"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const schema = require("../../js/settings-schema.js");
const settingsApply = require("../../js/content/settings-apply.js");

const root = path.resolve(__dirname, "../..");
const content = fs.readFileSync(path.join(root, "js/content.js"), "utf8");
const popup = fs.readFileSync(path.join(root, "html/popup.html"), "utf8");

test("infrastructure footer hiding is opt-in, live, and reversible", () => {
    const key = "hide_infrastructure_footer";
    assert.equal(schema.defaultsForArea("sync")[key], false);
    assert.equal(schema.validateSettingValue("sync", key, true).valid, true);
    assert.equal(schema.validateSettingValue("sync", key, "true").valid, false);
    assert.equal(schema.liveApplyMode(key), "live");
    assert.equal(schema.liveApplyGroup(key), "appearance");
    assert.equal(settingsApply.classifyKey(key), "live");
    assert.equal(settingsApply.liveApplyGroup(key), "appearance");
    assert.match(popup, /Hide infrastructure footer[\s\S]*?data-popup-setting="hide_infrastructure_footer"/);
    assert.match(content, /function applyInfrastructureFooterHide\(\)[\s\S]*?footer#footer\.ic-app-footer\[role='contentinfo'\]\{display:none!important\}/);
    assert.doesNotMatch(content, /document\.getElementById\("footer"\)\?\.remove\(\)/);
});
