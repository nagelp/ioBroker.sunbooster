"use strict";

/**
 * The AC charge timer ("timed_charge_connection", verified on firmware 1.0.5).
 *
 * The device runs it on its own clock (deviceTime), edge-triggered: charging starts
 * when a slot's start minute is reached and stops at its end minute (a slot whose end
 * is before its start runs across midnight). "ac_time_switch" enables the timer;
 * switching it off stops timer charging at once, switching it on only arms it (charging
 * starts at the next start edge). A changed slot power also only applies from its next
 * start edge.
 *
 * Writing it only works as a WebSocket WRITE-ATTR with an id/name/type/value kv; the
 * REST batchControlDevice accepts it but the device ignores it.
 *
 * Reported encodings (both handled by decode):
 *   live: [{"start_time":"1240","end_time":"1439","timed_charge_power":"1"}, ...]
 *   REST: [{"id":0,"value":[{"id":1,"value":"1240"},{"id":3,"value":"1"},{"id":2,"value":"1439"}]}, ...]
 * Times are minutes since midnight, power is an index into POWERS_W.
 */

const CODE = "timed_charge_connection";
const SWITCH_CODE = "ac_time_switch";
const TSL_ID = 6;
const POWERS_W = [200, 400, 600, 800, 1000];
const FIELDS = { 1: "start_time", 2: "end_time", 3: "timed_charge_power" };

const pad = (n) => String(n).padStart(2, "0");

function minutesToHHMM(min) {
    const m = ((Number(min) % 1440) + 1440) % 1440;
    return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

function hhmmToMinutes(text) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(text).trim());
    if (!m || +m[1] > 23 || +m[2] > 59) throw new Error(`invalid time ${JSON.stringify(text)} (expected HH:MM)`);
    return +m[1] * 60 + +m[2];
}

/** Nearest supported power index for a wattage. */
function powerIndex(watts) {
    const w = Number(watts);
    if (!Number.isFinite(w) || w <= 0) throw new Error(`invalid power ${JSON.stringify(watts)}`);
    let best = 0;
    for (let i = 1; i < POWERS_W.length; i++) {
        if (Math.abs(POWERS_W[i] - w) < Math.abs(POWERS_W[best] - w)) best = i;
    }
    return best;
}

/** Reported value (string or array, live or REST encoding) -> [{start, end, power}] (unused all-zero slots dropped). */
function decode(raw) {
    let arr = raw;
    if (typeof arr === "string") arr = JSON.parse(arr);
    if (!Array.isArray(arr)) throw new Error("timer value is not an array");
    const slots = [];
    for (const e of arr) {
        let f = e;
        if (e && Array.isArray(e.value)) {
            f = {};
            for (const x of e.value) f[FIELDS[x.id] || x.id] = x.value;
        }
        const start = Number(f.start_time), end = Number(f.end_time), p = Number(f.timed_charge_power);
        if (![start, end, p].every(Number.isFinite)) continue;
        if (start === 0 && end === 0 && p === 0) continue;
        slots.push({ start: minutesToHHMM(start), end: minutesToHHMM(end), power: POWERS_W[p] || null });
    }
    return slots;
}

/** [{start: "HH:MM", end: "HH:MM", power: W}] -> WebSocket kv (with the unused leading slot the app also writes). */
function encode(slots) {
    if (!Array.isArray(slots)) throw new Error("expected an array of {start, end, power}");
    const struct = (start, end, p) => ({
        id: 0, name: "", type: "STRUCT", value: [
            { id: 1, name: "start_time", type: "INT", value: String(start) },
            { id: 2, name: "end_time", type: "INT", value: String(end) },
            { id: 3, name: "timed_charge_power", type: "ENUM", value: String(p) },
        ],
    });
    const value = [struct(0, 0, 0)];
    for (const s of slots) {
        const start = hhmmToMinutes(s.start), end = hhmmToMinutes(s.end);
        if (start === end) throw new Error(`slot ${s.start}-${s.end} is empty`);
        value.push(struct(start, end, powerIndex(s.power)));
    }
    return [{ id: TSL_ID, name: CODE, type: "ARRAY", value }];
}

/**
 * The slot for "charge now at `watts`": starts at the next full minute of `now` (one
 * more if that is less than 15 s away, so the write surely arrives before the edge)
 * and runs round the clock until the minute before.
 */
function chargeNowSlot(watts, now = new Date()) {
    const min = now.getHours() * 60 + now.getMinutes() + (now.getSeconds() >= 45 ? 2 : 1);
    return { start: minutesToHHMM(min), end: minutesToHHMM(min - 1), power: POWERS_W[powerIndex(watts)] };
}

module.exports = { CODE, SWITCH_CODE, POWERS_W, decode, encode, chargeNowSlot, minutesToHHMM, hhmmToMinutes, powerIndex };
