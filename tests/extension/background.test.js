"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const contract = require("../../js/platform/contract.js");
const router = require("../../js/platform/router.js");
const schema = require("../../js/settings-schema.js");

const backgroundSource = fs.readFileSync(path.join(__dirname, "../../js/background.js"), "utf8");
const ACCOUNT_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function area(values, calls, areaName, storageSetFailures) {
    return {
        async get(keys) {
            calls.storage += 1;
            if (keys === null) return { ...values };
            const requested = Array.isArray(keys) ? keys : [keys];
            return Object.fromEntries(requested.filter((key) => Object.prototype.hasOwnProperty.call(values, key)).map((key) => [key, values[key]]));
        },
        async set(changes) {
            calls.storage += 1;
            calls.storageWrites.push({ area: areaName, changes: { ...changes } });
            if ((storageSetFailures[areaName] || 0) > 0) {
                storageSetFailures[areaName] -= 1;
                throw new Error(`${areaName}_storage_set_failed`);
            }
            Object.assign(values, changes);
        },
        async remove(keys) {
            calls.storage += 1;
            for (const key of (Array.isArray(keys) ? keys : [keys])) delete values[key];
        }
    };
}

function makeBackground({ session = true, browserFactory = true, upload = false, optIns = {}, runtime, registration, scriptBlocker, overlayLauncher, migrateLegacyAliases, settingsSchema, initialSyncValues = {}, initialLocalValues = {}, storageSetFailures = {} } = {}) {
    const calls = { storage: 0, tabs: 0, transport: 0, idb: 0, runtime: [], logs: [], launches: [], syncGetRequests: [], storageWrites: [] };
    let toolbarListener;
    let permissionAddedListener;
    let permissionRemovedListener;
    let storageChangedListener;
    let installedListener;
    const syncValues = { custom_domain: ["https://canvas.example.edu"], ...initialSyncValues };
    const localValues = { "platform.flags": { upload }, "platform.accountMetadata": { accounts: [] }, canvas_sync_opt_in: optIns, ...initialLocalValues };
    const sessionValues = {};
    let messageListener;
    let captured;
    let capturedNestTransportOptions;
    let capturedScriptBlockerOptions;
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
            onInstalled: { addListener(listener) { installedListener = listener; } }
        },
        storage: {
            sync: area(syncValues, calls, "sync", storageSetFailures),
            local: area(localValues, calls, "local", storageSetFailures),
            onChanged: { addListener(listener) { storageChangedListener = listener; } }
        },
        tabs: {
            async query() { calls.tabs += 1; return []; },
            async sendMessage() { calls.tabs += 1; return {}; }
        },
        windows: { onRemoved: { addListener() {} } },
        permissions: {
            onAdded: { addListener(listener) { permissionAddedListener = listener; } },
            onRemoved: { addListener(listener) { permissionRemovedListener = listener; } }
        },
        action: { onClicked: { addListener(listener) { toolbarListener = listener; } } }
    };
    if (session) chromeApi.storage.session = area(sessionValues, calls, "session", storageSetFailures);

    const storageAdapter = {
        async get(areaName, keys) {
            calls.storage += 1;
            if (areaName === "sync") calls.syncGetRequests.push(Array.isArray(keys) ? keys.slice() : [keys]);
            const source = areaName === "sync" ? syncValues : areaName === "local" ? localValues : sessionValues;
            const requested = Array.isArray(keys) ? keys : [keys];
            return Object.fromEntries(requested.filter((key) => Object.prototype.hasOwnProperty.call(source, key)).map((key) => [key, source[key]]));
        },
        async set() { calls.storage += 1; return { ok: true }; },
        async remove() { calls.storage += 1; return { ok: true }; },
        async readFlags(defaults) { calls.storage += 1; return { ...defaults, upload }; },
        async migrateLegacyAliases() {
            if (typeof migrateLegacyAliases === "function") return migrateLegacyAliases();
            return { values: {}, changes: {} };
        }
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
            createNestTransport(options) {
                capturedNestTransportOptions = options;
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
        CanvasRegistration: { createCanvasRegistration() { return registration || { apiAvailable: () => false, ensureOrigin: async () => ({ ok: true }), reconcile: async () => [] }; } },
        CanvasSyncStorage: { createCanvasSyncStorage() {} },
        CanvasSessionResolver: { createCanvasSessionResolver() {} },
        CanvasExtractionMessenger: { createCanvasExtractionMessenger() {} },
        CanvasSyncNest: function CanvasSyncNest() {},
        CanvasSyncCore: { createCanvasSyncCore() {} },
        CanvasSyncController: { createCanvasSyncController() {} },
        CanvasSyncCycle: { createCanvasSyncCycle() {} },
        OverlayLauncher: {
            createOverlayLauncher() {
                return overlayLauncher || {
                    async launch(tab, context) {
                        calls.launches.push({ tab, context });
                        return { ok: true, state: "opened", tabId: tab?.id ?? null };
                    }
                };
            }
        }
    };
    if (scriptBlocker) platform.ScriptBlocker = { createScriptBlockCoordinator(options) { capturedScriptBlockerOptions = options; return scriptBlocker; } };
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
        APStudyCanvasSchema: settingsSchema || { defaultsForArea: () => ({}), aliases: {} },
        crypto: {
            randomUUID: () => "worker-uuid",
            getRandomValues(bytes) { bytes.fill(7); return bytes; }
        },
        fetch: async () => ({ ok: false, status: 503 }),
        setTimeout,
        clearTimeout,
        URL,
        Uint8Array,
        TextEncoder,
        console: { warn(...values) { calls.logs.push(values); }, error(...values) { calls.logs.push(values); } },
        importScripts() {}
    };
    context.globalThis = context;
    vm.runInNewContext(backgroundSource, context, { filename: "js/background.js" });
    return {
        calls,
        chromeApi,
        runtime: runtimeInstance,
        getCaptured: () => Object.assign({}, captured, { scriptBlockerOptions: capturedScriptBlockerOptions }),
        getNestTransportOptions: () => capturedNestTransportOptions,
        getMessageListener: () => messageListener,
        getToolbarListener: () => toolbarListener,
        getPermissionAddedListener: () => permissionAddedListener,
        getPermissionRemovedListener: () => permissionRemovedListener,
        getStorageChangedListener: () => storageChangedListener,
        getInstalledListener: () => installedListener,
        syncValues,
        localValues
    };
}

test("Nest tab transport repairs an already-open tab after the extension bridge is missing", async () => {
    const background = makeBackground();
    const injections = [];
    let sends = 0;
    background.chromeApi.tabs.get = async (tabId) => ({ id: tabId, url: "https://nest.apstudy.org/workspace" });
    background.chromeApi.tabs.sendMessage = async () => {
        sends += 1;
        if (sends === 1) throw new Error("Could not establish connection. Receiving end does not exist.");
        return { ok: true };
    };
    background.chromeApi.scripting = {
        async executeScript(options) { injections.push(options); return []; }
    };

    const result = await background.getNestTransportOptions().sendToTab(41, { kind: "APSTUDYCANVAS_NEST_BRIDGE_REQUEST" });
    assert.deepEqual(result, { ok: true });
    assert.equal(sends, 2);
    assert.deepEqual(JSON.parse(JSON.stringify(injections)), [{
        target: { tabId: 41 },
        files: ["js/platform/contract.js", "js/platform/security.js", "js/platform/transport.js", "js/platform/nest-bridge.js"]
    }]);
});

test("Nest tab bridge recovery revalidates the tab origin before injecting", async () => {
    const background = makeBackground();
    let injected = false;
    background.chromeApi.tabs.get = async (tabId) => ({ id: tabId, url: "https://nest.apstudy.org.evil.test/workspace" });
    background.chromeApi.tabs.sendMessage = async () => { throw new Error("missing_receiver"); };
    background.chromeApi.scripting = { async executeScript() { injected = true; } };

    await assert.rejects(
        () => background.getNestTransportOptions().sendToTab(42, { kind: "APSTUDYCANVAS_NEST_BRIDGE_REQUEST" }),
        (error) => error?.code === "NEST_TAB_ORIGIN_INVALID"
    );
    assert.equal(injected, false);
});

function hostileFailure(secret) {
    const error = new Error(secret);
    Object.defineProperty(error, "message", { get() { throw new Error("message getter must not run"); } });
    Object.defineProperty(error, "stack", { get() { throw new Error("stack getter must not run"); } });
    Object.defineProperty(error, "url", { get() { throw new Error("URL getter must not run"); } });
    return error;
}

function assertSafeDiagnosticLogs(logs, expectedCodes, secrets) {
    assert.deepEqual(logs.map(([, diagnostic]) => diagnostic?.code).sort(), expectedCodes.slice().sort());
    logs.forEach((entry) => {
        assert.equal(entry.length, 2);
        assert.equal(entry[0], "APStudyCanvas background diagnostic");
        assert.deepEqual(Object.keys(entry[1]).sort(), ["category", "code", "operation"]);
        Object.values(entry[1]).forEach((value) => assert.equal(typeof value, "string"));
        assert.ok(Buffer.byteLength(JSON.stringify(entry), "utf8") <= 192, "diagnostic must stay within the console byte bound");
        secrets.forEach((secret) => assert.doesNotMatch(JSON.stringify(entry), new RegExp(secret)));
    });
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

test("the toolbar click hands the clicked tab and resolved context to the overlay launcher", async () => {
    const background = makeBackground();
    const listener = background.getToolbarListener();
    assert.equal(typeof listener, "function");
    assert.equal(background.calls.launches.length, 0);

    const clicked = { id: 41, windowId: 7, url: "https://canvas.example.edu/courses" };
    listener(clicked);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(background.calls.launches.length, 1);
    const [launch] = background.calls.launches;
    assert.equal(launch.tab, clicked);
    assert.deepEqual(launch.context.configuredOrigins, ["https://canvas.example.edu"]);
    assert.equal(launch.context.flags.canvasOverlay, true);
    // A rejected launch must never surface as an unhandled rejection in the worker.
    assert.deepEqual(background.calls.logs, []);
});

test("overlay launch rejects an accessor ok field without executing it or exposing its error", async () => {
    const secret = "https://private.example/accessor?token=secret";
    let accessorReads = 0;
    const result = {};
    Object.defineProperty(result, "ok", {
        enumerable: true,
        get() {
            accessorReads += 1;
            throw new Error(secret);
        }
    });
    const background = makeBackground({ overlayLauncher: { async launch() { return result; } } });

    background.getToolbarListener()({ id: 51 });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(accessorReads, 0);
    assertSafeDiagnosticLogs(background.calls.logs, ["BACKGROUND_OVERLAY_LAUNCH_NOT_OPENED"], [secret]);
});

test("overlay launch fails closed when hostile Proxy descriptor traps reject inspection", async () => {
    const secret = "account-981 raw-stack https://private.example/proxy";
    let descriptorChecks = 0;
    let valueTrapEffects = 0;
    const result = new Proxy({}, {
        get(target, property, receiver) {
            if (property === "then") return undefined;
            valueTrapEffects += 1;
            throw new Error(secret);
        },
        getOwnPropertyDescriptor() {
            descriptorChecks += 1;
            throw new Error(secret);
        },
        getPrototypeOf() {
            valueTrapEffects += 1;
            throw new Error(secret);
        },
        has() {
            valueTrapEffects += 1;
            throw new Error(secret);
        },
        ownKeys() {
            valueTrapEffects += 1;
            throw new Error(secret);
        }
    });
    const background = makeBackground({ overlayLauncher: { launch() { return result; } } });

    background.getToolbarListener()({ id: 52 });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(descriptorChecks, 1);
    assert.equal(valueTrapEffects, 0);
    assertSafeDiagnosticLogs(background.calls.logs, ["BACKGROUND_OVERLAY_LAUNCH_NOT_OPENED"], [secret]);
});

test("background failure diagnostics are fixed, bounded, and never inspect hostile errors or results", async () => {
    const secrets = ["https://private.example/secret", "account-981", "raw-stack", "token=secret"];
    const initialFailure = hostileFailure(`${secrets[0]} ${secrets[1]}`);
    const resyncFailure = hostileFailure(`${secrets[2]} ${secrets[3]}`);
    let syncCalls = 0;
    const scriptBlocker = {
        isReady: () => true,
        attach() {},
        syncFromSettings() {
            syncCalls += 1;
            return Promise.reject(syncCalls === 1 ? initialFailure : resyncFailure);
        }
    };
    const overlayFailure = hostileFailure(`${secrets[0]} ${secrets[3]}`);
    let launches = 0;
    const overlayLauncher = {
        async launch() {
            launches += 1;
            if (launches === 1) return {
                ok: false,
                get account() { throw new Error("result getter must not run"); },
                url: secrets[0]
            };
            throw overlayFailure;
        }
    };
    const aliasFailure = hostileFailure(`${secrets[1]} ${secrets[2]}`);
    const background = makeBackground({ scriptBlocker, overlayLauncher, migrateLegacyAliases: () => Promise.reject(aliasFailure) });
    await new Promise((resolve) => setImmediate(resolve));
    background.getToolbarListener()({ id: 1 });
    background.getToolbarListener()({ id: 2 });
    background.getStorageChangedListener()({ block_tool_scripts: { oldValue: true, newValue: false } }, "sync");
    background.getInstalledListener()({ reason: "install" });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assertSafeDiagnosticLogs(background.calls.logs, [
        "BACKGROUND_SCRIPT_BLOCK_INITIAL_SYNC_FAILED",
        "BACKGROUND_OVERLAY_LAUNCH_NOT_OPENED",
        "BACKGROUND_OVERLAY_LAUNCH_FAILED",
        "BACKGROUND_SCRIPT_BLOCK_RESYNC_FAILED",
        "BACKGROUND_PLATFORM_ALIAS_MIGRATION_FAILED"
    ], secrets);

    const installFailure = hostileFailure(`${secrets[0]} ${secrets[2]}`);
    const installBackground = makeBackground({
        settingsSchema: { defaultsForArea() { throw installFailure; }, aliases: {} }
    });
    installBackground.getInstalledListener()({ reason: "install" });
    await new Promise((resolve) => setImmediate(resolve));
    assertSafeDiagnosticLogs(installBackground.calls.logs, ["BACKGROUND_INSTALL_RECONCILIATION_FAILED"], secrets);
});

test("lazy Workspace settings stay absent during install reconciliation", async () => {
    const background = makeBackground({ settingsSchema: schema });
    background.getInstalledListener()({ reason: "update" });
    await new Promise((resolve) => setImmediate(resolve));

    for (const key of schema.lazySyncDefaultKeys) {
        assert.equal(Object.prototype.hasOwnProperty.call(background.syncValues, key), false, `${key} was not materialized`);
    }
});

test("script blockers are explicit opt-ins and planner compatibility data is never read or synchronized by the background", async () => {
    let syncs = 0;
    const scriptBlocker = {
        isReady: () => true,
        attach() {},
        syncFromSettings() { syncs += 1; return Promise.resolve(); }
    };
    const background = makeBackground({ scriptBlocker });
    background.syncValues.block_planner_script = false;
    const settings = await background.getCaptured().scriptBlockerOptions.readSettings();

    assert.deepEqual(JSON.parse(JSON.stringify(settings)), {
        tool: false,
        editor: false,
        origins: ["https://canvas.example.edu"]
    });
    background.syncValues.block_tool_scripts = true;
    background.syncValues.block_editor_scripts = true;
    const optedIn = await background.getCaptured().scriptBlockerOptions.readSettings();
    assert.deepEqual(JSON.parse(JSON.stringify(optedIn)), {
        tool: true,
        editor: true,
        origins: ["https://canvas.example.edu"]
    });
    assert.equal(background.calls.syncGetRequests.some((keys) => keys.includes("block_planner_script")), false);
    const initialSyncs = syncs;
    background.getStorageChangedListener()({ block_planner_script: { oldValue: true, newValue: false } }, "sync");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(syncs, initialSyncs, "a legacy planner-only change cannot trigger DNR synchronization");
    assert.equal(background.syncValues.block_planner_script, false, "stored compatibility data remains untouched");
});

test("startup safety migration replaces legacy script-block opt-ins with explicit false values", async () => {
    let synchronizations = 0;
    const scriptBlocker = {
        isReady: () => true,
        attach() {},
        syncFromSettings() { synchronizations += 1; return Promise.resolve(); }
    };
    const background = makeBackground({
        scriptBlocker,
        initialSyncValues: { block_tool_scripts: true, block_editor_scripts: true }
    });

    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(background.syncValues.block_tool_scripts, false);
    assert.equal(background.syncValues.block_editor_scripts, false);
    assert.equal(background.localValues["background.script_block_safety_migration.v1"], true);
    assert.equal(synchronizations, 1, "the coordinator clears rules only after the false values persist");
    assert.deepEqual(background.calls.storageWrites.map(({ area, changes }) => ({ area, changes })), [
        { area: "sync", changes: { block_tool_scripts: false, block_editor_scripts: false } },
        { area: "local", changes: { "background.script_block_safety_migration.v1": true } }
    ]);
});

test("startup safety migration materializes absent script-block settings as false", async () => {
    const scriptBlocker = {
        isReady: () => true,
        attach() {},
        syncFromSettings() { return Promise.resolve(); }
    };
    const background = makeBackground({ scriptBlocker });

    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(background.syncValues.block_tool_scripts, false);
    assert.equal(background.syncValues.block_editor_scripts, false);
    assert.equal(background.localValues["background.script_block_safety_migration.v1"], true);
});

test("completed script-block safety migration preserves later user opt-ins", async () => {
    const first = makeBackground({
        scriptBlocker: { isReady: () => true, attach() {}, syncFromSettings() { return Promise.resolve(); } }
    });
    await new Promise((resolve) => setImmediate(resolve));
    first.syncValues.block_tool_scripts = true;
    first.syncValues.block_editor_scripts = true;

    const second = makeBackground({
        scriptBlocker: { isReady: () => true, attach() {}, syncFromSettings() { return Promise.resolve(); } },
        initialSyncValues: { ...first.syncValues },
        initialLocalValues: { ...first.localValues }
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(second.syncValues.block_tool_scripts, true);
    assert.equal(second.syncValues.block_editor_scripts, true);
    assert.deepEqual(second.calls.storageWrites, [], "the marker prevents any later preference overwrite");
});

test("script-block safety migration leaves its marker absent until storage and DNR cleanup succeed", async () => {
    const storageFailure = makeBackground({
        scriptBlocker: { isReady: () => true, attach() {}, syncFromSettings() { return Promise.resolve(); } },
        initialSyncValues: { block_tool_scripts: true, block_editor_scripts: true },
        storageSetFailures: { sync: 1 }
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(storageFailure.localValues["background.script_block_safety_migration.v1"], undefined);
    assert.equal(storageFailure.syncValues.block_tool_scripts, true, "a failed atomic write leaves the old durable values untouched");
    assert.deepEqual(storageFailure.calls.storageWrites.map(({ area }) => area), ["sync"]);

    const cleanupFailure = makeBackground({
        scriptBlocker: { isReady: () => true, attach() {}, syncFromSettings() { return Promise.reject(new Error("dnr_cleanup_failed")); } },
        initialSyncValues: { block_tool_scripts: true, block_editor_scripts: true }
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cleanupFailure.syncValues.block_tool_scripts, false);
    assert.equal(cleanupFailure.syncValues.block_editor_scripts, false);
    assert.equal(cleanupFailure.localValues["background.script_block_safety_migration.v1"], undefined, "the completion marker never precedes cleanup");
    assert.deepEqual(cleanupFailure.calls.storageWrites.map(({ area }) => area), ["sync"]);

    const unavailable = makeBackground({
        scriptBlocker: { isReady: () => false, attach() {}, syncFromSettings() { return Promise.resolve(); } },
        initialSyncValues: { block_tool_scripts: true, block_editor_scripts: true }
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(unavailable.localValues["background.script_block_safety_migration.v1"], undefined, "an unavailable DNR is retried on a future startup");

    const retry = makeBackground({
        scriptBlocker: { isReady: () => true, attach() {}, syncFromSettings() { return Promise.resolve(); } },
        initialSyncValues: { ...cleanupFailure.syncValues },
        initialLocalValues: { ...cleanupFailure.localValues }
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(retry.localValues["background.script_block_safety_migration.v1"], true, "a later successful startup completes the retry");
});

test("permission add/remove reconciliation is serialized and reads the durable snapshot when it runs", async () => {
    const snapshots = [];
    const registration = {
        apiAvailable: () => true,
        async reconcile(snapshot) { snapshots.push(JSON.parse(JSON.stringify(snapshot))); return []; }
    };
    const background = makeBackground({ registration });
    assert.equal(typeof background.getPermissionAddedListener(), "function");
    assert.equal(typeof background.getPermissionRemovedListener(), "function");
    assert.equal(typeof background.getStorageChangedListener(), "function");

    // The event is raised before the custom-origin flow persists. The queued
    // task must read only when it executes, after this durable state arrives.
    background.getPermissionAddedListener()({ origins: ["https://canvas.example.edu/*"] });
    background.syncValues.custom_domain = ["https://canvas.example.edu"];
    background.localValues["platform.accountMetadata"] = { accounts: [{ origin: "https://canvas.example.edu" }] };
    background.getStorageChangedListener()({ custom_domain: { oldValue: [], newValue: background.syncValues.custom_domain } }, "sync");
    background.getPermissionRemovedListener()({ origins: ["https://canvas.example.edu/*"] });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(snapshots.length, 3);
    assert.deepEqual(snapshots, snapshots.map(() => ({
        configuredOrigins: ["https://canvas.example.edu"],
        verifiedOrigins: ["https://canvas.example.edu"]
    })));
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

test("mutation bridge opens an inactive Nest tab only when requested and missing", async () => {
    const background = makeBackground();
    const created = [];
    background.chromeApi.tabs.create = async (options) => { created.push(options); return { id: 82, status: 'complete', url: options.url }; };
    const find = background.getNestTransportOptions().findExactNestTab;
    assert.equal(await find(), null);
    assert.equal(created.length, 0);
    assert.equal((await find({ createIfMissing: true })).id, 82);
    assert.equal(created.length, 1);
    assert.equal(created[0].active, false);
    assert.equal(created[0].url, 'https://nest.apstudy.org/dashboard');
    background.chromeApi.tabs.query = async () => [{ id: 90, url: 'https://nest.apstudy.org/' }];
    assert.equal((await find({ createIfMissing: true })).id, 90);
    assert.equal(created.length, 1);
});

test("concurrent mutation recovery waits for one Nest tab to finish loading", async () => {
    const background = makeBackground();
    let listener;
    let creates = 0;
    let removed = 0;
    const tab = { id: 83, status: 'loading', url: 'https://nest.apstudy.org/extension/connect' };
    background.chromeApi.tabs.create = async () => { creates++; return tab; };
    background.chromeApi.tabs.get = async () => tab;
    background.chromeApi.tabs.onUpdated = { addListener(fn) { listener = fn; }, removeListener(fn) { assert.equal(fn, listener); removed++; } };
    const find = background.getNestTransportOptions().findExactNestTab;
    const first = find({ createIfMissing: true });
    await new Promise(resolve => setImmediate(resolve));
    const second = find({ createIfMissing: true });
    listener(tab.id, { status: 'complete' }, { ...tab, status: 'complete' });
    assert.equal((await first).status, 'complete');
    assert.equal((await second).status, 'complete');
    assert.equal(creates, 1);
    assert.equal(removed, 1);
});
