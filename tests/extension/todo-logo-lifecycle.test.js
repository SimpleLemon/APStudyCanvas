"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.resolve(__dirname, "../../js/content.js"), "utf8");
const todoCss = fs.readFileSync(path.resolve(__dirname, "../../css/todo-right-rail.css"), "utf8");
const helperStart = source.indexOf("const TODO_INSTITUTION_LOGO_SELECTOR");
const helperEnd = source.indexOf("\nfunction createTodoIntegration()", helperStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart, "Todo institution-logo controller is present");
const createController = new Function(`${source.slice(helperStart, helperEnd)}\nreturn createTodoInstitutionLogoController;`)();

class FakeLogo {
    constructor(attributes = {}) {
        this.attributes = new Map(Object.entries(attributes));
        this.hidden = this.attributes.has("hidden");
    }

    getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
    setAttribute(name, value) { this.attributes.set(name, String(value)); if (name === "hidden") this.hidden = true; }
    removeAttribute(name) { this.attributes.delete(name); if (name === "hidden") this.hidden = false; }
}

test("Todo logo controller owns only Canvas’s institutional mark and restores exact attributes", () => {
    const logo = new FakeLogo({ hidden: "until-found", "aria-hidden": "false", "data-apstudycanvas-todo-logo-visibility": "canvas" });
    const document = { querySelectorAll(selector) {
        // The global TODO_INSTITUTION_LOGO_SELECTOR owns the Canvas mark by its
        // Canvas-specific class, regardless of which dashboard wrapper wraps it.
        assert.equal(selector, ".ic-sidebar-logo, .ic-sidebar-logo__image");
        return [logo];
    } };
    const controller = createController(document);

    controller.apply(false);
    assert.equal(logo.hidden, true);
    assert.match(logo.getAttribute("style"), /display:\s*none\s*!important/);
    assert.equal(logo.getAttribute("aria-hidden"), "true");
    assert.equal(logo.getAttribute("data-apstudycanvas-todo-logo-visibility"), "hidden");

    controller.apply(true);
    assert.equal(logo.getAttribute("hidden"), "until-found");
    assert.equal(logo.hidden, true);
    assert.equal(logo.getAttribute("style"), null);
    assert.equal(logo.getAttribute("aria-hidden"), "false");
    assert.equal(logo.getAttribute("data-apstudycanvas-todo-logo-visibility"), "canvas");
});

test("Todo logo controller is a safe no-op when Canvas does not expose the mark", () => {
    const controller = createController({ querySelectorAll() { return []; } });
    assert.equal(controller.apply(false), 0);
    controller.restore();
});

test("Todo-owned logo marker wins over Canvas display rules", () => {
    // Both the wrapper mark and its image element are keyed on the ownership
    // attribute, without a #right-side scope, so every dashboard variant holds.
    assert.match(
        todoCss,
        /\.ic-sidebar-logo\[data-apstudycanvas-todo-logo-visibility="hidden"\][^{}]*\{[^}]*display:\s*none\s*!important;/s
    );
    assert.match(
        todoCss,
        /\.ic-sidebar-logo__image\[data-apstudycanvas-todo-logo-visibility="hidden"\][^{}]*\{[^}]*display:\s*none\s*!important;/s
    );
});

test("Todo lifecycle restores the institutional mark on teardown and non-stale failures", () => {
    assert.match(source, /function removeRail\(\) \{\s*institutionLogo\.restore\(\);/);
    // The persisted opt-in is applied by both render and settings changes;
    // false still keeps Nest chrome authoritative, while true restores Canvas.
    assert.match(source, /institutionLogo\.apply\(settings\(\)\.todo_institution_logo_visible === true\);\s*if \(railMounted\) stopTodoInstitutionLogoPrepaint\(\);/);
    assert.match(source, /institutionLogo\.apply\(settings\(\)\.todo_institution_logo_visible === true\);\s*schedule\("settings"\);/);
    assert.match(source, /if \(!currentBinding\) \{\s*institutionLogo\.restore\(\);/);
    assert.match(source, /if \(!range\) \{\s*institutionLogo\.restore\(\);/);
    assert.match(source, /if \(stale\(\) \|\| error\?\.name === "AbortError"\) return[\s\S]*?institutionLogo\.restore\(\);/);
});

test("the institutional mark is hidden from the earliest page state by a document_start prepaint", () => {
    // The prepaint uses the resolved preference while Canvas is still parsing;
    // absent storage falls back to the schema default, while an explicit opt-in
    // restores Canvas's mark through the same ownership controller.
    assert.match(source, /function startTodoInstitutionLogoPrepaint\(\)/);
    assert.match(source, /startTodoInstitutionLogoPrepaint\(\);/);
    assert.match(source, /function todoInstitutionLogoVisible\(\) \{\s*return todoSettingsSnapshot\(options\)\.settings\.todo_institution_logo_visible === true;/);
    assert.match(source, /controller\.apply\(todoInstitutionLogoVisible\(\)\);/);
    assert.doesNotMatch(source.slice(source.indexOf("function startTodoInstitutionLogoPrepaint"), source.indexOf("function stopTodoInstitutionLogoPrepaint")), /controller\.apply\(false\)/);
    // The runtime adopts the same shared controller; the prepaint stops only
    // when the owned rail mounts, and its scans keep scheduling the rail mount
    // until then.
    assert.match(source, /function createTodoIntegration\(\)[\s\S]*?const institutionLogo = todoInstitutionLogoController\(\);/);
    assert.match(source, /if \(railMounted\) stopTodoInstitutionLogoPrepaint\(\);/);
    assert.match(source, /schedule\?\.\("todo-target-ready"\);/);
    assert.match(source, /new MutationObserver\(scan\)/, "insertions are observed before first paint");
    assert.match(source, /abandonTodoInstitutionLogoPrepaint\(\);/, "unapproved origins restore the mark");
});
