"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const stateApi = require("../../js/canvas-adapter/sync-state.js");
const { createSyncEngine } = require("../../js/canvas-adapter/sync-engine.js");

const binding = Object.freeze({
    contractVersion: 1,
    accountKey: "account-hash",
    origin: "https://canvas.example.edu",
    userId: 123,
    providerUserId: "canvas-user-1",
    label: "Canvas",
    sourceId: "source-client",
    runId: "run-client",
    generation: 1,
    consentVersion: 1,
    sourceRef: "src1:opaque-engine",
    scope: { course: 42 },
    registeredDescriptorIds: ["assignments"]
});

function proof() {
    return {
        contractVersion: 1,
        account_key: "account-hash",
        consent_version: 1,
        identity: { authenticated: true, account_key: "account-hash" },
        consent: { current: true, account_key: "account-hash", consent_version: 1, scopes: ["full_history_upload", "ongoing_read"] }
    };
}

function make({ session = { accountKey: "account-hash", origin: binding.origin, userId: 123 }, stored } = {}) {
    const calls = [];
    let summary = stored;
    const store = {
        async get() { calls.push(["store.get"]); return summary; },
        async set(value) { calls.push(["store.set", value]); summary = value; }
    };
    const client = {
        async preflight(value) { calls.push(["preflight", value]); return { ok: true }; },
        async establishSource(value) { calls.push(["establishSource", value]); return { source_ref: "src1:opaque-engine", account_key: "account-hash", source_key: "canvas:account-hash" }; },
        async startRun(value) { calls.push(["startRun", value]); return { run_id: "run-server", generation: 7 }; },
        async status(value) { calls.push(["status", value]); return { generation: 1, secret: "never-return" }; },
        async resume(value) { calls.push(["resume", value]); return {}; },
        async cancel(value) { calls.push(["cancel", value]); return {}; }
    };
    const engine = createSyncEngine({ stateApi, client, summaryStore: store, resolveCanvasSession: async () => session });
    return { engine, calls, client, store, get summary() { return summary; } };
}

function waitingSummary() {
    const { providerUserId, label, ...stateBinding } = binding;
    const run = stateApi.createRun(stateBinding);
    return stateApi.toSafeSummary(stateApi.transition(run, { type: "wait" }).state);
}

test("disabled methods are idle and make zero dependency calls", async () => {
    const fake = make();
    assert.deepEqual(await fake.engine.start({ enabled: false, binding, proof: proof() }), { state: "idle", code: "feature_disabled" });
    assert.deepEqual(await fake.engine.getStatus({ enabled: false, binding }), { state: "idle", code: "feature_disabled" });
    assert.deepEqual(await fake.engine.resume({ enabled: false, binding, proof: proof() }), { state: "idle", code: "feature_disabled" });
    assert.deepEqual(await fake.engine.cancel({ enabled: false, binding }), { state: "idle", code: "feature_disabled" });
    assert.deepEqual(fake.calls, []);
});

test("start waits without a Canvas session and persists only a safe summary", async () => {
    const fake = make({ session: null });
    const result = await fake.engine.start({ enabled: true, binding, proof: proof() });
    assert.equal(result.state, "waiting_for_canvas_session");
    assert.equal(fake.calls.filter(([name]) => name === "establishSource").length, 0);
    assert.equal(fake.calls.filter(([name]) => name === "store.set").length, 1);
    assert.doesNotMatch(JSON.stringify(fake.summary), /proof|token|secret/i);
});

test("start mismatch throws before client or store writes", async () => {
    const fake = make({ session: { accountKey: "other-account", origin: binding.origin, userId: 123 } });
    await assert.rejects(fake.engine.start({ enabled: true, binding, proof: proof() }), (error) => error.code === "ACCOUNT_MISMATCH");
    assert.deepEqual(fake.calls, []);
});

test("valid start follows the safe call order and never persists proof", async () => {
    const fake = make();
    const result = await fake.engine.start({ enabled: true, binding, proof: proof() });
    assert.equal(result.binding.source_id, "source-client");
    assert.equal(result.binding.source_ref, "src1:opaque-engine");
    assert.equal(result.binding.run_id, "run-server");
    assert.equal(result.binding.generation, 7);
    assert.deepEqual(fake.calls.map(([name]) => name), ["preflight", "establishSource", "startRun", "store.set"]);
    assert.doesNotMatch(JSON.stringify(fake.summary), /authenticated|current|proof/i);
});

test("getStatus restores summaries, handles absent state, and rejects stale generations", async () => {
    const absent = make();
    assert.deepEqual(await absent.engine.getStatus({ enabled: true, binding }), { state: "idle" });
    const fake = make({ stored: waitingSummary() });
    const result = await fake.engine.getStatus({ enabled: true, binding });
    assert.equal(result.state, "waiting_for_canvas_session");
    assert.equal(fake.calls.some(([name]) => name === "status"), true);
    fake.client.status = async () => ({ generation: 999, secret: "private" });
    const stale = await fake.engine.getStatus({ enabled: true, binding });
    assert.deepEqual(stale, { state: "failed", code: "STALE_GENERATION" });
    assert.equal(fake.calls.filter(([name]) => name === "store.set").length, 0);
});

test("resume waits for a session or resumes an exact saved run", async () => {
    const waiting = make({ stored: waitingSummary(), session: null });
    assert.equal((await waiting.engine.resume({ enabled: true, binding, proof: proof() })).state, "waiting_for_canvas_session");
    assert.equal(waiting.calls.some(([name]) => name === "preflight"), false);
    const exact = make({ stored: waitingSummary() });
    assert.equal((await exact.engine.resume({ enabled: true, binding, proof: proof() })).state, "running");
    assert.deepEqual(exact.calls.map(([name]) => name), ["store.get", "preflight", "resume", "store.set"]);
});

test("cancel is idempotent and dependency errors are bounded", async () => {
    const { providerUserId, label, ...stateBinding } = binding;
    const cancelled = stateApi.transition(stateApi.createRun(stateBinding), { type: "cancel" }).state;
    const idempotent = make({ stored: stateApi.toSafeSummary(cancelled) });
    assert.equal((await idempotent.engine.cancel({ enabled: true, binding })).state, "cancelled");
    assert.equal(idempotent.calls.some(([name]) => name === "cancel"), false);
    const broken = make();
    broken.client.preflight = async () => { throw Object.assign(new Error("secret body"), { code: "SYNC_SECRET_REJECTED", body: "private" }); };
    const failure = await broken.engine.start({ enabled: true, binding, proof: proof() });
    assert.deepEqual(failure, { state: "failed", errorCode: "SYNC_SECRET_REJECTED" });
    assert.doesNotMatch(JSON.stringify(failure), /secret body|private/i);
});
