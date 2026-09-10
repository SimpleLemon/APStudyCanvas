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
        "/api/extension/todos": ["GET", "POST"],
        "/api/extension/calendars": ["GET"],
        "/api/extension/calendar/events": ["GET", "POST"],
        "/api/extension/calendar/preferences": ["GET", "POST"],
        "/api/extension/calendar/courses": ["GET"],
        "/api/extension/calendar/course-sections": ["GET"],
        "/api/extension/calendar/saved-courses": ["GET"],
        "/api/extension/calendar/shares": ["GET"],
        "/api/extension/mirrors": ["GET", "POST"],
        "/api/extension/calendar/event-overrides": ["POST"],
        "/api/extension/calendar/event-overrides/hide": ["POST"],
        "/api/extension/calendar/refresh": ["POST"],
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
    const TODO_TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
    const TODO_QUERY_FIELDS = Object.freeze(new Set([
        "limit", "offset", "page", "cursor", "start", "end", "from", "to", "start_date", "end_date",
        "due_start", "due_end", "completed", "undated", "include_undated"
    ]));
    const TODO_CREATE_FIELDS = Object.freeze(new Set([
        "title", "description", "link", "url", "source_url", "due", "due_at", "deadline_at", "due_date",
        "timezone", "time_zone", "priority", "canvas_account_key", "canvasAccountKey", "account_key",
        "canvas_course_id", "canvasCourseId", "course_id", "canvas_course_label", "canvasCourseLabel",
        "course_label", "type_label", "typeLabel", "type", "points_earned", "pointsEarned",
        "points_possible", "pointsPossible", "source_identity", "source", "source_key", "sourceKey",
        "source_item_key", "sourceItemKey", "canvas_source_item_key", "source_event_ref", "sourceEventRef",
        "canvas_event_ref", "idempotency_key", "idempotencyKey"
    ]));
    const CALENDAR_RANGE_MAX_DAYS = 62;
    const CALENDAR_RANGE_MAX_MS = CALENDAR_RANGE_MAX_DAYS * 24 * 60 * 60 * 1000;
    const STRICT_ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

    function isStrictIsoInstant(value) {
        if (typeof value !== "string" || !STRICT_ISO_INSTANT.test(value)) return false;
        const parsed = new Date(value);
        return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
    }
    const DYNAMIC_PATH_RULES = Object.freeze([
        { pattern: /^\/api\/extension\/calendar\/events\/([A-Za-z0-9][A-Za-z0-9._:-]{0,159})$/, methods: ["GET", "PUT", "DELETE"], query: new Set() },
        { pattern: /^\/api\/extension\/calendar\/sources$/, methods: ["GET", "POST"], query: new Set(["include_archived"]) },
        { pattern: /^\/api\/extension\/calendar\/sources\/(src1:[A-Za-z0-9._~-]{1,128})\/sync$/, methods: ["POST"], query: new Set() },
        { pattern: /^\/api\/extension\/calendar\/sources\/(src1:[A-Za-z0-9._~-]{1,128})\/sync\/([A-Za-z0-9._:-]{1,160})$/, methods: ["GET"], query: new Set(["generation"]) },
        { pattern: /^\/api\/extension\/calendar\/sources\/(src1:[A-Za-z0-9._~-]{1,128})\/sync\/([A-Za-z0-9._:-]{1,160})\/(?:resume|renew)$/, methods: ["PUT"], query: new Set() },
        { pattern: /^\/api\/extension\/calendar\/sources\/(src1:[A-Za-z0-9._~-]{1,128})\/sync\/([A-Za-z0-9._:-]{1,160})\/cancel$/, methods: ["POST"], query: new Set() },
        { pattern: /^\/api\/extension\/calendar\/sources\/(src1:[A-Za-z0-9._~-]{1,128})\/sync\/([A-Za-z0-9._:-]{1,160})\/(?:batch|batches|finalize)$/, methods: ["POST"], query: new Set() },
        { pattern: /^\/api\/extension\/calendar\/sources\/(src1:[A-Za-z0-9._~-]{1,128})\/routing$/, methods: ["GET", "PUT"], query: new Set() },
        { pattern: /^\/api\/extension\/calendar\/sources\/([A-Za-z0-9._:-]{1,160})\/(?:writebacks|writeback-intents)$/, methods: ["GET", "POST"], query: new Set(["account_key", "event_ref", "states", "limit"]) },
        { pattern: /^\/api\/extension\/calendar\/sources\/([A-Za-z0-9._:-]{1,160})\/writebacks\/([A-Za-z0-9._:-]{1,160})(?:\/result)?$/, methods: ["GET", "POST"], query: new Set() },
        { pattern: /^\/api\/extension\/calendar\/sources\/([A-Za-z0-9._:-]{1,160})\/writeback-results\/([A-Za-z0-9._:-]{1,160})$/, methods: ["POST"], query: new Set() },
        { pattern: /^\/api\/extension\/calendar\/sources\/([A-Za-z0-9._:-]{1,160})\/mirrors\/refresh$/, methods: ["POST"], query: new Set() },
        { pattern: /^\/api\/extension\/calendar\/sources\/([A-Za-z0-9._:-]{1,160})\/event-links$/, methods: ["GET", "POST"], query: new Set(["link_id", "event_ref"]) },
        { pattern: /^\/api\/extension\/calendar\/sources\/([A-Za-z0-9._:-]{1,160})\/event-links\/([A-Za-z0-9._:-]{1,160})\/unlink$/, methods: ["POST"], query: new Set() },
        { pattern: /^\/api\/extension\/calendar\/sources\/([A-Za-z0-9._:-]{1,160})\/writebacks\/([A-Za-z0-9._:-]{1,160})\/(?:conflict|resolve)$/, methods: ["GET", "POST"], query: new Set() },
        { pattern: /^\/api\/extension\/todos\/([A-Za-z0-9][A-Za-z0-9._:-]{0,159})\/completion$/, methods: ["PATCH"], query: new Set() }
    ]);
    const ALLOWED_HEADERS = Object.freeze(new Set(["accept", "content-type", "x-csrftoken", "x-request-id", "idempotency-key", "x-canvas-account-key"]));
    const SAFE_RESPONSE_HEADERS = Object.freeze(new Set(["content-type", "x-request-id", "retry-after", "x-apstudy-csrf-error"]));
    const SAFE_RESPONSE_FIELDS = Object.freeze(new Set([
        "calendarintegration", "calendarread", "calendarupload", "calendarprojection", "calendarmirroring",
        "calendartwowaywriteback", "calendarsourcemutation", "calendarsharesics", "upload", "projection", "mirroring", "mutation", "overlay", "replacement",
        "start", "end", "startat", "endat", "details", "tododate", "locationname", "locationaddress", "deleted", "choices", "copiesretained", "item", "allowed", "linked", "pendingid", "operationid", "destination", "conflict", "choice", "canvasrevision", "canvassnapshot", "nestsnapshot", "nestrevision", "resultrevision", "payload", "writebackid", "targetaccount", "targetcalendar", "nesteventid", "canvascontextid", "canvascalendarid", "canvasitemtype", "canvasitemid", "canvasoccurrenceid", "sourcerevision", "sourcehash", "mirrorstate", "linkid", "override", "eventscached", "preferences", "calendarname", "colorhex", "event", "startdate", "enddate", "allday", "isallday", "sourcetype", "editable",
        "provider", "defaultmirrorcalendar", "syncstate", "lastsyncstartedat", "lastsynccompletedat", "lastseenat", "lasterrorcode", "archivedat",
        "nestuserid", "startedat", "completedat", "cancelledat", "expiresat", "errorcode", "errormessage", "retrycount", "nextretryat",
        "page", "cursor", "descriptor", "descriptorindex", "fetched", "uploaded", "failed", "skipped", "total", "processed", "tombstoned", "acceptedcount", "rejectedcount", "counts",
        "username", "writebacks", "writeback", "writebackresult", "operation", "expectedrevision", "revision", "eventkind", "eventlink", "eventlinks",
        "ok", "status", "state", "code", "message", "error", "errors", "version", "current", "requestid",
        "contractversion", "identity", "authenticated", "userid", "accountid", "profile", "displayname", "name",
        "avatarurl", "sourceurl", "sourceorigin", "consent", "enabled", "granted", "revoked", "scopes",
        "calendars", "calendarid", "id", "title", "color", "timezone", "routing", "routingid", "routeid",
        "eventid", "eventref", "events", "updatedat", "createdat", "result", "results", "data", "count", "hasmore",
        "sources", "source", "sourceid", "sourceref", "source_ref", "sourcekey", "source_key", "accountkey", "label", "provideruserid", "consentversion", "run", "batch", "runid",
        "generation", "leaseexpiresat", "lease_token", "leasetoken", "checkpoint", "counters", "scope", "status",
        "accepted", "accepted_event_refs", "acceptedeventrefs", "quarantined", "batch_size", "batchsize", "payload_hash",
        "payloadhash", "idempotency_key", "idempotencykey", "idempotent", "retry_after", "retryafter", "capabilities",
        "fallback_calendar_id", "fallbackcalendarid", "destination_calendar_id", "destinationcalendarid", "calendar_name", "completion_status", "completion_source",
        "readonly", "read_only", "imported", "kind", "visible", "routing_eligible", "routingeligible", "routing_degraded", "routingdegraded",
        "todo", "todos", "list", "pagination", "has_more", "hasmore", "next_offset", "nextoffset", "description", "link", "url", "priority", "due",
        "deadline_at", "deadlineat", "deadline_time", "deadlinetime", "reminder_minutes", "reminderminutes", "completed", "completed_at", "completedat", "starred", "canvas_account_key", "canvasaccountkey",
        "canvas_course_id", "canvascourseid", "canvas_course_label", "canvascourselabel", "type_label", "typelabel", "points_earned", "pointsearned", "points_possible", "pointspossible", "source_identity", "sourceidentity",
        "source_item_key", "sourceitemkey", "source_event_ref", "sourceeventref", "created_at", "updated_at", "order", "collapsed", "hidden", "sort_mode", "sortmode", "list_id", "listid"
    ]));
    const SAFE_URL_FIELDS = Object.freeze(new Set(["avatarurl", "sourceurl", "sourceorigin", "link", "url"]));

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
        if ((pathname === "/api/calendar/events" || pathname === "/api/extension/calendar/events") && method === "GET") {
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
                const allowed = pathname === "/api/extension/consent"
                    ? new Set(["source_key", "account_key", "version"])
                    : pathname === "/api/extension/calendar/courses" ? new Set(["q", "term", "limit", "offset"])
                    : pathname === "/api/extension/calendar/course-sections" ? new Set(["ids"])
                    : pathname === "/api/extension/todos" ? TODO_QUERY_FIELDS : pathname === "/api/extension/mirrors" ? new Set(["event_ref"]) : new Set();
                for (const [key, value] of parsed.searchParams.entries()) {
                    const maxLength = pathname === "/api/extension/calendar/course-sections" && key === "ids" ? 16100 : 512;
                    if (!allowed.has(key) || !value || value.length > maxLength || security.hasCredentialLikeScalar(value)) return null;
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

    function validateTodoQuery(query = {}) {
        if (!security.isPlainObject(query)) throw new Error("NEST_TODO_QUERY_OBJECT_REQUIRED");
        const output = {};
        for (const [key, value] of Object.entries(query)) {
            if (!TODO_QUERY_FIELDS.has(key)) throw new Error("NEST_TODO_QUERY_FIELD_NOT_ALLOWLISTED");
            if (value === undefined || value === null || value === "") continue;
            if (typeof value === "boolean") output[key] = String(value);
            else if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) output[key] = String(value);
            else if (typeof value === "string" && value.length <= 512 && !/[\r\n]/.test(value) && !security.hasCredentialLikeScalar(value)) output[key] = value;
            else throw new Error("NEST_TODO_QUERY_VALUE_INVALID");
        }
        return output;
    }

    function serializeTodoQuery(query = {}) {
        const normalized = validateTodoQuery(query);
        const params = new URLSearchParams();
        for (const key of Object.keys(normalized).sort()) params.set(key, normalized[key]);
        return params.toString();
    }

    function validateTodoCreatePayload(payload) {
        if (!security.isPlainObject(payload)) throw new Error("NEST_TODO_CREATE_PAYLOAD_OBJECT_REQUIRED");
        if (Object.keys(payload).some((key) => !TODO_CREATE_FIELDS.has(key))) throw new Error("NEST_TODO_CREATE_FIELD_NOT_ALLOWLISTED");
        if (!Object.prototype.hasOwnProperty.call(payload, "title")) throw new Error("NEST_TODO_CREATE_TITLE_REQUIRED");
        return Object.freeze({ ...payload });
    }

    function validateTodoTaskId(taskId) {
        if (typeof taskId !== "string" || !TODO_TASK_ID_PATTERN.test(taskId)) throw new Error("NEST_TODO_TASK_ID_INVALID");
        return taskId;
    }

    function validateTodoCompletionPayload(payload) {
        if (!security.isPlainObject(payload) || Object.keys(payload).length !== 1 || typeof payload.completed !== "boolean") {
            throw new Error("NEST_TODO_COMPLETION_PAYLOAD_INVALID");
        }
        return Object.freeze({ completed: payload.completed });
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

    function safeCalendarInstant(value, allDay = false) {
        if (typeof value !== "string") return undefined;
        if (allDay && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
            const parsed = new Date(`${value}T00:00:00.000Z`);
            return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : undefined;
        }
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return undefined;
        const parsed = new Date(value);
        return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined;
    }

    function pickObject(value, allowedKeys) {
        if (!security.isPlainObject(value)) return undefined;
        const output = {};
        for (const key of allowedKeys) if (Object.prototype.hasOwnProperty.call(value, key)) output[key] = value[key];
        return output;
    }

    function sanitizeCalendarCapabilities(value) {
        const source = pickObject(value, ["read_only", "recurrence", "upload", "projection", "overlay", "replacement", "mutation", "mirroring", "calendar_integration", "calendar_read", "calendar_upload", "calendar_projection", "calendar_mirroring", "calendar_two_way_writeback"]);
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
        const allDay = value.all_day === true || value.is_all_day === true;
        const start = safeCalendarInstant(value.start ?? value.start_date ?? value.start_at ?? value.start_time, allDay);
        const end = safeCalendarInstant(value.end ?? value.end_date ?? value.end_at ?? value.end_time, allDay);
        if (!title || !start || !end || !(Date.parse(start) < Date.parse(end))) return null;
        output.title = title;
        output.start = start;
        output.end = end;
        for (const key of ["all_day", "is_all_day", "timed", "multi_day", "is_multi_day", "completed", "read_only"]) if (typeof value[key] === "boolean") output[key] = value[key];
        for (const key of ["id", "calendar_id", "original_calendar_id"]) {
            if (typeof value[key] === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value[key])) output[key] = value[key];
        }
        if (typeof value.event_ref === "string" && /^(?:user|task|feed|canvas):[A-Za-z0-9._:~-]{1,255}$/.test(value.event_ref)) output.event_ref = value.event_ref;
        if (["user", "task", "feed", "canvas", "native"].includes(value.source_type)) output.source_type = value.source_type;
        if (typeof value.editable === "boolean") output.editable = value.editable && ["user", "native"].includes(output.source_type) && /^user:/.test(output.event_ref || "");
        if (Number.isInteger(value.reminder_minutes) && value.reminder_minutes >= 0 && value.reminder_minutes <= 525600) output.reminder_minutes = value.reminder_minutes;
        const color = safeCalendarColor(value.color);
        if (color) output.color = color;
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
            for (const key of ["id", "calendar_id"]) if (typeof item[key] === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(item[key])) source[key] = item[key];
            for (const key of ["visible", "editable", "imported"]) if (typeof item[key] === "boolean") source[key] = item[key];
            for (const key of ["name", "display_name", "type", "source_type"]) { const text = safeCalendarText(item[key], 160); if (text) source[key] = text; }
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

    function safeAuxText(value, limit) {
        if (typeof value !== "string") return undefined;
        const text = value.trim();
        return text && text.length <= limit && !security.hasCredentialLikeScalar(text) ? text : undefined;
    }

    function sanitizeCourseSection(value) {
        if (!security.isPlainObject(value)) return null;
        const id = safeAuxText(String(value.id ?? value.section_id ?? ""), 160);
        if (!id || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(id)) return null;
        const output = { id };
        for (const [key, limit] of Object.entries({ term: 64, subject: 32, course_code: 64, course_title: 512, catalog_number: 32, section_number: 32, instructor: 256, type: 64 })) {
            const text = safeAuxText(value[key], limit);
            if (text) output[key] = text;
        }
        if (typeof value.is_cancelled === "boolean") output.is_cancelled = value.is_cancelled;
        const instructors = Array.isArray(value.instructors_unique) ? value.instructors_unique : Array.isArray(value.instructors) ? value.instructors : [];
        output.instructors_unique = instructors.map((item) => safeAuxText(item, 256)).filter(Boolean).slice(0, 16);
        if (security.isPlainObject(value.date_range)) {
            const start = safeAuxText(value.date_range.start, 10);
            const end = safeAuxText(value.date_range.end, 10);
            if (/^\d{4}-\d{2}-\d{2}$/.test(start || "") && /^\d{4}-\d{2}-\d{2}$/.test(end || "")) output.date_range = { start, end };
        }
        output.meetings = (Array.isArray(value.meetings) ? value.meetings : []).map((meeting) => {
            if (!security.isPlainObject(meeting)) return null;
            const day = safeAuxText(meeting.day, 8);
            const start = safeAuxText(meeting.start, 16);
            const end = safeAuxText(meeting.end, 16);
            if (!/^(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)$/.test(day || "") || !start || !end) return null;
            const clean = { day, start, end };
            const location = safeAuxText(meeting.location, 256);
            if (location) clean.location = location;
            return clean;
        }).filter(Boolean).slice(0, 32);
        return output;
    }

    function sanitizeCalendarAuxResponse(value, kind) {
        if (!security.isPlainObject(value)) throw new Error("NEST_CALENDAR_AUX_RESPONSE_INVALID");
        const output = {};
        if (typeof value.ok === "boolean") output.ok = value.ok;
        if (Number.isInteger(value.contractVersion)) output.contractVersion = value.contractVersion;
        if (value.error !== undefined) output.error = sanitizeResponseValue(value.error, "error");
        if (kind === "courses" || kind === "saved" || kind === "sections") {
            const key = kind === "saved" ? "courses" : "sections";
            output[key] = (Array.isArray(value[key]) ? value[key] : []).map(sanitizeCourseSection).filter(Boolean).slice(0, kind === "sections" ? 100 : 100);
            if (kind === "courses") output.terms = (Array.isArray(value.terms) ? value.terms : []).map((item) => safeAuxText(item, 64)).filter(Boolean).slice(0, 64);
            for (const keyName of ["total", "count", "offset", "limit"]) if (Number.isSafeInteger(value[keyName]) && value[keyName] >= 0) output[keyName] = value[keyName];
            if (typeof value.has_more === "boolean") output.has_more = value.has_more;
            if (kind === "saved" && typeof value.supported === "boolean") output.supported = value.supported;
        } else if (kind === "shares") {
            output.shares = (Array.isArray(value.shares) ? value.shares : []).map((share) => {
                if (!security.isPlainObject(share)) return null;
                const id = safeAuxText(share.id, 160);
                if (!id) return null;
                const clean = { id };
                for (const [key, limit] of Object.entries({ shareCode: 160, dateScope: 32, fixedStart: 10, fixedEnd: 10, scopeLabel: 256, createdAt: 64, updatedAt: 64 })) {
                    const text = safeAuxText(share[key], limit); if (text) clean[key] = text;
                }
                if (typeof share.shareUrl === "string") {
                    try {
                        const url = new URL(share.shareUrl);
                        if (url.origin === NEST_ORIGIN && /^\/calendar\/shared\/[A-Za-z0-9._~-]{1,160}$/.test(url.pathname) && !url.search && !url.hash) clean.shareUrl = url.href;
                    } catch (error) {}
                }
                for (const key of ["isActive", "includeAllCalendars", "icsConfigured", "icsEnabled"]) if (typeof share[key] === "boolean") clean[key] = share[key];
                if (Number.isInteger(share.rollingDays) && share.rollingDays >= 0 && share.rollingDays <= 3660) clean.rollingDays = share.rollingDays;
                clean.calendarIds = (Array.isArray(share.calendarIds) ? share.calendarIds : []).map((item) => safeAuxText(item, 160)).filter(Boolean).slice(0, 100);
                return clean;
            }).filter(Boolean).slice(0, 100);
            if (Number.isSafeInteger(value.count) && value.count >= 0) output.count = value.count;
        }
        return output;
    }

    function calendarAuxKind(path) {
        const pathname = String(path || "").split("?")[0];
        return ({ "/api/extension/calendar/courses": "courses", "/api/extension/calendar/course-sections": "sections", "/api/extension/calendar/saved-courses": "saved", "/api/extension/calendar/shares": "shares" })[pathname] || "";
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
            if (found || security.findSensitiveData(null, key)) {
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

    async function responseFromFetch(response, { allowCsrfHeader = false, allowLeaseToken = false, calendarRange = false, calendarAux = "", allowArray = false, allowedCanvasOrigins = [] } = {}) {
        const headers = readHeaders(response, allowCsrfHeader);
        if (!isJsonContentType(headers["content-type"])) throw new Error("NEST_RESPONSE_JSON_REQUIRED");
        if (!response || typeof response.text !== "function") throw new Error("NEST_RESPONSE_INVALID");
        const raw = await response.text();
        if (byteLength(raw) > MAX_RESPONSE_BYTES) throw new Error("NEST_RESPONSE_TOO_LARGE");
        let parsed;
        try { parsed = JSON.parse(raw); } catch (error) { throw new Error("NEST_RESPONSE_JSON_INVALID"); }
        // Older Nest deployments return this bootstrap secret in JSON. Move it
        // into the private CSRF header channel before the public-body sanitizer.
        if (allowCsrfHeader && security.isPlainObject(parsed) && Object.prototype.hasOwnProperty.call(parsed, "csrfToken")) {
            const token = parsed.csrfToken;
            if (typeof token !== "string" || !token || token.length > 512 || /[\r\n]/.test(token)) throw new Error("NEST_CSRF_UNAVAILABLE");
            if (headers["x-csrftoken"] && headers["x-csrftoken"] !== token) throw new Error("NEST_CSRF_UNAVAILABLE");
            headers["x-csrftoken"] = token;
            delete parsed.csrfToken;
        }
        const body = calendarRange
            ? sanitizeCalendarRangeResponse(parsed, { allowedCanvasOrigins })
            : calendarAux ? sanitizeCalendarAuxResponse(parsed, calendarAux)
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
            "/api/extension/todos",
            "/api/calendar/events",
            "/api/extension/calendar/events",
            "/api/extension/calendar/preferences",
            "/api/extension/calendar/courses",
            "/api/extension/calendar/course-sections",
            "/api/extension/calendar/saved-courses",
            "/api/extension/calendar/shares"
        ]).has(matched.pathname);
    }

    function isCalendarRangePath(path) { return /^\/api\/(?:extension\/calendar|calendar)\/events\?/.test(path || ""); }

    function isInternalSyncPath(path) {
        return /^\/api\/extension\/calendar\/sources\/(?:src1:|src1%3A)[A-Za-z0-9._~-]{1,128}\/sync(?:\/|\?|$)/i.test(path || "");
    }

    function isConsentPath(path) {
        try {
            return new URL(`${NEST_ORIGIN}${path}`).pathname === "/api/extension/consent";
        } catch (error) {
            return false;
        }
    }

    function makeBridgeRequest(request, requestId, mutation, { allowLeaseToken = false } = {}) {
        return {
            kind: "APSTUDYCANVAS_NEST_BRIDGE_REQUEST",
            version: 1,
            request_id: requestId,
            request,
            ...(allowLeaseToken && isInternalSyncPath(request.path) ? { internal_sync: true } : {}),
            ...(mutation ? { mutation } : {})
        };
    }

    function validateBridgeResponse(response, requestId, { allowLeaseToken = false, calendarRange = false, calendarAux = "", allowArray = false, allowedCanvasOrigins = [] } = {}) {
        if (!security.isPlainObject(response) || response.kind !== "APSTUDYCANVAS_NEST_BRIDGE_RESPONSE" || response.version !== 1 || response.request_id !== requestId) throw new Error("NEST_BRIDGE_RESPONSE_INVALID");
        if (response.headers && (!security.isPlainObject(response.headers) || Object.keys(response.headers).some((key) => !SAFE_RESPONSE_HEADERS.has(String(key).toLowerCase())))) throw new Error("NEST_BRIDGE_HEADERS_INVALID");
        if (response.body !== undefined) response.body = calendarRange
            ? sanitizeCalendarRangeResponse(response.body, { allowedCanvasOrigins })
            : calendarAux ? sanitizeCalendarAuxResponse(response.body, calendarAux)
            : validateResponseBodyObject(response.body, { allowLeaseToken, allowArray });
        if (response.code !== undefined && (typeof response.code !== "string" || security.hasCredentialLikeScalar(response.code))) throw new Error("NEST_BRIDGE_CODE_INVALID");
        return response;
    }

    async function boundedOperation(operation, { signal, timeoutMs = 12000 } = {}) {
        if (signal?.aborted) throw Object.assign(new Error("NEST_REQUEST_ABORTED"), { code: "NEST_REQUEST_ABORTED" });
        const abort = new AbortController();
        let timer;
        let onAbort;
        const interrupted = new Promise((_, reject) => {
            onAbort = () => { abort.abort(); reject(Object.assign(new Error("NEST_REQUEST_ABORTED"), { code: "NEST_REQUEST_ABORTED" })); };
            signal?.addEventListener("abort", onAbort, { once: true });
            timer = setTimeout(() => {
                abort.abort();
                reject(Object.assign(new Error("NEST_REQUEST_TIMEOUT"), { code: "NEST_REQUEST_TIMEOUT", unavailable: true }));
            }, timeoutMs);
        });
        try { return await Promise.race([Promise.resolve().then(() => operation(abort.signal)), interrupted]); }
        finally { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); }
    }

    function isCsrfFailure(response) {
        return [403, 419].includes(response?.status) || (response?.status === 400 && response?.headers?.["x-apstudy-csrf-error"] === "1");
    }

    function createNestTransport({ fetchImpl = (...args) => fetch(...args), findExactNestTab = async () => null, sendToTab = async () => null, timeoutMs = 12000 } = {}) {
        function noStorePath(path) { return path.startsWith("/api/extension/") || path.startsWith("/api/calendar/events?"); }

        async function direct(request, requestId, options = {}) {
            return boundedOperation(async (signal) => {
                let response;
                try {
                    response = await fetchImpl(`${NEST_ORIGIN}${request.path}`, {
                        method: request.method, credentials: "include", cache: "no-store", signal,
                        headers: request.headers,
                        ...(request.body === undefined ? {} : { body: request.body })
                    });
                } catch (error) {
                    if (signal.aborted) throw error;
                    throw Object.assign(new Error("NEST_OFFLINE"), { code: "NEST_OFFLINE", unavailable: true });
                }
                if (isUnavailableResponse(response)) return { ok: false, status: Number(response.status || 0), transport: "direct", request_id: requestId, cache: "no-store" };
                return Object.assign(await responseFromFetch(response, { ...options, allowArray: request.path.endsWith("/routing"), calendarRange: isCalendarRangePath(request.path), calendarAux: calendarAuxKind(request.path) }), { transport: "direct", request_id: requestId, cache: "no-store" });
            }, { signal: options.signal, timeoutMs });
        }

        async function exactNestTab(createIfMissing = false) {
            const tab = await findExactNestTab({ createIfMissing });
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
            const tab = await boundedOperation(() => exactNestTab(Boolean(mutation)), { signal: options.signal, timeoutMs });
            const raw = await boundedOperation(() => sendToTab(tab.id, makeBridgeRequest(request, requestId, mutation, options)), { signal: options.signal, timeoutMs });
            const response = validateBridgeResponse(raw, requestId, { ...options, allowArray: request.path.endsWith("/routing"), calendarRange: isCalendarRangePath(request.path), calendarAux: calendarAuxKind(request.path) });
            return Object.assign({ transport: "tab", tab_id: tab.id, ...(noStorePath(request.path) ? { cache: "no-store" } : {}) }, response);
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
                directResponse = await direct(normalized, requestId, { signal, allowLeaseToken });
            } catch (error) {
                if (signal?.aborted || error?.name === "AbortError") {
                    const aborted = new Error("NEST_REQUEST_ABORTED");
                    aborted.code = "NEST_REQUEST_ABORTED";
                    throw aborted;
                }
                if (!allowTabFallback || !error?.unavailable) throw error;
                return viaExactNestTab(normalized, requestId, undefined, { allowLeaseToken, signal });
            }
            if (allowTabFallback && isUnavailableResponse(directResponse)) return viaExactNestTab(normalized, requestId, undefined, { allowLeaseToken, signal });
            if (allowTabFallback && isAuthRejectedResponse(directResponse) && isSafeAuthFallbackRequest(normalized)) {
                try { return await viaExactNestTab(normalized, requestId, undefined, { allowLeaseToken, signal }); }
                catch (error) {
                    if (error?.code === "NEST_UNAVAILABLE") return directResponse;
                    throw error;
                }
            }
            return directResponse;
        }

        async function listTodos(query = {}, { requestId = randomRequestId(), allowTabFallback = true, signal } = {}) {
            const serialized = serializeTodoQuery(query);
            const path = `/api/extension/todos${serialized ? `?${serialized}` : ""}`;
            return request({ method: "GET", path, headers: { Accept: "application/json", "X-Request-ID": requestId } }, { requestId, allowTabFallback, signal });
        }

        async function createTodo(payload, options = {}) {
            const body = validateTodoCreatePayload(payload);
            const requestId = options.requestId || randomRequestId();
            const payloadKey = body.idempotency_key ?? body.idempotencyKey;
            const idempotencyKey = options.idempotencyKey ?? payloadKey ?? requestId;
            if (payloadKey !== undefined && options.idempotencyKey !== undefined && payloadKey !== options.idempotencyKey) throw new Error("NEST_TODO_IDEMPOTENCY_KEY_CONFLICT");
            return mutate({ method: "POST", path: "/api/extension/todos", body, headers: { Accept: "application/json" } }, {
                requestId,
                idempotent: true,
                idempotencyKey
            });
        }

        async function setTodoCompletion(taskId, payload, { requestId = randomRequestId(), idempotencyKey = requestId } = {}) {
            const normalizedTaskId = validateTodoTaskId(taskId);
            const body = validateTodoCompletionPayload(payload);
            return mutate({ method: "PATCH", path: `/api/extension/todos/${encodeURIComponent(normalizedTaskId)}/completion`, body, headers: { Accept: "application/json" } }, {
                requestId,
                idempotent: true,
                idempotencyKey
            });
        }

        const todos = Object.freeze({
            list: listTodos,
            get: listTodos,
            create: createTodo,
            setCompletion: setTodoCompletion,
            complete: setTodoCompletion
        });

        async function identityGet({ requestId = randomRequestId(), signal } = {}) {
            try {
                return await request({ method: "GET", path: "/api/extension/identity", headers: { Accept: "application/json", "X-Request-ID": requestId } }, { requestId, signal });
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
                error.unavailable = isUnavailableResponse(response) || isAuthRejectedResponse(response);
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
                const csrfFailure = isCsrfFailure(response);
                // A fresh token cannot repair an extension-origin HTTPS referrer.
                // Retry in Nest's own context, with its own token and the same key.
                if (csrfFailure && idempotent && retried) return viaExactNestTab(base, requestId, bridgeMutation, { allowLeaseToken: internalLease });
                if (!csrfFailure || !idempotent || retried) return Object.assign(response, { retried });
                retried = true;
                csrf = await freshDirectCsrf(requestId);
            }
        }

        return Object.freeze({ request, identityGet, mutate, todos, listTodos, createTodo, setTodoCompletion });
    }

    return Object.freeze({
        NEST_ORIGIN,
        boundedOperation,
        isCsrfFailure,
        isInternalSyncPath,
        isCalendarRangePath,
        MAX_BODY_BYTES,
        MAX_RESPONSE_BYTES,
        PATH_METHODS,
        TODO_TASK_ID_PATTERN,
        TODO_QUERY_FIELDS,
        TODO_CREATE_FIELDS,
        ALLOWED_HEADERS,
        SAFE_RESPONSE_FIELDS,
        CALENDAR_RANGE_MAX_DAYS,
        CALENDAR_RANGE_MAX_MS,
        isStrictIsoInstant,
        sanitizeCalendarRangeResponse,
        sanitizeCalendarAuxResponse,
        validateTransportRequest,
        validateTodoQuery,
        serializeTodoQuery,
        validateTodoCreatePayload,
        validateTodoTaskId,
        validateTodoCompletionPayload,
        buildNestUrl,
        createNestTransport,
        sanitizeResponseValue,
        validateResponseBodyObject,
        responseFromFetch,
        makeBridgeRequest,
        validateBridgeResponse
    });
}));
