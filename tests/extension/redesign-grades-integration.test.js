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
