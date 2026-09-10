"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const planner = require("../../js/content/planner-tasks.js");
const bridgeApi = require("../../js/platform/planner-page-bridge.js");
const transportApi = require("../../js/content/planner-page-transport.js");
const model = require("../../js/content/todo-model.js");
const todoApi = require("../../js/content/todo-api.js");

const ORIGIN = "https://canvas.example.edu";
const ACCOUNT = "a".repeat(64);
const documentForOrigin = (origin = ORIGIN, cookie = "", metaToken = "") => ({
    location: { href: `${origin}/` },
    cookie,
    querySelector: (selector) => selector.includes("csrf") && metaToken ? { getAttribute: (name) => name === "content" ? metaToken : null } : null
});

function response(status, body = {}, link = "") {
    return { ok: status >= 200 && status < 300, status, headers: { get: (name) => String(name).toLowerCase() === "link" ? link : null }, json: async () => body };
}

function bridgeSender() {
    return { tab: { id: 17, url: `${ORIGIN}/calendar` }, url: `${ORIGIN}/calendar`, frameId: 0 };
}

function bridgeFactory(dispatches) {
    return bridgeApi.createPlannerPageBridge({
        allowedOrigins: [ORIGIN],
        chromeApi: { scripting: { async executeScript(options) {
            dispatches.push(options.args?.[0]?.method || "cancel");
            return [{ result: { ok: true, status: 201, body: { id: 91 }, headers: {} } }];
        } } }
    });
}

test("planner markers are stable, visible only as data, and never claim unmarked Canvas notes", () => {
    const details = planner.encodeDetails({ description: "Review the lab", id: "pt-abcdefg-1234567", completed: true, link: "https://canvas.example.edu/courses/42" });
    assert.match(details, /APSTUDYCANVAS_PLANNER_NOTE:1:pt-abcdefg-1234567:1/);
    assert.deepEqual(planner.parseMarker(details), { version: 1, id: "pt-abcdefg-1234567", completed: true });
    assert.equal(planner.owned({ details }), true);
    assert.equal(planner.owned({ details: "A student-created Canvas planner note" }), false);
    assert.equal(planner.splitDetails(details).description, "Review the lab");
    assert.equal(planner.splitDetails(details).link, "https://canvas.example.edu/courses/42");
});

test("planner draft validation bounds payloads and keeps course and link data safe", () => {
    const valid = planner.normalizeDraft({ title: "  Study  ", todoDate: "2026-09-05", courseId: 42, description: "Notes", link: "https://canvas.example.edu/pages/study" }, { random: () => .2 });
    assert.equal(valid.ok, true);
    assert.equal(valid.value.title, "Study");
    assert.equal(valid.value.course_id, "42");
    assert.match(valid.value.details, /Link: https:\/\/canvas\.example\.edu\/pages\/study/);
    assert.equal(planner.normalizeDraft({ title: "", todoDate: "2026-09-05" }).error.code, "PLANNER_TITLE_REQUIRED");
    assert.equal(planner.normalizeDraft({ title: "x", todoDate: "not-a-date" }).error.code, "PLANNER_DATE_INVALID");
    assert.equal(planner.normalizeDraft({ title: "x", todoDate: "2026-09-07T04:00:00Z" }).error.code, "PLANNER_DATE_INVALID", "bypass callers cannot smuggle Canvas ISO timestamps past the date-only transport contract");
    assert.equal(planner.normalizeDraft({ title: "x", todoDate: "2026-09-05", courseId: "hidden" }).error.code, "PLANNER_COURSE_INVALID");
    assert.equal(planner.normalizeDraft({ title: "x", todoDate: "2026-09-05", link: "http://example.edu" }).error.code, "PLANNER_LINK_INVALID");
});

test("planner transport stays fail-closed until the default-off preference is explicitly enabled", async () => {
    let calls = 0;
    const transport = planner.createTransport({ origin: ORIGIN, document: documentForOrigin(ORIGIN, "_csrf_token=csrf-value"), fetchImpl: async () => { calls += 1; return response(201); } });
    const result = await transport.create({ title: "Test", todoDate: "2026-09-05" });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "PLANNER_TASKS_DISABLED");
    assert.equal(calls, 0);
});

test("enabled planner transport uses same-origin JSON plus Canvas CSRF and rejects unowned edits/deletes", async () => {
    const calls = [];
    const transport = planner.createTransport({
        origin: ORIGIN,
        enabled: true,
        document: documentForOrigin(ORIGIN, "a=b; _csrf_token=csrf%20value"),
        fetchImpl: async (url, options) => { calls.push({ url, options }); return response(options.method === "POST" ? 201 : 200, { id: 91 }); }
    });
    const created = await transport.create({ title: "Disposable", todoDate: "2026-09-05", stableId: "pt-abcdefg-1234567" });
    assert.equal(created.ok, true);
    assert.equal(calls[0].url, `${ORIGIN}/api/v1/planner_notes`);
    assert.deepEqual(calls[0].options.headers, { Accept: "application/json", "Content-Type": "application/json", "X-CSRF-Token": "csrf value" });
    assert.deepEqual(JSON.parse(calls[0].options.body), {
        title: "Disposable",
        todo_date: "2026-09-05",
        details: planner.encodeDetails({ id: "pt-abcdefg-1234567" })
    });
    const foreign = { id: 91, details: "ordinary Canvas note" };
    assert.equal((await transport.update(foreign, { title: "No", todoDate: "2026-09-05" })).error.code, "PLANNER_NOTE_NOT_OWNED");
    assert.equal((await transport.remove(foreign)).error.code, "PLANNER_NOTE_NOT_OWNED");
    assert.equal(calls.length, 1);
    const owned = { id: 91, details: planner.encodeDetails({ id: "pt-abcdefg-1234567" }) };
    assert.equal((await transport.update(owned, { title: "Changed", todoDate: "2026-09-06" })).ok, true);
    assert.equal((await transport.remove(owned)).ok, true);
    assert.deepEqual(calls.slice(1).map((call) => [call.options.method, call.url]), [["PUT", `${ORIGIN}/api/v1/planner_notes/91`], ["DELETE", `${ORIGIN}/api/v1/planner_notes/91`]]);
});

test("same stable planner draft reuses its in-flight create request", async () => {
    let resolve;
    let calls = 0;
    const transport = planner.createTransport({
        origin: ORIGIN,
        enabled: true,
        document: documentForOrigin(ORIGIN, "_csrf_token=csrf-value"),
        fetchImpl: async () => { calls += 1; await new Promise((done) => { resolve = done; }); return response(201, { id: 41 }); }
    });
    const draft = { title: "Review", todoDate: "2026-09-05", stableId: "pt-abcdefg-1234567" };
    const first = transport.create(draft);
    const second = transport.create(draft);
    assert.strictEqual(first, second);
    assert.equal(calls, 1);
    resolve();
    assert.equal((await first).ok, true);
});

test("completion update preserves the owned note's stable Canvas fields exactly", async () => {
    const calls = [];
    const transport = planner.createTransport({
        origin: ORIGIN,
        enabled: true,
        document: documentForOrigin(ORIGIN, "_csrf_token=x"),
        fetchImpl: async (url, options) => { calls.push({ url, options }); return response(200, { id: 91 }); }
    });
    const note = {
        id: 91,
        title: "Study chapter",
        todo_date: "2026-09-05",
        course_id: 42,
        details: planner.encodeDetails({ description: "Read carefully", link: `${ORIGIN}/courses/42/pages/chapter`, id: "pt-abcdefg-1234567", completed: false })
    };
    const result = await transport.update(note, { completed: true });
    assert.equal(result.ok, true);
    const payload = JSON.parse(calls[0].options.body);
    assert.deepEqual(Object.keys(payload).sort(), ["course_id", "details", "title", "todo_date"]);
    assert.equal(payload.title, note.title);
    assert.equal(payload.todo_date, note.todo_date);
    assert.equal(payload.course_id, "42");
    assert.equal(planner.splitDetails(payload.details).description, "Read carefully");
    assert.equal(planner.splitDetails(payload.details).link, `${ORIGIN}/courses/42/pages/chapter`);
    assert.equal(planner.parseMarker(payload.details).completed, true);
});

test("context_code-only planner rows retain their normalized course for completion and edit", async () => {
    const raw = {
        id: 91,
        context_code: "course_42",
        title: "Study chapter",
        todo_date: "2026-09-05",
        details: planner.encodeDetails({ id: "pt-abcdefg-1234567", completed: false })
    };
    const normalized = await model.normalizeCanvasTask("planner_note", raw, { origin: ORIGIN, userId: 1, accountKey: ACCOUNT, timeZone: "America/New_York" });
    assert.equal(normalized.task.course.id, "42", "Canvas context_code becomes the normalized task course");
    const calls = [];
    const transport = planner.createTransport({
        origin: ORIGIN, enabled: true, document: documentForOrigin(ORIGIN, "_csrf_token=x"),
        fetchImpl: async (_url, options) => { calls.push(JSON.parse(options.body)); return response(200); }
    });
    const ownedNote = { id: raw.id, title: raw.title, todo_date: raw.todo_date, course_id: normalized.task.course.id, details: raw.details };
    await transport.update(ownedNote, { completed: true });
    await transport.update(ownedNote, { title: "Edited" });
    assert.deepEqual(calls.map((payload) => payload.course_id), ["42", "42"]);
    const content = fs.readFileSync(require.resolve("../../js/content.js"), "utf8");
    assert.match(content, /nested\.course_id \?\? raw\.course_id \?\? task\?\.course\?\.id/);
    assert.match(content, /courseId: note\.course_id[\s\S]*link: parts\.link/);
});

test("server-committed then disconnected create reconciles by stable ownership id", async () => {
    const stableId = "pt-abcdefg-1234567";
    const calls = [];
    const transport = planner.createTransport({
        origin: ORIGIN,
        enabled: true,
        document: documentForOrigin(ORIGIN, "_csrf_token=x"),
        fetchImpl: async (url, options) => {
            calls.push({ url, options });
            if (options.method === "POST") throw new TypeError("connection lost after commit");
            return response(200, [{ id: 72, title: "Review", todo_date: "2026-09-05", details: planner.encodeDetails({ id: stableId }) }]);
        }
    });
    const result = await transport.create({ title: "Review", todoDate: "2026-09-05", stableId });
    assert.equal(result.ok, true);
    assert.equal(result.state, "reconciled");
    assert.equal(result.body.id, 72);
    assert.deepEqual(calls.map(({ options }) => options.method), ["POST", "GET"]);
    assert.match(calls[1].url, /planner_notes\?end_date=2026-09-05&per_page=100&start_date=2026-09-05|planner_notes\?start_date=2026-09-05&end_date=2026-09-05&per_page=100/);
});

test("a server-committed 5xx create reconciles a marker on the second planner page", async () => {
    const stableId = "pt-abcdefg-1234567";
    const calls = [];
    const pageTwo = `${ORIGIN}/api/v1/planner_notes?start_date=2026-09-05&end_date=2026-09-05&per_page=100&page=2`;
    const fullPage = Array.from({ length: 100 }, (_, id) => ({ id, details: "unowned" }));
    const transport = planner.createTransport({
        origin: ORIGIN,
        enabled: true,
        document: documentForOrigin(ORIGIN, "_csrf_token=x"),
        fetchImpl: async (url, options) => {
            calls.push({ url, options });
            if (options.method === "POST") return response(503, { error: { message: "gateway failed after commit" } });
            return url.includes("page=2")
                ? response(200, [{ id: 72, details: planner.encodeDetails({ id: stableId }) }])
                : response(200, fullPage, `<${pageTwo}>; rel="next"`);
        }
    });
    const result = await transport.create({ title: "Review", todoDate: "2026-09-05", stableId });
    assert.equal(result.state, "reconciled");
    assert.deepEqual(calls.map(({ options }) => options.method), ["POST", "GET", "GET"]);
});

test("ambiguous 408 responses reconcile before retry, while validation and auth failures do not", async () => {
    const stableId = "pt-abcdefg-1234567";
    const methods = [];
    const transport = planner.createTransport({
        origin: ORIGIN, enabled: true, document: documentForOrigin(ORIGIN, "_csrf_token=x"),
        fetchImpl: async (_url, options) => { methods.push(options.method); return options.method === "POST" ? response(408) : response(200, []); }
    });
    const draft = { title: "Review", todoDate: "2026-09-05", stableId };
    assert.equal((await transport.create(draft)).state, "confirmed-absent");
    assert.deepEqual(methods, ["POST", "GET"]);

    for (const status of [401, 422]) {
        let calls = 0;
        const definitive = planner.createTransport({
            origin: ORIGIN, enabled: true, document: documentForOrigin(ORIGIN, "_csrf_token=x"),
            fetchImpl: async () => { calls += 1; return response(status); }
        });
        assert.equal((await definitive.create(draft)).status, status);
        assert.equal(calls, 1, `${status} is a confirmed failure and must not reconcile`);
    }
});

test("reconciliation refuses unsafe, capped, or incomplete planner pagination", async () => {
    const stableId = "pt-abcdefg-1234567";
    const fullPage = Array.from({ length: 100 }, (_, id) => ({ id, details: "unowned" }));
    const scenarios = [
        { name: "cross-origin link", link: "<https://attacker.example/api/v1/planner_notes?page=2>; rel=next" },
        { name: "full page without next", link: "" },
        { name: "pagination cap", link: `<${ORIGIN}/api/v1/planner_notes?start_date=2026-09-05&end_date=2026-09-05&per_page=100&page=2>; rel=next` }
    ];
    for (const scenario of scenarios) {
        let reads = 0;
        const transport = planner.createTransport({
            origin: ORIGIN, enabled: true, document: documentForOrigin(ORIGIN, "_csrf_token=x"),
            fetchImpl: async (_url, options) => {
                if (options.method === "POST") throw new TypeError("disconnected");
                reads += 1;
                return response(200, fullPage, scenario.name === "pagination cap" && reads < 6 ? scenario.link : scenario.link);
            }
        });
        const result = await transport.create({ title: "Review", todoDate: "2026-09-05", stableId });
        assert.equal(result.state, "outcome-uncertain", scenario.name);
        assert.equal(reads, scenario.name === "pagination cap" ? 5 : 1, scenario.name);
    }
});

test("confirmed-absent create permits one explicit retry POST", async () => {
    const methods = [];
    let postCount = 0;
    const transport = planner.createTransport({
        origin: ORIGIN,
        enabled: true,
        document: documentForOrigin(ORIGIN, "_csrf_token=x"),
        fetchImpl: async (_url, options) => {
            methods.push(options.method);
            if (options.method === "POST" && ++postCount === 1) throw new TypeError("offline");
            if (options.method === "GET") return response(200, []);
            return response(201, { id: 73 });
        }
    });
    const draft = { title: "Review", todoDate: "2026-09-05", stableId: "pt-abcdefg-1234567" };
    const first = await transport.create(draft);
    assert.equal(first.state, "confirmed-absent");
    assert.equal(first.retryBlocked, false);
    assert.equal((await transport.create(draft)).ok, true);
    assert.deepEqual(methods, ["POST", "GET", "POST"]);
});

test("failed reconciliation remains outcome-uncertain and retry cannot POST blindly", async () => {
    const methods = [];
    const transport = planner.createTransport({
        origin: ORIGIN,
        enabled: true,
        document: documentForOrigin(ORIGIN, "_csrf_token=x"),
        fetchImpl: async (_url, options) => {
            methods.push(options.method);
            if (options.method === "POST") throw new TypeError("offline");
            return response(503, { error: { message: "unavailable" } });
        }
    });
    const draft = { title: "Review", todoDate: "2026-09-05", stableId: "pt-abcdefg-1234567" };
    const first = await transport.create(draft);
    assert.equal(first.state, "outcome-uncertain");
    assert.equal(first.retryBlocked, true);
    const second = await transport.create(draft);
    assert.equal(second.state, "outcome-uncertain");
    assert.deepEqual(methods, ["POST", "GET", "GET"], "retry performs reconciliation only while the outcome is uncertain");
});

test("failed session reopen is definitive: create stays available for retry without dispatch or reconciliation", async () => {
    const messages = [];
    const dispatches = [];
    let bridge = bridgeFactory(dispatches);
    let opens = 0;
    const runtime = { async sendMessage(message) {
        messages.push(message);
        if (message.action === "open" && ++opens === 2) return { ok: false, error: "PLANNER_BRIDGE_FORBIDDEN" };
        const reply = await bridge.handle(message, bridgeSender());
        if (message.action === "open") bridge = bridgeFactory(dispatches);
        return reply;
    } };
    const page = transportApi.create({ runtime, origin: ORIGIN });
    const domain = planner.createTransport({ origin: ORIGIN, enabled: true, document: documentForOrigin(ORIGIN, "_csrf_token=x"), fetchImpl: page.fetchImpl });
    const draft = { title: "Unsent", todoDate: "2026-09-05", stableId: "pt-abcdefg-1234567" };
    const first = domain.create(draft);
    const duplicate = domain.create(draft);
    assert.strictEqual(first, duplicate, "one UI action path retains create coalescing during recovery");
    const result = await first;
    assert.equal(result.state, "unavailable");
    assert.equal(result.indeterminate, false);
    assert.equal(result.recoverable, true);
    assert.equal(result.error.code, "CANVAS_PLANNER_PRE_DISPATCH_UNAVAILABLE");
    assert.equal(result.error.message, "This task wasn’t sent to Canvas. Check your connection or reload Canvas, then try again.");
    assert.deepEqual(messages.map(({ action }) => action), ["open", "request", "open"]);
    assert.equal(messages.filter(({ request }) => request?.method === "GET").length, 0, "definitive unsent creates do not reconcile");
    assert.deepEqual(dispatches, [], "MAIN and Canvas are never reached");
    page.dispose();
});

test("a second pre-dispatch session rejection is definitive and never becomes an uncertain duplicate", async () => {
    const messages = [];
    const dispatches = [];
    let bridge = bridgeFactory(dispatches);
    let opens = 0;
    const runtime = { async sendMessage(message) {
        messages.push(message);
        const reply = await bridge.handle(message, bridgeSender());
        if (message.action === "open" && ++opens <= 2) bridge = bridgeFactory(dispatches);
        return reply;
    } };
    const page = transportApi.create({ runtime, origin: ORIGIN });
    const domain = planner.createTransport({ origin: ORIGIN, enabled: true, document: documentForOrigin(ORIGIN, "_csrf_token=x"), fetchImpl: page.fetchImpl });
    const result = await domain.create({ title: "Still unsent", todoDate: "2026-09-05", stableId: "pt-abcdefg-1234567" });
    assert.equal(result.state, "unavailable");
    assert.equal(result.indeterminate, false);
    assert.equal(result.retryBlocked, undefined);
    assert.deepEqual(messages.map(({ action }) => action), ["open", "request", "open", "request"]);
    assert.equal(messages.filter(({ request }) => request?.method === "POST").length, 2, "only the bounded broker control attempt is repeated");
    assert.equal(messages.filter(({ request }) => request?.method === "GET").length, 0, "no ambiguous-write reconciliation read runs");
    assert.deepEqual(dispatches, [], "neither control attempt dispatches to MAIN/Canvas");
    page.dispose();
});

test("pre-dispatch planner update and delete failures use accurate definitive recovery copy", async () => {
    const owned = { id: 91, title: "Owned", todo_date: "2026-09-05", details: planner.encodeDetails({ id: "pt-abcdefg-1234567" }) };
    const messages = [];
    const runtime = { async sendMessage(message) { messages.push(message); return message.action === "close" ? { ok: true } : { ok: false, error: "PLANNER_BRIDGE_FORBIDDEN" }; } };
    const page = transportApi.create({ runtime, origin: ORIGIN });
    const domain = planner.createTransport({ origin: ORIGIN, enabled: true, document: documentForOrigin(ORIGIN, "_csrf_token=x"), fetchImpl: page.fetchImpl });
    const updated = await domain.update(owned, { title: "Changed" });
    const removed = await domain.remove(owned);
    assert.equal(updated.state, "unavailable");
    assert.equal(updated.indeterminate, false);
    assert.equal(updated.error.message, "Your changes weren’t sent to Canvas. Check your connection or reload Canvas, then try again.");
    assert.equal(removed.state, "unavailable");
    assert.equal(removed.indeterminate, false);
    assert.equal(removed.error.message, "The task wasn’t deleted in Canvas. Check your connection or reload Canvas, then try again.");
    assert.deepEqual(messages.map(({ action }) => action), ["open", "open"], "neither failed open sends a mutation request");
    page.dispose();
});

test("planner notes normalize with separate provenance and completion has rollback-safe confirmation", async () => {
    const raw = { id: 9, course_id: 42, title: "Owned", todo_date: "2026-09-05", details: planner.encodeDetails({ id: "pt-abcdefg-1234567", completed: false }) };
    const normalized = await model.normalizeCanvasTask("planner_note", raw, { origin: ORIGIN, userId: 1, accountKey: ACCOUNT, timeZone: "America/New_York" });
    assert.equal(normalized.ok, true);
    assert.equal(normalized.task.source, "canvas-planner-note");
    assert.equal(normalized.task.mutationAuthority, "canvas_planner_note");
    const api = todoApi.createTodoApi({ canvas: { setPlannerNoteCompletion: async () => ({ ok: true, status: 200, body: { id: 9 } }) } });
    const done = await api.dispatchCompletion(normalized.task, true);
    assert.equal(done.ok, true);
    assert.equal(done.task.completion, true);
    const failing = todoApi.createTodoApi({ canvas: { setPlannerNoteCompletion: async () => ({ ok: false, status: 422, body: { error: { message: "invalid" } } }) } });
    const rejected = await failing.dispatchCompletion(normalized.task, true);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.task.completion, false, "the source task is retained for UI rollback");
});

test("mapped nested Planner Note fields retain APStudy ownership and the immutable note id", async () => {
    const details = planner.encodeDetails({ description: "Read the refreshed note", id: "pt-abcdefg-1234567", completed: false });
    // This is the exact compact shape after content.js promotes the canonical
    // Planner Note fields from a /planner/items `plannable` object. Its source
    // row id is deliberately different from the mutable note resource id.
    const raw = {
        id: 41809,
        plannable_id: 41809,
        planner_item_id: 9911,
        plannable_type: "planner_note",
        course_id: 42,
        title: "Refreshed owned note",
        todo_date: "2026-09-07",
        details,
        plannable: { id: 41809, title: "Refreshed owned note", todo_date: "2026-09-07", details }
    };
    const normalized = await model.normalizeCanvasTask("planner_note", raw, { origin: ORIGIN, userId: 1, accountKey: ACCOUNT, timeZone: "America/New_York" });
    assert.equal(normalized.ok, true);
    assert.equal(normalized.task.remoteId, "41809", "the immutable Planner Note id replaces the transient planner row id");
    assert.equal(normalized.task.source, "canvas-planner-note");
    assert.equal(normalized.task.mutationAuthority, "canvas_planner_note");
    assert.equal(normalized.task.mutation.plannerNoteId, "pt-abcdefg-1234567");
    assert.equal(normalized.task.raw.details, details, "TodoModel receives the promoted nested details marker");

    const calls = [];
    const transport = planner.createTransport({
        origin: ORIGIN,
        enabled: true,
        document: documentForOrigin(ORIGIN, "_csrf_token=x"),
        fetchImpl: async (url, options) => { calls.push({ url, options }); return response(200, { id: 41809 }); }
    });
    const note = { id: normalized.task.remoteId, details: normalized.task.raw.details, title: normalized.task.title, todo_date: normalized.task.raw.todo_date };
    await transport.update(note, { title: "Edited refreshed note", todoDate: "2026-09-07" });
    await transport.remove(note);
    assert.deepEqual(calls.map(({ options, url }) => [options.method, url]), [
        ["PUT", `${ORIGIN}/api/v1/planner_notes/41809`],
        ["DELETE", `${ORIGIN}/api/v1/planner_notes/41809`]
    ]);
});

test("conflicting mapped Planner Note resource ids revoke marker-derived mutation authority", async () => {
    const raw = {
        // The conflicting row remains displayable under its feed id, but
        // content.js marks it untrusted instead of guessing a mutation target.
        id: 9911,
        plannable_id: 41998,
        planner_item_id: 9911,
        planner_note_resource_id: null,
        planner_note_resource_id_conflict: true,
        plannable_type: "planner_note",
        course_id: 42,
        title: "Conflicting owned note",
        todo_date: "2026-09-07",
        details: planner.encodeDetails({ description: "Read safely", id: "pt-conflict-1234567", completed: false }),
        plannable: { id: 42001, title: "Conflicting owned note" }
    };
    const normalized = await model.normalizeCanvasTask("planner_note", raw, { origin: ORIGIN, userId: 1, accountKey: ACCOUNT, timeZone: "America/New_York" });
    assert.equal(normalized.ok, true);
    assert.equal(normalized.task.source, "canvas", "an ownership marker cannot override an ambiguous Canvas resource identity");
    assert.equal(normalized.task.mutationAuthority, null);
    assert.equal(normalized.task.mutation.plannerNoteId, null, "the APStudy marker id is not a Canvas endpoint id");
    let plannerWrites = 0;
    let overrideWrites = 0;
    const api = todoApi.createTodoApi({
        canvas: {
            setPlannerNoteCompletion: async () => { plannerWrites += 1; return { ok: true, status: 200 }; },
            writePlannerOverride: async () => { overrideWrites += 1; return { ok: true, status: 200 }; }
        }
    });
    const result = await api.dispatchCompletion(normalized.task, true);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "PLANNER_NOTE_NOT_OWNED");
    assert.equal(plannerWrites, 0);
    assert.equal(overrideWrites, 0);
});

test("unmarked Canvas planner notes cannot be completed through any To-Do authority", async () => {
    const raw = { id: 10, course_id: 42, title: "Foreign", todo_date: "2026-09-05", details: "student note" };
    const normalized = await model.normalizeCanvasTask("planner_note", raw, { origin: ORIGIN, userId: 1, accountKey: ACCOUNT, timeZone: "America/New_York" });
    assert.equal(normalized.task.mutationAuthority, null);
    let writes = 0;
    const api = todoApi.createTodoApi({ canvas: { writePlannerOverride: async () => { writes += 1; return { ok: true, status: 200 }; } } });
    const result = await api.dispatchCompletion(normalized.task, true, { mode: "canvas_planner_override" });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "PLANNER_NOTE_NOT_OWNED");
    assert.equal(writes, 0);
});

test("planner transport aborts on navigation and never starts a write without a CSRF cookie", async () => {
    const noToken = planner.createTransport({ origin: ORIGIN, enabled: true, document: documentForOrigin(ORIGIN), fetchImpl: async () => { throw new Error("must not fetch"); } });
    assert.equal((await noToken.create({ title: "Test", todoDate: "2026-09-05" })).error.code, "CANVAS_SESSION_TOKEN_UNAVAILABLE");
    let rejectFetch;
    const transport = planner.createTransport({ origin: ORIGIN, enabled: true, document: documentForOrigin(ORIGIN, "_csrf_token=x"), fetchImpl: (_url, options) => new Promise((_resolve, reject) => { rejectFetch = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })); options.signal.addEventListener("abort", rejectFetch, { once: true }); }) });
    const pending = transport.create({ title: "Test", todoDate: "2026-09-05" });
    transport.dispose();
    const result = await pending;
    assert.equal(result.state, "outcome-uncertain", "an aborted in-flight POST is conservatively treated as potentially committed");
    assert.equal(typeof rejectFetch, "function");
});

test("planner transport resolves Canvas CSRF from a cookie or document meta without leaking a malformed token", async () => {
    const headers = [];
    const fetchImpl = async (_url, options) => { headers.push(options.headers["X-CSRF-Token"]); return response(201); };
    const fromMeta = planner.createTransport({ origin: ORIGIN, enabled: true, document: documentForOrigin(ORIGIN, "", "meta-token"), fetchImpl });
    assert.equal((await fromMeta.create({ title: "Meta", todoDate: "2026-09-05", stableId: "pt-abcdefg-1234567" })).ok, true);
    const cookieWins = planner.createTransport({ origin: ORIGIN, enabled: true, document: documentForOrigin(ORIGIN, "_csrf_token=cookie-token", "meta-token"), fetchImpl });
    assert.equal((await cookieWins.create({ title: "Cookie", todoDate: "2026-09-05", stableId: "pt-abcdefg-7654321" })).ok, true);
    const malformed = planner.createTransport({ origin: ORIGIN, enabled: true, document: documentForOrigin(ORIGIN, "", "bad\nvalue"), fetchImpl });
    assert.equal((await malformed.create({ title: "Blocked", todoDate: "2026-09-05" })).error.code, "CANVAS_SESSION_TOKEN_UNAVAILABLE");
    assert.deepEqual(headers, ["meta-token", "cookie-token"]);
});

test("planner transport treats thrown fetches and status zero as recoverable network failures, never HTTP errors", async () => {
    const owned = { id: 91, title: "Owned", todo_date: "2026-09-05", details: planner.encodeDetails({ id: "pt-abcdefg-1234567" }) };
    for (const fetchImpl of [async () => { throw new TypeError("Failed to fetch"); }, async () => ({ ok: false, status: 0, json: async () => { throw new Error("opaque"); } })]) {
        const transport = planner.createTransport({ origin: ORIGIN, enabled: true, document: documentForOrigin(ORIGIN, "_csrf_token=x"), fetchImpl });
        const result = await transport.update(owned, { title: "Changed" });
        assert.equal(result.state, "network");
        assert.equal(result.recoverable, true);
        assert.equal(result.error.code, "CANVAS_PLANNER_NOTE_NETWORK_UNAVAILABLE");
        assert.doesNotMatch(result.error.message, /status 0/i);
        assert.equal(result.status, undefined);
    }
});

test("planner transport parses direct Canvas payloads and malformed successful JSON without misclassifying the HTTP status", async () => {
    let request;
    const transport = planner.createTransport({
        origin: ORIGIN,
        enabled: true,
        document: documentForOrigin(ORIGIN, "_csrf_token=x"),
        fetchImpl: async (_url, options) => {
            request = options;
            return { ok: false, status: 422, headers: { get: () => null }, json: async () => { throw new Error("non-JSON Rails error"); } };
        }
    });
    const result = await transport.create({ title: "Direct", todoDate: "2026-09-05", stableId: "pt-abcdefg-1234567" });
    assert.equal(result.status, 422);
    assert.equal(result.error.code, "CANVAS_PLANNER_NOTE_POST_FAILED");
    assert.equal(result.error.message, "Canvas rejected the planner request. (HTTP 422).");
    assert.equal(Object.hasOwn(JSON.parse(request.body), "planner_note"), false);
});

test("planner transport rejects cross-origin and malformed-note writes before fetch", async () => {
    let calls = 0;
    const transport = planner.createTransport({ origin: "https://other.example.edu", enabled: true, document: documentForOrigin(ORIGIN, "_csrf_token=x"), fetchImpl: async () => { calls += 1; return response(200); } });
    assert.equal((await transport.create({ title: "Test", todoDate: "2026-09-05" })).error.code, "CANVAS_ORIGIN_UNAVAILABLE");
    const local = planner.createTransport({ origin: ORIGIN, enabled: true, document: documentForOrigin(ORIGIN, "_csrf_token=x"), fetchImpl: async () => { calls += 1; return response(200); } });
    const ownedWithBadId = { id: "91/../../users/self", details: planner.encodeDetails({ id: "pt-abcdefg-1234567" }) };
    assert.equal((await local.remove(ownedWithBadId)).error.code, "PLANNER_NOTE_ID_INVALID");
    assert.equal(calls, 0);
});
