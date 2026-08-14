(function (root, factory) {
    "use strict";

    const api = factory(root, typeof require === "function" ? require : null);
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasPlatform = Object.assign(root.APStudyCanvasPlatform || {}, { CanvasSyncBrowser: api });
}(typeof globalThis !== "undefined" ? globalThis : this, function (root, loader) {
    "use strict";

    const SAFE_CODE = /^[A-Za-z][A-Za-z0-9_:-]{0,63}$/;
    const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
    const SENSITIVE = /TAB|ACCOUNT|CANVAS|SOURCE|ORIGIN|PROOF|LEASE|EVENT|RAW|TOKEN|COOKIE|CSRF|SECRET|PASSWORD|URL/i;
    const COUNT_KEY = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;
    const SOURCE_REF = /^src1:[A-Za-z0-9._~-]{1,128}$/;
    const DEFAULT_FLAGS = Object.freeze({ upload: false });

    function own(value, key) {
        return Object.prototype.hasOwnProperty.call(value || {}, key);
    }

    function isObject(value) {
        return Boolean(value) && typeof value === "object";
    }

    function pick(value, names) {
        for (const name of names) if (value && value[name] !== undefined) return value[name];
        return undefined;
    }

    function tryLoad(path) {
        if (typeof loader !== "function") return null;
        try { return loader(path); } catch (error) { return null; }
    }

    function moduleFrom(modules, names, globalValue, path) {
        const injected = pick(modules, names);
        if (injected !== undefined) return injected;
        if (globalValue !== undefined) return globalValue;
        return tryLoad(path);
    }

    function unwrap(value, name) {
        if (typeof value === "function") return value;
        return typeof value?.[name] === "function" ? value[name] : null;
    }

    function method(value, names) {
        for (const name of names) if (typeof value?.[name] === "function") return value[name];
        return null;
    }

    function idFactoryFunction(value) {
        if (typeof value === "function") return value;
        if (typeof value?.create === "function") return value.create.bind(value);
        return null;
    }

    function defaultIdFactory() {
        let next = 0;
        return (label = "id") => `${String(label).replace(/[^A-Za-z0-9._:-]/g, "-")}-${++next}`;
    }

    function safeFlags(value) {
        if (!value || typeof value !== "object" || Array.isArray(value)) return { ...DEFAULT_FLAGS };
        const flags = { ...DEFAULT_FLAGS };
        for (const [key, item] of Object.entries(value)) {
            if (/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/.test(key) && typeof item === "boolean") flags[key] = item;
        }
        return flags;
    }

    function safeCode(value, fallback = "SYNC_BROWSER_UNAVAILABLE") {
        return typeof value === "string" && SAFE_CODE.test(value) && !SENSITIVE.test(value) ? value : fallback;
    }

    function safeId(value) {
        return typeof value === "string" && SAFE_ID.test(value) && !SENSITIVE.test(value) ? value : null;
    }

    function safeCountTree(value, depth = 0, seen = new Set()) {
        if (depth > 5) return undefined;
        if (Number.isSafeInteger(value) && value >= 0) return value;
        if (typeof value === "boolean" || value === null) return value;
        if (!value || typeof value !== "object" || seen.has(value)) return undefined;
        seen.add(value);
        let result;
        if (Array.isArray(value)) {
            const items = value.map((item) => safeCountTree(item, depth + 1, seen));
            result = items.every((item) => item !== undefined) ? items : undefined;
        } else {
            result = {};
            for (const [key, item] of Object.entries(value)) {
                if (!COUNT_KEY.test(key) || SENSITIVE.test(key)) { result = undefined; break; }
                const safe = safeCountTree(item, depth + 1, seen);
                if (safe === undefined) { result = undefined; break; }
                result[key] = safe;
            }
        }
        seen.delete(value);
        return result;
    }

    function redact(value, fallback = "SYNC_BROWSER_FAILED") {
        const source = isObject(value) ? value : {};
        const result = {};
        if (typeof source.state === "string" && SAFE_CODE.test(source.state) && !SENSITIVE.test(source.state)) result.state = source.state;
        if (own(source, "counts")) {
            const counts = safeCountTree(source.counts);
            if (counts !== undefined) result.counts = counts;
        }
        if (own(source, "count") && Number.isSafeInteger(source.count) && source.count >= 0) result.count = source.count;
        for (const key of ["correlation", "hash"]) {
            const safe = safeId(source[key]);
            if (safe) result[key] = safe;
        }
        if (own(source, "errorCode") || own(source, "code") || own(source, "error")) {
            const candidate = source.errorCode ?? source.code ?? source.error?.code;
            result.errorCode = candidate === null || candidate === undefined ? null : safeCode(candidate, fallback);
        }
        const sourceRef = source.source_ref ?? source.sourceRef ?? source.binding?.source_ref ?? source.binding?.sourceRef;
        if (typeof sourceRef === "string" && SOURCE_REF.test(sourceRef)) result.source_ref = sourceRef;
        if (!Object.keys(result).length) result.state = "unavailable";
        return result;
    }

    function browserArea(value) {
        return value && ["get", "set", "remove"].every((name) => typeof value[name] === "function");
    }

    function transportAvailable(value) {
        return typeof value === "function" || typeof value?.request === "function" || typeof value?.mutate === "function";
    }

    function storeAvailable(value) {
        return value && typeof value.list === "function" && typeof value.put === "function";
    }

    function idbAvailable(value) {
        return storeAvailable(value) || typeof value?.createIndexedDbStore === "function" || typeof value?.createStore === "function";
    }

    function dependencySet({ browser, transport, idb, configuredOrigins, modules, hashKey, idFactory }) {
        const platform = root?.APStudyCanvasPlatform || {};
        const adapter = root?.APStudyCanvasCanvasAdapter || {};
        const injected = modules || {};
        const storageApi = moduleFrom(injected, ["storage", "canvasSyncStorage", "syncStorage", "CanvasSyncStorage", "createCanvasSyncStorage"], platform.CanvasSyncStorage, "./canvas-sync-storage.js");
        const resolverApi = moduleFrom(injected, ["resolver", "sessionResolver", "canvasSessionResolver", "CanvasSessionResolver", "createCanvasSessionResolver"], platform.CanvasSessionResolver, "./canvas-session-resolver.js");
        const messengerApi = moduleFrom(injected, ["messenger", "extractionMessenger", "canvasExtractionMessenger", "CanvasExtractionMessenger", "createCanvasExtractionMessenger"], platform.CanvasExtractionMessenger, "./canvas-extraction-messenger.js");
        const nestApi = moduleFrom(injected, ["nest", "canvasSyncNest", "CanvasSyncNest", "createCanvasSyncNest"], platform.CanvasSyncNest, "./canvas-sync-nest.js");
        const coreApi = moduleFrom(injected, ["core", "canvasSyncCore", "CanvasSyncCore", "createCanvasSyncCore"], platform.CanvasSyncCore, "./canvas-sync-core.js");
        const outboxApi = moduleFrom(injected, ["outbox", "canvasOutbox", "Outbox", "createOutbox"], adapter.Outbox, "../canvas-adapter/outbox.js");
        const syncClientApi = moduleFrom(injected, ["syncClient", "client", "SyncClient", "createSyncClient"], adapter.SyncClient, "../canvas-adapter/sync-client.js");
        const stateApi = moduleFrom(injected, ["stateApi", "syncState", "state", "SyncState"], adapter.SyncState, "../canvas-adapter/sync-state.js");
        const engineApi = moduleFrom(injected, ["engine", "syncEngine", "SyncEngine", "createSyncEngine"], adapter.SyncEngine, "../canvas-adapter/sync-engine.js");
        const stageApi = moduleFrom(injected, ["extractStage", "syncExtractStage", "SyncExtractStage", "createSyncExtractStage"], adapter.SyncExtractStage, "../canvas-adapter/sync-extract-stage.js");
        const uploaderApi = moduleFrom(injected, ["uploader", "syncUploader", "SyncUploader", "createSyncUploader"], adapter.SyncUploader, "../canvas-adapter/sync-uploader.js");
        const finalizerApi = moduleFrom(injected, ["finalizer", "syncFinalizer", "SyncFinalizer", "createSyncFinalizer"], adapter.SyncFinalizer, "../canvas-adapter/sync-finalizer.js");
        const controllerApi = moduleFrom(injected, ["controller", "syncController", "canvasSyncController", "CanvasSyncController", "createCanvasSyncController"], platform.CanvasSyncController, "./canvas-sync-controller.js");
        const cycleApi = moduleFrom(injected, ["cycle", "syncCycle", "canvasSyncCycle", "CanvasSyncCycle", "createCanvasSyncCycle"], platform.CanvasSyncCycle, "./canvas-sync-cycle.js");
        const alarmsApi = moduleFrom(injected, ["alarms", "canvasSyncAlarms", "CanvasSyncAlarms", "createCanvasSyncAlarms"], platform.CanvasSyncAlarms, "./canvas-sync-alarms.js");
        const factoryInput = pick(injected, ["factories", "coreFactories"]) || {};
        const factories = {
            stateApi: pick(factoryInput, ["stateApi", "syncState"]) || stateApi,
            createSyncEngine: pick(factoryInput, ["createSyncEngine"]) || unwrap(engineApi, "createSyncEngine"),
            createSyncExtractStage: pick(factoryInput, ["createSyncExtractStage"]) || unwrap(stageApi, "createSyncExtractStage"),
            createSyncUploader: pick(factoryInput, ["createSyncUploader"]) || unwrap(uploaderApi, "createSyncUploader"),
            createSyncFinalizer: pick(factoryInput, ["createSyncFinalizer"]) || unwrap(finalizerApi, "createSyncFinalizer"),
            createCanvasSyncController: pick(factoryInput, ["createCanvasSyncController"]) || unwrap(controllerApi, "createCanvasSyncController"),
            createCanvasSyncCycle: pick(factoryInput, ["createCanvasSyncCycle"]) || unwrap(cycleApi, "createCanvasSyncCycle")
        };
        const missing = [];
        if (!browserArea(browser?.storage?.session)) missing.push("storage.session");
        if (!browserArea(browser?.storage?.local)) missing.push("storage.local");
        if (typeof browser?.tabs?.query !== "function" || typeof browser?.tabs?.sendMessage !== "function") missing.push("tabs");
        if (!transportAvailable(transport)) missing.push("transport");
        if (!idbAvailable(idb)) missing.push("idb");
        if (typeof hashKey !== "function") missing.push("hashKey");
        if (!unwrap(storageApi, "createCanvasSyncStorage")) missing.push("createCanvasSyncStorage");
        if (!unwrap(resolverApi, "createCanvasSessionResolver")) missing.push("createCanvasSessionResolver");
        if (!unwrap(messengerApi, "createCanvasExtractionMessenger")) missing.push("createCanvasExtractionMessenger");
        if (!unwrap(nestApi, "createCanvasSyncNest") && typeof nestApi !== "function") missing.push("createCanvasSyncNest");
        if (!unwrap(coreApi, "createCanvasSyncCore")) missing.push("createCanvasSyncCore");
        if (!unwrap(outboxApi, "createOutbox")) missing.push("createOutbox");
        if (!idFactoryFunction(idFactory)) missing.push("idFactory");
        ["createSyncEngine", "createSyncExtractStage", "createSyncUploader", "createSyncFinalizer", "createCanvasSyncController", "createCanvasSyncCycle"].forEach((name) => {
            if (typeof factories[name] !== "function") missing.push(`factories.${name}`);
        });
        if (!factories.stateApi || typeof factories.stateApi !== "object"
            || ["createRun", "transition", "toSafeSummary", "restoreSafeSummary", "normalizeBinding"].some((name) => typeof factories.stateApi[name] !== "function")) missing.push("factories.stateApi");
        if (typeof unwrap(syncClientApi, "createSyncClient") !== "function" && typeof syncClientApi !== "function") missing.push("syncClientFactory");
        return {
            browser,
            transport,
            idb,
            hashKey,
            configuredOrigins,
            storageFactory: unwrap(storageApi, "createCanvasSyncStorage"),
            resolverFactory: unwrap(resolverApi, "createCanvasSessionResolver"),
            messengerFactory: unwrap(messengerApi, "createCanvasExtractionMessenger"),
            nestFactory: typeof nestApi === "function" ? nestApi : unwrap(nestApi, "createCanvasSyncNest"),
            coreFactory: unwrap(coreApi, "createCanvasSyncCore"),
            alarmsFactory: unwrap(alarmsApi, "createCanvasSyncAlarms"),
            outboxFactory: unwrap(outboxApi, "createOutbox"),
            syncClientFactory: typeof syncClientApi === "function" ? syncClientApi : unwrap(syncClientApi, "createSyncClient"),
            factories,
            idFactory: idFactoryFunction(idFactory),
            missing
        };
    }

    function idFactoryValue(modules) {
        return pick(modules || {}, ["idFactory", "ids"]) || null;
    }

    async function resolveConfiguredOrigins(value) {
        let resolved = typeof value === "function" ? value() : value;
        if (resolved && typeof resolved.then === "function") resolved = await resolved;
        if (resolved instanceof Set) resolved = Array.from(resolved);
        return Array.isArray(resolved) ? resolved.slice() : resolved;
    }

    function createCanvasSyncBrowser(options = {}) {
        const {
            browser,
            transport,
            idb,
            configuredOrigins,
            modules,
            featureFlags,
            idFactory: suppliedIdFactory,
            hashKey
        } = options;
        const selectedIdFactory = suppliedIdFactory || idFactoryValue(modules) || defaultIdFactory();
        const dependencies = dependencySet({ browser, transport, idb, configuredOrigins, modules, hashKey, idFactory: selectedIdFactory });
        if (typeof dependencies.idFactory !== "function") dependencies.idFactory = idFactoryFunction(selectedIdFactory) || defaultIdFactory();
        if (dependencies.missing.includes("idFactory")) dependencies.missing = dependencies.missing.filter((item) => item !== "idFactory");

        let flagsReady = false;
        let flags = { ...DEFAULT_FLAGS };
        let components = null;
        let alarmStorage = null;
        let alarmAdapter = null;
        let outboxInit = null;
        let initialization = null;
        let activeCycleContext = null;
        let unavailable = dependencies.missing.length ? "dependency_unavailable" : null;

        async function readFlags() {
            try {
                if (featureFlags !== undefined) {
                    const provided = await (typeof featureFlags === "function" ? featureFlags() : featureFlags);
                    flags = safeFlags(provided);
                } else {
                    const result = await dependencies.browser.storage.local.get("platform.flags");
                    const stored = result?.["platform.flags"] ?? (result && typeof result === "object" && own(result, "upload") ? result : undefined);
                    flags = safeFlags(stored);
                }
                flagsReady = true;
                return flags;
            } catch (error) {
                unavailable = "storage_unavailable";
                throw error;
            }
        }

        function enabled() {
            return flags.upload === true;
        }

        function leaseBinding(key) {
            const sourceId = dependencies.hashKey(`canvas-sync-browser-lease:${String(key)}`);
            return { sourceId, runId: "canvas-sync-browser", generation: 1 };
        }

        function createSessionSecretStore(leaseStore) {
            return Object.freeze({
                async get(key) { return leaseStore.get(leaseBinding(key)); },
                async set(key, value) { return leaseStore.set(leaseBinding(key), value); },
                async remove(key) { return leaseStore.remove(leaseBinding(key)); }
            });
        }

        function makeOutbox() {
            let store = dependencies.idb;
            if (!storeAvailable(store)) {
                if (typeof dependencies.idb.createIndexedDbStore === "function") {
                    store = dependencies.idb.createIndexedDbStore({ indexedDB: dependencies.browser.indexedDB, storeName: "canvas_outbox" });
                } else if (typeof dependencies.idb.createStore === "function") {
                    store = dependencies.idb.createStore({ browser: dependencies.browser, storeName: "canvas_outbox" });
                }
            }
            if (!storeAvailable(store)) throw new Error("OUTBOX_STORE_REQUIRED");
            return dependencies.outboxFactory({ store });
        }

        function unavailableAlarms() {
            return Object.freeze({
                available: false,
                schedule: () => ({ state: "paused", errorCode: "alarms_unavailable" }),
                consume: async () => null,
                cancel: () => ({ state: "paused", errorCode: "alarms_unavailable" })
            });
        }

        function createAlarmAdapter(storage) {
            if (typeof dependencies.alarmsFactory !== "function") return unavailableAlarms();
            try {
                return dependencies.alarmsFactory({
                    alarms: dependencies.browser.alarms,
                    runIndex: storage?.runIndex,
                    summaryStore: storage?.summaryStore,
                    hashKey: dependencies.hashKey
                });
            } catch (error) {
                return unavailableAlarms();
            }
        }

        function ensureAlarmAdapter() {
            if (alarmAdapter) return alarmAdapter;
            if (!alarmStorage) {
                try {
                    alarmStorage = dependencies.storageFactory({
                        storage: {
                            session: dependencies.browser.storage.session,
                            local: dependencies.browser.storage.local
                        },
                        stateApi: dependencies.factories.stateApi,
                        hashKey: dependencies.hashKey
                    });
                } catch (error) {
                    alarmAdapter = unavailableAlarms();
                    return alarmAdapter;
                }
            }
            alarmAdapter = createAlarmAdapter(alarmStorage);
            return alarmAdapter;
        }

        async function ensureSummaryRef(storage, context) {
            const summaryStore = storage?.summaryStore;
            const binding = context?.binding;
            if (!binding) return null;
            if (typeof summaryStore?.getRef === "function") {
                try {
                    const existing = await summaryStore.getRef(binding);
                    if (typeof existing === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(existing)) return existing;
                } catch (error) {}
            }
            if (typeof summaryStore?.set !== "function") return null;
            let runSummary = context?.runSummary;
            if (runSummary === undefined && typeof summaryStore.get === "function") {
                try { runSummary = await summaryStore.get(binding); } catch (error) { return null; }
            }
            if (runSummary === null || runSummary === undefined) return null;
            try {
                const summaryRef = await summaryStore.set(runSummary);
                if (typeof summaryRef === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(summaryRef)) return summaryRef;
            } catch (error) {}
            try {
                const summaryRef = await summaryStore.set(binding, runSummary);
                return typeof summaryRef === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(summaryRef) ? summaryRef : null;
            } catch (error) { return null; }
        }

        async function scheduleResume(input = {}) {
            const context = activeCycleContext;
            if (!context || !alarmAdapter?.available) return { state: "paused", errorCode: "alarms_unavailable" };
            const summaryRef = await ensureSummaryRef(context.storage || components?.storage || alarmStorage, context);
            if (!summaryRef) return { state: "paused", errorCode: "summary_ref_unavailable" };
            return alarmAdapter.schedule(context.binding, { delayMs: input.delayMs, summaryRef });
        }

        async function buildComponents() {
            const resolvedOrigins = await resolveConfiguredOrigins(configuredOrigins);
            const storage = alarmStorage || dependencies.storageFactory({
                storage: {
                    session: dependencies.browser.storage.session,
                    local: dependencies.browser.storage.local
                },
                stateApi: dependencies.factories.stateApi,
                hashKey: dependencies.hashKey
            });
            alarmStorage = storage;
            alarmAdapter = alarmAdapter || createAlarmAdapter(storage);
            const rawResolver = dependencies.resolverFactory({
                tabs: dependencies.browser.tabs,
                configuredOrigins: resolvedOrigins,
                idFactory: dependencies.idFactory
            });
            const sessions = new Map();
            const resolver = Object.freeze({
                async resolve(binding) {
                    const session = await rawResolver.resolve(binding);
                    if (session && Number.isSafeInteger(session.tabId)) sessions.set(session.tabId, session);
                    return session;
                },
                isOwnedSession(session) {
                    return rawResolver.isOwnedSession(session);
                }
            });
            const rawMessenger = dependencies.messengerFactory({
                tabs: dependencies.browser.tabs,
                sessionResolver: resolver,
                idFactory: dependencies.idFactory
            });
            const messenger = Object.freeze({
                async request(sessionOrTabId, payloadOrEnvelope) {
                    let session = sessionOrTabId;
                    let payload = payloadOrEnvelope;
                    if (Number.isSafeInteger(sessionOrTabId)) {
                        session = sessions.get(sessionOrTabId) || null;
                        payload = payloadOrEnvelope?.payload;
                    }
                    return rawMessenger.request(session, payload);
                }
            });
            const sessionSecretStore = createSessionSecretStore(storage.leaseStore);
            const nest = dependencies.nestFactory({
                transport: dependencies.transport,
                syncClientFactory: (clientDependencies) => dependencies.syncClientFactory({
                    ...clientDependencies,
                    idFactory: dependencies.idFactory
                }),
                sessionSecretStore,
                sourceMetadataStore: options.sourceMetadataStore
            });
            const outbox = makeOutbox();
            if (!outbox || typeof outbox.init !== "function") throw new Error("OUTBOX_INIT_UNAVAILABLE");
            outboxInit = Promise.resolve().then(() => outbox.init());
            await outboxInit;
            const core = dependencies.coreFactory({
                factories: dependencies.factories,
                storage,
                nest,
                resolver,
                messenger,
                outbox,
                getFeatureFlags: () => flags,
                scheduleResume,
                idFactory: dependencies.idFactory
            });
            if (!core || ["start", "resume", "status", "cancel", "runCycle"].some((name) => typeof core[name] !== "function")) throw new Error("CORE_UNAVAILABLE");
            components = Object.freeze({ storage, resolver, messenger, nest, outbox, core, alarmAdapter });
        }

        async function ensureReady() {
            if (!flagsReady) {
                try { await readFlags(); } catch (error) { return { unavailable: unavailable || "storage_unavailable" }; }
            }
            if (!enabled()) return { disabled: true };
            if (unavailable) return { unavailable };
            if (components) return { ready: true };
            if (!initialization) {
                initialization = buildComponents().catch((error) => {
                    unavailable = safeCode(error?.code || error?.message, "dependency_unavailable");
                    components = null;
                    return null;
                });
            }
            await initialization;
            return components ? { ready: true } : { unavailable: unavailable || "dependency_unavailable" };
        }

        async function init() {
            const state = await ensureReady();
            if (state.ready || state.disabled) return { ok: true, available: true };
            return { ok: false, available: false, errorCode: safeCode(state.unavailable, "dependency_unavailable") };
        }

        async function delegate(name, input) {
            const state = await ensureReady();
            if (state.disabled) return { state: "idle", errorCode: "feature_disabled" };
            if (!state.ready) return { state: "unavailable", errorCode: safeCode(state.unavailable, "dependency_unavailable") };
            try { return redact(await components.core[name](input)); }
            catch (error) { return redact({ state: "failed", errorCode: error?.code }, "SYNC_BROWSER_FAILED"); }
        }

        function internalBinding(run) {
            const binding = run?.binding;
            if (!isObject(binding) || !Number.isSafeInteger(binding.generation) || binding.generation <= 0
                || typeof binding.accountKey !== "string" || typeof binding.origin !== "string"
                || typeof binding.userId !== "string" || typeof binding.sourceId !== "string" || typeof binding.sourceRef !== "string" || !SOURCE_REF.test(binding.sourceRef) || typeof binding.runId !== "string"
                || binding.consentVersion !== 1 || typeof binding.scopeHash !== "string"
                || !Array.isArray(binding.registeredDescriptorIds) || binding.registeredDescriptorIds.length === 0) return null;
            return Object.freeze({
                contractVersion: 1,
                accountKey: binding.accountKey,
                origin: binding.origin,
                canvasUserId: binding.userId,
                sourceId: binding.sourceId,
                source_ref: binding.sourceRef,
                runId: binding.runId,
                generation: binding.generation,
                consentVersion: binding.consentVersion,
                scope: { hash: binding.scopeHash },
                descriptors: binding.registeredDescriptorIds.slice()
            });
        }

        async function handleAlarm(alarm) {
            try {
                const adapter = ensureAlarmAdapter();
                const summaryRef = await adapter.consume(alarm);
                if (!summaryRef) return redact({ state: "idle", errorCode: "alarm_ignored" });

                if (!flagsReady) {
                    try { await readFlags(); } catch (error) { return redact({ state: "idle", errorCode: "storage_unavailable" }); }
                }
                if (!enabled()) return redact({ state: "idle", errorCode: "feature_disabled" });

                const state = await ensureReady();
                if (!state.ready || typeof components.storage.summaryStore?.getByRef !== "function") {
                    return redact({ state: "idle", errorCode: state.unavailable || "summary_unavailable" });
                }
                const run = await components.storage.summaryStore.getByRef(summaryRef);
                const binding = internalBinding(run);
                let safeSummary = null;
                try { safeSummary = binding ? dependencies.factories.stateApi.toSafeSummary(run) : null; } catch (error) { safeSummary = null; }
                if (!binding || !safeSummary) return redact({ state: "idle", errorCode: "summary_unavailable" });

                const previous = activeCycleContext;
                activeCycleContext = { binding, runSummary: safeSummary, storage: components.storage };
                try {
                    return redact(await components.core.runCycle({ binding, runSummary: safeSummary }));
                } finally {
                    activeCycleContext = previous;
                }
            } catch (error) {
                return redact({ state: "failed", errorCode: error?.code }, "ALARM_HANDLER_FAILED");
            }
        }

        return Object.freeze({
            init,
            start: (input) => delegate("start", input),
            resume: (input) => delegate("resume", input),
            status: (input) => delegate("status", input),
            cancel: (input) => delegate("cancel", input),
            runCycle: async (input) => {
                const previous = activeCycleContext;
                activeCycleContext = { binding: input?.binding, runSummary: input?.runSummary, storage: components?.storage || alarmStorage };
                try { return await delegate("runCycle", input); }
                finally { activeCycleContext = previous; }
            },
            handleAlarm
        });
    }

    return Object.freeze({ createCanvasSyncBrowser });
}));
