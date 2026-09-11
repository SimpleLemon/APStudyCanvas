"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const editCanvas = fs.readFileSync(path.join(root, "js/edit-canvas.js"), "utf8");
const popup = fs.readFileSync(path.join(root, "html/popup.html"), "utf8");
const content = fs.readFileSync(path.join(root, "js/content.js"), "utf8");
const overlayHost = fs.readFileSync(path.join(root, "js/content/overlay-host.js"), "utf8");
const router = fs.readFileSync(path.join(root, "js/platform/router.js"), "utf8");

test("popup registers Planner assets in dependency order", () => {
    const adapter = popup.indexOf("../js/workspace-planner-adapter.js");
    const planner = popup.indexOf("../js/workspace-planner.js");
    const controller = popup.indexOf("../js/edit-canvas.js");
    assert.ok(adapter > 0 && planner > adapter && controller > planner);
    assert.match(popup, /css\/workspace-planner\.css/);
});

test("Planner integration creates a fresh adapter with only existing bridge families and scoped persistence", () => {
    for (const family of ["NEST_CALENDAR_RANGE_GET", "NEST_CALENDAR_EVENT_CREATE", "NEST_CALENDAR_EVENT_UPDATE", "NEST_CALENDAR_EVENT_DELETE"]) {
        assert.match(editCanvas, new RegExp(`"${family}"`));
    }
    assert.match(editCanvas, /createPlannerAdapter\(\{[\s\S]*send: sendPlannerBridge,[\s\S]*getAccount: verifiedModuleAccount,[\s\S]*importLedger: createPlannerImportLedger/);
    assert.match(editCanvas, /apstudycanvas\.planner\.import-ledger\.v1:/);
    assert.match(editCanvas, /preferences: localStorageAdapter\(\)/);
    assert.match(editCanvas, /editable: false[\s\S]*source_label: "Local tasks"/);
    assert.match(editCanvas, /connection\?\.getSnapshot\?\.\(\)/);
    assert.match(editCanvas, /granted: item\.granted === true \|\| \(item\.valid === true && item\.current === true/);
});

test("Canvas Search routes to the existing content search UI through an exact overlay action", () => {
    assert.match(editCanvas, /action: "canvas-search"/);
    assert.match(editCanvas, /overlayControl\?\.\("canvas-search"\)/);
    assert.match(overlayHost, /"canvas-search"/);
    assert.match(router, /"canvas-search"/);
    assert.match(content, /event\?\.action === "canvas-search"[\s\S]*return ensurePhaseFourSearch\(\)\.then\(\(\) => contentCanvasSearchUi\?\.show/);
    assert.doesNotMatch(editCanvas, /openModernTarget\(entry\.target, entry\.category[\s\S]{0,120}canvas-search-route/);
});

test("Grades read seam is authenticated, bounded, complete, and rechecks account identity", () => {
    assert.match(overlayHost, /action === "grades-read"[\s\S]*\["courses", "course"\]/);
    assert.match(content, /async function readWorkspaceGrades/);
    assert.match(content, /phaseFourCanvasContext\(\)[\s\S]*fetchPhaseFourGradeAnalyticsCollection[\s\S]*phaseFourCanvasContext\(\)/);
    assert.match(content, /assignments: \{ items: assignments, complete: true \}/);
    assert.match(content, /assignmentGroups: \{ items: assignmentGroups, complete: true \}/);
    assert.match(content, /GRADES_ACCOUNT_STALE/);
});
