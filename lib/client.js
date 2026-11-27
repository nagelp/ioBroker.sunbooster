"use strict";

const EventEmitter = require("events");
const WebSocket = require("ws");

const DEFAULTS = {
    wsUrl: "wss://iot-ws.quecteleu.com/ws/v1",
    apiBase: "https://iot-api.acceleronix.io",
    refreshPath: "/v2/enduser/enduserapi/refreshToken",
    controlPath: "/v2/binding/enduserapi/batchControlDevice",
    attrsPath: "/v2/binding/enduserapi/getDeviceBusinessAttributes",
    refreshMarginSec: 300,
    reconnectMinMs: 5000,
    reconnectMaxMs: 60000,
    heartbeatMs: 30000,
};

const SUBSCRIBE_MESSAGE_TYPES = [
    "ONLINE", "STATUS", "RAW-UPLINK", "MATTR-REPORT", "MEVENT-INFO",
    "MEVENT-WARN", "MEVENT-ERROR", "LOCATION-INFO-KV", "MSERV-OUTPUT", "MATTR-READRESP",
];

function normalizeToken(token) {
    let t = String(token || "").trim();
    if (!t) throw new Error("Token is empty");
    if (t.startsWith("Bearer Bearer ")) t = t.replace("Bearer Bearer ", "Bearer ", 1);
    return t.startsWith("Bearer ") ? t : `Bearer ${t}`;
}

/**
 * WebSocket live client + token refresh + REST control for a Sunbooster device.
 *
 * Events:
 *   'connection'(bool)  - WS logged in & subscribed / lost
 *   'data'(kvObject)    - live property updates (resourceCode -> raw value)
 *   'online'(bool)      - device ONLINE state
 *   'tokens'(bundle)    - new {accessToken, refreshToken, accessExpiration, refreshExpiration} to persist
 *   'error'(err)        - non-fatal error
 *   'authfailed'(err)   - refresh token exhausted; manual re-auth required
 */
class SunboosterClient extends EventEmitter {
    /**
     * @param {object} cfg {accessToken, refreshToken, accessExpiration, refreshExpiration,
     *                       uid, productKey, deviceKey, wsUrl?, apiBase?}
     * @param {object} [logger] optional {debug,info,warn,error}
     */
    constructor(cfg, logger) {
        super();
        const given = Object.fromEntries(Object.entries(cfg).filter(([, v]) => v !== undefined && v !== null && v !== ""));
        this.opts = { ...DEFAULTS, ...given };
        this.log = logger || { debug() {}, info() {}, warn() {}, error() {} };

        this.accessToken = normalizeToken(cfg.accessToken);
        this.refreshToken = normalizeToken(cfg.refreshToken);
        this.accessExpiration = Number(cfg.accessExpiration) || 0;
        this.refreshExpiration = Number(cfg.refreshExpiration) || 0;
        this.uid = cfg.uid;
        this.productKey = cfg.productKey;
        this.deviceKey = cfg.deviceKey;

        // The device only reports on its own when something changes. Re-sending
        // high_frequency_reporting=2 (as the app does) makes it push live values
        // for ~30 s; repeating it every liveInterval seconds keeps data flowing.
        const li = Number(this.opts.liveInterval);
        this.liveIntervalSec = Number.isFinite(li) ? (li <= 0 ? 0 : Math.max(li, 5)) : 10;
        this._liveTimer = null;

        this._stopped = false;
        this._ws = null;
        this._loop = null;
        this._backoff = this.opts.reconnectMinMs;
        this._hbTimer = null;
        this._wsAlive = false;
        this._pendingSends = []; // wsSend() calls waiting for their send_ack, in order
    }

    _now() { return Math.floor(Date.now() / 1000); }
    _accessExpiresSoon() { return this.accessExpiration - this._now() <= this.opts.refreshMarginSec; }

    async start() {
        this._stopped = false;
        this._loop = this._runLoop();
    }

    async stop() {
        this._stopped = true;
        this._stopLive();
        this._clearHeartbeat();
        if (this._ws) { try { this._ws.close(); } catch { /* ignore */ } }
        if (this._loop) { try { await this._loop; } catch { /* ignore */ } }
    }

    // ---- token refresh -------------------------------------------------

    async ensureValidToken() {
        if (this._accessExpiresSoon()) await this.refreshTokens();
    }

    async refreshTokens() {
        if (this.refreshExpiration && this.refreshExpiration - this._now() <= 0) {
            const err = new Error("Refresh token has expired - re-authentication required");
            this.emit("authfailed", err);
            throw err;
        }
        const url = `${this.opts.apiBase}${this.opts.refreshPath}?refreshToken=${encodeURIComponent(this.refreshToken)}`;
        this.log.info("Refreshing Sunbooster tokens");
        const res = await fetch(url, { method: "PUT", headers: { "Content-Type": "application/json" } });
        const text = await res.text();
        let payload;
        try { payload = JSON.parse(text); } catch { throw new Error(`Refresh response not JSON: ${text.slice(0, 200)}`); }
        if (payload.code !== 200) {
            const err = new Error(`Refresh failed: ${payload.code} ${payload.msg || ""}`);
            if (payload.code === 5032 || payload.code === 5106) this.emit("authfailed", err);
            throw err;
        }
        const data = payload.data || {};
        const access = data.accessToken || {};
        const refresh = data.refreshToken || {};
        if (!access.token || !refresh.token) throw new Error(`Refresh response incomplete: ${text.slice(0, 200)}`);

        this.accessToken = normalizeToken(access.token);
        this.accessExpiration = Number(access.expirationTime) || 0;
        this.refreshToken = normalizeToken(refresh.token);
        this.refreshExpiration = Number(refresh.expirationTime) || 0;

        this.emit("tokens", {
            accessToken: this.accessToken,
            refreshToken: this.refreshToken,
            accessExpiration: this.accessExpiration,
            refreshExpiration: this.refreshExpiration,
        });
        this.log.info(`Token refresh OK (access in ${this.accessExpiration - this._now()}s, refresh in ${this.refreshExpiration - this._now()}s)`);
    }

    // ---- control -------------------------------------------------------

    /**
     * Send one property command. `value` must already be in device encoding.
     * @returns {Promise<void>} resolves on device-level success, rejects otherwise.
     */
    async control(code, value) {
        await this.ensureValidToken();
        const body = {
            type: 2,
            deviceList: [{ productKey: this.productKey, deviceKey: this.deviceKey }],
            data: JSON.stringify([{ [code]: value }]),
            qos: 1,
        };
        const res = await fetch(`${this.opts.apiBase}${this.opts.controlPath}`, {
            method: "POST",
            headers: { Authorization: this.accessToken, "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        const text = await res.text();
        let payload;
        try { payload = JSON.parse(text); } catch { throw new Error(`Control response not JSON: ${text.slice(0, 200)}`); }
        if (payload.code !== 200) throw new Error(`Control rejected: ${payload.code} ${payload.msg || ""} ${payload.extMsg || ""}`);
        const fail = payload.data && payload.data.failureList;
        if (Array.isArray(fail) && fail.length) throw new Error(`Device refused command: ${fail[0] && fail[0].msg}`);
        this.log.debug(`control ${code}=${JSON.stringify(value)} OK`);
    }

    /**
     * Send a "send" command over the WebSocket (the app SDK's write path; needed for the
     * charge timer, which the device ignores when written via REST).
     * `data` is merged over {productKey, deviceKey, type: "WRITE-ATTR", dataFormat: "Text"};
     * a non-string `kv` is JSON-encoded.
     * @returns {Promise<string>} the sent message, once the cloud acknowledged it (send_ack "succ")
     */
    wsSend(data) {
        const ws = this._ws;
        if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("WebSocket not connected"));
        const d = { productKey: this.productKey, deviceKey: this.deviceKey, type: "WRITE-ATTR", dataFormat: "Text", ...data };
        if (d.kv !== undefined && typeof d.kv !== "string") d.kv = JSON.stringify(d.kv);
        const msg = JSON.stringify({ cmd: "send", data: d });
        return new Promise((resolve, reject) => {
            // The acks carry no reference to the request; they come back in order.
            const pending = { resolve: () => resolve(msg), reject, timer: null };
            pending.timer = setTimeout(() => {
                this._pendingSends = this._pendingSends.filter((p) => p !== pending);
                reject(new Error("no send_ack within 15 s"));
            }, 15000);
            this._pendingSends.push(pending);
            ws.send(msg);
        });
    }

    /** Write attributes in the WebSocket kv encoding ([{id, name, type, value}]). */
    async writeAttributes(kv) {
        await this.wsSend({ kv });
    }

    _onSendAck(obj) {
        const pending = this._pendingSends.shift();
        if (!pending) return;
        clearTimeout(pending.timer);
        const status = obj.data && obj.data.status;
        if (status === "succ") pending.resolve();
        else pending.reject(new Error(`send rejected: ${JSON.stringify(obj.data)}`));
    }

    /** Read current thing-model values via REST (note: this cache can lag). */
    async readAttributes(codes) {
        await this.ensureValidToken();
        const q = `pk=${encodeURIComponent(this.productKey)}&dk=${encodeURIComponent(this.deviceKey)}&type=2` +
            (codes && codes.length ? `&codeList=${encodeURIComponent(codes.join(","))}` : "");
        const res = await fetch(`${this.opts.apiBase}${this.opts.attrsPath}?${q}`, {
            headers: { Authorization: this.accessToken },
        });
        const payload = await res.json().catch(() => null);
        const rows = (payload && payload.data && payload.data.customizeTslInfo) || [];
        const out = {};
        for (const r of rows) out[r.resourceCode] = r.resourceValce;
        return out;
    }

    /** Ask the device to push live values for the next ~30 s (what the app does while open). */
    async requestLiveReports() {
        await this.control("high_frequency_reporting", 2);
    }

    _startLive() {
        if (!this.liveIntervalSec || this._liveTimer) return;
        const tick = () => this.requestLiveReports().catch((err) =>
            this.log.debug(`live report request failed: ${err && err.message}`));
        tick();
        this._liveTimer = setInterval(tick, this.liveIntervalSec * 1000);
    }

    _stopLive() {
        if (this._liveTimer) clearInterval(this._liveTimer);
        this._liveTimer = null;
    }

    /**
     * Detect a silently dropped WebSocket. The `ws` client does not ping on its
     * own, so a half-open connection (cloud LB / NAT idle drop with no close
     * frame) would otherwise never fire 'close' and data would freeze forever.
     * Any incoming frame (message or pong) counts as alive; a missed round
     * terminates the socket so the run loop reconnects.
     */
    _installHeartbeat(ws, onDead) {
        this._clearHeartbeat();
        this._wsAlive = true;
        ws.on("pong", () => { this._wsAlive = true; });
        const timer = setInterval(() => {
            if (this._hbTimer !== timer) return; // stale timer (already cleared or replaced)
            if (!this._wsAlive) {
                this._clearHeartbeat();
                this.log.warn("WS heartbeat timeout; terminating and reconnecting");
                try { ws.terminate(); } catch { /* ignore */ }
                onDead();
                return;
            }
            this._wsAlive = false;
            try { ws.ping(); } catch { /* ignore */ }
        }, this.opts.heartbeatMs);
        this._hbTimer = timer;
        if (timer && timer.unref) timer.unref();
    }

    _clearHeartbeat() {
        if (this._hbTimer) clearInterval(this._hbTimer);
        this._hbTimer = null;
    }

    // ---- live websocket loop -------------------------------------------

    async _runLoop() {
        while (!this._stopped) {
            try {
                await this.ensureValidToken();
                await this._connectOnce();
                this._backoff = this.opts.reconnectMinMs; // reset after a clean session
            } catch (err) {
                if (this._stopped) break;
                this.emit("connection", false);
                if (err && err.authfailed) { this.emit("authfailed", err); await this._sleep(30000); continue; }
                this.log.warn(`WS session error: ${err && err.message}`);
                this.emit("error", err);
                await this._sleep(this._backoff);
                this._backoff = Math.min(this._backoff * 2, this.opts.reconnectMaxMs);
            }
        }
    }

    _connectOnce() {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(this.opts.wsUrl, { handshakeTimeout: 15000 });
            this._ws = ws;
            let settled = false;
            const finish = (err) => {
                if (settled) return;
                settled = true;
                for (const p of this._pendingSends.splice(0)) {
                    clearTimeout(p.timer);
                    p.reject(new Error("WebSocket closed before send_ack"));
                }
                this._stopLive();
                this._clearHeartbeat();
                try { ws.close(); } catch { /* ignore */ }
                err ? reject(err) : resolve();
            };

            ws.on("open", () => ws.send(JSON.stringify({ cmd: "login", data: { token: this.accessToken } })));

            ws.on("message", (raw) => {
                this._wsAlive = true;
                let obj;
                try { obj = JSON.parse(raw.toString()); } catch { return; }

                if (obj.cmd === "login_resp") {
                    if (obj.data && obj.data.code === 1) {
                        ws.send(JSON.stringify({
                            cmd: "subscribe",
                            data: [{ deviceKey: this.deviceKey, productKey: this.productKey, messageType: SUBSCRIBE_MESSAGE_TYPES }],
                        }));
                    } else {
                        const err = new Error(`WS login failed: ${JSON.stringify(obj.data)}`);
                        if (obj.data && obj.data.code === 4008) err.authfailed = true;
                        finish(err);
                    }
                    return;
                }

                if (obj.cmd === "error") {
                    const code = obj.data && obj.data.code;
                    const err = new Error(`WS error: ${JSON.stringify(obj.data)}`);
                    if (code === 4008 || code === 4010) err.authfailed = true;
                    finish(err);
                    return;
                }

                if (Array.isArray(obj.data) && obj.data[0] && obj.data[0].code !== undefined) {
                    if (obj.data[0].code === 1) {
                        this._backoff = this.opts.reconnectMinMs;
                        this.emit("connection", true);
                        this._startLive();
                        this._installHeartbeat(ws, () => finish(new Error("WS heartbeat timeout")));
                    } else {
                        finish(new Error(`WS subscribe failed: ${JSON.stringify(obj.data)}`));
                    }
                    return;
                }

                if (obj.cmd === "message") this._handleMessage(obj);
                else if (obj.cmd === "send_ack") this._onSendAck(obj);
            });

            ws.on("close", () => finish(this._stopped ? undefined : new Error("WS closed")));
            ws.on("error", (err) => finish(err));

            if (this._stopped) finish(undefined);
        });
    }

    _handleMessage(obj) {
        const payload = obj.data || {};
        const type = payload.type;
        const inner = payload.data || {};
        if (type === "ONLINE") {
            this.emit("online", inner.value === 1);
            return;
        }
        const kv = inner.kv && typeof inner.kv === "object" ? inner.kv : null;
        if (kv) this.emit("data", kv);
    }

    _sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
}

module.exports = { SunboosterClient, normalizeToken, SUBSCRIBE_MESSAGE_TYPES, DEFAULTS };
