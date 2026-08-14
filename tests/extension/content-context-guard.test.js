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
