"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const schema = require("../../js/settings-schema.js");
const popup = require("../../js/popup-controller.js");

const ACCOUNT_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

test("per-account opt-in is local-only, default-isolated, and excluded from reset/import", () => {
    const first = schema.defaultsForArea("local");
    first.canvas_sync_opt_in[ACCOUNT_KEY] = true;
    assert.deepEqual(schema.defaultsForArea("local").canvas_sync_opt_in, {});
    assert.equal(Object.prototype.hasOwnProperty.call(schema.defaultsForArea("sync"), "canvas_sync_opt_in"), false);
    assert.equal(schema.knownResettableKeys.includes("canvas_sync_opt_in"), false);
    assert.equal(popup.validateImportData({ canvas_sync_opt_in: { [ACCOUNT_KEY]: true } }), false);
});

test("per-account opt-in rejects malformed, oversized, and secret-shaped values", () => {
    const oversized = Object.fromEntries(Array.from({ length: schema.CANVAS_SYNC_OPT_IN_MAX_ACCOUNTS + 1 }, (_, index) => [index.toString(16).padStart(64, "0"), true]));
    for (const value of [
        { [ACCOUNT_KEY]: "yes" },
        oversized,
        { "Bearer secret": true },
        { [ACCOUNT_KEY]: true, authorization: false }
    ]) {
        const result = schema.validateSettingValue("local", "canvas_sync_opt_in", value);
        assert.equal(result.valid, false, JSON.stringify(value));
        assert.equal(result.code, "SETTINGS_VALUE_INVALID");
    }
    assert.equal(schema.validateSettingValue("local", "canvas_sync_opt_in", { [ACCOUNT_KEY]: true }).valid, true);
});
