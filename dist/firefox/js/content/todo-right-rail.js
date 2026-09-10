(function (root, factory) {
    "use strict";
    const content = root?.APStudyCanvasContent || {};
    const state = content.TodoState || (typeof require === "function" ? require("./todo-state.js") : null);
    const time = content.TodoTime || (typeof require === "function" ? require("./todo-time.js") : null);
    const todoApi = content.TodoApi || (typeof require === "function" ? require("./todo-api.js") : null);
    const effectsApi = content.TodoEffects || (typeof require === "function" ? require("./todo-effects.js") : null);
    const planner = content.PlannerTasks || (typeof require === "function" ? require("./planner-tasks.js") : null);
    const api = factory(state, time, todoApi, effectsApi, planner);
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasContent = Object.assign(root.APStudyCanvasContent || {}, { TodoRightRail: api });
}(typeof globalThis !== "undefined" ? globalThis : this, function (stateApi, timeApi, todoApi, effectsApi, plannerApi) {
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
        recent: "Recent"
    });
    const PERSONAL_COURSE_ID = "nest-personal";
    const TYPE_OPTIONS = Object.freeze(["assignment", "quiz", "discussion", "task"]);
    const PRIORITY_OPTIONS = Object.freeze(["", "low", "normal", "high"]);
    const PRIORITY_LABELS = Object.freeze({ "": "Not set", low: "Low", normal: "Medium", high: "High" });
    const TYPE_LABELS = Object.freeze({ assignment: "Assignment", quiz: "Quiz", discussion: "Discussion", task: "Task" });
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

    // Deterministic fallback palette: six hue families balanced around the
    // Nest navy/gold world — navy, teal, plum, forest, cranberry, ochre. One
    // warm anchor instead of the earlier brown-heavy pair, so hashed
    // assignments never stack earth tones against parchment surfaces.
    const FALLBACK_COURSE_PALETTE = Object.freeze(["#294d91", "#1e6f68", "#7d3f68", "#386641", "#b5484d", "#a8842c"]);

    function normalizeHexColor(value) {
        const candidate = text(value).toLowerCase();
        return /^#[0-9a-f]{3,8}$/.test(candidate) ? candidate : null;
    }

    function fallbackCourseHash(key) {
        return Array.from(key).reduce((value, character) => ((value * 31) + character.charCodeAt(0)) >>> 0, 0);
    }

    function courseColor(course, index = 0) {
        const authoritative = normalizeHexColor(course?.color);
        if (authoritative) return authoritative;
        const key = text(course?.id || course?.course_id || course?.code || course?.label || course?.name);
        return FALLBACK_COURSE_PALETTE[(key ? fallbackCourseHash(key) : Math.max(0, index)) % FALLBACK_COURSE_PALETTE.length];
    }

    // One resolved color per displayed course. An authoritative color already
    // carried on the record (Canvas custom colors merge upstream, or the
    // Personal course's own gold) always wins and may legitimately repeat when
    // the user assigned the same color twice. Every other course takes a
    // deterministic palette slot keyed by its stable course id, probing
    // forward past colors already claimed in this displayed set — so displayed
    // fallback colors stay distinct (BC's index-collision duplicates are gone)
    // and rerenders, filter changes, and reloads reproduce the same set
    // because the assignment never depends on task or course arrival order.
    function resolveCourseColors(courses, palette = FALLBACK_COURSE_PALETTE) {
        const list = array(courses);
        const resolved = list.map((course) => normalizeHexColor(course?.color));
        const used = new Set(resolved.filter(Boolean));
        list
            .map((course, index) => ({ index, id: text(course?.id || course?.course_id || course?.code || course?.label || course?.name) }))
            .filter(({ index }) => !resolved[index])
            .sort((left, right) => (left.id === right.id ? left.index - right.index : left.id < right.id ? -1 : 1))
            .forEach(({ id, index }) => {
                const start = id ? fallbackCourseHash(id) % palette.length : 0;
                let assigned = null;
                for (let probe = 0; probe < palette.length && !assigned; probe += 1) {
                    const candidate = palette[(start + probe) % palette.length];
                    if (!used.has(candidate)) assigned = candidate;
                }
                resolved[index] = assigned || palette[start];
                used.add(resolved[index]);
            });
        return resolved;
    }

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

    function formatRange(range) {        if (!range?.start || !range?.end) return "Choose dates";
        const format = (value) => {
            try { return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${value}T12:00:00Z`)); }
            catch (error) { return value; }
        };
        return range.start === range.end ? format(range.start) : `${format(range.start)} - ${format(range.end)}`;
    }

    // BC-style compact points copy: "15pts", "13/13pts", "-/2.5pts". A
    // completed row without a posted score keeps its possible value visible
    // behind the dash; an active row shows only the possible value.
    function pointsText(points, completed = false) {
        if (!points || (points.earned === null && points.possible === null)) return "";
        const value = (v) => v === null || v === undefined ? "-" : String(v);
        if (points.earned === null) return completed ? `-/${value(points.possible)}pts` : `${value(points.possible)}pts`;
        if (points.possible === null) return `${value(points.earned)}pts`;
        return `${value(points.earned)}/${value(points.possible)}pts`;
    }

    function draftPoints(draft) {
        const hasEarned = draft?.earned !== undefined && draft?.earned !== null && draft.earned !== "";
        const hasPossible = draft?.possible !== undefined && draft?.possible !== null && draft.possible !== "";
        if (!hasEarned && !hasPossible) return null;
        return { earned: hasEarned ? Number(draft.earned) : null, possible: hasPossible ? Number(draft.possible) : null };
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

    function typeIconName(task) {
        const type = text(task?.type);
        if (type === "quiz") return "help";
        if (type === "discussion") return "chat";
        if (type === "announcement") return "megaphone";
        if (type === "calendar") return "calendar";
        if (type === "planner_note" || type === "nest_task" || type === "task") return "note";
        return "sheet";
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
            // BC-style adaptive arch: one band per represented course, never a
            // fixed band count. The radial space divides evenly across the
            // count — three courses draw three wide bands, eight draw eight
            // slim ones — and a lone course draws one fat arc. Bands carry
            // their course's color and sweep that course's own progress, so
            // the arch always matches the legend chip set one-to-one.
            const count = palette.length;
            const outerEdge = 64;
            const innerEdge = 18;
            const space = outerEdge - innerEdge;
            const pad = count > 4 ? 2.5 : 3.5;
            const bandWidth = count > 1 ? space / count : space;
            const width = count > 1 ? Math.max(2, bandWidth - pad) : Math.min(28, bandWidth - pad);
            palette.forEach((course, index) => {
                const radius = innerEdge + bandWidth * (count - index) - bandWidth / 2;
                append(svg, arc(radius, `color-mix(in srgb, ${course.color} 24%, var(--todo-surface, #ffffff))`, 1, width));
                const value = arc(radius, course.color, empty ? 1 : courseRatio(course), width);
                value.setAttribute("data-course-id", text(course.id));
                append(svg, value);
            });
            // Compact per-count frame: the viewBox hugs the drawn bands —
            // round caps included, two units of breath on each side — so a
            // lone fat arc and a dense arch each reserve only the height they
            // draw. The CSS box follows this intrinsic ratio (no fixed
            // aspect-ratio), which removes the blank band the old 160/84 box
            // left under few-course arches at narrow widths.
            const outermostRadius = innerEdge + bandWidth * count - bandWidth / 2;
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
        let modalDraft = null;
        let modalErrors = {};
        let modalMessage = "";
        let modalBusy = false;
        let modalStatus = "idle";
        let modalConfirmDiscard = false;
        let modalTask = null;
        let modalDateMutationBlocked = false;
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
            const today = makeElement(documentRef, "button", { type: "button", className: "apstudy-todo-today", "data-action": "today", "aria-label": "Back to today", title: "Back to today", textContent: "Today" });
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
                append(item, makeElement(documentRef, "span", { className: "apstudy-todo-course-code", textContent: courseCode(course.course) }));
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

        function renderGroups() {
            const panel = makeElement(documentRef, "section", { className: "apstudy-todo-panel", id: "apstudy-todo-panel", role: "tabpanel", "aria-labelledby": `apstudy-todo-tab-${selectedTab}`, tabIndex: 0 });
            const entries = currentEntries();
            const groups = buildGroups(entries, state.settings.todo_grouping !== false);
            const notice = selectedTab === TABS.announcements ? announcementNotice() : "";
            if (notice) append(panel, makeElement(documentRef, "p", { className: "apstudy-todo-announcement-notice", role: "status", textContent: notice }));
            if (!groups.length) {
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
            append(actions, complete);

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
            // Hiding decorative icons never removes the semantic course label,
            // task title, or due-state text from the row.
            if (state.settings.todo_icons_visible !== false) {
                const typeMark = makeElement(documentRef, "span", { className: "apstudy-todo-task-type", "aria-hidden": "true" });
                append(typeMark, icon(documentRef, typeIconName(task), 14));
                append(meta, typeMark);
            }
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

        function renderStreak() {
            if (state.settings.todo_streak_enabled === false) return;
            const streak = plainObject(state.streak);
            const section = makeElement(documentRef, "section", { className: "apstudy-todo-streak", "data-streak-source": "canvas", "aria-label": "Due-task streak" });
            const card = makeElement(documentRef, "div", { className: "apstudy-todo-streak-summary" });
            const mark = makeElement(documentRef, "span", { className: "apstudy-todo-streak-mark", "aria-hidden": "true" });
            append(mark, icon(documentRef, "flame", 17));
            append(card, mark);
            const days = Number.isFinite(Number(streak.current)) ? Math.max(0, Number(streak.current)) : 0;
            const loadingStreak = streak.state === "loading";
            append(card, makeElement(documentRef, "strong", { textContent: loadingStreak ? "…" : streak.state === "unavailable" ? "Unavailable" : `${days} day streak` }));
            const copy = loadingStreak
                ? "Verifying your recent Canvas work."
                : streak.state === "unavailable"
                ? "Canvas could not verify this yet."
                : streak.state === "stale"
                    ? "without missing a due task. Last verified Canvas observation."
                : streak.state === "tracking"
                    ? "Tracking starts after your first due date settles."
                    : "without missing a due task";
            append(card, makeElement(documentRef, "span", { textContent: copy }));
            append(section, card);
            append(rootNode, section);
        }

        function renderFeedback() {
            if (state.settings.todo_hide_feedback === true) return;
            const section = makeElement(documentRef, "section", { className: "apstudy-todo-feedback", "aria-labelledby": "apstudy-todo-feedback-title" });
            append(section, makeElement(documentRef, "h2", { id: "apstudy-todo-feedback-title", textContent: "Recent Feedback" }));
            if (!state.feedback.length) append(section, makeElement(documentRef, "p", { className: "apstudy-todo-empty", textContent: "No recent feedback" }));
            state.feedback.slice(0, 3).forEach((item) => {
                const row = makeElement(documentRef, "div", { className: "apstudy-todo-feedback-row" });
                const href = safeHttpsUrl(item?.url);
                append(row, href ? makeElement(documentRef, "a", { href, textContent: text(item?.title, "Feedback") }) : makeElement(documentRef, "span", { textContent: text(item?.title, "Feedback") }));
                append(row, makeElement(documentRef, "span", { className: "apstudy-todo-feedback-source", textContent: sourceLabel(item) }));
                const score = item?.score || item?.points;
                append(row, makeElement(documentRef, "span", { className: "apstudy-todo-feedback-score", textContent: score ? `${score.earned ?? "—"} out of ${score.possible ?? "—"}` : "Reviewed" }));
                append(section, row);
            });
            const grades = makeElement(documentRef, "button", { type: "button", className: "apstudy-todo-view-grades", "data-action": "open-grades", textContent: "View Grades" });
            on(grades, "click", () => callbacks.onOpenGrades?.());
            append(section, grades);
            append(rootNode, section);
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
                    modalFields.description?.focus?.();
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
                earned: "",
                possible: "",
                stableId: operationId && plannerTasksEnabled() ? text(callbacks.plannerTaskOperationId?.()) : ""
            };
        }

        function isDraftDirty() {
            const current = { ...plainObject(modalDraft), stableId: "" };
            return JSON.stringify(current) !== JSON.stringify(defaultDraft());
        }

        function updateDraft(key, value) { modalDraft = { ...modalDraft, [key]: value }; }

        function fieldError(id, message) {
            return makeElement(documentRef, "span", { className: "apstudy-todo-field-error", id: `apstudy-todo-error-${id}`, role: "alert", textContent: message });
        }

        function modalRow(dialog, key, labelText, iconName, control) {
            const wrapper = makeElement(documentRef, "div", { className: "apstudy-todo-form-row" });
            const id = `apstudy-todo-field-${key}`;
            const label = makeElement(documentRef, "label", { htmlFor: id, className: "apstudy-todo-form-row-label" });
            append(label, icon(documentRef, iconName, 16));
            append(label, makeElement(documentRef, "span", { textContent: labelText }));
            append(wrapper, label);
            append(wrapper, control);
            if (modalErrors[key]) {
                control.setAttribute?.("aria-invalid", "true");
                control.setAttribute?.("aria-describedby", `apstudy-todo-error-${key}`);
                append(wrapper, fieldError(key, modalErrors[key]));
            }
            append(dialog, wrapper);
            modalFields[key] = control;
            return control;
        }

        function modalField(dialog, key, labelText, iconName, type, attributes = {}) {
            const input = makeElement(documentRef, type === "textarea" ? "textarea" : "input", { id: `apstudy-todo-field-${key}`, name: key, type: type === "textarea" ? undefined : type, ...attributes });
            input.value = text(modalDraft[key]);
            on(input, "input", () => updateDraft(key, input.value));
            on(input, "change", () => updateDraft(key, input.value));
            return modalRow(dialog, key, labelText, iconName, input);
        }

        function selectField(dialog, key, labelText, iconName, optionsList) {
            const select = makeElement(documentRef, "select", { id: `apstudy-todo-field-${key}`, name: key });
            optionsList.forEach((optionData) => {
                const option = typeof optionData === "string" ? { value: optionData, label: optionData } : optionData;
                const node = makeElement(documentRef, "option", { value: option.value, textContent: option.label });
                node.selected = String(option.value) === String(modalDraft[key] || "");
                append(select, node);
            });
            on(select, "change", () => updateDraft(key, select.value));
            return modalRow(dialog, key, labelText, iconName, select);
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
            return {
                title: text(draft.title),
                type: text(draft.type, "task"),
                ...(text(draft.description) ? { description: text(draft.description) } : {}),
                ...(safeHttpsUrl(draft.link) ? { link: safeHttpsUrl(draft.link) } : {}),
                ...(draft.dueDate ? { due_date: draft.dueDate } : {}),
                ...(draft.dueDate && draft.dueTime ? { due_at: `${draft.dueDate}T${draft.dueTime}:00` } : {}),
                ...(draft.timezone ? { timezone: draft.timezone } : {}),
                ...(draft.priority ? { priority: draft.priority } : {}),
                ...(draft.courseId ? { canvas_course_id: String(draft.courseId) } : {}),
                ...(draftPoints(draft) ? { points: draftPoints(draft) } : {}),
                idempotency_key: idempotencyKey
            };
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
                modalMessage = "Fix the highlighted fields before creating the task.";
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
                modalStatus = "unavailable";
                renderModal();
                return { ok: false, state: "unavailable", error: { code: "NEST_TRANSPORT_UNAVAILABLE" } };
            }
            modalBusy = true;
            modalMessage = editing ? "Saving in Canvas…" : canvasPlanner ? "Creating in Canvas…" : "Creating in Nest…";
            modalStatus = "saving";
            renderModal();
            const idempotencyKey = `todo-create:${stableHash(JSON.stringify(modalDraft))}`;
            const requestId = `todo-create-request:${++requestSequence}`;
            let result;
            try {
                const payload = canvasPlanner
                    ? { title: modalDraft.title, description: modalDraft.description, link: modalDraft.link, courseId: modalDraft.courseId, todoDate: modalDraft.dueDate, stableId: modalDraft.stableId }
                    : buildNestCreatePayload(modalDraft, idempotencyKey);
                result = editing ? await create(modalTask, payload, { requestId, idempotencyKey }) : await create(payload, { requestId, idempotencyKey });
            } catch (error) {
                result = { ok: false, state: "error", error: { code: error?.code || (canvasPlanner ? "CANVAS_PLANNER_NOTE_CREATE_FAILED" : "NEST_TODO_CREATE_FAILED"), message: error?.message || (canvasPlanner ? "Canvas could not create the task." : "Nest could not create the task.") } };
            }
            modalBusy = false;
            if (!result || result.ok !== true) {
                const signedOut = ["NEST_SIGNED_OUT", "NEST_UNAUTHENTICATED", "UNAUTHENTICATED"].includes(String(result?.error?.code || ""));
                const diagnosticCode = /^[A-Z0-9-]{4,32}$/.test(String(result?.error?.diagnostic || "")) ? result.error.diagnostic : "";
                const diagnosticPhase = ["pre-dispatch", "main-world", "transport"].includes(String(result?.error?.phase || "")) ? result.error.phase : "";
                const diagnostic = diagnosticCode ? ` Diagnostic code: ${diagnosticCode}${diagnosticPhase ? ` (${diagnosticPhase})` : ""}.` : "";
                modalMessage = `${signedOut ? "Nest is signed out. Connect Nest in Calendar & Accounts, then retry." : result?.error?.message || (canvasPlanner ? "Canvas could not create the task." : "Nest could not create the task.")}${diagnostic} Your draft is preserved.`;
                modalStatus = signedOut ? "connect" : result?.state === "outcome-uncertain" ? "uncertain" : result?.state === "unavailable" ? "unavailable" : "error";
                renderModal();
                return result || { ok: false, state: "error" };
            }
            const created = result.task;
            if (created) state.tasks = uniqueById(state.tasks.concat([created]));
            try { callbacks.onTaskCreated?.(result); } catch (error) {}
            modalOpen = false;
            modalTask = null;
            modalDraft = null;
            modalMessage = editing ? "Task updated in Canvas." : canvasPlanner ? "Task created in Canvas." : "Task created in Nest.";
            modalStatus = "idle";
            modalConfirmDiscard = false;
            modalDateMutationBlocked = false;
            detachModalKeydown();
            removeModalNode();
            setLive(editing ? "Task updated in Canvas." : canvasPlanner ? "Task created in Canvas." : "Task created in Nest.");
            restoreFocusAfterModalClose();
            return result;
        }

        function focusFirstModalError() {
            const first = Object.keys(modalErrors)[0];
            if (first && modalFields[first]) modalFields[first].focus?.();
            else modalFields.description?.focus?.();
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
            closeAddTask(true);
        }

        function cancelDiscard() {
            modalConfirmDiscard = false;
            modalErrors = {};
            renderModal();
            modalFields.description?.focus?.();
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
            modalFields.description?.focus?.();
        }

        function openEditTask(task) {
            if (!plannerTasksEnabled() || task?.mutationAuthority !== "canvas_planner_note" || modalOpen) return;
            const draft = plannerDraft(task);
            modalTask = task;
            modalDateMutationBlocked = task?.raw?.planner_note_date_mutation_blocked === true;
            modalOpen = true;
            modalDraft = { ...defaultDraft(), title: text(draft.title || task.title), description: text(draft.description), dueDate: text(draft.todoDate || task?.due?.date), dueTime: "", courseId: text(draft.courseId || task?.course?.id), link: text(draft.link) };
            modalErrors = {}; modalMessage = modalDateMutationBlocked
                ? "Canvas account timezone is unavailable. Reload Canvas before editing or completing this task. You can still delete it."
                : "Edit this APStudyCanvas-owned Canvas task."; modalStatus = modalDateMutationBlocked ? "unavailable" : "idle"; modalConfirmDiscard = false;
            previousFocus = documentRef.activeElement || null;
            on(documentRef, "keydown", modalKeydown);
            renderModal();
            modalFields.title?.focus?.();
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
            removeModalNode();
            if (!modalOpen || !documentRef?.body) return;
            const backdrop = makeElement(documentRef, "div", { className: "apstudy-todo-modal-backdrop", "data-apstudycanvas-owned": "todo-modal" });
            const dialog = makeElement(documentRef, "div", { className: "apstudy-todo-modal", role: "dialog", "aria-modal": "true", "aria-labelledby": "apstudy-todo-modal-title", "aria-describedby": "apstudy-todo-modal-status" });
            modalNode = backdrop;
            modalFields = {};
            append(backdrop, dialog);
            const header = makeElement(documentRef, "header", { className: "apstudy-todo-modal-header" });
            append(header, makeElement(documentRef, "h2", { id: "apstudy-todo-modal-title", textContent: modalTask ? "Edit Canvas task" : "New item" }));
            const close = makeElement(documentRef, "button", { type: "button", className: "apstudy-todo-modal-close", "data-action": "close-add-task", "aria-label": "Close Add Task dialog", title: "Close" });
            on(close, "click", () => closeAddTask());
            append(header, close);
            append(dialog, header);

            if (modalConfirmDiscard) {
                const confirm = makeElement(documentRef, "div", { className: "apstudy-todo-modal-confirm" });
                append(confirm, makeElement(documentRef, "p", { id: "apstudy-todo-modal-status", className: "apstudy-todo-modal-status is-confirm", "aria-live": "polite", textContent: "Do you want to discard this task." }));
                const actions = makeElement(documentRef, "div", { className: "apstudy-todo-modal-actions" });
                const cancel = makeElement(documentRef, "button", { type: "button", className: "apstudy-todo-connect", "data-action": "cancel-discard", textContent: "Cancel" });
                const discard = makeElement(documentRef, "button", { type: "button", className: "apstudy-todo-discard", "data-action": "confirm-discard", textContent: "Discard" });
                on(cancel, "click", cancelDiscard);
                on(discard, "click", discardDraft);
                modalFields.description = cancel;
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

            // BC's "New item" order: description first, then the link pill,
            // then the compact DETAILS rows.
            const description = makeElement(documentRef, "textarea", { id: "apstudy-todo-field-description", name: "description", rows: "4", maxlength: "2000", placeholder: "Description (optional)", "aria-label": "Description (optional)" });
            description.value = text(modalDraft.description);
            on(description, "input", () => updateDraft("description", description.value));
            if (modalErrors.description) {
                description.setAttribute?.("aria-invalid", "true");
                description.setAttribute?.("aria-describedby", "apstudy-todo-error-description");
                append(form, fieldError("description", modalErrors.description));
            }
            modalFields.description = description;
            append(form, description);

            const linkPill = makeElement(documentRef, "div", { className: "apstudy-todo-form-link" });
            append(linkPill, icon(documentRef, "link", 16));
            const linkInput = makeElement(documentRef, "input", { id: "apstudy-todo-field-link", name: "link", type: "url", inputmode: "url", placeholder: "Add a link", "aria-label": "Add a link (optional HTTPS link)", autocomplete: "url" });
            linkInput.value = text(modalDraft.link);
            on(linkInput, "input", () => updateDraft("link", linkInput.value));
            on(linkInput, "change", () => updateDraft("link", linkInput.value));
            if (modalErrors.link) {
                linkInput.setAttribute?.("aria-invalid", "true");
                linkInput.setAttribute?.("aria-describedby", "apstudy-todo-error-link");
                append(form, fieldError("link", modalErrors.link));
            }
            modalFields.link = linkInput;
            append(linkPill, linkInput);
            append(form, linkPill);

            modalField(form, "title", "Title", "sheet", "text", { maxlength: "255", required: "true", "aria-required": "true", placeholder: "Item title", autocomplete: "off" });

            append(form, makeElement(documentRef, "p", { className: "apstudy-todo-form-eyebrow", "aria-hidden": "true", textContent: "Details" }));

            const courses = [{ value: "", label: "No course association" }].concat((plannerTasksEnabled() ? plannerCourses() : state.courses).map((course) => ({ value: String(course.id), label: courseLabel(course) })));
            selectField(form, "courseId", "Course", "book", courses);
            if (!plannerTasksEnabled()) selectField(form, "type", "Type", "note", TYPE_OPTIONS.map((value) => ({ value, label: TYPE_LABELS[value] || value })));

            const dueWrap = makeElement(documentRef, "div", { className: "apstudy-todo-form-due" });
            const dueDate = makeElement(documentRef, "input", { id: "apstudy-todo-field-dueDate", name: "dueDate", type: "date", "aria-label": "Due date" });
            dueDate.value = text(modalDraft.dueDate);
            const dueTime = makeElement(documentRef, "input", { id: "apstudy-todo-field-dueTime", name: "dueTime", type: "time", "aria-label": "Due time" });
            dueTime.value = text(modalDraft.dueTime);
            on(dueDate, "input", () => updateDraft("dueDate", dueDate.value));
            on(dueDate, "change", () => updateDraft("dueDate", dueDate.value));
            on(dueTime, "input", () => updateDraft("dueTime", dueTime.value));
            on(dueTime, "change", () => updateDraft("dueTime", dueTime.value));
            modalFields.dueDate = dueDate;
            modalFields.dueTime = dueTime;
            const dueLabel = makeElement(documentRef, "label", { htmlFor: "apstudy-todo-field-dueDate", className: "apstudy-todo-form-row-label" });
            append(dueLabel, icon(documentRef, "calendar", 16));
            append(dueLabel, makeElement(documentRef, "span", { textContent: "Due Date" }));
            const dueRow = makeElement(documentRef, "div", { className: "apstudy-todo-form-row" });
            append(dueRow, dueLabel);
            append(dueWrap, dueDate);
            append(dueWrap, dueTime);
            if (modalErrors.dueDate || modalErrors.dueTime) {
                const dueError = fieldError(modalErrors.dueDate ? "dueDate" : "dueTime", modalErrors.dueDate || modalErrors.dueTime);
                if (modalErrors.dueDate) dueDate.setAttribute?.("aria-invalid", "true");
                if (modalErrors.dueTime) dueTime.setAttribute?.("aria-invalid", "true");
                dueTime.setAttribute?.("aria-describedby", `apstudy-todo-error-${modalErrors.dueDate ? "dueDate" : "dueTime"}`);
                append(dueRow, dueError);
            }
            append(dueRow, dueWrap);
            append(form, dueRow);

            if (!plannerTasksEnabled()) modalField(form, "timezone", "Timezone", "clock", "text", { autocomplete: "off" });
            const pointsWrap = makeElement(documentRef, "div", { className: "apstudy-todo-form-points" });
            const earned = makeElement(documentRef, "input", { id: "apstudy-todo-field-earned", name: "earned", type: "number", min: "0", step: "any", inputmode: "decimal", placeholder: "--", "aria-label": "Earned points (optional)" });
            earned.value = text(modalDraft.earned);
            const possible = makeElement(documentRef, "input", { id: "apstudy-todo-field-possible", name: "possible", type: "number", min: "0", step: "any", inputmode: "decimal", placeholder: "--", "aria-label": "Possible points (optional)" });
            possible.value = text(modalDraft.possible);
            on(earned, "input", () => updateDraft("earned", earned.value));
            on(possible, "input", () => updateDraft("possible", possible.value));
            modalFields.earned = earned;
            modalFields.possible = possible;
            if (modalErrors.earned || modalErrors.possible) {
                if (modalErrors.earned) earned.setAttribute?.("aria-invalid", "true");
                if (modalErrors.possible) possible.setAttribute?.("aria-invalid", "true");
                append(pointsWrap, fieldError(modalErrors.earned ? "earned" : "possible", modalErrors.earned || modalErrors.possible));
            }
            append(pointsWrap, earned);
            append(pointsWrap, makeElement(documentRef, "span", { className: "apstudy-todo-form-points-slash", "aria-hidden": "true", textContent: "/" }));
            append(pointsWrap, possible);
            const pointsRow = makeElement(documentRef, "div", { className: "apstudy-todo-form-row" });
            const pointsLabel = makeElement(documentRef, "label", { className: "apstudy-todo-form-row-label" });
            append(pointsLabel, icon(documentRef, "star", 16));
            append(pointsLabel, makeElement(documentRef, "span", { textContent: "Points" }));
            append(pointsRow, pointsLabel);
            append(pointsRow, pointsWrap);
            if (!plannerTasksEnabled()) {
                append(form, pointsRow);
                selectField(form, "priority", "Priority", "flag", PRIORITY_OPTIONS.map((value) => ({ value, label: PRIORITY_LABELS[value] || value })));
            }

            const actions = makeElement(documentRef, "div", { className: "apstudy-todo-modal-actions" });
            const connect = makeElement(documentRef, "button", { type: "button", className: "apstudy-todo-connect", "data-action": "connect-nest", textContent: plannerTasksEnabled() ? "Canvas settings" : "Connect Nest" });
            const retry = makeElement(documentRef, "button", { type: "button", className: "apstudy-todo-retry-create", "data-action": "retry-create", textContent: modalStatus === "uncertain" ? "Check Canvas" : "Retry" });
            const submit = makeElement(documentRef, "button", { type: "submit", className: "apstudy-todo-submit", textContent: modalTask ? "Save changes" : "+ Add Task" });
            setDisabled(submit, modalBusy || Boolean(modalTask && modalDateMutationBlocked));
            setDisabled(connect, modalBusy);
            setDisabled(retry, modalBusy || !["error", "unavailable", "connect", "uncertain"].includes(modalStatus));
            on(connect, "click", plannerTasksEnabled() ? () => callbacks.onOpenTodoSettings?.() : connectNest);
            on(retry, "click", submitAddTask);
            append(actions, connect);
            append(actions, retry);
            if (modalTask) {
                const remove = makeElement(documentRef, "button", { type: "button", className: "apstudy-todo-discard", "data-action": "delete-planner-task", textContent: "Delete" });
                setDisabled(remove, modalBusy);
                on(remove, "click", () => deletePlannerTask(modalTask));
                append(actions, remove);
            }
            append(actions, submit);
            append(form, actions);
            append(dialog, form);
            append(documentRef.body, backdrop);
            if (activeFieldKey && modalFields[activeFieldKey]) modalFields[activeFieldKey].focus?.();
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
        function streakSignature() {
            const supplied = plainObject(state.streak);
            if (supplied.source === "nest") return "days:0";
            if (supplied.current === undefined) return `state:${text(supplied.state) || "none"}`;
            const days = Number.isFinite(Number(supplied.current)) ? Math.max(0, Number(supplied.current)) : 0;
            return `days:${days}:${text(supplied.state) || "none"}`;
        }

        function feedbackSignature(item) {
            const score = item?.score || item?.points;
            return {
                title: text(item?.title, "Feedback"),
                url: safeHttpsUrl(item?.url) || "",
                source: text(item?.source),
                course: text(item?.course?.id),
                score: score && typeof score === "object" ? { earned: pointPart(score.earned), possible: pointPart(score.possible) } : null
            };
        }

        function computeRenderSignature() {
            try {
                return JSON.stringify(signatureValue({
                    tasks: array(state.tasks).map(taskSignature),
                    settings: state.settings,
                    range: state.range ? { start: text(state.range.start), end: text(state.range.end), timeZone: text(state.range.timeZone) } : null,
                    courses: array(state.courses).map((course) => [text(course.id), text(course.label), text(course.course?.code), courseColor(course)]),
                    streak: streakSignature(),
                    feedback: array(state.feedback).map(feedbackSignature),
                    calendar: [
                        text(state.calendar?.state || state.calendar?.status || state.calendarConnectionState).toLowerCase(),
                        state.calendar?.syncing === true
                    ],
                    canvasState: text(state.canvasState).toLowerCase(),
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
            clearChildren(rootNode);
            renderStreak();
            renderHeader();
            renderTimeframe();
            renderProgress();
            renderTabs();
            renderGroups();
            renderAddTask();
            renderFeedback();
            effectsLayer = makeElement(documentRef, "div", { className: "apstudy-todo-effects-layer", "data-todo-effects-layer": "true", "aria-hidden": "true" });
            append(rootNode, effectsLayer);
            append(rootNode, makeElement(documentRef, "p", { className: "apstudy-todo-live", role: "status", "aria-live": "polite", "aria-atomic": "true", textContent: state.liveMessage }));
            reattachPreview();
            renderModal();
            renderSignature = computeRenderSignature();
        }

        function bindPreviewKeydown() {
            if (previewKeydown) return;
            previewKeydown = (event) => {
                if (event?.key === "Escape" && !modalOpen && previewFor !== null) hidePreviewNode({ returnFocus: true });
            };
            on(documentRef, "keydown", previewKeydown);
        }

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
            mounted = true;
            bindPreviewKeydown();
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
            if (!mounted) return { ok: true, state: "already-destroyed" };
            lifecycleVersion += 1;
            closeAddTask(true);
            hidePreviewNode();
            if (previewKeydown) {
                documentRef.removeEventListener?.("keydown", previewKeydown);
                previewKeydown = null;
            }
            effects?.destroy?.();
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
        normalizeProgressStyle,
        normalizeSettings,
        normalizeHexColor,
        resolveCourseColors,
        safeHttpsUrl,
        htmlToText,
        formatDue,
        formatRange,
        pointsText,
        progressFromCounts,
        renderProgressGraphic,
        buildNestCreatePayload: (draft, idempotencyKey) => ({
            title: text(draft?.title),
            type: text(draft?.type, "task"),
            ...(text(draft?.description) ? { description: text(draft.description) } : {}),
            ...(safeHttpsUrl(draft?.link) ? { link: safeHttpsUrl(draft.link) } : {}),
            ...(draft?.dueDate ? { due_date: draft.dueDate } : {}),
            ...(draft?.dueDate && draft?.dueTime ? { due_at: `${draft.dueDate}T${draft.dueTime}:00` } : {}),
            ...(draft?.timezone ? { timezone: draft.timezone } : {}),
            ...(draft?.priority ? { priority: draft.priority } : {}),
            ...(draft?.courseId ? { canvas_course_id: String(draft.courseId) } : {}),
            ...(draftPoints(draft) ? { points: draftPoints(draft) } : {}),
            idempotency_key: idempotencyKey
        }),
        create: createTodoRightRail
    });
}));
