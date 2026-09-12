"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const registration = require("../../js/platform/canvas-registration.js");

const root = path.resolve(__dirname, "../..");
const popup = fs.readFileSync(path.join(root, "html/popup.html"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const editCanvas = fs.readFileSync(path.join(root, "js/edit-canvas.js"), "utf8");
const content = fs.readFileSync(path.join(root, "js/content.js"), "utf8");

test("popup loads the shared Grades component and dependencies before its entrypoint", () => {
    const order = [
        "../js/content/grade-analytics.js",
        "../js/content/gpa.js",
        "../js/content/workspace-model.js",
        "../js/workspace-grades-domain.js",
        "../js/workspace-grades.js",
        "../js/edit-canvas.js"
    ].map(file => popup.indexOf(file));
    assert.ok(order.every(index => index > 0));
    assert.deepEqual(order.slice().sort((a, b) => a - b), order);
    assert.match(popup, /css\/workspace-grades\.css/);
});

test("static and dynamic Canvas registration load the shared Grades component after its dependencies", () => {
    const canvas = manifest.content_scripts.find(entry => entry.js?.includes("js/content.js"));
    assert.deepEqual(canvas.js, registration.CANVAS_CONTENT_SCRIPTS);
    assert.deepEqual(canvas.css, registration.CANVAS_CSS);
    for (const scripts of [canvas.js, registration.CANVAS_CONTENT_SCRIPTS]) {
        assert.ok(scripts.indexOf("js/content/grade-analytics.js") < scripts.indexOf("js/workspace-grades-domain.js"));
        assert.ok(scripts.indexOf("js/content/gpa.js") < scripts.indexOf("js/workspace-grades-domain.js"));
        assert.ok(scripts.indexOf("js/workspace-grades-domain.js") < scripts.indexOf("js/workspace-grades.js"));
        assert.ok(scripts.indexOf("js/workspace-grades.js") < scripts.indexOf("js/content.js"));
    }
    assert.ok(canvas.css.includes("css/workspace-grades.css"));
});

test("popup Grades uses the exact shared module API and existing authenticated read bridge", () => {
    assert.match(editCanvas, /APStudyCanvasWorkspaceGradesUI/);
    assert.match(editCanvas, /uiApi\.createGradesModule\(\{/);
    assert.doesNotMatch(editCanvas, /createGradesWorkspace\(\{/);
    assert.match(editCanvas, /overlayControl\?\.\("grades-read"/);
    assert.match(editCanvas, /readCourses: signal => readPopupGrades\("courses"/);
    assert.match(editCanvas, /readCourseGradeData: \(courseId, signal\) => readPopupGrades\("course"/);
});

test("popup Grades preserves legacy workspace keys and separates preferences and scenarios", () => {
    assert.match(editCanvas, /createLegacyWorkspaceStore\(account\)/);
    assert.match(editCanvas, /saveWorkspaceGrades: grades => workspaceStore\.transact\(record => \{ record\.grades = grades; \}\)/);
    assert.match(editCanvas, /createChartPreferenceStore\(\{ storage: localStorageAdapter\(\), account/);
    assert.match(editCanvas, /apstudycanvas\.grades\.scenario\.v1:/);
    assert.match(editCanvas, /context\.origin\}:\$\{context\.accountId\}:\$\{key\}/);
    assert.match(editCanvas, /assertLegacyWorkspaceAccount\(expected\)[\s\S]*storageCall\("local", "set"[\s\S]*assertLegacyWorkspaceAccount\(expected\)/);
});

test("native global and course Grades routes mount the same shared workspace in an owned child", () => {
    assert.match(content, /contentWorkspaceGradesUiApi\.createGradesWorkspace\(\{/);
    assert.match(content, /workspace\.mount\(host, \{ mode: "canvas", route/);
    assert.match(content, /phaseFourGlobalGradesRoute\(pathname\)/);
    assert.match(content, /phaseFourGradeCourseId\(pathname\)/);
    assert.match(content, /canvasHost\.append\(host\)/);
    assert.doesNotMatch(content, /canvasHost\.replaceChildren\(host\)/);
});

test("native Grades injects bounded reads, legacy storage, separate preferences, and stale guards", () => {
    assert.match(content, /createGradeReadAdapter\(\{[\s\S]*verifyAccount: nativeGradesAccount/);
    assert.match(content, /maxItems: 100/);
    assert.match(content, /maxItems: 500/);
    assert.match(content, /contentWorkspaceModelApi\.createStore\(\{[\s\S]*verify: \(\) => verifyNativeGradesLegacyContext/);
    assert.match(content, /createChartPreferenceStore\(\{ storage, account, verifyAccount: nativeGradesAccount \}\)/);
    assert.match(content, /CONTENT_GRADES_SCENARIO_PREFIX/);
    assert.match(content, /verifyNativeGradesLegacyContext\(expected\)[\s\S]*storageAreaSet[\s\S]*verifyNativeGradesLegacyContext\(expected\)/);
});

test("native Grades owns active rendering and tears down on every existing privacy boundary", () => {
    assert.match(content, /teardownPhaseFourFeatures[\s\S]*teardownNativeGradesWorkspace\(reason\)/);
    assert.match(content, /syncPhaseFourFeatures[\s\S]*return ensureNativeGradesWorkspace\(\)/);
    assert.match(content, /workspace\?\.dispose\?\.\(reason\)/);
    assert.match(content, /contentGradesWorkspaceDirty[\s\S]*beforeunload/);
});
