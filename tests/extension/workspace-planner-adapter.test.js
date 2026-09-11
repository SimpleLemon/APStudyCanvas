"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const planner = require("../../js/workspace-planner-adapter.js");

const ACCOUNT_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function account(overrides = {}) {
    const base = {
        canvas: { verified: true, accountKey: ACCOUNT_KEY, origin: "https://canvas.example.edu" },
        nest: {
            verified: true, identity: "nest-user-1",
            capabilities: { calendar_integration: true, calendar_read: true, calendar_projection: true, calendar_two_way_writeback: true },
            consent: [
                { version: 1, current: true, granted: true, account_key: ACCOUNT_KEY, scopes: ["ongoing_read"] },
                { version: 2, current: true, granted: true, account_key: ACCOUNT_KEY, scopes: ["personal_events_write"] }
            ]
        }
    };
    return { ...base, ...overrides, canvas: { ...base.canvas, ...(overrides.canvas || {}) }, nest: { ...base.nest, ...(overrides.nest || {}) } };
}

function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
}

function personal(overrides = {}) {
    return { event_ref: "user:event-1", source_type: "user", editable: true, title: "Study", start: "2026-03-08T06:00:00.000Z", end: "2026-03-08T07:00:00.000Z", ...overrides };
}

test("gating fails closed for display-only identity, missing read consent, and write permission", () => {
    assert.equal(planner.accessFor(account({ canvas: { verified: false, profile: { id: "display-only" } } })).code, "PLANNER_ACCOUNT_UNVERIFIED");
    assert.equal(planner.accessFor(account({ nest: { consent: [] } })).code, "PLANNER_READ_CONSENT_REQUIRED");
    const readOnly = account({ nest: {
        capabilities: { calendar_integration: true, calendar_read: true, calendar_projection: true, calendar_two_way_writeback: false },
        consent: [{ current: true, granted: true, account_key: ACCOUNT_KEY, scopes: ["ongoing_read"] }]
    } });
    assert.deepEqual(planner.accessFor(readOnly), { read: true, write: false, code: "PLANNER_WRITE_CONSENT_REQUIRED" });
});

test("Sunday week and month grid ranges respect timezone DST while snapping/default duration stay exact", () => {
    const spring = planner.rangeForView("2026-03-11T16:00:00.000Z", "week", "America/New_York");
    assert.equal(spring.start, "2026-03-08T05:00:00.000Z");
    assert.equal(spring.end, "2026-03-15T04:00:00.000Z");
    assert.equal((Date.parse(spring.end) - Date.parse(spring.start)) / 3600000, 167);
    const fall = planner.rangeForView("2026-11-03T16:00:00.000Z", "week", "America/New_York");
    assert.equal((Date.parse(fall.end) - Date.parse(fall.start)) / 3600000, 169);
    const grid = planner.monthGridRange("2026-09-11T12:00:00.000Z", "America/New_York");
    assert.equal(planner.localDateKey(grid.start, grid.timeZone), "2026-08-30");
    assert.equal(planner.localDateKey(grid.end, grid.timeZone), "2026-10-04");
    assert.equal(planner.snapInstant("2026-09-11T12:08:00.000Z").toISOString(), "2026-09-11T12:15:00.000Z");
    assert.deepEqual(planner.defaultTimedRange("2026-09-11T12:08:00.000Z"), { start: "2026-09-11T12:15:00.000Z", end: "2026-09-11T13:15:00.000Z" });
});

test("range reads use the exact bridge family and stale account responses cannot commit", async () => {
    let live = account();
    const pending = deferred();
    const calls = [];
    const adapter = planner.createPlannerAdapter({ getAccount: () => live, timeZone: "UTC", send: (type, payload) => { calls.push({ type, payload }); return pending.promise; } });
    const loading = adapter.loadRange({ anchor: "2026-09-11T12:00:00.000Z", view: "day" });
    assert.equal(calls[0].type, "NEST_CALENDAR_RANGE_GET");
    assert.deepEqual(calls[0].payload, { start: "2026-09-11T00:00:00.000Z", end: "2026-09-12T00:00:00.000Z" });
    live = account({ canvas: { accountKey: "a".repeat(64) } });
    pending.resolve({ ok: true, events: [{ title: "Wrong account" }], sources: [] });
    await loading;
    assert.deepEqual(adapter.snapshot().events, []);
});

test("permission loss retains the draft, account switches stay stale, and Canvas deadlines are immutable", async () => {
    let live = account();
    const pending = deferred();
    const calls = [];
    const adapter = planner.createPlannerAdapter({ getAccount: () => live, send: (type, payload) => { calls.push({ type, payload }); return pending.promise; } });
    const canvasDeadline = { event_ref: "canvas:assignment-1", source_type: "canvas", editable: false };
    assert.deepEqual(await adapter.moveEvent(canvasDeadline, "2026-09-11T12:00:00.000Z", "2026-09-11T13:00:00.000Z"), { ok: false, code: "PLANNER_PERSONAL_EVENT_REQUIRED" });
    assert.deepEqual(await adapter.resizeEvent(personal(), "2026-03-08T05:00:00.000Z"), { ok: false, code: "PLANNER_RANGE_INVALID" });
    assert.equal(calls.length, 0);
    const writing = adapter.updateEvent(personal(), { title: "Moved safely" }, { draftId: "edit-1" });
    live = account({ nest: {
        capabilities: { calendar_integration: true, calendar_read: true, calendar_projection: true, calendar_two_way_writeback: false }
    } });
    pending.resolve({ ok: true, contractVersion: 1, event: personal({ title: "Moved safely" }) });
    assert.deepEqual(await writing, { ok: false, code: "PLANNER_WRITE_CONSENT_REQUIRED" });
    assert.equal(adapter.snapshot().drafts["edit-1"].title, "Moved safely");

    const denied = await adapter.createEvent({ title: "Retain me", start: "2026-09-11T12:00:00.000Z", end: "2026-09-11T13:00:00.000Z" }, { draftId: "create-1" });
    assert.equal(denied.ok, false);
    assert.equal(adapter.snapshot().drafts["create-1"].title, "Retain me");
});

test("refreshing after an account switch clears account-bound planner state", async () => {
    let live = account();
    const adapter = planner.createPlannerAdapter({
        getAccount: () => live,
        send: async () => ({ ok: true, events: [personal()], sources: [{ id: "main" }] })
    });
    await adapter.loadRange({ anchor: "2026-09-11T12:00:00.000Z", view: "day" });
    assert.equal(adapter.snapshot().events.length, 1);
    live = account({ canvas: { accountKey: "a".repeat(64) } });
    const refreshed = adapter.refreshAccess();
    assert.deepEqual(refreshed.events, []);
    assert.deepEqual(refreshed.sources, []);
    assert.equal(refreshed.range, null);
});

test("personal mutations expose exact bridge families and failed server drafts are retained", async () => {
    const calls = [];
    const responses = [{ ok: true, contractVersion: 1 }, { ok: false, code: "SERVER_DOWN" }, { ok: true, contractVersion: 1 }];
    const adapter = planner.createPlannerAdapter({ getAccount: account, send: async (type, payload) => { calls.push({ type, payload }); return responses.shift(); } });
    assert.equal((await adapter.createEvent({ title: "Block", start: "2026-09-11T12:00:00.000Z", end: "2026-09-11T13:00:00.000Z" })).ok, true);
    assert.equal((await adapter.updateEvent(personal(), { title: "Keep draft" }, { draftId: "failed-edit" })).ok, false);
    assert.equal((await adapter.deleteEvent(personal())).ok, true);
    assert.deepEqual(calls.map((call) => call.type), ["NEST_CALENDAR_EVENT_CREATE", "NEST_CALENDAR_EVENT_UPDATE", "NEST_CALENDAR_EVENT_DELETE"]);
    assert.equal(calls[1].payload.event_id, "user:event-1");
    assert.equal(adapter.snapshot().drafts["failed-edit"].title, "Keep draft");
});

test("explicit import deduplicates, retains originals, creates separate personal blocks, and reports partial failures", async () => {
    const calls = [];
    let attempt = 0;
    const ledger = new Set(["canvas:already"]);
    const adapter = planner.createPlannerAdapter({
        getAccount: account,
        importLedger: { has: async (key) => ledger.has(key), add: async (key) => ledger.add(key) },
        send: async (type, payload) => { calls.push({ type, payload }); attempt += 1; return attempt === 2 ? { ok: false, code: "CREATE_FAILED" } : { ok: true, contractVersion: 1, event: personal() }; }
    });
    const originals = [
        { event_ref: "canvas:one", source_type: "canvas", title: "Due one", start: "2026-09-11T12:08:00.000Z", end: "2026-09-11T12:09:00.000Z" },
        { event_ref: "canvas:one", source_type: "canvas", title: "Duplicate", start: "2026-09-11T12:08:00.000Z", end: "2026-09-11T12:09:00.000Z" },
        { event_ref: "canvas:already", source_type: "canvas", title: "Already", start: "2026-09-11T12:08:00.000Z", end: "2026-09-11T12:09:00.000Z" },
        { event_ref: "canvas:two", source_type: "canvas", title: "Due two", start: "2026-09-11T14:02:00.000Z", end: "2026-09-11T14:03:00.000Z" }
    ];
    const result = await adapter.importEvents(originals, { calendar_id: "main" });
    assert.deepEqual(result.originals, originals);
    assert.equal(calls.length, 2);
    assert.equal(calls.every((call) => call.type === "NEST_CALENDAR_EVENT_CREATE"), true);
    assert.deepEqual({ start: calls[0].payload.start, end: calls[0].payload.end }, { start: "2026-09-11T12:15:00.000Z", end: "2026-09-11T13:15:00.000Z" });
    assert.equal(result.results.filter((item) => item.skipped).length, 2);
    assert.equal(result.results.at(-1).code, "CREATE_FAILED");
    assert.equal(adapter.snapshot().drafts["import:canvas:two"].title, "Due two");
    assert.equal(ledger.has("canvas:one"), true);
    assert.equal(ledger.has("canvas:two"), false);
});

test("filters are immutable UI-ready state over source, kind, and completion", async () => {
    const adapter = planner.createPlannerAdapter({
        getAccount: account,
        send: async () => ({ ok: true, events: [
            { title: "Canvas due", source_type: "canvas", source_label: "Canvas", completed: false },
            { title: "Done block", source_type: "user", calendar_id: "main", completed: true }
        ], sources: [{ id: "main", label: "Main" }] })
    });
    await adapter.loadRange({ anchor: "2026-09-11T12:00:00.000Z", view: "day" });
    const state = adapter.setFilters({ kinds: ["canvas"], showCompleted: false });
    assert.deepEqual(state.visibleEvents.map((event) => event.title), ["Canvas due"]);
    assert.throws(() => state.filters.kinds.push("user"));
});
