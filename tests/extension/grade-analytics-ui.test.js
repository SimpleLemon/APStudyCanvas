"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const domain = require("../../js/content/grade-analytics.js");
const ui = require("../../js/content/grade-analytics-ui.js");
const { Document, walk } = require("./helpers/dom.js");
function fixture() { return { courseId: "42", assignmentGroups: [{ id: 1, name: "Tests", group_weight: 60 }], assignments: [{ id: 1, name: "Zero", assignment_group_id: 1, points_possible: 10, submission: { score: 0 }, due_at: "2026-09-01T00:00:00Z" }, { id: 2, name: "Ungraded", assignment_group_id: 1, points_possible: 10, submission: {} }] }; }
function action(root, name) { return walk(root).find((node) => node.dataset.action === name); }
function text(root) { return walk(root).map((node) => node.textContent).join(" "); }

test("renders accessible overview, distribution, history, heatmap and textual chart equivalents without changing inputs", () => {
    const doc = new Document(); const host = doc.createElement("main"); const source = fixture(); const before = JSON.stringify(source);
    const controller = ui.createGradeAnalyticsUI({ document: doc, domain });
    assert.equal(controller.mount(host, { source, zones: true }), true);
    const root = host.children[0];
    assert.equal(root.dataset.apstudycanvasOwned, "true");
    assert.equal(root.attributes["aria-labelledby"], "apstudy-grade-analytics-title");
    assert.match(text(root), /Estimates use the grades/); assert.match(text(root), /Text equivalent: assignment distribution/); assert.match(text(root), /Text equivalent: assignment history/); assert.ok(walk(root).some((node) => node.attributes["aria-label"] === "Grade heatmap, with assignment names and scores")); assert.match(walk(root).find((node) => node.className === "apstudy-grade-analytics__pie").attributes["aria-label"], /Assignment distribution/);
    assert.equal(JSON.stringify(source), before, "rendering never mutates Canvas-shaped input");
});
test("loading, empty, error, and ungraded states fail open without an analytics root outside its host", () => {
    const doc = new Document(); const host = doc.createElement("main"); const controller = ui.createGradeAnalyticsUI({ document: doc, domain });
    controller.mount(host, { state: "loading" }); assert.equal(walk(host).find((node) => node.textContent === "Loading grade estimates…").attributes.role, "status");
    let retries = 0; controller.update({ state: "error", error: "Canvas data is unavailable", onRetry: () => { retries += 1; } }); assert.equal(walk(host).find((node) => node.textContent === "Canvas data is unavailable").attributes.role, "alert");
    const retry = action(host.children[0], "retry"); retry.focus(); host.children[0].dispatchEvent({ type: "click", target: retry }); assert.equal(retries, 1, "a recoverable read failure offers an explicit retry");
    controller.update({ source: fixture(), state: "ready" }); assert.match(text(host), /Ungraded/);
    controller.destroy(); assert.equal(host.children.length, 0); assert.equal(controller.isMounted(), false);
    assert.equal(controller.mount(null, { source: fixture() }), false, "missing DOM selector/container fails open");
});
test("truncated Canvas pagination is visibly disclosed as a recoverable no-estimate state", () => {
    const doc = new Document(); const host = doc.createElement("main"); const controller = ui.createGradeAnalyticsUI({ document: doc, domain }); let retries = 0;
    controller.mount(host, { state: "error", error: "This course has more grade data than Grade Analytics can safely read at once. No estimate is shown; reload this Grades page or try again after Canvas finishes loading. Canvas remains unchanged.", onRetry: () => { retries += 1; } });
    assert.match(text(host), /No estimate is shown/);
    const alert = walk(host).find((node) => node.attributes.role === "alert"); assert.ok(alert, "the incomplete-data state is announced");
    const retry = action(host.children[0], "retry"); host.children[0].dispatchEvent({ type: "click", target: retry }); assert.equal(retries, 1);
});
test("detects a Canvas-replaced mount root so the integration can remount it", () => {
    const doc = new Document(); const host = doc.createElement("main"); const controller = ui.createGradeAnalyticsUI({ document: doc, domain });
    controller.mount(host, { source: fixture() }); assert.equal(controller.isAttached(), true);
    host.replaceChildren(); assert.equal(controller.isAttached(), false);
});
test("Imagine-If edits retain logical focus and caret, announce changed estimates once, and use a safe removal fallback", () => {
    const doc = new Document(); const host = doc.createElement("main"); const controller = ui.createGradeAnalyticsUI({ document: doc, domain }); controller.mount(host, { source: fixture() }); let root = host.children[0];
    const score = action(root, "assignment-score"); score.focus(); score.value = "10"; score.setSelectionRange(1, 2); root.dispatchEvent({ type: "change", target: score }); root = host.children[0];
    assert.equal(doc.activeElement.dataset.focusKey, "assignment-score:1"); assert.equal(doc.activeElement.value, "10"); assert.equal(doc.activeElement.selectionStart, 1); assert.equal(doc.activeElement.selectionEnd, 2);
    const live = walk(root).find((node) => node.className === "apstudy-grade-analytics__live"); const announcement = live.textContent;
    assert.equal(live.attributes["aria-live"], "polite"); assert.equal(live.attributes["aria-atomic"], "true"); assert.match(announcement, /Local estimate recalculated: 100.0%/);
    const sameScore = action(root, "assignment-score"); sameScore.focus(); sameScore.value = "10"; root.dispatchEvent({ type: "change", target: sameScore }); assert.equal(walk(root).find((node) => node.className === "apstudy-grade-analytics__live").textContent, announcement, "an unchanged estimate does not create a second announcement");
    root = host.children[0]; const possible = action(root, "assignment-possible"); possible.focus(); possible.value = "20"; possible.setSelectionRange(0, 1); root.dispatchEvent({ type: "change", target: possible }); root = host.children[0]; assert.equal(doc.activeElement.dataset.focusKey, "assignment-possible:1"); assert.equal(doc.activeElement.selectionStart, 0);
    const weight = action(root, "group-weight"); weight.focus(); weight.value = "50"; root.dispatchEvent({ type: "change", target: weight }); root = host.children[0]; assert.equal(doc.activeElement.dataset.focusKey, "group-weight:1");
    const removeAssignment = action(root, "remove-assignment"); removeAssignment.focus(); root.dispatchEvent({ type: "click", target: removeAssignment }); root = host.children[0]; assert.equal(doc.activeElement.dataset.focusKey, "new-assignment-name");
    const removeGroup = action(root, "remove-group"); removeGroup.focus(); root.dispatchEvent({ type: "click", target: removeGroup }); assert.equal(doc.activeElement.dataset.focusKey, "new-group-name");
});
test("keyboard-only add controls move focus to the added editable row", () => {
    const doc = new Document(); const host = doc.createElement("main"); const controller = ui.createGradeAnalyticsUI({ document: doc, domain }); controller.mount(host, { source: fixture() }); let root = host.children[0];
    action(root, "new-group-name").value = "Projects"; action(root, "new-group-weight").value = "40"; const addGroup = action(root, "add-group"); addGroup.focus(); root.dispatchEvent({ type: "click", target: addGroup }); root = host.children[0]; assert.equal(doc.activeElement.dataset.focusKey, "group-weight:local-group-1");
    action(root, "new-assignment-name").value = "Essay"; action(root, "new-assignment-score").value = "8"; action(root, "new-assignment-possible").value = "10"; const addAssignment = action(root, "add-assignment"); addAssignment.focus(); root.dispatchEvent({ type: "click", target: addAssignment }); assert.equal(doc.activeElement.dataset.focusKey, "assignment-score:local-assignment-1");
});
test("Imagine-If controls are local, bounded by the domain, pin/reset, and lifecycle re-entry drops local changes", () => {
    const doc = new Document(); const host = doc.createElement("main"); const source = fixture(); const controller = ui.createGradeAnalyticsUI({ document: doc, domain }); controller.mount(host, { source }); let root = host.children[0];
    const earned = action(root, "assignment-score"); earned.value = "10"; root.dispatchEvent({ type: "change", target: earned }); root = host.children[0]; assert.match(text(root), /100.0%/, "local score edit rerenders an estimate");
    root.dispatchEvent({ type: "click", target: action(root, "pin") }); root = host.children[0]; assert.match(text(root), /Pinned local estimate/);
    root.dispatchEvent({ type: "click", target: action(root, "reset") }); root = host.children[0]; assert.doesNotMatch(text(root), /Pinned local estimate/); assert.equal(source.assignments[0].submission.score, 0);
    controller.destroy(); controller.mount(host, { source }); assert.doesNotMatch(text(host), /Pinned local estimate/, "new mount starts a new in-memory scenario");
});
test("rapid update/dispose races leave no root or retained rendered data", () => {
    const doc = new Document(); const first = doc.createElement("main"); const second = doc.createElement("main"); const controller = ui.createGradeAnalyticsUI({ document: doc, domain });
    controller.mount(first, { source: fixture() }); const initialGeneration = controller.generation(); controller.update({ state: "loading" }); controller.destroy(); controller.update({ source: fixture() });
    assert.equal(first.children.length, 0); assert.equal(controller.isMounted(), false); assert.ok(controller.generation() > initialGeneration);
    controller.mount(second, { source: fixture() }); assert.equal(second.children.length, 1); controller.destroy(); assert.equal(second.children.length, 0);
});
test("large courses cap rendered history, editor rows, and heatmap cells at the declared performance bound", () => {
    const doc = new Document(); const host = doc.createElement("main"); const assignments = Array.from({ length: 150 }, (_, index) => ({ id: index + 1, name: `Assignment ${index + 1}`, points_possible: 10, submission: { score: 8 } }));
    const controller = ui.createGradeAnalyticsUI({ document: doc, domain }); controller.mount(host, { source: { assignments }, zones: true }); const root = host.children[0];
    assert.equal(walk(root).filter((node) => node.className === "apstudy-grade-analytics__heatmap-cell").length, ui.MAX_RENDERED_ROWS);
    assert.equal(walk(root).filter((node) => node.dataset.assignmentId).length, ui.MAX_RENDERED_ROWS, "editor rows share the cap");
    assert.match(text(root), /Showing the first 100 of 150 graded assignments/); assert.match(walk(root).find((node) => node.attributes["aria-label"]?.includes("zone")).attributes["aria-label"], /zone/);
});
test("records deterministic initial-mount and 200-task render measurements against Phase 4F ceilings", () => {
    let time = 0; const now = () => ++time; const doc = new Document(); const host = doc.createElement("main"); const assignments = Array.from({ length: 200 }, (_, index) => ({ id: index + 1, name: `Assignment ${index + 1}`, points_possible: 10, submission: { score: 8 } }));
    const controller = ui.createGradeAnalyticsUI({ document: doc, domain, now }); controller.mount(host, { source: { assignments } }); const metrics = controller.renderMetrics();
    assert.ok(metrics.initialMountMs <= ui.PERFORMANCE_BUDGETS.initialMountMs, "initial mount remains under the 50 ms budget with deterministic clock instrumentation"); assert.ok(metrics.lastRenderMs <= ui.PERFORMANCE_BUDGETS.taskRender200Ms, "a 200-task render remains under the 100 ms budget with deterministic clock instrumentation"); assert.equal(metrics.renderedAssignments, ui.MAX_RENDERED_ROWS, "the visible work stays capped at 100 rows");
});
test("UI has no fetch, storage, Canvas mutation, registration, or navigation capability and CSS preserves narrow/reduced-motion/keyboard contracts", () => {
    const root = path.resolve(__dirname, "../.."); const source = fs.readFileSync(path.join(root, "js/content/grade-analytics-ui.js"), "utf8"); const css = fs.readFileSync(path.join(root, "css/grade-analytics.css"), "utf8");
    assert.doesNotMatch(source, /\b(?:fetch|XMLHttpRequest|chrome\.storage|localStorage|location\.(?:assign|href)|window\.open)\b/); assert.match(source, /materializeScenario/); assert.match(source, /MAX_RENDERED_ROWS/);
    assert.match(css, /@media \(max-width:700px\)/); assert.match(css, /prefers-reduced-motion:reduce/); assert.match(css, /:focus-visible/); assert.match(css, /overflow:auto/);
});
