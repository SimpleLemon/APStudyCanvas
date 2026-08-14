(function (root, factory) {
    "use strict";
    const adapter = root?.APStudyCanvasCanvasAdapter || {};
    const api = factory(
        adapter.Identity,
        adapter.Contracts,
        adapter.Normalizers,
        adapter.Pagination,
        adapter.Batch,
        adapter.Protocol
    );
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasCanvasAdapter = Object.assign(root.APStudyCanvasCanvasAdapter || {}, { Extractor: api });
}(typeof globalThis !== "undefined" ? globalThis : this, function (identity, contracts, normalizers, pagination, batch, protocol) {
    "use strict";

    const VERSION = 1;
    // Keep the content-to-worker handoff below the worker's narrow Nest batch
    // allowance. The server still accepts its documented 512 KiB maximum;
    // this smaller limit leaves room for the exact snake_case upload envelope.
    const UPLOAD_BATCH_BYTES = 48 * 1024;
    const UPLOAD_BATCH_ITEMS = 80;
    const MAX_TYPES = 8;
    const MAX_CONTEXTS = 1000;
    const MAX_PLAN_KEYS = 2000;
    const SUPPORTED_TYPES = new Set(["assignment", "quiz", "discussion_topic", "planner_note", "calendar_event"]);
    const COURSE_TYPES = new Set(["assignment", "quiz", "discussion_topic"]);
    // No current worker/coordinator is authorized to construct an extractor.
    // Keeping the capability private makes the content-facing factory inert
    // until an explicitly internal caller is implemented in a later phase.
    const INTERNAL_FACTORY_TOKEN = {};

    function clone(value) {
        if (value === undefined) return undefined;
        if (typeof structuredClone === "function") return structuredClone(value);
        return JSON.parse(JSON.stringify(value));
    }

    function isPlainObject(value) {
        if (!value || typeof value !== "object" || Array.isArray(value)) return false;
        const prototype = Object.getPrototypeOf(value);
        return prototype === Object.prototype || prototype === null;
    }

    function text(value, max = 256) {
        if (typeof value !== "string" && typeof value !== "number") return null;
        const result = String(value).trim();
        if (!result || result.length > max || /[\u0000-\u001f\u007f]/.test(result)) return null;
        return result;
    }

    function id(value) {
        const result = text(value, 128);
        return result && /^[1-9]\d{0,19}$/.test(result) ? result : null;
    }

    function safeTypes(value) {
        const requested = value === undefined ? Array.from(SUPPORTED_TYPES) : Array.isArray(value) ? value : [];
        const accepted = [];
        const disabled = [];
        for (const raw of requested.slice(0, MAX_TYPES)) {
            const type = text(raw, 64);
            if (!type || !SUPPORTED_TYPES.has(type)) {
                if (type) disabled.push({ type, code: "CANVAS_ITEM_TYPE_UNSUPPORTED" });
                continue;
            }
            if (!accepted.includes(type)) accepted.push(type);
        }
        return { accepted, disabled };
    }

    function safeContexts(value) {
        if (value === undefined) return [];
        if (!Array.isArray(value)) return null;
        const result = [];
        for (const raw of value.slice(0, MAX_CONTEXTS)) {
            const candidate = id(raw);
            if (!candidate) return null;
            if (!result.includes(candidate)) result.push(candidate);
        }
        return result;
    }

    function safeContextCodes(value) {
        if (value === undefined) return [];
        if (!Array.isArray(value)) return null;
        const result = [];
        for (const raw of value.slice(0, MAX_CONTEXTS)) {
            const candidate = text(raw, 256);
            if (!candidate || !/^(?:course|group|user|account)_[1-9]\d{0,19}$/.test(candidate)) return null;
            if (!result.includes(candidate)) result.push(candidate);
        }
        return result;
    }

    function safeLowerBound(value) {
        if (value === undefined || value === null) return null;
        if (!isPlainObject(value) || value.verified !== true) return null;
        const candidate = text(value.value ?? value.date ?? value.lowerBound, 128);
        if (!candidate || !Number.isFinite(Date.parse(candidate))) return null;
        const source = text(value.source || "verified", 128);
        if (!source) return null;
        return { value: candidate, verified: true, source };
    }

    function safeLowerBounds(value) {
        if (value === undefined) return {};
        if (!isPlainObject(value)) return null;
        const result = {};
        for (const type of ["planner_note", "calendar_event"]) {
            if (value[type] !== undefined) {
                const lower = safeLowerBound(value[type]);
                if (!lower) return null;
                result[type] = lower;
            }
        }
        return result;
    }

    function safeScope(payload = {}) {
        if (!isPlainObject(payload)) return { ok: false, code: "CANVAS_SCOPE_INVALID" };
        const types = safeTypes(payload.types);
        const contexts = safeContexts(payload.context_ids ?? payload.contextIds);
        const contextCodes = safeContextCodes(payload.context_codes ?? payload.contextCodes);
        const lowerBounds = safeLowerBounds(payload.lower_bounds ?? payload.lowerBounds);
        if (!contexts || !contextCodes || !lowerBounds) return { ok: false, code: "CANVAS_SCOPE_INVALID" };
        const windowDays = payload.window_days ?? payload.windowDays;
        const normalizedWindowDays = windowDays === undefined ? 30 : Number(windowDays);
        if (!Number.isInteger(normalizedWindowDays) || normalizedWindowDays < 1 || normalizedWindowDays > 3660) return { ok: false, code: "CANVAS_DATE_WINDOW_SIZE_INVALID" };
        const disabled = types.disabled.slice();
        const enabledTypes = types.accepted.filter((type) => {
            if (COURSE_TYPES.has(type) && contexts.length === 0) {
                disabled.push({ type, code: "CANVAS_CONTEXT_SCOPE_REQUIRED" });
                return false;
            }
            return true;
        });
        return {
            ok: true,
            types: enabledTypes,
            disabled,
            contexts,
            contextCodes,
            lowerBounds,
            windowDays: normalizedWindowDays,
            dateOnlyMode: payload.date_only_mode === true || payload.dateOnlyMode === true
        };
    }

    function planKey(type, contextId = "all") {
        return `${type}:${contextId || "all"}`;
    }

    function resultState(result) {
        return result?.state === "complete" ? "complete" : result?.state || "partial";
    }

    function errorResult(state, code, extra = {}) {
        return { ok: false, state, code, ...extra };
    }

    function responseHeaders(response) {
        const headers = response?.headers;
        if (!headers) return {};
        if (typeof headers.get === "function") return headers;
        const result = {};
        Object.entries(headers).forEach(([key, value]) => { result[String(key).toLowerCase()] = String(value); });
        return result;
    }

    function makeHttpError(response) {
        const error = new Error(`CANVAS_HTTP_${Number(response?.status || 0)}`);
        error.status = Number(response?.status || 0);
        error.headers = responseHeaders(response);
        return error;
    }

    function normalizeBatchItem(item) {
        if (!isPlainObject(item)) return null;
        const source = item.source || {};
        const identitySource = {
            context: source.contextId,
            calendar: source.calendarId,
            remote: source.id,
            occurrence: source.occurrenceId,
            item_key: source.key,
            ...(source.url ? { url: source.url } : {}),
            ...(source.timezone ? { timezone: source.timezone } : {}),
            ...(source.offset ? { offset: source.offset } : {})
        };
        const normalizedSource = Object.fromEntries(Object.entries(identitySource).filter(([, value]) => value !== undefined && value !== null));
        const normalizedPayload = { ...(item.payload || {}) };
        if (item.completion !== undefined && normalizedPayload.completion === undefined) {
            normalizedPayload.completion = item.completion;
        }
        // Descriptions and source URLs stay in the tab and are deliberately not
        // staged in the bounded extension outbox. The Nest projection receives
        // the validated source URL separately when the worker uploads.
        delete normalizedPayload.description;
        delete normalizedPayload.url;
        if (normalizedPayload.recurrence?.seriesId !== undefined && normalizedPayload.recurrence?.seriesHash === undefined) {
            normalizedPayload.recurrence = {
                ...normalizedPayload.recurrence,
                seriesHash: identity?.sha256HexSync?.(String(normalizedPayload.recurrence.seriesId)) || String(normalizedPayload.recurrence.seriesId)
            };
            delete normalizedPayload.recurrence.seriesId;
        }
        return {
            schemaVersion: item.schemaVersion,
            eventRef: item.eventRef,
            source: {
                type: source.type,
                accountKey: source.accountKey,
                payloadHash: source.payloadHash,
                revision: source.revision,
                identity: normalizedSource
            },
            payload: normalizedPayload
        };
    }

    function createExtractor({
        window: win = globalThis.window,
        contextService,
        fetchImpl = globalThis.fetch,
        runtime = globalThis.chrome?.runtime,
        now = () => Date.now(),
        random = Math.random,
        wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
        internalToken = null
    } = {}) {
        if (internalToken !== INTERNAL_FACTORY_TOKEN) return null;
        let active = null;

        function origin() {
            return identity?.normalizeCanvasOrigin?.(win?.location?.origin || "") || null;
        }

        async function verify(expectedOrigin, expectedUserId) {
            if (!contextService?.verifyAccount) return errorResult("waiting", "CANVAS_ACCOUNT_VERIFICATION_WAITING");
            const result = await contextService.verifyAccount({ expectedOrigin, expectedUserId });
            if (!result?.ok || result.state !== "verified") return result || errorResult("waiting", "CANVAS_ACCOUNT_VERIFICATION_WAITING");
            if (result.origin !== expectedOrigin || String(result.userId) !== String(expectedUserId)) return errorResult("mismatch", "CANVAS_ACCOUNT_MISMATCH");
            return result;
        }

        function sendInternal(type, payload, requestId) {
            if (!runtime?.sendMessage) return Promise.resolve({ ok: false, code: "CANVAS_WORKER_UNAVAILABLE" });
            let envelope;
            try { envelope = protocol.createEnvelope(type, payload, requestId); }
            catch (error) { return Promise.resolve({ ok: false, code: error.message || "INTERNAL_MESSAGE_INVALID" }); }
            return new Promise((resolve) => {
                let settled = false;
                const finish = (value) => {
                    if (settled) return;
                    settled = true;
                    resolve(isPlainObject(value) ? value : { ok: false, code: "CANVAS_WORKER_RESPONSE_INVALID" });
                };
                try {
                    const pending = runtime.sendMessage(envelope, finish);
                    if (pending?.then) pending.then(finish).catch(() => finish({ ok: false, code: "CANVAS_WORKER_UNAVAILABLE" }));
                } catch (error) { finish({ ok: false, code: "CANVAS_WORKER_UNAVAILABLE" }); }
                setTimeout(() => finish({ ok: false, code: "CANVAS_WORKER_TIMEOUT" }), 10000);
            });
        }

        function pageFetch(expectedOrigin, expectedUserId, run) {
            return async (url) => {
                if (run.cancelled) {
                    const error = new Error("CANVAS_SYNC_CANCELLED");
                    error.aborted = true;
                    error.code = "CANVAS_SYNC_CANCELLED";
                    throw error;
                }
                const checkedOrigin = identity?.normalizeCanvasOrigin?.(expectedOrigin);
                let target;
                try { target = new URL(String(url)); } catch (error) { throw Object.assign(new Error("CANVAS_LINK_URL_INVALID"), { code: "CANVAS_LINK_URL_INVALID" }); }
                if (!checkedOrigin || target.origin !== checkedOrigin || target.protocol !== "https:" || !/^\/api\/v1(?:\/|$)/.test(target.pathname) || target.username || target.password || target.hash) {
                    throw Object.assign(new Error("CANVAS_LINK_ORIGIN_INVALID"), { code: "CANVAS_LINK_ORIGIN_INVALID" });
                }
                if (typeof fetchImpl !== "function") throw Object.assign(new Error("CANVAS_FETCH_UNAVAILABLE"), { code: "CANVAS_FETCH_UNAVAILABLE", offline: true });
                const response = await fetchImpl(target.href, {
                    method: "GET",
                    credentials: "include",
                    headers: { Accept: "application/json" }
                });
                if (!response?.ok) throw makeHttpError(response);
                let payload;
                try { payload = await response.json(); }
                catch (error) { throw Object.assign(new Error("CANVAS_PAYLOAD_MALFORMED"), { code: "CANVAS_PAYLOAD_MALFORMED" }); }
                if (!Array.isArray(payload)) throw Object.assign(new Error("CANVAS_PAYLOAD_MALFORMED"), { code: "CANVAS_PAYLOAD_MALFORMED" });
                return { status: response.status, headers: responseHeaders(response), data: payload };
            };
        }

        async function emitCheckpoint(run, planKeyValue, checkpoint, progress) {
            const response = await sendInternal("CANVAS_EXTRACT_PROGRESS", {
                source_id: run.sourceId,
                run_id: run.runId,
                generation: run.generation,
                account_hash: run.accountKey,
                plan_key: planKeyValue,
                checkpoint: clone(checkpoint),
                progress: clone(progress)
            }, run.requestId);
            if (response?.ok === false && response.code === "CANVAS_SYNC_GENERATION_SUPERSEDED") {
                run.cancelled = true;
                return response;
            }
            return response;
        }

        async function emitBatch(run, planKeyValue, items, partial, checkpoint) {
            const prepared = items.map(normalizeBatchItem).filter(Boolean);
            const built = batch.buildBatches(prepared, { maxItems: UPLOAD_BATCH_ITEMS, maxBytes: UPLOAD_BATCH_BYTES });
            if (!built.ok) return built;
            let sent = 0;
            for (const next of built.batches) {
                if (run.cancelled) return errorResult("partial", "CANVAS_SYNC_CANCELLED", { sent });
                const response = await sendInternal("CANVAS_EXTRACT_BATCH", {
                    source_id: run.sourceId,
                    run_id: run.runId,
                    generation: run.generation,
                    account_hash: run.accountKey,
                    plan_key: planKeyValue,
                    batch_index: run.nextBatchIndex,
                    batch_count: built.batches.length,
                    partial: Boolean(partial),
                    checksum: next.checksum,
                    item_count: next.item_count,
                    checkpoint: clone(checkpoint),
                    items: next.items
                }, run.requestId);
                if (!response?.ok) return errorResult("partial", response?.code || "CANVAS_BATCH_QUEUE_FAILED", { sent });
                sent += 1;
                run.nextBatchIndex += 1;
            }
            return { ok: true, sent, quarantined: built.quarantined_count || 0 };
        }

        function planOptions(run, scope, type, contextId, checkpoint) {
            const contextCodes = scope.contextCodes.length ? scope.contextCodes : scope.contexts.map((value) => `course_${value}`);
            const options = {
                type,
                origin: run.origin,
                userId: run.userId,
                contextId: contextId || undefined,
                scope: {},
                filter: {},
                query: type === "calendar_event" && contextCodes.length ? { "context_codes[]": contextCodes } : {},
                generation: run.generation,
                consentVersion: run.consentVersion,
                perPage: 100,
                windowDays: scope.windowDays,
                dateOnlyMode: scope.dateOnlyMode,
                correlation: `${run.runId}:${type}:${contextId || "all"}`
            };
            if (type === "planner_note" || type === "calendar_event") options.lowerBound = scope.lowerBounds[type];
            if (checkpoint) options.resumeCheckpoint = clone(checkpoint);
            return options;
        }

        async function run(request) {
            if (!isPlainObject(request)) return errorResult("unsupported", "CANVAS_EXTRACT_REQUEST_INVALID");
            const payload = request.payload || {};
            const expectedOrigin = identity?.normalizeCanvasOrigin?.(payload.origin);
            const expectedUserId = identity?.normalizeUserId?.(payload.user_id ?? payload.userId);
            if (!expectedOrigin || !expectedUserId) return errorResult("waiting", "CANVAS_ACCOUNT_EXPECTED_INVALID");
            if (origin() !== expectedOrigin) return errorResult("mismatch", "CANVAS_ORIGIN_MISMATCH");
            const scope = safeScope(payload.scope || payload);
            if (!scope.ok && scope.state !== "partial") return scope;
            if (scope.accepted?.length > MAX_TYPES || scope.contexts?.length > MAX_CONTEXTS) return errorResult("unsupported", "CANVAS_SCOPE_TOO_LARGE");
            const run = {
                requestId: request.request_id,
                sourceId: text(payload.source_id, 160),
                runId: text(payload.run_id, 160),
                generation: Number.isSafeInteger(payload.generation) && payload.generation >= 0 ? payload.generation : -1,
                consentVersion: text(payload.consent_version ?? payload.consentVersion, 128),
                origin: expectedOrigin,
                userId: expectedUserId,
                accountKey: null,
                cancelled: false,
                nextBatchIndex: 0
            };
            if (!run.sourceId || !run.runId || run.generation < 0 || !run.consentVersion) return errorResult("unsupported", "CANVAS_EXTRACT_REQUEST_INVALID");
            const verified = await verify(expectedOrigin, expectedUserId);
            if (!verified?.ok) return verified || errorResult("waiting", "CANVAS_ACCOUNT_VERIFICATION_WAITING");
            run.accountKey = await identity.accountKey({ origin: expectedOrigin, userId: expectedUserId });
            if (!run.accountKey) return errorResult("waiting", "CANVAS_ACCOUNT_KEY_UNAVAILABLE");
            if (payload.account_hash && String(payload.account_hash).toLowerCase() !== run.accountKey.toLowerCase()) return errorResult("mismatch", "CANVAS_ACCOUNT_MISMATCH");
            active = run;

            const checkpoints = isPlainObject(payload.checkpoints) ? payload.checkpoints : {};
            const planResults = [];
            let totalBatches = 0;
            let totalQuarantined = 0;
            const plans = [];
            for (const type of scope.types || []) {
                if (COURSE_TYPES.has(type)) {
                    for (const contextId of scope.contexts) plans.push({ type, contextId });
                } else plans.push({ type, contextId: "all" });
            }
            if (plans.length > MAX_PLAN_KEYS) return errorResult("unsupported", "CANVAS_SCOPE_TOO_LARGE");
            if (!plans.length) return errorResult("partial", "CANVAS_NO_ENABLED_TYPES", { disabled: scope.disabled || [] });

            for (const descriptor of plans) {
                if (run.cancelled) break;
                const key = planKey(descriptor.type, descriptor.contextId);
                const checkpoint = checkpoints[key];
                const options = planOptions(run, scope, descriptor.type, descriptor.contextId === "all" ? null : descriptor.contextId, checkpoint);
                const plan = pagination.buildFullHistoryPlan(options);
                if (!plan?.ok) {
                    planResults.push({ plan_key: key, type: descriptor.type, context_id: descriptor.contextId, state: plan?.state || "partial", code: plan?.code || "CANVAS_PLAN_UNAVAILABLE", tombstone_eligible: false });
                    continue;
                }
                const pageStats = { normalized: 0, quarantined: 0, batches: 0, handoff: true };
                const history = await pagination.runPlan(plan, {
                    resumeCheckpoint: checkpoint,
                    generation: run.generation,
                    consentVersion: run.consentVersion,
                    fetchPage: pageFetch(expectedOrigin, expectedUserId, run),
                    collectItems: false,
                    onPage: async (rawItems, pageInfo) => {
                        const normalized = [];
                        for (const raw of Array.isArray(rawItems) ? rawItems : []) {
                            const normalizedResult = await normalizers.normalizeCanvasItem(descriptor.type, raw, {
                                origin: expectedOrigin,
                                userId: expectedUserId,
                                allowedSourceOrigins: [expectedOrigin]
                            });
                            if (!normalizedResult?.ok || !Array.isArray(normalizedResult.items)) {
                                pageStats.quarantined += 1;
                                continue;
                            }
                            const safeItems = [];
                            for (const item of normalizedResult.items) {
                                if (normalizers.safeUploadObject && !await normalizers.safeUploadObject(item)) {
                                    pageStats.quarantined += 1;
                                    continue;
                                }
                                safeItems.push(item);
                            }
                            normalized.push(...safeItems);
                            pageStats.quarantined += Array.isArray(normalizedResult.quarantined) ? normalizedResult.quarantined.length : 0;
                        }
                        pageStats.normalized += normalized.length;
                        const handoff = await emitBatch(run, key, normalized, false, pageInfo?.checkpoint);
                        pageStats.batches += Number(handoff?.sent || 0);
                        if (!handoff?.ok) {
                            pageStats.handoff = false;
                            run.cancelled = true;
                            return { ok: false, code: handoff?.code || "CANVAS_BATCH_QUEUE_FAILED" };
                        }
                        pageStats.quarantined += Number(handoff?.quarantined || 0);
                        return { ok: true };
                    },
                    revalidateCurrentContext: async () => {
                        if (run.cancelled) return { ok: false, state: "mismatch", code: "CANVAS_SYNC_CANCELLED" };
                        return verify(expectedOrigin, expectedUserId);
                    },
                    saveCheckpoint: (next) => emitCheckpoint(run, key, next, { state: "checkpoint", count: next?.counters?.items || 0, correlation_hash: pagination.makeProgress("checkpoint", next?.counters, now(), now, null, `${run.runId}:${key}`).correlation_hash }),
                    wait,
                    random,
                    clock: now
                });
                totalBatches += pageStats.batches;
                totalQuarantined += pageStats.quarantined;
                planResults.push({
                    plan_key: key,
                    type: descriptor.type,
                    context_id: descriptor.contextId,
                    state: resultState(history),
                    code: history?.code || null,
                    normalized: pageStats.normalized,
                    quarantined: pageStats.quarantined,
                    batches: pageStats.batches,
                    checkpoint: clone(history?.checkpoint),
                    progress: clone(history?.progress),
                    tombstone_eligible: Boolean(history?.tombstone_eligible && history?.gate_valid && pageStats.handoff)
                });
            }
            const complete = !run.cancelled && planResults.length === plans.length && planResults.every((item) => item.state === "complete" && item.tombstone_eligible);
            const state = run.cancelled ? "partial" : complete ? "complete" : "partial";
            const result = {
                ok: complete,
                state,
                source_id: run.sourceId,
                run_id: run.runId,
                generation: run.generation,
                account_hash: run.accountKey,
                plans: planResults,
                counts: {
                    plans: planResults.length,
                    batches: totalBatches,
                    quarantined: totalQuarantined,
                    normalized: planResults.reduce((sum, item) => sum + Number(item.normalized || 0), 0)
                },
                tombstone_eligible: complete,
                ...(scope.disabled?.length ? { disabled: scope.disabled } : {})
            };
            active = null;
            return result;
        }

        async function handle(message) {
            const validation = protocol.validateEnvelope(message);
            if (!validation.ok) return { ok: false, state: "unsupported", code: validation.code };
            const envelope = validation.value;
            if (envelope.type === "CANVAS_EXTRACT_RUN") return run(envelope);
            if (envelope.type === "CANVAS_EXTRACT_CANCEL") {
                if (active && (!envelope.payload.run_id || envelope.payload.run_id === active.runId)) {
                    active.cancelled = true;
                    return { ok: true, state: "cancelling", run_id: active.runId };
                }
                return { ok: true, state: "idle" };
            }
            if (envelope.type === "CANVAS_EXTRACT_STATUS") return { ok: true, state: active ? "running" : "idle", run_id: active?.runId || null };
            return { ok: false, state: "unsupported", code: "INTERNAL_TYPE_NOT_FOR_CONTENT" };
        }

        return Object.freeze({ handle, run, cancel: () => { if (active) active.cancelled = true; }, status: () => ({ ok: true, state: active ? "running" : "idle", run_id: active?.runId || null }), constants: Object.freeze({ VERSION, UPLOAD_BATCH_BYTES }) });
    }

    return Object.freeze({ VERSION, UPLOAD_BATCH_BYTES, UPLOAD_BATCH_ITEMS, createExtractor, safeScope, normalizeBatchItem });
}));
