"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createContentSyncExtraction, TYPE, MAX_ITEMS, MAX_BYTES } = require("../../js/content/sync-extraction.js");

const RUNTIME_ID = "abcdefghijklmnopabcdefghijklmnop";
const ORIGIN = "https://canvas.example.edu";
const BASE = {
    contract_version: 1,
    request_id: "sync-request-1",
    type: TYPE,
    payload: {
        expectedOrigin: ORIGIN,
        canvasUserId: "student-1",
        accountKey: "account-key-1",
        sourceId: "source-1",
        runId: "run-1",
        generation: 7,
        consentVersion: "consent-v1",
        scope: { types: ["assignment"], context_ids: ["42"] },
        descriptors: [{ id: "assignment:42", resource: "assignment" }],
        checkpoint: { page: 1 }
    }
};
const BACKGROUND = { id: RUNTIME_ID, url: `chrome-extension://${RUNTIME_ID}/background.html` };
const CONTEXT = { ok: true, state: "connected", origin: ORIGIN, canvasUser: { id: "student-1" }, accountKey: "account-key-1" };

function message(overrides = {}) {
    return { ...BASE, ...overrides, payload: { ...BASE.payload, ...(overrides.payload || {}) } };
}

function response(overrides = {}) {
    return { ok: true, state: "complete", batches: [{ items: [{ eventRef: "event-1" }], checkpoint: { page: 2 }, payloadHash: "hash-1" }], descriptorProgress: 1, quarantineCount: 0, checkpointHash: "checkpoint-1", complete: true, errorCode: null, ...overrides };
}

function setup({ extractorResult = response(), context = CONTEXT, factory = null } = {}) {
    const calls = { context: [], factory: [], extractor: [] };
    const extractorFactory = factory || (async (value) => {
        calls.factory.push(value);
        return { handle: async (request) => { calls.extractor.push(request); return extractorResult; } };
    });
    const handler = createContentSyncExtraction({
        runtimeId: RUNTIME_ID,
        getCanvasContext: async (value) => { calls.context.push(value); return context; },
        extractorFactory
    });
    return { handler, calls };
}

test("accepts an own extension background sender and invokes the extractor with the same binding/plan", async () => {
    const { handler, calls } = setup();
    const result = await handler.handle(BASE, BACKGROUND);
    assert.deepEqual(result, response());
    assert.equal(calls.context.length, 1);
    assert.deepEqual(calls.factory[0].binding, {
        origin: ORIGIN, expectedOrigin: ORIGIN, userId: "student-1", canvasUserId: "student-1", accountKey: "account-key-1",
        sourceId: "source-1", runId: "run-1", generation: 7, consentVersion: "consent-v1"
    });
    assert.deepEqual(calls.factory[0].plan, { scope: BASE.payload.scope, descriptors: BASE.payload.descriptors, checkpoint: BASE.payload.checkpoint });
    assert.equal(calls.extractor[0].type, "CANVAS_EXTRACT_RUN");
    assert.equal(calls.extractor[0].payload.account_hash, "account-key-1");
});

test("constructs safely but stays inert when the private extractor authority is unavailable", async () => {
    const { handler, calls } = setup({ factory: async () => null });
    const result = await handler.handle(BASE, BACKGROUND);
    assert.deepEqual(result, {
        ok: false,
        state: "error",
        batches: [],
        descriptorProgress: 0,
        quarantineCount: 0,
        checkpointHash: null,
        complete: false,
        errorCode: "CANVAS_EXTRACTOR_UNAVAILABLE"
    });
    assert.equal(calls.context.length, 1);
});

test("rejects popup, options, page, foreign, and ambiguous senders before context or extractor", async () => {
    const senders = [
        { id: RUNTIME_ID, url: `chrome-extension://${RUNTIME_ID}/popup.html` },
        { id: RUNTIME_ID, url: `chrome-extension://${RUNTIME_ID}/options.html`, type: "options" },
        { id: RUNTIME_ID, tab: { id: 1 }, url: `${ORIGIN}/courses/42` },
        { id: "foreign-extension", url: "chrome-extension://foreign-extension/background.html" },
        { id: RUNTIME_ID, url: `chrome-extension://${RUNTIME_ID}/unknown.html`, type: "unknown" },
        { id: RUNTIME_ID, url: `chrome-extension://${RUNTIME_ID}/background.html`, documentId: "popup-document" }
    ];
    for (const sender of senders) {
        const { handler, calls } = setup();
        const result = await handler.handle(BASE, sender);
        assert.equal(result.ok, false);
        assert.equal(result.errorCode, "CANVAS_SYNC_SENDER_NOT_ALLOWED");
        assert.deepEqual(calls.context, []);
        assert.deepEqual(calls.factory, []);
    }
});

test("rejects invalid envelopes and bindings", async () => {
    for (const invalid of [
        { contract_version: 2 },
        { ...BASE, type: "CANVAS_SYNC_START" },
        { ...BASE, request_id: "bad id" },
        { ...BASE, payload: { ...BASE.payload, generation: 0 } },
        { ...BASE, payload: { ...BASE.payload, descriptors: [] } },
        { ...BASE, payload: { ...BASE.payload, extra: true } },
        { ...BASE, payload: { ...BASE.payload, scope: { rawResponse: "no" } } }
    ]) {
        const { handler, calls } = setup();
        const result = await handler.handle(invalid, BACKGROUND);
        assert.equal(result.ok, false);
        assert.equal(calls.context.length, 0);
        assert.equal(calls.factory.length, 0);
    }
});

test("revalidates origin, user, and account and never invokes extractor on mismatch", async () => {
    for (const context of [
        { ...CONTEXT, origin: "https://other.example.edu" },
        { ...CONTEXT, canvasUser: { id: "student-2" } },
        { ...CONTEXT, accountKey: "other-account" },
        { ok: true, state: "connected", origin: ORIGIN, canvasUser: { id: "student-1" } }
    ]) {
        const { handler, calls } = setup({ context });
        const result = await handler.handle(BASE, BACKGROUND);
        assert.equal(result.ok, false);
        assert.equal(result.state, context.state === "connected" && context.origin === ORIGIN && context.canvasUser.id === "student-1" ? "mismatch" : "mismatch");
        assert.equal(calls.factory.length, 0);
    }
});

test("returns only the bounded safe result shape and rejects raw or secret extractor responses", async () => {
    for (const extractorResult of [
        { ...response(), rawResponse: { body: "raw" } },
        { ...response(), accessToken: "secret" },
        { ...response(), batches: [{ items: [{ authorization: "Bearer secret" }], checkpoint: {} }] }
    ]) {
        const { handler } = setup({ extractorResult });
        const result = await handler.handle(BASE, BACKGROUND);
        assert.equal(result.ok, false);
        assert.equal(result.errorCode, "CANVAS_SYNC_EXTRACTOR_RESPONSE_UNSAFE");
        assert.deepEqual(Object.keys(result).sort(), ["batches", "checkpointHash", "complete", "descriptorProgress", "errorCode", "ok", "quarantineCount", "state"]);
    }
});

test("preserves partial and complete states without leaking wrapper fields", async () => {
    const partial = response({ ok: false, state: "partial", complete: false, errorCode: "CANVAS_PAGE_FAILED", quarantineCount: 2 });
    const partialResult = await setup({ extractorResult: partial }).handler.handle(BASE, BACKGROUND);
    assert.deepEqual(partialResult, partial);
    const completeResult = await setup({ extractorResult: response() }).handler.handle(BASE, BACKGROUND);
    assert.equal(completeResult.complete, true);
    assert.equal(completeResult.ok, true);
});

test("rejects oversized item counts and batches", async () => {
    const many = response({ batches: [{ items: Array.from({ length: MAX_ITEMS + 1 }, (_, index) => ({ id: index })), checkpoint: {} }] });
    const tooManyResult = await setup({ extractorResult: many }).handler.handle(BASE, BACKGROUND);
    assert.equal(tooManyResult.errorCode, "CANVAS_SYNC_BATCH_INVALID");
    const tooLarge = response({ batches: [{ items: [{ value: "x".repeat(MAX_BYTES) }], checkpoint: {} }] });
    const tooLargeResult = await setup({ extractorResult: tooLarge }).handler.handle(BASE, BACKGROUND);
    assert.equal(tooLargeResult.errorCode, "CANVAS_SYNC_BATCH_TOO_LARGE");
});
