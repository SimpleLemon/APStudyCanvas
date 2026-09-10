"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createNestTransport, responseFromFetch } = require("../../js/platform/transport.js");
const { create } = require("../../js/platform/connection-coordinator.js");
const { normalizeIdentityResponse, resolveProfile } = require("../../js/popup-controller.js");
const identity = { state: "authenticated", profile: { id: "nest-1", displayName: "Nest Student", avatarUrl: "https://nest.apstudy.org/avatar.png" } };
function response(status, body, extra = {}) {
    return { ok: status < 400, status, headers: { forEach(fn) { for (const [key, value] of Object.entries({ "content-type": "application/json", ...extra })) fn(value, key); } }, text: async () => JSON.stringify(body) };
}
const mutation = { method: "PUT", path: "/api/extension/consent", body: { action: "grant" } };

test("real Nest CSRF error reaches bounded same-origin recovery without exposing its body", async () => {
    const calls = [];
    const csrfBody = { ok: false, code: "csrf_required", message: "CSRF validation failed.", contractVersion: 1 };
    const nest = createNestTransport({
        fetchImpl: async (url) => {
            calls.push(url);
            return url.endsWith("/csrf") ? response(200, {}, { "x-csrftoken": "private-bootstrap" })
                : response(400, csrfBody, { "x-apstudy-csrf-error": "1" });
        },
        findExactNestTab: async () => ({ id: 7, url: "https://nest.apstudy.org/dashboard" }),
        sendToTab: async (id, message) => {
            assert.equal(id, 7);
            assert.equal(message.mutation.idempotency_key, "save-1");
            assert.equal(message.request.headers["x-csrftoken"], undefined);
            return { kind: "APSTUDYCANVAS_NEST_BRIDGE_RESPONSE", version: 1, request_id: message.request_id, ok: true, status: 200, headers: {}, body: { ok: true, granted: true } };
        }
    });
    assert.equal((await nest.mutate(mutation, { requestId: "save-1", idempotent: true })).body.granted, true);
    assert.equal(calls.length, 4, "two bounded direct attempts, then one same-origin bridge");
    const safe = await responseFromFetch(response(400, { ...csrfBody, token: "must-not-escape" }, { "x-apstudy-csrf-error": "1" }));
    assert.deepEqual(safe.body, { ok: false, code: "NEST_CSRF_REQUIRED" });
    await assert.rejects(responseFromFetch(response(400, { token: "must-not-escape" })), /SECRET/);
});

test("sign-out persists across restart, blocks all transport paths, and requires explicit verified sign-in", async () => {
    let disconnected = false;
    let calls = 0;
    let next = response(200, identity);
    const options = { readDisconnected: async () => disconnected, writeDisconnected: async value => { disconnected = value; }, fetchImpl: async () => { calls++; return next; } };
    const first = createNestTransport(options);
    await first.signOut();
    const restarted = createNestTransport(options);
    assert.equal((await restarted.identityGet()).code, "NEST_EXTENSION_SIGNED_OUT");
    await assert.rejects(restarted.mutate(mutation), /SIGNED_OUT/);
    await assert.rejects(restarted.listTodos(), /SIGNED_OUT/);
    assert.equal(calls, 0);
    next = response(401, { authenticated: false });
    await restarted.signIn();
    assert.equal(disconnected, true);
    next = response(200, identity);
    assert.equal((await restarted.signIn()).body.profile.id, "nest-1");
    assert.equal(disconnected, false);
    assert.equal((await restarted.identityGet()).body.profile.id, "nest-1");
});

test("sign-out discards pending identity and CSRF responses even after reconnection", async () => {
    let resolveRead;
    let started;
    const waiting = new Promise(resolve => { started = resolve; });
    let calls = 0;
    const nest = createNestTransport({ fetchImpl: async () => {
        calls++;
        if (calls === 1) { started(); return new Promise(resolve => { resolveRead = resolve; }); }
        return response(200, identity);
    } });
    const pending = nest.mutate(mutation, { idempotent: true });
    const rejection = assert.rejects(pending, /SIGNED_OUT/);
    await waiting;
    await nest.signOut();
    await nest.signIn();
    resolveRead(response(200, {}, { "x-csrftoken": "late-private-bootstrap" }));
    await rejection;
    assert.equal(calls, 2, "the stale mutation never sends its PUT");
});

test("a sign-out during explicit sign-in cannot be undone by its late response", async () => {
    let finish;
    let started;
    const waiting = new Promise(resolve => { started = resolve; });
    let stored = true;
    const nest = createNestTransport({ readDisconnected: async () => stored, writeDisconnected: async value => { stored = value; }, fetchImpl: async () => { started(); return new Promise(resolve => { finish = resolve; }); } });
    const pending = nest.signIn();
    const rejected = assert.rejects(pending, /SIGNED_OUT/);
    await waiting;
    await nest.signOut();
    finish(response(200, identity));
    await rejected;
    assert.equal(stored, true);
});

test("refresh keeps Nest display stable but authorization and sign-out remain independent", async () => {
    let finish;
    let first = true;
    const connection = create({ readIdentity: async () => first ? (first = false, { ok: true, body: identity }) : new Promise(resolve => { finish = resolve; }), normalizeIdentity: normalizeIdentityResponse });
    await connection.refresh();
    const refresh = connection.refresh();
    assert.equal(connection.refresh(), refresh);
    assert.equal(connection.getSnapshot().identity.profile.name, "Nest Student");
    await Promise.resolve();
    finish({ ok: false, status: 503 });
    await refresh;
    assert.equal(connection.getSnapshot().identity.state, "unavailable");
    assert.equal(connection.getSnapshot().displayProfile.name, "Nest Student");
    connection.signOut();
    assert.equal(connection.getSnapshot().displayProfile, null);
    connection.dispose();
});

test("authenticated and unknown profiles never borrow Canvas photos", () => {
    const canvas = { name: "Canvas Student", avatarUrl: "https://canvas.emory.edu/avatar.png" };
    assert.equal(resolveProfile({ name: "Nest Student" }, canvas).avatarUrl, null);
    assert.equal(resolveProfile({}, canvas).source, "nest");
    assert.equal(resolveProfile(null, canvas, "", "checking").avatarUrl, null);
    assert.equal(resolveProfile(null, canvas, "", "unavailable").source, "fallback");
    assert.equal(resolveProfile(null, canvas, "", "signed_out").source, "canvas");
});
