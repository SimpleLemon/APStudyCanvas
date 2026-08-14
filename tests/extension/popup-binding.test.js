"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const POPUP_SOURCE = fs.readFileSync(path.join(__dirname, "../../js/popup.js"), "utf8");
const SCHEMA_SOURCE = fs.readFileSync(path.join(__dirname, "../../js/settings-schema.js"), "utf8");
const POPUP_CONTEXT_SOURCE = POPUP_SOURCE.slice(0, POPUP_SOURCE.indexOf("function expandedRouteHasSource"));
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

function loadPopupBinding(search, { activeTabId = 99 } = {}) {
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
    vm.runInNewContext(`${POPUP_BINDING_SOURCE}\n globalThis.__requestCanvasContext = requestCanvasContext;`, context, { filename: "js/popup.js" });
    return { requestCanvasContext: context.__requestCanvasContext, calls };
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

test("invalid fullscreen source IDs fail closed without falling back to the active tab", async () => {
    const invalidQueries = [
        ["missing", "?fullscreen=1&sourceCanvasTabId="],
        ["fractional", "?fullscreen=1&sourceCanvasTabId=7.5"],
        ["signed", "?fullscreen=1&sourceCanvasTabId=%2B7"],
        ["padded", "?fullscreen=1&sourceCanvasTabId=007"],
        ["duplicate", "?fullscreen=1&sourceCanvasTabId=7&sourceCanvasTabId=8"],
        ["unsafe", "?fullscreen=1&sourceCanvasTabId=9007199254740992"],
        ["non-fullscreen", "?fullscreen=1&sourceCanvasTabId=0"]
    ];

    for (const [label, search] of invalidQueries) {
        const harness = loadPopupBinding(search, { activeTabId: 123 });
        await harness.requestCanvasContext();
        assert.equal(harness.calls.some((call) => call.type === "query"), false, label);
        assert.equal(harness.calls.some((call) => call.type === "sendMessage" && call.id === 123), false, label);
    }
});
