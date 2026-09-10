"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const transport = require("../../js/platform/transport.js");

function response(status, body = {}, extra = {}) {
    return { ok: status >= 200 && status < 300, status,
        headers: { forEach(fn) { Object.entries({ "content-type": "application/json", ...extra }).forEach(([key, value]) => fn(value, key)); } },
        text: async () => JSON.stringify(body) };
}

test("signed-out direct identity stays signed out when there is no Nest tab", async () => {
    const client = transport.createNestTransport({ fetchImpl: async () => response(401, { state: "signed_out", contractVersion: 1 }) });
    const result = await client.identityGet();
    assert.equal(result.status, 401);
    assert.equal(result.body.state, "signed_out");
});

test("live calendar capability flags survive both transport sanitizers", async () => {
    const capabilities = { calendar_integration: true, calendar_read: true, calendar_upload: true, calendar_two_way_writeback: false, calendar_mirroring: false };
    const result = await transport.responseFromFetch(response(200, { contractVersion: 1, capabilities }));
    assert.deepEqual(result.body.capabilities, capabilities);
    const bridged = transport.validateBridgeResponse({ kind: "APSTUDYCANVAS_NEST_BRIDGE_RESPONSE", version: 1, request_id: "r1", ...result }, "r1");
    assert.deepEqual(bridged.body.capabilities, capabilities);
});

test("safe consent revocation signals survive direct and bridge sanitizers", async () => {
    const consent = { version: 1, current: true, granted: true, revoked: true, state: "revoked", scopes: [] };
    const direct = await transport.responseFromFetch(response(200, { contractVersion: 1, ok: true, consent }));
    assert.equal(direct.body.consent.revoked, true);
    assert.equal(direct.body.consent.state, "revoked");
    const bridged = transport.validateBridgeResponse({ kind: "APSTUDYCANVAS_NEST_BRIDGE_RESPONSE", version: 1, request_id: "consent-revoked", ...direct }, "consent-revoked");
    assert.equal(bridged.body.consent.revoked, true);
    assert.equal(bridged.body.consent.state, "revoked");
});

test("timeouts cover response body reads and tab messages", async () => {
    const bodyClient = transport.createNestTransport({ timeoutMs: 5, fetchImpl: async () => ({ ...response(200), text: () => new Promise(() => {}) }) });
    await assert.rejects(bodyClient.request({ path: "/api/extension/identity" }, { allowTabFallback: false }), /NEST_REQUEST_TIMEOUT/);
    const tabClient = transport.createNestTransport({ timeoutMs: 5, fetchImpl: async () => { throw new Error("offline"); }, findExactNestTab: async () => ({ id: 1, url: "https://nest.apstudy.org/" }), sendToTab: () => new Promise(() => {}) });
    await assert.rejects(tabClient.request({ path: "/api/extension/identity" }), /NEST_REQUEST_TIMEOUT/);
});

test("aborting a direct request does not start a tab fallback", async () => {
    const abort = new AbortController();
    let lookups = 0;
    const client = transport.createNestTransport({ fetchImpl: () => new Promise(() => {}), findExactNestTab: async () => { lookups++; return null; } });
    const pending = client.request({ path: "/api/extension/identity" }, { signal: abort.signal });
    abort.abort();
    await assert.rejects(pending, /NEST_REQUEST_ABORTED/);
    assert.equal(lookups, 0);
});

test("Flask CSRF rejection refreshes once without retrying unrelated bad requests", async () => {
    let csrf = 0;
    let writes = 0;
    const client = transport.createNestTransport({ fetchImpl: async (url) => {
        if (url.endsWith("/csrf")) return response(200, { contractVersion: 1, ok: true }, { "x-csrftoken": `safe-${++csrf}` });
        writes++;
        return writes === 1 ? response(400, { ok: false }, { "x-apstudy-csrf-error": "1" }) : response(200, { ok: true });
    } });
    assert.equal((await client.mutate({ method: "PUT", path: "/api/extension/consent", body: {} }, { idempotent: true })).ok, true);
    assert.equal(csrf, 2);
    assert.equal(writes, 2);
    assert.equal(transport.isCsrfFailure({ status: 400 }), false);
});

test("CSRF preflight auth failure can move the entire mutation to the signed-in tab", async () => {
    let sent;
    const client = transport.createNestTransport({ fetchImpl: async () => response(401, { state: "signed_out" }), findExactNestTab: async () => ({ id: 1, url: "https://nest.apstudy.org/extension/connect" }), sendToTab: async (_, message) => {
        sent = message;
        return { kind: "APSTUDYCANVAS_NEST_BRIDGE_RESPONSE", version: 1, request_id: message.request_id, ok: true, status: 200, body: { ok: true } };
    } });
    assert.equal((await client.mutate({ method: "PUT", path: "/api/extension/consent", body: {} }, { idempotent: true })).transport, "tab");
    assert.equal(sent.request.headers["x-csrftoken"], undefined);
});

test("consent grant fixture matches Nest CSRF and PUT contracts end to end", async () => {
    const accountKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const sourceKey = `canvas:${accountKey}`;
    const payload = {
        version: 1,
        source_key: sourceKey,
        account_key: accountKey,
        action: "grant",
        scopes: ["full_history_upload", "ongoing_read", "shares_ics_inclusion"]
    };
    const calls = [];
    const client = transport.createNestTransport({ fetchImpl: async (url, options) => {
        calls.push({ url, options });
        if (url.endsWith("/api/extension/csrf")) {
            return response(200, { contractVersion: 1, ok: true }, { "x-csrftoken": "fixture-csrf" });
        }
        return response(200, {
            contractVersion: 1,
            ok: true,
            consent: {
                version: 1, sourceKey, source_key: sourceKey, accountKey: accountKey, account_key: accountKey,
                current: true, granted: true, state: "active", scopes: payload.scopes
            },
            version: 1, current: true, granted: true, scopes: payload.scopes, sourceKey
        });
    } });

    const result = await client.mutate({ method: "PUT", path: "/api/extension/consent", body: payload, headers: { Accept: "application/json" } }, {
        requestId: "consent-save-fixture",
        idempotent: true,
        idempotencyKey: "consent-save-fixture"
    });

    assert.equal(calls.length, 2);
    assert.equal(calls[0].options.credentials, "include");
    assert.equal(calls[0].options.cache, "no-store");
    assert.equal(calls[1].options.method, "PUT");
    assert.equal(calls[1].options.credentials, "include");
    assert.equal(calls[1].options.cache, "no-store");
    assert.equal(calls[1].options.headers["x-csrftoken"], "fixture-csrf");
    assert.equal(calls[1].options.headers["idempotency-key"], "consent-save-fixture");
    assert.deepEqual(JSON.parse(calls[1].options.body), payload);
    assert.equal(result.ok, true);
    assert.equal(result.body.consent.state, "active");
    assert.deepEqual(result.body.consent.scopes, payload.scopes);
});

test("private sync leases survive only explicitly marked internal sync bridge requests", async () => {
    let sent;
    const client = transport.createNestTransport({ fetchImpl: async () => { throw new Error("offline"); }, findExactNestTab: async () => ({ id: 1, url: "https://nest.apstudy.org/" }), sendToTab: async (_, message) => {
        sent = message;
        return { kind: "APSTUDYCANVAS_NEST_BRIDGE_RESPONSE", version: 1, request_id: message.request_id, ok: true, status: 200, body: { run: { id: "run-1", lease_token: "private-lease" } } };
    } });
    const result = await client.mutate({ method: "PUT", path: "/api/extension/calendar/sources/src1:account/sync/run-1/renew", body: { lease_token: "private-lease" } }, { internalLease: true, idempotent: true });
    assert.equal(sent.internal_sync, true);
    assert.equal(result.body.run.lease_token, "private-lease");
    assert.equal(transport.isInternalSyncPath("/api/extension/consent"), false);
    assert.throws(() => transport.validateBridgeResponse({ kind: "APSTUDYCANVAS_NEST_BRIDGE_RESPONSE", version: 1, request_id: "r", body: { lease_token: "private-lease" } }, "r"), /SECRET_REJECTED/);
});

test("installed Nest bridge handles header-only CSRF and private sync replies in its isolated world", async () => {
    const vm = require("node:vm");
    const fs = require("node:fs");
    const path = require("node:path");
    let listener;
    let mutationOptions;
    const world = {
        URL, URLSearchParams, TextEncoder, AbortController, setTimeout, clearTimeout,
        location: { origin: "https://nest.apstudy.org" },
        chrome: { runtime: { getURL: () => "chrome-extension://extension-id/", onMessage: { addListener(fn) { listener = fn; } } } },
        fetch: async (url, options) => {
            if (url.endsWith("/csrf")) return response(200, { ok: true }, { "x-csrftoken": "safe-csrf" });
            mutationOptions = options;
            return response(200, { ok: true, run: { id: "run-1", lease_token: "safe-lease" } });
        }
    };
    const context = vm.createContext(world);
    for (const file of ["contract.js", "security.js", "transport.js", "nest-bridge.js"]) vm.runInContext(fs.readFileSync(path.join(__dirname, "../../js/platform", file), "utf8"), context);
    const message = vm.runInContext(`({ kind: "APSTUDYCANVAS_NEST_BRIDGE_REQUEST", version: 1, request_id: "sync-1", internal_sync: true, request: { method: "PUT", path: "/api/extension/calendar/sources/src1:account/sync/run-1/renew", body: { lease_token: "safe-lease" } }, mutation: { idempotent: true, idempotency_key: "sync-1" } })`, context);
    const result = await new Promise((resolve) => listener(message, { id: "extension-id" }, resolve));
    assert.equal(result.ok, true);
    assert.equal(result.body.run.lease_token, "safe-lease");
    assert.equal(result.headers["x-csrftoken"], undefined);
    assert.equal(mutationOptions.headers["x-csrftoken"], "safe-csrf");
    assert.equal(mutationOptions.cache, "no-store");
});

test("actual Nest event dates and safe edit identities survive range normalization", () => {
    const result = transport.sanitizeCalendarRangeResponse({ contractVersion: 1, ok: true, events: [
        { id: "event-1", event_ref: "user:event-1", source_type: "user", editable: true, calendar_id: "personal", title: "Meeting", start: "2026-09-08T14:00:00Z", end: "2026-09-08T15:00:00Z", is_all_day: false, reminder_minutes: 15 },
        { event_ref: "canvas:assignment-1", source_type: "canvas", editable: true, title: "Deadline", start: "2026-09-08", end: "2026-09-09", is_all_day: true },
        { title: "Invalid date", start: "2026-02-30", end: "2026-03-03", is_all_day: true }
    ] });
    assert.equal(result.events.length, 2);
    assert.equal(result.events[0].start, "2026-09-08T14:00:00.000Z");
    assert.equal(result.events[0].event_ref, "user:event-1");
    assert.equal(result.events[0].editable, true);
    assert.equal(result.events[0].reminder_minutes, 15);
    assert.equal(result.events[1].start, "2026-09-08");
    assert.equal(result.events[1].editable, false);
    assert.equal(result.events[1].is_all_day, true);
});

test("persistent HTTPS CSRF rejection moves an idempotent save to Nest with the same key", async () => {
    let writes = 0;
    let tokens = 0;
    let sent;
    let lookup;
    const client = transport.createNestTransport({
        fetchImpl: async (url) => {
            if (url.endsWith('/csrf')) return response(200, {}, { 'x-csrftoken': `token-${++tokens}` });
            writes++;
            return response(400, { ok: false }, { 'x-apstudy-csrf-error': '1' });
        },
        findExactNestTab: async (options) => { lookup = options; return { id: 8, url: 'https://nest.apstudy.org/extension/connect' }; },
        sendToTab: async (_, message) => {
            sent = message;
            return { kind: 'APSTUDYCANVAS_NEST_BRIDGE_RESPONSE', version: 1, request_id: message.request_id, ok: true, status: 200, body: { ok: true } };
        }
    });
    const result = await client.mutate({ method: 'PUT', path: '/api/extension/consent', body: { action: 'grant' } }, { idempotent: true, requestId: 'save-1', idempotencyKey: 'save-1' });
    assert.equal(result.transport, 'tab');
    assert.equal(result.ok, true);
    assert.equal(writes, 2);
    assert.equal(tokens, 2);
    assert.equal(lookup.createIfMissing, true);
    assert.equal(sent.mutation.idempotency_key, 'save-1');
    assert.equal(sent.request.headers['x-csrftoken'], undefined);
});

test("read-only fallback never requests a new Nest tab", async () => {
    let lookup;
    const client = transport.createNestTransport({
        fetchImpl: async () => response(503),
        findExactNestTab: async (options) => { lookup = options; return null; }
    });
    await assert.rejects(client.request({ path: '/api/extension/consent' }), /NEST_UNAVAILABLE/);
    assert.equal(lookup.createIfMissing, false);
});

test('legacy JSON CSRF bootstrap stays private and permits consent mutations', async () => {
    const token = 'legacy-fixture-csrf';
    const privateResponse = await transport.responseFromFetch(response(200, { ok: true, contractVersion: 1, csrfToken: token }), { allowCsrfHeader: true });
    assert.equal(privateResponse.headers['x-csrftoken'], token);
    assert.equal(JSON.stringify(privateResponse.body).includes(token), false);
    await assert.rejects(transport.responseFromFetch(response(200, { csrfToken: token })), /NEST_RESPONSE_SECRET_REJECTED/);
    let writes = 0;
    const client = transport.createNestTransport({ fetchImpl: async (url, options) => {
        if (url.endsWith('/csrf')) return response(200, { ok: true, contractVersion: 1, csrfToken: token });
        writes++;
        assert.equal(options.headers['x-csrftoken'], token);
        return response(200, { ok: true });
    }});
    assert.equal((await client.mutate({ method: 'PUT', path: '/api/extension/consent', body: { action: 'grant' } }, { idempotent: true })).ok, true);
    assert.equal(writes, 1);
});

test('legacy CSRF compatibility rejects malformed, conflicting, and unrelated secrets', async () => {
    for (const token of ['', 'x'.repeat(513), 'bad\r\ntoken', 12, null]) {
        await assert.rejects(transport.responseFromFetch(response(200, { csrfToken: token }), { allowCsrfHeader: true }), /NEST_CSRF_UNAVAILABLE/);
    }
    await assert.rejects(transport.responseFromFetch(response(200, { csrfToken: 'one' }, { 'x-csrftoken': 'two' }), { allowCsrfHeader: true }), /NEST_CSRF_UNAVAILABLE/);
    await assert.rejects(transport.responseFromFetch(response(200, { csrfToken: 'one', access_token: 'secret' }), { allowCsrfHeader: true }), /NEST_RESPONSE_SECRET_REJECTED/);
});
