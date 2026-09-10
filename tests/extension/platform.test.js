"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const contract = require("../../js/platform/contract.js");
const security = require("../../js/platform/security.js");
const storage = require("../../js/platform/storage.js");
const indexedDb = require("../../js/platform/idb.js");
const transport = require("../../js/platform/transport.js");
const canvasRegistration = require("../../js/platform/canvas-registration.js");
const router = require("../../js/platform/router.js");

function response(status, body = {}, headers = { "content-type": "application/json" }) {
    const normalizedHeaders = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: {
            forEach(callback) { Object.entries(normalizedHeaders).forEach(([name, value]) => callback(value, name)); },
            get(name) { return normalizedHeaders[String(name).toLowerCase()] || null; }
        },
        async text() { return typeof body === "string" ? body : JSON.stringify(body); }
    };
}

function extensionChrome(extra = {}) {
    return Object.assign({ runtime: { getURL: (path) => `chrome-extension://test-id/${path.replace(/^\//, "")}` } }, extra);
}

test("v1 envelopes validate required shape and reject exact-origin sender spoofs", () => {
    const envelope = contract.createEnvelope("NEST_IDENTITY_GET", {}, "request-1");
    assert.equal(contract.validateEnvelope(envelope).ok, true);
    assert.equal(contract.validateEnvelope({ ...envelope, request_id: "" }).code, "ENVELOPE_REQUEST_ID_INVALID");
    assert.equal(contract.validateEnvelope({ ...envelope, payload: [] }).code, "ENVELOPE_PAYLOAD_OBJECT_REQUIRED");
    assert.equal(contract.validateEnvelope({ ...envelope, type: "NOT_A_FAMILY" }).code, "ENVELOPE_TYPE_UNSUPPORTED");

    const configured = ["https://canvas.example.edu"];
    const verified = ["https://canvas.example.edu"];
    const options = { runtimeApi: extensionChrome().runtime, configuredOrigins: configured, verifiedOrigins: verified };
    assert.equal(contract.classifySender({ url: "chrome-extension://test-id/popup.html" }, options).kind, "extension");
    assert.equal(contract.classifySender({ id: "test-id" }, options).kind, "extension");
    assert.equal(contract.classifySender({ id: "other-id" }, options).code, "SENDER_NOT_ALLOWED");
    assert.equal(contract.classifySender({ id: "other-id", url: "chrome-extension://test-id/popup.html" }, options).code, "SENDER_NOT_ALLOWED");
    assert.equal(contract.classifySender({ url: "https://canvas.example.edu/courses/1" }, options).kind, "canvas");
    for (const spoof of [
        "https://evil.example.edu/courses/1",
        "https://canvas.example.edu.evil.test/courses/1",
        "https://nest.apstudy.org.evil.test/",
        "http://canvas.example.edu/courses/1"
    ]) assert.equal(contract.classifySender({ url: spoof }, options).code, "SENDER_NOT_ALLOWED");
    assert.equal(contract.classifySender({ url: "https://nest.apstudy.org/" }, options).kind, "nest");
});

test("camelCase and separator-insensitive secret classification catches keys and scalar credentials", () => {
    for (const key of ["accessToken", "access_token", "ACCESS-TOKEN", "Authorization", "privateIcsUrl", "rawCsrf", "csrf.token", "appwriteJwt", "setCookie"]) {
        assert.equal(security.isSensitiveKey(key), true, key);
    }
    for (const value of [
        "Bearer abc.def.ghi",
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.signature123",
        "rawCsrf=abcdef1234",
        "authorization: opaque-value",
        "https://calendar.example/private.ics",
        "https://safe.example/avatar.png?accessToken=secret"
    ]) assert.equal(security.hasCredentialLikeScalar(value), true, value);
    assert.equal(security.validateSafeHttpsUrl("https://cdn.example/avatar.png?size=96"), true);
});

test("sync, local, and session storage reject adversarial secret keys and values", async () => {
    const area = storage.createMemoryStorage({ sync: { gradent_cards: true }, local: {}, session: {} });
    const keys = { sync: "platform.preferences", local: "platform.accountMetadata", session: "platform.currentProfile" };
    const adversarial = [
        { accessToken: "opaque" },
        { "AUTHORIZATION": "opaque" },
        { private_Ics_Url: "https://calendar.example/private.ics" },
        { rawCsrfValue: "abcdef" },
        { nested: { appwriteJWT: "opaque" } },
        { note: "Bearer abc.def.ghi" },
        { note: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.signature123" },
        { note: "rawCsrf=abcdef1234" },
        { note: "https://safe.example/avatar.png?authorization=secret" },
        { note: "{\"accessToken\":\"quoted-secret\"}" }
    ];
    for (const storageArea of ["sync", "local", "session"]) {
        for (const value of adversarial) {
            await assert.rejects(area.set(storageArea, { [keys[storageArea]]: value }), /PLATFORM_SECRET_STORAGE_FORBIDDEN/, `${storageArea}: ${JSON.stringify(value)}`);
        }
    }
    await assert.rejects(area.set("sync", { pendingWorkspaceRouteToken: "portable" }), /PLATFORM_STORAGE_KEY_FORBIDDEN/);
    await assert.rejects(area.set("sync", { workspace_target: "portable" }), /PLATFORM_STORAGE_KEY_FORBIDDEN/);
    await area.set("session", { "platform.workspaceContext": { windowId: 7, sourceCanvasTabId: 9 } });
    assert.deepEqual((await area.get("session", "platform.workspaceContext"))["platform.workspaceContext"], { windowId: 7, sourceCanvasTabId: 9 });
    const accountA = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const accountB = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
    const metadataRecord = (accountKey) => ({ source_ref: "src1:shared", source_key: `canvas:${accountKey}`, origin: "https://canvas.example.edu", nest_user_id: "nest-user-1", provider_user_id: "canvas-user", label: "Canvas", active: true, archived: false, routing_eligible: true });
    await assert.rejects(area.set("local", { "platform.sourceMetadata": { version: 1, accounts: { [accountA]: metadataRecord(accountA), [accountB]: metadataRecord(accountB) } } }), /PLATFORM_SOURCE_METADATA_INVALID/);
    const migration = await area.migrateLegacyAliases();
    assert.deepEqual(migration.values, { gradient_cards: true });
});

test("mutation bodies require JSON object payloads and scan parsed keys and values", () => {
    const valid = transport.validateTransportRequest({ method: "POST", path: "/api/extension/consent", body: "{\"granted\":true}" });
    assert.equal(valid.body, "{\"granted\":true}");
    for (const body of [
        "not json",
        "\"scalar\"",
        "[1,2,3]",
        "{\"authorization\":\"Bearer abc\"}",
        "{\"accessToken\":\"opaque\"}",
        { nested: { rawCsrf: "opaque" } },
        { sourceUrl: "https://calendar.example/private.ics" },
        { note: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.signature123" }
    ]) assert.throws(() => transport.validateTransportRequest({ method: "POST", path: "/api/extension/consent", body }), /JSON_|NEST_BODY|NEST_SECRET/);
    const circular = {}; circular.self = circular;
    assert.throws(() => transport.validateTransportRequest({ method: "POST", path: "/api/extension/consent", body: circular }), /JSON_BODY_NOT_SERIALIZABLE/);
    assert.throws(() => transport.validateTransportRequest({ method: "POST", path: "/api/extension/consent", body: { granted: true }, headers: { "Content-Type": "text/plain" } }), /NEST_CONTENT_TYPE_JSON_REQUIRED/);
    assert.throws(() => transport.validateTransportRequest({ method: "POST", path: "/api/extension/consent", body: { data: "x".repeat(transport.MAX_BODY_BYTES) } }), /NEST_BODY_TOO_LARGE/);
});

test("Nest transport rejects arbitrary URL proxying and unsafe request headers", () => {
    assert.throws(() => transport.validateTransportRequest({ method: "GET", url: "https://attacker.example/" }), /NEST_ARBITRARY_URL_FORBIDDEN/);
    assert.throws(() => transport.validateTransportRequest({ method: "GET", path: "/proxy?url=https://attacker.example" }), /NEST_PATH_METHOD_NOT_ALLOWLISTED/);
    assert.throws(() => transport.validateTransportRequest({ method: "GET", path: "/api/extension/identity", headers: { Cookie: "secret" } }), /NEST_HEADER_NOT_ALLOWLISTED/);
    assert.equal(transport.buildNestUrl("/api/extension/identity"), "https://nest.apstudy.org/api/extension/identity");
});

test("extension endpoint responses require safe JSON objects and preserve only validated safe URL fields", async () => {
    const safe = await transport.responseFromFetch(response(200, {
        identity: "account",
        profile: { displayName: "Student", avatarUrl: "https://cdn.example/avatar.png?size=96", sourceUrl: "https://canvas.example.edu/courses/1", ignoredField: "drop-me" },
        unknownRoot: "drop-me"
    }));
    assert.deepEqual(safe.body, {
        identity: "account",
        profile: { displayName: "Student", avatarUrl: "https://cdn.example/avatar.png?size=96", sourceUrl: "https://canvas.example.edu/courses/1" }
    });
    const badResponses = [
        response(200, "<html>login</html>", { "content-type": "text/html" }),
        response(200, "BEGIN:VCALENDAR", { "content-type": "text/calendar" }),
        response(200, "plain text", { "content-type": "text/plain" }),
        response(200, "scalar"),
        response(200, [1, 2, 3]),
        response(200, { profile: { avatarUrl: "https://user:pass@cdn.example/avatar.png" } }),
        response(200, { profile: { avatarUrl: "https://cdn.example/private.ics" } }),
        response(200, { profile: { sourceUrl: "https://canvas.example.edu/?token=secret" } }),
        response(200, { message: "Bearer abc.def.ghi" }),
        response(200, { message: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.signature123" }),
        response(200, { message: "rawCsrf=abcdef1234" }),
        response(200, { appwriteToken: "opaque" })
    ];
    for (const unsafe of badResponses) await assert.rejects(transport.responseFromFetch(unsafe), /NEST_RESPONSE_/);
});

test("consent envelope survives transport with current, nested fields, and no-store", async () => {
    const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "../fixtures/nest/extension_contract_v1.json"), "utf8"));
    let requestOptions;
    const nest = transport.createNestTransport({
        fetchImpl: async (_url, options) => { requestOptions = options; return response(200, fixture.response); }
    });
    const result = await nest.request({ method: "GET", path: "/api/extension/consent?source_key=canvas%3A0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef&account_key=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef&version=1" }, { requestId: "consent-envelope" });
    assert.equal(requestOptions.cache, "no-store");
    assert.equal(result.body.current, true);
    assert.equal(result.body.consent.current, true);
    assert.deepEqual(result.body.consent.scopes, fixture.response.consent.scopes);
    assert.equal(result.body.provider_user_id, undefined);
});

test("identity falls back only to an exact Nest tab and worker revalidates bridged JSON", async () => {
    const sent = [];
    const nest = transport.createNestTransport({
        fetchImpl: async () => { throw new TypeError("offline"); },
        findExactNestTab: async () => ({ id: 42, url: "https://nest.apstudy.org/dashboard" }),
        sendToTab: async (tabId, message) => {
            sent.push({ tabId, message });
            return { kind: "APSTUDYCANVAS_NEST_BRIDGE_RESPONSE", version: 1, request_id: message.request_id, ok: true, status: 200, headers: { "content-type": "application/json" }, body: { identity: "account" } };
        }
    });
    const result = await nest.identityGet({ requestId: "identity-1" });
    assert.equal(result.ok, true);
    assert.equal(sent[0].tabId, 42);
    assert.equal(sent[0].message.request.path, "/api/extension/identity");

    const spoofedTab = transport.createNestTransport({ fetchImpl: async () => { throw new TypeError("offline"); }, findExactNestTab: async () => ({ id: 1, url: "https://nest.apstudy.org.evil.test/" }) });
    assert.equal((await spoofedTab.identityGet({ requestId: "identity-2" })).code, "NEST_TAB_ORIGIN_INVALID");

    const secretBridge = transport.createNestTransport({
        fetchImpl: async () => { throw new TypeError("offline"); },
        findExactNestTab: async () => ({ id: 2, url: "https://nest.apstudy.org/" }),
        sendToTab: async (_tabId, message) => ({ kind: "APSTUDYCANVAS_NEST_BRIDGE_RESPONSE", version: 1, request_id: message.request_id, ok: true, status: 200, body: { accessToken: "opaque" } })
    });
    assert.match((await secretBridge.identityGet({ requestId: "identity-3" })).code, /NEST_RESPONSE_SECRET_REJECTED/);
});

test("direct auth rejection retries only safe GET bootstrap paths through an exact Nest tab", async () => {
    const calls = [];
    const nest = transport.createNestTransport({
        fetchImpl: async (url) => {
            calls.push(["direct", url]);
            return response(401, { state: "signed_out" });
        },
        findExactNestTab: async () => ({ id: 77, url: "https://nest.apstudy.org/dashboard" }),
        sendToTab: async (tabId, message) => {
            calls.push(["tab", tabId, message]);
            return { kind: "APSTUDYCANVAS_NEST_BRIDGE_RESPONSE", version: 1, request_id: message.request_id, ok: true, status: 200, headers: { "content-type": "application/json" }, body: { authenticated: true, state: "authenticated" } };
        }
    });
    const result = await nest.identityGet({ requestId: "identity-auth-fallback" });
    assert.equal(result.ok, true);
    assert.equal(result.transport, "tab");
    assert.equal(calls[0][0], "direct");
    assert.equal(calls[1][0], "tab");
    assert.equal(calls[1][2].request.path, "/api/extension/identity");
    assert.equal(calls[1][2].request.headers["x-csrftoken"], undefined);

    const consent = await nest.request({ method: "GET", path: "/api/extension/consent?source_key=canvas%3A0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef&account_key=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef&version=1", headers: { Accept: "application/json" } }, { requestId: "consent-auth-fallback" });
    assert.equal(consent.transport, "tab");
    const courses = await nest.request({ method: "GET", path: "/api/extension/calendar/courses?limit=50&offset=0", headers: { Accept: "application/json" } }, { requestId: "courses-auth-fallback" });
    assert.equal(courses.transport, "tab");
    assert.equal(calls.filter((call) => call[0] === "tab").length, 3);
});

test("auth fallback rejects foreign tabs and never applies to mutations", async () => {
    const foreign = transport.createNestTransport({
        fetchImpl: async () => response(403, { state: "signed_out" }),
        findExactNestTab: async () => ({ id: 78, url: "https://nest.apstudy.org.evil.test/dashboard" }),
        sendToTab: async () => { throw new Error("must not proxy foreign tab"); }
    });
    assert.equal((await foreign.identityGet({ requestId: "foreign-auth-fallback" })).code, "NEST_TAB_ORIGIN_INVALID");

    let tabCalls = 0;
    const mutation = transport.createNestTransport({
        fetchImpl: async (url) => url.endsWith("/csrf")
            ? response(200, {}, { "content-type": "application/json", "x-csrftoken": "csrf-safe" })
            : response(403, { state: "signed_out" }),
        findExactNestTab: async () => ({ id: 79, url: "https://nest.apstudy.org/dashboard" }),
        sendToTab: async () => { tabCalls += 1; return {}; }
    });
    const result = await mutation.mutate({ method: "POST", path: "/api/extension/events/mutate", body: { eventId: "event-1" } }, { requestId: "non-idempotent-auth", idempotent: false });
    assert.equal(result.status, 403);
    assert.equal(tabCalls, 0);
});

test("rollout defaults enable read-only integration while malformed and destructive flags fail closed", async () => {
    assert.equal(contract.FEATURE_FLAGS.identity, true);
    assert.equal(contract.FEATURE_FLAGS.upload, true);
    assert.equal(contract.FEATURE_FLAGS.projection, true);
    assert.equal(contract.FEATURE_FLAGS.overlay, true);
    assert.equal(contract.FEATURE_FLAGS.canvasOverlay, true);
    assert.equal(contract.FEATURE_FLAGS.browserFullscreen, undefined);
    for (const key of ["mirroring", "mutation", "replacement", "browserReplace"]) assert.equal(contract.FEATURE_FLAGS[key], false);
    assert.deepEqual(contract.FEATURE_FLAGS.calendarReplacementParity, { version: 1, ready: false });

    const legacy = contract.normalizeFeatureFlags({ upload: false, projection: true, overlay: false }, contract.FEATURE_FLAGS);
    assert.equal(legacy.upload, false);
    assert.equal(legacy.projection, true);
    assert.equal(legacy.overlay, false);
    assert.equal(legacy.mirroring, false);
    assert.equal(legacy.mutation, false);
    assert.equal(legacy.replacement, false);

    const malformed = contract.normalizeFeatureFlags({ upload: "true", projection: true }, contract.FEATURE_FLAGS);
    assert.equal(malformed.upload, false);
    assert.equal(malformed.projection, false);
    assert.equal(malformed.identity, false);
    assert.equal(contract.normalizeFeatureFlags({ version: 2, flags: { upload: true, projection: true } }, contract.FEATURE_FLAGS).upload, false);

    const area = storage.createMemoryStorage({ sync: {}, local: { "platform.flags": { upload: true, projection: true, overlay: true, mirroring: true, mutation: true, replacement: true, browserReplace: true } }, session: {} });
    const stored = await area.readFlags(contract.FEATURE_FLAGS);
    assert.equal(stored.upload, true);
    assert.equal(stored.projection, true);
    assert.equal(stored.overlay, true);
    assert.equal(stored.mirroring, true);
    assert.equal(stored.mutation, true);
    assert.equal(stored.replacement, true);
    assert.equal(stored.browserReplace, true);
    await area.set("local", { "platform.flags": { version: 2, flags: { upload: true, projection: true } } });
    const skewed = await area.readFlags(contract.FEATURE_FLAGS);
    assert.equal(skewed.upload, false);
    assert.equal(skewed.projection, false);
    assert.equal(skewed.overlay, false);
    assert.equal(skewed.replacement, false);
});

test("router enforces scoped consent GET/PUT contracts without changing identity", async () => {
    assert.equal(router.CONSENT_VERSION, 1);
    assert.deepEqual(router.CONSENT_SCOPES, ["full_history_upload", "ongoing_read", "shares_ics_inclusion"]);
    const area = storage.createMemoryStorage({ sync: {}, local: {}, session: {} });
    const accountKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const calls = [];
    const transportStub = {
        identityGet: async (options) => { calls.push({ kind: "identity", options }); return { ok: true, identity: "account" }; },
        request: async (request, options) => { calls.push({ kind: "request", request, options }); return { ok: true, body: { state: "authenticated" } }; },
        mutate: async (request, options) => { calls.push({ kind: "mutate", request, options }); return { ok: true, body: { state: "authenticated" } }; }
    };
    const service = router.createRouter({ chromeApi: extensionChrome(), storage: area, transport: transportStub });
    assert.equal(service.constants.CONSENT_VERSION, router.CONSENT_VERSION);
    assert.deepEqual(service.constants.CONSENT_SCOPES, router.CONSENT_SCOPES);
    const popupSender = { url: "chrome-extension://test-id/html/popup.html" };

    const identity = await service.handle(contract.createEnvelope("NEST_IDENTITY_GET", {}, "identity-unchanged"), popupSender);
    assert.deepEqual(identity.payload, { ok: true, identity: "account" });
    assert.equal(calls[0].kind, "identity");

    const getPayload = { source_key: `canvas:${accountKey}`, account_key: accountKey, version: 1 };
    const consentGet = await service.handle(contract.createEnvelope("NEST_CONSENT_GET", getPayload, "consent-get"), popupSender);
    assert.deepEqual(consentGet.payload, { ok: true, body: { state: "authenticated" } });
    assert.deepEqual(calls[1], {
        kind: "request",
        request: {
            method: "GET",
            path: `/api/extension/consent?source_key=canvas%3A${accountKey}&account_key=${accountKey}&version=1`,
            headers: { Accept: "application/json", "X-Request-ID": "consent-get" }
        },
        options: { requestId: "consent-get" }
    });

    const setPayload = {
        source_key: `canvas:${accountKey}`,
        account_key: accountKey,
        action: "grant",
        scopes: ["full_history_upload", "ongoing_read", "shares_ics_inclusion"],
        version: 1
    };
    const consentSet = await service.handle(contract.createEnvelope("NEST_CONSENT_SET", setPayload, "consent-set"), popupSender);
    assert.deepEqual(consentSet.payload, { ok: true, body: { state: "authenticated" } });
    assert.deepEqual(calls[2], {
        kind: "mutate",
        request: { method: "PUT", path: "/api/extension/consent", body: setPayload, headers: { Accept: "application/json" } },
        options: { requestId: "consent-set", idempotent: true }
    });

    const invalid = [
        ["NEST_CONSENT_GET", { ...getPayload, tabId: 4 }],
        ["NEST_CONSENT_GET", { ...getPayload, account_key: "Bearer secret" }],
        ["NEST_CONSENT_GET", { ...getPayload, source_key: "nest:emory" }],
        ["NEST_CONSENT_GET", { ...getPayload, source_key: `canvas:${"f".repeat(64)}` }],
        ["NEST_CONSENT_SET", { granted: true }],
        ["NEST_CONSENT_SET", { enabled: true }],
        ["NEST_CONSENT_SET", { ...setPayload, cookie: "secret" }],
        ["NEST_CONSENT_SET", { ...setPayload, authorization: "Bearer secret" }],
        ["NEST_CONSENT_SET", { ...setPayload, scopes: ["history_read", "ongoing_sync"] }],
        ["NEST_CONSENT_SET", { ...setPayload, version: "consent-v1" }],
        ["NEST_CONSENT_GET", { ...getPayload, version: "consent-v1" }]
    ];
    for (const [type, payload] of invalid) {
        const before = calls.length;
        const result = await service.handle(contract.createEnvelope(type, payload, `invalid-${before}`), popupSender);
        assert.equal(result.payload.ok, false);
        assert.match(result.payload.code, /NEST_CONSENT_(?:GET|SET)_PAYLOAD_INVALID/);
        assert.equal(calls.length, before);
        assert.doesNotMatch(JSON.stringify(result), /secret|cookie|Bearer/i);
    }

    for (const [sender, code] of [
        [{ url: "https://foreign.example.edu/" }, "SENDER_NOT_ALLOWED"],
        [{ url: "chrome-extension://test-id/html/options.html" }, "SENDER_EXTENSION_REQUIRED"]
    ]) {
        const before = calls.length;
        const result = await service.handle(contract.createEnvelope("NEST_CONSENT_GET", getPayload, `foreign-${before}`), sender);
        assert.deepEqual(result.payload, { ok: false, code });
        assert.equal(calls.length, before);
    }
});

test("producer-shaped v1 non-grants survive transport and router normalization without authorizing access", async () => {
    const accountKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const sourceKey = `canvas:${accountKey}`;
    const popupSender = { url: "chrome-extension://test-id/html/popup.html" };
    const payload = { source_key: sourceKey, account_key: accountKey, version: 1 };
    let producerBody;
    const service = router.createRouter({
        chromeApi: extensionChrome(),
        storage: storage.createMemoryStorage({ sync: {}, local: {}, session: {} }),
        transport: {
            request: async () => transport.responseFromFetch(response(200, producerBody)),
            identityGet: async () => ({ ok: true })
        }
    });
    const invoke = (id) => service.handle(contract.createEnvelope("NEST_CONSENT_GET", payload, id), popupSender);
    const producerConsent = (overrides = {}) => ({
        version: 1,
        sourceKey,
        source_key: sourceKey,
        accountKey: accountKey,
        account_key: accountKey,
        current: true,
        granted: false,
        state: "not_granted",
        scopes: [],
        ...overrides
    });
    const envelope = (consent) => ({
        contractVersion: 1,
        ok: true,
        consent,
        version: consent.version,
        current: consent.current,
        granted: consent.granted,
        scopes: consent.scopes,
        sourceKey: consent.sourceKey
    });

    producerBody = envelope(producerConsent());
    let result = await invoke("producer-empty");
    assert.equal(result.payload.ok, true);
    assert.deepEqual(result.payload.body.scopes, []);
    assert.equal(result.payload.body.granted, false);
    assert.equal(result.payload.body.revoked, false);

    producerBody = envelope(producerConsent({ scopes: ["ongoing_read"] }));
    result = await invoke("producer-partial");
    assert.equal(result.payload.ok, true);
    assert.deepEqual(result.payload.body.scopes, ["ongoing_read"]);
    assert.equal(result.payload.body.granted, false);

    producerBody = envelope(producerConsent({ current: false, state: "revoked" }));
    result = await invoke("producer-revoked");
    assert.equal(result.payload.ok, true);
    assert.equal(result.payload.body.state, "revoked");
    assert.equal(result.payload.body.revoked, true);
    assert.equal(result.payload.body.consent.revoked, true);

    for (const [name, overrides] of [
        ["partial-grant", { granted: true, scopes: ["ongoing_read"], state: "active" }],
        ["unknown-scope", { scopes: ["unknown_scope"] }],
        ["duplicate-scope", { scopes: ["ongoing_read", "ongoing_read"] }]
    ]) {
        producerBody = envelope(producerConsent(overrides));
        result = await invoke(`producer-${name}`);
        assert.deepEqual(result.payload, { ok: false, code: "NEST_CONSENT_RESPONSE_INVALID" }, name);
    }

    const writePayload = { ...payload, version: 2 };
    producerBody = envelope({ ...producerConsent({ version: 2, scopes: ["personal_events_write"] }), sourceKey, source_key: sourceKey });
    producerBody.version = 2;
    result = await service.handle(contract.createEnvelope("NEST_CONSENT_GET", writePayload, "producer-v2-separate"), popupSender);
    assert.deepEqual(result.payload, { ok: false, code: "NEST_CONSENT_RESPONSE_INVALID" });
});

test("projection calendars and routing use the real source-bound contract without upload", async () => {
    const accountKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const sourceRef = "src1:opaque-routing";
    const sourceKey = `canvas:${accountKey}`;
    const area = storage.createMemoryStorage({
        sync: {},
        local: {
            "platform.sourceMetadata": {
                version: 1,
                accounts: {
                    [accountKey]: {
                        source_ref: sourceRef,
                        source_key: sourceKey,
                        origin: "https://canvas.example.edu",
                        nest_user_id: "nest-user-1",
                        provider_user_id: "canvas-user",
                        label: "Canvas",
                        active: true,
                        archived: false,
                        routing_eligible: true
                    }
                }
            }
        },
        session: {}
    });
    const calls = [];
    const transportStub = {
        identityGet: async (options) => { calls.push({ kind: "identity", options }); return { ok: true, body: { contractVersion: 1, authenticated: true, state: "authenticated", user_id: "nest-user-1" } }; },
        request: async (request, options) => {
            calls.push({ kind: "request", request, options });
            if (request.path === "/api/extension/calendars") return { ok: true, status: 200, body: { contractVersion: 1, ok: true, calendars: [{ id: "calendar-main", label: "Main", visible: true, read_only: false, imported: false, kind: "native", routing_eligible: true, routing_degraded: false }] } };
            if (request.path === `/api/extension/calendar/sources/${encodeURIComponent(sourceRef)}/routing`) return { ok: true, status: 200, body: { contractVersion: 1, ok: true, routing: { state: "incomplete", destination_calendar_id: "calendar-main", fallback_calendar_id: null } } };
            return { ok: true, status: 200, body: { version: 1, current: true, granted: true, account_key: accountKey, source_key: sourceKey, scopes: ["full_history_upload", "ongoing_read", "shares_ics_inclusion"] } };
        },
        mutate: async (request, options) => {
            calls.push({ kind: "mutate", request, options });
            return { ok: true, status: 200, body: { contractVersion: 1, ok: true, routing: { state: request.body.state, destination_calendar_id: request.body.destination_calendar_id, fallback_calendar_id: request.body.fallback_calendar_id }, idempotent: true } };
        }
    };
    const service = router.createRouter({ chromeApi: extensionChrome(), storage: area, transport: transportStub, featureFlags: { projection: true } });
    const sender = { url: "chrome-extension://test-id/html/popup.html" };
    const calendars = await service.handle(contract.createEnvelope("NEST_CALENDARS_GET", { source_ref: sourceRef }, "calendars-1"), sender);
    assert.deepEqual(calendars.payload, {
        contractVersion: 1,
        ok: true,
        calendars: [{ id: "calendar-main", label: "Main", visible: true, read_only: false, imported: false, kind: "native", routing_eligible: true, routing_degraded: false }],
        source_ref: sourceRef,
        routing: { incomplete: { state: "incomplete", destination_calendar_id: "calendar-main", fallback_calendar_id: null }, completed: null }
    });
    assert.equal(calls.filter((call) => call.kind === "mutate").length, 0);
    assert.equal(calls.some((call) => call.request?.path === "/api/extension/calendars"), true);
    assert.equal(calls.some((call) => call.request?.path === `/api/extension/calendar/sources/${encodeURIComponent(sourceRef)}/routing` && call.request.method === "GET"), true);

    const routing = await service.handle(contract.createEnvelope("NEST_ROUTING_SET", { source_ref: sourceRef, state: "completed", destination_calendar_id: "calendar-main", fallback_calendar_id: null }, "routing-1"), sender);
    assert.deepEqual(routing.payload, { ok: true, contractVersion: 1, routing: { state: "completed", destination_calendar_id: "calendar-main", fallback_calendar_id: null }, idempotent: true });
    const mutation = calls.find((call) => call.kind === "mutate");
    assert.equal(mutation.request.path, `/api/extension/calendar/sources/${encodeURIComponent(sourceRef)}/routing`);
    assert.deepEqual(mutation.request.body, { state: "completed", destination_calendar_id: "calendar-main", fallback_calendar_id: null });
    assert.equal(mutation.options.idempotent, true);
    assert.equal(mutation.options.idempotencyKey, "routing-1");
    assert.equal(calls.some((call) => call.kind === "request" && call.request.path.includes("/sync")), false);

    const disabled = router.createRouter({ chromeApi: extensionChrome(), storage: area, transport: transportStub, featureFlags: { projection: false } });
    const gated = await disabled.handle(contract.createEnvelope("NEST_CALENDARS_GET", {}, "calendars-disabled"), sender);
    assert.deepEqual(gated.payload, { ok: false, code: "FEATURE_DISABLED_PROJECTION" });
});

test("routing binds source references to the current opaque Nest identity and isolates Canvas consent", async () => {
    const accountA = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const accountB = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
    const sourceA = "src1:routing-account-a";
    const sourceB = "src1:routing-account-b";
    const userA = "nest-user-a";
    const sourceRecord = (accountKey, sourceRef, nestUserId) => ({
        source_ref: sourceRef,
        source_key: `canvas:${accountKey}`,
        origin: "https://canvas.example.edu",
        nest_user_id: nestUserId,
        provider_user_id: "canvas-user",
        label: "Canvas",
        active: true,
        archived: false,
        routing_eligible: true
    });
    const area = storage.createMemoryStorage({
        sync: {},
        local: { "platform.sourceMetadata": { version: 1, accounts: {
            [accountA]: sourceRecord(accountA, sourceA, userA),
            [accountB]: sourceRecord(accountB, sourceB, userA)
        } } },
        session: {}
    });
    let currentUser = userA;
    let consent = { account_key: accountA, source_key: `canvas:${accountA}`, version: 1, current: true, granted: true, scopes: router.CONSENT_SCOPES.slice() };
    const calls = [];
    const transportStub = {
        identityGet: async () => ({ ok: true, body: { contractVersion: 1, authenticated: true, state: "authenticated", user_id: currentUser } }),
        request: async (request) => {
            calls.push(request);
            if (request.path === "/api/extension/calendars") return { ok: true, status: 200, body: { contractVersion: 1, ok: true, calendars: [{ id: "calendar-main", label: "Main", visible: true, read_only: false, imported: false, kind: "native", routing_eligible: true, routing_degraded: false }] } };
            if (request.path.endsWith("/routing")) return { ok: true, status: 200, body: { contractVersion: 1, ok: true, routing: { state: "incomplete", destination_calendar_id: "calendar-main", fallback_calendar_id: null } } };
            return { ok: true, status: 200, body: consent };
        },
        mutate: async () => { throw new Error("mutation should not be reached by this test"); }
    };
    const service = router.createRouter({ chromeApi: extensionChrome(), storage: area, transport: transportStub, featureFlags: { projection: true } });
    const sender = { url: "chrome-extension://test-id/html/popup.html" };
    const request = (sourceRef, id) => service.handle(contract.createEnvelope("NEST_CALENDARS_GET", { source_ref: sourceRef }, id), sender);

    assert.equal((await request(sourceA, "bound-a")).payload.ok, true, "real identity shape without Canvas account key is accepted");
    const callsBeforeSwitch = calls.length;
    currentUser = "nest-user-switched";
    assert.deepEqual((await request(sourceA, "switched")).payload, { ok: false, code: "NEST_IDENTITY_MISMATCH" });
    assert.equal(calls.length, callsBeforeSwitch + 1, "switched identity stops before the routing backend");

    currentUser = userA;
    consent = { ...consent, account_key: accountB, source_key: `canvas:${accountB}` };
    assert.deepEqual((await request(sourceA, "canvas-cross-account")).payload, { ok: false, code: "NEST_CURRENT_READ_CONSENT_REQUIRED" });
    consent = { account_key: accountA, source_key: `canvas:${accountA}`, version: 1, current: false, granted: false, scopes: router.CONSENT_SCOPES.slice() };
    assert.deepEqual((await request(sourceA, "revoked")).payload, { ok: false, code: "NEST_CURRENT_READ_CONSENT_REQUIRED" });
    consent = { account_key: accountA, source_key: `canvas:${accountA}`, version: 1, current: true, granted: true, revoked: true, scopes: router.CONSENT_SCOPES.slice() };
    assert.deepEqual((await request(sourceA, "revoked-boolean-contradiction")).payload, { ok: false, code: "NEST_CURRENT_READ_CONSENT_REQUIRED" });
    consent = { account_key: accountA, source_key: `canvas:${accountA}`, version: 1, current: true, granted: true, state: "revoked", scopes: router.CONSENT_SCOPES.slice() };
    assert.deepEqual((await request(sourceA, "revoked-state-contradiction")).payload, { ok: false, code: "NEST_CURRENT_READ_CONSENT_REQUIRED" });

    const unboundArea = storage.createMemoryStorage({ sync: {}, local: { "platform.sourceMetadata": { version: 1, accounts: { [accountA]: sourceRecord(accountA, sourceA, undefined) } } }, session: {} });
    const unbound = router.createRouter({ chromeApi: extensionChrome(), storage: unboundArea, transport: transportStub, featureFlags: { projection: true } });
    assert.deepEqual((await unbound.handle(contract.createEnvelope("NEST_CALENDARS_GET", { source_ref: sourceA }, "unbound"), sender)).payload, { ok: false, code: "NEST_SOURCE_REF_INVALID" });
    assert.deepEqual((await request("src1:missing-source", "missing")).payload, { ok: false, code: "NEST_SOURCE_REF_INVALID" });
});

test("consent normalization enforces v1 contract aliases and envelope/body agreement", async () => {
    const accountKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const sourceRef = "src1:consent-contract";
    const sourceKey = `canvas:${accountKey}`;
    const source = { source_ref: sourceRef, source_key: sourceKey, origin: "https://canvas.example.edu", nest_user_id: "nest-user-1", provider_user_id: "canvas-user", label: "Canvas", active: true, archived: false, routing_eligible: true };
    const area = storage.createMemoryStorage({ sync: {}, local: { "platform.sourceMetadata": { version: 1, accounts: { [accountKey]: source } } }, session: {} });
    const calendar = { id: "calendar-main", label: "Main", visible: true, read_only: false, imported: false, kind: "native", routing_eligible: true, routing_degraded: false };
    const baseConsent = { version: 1, current: true, granted: true, account_key: accountKey, source_key: sourceKey, scopes: router.CONSENT_SCOPES.slice() };
    let consentResponse = { ...baseConsent };
    const transportStub = {
        identityGet: async () => ({ ok: true, body: { authenticated: true, state: "authenticated", user_id: "nest-user-1" } }),
        request: async (request) => {
            if (request.path === "/api/extension/calendars") return { ok: true, status: 200, body: { contractVersion: 1, ok: true, calendars: [calendar] } };
            if (request.path.endsWith("/routing")) return { ok: true, status: 200, body: [] };
            return consentResponse;
        }
    };
    const service = router.createRouter({ chromeApi: extensionChrome(), storage: area, transport: transportStub, featureFlags: { projection: true } });
    const sender = { url: "chrome-extension://test-id/html/popup.html" };
    const invoke = (id) => service.handle(contract.createEnvelope("NEST_CALENDARS_GET", { source_ref: sourceRef }, id), sender);

    for (const [name, responseValue] of [
        ["missing-contract-version-v1", { ...baseConsent }],
        ["nested-v1", { contractVersion: 1, consent: { ...baseConsent } }],
        ["camel-v1", { contractVersion: 1, consent: { ...baseConsent }, contract_version: 1 }]
    ]) {
        consentResponse = responseValue;
        assert.equal((await invoke(name)).payload.ok, true, name);
    }
    for (const [name, responseValue] of [
        ["contract-version-2", { ...baseConsent, contractVersion: 2 }],
        ["contract-version-alias-2", { ...baseConsent, contract_version: 2 }],
        ["contract-alias-mismatch", { ...baseConsent, contractVersion: 1, contract_version: 2 }],
        ["envelope-body-mismatch", { contractVersion: 1, body: { ...baseConsent, contract_version: 2 } }],
        ["consent-version-2", { ...baseConsent, version: 2 }]
    ]) {
        consentResponse = responseValue;
        assert.deepEqual((await invoke(name)).payload, { ok: false, code: "NEST_CURRENT_READ_CONSENT_REQUIRED" }, name);
    }
});

test("routing GET normalizes zero/one/two backend rows and rejects unsafe or duplicate rows", async () => {
    const accountKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const sourceRef = "src1:routing-matrix";
    const sourceKey = `canvas:${accountKey}`;
    const area = storage.createMemoryStorage({
        sync: {},
        local: { "platform.sourceMetadata": { version: 1, accounts: { [accountKey]: { source_ref: sourceRef, source_key: sourceKey, origin: "https://canvas.example.edu", nest_user_id: "nest-user-1", provider_user_id: "canvas-user", label: "Canvas", active: true, archived: false, routing_eligible: true } } } },
        session: {}
    });
    const calendar = { id: "calendar-main", label: "Main", visible: true, read_only: false, imported: false, kind: "native", routing_eligible: true, routing_degraded: false };
    const incomplete = { state: "incomplete", destination_calendar_id: "calendar-main", fallback_calendar_id: null };
    const completed = { state: "completed", destination_calendar_id: "calendar-fallback", fallback_calendar_id: "calendar-main" };
    let routeBody = [];
    let mutationBody = { ...completed, internal_id: "route-2" };
    const transportStub = {
        identityGet: async () => ({ ok: true, body: { contractVersion: 1, authenticated: true, state: "authenticated", user_id: "nest-user-1" } }),
        request: async (request) => {
            if (request.path === "/api/extension/calendars") return { ok: true, status: 200, body: { contractVersion: 1, ok: true, calendars: [calendar] } };
            if (request.path.includes("/routing")) return { ok: true, status: 200, body: routeBody };
            return { ok: true, status: 200, body: { contractVersion: 1, ok: true, consent: { version: 1, current: true, granted: true, account_key: accountKey, source_key: sourceKey, scopes: router.CONSENT_SCOPES.slice() }, version: 1, current: true, granted: true, account_key: accountKey, source_key: sourceKey, scopes: router.CONSENT_SCOPES.slice() } };
        },
        mutate: async () => ({ ok: true, status: 200, body: { ...mutationBody, idempotent: true } })
    };
    const service = router.createRouter({ chromeApi: extensionChrome(), storage: area, transport: transportStub, featureFlags: { projection: true } });
    const sender = { url: "chrome-extension://test-id/html/popup.html" };
    for (const [rows, expected] of [
        [[], { incomplete: null, completed: null }],
        [[incomplete], { incomplete, completed: null }],
        [[incomplete, completed], { incomplete, completed }],
        [incomplete, { incomplete, completed: null }]
    ]) {
        routeBody = rows;
        const result = await service.handle(contract.createEnvelope("NEST_CALENDARS_GET", { source_ref: sourceRef }, `routing-${JSON.stringify(rows).length}`), sender);
        assert.deepEqual(result.payload.routing, expected);
    }
    for (const [index, invalid] of [
        [incomplete, incomplete],
        [{ ...incomplete, state: "unknown" }],
        [{ ...incomplete, destination_calendar_id: "https://unsafe" }],
        [{ ...incomplete, destinationCalendarId: "calendar-other" }]
    ].entries()) {
        routeBody = invalid;
        const result = await service.handle(contract.createEnvelope("NEST_CALENDARS_GET", { source_ref: sourceRef }, `invalid-routing-${index}`), sender);
        assert.deepEqual(result.payload, { ok: false, code: "NEST_ROUTING_RESPONSE_INVALID" });
    }
    const put = await service.handle(contract.createEnvelope("NEST_ROUTING_SET", { source_ref: sourceRef, state: "completed", destination_calendar_id: "calendar-main", fallback_calendar_id: null }, "routing-put"), sender);
    assert.deepEqual(put.payload, { ok: true, contractVersion: 1, routing: { state: "completed", destination_calendar_id: "calendar-fallback", fallback_calendar_id: "calendar-main" }, idempotent: true });
});

test("revoke reports server-revoked local cleanup pending, retries after restart, and isolates accounts", async () => {
    const accountA = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const accountB = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
    const area = storage.createMemoryStorage({ sync: {}, local: {}, session: {} });
    let outboxAttempts = 0;
    let mutateAttempts = 0;
    const calls = [];
    const dependencies = {
        outbox: { revokeAccount: async ({ accountKey }) => { calls.push(["outbox", accountKey]); outboxAttempts += 1; if (outboxAttempts === 1) throw new Error("temporary local failure"); } },
        alarms: { cancelAccount: async (accountKey) => calls.push(["alarm", accountKey]) },
        syncStorage: { revokeAccount: async (accountKey) => calls.push(["sync", accountKey]) }
    };
    const firstCleanup = router.createRevocationCleanupCoordinator({ storage: area, ...dependencies, now: () => 1000 });
    await firstCleanup.mark(accountB, "revoked");
    const transportStub = {
        mutate: async () => { mutateAttempts += 1; calls.push(["revoke", mutateAttempts]); return { ok: true, status: 200, body: { ok: true, account_key: accountA, source_key: `canvas:${accountA}` } }; },
        request: async () => ({ ok: true, body: {} }),
        identityGet: async () => ({ ok: true, body: {} })
    };
    const payload = { source_key: `canvas:${accountA}`, account_key: accountA, action: "revoke", scopes: router.CONSENT_SCOPES.slice(), version: 1 };
    const first = router.createRouter({ chromeApi: extensionChrome(), storage: area, transport: transportStub, revocationCleanup: firstCleanup }).handle(contract.createEnvelope("NEST_CONSENT_SET", payload, "revoke-a-1"), { url: "chrome-extension://test-id/html/popup.html" });
    const firstResult = await first;
    assert.equal(firstResult.payload.code, "SERVER_REVOKED_LOCAL_CLEANUP_PENDING");
    assert.equal(firstResult.payload.server_revoked, true);
    assert.equal(firstResult.payload.revoke_pending, true);
    assert.equal(mutateAttempts, 1);
    assert.deepEqual((await area.get("local", "platform.revocationSummaries"))["platform.revocationSummaries"].accounts[accountB], {
        version: 1, state: "revoked", retry_required: false, revoke_pending: false, server_revoked: true, local_cleanup_pending: false, local_stopped: true, updated_at: 1000
    });

    const restartedCleanup = router.createRevocationCleanupCoordinator({ storage: area, ...dependencies, now: () => 2000 });
    const second = await router.createRouter({ chromeApi: extensionChrome(), storage: area, transport: transportStub, revocationCleanup: restartedCleanup }).handle(contract.createEnvelope("NEST_CONSENT_SET", payload, "revoke-a-2"), { url: "chrome-extension://test-id/html/popup.html" });
    assert.deepEqual(second.payload, { ok: true, state: "revoked", revoked: true });
    assert.equal(mutateAttempts, 2);
    const summaries = (await area.get("local", "platform.revocationSummaries"))["platform.revocationSummaries"].accounts;
    assert.equal(summaries[accountA].state, "revoked");
    assert.equal(summaries[accountA].server_revoked, true);
    assert.equal(summaries[accountB].state, "revoked");
    assert.equal(calls.some(([kind]) => kind === "upload" || kind === "retry"), false);

    const failingArea = storage.createMemoryStorage({ sync: {}, local: {}, session: {} });
    const failingCleanup = router.createRevocationCleanupCoordinator({ storage: failingArea, outbox: { revokeAccount: async () => {} }, now: () => 3000 });
    const failingTransport = { mutate: async () => { throw new Error("server unavailable"); } };
    const failed = await router.createRouter({ chromeApi: extensionChrome(), storage: failingArea, transport: failingTransport, revocationCleanup: failingCleanup }).handle(contract.createEnvelope("NEST_CONSENT_SET", payload, "revoke-a-failure"), { url: "chrome-extension://test-id/html/popup.html" });
    assert.deepEqual(failed.payload, { ok: false, code: "NEST_REVOKE_RETRY_REQUIRED" });
    assert.equal((await failingArea.get("local", "platform.revocationSummaries"))["platform.revocationSummaries"].accounts[accountA].server_revoked, false);
});

test("direct mutation obtains fresh CSRF and retries once only when idempotent", async () => {
    const calls = [];
    let csrfCount = 0;
    let mutationCount = 0;
    const nest = transport.createNestTransport({
        fetchImpl: async (url, options) => {
            calls.push({ url, options });
            if (url.endsWith("/csrf")) {
                csrfCount += 1;
                return response(200, {}, { "content-type": "application/json", "x-csrftoken": `csrf-${csrfCount}` });
            }
            mutationCount += 1;
            return response(mutationCount === 1 ? 403 : 200, { ok: mutationCount > 1 });
        }
    });
    const result = await nest.mutate({ method: "PUT", path: "/api/extension/events/override", body: { eventId: "event-1" } }, { requestId: "mutate-1", idempotent: true, idempotencyKey: "idem-1" });
    assert.equal(result.ok, true);
    assert.equal(result.retried, true);
    assert.equal(csrfCount, 2);
    assert.equal(mutationCount, 2);
    const mutations = calls.filter((call) => call.url.endsWith("/events/override"));
    assert.equal(mutations[0].options.headers["x-csrftoken"], "csrf-1");
    assert.equal(mutations[1].options.headers["x-csrftoken"], "csrf-2");
    assert.equal(mutations[0].options.headers["idempotency-key"], "idem-1");

    let nonIdempotentCalls = 0;
    const nonIdempotent = transport.createNestTransport({
        fetchImpl: async (url) => {
            if (url.endsWith("/csrf")) return response(200, {}, { "content-type": "application/json", "x-csrftoken": "csrf-one" });
            nonIdempotentCalls += 1;
            return response(403, { ok: false });
        }
    });
    const noRetry = await nonIdempotent.mutate({ method: "POST", path: "/api/extension/events/mutate", body: { eventId: "event-1" } }, { requestId: "mutate-2", idempotent: false });
    assert.equal(noRetry.retried, false);
    assert.equal(nonIdempotentCalls, 1);
});

test("tab mutation fallback performs a whole request and never carries or returns raw CSRF", async () => {
    let sent;
    const nest = transport.createNestTransport({
        fetchImpl: async () => { throw new TypeError("offline before CSRF"); },
        findExactNestTab: async () => ({ id: 9, url: "https://nest.apstudy.org/app" }),
        sendToTab: async (_tabId, message) => {
            sent = message;
            return { kind: "APSTUDYCANVAS_NEST_BRIDGE_RESPONSE", version: 1, request_id: message.request_id, ok: true, status: 200, headers: { "content-type": "application/json" }, body: { ok: true } };
        }
    });
    const result = await nest.mutate({ method: "POST", path: "/api/extension/consent", body: { granted: true } }, { requestId: "whole-1", idempotent: true, idempotencyKey: "idem-whole" });
    assert.equal(result.ok, true);
    assert.deepEqual(sent.mutation, { idempotent: true, idempotency_key: "idem-whole" });
    assert.equal(sent.request.headers["x-csrftoken"], undefined);
    assert.doesNotMatch(JSON.stringify(sent), /csrf-[A-Za-z0-9]/i);
    assert.equal(result.headers["x-csrftoken"], undefined);
});

test("IDB rejects secrets, evicts acknowledged oldest-first, and never evicts pending", async () => {
    for (const value of [
        { accessToken: "opaque" },
        { authorization_value: "opaque" },
        { privateIcsUrl: "https://calendar.example/private.ics" },
        { rawCsrf: "opaque" },
        { message: "Bearer abc.def.ghi" },
        { message: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.signature123" }
    ]) await assert.rejects(indexedDb.createMemoryBoundedStore().put("batch", value), /IDB_SECRET_STORAGE_FORBIDDEN/);

    const queue = indexedDb.createMemoryBoundedStore({ maxBytes: 100, maxRecords: 3 });
    await queue.put("ack-old", { id: 1 }, { state: "acknowledged", createdAt: 1 });
    await queue.put("pending", { id: 2 }, { state: "pending", createdAt: 2 });
    await queue.put("ack-new", { id: 3 }, { state: "acknowledged", createdAt: 3 });
    assert.equal((await queue.put("incoming", { id: 4 })).ok, true);
    assert.equal(await queue.get("ack-old"), undefined);
    assert.deepEqual(await queue.get("pending"), { id: 2 });
    assert.deepEqual(await queue.get("ack-new"), { id: 3 });
});

test("IDB acknowledged replacement cannot self-evict at byte and record limits", async () => {
    const queue = indexedDb.createMemoryBoundedStore({ maxBytes: 50, maxRecords: 2 });
    const original = { data: "a".repeat(10) };
    const peer = { data: "b".repeat(10) };
    await queue.put("target", original, { state: "acknowledged", createdAt: 1 });
    await queue.put("pending-peer", peer, { state: "pending", createdAt: 2 });

    const replacement = await queue.put("target", { data: "c".repeat(30) }, { state: "acknowledged", createdAt: 3 });
    assert.equal(replacement.code, "IDB_PENDING_LIMIT");
    assert.deepEqual(await queue.get("target"), original);
    assert.deepEqual(await queue.get("pending-peer"), peer);
    const status = await queue.status();
    assert.equal(status.count, 2);
    assert.ok(status.bytes <= status.maxBytes);
});

test("IDB larger acknowledged replacement evicts another acknowledged record, not itself", async () => {
    const queue = indexedDb.createMemoryBoundedStore({ maxBytes: 60, maxRecords: 3 });
    await queue.put("target", { data: "a".repeat(10) }, { state: "acknowledged", createdAt: 1 });
    await queue.put("evictable", { data: "b".repeat(10) }, { state: "acknowledged", createdAt: 2 });
    await queue.put("pending-peer", { id: 3 }, { state: "pending", createdAt: 3 });

    const larger = { data: "c".repeat(25) };
    const replacement = await queue.put("target", larger, { state: "acknowledged", createdAt: 4 });
    assert.equal(replacement.ok, true);
    assert.deepEqual(await queue.get("target"), larger);
    assert.equal(await queue.get("evictable"), undefined);
    assert.deepEqual(await queue.get("pending-peer"), { id: 3 });
    assert.equal((await queue.status()).count, 2);
});

test("IDB smaller acknowledged replacement preserves target and peers without count drift", async () => {
    const queue = indexedDb.createMemoryBoundedStore({ maxBytes: 50, maxRecords: 2 });
    await queue.put("target", { data: "a".repeat(20) }, { state: "acknowledged", createdAt: 1 });
    await queue.put("pending-peer", { id: 2 }, { state: "pending", createdAt: 2 });

    const smaller = { data: "b".repeat(5) };
    const replacement = await queue.put("target", smaller, { state: "acknowledged", createdAt: 3 });
    assert.equal(replacement.ok, true);
    assert.deepEqual(await queue.get("target"), smaller);
    assert.deepEqual(await queue.get("pending-peer"), { id: 2 });
    assert.equal((await queue.status()).count, 2);
});

test("IDB pending replacement never evicts its target", async () => {
    const queue = indexedDb.createMemoryBoundedStore({ maxBytes: 50, maxRecords: 2 });
    await queue.put("pending-target", { data: "a".repeat(10) }, { state: "pending", createdAt: 1 });
    await queue.put("ack-peer", { data: "b".repeat(10) }, { state: "acknowledged", createdAt: 2 });

    const larger = { data: "c".repeat(25) };
    const replacement = await queue.put("pending-target", larger, { state: "pending", createdAt: 3 });
    assert.equal(replacement.ok, true);
    assert.deepEqual(await queue.get("pending-target"), larger);
    assert.equal(await queue.get("ack-peer"), undefined);
    const status = await queue.status();
    assert.equal(status.count, 1);
    assert.ok(status.bytes <= status.maxBytes);
});

test("IDB pauses on pending limit and resumes only after acknowledgment permits eviction", async () => {
    const queue = indexedDb.createMemoryBoundedStore({ maxBytes: 100, maxRecords: 2 });
    await queue.put("one", { id: 1 });
    await queue.put("two", { id: 2 });
    const limited = await queue.put("three", { id: 3 });
    assert.equal(limited.code, "IDB_PENDING_LIMIT");
    assert.equal((await queue.resume()).paused, true);
    await queue.acknowledge("one");
    assert.equal((await queue.resume()).paused, false);
    assert.equal(await queue.get("one"), undefined);
    assert.equal((await queue.put("three", { id: 3 })).ok, true);
});

test("real-store quota errors expose a sanitized pause reason and recover only through acknowledged eviction", async () => {
    const backend = indexedDb.createMemoryBackend([
        { key: "acked", value: { id: 1 }, bytes: 8, state: "acknowledged", createdAt: 1 }
    ], { failQuotaWrites: 1 });
    const queue = indexedDb.createIndexedDbStore({ backend, maxBytes: 1000, maxRecords: 10 });
    const failed = await queue.put("pending", { id: 2 });
    assert.equal(failed.code, "IDB_QUOTA_EXCEEDED");
    assert.deepEqual(failed.reason, { code: "IDB_QUOTA_EXCEEDED", message: "Browser storage quota was exceeded." });
    assert.doesNotMatch(JSON.stringify(failed), /sensitive browser quota details/);
    const recovered = await queue.resume();
    assert.equal(recovered.paused, false);
    assert.equal(await queue.get("acked"), undefined);
    assert.equal((await queue.put("pending", { id: 2 })).ok, true);

    const noAckBackend = indexedDb.createMemoryBackend([], { failQuotaWrites: 1 });
    const noAck = indexedDb.createIndexedDbStore({ backend: noAckBackend });
    await noAck.put("pending", { id: 1 });
    assert.equal((await noAck.resume()).paused, true);
});

function dynamicChrome({ permission = false, scripting = true } = {}) {
    const scripts = [];
    const calls = { contains: [], registered: [], unregistered: [] };
    const chromeApi = {
        permissions: {
            async contains(query) { calls.contains.push(query); return permission; }
        }
    };
    if (scripting) chromeApi.scripting = {
        async getRegisteredContentScripts() { return scripts.map((item) => structuredClone(item)); },
        async registerContentScripts(items) { calls.registered.push(...items); scripts.push(...structuredClone(items)); },
        async unregisterContentScripts({ ids }) { calls.unregistered.push(...ids); ids.forEach((id) => { const index = scripts.findIndex((script) => script.id === id); if (index >= 0) scripts.splice(index, 1); }); }
    };
    return { chromeApi, scripts, calls };
}

test("dynamic Canvas registration requires explicit exact-origin permission and registers one exact pattern", async () => {
    const origin = "https://canvas.example.edu";
    const deniedApi = dynamicChrome({ permission: false });
    const denied = canvasRegistration.createCanvasRegistration({ chromeApi: deniedApi.chromeApi });
    assert.deepEqual(await denied.ensureOrigin(origin, { configuredOrigins: [origin] }), { ok: false, code: "permission_required", origin, permission: `${origin}/*` });
    assert.equal(deniedApi.scripts.length, 0);
    assert.deepEqual(deniedApi.calls.contains[0], { origins: [`${origin}/*`] });

    const allowedApi = dynamicChrome({ permission: true });
    const allowed = canvasRegistration.createCanvasRegistration({ chromeApi: allowedApi.chromeApi });
    const registered = await allowed.ensureOrigin(origin, { configuredOrigins: [origin] });
    assert.equal(registered.state, "registered");
    assert.equal(allowedApi.scripts.length, 2);
    const watchdogScript = allowedApi.scripts.find((script) => script.id.endsWith("-watchdog"));
    const contentScript = allowedApi.scripts.find((script) => script.id === canvasRegistration.scriptIdForOrigin(origin));
    assert.ok(watchdogScript);
    assert.deepEqual(watchdogScript.js, [canvasRegistration.CANVAS_WATCHDOG_SCRIPT]);
    assert.equal(watchdogScript.world, "MAIN");
    assert.deepEqual(contentScript.matches, [`${origin}/*`]);
    assert.deepEqual(contentScript.js, canvasRegistration.CANVAS_CONTENT_SCRIPTS);
    assert.deepEqual(contentScript.css, canvasRegistration.CANVAS_CSS);
    assert.ok(!contentScript.matches.some((match) => match === "https://*/*"));
    assert.equal((await allowed.ensureOrigin("https://canvas.example.edu.evil.test", { configuredOrigins: [origin] })).code, "CANVAS_ORIGIN_NOT_CONFIGURED");
    assert.equal((await canvasRegistration.createCanvasRegistration({ chromeApi: dynamicChrome({ scripting: false }).chromeApi }).ensureOrigin(origin, { configuredOrigins: [origin] })).code, "browser_unsupported");
    assert.equal((await allowed.ensureOrigin(canvasRegistration.DEFAULT_CANVAS_ORIGIN, { configuredOrigins: [canvasRegistration.DEFAULT_CANVAS_ORIGIN] })).state, "already_static");
});

test("router gates dynamic registration, rejects Canvas spoofing, and never silently enables later families", async () => {
    const origin = "https://canvas.example.edu";
    const area = storage.createMemoryStorage({ sync: { custom_domain: [origin] }, local: {}, session: {} });
    const registration = { ensureOrigin: async (requested, options) => requested === origin && options.configuredOrigins.includes(origin) ? { ok: false, code: "permission_required", origin } : { ok: false, code: "CANVAS_ORIGIN_NOT_CONFIGURED" } };
    const service = router.createRouter({
        chromeApi: extensionChrome(),
        storage: area,
        transport: { identityGet: async () => ({ ok: true, identity: "account" }) },
        canvasRegistration: registration,
        featureFlags: { upload: false }
    });
    const permission = await service.handle(contract.createEnvelope("CANVAS_ACCOUNT_VERIFY", { origin }, "permission-1"), { url: "chrome-extension://test-id/popup.html" });
    assert.equal(permission.payload.code, "permission_required");
    const verified = await service.handle(contract.createEnvelope("CANVAS_ACCOUNT_VERIFY", { account_id: "canvas-account" }, "verify-1"), { url: `${origin}/courses/1` });
    assert.equal(verified.payload.ok, true);
    const spoof = await service.handle(contract.createEnvelope("CANVAS_SYNC_STATUS", {}, "spoof-1"), { url: "https://canvas.example.edu.evil.test/courses/1" });
    assert.equal(spoof.payload.code, "SENDER_NOT_ALLOWED");
    const disabled = await service.handle(contract.createEnvelope("CANVAS_SYNC_STATUS", {}, "sync-1"), { url: `${origin}/courses/1` });
    assert.equal(disabled.payload.code, "FEATURE_DISABLED_UPLOAD");
});

test("router delegates public sync only from the exact extension page and redacts results", async () => {
    const origin = "https://canvas.example.edu";
    const area = storage.createMemoryStorage({
        sync: { custom_domain: [origin] },
        local: {
            "platform.accountMetadata": { version: 1, accounts: [{ origin, accountId: "canvas-account" }] },
            canvas_sync_opt_in: { ["0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"]: true }
        },
        session: {}
    });
    const accountKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const rejectedAccountKey = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
    const calls = [];
    const canvasSync = Object.fromEntries([
        ["start", async (payload) => { calls.push(["start", payload]); return { state: "running", source_ref: "src1:opaque-public", source_id: "legacy-source", accountKey: accountKey, provider_user_id: "canvas-user", lease_token: "secret", counts: { sent: 2, nested: { done: 1 } }, token: "secret", raw: { url: "https://private.example" }, correlation: "corr-1" }; }],
        ["resume", async (payload) => { calls.push(["resume", payload]); return { state: "paused", counts: { sent: 3 } }; }],
        ["status", async (payload) => { calls.push(["status", payload]); return { state: "partial", counts: { sent: 4, unsafe: { url: "https://private.example" } }, errorCode: "SAFE_RETRY" }; }],
        ["cancel", async (payload) => { calls.push(["cancel", payload]); return { state: "cancelled" }; }]
    ]);
    const service = router.createRouter({
        chromeApi: extensionChrome(),
        storage: area,
        featureFlags: { upload: true },
        canvasSync,
        transport: {}
    });
    const extensionSender = { url: "chrome-extension://test-id/html/popup.html" };
    for (const [type, method] of [["CANVAS_SYNC_START", "start"], ["CANVAS_SYNC_RESUME", "resume"], ["CANVAS_SYNC_STATUS", "status"], ["CANVAS_SYNC_CANCEL", "cancel"]]) {
        const result = await service.handle(contract.createEnvelope(type, { scope: "current", accountKey }, `sync-${method}`), extensionSender);
        assert.equal(result.payload.state, method === "start" ? "running" : method === "resume" ? "paused" : method === "status" ? "partial" : "cancelled", type);
        if (method === "start") {
            assert.equal(result.payload.source_ref, "src1:opaque-public");
            assert.equal(Object.prototype.hasOwnProperty.call(result.payload, "source_id"), false);
            assert.equal(Object.prototype.hasOwnProperty.call(result.payload, "accountKey"), false);
            assert.equal(Object.prototype.hasOwnProperty.call(result.payload, "provider_user_id"), false);
            assert.equal(Object.prototype.hasOwnProperty.call(result.payload, "lease_token"), false);
        }
        assert.equal(calls.at(-1)[0], method);
        assert.deepEqual(calls.at(-1)[1], { scope: "current", accountKey });
    }
    assert.deepEqual(calls[0], ["start", { scope: "current", accountKey }]);
    const beforeRejected = calls.length;
    const rejected = await service.handle(contract.createEnvelope("CANVAS_SYNC_STATUS", { scope: "current", accountKey: rejectedAccountKey }, "sync-rejected-account"), extensionSender);
    assert.deepEqual(rejected.payload, { ok: false, code: "CANVAS_SYNC_OPT_IN_REQUIRED" });
    assert.equal(calls.length, beforeRejected);
    assert.doesNotMatch(JSON.stringify((await service.handle(contract.createEnvelope("CANVAS_SYNC_START", {}, "redact-1"), extensionSender)).payload), /secret|private|https?:|token|url/i);

    for (const sender of [
        { url: `${origin}/courses/1` },
        { url: "https://foreign.example.edu/courses/1" },
        { url: "chrome-extension://test-id/html/options.html" }
    ]) {
        const before = calls.length;
        const result = await service.handle(contract.createEnvelope("CANVAS_SYNC_STATUS", {}, `reject-${calls.length}`), sender);
        assert.equal(result.payload.ok, false);
        assert.equal(calls.length, before);
    }

    for (const payload of [{ tabId: 1 }, { windowId: 2 }, { url: "https://private.example" }, { headers: { Authorization: "secret" } }]) {
        const result = await service.handle(contract.createEnvelope("CANVAS_SYNC_STATUS", payload, `payload-${Object.keys(payload)[0]}`), extensionSender);
        assert.equal(result.payload.ok, false);
        assert.match(result.payload.code, /REQUEST_CONTEXT_FORBIDDEN|CANVAS_SYNC_PAYLOAD_INVALID/);
    }
});

test("router keeps public sync disabled and writeback non-delegating", async () => {
    const calls = [];
    const origin = "https://canvas.example.edu";
    const area = storage.createMemoryStorage({
        sync: { custom_domain: [origin] },
        local: {},
        session: {}
    });
    const canvasSync = Object.fromEntries(["start", "resume", "status", "cancel"].map((method) => [method, async () => { calls.push(method); return { state: "running" }; }]));
    const extensionSender = { url: "chrome-extension://test-id/html/popup.html" };
    const disabled = router.createRouter({ chromeApi: extensionChrome(), storage: area, canvasSync, featureFlags: { upload: false }, transport: {} });
    for (const type of ["CANVAS_SYNC_START", "CANVAS_SYNC_RESUME", "CANVAS_SYNC_STATUS", "CANVAS_SYNC_CANCEL"]) {
        const result = await disabled.handle(contract.createEnvelope(type, {}, `disabled-${type}`), extensionSender);
        assert.equal(result.payload.code, "FEATURE_DISABLED_UPLOAD");
    }
    assert.deepEqual(calls, []);

    const writeback = router.createRouter({
        chromeApi: extensionChrome(),
        storage: area,
        featureFlags: { upload: true, mirroring: true, mutation: true },
        canvasSync,
        transport: {}
    });
    for (const type of ["CANVAS_WRITEBACK_DRAIN", "CANVAS_WRITEBACK_RESULT"]) {
        const result = await writeback.handle(contract.createEnvelope(type, {}, `writeback-${type}`), extensionSender);
        assert.equal(result.payload.ok, false);
        assert.equal(calls.length, 0);
    }
    assert.deepEqual(calls, []);
});

function permissionChrome({ permission = true, scripting = true } = {}) {
    const scripts = [];
    const calls = { contains: [], request: [], remove: [], registered: [], unregistered: [] };
    const chromeApi = {
        runtime: { getURL: (url) => `chrome-extension://test-id/${url.replace(/^\//, "")}` },
        permissions: {
            async contains(query) { calls.contains.push(query); return permission; },
            async request(query) { calls.request.push(query); return permission; },
            async remove(query) { calls.remove.push(query); return true; }
        }
    };
    if (scripting) chromeApi.scripting = {
        async getRegisteredContentScripts() { return scripts.map((item) => structuredClone(item)); },
        async registerContentScripts(items) { calls.registered.push(...structuredClone(items)); scripts.push(...structuredClone(items)); },
        async unregisterContentScripts({ ids }) { calls.unregistered.push(...ids); ids.forEach((id) => { const index = scripts.findIndex((script) => script.id === id); if (index >= 0) scripts.splice(index, 1); }); }
    };
    return { chromeApi, scripts, calls };
}

function extensionRequest(service, type, payload, requestId) {
    return service.handle(contract.createEnvelope(type, payload, requestId), { url: "chrome-extension://test-id/popup.html" });
}

test("SETTINGS_* uses schema-backed actual popup keys, aliases, per-key results, correct areas, and preserves unknown values on reset", async () => {
    const area = storage.createMemoryStorage({
        sync: { dark_mode: true, sidebar_page_order: ["dashboard", "courses", "calendar", "inbox", "history", "help"], unknown_user_value: "keep" },
        local: {
            seen_update_version: "old-version",
            user_owned_local_value: "keep-local",
            canvas_sync_opt_in: { ["0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"]: true }
        },
        session: {}
    });
    const service = router.createRouter({ chromeApi: extensionChrome(), storage: area, transport: {} });

    const updated = await extensionRequest(service, "SETTINGS_UPDATE", {
        area: "sync",
        changes: { dark_mode: false, sidebar_page_order: ["courses", "dashboard", "calendar", "inbox", "history", "help"] }
    }, "settings-update-1");
    assert.equal(updated.payload.ok, true);
    assert.equal(updated.payload.results.dark_mode.ok, true);
    assert.equal((await area.get("sync", "dark_mode")).dark_mode, false);

    const alias = await extensionRequest(service, "SETTINGS_UPDATE", { area: "sync", changes: { gradent_cards: true } }, "settings-alias-1");
    assert.equal(alias.payload.ok, true);
    assert.equal(alias.payload.results.gradent_cards.ok, true);
    assert.deepEqual(await area.get("sync", ["gradient_cards", "gradent_cards"]), { gradient_cards: true, gradent_cards: true });

    const read = await extensionRequest(service, "SETTINGS_READ", { area: "sync", keys: ["dark_mode", "sidebar_page_order", "gradent_cards"] }, "settings-read-1");
    assert.equal(read.payload.ok, true);
    assert.deepEqual(read.payload.values.dark_mode, false);
    assert.equal(read.payload.results.sidebar_page_order.present, true);

    const malformed = await extensionRequest(service, "SETTINGS_UPDATE", { area: "sync", changes: { dark_mode: "yes" } }, "settings-malformed-1");
    assert.equal(malformed.payload.ok, false);
    assert.equal(malformed.payload.results.dark_mode.code, "SETTINGS_VALUE_INVALID");
    assert.equal((await area.get("sync", "dark_mode")).dark_mode, false);

    for (const key of ["api_key", "privateIcsUrl", "__proto__"]) {
        const changes = JSON.parse(`{"${key}":"secret"}`);
        const rejected = await extensionRequest(service, "SETTINGS_UPDATE", { area: "sync", changes }, `settings-secret-${key}`);
        assert.equal(rejected.payload.ok, false, key);
        assert.equal(rejected.payload.results[key].code, "SETTINGS_KEY_FORBIDDEN", key);
    }

    const accountKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const oversizedOptIn = Object.fromEntries(Array.from({ length: 65 }, (_, index) => [index.toString(16).padStart(64, "0"), true]));
    for (const [label, value] of [
        ["malformed", { [accountKey]: "yes" }],
        ["oversized", oversizedOptIn],
        ["secret", { "Bearer secret": true }]
    ]) {
        const rejected = await extensionRequest(service, "SETTINGS_UPDATE", { area: "local", changes: { canvas_sync_opt_in: value } }, `settings-opt-in-${label}`);
        assert.equal(rejected.payload.ok, false, label);
        assert.equal(rejected.payload.results.canvas_sync_opt_in.code, "SETTINGS_VALUE_INVALID", label);
    }

    const local = await extensionRequest(service, "SETTINGS_UPDATE", { area: "local", changes: { seen_update_version: "new-version" } }, "settings-local-1");
    assert.equal(local.payload.ok, true);
    assert.equal((await area.get("local", "seen_update_version")).seen_update_version, "new-version");

    const reset = await extensionRequest(service, "SETTINGS_RESET", { area: "sync", keys: ["dark_mode", "gradent_cards"] }, "settings-reset-1");
    assert.equal(reset.payload.ok, true);
    const afterReset = area.snapshot();
    assert.equal(afterReset.sync.dark_mode, undefined);
    assert.equal(afterReset.sync.gradient_cards, undefined);
    assert.equal(afterReset.sync.gradent_cards, undefined);
    assert.equal(afterReset.sync.unknown_user_value, "keep");
    assert.equal(afterReset.local.user_owned_local_value, "keep-local");
    assert.deepEqual(afterReset.local.canvas_sync_opt_in, { [accountKey]: true });
});

test("content-facing sync writes dispatch normal popup settings, while local/session platform boundaries remain separate", async () => {
    const changes = [];
    const state = { sync: { dark_mode: true }, local: {}, session: {} };
    const makeArea = (name) => ({
        get(keys) {
            const requested = keys === null || keys === undefined ? Object.keys(state[name]) : Array.isArray(keys) ? keys : [keys];
            return Promise.resolve(Object.fromEntries(requested.filter((key) => Object.prototype.hasOwnProperty.call(state[name], key)).map((key) => [key, state[name][key]])));
        },
        set(values) { Object.assign(state[name], values); changes.push({ area: name, values }); return Promise.resolve(); },
        remove(keys) { (Array.isArray(keys) ? keys : [keys]).forEach((key) => delete state[name][key]); return Promise.resolve(); }
    });
    const adapter = storage.createChromeStorageAdapter({ sync: makeArea("sync"), local: makeArea("local"), session: makeArea("session") });
    await adapter.settingsUpdate("sync", { dark_mode: false });
    assert.deepEqual(changes, [{ area: "sync", values: { dark_mode: false } }]);
    assert.equal(state.sync.dark_mode, false);
    await assert.rejects(adapter.settingsUpdate("session", { dark_mode: false }), /SETTINGS_AREA_UNSUPPORTED/);
});

test("custom Canvas permission flow is exact, user-action gated, sequenced, and cleans up only the changed origin", async () => {
    const oldOrigin = "https://old.canvas.example.edu";
    const newOrigin = "https://new.canvas.example.edu";
    const permission = permissionChrome({ permission: true });
    const area = storage.createMemoryStorage({ sync: { custom_domain: [oldOrigin] }, local: {}, session: {} });
    const registration = canvasRegistration.createCanvasRegistration({ chromeApi: permission.chromeApi });
    const service = router.createRouter({ chromeApi: permission.chromeApi, storage: area, transport: {}, canvasRegistration: registration });

    // Startup reconciliation is read-only with respect to permissions: it may
    // register a previously granted exact script, but it never requests.
    await registration.reconcile({ configuredOrigins: [oldOrigin], verifiedOrigins: [oldOrigin] });
    assert.equal(permission.calls.request.length, 0);
    assert.deepEqual(permission.calls.contains.at(-1), { origins: [`${oldOrigin}/*`] });

    const denied = permissionChrome({ permission: false });
    const deniedArea = storage.createMemoryStorage({ sync: {}, local: {}, session: {} });
    const deniedRegistration = canvasRegistration.createCanvasRegistration({ chromeApi: denied.chromeApi });
    const deniedService = router.createRouter({ chromeApi: denied.chromeApi, storage: deniedArea, transport: {}, canvasRegistration: deniedRegistration });
    const exactRequest = { origins: [`${newOrigin}/*`] };
    assert.equal(await denied.chromeApi.permissions.request(exactRequest), false);
    assert.deepEqual(denied.calls.request, [exactRequest]);
    assert.ok(!JSON.stringify(denied.calls.request).includes("https://*/*"));
    assert.equal((await extensionRequest(deniedService, "SETTINGS_UPDATE", { area: "sync", changes: { custom_domain: [newOrigin] }, user_gesture: true }, "canvas-denied-1")).payload.code, "permission_required");
    assert.deepEqual((await deniedArea.get("sync", ["custom_domain"])), {});
    assert.equal(denied.scripts.length, 0);

    const connected = await extensionRequest(service, "SETTINGS_UPDATE", { area: "sync", changes: { custom_domain: [newOrigin] }, user_gesture: true }, "canvas-connect-1");
    assert.equal(connected.payload.ok, true);
    assert.deepEqual(permission.scripts.map((script) => script.matches), [[`${newOrigin}/*`], [`${newOrigin}/*`]]);
    assert.ok(!permission.calls.registered.some((script) => script.matches.includes("https://*/*")));
    assert.deepEqual((await area.get("sync", "custom_domain")).custom_domain, [newOrigin]);
    assert.deepEqual(permission.calls.remove, [{ origins: [`${oldOrigin}/*`] }]);

    const verified = await extensionRequest(service, "CANVAS_ACCOUNT_VERIFY", {
        origin: newOrigin, account_id: "canvas-user-1", display_name: "Canvas User", user_gesture: true
    }, "canvas-verify-1");
    assert.equal(verified.payload.ok, true);
    assert.deepEqual((await area.get("local", "platform.accountMetadata"))["platform.accountMetadata"].accounts[0], {
        origin: newOrigin, accountId: "canvas-user-1", displayName: "Canvas User", verifiedAt: verified.payload.account.verifiedAt
    });

    const removed = await extensionRequest(service, "SETTINGS_UPDATE", { area: "sync", changes: { custom_domain: [] }, user_gesture: true }, "canvas-remove-1");
    assert.equal(removed.payload.ok, true);
    assert.equal(permission.scripts.length, 0);
    assert.deepEqual(permission.calls.remove, [{ origins: [`${oldOrigin}/*`] }, { origins: [`${newOrigin}/*`] }]);
    assert.deepEqual((await area.get("sync", "custom_domain")).custom_domain, []);
});

test("custom domain browser support is isolated from static Emory Canvas", async () => {
    const unsupported = permissionChrome({ permission: true, scripting: false });
    const area = storage.createMemoryStorage({ sync: {}, local: {}, session: {} });
    const service = router.createRouter({ chromeApi: unsupported.chromeApi, storage: area, transport: {}, canvasRegistration: canvasRegistration.createCanvasRegistration({ chromeApi: unsupported.chromeApi }) });
    const custom = await extensionRequest(service, "SETTINGS_UPDATE", { area: "sync", changes: { custom_domain: ["https://custom.canvas.example.edu"] }, user_gesture: true }, "canvas-unsupported-1");
    assert.equal(custom.payload.code, "browser_unsupported");
    assert.deepEqual(await area.get("sync", ["custom_domain"]), {});
    const emory = await extensionRequest(service, "SETTINGS_UPDATE", { area: "sync", changes: { custom_domain: ["https://canvas.emory.edu"] }, user_gesture: true }, "canvas-emory-1");
    assert.equal(emory.payload.ok, true);
    assert.deepEqual((await area.get("sync", "custom_domain")).custom_domain, ["https://canvas.emory.edu"]);
});

test("popup custom-domain implementation has one explicit exact request site and no startup permission request", () => {
    const source = fs.readFileSync(path.join(__dirname, "../../js/diagnostics-transport.js"), "utf8");
    assert.match(source, /permissionCall\("request", \{ origins: \[pattern\(origin\)\] \}, chromeApi\)/);
    assert.ok(source.includes('action.addEventListener("click", () => saveCustomCanvasDomain().catch(() => {}));'));
    assert.ok(!source.includes('permissions.request({ origins: ["https://*/*"] })'));
    assert.ok(source.includes('operation: "register"'));
    assert.ok(source.includes('canvas_transaction: "persist_only"'));
});

test("Nest producer capability fields survive transport, identity, coordinator, and popup gates", async () => {
    const producer = { calendar_integration: true, calendar_read: true, calendar_upload: true, calendar_projection: true, calendar_two_way_writeback: true, calendar_mirroring: false };
    const safe = await transport.responseFromFetch(response(200, { identity: 'fixture-user', authenticated: true, capabilities: producer }));
    const popup = require('../../js/popup-controller.js');
    const coordinator = require('../../js/platform/connection-coordinator.js').create({ readIdentity: async () => safe, normalizeIdentity: popup.normalizeIdentityResponse });
    const snapshot = await coordinator.refresh();
    assert.deepEqual(snapshot.capabilities, producer);
    const source = fs.readFileSync(path.join(__dirname, '../../js/popup.js'), 'utf8');
    const normalize = source.slice(source.indexOf('function popupCalendarNormalizeCapabilities('), source.indexOf('function popupCalendarConnectionBinding('));
    const ctx = vm.createContext({ isPlainObject: security.isPlainObject, value: snapshot.capabilities, flags: {...contract.normalizeFeatureFlags(undefined), mutation:true} });
    vm.runInContext(normalize, ctx);
    const result = JSON.parse(vm.runInContext('JSON.stringify(popupCalendarNormalizeCapabilities(value, flags))', ctx));
    assert.deepEqual(result, {upload:true,projection:true,overlay:true,replacement:false,mutation:true,mirroring:false});
    assert.equal(vm.runInContext('popupCalendarNormalizeCapabilities(value, {...flags, upload:false}).upload', ctx), false);
    assert.equal(vm.runInContext('popupCalendarNormalizeCapabilities({...value, calendar_upload:false}, flags).upload', ctx), false);
    coordinator.dispose();
});
