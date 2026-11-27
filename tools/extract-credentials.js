#!/usr/bin/env node
'use strict';

/**
 * Extract Sunbooster cloud credentials from an `adb logcat` dump taken while
 * logging in with the Sunbooster app V1.0.0, and write them to credentials.json.
 *
 *   adb logcat -c
 *   (log in to the app and open your POWERSTATION once)
 *   adb logcat -d > login.log
 *   node extract-credentials.js login.log [-o credentials.json]
 *
 * No dependencies; only Node.js built-ins.
 */

const fs = require('node:fs');
const path = require('node:path');

const LOGIN_MARKER = 'emailPwdLogin--:';
const RN_MARKER = 'Running "QuecRNAPP" with ';

/**
 * Decode a log file buffer, handling UTF-16 (PowerShell `>`) and UTF-8 BOMs.
 *
 * @param {Buffer} buf the file content
 * @returns {string} the decoded text
 */
function decodeLog(buf) {
    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
        return buf.subarray(2).toString('utf16le');
    }
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
        return buf.subarray(3).toString('utf8');
    }
    return buf.toString('utf8');
}

/**
 * Epoch seconds from a value in seconds or milliseconds.
 *
 * @param {number|string} n the time
 * @returns {number} epoch seconds
 */
function toSeconds(n) {
    const v = Number(n) || 0;
    return v > 1e12 ? Math.floor(v / 1000) : v;
}

/**
 * Adds the "Bearer " prefix to a token if it is missing.
 *
 * @param {string} token the token
 * @returns {string} the token with prefix
 */
function withBearer(token) {
    const t = String(token || '').trim();
    return !t || t.startsWith('Bearer ') ? t : `Bearer ${t}`;
}

/**
 * Parse a logcat dump into a credentials object. Throws if required values are missing.
 *
 * @param {string} text the logcat output
 * @returns {object} the credentials
 */
function parseLog(text) {
    let login = null;
    let device = null;
    let props = null;

    for (const line of text.split(/\r?\n/)) {
        const li = line.indexOf(LOGIN_MARKER);
        if (li !== -1) {
            try {
                const o = JSON.parse(line.slice(li + LOGIN_MARKER.length).trim());
                if (o && o.code === 200 && o.data && o.data.accessToken) {
                    login = o.data;
                }
            } catch {
                /* truncated or unrelated line */
            }
        }
        const ri = line.indexOf(RN_MARKER);
        if (ri !== -1) {
            try {
                const o = JSON.parse(line.slice(ri + RN_MARKER.length).trim());
                if (o && o.initialProps) {
                    props = o.initialProps;
                    const dev = props.device;
                    device = (typeof dev === 'string' ? JSON.parse(dev) : dev) || device;
                }
            } catch {
                /* truncated or unrelated line */
            }
        }
    }

    const out = {
        access_token: login ? withBearer(login.accessToken && login.accessToken.token) : '',
        access_expiration: login ? toSeconds(login.accessToken && login.accessToken.expirationTime) : 0,
        refresh_token: login ? withBearer(login.refreshToken && login.refreshToken.token) : '',
        refresh_expiration: login ? toSeconds(login.refreshToken && login.refreshToken.expirationTime) : 0,
        uid: (device && device.uid) || (login && login.uid) || '',
        productKey: (device && device.productKey) || '',
        deviceKey: (device && device.deviceKey) || '',
        deviceName: (device && device.deviceName) || '',
        productName: (device && device.productName) || '',
        userDomain: (props && props.userDomain) || '',
        area: (props && props.area) || '',
    };

    // Fallback if the device panel line is missing: the RN module logs "channelId===<pk>_<dk>".
    if (!out.productKey || !out.deviceKey) {
        const all = [...text.matchAll(/channelId===([A-Za-z0-9]+)_([A-Za-z0-9]+)/g)];
        const m = all[all.length - 1];
        if (m) {
            out.productKey = out.productKey || m[1];
            out.deviceKey = out.deviceKey || m[2];
        }
    }

    const missing = [];
    if (!out.access_token || !out.refresh_token) {
        missing.push('tokens (no successful emailPwdLogin line - did you log in with app V1.0.0 while capturing?)');
    }
    for (const key of ['uid', 'productKey', 'deviceKey']) {
        if (!out[key]) {
            missing.push(key);
        }
    }
    if (missing.length) {
        const deviceOnly = !missing.some(m => m.startsWith('tokens'));
        throw new Error(
            `Missing in log: ${missing.join(', ')}${deviceOnly ? ' - open your POWERSTATION in the app before dumping the log' : ''}`,
        );
    }
    return out;
}

function fmtTime(sec) {
    return sec ? new Date(sec * 1000).toLocaleString() : '?';
}

function main(argv) {
    const args = argv.slice(2);
    let input = null;
    let output = 'credentials.json';
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '-o' || args[i] === '--out') {
            output = args[++i];
        } else if (args[i] === '-h' || args[i] === '--help') {
            input = null;
            break;
        } else {
            input = args[i];
        }
    }
    if (!input || !output) {
        console.log('usage: node extract-credentials.js <login.log> [-o credentials.json]');
        return 2;
    }

    let creds;
    try {
        creds = parseLog(decodeLog(fs.readFileSync(input)));
    } catch (err) {
        console.error(`Error: ${err.message}`);
        return 1;
    }

    fs.writeFileSync(output, `${JSON.stringify(creds, null, 2)}\n`, { mode: 0o600 });
    try {
        fs.chmodSync(output, 0o600);
    } catch {
        /* not supported on this platform */
    }

    console.log(`Wrote ${path.resolve(output)}\n`);
    console.log('Enter these in the ioBroker adapter settings:');
    console.log(`  Access token          ${creds.access_token}`);
    console.log(`  Refresh token         ${creds.refresh_token}`);
    console.log(`  Access token expiry   ${creds.access_expiration}  (${fmtTime(creds.access_expiration)})`);
    console.log(`  Refresh token expiry  ${creds.refresh_expiration}  (${fmtTime(creds.refresh_expiration)})`);
    console.log(`  User id (uid)         ${creds.uid}`);
    console.log(`  Product key           ${creds.productKey}`);
    console.log(`  Device key            ${creds.deviceKey}`);
    if (creds.deviceName || creds.productName) {
        console.log(`\nDevice: ${creds.deviceName} (${creds.productName})`);
    }
    if (creds.refresh_expiration && creds.refresh_expiration <= Math.floor(Date.now() / 1000)) {
        console.log('\nWARNING: the refresh token has already expired - capture a fresh login.');
    }
    console.log("\nThis output and the file contain your login tokens - don't share them.");
    return 0;
}

if (require.main === module) {
    process.exitCode = main(process.argv);
} else {
    module.exports = { parseLog, decodeLog };
}
