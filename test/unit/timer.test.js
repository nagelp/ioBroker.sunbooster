"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const timer = require("../../lib/timer");

test("decode: live and REST encodings give the same slots, unused zero slot dropped", () => {
    const live = '[{"end_time":"0","start_time":"0","timed_charge_power":"0"},{"end_time":"1439","start_time":"1240","timed_charge_power":"1"}]';
    const rest = '[{"id":0,"value":[{"id":1,"value":"0"},{"id":3,"value":"0"},{"id":2,"value":"0"}]},' +
        '{"id":0,"value":[{"id":1,"value":"1240"},{"id":3,"value":"1"},{"id":2,"value":"1439"}]}]';
    const want = [{ start: "20:40", end: "23:59", power: 400 }];
    assert.deepStrictEqual(timer.decode(live), want);
    assert.deepStrictEqual(timer.decode(JSON.parse(rest)), want);
});

test("encode: the verified WebSocket kv (leading unused slot, string values)", () => {
    const kv = timer.encode([{ start: "09:30", end: "09:34", power: 200 }]);
    assert.deepStrictEqual(kv, [{
        id: 6, name: "timed_charge_connection", type: "ARRAY", value: [
            { id: 0, name: "", type: "STRUCT", value: [
                { id: 1, name: "start_time", type: "INT", value: "0" },
                { id: 2, name: "end_time", type: "INT", value: "0" },
                { id: 3, name: "timed_charge_power", type: "ENUM", value: "0" }] },
            { id: 0, name: "", type: "STRUCT", value: [
                { id: 1, name: "start_time", type: "INT", value: "570" },
                { id: 2, name: "end_time", type: "INT", value: "574" },
                { id: 3, name: "timed_charge_power", type: "ENUM", value: "0" }] },
        ],
    }]);
});

test("encode rejects bad input", () => {
    assert.throws(() => timer.encode([{ start: "24:00", end: "01:00", power: 200 }]), /invalid time/);
    assert.throws(() => timer.encode([{ start: "10:00", end: "10:00", power: 200 }]), /empty/);
    assert.throws(() => timer.encode([{ start: "10:00", end: "11:00", power: 0 }]), /invalid power/);
    assert.throws(() => timer.encode({}), /array/);
});

test("powerIndex picks the nearest step", () => {
    assert.strictEqual(timer.powerIndex(200), 0);
    assert.strictEqual(timer.powerIndex(250), 0);
    assert.strictEqual(timer.powerIndex(400), 1);
    assert.strictEqual(timer.powerIndex(5000), 4);
});

test("chargeNowSlot: next minute, round the clock; one more minute when close to the edge", () => {
    assert.deepStrictEqual(timer.chargeNowSlot(200, new Date(2026, 10, 27, 9, 41, 13)),
        { start: "09:42", end: "09:41", power: 200 });
    assert.deepStrictEqual(timer.chargeNowSlot(400, new Date(2026, 10, 27, 9, 41, 50)),
        { start: "09:43", end: "09:42", power: 400 });
    assert.deepStrictEqual(timer.chargeNowSlot(1000, new Date(2026, 10, 27, 23, 59, 20)),
        { start: "00:00", end: "23:59", power: 1000 });
});
