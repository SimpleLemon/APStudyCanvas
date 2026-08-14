(function (root, factory) {
    "use strict";

    const api = factory();
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasContent = Object.assign(root.APStudyCanvasContent || {}, { SyncExtraction: api });
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const CONTRACT_VERSION = 1;
    const TYPE = "CANVAS_SYNC_EXTRACT_INTERNAL";
    const EXTRACTOR_TYPE = "CANVAS_EXTRACT_RUN";
    const MAX_REQUEST_ID = 160;
    const MAX_ITEMS = 80;
    const MAX_BYTES = 48 * 1024;
    const MAX_PAYLOAD_BYTES = MAX_BYTES;
    const MAX_DESCRIPTORS = 80;
    const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
    const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/+%:@-]{0,255}$/;
    const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
    const SAFE_KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,95}$/;
    const SECRET_KEY = /(?:access[_-]?token|refresh[_-]?token|id[_-]?token|oauth(?:2)?[_-]?token|authorization|bearer|password|passwd|secret|credential|api[_-]?key|client[_-]?secret|private|cookie|csrf|session|raw|response|wrapper)/i;
    const SECRET_VALUE = /(?:bearer\s+|(?:access|refresh|id|oauth|auth)[_-]?(?:token|key)\s*[:=]|(?:password|passwd|secret|credential|cookie|csrf|session)\s*[:=]|-----begin\s+(?:private|openpgp)\s+key)/i;
    const URL_VALUE = /^(?:https?|ftp|data):\/\//i;
    const PAYLOAD_KEYS = new Set([
        "expectedOrigin", "canvasUserId", "accountKey", "sourceId", "runId", "generation",
        "consentVersion", "scope", "descriptors", "checkpoint"
    ]);
    const BATCH_KEYS = new Set(["items", "checkpoint", "payloadHash", "payload_hash"]);

    function isPlainObject(value) {
        if (!value || typeof value !== "object" || Array.isArray(value)) return false;
        const prototype = Object.getPrototypeOf(value);
        return prototype === Object.prototype || prototype === null;
    }

    function hasOwn(value, key) {
        return Object.prototype.hasOwnProperty.call(value, key);
    }

    function bytes(value) {
        let serialized;
        try { serialized = typeof value === "string" ? value : JSON.stringify(value); }
        catch (error) { return Number.POSITIVE_INFINITY; }
        if (typeof TextEncoder === "function") return new TextEncoder().encode(serialized).length;
        try { return unescape(encodeURIComponent(serialized)).length; }
        catch (error) { return Number.POSITIVE_INFINITY; }
    }

    function failure(code, state = "unsupported") {
        return { ok: false, state, batches: [], descriptorProgress: 0, quarantineCount: 0, checkpointHash: null, complete: false, errorCode: code };
    }

    function safeErrorCode(value, fallback = "CANVAS_SYNC_EXTRACTION_FAILED") {
        return typeof value === "string" && ERROR_CODE.test(value) ? value : fallback;
    }

    function exactKeys(value, allowed) {
        return isPlainObject(value) && Object.keys(value).every((key) => allowed.has(key));
    }

    function safeClone(value, seen = new Set(), depth = 0) {
        if (depth > 8) throw new Error("unsafe_value");
        if (value === null || typeof value === "boolean") return value;
        if (typeof value === "string") {
            if (value.length > MAX_PAYLOAD_BYTES || /[\u0000-\u001f\u007f]/.test(value) || SECRET_VALUE.test(value) || URL_VALUE.test(value)) throw new Error("unsafe_value");
            return value;
        }
        if (typeof value === "number") {
            if (!Number.isFinite(value)) throw new Error("unsafe_value");
            return value;
        }
        if (!value || typeof value !== "object" || seen.has(value)) throw new Error("unsafe_value");
        seen.add(value);
        let output;
        if (Array.isArray(value)) {
            if (value.length > MAX_DESCRIPTORS * 4) throw new Error("unsafe_value");
            output = value.map((item) => safeClone(item, seen, depth + 1));
        } else {
            if (!isPlainObject(value)) throw new Error("unsafe_value");
            output = {};
            for (const key of Object.keys(value)) {
                if (!SAFE_KEY.test(key) || SECRET_KEY.test(key)) throw new Error("unsafe_value");
                output[key] = safeClone(value[key], seen, depth + 1);
            }
        }
        seen.delete(value);
        return output;
    }

    function normalizedOrigin(value) {
        if (typeof value !== "string") return null;
        try {
            const url = new URL(value.trim());
            if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
            if (url.pathname !== "" && url.pathname !== "/") return null;
            return url.origin;
        } catch (error) {
            return null;
        }
    }

    function normalizedText(value, max = 256) {
        return typeof value === "string" && value.length > 0 && value.length <= max
            && value === value.trim() && IDENTIFIER.test(value) && !SECRET_VALUE.test(value) ? value : null;
    }

    function senderIsOwnBackground(sender, runtimeId) {
        if (!isPlainObject(sender) || !normalizedText(runtimeId, 256) || sender.id !== runtimeId) return false;
        // A present tab field means the message is associated with a tab. Null
        // and undefined are both treated as present/ambiguous rather than as a
        // background proof.
        if (hasOwn(sender, "tab") || sender.tab !== undefined) return false;

        if (hasOwn(sender, "type")) {
            if (typeof sender.type !== "string" || !["background", "service_worker", "extension"].includes(sender.type)) return false;
        }
        const documentMarker = sender.documentId;
        for (const marker of [sender.type, documentMarker, sender.documentLifecycle]) {
            if (marker !== undefined && (typeof marker !== "string" || /(?:popup|options)/i.test(marker))) return false;
        }

        if (!hasOwn(sender, "url")) return true;
        if (typeof sender.url !== "string" || !sender.url) return false;
        let url;
        try { url = new URL(sender.url); }
        catch (error) { return false; }
        if (!["chrome-extension:", "moz-extension:"].includes(url.protocol) || url.hostname !== runtimeId) return false;
        if (/(?:^|[\\/])(?:popup|options)(?:\.[^\\/]*)?(?:$|[?#])/i.test(url.pathname)) return false;
        return true;
    }

    function validateEnvelope(message) {
        if (!isPlainObject(message)) return { ok: false, result: failure("CANVAS_SYNC_ENVELOPE_INVALID") };
        if (message.contract_version !== CONTRACT_VERSION) return { ok: false, result: failure("CANVAS_SYNC_VERSION_UNSUPPORTED") };
        if (typeof message.request_id !== "string" || message.request_id.length > MAX_REQUEST_ID || !REQUEST_ID.test(message.request_id)) {
            return { ok: false, result: failure("CANVAS_SYNC_REQUEST_ID_INVALID") };
        }
        if (message.type !== TYPE) return { ok: false, result: failure("CANVAS_SYNC_TYPE_UNSUPPORTED") };
        if (!isPlainObject(message.payload) || !exactKeys(message.payload, PAYLOAD_KEYS)) return { ok: false, result: failure("CANVAS_SYNC_PAYLOAD_INVALID") };
        if (Object.keys(message.payload).length !== PAYLOAD_KEYS.size || bytes(message.payload) > MAX_PAYLOAD_BYTES) return { ok: false, result: failure("CANVAS_SYNC_PAYLOAD_INVALID") };
        const payload = message.payload;
        for (const key of PAYLOAD_KEYS) if (!hasOwn(payload, key)) return { ok: false, result: failure("CANVAS_SYNC_PAYLOAD_INVALID") };

        const expectedOrigin = normalizedOrigin(payload.expectedOrigin);
        const canvasUserId = normalizedText(String(payload.canvasUserId), 120);
        const accountKey = normalizedText(payload.accountKey, 256);
        const sourceId = normalizedText(payload.sourceId, 256);
        const runId = normalizedText(payload.runId, 256);
        const consentVersion = normalizedText(payload.consentVersion, 128);
        if (!expectedOrigin || !canvasUserId || !accountKey || !sourceId || !runId || !consentVersion || !Number.isSafeInteger(payload.generation) || payload.generation <= 0) {
            return { ok: false, result: failure("CANVAS_SYNC_BINDING_INVALID") };
        }
        if (!isPlainObject(payload.scope) || !Array.isArray(payload.descriptors) || payload.descriptors.length === 0 || payload.descriptors.length > MAX_DESCRIPTORS) {
            return { ok: false, result: failure("CANVAS_SYNC_PLAN_INVALID") };
        }
        if (payload.checkpoint !== null && !isPlainObject(payload.checkpoint)) return { ok: false, result: failure("CANVAS_SYNC_CHECKPOINT_INVALID") };
        try {
            const scope = safeClone(payload.scope);
            const descriptors = safeClone(payload.descriptors);
            const checkpoint = safeClone(payload.checkpoint);
            if (bytes({ scope, descriptors, checkpoint }) > MAX_PAYLOAD_BYTES) return { ok: false, result: failure("CANVAS_SYNC_PAYLOAD_INVALID") };
            return { ok: true, value: { expectedOrigin, canvasUserId, accountKey, sourceId, runId, generation: payload.generation, consentVersion, scope, descriptors, checkpoint } };
        } catch (error) {
            return { ok: false, result: failure("CANVAS_SYNC_PLAN_INVALID") };
        }
    }

    function contextAccountKey(context) {
        return context?.accountKey ?? context?.account_key ?? context?.accountHash ?? context?.account_hash ?? context?.account?.key ?? context?.account?.accountKey;
    }

    function contextUserId(context) {
        return context?.canvasUser?.id ?? context?.canvas_user?.id ?? context?.userId ?? context?.user_id;
    }

    function validateContext(context, binding) {
        if (!isPlainObject(context) || context.ok !== true || !["connected", "verified"].includes(context.state)) return failure("CANVAS_CONTEXT_UNAVAILABLE", "waiting");
        if (context.origin !== binding.expectedOrigin) return failure("CANVAS_ORIGIN_MISMATCH", "mismatch");
        if (String(contextUserId(context)) !== String(binding.canvasUserId)) return failure("CANVAS_USER_ID_MISMATCH", "mismatch");
        const accountKey = contextAccountKey(context);
        if (!normalizedText(accountKey, 256) || accountKey.toLowerCase() !== binding.accountKey.toLowerCase()) return failure("CANVAS_ACCOUNT_MISMATCH", "mismatch");
        return null;
    }

    function resultFrom(value) {
        const raw = isPlainObject(value) ? value : null;
        if (!raw) return failure("CANVAS_SYNC_EXTRACTOR_RESPONSE_INVALID", "error");
        try { safeClone(raw); }
        catch (error) { return failure("CANVAS_SYNC_EXTRACTOR_RESPONSE_UNSAFE", "error"); }
        const source = isPlainObject(raw.result) && !hasOwn(raw, "batches") ? raw.result : raw;
        if (!isPlainObject(source) || !Array.isArray(source.batches)) return failure("CANVAS_SYNC_EXTRACTOR_RESPONSE_INVALID", "error");
        const batches = [];
        try {
            for (const rawBatch of source.batches) {
                if (!isPlainObject(rawBatch) || !exactKeys(rawBatch, BATCH_KEYS) || !Array.isArray(rawBatch.items) || rawBatch.items.length > MAX_ITEMS || !hasOwn(rawBatch, "checkpoint")) {
                    return failure("CANVAS_SYNC_BATCH_INVALID", "error");
                }
                const batch = { items: safeClone(rawBatch.items), checkpoint: safeClone(rawBatch.checkpoint) };
                const payloadHash = rawBatch.payloadHash ?? rawBatch.payload_hash;
                if (payloadHash !== undefined) {
                    if (typeof payloadHash !== "string" || payloadHash.length > 256 || !normalizedText(payloadHash, 256)) return failure("CANVAS_SYNC_BATCH_INVALID", "error");
                    batch.payloadHash = payloadHash;
                }
                if (bytes(batch) > MAX_BYTES) return failure("CANVAS_SYNC_BATCH_TOO_LARGE", "error");
                batches.push(batch);
            }
        } catch (error) {
            return failure("CANVAS_SYNC_BATCH_INVALID", "error");
        }
        const descriptorProgress = Number.isSafeInteger(source.descriptorProgress) && source.descriptorProgress >= 0 ? source.descriptorProgress : 0;
        const quarantineCount = Number.isSafeInteger(source.quarantineCount) && source.quarantineCount >= 0 ? source.quarantineCount : 0;
        const checkpointHash = source.checkpointHash === null || source.checkpointHash === undefined ? null : normalizedText(source.checkpointHash, 256);
        if (source.checkpointHash !== null && source.checkpointHash !== undefined && !checkpointHash) return failure("CANVAS_SYNC_EXTRACTOR_RESPONSE_INVALID", "error");
        const state = ["partial", "complete", "waiting", "mismatch", "error", "unsupported", "failed"].includes(source.state) ? source.state : source.complete === true ? "complete" : "partial";
        const complete = source.complete === true && state === "complete";
        const ok = source.ok === true && complete;
        const errorCode = source.errorCode || source.code;
        return { ok, state, batches, descriptorProgress, quarantineCount, checkpointHash, complete, errorCode: errorCode ? safeErrorCode(errorCode) : null };
    }

    function createContentSyncExtraction({ extractorFactory, getCanvasContext, runtimeId } = {}) {
        async function handle(message, sender) {
            if (!senderIsOwnBackground(sender, runtimeId)) return failure("CANVAS_SYNC_SENDER_NOT_ALLOWED");
            const envelope = validateEnvelope(message);
            if (!envelope.ok) return envelope.result;
            if (typeof getCanvasContext !== "function") return failure("CANVAS_CONTEXT_UNAVAILABLE", "waiting");
            if (typeof extractorFactory !== "function") return failure("CANVAS_EXTRACTOR_UNAVAILABLE", "error");
            const input = envelope.value;
            const binding = Object.freeze({
                origin: input.expectedOrigin,
                expectedOrigin: input.expectedOrigin,
                userId: input.canvasUserId,
                canvasUserId: input.canvasUserId,
                accountKey: input.accountKey,
                sourceId: input.sourceId,
                runId: input.runId,
                generation: input.generation,
                consentVersion: input.consentVersion
            });
            const plan = Object.freeze({ scope: input.scope, descriptors: input.descriptors, checkpoint: input.checkpoint });
            let context;
            try { context = await getCanvasContext({ expectedOrigin: input.expectedOrigin, canvasUserId: input.canvasUserId, accountKey: input.accountKey }); }
            catch (error) { return failure("CANVAS_CONTEXT_UNAVAILABLE", "waiting"); }
            const contextFailure = validateContext(context, input);
            if (contextFailure) return contextFailure;

            let extractor;
            try {
                // The injected factory owns the private construction authority.
                // This boundary receives only the already-authorized factory.
                extractor = await extractorFactory({ binding, plan });
            } catch (error) {
                return failure("CANVAS_EXTRACTOR_UNAVAILABLE", "error");
            }
            const request = {
                contract_version: CONTRACT_VERSION,
                request_id: message.request_id,
                type: EXTRACTOR_TYPE,
                payload: {
                    origin: input.expectedOrigin,
                    user_id: input.canvasUserId,
                    account_hash: input.accountKey,
                    source_id: input.sourceId,
                    run_id: input.runId,
                    generation: input.generation,
                    consent_version: input.consentVersion,
                    scope: input.scope,
                    descriptors: input.descriptors,
                    checkpoint: input.checkpoint,
                    checkpoints: input.checkpoint
                }
            };
            let result;
            try {
                if (typeof extractor?.handle === "function") result = await extractor.handle(request);
                else if (typeof extractor?.extract === "function") result = await extractor.extract({ binding, plan, requestId: message.request_id });
                else if (typeof extractor === "function") result = await extractor(request);
                else return failure("CANVAS_EXTRACTOR_UNAVAILABLE", "error");
            } catch (error) {
                return failure("CANVAS_SYNC_EXTRACTOR_FAILED", "error");
            }
            return resultFrom(result);
        }

        return Object.freeze({ handle });
    }

    return Object.freeze({ CONTRACT_VERSION, TYPE, MAX_ITEMS, MAX_BYTES, createContentSyncExtraction });
}));
