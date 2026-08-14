(function (root, factory) {
    "use strict";

    const identity = root?.APStudyCanvasCanvasAdapter?.Identity || (typeof require === "function" ? require("./identity.js") : null);
    const contracts = root?.APStudyCanvasCanvasAdapter?.Contracts || (typeof require === "function" ? require("./contracts.js") : null);
    const security = root?.APStudyCanvasPlatform?.Security || (typeof require === "function" ? require("../platform/security.js") : null);
    const api = factory(identity, contracts, security);
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasCanvasAdapter = Object.assign(root.APStudyCanvasCanvasAdapter || {}, { Normalizers: api });
}(typeof globalThis !== "undefined" ? globalThis : this, function (identity, contracts, security) {
    "use strict";

    const VERSION = 1;
    const SAFE_TEXT_LIMIT = 200000;
    const SAFE_TITLE_LIMIT = 1000;
    const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
    const INSTANT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})$/i;
    const SUPPORTED_TYPES = Object.freeze(["assignment", "quiz", "discussion_topic", "planner_note", "calendar_event"]);

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

    function text(value, limit = SAFE_TEXT_LIMIT) {
        if (typeof value !== "string" && typeof value !== "number") return null;
        const result = String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
        return result ? result.slice(0, limit) : null;
    }

    function idValue(value) {
        if (typeof value !== "string" && typeof value !== "number") return null;
        if (typeof value === "number" && !Number.isSafeInteger(value)) return null;
        const result = String(value).trim();
        return result && result.length <= 256 && !/[\u0000-\u001f\u007f]/.test(result) ? result : null;
    }

    function canvasIdValue(value) {
        if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
        if (typeof value !== "string" || !/^[1-9]\d{0,19}$/.test(value)) return null;
        return value;
    }

    function sourceTimezone(value) {
        const candidate = text(value, 128);
        if (!candidate || security?.hasCredentialLikeScalar?.(candidate)) return null;
        // IANA names, common Rails names, or an explicit offset are all safe
        // provenance values. Do not accept arbitrary control/punctuation data.
        return /^[A-Za-z0-9_./+ -]+$/.test(candidate) ? candidate : null;
    }

    function sourceOffset(value) {
        if (typeof value !== "string") return null;
        if (/Z$/i.test(value)) return "Z";
        const match = value.match(/([+-]\d{2}:\d{2})$/);
        return match ? match[1] : null;
    }

    function isValidDateOnly(value) {
        if (!DATE_ONLY_PATTERN.test(String(value || ""))) return false;
        const [year, month, day] = String(value).split("-").map(Number);
        const date = new Date(Date.UTC(year, month - 1, day));
        return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
    }

    function isValidInstant(value) {
        const match = String(value || "").match(INSTANT_PATTERN);
        if (!match) return false;
        const [, year, month, day, hour, minute, second = "00", , zone] = match;
        const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
        if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() !== Number(month) - 1 || date.getUTCDate() !== Number(day)) return false;
        if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return false;
        if (zone.toUpperCase() !== "Z") {
            const offset = zone.slice(1).split(":").map(Number);
            if (offset[0] > 23 || offset[1] > 59) return false;
        }
        return Number.isFinite(Date.parse(value));
    }

    function parseDateValue(value, { allowDateOnly = true, allDay = false, timezone = null } = {}) {
        const candidate = text(value, 128);
        if (!candidate) return null;
        if (allowDateOnly && DATE_ONLY_PATTERN.test(candidate)) {
            if (!isValidDateOnly(candidate) || !allDay && !allowDateOnly) return null;
            return {
                kind: "all_day",
                date: candidate,
                sourceTimezone: sourceTimezone(timezone),
                sourceOffset: null
            };
        }
        if (allDay || !isValidInstant(candidate)) return null;
        const offset = sourceOffset(candidate);
        return {
            kind: "instant",
            utcInstant: new Date(Date.parse(candidate)).toISOString(),
            sourceTimezone: sourceTimezone(timezone) || (offset === "Z" ? "UTC" : offset),
            sourceOffset: offset
        };
    }

    function normalizedOrigin(value) {
        if (typeof value !== "string" || !value.trim()) return null;
        try {
            const url = new URL(value.trim());
            if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
            if (url.pathname !== "" && url.pathname !== "/") return null;
            return url.origin;
        } catch (error) {
            return null;
        }
    }

    function allowedOrigins(expectedOrigin, allowlist) {
        return new Set([expectedOrigin, ...(Array.isArray(allowlist) ? allowlist : [])].map(normalizedOrigin).filter(Boolean));
    }

    function safeUrl(value, expectedOrigin, { sameOrigin = true, allowedSourceOrigins = [] } = {}) {
        if (typeof value !== "string" || value.trim().length > 2048) return null;
        try {
            const url = new URL(value.trim());
            if (url.protocol !== "https:" || url.username || url.password || url.hash || /\.ics$/i.test(url.pathname)) return null;
            const origins = allowedOrigins(expectedOrigin, allowedSourceOrigins);
            if (sameOrigin && !origins.has(url.origin)) return null;
            if (!sameOrigin && origins.size && !origins.has(url.origin)) return null;
            for (const [key, item] of url.searchParams.entries()) {
                const normalizedKey = String(key).toLowerCase().replace(/[^a-z0-9]/g, "");
                if (/(?:token|secret|password|authorization|cookie|csrf|session|private|credential|apikey|accesskey|privateics)/i.test(normalizedKey)) return null;
                if (security?.hasCredentialLikeScalar?.(item)) return null;
            }
            return url.href;
        } catch (error) {
            return null;
        }
    }

    function safeReason(code) {
        const known = new Set([
            "CANVAS_ITEM_TYPE_UNSUPPORTED",
            "CANVAS_ANNOUNCEMENT_UNSUPPORTED",
            "CANVAS_REMOTE_ID_MISSING",
            "CANVAS_CONTEXT_ID_MISSING",
            "CANVAS_ACCOUNT_EXPECTED_INVALID",
            "CANVAS_DATE_MISSING",
            "CANVAS_DATE_INVALID",
            "CANVAS_END_DATE_MISSING",
            "CANVAS_END_DATE_INVALID",
            "CANVAS_OCCURRENCE_ID_UNSTABLE",
            "CANVAS_RECURRENCE_UNSTABLE",
            "CANVAS_OCCURRENCE_REQUIRED",
            "CANVAS_PAYLOAD_SENSITIVE",
            "CANVAS_SOURCE_URL_INVALID",
            "CANVAS_SOURCE_INVALID"
        ]);
        return known.has(code) ? code : "CANVAS_ITEM_QUARANTINED";
    }

    function quarantine(type, code, extra = {}) {
        const reasonCode = safeReason(code);
        return {
            ok: false,
            state: "quarantined",
            type: typeof type === "string" ? type.slice(0, 80) : null,
            code: reasonCode,
            reason: { code: reasonCode },
            items: [],
            ...(extra.count ? { quarantinedCount: extra.count } : {})
        };
    }

    function unsupported(type) {
        return { ok: false, state: "unsupported", type: text(type, 80), code: "CANVAS_ITEM_TYPE_UNSUPPORTED", items: [] };
    }

    function isAnnouncement(item) {
        return item?.is_announcement === true || item?.announcement === true || item?.topic_type === "announcement" || item?.type === "announcement";
    }

    function completionSubmission(value, type) {
        if (Array.isArray(value)) {
            for (const item of value) {
                const candidate = completionSubmission(item, type);
                if (candidate.present) return candidate;
            }
            return { present: false, complete: false };
        }
        if (!isPlainObject(value)) return { present: false, complete: false };
        const state = String(value.workflow_state || value.status || "").toLowerCase();
        const complete = type === "quiz"
            ? state === "complete" || Boolean(value.finished_at)
            : Boolean(value.submitted_at) || ["submitted", "graded", "pending_review"].includes(state);
        return { present: true, complete };
    }

    function completionOverride(value) {
        if (!isPlainObject(value)) return { present: false, complete: false };
        return { present: true, complete: value.marked_complete === true };
    }

    function reconcileCompletion({ submission = null, plannerOverride = null, notApplicable = false, type = "" } = {}) {
        const submissionState = completionSubmission(submission, type);
        const overrideState = completionOverride(plannerOverride);
        if (!submissionState.present && !overrideState.present && notApplicable) return "not_applicable";
        if (submissionState.complete || overrideState.complete) {
            if (submissionState.present && overrideState.present) return "completed/submission+planner_override";
            if (submissionState.complete) return "completed/submission";
            return "completed/planner_override";
        }
        return "incomplete/none";
    }

    function completionFor(type, item, registry) {
        let submission = item?.submission ?? item?.submissions;
        let plannerOverride = item?.planner_override ?? item?.plannerOverride;
        if (type === "discussion_topic") {
            const assignment = item?.assignment || {};
            submission = submission ?? assignment.submission;
            plannerOverride = plannerOverride ?? assignment.planner_override;
        }
        if (type === "quiz") submission = item?.submission ?? item?.quiz_submission ?? item?.quizSubmissions;
        const notApplicable = !registry.completion?.supported || (type === "calendar_event" && !plannerOverride);
        return reconcileCompletion({ submission, plannerOverride, notApplicable, type });
    }

    function occurrenceCandidates(type, item, remoteId) {
        const candidates = [];
        const add = (dateValue, occurrenceId, field, timezone = null) => candidates.push({ dateValue, occurrenceId, field, timezone });
        if (type === "assignment" || type === "quiz") {
            if (Array.isArray(item?.all_dates) && item.all_dates.length) {
                item.all_dates.forEach((date) => {
                    if (!isPlainObject(date)) return;
                    const occurrenceId = date.id !== undefined && date.id !== null ? canvasIdValue(date.id) : date.base === true ? remoteId : undefined;
                    add(date.due_at, occurrenceId, "all_dates[].due_at", date.timezone || date.time_zone);
                });
            } else add(item?.due_at, remoteId, "due_at");
        } else if (type === "discussion_topic") {
            const assignment = isPlainObject(item?.assignment) ? item.assignment : {};
            const dates = Array.isArray(assignment.all_dates) && assignment.all_dates.length ? assignment.all_dates : null;
            if (dates) {
                dates.forEach((date) => {
                    if (!isPlainObject(date)) return;
                    const occurrenceId = date.id !== undefined && date.id !== null ? canvasIdValue(date.id) : date.base === true ? remoteId : undefined;
                    add(date.due_at, occurrenceId, "assignment.all_dates[].due_at", date.timezone || date.time_zone);
                });
            } else add(assignment.due_at ?? item?.due_at ?? item?.posted_at, remoteId, assignment.due_at || item?.due_at ? "assignment.due_at" : "posted_at");
        } else if (type === "planner_note") {
            add(item?.todo_date, remoteId, "todo_date");
        } else if (type === "calendar_event") {
            if (item?.all_day === true) add(item?.all_day_date, remoteId, "all_day_date");
            else add(item?.start_at, remoteId, "start_at");
        }
        return candidates;
    }

    function recurrenceFor(type, item, remoteId) {
        if (type !== "calendar_event") return { ok: true, occurrenceId: remoteId, recurrence: null };
        const seriesId = idValue(item?.series_uuid);
        const rule = text(item?.rrule, 2048);
        const hasRecurrence = Boolean(seriesId || rule || item?.series_head === true);
        if (!hasRecurrence) return { ok: true, occurrenceId: remoteId, recurrence: null };
        if (!seriesId || !remoteId) return { ok: false, code: "CANVAS_RECURRENCE_UNSTABLE" };
        return { ok: true, occurrenceId: remoteId, recurrence: { seriesId, ...(rule ? { rule } : {}) } };
    }

    function contextIdFor(type, item, options, userId) {
        const explicit = options.contextId !== undefined && options.contextId !== null && options.contextId !== "" ? options.contextId : options.calendarId;
        const candidate = explicit ?? item?.context_code ?? item?.course_id ?? (type === "planner_note" ? `user_${userId}` : null);
        return idValue(candidate);
    }

    async function normalizeContext(type, item, options) {
        const account = identity.normalizeAccount({
            origin: options.origin || options.expectedOrigin || options.account?.origin,
            userId: options.userId ?? options.expectedUserId ?? options.account?.userId
        });
        if (!account) return { ok: false, result: quarantine(type, "CANVAS_ACCOUNT_EXPECTED_INVALID") };
        const contextId = contextIdFor(type, item, options, account.userId);
        if (!contextId) return { ok: false, result: quarantine(type, "CANVAS_CONTEXT_ID_MISSING") };
        const calendarId = idValue(options.calendarId ?? item?.context_code ?? contextId);
        if (!calendarId) return { ok: false, result: quarantine(type, "CANVAS_CONTEXT_ID_MISSING") };
        const accountHash = options.accountKey || await identity.accountKey({ ...account, forceFallback: options.forceFallback, cryptoImpl: options.cryptoImpl });
        if (!/^[a-f0-9]{64}$/i.test(String(accountHash || ""))) return { ok: false, result: quarantine(type, "CANVAS_SOURCE_INVALID") };
        return { ok: true, account, contextId, calendarId, accountKey: accountHash };
    }

    function sourceTimezoneFor(item, candidate, options) {
        return sourceTimezone(candidate?.timezone || item?.timezone || item?.time_zone || item?.time_zone_edited || item?.source_timezone || options.sourceTimezone);
    }

    function sourceRevision(item, payloadHash) {
        const version = idValue(item?.version_number);
        if (version) return `version:${version}`;
        const updated = parseDateValue(item?.updated_at, { allowDateOnly: false });
        if (updated) return `updated_at:${updated.utcInstant}`;
        const created = parseDateValue(item?.created_at, { allowDateOnly: false });
        if (created) return `created_at:${created.utcInstant}`;
        return `payload:${payloadHash}`;
    }

    function sourceTitle(type, item) {
        if (type === "assignment") return text(item?.name, SAFE_TITLE_LIMIT);
        return text(item?.title, SAFE_TITLE_LIMIT);
    }

    function sourceDescription(type, item) {
        if (type === "discussion_topic") return text(item?.message, SAFE_TEXT_LIMIT);
        if (type === "planner_note") return text(item?.description ?? item?.details, SAFE_TEXT_LIMIT);
        return text(item?.description, SAFE_TEXT_LIMIT);
    }

    function sourceUrl(type, item) {
        if (type === "planner_note") return item?.html_url ?? item?.linked_object_html_url ?? item?.linked_object_url ?? item?.url;
        return item?.html_url ?? item?.url;
    }

    function candidateDate(type, item, candidate, options) {
        const allDay = type === "calendar_event" && item?.all_day === true;
        const allowDateOnly = type === "planner_note" || allDay;
        return parseDateValue(candidate.dateValue, { allowDateOnly, allDay, timezone: sourceTimezoneFor(item, candidate, options) });
    }

    function calendarEnd(type, item, date, options) {
        if (type !== "calendar_event" || item?.all_day === true) return { ok: true, value: null };
        if (item?.end_at === undefined || item?.end_at === null || item?.end_at === "") return { ok: false, code: "CANVAS_END_DATE_MISSING" };
        const end = parseDateValue(item.end_at, { allowDateOnly: false, timezone: sourceTimezoneFor(item, null, options) });
        if (!end) return { ok: false, code: "CANVAS_END_DATE_INVALID" };
        if (date.kind !== "instant" || Date.parse(end.utcInstant) < Date.parse(date.utcInstant)) return { ok: false, code: "CANVAS_END_DATE_INVALID" };
        return { ok: true, value: end };
    }

    async function normalizeCandidate(type, item, options, context, registry, candidate, recurrence) {
        const remoteId = canvasIdValue(item?.id);
        if (!remoteId) return quarantine(type, "CANVAS_REMOTE_ID_MISSING");
        if (candidate.occurrenceId === undefined || !canvasIdValue(candidate.occurrenceId)) return quarantine(type, "CANVAS_OCCURRENCE_ID_UNSTABLE");
        const date = candidateDate(type, item, candidate, options);
        if (!date) return quarantine(type, candidate.dateValue ? "CANVAS_DATE_INVALID" : "CANVAS_DATE_MISSING");
        const end = calendarEnd(type, item, date, options);
        if (!end.ok) return quarantine(type, end.code);
        const rawUrl = sourceUrl(type, item);
        const sourceCalendarUrl = rawUrl == null ? null : safeUrl(rawUrl, context.account.origin, {
            sameOrigin: true,
            allowedSourceOrigins: options.allowedSourceOrigins
        });
        if (rawUrl != null && !sourceCalendarUrl) return quarantine(type, "CANVAS_SOURCE_URL_INVALID");
        const sourceKey = identity.sourceItemKey({
            type,
            contextId: type === "calendar_event" ? undefined : context.contextId,
            calendarId: context.calendarId,
            remoteId,
            occurrenceId: recurrence.occurrenceId || candidate.occurrenceId
        });
        if (!sourceKey) return quarantine(type, "CANVAS_SOURCE_INVALID");
        const description = type === "calendar_event" ? null : sourceDescription(type, item);
        const payload = {
            title: sourceTitle(type, item),
            ...(description ? { description } : {}),
            ...(sourceCalendarUrl ? { url: sourceCalendarUrl } : {}),
            date,
            ...(registry.payload.deadlineOnly ? { deadline: true } : {}),
            ...(recurrence.recurrence ? { recurrence: recurrence.recurrence } : {}),
            ...(type === "calendar_event" ? {
                ...(end.value ? { end: end.value } : {}),
                ...(text(item?.location_name, 1000) ? { locationName: text(item.location_name, 1000) } : {}),
                ...(text(item?.location_address, 2000) ? { locationAddress: text(item.location_address, 2000) } : {})
            } : {})
        };
        if (security?.findSensitiveData?.(payload)) return quarantine(type, "CANVAS_PAYLOAD_SENSITIVE");
        const payloadHash = await identity.sha256Hex(identity.stableStringify(payload), { cryptoImpl: options.cryptoImpl, forceFallback: options.forceFallback });
        const revision = sourceRevision(item, payloadHash);
        const eventRef = await identity.buildEventRef({ accountKey: context.accountKey, sourceItemKey: sourceKey });
        if (!eventRef) return quarantine(type, "CANVAS_SOURCE_INVALID");
        const occurrenceId = recurrence.occurrenceId || candidate.occurrenceId;
        return {
            schemaVersion: VERSION,
            eventRef,
            source: {
                key: sourceKey,
                type,
                id: remoteId,
                contextId: context.contextId,
                calendarId: context.calendarId,
                occurrenceId,
                url: sourceCalendarUrl,
                calendarUrl: sourceCalendarUrl,
                timezone: date.sourceTimezone,
                offset: date.sourceOffset,
                revision,
                payloadHash,
                accountKey: context.accountKey
            },
            date,
            completion: completionFor(type, item, registry),
            payload
        };
    }

    async function normalizeTyped(type, item, options = {}) {
        if (!SUPPORTED_TYPES.includes(type)) return unsupported(type);
        if (!isPlainObject(item)) return quarantine(type, "CANVAS_SOURCE_INVALID");
        if (type === "discussion_topic" && isAnnouncement(item)) return { ok: false, state: "unsupported", type, code: "CANVAS_ANNOUNCEMENT_UNSUPPORTED", items: [] };
        const registry = contracts.getCapability(type);
        if (!registry) return unsupported(type);
        const context = await normalizeContext(type, item, options);
        if (!context.ok) return context.result;
        const remoteId = canvasIdValue(item.id);
        if (!remoteId) return quarantine(type, "CANVAS_REMOTE_ID_MISSING");
        const recurrence = recurrenceFor(type, item, remoteId);
        if (!recurrence.ok) return quarantine(type, recurrence.code);
        const candidates = occurrenceCandidates(type, item, remoteId);
        if (!candidates.length) return quarantine(type, "CANVAS_DATE_MISSING");
        const normalized = [];
        const quarantined = [];
        for (const candidate of candidates) {
            const result = await normalizeCandidate(type, item, options, context, registry, candidate, recurrence);
            if (result?.ok === false) quarantined.push(result.reason?.code || result.code || "CANVAS_ITEM_QUARANTINED");
            else normalized.push(result);
        }
        if (!normalized.length) return quarantine(type, quarantined[0] || "CANVAS_ITEM_QUARANTINED", { count: quarantined.length || 1 });
        return {
            ok: true,
            state: "normalized",
            type,
            items: normalized,
            ...(normalized.length === 1 ? { item: normalized[0] } : {}),
            ...(quarantined.length ? { quarantined: quarantined.map((code) => ({ code: safeReason(code) })) } : {})
        };
    }

    function normalizeCanvasItem(type, item, options) { return normalizeTyped(type, item, options); }

    async function safeUploadObject(value) {
        if (!isPlainObject(value) || value.schemaVersion !== VERSION || !/^canvas:[a-f0-9]{64}:[a-f0-9]{64}$/i.test(String(value.eventRef || "")) || !isPlainObject(value.source)) return false;
        if (!security?.isJsonSerializable?.(value) || security.findSensitiveData(value)) return false;
        if (!SUPPORTED_TYPES.includes(value.source.type)) return false;
        if (!["key", "id", "contextId", "calendarId", "occurrenceId", "revision", "payloadHash", "accountKey"].every((field) => value.source[field] !== undefined && value.source[field] !== null)) return false;
        const canonicalKey = identity.sourceItemKey({
            type: value.source.type,
            contextId: value.source.type === "calendar_event" ? undefined : value.source.contextId,
            calendarId: value.source.calendarId,
            remoteId: value.source.id,
            occurrenceId: value.source.occurrenceId
        });
        if (!canonicalKey || value.source.key !== canonicalKey || !/^[a-f0-9]{64}$/.test(String(value.source.accountKey))) return false;
        return identity.verifyEventRef({ eventRef: String(value.eventRef), accountKey: String(value.source.accountKey), sourceItemKey: canonicalKey });
    }

    return Object.freeze({
        VERSION,
        SUPPORTED_TYPES,
        parseDateValue,
        safeUrl,
        reconcileCompletion,
        normalizeAssignment: (item, options) => normalizeTyped("assignment", item, options),
        normalizeQuiz: (item, options) => normalizeTyped("quiz", item, options),
        normalizeDiscussionTopic: (item, options) => normalizeTyped("discussion_topic", item, options),
        normalizePlannerNote: (item, options) => normalizeTyped("planner_note", item, options),
        normalizeCalendarEvent: (item, options) => normalizeTyped("calendar_event", item, options),
        // Kept as a compatibility alias; stable occurrences are calendar_event
        // records, not an undocumented Canvas API resource type.
        normalizeStableOccurrence: (item, options) => normalizeTyped("calendar_event", item, options),
        normalizeCanvasItem,
        safeUploadObject
    });
}));
