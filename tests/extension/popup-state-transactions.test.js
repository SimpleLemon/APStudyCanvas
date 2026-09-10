"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const popup = require("../../js/popup-controller.js");

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((nextResolve, nextReject) => {
        resolve = nextResolve;
        reject = nextReject;
    });
    return { promise, resolve, reject };
}

function fakeNode({ id, type = "text" } = {}) {
    return {
        id, type, value: "", checked: false, hidden: false, textContent: "", dataset: {}, style: {},
        classList: { toggle() {} }, setAttribute() {}, removeAttribute() {}, focus() {},
        addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; },
        replaceChildren() {}, appendChild() {}
    };
}

function fakeDocument(nodes = {}) {
    return {
        body: { dataset: {} }, visibilityState: "visible",
        querySelector(selector) { return nodes[selector] || null; },
        querySelectorAll() { return []; },
        getElementById(id) { return nodes[`#${id}`] || null; },
        addEventListener() {}, createElement() { return fakeNode(); }
    };
}

function fakeChrome(sendMessage, { sync = {}, local = {} } = {}) {
    const areas = { sync: { ...sync }, local: { ...local } };
    const area = (name) => ({
        get(keys) {
            const source = areas[name];
            if (keys === null || keys === undefined) return Promise.resolve({ ...source });
            const list = Array.isArray(keys) ? keys : [keys];
            return Promise.resolve(Object.fromEntries(list.filter((key) => Object.prototype.hasOwnProperty.call(source, key)).map((key) => [key, source[key]])));
        },
        set(changes) { Object.assign(areas[name], changes); return Promise.resolve(); },
        remove(keys) { (Array.isArray(keys) ? keys : [keys]).forEach((key) => delete areas[name][key]); return Promise.resolve(); }
    });
    return {
        runtime: { sendMessage: (message) => sendMessage(message) },
        storage: { sync: area("sync"), local: area("local") },
        tabs: { create: async () => ({ id: 1 }) }
    };
}

function controllerWith(sendMessage, options = {}) {
    return popup.createController({
        document: fakeDocument(options.nodes),
        window: { location: { search: "" }, addEventListener() {}, open() {} },
        chromeApi: fakeChrome(sendMessage, options),
        defaults: {},
        settingsStore: options.settingsStore
    });
}

function categoryNode(category) {
    const attributes = new Map();
    const classes = new Set();
    return {
        dataset: { workspaceTarget: category },
        tabIndex: 0,
        classList: { toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); }, contains(name) { return classes.has(name); } },
        setAttribute(name, value) { attributes.set(name, String(value)); },
        removeAttribute(name) { attributes.delete(name); },
        hasAttribute(name) { return attributes.has(name); },
        getAttribute(name) { return attributes.get(name) ?? null; }
    };
}

test("identity generation prevents late prior identity, consent, and calendar responses from restoring state", async () => {
    const firstIdentity = deferred();
    const secondIdentity = deferred();
    const oldConsent = deferred();
    const oldCalendars = deferred();
    let identityCalls = 0;
    const chromeMessage = (message) => {
        if (message.type === "NEST_IDENTITY_GET") {
            identityCalls += 1;
            return identityCalls === 1 ? firstIdentity.promise : secondIdentity.promise;
        }
        if (message.type === "NEST_CONSENT_GET") return oldConsent.promise;
        if (message.type === "NEST_CALENDARS_GET") return oldCalendars.promise;
        return { ok: true };
    };
    const controller = controllerWith(chromeMessage, { local: { "platform.flags": { projection: true } } });
    controller.state.identity = { state: "authenticated", identity: "old-user", profile: { name: "Old User" } };
    controller.state.identityUserKey = "old-user";
    controller.state.identityGeneration = 20;
    controller.state.consent = { granted: true };
    controller.state.calendars = { ok: true, calendars: [{ id: "old" }] };
    controller.state.nestLinkedAccounts = [{ id: "old-linked" }];

    const firstRefresh = controller.refreshIdentity();
    assert.equal(controller.state.consent, null, "refresh clears Nest-derived state immediately");
    assert.equal(controller.state.calendars, null);
    assert.deepEqual(controller.state.nestLinkedAccounts, []);
    const secondRefresh = controller.refreshIdentity();
    secondIdentity.resolve({ ok: false, status: 401 });
    await secondRefresh;
    firstIdentity.resolve({ ok: true, identity: "old-user", profile: { name: "Old User" }, linkedAccounts: [{ id: "late" }] });
    await firstRefresh;
    assert.equal(controller.state.identity.state, "signed_out");
    assert.equal(controller.state.identityUserKey, "");
    assert.equal(controller.state.consent, null);
    assert.equal(controller.state.calendars, null);
    assert.deepEqual(controller.state.nestLinkedAccounts, []);

    controller.state.identity = { state: "authenticated", identity: "old-user", profile: { name: "Old User" } };
    controller.state.identityUserKey = "old-user";
    controller.state.identityGeneration = 30;
    const consentLoad = controller.loadConsent(30, "old-user");
    const calendarLoad = controller.loadCalendars(30, "old-user");
    controller.state.identityGeneration = 31;
    controller.state.identity = { state: "signed_out", profile: null };
    controller.state.identityUserKey = "";
    oldConsent.resolve({ ok: true, granted: true });
    oldCalendars.resolve({ ok: true, calendars: [{ id: "late" }] });
    assert.equal(await consentLoad, null);
    assert.equal(await calendarLoad, null);
    assert.equal(controller.state.consent, null);
    assert.equal(controller.state.calendars, null);
});

test("consent set requires the current authenticated identity and discards late completion after sign out", async () => {
    const consentSet = deferred();
    const controller = controllerWith((message) => {
        if (message.type === "NEST_CONSENT_SET") return consentSet.promise;
        if (message.type === "NEST_IDENTITY_GET") return Promise.resolve({ ok: false, status: 401 });
        return { ok: true };
    });
    controller.state.identity = { state: "authenticated", identity: "acct-1", profile: { name: "User" } };
    controller.state.identityUserKey = "acct-1";
    controller.state.identityGeneration = 8;
    const pending = controller.setConsent(true);
    await new Promise((resolve) => setImmediate(resolve));
    await controller.refreshIdentity();
    consentSet.resolve({ ok: true, granted: true });
    await assert.rejects(pending, (error) => error.message === "STALE_IDENTITY_COMPLETION");
    assert.equal(controller.state.consent, null);
    assert.equal(controller.state.identity.state, "signed_out");
    await assert.rejects(controller.setConsent(true), (error) => error.message === "NEST_AUTHENTICATION_REQUIRED");
});

test("category updates keep exactly one rail aria-current state, active class, and select value aligned", () => {
    const rail = ["overview", "sidebar", "themes"].map(categoryNode);
    rail.forEach((node) => { node.tabIndex = node.dataset.workspaceTarget === "overview" ? 0 : -1; });
    const overviewAction = categoryNode("themes");
    overviewAction.tabIndex = 0;
    const options = rail.map((node) => ({ value: node.dataset.workspaceTarget, selected: false }));
    const select = { value: "", options };
    const sections = rail.map((node) => ({ dataset: { category: node.dataset.workspaceTarget }, hidden: false }));
    const document = {
        body: { dataset: {} },
        querySelector(selector) { return selector === "#workspace-category-select" ? select : null; },
        querySelectorAll(selector) {
            if (selector === ".workspace-nav [data-workspace-target]") return rail;
            if (selector === "[data-workspace-target]") return [...rail, overviewAction];
            if (selector === ".workspace-section[data-category]") return sections;
            return [];
        },
        getElementById() { return null; }
    };
    const controller = popup.createController({ document, window: { location: { search: "" }, addEventListener() {} }, chromeApi: fakeChrome(() => ({ ok: true })), defaults: {} });

    controller.updateCategory("sidebar");
    assert.deepEqual(rail.filter((node) => node.hasAttribute("aria-current")).map((node) => node.dataset.workspaceTarget), ["sidebar"]);
    assert.equal(rail.find((node) => node.dataset.workspaceTarget === "sidebar").classList.contains("is-active"), true);
    assert.equal(rail.find((node) => node.dataset.workspaceTarget === "sidebar").tabIndex, 0);
    assert.equal(rail.find((node) => node.dataset.workspaceTarget === "overview").tabIndex, -1);
    assert.equal(overviewAction.tabIndex, 0, "content route action remains keyboard-focusable");
    assert.equal(overviewAction.hasAttribute("aria-current"), false, "content route action never receives navigation state");
    assert.equal(select.value, "sidebar");
    assert.deepEqual(options.filter((option) => option.selected).map((option) => option.value), ["sidebar"]);

    controller.updateCategory("overview");
    assert.deepEqual(rail.filter((node) => node.hasAttribute("aria-current")).map((node) => node.dataset.workspaceTarget), ["overview"]);
    assert.equal(rail.find((node) => node.dataset.workspaceTarget === "sidebar").classList.contains("is-active"), false);
    assert.equal(rail.find((node) => node.dataset.workspaceTarget === "overview").tabIndex, 0);
    assert.equal(rail.find((node) => node.dataset.workspaceTarget === "sidebar").tabIndex, -1);
    assert.equal(overviewAction.tabIndex, 0);
    assert.equal(overviewAction.hasAttribute("aria-current"), false);
    assert.equal(select.value, "overview");
    assert.deepEqual(options.filter((option) => option.selected).map((option) => option.value), ["overview"]);
});

test("sidebar canonicalization rejects malformed values, persists the canonical load result, and preserves restoredOrder on failure", async () => {
    const malformed = ["courses", "courses", "unknown", "__proto__", 7, "help"];
    const persisted = [];
    const settingsStore = {
        transaction: async (changes) => { persisted.push(changes); return { ok: true }; },
        updateField: async () => { throw new Error("SIDEBAR_WRITE_FAILED"); }
    };
    const controller = controllerWith(() => ({ ok: true }), { sync: { sidebar_page_order: malformed }, settingsStore });
    await controller.loadSidebarSettings();
    const expected = popup.normalizeSidebarOrder(["courses", "help", "dashboard", "calendar", "inbox", "history", "unknown"]);
    assert.deepEqual(controller.state.sidebarOrder, expected);
    assert.deepEqual(persisted, [{ sidebar_page_order: expected }]);
    assert.deepEqual(popup.normalizeSidebarOrder({ 0: "courses" }), popup.normalizeSidebarOrder([]));
    assert.deepEqual(popup.normalizeSidebarOrder(["__proto__", "constructor", "prototype", "dashboard", "dashboard"]), popup.normalizeSidebarOrder(["dashboard"]));

    controller.state.sidebarOrder = ["dashboard", "courses", "calendar", "inbox", "history", "help"];
    controller.state.persistedSidebarOrder = controller.state.sidebarOrder.slice();
    let rendererResult;
    const failed = controller.persistSidebarOrder(["courses", "dashboard"], "courses", { onResult: (result) => { rendererResult = result; } });
    await assert.rejects(failed, (error) => Array.isArray(error.restoredOrder) && error.result.restoredOrder.join(",") === controller.state.persistedSidebarOrder.join(","));
    assert.deepEqual(controller.state.sidebarOrder, controller.state.persistedSidebarOrder);
    assert.deepEqual(rendererResult.restoredOrder, controller.state.persistedSidebarOrder);
    assert.equal(rendererResult.ok, false);
});

test("sidebar reorder generations ignore stale failure rollback and keep newest success canonical", async () => {
    const initial = popup.normalizeSidebarOrder(["dashboard", "courses", "calendar", "inbox", "history", "help"]);
    const firstOrder = popup.normalizeSidebarOrder(["courses", "dashboard", "calendar", "inbox", "history", "help"]);
    const newestOrder = popup.normalizeSidebarOrder(["courses", "calendar", "dashboard", "inbox", "history", "help"]);
    const saves = [];
    const settingsStore = {
        updateField: (key, value) => {
            const pending = deferred();
            saves.push({ key, value, ...pending });
            return pending.promise;
        }
    };
    const controller = controllerWith(() => ({ ok: true }), { settingsStore });
    controller.state.sidebarOrder = initial.slice();
    controller.state.persistedSidebarOrder = initial.slice();

    const staleFailure = controller.persistSidebarOrder(firstOrder, "courses");
    const newestSuccess = controller.persistSidebarOrder(newestOrder, "calendar");
    assert.deepEqual(controller.state.sidebarOrder, newestOrder);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(saves.length, 1, "newest save waits behind the older in-flight operation");

    saves[0].reject(new Error("OLD_SAVE_FAILED"));
    let oldError;
    await assert.rejects(staleFailure, (error) => { oldError = error; return true; });
    assert.equal(oldError.current, false);
    assert.deepEqual(controller.state.sidebarOrder, newestOrder, "old failure cannot restore newer optimistic state");
    assert.deepEqual(controller.state.persistedSidebarOrder, initial);

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(saves.length, 2);
    saves[1].resolve({ ok: true });
    const newestResult = await newestSuccess;
    assert.equal(newestResult.current, true);
    assert.deepEqual(controller.state.sidebarOrder, newestOrder);
    assert.deepEqual(controller.state.persistedSidebarOrder, newestOrder);

    const failedNewest = controller.persistSidebarOrder(firstOrder, "courses");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(saves.length, 3);
    saves[2].reject(new Error("NEWEST_SAVE_FAILED"));
    let newestError;
    await assert.rejects(failedNewest, (error) => { newestError = error; return true; });
    assert.equal(newestError.current, true);
    assert.deepEqual(controller.state.sidebarOrder, newestOrder);
    assert.deepEqual(controller.state.persistedSidebarOrder, newestOrder);
});

function transactionBase(overrides = {}) {
    const events = [];
    const base = {
        settingsChanges: { dark_mode: false },
        cardColors: ["#112233", "#445566"],
        hasCanvas: true,
        readSettings: async () => { events.push("read-settings"); return { dark_mode: true }; },
        writeSettings: async (changes) => { events.push(["write-settings", changes]); return { ok: true }; },
        restoreSettings: async (snapshot) => { events.push(["restore-settings", snapshot]); return { ok: true }; },
        readCanvasColors: async () => { events.push("read-colors"); return ["#aabbcc"]; },
        writeCanvasColors: async (colors) => { events.push(["write-colors", colors]); return true; },
        readQueuedColors: async () => ({ present: false }),
        queueCanvasColors: async (colors) => { events.push(["queue-colors", colors]); return { ok: true }; },
        restoreQueuedColors: async (snapshot) => { events.push(["restore-queued", snapshot]); return { ok: true }; }
    };
    return { options: { ...base, ...overrides }, events };
}

test("live Canvas import snapshots and commits settings/colors with explicit applied result", async () => {
    const { options, events } = transactionBase();
    const result = await popup.runThemeImportTransaction(options);
    assert.equal(result.canvasColorsApplied, true);
    assert.equal(result.canvasColorsPending, false);
    assert.deepEqual(events, ["read-settings", "read-colors", ["write-settings", { dark_mode: false }], ["write-colors", ["#112233", "#445566"]]]);
});

test("live Canvas settings failure compensates settings and colors", async () => {
    const { options, events } = transactionBase({ writeSettings: async () => { events.push("write-settings"); return { ok: false, code: "SETTINGS_WRITE_FAILED" }; } });
    await assert.rejects(popup.runThemeImportTransaction(options), (error) => error.code === "SETTINGS_WRITE_FAILED");
    assert.ok(events.some((event) => Array.isArray(event) && event[0] === "restore-settings"));
    assert.ok(events.some((event) => Array.isArray(event) && event[0] === "write-colors" && event[1][0] === "#aabbcc"));
});

test("live Canvas color failure compensates both sides and does not report success", async () => {
    let colorCalls = 0;
    const { options, events } = transactionBase({ writeCanvasColors: async (colors) => { events.push(["write-colors", colors]); colorCalls += 1; return colorCalls === 1 ? { ok: false, code: "CANVAS_COLORS_WRITE_FAILED" } : true; } });
    await assert.rejects(popup.runThemeImportTransaction(options), (error) => error.code === "CANVAS_COLORS_WRITE_FAILED");
    assert.ok(events.some((event) => Array.isArray(event) && event[0] === "restore-settings"));
    assert.equal(events.filter((event) => Array.isArray(event) && event[0] === "write-colors").length, 2);
});

test("compensation failure returns sanitized state without raw error details", async () => {
    const { options } = transactionBase({
        writeCanvasColors: async () => ({ ok: false, code: "CANVAS_COLORS_WRITE_FAILED" }),
        restoreSettings: async () => { throw new Error("secret token should not escape"); }
    });
    await assert.rejects(popup.runThemeImportTransaction(options), (error) => {
        assert.equal(error.code, "THEME_TRANSACTION_COMPENSATION_FAILED");
        assert.equal(error.cause, undefined);
        assert.equal(error.state.ok, false);
        assert.equal(error.state.primary.code, "CANVAS_COLORS_WRITE_FAILED");
        assert.match(error.state.compensation[0].error.message, /redacted/);
        return true;
    });
});

test("no Canvas import queues validated colors and explicitly reports pending/not applied", async () => {
    const { options, events } = transactionBase({ hasCanvas: false });
    const result = await popup.runThemeImportTransaction(options);
    assert.equal(result.canvasColorsApplied, false);
    assert.equal(result.canvasColorsQueued, true);
    assert.equal(result.canvasColorsPending, true);
    assert.equal(result.canvasColorsNotApplied, true);
    assert.ok(events.some((event) => Array.isArray(event) && event[0] === "queue-colors"));
});

test("theme import rejects unknown, malformed, prototype-like, secret, and invalid color data before writes", async () => {
    const cases = [
        { settingsChanges: { unknown_setting: true } },
        { settingsChanges: { dark_mode: "yes" } },
        { settingsChanges: JSON.parse('{"__proto__":{"polluted":true}}') },
        { settingsChanges: JSON.parse('{"constructor":{"polluted":true}}') },
        { settingsChanges: JSON.parse('{"api_key":"secret"}') },
        { cardColors: ["red"] }
    ];
    for (const invalid of cases) {
        const { options } = transactionBase(invalid);
        await assert.rejects(popup.runThemeImportTransaction(options), (error) => error.message === "THEME_TRANSACTION_INVALID");
    }
});
