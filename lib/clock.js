'use strict';

/**
 * The device keeps its own local clock ("deviceTime", "YYYY-MM-DD HH:MM:SS") and
 * runs its charge/feed timers on it. It doesn't follow DST changes and drifts, so
 * the adapter can set it from the host clock (host local time zone).
 */

const pad = n => String(n).padStart(2, '0');

/**
 * Date -> "YYYY-MM-DD HH:MM:SS" in the host's local time.
 *
 * @param {Date} date the time to format
 * @returns {string} "YYYY-MM-DD HH:MM:SS"
 */
function formatLocal(date) {
    return (
        `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
        `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    );
}

/**
 * "YYYY-MM-DD HH:MM:SS" (host local time) -> epoch ms, or NaN.
 *
 * @param {string} text the time as "YYYY-MM-DD HH:MM:SS"
 * @returns {number} epoch ms, or NaN
 */
function parseLocal(text) {
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(String(text || '').trim());
    if (!m) {
        return NaN;
    }
    return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
}

/**
 * Device clock minus host clock in seconds (NaN if unparsable).
 *
 * @param {string} deviceTime the device clock as reported ("YYYY-MM-DD HH:MM:SS")
 * @param {number} nowMs the host clock in epoch ms
 * @returns {number} the offset in seconds
 */
function clockOffsetSec(deviceTime, nowMs) {
    return (parseLocal(deviceTime) - nowMs) / 1000;
}

module.exports = { formatLocal, parseLocal, clockOffsetSec };
