"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const { parseLog, decodeLog } = require("../tools/extract-credentials");

const prefix = (tag) => `11-15 15:23:23.656 14241 14241 I ${tag}: `;

function loginLine(access, refresh, exp) {
    return prefix("System.out") + "emailPwdLogin--:" + JSON.stringify({
        code: 200, msg: "",
        data: {
            accessToken: { token: `Bearer ${access}`, expirationTime: exp },
            refreshToken: { token: `Bearer ${refresh}`, expirationTime: exp + 2592000 },
        },
    });
}

function rnLine(device) {
    return prefix("ReactNativeJS") + 'Running "QuecRNAPP" with ' + JSON.stringify({
        initialProps: { userDomain: "E.DM.1.3", area: "europe", token: null, device: JSON.stringify(device) },
        rootTag: 1,
    });
}

const DEVICE = { uid: "U1", productKey: "pkX", deviceKey: "DK1", deviceName: "GRID+_1", productName: "POWERSTATION GRID+" };

test("extracts tokens and device ids from a logcat dump, last login wins", () => {
    const log = [
        prefix("ActivityManager") + "unrelated",
        loginLine("old.access", "old.refresh", 1794750000),
        rnLine(DEVICE),
        loginLine("new.access", "new.refresh", 1794760000),
    ].join("\r\n");

    const c = parseLog(log);
    assert.strictEqual(c.access_token, "Bearer new.access");
    assert.strictEqual(c.refresh_token, "Bearer new.refresh");
    assert.strictEqual(c.access_expiration, 1794760000);
    assert.strictEqual(c.refresh_expiration, 1794760000 + 2592000);
    assert.deepStrictEqual([c.uid, c.productKey, c.deviceKey], ["U1", "pkX", "DK1"]);
    assert.strictEqual(c.area, "europe");
});

test("decodes a UTF-16LE file as written by Windows PowerShell", () => {
    const text = [loginLine("a", "r", 1794760000), rnLine(DEVICE)].join("\r\n");
    const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
    assert.strictEqual(parseLog(decodeLog(buf)).access_token, "Bearer a");
});

test("falls back to channelId for product/device key", () => {
    const log = [
        loginLine("a", "r", 1794760000),
        prefix("QuecRNDeviceModule") + "channelId===pkX_DK1",
    ].join("\n");
    assert.throws(() => parseLog(log), /Missing in log: uid - open your POWERSTATION/);
});

test("reports a missing login clearly", () => {
    assert.throws(() => parseLog(rnLine(DEVICE)), /no successful emailPwdLogin line/);
});
