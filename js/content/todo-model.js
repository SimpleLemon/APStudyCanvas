(function (root, factory) {
    "use strict";
    const identity = root?.APStudyCanvasCanvasAdapter?.Identity || (typeof require === "function" ? require("../canvas-adapter/identity.js") : null);
    const time = root?.APStudyCanvasContent?.TodoTime || (typeof require === "function" ? require("./todo-time.js") : null);
    const planner = root?.APStudyCanvasContent?.PlannerTasks || (typeof require === "function" ? require("./planner-tasks.js") : null);
    const api = factory(identity, time, planner);
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasContent = Object.assign(root.APStudyCanvasContent || {}, { TodoModel: api });
}(typeof globalThis !== "undefined" ? globalThis : this, function (identity, time, planner) {
    "use strict";

    const CANVAS_TYPES = new Set(["assignment", "quiz", "discussion", "discussion_topic", "announcement", "calendar", "calendar_event", "planner_note"]);
    const TYPE_ALIASES = Object.freeze({ discussion_topic: "discussion", calendar_event: "calendar" });
    const PRIORITIES = new Set(["low", "normal", "high", "urgent"]);

    function object(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
    function text(value, fallback = null) {
        if (typeof value !== "string" && typeof value !== "number") return fallback;
        const result = String(value).replace(/[\u0000-\u001f\u007f]/g, "").trim();
        return result || fallback;
    }
    function id(value) {
        if (typeof value !== "string" && typeof value !== "number") return null;
        const result = String(value).trim();
        return result && !/[\u0000-\u001f\u007f/]/.test(result) ? result : null;
    }
    function bool(value) { return value === true; }
    function first(...values) { return values.find((value) => value !== undefined && value !== null && value !== ""); }

    function normalizedType(type, item) {
        const candidate = String(type || item?.type || item?.plannable_type || "").toLowerCase();
        if (candidate === "discussion_topic" && (item?.is_announcement === true || item?.announcement === true || item?.topic_type === "announcement")) return "announcement";
        if (candidate === "discussion" && (item?.is_announcement === true || item?.announcement === true || item?.topic_type === "announcement")) return "announcement";
        return TYPE_ALIASES[candidate] || candidate;
    }

    function courseMetadata(item, fallback = null) {
        const source = object(item?.course || item?.context || item?.course_metadata);
        const courseId = first(source.id, source.course_id, item?.course_id, item?.canvas_course_id, item?.context_code?.replace(/^course_/, ""), fallback?.id);
        const name = text(first(source.name, source.course_name, item?.course_name, fallback?.name));
        // Planner's context_name is Canvas's full human course label. Keep it
        // even when a terse course code is available for primary display.
        const fullLabel = text(first(source.label, source.context_name, item?.context_name, item?.course_label, item?.canvas_course_label, fallback?.label, name));
        const code = text(first(source.course_code, source.code, item?.course_code, fallback?.code));
        const color = text(first(source.color, source.course_color, item?.course_color, item?.context_color, fallback?.color));
        if (!courseId && !name && !code) return null;
        return { id: courseId ? String(courseId) : null, name: name || fullLabel, code, label: code || fullLabel || name || (courseId ? `Course ${courseId}` : null), fullLabel: fullLabel || name || code || null, color };
    }

    function sourceDue(type, item) {
        if (type === "assignment" || type === "quiz") return first(item?.due_at, item?.dueAt, item?.all_dates?.find((entry) => entry?.due_at)?.due_at);
        if (type === "discussion" || type === "announcement") return first(item?.assignment?.due_at, item?.due_at, item?.posted_at, item?.published_at);
        if (type === "calendar") return item?.all_day ? first(item?.all_day_date, item?.start_at) : first(item?.start_at, item?.due_at);
        if (type === "planner_note") return first(item?.todo_date, item?.due_at, item?.due_date);
        return first(item?.due_at, item?.due, item?.deadline_at, item?.due_date);
    }

    function sourceUrl(item) {
        const value = first(item?.html_url, item?.url, item?.link, item?.source_url);
        if (!value) return null;
        try {
            const url = new URL(String(value));
            return url.protocol === "https:" && !url.username && !url.password && !url.hash ? url.href : null;
        } catch (error) { return null; }
    }

    function points(item) {
        const submission = object(item?.submission || item?.submissions);
        const possible = first(item?.points_possible, item?.pointsPossible, item?.points, item?.max_points);
        const earned = first(item?.points_earned, item?.pointsEarned, submission?.score);
        const numeric = (value) => value === null || value === undefined || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);
        const result = { earned: numeric(earned), possible: numeric(possible) };
        return result.earned === null && result.possible === null ? null : result;
    }

    function priority(value) {
        if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.min(3, Math.round(value)));
        const candidate = String(value || "normal").toLowerCase();
        return PRIORITIES.has(candidate) ? candidate : "normal";
    }

    function canvasStates(type, item) {
        const assignment = object(item?.assignment);
        // Planner rows use a compact `submissions` summary while assignment
        // responses use `submission`.  Consult both: choosing the first object
        // would discard a populated summary whenever an empty detail object is
        // also present.
        const submissions = [object(item?.submission), object(item?.submissions), object(assignment?.submission)];
        const override = object(first(item?.planner_override, item?.plannerOverride, assignment?.planner_override));
        const sources = [object(item), ...submissions];
        const has = (name) => sources.some((source) => source[name] === true);
        const value = (name) => first(...sources.map((source) => source[name]));
        const workflow = String(first(...submissions.map((submission) => submission.workflow_state), ...submissions.map((submission) => submission.status)) || "").toLowerCase();
        const needsGrading = workflow === "needs_grading" || has("needs_grading");
        const submitted = Boolean(has("submitted") || sources.some((source) => Boolean(source.submitted_at)) || ["submitted", "graded", "pending_review", "needs_grading"].includes(workflow) || (type === "quiz" && (workflow === "complete" || sources.some((source) => Boolean(source.finished_at)))));
        const postedGrade = first(value("posted_grade"), value("grade"));
        const graded = has("graded") || workflow === "graded" || (postedGrade !== undefined && postedGrade !== null && String(postedGrade).trim() !== "");
        // Canvas explicitly marks an excused submission as not requiring work.
        // Treat it as done, rather than leaving an excused assignment active.
        const excused = has("excused");
        const positivelySubmitted = submitted || graded || needsGrading || workflow === "pending_review" || excused;
        return {
            submitted: positivelySubmitted,
            graded,
            needsGrading,
            excused,
            late: has("late"),
            missing: has("missing"),
            readState: item?.read_state === "unread" || item?.unread === true || item?.read === false
                ? "unread"
                : item?.read_state === "read" || item?.read === true || item?.unread === false
                    ? "read"
                    : "unknown",
            // A missing flag alone is not a completion signal. Canvas has
            // positively identified work as submitted/graded/needs-grading,
            // and planner overrides remain the only user-writeable completion.
            completion: positivelySubmitted || bool(override?.marked_complete),
            workflowState: workflow || null,
            status: positivelySubmitted ? "done" : needsGrading ? "needs-grading" : "active",
            plannerOverride: override?.id || null
        };
    }

    async function normalizeCanvasTask(type, item, options = {}) {
        const raw = object(item);
        const canonicalType = normalizedType(type, raw);
        if (!CANVAS_TYPES.has(String(type || "").toLowerCase()) && !CANVAS_TYPES.has(canonicalType)) return { ok: false, code: "TODO_CANVAS_TYPE_UNSUPPORTED" };
        const account = identity?.normalizeAccount?.({ origin: options.origin || options.expectedOrigin || options.account?.origin, userId: options.userId ?? options.expectedUserId ?? options.account?.userId });
        const accountKey = String(options.accountKey || "").toLowerCase() || await identity?.accountKey?.({ ...account, forceFallback: options.forceFallback, cryptoImpl: options.cryptoImpl });
        const remoteId = id(first(raw.id, raw.plannable_id));
        if (!account || !/^[a-f0-9]{64}$/.test(String(accountKey || "")) || !remoteId) return { ok: false, code: "TODO_CANVAS_IDENTITY_INVALID" };
        const contextId = id(first(options.contextId, raw.course_id, raw.context_code, canonicalType === "planner_note" ? `user_${account.userId}` : null));
        const calendarId = id(first(options.calendarId, raw.context_code, raw.course_id, contextId));
        if (!contextId || !calendarId) return { ok: false, code: "TODO_CANVAS_CONTEXT_INVALID" };
        const occurrenceId = id(first(raw.occurrence_id, raw.all_dates?.find((entry) => entry?.id)?.id, raw.id));
        const adapterType = canonicalType === "discussion" ? "discussion_topic" : canonicalType === "calendar" ? "calendar_event" : canonicalType;
        const sourceItemKey = identity.sourceItemKey({ type: adapterType, contextId: adapterType === "calendar_event" ? undefined : contextId, calendarId, remoteId, occurrenceId });
        const eventRef = await identity.buildEventRef({ accountKey, sourceItemKey });
        if (!sourceItemKey || !eventRef) return { ok: false, code: "TODO_CANVAS_SOURCE_ID_INVALID" };
        const userTimeZone = time.resolveTimeZone(options.canvasUserTimeZone || options.timeZone, options.browserTimeZone);
        const due = time.parseDue(sourceDue(canonicalType, raw), { timeZone: userTimeZone, allDay: canonicalType === "calendar" && raw.all_day === true || canonicalType === "planner_note" && DATE_ONLY(raw.todo_date) });
        const state = canvasStates(canonicalType, raw);
        const title = text(first(raw.name, raw.title, raw.plannable?.title), "Untitled task");
        const plannerMetadata = canonicalType === "planner_note" ? planner?.parseMarker?.(raw.details) : null;
        // content.js marks a Planner feed row untrusted when Canvas supplies
        // conflicting outer and nested resource ids. A marker establishes
        // APStudy ownership, not permission to guess which resource to write.
        const plannerNoteResourceConflict = canonicalType === "planner_note" && raw.planner_note_resource_id_conflict === true;
        const ownedPlannerNote = Boolean(plannerMetadata && !plannerNoteResourceConflict);
        const result = {
            id: eventRef,
            source: ownedPlannerNote ? "canvas-planner-note" : "canvas",
            accountKey,
            sourceItemKey,
            eventRef,
            remoteId,
            sourceType: adapterType,
            type: canonicalType,
            title,
            url: sourceUrl(raw),
            course: courseMetadata(raw, options.course),
            due,
            timezone: due?.timeZone || userTimeZone,
            points: points(raw),
            priority: priority(first(raw.priority, raw.planner_priority)),
            completion: ownedPlannerNote ? plannerMetadata.completed : state.completion,
            submitted: state.submitted,
            graded: state.graded,
            needsGrading: state.needsGrading,
            excused: state.excused,
            late: state.late,
            workflowState: state.workflowState,
            status: state.status,
            missing: state.missing,
            unread: state.readState === "unread",
            readState: state.readState,
            // Planner notes are never routed through the generic planner-
            // override writer. Only the extension marker grants mutation
            // authority; ordinary Canvas notes remain strictly read-only.
            mutationAuthority: ownedPlannerNote ? "canvas_planner_note" : canonicalType === "planner_note" ? null : canonicalType === "announcement" ? "canvas_announcement_read" : "canvas_planner_override",
            mutation: { authority: ownedPlannerNote ? "canvas_planner_note" : canonicalType === "planner_note" ? null : canonicalType === "announcement" ? "canvas_announcement_read" : "canvas_planner_override", plannerOverrideId: state.plannerOverride, plannerNoteId: ownedPlannerNote ? plannerMetadata.id : null, submitAssignment: false },
            raw
        };
        if (canonicalType === "announcement" && result.readState !== "unread") result.visibility = "excluded";
        return { ok: true, state: "normalized", task: Object.freeze(result) };
    }

    function nestTaskId(item) { return id(first(item?.id, item?.task_id, item?.todo_id, item?.source_item_key)); }

    function normalizeNestTask(item, options = {}) {
        const raw = object(item);
        const remoteId = nestTaskId(raw);
        const accountKey = text(first(options.accountKey, raw.account_key, raw.accountKey, raw.nest_account_key), "nest");
        if (!remoteId) return { ok: false, code: "TODO_NEST_IDENTITY_INVALID" };
        const type = "nest_task";
        const sourceItemKey = `nest:${encodeURIComponent(accountKey)}:${encodeURIComponent(remoteId)}`;
        const dueValue = first(raw.due_at, raw.due, raw.deadline_at, raw.due_date);
        const due = time.parseDue(dueValue, { timeZone: options.timeZone, allDay: typeof dueValue === "string" && DATE_ONLY(dueValue) });
        const completion = bool(first(raw.completed, raw.completion, raw.done));
        const result = {
            id: sourceItemKey,
            source: "nest",
            accountKey,
            sourceItemKey,
            eventRef: null,
            remoteId,
            sourceType: type,
            type,
            title: text(first(raw.title, raw.name), "Untitled task"),
            url: sourceUrl(raw),
            course: courseMetadata(raw, options.course),
            due,
            timezone: due?.timeZone || time.resolveTimeZone(options.timeZone),
            points: points(raw),
            priority: priority(first(raw.priority, raw.planner_priority)),
            completion,
            submitted: false,
            graded: false,
            needsGrading: false,
            workflowState: null,
            status: completion ? "done" : "active",
            missing: bool(raw.missing),
            unread: false,
            mutationAuthority: "nest",
            mutation: { authority: "nest", submitAssignment: false },
            raw
        };
        return { ok: true, state: "normalized", task: Object.freeze(result) };
    }

    function DATE_ONLY(value) { return /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")); }

    return Object.freeze({
        CANVAS_TYPES,
        normalizedType,
        courseMetadata,
        points,
        priority,
        normalizeCanvasTask,
        normalizeNestTask,
        nestTaskId
    });
}));
