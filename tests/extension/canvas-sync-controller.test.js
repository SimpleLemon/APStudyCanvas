"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createCanvasSyncController } = require("../../js/platform/canvas-sync-controller.js");

const BINDING = Object.freeze({
    contractVersion: 1,
    accountKey: "account-hash",
    origin: "https://canvas.example.edu",
    canvasUserId: "canvas-user-1",
    sourceId: "source-1",
    label: "Canvas",
    consentVersion: "consent-v1",
    scope: { courses: [42], capabilities: ["read"] },
    descriptors: [{ id: "assignments", version: 1 }],
    requestId: "request-1"
});

function identity(overrides = {}) {
    return { ok: true, authenticated: true, accountKey: "account-hash", ...overrides };
}

function session(overrides = {}) {
    return { accountKey: "account-hash", origin: BINDING.origin, canvasUserId: BINDING.canvasUserId, ...overrides };
}

function proof(overrides = {}) {
    return {
        granted: true,
        current: true,
        accountKey: "account-hash",
        consentVersion: "consent-v1",
        scope: BINDING.scope,
        proofToken: "must-not-return",
        ...overrides
    };
}

function make(overrides = {}) {
    const calls = [];
    const engine = {
        async start(input) { calls.push(["engine.start", input]); return input.session === null ? { state: "waiting" } : { state: "running", counts: { sent: 2 }, proof: "private", providerId: "private" }; },
        async resume(input) { calls.push(["engine.resume", input]); return { state: "running", counts: { resumed: 1 } }; },
        async getStatus(input) { calls.push(["engine.getStatus", input]); return { state: "partial", counts: { sent: 1 }, url: "https://private.example" }; },
        async cancel(input) { calls.push(["engine.cancel", input]); return { state: "cancelled", errorCode: null }; }
    };
    const controller = createCanvasSyncController({
        getFeatureFlags: () => ({ upload: true }),
        getNestIdentity: async (...args) => { calls.push(["identity", ...args]); return identity(); },
        getConsentProof: async (value) => { calls.push(["consent", value]); return proof(); },
        resolveCanvasSession: async (value) => { calls.push(["session", value]); return session(); },
        engine,
        idFactory: (label) => { calls.push(["id", label]); return "corr-1"; },
        ...overrides
    });
    return { controller, calls };
}

test("disabled upload makes zero dependency calls and returns safe feature_disabled", async () => {
    const calls = [];
    const controller = createCanvasSyncController({
        getFeatureFlags: () => ({ upload: false }),
        getNestIdentity: () => { calls.push("identity"); },
        resolveCanvasSession: () => { calls.push("session"); },
        getConsentProof: () => { calls.push("consent"); },
        engine: { start: () => { calls.push("engine"); } },
        idFactory: () => { calls.push("id"); }
    });
    assert.deepEqual(await controller.start({ tabId: 1 }), { state: "idle", errorCode: "feature_disabled" });
    assert.deepEqual(await controller.resume(BINDING), { state: "idle", errorCode: "feature_disabled" });
    assert.deepEqual(await controller.status(BINDING), { state: "idle", errorCode: "feature_disabled" });
    assert.deepEqual(await controller.cancel(BINDING), { state: "idle", errorCode: "feature_disabled" });
    assert.deepEqual(calls, []);
});

test("start validates the caller contract, orders identity before session and consent, and uses exact happy call shapes", async () => {
    const fake = make();
    const result = await fake.controller.start(BINDING);
    assert.deepEqual(result, { state: "running", counts: { sent: 2 }, correlation: "corr-1" });
    assert.deepEqual(fake.calls.map(([name]) => name), ["identity", "id", "session", "consent", "engine.start"]);
    assert.deepEqual(fake.calls[0], ["identity"]);
    assert.deepEqual(fake.calls[2][1], BINDING);
    assert.deepEqual(fake.calls[3][1], BINDING);
    assert.deepEqual(fake.calls[4][1], { enabled: true, binding: BINDING, proof: proof() });
    await assert.deepEqual(await fake.controller.start({ ...BINDING, tabId: 12 }), { state: "failed", errorCode: "REQUEST_CONTEXT_FORBIDDEN" });
    await assert.deepEqual(await fake.controller.start({ ...BINDING, extra: true }), { state: "failed", errorCode: "REQUEST_FIELD_UNKNOWN" });
});

test("signed out, missing sessions, mismatches, and missing consent fail safely without crossing gates", async () => {
    const signedOut = make({ getNestIdentity: async () => { signedOut.calls.push(["identity"]); return identity({ authenticated: false, state: "signed_out" }); } });
    assert.deepEqual(await signedOut.controller.start(BINDING), { state: "signed_out", errorCode: "SYNC_NEST_IDENTITY_REQUIRED", correlation: BINDING.requestId });
    assert.deepEqual(signedOut.calls.map(([name]) => name), ["identity"]);

    const missing = make({ resolveCanvasSession: async (value) => { missing.calls.push(["session", value]); return null; } });
    const missingResult = await missing.controller.start(BINDING);
    assert.deepEqual(missingResult, { state: "waiting", correlation: "corr-1" });
    assert.deepEqual(missing.calls.map(([name]) => name), ["identity", "id", "session", "engine.start"]);
    assert.equal(missing.calls.some(([name]) => name === "consent"), false);
    assert.equal(missing.calls[3][1].session, null);

    const mismatch = make({ resolveCanvasSession: async () => session({ accountKey: "other-account" }) });
    assert.deepEqual(await mismatch.controller.start(BINDING), { state: "failed", errorCode: "CANVAS_ACCOUNT_MISMATCH", correlation: "corr-1" });
    assert.equal(mismatch.calls.some(([name]) => name === "consent" || name === "engine.start"), false);

    const noConsent = make({ getConsentProof: async (value) => { noConsent.calls.push(["consent", value]); return proof({ granted: false, current: false }); } });
    assert.deepEqual(await noConsent.controller.start(BINDING), { state: "failed", errorCode: "SYNC_CURRENT_CONSENT_REQUIRED", correlation: "corr-1" });
    assert.equal(noConsent.calls.some(([name]) => name === "engine.start"), false);
});

test("resume repeats the safe sequence and passes its proof only to the engine", async () => {
    const fake = make();
    assert.deepEqual(await fake.controller.resume(BINDING), { state: "running", counts: { resumed: 1 }, correlation: "corr-1" });
    assert.deepEqual(fake.calls.map(([name]) => name), ["identity", "id", "session", "consent", "engine.resume"]);
    assert.deepEqual(fake.calls[4][1], { enabled: true, binding: BINDING, proof: proof() });
});

test("status validates binding and only calls engine.getStatus when enabled", async () => {
    const fake = make();
    assert.deepEqual(await fake.controller.status(BINDING), { state: "partial", counts: { sent: 1 }, correlation: "corr-1" });
    assert.deepEqual(fake.calls.map(([name]) => name), ["id", "engine.getStatus"]);
    const invalid = await fake.controller.status({ ...BINDING, windowId: 7 });
    assert.deepEqual(invalid, { state: "failed", errorCode: "REQUEST_CONTEXT_FORBIDDEN" });
});

test("cancel authenticates the exact binding but does not require a Canvas session when a server lease can exist", async () => {
    const fake = make({ resolveCanvasSession: async () => { throw new Error("must not be called"); } });
    assert.deepEqual(await fake.controller.cancel(BINDING), { state: "cancelled", errorCode: null, correlation: "corr-1" });
    assert.deepEqual(fake.calls.map(([name]) => name), ["identity", "id", "engine.cancel"]);
    assert.deepEqual(fake.calls[2][1], { enabled: true, binding: BINDING });
});

test("redaction keeps only safe state/counts/errorCode/correlation fields", async () => {
    const fake = make({
        engine: {
            async getStatus() { return { state: "running", counts: { sent: 3, nested: { done: 2 } }, errorCode: "SYNC_OK", proof: proof(), tabId: 4, providerId: "private", url: "https://private.example", raw: { secret: "private" } }; }
        }
    });
    const result = await fake.controller.status(BINDING);
    assert.deepEqual(result, { state: "running", counts: { sent: 3, nested: { done: 2 } }, errorCode: "SYNC_OK", correlation: "corr-1" });
    assert.doesNotMatch(JSON.stringify(result), /proof|token|private|provider|https?:\/\//i);
});
