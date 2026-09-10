"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ui = require("../../js/content/canvas-search-ui.js");

function walk(node) { return node ? [node, ...node.children.flatMap(walk)] : []; }
class Node {
    constructor(doc, tagName) { this.ownerDocument = doc; this.tagName = tagName; this.children = []; this.parentElement = null; this.dataset = {}; this.attributes = {}; this.listeners = new Map(); this.hidden = false; this.value = ""; this.textContent = ""; this.className = ""; }
    append(...nodes) { nodes.filter(Boolean).forEach((child) => { child.parentElement = this; this.children.push(child); }); }
    replaceChildren(...nodes) { this.children.forEach((child) => { child.parentElement = null; }); this.children = []; this.append(...nodes); }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((child) => child !== this); this.parentElement = null; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    removeEventListener(type, listener) { if (this.listeners.get(type) === listener) this.listeners.delete(type); }
    dispatchEvent(event) { this.listeners.get(event.type)?.({ preventDefault() {}, ...event, target: event.target || this }); }
    focus() { this.ownerDocument.activeElement = this; }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    querySelectorAll(selector) {
        return walk(this).filter((node) => {
            if (selector === "[data-canvas-search-content]") return Boolean(node.dataset.canvasSearchContent);
            if (selector === "[data-canvas-search-result]") return node.dataset.canvasSearchResult !== undefined;
            if (selector === "button:not([disabled]), input:not([disabled])") return /^(button|input)$/i.test(node.tagName);
            return false;
        });
    }
    closest(selector) {
        let current = this;
        while (current) {
            if (selector === "[data-canvas-search-action]" && current.dataset.canvasSearchAction) return current;
            if (selector === "[data-canvas-search-result]" && current.dataset.canvasSearchResult !== undefined) return current;
            current = current.parentElement;
        }
        return null;
    }
}
class Document {
    constructor() { this.activeElement = null; this.documentElement = null; this.frames = []; }
    createElement(tag) { return new Node(this, tag); }
    createElementNS(namespace, tag) { const node = this.createElement(tag); node.namespaceURI = namespace; Object.defineProperty(node, "className", { get: () => ({ baseVal: node.attributes.class || "" }) }); return node; }
    querySelectorAll(selector) { return selector === "iframe" ? this.frames : []; }
}
class Window {
    constructor() { this.listeners = new Map(); }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    removeEventListener(type, listener) { if (this.listeners.get(type) === listener) this.listeners.delete(type); }
    dispatch(event) { this.listeners.get(event.type)?.({ preventDefault() { this.prevented = true; }, ...event }); }
}
function tick() { return new Promise((resolve) => setTimeout(resolve, 0)); }
function result(title, href, type = "assignment") { return { title, href, type, course: "Biology", summary: "Week one" }; }
function mounted({ enabled = true, quizSafe = false, theme, query = async () => ({ items: [result("Lab report", "/courses/7/assignments/8")] }), refresh = async () => ({ ok: true }), refreshTimeoutMs } = {}) {
    const document = new Document(); const window = new Window(); const host = document.createElement("main"); const trigger = document.createElement("button"); trigger.focus();
    const index = { query, refresh }; const intents = [];
    const controller = ui.createCanvasSearchUI({ document, window, debounceMs: 0, refreshTimeoutMs });
    const mounted = controller.mount(host, { index, origin: "https://canvas.emory.edu", accountId: "account-7", enabled, quizSafe, theme, collect: async () => [], onNavigate: (intent) => intents.push(intent) });
    return { document, window, host, trigger, index, intents, controller, mounted };
}
function root(host) { return host.children[0]; }
function find(host, predicate) { return walk(root(host)).find(predicate); }

test("search surface is opt-in, owns a labelled modal, refreshes local data, and restores focus after Escape", async () => {
    const fixture = mounted();
    assert.equal(fixture.mounted, true); assert.equal(root(fixture.host).hidden, true);
    fixture.trigger.focus(); assert.equal(fixture.controller.show(), true); await tick(); await tick();
    const searchRoot = root(fixture.host); const input = find(fixture.host, (node) => node.className === "apstudy-canvas-search__input");
    const hiddenTitle = find(fixture.host, (node) => node.className === "apstudy-canvas-search__title apstudy-canvas-search__visually-hidden");
    const field = find(fixture.host, (node) => node.className === "apstudy-canvas-search__field");
    const footer = find(fixture.host, (node) => node.className === "apstudy-canvas-search__footer");
    const close = find(fixture.host, (node) => node.dataset.canvasSearchAction === "close");
    assert.equal(searchRoot.dataset.apstudycanvasOwned, "true"); assert.equal(searchRoot.attributes.role, "dialog"); assert.equal(hiddenTitle.id, "apstudy-canvas-search-title"); assert.equal(input.id, "apstudy-canvas-search-input"); assert.equal(input.attributes.role, "combobox"); assert.equal(input.placeholder, "Search assignments, files, pages…"); assert.match(input.attributes["aria-label"], /modules/); assert.equal(field.children[0].tagName, "svg"); assert.equal(footer.children.length, 4); assert.equal(close.children[0].tagName, "kbd"); assert.equal(fixture.document.activeElement, input);
    input.value = "lab"; searchRoot.dispatchEvent({ type: "input", target: input }); await tick(); await tick();
    assert.match(walk(searchRoot).map((node) => node.textContent).join(" "), /Lab report/);
    searchRoot.dispatchEvent({ type: "keydown", key: "Escape" });
    assert.equal(searchRoot.hidden, true); assert.equal(fixture.document.activeElement, fixture.trigger);
});

test("search appearance accepts Canvas-following and forced theme updates", () => {
    const fixture = mounted({ theme: "dark" });
    assert.equal(root(fixture.host).dataset.extensionTheme, "dark");
    assert.equal(fixture.controller.setTheme("light"), true);
    assert.equal(root(fixture.host).dataset.extensionTheme, "light");
    assert.equal(fixture.controller.setTheme("system"), true);
    assert.equal(root(fixture.host).dataset.extensionTheme, "system");
});

test("loading announces through a hidden live region and shows a compact progress cue", () => {
    const fixture = mounted({ refreshTimeoutMs: 5, refresh: () => new Promise(() => {}) });
    fixture.controller.show();
    const liveStatus = find(fixture.host, (node) => node.className === "apstudy-canvas-search__status apstudy-canvas-search__visually-hidden");
    const loading = find(fixture.host, (node) => node.className === "apstudy-canvas-search__state apstudy-canvas-search__state--loading");
    const spinner = find(fixture.host, (node) => node.className === "apstudy-canvas-search__spinner");
    assert.equal(liveStatus.attributes["aria-live"], "polite"); assert.match(liveStatus.textContent, /Refreshing your local Canvas index/); assert.ok(loading); assert.equal(spinner.attributes["aria-hidden"], "true");
    fixture.controller.close();
});

test("Cmd/Ctrl+K has one owner from the host or a same-origin Canvas iframe", () => {
    const fixture = mounted();
    const frameWindow = new Window();
    const frame = { contentWindow: frameWindow, addEventListener() {}, removeEventListener() {} };
    fixture.document.frames.push(frame);
    // Remount after registering the frame, mirroring a Canvas iframe present
    // when the command surface attaches.
    fixture.controller.destroy();
    fixture.controller.mount(fixture.host, { index: fixture.index, origin: "https://canvas.emory.edu", accountId: "account-7", enabled: true, quizSafe: false, collect: async () => [] });
    frameWindow.dispatch({ type: "keydown", key: "k", metaKey: true, target: { tagName: "DIV" } });
    frameWindow.dispatch({ type: "keydown", key: "k", ctrlKey: true, target: { tagName: "DIV" } });
    assert.equal(fixture.controller.isOpen(), true);
    assert.equal(fixture.host.children.filter((node) => node.className === "apstudy-canvas-search").length, 1);
    fixture.controller.close();
    frameWindow.dispatch({ type: "keydown", key: "k", metaKey: true, target: { tagName: "INPUT" } });
    assert.equal(fixture.controller.isOpen(), false, "editable iframe focus retains its native shortcut behavior");
});

test("keyboard and pointer activation emit only same-origin user-gesture navigation intents", async () => {
    const fixture = mounted({ query: async () => ({ items: [result("Safe", "/courses/7/assignments/8"), result("Unsafe", "https://outside.example/item")] }) });
    fixture.controller.show(); await tick(); await tick(); await tick();
    const searchRoot = root(fixture.host); const searchInput = find(fixture.host, (node) => node.className === "apstudy-canvas-search__input"); searchInput.value = "safe"; searchRoot.dispatchEvent({ type: "input", target: searchInput }); await tick(); await tick();
    const item = find(fixture.host, (node) => node.dataset.canvasSearchResult === "0"); assert.ok(item); searchRoot.dispatchEvent({ type: "click", target: item, shiftKey: true });
    assert.deepEqual(fixture.intents, [{ type: "canvas-search-navigation", href: "/courses/7/assignments/8", disposition: "new-tab", userGesture: true, source: "canvas-search" }]);
    const keyboard = mounted({ query: async () => ({ items: [result("Safe", "/courses/7/assignments/8")] }) }); keyboard.controller.show(); await tick(); await tick(); await tick();
    const keyboardInput = find(keyboard.host, (node) => node.className === "apstudy-canvas-search__input"); keyboardInput.value = "safe"; root(keyboard.host).dispatchEvent({ type: "input", target: keyboardInput }); await tick(); await tick();
    root(keyboard.host).dispatchEvent({ type: "keydown", key: "Enter", ctrlKey: true });
    assert.equal(keyboard.intents.length, 1); assert.equal(keyboard.intents[0].disposition, "new-tab");
});

test("shortcut avoids editable controls, fails closed on opt-out or quiz-safe routes, and destroy cancels its owned UI", () => {
    const disabled = mounted({ enabled: false }); assert.equal(disabled.mounted, false);
    const quiz = mounted({ quizSafe: true }); assert.equal(quiz.mounted, false);
    const fixture = mounted(); const input = fixture.document.createElement("input"); fixture.window.dispatch({ type: "keydown", key: "k", ctrlKey: true, target: input }); assert.equal(fixture.controller.isOpen(), false);
    fixture.window.dispatch({ type: "keydown", key: "k", ctrlKey: true, target: fixture.host }); assert.equal(fixture.controller.isOpen(), true);
    fixture.controller.destroy(); assert.equal(fixture.host.children.length, 0); assert.equal(fixture.controller.isMounted(), false);
});

test("error and empty states are announced, and Nest-aligned CSS keeps controls usable", async () => {
    const fixture = mounted({ query: async () => { throw new Error("offline"); }, refresh: async () => ({ ok: false }) });
    fixture.controller.show(); await tick(); await tick();
    assert.match(walk(root(fixture.host)).map((node) => node.textContent).join(" "), /index refresh failed/);
    const source = fs.readFileSync(path.resolve(__dirname, "../../css/canvas-search.css"), "utf8");
    assert.match(source, /@media \(max-width:520px\)/); assert.match(source, /@media \(prefers-reduced-motion:reduce\)[\s\S]*animation:none !important/); assert.match(source, /__field:focus-within[^}]*#D4AF37/); assert.match(source, /\.apstudy-canvas-search #apstudy-canvas-search-input[^}]*border:0!important[^}]*box-shadow:none!important/); assert.doesNotMatch(source, /appearance:none/); assert.match(source, /:focus-visible/); assert.match(source, /max-block-size:min\(680px/); assert.match(source, /__group-title[^}]*text-transform:uppercase/); assert.match(source, /__result\[aria-selected="true"\][^}]*box-shadow:inset 3px 0 0 #D4AF37/); assert.match(source, /__footer[^}]*border-block-start/); assert.match(source, /__state--loading[^}]*display:flex/); assert.match(source, /__spinner[^}]*animation:apstudy-canvas-search-spin/); assert.doesNotMatch(source, /fetch\s*\(/);
});

test("partial and rate-limited refreshes explain recovery without discarding the search surface", async () => {
    const partial = mounted({ refresh: async () => ({ ok: true, partial: true }) });
    partial.controller.show(); await tick(); await tick(); await tick();
    assert.match(walk(root(partial.host)).map((node) => node.textContent).join(" "), /Some Canvas resource types were unavailable/);
    const limited = mounted({ refresh: async () => ({ ok: false, code: "CANVAS_SEARCH_RATE_LIMITED" }) });
    limited.controller.show(); await tick(); await tick();
    assert.match(walk(root(limited.host)).map((node) => node.textContent).join(" "), /asked us to slow down/);
    for (const [code, copy] of [["CANVAS_SEARCH_TIMEOUT", /took too long/], ["CANVAS_SEARCH_WRITE_FAILED", /could not be saved/], ["CANVAS_SEARCH_CANCELLED", /was cancelled/]]) {
        const fixture = mounted({ refresh: async () => ({ ok: false, code }) });
        fixture.controller.show(); await tick(); await tick();
        assert.match(walk(root(fixture.host)).map((node) => node.textContent).join(" "), copy);
        assert.ok(find(fixture.host, (node) => node.dataset.canvasSearchAction === "refresh"), `${code} leaves an enabled retry action`);
    }
});

test("a hung provider, rejected auth/network refresh, and retry all settle into an actionable state", async () => {
    let attempts = 0;
    const fixture = mounted({
        refreshTimeoutMs: 5,
        refresh: async () => {
            attempts += 1;
            if (attempts === 1) return new Promise(() => {});
            if (attempts === 2) throw Object.assign(new Error("unauthorized"), { status: 401 });
            return { ok: true };
        }
    });
    fixture.controller.show(); await new Promise((resolve) => setTimeout(resolve, 50)); await tick();
    assert.match(walk(root(fixture.host)).map((node) => node.textContent).join(" "), /took too long/);
    let retry = find(fixture.host, (node) => node.dataset.canvasSearchAction === "refresh"); root(fixture.host).dispatchEvent({ type: "click", target: retry }); await tick(); await tick();
    assert.match(walk(root(fixture.host)).map((node) => node.textContent).join(" "), /refresh failed/);
    retry = find(fixture.host, (node) => node.dataset.canvasSearchAction === "refresh"); root(fixture.host).dispatchEvent({ type: "click", target: retry }); await tick(); await tick();
    assert.match(walk(root(fixture.host)).map((node) => node.textContent).join(" "), /Start typing/);
    assert.equal(attempts, 3);
});

function typeQuery(fixture, value) {
    const input = find(fixture.host, (node) => node.className === "apstudy-canvas-search__input");
    input.value = value;
    root(fixture.host).dispatchEvent({ type: "input", target: input });
    return input;
}
function textOf(fixture) { return walk(root(fixture.host)).map((node) => node.textContent).join(" "); }

test("typing during refresh searches cached data then displays newly collected results without replacing the input", async () => {
    let finish; let refreshed = false;
    const fixture = mounted({
        refresh: () => new Promise((resolve) => { finish = () => { refreshed = true; resolve({ ok: true }); }; }),
        query: async ({ query }) => ({ items: query ? [result(refreshed ? "New lab" : "Cached lab", "/courses/7/assignments/8")] : [] })
    });
    fixture.controller.show();
    const input = typeQuery(fixture, "lab"); await tick(); await tick();
    assert.match(textOf(fixture), /Cached lab/);
    assert.match(textOf(fixture), /Refreshing/);
    finish(); await tick(); await tick();
    assert.match(textOf(fixture), /New lab/);
    assert.doesNotMatch(textOf(fixture), /Cached lab|Refreshing/);
    assert.equal(find(fixture.host, (node) => node.className === "apstudy-canvas-search__input"), input);
    assert.equal(fixture.document.activeElement, input);
    fixture.controller.destroy();
});

test("fresh cache avoids repeated network refresh on reopen and explicit Refresh remains available", async () => {
    let refreshes = 0;
    const fixture = mounted({ refresh: async () => { refreshes++; return { ok: true }; } });
    fixture.index.read = async () => ({ fresh: true });
    fixture.controller.show(); await tick();
    fixture.controller.close(); fixture.controller.show(); await tick();
    assert.equal(refreshes, 0);
    const button = find(fixture.host, (node) => node.dataset.canvasSearchAction === "refresh");
    root(fixture.host).dispatchEvent({ type: "click", target: button }); await tick();
    assert.equal(refreshes, 1);
    fixture.controller.destroy();
});

test("an older query cannot render after the user changes text during debounce", async () => {
    let finishOld;
    const fixture = mounted({ query: ({ query }) => query === "old" ? new Promise((resolve) => { finishOld = resolve; }) : Promise.resolve({ items: [] }) });
    fixture.controller.show(); await tick();
    typeQuery(fixture, "old"); await tick();
    typeQuery(fixture, "new");
    finishOld({ items: [result("Old result", "/courses/7/assignments/8")] });
    await Promise.resolve(); await Promise.resolve();
    assert.doesNotMatch(textOf(fixture), /Old result/);
    await tick(); fixture.controller.destroy();
});

test("refresh failure keeps cached matches usable and footer Enter does not open a result", async () => {
    let fail;
    const fixture = mounted({ refresh: () => new Promise((resolve) => { fail = resolve; }) });
    fixture.controller.show(); typeQuery(fixture, "lab"); await tick(); await tick();
    fail({ ok: false, code: "CANVAS_SEARCH_TIMEOUT" }); await tick();
    assert.match(textOf(fixture), /Lab report/); assert.match(textOf(fixture), /took too long/);
    const alert = find(fixture.host, (node) => node.attributes.role === "alert");
    assert.match(alert.textContent, /took too long/);
    const close = find(fixture.host, (node) => node.dataset.canvasSearchAction === "close");
    root(fixture.host).dispatchEvent({ type: "keydown", target: close, key: "Enter" });
    assert.equal(fixture.intents.length, 0);
    fixture.controller.destroy();
});

test("rendered group order matches arrow order and real index metadata appears beside SVG icons", async () => {
    const fixture = mounted({ query: async () => ({ items: [
        { type: "file", title: "Reading", href: "/courses/7/files/9", courseName: "Biology", moduleLabel: "Week one" },
        { type: "assignment", title: "Lab", href: "/courses/7/assignments/8", courseName: "Biology" }
    ] }) });
    fixture.controller.show(); await tick(); typeQuery(fixture, "biology"); await tick(); await tick();
    const buttons = walk(root(fixture.host)).filter((node) => node.dataset.canvasSearchResult !== undefined);
    assert.deepEqual(buttons.map((node) => node.dataset.canvasSearchResult), ["0", "1"]);
    assert.match(textOf(fixture), /Biology · Week one/);
    assert.equal(buttons[0].children[0].namespaceURI, "http://www.w3.org/2000/svg");
    root(fixture.host).dispatchEvent({ type: "keydown", key: "ArrowDown" });
    root(fixture.host).dispatchEvent({ type: "keydown", key: "Enter" });
    assert.equal(fixture.intents[0].href, "/courses/7/files/9");
});
