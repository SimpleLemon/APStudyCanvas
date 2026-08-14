"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createSyncUploader } = require("../../js/canvas-adapter/sync-uploader.js");

const binding = Object.freeze({ account: "account-a", source: "source-a", run: "run-a", generation: 7 });

function batch(overrides = {}) {
    return {
        batchId: "batch-1",
        idempotencyKey: "idem-1",
        payloadHash: "payload-1",
        namespace: { ...binding },
        items: [{ event: "normalized-item" }],
        ...overrides
    };
}

function fake({ lease = { leaseId: "lease-1", batch: batch(), attempts: 1 }, response, current = 7 } = {}) {
    const calls = [];
    const outbox = {
        async leaseNext(namespace) {
            calls.push(["leaseNext", namespace]);
            if (lease === null) return { ok: true, state: "empty", lease: null };
            if (lease.leaseId) return { ok: true, state: "leased", lease: { lease_id: lease.leaseId, attempt: lease.attempts }, batch: lease.batch };
            return lease;
        },
        async getCurrentGeneration(namespace) { calls.push(["getCurrentGeneration", namespace]); return typeof current === "function" ? current() : current; },
        async acknowledgeBatch(input) { calls.push(["acknowledgeBatch", input]); },
        async scheduleRetry(input) { calls.push(["scheduleRetry", input]); return { ok: true, state: "scheduled" }; }
    };
    const client = { async uploadBatch(receivedBinding, receivedBatch) { calls.push(["uploadBatch", receivedBinding, receivedBatch]); return typeof response === "function" ? response() : response; } };
    return { uploader: createSyncUploader({ client, outbox, clock: () => 1000 }), calls };
}

function receipt(overrides = {}) {
    return { receiptId: "receipt-1", batchId: "batch-1", idempotencyKey: "idem-1", payloadHash: "payload-1", generation: 7, ...overrides };
}

test("disabled and empty outbox are idle without upload work", async () => {
    const disabled = fake({ response: receipt() });
    assert.deepEqual(await disabled.uploader.uploadNext({ enabled: false, binding }), { state: "idle" });
    assert.deepEqual(disabled.calls, []);
    const empty = fake({ lease: null, response: receipt() });
    assert.deepEqual(await empty.uploader.uploadNext({ enabled: true, binding }), { state: "idle" });
    assert.deepEqual(empty.calls.map(([name]) => name), ["leaseNext"]);
});

test("successful upload atomically acknowledges the validated receipt", async () => {
    const fakeState = fake({ response: receipt({ secret: "must not persist" }) });
    const result = await fakeState.uploader.uploadNext({ enabled: true, binding });
    assert.equal(result.state, "queued");
    assert.deepEqual(fakeState.calls.map(([name]) => name), ["leaseNext", "getCurrentGeneration", "uploadBatch", "getCurrentGeneration", "acknowledgeBatch"]);
    const acknowledged = fakeState.calls.find(([name]) => name === "acknowledgeBatch")[1];
    assert.deepEqual(acknowledged.receipt, {
        idempotency_hash: "idem-1",
        payload_hash: "payload-1",
        generation: 7
    });
    assert.doesNotMatch(JSON.stringify(acknowledged), /must not persist|secret/i);
});

test("receipt binding mismatch fails without recording or acknowledging", async () => {
    const fakeState = fake({ response: receipt({ payloadHash: "other-payload" }) });
    const result = await fakeState.uploader.uploadNext({ enabled: true, binding });
    assert.equal(result.code, "receipt_mismatch");
    assert.deepEqual(fakeState.calls.map(([name]) => name), ["leaseNext", "getCurrentGeneration", "uploadBatch", "getCurrentGeneration", "scheduleRetry"]);
    assert.equal(fakeState.calls.some(([name]) => name === "acknowledgeBatch"), false);
    assert.deepEqual(fakeState.calls.at(-1)[1], { lease: { lease_id: "lease-1", attempt: 1 }, delayMs: 300000, errorClass: "validation" });
});

test("retryable failures schedule bounded retry and pause after the eighth attempt", async () => {
    const fakeState = fake({ lease: { leaseId: "lease-1", batch: batch(), attempts: 8 }, response: { status: 429, retryAfterMs: 999999 } });
    const result = await fakeState.uploader.uploadNext({ enabled: true, binding });
    assert.equal(result.state, "paused");
    assert.deepEqual(fakeState.calls.map(([name]) => name), ["leaseNext", "getCurrentGeneration", "uploadBatch", "getCurrentGeneration", "scheduleRetry"]);
    assert.deepEqual(fakeState.calls.find(([name]) => name === "scheduleRetry")[1], { lease: { lease_id: "lease-1", attempt: 8 }, delayMs: 300000, errorClass: "rate_limited" });
    assert.equal(fakeState.calls.some(([name]) => name === "acknowledgeBatch"), false);
});

test("forbidden responses fail closed and never acknowledge", async () => {
    const fakeState = fake({ response: { status: 403, body: { event: "private" } } });
    const result = await fakeState.uploader.uploadNext({ enabled: true, binding });
    assert.deepEqual(result.state, "error");
    assert.equal(result.code, "forbidden");
    assert.equal(fakeState.calls.some(([name]) => name === "acknowledgeBatch"), false);
    assert.deepEqual(fakeState.calls.find(([name]) => name === "scheduleRetry")[1], { lease: { lease_id: "lease-1", attempt: 1 }, delayMs: 300000, errorClass: "validation" });
});

test("stale generation before upload releases the lease", async () => {
    const fakeState = fake({ response: receipt(), current: 8 });
    const result = await fakeState.uploader.uploadNext({ enabled: true, binding });
    assert.equal(result.code, "stale_generation");
    assert.equal(fakeState.calls.some(([name]) => name === "uploadBatch"), false);
    assert.equal(fakeState.calls.some(([name]) => name === "acknowledgeBatch"), false);
    assert.deepEqual(fakeState.calls.at(-1)[1], { lease: { lease_id: "lease-1", attempt: 1 }, delayMs: 300000, errorClass: "conflict" });
});

test("stale generation after response releases the lease without receipt writes", async () => {
    let count = 0;
    const fakeState = fake({ response: receipt(), current: () => (count++ === 0 ? 7 : 8) });
    const result = await fakeState.uploader.uploadNext({ enabled: true, binding });
    assert.equal(result.code, "stale_generation");
    assert.equal(fakeState.calls.some(([name]) => name === "acknowledgeBatch"), false);
    assert.deepEqual(fakeState.calls.at(-1)[1], { lease: { lease_id: "lease-1", attempt: 1 }, delayMs: 300000, errorClass: "conflict" });
});

test("malformed batches and receipts are rejected and all returned data is redacted", async () => {
    const malformedBatch = fake({ lease: { leaseId: "lease-1", batch: batch({ lease: { token: "secret" } }) }, response: receipt() });
    assert.equal((await malformedBatch.uploader.uploadNext({ enabled: true, binding })).code, "malformed");
    assert.equal(malformedBatch.calls.some(([name]) => name === "uploadBatch"), false);
    const redacted = fake({ response: receipt({ url: "https://private.example/item", event: "private-event", accessToken: "secret" }) });
    const result = await redacted.uploader.uploadNext({ enabled: true, binding });
    assert.equal(result.state, "queued");
    assert.doesNotMatch(JSON.stringify(result), /private|secret|https?:/i);
    const saved = redacted.calls.find(([name]) => name === "acknowledgeBatch")[1];
    assert.doesNotMatch(JSON.stringify(saved), /private|secret|https?:/i);
    const invalidBinding = fake({ response: receipt() });
    const invalid = await invalidBinding.uploader.uploadNext({ enabled: true, binding: { ...binding, generation: 0 } });
    assert.deepEqual(invalidBinding.calls, []);
    assert.equal(invalid.code, "invalid_binding");
});
