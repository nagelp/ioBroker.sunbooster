"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const m = require("../lib/mapping");

test("feed watts -> device value (0=off, then 50W steps from 100W)", () => {
    assert.strictEqual(m.feedWattsToValue(0), 0);
    assert.strictEqual(m.feedWattsToValue(100), 1);
    assert.strictEqual(m.feedWattsToValue(150), 2);
    assert.strictEqual(m.feedWattsToValue(200), 3);
    assert.strictEqual(m.feedWattsToValue(800), 15);
});

test("feed value -> watts round-trips", () => {
    assert.strictEqual(m.feedValueToWatts(0), 0);
    assert.strictEqual(m.feedValueToWatts(1), 100);
    assert.strictEqual(m.feedValueToWatts(3), 200);
    for (const w of [0, 100, 150, 200, 400, 800]) {
        assert.strictEqual(m.feedValueToWatts(m.feedWattsToValue(w)), w);
    }
});

test("feed watts clamp and snap to nearest 50W step", () => {
    assert.strictEqual(m.feedWattsToValue(120), m.feedWattsToValue(100)); // snaps down to 100
    assert.strictEqual(m.feedWattsToValue(5000), 15);                     // clamps to 800W
    assert.strictEqual(m.feedWattsToValue(50), 1);                        // below min -> 100W
});

test("every control maps to a device code and both converters exist", () => {
    for (const c of m.CONTROLS) {
        assert.ok(c.code, `control ${c.id} has a device code`);
        assert.strictEqual(typeof c.toDevice, "function");
        assert.strictEqual(typeof c.fromDevice, "function");
        assert.strictEqual(m.CONTROL_BY_CODE[c.code], c);
    }
});
