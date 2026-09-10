"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const vm = require("node:vm");
const watchdog = require("../../js/content/sidebar-watchdog.js");

class ClassList {
    constructor(node) { this.node = node; }
    values() { return new Set(String(this.node.attributes.get("class") || "").split(/\s+/).filter(Boolean)); }
    write(values) { this.node.attributes.set("class", Array.from(values).join(" ")); }
    add(...names) { const values = this.values(); names.forEach((name) => values.add(name)); this.write(values); }
    remove(...names) { const values = this.values(); names.forEach((name) => values.delete(name)); this.write(values); }
    contains(name) { return this.values().has(name); }
}

class FakeNode {
    constructor(tagName = "div") {
        this.tagName = tagName.toUpperCase();
        this.nodeName = this.tagName;
        this.attributes = new Map();
        this.children = [];
        this.parentNode = null;
        this.classList = new ClassList(this);
        this.style = {
            values: new Map(),
            setProperty: (name, value) => this.style.values.set(name, String(value)),
            removeProperty: (name) => this.style.values.delete(name),
            getPropertyValue: (name) => this.style.values.get(name) || ""
        };
    }
    get id() { return this.getAttribute("id"); }
    set id(value) { this.setAttribute("id", value); }
    get isConnected() { return Boolean(this.parentNode) || this.tagName === "HTML"; }
    setAttribute(name, value) { this.attributes.set(String(name), String(value)); }
    getAttribute(name) { return this.attributes.get(String(name)) ?? null; }
    removeAttribute(name) { this.attributes.delete(String(name)); }
    appendChild(child) { if (child.parentNode) child.parentNode.removeChild(child); child.parentNode = this; this.children.push(child); return child; }
    removeChild(child) { const index = this.children.indexOf(child); if (index >= 0) this.children.splice(index, 1); child.parentNode = null; return child; }
    remove() { this.parentNode?.removeChild(this); }
    contains(node) { return this === node || this.children.some((child) => child.contains(node)); }
    matches(selector) {
        if (selector === "#nav-tray-portal .navigation-tray-container.courses-tray") {
            return this.parentNode?.id === "nav-tray-portal" && this.classList.contains("navigation-tray-container") && this.classList.contains("courses-tray");
        }
        if (selector === "body.with-left-side.course-menu-expanded #left-side.ic-app-course-menu") {
            const body = this.parentNode?.parentNode;
            return this.id === "left-side"
                && this.classList.contains("ic-app-course-menu")
                && body?.tagName === "BODY"
                && body.classList.contains("with-left-side")
                && body.classList.contains("course-menu-expanded");
        }
        if (selector.startsWith("#")) return this.id === selector.slice(1);
        if (selector.startsWith(".")) return this.classList.contains(selector.slice(1));
        if (selector.startsWith("[")) {
            const match = selector.match(/^\[([^=\]]+)(?:=['"]?([^\]'"]+)['"]?)?\]$/);
            return Boolean(match && this.attributes.has(match[1]) && (match[2] === undefined || this.getAttribute(match[1]) === match[2]));
        }
        return this.tagName.toLowerCase() === selector.toLowerCase();
    }
    querySelectorAll(selector) {
        const output = [];
        const visit = (node) => { node.children.forEach((child) => { if (child.matches(selector)) output.push(child); visit(child); }); };
        visit(this);
        return output;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

class FakeDocument extends FakeNode {
    constructor() {
        super("html");
        this.documentElement = this;
        this.body = new FakeNode("body");
        this.appendChild(this.body);
        this.visibilityState = "visible";
        this.listeners = new Map();
    }
    getElementById(id) { return [this, ...this.querySelectorAll(`#${id}`)].find((node) => node.id === id) || null; }
    addEventListener(type, callback) { const list = this.listeners.get(type) || []; list.push(callback); this.listeners.set(type, list); }
    removeEventListener(type, callback) { this.listeners.set(type, (this.listeners.get(type) || []).filter((item) => item !== callback)); }
    dispatch(type) { (this.listeners.get(type) || []).slice().forEach((callback) => callback()); }
}

function environment() {
    let now = 1000;
    const timers = new Map();
    let nextTimer = 1;
    const document = new FakeDocument();
    const native = new FakeNode("nav");
    native.id = "global_nav";
    native.classList.add("apstudycanvas-sidebar", "apstudycanvas-sidebar-hidden");
    native.setAttribute("data-apstudycanvas-sidebar-mounted", "1");
    document.body.appendChild(native);
    const root = new FakeNode("aside");
    root.id = watchdog.ROOT_ID;
    root.setAttribute(watchdog.MOUNTED_ATTRIBUTE, "1");
    document.body.appendChild(root);
    const wrapper = new FakeNode("main");
    wrapper.id = "wrapper";
    wrapper.classList.add("canvas-class-that-must-survive");
    wrapper.setAttribute("data-canvas-value", "preserve");
    wrapper.setAttribute(watchdog.MOUNTED_ATTRIBUTE, "1");
    document.body.appendChild(wrapper);
    const trayPortal = new FakeNode("div");
    trayPortal.id = "nav-tray-portal";
    const courseTray = new FakeNode("div");
    courseTray.classList.add("navigation-tray-container", "courses-tray", "canvas-course-tray-class");
    courseTray.setAttribute(watchdog.MOUNTED_ATTRIBUTE, "1");
    trayPortal.appendChild(courseTray);
    document.body.appendChild(trayPortal);
    document.body.classList.add("with-left-side", "course-menu-expanded");
    const columns = new FakeNode("div");
    columns.classList.add("ic-Layout-columns", "canvas-columns-class");
    columns.setAttribute(watchdog.MOUNTED_ATTRIBUTE, "1");
    const leftSide = new FakeNode("nav");
    leftSide.id = "left-side";
    leftSide.classList.add("ic-app-course-menu", "canvas-course-menu-class");
    leftSide.setAttribute(watchdog.MOUNTED_ATTRIBUTE, "1");
    columns.appendChild(leftSide);
    document.body.appendChild(columns);
    const win = {
        setInterval(callback) { const id = nextTimer++; timers.set(id, callback); return id; },
        clearInterval(id) { timers.delete(id); }
    };
    function beat(session = "session-a") {
        document.documentElement.setAttribute(watchdog.MOUNTED_ATTRIBUTE, "1");
        document.documentElement.setAttribute(watchdog.ACTIVE_ATTRIBUTE, "1");
        document.documentElement.setAttribute(watchdog.SESSION_ATTRIBUTE, session);
        document.documentElement.setAttribute(watchdog.HEARTBEAT_ATTRIBUTE, String(now));
    }
    return { document, native, root, wrapper, courseTray, columns, leftSide, win, beat, advance(amount) { now += amount; }, now: () => now, timers };
}

test("CommonJS loading is inert, while a browser-like script root may auto-install", () => {
    const modulePath = path.resolve(__dirname, "../../js/content/sidebar-watchdog.js");
    const result = spawnSync(process.execPath, ["-e", [
        "let intervals = 0;",
        "global.setInterval = () => { intervals += 1; return 1; };",
        "global.clearInterval = () => {};",
        "global.document = { documentElement: {}, getElementById() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; }, addEventListener() {}, removeEventListener() {} };",
        `require(${JSON.stringify(modulePath)});`,
        "if (intervals !== 0) process.exit(9);"
    ].join("\n")], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);

    const env = environment();
    const context = { document: env.document, setInterval: env.win.setInterval, clearInterval: env.win.clearInterval };
    context.globalThis = context;
    vm.runInNewContext(fs.readFileSync(modulePath, "utf8"), context, { filename: modulePath });
    assert.equal(env.timers.size, 1);
    const marker = context[watchdog.WATCHDOG_MARKER_SLOT];
    assert.equal(marker.version, watchdog.VERSION);
    assert.equal(typeof marker.check, "undefined");
    const descriptor = Object.getOwnPropertyDescriptor(context, watchdog.WATCHDOG_MARKER_SLOT);
    assert.equal(descriptor.writable, false);
    assert.equal(descriptor.configurable, false);
    assert.equal(Object.isFrozen(marker), true);
    assert.equal(env.timers.size, 1);
});

test("healthy heartbeat and session rollover never clean up an active rail", () => {
    const env = environment();
    env.beat();
    const service = watchdog.createSidebarWatchdog({ window: env.win, document: env.document, now: env.now, staleMs: 10000, visibleGraceMs: 3500 });
    service.start();
    env.advance(5000);
    env.beat();
    assert.equal(service.check(), false);
    env.advance(6000);
    env.beat("session-b");
    assert.equal(service.check(), false, "a quick extension reload rolls the session token without cleanup");
    assert.equal(env.document.getElementById(watchdog.ROOT_ID), env.root);
    assert.equal(service.cleanupCount(), 0);
    service.stop();
});

test("stale visible heartbeat cleans only APStudyCanvas-owned state after the grace interval", () => {
    const env = environment();
    env.beat();
    const recovery = new FakeNode("button"); recovery.id = watchdog.RECOVERY_ID; recovery.setAttribute(watchdog.MOUNTED_ATTRIBUTE, "1"); env.document.body.appendChild(recovery);
    const overlay = new FakeNode("div"); overlay.id = "apstudycanvas-overlay-root"; env.document.body.appendChild(overlay);
    const style = new FakeNode("style"); style.id = watchdog.LEGACY_LAYOUT_STYLE_ID; env.document.body.appendChild(style);
    env.document.documentElement.style.setProperty(watchdog.WIDTH_PROPERTY, "280px");
    const service = watchdog.createSidebarWatchdog({ window: env.win, document: env.document, now: env.now, staleMs: 10000, visibleGraceMs: 3500 });
    service.start();
    env.advance(10001);
    assert.equal(service.check(), true);
    assert.equal(env.document.getElementById(watchdog.ROOT_ID), null);
    assert.equal(env.document.getElementById(watchdog.RECOVERY_ID), null);
    assert.equal(env.document.getElementById("apstudycanvas-overlay-root"), overlay, "the independent settings overlay is outside watchdog ownership");
    assert.equal(env.document.getElementById(watchdog.LEGACY_LAYOUT_STYLE_ID), null);
    assert.equal(env.native.classList.contains("apstudycanvas-sidebar"), false);
    assert.equal(env.native.getAttribute(watchdog.MOUNTED_ATTRIBUTE), null);
    assert.equal(env.document.documentElement.style.getPropertyValue(watchdog.WIDTH_PROPERTY), "");
    assert.equal(env.wrapper.classList.contains("canvas-class-that-must-survive"), true);
    assert.equal(env.wrapper.getAttribute("data-canvas-value"), "preserve");
    assert.equal(env.wrapper.getAttribute(watchdog.MOUNTED_ATTRIBUTE), null);
    assert.equal(env.courseTray.getAttribute(watchdog.MOUNTED_ATTRIBUTE), null);
    assert.equal(env.courseTray.classList.contains("canvas-course-tray-class"), true);
    assert.equal(env.columns.getAttribute(watchdog.MOUNTED_ATTRIBUTE), null);
    assert.equal(env.columns.classList.contains("canvas-columns-class"), true);
    assert.equal(env.leftSide.getAttribute(watchdog.MOUNTED_ATTRIBUTE), null);
    assert.equal(env.leftSide.classList.contains("canvas-course-menu-class"), true);
    service.stop();
});

test("hidden tabs never clean up; visibility resumes a fresh conservative grace period", () => {
    const env = environment();
    env.beat();
    const service = watchdog.createSidebarWatchdog({ window: env.win, document: env.document, now: env.now, staleMs: 10000, visibleGraceMs: 3500 });
    service.start();
    env.document.visibilityState = "hidden";
    env.advance(60000);
    assert.equal(service.check(), false);
    assert.equal(env.document.getElementById(watchdog.ROOT_ID), env.root);
    env.document.visibilityState = "visible";
    env.document.dispatch("visibilitychange");
    env.advance(3499);
    assert.equal(service.check(), false);
    env.advance(2);
    assert.equal(service.check(), true);
    service.stop();
});

test("normal teardown clears the heartbeat, so the watchdog does not race it", () => {
    const env = environment();
    env.beat();
    const service = watchdog.createSidebarWatchdog({ window: env.win, document: env.document, now: env.now });
    service.start();
    env.document.documentElement.removeAttribute(watchdog.ACTIVE_ATTRIBUTE);
    env.document.documentElement.removeAttribute(watchdog.SESSION_ATTRIBUTE);
    env.document.documentElement.removeAttribute(watchdog.HEARTBEAT_ATTRIBUTE);
    env.advance(20000);
    assert.equal(service.check(), false);
    assert.equal(service.cleanupCount(), 0);
    assert.equal(env.document.getElementById(watchdog.ROOT_ID), env.root);
    service.stop();
});

test("page-main-world installation is singleton and idempotent", () => {
    const env = environment();
    const first = watchdog.installPageWatchdog({ window: env.win, document: env.document, now: env.now });
    const second = watchdog.installPageWatchdog({ window: env.win, document: env.document, now: env.now });
    assert.equal(second, first);
    assert.equal(env.timers.size, 1);
});

test("stale same-version page marker recovers from DOM liveness without exposing a controller", () => {
    const env = environment();
    const first = watchdog.installPageWatchdog({ window: env.win, document: env.document, now: env.now });
    assert.equal(env.timers.size, 1);
    env.timers.clear();
    env.advance(watchdog.WATCHDOG_LIVENESS_MS + 1);
    const recovered = watchdog.installPageWatchdog({ window: env.win, document: env.document, now: env.now });
    assert.equal(recovered, first);
    assert.equal(env.timers.size, 1, "a stale immutable marker does not block a replacement interval");
    assert.equal(typeof recovered.check, "undefined");
    assert.equal(Object.isFrozen(recovered), true);
});

test("missing, malformed, and future heartbeat evidence is bounded and cleans only owned state", () => {
    ["missing", "malformed", "future"].forEach((kind) => {
        const env = environment();
        if (kind !== "missing") env.document.documentElement.setAttribute(watchdog.SESSION_ATTRIBUTE, "session-a");
        if (kind === "malformed") env.document.documentElement.setAttribute(watchdog.HEARTBEAT_ATTRIBUTE, "not-a-time");
        if (kind === "future") env.document.documentElement.setAttribute(watchdog.HEARTBEAT_ATTRIBUTE, "999999");
        const unrelatedDialog = new FakeNode("div");
        unrelatedDialog.classList.add("popover");
        unrelatedDialog.setAttribute("role", "dialog");
        env.document.body.appendChild(unrelatedDialog);
        const service = watchdog.createSidebarWatchdog({
            window: env.win,
            document: env.document,
            now: env.now,
            visibleGraceMs: 0,
            unhealthyEvidenceMs: 15000
        });
        service.start();
        env.advance(14999);
        assert.equal(service.check(), false, `${kind} evidence retains the conservative unhealthy window`);
        env.advance(2);
        assert.equal(service.check(), true, `${kind} evidence is eventually recoverable`);
        assert.equal(env.document.getElementById(watchdog.ROOT_ID), null);
        assert.equal(unrelatedDialog.parentNode, env.document.body);
        service.stop();
    });
});

test("session-present heartbeat-missing evidence uses the conservative malformed window", () => {
    const env = environment();
    env.document.documentElement.setAttribute(watchdog.SESSION_ATTRIBUTE, "partial-session");
    env.document.documentElement.removeAttribute(watchdog.HEARTBEAT_ATTRIBUTE);
    const service = watchdog.createSidebarWatchdog({
        window: env.win,
        document: env.document,
        now: env.now,
        staleMs: 1000,
        visibleGraceMs: 0,
        unhealthyEvidenceMs: 15000
    });
    service.start();
    env.advance(1001);
    assert.equal(service.check(), false, "missing raw heartbeat does not become numeric zero and take the stale path");
    env.advance(14000);
    assert.equal(service.check(), true);
    assert.equal(service.cleanupCount(), 1);
    service.stop();
});

test("stale state is cleaned when the custom root is removed", () => {
    const env = environment();
    env.beat();
    env.root.remove();
    const service = watchdog.createSidebarWatchdog({ window: env.win, document: env.document, now: env.now, staleMs: 10000, visibleGraceMs: 0 });
    service.start();
    env.advance(10001);
    assert.equal(service.check(), true);
    assert.equal(env.native.classList.contains("apstudycanvas-sidebar-hidden"), false);
    assert.equal(env.document.documentElement.style.getPropertyValue(watchdog.WIDTH_PROPERTY), "");
    service.stop();
});

test("stale cleanup does not remove a replacement node with the old root id", () => {
    const env = environment();
    env.beat();
    env.root.remove();
    const replacement = new FakeNode("div");
    replacement.id = watchdog.ROOT_ID;
    env.document.body.appendChild(replacement);
    const service = watchdog.createSidebarWatchdog({ window: env.win, document: env.document, now: env.now, staleMs: 10000, visibleGraceMs: 0 });
    service.start();
    env.advance(10001);
    assert.equal(service.check(), true);
    assert.equal(env.document.getElementById(watchdog.ROOT_ID), replacement);
    service.stop();
});

test("watchdog communication and cleanup remain namespaced and source is page-world safe", () => {
    const source = fs.readFileSync(path.join(__dirname, "../../js/content/sidebar.js"), "utf8");
    assert.match(source, /data-apstudycanvas-sidebar-heartbeat/);
    assert.match(source, /data-apstudycanvas-sidebar-session/);
    assert.match(source, /function startHeartbeat/);
    assert.match(source, /function clearHeartbeat/);
    assert.match(source, /function persistPrepaintRecord/, "the controller records the rendered rail width for the next navigation");
    assert.match(source, /persistPrepaintRecord\(hidden \? 0 : width, runtimeState\)/);
    const pageSource = fs.readFileSync(path.join(__dirname, "../../js/content/sidebar-watchdog.js"), "utf8");
    assert.doesNotMatch(pageSource, /chrome\s*\./);
    assert.doesNotMatch(pageSource, /browser\s*\./);
    assert.match(pageSource, /win\?\.sessionStorage\?\./, "prepaint storage access stays behind guarded optional chaining");
    assert.match(pageSource, /apstudycanvas-sidebar-root/);
});

function stripOwnedEvidence(env) {
    env.native.classList.remove("apstudycanvas-sidebar", "apstudycanvas-sidebar-hidden");
    env.native.removeAttribute(watchdog.MOUNTED_ATTRIBUTE);
    env.root.remove();
    [env.wrapper, env.courseTray, env.columns, env.leftSide].forEach((node) => node.removeAttribute(watchdog.MOUNTED_ATTRIBUTE));
}

function sessionStorageStub(entries = []) {
    const store = new Map(entries);
    return {
        store,
        getItem: (key) => (store.has(key) ? store.get(key) : null),
        setItem: (key, value) => store.set(key, String(value)),
        removeItem: (key) => store.delete(key)
    };
}

test("prepaint replays the recorded rail width before first paint and clears it after the grace without a rail", () => {
    const env = environment();
    stripOwnedEvidence(env);
    const storage = sessionStorageStub([["apstudycanvas-sidebar-prepaint", JSON.stringify({ v: 1, width: 240, state: "expanded" })]]);
    env.win.sessionStorage = storage;
    const service = watchdog.createSidebarWatchdog({ window: env.win, document: env.document, now: env.now, prepaintGraceMs: 7000 });
    service.start();
    assert.equal(env.document.documentElement.getAttribute(watchdog.PREPAINT_ATTRIBUTE), "1");
    assert.equal(env.document.documentElement.style.getPropertyValue(watchdog.WIDTH_PROPERTY), "240px");
    assert.equal(storage.store.has(watchdog.PREPAINT_STORAGE_KEY), true, "the record is preserved for future navigations while healthy");
    env.advance(6999);
    assert.equal(service.check(), false, "the reservation survives the whole grace while no controller has mounted");
    assert.equal(env.document.documentElement.getAttribute(watchdog.PREPAINT_ATTRIBUTE), "1");
    env.advance(2);
    assert.equal(service.check(), false);
    assert.equal(env.document.documentElement.getAttribute(watchdog.PREPAINT_ATTRIBUTE), null, "the reservation is cleared once the controller never mounts");
    assert.equal(env.document.documentElement.style.getPropertyValue(watchdog.WIDTH_PROPERTY), "");
    assert.equal(storage.store.has(watchdog.PREPAINT_STORAGE_KEY), false, "a dead reservation cannot prepaint future navigations");
    service.stop();
});

test("prepaint stays in place once a real rail heartbeat appears", () => {
    const env = environment();
    stripOwnedEvidence(env);
    const storage = sessionStorageStub([["apstudycanvas-sidebar-prepaint", JSON.stringify({ v: 1, width: 260, state: "expanded" })]]);
    env.win.sessionStorage = storage;
    const service = watchdog.createSidebarWatchdog({ window: env.win, document: env.document, now: env.now });
    env.beat("session-prepaint");
    service.start();
    assert.equal(env.document.documentElement.getAttribute(watchdog.PREPAINT_ATTRIBUTE), "1");
    assert.equal(env.document.documentElement.style.getPropertyValue(watchdog.WIDTH_PROPERTY), "260px");
    env.advance(30000);
    env.beat("session-prepaint");
    assert.equal(service.check(), false, "a live heartbeat keeps the prepaint up");
    assert.equal(env.document.documentElement.getAttribute(watchdog.PREPAINT_ATTRIBUTE), "1");
    assert.equal(service.cleanupCount(), 0);
    service.stop();
});

test("malformed and out-of-range prepaint records never reserve the gutter", () => {
    [JSON.stringify({ v: 2, width: 240 }), JSON.stringify({ v: 1, width: 9999 }), JSON.stringify({ v: 1, width: "wide" }), "not-json"].forEach((record) => {
        const env = environment();
        stripOwnedEvidence(env);
        env.win.sessionStorage = sessionStorageStub([["apstudycanvas-sidebar-prepaint", record]]);
        const service = watchdog.createSidebarWatchdog({ window: env.win, document: env.document, now: env.now });
        service.start();
        assert.equal(env.document.documentElement.getAttribute(watchdog.PREPAINT_ATTRIBUTE), null);
        assert.equal(env.document.documentElement.style.getPropertyValue(watchdog.WIDTH_PROPERTY), "");
        assert.equal(service.cleanupCount(), 0);
        service.stop();
    });
});

test("a prepaint-only width is not mistaken for a live rail by ownership evidence", () => {
    const env = environment();
    stripOwnedEvidence(env);
    env.win.sessionStorage = sessionStorageStub([["apstudycanvas-sidebar-prepaint", JSON.stringify({ v: 1, width: 240, state: "expanded" })]]);
    const service = watchdog.createSidebarWatchdog({ window: env.win, document: env.document, now: env.now, prepaintGraceMs: 0 });
    service.start();
    env.advance(1);
    assert.equal(service.check(), false, "the grace path owns clearing the reservation");
    assert.equal(env.document.documentElement.getAttribute(watchdog.PREPAINT_ATTRIBUTE), null, "an expired reservation is cleaned through the grace path, not rail cleanup");
    assert.equal(service.cleanupCount(), 0);
    service.stop();
});
