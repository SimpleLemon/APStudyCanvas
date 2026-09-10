"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const contract = require("../../js/platform/contract.js");
const storage = require("../../js/platform/storage.js");
const router = require("../../js/platform/router.js");

const CANVAS_ORIGIN = "https://canvas.emory.edu";
const ACCOUNT_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const EXTENSION_ORIGIN = "chrome-extension://test-id";

// An overlay iframe is an extension-origin document that lives inside a Canvas
// tab, so unlike the action popup its sender carries tab and frame context.
function overlayFrameSender(search = "?embedded=1") {
    const url = new URL(`${EXTENSION_ORIGIN}/html/popup.html${search}`);
    if (url.searchParams.get("embedded") === "1" && !url.searchParams.has("overlayParentOrigin")) {
        url.searchParams.set("overlayParentOrigin", CANVAS_ORIGIN);
    }
    return {
        id: "test-id",
        origin: EXTENSION_ORIGIN,
        url: url.href,
        frameId: 3,
        tab: { id: 42, url: `${CANVAS_ORIGIN}/courses/1`, windowId: 7 }
    };
}

function contentScriptSender() {
    return { id: "test-id", origin: CANVAS_ORIGIN, url: `${CANVAS_ORIGIN}/courses/1`, frameId: 0, tab: { id: 42, url: `${CANVAS_ORIGIN}/courses/1` } };
}

function createService({ canvasSync, transport, chromeApi } = {}) {
    const area = storage.createMemoryStorage({
        sync: { custom_domain: [CANVAS_ORIGIN], dark_mode: false },
        local: {
            "platform.accountMetadata": { version: 1, accounts: [{ origin: CANVAS_ORIGIN, accountId: "canvas-account" }] },
            canvas_sync_opt_in: { [ACCOUNT_KEY]: true }
        },
        session: {}
    });
    return {
        area,
        service: router.createRouter({
            chromeApi: chromeApi || { runtime: { getURL: (value) => `${EXTENSION_ORIGIN}/${String(value).replace(/^\//, "")}` } },
            storage: area,
            transport: transport || {
                identityGet: async () => ({ ok: true, identity: "account" }),
                request: async () => ({ ok: true, body: { state: "authenticated" } }),
                mutate: async () => ({ ok: true, body: { state: "authenticated" } })
            },
            canvasSync: canvasSync || { status: async () => ({ state: "idle" }) }
        })
    };
}

test("every overlay control preserves the iframe session through privileged forwarding", async () => {
    const forwarded = [];
    const chromeApi = {
        runtime: { getURL: (value) => `${EXTENSION_ORIGIN}/${String(value).replace(/^\//, "")}` },
        tabs: {
            async sendMessage(tabId, message, options) {
                forwarded.push({ tabId, message, options });
                return { payload: { ok: true, state: message.payload.action } };
            }
        }
    };
    const { service } = createService({ chromeApi });
    const actions = ["ready", "error", "retry", "draft-state", "close", "discard-close", "fullscreen", "navigate", "zoom", "preview", "focus"];
    for (const action of actions) {
        const result = await service.handle(contract.createEnvelope("OVERLAY_CONTROL", {
            action,
            overlaySession: "session-transport",
            ...(action === "error" ? { code: "POPUP_INIT_FAILED", recoverable: true } : {}),
            ...(action === "draft-state" ? { draft: true, sequence: 1 } : {}),
            ...(action === "discard-close" ? { confirmDiscard: true } : {})
        }, `overlay-${action}`), overlayFrameSender("?embedded=1&overlaySession=session-transport&sourceCanvasTabId=42"));
        assert.equal(result.payload.ok, true, action);
        assert.equal(result.payload.action, action);
    }
    assert.deepEqual(forwarded.map((entry) => ({
        tabId: entry.tabId,
        frameId: entry.options.frameId,
        action: entry.message.payload.action,
        overlaySession: entry.message.payload.overlaySession
    })), actions.map((action) => ({ tabId: 42, frameId: 0, action, overlaySession: "session-transport" })));
});

test("privileged overlay forwarding binds sourceCanvasTabId to the sender tab", async () => {
    const forwarded = [];
    const chromeApi = {
        runtime: { getURL: (value) => `${EXTENSION_ORIGIN}/${String(value).replace(/^\//, "")}` },
        tabs: {
            async sendMessage(tabId, message, options) {
                forwarded.push({ tabId, message, options });
                return { payload: { ok: true, state: "ready" } };
            }
        }
    };
    const { service } = createService({ chromeApi });
    const request = contract.createEnvelope("OVERLAY_CONTROL", {
        action: "ready",
        overlaySession: "session-tab-binding"
    }, "overlay-tab-binding");

    const positive = await service.handle(
        request,
        overlayFrameSender("?embedded=1&overlaySession=session-tab-binding&sourceCanvasTabId=42")
    );
    assert.equal(positive.payload.ok, true);
    assert.equal(forwarded.length, 1);

    forwarded.length = 0;
    const invalidSources = [
        ["duplicate", "?embedded=1&overlaySession=session-tab-binding&sourceCanvasTabId=42&sourceCanvasTabId=42"],
        ["zero", "?embedded=1&overlaySession=session-tab-binding&sourceCanvasTabId=0"],
        ["negative", "?embedded=1&overlaySession=session-tab-binding&sourceCanvasTabId=-1"],
        ["mismatched", "?embedded=1&overlaySession=session-tab-binding&sourceCanvasTabId=41"],
        ["foreign parent origin", "?embedded=1&overlaySession=session-tab-binding&sourceCanvasTabId=42&overlayParentOrigin=https%3A%2F%2Fevil.example"]
    ];
    for (const [name, search] of invalidSources) {
        const result = await service.handle(request, overlayFrameSender(search));
        assert.equal(result.payload.ok, false, name);
        assert.equal(result.payload.code, "OVERLAY_SESSION_REQUIRED", name);
        assert.equal(forwarded.length, 0, `${name}: invalid sourceCanvasTabId must not forward`);
    }

    const nonpositiveSender = overlayFrameSender("?embedded=1&overlaySession=session-tab-binding&sourceCanvasTabId=42");
    nonpositiveSender.tab.id = 0;
    const nonpositive = await service.handle(request, nonpositiveSender);
    assert.equal(nonpositive.payload.code, "OVERLAY_SESSION_REQUIRED");
    assert.equal(forwarded.length, 0);
});

// Live regression: opening the control center from the Canvas sidebar mints
// the iframe URL without sourceCanvasTabId because no launcher message
// supplied a tab id. The router must bind the session to the authoritative
// sender.tab.id so the ready/error handshake can complete.
test("sidebar opens without sourceCanvasTabId still complete the ready and error handshake", async () => {
    const forwarded = [];
    const chromeApi = {
        runtime: { getURL: (value) => `${EXTENSION_ORIGIN}/${String(value).replace(/^\//, "")}` },
        tabs: {
            async sendMessage(tabId, message, options) {
                forwarded.push({ tabId, message, options });
                return { payload: { ok: true, state: message.payload.action } };
            }
        }
    };
    const { service } = createService({ chromeApi });
    const sidebarSender = overlayFrameSender("?embedded=1&category=sidebar&overlaySession=session-sidebar-direct");
    for (const action of ["ready", "error"]) {
        const result = await service.handle(contract.createEnvelope("OVERLAY_CONTROL", {
            action,
            overlaySession: "session-sidebar-direct",
            ...(action === "error" ? { code: "POPUP_INIT_FAILED", recoverable: true } : {})
        }, `overlay-sidebar-${action}`), sidebarSender);
        assert.equal(result.payload.ok, true, action);
        assert.equal(result.payload.action, action);
    }
    assert.deepEqual(forwarded.map((entry) => ({
        tabId: entry.tabId,
        frameId: entry.options.frameId,
        action: entry.message.payload.action,
        overlaySession: entry.message.payload.overlaySession
    })), [
        { tabId: 42, frameId: 0, action: "ready", overlaySession: "session-sidebar-direct" },
        { tabId: 42, frameId: 0, action: "error", overlaySession: "session-sidebar-direct" }
    ]);

    forwarded.length = 0;
    const request = contract.createEnvelope("OVERLAY_CONTROL", {
        action: "ready",
        overlaySession: "session-sidebar-direct"
    }, "overlay-sidebar-auth");
    const missingTab = await service.handle(request, { ...sidebarSender, tab: undefined });
    assert.equal(missingTab.payload.code, "OVERLAY_SESSION_REQUIRED");
    const nonpositiveTab = await service.handle(request, { ...sidebarSender, tab: { id: 0, url: `${CANVAS_ORIGIN}/courses/1` } });
    assert.equal(nonpositiveTab.payload.code, "OVERLAY_SESSION_REQUIRED");
    assert.equal(forwarded.length, 0, "an unbindable sender tab must not forward");
});

test("a Canvas-hosted extension iframe reported as frame zero completes overlay recovery", async () => {
    const forwarded = [];
    const chromeApi = {
        runtime: { getURL: (value) => `${EXTENSION_ORIGIN}/${String(value).replace(/^\//, "")}` },
        tabs: {
            async sendMessage(tabId, message, options) {
                forwarded.push({ tabId, message, options });
                return { payload: { ok: true, state: message.payload.action } };
            }
        }
    };
    const { service } = createService({ chromeApi });
    const sender = overlayFrameSender("?embedded=1&overlaySession=session-frame-zero&sourceCanvasTabId=42");
    sender.frameId = 0;
    for (const action of ["ready", "error", "retry"]) {
        const result = await service.handle(contract.createEnvelope("OVERLAY_CONTROL", {
            action,
            overlaySession: "session-frame-zero",
            ...(action === "error" ? { code: "POPUP_INIT_FAILED", recoverable: true } : {})
        }, `overlay-frame-zero-${action}`), sender);
        assert.equal(result.payload.ok, true, action);
        assert.equal(result.payload.action, action);
    }
    assert.deepEqual(forwarded.map((entry) => entry.options.frameId), [0, 0, 0]);
});

test("OVERLAY_CONTROL rejects every invalid sender shape without forwarding", async () => {
    let forwards = 0;
    const chromeApi = {
        runtime: { getURL: (value) => `${EXTENSION_ORIGIN}/${String(value).replace(/^\//, "")}` },
        tabs: { async sendMessage() { forwards += 1; return { payload: { ok: true } }; } }
    };
    const { service } = createService({ chromeApi });
    const request = (overlaySession) => contract.createEnvelope("OVERLAY_CONTROL", {
        action: "retry",
        ...(overlaySession === undefined ? {} : { overlaySession })
    }, `overlay-retry-${overlaySession}`);

    const validSender = overlayFrameSender("?embedded=1&overlaySession=session-transport&sourceCanvasTabId=42&category=appearance");
    const cases = [
        {
            name: "negative frame",
            sender: { ...validSender, frameId: -1 },
            expected: "OVERLAY_FRAME_REQUIRED"
        },
        {
            name: "missing tab",
            sender: { ...validSender, tab: undefined },
            expected: "OVERLAY_SESSION_REQUIRED"
        },
        {
            name: "options extension path",
            sender: { ...validSender, url: `${EXTENSION_ORIGIN}/html/options.html?embedded=1&overlaySession=session-transport` },
            expected: "OVERLAY_SESSION_REQUIRED"
        },
        {
            name: "other extension path",
            sender: { ...validSender, url: `${EXTENSION_ORIGIN}/html/overlay.html?embedded=1&overlaySession=session-transport` },
            expected: "OVERLAY_SESSION_REQUIRED"
        },
        {
            name: "foreign extension origin",
            sender: { ...validSender, id: "foreign-id", origin: "chrome-extension://foreign-id", url: "chrome-extension://foreign-id/html/popup.html?embedded=1&overlaySession=session-transport" },
            expected: "SENDER_NOT_ALLOWED"
        },
        {
            name: "Canvas origin",
            sender: contentScriptSender(),
            expected: "SENDER_EXTENSION_REQUIRED"
        },
        {
            name: "hash manipulation",
            sender: { ...validSender, url: `${EXTENSION_ORIGIN}/html/popup.html?embedded=1&overlaySession=session-transport#workspace` },
            expected: "OVERLAY_SESSION_REQUIRED"
        },
        {
            name: "foreign URL with privileged origin field",
            sender: { ...validSender, url: "chrome-extension://foreign-id/html/popup.html?embedded=1&overlaySession=session-transport" },
            expected: "OVERLAY_SESSION_REQUIRED"
        },
        {
            name: "unknown query manipulation",
            sender: { ...validSender, url: `${EXTENSION_ORIGIN}/html/popup.html?embedded=1&overlaySession=session-transport&view=preview` },
            expected: "OVERLAY_SESSION_REQUIRED"
        },
        {
            name: "duplicate embedded flags",
            sender: overlayFrameSender("?embedded=1&embedded=1&overlaySession=session-transport"),
            expected: "OVERLAY_SESSION_REQUIRED"
        },
        {
            name: "duplicate session tokens",
            sender: overlayFrameSender("?embedded=1&overlaySession=session-transport&overlaySession=session-transport"),
            expected: "OVERLAY_SESSION_REQUIRED"
        },
        {
            name: "duplicate source tab ids",
            sender: overlayFrameSender("?embedded=1&overlaySession=session-transport&sourceCanvasTabId=42&sourceCanvasTabId=42"),
            expected: "OVERLAY_SESSION_REQUIRED"
        },
        {
            name: "missing sender token",
            sender: overlayFrameSender("?embedded=1"),
            expected: "OVERLAY_SESSION_REQUIRED"
        },
        {
            name: "missing payload token",
            sender: validSender,
            overlaySession: undefined,
            expected: "OVERLAY_SESSION_MISMATCH"
        },
        {
            name: "token mismatch",
            sender: validSender,
            overlaySession: "session-other",
            expected: "OVERLAY_SESSION_MISMATCH"
        }
    ];

    for (const item of cases) {
        const result = await service.handle(request(Object.prototype.hasOwnProperty.call(item, "overlaySession") ? item.overlaySession : "session-transport"), item.sender);
        assert.equal(result.payload.ok, false, item.name);
        assert.equal(result.payload.code, item.expected, item.name);
        assert.equal(forwards, 0, `${item.name}: tabs.sendMessage must not run`);
    }
    assert.equal(forwards, 0);
});

test("an extension-origin overlay frame inside a Canvas tab clears every settings and Nest sender gate", async () => {
    const { service } = createService();
    const sender = overlayFrameSender();

    const read = await service.handle(contract.createEnvelope("SETTINGS_READ", { area: "sync", keys: ["dark_mode"] }, "overlay-read"), sender);
    assert.notEqual(read.payload.code, "SENDER_EXTENSION_REQUIRED");
    assert.equal(read.payload.ok, true);

    const update = await service.handle(contract.createEnvelope("SETTINGS_UPDATE", { area: "sync", changes: { dark_mode: true } }, "overlay-update"), sender);
    assert.notEqual(update.payload.code, "SENDER_EXTENSION_REQUIRED");
    assert.equal(update.payload.ok, true);

    const context = await service.handle(
        contract.createEnvelope("POPUP_CONTEXT_GET", {}, "overlay-context"),
        overlayFrameSender("?embedded=1&overlaySession=session-context&view=workspace")
    );
    assert.equal(context.payload.ok, true);
    assert.equal(context.payload.sourceCanvasTabId, 42);
    assert.equal(context.payload.sourceCanvasOrigin, CANVAS_ORIGIN);

    const consent = await service.handle(contract.createEnvelope("NEST_CONSENT_GET", {
        source_key: `canvas:${ACCOUNT_KEY}`,
        account_key: ACCOUNT_KEY,
        version: 1
    }, "overlay-consent"), sender);
    assert.notEqual(consent.payload.code, "SENDER_EXTENSION_REQUIRED");
    assert.deepEqual(consent.payload, { ok: true, body: { state: "authenticated" } });

    const status = await service.handle(contract.createEnvelope("CANVAS_SYNC_STATUS", { accountKey: ACCOUNT_KEY }, "overlay-sync"), sender);
    assert.notEqual(status.payload.code, "SENDER_EXTENSION_REQUIRED");
    assert.equal(status.payload.state, "idle");
});

test("a Canvas-origin sender is rejected for the same families, so a page-side overlay is not an option", async () => {
    const { service } = createService();
    const sender = contentScriptSender();

    for (const type of ["SETTINGS_READ", "SETTINGS_UPDATE", "SETTINGS_RESET", "POPUP_CONTEXT_GET"]) {
        const result = await service.handle(contract.createEnvelope(type, { area: "sync", keys: ["dark_mode"], changes: { dark_mode: true } }, `canvas-${type}`), sender);
        assert.equal(result.payload.code, "SENDER_EXTENSION_REQUIRED", type);
    }
    const consent = await service.handle(contract.createEnvelope("NEST_CONSENT_GET", {
        source_key: `canvas:${ACCOUNT_KEY}`,
        account_key: ACCOUNT_KEY,
        version: 1
    }, "canvas-consent"), sender);
    assert.equal(consent.payload.code, "SENDER_EXTENSION_REQUIRED");
});

test("the overlay frame URL must stay on the popup pathname with no hash", async () => {
    const { service } = createService();

    const querySender = overlayFrameSender("?embedded=1&category=appearance");
    const allowed = await service.handle(contract.createEnvelope("CANVAS_SYNC_STATUS", { accountKey: ACCOUNT_KEY }, "query-ok"), querySender);
    assert.equal(allowed.payload.state, "idle");

    const hashSender = overlayFrameSender("?embedded=1#appearance");
    const blockedByHash = await service.handle(contract.createEnvelope("CANVAS_SYNC_STATUS", { accountKey: ACCOUNT_KEY }, "hash-blocked"), hashSender);
    assert.equal(blockedByHash.payload.code, "SENDER_EXTENSION_REQUIRED");

    const otherPage = { ...overlayFrameSender(), url: `${EXTENSION_ORIGIN}/html/overlay.html?embedded=1` };
    const blockedByPath = await service.handle(contract.createEnvelope("CANVAS_SYNC_STATUS", { accountKey: ACCOUNT_KEY }, "path-blocked"), otherPage);
    assert.equal(blockedByPath.payload.code, "SENDER_EXTENSION_REQUIRED");
});
