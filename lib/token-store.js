"use strict";

const fs = require("fs/promises");
const path = require("path");

const FILE_NAME = "tokens.json";

/**
 * Persists the rotating token bundle as an encrypted file in the instance data directory,
 * so the tokens are never exposed through states/objects (and thus not via REST/simple-api).
 */
class TokenStore {
    /**
     * @param {string} dir instance data directory
     * @param {{encrypt: (s: string) => string, decrypt: (s: string) => string}} crypto
     */
    constructor(dir, crypto) {
        this.dir = dir;
        this.file = path.join(dir, FILE_NAME);
        this.crypto = crypto;
    }

    /** @returns {Promise<object|null>} the stored bundle, or null if there is none */
    async load() {
        let raw;
        try {
            raw = await fs.readFile(this.file, "utf8");
        } catch (err) {
            if (err.code === "ENOENT") return null;
            throw err;
        }
        return JSON.parse(this.crypto.decrypt(raw.trim()));
    }

    async save(bundle) {
        await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
        const tmp = `${this.file}.tmp`;
        await fs.writeFile(tmp, this.crypto.encrypt(JSON.stringify(bundle)), { mode: 0o600 });
        await fs.rename(tmp, this.file);
    }
}

module.exports = { TokenStore };
