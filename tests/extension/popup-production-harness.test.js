"use strict";

// This is deliberately a document-level harness, not a controller unit test.
// It parses popup.html, executes its production scripts in tag order, and
// models the first iframe layout where geometry is still zero but CSS has
// already selected the desktop rail.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "../..");
const popupHtml = fs.readFileSync(path.join(root, "html/popup.html"), "utf8");
const categoryNames = ["overview", "appearance", "sidebar", "course-cards", "study-tools", "themes", "gpa-grades", "canvas-search", "calendar-accounts", "data-support"];

function attributes(tag) {
    return Object.fromEntries(Array.from(tag.matchAll(/([:\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g))
        .filter(([, name]) => !["button", "section", "select", "option", "div", "nav", "header", "body", "script"].includes(name))
        .map(([, name, quoted, single, bare]) => [name, quoted ?? single ?? bare ?? ""]));
}

function createNode(tag, attrs = {}) {
    const listeners = new Map();
    const attributesMap = new Map(Object.entries(attrs));
    const classes = new Set((attrs.class || "").split(/\s+/).filter(Boolean));
    const dataset = Object.fromEntries(Object.entries(attrs)
        .filter(([name]) => name.startsWith("data-"))
        .map(([name, value]) => [name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), value]));
    return {
        tagName: tag.toUpperCase(), id: attrs.id || "", dataset, parentElement: null,
        hidden: Object.hasOwn(attrs, "hidden"), inert: Object.hasOwn(attrs, "inert"), tabIndex: attrs.tabindex ? Number(attrs.tabindex) : 0,
        value: attrs.value || "", textContent: "", children: [], style: {}, clickCount: 0, classList: {
            toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
            contains(name) { return classes.has(name); }, add(name) { classes.add(name); }, remove(name) { classes.delete(name); }
        },
        addEventListener(type, listener) { const list = listeners.get(type) || []; list.push(listener); listeners.set(type, list); },
        dispatchEvent(event) { (listeners.get(event.type) || []).forEach((listener) => listener.call(this, event)); return !event.defaultPrevented; },
        click() { this.clickCount += 1; return this.dispatchEvent({ type: "click", target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.propagationStopped = true; } }); },
        setAttribute(name, value) { attributesMap.set(name, String(value)); if (name === "inert") this.inert = true; if (name === "hidden") this.hidden = true; },
        removeAttribute(name) { attributesMap.delete(name); if (name === "inert") this.inert = false; if (name === "hidden") this.hidden = false; },
        getAttribute(name) { return attributesMap.get(name) ?? null; }, hasAttribute(name) { return attributesMap.has(name); },
        closest(selector) { if (selector.includes("[data-workspace-target]") && this.dataset.workspaceTarget) return this; return null; },
        contains(node) { return node === this || this.children.includes(node); }, focus() { this.ownerDocument.activeElement = this; },
        querySelector() { return null; }, querySelectorAll() { return []; }, scrollIntoView() {}, getBoundingClientRect() { return { width: this.id === "app-scroll" ? 0 : 700, top: 0, height: 24 }; }
    };
}

function createProductionDocument() {
    const ids = new Map();
    const all = [];
    const nav = createNode("nav", { class: "workspace-nav" });
    const app = createNode("div", { id: "app-scroll" });
    const body = createNode("body", { "data-mode": "workspace" });
    const workspaceMarkup = popupHtml.match(/<div\b[^>]*id="workspace-view"[^>]*>/)?.[0] || '<div id="workspace-view">';
    const workspace = createNode("div", attributes(workspaceMarkup));
    const select = createNode("select", { id: "workspace-category-select" });
    select.options = categoryNames.map((value) => ({ value, selected: value === "overview" }));
    select.parentElement = createNode("label", { class: "workspace-category-select-wrap" });
    const compactBrandMarkup = popupHtml.match(/<button\b[^>]*id="compact-home-trigger"[^>]*>[\s\S]*?<\/button>/)?.[0] || "";
    const overviewTrigger = createNode("button", attributes(compactBrandMarkup));
    const accountMarkup = popupHtml.match(/<button\b[^>]*id="workspace-account-trigger"[^>]*>[\s\S]*?<\/button>/)?.[0] || "";
    const accountTrigger = createNode("button", attributes(accountMarkup));
    [app, workspace, select, overviewTrigger, accountTrigger].forEach((node) => { node.ownerDocument = null; all.push(node); if (node.id) ids.set(node.id, node); });
    const navMarkup = popupHtml.slice(popupHtml.indexOf('<nav class="workspace-nav"'), popupHtml.indexOf("</nav>", popupHtml.indexOf('<nav class="workspace-nav"')));
    const rail = Array.from(navMarkup.matchAll(/<button\b[^>]*data-workspace-target="([^"]+)"[^>]*>/g), (match) => {
        const node = createNode("button", attributes(match[0]));
        node.parentElement = nav; nav.children.push(node); all.push(node); return node;
    });
    const sections = Array.from(popupHtml.matchAll(/<section\b[^>]*data-category="([^"]+)"[^>]*>/g), (match) => {
        const node = createNode("section", attributes(match[0]));
        node.ownerDocument = null; all.push(node); ids.set(node.id, node); return node;
    });
    const documentListeners = new Map();
    const doc = {
        readyState: "loading", body, activeElement: null, visibilityState: "visible", referrer: "https://canvas.emory.edu/",
        addEventListener(type, listener) { const list = documentListeners.get(type) || []; list.push(listener); documentListeners.set(type, list); },
        dispatchEvent(event) { (documentListeners.get(event.type) || []).forEach((listener) => listener(event)); },
        getElementById(id) { return ids.get(id) || null; },
        createElement(tag) { const node = createNode(tag); node.ownerDocument = doc; return node; },
        querySelector(selector) {
            if (selector === ".workspace-nav") return nav;
            if (selector === "#app-scroll") return app;
            if (selector === "#workspace-category-select") return select;
            if (selector === "#workspace-view") return workspace;
            if (selector === "#compact-home-trigger") return overviewTrigger;
            if (selector.startsWith("#")) return ids.get(selector.slice(1)) || null;
            return null;
        },
        querySelectorAll(selector) {
            if (selector === ".workspace-nav [data-workspace-target]") return rail.filter((node) => node.parentElement === nav);
            if (selector === "[data-workspace-target]") return [...rail, accountTrigger];
            if (selector === ".workspace-section[data-category]") return sections;
            if (selector === ".workspace-overview-link[data-workspace-overview]") return [];
            if (selector.includes("[data-canvas-load-note]") || selector.includes("[data-popup-setting]") || selector.includes(".workspace-info")) return [];
            return [];
        }
    };
    all.forEach((node) => { node.ownerDocument = doc; }); body.ownerDocument = doc; nav.ownerDocument = doc;
    return { doc, nav, select, overviewTrigger, accountTrigger, all, rail: rail.filter((node) => categoryNames.includes(node.dataset.workspaceTarget)), sections };
}

async function flush() { await new Promise((resolve) => setImmediate(resolve)); await new Promise((resolve) => setImmediate(resolve)); }

function boot(search, { slowOptional = false } = {}) {
    const page = createProductionDocument();
    const initialUrl = new URL(`chrome-extension://jcaaaafnpcgegbcpddpddfhjgkkbjfbp/html/popup.html${search}`);
    const location = { href: initialUrl.href, search: initialUrl.search, origin: initialUrl.origin };
    const windowListeners = new Map();
    const window = {
        location, document: page.doc, parent: null, confirm: () => true,
        addEventListener(type, listener) { const list = windowListeners.get(type) || []; list.push(listener); windowListeners.set(type, list); },
        getComputedStyle(node) { return { display: node === page.select.parentElement ? "none" : "block" }; },
        requestAnimationFrame(callback) { callback(); return 1; },
        ResizeObserver: class { observe() {} }, matchMedia: () => ({ matches: false }), close() {}, open() { return {}; }
    };
    window.parent = window;
    const history = { state: null, replaceState(state, _, href) {
        const next = new URL(href);
        history.state = state;
        location.href = next.href;
        location.search = next.search;
        location.origin = next.origin;
    } };
    window.history = history;
    const chrome = {
        storage: { sync: { get: async () => ({}), set: async () => {} }, local: { get: async () => ({}), set: async () => {} }, onChanged: { addListener() {} } },
        runtime: { sendMessage: () => slowOptional ? new Promise(() => {}) : Promise.resolve({ ok: true }), lastError: null }, tabs: { query: async () => [], getCurrent: async () => null }
    };
    const context = vm.createContext({ AbortController, window, document: page.doc, chrome, history, URL, URLSearchParams, Promise, setTimeout, clearTimeout, console, CSS: { escape: (value) => value }, globalThis: window });
    const scripts = Array.from(popupHtml.matchAll(/<script[^>]+src="([^"]+)"/g), (match) => match[1]);
    for (const src of scripts) vm.runInContext(fs.readFileSync(path.resolve(root, "html", src), "utf8"), context, { filename: src });
    page.doc.readyState = "interactive";
    page.doc.dispatchEvent({ type: "DOMContentLoaded" });
    return { ...page, window, location, history, canvasHostUrl: "https://canvas.emory.edu/courses/123", scripts, flush };
}

function click(node) {
    if (node.parentElement?.inert || node.inert) return false;
    node.click();
    return true;
}

test("production popup document keeps every actual workspace route interactive after a zero-width iframe bootstrap", async () => {
    for (const [label, search, slowOptional] of [
        ["standalone", "?view=workspace", false],
        ["embedded slow optional dependencies", "?embedded=1&overlaySession=production-harness&overlayParentOrigin=https%3A%2F%2Fcanvas.emory.edu", true]
    ]) {
        const runtime = boot(search, { slowOptional });
        assert.deepEqual(runtime.scripts, ["../js/settings-schema.js", "../js/platform/contract.js", "../js/themes.js", "../js/backgrounds.js", "../js/diagnostics-transport.js", "../js/local-themes.js", "../js/platform/connection-coordinator.js", "../js/popup-controller.js", "../js/edit-canvas.js", "../js/popup.js"]);
        await runtime.flush();
        assert.equal(runtime.doc.body.dataset.mode, "workspace", `${label}: Workspace is always the visible surface`);
        assert.equal(runtime.doc.getElementById("workspace-view").hidden, false, `${label}: startup removes the workspace hidden attribute`);
        assert.equal(runtime.doc.getElementById("workspace-view").inert, false, `${label}: startup removes the workspace inert attribute`);
        assert.equal(runtime.doc.getElementById("workspace-view").getAttribute("aria-hidden"), null, `${label}: startup exposes the workspace to accessibility APIs`);
        assert.equal(runtime.location.search.includes("view=workspace"), true, `${label}: Workspace route is recorded without replacing the overlay session`);
        assert.equal(runtime.location.href.startsWith("chrome-extension://jcaaaafnpcgegbcpddpddfhjgkkbjfbp/html/popup.html"), true, `${label}: the iframe keeps its extension document`);
        assert.equal(runtime.canvasHostUrl, "https://canvas.emory.edu/courses/123", `${label}: the Canvas host URL is never replaced`);
        assert.equal(runtime.nav.inert, false, `${label}: desktop CSS must win over stale first-layout geometry`);

        for (const button of runtime.rail) {
            assert.equal(click(button), true, `${label}: ${button.dataset.workspaceTarget} receives a native mouse click`);
            assert.equal(runtime.window.APStudyCanvasWorkspace.category, button.dataset.workspaceTarget);
            assert.equal(runtime.location.search.includes(`category=${button.dataset.workspaceTarget}`), button.dataset.workspaceTarget !== "overview");
        }
        for (const button of runtime.rail) {
            button.dispatchEvent({ type: "keydown", target: button, key: "Enter", preventDefault() {} });
            assert.equal(click(button), true, `${label}: ${button.dataset.workspaceTarget} receives keyboard activation`);
            assert.equal(runtime.window.APStudyCanvasWorkspace.category, button.dataset.workspaceTarget);
        }
        runtime.select.value = "gpa-grades";
        runtime.select.dispatchEvent({ type: "change", target: runtime.select });
        assert.equal(runtime.window.APStudyCanvasWorkspace.category, "gpa-grades", `${label}: the narrow picker routes through the same category state`);
        assert.equal(click(runtime.overviewTrigger), true, `${label}: the compact brand remains an in-place Overview route`);
        await runtime.flush();
        assert.equal(runtime.doc.body.dataset.mode, "workspace", `${label}: Overview never hides Workspace`);
        assert.equal(runtime.window.APStudyCanvasWorkspace.category, "overview", `${label}: the compact brand returns to Overview without waiting for optional work`);
        assert.equal(click(runtime.accountTrigger), true, `${label}: account context routes into its dedicated section`);
        assert.equal(runtime.window.APStudyCanvasWorkspace.category, "calendar-accounts", `${label}: account context selects Account & calendar`);
    }
});
