'use strict';

const utils = require('@iobroker/adapter-core');
const { SunboosterClient } = require('./lib/client');
const mapping = require('./lib/mapping');
const { TokenStore } = require('./lib/token-store');
const clock = require('./lib/clock');
const timer = require('./lib/timer');

const CLOCK_TOLERANCE_S = 30; // set the device clock when it is off by more than this
const CLOCK_MIN_INTERVAL_MS = 600e3; // ... but at most this often
const CLOCK_SET_AT_SECOND = 30; // set it mid-minute: a correction of a few seconds then never crosses a
// minute boundary, so it can't skip or repeat a timer's start edge

class Sunbooster extends utils.Adapter {
    constructor(options) {
        super({ ...options, name: 'sunbooster' });
        this.client = null;
        this.tokenStore = null;
        this._lastClockSync = 0;
        this._clockTimer = null;
        this._clockPending = null;
        this._timerSwitch = undefined; // last reported ac_time_switch
        this._timerSlots = undefined; // last reported charge timer slots
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    async onReady() {
        this.setState('info.connection', false, true);

        const cfg = this.config;
        if (!cfg.productKey || !cfg.deviceKey) {
            this.log.error('productKey and deviceKey are required - configure the adapter first.');
            return;
        }

        this.tokenStore = new TokenStore(utils.getAbsoluteInstanceDataDir(this), {
            encrypt: s => this.encrypt(s),
            decrypt: s => this.decrypt(s),
        });
        const tokens = await this._loadTokens();
        if (!tokens.accessToken || !tokens.refreshToken) {
            this.log.error('No tokens configured - enter the captured access/refresh tokens in the adapter settings.');
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
            {
                // The adapter's timers: js-controller clears them on unload.
                setTimeout: (fn, ms) => this.setTimeout(fn, ms),
                clearTimeout: t => this.clearTimeout(t),
                setInterval: (fn, ms) => this.setInterval(fn, ms),
                clearInterval: t => this.clearInterval(t),
            },
        );

        let clockSyncedOnce = false;
        this.client.on('connection', ok => {
            this.setState('info.connection', !!ok, true);
            if (ok) {
                this._snapshot().catch(e => this.log.debug(`snapshot failed: ${e && e.message}`));
            }
            if (ok && cfg.syncClock && !clockSyncedOnce) {
                clockSyncedOnce = true;
                this._syncClock('adapter start');
            }
        });
        this.client.on('online', on => this.setState('device.online', !!on, true));
        this.client.on('data', kv => {
            this._applyData(kv);
            // Only live reports: the REST snapshot's deviceTime is as old as the cloud's cache.
            if (cfg.syncClock && kv.deviceTime !== undefined) {
                this._checkClock(kv.deviceTime);
            }
        });
        this.client.on('tokens', bundle => this._saveTokens(bundle));
        this.client.on('error', err => this.log.debug(`client: ${err && err.message}`));
        this.client.on('authfailed', err =>
            this.log.error(`Authentication failed - re-capture tokens: ${err && err.message}`),
        );

        this.subscribeStates('control.*');
        await this.client.start();
        this.log.info('Sunbooster client started');

        if (cfg.syncClock) {
            const hours = Number(cfg.clockSyncInterval);
            const every = Number.isFinite(hours) && hours > 0 ? Math.max(hours, 0.25) : 0;
            if (every) {
                this._clockTimer = this.setInterval(() => this._syncClock('periodic'), every * 3600e3);
                this.log.info(
                    `Setting the device clock every ${every} h (and whenever it is off by more than ${CLOCK_TOLERANCE_S} s)`,
                );
            }
        }
    }

    _checkClock(deviceTime) {
        const now = Date.now();
        const off = clock.clockOffsetSec(deviceTime, now);
        if (!Number.isFinite(off) || Math.abs(off) <= CLOCK_TOLERANCE_S) {
            return;
        }
        if (now - this._lastClockSync < CLOCK_MIN_INTERVAL_MS) {
            return;
        }
        this._syncClock(`it was ${off > 0 ? '+' : ''}${Math.round(off)} s off (${deviceTime})`);
    }

    /**
     * Sets the device clock from the host clock at the next CLOCK_SET_AT_SECOND of a minute.
     *
     * @param {string} why the reason, for the log
     */
    _syncClock(why) {
        if (this._clockPending || !this.client) {
            return;
        }
        this._lastClockSync = Date.now();
        const sec = new Date().getSeconds() + new Date().getMilliseconds() / 1000;
        const waitS = (CLOCK_SET_AT_SECOND - sec + 60) % 60;
        this._clockPending = this.setTimeout(() => {
            this._clockPending = null;
            this._lastClockSync = Date.now();
            const target = clock.formatLocal(new Date(Date.now() + 1000)); // the command takes about a second
            this.client
                .control('deviceTime', target)
                .then(() => this.log.info(`Device clock set to ${target} (${why})`))
                .catch(err => this.log.warn(`Could not set the device clock: ${err && err.message}`));
        }, waitS * 1000);
    }

    // ---- charge timer ----

    /**
     * Mirrors the timer onto control.chargeTimer / control.timerCharge.
     *
     * @param {string} code timed_charge_connection or ac_time_switch
     * @param {string|boolean|Array<object>} raw the reported value
     */
    _onTimerReport(code, raw) {
        if (code === timer.SWITCH_CODE) {
            this._timerSwitch = raw === true || raw === 'true';
        } else {
            try {
                this._timerSlots = timer.decode(raw);
            } catch (err) {
                this.log.debug(`charge timer: can't decode ${JSON.stringify(raw)}: ${err && err.message}`);
                return;
            }
            this.setState('control.chargeTimer', { val: JSON.stringify(this._timerSlots), ack: true });
        }
        if (this._timerSwitch === undefined) {
            return;
        }
        let w = null; // timer in some other configuration (e.g. set in the app)
        if (!this._timerSwitch) {
            w = 0;
        } else if (this._timerSlots && this._timerSlots.length === 1) {
            const s = this._timerSlots[0];
            if ((timer.hhmmToMinutes(s.end) + 1) % 1440 === timer.hhmmToMinutes(s.start)) {
                w = s.power;
            }
        }
        if (w !== null || this._timerSlots !== undefined) {
            this.setState('control.timerCharge', { val: w, ack: true });
        }
    }

    async _writeTimer(slots) {
        await this.client.writeAttributes(timer.encode(slots));
    }

    async _setChargeTimer(state) {
        try {
            const slots = JSON.parse(String(state.val || '[]'));
            await this._writeTimer(slots);
            this.log.info(`Charge timer set to ${JSON.stringify(slots)}`);
        } catch (err) {
            this.log.error(`control.chargeTimer: ${err && err.message}`);
        }
    }

    async _setTimerCharge(state) {
        const w = Number(state.val);
        try {
            if (!w || w <= 0) {
                await this.client.control(timer.SWITCH_CODE, false);
                this.log.info('Timer charging off');
            } else {
                const slot = timer.chargeNowSlot(w);
                await this._writeTimer([slot]);
                await this.client.control(timer.SWITCH_CODE, true);
                this.log.info(`Timer charging at ${slot.power} W from ${slot.start} (slot ${slot.start}-${slot.end})`);
            }
        } catch (err) {
            this.log.error(`control.timerCharge=${state.val} failed: ${err && err.message}`);
        }
    }

    async _createObjects() {
        await this.setObjectNotExistsAsync('device', {
            type: 'channel',
            common: { name: 'Device telemetry' },
            native: {},
        });
        await this.setObjectNotExistsAsync('control', { type: 'channel', common: { name: 'Controls' }, native: {} });

        await this.setObjectNotExistsAsync('device.online', {
            type: 'state',
            common: {
                name: 'Device online',
                type: 'boolean',
                role: 'indicator.reachable',
                read: true,
                write: false,
                def: false,
            },
            native: {},
        });

        for (const r of mapping.READONLY) {
            await this.setObjectNotExistsAsync(`device.${r.id}`, {
                type: 'state',
                common: {
                    name: r.name,
                    type: r.type,
                    role: r.role,
                    read: true,
                    write: false,
                    ...(r.unit ? { unit: r.unit } : {}),
                    ...(r.states ? { states: r.states } : {}),
                },
                native: {},
            });
        }

        await this.setObjectNotExistsAsync('control.chargeTimer', {
            type: 'state',
            common: {
                name: 'AC charge timer: JSON [{"start":"HH:MM","end":"HH:MM","power":200|400|600|800|1000}] (starts at each start minute, device clock)',
                type: 'string',
                role: 'json',
                read: true,
                write: true,
            },
            native: {},
        });
        await this.setObjectNotExistsAsync('control.timerCharge', {
            type: 'state',
            common: {
                name: 'Charge from the grid now via the timer: 0 = off, 200-1000 W (starts within ~1 min; replaces the charge timer)',
                type: 'number',
                role: 'level.power',
                unit: 'W',
                read: true,
                write: true,
                min: 0,
                max: 1000,
                step: 200,
            },
            native: {},
        });

        for (const c of mapping.CONTROLS) {
            await this.setObjectNotExistsAsync(`control.${c.id}`, {
                type: 'state',
                common: {
                    name: c.name,
                    type: c.type,
                    role: c.role,
                    read: true,
                    write: true,
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
        if (!this.client) {
            return;
        }
        const kv = await this.client.readAttributes([]);
        if (kv && Object.keys(kv).length) {
            this.log.debug(`seeded ${Object.keys(kv).length} values from REST snapshot`);
            this._applyData(kv);
        }
    }

    _applyData(kv) {
        for (const [code, raw] of Object.entries(kv)) {
            if (code === timer.CODE || code === timer.SWITCH_CODE) {
                this._onTimerReport(code, raw);
            }
            const ro = mapping.READONLY_BY_CODE[code];
            if (ro) {
                let val;
                try {
                    val = ro.parse ? ro.parse(raw) : raw;
                } catch {
                    val = raw;
                }
                if (ro.type === 'number' && Number.isNaN(val)) {
                    continue;
                }
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
        if (!state || state.ack || !this.client) {
            return;
        }
        const key = id.split('.').pop();
        if (key === 'chargeTimer') {
            return this._setChargeTimer(state);
        }
        if (key === 'timerCharge') {
            return this._setTimerCharge(state);
        }
        const ctrl = mapping.CONTROLS.find(c => c.id === key);
        if (!ctrl || !ctrl.write) {
            return;
        }

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
                this.log.info('Using stored rotating tokens');
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
            this.log.debug('Stored refreshed tokens');
        } catch (err) {
            this.log.warn(`Could not store tokens: ${err && err.message}`);
        }
    }

    async onUnload(callback) {
        try {
            if (this._clockTimer) {
                this.clearInterval(this._clockTimer);
            }
            if (this._clockPending) {
                this.clearTimeout(this._clockPending);
            }
            if (this.client) {
                await this.client.stop();
            }
            this.setState('info.connection', false, true);
        } catch {
            /* ignore */
        } finally {
            callback();
        }
    }
}

if (require.main !== module) {
    module.exports = options => new Sunbooster(options);
} else {
    new Sunbooster();
}
