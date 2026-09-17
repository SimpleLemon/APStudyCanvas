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

const KEY = "wide_course_cards";
const ATTRIBUTE = "data-apstudycanvas-wide-course-cards";

test("wide_course_cards is an off-by-default, resettable, exportable boolean", () => {
    assert.equal(schema.syncDefaults[KEY], false);
    assert.deepEqual(schema.validateSettingValue("sync", KEY, true), { valid: true, value: true });
    assert.deepEqual(schema.validateSettingValue("sync", KEY, false), { valid: true, value: false });
    assert.equal(schema.validateSettingValue("sync", KEY, "true").valid, false);
    assert.ok(schema.knownResettableKeys.includes(KEY));
    assert.ok(schema.exportableSyncSettingKeys.includes(KEY));
});

test("wide_course_cards is live-applied through the course-card aesthetics operation", () => {
    assert.equal(schema.liveApplyMode(KEY), "live");
    assert.equal(schema.liveApplyGroup(KEY), "course-cards");
    assert.equal(settingsApply.classifyKey(KEY), "live");
    assert.equal(settingsApply.liveApplyGroup(KEY), "course-cards");
    assert.ok(settingsApply.OPERATION_KEYS.aesthetics.includes(KEY));
});

test("the wider-card switch follows compact padding in Course Cards settings", () => {
    const section = popupHtml.match(/<section class="workspace-section" id="workspace-section-course-cards"[\s\S]*?<\/section>/)?.[0] || "";
    const compactIndex = section.indexOf('data-popup-setting="dashboard_compact_padding"');
    const wideIndex = section.indexOf(`data-popup-setting="${KEY}"`);
    assert.ok(compactIndex >= 0, "missing compact card-section padding control");
    assert.ok(wideIndex > compactIndex, "the wider-card switch must sit under compact padding");
    assert.match(section, /<strong>Wider course cards<\/strong>/);
    assert.match(section, /Stretch cards evenly to fill each row/);
    assert.match(section, /Compact padding leaves more room for every card/);
    assert.match(popupSource, new RegExp(`^const syncedSwitches = \\[[^\\]]*'${KEY}'`));
    const booleanKeys = controllerSource.match(/const THEME_BOOLEAN_KEYS = new Set\(\[([\s\S]*?)\]\)/)?.[1] || "";
    assert.ok(booleanKeys.includes(`"${KEY}"`), "theme import must treat the switch as boolean");
});

test("content owns a reversible root attribute for the wider-card layout", () => {
    const applier = contentSource.match(/function applyWideCourseCards\(\) \{[\s\S]*?\n\}/)?.[0] || "";
    assert.ok(applier, "missing applyWideCourseCards");
    assert.match(applier, new RegExp(ATTRIBUTE));
    assert.match(applier, /options\.wide_course_cards === true/);
    assert.match(applier, /setAttribute\?\.\(attribute, "true"\)/);
    assert.match(applier, /removeAttribute\?\.\(attribute\)/);
    assert.match(contentSource, /function applyAestheticChanges\(\) \{[\s\S]*?applyWideCourseCards\(\);/);
});

test("wider cards use equal flexible columns without owning section padding", () => {
    const rules = Array.from(contentCss.matchAll(/([^{}]+)\{([^}]*)\}/g), (match) => ({
        selector: match[1].replace(/\/\*[\s\S]*?\*\//g, "").trim(),
        body: match[2]
    }));
    const wideRules = rules.filter((rule) => rule.selector.includes(`[${ATTRIBUTE}="true"]`));
    const container = wideRules.find((rule) => /\.ic-DashboardCard__box__container$/.test(rule.selector) && rule.body.includes("grid-template-columns"));
    assert.ok(container, "the wide layout must turn the card container into a flexible grid");
    assert.match(container.body, /display:\s*grid\s*!important/);
    assert.match(container.body, /repeat\(auto-fit,\s*minmax\(min\(100%,\s*262px\),\s*1fr\)\)/);
    assert.match(container.body, /align-items:\s*start/, "changing width must not force every card to the tallest row height");
    assert.match(container.body, /column-gap:\s*12px\s*!important/);
    assert.doesNotMatch(container.body, /padding/, "wide cards must preserve Canvas or compact section padding");

    const card = wideRules.find((rule) => /\.ic-DashboardCard$/.test(rule.selector));
    assert.ok(card, "the cards must fill their flexible tracks");
    assert.match(card.body, /width:\s*100%\s*!important/);
    assert.match(card.body, /margin-inline-start:\s*0\s*!important/);
    assert.match(card.body, /margin-inline-end:\s*0\s*!important/);

    for (const [level, gap] of Object.entries({ minimal: 10, medium: 8, high: 4 })) {
        const interaction = rules.find((rule) => rule.selector.includes(`[${ATTRIBUTE}="true"]`) && rule.selector.includes(`data-apstudycanvas-dashboard-compact-padding="${level}"`));
        assert.ok(interaction, `missing ${level} compact-padding interaction`);
        assert.match(interaction.body, new RegExp(`column-gap:\\s*${gap}px\\s*!important`));
        assert.doesNotMatch(interaction.body, /padding|grid-template-columns|width/, "compact interaction may only change the gap");
    }
});
