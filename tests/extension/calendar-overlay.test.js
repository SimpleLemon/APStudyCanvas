"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const overlay = require("../../js/content/calendar-overlay.js");

const root = path.resolve(__dirname, "../..");
const ORIGIN = "https://canvas.example.edu";
const RANGE = { start: "2026-08-01T00:00:00.000Z", end: "2026-08-08T00:00:00.000Z" };
const ARTIFACT_JS = "js/content/calendar-extension/calendar-extension.v1.js";
const ARTIFACT_CSS = "js/content/calendar-extension/calendar-extension.v1.css";

class FakeElement {
    constructor(tagName = "div") {
        this.nodeType = 1;
        this.tagName = tagName.toUpperCase();
        this.attributes = new Map();
        this.children = [];
        this.parentNode = null;
        this.isConnected = true;
        this.style = { cssText: "" };
        this.className = "";
        this.hidden = false;
        this.ariaHidden = "";
        this.inert = false;
        this.textContent = "";
    }
    get id() { return this.getAttribute("id") || ""; }
    set id(value) { this.setAttribute("id", value); }
    get nextSibling() {
        const index = this.parentNode?.children.indexOf(this) ?? -1;
        return index >= 0 ? this.parentNode.children[index + 1] || null : null;
    }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    removeAttribute(name) { this.attributes.delete(name); }
    insertBefore(node, reference) {
        if (node.parentNode) node.parentNode.removeChild(node);
        const index = reference ? this.children.indexOf(reference) : -1;
        node.parentNode = this;
        node.isConnected = this.isConnected;
        if (index < 0) this.children.push(node);
        else this.children.splice(index, 0, node);
        return node;
    }
    appendChild(node) { return this.insertBefore(node, null); }
    removeChild(node) {
        const index = this.children.indexOf(node);
        if (index >= 0) this.children.splice(index, 1);
        node.parentNode = null;
        node.isConnected = false;
        return node;
    }
    querySelector(selector) {
        if (selector === `[${overlay.READY_CONTENT_MARKER}="${overlay.READY_MARKER_VALUE}"]` && this.getAttribute(overlay.READY_CONTENT_MARKER) === overlay.READY_MARKER_VALUE) return this;
        for (const child of this.children) {
            if (selector === `[${overlay.READY_CONTENT_MARKER}="${overlay.READY_MARKER_VALUE}"]` && child.getAttribute(overlay.READY_CONTENT_MARKER) === overlay.READY_MARKER_VALUE) return child;
            const result = child.querySelector?.(selector);
            if (result) return result;
        }
        return null;
    }
    querySelectorAll(selector) {
        const matches = [];
        const visit = (node) => {
            if (selector === `[${overlay.READY_CONTENT_MARKER}="${overlay.READY_MARKER_VALUE}"]` && node.getAttribute(overlay.READY_CONTENT_MARKER) === overlay.READY_MARKER_VALUE) matches.push(node);
            node.children.forEach(visit);
        };
        this.children.forEach(visit);
        return matches;
    }
}

class FakeDocument {
    constructor() {
        this.nodeType = 9;
        this.documentElement = new FakeElement("html");
        this.body = new FakeElement("body");
        this.documentElement.appendChild(this.body);
        this.anchor = new FakeElement("main");
        this.anchor.id = "calendar-app";
        this.body.appendChild(this.anchor);
    }
    createElement(tagName) { return new FakeElement(tagName); }
    querySelector(selector) { return selector.includes("calendar-app") ? this.anchor : null; }
    getElementById(id) {
        const visit = (node) => {
            if (node.id === id) return node;
            for (const child of node.children) {
                const result = visit(child);
                if (result) return result;
            }
            return null;
        };
        return visit(this.documentElement);
    }
}

function makeWindow(pathname = "/calendar") {
    const listeners = new Map();
    const observers = [];
    return {
        location: { protocol: "https:", host: "canvas.example.edu", origin: ORIGIN, pathname, hash: "", href: `${ORIGIN}${pathname}` },
        crypto: { randomUUID: () => "request-id" },
        MutationObserver: class {
            constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this); }
            observe() {}
            disconnect() { this.disconnected = true; }
            trigger() { if (!this.disconnected) this.callback(); }
        },
        addEventListener(type, listener) { listeners.set(type, [...(listeners.get(type) || []), listener]); },
        removeEventListener(type, listener) { listeners.set(type, (listeners.get(type) || []).filter((candidate) => candidate !== listener)); },
        dispatch(type, event = {}) { (listeners.get(type) || []).slice().forEach((listener) => listener(event)); },
        listenerCount(type) { return (listeners.get(type) || []).length; },
        observers
    };
}

function makeHarness({ mode = "overlay", flags = { projection: true, overlay: true }, pathname = "/calendar", context, artifact, response = { contractVersion: 1, ok: true, events: [], sources: [] }, pending = false, replacementReady = false } = {}) {
    const document = new FakeDocument();
    const window = makeWindow(pathname);
    if (replacementReady) {
        flags = { ...flags, replacement: true, [overlay.REPLACEMENT_PARITY_FLAG]: { version: overlay.REPLACEMENT_PARITY_VERSION, ready: true } };
    }
    const messages = [];
    const pendingSignals = [];
    const runtime = {
        sendMessage(message, callback) {
            messages.push(message);
            if (pending) {
                return new Promise((resolve, reject) => {
                    const signal = arguments[2];
                    pendingSignals.push({ resolve, reject, signal });
                });
            }
            const result = typeof response === "function" ? response(message) : { payload: response };
            callback?.(result);
            return Promise.resolve(result);
        }
    };
    const chromeApi = { runtime };
    const mounted = [];
    const defaultArtifact = artifact || {
        contractVersion: 1,
        ...(replacementReady ? { [overlay.REPLACEMENT_PARITY_FLAG]: { version: overlay.REPLACEMENT_PARITY_VERSION, ready: true } } : {}),
        createCalendarDataAdapter() { return {}; },
        mountCalendar(rootNode, adapter, capabilities) {
            mounted.push({ rootNode, adapter, capabilities });
            if (capabilities.mode === "replace") {
                rootNode.setAttribute(overlay.READY_MARKER, overlay.READY_MARKER_VALUE);
                rootNode.setAttribute(overlay.READY_CONTENT_MARKER, overlay.READY_MARKER_VALUE);
            }
            return () => { mounted.at(-1).disposed = true; };
        }
    };
    const controller = overlay.createCalendarOverlayController({
        window,
        document,
        chromeApi,
        getMode: () => mode,
        getFlags: () => flags,
        getContext: () => context || { ok: true, state: "connected", origin: ORIGIN, canvasUser: { id: "canvas-user" } },
        getArtifact: () => defaultArtifact,
        anchorTimeoutMs: 100,
        anchorStableMs: 0,
        now: () => Date.parse("2026-08-01T12:00:00.000Z")
    });
    return { controller, document, window, messages, mounted, pendingSignals, defaultArtifact, flags };
}

test("vendored artifact JS/CSS preserve the exact manifest hash contract in Chromium and Firefox packages", () => {
    const artifactManifest = JSON.parse(fs.readFileSync(path.join(root, "js/content/calendar-extension/manifest.json"), "utf8"));
    assert.equal(artifactManifest.contract_version, 1);
    assert.deepEqual(artifactManifest.files.map((entry) => entry.filename), ["calendar-extension.v1.js", "calendar-extension.v1.css"]);
    for (const entry of artifactManifest.files) {
        const source = fs.readFileSync(path.join(root, "js/content/calendar-extension", entry.filename));
        assert.equal(crypto.createHash("sha256").update(source).digest("hex"), entry.sha256, entry.filename);
        assert.deepEqual(source, fs.readFileSync(path.join(root, "dist/firefox/js/content/calendar-extension", entry.filename)));
    }
    const chromium = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8")).content_scripts[0];
    const firefox = JSON.parse(fs.readFileSync(path.join(root, "dist/firefox/manifest.json"), "utf8")).content_scripts[0];
    assert.deepEqual(firefox.js, chromium.js);
    assert.deepEqual(firefox.css, chromium.css);
    assert.deepEqual(chromium.js.slice(-3), [ARTIFACT_JS, "js/content/calendar-overlay.js", "js/content.js"]);
    assert.deepEqual(chromium.css, ["css/content.css", ARTIFACT_CSS]);
});

test("vendored artifact exposes the v1 mount contract without changing its bytes", () => {
    const source = fs.readFileSync(path.join(root, ARTIFACT_JS), "utf8");
    const context = vm.createContext({ console, document: { addEventListener() {}, removeEventListener() {} }, addEventListener() {}, setTimeout, clearTimeout });
    context.globalThis = context;
    context.window = context;
    vm.runInContext(source, context, { filename: ARTIFACT_JS });
    assert.equal(context.APStudyCalendarExtension.contractVersion, 1);
    assert.equal(typeof context.APStudyCalendarExtension.mountCalendar, "function");
    assert.equal(typeof context.APStudyCalendarExtension.createCalendarDataAdapter, "function");
});

test("off is the default and replace is treated as disabled", async () => {
    const off = makeHarness({ mode: null });
    assert.deepEqual(await off.controller.init(), { state: "off", mode: "off" });
    assert.equal(off.mounted.length, 0);
    const replace = makeHarness({ mode: "replace" });
    assert.deepEqual((await replace.controller.init()), { state: "off", mode: "replace", code: "CALENDAR_REPLACEMENT_PARITY_NOT_READY" });
    assert.equal(replace.mounted.length, 0);
});

test("exact /calendar route, verified origin/account, and gate failure prevent unsafe mount", async () => {
    const mismatch = makeHarness({ pathname: "/calendar", context: { ok: true, state: "verified", origin: "https://other.example.edu", userId: "canvas-user" } });
    assert.equal((await mismatch.controller.init()).state, "off-route");
    assert.equal(mismatch.mounted.length, 0);

    const wrongPath = makeHarness({ pathname: "/calendar/" });
    assert.equal((await wrongPath.controller.init()).state, "off-route");
    assert.equal(wrongPath.mounted.length, 0);

    const gate = makeHarness({ flags: { projection: true, overlay: false } });
    const gateResult = await gate.controller.init();
    assert.equal(gateResult.code, "FEATURE_DISABLED_OVERLAY");
    assert.equal(gate.mounted.length, 0);
});

test("bounded readiness range mounts once, preserves native DOM, and refreshes the last safe range", async () => {
    const harness = makeHarness();
    const nativeChildren = harness.document.body.children.slice();
    const result = await harness.controller.init();
    assert.equal(result.state, "mounted");
    assert.equal(harness.mounted.length, 1);
    assert.deepEqual(harness.document.body.children.filter((node) => node !== harness.document.anchor), [harness.mounted[0].rootNode]);
    assert.equal(harness.document.anchor.parentNode, harness.document.body);
    assert.deepEqual(harness.document.body.children.filter((node) => node === harness.document.anchor), nativeChildren);
    assert.equal(harness.mounted[0].rootNode.getAttribute(overlay.ROOT_MARKER), "1");
    assert.equal(harness.document.getElementById(overlay.ROOT_ID), harness.mounted[0].rootNode);

    assert.equal(harness.messages.length, 1);
    assert.equal(harness.messages[0].type, "NEST_CALENDAR_RANGE_GET");
    assert.equal(harness.messages[0].version, 1);
    assert.deepEqual(Object.keys(harness.messages[0].payload), ["start", "end"]);
    assert.ok(Date.parse(harness.messages[0].payload.end) - Date.parse(harness.messages[0].payload.start) <= 7 * 24 * 60 * 60 * 1000);

    await harness.mounted[0].adapter.loadRange({ range: RANGE });
    await harness.mounted[0].adapter.refresh();
    assert.equal(harness.messages.length, 3);
    assert.deepEqual(harness.messages.at(-1).payload, RANGE);
    assert.deepEqual(harness.mounted[0].capabilities.actionSupport, { routeDisplayOverride: false, retryWriteback: false, openSourceUrl: false });
});

test("adapter exposes only read-only loading defaults and no mutation/share/source/writeback operations", async () => {
    const harness = makeHarness();
    await harness.controller.init();
    const adapter = harness.mounted[0].adapter;
    for (const method of ["loadPreferences", "loadCourses", "loadCourseSectionsById", "loadShares"]) assert.equal(typeof adapter[method], "function");
    for (const method of ["savePreferences", "saveShare", "createEvent", "updateEvent", "deleteEvent", "saveSource", "setCanvasRouting", "setDisplayOverride", "retryWriteback", "openSafeSourceUrl"]) assert.equal(method in adapter, false, method);
    assert.deepEqual(await adapter.loadPreferences(), { response: { ok: true, status: 200 }, payload: { preferences: [] } });
    assert.deepEqual((await adapter.loadShares()).payload, { shares: [] });
    assert.equal(harness.mounted[0].capabilities.mutation, false);
    assert.equal(harness.mounted[0].capabilities.readOnly, true);
});

test("contract mismatch, range failure, abort, dispose, and repeated navigation never leave a mount behind", async () => {
    const mismatch = makeHarness({ artifact: { contractVersion: 2, mountCalendar() {}, createCalendarDataAdapter() {} } });
    assert.equal((await mismatch.controller.init()).state, "error");
    assert.equal(mismatch.mounted.length, 0);

    const failure = makeHarness({ response: { contractVersion: 1, ok: false, code: "NEST_CALENDAR_RANGE_UNAVAILABLE" } });
    assert.equal((await failure.controller.init()).state, "error");
    assert.equal(failure.mounted.length, 0);

    const repeated = makeHarness();
    await repeated.controller.init();
    await repeated.controller.route({ path: "/calendar", href: `${ORIGIN}/calendar` });
    await repeated.controller.route({ path: "/calendar", href: `${ORIGIN}/calendar` });
    assert.equal(repeated.mounted.length, 1);
    repeated.controller.dispose("test-dispose");
    assert.equal(repeated.document.getElementById(overlay.ROOT_ID), null);
    assert.equal(repeated.mounted[0].disposed, true);
    assert.equal(repeated.controller.getState().state, "disposed");

    const pending = makeHarness({ pending: true });
    const initPromise = pending.controller.init();
    await new Promise((resolve) => setImmediate(resolve));
    pending.controller.route({ path: "/courses/1", href: `${ORIGIN}/courses/1` });
    const aborted = await initPromise;
    assert.ok(aborted.state === "aborted" || aborted.state === "off-route");
    assert.equal(pending.mounted.length, 0);
});

test("replacement never hides native Canvas before the readiness marker/content check", async () => {
    const artifact = {
        contractVersion: 1,
        [overlay.REPLACEMENT_PARITY_FLAG]: { version: overlay.REPLACEMENT_PARITY_VERSION, ready: true },
        createCalendarDataAdapter() { return {}; },
        mountCalendar() { return () => {}; }
    };
    const harness = makeHarness({ mode: "replace", replacementReady: true, artifact });
    const result = await harness.controller.init();
    assert.equal(result.state, "error");
    assert.equal(result.code, "CALENDAR_REPLACEMENT_READY_MARKER_MISSING");
    assert.equal(harness.document.anchor.hidden, false);
    assert.equal(harness.document.anchor.getAttribute("hidden"), null);
    assert.equal(harness.document.anchor.getAttribute("aria-hidden"), null);
    assert.equal(harness.document.anchor.getAttribute("inert"), null);
    assert.equal(harness.document.getElementById(overlay.ROOT_ID), null);
});

test("replacement snapshots and restores every native visibility/accessibility/style/class value before APStudy removal", async () => {
    const harness = makeHarness({ mode: "replace", replacementReady: true });
    const native = harness.document.anchor;
    native.hidden = true;
    native.setAttribute("hidden", "");
    native.setAttribute("style", "display: grid; color: red;");
    native.style.cssText = "display: grid; color: red;";
    native.setAttribute("class", "calendar native");
    native.className = "calendar native";
    native.ariaHidden = "false";
    native.setAttribute("aria-hidden", "false");
    native.inert = false;
    native.setAttribute("inert", "");
    const before = {
        hidden: native.hidden,
        hiddenAttribute: native.getAttribute("hidden"),
        style: native.getAttribute("style"),
        cssText: native.style.cssText,
        class: native.getAttribute("class"),
        className: native.className,
        ariaHidden: native.ariaHidden,
        ariaAttribute: native.getAttribute("aria-hidden"),
        inert: native.inert,
        inertAttribute: native.getAttribute("inert")
    };
    const order = [];
    harness.defaultArtifact.mountCalendar = (rootNode, adapter, capabilities) => {
        harness.mounted.push({ rootNode, adapter, capabilities });
        rootNode.setAttribute(overlay.READY_MARKER, overlay.READY_MARKER_VALUE);
        rootNode.setAttribute(overlay.READY_CONTENT_MARKER, overlay.READY_MARKER_VALUE);
        return () => order.push({ hidden: native.hidden, rootConnected: rootNode.isConnected });
    };
    assert.equal((await harness.controller.init()).state, "mounted");
    assert.equal(native.hidden, true);
    assert.equal(native.getAttribute("aria-hidden"), "true");
    assert.equal(native.inert, true);
    assert.equal(harness.mounted[0].capabilities.mode, "replace");
    harness.controller.dispose("test-replacement-dispose");
    assert.deepEqual(order, [{ hidden: before.hidden, rootConnected: true }]);
    assert.deepEqual({
        hidden: native.hidden,
        hiddenAttribute: native.getAttribute("hidden"),
        style: native.getAttribute("style"),
        cssText: native.style.cssText,
        class: native.getAttribute("class"),
        className: native.className,
        ariaHidden: native.ariaHidden,
        ariaAttribute: native.getAttribute("aria-hidden"),
        inert: native.inert,
        inertAttribute: native.getAttribute("inert")
    }, before);
    assert.equal(harness.document.getElementById(overlay.ROOT_ID), null);
});

test("replacement restores native synchronously on range, mount, route, and feature failures", async () => {
    const rangeFailure = makeHarness({ mode: "replace", replacementReady: true, response: { contractVersion: 1, ok: false, code: "NEST_CALENDAR_RANGE_UNAVAILABLE" } });
    assert.equal((await rangeFailure.controller.init()).state, "error");
    assert.equal(rangeFailure.document.anchor.hidden, false);

    const mountFailure = makeHarness({
        mode: "replace",
        replacementReady: true,
        artifact: {
            contractVersion: 1,
            [overlay.REPLACEMENT_PARITY_FLAG]: { version: overlay.REPLACEMENT_PARITY_VERSION, ready: true },
            createCalendarDataAdapter() { return {}; },
            mountCalendar() { throw new Error("mount failed"); }
        }
    });
    assert.equal((await mountFailure.controller.init()).state, "error");
    assert.equal(mountFailure.document.anchor.hidden, false);

    const routeFailure = makeHarness({ mode: "replace", replacementReady: true });
    await routeFailure.controller.init();
    const routeResult = await routeFailure.controller.route({ path: "/courses/1", href: `${ORIGIN}/courses/1` });
    assert.equal(routeResult.state, "off-route");
    assert.equal(routeFailure.document.anchor.hidden, false);
    assert.equal(routeFailure.document.getElementById(overlay.ROOT_ID), null);

    const featureFailure = makeHarness({ mode: "replace", replacementReady: true });
    await featureFailure.controller.init();
    featureFailure.flags.overlay = false;
    const disabled = await featureFailure.controller.update({ "platform.flags": { newValue: { projection: true, overlay: false, replacement: true, [overlay.REPLACEMENT_PARITY_FLAG]: { version: 1, ready: true } } } }, "local");
    assert.equal(disabled.code, "FEATURE_DISABLED_OVERLAY");
    assert.equal(featureFailure.document.anchor.hidden, false);
    assert.equal(featureFailure.document.getElementById(overlay.ROOT_ID), null);
});

test("replacement restores on Canvas native-node replacement and supports repeated safe cycles without duplicate roots/listeners", async () => {
    const harness = makeHarness({ mode: "replace", replacementReady: true });
    const firstInit = harness.controller.init();
    assert.strictEqual(firstInit, harness.controller.init(), "duplicate init shares one activation promise");
    assert.equal((await firstInit).state, "mounted");
    assert.equal(harness.window.listenerCount("popstate"), 1);
    assert.equal(harness.window.listenerCount("hashchange"), 1);
    assert.equal(harness.document.body.children.filter((node) => node.id === overlay.ROOT_ID).length, 1);

    const oldNative = harness.document.anchor;
    const replacement = new FakeElement("main");
    replacement.id = "calendar-app";
    harness.document.body.removeChild(oldNative);
    harness.document.anchor = replacement;
    harness.document.body.appendChild(replacement);
    harness.window.observers.at(-1).trigger();
    assert.equal(harness.document.getElementById(overlay.ROOT_ID), null);
    assert.equal(oldNative.hidden, false);
    assert.equal(replacement.hidden, false);
    assert.equal(harness.window.listenerCount("popstate"), 0);
    assert.equal(harness.window.listenerCount("hashchange"), 0);

    const cycleResult = await harness.controller.init({ force: true, mode: "replace" });
    assert.equal(cycleResult.state, "mounted");
    assert.equal(harness.document.body.children.filter((node) => node.id === overlay.ROOT_ID).length, 1);
    harness.controller.dispose("cycle-end");
    assert.equal(harness.document.body.children.filter((node) => node.id === overlay.ROOT_ID).length, 0);
});

test("overlay mode and stored replace mode with false flags never hide Canvas", async () => {
    const overlayHarness = makeHarness({ mode: "overlay" });
    await overlayHarness.controller.init();
    assert.equal(overlayHarness.document.anchor.hidden, false);
    assert.equal(overlayHarness.document.anchor.getAttribute("aria-hidden"), null);
    overlayHarness.controller.dispose("overlay-end");

    const storedReplace = makeHarness({
        mode: "replace",
        flags: { projection: true, overlay: true, replacement: false, [overlay.REPLACEMENT_PARITY_FLAG]: { version: overlay.REPLACEMENT_PARITY_VERSION, ready: true } },
        replacementReady: false
    });
    const result = await storedReplace.controller.init();
    assert.equal(result.state, "off");
    assert.equal(result.code, "CALENDAR_REPLACEMENT_PARITY_NOT_READY");
    assert.equal(storedReplace.mounted.length, 0);
    assert.equal(storedReplace.document.anchor.hidden, false);
});

test("replacement parity marker is versioned, explicitly opt-in, and documents the disabled gate", () => {
    assert.equal(overlay.REPLACEMENT_PARITY_VERSION, 1);
    assert.deepEqual(overlay.REPLACEMENT_PARITY_GATE, [
        "month/week/agenda navigation",
        "all-day/timed event parity",
        "filters",
        "Nest CRUD and recurrence parity",
        "reminders/preferences parity",
        "source links",
        "completion styling/routing",
        "account events",
        "accessible dialogs"
    ]);
    assert.equal(overlay.replacementParityIsReady({ [overlay.REPLACEMENT_PARITY_FLAG]: { version: 1, ready: true } }, { replacement: true, [overlay.REPLACEMENT_PARITY_FLAG]: { version: 1, ready: true } }), true);
    assert.equal(overlay.replacementParityIsReady({ [overlay.REPLACEMENT_PARITY_FLAG]: { version: 2, ready: true } }, { replacement: true, [overlay.REPLACEMENT_PARITY_FLAG]: { version: 1, ready: true } }), false);
    assert.equal(overlay.replacementParityIsReady({ [overlay.REPLACEMENT_PARITY_FLAG]: { version: 1, ready: true } }, { replacement: false, [overlay.REPLACEMENT_PARITY_FLAG]: { version: 1, ready: true } }), false);
});
