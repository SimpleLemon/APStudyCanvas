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
    "./platform/fullscreen.js",
    "./platform/router.js"
]);

if (typeof importScripts === "function") importScripts(...BACKGROUND_PLATFORM_SCRIPTS);

"use strict";

const chromeApi = globalThis.chrome || globalThis.browser || {};
const settingsSchema = globalThis.APStudyCanvasSchema;
const platform = globalThis.APStudyCanvasPlatform;
const updateMessage = "APStudyCanvas was updated. Open the extension to review the latest workspace changes.";

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
const platformTransport = platform.Transport.createNestTransport({
    fetchImpl: (...args) => fetch(...args),
    findExactNestTab: async () => {
        if (!chromeApi.tabs?.query) return null;
        const tabs = await chromeApi.tabs.query({ url: [`${platform.Transport.NEST_ORIGIN}/*`] });
        return (tabs || []).find((tab) => {
            try { return new URL(tab.url || "").origin === platform.Transport.NEST_ORIGIN; } catch (error) { return false; }
        }) || null;
    },
    sendToTab: (tabId, message) => chromeApi.tabs?.sendMessage
        ? chromeApi.tabs.sendMessage(tabId, message)
        : Promise.reject(new Error("browser_unsupported"))
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

if (chromeApi.alarms?.onAlarm?.addListener) {
    chromeApi.alarms.onAlarm.addListener((alarm) => {
        Promise.resolve().then(() => canvasSync.handleAlarm(alarm)).catch(() => {});
    });
}

const platformRouter = platform.Router.createRouter({
    chromeApi,
    storage: platformStorage,
    transport: platformTransport,
    fullscreen: platform.Fullscreen,
    idb: platformIdb,
    canvasRegistration,
    canvasSync,
    withCanvasSyncAccount,
    revocationCleanup
});

async function reconcileCanvasRegistrations() {
    const [sync, local] = await Promise.all([
        platformStorageApi.sync.get(["custom_domain"]),
        platformStorageApi.local.get(["platform.accountMetadata"])
    ]);
    const configuredOrigins = platform.Contract.normalizeCanvasOrigins(sync.custom_domain);
    const accounts = Array.isArray(local["platform.accountMetadata"]?.accounts) ? local["platform.accountMetadata"].accounts : [];
    const verifiedOrigins = accounts.map((account) => platform.Contract.normalizeOrigin(account?.origin)).filter(Boolean);
    return canvasRegistration.reconcile({ configuredOrigins, verifiedOrigins });
}

if (chromeApi.runtime?.onMessage?.addListener) {
    chromeApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
        platformRouter.handle(message, sender).then(sendResponse).catch((error) => {
            sendResponse({ version: 1, request_id: message?.request_id || null, type: "ERROR", payload: { ok: false, code: error?.message || "PLATFORM_ROUTER_FAILED" } });
        });
        return true;
    });
}

if (chromeApi.windows?.onRemoved?.addListener) {
    chromeApi.windows.onRemoved.addListener((windowId) => {
        platform.Fullscreen.removeWindow(platformStorage, windowId).catch(() => {});
    });
}

if (chromeApi.permissions?.onAdded?.addListener) {
    chromeApi.permissions.onAdded.addListener(() => {
        reconcileCanvasRegistrations().catch(() => {});
    });
}

if (chromeApi.storage?.onChanged?.addListener) {
    chromeApi.storage.onChanged.addListener((changes, areaName) => {
        if ((areaName === "sync" && changes.custom_domain) || (areaName === "local" && changes["platform.accountMetadata"])) {
            reconcileCanvasRegistrations().catch(() => {});
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

    // Keep the legacy update message contract alive without replacing a
    // message that a user or an older build already saved.
    if (!hasOwn(sync, "update_msg")) {
        syncChanges.update_msg = updateMessage;
    }

    if (Object.keys(localChanges).length) await platformStorageApi.local.set(localChanges);
    if (Object.keys(syncChanges).length) await platformStorageApi.sync.set(syncChanges);

    await platformStorage.migrateLegacyAliases().catch((error) => {
        console.warn("APStudyCanvas platform alias migration failed", error);
    });
    await reconcileCanvasRegistrations().catch(() => {});

    if (details?.reason === "install" && (sync.new_install === true || syncChanges.new_install === true)) {
        await platformStorageApi.sync.set({ new_install: false });
    }
}

if (chromeApi.runtime?.onInstalled?.addListener) {
    chromeApi.runtime.onInstalled.addListener((details) => {
        reconcileInstalledStorage(details).catch((error) => {
            console.error("APStudyCanvas install reconciliation failed", error);
        });
    });
}

globalThis.APStudyCanvasBackground = Object.freeze({
    platformScripts: BACKGROUND_PLATFORM_SCRIPTS.slice(),
    storageSessionAvailable
});

// chrome.runtime.setUninstallURL("https://diditupe.dev/canvasrefined/goodbye");
