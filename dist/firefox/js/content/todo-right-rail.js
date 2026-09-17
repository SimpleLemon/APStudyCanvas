(function (root, factory) {
    "use strict";
    const content = root?.APStudyCanvasContent || {};
    const state = content.TodoState || (typeof require === "function" ? require("./todo-state.js") : null);
    const time = content.TodoTime || (typeof require === "function" ? require("./todo-time.js") : null);
    const todoApi = content.TodoApi || (typeof require === "function" ? require("./todo-api.js") : null);
    const effectsApi = content.TodoEffects || (typeof require === "function" ? require("./todo-effects.js") : null);
    const planner = content.PlannerTasks || (typeof require === "function" ? require("./planner-tasks.js") : null);
    const courseColors = content.CourseColors || (typeof require === "function" ? require("./course-colors.js") : null);
    const api = factory(state, time, todoApi, effectsApi, planner, courseColors);
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasContent = Object.assign(root.APStudyCanvasContent || {}, { TodoRightRail: api });
}(typeof globalThis !== "undefined" ? globalThis : this, function (stateApi, timeApi, todoApi, effectsApi, plannerApi, courseColorsApi) {
    "use strict";
    const PLANNER_DIAGNOSTIC_BUILD = "pbr-diagnostic-20260906-1";

    /**
     * Operate-mode integration contract for the later content owner:
     *
     * const rail = TodoRightRail.create({ host, completionDispatcher, ... });
     * rail.mount({ tasks, range, settings, streak, feedback, calendar });
     * rail.update(nextViewModel); rail.destroy();
     *
     * `tasks` must be normalized Canvas/Nest records from TodoModel. The
     * renderer never submits assignments, writes Canvas academic records, or
     * invents completion state. It owns only the host's replacement DOM.
     *
     * update() converges: with the same host identity and a structurally
     * identical normalized view model, it recomputes a deterministic render
     * signature and returns without calling clearChildren or touching the
     * DOM. Only values that render or alter interactions feed the signature;
     * DOM nodes, functions, controller references, and timestamps that are
     * not displayed are excluded. destroy() and mount() reset the signature
     * so the first render of a (re)mounted root always runs.
     */

    const TABS = Object.freeze({ announcements: "announcements", assigned: "assigned", done: "done" });
    const TAB_ORDER = Object.freeze([TABS.announcements, TABS.assigned, TABS.done]);
    const TAB_LABELS = Object.freeze({ announcements: "Announcements", assigned: "Assigned", done: "Done" });
    const TAB_ICONS = Object.freeze({ announcements: "megaphone", assigned: "sheet", done: "check" });
    const PROGRESS_STYLES = Object.freeze(["none", "circle", "rainbow", "bar", "heart", "cloud", "oiia"]);
    const PROGRESS_STYLE_ALIASES = Object.freeze({ simple: "circle", nested: "rainbow", segmented: "bar", minimal: "bar" });
    const GROUP_ORDER = Object.freeze(["missing", "overdue", "today", "tomorrow", "in-2-days", "in-3-days", "in-4-days", "later", "submitted-ungraded", "undated", "completed"]);
    const ANNOUNCEMENT_GROUP_ORDER = Object.freeze(["unread", "recent"]);
    const GROUP_LABELS = Object.freeze({
        missing: "Missing",
        overdue: "Overdue",
        today: "Due today",
        tomorrow: "Due tomorrow",
        "in-2-days": "Due in 2 days",
        "in-3-days": "Due in 3 days",
        "in-4-days": "Due in 4 days",
        later: "Due later",
        "submitted-ungraded": "Submitted",
        undated: "No due date",
        completed: "Completed",
        all: "All tasks",
        unread: "Unread",
        recent: "Read"
    });
    const PERSONAL_COURSE_ID = "nest-personal";
    const TYPE_OPTIONS = Object.freeze(["assignment", "quiz", "discussion", "study", "task", "custom"]);
    const PRIORITY_OPTIONS = Object.freeze(["", "low", "normal", "high"]);
    const PRIORITY_LABELS = Object.freeze({ "": "Not set", low: "Low", normal: "Medium", high: "High" });
    const TYPE_LABELS = Object.freeze({ assignment: "Assignment", quiz: "Quiz", discussion: "Discussion", study: "Study session", task: "Task", custom: "Custom" });
    const REPEAT_LIMIT = 10;
    const REPEAT_OPTIONS = Object.freeze([{ value: "never", label: "Never" }].concat(
        Array.from({ length: REPEAT_LIMIT }, (_, index) => ({ value: String(index + 1), label: index === 0 ? "1 week" : `${index + 1} weeks` }))
    ));
    const CUSTOM_TYPE_MAX = 40;
    const TIMEFRAME_LABELS = Object.freeze({ day: "Day", week: "Week", month: "Month", custom: "Custom" });
    const CUSTOM_UNITS = Object.freeze([
        { value: "days", factor: 1, label: "Days" },
        { value: "weeks", factor: 7, label: "Weeks" },
        { value: "months", factor: 30, label: "Months" }
    ]);
    // Original geometry for the Heart and Cloud progress styles: authored
    // vector paths, no vendor artwork.
    const HEART_PATH = "M80 136C30 100 12 74 12 50C12 28 28 14 46 14C61 14 73 22 80 34C87 22 99 14 114 14C132 14 148 28 148 50C148 74 130 100 80 136Z";
    const CLOUD_PATH = "M42 116A24 24 0 0 1 44 68A32 32 0 0 1 102 50A28 28 0 0 1 134 76A21 21 0 0 1 126 116Z";
    const DEFAULT_SETTINGS = Object.freeze({
        todo_progress_style: "circle",
        todo_course_scope: "active",
        todo_date_format: "absolute",
        todo_timeframe: "week",
        todo_week_start: "rolling",
        todo_month_start: "rolling-30",
        todo_custom_range_days: 7,
        todo_clock_24h: false,
        todo_separate_scrollbar: false,
        todo_full_height: false,
        todo_streak_enabled: true,
        todo_grouping: true,
        todo_course_filtering: true,
        todo_hide_feedback: true,
        todo_celebration: "confetti",
        todo_celebration_intensity: "normal",
        todo_reduced_motion_safe: true,
        todo_link_target: "new-tab",
        todo_hover_preview: true,
        todo_missing_enabled: true,
        todo_missing_retention: "always",
        todo_urgency_enabled: true,
        todo_completion_authority: "canvas",
        todo_icons_visible: true,
        todo_course_color_mode: "inherit"
    });

    function plainObject(value) {
        return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    }

    function array(value) { return Array.isArray(value) ? value : []; }

    function text(value, fallback = "") {
        if (value === null || value === undefined) return fallback;
        const result = String(value).replace(/[\u0000-\u001f\u007f]/g, "").trim();
        return result || fallback;
    }

    function firstText(...values) { return values.map((value) => text(value)).find(Boolean) || ""; }

    function safeHttpsUrl(value) {
        const candidate = text(value);
        if (!candidate) return null;
        try {
            const url = new URL(candidate);
            if (url.protocol !== "https:" || url.username || url.password || url.hash) return null;
            return url.href;
        } catch (error) { return null; }
    }

    // Preview descriptions arrive as Canvas-authored HTML. Rendering happens
    // through text nodes only, so tags are stripped to plain prose and a small
    // fixed entity set is decoded — nothing from the source reaches the DOM as
    // markup.
    function htmlToText(value) {
        const source = text(value);
        if (!source) return "";
        return source
            .replace(/<\s*(br|\/p|\/div|\/li|\/h[1-6])\s*\/?>/gi, "\n")
            .replace(/<[^>]*>/g, "")
            .replace(/&nbsp;/gi, " ")
            .replace(/&amp;/gi, "&")
            .replace(/&lt;/gi, "<")
            .replace(/&gt;/gi, ">")
            .replace(/&quot;/gi, "\"")
            .replace(/&#0*39;|&apos;/gi, "'")
            .replace(/[ \t]+/g, " ")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
    }

    function uniqueById(tasks) {
        const seen = new Set();
        return array(tasks).filter((task) => {
            const key = text(task?.id || task?.eventRef || [task?.source || "task", task?.remoteId, task?.sourceItemKey, task?.title, task?.due?.utcInstant, task?.due?.date].filter((value) => value !== undefined && value !== null && value !== "").join(":"), "task");
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    function normalizeProgressStyle(value) {
        if (PROGRESS_STYLES.includes(value)) return value;
        const aliased = PROGRESS_STYLE_ALIASES[value];
        return PROGRESS_STYLES.includes(aliased) ? aliased : DEFAULT_SETTINGS.todo_progress_style;
    }

    function normalizeSettings(values) {
        const source = plainObject(values);
        const result = { ...DEFAULT_SETTINGS, ...source };
        const legacy = {
            todo_hr24: "todo_clock_24h",
            todo_progress_rings: "todo_progress_style",
            todo_hide_feedback: "todo_hide_feedback"
        };
        if (typeof source.todo_hr24 === "boolean" && source.todo_clock_24h === undefined) result.todo_clock_24h = source.todo_hr24;
        if (source.todo_progress_style === undefined && typeof source.todo_progress_rings === "boolean") result.todo_progress_style = source.todo_progress_rings ? "circle" : "none";
        if (source.todo_hide_feedback === undefined && typeof source.todo_hide_feedback === "boolean") result.todo_hide_feedback = source.todo_hide_feedback;
        Object.keys(legacy).forEach((key) => { if (source[key] !== undefined && result[legacy[key]] === undefined) result[legacy[key]] = source[key]; });
        result.todo_progress_style = normalizeProgressStyle(result.todo_progress_style);
        if (!["day", "week", "month", "custom"].includes(result.todo_timeframe)) result.todo_timeframe = DEFAULT_SETTINGS.todo_timeframe;
        if (!["absolute", "relative"].includes(result.todo_date_format)) result.todo_date_format = DEFAULT_SETTINGS.todo_date_format;
        if (!["new-tab", "same-tab"].includes(result.todo_link_target)) result.todo_link_target = DEFAULT_SETTINGS.todo_link_target;
        if (typeof result.todo_icons_visible !== "boolean") result.todo_icons_visible = DEFAULT_SETTINGS.todo_icons_visible;
        if (!["inherit", "neutral"].includes(result.todo_course_color_mode)) result.todo_course_color_mode = DEFAULT_SETTINGS.todo_course_color_mode;
        return result;
    }

    function makeElement(documentRef, tag, attributes = {}, content = null) {
        const element = documentRef.createElement(tag);
        Object.entries(attributes).forEach(([key, value]) => {
            if (value === undefined || value === null) return;
            if (key === "className") element.className = String(value);
            else if (key === "textContent") element.textContent = String(value);
            else if (key === "style" && value && typeof value === "object") Object.assign(element.style || {}, value);
            else element.setAttribute?.(key === "htmlFor" ? "for" : key, String(value));
        });
        if (content !== null && content !== undefined) element.textContent = String(content);
        return element;
    }

    function append(parent, child) {
        if (!parent || !child) return child;
        if (typeof parent.append === "function") parent.append(child);
        else parent.appendChild?.(child);
        return child;
    }

    function clearChildren(node) {
        if (!node) return;
        if (typeof node.replaceChildren === "function") node.replaceChildren();
        else while (node.firstChild) node.removeChild(node.firstChild);
    }

    function childrenOf(node) { return Array.from(node?.children || node?.childNodes || []); }

    // Deterministic deep serializer for render-signature inputs: object keys
    // are sorted, arrays keep order, primitives pass through, and function
    // values are dropped. Callers only feed explicitly picked render-visible
    // fields, so DOM nodes and controller references never reach this walk.
    function signatureValue(value) {
        if (value === null || typeof value !== "object") return value === undefined ? null : value;
        if (Array.isArray(value)) return value.map(signatureValue);
        const result = {};
        Object.keys(value).sort().forEach((key) => {
            const entry = value[key];
            if (typeof entry === "function") return;
            result[key] = signatureValue(entry);
        });
        return result;
    }

    // pointsText distinguishes null from undefined (dash placement), so the
    // signature must too.
    function pointPart(value) {
        if (value === undefined) return "undefined";
        if (value === null) return "null";
        return String(value);
    }

    function on(node, eventName, handler) { node?.addEventListener?.(eventName, handler); }

    function eventActionTarget(event) {
        let node = event?.target || null;
        while (node) {
            if (node.getAttribute?.("data-action")) return node;
            node = node.parentNode;
        }
        return null;
    }

    function eventCourseTarget(event) {
        let node = event?.target || null;
        while (node) {
            if (node.getAttribute?.("data-course-id")) return node;
            node = node.parentNode;
        }
        return null;
    }

    function setDisabled(node, disabled) {
        if (!node) return;
        node.disabled = Boolean(disabled);
        node.setAttribute?.("aria-disabled", String(Boolean(disabled)));
    }

    function courseLabel(course) {
        return text(course?.label || course?.code || course?.name || (course?.id ? `Course ${course.id}` : "Course"));
    }

    function courseCode(course) {
        return text(course?.code) || courseLabel(course);
    }

    function compactCourseCode(course, limit = 18) {
        const full = courseCode(course).replace(/\s+/g, " ").trim();
        const boundedLimit = Math.max(8, Number(limit) || 18);
        const semanticPrefix = full.split(/\s*(?::|\||\u2014)\s*/, 1)[0].trim();
        const candidate = semanticPrefix && semanticPrefix.length < full.length ? semanticPrefix : full;
        if (candidate.length <= boundedLimit) return candidate;
        const visible = candidate.slice(0, boundedLimit + 1);
        const boundary = Math.max(visible.lastIndexOf(" "), visible.lastIndexOf("_"), visible.lastIndexOf("-"));
        const cutoff = boundary >= Math.floor(boundedLimit * .6) ? boundary : boundedLimit;
        return `${candidate.slice(0, cutoff).replace(/[\s_-]+$/, "")}\u2026`;
    }

    // Course colors resolve through the shared course-colors module so the
    // sidebar rail and this rail paint the same course with the same
    // deterministic, collision-avoided fallback.
    const FALLBACK_COURSE_PALETTE = courseColorsApi?.FALLBACK_COURSE_PALETTE || Object.freeze([]);
    const normalizeHexColor = courseColorsApi?.normalizeHexColor || (() => null);
    const courseColor = courseColorsApi?.courseColor || (() => null);
    const resolveCourseColors = courseColorsApi?.resolveCourseColors || (() => []);

    function courseList(tasks, settings, range, domain, suppliedCourses = []) {
        // Arcs are an in-range academic-work summary, never a catalog of
        // every course or a proxy for announcement activity. The supplied
        // courses are the authoritative displayed dashboard set (from the
        // sidebar's course model), so under the "All courses" ring scope every
        // displayed course appears in the legend and graphics even when it has
        // no tasks in the current range — its zero totals stay real zeros,
        // never fabricated ones. Under the default "Courses with active tasks"
        // scope, a course earns its spot through any eligible in-range task —
        // open or completed (BC's completed-items loop marks those courses
        // active too, so finished work still shows its full ring). Only
        // courses with no in-range tasks stay out of the legend, the graphic
        // palette, and the course dropdown.
        const result = [];
        const seen = new Set();
        const candidates = array(tasks).filter((task) => {
            if (stateApi?.isUndatedNest?.(task) || domain.state?.countsTowardProgress?.(task) === false) return false;
            return !range || domain.time?.dueIsInRange?.(task?.due, range, task?.timezone || range?.timeZone);
        });
        const includeAll = settings?.todo_course_scope === "all";
        const listedCourses = new Set();
        candidates.forEach((task) => {
            const id = text(task?.course?.id) || (task?.source === "nest" ? PERSONAL_COURSE_ID : "");
            if (id) listedCourses.add(id);
        });
        const push = (plain) => {
            const id = text(plain.id);
            if (!id || seen.has(id)) return;
            seen.add(id);
            result.push({ id, label: courseLabel(plain), color: courseColor(plain, result.length), course: plain });
        };
        array(suppliedCourses).forEach((course) => {
            const plain = plainObject(course);
            if (!includeAll && !listedCourses.has(text(plain.id))) return;
            push(plain);
        });
        candidates.forEach((task) => {
            const course = plainObject(task?.course);
            if (!includeAll && !listedCourses.has(text(course.id))) return;
            push(course);
        });
        // Courseless Nest tasks share one synthetic Personal course so the
        // legend and the row filter keep one shared filter state.
        if (listedCourses.has(PERSONAL_COURSE_ID) && !seen.has(PERSONAL_COURSE_ID)) {
            seen.add(PERSONAL_COURSE_ID);
            result.push({ id: PERSONAL_COURSE_ID, label: "Personal", color: "#D4AF37", course: { id: PERSONAL_COURSE_ID, label: "Personal", code: "Personal", color: "#D4AF37" } });
        }
        // Resolve the whole displayed set at once: authoritative colors win,
        // and courses without one take collision-avoided deterministic slots
        // (see resolveCourseColors) instead of index-ordered palette picks.
        resolveCourseColors(result.map((entry) => entry.course)).forEach((color, index) => {
            result[index].color = color;
        });
        // One deterministic order for arcs, segments, legend chips, and the
        // filter: stable course identity (code-unit label, then id) — never
        // the order tasks happened to arrive in across refreshes.
        result.sort((left, right) => {
            if (left.label !== right.label) return left.label < right.label ? -1 : 1;
            return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
        });
        return result;
    }

    function sortEntries(entries, direction = "asc") {
        // Announcements read top-down newest first; assigned work reads
        // soonest-due first. Undated entries stay last in either direction.
        const missingKey = direction === "desc" ? "0000-00-00" : "9999-99-99";
        return array(entries).slice().sort((left, right) => {
            const leftDue = timeApi?.dueDateKey?.(left.task?.due) || missingKey;
            const rightDue = timeApi?.dueDateKey?.(right.task?.due) || missingKey;
            const byDate = direction === "desc" ? rightDue.localeCompare(leftDue) : leftDue.localeCompare(rightDue);
            return byDate || text(left.task?.title).localeCompare(text(right.task?.title));
        });
    }

    function progressFromCounts(counts) {
        const total = Number(counts?.total) || 0;
        const completed = Math.max(0, Math.min(total, Number(counts?.completed) || 0));
        return { percentage: total === 0 ? 100 : Math.round(completed * 100 / total), completed, total, label: total === 0 ? "No tasks" : `${completed}/${total}` };
    }

    function formatDue(due, settings, timeZone, now = Date.now()) {
        if (!due) return "No due date";
        const dateKey = timeApi?.dueDateKey?.(due, timeZone);
        if (!dateKey) return "Due date unavailable";
        if (settings.todo_date_format === "relative") {
            const today = timeApi?.localDateKey?.(now, timeZone);
            const delta = today && timeApi?.daysInclusive ? Math.round((Date.parse(`${dateKey}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000) : null;
            if (delta === 0) return "Due today";
            if (delta === 1) return "Due tomorrow";
            if (Number.isFinite(delta) && delta < 0) return `Due ${Math.abs(delta)}d ago`;
            if (Number.isFinite(delta)) return `Due in ${delta}d`;
        }
        const date = new Date(`${dateKey}T12:00:00Z`);
        let dateText;
        try {
            dateText = new Intl.DateTimeFormat(undefined, { month: "2-digit", day: "2-digit", timeZone: "UTC" }).format(date);
        } catch (error) { dateText = dateKey; }
        if (due.kind !== "instant" || !due.utcInstant) return `Due ${dateText}`;
        try {
            const timeText = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", hour12: !settings.todo_clock_24h, timeZone: timeZone || undefined }).format(new Date(due.utcInstant));
            return `Due ${dateText} at ${timeText}`;
        } catch (error) { return `Due ${dateText}`; }
    }

    // Announcement rows surface the posted time, not a due date: the same
    // formatted value without the "Due" prefix, in sentence case.
    function announcementDueText(dueValue) {
        if (dueValue === "No due date") return "No post date";
        if (dueValue === "Due date unavailable") return "Post date unavailable";
        const stripped = dueValue.replace(/^Due /, "");
        return stripped ? `${stripped.charAt(0).toUpperCase()}${stripped.slice(1)}` : stripped;
    }

    // Weekly recurrence expands into independent date keys, one per task.
    // Shifting date keys (rather than adding milliseconds to an instant) is
    // what preserves the local wall clock across DST transitions.
    function repeatOccurrenceDates(dueDate, repeats, shiftDateKey) {
        const date = String(dueDate || "");
        const weeks = Number.isInteger(repeats) && repeats > 0 ? Math.min(10, repeats) : 0;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || typeof shiftDateKey !== "function") return [];
        const dates = Array.from({ length: weeks + 1 }, (_, index) => shiftDateKey(date, index * 7));
        return dates.filter((value, index) => value && dates.indexOf(value) === index);
    }

    function formatRange(range) {        if (!range?.start || !range?.end) return "Choose dates";
        const format = (value) => {
            try { return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${value}T12:00:00Z`)); }
            catch (error) { return value; }
        };
        return range.start === range.end ? format(range.start) : `${format(range.start)} - ${format(range.end)}`;
    }

    // BC-style compact points copy: "15pts", "13/13pts", "–/2.5pts". A
    // completed row without a posted score keeps its possible value visible
    // behind the dash; an active row shows only the possible value.
    function pointsText(points, completed = false) {
        if (!points || (points.earned === null && points.possible === null)) return "";
        const value = (v) => v === null || v === undefined ? "–" : String(v);
        if (points.earned === null) return completed ? `–/${value(points.possible)}pts` : `${value(points.possible)}pts`;
        if (points.possible === null) return `${value(points.earned)}pts`;
        return `${value(points.earned)}/${value(points.possible)}pts`;
    }

    function draftPoints(draft) {
        const hasEarned = draft?.earned !== undefined && draft?.earned !== null && draft.earned !== "";
        const hasPossible = draft?.possible !== undefined && draft?.possible !== null && draft.possible !== "";
        if (!hasEarned && !hasPossible) return null;
        return { earned: hasEarned ? Number(draft.earned) : null, possible: hasPossible ? Number(draft.possible) : null };
    }

    // The Nest create payload may only use fields the background transport
    // allowlist accepts (`js/platform/transport.js` TODO_CREATE_FIELDS): the
    // custom-type name travels as the supported `type_label`, and points travel
    // as the supported scalar `points_earned`/`points_possible` fields. The
    // unsupported `custom_type`/`points` keys are rejected before dispatch.
    function nestCreatePayload(draft, idempotencyKey) {
        const type = TYPE_OPTIONS.includes(String(draft?.type)) ? String(draft.type) : "task";
        const points = draftPoints(draft);
        return {
            title: text(draft?.title),
            type,
            ...(type === "custom" && text(draft?.customType) ? { type_label: text(draft.customType) } : {}),
            ...(text(draft?.description) ? { description: text(draft.description) } : {}),
            ...(safeHttpsUrl(draft?.link) ? { link: safeHttpsUrl(draft.link) } : {}),
            ...(draft?.dueDate ? { due_date: draft.dueDate } : {}),
            ...(draft?.dueDate && draft?.dueTime ? { due_at: `${draft.dueDate}T${draft.dueTime}:00` } : {}),
            ...(draft?.timezone ? { timezone: draft.timezone } : {}),
            ...(draft?.priority ? { priority: draft.priority } : {}),
            ...(draft?.courseId ? { canvas_course_id: String(draft.courseId) } : {}),
            ...(points?.earned !== null && points?.earned !== undefined ? { points_earned: points.earned } : {}),
            ...(points?.possible !== null && points?.possible !== undefined ? { points_possible: points.possible } : {}),
            idempotency_key: idempotencyKey
        };
    }

    function sourceLabel(task) { return task?.source === "nest" ? "Nest" : "Canvas"; }

    function svgElement(documentRef, tag, attributes = {}) {
        const element = documentRef.createElementNS?.("http://www.w3.org/2000/svg", tag) || documentRef.createElement(tag);
        Object.entries(attributes).forEach(([key, value]) => {
            if (value === undefined || value === null) return;
            // SVG className is a read-only animated property; the class must go
            // through the class attribute for both DOM and styling.
            element.setAttribute?.(key === "className" ? "class" : key, String(value));
        });
        return element;
    }

    // Original inline icon artwork: one consistent stroke vocabulary, drawn
    // here; no vendor assets, emoji, or unicode glyphs.
    const ICON_PATHS = Object.freeze({
        close: Object.freeze(["M6 6l12 12", "M18 6L6 18"]),
        megaphone: Object.freeze(["M4 10v4h3.2L14 18.4V5.6L7.2 10H4z", "M16.6 8.6a4.8 4.8 0 0 1 0 6.8", "M6.4 14.4v4.6h2.4"]),
        sheet: Object.freeze(["M6.5 3.5h8l3 3v14h-11z", "M14.5 3.5v3h3", "M9.2 10h5.6", "M9.2 13.2h5.6", "M9.2 16.4h3.4"]),
        check: Object.freeze(["M5 12.6l4.4 4.4L19 7.6"]),
        chevronLeft: Object.freeze(["M14.5 6l-6 6 6 6"]),
        chevronRight: Object.freeze(["M9.5 6l6 6-6 6"]),
        gear: Object.freeze(["M12 8.7a3.3 3.3 0 1 0 0 6.6 3.3 3.3 0 0 0 0-6.6z", "M12 3.8v2.1", "M12 18.1v2.1", "M3.8 12h2.1", "M18.1 12h2.1", "M6.2 6.2l1.5 1.5", "M16.3 16.3l1.5 1.5", "M17.8 6.2l-1.5 1.5", "M7.7 16.3l-1.5 1.5"]),
        link: Object.freeze(["M9.8 13.7a4 4 0 0 0 5.7 0l2.9-2.9a4 4 0 1 0-5.7-5.7l-1.1 1.1", "M14.2 10.3a4 4 0 0 0-5.7 0l-2.9 2.9a4 4 0 1 0 5.7 5.7l1.1-1.1"]),
        book: Object.freeze(["M4.8 4.5h6v15h-6z", "M12.8 4.5h6v15h-6z", "M10.8 4.5v15"]),
        calendar: Object.freeze(["M4.5 6.5h15v13h-15z", "M4.5 10.5h15", "M8.5 3.8v3.4", "M15.5 3.8v3.4"]),
        star: Object.freeze(["M12 4.4l2.2 4.8 5.2.5-3.9 3.5 1.1 5.1-4.6-2.7-4.6 2.7 1.1-5.1-3.9-3.5 5.2-.5z"]),
        flame: Object.freeze(["M13.8 3.8c.4 3.1-1 4.9-2.8 6.4.1-1.7-.4-3-1.4-4.1C7.2 8 5.3 10.3 5.3 13.5a6.7 6.7 0 0 0 13.4 0c0-3-1.6-6.8-4.9-9.7z", "M12.1 12c-1.3 1.1-2 2.1-2 3.3a2.4 2.4 0 0 0 4.8 0c0-1.3-.8-2.5-2.8-3.3z"]),
        flag: Object.freeze(["M6 21V4.2", "M6 4.8c4-2 7.2 1.8 12 0V13c-4.8 1.8-8-2-12 0"]),
        chat: Object.freeze(["M4.5 5.5h9.5a1.6 1.6 0 0 1 1.6 1.6v4.8a1.6 1.6 0 0 1-1.6 1.6H9l-4.5 3.6z", "M18.2 9.6h.7a1.6 1.6 0 0 1 1.6 1.6v7.3l-3.8-3h-3.9"]),
        help: Object.freeze(["M12 3.8a8.2 8.2 0 1 0 0 16.4 8.2 8.2 0 0 0 0-16.4z", "M9.7 9.5a2.4 2.4 0 1 1 3.5 2.2c-.8.4-1.2 1-1.2 1.8", "M12 16.6h.01"]),
        note: Object.freeze(["M5 4.5h14v15H5z", "M9.2 15.6l6-6 1.7 1.7-6 6H9.2z"]),
        clock: Object.freeze(["M12 3.8a8.2 8.2 0 1 0 0 16.4 8.2 8.2 0 0 0 0-16.4z", "M12 7.6V12l3 1.8"])
    });

    // Tab seals: the competitor study coin motif (thin ring around a solid,
    // filled core) redrawn on the 24 grid with Nest restraint. Cores are solid
    // silhouettes — not line art — so the tray reads as stamped seals; the
    // selection state fills the core gold from CSS. Tabs are icon-only; the
    // view name rides in data-tip for the CSS hover/focus tooltip.
    const SEAL_ICONS = Object.freeze({
        megaphone: Object.freeze({
            // Flared horn plus a dropped handle: a bare wedge reads as an
            // arrow at 18px, so the silhouette needs both to say megaphone.
            // One nonzero path — the handle overlaps the horn body, and the
            // shared winding direction unions them without evenodd holes.
            core: "M6.2 10.6l10-3.7v10.2l-10-3.7zM7.2 13.6l1.9.75-.94 2.62a1 1 0 0 1-1.88-.67z"
        }),
        sheet: Object.freeze({
            // One compound path with fill-rule evenodd: the three line slits
            // are punched out of the page silhouette instead of stroked.
            core: "M8 7.4h4.8l2.9 2.9v6.3H8zM10.1 9.9h3.2v1.1h-3.2zM10.1 12.2h4.1v1.1h-4.1zM10.1 14.5h2.9v1.1h-2.9z",
            knockout: true
        }),
        check: Object.freeze({
            core: "M7.3 12.3l3.3 3.3 6.1-6.1-1.5-1.5-4.6 4.6-1.8-1.8z"
        })
    });

    function sealIcon(documentRef, name, size = 18) {
        const seal = SEAL_ICONS[name] || null;
        const svg = svgElement(documentRef, "svg", {
            className: "apstudy-todo-seal", viewBox: "0 0 24 24", width: size, height: size,
            fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round",
            "aria-hidden": "true", focusable: "false"
        });
        append(svg, svgElement(documentRef, "circle", { cx: 12, cy: 12, r: 9.1 }));
        if (seal) {
            append(svg, svgElement(documentRef, "path", {
                className: "apstudy-todo-seal-core", d: seal.core, fill: "currentColor", stroke: "none",
                ...(seal.knockout ? { "fill-rule": "evenodd" } : {})
            }));
        }
        return svg;
    }

    function icon(documentRef, name, size = 18) {
        const svg = svgElement(documentRef, "svg", {
            className: `apstudy-todo-icon is-${name}`, viewBox: "0 0 24 24", width: size, height: size,
            fill: "none", stroke: "currentColor", "stroke-width": "1.8", "stroke-linecap": "round", "stroke-linejoin": "round",
            "aria-hidden": "true", focusable: "false"
        });
        (ICON_PATHS[name] || []).forEach((d) => append(svg, svgElement(documentRef, "path", { d })));
        return svg;
    }

    // Nest's egg mark warmed by an original two-tone flame. Keeping this as
    // inline vector art lets the shell inherit light/dark tokens while the
    // flame remains legible at the rail's compact size.
    function streakEggIcon(documentRef, size = 34) {
        const svg = svgElement(documentRef, "svg", {
            className: "apstudy-streak-egg", viewBox: "0 0 32 36", width: size, height: Math.round(size * 1.125),
            "aria-hidden": "true", focusable: "false"
        });
        append(svg, svgElement(documentRef, "path", { className: "apstudy-streak-egg-flame", d: "M18.5 1.8c.8 4-1.1 6.1-3.3 8.2.2-2.2-.7-4-2.2-5.3-4.6 3.9-7.3 8.5-6.1 13.4 1.2 5.1 5.9 8.5 11.1 7.6 5.8-1 9.1-6.5 7.6-12.1-.9-3.5-3.2-8.2-7.1-11.8Z" }));
        append(svg, svgElement(documentRef, "path", { className: "apstudy-streak-egg-flame-core", d: "M18.1 10.3c.2 2.1-.8 3.4-2 4.5.1-1.2-.3-2.1-1.2-2.9-2.4 2.2-3.4 4.7-2.6 7.1.7 2.2 2.8 3.5 5 3 2.7-.6 4.1-3.2 3.4-5.8-.4-1.7-1.4-4-2.6-5.9Z" }));
        append(svg, svgElement(documentRef, "path", { className: "apstudy-streak-egg-shell", d: "M16 10.2c-5.5 0-9 5.2-9 11.5C7 29.1 11.2 34 16 34s9-4.9 9-12.3c0-6.3-3.5-11.5-9-11.5Z" }));
        append(svg, svgElement(documentRef, "path", { className: "apstudy-streak-egg-smile", d: "M12.4 25.7c1 .8 2.2 1.2 3.6 1.2s2.6-.4 3.6-1.2" }));
        append(svg, svgElement(documentRef, "circle", { className: "apstudy-streak-egg-eye", cx: 12.6, cy: 21.5, r: .8 }));
        append(svg, svgElement(documentRef, "circle", { className: "apstudy-streak-egg-eye", cx: 19.4, cy: 21.5, r: .8 }));
        return svg;
    }

    function isStreakMilestone(value) {
        const days = Math.max(0, Number(value) || 0);
        return [1, 5, 10, 25].includes(days) || (days >= 50 && days % 50 === 0);
    }

    function statusCircleIcon(documentRef, completed) {
        const svg = svgElement(documentRef, "svg", {
            className: "apstudy-todo-task-complete-mark", viewBox: "0 0 24 24", width: 16, height: 16,
            fill: "none", stroke: "currentColor", "stroke-width": "1.8", "stroke-linecap": "round", "stroke-linejoin": "round",
            "aria-hidden": "true", focusable: "false"
        });
        append(svg, svgElement(documentRef, "circle", { cx: 12, cy: 12, r: 8.6 }));
        append(svg, svgElement(documentRef, "path", { d: "M8.4 12.4l2.4 2.4 4.8-4.9", "data-complete-check": "true" }));
        if (completed) svg.setAttribute("data-is-complete", "true");
        return svg;
    }

    function renderProgressGraphic(documentRef, style, progress, courses) {
        const normalized = normalizeProgressStyle(style);
        if (normalized === "none") return makeElement(documentRef, "span", { className: "apstudy-todo-progress-none is-none", "data-progress-style": normalized, "aria-hidden": "true" });
        // Bar, circle, heart, cloud, and oiia draw into fixed frames. The
        // rainbow's frame is computed per course count below so the graphic
        // reserves only the height its bands actually draw.
        let viewBox = normalized === "bar" ? "0 0 160 44" : normalized === "rainbow" ? null : "0 0 160 160";
        const svg = svgElement(documentRef, "svg", {
            className: `apstudy-todo-progress-graphic is-${normalized}`,
            "data-progress-style": normalized,
            ...(normalized === "oiia" ? { "data-oiia-original": "true" } : {}),
            ...(viewBox ? { viewBox } : {}),
            "aria-hidden": "true", focusable: "false"
        });
        const empty = progress.total === 0;
        // Every course the legend lists stays in the graphic: palettes are
        // never sliced, and each style's geometry scales with the course count
        // instead of silently dropping courses past a fixed cap.
        const palette = empty
            ? [{ id: "", color: "#0d1328", progress: { completed: 1, total: 1 } }]
            : (courses.length ? courses : [{ id: "", color: "#D4AF37", progress: { completed: progress.completed, total: progress.total } }]);
        const tint = (color) => `color-mix(in srgb, ${color} 30%, var(--todo-surface, #ffffff))`;
        const clampRatio = (value) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
        // Value shapes mount empty and sweep to their final dash on reveal;
        // reduced motion collapses the transition to an instant state change.
        const applyDash = (node, length, dashRatio, deferred) => {
            const final = `${length * clampRatio(dashRatio)} ${length}`;
            if (deferred) {
                node.setAttribute("stroke-dasharray", `0 ${length}`);
                node.setAttribute("data-final-dash", final);
            } else {
                node.setAttribute("stroke-dasharray", final);
            }
        };
        const courseRatio = (course) => {
            const counts = plainObject(course.progress);
            if (!Number.isFinite(counts.total) || counts.total === 0) return 0;
            return clampRatio(Number(counts.completed) / Number(counts.total));
        };
        const ring = (cx, cy, radius, color, dashRatio = 1, extra = {}) => {
            const circumference = 2 * Math.PI * radius;
            const node = svgElement(documentRef, "circle", { cx, cy, r: radius, fill: "none", stroke: color, "stroke-width": extra.width || 7, "stroke-linecap": "round" });
            applyDash(node, circumference, dashRatio, extra.deferred === true);
            node.setAttribute("transform", `rotate(-90 ${cx} ${cy})`);
            return node;
        };
        const arc = (radius, color, dashRatio = 1, width = 8) => {
            const length = Math.PI * radius;
            const node = svgElement(documentRef, "path", {
                d: `M ${80 - radius} 134 A ${radius} ${radius} 0 0 1 ${80 + radius} 134`,
                fill: "none", stroke: color, "stroke-width": width, "stroke-linecap": "round"
            });
            applyDash(node, length, dashRatio, true);
            return node;
        };
        const shapeLayer = (pathData, color, scale) => svgElement(documentRef, "path", {
            d: pathData,
            transform: scale === 1 ? undefined : `translate(80 78) scale(${scale}) translate(-80 -78)`,
            fill: "none", stroke: color, "stroke-width": 6, "stroke-linejoin": "round"
        });
        if (normalized === "circle") {
            // Every represented course keeps a ring: spacing tightens with the
            // count so radii never go negative and no course is dropped.
            const count = palette.length;
            const outer = 66;
            const inner = 16;
            const desired = count > 4 ? 7 : 9;
            const spacing = count > 1 ? Math.min(desired, (outer - inner) / (count - 1)) : desired;
            const width = Math.max(1.75, Math.min(count > 4 ? 5 : 7, spacing - 2));
            palette.forEach((course, index) => {
                const radius = outer - index * spacing;
                append(svg, ring(80, 80, radius, "var(--todo-track, #e3e0d9)", 1, { width }));
                const fill = empty ? 1 : courseRatio(course);
                const value = ring(80, 80, radius, course.color, fill, { width, deferred: true });
                value.setAttribute("data-course-id", text(course.id));
                append(svg, value);
            });
        } else if (normalized === "rainbow") {
            // Reserve a stable inner opening first, then divide only the outer
            // radial space among courses. The previous algorithm started at a
            // tiny inner radius, so the HTML readout could overlap the inner
            // bands as course count and font metrics changed. Keeping the
            // clear radius invariant makes the readout geometry deterministic.
            const count = palette.length;
            const outerEdge = 76;
            const openingEdge = 38;
            const space = outerEdge - openingEdge;
            const bandWidth = space / count;
            const gap = count === 1 ? 6 : Math.min(count > 4 ? 1.5 : 2.5, bandWidth * .35);
            const width = Math.max(.35, bandWidth - gap);
            palette.forEach((course, index) => {
                const radius = openingEdge + bandWidth * (count - index - .5);
                append(svg, arc(radius, `color-mix(in srgb, ${course.color} 24%, var(--todo-surface, #ffffff))`, 1, width));
                const value = arc(radius, course.color, empty ? 1 : courseRatio(course), width);
                value.setAttribute("data-course-id", text(course.id));
                append(svg, value);
            });

            // Draw only the percentage in the same coordinate system as the
            // arcs. Its baseline sits just above the arc endpoints; type size
            // respects the clear radius, so 0%, 100%, narrow rails, and changing
            // course counts all remain centered inside the opening. The task
            // fraction stays in normal document flow directly below the arch.
            const openingRadius = openingEdge + gap / 2;
            const percentageText = `${progress.percentage}%`;
            const percentSize = Math.min(percentageText.length > 3 ? 15 : 17.5, openingRadius * .5);
            const percentY = 128;
            const readout = svgElement(documentRef, "g", { className: "apstudy-todo-progress-svg-readout", "pointer-events": "none" });
            const percent = svgElement(documentRef, "text", { className: "apstudy-todo-progress-svg-percent", x: 80, y: percentY, "font-size": percentSize });
            percent.textContent = percentageText;
            append(readout, percent);
            append(svg, readout);
            svg.setAttribute("data-opening-radius", String(openingRadius));
            svg.setAttribute("data-arc-baseline", "134");
            // Compact per-count frame: the viewBox hugs the drawn bands —
            // round caps included, two units of breath on each side — so a
            // lone fat arc and a dense arch each reserve only the height they
            // draw. The CSS box follows this intrinsic ratio (no fixed
            // aspect-ratio), which removes the blank band the old 160/84 box
            // left under few-course arches at narrow widths.
            const outermostRadius = openingEdge + bandWidth * (count - .5);
            const halfStroke = width / 2;
            const top = Math.floor(134 - outermostRadius - halfStroke - 2);
            const bottom = Math.ceil(134 + halfStroke + 2);
            svg.setAttribute("viewBox", `0 ${top} 160 ${bottom - top}`);
        } else if (normalized === "bar") {
            append(svg, svgElement(documentRef, "rect", { x: 8, y: 14, width: 144, height: 16, rx: 8, fill: "var(--todo-track, #e3e0d9)" }));
            if (!empty && progress.completed > 0) {
                // Each contributing course takes its share of completions; a
                // small floor keeps slivers visible and the widths rescale so
                // the stacked segments end inside the track instead of
                // spilling past it when many courses contribute.
                const contributors = palette.filter((course) => (Number(plainObject(course.progress).completed) || 0) > 0);
                const weights = contributors.map((course) => Math.max(2, 144 * ((Number(plainObject(course.progress).completed) || 0) / progress.completed)));
                const scale = Math.min(1, 144 / weights.reduce((sum, value) => sum + value, 0));
                let offset = 8;
                contributors.forEach((course, index) => {
                    const width = weights[index] * scale;
                    const segment = svgElement(documentRef, "rect", { x: offset, y: 14, width, height: 16, rx: 7, fill: course.color });
                    segment.setAttribute("data-course-id", text(course.id));
                    append(svg, segment);
                    offset += width;
                });
            }
        } else if (normalized === "heart" || normalized === "cloud") {
            const pathData = normalized === "heart" ? HEART_PATH : CLOUD_PATH;
            // One nested layer per represented course; the step shrinks with
            // the count so every layer keeps a positive scale (no slicing).
            const step = palette.length > 1 ? Math.min(0.17, 0.75 / (palette.length - 1)) : 0;
            palette.forEach((course, index) => {
                const layer = shapeLayer(pathData, empty ? "var(--todo-muted, #4b4a47)" : course.color, 1 - index * step);
                if (index === 0 && !empty) layer.style?.setProperty?.("fill", tint(course.color));
                layer.setAttribute("data-course-id", text(course.id));
                append(svg, layer);
            });
        } else if (normalized === "oiia") {
            // OIIA is an original abstract orbit: a quiet geometric nucleus
            // with offset orbital paths. It deliberately contains no mascot,
            // cat, vendor art, remote image, or copied path data.
            append(svg, svgElement(documentRef, "ellipse", { cx: 80, cy: 80, rx: 54, ry: 22, fill: "none", stroke: "var(--todo-text, #1f1f1e)", "stroke-width": 2, "data-oiia-orbit": "outer" }));
            append(svg, svgElement(documentRef, "ellipse", { cx: 80, cy: 80, rx: 33, ry: 14, fill: "none", stroke: "#D4AF37", "stroke-width": 3, transform: "rotate(-24 80 80)", "data-oiia-orbit": "inner" }));
            append(svg, svgElement(documentRef, "circle", { cx: 80, cy: 80, r: 9, fill: "#D4AF37", "data-oiia-nucleus": "true" }));
            append(svg, svgElement(documentRef, "circle", { cx: 126, cy: 64, r: 5, fill: "#b3261e", "data-oiia-marker": "true" }));
        }
        return svg;
    }

    function createTodoRightRail(options = {}) {
        const documentRef = options.document || globalThis.document;
        const windowRef = options.window || globalThis.window;
        const domain = {
            state: options.domain?.state || stateApi,
            time: options.domain?.time || timeApi,
            api: options.domain?.api || todoApi
        };
        const effects = options.effects?.celebrate
            ? options.effects
            : effectsApi?.createTodoEffects?.({ document: documentRef, window: windowRef, setTimer: options.setTimer, clearTimer: options.clearTimer });
        const callbacks = options;
        const previewDelays = {
            open: Number.isFinite(options.hoverPreviewDelayMs) ? Math.max(0, options.hoverPreviewDelayMs) : 1200
        };
        let host = options.host || null;
        let rootNode = null;
        let modalNode = null;
        let effectsLayer = null;
        let nativeNodes = null;
        let mounted = false;
        let modalOpen = false;
        let streakOpen = false;
        let streakPopup = null;
        let streakDetailsOpen = false;
        let streakTrigger = null;
        let lastReliableStreakDays = null;
        const celebratedStreakMilestones = new Set();
        let modalDraft = null;
        let modalErrors = {};
        let modalMessage = "";
        let modalBusy = false;
        let modalStatus = "idle";
        let modalConfirmDiscard = false;
        let modalTask = null;
        let modalDateMutationBlocked = false;
        // Per-occurrence create progress for weekly repeats. Retained while the
        // draft is unchanged so a retry only submits the remaining/uncertain
        // occurrences and can never duplicate a confirmed one.
        let modalCreateProgress = { signature: "", created: new Map(), failedDate: null, uncertain: false };
        let previousFocus = null;
        let modalFields = {};
        let completionPending = null;
        let completionErrors = new Map();
        let selectedCourseIds = [];
        let selectedTab = TABS.assigned;
        let collapsedGroups = new Set(["announcements:recent"]);
        let previewFor = null;
        let previewTimer = null;
        let previewKeydown = null;
        let previewTrigger = null;
        let previewBodies = new Map();
        let previewRequestSequence = 0;
        let requestSequence = 0;
        let lifecycleVersion = 0;
        let state = {
            tasks: [],
            settings: normalizeSettings(options.settings),
            range: null,
            streak: null,
            feedback: [],
            courses: [],
            calendar: plainObject(options.calendar),
            liveMessage: "",
            now: options.now || Date.now()
        };

        function taskTimeZone(task = null, range = state.range) { return task?.timezone || range?.timeZone || state.timeZone || timeApi?.browserTimeZone?.() || "UTC"; }

        function missingAgeDays(task, now = state.now, range = state.range) {
            const dueKey = domain.time?.dueDateKey?.(task?.due, taskTimeZone(task, range));
            const today = domain.time?.localDateKey?.(now, taskTimeZone(task, range));
            if (!dueKey || !today) return null;
            return Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${dueKey}T00:00:00Z`)) / 86400000);
        }

        function missingVisible(task, settings = state.settings, now = state.now, range = state.range) {
            const classification = domain.state?.classifyTask?.(task, { now, timeZone: taskTimeZone(task, range) });
            if (!classification?.missing) return true;
            if (settings.todo_missing_enabled === false || settings.todo_missing_retention === "never") return false;
            const retentionDays = { "3-days": 3, "1-week": 7, "1-month": 31 }[settings.todo_missing_retention];
            if (!Number.isFinite(retentionDays)) return true;
            const age = missingAgeDays(task, now, range);
            return age === null || age <= retentionDays;
        }

        function renderableTasks(tasks, settings = state.settings, now = state.now, range = state.range) {
            return array(tasks).filter((task) => missingVisible(task, settings, now, range));
        }

        function fallbackRange(settings, input = {}) {
            if (input?.range?.start && input?.range?.end) return input.range;
            const timeZone = input.timeZone || state.range?.timeZone || state.timeZone;
            const now = input.now ?? state.now;
            const timeframe = settings.todo_timeframe;
            if (timeframe === "week" && settings.todo_week_start && settings.todo_week_start !== "rolling") {
                const anchor = domain.time?.localDateKey?.(now, timeZone);
                let weekday = 0;
                try {
                    const name = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: timeZone || undefined }).format(new Date(now));
                    weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(name);
                } catch (error) {}
                const startDay = { sunday: 0, saturday: 6, monday: 1 }[settings.todo_week_start];
                if (anchor && Number.isInteger(startDay) && weekday >= 0) {
                    const start = domain.time.shiftDateKey(anchor, -((weekday - startDay + 7) % 7));
                    return { start, end: domain.time.shiftDateKey(start, 6), length: 7, inclusive: true, kind: "week", timeZone: domain.time.resolveTimeZone(timeZone) };
                }
            }
            if (timeframe === "month" && settings.todo_month_start === "first") {
                const anchor = domain.time?.localDateKey?.(now, timeZone);
                if (anchor) {
                    const [year, month] = anchor.split("-").map(Number);
                    const start = `${year}-${String(month).padStart(2, "0")}-01`;
                    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
                    return { start, end: `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`, length: lastDay, inclusive: true, kind: "month", timeZone: domain.time.resolveTimeZone(timeZone) };
                }
            }
            return domain.time?.buildRange?.({
                timeframe,
                now,
                timeZone,
                customStart: input.customStart || settings.todo_custom_start,
                customEnd: input.customEnd || settings.todo_custom_end
            })?.value || null;
        }

        function setLive(message) { state.liveMessage = text(message); }

        function getCourseSelection(nextTasks, nextSettings, range, inputSelection, suppliedCourses = []) {
            const candidates = inputSelection === undefined ? selectedCourseIds : array(inputSelection).map(String);
            const available = courseList(nextTasks, nextSettings, range, domain, suppliedCourses);
            const retained = domain.state?.retainCourseFilter?.(candidates, available, {
                previousTimeframe: state.settings?.todo_timeframe,
                timeframe: nextSettings.todo_timeframe
            }) || { selectedCourseIds: candidates, resetReason: null };
            if (retained.resetReason) {
                try { callbacks.onCourseFilterReset?.(retained.resetReason); } catch (error) {}
            }
            return { available, selected: array(retained.selectedCourseIds).map(String) };
        }

        function viewModel(input = {}) {
            const nextSettings = normalizeSettings({ ...state.settings, ...plainObject(input.settings) });
            const hasTaskInput = ["tasks", "canvasTasks", "nestTasks"].some((key) => Object.prototype.hasOwnProperty.call(input, key));
            const nextTasks = uniqueById(hasTaskInput ? array(input.tasks).concat(array(input.canvasTasks), array(input.nestTasks)) : state.tasks);
            const nextRange = fallbackRange(nextSettings, input);
            const nextNow = input.now ?? state.now ?? Date.now();
            const visibleTasks = renderableTasks(nextTasks, nextSettings, nextNow, nextRange);
            const courseState = getCourseSelection(visibleTasks, nextSettings, nextRange, input.selectedCourseIds, input.courses);
            state = {
                ...state,
                ...input,
                tasks: nextTasks,
                settings: nextSettings,
                range: nextRange,
                courses: courseState.available,
                feedback: Object.prototype.hasOwnProperty.call(input, "feedback") ? array(input.feedback) : state.feedback,
                calendar: plainObject(input.calendar || state.calendar),
                now: nextNow
            };
            selectedCourseIds = courseState.selected;
            if (TAB_ORDER.includes(input.selectedTab)) selectedTab = input.selectedTab;
            if (Array.isArray(input.collapsedGroups)) collapsedGroups = new Set(input.collapsedGroups.map(String));
        }

        function filteredTasks() {
            const tasks = renderableTasks(state.tasks);
            return domain.state?.filterByCourses?.(tasks, selectedCourseIds) || tasks;
        }

        function grouped() {
            return domain.state?.groupTasks?.(filteredTasks(), { range: state.range, now: state.now, timeZone: state.range?.timeZone || state.timeZone })
                || { missing: [], active: [], completed: [], excluded: [], order: [] };
        }

        function periodProgress() {
            const counts = domain.state?.periodCounts?.(filteredTasks(), state.range, state.range?.timeZone || state.timeZone, state.now);
            if (counts) return progressFromCounts(counts);
            return domain.state?.progress?.(filteredTasks()) || { percentage: 100, completed: 0, total: 0, label: "No tasks" };
        }

        function taskCourseKey(task) {
            const id = text(task?.course?.id);
            return id || (task?.source === "nest" ? PERSONAL_COURSE_ID : "");
        }

        function courseProgress(courseId) {
            const tasks = filteredTasks().filter((task) => taskCourseKey(task) === String(courseId));
            const eligible = tasks.filter((task) => !domain.state?.isUndatedNest?.(task)
                && domain.state?.countsTowardProgress?.(task) !== false
                && (!state.range || domain.time?.dueIsInRange?.(task?.due, state.range, taskTimeZone(task))));
            return { completed: eligible.filter((task) => task.completion).length, total: eligible.length };
        }

        function courseColorForTask(task) {
            if (state.settings.todo_course_color_mode === "neutral") return "var(--todo-muted)";
            if (taskCourseKey(task) === PERSONAL_COURSE_ID) return "#D4AF37";
            const id = text(task?.course?.id);
            // Row identity must match the legend and the graphic: the course's
            // resolved color from the displayed set (authoritative merge plus
            // collision-avoided fallbacks), never a per-row re-derivation.
            const entry = state.courses.find((course) => String(course?.id) === id);
            if (entry) return text(entry.color) || courseColor(entry, 0);
            return courseColor(task?.course, 0);
        }

        function unreadCount() {
            return array(state.tasks).filter((task) => task?.type === "announcement" && task?.unread === true).length;
        }

        function renderHeader() {
            const header = makeElement(documentRef, "header", { className: "apstudy-todo-header" });
            append(header, makeElement(documentRef, "h2", { id: "apstudy-todo-title", textContent: "To-Do List" }));
            const actions = makeElement(documentRef, "div", { className: "apstudy-todo-header-actions" });
            const calendarState = text(state.calendar?.state || state.calendar?.status || state.calendarConnectionState, "unavailable").toLowerCase();
            const statusLabel = calendarState === "connected" || calendarState === "authenticated" ? "Connected" : calendarState === "syncing" || state.calendar?.syncing === true ? "Syncing" : calendarState === "signed_out" || calendarState === "disconnected" ? "Not connected" : calendarState === "error" || calendarState === "needs_attention" ? "Needs attention" : "Unavailable";
            const sync = makeElement(documentRef, "button", {
                type: "button",
                className: "apstudy-todo-sync",
                "data-action": "open-calendar-accounts",
                "data-sync-state": calendarState,
                "aria-label": `Sync, ${statusLabel}. Opens Calendar and Accounts.`,
                "aria-describedby": "apstudy-todo-calendar-state",
                title: statusLabel
            });
            append(sync, makeElement(documentRef, "span", { className: "apstudy-todo-sync-dot", "aria-hidden": "true" }));
            append(sync, makeElement(documentRef, "span", { className: "apstudy-todo-sync-label", textContent: "Sync" }));
            on(sync, "click", () => (callbacks.onOpenCalendarAccounts || callbacks.onOpenCalendarSettings)?.());
            append(actions, sync);
            append(actions, makeElement(documentRef, "span", { className: "apstudy-visually-hidden", id: "apstudy-todo-calendar-state", "data-sync-state": calendarState, textContent: statusLabel }));
            const settingsButton = makeElement(documentRef, "button", { type: "button", className: "apstudy-todo-settings", "data-action": "open-todo-settings", "aria-label": "Open To-Do settings", title: "Settings" });
            append(settingsButton, icon(documentRef, "gear", 16));
            on(settingsButton, "click", () => callbacks.onOpenTodoSettings?.());
            append(actions, settingsButton);
            append(header, actions);
            append(rootNode, header);
        }

        function navigate(direction) {
            const shifted = domain.time?.shiftRange?.(state.range, direction);
            if (!shifted?.ok) return;
            selectedCourseIds = [];
            state.range = shifted.value;
            setLive(direction < 0 ? "Previous timeframe selected." : "Next timeframe selected.");
            callbacks.onTimeframeChange?.({ timeframe: state.settings.todo_timeframe, range: state.range, direction });
            renderRail();
        }

        function resetToToday() {
            const fresh = fallbackRange(state.settings, { now: Date.now(), timeZone: state.range?.timeZone || state.timeZone });
            if (!fresh) return;
            selectedCourseIds = [];
            state.range = fresh;
            state.now = Date.now();
            setLive("Back to today.");
            callbacks.onTimeframeChange?.({ timeframe: state.settings.todo_timeframe, range: state.range });
            renderRail();
        }

        function commitTimeframe(timeframe, custom = {}) {
            const nextSettings = normalizeSettings({ ...state.settings, todo_timeframe: timeframe, ...custom.settings });
            const nextRange = fallbackRange(nextSettings, { now: state.now, timeZone: state.range?.timeZone || state.timeZone, customStart: custom.start, customEnd: custom.end });
            if (!nextRange) {
                setLive("Choose a valid timeframe.");
                renderRail();
                return false;
            }
            selectedCourseIds = [];
            state.settings = nextSettings;
            state.range = nextRange;
            setLive(`${TIMEFRAME_LABELS[timeframe] || timeframe} timeframe selected.`);
            callbacks.onTimeframeChange?.({ timeframe, range: state.range, settings: nextSettings });
            renderRail();
            return true;
        }

        function customUnitForDays(days) {
            const value = Number(days);
            if (Number.isFinite(value) && value >= 30 && value % 30 === 0) return "months";
            if (Number.isFinite(value) && value >= 7 && value % 7 === 0) return "weeks";
            return "days";
        }

        function renderTimeframe() {
            const nav = makeElement(documentRef, "nav", { className: "apstudy-todo-timeframe", "aria-label": "Task timeframe" });
            const select = makeElement(documentRef, "select", { className: "apstudy-todo-timeframe-select", "aria-label": "Task timeframe" });
            ["day", "week", "month", "custom"].forEach((value) => {
                const option = makeElement(documentRef, "option", { value, textContent: TIMEFRAME_LABELS[value] });
                option.selected = value === state.settings.todo_timeframe;
                append(select, option);
            });
            on(select, "change", () => commitTimeframe(select.value));
            append(nav, select);
            const timeframeLabel = TIMEFRAME_LABELS[state.settings.todo_timeframe] || "";
            const previous = makeElement(documentRef, "button", { type: "button", className: "apstudy-todo-range-arrow", "data-action": "previous-timeframe", "aria-label": `Previous ${state.settings.todo_timeframe}`, title: `Previous ${timeframeLabel}` });
            append(previous, icon(documentRef, "chevronLeft", 16));
            const next = makeElement(documentRef, "button", { type: "button", className: "apstudy-todo-range-arrow", "data-action": "next-timeframe", "aria-label": `Next ${state.settings.todo_timeframe}`, title: `Next ${timeframeLabel}` });
            append(next, icon(documentRef, "chevronRight", 16));
            on(previous, "click", () => navigate(-1));
            on(next, "click", () => navigate(1));
            const range = makeElement(documentRef, "div", { className: "apstudy-todo-range" });
            append(range, previous);
            append(range, makeElement(documentRef, "output", { className: "apstudy-todo-range-output", "aria-live": "polite", textContent: formatRange(state.range) }));
            append(range, next);
            append(nav, range);
            const currentRange = fallbackRange(state.settings, { now: state.now, timeZone: state.range?.timeZone || state.timeZone });
            const isCurrentRange = Boolean(currentRange && state.range && currentRange.start === state.range.start && currentRange.end === state.range.end);
            const today = makeElement(documentRef, "button", {
                type: "button", className: "apstudy-todo-today", "data-action": "today", "aria-label": "Back to today", title: "Back to today", textContent: "Today",
                ...(isCurrentRange ? { hidden: "" } : {})
            });
            on(today, "click", resetToToday);
            append(nav, today);
            if (state.settings.todo_timeframe === "custom") {
                const unit = customUnitForDays(state.settings.todo_custom_range_days);
                const factor = CUSTOM_UNITS.find((entry) => entry.value === unit)?.factor || 1;
                const custom = makeElement(documentRef, "div", { className: "apstudy-todo-custom-range", "data-custom-range": "true" });
                const value = makeElement(documentRef, "input", { type: "number", className: "apstudy-todo-custom-value", min: "1", step: "1", "aria-label": "Custom range length", value: String(Math.max(1, Math.round((Number(state.settings.todo_custom_range_days) || 7) / factor))) });
                const unitSelect = makeElement(documentRef, "select", { className: "apstudy-todo-custom-unit", "aria-label": "Custom range unit" });
                CUSTOM_UNITS.forEach((entry) => {
                    const option = makeElement(documentRef, "option", { value: entry.value, textContent: entry.label });
                    option.selected = entry.value === unit;
                    append(unitSelect, option);
                });
                const save = makeElement(documentRef, "button", { type: "button", className: "apstudy-todo-custom-save", "data-action": "save-custom-range", textContent: "Save" });
                const help = makeElement(documentRef, "span", { className: "apstudy-todo-custom-help", textContent: "Rolling window starting today, 1-90 days." });
                const updateCustom = () => {
                    const amount = Number(value.value);
                    const unitFactor = CUSTOM_UNITS.find((entry) => entry.value === unitSelect.value)?.factor || 1;
                    if (!Number.isFinite(amount) || amount < 1) {
                        help.textContent = "Choose a length of at least 1.";
                        help.setAttribute?.("role", "alert");
                        return;
                    }
                    const days = Math.max(1, Math.min(90, Math.round(amount * unitFactor)));
                    const timeZone = state.range?.timeZone || state.timeZone;
                    const start = domain.time?.localDateKey?.(Date.now(), timeZone);
                    const end = start ? domain.time?.shiftDateKey?.(start, days - 1) : null;
                    if (!start || !end) {
                        help.textContent = "Choose a valid range.";
                        help.setAttribute?.("role", "alert");
                        return;
                    }
                    help.textContent = `${days} days inclusive`;
                    help.removeAttribute?.("role");
                    commitTimeframe("custom", { start, end, settings: { todo_custom_range_days: days } });
                };
                on(save, "click", updateCustom);
                on(value, "keydown", (event) => { if (event?.key === "Enter") { event.preventDefault?.(); updateCustom(); } });
                append(custom, value);
                append(custom, unitSelect);
                append(custom, save);
                append(custom, help);
                append(nav, custom);
            }
            append(rootNode, nav);
        }

        function revealGraphic(svg) {
            const ready = () => {
                childrenOf(svg).forEach((node) => {
                    const final = node.getAttribute?.("data-final-dash");
                    if (final) {
                        node.setAttribute("stroke-dasharray", final);
                        node.removeAttribute?.("data-final-dash");
                    }
                });
                const current = svg.getAttribute("class") || "";
                if (!current.includes("is-ready")) svg.setAttribute("class", `${current} is-ready`.trim());
            };
            if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => requestAnimationFrame(ready));
            else if (typeof setTimeout === "function") setTimeout(ready, 50);
            else ready();
        }

        function dimRings(courseId) {
            const graphic = rootNode?.querySelector?.(".apstudy-todo-progress-graphic");
            if (!graphic) return;
            childrenOf(graphic).forEach((node) => {
                const id = node.getAttribute?.("data-course-id");
                if (!id) return;
                if (courseId && id !== courseId) node.setAttribute("data-dim", "true");
                else node.removeAttribute?.("data-dim");
            });
        }

        function toggleCourseFilter(courseId) {
            const id = String(courseId);
            selectedCourseIds = selectedCourseIds.length === 1 && selectedCourseIds[0] === id ? [] : [id];
            callbacks.onCourseFilterChange?.(selectedCourseIds.slice());
            renderRail();
        }

        function renderProgress() {
            const progress = periodProgress();
            const style = normalizeProgressStyle(state.settings.todo_progress_style);
            const courses = state.courses.map((course, index) => ({ ...course, color: courseColor(course, index), progress: courseProgress(course.id) }));
            const section = makeElement(documentRef, "section", { className: `apstudy-todo-progress is-${style}`, "aria-labelledby": "apstudy-todo-progress-title" });
            append(section, makeElement(documentRef, "h3", { id: "apstudy-todo-progress-title", className: "apstudy-visually-hidden", textContent: "Task progress" }));
            const filtering = state.settings.todo_course_filtering !== false;
            const empty = progress.total === 0;
            const graphic = empty ? null : renderProgressGraphic(documentRef, style, progress, courses);
            // Every course-mapped style (circle, rainbow, bar, heart, cloud)
            // is a clickable filter; only the unmapped placeholders (none,
            // oiia) stay inert, detected by the absence of course identity.
            const interactiveGraphic = Boolean(graphic)
                && childrenOf(graphic).some((node) => node.getAttribute?.("data-course-id"));
            if (graphic && filtering && interactiveGraphic && courses.length) {
                graphic.setAttribute?.("title", "Click to see tasks");
                childrenOf(graphic).forEach((node) => {
                    if (!node.getAttribute?.("data-course-id")) return;
                    on(node, "click", (event) => {
                        const target = eventCourseTarget(event);
                        const id = target?.getAttribute?.("data-course-id");
                        if (id) toggleCourseFilter(id);
                    });
                });
            }
            if (graphic) append(section, graphic);
            if (graphic && style !== "none") revealGraphic(graphic);
            const summary = makeElement(documentRef, "div", { className: `apstudy-todo-progress-summary${empty ? " is-empty" : ""}`, "aria-label": empty ? "No dated tasks in this timeframe" : `${progress.percentage}% · ${progress.completed}/${progress.total}` });
            append(summary, makeElement(documentRef, "strong", { className: "apstudy-todo-progress-percent", textContent: empty ? "No dated tasks in this timeframe" : `${progress.percentage}%` }));
            append(summary, makeElement(documentRef, "span", { className: "apstudy-todo-progress-fraction", textContent: empty ? "" : `${progress.completed}/${progress.total}` }));
            if (!empty) append(summary, makeElement(documentRef, "span", { className: "apstudy-todo-progress-complete-word", textContent: "complete" }));
            append(section, summary);
            if (empty) {
                append(rootNode, section);
                return;
            }
            const legend = makeElement(documentRef, "div", { className: `apstudy-todo-progress-legend${selectedCourseIds.length ? " has-filter" : ""}`, "aria-label": "Course progress" });
            if (!courses.length) append(legend, makeElement(documentRef, "span", { className: "apstudy-todo-legend-empty", textContent: "No courses in this timeframe" }));
            courses.forEach((course) => {
                const selected = selectedCourseIds.includes(String(course.id));
                const counts = plainObject(course.progress);
                const item = makeElement(documentRef, filtering ? "button" : "span", {
                    ...(filtering ? { type: "button" } : {}),
                    className: `apstudy-todo-course-filter${selected ? " is-selected" : ""}`,
                    "data-course-id": course.id,
                    "aria-label": `${course.label} — ${counts.completed || 0}/${counts.total || 0} tasks complete${filtering ? ". Click to see tasks." : ""}`,
                    title: `${course.label} — ${counts.completed || 0}/${counts.total || 0}`,
                    ...(filtering ? { "aria-pressed": String(selected) } : {})
                });
                item.style?.setProperty?.("--course-color", course.color);
                append(item, makeElement(documentRef, "span", { className: "apstudy-todo-course-dot", "aria-hidden": "true" }));
                append(item, makeElement(documentRef, "span", {
                    className: "apstudy-todo-course-code",
                    "data-full-course-code": courseCode(course.course),
                    textContent: compactCourseCode(course.course)
                }));
                append(item, makeElement(documentRef, "span", { className: "apstudy-visually-hidden", textContent: `, ${course.label}` }));
                if (filtering) {
                    on(item, "click", () => toggleCourseFilter(course.id));
                    on(item, "mouseenter", () => dimRings(String(course.id)));
                    on(item, "mouseleave", () => dimRings(null));
                }
                append(legend, item);
            });
            append(section, legend);
            append(rootNode, section);
        }

        function renderTabs() {
            const tabs = makeElement(documentRef, "div", { className: "apstudy-todo-tabs", role: "tablist", "aria-label": "To-Do views" });
            const unread = unreadCount();
            TAB_ORDER.forEach((tab) => {
                const selected = selectedTab === tab;
                const button = makeElement(documentRef, "button", {
                    type: "button",
                    className: `apstudy-todo-tab is-${tab}`,
                    role: "tab",
                    id: `apstudy-todo-tab-${tab}`,
                    "aria-selected": String(selected),
                    "aria-controls": "apstudy-todo-panel",
                    "data-tip": TAB_LABELS[tab],
                    "aria-label": tab === TABS.announcements && unread > 0 ? `${TAB_LABELS[tab]}, ${unread} unread` : TAB_LABELS[tab]
                });
                append(button, sealIcon(documentRef, TAB_ICONS[tab]));
                if (tab === TABS.announcements && unread > 0) {
                    append(button, makeElement(documentRef, "span", { className: "apstudy-todo-tab-badge", "aria-hidden": "true", textContent: String(unread) }));
                }
                button.tabIndex = selected ? 0 : -1;
                on(button, "click", () => selectTab(tab));
                on(button, "keydown", (event) => {
                    const index = TAB_ORDER.indexOf(tab);
                    let nextIndex = index;
                    if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = (index + 1) % TAB_ORDER.length;
                    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = (index - 1 + TAB_ORDER.length) % TAB_ORDER.length;
                    else if (event.key === "Home") nextIndex = 0;
                    else if (event.key === "End") nextIndex = TAB_ORDER.length - 1;
                    else return;
                    event.preventDefault?.();
                    selectTab(TAB_ORDER[nextIndex], true);
                });
                append(tabs, button);
            });
            append(rootNode, tabs);
        }

        function selectTab(tab, focus = false) {
            if (!TAB_ORDER.includes(tab)) return;
            selectedTab = tab;
            hidePreviewNode();
            setLive(`${TAB_LABELS[tab]} selected.`);
            renderRail();
            if (focus) rootNode?.querySelector?.(`#apstudy-todo-tab-${tab}`)?.focus?.();
        }

        function announcementEntries() {
            return array(state.tasks)
                .filter((task) => task?.type === "announcement")
                .filter((task) => !selectedCourseIds.length || selectedCourseIds.includes(taskCourseKey(task)))
                .map((task) => ({
                    task,
                    classification: { bucket: task?.unread === true ? "unread" : "recent", missing: false, overdue: false, undated: !task?.due }
                }));
        }

        function currentEntries() {
            const groupedState = grouped();
            if (selectedTab === TABS.announcements) return announcementEntries();
            if (selectedTab === TABS.done) return groupedState.completed.concat(groupedState.active.filter((entry) => entry.classification?.bucket === "submitted-ungraded"));
            return groupedState.missing.concat(groupedState.active.filter((entry) => entry.task?.type !== "announcement"));
        }

        function groupKeyForEntry(entry, grouping) {
            const task = entry.task;
            if (selectedTab === TABS.announcements) return task?.unread === true ? "unread" : "recent";
            if (grouping === false) return "all";
            if (task?.completion) return "completed";
            if (entry.classification?.bucket === "missing") return "missing";
            if (domain.state?.isUndatedNest?.(task)) return "undated";
            if (entry.classification?.bucket === "submitted-ungraded") return "submitted-ungraded";
            return domain.state?.dayGroupKey?.(task, { now: state.now, timeZone: state.range?.timeZone || state.timeZone }) || "later";
        }

        function buildGroups(entries, grouping = true) {
            if (!array(entries).length) return [];
            const order = selectedTab === TABS.announcements ? ANNOUNCEMENT_GROUP_ORDER : grouping === false ? ["all"] : GROUP_ORDER;
            const buckets = new Map();
            array(entries).forEach((entry) => {
                const key = groupKeyForEntry(entry, grouping);
                if (!order.includes(key)) return;
                if (!buckets.has(key)) buckets.set(key, []);
                buckets.get(key).push(entry);
            });
            const sortDirection = selectedTab === TABS.announcements ? "desc" : "asc";
            return order.filter((key) => buckets.has(key)).map((key) => ({ key, label: GROUP_LABELS[key] || key, entries: sortEntries(buckets.get(key), sortDirection) }));
        }

        function groupStateKey(groupKey) { return `${selectedTab}:${groupKey}`; }

        function renderEmptyState(label) {
            const row = makeElement(documentRef, "div", { className: "apstudy-todo-empty", role: "status" });
            append(row, makeElement(documentRef, "span", { className: "apstudy-todo-empty-count", "aria-hidden": "true", textContent: "0" }));
            append(row, makeElement(documentRef, "span", { className: "apstudy-todo-empty-label", textContent: label }));
            return row;
        }

        function canvasReadMessage() {
            const status = text(state.canvasState, "live").toLowerCase();
            if (status === "stale") return "Showing the last Canvas tasks we could verify.";
            if (["error", "unavailable"].includes(status)) return "Canvas tasks are unavailable. Reload Canvas, then try again.";
            if (status === "loading") return "Loading Canvas tasks…";
            return "";
        }

        function announcementNotice() {
            const source = plainObject(state.sourceState?.announcements);
            if (source.partial === true && source.truncated === true) return "Some announcements may be missing because Canvas returned a partial, truncated result.";
            if (source.truncated === true) return "Some announcements may be missing because Canvas truncated this result.";
            if (source.partial === true) return "Some announcements may be missing because Canvas returned a partial result.";
            return "";
        }

        let stopLoadingMotion = null;

        // Recent Feedback is a Done-view section, not a task group: nothing
        // here is completable, editable, or fabricated. Entries arrive as
        // sanitized structured records extracted from Canvas's own feedback
        // list, so no native markup or listener ever moves.
        function renderFeedbackSection() {
            if (selectedTab !== TABS.done) return null;
            const entries = array(state.feedback).filter((entry) => entry && text(entry.title));
            if (!entries.length) return null;
            const section = makeElement(documentRef, "section", { className: "apstudy-todo-group is-feedback", "data-group": "feedback", "aria-label": "Recent feedback" });
            const heading = makeElement(documentRef, "h3", { className: "apstudy-todo-group-heading is-static" });
            append(heading, makeElement(documentRef, "span", { className: "apstudy-todo-group-label", textContent: "Recent Feedback" }));
            append(section, heading);
            const list = makeElement(documentRef, "ul", { className: "apstudy-todo-feedback-list" });
            entries.forEach((entry) => {
                const row = makeElement(documentRef, "li", { className: "apstudy-todo-feedback" });
                const url = safeHttpsUrl(entry.url);
                const title = makeElement(documentRef, url ? "a" : "span", {
                    className: "apstudy-todo-feedback-title",
                    ...(url ? { href: url } : {}),
                    ...(url && state.settings.todo_link_target === "new-tab" ? { target: "_blank", rel: "noopener" } : {}),
                    textContent: text(entry.title, "Feedback")
                });
                append(row, title);
                const meta = makeElement(documentRef, "div", { className: "apstudy-todo-feedback-meta" });
                if (text(entry.courseLabel)) append(meta, makeElement(documentRef, "span", { className: "apstudy-todo-feedback-course", textContent: text(entry.courseLabel) }));
                const score = plainObject(entry.score);
                const earned = score.earned === undefined ? null : score.earned;
                const possible = score.possible === undefined ? null : score.possible;
                const scoreText = earned === null && possible === null ? "Reviewed"
                    : earned === null ? `–/${possible} pts`
                    : possible === null ? `${earned} pts`
                    : `${earned}/${possible} pts`;
                append(meta, makeElement(documentRef, "span", { className: "apstudy-todo-feedback-score", textContent: scoreText }));
                append(row, meta);
                if (url) on(row, "click", (event) => { if (eventActionTarget(event)) return; openTaskUrl(url); });
                append(list, row);
            });
            append(section, list);
            return section;
        }

        function renderGroups() {
            const panel = makeElement(documentRef, "section", { className: "apstudy-todo-panel", id: "apstudy-todo-panel", role: "tabpanel", "aria-labelledby": `apstudy-todo-tab-${selectedTab}`, tabIndex: 0 });
            const entries = currentEntries();
            const groups = buildGroups(entries, state.settings.todo_grouping !== false);
            const feedbackSection = renderFeedbackSection();
            const notice = selectedTab === TABS.announcements ? announcementNotice() : "";
            if (state.cacheState === "stale" && state.pending === true) {
                append(panel, makeElement(documentRef, "p", { className: "apstudy-todo-cache-notice", role: "status", textContent: "Updating tasks… Showing recently saved data." }));
            }
            if (notice) append(panel, makeElement(documentRef, "p", { className: "apstudy-todo-announcement-notice", role: "status", textContent: notice }));
            if (feedbackSection) append(panel, feedbackSection);
            if (!groups.length && !feedbackSection && state.canvasState === "loading" && globalThis.APStudyCanvasMotion) {
                stopLoadingMotion = globalThis.APStudyCanvasMotion.showLoading(panel, "Loading Canvas tasks…");
            } else if (!groups.length && !feedbackSection) {
                append(panel, renderEmptyState(canvasReadMessage() || (selectedTab === TABS.done ? "No completed tasks" : selectedTab === TABS.announcements ? "No announcements" : "No tasks")));
            }
            groups.forEach((group, groupIndex) => {
                const stateKey = groupStateKey(group.key);
                const collapsed = collapsedGroups.has(stateKey);
                const section = makeElement(documentRef, "section", { className: `apstudy-todo-group is-${group.key}${collapsed ? " is-collapsed" : ""}`, "data-group": group.key });
                const listId = `apstudy-todo-group-${selectedTab}-${group.key}`;
                const heading = makeElement(documentRef, "button", { type: "button", className: "apstudy-todo-group-heading", "aria-expanded": String(!collapsed), "aria-controls": listId, title: group.label });
                append(heading, makeElement(documentRef, "span", { className: "apstudy-todo-group-label", textContent: group.label }));
                if (collapsed) append(heading, makeElement(documentRef, "span", { className: "apstudy-todo-group-count", textContent: String(group.entries.length) }));
                append(heading, makeElement(documentRef, "span", { className: "apstudy-todo-group-chevron", "aria-hidden": "true" }));
                on(heading, "click", () => { if (collapsedGroups.has(stateKey)) collapsedGroups.delete(stateKey); else collapsedGroups.add(stateKey); renderRail(); });
                append(section, heading);
                if (!collapsed) {
                    const list = makeElement(documentRef, "ol", { className: "apstudy-todo-task-list", id: listId });
                    group.entries.forEach((entry, taskIndex) => append(list, renderTask(entry, {
                        tab: TAB_ORDER.indexOf(selectedTab),
                        group: groupIndex,
                        task: taskIndex
                    })));
                    append(section, list);
                }
                append(panel, section);
            });
            append(rootNode, panel);
        }

        function completionAuthorityCopy(task) {
            if (task?.source === "nest") return "Marked as complete in Nest";
            if (task?.type === "planner_note" && task?.mutationAuthority !== "canvas_planner_note") return "This Canvas planner note is read-only";
            return state.settings.todo_completion_authority === "manual" ? "Marked as complete manually" : "Marked as complete by Canvas";
        }

        function openTaskUrl(url) {
            if (state.settings.todo_link_target === "new-tab") {
                if (typeof windowRef?.open === "function") windowRef.open(url, "_blank", "noopener,noreferrer");
                return;
            }
            if (windowRef?.location) windowRef.location.href = url;
        }

        function renderTask(entry, renderedOccurrence) {
            const task = entry.task;
            const completed = Boolean(task?.completion);
            const submittedUngraded = !completed && task?.submitted === true && task?.graded !== true;
            const title = text(task?.title, "Untitled task");
            const taskId = text(task?.id);
            const taskPreviewId = previewId(renderedOccurrence);
            const row = makeElement(documentRef, "li", {
                className: `apstudy-todo-task is-${entry.classification?.bucket || "later"}${completed ? " is-complete" : ""}`,
                "data-task-id": taskId,
                "data-preview-id": taskPreviewId,
                "data-source": sourceLabel(task),
                "data-status": completed ? "completed" : submittedUngraded ? "submitted-ungraded" : "active"
            });
            const color = courseColorForTask(task);
            row.style?.setProperty?.("--course-color", color);
            append(row, makeElement(documentRef, "span", { className: "apstudy-todo-task-spine", style: { backgroundColor: color }, "aria-hidden": "true" }));
            const body = makeElement(documentRef, "div", { className: "apstudy-todo-task-body" });

            const top = makeElement(documentRef, "div", { className: "apstudy-todo-task-top" });
            append(top, makeElement(documentRef, "span", { className: "apstudy-todo-task-course", style: { color }, textContent: courseCode(task?.course) }));
            const actions = makeElement(documentRef, "div", { className: "apstudy-todo-task-actions", "aria-label": `Actions for ${title}` });
            // Announcement rows toggle Canvas read state, not completion: the
            // circle reflects unread/read, so copy and pressed state follow
            // the read state rather than the completion flag.
            const announcement = task?.type === "announcement";
            const read = announcement && task?.unread !== true;
            const desired = announcement ? !read : !completed;
            const pending = completionPending === task?.id;
            const complete = makeElement(documentRef, "button", {
                type: "button",
                className: "apstudy-todo-task-complete",
                "data-action": "complete-task",
                "aria-label": `${announcement ? (read ? "Mark as unread" : "Mark as read") : desired ? "Mark complete" : "Mark as active"}: ${title}`,
                "aria-pressed": String(announcement ? read : completed),
                title: announcement ? (read ? "Mark as unread" : "Mark as read") : completed ? completionAuthorityCopy(task) : "Mark complete"
            });
            append(complete, statusCircleIcon(documentRef, completed));
            const plannerNoteReadOnly = task?.type === "planner_note" && task?.mutationAuthority !== "canvas_planner_note";
            const plannerDateMutationBlocked = task?.raw?.planner_note_date_mutation_blocked === true;
            setDisabled(complete, pending || plannerNoteReadOnly || plannerDateMutationBlocked);
            if (pending) complete.setAttribute?.("aria-busy", "true");
            on(complete, "click", (event) => { event.stopPropagation?.(); handleCompletion(task, desired); });
            if (plannerTasksEnabled() && task?.mutationAuthority === "canvas_planner_note") {
                const edit = makeElement(documentRef, "button", { type: "button", className: "apstudy-todo-task-details", "data-action": "edit-planner-task", "aria-label": `Edit Canvas task: ${title}`, title: "Edit Canvas task" });
                append(edit, icon(documentRef, "note", 14));
                on(edit, "click", (event) => { event.stopPropagation?.(); openEditTask(task); });
                append(actions, edit);
            }

            // Announcement rows carry no details button: the row itself is
            // the preview toggle, so the note affordance would be redundant.
            if (!announcement) {
                const details = makeElement(documentRef, "button", {
                    type: "button",
                    className: "apstudy-todo-task-details",
                    "data-action": "toggle-preview",
                    "data-details-for": taskId,
                    "aria-expanded": String(previewFor !== null && previewFor === taskPreviewId),
                    "aria-controls": taskPreviewId,
                    "aria-label": `Show details: ${title}`,
                    title: "Show details"
                });
                append(details, icon(documentRef, "note", 14));
                on(details, "click", (event) => { event.stopPropagation?.(); togglePreview(task, row, details); });
                append(actions, details);
            }
            append(actions, complete);
            append(top, actions);
            append(body, top);

            const mid = makeElement(documentRef, "div", { className: "apstudy-todo-task-mid" });
            const link = safeHttpsUrl(task?.url);
            const titleNode = link
                ? makeElement(documentRef, "a", { className: "apstudy-todo-task-title", href: link, "data-action": "open-task", textContent: title })
                : makeElement(documentRef, "span", { className: "apstudy-todo-task-title", textContent: title });
            if (link && state.settings.todo_link_target === "new-tab") {
                titleNode.target = "_blank";
                titleNode.rel = "noopener";
            }
            append(mid, titleNode);
            append(body, mid);

            const urgentDue = ["missing", "overdue"].includes(entry.classification?.bucket) && state.settings.todo_urgency_enabled !== false;
            const meta = makeElement(documentRef, "div", { className: `apstudy-todo-task-meta${urgentDue ? " is-urgent-due" : ""}` });
            const dueValue = formatDue(task?.due, state.settings, task?.timezone || state.range?.timeZone, state.now);
            const due = makeElement(documentRef, "span", { className: "apstudy-todo-task-due" });
            if (announcement) {
                append(due, makeElement(documentRef, "span", { textContent: announcementDueText(dueValue) }));
            } else if (dueValue.startsWith("Due ")) {
                append(due, makeElement(documentRef, "strong", { textContent: "Due" }));
                append(due, makeElement(documentRef, "span", { textContent: ` ${dueValue.slice(4)}` }));
            } else {
                append(due, makeElement(documentRef, "span", { textContent: dueValue }));
            }
            append(meta, due);
            if (submittedUngraded) append(meta, makeElement(documentRef, "span", { className: "apstudy-todo-task-status", textContent: "Submitted · awaiting grade" }));
            const points = pointsText(task?.points, completed);
            if (points) append(meta, makeElement(documentRef, "span", { className: "apstudy-todo-task-points", textContent: points }));
            append(body, meta);

            const error = completionErrors.get(task?.id);
            if (error) {
                const errorId = `apstudy-todo-task-error-${taskId.replace(/[^a-zA-Z0-9_-]/g, "-") || "task"}`;
                const retry = makeElement(documentRef, "button", { type: "button", className: "apstudy-todo-task-retry", "data-action": "retry-completion", textContent: "Retry" });
                on(retry, "click", () => handleCompletion(task, desired));
                const errorRow = makeElement(documentRef, "div", { className: "apstudy-todo-task-error", id: errorId, role: "alert", textContent: `${error} ` });
                complete.setAttribute?.("aria-describedby", errorId);
                append(errorRow, retry);
                append(body, errorRow);
            }
            append(row, body);
            // Announcement rows open/close their preview from anywhere except
            // the title link and the action buttons; only the title link
            // itself navigates to Canvas.
            if (announcement) on(row, "click", (event) => { if (eventActionTarget(event)) return; togglePreview(task, row, row); });
            else if (link) on(row, "click", (event) => { if (eventActionTarget(event)) return; openTaskUrl(link); });
            attachPreviewHandlers(row, task);
            return row;
        }

        function taskDescription(task) {
            const raw = plainObject(task?.raw);
            const plannable = plainObject(raw.plannable);
            const stripPlannerMarker = (value) => String(value || "")
                .split(/\r?\n/)
                .filter((line) => !/^\s*APSTUDYCANVAS_PLANNER_NOTE:/i.test(line))
                .join("\n");
            const details = stripPlannerMarker(firstText(raw.details, plannable.details));
            const plannerPreview = stripPlannerMarker(raw.planner_note_preview);
            // Planner Note details include the durable ownership marker. It
            // authorizes writes but is metadata, never user-facing preview
            // copy. A marker-only note therefore honestly has no preview.
            const plannerNote = task?.type === "planner_note" || String(raw.plannable_type || raw.type || plannable.plannable_type || plannable.type || "").toLowerCase() === "planner_note";
            if (plannerNote) {
                const parts = plannerApi?.splitDetails?.(details);
                // The normal path is the domain parser. Retain a narrow
                // marker-line fallback only for an incomplete legacy script
                // pipeline, so an unavailable parser can never disclose the
                // ownership convention to a user.
                const description = String(plannerPreview || (typeof parts?.description === "string" ? parts.description : details))
                    // Treat the marker as a private metadata line even when
                    // Canvas handed us a malformed or conflicting note row
                    // that the domain parser intentionally refuses to own.
                    .split(/\r?\n/)
                    .filter((line) => !/^\s*APSTUDYCANVAS_PLANNER_NOTE:/i.test(line))
                    .join("\n");
                return htmlToText(description);
            }
            return htmlToText(stripPlannerMarker(firstText(raw.description, plannable.description, raw.message, plannable.message, details, task?.description)));
        }

        const PREVIEW_ID_MAX_LENGTH = 128;

        function previewId(coordinates = {}) {
            // Render coordinates are already unique within the rail. Unlike source
            // identifiers, they are fixed-width-bounded numeric DOM data and never
            // disclose Canvas or Nest record identifiers. Array indexes are capped
            // below 2^32 in the DOM renderer; the fixed tab/group ranges make
            // every live rail id at most 39 characters (and never over 128).
            const tab = Number(coordinates.tab) >>> 0;
            const group = Number(coordinates.group) >>> 0;
            const task = Number(coordinates.task) >>> 0;
            const id = `apstudy-todo-preview-t${tab}-g${group}-i${task}`;
            if (id.length > PREVIEW_ID_MAX_LENGTH) throw new RangeError("Preview id exceeds its DOM length bound.");
            return id;
        }

        function previewEnabled() { return state.settings.todo_hover_preview !== false; }

        function clearPreviewTimers() {
            if (previewTimer) { clearTimeout(previewTimer); previewTimer = null; }
        }

        function syncDetailsExpanded() {
            rootNode?.querySelectorAll?.(".apstudy-todo-task-details")?.forEach?.((node) => {
                node.setAttribute?.("aria-expanded", String(node.getAttribute?.("aria-controls") === previewFor));
            });
        }

        function hidePreviewNode({ returnFocus = false } = {}) {
            clearPreviewTimers();
            rootNode?.querySelector?.(".apstudy-todo-preview")?.remove?.();
            previewFor = null;
            previewRequestSequence += 1;
            syncDetailsExpanded();
            if (returnFocus) previewTrigger?.focus?.();
            previewTrigger = null;
        }

        function buildPreview(task, taskPreviewId) {
            const title = text(task?.title, "Untitled task");
            const card = makeElement(documentRef, "div", { id: taskPreviewId, className: "apstudy-todo-preview", role: "region", "aria-label": `Preview: ${title}` });
            append(card, makeElement(documentRef, "h4", { className: "apstudy-todo-preview-title", textContent: title }));
            if (task?.completion) {
                append(card, makeElement(documentRef, "p", { className: "apstudy-todo-preview-eyebrow", textContent: "Recent feedback" }));
                let mentioned = false;
                const points = task?.points;
                if (points && (points.earned !== null || points.possible !== null)) {
                    append(card, makeElement(documentRef, "p", { className: "apstudy-todo-preview-line", textContent: `Scored ${points.earned === null ? "-" : points.earned} out of ${points.possible === null ? "-" : points.possible} points.` }));
                    mentioned = true;
                }
                array(state.feedback)
                    .filter((item) => String(item?.course?.id ?? "") === String(task?.course?.id ?? ""))
                    .slice(0, 3)
                    .forEach((item) => {
                        const score = item?.score || item?.points;
                        append(card, makeElement(documentRef, "p", { className: "apstudy-todo-preview-line", textContent: `${text(item?.title, "Feedback")} — ${score ? `${score.earned ?? "-"} out of ${score.possible ?? "-"}` : "Reviewed"}` }));
                        mentioned = true;
                    });
                if (!mentioned) append(card, makeElement(documentRef, "p", { className: "apstudy-todo-preview-empty", textContent: "No feedback comments yet" }));
                return card;
            }
            const description = taskDescription(task);
            if (description) {
                append(card, makeElement(documentRef, "p", { className: "apstudy-todo-preview-eyebrow", textContent: "Instructions" }));
                append(card, makeElement(documentRef, "p", { className: "apstudy-todo-preview-body", textContent: description }));
            } else {
                append(card, makeElement(documentRef, "p", { className: "apstudy-todo-preview-empty", textContent: "No preview available for this item" }));
            }
            return card;
        }

        function showPreview(task, anchorRow, trigger = null) {
            clearPreviewTimers();
            rootNode?.querySelector?.(".apstudy-todo-preview")?.remove?.();
            if (!previewEnabled() || !task) { previewFor = null; syncDetailsExpanded(); return; }
            const taskPreviewId = text(anchorRow?.getAttribute?.("data-preview-id"));
            previewFor = taskPreviewId;
            previewTrigger = trigger || previewTrigger;
            const card = buildPreview(task, taskPreviewId);
            append(anchorRow, card);
            syncDetailsExpanded();
            hydratePreview(task, card, taskPreviewId);
        }

        // Planner rows omit item bodies for most plannables, so a description
        // is fetched on demand the first time a preview opens and cached for
        // the session. Filling happens only while this exact preview card is
        // still the live one; stale responses are dropped.
        function hydratePreview(task, card, taskPreviewId) {
            if (taskDescription(task)) return;
            // The Planner feed's nested Note is the canonical source of its
            // details. There is no safe generic item-body endpoint for Notes;
            // a marker-only owned note is intentionally previewless rather
            // than issuing an unrelated fetch or implying hidden content.
            if (task?.type === "planner_note") return;
            const describe = callbacks.describeTask;
            if (typeof describe !== "function") return;
            const cacheKey = text(task?.id) || taskPreviewId;
            if (previewBodies.has(cacheKey)) { fillPreviewBody(card, previewBodies.get(cacheKey)); return; }
            const empty = card.querySelector?.(".apstudy-todo-preview-empty");
            if (empty) empty.textContent = "Loading preview…";
            const requestId = ++previewRequestSequence;
            Promise.resolve()
                .then(() => describe(task))
                .then((body) => {
                    const value = typeof body === "string" ? htmlToText(body) : "";
                    previewBodies.set(cacheKey, value);
                    return value;
                })
                .catch(() => "")
                .then((value) => {
                    if (requestId !== previewRequestSequence || previewFor !== taskPreviewId) return;
                    if (rootNode?.querySelector?.(".apstudy-todo-preview") !== card) return;
                    fillPreviewBody(card, value);
                });
        }

        function fillPreviewBody(card, value) {
            const empty = card?.querySelector?.(".apstudy-todo-preview-empty");
            if (!empty) return;
            if (value) {
                empty.className = "apstudy-todo-preview-body";
                empty.textContent = value;
                return;
            }
            empty.textContent = "No preview available for this item";
        }

        function togglePreview(task, row, trigger) {
            if (previewFor !== null && previewFor === row?.getAttribute?.("data-preview-id")) hidePreviewNode();
            else showPreview(task, row, trigger);
        }

        // Hover and focus open the preview after a dwell delay. Leaving the
        // row only cancels a pending open — an open preview is sticky and
        // closes exclusively through its toggle click, Escape, or by opening
        // another row's preview.
        function attachPreviewHandlers(row, task) {
            const openSoon = () => {
                if (previewTimer) clearTimeout(previewTimer);
                previewTimer = setTimeout(() => { previewTimer = null; showPreview(task, row); }, previewDelays.open);
            };
            const cancelPendingOpen = () => {
                if (previewTimer) { clearTimeout(previewTimer); previewTimer = null; }
            };
            on(row, "mouseenter", openSoon);
            on(row, "mouseleave", cancelPendingOpen);
            on(row, "focusin", openSoon);
            on(row, "focusout", cancelPendingOpen);
        }

        function reattachPreview() {
            if (previewFor === null || !previewEnabled()) { previewFor = null; return; }
            const row = Array.from(rootNode?.querySelectorAll?.(".apstudy-todo-task") || [])
                .find((node) => node.getAttribute?.("data-preview-id") === previewFor);
            const groups = buildGroups(currentEntries(), state.settings.todo_grouping !== false);
            let task = null;
            groups.some((group, groupIndex) => group.entries.some((entry, taskIndex) => {
                if (previewId({ tab: TAB_ORDER.indexOf(selectedTab), group: groupIndex, task: taskIndex }) !== previewFor) return false;
                task = entry.task;
                return true;
            }));
            if (!row || !task) { previewFor = null; return; }
            showPreview(task, row);
        }

        function renderAddTask() {
            const button = makeElement(documentRef, "button", { type: "button", className: "apstudy-todo-add", "data-action": "open-add-task", textContent: "+ Add Task" });
            on(button, "click", openAddTask);
            append(rootNode, button);
        }

        function closeStreak(returnFocus = false) {
            streakOpen = false;
            streakPopup?.hidePopover?.();
            streakPopup?.remove?.();
            streakPopup = null;
            streakTrigger?.setAttribute?.("aria-expanded", "false");
            if (returnFocus) streakTrigger?.focus?.();
        }

        function streakDocumentClick(event) {
            if (streakOpen && !streakPopup?.contains?.(event.target) && !streakTrigger?.contains?.(event.target)) closeStreak();
        }
        function streakDocumentKey(event) {
            if (event.key === "Escape" && streakOpen) { event.preventDefault?.(); event.stopPropagation?.(); closeStreak(true); }
        }
        function positionStreak() {
            if (!streakPopup || !streakTrigger?.getBoundingClientRect) return;
            const rect = streakTrigger.getBoundingClientRect();
            const width = Math.min(320, (windowRef.innerWidth || 360) - 24);
            const height = Math.min(streakPopup.getBoundingClientRect?.().height || 360, (windowRef.innerHeight || 700) - 24);
            streakPopup.style.setProperty("width", `${width}px`);
            streakPopup.style.setProperty("left", `${Math.max(12, Math.min(rect.left, (windowRef.innerWidth || 360) - width - 12))}px`);
            streakPopup.style.setProperty("top", `${Math.max(12, Math.min(rect.bottom + 6, (windowRef.innerHeight || 700) - height - 12))}px`);
        }
        function visibleStreakWeek(streak) {
            const supplied = array(streak.week).filter(day => timeApi?.dateKeyValid?.(day?.date)).slice(-7);
            if (supplied.length === 7) return supplied;
            const zone = state.range?.timeZone || state.timeZone || timeApi?.browserTimeZone?.() || "UTC";
            const today = timeApi?.localDateKey?.(state.now, zone);
            if (!today) return supplied;
            return Array.from({ length: 7 }, (_, index) => ({
                date: timeApi.shiftDateKey(today, index - 6),
                outcome: "unknown",
                today: index === 6
            }));
        }
        function streakDateLabel(date) {
            const parsed = new Date(`${date}T12:00:00Z`);
            return Number.isNaN(parsed.getTime()) ? date : parsed.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
        }
        function streakWeekday(date) {
            const parsed = new Date(`${date}T12:00:00Z`);
            return Number.isNaN(parsed.getTime()) ? "·" : ["S", "M", "T", "W", "T", "F", "S"][parsed.getUTCDay()];
        }
        function renderStreakWeek(streak) {
            const week = makeElement(documentRef, "div", { className: "apstudy-streak-week", role: "list", "aria-label": "Last seven streak days" });
            visibleStreakWeek(streak).forEach(day => {
                const outcome = ["complete", "missed", "pending"].includes(day.outcome) ? day.outcome : "unknown";
                const status = outcome === "complete" ? "streak kept" : outcome === "missed" ? "due task missed" : outcome === "pending" ? "in progress" : "not tracked";
                const item = makeElement(documentRef, "span", { className: `apstudy-streak-day is-${outcome}${day.today ? " is-today" : ""}`, role: "listitem", "aria-label": `${day.today ? "Today, " : ""}${streakDateLabel(day.date)}: ${status}` });
                append(item, makeElement(documentRef, "span", { className: "apstudy-streak-day-label", "aria-hidden": "true", textContent: streakWeekday(day.date) }));
                const dot = makeElement(documentRef, "span", { className: "apstudy-streak-day-dot", "aria-hidden": "true" });
                if (outcome === "complete") append(dot, icon(documentRef, "check", 12));
                append(item, dot);
                append(week, item);
            });
            return week;
        }
        function celebrateStreakMilestone(section, streak, days) {
            const reliable = !["loading", "unavailable", "stale", "tracking"].includes(streak.state);
            const milestone = reliable && isStreakMilestone(days);
            if (milestone) {
                section.className += " is-milestone";
                section.setAttribute?.("data-streak-milestone", String(days));
            }
            if (milestone && streak.state === "verified" && lastReliableStreakDays !== days && !celebratedStreakMilestones.has(days)) {
                celebratedStreakMilestones.add(days);
                effects?.celebrate?.({
                    container: section,
                    type: "confetti",
                    intensity: "normal",
                    reducedMotion: state.settings.todo_reduced_motion_safe === true
                        ? effects?.prefersReducedMotion?.(windowRef)
                        : false,
                    onStaticSuccess: () => {}
                });
            }
            if (reliable) lastReliableStreakDays = days;
        }
        function renderStreak() {
            if (state.settings.todo_streak_enabled === false) { closeStreak(); return; }
            const streak = plainObject(state.streak);
            const section = makeElement(documentRef, "section", { className: "apstudy-todo-streak", "data-streak-source": "canvas", "aria-label": "Due-task streak" });
            const days = Math.max(0, Number(streak.current) || 0);
            const loading = streak.state === "loading";
            const card = makeElement(documentRef, "button", { type: "button", className: "apstudy-todo-streak-summary", "aria-haspopup": "dialog", "aria-expanded": String(streakOpen), "aria-controls": "apstudy-streak-details", "aria-label": loading ? "Streak is being verified" : `${days} day streak. View streak details.` });
            streakTrigger = card;
            const heading = makeElement(documentRef, "span", { className: "apstudy-streak-heading" });
            const mark = makeElement(documentRef, "span", { className: "apstudy-todo-streak-mark", "aria-hidden": "true" });
            append(mark, streakEggIcon(documentRef, 32));
            append(heading, mark);
            const copyGroup = makeElement(documentRef, "span", { className: "apstudy-streak-copy" });
            append(copyGroup, makeElement(documentRef, "strong", { textContent: loading ? "…" : streak.state === "unavailable" ? "Unavailable" : `${days} day streak` }));
            const copy = loading ? "Verifying your recent Canvas work."
                : streak.state === "unavailable" ? "Canvas could not verify this yet."
                : streak.state === "stale" ? "Canvas verification unavailable. Last verified Canvas observation."
                : streak.state === "tracking" ? "Tracking starts after your first due date settles."
                : streak.state === "pending" ? "Complete today’s tasks to extend your streak."
                : "";
            if (copy) append(copyGroup, makeElement(documentRef, "span", { textContent: copy }));
            append(heading, copyGroup);
            append(heading, icon(documentRef, "chevronRight", 16));
            append(card, heading);
            on(card, "click", event => {
                event.stopPropagation?.();
                if (streakOpen) { closeStreak(true); return; }
                streakOpen = true;
                renderRail();
                streakPopup?.querySelector?.("button")?.focus?.();
                callbacks.onStreakOpen?.();
            });
            append(section, card);
            append(rootNode, section);
            celebrateStreakMilestone(section, streak, days);
            if (!streakOpen) return;
            const popup = makeElement(documentRef, "div", { id: "apstudy-streak-details", className: "apstudy-streak-popup", role: "dialog", "aria-labelledby": "apstudy-streak-details-title", popover: "manual" });
            streakPopup = popup;
            const header = makeElement(documentRef, "div", { className: "apstudy-streak-popup-header" });
            append(header, makeElement(documentRef, "h2", { id: "apstudy-streak-details-title", textContent: "Your streak" }));
            const close = makeElement(documentRef, "button", { type: "button", "aria-label": "Close streak details", "data-streak-focus": "close" });
            append(close, icon(documentRef, "close", 18));
            on(close, "click", () => closeStreak(true));
            append(header, close); append(popup, header);
            const unverified = streak.state === "unavailable" || loading;
            const lead = makeElement(documentRef, "div", { className: "apstudy-streak-popup-lead" });
            const leadEgg = makeElement(documentRef, "span", { className: "apstudy-streak-popup-egg", "aria-hidden": "true" });
            append(leadEgg, streakEggIcon(documentRef, 48));
            const leadCopy = makeElement(documentRef, "p");
            append(leadCopy, makeElement(documentRef, "strong", { textContent: unverified ? "Streak check in progress" : `${days} ${days === 1 ? "day" : "days"}` }));
            append(leadCopy, makeElement(documentRef, "span", { textContent: "without missing a due task" }));
            append(lead, leadEgg);
            append(lead, leadCopy);
            append(popup, lead);
            append(popup, renderStreakWeek(streak));
            const stats = makeElement(documentRef, "dl", { className: "apstudy-streak-stats" });
            for (const [label, value] of [["Current streak", days], ["Personal best", Math.max(0, Number(streak.best) || 0)]]) {
                const stat = makeElement(documentRef, "div");
                append(stat, makeElement(documentRef, "dt", { textContent: label }));
                append(stat, makeElement(documentRef, "dd", { className: "apstudy-streak-total", textContent: unverified ? "—" : `${value} ${value === 1 ? "day" : "days"}` }));
                append(stats, stat);
            }
            append(popup, stats);
            const statusCopy = loading ? "Checking your Canvas tasks…"
                : streak.state === "unavailable" ? "We couldn’t check your streak. Try again to read your Canvas tasks."
                : streak.state === "stale" ? "Showing your last checked streak. Try again to update it."
                : streak.state === "pending" ? "Finish today’s tasks to keep your streak going."
                : "You’re all caught up for today.";
            append(popup, makeElement(documentRef, "p", { className: "apstudy-streak-status", role: "status", textContent: statusCopy }));
            if (!["loading", "unavailable", "stale"].includes(streak.state)) {
                const today = makeElement(documentRef, "section", { className: "apstudy-streak-today", "aria-label": "Today’s streak progress" });
                append(today, makeElement(documentRef, "h3", { textContent: `Today · ${streak.completedToday || 0} of ${streak.totalToday || 0} complete` }));
                if (!streak.totalToday) append(today, makeElement(documentRef, "p", { textContent: "No tasks due today. Assignment-free days count too." }));
                if (streak.totalToday) append(today, makeElement(documentRef, "progress", { max: streak.totalToday, value: streak.completedToday || 0, "aria-label": "Tasks completed today" }));
                const list = makeElement(documentRef, "ul");
                for (const task of streak.remainingTasks || []) {
                    const row = makeElement(documentRef, "li");
                    const href = safeHttpsUrl(task.url);
                    append(row, makeElement(documentRef, href ? "a" : "span", { ...(href ? { href, "data-streak-focus": String(task.id) } : {}), textContent: task.title || "Canvas task" }));
                    append(list, row);
                }
                if (streak.remainingTasks?.length) append(today, list);
                append(popup, today);
            }
            append(popup, makeElement(documentRef, "p", { className: "apstudy-streak-tip", textContent: "Finished work outside Canvas? Check it off in your To-Do List so it counts toward your streak." }));
            const details = makeElement(documentRef, "details", { className: "apstudy-streak-details", ...(streakDetailsOpen ? { open: "" } : {}) });
            append(details, makeElement(documentRef, "summary", { textContent: "How your streak is tracked", "data-streak-focus": "details" }));
            append(details, makeElement(documentRef, "p", { textContent: "Every calendar day counts. Complete all due tasks to extend your streak. An unfinished task on a past date breaks it; support can correct recorded missed dates." }));
            if (streak.since) append(details, makeElement(documentRef, "p", { textContent: `Current run started ${streak.since}.` }));
            if (streak.lastMissed) append(details, makeElement(documentRef, "p", { textContent: `Last missed date: ${streak.lastMissed}.` }));
            if (streak.forgiven?.length) append(details, makeElement(documentRef, "p", { textContent: `Restored by support: ${streak.forgiven.join(", ")}.` }));
            append(details, makeElement(documentRef, "p", { textContent: streak.syncState === "pending" ? "Nest sync pending. This result is provisional." : streak.syncState === "synced" ? "Synced with Nest." : "Streak history stays on this browser." }));
            on(details, "toggle", () => { streakDetailsOpen = details.open; positionStreak(); });
            append(popup, details);
            const footer = makeElement(documentRef, "div", { className: "apstudy-streak-footer" });
            append(footer, makeElement(documentRef, "span", { className: "apstudy-streak-verification", textContent: streak.lastVerified ? `Checked ${new Date(streak.lastVerified).toLocaleString()}` : loading ? "Reading Canvas…" : "No successful check yet" }));
            const retry = makeElement(documentRef, "button", { type: "button", className: "apstudy-streak-retry", "data-streak-focus": "retry", ...(loading ? { disabled: "" } : {}), textContent: loading ? "Checking…" : ["unavailable", "stale"].includes(streak.state) ? "Try again" : "Refresh" });
            on(retry, "click", async () => {
                const label = retry.textContent;
                retry.disabled = true; retry.textContent = "Checking…";
                try { await (callbacks.onStreakRefresh || callbacks.onStreakOpen)?.(); }
                catch (error) { retry.textContent = "Try again"; }
                finally { retry.disabled = false; if (retry.textContent === "Checking…") retry.textContent = label; }
            });
            append(footer, retry); append(popup, footer);
            append(section, popup);
            popup.showPopover?.();
            positionStreak();
        }

        function focusable(node) {
            const selectors = "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])";
            const found = Array.from(node?.querySelectorAll?.(selectors) || []);
            return found.filter((item) => !item.disabled && item.getAttribute?.("aria-hidden") !== "true");
        }

        function modalKeydown(event) {
            if (!modalOpen) return;
            if (event.key === "Escape") {
                event.preventDefault?.();
                if (modalConfirmDiscard) {
                    modalConfirmDiscard = false;
                    renderModal();
                    modalFields.title?.focus?.();
                    return;
                }
                closeAddTask();
                return;
            }
            if (event.key !== "Tab") return;
            const items = focusable(modalNode);
            if (!items.length) return;
            const current = documentRef.activeElement;
            const index = items.indexOf(current);
            const nextIndex = event.shiftKey ? (index <= 0 ? items.length - 1 : index - 1) : (index === items.length - 1 ? 0 : index + 1);
            event.preventDefault?.();
            items[nextIndex].focus?.();
        }

        function defaultDraft({ operationId = false } = {}) {
            const timeZone = state.range?.timeZone || timeApi?.browserTimeZone?.() || "UTC";
            const today = timeApi?.localDateKey?.(state.now || Date.now(), timeZone);
            return {
                title: "",
                description: "",
                dueDate: today ? (timeApi.shiftDateKey ? timeApi.shiftDateKey(today, 1) : today) : "",
                dueTime: "23:59",
                timezone: timeZone,
                priority: "",
                link: "",
                courseId: "",
                type: "task",
                customType: "",
                earned: "",
                possible: "",
                repeat: "never",
                stableId: operationId && plannerTasksEnabled() ? text(callbacks.plannerTaskOperationId?.()) : ""
            };
        }

        function isDraftDirty() {
            const current = { ...plainObject(modalDraft), stableId: "" };
            return JSON.stringify(current) !== JSON.stringify(defaultDraft());
        }

        function updateDraft(key, value) { modalDraft = { ...modalDraft, [key]: value }; }

        function repeatCount(draft = modalDraft) {
            const value = String(draft?.repeat ?? "never");
            if (value === "never") return 0;
            const parsed = Number(value);
            return Number.isInteger(parsed) && parsed >= 1 && parsed <= REPEAT_LIMIT ? parsed : 0;
        }

        // Repeat N weeks means the original occurrence plus N weekly repeats
        // (the original date through N weeks later). Date keys shift with the
        // local calendar, so 11:59pm stays 11:59pm across DST transitions and
        // no occurrence can land on a nonexistent wall-clock instant.
        function occurrenceDates(draft = modalDraft) {
            return repeatOccurrenceDates(draft?.dueDate, repeatCount(draft), timeApi?.shiftDateKey);
        }

        function formatShortDate(dateKey) {
            try {
                return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${dateKey}T12:00:00Z`));
            } catch (error) { return dateKey; }
        }

        function repeatSummary(draft = modalDraft) {
            if (repeatCount(draft) === 0) return "";
            const dates = occurrenceDates(draft);
            if (!dates.length) return "";
            const total = dates.length;
            const last = dates[dates.length - 1];
            if (total === 1) return `Creates 1 task on ${formatShortDate(dates[0])}.`;
            return `Creates ${total} tasks, every week, ending ${formatShortDate(last)}.`;
        }

        function fieldError(id, message) {
            return makeElement(documentRef, "span", { className: "apstudy-todo-field-error", id: `apstudy-todo-error-${id}`, role: "alert", textContent: message });
        }

        // Stacked label-over-control field. Pairs of these compose the
        // two-column desktop grid; each column collapses to one column on
        // narrow viewports, so a label never fights a control for width.
        function stackedField(parent, key, labelText, iconName, control) {
            const wrapper = makeElement(documentRef, "div", { className: "apstudy-todo-form-row is-stacked", "data-field": key });
            const id = control.getAttribute?.("id");
            const label = makeElement(documentRef, "label", { htmlFor: id, className: "apstudy-todo-form-row-label" });
            if (iconName) append(label, icon(documentRef, iconName, 16));
            append(label, makeElement(documentRef, "span", { textContent: labelText }));
            append(wrapper, label);
            append(wrapper, control);
            if (modalErrors[key]) {
                control.setAttribute?.("aria-invalid", "true");
                control.setAttribute?.("aria-describedby", `apstudy-todo-error-${key}`);
                append(wrapper, fieldError(key, modalErrors[key]));
            }
            append(parent, wrapper);
            modalFields[key] = control;
            return control;
        }

        function selectControl(key, optionsList) {
            const select = makeElement(documentRef, "select", { id: `apstudy-todo-field-${key}`, name: key });
            optionsList.forEach((optionData) => {
                const option = typeof optionData === "string" ? { value: optionData, label: optionData } : optionData;
                const node = makeElement(documentRef, "option", { value: option.value, textContent: option.label });
                node.selected = String(option.value) === String(modalDraft[key] || "");
                append(select, node);
            });
            return select;
        }

        function primaryActionLabel() {
            if (modalBusy) return modalTask ? "Saving…" : "Adding…";
            if (!modalTask && modalStatus === "uncertain") return "Check saved tasks";
            if (!modalTask && ["error", "unavailable", "connect"].includes(modalStatus)) return "Try again";
            return modalTask ? "Save changes" : "+ Add Task";
        }

        function validateDraft() {
            const errors = {};
            const draft = plainObject(modalDraft);
            if (!text(draft.title)) errors.title = "Add a title before creating the task.";
            if (text(draft.title).length > 255) errors.title = "Titles must be 255 characters or fewer.";
            if (text(draft.description).length > 2000) errors.description = "Descriptions must be 2,000 characters or fewer.";
            if (draft.link && !safeHttpsUrl(draft.link)) errors.link = "Use a complete HTTPS link without credentials or fragments.";
            if (text(draft.link).length > 2048) errors.link = "Links must be 2,048 characters or fewer.";
            if (draft.type && !TYPE_OPTIONS.includes(String(draft.type))) errors.type = "Choose a supported task type.";
            if (String(draft.type) === "custom" && !text(draft.customType)) errors.customType = "Name the custom task type.";
            if (text(draft.customType).length > CUSTOM_TYPE_MAX) errors.customType = `Custom types must be ${CUSTOM_TYPE_MAX} characters or fewer.`;
            const repeat = String(draft.repeat ?? "never");
            if (repeat !== "never" && repeatCount(draft) === 0) errors.repeat = "Choose a repeat between Never and 10 weeks.";
            if (repeatCount(draft) > 0 && !timeApi?.dateKeyValid?.(draft.dueDate)) errors.dueDate = "Choose a valid due date before repeating this task.";
            if (draft.dueTime && !draft.dueDate) errors.dueTime = "Choose a due date before adding a time.";
            if (draft.dueTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(draft.dueTime))) errors.dueTime = "Choose a valid time.";
            if (draft.dueDate && !timeApi?.dateKeyValid?.(draft.dueDate)) errors.dueDate = "Choose a valid due date.";
            if (plannerTasksEnabled() && !draft.dueDate) errors.dueDate = "Canvas planner tasks need a due date.";
            if (draft.timezone && !timeApi?.validTimeZone?.(draft.timezone)) errors.timezone = "Choose a valid timezone, such as America/New_York.";
            if (draft.priority && !PRIORITY_OPTIONS.includes(String(draft.priority))) errors.priority = "Choose a supported priority.";
            const possible = draft.possible === "" || draft.possible === null || draft.possible === undefined ? null : Number(draft.possible);
            const earned = draft.earned === "" || draft.earned === null || draft.earned === undefined ? null : Number(draft.earned);
            if (possible !== null && (!Number.isFinite(possible) || possible < 0)) errors.possible = "Possible points must be a non-negative number.";
            if (earned !== null && (!Number.isFinite(earned) || earned < 0)) errors.earned = "Earned points must be a non-negative number.";
            if (earned !== null && possible !== null && earned > possible) errors.earned = "Earned points cannot exceed possible points.";
            return errors;
        }

        function buildNestCreatePayload(draft, idempotencyKey) {
            return nestCreatePayload(draft, idempotencyKey);
        }

        function stableHash(value) {
            let hash = 0;
            for (let index = 0; index < value.length; index += 1) hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
            return Math.abs(hash).toString(36);
        }

        function nestTransport() { return callbacks.createNestTask || callbacks.nestCreate || callbacks.todoApi?.createNestTask || domain.api?.createNestTask || null; }

        function plannerTasksEnabled() { return callbacks.plannerTasksEnabled?.() === true; }

        function plannerTransport() { return callbacks.createPlannerTask || null; }
        function plannerUpdateTransport() { return callbacks.updatePlannerTask || null; }
        function plannerDeleteTransport() { return callbacks.deletePlannerTask || null; }
        function plannerDraft(task) { return typeof callbacks.plannerTaskDraft === "function" ? plainObject(callbacks.plannerTaskDraft(task)) : {}; }

        function plannerCourses() {
            // The coordinator supplies only its displayed (therefore visible)
            // Canvas course projection. Do not fall back to task-derived
            // courses: that could reintroduce a hidden course into this writer.
            return array(typeof callbacks.plannerCourses === "function" ? callbacks.plannerCourses() : [])
                .map((course) => plainObject(course))
                .filter((course) => /^[1-9]\d{0,19}$/.test(text(course.id)) && course.hidden !== true && course.visible !== false);
        }

        function plannerOccurrenceStableId(base, dateKey) {
            const candidate = text(base);
            const valid = /^[a-z0-9][a-z0-9_-]{7,63}$/.test(candidate) ? candidate : text(plannerApi?.makeStableId?.());
            if (!valid) return "";
            const suffix = dateKey ? `-${dateKey.replace(/-/g, "")}` : "";
            return `${valid}${suffix}`.slice(0, 64);
        }

        function canvasOccurrencePayload(draft, dateKey) {
            return {
                title: draft.title,
                description: draft.description,
                link: draft.link,
                courseId: draft.courseId,
                todoDate: dateKey,
                stableId: plannerOccurrenceStableId(draft.stableId, dateKey),
                type: draft.type,
                customType: draft.customType,
                priority: draft.priority,
                points: draftPoints(draft) || null
            };
        }

        function occurrenceSignature(draft = modalDraft) {
            return JSON.stringify({
                title: text(draft?.title),
                dueDate: text(draft?.dueDate),
                dueTime: text(draft?.dueTime),
                repeat: String(draft?.repeat ?? "never"),
                courseId: text(draft?.courseId),
                type: text(draft?.type),
                customType: text(draft?.customType),
                priority: text(draft?.priority),
                earned: text(draft?.earned),
                possible: text(draft?.possible)
            });
        }

        function resetCreateProgress() {
            modalCreateProgress = { signature: "", created: new Map(), failedDate: null, uncertain: false };
        }

        function failureOutcome(result, canvasPlanner) {
            const signedOut = ["NEST_SIGNED_OUT", "NEST_UNAUTHENTICATED", "UNAUTHENTICATED"].includes(String(result?.error?.code || ""));
            const diagnosticCode = /^[A-Z0-9-]{4,32}$/.test(String(result?.error?.diagnostic || "")) ? result.error.diagnostic : "";
            const diagnosticPhase = ["pre-dispatch", "main-world", "transport"].includes(String(result?.error?.phase || "")) ? result.error.phase : "";
            const diagnostic = diagnosticCode ? ` Diagnostic code: ${diagnosticCode}${diagnosticPhase ? ` (${diagnosticPhase})` : ""}.` : "";
            const baseMessage = signedOut
                ? "Nest is signed out. Connect Nest in Calendar & Accounts, then retry."
                : text(result?.error?.message) || (canvasPlanner ? "Canvas could not create the task." : "Nest could not create the task.");
            return {
                signedOut,
                message: `${baseMessage}${diagnostic}`,
                status: signedOut ? "connect" : result?.state === "outcome-uncertain" ? "uncertain" : result?.state === "unavailable" ? "unavailable" : "error"
            };
        }

        async function submitAddTask() {
            if (modalBusy) return { ok: false, state: "busy" };
            if (modalTask && modalDateMutationBlocked) {
                const result = { ok: false, state: "unavailable", error: { code: "PLANNER_TIMEZONE_UNAVAILABLE", message: "Canvas account timezone is unavailable. Reload Canvas before editing or completing this task." } };
                modalMessage = `${result.error.message} Your task is unchanged.`;
                modalStatus = "unavailable";
                renderModal();
                return result;
            }
            modalErrors = validateDraft();
            if (Object.keys(modalErrors).length) {
                modalMessage = modalTask ? "Fix the highlighted fields before saving changes." : "Fix the highlighted fields before creating the task.";
                modalStatus = "validation";
                renderModal();
                focusFirstModalError();
                return { ok: false, state: "validation" };
            }
            const canvasPlanner = plannerTasksEnabled();
            const editing = Boolean(modalTask);
            if (canvasPlanner && !editing && !text(modalDraft.stableId)) updateDraft("stableId", text(callbacks.plannerTaskOperationId?.()));
            const create = editing ? plannerUpdateTransport() : canvasPlanner ? plannerTransport() : nestTransport();
            if (typeof create !== "function") {
                modalMessage = canvasPlanner
                    ? "Canvas planner tasks are unavailable. Reload Canvas, then retry. Your draft is preserved."
                    : "Nest is unavailable. Connect Nest in Calendar & Accounts, then retry. Your draft is preserved.";
                modalStatus = canvasPlanner ? "unavailable" : "connect";
                renderModal();
                return { ok: false, state: "unavailable", error: { code: "NEST_TRANSPORT_UNAVAILABLE" } };
            }

            if (editing) {
                modalBusy = true;
                modalMessage = "Saving in Canvas…";
                modalStatus = "saving";
                renderModal();
                const idempotencyKey = `todo-update:${stableHash(JSON.stringify(modalDraft))}`;
                const requestId = `todo-update-request:${++requestSequence}`;
                let result;
                try {
                    const payload = plannerTasksEnabled()
                        ? canvasOccurrencePayload(modalDraft, text(modalDraft.dueDate))
                        : buildNestCreatePayload(modalDraft, idempotencyKey);
                    result = await create(modalTask, payload, { requestId, idempotencyKey });
                } catch (error) {
                    result = { ok: false, state: "error", error: { code: error?.code || (canvasPlanner ? "CANVAS_PLANNER_NOTE_UPDATE_FAILED" : "NEST_TODO_CREATE_FAILED"), message: error?.message || (canvasPlanner ? "Canvas could not save the task." : "Nest could not save the task.") } };
                }
                modalBusy = false;
                if (!result || result.ok !== true) {
                    const outcome = failureOutcome(result, canvasPlanner);
                    modalMessage = `${outcome.message} Your changes are preserved.`;
                    modalStatus = outcome.status;
                    renderModal();
                    return result || { ok: false, state: "error" };
                }
                if (result.task) state.tasks = uniqueById(state.tasks.concat([result.task]));
                try { callbacks.onTaskCreated?.(result); } catch (error) {}
                const message = canvasPlanner ? "Task updated in Canvas." : "Task updated in Nest.";
                finishModal(message);
                return result;
            }

            const dates = occurrenceDates(modalDraft);
            if (!dates.length) {
                modalErrors = { ...modalErrors, dueDate: "Choose a valid due date before creating the task." };
                modalMessage = "Fix the highlighted fields before creating the task.";
                modalStatus = "validation";
                renderModal();
                focusFirstModalError();
                return { ok: false, state: "validation" };
            }
            const signature = occurrenceSignature(modalDraft);
            if (modalCreateProgress.signature !== signature) resetCreateProgress();
            modalCreateProgress.signature = signature;
            const idempotencyBase = `todo-create:${stableHash(JSON.stringify(modalDraft))}`;
            modalBusy = true;
            modalMessage = dates.length > 1 ? `Creating ${dates.length} tasks…` : canvasPlanner ? "Creating in Canvas…" : "Creating in Nest…";
            modalStatus = "saving";
            renderModal();
            let outcome = null;
            let lastResult = null;
            for (const dateKey of dates) {
                if (modalCreateProgress.created.has(dateKey)) continue;
                const requestId = `todo-create-request:${++requestSequence}:${dateKey.replace(/-/g, "")}`;
                const idempotencyKey = `${idempotencyBase}:${dateKey}`;
                let result;
                try {
                    const payload = canvasPlanner
                        ? canvasOccurrencePayload(modalDraft, dateKey)
                        : buildNestCreatePayload({ ...modalDraft, dueDate: dateKey }, idempotencyKey);
                    result = await create(payload, { requestId, idempotencyKey });
                } catch (error) {
                    result = { ok: false, state: "error", error: { code: error?.code || (canvasPlanner ? "CANVAS_PLANNER_NOTE_CREATE_FAILED" : "NEST_TODO_CREATE_FAILED"), message: error?.message || (canvasPlanner ? "Canvas could not create the task." : "Nest could not create the task.") } };
                }
                if (result && result.ok === true) {
                    modalCreateProgress.created.set(dateKey, result);
                    modalCreateProgress.failedDate = null;
                    modalCreateProgress.uncertain = false;
                    if (result.task) state.tasks = uniqueById(state.tasks.concat([result.task]));
                    try { callbacks.onTaskCreated?.(result); } catch (error) {}
                    lastResult = result;
                    continue;
                }
                outcome = failureOutcome(result, canvasPlanner);
                modalCreateProgress.failedDate = dateKey;
                modalCreateProgress.uncertain = outcome.status === "uncertain";
                lastResult = result || { ok: false, state: "error" };
                break;
            }
            modalBusy = false;
            const createdCount = dates.filter((dateKey) => modalCreateProgress.created.has(dateKey)).length;
            if (outcome) {
                const total = dates.length;
                const progressCopy = createdCount > 0 ? `Created ${createdCount} of ${total} tasks. ` : "";
                const remainingCopy = createdCount > 0
                    ? `Retry creates only the remaining ${total - createdCount} ${total - createdCount === 1 ? "task" : "tasks"}.`
                    : "";
                modalMessage = `${progressCopy}${outcome.message} Your draft is preserved.${remainingCopy ? ` ${remainingCopy}` : ""}`;
                modalStatus = outcome.status;
                renderModal();
                return lastResult;
            }
            const message = canvasPlanner
                ? (createdCount === 1 ? "Task created in Canvas." : `${createdCount} tasks created in Canvas.`)
                : (createdCount === 1 ? "Task created in Nest." : `${createdCount} tasks created in Nest.`);
            finishModal(message);
            return lastResult || { ok: true, state: "created" };
        }

        function finishModal(message) {
            modalOpen = false;
            modalTask = null;
            modalDraft = null;
            modalMessage = message;
            modalStatus = "idle";
            modalConfirmDiscard = false;
            modalDateMutationBlocked = false;
            resetCreateProgress();
            detachModalKeydown();
            removeModalNode();
            setLive(message);
            restoreFocusAfterModalClose();
        }

        function focusFirstModalError() {
            const first = Object.keys(modalErrors)[0];
            if (first && modalFields[first]) modalFields[first].focus?.();
            else modalFields.title?.focus?.();
        }

        function connectNest() {
            callbacks.onConnectNest?.();
            modalMessage = "Use Calendar & Accounts to connect Nest or sign in, then retry.";
            modalStatus = "connect";
            renderModal();
        }

        function removeModalNode() {
            modalNode?.remove?.();
            modalNode = null;
            modalFields = {};
        }

        function detachModalKeydown() { documentRef.removeEventListener?.("keydown", modalKeydown); }

        function canRestoreFocus(node) {
            if (!node || typeof node.focus !== "function" || node.disabled || node.hidden) return false;
            const connected = typeof node.isConnected === "boolean"
                ? node.isConnected
                : documentRef.contains?.(node);
            return connected !== false && node.getAttribute?.("aria-hidden") !== "true";
        }

        function restoreFocusAfterModalClose() {
            const focus = previousFocus;
            previousFocus = null;
            renderRail();
            const target = canRestoreFocus(focus)
                ? focus
                : rootNode?.querySelector?.(".apstudy-todo-add");
            target?.focus?.();
        }

        function closeAddTask(force = false) {
            if (!modalOpen) return;
            // A dirty draft earns BC's confirm-discard step; destroying the rail
            // or finishing a create skips straight past it.
            if (!force && !modalConfirmDiscard && isDraftDirty()) {
                modalConfirmDiscard = true;
                renderModal();
                modalFields.discard?.focus?.();
                return;
            }
            modalOpen = false;
            modalBusy = false;
            modalConfirmDiscard = false;
            modalDateMutationBlocked = false;
            modalErrors = {};
            detachModalKeydown();
            removeModalNode();
            restoreFocusAfterModalClose();
        }

        function discardDraft() {
            modalDraft = null;
            modalErrors = {};
            modalMessage = "";
            modalStatus = "idle";
            resetCreateProgress();
            closeAddTask(true);
        }

        function cancelDiscard() {
            modalConfirmDiscard = false;
            modalErrors = {};
            renderModal();
            modalFields.title?.focus?.();
        }

        function openAddTask() {
            if (modalOpen) return;
            modalOpen = true;
            modalTask = null;
            modalDateMutationBlocked = false;
            modalDraft = modalDraft || defaultDraft({ operationId: true });
            modalErrors = {};
            modalMessage = "";
            modalStatus = "idle";
            modalConfirmDiscard = false;
            previousFocus = documentRef.activeElement || null;
            on(documentRef, "keydown", modalKeydown);
            renderModal();
            focusModalTitleAtTop();
        }

        // The dialog opens at the title even if focusing the first field nudged
        // the form's scrollport on a short viewport.
        function focusModalTitleAtTop() {
            modalFields.title?.focus?.();
            const formNode = modalNode?.querySelector?.(".apstudy-todo-form");
            if (formNode) formNode.scrollTop = 0;
        }

        function openEditTask(task) {
            if (!plannerTasksEnabled() || task?.mutationAuthority !== "canvas_planner_note" || modalOpen) return;
            const draft = plannerDraft(task);
            const points = plainObject(draft.points);
            modalTask = task;
            modalDateMutationBlocked = task?.raw?.planner_note_date_mutation_blocked === true;
            modalOpen = true;
            resetCreateProgress();
            modalDraft = {
                ...defaultDraft(),
                title: text(draft.title || task.title),
                description: text(draft.description),
                dueDate: text(draft.todoDate || task?.due?.date),
                dueTime: "",
                courseId: text(draft.courseId || task?.course?.id),
                link: text(draft.link),
                type: TYPE_OPTIONS.includes(text(draft.type)) ? text(draft.type) : taskTypeForTask(task),
                customType: text(draft.customType || task?.customType),
                priority: text(draft.priority || task?.priority),
                earned: points.earned === null || points.earned === undefined ? "" : String(points.earned),
                possible: points.possible === null || points.possible === undefined ? "" : String(points.possible)
            };
            modalErrors = {}; modalMessage = modalDateMutationBlocked
                ? "Canvas account timezone is unavailable. Reload Canvas before editing or completing this task. You can still delete it."
                : "Edit this APStudyCanvas-owned Canvas task."; modalStatus = modalDateMutationBlocked ? "unavailable" : "idle"; modalConfirmDiscard = false;
            previousFocus = documentRef.activeElement || null;
            on(documentRef, "keydown", modalKeydown);
            renderModal();
            focusModalTitleAtTop();
        }

        function taskTypeForTask(task) {
            const value = text(task?.taskType);
            if (TYPE_OPTIONS.includes(value)) return value;
            return "task";
        }

        async function deletePlannerTask(task) {
            const remove = plannerDeleteTransport();
            if (modalBusy || typeof remove !== "function" || task?.mutationAuthority !== "canvas_planner_note") return;
            modalBusy = true; modalMessage = "Deleting from Canvas…"; modalStatus = "saving"; renderModal();
            let result;
            try { result = await remove(task, { requestId: `todo-delete:${++requestSequence}` }); } catch (error) { result = { ok: false, error: { message: error?.message || "Canvas could not delete the task." } }; }
            modalBusy = false;
            if (!result?.ok) { modalMessage = `${result?.error?.message || "Canvas could not delete the task."} Your task is unchanged.`; modalStatus = "error"; renderModal(); return; }
            modalOpen = false; modalTask = null; modalDraft = null; removeModalNode(); detachModalKeydown(); setLive("Task deleted from Canvas."); try { callbacks.onTaskCreated?.(result); } catch (error) {} restoreFocusAfterModalClose();
        }

        function renderModal() {
            const activeFieldKey = modalOpen ? text(documentRef.activeElement?.name || documentRef.activeElement?.getAttribute?.("name")) : "";
            // A re-render rebuilds the form, so the reading position is captured
            // and restored: changing type, repeat, or date validity must not
            // jump the dialog back to the top.
            const restoreScroll = modalOpen ? Number(modalNode?.querySelector?.(".apstudy-todo-form")?.scrollTop) || 0 : 0;
            removeModalNode();
            if (!modalOpen || !documentRef?.body) return;
            const backdrop = makeElement(documentRef, "div", { className: "apstudy-todo-modal-backdrop", "data-apstudycanvas-owned": "todo-modal" });
            const dialog = makeElement(documentRef, "div", { className: "apstudy-todo-modal", role: "dialog", "aria-modal": "true", "aria-labelledby": "apstudy-todo-modal-title", "aria-describedby": "apstudy-todo-modal-status" });
            modalNode = backdrop;
            modalFields = {};
            append(backdrop, dialog);
            const header = makeElement(documentRef, "header", { className: "apstudy-todo-modal-header" });
            append(header, makeElement(documentRef, "h2", { id: "apstudy-todo-modal-title", textContent: modalTask ? "Edit Canvas task" : "Add task" }));
            const close = makeElement(documentRef, "button", { type: "button", className: "apstudy-todo-modal-close", "data-action": "close-add-task", "aria-label": "Close Add Task dialog", title: "Close" });
            on(close, "click", () => closeAddTask());
            append(header, close);
            append(dialog, header);

            if (modalConfirmDiscard) {
                const confirm = makeElement(documentRef, "div", { className: "apstudy-todo-modal-confirm" });
                append(confirm, makeElement(documentRef, "p", { id: "apstudy-todo-modal-status", className: "apstudy-todo-modal-status is-confirm", "aria-live": "polite", textContent: "Do you want to discard this task." }));
                const actions = makeElement(documentRef, "div", { className: "apstudy-todo-modal-actions" });
                const cancel = makeElement(documentRef, "button", { type: "button", className: "apstudy-todo-cancel", "data-action": "cancel-discard", textContent: "Cancel" });
                const discard = makeElement(documentRef, "button", { type: "button", className: "apstudy-todo-discard", "data-action": "confirm-discard", textContent: "Discard" });
                on(cancel, "click", cancelDiscard);
                on(discard, "click", discardDraft);
                modalFields.cancel = cancel;
                modalFields.discard = discard;
                append(actions, cancel);
                append(actions, discard);
                append(confirm, actions);
                append(dialog, confirm);
                append(documentRef.body, backdrop);
                return;
            }

            const form = makeElement(documentRef, "form", { className: "apstudy-todo-form", novalidate: "true" });
            on(form, "submit", (event) => { event.preventDefault?.(); submitAddTask(); });
            append(form, makeElement(documentRef, "p", {
                id: "apstudy-todo-modal-status",
                className: `apstudy-todo-modal-status is-${modalStatus}`,
                "data-apstudycanvas-planner-build": PLANNER_DIAGNOSTIC_BUILD,
                role: modalStatus === "saving" ? "status" : "alert",
                "aria-live": "polite",
                textContent: modalMessage || (plannerTasksEnabled()
                    ? "This creates an APStudyCanvas-owned planner task in Canvas when you submit."
                    : "Nest tasks stay separate from Canvas assignments.")
            }));

            // Title leads: it is the only required field, so it owns the first
            // focus stop and the first reading position in the dialog.
            const titleInput = makeElement(documentRef, "input", { id: "apstudy-todo-field-title", name: "title", type: "text", maxlength: "255", required: "true", "aria-required": "true", placeholder: "Item title", autocomplete: "off" });
            titleInput.value = text(modalDraft.title);
            on(titleInput, "input", () => updateDraft("title", titleInput.value));
            stackedField(form, "title", "Title", "sheet", titleInput);

            const description = makeElement(documentRef, "textarea", { id: "apstudy-todo-field-description", name: "description", rows: "3", maxlength: "2000", placeholder: "Add a description (optional)", "aria-label": "Description (optional)" });
            description.value = text(modalDraft.description);
            on(description, "input", () => updateDraft("description", description.value));
            stackedField(form, "description", "Description", "note", description);

            const linkPill = makeElement(documentRef, "div", { className: "apstudy-todo-form-link" });
            append(linkPill, icon(documentRef, "link", 16));
            const linkInput = makeElement(documentRef, "input", { id: "apstudy-todo-field-link", name: "link", type: "url", inputmode: "url", placeholder: "Add a link", "aria-label": "Add a link (optional HTTPS link)", autocomplete: "url" });
            linkInput.value = text(modalDraft.link);
            on(linkInput, "input", () => updateDraft("link", linkInput.value));
            on(linkInput, "change", () => updateDraft("link", linkInput.value));
            modalFields.link = linkInput;
            append(linkPill, linkInput);
            stackedField(form, "link", "Link", null, linkPill);

            // Course and Type pair on desktop; the pair collapses to one
            // column on narrow viewports.
            const detailPair = makeElement(documentRef, "div", { className: "apstudy-todo-form-pair" });
            const courses = [{ value: "", label: "No course — Personal" }].concat((plannerTasksEnabled() ? plannerCourses() : state.courses).map((course) => ({ value: String(course.id), label: courseLabel(course) })));
            const courseSelect = selectControl("courseId", courses);
            on(courseSelect, "change", () => updateDraft("courseId", courseSelect.value));
            stackedField(detailPair, "courseId", "Course", "book", courseSelect);
            const typeSelect = selectControl("type", TYPE_OPTIONS.map((value) => ({ value, label: TYPE_LABELS[value] || value })));
            on(typeSelect, "change", () => {
                const wasCustom = String(modalDraft.type) === "custom";
                updateDraft("type", typeSelect.value);
                if (wasCustom || typeSelect.value === "custom") renderModal();
            });
            stackedField(detailPair, "type", "Type", "note", typeSelect);
            append(form, detailPair);

            if (String(modalDraft.type) === "custom") {
                const customInput = makeElement(documentRef, "input", { id: "apstudy-todo-field-customType", name: "customType", type: "text", maxlength: String(CUSTOM_TYPE_MAX), placeholder: "Name this type", autocomplete: "off" });
                customInput.value = text(modalDraft.customType);
                on(customInput, "input", () => updateDraft("customType", customInput.value));
                stackedField(form, "customType", "Custom type", "note", customInput);
            }

            const duePair = makeElement(documentRef, "div", { className: "apstudy-todo-form-pair" });
            const dueDate = makeElement(documentRef, "input", { id: "apstudy-todo-field-dueDate", name: "dueDate", type: "date", "aria-label": "Due date" });
            dueDate.value = text(modalDraft.dueDate);
            on(dueDate, "input", () => updateDraft("dueDate", dueDate.value));
            on(dueDate, "change", () => {
                const wasValid = timeApi?.dateKeyValid?.(modalDraft.dueDate) === true;
                updateDraft("dueDate", dueDate.value);
                if (wasValid !== (timeApi?.dateKeyValid?.(dueDate.value) === true)) renderModal();
            });
            stackedField(duePair, "dueDate", "Due date", "calendar", dueDate);
            if (plannerTasksEnabled()) {
                // Canvas planner notes are date-only end to end: the writer
                // sends todo_date only and reloads an all-day due, so a time
                // field would promise a save that cannot happen.
                append(form, duePair);
                append(form, makeElement(documentRef, "p", { className: "apstudy-todo-form-date-note", textContent: "Canvas planner tasks are date-only — time is not saved." }));
            } else {
                const dueTime = makeElement(documentRef, "input", { id: "apstudy-todo-field-dueTime", name: "dueTime", type: "time", "aria-label": "Due time" });
                dueTime.value = text(modalDraft.dueTime);
                on(dueTime, "input", () => updateDraft("dueTime", dueTime.value));
                on(dueTime, "change", () => updateDraft("dueTime", dueTime.value));
                stackedField(duePair, "dueTime", "Due time", "clock", dueTime);
                append(form, duePair);
            }

            if (!plannerTasksEnabled()) {
                const timezone = makeElement(documentRef, "input", { id: "apstudy-todo-field-timezone", name: "timezone", type: "text", autocomplete: "off" });
                timezone.value = text(modalDraft.timezone);
                on(timezone, "input", () => updateDraft("timezone", timezone.value));
                stackedField(form, "timezone", "Timezone", "clock", timezone);
            }

            if (!modalTask) {
                const validDate = timeApi?.dateKeyValid?.(modalDraft.dueDate) === true;
                const repeatRow = makeElement(documentRef, "div", { className: "apstudy-todo-form-row is-stacked apstudy-todo-form-repeat", "data-field": "repeat", "data-repeat-active": String(repeatCount(modalDraft) > 0) });
                const repeatLabel = makeElement(documentRef, "label", { htmlFor: "apstudy-todo-field-repeat", className: "apstudy-todo-form-row-label" });
                append(repeatLabel, icon(documentRef, "calendar", 16));
                append(repeatLabel, makeElement(documentRef, "span", { textContent: "Repeat weekly" }));
                const repeatSelect = selectControl("repeat", REPEAT_OPTIONS);
                setDisabled(repeatSelect, !validDate);
                on(repeatSelect, "change", () => { updateDraft("repeat", repeatSelect.value); renderModal(); });
                append(repeatRow, repeatLabel);
                append(repeatRow, repeatSelect);
                append(repeatRow, makeElement(documentRef, "p", {
                    className: "apstudy-todo-form-repeat-summary",
                    role: "status",
                    textContent: validDate
                        ? (repeatSummary(modalDraft) || "No repeat — creates one task.")
                        : "Add a due date to repeat this task."
                }));
                if (modalErrors.repeat) append(repeatRow, fieldError("repeat", modalErrors.repeat));
                modalFields.repeat = repeatSelect;
                append(form, repeatRow);
            }

            // Priority and points share the final two-column band.
            const bottomPair = makeElement(documentRef, "div", { className: "apstudy-todo-form-pair" });
            const prioritySelect = selectControl("priority", PRIORITY_OPTIONS.map((value) => ({ value, label: PRIORITY_LABELS[value] || value })));
            on(prioritySelect, "change", () => updateDraft("priority", prioritySelect.value));
            stackedField(bottomPair, "priority", "Priority", "flag", prioritySelect);

            const pointsRow = makeElement(documentRef, "div", { className: "apstudy-todo-form-row is-stacked", "data-field": "points" });
            const pointsLabel = makeElement(documentRef, "label", { htmlFor: "apstudy-todo-field-earned", className: "apstudy-todo-form-row-label" });
            append(pointsLabel, icon(documentRef, "star", 16));
            append(pointsLabel, makeElement(documentRef, "span", { textContent: "Points" }));
            const pointsWrap = makeElement(documentRef, "div", { className: "apstudy-todo-form-points" });
            const earned = makeElement(documentRef, "input", { id: "apstudy-todo-field-earned", name: "earned", type: "number", min: "0", step: "any", inputmode: "decimal", placeholder: "--", "aria-label": "Earned points (optional)" });
            earned.value = text(modalDraft.earned);
            const possible = makeElement(documentRef, "input", { id: "apstudy-todo-field-possible", name: "possible", type: "number", min: "0", step: "any", inputmode: "decimal", placeholder: "--", "aria-label": "Possible points (optional)" });
            possible.value = text(modalDraft.possible);
            on(earned, "input", () => updateDraft("earned", earned.value));
            on(possible, "input", () => updateDraft("possible", possible.value));
            modalFields.earned = earned;
            modalFields.possible = possible;
            append(pointsWrap, earned);
            append(pointsWrap, makeElement(documentRef, "span", { className: "apstudy-todo-form-points-slash", "aria-hidden": "true", textContent: "/" }));
            append(pointsWrap, possible);
            if (modalErrors.earned || modalErrors.possible) {
                if (modalErrors.earned) earned.setAttribute?.("aria-invalid", "true");
                if (modalErrors.possible) possible.setAttribute?.("aria-invalid", "true");
                append(pointsWrap, fieldError(modalErrors.earned ? "earned" : "possible", modalErrors.earned || modalErrors.possible));
            }
            append(pointsRow, pointsLabel);
            append(pointsRow, pointsWrap);
            modalFields.points = pointsWrap;
            append(bottomPair, pointsRow);
            append(form, bottomPair);

            const actions = makeElement(documentRef, "div", { className: "apstudy-todo-modal-actions" });
            const cancel = makeElement(documentRef, "button", { type: "button", className: "apstudy-todo-cancel", "data-action": "cancel-add-task", textContent: "Cancel" });
            on(cancel, "click", () => closeAddTask());
            append(actions, cancel);
            if (modalTask) {
                const remove = makeElement(documentRef, "button", { type: "button", className: "apstudy-todo-discard", "data-action": "delete-planner-task", textContent: "Delete" });
                setDisabled(remove, modalBusy);
                on(remove, "click", () => deletePlannerTask(modalTask));
                append(actions, remove);
            }
            if (!plannerTasksEnabled() && modalStatus === "connect") {
                const connect = makeElement(documentRef, "button", { type: "button", className: "apstudy-todo-connect", "data-action": "connect-nest", textContent: "Connect Nest" });
                setDisabled(connect, modalBusy);
                on(connect, "click", connectNest);
                append(actions, connect);
            }
            const submit = makeElement(documentRef, "button", { type: "submit", className: "apstudy-todo-submit", "data-action": "submit-task", textContent: primaryActionLabel() });
            setDisabled(submit, modalBusy || Boolean(modalTask && modalDateMutationBlocked));
            if (modalBusy) submit.setAttribute?.("aria-busy", "true");
            if (!modalTask && ["error", "unavailable", "connect", "uncertain"].includes(modalStatus)) submit.setAttribute?.("data-recovery", "true");
            append(actions, submit);
            append(form, actions);
            append(dialog, form);
            append(documentRef.body, backdrop);
            // The form only has a scrollport once it is attached (clientHeight
            // > 0). Restoring the reading position before that clamps scrollTop
            // to 0 and the dialog jumps back to the top.
            form.scrollTop = restoreScroll;
            const refocus = activeFieldKey && modalFields[activeFieldKey];
            if (refocus?.focus) refocus.focus({ preventScroll: true });
        }

        function handleCompletion(task, desired) {
            if (!task || completionPending) return;
            const readAction = task?.type === "announcement";
            const isLocalAssignment = !readAction && task?.source === "canvas" && task?.type !== "planner_note";
            if (isLocalAssignment && desired && typeof windowRef?.confirm === "function") {
                const confirmed = windowRef.confirm(`Mark “${text(task.title, "this assignment") }” as completed in APStudyCanvas? This will not change Canvas.`);
                if (!confirmed) {
                    setLive("Completion cancelled.");
                    return;
                }
            }
            const dispatcher = callbacks.completionDispatcher || callbacks.onComplete || callbacks.todoApi?.dispatchCompletion || domain.api?.dispatchCompletion;
            if (typeof dispatcher !== "function") {
                completionErrors.set(task.id, "Completion is unavailable. Try again after reconnecting.");
                setLive("Completion is unavailable. Retry is available.");
                renderRail();
                return;
            }
            completionPending = task.id;
            completionErrors.delete(task.id);
            setLive(`${text(task.title, "Task")} is saving.`);
            renderRail();
            const requestId = `todo-completion-request:${++requestSequence}`;
            const idempotencyKey = `todo-completion:${stableHash(String(task.id))}:${desired ? "complete" : "active"}`;
            const requestVersion = lifecycleVersion;
            Promise.resolve().then(() => dispatcher(task, desired, { requestId, idempotencyKey, mode: state.settings.todo_completion_authority, accountKey: task.accountKey })).then((result) => {
                if (!mounted || requestVersion !== lifecycleVersion) return;
                completionPending = null;
                if (result?.ok === true) {
                    const replacement = result.task
                        || (readAction ? domain.state?.applyConfirmedAnnouncementRead?.(task, desired) : null)
                        || domain.state?.applyConfirmedCompletion?.(task, desired)
                        || { ...task, completion: desired };
                    state.tasks = state.tasks.map((entry) => String(entry.id) === String(task.id) ? replacement : entry);
                    completionErrors.delete(task.id);
                    setLive(`${text(task.title, "Task")} marked ${readAction ? (desired ? "read" : "unread") : desired ? "complete" : "active"}.`);
                    renderRail();
                    // Reading an announcement is routine triage, not finished
                    // work: the completion celebration stays reserved for
                    // tasks that actually completed.
                    if (!readAction) {
                        effects?.celebrate?.({
                            container: effectsLayer,
                            type: state.settings.todo_celebration,
                            intensity: state.settings.todo_celebration_intensity,
                            reducedMotion: state.settings.todo_reduced_motion_safe === true
                                ? effects?.prefersReducedMotion?.(windowRef)
                                : false,
                            onStaticSuccess: () => {}
                        });
                    }
                    try { callbacks.onCompletionSuccess?.(replacement); } catch (error) {}
                } else {
                    const message = result?.error?.message || "Canvas or Nest did not confirm the change.";
                    completionErrors.set(task.id, `${message} Your previous state is unchanged.`);
                    setLive(`${text(task.title, "Task")} could not be updated. Retry is available.`);
                    renderRail();
                    // Contained: a throwing consumer callback must not turn the
                    // settled completion promise into an unhandled rejection
                    // (and must not re-enter this handler through the .catch).
                    try { callbacks.onCompletionFailure?.(result); } catch (error) {}
                }
            }).catch((error) => {
                if (!mounted || requestVersion !== lifecycleVersion) return;
                completionPending = null;
                completionErrors.set(task.id, `${error?.message || "The completion request failed."} Your previous state is unchanged.`);
                setLive(`${text(task.title, "Task")} could not be updated. Retry is available.`);
                renderRail();
                try { callbacks.onCompletionFailure?.(error); } catch (callbackError) {}
            });
        }

        // Render-signature state: the digest of what is currently projected
        // into the DOM. null means "nothing rendered yet" (fresh mount, after
        // destroy, or mid-render), which forces the next update to render.
        let renderSignature = null;

        // Signature for one task: every field renderTask, the preview card,
        // grouping, or the completion dispatcher reads. Everything else on
        // the record (raw payloads, hidden timestamps, functions, internal
        // bookkeeping) is deliberately excluded. safeHttpsUrl and text() are
        // applied so the signature sees exactly the normalized values the
        // renderer would project.
        function taskSignature(task) {
            if (!task || typeof task !== "object") return null;
            const course = task.course && typeof task.course === "object" ? task.course : null;
            const due = task.due && typeof task.due === "object" ? task.due : null;
            const points = task.points && typeof task.points === "object" ? task.points : null;
            return {
                id: text(task.id),
                eventRef: text(task.eventRef),
                remoteId: text(task.remoteId),
                sourceItemKey: text(task.sourceItemKey),
                source: text(task.source),
                title: text(task.title),
                type: text(task.type),
                taskType: text(task.taskType),
                customType: text(task.customType),
                priority: text(task.priority),
                url: safeHttpsUrl(task.url) || "",
                accountKey: text(task.accountKey),
                timezone: text(task.timezone),
                course: course ? {
                    id: text(course.id),
                    label: text(course.label),
                    code: text(course.code),
                    name: text(course.name),
                    // The row renders courseColorForTask(task) — the resolved
                    // displayed-set color — so the signature signs that value,
                    // not the raw pre-merge course color.
                    color: courseColorForTask(task)
                } : null,
                due: due ? {
                    kind: text(due.kind),
                    date: text(due.date),
                    timeZone: text(due.timeZone),
                    // The instant is displayed (and feeds dueDateKey) only for
                    // instant-kind dues; a date-kind due's stray instant never
                    // renders, so it stays out of the signature.
                    instant: due.kind === "instant" ? text(due.utcInstant || due.at || due.value) : ""
                } : (task.due ? String(task.due) : null),
                points: points ? { earned: pointPart(points.earned), possible: pointPart(points.possible) } : null,
                completion: Boolean(task.completion),
                submitted: Boolean(task.submitted),
                graded: Boolean(task.graded),
                missing: task.missing === true,
                unread: task.unread === true,
                description: taskDescription(task)
            };
        }

        // Mirrors renderStreak's resolution: nest-source renders 0 days, a
        // supplied current renders its clamped day count, and anything else
        // is derived from tasks/now/range, which are signed on their own.
        // The streak state rides along in the signature: a rollover that only
        // moves tracking → verified (or verified → stale) at the same day
        // count changes the rendered copy and must not converge away.
        function streakSignature() { return JSON.stringify(state.streak || null); }

        function computeRenderSignature() {
            try {
                return JSON.stringify(signatureValue({
                    tasks: array(state.tasks).map(taskSignature),
                    settings: state.settings,
                    range: state.range ? { start: text(state.range.start), end: text(state.range.end), timeZone: text(state.range.timeZone) } : null,
                    courses: array(state.courses).map((course) => [text(course.id), text(course.label), text(course.course?.code), courseColor(course)]),
                    feedback: array(state.feedback).map((entry) => [
                        text(entry?.id),
                        text(entry?.title),
                        text(entry?.url),
                        text(entry?.courseId),
                        text(entry?.courseLabel),
                        pointPart(entry?.score?.earned),
                        pointPart(entry?.score?.possible)
                    ]),
                    streak: streakSignature(),
                    calendar: [
                        text(state.calendar?.state || state.calendar?.status || state.calendarConnectionState).toLowerCase(),
                        state.calendar?.syncing === true
                    ],
                    canvasState: text(state.canvasState).toLowerCase(),
                    cacheState: text(state.cacheState).toLowerCase(),
                    pending: state.pending === true,
                    liveMessage: String(state.liveMessage ?? ""),
                    now: state.now ?? null,
                    timeZone: text(state.timeZone),
                    selectedTab,
                    selectedCourseIds: selectedCourseIds.map(String),
                    collapsedGroups: Array.from(collapsedGroups).map(String).sort(),
                    previewFor: previewFor === null ? null : String(previewFor),
                    completionPending: completionPending === null ? null : String(completionPending),
                    completionErrors: Array.from(completionErrors.entries())
                        .map(([id, message]) => [String(id), text(message)])
                        .sort((left, right) => String(left[0]).localeCompare(String(right[0])))
                }));
            } catch (error) {
                // Unserializable input (e.g. a circular object smuggled into
                // settings): fail open and render.
                return null;
            }
        }

        // Inline sizing is never the rail's scroll mechanism: the data
        // attributes plus CSS own both modes. Anything an earlier owner (or a
        // page-level tweak) left inline — a pinned height, an overflow-y —
        // would resurrect an independent nested scrollport against the current
        // setting, so every render strips it. Reversible by construction:
        // turning todo_separate_scrollbar on re-enables only the CSS contract.
        const RAIL_SCROLL_INLINE_PROPS = Object.freeze([
            "block-size", "height", "max-block-size", "max-height", "min-block-size", "min-height",
            "overflow", "overflow-x", "overflow-y", "overscroll-behavior", "scrollbar-gutter"
        ]);

        function reconcileRailScrollStyles() {
            if (!rootNode) return;
            RAIL_SCROLL_INLINE_PROPS.forEach((property) => rootNode.style?.removeProperty?.(property));
        }

        function renderRail() {
            if (!mounted || !rootNode) return;
            renderSignature = null;
            reconcileRailScrollStyles();
            rootNode.setAttribute?.("data-separate-scrollbar", String(state.settings.todo_separate_scrollbar === true));
            rootNode.setAttribute?.("data-full-height", String(state.settings.todo_full_height === true));
            stopLoadingMotion?.(); stopLoadingMotion = null;
            const streakFocus = documentRef.activeElement?.getAttribute?.("data-streak-focus");
            const triggerFocused = documentRef.activeElement === streakTrigger;
            clearChildren(rootNode);
            renderStreak();
            renderHeader();
            renderTimeframe();
            renderProgress();
            renderTabs();
            renderGroups();
            renderAddTask();
            effectsLayer = makeElement(documentRef, "div", { className: "apstudy-todo-effects-layer", "data-todo-effects-layer": "true", "aria-hidden": "true" });
            append(rootNode, effectsLayer);
            append(rootNode, makeElement(documentRef, "p", { className: "apstudy-todo-live", role: "status", "aria-live": "polite", "aria-atomic": "true", textContent: state.liveMessage }));
            reattachPreview();
            renderModal();
            renderSignature = computeRenderSignature();
            if (streakFocus && streakOpen) {
                const target = Array.from(streakPopup?.querySelectorAll?.("[data-streak-focus]") || []).find(node => node.getAttribute("data-streak-focus") === streakFocus);
                (target || streakPopup?.querySelector?.("button"))?.focus?.();
            } else if (triggerFocused) streakTrigger?.focus?.();
        }

        function bindPreviewKeydown() {
            if (previewKeydown) return;
            previewKeydown = (event) => {
                if (event?.key === "Escape" && !modalOpen && previewFor !== null) hidePreviewNode({ returnFocus: true });
            };
            on(documentRef, "keydown", previewKeydown);
        }

        let stopMotionVisibility = null;

        function mount(input = {}) {
            const target = input.host || host;
            if (!target) return { ok: false, code: "TODO_RAIL_HOST_REQUIRED" };
            if (mounted && target === host) {
                update(input);
                return { ok: true, state: "already-mounted", root: rootNode };
            }
            if (mounted) destroy();
            host = target;
            // A fresh root must always paint its first render, even when the
            // caller replays an input that matches the previous lifecycle.
            renderSignature = null;
            lifecycleVersion += 1;
            nativeNodes = childrenOf(host);
            nativeNodes.forEach((node) => node.remove?.());
            rootNode = makeElement(documentRef, "aside", { className: "apstudy-todo-right-rail", "data-apstudycanvas-owned": "todo-right-rail", "data-placement": input.placement || options.placement || "right-rail", "aria-labelledby": "apstudy-todo-title" });
            append(host, rootNode);
            stopMotionVisibility = globalThis.APStudyCanvasMotion?.watchVisibility(rootNode);
            mounted = true;
            bindPreviewKeydown();
            on(documentRef, "click", streakDocumentClick);
            on(documentRef, "keydown", streakDocumentKey);
            on(windowRef, "resize", positionStreak);
            on(documentRef, "scroll", positionStreak);
            viewModel(input);
            renderRail();
            return { ok: true, state: "mounted", root: rootNode };
        }

        function update(input = {}) {
            if (!mounted) return { ok: false, code: "TODO_RAIL_NOT_MOUNTED" };
            viewModel(input);
            const signature = computeRenderSignature();
            // Convergence: the normalized render-visible state is identical
            // to what is already on screen (same host, same signature), so
            // skip clearChildren and the rebuild entirely. Interaction
            // handlers still call renderRail() directly and always repaint.
            if (signature !== null && signature === renderSignature) {
                return { ok: true, state: "updated", root: rootNode, rendered: false };
            }
            renderRail();
            return { ok: true, state: "updated", root: rootNode, rendered: true };
        }

        function destroy() {
            closeStreak();
            documentRef.removeEventListener?.("click", streakDocumentClick);
            documentRef.removeEventListener?.("keydown", streakDocumentKey);
            windowRef.removeEventListener?.("resize", positionStreak);
            documentRef.removeEventListener?.("scroll", positionStreak);
            if (!mounted) return { ok: true, state: "already-destroyed" };
            lifecycleVersion += 1;
            closeAddTask(true);
            hidePreviewNode();
            if (previewKeydown) {
                documentRef.removeEventListener?.("keydown", previewKeydown);
                previewKeydown = null;
            }
            effects?.destroy?.();
            stopLoadingMotion?.(); stopLoadingMotion = null;
            stopMotionVisibility?.(); stopMotionVisibility = null;
            rootNode?.remove?.();
            childrenOf(host).filter((node) => node?.getAttribute?.("data-apstudycanvas-owned") === "todo-right-rail").forEach((node) => node.remove?.());
            const captured = new Set(array(nativeNodes));
            const firstUncaptured = childrenOf(host).find((node) => !captured.has(node)) || null;
            array(nativeNodes).forEach((node) => {
                if (node?.parentNode === host) return;
                if (typeof host.insertBefore === "function") host.insertBefore(node, firstUncaptured);
                else append(host, node);
            });
            rootNode = null;
            effectsLayer = null;
            nativeNodes = null;
            mounted = false;
            completionPending = null;
            // Reset the digest so a remount (same controller, same input)
            // repaints instead of converging against a dead tree.
            renderSignature = null;
            return { ok: true, state: "destroyed" };
        }

        const controller = {
            mount,
            update,
            destroy,
            openAddTask,
            closeAddTask,
            getRoot: () => rootNode,
            getState: () => ({
                ...state,
                selectedTab,
                selectedCourseIds: selectedCourseIds.slice(),
                collapsedGroups: Array.from(collapsedGroups),
                previewFor,
                modalOpen,
                completionPending
            })
        };
        return Object.freeze(controller);
    }

    return Object.freeze({
        TABS,
        TAB_ORDER,
        TAB_LABELS,
        PROGRESS_STYLES,
        PROGRESS_STYLE_ALIASES,
        GROUP_ORDER,
        GROUP_LABELS,
        PERSONAL_COURSE_ID,
        FALLBACK_COURSE_PALETTE,
        TYPE_OPTIONS,
        TYPE_LABELS,
        REPEAT_OPTIONS,
        normalizeProgressStyle,
        normalizeSettings,
        normalizeHexColor,
        resolveCourseColors,
        safeHttpsUrl,
        htmlToText,
        formatDue,
        formatRange,
        repeatOccurrenceDates,
        compactCourseCode,
        pointsText,
        progressFromCounts,
        renderProgressGraphic,
        buildNestCreatePayload: (draft, idempotencyKey) => nestCreatePayload(draft, idempotencyKey),
        create: createTodoRightRail
    });
}));
