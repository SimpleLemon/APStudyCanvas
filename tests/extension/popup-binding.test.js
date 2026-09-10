"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const POPUP_SOURCE = fs.readFileSync(path.join(__dirname, "../../js/popup.js"), "utf8");
const DIAGNOSTICS_TRANSPORT_SOURCE = fs.readFileSync(path.join(__dirname, "../../js/diagnostics-transport.js"), "utf8");
const SCHEMA_SOURCE = fs.readFileSync(path.join(__dirname, "../../js/settings-schema.js"), "utf8");
const POPUP_CONTEXT_SOURCE = POPUP_SOURCE.slice(0, POPUP_SOURCE.indexOf("function expandedRouteIsHosted"));
const POPUP_BINDING_SOURCE = POPUP_SOURCE.slice(0, POPUP_SOURCE.indexOf("function ensureCanvasHeaderAction"));
const ORIGIN = "https://canvas.example.edu";
const ALLOWED_CANVAS_ORIGIN = "https://canvas.emory.edu";
const ACCOUNT_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function loadPopupContext() {
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
        isPlainObject(value) {
            if (!value || typeof value !== "object" || Array.isArray(value)) return false;
            const prototype = Object.getPrototypeOf(value);
            return prototype === Object.prototype || prototype === null;
        },
        window: null
    };
    context.window = context;
    context.globalThis = context;
    vm.runInNewContext(SCHEMA_SOURCE, context, { filename: "js/settings-schema.js" });
    vm.runInNewContext(POPUP_CONTEXT_SOURCE, context, { filename: "js/popup.js" });
    return context.APStudyCanvasPopupContext;
}

function loadPopupBinding(search, { activeTabId = 99, embeddedTabId = activeTabId } = {}) {
    const calls = [];
    const tab = (id) => ({ id, url: `${ALLOWED_CANVAS_ORIGIN}/dashboard` });
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
        isPlainObject(value) {
            if (!value || typeof value !== "object" || Array.isArray(value)) return false;
            const prototype = Object.getPrototypeOf(value);
            return prototype === Object.prototype || prototype === null;
        },
        chrome: {
            runtime: {
                async sendMessage(message) {
                    calls.push({ type: "runtimeSendMessage", message });
                    if (message?.type === "POPUP_CONTEXT_GET") {
                        return {
                            payload: {
                                ok: true,
                                sourceCanvasTabId: embeddedTabId,
                                sourceCanvasOrigin: ALLOWED_CANVAS_ORIGIN
                            }
                        };
                    }
                    return { payload: { ok: false, code: "UNSUPPORTED_FAMILY" } };
                }
            },
            storage: { sync: { get: async () => ({}) } },
            tabs: {
                async get(id) {
                    calls.push({ type: "get", id });
                    return tab(id);
                },
                async query() {
                    calls.push({ type: "query" });
                    return [tab(activeTabId)];
                },
                async sendMessage(id, message) {
                    calls.push({ type: "sendMessage", id, message });
                    const response = connected({});
                    response.origin = ALLOWED_CANVAS_ORIGIN;
                    response.canvasBinding.origin = ALLOWED_CANVAS_ORIGIN;
                    return response;
                }
            }
        },
        window: null
    };
    context.window = context;
    context.location = { search };
    context.globalThis = context;
    vm.runInNewContext(SCHEMA_SOURCE, context, { filename: "js/settings-schema.js" });
    vm.runInNewContext(DIAGNOSTICS_TRANSPORT_SOURCE, context, { filename: "js/diagnostics-transport.js" });
    vm.runInNewContext(`${POPUP_BINDING_SOURCE}\n globalThis.__requestCanvasContext = requestCanvasContext;`, context, { filename: "js/popup.js" });
    return {
        requestCanvasContext: context.__requestCanvasContext,
        requireHostedSourceAtStartup: context.APStudyCanvasPopupContext.requireHostedSourceAtStartup,
        calls
    };
}

function connected(binding, overrides = {}) {
    return {
        ok: true,
        state: "connected",
        origin: ORIGIN,
        profile: { displayName: "Canvas Student", avatarUrl: "https://cdn.example/avatar.png?size=96" },
        unread: { count: 4, categories: { conversations: 4 } },
        canvasBinding: {
            origin: ORIGIN,
            canvasUserId: "student-1",
            accountKey: ACCOUNT_KEY,
            sourceKey: `canvas:${ACCOUNT_KEY}`,
            label: "Canvas Student",
            extraction: "supported",
            ...binding
        },
        ...overrides
    };
}

function host(value) {
    return JSON.parse(JSON.stringify(value));
}

test("popup normalization preserves a safe binding and existing profile/unread context", () => {
    const popupContext = loadPopupContext();
    const normalized = popupContext.sanitizeCanvasContext(connected({}));
    assert.deepEqual(host(normalized.canvasBinding), {
        origin: ORIGIN,
        canvasUserId: "student-1",
        accountKey: ACCOUNT_KEY,
        sourceKey: `canvas:${ACCOUNT_KEY}`,
        label: "Canvas Student",
        extraction: "supported"
    });
    assert.deepEqual(host(normalized.profile), { displayName: "Canvas Student", avatarUrl: "https://cdn.example/avatar.png?size=96" });
    assert.deepEqual(host(normalized.unread), { count: 4, categories: { conversations: 4 } });
});

test("popup normalization drops malformed or unsafe bindings without leaking them", () => {
    const popupContext = loadPopupContext();
    for (const binding of [
        { sourceKey: "canvas:not-the-account-key" },
        { accountKey: "Bearer secret", sourceKey: "canvas:Bearer secret" },
        { authorization: "Bearer secret" },
        { extraction: "unsupported", extra: "unexpected" }
    ]) {
        const normalized = popupContext.sanitizeCanvasContext(connected(binding));
        assert.equal(normalized.canvasBinding, null, JSON.stringify(binding));
        assert.deepEqual(host(normalized.profile), { displayName: "Canvas Student", avatarUrl: "https://cdn.example/avatar.png?size=96" });
        assert.deepEqual(host(normalized.unread), { count: 4, categories: { conversations: 4 } });
        assert.doesNotMatch(JSON.stringify(normalized), /Bearer|secret|authorization/i);
    }
});

test("sidebar context keeps unknown pages and verified courses while stripping unsafe fields", () => {
    const popupContext = loadPopupContext();
    const normalized = popupContext.sanitizeCanvasContext(connected({}, {
        contextRevision: 7,
        sidebarContext: {
            version: 1,
            origin: ORIGIN,
            accountKey: ACCOUNT_KEY,
            route: { origin: ORIGIN, pathname: "/courses/42", kind: "course", pageId: "courses", courseId: "42", resource: ["assignments", { secret: "drop" }] },
            pageOrder: ["dashboard", "canvas-route:abc123", "unknown-field"],
            pageVisibility: { dashboard: true, "canvas-route:abc123": false, secret: "drop" },
            pages: [
                { id: "dashboard", label: "Dashboard", href: `${ORIGIN}/`, available: true, source: "canvas", iconRole: "dashboard" },
                { id: "canvas-route:abc123", label: "Unknown Canvas Page", href: "https://evil.example/phish", available: true, source: "canvas", iconRole: "canvas", token: "drop" },
                { id: "unavailable", label: "Retained but unavailable", href: `${ORIGIN}/hidden`, available: false, source: "canvas", iconRole: "canvas" }
            ],
            courseOrder: ["7", "8"],
            courses: [
                { id: "7", name: "Biology", href: `${ORIGIN}/courses/7`, available: true, published: true, color: "#D4AF37" },
                { id: "8", name: "Unsafe", href: "https://evil.example/courses/8", available: true, published: true, color: "javascript:bad" }
            ],
            bearer: "never expose"
        }
    }));
    assert.equal(normalized.contextRevision, 7);
    assert.deepEqual(host(normalized.sidebarContext.pageOrder), ["dashboard", "canvas-route:abc123", "unavailable"]);
    assert.equal(normalized.sidebarContext.pages.find((page) => page.id === "canvas-route:abc123").available, false);
    assert.equal(normalized.sidebarContext.pages.find((page) => page.id === "unavailable").available, false);
    assert.deepEqual(host(normalized.sidebarContext.courses.map((course) => course.id)), ["7"]);
    assert.equal(normalized.sidebarContext.courses[0].color, "#D4AF37");
    assert.equal(JSON.stringify(normalized).includes("never expose"), false);
    assert.equal(JSON.stringify(normalized).includes("evil.example"), false);
});

test("standalone or unbound context remains unavailable for sidebar data", () => {
    const popupContext = loadPopupContext();
    const normalized = popupContext.sanitizeCanvasContext({ ok: true, state: "connected", origin: ORIGIN, profile: null, unread: null, sidebarContext: { origin: ORIGIN, accountKey: ACCOUNT_KEY, pages: [], courses: [] } });
    assert.equal(normalized.canvasBinding, null);
    assert.equal(normalized.sidebarContext, null);
});

test("binding context events expose only redacted popup-safe data", () => {
    const popupContext = loadPopupContext();
    const detail = popupContext.canvasContextEventDetail(connected({}, {
        profile: { displayName: "Bearer secret", avatarUrl: "https://cdn.example/avatar.png?token=secret" },
        unread: { count: 2, categories: { conversations: 1, csrf: 9 } },
        canvasBinding: {
            origin: ORIGIN,
            canvasUserId: "student-1",
            accountKey: ACCOUNT_KEY,
            sourceKey: `canvas:${ACCOUNT_KEY}`,
            label: "Canvas Student",
            extraction: "supported"
        }
    }), 19);
    assert.deepEqual(host(detail), {
        state: "connected",
        profile: { displayName: null, avatarUrl: null },
        unread: { count: 2, categories: { conversations: 1 } },
        canvasBinding: {
            origin: ORIGIN,
            canvasUserId: "student-1",
            accountKey: ACCOUNT_KEY,
            sourceKey: `canvas:${ACCOUNT_KEY}`,
            label: "Canvas Student",
            extraction: "supported"
        },
        sourceTabId: 19
    });
    assert.doesNotMatch(JSON.stringify(detail), /Bearer|secret|token|csrf/i);
});

test("popup source tab propagation accepts only safe non-negative tab IDs", () => {
    const popupContext = loadPopupContext();
    const response = connected({});
    assert.equal(popupContext.canvasContextEventDetail(response, 0).sourceTabId, 0);
    for (const value of [null, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "19", { valueOf: () => 19 }]) {
        assert.equal(popupContext.canvasContextEventDetail(response, value).sourceTabId, null, String(value));
    }
});

test("fullscreen bootstrap sends the URL source tab to the first Canvas context request", async () => {
    const harness = loadPopupBinding("?fullscreen=1&sourceCanvasTabId=704772705");
    await harness.requestCanvasContext();
    const firstContextRequest = harness.calls.find((call) => call.type === "sendMessage");
    assert.equal(firstContextRequest?.id, 704772705);
    assert.equal(firstContextRequest?.message?.type, "GET_CANVAS_CONTEXT");
});

test("embedded overlay bootstrap sends the URL source tab to the first Canvas context request", async () => {
    const harness = loadPopupBinding("?embedded=1&sourceCanvasTabId=704772705");
    await harness.requestCanvasContext();
    const firstContextRequest = harness.calls.find((call) => call.type === "sendMessage");
    assert.equal(firstContextRequest?.id, 704772705);
    assert.equal(firstContextRequest?.message?.type, "GET_CANVAS_CONTEXT");
});

test("source-less embedded overlays resolve the containing Canvas tab before the first context request", async () => {
    const harness = loadPopupBinding(
        "?embedded=1&category=calendar-accounts&overlaySession=session-calendar&overlayParentOrigin=https%3A%2F%2Fcanvas.emory.edu&view=workspace",
        { activeTabId: 123, embeddedTabId: 42 }
    );
    assert.equal(harness.requireHostedSourceAtStartup(), null);
    await harness.requestCanvasContext();
    assert.equal(harness.calls.some((call) => call.type === "query"), false);
    assert.equal(harness.calls.some((call) => call.type === "runtimeSendMessage" && call.message?.type === "POPUP_CONTEXT_GET"), true);
    assert.equal(harness.calls.some((call) => call.type === "get" && call.id === 42), true);
    assert.equal(harness.calls.some((call) => call.type === "sendMessage" && call.id === 42 && call.message?.type === "GET_CANVAS_CONTEXT"), true);
});

test("standalone popup startup retains its active-tab lookup", async () => {
    const harness = loadPopupBinding("", { activeTabId: 99 });
    await harness.requestCanvasContext();
    assert.equal(harness.calls.some((call) => call.type === "query"), true);
    assert.equal(harness.calls.some((call) => call.type === "sendMessage" && call.id === 99), true);
});

test("hosted source helpers accept fullscreen and embedded routes and reject everything else", () => {
    const popupContext = loadPopupContext();
    assert.equal(popupContext.hostedRouteFromSearch("?fullscreen=1"), true);
    assert.equal(popupContext.hostedRouteFromSearch("?embedded=1"), true);
    assert.equal(popupContext.hostedRouteFromSearch("?embedded=1&fullscreen=1"), true);
    assert.equal(popupContext.parseHostedSourceTabId("?fullscreen=1&sourceCanvasTabId=19"), 19);
    assert.equal(popupContext.parseHostedSourceTabId("?embedded=1&sourceCanvasTabId=19"), 19);
    assert.equal(popupContext.hostedSourceParamPresent("?fullscreen=1&sourceCanvasTabId=19"), true);
    assert.equal(popupContext.hostedSourceParamPresent("?embedded=1&sourceCanvasTabId="), true);
    assert.equal(popupContext.parseHostedSourceTabId("?view=workspace&sourceCanvasTabId=19"), null);
    assert.equal(popupContext.hostedSourceParamPresent("?view=workspace&sourceCanvasTabId=19"), false);
});

test("invalid fullscreen source IDs fail closed without falling back to the active tab", async () => {
    const invalidQueries = [
        ["missing-param", "?fullscreen=1"],
        ["missing", "?fullscreen=1&sourceCanvasTabId="],
        ["fractional", "?fullscreen=1&sourceCanvasTabId=7.5"],
        ["signed", "?fullscreen=1&sourceCanvasTabId=%2B7"],
        ["padded", "?fullscreen=1&sourceCanvasTabId=007"],
        ["duplicate", "?fullscreen=1&sourceCanvasTabId=7&sourceCanvasTabId=8"],
        ["unsafe", "?fullscreen=1&sourceCanvasTabId=9007199254740992"],
        ["non-fullscreen", "?fullscreen=1&sourceCanvasTabId=0"],
        ["embedded-missing-param", "?embedded=1"],
        ["embedded-missing", "?embedded=1&sourceCanvasTabId="],
        ["embedded-duplicate", "?embedded=1&sourceCanvasTabId=7&sourceCanvasTabId=8"],
        ["embedded-zero", "?embedded=1&sourceCanvasTabId=0"],
        ["combined-missing", "?embedded=1&fullscreen=1"]
    ];

    for (const [label, search] of invalidQueries) {
        const harness = loadPopupBinding(search, { activeTabId: 123 });
        await harness.requestCanvasContext();
        assert.equal(harness.calls.some((call) => call.type === "query"), false, label);
        assert.equal(harness.calls.some((call) => call.type === "sendMessage" && call.id === 123), false, label);
    }
});

test("embedded startup rejects an explicitly invalid source before ready and enters recovery without any tab lookup", async () => {
    const popupController = require("../../js/popup-controller.js");
    const harness = loadPopupBinding("?embedded=1&overlaySession=session-source-error&sourceCanvasTabId=", { activeTabId: 123 });
    const recovery = { hidden: true, dataset: { state: "idle" } };
    let readyCalls = 0;
    const startup = popupController.createStartup({
        controller: { init() {} },
        document: { readyState: "complete", addEventListener() {} },
        loaders: [
            () => harness.requireHostedSourceAtStartup(),
            () => harness.requestCanvasContext()
        ],
        onReady() { readyCalls += 1; },
        onError(error) {
            assert.equal(error?.code, "POPUP_HOSTED_SOURCE_INVALID");
            recovery.hidden = false;
            recovery.dataset.state = "error";
        }
    });

    await assert.rejects(startup.promise, { code: "POPUP_HOSTED_SOURCE_INVALID" });
    assert.equal(readyCalls, 0);
    assert.deepEqual(recovery, { hidden: false, dataset: { state: "error" } });
    assert.equal(harness.calls.some((call) => call.type === "query" || call.type === "get" || call.type === "sendMessage" || call.type === "runtimeSendMessage"), false);
});

test("sidebar-launched embedded workspaces use the parent bridge when no source tab id is available", async () => {
    const popupContext = loadPopupContext();
    const listeners = [];
    const parentMessages = [];
    const parent = {
        postMessage(message, targetOrigin) {
            parentMessages.push({ message, targetOrigin });
        }
    };
    const child = {
        location: { search: "?embedded=1&category=sidebar&overlaySession=session-sidebar" },
        parent,
        addEventListener(type, listener) { if (type === "message") listeners.push(listener); },
        removeEventListener(type, listener) {
            if (type === "message") {
                const index = listeners.indexOf(listener);
                if (index >= 0) listeners.splice(index, 1);
            }
        },
        setTimeout,
        clearTimeout
    };
    const chromeApi = {
        runtime: {
            sendMessage() { throw new Error("runtime transport should not be used for the sidebar bridge"); }
        }
    };
    const bridged = popupContext.createEmbeddedOverlayChromeApi(chromeApi, {
        windowRef: child,
        documentRef: { referrer: `${ALLOWED_CANVAS_ORIGIN}/courses/1` },
        timeoutMs: 100
    });
    const pending = bridged.runtime.sendMessage({
        type: "OVERLAY_CONTROL",
        request_id: "popup-bridge-1",
        payload: { action: "ready", overlaySession: "session-sidebar" }
    });
    assert.equal(parentMessages.length, 1);
    assert.equal(parentMessages[0].targetOrigin, ALLOWED_CANVAS_ORIGIN);
    assert.equal(parentMessages[0].message.type, "apstudycanvas-overlay-control");
    listeners.slice().forEach((listener) => listener({
        source: parent,
        origin: ALLOWED_CANVAS_ORIGIN,
        data: {
            type: "apstudycanvas-overlay-control-response",
            requestId: "popup-bridge-1",
            overlaySession: "session-sidebar",
            payload: { ok: true, state: "ready" }
        }
    }));
    const response = await pending;
    assert.equal(response.payload.ok, true);
    assert.equal(response.payload.state, "ready");
});

test("source-less embedded startup permits host-bound sessions without weakening explicit source validation", () => {
    const sidebar = loadPopupBinding("?embedded=1&category=sidebar&overlaySession=session-sidebar");
    assert.equal(sidebar.requireHostedSourceAtStartup(), null);

    const otherEmbedded = loadPopupBinding("?embedded=1&category=calendar&overlaySession=session-other");
    assert.equal(otherEmbedded.requireHostedSourceAtStartup(), null);

    const invalidExplicitSource = loadPopupBinding("?embedded=1&category=calendar&overlaySession=session-other&sourceCanvasTabId=");
    assert.throws(() => invalidExplicitSource.requireHostedSourceAtStartup(), { code: "POPUP_HOSTED_SOURCE_INVALID" });
});

test("every embedded frame uses the session-bound parent bridge, including toolbar frames after replacement", async () => {
    const popupContext = loadPopupContext();
    const parentMessages = [];
    const listeners = [];
    const parent = {
        postMessage(message, targetOrigin) { parentMessages.push({ message, targetOrigin }); }
    };
    const child = {
        location: { search: "?embedded=1&sourceCanvasTabId=42&category=appearance&overlaySession=session-toolbar&overlayParentOrigin=https%3A%2F%2Fcanvas.emory.edu" },
        parent,
        addEventListener(type, listener) { if (type === "message") listeners.push(listener); },
        removeEventListener(type, listener) {
            const index = listeners.indexOf(listener);
            if (index >= 0) listeners.splice(index, 1);
        },
        setTimeout,
        clearTimeout
    };
    const chromeApi = { runtime: { sendMessage() { throw new Error("toolbar frames must not rely on stale worker sender metadata"); } } };
    const bridged = popupContext.createEmbeddedOverlayChromeApi(chromeApi, {
        windowRef: child,
        documentRef: { referrer: "" },
        timeoutMs: 100
    });
    const pending = bridged.runtime.sendMessage({
        type: "OVERLAY_CONTROL",
        request_id: "popup-toolbar-replacement",
        payload: { action: "ready", overlaySession: "session-toolbar" }
    });
    assert.equal(parentMessages.length, 1);
    assert.equal(parentMessages[0].targetOrigin, ALLOWED_CANVAS_ORIGIN);
    listeners.slice().forEach((listener) => listener({
        source: parent,
        origin: ALLOWED_CANVAS_ORIGIN,
        data: {
            type: "apstudycanvas-overlay-control-response",
            requestId: "popup-toolbar-replacement",
            overlaySession: "session-toolbar",
            payload: { ok: true, state: "ready" }
        }
    }));
    assert.deepEqual(host(await pending), { payload: { ok: true, state: "ready" } });
});
