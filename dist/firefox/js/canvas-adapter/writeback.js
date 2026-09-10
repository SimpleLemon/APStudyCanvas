(function (root, factory) {
    "use strict";

    const identity = root?.APStudyCanvasCanvasAdapter?.Identity || (typeof require === "function" ? require("./identity.js") : null);
    const api = factory(identity);
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasCanvasAdapter = Object.assign(root.APStudyCanvasCanvasAdapter || {}, { Writeback: api });
}(typeof globalThis !== "undefined" ? globalThis : this, function (identity) {
    "use strict";

    const SUPPORTED_SOURCE_TYPES = new Set(["calendar_event", "planner_note"]);
    const PERSONAL_CONTEXT = /^user_[1-9]\d{0,19}$/;
    const HASH = /^[a-f0-9]{64}$/;
    const EVENT_REF = /^canvas:([a-f0-9]{64}):([a-f0-9]{64})$/;
    const CANVAS_ID = /^[1-9]\d{0,19}$/;

    function isPlainObject(value) {
        if (!value || typeof value !== "object" || Array.isArray(value)) return false;
        const prototype = Object.getPrototypeOf(value);
        return prototype === Object.prototype || prototype === null;
    }

    function hash(value) {
        if (!identity?.sha256HexSync) throw new Error("WRITEBACK_HASH_UNAVAILABLE");
        return identity.sha256HexSync(String(value));
    }

    function sourceType(item) {
        return String(item?.source?.type || item?.sourceType || item?.type || "").toLowerCase();
    }

    function revisionHash(value) {
        if (value === null || value === undefined || value === "") return null;
        return HASH.test(String(value)) ? String(value).toLowerCase() : hash(value);
    }

    function mutationKind(mutation = {}) {
        if (!isPlainObject(mutation)) return null;
        const completion = mutation.completed ?? mutation.marked_complete;
        if (typeof completion === "boolean") return "completion";
        if (typeof mutation.due_at === "string" && Number.isFinite(Date.parse(mutation.due_at))) return "date";
        return null;
    }

    function classifyNormalizedItem(item, accountKey) {
        if (!isPlainObject(item) || !isPlainObject(item.source)) return { ok: false, code: "WRITEBACK_ITEM_INVALID" };
        const eventRef = String(item.eventRef || item.event_ref || "");
        const match = eventRef.match(EVENT_REF);
        if (!match || match[1].toLowerCase() !== String(accountKey || "").toLowerCase()) return { ok: false, code: "WRITEBACK_EVENT_REF_INVALID" };
        const type = sourceType(item);
        if (!SUPPORTED_SOURCE_TYPES.has(type)) return { ok: false, code: "WRITEBACK_ITEM_TYPE_UNSUPPORTED" };
        const source = item.source;
        if (source.accountKey && String(source.accountKey).toLowerCase() !== String(accountKey).toLowerCase()) return { ok: false, code: "WRITEBACK_ACCOUNT_MISMATCH" };
        if (!CANVAS_ID.test(String(source.id || "")) || !CANVAS_ID.test(String(source.occurrenceId || ""))) return { ok: false, code: "WRITEBACK_SOURCE_ID_INVALID" };
        if (typeof source.key !== "string" || !source.key || source.key.length > 512) return { ok: false, code: "WRITEBACK_SOURCE_KEY_INVALID" };
        const calendarId = String(source.calendarId || "");
        const contextId = String(source.contextId || "");
        if (type === "calendar_event" && !PERSONAL_CONTEXT.test(calendarId)) return { ok: false, code: "WRITEBACK_PERSONAL_CALENDAR_REQUIRED" };
        if (type === "planner_note" && !PERSONAL_CONTEXT.test(contextId)) return { ok: false, code: "WRITEBACK_PERSONAL_PLANNER_REQUIRED" };
        const payloadHash = String(source.payloadHash || source.payload_hash || "");
        if (!HASH.test(payloadHash)) return { ok: false, code: "WRITEBACK_PAYLOAD_HASH_INVALID" };
        return {
            ok: true,
            value: Object.freeze({
                event_ref: eventRef.toLowerCase(),
                source_type: type,
                target_kind: type === "calendar_event" ? "personal_calendar_event" : "planner_task",
                source_key_hash: hash(source.key),
                remote_id_hash: hash(source.id),
                occurrence_id_hash: hash(source.occurrenceId),
                context_hash: hash(type === "calendar_event" ? calendarId : contextId),
                payload_hash: payloadHash.toLowerCase(),
                revision_hash: revisionHash(source.revision) || hash(payloadHash),
                writable_operations: type === "calendar_event" ? ["date"] : ["completion", "date"]
            })
        };
    }

    function supportsMutation(mirror, mutation) {
        const kind = mutationKind(mutation);
        if (!kind) return { ok: false, code: "WRITEBACK_MUTATION_UNSUPPORTED" };
        if (!mirror?.writable_operations?.includes(kind)) return { ok: false, code: "WRITEBACK_MUTATION_TARGET_UNSUPPORTED" };
        return { ok: true, kind };
    }

    return Object.freeze({
        classifyNormalizedItem,
        supportsMutation,
        mutationKind,
        SUPPORTED_SOURCE_TYPES
    });
}));
