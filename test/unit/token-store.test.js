"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { TokenStore } = require("../../lib/token-store");

const crypto = {
    encrypt: (s) => `enc:${Buffer.from(s).toString("base64")}`,
    decrypt: (s) => Buffer.from(s.replace(/^enc:/, ""), "base64").toString(),
};

test("round-trips the bundle and never writes it in plain text", async (t) => {
    const dir = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "sb-")), "sunbooster.0");
    t.after(() => fs.rm(path.dirname(dir), { recursive: true, force: true }));
    const store = new TokenStore(dir, crypto);

    assert.strictEqual(await store.load(), null);

    const bundle = { accessToken: "Bearer secret-a", refreshToken: "Bearer secret-r", refreshExpiration: 42 };
    await store.save(bundle);

    const raw = await fs.readFile(path.join(dir, "tokens.json"), "utf8");
    assert.ok(!raw.includes("secret"));
    if (process.platform !== "win32") {
        assert.strictEqual((await fs.stat(path.join(dir, "tokens.json"))).mode & 0o777, 0o600);
    }
    assert.deepStrictEqual(await store.load(), bundle);
});
