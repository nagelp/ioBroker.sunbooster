"use strict";

const utils = require("@iobroker/adapter-core");
const { SunboosterClient } = require("./lib/client");
const mapping = require("./lib/mapping");
const { TokenStore } = require("./lib/token-store");

class Sunbooster extends utils.Adapter {
    constructor(options) {
        super({ ...options, name: "sunbooster" });
        this.client = null;
        this.tokenStore = null;
        this.on("ready", this.onReady.bind(this));
        this.on("stateChange", this.onStateChange.bind(this));
        this.on("unload", this.onUnload.bind(this));
    }

    async onReady() {
        this.setState("info.connection", false, true);

        const cfg = this.config;
        if (!cfg.productKey || !cfg.deviceKey) {
            this.log.error("productKey and deviceKey are required - configure the adapter first.");
            return;
        }

        this.tokenStore = new TokenStore(utils.getAbsoluteInstanceDataDir(this), {
            encrypt: (s) => this.encrypt(s),
            decrypt: (s) => this.decrypt(s),
        });
        const tokens = await this._loadTokens();
        if (!tokens.accessToken || !tokens.refreshToken) {
            this.log.error("No tokens configured - enter the captured access/refresh tokens in the adapter settings.");
            return;
        }

        await this._createObjects();

        this.client = new SunboosterClient(
            {
                accessToken: tokens.accessToken,
                refreshToken: tokens.refreshToken,
                accessExpiration: tokens.accessExpiration,
                refreshExpiration: tokens.refreshExpiration,
                uid: cfg.uid,
                productKey: cfg.productKey,
                deviceKey: cfg.deviceKey,
                wsUrl: cfg.wsUrl || undefined,
                apiBase: cfg.apiBase || undefined,
                liveInterval: cfg.updateInterval,
            },
            this.log,
        );

        this.client.on("connection", (ok) => {
            this.setState("info.connection", !!ok, true);
            if (ok) this._snapshot().catch((e) => this.log.debug(`snapshot failed: ${e && e.message}`));
        });
        this.client.on("online", (on) => this.setState("device.online", !!on, true));
        this.client.on("data", (kv) => this._applyData(kv));
        this.client.on("tokens", (bundle) => this._saveTokens(bundle));
        this.client.on("error", (err) => this.log.debug(`client: ${err && err.message}`));
        this.client.on("authfailed", (err) =>
            this.log.error(`Authentication failed - re-capture tokens: ${err && err.message}`));

        this.subscribeStates("control.*");
        await this.client.start();
        this.log.info("Sunbooster client started");
    }

    async _createObjects() {
        await this.setObjectNotExistsAsync("device", { type: "channel", common: { name: "Device telemetry" }, native: {} });
        await this.setObjectNotExistsAsync("control", { type: "channel", common: { name: "Controls" }, native: {} });

        await this.setObjectNotExistsAsync("device.online", {
            type: "state",
            common: { name: "Device online", type: "boolean", role: "indicator.reachable", read: true, write: false, def: false },
            native: {},
        });

        for (const r of mapping.READONLY) {
            await this.setObjectNotExistsAsync(`device.${r.id}`, {
                type: "state",
                common: {
                    name: r.name, type: r.type, role: r.role, read: true, write: false,
                    ...(r.unit ? { unit: r.unit } : {}),
                    ...(r.states ? { states: r.states } : {}),
                },
                native: {},
            });
        }

        for (const c of mapping.CONTROLS) {
            await this.setObjectNotExistsAsync(`control.${c.id}`, {
                type: "state",
                common: {
                    name: c.name, type: c.type, role: c.role, read: true, write: true,
                    ...(c.unit ? { unit: c.unit } : {}),
                    ...(c.states ? { states: c.states } : {}),
                    ...(c.min !== undefined ? { min: c.min } : {}),
                    ...(c.max !== undefined ? { max: c.max } : {}),
                    ...(c.step !== undefined ? { step: c.step } : {}),
                },
                native: {},
            });
        }
    }

    async _snapshot() {
        if (!this.client) return;
        const kv = await this.client.readAttributes([]);
        if (kv && Object.keys(kv).length) {
            this.log.debug(`seeded ${Object.keys(kv).length} values from REST snapshot`);
            this._applyData(kv);
        }
    }

    _applyData(kv) {        for (const [code, raw] of Object.entries(kv)) {
            const ro = mapping.READONLY_BY_CODE[code];
            if (ro) {
                let val;
                try { val = ro.parse ? ro.parse(raw) : raw; } catch { val = raw; }
                if (ro.type === "number" && Number.isNaN(val)) continue;
                this.setState(`device.${ro.id}`, { val, ack: true });
            }
            const ctrl = mapping.CONTROL_BY_CODE[code];
            if (ctrl) {
                const val = ctrl.fromDevice ? ctrl.fromDevice(raw) : raw;
                this.setState(`control.${ctrl.id}`, { val, ack: true });
            }
        }
    }

    async onStateChange(id, state) {
        if (!state || state.ack || !this.client) return;
        const key = id.split(".").pop();
        const ctrl = mapping.CONTROLS.find((c) => c.id === key);
        if (!ctrl || !ctrl.write) return;

        const deviceValue = ctrl.toDevice ? ctrl.toDevice(state.val) : state.val;
        try {
            await this.client.control(ctrl.code, deviceValue);
            this.setState(`control.${ctrl.id}`, { val: state.val, ack: true });
            this.log.debug(`control.${ctrl.id} -> ${ctrl.code}=${JSON.stringify(deviceValue)}`);
        } catch (err) {
            this.log.error(`Failed to set ${ctrl.id}: ${err && err.message}`);
        }
    }

    async _loadTokens() {
        const cfg = this.config;
        const seed = {
            accessToken: cfg.accessToken,
            refreshToken: cfg.refreshToken,
            accessExpiration: Number(cfg.accessExpiration) || 0,
            refreshExpiration: Number(cfg.refreshExpiration) || 0,
        };
        try {
            const saved = await this.tokenStore.load();
            // Prefer saved tokens only if the refresh token is still valid and newer.
            if (saved && saved.refreshToken && (saved.refreshExpiration || 0) >= seed.refreshExpiration) {
                this.log.info("Using stored rotating tokens");
                return saved;
            }
        } catch (err) {
            this.log.warn(`Could not read stored tokens, falling back to configured ones: ${err && err.message}`);
        }
        return seed;
    }

    async _saveTokens(bundle) {
        try {
            await this.tokenStore.save(bundle);
            this.log.debug("Stored refreshed tokens");
        } catch (err) {
            this.log.warn(`Could not store tokens: ${err && err.message}`);
        }
    }

    async onUnload(callback) {
        try {
            if (this.client) await this.client.stop();
            this.setState("info.connection", false, true);
        } catch { /* ignore */ } finally {
            callback();
        }
    }
}

if (require.main !== module) {
    module.exports = (options) => new Sunbooster(options);
} else {
    new Sunbooster();
}
