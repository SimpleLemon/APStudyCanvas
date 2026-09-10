"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const lifecycle = require("../../js/content/lifecycle.js");
const canvasRegistration = require("../../js/platform/canvas-registration.js");

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

function percentile(samples, fraction) {
    const ordered = samples.slice().sort((left, right) => left - right);
    return ordered[Math.min(ordered.length - 1, Math.max(0, Math.ceil(ordered.length * fraction) - 1))];
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

test("owned sidebar mutations are ignored and each history/hash route event refreshes once", () => {
    const document = new FakeDocument();
    const window = makeWindow();
    const timers = makeTimers();
    const Observer = makeObserverClass();
    const refreshes = [];
    let callbackMutations = 0;
    const controller = lifecycle.createContentLifecycle({
        document, window, mutationObserver: Observer, setTimer: timers.setTimer, clearTimer: timers.clearTimer,
        onMutation: () => { callbackMutations += 1; return true; },
        onRefresh: (reason) => refreshes.push(reason)
    });
    controller.init();
    timers.flush();
    const observer = Observer.instances.at(-1);
    const owned = new FakeElement(); owned.setAttribute("id", "apstudycanvas-sidebar-root");
    observer.trigger([{ type: "childList", target: owned, addedNodes: [new FakeElement()] }]);
    assert.equal(callbackMutations, 0);
    assert.equal(timers.pending(), 0);
    const recovery = new FakeElement(); recovery.setAttribute("id", "apstudycanvas-sidebar-recovery");
    observer.trigger([{ type: "childList", target: recovery, addedNodes: [new FakeElement()] }]);
    const settings = new FakeElement(); settings.setAttribute("id", "apstudycanvas-overlay-root");
    observer.trigger([{ type: "childList", target: settings, addedNodes: [new FakeElement()] }]);
    const ownedChild = new FakeElement(); ownedChild.setAttribute("class", "apstudycanvas-sidebar-course-status");
    observer.trigger([{ type: "childList", target: ownedChild, removedNodes: [new FakeElement()] }]);
    assert.equal(callbackMutations, 0, "recovery, settings, and namespaced descendants are wholly lifecycle-owned");
    assert.equal(timers.pending(), 0, "owned UI render storms never schedule adapter work");
    document.documentElement.setAttribute("style", "--apstudy-sidebar-width:0px;");
    observer.trigger([{ type: "attributes", target: document.documentElement, attributeName: "style" }]);
    assert.equal(callbackMutations, 0);
    window.history.pushState({}, "", "/courses/2");
    timers.flush();
    window.dispatch("hashchange");
    timers.flush();
    assert.deepEqual(refreshes.filter((reason) => ["history", "hashchange"].includes(reason)), ["history", "hashchange"]);
    controller.dispose();
});

test("dashboard hydration follows the debounced refresh pipeline and dispose stays idempotent", () => {
    const document = new FakeDocument();
    const window = makeWindow();
    const timers = makeTimers();
    const Observer = makeObserverClass();
    const hydrations = [];
    const disposals = [];
    const controller = lifecycle.createContentLifecycle({
        document, window, mutationObserver: Observer,
        setTimer: timers.setTimer, clearTimer: timers.clearTimer,
        now: () => 1,
        onDashboardHydrate: (reason) => hydrations.push(reason),
        onDispose: ({ reason }) => disposals.push(reason)
    });
    controller.init();
    assert.equal(timers.pending(), 1, "initial start schedules one debounced hydration");
    timers.flush();
    assert.deepEqual(hydrations, ["init"]);

    const observer = Observer.instances.at(-1);
    observer.trigger();
    observer.trigger();
    observer.trigger([{ type: "childList" }, { type: "childList" }]);
    assert.equal(timers.pending(), 1, "relevant external mutations coalesce into one hydration");
    timers.flush();
    assert.deepEqual(hydrations, ["init", "mutation"]);

    const owned = new FakeElement(); owned.setAttribute("id", "apstudycanvas-sidebar-root");
    observer.trigger([{ type: "childList", target: owned, addedNodes: [new FakeElement()] }]);
    assert.equal(timers.pending(), 0, "lifecycle-owned mutations never schedule hydration");

    window.history.pushState({}, "", "/courses/2");
    timers.flush();
    assert.deepEqual(hydrations, ["init", "mutation", "history"]);
    window.dispatch("hashchange");
    timers.flush();
    assert.deepEqual(hydrations, ["init", "mutation", "history", "hashchange"]);

    controller.dispose();
    controller.dispose();
    assert.equal(controller.isDisposed(), true);
    assert.deepEqual(disposals, ["dispose"], "dispose is idempotent");
    observer.trigger();
    timers.flush();
    assert.deepEqual(hydrations, ["init", "mutation", "history", "hashchange"], "a disposed lifecycle never hydrates");
});

test("Canvas content scripts load sidebar dependencies before the controller and register its CSS", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../../manifest.json"), "utf8"));
    const canvasScript = manifest.content_scripts.find((entry) => entry.matches?.includes("https://canvas.emory.edu/*") && entry.js?.includes("js/content.js"));
    assert.ok(canvasScript);
    const scripts = canvasScript.js;
    assert.ok(scripts.indexOf("js/content/sidebar-model.js") >= 0);
    assert.ok(scripts.indexOf("js/content/sidebar-adapter.js") > scripts.indexOf("js/content/sidebar-model.js"));
    assert.ok(scripts.indexOf("js/content/sidebar.js") > scripts.indexOf("js/content/sidebar-adapter.js"));
    assert.ok(scripts.indexOf("js/content.js") > scripts.indexOf("js/content/sidebar.js"));
    assert.ok(canvasScript.css.includes("css/sidebar.css"));
    assert.equal(canvasScript.css.filter((entry) => entry === "css/sidebar.css").length, 1);
    assert.equal(canvasRegistration.CANVAS_CSS.filter((entry) => entry === "css/sidebar.css").length, 1);
    const sidebarSource = fs.readFileSync(path.join(__dirname, "../../js/content/sidebar.js"), "utf8");
    assert.doesNotMatch(sidebarSource, /createElement\(\s*["']link["']\s*\)/, "sidebar CSS has one manifest/runtime injection path");
    assert.doesNotMatch(sidebarSource, /rel\s*=\s*["']stylesheet["']/, "sidebar must not add a persistent stylesheet link");
});

test("dashboard initialization keeps Canvas-shaped lifecycle setup within the 50 ms initial-work budget", (t) => {
    // This models the production dashboard route before Canvas has inserted
    // its card grid: lifecycle owns setup, while the initial hydrate remains
    // debounced. Repeated samples make the time gate resistant to a lone
    // scheduler hiccup; exact setup counts are the deterministic companion.
    const samples = [];
    const setup = [];
    for (let index = 0; index < 24; index += 1) {
        const document = new FakeDocument();
        const window = makeWindow();
        window.location = { href: "https://canvas.emory.edu/", pathname: "/" };
        const chromeApi = makeChrome();
        const timers = makeTimers();
        const Observer = makeObserverClass();
        const started = process.hrtime.bigint();
        const controller = lifecycle.createContentLifecycle({
            document, window, chromeApi, mutationObserver: Observer,
            setTimer: timers.setTimer, clearTimer: timers.clearTimer,
            debounceMs: 16,
            onDashboardHydrate() {}
        });
        controller.init();
        samples.push(Number(process.hrtime.bigint() - started) / 1e6);
        setup.push({
            observers: Observer.instances.length,
            observerObserves: Observer.instances[0]?.observeCalls || 0,
            storageListeners: chromeApi.listeners.length,
            windowListeners: [...window.listeners.values()].reduce((total, listeners) => total + listeners.length, 0),
            pendingRefreshes: timers.pending()
        });
        controller.dispose();
    }
    const p95 = percentile(samples, 0.95);
    assert.ok(p95 <= 50, `dashboard lifecycle setup p95 ${p95.toFixed(3)} ms exceeds the 50 ms initial-work budget`);
    setup.forEach((entry) => assert.deepEqual(entry, {
        observers: 1,
        observerObserves: 1,
        storageListeners: 1,
        windowListeners: 5,
        pendingRefreshes: 1
    }, "one observer, one storage hook, five route/page hooks, and one deferred hydrate bound setup work"));
    t.diagnostic(`dashboard-init samples=${samples.length} p50=${percentile(samples, 0.5).toFixed(3)}ms p95=${p95.toFixed(3)}ms node=${process.version} platform=${process.platform}/${process.arch}`);
});
