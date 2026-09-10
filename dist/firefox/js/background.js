const BACKGROUND_PLATFORM_SCRIPTS = Object.freeze([
    "./settings-schema.js",
    "./platform/contract.js",
    "./platform/security.js",
    "./platform/storage.js",
    "./platform/transport.js",
    "./platform/idb.js",
    "./canvas-adapter/identity.js",
    "./canvas-adapter/outbox.js",
    "./canvas-adapter/sync-state.js",
    "./canvas-adapter/sync-client.js",
    "./canvas-adapter/sync-engine.js",
    "./canvas-adapter/sync-extract-stage.js",
    "./canvas-adapter/sync-uploader.js",
    "./canvas-adapter/sync-finalizer.js",
    "./platform/canvas-sync-storage.js",
    "./platform/canvas-session-resolver.js",
    "./platform/canvas-extraction-messenger.js",
    "./platform/canvas-sync-nest.js",
    "./platform/canvas-sync-controller.js",
    "./platform/canvas-sync-cycle.js",
    "./platform/canvas-sync-core.js",
    "./platform/canvas-sync-alarms.js",
    "./platform/canvas-sync-browser.js",
    "./platform/canvas-registration.js",
    "./platform/planner-page-bridge.js",
    "./platform/overlay-launcher.js",
    "./platform/script-blocker.js",
    "./canvas-adapter/writeback.js",
    "./platform/writeback-consent.js",
    "./platform/writeback-mirrors.js",
    "./platform/writeback-executor.js",
    "./platform/writeback.js",
    "./platform/writeback-runtime.js",
    "./platform/router.js"
]);

if (typeof importScripts === "function") importScripts(...BACKGROUND_PLATFORM_SCRIPTS);

"use strict";

const chromeApi = globalThis.chrome || globalThis.browser || {};
const settingsSchema = globalThis.APStudyCanvasSchema;
const platform = globalThis.APStudyCanvasPlatform;
const updateMessage = "APStudyCanvas was updated. Open the extension to review the latest workspace changes.";
const BACKGROUND_DIAGNOSTIC_TITLE = "APStudyCanvas background diagnostic";
const BACKGROUND_DIAGNOSTIC_MAX_BYTES = 192;
// This local marker intentionally records a one-time compatibility repair,
// rather than a user's preference. It prevents a later, deliberate opt-in
// from being reset on every worker startup.
const SCRIPT_BLOCK_SAFETY_MIGRATION_KEY = "background.script_block_safety_migration.v1";
const BACKGROUND_DIAGNOSTICS = Object.freeze({
    SCRIPT_BLOCK_INITIAL_SYNC_FAILED: Object.freeze({ code: "BACKGROUND_SCRIPT_BLOCK_INITIAL_SYNC_FAILED", category: "script-blocker", operation: "initial-sync" }),
    OVERLAY_LAUNCH_NOT_OPENED: Object.freeze({ code: "BACKGROUND_OVERLAY_LAUNCH_NOT_OPENED", category: "overlay", operation: "launch" }),
    OVERLAY_LAUNCH_FAILED: Object.freeze({ code: "BACKGROUND_OVERLAY_LAUNCH_FAILED", category: "overlay", operation: "launch" }),
    SCRIPT_BLOCK_RESYNC_FAILED: Object.freeze({ code: "BACKGROUND_SCRIPT_BLOCK_RESYNC_FAILED", category: "script-blocker", operation: "settings-resync" }),
    PLATFORM_ALIAS_MIGRATION_FAILED: Object.freeze({ code: "BACKGROUND_PLATFORM_ALIAS_MIGRATION_FAILED", category: "startup", operation: "settings-migration" }),
    INSTALL_RECONCILIATION_FAILED: Object.freeze({ code: "BACKGROUND_INSTALL_RECONCILIATION_FAILED", category: "startup", operation: "install-reconciliation" })
});

function reportBackgroundDiagnostic(key) {
    // The records are module-owned literals: this path never inspects an Error,
    // result, or other caller-controlled object before it reaches the console.
    const diagnostic = BACKGROUND_DIAGNOSTICS[key];
    if (!diagnostic) return;
    try {
        const bytes = JSON.stringify([BACKGROUND_DIAGNOSTIC_TITLE, diagnostic]).length;
        if (bytes <= BACKGROUND_DIAGNOSTIC_MAX_BYTES) console.warn(BACKGROUND_DIAGNOSTIC_TITLE, diagnostic);
    } catch (_) {}
}

function isSuccessfulOverlayLaunchResult(result) {
    if (result === null || (typeof result !== "object" && typeof result !== "function")) return false;
    try {
        const descriptor = Object.getOwnPropertyDescriptor(result, "ok");
        return Boolean(descriptor && Object.prototype.hasOwnProperty.call(descriptor, "value") && descriptor.value === true);
    } catch (_) {
        return false;
    }
}

function unsupportedStorageArea() {
    const unsupported = () => Promise.reject(new Error("browser_unsupported"));
    return Object.freeze({ get: unsupported, set: unsupported, remove: unsupported });
}

function createFeatureDetectedStorageApi(storageApi) {
    const safeStorage = Object.create(storageApi || null);
    ["sync", "local", "session"].forEach((area) => {
        const candidate = storageApi?.[area];
        if (!candidate || ["get", "set", "remove"].some((method) => typeof candidate[method] !== "function")) {
            safeStorage[area] = unsupportedStorageArea();
        }
    });
    return safeStorage;
}

const platformStorageApi = createFeatureDetectedStorageApi(chromeApi.storage);
const storageSessionAvailable = Boolean(chromeApi.storage?.session && ["get", "set", "remove"].every((method) => typeof chromeApi.storage.session[method] === "function"));
const platformStorage = platform.Storage.createChromeStorageAdapter(platformStorageApi);
const sourceMetadataStore = Object.freeze({
    async get() {
        const stored = await platformStorage.get("local", platform.Storage.SOURCE_METADATA_KEY);
        return stored[platform.Storage.SOURCE_METADATA_KEY] || { version: 1, accounts: {} };
    },
    async set(value) { await platformStorage.set("local", { [platform.Storage.SOURCE_METADATA_KEY]: value }); }
});
const canvasRegistration = platform.CanvasRegistration.createCanvasRegistration({ chromeApi });
async function authorizedPlannerBridgeOrigins() {
    const configured = await configuredCanvasOrigins().catch(() => []);
    const staticOrigins = platform.CanvasRegistration?.STATIC_CANVAS_ORIGINS || ["https://canvas.emory.edu"];
    const dynamic = [];
    for (const origin of configured) {
        if (staticOrigins.includes(origin)) continue;
        try {
            if (await chromeApi.permissions?.contains?.({ origins: [`${origin}/*`] })) dynamic.push(origin);
        } catch (_) {}
    }
    return Array.from(new Set(staticOrigins.concat(dynamic)));
}
const plannerPageBridge = platform.PlannerPageBridge?.createPlannerPageBridge?.({ chromeApi, allowedOrigins: authorizedPlannerBridgeOrigins }) || null;
const NEST_BRIDGE_FILES = Object.freeze([
    "js/platform/contract.js",
    "js/platform/security.js",
    "js/platform/transport.js",
    "js/platform/nest-bridge.js"
]);

async function sendToNestTab(tabId, message) {
    if (!chromeApi.tabs?.sendMessage) throw new Error("browser_unsupported");
    try {
        return await chromeApi.tabs.sendMessage(tabId, message);
    } catch (initialError) {
        if (!chromeApi.tabs?.get || !chromeApi.scripting?.executeScript) throw initialError;
        const tab = await chromeApi.tabs.get(tabId);
        let exactNestTab = false;
        try { exactNestTab = new URL(tab?.url || "").origin === platform.Transport.NEST_ORIGIN; } catch (error) {}
        if (!exactNestTab) {
            const error = new Error("NEST_TAB_ORIGIN_INVALID");
            error.code = "NEST_TAB_ORIGIN_INVALID";
            throw error;
        }
        await chromeApi.scripting.executeScript({ target: { tabId }, files: NEST_BRIDGE_FILES });
        return chromeApi.tabs.sendMessage(tabId, message);
    }
}

let pendingNestBridgeTab = null;
async function createNestBridgeTab() {
    if (pendingNestBridgeTab) return pendingNestBridgeTab;
    pendingNestBridgeTab = (async () => {
        const tab = await chromeApi.tabs.create({ url: `${platform.Transport.NEST_ORIGIN}/dashboard`, active: false });
        if (tab.status === "complete") return tab;
        return new Promise((resolve, reject) => {
            const finish = (error, ready) => {
                clearTimeout(timer);
                chromeApi.tabs.onUpdated.removeListener(updated);
                if (error) reject(error); else resolve(ready);
            };
            const updated = (id, change, ready) => {
                if (id === tab.id && change.status === "complete") finish(null, ready);
            };
            const timer = setTimeout(() => finish(new Error("NEST_UNAVAILABLE")), 10000);
            chromeApi.tabs.onUpdated.addListener(updated);
            // Catch completion between tabs.create and listener registration.
            chromeApi.tabs.get(tab.id).then((ready) => {
                if (ready.status === "complete") finish(null, ready);
            }).catch((error) => finish(error));
        });
    })();
    try { return await pendingNestBridgeTab; }
    finally { pendingNestBridgeTab = null; }
}

const platformTransport = platform.Transport.createNestTransport({
    fetchImpl: (...args) => fetch(...args),
    findExactNestTab: async ({ createIfMissing = false } = {}) => {
        if (createIfMissing && pendingNestBridgeTab) return pendingNestBridgeTab;
        if (!chromeApi.tabs?.query) return null;
        const tabs = await chromeApi.tabs.query({ url: [`${platform.Transport.NEST_ORIGIN}/*`] });
        const existing = (tabs || []).find((tab) => {
            try { return new URL(tab.url || "").origin === platform.Transport.NEST_ORIGIN; } catch (error) { return false; }
        }) || null;
        if (existing) return existing;
        return createIfMissing ? createNestBridgeTab() : null;
    },
    sendToTab: sendToNestTab
});
const platformIdb = platform.IndexedDb.createIndexedDbStore();

const CANVAS_SYNC_RUNTIME_UNAVAILABLE = Object.freeze({
    state: "unavailable",
    errorCode: "sync_runtime_unavailable"
});

function unavailableCanvasSyncMethod() {
    return Promise.resolve({ ...CANVAS_SYNC_RUNTIME_UNAVAILABLE });
}

function unavailableCanvasSync() {
    return Object.freeze(Object.fromEntries([
        ["init", unavailableCanvasSyncMethod],
        ["start", unavailableCanvasSyncMethod],
        ["resume", unavailableCanvasSyncMethod],
        ["status", unavailableCanvasSyncMethod],
        ["cancel", unavailableCanvasSyncMethod],
        ["runCycle", unavailableCanvasSyncMethod],
        ["handleAlarm", unavailableCanvasSyncMethod]
    ]));
}

function storageAreaAvailable(area) {
    return Boolean(area && ["get", "set", "remove"].every((method) => typeof area[method] === "function"));
}

function createCanvasSyncIdFactory() {
    const cryptoApi = globalThis.crypto;
    let sequence = 0;
    return (label = "id") => {
        const safeLabel = String(label).replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 48) || "id";
        let entropy = "";
        try {
            if (typeof cryptoApi?.randomUUID === "function") entropy = cryptoApi.randomUUID();
            else if (typeof cryptoApi?.getRandomValues === "function") {
                const bytes = new Uint8Array(12);
                cryptoApi.getRandomValues(bytes);
                entropy = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
            }
        } catch (error) {
            entropy = "";
        }
        sequence += 1;
        return `${safeLabel}-${entropy || `local-${sequence}`}`.slice(0, 160);
    };
}

function createCanvasSyncHashKey() {
    const identity = globalThis.APStudyCanvasCanvasAdapter?.Identity;
    if (typeof identity?.sha256HexSync !== "function") return null;
    return (value) => identity.sha256HexSync(String(value).slice(0, 1024));
}

function canvasSyncModules() {
    const adapter = globalThis.APStudyCanvasCanvasAdapter || {};
    return Object.freeze({
        storage: platform.CanvasSyncStorage,
        resolver: platform.CanvasSessionResolver,
        messenger: platform.CanvasExtractionMessenger,
        nest: platform.CanvasSyncNest,
        core: platform.CanvasSyncCore,
        alarms: platform.CanvasSyncAlarms,
        outbox: adapter.Outbox,
        syncClient: adapter.SyncClient,
        identity: adapter.Identity,
        factories: Object.freeze({
            stateApi: adapter.SyncState,
            createSyncEngine: adapter.SyncEngine?.createSyncEngine,
            createSyncExtractStage: adapter.SyncExtractStage?.createSyncExtractStage,
            createSyncUploader: adapter.SyncUploader?.createSyncUploader,
            createSyncFinalizer: adapter.SyncFinalizer?.createSyncFinalizer,
            createCanvasSyncController: platform.CanvasSyncController?.createCanvasSyncController,
            createCanvasSyncCycle: platform.CanvasSyncCycle?.createCanvasSyncCycle
        })
    });
}

function canvasSyncDependenciesAvailable(modules, hashKey) {
    const adapter = globalThis.APStudyCanvasCanvasAdapter || {};
    const requiredFactories = [
        [modules.storage, "createCanvasSyncStorage"],
        [modules.resolver, "createCanvasSessionResolver"],
        [modules.messenger, "createCanvasExtractionMessenger"],
        [modules.core, "createCanvasSyncCore"],
        [modules.outbox, "createOutbox"],
        [modules.syncClient, "createSyncClient"]
    ];
    const stateApi = modules.factories.stateApi;
    return storageSessionAvailable
        && storageAreaAvailable(chromeApi.storage?.local)
        && typeof chromeApi.tabs?.query === "function"
        && typeof chromeApi.tabs?.sendMessage === "function"
        && typeof platformTransport?.request === "function"
        && typeof platformTransport?.mutate === "function"
        && typeof platformIdb?.list === "function"
        && typeof platformIdb?.put === "function"
        && typeof platformStorage?.get === "function"
        && typeof platform.Contract?.normalizeCanvasOrigins === "function"
        && typeof hashKey === "function"
        && typeof modules.nest === "function"
        && requiredFactories.every(([factory, name]) => typeof factory === "function" || typeof factory?.[name] === "function")
        && typeof adapter.Identity?.sha256HexSync === "function"
        && stateApi && ["createRun", "transition", "toSafeSummary", "restoreSafeSummary", "normalizeBinding"].every((name) => typeof stateApi[name] === "function")
        && [
            "createSyncEngine",
            "createSyncExtractStage",
            "createSyncUploader",
            "createSyncFinalizer",
            "createCanvasSyncController",
            "createCanvasSyncCycle"
        ].every((name) => typeof modules.factories[name] === "function");
}

async function configuredCanvasOrigins() {
    const stored = await platformStorage.get("sync", "custom_domain");
    return platform.Contract.normalizeCanvasOrigins(stored?.custom_domain);
}

const CANVAS_ACCOUNT_KEY_PATTERN = /^[a-f0-9]{64}$/;
const CANVAS_SYNC_OPT_IN_MAX_ACCOUNTS = 64;
const CANVAS_SYNC_OPT_IN_MAX_BYTES = 8192;

function normalizedCanvasSyncOptIns(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    let prototype;
    try {
        prototype = Object.getPrototypeOf(value);
        // Storage values can cross a worker/realm boundary, so a plain object
        // may not share this realm's Object.prototype. Reject class instances
        // and other custom prototypes without relying on object identity.
        if (prototype !== null && Object.getPrototypeOf(prototype) !== null) return {};
    } catch (error) {
        return {};
    }
    const entries = Object.entries(value);
    if (entries.length > CANVAS_SYNC_OPT_IN_MAX_ACCOUNTS) return {};
    const normalized = {};
    for (const [accountKey, optedIn] of entries) {
        if (!CANVAS_ACCOUNT_KEY_PATTERN.test(accountKey) || typeof optedIn !== "boolean") return {};
        normalized[accountKey] = optedIn;
    }
    const serialized = JSON.stringify(normalized);
    const bytes = typeof TextEncoder === "function" ? new TextEncoder().encode(serialized).length : unescape(encodeURIComponent(serialized)).length;
    return bytes <= CANVAS_SYNC_OPT_IN_MAX_BYTES ? normalized : {};
}

let canvasSyncAccountKey = null;
let canvasSyncAccountQueue = Promise.resolve();

async function canvasSyncFeatureFlags(requestAccountKey = canvasSyncAccountKey) {
    const rollout = typeof platformStorage.readFlags === "function"
        ? await platformStorage.readFlags({ upload: false })
        : platform.Contract.normalizeFeatureFlags(
            (await platformStorageApi.local.get("platform.flags"))?.["platform.flags"],
            { upload: false }
        );
    let optIns = {};
    try {
        const stored = await platformStorage.get("local", "canvas_sync_opt_in");
        optIns = normalizedCanvasSyncOptIns(stored?.canvas_sync_opt_in);
    } catch (error) {}
    const accountKey = typeof requestAccountKey === "string" ? requestAccountKey.trim().toLowerCase() : "";
    const accountOptedIn = CANVAS_ACCOUNT_KEY_PATTERN.test(accountKey) && optIns[accountKey] === true;
    return Object.assign({}, rollout, { upload: rollout.upload === true && accountOptedIn });
}

function withCanvasSyncAccount(accountKey, operation) {
    const normalized = typeof accountKey === "string" ? accountKey.trim().toLowerCase() : "";
    const run = canvasSyncAccountQueue.then(async () => {
        const previous = canvasSyncAccountKey;
        canvasSyncAccountKey = CANVAS_ACCOUNT_KEY_PATTERN.test(normalized) ? normalized : null;
        try {
            return await operation();
        } finally {
            canvasSyncAccountKey = previous;
        }
    });
    canvasSyncAccountQueue = run.catch(() => {});
    return run;
}

function createCanvasSyncRuntime() {
    const factory = platform.CanvasSyncBrowser?.createCanvasSyncBrowser;
    const modules = canvasSyncModules();
    const hashKey = createCanvasSyncHashKey();
    if (typeof factory !== "function" || !canvasSyncDependenciesAvailable(modules, hashKey)) return unavailableCanvasSync();
    try {
        const runtime = factory({
            browser: chromeApi,
            transport: platformTransport,
            idb: platformIdb,
            configuredOrigins: configuredCanvasOrigins,
            modules,
            featureFlags: canvasSyncFeatureFlags,
            hashKey,
            sourceMetadataStore,
            idFactory: createCanvasSyncIdFactory()
        });
        if (!runtime || ["init", "start", "resume", "status", "cancel", "runCycle", "handleAlarm"].some((method) => typeof runtime[method] !== "function")) return unavailableCanvasSync();
        return runtime;
    } catch (error) {
        return unavailableCanvasSync();
    }
}

const canvasSync = createCanvasSyncRuntime();

function createBackgroundRevocationCleanup() {
    const modules = canvasSyncModules();
    const hashKey = createCanvasSyncHashKey();
    let syncStorage = null;
    let outbox = null;
    let alarms = null;
    try {
        if (typeof modules.storage?.createCanvasSyncStorage === "function" && typeof hashKey === "function") {
            syncStorage = modules.storage.createCanvasSyncStorage({
                storage: { session: platformStorageApi.session, local: platformStorageApi.local },
                stateApi: modules.factories.stateApi,
                hashKey
            });
        }
    } catch (error) { syncStorage = null; }
    try {
        const factory = modules.outbox?.createOutbox;
        if (typeof factory === "function") outbox = factory({ store: platformIdb });
    } catch (error) { outbox = null; }
    try {
        const factory = modules.alarms?.createCanvasSyncAlarms;
        if (typeof factory === "function" && syncStorage && typeof hashKey === "function") {
            alarms = factory({
                alarms: chromeApi.alarms,
                runIndex: syncStorage.runIndex,
                summaryStore: syncStorage.summaryStore,
                accountAlarmIndex: syncStorage.accountAlarmIndex,
                hashKey
            });
        }
    } catch (error) { alarms = null; }
    try {
        return typeof platform.Router?.createRevocationCleanupCoordinator === "function"
            ? platform.Router.createRevocationCleanupCoordinator({ storage: platformStorage, outbox, alarms, syncStorage })
            : null;
    } catch (error) { return null; }
}

const revocationCleanup = createBackgroundRevocationCleanup();

// Dashboard script hygiene: tab-scoped session rules block Instructure's
// dashboard-only editor/media bundles on dashboard tabs, and the
// static tool-script ruleset is toggled from the user's settings. Feature
// detection keeps older browsers and tests without declarativeNetRequest on
// the plain no-op path.
const scriptBlockCoordinator = platform.ScriptBlocker?.createScriptBlockCoordinator
    ? platform.ScriptBlocker.createScriptBlockCoordinator({
        chromeApi,
        readSettings: async () => {
            const stored = await platformStorage.get("sync", ["block_tool_scripts", "block_editor_scripts", "custom_domain"]);
            return {
                tool: stored?.block_tool_scripts === true,
                editor: stored?.block_editor_scripts === true,
                origins: platform.Contract.normalizeCanvasOrigins(stored?.custom_domain)
            };
        }
    })
    : null;

// DNR updates from startup, the safety migration, and storage events must run
// in order. In particular, an older persisted opt-in must not race the
// migration's explicit false values and re-install its rules after cleanup.
let scriptBlockSyncQueue = Promise.resolve();

function synchronizeScriptBlocks() {
    if (!scriptBlockCoordinator?.isReady?.() || typeof scriptBlockCoordinator.syncFromSettings !== "function") {
        return Promise.reject(new Error("script_blocker_unavailable"));
    }
    const run = scriptBlockSyncQueue.then(() => scriptBlockCoordinator.syncFromSettings());
    scriptBlockSyncQueue = run.catch(() => {});
    return run;
}

async function migrateScriptBlockSafety() {
    const marker = await platformStorageApi.local.get(SCRIPT_BLOCK_SAFETY_MIGRATION_KEY);
    if (marker?.[SCRIPT_BLOCK_SAFETY_MIGRATION_KEY] === true) return { migrated: false };

    // One sync write makes both related compatibility switches safe together.
    // Do not set the local marker until the coordinator has removed the static
    // ruleset and every active tab's session rules using those false values.
    await platformStorageApi.sync.set({
        block_tool_scripts: false,
        block_editor_scripts: false
    });
    await synchronizeScriptBlocks();
    await platformStorageApi.local.set({ [SCRIPT_BLOCK_SAFETY_MIGRATION_KEY]: true });
    return { migrated: true };
}

if (scriptBlockCoordinator?.isReady?.()) {
    migrateScriptBlockSafety().then((result) => {
        // Do not attach tab-update handlers while a legacy profile can still
        // contain true values; that would briefly recreate the very blocks the
        // migration is intended to remove.
        scriptBlockCoordinator.attach();
        // Once this profile has been repaired, normal startup synchronization
        // honors any later, explicit setting changes.
        if (result.migrated === false) return synchronizeScriptBlocks();
        return undefined;
    }).catch(() => {
        reportBackgroundDiagnostic("SCRIPT_BLOCK_INITIAL_SYNC_FAILED");
    });
}

if (chromeApi.alarms?.onAlarm?.addListener) {
    chromeApi.alarms.onAlarm.addListener((alarm) => {
        Promise.resolve().then(() => canvasSync.handleAlarm(alarm)).catch(() => {});
        Promise.resolve().then(() => writebackRuntime?.handleAlarm(alarm)).catch(() => {});
    });
}

const canvasWriteback = platform.Writeback?.createWritebackService?.({
    storage: platformStorage, store: platformIdb, transport: platformTransport,
    executor: platform.WritebackExecutor?.createWritebackExecutor?.({ chromeApi, allowedOrigins: authorizedPlannerBridgeOrigins })
});

const writebackRuntime = canvasWriteback && platform.WritebackRuntime?.createRuntime?.({ storage: platformStorage, service: canvasWriteback, alarms: chromeApi.alarms });
writebackRuntime?.start();

const platformRouter = platform.Router.createRouter({
    canvasWriteback,
    chromeApi,
    storage: platformStorage,
    transport: platformTransport,
    idb: platformIdb,
    canvasRegistration,
    canvasSync,
    withCanvasSyncAccount,
    revocationCleanup,
    scriptBlocker: scriptBlockCoordinator
});

let canvasRegistrationReconcileQueue = Promise.resolve();

function reconcileCanvasRegistrations() {
    // Read storage inside the queue, not before it. Permission and storage
    // events can otherwise enqueue snapshots out of order and let an older
    // onAdded snapshot remove a newer registration transaction.
    const run = canvasRegistrationReconcileQueue.then(async () => {
        const [sync, local] = await Promise.all([
            platformStorageApi.sync.get(["custom_domain"]),
            platformStorageApi.local.get(["platform.accountMetadata"])
        ]);
        const configuredOrigins = platform.Contract.normalizeCanvasOrigins(sync.custom_domain);
        const accounts = Array.isArray(local["platform.accountMetadata"]?.accounts) ? local["platform.accountMetadata"].accounts : [];
        const verifiedOrigins = accounts.map((account) => platform.Contract.normalizeOrigin(account?.origin)).filter(Boolean);
        return canvasRegistration.reconcile({ configuredOrigins, verifiedOrigins });
    });
    canvasRegistrationReconcileQueue = run.catch(() => {});
    return run;
}

if (chromeApi.runtime?.onMessage?.addListener) {
    chromeApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message?.kind === "APSTUDYCANVAS_PLANNER_PAGE_REQUEST" && plannerPageBridge) {
            plannerPageBridge.handle(message, sender).then(sendResponse).catch(() => sendResponse({ ok: false, status: 0, error: "execution" }));
            return true;
        }
        platformRouter.handle(message, sender).then(sendResponse).catch((error) => {
            sendResponse({ version: 1, request_id: message?.request_id || null, type: "ERROR", payload: { ok: false, code: error?.message || "PLATFORM_ROUTER_FAILED" } });
        });
        return true;
    });
}

// Sessions contain opaque nonces and active MAIN-world abort controllers.
// They must not survive a tab close or a new committed top-frame document.
if (chromeApi.tabs?.onRemoved?.addListener && plannerPageBridge?.disposeTab) {
    chromeApi.tabs.onRemoved.addListener((tabId) => plannerPageBridge.disposeTab(tabId));
}
if (chromeApi.webNavigation?.onCommitted?.addListener && plannerPageBridge?.disposeTab) {
    chromeApi.webNavigation.onCommitted.addListener((details) => {
        if (details.frameId === 0) plannerPageBridge.disposeTab(details.tabId);
    });
}

const overlayLauncher = platform.OverlayLauncher.createOverlayLauncher({ chromeApi });

async function overlayLaunchContext() {
    const [configuredOrigins, flags] = await Promise.all([
        configuredCanvasOrigins().catch(() => []),
        platformStorage.readFlags
            ? platformStorage.readFlags(platform.Contract.FEATURE_FLAGS).catch(() => platform.Contract.FEATURE_FLAGS)
            : Promise.resolve(platform.Contract.FEATURE_FLAGS)
    ]);
    return { configuredOrigins, flags };
}

// The toolbar has no default_popup. Clicking it opens the in-page overlay on an
// eligible Canvas tab, hands off to one if the clicked tab is not Canvas, and
// falls back to the workspace in its own tab when no Canvas tab exists.
if (chromeApi.action?.onClicked?.addListener) {
    chromeApi.action.onClicked.addListener((tab) => {
        overlayLaunchContext()
            .then((context) => overlayLauncher.launch(tab, context))
            .then((result) => {
                if (!isSuccessfulOverlayLaunchResult(result)) reportBackgroundDiagnostic("OVERLAY_LAUNCH_NOT_OPENED");
            })
            .catch(() => {
                reportBackgroundDiagnostic("OVERLAY_LAUNCH_FAILED");
            });
    });
}

if (chromeApi.permissions?.onAdded?.addListener) {
    chromeApi.permissions.onAdded.addListener(() => {
        reconcileCanvasRegistrations().catch(() => {});
    });
}

if (chromeApi.permissions?.onRemoved?.addListener) {
    chromeApi.permissions.onRemoved.addListener(() => {
        // A browser-side revocation must remove the matching dynamic scripts
        // even when no settings change follows it.
        reconcileCanvasRegistrations().catch(() => {});
    });
}

if (chromeApi.storage?.onChanged?.addListener) {
    chromeApi.storage.onChanged.addListener((changes, areaName) => {
        if ((areaName === "sync" && changes.custom_domain) || (areaName === "local" && changes["platform.accountMetadata"])) {
            reconcileCanvasRegistrations().catch(() => {});
        }
        if (areaName === "sync" && ["block_tool_scripts", "block_editor_scripts"].some((key) => changes[key])) {
            const sync = synchronizeScriptBlocks();
            if (sync?.catch) sync.catch(() => {
                reportBackgroundDiagnostic("SCRIPT_BLOCK_RESYNC_FAILED");
            });
        }
    });
}

function cloneSetting(value) {
    if (value === undefined) return undefined;
    if (typeof structuredClone === "function") return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
}

function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function missingDefaults(existing, defaults, aliasGroups = []) {
    const changes = {};
    const covered = new Set();

    aliasGroups.forEach((group) => {
        const keys = Array.from(new Set(group));
        keys.forEach((key) => covered.add(key));
        const sourceKey = keys.find((key) => hasOwn(existing, key));
        const value = sourceKey ? existing[sourceKey] : defaults[keys[0]];
        keys.forEach((key) => {
            if (!hasOwn(existing, key) && value !== undefined) changes[key] = cloneSetting(value);
        });
    });

    Object.keys(defaults || {}).forEach((key) => {
        if (covered.has(key) || hasOwn(existing, key)) return;
        changes[key] = cloneSetting(defaults[key]);
    });
    return changes;
}

async function reconcileInstalledStorage(details) {
    if (!settingsSchema) throw new Error("APStudyCanvas settings schema did not load.");

    const [local, sync] = await Promise.all([
        platformStorageApi.local.get(null),
        platformStorageApi.sync.get(null)
    ]);
    const localDefaults = settingsSchema.defaultsForArea("local");
    const syncDefaults = settingsSchema.defaultsForArea("sync");
    const aliases = Object.values(settingsSchema.aliases || {});
    const localChanges = missingDefaults(local, localDefaults);
    const syncChanges = missingDefaults(sync, syncDefaults, aliases);
    // Phase 1 defaults are resolved on read. Leaving them absent preserves an
    // established profile without a surprise sync write during extension
    // update; only an explicit user choice is persisted.
    for (const key of settingsSchema.lazySyncDefaultKeys || []) delete syncChanges[key];

    // Keep the legacy update message contract alive without replacing a
    // message that a user or an older build already saved.
    if (!hasOwn(sync, "update_msg")) {
        syncChanges.update_msg = updateMessage;
    }

    if (Object.keys(localChanges).length) await platformStorageApi.local.set(localChanges);
    if (Object.keys(syncChanges).length) await platformStorageApi.sync.set(syncChanges);

    await platformStorage.migrateLegacyAliases().catch(() => {
        reportBackgroundDiagnostic("PLATFORM_ALIAS_MIGRATION_FAILED");
    });
    await reconcileCanvasRegistrations().catch(() => {});

    if (details?.reason === "install" && (sync.new_install === true || syncChanges.new_install === true)) {
        await platformStorageApi.sync.set({ new_install: false });
    }
}

if (chromeApi.runtime?.onInstalled?.addListener) {
    chromeApi.runtime.onInstalled.addListener((details) => {
        reconcileInstalledStorage(details).catch(() => {
            reportBackgroundDiagnostic("INSTALL_RECONCILIATION_FAILED");
        });
    });
}

globalThis.APStudyCanvasBackground = Object.freeze({
    platformScripts: BACKGROUND_PLATFORM_SCRIPTS.slice(),
    storageSessionAvailable
});

// chrome.runtime.setUninstallURL("https://diditupe.dev/canvasrefined/goodbye");
