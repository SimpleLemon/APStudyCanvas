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
const controllerSource = read("js/popup-controller.js");
const contentSource = read("js/content.js");

const KEY = "hide_dashboard_header";

test("hide_dashboard_header persists as an off-by-default course-card boolean", () => {
    assert.equal(schema.syncDefaults[KEY], false, "the header row ships visible");
    assert.equal(schema.validateSettingValue("sync", KEY, true).valid, true);
    assert.equal(schema.validateSettingValue("sync", KEY, false).valid, true);
    for (const value of ["on", 1, null, undefined, {}]) {
        assert.equal(schema.validateSettingValue("sync", KEY, value).valid, false, JSON.stringify(value));
    }
    assert.equal(schema.knownResettableKeys.includes(KEY), true, "support reset restores the default");
    assert.equal(schema.exportableSyncSettingKeys.includes(KEY), true, "settings backups carry the preference");
});

test("hide_dashboard_header is a live course-cards change on both classifier sides", () => {
    assert.equal(schema.liveApplyMode(KEY), "live", "hiding the row restyles the open Canvas page without a reload");
    assert.equal(schema.liveApplyGroup(KEY), "course-cards");
    assert.equal(settingsApply.classifyKey(KEY), "live");
    assert.equal(settingsApply.liveApplyGroup(KEY), "course-cards");
    assert.ok(schema.liveApplyGroups["course-cards"].includes(KEY));
    assert.ok(settingsApply.LIVE_APPLY_GROUPS["course-cards"].includes(KEY));
    assert.ok(settingsApply.OPERATION_KEYS.aesthetics.includes(KEY), "a change must re-run the aesthetics operation");
});

test("a live hide_dashboard_header change re-runs aesthetics exactly once and reports the key", () => {
    const applied = [];
    const applicator = settingsApply.createSettingsApplicator({
        document: { createElement: () => ({ textContent: "", remove() {} }) },
        operations: {
            aesthetics(settings) {
                applied.push(settings[KEY]);
                return true;
            }
        }
    });

    const first = applicator.applyChanges({ [KEY]: true }, { [KEY]: true }, { source: "settings-update" });
    assert.equal(first.applied, true);
    assert.deepEqual(applied, [true]);
    assert.ok(first.appliedKeys.includes(KEY));

    const echo = applicator.applyChanges({ [KEY]: true }, { [KEY]: true }, { source: "storage" });
    assert.equal(echo.applied, false, "a matching storage echo must not re-render");
    assert.deepEqual(applied, [true]);

    const off = applicator.applyChanges({ [KEY]: false }, { [KEY]: false }, { source: "settings-update" });
    assert.equal(off.applied, true);
    assert.deepEqual(applied, [true, false]);
});

test("content.js owns Canvas's dashboard header container through the aesthetics operation", () => {
    const applier = contentSource.match(/function applyDashboardHeaderHide\(\) \{[\s\S]*?\n\}/)?.[0];
    assert.ok(applier, "missing applyDashboardHeaderHide");
    assert.match(applier, /apstudycanvas-dashboard-header-hide/, "the hide rule must live in a dedicated style node, not the shared aesthetics sheet");
    assert.match(applier, /#dashboard_header_container\{display:none!important\}/, "the whole header row goes, not just one control");
    assert.match(applier, /style\.textContent !== text/, "the stylesheet write must be conditional to avoid self-sustaining refresh loops");
    assert.match(applier, /setProperty\("display", "none", "important"\)/, "the live element gets an inline display assertion");
    assert.match(applier, /removeProperty\("display"\)/, "turning the option off must undo the inline assertion");
    assert.match(contentSource, /function applyAestheticChanges\(\) \{\s*applyDashboardCompactPadding\(\);\s*applyDashboardHeaderHide\(\);/, "the aesthetics operation must drive the applier");
    assert.match(contentSource, /function hydrateDashboard\(\) \{\s*[\s\S]*?applyDashboardHeaderHide\(\);/, "dashboard hydration must re-assert the hide after Canvas repaints");
});

test("the Dashboard workspace toggle lives in the Course Cards section with a live note", () => {
    const section = popupHtml.match(/<section class="workspace-section" id="workspace-section-course-cards"[\s\S]*?<\/section>/)?.[0] || "";
    assert.ok(section, "missing the Course Cards workspace section");
    const row = section.match(/<label class="workspace-setting">[\s\S]*?data-popup-setting="hide_dashboard_header"><\/label>/)?.[0] || "";
    assert.ok(row, "the toggle must live in the Course Cards section");
    assert.match(row, /<strong>Hide dashboard header row<\/strong>/, "the row needs a visible name");
    assert.match(row, /<small>/, "the row needs a descriptive note");
    assert.match(row, /Updates the open Canvas page immediately/, "the note must say the hide is live");
    assert.match(row, /Dashboard title/, "the note must name the Dashboard title");
    assert.match(row, /Switch to new Dashboard view/, "the note must name the switch button");
    assert.match(row, /options menu/, "the note must disclose that the view options menu goes too");
});

test("popup binding and import paths accept the boolean", () => {
    assert.match(popupSource, /'hide_dashboard_header'/, "popup.js must sync the setting");
    const booleanSet = controllerSource.match(/const THEME_BOOLEAN_KEYS = new Set\(\[([\s\S]*?)\]\)/)?.[1] || "";
    assert.ok(booleanSet.includes(`"${KEY}"`), "theme import must treat the key as boolean");
    const allowedList = controllerSource.match(/const THEME_ALLOWED_SETTING_KEYS = Object.freeze\(\[([\s\S]*?)\]\)/)?.[1] || "";
    assert.ok(allowedList.includes(`"${KEY}"`), "theme import must accept the key");
});
