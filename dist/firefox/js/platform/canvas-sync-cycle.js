(function (root, factory) {
    "use strict";

    const api = factory();
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasPlatform = Object.assign(root.APStudyCanvasPlatform || {}, { CanvasSyncCycle: api });
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const CONTRACT_VERSION = 1;
    const EXTRACT_TYPE = "CANVAS_SYNC_EXTRACT_INTERNAL";
    const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
    const SAFE_CODE = /^[A-Za-z][A-Za-z0-9_:-]{0,63}$/;
    const UNSAFE = /TOKEN|COOKIE|CSRF|SECRET|PASSWORD|PROVIDER|TAB|WINDOW|URL|RAW|EVENT|TITLE|DESCRIPTION|LEASE/i;
    const MAX_RESUME_DELAY = 300000;
    const MIN_RESUME_DELAY = 250;

    function isPlainObject(value) {
        if (!value || typeof value !== "object" || Array.isArray(value)) return false;
        const prototype = Object.getPrototypeOf(value);
        return prototype === Object.prototype || prototype === null;
    }

    function pick(value, ...keys) {
        if (!value || typeof value !== "object") return undefined;
        for (const key of keys) if (value[key] !== undefined) return value[key];
        return undefined;
    }

    function safeCode(value, fallback) {
        return typeof value === "string" && SAFE_CODE.test(value) && !UNSAFE.test(value) ? value : fallback;
    }

    function safeId(value, fallback) {
        return typeof value === "string" && SAFE_ID.test(value) && !UNSAFE.test(value) ? value : fallback;
    }

    function safeCount(value) {
        return Number.isSafeInteger(value) && value >= 0 ? value : null;
    }

    function userId(value) {
        if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
        return typeof value === "string" && value.length > 0 && value.length <= 256 ? value : null;
    }

    function origin(value) {
        if (typeof value !== "string") return null;
        try {
            const parsed = new URL(value);
            if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) return null;
            return value === parsed.origin ? value : null;
        } catch (error) {
            return null;
        }
    }

    function normalizeBinding(input) {
        if (!isPlainObject(input)) return null;
        const accountKey = pick(input, "accountKey", "account_key", "account");
        const sourceId = pick(input, "sourceId", "source_id", "source");
        const runId = pick(input, "runId", "run_id", "run");
        const canvasUserId = pick(input, "canvasUserId", "userId", "user_id", "user");
        const consentVersion = pick(input, "consentVersion", "consent_version");
        const scope = pick(input, "scope", "scopeValue", "scope_value");
        const descriptors = pick(input, "descriptors", "registeredDescriptors", "registered_descriptors");
        if (typeof accountKey !== "string" || !accountKey || typeof sourceId !== "string" || !sourceId
            || typeof runId !== "string" || !runId || !origin(input.origin) || userId(canvasUserId) === null
            || typeof consentVersion !== "string" || !consentVersion || !isPlainObject(scope)
            || !Array.isArray(descriptors) || descriptors.length === 0 || !Number.isSafeInteger(input.generation) || input.generation <= 0) return null;
        return Object.freeze({ accountKey, sourceId, runId, origin: input.origin, canvasUserId, consentVersion, scope, descriptors, generation: input.generation });
    }

    function bindingMatchesSession(binding, session) {
        if (!isPlainObject(session)) return false;
        const account = pick(session, "accountKey", "account_key", "account");
        const sessionOrigin = session.origin;
        const sessionUser = pick(session, "canvasUserId", "canvas_user_id", "userId", "user_id", "user", "providerUserId", "provider_user_id");
        if (account === undefined || sessionOrigin === undefined || sessionUser === undefined) return false;
        return String(account) === String(binding.accountKey)
            && sessionOrigin === binding.origin
            && String(sessionUser) === String(binding.canvasUserId);
    }

    function summaryMatches(binding, summary) {
        if (!isPlainObject(summary?.binding)) return true;
        const candidate = summary.binding;
        const account = pick(candidate, "accountKey", "account_key", "account");
        const source = pick(candidate, "sourceId", "source_id", "source");
        const run = pick(candidate, "runId", "run_id", "run");
        const generation = candidate.generation;
        const user = pick(candidate, "canvasUserId", "userId", "user_id", "user");
        return (account === undefined || String(account) === String(binding.accountKey))
            && (source === undefined || String(source) === String(binding.sourceId))
            && (run === undefined || String(run) === String(binding.runId))
            && (generation === undefined || generation === binding.generation)
            && (user === undefined || String(user) === String(binding.canvasUserId));
    }

    function namespace(binding) {
        return { account: binding.accountKey, source: binding.sourceId, run: binding.runId, generation: binding.generation };
    }

    function sessionTabId(session) {
        const value = session?.tab?.id ?? session?.id ?? session?.tabId;
        return Number.isSafeInteger(value) && value >= 0 ? value : null;
    }

    function safeDelay(value) {
        const number = typeof value === "number" ? value : Number(value);
        if (!Number.isFinite(number)) return 1000;
        return Math.max(MIN_RESUME_DELAY, Math.min(MAX_RESUME_DELAY, Math.floor(number)));
    }

    function safeState(value, fallback = "failed") {
        return typeof value === "string" && SAFE_CODE.test(value) && !UNSAFE.test(value) ? value : fallback;
    }

    function counts(pending, queued) {
        return { pending: safeCount(pending) ?? 0, queued: safeCount(queued) ?? 0 };
    }

    function output(state, pending, queued, errorCode, correlation) {
        const result = { state: safeState(state), counts: counts(pending, queued), errorCode: errorCode ? safeCode(errorCode, "SYNC_CYCLE_FAILED") : null };
        if (correlation) result.correlation = safeId(correlation, "cycle");
        return result;
    }

    function resultState(value) {
        const state = value?.state;
        if (state === "waiting" || state === "unsupported") return "waiting";
        if (state === "mismatch") return "failed";
        if (state === "partial") return "partial";
        if (state === "complete") return "running";
        if (state === "error" || state === "failed") return "partial";
        return "running";
    }

    function extractionResult(response, requestId) {
        let value = response;
        if (isPlainObject(value) && Object.prototype.hasOwnProperty.call(value, "payload")) {
            if (value.request_id !== undefined && value.request_id !== requestId) return { error: "extraction_malformed" };
            value = value.payload;
        }
        if (isPlainObject(value) && !Array.isArray(value.batches) && isPlainObject(value.result)) value = value.result;
        if (!isPlainObject(value) || !Array.isArray(value.batches)
            || !Number.isSafeInteger(value.descriptorProgress) || value.descriptorProgress < 0
            || !Number.isSafeInteger(value.quarantineCount) || value.quarantineCount < 0
            || (value.checkpointHash !== null && typeof value.checkpointHash !== "string")
            || typeof value.complete !== "boolean") return { error: "extraction_malformed" };
        const state = value.state === undefined ? (value.complete ? "complete" : "partial") : safeState(value.state, "malformed");
        if (state === "malformed") return { error: "extraction_malformed" };
        if (state === "mismatch") return { state: "failed", error: "binding_mismatch" };
        if (state === "waiting" || state === "unsupported") return { state: "waiting", error: safeCode(value.errorCode || value.code, "canvas_session_waiting") };
        return {
            state: state === "partial" || state === "error" || state === "failed" ? "partial" : "complete",
            result: {
                batches: value.batches,
                descriptorProgress: value.descriptorProgress,
                quarantineCount: value.quarantineCount,
                checkpointHash: value.checkpointHash ?? null,
                complete: value.complete
            }
        };
    }

    function hasDescriptorProgress(value) {
        if (!value || typeof value !== "object") return false;
        if (Number.isSafeInteger(value.descriptorProgress) && value.descriptorProgress > 0) return true;
        const progress = value.progress;
        return isPlainObject(progress) && Object.keys(progress).length > 0;
    }

    function extractionComplete(summary) {
        return summary?.extractionComplete === true || summary?.extraction_complete === true;
    }

    function shouldResume(value) {
        if (!value || value.state === "paused" || value.state === "exhausted" || value.exhausted === true || value.paused === true) return false;
        const code = String(value.code || value.errorCode || "").toLowerCase();
        return value.state === "queued" || value.state === "retry" || value.more === true || value.retry === true || code.includes("retry");
    }

    function retryDelay(value) {
        return safeDelay(value?.retryAfterMs ?? value?.retry_after_ms ?? value?.delayMs ?? value?.delay_ms
            ?? value?.retry?.delayMs ?? value?.retry?.delay_ms);
    }

    function createCanvasSyncCycle({ getFeatureFlags, resolveCanvasSession, requestExtraction, extractStage, uploader, finalizer, outbox, scheduleResume, idFactory } = {}) {
        function enabled() {
            try {
                const flags = typeof getFeatureFlags === "function" ? getFeatureFlags() : getFeatureFlags;
                return flags?.upload === true;
            } catch (error) {
                return false;
            }
        }

        function makeCorrelation(binding) {
            let value;
            try {
                if (typeof idFactory === "function") value = idFactory("canvas-sync-cycle");
                else if (idFactory && typeof idFactory.create === "function") value = idFactory.create("canvas-sync-cycle");
            } catch (error) {
                value = undefined;
            }
            return safeId(value, safeId(binding?.requestId, "cycle"));
        }

        async function runCycle({ binding, runSummary } = {}) {
            if (!enabled()) return { state: "idle", errorCode: "feature_disabled" };

            const normalized = normalizeBinding(binding);
            if (!normalized) return output("failed", 0, 0, "invalid_binding");
            if (!summaryMatches(normalized, runSummary)) return output("failed", 0, 0, "binding_mismatch", makeCorrelation(binding));
            const correlation = makeCorrelation(binding);
            const exactNamespace = namespace(normalized);
            let pending = 0;
            let queued = 0;
            let scheduled = false;
            let extractionWasPartial = false;
            let extractionHasProgress = false;

            const schedule = async (uploadResult) => {
                if (scheduled || typeof scheduleResume !== "function" || !shouldResume(uploadResult)) return null;
                scheduled = true;
                try {
                    await scheduleResume({ delayMs: retryDelay(uploadResult), reason: "upload" });
                    return null;
                } catch (error) {
                    return "resume_schedule_failed";
                }
            };

            let session;
            try {
                if (typeof resolveCanvasSession !== "function") return output("waiting", 0, 0, "session_unavailable", correlation);
                session = await resolveCanvasSession(binding);
            } catch (error) {
                return output("waiting", 0, 0, "session_unavailable", correlation);
            }
            if (session === null || session === undefined) return output("waiting", 0, 0, null, correlation);
            if (!bindingMatchesSession(normalized, session)) return output("failed", 0, 0, "binding_mismatch", correlation);
            const tabId = sessionTabId(session);
            if (tabId === null) return output("waiting", 0, 0, "session_unavailable", correlation);

            try {
                if (typeof outbox?.pendingCount !== "function" || typeof outbox?.currentGeneration !== "function") throw new Error("dependency_unavailable");
                pending = await outbox.pendingCount(exactNamespace);
                if (!Number.isSafeInteger(pending) || pending < 0) throw new Error("count_invalid");

                let uploadResult = null;
                if (pending > 0) {
                    if (typeof uploader?.uploadNext !== "function") throw new Error("dependency_unavailable");
                    uploadResult = await uploader.uploadNext({ enabled: true, binding });
                } else if (!extractionComplete(runSummary)) {
                    const before = await outbox.currentGeneration(exactNamespace);
                    if (before !== normalized.generation) return output("failed", pending, queued, "stale_generation", correlation);
                    if (typeof requestExtraction !== "function") throw new Error("dependency_unavailable");
                    const envelope = {
                        contract_version: CONTRACT_VERSION,
                        request_id: correlation,
                        type: EXTRACT_TYPE,
                        payload: {
                            expectedOrigin: normalized.origin,
                            canvasUserId: normalized.canvasUserId,
                            accountKey: normalized.accountKey,
                            sourceId: normalized.sourceId,
                            runId: normalized.runId,
                            generation: normalized.generation,
                            consentVersion: normalized.consentVersion,
                            scope: normalized.scope,
                            descriptors: normalized.descriptors,
                            checkpoint: runSummary?.checkpoint ?? runSummary?.checkpointValue ?? null
                        }
                    };
                    let extracted;
                    try {
                        extracted = extractionResult(await requestExtraction(tabId, envelope), correlation);
                    } catch (error) {
                        return output("waiting", pending, queued, "canvas_session_waiting", correlation);
                    }
                    if (extracted.error) return output("partial", pending, queued, extracted.error, correlation);
                    if (extracted.state === "waiting" || extracted.state === "failed") return output(extracted.state === "failed" ? "failed" : "waiting", pending, queued, extracted.error, correlation);
                    extractionHasProgress = extracted.result.descriptorProgress > 0;
                    const afterExtraction = await outbox.currentGeneration(exactNamespace);
                    if (afterExtraction !== normalized.generation) return output("failed", pending, queued, "stale_generation", correlation);
                    if (typeof extractStage?.queueResult !== "function") throw new Error("dependency_unavailable");
                    const staged = await extractStage.queueResult({ enabled: true, binding, result: extracted.result });
                    queued = safeCount(staged?.queued) ?? 0;
                    extractionWasPartial = extracted.state === "partial" || staged?.state === "error" || staged?.state === "paused" || staged?.state === "superseded";
                    if (staged?.state === "superseded") return output("failed", pending, queued, "stale_generation", correlation);
                    if (staged?.state === "error") return output("partial", pending, queued, safeCode(staged.errorCode, "stage_failed"), correlation);
                    if (staged?.state === "paused") return output("paused", pending, queued, "outbox_paused", correlation);
                    pending = await outbox.pendingCount(exactNamespace);
                    if (!Number.isSafeInteger(pending) || pending < 0) throw new Error("count_invalid");
                    if (pending > 0) {
                        if (typeof uploader?.uploadNext !== "function") throw new Error("dependency_unavailable");
                        uploadResult = await uploader.uploadNext({ enabled: true, binding });
                    }
                }

                if (uploadResult) {
                    const afterUpload = await outbox.currentGeneration(exactNamespace);
                    if (afterUpload !== normalized.generation) return output("failed", pending, queued, "stale_generation", correlation);
                    const scheduleError = await schedule(uploadResult);
                    pending = await outbox.pendingCount(exactNamespace);
                    if (!Number.isSafeInteger(pending) || pending < 0) throw new Error("count_invalid");
                    if (scheduleError) return output("partial", pending, queued, scheduleError, correlation);
                    if (uploadResult.state === "paused" || uploadResult.state === "exhausted" || uploadResult.exhausted === true) return output("paused", pending, queued, "retry_exhausted", correlation);
                }

                if (pending === 0) pending = await outbox.pendingCount(exactNamespace);
                if (!Number.isSafeInteger(pending) || pending < 0) throw new Error("count_invalid");
                if (pending > 0) return output("running", pending, queued, null, correlation);
                if (extractionWasPartial || (!extractionHasProgress && !hasDescriptorProgress(runSummary))) return output(extractionWasPartial ? "partial" : "running", pending, queued, null, correlation);

                const beforeFinalizer = await outbox.currentGeneration(exactNamespace);
                if (beforeFinalizer !== normalized.generation) return output("failed", pending, queued, "stale_generation", correlation);
                if (typeof finalizer?.finalizeIfReady !== "function") throw new Error("dependency_unavailable");
                const finalized = await finalizer.finalizeIfReady({ enabled: true, binding, runSummary, requestId: correlation });
                return output(safeState(finalized?.state, "partial"), pending, queued, finalized?.errorCode ?? finalized?.code ?? null, correlation);
            } catch (error) {
                const code = safeCode(error?.code || error?.message, "cycle_dependency_failed");
                return output(code === "count_invalid" ? "partial" : "failed", pending, queued, code, correlation);
            }
        }

        return Object.freeze({ runCycle });
    }

    return Object.freeze({ createCanvasSyncCycle });
}));
