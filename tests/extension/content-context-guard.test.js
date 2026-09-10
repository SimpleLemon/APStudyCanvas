"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const guard = require("../../js/content/context-guard.js");

test("invalidated extension contexts settle quietly and invoke teardown once", async () => {
    let teardowns = 0;
    const result = await guard.run(() => Promise.reject(new Error("Extension context invalidated")), { onInvalidated: () => { teardowns += 1; } });
    assert.deepEqual(result, { ok: false, invalidated: true });
    assert.equal(teardowns, 1);
    assert.equal(guard.isInvalidated(new Error("Extension context was invalidated")), true);
});

test("ordinary runtime errors remain rejected", async () => {
    await assert.rejects(
        guard.run(() => Promise.reject(new Error("storage unavailable"))),
        /storage unavailable/
    );
    assert.equal(guard.isInvalidated(new Error("permission denied")), false);
});

test("canonical, punctuated, and safely wrapped invalidated variants are recognized", () => {
    assert.equal(guard.isInvalidated(new Error("Extension context invalidated")), true);
    assert.equal(guard.isInvalidated(new Error("Extension context invalidated.")), true);
    assert.equal(guard.isInvalidated(new Error("Extension context invalidated!")), true);
    assert.equal(guard.isInvalidated(new Error("Extension context was invalidated.")), true);
    assert.equal(guard.isInvalidated(new Error("Uncaught Error: Extension context invalidated.")), true);
    assert.equal(guard.isInvalidated(new Error("Uncaught (in promise) Error: Extension context invalidated.")), true);
    assert.equal(guard.isInvalidated(new Error("TypeError: Extension context invalidated")), true);
    assert.equal(guard.isInvalidated("  Extension context invalidated.  "), true);
});

test("resembling but unrelated errors still propagate instead of being swallowed", async () => {
    assert.equal(guard.isInvalidated(new Error("Extension context invalidatedish")), false);
    assert.equal(guard.isInvalidated(new Error("The extension context was invalidated by the browser")), false);
    assert.equal(guard.isInvalidated(new Error("Extension context invalidated by reload; retrying")), false);
    assert.equal(guard.isInvalidated(new Error("Cannot read properties of undefined (reading 'id')")), false);
    assert.equal(guard.isInvalidated(new Error("TypeError: Cannot read properties of undefined (reading 'id')")), false);
    await assert.rejects(
        guard.run(() => Promise.reject(new Error("TypeError: Cannot read properties of undefined (reading 'id')"))),
        /reading 'id'/
    );
    await assert.rejects(
        guard.run(() => Promise.reject(new Error("storage unavailable"))),
        /storage unavailable/
    );
});
