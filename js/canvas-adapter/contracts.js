(function (root, factory) {
    "use strict";

    const api = factory();
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasCanvasAdapter = Object.assign(root.APStudyCanvasCanvasAdapter || {}, { Contracts: api });
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const VERSION = 1;
    const MAX_PER_PAGE = 100;
    const MAX_BATCH_ITEMS = 100;
    const MAX_BATCH_BYTES = 512 * 1024;
    const MAX_RETRY_ATTEMPTS = 8;
    const BACKOFF_BASE_MS = 2000;
    const BACKOFF_MAX_MS = 5 * 60 * 1000;
    const INCREMENTAL_OVERLAP_MS = 24 * 60 * 60 * 1000;

    // These are the only source URLs used by this phase. They are official
    // Instructure API reference pages, not vendor, community, or instance data.
    const OFFICIAL_DOCUMENTATION = Object.freeze({
        basics: "https://canvas.instructure.com/doc/api/index.html",
        pagination: "https://canvas.instructure.com/doc/api/file.pagination.html",
        throttling: "https://canvas.instructure.com/doc/api/file.throttling.html",
        assignments: "https://canvas.instructure.com/doc/api/assignments.html",
        submissions: "https://canvas.instructure.com/doc/api/submissions.html",
        quizzes: "https://canvas.instructure.com/doc/api/quizzes.html",
        quizSubmissions: "https://canvas.instructure.com/doc/api/quiz_submissions.html",
        discussionTopics: "https://canvas.instructure.com/doc/api/discussion_topics.html",
        planner: "https://canvas.instructure.com/doc/api/planner.html",
        calendarEvents: "https://canvas.instructure.com/doc/api/calendar_events.html"
    });

    const READ_CAPABILITY = "canvas.context.verified";
    const ASSIGNMENT_WRITE = "canvas.assignments.manage";
    const ASSIGNMENT_SUBMIT = "canvas.assignments.submit";
    const QUIZ_WRITE = "canvas.quizzes.manage";
    const QUIZ_SUBMIT = "canvas.quizzes.submit";
    const DISCUSSION_WRITE = "canvas.discussions.manage";
    const DISCUSSION_CONTRIBUTE = "canvas.discussions.contribute";
    const PLANNER_WRITE = "canvas.planner.manage";
    const CALENDAR_WRITE = "canvas.calendar.manage";
    const PLANNER_OVERRIDE_WRITE = "canvas.planner_override.manage";

    function clone(value) {
        if (value === undefined) return undefined;
        if (typeof structuredClone === "function") return structuredClone(value);
        return JSON.parse(JSON.stringify(value));
    }

    function deepFreeze(value, seen = new Set()) {
        if (!value || typeof value !== "object" || seen.has(value)) return value;
        seen.add(value);
        Object.values(value).forEach((item) => deepFreeze(item, seen));
        return Object.freeze(value);
    }

    function byteLength(value) {
        let serialized;
        try { serialized = typeof value === "string" ? value : JSON.stringify(value); } catch (error) { return Number.POSITIVE_INFINITY; }
        if (typeof TextEncoder === "function") return new TextEncoder().encode(serialized).length;
        try { return unescape(encodeURIComponent(serialized)).length; } catch (error) { return Number.POSITIVE_INFINITY; }
    }

    function cleanPath(path) {
        return String(path || "").replace(/\/\.json(?=\/|$)/g, "");
    }

    /*
     * Read/import operations are enabled only when the endpoint and returned
     * data shape are documented. Mutations are always fail-closed in Phase 5A;
     * their metadata still records the two independent gates required before a
     * future phase could enable them. No role is granted by this registry.
     */
    function operation({ method, path, source, documented = false, mutation = false, liveCapabilityRequired = null, enabled } = {}) {
        const liveRequired = Boolean(liveCapabilityRequired);
        const documentedOperation = Boolean(documented);
        const eligible = documentedOperation && (!mutation || liveRequired);
        const defaultEnabled = mutation ? false : eligible;
        const requestedEnabled = enabled === undefined ? defaultEnabled : Boolean(enabled);
        const finalEnabled = requestedEnabled && eligible && !mutation;
        return {
            method,
            path: cleanPath(path),
            enabled: finalEnabled,
            documented: documentedOperation,
            mutation: Boolean(mutation),
            live_capability_required: liveRequired,
            ...(liveRequired ? { requiredLiveCapability: liveCapabilityRequired } : {}),
            ...(!finalEnabled ? { disabledReason: mutation ? "phase5a_mutations_disabled" : "not_documented" } : {}),
            ...(source ? { source } : {})
        };
    }

    function readOperation(args) {
        return operation({ ...args, documented: true, mutation: false });
    }

    function mutationOperation(args) {
        return operation({ ...args, documented: true, mutation: true });
    }

    function readSource({ list, history, listQuery = {}, historyQuery = {}, window }) {
        return {
            list,
            // `import` is deliberately the same documented read endpoint. It is
            // a registry label, not an additional undocumented API route.
            import: clone(list),
            history,
            listQuery,
            historyQuery,
            paginated: true,
            ...(window ? { window } : {})
        };
    }

    const fullHistoryWindow = (reason) => ({ mode: "none", lowerBoundSupported: false, reason });
    const dateWindow = (field, start = "start_date", end = "end_date") => ({
        mode: "date_range",
        lowerBoundSupported: true,
        startParam: start,
        endParam: end,
        dateField: field,
        inclusive: true,
        overlapMs: INCREMENTAL_OVERLAP_MS
    });

    function mutationPolicy() {
        return {
            defaultEnabled: false,
            requiresDocumented: true,
            requiresLiveCapability: true,
            studentRoleCanMutate: false
        };
    }

    const CAPABILITY_REGISTRY = {
        assignment: {
            version: VERSION,
            label: "Assignments",
            officialSources: [OFFICIAL_DOCUMENTATION.assignments, OFFICIAL_DOCUMENTATION.submissions, OFFICIAL_DOCUMENTATION.planner],
            mutationPolicy: mutationPolicy(),
            source: readSource({
                list: readOperation({ method: "GET", path: "/api/v1/courses/{contextId}/assignments", source: OFFICIAL_DOCUMENTATION.assignments, liveCapabilityRequired: READ_CAPABILITY }),
                history: readOperation({ method: "GET", path: "/api/v1/courses/{contextId}/assignments/{remoteId}/submissions/{userId}", source: OFFICIAL_DOCUMENTATION.submissions, liveCapabilityRequired: READ_CAPABILITY }),
                listQuery: { include: ["submission", "all_dates"] },
                historyQuery: { include: ["submission_history"] },
                window: fullHistoryWindow("The official assignments list has no date lower-bound parameter; full history is required.")
            }),
            identity: { remoteIdField: "id", occurrenceIdField: "all_dates[].id or assignment.id for base", baseOccurrenceField: "all_dates[].base", contextField: "course_id", calendarField: "course_id" },
            dates: { fields: ["all_dates[].due_at", "due_at"], primary: "due_at", kind: "instant", allDayField: null, timezone: "ISO-8601 offset from due_at" },
            completion: {
                supported: true,
                sources: ["submission", "planner_override"],
                semantics: "A current submission is complete when Canvas reports submitted_at or a submitted/graded/pending_review workflow state. Planner marked_complete is an independent user override.",
                operation: mutationOperation({ method: "POST", path: "/api/v1/courses/{contextId}/assignments/{remoteId}/submissions", liveCapabilityRequired: ASSIGNMENT_SUBMIT, source: OFFICIAL_DOCUMENTATION.submissions }),
                plannerOverride: mutationOperation({ method: "PUT", path: "/api/v1/planner/overrides/{overrideId}", liveCapabilityRequired: PLANNER_OVERRIDE_WRITE, source: OFFICIAL_DOCUMENTATION.planner })
            },
            operations: {
                create: mutationOperation({ method: "POST", path: "/api/v1/courses/{contextId}/assignments", liveCapabilityRequired: ASSIGNMENT_WRITE, source: OFFICIAL_DOCUMENTATION.assignments }),
                update: mutationOperation({ method: "PUT", path: "/api/v1/courses/{contextId}/assignments/{remoteId}", liveCapabilityRequired: ASSIGNMENT_WRITE, source: OFFICIAL_DOCUMENTATION.assignments }),
                completion: mutationOperation({ method: "POST", path: "/api/v1/courses/{contextId}/assignments/{remoteId}/submissions", liveCapabilityRequired: ASSIGNMENT_SUBMIT, source: OFFICIAL_DOCUMENTATION.submissions }),
                delete: mutationOperation({ method: "DELETE", path: "/api/v1/courses/{contextId}/assignments/{remoteId}", liveCapabilityRequired: ASSIGNMENT_WRITE, source: OFFICIAL_DOCUMENTATION.assignments })
            },
            payload: { titleField: "name", descriptionField: "description", urlField: "html_url", deadlineOnly: true }
        },
        quiz: {
            version: VERSION,
            label: "Quizzes",
            officialSources: [OFFICIAL_DOCUMENTATION.quizzes, OFFICIAL_DOCUMENTATION.quizSubmissions, OFFICIAL_DOCUMENTATION.planner],
            mutationPolicy: mutationPolicy(),
            source: readSource({
                list: readOperation({ method: "GET", path: "/api/v1/courses/{contextId}/quizzes", source: OFFICIAL_DOCUMENTATION.quizzes, liveCapabilityRequired: READ_CAPABILITY }),
                history: readOperation({ method: "GET", path: "/api/v1/courses/{contextId}/quizzes/{remoteId}", source: OFFICIAL_DOCUMENTATION.quizzes, liveCapabilityRequired: READ_CAPABILITY }),
                listQuery: { include: ["all_dates"] },
                historyQuery: { include: ["submission"] },
                window: fullHistoryWindow("The official quizzes list has no date lower-bound parameter; full history is required.")
            }),
            identity: { remoteIdField: "id", occurrenceIdField: "all_dates[].id or quiz.id for base", baseOccurrenceField: "all_dates[].base", contextField: "course_id", calendarField: "course_id" },
            dates: { fields: ["all_dates[].due_at", "due_at", "due_at"], primary: "due_at", kind: "instant", allDayField: null, timezone: "ISO-8601 offset from due_at" },
            completion: {
                supported: true,
                sources: ["submission", "planner_override"],
                semantics: "A quiz submission is complete when Canvas reports workflow_state=complete or finished_at. Planner marked_complete is an independent user override.",
                operation: mutationOperation({ method: "POST", path: "/api/v1/courses/{contextId}/quizzes/{remoteId}/submissions/{submissionId}/complete", liveCapabilityRequired: QUIZ_SUBMIT, source: OFFICIAL_DOCUMENTATION.quizSubmissions }),
                plannerOverride: mutationOperation({ method: "PUT", path: "/api/v1/planner/overrides/{overrideId}", liveCapabilityRequired: PLANNER_OVERRIDE_WRITE, source: OFFICIAL_DOCUMENTATION.planner })
            },
            operations: {
                create: mutationOperation({ method: "POST", path: "/api/v1/courses/{contextId}/quizzes", liveCapabilityRequired: QUIZ_WRITE, source: OFFICIAL_DOCUMENTATION.quizzes }),
                update: mutationOperation({ method: "PUT", path: "/api/v1/courses/{contextId}/quizzes/{remoteId}", liveCapabilityRequired: QUIZ_WRITE, source: OFFICIAL_DOCUMENTATION.quizzes }),
                completion: mutationOperation({ method: "POST", path: "/api/v1/courses/{contextId}/quizzes/{remoteId}/submissions/{submissionId}/complete", liveCapabilityRequired: QUIZ_SUBMIT, source: OFFICIAL_DOCUMENTATION.quizSubmissions }),
                delete: mutationOperation({ method: "DELETE", path: "/api/v1/courses/{contextId}/quizzes/{remoteId}", liveCapabilityRequired: QUIZ_WRITE, source: OFFICIAL_DOCUMENTATION.quizzes })
            },
            payload: { titleField: "title", descriptionField: "description", urlField: "html_url", deadlineOnly: true }
        },
        discussion_topic: {
            version: VERSION,
            label: "Discussion topics",
            officialSources: [OFFICIAL_DOCUMENTATION.discussionTopics, OFFICIAL_DOCUMENTATION.planner],
            mutationPolicy: mutationPolicy(),
            source: readSource({
                list: readOperation({ method: "GET", path: "/api/v1/courses/{contextId}/discussion_topics", source: OFFICIAL_DOCUMENTATION.discussionTopics, liveCapabilityRequired: READ_CAPABILITY }),
                history: readOperation({ method: "GET", path: "/api/v1/courses/{contextId}/discussion_topics/{remoteId}", source: OFFICIAL_DOCUMENTATION.discussionTopics, liveCapabilityRequired: READ_CAPABILITY }),
                listQuery: { include: ["all_dates"] },
                historyQuery: {},
                window: fullHistoryWindow("The official discussion topics list has no date lower-bound parameter; full history is required.")
            }),
            identity: { remoteIdField: "id", occurrenceIdField: "assignment.all_dates[].id or discussion_topic.id", baseOccurrenceField: "assignment.all_dates[].base", contextField: "course_id", calendarField: "course_id" },
            dates: { fields: ["assignment.all_dates[].due_at", "assignment.due_at", "posted_at"], primary: "assignment.due_at", fallback: "posted_at", kind: "instant", allDayField: null, timezone: "ISO-8601 offset from source date field" },
            completion: {
                supported: true,
                sources: ["submission", "planner_override"],
                semantics: "Only a graded discussion with an official linked assignment can use submission completion. A planner override may mark the topic complete. An ungraded discussion has no submission completion field.",
                operation: mutationOperation({ method: "POST", path: "/api/v1/courses/{contextId}/discussion_topics/{remoteId}/entries", liveCapabilityRequired: DISCUSSION_CONTRIBUTE, source: OFFICIAL_DOCUMENTATION.discussionTopics }),
                plannerOverride: mutationOperation({ method: "PUT", path: "/api/v1/planner/overrides/{overrideId}", liveCapabilityRequired: PLANNER_OVERRIDE_WRITE, source: OFFICIAL_DOCUMENTATION.planner })
            },
            operations: {
                create: mutationOperation({ method: "POST", path: "/api/v1/courses/{contextId}/discussion_topics", liveCapabilityRequired: DISCUSSION_WRITE, source: OFFICIAL_DOCUMENTATION.discussionTopics }),
                update: mutationOperation({ method: "PUT", path: "/api/v1/courses/{contextId}/discussion_topics/{remoteId}", liveCapabilityRequired: DISCUSSION_WRITE, source: OFFICIAL_DOCUMENTATION.discussionTopics }),
                completion: mutationOperation({ method: "PUT", path: "/api/v1/planner/overrides/{overrideId}", liveCapabilityRequired: PLANNER_OVERRIDE_WRITE, source: OFFICIAL_DOCUMENTATION.planner }),
                delete: mutationOperation({ method: "DELETE", path: "/api/v1/courses/{contextId}/discussion_topics/{remoteId}", liveCapabilityRequired: DISCUSSION_WRITE, source: OFFICIAL_DOCUMENTATION.discussionTopics })
            },
            payload: { titleField: "title", descriptionField: "message", urlField: "html_url", deadlineOnly: true }
        },
        planner_note: {
            version: VERSION,
            label: "Planner notes",
            officialSources: [OFFICIAL_DOCUMENTATION.planner],
            mutationPolicy: mutationPolicy(),
            source: readSource({
                list: readOperation({ method: "GET", path: "/api/v1/planner_notes", source: OFFICIAL_DOCUMENTATION.planner, liveCapabilityRequired: READ_CAPABILITY }),
                history: readOperation({ method: "GET", path: "/api/v1/planner_notes/{remoteId}", source: OFFICIAL_DOCUMENTATION.planner, liveCapabilityRequired: READ_CAPABILITY }),
                listQuery: { dateWindow: { start: "start_date", end: "end_date", field: "todo_date", inclusive: true } },
                historyQuery: {},
                window: dateWindow("todo_date")
            }),
            identity: { remoteIdField: "id", occurrenceIdField: "planner_note.id", contextField: "course_id", calendarField: "course_id|user_{userId}" },
            dates: { fields: ["todo_date"], primary: "todo_date", kind: "instant_or_date", allDayField: "date-only todo_date", timezone: "ISO-8601 offset from todo_date or supplied IANA source timezone" },
            completion: {
                supported: true,
                sources: ["planner_override"],
                semantics: "PlannerOverride.marked_complete is the only documented completion source for a planner note.",
                operation: mutationOperation({ method: "PUT", path: "/api/v1/planner/overrides/{overrideId}", liveCapabilityRequired: PLANNER_OVERRIDE_WRITE, source: OFFICIAL_DOCUMENTATION.planner })
            },
            operations: {
                create: mutationOperation({ method: "POST", path: "/api/v1/planner_notes", liveCapabilityRequired: PLANNER_WRITE, source: OFFICIAL_DOCUMENTATION.planner }),
                update: mutationOperation({ method: "PUT", path: "/api/v1/planner_notes/{remoteId}", liveCapabilityRequired: PLANNER_WRITE, source: OFFICIAL_DOCUMENTATION.planner }),
                completion: mutationOperation({ method: "PUT", path: "/api/v1/planner/overrides/{overrideId}", liveCapabilityRequired: PLANNER_OVERRIDE_WRITE, source: OFFICIAL_DOCUMENTATION.planner }),
                delete: mutationOperation({ method: "DELETE", path: "/api/v1/planner_notes/{remoteId}", liveCapabilityRequired: PLANNER_WRITE, source: OFFICIAL_DOCUMENTATION.planner })
            },
            payload: { titleField: "title", descriptionField: "description|details", urlField: "html_url|linked_object_html_url", deadlineOnly: false }
        },
        calendar_event: {
            version: VERSION,
            label: "Native Canvas calendar events",
            officialSources: [OFFICIAL_DOCUMENTATION.calendarEvents, OFFICIAL_DOCUMENTATION.planner],
            mutationPolicy: mutationPolicy(),
            source: readSource({
                list: readOperation({ method: "GET", path: "/api/v1/calendar_events", source: OFFICIAL_DOCUMENTATION.calendarEvents, liveCapabilityRequired: READ_CAPABILITY }),
                history: readOperation({ method: "GET", path: "/api/v1/calendar_events/{remoteId}", source: OFFICIAL_DOCUMENTATION.calendarEvents, liveCapabilityRequired: READ_CAPABILITY }),
                listQuery: { dateWindow: { start: "start_date", end: "end_date", field: "start_at|all_day_date", inclusive: true }, contextCodes: "context_codes[]", allEvents: "all_events", undated: "undated", excludes: ["description", "child_events", "assignment"] },
                historyQuery: {},
                window: dateWindow("start_at|all_day_date")
            }),
            identity: { remoteIdField: "id", occurrenceIdField: "id", seriesField: "series_uuid", contextField: "context_code", calendarField: "context_code" },
            dates: { fields: ["all_day_date", "start_at", "end_at"], primary: "start_at", kind: "instant_or_date", allDayField: "all_day", timezone: "ISO-8601 offset from start_at/end_at or supplied IANA source timezone" },
            recurrence: {
                supported: true,
                stableOccurrenceFields: ["series_uuid", "id"],
                seriesRuleField: "rrule",
                rootField: "series_head",
                semantics: "A recurring event is accepted only when the official response contains both series_uuid and an individual id. A rule without a series UUID is quarantined."
            },
            completion: {
                supported: true,
                sources: ["planner_override"],
                semantics: "CalendarEvent has no documented native completion field; only an official planner override can supply completion.",
                operation: mutationOperation({ method: "PUT", path: "/api/v1/planner/overrides/{overrideId}", liveCapabilityRequired: PLANNER_OVERRIDE_WRITE, source: OFFICIAL_DOCUMENTATION.planner })
            },
            operations: {
                create: mutationOperation({ method: "POST", path: "/api/v1/calendar_events", liveCapabilityRequired: CALENDAR_WRITE, source: OFFICIAL_DOCUMENTATION.calendarEvents }),
                update: mutationOperation({ method: "PUT", path: "/api/v1/calendar_events/{remoteId}", liveCapabilityRequired: CALENDAR_WRITE, source: OFFICIAL_DOCUMENTATION.calendarEvents }),
                completion: mutationOperation({ method: "PUT", path: "/api/v1/planner/overrides/{overrideId}", liveCapabilityRequired: PLANNER_OVERRIDE_WRITE, source: OFFICIAL_DOCUMENTATION.planner }),
                delete: mutationOperation({ method: "DELETE", path: "/api/v1/calendar_events/{remoteId}", liveCapabilityRequired: CALENDAR_WRITE, source: OFFICIAL_DOCUMENTATION.calendarEvents })
            },
            payload: { titleField: "title", descriptionField: null, urlField: "html_url|url", deadlineOnly: false, excludes: ["description", "private_ics", "raw_email", "child_events", "assignment"] }
        }
    };

    const UNSUPPORTED_TYPES = Object.freeze(["announcement", "custom_local_task", "unknown"]);

    function getCapability(type) {
        return CAPABILITY_REGISTRY[type] || null;
    }

    function getOperation(type, name) {
        return getCapability(type)?.operations?.[name] || null;
    }

    function operationAvailability(type, name, liveCapabilities = {}) {
        const selected = getOperation(type, name);
        if (!selected) return { ok: false, state: "disabled", code: "CANVAS_OPERATION_UNKNOWN" };
        if (!selected.enabled) return { ok: false, state: "disabled", code: "CANVAS_OPERATION_DISABLED", reason: selected.disabledReason || "not_enabled" };
        if (selected.requiredLiveCapability && liveCapabilities[selected.requiredLiveCapability] !== true) {
            return { ok: false, state: "waiting", code: "CANVAS_CAPABILITY_REQUIRED", requiredLiveCapability: selected.requiredLiveCapability };
        }
        return { ok: true, state: "enabled", operation: clone(selected) };
    }

    function assertSupportedType(type) {
        if (typeof type !== "string" || !getCapability(type)) {
            const error = new Error("CANVAS_ITEM_TYPE_UNSUPPORTED");
            error.code = "CANVAS_ITEM_TYPE_UNSUPPORTED";
            throw error;
        }
        return type;
    }

    return deepFreeze({
        VERSION,
        MAX_PER_PAGE,
        MAX_BATCH_ITEMS,
        MAX_BATCH_BYTES,
        MAX_RETRY_ATTEMPTS,
        BACKOFF_BASE_MS,
        BACKOFF_MAX_MS,
        INCREMENTAL_OVERLAP_MS,
        OFFICIAL_DOCUMENTATION,
        CAPABILITY_REGISTRY,
        UNSUPPORTED_TYPES,
        byteLength,
        clone,
        getCapability,
        getOperation,
        operationAvailability,
        assertSupportedType
    });
}));
