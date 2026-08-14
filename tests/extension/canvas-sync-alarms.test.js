"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createCanvasSyncAlarms } = require("../../js/platform/canvas-sync-alarms.js");

const binding = Object.freeze({ sourceId: "source-a/opaque", runId: "run-a?opaque", generation: 7 });
const rawIdentifiers = [binding.sourceId, binding.runId];
const summaryRef = "summary-ref-7";

function hashKey(value) {
    return Buffer.from(String(value)).toString("hex").slice(0, 64);
}

function fake({ available = true, clock = () => 1000000, summaryStore } = {}) {
    const calls = [];
    const index = new Map();
    const alarms = available ? {
        async create(name, info) { calls.push(["create", name, info]); },
        async clear(name) { calls.push(["clear", name]); return true; }
    } : undefined;
    const runIndex = {
        async set(ref, safeRef) { calls.push(["set", ref, safeRef]); index.set(ref, safeRef); },
        async get(ref) { calls.push(["get", ref]); return index.get(ref) || null; },
        async remove(ref) { calls.push(["remove", ref]); index.delete(ref); }
    };
    return { api: createCanvasSyncAlarms({ alarms, runIndex, summaryStore, hashKey, clock }), calls, index };
}

function nameFromCreate(calls) {
    return calls.find((call) => call[0] === "create")[1];
}

test("absent alarms pause without creating timers", async () => {
    const fakeApi = fake({ available: false });
    assert.equal(fakeApi.api.available, false);
    assert.deepEqual(fakeApi.api.schedule(binding, 1), { state: "paused", errorCode: "alarms_unavailable" });
    assert.deepEqual(fakeApi.calls, []);
});

test("schedule uses an exact opaque alarm name and never exposes binding identifiers", async () => {
    const fakeApi = fake();
    assert.deepEqual(await fakeApi.api.schedule(binding, 120000, summaryRef), { state: "scheduled" });
    const name = nameFromCreate(fakeApi.calls);
    assert.match(name, /^aps-canvas-sync:[A-Za-z0-9_-]{1,128}$/);
    assert.equal(name.startsWith("aps-canvas-sync:aps-canvas-sync:"), false);
    rawIdentifiers.forEach((identifier) => assert.equal(name.includes(identifier), false));
    assert.equal(JSON.stringify(fakeApi.calls).includes("sourceId"), false);
    assert.equal(JSON.stringify(fakeApi.calls).includes("runId"), false);
    assert.equal(JSON.stringify(fakeApi.calls).includes("generation"), false);
    assert.equal(fakeApi.calls[0][0], "set");
    assert.equal(fakeApi.calls[0][2], summaryRef);
    assert.equal(fakeApi.calls[1][0], "create");
    assert.deepEqual(fakeApi.calls[1][2], { when: 1120000 });
});

test("schedule clamps delays to one through five minutes", async () => {
    const fakeApi = fake({ clock: () => 5000 });
    await fakeApi.api.schedule(binding, 1, summaryRef);
    await fakeApi.api.schedule(binding, 999999999, summaryRef);
    const creates = fakeApi.calls.filter((call) => call[0] === "create");
    assert.equal(creates[0][2].when, 65000);
    assert.equal(creates[1][2].when, 305000);
});

test("consume accepts only exact alarm names and is one-shot", async () => {
    const fakeApi = fake();
    await fakeApi.api.schedule(binding, 60000, summaryRef);
    const name = nameFromCreate(fakeApi.calls);
    assert.equal(await fakeApi.api.consume({ name: "foreign:" + name }), null);
    assert.equal(await fakeApi.api.consume({ name: `${name}:extra` }), null);
    assert.equal(await fakeApi.api.consume({ name }), summaryRef);
    assert.equal(await fakeApi.api.consume({ name }), null);
    assert.equal(fakeApi.index.size, 0);
});

test("cancel clears the exact alarm before removing its index", async () => {
    const fakeApi = fake();
    await fakeApi.api.schedule(binding, 60000, summaryRef);
    const name = nameFromCreate(fakeApi.calls);
    assert.deepEqual(await fakeApi.api.cancel(binding), { state: "cancelled" });
    const actions = fakeApi.calls.slice(2).map((call) => call[0]);
    assert.deepEqual(actions, ["clear", "remove"]);
    assert.equal(fakeApi.calls[2][1], name);
    assert.equal(fakeApi.index.size, 0);
});

test("duplicate scheduling replaces the same opaque index across adapter restarts", async () => {
    const first = fake();
    await first.api.schedule(binding, 60000, summaryRef);
    const restarted = createCanvasSyncAlarms({ alarms: first.api.available ? {
        async create(name, info) { first.calls.push(["create-restarted", name, info]); },
        async clear(name) { first.calls.push(["clear-restarted", name]); return true; }
    } : undefined, runIndex: {
        async set(ref, safeRef) { first.calls.push(["set-restarted", ref, safeRef]); first.index.set(ref, safeRef); },
        async get(ref) { return first.index.get(ref) || null; },
        async remove(ref) { first.index.delete(ref); }
    }, hashKey, clock: () => 2000000 });
    await restarted.schedule(binding, 300000, summaryRef);
    const refs = first.calls.filter((call) => call[0] === "set" || call[0] === "set-restarted").map((call) => call[1]);
    const names = first.calls.filter((call) => call[0] === "create" || call[0] === "create-restarted").map((call) => call[1]);
    assert.equal(new Set(refs).size, 1);
    assert.equal(new Set(names).size, 1);
    assert.equal(first.index.size, 1);
});

test("missing summary references are rejected without creating an alarm", async () => {
    const fakeApi = fake();
    assert.deepEqual(await fakeApi.api.schedule(binding, 60000), { state: "paused", errorCode: "summary_ref_unavailable" });
    assert.deepEqual(fakeApi.calls, []);
});

test("legacy scheduling derives a stored summary reference safely", async () => {
    const fakeApi = fake({ summaryStore: { async getRef() { return summaryRef; } } });
    assert.deepEqual(await fakeApi.api.schedule(binding, 60000), { state: "scheduled" });
    assert.equal(fakeApi.calls[0][2], summaryRef);
});

test("external failures return redacted status codes", async () => {
    const secret = "access_token=do-not-return";
    const calls = [];
    const api = createCanvasSyncAlarms({
        alarms: {
            async create() { throw new Error(secret); },
            async clear() { throw new Error(secret); }
        },
        runIndex: {
            async set() { calls.push("set"); },
            async get() { return null; },
            async remove() { calls.push("remove"); }
        },
        hashKey
    });
    const scheduled = await api.schedule(binding, 60000, summaryRef);
    const cancelled = await api.cancel(binding);
    assert.deepEqual(scheduled, { state: "paused", errorCode: "alarm_schedule_failed" });
    assert.deepEqual(cancelled, { state: "paused", errorCode: "alarm_cancel_failed" });
    assert.equal(JSON.stringify([scheduled, cancelled, calls]).includes(secret), false);
});
