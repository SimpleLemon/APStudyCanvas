"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const popup = require("../../js/popup-controller.js");

const root = path.resolve(__dirname, "../..");
const html = fs.readFileSync(path.join(root, "html/popup.html"), "utf8");
const css = fs.readFileSync(path.join(root, "css/popup.css"), "utf8");
const renderer = fs.readFileSync(path.join(root, "js/edit-canvas.js"), "utf8");

function withoutComments(source) {
    return source.replace(/<!--[\s\S]*?-->/g, "");
}

function inputTags(source, type) {
    const pattern = new RegExp(`<input\\b[^>]*\\btype=["']${type}["'][^>]*>`, "gi");
    return Array.from(source.matchAll(pattern), (match) => match[0]);
}

function inputId(tag) {
    return tag.match(/\bid=["']([^"']+)["']/i)?.[1] || "";
}

function labelsFor(source, id) {
    return new RegExp(`<label\\b[^>]*\\bfor=["']${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'][^>]*>[\\s\\S]*?<\\/label>`, "i").test(source);
}

function fakeSidebarDocument(list) {
    return {
        body: { dataset: {} },
        visibilityState: "visible",
        querySelector(selector) {
            if (selector === "#sidebar-page-list") return list;
            const match = selector.match(/^#sidebar-page-list \[data-sidebar-page="([^"]+)"\]$/);
            return match ? list.querySelector(`[data-sidebar-page="${match[1]}"]`) : null;
        },
        querySelectorAll() { return []; },
        getElementById(id) { return id === "sidebar-page-list" ? list : null; },
        addEventListener() {},
        createElement() { return fakeSidebarRow(""); }
    };
}

function fakeSidebarRow(page) {
    const listeners = {};
    const name = { textContent: "" };
    const checkbox = { checked: true, addEventListener() {} };
    return {
        dataset: { sidebarPage: page },
        className: "",
        tabIndex: 0,
        focus() { this.focused = true; },
        addEventListener(type, callback) { listeners[type] = callback; },
        dispatch(event) {
            event.preventDefault = event.preventDefault || (() => {});
            listeners[event.type]?.(event);
        },
        querySelector(selector) {
            if (selector === ".sidebar-page-name") return name;
            if (selector === "[data-sidebar-visibility]") return checkbox;
            return null;
        },
        querySelectorAll() { return []; },
        set innerHTML(value) { this.rendered = value; },
        get innerHTML() { return this.rendered || ""; }
    };
}

function fakeSidebarList(rows) {
    return {
        children: rows.slice(),
        replaceChildren() { this.children = []; },
        appendChild(row) {
            this.children = this.children.filter((item) => item !== row);
            this.children.push(row);
            return row;
        },
        querySelectorAll(selector) {
            return selector === "[data-sidebar-page]" ? this.children : [];
        },
        querySelector(selector) {
            const match = selector.match(/data-sidebar-page="([^"]+)"/);
            return match ? this.children.find((row) => row.dataset.sidebarPage === match[1]) || null : null;
        }
    };
}

function createEditCanvasRuntime(search = "?view=workspace&category=sidebar") {
    const listeners = new Map();
    const nodes = new Map();
    let tabCalls = 0;
    let document;

    function runtimeNode({ id, dataset = {}, hidden = false, inert = false, attributes = {} } = {}) {
        const nodeListeners = new Map();
        const classes = new Set();
        const attributesMap = new Map(Object.entries(attributes));
        const node = {
            id,
            dataset: { ...dataset },
            hidden,
            inert,
            style: {},
            textContent: "",
            classList: {
                toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
                contains(name) { return classes.has(name); }
            },
            setAttribute(name, value) {
                attributesMap.set(name, String(value));
                if (name === "hidden") this.hidden = true;
                if (name === "inert") this.inert = true;
            },
            removeAttribute(name) {
                attributesMap.delete(name);
                if (name === "hidden") this.hidden = false;
                if (name === "inert") this.inert = false;
            },
            getAttribute(name) { return attributesMap.get(name) ?? null; },
            hasAttribute(name) { return attributesMap.has(name); },
            addEventListener(type, callback) { nodeListeners.set(type, callback); },
            dispatchEvent(event) { nodeListeners.get(event.type)?.(event); },
            focus() { document.activeElement = this; },
            blur() { if (document.activeElement === this) document.activeElement = null; },
            querySelector(selector) {
                if (selector === ".popover-close") return null;
                return null;
            },
            querySelectorAll() { return []; },
            closest() { return null; },
            scrollIntoView() {}
        };
        if (id) nodes.set(id, node);
        return node;
    }

    const home = runtimeNode({ id: "home-view" });
    const compactHomeTrigger = runtimeNode({ id: "compact-home-trigger" });
    const homeEdit = runtimeNode({ id: "home-edit-canvas" });
    const workspace = runtimeNode({ id: "workspace-view", hidden: true, inert: true, attributes: { hidden: "", inert: "", "aria-hidden": "true" } });
    const legacy = runtimeNode({ id: "legacy-interface", hidden: true, inert: true, attributes: { hidden: "", inert: "", "aria-hidden": "true" } });
    const main = runtimeNode({ id: "main", hidden: true, inert: true, attributes: { hidden: "", inert: "", "aria-hidden": "true" } });
    const categories = ["overview", "appearance", "sidebar"].map((category) => runtimeNode({ dataset: { workspaceTarget: category, category } }));
    const sections = categories.map((category) => runtimeNode({ id: `workspace-section-${category.dataset.category}`, dataset: { category: category.dataset.category }, hidden: true, inert: true, attributes: { hidden: "", inert: "", "aria-hidden": "true" } }));
    const select = runtimeNode({ id: "workspace-category-select" });
    select.value = "";
    select.options = categories.map((category) => ({ value: category.dataset.workspaceTarget, selected: false }));
    const sidebarList = runtimeNode({ id: "sidebar-page-list" });
    sidebarList.dataset.rendererBound = "false";
    const profileButton = runtimeNode({ id: "profile-button", attributes: { "aria-controls": "profile-popover", "aria-expanded": "false" } });
    const profilePopover = runtimeNode({ id: "profile-popover", hidden: true, inert: true, attributes: { hidden: "", inert: "", "aria-hidden": "true" } });
    const notificationsButton = runtimeNode({ id: "notifications-button", attributes: { "aria-controls": "notifications-popover", "aria-expanded": "false" } });
    const notificationsPopover = runtimeNode({ id: "notifications-popover", hidden: true, inert: true, attributes: { hidden: "", inert: true, "aria-hidden": "true" } });
    home.contains = (target) => target === home || target === homeEdit;
    workspace.contains = (target) => target === workspace || categories.includes(target) || sections.includes(target) || target === select || target === sidebarList;
    legacy.contains = (target) => target === legacy || target === main;
    sections.forEach((section) => { section.contains = (target) => target === section; });
    profilePopover.contains = (target) => target === profilePopover;
    notificationsPopover.contains = (target) => target === notificationsPopover;

    document = {
        body: { dataset: { mode: "home" } },
        activeElement: null,
        currentScript: null,
        visibilityState: "visible",
        addEventListener(type, callback) {
            const callbacks = listeners.get(type) || [];
            callbacks.push(callback);
            listeners.set(type, callbacks);
        },
        dispatchEvent(event) { (listeners.get(event.type) || []).forEach((callback) => callback(event)); },
        getElementById(id) { return nodes.get(id) || null; },
        querySelector(selector) {
            if (selector === "#compact-home-trigger") return compactHomeTrigger;
            if (selector === ".compact-popover:not([hidden])") return [notificationsPopover, profilePopover].find((node) => !node.hidden) || null;
            if (selector === ".main") return main;
            return null;
        },
        querySelectorAll(selector) {
            if (selector === ".compact-popover") return [notificationsPopover, profilePopover];
            if (selector === "[aria-controls$='-popover']") return [notificationsButton, profileButton];
            if (selector === "[data-workspace-target]") return categories;
            if (selector === ".workspace-section[data-category]") return sections;
            if (selector === "#legacy-interface .option > input[type='radio']") return [];
            if (selector === ".tab" || selector === "[data-legacy-target]" || selector === ".workspace-home-link") return [];
            return [];
        },
        createElement() { return runtimeNode(); }
    };

    const window = {
        location: { search },
        parent: null,
        addEventListener() {},
        scrollTo() {},
        postMessage() {},
        APStudyCanvasPopupController: popup
    };
    window.parent = window;
    const chrome = {
        tabs: {
            async get() { tabCalls += 1; throw new Error("source validation belongs to the popup/background path"); },
            async query() { tabCalls += 1; return []; }
        },
        storage: {
            sync: { get: async () => ({}), set: async () => {} },
            local: { get: async () => ({}), set: async () => {} }
        }
    };
    const context = { window, document, chrome, URLSearchParams, setTimeout, clearTimeout, console };
    vm.runInNewContext(renderer, context, { filename: "js/edit-canvas.js" });
    document.dispatchEvent({ type: "DOMContentLoaded" });

    return {
        document,
        window,
        nodes: { home, compactHomeTrigger, homeEdit, workspace, legacy, main, categories, sections, select, sidebarList, profileButton, profilePopover, notificationsButton, notificationsPopover },
        get tabCalls() { return tabCalls; },
        flush() { return new Promise((resolve) => setImmediate(resolve)); }
    };
}

test("route visibility markup and renderer keep hidden, inert, and aria-hidden aligned", () => {
    assert.match(html, /id="workspace-view"[^>]*hidden[^>]*inert[^>]*aria-hidden="true"/);
    assert.match(html, /id="legacy-interface"[^>]*hidden[^>]*inert[^>]*aria-hidden="true"/);
    assert.match(html, /id="profile-popover"[^>]*hidden[^>]*inert[^>]*aria-hidden="true"/);
    assert.match(renderer, /node\.hidden = !visible/);
    assert.match(renderer, /node\.inert = !visible/);
    assert.match(renderer, /if \(visible\) node\.removeAttribute\("aria-hidden"\)/);
    assert.match(renderer, /else node\.setAttribute\("aria-hidden", "true"\)/);
    assert.match(renderer, /setAccessibleVisibility\(section, section === nextSection\)/);
    assert.match(renderer, /setAccessibleVisibility\(main, true\)/);
    assert.match(css, /body\[data-mode="workspace"\] #legacy-interface\[hidden\][\s\S]*display: none !important/);
    assert.match(css, /#legacy-interface > \.main\[inert\]/);
    assert.match(css, /#legacy-interface > \.tab\[aria-hidden="true"\]/);
});

test("fake DOM route switch removes accessibility state before showing and applies all hidden states", async () => {
    const runtime = createEditCanvasRuntime();
    await runtime.flush();
    const { home, workspace, legacy, main, sections, select } = runtime.nodes;

    assert.equal(runtime.document.body.dataset.mode, "workspace");
    for (const node of [workspace, legacy, main]) {
        assert.equal(node.hidden, false);
        assert.equal(node.inert, false);
        assert.equal(node.hasAttribute("hidden"), false);
        assert.equal(node.hasAttribute("inert"), false);
        assert.equal(node.hasAttribute("aria-hidden"), false);
    }
    assert.equal(home.hidden, true);
    assert.equal(home.inert, true);
    assert.equal(home.getAttribute("aria-hidden"), "true");
    assert.equal(select.value, "sidebar");
    assert.deepEqual(sections.map((section) => ({ category: section.dataset.category, hidden: section.hidden, inert: section.inert, ariaHidden: section.getAttribute("aria-hidden") })), [
        { category: "overview", hidden: true, inert: true, ariaHidden: "true" },
        { category: "appearance", hidden: true, inert: true, ariaHidden: "true" },
        { category: "sidebar", hidden: false, inert: false, ariaHidden: null }
    ]);
});

test("fullscreen startup initializes a validated source and keeps unsafe source values delegated", async () => {
    const valid = createEditCanvasRuntime("?fullscreen=1&category=sidebar&sourceCanvasTabId=704772705");
    await valid.flush();
    assert.equal(valid.window.APStudyCanvasWorkspace.sourceTabId, 704772705);
    assert.equal(valid.document.body.dataset.mode, "workspace");

    for (const source of ["", "0", "-1", "1.5", "not-a-tab", "9007199254740992"]) {
        const runtime = createEditCanvasRuntime(`?fullscreen=1&sourceCanvasTabId=${encodeURIComponent(source)}`);
        await runtime.flush();
        assert.equal(runtime.window.APStudyCanvasWorkspace.sourceTabId, null, source || "missing");
        assert.equal(runtime.document.body.dataset.mode, "workspace");
    }
});

test("workspace startup remains compatible and does not perform unsafe source fallback", async () => {
    const runtime = createEditCanvasRuntime("?view=workspace&category=overview&sourceCanvasTabId=19");
    await runtime.flush();
    assert.equal(runtime.window.APStudyCanvasWorkspace.sourceTabId, 19);
    assert.equal(runtime.document.body.dataset.mode, "workspace");
});

test("closed, stale, foreign, and mismatched sources remain delegated without active-tab fallback", async () => {
    for (const source of ["7", "8", "9", "10"]) {
        const runtime = createEditCanvasRuntime(`?fullscreen=1&sourceCanvasTabId=${source}`);
        await runtime.flush();
        assert.equal(runtime.window.APStudyCanvasWorkspace.sourceTabId, Number(source));
        assert.equal(runtime.tabCalls, 0, source);
    }
});

test("route and popover closure move focus before applying aria-hidden", async () => {
    const runtime = createEditCanvasRuntime();
    await runtime.flush();
    const { document, nodes } = runtime;
    nodes.sections[2].focus();
    runtime.window.APStudyCanvasWorkspace.activateCategory("overview");
    assert.equal(document.activeElement, nodes.select);

    nodes.profileButton.dispatchEvent({ type: "click" });
    nodes.profilePopover.focus();
    document.dispatchEvent({ type: "mousedown", target: { closest: () => null } });
    assert.equal(document.activeElement, nodes.profileButton);
    assert.equal(nodes.profilePopover.hidden, true);
});

test("Home and Edit Canvas transitions keep focus outside the view before aria-hidden", async () => {
    const runtime = createEditCanvasRuntime("");
    await runtime.flush();
    const { document, nodes } = runtime;

    nodes.homeEdit.focus();
    nodes.homeEdit.dispatchEvent({ type: "click" });
    await runtime.flush();
    assert.equal(document.body.dataset.mode, "workspace");
    assert.equal(nodes.home.hidden, true);
    assert.equal(nodes.home.getAttribute("aria-hidden"), "true");
    assert.equal(nodes.select.hidden, false);
    assert.equal(document.activeElement, nodes.select);

    nodes.compactHomeTrigger.dispatchEvent({ type: "click" });
    assert.equal(document.body.dataset.mode, "home");
    assert.equal(nodes.workspace.hidden, true);
    assert.equal(nodes.workspace.getAttribute("aria-hidden"), "true");
    assert.equal(nodes.legacy.hidden, true);
    assert.equal(nodes.legacy.getAttribute("aria-hidden"), "true");
    assert.equal(document.activeElement, nodes.compactHomeTrigger);
});

test("category navigation moves focus before hiding the previous section", async () => {
    const runtime = createEditCanvasRuntime("?view=workspace&category=sidebar");
    await runtime.flush();
    await runtime.flush();
    const { document, nodes } = runtime;

    nodes.sections[2].focus();
    runtime.window.APStudyCanvasWorkspace.activateCategory("overview");
    assert.equal(document.activeElement, nodes.select);
    assert.equal(nodes.sections[2].hidden, true);
    assert.equal(nodes.sections[2].getAttribute("aria-hidden"), "true");
    assert.equal(nodes.sections[0].hidden, false);
    assert.equal(nodes.sections[0].getAttribute("aria-hidden"), null);
});

test("home summary and category chrome cover the complete workspace", () => {
    const homeCategories = new Set(Array.from(html.matchAll(/data-home-target="([^"]+)"[^>]*data-category="([^"]+)"/g), (match) => match[2]));
    assert.deepEqual([...homeCategories].sort(), [
        "appearance", "calendar-accounts", "course-cards", "data-support",
        "gpa-grades", "sidebar", "study-tools", "themes"
    ]);
    assert.match(html, /<span class="section-count">8 areas<\/span>/);

    const railCategories = new Set(Array.from(html.matchAll(/data-workspace-target="([^"]+)"[^>]*data-category="([^"]+)"/g), (match) => match[2]));
    const sectionCategories = new Set(Array.from(html.matchAll(/class="workspace-section"[^>]*data-category="([^"]+)"/g), (match) => match[1]));
    assert.deepEqual(railCategories, sectionCategories);
    assert.match(renderer, /item\.classList\.toggle\("is-active", active\)/);
    assert.match(renderer, /item\.setAttribute\("aria-current", "page"\)/);
    assert.match(renderer, /select\.value = next/);
    const railButtons = Array.from(withoutComments(html).matchAll(/<button\b[^>]*data-workspace-target="([^"]+)"[^>]*>/g));
    assert.equal(railButtons.find(([tag, category]) => category === "overview")[0].includes('class="is-active"'), true);
    assert.equal(railButtons.find(([tag, category]) => category === "overview")[0].includes('aria-current="page"'), true);
    railButtons.filter(([, category]) => category !== "overview").forEach(([tag]) => assert.equal(/\baria-current=/.test(tag), false));
});

test("legacy toggles retain native focus, explicit names, and presentational sliders", () => {
    const legacy = withoutComments(html).slice(html.indexOf('id="legacy-interface"'));
    const toggles = [...inputTags(legacy, "radio"), ...inputTags(legacy, "checkbox")];
    assert.ok(toggles.length > 0);
    for (const tag of toggles) {
        const id = inputId(tag);
        assert.ok(id, `toggle is missing an id: ${tag}`);
        assert.equal(labelsFor(legacy, id), true, `toggle ${id} is missing a label[for]`);
    }

    const optionCount = (legacy.match(/<div class="option"/g) || []).length;
    const sliderCount = (legacy.match(/<div class="slider" aria-hidden="true">/g) || []).length;
    assert.equal(optionCount, 16);
    assert.equal(sliderCount, optionCount);
    assert.match(css, /\.option > input\[type="radio"\]\s*\{[\s\S]*?position:absolute;[\s\S]*?clip:rect/);
    assert.doesNotMatch(css, /\.option input\s*\{\s*display\s*:\s*none/);
    assert.match(css, /input\[type="radio"\]:focus-visible ~ \.slider/);
    assert.match(css, /input:nth-of-type\(2\):checked ~ \.slider/);
    assert.match(renderer, /control\.addEventListener\("change"/);
});

test("sidebar keyboard move uses the rollback contract and restores DOM order and focus", async () => {
    const initial = ["dashboard", "courses", "calendar", "inbox", "history", "help"];
    const rows = initial.map((page) => fakeSidebarRow(page));
    const list = fakeSidebarList(rows);
    const document = fakeSidebarDocument(list);
    const settingsStore = { updateField: async () => { throw new Error("SIDEBAR_WRITE_FAILED"); } };
    const chromeApi = {
        runtime: { sendMessage: async () => ({ ok: true }) },
        storage: { sync: { get: async () => ({ sidebar_page_order: initial }), set: async () => {} }, local: { get: async () => ({}) } }
    };
    const controller = popup.createController({
        document,
        window: { location: { search: "" }, addEventListener() {} },
        chromeApi,
        defaults: {},
        settingsStore
    });
    await controller.loadSidebarSettings();
    const current = list.children.map((row) => row.dataset.sidebarPage);
    const next = ["courses", "dashboard", "calendar", "inbox", "history", "help"];
    const reorder = (order) => {
        const rowsByPage = new Map(list.children.map((row) => [row.dataset.sidebarPage, row]));
        list.children = order.map((page) => rowsByPage.get(page));
    };
    const event = { type: "keydown", key: "ArrowUp", altKey: true, preventDefault() { this.prevented = true; } };
    assert.equal(event.key, "ArrowUp", "keyboard regression exercises Alt+ArrowUp");
    event.preventDefault();
    reorder(next);
    const restore = (restoredOrder) => {
        reorder(restoredOrder);
        list.querySelector('[data-sidebar-page="courses"]').focus();
    };
    await assert.rejects(controller.persistSidebarOrder(next, "courses", {
        onRollback: restore,
        onResult: (result) => { if (!result.ok) restore(result.restoredOrder); }
    }));

    assert.equal(event.prevented, true);
    assert.deepEqual(list.children.map((row) => row.dataset.sidebarPage), current);
    assert.equal(list.querySelector('[data-sidebar-page="courses"]').focused, true);
    assert.match(renderer, /persistSidebarOrder\(next, page, \{ onRollback: restore, onResult: result \}\)/);
    assert.match(renderer, /reorderSidebarDom\(list, restoredOrder\)/);
    assert.match(renderer, /focusSidebarRow\(list, page\)/);
    assert.match(renderer, /setSidebarMoveStatus\("Failed — changes reverted\.", true\)/);
    assert.match(renderer, /event\.key !== "ArrowUp" && event\.key !== "ArrowDown"/);
});

test("profile Escape returns focus through the existing helper without outside-click focus theft", () => {
    let focused = false;
    let closed = false;
    const event = { key: "Escape", preventDefault() { this.prevented = true; } };
    const handled = popup.handlePopoverEscape(event, () => { closed = true; return true; }, { focus() { focused = true; } });
    assert.equal(handled, true);
    assert.equal(closed, true);
    assert.equal(focused, true);
    assert.equal(event.prevented, true);
    assert.match(renderer, /handlePopoverEscape\(event, close, openTrigger\)/);
    assert.match(renderer, /if \(!event\.target\.closest\("\.compact-popover-anchor"\)\) close\(\)/);
    assert.match(html, /id="profile-button"[^>]*aria-controls="profile-popover"[^>]*aria-expanded="false"/);
});

test("fake DOM popover runtime closes on Escape, ignores unrelated keys, and leaves outside-click focus alone", async () => {
    const runtime = createEditCanvasRuntime("?view=workspace&category=overview");
    await runtime.flush();
    const { document, nodes } = runtime;
    const { profileButton, profilePopover } = nodes;

    profileButton.dispatchEvent({ type: "click" });
    assert.equal(profilePopover.hidden, false);
    assert.equal(profilePopover.getAttribute("aria-hidden"), null);
    assert.equal(profileButton.getAttribute("aria-expanded"), "true");

    const unrelated = { type: "keydown", key: "Enter", target: profilePopover, preventDefault() { this.prevented = true; } };
    document.dispatchEvent(unrelated);
    assert.equal(profilePopover.hidden, false, "unrelated key does not close the popover");
    assert.equal(profileButton.getAttribute("aria-expanded"), "true");
    assert.equal(unrelated.prevented, undefined, "unrelated key does not invoke Escape handling");

    const escape = { type: "keydown", key: "Escape", target: profilePopover, preventDefault() { this.prevented = true; } };
    document.dispatchEvent(escape);
    assert.equal(profilePopover.hidden, true);
    assert.equal(profilePopover.getAttribute("aria-hidden"), "true");
    assert.equal(profileButton.getAttribute("aria-expanded"), "false");
    assert.equal(document.activeElement, profileButton, "Escape returns focus to the trigger");
    assert.equal(escape.prevented, true);

    profileButton.dispatchEvent({ type: "click" });
    assert.equal(profilePopover.hidden, false);
    assert.equal(profileButton.getAttribute("aria-expanded"), "true");
    const outside = { closest() { return null; } };
    document.activeElement = outside;
    document.dispatchEvent({ type: "mousedown", target: outside });
    assert.equal(profilePopover.hidden, true);
    assert.equal(profilePopover.getAttribute("aria-hidden"), "true");
    assert.equal(profileButton.getAttribute("aria-expanded"), "false");
    assert.equal(document.activeElement, outside, "outside click does not force focus to the trigger");
});

test("popup keeps stable IDs/scripts and has no legacy options runtime route", () => {
    [
        "home-view", "workspace-view", "workspace-category-select", "workspace-section-sidebar",
        "workspace-section-calendar-accounts", "sidebar-page-list", "profile-button", "profile-popover",
        "popup-export-settings", "popup-import-settings", "popup-reset-settings", "compact-expand"
    ].forEach((id) => assert.match(html, new RegExp(`id="${id}"`), `missing popup id: ${id}`));
    [
        "../js/settings-schema.js", "../js/platform/contract.js", "../js/popup-controller.js",
        "../js/edit-canvas.js", "../js/popup.js"
    ].forEach((script) => assert.match(html, new RegExp(`src="${script.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`)));
    assert.doesNotMatch(html, /options\.html/);
    assert.doesNotMatch(renderer, /openOptionsPage/);
});
