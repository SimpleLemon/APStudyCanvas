"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const syncClient = require("../../js/canvas-adapter/sync-client.js");

const ORIGIN = "https://canvas.example.edu";
const SOURCE_REF = "src1:opaque-a";
const BASE = Object.freeze({
    contractVersion: 1,
    accountKey: "account-hash",
    origin: ORIGIN,
    providerUserId: "canvas-user-1",
    label: "Canvas",
    consentVersion: 1,
    scope: { course: "course-hash" }
});

function proof(overrides = {}) {
    return {
        contractVersion: 1,
        account_key: "account-hash",
        consent_version: 1,
        identity: { state: "authenticated", user_id: "nest-user-1" },
        consent: { current: true, account_key: "account-hash", consent_version: 1, scopes: ["full_history_upload", "ongoing_read"] },
        ...overrides
    };
}

function binding(overrides = {}) {
    return { ...BASE, ...overrides };
}

function makeStore() {
    const values = new Map();
    return {
        values,
        async get(key) { return values.get(key); },
        async set(key, value) { values.set(key, value); },
        async remove(key) { values.delete(key); }
    };
}

function makeTransport(responses = []) {
    const calls = [];
    const transport = async (request) => {
        calls.push(request);
        return responses.shift() || { ok: true, status: 200, body: { accepted: true } };
    };
    transport.calls = calls;
    return transport;
}

function makeClient(responses = []) {
    const store = makeStore();
    let metadata = { version: 1, accounts: {} };
    const sourceMetadataStore = {
        async get() { return metadata; },
        async set(value) { metadata = value; }
    };
    const transport = makeTransport(responses);
    const client = syncClient({ transport, sessionSecretStore: store, sourceMetadataStore, idFactory: (label) => `${label}-id` });
    return { client, transport, store, get metadata() { return metadata; } };
}

async function ready(client) { await client.preflight(proof()); }

function runBinding(overrides = {}) { return binding({ runId: "run-1", generation: 3, ...overrides }); }

function normalizedItem(label = "one") {
    return {
        schemaVersion: 1,
        eventRef: `canvas:event-${label}`,
        source: { type: "assignment", account_hash: "account-hash" },
        payload: { title: `Generated ${label}`, date: { kind: "due", utcInstant: "2026-08-12T12:00:00Z" } }
    };
}

test("preflight is local, explicit, and gates transport and persistence", async () => {
    const { client, transport, store } = makeClient();
    await assert.rejects(client.establishSource(BASE), (error) => error.code === "SYNC_PREFLIGHT_REQUIRED");
    assert.equal(transport.calls.length, 0);
    assert.equal(store.values.size, 0);
    await assert.rejects(client.preflight(proof({ consent_version: "consent-v1" })), /SYNC_CONSENT_VERSION_INVALID/);
    assert.equal(transport.calls.length, 0);
    assert.equal(store.values.size, 0);
    const result = await client.preflight(proof());
    assert.deepEqual(result, { ok: true, contractVersion: 1 });
    assert.doesNotMatch(JSON.stringify(result), /account|email|token/i);
});

test("source, start, status, lease operations, batch, and finalize use exact routes and bodies", async () => {
    const fake = makeClient([
        { ok: true, status: 200, body: { source_ref: SOURCE_REF, account_key: "account-hash", source_key: "canvas:account-hash" } },
        { ok: true, status: 200, body: { run_id: "run-1", generation: 3, lease_token: "lease-a" } },
        { ok: true, status: 200, body: { run: { run_id: "run-1", generation: 3, lease_token: "lease-b", state: "running" } } },
        { ok: true, status: 200, body: { run_id: "run-1", generation: 3, lease_token: "lease-c" } },
        { ok: true, status: 200, body: { run_id: "run-1", generation: 3, lease_token: "lease-d" } },
        { ok: true, status: 200, body: { accepted: 1 } },
        { ok: true, status: 200, body: { complete: true } }
    ]);
    const { client, transport, store } = fake;
    await ready(client);
    await client.establishSource(BASE);
    assert.equal(fake.metadata.accounts["account-hash"].nest_user_id, "nest-user-1");
    const established = binding({ sourceRef: SOURCE_REF });
    await client.startRun(established);
    const run = runBinding({ sourceRef: SOURCE_REF });
    await client.status(run);
    await client.resume(run);
    await client.renew(run);
    await client.uploadBatch(run, { items: [normalizedItem()], checkpoint: { page: 1 }, idempotencyKey: "batch-1" });
    await client.finalize(run, "complete");
    assert.deepEqual(transport.calls.map(({ method, path, query }) => ({ method, path, query })), [
        { method: "POST", path: "/api/extension/calendar/sources", query: undefined },
        { method: "POST", path: "/api/extension/calendar/sources/src1%3Aopaque-a/sync", query: undefined },
        { method: "GET", path: "/api/extension/calendar/sources/src1%3Aopaque-a/sync/run-1", query: { generation: 3 } },
        { method: "PUT", path: "/api/extension/calendar/sources/src1%3Aopaque-a/sync/run-1/resume", query: undefined },
        { method: "PUT", path: "/api/extension/calendar/sources/src1%3Aopaque-a/sync/run-1/renew", query: undefined },
        { method: "POST", path: "/api/extension/calendar/sources/src1%3Aopaque-a/sync/run-1/batch", query: undefined },
        { method: "POST", path: "/api/extension/calendar/sources/src1%3Aopaque-a/sync/run-1/finalize", query: undefined }
    ]);
    assert.equal(transport.calls[0].body.account_key, "account-hash");
    assert.match(transport.calls[0].body.source_id, /^canvas-history-v1-[0-9a-f]{16}$/);
    assert.deepEqual(transport.calls[0].body, { account_key: "account-hash", source_id: transport.calls[0].body.source_id, origin: ORIGIN, provider_user_id: "canvas-user-1", label: "Canvas", consent_version: 1 });
    assert.deepEqual(transport.calls[1].body, { scope: BASE.scope, consent_version: 1, idempotency_key: "run-start-idempotency-id" });
    assert.deepEqual(transport.calls[2].body, undefined);
    assert.deepEqual(transport.calls[3].body, { generation: 3, lease_token: "lease-b" });
    assert.deepEqual(transport.calls[4].body, { generation: 3, lease_token: "lease-c" });
    assert.deepEqual(transport.calls[5].body, { items: [normalizedItem()], generation: 3, lease_token: "lease-d", idempotency_key: "batch-1", checkpoint: { page: 1 } });
    assert.deepEqual(transport.calls[6].body, { scope: BASE.scope, generation: 3, lease_token: "lease-d", status: "complete" });
    assert.equal(store.values.size, 0);
});

test("lease tokens are session-only, redacted from returns, and missing leases fail before transport", async () => {
    const { client, transport, store } = makeClient([{ ok: true, status: 200, body: { run_id: "run-1", generation: 3, lease_token: "opaque" } }]);
    await ready(client);
    const result = await client.startRun(runBinding({ sourceRef: SOURCE_REF }));
    assert.doesNotMatch(JSON.stringify(result), /opaque|lease.?token/i);
    assert.equal(store.values.get(`apsc-sync-v1:account-hash:${SOURCE_REF}:run-1:3`), "opaque");
    const other = runBinding({ sourceRef: SOURCE_REF, generation: 4 });
    await assert.rejects(client.status(other), /SYNC_LEASE_MISSING/);
    assert.equal(transport.calls.length, 1);
});

test("binding, path, terminal status, batch shape, item, and size validation fail closed", async () => {
    const { client, transport, store } = makeClient();
    await ready(client);
    await assert.rejects(client.startRun(binding({ sourceRef: SOURCE_REF, sourceId: "../source" })), /SYNC_SOURCE_ID_INVALID/);
    await assert.rejects(client.startRun(binding({ accountKey: "other-account", sourceRef: SOURCE_REF })), /SYNC_BINDING_AUTH_MISMATCH/);
    await assert.rejects(client.finalize(runBinding({ sourceRef: SOURCE_REF }), "done"), /SYNC_FINAL_STATUS_INVALID/);
    store.values.set(`apsc-sync-v1:account-hash:${SOURCE_REF}:run-1:3`, "lease");
    await assert.rejects(client.uploadBatch(runBinding({ sourceRef: SOURCE_REF }), { items: [normalizedItem()], checkpoint: { page: 1 }, idempotencyKey: "x", response: {} }), /SYNC_RAW_ITEM_REJECTED|SYNC_CHECKPOINT_INVALID/);
    await assert.rejects(client.uploadBatch(runBinding({ sourceRef: SOURCE_REF }), { items: Array.from({ length: 81 }, () => normalizedItem()), checkpoint: { page: 1 }, idempotencyKey: "x" }), /SYNC_BATCH_LIMIT_EXCEEDED/);
    await assert.rejects(client.uploadBatch(runBinding({ sourceRef: SOURCE_REF }), { items: [{ ...normalizedItem(), payload: { url: "https://foreign.example/item" } }], checkpoint: { page: 1 }, idempotencyKey: "x" }), /SYNC_UNSAFE_URL_REJECTED/);
    await assert.rejects(client.uploadBatch(runBinding({ sourceRef: SOURCE_REF }), { items: [normalizedItem()], checkpoint: { page: "x" }, idempotencyKey: "x" }), /SYNC_CHECKPOINT_INVALID|SYNC_RAW_ITEM_REJECTED/);
    assert.equal(transport.calls.length, 0);
});

test("batch request is capped at 48 KiB and all idempotency fields are bounded", async () => {
    const { client, transport, store } = makeClient();
    await ready(client);
    store.values.set(`apsc-sync-v1:account-hash:${SOURCE_REF}:run-1:3`, "lease");
    const oversized = normalizedItem("large");
    oversized.payload.title = "x".repeat(50000);
    await assert.rejects(client.uploadBatch(runBinding({ sourceRef: SOURCE_REF }), { items: [oversized], checkpoint: { page: 1 }, idempotencyKey: "batch" }), /SYNC_BATCH_BYTES_EXCEEDED/);
    await assert.rejects(client.uploadBatch(runBinding({ sourceRef: SOURCE_REF }), { items: [normalizedItem()], checkpoint: { page: 1 }, idempotencyKey: "bad key" }), /SYNC_IDEMPOTENCY_KEY_INVALID/);
    assert.equal(transport.calls.length, 0);
});

test("sanitized HTTP and offline errors contain only bounded metadata", async () => {
    for (const response of [
        { ok: false, status: 401, body: { email: "private@example.edu", token: "secret" } },
        { ok: false, status: 403, body: { account_key: "private-account" } },
        { ok: false, status: 429, retryAfterMs: 999999, body: { event: "private" } },
        { ok: false, status: 0, body: { secret: "private" } }
    ]) {
        const { client } = makeClient([response]);
        await ready(client);
        await assert.rejects(client.establishSource(BASE), (error) => {
            assert.ok(["SYNC_UNAUTHENTICATED", "SYNC_FORBIDDEN", "SYNC_RATE_LIMITED", "SYNC_OFFLINE"].includes(error.code));
            assert.ok(error.status >= 0 && error.status <= 599);
            assert.ok(!Object.prototype.hasOwnProperty.call(error, "body"));
            assert.ok(!Object.prototype.hasOwnProperty.call(error, "account_key"));
            assert.ok(!Object.prototype.hasOwnProperty.call(error, "retryAfterMs") || error.retryAfterMs <= 300000);
            return true;
        });
    }
});

test("existing request/mutate transport shape is adapted without arbitrary URLs", async () => {
    const calls = [];
    const store = makeStore();
    const transport = {
        async request(spec, options) { calls.push({ kind: "request", spec, options }); return { ok: true, status: 200, body: { lease_token: "from-status" } }; },
        async mutate(spec, options) { calls.push({ kind: "mutate", spec, options }); return { ok: true, status: 200, body: { accepted: true } }; }
    };
    const client = syncClient({ transport, sessionSecretStore: store, idFactory: (label) => `${label}-id` });
    await ready(client);
    store.values.set(`apsc-sync-v1:account-hash:${SOURCE_REF}:run-1:3`, "lease");
    await client.status(runBinding({ sourceRef: SOURCE_REF }));
    assert.equal(calls[0].kind, "request");
    assert.equal(calls[0].spec.path, "/api/extension/calendar/sources/src1%3Aopaque-a/sync/run-1?generation=3");
    await client.renew(runBinding({ sourceRef: SOURCE_REF }));
    assert.equal(calls[1].kind, "mutate");
    assert.equal(calls[1].spec.path, "/api/extension/calendar/sources/src1%3Aopaque-a/sync/run-1/renew");
    assert.equal(calls[1].options.internalLease, true);
});
