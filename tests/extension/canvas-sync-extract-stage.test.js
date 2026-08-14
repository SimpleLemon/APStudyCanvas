"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const identity = require("../../js/canvas-adapter/identity.js");
const { createSyncExtractStage } = require("../../js/canvas-adapter/sync-extract-stage.js");

const H = (value) => identity.sha256HexSync(String(value));
const binding = Object.freeze({ accountKey: H("account"), sourceId: "source-a", runId: "run-a", generation: 7 });

function item(label = "one", accountKey = binding.accountKey) {
    return {
        schemaVersion: 1,
        eventRef: `canvas:${accountKey}:${H(`event:${label}`)}`,
        source: {
            type: "assignment",
            accountKey,
            payloadHash: H(`payload:${label}`),
            revision: `version:${label}`,
            identity: { context: "course-1", remote: "1", occurrence: "1", item_key: `assignment%3Acourse-1%3A1%3A1` }
        },
        payload: { title: `Title ${label}`, date: { kind: "instant", utcInstant: "2026-08-13T12:00:00Z", sourceOffset: "Z" }, deadline: true }
    };
}

function result(batches = [{ items: [item()], checkpoint: { page: 1 }, payloadHash: H("batch-1") }], overrides = {}) {
    return { batches, descriptorProgress: 3, quarantineCount: 1, checkpointHash: "checkpoint-1", complete: false, ...overrides };
}

function fakeOutbox({ current = 7, enqueue = () => ({ ok: true }) } = {}) {
    const calls = [];
    return {
        calls,
        outbox: {
            async currentGeneration(namespace) { calls.push(["currentGeneration", namespace]); return typeof current === "function" ? current() : current; },
            async enqueue(value) { calls.push(["enqueue", value]); return enqueue(value); }
        }
    };
}

test("disabled is idle without validating or touching dependencies", async () => {
    const fake = fakeOutbox();
    const stage = createSyncExtractStage({ outbox: fake.outbox });
    assert.deepEqual(await stage.queueResult({ enabled: false, binding: null, result: null }), {
        state: "idle", queued: 0, quarantined: 0, descriptorProgress: 0, checkpointHash: null, errorCode: null
    });
    assert.deepEqual(fake.calls, []);
});

test("valid exact batches enqueue in order with deterministic namespace and factory ids", async () => {
    const fake = fakeOutbox();
    const stage = createSyncExtractStage({ outbox: fake.outbox, idFactory: ({ index }) => `idem-${index}` });
    const input = result([
        { items: [item("one")], checkpoint: { page: 1 } },
        { items: [item("two")], checkpoint: { page: 2 } }
    ]);
    const output = await stage.queueResult({ enabled: true, binding, result: input });
    assert.equal(output.state, "queued");
    assert.equal(output.queued, 2);
    assert.deepEqual(fake.calls.map(([name]) => name), ["currentGeneration", "enqueue", "currentGeneration", "enqueue"]);
    assert.deepEqual(fake.calls[1][1].namespace, { account: binding.accountKey, source: binding.sourceId, run: binding.runId, generation: binding.generation });
    assert.equal(fake.calls[1][1].idempotencyKey, "idem-0");
    assert.deepEqual(fake.calls[1][1].batch, input.batches[0]);
});

test("duplicate idempotency responses count once", async () => {
    const fake = fakeOutbox({ enqueue: () => ({ ok: true, duplicate: true }) });
    const stage = createSyncExtractStage({ outbox: fake.outbox });
    const output = await stage.queueResult({ enabled: true, binding, result: result([{ items: [item()], checkpoint: { page: 1 }, payloadHash: "stable-batch-id" }]) });
    assert.equal(output.state, "queued");
    assert.equal(output.queued, 1);
});

test("secret, raw, and URL fields are rejected before enqueue", async () => {
    for (const mutate of [
        (value) => ({ ...value, accessToken: "secret" }),
        (value) => ({ ...value, rawResponse: { value: "raw" } }),
        (value) => ({ ...value, batches: [{ ...value.batches[0], checkpoint: { url: "https://canvas.example" } }] })
    ]) {
        const fake = fakeOutbox();
        const stage = createSyncExtractStage({ outbox: fake.outbox });
        const output = await stage.queueResult({ enabled: true, binding, result: mutate(result()) });
        assert.equal(output.state, "error");
        assert.equal(fake.calls.length, 0);
    }
});

test("item count and complete enqueue payload size are bounded", async () => {
    const tooMany = result([{ items: Array.from({ length: 81 }, (_, index) => item(String(index))), checkpoint: { page: 1 } }]);
    const countFake = fakeOutbox();
    const countStage = createSyncExtractStage({ outbox: countFake.outbox, idFactory: () => "count-id" });
    assert.equal((await countStage.queueResult({ enabled: true, binding, result: tooMany })).errorCode, "batch_item_limit");
    assert.equal(countFake.calls.length, 0);

    const tooLarge = result([{ items: [item()], checkpoint: { cursor: "x".repeat(50000) } }]);
    const sizeFake = fakeOutbox();
    const sizeStage = createSyncExtractStage({ outbox: sizeFake.outbox, idFactory: () => "size-id" });
    assert.equal((await sizeStage.queueResult({ enabled: true, binding, result: tooLarge })).errorCode, "payload_too_large");
    assert.equal(sizeFake.calls.length, 0);
});

test("stale generation stops before the next enqueue", async () => {
    let checks = 0;
    const fake = fakeOutbox({ current: () => (checks++ === 0 ? 7 : 8) });
    const stage = createSyncExtractStage({ outbox: fake.outbox, idFactory: ({ index }) => `idem-${index}` });
    const output = await stage.queueResult({ enabled: true, binding, result: result([
        { items: [item("one")], checkpoint: { page: 1 } },
        { items: [item("two")], checkpoint: { page: 2 } }
    ]) });
    assert.equal(output.state, "superseded");
    assert.equal(output.queued, 1);
    assert.deepEqual(fake.calls.map(([name]) => name), ["currentGeneration", "enqueue", "currentGeneration"]);
});

test("capacity pauses without eviction and returns only safe result fields", async () => {
    const fake = fakeOutbox({ enqueue: () => ({ ok: false, state: "paused", code: "OUTBOX_CAPACITY_LIMIT", raw: "secret" }) });
    const stage = createSyncExtractStage({ outbox: fake.outbox, idFactory: () => "capacity-id" });
    const output = await stage.queueResult({ enabled: true, binding, result: result() });
    assert.deepEqual(Object.keys(output).sort(), ["checkpointHash", "descriptorProgress", "errorCode", "quarantined", "queued", "state"]);
    assert.deepEqual(output, {
        state: "paused", queued: 0, quarantined: 1, descriptorProgress: 3, checkpointHash: "checkpoint-1", errorCode: "capacity"
    });
    assert.equal(fake.calls.some(([name]) => /evict|delete|remove/i.test(name)), false);
});
