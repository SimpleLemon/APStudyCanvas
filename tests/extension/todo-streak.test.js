"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const streak = require("../../js/content/todo-streak.js");
const time = require("../../js/content/todo-time.js");

const scope = (today = "2026-08-10", accountKey = "canvas-a", timeZone = "America/New_York") => ({ today, accountKey, timeZone });
const task = (date, completion = true) => ({ source: "canvas", type: "assignment", due: { kind: "date", date }, completion });

test("starts tracking without historic backfill and scopes state by Canvas account and timezone", () => {
    assert.equal(streak.POLICY_VERSION, 3);
    const first = streak.plan(null, scope());
    assert.equal(first.reason, "first-run");
    assert.equal(first.state.since, "2026-08-10");
    assert.equal(first.state.current, 0);
    assert.equal(streak.normalize(first.state, scope("2026-08-10", "canvas-b")).since, null);
    assert.equal(streak.normalize(first.state, scope("2026-08-10", "canvas-a", "UTC")).since, null);
});

test("policy v3 does not reinterpret older settled history", () => {
    assert.equal(streak.STORAGE_KEY, "todo_streak_history_v3", "policy-v3 storage does not share an older persistence map");
    const old = { ...streak.empty(scope()), policyVersion: 1, since: "2026-08-01", lastSettledDate: "2026-08-09", current: 9 };
    assert.equal(streak.normalize(old, scope()).since, null);
    assert.notEqual(streak.scopeKey({ ...scope(), policyVersion: 1 }), streak.scopeKey(scope()));
});

test("settles only past Canvas due dates, skips no-task dates, and never revises settled outcomes", () => {
    const initial = streak.plan(null, scope()).state;
    const first = streak.advance(initial, [task("2026-08-10"), task("2026-08-12")], scope("2026-08-13"));
    assert.equal(first.history.days["2026-08-10"], streak.CLEAR);
    assert.equal(first.history.days["2026-08-11"], streak.NONE);
    assert.equal(first.history.days["2026-08-12"], streak.CLEAR);
    assert.equal(first.history.current, 2);
    const immutable = streak.advance(first.history, [task("2026-08-10", false), task("2026-08-13", false)], scope("2026-08-14"));
    assert.equal(immutable.history.days["2026-08-10"], streak.CLEAR);
    assert.equal(immutable.history.days["2026-08-13"], streak.MISSED);
    assert.equal(immutable.history.current, 0);
});

test("plans a bounded forward fetch independent of selected ranges and retains bounded history", () => {
    const history = { ...streak.plan(null, scope("2026-01-01")).state, lastSettledDate: "2026-01-01" };
    const planned = streak.plan(history, scope("2026-08-01"));
    assert.equal(planned.range.start, "2026-01-02");
    assert.equal(planned.range.end, "2026-04-01");
    assert.equal(streak.MAX_DAYS_PER_FETCH, 90);
    const days = Object.fromEntries(Array.from({ length: 420 }, (_, i) => {
        const date = new Date(Date.UTC(2024, 0, 1 + i));
        return [date.toISOString().slice(0, 10), streak.NONE];
    }));
    const advanced = streak.advance({ ...history, days, lastSettledDate: "2026-01-01" }, [], scope("2026-01-03"));
    assert.ok(Object.keys(advanced.history.days).length <= streak.MAX_DAY_ENTRIES);
});

test("a failed source can retain only a previously verified summary", () => {
    const unavailable = streak.summarize(null, scope());
    assert.equal(unavailable.state, "unavailable");
    const history = { ...streak.plan(null, scope()).state, current: 2, since: "2026-08-01" };
    assert.equal(streak.summarize(history, scope()).state, "tracking");
    assert.equal(streak.freeze(history, scope()).state, "unavailable", "an unverified tracking start is not presented as stale truth");
    const verified = { ...history, lastSettledDate: "2026-08-09" };
    assert.deepEqual(streak.freeze(verified, scope()), { state: "stale", current: 2, since: "2026-08-01", best: 0, noTaskDates: "skip" });
});

test("a partial Canvas read freezes the last verified history rather than settling unknown dates", () => {
    const history = { ...streak.plan(null, scope("2026-08-01")).state, lastSettledDate: "2026-08-01", current: 1, days: { "2026-08-01": streak.CLEAR } };
    const result = streak.advance(history, [task("2026-08-02", false)], scope("2026-08-03"), { complete: false });
    assert.equal(result.state, "partial");
    assert.deepEqual(result.history, streak.normalize(history, scope("2026-08-03")));
    assert.equal(result.history.days["2026-08-02"], undefined);
});

test("the streak module never consults a selected Todo range or walks backward through empty history", () => {
    const source = require("node:fs").readFileSync(require("node:path").join(__dirname, "../../js/content/todo-streak.js"), "utf8");
    assert.doesNotMatch(source, /selectedRange|todo_timeframe|while \(cursor\).*shiftDateKey\(cursor, -1\)/s);
    const first = streak.advance(null, [task("2020-01-01")], scope("2026-08-10"));
    assert.equal(first.state, "tracking");
    assert.equal(first.settled, 0, "first run records its start only; it never backfills");
});

test("the history coordinator serializes overlapping snapshots, preserves settled dates, and retains other scopes", async () => {
    const scopeA = scope("2026-08-03", "canvas-a");
    const scopeB = scope("2026-08-03", "canvas-b");
    const keyA = streak.scopeKey(scopeA);
    const keyB = streak.scopeKey(scopeB);
    const seed = (activeScope) => ({ ...streak.plan(null, { ...activeScope, today: "2026-08-01" }).state, lastSettledDate: "2026-08-01", current: 1, best: 1, days: { "2026-08-01": streak.CLEAR } });
    let stored = { [keyA]: seed(scopeA), [keyB]: seed(scopeB) };
    const writes = [];
    let releaseFirst;
    const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
    const coordinator = streak.createHistoryCoordinator({
        read: async () => ({ ...stored }),
        write: async (next) => { writes.push(next); stored = next; }
    });
    const first = coordinator.update(scopeA, async (latest) => {
        await firstGate;
        return { write: true, history: streak.advance(latest, [task("2026-08-02")], scopeA).history };
    });
    const conflicting = coordinator.update(scopeA, (latest) => ({ write: false, history: latest }));
    const otherScope = coordinator.update(scopeB, (latest) => ({ write: true, history: streak.advance(latest, [task("2026-08-02", false)], scopeB).history }));
    releaseFirst();
    await Promise.all([first, conflicting, otherScope]);
    assert.equal(stored[keyA].days["2026-08-02"], streak.CLEAR, "the later overlapping snapshot cannot revise an already settled date");
    assert.equal(stored[keyB].days["2026-08-02"], streak.MISSED, "a different account scope remains intact in the shared map");
    assert.equal(writes.length, 2);
    const stale = await coordinator.update(scopeA, () => ({ write: true, history: streak.empty(scopeA) }), { isCurrent: () => false });
    assert.equal(stale.stale, true);
    assert.equal(writes.length, 2, "a stale generation never writes");
});

test("settles forward across a midnight rollover and never re-fetches settled days", () => {
    const first = streak.advance(null, [task("2026-08-10")], scope("2026-08-10"));
    assert.equal(first.state, "tracking");
    assert.equal(first.settled, 0, "the first run only records its start; today is never settled");

    const day2 = streak.advance(first.history, [task("2026-08-10")], scope("2026-08-11"));
    assert.equal(day2.state, "verified");
    assert.equal(day2.settled, 1, "the rollover settles exactly the newly past day");
    assert.equal(day2.history.days["2026-08-10"], streak.CLEAR);
    assert.equal(day2.history.current, 1);
    assert.equal(day2.history.lastSettledDate, "2026-08-10");

    const sameEvening = streak.plan(day2.history, scope("2026-08-11"));
    assert.equal(sameEvening.reason, "current", "a settled edge needs no fetch until the next rollover");
    assert.equal(sameEvening.range, null);

    const day3 = streak.advance(day2.history, [task("2026-08-11")], scope("2026-08-12"));
    assert.equal(day3.history.days["2026-08-11"], streak.CLEAR);
    assert.equal(day3.history.current, 2, "the streak continues across the rollover boundary");
    assert.equal(day3.history.lastSettledDate, "2026-08-11");
});

test("a missed day resets the current streak while the best streak and settled history persist", () => {
    const seed = {
        ...streak.plan(null, scope("2026-08-01")).state,
        lastSettledDate: "2026-08-05",
        current: 5,
        best: 5,
        days: Object.fromEntries(["2026-08-01", "2026-08-02", "2026-08-03", "2026-08-04", "2026-08-05"].map((date) => [date, streak.CLEAR]))
    };
    const next = streak.advance(seed, [task("2026-08-06", false), task("2026-08-07")], scope("2026-08-08"));
    assert.equal(next.history.days["2026-08-06"], streak.MISSED);
    assert.equal(next.history.days["2026-08-07"], streak.CLEAR);
    assert.equal(next.history.current, 1, "the current streak restarts after the miss");
    assert.equal(next.history.best, 5, "the best streak survives the reset");
    assert.equal(next.history.lastSettledDate, "2026-08-07");
});

test("one clear due date adds one streak day, while a late assignment resets it", () => {
    const history = {
        ...streak.plan(null, scope("2026-08-01")).state,
        lastSettledDate: "2026-08-01",
        current: 1,
        best: 1,
        days: { "2026-08-01": streak.CLEAR }
    };
    const clear = streak.advance(history, [task("2026-08-02"), task("2026-08-02")], scope("2026-08-03"));
    assert.equal(clear.history.current, 2, "multiple assignments on one day count as one day");
    const late = streak.advance(clear.history, [{ ...task("2026-08-03"), late: true }], scope("2026-08-04"));
    assert.equal(late.history.days["2026-08-03"], streak.MISSED);
    assert.equal(late.history.current, 0, "late work breaks the current streak even when submitted");
    assert.equal(late.history.best, 2);
});

test("the integration streak read skips unsupported planner types instead of freezing settlement", () => {
    const source = require("node:fs").readFileSync(require("node:path").join(__dirname, "../../js/content.js"), "utf8");
    assert.match(source, /skipUnsupported = false/, "normalizeCanvasItems keeps the strict default for the visible list");
    assert.match(source, /else if \(skipUnsupported && result\?\.code === "TODO_CANVAS_TYPE_UNSUPPORTED"\) continue;/, "unsupported planner rows cannot veto streak completeness");
    assert.match(source, /normalizeCanvasItems\(result\.items \|\| \[\], currentBinding, \{ skipUnsupported: true \}\)/, "trackedStreak opts into the tolerant read");
});

test("date rollovers across month boundaries keep settling exactly the unsettled days", () => {
    const initial = streak.plan(null, scope("2026-07-31", "UTC")).state;
    const first = streak.advance(initial, [task("2026-07-31")], scope("2026-08-01", "UTC"));
    assert.equal(first.history.days["2026-07-31"], streak.CLEAR);
    assert.equal(first.history.lastSettledDate, "2026-07-31");
    assert.equal(first.history.current, 1);
    const second = streak.advance(first.history, [task("2026-08-01", false)], scope("2026-08-02", "UTC"));
    assert.equal(second.history.days["2026-08-01"], streak.MISSED);
    assert.equal(second.history.current, 0);
    assert.equal(second.history.best, 1, "the settled best survives the broken day");
});

test("the rail re-settles and repaints after a date rollover instead of freezing yesterday's readout", () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const content = fs.readFileSync(path.join(__dirname, "../../js/content.js"), "utf8");
    assert.match(content, /function armDayRolloverWatch\(\)/, "a rollover watcher is defined");
    assert.match(content, /schedule\("day-rollover"\)/, "the watcher schedules a refresh on day change");
    assert.match(content, /if \(rolloverTimer !== null\) \{ clearTimeout\(rolloverTimer\); rolloverTimer = null; \}\s*removeRail\(\);/, "pause tears the watcher down");
    assert.match(content, /if \(!railMounted\) \{\s*render\(\{[\s\S]*?canvasState: "loading"/, "the shell mounts before any async work");
    assert.match(content, /armDayRolloverWatch\(\);/, "the watcher arms once the shell mounts");
});

test("legacy streak storage and duplicate right-rail scorer are absent", () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const root = path.join(__dirname, "../..");
    const content = fs.readFileSync(path.join(root, "js/content.js"), "utf8");
    const manifest = fs.readFileSync(path.join(root, "manifest.json"), "utf8");
    assert.doesNotMatch(content, /streak_history|updateStreak|RightRailData/);
    assert.doesNotMatch(manifest, /right-rail-data/);
    assert.equal(fs.existsSync(path.join(root, "js/content/right-rail-data.js")), false);
});

test("seedWindow bounds the first-run read to the settled local days ending yesterday", () => {
    const seed = streak.seedWindow(scope("2026-08-10"));
    assert.equal(seed.end, "2026-08-09");
    assert.equal(seed.start, time.shiftDateKey("2026-08-09", -(streak.MAX_DAYS_PER_FETCH - 1)));
    assert.equal(seed.timeZone, "America/New_York");
    assert.equal(streak.seedWindow({ today: "not-a-date", timeZone: "UTC" }), null, "an unusable clock seeds nothing");
});

test("seeding settles qualifying completed dates so eligible work is not pinned at zero", () => {
    const seedRange = streak.seedWindow(scope("2026-08-10"));
    const tasks = [task("2026-08-06", false), task("2026-08-07"), task("2026-08-08"), task("2026-08-09")];
    const result = streak.advance(null, tasks, scope("2026-08-10"), { range: seedRange });
    assert.equal(result.state, "verified");
    assert.ok(result.history.current > 0, "eligible completed dates produce a non-zero streak");
    assert.equal(result.history.current, 3);
    assert.equal(result.history.best, 3);
    assert.equal(result.history.since, seedRange.start, "tracking starts at the earliest seeded day");
    assert.equal(result.history.lastSettledDate, "2026-08-09");
    assert.equal(result.history.days["2026-08-05"], streak.NONE, "no-task dates stay skipped");
    assert.equal(result.history.days["2026-08-06"], streak.MISSED);
    assert.equal(result.history.days["2026-08-09"], streak.CLEAR);
    assert.equal(result.history.days["2026-08-10"], undefined, "a seed never settles today");
});

test("a broken day inside the seeded window resets the current streak while best survives", () => {
    const tasks = [
        task("2026-08-01"), task("2026-08-02"), task("2026-08-03", false),
        task("2026-08-04"), task("2026-08-05"), task("2026-08-06"),
        task("2026-08-07"), task("2026-08-08"), task("2026-08-09")
    ];
    const result = streak.advance(null, tasks, scope("2026-08-10"), { range: { start: "2026-08-01", end: "2026-08-09" } });
    assert.equal(result.history.days["2026-08-03"], streak.MISSED);
    assert.equal(result.history.current, 6);
    assert.equal(result.history.best, 6);
});

test("seed windows clamp to the bounded past and invalid ranges fall back to the tracking start", () => {
    const oversized = streak.advance(null, [], scope("2026-08-10"), { range: { start: "2020-01-01", end: "2026-08-10" } });
    assert.equal(oversized.state, "verified");
    assert.equal(oversized.history.lastSettledDate, "2026-08-09", "a seed ending today clamps to yesterday");
    assert.equal(oversized.history.since, streak.seedWindow(scope("2026-08-10")).start);
    assert.ok(Object.keys(oversized.history.days).length <= streak.MAX_DAY_ENTRIES);

    const invalid = streak.advance(null, [], scope("2026-08-10"), { range: { start: "2026-08-09", end: "2026-08-01" } });
    assert.equal(invalid.state, "tracking", "an inverted seed records the plain first-run start");
    assert.equal(invalid.settled, 0);
    assert.equal(invalid.history.since, "2026-08-10");
});

test("seeding never revises settled history and re-running it is a no-op", () => {
    const seedRange = { start: "2026-08-03", end: "2026-08-09" };
    const first = streak.advance(null, [task("2026-08-05")], scope("2026-08-10"), { range: seedRange });
    assert.equal(first.history.days["2026-08-05"], streak.CLEAR);

    const again = streak.advance(first.history, [task("2026-08-05")], scope("2026-08-10"), { range: seedRange });
    assert.equal(again.settled, 0, "a tracked record ignores the seed and plans forward only");
    assert.equal(again.changed, false);
    assert.deepEqual(again.history, first.history);

    const contradicting = streak.advance(first.history, [task("2026-08-05", false)], scope("2026-08-10"), { range: seedRange });
    assert.equal(contradicting.history.days["2026-08-05"], streak.CLEAR, "settled outcomes stay immutable");
});

test("the integration seeds the streak from one bounded historical read on first run", () => {
    const source = require("node:fs").readFileSync(require("node:path").join(__dirname, "../../js/content.js"), "utf8");
    assert.match(source, /const seedRange = contentTodoStreakApi\.seedWindow\(scope\);/, "first run plans the bounded seed window");
    assert.match(source, /fetchCanvasPlanner\(\{ fetchImpl: \(\.\.\.args\) => fetch\(\.\.\.args\), origin: currentBinding\.origin, range: seedRange, signal \}\)/, "the seed window is fetched like any planned range");
    assert.match(source, /latestPlan\.reason !== "first-run" && latestPlan\.reason !== "seed-required"/, "a concurrently seeded record wins over a stale plan");
    assert.match(source, /contentTodoStreakApi\.advance\(latest, seedTasks, scope, \{ range: seedRange \}\)/, "the seed settles through the standard advance policy");
});

test("an unseeded current-policy zero history is classified seed-required without touching settled records", () => {
    const preFix = { ...streak.empty({ ...scope(), today: null }), since: "2026-08-09", lastSettledDate: null, current: 0, best: 0, days: {} };
    assert.equal(streak.requiresSeed(preFix, scope()), true, "the unseeded zero history is a migration target");
    const planned = streak.plan(preFix, scope());
    assert.equal(planned.reason, "seed-required");
    assert.equal(planned.range, null);
    // Any settled evidence disqualifies the record from the migration.
    assert.equal(streak.requiresSeed({ ...preFix, lastSettledDate: "2026-08-09" }, scope()), false, "a settled date is settled history");
    assert.equal(streak.requiresSeed({ ...preFix, days: { "2026-08-08": streak.CLEAR } }, scope()), false, "populated days are settled history");
    assert.equal(streak.requiresSeed({ ...preFix, current: 2 }, scope()), false, "a counted streak is settled history");
    assert.equal(streak.requiresSeed({ ...preFix, best: 1 }, scope()), false, "a recorded best is settled history");
    assert.equal(streak.requiresSeed(null, scope()), false, "a missing record is first-run, not a migration target");
    assert.equal(streak.plan({ ...preFix, policyVersion: 1 }, scope()).reason, "first-run", "foreign policy records normalize away instead of upgrading");
});

test("the stored-state upgrade seeds an existing unseeded zero history through the real coordinator", async () => {
    const scopeKey = streak.scopeKey(scope());
    const legacyScopeKey = streak.scopeKey({ ...scope(), policyVersion: 1 });
    // A stored record of the isolated pre-include history era (v:1, here
    // represented by the pre-upgrade zero-history shape the coordinator must
    // still upgrade): the upgrade path is version-agnostic once normalize()
    // accepts the record, so the literal keeps the current era's version.
    const preFix = { v: streak.HISTORY_VERSION, accountKey: "canvas-a", timeZone: "America/New_York", policyVersion: streak.POLICY_VERSION, since: "2026-08-09", lastSettledDate: null, current: 0, best: 0, days: {} };
    const staleEra = { v: 1, accountKey: "canvas-a", timeZone: "America/New_York", policyVersion: streak.POLICY_VERSION, since: "2026-08-09", lastSettledDate: "2026-08-09", current: 0, best: 0, days: { "2026-08-05": streak.MISSED } };
    assert.equal(streak.normalize(staleEra, scope()).since, null, "a settled record from the pre-include era is isolated, never reinterpreted");
    let stored = {
        [legacyScopeKey]: { v: 1, accountKey: "canvas-a", timeZone: "America/New_York", policyVersion: 1, since: "2026-07-01", lastSettledDate: "2026-07-20", current: 7, best: 9, days: { "2026-07-20": streak.CLEAR } },
        [scopeKey]: preFix
    };
    const reads = [];
    const coordinator = streak.createHistoryCoordinator({
        read: async () => { reads.push(JSON.parse(JSON.stringify(stored))); return JSON.parse(JSON.stringify(stored)); },
        write: async (all) => { stored = JSON.parse(JSON.stringify(all)); }
    });
    // The exact derive sequence trackedStreak runs for a seedable plan.
    const upgrade = async () => {
        const previous = stored[scopeKey] || null;
        const planned = streak.plan(previous, scope());
        if (planned.reason !== "first-run" && planned.reason !== "seed-required") return "tracking";
        const seedRange = streak.seedWindow(scope());
        const seedTasks = [task("2026-08-05")];
        const committed = await coordinator.update(scope(), (latest) => {
            const latestPlan = streak.plan(latest, scope());
            if (latestPlan.reason !== "first-run" && latestPlan.reason !== "seed-required") return { write: false, history: streak.normalize(latest, scope()) };
            if (!seedRange || !seedTasks) return { write: latestPlan.reason === "first-run", history: latestPlan.state };
            const seeded = streak.advance(latest, seedTasks, scope(), { range: seedRange });
            return { write: seeded.changed, history: seeded.history };
        });
        return committed;
    };
    const first = await upgrade();
    assert.equal(first.written, true);
    assert.equal(first.history.since, "2026-08-09", "the stored tracking start survives the upgrade");
    assert.equal(first.history.lastSettledDate, "2026-08-09");
    assert.equal(first.history.days["2026-08-05"], streak.CLEAR, "the qualifying seeded day lands");
    assert.equal(first.history.current, 1);
    assert.equal(streak.requiresSeed(first.history, scope()), false, "the upgraded record is fully seeded");
    assert.equal(stored[legacyScopeKey].policyVersion, 1, "the settled v1 policy scope is never reinterpreted");
    assert.equal(stored[legacyScopeKey].current, 7);
    const second = await upgrade();
    assert.equal(second, "tracking", "an upgraded record plans forward only");
    assert.equal(reads.length, 1, "the second run never reaches the coordinator again");
});

test("a failed seed read keeps the seed-required marker so the next refresh retries", async () => {
    const scopeKey = streak.scopeKey(scope());
    let stored = { [scopeKey]: { ...streak.empty({ ...scope(), today: null }), since: "2026-08-09", lastSettledDate: null, current: 0, best: 0, days: {} } };
    const coordinator = streak.createHistoryCoordinator({
        read: async () => JSON.parse(JSON.stringify(stored)),
        write: async (all) => { stored = JSON.parse(JSON.stringify(all)); }
    });
    const committed = await coordinator.update(scope(), (latest) => {
        const latestPlan = streak.plan(latest, scope());
        if (latestPlan.reason !== "first-run" && latestPlan.reason !== "seed-required") return { write: false, history: streak.normalize(latest, scope) };
        return { write: latestPlan.reason === "first-run", history: latestPlan.state };
    });
    assert.equal(committed.written, false, "a seed-required record is preserved when the read fails");
    assert.equal(streak.plan(stored[scopeKey], scope()).reason, "seed-required", "the marker survives so seeding retries");
});

test("the real planner row shape settles submitted work so the seed leaves zero", async () => {
    // Canvas ships a literal `submissions: false` placeholder on planner rows
    // unless the feed requests include[]=submissions. The placeholder carries
    // no completion signal; the included summary object does. The seed's
    // historical read must see the real shape or qualifying submitted work
    // settles as MISSED and pins the streak at zero.
    const model = require("../../js/content/todo-model.js");
    const accountKey = "82b43931e4cb7ecd230c97a5c65c002dcc3016797b3ba873250686e01bec321e";
    const normalize = async (submissions) => {
        const result = await model.normalizeCanvasTask("assignment", {
            id: 101,
            plannable_type: "assignment",
            plannable_id: 101,
            course_id: 42,
            plannable: { id: 101, title: "Reading check", due_at: "2026-08-05T12:00:00Z" },
            due_at: "2026-08-05T12:00:00Z",
            html_url: "https://canvas.example.edu/courses/42/assignments/101",
            submissions
        }, { origin: "https://canvas.example.edu", userId: 123, accountKey });
        assert.equal(result.ok, true, result.code);
        return result.task;
    };
    const submitted = await normalize({ submitted: true, excused: false, posted_at: "2026-08-05T13:01:00Z", score: 9 });
    assert.equal(submitted.completion, true, "the include[]=submissions summary carries the submitted signal");
    const placeholder = await normalize(false);
    assert.equal(placeholder.completion, false, "the submissions:false placeholder carries no completion signal");
    const seedRange = { start: "2026-08-01", end: "2026-08-09" };
    const seeded = streak.advance(null, [submitted], scope("2026-08-10"), { range: seedRange });
    assert.equal(seeded.history.days["2026-08-05"], streak.CLEAR, "the genuinely submitted day settles CLEAR");
    assert.equal(seeded.history.current, 1, "the seeded streak leaves zero when qualifying work exists");
    const brokenEra = streak.advance(null, [placeholder], scope("2026-08-10"), { range: seedRange });
    assert.equal(brokenEra.history.days["2026-08-05"], streak.MISSED, "without submission state the same day would wrongly settle MISSED");
});
