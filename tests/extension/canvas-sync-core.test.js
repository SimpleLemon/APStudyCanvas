"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createCanvasSyncCore } = require("../../js/platform/canvas-sync-core.js");
const stateApi = require("../../js/canvas-adapter/sync-state.js");
const { createSyncEngine } = require("../../js/canvas-adapter/sync-engine.js");
const { createSyncExtractStage } = require("../../js/canvas-adapter/sync-extract-stage.js");
const { createSyncUploader } = require("../../js/canvas-adapter/sync-uploader.js");
const { createSyncFinalizer } = require("../../js/canvas-adapter/sync-finalizer.js");
const { createCanvasSyncController } = require("../../js/platform/canvas-sync-controller.js");
const { createCanvasSyncCycle } = require("../../js/platform/canvas-sync-cycle.js");

const realFactories = {
    stateApi,
    createSyncEngine,
    createSyncExtractStage,
    createSyncUploader,
    createSyncFinalizer,
    createCanvasSyncController,
    createCanvasSyncCycle
};

const BINDING = Object.freeze({
    contractVersion: 1,
    accountKey: "account-1",
    origin: "https://canvas.example.edu",
    canvasUserId: "canvas-user-1",
    sourceId: "source-1",
    runId: "run-1",
    generation: 7,
    label: "Canvas",
    consentVersion: "consent-1",
    scope: { courses: [42] },
    descriptors: [{ id: "assignments" }],
    requestId: "request-1"
});

function clientFake(calls = []) {
    return {
        async preflight(proof) { calls.push(["preflight", proof]); return { ok: true }; },
        async establishSource(value) { calls.push(["establishSource", value]); return { source_id: value.sourceId }; },
        async startRun(value) { calls.push(["startRun", value]); return { run_id: value.runId, generation: value.generation }; },
        async status(value) { calls.push(["status", value]); return { generation: value.generation }; },
        async resume(value) { calls.push(["resume", value]); return {}; },
        async cancel(value) { calls.push(["cancel", value]); return {}; },
        async uploadBatch(value) { calls.push(["uploadBatch", value]); return { ok: true }; },
        async finalize(value) { calls.push(["finalize", value]); return { run_id: value.runId, generation: value.generation, status: "complete" }; }
    };
}

function makeOutbox(overrides = {}) {
    return {
        async currentGeneration() { return BINDING.generation; },
        async pendingCount() { return 0; },
        async enqueue() { return { ok: true }; },
        async leaseNext() { return null; },
        async acknowledgeBatch() { return { ok: true }; },
        async scheduleRetry() { return { ok: true }; },
        ...overrides
    };
}

function makeDependencies(overrides = {}) {
    const calls = [];
    const client = overrides.client || clientFake(calls);
    const summaryStore = overrides.summaryStore || {
        async get() { calls.push(["summary.get"]); return null; },
        async set(value) { calls.push(["summary.set", value]); }
    };
    const deps = {
        factories: { ...realFactories, ...(overrides.factories || {}) },
        storage: { summaryStore },
        nest: {
            createClient() { calls.push(["createClient"]); return client; },
            async getIdentity() { calls.push(["identity"]); return { authenticated: true, accountKey: BINDING.accountKey }; },
            async getConsentProof(value) { calls.push(["consent", value]); return { granted: true, accountKey: BINDING.accountKey, consentVersion: BINDING.consentVersion, scope: BINDING.scope }; },
            ...(overrides.nest || {})
        },
        resolver: { async resolve(value) { calls.push(["resolve", value]); return { accountKey: BINDING.accountKey, origin: BINDING.origin, canvasUserId: BINDING.canvasUserId, tabId: 9 }; }, ...(overrides.resolver || {}) },
        messenger: overrides.messenger || { async request(...args) { calls.push(["request", ...args]); return null; } },
        outbox: overrides.outbox || makeOutbox(),
        getFeatureFlags: overrides.getFeatureFlags,
        scheduleResume: overrides.scheduleResume,
        idFactory: overrides.idFactory
    };
    return { deps, calls, client };
}

test("contract failure happens before client or factory construction", () => {
    let created = 0;
    const fake = makeDependencies({
        factories: {
            createSyncEngine() { created += 1; },
            createSyncExtractStage,
            createSyncUploader,
            createSyncFinalizer,
            createCanvasSyncController,
            createCanvasSyncCycle
        },
        messenger: {}
    });
    assert.throws(() => createCanvasSyncCore(fake.deps), (error) => error.code === "DEPENDENCY_CONTRACT_MISMATCH");
    assert.equal(created, 0);
    assert.deepEqual(fake.calls, []);
});

test("default-disabled core returns safe idle results without dependency calls", async () => {
    const fake = makeDependencies();
    const core = createCanvasSyncCore(fake.deps);
    assert.deepEqual(await core.start(BINDING), { state: "idle", errorCode: "feature_disabled" });
    assert.deepEqual(await core.resume(BINDING), { state: "idle", errorCode: "feature_disabled" });
    assert.deepEqual(await core.status(BINDING), { state: "idle", errorCode: "feature_disabled" });
    assert.deepEqual(await core.cancel(BINDING), { state: "idle", errorCode: "feature_disabled" });
    assert.deepEqual(await core.runCycle({ binding: BINDING }), { state: "idle", errorCode: "feature_disabled" });
    assert.deepEqual(fake.calls, [["createClient"]]);
});

test("controller wiring preserves identity, session, consent, and exact preflight order", async () => {
    const calls = [];
    const engine = {
        async start(value) { calls.push(["engine.start", value]); return { state: "running", counts: { started: 1 }, proof: "private" }; },
        async resume(value) { return { state: "running", counts: {} }; },
        async getStatus(value) { return { state: "running", counts: {} }; },
        async cancel(value) { return { state: "cancelled" }; }
    };
    const fake = makeDependencies({
        getFeatureFlags: () => ({ upload: true }),
        factories: { createSyncEngine: () => engine },
        nest: {
            async getIdentity() { calls.push(["identity"]); return { authenticated: true, accountKey: BINDING.accountKey }; },
            async getConsentProof(value) { calls.push(["consent", value]); return { granted: true, accountKey: BINDING.accountKey, consentVersion: BINDING.consentVersion, scope: BINDING.scope }; }
        },
        resolver: { async resolve(value) { calls.push(["resolve", value]); return { accountKey: BINDING.accountKey, origin: BINDING.origin, canvasUserId: BINDING.canvasUserId, tabId: 9 }; } },
        idFactory: () => { calls.push(["id"]); return "correlation-1"; }
    });
    const core = createCanvasSyncCore(fake.deps);
    const result = await core.start({
        contractVersion: 1,
        accountKey: BINDING.accountKey,
        origin: BINDING.origin,
        canvasUserId: BINDING.canvasUserId,
        sourceId: BINDING.sourceId,
        label: BINDING.label,
        consentVersion: BINDING.consentVersion,
        scope: BINDING.scope,
        descriptors: BINDING.descriptors,
        requestId: BINDING.requestId
    });
    assert.deepEqual(result, { state: "running", counts: { started: 1 }, correlation: "correlation-1" });
    assert.deepEqual(calls.map(([name]) => name), ["identity", "id", "resolve", "consent", "engine.start"]);
    assert.equal(calls[3][1].sourceId, BINDING.sourceId);
    assert.deepEqual(calls[4][1], {
        enabled: true,
        binding: calls[3][1],
        proof: { granted: true, accountKey: BINDING.accountKey, consentVersion: BINDING.consentVersion, scope: BINDING.scope }
    });
});

test("runCycle wires messenger, stage, uploader, and finalizer in order", async () => {
    const calls = [];
    let pendingReads = 0;
    const fake = makeDependencies({
        getFeatureFlags: () => ({ upload: true }),
        factories: {
            createSyncEngine: () => ({ start() {}, resume() {}, getStatus() {}, cancel() {} }),
            createSyncExtractStage: (value) => { calls.push(["stage.create", value]); return { queueResult: async (input) => { calls.push(["stage", input]); return { state: "queued", queued: 1 }; } }; },
            createSyncUploader: (value) => { calls.push(["uploader.create", value]); return { uploadNext: async (input) => { calls.push(["uploader", input]); return { state: "idle" }; } }; },
            createSyncFinalizer: (value) => { calls.push(["finalizer.create", value]); return { finalizeIfReady: async (input) => { calls.push(["finalizer", input]); return { state: "completed" }; } }; },
            createCanvasSyncController: () => ({ start() {}, resume() {}, status() {}, cancel() {} }),
            createCanvasSyncCycle
        },
        resolver: { async resolve() { calls.push(["resolve"]); return { accountKey: BINDING.accountKey, origin: BINDING.origin, canvasUserId: BINDING.canvasUserId, tabId: 9 }; } },
        messenger: { async request(...args) { calls.push(["request", ...args]); return { batches: [], descriptorProgress: 1, quarantineCount: 0, checkpointHash: null, complete: true }; } },
        outbox: makeOutbox({ async pendingCount() { return pendingReads++ === 1 ? 1 : 0; } })
    });
    const core = createCanvasSyncCore(fake.deps);
    const result = await core.runCycle({ binding: BINDING, runSummary: { extractionComplete: false } });
    assert.equal(result.state, "completed");
    assert.deepEqual(calls.map(([name]) => name), ["stage.create", "uploader.create", "finalizer.create", "resolve", "request", "stage", "uploader", "finalizer"]);
    assert.equal(calls.find(([name]) => name === "request")[1], 9);
});

test("public results recursively retain only state, counts, error, and correlation", async () => {
    const fake = makeDependencies({
        getFeatureFlags: () => ({ upload: true }),
        factories: {
            createSyncEngine: () => ({ start() {}, resume() {}, getStatus() {}, cancel() {} }),
            createCanvasSyncController: () => ({
                async start() { return { state: "running", counts: { accepted: 2, nested: { rejected: 1 } }, token: "secret", lease: "lease", proof: "proof", tabId: 9, events: [{ raw: "private" }], providerId: "provider-123" }; },
                async resume() { return { state: "running" }; }, async status() { return { state: "running" }; }, async cancel() { return { state: "cancelled" }; }
            }),
            createCanvasSyncCycle: () => ({ async runCycle() { return { state: "partial", errorCode: "RAW_PROVIDER_ERROR", correlation: "cycle-1", binding: { sourceId: "private" }, rawError: new Error("private") }; } })
        }
    });
    const core = createCanvasSyncCore(fake.deps);
    assert.deepEqual(await core.start(BINDING), { state: "running", counts: { accepted: 2, nested: { rejected: 1 } } });
    assert.deepEqual(await core.runCycle({ binding: BINDING }), { state: "partial", errorCode: "SYNC_CORE_FAILED", correlation: "cycle-1" });
});

test("summary-store and outbox aliases are adapted without changing their state", () => {
    const calls = [];
    const fake = makeDependencies({
        summaryStore: {
            async read() { calls.push("read"); },
            async write() { calls.push("write"); }
        },
        outbox: {
            async getCurrentGeneration() { calls.push("generation"); return 7; },
            async getPendingCount() { calls.push("pending"); return 0; },
            async enqueueBatch() { calls.push("enqueue"); },
            async leaseBatch() { calls.push("lease"); return null; },
            async acknowledge() { calls.push("ack"); },
            async retry() { calls.push("retry"); }
        },
        factories: {
            createSyncEngine: (value) => { assert.equal(typeof value.summaryStore.get, "function"); assert.equal(typeof value.summaryStore.set, "function"); return { start() {}, resume() {}, getStatus() {}, cancel() {} }; },
            createSyncExtractStage: (value) => { assert.equal(typeof value.outbox.enqueue, "function"); return { queueResult() {} }; },
            createSyncUploader: (value) => { assert.equal(typeof value.outbox.currentGeneration, "function"); assert.equal(typeof value.outbox.pendingCount, "function"); return { uploadNext() {} }; },
            createSyncFinalizer: () => ({ finalizeIfReady() {} }),
            createCanvasSyncController: () => ({ start() {}, resume() {}, status() {}, cancel() {} }),
            createCanvasSyncCycle: () => ({ runCycle() {} })
        }
    });
    createCanvasSyncCore(fake.deps);
    assert.equal(calls.length, 0);
});
