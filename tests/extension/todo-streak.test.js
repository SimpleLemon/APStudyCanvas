"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const streak = require("../../js/content/todo-streak.js");
const time = require("../../js/content/todo-time.js");
const scope = (today = "2026-09-12", zone = "America/New_York") => ({ accountKey: "account-a", timeZone: zone, today, now: Date.parse(`${today}T16:00:00Z`) });
const task = (date, complete = true, extra = {}) => ({ id: date, title: "Assignment", source: "canvas", type: "assignment", due: { kind: "date", date }, completion: complete, ...extra });
const advance = (history, tasks, s = scope()) => streak.advance(history, tasks, s).history;

test("initial seed covers 180 past days plus today; tracking starts with the first observed task", () => {
    const s = scope();
    assert.equal(time.daysInclusive(streak.seedWindow(s).start, s.today), 181);
    const h = advance(null, []);
    assert.equal(h.since, s.today); assert.equal(h.current, 1); assert.equal(h.best, 1);
    const observed = advance(null, [task("2026-07-20")]);
    assert.equal(observed.since, "2026-07-20"); assert.equal(observed.current, 55); assert.equal(observed.best, 55);
});
test("the v4 day-one seed bug repairs itself from retained observed outcomes", () => {
    const broken = advance(null, []);
    broken.days["2026-07-20"] = streak.CLEAR;
    broken.since = "2026-09-12";
    broken.startedAt = "2026-09-12";
    broken.current = 1;
    const repaired = advance(broken, []);
    assert.equal(repaired.since, "2026-07-20"); assert.equal(repaired.startedAt, "2026-07-20"); assert.equal(repaired.current, 55);
});
test("latest missed date resets; empty calendar days and today count", () => {
    const h = advance(null, [task("2026-09-08", false), task("2026-09-10", true)]);
    assert.equal(h.startedAt, "2026-09-09"); assert.equal(h.current, 4);
    const next = advance(h, [], scope("2026-09-13"));
    assert.equal(next.current, 5);
});
test("today pending is distinct from a break and completes immediately", () => {
    const tasks = [task("2026-09-08", false), task("2026-09-12", false)];
    const h = advance(null, tasks);
    assert.equal(h.current, 3);
    const summary = streak.summarize(h, scope(), tasks);
    assert.equal(summary.state, "pending"); assert.equal(summary.remainingTasks.length, 1);
    assert.equal(summary.completedToday, 0);
    assert.equal(advance(h, [task("2026-09-12")]).current, 4);
});
test("summary exposes the main seven-day history without streak-freeze concepts", () => {
    const h = advance(null, [task("2026-09-06"), task("2026-09-09", false)]);
    const week = streak.summarize(h, scope(), []).week;
    assert.deepEqual(week.map(day => day.date), ["2026-09-06", "2026-09-07", "2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11", "2026-09-12"]);
    assert.deepEqual(week.map(day => day.outcome), ["complete", "complete", "complete", "missed", "complete", "complete", "complete"]);
    assert.equal(week.at(-1).today, true);
});
test("a Canvas late flag does not independently break a completed task", () => {
    const h = advance(null, [task("2026-09-08", false), task("2026-09-11", true, { late: true })]);
    assert.equal(h.current, 4);
});
test("late completion cannot erase a recorded miss; support can forgive it", () => {
    const h = advance(null, [task("2026-09-08", false), task("2026-09-10", false)]);
    assert.equal(h.current, 2);
    const next = advance(h, [task("2026-09-10", true)]);
    assert.equal(next.days["2026-09-10"], "missed"); assert.equal(next.current, 2);
    const corrected = streak.recalculate({ ...next, forgiven: ["2026-09-10"] }, scope().today);
    assert.equal(corrected.current, 4);
    assert.equal(streak.recalculate({ ...corrected, forgiven: [] }, scope().today).current, 2);
});
test("recent dates are rechecked; long absences retain all unverified dates", () => {
    const h = advance(null, [task("2026-09-08", false)]);
    assert.equal(streak.plan(h, scope()).range.start, "2026-09-10");
    assert.equal(streak.plan(h, scope("2027-03-01")).range.start, "2026-09-12");
    assert.equal(advance(h, [task("2026-09-11", false)]).current, 1);
});
test("partial reads and invalid ranges never settle or fabricate dates", () => {
    const h = advance(null, []);
    assert.equal(streak.advance(h, [], scope(), { complete: false }).changed, false);
    assert.equal(streak.advance(h, [], scope(), { range: { start: "2026-09-10", end: "2026-09-11" } }).changed, false);
    assert.equal(streak.freeze(h, scope()).state, "stale");
    assert.equal(streak.freeze(null, scope()).state, "unavailable");
});
test("accounts, zones, and legacy policy records stay isolated", () => {
    const h = advance(null, []);
    assert.equal(streak.normalize(h, { ...scope(), accountKey: "other" }).since, null);
    assert.equal(streak.normalize(h, scope("2026-09-12", "UTC")).since, null);
    assert.equal(streak.normalize({ ...h, v: 3 }, scope()).since, null);
});
test("DST dates count as calendar days and unsupported sources do not count", () => {
    const s = scope("2026-03-09");
    const h = advance(null, [task("2026-03-06", false), task("2026-03-08", false, { source: "nest" }), task("2026-03-08", false, { type: "announcement" })], s);
    assert.equal(h.current, 3);
});
test("coordinator serializes map writes and rejects stale lifecycles", async () => {
    let all = {};
    const c = streak.createHistoryCoordinator({ read: async () => all, write: async value => { all = value; } });
    await Promise.all([c.update(scope(), () => ({ write: true, history: advance(null, []) })),
        c.update({ ...scope(), accountKey: "other" }, () => ({ write: true, history: { since: "2026-09-12" } }))]);
    assert.equal(Object.keys(all).length, 2);
    const result = await c.update(scope(), () => { throw Error("must not derive"); }, { isCurrent: () => false });
    assert.equal(result.stale, true);
});

test("seeding does not invent a best before the earliest observed break; owned notes count", () => {
    const h = advance(null, [task("2026-09-08", false), task("2026-09-12", false, {source:"canvas-planner-note",type:"planner_note"})]);
    assert.equal(h.current,3); assert.equal(h.best,3);
});

test("account announcements cannot block streak verification; malformed assignments still do", async () => {
    const fs = require("node:fs");
    const source = fs.readFileSync(require.resolve("../../js/content.js"), "utf8");
    const start = source.indexOf("    async function normalizeCanvasItems(");
    const end = source.indexOf("    const streakSync =", start);
    const model = require("../../js/content/todo-model.js");
    const normalize = new Function("plannerItem", "plannerBindingTimeZone", "storageAreaGet", "chrome", "contentTodoModelApi",
        `${source.slice(start, end)}; return normalizeCanvasItems;`)(x => x, () => "UTC", async () => ({}), {storage:{local:{}}}, model);
    const binding = {origin:"https://canvas.example.edu",userId:123,accountKey:"a".repeat(64),timeZone:"UTC"};
    const task = {plannable_type:"assignment",id:1,course_id:2,due_at:"2026-09-12T20:00:00Z"};
    const result = await normalize([{plannable_type:"announcement",id:9}, {plannable_type:"wiki_page",id:10}, task], binding, {skipUnsupported:true});
    assert.equal(result.complete,true);
    assert.equal(result.tasks.length,1);
    const h = streak.advance(null,result.tasks,scope());
    assert.equal(h.state,"verified");
    assert.equal(h.history.todayComplete,false);
    assert.equal((await normalize([{...task,course_id:null}],binding,{skipUnsupported:true})).complete,false);
});
