"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const identity = require("../../js/canvas-adapter/identity.js");
const indexedDb = require("../../js/platform/idb.js");
const outboxApi = require("../../js/canvas-adapter/outbox.js");

const H = (label) => identity.sha256HexSync(`generated:${label}`);
const RAW = Object.freeze({ account: "raw-account-271828", source: "raw-source-314159", run: "raw-run-161803" });

function namespace(overrides = {}) {
    return {
        accountHash: overrides.accountHash || H(overrides.account || "account-a"),
        sourceHash: overrides.sourceHash || H(overrides.source || "source-a"),
        runHash: overrides.runHash || H(overrides.run || "run-a"),
        generation: overrides.generation ?? 0
    };
}

function item(label, accountHash = namespace().accountHash) {
    return {
        schemaVersion: 1,
        eventRef: `canvas:${accountHash}:${H(`event:${label}`)}`,
        source: { type: "assignment", account_hash: accountHash },
        payload: {
            title: `Generated title ${label}`,
            date: { kind: "due", utcInstant: "2026-08-12T12:00:00Z", sourceOffset: "Z" },
            deadline: true,
            completion: { status: "incomplete", submission: { present: false, complete: false } }
        }
    };
}

function batch(label, ns = namespace()) {
    return { items: [item(label, ns.accountHash)] };
}

function checkpoint(ns, page = 1) {
    return {
        contract_version: 1,
        source_hash: ns.sourceHash,
        account_hash: ns.accountHash,
        expected_origin_hash: H("https://canvas.generated.example.edu"),
        expected_user_hash: H("generated-user"),
        consent_version: "generated-consent-v1",
        scope: { course: H("course-generated") },
        filter: { kind: "upcoming" },
        window: { start: "2026-08-01", end: "2026-08-31" },
        generation: ns.generation,
        window_index: 0,
        page,
        counters: { pages: page, items: page * 2, windows: 1, retries: 0 },
        cursor: `cursor-${page}`
    };
}

function makeStore(options = {}) {
    return indexedDb.createMemoryBoundedStore({ maxBytes: 25 * 1024 * 1024, maxRecords: 10000, ...options });
}

function makeOutbox(store, options = {}) {
    return outboxApi.createOutbox({ store, now: options.now || (() => 1000), leaseMs: options.leaseMs, hooks: options.hooks, crashAtStep: options.crashAtStep });
}

function errorWithCode(code) {
    const error = new Error(code);
    error.code = code;
    error.simulatedCrash = true;
    return error;
}

async function storedValues(store) {
    return (await store.list()).map((entry) => entry.value);
}

test("namespace, hashes, and persisted keys contain no raw identifiers", async () => {
    const ns = outboxApi.namespace({ ...RAW, generation: 7 });
    assert.match(ns.account_hash, /^[a-f0-9]{64}$/);
    assert.match(ns.source_hash, /^[a-f0-9]{64}$/);
    assert.match(ns.run_hash, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(JSON.stringify(ns), /raw-account|raw-source|raw-run/);

    const store = makeStore();
    const box = makeOutbox(store);
    await box.enqueueBatch({ namespace: ns, idempotencyKey: "raw-idempotency-key", batch: batch("safe-event", ns) });
    const serialized = JSON.stringify(await store.list());
    assert.doesNotMatch(serialized, /raw-account|raw-source|raw-run|raw-idempotency-key/);
    assert.match(serialized, new RegExp(`${outboxApi.VERSION}`));
});

test("accepted record schemas are normalized and secret/private data is rejected", async () => {
    const ns = namespace();
    const store = makeStore();
    const box = makeOutbox(store);
    await box.enqueueBatch({ namespace: ns, idempotencyKey: "schema-batch", batch: batch("schema", ns), checkpoint: checkpoint(ns) });
    const intent = await box.enqueueWritebackIntent({
        namespace: ns,
        idempotencyKey: "schema-intent",
        targetAccount: "generated-target-account",
        expectedRevision: "generated-revision",
        mutation: { completed: true, value_hash: H("generated-answer") }
    });
    await box.transitionWriteback({ intentKey: intent.intent.intent_key, state: "queued" });
    await box.transitionWriteback({ intentKey: intent.intent.intent_key, state: "applied" });

    const allowed = {
        normalized_batch: new Set(["schema_version", "key_prefix", "record_type", "namespace", "idempotency_hash", "payload_hash", "batch_sequence", "status", "attempt", "retry_after", "payload", "committed", "commit_id", "transaction_target_keys", "lease", "ack_pending", "last_error_class"]),
        checkpoint: new Set(["schema_version", "key_prefix", "record_type", "namespace", "checkpoint", "committed", "commit_id", "transaction_target_keys"]),
        generation_meta: new Set(["schema_version", "key_prefix", "record_type", "account_hash", "scope_hash", "latest_generation", "latest_generation_hash", "cancelled", "revoked", "reason_hash", "updated_at"]),
        writeback_intent: new Set(["schema_version", "key_prefix", "record_type", "namespace", "idempotency_hash", "target_account_hash", "expected_revision_hash", "payload_hash", "mutation", "state", "attempt", "committed"]),
        writeback_result: new Set(["schema_version", "key_prefix", "record_type", "namespace", "idempotency_hash", "payload_hash", "expected_revision_hash", "target_account_hash", "state", "error_class", "correlation_hash", "committed"]),
        upload_receipt: new Set(["schema_version", "key_prefix", "record_type", "namespace", "idempotency_hash", "payload_hash", "generation_hash", "receipt_hash", "accepted", "transaction_state", "committed"])
    };
    for (const value of await storedValues(store)) {
        assert.ok(allowed[value.record_type], value.record_type);
        for (const key of Object.keys(value)) assert.ok(allowed[value.record_type].has(key), `${value.record_type}.${key}`);
    }
    const serialized = JSON.stringify(await storedValues(store));
    assert.doesNotMatch(serialized, /generated-target-account|generated-revision|generated-answer/);

    const rejected = [
        { payload: { title: "Bearer generated.token.value" } },
        { description: "private description" },
        { email: "student@example.invalid" },
        { privateIcs: "https://calendar.example.invalid/private.ics" },
        { cookie: "session=opaque" },
        { csrfToken: "opaque" },
        { accessToken: "opaque" }
    ];
    for (const fields of rejected) {
        await assert.rejects(
            box.enqueueBatch({ namespace: ns, idempotencyKey: `reject-${H(JSON.stringify(fields))}`, batch: { items: [{ ...item(JSON.stringify(fields), ns.accountHash), payload: fields }] } }),
            /OUTBOX_(SECRET_REJECTED|RAW_DATA_REJECTED|BATCH_ITEM_INVALID)/,
            JSON.stringify(fields)
        );
    }
    await assert.rejects(box.enqueueBatch({ namespace: ns, idempotencyKey: "reject-checkpoint", batch: batch("reject-checkpoint", ns), checkpoint: { ...checkpoint(ns), description: "not allowed" } }), /OUTBOX_CHECKPOINT_INVALID|OUTBOX_RAW_DATA_REJECTED/);
    await assert.rejects(box.enqueueWritebackIntent({ namespace: ns, idempotencyKey: "reject-mutation", mutation: { description: "not allowed" }, targetAccount: "target" }), /OUTBOX_(SECRET_REJECTED|MUTATION_FIELDS_INVALID|RAW_DATA_REJECTED)/);
});

test("enqueue is idempotent for equal payloads and conflicts for different payloads", async () => {
    const ns = namespace();
    const box = makeOutbox(makeStore());
    const first = await box.enqueueBatch({ namespace: ns, idempotencyKey: "same-key", batch: batch("same", ns) });
    const duplicate = await box.enqueueBatch({ namespace: ns, idempotencyKey: "same-key", batch: batch("same", ns) });
    const conflict = await box.enqueueBatch({ namespace: ns, idempotencyKey: "same-key", batch: batch("different", ns) });
    assert.equal(first.ok, true);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.batch.payload_hash, first.batch.payload_hash);
    assert.deepEqual(conflict, { ok: false, state: "conflict", code: "OUTBOX_IDEMPOTENCY_CONFLICT", idempotency_hash: first.batch.idempotency_hash });
});

test("journal recovery reconciles every prepare and commit crash point", async () => {
    const ns = namespace();
    const dryStore = makeStore();
    const observed = [];
    await makeOutbox(dryStore, { hooks: { afterStep: async (step) => observed.push(step) } }).enqueueBatch({ namespace: ns, idempotencyKey: "crash-matrix", batch: batch("crash", ns), checkpoint: checkpoint(ns) });
    assert.deepEqual(observed.map((step) => step.split(":")[0]), ["journal_prepared", "target_prepared", "target_prepared", "target_committed", "target_committed", "journal_committed", "journal_acknowledged"]);

    for (const [index, crashStep] of observed.entries()) {
        const store = makeStore();
        const box = makeOutbox(store, { hooks: { afterStep: async (step) => { if (step === crashStep) throw errorWithCode("OUTBOX_SIMULATED_CRASH"); } } });
        await assert.rejects(box.enqueueBatch({ namespace: ns, idempotencyKey: "crash-matrix", batch: batch("crash", ns), checkpoint: checkpoint(ns) }), /OUTBOX_SIMULATED_CRASH/);
        const restarted = makeOutbox(store);
        await restarted.init();
        const pending = await restarted.listPending({ namespace: ns, includeSuperseded: true });
        if (index < 2) {
            assert.equal(pending.length, 0, `crash at ${crashStep}`);
            assert.equal(await restarted.getCheckpoint({ namespace: ns }), null, `crash at ${crashStep}`);
        } else {
            assert.equal(pending.length, 1, `crash at ${crashStep}`);
            assert.equal((await restarted.getCheckpoint({ namespace: ns })).page, 1, `crash at ${crashStep}`);
        }
        assert.equal((await storedValues(store)).some((value) => value.record_type === "journal"), false, `journal leaked at ${crashStep}`);
    }
});

test("batch/checkpoint commit is logically atomic and checkpoint gates the next fetch", async () => {
    const ns = namespace();
    const box = makeOutbox(makeStore());
    assert.deepEqual(await box.canFetchNext({ namespace: ns }), { ok: false, state: "blocked", code: "OUTBOX_CHECKPOINT_REQUIRED" });
    await box.enqueueBatch({ namespace: ns, idempotencyKey: "gated", batch: batch("gated", ns), checkpoint: checkpoint(ns, 3) });
    const gate = await box.canFetchNext({ namespace: ns });
    assert.equal(gate.ok, true);
    assert.equal(gate.checkpoint_hash, (await box.getCheckpoint({ namespace: ns })).checkpoint_hash);
    const resumed = await box.resumePending({ namespace: ns });
    assert.equal(resumed.pending.length, 1);
    assert.equal(resumed.pending[0].payload.item_count, 1);
});

test("pending resume is deterministic across insertion order and restart", async () => {
    const ns = namespace();
    const store = makeStore();
    const box = makeOutbox(store);
    for (const sequence of [2, 0, 1]) await box.enqueueBatch({ namespace: ns, idempotencyKey: `sequence-${sequence}`, batchSequence: sequence, batch: batch(`sequence-${sequence}`, ns) });
    const first = await box.listPending({ namespace: ns, includeSuperseded: true });
    const second = (await makeOutbox(store).resumePending({ namespace: ns, includeSuperseded: true })).pending;
    assert.deepEqual(first.map((entry) => entry.batch_sequence), [0, 1, 2]);
    assert.deepEqual(second.map((entry) => entry.idempotency_hash), first.map((entry) => entry.idempotency_hash));
});

test("IDB enforces 10,000 records, byte limits, pending protection, and oldest acknowledged eviction", async () => {
    const initial = Array.from({ length: 10000 }, (_, index) => ({ key: `generated-${index}`, value: { sequence: index }, bytes: 20, state: "pending", createdAt: index }));
    const full = indexedDb.createMemoryBoundedStore({ maxBytes: 1000000, maxRecords: 10000, backend: indexedDb.createMemoryBackend(initial) });
    assert.equal((await full.status()).count, 10000);
    assert.equal((await full.put("generated-overflow", { sequence: 10001 })).code, "IDB_PENDING_LIMIT");
    assert.equal((await full.status()).pending, 10000);
    const small = indexedDb.createMemoryBoundedStore({ maxBytes: 80, maxRecords: 3 });
    await small.put("ack-old", { data: "a" }, { state: "acknowledged", createdAt: 1 });
    await small.put("pending", { data: "b" }, { createdAt: 2 });
    await small.put("ack-new", { data: "c" }, { state: "acknowledged", createdAt: 3 });
    assert.equal((await small.put("incoming", { data: "d" })).ok, true);
    assert.equal(await small.get("ack-old"), undefined);
    assert.deepEqual(await small.get("pending"), { data: "b" });
    const byteLimited = indexedDb.createMemoryBoundedStore({ maxBytes: 40, maxRecords: 4 });
    await byteLimited.put("pending-byte", { data: "x".repeat(20) });
    const tooLarge = await byteLimited.put("pending-byte-2", { data: "y".repeat(40) });
    assert.equal(tooLarge.code, "IDB_PENDING_LIMIT");
    assert.deepEqual(await byteLimited.get("pending-byte"), { data: "x".repeat(20) });
});

test("quota pauses writes and recovers through acknowledged eviction; bypass and replacement accounting remain compatible", async () => {
    const backend = indexedDb.createMemoryBackend([{ key: "ack", value: { generated: 1 }, bytes: 16, state: "acknowledged", createdAt: 1 }], { failQuotaWrites: 1 });
    const store = indexedDb.createIndexedDbStore({ backend, maxBytes: 1000, maxRecords: 4 });
    const failed = await store.put("new", { generated: 2 });
    assert.equal(failed.code, "IDB_QUOTA_EXCEEDED");
    assert.equal(failed.paused, true);
    assert.equal((await store.put("blocked", { generated: 3 })).code, "IDB_QUOTA_EXCEEDED");
    assert.equal((await store.putBypassPause("recovery", { generated: 4 }, { state: "acknowledged" })).ok, true);
    assert.equal((await store.status()).paused, true);
    assert.equal((await store.resume()).paused, false);
    const replacementStore = makeStore({ maxBytes: 120, maxRecords: 3 });
    await replacementStore.put("target", { data: "a".repeat(20) }, { state: "acknowledged", createdAt: 1 });
    await replacementStore.put("peer", { data: "b".repeat(20) }, { state: "acknowledged", createdAt: 2 });
    await replacementStore.put("pending", { data: "c" }, { createdAt: 3 });
    assert.equal((await replacementStore.put("target", { data: "d".repeat(30) }, { state: "acknowledged" })).ok, true);
    assert.deepEqual(await replacementStore.get("target"), { data: "d".repeat(30) });
    assert.deepEqual(await replacementStore.get("pending"), { data: "c" });
    assert.ok((await replacementStore.status()).bytes <= 120);
});

test("account/source/run/generation isolation and supersede preserve old pending records", async () => {
    const store = makeStore();
    const box = makeOutbox(store);
    const oldNs = namespace({ account: "account-old", source: "source-one", run: "run-one", generation: 0 });
    const newNs = namespace({ account: "account-old", source: "source-one", run: "run-one", generation: 1 });
    const otherNs = namespace({ account: "account-other", source: "source-two", run: "run-two", generation: 0 });
    await box.enqueueBatch({ namespace: oldNs, idempotencyKey: "old", batch: batch("old", oldNs) });
    await box.enqueueBatch({ namespace: newNs, idempotencyKey: "new", batch: batch("new", newNs) });
    await box.enqueueBatch({ namespace: otherNs, idempotencyKey: "other", batch: batch("other", otherNs) });
    await box.supersedeGeneration({ namespace: newNs });
    assert.equal((await box.listPending({ namespace: newNs })).length, 1);
    assert.equal((await box.listPending({ namespace: oldNs })).length, 0);
    assert.equal((await box.listPending({ namespace: oldNs, includeSuperseded: true })).length, 1);
    assert.equal((await box.listPending({ namespace: otherNs })).length, 1);
    assert.equal((await box.leaseNext({ namespace: newNs })).batch.namespace.scope_hash, outboxApi.namespace(newNs).scope_hash);
});

test("cancel and revoke drain blocks prevent new batches and writeback", async () => {
    for (const revoke of [false, true]) {
        const ns = namespace({ run: `drain-${revoke}` });
        const box = makeOutbox(makeStore());
        await box.enqueueBatch({ namespace: ns, idempotencyKey: "before-cancel", batch: batch("before-cancel", ns) });
        const pendingIntent = await box.enqueueWritebackIntent({ namespace: ns, idempotencyKey: "before-cancel-intent", targetAccount: "target", mutation: { completed: true } });
        const cancelled = await box.cancel({ namespace: ns, revoke });
        assert.equal(cancelled.state, "cancelled");
        assert.equal(cancelled.revoked, revoke);
        assert.equal((await box.leaseNext({ namespace: ns })).state, "empty");
        assert.equal((await box.enqueueBatch({ namespace: ns, idempotencyKey: "after-cancel", batch: batch("after-cancel", ns) })).code, "OUTBOX_DRAIN_CANCELLED");
        assert.equal((await box.enqueueWritebackIntent({ namespace: ns, idempotencyKey: "after-cancel-intent", targetAccount: "target", mutation: { completed: true } })).code, "OUTBOX_DRAIN_CANCELLED");
        assert.equal((await box.transitionWriteback({ intentKey: pendingIntent.intent.intent_key, state: "cancelled" })).ok, true);
    }
});

test("revoke durably and idempotently upgrades a completed cancel across every crash point", async () => {
    const ns = namespace({ run: "cancel-then-revoke" });
    const observedStore = makeStore();
    await makeOutbox(observedStore).cancel({ namespace: ns });
    const observed = [];
    const upgraded = await makeOutbox(observedStore, { hooks: { afterStep: async (step) => observed.push(step) } }).revoke({ namespace: ns });
    assert.equal(upgraded.revoked, true);
    assert.deepEqual(observed, ["cancel_marked_closing", "cancel_journal_prepared", "cancel_journal_committed", "cancel_closed"]);

    for (const crashStep of observed) {
        const store = makeStore();
        const initial = makeOutbox(store);
        await initial.enqueueBatch({ namespace: ns, idempotencyKey: `before-${crashStep}`, batch: batch(`before-${crashStep}`, ns) });
        await initial.cancel({ namespace: ns });
        const crashing = makeOutbox(store, { hooks: { afterStep: async (step) => { if (step === crashStep) throw errorWithCode("OUTBOX_SIMULATED_CRASH"); } } });
        await assert.rejects(crashing.revoke({ namespace: ns }), /OUTBOX_SIMULATED_CRASH/);

        const restarted = makeOutbox(store);
        await restarted.init();
        const meta = (await storedValues(store)).find((value) => value.record_type === "generation_meta" && value.scope_hash === outboxApi.namespace(ns).scope_hash);
        assert.equal(meta.revoked, true, `revoked after ${crashStep}`);
        assert.equal(meta.drain_state, "closed", `closed after ${crashStep}`);
        assert.equal((await restarted.enqueueBatch({ namespace: ns, idempotencyKey: `blocked-${crashStep}`, batch: batch(`blocked-${crashStep}`, ns) })).code, "OUTBOX_DRAIN_CANCELLED");
        assert.equal((await restarted.revoke({ namespace: ns })).revoked, true);
        assert.equal((await storedValues(store)).some((value) => value.record_type === "journal"), false, `journal leaked after ${crashStep}`);
    }
});

test("lease is one-at-a-time, expires, survives restart, and increments attempts", async () => {
    let clock = 1000;
    const now = () => clock;
    const store = makeStore();
    const ns = namespace();
    const first = makeOutbox(store, { now, leaseMs: 100 });
    await first.enqueueBatch({ namespace: ns, idempotencyKey: "lease", batch: batch("lease", ns) });
    const leased = await first.leaseNext({ namespace: ns, requestKey: "request-raw" });
    assert.equal(leased.state, "leased");
    assert.equal(leased.batch.attempt, 1);
    assert.equal((await makeOutbox(store, { now, leaseMs: 100 }).leaseNext({ namespace: ns })).code, "OUTBOX_LEASE_ACTIVE");
    clock = 1101;
    const afterExpiry = await makeOutbox(store, { now, leaseMs: 100 }).leaseNext({ namespace: ns });
    assert.equal(afterExpiry.state, "leased");
    assert.equal(afterExpiry.batch.attempt, 2);
    assert.equal((await makeOutbox(store, { now, leaseMs: 100 }).leaseNext({ namespace: ns })).code, "OUTBOX_LEASE_ACTIVE");
    assert.equal((await first.scheduleRetry({ lease: afterExpiry.lease, delayMs: 20, errorClass: "network" })).state, "scheduled");
    clock = 1130;
    assert.equal((await first.leaseNext({ namespace: ns })).batch.attempt, 3);
});

test("concurrent namespace-filtered leases across two instances still acquire only one global lease", async () => {
    const store = makeStore();
    const nsA = namespace({ run: "global-lease-a" });
    const nsB = namespace({ run: "global-lease-b" });
    const first = makeOutbox(store);
    const second = makeOutbox(store);
    await first.enqueueBatch({ namespace: nsA, idempotencyKey: "global-lease-a", batch: batch("global-lease-a", nsA) });
    await first.enqueueBatch({ namespace: nsB, idempotencyKey: "global-lease-b", batch: batch("global-lease-b", nsB) });

    const results = await Promise.all([
        first.leaseNext({ namespace: nsA, requestKey: "global-request-a" }),
        second.leaseNext({ namespace: nsB, requestKey: "global-request-b" })
    ]);
    const leased = results.filter((result) => result.state === "leased");
    const busy = results.filter((result) => result.code === "OUTBOX_LEASE_ACTIVE");
    assert.equal(leased.length, 1);
    assert.equal(busy.length, 1);
    const winnerIndex = results.indexOf(leased[0]);
    const expectedScope = outboxApi.namespace(winnerIndex === 0 ? nsA : nsB).scope_hash;
    assert.equal(leased[0].batch.namespace.scope_hash, expectedScope);
    assert.equal(busy[0].lease.lease_id, leased[0].lease.lease_id);
    assert.equal((await first.status()).counters.leased_batches, 1);
});

test("receipt matching acknowledges exactly once and mismatches do not mutate the batch", async () => {
    const ns = namespace();
    const matrixStore = makeStore();
    const box = makeOutbox(matrixStore);
    await box.enqueueBatch({ namespace: ns, idempotencyKey: "receipt", batch: batch("receipt", ns) });
    const leased = await box.leaseNext({ namespace: ns });
    const mismatch = await assert.rejects(box.acknowledgeBatch({ lease: leased.lease, receipt: { idempotency_hash: leased.lease.idempotency_hash, payload_hash: H("wrong"), generation_hash: leased.lease.generation_hash } }), /OUTBOX_RECEIPT_MISMATCH/);
    assert.equal(mismatch, undefined);
    const receipt = { idempotency_hash: leased.lease.idempotency_hash, payload_hash: leased.lease.payload_hash, generation_hash: leased.lease.generation_hash, accepted: true };
    const acknowledged = await box.acknowledgeBatch({ lease: leased.lease, receipt });
    const duplicate = await box.acknowledgeBatch({ namespace: ns, idempotency_hash: leased.lease.idempotency_hash, receipt });
    assert.equal(acknowledged.ok, true);
    assert.equal(duplicate.duplicate, true);
    assert.equal((await box.status()).counters.pending_batches, 0);
});

test("every writeback state accepts only its contract transitions and preserves target/revision hashes", async () => {
    const states = outboxApi.WRITEBACK_STATES;
    const allowed = {
        waiting_for_canvas_session: new Set(["queued", "unsupported", "forbidden", "conflict", "retryable_failed", "cancelled"]),
        queued: new Set(["applied", "unsupported", "forbidden", "conflict", "retryable_failed", "cancelled"]),
        retryable_failed: new Set(["queued", "applied", "unsupported", "forbidden", "conflict", "cancelled"]),
        applied: new Set(), unsupported: new Set(), forbidden: new Set(), conflict: new Set(), cancelled: new Set()
    };
    const matrixStore = makeStore();
    const box = makeOutbox(matrixStore);
    for (const from of states) {
        for (const to of states) {
            const ns = namespace({ run: `transition-${from}-${to}` });
            const created = await box.enqueueWritebackIntent({ namespace: ns, idempotencyKey: "matrix", state: from, targetAccount: "target-raw", expectedRevision: "revision-raw", mutation: { completed: true, answer_hash: H("answer") } });
            assert.equal(created.intent.target_account_hash, identity.sha256HexSync("target-account\u0000target-raw"));
            assert.equal(created.intent.expected_revision_hash, identity.sha256HexSync("revision-raw"));
            const result = await box.transitionWriteback({ intentKey: created.intent.intent_key, state: to });
            if (from === to) assert.equal(result.ok, true, `${from} -> ${to}`);
            else if (allowed[from].has(to)) assert.equal(result.ok, true, `${from} -> ${to}`);
            else assert.deepEqual(result, { ok: false, state: "conflict", code: "OUTBOX_WRITEBACK_TRANSITION_INVALID" }, `${from} -> ${to}`);
        }
    }
    const serialized = JSON.stringify(await storedValues(matrixStore));
    assert.doesNotMatch(serialized, /target-raw|revision-raw|generated:answer/);
});

test("summary and telemetry expose safe counters only", async () => {
    const ns = namespace();
    const store = makeStore({ maxBytes: 200 });
    const box = makeOutbox(store);
    await box.enqueueBatch({ namespace: ns, idempotencyKey: "telemetry", batch: batch("telemetry", ns) });
    const status = await box.status();
    assert.equal(status.payload, undefined);
    assert.equal(status.raw, undefined);
    assert.match(status.correlation_hash, /^c-[a-f0-9]{24}$/);
    assert.doesNotMatch(JSON.stringify(status), /Generated title|telemetry|raw-account/);
    const limited = await box.enqueueBatch({ namespace: ns, idempotencyKey: "telemetry-overflow", batch: batch("telemetry-overflow", ns) });
    assert.equal(limited.ok, false);
    assert.doesNotMatch(JSON.stringify(limited), /Generated title|telemetry-overflow|raw-account/);
    assert.equal(limited.summary.payload, undefined);
});
