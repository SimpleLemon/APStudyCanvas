"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const popup = require("../../js/popup-controller.js");

const POPUP_SOURCE = fs.readFileSync(path.join(__dirname, "../../js/popup.js"), "utf8");
const SCHEMA_SOURCE = fs.readFileSync(path.join(__dirname, "../../js/settings-schema.js"), "utf8");

function fakeChrome({ sync = {}, local = {}, sendMessage } = {}) {
    const areas = { sync: { ...sync }, local: { ...local } };
    const calls = [];
    const storageGets = [];
    const area = (name) => ({
        get(keys) {
            storageGets.push({ area: name, keys: Array.isArray(keys) ? keys.slice() : keys });
            const source = areas[name];
            if (keys === null || keys === undefined) return Promise.resolve({ ...source });
            const list = Array.isArray(keys) ? keys : [keys];
            return Promise.resolve(Object.fromEntries(list.map((key) => [key, source[key]]).filter(([, value]) => value !== undefined)));
        },
        set(changes) { Object.assign(areas[name], changes); return Promise.resolve(); },
        remove(keys) { (Array.isArray(keys) ? keys : [keys]).forEach((key) => delete areas[name][key]); return Promise.resolve(); }
    });
    return {
        calls,
        storageGets,
        areas,
        runtime: { sendMessage: async (message) => { calls.push(message); return sendMessage ? sendMessage(message) : { payload: { ok: true } }; } },
        tabs: { create: async (details) => { calls.push({ tabsCreate: details }); return { id: 12 }; } },
        storage: { sync: area("sync"), local: area("local") }
    };
}

function fakeNode({ id, value = "", checked = false, type = "text", dataset = {}, attributes = {} } = {}) {
    const listeners = {};
    const attributesMap = new Map(Object.entries(attributes));
    return {
        id, value, checked, type, dataset, hidden: false, disabled: false, textContent: "", classList: { toggle() {} },
        style: {},
        setAttribute(name, value) { attributesMap.set(name, String(value)); },
        removeAttribute(name) { attributesMap.delete(name); },
        getAttribute(name) { return attributesMap.get(name) ?? null; },
        hasAttribute(name) { return attributesMap.has(name); },
        addEventListener(event, callback) { (listeners[event] ||= []).push(callback); },
        listenerCount(event) { return (listeners[event] || []).length; },
        dispatch(event, detail) {
            const type = typeof event === "string" ? event : event.type;
            const dispatched = typeof event === "object" ? event : { key: event, detail };
            dispatched.target = this;
            dispatched.preventDefault = dispatched.preventDefault || (() => { dispatched.defaultPrevented = true; });
            (listeners[type] || []).forEach((callback) => callback(dispatched));
            return dispatched;
        },
        querySelector() { return null; }, querySelectorAll() { return []; }, replaceChildren() {}, appendChild() {},
        closest() { return null; }, focus() {}
    };
}

function fakeDocument(nodes = {}) {
    return {
        body: { dataset: {} }, visibilityState: "visible",
        querySelector(selector) { return nodes[selector] || null; },
        querySelectorAll(selector) {
            if (selector === "[data-popup-setting]") return Object.values(nodes).filter((node) => node.dataset?.popupSetting);
            const popupSetting = selector.match(/^\[data-popup-setting="([^"]+)"\]$/);
            if (popupSetting) return Object.values(nodes).filter((node) => node.dataset?.popupSetting === popupSetting[1]);
            if (selector === "[data-sidebar-control]") return Object.values(nodes).filter((node) => node.dataset?.sidebarControl);
            return [];
        },
        getElementById(id) { return nodes[`#${id}`] || Object.values(nodes).find((node) => node.id === id) || null; },
        addEventListener() {}, createElement() { return fakeNode(); }
    };
}

test("settings reset preserves the compatibility-only likes preference", async () => {
    const writes = [];
    const controller = popup.createController({
        document: fakeDocument(),
        window: { location: { search: "" }, confirm: () => true, addEventListener() {} },
        defaults: { dark_mode: true, browser_show_likes: false },
        settingsStore: { transaction: async (changes) => { writes.push(changes); } }
    });

    await controller.resetSettings();

    assert.deepEqual(writes, [{ dark_mode: true }]);
    assert.equal(Object.hasOwn(writes[0], "browser_show_likes"), false);
});

test("popup read, import, export, and reset leave retired reminder storage untouched", async () => {
    const remind = fakeNode({ id: "remind", type: "checkbox", checked: true, dataset: { popupSetting: "remind" } });
    const darkMode = fakeNode({ id: "dark-mode", type: "checkbox", dataset: { popupSetting: "dark_mode" } });
    const exportButton = fakeNode({ id: "popup-export-settings", type: "button" });
    const exportOutput = fakeNode({ id: "popup-export-output" });
    const importButton = fakeNode({ id: "popup-import-settings", type: "button" });
    const importInput = fakeNode({ id: "popup-import-input", value: JSON.stringify({ dark_mode: true, remind: false, reminder_count: 99 }) });
    const chromeApi = fakeChrome({ sync: { dark_mode: false, remind: true, reminder_count: 4 } });
    const writes = [];
    const controller = popup.createController({
        document: fakeDocument({ "#remind": remind, "#dark-mode": darkMode, "#popup-export-settings": exportButton, "#popup-export-output": exportOutput, "#popup-import-settings": importButton, "#popup-import-input": importInput }),
        window: { location: { search: "" }, confirm: () => true, addEventListener() {} },
        chromeApi,
        defaults: { dark_mode: true, remind: false, reminder_count: 1 },
        settingsStore: { transaction: async (changes) => { writes.push(changes); } }
    });

    await controller.init();
    assert.equal(darkMode.checked, false, "active settings still synchronize into controls");
    assert.equal(remind.checked, true, "retired controls are not synchronized");
    assert.equal(chromeApi.storageGets.some(({ area, keys }) => area === "sync" && Array.isArray(keys) && keys.includes("remind")), false, "popup reads never request retired reminder values");

    exportButton.dispatch("click");
    await new Promise((resolve) => setImmediate(resolve));
    const exported = JSON.parse(exportOutput.value);
    assert.equal(exported.dark_mode, false, "active settings still export");
    assert.equal(Object.hasOwn(exported, "remind"), false);
    assert.equal(Object.hasOwn(exported, "reminder_count"), false);

    importButton.dispatch("click");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(writes.pop(), { dark_mode: true }, "imports discard retired reminder values while preserving active changes");

    await controller.resetSettings();
    assert.deepEqual(writes.pop(), { dark_mode: true }, "reset writes active defaults only");
    assert.equal(chromeApi.areas.sync.remind, true, "existing retired values are never mutated");
    assert.equal(chromeApi.areas.sync.reminder_count, 4, "existing retired values are never mutated");
});

function interactiveNode(tagName = "div") {
    const listeners = new Map();
    const attributes = new Map();
    const children = [];
    const classes = new Set();
    const node = {
        tagName: tagName.toUpperCase(),
        dataset: {},
        style: {},
        childNodes: children,
        children,
        hidden: false,
        textContent: "",
        focused: false,
        classList: {
            add(...names) { names.forEach((name) => classes.add(name)); },
            remove(...names) { names.forEach((name) => classes.delete(name)); },
            toggle(name, force) { if (force === undefined ? !classes.has(name) : force) classes.add(name); else classes.delete(name); },
            contains(name) { return classes.has(name); }
        },
        setAttribute(name, value) { attributes.set(name, String(value)); },
        getAttribute(name) { return attributes.get(name) ?? null; },
        removeAttribute(name) { attributes.delete(name); },
        addEventListener(type, callback) { const values = listeners.get(type) || []; values.push(callback); listeners.set(type, values); },
        dispatch(type, event = {}) { const detail = { ...event, type, target: event.target || node, preventDefault: event.preventDefault || (() => { detail.defaultPrevented = true; }) }; (listeners.get(type) || []).slice().forEach((callback) => callback(detail)); return detail; },
        appendChild(child) { children.push(child); child.parentNode = node; return child; },
        append(...next) { next.forEach((child) => node.appendChild(child)); },
        replaceChildren(...next) { children.splice(0, children.length, ...next); next.forEach((child) => { child.parentNode = node; }); },
        querySelector(selector) {
            if (selector === "[data-sidebar-drag-handle]") return children.find((child) => child.dataset?.sidebarDragHandle === "true") || null;
            if (selector === ".sidebar-course-name" || selector === ".sidebar-page-name") return children.find((child) => child.classList?.contains(selector.slice(1))) || null;
            if (selector === ".sidebar-course-dot") return children.find((child) => child.classList?.contains("sidebar-course-dot")) || null;
            if (selector === "ol") return children.find((child) => child.tagName === "OL") || null;
            const match = selector.match(/data-course-id="([^"]+)"/);
            return match ? children.find((child) => child.dataset?.courseId === match[1]) || null : null;
        },
        querySelectorAll(selector) {
            if (selector === "[data-course-move]") return children.filter((child) => child.dataset?.courseMove);
            return [];
        },
        focus() { node.focused = true; }
    };
    Object.defineProperty(node, "innerHTML", {
        set(value) {
            node.replaceChildren();
            if (String(value).includes("data-sidebar-drag-handle")) {
                const handle = interactiveNode("span"); handle.dataset.sidebarDragHandle = "true"; node.appendChild(handle);
            }
            if (String(value).includes("sidebar-page-name")) { const name = interactiveNode("span"); name.classList.add("sidebar-page-name"); node.appendChild(name); }
            if (String(value).includes("sidebar-course-name")) { const name = interactiveNode("span"); name.classList.add("sidebar-course-name"); node.appendChild(name); }
            if (String(value).includes("sidebar-course-dot")) { const dot = interactiveNode("span"); dot.classList.add("sidebar-course-dot"); node.appendChild(dot); }
            ["up", "down"].forEach((direction) => {
                if (!String(value).includes(`data-course-move="${direction}"`) && !String(value).includes(`data-sidebar-move="${direction}"`)) return;
                const button = interactiveNode("button");
                if (String(value).includes(`data-course-move="${direction}"`)) button.dataset.courseMove = direction;
                if (String(value).includes(`data-sidebar-move="${direction}"`)) button.dataset.sidebarMove = direction;
                node.appendChild(button);
            });
        },
        get() { return ""; }
    });
    return node;
}

function interactiveSidebarDocument(editor, status) {
    return {
        body: { dataset: {} }, visibilityState: "visible",
        querySelector(selector) {
            if (selector === "#sidebar-course-order-editor") return editor;
            if (selector === "#workspace-save-status") return status;
            const match = selector.match(/#sidebar-course-order-editor \[data-course-id="([^"]+)"\]/);
            return match ? editor.querySelector("ol")?.querySelector(`[data-course-id="${match[1]}"]`) : null;
        },
        querySelectorAll() { return []; },
        getElementById(id) { return id === "sidebar-course-order-editor" ? editor : null; },
        addEventListener() {},
        createElement(tagName) { return interactiveNode(tagName); }
    };
}

function fakeSidebarRow(page) {
    const checkbox = { checked: true, disabled: false, addEventListener() {} };
    const pageName = { textContent: "" };
    return {
        dataset: { sidebarPage: page },
        tabIndex: 0,
        focused: false,
        innerHTML: "",
        focus() { this.focused = true; },
        querySelector(selector) {
            if (selector === ".sidebar-page-name") return pageName;
            if (selector === "[data-sidebar-visibility]") return checkbox;
            return null;
        },
        querySelectorAll() { return []; },
        addEventListener() {}
    };
}

function fakeSidebarList(rows) {
    return {
        children: rows.slice(),
        replaceChildren() { this.children = []; },
        appendChild(row) { this.children.push(row); return row; },
        querySelector(selector) {
            const match = selector.match(/data-sidebar-page="([^"]+)"/);
            return match ? this.children.find((row) => row.dataset.sidebarPage === match[1]) || null : null;
        },
        querySelectorAll(selector) { return selector === "[data-sidebar-page]" ? this.children : []; }
    };
}

function fakeSidebarDocument(list, status, canvasLoadNote = null) {
    return {
        body: { dataset: {} },
        visibilityState: "visible",
        querySelector(selector) {
            if (selector === "#sidebar-page-list") return list;
            if (selector === "#workspace-save-status") return status;
            if (selector === "#workspace-section-sidebar [data-canvas-load-note]") return canvasLoadNote;
            const match = selector.match(/^#sidebar-page-list \[data-sidebar-page="([^"]+)"\]$/);
            return match ? list.querySelector(`[data-sidebar-page="${match[1]}"]`) : null;
        },
        querySelectorAll() { return []; },
        getElementById(id) { return id === "sidebar-page-list" ? list : null; },
        addEventListener() {},
        createElement() { return fakeSidebarRow(""); }
    };
}

function loadPopupCalendarControllerFactory({ document, window, chromeApi }) {
    const context = {
        URL,
        URLSearchParams,
        Set,
        Object,
        Array,
        Number,
        String,
        RegExp,
        Error,
        Date,
        Math,
        Promise,
        Reflect,
        setTimeout,
        clearTimeout,
        document,
        window,
        chrome: chromeApi,
        isPlainObject(value) {
            if (!value || typeof value !== "object" || Array.isArray(value)) return false;
            const prototype = Object.getPrototypeOf(value);
            return prototype === Object.prototype || prototype === null;
        }
    };
    context.globalThis = context;
    vm.runInNewContext(SCHEMA_SOURCE, context, { filename: "js/settings-schema.js" });
    vm.runInNewContext(`${POPUP_SOURCE.slice(0, POPUP_SOURCE.indexOf("function queueSettingWrite"))}
        globalThis.__createPopupCalendarController = createPopupCalendarController;
        globalThis.__popupCalendarContextFromEvent = popupCalendarContextFromEvent;
        globalThis.__normalizeCanvasBinding = normalizeCanvasBinding;`, context, { filename: "js/popup.js" });
    return { createPopupCalendarController: context.__createPopupCalendarController, popupCalendarContextFromEvent: context.__popupCalendarContextFromEvent, normalizeCanvasBinding: context.__normalizeCanvasBinding, context };
}

test("popup startup invokes init exactly once when the DOM is already ready", async () => {
    let calls = 0;
    const controller = { async init() { calls += 1; return controller; } };
    const startup = popup.createStartup({ controller, document: { readyState: "complete", addEventListener() { assert.fail("ready DOM should not add a listener"); } } });

    assert.equal(startup.started, true);
    await startup.promise;
    await startup.start();
    assert.equal(calls, 1);
});

test("popup startup invokes init exactly once from DOMContentLoaded", async () => {
    let calls = 0;
    let listener = null;
    let options = null;
    const controller = { async init() { calls += 1; return controller; } };
    const startup = popup.createStartup({
        controller,
        document: {
            readyState: "loading",
            addEventListener(type, callback, value) {
                assert.equal(type, "DOMContentLoaded");
                listener = callback;
                options = value;
            }
        }
    });

    assert.equal(startup.started, false);
    assert.deepEqual(options, { once: true });
    listener();
    listener();
    await startup.promise;
    assert.equal(calls, 1);
});

test("popup runtime makes ready the terminal aggregate startup operation and drafts a post-ready sync", () => {
    const startupSource = POPUP_SOURCE.slice(POPUP_SOURCE.indexOf("window.APStudyCanvasPopupStartup ="), POPUP_SOURCE.indexOf("document.addEventListener(\"change\""));
    for (const required of [
        "initializePopupChrome()",
        "popupCalendarController.init()",
        "APStudyCanvasEditCanvasStartup?.start?.()",
        "requireHostedSourceAtStartup()"
    ]) {
        assert.match(startupSource, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), required);
    }
    assert.match(startupSource, /onReady: \(\) => popupController\.signalReady\(\)/);
    assert.ok(startupSource.indexOf("onReady:") < startupSource.indexOf("afterReady:"));
    assert.match(startupSource, /onAfterReadyError: \(error\) => popupController\.reportDraftSyncFailure\(error\)/);
    assert.doesNotMatch(startupSource, /signalReady\(\{[\s\S]*draft:/);
});

test("embedded shell acknowledges ready before slow data and loader work can exhaust the host timeout", async () => {
    const chromeApi = fakeChrome();
    const originalGet = chromeApi.storage.sync.get;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    chromeApi.storage.sync.get = async (keys) => {
        await gate;
        return originalGet(keys);
    };
    const document = fakeDocument();
    const controller = popup.createController({
        document,
        window: { location: { search: "?embedded=1&overlaySession=session-1" }, addEventListener() {} },
        chromeApi,
        defaults: {}
    });

    let releaseLoader;
    const loaderGate = new Promise((resolve) => { releaseLoader = resolve; });
    const startup = popup.createStartup({
        controller,
        document: { readyState: "complete", addEventListener() {} },
        loaders: [() => loaderGate],
        onReady: () => controller.signalReady(),
        afterReady: () => controller.signalDraftState({ draft: true })
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(chromeApi.calls.some((message) => message.type === "OVERLAY_CONTROL" && message.payload?.action === "ready"), true);

    release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(chromeApi.calls.filter((message) => message.type === "OVERLAY_CONTROL" && message.payload?.action === "ready").length, 1);
    releaseLoader();
    await startup.promise;
    await startup.postReadyPromise;
    const controls = chromeApi.calls.filter((message) => message.type === "OVERLAY_CONTROL");
    assert.equal(document.body.dataset.shell, "embedded");
    assert.equal(document.body.dataset.mode, "workspace");
    assert.equal(controller.state.category, "overview");
    assert.deepEqual(controls.map((message) => message.payload), [
        { action: "ready", overlaySession: "session-1" },
        { action: "draft-state", overlaySession: "session-1", draft: true, sequence: 1 }
    ]);
    await Promise.all([startup.start(), startup.start(), controller.init()]);
    assert.equal(chromeApi.calls.filter((message) => message.type === "OVERLAY_CONTROL" && message.payload?.action === "ready").length, 1);
});

test("a required failure after embedded shell readiness stays local instead of stranding host recovery", async () => {
    const errorArea = fakeNode({ id: "workspace-error-area" });
    const errorMessage = fakeNode({ id: "workspace-error-message" });
    const retry = fakeNode({ id: "workspace-error-retry" });
    const chromeApi = fakeChrome();
    const document = fakeDocument({
        "#workspace-error-area": errorArea,
        "#workspace-error-message": errorMessage,
        "#workspace-error-retry": retry
    });
    const controller = popup.createController({
        document,
        window: { location: { search: "?embedded=1&overlaySession=session-error" }, addEventListener() {} },
        chromeApi,
        defaults: {}
    });

    const startup = popup.createStartup({
        controller,
        document: { readyState: "complete", addEventListener() {} },
        loaders: [async () => { throw new Error("REQUIRED_STARTUP_FAILED"); }],
        onReady: () => controller.signalReady(),
        afterReady: () => controller.signalDraftState({ draft: false }),
        onError: (error) => controller.reportStartupFailure(error)
    });
    await assert.rejects(startup.promise, /REQUIRED_STARTUP_FAILED/);
    assert.equal(errorArea.hidden, false);
    assert.equal(errorArea.getAttribute("data-state"), "error");
    assert.match(errorMessage.textContent, /couldn’t load this workspace/i);
    assert.equal(chromeApi.calls.filter((message) => message.type === "OVERLAY_CONTROL" && message.payload?.action === "ready").length, 1);
    assert.equal(chromeApi.calls.some((message) => message.type === "OVERLAY_CONTROL" && message.payload?.action === "error"), false);
});

test("draft changes use draft-state after the one-time ready handshake", async () => {
    const chromeApi = fakeChrome();
    const controller = popup.createController({
        document: fakeDocument(),
        window: { location: { search: "?embedded=1&overlaySession=session-draft" }, addEventListener() {} },
        chromeApi,
        defaults: {}
    });

    await controller.init();
    await controller.signalReady();
    await controller.signalDraftState({ draft: true });
    await controller.signalReady();

    const actions = chromeApi.calls
        .filter((message) => message.type === "OVERLAY_CONTROL")
        .map((message) => ({ action: message.payload.action, draft: message.payload.draft, sequence: message.payload.sequence }));
    assert.deepEqual(actions, [
        { action: "ready", draft: undefined, sequence: undefined },
        { action: "draft-state", draft: true, sequence: 1 }
    ]);
});

test("draft transitions are serialized, sequenced, and continue after an observed transport failure", async () => {
    const pending = [];
    const chromeApi = fakeChrome({
        sendMessage(message) {
            if (message.type !== "OVERLAY_CONTROL" || message.payload.action === "ready") return { payload: { ok: true } };
            return new Promise((resolve, reject) => pending.push({ message, resolve, reject }));
        }
    });
    const controller = popup.createController({
        document: fakeDocument(),
        window: { location: { search: "?embedded=1&overlaySession=session-order" }, addEventListener() {} },
        chromeApi,
        defaults: {}
    });
    await controller.init();
    await controller.signalReady();

    const older = controller.signalDraftState({ draft: false });
    await new Promise((resolve) => setImmediate(resolve));
    const newer = controller.signalDraftState({ draft: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(pending.length, 1, "the newer transition waits for the older transport result");
    assert.deepEqual(pending[0].message.payload, {
        action: "draft-state",
        overlaySession: "session-order",
        draft: false,
        sequence: 1
    });

    pending[0].reject(new Error("TRANSPORT_FAILED"));
    await assert.rejects(older, { code: "OVERLAY_HOST_UNAVAILABLE" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(pending.length, 2, "a failed older transition does not strand the queue");
    assert.deepEqual(pending[1].message.payload, {
        action: "draft-state",
        overlaySession: "session-order",
        draft: true,
        sequence: 2
    });
    pending[1].resolve({ payload: { ok: true, draft: true, sequence: 2 } });
    assert.deepEqual(await newer, { ok: true, draft: true, sequence: 2 });
});

test("initial draft synchronization failure after ready is tracked without becoming a startup error", async () => {
    const status = fakeNode({ id: "workspace-save-status" });
    const errorArea = fakeNode({ id: "workspace-error-area" });
    const errorMessage = fakeNode({ id: "workspace-error-message" });
    let rejectDraft;
    const chromeApi = fakeChrome({
        sendMessage(message) {
            if (message.type !== "OVERLAY_CONTROL") return { payload: { ok: true } };
            if (message.payload.action === "ready") return { payload: { ok: true, state: "ready" } };
            if (message.payload.action === "draft-state") {
                return new Promise((resolve, reject) => { rejectDraft = reject; });
            }
            return { payload: { ok: true } };
        }
    });
    const controller = popup.createController({
        document: fakeDocument({
            "#workspace-save-status": status,
            "#workspace-error-area": errorArea,
            "#workspace-error-message": errorMessage
        }),
        window: { location: { search: "?embedded=1&overlaySession=session-initial-draft" }, addEventListener() {} },
        chromeApi,
        defaults: {}
    });
    const startup = popup.createStartup({
        controller,
        document: { readyState: "complete", addEventListener() {} },
        onReady: () => controller.signalReady(),
        afterReady: () => controller.signalDraftState({ draft: false }),
        onAfterReadyError: (error) => controller.reportDraftSyncFailure(error),
        onError: (error) => controller.reportStartupFailure(error)
    });

    await startup.promise;
    assert.equal(chromeApi.calls.filter((message) => message.type === "OVERLAY_CONTROL" && message.payload.action === "ready").length, 1);
    rejectDraft(new Error("DRAFT_TRANSPORT_FAILED"));
    await startup.postReadyPromise;

    assert.equal(controller.state.startupFailurePromise, null);
    assert.equal(controller.state.draftSyncError.code, "OVERLAY_HOST_UNAVAILABLE");
    assert.equal(errorArea.hidden, true);
    assert.match(status.textContent, /Unsaved-change protection could not sync/);
    assert.equal(status.dataset.state, "failed");
    assert.equal(chromeApi.calls.some((message) => message.type === "OVERLAY_CONTROL" && message.payload.action === "error"), false);
});

test("a successful draft sync clears only the recovered draft-protection warning", async () => {
    const workspaceStatus = fakeNode({ id: "workspace-save-status" });
    const homeStatus = fakeNode({ id: "home-save-status" });
    let draftAttempts = 0;
    const chromeApi = fakeChrome({
        sendMessage(message) {
            if (message.type !== "OVERLAY_CONTROL") return { payload: { ok: true } };
            if (message.payload.action === "ready") return { payload: { ok: true, state: "ready" } };
            if (message.payload.action === "draft-state" && ++draftAttempts === 1) {
                return Promise.reject(new Error("DRAFT_TRANSPORT_FAILED"));
            }
            return { payload: { ok: true, state: "ready", draft: message.payload.draft, sequence: message.payload.sequence } };
        }
    });
    const controller = popup.createController({
        document: fakeDocument({
            "#workspace-save-status": workspaceStatus,
            "#home-save-status": homeStatus
        }),
        window: { location: { search: "?embedded=1&overlaySession=session-draft-recovery" }, addEventListener() {} },
        chromeApi,
        defaults: {}
    });
    await controller.init();
    await controller.signalReady();

    const failed = controller.signalDraftState({ draft: true });
    await assert.rejects(failed, { code: "OVERLAY_HOST_UNAVAILABLE" });
    controller.reportDraftSyncFailure({ code: "OVERLAY_HOST_UNAVAILABLE" });
    assert.match(workspaceStatus.textContent, /Unsaved-change protection could not sync/);
    homeStatus.textContent = "Failed — changes reverted.";
    homeStatus.dataset.state = "failed";

    assert.deepEqual(await controller.signalDraftState({ draft: true }), {
        ok: true,
        state: "ready",
        draft: true,
        sequence: 2
    });
    assert.equal(controller.state.draftSyncError, null);
    assert.equal(workspaceStatus.textContent, "Settings sync automatically.");
    assert.equal(workspaceStatus.dataset.state, "idle");
    assert.equal(homeStatus.textContent, "Failed — changes reverted.", "an unrelated error remains visible");
    assert.equal(homeStatus.dataset.state, "failed");
});

test("an early embedded ready handshake failure resets its cache so aggregate startup can retry", async () => {
    let readyAttempts = 0;
    const chromeApi = fakeChrome({
        sendMessage(message) {
            if (message.type !== "OVERLAY_CONTROL") return { payload: { ok: true } };
            if (message.payload.action !== "ready") return { payload: { ok: true, state: "ready" } };
            readyAttempts += 1;
            if (readyAttempts === 1) return Promise.reject(new Error("TRANSPORT_DOWN"));
            return { payload: { ok: true, state: "ready" } };
        }
    });
    const controller = popup.createController({
        document: fakeDocument(),
        window: { location: { search: "?embedded=1&overlaySession=session-ready-retry" }, addEventListener() {} },
        chromeApi,
        defaults: {}
    });
    await controller.init();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(controller.state.readySignalPromise, null, "the failed early handshake is no longer cached");
    assert.deepEqual(await controller.signalReady(), { ok: true, state: "ready" });
    assert.equal(readyAttempts, 2, "the retry sends a fresh ready exchange");
});

test("a stale early ready reply clears the cache and stops stranding later draft transitions", async () => {
    let readyAttempts = 0;
    const chromeApi = fakeChrome({
        sendMessage(message) {
            if (message.type !== "OVERLAY_CONTROL") return { payload: { ok: true } };
            if (message.payload.action === "ready") {
                readyAttempts += 1;
                return readyAttempts === 1
                    ? { payload: { ok: false, code: "OVERLAY_SESSION_STALE" } }
                    : { payload: { ok: true, state: "ready" } };
            }
            return { payload: { ok: true, state: "ready", draft: message.payload.draft, sequence: message.payload.sequence } };
        }
    });
    const controller = popup.createController({
        document: fakeDocument(),
        window: { location: { search: "?embedded=1&overlaySession=session-draft-after-ready-fail" }, addEventListener() {} },
        chromeApi,
        defaults: {}
    });
    await controller.init();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(controller.state.readySignalPromise, null, "the stale early response is not retained as readiness");
    assert.deepEqual(await controller.signalDraftState({ draft: true }), {
        ok: true,
        state: "ready",
        draft: true,
        sequence: 1
    });
    assert.equal(readyAttempts, 2, "the draft transition retried the ready exchange first");
});

test("standalone startup recovery stays in its own tab without opening another workspace", async () => {
    const errorArea = fakeNode({ id: "workspace-error-area" });
    const errorMessage = fakeNode({ id: "workspace-error-message" });
    const chromeApi = fakeChrome();
    const controller = popup.createController({
        document: fakeDocument({ "#workspace-error-area": errorArea, "#workspace-error-message": errorMessage }),
        window: { location: { search: "?view=workspace" }, addEventListener() {} },
        chromeApi,
        defaults: {}
    });

    assert.deepEqual(await controller.reportStartupFailure(new Error("STARTUP_FAILED")), {
        ok: true,
        state: "error",
        standalone: true
    });
    assert.match(errorMessage.textContent, /reopen the workspace/i);
    assert.equal(chromeApi.calls.some((call) => call.type === "OVERLAY_CONTROL" || call.tabsCreate), false);
});

test("identity states and strict avatar/profile precedence", () => {
    assert.equal(popup.normalizeIdentityResponse({ ok: true, identity: "acct", profile: { name: "Nest User", avatarUrl: "https://cdn.example/avatar.png" } }).state, "authenticated");
    assert.equal(popup.normalizeIdentityResponse({ ok: false, status: 401 }).state, "signed_out");
    assert.equal(popup.normalizeIdentityResponse({ ok: false, code: "TOKEN_EXPIRED" }).state, "expired");
    assert.equal(popup.normalizeIdentityResponse({ ok: false, code: "NEST_OFFLINE" }).state, "unavailable");
    assert.equal(popup.isHttpsAvatar("http://cdn.example/a.png"), false);
    assert.deepEqual(popup.resolveProfile({ name: "Nest", avatarUrl: "https://nest.example/a" }, { name: "Canvas" }), { name: "Nest", avatarUrl: "https://nest.example/a", initials: "N", source: "nest" });
    assert.equal(popup.resolveProfile({}, { name: "Canvas Student" }).source, "canvas");
    assert.equal(popup.resolveProfile({}, {}).initials, "?");
});

test("onboarding sign-in opens top-level Nest and continue dismisses", async () => {
    const chromeApi = fakeChrome();
    const nodes = { "#nest-onboarding": fakeNode({ id: "nest-onboarding" }) };
    const document = fakeDocument(nodes);
    const controller = popup.createController({ document, window: { location: { search: "" }, addEventListener() {}, open() {} }, chromeApi, defaults: {} });
    await controller.openNestLogin();
    assert.equal(chromeApi.calls.at(-1).tabsCreate.url, "https://nest.apstudy.org/extension/connect");
    await controller.dismissOnboarding();
    assert.equal(nodes["#nest-onboarding"].hidden, true);
});

test("Nest sign-in actions prevent navigation and open exactly once per click", async () => {
    const chromeApi = fakeChrome();
    const primary = fakeNode({ id: "nest-sign-in" });
    const calendar = fakeNode({ id: "calendar-nest-login" });
    const document = fakeDocument({ "#nest-sign-in": primary, "#calendar-nest-login": calendar });
    const controller = popup.createController({ document, window: { location: { search: "" }, addEventListener() {}, open() {} }, chromeApi, defaults: {} });
    await controller.init();
    assert.equal(primary.listenerCount("click"), 1);
    assert.equal(calendar.listenerCount("click"), 1);

    const primaryTabCount = chromeApi.calls.filter((call) => call.tabsCreate).length;
    const primaryEvent = primary.dispatch({ type: "click" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(primaryEvent.defaultPrevented, true);
    assert.equal(chromeApi.calls.filter((call) => call.tabsCreate).length - primaryTabCount, 1);
    assert.equal(chromeApi.calls.filter((call) => call.tabsCreate).at(-1).tabsCreate.url, "https://nest.apstudy.org/extension/connect");

    const calendarTabCount = chromeApi.calls.filter((call) => call.tabsCreate).length;
    const calendarEvent = calendar.dispatch({ type: "click" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calendarEvent.defaultPrevented, true);
    assert.equal(chromeApi.calls.filter((call) => call.tabsCreate).length - calendarTabCount, 1);
    assert.equal(chromeApi.calls.filter((call) => call.tabsCreate).at(-1).tabsCreate.url, "https://nest.apstudy.org/extension/connect");
});

test("Nest sign-in failure reports a retryable live status without swallowing the retry", async () => {
    const status = fakeNode({ id: "workspace-save-status", attributes: { role: "status", "aria-live": "polite" } });
    const primary = fakeNode({ id: "nest-sign-in" });
    const chromeApi = fakeChrome();
    let windowOpenCount = 0;
    chromeApi.tabs.create = async (details) => {
        chromeApi.calls.push({ tabsCreate: details });
        throw new Error("TABS_CREATE_FAILED");
    };
    const document = fakeDocument({ "#nest-sign-in": primary, "#workspace-save-status": status });
    const controller = popup.createController({ document, window: { location: { search: "" }, addEventListener() {}, open() { windowOpenCount += 1; return null; } }, chromeApi, defaults: {} });
    await controller.init();
    assert.equal(primary.listenerCount("click"), 1);

    const firstEvent = primary.dispatch({ type: "click" });
    await new Promise((resolve) => setImmediate(resolve));
    const secondEvent = primary.dispatch({ type: "click" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(firstEvent.defaultPrevented, true);
    assert.equal(secondEvent.defaultPrevented, true);
    assert.equal(chromeApi.calls.filter((call) => call.tabsCreate).length, 2);
    assert.equal(windowOpenCount, 2);
    assert.equal(status.textContent, "Nest sign-in could not open. Try again.");
    assert.equal(status.dataset.state, "failed");
    assert.equal(status.hidden, false);
    assert.equal(status.getAttribute("role"), "status");
    assert.equal(status.getAttribute("aria-live"), "polite");
});

test("modern dark palette mounts native color fields and saves the active draft without retired preset buttons", async () => {
    const palette = interactiveNode("div");
    const apply = fakeNode({ id: "modern-dark-palette-apply" });
    const discard = fakeNode({ id: "modern-dark-palette-discard" });
    const status = fakeNode({ id: "modern-dark-palette-status" });
    const courseSave = fakeNode({ id: "modern-course-save" });
    const document = fakeDocument({
        "#modern-course-save": courseSave,
        "#modern-dark-palette": palette,
        "#modern-dark-palette-apply": apply,
        "#modern-dark-palette-discard": discard,
        "#modern-dark-palette-status": status
    });
    document.createElement = (tagName) => interactiveNode(tagName);
    const transactions = [];
    const previousEditors = globalThis.APStudyCanvasSettingsEditors;
    globalThis.APStudyCanvasSettingsEditors = {
        createCourseCardEditor() { return { save: async () => {}, reset: async () => {} }; },
        createGpaBoundsEditor() { return { order: [], applyPreset: async () => {} }; },
        createAppearanceTools() { return { normalizeFont: (value) => value, applyCss: async () => {}, discardCss: () => "", setDarkFixUrls: async () => {}, applyBackground: async () => {} }; },
        createDiagnosticsTools() { return { loadErrors: async () => [], inspect: async () => ({ selectors: "" }), requestCustomOrigin: async () => {} }; }
    };
    try {
        const controller = popup.createController({
            document,
            window: { location: { search: "" }, addEventListener() {} },
            chromeApi: fakeChrome({ sync: { dark_preset: { "background-0": "#112233" } } }),
            defaults: {},
            settingsStore: { transaction: async (changes) => { transactions.push(changes); } }
        });
        await controller.init();
        await new Promise((resolve) => setImmediate(resolve));
        const color = palette.children[0]?.children[1];
        assert.equal(color?.type, "color");
        color.value = "#abcdef";
        color.dispatch("input");
        apply.dispatch("click");
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(transactions.at(-1), { dark_preset: { "background-0": "#abcdef" } });
        assert.equal(status.textContent, "Dark palette applied.");
        assert.equal(courseSave.listenerCount("click"), 1, "the modern editor mounted without a retired preset-button control");
    } finally {
        if (previousEditors === undefined) delete globalThis.APStudyCanvasSettingsEditors;
        else globalThis.APStudyCanvasSettingsEditors = previousEditors;
    }
});

test("modern GPA bounds render after the editor's asynchronous settings read", async () => {
    const bounds = interactiveNode("div");
    const courseSave = fakeNode({ id: "modern-course-save" });
    const document = fakeDocument({ "#modern-course-save": courseSave, "#modern-gpa-bounds": bounds });
    document.createElement = (tagName) => interactiveNode(tagName);
    const previousEditors = globalThis.APStudyCanvasSettingsEditors;
    globalThis.APStudyCanvasSettingsEditors = {
        createCourseCardEditor() { return { save: async () => {}, reset: async () => {} }; },
        createGpaBoundsEditor() { return { order: ["A", "F"], applyPreset: async () => {}, update: async () => {} }; },
        createAppearanceTools() { return { normalizeFont: (value) => value, applyCss: async () => {}, discardCss: () => "", setDarkFixUrls: async () => {}, applyBackground: async () => {} }; },
        createDiagnosticsTools() { return { loadErrors: async () => [], inspect: async () => ({ selectors: "" }), requestCustomOrigin: async () => {} }; }
    };
    try {
        const controller = popup.createController({
            document,
            window: { location: { search: "" }, addEventListener() {} },
            chromeApi: fakeChrome({ sync: { gpa_calc_bounds: { A: { cutoff: 93, gpa: 4 }, F: { cutoff: 0, gpa: 0 } } } }),
            defaults: {},
            settingsStore: { transaction: async () => {} }
        });
        await controller.init();
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(bounds.children.length, 2);
        assert.equal(bounds.children[0].children[0].textContent, "A");
        assert.equal(bounds.children[0].children[1].value, "93");
    } finally {
        if (previousEditors === undefined) delete globalThis.APStudyCanvasSettingsEditors;
        else globalThis.APStudyCanvasSettingsEditors = previousEditors;
    }
});

test("successful Nest sign-in opens one top-level tab without window.open fallback", async () => {
    const chromeApi = fakeChrome();
    let windowOpenCount = 0;
    const controller = popup.createController({
        document: fakeDocument(),
        window: { location: { search: "" }, addEventListener() {}, open() { windowOpenCount += 1; return null; } },
        chromeApi,
        defaults: {}
    });

    const result = await controller.openNestLogin();
    const tabCreates = chromeApi.calls.filter((call) => call.tabsCreate);
    assert.deepEqual(result, { id: 12 });
    assert.equal(tabCreates.length, 1);
    assert.deepEqual(tabCreates[0].tabsCreate, { url: "https://nest.apstudy.org/extension/connect" });
    assert.equal(windowOpenCount, 0);
});

test("sidebar live-apply applied:false reports the next Canvas-load status", async () => {
    const prior = ["dashboard", "courses", "calendar", "inbox", "history", "help"];
    const canonicalPrior = popup.normalizeSidebarOrder(prior);
    const list = fakeSidebarList(prior.map((page) => fakeSidebarRow(page)));
    const status = fakeNode({ id: "workspace-save-status" });
    const canvasLoadNote = fakeNode({ attributes: { "data-canvas-load-note": "true" } });
    const document = fakeSidebarDocument(list, status, canvasLoadNote);
    const liveChanges = [];
    const controller = popup.createController({
        document,
        window: { location: { search: "" }, addEventListener() {} },
        chromeApi: fakeChrome(),
        defaults: {},
        settingsStore: { updateField: async () => {}, flush: async () => {} },
        liveApply: async (changes) => {
            liveChanges.push(changes);
            return { ok: true, applied: false };
        }
    });
    await controller.loadSidebarSettings();

    const next = popup.reorderItems(prior, 1, "up");
    const result = await controller.persistSidebarOrder(next, "courses");

    assert.deepEqual(liveChanges, [{ sidebar_page_order: popup.normalizeSidebarOrder(next) }]);
    assert.equal(result.applied, false);
    assert.equal(result.appliesNextLoad, true);
    assert.equal(controller.state.sidebarNeedsNextLoad, true);
    assert.equal(canvasLoadNote.hidden, false);
    assert.equal(canvasLoadNote.textContent, "Saved. Applies on the next Canvas load.");
    assert.notEqual(canvasLoadNote.textContent, "Canvas updated live.");
    assert.equal(status.textContent, "Saved. Applies next Canvas load.");
});

test("BetterCampus sidebar parity keeps logo and page ordering/visibility enabled when the master is off", async () => {
    const list = fakeSidebarList([]);
    const layoutInput = fakeNode({ type: "select" });
    const collapsedInput = fakeNode({ type: "checkbox" });
    const advancedInput = fakeNode({ type: "number" });
    const logoInput = fakeNode({ type: "checkbox" });
    const layout = fakeNode({ dataset: { sidebarControl: "layout" } });
    const collapsed = fakeNode({ dataset: { sidebarControl: "collapsed" } });
    const advanced = fakeNode({ dataset: { sidebarControl: "advanced-layout" } });
    const branding = fakeNode({ dataset: { sidebarControl: "branding" } });
    layout.querySelectorAll = () => [layoutInput];
    collapsed.querySelectorAll = () => [collapsedInput];
    advanced.querySelectorAll = () => [advancedInput];
    branding.querySelectorAll = () => [logoInput];
    const document = fakeDocument({
        "#sidebar-page-list": list,
        "#sidebar-layout": layout,
        "#sidebar-collapsed": collapsed,
        "#sidebar-advanced": advanced,
        "#sidebar-branding": branding
    });
    document.createElement = () => fakeSidebarRow("");
    const controller = popup.createController({
        document,
        window: { location: { search: "" }, addEventListener() {} },
        chromeApi: fakeChrome(),
        defaults: { better_sidebar: false }
    });

    await controller.loadSidebarSettings();

    assert.equal(layoutInput.disabled, true, "Width/Density/Size stay disabled");
    assert.equal(collapsedInput.disabled, true, "Collapsed Options stay disabled");
    assert.equal(advancedInput.disabled, true, "advanced layout stays disabled");
    assert.equal(logoInput.disabled, false, "the logo control stays enabled");
    assert.ok(list.children.length > 0, "page ordering/visibility rows remain available");
    list.children.forEach((row) => assert.equal(row.querySelector("[data-sidebar-visibility]").disabled, false, "page visibility stays enabled"));
});

test("sidebar editor uses canonical Phase 2 defaults, bounds, and all five scale pairs", () => {
    assert.equal(popup.DEFAULT_SIDEBAR_SETTINGS.sidebar_expanded_width, 180);
    assert.equal(popup.DEFAULT_SIDEBAR_SETTINGS.sidebar_collapsed_width, 86);
    assert.deepEqual(popup.SIDEBAR_NUMERIC_RANGES.sidebar_expanded_width, { min: 160, max: 320 });
    assert.deepEqual(popup.SIDEBAR_NUMERIC_RANGES.sidebar_collapsed_width, { min: 48, max: 112 });
    assert.deepEqual(Object.keys(popup.SIDEBAR_SIZE_PRESETS), ["tiny", "small", "medium", "large", "extra-large"]);
    assert.deepEqual(popup.sidebarPresetChanges("size", "tiny"), { sidebar_scale_preset: "tiny", sidebar_icon_size: 12, sidebar_label_size: 10 });
    assert.deepEqual(popup.sidebarPresetChanges("size", "small"), { sidebar_scale_preset: "small", sidebar_icon_size: 14, sidebar_label_size: 12 });
    assert.deepEqual(popup.sidebarPresetChanges("size", "medium"), { sidebar_scale_preset: "medium", sidebar_icon_size: 16, sidebar_label_size: 14 });
    assert.deepEqual(popup.sidebarPresetChanges("size", "large"), { sidebar_scale_preset: "large", sidebar_icon_size: 18, sidebar_label_size: 16 });
    assert.deepEqual(popup.sidebarPresetChanges("size", "extra-large"), { sidebar_scale_preset: "extra-large", sidebar_icon_size: 21, sidebar_label_size: 18 });
    assert.deepEqual(popup.sidebarPresetChanges("width", "collapsed"), { sidebar_preferred_state: "collapsed" });
    assert.deepEqual(popup.sidebarPresetChanges("density", "expanded"), { sidebar_density: "cozy" });
});

test("sidebar load preserves explicit legacy widths but resolves missing widths to new defaults without migration writes", async () => {
    const list = fakeSidebarList([]);
    const document = fakeSidebarDocument(list, fakeNode({ id: "workspace-save-status" }));
    const chromeApi = fakeChrome({ sync: { sidebar_expanded_width: 280, sidebar_collapsed_width: 56, sidebar_density: "comfortable" } });
    const controller = popup.createController({ document, window: { location: { search: "" }, addEventListener() {} }, chromeApi, defaults: {} });
    await controller.loadSidebarSettings();
    assert.equal(controller.state.sidebarSettings.sidebar_expanded_width, 280);
    assert.equal(controller.state.sidebarSettings.sidebar_collapsed_width, 56);
    assert.equal(controller.state.sidebarSettings.sidebar_density, "cozy");
    assert.equal(controller.state.sidebarRawPresence.sidebar_expanded_width, true);

    const fresh = popup.createController({
        document: fakeSidebarDocument(fakeSidebarList([]), fakeNode({ id: "workspace-save-status" })),
        window: { location: { search: "" }, addEventListener() {} },
        chromeApi: fakeChrome(),
        defaults: {}
    });
    await fresh.loadSidebarSettings();
    assert.equal(fresh.state.sidebarSettings.sidebar_expanded_width, 180);
    assert.equal(fresh.state.sidebarSettings.sidebar_collapsed_width, 86);
    assert.equal(fresh.state.sidebarRawPresence.sidebar_expanded_width, undefined);
});

test("sidebar page visibility stays separate from order and preserves unknown destinations", async () => {
    const prior = ["courses", "canvas-route:abc123"];
    const document = fakeSidebarDocument(fakeSidebarList([]), fakeNode({ id: "workspace-save-status" }));
    const controller = popup.createController({
        document,
        window: { location: { search: "" }, addEventListener() {} },
        chromeApi: fakeChrome({ sync: { sidebar_page_order: prior, sidebar_page_visibility: { courses: false, "canvas-route:abc123": true } } }),
        defaults: {}
    });
    await controller.loadSidebarSettings();
    assert.deepEqual(controller.state.sidebarOrder, ["courses", "dashboard", "calendar", "inbox", "history", "help", "apstudy:planner", "apstudy:notes", "apstudy:grades", "apstudy:study", "canvas-route:abc123"]);
    assert.equal(controller.state.sidebarVisibility.courses, false);
    assert.equal(controller.state.sidebarVisibility["canvas-route:abc123"], true);
    assert.deepEqual(controller.state.sidebarOrder, controller.state.sidebarSettings.sidebar_page_order);
});

test("course editor is truthful when unavailable and uses account-local storage when a snapshot is exposed", async () => {
    const editor = fakeNode({ id: "sidebar-course-order-editor" });
    const chromeApi = fakeChrome();
    const document = fakeDocument({ "#sidebar-course-order-editor": editor, "#workspace-save-status": fakeNode({ id: "workspace-save-status" }) });
    const controller = popup.createController({ document, window: { location: { search: "" }, addEventListener() {} }, chromeApi, defaults: {} });
    await controller.loadSidebarCourseOrder();
    assert.equal(controller.state.sidebarCourseOrderAvailable, false);

    const accountKey = "a".repeat(64);
    controller.state.canvas = {
        sidebarContext: {
            origin: "https://canvas.emory.edu",
            accountKey,
            courses: [
                { id: "7", name: "Biology", href: "https://canvas.emory.edu/courses/7", color: "#D4AF37", available: true, published: true },
                { id: "8", name: "History", href: "https://canvas.emory.edu/courses/8", available: true, published: true }
            ]
        }
    };
    await controller.loadSidebarCourseOrder();
    assert.equal(controller.state.sidebarCourseOrderAvailable, true);
    assert.deepEqual(controller.state.sidebarCourseOrder, ["7", "8"]);
    await controller.persistSidebarCourseOrder(["8", "7"], "8");
    const localKeys = Object.keys(chromeApi.areas.local);
    assert.equal(localKeys.length, 1);
    assert.deepEqual(chromeApi.areas.local[localKeys[0]], ["8", "7"]);
    assert.equal(Object.keys(chromeApi.areas.sync).length, 0, "course IDs never enter sync settings");
});

test("course-order persistence refreshes the connected Canvas sidebar after its local write", async () => {
    const status = fakeNode({ id: "workspace-save-status" });
    const chromeApi = fakeChrome();
    const messages = [];
    chromeApi.tabs.get = async (id) => ({ id, url: "https://canvas.emory.edu/courses/7" });
    chromeApi.tabs.sendMessage = async (tabId, message, options) => {
        messages.push({ tabId, message, options });
        return { payload: { ok: true, refreshed: true } };
    };
    const controller = popup.createController({ document: fakeDocument({ "#workspace-save-status": status }), window: { location: { search: "" }, addEventListener() {} }, chromeApi, defaults: {} });
    const accountKey = "c".repeat(64);
    controller.state.canvas = {
        state: "connected",
        sourceTabId: 27,
        sidebarContext: {
            origin: "https://canvas.emory.edu", accountKey,
            courses: [
                { id: "7", name: "Biology", href: "https://canvas.emory.edu/courses/7", available: true, published: true },
                { id: "8", name: "History", href: "https://canvas.emory.edu/courses/8", available: true, published: true }
            ]
        }
    };
    await controller.loadSidebarCourseOrder();
    const result = await controller.persistSidebarCourseOrder(["8", "7"]);
    assert.equal(result.appliesNextLoad, false);
    assert.equal(status.textContent, "Saved.");
    assert.deepEqual(messages, [{
        tabId: 27,
        message: { version: 1, request_id: messages[0].message.request_id, type: "SIDEBAR_REFRESH", payload: { reason: "course-order" } },
        options: { frameId: 0 }
    }]);
    assert.match(messages[0].message.request_id, /^popup-sidebar-refresh-[A-Za-z0-9._:-]{1,160}$/);
});

test("course-order persistence falls back to the next Canvas load when no live Canvas tab is available", async () => {
    const status = fakeNode({ id: "workspace-save-status" });
    const chromeApi = fakeChrome();
    const controller = popup.createController({ document: fakeDocument({ "#workspace-save-status": status }), window: { location: { search: "" }, addEventListener() {} }, chromeApi, defaults: {} });
    const accountKey = "d".repeat(64);
    controller.state.canvas = {
        state: "connected",
        sidebarContext: {
            origin: "https://canvas.emory.edu", accountKey,
            courses: [
                { id: "7", name: "Biology", href: "https://canvas.emory.edu/courses/7", available: true, published: true },
                { id: "8", name: "History", href: "https://canvas.emory.edu/courses/8", available: true, published: true }
            ]
        }
    };
    await controller.loadSidebarCourseOrder();
    const result = await controller.persistSidebarCourseOrder(["8", "7"]);
    assert.equal(result.appliesNextLoad, true);
    assert.equal(status.textContent, "Saved. Applies next Canvas load.");
    assert.deepEqual(Object.values(chromeApi.areas.local), [["8", "7"]]);
});

test("sanitized Canvas sidebar context populates unknown pages and supports handle-only drag/drop with rollback", async () => {
    const editor = interactiveNode("section");
    const status = interactiveNode("p");
    let contextListener = null;
    const chromeApi = fakeChrome();
    const document = interactiveSidebarDocument(editor, status);
    const window = {
        location: { search: "" },
        addEventListener(type, callback) { if (type === "apstudycanvas-canvas-context") contextListener = callback; }
    };
    const controller = popup.createController({ document, window, chromeApi, defaults: {} });
    await controller.init();
    const accountKey = "b".repeat(64);
    const sidebarContext = {
        origin: "https://canvas.emory.edu",
        accountKey,
        route: { origin: "https://canvas.emory.edu", pathname: "/courses/7", kind: "course", pageId: "courses", courseId: "7", resource: [] },
        pages: [
            { id: "dashboard", label: "Dashboard", href: "https://canvas.emory.edu/", available: true, source: "canvas", iconRole: "dashboard" },
            { id: "canvas-route:unknown", label: "Assignments", href: "https://canvas.emory.edu/courses/7/assignments", available: true, source: "canvas", iconRole: "canvas" }
        ],
        pageOrder: ["dashboard", "canvas-route:unknown"],
        pageVisibility: {},
        courses: [
            { id: "7", name: "Biology", href: "https://canvas.emory.edu/courses/7", available: true, published: true, color: "#D4AF37" },
            { id: "8", name: "History", href: "https://canvas.emory.edu/courses/8", available: true, published: true, color: "#123456" }
        ],
        courseOrder: ["7", "8"]
    };
    contextListener({ detail: { state: "connected", sourceTabId: 14, contextRevision: 1, canvasBinding: { origin: "https://canvas.emory.edu", accountKey }, sidebarContext } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(controller.state.sidebarPages.map((page) => page.id), ["dashboard", "canvas-route:unknown"]);
    assert.equal(controller.state.sidebarCourseOrderAvailable, true);
    assert.deepEqual(controller.state.sidebarCourseOrder, ["7", "8"]);

    const currentContext = { ...sidebarContext, route: { ...sidebarContext.route, pathname: "/courses/8", courseId: "8" } };
    contextListener({ detail: { state: "connected", sourceTabId: 14, contextRevision: 2, canvasBinding: { origin: "https://canvas.emory.edu", accountKey }, sidebarContext: currentContext } });
    await new Promise((resolve) => setImmediate(resolve));
    contextListener({ detail: { state: "connected", sourceTabId: 14, contextRevision: 1, canvasBinding: { origin: "https://canvas.emory.edu", accountKey }, sidebarContext } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(controller.state.sidebarContextRevision, 2, "older context responses cannot replace the current snapshot");
    assert.equal(controller.state.sidebarCourseOrderKey, `apstudycanvas.sidebar.course-order.v1:${accountKey}`);

    const list = editor.querySelector("ol");
    const first = list.children[0];
    const second = list.children[1];
    const dataTransfer = { setData() {}, effectAllowed: "", dropEffect: "" };
    first.querySelector("[data-sidebar-drag-handle]").dispatch("dragstart", { dataTransfer });
    second.dispatch("dragover", { dataTransfer });
    second.dispatch("drop", { dataTransfer });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(controller.state.sidebarCourseOrder, ["8", "7"]);
    assert.match(Object.keys(chromeApi.areas.local)[0], /^apstudycanvas\.sidebar\.course-order\.v1:b{64}$/);
    assert.equal(editor.querySelector("ol").querySelector('[data-course-id="7"]').focused, true);
    assert.match(status.textContent, /Moved Biology/);

    // Starting a drag from the row itself is ignored; only its handle owns dragstart.
    const currentList = editor.querySelector("ol");
    currentList.children[0].dispatch("dragstart", { dataTransfer });
    currentList.children[1].dispatch("drop", { dataTransfer });
    assert.deepEqual(controller.state.sidebarCourseOrder, ["8", "7"]);

    chromeApi.storage.local.set = () => Promise.reject(new Error("storage down"));
    const rollbackList = editor.querySelector("ol");
    const rollbackHandle = rollbackList.children[0].querySelector("[data-sidebar-drag-handle]");
    const rollbackTarget = rollbackList.children[1];
    rollbackHandle.dispatch("dragstart", { dataTransfer });
    rollbackTarget.dispatch("drop", { dataTransfer });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(controller.state.sidebarCourseOrder, ["8", "7"]);
    assert.match(status.textContent, /reverted/i);
});

test("newly discovered Canvas destinations render in sidebar visibility settings immediately", async () => {
    const list = fakeSidebarList([]);
    const document = fakeSidebarDocument(list, fakeNode({ id: "workspace-save-status" }));
    let contextListener = null;
    const controller = popup.createController({
        document,
        window: {
            location: { search: "" },
            addEventListener(type, callback) {
                if (type === "apstudycanvas-canvas-context") contextListener = callback;
            }
        },
        chromeApi: fakeChrome(),
        defaults: {}
    });
    await controller.init();

    contextListener({
        detail: {
            state: "connected",
            sourceTabId: 14,
            contextRevision: 1,
            sidebarContext: {
                pages: [{ id: "canvas-route:studio", label: "Studio", href: "https://canvas.emory.edu/accounts/1/external_tools/42", available: true }],
                pageVisibility: {}
            }
        }
    });

    assert.ok(list.querySelector('[data-sidebar-page="canvas-route:studio"]'));
});

test("canonical APStudy Page controls keep readable labels in the popup before Canvas context arrives", async () => {
    const list = fakeSidebarList([]);
    const controller = popup.createController({
        document: fakeSidebarDocument(list, fakeNode({ id: "workspace-save-status" })),
        window: { location: { search: "" }, addEventListener() {} },
        chromeApi: fakeChrome(), defaults: {}
    });
    await controller.loadSidebarSettings();
    const labels = ["apstudy:planner", "apstudy:notes", "apstudy:grades", "apstudy:study"].map((id) => list.querySelector(`[data-sidebar-page="${id}"]`).querySelector(".sidebar-page-name").textContent);
    assert.deepEqual(labels, ["Planner", "Notes", "Grades", "Study"]);
});

test("settings store saves immediately after debounce, rolls back only failed field, and flushes", async () => {
    const updates = [];
    let reject = false;
    const store = popup.createSettingsStore({
        sendUpdate: async (changes) => { updates.push(changes); if (reject) throw new Error("fail"); },
        read: async () => ({ dark_mode: false, assignments_due: true }),
        aliases: { gradient_cards: ["gradient_cards", "gradent_cards"] },
        debounceMs: 0
    });
    await store.updateField("dark_mode", true);
    assert.deepEqual(updates[0], { dark_mode: true });
    await store.updateField("gradient_cards", true);
    assert.deepEqual(updates[1], { gradient_cards: true, gradent_cards: true });
    reject = true;
    await assert.rejects(store.updateField("dark_mode", true));
    await store.flush();
    assert.equal(updates.length, 3);
});

test("time controls render time objects for valueless markup and restore invalid input without writing", async () => {
    // Real popup markup uses a valueless data-time-object attribute, which the
    // DOM exposes as dataset.timeObject === "".
    const start = fakeNode({ type: "time", value: "", dataset: { popupSetting: "auto_dark_start", timeObject: "" } });
    const end = fakeNode({ type: "time", value: "21:45", dataset: { popupSetting: "auto_dark_end", timeObject: "true" } });
    const transactions = [];
    const document = fakeDocument({ "#auto-dark-start": start, "#auto-dark-end": end });
    const controller = popup.createController({
        document,
        window: { location: { search: "" }, addEventListener() {} },
        chromeApi: fakeChrome({ sync: {
            auto_dark_start: { hour: "08", minute: "30" },
            auto_dark_end: { hour: "21", minute: "45" }
        } }),
        defaults: {},
        settingsStore: { async transaction(changes) { transactions.push(changes); return {}; } }
    });

    await controller.init();
    assert.equal(start.value, "08:30", "valueless data-time-object renders the canonical hour/minute object");
    assert.equal(end.value, "21:45", "explicit true remains compatible");
    transactions.length = 0;
    start.value = "";
    start.dispatch("change");
    assert.equal(start.value, "08:30");
    end.value = "not-a-time";
    end.dispatch("change");
    assert.equal(end.value, "21:45");
    assert.deepEqual(transactions, []);
});

test("transaction rollback reads the canonical snapshot when no custom reader is supplied", async () => {
    const rollbacks = [];
    const store = popup.createSettingsStore({
        read: async () => ({ auto_dark_start: { hour: "08", minute: "30" } }),
        sendUpdate: async () => ({ ok: false }),
        onRollback: (key, value) => rollbacks.push({ key, value })
    });

    await assert.rejects(store.transaction({ auto_dark_start: { hour: "09", minute: "00" } }));
    assert.deepEqual(rollbacks, [{ key: "auto_dark_start", value: { hour: "08", minute: "30" } }]);
});

test("custom background adjustments follow a valid HTTPS URL across load, change, and rollback", async () => {
    const url = fakeNode({ id: "custom-background-link-workspace", type: "url", value: "", dataset: { popupSetting: "customBackgroundLink" } });
    const opacity = fakeNode({ type: "range", dataset: { popupSetting: "customBackgroundOpacity", backgroundDependent: "" } });
    const blur = fakeNode({ type: "range", dataset: { popupSetting: "customBackgroundBlur", backgroundDependent: "" } });
    const group = fakeNode({ id: "workspace-background-controls" });
    const nodes = {
        "#custom-background-link-workspace": url,
        "#workspace-background-controls": group,
        "#opacity": opacity,
        "#blur": blur
    };
    const document = fakeDocument(nodes);
    const originalQueryAll = document.querySelectorAll;
    document.querySelectorAll = (selector) => selector === "[data-background-dependent]"
        ? [opacity, blur]
        : originalQueryAll(selector);
    let rejectUrlWrite = false;
    const controller = popup.createController({
        document,
        window: { location: { search: "" }, addEventListener() {} },
        chromeApi: fakeChrome({ sync: { customBackgroundLink: "http://example.edu/image.jpg" } }),
        defaults: {},
        settingsStore: {
            async transaction() {
                if (rejectUrlWrite) throw new Error("write failed");
                return {};
            }
        }
    });

    await controller.init();
    [opacity, blur].forEach((control) => {
        assert.equal(control.disabled, true);
        assert.equal(control.getAttribute("aria-disabled"), "true");
    });
    url.value = "https://example.edu/image.jpg";
    url.dispatch("change");
    await new Promise((resolve) => setImmediate(resolve));
    [opacity, blur].forEach((control) => assert.equal(control.disabled, false));
    rejectUrlWrite = true;
    url.value = "https://example.edu/another.jpg";
    url.dispatch("change");
    await new Promise((resolve) => setImmediate(resolve));
    [opacity, blur].forEach((control) => {
        assert.equal(control.disabled, true);
        assert.equal(control.getAttribute("aria-disabled"), "true");
    });
});

test("settings store debounces repeated field edits into one SETTINGS_UPDATE", async () => {
    const updates = [];
    const store = popup.createSettingsStore({ sendUpdate: async (changes) => { updates.push(changes); }, debounceMs: 15 });
    const first = store.updateField("sidebar_density", "compact");
    const second = store.updateField("sidebar_density", "comfortable");
    await new Promise((resolve) => setTimeout(resolve, 30));
    await Promise.all([first, second]);
    assert.deepEqual(updates, [{ sidebar_density: "comfortable" }]);
});

test("category normalization, sidebar keyboard reorder, and persistence helpers", () => {
    assert.equal(popup.normalizedCategory("sidebar"), "sidebar");
    assert.equal(popup.normalizedCategory("legacy"), "overview");
    assert.deepEqual(popup.reorderItems(["dashboard", "courses", "calendar"], 1, "up"), ["courses", "dashboard", "calendar"]);
    assert.deepEqual(popup.reorderItems(["dashboard", "courses", "calendar"], 1, "down"), ["dashboard", "calendar", "courses"]);
});

test("category state is roving only within the sidebar while overview actions stay keyboard-accessible", () => {
    const navOverview = fakeNode({ dataset: { workspaceTarget: "overview" }, attributes: { "aria-current": "page" } });
    const navAppearance = fakeNode({ dataset: { workspaceTarget: "appearance" } });
    const overviewAction = fakeNode({ dataset: { workspaceTarget: "appearance" } });
    navOverview.tabIndex = 0;
    navAppearance.tabIndex = -1;
    overviewAction.tabIndex = 0;
    const overviewSection = fakeNode({ dataset: { category: "overview" } });
    const appearanceSection = fakeNode({ dataset: { category: "appearance" } });
    const document = fakeDocument();
    const workspaceNav = fakeNode();
    const shell = { getBoundingClientRect: () => ({ width: 0 }) };
    const select = fakeNode();
    select.parentElement = {};
    document.activeElement = navOverview;
    workspaceNav.contains = (node) => node === navOverview || node === navAppearance;
    select.focus = () => { document.activeElement = select; };
    document.querySelectorAll = (selector) => {
        if (selector === ".workspace-nav [data-workspace-target]") return [navOverview, navAppearance];
        if (selector === ".workspace-section[data-category]") return [overviewSection, appearanceSection];
        if (selector === "[data-workspace-target]") return [navOverview, navAppearance, overviewAction];
        return [];
    };
    const query = document.querySelector.bind(document);
    document.querySelector = (selector) => {
        if (selector === ".workspace-nav") return workspaceNav;
        if (selector === "#app-scroll") return shell;
        if (selector === "#workspace-category-select") return select;
        return query(selector);
    };
    const controller = popup.createController({
        document,
        window: {
            location: { search: "" },
            addEventListener() {},
            getComputedStyle() { return { display: "none" }; }
        },
        chromeApi: fakeChrome(),
        defaults: {}
    });

    controller.updateCategory("appearance");

    assert.equal(navOverview.tabIndex, -1);
    assert.equal(navOverview.getAttribute("aria-current"), null);
    assert.equal(navAppearance.tabIndex, 0);
    assert.equal(navAppearance.getAttribute("aria-current"), "page");
    assert.equal(overviewAction.tabIndex, 0, "content route actions remain in the normal tab order");
    assert.equal(overviewAction.getAttribute("aria-current"), null, "content route actions never impersonate navigation state");
    assert.equal(overviewSection.hidden, true);
    assert.equal(appearanceSection.hidden, false);
    assert.equal(workspaceNav.inert, false, "a stale zero-width measurement cannot inert a rail CSS keeps visible");
    assert.equal(workspaceNav.getAttribute("aria-hidden"), "false");
    assert.equal(select.tabIndex, -1);
    assert.equal(document.activeElement, navOverview, "the visible rail keeps its current focus");
});

test("profile rendering resolves Nest identity into the sidebar and account identity card", () => {
    const railAvatar = fakeNode({ id: "workspace-account-avatar" });
    const accountAvatar = fakeNode({ id: "account-section-avatar" });
    const railName = fakeNode({ id: "workspace-account-name" });
    const railSource = fakeNode({ id: "workspace-account-source" });
    const railStatus = fakeNode({ id: "workspace-account-status" });
    const accountName = fakeNode({ id: "account-section-name" });
    const accountSource = fakeNode({ id: "account-section-source" });
    const accountStatus = fakeNode({ id: "account-section-status" });
    const accountBinding = fakeNode({ id: "account-section-binding" });
    const nodes = {
        "#workspace-account-avatar": railAvatar,
        "#account-section-avatar": accountAvatar,
        "#workspace-account-name": railName,
        "#workspace-account-source": railSource,
        "#workspace-account-status": railStatus,
        "#account-section-name": accountName,
        "#account-section-source": accountSource,
        "#account-section-status": accountStatus,
        "#account-section-binding": accountBinding
    };
    const controller = popup.createController({ document: fakeDocument(nodes), window: { location: { search: "" }, addEventListener() {} }, chromeApi: fakeChrome(), defaults: {} });
    controller.state.identity = { state: "authenticated", profile: { name: "Nest Student", avatarUrl: "https://nest.example/avatar.png" } };
    controller.state.canvas = { canvasBinding: { accountKey: "verified-account" } };
    controller.state.canvasAccounts = [{ displayName: "Emory Canvas", origin: "https://canvas.emory.edu" }];
    controller.renderProfile();
    assert.equal(railAvatar.dataset.source, "nest");
    assert.equal(accountAvatar.dataset.source, "nest");
    assert.equal(railName.textContent, "Nest Student");
    assert.equal(railSource.textContent, "Nest account");
    assert.equal(railStatus.textContent, "Nest connected");
    assert.equal(accountName.textContent, "Nest Student");
    assert.equal(accountSource.textContent, "Nest account");
    assert.equal(accountStatus.textContent, "Nest connected");
    assert.equal(accountBinding.textContent, "Verified Canvas binding available.");
});

test("account routes replace the deleted profile chrome", () => {
    const fs = require("node:fs");
    const html = fs.readFileSync(require("node:path").resolve(__dirname, "../../html/popup.html"), "utf8");
    assert.doesNotMatch(html, /id="profile-button"/);
    assert.doesNotMatch(html, /id="profile-popover"/);
    assert.match(html, /id="compact-home-trigger"[^>]*data-workspace-target="overview"/);
    assert.match(html, /id="workspace-account-trigger"[^>]*data-workspace-target="calendar-accounts"/);
    assert.doesNotMatch(html, /id="canvas-account-list"/);
    assert.match(html, /id="workspace-canvas-account-list"/);
    assert.match(html, /class="workspace-account-context"[^>]*id="workspace-account-trigger"/);
    assert.match(html, /id="workspace-account-name">Canvas workspace/);
    assert.match(html, /id="workspace-account-source">Local fallback/);
    assert.match(html, /id="workspace-account-status"/);
    assert.doesNotMatch(POPUP_SOURCE, /profile-button|profile-popover/);
});

test("Nest authentication alone controls connection affordances", async () => {
    const onboarding = fakeNode({ id: "nest-onboarding" });
    const primary = fakeNode({ id: "nest-sign-in" });
    const calendar = fakeNode({ id: "calendar-nest-login" });
    const identityCard = fakeNode();
    const nodes = {
        "#nest-onboarding": onboarding,
        "#nest-sign-in": primary,
        "#calendar-nest-login": calendar,
        ".account-identity-card": identityCard
    };
    let identityResponse = { payload: { ok: true, identity: "nest-student", profile: { name: "Nest Student" } } };
    const chromeApi = fakeChrome({ sendMessage: () => identityResponse });
    const controller = popup.createController({ document: fakeDocument(nodes), window: { location: { search: "" }, addEventListener() {} }, chromeApi, defaults: {} });

    await controller.refreshIdentity();
    [onboarding, primary, calendar].forEach((node) => {
        assert.equal(node.hidden, true);
        assert.equal(node.inert, true);
    });
    assert.equal(identityCard.dataset.identityState, "authenticated");

    identityResponse = { payload: { ok: false, code: "TOKEN_EXPIRED" } };
    controller.state.onboardingReady = true;
    await controller.refreshIdentity();
    [primary, calendar].forEach((node) => {
        assert.equal(node.hidden, false);
        assert.equal(node.inert, false);
        assert.equal(node.disabled, false);
    });
    assert.equal(onboarding.hidden, false);
    assert.equal(onboarding.inert, false);
    assert.equal(identityCard.dataset.identityState, "expired");

    identityResponse = { payload: { ok: false, code: "NEST_TRANSPORT_UNAVAILABLE" } };
    await controller.refreshIdentity();
    [onboarding, primary, calendar].forEach((node) => {
        assert.equal(node.hidden, false, "connection failure must retain a sign-in recovery action");
        assert.equal(node.inert, false);
    });
    assert.equal(identityCard.dataset.identityState, "unavailable");
});

test("transaction helper applies import/reset batches atomically and no-Canvas state is explicit", async () => {
    const updates = [];
    const store = popup.createSettingsStore({ sendUpdate: async (changes) => { updates.push(changes); }, debounceMs: 0 });
    await store.transaction({ dark_mode: false, sidebar_density: "compact" });
    assert.deepEqual(updates, [{ dark_mode: false, sidebar_density: "compact" }]);
    const notice = fakeNode({ id: "no-canvas-notice" });
    const document = fakeDocument({ "#no-canvas-notice": notice });
    const controller = popup.createController({ document, window: { location: { search: "" }, addEventListener() {} }, chromeApi: fakeChrome(), defaults: {} });
    controller.renderCanvasAvailability();
    assert.match(notice.textContent, /No Canvas tab is open/);
    assert.equal(notice.hidden, false);
});

test("theme import isolation excludes per-account Canvas sync opt-in", () => {
    const accountKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    assert.equal(popup.validateImportData({ canvas_sync_opt_in: { [accountKey]: true } }), false);
    assert.equal(popup.validateImportData({ remind: true }), false, "retired reminder keys cannot enter a theme import");
    assert.equal(popup.validateImportData({ reminder_count: 2 }), false, "retired reminder data cannot enter a theme import");
    assert.equal(popup.validateImportData({ dark_mode: false }), true);
});

test("sidebar order persists as a single field update", async () => {
    const updates = [];
    const store = popup.createSettingsStore({ sendUpdate: async (changes) => { updates.push(changes); }, debounceMs: 0 });
    const next = popup.reorderItems(["dashboard", "courses", "calendar"], 2, "up");
    await store.updateField("sidebar_page_order", next);
    assert.deepEqual(updates, [{ sidebar_page_order: ["dashboard", "calendar", "courses"] }]);
});

test("rejected sidebar persistence restores canonical order, callback metadata, DOM focus, and status", async () => {
    const prior = ["dashboard", "courses", "calendar", "inbox", "history", "help"];
    const canonicalPrior = popup.normalizeSidebarOrder(prior);
    const list = fakeSidebarList(prior.map((page) => fakeSidebarRow(page)));
    const status = fakeNode({ id: "workspace-save-status" });
    const document = fakeSidebarDocument(list, status);
    const settingsStore = { updateField: async () => { throw new Error("SIDEBAR_WRITE_FAILED"); } };
    const chromeApi = {
        runtime: { sendMessage: async () => ({ ok: true }) },
        storage: { sync: { get: async () => ({ sidebar_page_order: prior }), set: async () => {} }, local: { get: async () => ({}) } }
    };
    const controller = popup.createController({
        document,
        window: { location: { search: "" }, addEventListener() {} },
        chromeApi,
        defaults: {},
        settingsStore
    });
    await controller.loadSidebarSettings();

    const next = popup.reorderItems(prior, 1, "up");
    let rollbackOrder;
    let rollbackError;
    let callbackResult;
    let thrown;
    try {
        await controller.persistSidebarOrder(next, "courses", {
            onRollback: (restoredOrder, error) => {
                rollbackOrder = restoredOrder;
                rollbackError = error;
            },
            onResult: (result) => { callbackResult = result; }
        });
        assert.fail("persistSidebarOrder should reject when persistence fails");
    } catch (error) {
        thrown = error;
    }

    assert.deepEqual(list.children.map((row) => row.dataset.sidebarPage), canonicalPrior);
    assert.deepEqual(controller.state.sidebarOrder, canonicalPrior);
    assert.deepEqual(controller.state.persistedSidebarOrder, canonicalPrior);
    assert.deepEqual(rollbackOrder, canonicalPrior);
    assert.equal(rollbackError, thrown);
    assert.equal(callbackResult, thrown.result);
    assert.equal(callbackResult.ok, false);
    assert.deepEqual(callbackResult.restoredOrder, canonicalPrior);
    assert.deepEqual(callbackResult.order, canonicalPrior);
    assert.equal(callbackResult.current, true);
    assert.equal(callbackResult.operationId, thrown.operationId);
    assert.equal(thrown.current, true);
    assert.deepEqual(thrown.restoredOrder, canonicalPrior);
    assert.equal(list.querySelector('[data-sidebar-page="courses"]').focused, true);
    assert.equal(status.textContent, "Failed — changes reverted.");
});

test("embedded compact-expand stays hidden, unfocusable, and unbound", async () => {
    const srLabel = { textContent: "Enter fullscreen" };
    const expand = fakeNode({
        id: "compact-expand",
        attributes: { "aria-label": "Enter fullscreen", "aria-pressed": "false", title: "Enter fullscreen" }
    });
    expand.querySelector = (selector) => selector === ".sr-only" ? srLabel : null;
    const chromeApi = fakeChrome();
    const controller = popup.createController({
        document: fakeDocument({ "#compact-expand": expand }),
        window: { location: { search: "?embedded=1" }, addEventListener() {} },
        chromeApi,
        defaults: {}
    });
    await controller.init();
    assert.equal(expand.hidden, true);
    assert.equal(expand.listenerCount("click"), 0);
    assert.equal(expand.getAttribute("aria-label"), null);
    assert.equal(expand.getAttribute("aria-pressed"), null);
    assert.equal(expand.getAttribute("title"), null);
    assert.equal(srLabel.textContent, "");
    expand.dispatch("click");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(chromeApi.calls.some((message) => message.type === "OVERLAY_CONTROL" && message.payload?.action === "fullscreen"), false);
});

test("tab and popup hosts hide the compact-expand control", async () => {
    for (const search of ["", "?view=workspace", "?fullscreen=1"]) {
        const expand = fakeNode({ id: "compact-expand" });
        const controller = popup.createController({
            document: fakeDocument({ "#compact-expand": expand }),
            window: { location: { search }, addEventListener() {} },
            chromeApi: fakeChrome(),
            defaults: {}
        });
        await controller.init();
        assert.equal(expand.hidden, true, search || "popup");
    }
});

test("one fullscreen Canvas context event reaches calendar and base popup handlers", async () => {
    const listeners = new Map();
    const win = {
        location: { search: "?fullscreen=1&sourceCanvasTabId=19" },
        addEventListener(type, callback) {
            const callbacks = listeners.get(type) || [];
            callbacks.push(callback);
            listeners.set(type, callbacks);
        },
        removeEventListener() {}
    };
    const notice = fakeNode({ id: "no-canvas-notice" });
    const document = fakeDocument({ "#no-canvas-notice": notice });
    const chromeApi = fakeChrome();
    const controller = popup.createController({ document, window: win, chromeApi, defaults: {} });
    const popupRuntime = loadPopupCalendarControllerFactory({ document, window: win, chromeApi });
    const calendar = popupRuntime.createPopupCalendarController({ controller, document, window: win });

    await controller.init();
    const detailValue = {
        state: "connected",
        profile: { displayName: "Canvas Student", avatarUrl: "https://cdn.example/avatar.png" },
        unread: { count: 4, categories: { conversations: 4 } },
        canvasBinding: {
            origin: "https://canvas.example.edu",
            canvasUserId: "student-1",
            accountKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            sourceKey: "canvas:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            label: "Canvas Student",
            extraction: "supported"
        },
        sourceTabId: 19
    };
    const detail = vm.runInContext(`JSON.parse(${JSON.stringify(JSON.stringify(detailValue))})`, popupRuntime.context);
    assert.deepEqual(popupRuntime.normalizeCanvasBinding({ ok: true, state: "connected", origin: detail.canvasBinding.origin, canvasBinding: detail.canvasBinding }, detail.profile), detail.canvasBinding);
    assert.deepEqual(JSON.parse(JSON.stringify(popupRuntime.popupCalendarContextFromEvent(detail))), {
        state: "connected",
        binding: JSON.parse(JSON.stringify(detail.canvasBinding))
    });
    const event = {
        detail,
        stopPropagation() { this.propagationStopped = true; },
        stopImmediatePropagation() { this.immediatePropagationStopped = true; }
    };
    for (const callback of listeners.get("apstudycanvas-canvas-context") || []) {
        callback(event);
        if (event.immediatePropagationStopped) break;
    }

    assert.equal(event.propagationStopped, true);
    assert.equal(event.immediatePropagationStopped, undefined);
    assert.equal(calendar.state.contextState, "connected", JSON.stringify(calendar.state.binding));
    assert.equal(calendar.state.binding.accountKey, detail.canvasBinding.accountKey);
    assert.deepEqual(controller.state.canvas, {
        state: "connected",
        profile: detail.profile,
        unread: detail.unread,
        canvasBinding: detail.canvasBinding,
        sourceTabId: 19
    });
    assert.equal(document.body.dataset.mode, "workspace");
    assert.equal(notice.hidden, true);
});

test("missing or untrusted Canvas source context is reduced to null and fails safely", async () => {
    const listeners = {};
    const chromeApi = fakeChrome();
    const win = {
        location: { search: "" },
        addEventListener(type, callback) { listeners[type] = callback; },
        removeEventListener() {}
    };
    const controller = popup.createController({ document: fakeDocument({ "#fullscreen-status": fakeNode({ id: "fullscreen-status" }), "#workspace-error-area": fakeNode({ id: "workspace-error-area" }) }), window: win, chromeApi, defaults: {} });
    await controller.init();
    listeners["apstudycanvas-canvas-context"]({ detail: { state: "connected", sourceTabId: "19" } });
    assert.equal(controller.state.canvas.sourceTabId, null);
    assert.match(controller.state.canvas.sourceTabId === null ? "safe" : "unsafe", /safe/);
});

test("calendar selectors remain disabled until projection capability is live", async () => {
    const chromeApi = fakeChrome({ local: { "platform.flags": { projection: false } } });
    const nodes = { "#calendar-capability-status": fakeNode({ id: "calendar-capability-status" }), "#calendar-routing-controls": fakeNode({ id: "calendar-routing-controls" }) };
    const controller = popup.createController({ document: fakeDocument(nodes), window: { location: { search: "" }, addEventListener() {} }, chromeApi, defaults: {} });
    await controller.loadCalendars();
    assert.equal(nodes["#calendar-routing-controls"].hidden, true);
});

test("background preset controls preserve their own preset binding", () => {
    const controllerSource = fs.readFileSync(path.join(__dirname, "../../js/popup-controller.js"), "utf8");
    assert.match(controllerSource, /button\.addEventListener\("click", \(\) => appearance\.applyBackground\(preset\)/);
    assert.doesNotMatch(controllerSource, /preset = presets\[e\.target\.id\]/);
});

test("annotateReloadApplyReasons labels every reload-classified control", () => {
    const schema = { reloadApplyReason: (key) => key === "assignments_due" ? "Loads planner items from the Canvas API." : null, reloadApplyReasons: { assignments_due: "Loads planner items from the Canvas API." } };
    const hintHost = {
        children: [],
        querySelector(selector) { return selector === "small" ? this.small : null; },
        appendChild(node) { this.children.push(node); this.small = node; return node; }
    };
    const control = fakeNode({ dataset: { popupSetting: "assignments_due" } });
    control.closest = () => hintHost;
    control.matches = () => true;
    const documentRef = {
        querySelectorAll(selector) {
            if (selector.includes("data-popup-setting")) return [control];
            return [];
        },
        getElementById() { return null; },
        querySelector() { return null; },
        createElement(tag) { return fakeNode({ id: tag }); }
    };
    const count = popup.annotateReloadApplyReasons(documentRef, schema);
    assert.ok(count >= 1);
    assert.equal(control.getAttribute("aria-describedby").includes("reload-reason-assignments_due"), true);
    assert.match(hintHost.small.textContent, /Needs a Canvas refresh/);
});

test("enabling To-do course-card tasks or Due dates persists the other one false in both directions", async () => {
    const todo = fakeNode({ id: "todo_course_card_tasks_enabled", type: "checkbox", checked: false, dataset: { popupSetting: "todo_course_card_tasks_enabled" } });
    const due = fakeNode({ id: "assignments_due", type: "checkbox", checked: true, dataset: { popupSetting: "assignments_due" } });
    const document = fakeDocument({ "#todo_course_card_tasks_enabled": todo, "#assignments_due": due });
    const transactions = [];
    const controller = popup.createController({
        document,
        window: { location: { search: "" }, addEventListener() {} },
        chromeApi: fakeChrome(),
        defaults: {},
        settingsStore: {
            async transaction(changes) { transactions.push(changes); return {}; },
            async updateField(key, value) { transactions.push({ [key]: value }); return {}; },
            async flush() { return {}; }
        }
    });
    await controller.init();
    let cursor = 0;
    const writeFor = (key) => {
        const found = transactions.slice(cursor).find((changes) => Object.prototype.hasOwnProperty.call(changes, key));
        cursor = transactions.indexOf(found) + 1;
        return found;
    };

    todo.checked = true;
    todo.dispatch("change");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(writeFor("todo_course_card_tasks_enabled"), { todo_course_card_tasks_enabled: true, assignments_due: false }, "enabling To-do tasks must persist Due off");
    assert.equal(due.checked, false, "the Due control is flipped off alongside the write");

    due.checked = true;
    due.dispatch("change");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(writeFor("assignments_due"), { assignments_due: true, todo_course_card_tasks_enabled: false }, "enabling Due must persist To-do tasks off");
    assert.equal(todo.checked, false, "the To-do control is flipped off alongside the write");
});

test("settings hydration gates controls while optional identity lookup cannot delay readiness", async () => {
    let release;
    const saved = new Promise((resolve) => { release = resolve; });
    const toggle = fakeNode({ type: "checkbox", dataset: { popupSetting: "dark_mode" } });
    const map = fakeNode();
    const chromeApi = fakeChrome({ sendMessage: (message) => message.type === "NEST_IDENTITY_GET" ? new Promise(() => {}) : { ok: true } });
    chromeApi.storage.sync.get = () => saved;
    const document = fakeDocument({ "#dark": toggle, ".workspace-category-map": map });
    const controller = popup.createController({ document, window: { location: { search: "" }, addEventListener() {} }, chromeApi, defaults: { dark_mode: false } });
    const pending = controller.init();
    assert.equal(map.inert, true);
    assert.equal(map.getAttribute("aria-busy"), "true");
    release({ dark_mode: true });
    await pending;
    assert.equal(toggle.checked, true);
    assert.equal(map.inert, false);
    assert.equal(document.body.dataset.settingsState, "ready");
    assert.equal(controller.state.accountLoading, true);
});

test("failed persisted-settings reads keep the map inert and expose recovery instead of usable defaults", async () => {
    const map = fakeNode();
    const errorArea = fakeNode();
    const toggle = fakeNode({ type: "checkbox", dataset: { popupSetting: "dark_mode" } });
    const chromeApi = fakeChrome();
    chromeApi.storage.sync.get = async () => { throw new Error("STORAGE_UNAVAILABLE"); };
    const document = fakeDocument({ ".workspace-category-map": map, "#dark": toggle, "#workspace-error-area": errorArea });
    const controller = popup.createController({ document, window: { location: { search: "" }, addEventListener() {} }, chromeApi, defaults: { dark_mode: true } });
    await assert.rejects(controller.init(), /STORAGE_UNAVAILABLE/);
    assert.equal(map.inert, true);
    assert.equal(document.body.dataset.settingsState, "error");
    assert.equal(errorArea.hidden, false);
    assert.equal(toggle.checked, false);
});

test("compact Back restores list scroll and focus, and resizing preserves category and drafts", async () => {
    const nav = fakeNode(), sidebar = fakeNode(), content = fakeNode(), back = fakeNode();
    const appearance = fakeNode({ dataset: { workspaceTarget: "appearance" } });
    const section = fakeNode({ dataset: { category: "appearance" } });
    const document = fakeDocument({ ".workspace-nav": nav, ".workspace-sidebar": sidebar, ".workspace-content": content, "#workspace-back": back, '#workspace-section-appearance': section, '.workspace-nav [data-workspace-target="appearance"]': appearance });
    const queryAll = document.querySelectorAll.bind(document);
    document.querySelectorAll = (selector) => selector === '.workspace-nav [data-workspace-target]' || selector === '[data-workspace-target]' ? [appearance] : selector === '.workspace-section[data-category]' ? [section] : queryAll(selector);
    nav.contains = (node) => node === appearance;
    sidebar.contains = nav.contains;
    content.contains = (node) => node === section || node === back;
    [appearance, section, back].forEach((node) => { node.focus = () => { document.activeElement = node; }; });
    let compact = true;
    const controller = popup.createController({ document, window: { location: { search: "" }, addEventListener() {}, getComputedStyle: () => ({ display: compact ? "inline-flex" : "none" }) }, chromeApi: fakeChrome() });
    await controller.init();
    controller.showCategoryList();
    nav.scrollTop = 173;
    appearance.focus();
    appearance.dispatch("click");
    assert.equal(document.body.dataset.navigationPage, "detail");
    assert.equal(controller.state.category, "appearance");
    assert.equal(sidebar.inert, true);
    controller.state.modernDarkPaletteDraft = { surface: "#123456" };
    compact = false;
    controller.syncWorkspaceNavigationMode();
    assert.equal(sidebar.inert, false);
    compact = true;
    controller.syncWorkspaceNavigationMode();
    assert.equal(document.body.dataset.navigationPage, "detail");
    back.dispatch("click");
    assert.equal(document.body.dataset.navigationPage, "list");
    assert.equal(document.activeElement, appearance);
    assert.equal(nav.scrollTop, 173);
    assert.deepEqual(controller.state.modernDarkPaletteDraft, { surface: "#123456" });
    assert.equal(content.inert, true);
    await controller.init();
    assert.equal(back.listenerCount("click"), 1);
});

test("a stalled settings read reaches recoverable error instead of indefinite loading", async () => {
    const timers = new Map();
    let nextTimer = 0;
    const map = fakeNode();
    const chromeApi = fakeChrome();
    chromeApi.storage.sync.get = () => new Promise(() => {});
    const document = fakeDocument({ ".workspace-category-map": map });
    const controller = popup.createController({ document, chromeApi, window: {
        location: { search: "" }, addEventListener() {},
        setTimeout(callback) { const id = ++nextTimer; timers.set(id, callback); return id; },
        clearTimeout(id) { timers.delete(id); }
    } });
    const loading = controller.init();
    const failure = assert.rejects(loading, /timed out/);
    await Promise.resolve();
    [...timers.values()].forEach((callback) => callback());
    await failure;
    assert.equal(map.inert, true);
    assert.equal(document.body.dataset.settingsState, "error");
});

test("optional account retry is single-flight and clears its inline error after recovery", async () => {
    let recover = false;
    const chromeApi = fakeChrome({ sendMessage: () => recover ? { state: "signed_out" } : { ok: false, code: "NEST_OFFLINE" } });
    const message = fakeNode(), retry = fakeNode(), lookupRow = fakeNode();
    const controller = popup.createController({ document: fakeDocument({ ".account-lookup-row": lookupRow, "#workspace-account-loading": message, "#workspace-account-retry": retry }), chromeApi, window: { location: { search: "" }, addEventListener() {} } });
    await controller.init();
    const first = controller.state.accountLoadPromise;
    assert.equal(controller.loadOptionalAccounts(), first);
    await first;
    assert.equal(retry.hidden, false);
    assert.equal(lookupRow.hidden, false, "a failed optional lookup keeps its recovery row visible");
    assert.match(message.textContent, /settings still work/);
    recover = true;
    retry.dispatch("click");
    await controller.state.accountLoadPromise;
    assert.equal(retry.hidden, true);
    assert.equal(lookupRow.hidden, true, "a recovered lookup removes the inline recovery row");
    assert.equal(message.textContent, "");
    assert.equal(chromeApi.calls.filter((call) => call.type === "NEST_IDENTITY_GET").length, 2);
});

test("sign-in reuses its Nest tab and completion refreshes identity without reopening settings", async () => {
    const listeners = new Map();
    let tabUpdated;
    let current = { ok: false, status: 401 };
    const chromeApi = fakeChrome({ sendMessage: (message) => message.type === "NEST_IDENTITY_GET" ? current : { ok: true } });
    const activations = [];
    chromeApi.tabs.get = async () => ({ id: 12, url: "https://nest.apstudy.org/extension/connect" });
    chromeApi.tabs.update = async (id, details) => { activations.push({ id, details }); return { id }; };
    chromeApi.tabs.onUpdated = { addListener(fn) { tabUpdated = fn; }, removeListener() {} };
    chromeApi.tabs.onRemoved = { addListener() {}, removeListener() {} };
    const controller = popup.createController({ document: fakeDocument(), window: { location: { search: "" }, addEventListener(type, fn) { listeners.set(type, fn); } }, chromeApi });
    await controller.init();
    await controller.loadOptionalAccounts();
    await Promise.all([controller.openNestLogin(), controller.openNestLogin()]);
    await controller.openNestLogin();
    assert.equal(chromeApi.calls.filter((call) => call.tabsCreate).length, 1);
    assert.equal(activations.length, 1);
    current = { ok: true, body: { state: "authenticated", profile: { id: "nest-user", displayName: "Student" } } };
    tabUpdated(12, { status: "complete" }, { url: "https://nest.apstudy.org/extension/connect" });
    await controller.loadOptionalAccounts();
    assert.equal(controller.state.identity.state, "authenticated");
    current = { ok: false, status: 401 };
    listeners.get("focus")();
    await controller.loadOptionalAccounts();
    assert.equal(controller.state.identity.state, "signed_out");
    listeners.get("pagehide")();
});
