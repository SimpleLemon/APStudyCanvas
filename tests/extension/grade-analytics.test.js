"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const analytics = require("../../js/content/grade-analytics.js");
const schema = require("../../js/settings-schema.js");

const BOUNDS = schema.defaultsForArea("sync").gpa_calc_bounds;
const fixture = Object.freeze({
    courseId: "42",
    assignmentGroups: [{ id: 1, name: "Tests", group_weight: 60 }, { id: 2, name: "Work", group_weight: 40 }],
    assignments: [
        { id: 1, name: "Zero is real", assignment_group_id: 1, points_possible: 10, submission: { score: 0 }, due_at: "2026-09-02T00:00:00Z" },
        { id: 2, name: "Missing", assignment_group_id: 1, points_possible: 10, submission: { missing: true }, due_at: "2026-09-01T00:00:00Z" },
        { id: 3, name: "Weighted work", assignment_group_id: 2, points_possible: 20, submission: { score: 18 }, due_at: "2026-09-03T00:00:00Z" },
        { id: 4, name: "Ungraded", assignment_group_id: 2, points_possible: 20, submission: {} },
        { id: 5, name: "Hidden", assignment_group_id: 2, points_possible: 20, hidden: true, submission: { score: 20 } },
        { id: 6, name: "Dropped", assignment_group_id: 2, points_possible: 20, dropped: true, submission: { score: 20 } }
    ]
});

test("normalization is bounded, defensive, immutable, and keeps Canvas source untouched", () => {
    const raw = { assignments: [{ id: "x/unsafe", name: "No" }, { id: "1", name: "\u0000 Safe ", points_possible: "10", score: "0" }], groups: Array.from({ length: 130 }, (_, id) => ({ id, name: "group" })) };
    const normalized = analytics.normalizeGradeData(raw);
    assert.equal(normalized.groups.length, analytics.MAX_GROUPS);
    assert.equal(normalized.assignments.length, 1);
    assert.equal(normalized.assignments[0].title, "Safe");
    assert.equal(normalized.assignments[0].score, 0);
    assert.throws(() => { normalized.assignments[0].score = 9; }, TypeError);
    assert.equal(raw.assignments[1].name, "\u0000 Safe ");
});

test("overview distinguishes weighted, missing, hidden, dropped, ungraded, and a valid zero", () => {
    const result = analytics.calculateAnalytics(fixture, { bounds: BOUNDS, zones: true });
    assert.equal(result.overview.method, "weighted-groups");
    assert.equal(Number(result.overview.score.toFixed(2)), 36, "tests are 0%; work is 90%; weighted 60/40");
    assert.equal(result.overview.counted, 3);
    assert.deepEqual({ missing: result.overview.missing, hidden: result.overview.hidden, dropped: result.overview.dropped, ungraded: result.overview.ungraded }, { missing: 1, hidden: 1, dropped: 1, ungraded: 1 });
    assert.equal(result.overview.estimate, true);
    assert.equal(result.history[0].title, "Missing", "history sorts by due date without mutating source order");
    assert.equal(result.history[0].score, 0);
    assert.equal(result.heatmap[0].zone, "at-risk");
    assert.match(result.heatmap[0].label, /Missing: 0\.0% \(F\)/);
    assert.deepEqual(result.distribution, [{ letter: "A-", count: 1 }, { letter: "F", count: 2 }]);
    assert.equal(result.lastFive.length, 3);
});

test("unweighted groups fall back to points and never produce NaN", () => {
    const result = analytics.calculateAnalytics({ assignments: [{ id: 1, points_possible: 0, score: 0 }, { id: 2, points_possible: 20, score: 10 }] }, { bounds: BOUNDS });
    assert.equal(result.overview.method, "points");
    assert.equal(result.overview.score, 50);
    assert.equal(result.overview.letter, "F");
    assert.ok(Object.values(result.overview).every((value) => value === null || typeof value !== "number" || Number.isFinite(value)));
});

test("scenario edits are in-memory, reversible, bounded, and pin an estimate without modifying source", () => {
    const original = analytics.calculateAnalytics(fixture, { bounds: BOUNDS });
    let scenario = analytics.createScenario();
    scenario = analytics.scenarioAssignment(scenario, "1", { score: 10 });
    scenario = analytics.scenarioGroup(scenario, "1", { weight: 0.5 });
    scenario = analytics.addScenarioGroup(scenario, { id: "extra", name: "Extra credit", weight: 0.1 });
    scenario = analytics.addScenarioAssignment(scenario, { id: "practice", title: "Practice", groupId: "2", pointsPossible: 10, score: 10 });
    scenario = analytics.setScenarioFinal(scenario, { groupId: "1", pointsPossible: 100, score: 100 });
    const projected = analytics.calculateAnalytics(analytics.materializeScenario(fixture, scenario), { bounds: BOUNDS });
    assert.ok(projected.overview.score > original.overview.score);
    scenario = analytics.pinFinalEstimate(fixture, scenario, { bounds: BOUNDS });
    assert.equal(scenario.pinnedFinal.estimate, true);
    assert.ok(Number.isFinite(scenario.pinnedFinal.score));
    assert.equal(fixture.assignments[0].submission.score, 0, "base Canvas-shaped record stays unchanged");
    const withoutWork = analytics.removeScenarioAssignment(analytics.removeScenarioGroup(scenario, "2"), "3");
    const changed = analytics.materializeScenario(fixture, withoutWork);
    assert.ok(!changed.groups.some((group) => group.id === "2"));
    assert.ok(!changed.assignments.some((assignment) => assignment.id === "3"));
    const reset = analytics.resetScenario();
    assert.deepEqual(analytics.calculateAnalytics(analytics.materializeScenario(fixture, reset), { bounds: BOUNDS }).overview.score, original.overview.score);
    let capped = analytics.createScenario();
    for (let index = 0; index < analytics.MAX_SCENARIO_ADDITIONS + 5; index += 1) capped = analytics.addScenarioAssignment(capped, { id: `new-${index}`, pointsPossible: 1, score: 1 });
    assert.equal(Object.keys(capped.assignments).length, analytics.MAX_SCENARIO_ADDITIONS);
});

test("the domain has no DOM, persistence, or mutation transport capability", () => {
    const source = require("node:fs").readFileSync(require("node:path").resolve(__dirname, "../../js/content/grade-analytics.js"), "utf8");
    assert.doesNotMatch(source, /\b(?:fetch|XMLHttpRequest|chrome\.storage|localStorage|document\.)\b/);
    assert.equal(globalThis.APStudyCanvasContent?.GradeAnalytics, analytics);
    assert.throws(() => { analytics.VERSION = 2; }, TypeError);
});
