(function (root, factory) {
    "use strict";
    const time = root?.APStudyCanvasContent?.TodoTime || (typeof require === "function" ? require("./todo-time.js") : null);
    const api = factory(time);
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasContent = Object.assign(root.APStudyCanvasContent || {}, { TodoState: api });
}(typeof globalThis !== "undefined" ? globalThis : this, function (time) {
    "use strict";

    function cloneTask(task, completion) { return { ...task, completion, raw: task.raw }; }
    function isUndatedNest(task) { return task?.source === "nest" && !task?.due; }
    function isAnnouncement(task) { return task?.type === "announcement"; }
    function isVisible(task) { return !isAnnouncement(task) || task.unread === true; }
    function countsTowardProgress(task) { return !isAnnouncement(task); }
    function dueMs(task) {
        if (task?.due?.kind === "instant") return Date.parse(task.due.utcInstant);
        if (task?.due?.kind === "date") return Date.parse(`${task.due.date}T23:59:59.999Z`);
        return NaN;
    }
    function dueKey(task, zone) { return time.dueDateKey(task?.due, zone); }
    function overdue(task, now, zone) {
        if (!task?.due || task.completion) return false;
        if (task.due.kind === "date") return dueKey(task, zone) < time.localDateKey(now, zone);
        const value = dueMs(task);
        return Number.isFinite(value) && value < new Date(now === undefined ? Date.now() : now).getTime();
    }
    function explicitOrNestMissing(task, now, zone) {
        return !task.completion && ((task.source === "canvas" && task.missing === true) || (task.source === "nest" && overdue(task, now, zone)));
    }

    function classifyTask(task, { now = Date.now(), timeZone } = {}) {
        if (!isVisible(task)) return { bucket: "excluded", reason: "announcement_read", missing: false, overdue: false, undated: false };
        const undated = !task?.due;
        const isMissing = explicitOrNestMissing(task, now, timeZone);
        const isOverdue = overdue(task, now, timeZone);
        if (task?.completion) return { bucket: "completed", missing: false, overdue: false, undated };
        if (isMissing) return { bucket: "missing", missing: true, overdue: isOverdue, undated };
        if (undated) return { bucket: "undated", missing: false, overdue: false, undated: true };
        if (task.submitted && !task.graded) return { bucket: "submitted-ungraded", missing: false, overdue: isOverdue, undated: false };
        if (isOverdue) return { bucket: "overdue", missing: false, overdue: true, undated: false };
        const remaining = dueMs(task) - new Date(now === undefined ? Date.now() : now).getTime();
        if (Number.isFinite(remaining) && remaining <= 86400000) return { bucket: "urgent", missing: false, overdue: false, undated: false };
        if (Number.isFinite(remaining) && remaining <= 3 * 86400000) return { bucket: "soon", missing: false, overdue: false, undated: false };
        return { bucket: "later", missing: false, overdue: false, undated: false };
    }

    // BC-style day-level bucket key for an active task. Pure: returns null for
    // undated tasks so callers can route them to their own trailing group.
    function dayGroupKey(task, { now = Date.now(), timeZone } = {}) {
        if (!task?.due || task.completion) return null;
        const zone = timeZone;
        const dueKey = time.dueDateKey(task.due, zone);
        const todayKey = time.localDateKey(now === undefined ? Date.now() : now, zone);
        if (!dueKey || !todayKey) return null;
        const delta = Math.round((Date.parse(`${dueKey}T00:00:00Z`) - Date.parse(`${todayKey}T00:00:00Z`)) / 86400000);
        if (delta < 0) return "overdue";
        if (delta === 0) return "today";
        if (delta === 1) return "tomorrow";
        if (delta >= 2 && delta <= 4) return `in-${delta}-days`;
        return "later";
    }

    function isPeriodTask(task, range, zone) {
        if (isUndatedNest(task)) return false;
        return time.dueIsInRange(task?.due, range, zone);
    }

    function groupTasks(tasks, { range, now = Date.now(), timeZone } = {}) {
        const missing = [], active = [], completed = [], excluded = [];
        for (const task of Array.isArray(tasks) ? tasks : []) {
            const classification = classifyTask(task, { now, timeZone });
            if (classification.bucket === "excluded") { excluded.push(task); continue; }
            if (classification.missing) { missing.push({ task, classification }); continue; }
            if (task.completion) {
                if (!range || isPeriodTask(task, range, timeZone)) completed.push({ task, classification });
                continue;
            }
            if (isUndatedNest(task) || !range || isPeriodTask(task, range, timeZone)) {
                active.push({ task, classification, group: isUndatedNest(task) ? "No due date" : classification.bucket });
            }
        }
        return { missing, active, completed, excluded, order: ["missing", "active", "completed"] };
    }

    function progress(tasks) {
        const eligible = (Array.isArray(tasks) ? tasks : []).filter((task) => !isUndatedNest(task) && countsTowardProgress(task));
        const completed = eligible.filter((task) => task.completion).length;
        const total = eligible.length;
        return { percentage: total === 0 ? 100 : Math.round(completed * 100 / total), completed, total, label: total === 0 ? "No tasks" : `${completed}/${total}` };
    }

    function periodCounts(tasks, range, timeZone, now = Date.now()) {
        const eligible = (Array.isArray(tasks) ? tasks : []).filter((task) => !isUndatedNest(task) && countsTowardProgress(task) && isPeriodTask(task, range, timeZone));
        return {
            total: eligible.length,
            completed: eligible.filter((task) => task.completion).length,
            incomplete: eligible.filter((task) => !task.completion).length,
            missing: eligible.filter((task) => explicitOrNestMissing(task, now, timeZone)).length
        };
    }

    function streakInput(tasks, timeZone) {
        return (Array.isArray(tasks) ? tasks : []).filter((task) => task.source === "canvas" && !isUndatedNest(task) && !isAnnouncement(task) && task.due && dueKey(task, timeZone));
    }

    function retainCourseFilter(selectedCourseIds, availableCourses, { previousTimeframe, timeframe } = {}) {
        const selected = Array.from(new Set((Array.isArray(selectedCourseIds) ? selectedCourseIds : []).map(String)));
        const available = new Set((Array.isArray(availableCourses) ? availableCourses : []).map((course) => String(course?.id ?? course)));
        if (previousTimeframe !== undefined && previousTimeframe !== timeframe) return { selectedCourseIds: [], retained: false, resetReason: "timeframe_changed" };
        if (selected.some((courseId) => !available.has(courseId))) return { selectedCourseIds: [], retained: false, resetReason: "course_vanished" };
        return { selectedCourseIds: selected, retained: true, resetReason: null };
    }

    function filterByCourses(tasks, selectedCourseIds) {
        const selected = new Set((Array.isArray(selectedCourseIds) ? selectedCourseIds : []).map(String));
        if (!selected.size) return Array.isArray(tasks) ? tasks.slice() : [];
        return (Array.isArray(tasks) ? tasks : []).filter((task) => {
            const courseId = String(task?.course?.id ?? "");
            if (courseId && selected.has(courseId)) return true;
            // Courseless Nest tasks share one synthetic "Personal" course so
            // they remain filterable without inventing Canvas associations.
            return !courseId && task?.source === "nest" && selected.has("nest-personal");
        });
    }

    function applyConfirmedCompletion(task, completed) { return cloneTask(task, completed === true); }

    // Canvas discussion reads are a read-state mutation, not an academic
    // completion: the confirmed task flips unread/readState (and adopts the
    // same excluded visibility a fresh Canvas read would normalize to) while
    // completion stays untouched, so read announcements never leak into the
    // Done tab or progress counts.
    function applyConfirmedAnnouncementRead(task, read) {
        const next = { ...task, unread: read !== true, readState: read === true ? "read" : "unread", raw: task.raw };
        if (read === true) next.visibility = "excluded";
        else delete next.visibility;
        return next;
    }

    return Object.freeze({
        isUndatedNest,
        countsTowardProgress,
        classifyTask,
        dayGroupKey,
        groupTasks,
        progress,
        periodCounts,
        streakInput,
        retainCourseFilter,
        filterByCourses,
        applyConfirmedCompletion,
        applyConfirmedAnnouncementRead
    });
}));
