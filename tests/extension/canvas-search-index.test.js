"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const api = require("../../js/content/canvas-search-index.js");
const { createCanvasSearchStorage } = require("./helpers/canvas-search-storage.js");

const ORIGIN = "https://canvas.example.edu";
const ACCOUNT = "student-42";

function records() {
    return [
        { id: 1, type: "assignment", title: "Read chapter one", courseId: 7, courseName: "Biology", summary: "Mitosis review", href: "/courses/7/assignments/1" },
        { id: 2, type: "file", title: "Chapter one handout", course: "Biology", href: `${ORIGIN}/courses/7/files/2` },
        { id: 3, type: "page", title: "Lab safety", course: "Chemistry", href: "/courses/8/pages/lab-safety" },
        { id: 4, type: "module", title: "Week one module", course: "Biology", href: "/courses/7/modules/4" }
    ];
}

function logicalClock() {
    const timers = new Map(); let id = 0;
    return {
        setTimeout(callback) { const timer = ++id; timers.set(timer, callback); return timer; },
        clearTimeout(timer) { timers.delete(timer); },
        fire() { const pending = [...timers.values()]; timers.clear(); pending.forEach((callback) => callback()); },
        get size() { return timers.size; }
    };
}

test("the index stores only safe same-origin display metadata and ranks every Canvas result type deterministically", async () => {
    const storage = createCanvasSearchStorage();
    const index = api.createCanvasSearchIndex({ storage, now: () => 1000 });
    assert.equal(await index.write({ origin: ORIGIN, accountId: ACCOUNT, enabled: true, items: records().concat([
        { id: "bad", type: "page", title: "<img src=x onerror=1>", href: "javascript:alert(1)" },
        { id: "evil", type: "assignment", title: "Elsewhere", href: "https://evil.example/steal" }
    ]) }), true);
    const result = await index.query({ origin: ORIGIN, accountId: ACCOUNT, enabled: true, query: "one" });
    assert.deepEqual(result.items.map((item) => item.type), ["assignment", "file", "module"]);
    assert.ok(result.items.every((item) => item.href.startsWith("/courses/")));
    assert.equal(storage.value(api.STORAGE_KEY).entries && JSON.stringify(storage.value(api.STORAGE_KEY)).includes(ACCOUNT), false, "the raw account identifier never enters local storage");
    assert.equal(JSON.stringify(storage.value(api.STORAGE_KEY)).includes("Mitosis review"), false, "content summaries never enter local storage");
    assert.equal(api.safeHref("https://evil.example", ORIGIN), null);
    assert.equal(api.safeHref("javascript:alert(1)", ORIGIN), null);
});

test("opt-in gates every read, write, query, and refresh without issuing a request", async () => {
    const storage = createCanvasSearchStorage();
    const index = api.createCanvasSearchIndex({ storage });
    let calls = 0;
    assert.equal(await index.write({ origin: ORIGIN, accountId: ACCOUNT, enabled: false, items: records() }), false);
    assert.equal(await index.read({ origin: ORIGIN, accountId: ACCOUNT, enabled: false }), null);
    assert.deepEqual(await index.query({ origin: ORIGIN, accountId: ACCOUNT, enabled: false, query: "read" }), { items: [], stale: false });
    assert.deepEqual(await index.refresh({ origin: ORIGIN, accountId: ACCOUNT, enabled: false, collect: async () => { calls += 1; return records(); } }), { ok: false, code: "CANVAS_SEARCH_DISABLED" });
    assert.equal(calls, 0);
});

test("a bounded in-memory session index remains useful when persistent storage is unavailable", async () => {
    const index = api.createCanvasSearchIndex();
    assert.equal(await index.write({ origin: ORIGIN, accountId: ACCOUNT, enabled: true, items: records() }), true);
    assert.deepEqual((await index.query({ origin: ORIGIN, accountId: ACCOUNT, enabled: true, query: "safety" })).items.map((item) => item.type), ["page"]);
    await index.clear({ origin: ORIGIN, accountId: ACCOUNT });
    assert.equal(await index.read({ origin: ORIGIN, accountId: ACCOUNT, enabled: true }), null);
});

test("cache freshness, expiration, account/origin partitioning, and explicit clear fail closed", async () => {
    const storage = createCanvasSearchStorage();
    const clock = { now: 1000 };
    const index = api.createCanvasSearchIndex({ storage, now: () => clock.now, ttlMs: 50, maxAgeMs: 100 });
    await index.write({ origin: ORIGIN, accountId: ACCOUNT, enabled: true, items: records() });
    assert.equal((await index.read({ origin: ORIGIN, accountId: ACCOUNT, enabled: true })).fresh, true);
    clock.now += 60;
    assert.equal((await index.read({ origin: ORIGIN, accountId: ACCOUNT, enabled: true })).stale, true);
    assert.equal(await index.read({ origin: ORIGIN, accountId: "other", enabled: true }), null);
    assert.equal(await index.read({ origin: "https://other.example.edu", accountId: ACCOUNT, enabled: true }), null);
    await index.clear({ origin: ORIGIN, accountId: ACCOUNT });
    assert.equal(await index.read({ origin: ORIGIN, accountId: ACCOUNT, enabled: true }), null);
    await index.write({ origin: ORIGIN, accountId: ACCOUNT, enabled: true, items: records() });
    clock.now += 101;
    assert.equal(await index.read({ origin: ORIGIN, accountId: ACCOUNT, enabled: true }), null);
    assert.equal(storage.value(api.STORAGE_KEY), undefined, "an expired final entry is physically removed from extension-local storage");
    assert.ok(storage.operations.some((operation) => operation.type === "remove" && operation.key === api.STORAGE_KEY));
    await index.clear();
    assert.equal(storage.value(api.STORAGE_KEY), undefined);
});

test("cold-start global clear removes the whole retained blob, while scoped clear preserves other accounts", async () => {
    const storage = createCanvasSearchStorage();
    const index = api.createCanvasSearchIndex({ storage, now: () => 1000, maxEntries: 4 });
    await index.write({ origin: ORIGIN, accountId: ACCOUNT, enabled: true, items: records() });
    await index.write({ origin: ORIGIN, accountId: "other", enabled: true, items: records() });
    await index.clear({ origin: ORIGIN, accountId: ACCOUNT });
    assert.ok(storage.value(api.STORAGE_KEY), "scoped clear retains a different account scope");
    assert.equal(await index.read({ origin: ORIGIN, accountId: ACCOUNT, enabled: true }), null);
    assert.ok(await index.read({ origin: ORIGIN, accountId: "other", enabled: true }));

    const coldStart = api.createCanvasSearchIndex({ storage });
    await coldStart.clear();
    assert.equal(storage.value(api.STORAGE_KEY), undefined, "missing identity clears a cold-start blob rather than leaving it unreadable");
});

test("a rejected scoped clear cannot keep serving the cached account in memory", async () => {
    const storage = createCanvasSearchStorage();
    const index = api.createCanvasSearchIndex({ storage });
    await index.write({ origin: ORIGIN, accountId: ACCOUNT, enabled: true, items: records() });
    storage.set = async () => { throw new Error("quota"); };
    await index.clear({ origin: ORIGIN, accountId: ACCOUNT });
    assert.equal(await index.read({ origin: ORIGIN, accountId: ACCOUNT, enabled: true }), null);
});

test("entry and byte bounds evict oldest accounts without retaining an oversized or rejected index", async () => {
    const storage = createCanvasSearchStorage();
    const clock = { now: 1000 };
    const index = api.createCanvasSearchIndex({ storage, now: () => clock.now++, maxEntries: 2, maxBytes: 900 });
    assert.equal(await index.write({ origin: ORIGIN, accountId: "one", enabled: true, items: records() }), true);
    assert.equal(await index.write({ origin: ORIGIN, accountId: "two", enabled: true, items: records() }), true);
    assert.equal(await index.write({ origin: ORIGIN, accountId: "three", enabled: true, items: records() }), true);
    assert.equal(await index.read({ origin: ORIGIN, accountId: "one", enabled: true }), null);
    assert.ok(await index.read({ origin: ORIGIN, accountId: "three", enabled: true }));
    const tiny = api.createCanvasSearchIndex({ storage: createCanvasSearchStorage(), maxBytes: 1 });
    assert.equal(await tiny.write({ origin: ORIGIN, accountId: ACCOUNT, enabled: true, items: records() }), false);
    assert.equal(await tiny.read({ origin: ORIGIN, accountId: ACCOUNT, enabled: true }), null);
});

test("refresh propagates abort, rejects stale races, and cannot commit after dispose", async () => {
    const storage = createCanvasSearchStorage();
    const index = api.createCanvasSearchIndex({ storage });
    let firstSignal;
    let releaseFirst;
    const first = index.refresh({ origin: ORIGIN, accountId: ACCOUNT, enabled: true, collect: ({ signal }) => new Promise((resolve) => { firstSignal = signal; releaseFirst = () => resolve(records()); }) });
    await Promise.resolve();
    const second = index.refresh({ origin: ORIGIN, accountId: ACCOUNT, enabled: true, collect: async () => records() });
    assert.equal(firstSignal.aborted, true);
    releaseFirst();
    assert.deepEqual(await first, { ok: false, code: "CANVAS_SEARCH_CANCELLED" });
    assert.deepEqual(await second, { ok: true });
    const external = new AbortController();
    const aborted = index.refresh({ origin: ORIGIN, accountId: ACCOUNT, enabled: true, signal: external.signal, collect: ({ signal }) => new Promise((resolve) => signal.addEventListener("abort", () => resolve(records()), { once: true })) });
    external.abort();
    assert.deepEqual(await aborted, { ok: false, code: "CANVAS_SEARCH_CANCELLED" });
    index.dispose();
    assert.deepEqual(await index.refresh({ origin: ORIGIN, accountId: ACCOUNT, enabled: true, collect: async () => records() }), { ok: false, code: "CANVAS_SEARCH_DISABLED" });
});

test("a refresh deadline settles ignored aborts, rejects late collection mutation, and releases its timer", async () => {
    const storage = createCanvasSearchStorage(); const clock = logicalClock();
    const index = api.createCanvasSearchIndex({ storage, refreshTimeoutMs: 1, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout });
    await index.write({ origin: ORIGIN, accountId: ACCOUNT, enabled: true, items: records() });
    let signal; let release;
    const pending = index.refresh({ origin: ORIGIN, accountId: ACCOUNT, enabled: true, collect: ({ signal: supplied }) => new Promise((resolve) => { signal = supplied; release = () => resolve({ items: [records()[0]], failures: [] }); }) });
    await Promise.resolve(); clock.fire();
    assert.deepEqual(await pending, { ok: false, code: "CANVAS_SEARCH_TIMEOUT" });
    assert.equal(signal.aborted, true, "deadline aborts the supplied collector signal even when it ignores abort");
    release(); await Promise.resolve(); await Promise.resolve();
    assert.deepEqual((await index.query({ origin: ORIGIN, accountId: ACCOUNT, enabled: true, query: "handout" })).items.map((item) => item.type), ["file"], "a late collection cannot overwrite the prior index");
    assert.equal(clock.size, 0, "terminal refresh clears its deadline timer");
});

test("a storage rejection is terminal and leaves the prior local index intact", async () => {
    const storage = createCanvasSearchStorage(); const index = api.createCanvasSearchIndex({ storage });
    await index.write({ origin: ORIGIN, accountId: ACCOUNT, enabled: true, items: records() });
    storage.set = async () => { throw new Error("quota"); };
    assert.deepEqual(await index.refresh({ origin: ORIGIN, accountId: ACCOUNT, enabled: true, collect: async () => ({ items: [records()[0]], failures: [] }) }), { ok: false, code: "CANVAS_SEARCH_WRITE_FAILED" });
    assert.deepEqual((await index.query({ origin: ORIGIN, accountId: ACCOUNT, enabled: true, query: "handout" })).items.map((item) => item.type), ["file"]);
});

test("partial resource failures retain successful metadata, while a fully failed refresh preserves the prior local index", async () => {
    const storage = createCanvasSearchStorage();
    const index = api.createCanvasSearchIndex({ storage });
    await index.write({ origin: ORIGIN, accountId: ACCOUNT, enabled: true, items: records() });
    const partial = await index.refresh({
        origin: ORIGIN, accountId: ACCOUNT, enabled: true,
        collect: async () => ({ items: [records()[0]], failures: ["PHASE_FOUR_READ_403"] })
    });
    assert.deepEqual(partial, { ok: true, partial: true });
    assert.deepEqual((await index.query({ origin: ORIGIN, accountId: ACCOUNT, enabled: true, query: "chapter" })).items.map((item) => item.type), ["assignment"]);
    const failed = await index.refresh({
        origin: ORIGIN, accountId: ACCOUNT, enabled: true,
        collect: async () => ({ items: [], failures: ["PHASE_FOUR_READ_429"] })
    });
    assert.deepEqual(failed, { ok: false, code: "CANVAS_SEARCH_RATE_LIMITED" });
    assert.deepEqual((await index.query({ origin: ORIGIN, accountId: ACCOUNT, enabled: true, query: "chapter" })).items.map((item) => item.type), ["assignment"]);
});

test("a genuinely empty Canvas collection becomes a fresh empty local index", async () => {
    const index = api.createCanvasSearchIndex({ storage: createCanvasSearchStorage() });
    assert.deepEqual(await index.refresh({ origin: ORIGIN, accountId: ACCOUNT, enabled: true, collect: async () => ({ items: [], failures: [] }) }), { ok: true });
    assert.deepEqual(await index.query({ origin: ORIGIN, accountId: ACCOUNT, enabled: true, query: "anything" }), { items: [], stale: false });
});

function percentile(samples, fraction) {
    const ordered = samples.slice().sort((left, right) => left - right);
    return ordered[Math.ceil(ordered.length * fraction) - 1];
}

function elapsedMs(callback) {
    const started = process.hrtime.bigint();
    return Promise.resolve(callback()).then((value) => ({ value, ms: Number(process.hrtime.bigint() - started) / 1e6 }));
}

function representativeThousandRecords() {
    const types = ["assignment", "file", "page", "module"];
    return Array.from({ length: 1000 }, (_, id) => {
        const unit = String(Math.floor(id / types.length)).padStart(3, "0");
        const type = types[id % types.length];
        const courseId = Math.floor(id / 100) + 1;
        return {
            id: `canvas-${id}`,
            type,
            title: `Biology Unit ${unit} ${type} resource`,
            courseId,
            courseName: `Biology ${courseId}`,
            moduleLabel: `Unit ${unit}`,
            href: `/courses/${courseId}/${type}s/${id}`
        };
    });
}

test("a 1,000-record local index build, cold hydration, and repeated query p95 meet Phase 5 budgets", async (t) => {
    const thousand = representativeThousandRecords();
    const options = { now: () => 1000, maxItems: 1000, maxBytes: 1024 * 1024 };
    const request = { origin: ORIGIN, accountId: ACCOUNT, enabled: true, query: "biology unit 000", limit: 4 };
    const assertRepresentativeResult = (response) => {
        assert.equal(response.stale, false);
        assert.deepEqual(response.items.map((item) => item.type), ["assignment", "file", "page", "module"]);
        assert.deepEqual(response.items.map((item) => item.id), ["canvas-0", "canvas-1", "canvas-2", "canvas-3"]);
    };
    const coldPass = async () => {
        const storage = createCanvasSearchStorage();
        const writer = api.createCanvasSearchIndex({ storage, ...options });
        const build = await elapsedMs(() => writer.write({ origin: ORIGIN, accountId: ACCOUNT, enabled: true, items: thousand }));
        assert.equal(build.value, true);
        const hydrated = api.createCanvasSearchIndex({ storage, ...options });
        const hydration = await elapsedMs(() => hydrated.query(request));
        assertRepresentativeResult(hydration.value);
        assert.equal(storage.operations.filter((operation) => operation.type === "get").length, 2, "each cold pass loads once to build and once to hydrate");
        assert.equal(storage.operations.filter((operation) => operation.type === "set").length, 1, "local build persists exactly one bounded index blob");
        return { buildMs: build.ms, hydrationMs: hydration.ms };
    };

    // Warm the module/JIT independently, then retain fresh storage and index
    // instances for every measured cold pass. No fake clock or timer is used.
    for (let run = 0; run < 4; run += 1) await coldPass();
    const coldSamples = [];
    for (let run = 0; run < 12; run += 1) coldSamples.push(await coldPass());
    const buildP95 = percentile(coldSamples.map((sample) => sample.buildMs), 0.95);
    const hydrationP95 = percentile(coldSamples.map((sample) => sample.hydrationMs), 0.95);
    assert.ok(buildP95 < 2000, `1,000-record local build p95 ${buildP95.toFixed(3)}ms must remain below 2,000ms`);
    assert.ok(hydrationP95 < 2000, `1,000-record local hydration p95 ${hydrationP95.toFixed(3)}ms must remain below 2,000ms`);

    const storage = createCanvasSearchStorage();
    const index = api.createCanvasSearchIndex({ storage, ...options });
    assert.equal(await index.write({ origin: ORIGIN, accountId: ACCOUNT, enabled: true, items: thousand }), true);
    // Query samples use the warmed, actual in-memory index and retain the full
    // normalize/rank/sort/copy path. Storage and network are not faked into it.
    for (let run = 0; run < 8; run += 1) assertRepresentativeResult((await elapsedMs(() => index.query(request))).value);
    const querySamples = [];
    for (let run = 0; run < 32; run += 1) {
        const sample = await elapsedMs(() => index.query(request));
        assertRepresentativeResult(sample.value);
        querySamples.push(sample.ms);
    }
    const queryP95 = percentile(querySamples, 0.95);
    assert.ok(queryP95 < 50, `1,000-record local query p95 ${queryP95.toFixed(3)}ms must remain below 50ms`);
    t.diagnostic(`canvas-search-1000 coldSamples=${coldSamples.length} coldWarmup=4 querySamples=${querySamples.length} queryWarmup=8 build-p50=${percentile(coldSamples.map((sample) => sample.buildMs), 0.5).toFixed(3)}ms build-p95=${buildP95.toFixed(3)}ms hydration-p50=${percentile(coldSamples.map((sample) => sample.hydrationMs), 0.5).toFixed(3)}ms hydration-p95=${hydrationP95.toFixed(3)}ms query-p50=${percentile(querySamples, 0.5).toFixed(3)}ms query-p95=${queryP95.toFixed(3)}ms node=${process.version} platform=${process.platform}/${process.arch}`);
});
