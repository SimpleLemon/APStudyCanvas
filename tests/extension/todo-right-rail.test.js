"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const railApi = require("../../js/content/todo-right-rail.js");
const effectsApi = require("../../js/content/todo-effects.js");
const time = require("../../js/content/todo-time.js");
const planner = require("../../js/content/planner-tasks.js");
const plannerPageTransport = require("../../js/content/planner-page-transport.js");
const plannerPageBridge = require("../../js/platform/planner-page-bridge.js");

class FakeElement {
    constructor(documentRef, tagName) {
        this.ownerDocument = documentRef;
        this.nodeName = String(tagName).toUpperCase();
        this.parentNode = null;
        this.childNodes = [];
        this.attributes = new Map();
        this.listeners = new Map();
        this.style = {
            setProperty(key, value) { this[key] = value; },
            getPropertyValue(key) { return Object.prototype.hasOwnProperty.call(this, key) ? this[key] : ""; },
            removeProperty(key) { delete this[key]; }
        };
        this.value = "";
        this.disabled = false;
        this.selected = false;
        this._text = "";
        this._className = "";
    }

    get children() { return this.childNodes.filter((node) => node instanceof FakeElement); }
    get firstChild() { return this.childNodes[0] || null; }
    get firstElementChild() { return this.children[0] || null; }
    get isConnected() { return this === this.ownerDocument.body || Boolean(this.parentNode?.isConnected); }
    get className() { return this._className; }
    set className(value) { this._className = String(value || ""); this.attributes.set("class", this._className); }
    get id() { return this.attributes.get("id") || ""; }
    set id(value) { this.setAttribute("id", value); }
    get textContent() { return this._text || this.childNodes.map((node) => node.textContent || "").join(""); }
    set textContent(value) { this._text = String(value ?? ""); this.replaceChildren(); }

    append(...nodes) { nodes.forEach((node) => this.appendChild(node)); }
    appendChild(node) {
        if (!node) return node;
        node.parentNode?.removeChild?.(node);
        node.parentNode = this;
        this.childNodes.push(node);
        return node;
    }
    insertBefore(node, reference) {
        if (!node) return node;
        node.parentNode?.removeChild?.(node);
        const index = this.childNodes.indexOf(reference);
        node.parentNode = this;
        if (index < 0) this.childNodes.push(node);
        else this.childNodes.splice(index, 0, node);
        return node;
    }
    removeChild(node) {
        const index = this.childNodes.indexOf(node);
        if (index >= 0) this.childNodes.splice(index, 1);
        if (node) node.parentNode = null;
        return node;
    }
    replaceChildren(...nodes) {
        this.childNodes.forEach((node) => { node.parentNode = null; });
        this.childNodes = [];
        nodes.forEach((node) => this.appendChild(node));
    }
    remove() { this.parentNode?.removeChild?.(this); }

    setAttribute(name, value) {
        const key = String(name);
        const stringValue = String(value);
        this.attributes.set(key, stringValue);
        if (key === "class") this._className = stringValue;
        if (key === "id") this.attributes.set("id", stringValue);
        if (key === "value") this.value = stringValue;
    }
    getAttribute(name) { return this.attributes.get(String(name)) ?? null; }
    removeAttribute(name) { this.attributes.delete(String(name)); }

    addEventListener(type, handler) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push(handler);
    }
    removeEventListener(type, handler) {
        this.listeners.set(type, (this.listeners.get(type) || []).filter((entry) => entry !== handler));
    }
    dispatch(type, properties = {}) {
        const event = {
            type,
            target: this,
            currentTarget: this,
            key: properties.key,
            shiftKey: Boolean(properties.shiftKey),
            preventDefault() { this.defaultPrevented = true; },
            stopPropagation() { this.propagationStopped = true; },
            ...properties
        };
        (this.listeners.get(type) || []).slice().forEach((handler) => handler(event));
        return event;
    }
    focus() { this.ownerDocument.activeElement = this; }
    contains(node) { return node === this || this.childNodes.some((child) => child.contains?.(node)); }

    matches(selector) {
        const simple = selector.trim().replace(/:not\([^)]*\)/g, "");
        if (!simple) return true;
        const tag = simple.match(/^[a-zA-Z][\w-]*/)?.[0];
        if (tag && this.nodeName.toLowerCase() !== tag.toLowerCase()) return false;
        const id = simple.match(/#([\w:-]+)/)?.[1];
        if (id && this.id !== id) return false;
        const classes = Array.from(simple.matchAll(/\.([\w-]+)/g), (match) => match[1]);
        if (classes.some((name) => !this.className.split(/\s+/).includes(name))) return false;
        const attrs = Array.from(simple.matchAll(/\[([^\]=]+)(?:=['"]?([^\]'"]+)['"]?)?\]/g));
        return attrs.every(([, name, expected]) => this.getAttribute(name) !== null && (expected === undefined || this.getAttribute(name) === expected));
    }
    querySelectorAll(selector) {
        const selectors = String(selector).split(",").map((item) => item.trim()).filter(Boolean);
        const result = [];
        const visit = (node) => {
            node.childNodes.forEach((child) => {
                if (!(child instanceof FakeElement)) return;
                if (selectors.some((candidate) => child.matchesDeep(candidate))) result.push(child);
                visit(child);
            });
        };
        visit(this);
        return result;
    }
    matchesDeep(selector) {
        const parts = selector.split(/\s+/);
        if (parts.length < 2) return this.matches(selector);
        if (!this.matches(parts[parts.length - 1])) return false;
        let node = this.parentNode;
        let index = parts.length - 2;
        while (node && index >= 0) {
            if (node instanceof FakeElement && node.matches(parts[index])) index -= 1;
            node = node.parentNode;
        }
        return index < 0;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

class FakeDocument {
    constructor() {
        this.listeners = new Map();
        this.activeElement = null;
        this.body = new FakeElement(this, "body");
    }
    createElement(tagName) { return new FakeElement(this, tagName); }
    createElementNS(_ns, tagName) { return new FakeElement(this, tagName); }
    addEventListener(type, handler) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push(handler);
    }
    removeEventListener(type, handler) { this.listeners.set(type, (this.listeners.get(type) || []).filter((entry) => entry !== handler)); }
    dispatch(type, properties = {}) { (this.listeners.get(type) || []).slice().forEach((handler) => handler({ type, preventDefault() {}, ...properties })); }
    contains(node) { return this.body.contains(node); }
    querySelector(selector) { return this.body.querySelector(selector); }
    querySelectorAll(selector) { return this.body.querySelectorAll(selector); }
    getElementById(id) { return this.body.querySelector(`#${id}`); }
}

function windowStub(reducedMotion = false, spies = {}) {
    return {
        matchMedia: () => ({ matches: reducedMotion }),
        ...(spies.open ? { open: spies.open } : {}),
        ...(spies.confirm ? { confirm: spies.confirm } : {})
    };
}

function task(id, source, overrides = {}) {
    return {
        id,
        source,
        title: `${source} ${id}`,
        type: source === "nest" ? "nest_task" : "assignment",
        url: `https://canvas.emory.edu/tasks/${id}`,
        course: { id: id === "undated" || id === "personal" ? "nest-course" : "42", label: id === "undated" || id === "personal" ? "Nest study" : "BIO 141", code: id === "undated" || id === "personal" ? "NEST 1" : "BIO 141", color: "#294d91" },
        due: { kind: "date", date: "2026-08-26", timeZone: "UTC" },
        timezone: "UTC",
        points: { earned: null, possible: 10 },
        completion: false,
        submitted: false,
        graded: false,
        missing: false,
        unread: false,
        ...overrides
    };
}

function dataSet() {
    return [
        task("missing", "canvas", { due: { kind: "date", date: "2026-08-20", timeZone: "UTC" }, missing: true }),
        task("overdue", "canvas", { due: { kind: "date", date: "2026-08-24", timeZone: "UTC" } }),
        task("today", "canvas", { due: { kind: "date", date: "2026-08-25", timeZone: "UTC" } }),
        task("in-2-days", "canvas", { due: { kind: "date", date: "2026-08-27", timeZone: "UTC" } }),
        task("in-3-days", "canvas", { due: { kind: "date", date: "2026-08-28", timeZone: "UTC" } }),
        task("completed", "canvas", { due: { kind: "date", date: "2026-08-26", timeZone: "UTC" }, completion: true, graded: true, points: { earned: 13, possible: 13 } }),
        task("undated", "nest", { due: null }),
        task("announcement", "canvas", { type: "announcement", unread: true, title: "Unread notice" }),
        task("read-notice", "canvas", { type: "announcement", unread: false, read: true, title: "Old notice" })
    ];
}

function railText(root, selector) { return root.querySelector(selector)?.textContent || ""; }
function classes(root) { return root.children.map((child) => child.className); }
function tick(ms = 5) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function mountRail(documentRef, host, input = {}, options = {}) {
    const controller = railApi.create({ document: documentRef, window: windowStub(), host, now: Date.parse("2026-08-25T12:00:00Z"), ...options });
    const result = controller.mount({ range: { start: "2026-08-24", end: "2026-08-30", timeZone: "UTC" }, ...input });
    assert.equal(result.ok, true);
    return controller;
}

test("renders the BC-aligned rail order, icon folder tabs, day-level groups, and merged source labels", () => {
    const documentRef = new FakeDocument();
    const host = documentRef.createElement("div");
    const controller = mountRail(documentRef, host, {
        tasks: dataSet(),
        streak: { current: 4 },
        feedback: [{ source: "canvas", title: "Lab report", score: { earned: 8, possible: 10 } }],
        calendar: { state: "connected" },
        settings: { todo_hide_feedback: false }
    });
    const root = controller.getRoot();
    assert.deepEqual(classes(root).slice(0, 8), [
        "apstudy-todo-streak",
        "apstudy-todo-header",
        "apstudy-todo-timeframe",
        "apstudy-todo-progress is-circle",
        "apstudy-todo-tabs",
        "apstudy-todo-panel",
        "apstudy-todo-add",
        "apstudy-todo-feedback"
    ]);
    assert.match(root.textContent, /Canvas/);
    const sources = Array.from(root.querySelectorAll(".apstudy-todo-task")).map((row) => row.getAttribute("data-source"));
    assert.ok(sources.includes("Canvas"), "Canvas rows keep their merged data-source");
    assert.ok(sources.includes("Nest"), "Nest rows keep their merged data-source");

    // Gap 1: icon folder-tab strip, Assigned default, unread badge on Announcements.
    assert.deepEqual(railApi.TAB_ORDER, ["announcements", "assigned", "done"]);
    const tabs = root.querySelectorAll("[role='tab']");
    assert.equal(tabs.length, 3);
    assert.equal(root.querySelector("[role='tablist']").getAttribute("aria-label"), "To-Do views");
    assert.equal(root.querySelector("#apstudy-todo-tab-assigned").getAttribute("aria-selected"), "true");
    assert.equal(root.querySelector("#apstudy-todo-tab-announcements").getAttribute("aria-selected"), "false");
    assert.equal(root.querySelector("#apstudy-todo-tab-announcements").getAttribute("aria-label"), "Announcements, 1 unread");
    assert.equal(root.querySelector("#apstudy-todo-tab-announcements .apstudy-todo-tab-badge").textContent, "1");
    ["is-announcements", "is-assigned", "is-done"].forEach((name) => assert.ok(root.querySelector(`.apstudy-todo-tab.${name} svg`), `icon for ${name}`));
    // Icon-only tabs name themselves twice: data-tip drives the hover/focus
    // tooltip, the aria-label carries the accessible name (no native title).
    assert.equal(root.querySelector("#apstudy-todo-tab-assigned").getAttribute("data-tip"), "Assigned");
    assert.equal(root.querySelector("#apstudy-todo-tab-assigned").getAttribute("title"), null);
    assert.equal(root.querySelector("#apstudy-todo-tab-assigned .apstudy-todo-tab-label"), null);
    assert.equal(root.querySelector("[role='tabpanel']").getAttribute("aria-labelledby"), "apstudy-todo-tab-assigned");

    // Gap 2: BC day-level groups; Missing leads, undated Nest stays last.
    ["missing", "overdue", "today", "in-2-days", "in-3-days", "undated"].forEach((group) => {
        assert.ok(root.querySelector(`[data-group='${group}']`), `missing ${group} group`);
    });
    assert.equal(root.querySelector("[data-group='missing'] .apstudy-todo-group-label").textContent, "Missing");
    assert.equal(root.querySelector("[data-group='today'] .apstudy-todo-group-label").textContent, "Due today");
    assert.equal(root.querySelector("[data-group='in-2-days'] .apstudy-todo-group-label").textContent, "Due in 2 days");
    const groupChildren = root.querySelectorAll(".apstudy-todo-group").map((node) => node.getAttribute("data-group"));
    assert.equal(groupChildren.at(-1), "undated", "undated Nest group stays last");
    assert.equal(root.querySelector("[data-group='missing'] .apstudy-todo-group-heading").getAttribute("aria-expanded"), "true");
    assert.ok(root.querySelector("[data-group='missing'] .apstudy-todo-group-chevron"));

    // Gap 7: progress readout + empty-window copy.
    // Announcements are a tabbed communication stream, not academic work.
    assert.equal(root.querySelector(".apstudy-todo-progress-percent").textContent, "20%");
    assert.equal(root.querySelector(".apstudy-todo-progress-fraction").textContent, "1/5");
    assert.match(root.textContent, /Recent Feedback/);

    for (const style of railApi.PROGRESS_STYLES) {
        controller.update({ settings: { todo_progress_style: style } });
        const graphic = root.querySelector(`[data-progress-style='${style}']`);
        assert.ok(graphic, `progress style ${style}`);
        if (style === "oiia") assert.equal(graphic.getAttribute("data-oiia-original"), "true");
    }
    assert.doesNotMatch(fs.readFileSync(path.join(__dirname, "../../js/content/todo-right-rail.js"), "utf8"), /<img|data:image|url\(https?:/i);

    // An empty window is a calm explicit state, not an unexplained 0/0 success.
    controller.update({ tasks: [], settings: { todo_progress_style: "circle" } });
    assert.equal(railText(root, ".apstudy-todo-progress-percent"), "No dated tasks in this timeframe");
    assert.equal(root.querySelector(".apstudy-todo-progress-graphic"), null);
});

test("rail layout controls set reversible attributes on the extension-owned root", () => {
    const documentRef = new FakeDocument();
    const host = documentRef.createElement("div");
    const controller = mountRail(documentRef, host, {
        settings: { todo_separate_scrollbar: true, todo_full_height: true }
    });
    const root = controller.getRoot();
    assert.equal(root.getAttribute("data-separate-scrollbar"), "true");
    assert.equal(root.getAttribute("data-full-height"), "true");

    const update = controller.update({ settings: { todo_separate_scrollbar: false, todo_full_height: false } });
    assert.equal(update.rendered, true, "a layout setting change updates the owned root immediately");
    assert.equal(root.getAttribute("data-separate-scrollbar"), "false");
    assert.equal(root.getAttribute("data-full-height"), "false");
});

test("scroll ownership is attribute+CSS owned: stale inline height/overflow never survives a render", () => {
    const documentRef = new FakeDocument();
    const host = documentRef.createElement("div");
    const stale = {
        height: "677px",
        "overflow-y": "auto",
        overflow: "auto",
        "max-height": "677px",
        "min-height": "100vh",
        "overscroll-behavior": "contain",
        "scrollbar-gutter": "stable"
    };
    const controller = railApi.create({ document: documentRef, window: windowStub(), host, now: Date.parse("2026-08-25T12:00:00Z") });
    const mounted = controller.mount({ host, settings: { todo_separate_scrollbar: true, todo_full_height: true } });
    assert.equal(mounted.ok, true);
    const root = controller.getRoot();

    // Opt-in dedicated scroll owner: the attribute still identifies it, and
    // the reconcile strips stale inline sizing so CSS (never inline values)
    // owns the scrollport.
    Object.entries(stale).forEach(([property, value]) => root.style.setProperty(property, value));
    const optIn = controller.update({ settings: { todo_full_height: false } });
    assert.equal(optIn.rendered, true, "a layout setting change updates the owned root immediately");
    ["height", "overflow-y", "overflow", "max-height", "min-height", "overscroll-behavior", "scrollbar-gutter"].forEach((property) => {
        assert.equal(root.style.getPropertyValue(property), "", `no stale inline ${property} survives a render`);
    });
    assert.equal(root.getAttribute("data-separate-scrollbar"), "true");

    // Default flow ownership: the same strip keeps the rail moving with the
    // Canvas document instead of double-scrolling against stale inline values.
    Object.entries(stale).forEach(([property, value]) => root.style.setProperty(property, value));
    const flow = controller.update({ settings: { todo_separate_scrollbar: false } });
    assert.equal(flow.rendered, true);
    ["height", "overflow-y", "overflow", "max-height", "min-height", "overscroll-behavior", "scrollbar-gutter"].forEach((property) => {
        assert.equal(root.style.getPropertyValue(property), "", `flow mode strips inline ${property}`);
    });
    assert.equal(root.getAttribute("data-separate-scrollbar"), "false");
});

test("the separate-scroll contract scopes stickiness to the wrapper and keeps overflow on the rail", () => {
    const css = fs.readFileSync(path.join(__dirname, "../../css/todo-right-rail.css"), "utf8");
    const base = css.match(/\.apstudy-todo-right-rail\s*\{([\s\S]*?)\n\}/);
    assert.ok(base);
    assert.doesNotMatch(base[1], /position:\s*sticky|inset-block-start|block-size:\s*var\(--todo-separate-scrollport-size\)|max-block-size|overflow-y:\s*auto/, "the default rail remains unbounded and non-sticky");
    assert.match(base[1], /--todo-viewport-gutter:\s*24px;/, "the rail names Canvas's top viewport offset");
    const separate = css.match(/\.apstudy-todo-right-rail\[data-separate-scrollbar="true"\]\s*\{([\s\S]*?)\n\}/);
    assert.ok(separate);
    assert.match(separate[1], /block-size:\s*var\(--todo-separate-scrollport-size\);/, "separate-scrollbar mode owns the viewport-sized rail");
    assert.match(separate[1], /max-block-size:\s*100%;/, "the rail cannot exceed its sticky wrapper");
    assert.match(separate[1], /min-block-size:\s*0;/, "separate-scrollbar mode overrides full-height minimum sizing");
    assert.match(separate[1], /overflow-y:\s*auto;/, "separate-scrollbar mode retains its independent vertical scrollport");

    const wrapper = css.match(/#right-side-wrapper:has\(\.apstudy-todo-right-rail\[data-separate-scrollbar="true"\]\)\s*\{([\s\S]*?)\n\}/);
    assert.ok(wrapper, "the sticky frame requires an APStudy rail in separate-scrollbar mode");
    assert.match(wrapper[1], /position:\s*sticky;/, "separate-scrollbar mode makes only the containing wrapper sticky");
    assert.match(wrapper[1], /inset-block-start:\s*0;/, "the wrapper pins to the viewport start");
    assert.match(wrapper[1], /align-self:\s*flex-start;/, "the wrapper keeps its intrinsic grid alignment");
    assert.match(wrapper[1], /block-size:\s*var\(--todo-separate-scrollport-size\);/, "the wrapper and rail share one viewport budget");
    assert.match(wrapper[1], /min-block-size:\s*0;/, "the wrapper cannot force a taller rail through full-height content");
    assert.match(wrapper[1], /overflow:\s*visible\s*!important;/, "the wrapper is not a nested scrollport");
    assert.doesNotMatch(wrapper[1], /overflow(?:-[xy])?:\s*auto/, "wrapper overflow remains disabled");
});

test("group headers collapse with a count badge and divider, persisting per tab and group key", () => {
    const documentRef = new FakeDocument();
    const host = documentRef.createElement("div");
    const controller = mountRail(documentRef, host, { tasks: dataSet() });
    const root = controller.getRoot();
    const heading = root.querySelector("[data-group='missing'] .apstudy-todo-group-heading");
    heading.dispatch("click");
    const collapsedSection = root.querySelector("[data-group='missing']");
    assert.ok(collapsedSection.className.includes("is-collapsed"));
    assert.equal(collapsedSection.querySelector(".apstudy-todo-group-heading").getAttribute("aria-expanded"), "false");
    assert.equal(collapsedSection.querySelector(".apstudy-todo-group-count").textContent, "1");
    assert.equal(collapsedSection.querySelector(".apstudy-todo-task-list"), null, "collapsed groups render no rows");
    assert.ok(controller.getState().collapsedGroups.includes("assigned:missing"));

    // Collapse state survives re-renders and tab switches (per tab+group key).
    controller.update({});
    assert.ok(controller.getRoot().querySelector("[data-group='missing']").className.includes("is-collapsed"));
    controller.getRoot().querySelector("#apstudy-todo-tab-done").dispatch("click");
    assert.ok(controller.getRoot().querySelector("[data-group='completed'] .apstudy-todo-task-list"), "done tab unaffected");
    controller.getRoot().querySelector("#apstudy-todo-tab-assigned").dispatch("click");
    assert.ok(controller.getRoot().querySelector("[data-group='missing']").className.includes("is-collapsed"));

    // Announcements remain an accessible two-group stream: Unread, then Recent.
    controller.getRoot().querySelector("#apstudy-todo-tab-announcements").dispatch("click");
    const announcementsRoot = controller.getRoot();
    assert.equal(announcementsRoot.querySelector("[data-group='unread'] .apstudy-todo-group-heading").getAttribute("aria-expanded"), "true");
    assert.equal(announcementsRoot.querySelector("[data-group='recent'] .apstudy-todo-group-heading").getAttribute("aria-expanded"), "false");
    assert.ok(announcementsRoot.querySelector("[data-group='recent'] .apstudy-todo-group-count"));
    assert.match(announcementsRoot.textContent, /Unread notice/);
});

test("announcement groups list newest first: the most recent post leads Recent", () => {
    const documentRef = new FakeDocument();
    const datedNotice = (id, date, title) => task(id, "canvas", { type: "announcement", unread: false, read: true, title, due: { kind: "date", date, timeZone: "UTC" } });
    const controller = mountRail(documentRef, documentRef.createElement("div"), {
        tasks: [
            datedNotice("oldest", "2026-08-24", "Oldest notice"),
            datedNotice("newest", "2026-08-28", "Newest notice"),
            datedNotice("middle", "2026-08-26", "Middle notice"),
            task("unread-notice", "canvas", { type: "announcement", unread: true, title: "Unread notice", due: { kind: "date", date: "2026-08-23", timeZone: "UTC" } })
        ]
    });
    const root = controller.getRoot();
    root.querySelector("#apstudy-todo-tab-announcements").dispatch("click");
    root.querySelector("[data-group='recent'] .apstudy-todo-group-heading").dispatch("click");
    const recentRoot = controller.getRoot();
    const recentOrder = recentRoot.querySelectorAll("[data-group='recent'] .apstudy-todo-task-title").map((node) => node.textContent);
    assert.deepEqual(recentOrder, ["Newest notice", "Middle notice", "Oldest notice"], "Recent lists newest at the top, oldest at the bottom");
    const unreadOrder = recentRoot.querySelectorAll("[data-group='unread'] .apstudy-todo-task-title").map((node) => node.textContent);
    assert.deepEqual(unreadOrder, ["Unread notice"]);
});

test("announcement completeness is honest and Done includes submitted work awaiting a grade", () => {
    const documentRef = new FakeDocument();
    const controller = mountRail(documentRef, documentRef.createElement("div"), {
        tasks: [
            task("notice", "canvas", { type: "announcement", unread: true }),
            task("submitted", "canvas", { submitted: true, graded: false, completion: false })
        ],
        sourceState: { announcements: { partial: true, truncated: true } }
    });
    let root = controller.getRoot();
    root.querySelector("#apstudy-todo-tab-announcements").dispatch("click");
    assert.match(railText(root, ".apstudy-todo-announcement-notice"), /partial, truncated/);
    root.querySelector("#apstudy-todo-tab-done").dispatch("click");
    root = controller.getRoot();
    const row = root.querySelector("[data-task-id='submitted']");
    assert.equal(row.getAttribute("data-status"), "submitted-ungraded");
    assert.equal(row.querySelector(".apstudy-todo-task-status").textContent, "Submitted · awaiting grade");
});

test("tab keyboard support exceeds BC: roving tabindex plus arrow, Home, and End navigation", () => {
    const documentRef = new FakeDocument();
    const host = documentRef.createElement("div");
    const controller = mountRail(documentRef, host, { tasks: dataSet() });
    const root = controller.getRoot();
    const announcements = root.querySelector("#apstudy-todo-tab-announcements");
    assert.equal(announcements.tabIndex, -1);
    announcements.dispatch("keydown", { key: "ArrowRight" });
    assert.equal(documentRef.activeElement.id, "apstudy-todo-tab-assigned");
    assert.equal(root.querySelector("#apstudy-todo-tab-assigned").getAttribute("aria-selected"), "true");
    assert.equal(root.querySelector("#apstudy-todo-tab-assigned").tabIndex, 0);
    root.querySelector("#apstudy-todo-tab-assigned").dispatch("keydown", { key: "End" });
    assert.equal(documentRef.activeElement.id, "apstudy-todo-tab-done");
    root.querySelector("#apstudy-todo-tab-done").dispatch("keydown", { key: "Home" });
    assert.equal(documentRef.activeElement.id, "apstudy-todo-tab-announcements");
});

test("task rows match the BC anatomy: spine, colored code chip, two actions, BC points, and row click", () => {
    const documentRef = new FakeDocument();
    const host = documentRef.createElement("div");
    const opened = [];
    const controller = mountRail(documentRef, host, { tasks: dataSet() }, {});
    const root = controller.getRoot();

    const row = root.querySelector(".apstudy-todo-task");
    assert.equal(row.getAttribute("data-source"), "Canvas");
    assert.ok(row.querySelector(".apstudy-todo-task-spine"), "course-color spine");
    const code = row.querySelector(".apstudy-todo-task-course");
    assert.equal(code.textContent, "BIO 141");
    assert.ok(code.style.color, "course code takes the course color");
    assert.ok(!row.querySelector(".apstudy-todo-task-source"), "no source chip: the course label identifies the row");
    const title = row.querySelector(".apstudy-todo-task-title");
    assert.equal(title.getAttribute("data-action"), "open-task");
    assert.ok(row.querySelector(".apstudy-todo-task-complete svg circle"), "circle checkbox");
    assert.equal(row.querySelector(".apstudy-todo-task-complete").getAttribute("aria-pressed"), "false");
    assert.ok(row.querySelector(".apstudy-todo-task-details"), "Details affordance for touch");
    assert.equal(row.querySelectorAll(".apstudy-todo-task-actions button").length, 2, "each tab's rows keep completion and details actions");
    assert.match(row.querySelector(".apstudy-todo-task-due").textContent, /^Due 08\/\d\d/);
    assert.equal(row.querySelector(".apstudy-todo-task-points").textContent, "10pts");
    assert.ok(row.querySelector(".apstudy-todo-task-meta.is-urgent-due"), "missing rows highlight the due label");

    // BC points formats: 13/13pts and -/2.5pts.
    controller.update({ selectedTab: "done" });
    const doneRow = root.querySelector(".apstudy-todo-task");
    assert.equal(doneRow.getAttribute("data-status"), "completed");
    assert.ok(doneRow.className.includes("is-complete"));
    assert.equal(doneRow.querySelector(".apstudy-todo-task-complete").getAttribute("aria-pressed"), "true");
    assert.equal(doneRow.querySelector(".apstudy-todo-task-points").textContent, "13/13pts");
    assert.equal(doneRow.querySelector(".apstudy-todo-task-complete").getAttribute("title"), "Marked as complete by Canvas");

    const partial = railApi.pointsText({ earned: null, possible: 2.5 }, true);
    assert.equal(partial, "-/2.5pts");
    assert.equal(railApi.pointsText({ earned: null, possible: 15 }), "15pts", "active rows show the possible value alone");

    // Row click opens the item; interactive children do not double-open.
    const rowWindow = windowStub(false, { open: (url) => opened.push(url) });
    const clickController = railApi.create({ document: documentRef, window: rowWindow, host: documentRef.createElement("div"), now: Date.parse("2026-08-25T12:00:00Z") });
    clickController.mount({ tasks: [task("clickable", "canvas")], range: { start: "2026-08-24", end: "2026-08-30", timeZone: "UTC" } });
    const clickRow = clickController.getRoot().querySelector(".apstudy-todo-task");
    clickRow.dispatch("click");
    assert.deepEqual(opened, ["https://canvas.emory.edu/tasks/clickable"]);
    clickRow.querySelector(".apstudy-todo-task-complete").dispatch("click");
    assert.equal(opened.length, 1, "checkbox clicks do not open the item");
    clickRow.querySelector(".apstudy-todo-task-details").dispatch("click");
    assert.equal(opened.length, 1, "details clicks do not open the item");
});

test("icon and color preferences retain semantic course text while removing only decorative UI", () => {
    const documentRef = new FakeDocument();
    const host = documentRef.createElement("div");
    const controller = mountRail(documentRef, host, {
        tasks: [task("plain", "canvas", { title: "A very long assignment title", course: { id: "42", code: "BIO 141", label: "Biology", color: "#294d91" } })],
        settings: { todo_icons_visible: false, todo_course_color_mode: "neutral" }
    }, {});
    const root = controller.getRoot();
    const row = root.querySelector(".apstudy-todo-task");
    assert.equal(root.querySelector(".apstudy-todo-task-type"), null);
    assert.equal(row.querySelector(".apstudy-todo-task-course").textContent, "BIO 141");
    assert.equal(row.style["--course-color"], "var(--todo-muted)");
});

test("hover and keyboard focus open an in-rail preview, Details toggles it, and Escape returns focus", async () => {
    const documentRef = new FakeDocument();
    const host = documentRef.createElement("div");
    const described = task("described", "canvas", { raw: { description: "<p>Read <b>chapter 3</b></p> before class" } });
    const controller = mountRail(documentRef, host, { tasks: [described, task("blank", "canvas"), task("graded", "canvas", { completion: true, graded: true, points: { earned: 13, possible: 13 } })] }, { hoverPreviewDelayMs: 0 });
    const root = controller.getRoot();

    const row = root.querySelector("[data-task-id='described']");
    row.dispatch("mouseenter");
    await tick();
    let preview = root.querySelector(".apstudy-todo-preview");
    assert.ok(preview, "hover opens the preview");
    assert.equal(preview.parentNode, row, "preview remains in the task row instead of escaping the rail");
    assert.equal(preview.querySelector(".apstudy-todo-preview-title").textContent, "canvas described");
    assert.equal(preview.querySelector(".apstudy-todo-preview-eyebrow").textContent, "Instructions");
    assert.match(preview.querySelector(".apstudy-todo-preview-body").textContent, /Read chapter 3\s*before class/);
    const hoverDetails = row.querySelector(".apstudy-todo-task-details");
    assert.equal(hoverDetails.getAttribute("aria-expanded"), "true");
    assert.equal(hoverDetails.getAttribute("aria-controls"), preview.id, "Details names its stable preview region");

    row.dispatch("mouseleave");
    await tick();
    assert.ok(root.querySelector(".apstudy-todo-preview"), "leaving the row never dismisses an open preview");
    documentRef.dispatch("keydown", { key: "Escape" });
    assert.equal(root.querySelector(".apstudy-todo-preview"), null, "Escape dismisses");

    // Details button: an explicit, non-hover-only path.
    const details = root.querySelector("[data-task-id='described'] .apstudy-todo-task-details");
    details.dispatch("click");
    assert.ok(root.querySelector(".apstudy-todo-preview"));
    assert.equal(root.querySelector(".apstudy-todo-preview").id, details.getAttribute("aria-controls"), "the relationship survives an explicit open and rerender");
    details.focus();
    documentRef.dispatch("keydown", { key: "Escape" });
    assert.equal(documentRef.activeElement, details, "Escape restores the Details trigger");
    details.dispatch("click");
    assert.ok(root.querySelector(".apstudy-todo-preview"));
    details.dispatch("click");
    assert.equal(root.querySelector(".apstudy-todo-preview"), null);

    // Keyboard focus opens it too.
    row.dispatch("focusin");
    await tick();
    assert.ok(root.querySelector(".apstudy-todo-preview"));
    documentRef.dispatch("keydown", { key: "Escape" });
    assert.equal(root.querySelector(".apstudy-todo-preview"), null, "Escape dismisses");

    // Fallback copy and completed feedback variant (completed rows live on Done).
    root.querySelector("[data-task-id='blank']").dispatch("mouseenter");
    await tick();
    assert.match(root.querySelector(".apstudy-todo-preview").textContent, /No preview available for this item/);
    documentRef.dispatch("keydown", { key: "Escape" });
    root.querySelector("#apstudy-todo-tab-done").dispatch("click");
    root.querySelector("[data-task-id='graded']").dispatch("mouseenter");
    await tick();
    const completedPreview = root.querySelector(".apstudy-todo-preview").textContent;
    assert.match(completedPreview, /Recent feedback/);
    assert.match(completedPreview, /Scored 13 out of 13 points/);

    // The setting keeps the layer off entirely.
    const disabledDocument = new FakeDocument();
    const disabled = mountRail(disabledDocument, disabledDocument.createElement("div"), { tasks: [described], settings: { todo_hover_preview: false } }, { hoverPreviewDelayMs: 0 });
    disabled.getRoot().querySelector(".apstudy-todo-task").dispatch("mouseenter");
    await tick();
    assert.equal(disabled.getRoot().querySelector(".apstudy-todo-preview"), null);
});

test("announcement rows drop the details button, toggle the preview from the row, and post the time without a due label", async () => {
    const documentRef = new FakeDocument();
    const host = documentRef.createElement("div");
    const notice = task("notice", "canvas", {
        type: "announcement",
        unread: true,
        url: "https://canvas.emory.edu/courses/42/discussion_topics/9",
        raw: { message: "<p>Welcome to the course!</p>" }
    });
    const controller = mountRail(documentRef, host, { tasks: [notice] }, { hoverPreviewDelayMs: 0 });
    const root = controller.getRoot();
    root.querySelector("#apstudy-todo-tab-announcements").dispatch("click");
    const row = root.querySelector(".apstudy-todo-task");
    assert.equal(row.querySelector(".apstudy-todo-task-details"), null, "announcement rows carry no details button");
    const title = row.querySelector(".apstudy-todo-task-title");
    assert.equal(title.getAttribute("data-action"), "open-task");
    assert.equal(title.target, "_blank");
    assert.equal(title.rel, "noopener");

    row.dispatch("click");
    let preview = root.querySelector(".apstudy-todo-preview");
    assert.ok(preview, "clicking the row opens the preview");
    assert.match(preview.textContent, /Welcome to the course!/);
    row.dispatch("click");
    assert.equal(root.querySelector(".apstudy-todo-preview"), null, "clicking again closes the preview");

    row.dispatch("click");
    assert.ok(root.querySelector(".apstudy-todo-preview"));
    title.dispatch("click");
    assert.ok(root.querySelector(".apstudy-todo-preview"), "the title link never toggles the preview: it only navigates");
    documentRef.dispatch("keydown", { key: "Escape" });
    assert.equal(root.querySelector(".apstudy-todo-preview"), null);

    // The posted time replaces the "Due" prefix on announcement rows.
    const due = row.querySelector(".apstudy-todo-task-due");
    assert.match(due.textContent, /^08\/26/);
    assert.equal(due.querySelector("strong"), null, "no Due label on announcements");
});

test("previews without a local body load Canvas content on demand, cache it, and fall back honestly", async () => {
    const documentRef = new FakeDocument();
    const host = documentRef.createElement("div");
    const blank = task("blank", "canvas");
    const broken = task("broken", "canvas", { course: { id: "43", label: "CHEM 201", code: "CHEM 201", color: "#b5484d" } });
    let calls = 0;
    const controller = mountRail(documentRef, host, { tasks: [blank, broken] }, {
        hoverPreviewDelayMs: 0,
        describeTask: async (candidate) => {
            calls += 1;
            if (candidate.id === "broken") throw new Error("Canvas request failed: 500");
            return "<p>Fetched <b>body</b></p>";
        }
    });
    const root = controller.getRoot();
    const row = root.querySelector("[data-task-id='blank']");
    row.dispatch("mouseenter");
    await tick();
    assert.match(root.querySelector(".apstudy-todo-preview").textContent, /Fetched body/);
    row.dispatch("mouseleave");
    await tick();
    assert.ok(root.querySelector(".apstudy-todo-preview"), "leaving the row keeps the preview open");
    row.dispatch("mouseenter");
    await tick();
    assert.match(root.querySelector(".apstudy-todo-preview").textContent, /Fetched body/, "the fetched body survives a reopen from cache");
    assert.equal(calls, 1, "no refetch for a cached preview");
    documentRef.dispatch("keydown", { key: "Escape" });

    const brokenRow = root.querySelector("[data-task-id='broken']");
    brokenRow.dispatch("mouseenter");
    await tick();
    const failedPreview = root.querySelector(".apstudy-todo-preview");
    assert.match(failedPreview.textContent, /No preview available for this item/);
    assert.doesNotMatch(failedPreview.textContent, /Loading preview/);
    documentRef.dispatch("keydown", { key: "Escape" });
});

test("a slow preview response that lands after the preview closed never resurrects it", async () => {
    const documentRef = new FakeDocument();
    const host = documentRef.createElement("div");
    let resolveFetch;
    const controller = mountRail(documentRef, host, { tasks: [task("slow", "canvas")] }, {
        hoverPreviewDelayMs: 0,
        describeTask: () => new Promise((resolve) => { resolveFetch = resolve; })
    });
    const root = controller.getRoot();
    root.querySelector(".apstudy-todo-task").dispatch("mouseenter");
    await tick();
    assert.match(root.querySelector(".apstudy-todo-preview").textContent, /Loading preview/);
    root.querySelector(".apstudy-todo-task").dispatch("mouseleave");
    await tick();
    assert.ok(root.querySelector(".apstudy-todo-preview"), "a pending response does not close the preview");
    documentRef.dispatch("keydown", { key: "Escape" });
    assert.equal(root.querySelector(".apstudy-todo-preview"), null);
    resolveFetch("<p>Late body</p>");
    await tick();
    assert.equal(root.querySelector(".apstudy-todo-preview"), null, "stale responses are dropped");
});

test("coordinate preview ids are bounded, source-private, unique, and stable for colliding records", () => {
    const documentRef = new FakeDocument();
    const longSourceIdentifier = "canvas-source-private-identifier-".repeat(64);
    const sourceFields = {
        eventRef: `${longSourceIdentifier}event`,
        remoteId: `${longSourceIdentifier}remote`,
        sourceItemKey: `${longSourceIdentifier}item`
    };
    const first = task("Aa", "canvas", { ...sourceFields, raw: { description: "First collision case" } });
    const second = task("BB", "canvas", { ...sourceFields, raw: { description: "Second collision case" } });
    const duplicate = task("duplicate-id", "canvas", { ...sourceFields, raw: { description: "Duplicate source id" } });
    const controller = mountRail(documentRef, documentRef.createElement("div"), { tasks: [first, second, duplicate] });
    const root = controller.getRoot();
    const rows = root.querySelectorAll(".apstudy-todo-task");
    const details = rows.map((row) => row.querySelector(".apstudy-todo-task-details"));
    const previewIds = details.map((button) => button.getAttribute("aria-controls"));

    assert.equal(rows.length, 3);
    assert.equal(new Set(previewIds).size, 3, "Aa, BB, and duplicate source fields each receive a distinct rendered occurrence");
    previewIds.forEach((id) => {
        assert.match(id, /^apstudy-todo-preview-t\d+-g\d+-i\d+$/, "the id is DOM-safe render coordinates only");
        assert.ok(id.length <= 128, `preview id must stay bounded: ${id.length}`);
        ["Aa", "BB", "duplicate-id", ...Object.values(sourceFields)].forEach((identifier) => assert.ok(!id.includes(identifier), `preview id must not disclose ${identifier}`));
    });

    details.forEach((button, index) => {
        assert.equal(button.getAttribute("aria-expanded"), "false");
        button.dispatch("click");
        const preview = root.querySelector(".apstudy-todo-preview");
        assert.equal(preview.id, previewIds[index], "Details controls exactly its preview region");
        assert.equal(preview.getAttribute("data-preview-for"), null, "preview metadata does not expose the task identifier");
        assert.equal(button.getAttribute("aria-expanded"), "true");
        button.focus();
        documentRef.dispatch("keydown", { key: "Escape" });
        assert.equal(documentRef.activeElement, button, "Escape returns focus to the opening Details button");
        assert.equal(button.getAttribute("aria-expanded"), "false");
    });

    const update = controller.update({ canvasState: "stale" });
    assert.equal(update.rendered, true, "state update forces a rerender");
    const rerenderedRows = root.querySelectorAll(".apstudy-todo-task");
    assert.deepEqual(
        rerenderedRows.map((row) => row.querySelector(".apstudy-todo-task-details").getAttribute("aria-controls")),
        previewIds,
        "equivalent same-order rerenders retain preview ids"
    );
});

test("a first-run streak is a tracking state, not an observed zero-day claim", () => {
    const documentRef = new FakeDocument();
    const controller = mountRail(documentRef, documentRef.createElement("div"), {
        tasks: [],
        streak: { state: "tracking", current: 0, since: "2026-08-25" }
    });
    const card = controller.getRoot().querySelector(".apstudy-todo-streak-summary");
    assert.match(card.textContent, /0 day streak/);
    assert.match(card.textContent, /Tracking starts after your first due date settles\./);
    assert.doesNotMatch(card.textContent, /consecutive completed due dates observed/);
});

test("a rollover verification landing on the same day count still repaints the streak card", () => {
    const documentRef = new FakeDocument();
    const range = { start: "2026-08-24", end: "2026-08-30", timeZone: "UTC" };
    const controller = mountRail(documentRef, documentRef.createElement("div"), {
        tasks: [],
        streak: { state: "stale", current: 4, since: "2026-08-20" },
        range
    });
    assert.match(railText(controller.getRoot(), ".apstudy-todo-streak-summary"), /Last verified Canvas observation/);
    const converged = controller.update({ streak: { state: "stale", current: 4, since: "2026-08-20" }, range });
    assert.equal(converged.rendered, false, "an identical snapshot still converges");
    const verified = controller.update({ streak: { state: "verified", current: 4, since: "2026-08-20" }, range });
    assert.equal(verified.rendered, true, "state-only transitions (stale → verified at the same count) repaint");
    assert.doesNotMatch(railText(controller.getRoot(), ".apstudy-todo-streak-summary"), /Last verified Canvas observation/);
});

test("the loading shell renders an explicit, calm streak placeholder instead of a false readout", () => {
    const documentRef = new FakeDocument();
    const controller = mountRail(documentRef, documentRef.createElement("div"), {
        tasks: [],
        streak: { state: "loading" },
        canvasState: "loading"
    });
    const card = railText(controller.getRoot(), ".apstudy-todo-streak-summary");
    assert.match(card, /Verifying your recent Canvas work/);
    assert.doesNotMatch(card, /0 day streak/, "loading never claims an observed zero-day streak");
    assert.doesNotMatch(card, /Unavailable/, "loading is not reported as verified unavailability");
});

test("empty, loading, error, and stale states are explicit; the empty progress readout never claims 0/0 success", () => {
    const documentRef = new FakeDocument();
    const host = documentRef.createElement("div");
    const controller = mountRail(documentRef, host, { tasks: [], canvasState: "error", streak: { state: "unavailable" } });
    const root = controller.getRoot();
    assert.match(railText(root, ".apstudy-todo-panel"), /Canvas tasks are unavailable\. Reload Canvas, then try again\./);
    assert.match(railText(root, ".apstudy-todo-progress-summary"), /No dated tasks in this timeframe/);
    assert.doesNotMatch(railText(root, ".apstudy-todo-progress-summary"), /0\/0/);
    controller.update({ tasks: [], canvasState: "stale" });
    assert.match(railText(root, ".apstudy-todo-panel"), /Showing the last Canvas tasks we could verify\./);
    controller.update({ tasks: [], canvasState: "loading" });
    assert.match(railText(root, ".apstudy-todo-panel"), /Loading Canvas tasks/);
});

test("Add Task renders the BC New-item layout, validates, preserves drafts, offers Nest sign-in, and keeps idempotency stable", async () => {
    const documentRef = new FakeDocument();
    const host = documentRef.createElement("div");
    const priorFocus = documentRef.createElement("button");
    host.append(priorFocus);
    const keys = [];
    const payloads = [];
    let connected = 0;
    const nestTask = task("created", "nest", { type: "nest_task", completion: false, due: null });
    const controller = railApi.create({
        document: documentRef,
        window: windowStub(),
        host,
        createNestTask: async (payload, createOptions) => {
            payloads.push(payload);
            keys.push(createOptions.idempotencyKey);
            if (payloads.length === 1) return { ok: false, error: { code: "NEST_SIGNED_OUT", message: "Nest is signed out." } };
            return { ok: true, task: nestTask };
        },
        onConnectNest: () => { connected += 1; },
        now: Date.parse("2026-08-25T12:00:00Z")
    });
    controller.mount({ tasks: [], range: { start: "2026-08-25", end: "2026-08-31", timeZone: "UTC" } });
    const add = controller.getRoot().querySelector(".apstudy-todo-add");
    priorFocus.focus();
    add.dispatch("click");

    // Gap 5: description-first "New item" dialog with a DETAILS section.
    assert.equal(documentRef.activeElement.id, "apstudy-todo-field-description");
    const form = documentRef.body.querySelector(".apstudy-todo-form");
    assert.equal(documentRef.body.querySelector("#apstudy-todo-modal-title").textContent, "New item");
    const fieldOrder = Array.from(form.querySelectorAll("input,textarea,select")).map((node) => node.getAttribute("name") || node.id);
    assert.equal(fieldOrder[0], "description", "description comes first");
    assert.ok(fieldOrder.indexOf("description") < fieldOrder.indexOf("title"));
    assert.ok(documentRef.body.querySelector(".apstudy-todo-form-eyebrow"));
    assert.equal(documentRef.body.querySelector("#apstudy-todo-field-earned").getAttribute("placeholder"), "--");
    assert.equal(documentRef.body.querySelector("#apstudy-todo-field-possible").getAttribute("placeholder"), "--");
    assert.equal(documentRef.body.querySelector(".apstudy-todo-submit").textContent, "+ Add Task");

    form.dispatch("submit");
    assert.ok(documentRef.body.querySelector("#apstudy-todo-error-title"));

    const title = documentRef.body.querySelector("#apstudy-todo-field-title");
    title.value = "A preserved Nest task";
    title.dispatch("input");
    const link = documentRef.body.querySelector("#apstudy-todo-field-link");
    link.value = "http://unsafe.example";
    link.dispatch("input");
    form.dispatch("submit");
    assert.match(documentRef.body.querySelector(".apstudy-todo-modal-status").textContent, /highlighted/);
    assert.ok(documentRef.body.querySelector("#apstudy-todo-error-link"));
    link.value = "https://example.edu/study";
    link.dispatch("input");

    // Default due date is tomorrow at 11:59pm in the rail timezone.
    assert.equal(documentRef.body.querySelector("#apstudy-todo-field-dueDate").value, "2026-08-26");
    assert.equal(documentRef.body.querySelector("#apstudy-todo-field-dueTime").value, "23:59");

    form.dispatch("submit");
    await tick();
    assert.equal(payloads.length, 1);
    assert.match(documentRef.body.querySelector(".apstudy-todo-modal-status").textContent, /signed out/);
    assert.ok(documentRef.body.querySelector(".apstudy-todo-retry-create"));
    assert.match(documentRef.body.querySelector("#apstudy-todo-field-title").value, /preserved/, "the draft survives the failure");
    documentRef.body.querySelector(".apstudy-todo-connect").dispatch("click");
    assert.equal(connected, 1);
    documentRef.body.querySelector(".apstudy-todo-retry-create").dispatch("click");
    await tick();
    assert.equal(payloads.length, 2);
    assert.equal(payloads[1].link, "https://example.edu/study");
    assert.equal(payloads[1].due_at, "2026-08-26T23:59:00", "default due is tomorrow 11:59pm");
    assert.ok(keys[0] && keys[0] === keys[1], "the idempotency key stays stable across retries");
    assert.equal(documentRef.body.querySelector(".apstudy-todo-modal"), null);
    assert.equal(documentRef.activeElement.className, "apstudy-todo-add", "focus returns to the Add Task button");

    // BC's confirm-discard flow: Escape with a dirty draft asks before discarding.
    controller.openAddTask();
    assert.equal(documentRef.activeElement.id, "apstudy-todo-field-description");
    documentRef.body.querySelector("#apstudy-todo-field-title").value = "Draft to discard";
    documentRef.body.querySelector("#apstudy-todo-field-title").dispatch("input");
    documentRef.dispatch("keydown", { key: "Escape" });
    assert.match(documentRef.body.querySelector(".apstudy-todo-modal-status").textContent, /Do you want to discard this task\./);
    assert.ok(documentRef.body.querySelector("[data-action='cancel-discard']"));
    assert.ok(documentRef.body.querySelector("[data-action='confirm-discard']"));
    documentRef.body.querySelector("[data-action='cancel-discard']").dispatch("click");
    assert.ok(documentRef.body.querySelector(".apstudy-todo-form"), "Cancel keeps the draft and the form");
    documentRef.dispatch("keydown", { key: "Escape" });
    documentRef.body.querySelector("[data-action='confirm-discard']").dispatch("click");
    assert.equal(documentRef.body.querySelector(".apstudy-todo-modal"), null);
    controller.openAddTask();
    assert.equal(documentRef.body.querySelector("#apstudy-todo-field-title").value, "", "discarding clears the draft");
    documentRef.dispatch("keydown", { key: "Escape" });
    assert.equal(documentRef.body.querySelector(".apstudy-todo-modal"), null, "a clean draft closes without confirming");
});

test("Canvas planner Add Task click opens its dialog and uses only planner transport", async () => {
    const documentRef = new FakeDocument();
    const host = documentRef.createElement("div");
    const payloads = [];
    let attempts = 0;
    let nestAttempts = 0;
    const controller = railApi.create({
        document: documentRef,
        window: windowStub(),
        host,
        plannerTasksEnabled: () => true,
        plannerTaskOperationId: () => "pt-stableop-1234567",
        plannerCourses: () => [{ id: "42", label: "Visible course" }, { id: "99", label: "Hidden course", hidden: true }],
        createPlannerTask: async (payload) => {
            payloads.push(payload);
            attempts += 1;
            if (attempts === 1) return { ok: false, state: "outcome-uncertain", retryBlocked: true, error: { code: "PLANNER_CREATE_OUTCOME_UNCERTAIN", message: "Canvas may have created this task, but APStudyCanvas could not verify the result." } };
            return { ok: true, state: "reconciled", body: { id: 72 } };
        },
        createNestTask: async () => {
            nestAttempts += 1;
            throw new Error("Canvas planner mode must not invoke Nest transport");
        },
        now: Date.parse("2026-08-25T12:00:00Z")
    });
    controller.mount({ tasks: [], range: { start: "2026-08-25", end: "2026-08-31", timeZone: "UTC" } });
    controller.getRoot().querySelector(".apstudy-todo-add").dispatch("click");
    assert.match(documentRef.body.querySelector(".apstudy-todo-modal-status").textContent, /APStudyCanvas-owned planner task in Canvas/, "the production Add Task click opens the Canvas-mode dialog");
    const courseOptions = documentRef.body.querySelector("#apstudy-todo-field-courseId").children.map((option) => option.textContent);
    assert.deepEqual(courseOptions, ["No course association", "Visible course"], "hidden courses never reach the Canvas writer");
    const title = documentRef.body.querySelector("#apstudy-todo-field-title");
    title.value = "Stable Canvas task";
    title.dispatch("input");
    documentRef.body.querySelector(".apstudy-todo-form").dispatch("submit");
    await tick();
    assert.equal(documentRef.body.querySelector(".apstudy-todo-retry-create").textContent, "Check Canvas");
    assert.match(documentRef.body.querySelector(".apstudy-todo-modal-status").textContent, /may have created/i);
    assert.equal(documentRef.body.querySelector("#apstudy-todo-field-title").value, "Stable Canvas task", "the uncertain draft remains editable");
    documentRef.body.querySelector(".apstudy-todo-retry-create").dispatch("click");
    await tick();
    assert.equal(payloads.length, 2);
    assert.equal(nestAttempts, 0);
    assert.equal(payloads[0].stableId, "pt-stableop-1234567");
    assert.equal(payloads[1].stableId, payloads[0].stableId, "reconciliation reuses the same ownership operation id");
    assert.equal(documentRef.body.querySelector(".apstudy-todo-modal"), null);
});

test("Planner Note rendered actions retain the mapped canonical note", async () => {
    const documentRef = new FakeDocument();
    const host = documentRef.createElement("div");
    const details = planner.encodeDetails({ description: "Read the refreshed note", id: "pt-abcdefg-1234567", completed: false });
    const owned = task("owned-refreshed", "canvas-planner-note", {
        type: "planner_note",
        mutationAuthority: "canvas_planner_note",
        remoteId: "41809",
        raw: { id: 41809, plannable_id: 41809, planner_item_id: 9911, todo_date: "2026-08-26", details, plannable: { id: 41809, details, todo_date: "2026-08-26" } }
    });
    const calls = [];
    const controller = mountRail(documentRef, host, { tasks: [owned] }, {
        plannerTasksEnabled: () => true,
        plannerTaskDraft: (task) => ({ title: task.title, todoDate: task.raw.todo_date, description: planner.splitDetails(task.raw.details).description }),
        completionDispatcher: async (task) => { calls.push(["complete", task]); return { ok: true, task: { ...task, completion: true } }; },
        updatePlannerTask: async (task) => { calls.push(["edit", task]); return { ok: true }; },
        deletePlannerTask: async (task) => { calls.push(["delete", task]); return { ok: true }; },
        createNestTask: async () => { throw new Error("owned Canvas note must never use Nest"); }
    });
    const root = controller.getRoot();
    const row = root.querySelector("[data-task-id='owned-refreshed']");
    root.querySelector("[data-action='edit-planner-task']").dispatch("click");
    documentRef.body.querySelector(".apstudy-todo-form").dispatch("submit");
    await tick();
    root.querySelector("[data-action='edit-planner-task']").dispatch("click");
    documentRef.body.querySelector("[data-action='delete-planner-task']").dispatch("click");
    await tick();
    row.querySelector("[data-action='complete-task']").dispatch("click");
    await tick();
    assert.deepEqual(calls.map(([action, task]) => [action, task.raw.id, task.remoteId]), [
        ["edit", 41809, "41809"],
        ["delete", 41809, "41809"],
        ["complete", 41809, "41809"]
    ], "all rendered actions retain the normalized Planner Note resource rather than its planner row id");
});

test("conflicting Planner Note ids render as non-actionable", () => {
    const documentRef = new FakeDocument();
    const host = documentRef.createElement("div");
    const details = planner.encodeDetails({ description: "Read safely", id: "pt-conflict-1234567", completed: false });
    const conflict = task("conflicting-refreshed", "canvas", {
        type: "planner_note",
        mutationAuthority: null,
        remoteId: "9911",
        raw: { id: 9911, plannable_id: 41998, planner_item_id: 9911, plannable_type: "planner_note", planner_note_resource_id_conflict: true, todo_date: "2026-08-26", details, plannable: { id: 42001, details, todo_date: "2026-08-26" } }
    });
    const calls = [];
    const controller = mountRail(documentRef, host, { tasks: [conflict] }, {
        plannerTasksEnabled: () => true,
        completionDispatcher: async () => { calls.push("complete"); return { ok: true }; },
        updatePlannerTask: async () => { calls.push("edit"); return { ok: true }; },
        deletePlannerTask: async () => { calls.push("delete"); return { ok: true }; }
    });
    const row = controller.getRoot().querySelector("[data-task-id='conflicting-refreshed']");
    assert.equal(row.querySelector("[data-action='complete-task']").disabled, true);
    assert.equal(row.querySelector("[data-action='edit-planner-task']"), null);
    assert.ok(row.querySelector("[data-action='toggle-preview']"), "the row remains inspectable without re-granting mutation controls");
    assert.deepEqual(calls, [], "the rail does not surface any mutation callback for a conflicting row");
});

test("Canvas planner pre-dispatch failure says the task was not sent and preserves the retryable draft", async () => {
    const documentRef = new FakeDocument();
    const host = documentRef.createElement("div");
    let attempts = 0;
    const controller = railApi.create({
        document: documentRef,
        window: windowStub(),
        host,
        plannerTasksEnabled: () => true,
        plannerTaskOperationId: () => "pt-stableop-1234567",
        createPlannerTask: async () => {
            attempts += 1;
            return { ok: false, state: "unavailable", indeterminate: false, recoverable: true, error: { code: "CANVAS_PLANNER_PRE_DISPATCH_UNAVAILABLE", diagnostic: "PBR-CSRF", phase: "pre-dispatch", message: "This task wasn’t sent to Canvas. Check your connection or reload Canvas, then try again." } };
        },
        now: Date.parse("2026-08-25T12:00:00Z")
    });
    controller.mount({ tasks: [], range: { start: "2026-08-25", end: "2026-08-31", timeZone: "UTC" } });
    controller.openAddTask();
    const title = documentRef.body.querySelector("#apstudy-todo-field-title");
    title.value = "Keep this draft";
    title.dispatch("input");
    documentRef.body.querySelector(".apstudy-todo-form").dispatch("submit");
    await tick();
    assert.equal(attempts, 1);
    assert.equal(documentRef.body.querySelector(".apstudy-todo-modal-status").textContent, "This task wasn’t sent to Canvas. Check your connection or reload Canvas, then try again. Diagnostic code: PBR-CSRF (pre-dispatch). Your draft is preserved.");
    assert.equal(documentRef.body.querySelector(".apstudy-todo-modal-status").className, "apstudy-todo-modal-status is-unavailable");
    assert.equal(documentRef.body.querySelector(".apstudy-todo-retry-create").textContent, "Retry");
    assert.equal(documentRef.body.querySelector("#apstudy-todo-field-title").value, "Keep this draft");
});

test("real planner submit preserves bridge diagnostics, uses callback-only runtime replies, and never renders a misleading HTTP body", async () => {
    const origin = "https://canvas.example.edu";
    const sender = { tab: { id: 71, url: `${origin}/` }, url: `${origin}/`, frameId: 0 };
    async function submit(executeScript, replyTransform = (reply) => reply) {
        const bridge = plannerPageBridge.createPlannerPageBridge({ allowedOrigins: [origin], chromeApi: { scripting: { executeScript } } });
        // This intentionally returns undefined: it is the callback-shaped
        // runtime contract that older Brave builds expose to content scripts.
        const runtime = { sendMessage(message, callback) { void bridge.handle(message, sender).then((reply) => callback(replyTransform(reply, message))); } };
        const page = plannerPageTransport.create({ runtime, origin });
        const domain = planner.createTransport({
            origin,
            enabled: true,
            document: { location: { href: `${origin}/` }, cookie: "_csrf_token=test", querySelector: () => null },
            fetchImpl: page.fetchImpl
        });
        const documentRef = new FakeDocument();
        const host = documentRef.createElement("div");
        const controller = railApi.create({
            document: documentRef,
            window: windowStub(),
            host,
            plannerTasksEnabled: () => true,
            plannerTaskOperationId: () => "pt-bridgee2e-1234567",
            createPlannerTask: (payload) => domain.create(payload),
            now: Date.parse("2026-08-25T12:00:00Z")
        });
        controller.mount({ tasks: [], range: { start: "2026-08-25", end: "2026-08-31", timeZone: "UTC" } });
        controller.openAddTask();
        const title = documentRef.body.querySelector("#apstudy-todo-field-title");
        title.value = "Bridge diagnostic";
        title.dispatch("input");
        documentRef.body.querySelector(".apstudy-todo-form").dispatch("submit");
        await tick(25);
        return { status: documentRef.body.querySelector(".apstudy-todo-modal-status"), page, domain };
    }

    for (const [failure, diagnostic, phase] of [
        ["csrf", "PBR-CSRF", "pre-dispatch"],
        ["origin", "PBR-ORIGIN", "pre-dispatch"],
        ["network", "PBR-NETWORK", "main-world"],
        ["aborted", "PBR-ABORTED", "main-world"],
        ["response_too_large", "PBR-RESPONSETOOLARGE", "main-world"],
        ["response_malformed", "PBR-RESPONSEMALFORME", "main-world"],
        ["response_headers", "PBR-RESPONSEHEADERS", "main-world"]
    ]) {
        const calls = [];
        const { status } = await submit(async (options) => {
            calls.push(options.args?.[0]?.method || "cancel");
            return [{ result: { ok: false, status: 0, error: failure } }];
        });
        assert.match(status.textContent, new RegExp(`Diagnostic code: ${diagnostic} \\(${phase}\\)\\.`), failure);
        assert.equal(status.getAttribute("data-apstudycanvas-planner-build"), "pbr-diagnostic-20260906-1", failure);
        assert.equal(calls.filter((method) => method === "POST").length, 1, `${failure} never duplicates a Canvas create`);
    }

    const emptyMain = await submit(async () => []);
    assert.match(emptyMain.status.textContent, /Diagnostic code: PBR-EMPTY-RESULT \(main-world\)\./);

    const unknownBridgeStatusZero = await submit(
        async () => [{ result: { ok: true, status: 201, body: { id: 91 }, headers: {} } }],
        (reply, message) => message.action === "request" ? { ok: false, status: 0, error: "unclassified_bridge_failure" } : reply
    );
    assert.match(unknownBridgeStatusZero.status.textContent, /Diagnostic code: PBR-UNKNOWN \(main-world\)\./);

    const malicious = await submit(async (options) => {
        const operation = options.args?.[0];
        return [{ result: operation.method === "POST"
            ? { ok: true, status: 422, body: { message: "Request failed with status 0. secret=do-not-render" }, headers: {} }
            : { ok: true, status: 200, body: [], headers: {} } }];
    });
    assert.equal(malicious.status.textContent, "Canvas rejected the planner request. (HTTP 422). Your draft is preserved.");
    assert.doesNotMatch(malicious.status.textContent, /status 0|secret=|PBR-/i);
    malicious.page.dispose();
    malicious.domain.dispose();
});

test("changing the timeframe select reports the committed settings so the owner can persist them", () => {
    const documentRef = new FakeDocument();
    const host = documentRef.createElement("div");
    const changes = [];
    const controller = mountRail(documentRef, host, { tasks: [task("one", "canvas")] }, { onTimeframeChange: (payload) => changes.push(payload) });
    const root = controller.getRoot();
    const select = root.querySelector(".apstudy-todo-timeframe-select");
    select.value = "month";
    select.dispatch("change");
    assert.equal(changes.length, 1, "the select change notifies the owner exactly once");
    assert.equal(changes[0].timeframe, "month");
    assert.equal(changes[0].settings?.todo_timeframe, "month", "the payload carries the committed settings for persistence");
    assert.ok(changes[0].range?.start && changes[0].range?.end, "the payload carries the rebuilt range");
    assert.equal(controller.getState().settings.todo_timeframe, "month", "the rail's own state leads immediately");
});

test("timeframe renders BC's pill dropdown with icon arrows, range text, Today reset, and custom value+unit", () => {
    const documentRef = new FakeDocument();
    const host = documentRef.createElement("div");
    const controller = mountRail(documentRef, host, { tasks: [] });
    const root = controller.getRoot();
    assert.equal(railText(root, ".apstudy-todo-range-output"), "Aug 24 - Aug 30");
    const previous = root.querySelector("[data-action='previous-timeframe']");
    const next = root.querySelector("[data-action='next-timeframe']");
    assert.equal(previous.getAttribute("aria-label"), "Previous week");
    assert.ok(previous.querySelector("svg"), "icon arrows");
    previous.dispatch("click");
    assert.equal(railText(root, ".apstudy-todo-range-output"), "Aug 17 - Aug 23");
    next.dispatch("click");
    next.dispatch("click");
    assert.equal(railText(root, ".apstudy-todo-range-output"), "Aug 31 - Sep 6");
    root.querySelector("[data-action='today']").dispatch("click");
    assert.equal(controller.getState().range.start, time.localDateKey(Date.now(), "UTC"), "Today resets the window to now");

    controller.update({ settings: { todo_timeframe: "custom", todo_custom_range_days: 14 } });
    const custom = root.querySelector("[data-custom-range='true']");
    assert.ok(custom, "custom exposes the value+unit control");
    assert.equal(custom.querySelector(".apstudy-todo-custom-value").value, "2");
    custom.querySelector(".apstudy-todo-custom-unit").value = "weeks";
    custom.querySelector(".apstudy-todo-custom-value").value = "3";
    custom.querySelector("[data-action='save-custom-range']").dispatch("click");
    assert.equal(controller.getState().range.length, 21, "3 weeks saves a 21-day window");
    assert.equal(controller.getState().settings.todo_custom_range_days, 21);
    custom.querySelector(".apstudy-todo-custom-value").value = "0";
    custom.querySelector("[data-action='save-custom-range']").dispatch("click");
    assert.match(custom.querySelector(".apstudy-todo-custom-help").textContent, /at least 1/);
});

test("course legend chips share the filter state with the progress rings and dim when a filter is active", () => {
    const documentRef = new FakeDocument();
    const host = documentRef.createElement("div");
    const changes = [];
    const resets = [];
    const controller = railApi.create({ document: documentRef, window: windowStub(), host, onCourseFilterChange: (ids) => changes.push(ids), onCourseFilterReset: (reason) => resets.push(reason), now: Date.parse("2026-08-25T12:00:00Z") });
    controller.mount({
        tasks: [task("one", "canvas"), task("two", "canvas"), task("personal", "nest", { course: null })],
        range: { start: "2026-08-24", end: "2026-08-30", timeZone: "UTC" }
    });
    let root = controller.getRoot();
    const chips = () => Array.from(root.querySelectorAll("button.apstudy-todo-course-filter"));
    assert.equal(chips().length, 2, "course chip plus the Personal/Nest entry");
    const personal = chips().find((chip) => chip.getAttribute("data-course-id") === railApi.PERSONAL_COURSE_ID);
    assert.ok(personal, "Personal entry appears for courseless Nest tasks");
    assert.equal(personal.querySelector(".apstudy-todo-course-code").textContent, "Personal");
    assert.ok(root.querySelector(".apstudy-todo-progress-graphic").getAttribute("title") === "Click to see tasks");

    chips()[0].dispatch("click");
    root = controller.getRoot();
    assert.deepEqual(changes.at(-1), ["42"]);
    assert.ok(root.querySelector(".apstudy-todo-progress-legend").className.includes("has-filter"), "legend marks the active filter");
    assert.equal(root.querySelectorAll("[data-status='active'].apstudy-todo-task, li.apstudy-todo-task").length, 2, "rows recompute atomically");

    // Clicking a progress ring applies the same shared filter; clicking again clears.
    const ring = root.querySelector("circle[data-course-id='42']");
    assert.ok(ring, "course rings are clickable");
    root.querySelector("[data-group='tomorrow'] .apstudy-todo-group-heading").dispatch("click");
    ring.dispatch("click");
    assert.deepEqual(changes.at(-1), [], "clicking the selected ring clears the filter");
    assert.equal(controller.getRoot().querySelector(".apstudy-todo-progress-legend").className.includes("has-filter"), false);

    // Hovering a chip dims the other rings.
    chips()[0].dispatch("mouseenter");
    assert.equal(root.querySelectorAll("[data-dim='true']").length, 1, "the non-hovered ring dims");
    chips()[0].dispatch("mouseleave");
    assert.equal(root.querySelectorAll("[data-dim='true']").length, 0);

    controller.update({ settings: { todo_timeframe: "month" } });
    assert.ok(resets.includes("timeframe_changed"));
});

test("the legend and graphic follow the ring scope: active-task courses by default, every displayed course under all", () => {
    const documentRef = new FakeDocument();
    const host = documentRef.createElement("div");
    // The sidebar's displayed-card model is the authoritative set: 8 courses
    // are displayed on the dashboard, one has only a completed task in the
    // current range, one has an open task, and the rest have no tasks at all.
    // Under the default "Courses with active tasks" scope the completed-only
    // course still lists with its full ring (finished work counts, BC-style);
    // only the zero-task courses stay out. "All courses" restores the full
    // displayed set with real zero totals.
    const displayed = Array.from({ length: 8 }, (_, index) => ({
        id: String(100 + index),
        label: `Course ${index + 1}`,
        code: `CRS ${index + 1}`,
        color: "#294d91"
    }));
    const tasks = [
        task("done-only", "canvas", { course: { id: "103", label: "Course 4", code: "CRS 4", color: "#294d91" }, completion: true, graded: true }),
        task("open", "canvas", { course: { id: "105", label: "Course 6", code: "CRS 6", color: "#294d91" } })
    ];
    const controller = railApi.create({ document: documentRef, window: windowStub(), host, now: Date.parse("2026-08-25T12:00:00Z") });
    controller.mount({
        courses: displayed,
        tasks,
        range: { start: "2026-08-24", end: "2026-08-30", timeZone: "UTC" }
    });
    let root = controller.getRoot();
    const chips = () => Array.from(root.querySelectorAll("button.apstudy-todo-course-filter"));
    assert.deepEqual(
        chips().map((chip) => chip.getAttribute("data-course-id")),
        ["103", "105"],
        "active scope lists courses with any in-range task, completed or open"
    );
    assert.match(chips()[0].getAttribute("aria-label"), /^Course 4 — 1\/1 tasks complete/, "the completed-only course keeps its full count");
    assert.match(chips()[1].getAttribute("aria-label"), /^Course 6 — 0\/1 tasks complete/);
    const rings = () => Array.from(root.querySelectorAll("circle[data-course-id]"));
    assert.equal(rings().length, 2, "the ring graphic keeps one value ring per listed course");
    const dashOf = (ring) => String(ring.getAttribute("data-final-dash")).split(" ").map(Number);
    const doneRing = rings().find((ring) => ring.getAttribute("data-course-id") === "103");
    assert.equal(dashOf(doneRing)[0], dashOf(doneRing)[1], "the completed-only course's ring sweeps full");
    assert.equal(dashOf(rings().find((ring) => ring.getAttribute("data-course-id") === "105"))[0], 0);
    assert.deepEqual(controller.getState().courses.map((course) => course.id), ["103", "105"]);

    controller.update({ courses: displayed, settings: { todo_course_scope: "all" } });
    root = controller.getRoot();
    assert.equal(chips().length, 8, "all 8 displayed courses appear in the legend under the all scope");
    displayed.forEach((course) => {
        const chip = chips().find((node) => node.getAttribute("data-course-id") === course.id);
        assert.ok(chip, `course ${course.id} has a legend chip`);
        assert.equal(chip.getAttribute("data-course-id"), course.id);
        const zeroTask = !["103", "105"].includes(course.id);
        assert.match(
            chip.getAttribute("aria-label"),
            zeroTask ? new RegExp(`^${course.label} — 0/0 tasks complete`) : new RegExp(`^${course.label} — [01]/1 tasks complete`),
            `${course.label} reports its real totals`
        );
    });
    assert.equal(root.querySelectorAll("circle[data-course-id]").length, 8, "the ring graphic keeps one value ring per displayed course");
    assert.equal(railText(root, ".apstudy-todo-progress-fraction"), "1/2");
});

test("completion is pessimistic, idempotent, and recoverable on failure", async () => {
    const documentRef = new FakeDocument();
    const host = documentRef.createElement("div");
    let resolveCompletion;
    const pending = new Promise((resolve) => { resolveCompletion = resolve; });
    const taskRecord = task("pending", "canvas");
    const calls = [];
    const controller = railApi.create({
        document: documentRef,
        window: windowStub(),
        host,
        completionDispatcher: (record, desired, request) => { calls.push({ record, desired, request }); return pending; },
        now: Date.parse("2026-08-25T12:00:00Z")
    });
    controller.mount({ tasks: [taskRecord], range: { start: "2026-08-25", end: "2026-08-31", timeZone: "UTC" } });
    const root = controller.getRoot();
    root.querySelector(".apstudy-todo-task-complete").dispatch("click");
    assert.equal(root.querySelector(".apstudy-todo-task").getAttribute("data-status"), "active");
    assert.equal(root.querySelector(".apstudy-todo-task-complete").disabled, true);
    await tick();
    assert.equal(calls[0].request.idempotencyKey.includes("todo-completion"), true);
    resolveCompletion({ ok: true, task: { ...taskRecord, completion: true } });
    await tick();
    assert.equal(controller.getState().tasks.find((entry) => entry.id === taskRecord.id).completion, true);

    let fail = true;
    const failed = railApi.create({
        document: documentRef,
        window: windowStub(),
        host: documentRef.createElement("div"),
        completionDispatcher: async () => fail ? { ok: false, error: { message: "Canvas rejected the change." } } : { ok: true, task: { ...taskRecord, completion: true } },
        now: Date.parse("2026-08-25T12:00:00Z")
    });
    failed.mount({ tasks: [taskRecord], range: { start: "2026-08-25", end: "2026-08-31", timeZone: "UTC" } });
    failed.getRoot().querySelector(".apstudy-todo-task-complete").dispatch("click");
    await tick();
    assert.equal(failed.getRoot().querySelector(".apstudy-todo-task").getAttribute("data-status"), "active");
    assert.ok(failed.getRoot().querySelector(".apstudy-todo-task-retry"));
    assert.match(failed.getRoot().querySelector(".apstudy-todo-task-error").textContent, /Canvas rejected/);
    fail = false;
    failed.getRoot().querySelector(".apstudy-todo-task-retry").dispatch("click");
    await tick();
    assert.equal(failed.getState().tasks.find((entry) => entry.id === taskRecord.id).completion, true);
});

test("assignment completion asks for confirmation before using extension-only state", async () => {
    const documentRef = new FakeDocument();
    const taskRecord = task("local-only", "canvas");
    const confirmations = [];
    const calls = [];
    const controller = railApi.create({
        document: documentRef,
        window: windowStub(false, { confirm: (message) => { confirmations.push(message); return true; } }),
        host: documentRef.createElement("div"),
        completionDispatcher: async (record, desired) => { calls.push([record.id, desired]); return { ok: true, task: { ...record, completion: desired } }; },
        now: Date.parse("2026-08-25T12:00:00Z")
    });
    controller.mount({ tasks: [taskRecord], range: { start: "2026-08-25", end: "2026-08-31", timeZone: "UTC" } });
    controller.getRoot().querySelector(".apstudy-todo-task-complete").dispatch("click");
    await tick();
    assert.match(confirmations[0], /will not change Canvas/);
    assert.deepEqual(calls, [["local-only", true]]);

    const cancelled = railApi.create({
        document: documentRef,
        window: windowStub(false, { confirm: () => false }),
        host: documentRef.createElement("div"),
        completionDispatcher: async () => { throw new Error("must not dispatch after cancellation"); },
        now: Date.parse("2026-08-25T12:00:00Z")
    });
    cancelled.mount({ tasks: [taskRecord], range: { start: "2026-08-25", end: "2026-08-31", timeZone: "UTC" } });
    cancelled.getRoot().querySelector(".apstudy-todo-task-complete").dispatch("click");
    await tick();
    assert.equal(cancelled.getState().tasks[0].completion, false);
});

test("announcement rows toggle Canvas read state: read-aware copy, confirmed read moves the row to Recent", async () => {
    const documentRef = new FakeDocument();
    const taskRecord = task("notice", "canvas", { type: "announcement", unread: true, readState: "unread" });
    const calls = [];
    const controller = railApi.create({
        document: documentRef,
        window: windowStub(),
        host: documentRef.createElement("div"),
        completionDispatcher: async (record, desired) => {
            calls.push([record.id, desired]);
            return { ok: true, authority: "canvas_announcement_read", task: { ...record, unread: desired !== true, readState: desired ? "read" : "unread" } };
        },
        now: Date.parse("2026-08-25T12:00:00Z")
    });
    controller.mount({ tasks: [taskRecord], range: { start: "2026-08-25", end: "2026-08-31", timeZone: "UTC" } });
    const root = controller.getRoot();
    root.querySelector("#apstudy-todo-tab-announcements").dispatch("click");
    const button = root.querySelector("[data-group='unread'] .apstudy-todo-task-complete");
    assert.equal(button.getAttribute("aria-label"), "Mark as read: canvas notice");
    assert.equal(button.getAttribute("aria-pressed"), "false");
    assert.equal(button.getAttribute("title"), "Mark as read");
    button.dispatch("click");
    await tick();
    assert.deepEqual(calls, [["notice", true]], "an unread announcement dispatches a read request");
    assert.equal(root.querySelector("[data-group='unread']"), null, "the read announcement leaves the Unread group");
    assert.match(root.querySelector(".apstudy-todo-live").textContent, /marked read/);
    root.querySelector("[data-group='recent'] .apstudy-todo-group-heading").dispatch("click");
    const readButton = root.querySelector("[data-group='recent'] .apstudy-todo-task-complete");
    assert.equal(readButton.getAttribute("aria-pressed"), "true");
    assert.equal(readButton.getAttribute("aria-label"), "Mark as unread: canvas notice");
    assert.equal(readButton.getAttribute("title"), "Mark as unread");
    assert.equal(root.querySelector("[data-group='recent'] .apstudy-todo-task").getAttribute("data-status"), "active", "read state never renders as completed status");

    readButton.dispatch("click");
    await tick();
    assert.deepEqual(calls[1], ["notice", false], "toggling again dispatches an unread request");
    assert.ok(root.querySelector("[data-group='unread'] .apstudy-todo-task"), "the announcement returns to Unread");
    assert.match(root.querySelector(".apstudy-todo-live").textContent, /marked unread/);
});

test("a throwing onCompletionFailure consumer is invoked exactly once and stays contained", async () => {
    const documentRef = new FakeDocument();
    const host = documentRef.createElement("div");
    const failures = [];
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
        const controller = railApi.create({
            document: documentRef,
            window: windowStub(),
            host,
            completionDispatcher: async () => ({ ok: false, error: { message: "Canvas rejected the change." } }),
            // A consumer that throws while handling the failure must not be
            // re-entered through the promise catch, and the rejection must
            // never escape as unhandled.
            onCompletionFailure: (payload) => { failures.push(payload); throw new Error("consumer exploded"); },
            now: Date.parse("2026-08-25T12:00:00Z")
        });
        controller.mount({ tasks: [task("contained", "canvas")], range: { start: "2026-08-25", end: "2026-08-31", timeZone: "UTC" } });
        controller.getRoot().querySelector(".apstudy-todo-task-complete").dispatch("click");
        await tick();
        await tick();
        assert.equal(failures.length, 1, "the throwing consumer callback runs once, not twice");
        assert.equal(failures[0]?.error?.message, "Canvas rejected the change.");
        assert.ok(controller.getRoot().querySelector(".apstudy-todo-task-retry"), "the retry affordance still renders");
        assert.equal(controller.getState().completionPending, null, "no completion stays stuck as pending");
    } finally {
        process.off("unhandledRejection", onUnhandled);
    }
    assert.equal(unhandled.filter((reason) => reason instanceof Error && reason.message === "consumer exploded").length, 0);
});

test("settings hooks reset course filters, mount is idempotent, teardown restores native nodes, and effects honor motion/intensity", () => {
    const documentRef = new FakeDocument();
    const host = documentRef.createElement("div");
    const nativeOne = documentRef.createElement("section");
    const nativeTwo = documentRef.createElement("div");
    host.append(nativeOne, nativeTwo);
    const resets = [];
    const changes = [];
    const controller = railApi.create({ document: documentRef, window: windowStub(), host, onCourseFilterReset: (reason) => resets.push(reason), onCourseFilterChange: (ids) => changes.push(ids), now: Date.parse("2026-08-25T12:00:00Z") });
    const first = controller.mount({ tasks: dataSet(), range: { start: "2026-08-24", end: "2026-08-30", timeZone: "UTC" } });
    const second = controller.mount({ tasks: dataSet() });
    assert.equal(second.state, "already-mounted");
    assert.equal(first.root, controller.getRoot());
    controller.getRoot().querySelector("button.apstudy-todo-course-filter").dispatch("click");
    assert.deepEqual(changes.at(-1), ["42"]);
    controller.update({ settings: { todo_timeframe: "month" } });
    assert.ok(resets.includes("timeframe_changed"));
    controller.getRoot().querySelector("button.apstudy-todo-course-filter")?.dispatch("click");
    controller.update({ tasks: [task("other", "canvas", { course: { id: "99", label: "Other" } })] });
    assert.ok(resets.includes("course_vanished"));
    controller.destroy();
    assert.deepEqual(host.children, [nativeOne, nativeTwo]);
    const remount = controller.mount({ tasks: [] });
    assert.equal(remount.ok, true);
    controller.destroy();

    const effectsDocument = new FakeDocument();
    const container = effectsDocument.createElement("div");
    let timerCallback;
    const effects = effectsApi.createTodoEffects({ document: effectsDocument, window: windowStub(true), setTimer: (callback) => { timerCallback = callback; return 1; }, clearTimer: () => {} });
    const staticResult = effects.celebrate({ container, type: "confetti", intensity: "insane", reducedMotion: true });
    assert.equal(staticResult.mode, "static");
    assert.ok(container.querySelector("[data-effect-mode='static']"));
    const animated = effects.celebrate({ container, type: "stars", intensity: "extra", reducedMotion: false });
    assert.equal(animated.mode, "animated");
    assert.equal(animated.count, 18);
    assert.ok(container.querySelectorAll("[data-effect-type='stars']").length);
    timerCallback();
});

test("completion effects respect the reduced-motion safety preference", () => {
    const source = fs.readFileSync(path.join(__dirname, "../../js/content/todo-right-rail.js"), "utf8");
    assert.match(source, /reducedMotion: state\.settings\.todo_reduced_motion_safe === true\s*\? effects\?\.prefersReducedMotion\?\.\(windowRef\)\s*: false/);
});

test("normalizeSettings maps renamed styles and the legacy rings flag onto the BC circle default", () => {
    assert.equal(railApi.normalizeSettings({}).todo_progress_style, "circle", "factory default is Circle");
    assert.equal(railApi.normalizeSettings({ todo_progress_style: "simple" }).todo_progress_style, "circle");
    assert.equal(railApi.normalizeSettings({ todo_progress_style: "minimal" }).todo_progress_style, "bar");
    assert.equal(railApi.normalizeSettings({ todo_progress_style: "nested" }).todo_progress_style, "rainbow");
    assert.equal(railApi.normalizeSettings({ todo_progress_style: "segmented" }).todo_progress_style, "bar");
    assert.equal(railApi.normalizeSettings({ todo_progress_rings: true }).todo_progress_style, "circle");
    assert.equal(railApi.normalizeSettings({ todo_progress_rings: false }).todo_progress_style, "none");
    assert.equal(railApi.normalizeSettings({ todo_progress_style: "heart" }).todo_progress_style, "heart");
});

// Phase 2A2 convergence instrumentation. The spies watch the exact mutation
// surfaces the renderer owns: root.replaceChildren (what clearChildren
// drives), document.createElement (a full rebuild builds fresh elements),
// and the node identity of the root's sections.
function convergenceInput() {
    return {
        tasks: dataSet(),
        streak: { current: 4 },
        feedback: [{ source: "canvas", title: "Lab report", score: { earned: 8, possible: 10 } }],
        calendar: { state: "connected" },
        settings: { todo_hide_feedback: false },
        range: { start: "2026-08-24", end: "2026-08-30", timeZone: "UTC" }
    };
}

function instrumentMutations(documentRef, root) {
    const instrumentation = { clears: 0, created: 0 };
    const originalCreateElement = documentRef.createElement.bind(documentRef);
    documentRef.createElement = (tag) => { instrumentation.created += 1; return originalCreateElement(tag); };
    const originalReplaceChildren = root.replaceChildren.bind(root);
    root.replaceChildren = (...nodes) => { instrumentation.clears += 1; return originalReplaceChildren(...nodes); };
    return instrumentation;
}

test("an identical second update converges: no clearChildren, no element creation, no rebuilt nodes, and hidden volatility stays out of the signature", () => {
    const documentRef = new FakeDocument();
    const host = documentRef.createElement("div");
    const controller = mountRail(documentRef, host, convergenceInput());
    const root = controller.getRoot();
    const sections = Array.from(root.children);
    assert.ok(sections.length >= 8, "the mount painted the rail sections");

    // Repeat updates with freshly built (structurally identical, never
    // reference-identical) input must leave the mounted tree untouched.
    const first = controller.update(convergenceInput());
    const second = controller.update(convergenceInput());
    assert.equal(first.ok, true);
    assert.equal(first.state, "updated");
    assert.equal(first.rendered, false, "the first repeat update converges");
    assert.equal(second.rendered, false, "the second repeat update converges");

    const instrumentation = instrumentMutations(documentRef, root);
    const third = controller.update(convergenceInput());
    assert.equal(third.rendered, false);
    assert.equal(instrumentation.clears, 0, "clearChildren never runs");
    assert.equal(instrumentation.created, 0, "no element is built");
    Array.from(root.children).forEach((node, index) => assert.equal(node, sections[index], `section ${index} keeps node identity`));

    // Values that never render must stay outside the signature: hidden task
    // timestamps and bookkeeping, functions, controller/DOM references.
    const volatileTasks = dataSet().map((entry) => ({
        ...entry,
        raw: { syncedAt: "2026-08-29T04:00:00Z", revision: { seq: 91 } },
        controllerRef: {},
        hiddenCheckpoint: Date.now()
    }));
    const noisyInput = {
        ...convergenceInput(),
        tasks: volatileTasks,
        syncedAt: "2026-08-29T09:00:00Z",
        onVolatileHook: () => {},
        scratchNode: documentRef.createElement("div")
    };
    const noisy = controller.update(noisyInput);
    assert.equal(noisy.rendered, false, "non-displayed volatility does not rerender");
    assert.equal(instrumentation.clears, 0);
    assert.equal(Array.from(root.children)[0], sections[0], "the tree was not touched");

    // Even a different invisible value between updates stays converged.
    const secondScratch = documentRef.createElement("div");
    instrumentation.created = 0;
    const noisyTwo = controller.update({ ...noisyInput, scratchNode: secondScratch });
    assert.equal(noisyTwo.rendered, false, "a different-but-invisible value still converges");
    assert.equal(instrumentation.created, 0, "converged updates build nothing");
});

test("every render-visible change still renders: list, count, text, controls, settings, and derived surfaces", () => {
    const cases = [
        ["task title text", (base) => ({ ...base, tasks: base.tasks.map((entry) => entry.id === "today" ? { ...entry, title: "Renamed field survey" } : entry) }),
            (root) => assert.equal(root.querySelector("[data-task-id='today'] .apstudy-todo-task-title").textContent, "Renamed field survey")],
        ["a task joins the list", (base) => ({ ...base, tasks: base.tasks.concat([task("brand-new", "canvas")]) }),
            (root) => assert.ok(root.querySelector("[data-task-id='brand-new']"), "the new row paints")],
        ["a task leaves the list", (base) => ({ ...base, tasks: base.tasks.filter((entry) => entry.id !== "overdue") }),
            (root) => assert.equal(root.querySelector("[data-task-id='overdue']"), null)],
        ["a task completes", (base) => ({ ...base, tasks: base.tasks.map((entry) => entry.id === "today" ? { ...entry, completion: true } : entry) }),
            (root) => assert.equal(root.querySelector("[data-task-id='today']"), null, "the completed row leaves the assigned list")],
        ["an announcement is marked read", (base) => ({ ...base, tasks: base.tasks.map((entry) => entry.id === "announcement" ? { ...entry, unread: false } : entry) }),
            (root) => assert.equal(root.querySelector("#apstudy-todo-tab-announcements .apstudy-todo-tab-badge"), null)],
        ["the selected tab changes", (base) => ({ ...base, selectedTab: "done" }),
            (root) => {
                assert.equal(root.querySelector("[role='tabpanel']").getAttribute("aria-labelledby"), "apstudy-todo-tab-done");
                assert.ok(root.querySelector("[data-task-id='completed']"), "completed rows paint on the done tab");
            }],
        ["the course filter changes", (base) => ({ ...base, selectedCourseIds: ["42"] }),
            (root) => assert.ok(root.querySelector(".apstudy-todo-progress-legend").className.includes("has-filter"))],
        ["a group collapses", (base) => ({ ...base, collapsedGroups: ["assigned:missing"] }),
            (root) => assert.ok(root.querySelector("[data-group='missing']").className.includes("is-collapsed"))],
        ["the progress style changes", (base) => ({ ...base, settings: { ...base.settings, todo_progress_style: "bar" } }),
            (root) => assert.ok(root.querySelector("[data-progress-style='bar']"))],
        ["the date format changes", (base) => ({ ...base, settings: { ...base.settings, todo_date_format: "relative" } }),
            (root) => assert.match(root.querySelector("[data-task-id='today'] .apstudy-todo-task-due").textContent, /Due today/)],
        ["the range changes", (base) => ({ ...base, range: { start: "2026-09-01", end: "2026-09-07", timeZone: "UTC" } }),
            (root) => assert.equal(railText(root, ".apstudy-todo-range-output"), "Sep 1 - Sep 7")],
        ["the streak changes", (base) => ({ ...base, streak: { current: 9 } }),
            (root) => assert.match(railText(root, ".apstudy-todo-streak-summary strong"), /^9 day streak/)],
        ["feedback rows change", (base) => ({ ...base, feedback: [{ source: "canvas", title: "Lab report", score: { earned: 8, possible: 10 } }, { source: "nest", title: "Essay notes", score: null }] }),
            (root) => assert.equal(root.querySelectorAll(".apstudy-todo-feedback-row").length, 2)],
        ["the calendar sync state changes", (base) => ({ ...base, calendar: { state: "syncing", syncing: true } }),
            (root) => assert.equal(root.querySelector(".apstudy-todo-sync").getAttribute("data-sync-state"), "syncing")],
        ["the live message changes", (base) => ({ ...base, liveMessage: "Synced just now." }),
            (root) => assert.equal(railText(root, ".apstudy-todo-live"), "Synced just now.")]
    ];

    cases.forEach(([label, mutate, assertDom]) => {
        const documentRef = new FakeDocument();
        const host = documentRef.createElement("div");
        const controller = mountRail(documentRef, host, convergenceInput());
        const root = controller.getRoot();
        assert.equal(controller.update(convergenceInput()).rendered, false, `${label}: the untouched baseline converges`);
        const instrumentation = instrumentMutations(documentRef, root);
        const before = Array.from(root.children);
        const result = controller.update(mutate(convergenceInput()));
        assert.equal(result.rendered, true, `${label} rerenders`);
        assert.ok(instrumentation.clears >= 1, `${label} clears the root before rebuilding`);
        assert.ok(instrumentation.created > 0, `${label} builds fresh elements`);
        assert.notEqual(Array.from(root.children)[0], before[0], `${label} rebuilds the section nodes`);
        assertDom(root);
        const repeat = controller.update(mutate(convergenceInput()));
        assert.equal(repeat.rendered, false, `${label}: the changed state converges on repeat`);
    });
});

test("destroy and remount reset the render signature: teardown refuses updates and a replayed input repaints a new root", () => {
    const documentRef = new FakeDocument();
    const host = documentRef.createElement("div");
    const controller = mountRail(documentRef, host, convergenceInput());
    const firstRoot = controller.getRoot();
    assert.equal(controller.update(convergenceInput()).rendered, false, "converged while mounted");

    controller.destroy();
    assert.deepEqual(host.children, [], "teardown empties the host");
    const rejected = controller.update(convergenceInput());
    assert.equal(rejected.ok, false, "update after destroy refuses");
    assert.equal(rejected.code, "TODO_RAIL_NOT_MOUNTED");

    // Same controller, replayed input: the signature reset forces a fresh paint.
    const remounted = controller.mount(convergenceInput());
    assert.equal(remounted.ok, true);
    assert.equal(remounted.state, "mounted");
    const secondRoot = controller.getRoot();
    assert.notEqual(secondRoot, firstRoot, "the remount builds a brand-new root");
    assert.deepEqual(host.children, [secondRoot]);
    assert.ok(secondRoot.querySelector(".apstudy-todo-panel"), "the replayed input painted a full rail");
    assert.equal(controller.update(convergenceInput()).rendered, false, "the new tree converges against its own signature");
    assert.equal(controller.update({ ...convergenceInput(), streak: { current: 7 } }).rendered, true, "a visible change after remount still renders");

    const again = controller.mount({ ...convergenceInput(), streak: { current: 7 } });
    assert.equal(again.state, "already-mounted");
    assert.match(railText(secondRoot, ".apstudy-todo-streak-summary strong"), /^7 day streak/, "an already-mounted mount repaints on a visible change");
});

test("the isolated stylesheet exposes Nest tokens, BC-aligned geometry, seven styles, and reduced-motion suppression", () => {
    const css = fs.readFileSync(path.join(__dirname, "../../css/todo-right-rail.css"), "utf8");
    const fontFaces = fs.readFileSync(path.join(__dirname, "../../js/content/font-faces.js"), "utf8");
    assert.match(css, /Newsreader/);
    assert.match(css, /Public Sans/);
    assert.match(fontFaces, /font-family: "IBM Plex Mono"/, "rail faces are declared by extension URL in font-faces.js");
    ["none", "circle", "rainbow", "bar", "heart", "cloud", "oiia"].forEach((style) => assert.match(css, new RegExp(`is-${style}`)));
    assert.match(css, /data-placement="below-course-cards"/);
    assert.match(css, /@container/);
    assert.match(css, /prefers-reduced-motion/);
    assert.match(css, /focus-visible/);
    assert.match(css, /apstudy-todo-tabs/, "folder tab tray");
    assert.match(css, /apstudy-todo-preview/, "hover preview card");
    assert.doesNotMatch(css, /inset-inline-end:\s*calc\(100% \+ 10px\)/, "preview has no off-rail inline escape path");
    assert.doesNotMatch(css, /clamp\(280px,\s*100%,\s*380px\)/, "rail has no 280px effective minimum");
    assert.doesNotMatch(css, /min-width:\s*280px/, "no authored narrow-host minimum remains");
    assert.match(css, /\.apstudy-todo-progress\s*\{[^}]*max-width:\s*100%;[^}]*overflow:\s*hidden;/s, "progress stays contained by a narrow rail");
    assert.match(css, /\.apstudy-todo-progress-graphic\s*\{[^}]*max-width:\s*100%;[^}]*overflow:\s*hidden;/s, "progress art cannot expand the page scroll width");
    assert.match(css, /@container \(max-width: 280px\)[\s\S]*apstudy-todo-custom-range \{ grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\); \}/, "custom controls reflow instead of forcing a horizontal strip");
    assert.match(css, /apstudy-todo-task-spine/, "course-color spine");
    assert.match(css, /line-through/, "completed titles strike through");
    assert.match(css, /animation(?!-name).*none|animation: none/, "reduced motion suppresses decorative animation");
    assert.doesNotMatch(css, /fonts\.googleapis|fonts\.gstatic|data:image|url\(https?:/i);
});

test("the Add Task dialog contains native fields and reflows its Due Date controls at 200% zoom", () => {
    const css = fs.readFileSync(path.join(__dirname, "../../css/todo-right-rail.css"), "utf8");
    const nativeFields = css.match(/\.apstudy-todo-form textarea,\s*\.apstudy-todo-form input,\s*\.apstudy-todo-form select\s*\{([^}]*)\}/);
    assert.ok(nativeFields, "the modal owns one native-field containment rule");
    assert.match(nativeFields[1], /inline-size:\s*100%;/, "native fields fill only their grid track");
    assert.match(nativeFields[1], /max-inline-size:\s*100%;/, "native fields cannot widen the dialog");
    assert.match(nativeFields[1], /min-width:\s*0;/, "native fields may shrink below browser intrinsic widths");

    const dueRule = css.match(/\.apstudy-todo-form-due\s*\{([^}]*)\}/);
    assert.ok(dueRule, "the due-time group is an owned grid");
    assert.match(dueRule[1], /inline-size:\s*100%;/, "the due-time group stays inside its row");
    assert.match(dueRule[1], /grid-template-columns:\s*minmax\(0, 1\.4fr\) minmax\(0, 1fr\);/, "desktop keeps the compact date/time pair");

    const zoomRule = css.match(/@media \(max-width: 760px\)\s*\{\s*\.apstudy-todo-form-due\s*\{([^}]*)\}/);
    assert.ok(zoomRule, "a medium effective viewport has a due-time reflow rule");
    assert.match(zoomRule[1], /grid-template-columns:\s*minmax\(0, 1fr\);/, "date and time stack so both remain reachable at 200% zoom");
    assert.match(css, /\.apstudy-todo-modal,\s*\.apstudy-todo-modal \*\s*\{\s*box-sizing:\s*border-box;/, "host content-box styles cannot add width outside the modal");
    assert.match(css, /\.apstudy-todo-form-row > \*,\s*\.apstudy-todo-form-due,\s*\.apstudy-todo-form-points,\s*\.apstudy-todo-modal-actions\s*\{\s*min-inline-size:\s*0;/, "form rows and action controls can shrink without horizontal overflow");
});

test("the header owns the single To-Do divider, the tray shares one optical center, and the rainbow composition stays centered", () => {    const css = fs.readFileSync(path.join(__dirname, "../../css/todo-right-rail.css"), "utf8");

    // Exactly one divider under To-Do List: the header row carries it; the
    // owned title stays borderless so Canvas's heading borders never double it.
    assert.match(css, /\.apstudy-todo-header\s*\{[^}]*border-bottom:\s*1px solid var\(--todo-border\);/s, "the header owns the single divider");
    const titleRule = css.match(/\.apstudy-todo-header h2,\s*#right-side #apstudy-todo-title\s*\{([^}]*)\}/);
    assert.ok(titleRule, "the owned title has its own reset rule");
    assert.match(titleRule[1], /(^|\s)border:\s*0;/, "the owned title carries no border of its own");
    assert.doesNotMatch(titleRule[1], /border-bottom/);

    // One shared vertical center across the three tabs: the tray stretches its
    // tabs, each tab centers its icon+label, and the raised selected card
    // centers too (33px in the 32px track) instead of sagging on flex-start.
    assert.match(css, /\.apstudy-todo-tabs\s*\{[^}]*align-items:\s*stretch;/s);
    assert.match(css, /\.apstudy-todo-tab\s*\{[^}]*align-items:\s*center;/s);
    assert.match(css, /\.apstudy-todo-tab\[aria-selected="true"\]\s*\{[^}]*align-self:\s*center;/s);
    assert.match(css, /\.apstudy-todo-tab-badge\s*\{[^}]*position:\s*absolute;/s, "the badge stays anchored to its tab");

    // The rainbow draws one band per course in the course palette, and its
    // complete composition — arcs, readout, and legend — remains horizontally
    // centered even in the wide below-course-cards placement where plain
    // legends go flex-start.
    assert.equal(railApi.RAINBOW_BANDS, undefined, "the fixed six-band spectral set is retired");
    assert.match(css, /@container \(min-width: 391px\)\s*\{[\s\S]*?\.apstudy-todo-progress-legend\s*\{\s*justify-content:\s*flex-start;\s*\}[\s\S]*?\.is-rainbow \.apstudy-todo-progress-legend\s*\{\s*justify-content:\s*center;/);
    assert.match(css, /\.is-rainbow \.apstudy-todo-progress-summary:not\(\.is-empty\)\s*\{[^}]*justify-content:\s*center;/s, "the BC-style readout sits centered beneath the arch");
    assert.doesNotMatch(css, /\.is-rainbow \.apstudy-todo-progress-summary:not\(\.is-empty\)\s*\{[^}]*grid-area/s, "the readout never overlays the rainbow bands");
    assert.match(css, /\.apstudy-todo-progress-graphic\.is-rainbow\s*\{[^}]*width:\s*min\(100%, 238px\);/s, "the rainbow keeps its centered BC width");
    // No fixed aspect-ratio may reserve height the drawing does not use: the
    // per-count viewBox is the compact frame, and the CSS box follows its
    // intrinsic ratio instead of the retired fixed 160/84 box.
    assert.doesNotMatch(css, /\.apstudy-todo-progress-graphic[^,{]*\{[^}]*aspect-ratio/s, "no fixed aspect-ratio reserves blank rainbow height");
    assert.match(css, /\.apstudy-todo-progress-graphic\.is-rainbow\s*\{[^}]*justify-self:\s*center;/s, "the compact arch stays centered");
});

test("the progress graphic covers every represented course without truncation or overflow", () => {
    const documentRef = new FakeDocument();
    const manyCourses = Array.from({ length: 8 }, (_, index) => task(`m${index}`, "canvas", {
        course: { id: String(100 + index), label: `Course ${index}`, code: `C${index}`, color: "#294d91" },
        completion: index % 2 === 0
    }));
    const controller = mountRail(documentRef, documentRef.createElement("div"), {
        tasks: manyCourses,
        settings: { todo_progress_style: "circle" }
    });
    const root = controller.getRoot();
    const rings = root.querySelectorAll("circle[data-course-id]");
    assert.equal(new Set(rings.map((ring) => ring.getAttribute("data-course-id"))).size, 8, "every course keeps a value ring past the old six-course cap");
    rings.forEach((ring) => assert.ok(Number(ring.getAttribute("r")) > 0, "no ring radius collapses"));

    controller.update({ settings: { todo_progress_style: "rainbow" } });
    const arcs = Array.from(root.querySelectorAll("[data-progress-style='rainbow'] path"));
    const tracks = arcs.filter((arc) => String(arc.getAttribute("stroke")).includes("color-mix"));
    assert.equal(tracks.length, 8, "the arch draws one faint track per course, not a fixed band count");
    const bands = arcs.filter((arc) => !String(arc.getAttribute("stroke")).includes("color-mix"));
    assert.equal(bands.length, 8, "every course keeps its own value band");
    arcs.forEach((arc) => assert.match(String(arc.getAttribute("d")), /^M \d/ , "each band is a deterministic arc path"));
    const radii = bands.map((arc) => Number(String(arc.getAttribute("d")).match(/^M ([\d.]+) 134/)?.[1]));
    assert.deepEqual(new Set(radii).size, 8, "bands stack at distinct radii");
    radii.forEach((leftEdge) => assert.ok(leftEdge >= 16 && leftEdge <= 64.01, "band radii stay inside the arch box"));

    controller.update({ settings: { todo_progress_style: "bar" } });
    const segments = root.querySelectorAll("rect[data-course-id]");
    assert.equal(segments.length, 4, "each contributing course takes exactly one segment");
    let end = 8;
    segments.forEach((segment) => {
        const x = Number(segment.getAttribute("x"));
        const width = Number(segment.getAttribute("width"));
        assert.ok(x >= end - 0.001, "segments stack without overlap");
        end = x + width;
    });
    assert.ok(end <= 152.001, "segments stay inside the 144px track");

    controller.update({ settings: { todo_progress_style: "heart" } });
    assert.equal(root.querySelectorAll("[data-progress-style='heart'] path[data-course-id]").length, 8, "heart layers stop slicing courses");
    controller.update({ settings: { todo_progress_style: "cloud" } });
    const cloudLayers = root.querySelectorAll("[data-progress-style='cloud'] path[data-course-id]");
    assert.equal(cloudLayers.length, 8, "cloud layers stop slicing courses");
    cloudLayers.forEach((layer) => assert.ok(/scale\((\d*\.?\d+)\)/.test(String(layer.getAttribute("transform"))) === false || Number(String(layer.getAttribute("transform")).match(/scale\((\d*\.?\d+)\)/)?.[1]) > 0, "every layer keeps a positive scale"));
});

test("the rainbow arch adapts its band count, width, and colors to the course set", () => {
    const documentRef = new FakeDocument();
    const changes = [];
    const three = Array.from({ length: 3 }, (_, index) => task(`t${index}`, "canvas", {
        course: { id: String(200 + index), label: `Course ${index}`, code: `T${index}`, color: "#1e6f68" },
        completion: false
    }));
    const controller = mountRail(documentRef, documentRef.createElement("div"), { tasks: three, settings: { todo_progress_style: "rainbow" } }, { onCourseFilterChange: (ids) => changes.push(ids) });
    const root = controller.getRoot();
    const bands = () => Array.from(root.querySelectorAll("[data-progress-style='rainbow'] path[data-course-id]"));
    assert.equal(bands().length, 3, "three courses draw three bands — no ghost fixed-count bands");
    bands().forEach((band) => assert.ok(Number(band.getAttribute("stroke-width")) > 8, "few courses draw wide bands"));
    bands().forEach((band, index) => assert.equal(band.getAttribute("data-course-id"), String(200 + index), "each band carries its course identity"));
    bands().forEach((band) => assert.equal(band.getAttribute("stroke"), "#1e6f68", "bands use their course's color, not a fixed spectrum"));
    const dashOf = (band) => String(band.getAttribute("data-final-dash")).split(" ").map(Number);
    bands().forEach((band) => assert.equal(dashOf(band)[0], 0, "open tasks keep their bands empty — no fabricated progress"));

    // The bands share the legend's filter behavior: clicking one filters, clicking again clears.
    bands()[1].dispatch("click");
    assert.deepEqual(changes.at(-1), ["201"]);
    assert.ok(root.querySelector(".apstudy-todo-progress-legend").className.includes("has-filter"));
    bands()[1].dispatch("click");
    assert.deepEqual(changes.at(-1), []);

    // A lone course draws one fat arc instead of a thin ring.
    controller.update({ tasks: [task("solo", "canvas", { course: { id: "300", label: "Solo", code: "SOL", color: "#386641" } })] });
    const soloBands = Array.from(controller.getRoot().querySelectorAll("[data-progress-style='rainbow'] path[data-course-id]"));
    assert.equal(soloBands.length, 1, "one course draws one band");
    assert.equal(soloBands[0].getAttribute("stroke-width"), "28", "the single band widens into a fat arc");
    assert.equal(soloBands[0].getAttribute("stroke"), "#386641");
});

function rainbowFrame(root) {
    const svg = root.querySelector("[data-progress-style='rainbow']");
    const [, top, , height] = String(svg.getAttribute("viewBox")).split(" ").map(Number);
    const bands = Array.from(svg.querySelectorAll("path[data-course-id]"));
    const extents = bands.map((band) => {
        const radius = 80 - Number(String(band.getAttribute("d")).match(/^M ([\d.]+)/)[1]);
        const half = Number(band.getAttribute("stroke-width")) / 2;
        return { top: 134 - radius - half, bottom: 134 + half };
    });
    return {
        top,
        bottom: top + height,
        height,
        minTop: Math.min(...extents.map((extent) => extent.top)),
        maxBottom: Math.max(...extents.map((extent) => extent.bottom))
    };
}

test("the rainbow frame hugs its bands at every course count instead of reserving blank height", () => {
    const documentRef = new FakeDocument();
    const courseTasks = (count, offset = 400) => Array.from({ length: count }, (_, index) => task(`rb${index}`, "canvas", {
        course: { id: String(offset + index), label: `Course ${index}`, code: `R${index}`, color: "" },
        completion: false
    }));
    const controller = mountRail(documentRef, documentRef.createElement("div"), { tasks: courseTasks(1), settings: { todo_progress_style: "rainbow" } });
    for (const count of [1, 3, 8]) {
        controller.update({ tasks: courseTasks(count), settings: { todo_progress_style: "rainbow" } });
        const frame = rainbowFrame(controller.getRoot());
        // No clipping: every band, round caps included, sits inside the frame.
        assert.ok(frame.minTop >= frame.top && frame.maxBottom <= frame.bottom, `${count} bands stay inside the viewBox`);
        // No dead space: the frame hugs the drawn strokes with only the
        // authored two-unit breath on each side, at any course count.
        assert.ok(Math.abs(frame.top - (frame.minTop - 2)) <= 1.01, `${count} bands: the top edge hugs the outermost stroke`);
        assert.ok(Math.abs(frame.bottom - (frame.maxBottom + 2)) <= 1.01, `${count} bands: the bottom edge hugs the caps`);
        assert.ok(frame.height < 84, `${count} bands: the compact frame is tighter than the retired fixed 160/84 box`);
    }
});

test("course colors are authoritative, distinct, and stable across renders and remounts", () => {
    const documentRef = new FakeDocument();
    const courses = [
        { id: "101", label: "Biology", code: "BIOL" },
        { id: "102", label: "Chemistry", code: "CHEM", color: "" },
        { id: "103", label: "Japanese", code: "JPN", color: "rgb(127,134,198)" },
        { id: "104", label: "ECS", code: "ECS", color: "#008400" },
        { id: "105", label: "Health", code: "HLTH", color: "#4B244A" }
    ];
    const tasks = courses.map((course, index) => task(`cc${index}`, "canvas", {
        course: { id: course.id, label: course.label, code: course.code, color: course.color }
    }));
    const chipColor = (root, id) => root.querySelector(`.apstudy-todo-course-filter[data-course-id='${id}']`)?.style.getPropertyValue("--course-color");
    const controller = mountRail(documentRef, documentRef.createElement("div"), { tasks, courses });
    const root = controller.getRoot();
    // Authoritative Canvas colors win verbatim (normalized to lowercase hex);
    // null or non-hex colors never leak through as-is.
    assert.equal(chipColor(root, "104"), "#008400");
    assert.equal(chipColor(root, "105"), "#4b244a");
    // The three colorless courses get deterministic fallbacks that are
    // distinct from each other and never reuse an authoritative color on the
    // same displayed set (the retired index fallback tripled BIOL/CHEM/JPN).
    const fallbacks = ["101", "102", "103"].map((id) => chipColor(root, id));
    assert.equal(new Set([...fallbacks, "#008400", "#4b244a"]).size, 5, "displayed colors stay distinct unless the user assigned the same color");
    // Rows share the legend's resolved color — no per-row re-derivation.
    const rowColor = (index) => root.querySelector(`[data-task-id='cc${index}']`)?.style.getPropertyValue("--course-color");
    assert.equal(rowColor(0), fallbacks[0]);
    assert.equal(rowColor(3), "#008400");

    // Stability: an unrelated update re-renders the same resolved set, and a
    // full destroy+remount reproduces it from the same stable course ids.
    const snapshot = ["101", "102", "103", "104", "105"].map((id) => chipColor(root, id));
    controller.update({ settings: { todo_date_format: "relative" } });
    assert.deepEqual(["101", "102", "103", "104", "105"].map((id) => chipColor(controller.getRoot(), id)), snapshot, "rerenders keep the resolved colors");
    const remounted = mountRail(new FakeDocument(), documentRef.createElement("div"), { tasks: tasks.slice().reverse(), courses: courses.slice().reverse() });
    assert.deepEqual(["101", "102", "103", "104", "105"].map((id) => chipColor(remounted.getRoot(), id)), snapshot, "arrival order cannot change the resolved colors");

    // Two courses the user explicitly gave the same Canvas color stay the
    // same; the collision-avoided fallback still avoids that color.
    const duplicated = [
        { id: "201", label: "One", code: "ONE", color: "#b3261e" },
        { id: "202", label: "Two", code: "TWO", color: "#b3261e" },
        { id: "203", label: "Three", code: "THR" }
    ];
    const duplicateRail = mountRail(new FakeDocument(), documentRef.createElement("div"), {
        tasks: duplicated.map((course, index) => task(`dd${index}`, "canvas", { course })),
        courses: duplicated
    });
    const duplicateRoot = duplicateRail.getRoot();
    assert.equal(chipColor(duplicateRoot, "201"), "#b3261e");
    assert.equal(chipColor(duplicateRoot, "202"), "#b3261e", "explicit authoritative duplicates are the user's own choice");
    assert.notEqual(chipColor(duplicateRoot, "203"), "#b3261e");
    assert.ok(railApi.resolveCourseColors(duplicated).every((color) => /^#[0-9a-f]{3,8}$/.test(color)), "resolveCourseColors always yields usable hex");
});

test("many contributing courses rescale bar segments instead of spilling past the track", () => {
    const documentRef = new FakeDocument();
    const flood = [];
    for (let index = 0; index < 30; index += 1) flood.push(task(`s${index}`, "canvas", { course: { id: `s${index}`, label: `S${index}`, code: `S${index}`, color: "#1e6f68" }, completion: true }));
    for (let index = 0; index < 71; index += 1) flood.push(task(`b${index}`, "canvas", { course: { id: "big", label: "Big", code: "BIG", color: "#294d91" }, completion: true }));
    const controller = mountRail(documentRef, documentRef.createElement("div"), { tasks: flood, settings: { todo_progress_style: "bar" } });
    const root = controller.getRoot();
    const segments = root.querySelectorAll("rect[data-course-id]");
    assert.equal(segments.length, 31, "all 31 contributing courses keep a segment");
    let end = 8;
    segments.forEach((segment) => {
        const x = Number(segment.getAttribute("x"));
        const width = Number(segment.getAttribute("width"));
        assert.ok(x >= end - 0.001, "segments stack without overlap");
        end = x + width;
    });
    assert.ok(end <= 152.001, "the minimum-width floor rescales instead of overflowing the track");
});

test("the legend includes zero-completion courses in one deterministic order across refreshes", () => {
    const documentRef = new FakeDocument();
    const done = task("done", "canvas", { completion: true });
    const open = task("open", "canvas", { course: { id: "77", label: "Zebra studies", code: "ZEB", color: "#386641" } });
    // Both courses list under the default active scope: course 77 has an open
    // task, and course 42's finished task still counts as in-range work.
    const controller = mountRail(documentRef, documentRef.createElement("div"), { tasks: [done, open] });
    const ids = (root) => Array.from(root.querySelectorAll("button.apstudy-todo-course-filter")).map((chip) => chip.getAttribute("data-course-id"));
    assert.deepEqual(ids(controller.getRoot()), ["42", "77"], "the legend lists every course in stable identity order");
    const zebra = controller.getRoot().querySelector("button.apstudy-todo-course-filter[data-course-id='77']");
    assert.match(zebra.getAttribute("aria-label"), /0\/1 tasks complete/, "zero-completion courses stay listed with honest counts");
    assert.ok(controller.getRoot().querySelector("circle[data-course-id='77']"), "zero-completion courses keep a ring");

    // Arrival order never reorders arcs, segments, or legend chips.
    const flippedDocument = new FakeDocument();
    const flipped = mountRail(flippedDocument, flippedDocument.createElement("div"), { tasks: [open, done] });
    assert.deepEqual(ids(flipped.getRoot()), ["42", "77"], "task arrival order cannot reorder the legend");
    assert.deepEqual(flipped.getState().courses.map((course) => course.id), controller.getState().courses.map((course) => course.id), "the course model is identical regardless of arrival order");
});

test("the narrow header keeps one row: actions stay beside the title instead of an orphan second row", () => {
    const css = fs.readFileSync(path.join(__dirname, "../../css/todo-right-rail.css"), "utf8");
    const narrow = css.match(/@container \(max-width: 280px\)\s*\{([\s\S]*?)\n\}/);
    assert.ok(narrow, "the narrow container query exists");
    const block = narrow[1];
    assert.doesNotMatch(block, /flex-direction:\s*column/, "the header never stacks its actions into a second row");
    assert.match(block, /\.apstudy-todo-header \{[^}]*align-items:\s*center;/s, "the header stays one centered row");
    assert.match(block, /\.apstudy-todo-header h2 \{[^}]*text-overflow:\s*ellipsis;/s, "the title truncates instead of pushing actions out");
    assert.match(block, /\.apstudy-todo-sync-label \{\s*display:\s*none;\s*\}/, "Sync compacts to its icon while its aria-label keeps it accessible");
    assert.match(block, /\.apstudy-todo-settings \{[^}]*width:\s*32px;/s, "the gear stays on the shared row");
});
