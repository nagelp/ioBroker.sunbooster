"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const clock = require("../../lib/clock");

test("formatLocal / parseLocal round-trip in local time", () => {
    const d = new Date(2026, 10, 26, 7, 5, 9);
    assert.strictEqual(clock.formatLocal(d), "2026-11-26 07:05:09");
    assert.strictEqual(clock.parseLocal("2026-11-26 07:05:09"), d.getTime());
});

test("clockOffsetSec: device ahead is positive, garbage is NaN", () => {
    const now = new Date(2026, 10, 26, 19, 22, 15).getTime();
    assert.strictEqual(clock.clockOffsetSec("2026-11-26 20:31:42", now), 4167);
    assert.strictEqual(clock.clockOffsetSec("2026-11-26 19:22:00", now), -15);
    assert.ok(Number.isNaN(clock.clockOffsetSec("", now)));
    assert.ok(Number.isNaN(clock.clockOffsetSec("26.11.2026 19:22", now)));
});
