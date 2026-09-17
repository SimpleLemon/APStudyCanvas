"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync(require("node:path").join(__dirname, "../../js/content.js"), "utf8");
function fn(name) {
    const start = source.indexOf(`function ${name}(`);
    let depth = 0;
    for (let i = source.indexOf("{", start); i < source.length; i++) {
        if (source[i] === "{") depth++;
        if (source[i] === "}" && --depth === 0) return source.slice(start - (source.slice(start - 6, start) === "async " ? 6 : 0), i + 1);
    }
    throw new Error(name);
}
function load(name, context) { return vm.runInNewContext(`(${fn(name)})`, context); }
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
const tick = () => new Promise(r => setImmediate(r));

test("Canvas tasks paint before delayed streak/Nest reads and late cancelled results never paint", async () => {
    const planner = deferred(), nest = deferred(), streak = deferred();
    const paints = [];
    const context = {
        abortRefresh() {}, destroyed: false, enabled: () => true, routeIsSupported: () => true,
        generation: 0, AbortController, refreshAbortController: null, contentContextDead: false,
        settings: () => ({}), rangeOverride: null, todoRefreshRange: () => ({ start: "2026-09-13", end: "2026-09-20" }),
        railMounted: true, resolveBinding: async () => ({ accountKey: "a".repeat(64), origin: "https://canvas.example.edu" }), clearBindingReadiness() {},
        todoCacheContext: () => null, reusableView: () => null, institutionLogo: { restore() {} },
        contentTodoApi: { fetchCanvasPlanner: () => planner.promise, dedupeCanvasTasks: tasks => tasks },
        enrichPlannerAssignmentScores: async items => items, removeRail() {},
        normalizeCanvasItems: async items => ({ tasks: items }), lastView: null,
        canvasTodoApi: { readNestTasks: () => nest.promise }, trackedStreak: () => streak.promise,
        maybeFetchCanvasCustomColors: async () => null, activeAnnouncementContextCodes: () => [],
        displayedRailCourses: () => [], renderCards: view => paints.push(view), render: view => ({ ok: true, view }),
        mergeCanvasCustomColors: courses => courses, canvasCustomColorsFor: () => null,
        contentCalendarOverlayController: null, associateNestTask: task => task,
        lastCourseSignature: "", railCourseSignature: () => ""
    };
    const refresh = load("refresh", context);
    const pending = refresh();
    await tick();
    planner.resolve({ ok: true, state: "live", items: [{ id: "lab", source: "canvas" }] });
    await tick();
    assert.equal(paints.length, 1);
    assert.equal(paints[0].canvasTasks[0].id, "lab", "no dependency on unresolved Nest/streak reads");
    context.generation++;
    nest.resolve({ tasks: [{ id: "late" }] }); streak.resolve({ state: "verified" });
    assert.equal((await pending).state, "stale");
    assert.equal(paints.length, 1);
});

test("DOM hydration repairs cards without restarting an in-flight or recently completed fetch", () => {
    let renders = 0, timers = 0;
    const context = { timer: null, refreshAbortController: {}, lastView: null,
        enabled: () => true, routeIsSupported: () => true, settings: () => ({}),
        render: () => { renders++; }, TODO_ROUTE_REVALIDATE_MS: 60000,
        setTimeout: () => { timers++; return timers; }, clearTimeout() {} };
    const schedule = load("schedule", context);
    for (let i = 0; i < 20; i++) schedule("dashboard-ready");
    assert.equal(timers, 0);
    context.lastView = { now: Date.now() };
    context.refreshAbortController = null;
    schedule("mutation");
    assert.equal(renders, 1);
    assert.equal(timers, 0);
    schedule("card-completed");
    assert.equal(timers, 1, "real task changes still refresh data");
});

test("grades retry transient failures, release failed cache, and share successful reads", async () => {
    let reads = 0;
    const context = { options: { dashboard_grades: true }, grades: null, logError() {},
        fetchPhaseFourGradeAnalyticsCollection: async () => { reads++; if (reads <= 2) throw Error("offline"); return [{ id: 42 }]; } };
    const get = load("getGrades", context);
    await get();
    assert.equal(reads, 2);
    assert.equal(context.grades, null);
    assert.equal((await get())[0].id, 42);
    await get();
    assert.equal(reads, 3);
});

test("an unhydrated first card or absent header cannot hide grades on ready cards", async () => {
    const attributes = new Map();
    const badge = { textContent: "", style: {}, classList: { toggle() {} }, setAttribute: (key, value) => attributes.set(key, value), getAttribute: key => attributes.get(key), removeAttribute: key => attributes.delete(key) };
    const link = { href: "https://canvas.example.edu/courses/42" };
    const ready = { querySelector: selector => selector === ".ic-DashboardCard__link" ? link : selector === ".ic-DashboardCard__header" ? {} : badge };
    const context = { options: { dashboard_grades: true }, grades: Promise.resolve([{ id: 42, enrollments: [{ type: "teacher" }, { type: "student", computed_current_score: 96 }] }]),
        document: { querySelectorAll: () => [{ querySelector: () => null }, { querySelector: selector => selector === ".ic-DashboardCard__link" ? link : null }, ready] },
        domain: "https://canvas.example.edu", contentCardAppearanceApi: { canvasCourseLocation: href => href ? { courseId: "42" } : null, courseDestination: () => ({ href: "https://canvas.example.edu/courses/42/grades" }) }, logError: error => { throw error; } };
    load("insertGrades", context)();
    await tick();
    assert.equal(badge.textContent, "96%");
    assert.equal(badge.style.display, "block");
});

test("course-card to-do controls live in Course Cards and remain enabled by default", () => {
    const html = fs.readFileSync(require("node:path").join(__dirname, "../../html/popup.html"), "utf8");
    const section = html.slice(html.indexOf('id="workspace-section-course-cards"'), html.indexOf('id="workspace-section-study-tools"'));
    for (const key of ["todo_course_card_tasks_enabled", "todo_card_max", "todo_card_sort", "todo_hide_completed"]) assert.ok(section.includes(`data-popup-setting="${key}"`));
    assert.equal(require("../../js/settings-schema.js").todoSettingsDefaults.todo_course_card_tasks_enabled, true);
});


test("Course Cards has one grouped shared limit and automatic legacy fallback", () => {
    const schema = require("../../js/settings-schema.js");
    const html = fs.readFileSync(require("node:path").join(__dirname, "../../html/popup.html"), "utf8");
    const section = html.slice(html.indexOf('id="workspace-section-course-cards"'), html.indexOf('id="workspace-section-study-tools"'));
    assert.doesNotMatch(section, /data-popup-setting="(?:assignments_due|num_assignments)"|Course-card task limit/);
    assert.match(section, /Due assignments<\/p>\s*<div class="workspace-control-grid">/);
    assert.deepEqual(schema.todoLegacyCompatibilityChanges("todo_card_max", 7), { num_todo_items: 7, num_assignments: 7 });
    assert.deepEqual(schema.courseCardTaskExclusivityChanges("todo_course_card_tasks_enabled", false), { assignments_due: true });
    assert.equal(schema.todoSettingsDefaults.todo_card_sort, "due-date");
    assert.equal(schema.migrateTodoSettings({ todo_card_sort: "urgency-balanced" }).settings.todo_card_sort, "urgency-balanced", "saved choices remain intact");
});
