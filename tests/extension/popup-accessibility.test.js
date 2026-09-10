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
const controller = fs.readFileSync(path.join(root, "js/popup-controller.js"), "utf8");

test("manual close recovery names destructive discard and exposes retryable status", () => {
    const dialog = html.match(/<dialog\b[^>]*id="manual-close-prompt"[\s\S]*?<\/dialog>/)?.[0] || "";
    assert.match(dialog, /aria-describedby="manual-close-description manual-close-status"/);
    assert.match(dialog, /id="manual-close-status"[^>]*role="status"[^>]*aria-live="polite"/);
    assert.match(dialog, /id="manual-close-discard"[^>]*>Discard and close<\/button>/);
    assert.doesNotMatch(dialog, />Close popup<\/button>/);
});

test("compatibility labels match the settings they control", () => {
    assert.match(html, /Show assignment footer/);
    assert.match(html, /Keeps the To-Do rail in view with its own scroll area\./);
    assert.match(html, /Stretches the To-Do rail to the viewport height\./);
    assert.doesNotMatch(html, /Compatibility option for the legacy rail layout\./);
});

test("sidebar editor exposes canonical controls, recovery, and mandatory names", () => {
    for (const key of [
        "better_sidebar", "sidebar_expanded_width", "sidebar_collapsed_width", "sidebar_density", "sidebar_avatar_size",
        "sidebar_product_entry_visible", "sidebar_collapsed_labels", "sidebar_tooltips", "sidebar_pages_visible_expanded",
        "sidebar_pages_visible_collapsed", "sidebar_courses_visible_expanded", "sidebar_courses_visible_collapsed",
        "sidebar_pages_folded", "sidebar_courses_folded"
    ]) assert.match(html, new RegExp(`data-popup-setting="${key}"`), `missing ${key}`);
    assert.match(html, /data-popup-setting="sidebar_avatar_size"[^>]*>\s*<option value="small">Small<\/option>\s*<option value="medium">Medium<\/option>\s*<option value="large">Large<\/option>/, "the profile picture size offers Small, Medium, and Large");
    assert.doesNotMatch(html, /data-popup-setting="sidebar_logo_visible"/, "the school-logo control is gone because the header is now the profile picture");
    assert.match(html, /data-sidebar-preset="width"/);
    assert.match(html, /data-sidebar-preset="density"/);
    assert.match(html, /data-sidebar-preset="size"/);
    assert.match(html, /id="sidebar-toggle-hidden"[^>]*aria-pressed="false"/);
    assert.match(html, /id="sidebar-course-order-editor"[^>]*aria-live="polite"/);
    assert.match(html, /id="sidebar-page-list"[^>]*aria-label="Sidebar page order"/);
    assert.doesNotMatch(html, /data-popup-setting="sidebar_accessibility_labels"/);
    assert.doesNotMatch(html, />Accessibility Labels</);
    assert.match(controller, /sidebar_accessibility_labels = true/);
    assert.match(controller, /key === "sidebar_accessibility_labels"\) return value === true \? true : null/);
});

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

function createEditCanvasRuntime(search = "?view=workspace&category=sidebar", { pendingPopupInit = false } = {}) {
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
            clickCount: 0,
            click() {
                this.clickCount += 1;
                nodeListeners.get("click")?.({ type: "click", target: this, preventDefault() {} });
            },
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

    const compactHomeTrigger = runtimeNode({ id: "compact-home-trigger" });
    const workspace = runtimeNode({ id: "workspace-view" });
    const categories = ["overview", "appearance", "sidebar", "course-cards", "study-tools", "themes", "gpa-grades", "canvas-search", "calendar-accounts", "data-support"]
        .map((category) => runtimeNode({ dataset: { workspaceTarget: category, category } }));
    const workspaceNav = runtimeNode({ id: "workspace-nav" });
    categories.forEach((category) => {
        category.closest = (selector) => selector === "[data-workspace-target]" ? category : null;
    });
    const sections = categories.map((category) => runtimeNode({ id: `workspace-section-${category.dataset.category}`, dataset: { category: category.dataset.category }, hidden: true, inert: true, attributes: { hidden: "", inert: "", "aria-hidden": "true" } }));
    const select = runtimeNode({ id: "workspace-category-select" });
    select.value = "";
    select.options = categories.map((category) => ({ value: category.dataset.workspaceTarget, selected: false }));
    const sidebarList = runtimeNode({ id: "sidebar-page-list" });
    sidebarList.dataset.rendererBound = "false";
    const workspaceAccountTrigger = runtimeNode({ id: "workspace-account-trigger", dataset: { workspaceTarget: "calendar-accounts" } });
    const notificationsButton = runtimeNode({ id: "notifications-button", attributes: { "aria-controls": "notifications-popover", "aria-expanded": "false" } });
    const notificationsPopover = runtimeNode({ id: "notifications-popover", hidden: true, inert: true, attributes: { hidden: "", inert: true, "aria-hidden": "true" } });
    const discardCustomStyles = runtimeNode({ id: "discard-custom-styles" });
    const discardDarkPalette = runtimeNode({ id: "discard-dark-palette" });
    const importInput = runtimeNode({ id: "popup-import-input" });
    importInput.value = "imported theme";
    workspace.contains = (target) => target === workspace || target === workspaceNav || categories.includes(target) || sections.includes(target) || target === select || target === sidebarList || target === workspaceAccountTrigger;
    sections.forEach((section) => { section.contains = (target) => target === section; });
    notificationsPopover.contains = (target) => target === notificationsPopover;

    document = {
        body: { dataset: { mode: "workspace" } },
        documentElement: { clientWidth: 640, clientHeight: 480, getBoundingClientRect() { return { left: 0, top: 0, width: 640, height: 480 }; } },
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
            if (selector === ".workspace-nav") return workspaceNav;
            return null;
        },
        querySelectorAll(selector) {
            if (selector === ".compact-popover") return [notificationsPopover];
            if (selector === "[aria-controls$='-popover']") return [notificationsButton];
            if (selector === "[data-workspace-target]") return [...categories, workspaceAccountTrigger];
            if (selector === ".workspace-nav [data-workspace-target]") return categories;
            if (selector === ".workspace-section[data-category]") return sections;
            if (selector === ".workspace-overview-link") return [];
            return [];
        },
        createElement() { return runtimeNode(); }
    };

    const overlayActions = [];
    const windowListeners = new Map();
    const window = {
        location: { search },
        parent: null,
        innerWidth: 640,
        innerHeight: 480,
        addEventListener(type, callback) { windowListeners.set(type, callback); },
        scrollTo() {},
        postMessage() {},
        APStudyCanvasPopupController: popup,
        APStudyCanvasPopup: {
            init: pendingPopupInit ? () => new Promise(() => {}) : undefined,
            signalDraftState() {},
            overlayControl(action) {
                overlayActions.push(action);
                return Promise.resolve({ ok: true });
            }
        }
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
        nodes: { compactHomeTrigger, workspace, workspaceNav, categories, sections, select, sidebarList, workspaceAccountTrigger, notificationsButton, notificationsPopover, discardCustomStyles, discardDarkPalette, importInput },
        overlayActions,
        get tabCalls() { return tabCalls; },
        flush() { return new Promise((resolve) => setImmediate(resolve)); }
    };
}

function dirtyThemeDraftRuntime(confirmImpl) {
    const runtime = createEditCanvasRuntime("?embedded=1&sourceCanvasTabId=19&overlaySession=confirm-test");
    if (confirmImpl !== undefined) runtime.window.confirm = confirmImpl;
    const draft = runtime.window.APStudyCanvasThemeDraft;
    draft.setCss(true);
    draft.setPalette(true);
    draft.setImport(true);
    return runtime;
}

test("modern-only accessibility fixture exposes Workspace navigation without retired interface nodes", async () => {
    const runtime = createEditCanvasRuntime("?view=workspace&category=overview");
    await runtime.flush();

    assert.equal(runtime.document.getElementById("legacy-interface"), null);
    assert.equal(runtime.document.getElementById("main"), null);
    assert.equal(runtime.document.getElementById("customize-dark-btn"), null);
    assert.equal(runtime.nodes.categories.length, 10);
    assert.equal(runtime.nodes.sections.length, 10);
    assert.equal(runtime.document.body.dataset.mode, "workspace");
});

function assertDraftWasPreserved(runtime) {
    assert.equal(runtime.window.APStudyCanvasWorkspace.themeDraftDirty, true);
    assert.equal(runtime.nodes.discardCustomStyles.clickCount, 0);
    assert.equal(runtime.nodes.discardDarkPalette.clickCount, 0);
    assert.equal(runtime.nodes.importInput.value, "imported theme");
    assert.equal(runtime.overlayActions.includes("discard-close"), false);
}

test("missing window.confirm fails closed without discarding the theme draft", () => {
    const runtime = dirtyThemeDraftRuntime(undefined);
    assert.equal(runtime.window.APStudyCanvasWorkspace.confirmLeave(), false);
    assertDraftWasPreserved(runtime);
});

test("throwing window.confirm fails closed without discarding the theme draft", () => {
    const runtime = dirtyThemeDraftRuntime(() => { throw new Error("confirm unavailable"); });
    assert.equal(runtime.window.APStudyCanvasWorkspace.confirmLeave(), false);
    assertDraftWasPreserved(runtime);
});

test("false window.confirm fails closed without discarding the theme draft", () => {
    const runtime = dirtyThemeDraftRuntime(() => false);
    assert.equal(runtime.window.APStudyCanvasWorkspace.confirmLeave(), false);
    assertDraftWasPreserved(runtime);
});

test("only true window.confirm clears the modern theme draft without touching retired controls", () => {
    const runtime = dirtyThemeDraftRuntime(() => true);
    assert.equal(runtime.window.APStudyCanvasWorkspace.confirmLeave(), true);
    assert.equal(runtime.window.APStudyCanvasWorkspace.themeDraftDirty, false);
    assert.equal(runtime.nodes.discardCustomStyles.clickCount, 0);
    assert.equal(runtime.nodes.discardDarkPalette.clickCount, 0);
    assert.equal(runtime.nodes.importInput.value, "");
    assert.equal(runtime.overlayActions.includes("discard-close"), false);
});

test("route visibility markup and renderer keep hidden, inert, and aria-hidden aligned", () => {
    assert.doesNotMatch(html, /id="home-view"|id="home-edit-canvas"/);
    assert.doesNotMatch(html, /id="profile-button"|id="profile-popover"/);
    assert.match(html, /id="notifications-popover"[^>]*hidden[^>]*inert[^>]*aria-hidden="true"/);
    assert.match(renderer, /node\.hidden = !visible/);
    assert.match(renderer, /node\.inert = !visible/);
    assert.match(renderer, /if \(visible\) node\.removeAttribute\("aria-hidden"\)/);
    assert.match(renderer, /else node\.setAttribute\("aria-hidden", "true"\)/);
    assert.match(renderer, /setAccessibleVisibility\(section, section === nextSection\)/);
    assert.doesNotMatch(renderer, /setupHome|home-edit-canvas|home-view/);
    assert.match(renderer, /sections\.forEach\(\(section\) => setAccessibleVisibility\(section, section === nextSection\)\)/);
});

test("Workspace category switching makes one section available and updates the compact picker", () => {
    assert.match(renderer, /const nextSection = sections\.find\(\(section\) => section\.dataset\.category === next\)/);
    assert.match(renderer, /if \(nextSection\) setAccessibleVisibility\(nextSection, true\)/);
    assert.match(renderer, /sections\.forEach\(\(section\) => setAccessibleVisibility\(section, section === nextSection\)\)/);
    assert.match(renderer, /select\.value = next/);
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

test("category changes and notification closure move focus before applying aria-hidden", async () => {
    const runtime = createEditCanvasRuntime();
    await runtime.flush();
    const { document, nodes } = runtime;
    nodes.sections[2].focus();
    runtime.window.APStudyCanvasWorkspace.activateCategory("overview");
    assert.equal(document.activeElement, nodes.sections[0]);

    nodes.notificationsButton.dispatchEvent({ type: "click" });
    nodes.notificationsPopover.focus();
    document.dispatchEvent({ type: "mousedown", target: { closest: () => null } });
    assert.equal(document.activeElement, nodes.notificationsButton);
    assert.equal(nodes.notificationsPopover.hidden, true);
});

test("Workspace is the only startup route and the compact brand returns to Overview", () => {
    assert.match(html, /<body data-mode="workspace"[^>]*>/);
    assert.match(html, /id="workspace-category-select"[^>]*aria-label="Edit Canvas category"/);
    assert.doesNotMatch(html, /id="home-view"|id="home-edit-canvas"/);
    assert.doesNotMatch(renderer, /startsInWorkspace|setupHome/);
    assert.match(renderer, /enterWorkspace\("overview"\)/);
});

test("category navigation moves focus before hiding the previous section", async () => {
    const runtime = createEditCanvasRuntime("?view=workspace&category=sidebar");
    await runtime.flush();
    await runtime.flush();
    const { document, nodes } = runtime;

    nodes.sections[2].focus();
    runtime.window.APStudyCanvasWorkspace.activateCategory("overview");
    assert.equal(document.activeElement, nodes.sections[0]);
    assert.equal(nodes.sections[2].hidden, true);
    assert.equal(nodes.sections[2].getAttribute("aria-hidden"), "true");
    assert.equal(nodes.sections[0].hidden, false);
    assert.equal(nodes.sections[0].getAttribute("aria-hidden"), null);
});

test("ordinary category activation reveals its Workspace section", async () => {
    const runtime = createEditCanvasRuntime("?view=workspace&category=overview");
    await runtime.flush();

    runtime.window.APStudyCanvasWorkspace.activateCategory("appearance");
    assert.equal(runtime.nodes.sections[1].hidden, false);
});

test("account context is a Workspace route to Account & calendar", async () => {
    const runtime = createEditCanvasRuntime("?embedded=1&category=overview");
    await runtime.flush();

    runtime.nodes.workspaceAccountTrigger.click();
    assert.equal(runtime.window.APStudyCanvasWorkspace.category, "calendar-accounts");
    assert.equal(runtime.nodes.sections.find((section) => section.dataset.category === "calendar-accounts").hidden, false);
    assert.equal(runtime.document.body.dataset.mode, "workspace");
    assert.equal(runtime.nodes.workspaceAccountTrigger.classList.contains("is-active"), true);
    assert.equal(runtime.nodes.workspaceAccountTrigger.getAttribute("aria-current"), "page");
});

test("every Workspace category stays interactive while the popup controller is still loading", async () => {
    const runtime = createEditCanvasRuntime("?embedded=1&view=workspace&category=overview&overlaySession=live-session", { pendingPopupInit: true });
    await runtime.flush();

    for (const category of runtime.nodes.categories) {
        category.click();
        const target = category.dataset.workspaceTarget;
        const section = runtime.nodes.sections.find((item) => item.dataset.category === target);
        assert.equal(section.hidden, false, `${target} is visible without waiting for optional initialization`);
        assert.equal(runtime.nodes.select.value, target, `${target} updates the compact picker`);
        assert.equal(runtime.window.APStudyCanvasWorkspace.category, target, `${target} restores deterministic workspace state`);
    }
});

test("rail roving tabindex exposes every category through Arrow keys and Home/End", async () => {
    const runtime = createEditCanvasRuntime("?view=workspace&category=overview");
    await runtime.flush();
    await runtime.flush();
    const { workspaceNav, categories, sections } = runtime.nodes;

    const press = async (target, key) => {
        const event = { type: "keydown", target, key, preventDefault() { this.prevented = true; } };
        workspaceNav.dispatchEvent(event);
        await runtime.flush();
        assert.equal(event.prevented, true, `${key} keeps focus movement inside the rail`);
    };

    await press(categories[0], "ArrowDown");
    assert.equal(runtime.document.activeElement, categories[1]);
    assert.equal(categories[1].tabIndex, 0);
    assert.equal(sections[1].hidden, false);

    await press(categories[1], "End");
    assert.equal(runtime.document.activeElement, categories.at(-1));
    assert.equal(categories.at(-1).tabIndex, 0);
    assert.equal(sections.at(-1).hidden, false);

    await press(categories.at(-1), "Home");
    assert.equal(runtime.document.activeElement, categories[0]);
    assert.equal(categories[0].tabIndex, 0);
    assert.equal(sections[0].hidden, false);

    await press(categories[0], "ArrowUp");
    assert.equal(runtime.document.activeElement, categories[0]);
});

test("Workspace category chrome remains complete without a Home route", () => {
    assert.match(html, /<body data-mode="workspace"[^>]*>/);
    assert.doesNotMatch(html, /class="workspace-header"|id="workspace-title"|id="workspace-save-status"|data-workspace-overview/);
    assert.match(html, /id="workspace-view"[^>]*aria-label="Edit Canvas settings"/);
    assert.doesNotMatch(html, /Return to APStudyCanvas home|>Home<\/a>/);
    assert.doesNotMatch(html, /id="home-view"|id="home-edit-canvas"/);
    assert.doesNotMatch(html, /workspace-search-input/);
    assert.match(renderer, /function replaceWorkspaceViewInUrl/);
    assert.match(renderer, /function replaceWorkspaceCategoryInUrl/);
    assert.match(renderer, /url\.searchParams\.set\("category", category\)/);
    assert.match(renderer, /url\.searchParams\.delete\("category"\)/);
    [
        "auto_dark_start", "auto_dark_end", "device_dark", "assignment_date_format", "card_overdues",
        "relative_dues", "num_assignments", "gpa_calc_prepend", "dashboard_grades", "grade_hover",
        "canvas_search_enabled", "grade_analytics_enabled", "todo_progress_style", "todo_timeframe", "todo_completion_authority", "todo_celebration"
    ].forEach((key) => assert.match(html, new RegExp(`data-popup-setting="${key}"`), `missing Phase 2 setting ${key}`));
    const searchControl = html.match(/<label class="workspace-setting">[\s\S]*?data-popup-setting="canvas_search_enabled"[\s\S]*?<\/label>/)?.[0] || "";
    assert.match(searchControl, /<strong>Enable local Canvas search<\/strong>/);
    assert.match(searchControl, /Off by default\./);
    assert.match(searchControl, /only on this device/i);
    assert.match(searchControl, /Nothing is sent to Nest or another service\./);
    const analyticsControl = html.match(/<label class="workspace-setting">[\s\S]*?data-popup-setting="grade_analytics_enabled"[\s\S]*?<\/label>/)?.[0] || "";
    assert.match(analyticsControl, /<strong>Enable grade analytics<\/strong>/);
    assert.match(analyticsControl, /Off by default\./);
    assert.match(analyticsControl, /Grade overview to the global Grades page/);
    assert.match(analyticsControl, /per-course analytics to each course Grades page/);
    assert.match(analyticsControl, /never changes Canvas grades/i);
    assert.match(html, /<h2>To-do list<\/h2>/);
    assert.match(html, /<h2>Themes &amp; backups<\/h2>/);
    assert.match(controller, /timeObject/);
    assert.match(html, /data-popup-setting="auto_dark_start" data-time-object/);
    assert.match(controller, /hour: rawValue\.slice\(0, 2\), minute: rawValue\.slice\(3, 5\)/);

    const expectedCategories = new Set([
        "overview", "appearance", "sidebar", "course-cards", "study-tools",
        "themes", "gpa-grades", "canvas-search", "calendar-accounts", "data-support"
    ]);
    const tags = Array.from(withoutComments(html).matchAll(/<[^>]+>/g), (match) => match[0]);
    const attribute = (tag, name) => tag.match(new RegExp(`\\b${name}="([^"]+)"`))?.[1] || "";
    const hasClass = (tag, name) => attribute(tag, "class").split(/\s+/).includes(name);
    const railCategories = new Set(tags.filter((tag) => attribute(tag, "data-workspace-target") && attribute(tag, "data-category")).map((tag) => attribute(tag, "data-category")));
    const sectionCategories = new Set(tags.filter((tag) => hasClass(tag, "workspace-section") && attribute(tag, "data-category")).map((tag) => attribute(tag, "data-category")));
    assert.deepEqual(railCategories, expectedCategories);
    assert.deepEqual(sectionCategories, expectedCategories);
    assert.match(html, /id="nav-group-workspace">Workspace<\/p>/);
    assert.match(html, /id="nav-group-customize">Customize<\/p>/);
    assert.match(html, /id="nav-group-study">Study<\/p>/);
    assert.match(html, /id="nav-group-account">Account<\/p>/);
    assert.doesNotMatch(html, /nav-group-look/);
    // We ship no premium tier, so the rail has no locked or disabled rows.
    assert.doesNotMatch(html, /workspace-nav-lock/);
    assert.doesNotMatch(withoutComments(html).slice(html.indexOf('class="workspace-nav"'), html.indexOf("</nav>")), /\bdisabled\b/);
    // Sidebar belongs with the other look-and-feel categories, not with Study.
    const customizeGroup = withoutComments(html).match(/aria-labelledby="nav-group-customize"[\s\S]*?<\/div>/)[0];
    ["appearance", "themes", "course-cards", "sidebar"].forEach((category) => {
        assert.ok(customizeGroup.includes(`data-workspace-target="${category}"`), `Customize is missing ${category}`);
    });
    assert.doesNotMatch(html, /id="workspace-preview"/);
    assert.doesNotMatch(html, /data-preview-slot="canvas"/);
    assert.match(renderer, /item\.classList\.toggle\("is-active", active\)/);
    assert.match(renderer, /item\.setAttribute\("aria-current", "page"\)/);
    assert.match(renderer, /querySelectorAll\("\.workspace-nav \[data-workspace-target\]"\)\.forEach/);
    assert.match(renderer, /function bindWorkspaceNavigation\(\)[\s\S]*querySelectorAll\("\[data-workspace-target\]"\)\.forEach/);
    assert.match(controller, /qa\("\.workspace-nav \[data-workspace-target\]"\)\.forEach/);
    assert.match(controller, /qa\("\[data-workspace-target\]"\)\.forEach/);
    assert.match(renderer, /select\.value = next/);
    const railMarkup = withoutComments(html).slice(html.indexOf('class="workspace-nav"'), html.indexOf("</nav>"));
    const railButtons = Array.from(railMarkup.matchAll(/<button\b[^>]*data-workspace-target="([^"]+)"[^>]*>/g));
    assert.equal(railButtons.find(([tag, category]) => category === "overview")[0].includes('class="is-active"'), true);
    assert.equal(railButtons.find(([tag, category]) => category === "overview")[0].includes('aria-current="page"'), true);
    railButtons.filter(([, category]) => category !== "overview").forEach(([tag]) => assert.equal(/\baria-current=/.test(tag), false));
});

test("save status uses one canonical live announcer without a redundant workspace readout", () => {
    const live = html.match(/<[^>]+id="save-status-live"[^>]*>/)?.[0] || "";
    assert.ok(live, "the canonical save-status announcer remains present");
    assert.match(live, /aria-live="polite"/);
    assert.match(live, /role="status"/);
    assert.doesNotMatch(html, /id="workspace-save-status"/);
    assert.doesNotMatch(html, /id="(?:popup-settings-status|workspace-last-saved-value|fullscreen-status)"/);
    assert.doesNotMatch(renderer, /Showing \$\{(?:applied|context\.category)\}\. Settings sync automatically\./);
    assert.match(controller, /const live = q\("#save-status-live"\)/);
    const popupRuntime = fs.readFileSync(path.join(root, "js/popup.js"), "utf8");
    assert.doesNotMatch(popupRuntime, /home-save-status/, "the retired Home status surface must not be revived");
    assert.match(renderer, /function setCanonicalSaveStatus\(message\)/);
    assert.match(renderer, /getElementById\("save-status-live"\)/);
});

test("embedded workspace keeps category navigation accessible at narrow shell widths", () => {
    assert.match(css, /@container shell \(width < 700px\)/);
    assert.match(css, /body\[data-navigation-page="list"\] \.workspace-content \{ display: none/);
    assert.match(html, /id="workspace-back"/);
    assert.match(css, /\.workspace-disclosure textarea \{[^}]*max-width:\s*100%/);
});

test("modern setting controls retain visible keyboard focus and descriptive labels", () => {
    assert.match(html, /<strong>Enable To-Do List<\/strong>/);
    assert.match(html, /<label class="workspace-setting"[^>]*><span><strong>Course ID<\/strong>/);
    assert.match(css, /\.workspace-stage :is\(a, button, input, select, textarea, summary, \[tabindex\]\):focus-visible/);
    assert.match(css, /\.workspace-setting select \{[^}]*min-height:\s*44px/);
    assert.match(css, /\.settings-switch:checked/);
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

test("notification Escape returns focus through the existing helper without outside-click focus theft", () => {
    let focused = false;
    let closed = false;
    const event = { key: "Escape", preventDefault() { this.prevented = true; } };
    const handled = popup.handlePopoverEscape(event, () => { closed = true; return true; }, { focus() { focused = true; } });
    assert.equal(handled, true);
    assert.equal(closed, true);
    assert.equal(focused, true);
    assert.equal(event.prevented, true);
    assert.match(renderer, /handlePopoverEscape\(event, close, openTrigger\)/);
    assert.match(renderer, /if \(!event\.target\?\.closest\?\.\("\.compact-popover-anchor"\)\) close\(\)/);
    assert.match(html, /id="notifications-button"[^>]*aria-controls="notifications-popover"[^>]*aria-expanded="false"/);
});

test("notification runtime closes on Escape, ignores unrelated keys, and leaves outside-click focus alone", async () => {
    const runtime = createEditCanvasRuntime("?view=workspace&category=overview");
    await runtime.flush();
    const { document, nodes } = runtime;
    const { notificationsButton, notificationsPopover } = nodes;

    notificationsButton.dispatchEvent({ type: "click" });
    assert.equal(notificationsPopover.hidden, false);
    assert.equal(notificationsPopover.getAttribute("aria-hidden"), null);
    assert.equal(notificationsButton.getAttribute("aria-expanded"), "true");

    const unrelated = { type: "keydown", key: "Enter", target: notificationsPopover, preventDefault() { this.prevented = true; } };
    document.dispatchEvent(unrelated);
    assert.equal(notificationsPopover.hidden, false, "unrelated key does not close the notification tray");
    assert.equal(notificationsButton.getAttribute("aria-expanded"), "true");
    assert.equal(unrelated.prevented, undefined, "unrelated key does not invoke Escape handling");

    const escape = { type: "keydown", key: "Escape", target: notificationsPopover, preventDefault() { this.prevented = true; } };
    document.dispatchEvent(escape);
    assert.equal(notificationsPopover.hidden, true);
    assert.equal(notificationsPopover.getAttribute("aria-hidden"), "true");
    assert.equal(notificationsButton.getAttribute("aria-expanded"), "false");
    assert.equal(document.activeElement, notificationsButton, "Escape returns focus to the trigger");
    assert.equal(escape.prevented, true);

    notificationsButton.dispatchEvent({ type: "click" });
    assert.equal(notificationsPopover.hidden, false);
    assert.equal(notificationsButton.getAttribute("aria-expanded"), "true");
    const outside = { closest() { return null; } };
    document.activeElement = outside;
    document.dispatchEvent({ type: "mousedown", target: outside });
    assert.equal(notificationsPopover.hidden, true);
    assert.equal(notificationsPopover.getAttribute("aria-hidden"), "true");
    assert.equal(notificationsButton.getAttribute("aria-expanded"), "false");
    assert.equal(document.activeElement, outside, "outside click does not force focus to the trigger");
});

test("notification tray stays within the local viewport and repositions on resize", async () => {
    const runtime = createEditCanvasRuntime("?embedded=1&category=overview");
    await runtime.flush();
    const { notificationsButton, notificationsPopover } = runtime.nodes;
    notificationsButton.getBoundingClientRect = () => ({ left: 600, top: 430, right: 632, bottom: 470, width: 32, height: 40 });
    notificationsPopover.getBoundingClientRect = () => ({ width: 280 });

    notificationsButton.click();
    assert.equal(notificationsPopover.style.position, "fixed");
    assert.equal(notificationsPopover.style.left, "348px");
    assert.equal(notificationsPopover.style.top, "auto");
    assert.equal(notificationsPopover.style.bottom, "58px");
    assert.equal(notificationsPopover.style.maxHeight, "410px");
    assert.match(renderer, /window\.addEventListener\?\.\("resize", positionVisibleTray\)/);
    assert.match(renderer, /document\.documentElement\?\.getBoundingClientRect\?\./);
});

test("popup keeps stable IDs/scripts and has no legacy options runtime route", () => {
    [
        "workspace-view", "workspace-category-select", "workspace-section-sidebar",
        "workspace-section-calendar-accounts", "sidebar-page-list", "workspace-account-trigger", "workspace-account-avatar", "workspace-account-name", "workspace-account-source", "workspace-account-status",
        "account-section-avatar", "account-section-name", "account-section-source", "account-section-status", "account-section-binding",
        "popup-export-settings", "popup-import-settings", "popup-reset-settings", "compact-expand",
        "custom-background-link-workspace", "local-theme-search", "local-theme-sort",
        "local-export-select-all", "local-export-select-none", "local-export-selected"
    ].forEach((id) => assert.match(html, new RegExp(`id="${id}"`), `missing popup id: ${id}`));
    assert.doesNotMatch(html, /Open fullscreen Edit Canvas/);
    [
        "../js/settings-schema.js", "../js/platform/contract.js", "../js/popup-controller.js",
        "../js/edit-canvas.js", "../js/popup.js"
    ].forEach((script) => assert.match(html, new RegExp(`src="${script.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`)));
    assert.doesNotMatch(html, /options\.html/);
    assert.doesNotMatch(renderer, /openOptionsPage/);
});

test("Phase 3 appearance controls use the reserved schema keys with labelled, dependency-aware inputs", () => {
    ["customBackgroundLink", "customBackgroundOpacity", "customBackgroundBlur", "cardImageRoundness", "cardPadding", "card_letter_grade_visible"].forEach((key) => {
        assert.match(html, new RegExp(`data-popup-setting="${key}"`), `missing Phase 3 setting ${key}`);
    });
    assert.match(html, /id="local-theme-sort"/);
    assert.doesNotMatch(html, /id="local-theme-sort"[^>]*data-popup-setting=/, "local browse order must not enter the Canvas-settings transaction");
    assert.match(html, /id="custom-background-dependency-help"/);
    assert.match(html, /data-background-dependent/);
    ["custom-background-opacity-workspace", "custom-background-blur-workspace"].forEach((id) => {
        const tag = html.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`))?.[0] || "";
        assert.match(tag, /aria-describedby="custom-background-dependency-help"/);
    });
    assert.match(html, /id="local-export-select-all"/);
    assert.match(html, /id="local-export-select-none"/);
    assert.match(html, /id="local-export-options"/);
    assert.match(html, /src="\.\.\/js\/local-themes\.js"/);
    assert.ok(html.indexOf('src="../js/local-themes.js"') < html.indexOf('src="../js/popup-controller.js"'), "local theme API loads before the controller mounts it");
    assert.doesNotMatch(fs.readFileSync(path.join(root, "js/popup.js"), "utf8"), /\bthemes\b/, "popup runtime has no legacy themes global");
});

test("Edit Canvas keeps search and editor actions modern-only", () => {
    assert.doesNotMatch(renderer, /querySelectorAll\("#legacy-interface \\.option > input\[type=['"]radio['"]\]"\)/);
    assert.doesNotMatch(renderer, /legacyRadioInteractionsBound/);
    assert.doesNotMatch(renderer, /data-legacy-target|openLegacyTarget/);
    assert.match(renderer, /openModernTarget/);
    assert.doesNotMatch(renderer, /#legacy-interface input/);
});

test("every retired launcher has a modern Workspace owner", () => {
    [
        "modern-custom-font", "modern-custom-css", "modern-background-presets", "modern-dark-palette",
        "modern-course-save", "modern-course-reset", "modern-gpa-bounds", "modern-gpa-preset-apstudy",
        "local-theme-list", "popup-import-settings", "modern-diagnostics-load", "modern-canvas-origin-save"
    ].forEach((id) => assert.match(html, new RegExp(`id="${id}"`), `modern mount ${id}`));
    assert.doesNotMatch(html, /data-legacy-target/);
    assert.doesNotMatch(renderer, /\.click\(\).*?(?:customize-dark-btn|advanced-settings|gpa-bounds-btn|report-issue-btn)/s);
});

test("modern editor mounts use injected controller dependencies and confirmation paths", () => {
    const controller = fs.readFileSync(path.join(root, "js/popup-controller.js"), "utf8");
    assert.match(controller, /function modernEditorDependencies\(\)/);
    assert.match(controller, /createCourseCardEditor\(deps\)/);
    assert.match(controller, /createGpaBoundsEditor\(\{ \.\.\.deps, render:/);
    assert.match(controller, /createAppearanceTools\(\{ \.\.\.deps/);
    assert.match(controller, /APStudyCanvasDiagnosticsTransport/);
    assert.match(controller, /inspectCanvas: \(\) => diagnosticsTransport\?\.inspectCanvas\?\.\(\)/);
    assert.match(controller, /requestCustomOrigin: \(origin\) => diagnosticsTransport\?\.requestCustomOrigin\?\.\(origin\)/);
    assert.match(controller, /function mountLocalThemeBrowser\(\)/);
    assert.match(controller, /localThemes\.setup\(doc, chromeService, settingsSchemaApi, \{\s*runThemeImportTransaction: runLocalThemeTransaction,\s*persistSort: persistLocalThemeSort\s*\}\)/);
    assert.match(controller, /confirm: \(message\) => typeof win\?\.confirm !== "function" \|\| win\.confirm\(message\)/);
    assert.match(controller, /settingsStore\.transaction\(resolved\)/);
});

test("modern palette and card status mounts retain drafts and outcomes without legacy controls", () => {
    const controller = fs.readFileSync(path.join(root, "js/popup-controller.js"), "utf8");
    ["modern-dark-palette-tools", "modern-dark-palette-apply", "modern-dark-palette-discard", "modern-dark-fixer-save", "modern-card-status"].forEach((id) => {
        assert.match(html, new RegExp(`id="${id}"`));
    });
    assert.match(controller, /modernDarkPaletteDraft/);
    assert.match(controller, /Dark palette could not be saved\. Your draft is still here\./);
    assert.match(controller, /Course card could not be saved\. Your draft is still here\./);
    assert.match(controller, /diagnostics\.inspect\(\)/);
    assert.doesNotMatch(controller, /discard-custom-styles|discard-dark-palette/);
});

test("dormant fullscreen markup is hidden and has no misleading accessible label", () => {
    const markup = html.match(/<button\b[^>]*id="compact-expand"[^>]*>[\s\S]*?<\/button>/)?.[0] || "";
    const tag = markup.match(/^<button\b[^>]*>/)?.[0] || "";
    assert.ok(markup, "missing compact-expand markup");
    assert.match(tag, /\bhidden\b/);
    assert.doesNotMatch(tag, /\b(?:aria-label|aria-pressed|title|tabindex)\s*=/);
    assert.doesNotMatch(markup, /(?:Enter|Exit) fullscreen/i);
});

test("the global search is the only search bound in every Workspace shell", () => {
    assert.match(renderer, /setupGlobalSearch\(\)/);
    assert.match(renderer, /inputId: "global-search-input"/);
    assert.doesNotMatch(renderer, /inputId: "workspace-search-input"/);
    assert.match(renderer, /ArrowDown/);
    assert.match(renderer, /bindNavKeyboard/);
    assert.match(renderer, /bindEmbeddedFocusBridge/);
    assert.match(renderer, /themeDraft/);
    assert.match(renderer, /confirmLeave/);
});

test("startup recovery separates embedded new-tab escape from standalone Workspace overview", () => {
    const errorArea = html.match(/<section class="workspace-error-area"[\s\S]*?<\/section>/)?.[0] || "";
    assert.match(errorArea, /id="workspace-error-retry"[^>]*>Reload workspace<\/button>/);
    assert.match(errorArea, /data-recovery-shell="embedded"[^>]*href="\.\.\/html\/popup\.html\?view=workspace"[^>]*target="_blank"[^>]*>Open in a new tab<\/a>/);
    assert.match(errorArea, /data-recovery-shell="standalone"[^>]*href="\.\.\/html\/popup\.html"[^>]*>Return to Workspace overview<\/a>/);
    assert.doesNotMatch(errorArea, /data-recovery-shell="standalone"[^>]*target="_blank"/);
    assert.doesNotMatch(errorArea, /data-recovery-shell="(?:embedded|standalone)"[^>]*data-workspace-home/);
    assert.match(controller, /#workspace-error-retry"\)\?\.addEventListener\?\.\("click", \(\) => win\?\.location\?\.reload\?\.\(\)\)/);
});

test("workspace setting guidance preserves refresh copy only for script blockers", () => {
    assert.match(html, /Block tool scripts<\/strong><small>Compatibility only\. Refresh Canvas after changing it/);
    assert.match(html, /Block editor\/media scripts<\/strong><small>Compatibility only\. Refresh Canvas after changing it/);
    assert.match(renderer, /explainDisabledControls/);
    // Rows are <label>s, so the info button sits outside the label and points at
    // the row's own <small> rather than inventing new copy.
    const infoButtons = Array.from(html.matchAll(/<button\b[^>]*class="workspace-info"[^>]*>/g), (match) => match[0]);
    assert.ok(infoButtons.length >= 3 && infoButtons.length <= 4, `expected 3-4 info buttons, found ${infoButtons.length}`);
    infoButtons.forEach((tag) => {
        assert.match(tag, /aria-expanded="false"/);
        assert.match(tag, /aria-describedby="([^"]+)"/);
        assert.match(tag, /aria-label="/);
        const target = tag.match(/aria-describedby="([^"]+)"/)[1];
        assert.match(html, new RegExp(`<small id="${target}">`), `info button describes a missing note: ${target}`);
    });
    assert.match(controller, /bindSettingInfo\(\)/);
    assert.match(html, /id="modern-css-apply"/);
    assert.match(html, /id="modern-dark-palette-apply"/);
    // aria-expanded has to track the row it opens, and the info dot's target has
    // to reach 48px without eating into the toggle beside it.
    assert.match(controller, /button\.setAttribute\?\.\("aria-expanded", String\(next\)\)/);
    assert.match(controller, /row\.dataset\.infoOpen = String\(next\)/);
    assert.match(css, /\.workspace-setting\.has-info\[data-info-open="true"\] > label small \{[^}]*white-space: normal/);
    assert.match(css, /\.workspace-info::after \{[^}]*inset: -10px/);
});

// Phase 7. Every dimmed row is the sidebar dependency group, and dimming alone
// says nothing — aria-disabled has to be paired with a sentence the user can
// read. The reason lives inside the row's <label>, which is only safe because
// every dependent control carries an explicit aria-label, so the added copy never
// reaches an accessible name.
test("dimmed dependent rows carry aria-disabled and a readable reason, not just opacity", () => {
    assert.match(controller, /const SIDEBAR_DEPENDENCY_REASON = "Turn on Enable New Sidebar to change this\."/);
    assert.match(controller, /setSidebarDependencyReason\(node, !enabled, index\)/);
    assert.match(controller, /reason\.className = "control-disabled-reason"/);
    assert.match(controller, /control\.setAttribute\?\.\("aria-disabled", String\(!enabled\)\)/);
    // Turning the master switch back on has to remove both the copy and the
    // association, or the row keeps describing a state it is no longer in.
    assert.match(controller, /if \(!disabled\) \{\s*existing\?\.remove\?\.\(\);/);
    assert.match(controller, /startsWith\("sidebar-dependency-reason-"\)/);

    const dependent = Array.from(
        html.matchAll(/<label\b[^>]*data-sidebar-control="(layout|collapsed|advanced-layout)"[^>]*>[\s\S]*?<\/label>/g),
        (match) => match[0]
    );
    assert.ok(dependent.length >= 8, `expected the dependent sidebar rows, found ${dependent.length}`);
    dependent.forEach((row) => {
        assert.match(row, /aria-label="/, "a dependent row without aria-label would absorb the reason copy into its name");
    });
});

// State-specific live regions latch their content so they do not re-announce
// text that has not changed.
test("live regions latch on state, not on every render", () => {
    assert.match(controller, /const current = readout\.dataset \? readout\.dataset\.state : readout\.getAttribute\?\.\("data-state"\)/);
    assert.match(controller, /if \(current === next\) return;/);
    assert.match(html, /id="better-todo-optin-state" data-state="on" aria-live="polite"/);

    const content = fs.readFileSync(path.join(root, "js/content.js"), "utf8");
    assert.match(content, /status\.setAttribute\?\.\("aria-live", "polite"\)/);
    assert.match(content, /if \(status\.dataset\?\.canvasrefinedGpaState === next\) return;/);
    assert.match(content, /status\.dataset\.canvasrefinedGpaState = next/);
    // The region is created once and kept, so it is the note appearing inside an
    // existing region that gets announced, not a region appearing from nowhere.
    assert.match(content, /const existing = card\.querySelector\("\.canvasrefined-gpa-status"\);\s*if \(existing\) return existing;/);
});

// The rail injects into Canvas's own DOM, so its faces are declared by
// js/content/font-faces.js via runtime.getURL() (manifest CSS would resolve
// url() against the Canvas page) and must stay web-accessible. DESIGN.md names
// Newsreader for section headers.
test("the right rail uses the mandated display face and reaches reduced motion", () => {
    const rail = fs.readFileSync(path.join(root, "css/content.css"), "utf8");
    const fontFaces = fs.readFileSync(path.join(root, "js/content/font-faces.js"), "utf8");
    assert.match(fontFaces, /urlFor\("newsreader-latin\.woff2"\)/);
    assert.match(fontFaces, /font-family: "Newsreader"; src: url\("\$\{newsreader\}"\) format\("woff2"\)/);
    assert.match(fontFaces, /urlFor\("ibm-plex-mono-latin-500\.woff2"\)/);
    assert.match(rail, /#better-todo-header h2 \{[^}]*font-family: "Newsreader", ui-serif, serif !important/);
    // DESIGN.md floors display letter-spacing at -0.04em.
    const heading = rail.slice(rail.indexOf("#better-todo-header h2 {"));
    const spacing = Number(heading.slice(0, heading.indexOf("}")).match(/letter-spacing:\s*(-?[\d.]+)em/)[1]);
    assert.ok(spacing >= -0.04, `display letter-spacing ${spacing}em is tighter than the -0.04em floor`);
    // Reduced motion has to reach the ring, whose transition is written inline by
    // renderProgressRing(); author !important outranks a non-important inline
    // declaration, which is why this is the rule that wins.
    const reduced = rail.slice(rail.indexOf("@media (prefers-reduced-motion: reduce)"));
    [".canvasrefined-progress-ring", "#better-todo-indicator"].forEach((selector) => {
        assert.ok(reduced.includes(selector), `reduced motion misses ${selector}`);
    });
    assert.match(reduced, /transition: none !important/);
    assert.match(reduced, /animation: none !important/);
    const content = fs.readFileSync(path.join(root, "js/content.js"), "utf8");
    assert.match(content, /fg\.style\.transition = 'stroke-dashoffset \.8s/);
});

// U-8. Enabling better_todo empties Canvas's own #right-side and keeps only
// .events_list.recent_feedback, so the panel has to say that in full rather
// than leave it in a one-line clamped note.
test("To-Do states that it replaces Canvas's right sidebar", () => {
    const schema = require("../../js/settings-schema.js");
    assert.equal(schema.syncDefaults.better_todo, true, "the factory enables the To-Do rail");

    const group = html.match(/<div class="workspace-group" id="better-todo-optin">[\s\S]*?<\/output>/);
    assert.ok(group, "missing the better_todo opt-in group");
    const optin = group[0];
    assert.match(optin, /data-popup-setting="todo_enabled"/);
    assert.match(optin, /replaces Canvas’s own right sidebar/);
    assert.match(optin, /Recent Feedback/);
    assert.match(optin, /restores the native rail immediately/);
    assert.doesNotMatch(optin, /[Rr]eload Canvas after changing/);
    assert.match(optin, /id="better-todo-optin-note"/);
    assert.match(optin, /aria-describedby="setting-info-better-todo better-todo-optin-note"/);
    assert.match(optin, /<output class="workspace-optin-state" id="better-todo-optin-state" data-state="on" aria-live="polite">On/);

    assert.match(css, /\.workspace-optin-note \{/);
    assert.match(css, /\.workspace-optin-state\[data-state="on"\]/);
    assert.match(controller, /function renderBetterTodoOptIn\(value\)/);
    assert.match(controller, /if \(key === "better_todo"\) renderBetterTodoOptIn\(value\);/);
    // No silent default flip and no one-time write to the user's stored value.
    assert.doesNotMatch(controller, /better_todo["']?\s*:\s*true/);
});
