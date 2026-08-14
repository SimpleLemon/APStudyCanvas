"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createCanvasSyncCycle } = require("../../js/platform/canvas-sync-cycle.js");

const BINDING = Object.freeze({
    accountKey: "account-hash",
    origin: "https://canvas.example.edu",
    canvasUserId: "canvas-user-1",
    sourceId: "source-1",
    runId: "run-1",
    generation: 7,
    consentVersion: "consent-v1",
    scope: { courses: [42] },
    descriptors: [{ id: "assignments" }],
    requestId: "request-1"
});

const SESSION = { accountKey: BINDING.accountKey, origin: BINDING.origin, canvasUserId: BINDING.canvasUserId, tab: { id: 19 } };
const SUMMARY = Object.freeze({ extractionComplete: true, progress: { assignments: { state: "exhausted" } } });

function extraction(overrides = {}) {
    return {
        contract_version: 1,
        request_id: "corr-1",
        type: "CANVAS_SYNC_EXTRACT_INTERNAL",
        payload: {
            ok: true,
            state: "complete",
            batches: [],
            descriptorProgress: 1,
            quarantineCount: 0,
            checkpointHash: "checkpoint-1",
            complete: true,
            ...overrides
        }
    };
}

function make(overrides = {}) {
    const calls = [];
    let pending = 0;
    const generations = Array.isArray(overrides.generations) ? overrides.generations.slice() : null;
    const cycle = createCanvasSyncCycle({
        getFeatureFlags: () => ({ upload: true }),
        resolveCanvasSession: async (value) => { calls.push(["session", value]); return SESSION; },
        requestExtraction: async (tabId, envelope) => { calls.push(["extract", tabId, envelope]); return extraction(); },
        extractStage: { queueResult: async (value) => { calls.push(["stage", value]); if (overrides.stagePending !== undefined) pending = overrides.stagePending; return { state: "queued", queued: 1 }; } },
        uploader: { uploadNext: async (value) => { calls.push(["upload", value]); if (overrides.uploadPending !== undefined) pending = overrides.uploadPending; return overrides.uploadResult || { state: "idle" }; } },
        finalizer: { finalizeIfReady: async (value) => { calls.push(["finalize", value]); return overrides.finalizerResult || { state: "completed", errorCode: null }; } },
        outbox: {
            pendingCount: async (value) => { calls.push(["pending", value]); return pending; },
            currentGeneration: async (value) => { calls.push(["generation", value]); return generations ? generations.shift() : BINDING.generation; }
        },
        scheduleResume: async (value) => { calls.push(["schedule", value]); },
        idFactory: () => "corr-1",
        ...overrides
    });
    return { cycle, calls, setPending(value) { pending = value; } };
}

test("disabled upload is idle with zero dependency calls", async () => {
    const calls = [];
    const cycle = createCanvasSyncCycle({
        getFeatureFlags: () => ({ upload: false }),
        resolveCanvasSession: () => { calls.push("session"); },
        requestExtraction: () => { calls.push("extract"); },
        outbox: { pendingCount: () => { calls.push("outbox"); } },
        idFactory: () => { calls.push("id"); }
    });
    assert.deepEqual(await cycle.runCycle({ binding: BINDING }), { state: "idle", errorCode: "feature_disabled" });
    assert.deepEqual(calls, []);
});

test("missing and mismatched sessions are safe without extraction, upload, or finalize", async () => {
    const missing = make();
    missing.cycle = createCanvasSyncCycle({ getFeatureFlags: () => ({ upload: true }), resolveCanvasSession: async () => { missing.calls.push(["session"]); return null; }, idFactory: () => "corr-1" });
    assert.equal((await missing.cycle.runCycle({ binding: BINDING })).state, "waiting");
    assert.deepEqual(missing.calls.map(([name]) => name), ["session"]);

    const mismatch = make();
    mismatch.cycle = createCanvasSyncCycle({ getFeatureFlags: () => ({ upload: true }), resolveCanvasSession: async () => { mismatch.calls.push(["session"]); return { ...SESSION, accountKey: "other" }; }, idFactory: () => "corr-1" });
    const result = await mismatch.cycle.runCycle({ binding: BINDING });
    assert.equal(result.errorCode, "binding_mismatch");
    assert.deepEqual(mismatch.calls.map(([name]) => name), ["session"]);
});

test("pending work uploads first and never extracts", async () => {
    const fake = make({ uploadResult: { state: "queued", retryAfterMs: 500 }, uploadPending: 1 });
    fake.setPending(1);
    const result = await fake.cycle.runCycle({ binding: BINDING, runSummary: SUMMARY });
    assert.equal(result.state, "running");
    assert.equal(fake.calls.filter(([name]) => name === "extract").length, 0);
    assert.equal(fake.calls.filter(([name]) => name === "upload").length, 1);
    assert.equal(fake.calls.filter(([name]) => name === "schedule").length, 1);
});

test("empty outbox stages extraction and performs at most one upload", async () => {
    const fake = make({ stagePending: 1, uploadPending: 0 });
    const result = await fake.cycle.runCycle({ binding: { ...BINDING, requestId: undefined }, runSummary: { extractionComplete: false } });
    assert.equal(result.state, "completed");
    assert.equal(fake.calls.filter(([name]) => name === "extract").length, 1);
    assert.equal(fake.calls.filter(([name]) => name === "stage").length, 1);
    assert.equal(fake.calls.filter(([name]) => name === "upload").length, 1);
    assert.deepEqual(fake.calls.find(([name]) => name === "extract")[1], 19);
    const envelope = fake.calls.find(([name]) => name === "extract")[2];
    assert.deepEqual(Object.keys(envelope).sort(), ["contract_version", "payload", "request_id", "type"]);
    assert.equal(envelope.type, "CANVAS_SYNC_EXTRACT_INTERNAL");
    assert.equal(envelope.payload.generation, 7);
});

test("retry schedules one bounded resume and exhausted work does not loop", async () => {
    const retry = make({ uploadResult: { state: "retry", retryAfterMs: 999999 }, uploadPending: 1 });
    retry.setPending(1);
    await retry.cycle.runCycle({ binding: BINDING, runSummary: SUMMARY });
    const schedule = retry.calls.find(([name]) => name === "schedule");
    assert.deepEqual(schedule[1], { delayMs: 300000, reason: "upload" });

    const exhausted = make({ uploadResult: { state: "paused", code: "retry_exhausted" }, uploadPending: 1 });
    exhausted.setPending(1);
    const result = await exhausted.cycle.runCycle({ binding: BINDING, runSummary: SUMMARY });
    assert.equal(result.state, "paused");
    assert.equal(exhausted.calls.filter(([name]) => name === "schedule").length, 0);
});

test("stale generation at each boundary stops the cycle safely", async () => {
    const before = make({ generations: [8] });
    before.setPending(0);
    assert.equal((await before.cycle.runCycle({ binding: BINDING, runSummary: { extractionComplete: false } })).errorCode, "stale_generation");
    assert.equal(before.calls.filter(([name]) => name === "extract").length, 0);

    const afterExtraction = make({ generations: [7, 8] });
    afterExtraction.setPending(0);
    assert.equal((await afterExtraction.cycle.runCycle({ binding: BINDING, runSummary: { extractionComplete: false } })).errorCode, "stale_generation");
    assert.equal(afterExtraction.calls.filter(([name]) => name === "stage").length, 0);

    const afterUpload = make({ uploadPending: 0, uploadResult: { state: "idle" }, generations: [7, 8] });
    afterUpload.setPending(1);
    assert.equal((await afterUpload.cycle.runCycle({ binding: BINDING, runSummary: SUMMARY })).errorCode, "stale_generation");
    assert.equal(afterUpload.calls.filter(([name]) => name === "finalize").length, 0);
});

test("partial extraction never permits a complete override", async () => {
    const fake = make({ stagePending: 0, requestExtraction: async (tabId, envelope) => { fake.calls.push(["extract", tabId, envelope]); return extraction({ state: "partial", complete: false, descriptorProgress: 1 }); } });
    const result = await fake.cycle.runCycle({ binding: BINDING, runSummary: { extractionComplete: false } });
    assert.equal(result.state, "partial");
    assert.equal(fake.calls.filter(([name]) => name === "finalize").length, 0);
});

test("finalizer is called only after the pending recheck reaches zero", async () => {
    const pending = make({ uploadResult: { state: "idle" }, uploadPending: 1 });
    pending.setPending(1);
    assert.equal((await pending.cycle.runCycle({ binding: BINDING, runSummary: SUMMARY })).state, "running");
    assert.equal(pending.calls.filter(([name]) => name === "finalize").length, 0);

    const empty = make({ uploadResult: { state: "idle" }, uploadPending: 0 });
    empty.setPending(1);
    assert.equal((await empty.cycle.runCycle({ binding: BINDING, runSummary: SUMMARY })).state, "completed");
    assert.equal(empty.calls.filter(([name]) => name === "finalize").length, 1);
});

test("cycle output is redacted to safe state, counts, errorCode, and correlation", async () => {
    const fake = make({ finalizerResult: { state: "partial", errorCode: "https://private.example/title", providerId: "secret", events: [{ title: "private" }] } });
    fake.setPending(1);
    const result = await fake.cycle.runCycle({ binding: BINDING, runSummary: SUMMARY });
    assert.deepEqual(Object.keys(result).sort(), ["correlation", "counts", "errorCode", "state"]);
    assert.doesNotMatch(JSON.stringify(result), /private|provider|https?:\/\//i);
});
