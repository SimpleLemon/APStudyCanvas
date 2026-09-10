"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const schema = require("../../js/settings-schema.js");
const settingsApply = require("../../js/content/settings-apply.js");

class FakeNode {
    constructor(tagName = "div") {
        this.tagName = String(tagName).toUpperCase();
        this.nodeType = 1;
        this.parentNode = null;
        this.childNodes = [];
        this.textContent = "";
        this.id = "";
        this._attributes = new Map();
    }

    setAttribute(name, value) {
        this._attributes.set(String(name), String(value));
        if (String(name) === "id") this.id = String(value);
    }

    getAttribute(name) {
        return this._attributes.has(String(name)) ? this._attributes.get(String(name)) : null;
    }

    appendChild(node) {
        if (node.parentNode) node.parentNode.removeChild(node);
        this.childNodes.push(node);
        node.parentNode = this;
        return node;
    }

    removeChild(node) {
        const index = this.childNodes.indexOf(node);
        if (index >= 0) this.childNodes.splice(index, 1);
        node.parentNode = null;
        return node;
    }

    remove() {
        this.parentNode?.removeChild(this);
    }

    getElementById(id) {
        if (this.id === id) return this;
        for (const child of this.childNodes) {
            const found = child.getElementById?.(id);
            if (found) return found;
        }
        return null;
    }
}

class FakeDocument {
    constructor() {
        this.documentElement = new FakeNode("html");
        this.head = new FakeNode("head");
        this.documentElement.appendChild(this.head);
    }

    createElement(tagName) { return new FakeNode(tagName); }
    getElementById(id) { return this.documentElement.getElementById(id); }
}

test("schema and content-script live-apply groups stay aligned", () => {
    // Derived, not enumerated: a new group added to one side and forgotten on
    // the other used to slip past a hardcoded group list.
    assert.deepEqual(
        Object.keys(schema.liveApplyGroups).sort(),
        Object.keys(settingsApply.LIVE_APPLY_GROUPS).sort()
    );
    for (const group of Object.keys(schema.liveApplyGroups)) {
        assert.deepEqual(
            [...schema.liveApplyGroups[group]].sort(),
            [...settingsApply.LIVE_APPLY_GROUPS[group]].sort()
        );
    }
    assert.deepEqual(
        Object.keys(schema.reloadApplyReasons).sort(),
        Object.keys(settingsApply.RELOAD_APPLY_REASONS).sort()
    );
});

test("SETTINGS_UPDATE accepts live appearance and dashboard keys", () => {
    const sidebar = {
        validateSettingsUpdateRequest(request) {
            return { ok: true, payload: request.payload };
        }
    };
    const live = settingsApply.validateSettingsUpdateRequest({
        type: "SETTINGS_UPDATE",
        payload: { area: "sync", changes: { dark_mode: true, condensed_cards: true } }
    }, { validateSidebar: sidebar.validateSettingsUpdateRequest });
    assert.equal(live.ok, true);
    assert.deepEqual(live.payload.changes, { dark_mode: true, condensed_cards: true });
    assert.deepEqual(live.payload.reloadKeys, []);

    const mixed = settingsApply.validateSettingsUpdateRequest({
        type: "SETTINGS_UPDATE",
        payload: { area: "sync", changes: { dark_mode: false, assignments_due: true } }
    }, { validateSidebar: sidebar.validateSettingsUpdateRequest });
    assert.equal(mixed.ok, true);
    assert.deepEqual(mixed.payload.changes, { dark_mode: false, assignments_due: true });
    assert.deepEqual(mixed.payload.reloadKeys, []);

    const unknown = settingsApply.validateSettingsUpdateRequest({
        type: "SETTINGS_UPDATE",
        payload: { area: "sync", changes: { not_a_setting: true } }
    });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.code, "SETTINGS_KEY_UNSUPPORTED");
});

test("dashboard assignment and grade/GPA controls dispatch live operations without reload keys", () => {
    const assignmentKeys = ["assignment_date_format", "card_overdues", "relative_dues", "num_assignments"];
    const gradeKeys = ["dashboard_grades", "grade_hover", "gpa_calc", "gpa_calc_prepend", "gpa_calc_weighted", "gpa_calc_cumulative", "gpa_calc_bounds"];
    const values = {
        assignment_date_format: true,
        card_overdues: true,
        relative_dues: true,
        num_assignments: 6,
        dashboard_grades: true,
        grade_hover: true,
        gpa_calc: true,
        gpa_calc_prepend: true,
        gpa_calc_weighted: true,
        gpa_calc_cumulative: true,
        gpa_calc_bounds: { A: { cutoff: 93, gpa: 4 } }
    };
    const validated = settingsApply.validateSettingsUpdateRequest({
        type: "SETTINGS_UPDATE",
        payload: { area: "sync", changes: values }
    });
    assert.equal(validated.ok, true);
    assert.deepEqual(validated.payload.reloadKeys, []);
    assert.deepEqual(validated.payload.changes, values);

    const calls = [];
    const applicator = settingsApply.createSettingsApplicator({
        operations: {
            cardAssignments() { calls.push("assignments"); return true; },
            dashboardGrades() { calls.push("grades"); return true; }
        }
    });
    const message = applicator.applyChanges(values, values, { source: "settings-update" });
    const echo = applicator.applyChanges(values, values, { source: "storage" });
    assert.deepEqual(calls, ["assignments", "grades"], "each dashboard owner runs once for one message plus its storage echo");
    assert.deepEqual(message.reloadKeys, []);
    assert.deepEqual(echo.reloadKeys, []);
    assert.deepEqual(message.appliedKeys.sort(), Object.keys(values).sort());
    assert.equal(echo.applied, false);
    assignmentKeys.concat(gradeKeys).forEach((key) => assert.equal(settingsApply.classifyKey(key), "live", key));
    assert.equal(settingsApply.classifyKey("todo_hide_feedback"), "live");
    assert.equal(settingsApply.RELOAD_APPLY_REASONS.todo_hide_feedback, undefined);
});

test("re-applying the same value is a no-op and turning a style off removes the node", () => {
    const document = new FakeDocument();
    const applicator = settingsApply.createSettingsApplicator({
        document,
        operations: {
            aesthetics(settings, helpers) {
                helpers.upsertStyle("canvasrefined-aesthetics", settings.condensed_cards ? ".ic-DashboardCard__header_hero{height:60px}" : "");
            }
        }
    });

    const first = applicator.applyChanges({ condensed_cards: true }, { condensed_cards: true });
    assert.equal(first.applied, true);
    assert.equal(document.getElementById("canvasrefined-aesthetics").textContent.includes("height:60px"), true);
    assert.equal(applicator.stats().aesthetics, 1);

    const second = applicator.applyChanges({ condensed_cards: true }, { condensed_cards: true });
    assert.equal(second.rendered, false, "re-applying the same value never re-renders");
    assert.equal(second.applied, true, "the message still reports the live page truth so the popup cannot claim a reload is needed");
    assert.deepEqual(second.appliedKeys, ["condensed_cards"]);
    assert.equal(applicator.stats().aesthetics, 1);

    const off = applicator.applyChanges({ condensed_cards: false }, { condensed_cards: false });
    assert.equal(off.applied, true);
    assert.equal(document.getElementById("canvasrefined-aesthetics"), null);
    assert.equal(applicator.stats().aesthetics, 2);
});

test("a storage echo that wins the race lets the racing SETTINGS_UPDATE report already-live truth", () => {
    const document = new FakeDocument();
    const applicator = settingsApply.createSettingsApplicator({
        document,
        operations: {
            aesthetics(settings, helpers) {
                helpers.upsertStyle("canvasrefined-aesthetics", settings.condensed_cards ? ".ic-DashboardCard__header_hero{height:60px}" : "");
            }
        }
    });

    // The content script's own storage.onChanged apply lands first and renders.
    const echo = applicator.applyChanges({ condensed_cards: true }, { condensed_cards: true }, { source: "storage" });
    assert.equal(echo.applied, true);
    assert.equal(echo.rendered, true);
    assert.equal(applicator.stats().aesthetics, 1);

    // The popup's direct SETTINGS_UPDATE for the same value arrives second:
    // nothing re-renders, but the response must still report the change as
    // applied or the popup would surface a false "takes effect on reload".
    const message = applicator.applyChanges({ condensed_cards: true }, { condensed_cards: true }, { source: "settings-update" });
    assert.equal(message.applied, true);
    assert.equal(message.rendered, false);
    assert.deepEqual(message.appliedKeys, ["condensed_cards"]);
    assert.equal(applicator.stats().aesthetics, 1, "the racing message must not re-run the operation");

    // A storage echo that adds nothing keeps reporting applied:false.
    const quiet = applicator.applyChanges({ condensed_cards: true }, { condensed_cards: true }, { source: "storage" });
    assert.equal(quiet.applied, false);
    assert.equal(applicator.stats().aesthetics, 1);
});

test("one SETTINGS_UPDATE and a matching storage echo apply the operation once", () => {
    const document = new FakeDocument();
    const applicator = settingsApply.createSettingsApplicator({
        document,
        operations: {
            darkMode(settings, helpers) {
                helpers.upsertStyle("darkcss", settings.dark_mode ? ":root{color:inherit}" : "");
            }
        }
    });

    const fromMessage = applicator.applyChanges({ dark_mode: true }, { dark_mode: true }, { source: "settings-update" });
    const fromStorage = applicator.applyChanges({ dark_mode: true }, { dark_mode: true }, { source: "storage" });
    assert.equal(fromMessage.applied, true);
    assert.equal(fromStorage.applied, false);
    assert.equal(applicator.stats().darkMode, 1);
    assert.equal(document.head.childNodes.filter((node) => node.id === "darkcss").length, 1);
});

test("startup apply and a later off share one dark-mode implementation", () => {
    const document = new FakeDocument();
    const applicator = settingsApply.createSettingsApplicator({
        document,
        operations: {
            darkMode(settings, helpers) {
                helpers.upsertStyle("darkcss", settings.dark_mode ? ":root{color:inherit}" : "");
            }
        }
    });

    applicator.apply({ dark_mode: true }, { source: "startup" });
    assert.ok(document.getElementById("darkcss"));
    applicator.applyChanges({ dark_mode: false }, { dark_mode: false }, { source: "settings-update" });
    assert.equal(document.getElementById("darkcss"), null);
});
