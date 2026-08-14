"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const contract = require("../../js/platform/contract.js");
const storage = require("../../js/platform/storage.js");
const transport = require("../../js/platform/transport.js");
const router = require("../../js/platform/router.js");

const ORIGIN = "https://canvas.example.edu";
const ACCOUNT_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const START = "2026-01-01T00:00:00.000Z";
const END = "2026-02-01T00:00:00.000Z";
const RANGE = { start: START, end: END };
const SOURCE = {
    source_ref: "src1:calendar-range",
    source_key: `canvas:${ACCOUNT_KEY}`,
    origin: ORIGIN,
    nest_user_id: "nest-user-1",
    provider_user_id: "canvas-user",
    label: "Canvas",
    active: true,
    archived: false,
    routing_eligible: true
};

function extensionChrome() {
    return { runtime: { getURL: (value) => `chrome-extension://test-id/${String(value).replace(/^\//, "")}` } };
}

function response(status, body = {}, headers = { "content-type": "application/json" }) {
    const normalized = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { forEach(callback) { Object.entries(normalized).forEach(([key, value]) => callback(value, key)); } },
        async text() { return typeof body === "string" ? body : JSON.stringify(body); }
    };
}

function rangeBody(overrides = {}) {
    return {
        contractVersion: 1,
        ok: true,
        events: [{
            title: "Read safely",
            start: START,
            end: "2026-01-01T01:00:00.000Z",
            all_day: false,
            timed: true,
            multi_day: false,
            source_label: "Canvas",
            source_color: "#123456",
            completion_style: "incomplete",
            completed: false,
            read_only: true,
            description: "Plain text",
            source_url: `${ORIGIN}/courses/1/calendar_events/2`,
            recurrence: { state: "supported", read_only: true, supported: true },
            capabilities: { read_only: true, recurrence: "supported", mutation: "disabled" },
            event_id: "provider-event-secret",
            user_id: "provider-user-secret",
            account_id: "account-secret",
            provider_id: "provider-secret",
            internal_id: "internal-secret",
            private_url: "https://private.example/secret",
            unsafe_html: "<img src=x onerror=alert(1)>",
            token: "should-drop"
        }],
        sources: [{ label: "Canvas", color: "#123456", source_url: `${ORIGIN}/calendar`, source_id: "drop" }],
        counts: { total: 1, visible: 1, completed: 0, timed: 1, all_day: 0, user_id: "drop" },
        refresh: { state: "fresh", stale: false, last_refreshed_at: START, internal_id: "drop" },
        ...overrides,
        user_id: "drop-top-level",
        unknown: { provider_account_id: "drop" }
    };
}

function makeArea({ flags = { projection: true, overlay: true }, accountMetadata = { version: 1, accounts: [{ origin: ORIGIN, accountId: "canvas-account", accountKey: ACCOUNT_KEY }] }, source = SOURCE } = {}) {
    return storage.createMemoryStorage({
        sync: { custom_domain: [ORIGIN] },
        local: { "platform.flags": flags, "platform.accountMetadata": accountMetadata, "platform.sourceMetadata": { version: 1, accounts: { [ACCOUNT_KEY]: source } } },
        session: {}
    });
}

function makeTransport(body = rangeBody()) {
    const calls = [];
    const api = {
        calls,
        identityGet: async (options) => { calls.push({ kind: "identity", options }); return { ok: true, body: { authenticated: true, state: "authenticated", account_key: ACCOUNT_KEY } }; },
        request: async (request, options) => {
            calls.push({ kind: "request", request, options });
            if (request.path.startsWith("/api/extension/consent?")) return { ok: true, body: { version: 1, current: true, granted: true, account_key: ACCOUNT_KEY, source_key: `canvas:${ACCOUNT_KEY}`, scopes: ["full_history_upload", "ongoing_read", "shares_ics_inclusion"] } };
            return { ok: true, status: 200, body };
        },
        mutate: async () => { throw new Error("MUTATION_MUST_NOT_RUN"); },
        sanitizeCalendarRangeResponse: transport.sanitizeCalendarRangeResponse
    };
    return api;
}

test("calendar range contract is exact, strict, bounded, and versioned", () => {
    assert.equal(contract.MESSAGE_FAMILIES.includes("NEST_CALENDAR_RANGE_GET"), true);
    assert.deepEqual(contract.validateCalendarRangePayload(RANGE).value, { start: START, end: END, version: 1 });
    assert.equal(contract.CALENDAR_RANGE_MAX_DAYS, 62);
    for (const payload of [
        { start: START, end: END, extra: true },
        { start: "2026-01-01", end: END },
        { start: END, end: START },
        { start: START, end: "2026-04-01T00:00:00.000Z" },
        { start: START, end: END, version: 1 }
    ]) assert.equal(contract.validateCalendarRangePayload(payload).ok, false);
    assert.equal(contract.buildCalendarRangePath(START, END), "/api/calendar/events?start=2026-01-01T00%3A00%3A00.000Z&end=2026-02-01T00%3A00%3A00.000Z");
});

test("transport permits only the canonical calendar path and returns no-store for direct and tab fallback", async () => {
    const path = contract.buildCalendarRangePath(START, END);
    assert.deepEqual(transport.validateTransportRequest({ method: "GET", path }).path, path);
    for (const invalid of [
        "/api/calendar/events?end=2026-02-01T00%3A00%3A00.000Z&start=2026-01-01T00%3A00%3A00.000Z",
        `${path}&extra=x`,
        "/api/calendar/events?start=2026-01-01T00%3A00%3A00Z&end=2026-02-01T00%3A00%3A00.000Z",
        "/api/calendar/events?start=2026-01-01T00%3A00%3A00.000Z&end=2026-04-01T00%3A00%3A00.000Z",
        "/api/calendar/other?start=x&end=y"
    ]) assert.throws(() => transport.validateTransportRequest({ method: "GET", path: invalid }), /NEST_PATH_METHOD_NOT_ALLOWLISTED/);

    let direct;
    const directNest = transport.createNestTransport({ fetchImpl: async (url, options) => { direct = { url, options }; return response(200, rangeBody()); } });
    const directResult = await directNest.request({ method: "GET", path }, { requestId: "range-direct" });
    assert.equal(direct.url, `https://nest.apstudy.org${path}`);
    assert.equal(direct.options.cache, "no-store");
    assert.equal(directResult.cache, "no-store");
    assert.deepEqual(directResult.body.events[0], {
        title: "Read safely", start: START, end: "2026-01-01T01:00:00.000Z", all_day: false, timed: true, multi_day: false,
        source_label: "Canvas", source_color: "#123456", completion_style: "incomplete", completed: false, read_only: true,
        description: "Plain text", source_url: `${ORIGIN}/courses/1/calendar_events/2`, recurrence: { state: "supported", read_only: true, supported: true },
        capabilities: { read_only: true, recurrence: "supported", mutation: "disabled" }
    });
    assert.equal(Object.prototype.hasOwnProperty.call(directResult.body, "user_id"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(directResult.body.events[0], "event_id"), false);

    let bridged;
    const tabNest = transport.createNestTransport({
        fetchImpl: async () => { throw new TypeError("offline"); },
        findExactNestTab: async () => ({ id: 7, url: "https://nest.apstudy.org/calendar" }),
        sendToTab: async (_tab, message) => { bridged = message; return { kind: "APSTUDYCANVAS_NEST_BRIDGE_RESPONSE", version: 1, request_id: message.request_id, ok: true, status: 200, headers: { "content-type": "application/json" }, body: rangeBody() }; }
    });
    const tabResult = await tabNest.request({ method: "GET", path }, { requestId: "range-tab" });
    assert.equal(bridged.request.path, path);
    assert.equal(bridged.request.method, "GET");
    assert.equal(tabResult.transport, "tab");
    assert.equal(tabResult.cache, "no-store");
});

test("range router gates sender, page, binding, identity, consent, flags, and never mutates or persists payloads", async () => {
    const area = makeArea();
    const nest = makeTransport();
    const service = router.createRouter({ chromeApi: extensionChrome(), storage: area, transport: nest, fullscreen: {} });
    const message = contract.createEnvelope("NEST_CALENDAR_RANGE_GET", RANGE, "range-router");
    const canvas = { url: `${ORIGIN}/calendar?view=month` };
    const result = await service.handle(message, canvas);
    assert.equal(result.payload.ok, true);
    assert.equal(result.payload.events[0].source_url.startsWith(ORIGIN), true);
    assert.equal(nest.calls.filter((call) => call.kind === "request").length, 2);
    assert.equal(nest.calls.at(-1).request.path, contract.buildCalendarRangePath(START, END));
    assert.equal(nest.calls.at(-1).options.requestId, "range-router");
    assert.equal(nest.calls.some((call) => call.kind === "mutate"), false);
    assert.deepEqual((await area.get("local", "platform.sanitizedErrors"))["platform.sanitizedErrors"], undefined);

    for (const sender of [
        { url: "chrome-extension://test-id/popup.html" },
        { url: `${ORIGIN}/courses/1` },
        { url: "https://canvas.example.edu.evil.test/calendar" },
        { url: `${ORIGIN}/calendar#spoof` }
    ]) {
        const rejected = await service.handle(message, sender);
        assert.equal(rejected.payload.ok, false);
        assert.match(rejected.payload.code, /(?:SENDER_CANVAS|SENDER_NOT_ALLOWED)/);
    }

    for (const flags of [{ projection: false, overlay: true }, { projection: true, overlay: false }, { projection: false, overlay: false }]) {
        const gated = router.createRouter({ chromeApi: extensionChrome(), storage: makeArea({ flags }), transport: makeTransport(), fullscreen: {} });
        const rejected = await gated.handle(message, canvas);
        assert.match(rejected.payload.code, /FEATURE_DISABLED_(?:PROJECTION|OVERLAY)/);
    }
});

test("range router safely handles signed out, expired, unavailable, version skew, and unsafe source links", async () => {
    for (const identity of [
        { authenticated: false, state: "signed_out" },
        { authenticated: false, state: "expired" }
    ]) {
        const nest = makeTransport();
        nest.identityGet = async () => ({ ok: true, body: identity });
        const service = router.createRouter({ chromeApi: extensionChrome(), storage: makeArea(), transport: nest, fullscreen: {} });
        const result = await service.handle(contract.createEnvelope("NEST_CALENDAR_RANGE_GET", RANGE, `identity-${identity.state}`), { url: `${ORIGIN}/calendar` });
        assert.equal(result.payload.code, identity.state === "signed_out" ? "NEST_SIGNED_OUT" : "NEST_SESSION_EXPIRED");
    }
    for (const body of [{ contractVersion: 2, ok: true, events: [] }, { contractVersion: 1, ok: true, events: [] }]) {
        const nest = makeTransport(body);
        if (body.contractVersion === 1) nest.request = async (request) => request.path.startsWith("/api/extension/consent?")
            ? { ok: true, body: { version: 1, current: true, granted: true, account_key: ACCOUNT_KEY, source_key: `canvas:${ACCOUNT_KEY}`, scopes: ["full_history_upload", "ongoing_read", "shares_ics_inclusion"] } }
            : { ok: true, status: 503, body: { state: "unavailable" } };
        else nest.request = async (request) => request.path.startsWith("/api/extension/consent?")
            ? { ok: true, body: { version: 1, current: true, granted: true, account_key: ACCOUNT_KEY, source_key: `canvas:${ACCOUNT_KEY}`, scopes: ["full_history_upload", "ongoing_read", "shares_ics_inclusion"] } }
            : { ok: true, status: 200, body };
        const service = router.createRouter({ chromeApi: extensionChrome(), storage: makeArea(), transport: nest, fullscreen: {} });
        const result = await service.handle(contract.createEnvelope("NEST_CALENDAR_RANGE_GET", RANGE, `response-${body.contractVersion}`), { url: `${ORIGIN}/calendar` });
        assert.equal(result.payload.code, body.contractVersion === 2 ? "NEST_CALENDAR_RANGE_VERSION_UNSUPPORTED" : "NEST_UNAVAILABLE");
    }
    const sanitizer = transport.sanitizeCalendarRangeResponse(rangeBody({ events: [{ title: "<script>x</script>", start: START, end: END, source_url: "https://evil.example/private" }] }), { allowedCanvasOrigins: [ORIGIN] });
    assert.deepEqual(sanitizer.events, []);
});
