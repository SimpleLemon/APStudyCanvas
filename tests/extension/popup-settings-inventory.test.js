"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const schema = require("../../js/settings-schema.js");
const settingsApply = require("../../js/content/settings-apply.js");

const popup = fs.readFileSync(path.join(__dirname, "../../html/popup.html"), "utf8");

function attribute(tag, name) {
    return tag.match(new RegExp(`\\b${name}=["']([^"']+)["']`, "i"))?.[1] || null;
}

function popupSettings(source) {
    const rows = [];
    const controls = [];
    const stack = [];
    const voidElements = new Set(["input", "br", "hr", "img", "meta", "link"]);
    const tags = /<\/?([a-z][\w:-]*)\b[^>]*>/gi;
    let cursor = 0;
    let match;
    while ((match = tags.exec(source))) {
        const text = source.slice(cursor, match.index);
        new Set(stack.map((element) => element.row).filter(Boolean)).forEach((row) => { row.copy += text; });
        cursor = tags.lastIndex;
        const tag = match[0];
        const closing = /^<\//.test(tag);
        if (closing) {
            const element = stack.pop();
            if (element?.startsSettingRow) rows.push(element.row);
            continue;
        }
        const className = attribute(tag, "class") || "";
        const isSettingRow = /\bworkspace-setting\b/.test(className);
        const parentRow = stack.at(-1)?.row || null;
        const row = isSettingRow ? { copy: "", controls: [] } : parentRow;
        const key = attribute(tag, "data-popup-setting");
        if (key) {
            assert.ok(row, `${key} must be inside a workspace setting row`);
            const control = { key, row };
            row.controls.push(control);
            controls.push(control);
        }
        if (!voidElements.has(match[1].toLowerCase()) && !/\/$/.test(tag)) {
            stack.push({ row, startsSettingRow: isSettingRow });
        } else if (isSettingRow) {
            rows.push(row);
        }
    }
    return controls;
}

test("every visible popup setting has an active sync key and an honest apply contract", () => {
    const activeSyncKeys = new Set(schema.settingKeysForArea("sync"));
    const operationForKey = new Map();
    Object.entries(settingsApply.OPERATION_KEYS).forEach(([operation, keys]) => {
        keys.forEach((key) => operationForKey.set(key, operation));
    });

    const controls = popupSettings(popup);
    assert.ok(controls.length > 0, "the popup must expose settings controls");
    controls.forEach(({ key, row }) => {
        assert.equal(activeSyncKeys.has(key), true, `${key} is an active sync setting`);
        const mode = schema.liveApplyMode(key);
        assert.ok(["live", "reload"].includes(mode), `${key} has a live or reload classification`);
        if (mode === "live") {
            assert.ok(operationForKey.has(key), `${key} maps to a declared live operation`);
            assert.doesNotMatch(row.copy, /(?:needs|requires?)\s+(?:a\s+)?(?:Canvas\s+)?(?:reload|refresh)|refresh\s+Canvas/i, `${key} does not claim a reload`);
        } else {
            assert.match(schema.reloadApplyReason(key) || "", /\S/, `${key} explains why it reloads`);
        }
    });
});

test("soon-live card and GPA controls never tell students to refresh Canvas", () => {
    const soonLiveKeys = new Set([
        "assignment_date_format", "card_overdues", "relative_dues", "num_assignments",
        "dashboard_grades", "grade_hover", "gpa_calc", "gpa_calc_prepend",
        "gpa_calc_weighted", "gpa_calc_cumulative"
    ]);
    const controls = popupSettings(popup).filter(({ key }) => soonLiveKeys.has(key));
    assert.equal(controls.length, 13, "every visible instance of the soon-live settings is covered");
    controls.forEach(({ key, row }) => {
        assert.doesNotMatch(row.copy, /(?:needs|requires?)\s+(?:a\s+)?(?:Canvas\s+)?(?:reload|refresh)|refresh\s+Canvas/i, `${key} has live wording`);
    });
});
