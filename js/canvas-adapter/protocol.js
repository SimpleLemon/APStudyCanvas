(function (root, factory) {
    "use strict";
    const api = factory(root?.APStudyCanvasPlatform?.Security || (typeof require === "function" ? require("../platform/security.js") : null));
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasCanvasAdapter = Object.assign(root.APStudyCanvasCanvasAdapter || {}, { Protocol: api });
}(typeof globalThis !== "undefined" ? globalThis : this, function (security) {
    "use strict";

    const CONTRACT_VERSION = 1;
    const MAX_REQUEST_ID = 160;
    const MAX_PAYLOAD_BYTES = 256 * 1024;
    const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
    const INTERNAL_TYPES = Object.freeze([
        "CANVAS_EXTRACT_RUN",
        "CANVAS_EXTRACT_CANCEL",
        "CANVAS_EXTRACT_STATUS",
        "CANVAS_EXTRACT_BATCH",
        "CANVAS_EXTRACT_PROGRESS",
        "CANVAS_EXTRACT_RESULT"
    ]);
    const TYPE_SET = new Set(INTERNAL_TYPES);

    function isPlainObject(value) {
        if (!value || typeof value !== "object" || Array.isArray(value)) return false;
        const prototype = Object.getPrototypeOf(value);
        return prototype === Object.prototype || prototype === null;
    }

    function clone(value) {
        if (value === undefined) return undefined;
        if (typeof structuredClone === "function") return structuredClone(value);
        return JSON.parse(JSON.stringify(value));
    }

    function byteLength(value) {
        let serialized;
        try { serialized = typeof value === "string" ? value : JSON.stringify(value); } catch (error) { return Number.POSITIVE_INFINITY; }
        if (typeof TextEncoder === "function") return new TextEncoder().encode(serialized).length;
        try { return unescape(encodeURIComponent(serialized)).length; } catch (error) { return Number.POSITIVE_INFINITY; }
    }

    function randomRequestId() {
        if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
        return `extract-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
    }

    function failure(code, details) {
        return { ok: false, code, ...(details ? { details } : {}) };
    }

    function validateEnvelope(message) {
        if (!isPlainObject(message)) return failure("INTERNAL_ENVELOPE_OBJECT_REQUIRED");
        if (message.contract_version !== CONTRACT_VERSION) return failure("INTERNAL_ENVELOPE_VERSION_UNSUPPORTED");
        if (typeof message.request_id !== "string" || message.request_id.length > MAX_REQUEST_ID || !REQUEST_ID.test(message.request_id)) return failure("INTERNAL_REQUEST_ID_INVALID");
        if (!TYPE_SET.has(message.type)) return failure("INTERNAL_TYPE_UNSUPPORTED");
        if (!isPlainObject(message.payload)) return failure("INTERNAL_PAYLOAD_OBJECT_REQUIRED");
        if (byteLength(message.payload) > MAX_PAYLOAD_BYTES) return failure("INTERNAL_PAYLOAD_TOO_LARGE");
        if (security?.findSensitiveData?.(message.payload)) return failure("INTERNAL_SECRET_PAYLOAD_REJECTED");
        return { ok: true, value: Object.freeze({ contract_version: CONTRACT_VERSION, request_id: message.request_id, type: message.type, payload: clone(message.payload) }) };
    }

    function createEnvelope(type, payload = {}, requestId = randomRequestId()) {
        const value = { contract_version: CONTRACT_VERSION, request_id: requestId, type, payload };
        const result = validateEnvelope(value);
        if (!result.ok) throw new Error(result.code);
        return result.value;
    }

    function createResponse(request, payload = {}) {
        return createEnvelope(request?.type || "CANVAS_EXTRACT_RESULT", payload, request?.request_id || randomRequestId());
    }

    return Object.freeze({
        CONTRACT_VERSION,
        MAX_PAYLOAD_BYTES,
        INTERNAL_TYPES,
        createEnvelope,
        createResponse,
        validateEnvelope,
        isPlainObject,
        clone,
        byteLength
    });
}));
