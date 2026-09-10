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
const contentCss = read("css/content.css");

const KEY = "dashboard_compact_padding";
const ATTRIBUTE = "data-apstudycanvas-dashboard-compact-padding";
const LEVELS = ["minimal", "medium", "high"];

test("dashboard_compact_padding persists as a default-medium course-card level enum", () => {
    assert.equal(schema.syncDefaults[KEY], "medium", "the trim ships on at the medium level");
    for (const value of [...LEVELS, "off"]) {
        assert.equal(schema.validateSettingValue("sync", KEY, value).valid, true, JSON.stringify(value));
    }
    for (const value of ["on", 1, null, undefined, "maximum", {}]) {
        assert.equal(schema.validateSettingValue("sync", KEY, value).valid, false, JSON.stringify(value));
    }
    assert.equal(schema.knownResettableKeys.includes(KEY), true, "support reset restores the default");
    assert.equal(schema.exportableSyncSettingKeys.includes(KEY), true, "settings backups carry the preference");
});

test("legacy boolean installs normalize into the shipped medium level", () => {
    assert.equal(schema.normalizeDashboardCompactPadding(true), "medium");
    assert.equal(schema.normalizeDashboardCompactPadding(false), "medium");
    assert.equal(schema.normalizeDashboardCompactPadding("high"), "high");
    assert.equal(schema.normalizeDashboardCompactPadding("off"), "off");
    assert.equal(schema.normalizeDashboardCompactPadding("nonsense"), null);
    const legacyOn = schema.validateSettingValue("sync", KEY, true);
    assert.deepEqual(legacyOn, { valid: true, value: "medium" }, "stored booleans never reach storage raw");
});

test("dashboard_compact_padding is a live course-cards change on both classifier sides", () => {
    assert.equal(schema.liveApplyMode(KEY), "live", "the trim restyles the open Canvas page without a reload");
    assert.equal(schema.liveApplyGroup(KEY), "course-cards");
    assert.equal(settingsApply.classifyKey(KEY), "live");
    assert.equal(settingsApply.liveApplyGroup(KEY), "course-cards");
    assert.ok(schema.liveApplyGroups["course-cards"].includes(KEY));
    assert.ok(settingsApply.LIVE_APPLY_GROUPS["course-cards"].includes(KEY));
    assert.ok(settingsApply.OPERATION_KEYS.aesthetics.includes(KEY), "a change must re-run the aesthetics operation");
});

test("a live dashboard_compact_padding change re-runs aesthetics exactly once and reports the key", () => {
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

    const first = applicator.applyChanges({ [KEY]: "medium" }, { [KEY]: "medium" }, { source: "settings-update" });
    assert.equal(first.applied, true);
    assert.deepEqual(applied, ["medium"]);
    assert.ok(first.appliedKeys.includes(KEY));

    const echo = applicator.applyChanges({ [KEY]: "medium" }, { [KEY]: "medium" }, { source: "storage" });
    assert.equal(echo.applied, false, "a matching storage echo must not re-render");
    assert.deepEqual(applied, ["medium"]);

    const high = applicator.applyChanges({ [KEY]: "high" }, { [KEY]: "high" }, { source: "settings-update" });
    assert.equal(high.applied, true);
    assert.deepEqual(applied, ["medium", "high"]);
});

test("the Dashboard workspace tri-toggle lives in the Course Cards section with a live note", () => {
    const section = popupHtml.match(/<section class="workspace-section" id="workspace-section-course-cards"[\s\S]*?<\/section>/)?.[0] || "";
    assert.ok(section, "missing the Course Cards workspace section");
    const row = section.match(/<div class="workspace-setting">[\s\S]*?data-popup-setting="dashboard_compact_padding"[\s\S]*?<\/div>/)?.[0] || "";
    assert.ok(row, "the tri-toggle must live in the Course Cards section");
    assert.match(row, /<strong>Compact card-section padding<\/strong>/, "the row needs a visible name");
    assert.match(row, /<small>/, "the row needs a descriptive note");
    assert.match(row, /role="group"/, "the three toggles form one labelled group");
    for (const level of LEVELS) {
        assert.match(row, new RegExp(`data-setting-value="${level}"`), `the ${level} toggle must exist`);
    }
    assert.doesNotMatch(row, /data-value-type/, "the control is an enum, not a number");
    assert.match(row, /Updates the open Canvas page immediately/, "the note must say the trim is live");
    assert.doesNotMatch(row, /Minimal, Medium, and High/, "the level-by-level copy stays out of the note");
    assert.doesNotMatch(row, /tighten the gaps between the cards/, "the gap copy stays out of the note");
    assert.doesNotMatch(row, /keeping the card rows centered/, "the centering copy stays out of the note");
    assert.doesNotMatch(row, /card width stays unchanged/, "the card-width copy stays out of the note");
    const labels = row.match(/<label for="compact-padding-\w+">[^<]+<\/label>/g) || [];
    assert.deepEqual(labels.map((label) => label.replace(/<[^>]+>/g, "")), ["Minimal", "Medium", "High"]);
});

test("popup binding and import paths accept the level enum", () => {
    assert.match(popupSource, new RegExp(`^const syncedSwitches = \\[[^\\]]*'${KEY}'`), "popup.js must sync the setting");
    assert.match(controllerSource, new RegExp(`"${KEY}"`), "popup-controller.js must allowlist the key");
    const booleanSet = controllerSource.match(/const THEME_BOOLEAN_KEYS = new Set\(\[([\s\S]*?)\]\)/)?.[1] || "";
    assert.doesNotMatch(booleanSet, new RegExp(`"${KEY}"`), "theme import must not treat the key as boolean");
    const allowedList = controllerSource.match(/const THEME_ALLOWED_SETTING_KEYS = Object.freeze\(\[([\s\S]*?)\]\)/)?.[1] || "";
    assert.ok(allowedList.includes(`"${KEY}"`), "theme import must accept the key");
    assert.match(controllerSource, /dashboard_compact_padding"\s*\)\s*return typeof value === "boolean"/s, "theme import must accept the legacy boolean");
    assert.match(controllerSource, /normalizeImportedSettingChanges/, "theme import must canonicalize stored values");
    assert.doesNotMatch(booleanSet, new RegExp(`"${KEY}"`), "the extracted import path must not treat the enum as boolean");
    assert.match(controllerSource, /normalizeDashboardCompactPadding\?\.\(output\.dashboard_compact_padding\)/, "the extracted import path must canonicalize legacy booleans before storage");
});

test("content.js owns the root attribute through the aesthetics operation", () => {
    assert.match(contentSource, /function applyAestheticChanges\(\) \{\s*applyDashboardCompactPadding\(\);/);
    const applier = contentSource.match(/function applyDashboardCompactPadding\(\) \{[\s\S]*?\n\}/)?.[0] || "";
    assert.ok(applier, "missing applyDashboardCompactPadding");
    assert.match(applier, /normalizeDashboardCompactPadding/, "the level must come from the shared schema normalizer");
    assert.match(applier, /setAttribute\?\.\(attribute, level\)/);
    assert.match(applier, /removeAttribute\?\.\(attribute\)/);
    assert.doesNotMatch(applier, /body\b/, "the attribute belongs on the root element only");
});

test("content.css gates three card-section levels and three content-column levels behind the root attribute", () => {
    const rules = Array.from(contentCss.matchAll(/([^{}]+)\{([^}]*)\}/g), (match) => ({
        selector: match[1].replace(/\/\*[\s\S]*?\*\//g, "").trim(),
        body: match[2]
    }));
    const attr = (level) => `html\\[${ATTRIBUTE}="${level}"\\]`;
    const cardRules = rules.filter((rule) => rule.body.includes("padding-inline") && /\.ic-DashboardCard__box/.test(rule.selector));
    assert.equal(cardRules.length, 3, "exactly the three levels may restyle the card section's padding");
    cardRules.forEach((rule, index) => {
        // Current Canvas renders the card section as .ic-DashboardCard__box__container
        // (the flex wrapper inside #DashboardCard_Container); the legacy
        // .ic-DashboardCard__box stays as a fallback for older markup.
        assert.match(rule.selector, new RegExp(`${attr(LEVELS[index])} \\.ic-DashboardCard__box__container`));
        assert.match(rule.body, /padding-inline:\s*\d+px\s*!important/);
        for (const banned of ["width", "margin", "gap", "padding-block", "padding-top", "padding-bottom"]) {
            assert.equal(rule.body.includes(banned), false, `the trim must not touch ${banned}`);
        }
    });
    const contentRules = rules.filter((rule) => /\.ic-Layout-contentMain/.test(rule.selector) && rule.body.includes("padding-inline"));
    assert.equal(contentRules.length, 3, "each level must trim the main content column's side padding");
    contentRules.forEach((rule, index) => {
        assert.match(rule.selector, new RegExp(`${attr(LEVELS[index])} \\.ic-Layout-contentMain`), `level ${LEVELS[index]} must gate its content rule`);
        assert.doesNotMatch(rule.body, /padding-inline:\s*0/, "no level may fully remove the content gutters");
    });
    const highContentRule = contentRules.find((rule) => rule.selector.includes('="high"'));
    assert.match(highContentRule.body, /padding-inline:\s*4px/, "high must keep a narrow gutter, not collapse it");
    for (const level of LEVELS) {
        // Canvas lays the cards out as inline-blocks spaced by a 12px inline-start
        // margin per card, compensated by -12px on the plain block container, so
        // each level shortens the card margin and re-compensates the container.
        const gap = { minimal: 10, medium: 8, high: 4 }[level];
        const containerRule = rules.find((rule) => new RegExp(`^${attr(level)} \\.ic-DashboardCard__box__container$`).test(rule.selector.trim()) && rule.body.includes("margin-inline-start"));
        assert.ok(containerRule, `level ${level} must re-compensate the container's inline-start margin`);
        assert.match(containerRule.body, new RegExp(`margin-inline-start:\\s*-${gap}px\\s*!important`), `level ${level} must compensate the ${gap}px card margin`);
        const cardRule = rules.find((rule) => new RegExp(`^${attr(level)} \\.ic-DashboardCard__box__container \\.ic-DashboardCard$`).test(rule.selector.trim()));
        assert.ok(cardRule, `level ${level} must own the card margin that spaces the row`);
        assert.match(cardRule.body, new RegExp(`margin-inline-start:\\s*${gap}px\\s*!important`), `level ${level} must shrink the default 12px gap to ${gap}px, never 0`);
        assert.doesNotMatch(cardRule.body, /margin-bottom|margin-inline-end/, "vertical spacing and the far edge stay Canvas's own");
    }
    assert.deepEqual(LEVELS.map((level) => ({ minimal: 10, medium: 8, high: 4 }[level])), [10, 8, 4], "the gap ladder shrinks strictly per level and never reaches zero");
    assert.doesNotMatch(contentCss, /column-gap\s*:/, "column-gap is inert on Canvas's block container and must not come back");
    const centerRules = rules.filter((rule) => rule.selector.includes(ATTRIBUTE) && rule.body.includes("justify-content"));
    assert.equal(centerRules.length, 0, "justify-content does nothing on Canvas's block container");
    const mobileBlock = contentCss.match(/@media only screen and \(max-width: 620px\) \{[\s\S]*?\n\}/)?.[0] || "";
    assert.ok(mobileBlock, "Canvas's single-card breakpoint must keep Canvas's own zero margins");
    for (const level of LEVELS) {
        assert.match(mobileBlock, new RegExp(attr(level)), `the mobile exception must cover level ${level}`);
    }
    assert.match(mobileBlock, /margin-inline-start:\s*0\s*!important/, "full-width cards keep Canvas's own zero margin");
    const wrapperRule = rules.find((rule) => /\.ic-Layout-wrapper/.test(rule.selector) && rule.body.includes("max-width"));
    assert.ok(wrapperRule, "high must lift the wrapper's max-width cap to maximize horizontal space");
    assert.match(wrapperRule.selector, new RegExp(`${attr("high")} \\.ic-Layout-wrapper`), "the wrapper lift must stay behind the high level");
    assert.doesNotMatch(contentCss, new RegExp(`${ATTRIBUTE}="on"`), "the legacy single-level attribute value must be gone");
    assert.doesNotMatch(contentCss, new RegExp(`${ATTRIBUTE}[^{}]*\\{[^}]*(?:cardWidth|cardSpacing|\\.ic-DashboardCard\\s*\\{)`), "the attribute must never gate card sizing");
});
