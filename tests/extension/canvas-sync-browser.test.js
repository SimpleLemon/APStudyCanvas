"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createCanvasSyncBrowser } = require("../../js/platform/canvas-sync-browser.js");

function area() {
    return {
        async get() { return {}; },
        async set() {},
        async remove() {}
    };
}

function browser(overrides = {}) {
    return {
        storage: { session: area(), local: area(), ...(overrides.storage || {}) },
        tabs: { async query() { return []; }, async sendMessage() {}, ...(overrides.tabs || {}) },
        ...(overrides.browser || {})
    };
}

function modules(calls, coreResult = { state: "running", counts: { sent: 1 } }) {
    const factories = {
        stateApi: {
            createRun() {}, transition() {}, toSafeSummary() {}, restoreSafeSummary() {}, normalizeBinding() {}
        },
        createSyncEngine() { calls.push("engine"); return {}; },
        createSyncExtractStage() { calls.push("stage"); return {}; },
        createSyncUploader() { calls.push("uploader"); return {}; },
        createSyncFinalizer() { calls.push("finalizer"); return {}; },
        createCanvasSyncController() { calls.push("controller"); return {}; },
        createCanvasSyncCycle() { calls.push("cycle"); return {}; }
    };
    return {
        storage: { createCanvasSyncStorage(input) { calls.push(["storage", input]); return { leaseStore: { get() {}, set() {}, remove() {} }, summaryStore: {} }; } },
        resolver: { createCanvasSessionResolver(input) { calls.push(["resolver", input]); return { resolve() {}, isOwnedSession() { return true; } }; } },
        messenger: { createCanvasExtractionMessenger(input) { calls.push(["messenger", input]); return { request() {} }; } },
        nest: { createCanvasSyncNest(input) { calls.push(["nest", input]); return { createClient() { calls.push("client"); return { preflight() {}, establishSource() {}, startRun() {}, status() {}, resume() {}, cancel() {}, uploadBatch() {}, finalize() {} }; }, getIdentity() {}, getConsentProof() {} }; } },
        outbox: { createOutbox(input) { calls.push(["outbox", input]); return { async init() { calls.push("outbox.init"); } }; } },
        syncClient: { createSyncClient() { calls.push("syncClient"); return { preflight() {}, establishSource() {}, startRun() {}, status() {}, resume() {}, cancel() {}, uploadBatch() {}, finalize() {} }; } },
        core: { createCanvasSyncCore(input) { calls.push(["core", input]); return { start: async () => coreResult, resume: async () => coreResult, status: async () => coreResult, cancel: async () => coreResult, runCycle: async () => coreResult }; } },
        factories
    };
}

function make(overrides = {}) {
    const calls = [];
    const transport = overrides.transport || { request() {} };
    const idb = overrides.idb || { list() {}, put() {} };
    const instance = createCanvasSyncBrowser({
        browser: browser(overrides),
        transport,
        idb,
        configuredOrigins: overrides.configuredOrigins ?? ["https://canvas.example.edu"],
        featureFlags: overrides.featureFlags ?? { upload: true },
        idFactory: () => "id-1",
        hashKey: () => "hash-1",
        modules: modules(calls, overrides.coreResult)
    });
    return { instance, calls };
}

test("missing dependencies, including session storage, fail closed", async () => {
    const fake = make({ storage: { session: undefined } });
    assert.deepEqual(await fake.instance.start({}), { state: "unavailable", errorCode: "dependency_unavailable" });
    assert.deepEqual(fake.calls, []);
});

test("construction performs no storage, tab, transport, IDB, or factory work", () => {
    const fake = make();
    assert.deepEqual(fake.calls, []);
});

test("disabled start returns before touching tabs, transport, or IDB", async () => {
    let touched = 0;
    const fake = make({
        featureFlags: { upload: false },
        transport: {},
        idb: {},
        tabs: { async query() { touched += 1; return []; }, async sendMessage() { touched += 1; } }
    });
    assert.deepEqual(await fake.instance.start({}), { state: "idle", errorCode: "feature_disabled" });
    assert.equal(touched, 0);
    assert.deepEqual(fake.calls, []);
});

test("enabled operation lazily composes the literal browser dependencies", async () => {
    const fake = make();
    assert.deepEqual(await fake.instance.start({}), { state: "running", counts: { sent: 1 } });
    assert.deepEqual(fake.calls.map((item) => Array.isArray(item) ? item[0] : item), ["storage", "resolver", "messenger", "nest", "outbox", "outbox.init", "core"]);
    assert.equal(fake.calls.find((item) => Array.isArray(item) && item[0] === "storage")[1].storage.session.get instanceof Function, true);
});

test("missing session storage remains unavailable even when upload is enabled", async () => {
    const fake = make({ storage: { session: undefined } });
    assert.deepEqual(await fake.instance.init(), { ok: false, available: false, errorCode: "dependency_unavailable" });
    assert.deepEqual(await fake.instance.runCycle({}), { state: "unavailable", errorCode: "dependency_unavailable" });
    assert.deepEqual(fake.calls, []);
});

test("public results redact recursively and reuse initialized components after restart", async () => {
    const fake = make({ coreResult: { state: "partial", counts: { sent: 2, nested: { done: 1 } }, token: "secret", raw: { url: "https://private.test" }, correlation: "corr-1" } });
    assert.deepEqual(await fake.instance.status({}), { state: "partial", counts: { sent: 2, nested: { done: 1 } }, correlation: "corr-1" });
    await fake.instance.resume({});
    assert.equal(fake.calls.filter((item) => Array.isArray(item) && item[0] === "core").length, 1);
    assert.equal(fake.calls.filter((item) => item === "outbox.init").length, 1);
    assert.doesNotMatch(JSON.stringify(await fake.instance.cancel({})), /secret|private|token|url/i);
});

test("async flags and configured origins resolve before enabled composition", async () => {
    const fake = make({
        featureFlags: Promise.resolve({ upload: true }),
        configuredOrigins: Promise.resolve(new Set(["https://canvas.async.example.edu"]))
    });
    assert.deepEqual(await fake.instance.start({}), { state: "running", counts: { sent: 1 } });
    const resolver = fake.calls.find((item) => Array.isArray(item) && item[0] === "resolver");
    assert.deepEqual(resolver[1].configuredOrigins, ["https://canvas.async.example.edu"]);
});
