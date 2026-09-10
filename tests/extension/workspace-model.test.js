"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const model = require("../../js/content/workspace-model.js");
const gpa = require("../../js/content/gpa.js");
const context = { origin: "https://canvas.emory.edu", accountId: "42" };
const note = id => ({ id, title: id, body: "hello", courseId: "", updatedAt: 1 });
function memory() { let data = {}; return { get: async key => structuredClone({ [key]: data[key] }), set: async value => { data = { ...data, ...structuredClone(value) }; } }; }
test("workspace storage is isolated by exact verified Canvas origin and account", async () => {
    const storage = memory();
    const first = model.createStore({storage,context});
    await first.transact(s => s.notes.push(note("a")));
    for (const other of [{...context, accountId:"43"},{...context, origin:"https://school.instructure.com"}]) assert.equal((await model.createStore({storage,context:other}).load()).notes.length, 0);
    for (const bad of [{...context,accountId:""},{...context,origin:"http://canvas.emory.edu"},{...context,origin:"https://canvas.emory.edu/"}]) assert.throws(() => model.storageKey(bad));
    assert.equal((await first.load()).notes.length,1);
});
test("changed account and storage failures preserve prior state and allow retry", async () => {
    const storage = memory(); let user = context, fail = false;
    const baseSet = storage.set; storage.set = async value => { if (fail) throw new Error("Disk full"); await baseSet(value); };
    const store = model.createStore({storage,context,verify:async () => user});
    await store.transact(s => s.notes.push(note("a")));
    user = {...context,accountId:"99"};
    await assert.rejects(store.transact(s => s.notes.push(note("b"))), /account changed/);
    user = context; fail = true;
    await assert.rejects(store.transact(s => s.notes.push(note("b"))), /Disk full/);
    assert.equal(store.snapshot().notes.length,1);
    fail = false; await store.transact(s => s.notes.push(note("b")));
    assert.equal((await store.load()).notes.length,2);
});
test("serialized edits re-read storage and preserve sequential changes from another tab", async () => {
    const storage = memory(), a = model.createStore({storage,context}), b = model.createStore({storage,context});
    await a.load(); await b.transact(s => s.notes.push(note("b")));
    await Promise.all([a.transact(s => s.notes.push(note("a"))),a.transact(s => s.notes.push(note("c")))]);
    assert.deepEqual((await a.load()).notes.map(n => n.id),["b","a","c"]);
});
test("malformed and oversized records are rejected without overwriting saved material", async () => {
    const storage = memory(), store = model.createStore({storage,context});
    await store.transact(s => s.notes.push(note("a")));
    await assert.rejects(store.transact(s => { s.notes[0].body = "x".repeat(100001); }), /invalid/);
    await assert.rejects(store.transact(s => s.study.push({...note("b"),cards:[]})), /invalid/);
    await assert.rejects(store.transact(s => { s.grades.priorCredits = -1; }), /invalid/);
    assert.equal((await store.load()).notes[0].body,"hello");
    await storage.set({[model.storageKey(context)]: {version:2}});
    await assert.rejects(store.load(), /not been overwritten/);
});
test("GPA counts zero scores, excludes missing grades and uses credit weighting", () => {
    const courses = [0,90,null].map((score,i) => ({id:i+1,enrollments:[{type:"student",computed_current_score:score}]}));
    const settings = {courses:{1:{credits:1},2:{credits:3},3:{credits:3}},priorGpa:"",priorCredits:100};
    const bounds = {A:{cutoff:90,gpa:4},F:{cutoff:0,gpa:0}};
    let result = model.gradeSummary(courses,settings,bounds,gpa);
    assert.equal(result.term,3); assert.equal(result.cumulative,3); assert.equal(result.rows[2].score,null);
    settings.priorGpa=2; settings.priorCredits=4;
    assert.equal(model.gradeSummary(courses,settings,bounds,gpa).cumulative,2.5);
    settings.courses[1].whatIf=100;
    assert.equal(model.gradeSummary(courses,settings,bounds,gpa,true).term,4);
    assert.equal(model.gradeSummary(courses,settings,bounds,gpa,false).term,3);
    settings.courses[1].included=false;
    assert.equal(model.gradeSummary(courses,settings,bounds,gpa).term,4);
});
test("calendar ranges cross month/year boundaries and typed answers normalize whitespace", () => {
    const day = new Date(2026,11,30,12);
    const week = model.range(day,"week");
    assert.equal(model.dateKey(week.end),"2027-01-06");
    assert.equal(model.dateKey(model.range(day,"month").end),"2027-01-01");
    assert.equal(model.answerMatches("  Cell  WALL ","cell wall"),true);
    assert.equal(model.answerMatches("cell wall","cell membrane"),false);
});
