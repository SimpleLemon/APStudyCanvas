"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createCanvasSyncStorage } = require("../../js/platform/canvas-sync-storage.js");

function area(initial = {}) {
    const values = new Map(Object.entries(initial));
    const calls = [];
    return {
        calls,
        values,
        async get(key) { calls.push(["get", key]); return { [key]: values.get(key) }; },
        async set(value) { calls.push(["set", value]); Object.entries(value).forEach(([key, item]) => values.set(key, item)); },
        async remove(key) { calls.push(["remove", key]); values.delete(key); }
    };
}

function make() {
    const session = area();
    const local = area();
    const stateApi = {
        toSafeSummary(run) { return run.summary; },
        restoreSafeSummary(summary) { return { ok: true, state: { restored: summary } }; }
    };
    const hashKey = (value) => `h-${Buffer.from(String(value)).toString("hex").slice(0, 40)}`;
    return { storage: createCanvasSyncStorage({ storage: { session, local }, stateApi, hashKey }), session, local, stateApi, hashKey };
}

const binding = Object.freeze({ sourceId: "source-a", runId: "run-a", generation: 7 });

test("constructor requires complete session and local storage areas", () => {
    assert.throws(() => createCanvasSyncStorage({ storage: { local: area() } }), /STORAGE_SESSION_UNAVAILABLE/);
    assert.throws(() => createCanvasSyncStorage({ storage: { session: area(), local: { get() {} } } }), /STORAGE_SESSION_UNAVAILABLE/);
});

test("lease storage is session-only, exact-binding, restart-safe, and removable", async () => {
    const first = make();
    await first.storage.leaseStore.set(binding, "opaque-lease");
    assert.equal(first.local.calls.length, 0);
    assert.equal(await first.storage.leaseStore.get(binding), "opaque-lease");
    assert.equal(await first.storage.leaseStore.get({ ...binding, generation: 8 }), null);

    const restarted = createCanvasSyncStorage({ storage: { session: first.session, local: first.local }, stateApi: first.stateApi, hashKey: first.hashKey });
    assert.equal(await restarted.leaseStore.get(binding), "opaque-lease");
    await restarted.leaseStore.remove(binding);
    assert.equal(await first.storage.leaseStore.get(binding), null);
    assert.equal(first.local.calls.length, 0);
});

test("summary storage is local-only, restores safe summaries, and fails closed", async () => {
    const fake = make();
    const run = { summary: { summary_version: 1, binding: { source_id: binding.sourceId, run_id: binding.runId, generation: binding.generation }, nested: { count: 2 } } };
    await fake.storage.summaryStore.set(binding, run);
    assert.equal(fake.session.calls.length, 0);
    assert.deepEqual(await fake.storage.summaryStore.get(binding), { restored: run.summary });

    const key = Array.from(fake.local.values.keys())[0];
    fake.local.values.set(key, { v: 1, summary: { secret_value: "do-not-store" } });
    assert.equal(await fake.storage.summaryStore.get(binding), null);
    fake.local.values.set(key, { v: 99, summary: run.summary });
    assert.equal(await fake.storage.summaryStore.get(binding), null);
});

test("summary rejects recursive secrets and oversized JSON before local writes", async () => {
    const fake = make();
    await assert.rejects(fake.storage.summaryStore.set(binding, { summary: { nested: [{ csrfProof: "x" }] } }), /STORAGE_SUMMARY_SECRET_FORBIDDEN/);
    await assert.rejects(fake.storage.summaryStore.set(binding, { summary: { payload: "x".repeat(64 * 1024) } }), /STORAGE_SUMMARY_TOO_LARGE/);
    assert.equal(fake.local.calls.length, 0);
});

test("run index accepts only bounded hashed refs and uses local storage", async () => {
    const fake = make();
    await fake.storage.runIndex.set("h-ref", "h-binding");
    assert.equal(await fake.storage.runIndex.get("h-ref"), "h-binding");
    assert.equal(fake.session.calls.length, 0);
    await assert.rejects(fake.storage.runIndex.set("raw/source", "h-binding"), /STORAGE_INDEX_REF_INVALID/);
    await fake.storage.runIndex.remove("h-ref");
    assert.equal(await fake.storage.runIndex.get("h-ref"), null);
});

test("public snapshot projects presence booleans and zero count without values", async () => {
    const fake = make();
    await fake.storage.leaseStore.set(binding, "secret-token");
    await fake.storage.runIndex.set("h-ref", "h-binding");
    const snapshot = await fake.storage.publicSnapshot({ binding, hashRef: "h-ref" });
    assert.deepEqual(snapshot, { hasLease: true, hasSummary: false, hasIndex: true, indexCount: 0 });
    assert.equal(JSON.stringify(snapshot).includes("secret-token"), false);
});
