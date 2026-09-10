"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const schema = require("../../js/settings-schema.js");
const settingsApply = require("../../js/content/settings-apply.js");

const root = path.resolve(__dirname, "../..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const popupHtml = read("html/popup.html");
const popupSource = read("js/popup.js");
const contentSource = read("js/content.js");
const controllerSource = read("js/popup-controller.js");

const KEY = "todo_course_scope";
const OPTIONS = ["active", "all"];

test("todo_course_scope offers exactly the ring-scope options and ships active-only", () => {
    assert.deepEqual(schema.todoSettingOptions[KEY], OPTIONS);
    assert.equal(schema.todoSettingDescriptors.find((descriptor) => descriptor.key === KEY)?.section, "display");
    assert.equal(schema.todoSettingsDefaults[KEY], "active", "rings default to courses with active tasks");
    assert.equal(schema.validateSettingValue("sync", KEY, "active").valid, true);
    assert.equal(schema.validateSettingValue("sync", KEY, "all").valid, true);
    for (const value of ["none", "off", "Active", "", 0, 1, null, undefined, true, {}]) {
        assert.equal(schema.validateSettingValue("sync", KEY, value).valid, false, JSON.stringify(value));
    }
    assert.equal(schema.knownResettableKeys.includes(KEY), true, "support reset restores the default");
    assert.equal(schema.exportableSyncSettingKeys.includes(KEY), true, "settings backups carry the preference");
});

test("the ring scope is a live-reconciled todo change on both classifier sides", () => {
    assert.equal(schema.liveApplyMode(KEY), "live");
    assert.equal(schema.liveApplyGroup(KEY), "study-tools");
    assert.equal(schema.reloadApplyReason(KEY), null);
    assert.equal(settingsApply.classifyKey(KEY), "live");
    assert.equal(settingsApply.liveApplyGroup(KEY), "study-tools");
    assert.equal(settingsApply.RELOAD_APPLY_REASONS[KEY], undefined);
});

test("renderProgressRings filters ring courses by the saved ring scope", () => {
    const renderer = contentSource.match(/function renderProgressRings\(container, scopedData\) \{[\s\S]*?\n\}/)?.[0];
    assert.ok(renderer, "missing renderProgressRings");
    assert.match(renderer, /const ringScope = options\.todo_course_scope === "all" \? "all" : "active";/, "unknown or absent values must fall back to active-only");
    assert.match(renderer, /\.filter\(e => e\.total > 0 && \(ringScope === "all" \|\| e\.completed < e\.total\)\)/, "active-only must drop courses whose work is entirely complete");
    assert.match(renderer, /recentAssignments\.forEach\(item => \{/, "ring groups must build from the time-windowed assignments, not the full planner dump");
    assert.match(renderer, /ts >= oneMonthAgo/, "the recency window must gate ring membership");
});

test("both rerender paths funnel the scope through renderProgressRings", () => {
    assert.equal(contentSource.match(/renderProgressRings\(progressPlaceholder, scopedData\)/g)?.length, 2, "the placeholder and completion-rerender paths must share the renderer");
    assert.match(contentSource, /options\.todo_progress_rings === undefined \|\| options\.todo_progress_rings === true/, "the legacy rings toggle still gates rendering before the scope filter");
});

test("the workspace ring row lives in Study Tools with the two scope options", () => {
    const section = popupHtml.match(/<section class="workspace-section" id="workspace-section-study-tools"[\s\S]*?<\/section>/)?.[0] || "";
    assert.ok(section, "missing the Study Tools workspace section");
    const row = section.match(/<div class="workspace-setting"><span><strong>Show rings for<\/strong>[\s\S]*?<\/div>/)?.[0] || "";
    assert.ok(row, "the ring-scope row must be named Show rings for");
    assert.match(row, /data-popup-setting="todo_course_scope"/);
    assert.doesNotMatch(row, /data-custom-dropdown/, "the Workspace ring scope uses its one labelled native select");
    assert.match(row, /Limit the dashboard progress rings to courses with active tasks or include all courses\./);
    OPTIONS.forEach((value) => assert.match(row, new RegExp(`<option value="${value}">`)));
});

test("the Workspace owns one accessible ring-scope picker", () => {
    const controls = [...popupHtml.matchAll(/<select\b[^>]*data-popup-setting="todo_course_scope"[^>]*>[\s\S]*?<\/select>/g)].map((match) => match[0]);
    assert.equal(controls.length, 1, "the modern Study Tools section is the only ring-scope owner");
    assert.match(controls[0], /aria-label="Show rings for"/);
    assert.deepEqual([...controls[0].matchAll(/<option value="([^"]+)">/g)].map((match) => match[1]), OPTIONS);
    assert.match(controllerSource, /function setControlValue\(control, value\)/, "the controller owns canonical programmatic control updates");
    const popupCss = read("css/popup.css");
    assert.match(popupCss, /\.workspace-setting input\[type="number"\], \.workspace-setting select \{[^}]*min-height:\s*44px/, "the picker has the active Workspace hit area");
    assert.doesNotMatch(popupHtml, /todo-ring-scope-label|class="sub-option"/, "no retired To-do row remains");
});

test("popup binds the ring scope through the settings store without duplicate controls", () => {
    assert.match(controllerSource, /qa\(`\[data-popup-setting="\$\{key\}"\]`\)\.forEach/, "settings writes synchronize current Workspace controls");
    assert.equal([...popupHtml.matchAll(/data-popup-setting="todo_course_scope"/g)].length, 1);
});
