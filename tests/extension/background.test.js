"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const contract = require("../../js/platform/contract.js");
const router = require("../../js/platform/router.js");

const backgroundSource = fs.readFileSync(path.join(__dirname, "../../js/background.js"), "utf8");
const ACCOUNT_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function area(values, calls) {
    return {
        async get(keys) {
            calls.storage += 1;
            if (keys === null) return { ...values };
            const requested = Array.isArray(keys) ? keys : [keys];
            return Object.fromEntries(requested.filter((key) => Object.prototype.hasOwnProperty.call(values, key)).map((key) => [key, values[key]]));
        },
        async set(changes) {
            calls.storage += 1;
            Object.assign(values, changes);
        },
        async remove(keys) {
            calls.storage += 1;
            for (const key of (Array.isArray(keys) ? keys : [keys])) delete values[key];
        }
    };
}

function makeBackground({ session = true, browserFactory = true, upload = false, optIns = {}, runtime } = {}) {
    const calls = { storage: 0, tabs: 0, transport: 0, idb: 0, runtime: [], logs: [] };
    const syncValues = { custom_domain: ["https://canvas.example.edu"] };
    const localValues = { "platform.flags": { upload }, "platform.accountMetadata": { accounts: [] }, canvas_sync_opt_in: optIns };
    const sessionValues = {};
    let messageListener;
    let captured;
    const runtimeInstance = runtime || Object.fromEntries(["init", "start", "resume", "status", "cancel", "runCycle", "handleAlarm"].map((method) => [
        method,
        async () => {
            calls.runtime.push(method);
            return { state: "running", counts: { sent: 1 }, token: "secret", raw: { url: "https://private.example" } };
        }
    ]));

    const chromeApi = {
        runtime: {
            getURL: (value) => `chrome-extension://test-id/${String(value).replace(/^\//, "")}`,
            onMessage: { addListener(listener) { messageListener = listener; } },
            onInstalled: { addListener() {} }
        },
        storage: {
            sync: area(syncValues, calls),
            local: area(localValues, calls),
            onChanged: { addListener() {} }
        },
        tabs: {
            async query() { calls.tabs += 1; return []; },
            async sendMessage() { calls.tabs += 1; return {}; }
        },
        windows: { onRemoved: { addListener() {} } },
        permissions: { onAdded: { addListener() {} } }
    };
    if (session) chromeApi.storage.session = area(sessionValues, calls);

    const storageAdapter = {
        async get(areaName, keys) {
            calls.storage += 1;
            const source = areaName === "sync" ? syncValues : areaName === "local" ? localValues : sessionValues;
            const requested = Array.isArray(keys) ? keys : [keys];
            return Object.fromEntries(requested.filter((key) => Object.prototype.hasOwnProperty.call(source, key)).map((key) => [key, source[key]]));
        },
        async set() { calls.storage += 1; return { ok: true }; },
        async remove() { calls.storage += 1; return { ok: true }; },
        async readFlags(defaults) { calls.storage += 1; return { ...defaults, upload }; },
        async migrateLegacyAliases() { return { values: {}, changes: {} }; }
    };

    const adapter = {
        Identity: { sha256HexSync: (value) => `hash-${String(value).slice(0, 16)}` },
        Outbox: { createOutbox() {} },
        SyncClient: function SyncClient() {},
        SyncState: { createRun() {}, transition() {}, toSafeSummary() {}, restoreSafeSummary() {}, normalizeBinding() {} },
        SyncEngine: { createSyncEngine() {} },
        SyncExtractStage: { createSyncExtractStage() {} },
        SyncUploader: { createSyncUploader() {} },
        SyncFinalizer: { createSyncFinalizer() {} }
    };
    const platform = {
        Contract: contract,
        Storage: { createChromeStorageAdapter() { return storageAdapter; } },
        Transport: {
            NEST_ORIGIN: contract.NEST_ORIGIN,
            createNestTransport() {
                return {
                    async request() { calls.transport += 1; return {}; },
                    async mutate() { calls.transport += 1; return {}; }
                };
            }
        },
        IndexedDb: {
            createIndexedDbStore() {
                return {
                    async list() { calls.idb += 1; return []; },
                    async put() { calls.idb += 1; },
                    async delete() { calls.idb += 1; },
                    async clear() { calls.idb += 1; }
                };
            }
        },
        CanvasRegistration: { createCanvasRegistration() { return { apiAvailable: () => false, ensureOrigin: async () => ({ ok: true }), reconcile: async () => [] }; } },
        Fullscreen: { removeWindow: async () => {} },
        CanvasSyncStorage: { createCanvasSyncStorage() {} },
        CanvasSessionResolver: { createCanvasSessionResolver() {} },
        CanvasExtractionMessenger: { createCanvasExtractionMessenger() {} },
        CanvasSyncNest: function CanvasSyncNest() {},
        CanvasSyncCore: { createCanvasSyncCore() {} },
        CanvasSyncController: { createCanvasSyncController() {} },
        CanvasSyncCycle: { createCanvasSyncCycle() {} }
    };
    if (browserFactory) {
        platform.CanvasSyncBrowser = {
            createCanvasSyncBrowser(options) {
                captured = options;
                return runtimeInstance;
            }
        };
    }
    platform.Router = {
        createRouter(options) {
            captured = Object.assign(captured || {}, { router: options });
            return router.createRouter(options);
        }
    };

    const context = {
        chrome: chromeApi,
        browser: undefined,
        APStudyCanvasPlatform: platform,
        APStudyCanvasCanvasAdapter: adapter,
        APStudyCanvasSchema: { defaultsForArea: () => ({}), aliases: {} },
        crypto: {
            randomUUID: () => "worker-uuid",
            getRandomValues(bytes) { bytes.fill(7); return bytes; }
        },
        fetch: async () => ({ ok: false, status: 503 }),
        URL,
        Uint8Array,
        TextEncoder,
        console: { warn(...values) { calls.logs.push(values); }, error(...values) { calls.logs.push(values); } },
        importScripts() {}
    };
    context.globalThis = context;
    vm.runInNewContext(backgroundSource, context, { filename: "js/background.js" });
    return { calls, chromeApi, runtime: runtimeInstance, getCaptured: () => captured, getMessageListener: () => messageListener };
}

function dispatch(background, message, sender = { url: "chrome-extension://test-id/html/popup.html" }) {
    return new Promise((resolve) => {
        const returned = background.getMessageListener()(message, sender, resolve);
        assert.equal(returned, true);
    });
}

test("background injects a lazy Canvas sync runtime without construction I/O", async () => {
    const background = makeBackground();
    const captured = background.getCaptured();
    assert.ok(captured.router.canvasSync);
    for (const method of ["init", "start", "resume", "status", "cancel", "runCycle"]) assert.equal(typeof captured.router.canvasSync[method], "function");
    for (const name of ["storage", "resolver", "messenger", "nest", "core", "outbox", "syncClient", "identity"]) assert.ok(captured.modules[name]);
    assert.equal(typeof captured.modules.factories.stateApi, "object");
    for (const name of ["createSyncEngine", "createSyncExtractStage", "createSyncUploader", "createSyncFinalizer", "createCanvasSyncController", "createCanvasSyncCycle"]) assert.equal(typeof captured.modules.factories[name], "function");
    assert.equal(captured.idFactory(`raw/${"x".repeat(400)}`).length <= 160, true);
    assert.equal(captured.hashKey("x".repeat(5000)).length <= 160, true);
    assert.equal(background.calls.storage, 0);
    assert.equal(background.calls.tabs, 0);
    assert.equal(background.calls.transport, 0);
    assert.equal(background.calls.idb, 0);

    assert.deepEqual(await captured.configuredOrigins(), ["https://canvas.example.edu"]);
    assert.equal((await captured.featureFlags()).upload, false);
    assert.equal(background.calls.storage > 0, true);
});

test("missing session storage or sync global installs the listener with an unavailable facade", async () => {
    for (const background of [makeBackground({ session: false }), makeBackground({ browserFactory: false })]) {
        assert.equal(typeof background.getMessageListener(), "function");
        assert.deepEqual(JSON.parse(JSON.stringify(await background.getCaptured().router.canvasSync.start({}))), { state: "unavailable", errorCode: "sync_runtime_unavailable" });
        assert.deepEqual(JSON.parse(JSON.stringify(await background.getCaptured().router.canvasSync.init())), { state: "unavailable", errorCode: "sync_runtime_unavailable" });
        assert.deepEqual(background.calls.runtime, []);
    }
});

test("disabled public sync is gated by the router before the injected runtime is touched", async () => {
    const background = makeBackground({ upload: false });
    const result = await dispatch(background, contract.createEnvelope("CANVAS_SYNC_START", {}, "disabled-start"));
    assert.equal(result.payload.code, "FEATURE_DISABLED_UPLOAD");
    assert.deepEqual(background.calls.runtime, []);
});

test("enabled public sync delegates through the injected background runtime and redacts raw data", async () => {
    const background = makeBackground({ upload: true, optIns: { [ACCOUNT_KEY]: true } });
    const result = await dispatch(background, contract.createEnvelope("CANVAS_SYNC_START", { scope: "current", accountKey: ACCOUNT_KEY }, "enabled-start"));
    assert.equal(result.payload.state, "running");
    assert.deepEqual(background.calls.runtime, ["start"]);
    assert.doesNotMatch(JSON.stringify(result.payload), /secret|private|https?:|token|url/i);
    assert.equal(background.calls.transport, 0);
    assert.equal(background.calls.tabs, 0);
    assert.equal(background.calls.idb, 0);
    assert.deepEqual(background.calls.logs, []);
});

test("background feature getter isolates opted-in account A from rejected account B", async () => {
    const otherAccountKey = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
    const background = makeBackground({ upload: true, optIns: { [ACCOUNT_KEY]: true, [otherAccountKey]: false } });
    const featureFlags = background.getCaptured().featureFlags;
    assert.equal((await featureFlags(ACCOUNT_KEY)).upload, true);
    assert.equal((await featureFlags(otherAccountKey)).upload, false);
    assert.equal((await featureFlags("Bearer secret")).upload, false);
});
