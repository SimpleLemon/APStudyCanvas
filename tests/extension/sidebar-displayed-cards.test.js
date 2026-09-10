"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const cacheApi = require("../../js/content/sidebar-displayed-cards.js");

function storageStub(initial = {}) {
    const store = { ...initial };
    return {
        store,
        async get(key) { return store[key]; },
        async set(key, value) { store[key] = value; }
    };
}

test("writes and reads the displayed subset per origin without leaking other origins", async () => {
    const storage = storageStub();
    const cache = cacheApi.createDisplayedCardCache({ storage });
    assert.equal(await cache.write({ origin: "https://canvas.emory.edu", userId: "123", courseIds: ["42", 44, "not-a-course", ""] }), true);
    const entry = await cache.read({ origin: "https://canvas.emory.edu" });
    assert.deepEqual(entry.courseIds, ["42", "44"], "only valid course ids persist");
    assert.deepEqual(await cache.read({ origin: "https://other.school.edu" }), null);
    assert.deepEqual(await cache.read({ origin: "http://canvas.emory.edu" }), null, "insecure origins never read");
});

test("entries expire past the max age and malformed payloads read as empty", async () => {
    const storage = storageStub();
    let clock = 1_000_000;
    const cache = cacheApi.createDisplayedCardCache({ storage, now: () => clock });
    await cache.write({ origin: "https://canvas.emory.edu", courseIds: ["42"] });
    clock += cacheApi.DEFAULT_MAX_AGE_MS + 1;
    assert.deepEqual(await cache.read({ origin: "https://canvas.emory.edu" }), null, "stale evidence is not served");
    storage.store[cacheApi.STORAGE_KEY] = { version: 99, entries: {} };
    assert.deepEqual(await cache.read({ origin: "https://canvas.emory.edu" }), null);
    storage.store[cacheApi.STORAGE_KEY] = "garbage";
    assert.deepEqual(await cache.read({ origin: "https://canvas.emory.edu" }), null);
});

test("a rejected storage write never leaks its staged entry into later reads", async () => {
    let clock = 5_000;
    const storage = {
        async get(key) { return this.store?.[key]; },
        async set() { throw new Error("quota exceeded"); }
    };
    const cache = cacheApi.createDisplayedCardCache({ storage, now: () => clock });
    assert.equal(await cache.write({ origin: "https://canvas.emory.edu", courseIds: ["42"] }), false);
    assert.deepEqual(await cache.read({ origin: "https://canvas.emory.edu" }), null);
    clock += 10;
    assert.deepEqual(await cache.read({ origin: "https://canvas.emory.edu" }), null);
});

test("old entries are evicted when the entry limit is exceeded", async () => {
    const storage = storageStub();
    let clock = 1_000;
    const cache = cacheApi.createDisplayedCardCache({ storage, now: () => clock, maxEntries: 2 });
    await cache.write({ origin: "https://a.example", courseIds: ["1"] });
    clock += 10;
    await cache.write({ origin: "https://b.example", courseIds: ["2"] });
    clock += 10;
    await cache.write({ origin: "https://c.example", courseIds: ["3"] });
    assert.deepEqual(await cache.read({ origin: "https://a.example" }), null, "the oldest origin's entry is evicted");
    assert.equal((await cache.read({ origin: "https://b.example" })).courseIds[0], "2");
    assert.equal((await cache.read({ origin: "https://c.example" })).courseIds[0], "3");
});
