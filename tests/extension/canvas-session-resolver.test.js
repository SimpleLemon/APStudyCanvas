"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createCanvasSessionResolver } = require("../../js/platform/canvas-session-resolver.js");

const ORIGIN = "https://canvas.example.edu";
const BINDING = Object.freeze({ accountKey: "account-hash", origin: ORIGIN, canvasUserId: "canvas-user-1" });

function context(overrides = {}) {
    return { ok: true, state: "connected", origin: ORIGIN, canvasUser: { id: "canvas-user-1" }, ...overrides };
}

function verified(overrides = {}) {
    return { ok: true, state: "verified", verified: true, origin: ORIGIN, userId: "canvas-user-1", ...overrides };
}

function makeTabs(tabList, responses = {}) {
    const messages = [];
    return {
        messages,
        tabs: {
            async query() { return tabList; },
            async sendMessage(tabId, message) {
                messages.push({ tabId, message });
                const queue = responses[tabId] || [];
                if (!queue.length) throw new Error("unexpected message");
                const result = queue.shift();
                if (result instanceof Error) throw result;
                return result;
            }
        }
    };
}

test("rejects caller-owned binding keys and rejects forged sessions", async () => {
    const fake = makeTabs([{ id: 4, url: `${ORIGIN}/courses/1` }], { 4: [context(), verified()] });
    const resolver = createCanvasSessionResolver({ tabs: fake.tabs, configuredOrigins: [ORIGIN], idFactory: () => "request-1" });

    assert.equal(await resolver.resolve({ ...BINDING, tabId: 4 }), null);
    const session = await resolver.resolve(BINDING);
    assert.equal(resolver.isOwnedSession(session), true);
    assert.equal(resolver.isOwnedSession(Object.freeze({ ...session })), false);
    assert.equal(resolver.isOwnedSession({ ...session, windowId: 2 }), false);
});

test("returns no session when no tab has an exact configured origin", async () => {
    const fake = makeTabs([
        { id: 1, url: "https://canvas.example.edu.evil.test/courses/1" },
        { id: 2, url: "http://canvas.example.edu/courses/1" },
        { id: 3, url: "https://other.example.edu/courses/1" }
    ]);
    const resolver = createCanvasSessionResolver({ tabs: fake.tabs, configuredOrigins: [ORIGIN] });
    assert.equal(await resolver.resolve(BINDING), null);
    assert.deepEqual(fake.messages, []);
});

test("ignores switched and mismatched Canvas contexts", async () => {
    const fake = makeTabs([
        { id: 5, url: `${ORIGIN}/courses/1` },
        { id: 6, url: `${ORIGIN}/dashboard` }
    ], {
        5: [context({ canvasUser: { id: "canvas-user-2" } })],
        6: [context(), verified({ userId: "canvas-user-2" })]
    });
    const resolver = createCanvasSessionResolver({ tabs: fake.tabs, configuredOrigins: [ORIGIN] });
    assert.equal(await resolver.resolve(BINDING), null);
    assert.deepEqual(fake.messages.map(({ tabId, message }) => [tabId, message.type]), [[5, "GET_CANVAS_CONTEXT"], [6, "GET_CANVAS_CONTEXT"], [6, "CANVAS_ACCOUNT_VERIFY"]]);
});

test("uses the exact two-message context and verification flow", async () => {
    const ids = ["context-request", "verify-request"];
    const fake = makeTabs([{ id: 9, url: `${ORIGIN}/courses/42?view=all` }], { 9: [context(), verified()] });
    const resolver = createCanvasSessionResolver({ tabs: fake.tabs, configuredOrigins: [`${ORIGIN}/`], idFactory: () => ids.shift() });
    const session = await resolver.resolve(BINDING);

    assert.deepEqual(fake.messages, [
        { tabId: 9, message: { type: "GET_CANVAS_CONTEXT", version: 1, requestId: "context-request" } },
        { tabId: 9, message: { type: "CANVAS_ACCOUNT_VERIFY", version: 1, requestId: "verify-request", payload: { expectedOrigin: ORIGIN, expectedUserId: "canvas-user-1" } } }
    ]);
    assert.deepEqual(session, { tabId: 9, origin: ORIGIN, canvasUserId: "canvas-user-1", accountKey: "account-hash" });
    assert.equal(Object.isFrozen(session), true);
});

test("chooses current-window active, then active, then lowest numeric tab id", async () => {
    const fake = makeTabs([
        { id: 40, url: `${ORIGIN}/a`, active: false, currentWindow: true },
        { id: 30, url: `${ORIGIN}/b`, active: true, currentWindow: false },
        { id: 20, url: `${ORIGIN}/c`, active: true, currentWindow: true },
        { id: 10, url: `${ORIGIN}/d`, active: false, currentWindow: false }
    ], {
        10: [context(), verified()], 20: [context(), verified()], 30: [context(), verified()], 40: [context(), verified()]
    });
    const resolver = createCanvasSessionResolver({ tabs: fake.tabs, configuredOrigins: [ORIGIN], idFactory: (() => { let id = 0; return () => `request-${++id}`; })() });
    assert.equal((await resolver.resolve(BINDING)).tabId, 20);
});

test("ignores tabs that close or fail during either direct request", async () => {
    const fake = makeTabs([
        { id: 7, url: `${ORIGIN}/closed` },
        { id: 8, url: `${ORIGIN}/healthy` }
    ], { 7: [new Error("tab closed")], 8: [context(), new Error("tab closed after context")] });
    const resolver = createCanvasSessionResolver({ tabs: fake.tabs, configuredOrigins: [ORIGIN] });
    assert.equal(await resolver.resolve(BINDING), null);
    assert.deepEqual(fake.messages.map(({ tabId, message }) => [tabId, message.type]), [[7, "GET_CANVAS_CONTEXT"], [8, "GET_CANVAS_CONTEXT"], [8, "CANVAS_ACCOUNT_VERIFY"]]);
});
