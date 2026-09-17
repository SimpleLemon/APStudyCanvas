"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Document, walk } = require("./helpers/dom.js");
const adapterApi = require("../../js/workspace-planner-adapter.js");
const plannerApi = require("../../js/workspace-planner.js");

const ACCOUNT_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const context = (scope = "canvas:one") => ({
    account: {
        scope,
        canvas: { verified: true, accountKey: ACCOUNT_KEY, origin: "https://canvas.example.edu" },
        nest: { verified: true, identity: "nest-user" }
    }
});
const personal = (overrides = {}) => ({ event_ref: "user:block-1", source_type: "user", editable: true, title: "Study block", start: "2026-09-11T14:00:00.000Z", end: "2026-09-11T15:00:00.000Z", calendar_id: "personal", color: "#355f8a", ...overrides });
const deadline = (overrides = {}) => ({ event_ref: "canvas:due-1", source_type: "canvas", editable: false, title: "Essay due", start: "2026-09-11T16:00:00.000Z", end: "2026-09-11T17:00:00.000Z", source_label: "Canvas", source_color: "#8a4b35", ...overrides });

test("shell Planner mounts before preferences and disposal cancels pending initialization", async () => {
    const doc = documentHarness(); const host = doc.createElement("main"); const adapter = adapterHarness();
    let finish;
    const module = plannerApi.createWorkspacePlanner({ document: doc, host, adapter,
        preferences: { get: () => new Promise(resolve => { finish = resolve; }) } });
    await module.mount({ ...context(), deferInitialLoad: true });
    assert.ok(finish);
    assert.ok(host.children.length);
    await module.dispose();
    finish({});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(adapter.calls.filter(call => call[0] === "loadRange").length, 0);
});

function documentHarness() {
    const doc = new Document();
    const create = doc.createElement.bind(doc);
    doc.createElement = tag => {
        const node = create(tag);
        node.type = ""; node.disabled = false; node.checked = false; node.tabIndex = -1; node.step = "";
        node.setAttribute = function (key, value) { this.attributes[key] = String(value); if (key === "draggable") this.draggable = String(value) === "true"; };
        return node;
    };
    return doc;
}

function adapterHarness({ access = { read: true, write: true, code: null }, events = [personal(), deadline()], failCreate = false } = {}) {
    let state = {
        access, loading: false, range: null, events: structuredClone(events), visibleEvents: structuredClone(events),
        sources: [{ id: "personal", label: "Personal", color: "#355f8a", writable: true }, { id: "Canvas", label: "Canvas", color: "#8a4b35", writable: false }],
        filters: { sourceIds: [], kinds: [], showCompleted: true }, drafts: {}, import: null, error: null
    };
    const listeners = new Set();
    const calls = [];
    const publish = patch => { state = { ...state, ...patch }; listeners.forEach(listener => listener(structuredClone(state))); };
    const api = {
        calls,
        helpers: adapterApi,
        snapshot: () => structuredClone(state),
        subscribe(listener) { listeners.add(listener); listener(structuredClone(state)); return () => listeners.delete(listener); },
        refreshAccess() { publish({ access }); return structuredClone(state); },
        async loadRange({ anchor, view, useMonthGrid }) {
            calls.push(["loadRange", { view, useMonthGrid }]);
            const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
            const range = view === "month" && useMonthGrid ? adapterApi.monthGridRange(anchor, zone) : adapterApi.rangeForView(anchor, view, zone);
            publish({ range }); return structuredClone(state);
        },
        setFilters(filters) { calls.push(["setFilters", filters]); publish({ filters: { ...state.filters, ...filters } }); return structuredClone(state); },
        async createEvent(payload) { calls.push(["createEvent", payload]); if (failCreate) { publish({ drafts: { create: { ...payload, error: "SAVE_FAILED" } }, error: "SAVE_FAILED" }); return { ok: false, code: "SAVE_FAILED" }; } return { ok: true }; },
        async updateEvent(event, payload) { calls.push(["updateEvent", event, payload]); return { ok: true }; },
        async moveEvent(event, start, end) { calls.push(["moveEvent", event, start, end]); return { ok: true }; },
        async resizeEvent(event, end) { calls.push(["resizeEvent", event, end]); return { ok: true }; },
        async deleteEvent(event) { calls.push(["deleteEvent", event]); return { ok: true }; },
        async importEvents(items) { calls.push(["importEvents", items]); return { originals: items, results: items.map(item => ({ sourceId: item.event_ref, ok: true })) }; },
        dispose() { calls.push(["dispose"]); listeners.clear(); }
    };
    return api;
}

async function harness(options = {}) {
    const doc = documentHarness();
    const host = doc.createElement("main");
    const adapter = options.adapter || adapterHarness(options);
    const dirty = [];
    const stored = options.stored || null;
    const preferences = {
        get: async key => stored ? { [key]: stored } : {},
        set: async value => { adapter.calls.push(["preferences", value]); }
    };
    const module = plannerApi.createWorkspacePlanner({
        document: doc, window: { confirm: () => true }, host, adapter, preferences,
        now: () => new Date("2026-09-11T12:08:00.000Z"), onDirtyChange: value => dirty.push(value)
    });
    await module.mount(context(), options.route || {});
    const all = () => walk(host);
    const role = name => all().find(node => node.dataset.plannerRole === name);
    const button = label => all().find(node => node.tagName === "button" && node.textContent === label);
    const text = () => all().map(node => node.textContent).join(" ");
    const click = label => { const node = button(label); assert.ok(node, `button ${label}`); node.dispatchEvent({ type: "click" }); };
    const input = (roleName, value) => { const node = role(roleName); assert.ok(node, `role ${roleName}`); node.value = value; node.dispatchEvent({ type: "input" }); };
    const settle = () => new Promise(resolve => setImmediate(resolve));
    return { module, adapter, host, dirty, all, role, button, text, click, input, settle };
}

test("Planner defaults to a Sunday-aligned Week and remembers explicit view/date preferences", async () => {
    const h = await harness();
    assert.equal(h.adapter.calls[0][0], "loadRange");
    assert.deepEqual(h.adapter.calls[0][1], { view: "week", useMonthGrid: false });
    assert.ok(h.role("view-week"));
    assert.equal(h.role("view-week").attributes["aria-pressed"], "true");
    const weekHeadings = h.all().filter(node => node.parentElement?.className === "workspace-planner-week-heading" && node.tagName === "button");
    assert.equal(weekHeadings.length, 7);
    assert.match(weekHeadings[0].textContent, /^Sun/);

    h.click("Month");
    await h.settle();
    assert.equal(h.adapter.calls.some(([name, value]) => name === "loadRange" && value.view === "month" && value.useMonthGrid), true);
    assert.equal(h.adapter.calls.some(([name, value]) => name === "preferences" && value[Object.keys(value)[0]].view === "month"), true);
    assert.equal(h.all().filter(node => node.className.includes("workspace-planner-month-weekday")).length, 7);
    assert.match(h.text(), /30.*31.*1.*2/);
});

test("verified identity and consent gates expose only explicit recovery actions", async () => {
    const connect = adapterHarness({ access: { read: false, write: false, code: "PLANNER_ACCOUNT_UNVERIFIED" }, events: [] });
    const h = await harness({ adapter: connect });
    assert.match(h.text(), /verified Canvas and Nest account/);
    assert.ok(h.button("Connect Nest"));
    assert.equal(connect.calls.some(([name]) => name === "loadRange"), false);

    const consent = adapterHarness({ access: { read: false, write: false, code: "PLANNER_READ_CONSENT_REQUIRED" }, events: [] });
    const h2 = await harness({ adapter: consent });
    assert.match(h2.text(), /before Planner reads any existing events/);
    assert.ok(h2.button("Review access"));
    assert.equal(consent.calls.some(([name]) => name === "loadRange"), false);

    const readOnly = adapterHarness({ access: { read: true, write: false, code: "PLANNER_WRITE_CONSENT_REQUIRED" } });
    const h3 = await harness({ adapter: readOnly });
    assert.match(h3.text(), /Planner is read-only/);
    assert.ok(h3.button("Review editing access"));
    assert.equal(h3.button("New time block").disabled, true);
});

test("date-only all-day events stay on their civil calendar date", async () => {
    const allDay = deadline({ event_ref: "canvas:all-day", title: "All-day deadline", start: "2026-09-11", end: "2026-09-12", is_all_day: true });
    const h = await harness({ events: [allDay], route: { view: "day", date: "2026-09-11" } });
    assert.match(h.text(), /All-day deadline/);
    h.all().find(node => node.dataset.eventId === "canvas:all-day").dispatchEvent({ type: "click" });
    assert.match(h.text(), /Fri, Sep 11 · All day/);
});

test("create form uses a one-hour snapped default and failed saves keep an honest dirty draft", async () => {
    const h = await harness({ failCreate: true });
    h.click("New time block");
    assert.equal(h.role("start-time").value, "08:15");
    assert.equal(h.role("end-time").value, "09:15");
    h.input("title", "Read chapter");
    h.click("Save time block");
    await h.settle();
    const call = h.adapter.calls.find(([name]) => name === "createEvent");
    assert.ok(call);
    assert.equal((Date.parse(call[1].end) - Date.parse(call[1].start)) / 60000, 60);
    assert.equal(h.module.queryDirty(), true);
    assert.equal(h.role("title").value, "Read chapter");
    assert.match(h.text(), /draft is still here/i);
    assert.deepEqual(h.dirty, [true]);
});

test("Canvas deadlines remain view-only while explicit import waits for confirmation", async () => {
    const h = await harness();
    const due = h.all().find(node => node.dataset.eventId === "canvas:due-1");
    assert.ok(due); due.dispatchEvent({ type: "click" });
    assert.match(h.text(), /Canvas deadline · View only/);
    assert.equal(Boolean(h.button("Edit details")), false);
    assert.match(h.text(), /authoritative in Canvas/);

    h.click("Import existing tasks");
    assert.match(h.text(), /nothing uploads until you confirm/);
    assert.equal(h.adapter.calls.some(([name]) => name === "importEvents"), false);
    h.click("Import selected tasks");
    await h.settle();
    const imported = h.adapter.calls.find(([name]) => name === "importEvents");
    assert.equal(imported[1].length, 1);
    assert.equal(imported[1][0].event_ref, "canvas:due-1");
    assert.match(h.text(), /Original tasks were not changed/);
});

test("personal details route move, resize, edit, and delete through adapter operations", async () => {
    const h = await harness();
    h.all().find(node => node.dataset.eventId === "user:block-1").dispatchEvent({ type: "click" });
    h.click("15 min later"); await h.settle();
    h.all().find(node => node.dataset.eventId === "user:block-1").dispatchEvent({ type: "click" });
    h.click("Extend 15 min"); await h.settle();
    h.all().find(node => node.dataset.eventId === "user:block-1").dispatchEvent({ type: "click" });
    h.click("Edit details"); h.input("title", "Revised block"); h.click("Save time block"); await h.settle();
    h.all().find(node => node.dataset.eventId === "user:block-1").dispatchEvent({ type: "click" });
    h.click("Delete"); await h.settle();
    assert.equal(h.adapter.calls.some(([name]) => name === "moveEvent"), true);
    assert.equal(h.adapter.calls.some(([name]) => name === "resizeEvent"), true);
    assert.equal(h.adapter.calls.some(([name]) => name === "updateEvent"), true);
    assert.equal(h.adapter.calls.some(([name]) => name === "deleteEvent"), true);
});

test("account changes preserve dirty UI truth and dispose is idempotent", async () => {
    const h = await harness();
    h.click("New time block"); h.input("title", "Keep this draft");
    await h.module.routeUpdate({ view: "week" }, context("canvas:two"));
    assert.match(h.text(), /account changed.*unsaved draft is still here/i);
    assert.equal(h.module.queryDirty(), true);
    await h.module.dispose("route-change"); await h.module.dispose("route-change");
    assert.equal(h.host.children.length, 0);
    assert.equal(h.module.queryDirty(), false);
    assert.equal(h.adapter.calls.filter(([name]) => name === "dispose").length, 1);
    assert.deepEqual(h.dirty, [true, false]);
});

test("Planner CSS encodes seven-column views, shared axes, overlap positioning, now marker, and narrow editor flow", () => {
    const css = fs.readFileSync(path.join(__dirname, "../../css/workspace-planner.css"), "utf8");
    assert.match(css, /grid-template-columns:\s*repeat\(7, minmax\(108px, 1fr\)\)/);
    assert.match(css, /grid-template-columns:\s*64px repeat\(var\(--planner-days\), minmax\(110px, 1fr\)\)/);
    assert.match(css, /\.workspace-planner-event \{[^}]*position: absolute;/);
    assert.match(css, /\.workspace-planner-now \{[^}]*height: 2px;/);
    assert.match(css, /@container shell \(max-width: 620px\)[\s\S]*\.workspace-planner-body\.has-panel \.workspace-planner-main \{ display: none; \}/);
    assert.doesNotMatch(css, /grid-template-columns:\s*repeat\(5,/);
});
