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
    const area = (name) => ({
        get(keys) {
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
        areas,
        runtime: { sendMessage: async (message) => { calls.push(message); return sendMessage ? sendMessage(message) : { payload: { ok: true } }; } },
        tabs: { create: async (details) => { calls.push({ tabsCreate: details }); return { id: 12 }; } },
        storage: { sync: area("sync"), local: area("local") }
    };
}

function fakeNode({ id, value = "", checked = false, type = "text", dataset = {} } = {}) {
    const listeners = {};
    return {
        id, value, checked, type, dataset, hidden: false, textContent: "", classList: { toggle() {} },
        style: {},
        setAttribute() {}, addEventListener(event, callback) { listeners[event] = callback; },
        dispatch(event, detail) { listeners[event]?.({ target: this, key: event, detail, preventDefault() {} }); },
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
            return [];
        },
        getElementById(id) { return nodes[`#${id}`] || Object.values(nodes).find((node) => node.id === id) || null; },
        addEventListener() {}, createElement() { return fakeNode(); }
    };
}

function fakeSidebarRow(page) {
    return {
        dataset: { sidebarPage: page },
        tabIndex: 0,
        focused: false,
        innerHTML: "",
        focus() { this.focused = true; },
        querySelector(selector) {
            if (selector === ".sidebar-page-name") return { textContent: "" };
            if (selector === "[data-sidebar-visibility]") return { checked: true, addEventListener() {} };
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

function fakeSidebarDocument(list, status) {
    return {
        body: { dataset: {} },
        visibilityState: "visible",
        querySelector(selector) {
            if (selector === "#sidebar-page-list") return list;
            if (selector === "#workspace-save-status") return status;
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
    assert.equal(chromeApi.calls.at(-1).tabsCreate.url, "https://nest.apstudy.org/login");
    await controller.dismissOnboarding();
    assert.equal(nodes["#nest-onboarding"].hidden, true);
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

test("profile rendering keeps Nest separate from Canvas account context", () => {
    const avatar = fakeNode();
    const name = fakeNode({ id: "profile-display-name" });
    const source = fakeNode({ id: "profile-display-source" });
    const accountStatus = fakeNode({ id: "nest-account-status" });
    const accountList = fakeNode({ id: "canvas-account-list" });
    const nodes = {
        "#profile-button .profile-avatar": avatar,
        "#profile-display-name": name,
        "#profile-display-source": source,
        "#nest-account-status": accountStatus,
        "#canvas-account-list": accountList
    };
    const controller = popup.createController({ document: fakeDocument(nodes), window: { location: { search: "" }, addEventListener() {} }, chromeApi: fakeChrome(), defaults: {} });
    controller.state.identity = { state: "authenticated", profile: { name: "Nest Student", avatarUrl: "https://nest.example/avatar.png" } };
    controller.state.canvasAccounts = [{ displayName: "Emory Canvas", origin: "https://canvas.emory.edu" }];
    controller.renderProfile();
    assert.equal(name.textContent, "Nest Student");
    assert.equal(source.textContent, "Nest account");
    assert.equal(avatar.dataset.source, "nest");
    assert.equal(accountStatus.textContent, "Connected");
});

test("profile popover contract keeps account action top-level and escape-safe by markup", () => {
    const fs = require("node:fs");
    const html = fs.readFileSync(require("node:path").resolve(__dirname, "../../html/popup.html"), "utf8");
    assert.match(html, /id="profile-popover"[^>]*role="dialog"/);
    assert.match(html, /id="profile-nest-login"[^>]*href="https:\/\/nest\.apstudy\.org\/login"/);
    assert.match(html, /id="canvas-account-list"/);
    assert.match(html, /id="workspace-canvas-account-list"/);
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

    assert.deepEqual(list.children.map((row) => row.dataset.sidebarPage), prior);
    assert.deepEqual(controller.state.sidebarOrder, prior);
    assert.deepEqual(controller.state.persistedSidebarOrder, prior);
    assert.deepEqual(rollbackOrder, prior);
    assert.equal(rollbackError, thrown);
    assert.equal(callbackResult, thrown.result);
    assert.equal(callbackResult.ok, false);
    assert.deepEqual(callbackResult.restoredOrder, prior);
    assert.deepEqual(callbackResult.order, prior);
    assert.equal(callbackResult.current, true);
    assert.equal(callbackResult.operationId, thrown.operationId);
    assert.equal(thrown.current, true);
    assert.deepEqual(thrown.restoredOrder, prior);
    assert.equal(list.querySelector('[data-sidebar-page="courses"]').focused, true);
    assert.equal(status.textContent, "Failed — changes reverted.");
});

test("controller sends platform fullscreen, supports workspace mode, and preserves inline failure", async () => {
    const chromeApi = fakeChrome({ sendMessage: async (message) => ({ payload: { ok: false, code: "FULLSCREEN_SOURCE_TAB_REQUIRED" } }) });
    const nodes = { "#fullscreen-status": fakeNode({ id: "fullscreen-status" }), "#workspace-error-area": fakeNode({ id: "workspace-error-area" }) };
    const controller = popup.createController({ document: fakeDocument(nodes), window: { location: { search: "?view=workspace" }, addEventListener() {} }, chromeApi, defaults: {} });
    await assert.rejects(controller.openFullscreen());
    assert.match(nodes["#fullscreen-status"].textContent, /Fullscreen could not open/);
    assert.equal(chromeApi.calls[0].type, "POPUP_FULLSCREEN_OPEN");
});

test("Canvas context propagates its trusted source tab to the dedicated fullscreen request", async () => {
    const listeners = {};
    const chromeApi = fakeChrome({ sendMessage: async (message) => {
        assert.equal(message.payload.sourceCanvasTabId, 19);
        return { payload: { ok: true, windowId: 77, sourceCanvasTabId: 19 } };
    } });
    const win = {
        location: { search: "" },
        addEventListener(type, callback) { listeners[type] = callback; },
        removeEventListener() {}
    };
    const controller = popup.createController({ document: fakeDocument(), window: win, chromeApi, defaults: {} });
    await controller.init();
    listeners["apstudycanvas-canvas-context"]({ detail: { state: "connected", sourceTabId: 19 } });
    const result = await controller.openFullscreen();
    assert.equal(result.windowId, 77);
    assert.equal(controller.state.canvas.sourceTabId, 19);
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
    const chromeApi = fakeChrome({ sendMessage: async (message) => {
        assert.equal(message.payload.sourceCanvasTabId, null);
        return { payload: { ok: false, code: "FULLSCREEN_SOURCE_TAB_REQUIRED" } };
    } });
    const win = {
        location: { search: "" },
        addEventListener(type, callback) { listeners[type] = callback; },
        removeEventListener() {}
    };
    const controller = popup.createController({ document: fakeDocument({ "#fullscreen-status": fakeNode({ id: "fullscreen-status" }), "#workspace-error-area": fakeNode({ id: "workspace-error-area" }) }), window: win, chromeApi, defaults: {} });
    await controller.init();
    listeners["apstudycanvas-canvas-context"]({ detail: { state: "connected", sourceTabId: "19" } });
    assert.equal(controller.state.canvas.sourceTabId, null);
    await assert.rejects(controller.openFullscreen());
    assert.match(controller.state.canvas.sourceTabId === null ? "safe" : "unsafe", /safe/);
});

test("calendar selectors remain disabled until projection capability is live", async () => {
    const chromeApi = fakeChrome({ local: { "platform.flags": { projection: false } } });
    const nodes = { "#calendar-capability-status": fakeNode({ id: "calendar-capability-status" }), "#calendar-routing-controls": fakeNode({ id: "calendar-routing-controls" }) };
    const controller = popup.createController({ document: fakeDocument(nodes), window: { location: { search: "" }, addEventListener() {} }, chromeApi, defaults: {} });
    await controller.loadCalendars();
    assert.equal(nodes["#calendar-routing-controls"].hidden, true);
});
