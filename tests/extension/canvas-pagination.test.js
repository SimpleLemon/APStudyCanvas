"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const fixtureRoot = path.join(root, "tests/fixtures/canvas/pagination");
const identity = require(path.join(root, "js/canvas-adapter/identity.js"));
const contracts = require(path.join(root, "js/canvas-adapter/contracts.js"));
const pagination = require(path.join(root, "js/canvas-adapter/pagination.js"));
const batch = require(path.join(root, "js/canvas-adapter/batch.js"));

const ACCOUNT = { origin: "https://canvas.example.edu", userId: 123 };

function fixture(name) {
    return JSON.parse(fs.readFileSync(path.join(fixtureRoot, name), "utf8"));
}

function planOptions(overrides = {}) {
    return { ...ACCOUNT, type: "assignment", contextId: 42, consentVersion: "consent-v1", generation: 7, ...overrides };
}

function response(data, headers = {}, status = 200) { return { status, headers, data }; }

test("RFC5988 parser follows only rel=next, handles quoted commas, and caps per_page", () => {
    const links = fixture("link-variants.json");
    for (const header of links.valid) {
        const result = pagination.parseLinkHeader(header, { expectedOrigin: links.origin, baseUrl: `${links.origin}/api/v1/courses/42/assignments?per_page=100` });
        assert.equal(result.ok, true, header);
        assert.match(result.next, /^https:\/\/canvas\.example\.edu\/api\/v1\//);
        assert.equal(new URL(result.next).searchParams.get("per_page"), "100");
    }
    const ignored = pagination.parseLinkHeader(links.ignoredNonNext, { expectedOrigin: links.origin });
    assert.deepEqual(ignored.next, null);
    assert.equal(pagination.capPerPage(250), 100);
    assert.equal(pagination.capPerPage("not-a-number"), 100);
    assert.equal(pagination.parseLinkHeader("<https://canvas.example.edu/api/v1/x>; rel=\"prev\"", { expectedOrigin: links.origin }).next, null);
    assert.equal(pagination.parseLinkHeader("<https://canvas.example.edu/api/v1/x>; rel=\"next\"", { expectedOrigin: links.origin }).next.endsWith("per_page=100"), true);
});

test("malicious next links and malformed Link syntax fail closed", () => {
    const links = fixture("malicious-links.json");
    for (const header of links.invalid) {
        const result = pagination.parseLinkHeader(header, { expectedOrigin: links.origin });
        assert.equal(result.ok, false, header);
        assert.equal(result.next, undefined, header);
    }
    for (const header of ["not-a-link", "<https://canvas.example.edu/api/v1/x>; rel", "<https://canvas.example.edu/api/v1/x; rel=next"]) {
        assert.equal(pagination.parseLinkHeader(header, { expectedOrigin: links.origin }).ok, false, header);
    }
});

test("every first/next/resume URL is bound to the frozen plan descriptor", async () => {
    const basePlan = pagination.buildFullHistoryPlan(planOptions({ scope: { course_id: 42 }, filter: { workflow_state: "submitted" }, query: { user_id: "123" } }));
    assert.equal(Object.isFrozen(basePlan.plan_descriptor), true);
    assert.equal(basePlan.plan_descriptor.origin, ACCOUNT.origin);
    assert.equal(basePlan.plan_descriptor.endpoint_path_template, "/api/v1/courses/{contextId}/assignments");
    assert.equal(basePlan.plan_descriptor.resource, "assignment");
    assert.equal(basePlan.plan_descriptor.generation, 7);
    assert.equal(basePlan.plan_descriptor.consent_version, "consent-v1");
    assert.match(basePlan.descriptor_hash, /^[a-f0-9]{64}$/);

    const cases = [
        [basePlan, (url) => { url.pathname = "/api/v1/courses/42/quizzes"; }],
        [basePlan, (url) => { url.searchParams.set("workflow_state", "graded"); }],
        [basePlan, (url) => { url.searchParams.set("user_id", "124"); }],
        [pagination.buildFullHistoryPlan({ ...ACCOUNT, type: "planner_note", lowerBound: { value: "2026-01-01", verified: true }, now: "2026-02-01", windowDays: 30 }), (url) => { url.searchParams.set("end_date", "2026-01-29"); }]
    ];
    for (const [plan, mutate] of cases) {
        const target = new URL(plan.requests[0].url);
        target.searchParams.set("page", "2");
        mutate(target);
        const result = await pagination.runPlan(plan, {
            fetchPage: async () => response([{ id: 1 }], { Link: `<${target.href}>; rel="next"` })
        });
        assert.equal(result.state, "partial", target.href);
        assert.equal(result.tombstone_eligible, false, target.href);
        assert.equal(result.progress.error_class, "malformed", target.href);
    }

    const first = new URL(basePlan.requests[0].url);
    first.pathname = "/api/v1/courses/999/assignments";
    const mutatedPlan = { ...basePlan, requests: [{ ...basePlan.requests[0], url: first.href }] };
    const firstResult = await pagination.runPlan(mutatedPlan, { fetchPage: async () => response([]) });
    assert.equal(firstResult.state, "partial");
    assert.equal(firstResult.tombstone_eligible, false);
});

test("stale checkpoints, credentials, and all opaque cursors are rejected without persistence", async () => {
    const plan = pagination.buildFullHistoryPlan(planOptions());
    const checkpoint = pagination.createCheckpoint(plan, { pageUrl: plan.requests[0].url, page: 2 });
    const stale = { ...checkpoint, plan_descriptor_hash: identity.sha256HexSync("stale-plan") };
    const staleResult = await pagination.runPlan(plan, { resumeCheckpoint: stale, fetchPage: async () => response([]) });
    assert.equal(staleResult.state, "partial");
    assert.equal(staleResult.tombstone_eligible, false);

    const cursorValues = [
        "student@example.edu",
        "123456789",
        "c3R1ZGVudDoxMjM0NTY3ODk=",
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature",
        "opaque-random-7f4a91c2"
    ];
    for (const cursorValue of cursorValues) {
        const cursorUrl = new URL(plan.requests[0].url);
        cursorUrl.searchParams.set("cursor", cursorValue);
        const cursorResult = await pagination.runPlan(plan, {
            fetchPage: async () => response([{ id: 1 }], { Link: `<${cursorUrl.href}>; rel="next"` })
        });
        assert.equal(cursorResult.state, "partial", cursorValue);
        assert.equal(cursorResult.code, "CANVAS_CURSOR_PAGINATION_UNSUPPORTED", cursorValue);
        assert.equal(cursorResult.tombstone_eligible, false, cursorValue);
        assert.ok(cursorResult.checkpoint, cursorValue);
        assert.equal(Object.prototype.hasOwnProperty.call(cursorResult.checkpoint, "page_url"), false, cursorValue);
        assert.equal(Object.prototype.hasOwnProperty.call(cursorResult.checkpoint, "cursor"), false, cursorValue);
        assert.equal(Number.isInteger(cursorResult.checkpoint.page), true, cursorValue);
        assert.equal(Number.isInteger(cursorResult.checkpoint.per_page), true, cursorValue);
        assert.equal(JSON.stringify(cursorResult.checkpoint).includes(cursorValue), false, cursorValue);
        const direct = pagination.createCheckpoint(plan, { pageUrl: cursorUrl.href, cursor: cursorValue, page: 2 });
        assert.equal(Object.prototype.hasOwnProperty.call(direct, "cursor"), false, cursorValue);
        assert.equal(JSON.stringify(direct).includes(cursorValue), false, cursorValue);
    }
    for (const key of ["page_token", "continuation_token", "next_cursor", "offset"]) {
        const target = new URL(plan.requests[0].url);
        target.searchParams.set(key, "opaque");
        const parsed = pagination.parseLinkHeader(`<${target.href}>; rel="next"`, { expectedOrigin: ACCOUNT.origin });
        assert.equal(parsed.ok, false, key);
        assert.equal(parsed.code, "CANVAS_CURSOR_PAGINATION_UNSUPPORTED", key);
    }
    assert.equal(pagination.parseLinkHeader(`<https://user:pass@canvas.example.edu/api/v1/courses/42/assignments>; rel="next"`, { expectedOrigin: ACCOUNT.origin }).ok, false);
});

test("registry metadata creates complete full-history and explicit deterministic date-window plans", () => {
    const full = pagination.buildFullHistoryPlan(planOptions());
    assert.equal(full.ok, true);
    assert.equal(full.authoritative, true);
    assert.equal(full.windows.length, 1);
    assert.equal(new URL(full.requests[0].url).searchParams.get("per_page"), "100");
    assert.deepEqual(full.requests, pagination.buildFullHistoryPlan(planOptions()).requests);

    const windowedOptions = {
        ...ACCOUNT,
        type: "planner_note",
        consentVersion: "consent-v1",
        lowerBound: fixture("window-pages.json").lowerBound,
        now: fixture("window-pages.json").now,
        windowDays: 30
    };
    const windowed = pagination.buildFullHistoryPlan(windowedOptions);
    assert.equal(windowed.ok, true);
    assert.equal(windowed.windows.length, 2);
    assert.deepEqual(windowed.windows, pagination.buildFullHistoryPlan(windowedOptions).windows);
    assert.equal(new URL(windowed.requests[0].url).searchParams.get("start_date"), "2026-01-01");
    assert.equal(new URL(windowed.requests[1].url).searchParams.get("start_date"), "2026-01-31");

    for (const type of ["planner_note", "calendar_event"]) {
        const unsupported = pagination.buildFullHistoryPlan({ ...ACCOUNT, type, now: "2026-02-01" });
        assert.equal(unsupported.state, "unsupported");
        assert.equal(unsupported.code, "CANVAS_HISTORY_LOWER_BOUND_UNSUPPORTED");
        assert.equal(unsupported.tombstone_eligible, false);
    }
});

test("incremental plans subtract configurable overlap and keep the watermark monotonic", () => {
    const plan = pagination.buildIncrementalPlan({
        ...ACCOUNT,
        type: "planner_note",
        storedWatermark: "2026-02-01",
        overlapMs: 86400000,
        now: "2026-02-03",
        consentVersion: "consent-v1"
    });
    assert.equal(plan.ok, true);
    assert.equal(plan.incremental_start, "2026-01-31");
    const checkpoint = pagination.createCheckpoint(plan, { pageUrl: plan.requests[0].url, overlapWatermark: "2026-02-01" });
    const later = pagination.createCheckpoint(plan, { pageUrl: plan.requests[0].url, overlapWatermark: "2026-01-15", previous: checkpoint });
    assert.equal(later.overlap_watermark, "2026-02-01");
});

test("checkpoint is saved before every page fetch and contains hashes, exact safe scope, and no raw user ID/secret", async () => {
    const plan = pagination.buildFullHistoryPlan(planOptions({ scope: { course_id: 42, view: "all" }, filter: { include: ["submission"] } }));
    const events = [];
    const checkpoints = [];
    const firstUrl = plan.requests[0].url;
    const nextUrlObject = new URL(firstUrl);
    nextUrlObject.searchParams.set("page", "2");
    const nextUrl = nextUrlObject.href;
    const result = await pagination.runPlan(plan, {
        revalidateCurrentContext: async () => { events.push("revalidate"); return { ok: true }; },
        saveCheckpoint: async (value) => { events.push("save"); checkpoints.push(value); },
        fetchPage: async (url) => {
            events.push("fetch");
            if (url === firstUrl) return response([{ id: 1, due_at: "2026-08-12T00:00:00Z" }], { Link: `<${nextUrl}>; rel="next"` });
            return response([{ id: 2, due_at: "2026-08-13T00:00:00Z" }]);
        },
        clock: () => Date.parse("2026-08-12T00:00:00Z")
    });
    assert.equal(result.state, "complete");
    assert.equal(result.tombstone_eligible, true);
    assert.deepEqual(result.items.map((item) => item.id), [1, 2]);
    assert.deepEqual(events, ["revalidate", "save", "fetch", "revalidate", "save", "fetch", "save"]);
    assert.equal(checkpoints.length, 3);
    assert.equal(checkpoints.at(-1).counters.windows, 1, "completed windows retain a resumable final watermark checkpoint");
    assert.equal(checkpoints.at(-1).page, 2, "the final checkpoint records the last fetched page");
    for (const checkpoint of checkpoints) {
        assert.equal(checkpoint.contract_version, contracts.VERSION);
        assert.match(checkpoint.account_hash, /^[a-f0-9]{64}$/);
        assert.match(checkpoint.expected_origin_hash, /^[a-f0-9]{64}$/);
        assert.match(checkpoint.expected_user_hash, /^[a-f0-9]{64}$/);
        assert.equal(JSON.stringify(checkpoint).includes("123"), false);
        assert.equal(JSON.stringify(checkpoint).includes("access_token"), false);
        assert.equal(checkpoint.consent_version, "consent-v1");
    }
});

test("account mismatch is waiting/mismatch and makes no page call", async () => {
    const plan = pagination.buildFullHistoryPlan(planOptions());
    let fetches = 0;
    const result = await pagination.runPlan(plan, {
        revalidateCurrentContext: () => ({ state: "mismatch", code: "CANVAS_USER_ID_MISMATCH" }),
        fetchPage: async () => { fetches += 1; return response([]); }
    });
    assert.equal(result.state, "mismatch");
    assert.equal(result.code, "CANVAS_USER_ID_MISMATCH");
    assert.equal(fetches, 0);
    assert.equal(result.tombstone_eligible, false);
});

test("window/page checkpoints resume at the saved page and continue remaining windows", async () => {
    const plan = pagination.buildFullHistoryPlan({
        ...ACCOUNT,
        type: "planner_note",
        lowerBound: { value: "2026-01-01", verified: true, source: "official_registry" },
        now: "2026-02-01",
        windowDays: 30,
        consentVersion: "consent-v1"
    });
    const firstUrl = plan.requests[0].url;
    const pageTwo = "https://canvas.example.edu/api/v1/planner_notes?end_date=2026-01-30&page=2&per_page=100&start_date=2026-01-01";
    let firstCalls = 0;
    const interrupted = await pagination.runPlan(plan, {
        fetchPage: async (url) => {
            firstCalls += 1;
            if (url === firstUrl) return response([{ id: "window-1-page-1", todo_date: "2026-01-01" }], { Link: `<${pageTwo}>; rel="next"` });
            throw Object.assign(new Error("offline"), { code: "OFFLINE" });
        },
        wait: async () => { throw new Error("offline must not retry"); }
    });
    assert.equal(interrupted.state, "partial");
    assert.equal(interrupted.checkpoint.page, 2);
    assert.equal(interrupted.checkpoint.window_index, 0);

    const resumedUrls = [];
    const resumed = await pagination.runPlan(plan, {
        resumeCheckpoint: interrupted.checkpoint,
        fetchPage: async (url) => {
            resumedUrls.push(url);
            return response([{ id: url.includes("page=2") ? "window-1-page-2" : "window-2-page-1", todo_date: "2026-01-31" }]);
        }
    });
    assert.equal(resumed.state, "complete");
    assert.equal(resumed.tombstone_eligible, true);
    assert.equal(firstCalls, 2);
    assert.equal(resumedUrls.length, 2);
    assert.equal(new URL(resumedUrls[0]).pathname, new URL(pageTwo).pathname);
    assert.equal(new URL(resumedUrls[0]).searchParams.get("page"), "2");
    assert.equal(new URL(resumedUrls[0]).searchParams.get("start_date"), "2026-01-01");
    assert.equal(new URL(resumedUrls[0]).searchParams.get("end_date"), "2026-01-30");
    assert.equal(new URL(resumedUrls[1]).searchParams.get("start_date"), "2026-01-31");
});

test("401/403 wait without retry; Retry-After seconds/date take precedence", async () => {
    const retry = fixture("retry-responses.json");
    const plan = pagination.buildFullHistoryPlan(planOptions());
    for (const responseValue of [retry.unauthorized, retry.forbidden]) {
        let calls = 0;
        const result = await pagination.runPlan(plan, { fetchPage: async () => { calls += 1; return responseValue; }, wait: async () => { throw new Error("must not wait"); } });
        assert.equal(result.state, "waiting");
        assert.equal(calls, 1);
    }
    const fixedClock = () => Date.parse("2026-08-12T00:00:00Z");
    assert.equal(pagination.retryAfterMs(retry.retryAfterSeconds.headers, fixedClock), 2000);
    assert.equal(pagination.retryAfterMs(retry.retryAfterDate.headers, fixedClock), 10000);
});

test("Retry-After numeric/date delays are clamped, malformed values fall back, and retry checkpoints precede waits", async () => {
    const fixedClock = () => Date.parse("2026-08-12T00:00:00Z");
    assert.equal(pagination.retryAfterMs({ "Retry-After": "999999999" }, fixedClock), 300000);
    assert.equal(pagination.retryAfterMs({ "Retry-After": "Wed, 01 Jan 2020 00:00:00 GMT" }, fixedClock), 0);
    assert.equal(pagination.retryAfterMs({ "Retry-After": "not-a-delay" }, fixedClock), null);

    const plan = pagination.buildFullHistoryPlan(planOptions());
    const events = [];
    let calls = 0;
    const result = await pagination.runPlan(plan, {
        fetchPage: async () => {
            calls += 1;
            return calls === 1 ? response([], { "Retry-After": "999999999" }, 429) : response([]);
        },
        saveCheckpoint: async () => events.push("save"),
        wait: async (milliseconds) => { events.push(["wait", milliseconds]); },
        clock: fixedClock
    });
    assert.equal(result.state, "complete");
    assert.deepEqual(events.filter((item) => Array.isArray(item)), [["wait", 300000]]);
    const waitIndex = events.findIndex((item) => Array.isArray(item));
    assert.equal(events[waitIndex - 1], "save");
});

test("429/5xx/timeout retry with jitter and stop at eight attempts", async () => {
    const plan = pagination.buildFullHistoryPlan(planOptions());
    const waits = [];
    let calls = 0;
    const success = await pagination.runPlan(plan, {
        fetchPage: async () => {
            calls += 1;
            if (calls === 1) return { status: 429, headers: { "Retry-After": "2" }, data: [] };
            if (calls === 2) throw Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
            return response([{ id: calls }]);
        },
        wait: async (milliseconds) => waits.push(milliseconds),
        random: () => 0.5,
        clock: () => Date.parse("2026-08-12T00:00:00Z")
    });
    assert.equal(success.state, "complete");
    assert.equal(calls, 3);
    assert.deepEqual(waits, [2000, 2000]);

    let cappedCalls = 0;
    const capped = await pagination.runPlan(plan, {
        fetchPage: async () => { cappedCalls += 1; return { status: 503, headers: {}, data: [] }; },
        wait: async () => {},
        random: () => 1
    });
    assert.equal(capped.state, "partial");
    assert.equal(capped.error_class, undefined);
    assert.equal(capped.progress.error_class, "server");
    assert.equal(cappedCalls, 8);
});

test("offline, abort, malformed payload, and malformed Link remain partial with resumable checkpoint", async () => {
    const plan = pagination.buildFullHistoryPlan(planOptions());
    for (const error of [Object.assign(new Error("offline"), { code: "OFFLINE" }), Object.assign(new Error("closed"), { name: "AbortError" })]) {
        const result = await pagination.runPlan(plan, { fetchPage: async () => { throw error; }, wait: async () => { throw new Error("must not retry"); } });
        assert.equal(result.state, "partial");
        assert.equal(result.tombstone_eligible, false);
        assert.ok(result.checkpoint);
    }
    const malformedPayload = await pagination.runPlan(plan, { fetchPage: async () => response({ not: "an array" }) });
    assert.equal(malformedPayload.state, "partial");
    assert.equal(malformedPayload.progress.error_class, "malformed");
    assert.ok(malformedPayload.checkpoint);

    const malformedLink = await pagination.runPlan(plan, { fetchPage: async () => response([{ id: 1 }], { Link: "not-a-link" }) });
    assert.equal(malformedLink.state, "partial");
    assert.equal(malformedLink.progress.error_class, "malformed");
    assert.ok(malformedLink.checkpoint);
});

test("completion gate requires every page/window and matching generation, scope, and consent", async () => {
    const plan = pagination.buildFullHistoryPlan({ ...ACCOUNT, type: "planner_note", lowerBound: { value: "2026-01-01", verified: true }, now: "2026-02-01", windowDays: 30, generation: 3, consentVersion: "consent-v2" });
    let calls = 0;
    const complete = await pagination.runPlan(plan, { fetchPage: async () => { calls += 1; return response([{ id: calls, todo_date: "2026-01-01" }]); }, generation: 3, consentVersion: "consent-v2" });
    assert.equal(complete.state, "complete");
    assert.equal(complete.tombstone_eligible, true);
    assert.equal(calls, 2);

    const wrongConsent = await pagination.runPlan(plan, { fetchPage: async () => response([]), consentVersion: "consent-v3" });
    assert.equal(wrongConsent.state, "mismatch");
    assert.equal(wrongConsent.tombstone_eligible, false);

    const resumed = await pagination.runPlan(plan, { resumeCheckpoint: { ...complete.checkpoint, consent_version: "other" }, fetchPage: async () => response([]) });
    assert.equal(resumed.state, "mismatch");
    assert.equal(resumed.tombstone_eligible, false);
});

test("batch builder is deterministic, bounded, secret-free, and quarantines an oversized single item", () => {
    const items = [
        { eventRef: "b", payload: { text: "B" }, access_token: "secret" },
        { eventRef: "a", payload: { text: "A", nested: { password: "secret" } } }
    ];
    const forward = batch.buildBatches(items);
    const reverse = batch.buildBatches(items.slice().reverse());
    assert.deepEqual(forward.batches.map((item) => item.body), reverse.batches.map((item) => item.body));
    assert.equal(forward.item_count, 2);
    assert.equal(forward.checksum, reverse.checksum);
    assert.equal(JSON.stringify(forward).includes("secret"), false);
    assert.ok(forward.batches.every((item) => item.item_count <= 100 && item.byte_length <= 512 * 1024));

    const oversized = batch.buildBatches([{ eventRef: "huge", payload: { padding: "x".repeat(600000) } }]);
    assert.equal(oversized.batches.length, 0);
    assert.equal(oversized.quarantined.length, 1);
    assert.equal(oversized.quarantined[0].reason, "item_too_large");
});

test("batch builder respects 100-item and exact 512 KiB boundaries", () => {
    const hundred = batch.buildBatches(Array.from({ length: 100 }, (_, index) => ({ eventRef: `event-${String(index).padStart(3, "0")}` })));
    assert.equal(hundred.item_count, 100);
    assert.equal(hundred.batches.length, 1);
    assert.equal(hundred.batches[0].byte_length <= 512 * 1024, true);

    const base = { eventRef: "boundary", payload: { padding: "" } };
    const emptySize = Buffer.byteLength(batch.stableStringify({ items: [base] }), "utf8");
    base.payload.padding = "x".repeat(512 * 1024 - emptySize);
    const atLimit = batch.buildBatches([base]);
    assert.equal(atLimit.quarantined.length, 0);
    assert.equal(atLimit.batches[0].byte_length, 512 * 1024);
    const over = batch.buildBatches([{ eventRef: "boundary", payload: { padding: "x".repeat(512 * 1024 - emptySize + 1) } }]);
    assert.equal(over.quarantined.length, 1);
});

test("10,000 generated events build deterministically and can be interrupted/resumed without a loop", () => {
    const events = Array.from({ length: 10000 }, (_, index) => ({ eventRef: `generated-${String(index).padStart(5, "0")}`, payload: { index } }));
    const firstRun = batch.buildBatches(events);
    assert.equal(firstRun.item_count, 10000);
    assert.equal(firstRun.batches.length, 100);
    assert.ok(firstRun.batches.every((item) => item.item_count === 100 && item.byte_length <= 512 * 1024));
    const interrupted = firstRun.batches.slice(0, 37);
    const resumed = batch.buildBatches(events.slice(interrupted.reduce((count, item) => count + item.item_count, 0)));
    assert.equal(interrupted.reduce((count, item) => count + item.item_count, 0) + resumed.item_count, 10000);
    assert.equal(batch.buildBatches(events).checksum, firstRun.checksum);
});

test("safe progress telemetry contains only the contract fields", async () => {
    const plan = pagination.buildFullHistoryPlan(planOptions());
    const result = await pagination.runPlan(plan, { fetchPage: async () => response([{ id: 1 }]), correlation: "student=123/secret=never" });
    assert.deepEqual(Object.keys(result.progress).sort(), ["correlation_hash", "count", "duration", "error_class", "state"]);
    assert.deepEqual(result.progress, result.telemetry);
    assert.equal(JSON.stringify(result.progress).includes("123"), false);
    assert.equal(JSON.stringify(result.progress).includes("never"), false);
    assert.match(result.progress.correlation_hash, /^c-[a-f0-9]{24}$/);
});

test("browser-compatible UMD surface does not require Node-only APIs", () => {
    assert.equal(typeof pagination.parseLinkHeader, "function");
    assert.equal(typeof pagination.runPlan, "function");
    assert.equal(typeof batch.buildBatches, "function");
    assert.equal(typeof identity.sha256HexSync, "function");
});
