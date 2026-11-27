"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");
const { SunboosterClient, DEFAULTS } = require("../../lib/client");

const base = { accessToken: "Bearer a", refreshToken: "Bearer r", productKey: "pk", deviceKey: "dk" };

function stubbedClient(cfg) {
    const c = new SunboosterClient({ ...base, ...cfg });
    c.calls = [];
    c.control = async (code, value) => { c.calls.push([code, value]); };
    return c;
}

function fakeWs() {
    const ws = new EventEmitter();
    ws.pings = 0;
    ws.terminated = 0;
    ws.ping = () => { ws.pings++; };
    ws.terminate = () => { ws.terminated++; };
    return ws;
}

test("live reports are requested on connect and every interval until stopped", (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const c = stubbedClient({ liveInterval: 10 });

    c._startLive();
    assert.deepStrictEqual(c.calls, [["high_frequency_reporting", 2]]);
    t.mock.timers.tick(20000);
    assert.strictEqual(c.calls.length, 3);

    c._stopLive();
    t.mock.timers.tick(60000);
    assert.strictEqual(c.calls.length, 3);
});

test("interval 0 disables live reports", (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const c = stubbedClient({ liveInterval: 0 });
    c._startLive();
    t.mock.timers.tick(60000);
    assert.strictEqual(c.calls.length, 0);
});

test("missing config values fall back to defaults instead of undefined", () => {
    // Existing instances have no updateInterval and may pass empty URLs.
    const c = new SunboosterClient({ ...base, liveInterval: undefined, wsUrl: undefined, apiBase: "" });
    assert.strictEqual(c.liveIntervalSec, 10);
    assert.strictEqual(c.opts.wsUrl, DEFAULTS.wsUrl);
    assert.strictEqual(c.opts.apiBase, DEFAULTS.apiBase);
    assert.strictEqual(new SunboosterClient({ ...base, liveInterval: 1 }).liveIntervalSec, 5);
});

test("heartbeat terminates a silent socket and reconnects", (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const c = new SunboosterClient({ ...base, heartbeatMs: 30000 });
    const ws = fakeWs();
    let dead = 0;
    c._installHeartbeat(ws, () => { dead++; });

    // First round: still marked alive from install -> ping sent, flag cleared.
    t.mock.timers.tick(30000);
    assert.strictEqual(ws.pings, 1);
    assert.strictEqual(dead, 0);

    // Second round: no pong/message arrived -> terminate + reconnect callback.
    t.mock.timers.tick(30000);
    assert.strictEqual(ws.terminated, 1);
    assert.strictEqual(dead, 1);

    // Watchdog is cleared after firing: no further ticks act.
    t.mock.timers.tick(90000);
    assert.strictEqual(dead, 1);
});

test("heartbeat keeps a socket alive while pongs arrive", (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const c = new SunboosterClient({ ...base, heartbeatMs: 30000 });
    const ws = fakeWs();
    let dead = 0;
    c._installHeartbeat(ws, () => { dead++; });

    for (let i = 0; i < 5; i++) {
        t.mock.timers.tick(30000);
        ws.emit("pong"); // server answers each ping
    }
    assert.strictEqual(dead, 0);
    assert.strictEqual(ws.terminated, 0);
    assert.strictEqual(ws.pings, 5);
});


test("stop() wakes a running reconnect backoff instead of waiting it out", async () => {
    const c = new SunboosterClient(base);
    let attempts = 0;
    c.ensureValidToken = async () => {};
    c._connectOnce = async () => { attempts++; throw new Error("offline"); };
    c.on("error", () => {});
    c.opts.reconnectMinMs = 3600e3; // an hour
    await c.start();
    await new Promise((r) => setImmediate(r));
    const t0 = Date.now();
    await c.stop();
    assert.ok(Date.now() - t0 < 1000);
    assert.strictEqual(attempts, 1);
});

test("injected timers are used, and a missing timer (adapter shutting down) doesn't block", async () => {
    const used = [];
    const timers = {
        setTimeout: (fn, ms) => { used.push(["setTimeout", ms]); return undefined; }, // like adapter.setTimeout during stop
        clearTimeout: () => used.push(["clearTimeout"]),
        setInterval: (fn, ms) => { used.push(["setInterval", ms]); return 1; },
        clearInterval: () => used.push(["clearInterval"]),
    };
    const c = new SunboosterClient(base, undefined, timers);
    await c._sleep(5000); // resolves at once
    c._installHeartbeat(fakeWs(), () => {});
    c._clearHeartbeat();
    assert.deepStrictEqual(used, [["setTimeout", 5000], ["setInterval", DEFAULTS.heartbeatMs], ["clearInterval"]]);
});
