(function (root, factory) {
    "use strict";

    const api = factory();
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasPlatform = Object.assign(root.APStudyCanvasPlatform || {}, { CanvasSyncCore: api });
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const SAFE_CODE = /^[A-Za-z][A-Za-z0-9_:-]{0,63}$/;
    const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
    const SENSITIVE = /TOKEN|LEASE|PROOF|TAB|EVENT|RAW|PROVIDER|BINDING|URL|COOKIE|CSRF|SECRET|PASSWORD/i;
    const COUNT_KEY = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;

    function contractError(detail) {
        const error = new Error("DEPENDENCY_CONTRACT_MISMATCH");
        error.code = "DEPENDENCY_CONTRACT_MISMATCH";
        if (detail) error.dependency = detail;
        return error;
    }

    function isFunction(value) {
        return typeof value === "function";
    }

    function firstMethod(target, names) {
        for (const name of names) if (isFunction(target?.[name])) return name;
        return null;
    }

    function requireMethod(target, names, label) {
        const name = firstMethod(target, names);
        if (!name) throw contractError(label || names[0]);
        return name;
    }

    function delegate(target, name) {
        return function delegatedMethod(...args) {
            return target[name](...args);
        };
    }

    function aliasFacade(target, methods, label) {
        const selected = {};
        for (const [canonical, aliases] of Object.entries(methods)) {
            const name = requireMethod(target, aliases, `${label}.${canonical}`);
            selected[canonical] = delegate(target, name);
        }
        return Object.freeze(Object.assign({}, target, selected));
    }

    function prepareDependencies({ factories, storage, nest, resolver, messenger, outbox } = {}) {
        if (!factories || typeof factories !== "object") throw contractError("factories");
        [
            "createSyncEngine",
            "createSyncExtractStage",
            "createSyncUploader",
            "createSyncFinalizer",
            "createCanvasSyncController",
            "createCanvasSyncCycle"
        ].forEach((name) => requireMethod(factories, [name], `factories.${name}`));

        const stateApi = factories.stateApi || factories.syncState;
        if (!stateApi || typeof stateApi !== "object") throw contractError("factories.stateApi");
        ["createRun", "transition", "toSafeSummary", "restoreSafeSummary", "normalizeBinding"]
            .forEach((name) => requireMethod(stateApi, [name], `stateApi.${name}`));

        if (!storage || typeof storage !== "object") throw contractError("storage");
        const summaryStore = aliasFacade(storage.summaryStore, {
            get: ["get", "read", "load"],
            set: ["set", "write", "save"]
        }, "storage.summaryStore");

        if (!nest || typeof nest !== "object") throw contractError("nest");
        ["createClient", "getIdentity", "getConsentProof"].forEach((name) => requireMethod(nest, [name], `nest.${name}`));

        if (!resolver || typeof resolver !== "object") throw contractError("resolver");
        requireMethod(resolver, ["resolve"], "resolver.resolve");

        if (!messenger || typeof messenger !== "object") throw contractError("messenger");
        requireMethod(messenger, ["request"], "messenger.request");

        if (!outbox || typeof outbox !== "object") throw contractError("outbox");
        const outboxApi = aliasFacade(outbox, {
            currentGeneration: ["currentGeneration", "getCurrentGeneration"],
            pendingCount: ["pendingCount", "getPendingCount", "countPending"],
            enqueue: ["enqueue", "enqueueBatch", "enqueueNormalizedBatch"],
            leaseNext: ["leaseNext", "leaseBatch", "acquireBatchLease"],
            acknowledgeBatch: ["acknowledgeBatch", "acknowledge"],
            scheduleRetry: ["scheduleRetry", "retry"]
        }, "outbox");

        return { stateApi, summaryStore, outboxApi };
    }

    function safeCode(value, fallback) {
        if (typeof value !== "string" || !SAFE_CODE.test(value) || SENSITIVE.test(value)) return fallback;
        return value;
    }

    function safeCorrelation(value) {
        return typeof value === "string" && SAFE_ID.test(value) && !SENSITIVE.test(value) ? value : null;
    }

    function safeCountTree(value, depth = 0, seen = new Set()) {
        if (depth > 5) return undefined;
        if (value === null) return null;
        if (Number.isSafeInteger(value) && value >= 0) return value;
        if (typeof value === "boolean") return value;
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

    function redactResult(value, fallback = "SYNC_CORE_FAILED") {
        const result = {};
        const source = value && typeof value === "object" ? value : {};
        const state = safeCode(source.state, "failed");
        result.state = state;
        if (Object.prototype.hasOwnProperty.call(source, "counts")) {
            const counts = safeCountTree(source.counts);
            if (counts !== undefined) result.counts = counts;
        }
        if (Object.prototype.hasOwnProperty.call(source, "errorCode") || Object.prototype.hasOwnProperty.call(source, "code")) {
            const code = source.errorCode ?? source.code;
            result.errorCode = code === null || code === undefined ? null : safeCode(code, fallback);
        }
        const correlation = safeCorrelation(source.correlation);
        if (correlation) result.correlation = correlation;
        return result;
    }

    function failureResult(error, correlation) {
        const result = { state: "failed", errorCode: safeCode(error?.code, "SYNC_CORE_FAILED") };
        const safe = safeCorrelation(correlation);
        if (safe) result.correlation = safe;
        return result;
    }

    function createCanvasSyncCore({ factories, storage, nest, resolver, messenger, outbox, getFeatureFlags, scheduleResume, idFactory } = {}) {
        const prepared = prepareDependencies({ factories, storage, nest, resolver, messenger, outbox });
        const flags = getFeatureFlags === undefined ? () => ({ upload: false }) : getFeatureFlags;
        if (!isFunction(flags) && (!flags || typeof flags !== "object")) throw contractError("getFeatureFlags");
        if (scheduleResume !== undefined && !isFunction(scheduleResume)) throw contractError("scheduleResume");
        if (idFactory !== undefined && !isFunction(idFactory) && !(idFactory && isFunction(idFactory.create))) throw contractError("idFactory");

        const client = nest.createClient();
        if (!client || typeof client !== "object") throw contractError("nest.createClient");
        ["preflight", "establishSource", "startRun", "status", "resume", "cancel", "uploadBatch", "finalize"]
            .forEach((name) => requireMethod(client, [name], `client.${name}`));

        const featureFlags = flags;
        const resolveCanvasSession = resolver.resolve;
        const getNestIdentity = nest.getIdentity;
        const getConsentProof = nest.getConsentProof;
        const requestExtraction = messenger.request;
        const engine = factories.createSyncEngine({
            stateApi: prepared.stateApi,
            client,
            summaryStore: prepared.summaryStore,
            resolveCanvasSession
        });
        const extractStage = factories.createSyncExtractStage({ outbox: prepared.outboxApi, idFactory });
        const uploader = factories.createSyncUploader({ client, outbox: prepared.outboxApi });
        const finalizer = factories.createSyncFinalizer({
            stateApi: prepared.stateApi,
            client,
            outbox: prepared.outboxApi,
            summaryStore: prepared.summaryStore
        });
        const controller = factories.createCanvasSyncController({
            getFeatureFlags: featureFlags,
            getNestIdentity,
            getConsentProof,
            resolveCanvasSession,
            engine,
            idFactory
        });
        const cycle = factories.createCanvasSyncCycle({
            getFeatureFlags: featureFlags,
            resolveCanvasSession,
            requestExtraction,
            extractStage,
            uploader,
            finalizer,
            outbox: prepared.outboxApi,
            scheduleResume,
            idFactory
        });

        async function publicCall(target, method, input) {
            try {
                return redactResult(await target[method](input));
            } catch (error) {
                return failureResult(error, input?.correlation || input?.requestId);
            }
        }

        return Object.freeze({
            start: (input) => publicCall(controller, "start", input),
            resume: (input) => publicCall(controller, "resume", input),
            status: (input) => publicCall(controller, "status", input),
            cancel: (input) => publicCall(controller, "cancel", input),
            runCycle: (input) => publicCall(cycle, "runCycle", input)
        });
    }

    return Object.freeze({ createCanvasSyncCore });
}));
