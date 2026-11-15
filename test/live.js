"use strict";

/**
 * Live integration check for the Sunbooster client against a real device.
 * NOT part of the adapter runtime and never committed with secrets: it reads a
 * credentials file from SUNBOOSTER_CRED (default ~/.config or the path below).
 *
 *   node test/live.js                 # 20s of live data
 *   node test/live.js --refresh       # also exercise token refresh (rotates tokens)
 *   node test/live.js --feed 200      # also set feed-in to 200 W, then back to 0
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { SunboosterClient } = require("../lib/client");
const mapping = require("../lib/mapping");

const CRED = process.env.SUNBOOSTER_CRED || path.join(os.homedir(), "sunbooster-secrets", "credentials.json");
const cred = JSON.parse(fs.readFileSync(CRED, "utf8"));

const args = process.argv.slice(2);
const doRefresh = args.includes("--refresh");
const feedIdx = args.indexOf("--feed");
const feedW = feedIdx !== -1 ? Number(args[feedIdx + 1]) : null;

const log = {
    debug: (m) => console.log("  [dbg]", m),
    info: (m) => console.log("  [inf]", m),
    warn: (m) => console.log("  [wrn]", m),
    error: (m) => console.log("  [err]", m),
};

const client = new SunboosterClient(
    {
        accessToken: cred.access_token,
        refreshToken: cred.refresh_token,
        accessExpiration: cred.access_expiration,
        refreshExpiration: cred.refresh_expiration,
        uid: cred.uid,
        productKey: cred.productKey,
        deviceKey: cred.deviceKey,
    },
    log,
);

client.on("connection", (ok) => console.log(`connection: ${ok}`));
client.on("online", (on) => console.log(`online: ${on}`));
client.on("authfailed", (e) => console.log("AUTH FAILED:", e.message));

let dataCount = 0;
client.on("data", (kv) => {
    dataCount++;
    const show = {};
    for (const k of ["battery_percentage", "charge_mode_data_hm", "MIG_connection_data_hm", "charge_mode_power_hm", "ac_output_Power", "device_status"]) {
        if (kv[k] !== undefined) show[k] = kv[k];
    }
    if (Object.keys(show).length) console.log(`data#${dataCount}:`, JSON.stringify(show));
});

client.on("tokens", (bundle) => {
    cred.access_token = bundle.accessToken;
    cred.refresh_token = bundle.refreshToken;
    cred.access_expiration = bundle.accessExpiration;
    cred.refresh_expiration = bundle.refreshExpiration;
    fs.writeFileSync(CRED, JSON.stringify(cred, null, 2));
    console.log("tokens rotated & persisted to credentials file");
});

(async () => {
    if (doRefresh) {
        console.log("== forcing token refresh ==");
        await client.refreshTokens();
    }

    console.log("== starting live client (20s) ==");
    await client.start();
    await new Promise((r) => setTimeout(r, 8000));

    if (feedW !== null) {
        const v = mapping.feedWattsToValue(feedW);
        console.log(`== control: feed ${feedW}W (MIG value ${v}) ==`);
        await client.control("MIG_connection_data_hm", v);
        await new Promise((r) => setTimeout(r, 6000));
        console.log("== control: feed OFF (value 0) ==");
        await client.control("MIG_connection_data_hm", 0);
        await new Promise((r) => setTimeout(r, 4000));
    } else {
        await new Promise((r) => setTimeout(r, 12000));
    }

    await client.stop();
    console.log(`== done; received ${dataCount} data update(s) ==`);
    process.exit(0);
})().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
