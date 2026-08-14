"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const state = require(path.resolve(__dirname, "../../js/canvas-adapter/sync-state.js"));

const BINDING = Object.freeze({
    contractVersion: 1,
    accountKey: "account-hash",
    origin: "https://canvas.example.edu",
    userId: 123,
    sourceId: "canvas-source",
    runId: "run-1",
    generation: 7,
    consentVersion: 1,
    sourceRef: "src1:opaque-state",
    scope: { course: 42, type: "assignment" },
    registeredDescriptorIds: ["assignments", "quizzes"]
});

function run() {
    const result = state.createRun(BINDING);
    assert.ok(result);
    return result;
}

function transition(current, action) {
    const result = state.transition(current, { generation: BINDING.generation, ...action });
    assert.equal(result.ok, true, result.code);
    return result.state;
}

test("createRun normalizes the version-one binding and is immutable", () => {
    const current = run();
    assert.equal(current.version, 1);
    assert.equal(current.binding.userId, "123");
    assert.match(current.binding.scopeHash, /^h-/);
    assert.deepEqual(current.binding.registeredDescriptorIds, ["assignments", "quizzes"]);
    assert.equal(current.state, "running");
    assert.equal(Object.isFrozen(current), true);
    assert.equal(Object.isFrozen(current.binding), true);
});

test("wait, resume, progress, finalize, cancel, fail, and supersede are bounded state transitions", () => {
    let current = run();
    current = transition(current, { type: "wait", requestId: "wait-1" });
    assert.equal(current.state, "waiting_for_canvas_session");
    current = transition(current, { type: "resume", requestId: "resume-1" });
    current = transition(current, { type: "progress", descriptorId: "assignments", state: "exhausted", counts: { items: 4 }, checkpointHash: "cp-a", requestId: "progress-a" });
    current = transition(current, { type: "progress", descriptorId: "quizzes", state: "partial", counts: { items: 2 }, requestId: "progress-b" });
    assert.equal(transition(current, { type: "finalize", requestId: "finalize-1" }).state, "partial");
    current = transition(current, { type: "progress", descriptorId: "quizzes", state: "exhausted", counts: { items: 3 }, requestId: "progress-c" });
    current = transition(current, { type: "finalize", requestId: "finalize-2" });
    assert.equal(current.state, "completed");
    assert.equal(current.complete, true);
    assert.equal(current.tombstoneEligible, true);

    const cancelled = transition(run(), { type: "cancel", requestId: "cancel-1" });
    assert.equal(cancelled.state, "cancelled");
    const failed = transition(run(), { type: "fail", errorCode: "CANVAS_UNAVAILABLE", requestId: "fail-1" });
    assert.equal(failed.state, "failed");
    const replacement = transition(run(), {
        type: "supersede",
        nextBinding: { ...BINDING, generation: 8 },
        requestId: "supersede-1"
    });
    assert.equal(replacement.binding.generation, 8);
    assert.equal(replacement.state, "running");
});

test("strict binding and generation fences reject stale actions without mutation", () => {
    const current = run();
    const stale = state.transition(current, { type: "wait", generation: 6, requestId: "stale-1" });
    assert.equal(stale.ok, false);
    assert.equal(stale.code, "SYNC_BINDING_OR_GENERATION_MISMATCH");
    assert.equal(stale.state, current);
    const wrongBinding = state.transition(current, { type: "wait", generation: 7, accountKey: "other-account", requestId: "stale-2" });
    assert.equal(wrongBinding.ok, false);
    assert.equal(wrongBinding.state, current);
    assert.equal(current.state, "running");
    assert.deepEqual(current.progress, {});
});

test("request ids are idempotent for equal payloads and reject conflicting replay", () => {
    const current = run();
    const first = state.transition(current, { type: "progress", generation: 7, descriptorId: "assignments", state: "partial", count: 1, requestId: "same-1" });
    assert.equal(first.ok, true);
    const duplicate = state.transition(first.state, { type: "progress", generation: 7, descriptorId: "assignments", state: "partial", count: 1, requestId: "same-1" });
    assert.equal(duplicate.ok, true);
    assert.equal(duplicate.replayed, true);
    assert.deepEqual(duplicate.state, first.state);
    const conflict = state.transition(first.state, { type: "progress", generation: 7, descriptorId: "assignments", state: "exhausted", count: 1, requestId: "same-1" });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.code, "SYNC_REPLAY_CONFLICT");
    assert.deepEqual(conflict.state, first.state);
});

test("safe summaries contain only bounded state data and round-trip", () => {
    let current = transition(run(), { type: "progress", descriptorId: "assignments", state: "exhausted", count: 4, checkpointHash: "checkpoint-a", requestId: "safe-1" });
    const summary = state.toSafeSummary(current);
    const serialized = JSON.stringify(summary);
    assert.doesNotMatch(serialized, /token|cookie|csrf|raw|event|title|description|url/i);
    assert.equal(Object.prototype.hasOwnProperty.call(summary.binding, "scope"), false);
    const restored = state.restoreSafeSummary(summary);
    assert.equal(restored.ok, true);
    assert.deepEqual(state.toSafeSummary(restored.state), summary);
    assert.equal(state.restoreSafeSummary({ ...summary, summary_version: 99 }).code, "SYNC_SUMMARY_VERSION_UNSUPPORTED");
    assert.equal(state.restoreSafeSummary({ ...summary, unexpected: true }).code, "SYNC_SUMMARY_CORRUPT");
});

test("secret injection and unsafe summary values are rejected", () => {
    assert.equal(state.createRun({ ...BINDING, token: "opaque" }), null);
    assert.equal(state.createRun({ ...BINDING, scope: { title: "private" } }), null);
    const summary = state.toSafeSummary(run());
    for (const injected of [
        { token: "opaque" },
        { cookie: "session=opaque" },
        { csrf: "opaque" },
        { raw_event: "private" },
        { description: "private" },
        { url: "https://private.example" }
    ]) {
        assert.equal(state.restoreSafeSummary({ ...summary, ...injected }).ok, false, JSON.stringify(injected));
    }
    assert.equal(state.restoreSafeSummary(JSON.stringify(summary) + "x").code, "SYNC_SUMMARY_CORRUPT");
});

test("disabled and failed descriptors never become complete", () => {
    let current = run();
    current = transition(current, { type: "progress", descriptorId: "assignments", state: "disabled", requestId: "disabled-1" });
    current = transition(current, { type: "progress", descriptorId: "quizzes", state: "exhausted", requestId: "exhausted-1" });
    const finalized = transition(current, { type: "finalize", requestId: "disabled-finalize" });
    assert.equal(finalized.state, "partial");
    assert.equal(finalized.complete, false);
    assert.equal(finalized.tombstoneEligible, false);
});
