(function (root, factory) {
    "use strict";

    const api = factory();
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasPlatform = Object.assign(root.APStudyCanvasPlatform || {}, { Contract: api });
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const VERSION = 1;
    const MAX_REQUEST_ID_LENGTH = 160;
    const MAX_PAYLOAD_BYTES = 256 * 1024;
    const NEST_ORIGIN = "https://nest.apstudy.org";
    const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
    const FEATURE_FLAG_VERSION = 1;
    const MESSAGE_FAMILIES = Object.freeze([
        "NEST_IDENTITY_GET",
        "NEST_CONSENT_GET",
        "NEST_CONSENT_SET",
        "GET_CANVAS_CONTEXT",
        "CANVAS_ACCOUNT_VERIFY",
        "CANVAS_SYNC_START",
        "CANVAS_SYNC_RESUME",
        "CANVAS_SYNC_STATUS",
        "CANVAS_SYNC_CANCEL",
        "CANVAS_WRITEBACK_DRAIN",
        "CANVAS_WRITEBACK_RESULT",
        "NEST_CALENDARS_GET",
        "NEST_CALENDAR_RANGE_GET",
        "NEST_ROUTING_SET",
        "NEST_EVENT_OVERRIDE_SET",
        "NEST_EVENT_MUTATE",
        "POPUP_FULLSCREEN_OPEN",
        "POPUP_CONTEXT_GET",
        "SETTINGS_READ",
        "SETTINGS_UPDATE",
        "SETTINGS_RESET"
    ]);
    const MESSAGE_FAMILY_SET = new Set(MESSAGE_FAMILIES);
    const FEATURE_FLAGS = Object.freeze({
        identity: true,
        upload: true,
        projection: true,
        mirroring: false,
        mutation: false,
        overlay: true,
        replacement: false,
        calendarReplacementParity: Object.freeze({ version: 1, ready: false }),
        browserFullscreen: true,
        browserReplace: false
    });
    const FEATURE_FLAG_KEYS = Object.freeze([
        "identity", "upload", "projection", "mirroring", "mutation", "overlay", "replacement",
        "calendarReplacementParity", "browserFullscreen", "browserReplace"
    ]);
    const CALENDAR_RANGE_VERSION = 1;
    // Replacement parity is deliberately versioned and false until the
    // native Canvas/Nest behavior listed by the calendar overlay gate is
    // proven end-to-end. Storage cannot activate replacement by itself.
    const CALENDAR_REPLACEMENT_PARITY_VERSION = 1;
    const CALENDAR_REPLACEMENT_PARITY = Object.freeze({ version: CALENDAR_REPLACEMENT_PARITY_VERSION, ready: false });
    // A 62-day inclusive window covers month grids with adjacent days, week
    // navigation, and bounded agenda views without permitting an open-ended
    // educational-event export.
    const CALENDAR_RANGE_MAX_DAYS = 62;
    const CALENDAR_RANGE_MAX_MS = CALENDAR_RANGE_MAX_DAYS * 24 * 60 * 60 * 1000;
    const STRICT_ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

    function isPlainObject(value) {
        if (!value || typeof value !== "object" || Array.isArray(value)) return false;
        const prototype = Object.getPrototypeOf(value);
        return prototype === Object.prototype || prototype === null;
    }

    function disabledFeatureFlags() {
        return {
            identity: false,
            upload: false,
            projection: false,
            mirroring: false,
            mutation: false,
            overlay: false,
            replacement: false,
            calendarReplacementParity: { version: CALENDAR_REPLACEMENT_PARITY_VERSION, ready: false },
            browserFullscreen: false,
            browserReplace: false
        };
    }

    function cloneFeatureFlags(value) {
        const source = isPlainObject(value) ? value : {};
        return {
            ...FEATURE_FLAGS,
            ...source,
            calendarReplacementParity: {
                ...FEATURE_FLAGS.calendarReplacementParity,
                ...(isPlainObject(source.calendarReplacementParity) ? source.calendarReplacementParity : {})
            }
        };
    }

    // Legacy installs stored a flat, unversioned object. Keep its known boolean
    // overrides, but make malformed or explicitly newer contracts fail closed.
    function normalizeFeatureFlags(value, defaults = FEATURE_FLAGS) {
        const base = cloneFeatureFlags(defaults);
        if (value === undefined) return base;
        if (!isPlainObject(value)) return disabledFeatureFlags();

        const hasVersion = Object.prototype.hasOwnProperty.call(value, "version");
        if (hasVersion && value.version !== FEATURE_FLAG_VERSION) return disabledFeatureFlags();
        const source = hasVersion && Object.prototype.hasOwnProperty.call(value, "flags") ? value.flags : value;
        if (!isPlainObject(source)) return disabledFeatureFlags();

        const output = { ...base };
        let malformed = false;
        for (const [key, item] of Object.entries(source)) {
            if (key === "version" || key === "flags") continue;
            if (!FEATURE_FLAG_KEYS.includes(key)) continue;
            if (key === "calendarReplacementParity") {
                if (!isPlainObject(item) || item.version !== CALENDAR_REPLACEMENT_PARITY_VERSION || typeof item.ready !== "boolean") {
                    malformed = true;
                    break;
                }
                // The parity marker is independently fail-closed until the
                // replacement suite is explicitly proven.
                output[key] = { version: CALENDAR_REPLACEMENT_PARITY_VERSION, ready: item.ready === true && base[key]?.ready === true };
                continue;
            }
            if (typeof item !== "boolean") {
                malformed = true;
                break;
            }
            output[key] = item;
        }
        return malformed ? disabledFeatureFlags() : output;
    }

    function byteLength(value) {
        try {
            const text = JSON.stringify(value);
            if (typeof TextEncoder === "function") return new TextEncoder().encode(text).length;
            return unescape(encodeURIComponent(text)).length;
        } catch (error) {
            return Number.POSITIVE_INFINITY;
        }
    }

    function randomRequestId() {
        if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
        if (globalThis.crypto?.getRandomValues) {
            const bytes = new Uint8Array(16);
            globalThis.crypto.getRandomValues(bytes);
            return Array.from(bytes, (item) => item.toString(16).padStart(2, "0")).join("");
        }
        return `r-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
    }

    function fail(code, details) {
        return { ok: false, code, ...(details ? { details } : {}) };
    }

    function isStrictIsoInstant(value) {
        if (typeof value !== "string" || !STRICT_ISO_INSTANT.test(value)) return false;
        const parsed = new Date(value);
        return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
    }

    function validateCalendarRangePayload(payload) {
        const keys = Reflect.ownKeys(payload || {});
        if (!isPlainObject(payload) || keys.length !== 2 || keys.some((key) => typeof key !== "string" || !["start", "end"].includes(key))) {
            return fail("NEST_CALENDAR_RANGE_PAYLOAD_INVALID");
        }
        if (!isStrictIsoInstant(payload.start) || !isStrictIsoInstant(payload.end)) return fail("NEST_CALENDAR_RANGE_INVALID");
        const start = Date.parse(payload.start);
        const end = Date.parse(payload.end);
        if (!(start < end)) return fail("NEST_CALENDAR_RANGE_ORDER_INVALID");
        if (end - start > CALENDAR_RANGE_MAX_MS) return fail("NEST_CALENDAR_RANGE_TOO_LARGE");
        return { ok: true, value: Object.freeze({ start: payload.start, end: payload.end, version: CALENDAR_RANGE_VERSION }) };
    }

    function buildCalendarRangePath(start, end) {
        const validation = validateCalendarRangePayload({ start, end });
        if (!validation.ok) throw new Error(validation.code);
        const query = new URLSearchParams();
        query.set("start", start);
        query.set("end", end);
        return `/api/calendar/events?${query.toString()}`;
    }

    function validateEnvelope(message) {
        if (!isPlainObject(message)) return fail("ENVELOPE_OBJECT_REQUIRED");
        if (message.version !== VERSION) return fail("ENVELOPE_VERSION_UNSUPPORTED");
        if (typeof message.request_id !== "string" || message.request_id.length > MAX_REQUEST_ID_LENGTH || !REQUEST_ID_PATTERN.test(message.request_id)) {
            return fail("ENVELOPE_REQUEST_ID_INVALID");
        }
        if (typeof message.type !== "string" || !MESSAGE_FAMILY_SET.has(message.type)) return fail("ENVELOPE_TYPE_UNSUPPORTED");
        if (!isPlainObject(message.payload)) return fail("ENVELOPE_PAYLOAD_OBJECT_REQUIRED");
        if (byteLength(message.payload) > MAX_PAYLOAD_BYTES) return fail("ENVELOPE_PAYLOAD_TOO_LARGE");
        return {
            ok: true,
            value: Object.freeze({
                version: VERSION,
                request_id: message.request_id,
                type: message.type,
                payload: message.payload
            })
        };
    }

    function createEnvelope(type, payload = {}, requestId = randomRequestId()) {
        const envelope = { version: VERSION, request_id: requestId, type, payload };
        const validation = validateEnvelope(envelope);
        if (!validation.ok) throw new Error(validation.code);
        return validation.value;
    }

    function createResponse(request, payload) {
        return createEnvelope(request?.type || "POPUP_CONTEXT_GET", payload, request?.request_id || randomRequestId());
    }

    function createErrorResponse(request, code, message) {
        return createResponse(request, { ok: false, code, ...(message ? { message } : {}) });
    }

    function normalizeOrigin(value, { allowExtension = false } = {}) {
        if (typeof value !== "string" || !value.trim()) return null;
        try {
            const url = new URL(value.trim());
            if (url.username || url.password) return null;
            if (allowExtension && (url.protocol === "chrome-extension:" || url.protocol === "moz-extension:")) return `${url.protocol}//${url.host}`;
            if (url.protocol !== "https:") return null;
            return url.origin;
        } catch (error) {
            return null;
        }
    }

    function normalizeCanvasOrigins(rawValue) {
        const values = Array.isArray(rawValue) ? rawValue : String(rawValue || "").split(",");
        const origins = [];
        for (const raw of values) {
            const candidate = String(raw || "").trim();
            if (!candidate) continue;
            const withScheme = candidate.includes("://") ? candidate : `https://${candidate}`;
            const origin = normalizeOrigin(withScheme);
            if (!origin || origin === NEST_ORIGIN) continue;
            origins.push(origin);
        }
        return Array.from(new Set(origins));
    }

    function senderOrigin(sender) {
        return normalizeOrigin(sender?.origin || sender?.url || "", { allowExtension: true });
    }

    function extensionOrigin(runtimeApi) {
        try {
            return normalizeOrigin(runtimeApi?.getURL?.("/") || "", { allowExtension: true });
        } catch (error) {
            return null;
        }
    }

    function isExactExtensionSender(sender, expectedOrigin) {
        const origin = senderOrigin(sender);
        return Boolean(origin && expectedOrigin && origin === expectedOrigin && (origin.startsWith("chrome-extension:") || origin.startsWith("moz-extension:")));
    }

    function isExactNestSender(sender) {
        return senderOrigin(sender) === NEST_ORIGIN;
    }

    function isCanvasSender(sender, { configuredOrigins = [], verifiedOrigins = [], allowUnverified = false } = {}) {
        const origin = senderOrigin(sender);
        if (!origin || !origin.startsWith("https:") || origin === NEST_ORIGIN) return false;
        const configured = configuredOrigins.includes(origin);
        const verified = verifiedOrigins.includes(origin);
        return configured && (verified || allowUnverified);
    }

    function classifySender(sender, { runtimeApi, configuredOrigins = [], verifiedOrigins = [], allowUnverifiedCanvas = false } = {}) {
        const origin = senderOrigin(sender);
        const extension = extensionOrigin(runtimeApi);
        if (isExactExtensionSender(sender, extension)) return { ok: true, kind: "extension", origin };
        if (isExactNestSender(sender)) return { ok: true, kind: "nest", origin };
        if (isCanvasSender(sender, { configuredOrigins, verifiedOrigins, allowUnverified: allowUnverifiedCanvas })) {
            return { ok: true, kind: "canvas", origin, verified: verifiedOrigins.includes(origin) };
        }
        return fail("SENDER_NOT_ALLOWED");
    }

    return Object.freeze({
        VERSION,
        NEST_ORIGIN,
        MAX_PAYLOAD_BYTES,
        MESSAGE_FAMILIES,
        FEATURE_FLAGS,
        FEATURE_FLAG_VERSION,
        FEATURE_FLAG_KEYS,
        normalizeFeatureFlags,
        CALENDAR_RANGE_VERSION,
        CALENDAR_RANGE_MAX_DAYS,
        CALENDAR_RANGE_MAX_MS,
        CALENDAR_REPLACEMENT_PARITY_VERSION,
        CALENDAR_REPLACEMENT_PARITY,
        isStrictIsoInstant,
        validateCalendarRangePayload,
        buildCalendarRangePath,
        createEnvelope,
        createResponse,
        createErrorResponse,
        validateEnvelope,
        normalizeOrigin,
        normalizeCanvasOrigins,
        senderOrigin,
        extensionOrigin,
        isExactExtensionSender,
        isExactNestSender,
        isCanvasSender,
        classifySender,
        isPlainObject
    });
}));
