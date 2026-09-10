"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const notes = require("../../js/content/dashboard-notes.js");
const registration = require("../../js/platform/canvas-registration.js");

class NoteNode {
    constructor(doc, tag) { this.ownerDocument = doc; this.tagName = tag; this.children = []; this.parentElement = null; this.dataset = {}; this.style = {}; this.attributes = {}; this.listeners = new Map(); this.value = ""; this.scrollHeight = 40; }
    append(...nodes) { nodes.filter(Boolean).forEach((node) => { node.remove?.(); node.parentElement = this; this.children.push(node); }); }
    appendChild(node) { this.append(node); return node; }
    prepend(...nodes) { nodes.filter(Boolean).reverse().forEach((node) => { node.remove?.(); node.parentElement = this; this.children.unshift(node); }); }
    replaceChildren(...nodes) { this.children.forEach((node) => { node.parentElement = null; }); this.children = []; this.append(...nodes); }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((node) => node !== this); this.parentElement = null; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    addEventListener(name, handler) { this.listeners.set(name, handler); }
}
class NoteDocument {
    constructor() { this.documentElement = new NoteNode(this, "html"); this.activeElement = null; }
    createElement(tag) { return new NoteNode(this, tag); }
    createTextNode(text) { const node = new NoteNode(this, "#text"); node.textContent = String(text); return node; }
}
function observerClass() {
    const instances = [];
    class Observer { constructor(callback) { this.callback = callback; this.disconnected = false; instances.push(this); } observe() {} disconnect() { this.disconnected = true; } trigger() { this.callback([]); } }
    Observer.instances = instances;
    return Observer;
}
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
function checkboxStates(container) {
    const preview = container.children[0]?.children[1];
    return (preview?.children || []).flatMap((list) => list.children.map((row) => [row.children[0].dataset.apstudyNoteTaskId, row.children[0].checked]));
}

test("markdown parser keeps deterministic source mappings and caps task sidecars", () => {
    const source = "# Plan\n- [ ] Read **carefully**\n- [x] Ship";
    const tasks = notes.parse(source).filter((entry) => entry.type === "task");
    assert.deepEqual(tasks.map((task) => [task.id, task.start, task.end]), notes.parse(source).filter((entry) => entry.type === "task").map((task) => [task.id, task.start, task.end]));
    assert.equal(tasks[0].start, source.indexOf("- [ ]"));
    assert.equal(notes.parse(Array.from({ length: 120 }, () => "- [ ] bounded").join("\n")).filter((entry) => entry.type === "task").length, notes.MAX_TASKS);
    assert.equal(notes.normalizeSource("x".repeat(notes.MAX_SOURCE_CHARS + 1)).length, notes.MAX_SOURCE_CHARS, "raw source is bounded before any storage write");
    assert.equal(notes.normalizedState({ version: 1, noteId: notes.NOTE_ID, tasks: { foreign: true } }, tasks).tasks.foreign, undefined, "orphan states never survive cleanup");
});
test("unsafe and credentialed markdown URLs are rejected", () => {
    for (const value of ["javascript:alert(1)", "data:text/html,no", "http://example.test", "https://user:pass@example.test/x", "/courses/1"]) assert.equal(notes.safeUrl(value), null, value);
    assert.equal(notes.safeUrl("https://canvas.example.test/courses/1"), "https://canvas.example.test/courses/1");
});
test("checkbox state is separate, prunes orphans, rolls back failures, and serializes writes", async () => {
    const tasks = notes.parse("- [ ] One\n- [ ] Two").filter((entry) => entry.type === "task"); const writes = [];
    const storage = { async get() { return { [notes.STATE_KEY]: { version: 1, noteId: notes.NOTE_ID, tasks: { [tasks[0].id]: true, stale: true } } }; }, async set(value) { writes.push(value); } };
    const store = notes.createPersistence({ storage }); await store.load(tasks); assert.deepEqual(store.state().tasks, { [tasks[0].id]: true });
    await Promise.all([store.save(tasks, tasks[0].id, false), store.save(tasks, tasks[1].id, true)]);
    assert.equal(writes.at(-1)[notes.STATE_KEY].tasks[tasks[1].id], true);
    const errors = []; const failing = notes.createPersistence({ storage: { async get() { return {}; }, async set() { throw new Error("quota"); } }, onError: (message) => errors.push(message) });
    await failing.load(tasks); const result = await failing.save(tasks, tasks[0].id, true); assert.equal(result.ok, false); assert.equal(failing.state().tasks[tasks[0].id], undefined); assert.match(errors[0], /restored/);
});
test("a failed checkbox write cannot leak into a later successful checkbox write", async () => {
    const tasks = notes.parse("- [ ] One\n- [ ] Two").filter((entry) => entry.type === "task");
    const writes = [];
    let calls = 0;
    const storage = {
        async get() { return {}; },
        async set(value) {
            calls += 1;
            if (calls === 1) throw new Error("quota");
            writes.push(value);
        }
    };
    const store = notes.createPersistence({ storage });
    await store.load(tasks);
    const [first, second] = await Promise.all([
        store.save(tasks, tasks[0].id, true),
        store.save(tasks, tasks[1].id, true)
    ]);
    assert.equal(first.ok, false);
    assert.equal(second.ok, true);
    assert.deepEqual(writes, [{ [notes.STATE_KEY]: { version: 1, noteId: notes.NOTE_ID, tasks: { [tasks[1].id]: true } } }]);
    assert.deepEqual(store.state().tasks, { [tasks[1].id]: true });
});
test("two failed rapid toggles of one checkbox restore its last stored state", async () => {
    const [task] = notes.parse("- [ ] One").filter((entry) => entry.type === "task");
    const errors = [];
    const store = notes.createPersistence({
        storage: { async get() { return {}; }, async set() { throw new Error("quota"); } },
        onError: (message) => errors.push(message)
    });
    await store.load([task]);
    const [checked, unchecked] = await Promise.all([
        store.save([task], task.id, true),
        store.save([task], task.id, false)
    ]);
    assert.equal(checked.ok, false);
    assert.equal(unchecked.ok, false);
    assert.deepEqual(store.state().tasks, {}, "both failed writes return to the persisted unchecked value");
    assert.equal(errors.length, 2);
});
test("dashboard notes register before content for static and dynamic Firefox-compatible injection", () => {
    const root = path.resolve(__dirname, "../.."); const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8")); const scripts = manifest.content_scripts.find((entry) => entry.js?.includes("js/content.js")).js;
    assert.deepEqual(scripts, registration.CANVAS_CONTENT_SCRIPTS);
    ["js/content/card-appearance.js", "js/content/dashboard-notes.js"].forEach((script) => {
        assert.equal(scripts.filter((entry) => entry === script).length, 1, `${script} has one static registration`);
        assert.equal(registration.CANVAS_CONTENT_SCRIPTS.filter((entry) => entry === script).length, 1, `${script} has one dynamic registration`);
        assert.ok(scripts.indexOf(script) < scripts.indexOf("js/content.js"), `${script} loads before content`);
    });
    assert.ok(scripts.indexOf("js/content/card-appearance.js") < scripts.indexOf("js/content/dashboard-notes.js"), "card appearance precedes notes consistently");
    const source = fs.readFileSync(path.join(root, "js/content.js"), "utf8"); assert.match(source, /APStudyCanvasContent\?\.DashboardNotes/); assert.match(source, /function teardownDashboardNotes\(\)[\s\S]{0,160}dashboardNotesController\?\.destroy\(\)/); assert.match(source, /applyQuizSafeRouteGuard\(\)[\s\S]{0,700}teardownDashboardNotes\(\)/); assert.match(source, /\["dashboard_notes", "dashboard_notes_text"\]/, "storage updates rerender the mounted note");
});

test("notes wait only briefly for Canvas cards, then mount once when the cards arrive", async () => {
    const document = new NoteDocument(); const Observer = observerClass(); const timers = [];
    let cards = null;
    const controller = notes.createDashboardNotes({
        document,
        storage: { async get() { return {}; }, async set() {} },
        mutationObserver: Observer,
        setTimer(callback) { timers.push(callback); return timers.length; },
        clearTimer() {}
    });
    assert.equal(controller.reconcile({ source: "A preserved note", getContainer: () => cards }), false);
    assert.equal(controller.isWaiting(), true, "missing cards start the bounded readiness watch");
    cards = new NoteNode(document, "main");
    Observer.instances[0].trigger();
    await Promise.resolve(); await Promise.resolve();
    assert.equal(controller.isMounted(), true);
    assert.equal(cards.children.filter((node) => node.className === "canvasrefined-dashboard-notes").length, 1, "the delayed Canvas root receives one note");
    assert.equal(Observer.instances[0].disconnected, true, "the observer stops after the anchor is found");
    assert.equal(timers.length, 1, "readiness owns one bounded timeout, not a polling loop");
});

test("notes remount after an analytics-route return without duplicating or overwriting source", async () => {
    const document = new NoteDocument(); const first = new NoteNode(document, "main"); const second = new NoteNode(document, "main");
    let cards = first;
    const controller = notes.createDashboardNotes({ document, storage: { async get() { return {}; }, async set() {} } });
    controller.reconcile({ source: "Original note", getContainer: () => cards });
    await Promise.resolve(); await Promise.resolve();
    cards = second;
    controller.reconcile({ source: "Original note", getContainer: () => cards });
    await Promise.resolve(); await Promise.resolve();
    assert.equal(first.children.length, 0, "the previous Canvas root does not retain an orphan note");
    assert.equal(second.children.filter((node) => node.className === "canvasrefined-dashboard-notes").length, 1);
    assert.equal(second.children[0].children[0].value, "Original note");
});

for (const [name, initial, next, persisted] of [
    ["edit", "- [ ] Before", "- [ ] After", true],
    ["reorder", "- [ ] First\n- [ ] Second", "- [ ] Second\n- [ ] First", true],
    ["add", "- [ ] One", "- [ ] One\n- [ ] Two", true],
    ["remove", "- [ ] One\n- [ ] Two", "- [ ] Two", true]
]) {
    test(`notes ${name} during a deferred state read reloads only the latest task set`, async () => {
        const document = new NoteDocument(); const cards = new NoteNode(document, "main"); const first = deferred(); const second = deferred(); let reads = 0;
        const controller = notes.createDashboardNotes({
            document,
            storage: {
                get() { reads += 1; return reads === 1 ? first.promise : second.promise; },
                async set() {}
            }
        });
        controller.reconcile({ source: initial, getContainer: () => cards });
        controller.reconcile({ source: next, getContainer: () => cards });
        first.resolve({ [notes.STATE_KEY]: { version: 1, noteId: notes.NOTE_ID, tasks: Object.fromEntries(notes.parse(initial).filter((item) => item.type === "task").map((item) => [item.id, true])) } });
        await Promise.resolve(); await Promise.resolve();
        assert.equal(reads, 2, "the stale completion starts one replacement read");
        const latestTasks = notes.parse(next).filter((item) => item.type === "task");
        second.resolve({ [notes.STATE_KEY]: { version: 1, noteId: notes.NOTE_ID, tasks: Object.fromEntries(latestTasks.map((item) => [item.id, persisted])) } });
        await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
        assert.equal(cards.children[0].children[0].value, next, "the latest note text remains mounted");
        assert.deepEqual(checkboxStates(cards), latestTasks.map((item) => [item.id, persisted]), "only checkbox state normalized for the latest source is rendered");
    });
}

test("a stale dashboard-note state read cannot overwrite a newer completed read", async () => {
    const document = new NoteDocument(); const cards = new NoteNode(document, "main"); const first = deferred(); const second = deferred(); let reads = 0;
    const controller = notes.createDashboardNotes({ document, storage: { get() { reads += 1; return reads === 1 ? first.promise : second.promise; }, async set() {} } });
    controller.reconcile({ source: "- [ ] Old", getContainer: () => cards });
    controller.reconcile({ source: "- [ ] New", getContainer: () => cards });
    first.resolve({ [notes.STATE_KEY]: { version: 1, noteId: notes.NOTE_ID, tasks: {} } });
    await Promise.resolve(); await Promise.resolve();
    const [newTask] = notes.parse("- [ ] New").filter((item) => item.type === "task");
    second.resolve({ [notes.STATE_KEY]: { version: 1, noteId: notes.NOTE_ID, tasks: { [newTask.id]: true } } });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    assert.deepEqual(checkboxStates(cards), [[newTask.id, true]]);
    assert.equal(cards.children[0].children[0].value, "- [ ] New", "the stale completion cannot repaint its source");
});

test("destroy cancels a pending dashboard-note state read before it can paint", async () => {
    const document = new NoteDocument(); const cards = new NoteNode(document, "main"); const pending = deferred();
    const controller = notes.createDashboardNotes({ document, storage: { get() { return pending.promise; }, async set() {} } });
    controller.reconcile({ source: "- [ ] Keep", getContainer: () => cards });
    controller.destroy();
    pending.resolve({ [notes.STATE_KEY]: { version: 1, noteId: notes.NOTE_ID, tasks: {} } });
    await Promise.resolve(); await Promise.resolve();
    assert.equal(controller.isMounted(), false);
    assert.equal(cards.children.length, 0, "a cancelled read cannot restore the removed root");
});

test("disabled notes cancel a pending Canvas-anchor watch and never mount later", () => {
    const document = new NoteDocument(); const Observer = observerClass(); let cards = null;
    const controller = notes.createDashboardNotes({ document, storage: { async get() { return {}; }, async set() {} }, mutationObserver: Observer });
    controller.reconcile({ source: "Keep stored text", getContainer: () => cards });
    controller.reconcile({ enabled: false });
    cards = new NoteNode(document, "main");
    Observer.instances[0].trigger();
    assert.equal(controller.isMounted(), false);
    assert.equal(cards.children.length, 0);
});
