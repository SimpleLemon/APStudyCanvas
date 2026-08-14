"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const stateApi = require("../../js/canvas-adapter/sync-state.js");
const { createSyncFinalizer } = require("../../js/canvas-adapter/sync-finalizer.js");

const binding = Object.freeze({
    contractVersion: 1,
    accountKey: "account-hash",
    origin: "https://canvas.example.edu",
    userId: 123,
    sourceId: "source-a",
    runId: "run-a",
    generation: 7,
    consentVersion: 1,
    sourceRef: "src1:opaque-finalizer",
    scope: { course: 42 },
    registeredDescriptorIds: ["assignments", "quizzes"]
});

function transition(run, action) {
    const result = stateApi.transition(run, { generation: binding.generation, ...action });
    assert.equal(result.ok, true, result.code);
    return result.state;
}

function summary({ assignments = "exhausted", quizzes = "exhausted", state = "running" } = {}) {
    let run = stateApi.createRun(binding);
    run = transition(run, { type: "progress", descriptorId: "assignments", state: assignments, count: 2 });
    run = transition(run, { type: "progress", descriptorId: "quizzes", state: quizzes, count: 3 });
    if (state === "completed") run = transition(run, { type: "finalize" });
    return stateApi.toSafeSummary(run);
}

function fake({ pending = 0, current = binding.generation, response, error, stored } = {}) {
    const calls = [];
    let saved = stored;
    const outbox = {
        async pendingCount(namespace) { calls.push(["pendingCount", namespace]); return pending; },
        async currentGeneration(namespace) { calls.push(["currentGeneration", namespace]); return typeof current === "function" ? current() : current; }
    };
    const client = {
        async finalize(value, target) {
            calls.push(["finalize", value, target]);
            if (error) throw error;
            return response || { run_id: binding.runId, generation: binding.generation, status: target, secret: "never-store" };
        }
    };
    const summaryStore = { async set(value) { calls.push(["store.set", value]); saved = value; } };
    return { finalizer: createSyncFinalizer({ stateApi, client, outbox, summaryStore }), calls, get saved() { return saved; } };
}

test("pending work returns queued with the exact namespace and no completion calls", async () => {
    const fakeState = fake({ pending: 2 });
    const result = await fakeState.finalizer.finalizeIfReady({ enabled: true, binding, runSummary: summary(), requestId: "pending-1" });
    assert.equal(result.state, "running");
    assert.equal(result.status, "queued");
    assert.equal(fakeState.calls[0][0], "pendingCount");
    assert.deepEqual(fakeState.calls[0][1], { account: "account-hash", source: "source-a", run: "run-a", generation: 7 });
    assert.equal(fakeState.calls.some(([name]) => name === "finalize" || name === "store.set"), false);
});

test("complete finalization requires an exact server receipt and persists only a safe summary", async () => {
    const fakeState = fake({});
    const result = await fakeState.finalizer.finalizeIfReady({ enabled: true, binding, runSummary: summary({ state: "completed" }), requestId: "complete-1" });
    assert.equal(result.state, "completed");
    assert.equal(result.status, "complete");
    assert.equal(result.tombstoneEligible, true);
    assert.equal(fakeState.calls.filter(([name]) => name === "finalize").length, 1);
    assert.doesNotMatch(JSON.stringify(fakeState.saved), /never-store|secret|raw|token/i);
});

test("disabled descriptors target partial and persist safe partial state", async () => {
    const fakeState = fake({});
    const partial = summary({ quizzes: "disabled" });
    const result = await fakeState.finalizer.finalizeIfReady({ enabled: true, binding, runSummary: partial, requestId: "partial-1" });
    assert.equal(result.state, "partial");
    assert.equal(result.status, "partial");
    assert.equal(result.tombstoneEligible, false);
    assert.equal(fakeState.saved.state, "partial");
    assert.equal(fakeState.saved.tombstone_eligible, false);
});

test("stale generation is fenced before and after the injected client", async () => {
    const before = fake({ current: 8 });
    const pre = await before.finalizer.finalizeIfReady({ enabled: true, binding, runSummary: summary(), requestId: "stale-before" });
    assert.equal(pre.state, "superseded");
    assert.equal(before.calls.some(([name]) => name === "finalize"), false);

    let reads = 0;
    const after = fake({ current: () => (reads++ === 0 ? 7 : 8) });
    const post = await after.finalizer.finalizeIfReady({ enabled: true, binding, runSummary: summary(), requestId: "stale-after" });
    assert.equal(post.state, "superseded");
    assert.equal(after.calls.some(([name]) => name === "store.set"), false);
});

test("malformed and auth errors become redacted failed partial results", async () => {
    const malformed = fake({ response: { run_id: "wrong", generation: 7, status: "complete", accessToken: "secret" } });
    const malformedResult = await malformed.finalizer.finalizeIfReady({ enabled: true, binding, runSummary: summary({ state: "completed" }), requestId: "malformed-1" });
    assert.equal(malformedResult.errorCode, "MALFORMED");
    assert.doesNotMatch(JSON.stringify(malformedResult), /secret|accessToken/i);

    const forbidden = fake({ error: Object.assign(new Error("private secret"), { status: 403 }) });
    const forbiddenResult = await forbidden.finalizer.finalizeIfReady({ enabled: true, binding, runSummary: summary(), requestId: "forbidden-1" });
    assert.equal(forbiddenResult.errorCode, "FORBIDDEN");
    assert.doesNotMatch(JSON.stringify(forbidden.saved), /private|secret/i);
});

test("request replay is idempotent and a changed target conflicts", async () => {
    const fakeState = fake({});
    const complete = summary({ state: "completed" });
    const first = await fakeState.finalizer.finalizeIfReady({ enabled: true, binding, runSummary: complete, requestId: "replay-1" });
    const second = await fakeState.finalizer.finalizeIfReady({ enabled: true, binding, runSummary: complete, requestId: "replay-1" });
    assert.equal(first.state, "completed");
    assert.deepEqual(second, first);
    assert.equal(fakeState.calls.filter(([name]) => name === "finalize").length, 1);
    const conflict = await fakeState.finalizer.finalizeIfReady({ enabled: true, binding, runSummary: summary(), requestId: "replay-1" });
    assert.equal(conflict.errorCode, "SYNC_REPLAY_CONFLICT");
    assert.equal(fakeState.calls.filter(([name]) => name === "finalize").length, 1);
});

test("a partial run cannot become complete within the same generation", async () => {
    const fakeState = fake({});
    const exhaustedButRunning = summary();
    const result = await fakeState.finalizer.finalizeIfReady({ enabled: true, binding, runSummary: exhaustedButRunning, requestId: "partial-lock-1" });
    assert.equal(result.state, "partial");
    assert.equal(result.tombstoneEligible, false);
    assert.equal(fakeState.saved.state, "partial");
    assert.equal(fakeState.calls.find(([name]) => name === "finalize")[2], "partial");
});
