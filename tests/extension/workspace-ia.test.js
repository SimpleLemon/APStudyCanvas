"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const popup = fs.readFileSync(path.join(root, "html/popup.html"), "utf8");
const editor = fs.readFileSync(path.join(root, "js/edit-canvas.js"), "utf8");

test("Canvas Search is a dedicated Study category with route, compact-picker, and search parity", () => {
    assert.match(popup, /nav-group-study[\s\S]*data-workspace-target="canvas-search"[\s\S]*>Canvas Search</);
    assert.match(popup, /<option value="canvas-search">Canvas Search<\/option>/);
    assert.match(popup, /id="workspace-section-canvas-search" data-category="canvas-search"/);
    assert.match(popup, /Local only — no Nest transfer\. After Canvas loads, use Cmd\/Ctrl\+K to search\./);
    const gpaGradesSection = popup.match(/<section class="workspace-section" id="workspace-section-gpa-grades"[\s\S]*?<\/section>/)?.[0] || "";
    assert.doesNotMatch(gpaGradesSection, /canvas_search_enabled/);
    assert.match(editor, /\.workspace-section\[data-category\]/);
    assert.match(editor, /replaceWorkspaceCategoryInUrl\(applied\)/);
    assert.match(editor, /bindNavKeyboard\(\)/);
});

test("workspace exposes only canonical active compatibility controls and truthful adjacent copy", () => {
    ["assignment_sequence_footer_visible", "hide_infrastructure_footer", "quiz_safe_mode", "block_tool_scripts", "block_editor_scripts"].forEach((key) => {
        assert.match(popup, new RegExp(`data-popup-setting="${key}"`));
    });
    assert.doesNotMatch(popup, /data-popup-setting="block_planner_script"/);
    assert.match(popup, /APStudy navigation remains available\./);
    assert.match(popup, /Recommended\. Updates live on assessment-like routes/);
    assert.match(popup, /fails open for this session\. Refresh to retry\./);
    assert.match(popup, /read-only Grade overview to the global Grades page and per-course analytics to each course Grades page\. It never changes Canvas grades/);
    assert.match(popup, /Writes only APStudy-owned Planner Notes\./);
    assert.match(popup, /Appears only when card grades are enabled\.[\s\S]*never writes Canvas grades\./);
});
