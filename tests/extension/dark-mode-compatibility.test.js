"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { canvasCompatibilityFixture, addCanvasPortals, walk } = require("./helpers/canvas-compatibility-dom.js");

const root = path.resolve(__dirname, "../..");
const css = fs.readFileSync(path.join(root, "css/darkmodecss.js"), "utf8");
const slice = css.slice(css.indexOf("Phase 4 Slice C"));
const contentSource = fs.readFileSync(path.join(root, "js/content.js"), "utf8");
const darkModeCss = vm.runInNewContext(`${css}\nDARKMODE_CSS`);

function extractFunction(name) {
    const start = contentSource.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `missing ${name}`);
    const bodyStart = contentSource.indexOf("{", start);
    let depth = 0;
    for (let index = bodyStart; index < contentSource.length; index += 1) {
        if (contentSource[index] === "{") depth += 1;
        if (contentSource[index] === "}" && --depth === 0) return contentSource.slice(start, index + 1);
    }
    throw new Error(`unterminated ${name}`);
}

function darkModeHarness(fixture) {
    const context = vm.createContext({ document: fixture.document, runiframeChecker() {} });
    vm.runInContext(`
        let options = { dark_mode: true, device_dark: false, dark_preset: {} };
        let darkStyleInserted = false;
        const DARKMODE_CSS = ${JSON.stringify(darkModeCss)};
        ${extractFunction("generateDarkModeCSS")}
        ${extractFunction("toggleDarkMode")}
    `, context);
    return context;
}

test("Slice C dark compatibility is portal-reactive without a lifecycle observer", () => {
    assert.ok(slice.startsWith("Phase 4 Slice C"), "missing the isolated compatibility layer");
    assert.match(slice, /later portal inherits the active stylesheet/);
    assert.doesNotMatch(slice, /MutationObserver|setInterval|addEventListener/,
        "CSS must not retain observers or listeners when Canvas replaces a portal");
    assert.match(slice, /#nav-tray-portal :is\(\.navigation-tray-container\.courses-tray, \.navigation-tray-container\.profile-tray, \.tray-with-space-for-global-nav\)/);
    assert.doesNotMatch(slice, /#nav-tray-portal\s*\{/, "generic tray portal children remain Canvas-owned");
    assert.doesNotMatch(slice, /#apstudycanvas-sidebar-root[^\n]*\{/, "Nest sidebar chrome is not recoloured");
});

test("Slice C covers Canvas list/card coexistence and keeps grade grids intentionally scrollable", () => {
    assert.match(slice, /#DashboardCard_Container :is\(\.ic-DashboardCard__box, \.ic-DashboardCard__box__container, \.ic-DashboardCard\)/);
    assert.match(slice, /\.ic-DashboardCard__box :is\(\.ic-DashboardCard__header_content, \.ic-DashboardCard__header-button\)/);
    assert.match(slice, /#gradebook_grid, \.gradebook-grid, \[data-testid="gradebook-grid"\]/);
    assert.match(slice, /overflow: auto !important;/);
    assert.match(slice, /overscroll-behavior: contain;/);
    assert.doesNotMatch(slice, /white-space:\s*normal.*gradebook|gradebook.*max-width:\s*100%/s,
        "the grade grid must not be forced into a clipped responsive fit");
});

test("Slice C uses dark native controls only while dark CSS is live and preserves picker access", () => {
    assert.match(slice, /color-scheme: dark;/);
    assert.match(slice, /input\[type="date"\]/);
    assert.match(slice, /input\[type="datetime-local"\]/);
    assert.match(slice, /input\[type="time"\]/);
    assert.match(slice, /\.ui-datepicker, \.ui-timepicker-wrapper/);
    assert.match(slice, /max-inline-size: min\(100vw - 16px, 32rem\);/);
    assert.match(slice, /\.ui-datepicker, \.ui-timepicker-wrapper\) :is\(a, button, select, input\):focus-visible/);
    assert.doesNotMatch(slice, /html\s*\{[^}]*color-scheme/s,
        "a global color scheme would contaminate native light mode after dark mode is disabled");
});

test("Slice C applies tokenized contrast and focus contracts to dynamic Canvas surfaces", () => {
    for (const selector of [
        ".submission-details-container", ".submission-details-comments", "#comments-tray",
        "#announcementWrapper", ".comment_list .comment", ".discussion_entry",
        ".submission-late-pill", ".submission-missing-pill", "[role=\"listbox\"]"
    ]) {
        assert.ok(slice.includes(selector), `missing ${selector} compatibility coverage`);
    }
    assert.match(slice, /background(?:-color)?: var\(--bc(?:background-0|buttons)\) !important;/);
    assert.match(slice, /color: var\(--bctext-0\) !important;/);
    assert.match(slice, /outline: 2px solid var\(--bclinks\) !important;/);
    assert.doesNotMatch(slice, /(?:#(?:fff|ffffff|000|000000)|\bred\b|rgb\()/i,
        "the compatibility layer must inherit user-selected --bc tokens rather than hard-coded palette values");
});

test("dark stylesheet mounts against a realistic list/dashboard page, reaches later Canvas portals, and restores light mode", () => {
    const fixture = canvasCompatibilityFixture();
    const context = darkModeHarness(fixture);
    vm.runInContext("toggleDarkMode()", context);
    const style = fixture.document.querySelector("#darkcss");
    assert.ok(style, "dark mode inserts one owned stylesheet into the Canvas document");
    assert.match(style.textContent, /Phase 4 Slice C/);

    const portals = addCanvasPortals(fixture.document);
    assert.ok(walk(fixture.document.documentElement).includes(portals.tray));
    assert.ok(walk(fixture.document.documentElement).includes(portals.selectedOption));
    for (const token of [
        ".navigation-tray-container.courses-tray", ".submission-details-container", "#comments-tray",
        "#announcementWrapper", ".ui-datepicker", ".ui-timepicker-wrapper", "[role=\"listbox\"]"
    ]) assert.ok(style.textContent.includes(token), `late-mounted Canvas portal remains covered: ${token}`);
    assert.ok(style.textContent.includes("#DashboardCard_Container"));
    assert.ok(style.textContent.includes("#gradebook_grid"));
    assert.doesNotMatch(style.textContent, /#apstudycanvas-sidebar-root[^\n]*\{/);
    assert.doesNotMatch(style.textContent, /#apstudy-todo-right-rail[^\n]*\{/);

    vm.runInContext("options.dark_mode = false; toggleDarkMode()", context);
    assert.equal(fixture.document.querySelector("#darkcss"), null, "turning dark mode off removes the dark stylesheet rather than leaving stale native-control colors");
    assert.ok(walk(fixture.document.documentElement).includes(portals.tray), "Canvas portals remain Canvas-owned after restoration");
    assert.ok(walk(fixture.document.documentElement).includes(fixture.todo), "APStudy card/To-Do/sidebar siblings survive the mode transition");
});
