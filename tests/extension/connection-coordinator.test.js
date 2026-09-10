"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { create } = require("../../js/platform/connection-coordinator.js");
const { normalizeIdentityResponse } = require("../../js/popup-controller.js");

const identity = (id) => ({ ok: true, body: { state: "authenticated", profile: { id, displayName: "Same name" } } });
test("generic success and display data are not authentication proof", () => {
    for (const value of [{ ok: true }, { ok: true, profile: { name: "Someone" } }, { body: { profile: { id: "u1" } } }]) {
        assert.equal(normalizeIdentityResponse(value).state, "unavailable");
    }
    assert.equal(normalizeIdentityResponse(identity("u1")).identity, "u1");
    assert.equal(normalizeIdentityResponse({ status: 419 }).state, "expired");
});

test("refresh coalesces reads, clears dependent state and distinguishes accounts sharing a name", async () => {
    let calls = 0;
    let user = "u1";
    const connection = create({ readIdentity: async () => { calls++; return identity(user); }, normalizeIdentity: normalizeIdentityResponse });
    const first = connection.refresh();
    assert.equal(connection.refresh(), first);
    assert.equal(connection.getSnapshot().identity.state, "checking");
    await first;
    connection.update({ consent: { granted: true }, capabilities: { calendar_read: true } });
    assert.equal(connection.getSnapshot().consent.granted, true);
    user = "u2";
    await connection.refresh();
    assert.equal(calls, 2);
    assert.equal(connection.getSnapshot().identity.identity, "u2");
    assert.equal(connection.getSnapshot().consent, null);
    connection.dispose();
});

test("Canvas context invalidation rejects stale identity and supplementary responses", async () => {
    let resolve;
    const connection = create({ readIdentity: () => new Promise((done) => { resolve = done; }), normalizeIdentity: normalizeIdentityResponse });
    const pending = connection.refresh();
    await Promise.resolve();
    const generation = connection.getSnapshot().generation;
    connection.setContext({ accountKey: "new-account", origin: "https://canvas.emory.edu" });
    resolve(identity("old-user"));
    await pending;
    connection.update({ consent: { granted: true } }, generation);
    assert.equal(connection.isCurrent(generation), false);
    assert.equal(connection.getSnapshot().identity.state, "checking");
    assert.equal(connection.getSnapshot().consent, null);
    connection.dispose();
});

test("stalled and failed identity requests settle unavailable and can recover", async () => {
    let stalled = true;
    const connection = create({ readIdentity: () => stalled ? new Promise(() => {}) : identity("u1"), normalizeIdentity: normalizeIdentityResponse, timeoutMs: 5 });
    await connection.refresh();
    assert.equal(connection.getSnapshot().identity.state, "unavailable");
    stalled = false;
    await connection.refresh();
    assert.equal(connection.getSnapshot().identity.state, "authenticated");
    connection.dispose();
});

test("sign-out clears private data and snapshots cannot be mutated by a view", async () => {
    let result = identity("u1");
    const connection = create({ readIdentity: () => result, normalizeIdentity: normalizeIdentityResponse });
    await connection.refresh();
    const snapshot = connection.getSnapshot();
    assert.throws(() => { snapshot.identity.profile.name = "changed"; }, TypeError);
    result = { ok: false, status: 401 };
    await connection.refresh();
    assert.equal(connection.getSnapshot().identity.state, "signed_out");
    assert.equal(connection.getSnapshot().identity.profile, null);
    connection.dispose();
});
