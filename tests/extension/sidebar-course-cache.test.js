"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const cacheApi = require("../../js/content/sidebar-course-cache.js");

function memoryStorage(initial = {}) {
    const store = { ...initial };
    return {
        store,
        async get(key) { return store[key] === undefined ? {} : { [key]: store[key] }; },
        async set(key, value) { store[key] = value; }
    };
}

function courses(count, offset = 0) {
    return Array.from({ length: count }, (_, index) => ({
        id: String(offset + index + 1),
        name: `Course ${offset + index + 1}`,
        href: `https://canvas.emory.edu/courses/${offset + index + 1}`
    }));
}

function clock(start = 1_000_000) {
    return { current: start };
}

test("the course cache serves a fresh read after a successful write", async () => {
    const storage = memoryStorage();
    const time = clock();
    const cache = cacheApi.createSidebarCourseCache({ storage, now: () => time.current });
    assert.deepEqual(await cache.read({ origin: "https://canvas.emory.edu" }), null, "a cold cache reads as nothing");

    const written = courses(3);
    assert.equal(await cache.write({ origin: "https://canvas.emory.edu", userId: "101", courses: written }), true);
    const fresh = await cache.read({ origin: "https://canvas.emory.edu", userId: "101" });
    assert.equal(fresh.fresh, true);
    assert.equal(fresh.stale, false);
    assert.equal(fresh.savedAt, time.current);
    assert.deepEqual(fresh.courses, written);
    const persisted = storage.store[cacheApi.STORAGE_KEY];
    assert.equal(persisted.version, cacheApi.CACHE_VERSION);
    assert.equal(Object.values(persisted.entries)[0].origin, "https://canvas.emory.edu", "the stored entry keeps its own origin, never a reusable account id");
    assert.equal(await cache.clear(), undefined);
    assert.deepEqual(storage.store[cacheApi.STORAGE_KEY], null);
    assert.deepEqual(await cache.read({ origin: "https://canvas.emory.edu", userId: "101" }), null);
});

test("the course cache distinguishes stale-while-revalidate from expired entries", async () => {
    const storage = memoryStorage();
    const time = clock();
    const cache = cacheApi.createSidebarCourseCache({ storage, now: () => time.current });
    await cache.write({ origin: "https://canvas.emory.edu", userId: "7", courses: courses(2) });

    time.current += cacheApi.DEFAULT_TTL_MS + 1;
    const stale = await cache.read({ origin: "https://canvas.emory.edu", userId: "7" });
    assert.equal(stale.fresh, false);
    assert.equal(stale.stale, true, "inside the max age the entry stays usable as a provisional paint");
    assert.equal(stale.courses.length, 2);

    time.current += cacheApi.DEFAULT_MAX_AGE_MS;
    assert.deepEqual(await cache.read({ origin: "https://canvas.emory.edu", userId: "7" }), null, "beyond the max age the entry is gone");

    time.current = 1;
    await cache.write({ origin: "https://canvas.emory.edu", userId: "7", courses: courses(1) });
    time.current = 0;
    assert.deepEqual(await cache.read({ origin: "https://canvas.emory.edu", userId: "7" }), null, "a clock that runs backwards never serves the entry");
});

test("the course cache isolates accounts and rejects collisions and bad origins", async () => {
    const storage = memoryStorage();
    const cache = cacheApi.createSidebarCourseCache({ storage, now: () => 5_000 });
    await cache.write({ origin: "https://canvas.emory.edu", userId: "101", courses: courses(2) });

    assert.deepEqual(await cache.read({ origin: "https://canvas.emory.edu", userId: "202" }), null, "another user never sees this account's courses");
    assert.equal((await cache.read({ origin: "https://canvas.emory.edu", userId: "101" })).courses.length, 2);
    assert.equal((await cache.read({ origin: "https://canvas.emory.edu" })).courses.length, 2, "an unknown user may still receive the provisional paint");
    assert.equal((await cache.read({ origin: "https://canvas.emory.edu", userId: null })).courses.length, 2);

    // A hash collision must not serve another origin's courses. A fresh cache
    // instance reads the mutated blob, since an already-loaded cache trusts its
    // memory copy.
    const collided = cacheApi.hashContext("https://canvas.emory.edu");
    storage.store[cacheApi.STORAGE_KEY] = {
        version: cacheApi.CACHE_VERSION,
        entries: { [collided]: { origin: "https://evil.example", userId: "101", savedAt: 5_000, courses: courses(1, 50) } }
    };
    assert.deepEqual(await cacheApi.createSidebarCourseCache({ storage, now: () => 5_000 }).read({ origin: "https://canvas.emory.edu", userId: "101" }), null, "collision entries are rejected on read");

    for (const origin of ["http://canvas.emory.edu", "not a url", "", null, "javascript:alert(1)"]) {
        assert.equal(await cache.write({ origin, courses: courses(1) }), false, `origin ${String(origin)} is never cached`);
        assert.deepEqual(await cache.read({ origin }), null);
    }
    assert.equal(await cache.write({ origin: "https://canvas.emory.edu", courses: [] }), false, "empty course lists are never cached");
    assert.equal(await cache.write({ origin: "https://canvas.emory.edu", courses: [{ id: "x", name: "Biology", href: "http://insecure/x" }] }), false, "non-https hrefs are dropped, leaving nothing to cache");
});

test("the course cache bounds entries, course lists, and byte size", async () => {
    const storage = memoryStorage();
    const time = clock();
    const cache = cacheApi.createSidebarCourseCache({ storage, now: () => time.current });
    const origins = ["https://a.example", "https://b.example", "https://c.example", "https://d.example", "https://e.example"];
    for (const [index, origin] of origins.entries()) {
        time.current += 1_000;
        assert.equal(await cache.write({ origin, userId: String(index + 1), courses: courses(1, index * 10) }), true);
    }
    const blob = storage.store[cacheApi.STORAGE_KEY];
    assert.equal(Object.keys(blob.entries).length, cacheApi.DEFAULT_MAX_ENTRIES, "only the newest entries survive");
    assert.deepEqual(await cache.read({ origin: origins[0] }), null, "the oldest origin was evicted");
    assert.equal((await cache.read({ origin: origins[4], userId: "5" })).courses[0].id, "41", "the newest origin survives");

    const big = cacheApi.createSidebarCourseCache({ storage, now: () => time.current });
    const oversized = await big.read({ origin: origins[1] });
    assert.equal(oversized.courses.length <= cacheApi.DEFAULT_MAX_COURSES, true);
    assert.equal(await big.write({ origin: origins[1], courses: courses(cacheApi.DEFAULT_MAX_COURSES + 1) }), true);
    assert.equal((await big.read({ origin: origins[1] })).courses.length, cacheApi.DEFAULT_MAX_COURSES, "course lists are clamped to the product bound");

    const tiny = cacheApi.createSidebarCourseCache({ storage, maxBytes: 64, now: () => time.current });
    assert.equal(await tiny.write({ origin: "https://f.example", courses: courses(4) }), false, "a payload above the byte cap is rejected");
    assert.deepEqual(await tiny.read({ origin: "https://f.example" }), null, "a rejected write is not served from memory either");
    assert.equal(await tiny.write({ origin: "https://f.example", courses: courses(1) }), false, "even a small list cannot fit a tiny cap");
    const roomy = cacheApi.createSidebarCourseCache({ storage, now: () => time.current });
    assert.equal(await roomy.write({ origin: "https://h.example", courses: courses(1) }), true);
    assert.equal(Object.values(storage.store[cacheApi.STORAGE_KEY].entries).some((entry) => entry.origin === "https://f.example"), false, "a rejected staged entry never leaks into a later persisted write");

    const clamped = cacheApi.createSidebarCourseCache({ storage, maxEntries: 0, maxCourses: 50_000, now: () => time.current });
    assert.equal(await clamped.write({ origin: "https://g.example", courses: courses(2) }), true, "degenerate bounds clamp to safe minimums");
    assert.equal((await clamped.read({ origin: "https://g.example" })).courses.length, 2);
});
