"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const time = require("../../js/content/todo-time.js");
const model = require("../../js/content/todo-model.js");
const state = require("../../js/content/todo-state.js");
const todoApi = require("../../js/content/todo-api.js");

const ORIGIN = "https://canvas.example.edu";
const USER_ID = 123;
const ACCOUNT = "82b43931e4cb7ecd230c97a5c65c002dcc3016797b3ba873250686e01bec321e";

function canvasItem(type, overrides = {}) {
    const base = {
        id: 101,
        course_id: 42,
        name: "Read chapter 1",
        title: "Read chapter 1",
        due_at: "2026-09-01T23:59:00-04:00",
        html_url: `${ORIGIN}/courses/42/assignments/101`,
        submission: { submitted_at: null, grade: null },
        planner_override: { marked_complete: false },
        ...overrides
    };
    if (type === "quiz") return { ...base, title: "Unit quiz", html_url: `${ORIGIN}/courses/42/quizzes/101`, ...overrides };
    if (type === "discussion_topic" || type === "discussion") return { ...base, title: "Discuss", message: "Say hello", html_url: `${ORIGIN}/courses/42/discussion_topics/101`, assignment: { due_at: base.due_at }, ...overrides };
    if (type === "announcement") return { ...base, title: "Announcement", topic_type: "announcement", html_url: `${ORIGIN}/courses/42/discussion_topics/101`, ...overrides };
    if (type === "calendar_event" || type === "calendar") return { ...base, title: "Office hours", context_code: "course_42", start_at: base.due_at, end_at: "2026-09-02T00:59:00-04:00", html_url: `${ORIGIN}/calendar?event_id=101`, all_day: false, ...overrides };
    if (type === "planner_note") return { ...base, title: "Study block", todo_date: "2026-09-02", html_url: `${ORIGIN}/planner_notes/101`, ...overrides };
    return base;
}

async function normalizeCanvas(type, item, extra = {}) {
    const result = await model.normalizeCanvasTask(type, item, { origin: ORIGIN, userId: USER_ID, forceFallback: true, ...extra });
    assert.equal(result.ok, true, result.code);
    return result.task;
}

function nestTask(overrides = {}) {
    return { id: "nest-1", title: "Personal review", due_at: "2026-09-03T12:00:00Z", completed: false, ...overrides };
}

function headers(link = "") {
    return { get(name) { return String(name).toLowerCase() === "link" ? link : null; } };
}

test("Canvas identities are stable, source-aware, and retain the adapter event-ref pattern", async () => {
    const first = await normalizeCanvas("assignment", canvasItem("assignment"));
    const changed = await normalizeCanvas("assignment", canvasItem("assignment", { name: "A renamed assignment", due_at: "2026-09-04T23:59:00-04:00" }));
    const otherType = await normalizeCanvas("quiz", canvasItem("quiz"));
    const otherCourse = await normalizeCanvas("assignment", canvasItem("assignment", { course_id: 43 }));
    const otherAccount = await normalizeCanvas("assignment", canvasItem("assignment"), { accountKey: "f".repeat(64) });
    assert.match(first.id, /^canvas:[a-f0-9]{64}:[a-f0-9]{64}$/);
    assert.equal(first.id, changed.id, "content edits do not change the stable source identity");
    assert.notEqual(first.id, otherType.id);
    assert.notEqual(first.id, otherCourse.id);
    assert.notEqual(first.id, otherAccount.id);
    assert.equal(first.sourceItemKey, changed.sourceItemKey);
    assert.equal(first.mutation.submitAssignment, false);
});

test("all Canvas source families normalize into one renderer-neutral task shape", async () => {
    const tasks = await Promise.all([
        normalizeCanvas("assignment", canvasItem("assignment")),
        normalizeCanvas("quiz", canvasItem("quiz")),
        normalizeCanvas("discussion_topic", canvasItem("discussion_topic")),
        normalizeCanvas("announcement", canvasItem("announcement", { unread: true })),
        normalizeCanvas("calendar_event", canvasItem("calendar_event")),
        normalizeCanvas("planner_note", canvasItem("planner_note"))
    ]);
    assert.deepEqual(tasks.map((task) => task.type), ["assignment", "quiz", "discussion", "announcement", "calendar", "planner_note"]);
    for (const task of tasks) {
        assert.equal(task.source, "canvas");
        assert.equal(task.accountKey, ACCOUNT);
        assert.equal(typeof task.title, "string");
        assert.equal(task.course.id, task.type === "calendar" ? "42" : "42");
        assert.ok(task.due);
        assert.equal(task.timezone, "America/New_York");
        assert.ok(Object.hasOwn(task, "points"));
        assert.ok(Object.hasOwn(task, "priority"));
        assert.ok(Object.hasOwn(task, "submitted"));
        assert.ok(Object.hasOwn(task, "graded"));
        assert.ok(Object.hasOwn(task, "missing"));
        assert.ok(Object.hasOwn(task, "unread"));
        assert.equal(task.mutationAuthority, task.type === "announcement" ? "canvas_announcement_read" : task.type === "planner_note" ? null : "canvas_planner_override");
    }
    assert.equal(tasks[3].unread, true);
    assert.equal(tasks[3].mutation.authority, "canvas_announcement_read", "announcements own a Canvas read-state mutation, not a planner override");
});

test("Canvas state normalization uses positive Canvas submission signals for Done while retaining show-ready status", async () => {
    const submitted = await normalizeCanvas("assignment", canvasItem("assignment", { submission: { submitted_at: "2026-08-31T12:00:00Z", score: 8, grade: null } }));
    assert.equal(submitted.submitted, true);
    assert.equal(submitted.graded, false, "a score is not a posted grade");
    assert.equal(submitted.completion, true);
    assert.equal(state.classifyTask(submitted, { now: Date.parse("2026-08-30T12:00:00Z") }).bucket, "completed");

    const graded = await normalizeCanvas("assignment", canvasItem("assignment", { submission: { submitted_at: "2026-08-31T12:00:00Z", grade: "A-" } }));
    assert.equal(graded.graded, true);
    const needsGrading = await normalizeCanvas("assignment", canvasItem("assignment", { submission: { workflow_state: "needs_grading" } }));
    assert.equal(needsGrading.needsGrading, true);
    assert.equal(needsGrading.completion, true);
    const pendingReview = await normalizeCanvas("assignment", canvasItem("assignment", { submission: { workflow_state: "pending_review" } }));
    assert.equal(pendingReview.completion, true);
    const missing = await normalizeCanvas("assignment", canvasItem("assignment", { missing: true }));
    assert.equal(missing.missing, true);
    assert.equal(missing.completion, false, "a missing-only item is not done");
    const plannerSummarySubmitted = await normalizeCanvas("assignment", canvasItem("assignment", { submission: {}, submissions: { submitted: true, late: true, missing: true } }));
    assert.equal(plannerSummarySubmitted.completion, true, "Canvas planner submitted summaries are Done");
    assert.equal(plannerSummarySubmitted.late, true);
    const plannerSummaryGraded = await normalizeCanvas("assignment", canvasItem("assignment", { submission: {}, submissions: { graded: true } }));
    assert.equal(plannerSummaryGraded.completion, true, "Canvas planner graded summaries are Done");
    const excused = await normalizeCanvas("assignment", canvasItem("assignment", { submission: {}, submissions: { excused: true } }));
    assert.equal(excused.completion, true, "an explicitly excused Canvas item cannot remain active");
    const override = await normalizeCanvas("assignment", canvasItem("assignment", { submission: {}, planner_override: { id: 9, marked_complete: true } }));
    assert.equal(override.completion, true);
    const unread = await normalizeCanvas("announcement", canvasItem("announcement", { read: false }));
    const read = await normalizeCanvas("announcement", canvasItem("announcement", { read: true }));
    const unknown = await normalizeCanvas("announcement", canvasItem("announcement", { read: undefined, unread: undefined, read_state: undefined }));
    assert.equal(unread.unread, true);
    assert.equal(read.visibility, "excluded");
    assert.equal(unknown.readState, "unknown");
    assert.equal(unknown.unread, false, "missing announcement read state is not silently unread");
    assert.equal(unknown.visibility, "excluded");
});

test("Planner course context keeps a full label, preferred code, and color", async () => {
    const task = await normalizeCanvas("assignment", canvasItem("assignment", {
        context_code: "course_42", context_name: "Biology 101 — Fall 2026", course_code: "BIOL 101", course_color: "#204c8c"
    }));
    assert.deepEqual(task.course, { id: "42", name: "Biology 101 — Fall 2026", code: "BIOL 101", label: "BIOL 101", fullLabel: "Biology 101 — Fall 2026", color: "#204c8c" });
});

test("Nest tasks have stable account-scoped identities and undated tasks remain visible", () => {
    const first = model.normalizeNestTask(nestTask(), { accountKey: ACCOUNT, timeZone: "America/New_York" }).task;
    const changed = model.normalizeNestTask(nestTask({ title: "Renamed" }), { accountKey: ACCOUNT, timeZone: "America/New_York" }).task;
    const otherAccount = model.normalizeNestTask(nestTask(), { accountKey: "nest-user-2", timeZone: "America/New_York" }).task;
    const undated = model.normalizeNestTask(nestTask({ id: "undated", due_at: null }), { accountKey: ACCOUNT }).task;
    assert.equal(first.id, changed.id);
    assert.notEqual(first.id, otherAccount.id);
    assert.match(first.id, /^nest:/);
    assert.equal(undated.due, null);
    assert.equal(undated.mutationAuthority, "nest");
});

test("time ranges are inclusive, bounded, and shift by their exact length across DST", () => {
    const custom = time.buildRange({ timeframe: "custom", customStart: "2026-03-07", customEnd: "2026-03-09", timeZone: "America/New_York" });
    assert.equal(custom.ok, true);
    assert.equal(custom.value.length, 3);
    assert.equal(custom.value.inclusive, true);
    assert.deepEqual(time.shiftRange(custom.value, 1).value, { ...custom.value, start: "2026-03-10", end: "2026-03-12", length: 3, inclusive: true });
    assert.deepEqual(time.shiftRange(custom.value, -1).value.start, "2026-03-04");
    assert.equal(time.buildRange({ timeframe: "custom", customStart: "2026-01-01", customEnd: "2026-04-01" }).code, "TODO_CUSTOM_RANGE_LIMIT");
    assert.equal(time.buildRange({ timeframe: "custom", customStart: "2026-04-01", customEnd: "2026-03-01" }).code, "TODO_CUSTOM_RANGE_INVALID");
    assert.equal(time.resolveTimeZone("not/a-zone", "America/New_York"), "America/New_York");
    assert.equal(time.localDateKey("2026-03-08T04:30:00Z", "America/New_York"), "2026-03-07");
    assert.equal(time.localDateKey("2026-03-08T05:30:00Z", "America/New_York"), "2026-03-08");
    assert.equal(time.localDateKey("2026-11-01T05:30:00Z", "America/New_York"), "2026-11-01");
    assert.equal(time.localDateKey("2026-11-01T06:30:00Z", "America/New_York"), "2026-11-01");
});

test("urgency boundaries and missing rules remain strict", async () => {
    const now = Date.parse("2026-09-01T12:00:00Z");
    const due = async (hours, source = "canvas") => {
        const base = { ...canvasItem("assignment"), due_at: new Date(now + hours * 3600000).toISOString() };
        return source === "canvas" ? normalizeCanvas("assignment", base) : model.normalizeNestTask({ id: `nest-${hours}`, title: "Nest", due_at: base.due_at }, { accountKey: ACCOUNT }).task;
    };
    assert.equal(state.classifyTask(await due(24), { now }).bucket, "urgent");
    assert.equal(state.classifyTask(await due(24.001), { now }).bucket, "soon");
    assert.equal(state.classifyTask(await due(72), { now }).bucket, "soon");
    assert.equal(state.classifyTask(await due(72.001), { now }).bucket, "later");
    assert.equal(state.classifyTask(await due(-1), { now }).bucket, "overdue");
    const nestOverdue = await due(-1, "nest");
    assert.equal(state.classifyTask(nestOverdue, { now }).missing, true);
    const nestFlaggedButNotOverdue = model.normalizeNestTask({ id: "nest-flagged", title: "Nest", due_at: new Date(now + 24 * 3600000).toISOString(), missing: true }, { accountKey: ACCOUNT }).task;
    assert.equal(state.classifyTask(nestFlaggedButNotOverdue, { now }).missing, false);
    const explicitCanvas = await normalizeCanvas("assignment", canvasItem("assignment", { missing: true, due_at: new Date(now + 72 * 3600000).toISOString() }));
    assert.equal(state.classifyTask(explicitCanvas, { now }).bucket, "missing");
});

test("missing tasks are retained in a leading in-progress group and unread announcements are the only visible announcements", async () => {
    const missing = await normalizeCanvas("assignment", canvasItem("assignment", { id: 1, missing: true }));
    const active = await normalizeCanvas("assignment", canvasItem("assignment", { id: 2, due_at: "2026-09-02T12:00:00Z" }));
    const done = await normalizeCanvas("assignment", canvasItem("assignment", { id: 3, submission: { submitted_at: "2026-08-01T00:00:00Z" } }));
    const unread = await normalizeCanvas("announcement", canvasItem("announcement", { id: 4, unread: true }));
    const read = await normalizeCanvas("announcement", canvasItem("announcement", { id: 5, unread: false, read: true }));
    const grouped = state.groupTasks([missing, active, done, unread, read], { range: { start: "2026-09-01", end: "2026-09-04" }, now: Date.parse("2026-09-01T12:00:00Z") });
    assert.equal(grouped.order[0], "missing");
    assert.equal(grouped.missing.length, 1);
    assert.equal(grouped.missing[0].task.completion, false);
    assert.ok(grouped.active.some((entry) => entry.task.id === active.id));
    assert.ok(grouped.active.some((entry) => entry.task.id === unread.id));
    assert.equal(grouped.excluded.length, 1);
    assert.equal(grouped.excluded[0].id, read.id);
    assert.deepEqual(state.progress([unread, read]), { percentage: 100, completed: 0, total: 0, label: "No tasks" }, "announcements never affect task progress");
    assert.equal(state.streakInput([unread, read]).length, 0, "announcements never enter streak settlement");
});

test("undated Nest tasks are active under No due date but excluded from percentage, missing, urgency, streak, and period counts", () => {
    const undated = model.normalizeNestTask(nestTask({ id: "undated", due_at: null }), { accountKey: ACCOUNT }).task;
    const canvas = { id: "canvas-task", source: "canvas", type: "assignment", completion: true, missing: false, unread: false, due: { kind: "date", date: "2026-09-02", timeZone: "UTC" }, course: { id: "42" } };
    const grouped = state.groupTasks([undated, canvas], { range: { start: "2026-09-01", end: "2026-09-01" }, now: Date.parse("2026-09-01T12:00:00Z") });
    assert.equal(grouped.active.length, 1);
    assert.equal(grouped.active[0].group, "No due date");
    assert.deepEqual(state.progress([undated]), { percentage: 100, completed: 0, total: 0, label: "No tasks" });
    assert.deepEqual(state.periodCounts([undated], { start: "2026-09-01", end: "2026-09-30" }), { total: 0, completed: 0, incomplete: 0, missing: 0 });
    assert.equal(state.streakInput([undated]).length, 0);
});

test("progress handles empty results and streak input excludes Nest without retaining the old backward streak scan", () => {
    assert.deepEqual(state.progress([]), { percentage: 100, completed: 0, total: 0, label: "No tasks" });
    const nest = { id: "nest", source: "nest", type: "assignment", due: { kind: "date", date: "2026-08-31", timeZone: "UTC" }, completion: false, missing: false, unread: false };
    assert.equal(typeof state.streak, "undefined", "the range-coupled backward scan cannot be called by the rail");
    assert.equal(state.streakInput([nest]).length, 0);
});

test("course filters persist on refresh and reset on timeframe changes or vanished courses", () => {
    assert.deepEqual(state.retainCourseFilter(["42"], [{ id: 42 }, { id: 43 }], { previousTimeframe: "week", timeframe: "week" }), { selectedCourseIds: ["42"], retained: true, resetReason: null });
    assert.equal(state.retainCourseFilter(["42"], [{ id: 42 }], { previousTimeframe: "week", timeframe: "month" }).resetReason, "timeframe_changed");
    assert.equal(state.retainCourseFilter(["42"], [{ id: 43 }], { previousTimeframe: "week", timeframe: "week" }).resetReason, "course_vanished");
    assert.equal(state.filterByCourses([{ course: { id: 42 } }, { course: { id: 43 } }], ["42"]).length, 1);
});

test("Canvas planner fetch uses a bounded inclusive window, validates pages, and safely deduplicates", async () => {
    const calls = [];
    const result = await todoApi.fetchCanvasPlanner({
        origin: ORIGIN,
        range: { start: "2026-09-01", end: "2026-09-03" },
        fetchImpl: async (url) => {
            calls.push(url);
            const page = new URL(url).searchParams.get("page");
            return {
                status: 200,
                headers: headers(page ? "" : `<${ORIGIN}/api/v1/planner/items?start_date=2026-09-01&end_date=2026-09-03&per_page=100&page=2>; rel="next"`),
                async json() { return page ? [{ plannable_type: "assignment", plannable_id: 1, course_id: 42, plannable_date: "2026-09-02" }, { plannable_type: "assignment", plannable_id: 2, course_id: 42, plannable_date: "2026-09-03" }] : [{ plannable_type: "assignment", plannable_id: 1, course_id: 42, plannable_date: "2026-09-02" }]; }
            };
        }
    });
    assert.equal(result.ok, true);
    assert.equal(result.items.length, 2);
    assert.match(calls[0], /start_date=2026-09-01/);
    assert.match(calls[0], /end_date=2026-09-03/);
    assert.ok(calls.length > 0 && calls.every((url) => url.includes("include%5B%5D=submissions")), "every planner page requests real submission state (Canvas otherwise ships a literal submissions:false placeholder)");
    const malformed = await todoApi.fetchCanvasPlanner({ origin: ORIGIN, range: { start: "2026-09-01", end: "2026-09-91" }, fetchImpl: async () => { throw new Error("must not call"); } });
    assert.equal(malformed.ok, false);
    const escaped = await todoApi.fetchCanvasPlanner({ origin: ORIGIN, range: { start: "2026-09-01", end: "2026-09-03" }, fetchImpl: async () => ({ status: 200, headers: headers(`<https://evil.example/api/v1/planner/items?start_date=2026-09-01&end_date=2026-09-03>; rel="next"`), async json() { return []; } }) });
    assert.equal(escaped.error.code, "CANVAS_PLANNER_LINK_INVALID");
});

test("planner abort signal reaches every planner page request", async () => {
    const controller = new AbortController();
    const inits = [];
    const result = await todoApi.fetchCanvasPlanner({
        origin: ORIGIN,
        range: { start: "2026-09-01", end: "2026-09-03" },
        signal: controller.signal,
        fetchImpl: async (url, init) => {
            inits.push(init);
            return { status: 200, headers: headers(inits.length === 1 ? `<${ORIGIN}/api/v1/planner/items?start_date=2026-09-01&end_date=2026-09-03&per_page=100&page=2>; rel="next"` : ""), async json() { return [{ plannable_type: "assignment", plannable_id: 1, course_id: 42, plannable_date: "2026-09-02" }]; } };
        }
    });
    assert.equal(result.ok, true);
    assert.equal(inits.length, 3);
    for (const init of inits) assert.equal(init.signal, controller.signal);
});

test("a pre-aborted planner request performs no fetch and rejects AbortError", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    await assert.rejects(
        todoApi.fetchCanvasPlanner({
            origin: ORIGIN,
            range: { start: "2026-09-01", end: "2026-09-03" },
            signal: controller.signal,
            fetchImpl: async () => { calls += 1; return { status: 200, headers: headers(""), async json() { return []; } }; }
        }),
        (error) => error.name === "AbortError"
    );
    assert.equal(calls, 0);
});

test("aborting mid-pagination stops additional pages and rejects AbortError unchanged", async () => {
    const controller = new AbortController();
    const urls = [];
    await assert.rejects(
        todoApi.fetchCanvasPlanner({
            origin: ORIGIN,
            range: { start: "2026-09-01", end: "2026-09-03" },
            signal: controller.signal,
            fetchImpl: async (url) => {
                urls.push(url);
                const next = `<${ORIGIN}/api/v1/planner/items?start_date=2026-09-01&end_date=2026-09-03&per_page=100&page=${urls.length + 1}>; rel="next"`;
                if (urls.length === 1) return { status: 200, headers: headers(next), async json() { return [{ plannable_type: "assignment", plannable_id: 1, course_id: 42, plannable_date: "2026-09-02" }]; } };
                controller.abort();
                return { status: 200, headers: headers(next), async json() { return []; } };
            }
        }),
        (error) => error.name === "AbortError"
    );
    assert.equal(urls.length, 2, "no page is fetched after the abort");

    const fetchAbort = Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
    await assert.rejects(
        todoApi.fetchCanvasPlanner({
            origin: ORIGIN,
            range: { start: "2026-09-01", end: "2026-09-03" },
            signal: new AbortController().signal,
            fetchImpl: async () => { throw fetchAbort; }
        }),
        (error) => error === fetchAbort
    );
});

test("unrelated planner HTTP and parse failures retain their existing error shape", async () => {
    const controller = new AbortController();
    const http = await todoApi.fetchCanvasPlanner({ origin: ORIGIN, range: { start: "2026-09-01", end: "2026-09-03" }, signal: controller.signal, fetchImpl: async () => ({ status: 503, headers: headers(""), async json() { return []; } }) });
    assert.equal(http.ok, false);
    assert.equal(http.state, "partial");
    assert.equal(http.partial, true);
    assert.equal(http.error.code, "CANVAS_PLANNER_HTTP_ERROR");
    assert.equal(http.error.status, 503);

    const parse = await todoApi.fetchCanvasPlanner({ origin: ORIGIN, range: { start: "2026-09-01", end: "2026-09-03" }, signal: controller.signal, fetchImpl: async () => ({ status: 200, headers: headers(""), async json() { return { not: "an array" }; } }) });
    assert.equal(parse.ok, false);
    assert.equal(parse.error.code, "CANVAS_PLANNER_RESPONSE_MALFORMED");

    const thrown = await todoApi.fetchCanvasPlanner({ origin: ORIGIN, range: { start: "2026-09-01", end: "2026-09-03" }, fetchImpl: async () => { throw new Error("socket down"); } });
    assert.equal(thrown.ok, false);
    assert.equal(thrown.error.code, "CANVAS_PLANNER_READ_FAILED");
});

test("old planner callers without abort options remain unchanged", async () => {
    const inits = [];
    const result = await todoApi.fetchCanvasPlanner({
        origin: ORIGIN,
        range: { start: "2026-09-01", end: "2026-09-03" },
        fetchImpl: async (url, init) => {
            inits.push(init);
            return { status: 200, headers: headers(""), async json() { return [{ plannable_type: "assignment", plannable_id: 7, course_id: 42, plannable_date: "2026-09-02" }]; } };
        }
    });
    assert.equal(result.ok, true);
    assert.equal(result.pages, 2);
    assert.equal(result.items.length, 1);
    assert.equal(inits.length, 2);
    assert.equal(inits[0].signal, undefined);
});

test("Planner merges dual feeds by immutable plannable identity and preserves richer completion metadata", async () => {
    const result = await todoApi.fetchCanvasPlanner({
        origin: ORIGIN, range: { start: "2026-09-01", end: "2026-09-03" },
        fetchImpl: async (url) => ({ status: 200, headers: headers(""), async json() {
            return new URL(url).searchParams.get("filter") === "completed"
                ? [{ id: 800, plannable_id: 8, plannable_type: "assignment", course_id: 42, plannable_date: "2026-09-03", title: "Completed copy", submissions: { graded: true } }]
                : [{ id: 7, plannable_id: 7, plannable_type: "assignment", course_id: 42, plannable_date: "2026-09-01" }, { id: 8, plannable_id: 8, plannable_type: "assignment", course_id: 42, plannable_date: "2026-09-02", title: "Active copy", submissions: { missing: true } }, { id: 999, plannable_type: "assignment", course_id: 42, plannable_date: "2026-09-02" }];
        } })
    });
    assert.equal(result.ok, true);
    assert.equal(result.complete, true);
    assert.deepEqual(result.items.map((item) => item.plannable_id), [7, 8]);
    const completed = await normalizeCanvas("assignment", result.items[1]);
    assert.equal(completed.completion, true, "complete-feed records reach normalized Done state");
    assert.equal(completed.graded, true);
    assert.equal(completed.missing, false, "a completion observation supersedes stale missing metadata");
    assert.equal(result.items[1].plannable_date, "2026-09-03", "date changes do not produce a duplicate identity");
    assert.equal(todoApi.plannerItemKey({ id: 9, plannable_type: "assignment" }), null, "planner row ids are not plannable identities");
});

test("announcement reads batch contexts, paginate, retain unread plus recent read, and report partial truthfully", async () => {
    const controller = new AbortController();
    const calls = [];
    const result = await todoApi.fetchCanvasAnnouncements({
        origin: ORIGIN, contextCodes: ["course_42", "course_43"], signal: controller.signal, now: Date.parse("2026-09-15T12:00:00Z"),
        fetchImpl: async (url, init) => {
            calls.push({ url, init });
            const page = new URL(url).searchParams.get("page");
            return { status: 200, headers: headers(page ? "" : `<${ORIGIN}/api/v1/announcements?page=2>; rel=next`), async json() {
                return page ? [{ id: 2, context_code: "course_42", title: "Recent read", posted_at: "2026-09-10T12:00:00Z", read_state: "read", author: { display_name: "Prof" }, html_url: `${ORIGIN}/courses/42/discussion_topics/2` }]
                    : [{ id: 1, context_code: "course_42", title: "Unread", posted_at: "2026-01-01T12:00:00Z", read_state: "unread" }, { id: 2, context_code: "course_42", title: "Duplicate", posted_at: "2026-09-10T12:00:00Z", read_state: "read", author: { display_name: "Prof" }, html_url: `${ORIGIN}/courses/42/discussion_topics/2` }, { id: 3, context_code: "course_43", title: "Old read", posted_at: "2026-08-01T12:00:00Z", read_state: "read" }];
            } };
        }
    });
    assert.equal(result.ok, true);
    assert.equal(result.items.length, 2);
    assert.deepEqual(result.items.map((item) => item.id), [1, 2]);
    assert.equal(result.items[1].author.display_name, "Prof");
    assert.equal(calls.length, 2);
    calls.forEach(({ init }) => assert.equal(init.signal, controller.signal));

    const unknown = await todoApi.fetchCanvasAnnouncements({
        origin: ORIGIN, contextCodes: ["course_42"], now: Date.parse("2026-09-15T12:00:00Z"),
        fetchImpl: async () => ({ status: 200, headers: headers(""), async json() { return [{ id: 4, context_code: "course_42", posted_at: "2026-01-01T00:00:00Z" }, { id: 5, context_code: "course_42", posted_at: "2026-09-14T00:00:00Z" }]; } })
    });
    assert.deepEqual(unknown.items.map((item) => item.id), [5], "unknown read state is capped as a recent non-unread tail");
    assert.equal(todoApi.announcementReadState(unknown.items[0]), "unknown");

    const partial = await todoApi.fetchCanvasAnnouncements({ origin: ORIGIN, contextCodes: ["course_42"], maxPages: 1, fetchImpl: async () => ({ status: 200, headers: headers(`<${ORIGIN}/api/v1/announcements?page=2>; rel=next`), async json() { return []; } }) });
    assert.equal(partial.state, "partial");
    assert.equal(partial.truncated, true);
    controller.abort();
    await assert.rejects(todoApi.fetchCanvasAnnouncements({ origin: ORIGIN, contextCodes: ["course_42"], signal: controller.signal }), /aborted/i);
});

test("Nest reads paginate, deduplicate, and return only an in-memory stale read-only fallback", async () => {
    let calls = 0;
    const api = todoApi.createTodoApi({ nest: { todos: { async list(query) { calls += 1; if (calls === 1) return { ok: true, status: 200, body: { todos: [nestTask({ id: "1" })], has_more: true } }; if (calls === 2) return { ok: true, status: 200, body: { todos: [nestTask({ id: "1" }), nestTask({ id: "2" })] } }; throw Object.assign(new Error("offline"), { code: "NEST_OFFLINE" }); } } } });
    const live = await api.readNestTasks({ completed: false }, { requestId: "read-1" });
    assert.equal(live.ok, true);
    assert.equal(live.tasks.length, 2);
    const stale = await api.readNestTasks({}, { requestId: "read-2" });
    assert.equal(stale.ok, false);
    assert.equal(stale.state, "stale");
    assert.equal(stale.readOnly, true);
    assert.equal(stale.stale, true);
    assert.equal(stale.tasks.length, 2);
    const noFallback = await todoApi.createTodoApi({ nest: { todos: { async list() { return { ok: false, status: 503, body: { error: { code: "unavailable", message: "Try later" } } }; } } } }).readNestTasks();
    assert.equal(noFallback.state, "unavailable");
});

test("Nest create payload and completion preserve idempotency and status/error semantics", async () => {
    const task = model.normalizeNestTask(nestTask(), { accountKey: ACCOUNT }).task;
    const payload = todoApi.buildNestCreatePayload(task, { idempotencyKey: "idem-1" });
    assert.equal(payload.idempotency_key, "idem-1");
    assert.equal(payload.source_identity.account_key, ACCOUNT);
    let createOptions;
    let completionOptions;
    const api = todoApi.createTodoApi({ nest: { todos: {
        async create(value, options) { createOptions = { value, options }; return { ok: true, status: 201, body: { todo: nestTask({ id: "created" }), idempotent: false } }; },
        async setCompletion(id, value, options) { completionOptions = { id, value, options }; return { ok: true, status: 200, body: { todo: nestTask({ id, completed: true }) } }; }
    } } });
    const created = await api.createNestTask(payload, { requestId: "create-1", idempotencyKey: "idem-1", accountKey: ACCOUNT });
    assert.equal(created.status, 201);
    assert.equal(createOptions.options.idempotencyKey, "idem-1");
    const completed = await api.dispatchCompletion(task, true, { requestId: "complete-1", idempotencyKey: "idem-2" });
    assert.equal(completed.ok, true);
    assert.equal(completed.task.completion, true);
    assert.deepEqual(completionOptions, { id: "nest-1", value: { completed: true }, options: { requestId: "complete-1", idempotencyKey: "idem-2" } });
});

test("completion authorities mutate only their own authority and update state only after confirmed success", async () => {
    const canvasTask = await normalizeCanvas("assignment", canvasItem("assignment"));
    const calls = [];
    const canvasApi = todoApi.createTodoApi({ canvas: { async writePlannerOverride(task, payload) { calls.push(["canvas", task, payload]); return { ok: true, status: 200, body: { marked_complete: true } }; } } });
    const canvasDone = await canvasApi.dispatchCompletion(canvasTask, true);
    assert.equal(canvasDone.ok, true);
    assert.equal(canvasDone.task.completion, true);
    assert.deepEqual(calls.map((call) => call[0]), ["canvas"]);
    assert.equal(calls[0][2].marked_complete, true);

    let manualWrite;
    const manualApi = todoApi.createTodoApi({ manualState: { async get(key) { assert.equal(key, `todo-completion:${ACCOUNT}`); return {}; }, async set(key, value) { manualWrite = { key, value }; } } });
    const manualDone = await manualApi.dispatchCompletion(canvasTask, true, { mode: "manual", accountKey: ACCOUNT });
    assert.equal(manualDone.ok, true);
    assert.equal(manualWrite.value[canvasTask.id], true);

    const nestCalls = [];
    const nestApi = todoApi.createTodoApi({ nest: { todos: { async setCompletion(id, payload) { nestCalls.push([id, payload]); return { ok: true, status: 200, body: {} }; } } } });
    const nest = model.normalizeNestTask(nestTask(), { accountKey: ACCOUNT }).task;
    assert.equal((await nestApi.dispatchCompletion(nest, true)).task.completion, true);
    assert.deepEqual(nestCalls, [["nest-1", { completed: true }]]);

    let canvasSubmitCalled = false;
    const failedCanvasApi = todoApi.createTodoApi({ canvas: { async writePlannerOverride() { return { ok: false, status: 409, body: { error: { code: "conflict", message: "Conflict" } } }; }, async submitAssignment() { canvasSubmitCalled = true; } } });
    const failed = await failedCanvasApi.dispatchCompletion(canvasTask, true);
    assert.equal(failed.ok, false);
    assert.equal(failed.task.completion, canvasTask.completion);
    assert.equal(failed.error.code, "conflict");
    assert.equal(canvasSubmitCalled, false);
    const missingManual = await todoApi.createTodoApi({}).dispatchCompletion(canvasTask, true, { mode: "manual", accountKey: ACCOUNT });
    assert.equal(missingManual.error.code, "TODO_MANUAL_STATE_UNAVAILABLE");
});

test("announcement completion writes the Canvas discussion read state and never flips academic completion", async () => {
    const announcement = await normalizeCanvas("announcement", canvasItem("announcement", { unread: true, read: false }));
    const calls = [];
    const api = todoApi.createTodoApi({ canvas: { async markAnnouncementRead(task, payload) { calls.push([task.id, payload]); return { ok: true, status: 204, body: {} }; } } });
    const read = await api.dispatchCompletion(announcement, true);
    assert.equal(read.ok, true);
    assert.equal(read.authority, "canvas_announcement_read");
    assert.deepEqual(calls, [[announcement.id, { read: true }]]);
    assert.equal(read.task.completion, announcement.completion, "a read state is not an academic completion");
    assert.equal(read.task.unread, false);
    assert.equal(read.task.readState, "read");
    assert.equal(read.task.visibility, "excluded", "confirmed reads adopt the same visibility a fresh Canvas read normalizes to");
    const unread = await api.dispatchCompletion(announcement, false);
    assert.deepEqual(calls[1], [announcement.id, { read: false }]);
    assert.equal(unread.task.unread, true);
    assert.equal(unread.task.readState, "unread");
    assert.equal(Object.hasOwn(unread.task, "visibility"), false);
    const failedRead = await todoApi.createTodoApi({ canvas: { async markAnnouncementRead() { return { ok: false, status: 403, body: { error: { code: "forbidden", message: "Canvas refused the read write." } } }; } } }).dispatchCompletion(announcement, true);
    assert.equal(failedRead.ok, false);
    assert.equal(failedRead.task.unread, true, "failure leaves the prior read state untouched");
    assert.equal(failedRead.error.code, "forbidden");
    const missingTransport = await todoApi.createTodoApi({}).dispatchCompletion(announcement, true);
    assert.equal(missingTransport.error.code, "CANVAS_ANNOUNCEMENT_READ_UNAVAILABLE");
});

test("one announcement from the planner feed and the announcements feed collapses to the course-labeled row", async () => {
    // Planner rows carry the full course context but key occurrences by the
    // planner row id; /api/v1/announcements returns the same topic keyed by
    // the discussion id with only a context code, so raw event refs differ.
    const plannerRow = await normalizeCanvas("announcement", {
        id: 510123,
        plannable_id: 1393456,
        plannable_type: "announcement",
        course_id: 165886,
        context_name: "HLTH-100-MON: It's Your Health & Wellbeing - Fall 2026",
        title: "HLTH 100 Reminder: September 7-11",
        posted_at: "2026-09-01T12:00:00Z",
        read_state: "unread",
        html_url: `${ORIGIN}/courses/165886/discussion_topics/1393456`
    });
    const feedTopic = await normalizeCanvas("announcement", {
        id: 1393456,
        context_code: "course_165886",
        title: "HLTH 100 Reminder: September 7-11",
        message: "<p>Wear closed-toe shoes for the lab tour.</p>",
        posted_at: "2026-09-01T12:00:00Z",
        read_state: "unread",
        html_url: `${ORIGIN}/courses/165886/discussion_topics/1393456`
    });
    assert.notEqual(plannerRow.id, feedTopic.id, "reproduces the duplicate: distinct source item keys");
    assert.equal(plannerRow.course.id, feedTopic.course.id);
    assert.equal(plannerRow.course.name, "HLTH-100-MON: It's Your Health & Wellbeing - Fall 2026");
    assert.equal(feedTopic.course.name, null);
    assert.equal(feedTopic.course.label, "Course 165886");
    assert.equal(todoApi.canvasPlannableIdentity(plannerRow), todoApi.canvasPlannableIdentity(feedTopic));

    const merged = todoApi.dedupeCanvasTasks([plannerRow, feedTopic]);
    assert.equal(merged.length, 1, "the feed twin is dropped, the course-labeled planner row stays");
    assert.equal(merged[0].id, plannerRow.id);
    assert.equal(merged[0].course.name, "HLTH-100-MON: It's Your Health & Wellbeing - Fall 2026");
    assert.equal(merged[0].raw.message, "<p>Wear closed-toe shoes for the lab tour.</p>", "the kept row inherits the feed twin's body so previews render");

    const reversed = todoApi.dedupeCanvasTasks([feedTopic, plannerRow]);
    assert.equal(reversed.length, 1);
    assert.equal(reversed[0].id, plannerRow.id, "the course-labeled copy wins regardless of feed order");
    assert.equal(reversed[0].raw.message, "<p>Wear closed-toe shoes for the lab tour.</p>");

    const other = await normalizeCanvas("announcement", canvasItem("announcement", { id: 1399999, context_code: "course_42" }, { unread: true }));
    assert.deepEqual(todoApi.dedupeCanvasTasks([plannerRow, feedTopic, other]).map((entry) => entry.id), [plannerRow.id, other.id], "distinct announcements survive");

    const bare = { id: "canvas:x:1", source: "canvas", remoteId: "1", sourceItemKey: "k", type: "assignment", course: null, raw: {} };
    assert.deepEqual(todoApi.dedupeCanvasTasks([bare, bare, other]), [bare, other], "tasks without course context still dedupe by task id");
    assert.deepEqual(todoApi.dedupeCanvasTasks([]), []);
    assert.deepEqual(todoApi.dedupeCanvasTasks([null, plannerRow]), [plannerRow]);
});
