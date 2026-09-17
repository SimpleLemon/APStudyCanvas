"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const cacheApi = require("../../js/content/todo-view-cache.js");

const ACCOUNT = "a".repeat(64);
const OTHER_ACCOUNT = "b".repeat(64);
const ORIGIN = "https://canvas.emory.edu";
const RANGE = { start: "2026-09-14", end: "2026-09-20", timeZone: "America/New_York", length: 7, inclusive: true, kind: "week" };
const SETTINGS = { todo_completion_authority: "canvas" };

function storageHarness(seed = {}) {
    const store = { ...seed };
    return {
        store,
        async get(key) { return { [key]: store[key] }; },
        async set(key, value) { store[key] = value; }
    };
}

function context(overrides = {}) {
    return {
        origin: ORIGIN,
        accountKey: ACCOUNT,
        range: RANGE,
        settingsSignature: cacheApi.settingsSignature(SETTINGS),
        ...overrides
    };
}

function task(overrides = {}) {
    return {
        id: "event-1",
        source: "canvas-planner-note",
        accountKey: ACCOUNT,
        sourceItemKey: "planner_note:42:91",
        eventRef: "event-1",
        remoteId: "91",
        sourceType: "planner_note",
        type: "planner_note",
        title: "Review chapter",
        url: "https://canvas.emory.edu/courses/42/planner_notes/91",
        course: { id: "42", name: "Biology", code: "BIOL 101", label: "BIOL 101", color: "#123456" },
        due: { kind: "date", date: "2026-09-16", timeZone: "America/New_York" },
        timezone: "America/New_York",
        priority: "normal",
        completion: false,
        mutationAuthority: "canvas_planner_note",
        mutation: { authority: "canvas_planner_note", plannerNoteId: "owned-91", submitAssignment: false },
        raw: {
            id: "91",
            plannable_id: "91",
            course_id: "42",
            todo_date: "2026-09-16",
            details: "Read pages 20-30\nAPSTUDYCANVAS_PLANNER_NOTE:marker",
            planner_note_preview: "Read pages 20-30",
            planner_note_date_mutation_blocked: false,
            access_token: "must-not-persist",
            secret_payload: { password: "must-not-persist" }
        },
        ...overrides
    };
}

function view(overrides = {}) {
    return {
        canvasTasks: [task()],
        nestTasks: [],
        courses: [{ id: "42", name: "Biology", label: "BIOL 101", color: "#123456" }],
        canvasState: "live",
        nestState: "unavailable",
        announcementState: "live",
        sourceState: { planner: { state: "live", complete: true }, announcements: { state: "live", complete: true } },
        streak: { state: "verified", current: 12, best: 20, since: "2026-08-01", remainingTasks: [] },
        ...overrides
    };
}

test("todo view cache serves fresh then provisional data and expires after ten minutes", async () => {
    let now = 1_000_000;
    const storage = storageHarness();
    const cache = cacheApi.createTodoViewCache({ storage, now: () => now });
    assert.equal(await cache.write(context(), view()), true);

    let hit = await cache.read(context());
    assert.equal(hit.fresh, true);
    assert.equal(hit.stale, false);
    assert.equal(hit.view.canvasTasks[0].title, "Review chapter");

    now += cacheApi.DEFAULT_FRESH_TTL_MS + 1;
    hit = await cache.read(context());
    assert.equal(hit.fresh, false);
    assert.equal(hit.stale, true);

    now += cacheApi.DEFAULT_MAX_AGE_MS;
    assert.equal(await cache.read(context()), null);
});

test("cache scope rejects another account, origin, range, or task-affecting settings signature", async () => {
    const storage = storageHarness();
    const cache = cacheApi.createTodoViewCache({ storage, now: () => 2_000_000 });
    await cache.write(context(), view());
    assert.equal(await cache.read(context({ accountKey: OTHER_ACCOUNT })), null);
    assert.equal(await cache.read(context({ origin: "https://other.instructure.com" })), null);
    assert.equal(await cache.read(context({ range: { ...RANGE, end: "2026-09-21" } })), null);
    assert.equal(await cache.read(context({ settingsSignature: cacheApi.settingsSignature({ todo_completion_authority: "manual" }) })), null);
});

test("cache persists only the render/action subset and drops arbitrary raw Canvas payload fields", async () => {
    const storage = storageHarness();
    const cache = cacheApi.createTodoViewCache({ storage, now: () => 3_000_000 });
    assert.equal(await cache.write(context(), view()), true);
    const hit = await cache.read(context());
    const restored = hit.view.canvasTasks[0];

    assert.equal(restored.mutationAuthority, "canvas_planner_note");
    assert.equal(restored.mutation.plannerNoteId, "owned-91");
    assert.equal(restored.raw.plannable_id, "91");
    assert.equal(restored.raw.details.includes("APSTUDYCANVAS_PLANNER_NOTE"), true, "ownership metadata required for a Planner Note mutation is retained");
    assert.equal(Object.hasOwn(restored.raw, "access_token"), false);
    assert.equal(Object.hasOwn(restored.raw, "secret_payload"), false);

    const serialized = JSON.stringify(storage.store[cacheApi.STORAGE_KEY]);
    assert.equal(serialized.includes("must-not-persist"), false);
});

test("malformed, oversized, and superseded writes fail closed", async () => {
    const malformedStorage = storageHarness({ [cacheApi.STORAGE_KEY]: { version: 999, entries: { anything: { view: view() } } } });
    const malformed = cacheApi.createTodoViewCache({ storage: malformedStorage, now: () => 4_000_000 });
    assert.equal(await malformed.read(context()), null);

    const tinyStorage = storageHarness();
    const tiny = cacheApi.createTodoViewCache({ storage: tinyStorage, maxBytes: 300, now: () => 4_000_000 });
    assert.equal(await tiny.write(context(), view({ canvasTasks: [task({ title: "x".repeat(4000) })] })), false);
    assert.equal(tinyStorage.store[cacheApi.STORAGE_KEY], undefined);

    const currentStorage = storageHarness();
    const guarded = cacheApi.createTodoViewCache({ storage: currentStorage, now: () => 4_000_000 });
    assert.equal(await guarded.write(context(), view(), { isCurrent: () => false }), false);
    assert.equal(currentStorage.store[cacheApi.STORAGE_KEY], undefined);
});
