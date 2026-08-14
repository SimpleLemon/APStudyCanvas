(function (root, factory) {
    "use strict";

    const api = factory();
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasPlatform = Object.assign(root.APStudyCanvasPlatform || {}, { CanvasExtractionMessenger: api });
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const CONTRACT_VERSION = 1;
    const TYPE = "CANVAS_SYNC_EXTRACT_INTERNAL";
    const MAX_ITEMS = 80;
    const MAX_BYTES = 48 * 1024;
    const MAX_DESCRIPTORS = 80;
    const REQUEST_KEYS = new Set([
        "expectedOrigin", "canvasUserId", "accountKey", "sourceId", "runId",
        "generation", "consentVersion", "scope", "descriptors", "checkpoint"
    ]);
    const RESPONSE_KEYS = new Set([
        "ok", "state", "batches", "descriptorProgress", "quarantineCount",
        "checkpointHash", "complete", "errorCode"
    ]);
    const BATCH_KEYS = new Set(["items", "checkpoint", "payloadHash", "payload_hash"]);
    const ID = /^[A-Za-z0-9][A-Za-z0-9._:/+%:@-]{0,255}$/;
    const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
    const ERROR_CODE = /^[A-Za-z][A-Za-z0-9_:-]{0,63}$/;
    const SECRET_VALUE = /(?:bearer\s+|(?:access|refresh|id|oauth|auth)[_-]?(?:token|key)\s*[:=]|(?:password|passwd|secret|credential|cookie|csrf|session)\s*[:=]|-----begin\s+(?:private|openpgp)\s+key|eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,})/i;

    function isPlainObject(value) {
        if (!value || typeof value !== "object" || Array.isArray(value)) return false;
        const prototype = Object.getPrototypeOf(value);
        return prototype === Object.prototype || prototype === null;
    }

    function bytes(value) {
        let serialized;
        try { serialized = typeof value === "string" ? value : JSON.stringify(value); }
        catch (error) { return Number.POSITIVE_INFINITY; }
        if (typeof TextEncoder === "function") return new TextEncoder().encode(serialized).length;
        try { return unescape(encodeURIComponent(serialized)).length; }
        catch (error) { return Number.POSITIVE_INFINITY; }
    }

    function failure(code) {
        const error = new Error(code);
        error.code = code;
        return error;
    }

    function ownKeys(value) {
        try { return Reflect.ownKeys(value); }
        catch (error) { return null; }
    }

    function exactKeys(value, allowed) {
        const keys = isPlainObject(value) ? ownKeys(value) : null;
        return Boolean(keys && keys.every((key) => typeof key === "string" && allowed.has(key)));
    }

    function normalizeOrigin(value) {
        if (typeof value !== "string" || !value.trim()) return null;
        try {
            const parsed = new URL(value.trim());
            if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
            if (parsed.pathname !== "" && parsed.pathname !== "/") return null;
            return parsed.origin;
        } catch (error) {
            return null;
        }
    }

    function normalizedIdentifier(value, { allowNumber = false } = {}) {
        if (allowNumber && Number.isSafeInteger(value) && value >= 0) value = String(value);
        if (typeof value !== "string" || !value || value.length > 256 || value !== value.trim() || !ID.test(value)) return null;
        return value;
    }

    function normalizedKey(key) {
        return String(key).toLowerCase().replace(/[^a-z0-9]/g, "");
    }

    function unsafeKey(key) {
        const normalized = normalizedKey(key);
        return normalized === "tabid" || normalized === "windowid"
            || normalized === "type" && normalized === "message"
            || normalized.includes("token") || normalized.includes("authorization")
            || normalized.includes("bearer") || normalized.includes("password")
            || normalized.includes("secret") || normalized.includes("credential")
            || normalized.includes("cookie") || normalized.includes("csrf")
            || normalized.includes("private") || normalized.includes("raw")
            || normalized.includes("response") || normalized.includes("wrapper")
            || normalized === "body" || normalized === "headers" || normalized === "html"
            || normalized === "url" || normalized === "uri" || normalized === "href";
    }

    function safeUrl(value, expectedOrigin) {
        const matches = String(value).match(/(?:https?|ftp|data):\/\/[^\s"'<>]+/gi) || [];
        for (const candidate of matches) {
            let parsed;
            try { parsed = new URL(candidate); }
            catch (error) { return false; }
            if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash || parsed.origin !== expectedOrigin) return false;
            for (const [key, item] of parsed.searchParams.entries()) {
                if (unsafeKey(key) || SECRET_VALUE.test(item)) return false;
            }
        }
        return true;
    }

    function safeClone(value, expectedOrigin, seen = new Set()) {
        if (value === null || typeof value === "boolean") return value;
        if (typeof value === "string") {
            if (value.length > MAX_BYTES || /[\u0000-\u001f\u007f]/.test(value) || SECRET_VALUE.test(value) || !safeUrl(value, expectedOrigin)) throw failure("unsafe_value");
            return value;
        }
        if (typeof value === "number") {
            if (!Number.isFinite(value)) throw failure("unsafe_value");
            return value;
        }
        if (!value || typeof value !== "object" || seen.has(value)) throw failure("unsafe_value");
        seen.add(value);
        let output;
        if (Array.isArray(value)) {
            if (value.length > MAX_DESCRIPTORS * 4) throw failure("unsafe_value");
            output = value.map((item) => safeClone(item, expectedOrigin, seen));
        } else {
            if (!isPlainObject(value)) throw failure("unsafe_value");
            output = {};
            const keys = ownKeys(value);
            if (!keys || keys.some((key) => typeof key !== "string" || unsafeKey(key))) throw failure("unsafe_value");
            for (const key of keys) output[key] = safeClone(value[key], expectedOrigin, seen);
        }
        seen.delete(value);
        return output;
    }

    function validateRequestPayload(payload, session) {
        if (!exactKeys(payload, REQUEST_KEYS) || ownKeys(payload).length !== REQUEST_KEYS.size) throw failure("canvas_payload_invalid");
        const expectedOrigin = normalizeOrigin(payload.expectedOrigin);
        const sessionOrigin = normalizeOrigin(session.origin);
        const accountKey = normalizedIdentifier(payload.accountKey);
        const sessionAccount = normalizedIdentifier(session.accountKey);
        const canvasUserId = normalizedIdentifier(payload.canvasUserId, { allowNumber: true });
        const sessionUser = normalizedIdentifier(session.canvasUserId, { allowNumber: true });
        if (!expectedOrigin || !sessionOrigin || expectedOrigin !== sessionOrigin
            || !accountKey || !sessionAccount || accountKey !== sessionAccount
            || !canvasUserId || !sessionUser || canvasUserId !== sessionUser
            || !normalizedIdentifier(payload.sourceId)
            || !normalizedIdentifier(payload.runId)
            || !normalizedIdentifier(payload.consentVersion)
            || !Number.isSafeInteger(payload.generation) || payload.generation <= 0
            || !isPlainObject(payload.scope)
            || !Array.isArray(payload.descriptors) || payload.descriptors.length === 0 || payload.descriptors.length > MAX_DESCRIPTORS
            || (payload.checkpoint !== null && !isPlainObject(payload.checkpoint))) throw failure("canvas_binding_invalid");
        let normalized;
        try {
            normalized = {
                expectedOrigin,
                canvasUserId,
                accountKey,
                sourceId: normalizedIdentifier(payload.sourceId),
                runId: normalizedIdentifier(payload.runId),
                generation: payload.generation,
                consentVersion: normalizedIdentifier(payload.consentVersion),
                scope: safeClone(payload.scope, expectedOrigin),
                descriptors: safeClone(payload.descriptors, expectedOrigin),
                checkpoint: payload.checkpoint === null ? null : safeClone(payload.checkpoint, expectedOrigin)
            };
        } catch (error) {
            throw failure("canvas_payload_unsafe");
        }
        if (bytes(normalized) > MAX_BYTES) throw failure("canvas_payload_too_large");
        return normalized;
    }

    function normalizedErrorCode(value) {
        return value === undefined || value === null ? null : (typeof value === "string" && ERROR_CODE.test(value) && !SECRET_VALUE.test(value) ? value : null);
    }

    function normalizeBatch(batch, expectedOrigin) {
        if (!isPlainObject(batch) || !exactKeys(batch, BATCH_KEYS) || !Array.isArray(batch.items)
            || batch.items.length > MAX_ITEMS || !Object.prototype.hasOwnProperty.call(batch, "checkpoint")) throw failure("canvas_response_invalid");
        if (Object.prototype.hasOwnProperty.call(batch, "payloadHash") && Object.prototype.hasOwnProperty.call(batch, "payload_hash")) throw failure("canvas_response_invalid");
        const normalized = {
            items: safeClone(batch.items, expectedOrigin),
            checkpoint: safeClone(batch.checkpoint, expectedOrigin)
        };
        const hash = batch.payloadHash ?? batch.payload_hash;
        if (hash !== undefined) {
            if (typeof hash !== "string" || !normalizedIdentifier(hash) || !safeUrl(hash, expectedOrigin) || SECRET_VALUE.test(hash)) throw failure("canvas_response_invalid");
            normalized.payloadHash = hash;
        }
        if (bytes(normalized) > MAX_BYTES) throw failure("canvas_response_too_large");
        return normalized;
    }

    function normalizeResponse(response, session) {
        if (!isPlainObject(response) || !exactKeys(response, RESPONSE_KEYS)) throw failure("canvas_response_invalid");
        const keys = ownKeys(response);
        if (!keys || keys.some((key) => typeof key !== "string" || !RESPONSE_KEYS.has(key))) throw failure("canvas_response_invalid");
        const expectedOrigin = normalizeOrigin(session.origin);
        let batches = [];
        if (response.batches !== undefined) {
            if (!Array.isArray(response.batches) || response.batches.length > MAX_ITEMS) throw failure("canvas_response_invalid");
            try { batches = response.batches.map((batch) => normalizeBatch(batch, expectedOrigin)); }
            catch (error) { throw failure(error.code === "canvas_response_too_large" ? error.code : "canvas_response_invalid"); }
        }
        if (response.ok !== undefined && typeof response.ok !== "boolean") throw failure("canvas_response_invalid");
        if (response.complete !== undefined && typeof response.complete !== "boolean") throw failure("canvas_response_invalid");
        if (response.descriptorProgress !== undefined && (!Number.isSafeInteger(response.descriptorProgress) || response.descriptorProgress < 0)) throw failure("canvas_response_invalid");
        if (response.quarantineCount !== undefined && (!Number.isSafeInteger(response.quarantineCount) || response.quarantineCount < 0)) throw failure("canvas_response_invalid");
        if (response.checkpointHash !== undefined && response.checkpointHash !== null && (!normalizedIdentifier(response.checkpointHash) || SECRET_VALUE.test(response.checkpointHash))) throw failure("canvas_response_invalid");
        if (response.state !== undefined && (typeof response.state !== "string" || !ERROR_CODE.test(response.state) || SECRET_VALUE.test(response.state))) throw failure("canvas_response_invalid");
        const errorCode = normalizedErrorCode(response.errorCode);
        if (response.errorCode !== undefined && response.errorCode !== null && errorCode === null) throw failure("canvas_response_invalid");
        return {
            ok: response.ok === true,
            state: response.state || (response.complete === true ? "complete" : "partial"),
            batches,
            descriptorProgress: response.descriptorProgress ?? 0,
            quarantineCount: response.quarantineCount ?? 0,
            checkpointHash: response.checkpointHash ?? null,
            complete: response.complete === true,
            errorCode
        };
    }

    function unavailable() {
        return { ok: false, state: "waiting_for_canvas_session", errorCode: "canvas_session_unavailable" };
    }

    function fallbackIdFactory() {
        let sequence = 0;
        return () => `canvas-extraction-${++sequence}`;
    }

    function createCanvasExtractionMessenger({ tabs, sessionResolver, idFactory = fallbackIdFactory() } = {}) {
        const makeRequestId = typeof idFactory === "function" ? idFactory : idFactory && typeof idFactory.create === "function" ? idFactory.create.bind(idFactory) : null;
        async function request(session, payload) {
            let owned = false;
            try { owned = sessionResolver?.isOwnedSession?.(session) === true; }
            catch (error) { owned = false; }
            if (!owned) throw failure("canvas_session_not_owned");
            if (!Number.isSafeInteger(session?.tabId) || session.tabId < 0) throw failure("canvas_session_invalid");
            if (!tabs || typeof tabs.sendMessage !== "function") throw failure("canvas_tabs_unavailable");
            const normalizedPayload = validateRequestPayload(payload, session);
            const requestId = makeRequestId ? makeRequestId() : null;
            if (typeof requestId !== "string" || !REQUEST_ID.test(requestId)) throw failure("canvas_request_id_invalid");
            const envelope = { contract_version: CONTRACT_VERSION, type: TYPE, request_id: requestId, payload: normalizedPayload };
            let response;
            try { response = await tabs.sendMessage(session.tabId, envelope); }
            catch (error) { return unavailable(); }
            return normalizeResponse(response, session);
        }

        return Object.freeze({ request });
    }

    return Object.freeze({ CONTRACT_VERSION, TYPE, MAX_ITEMS, MAX_BYTES, createCanvasExtractionMessenger });
}));
