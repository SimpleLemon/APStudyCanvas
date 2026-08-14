(function (root, factory) {
    "use strict";

    const security = root?.APStudyCanvasPlatform?.Security || (typeof require === "function" ? require("./security.js") : null);
    const api = factory(security);
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasPlatform = Object.assign(root.APStudyCanvasPlatform || {}, { Transport: api });
}(typeof globalThis !== "undefined" ? globalThis : this, function (security) {
    "use strict";

    const NEST_ORIGIN = "https://nest.apstudy.org";
    const MAX_BODY_BYTES = 64 * 1024;
    const MAX_RESPONSE_BYTES = 128 * 1024;
    const PATH_METHODS = Object.freeze({
        "/api/extension/identity": ["GET"],
        "/api/extension/csrf": ["GET"],
        "/api/extension/consent": ["GET", "POST", "PUT"],
        "/api/extension/calendars": ["GET"],
        "/api/extension/events/override": ["PUT"],
        "/api/extension/events/mutate": ["POST"],
        "/api/extension/canvas/sync/start": ["POST"],
        "/api/extension/canvas/sync/resume": ["POST"],
        "/api/extension/canvas/sync/status": ["GET"],
        "/api/extension/canvas/sync/cancel": ["POST"],
        "/api/extension/writeback/drain": ["GET"],
        "/api/extension/writeback/result": ["POST"],
        "/api/calendar/events": ["GET"]
    });
    const CALENDAR_RANGE_MAX_DAYS = 62;
    const CALENDAR_RANGE_MAX_MS = CALENDAR_RANGE_MAX_DAYS * 24 * 60 * 60 * 1000;
    const STRICT_ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

    function isStrictIsoInstant(value) {
        if (typeof value !== "string" || !STRICT_ISO_INSTANT.test(value)) return false;
        const parsed = new Date(value);
        return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
    }
    const DYNAMIC_PATH_RULES = Object.freeze([
        { pattern: /^\/api\/extension\/calendar\/sources$/, methods: ["GET", "POST"], query: new Set(["include_archived"]) },
        { pattern: /^\/api\/extension\/calendar\/sources\/(src1:[A-Za-z0-9._~-]{1,128})\/sync$/, methods: ["POST"], query: new Set() },
        { pattern: /^\/api\/extension\/calendar\/sources\/(src1:[A-Za-z0-9._~-]{1,128})\/sync\/([A-Za-z0-9._:-]{1,160})$/, methods: ["GET"], query: new Set(["generation"]) },
        { pattern: /^\/api\/extension\/calendar\/sources\/(src1:[A-Za-z0-9._~-]{1,128})\/sync\/([A-Za-z0-9._:-]{1,160})\/(?:resume|renew)$/, methods: ["PUT"], query: new Set() },
        { pattern: /^\/api\/extension\/calendar\/sources\/(src1:[A-Za-z0-9._~-]{1,128})\/sync\/([A-Za-z0-9._:-]{1,160})\/cancel$/, methods: ["POST"], query: new Set() },
        { pattern: /^\/api\/extension\/calendar\/sources\/(src1:[A-Za-z0-9._~-]{1,128})\/sync\/([A-Za-z0-9._:-]{1,160})\/(?:batch|batches|finalize)$/, methods: ["POST"], query: new Set() },
        { pattern: /^\/api\/extension\/calendar\/sources\/(src1:[A-Za-z0-9._~-]{1,128})\/routing$/, methods: ["GET", "PUT"], query: new Set() },
        { pattern: /^\/api\/extension\/calendar\/sources\/([A-Za-z0-9._:-]{1,160})\/(?:writebacks|writeback-intents)$/, methods: ["GET", "POST"], query: new Set(["account_key", "event_ref", "states", "limit"]) },
        { pattern: /^\/api\/extension\/calendar\/sources\/([A-Za-z0-9._:-]{1,160})\/writebacks\/([A-Za-z0-9._:-]{1,160})(?:\/result)?$/, methods: ["GET", "POST"], query: new Set() },
        { pattern: /^\/api\/extension\/calendar\/sources\/([A-Za-z0-9._:-]{1,160})\/writeback-results\/([A-Za-z0-9._:-]{1,160})$/, methods: ["POST"], query: new Set() }
    ]);
    const ALLOWED_HEADERS = Object.freeze(new Set(["accept", "content-type", "x-csrftoken", "x-request-id", "idempotency-key"]));
    const SAFE_RESPONSE_HEADERS = Object.freeze(new Set(["content-type", "x-request-id", "retry-after"]));
    const SAFE_RESPONSE_FIELDS = Object.freeze(new Set([
        "ok", "status", "state", "code", "message", "error", "errors", "version", "current", "requestid",
        "contractversion", "identity", "authenticated", "userid", "accountid", "profile", "displayname", "name",
        "avatarurl", "sourceurl", "sourceorigin", "consent", "enabled", "granted", "scopes",
        "calendars", "calendarid", "id", "title", "color", "timezone", "routing", "routingid", "routeid",
        "eventid", "eventref", "events", "updatedat", "createdat", "result", "results", "data", "count", "hasmore",
        "sources", "source", "sourceid", "sourceref", "source_ref", "sourcekey", "source_key", "accountkey", "label", "provideruserid", "consentversion", "run", "batch", "runid",
        "generation", "leaseexpiresat", "lease_token", "leasetoken", "checkpoint", "counters", "scope", "status",
        "accepted", "accepted_event_refs", "acceptedeventrefs", "quarantined", "batch_size", "batchsize", "payload_hash",
        "payloadhash", "idempotency_key", "idempotencykey", "idempotent", "retry_after", "retryafter", "capabilities",
        "fallback_calendar_id", "fallbackcalendarid", "destination_calendar_id", "destinationcalendarid", "calendar_name", "completion_status", "completion_source",
        "readonly", "read_only", "imported", "kind", "visible", "routing_eligible", "routingeligible", "routing_degraded", "routingdegraded"
    ]));
    const SAFE_URL_FIELDS = Object.freeze(new Set(["avatarurl", "sourceurl", "sourceorigin"]));

    function byteLength(value) {
        const text = typeof value === "string" ? value : JSON.stringify(value);
        if (typeof text !== "string") return Number.POSITIVE_INFINITY;
        if (typeof TextEncoder === "function") return new TextEncoder().encode(text).length;
        return unescape(encodeURIComponent(text)).length;
    }

    function randomRequestId() {
        if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
        return `transport-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
    }

    function normalizeHeaders(headers = {}) {
        if (!security.isPlainObject(headers)) throw new Error("NEST_HEADERS_OBJECT_REQUIRED");
        const normalized = {};
        Object.entries(headers).forEach(([name, value]) => {
            const key = String(name).toLowerCase();
            if (!ALLOWED_HEADERS.has(key)) throw new Error("NEST_HEADER_NOT_ALLOWLISTED");
            if (typeof value !== "string" || value.length > 512 || /[\r\n]/.test(value)) throw new Error("NEST_HEADER_VALUE_INVALID");
            normalized[key] = value;
        });
        return normalized;
    }

    function serializeBody(body, { allowInternalLease = false } = {}) {
        if (body === undefined || body === null) return undefined;
        const parsed = security.parseJsonObject(body, "NEST_BODY_OBJECT_REQUIRED");
        const safe = allowInternalLease && Object.prototype.hasOwnProperty.call(parsed, "lease_token")
            ? Object.fromEntries(Object.entries(parsed).filter(([key]) => key !== "lease_token"))
            : parsed;
        if (security.findSensitiveData(safe)) throw new Error("NEST_SECRET_BODY_FORBIDDEN");
        if (allowInternalLease && parsed.lease_token !== undefined && (typeof parsed.lease_token !== "string" || !parsed.lease_token || parsed.lease_token.length > 512 || /[\r\n]/.test(parsed.lease_token))) throw new Error("NEST_LEASE_INVALID");
        const serialized = JSON.stringify(parsed);
        if (byteLength(serialized) > MAX_BODY_BYTES) throw new Error("NEST_BODY_TOO_LARGE");
        return serialized;
    }

    function matchingPathRule(path, method) {
        if (typeof path !== "string" || path.length > 2048 || !path.startsWith("/")) return null;
        let parsed;
        try { parsed = new URL(`https://nest.apstudy.org${path}`); }
        catch (error) { return null; }
        if (parsed.hash || parsed.username || parsed.password || parsed.origin !== NEST_ORIGIN) return null;
        let decodedPathname;
        try { decodedPathname = decodeURIComponent(parsed.pathname); } catch (error) { return null; }
        if (decodedPathname.includes("//") || /[\u0000-\u001f\u007f]/.test(decodedPathname)) return null;
        const pathname = parsed.pathname;
        if (pathname === "/api/calendar/events") {
            if (method !== "GET" || !parsed.search || parsed.hash) return null;
            const entries = Array.from(parsed.searchParams.entries());
            if (entries.length !== 2 || entries[0][0] !== "start" || entries[1][0] !== "end") return null;
            const [start, end] = entries.map(([, value]) => value);
            if (!isStrictIsoInstant(start) || !isStrictIsoInstant(end)) return null;
            const startTime = Date.parse(start);
            const endTime = Date.parse(end);
            if (!(startTime < endTime) || endTime - startTime > CALENDAR_RANGE_MAX_MS) return null;
            const canonical = new URLSearchParams();
            canonical.set("start", start);
            canonical.set("end", end);
            if (parsed.search.slice(1) !== canonical.toString()) return null;
            return { pathname, rule: { methods: ["GET"], query: new Set(["start", "end"]), calendarRange: true } };
        }
        if (Object.prototype.hasOwnProperty.call(PATH_METHODS, pathname) && PATH_METHODS[pathname].includes(method)) {
            if (parsed.search) {
                const allowed = pathname === "/api/extension/consent" ? new Set(["source_key", "account_key", "version"]) : new Set();
                for (const [key, value] of parsed.searchParams.entries()) {
                    if (!allowed.has(key) || !value || value.length > 512 || security.hasCredentialLikeScalar(value)) return null;
                }
            }
            return { pathname, rule: { methods: PATH_METHODS[pathname], query: pathname === "/api/extension/consent" ? new Set(["source_key", "account_key", "version"]) : new Set() } };
        }
        const rule = DYNAMIC_PATH_RULES.find((candidate) => candidate.pattern.test(decodedPathname) && candidate.methods.includes(method));
        if (!rule) return null;
        for (const [key, value] of parsed.searchParams.entries()) {
            if (!rule.query.has(key) || !value || value.length > 512 || security.hasCredentialLikeScalar(value)) return null;
        }
        return { pathname, rule };
    }

    function validateTransportRequest(spec, options = {}) {
        if (!security.isPlainObject(spec)) throw new Error("NEST_REQUEST_OBJECT_REQUIRED");
        if (Object.prototype.hasOwnProperty.call(spec, "url")) throw new Error("NEST_ARBITRARY_URL_FORBIDDEN");
        const method = String(spec.method || "GET").toUpperCase();
        const path = spec.path;
        const matched = matchingPathRule(path, method);
        if (!matched) throw new Error("NEST_PATH_METHOD_NOT_ALLOWLISTED");
        const body = serializeBody(spec.body, options);
        if (method === "GET" && body !== undefined) throw new Error("NEST_GET_BODY_FORBIDDEN");
        const headers = normalizeHeaders(spec.headers || {});
        if (body !== undefined && headers["content-type"] && !/^application\/json(?:\s*;|$)/i.test(headers["content-type"])) throw new Error("NEST_CONTENT_TYPE_JSON_REQUIRED");
        return Object.freeze({ method, path, headers, ...(body === undefined ? {} : { body }) });
    }

    function buildNestUrl(path) {
        const request = validateTransportRequest({ method: PATH_METHODS[path]?.[0], path });
        return `${NEST_ORIGIN}${request.path}`;
    }

    function safeCalendarText(value, maxLength = 512) {
        return typeof value === "string"
            && value.length > 0
            && value.length <= maxLength
            && !/[<>\u0000-\u001f\u007f]/.test(value)
            && !security.hasCredentialLikeScalar(value)
            ? value
            : undefined;
    }

    function safeCalendarColor(value) {
        return typeof value === "string" && /^(?:#[0-9a-f]{6}|[A-Za-z][A-Za-z0-9 _-]{0,31})$/i.test(value) ? value : undefined;
    }

    function safeCalendarUrl(value, allowedCanvasOrigins = []) {
        if (!security.validateSafeHttpsUrl(value)) return undefined;
        try {
            const parsed = new URL(value);
            if (allowedCanvasOrigins.length && !allowedCanvasOrigins.includes(parsed.origin)) return undefined;
            return value;
        } catch (error) {
            return undefined;
        }
    }

    function safeCalendarInstant(value) {
        if (!isStrictIsoInstant(value)) return undefined;
        return value;
    }

    function pickObject(value, allowedKeys) {
        if (!security.isPlainObject(value)) return undefined;
        const output = {};
        for (const key of allowedKeys) if (Object.prototype.hasOwnProperty.call(value, key)) output[key] = value[key];
        return output;
    }

    function sanitizeCalendarCapabilities(value) {
        const source = pickObject(value, ["read_only", "recurrence", "overlay", "replacement", "mutation"]);
        if (!source) return undefined;
        const output = {};
        for (const key of Object.keys(source)) {
            if (typeof source[key] === "boolean") output[key] = source[key];
            else if (typeof source[key] === "string" && /^(?:supported|unsupported|read_only|enabled|disabled|unavailable)$/i.test(source[key])) output[key] = source[key];
        }
        return Object.keys(output).length ? output : undefined;
    }

    function sanitizeCalendarRecurrence(value) {
        if (typeof value === "string") return /^(?:none|supported|unsupported|read_only|recurring|single)$/i.test(value) ? value : undefined;
        const source = pickObject(value, ["state", "read_only", "supported"]);
        if (!source) return undefined;
        const output = {};
        if (typeof source.state === "string" && /^(?:none|supported|unsupported|read_only|recurring|single)$/i.test(source.state)) output.state = source.state;
        if (typeof source.read_only === "boolean") output.read_only = source.read_only;
        if (typeof source.supported === "boolean") output.supported = source.supported;
        return Object.keys(output).length ? output : undefined;
    }

    function sanitizeCalendarEvent(value, allowedCanvasOrigins) {
        if (!security.isPlainObject(value)) return null;
        const output = {};
        const title = safeCalendarText(value.title, 512);
        const start = safeCalendarInstant(value.start ?? value.start_at ?? value.start_time);
        const end = safeCalendarInstant(value.end ?? value.end_at ?? value.end_time);
        if (!title || !start || !end || !(Date.parse(start) < Date.parse(end))) return null;
        output.title = title;
        output.start = start;
        output.end = end;
        for (const key of ["all_day", "timed", "multi_day", "completed", "read_only"]) if (typeof value[key] === "boolean") output[key] = value[key];
        const sourceLabel = safeCalendarText(value.source_label ?? value.sourceLabel, 160);
        if (sourceLabel) output.source_label = sourceLabel;
        const sourceColor = safeCalendarColor(value.source_color ?? value.sourceColor);
        if (sourceColor) output.source_color = sourceColor;
        const description = safeCalendarText(value.description, 4096);
        if (description) output.description = description;
        const completion = value.completion_style ?? value.completionStyle;
        if (typeof completion === "string" && /^(?:none|neutral|incomplete|completed|partial|overdue|due|submitted)$/i.test(completion)) output.completion_style = completion;
        const sourceUrl = safeCalendarUrl(value.source_url ?? value.canvas_source_url ?? value.canvasSourceUrl, allowedCanvasOrigins);
        if (sourceUrl) output.source_url = sourceUrl;
        const recurrence = sanitizeCalendarRecurrence(value.recurrence);
        if (recurrence !== undefined) output.recurrence = recurrence;
        const capabilities = sanitizeCalendarCapabilities(value.capabilities);
        if (capabilities !== undefined) output.capabilities = capabilities;
        return output;
    }

    function sanitizeCalendarSources(value, allowedCanvasOrigins) {
        if (!Array.isArray(value)) return undefined;
        const sources = [];
        for (const item of value) {
            if (!security.isPlainObject(item)) continue;
            const source = {};
            const label = safeCalendarText(item.label ?? item.source_label, 160);
            const color = safeCalendarColor(item.color ?? item.source_color);
            const url = safeCalendarUrl(item.source_url ?? item.canvas_source_url ?? item.url, allowedCanvasOrigins);
            if (label) source.label = label;
            if (color) source.color = color;
            if (url) source.source_url = url;
            if (typeof item.read_only === "boolean") source.read_only = item.read_only;
            const recurrence = sanitizeCalendarRecurrence(item.recurrence);
            if (recurrence !== undefined) source.recurrence = recurrence;
            const capabilities = sanitizeCalendarCapabilities(item.capabilities);
            if (capabilities !== undefined) source.capabilities = capabilities;
            if (Object.keys(source).length) sources.push(source);
        }
        return sources;
    }

    function sanitizeCalendarCounts(value) {
        const source = pickObject(value, ["total", "visible", "completed", "timed", "all_day", "allDay"]);
        if (!source) return undefined;
        const output = {};
        for (const [key, item] of Object.entries(source)) if (Number.isSafeInteger(item) && item >= 0) output[key === "allDay" ? "all_day" : key] = item;
        return Object.keys(output).length ? output : undefined;
    }

    function sanitizeCalendarRefresh(value) {
        const source = pickObject(value, ["state", "stale", "last_refreshed_at", "next_refresh_at", "retry_after_seconds"]);
        if (!source) return undefined;
        const output = {};
        if (typeof source.state === "string" && /^(?:fresh|stale|refreshing|unavailable|error)$/i.test(source.state)) output.state = source.state;
        if (typeof source.stale === "boolean") output.stale = source.stale;
        for (const key of ["last_refreshed_at", "next_refresh_at"]) {
            const instant = safeCalendarInstant(source[key]);
            if (instant) output[key] = instant;
        }
        if (Number.isSafeInteger(source.retry_after_seconds) && source.retry_after_seconds >= 0 && source.retry_after_seconds <= 86400) output.retry_after_seconds = source.retry_after_seconds;
        return Object.keys(output).length ? output : undefined;
    }

    function sanitizeCalendarRangeResponse(value, { allowedCanvasOrigins = [] } = {}) {
        if (!security.isPlainObject(value)) return {};
        const output = {};
        if (value.contractVersion === 1) output.contractVersion = 1;
        if (value.ok === true) output.ok = true;
        if (Array.isArray(value.events)) output.events = value.events.map((item) => sanitizeCalendarEvent(item, allowedCanvasOrigins)).filter(Boolean).slice(0, 2048);
        const sources = sanitizeCalendarSources(value.sources, allowedCanvasOrigins);
        if (sources !== undefined) output.sources = sources.slice(0, 256);
        const counts = sanitizeCalendarCounts(value.counts);
        if (counts !== undefined) output.counts = counts;
        const refresh = sanitizeCalendarRefresh(value.refresh);
        if (refresh !== undefined) output.refresh = refresh;
        if (typeof value.read_only === "boolean") output.read_only = value.read_only;
        const capabilities = sanitizeCalendarCapabilities(value.capabilities);
        if (capabilities !== undefined) output.capabilities = capabilities;
        return output;
    }

    function responseContainsSecret(value, allowLeaseToken = false, seen = new Set()) {
        if (value === null || typeof value !== "object") return security.findSensitiveData(value);
        if (seen.has(value)) return { reason: "cycle" };
        seen.add(value);
        const entries = Array.isArray(value) ? value.map((item, index) => [String(index), item]) : Object.entries(value);
        for (const [key, child] of entries) {
            if (allowLeaseToken && security.normalizeKey(key) === "leasetoken") {
                if (typeof child !== "string" || !child || child.length > 512 || /[\r\n]/.test(child)) return { reason: "lease" };
                continue;
            }
            const found = responseContainsSecret(child, allowLeaseToken, seen);
            if (found || security.findSensitiveData(child, key)) {
                seen.delete(value);
                return found || { path: key, reason: "sensitive" };
            }
        }
        seen.delete(value);
        return null;
    }

    function sanitizeResponseValue(value, field = "", { allowLeaseToken = false } = {}) {
        if (allowLeaseToken && security.normalizeKey(field) === "leasetoken") {
            if (typeof value !== "string" || !value || value.length > 512 || /[\r\n]/.test(value)) throw new Error("NEST_LEASE_INVALID");
            return value;
        }
        if (responseContainsSecret(value, allowLeaseToken)) throw new Error("NEST_RESPONSE_SECRET_REJECTED");
        if (Array.isArray(value)) return value.map((item) => sanitizeResponseValue(item, field, { allowLeaseToken }));
        if (security.isPlainObject(value)) {
            const sanitized = {};
            Object.entries(value).forEach(([key, item]) => {
                const normalized = security.normalizeKey(key);
                if (!SAFE_RESPONSE_FIELDS.has(normalized)) return;
                sanitized[key] = sanitizeResponseValue(item, normalized, { allowLeaseToken });
            });
            return sanitized;
        }
        if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return value;
        if (typeof value !== "string" || value.length > 8192 || security.hasCredentialLikeScalar(value)) throw new Error("NEST_RESPONSE_VALUE_REJECTED");
        if (/^https?:\/\//i.test(value)) {
            if (!SAFE_URL_FIELDS.has(security.normalizeKey(field)) || !security.validateSafeHttpsUrl(value)) throw new Error("NEST_RESPONSE_URL_REJECTED");
        }
        return value;
    }

    function validateResponseBodyObject(body, { allowLeaseToken = false, allowArray = false } = {}) {
        if ((!security.isPlainObject(body) && !(allowArray && Array.isArray(body))) || !security.isJsonSerializable(body)) throw new Error("NEST_RESPONSE_OBJECT_REQUIRED");
        if (responseContainsSecret(body, allowLeaseToken)) throw new Error("NEST_RESPONSE_SECRET_REJECTED");
        return sanitizeResponseValue(body, "", { allowLeaseToken });
    }

    function isJsonContentType(contentType) {
        return /^application\/(?:[A-Za-z0-9!#$&^_.+-]+\+)?json(?:\s*;|$)/i.test(String(contentType || "").trim());
    }

    function readHeaders(response, allowCsrfHeader) {
        const headers = {};
        if (!response?.headers?.forEach) return headers;
        response.headers.forEach((value, name) => {
            const lower = String(name).toLowerCase();
            if (SAFE_RESPONSE_HEADERS.has(lower) || (allowCsrfHeader && lower === "x-csrftoken")) headers[lower] = String(value).slice(0, 512);
        });
        return headers;
    }

    async function responseFromFetch(response, { allowCsrfHeader = false, allowLeaseToken = false, calendarRange = false, allowArray = false, allowedCanvasOrigins = [] } = {}) {
        const headers = readHeaders(response, allowCsrfHeader);
        if (!isJsonContentType(headers["content-type"])) throw new Error("NEST_RESPONSE_JSON_REQUIRED");
        if (!response || typeof response.text !== "function") throw new Error("NEST_RESPONSE_INVALID");
        const raw = await response.text();
        if (byteLength(raw) > MAX_RESPONSE_BYTES) throw new Error("NEST_RESPONSE_TOO_LARGE");
        let parsed;
        try { parsed = JSON.parse(raw); } catch (error) { throw new Error("NEST_RESPONSE_JSON_INVALID"); }
        const body = calendarRange
            ? sanitizeCalendarRangeResponse(parsed, { allowedCanvasOrigins })
            : validateResponseBodyObject(parsed, { allowLeaseToken, allowArray });
        return { ok: Boolean(response.ok), status: Number(response.status || 0), headers, body };
    }

    function isUnavailableResponse(response) {
        return !response || response.status === 0 || [502, 503, 504].includes(response.status);
    }

    function isAuthRejectedResponse(response) {
        return Number(response?.status) === 401 || Number(response?.status) === 403;
    }

    function isSafeAuthFallbackRequest(request) {
        if (!request || request.method !== "GET") return false;
        const matched = matchingPathRule(request.path, request.method);
        if (!matched) return false;
        // These are read-only identity/session bootstrap surfaces. A tab
        // fallback is deliberately not available to mutation or writeback
        // endpoints, even when a caller supplied an idempotency key.
        return new Set([
            "/api/extension/identity",
            "/api/extension/consent",
            "/api/extension/calendars",
            "/api/extension/calendar/sources",
            "/api/calendar/events"
        ]).has(matched.pathname);
    }

    function isConsentPath(path) {
        try {
            return new URL(`${NEST_ORIGIN}${path}`).pathname === "/api/extension/consent";
        } catch (error) {
            return false;
        }
    }

    function makeBridgeRequest(request, requestId, mutation) {
        return {
            kind: "APSTUDYCANVAS_NEST_BRIDGE_REQUEST",
            version: 1,
            request_id: requestId,
            request,
            ...(mutation ? { mutation } : {})
        };
    }

    function validateBridgeResponse(response, requestId, { allowLeaseToken = false, calendarRange = false, allowArray = false, allowedCanvasOrigins = [] } = {}) {
        if (!security.isPlainObject(response) || response.kind !== "APSTUDYCANVAS_NEST_BRIDGE_RESPONSE" || response.version !== 1 || response.request_id !== requestId) throw new Error("NEST_BRIDGE_RESPONSE_INVALID");
        if (response.headers && (!security.isPlainObject(response.headers) || Object.keys(response.headers).some((key) => !SAFE_RESPONSE_HEADERS.has(String(key).toLowerCase())))) throw new Error("NEST_BRIDGE_HEADERS_INVALID");
        if (response.body !== undefined) response.body = calendarRange
            ? sanitizeCalendarRangeResponse(response.body, { allowedCanvasOrigins })
            : validateResponseBodyObject(response.body, { allowLeaseToken, allowArray });
        if (response.code !== undefined && (typeof response.code !== "string" || security.hasCredentialLikeScalar(response.code))) throw new Error("NEST_BRIDGE_CODE_INVALID");
        return response;
    }

    function createNestTransport({ fetchImpl = (...args) => fetch(...args), findExactNestTab = async () => null, sendToTab = async () => null } = {}) {
        async function direct(request, requestId, options = {}) {
            let response;
            try {
                response = await fetchImpl(`${NEST_ORIGIN}${request.path}`, {
                    method: request.method,
                    credentials: "include",
                    ...(request.path === "/api/extension/calendars" || isConsentPath(request.path) || request.path.endsWith("/routing") || request.path.startsWith("/api/calendar/events?") ? { cache: "no-store" } : {}),
                    ...(options.signal ? { signal: options.signal } : {}),
                    headers: request.headers,
                    ...(request.body === undefined ? {} : { body: request.body })
                });
            } catch (error) {
                const unavailable = new Error("NEST_OFFLINE");
                unavailable.code = "NEST_OFFLINE";
                unavailable.unavailable = true;
                throw unavailable;
            }
            if (isUnavailableResponse(response)) return { ok: false, status: Number(response.status || 0), transport: "direct", request_id: requestId, ...(isConsentPath(request.path) || request.path.startsWith("/api/calendar/events?") ? { cache: "no-store" } : {}) };
            return Object.assign(await responseFromFetch(response, { ...options, allowArray: request.path.endsWith("/routing"), calendarRange: request.path.startsWith("/api/calendar/events?") }), { transport: "direct", request_id: requestId, ...(request.path === "/api/extension/calendars" || isConsentPath(request.path) || request.path.endsWith("/routing") || request.path.startsWith("/api/calendar/events?") ? { cache: "no-store" } : {}) });
        }

        async function exactNestTab() {
            const tab = await findExactNestTab();
            if (!tab || !Number.isInteger(tab.id)) {
                const error = new Error("NEST_UNAVAILABLE");
                error.code = "NEST_UNAVAILABLE";
                error.unavailable = true;
                throw error;
            }
            try {
                if (new URL(tab.url || "").origin !== NEST_ORIGIN) throw new Error("NEST_TAB_ORIGIN_INVALID");
            } catch (error) {
                const invalid = new Error("NEST_TAB_ORIGIN_INVALID");
                invalid.code = "NEST_TAB_ORIGIN_INVALID";
                throw invalid;
            }
            return tab;
        }

        async function viaExactNestTab(request, requestId, mutation, options = {}) {
            const tab = await exactNestTab();
            const raw = await sendToTab(tab.id, makeBridgeRequest(request, requestId, mutation));
            const response = validateBridgeResponse(raw, requestId, { ...options, allowArray: request.path.endsWith("/routing"), calendarRange: request.path.startsWith("/api/calendar/events?") });
            return Object.assign({ transport: "tab", tab_id: tab.id, ...(request.path === "/api/extension/calendars" || isConsentPath(request.path) || request.path.endsWith("/routing") || request.path.startsWith("/api/calendar/events?") ? { cache: "no-store" } : {}) }, response);
        }

        async function request(spec, { allowTabFallback = true, requestId = randomRequestId(), allowLeaseToken = false, signal } = {}) {
            const normalized = validateTransportRequest(spec);
            if (signal?.aborted) {
                const error = new Error("NEST_REQUEST_ABORTED");
                error.code = "NEST_REQUEST_ABORTED";
                throw error;
            }
            let directResponse;
            try {
                directResponse = await direct(normalized, requestId, { signal });
            } catch (error) {
                if (signal?.aborted || error?.name === "AbortError") {
                    const aborted = new Error("NEST_REQUEST_ABORTED");
                    aborted.code = "NEST_REQUEST_ABORTED";
                    throw aborted;
                }
                if (!allowTabFallback || !error?.unavailable) throw error;
                return viaExactNestTab(normalized, requestId, undefined, { allowLeaseToken });
            }
            if (allowTabFallback && isUnavailableResponse(directResponse)) return viaExactNestTab(normalized, requestId, undefined, { allowLeaseToken });
            if (allowTabFallback && isAuthRejectedResponse(directResponse) && isSafeAuthFallbackRequest(normalized)) {
                return viaExactNestTab(normalized, requestId, undefined, { allowLeaseToken });
            }
            return directResponse;
        }

        async function identityGet({ requestId = randomRequestId() } = {}) {
            try {
                return await request({ method: "GET", path: "/api/extension/identity", headers: { Accept: "application/json", "X-Request-ID": requestId } }, { requestId });
            } catch (error) {
                return { ok: false, code: error?.code || error?.message || "NEST_UNAVAILABLE", request_id: requestId };
            }
        }

        async function freshDirectCsrf(requestId) {
            const csrfRequest = validateTransportRequest({ method: "GET", path: "/api/extension/csrf", headers: { Accept: "application/json", "X-Request-ID": requestId } });
            const response = await direct(csrfRequest, requestId, { allowCsrfHeader: true });
            const token = response?.headers?.["x-csrftoken"];
            if (!response?.ok || typeof token !== "string" || !token || token.length > 512 || /[\r\n]/.test(token)) {
                const error = new Error("NEST_CSRF_UNAVAILABLE");
                error.code = "NEST_CSRF_UNAVAILABLE";
                error.unavailable = isUnavailableResponse(response);
                throw error;
            }
            return token;
        }

    function mutationRequest(base, csrf, requestId, idempotencyKey, options = {}) {
            return validateTransportRequest({
                method: base.method,
                path: base.path,
                body: base.body,
                headers: Object.assign({}, base.headers, {
                    "X-CSRFToken": csrf,
                    "X-Request-ID": requestId,
                    "Idempotency-Key": idempotencyKey,
                    "Content-Type": "application/json",
                    Accept: "application/json"
                })
            }, options);
        }

        async function mutate(spec, { requestId = randomRequestId(), idempotent = false, idempotencyKey = requestId, internalLease = false } = {}) {
            const base = validateTransportRequest(spec, { allowInternalLease: internalLease });
            if (base.method === "GET") throw new Error("NEST_MUTATION_METHOD_REQUIRED");
            if (typeof idempotencyKey !== "string" || !idempotencyKey || idempotencyKey.length > 160 || /[\r\n]/.test(idempotencyKey)) throw new Error("NEST_IDEMPOTENCY_KEY_INVALID");
            const bridgeMutation = { idempotent: Boolean(idempotent), idempotency_key: idempotencyKey };
            let csrf;
            try {
                csrf = await freshDirectCsrf(requestId);
            } catch (error) {
                if (!error?.unavailable) throw error;
                return viaExactNestTab(base, requestId, bridgeMutation, { allowLeaseToken: internalLease });
            }
            let retried = false;
            for (;;) {
                let response;
                try {
                    response = await direct(mutationRequest(base, csrf, requestId, idempotencyKey, { allowInternalLease: internalLease }), requestId, { allowLeaseToken: internalLease });
                } catch (error) {
                    if (error?.unavailable && idempotent) return viaExactNestTab(base, requestId, bridgeMutation, { allowLeaseToken: internalLease });
                    throw error;
                }
                if (isUnavailableResponse(response) && idempotent) return viaExactNestTab(base, requestId, bridgeMutation, { allowLeaseToken: internalLease });
                const csrfFailure = response.status === 403 || response.status === 419;
                if (!csrfFailure || !idempotent || retried) return Object.assign(response, { retried });
                retried = true;
                csrf = await freshDirectCsrf(requestId);
            }
        }

        return Object.freeze({ request, identityGet, mutate });
    }

    return Object.freeze({
        NEST_ORIGIN,
        MAX_BODY_BYTES,
        MAX_RESPONSE_BYTES,
        PATH_METHODS,
        ALLOWED_HEADERS,
        SAFE_RESPONSE_FIELDS,
        CALENDAR_RANGE_MAX_DAYS,
        CALENDAR_RANGE_MAX_MS,
        isStrictIsoInstant,
        sanitizeCalendarRangeResponse,
        validateTransportRequest,
        buildNestUrl,
        createNestTransport,
        sanitizeResponseValue,
        validateResponseBodyObject,
        responseFromFetch,
        makeBridgeRequest,
        validateBridgeResponse
    });
}));
