"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "../..");
const manifest = require("../../manifest.json");
const registration = require("../../js/platform/canvas-registration.js");

function walk(node) { return node ? [node, ...node.children.flatMap(walk)] : []; }
class Node {
    constructor(doc, tagName = "div") { this.ownerDocument = doc; this.tagName = tagName.toUpperCase(); this.children = []; this.parentElement = null; this.dataset = {}; this.attributes = new Map(); this.listeners = new Map(); this.hidden = false; this.value = ""; this.textContent = ""; this.className = ""; this.style = {}; this.classList = { add() {}, remove() {}, contains() { return false; } }; }
    append(...nodes) { nodes.filter(Boolean).forEach((node) => { node.remove?.(); node.parentElement = this; this.children.push(node); }); }
    appendChild(node) { this.append(node); return node; }
    replaceChildren(...nodes) { this.children.forEach((node) => { node.parentElement = null; }); this.children = []; this.append(...nodes); }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((node) => node !== this); this.parentElement = null; }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) || null; }
    removeAttribute(name) { this.attributes.delete(name); }
    addEventListener(type, listener) { this.listeners.set(type, [...(this.listeners.get(type) || []), listener]); }
    removeEventListener(type, listener) { this.listeners.set(type, (this.listeners.get(type) || []).filter((item) => item !== listener)); }
    dispatchEvent(event) { (this.listeners.get(event.type) || []).slice().forEach((listener) => listener({ preventDefault() {}, target: event.target || this, ...event })); }
    focus() { this.ownerDocument.activeElement = this; }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    querySelectorAll(selector) {
        return walk(this).filter((node) => (selector === "[data-canvas-search-content]" && node.dataset.canvasSearchContent)
            || (selector === "[data-canvas-search-result]" && node.dataset.canvasSearchResult !== undefined)
            || (selector === "button:not([disabled]), input:not([disabled])" && /^(BUTTON|INPUT)$/.test(node.tagName)));
    }
    closest(selector) { let node = this; while (node) { if ((selector === "[data-canvas-search-action]" && node.dataset.canvasSearchAction) || (selector === "[data-canvas-search-result]" && node.dataset.canvasSearchResult !== undefined)) return node; node = node.parentElement; } return null; }
}

function makeRuntime(pathname, { quiz = false } = {}) {
    const documentListeners = new Map(); const windowListeners = new Map(); const storageListeners = [];
    const document = {
        readyState: "loading", title: "Canvas", activeElement: null, shell: false,
        documentElement: new Node(null, "html"), body: null, head: { appendChild() {} }, cookie: "",
        createElement(tag) { return new Node(document, tag); }, getElementById() { return null; },
        querySelector(selector) {
            if (selector === "html") return document.documentElement;
            if (selector.includes("#application") || selector.includes("#wrapper.ic-app")) return document.shell ? document.body : null;
            return null;
        },
        querySelectorAll() { return []; },
        addEventListener(type, listener) { documentListeners.set(type, [...(documentListeners.get(type) || []), listener]); },
        removeEventListener(type, listener) { documentListeners.set(type, (documentListeners.get(type) || []).filter((item) => item !== listener)); },
        dispatch(type) { (documentListeners.get(type) || []).slice().forEach((listener) => listener()); }
    };
    document.documentElement.ownerDocument = document; document.body = new Node(document, "body"); document.documentElement.append(document.body);
    const window = {
        location: { origin: "https://canvas.emory.edu", protocol: "https:", host: "canvas.emory.edu", hostname: "canvas.emory.edu", pathname, href: `https://canvas.emory.edu${pathname}`, assign() {} },
        history: { pushState() {}, replaceState() {} },
        addEventListener(type, listener) { windowListeners.set(type, [...(windowListeners.get(type) || []), listener]); },
        removeEventListener(type, listener) { windowListeners.set(type, (windowListeners.get(type) || []).filter((item) => item !== listener)); },
        dispatch(type, event = {}) { (windowListeners.get(type) || []).slice().forEach((listener) => listener({ preventDefault() {}, target: event.target || document.body, ...event })); },
        setTimeout() { return 0; }, clearTimeout() {}, open() {}
    };
    const syncValues = { canvas_search_enabled: true, custom_cards_3: {} };
    const get = (values) => (keys, callback) => new Promise((resolve) => queueMicrotask(() => { const value = keys === null ? { ...values } : { ...values }; callback?.(value); resolve(value); }));
    const chrome = {
        runtime: { id: "test", getManifest: () => ({ version: "test" }), onMessage: { addListener() {} }, sendMessage() {} },
        storage: {
            sync: { get: get(syncValues), set(values) { Object.assign(syncValues, values); return Promise.resolve(); } },
            local: { get: get({}), set() { return Promise.resolve(); }, remove(key, callback) { callback?.(); return Promise.resolve(); } },
            onChanged: { addListener(listener) { storageListeners.push(listener); }, removeListener(listener) { const index = storageListeners.indexOf(listener); if (index >= 0) storageListeners.splice(index, 1); } }
        }
    };
    class Observer { constructor(callback) { this.callback = callback; } observe() {} disconnect() {} }
    const context = { window, document, chrome, console: { log() {}, warn() {}, error() {}, info() {} }, URL, DOMException, AbortController, MutationObserver: Observer, setTimeout() { return 0; }, clearTimeout() {}, setInterval() { return 0; }, clearInterval() {} };
    context.globalThis = context;
    vm.runInNewContext("globalThis.fetch = async (url) => ({ ok: true, json: async () => String(url).includes('/users/self') ? ({ id: 17, name: 'Student' }) : [] });", context);
    return { context, document, window, chrome, syncValues, storageListeners, setShell(value) { document.shell = value; }, setSearch(value) { const oldValue = syncValues.canvas_search_enabled; syncValues.canvas_search_enabled = value; storageListeners.slice().forEach((listener) => listener({ canvas_search_enabled: { oldValue, newValue: value } }, "sync")); }, quiz };
}

async function settle() { for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setImmediate(resolve)); }
function searchRoots(runtime) { return walk(runtime.document.body).filter((node) => node.className === "apstudy-canvas-search"); }

test("manifest-order search bootstrap waits for Canvas readiness and responds to opt-in changes", async () => {
    const scripts = manifest.content_scripts.find((entry) => entry.matches.includes("https://canvas.emory.edu/*") && entry.js.includes("js/content.js")).js;
    assert.deepEqual(scripts, registration.CANVAS_CONTENT_SCRIPTS, "dynamic registration executes the exact static manifest order");
    for (const pathname of ["/", "/courses/42", "/courses/42/assignments/8", "/courses/42/quizzes/9"]) {
        const runtime = makeRuntime(pathname);
        for (const script of scripts) vm.runInNewContext(fs.readFileSync(path.join(root, script), "utf8"), runtime.context, { filename: script });
        assert.equal(typeof runtime.context.APStudyCanvasContent.CanvasSearchIndex.createCanvasSearchIndex, "function");
        assert.equal(typeof runtime.context.APStudyCanvasContent.CanvasSearchUI.createCanvasSearchUI, "function");
        await settle();
        assert.equal(searchRoots(runtime).length, 0, `${pathname} reproduces the old pre-shell no-binding state`);
        assert.equal(runtime.syncValues.canvas_search_enabled, true, "the full startup snapshot retains the opt-in key");
        vm.runInNewContext("globalThis.__searchSetting = options?.canvas_search_enabled", runtime.context);
        assert.equal(runtime.context.__searchSetting, true, "startup preserves the persisted opt-in preference");
        runtime.setShell(true); runtime.document.readyState = "interactive"; runtime.document.dispatch("DOMContentLoaded"); runtime.window.dispatch("load"); await settle();
        assert.equal(searchRoots(runtime).length, 1, `${pathname} binds after Canvas shell readiness`);
        runtime.window.dispatch("keydown", { key: "k", ctrlKey: true }); runtime.window.dispatch("keydown", { key: "k", metaKey: true });
        assert.equal(searchRoots(runtime).length, 1, "Ctrl+K and Meta+K reuse one root"); assert.equal(searchRoots(runtime)[0].hidden, false);
        runtime.window.dispatch("keydown", { key: "k", ctrlKey: true, target: runtime.document.createElement("input") });
        assert.equal(searchRoots(runtime).length, 1, "editable targets retain their native shortcut behavior");
        runtime.setSearch(false); await settle(); assert.equal(searchRoots(runtime).length, 0, "opt-out clears the mounted root");
        runtime.setSearch(true); await settle(); assert.equal(searchRoots(runtime).length, 1, "opt-in remounts without reload");
    }
});

test("manifest-order search remains absent by default and on active quiz attempts", async () => {
    for (const pathname of ["/", "/courses/42/quizzes/9/take"]) {
        const runtime = makeRuntime(pathname); if (pathname === "/") runtime.syncValues.canvas_search_enabled = false;
        const scripts = registration.CANVAS_CONTENT_SCRIPTS;
        for (const script of scripts) vm.runInNewContext(fs.readFileSync(path.join(root, script), "utf8"), runtime.context, { filename: script });
        runtime.setShell(true); runtime.document.readyState = "complete"; runtime.document.dispatch("DOMContentLoaded"); runtime.window.dispatch("load"); await settle();
        assert.equal(searchRoots(runtime).length, 0, pathname);
    }
});

test("a real popup off-to-on event before Canvas shell readiness retains a single command owner", async () => {
    const runtime = makeRuntime("/courses/42");
    runtime.syncValues.canvas_search_enabled = false;
    for (const script of registration.CANVAS_CONTENT_SCRIPTS) vm.runInNewContext(fs.readFileSync(path.join(root, script), "utf8"), runtime.context, { filename: script });
    await settle();
    runtime.setSearch(true);
    // This is the production failure: the first enabled probe occurs before
    // Canvas inserts its shell, then the page becomes ready later.
    await settle(); assert.equal(searchRoots(runtime).length, 0);
    runtime.setShell(true); runtime.document.readyState = "interactive"; runtime.document.dispatch("DOMContentLoaded"); runtime.window.dispatch("load"); await settle();
    assert.equal(searchRoots(runtime).length, 1, "the deferred popup opt-in mounts exactly one palette");
    runtime.window.dispatch("keydown", { key: "k", metaKey: true });
    runtime.window.dispatch("keydown", { key: "k", ctrlKey: true });
    assert.equal(searchRoots(runtime).length, 1); assert.equal(searchRoots(runtime)[0].hidden, false);
    runtime.setSearch(false); runtime.setSearch(true); await settle();
    assert.equal(searchRoots(runtime).length, 1, "a rapid disable-enable cannot revive a stale bootstrap or duplicate the listener");
});

test("manifest-order disable and quiz-route teardown abort an in-flight Canvas collection", async () => {
    const runtime = makeRuntime("/courses/42");
    for (const script of registration.CANVAS_CONTENT_SCRIPTS) vm.runInNewContext(fs.readFileSync(path.join(root, script), "utf8"), runtime.context, { filename: script });
    runtime.setShell(true); runtime.document.readyState = "complete"; runtime.document.dispatch("DOMContentLoaded"); runtime.window.dispatch("load"); await settle();
    const signals = [];
    runtime.context.fetch = async (url, init) => {
        signals.push(init.signal);
        return new Promise(() => {});
    };
    runtime.window.dispatch("keydown", { key: "k", ctrlKey: true }); await settle();
    assert.ok(signals.length > 0, "Cmd/Ctrl+K begins the real manifest-ordered Canvas collection");
    runtime.setSearch(false); await settle();
    assert.equal(searchRoots(runtime).length, 0, "opt-out removes the command palette during refresh");
    assert.ok(signals.every((signal) => signal.aborted), "opt-out aborts every owned Canvas request");
    runtime.setSearch(true); await settle();
    assert.equal(searchRoots(runtime).length, 1, "a live opt-in remounts without a reload");
    runtime.window.location.pathname = "/courses/42/quizzes/9/take";
    runtime.window.location.href = "https://canvas.emory.edu/courses/42/quizzes/9/take";
    runtime.window.dispatch("popstate"); await settle();
    assert.equal(searchRoots(runtime).length, 0, "a quiz-attempt route tears down the search root");
});
