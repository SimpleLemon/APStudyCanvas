"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const createCanvasSyncNest = require("../../js/platform/canvas-sync-nest.js");

const ACCOUNT = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const SOURCE = `canvas:${ACCOUNT}`;
const VERSION = 1;
const SCOPES = ["full_history_upload", "ongoing_read", "shares_ics_inclusion"];

function makeTransport(responses = []) {
    const calls = [];
    return Object.assign({
        calls,
        async request(request) {
            calls.push(request);
            const response = responses.shift();
            if (response instanceof Error) throw response;
            return response || { ok: true, status: 200, body: {} };
        }
    }, { calls });
}

function identityBody(overrides = {}) {
    return {
        contract_version: 1,
        state: "authenticated",
        user_id: "nest-user-1",
        display_name: "Nest User",
        username: "nestuser",
        avatar_url: "https://cdn.example/avatar.png",
        ...overrides
    };
}

function consentBody(overrides = {}) {
    return {
        version: VERSION,
        granted: true,
        current: true,
        account_key: ACCOUNT,
        source_key: SOURCE,
        scopes: SCOPES.slice(),
        ...overrides
    };
}

function binding(overrides = {}) {
    return { accountKey: ACCOUNT, sourceKey: SOURCE, consentVersion: VERSION, requiredScopes: SCOPES.slice(), ...overrides };
}

test("identity uses one exact GET and never sends Canvas identifiers", async () => {
    const transport = makeTransport([{ ok: true, status: 200, body: identityBody() }]);
    const nest = createCanvasSyncNest({ transport });
    const result = await nest.getIdentity();
    assert.deepEqual(transport.calls, [{ method: "GET", path: "/api/extension/identity" }]);
    assert.deepEqual(result, {
        state: "authenticated",
        userId: "nest-user-1",
        displayName: "Nest User",
        username: "nestuser",
        avatarUrl: "https://cdn.example/avatar.png"
    });
    assert.equal(Object.prototype.hasOwnProperty.call(result, "canvasUserId"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(result, "accountKey"), false);
});

test("identity is minimal, redacts sensitive/Canvas fields, and accepts only safe HTTPS avatars", async () => {
    const transport = makeTransport([{ ok: true, status: 200, body: identityBody({
        email: "private@example.edu",
        settings: { theme: "dark" },
        canvas_user_id: "canvas-user-1",
        access_token: "secret",
        avatar_url: "http://evil.example/avatar.png"
    }) }]);
    const result = await createCanvasSyncNest({ transport }).getIdentity();
    assert.deepEqual(result, {
        state: "authenticated",
        userId: "nest-user-1",
        displayName: "Nest User",
        username: "nestuser",
        avatarUrl: null
    });
    assert.equal(Object.isFrozen(result), true);
});

test("identity maps 401 to signed out and offline to unavailable with bounded retry metadata", async () => {
    const signedOut = createCanvasSyncNest({ transport: makeTransport([{ ok: false, status: 401, body: { email: "private@example.edu" } }]) });
    assert.equal((await signedOut.getIdentity()).state, "signed_out");

    const offline = new Error("offline secret detail");
    offline.code = "NEST_OFFLINE";
    offline.unavailable = true;
    offline.retryAfterMs = 999999999;
    const unavailable = createCanvasSyncNest({ transport: makeTransport([offline]) });
    const result = await unavailable.getIdentity();
    assert.equal(result.state, "unavailable");
    assert.equal(result.retryAfterMs, 300000);
    assert.doesNotMatch(JSON.stringify(result), /offline secret detail|email|token/i);
});

test("consent uses exact source/account/version query and returns a frozen sync preflight proof", async () => {
    const transport = makeTransport([{ ok: true, status: 200, body: consentBody() }]);
    const proof = await createCanvasSyncNest({ transport }).getConsentProof(binding());
    assert.deepEqual(transport.calls, [{ method: "GET", path: `/api/extension/consent?source_key=canvas%3A${ACCOUNT}&account_key=${ACCOUNT}&version=1` }]);
    assert.deepEqual(proof, {
        version: 1,
        current: true,
        granted: true,
        accountKey: ACCOUNT,
        sourceKey: SOURCE,
        source_key: SOURCE,
        scopes: SCOPES,
        state: "current",
        timestamps: {}
    });
    assert.equal(Object.isFrozen(proof), true);
    assert.equal(Object.isFrozen(proof.scopes), true);
    assert.doesNotMatch(JSON.stringify(proof), /email|token|settings|canvas-user/i);
});

test("consent denies stale, revoked, mismatched, and insufficient-scope responses", async (t) => {
    const cases = [
        ["stale version", { version: "consent-v0" }],
        ["revoked", { current: false }],
        ["mismatched account", { account_key: "f".repeat(64) }],
        ["mismatched source", { source_key: `canvas:${"f".repeat(64)}` }],
        ["insufficient scope", { scopes: ["calendar.write"] }]
    ];
    for (const [name, changes] of cases) {
        await t.test(name, async () => {
            const body = consentBody();
            Object.assign(body, changes);
            const result = await createCanvasSyncNest({ transport: makeTransport([{ ok: true, status: 200, body }]) }).getConsentProof(binding());
            assert.equal(result, null);
        });
    }
});

test("consent validates contract/authentication and fails safely without exposing errors", async () => {
    for (const response of [
        { ok: true, status: 200, body: consentBody({ version: 2 }) },
        { ok: true, status: 200, body: consentBody({ granted: false }) },
        { ok: false, status: 401, body: { email: "private@example.edu" } },
        Object.assign(new Error("secret token detail"), { code: "NEST_OFFLINE", unavailable: true })
    ]) {
        const proof = await createCanvasSyncNest({ transport: makeTransport([response]) }).getConsentProof(binding());
        assert.equal(proof, null);
    }
});

test("legacy consent version and scopes are rejected as authorization", async () => {
    assert.equal(await createCanvasSyncNest({ transport: makeTransport([{ ok: true, status: 200, body: consentBody() }]) }).getConsentProof(binding({ consentVersion: "consent-v1" })), null);
    assert.equal(await createCanvasSyncNest({ transport: makeTransport([{ ok: true, status: 200, body: { contract_version: 1, authenticated: true, consent: { granted: true, current: true, scopes: ["history_read", "ongoing_sync"] } } }]) }).getConsentProof(binding()), null);
    assert.equal(await createCanvasSyncNest({ transport: makeTransport() }).getConsentProof(binding({ requiredScopes: ["history_read", "ongoing_sync"] })), null);
});

test("consent accepts matching nested/top-level canonical fields and rejects mismatches", async () => {
    const envelope = {
        contractVersion: 1,
        ok: true,
        consent: { version: 1, current: true, granted: true, source_key: SOURCE, account_key: ACCOUNT, scopes: SCOPES.slice() },
        version: 1,
        current: true,
        granted: true,
        sourceKey: SOURCE,
        source_key: SOURCE,
        accountKey: ACCOUNT,
        account_key: ACCOUNT,
        scopes: SCOPES.slice()
    };
    const proof = await createCanvasSyncNest({ transport: makeTransport([{ ok: true, status: 200, body: envelope }]) }).getConsentProof(binding());
    assert.equal(proof.current, true);
    assert.deepEqual(proof.scopes, SCOPES);
    for (const body of [
        { ...envelope, consent: { ...envelope.consent, current: false } },
        { ...envelope, sourceKey: `canvas:${"f".repeat(64)}` },
        { ...envelope, scopes: ["full_history_upload", "ongoing_read"] },
        { ...envelope, consent: { ...envelope.consent, authorization: "Bearer secret" } }
    ]) {
        const rejected = await createCanvasSyncNest({ transport: makeTransport([{ ok: true, status: 200, body }]) }).getConsentProof(binding());
        assert.equal(rejected, null);
    }
});

test("consent normalizes v1 contract versions across outer, body, and nested aliases", async () => {
    const validResponses = [
        { contractVersion: 1, body: consentBody() },
        { contract_version: 1, body: consentBody({ contractVersion: 1 }) },
        { contractVersion: 1, body: consentBody({ consent: { ...consentBody(), contract_version: 1 } }) },
        { body: consentBody({ contract_version: 1 }) },
        { body: consentBody() }
    ];
    for (const response of validResponses) {
        const proof = await createCanvasSyncNest({ transport: makeTransport([response]) }).getConsentProof(binding());
        assert.equal(proof?.version, 1);
    }

    const rejectedResponses = [
        { contractVersion: 2, body: consentBody() },
        { contractVersion: 1, body: consentBody({ contractVersion: 2 }) },
        { contractVersion: "1", body: consentBody() },
        { contractVersion: 1, contract_version: 2, body: consentBody() },
        { contractVersion: 1, body: consentBody({ contractVersion: 1, contract_version: 2 }) },
        { contractVersion: 1, body: consentBody({ consent: { ...consentBody(), contract_version: 2 } }) },
        { body: consentBody({ version: "1" }) }
    ];
    for (const response of rejectedResponses) {
        const proof = await createCanvasSyncNest({ transport: makeTransport([response]) }).getConsentProof(binding());
        assert.equal(proof, null);
    }
});

test("createClient injects the existing transport and session secret store", () => {
    const transport = makeTransport();
    const sessionSecretStore = { get() {}, set() {}, remove() {} };
    const sourceMetadataStore = { get() {}, set() {} };
    let received;
    const client = { ready: true };
    const nest = createCanvasSyncNest({ transport, sessionSecretStore, sourceMetadataStore, syncClientFactory: (deps) => { received = deps; return client; } });
    assert.equal(nest.createClient(), client);
    assert.deepEqual(received, { transport, sessionSecretStore, sourceMetadataStore });
    assert.throws(() => createCanvasSyncNest({ transport, sessionSecretStore }).createClient(), /NEST_SYNC_CLIENT_FACTORY_REQUIRED/);
});

test("literal sync client factory shape is supported and factory errors are sanitized", () => {
    const transport = makeTransport();
    const sessionSecretStore = { get() {}, set() {}, remove() {} };
    const sourceMetadataStore = { get() {}, set() {} };
    let received;
    const nest = createCanvasSyncNest({ transport, sessionSecretStore, sourceMetadataStore, syncClientFactory: { createSyncClient: (deps) => { received = deps; return "client"; } } });
    assert.equal(nest.createClient(), "client");
    assert.deepEqual(received, { transport, sessionSecretStore, sourceMetadataStore });
    const failing = createCanvasSyncNest({ transport, sessionSecretStore, syncClientFactory: () => { throw Object.assign(new Error("email=private@example.edu token=secret"), { code: "RAW_SECRET_ERROR" }); } });
    assert.throws(() => failing.createClient(), (error) => error.code === "NEST_SYNC_CLIENT_FACTORY_FAILED" && !/private|secret|RAW_SECRET/.test(error.message));
});

test("sync identity accepts Nest's actual v1 profile envelope", async () => {
    const transport = makeTransport([{ ok: true, status: 200, body: { contractVersion: 1, state: "authenticated", profile: { id: "nest-user-1", displayName: "Student", username: "student", avatarUrl: null } } }]);
    const result = await createCanvasSyncNest({ transport }).getIdentity();
    assert.deepEqual(result, { state: "authenticated", userId: "nest-user-1", displayName: "Student", username: "student", avatarUrl: null });
});
