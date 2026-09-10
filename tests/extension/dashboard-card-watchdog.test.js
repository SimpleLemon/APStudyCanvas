"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const watchdogApi = require("../../js/content/dashboard-card-watchdog.js");
const registration = require("../../js/platform/canvas-registration.js");

const root = path.resolve(__dirname, "../..");
const contentSource = fs.readFileSync(path.join(root, "js/content.js"), "utf8");

function makeTimers() {
    let nextId = 1;
    const callbacks = new Map();
    return {
        setTimer(callback) { const id = nextId++; callbacks.set(id, callback); return id; },
        clearTimer(id) { callbacks.delete(id); },
        flush() { const pending = Array.from(callbacks.values()); callbacks.clear(); pending.forEach((callback) => callback()); },
        pending() { return callbacks.size; }
    };
}

function makeObserverClass() {
    const instances = [];
    class Observer {
        constructor(callback) { this.callback = callback; this.disconnectCalls = 0; instances.push(this); }
        observe(target, options) { this.target = target; this.options = options; }
        disconnect() { this.disconnectCalls += 1; }
        trigger(records = [{ type: "childList", addedNodes: [{}] }]) { this.callback(records); }
    }
    Observer.instances = instances;
    return Observer;
}

function makeDocument() {
    let cards = [];
    let dashboardRoot = null;
    const document = {
        documentElement: {},
        querySelectorAll(selector) { return selector === ".ic-DashboardCard" ? cards.slice() : []; },
        querySelector(selector) { return selector === "#DashboardCard_Container" ? dashboardRoot : null; }
    };
    return {
        document,
        setCards(value) { cards = value; },
        setRoot({ nativeLoading = false } = {}) {
            dashboardRoot = {
                querySelector(selector) {
                    return nativeLoading && selector.includes("DashboardCard") ? {} : null;
                }
            };
        },
        clearRoot() { dashboardRoot = null; }
    };
}

function setup() {
    const fixture = makeDocument();
    const timers = makeTimers();
    const Observer = makeObserverClass();
    const reports = [];
    const watchdog = watchdogApi.createDashboardCardWatchdog({
        document: fixture.document,
        mutationObserver: Observer,
        setTimer: timers.setTimer,
        clearTimer: timers.clearTimer,
        isBlockingEnabled: () => true,
        onTerminal: (event) => reports.push(event)
    });
    return { fixture, timers, Observer, reports, watchdog };
}

test("delayed Canvas hydration settles a bounded dashboard watch without failing open", () => {
    const { fixture, timers, Observer, reports, watchdog } = setup();
    watchdog.reconcile("/");
    assert.equal(timers.pending(), 1);
    fixture.setRoot({ nativeLoading: true });
    fixture.setCards([{}]);
    Observer.instances[0].trigger();
    assert.equal(watchdog.isActive(), false);
    assert.equal(timers.pending(), 0);
    timers.flush();
    assert.deepEqual(reports, []);
});

test("a replaced Canvas dashboard root is checked at the terminal boundary, not its first mount", () => {
    const { fixture, timers, Observer, reports, watchdog } = setup();
    fixture.setRoot({ nativeLoading: true });
    watchdog.reconcile("/");
    fixture.setRoot({ nativeLoading: true });
    Observer.instances[0].trigger();
    fixture.setCards([{}]);
    Observer.instances[0].trigger();
    timers.flush();
    assert.deepEqual(reports, []);
    assert.equal(Observer.instances[0].disconnectCalls, 1);
});

test("other-extension mutations neither report nor create additional timers or observers", () => {
    const { timers, Observer, reports, watchdog } = setup();
    watchdog.reconcile("/");
    for (let index = 0; index < 40; index += 1) Observer.instances[0].trigger([{ type: "childList", addedNodes: [{ className: "other-extension" }] }]);
    assert.equal(Observer.instances.length, 1);
    assert.equal(timers.pending(), 1);
    timers.flush();
    assert.deepEqual(reports, [], "without a Canvas native loading shell, arbitrary DOM is not incompatibility evidence");
});

test("route leave cancels observation and dashboard re-entry receives one fresh bounded watch", () => {
    const { fixture, timers, Observer, reports, watchdog } = setup();
    fixture.setRoot({ nativeLoading: true });
    watchdog.reconcile("/");
    watchdog.reconcile("/courses/42");
    assert.equal(watchdog.isActive(), false);
    assert.equal(timers.pending(), 0);
    watchdog.reconcile("/dashboard");
    assert.equal(Observer.instances.length, 2);
    fixture.setCards([{}]);
    Observer.instances[1].trigger();
    timers.flush();
    assert.deepEqual(reports, []);
});

test("only a persistent native Canvas loading shell reports, and it reports once", () => {
    const { fixture, timers, Observer, reports, watchdog } = setup();
    fixture.setRoot({ nativeLoading: true });
    watchdog.reconcile("/");
    timers.flush();
    assert.equal(reports.length, 1);
    assert.equal(watchdog.wasReported(), true);
    watchdog.reconcile("/");
    assert.equal(Observer.instances.length, 1, "terminal result is session-one-shot");
    assert.equal(timers.pending(), 0);
});

test("dispose clears the only timer and observer", () => {
    const { timers, Observer, watchdog } = setup();
    watchdog.reconcile("/");
    watchdog.dispose();
    assert.equal(timers.pending(), 0);
    assert.equal(watchdog.hasObserver(), false);
    assert.equal(Observer.instances[0].disconnectCalls, 1);
});

test("production bootstrap uses the watchdog and keeps static/dynamic script order aligned", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
    const scripts = manifest.content_scripts[1].js;
    const file = "js/content/dashboard-card-watchdog.js";
    assert.deepEqual(scripts, registration.CANVAS_CONTENT_SCRIPTS);
    assert.ok(scripts.indexOf(file) > scripts.indexOf("js/content/card-appearance.js"));
    assert.ok(scripts.indexOf(file) < scripts.indexOf("js/content.js"));
    assert.match(contentSource, /ensureDashboardScriptBlockWatchdog\(\)\?\.reconcile\?\.\(current_page \|\| window\.location\.pathname\)/);
    assert.match(contentSource, /dashboardScriptBlockWatchdog\?\.reconcile\?\.\(current_page\)/);
    assert.match(contentSource, /dashboardScriptBlockWatchdog\?\.dispose\?\.\(\)/);
    assert.doesNotMatch(contentSource, /dashboardScriptBlockFailSafeScheduled/);
    assert.match(contentSource, /return options\?\.block_editor_scripts === true;/, "a missing retired planner setting cannot keep the watchdog active");
    assert.doesNotMatch(contentSource, /block_editor_scripts !== false \|\| options\?\.block_planner_script !== false/);
});
