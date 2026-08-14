"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const lifecycle = require("../../js/content/lifecycle.js");

class FakeElement {
    constructor() { this.attributes = new Map(); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    removeAttribute(name) { this.attributes.delete(name); }
}

class FakeDocument {
    constructor() { this.documentElement = new FakeElement(); }
}

function makeWindow() {
    const listeners = new Map();
    const history = {
        pushState(...args) { this.lastPush = args; },
        replaceState(...args) { this.lastReplace = args; }
    };
    return {
        location: { href: "https://canvas.example/courses/1", pathname: "/courses/1" },
        history,
        listeners,
        addEventListener(type, listener) {
            const values = listeners.get(type) || [];
            values.push(listener);
            listeners.set(type, values);
        },
        removeEventListener(type, listener) {
            listeners.set(type, (listeners.get(type) || []).filter((candidate) => candidate !== listener));
        },
        dispatch(type, event = {}) { (listeners.get(type) || []).slice().forEach((listener) => listener(event)); }
    };
}

function makeChrome() {
    const listeners = [];
    return {
        listeners,
        storage: {
            onChanged: {
                addListener(listener) { listeners.push(listener); },
                removeListener(listener) {
                    const index = listeners.indexOf(listener);
                    if (index >= 0) listeners.splice(index, 1);
                }
            }
        }
    };
}

function makeTimers() {
    let nextId = 1;
    const timers = new Map();
    return {
        setTimer(callback) { const id = nextId++; timers.set(id, callback); return id; },
        clearTimer(id) { timers.delete(id); },
        flush() { const pending = Array.from(timers.values()); timers.clear(); pending.forEach((callback) => callback()); },
        pending() { return timers.size; }
    };
}

function makeObserverClass() {
    const instances = [];
    class FakeObserver {
        constructor(callback) { this.callback = callback; this.observeCalls = 0; this.disconnectCalls = 0; instances.push(this); }
        observe() { this.observeCalls += 1; }
        disconnect() { this.disconnectCalls += 1; }
        trigger(records = [{ type: "childList" }]) { this.callback(records); }
    }
    FakeObserver.instances = instances;
    return FakeObserver;
}

test("lifecycle has one controller/listener/observer, debounces route and bounded mutation refreshes", () => {
    const document = new FakeDocument();
    const window = makeWindow();
    const chromeApi = makeChrome();
    const timers = makeTimers();
    const Observer = makeObserverClass();
    let clock = 1;
    const routes = [];
    const refreshes = [];
    let mutations = 0;
    const controller = lifecycle.createContentLifecycle({
        document, window, chromeApi,
        mutationObserver: Observer,
        setTimer: timers.setTimer,
        clearTimer: timers.clearTimer,
        now: () => clock++,
        debounceMs: 10,
        maxMutationRefreshes: 8,
        onRoute: (event) => routes.push(event),
        onRefresh: (reason) => refreshes.push(reason),
        onMutation: () => { mutations += 1; return mutations > 1; }
    });
    assert.equal(lifecycle.createContentLifecycle({ document, window, chromeApi }), controller);
    controller.init();
    controller.init();
    assert.equal(document.documentElement.getAttribute(lifecycle.MARKER), "1");
    assert.equal(chromeApi.listeners.length, 1);
    assert.equal(Observer.instances.length, 1);
    assert.equal(Observer.instances[0].observeCalls, 1);
    timers.flush();
    assert.deepEqual(refreshes, ["init"]);

    Observer.instances[0].trigger();
    assert.equal(timers.pending(), 0, "a mutation reported as irrelevant does not schedule refresh");
    for (let index = 0; index < 12; index += 1) Observer.instances[0].trigger();
    assert.ok(timers.pending() <= 1, "mutation refreshes are debounced");
    timers.flush();
    assert.equal(refreshes.filter((reason) => reason === "mutation").length, 1);

    window.history.pushState({}, "", "/courses/2");
    timers.flush();
    assert.equal(routes.length, 1);
    assert.equal(routes[0].reason, "history");
    assert.equal(refreshes.at(-1), "history");
});

test("bfcache pauses without destructive disposal, resumes once, and non-persisted teardown disposes exactly once", () => {
    const document = new FakeDocument();
    const window = makeWindow();
    const chromeApi = makeChrome();
    const timers = makeTimers();
    const Observer = makeObserverClass();
    const events = [];
    const controller = lifecycle.createContentLifecycle({
        document, window, chromeApi, mutationObserver: Observer,
        setTimer: timers.setTimer, clearTimer: timers.clearTimer,
        onPause: ({ reason }) => events.push(`pause:${reason}`),
        onResume: ({ reason }) => events.push(`resume:${reason}`),
        onDispose: ({ reason }) => events.push(`dispose:${reason}`)
    });
    controller.init();
    timers.flush();
    window.dispatch("pagehide", { persisted: true });
    window.dispatch("pagehide", { persisted: true });
    assert.deepEqual(events, ["pause:bfcache"]);
    assert.equal(controller.isPaused(), true);
    assert.equal(document.documentElement.getAttribute(lifecycle.MARKER), "1");
    assert.equal(Observer.instances[0].disconnectCalls, 1);

    window.dispatch("pageshow", { persisted: true });
    window.dispatch("pageshow", { persisted: true });
    timers.flush();
    assert.deepEqual(events, ["pause:bfcache", "resume:bfcache"]);
    assert.equal(controller.isPaused(), false);

    window.dispatch("pagehide", { persisted: false });
    window.dispatch("unload");
    assert.deepEqual(events, ["pause:bfcache", "resume:bfcache", "dispose:pagehide"]);
    assert.equal(document.documentElement.getAttribute(lifecycle.MARKER), null);
    assert.equal(chromeApi.listeners.length, 0);
    assert.equal(controller.isDisposed(), true);

    const replacement = lifecycle.createContentLifecycle({ document, window, chromeApi });
    assert.notEqual(replacement, controller, "teardown releases the document owner");
    replacement.dispose();
});

test("storage dispatches once and duplicate initialization never adds competing lifecycle markers", () => {
    const document = new FakeDocument();
    const window = makeWindow();
    const chromeApi = makeChrome();
    const changes = [];
    const controller = lifecycle.createContentLifecycle({ document, window, chromeApi, onStorageChange: (value, area) => changes.push({ value, area }) });
    controller.init();
    chromeApi.listeners[0]({ sidebar_scale: { newValue: 110 } }, "sync");
    assert.deepEqual(changes, [{ value: { sidebar_scale: { newValue: 110 } }, area: "sync" }]);
    assert.equal(window.listeners.get("popstate").length, 1);
    assert.equal(window.listeners.get("pagehide").length, 1);
    controller.dispose();
});

test("missing expected navigation stays on one debounced, bounded retry path", () => {
    const document = new FakeDocument();
    const window = makeWindow();
    const timers = makeTimers();
    const Observer = makeObserverClass();
    let refreshes = 0;
    const controller = lifecycle.createContentLifecycle({
        document, window, mutationObserver: Observer,
        setTimer: timers.setTimer, clearTimer: timers.clearTimer,
        now: () => 0, maxMutationRefreshes: 2, mutationWindowMs: 1000,
        onMutation: () => true, onRefresh: (reason) => { if (reason === "mutation") refreshes += 1; }
    });
    controller.init();
    timers.flush();
    for (let index = 0; index < 10; index += 1) Observer.instances.at(-1).trigger([{ type: "childList" }]);
    assert.equal(timers.pending(), 1, "one pending retry survives the mutation burst");
    timers.flush();
    assert.equal(refreshes, 1, "the bounded burst still invokes one debounced refresh");
    controller.dispose();
});
