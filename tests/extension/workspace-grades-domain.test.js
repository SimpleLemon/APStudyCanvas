"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const analytics = require("../../js/content/grade-analytics.js");
const gpa = require("../../js/content/gpa.js");
const schema = require("../../js/settings-schema.js");
const grades = require("../../js/workspace-grades-domain.js");

const BOUNDS = schema.defaultsForArea("sync").gpa_calc_bounds;
const ACCOUNT_KEY = "a".repeat(64);
function account(overrides = {}) {
    return {
        scope: `canvas:${ACCOUNT_KEY}`,
        canvas: { verified: true, origin: "https://canvas.example.edu", accountKey: ACCOUNT_KEY, accountId: "42", ...overrides }
    };
}
function source() {
    return {
        courseId: "7",
        assignmentGroups: [{ id: "tests", name: "Tests" }, { id: "work", name: "Coursework" }],
        assignments: [
            { id: "old", name: "Old test", assignment_group_id: "tests", points_possible: 20, submission: { score: 10 }, due_at: "2026-07-01T12:00:00Z" },
            { id: "recent", name: "Recent test", assignment_group_id: "tests", points_possible: 20, submission: { score: 18 }, due_at: "2026-09-05T12:00:00Z" },
            { id: "work", name: "Worksheet", assignment_group_id: "work", points_possible: 10, submission: { score: 8 }, due_at: "2026-09-08T12:00:00Z" },
            { id: "undated", name: "Undated", assignment_group_id: "work", points_possible: 10, submission: { score: 10 } },
            { id: "hidden", name: "Hidden", assignment_group_id: "work", points_possible: 10, submission: { score: 10 }, hidden: true, due_at: "2026-09-09T12:00:00Z" }
        ]
    };
}

test("read adapter accepts injected Canvas reads and rejects incomplete grade snapshots", async () => {
    const calls = [];
    const adapter = grades.createGradeReadAdapter({
        account: account(), analytics,
        verifyAccount: async () => account(),
        readCourses: async (signal) => { calls.push(["courses", signal]); return { items: [{ id: 7, name: "Biology", enrollments: [{ type: "StudentEnrollment", computed_current_score: 91 }] }], complete: true }; },
        readCourseGradeData: async (courseId, signal) => { calls.push([courseId, signal]); return { assignments: source().assignments, assignmentGroups: source().assignmentGroups }; }
    });
    const overview = await adapter.overview();
    assert.equal(overview.courses[0].currentGrade.status, "current");
    assert.equal(overview.courses[0].currentGrade.value, 91);
    assert.equal(overview.courses[0].links.assignments, "/courses/7/assignments");
    const detail = await adapter.course("7");
    assert.equal(detail.source.assignments.length, 5);
    assert.ok(calls.every(([, signal]) => signal instanceof AbortSignal));

    const incomplete = grades.createGradeReadAdapter({
        account: account(), analytics, verifyAccount: async () => account(), readCourses: async () => [],
        readCourseGradeData: async () => ({ assignments: { items: source().assignments, truncated: true }, assignmentGroups: source().assignmentGroups })
    });
    await assert.rejects(incomplete.course("7"), (error) => error.code === "GRADES_READ_INCOMPLETE" && /No estimate/.test(error.message));
    await assert.rejects(grades.createGradeReadAdapter({ account: account(), analytics, verifyAccount: async () => account(), readCourses: async () => Array.from({ length: 201 }, (_, id) => ({ id: id + 1 })), readCourseGradeData: async () => ({ assignments: [], assignmentGroups: [] }) }).overview(), (error) => error.code === "GRADES_READ_INCOMPLETE" && /No partial overview/.test(error.message));
});

test("read adapter catches stale accounts after reads and aborts pending work on disposal", async () => {
    let verification = 0;
    const switched = account({ accountKey: "b".repeat(64) }); switched.scope = `canvas:${"b".repeat(64)}`;
    const stale = grades.createGradeReadAdapter({
        account: account(), analytics,
        verifyAccount: async () => (++verification > 1 ? switched : account()),
        readCourses: async () => [{ id: 7 }],
        readCourseGradeData: async () => ({ assignments: [], assignmentGroups: [] })
    });
    await assert.rejects(stale.overview(), (error) => error.code === "GRADES_ACCOUNT_STALE");

    let observedAbort = false;
    const pending = grades.createGradeReadAdapter({
        account: account(), analytics, verifyAccount: async () => account(), readCourses: async (signal) => new Promise((resolve, reject) => {
            signal.addEventListener("abort", () => { observedAbort = true; const failure = new Error("aborted"); failure.name = "AbortError"; reject(failure); }, { once: true });
        }),
        readCourseGradeData: async () => ({ assignments: [], assignmentGroups: [] })
    });
    const operation = pending.overview();
    await Promise.resolve(); await Promise.resolve();
    pending.dispose();
    await assert.rejects(operation, (error) => error.code === "GRADES_READ_ABORTED");
    assert.equal(observedAbort, true);
    await assert.rejects(pending.overview(), (error) => error.code === "GRADES_ADAPTER_DISPOSED");
});

test("course overview preserves legacy settings and distinguishes current, official, and estimated values", () => {
    const courses = [{
        id: 7, name: "Biology", enrollments: [{ type: "StudentEnrollment", computed_current_score: 90, official_final_score: 94 }]
    }, {
        id: 8, name: "History", enrollments: [{ type: "StudentEnrollment", computed_current_score: 80 }]
    }];
    const savedWorkspace = { version: 1, notes: [], planner: [], study: [], grades: { priorGpa: "3", priorCredits: "4", courses: { "7": { credits: "2", goal: "93", whatIf: "100", weight: "ap" }, "8": { credits: 1, goal: 85, included: false } } } };
    const result = grades.buildCourseOverview(courses, savedWorkspace, { bounds: BOUNDS, gpa });
    assert.equal(result.rows[0].currentGrade.status, "current");
    assert.equal(result.rows[0].officialGrade.status, "official");
    assert.equal(result.rows[0].scenarioGrade.status, "estimated");
    assert.equal(result.rows[0].goal, 93);
    assert.equal(result.rows[1].included, false);
    assert.equal(result.current.counted, 1);
    assert.equal(result.current.credits, 2);
    assert.equal(result.current.weighted, 4.7, "the incumbent GPA model supplies AP weighting to the resolved A- tier");
    assert.equal(Number(result.current.cumulative.toFixed(3)), 3.567);
    assert.equal(Number(result.scenario.cumulative.toFixed(3)), 3.767, "the what-if value flows through the incumbent A+ scale and cumulative behavior");
    assert.deepEqual(Object.keys(savedWorkspace.grades).sort(), ["courses", "priorCredits", "priorGpa"], "legacy workspace shape is read without migration");
});

test("guided configuration rejects unsupported metrics, types, ranges, and reversed custom dates", () => {
    const invalid = grades.normalizeChartConfig({ courseId: "7", metric: "gpa-history", chartType: "pie", dateRange: "custom", start: "2026-09-10", end: "2026-09-01", comparison: "many" });
    assert.equal(invalid.ok, false);
    assert.deepEqual(invalid.errors.map((item) => item.code), ["METRIC_UNSUPPORTED", "CHART_UNSUPPORTED", "COMPARISON_UNSUPPORTED", "CUSTOM_RANGE_INVALID"]);
    const valid = grades.normalizeChartConfig({ courseId: "7", chartType: "scores-over-time", dateRange: "last-30-days" }, { now: new Date("2026-09-11T12:00:00Z") });
    assert.equal(valid.ok, true);
    assert.equal(valid.config.start, "2026-08-12T12:00:00.000Z");
    assert.equal(valid.config.end, "2026-09-11T12:00:00.000Z");
});

test("scores-over-time uses assignment timestamps only and table rows reference the same dataset points", () => {
    const result = grades.buildChartDataset(source(), { courseId: "7", metric: "assignment-percentage", chartType: "scores-over-time", dateRange: "last-30-days", comparison: "current" }, { analytics, now: new Date("2026-09-11T12:00:00Z") });
    assert.equal(result.state, "ready");
    assert.match(result.disclosure, /assignment due timestamps only/i);
    assert.match(result.table.caption, /not final-grade history/i);
    assert.deepEqual(result.datasets[0].points.map((point) => [point.key, point.y]), [["recent", 90], ["work", 80]]);
    assert.deepEqual(result.table.rows.map((row) => [row.pointKey, row.cells[2], row.cells[3]]), result.datasets[0].points.map((point) => [point.key, point.x, `${point.y.toFixed(1)}%`]));
    assert.ok(result.datasets[0].points.every((point) => /assignment due timestamp/.test(point.valueLabel)));
});

test("histogram and assignment-group presets expose current/scenario estimates without general multi-series", () => {
    let scenario = analytics.createScenario();
    scenario = analytics.scenarioAssignment(scenario, "recent", { score: 20 });
    scenario = analytics.addScenarioAssignment(scenario, { id: "new", title: "New work", groupId: "work", pointsPossible: 10, score: 5, dueAt: "2026-09-10T12:00:00Z" });
    const histogram = grades.buildChartDataset(source(), { courseId: "7", chartType: "score-histogram", dateRange: "all", comparison: "scenario" }, { analytics, scenario });
    assert.deepEqual(histogram.datasets.map((set) => [set.id, set.status]), [["current", "current"], ["scenario", "estimated"]]);
    assert.equal(histogram.datasets.length, 2);
    assert.equal(histogram.table.rows.length, 10, "five fixed bins from each of the two supported series");
    const bars = grades.buildChartDataset(source(), { courseId: "7", chartType: "assignment-group-bars", dateRange: "all", comparison: "scenario" }, { analytics, scenario });
    assert.deepEqual(bars.datasets[0].points.map((point) => point.label), ["Coursework", "Tests"]);
    assert.equal(Number(bars.datasets[1].points.find((point) => point.key === "work").y.toFixed(3)), 76.667);
    assert.deepEqual(bars.table.rows.map((row) => row.pointKey), bars.datasets.flatMap((set) => set.points.map((point) => point.key)));
});

test("missing dates/data are empty and unsupported scenario rules are explicit", () => {
    const undated = { courseId: "7", assignments: [{ id: 1, name: "Undated", points_possible: 10, score: 8 }], assignmentGroups: [] };
    const empty = grades.buildChartDataset(undated, { courseId: "7", chartType: "scores-over-time", dateRange: "all", comparison: "current" }, { analytics });
    assert.equal(empty.state, "empty");
    assert.equal(empty.code, "NO_SUPPORTED_DATA");
    const noScenario = grades.buildChartDataset(source(), { courseId: "7", chartType: "score-histogram", comparison: "scenario" }, { analytics });
    assert.equal(noScenario.code, "SCENARIO_REQUIRED");
    const withFinal = analytics.setScenarioFinal(analytics.createScenario(), { pointsPossible: 100, score: 90, groupId: "tests" });
    const unsupported = grades.buildChartDataset(source(), { courseId: "7", chartType: "scores-over-time", comparison: "scenario" }, { analytics, scenario: withFinal });
    assert.equal(unsupported.code, "SCENARIO_FINAL_TIME_UNSUPPORTED");
    assert.match(unsupported.message, /no assignment timestamp/);
});

test("chart preferences use a separate account key and stop before writes when the account is stale", async () => {
    const records = { "apstudycanvas.workspace.v1:https://canvas.example.edu:42": { version: 1, grades: { courses: { "7": { credits: 2 } } } } };
    const writes = [];
    const storage = { get: async (key) => ({ [key]: records[key] }), set: async (value) => { writes.push(value); Object.assign(records, value); } };
    const store = grades.createChartPreferenceStore({ storage, account: account(), verifyAccount: async () => account() });
    assert.match(store.key, /^apstudycanvas\.grades\.chart-prefs\.v1:/);
    assert.doesNotMatch(store.key, /workspace\.v1/);
    assert.equal((await store.load()).chartType, "scores-over-time");
    const saved = await store.save({ courseId: "7", chartType: "score-histogram", comparison: "scenario" });
    assert.equal(saved.chartType, "score-histogram");
    assert.equal(writes.length, 1);
    assert.ok(records["apstudycanvas.workspace.v1:https://canvas.example.edu:42"].grades.courses["7"], "legacy record is untouched");

    const stale = grades.createChartPreferenceStore({ storage, account: account(), verifyAccount: async () => ({ scope: null, canvas: { verified: false } }) });
    await assert.rejects(stale.save({ courseId: "7" }), (error) => error.code === "GRADES_ACCOUNT_UNVERIFIED");
    assert.equal(writes.length, 1, "verification fails before any stale-account write");
});

test("domain is pure/injected and exposes no Canvas mutation, transcript, AI, DOM, or general chart transport", () => {
    const moduleSource = require("node:fs").readFileSync(require("node:path").resolve(__dirname, "../../js/workspace-grades-domain.js"), "utf8");
    assert.doesNotMatch(moduleSource, /\b(?:fetch|XMLHttpRequest|document\.|chrome\.storage|localStorage)\b/);
    assert.doesNotMatch(moduleSource, /\b(?:POST|PUT|PATCH|DELETE)\b/);
    assert.deepEqual(grades.CHART_TYPES, ["scores-over-time", "score-histogram", "assignment-group-bars"]);
    assert.deepEqual(grades.METRICS, ["assignment-percentage"]);
});

test("standalone final solver distinguishes feasible, secured, impossible and invalid targets", () => {
    assert.ok(Math.abs(grades.requiredFinal(80, 85, 20).score - 105) < 1e-8);
    assert.equal(grades.requiredFinal(80, 85, 20).state, "unreachable");
    assert.equal(grades.requiredFinal(90, 80, 20).score, 40);
    assert.equal(grades.requiredFinal(100, 50, 20).state, "secured");
    assert.equal(grades.requiredFinal(null, 80, 20).state, "invalid");
    assert.equal(grades.requiredFinal(90, 80, 0).state, "invalid");
    assert.equal(grades.requiredFinal(90, 80, 101).state, "invalid");
    assert.equal(grades.requiredFinal(90, 80, 100).score, 80);
});

test("course-specific scales change only that course's GPA contribution", () => {
    const courses = [{ id: 1, currentScore: 91 }, { id: 2, currentScore: 91 }];
    const saved = { grades: { courses: { 1: { credits: 1, bounds: grades.gradingPreset(true) }, 2: { credits: 1 } } } };
    const overview = grades.buildCourseOverview(courses, saved, { bounds: grades.gradingPreset(false), gpa });
    assert.equal(overview.current.weighted, 3.85);
    assert.equal(grades.validateBounds(grades.gradingPreset(true)), true);
    assert.equal(grades.validateBounds({ A: { cutoff: 80, gpa: 4 }, B: { cutoff: 90, gpa: 3 }, F: { cutoff: 0, gpa: 0 } }), false);
    assert.equal(grades.validateBounds({ A: { cutoff: 90, gpa: 4 } }), false);
});

test("observations record Canvas scores, deduplicate same-day values, retain changes and expire old data", async () => {
    const memory = {}; let date = new Date("2026-09-12T12:00:00Z");
    const storage = { get: async key => ({ [key]: memory[key] }), set: async values => Object.assign(memory,values) };
    const store = grades.createHistoryStore({ storage, account: account(), now: () => date });
    const courses = [{ id: "7", currentGrade: { value: 80 }, scenarioGrade: { value: 99 } }, { id: "8", currentGrade: { value: null } }];
    assert.deepEqual((await store.capture(courses)).map(r => r.score), [80]);
    assert.equal((await store.capture(courses)).length,1);
    courses[0].currentGrade.value = 82;
    assert.deepEqual((await store.capture(courses)).map(r => r.score),[80,82]);
    date = new Date("2026-09-13T12:00:00Z"); assert.equal((await store.capture(courses)).length,3);
    date = new Date("2028-09-13T12:00:00Z"); assert.equal((await store.load()).length,0);
});

test("history rejects switched accounts before writes and does not leak another account's data", async () => {
    const memory = {}; let active = account(); let writes = 0;
    const storage = { get: async key => ({ [key]: memory[key] }), set: async values => { writes++; Object.assign(memory,values); } };
    const store = grades.createHistoryStore({ storage, account: active, verifyAccount: async () => active });
    await store.capture([{ id: "7", currentGrade: { value: 70 } }]);
    active = account({ accountKey: "b".repeat(64) }); active.scope = `canvas:${"b".repeat(64)}`;
    await assert.rejects(store.capture([{ id: "7", currentGrade: { value: 80 } }]), { code: "GRADES_ACCOUNT_STALE" });
    assert.equal(writes,1);
    assert.deepEqual(await grades.createHistoryStore({ storage, account: active }).load(), []);
});
