"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createCanvasExtractionMessenger } = require("../../js/platform/canvas-extraction-messenger.js");

const ORIGIN = "https://canvas.example.edu";
const SESSION = Object.freeze({ tabId: 19, accountKey: "account-1", origin: ORIGIN, canvasUserId: "student-1" });
const PAYLOAD = Object.freeze({
    expectedOrigin: ORIGIN,
    canvasUserId: "student-1",
    accountKey: "account-1",
    sourceId: "source-1",
    runId: "run-1",
    generation: 7,
    consentVersion: "consent-v1",
    scope: { courses: [42] },
    descriptors: [{ id: "assignment:42", resource: "assignment" }],
    checkpoint: null
});

function response(overrides = {}) {
    return {
        ok: true,
        state: "complete",
        batches: [{ items: [{ eventRef: "event-1" }], checkpoint: { page: 1 }, payloadHash: "hash-1" }],
        descriptorProgress: 1,
        quarantineCount: 0,
        checkpointHash: "checkpoint-1",
        complete: true,
        errorCode: null,
        ...overrides
    };
}

function setup(reply = response()) {
    const calls = [];
    const resolver = { isOwnedSession: (session) => session === SESSION };
    const tabs = { sendMessage: async (...args) => { calls.push(args); return reply; } };
    const messenger = createCanvasExtractionMessenger({ tabs, sessionResolver: resolver, idFactory: () => "request-1" });
    return { messenger, calls };
}

test("rejects forged sessions before tabs.sendMessage", async () => {
    const { messenger, calls } = setup();
    await assert.rejects(messenger.request({ ...SESSION }, PAYLOAD), (error) => error.code === "canvas_session_not_owned");
    assert.deepEqual(calls, []);
});

test("rejects binding mismatches and routing/message fields before send", async () => {
    for (const change of [
        { accountKey: "other" }, { expectedOrigin: "https://other.example.edu" }, { canvasUserId: "student-2" },
        { sourceId: "" }, { runId: "" }, { generation: 0 }, { consentVersion: "" },
        { tabId: 19 }, { windowId: 4 }, { type: "CANVAS_SYNC_EXTRACT_INTERNAL" }
    ]) {
        const { messenger, calls } = setup();
        await assert.rejects(messenger.request(SESSION, { ...PAYLOAD, ...change }));
        assert.deepEqual(calls, []);
    }
});

test("sends the exact branded envelope only to the owned tab", async () => {
    const { messenger, calls } = setup();
    const result = await messenger.request(SESSION, PAYLOAD);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 19);
    assert.deepEqual(calls[0][1], {
        contract_version: 1,
        type: "CANVAS_SYNC_EXTRACT_INTERNAL",
        request_id: "request-1",
        payload: PAYLOAD
    });
    assert.deepEqual(result, response());
});

test("returns normalized partial and complete extraction results", async () => {
    const partial = response({ ok: false, state: "partial", complete: false, errorCode: "CANVAS_PAGE_FAILED" });
    assert.deepEqual(await setup(partial).messenger.request(SESSION, PAYLOAD), partial);
    assert.deepEqual(await setup(response()).messenger.request(SESSION, PAYLOAD), response());
});

test("rejects raw wrappers, secret fields, unsafe URLs, and oversized batches", async () => {
    for (const reply of [
        { payload: response() },
        { ...response(), accessToken: "secret" },
        { ...response(), batches: [{ items: [{ rawResponse: { value: "raw" } }], checkpoint: {} }] },
        { ...response(), batches: [{ items: [{ link: "https://foreign.example.edu/private" }], checkpoint: {} }] },
        { ...response(), batches: [{ items: [{ value: "x".repeat(48 * 1024) }], checkpoint: {} }] },
        { ...response(), batches: [{ items: Array.from({ length: 81 }, (_, index) => ({ id: index })), checkpoint: {} }] }
    ]) {
        await assert.rejects(setup(reply).messenger.request(SESSION, PAYLOAD));
    }
});

test("converts tab closure and send errors to the safe waiting result", async () => {
    const calls = [];
    const messenger = createCanvasExtractionMessenger({
        tabs: { sendMessage: async (...args) => { calls.push(args); throw new Error("tab closed with secret token"); } },
        sessionResolver: { isOwnedSession: (session) => session === SESSION },
        idFactory: () => "request-1"
    });
    assert.deepEqual(await messenger.request(SESSION, PAYLOAD), {
        ok: false,
        state: "waiting_for_canvas_session",
        errorCode: "canvas_session_unavailable"
    });
    assert.equal(JSON.stringify(calls[0][1]).includes("secret"), false);
});

test("redacts tab/session/raw error data from returned results", async () => {
    const reply = {
        ...response({ state: "partial", complete: false, errorCode: "CANVAS_PAGE_FAILED" }),
        session: SESSION,
        tabId: 19,
        rawError: "Bearer secret"
    };
    await assert.rejects(setup(reply).messenger.request(SESSION, PAYLOAD));
});
