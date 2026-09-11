"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { Document, walk } = require("./helpers/dom.js");
const model = require("../../js/content/workspace-model.js");
const notesApi = require("../../js/workspace-notes.js");

const canvas = { origin: "https://canvas.emory.edu", accountId: "42" };
const context = value => ({ account: { canvas: { verified: true, ...value } } });
const note = (id, title, body, updatedAt = 1, extra = {}) => ({ id, title, body, courseId: "", updatedAt, deleted: false, ...extra });

function documentHarness() {
    const doc = new Document();
    const base = doc.createElement.bind(doc);
    doc.createElement = tag => {
        const node = base(tag);
        node.type = "";
        node.disabled = false;
        node.selectionStart = null;
        node.selectionEnd = null;
        return node;
    };
    return doc;
}

function storageHarness(seed) {
    let data = structuredClone(seed || {});
    let failure = null;
    return {
        storage: {
            get: async key => structuredClone({ [key]: data[key] }),
            set: async value => {
                if (failure) throw new Error(failure);
                data = { ...data, ...structuredClone(value) };
            }
        },
        read: key => structuredClone(data[key]),
        fail: message => { failure = message; }
    };
}

async function harness({ seed, verify, confirm = () => false } = {}) {
    const doc = documentHarness();
    const host = doc.createElement("main");
    const memory = storageHarness(seed);
    const dirtyEvents = [];
    let account = canvas;
    let id = 0;
    const module = notesApi.createWorkspaceNotes({
        document: doc,
        window: { confirm, crypto: { randomUUID: () => `new-${++id}` } },
        host,
        model,
        storage: memory.storage,
        verifyAccount: verify || (async () => account),
        readCourses: async () => [{ id: 7, name: "Biology" }, { id: 8, name: "History" }],
        now: () => 1000 + id,
        onDirtyChange: value => dirtyEvents.push(value)
    });
    await module.mount(context(canvas), {});
    const all = () => walk(host);
    const text = () => all().map(node => node.textContent).join(" ");
    const role = name => all().find(node => node.dataset.notesRole === name);
    const button = label => all().find(node => node.tagName === "button" && node.textContent === label);
    const field = label => all().find(node => node.tagName === "label" && node.children[0]?.textContent === label)?.children[1];
    const click = label => {
        const node = button(label);
        assert.ok(node, `button ${label}`);
        node.dispatchEvent({ type: "click" });
    };
    const input = (label, value) => {
        const node = field(label);
        assert.ok(node, `field ${label}`);
        node.value = value;
        node.dispatchEvent({ type: node.tagName === "select" ? "change" : "input" });
    };
    const settle = () => new Promise(resolve => setImmediate(resolve));
    return { module, host, memory, dirtyEvents, all, text, role, button, field, click, input, settle, setAccount: value => { account = value; } };
}

test("Notes accepts only a verified numeric Canvas account and preserves the legacy workspace key", async () => {
    assert.deepEqual(notesApi.accountFromContext(context(canvas)), canvas);
    for (const bad of [
        context({ ...canvas, verified: false }),
        context({ ...canvas, accountId: "canvas:42" }),
        context({ ...canvas, origin: "http://canvas.emory.edu" }),
        context({ ...canvas, origin: "https://canvas.emory.edu/path" })
    ]) assert.equal(notesApi.accountFromContext(bad), null);

    const key = model.storageKey(canvas);
    const existing = model.empty();
    existing.study.push({ id: "study-1", title: "Cells", courseId: "7", updatedAt: 10, cards: [{ id: "card-1", question: "Cell boundary?", answer: "Membrane" }] });
    existing.planner.push({ id: "plan-1", title: "Read", courseId: "7", updatedAt: 11, date: "2026-09-11" });
    const h = await harness({ seed: { [key]: existing } });
    h.click("New note");
    h.input("Title", "  Lecture   one  ");
    h.input("Course association", "7");
    h.input("Note text", "Cell membrane and transport");
    assert.equal(h.module.queryDirty(), true);
    assert.deepEqual(h.dirtyEvents, [true]);
    h.click("Save note");
    await h.settle();

    const saved = h.memory.read(key);
    assert.equal(saved.notes[0].title, "Lecture one");
    assert.equal(saved.notes[0].courseId, "7");
    assert.equal(saved.study[0].id, "study-1");
    assert.equal(saved.planner[0].id, "plan-1");
    assert.equal(h.module.queryDirty(), false);
    assert.deepEqual(h.dirtyEvents, [true, false]);
});

test("explicit save failure keeps the draft dirty and retry commits it", async () => {
    const h = await harness();
    h.click("New note");
    h.input("Title", "Failure draft");
    h.input("Note text", "This must survive the failed write.");
    h.memory.fail("Disk full");
    h.click("Save note");
    await h.settle();
    assert.match(h.text(), /Disk full.*draft is still here/i);
    assert.equal(h.field("Note text").value, "This must survive the failed write.");
    assert.equal(h.module.queryDirty(), true);

    h.memory.fail(null);
    h.click("Save note");
    await h.settle();
    assert.equal(h.memory.read(model.storageKey(canvas)).notes[0].title, "Failure draft");
    assert.equal(h.module.queryDirty(), false);
});

test("dirty route and narrow Back navigation preserve the draft when discard is declined", async () => {
    const key = model.storageKey(canvas);
    const state = model.empty();
    state.notes.push(note("a", "Alpha", "First"), note("b", "Beta", "Second", 2));
    const h = await harness({ seed: { [key]: state }, confirm: () => false });
    h.click("Alpha");
    h.input("Note text", "Unsaved first");
    await h.module.routeUpdate({ noteId: "b", query: "beta" });
    assert.equal(h.field("Title").value, "Alpha");
    assert.equal(h.field("Note text").value, "Unsaved first");
    assert.match(h.text(), /Save or discard this draft/);
    h.click("Back to notes");
    assert.equal(h.field("Title").value, "Alpha");
    assert.equal(h.host.children[0].className.includes("is-editor-open"), true);
});

test("trash, restore, filters, focus retention, and local search stay account scoped", async () => {
    const key = model.storageKey(canvas);
    const state = model.empty();
    state.notes.push(
        note("old", "Zoology", "Membrane notes", 1, { courseId: "7" }),
        note("new", "Archive", "Primary sources", 2, { courseId: "8" })
    );
    const h = await harness({ seed: { [key]: state } });
    h.input("Search notes", "membrane");
    assert.equal(h.role("search"), h.role("search").ownerDocument.activeElement);
    assert.match(h.text(), /Zoology/);
    assert.doesNotMatch(h.text(), /Archive/);
    h.input("Search notes", "");
    h.input("Sort", "title");
    const titles = h.all().filter(node => node.className === "workspace-notes-row-open").map(node => node.textContent);
    assert.deepEqual(titles, ["Archive", "Zoology"]);

    h.click("Archive");
    h.click("Move to trash");
    await h.settle();
    h.input("Show", "trash");
    assert.ok(h.button("Restore"));
    h.click("Restore");
    await h.settle();
    assert.equal(h.memory.read(key).notes.find(item => item.id === "new").deleted, false);

    const matches = await h.module.search("primary", context(canvas));
    assert.deepEqual(matches.map(item => [item.label, item.route, item.detail.noteId]), [["Archive", "notes", "new"]]);
    const other = await harness({
        seed: { [key]: h.memory.read(key) },
        verify: async () => ({ ...canvas, accountId: "99" })
    });
    assert.deepEqual(await other.module.search("primary", context({ ...canvas, accountId: "99" })), []);
});

test("account changes block writes, retain the draft, and dispose is idempotent", async () => {
    const h = await harness();
    h.click("New note");
    h.input("Title", "Account-bound draft");
    h.input("Note text", "Remain visible");
    h.setAccount({ ...canvas, accountId: "99" });
    await h.module.routeUpdate({ query: "draft" });
    assert.match(h.text(), /account changed/i);
    h.click("Save note");
    await h.settle();
    assert.equal(h.field("Note text").value, "Remain visible");
    assert.equal(h.module.queryDirty(), true);
    assert.equal(h.memory.read(model.storageKey(canvas)), undefined);

    await h.module.dispose("route-change");
    await h.module.dispose("route-change");
    assert.equal(h.host.children.length, 0);
    assert.equal(h.module.queryDirty(), false);
    assert.deepEqual(h.dirtyEvents, [true, false]);
});

test("Notes CSS keeps adjacent desktop panes and a narrow list-to-editor Back flow", () => {
    const css = require("node:fs").readFileSync(require("node:path").join(__dirname, "../../css/workspace-notes.css"), "utf8");
    assert.match(css, /grid-template-columns:\s*minmax\(280px,[^)]+\)\s+minmax\(420px,/);
    assert.match(css, /@container shell \(max-width: 760px\)[\s\S]*\.workspace-notes\.is-editor-open \.workspace-notes-library \{ display: none; \}/);
    assert.match(css, /@container shell \(max-width: 760px\)[\s\S]*\.workspace-notes-back \{ display: inline-flex;/);
    assert.match(css, /\.workspace-notes-row-open \{[^}]*min-height: 44px;/);
});
