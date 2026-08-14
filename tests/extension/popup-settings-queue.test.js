"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const popup = require("../../js/popup-controller.js");

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((nextResolve, nextReject) => {
        resolve = nextResolve;
        reject = nextReject;
    });
    return { promise, resolve, reject };
}

function fakeTimers() {
    let nextId = 0;
    const timers = new Map();
    return {
        timers,
        setTimer(callback) {
            const id = ++nextId;
            timers.set(id, callback);
            return id;
        },
        clearTimer(id) {
            timers.delete(id);
        },
        runNext() {
            const next = timers.entries().next();
            if (next.done) return false;
            timers.delete(next.value[0]);
            next.value[1]();
            return true;
        }
    };
}

function storeWith(overrides = {}) {
    const clock = fakeTimers();
    const calls = [];
    const values = { first: "old-first", second: "old-second", good: "old-good", bad: "old-bad" };
    const store = popup.createSettingsStore({
        debounceMs: 50,
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
        read: async (keys) => Object.fromEntries(keys.filter((key) => Object.prototype.hasOwnProperty.call(values, key)).map((key) => [key, values[key]])),
        sendUpdate: async (changes) => {
            calls.push(changes);
            Object.assign(values, changes);
            return { ok: true, changed: Object.keys(changes) };
        },
        ...overrides
    });
    return { store, clock, calls, values };
}

test("popup runtime has canonical sync and local settings-store initializations", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "../../js/popup.js"), "utf8");
    assert.equal((source.match(/\bcreateSettingsStore\s*\(/g) || []).length, 2);
    assert.match(source, /settingsStore:\s*popupSettingsStore/);
    assert.match(source, /popupPlatformRequest\("SETTINGS_UPDATE", \{ area: "local", changes \}\)/);
    assert.match(source, /canvas_sync_opt_in:\s*\(value\)\s*=>\s*settingsSchema\.normalizeCanvasSyncOptIn/);
});

test("writes arriving during an in-flight batch are drained in the next loop", async () => {
    const gate = deferred();
    let callCount = 0;
    const { store, calls } = storeWith({
        sendUpdate: async (changes) => {
            calls.push(changes);
            callCount += 1;
            if (callCount === 1) await gate.promise;
            return { ok: true, changed: Object.keys(changes) };
        }
    });
    const first = store.updateField("first", "new-first");
    const flushing = store.flush();
    await new Promise((resolve) => setImmediate(resolve));
    const second = store.updateField("second", "new-second");
    gate.resolve();
    await Promise.all([first, second, flushing]);
    assert.deepEqual(calls, [{ first: "new-first" }, { second: "new-second" }]);
});

test("overlapping same-key writes settle both callers and preserve newest value", async () => {
    const gate = deferred();
    let callCount = 0;
    const { store, calls } = storeWith({
        sendUpdate: async (changes) => {
            calls.push(changes);
            callCount += 1;
            if (callCount === 1) await gate.promise;
            return { ok: true, changed: Object.keys(changes) };
        }
    });
    const first = store.updateField("first", "first-value");
    const flushing = store.flush();
    await new Promise((resolve) => setImmediate(resolve));
    const newest = store.updateField("first", "newest-value");
    gate.resolve();
    await Promise.all([first, newest, flushing]);
    assert.deepEqual(calls, [{ first: "first-value" }, { first: "newest-value" }]);
});

test("partial batch failure settles callers and rolls back only failed keys", async () => {
    const rollbacks = [];
    const { store, calls } = storeWith({
        onRollback: (key, value) => rollbacks.push([key, value]),
        sendUpdate: async (changes) => {
            calls.push(changes);
            return { ok: false, results: { good: { ok: true }, bad: { ok: false, code: "BAD_KEY" } } };
        }
    });
    const good = store.updateField("good", "new-good");
    const bad = store.updateField("bad", "new-bad");
    const flushed = store.flush();
    await assert.doesNotReject(good);
    await assert.rejects(bad, (error) => error.code === "BAD_KEY");
    await assert.rejects(flushed, (error) => error.code === "SETTINGS_FLUSH_FAILED" && error.errors.length === 1);
    assert.deepEqual(calls, [{ good: "new-good", bad: "new-bad" }]);
    assert.deepEqual(rollbacks, [["bad", "old-bad"]]);
});

test("transport throw rejects only its batch and later queued writes still succeed", async () => {
    const gate = deferred();
    let callCount = 0;
    const { store, calls } = storeWith({
        sendUpdate: async (changes) => {
            calls.push(changes);
            callCount += 1;
            if (callCount === 1) return gate.promise;
            return { ok: true, changed: Object.keys(changes) };
        }
    });
    const failed = store.updateField("first", "failed-first");
    const flushing = store.flush();
    await new Promise((resolve) => setImmediate(resolve));
    const later = store.updateField("second", "successful-later");
    gate.reject(new Error("transport down"));
    await assert.rejects(failed);
    await assert.doesNotReject(later);
    await assert.rejects(flushing, (error) => error.code === "SETTINGS_FLUSH_FAILED");
    assert.deepEqual(calls, [{ first: "failed-first" }, { second: "successful-later" }]);
});

test("canonical teardown flush drains all queued writes", async () => {
    const { store, clock, calls } = storeWith();
    const first = store.updateField("first", "teardown-first");
    const second = store.updateField("second", "teardown-second");
    const teardownFlush = store.flush();
    await Promise.all([first, second, teardownFlush]);
    assert.deepEqual(calls, [{ first: "teardown-first", second: "teardown-second" }]);
    assert.equal(clock.timers.size, 0);
});

test("successful and failed callers leave no dangling timers or promises", async () => {
    const { store, clock } = storeWith({ sendUpdate: async () => { throw new Error("temporary transport failure"); } });
    const pending = store.updateField("first", "will-fail");
    const flush = store.flush();
    await assert.rejects(pending);
    await assert.rejects(flush, (error) => error.code === "SETTINGS_FLUSH_FAILED");
    assert.equal(clock.timers.size, 0);
    await store.flush();
    assert.equal(clock.timers.size, 0);
});
