"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const contract = require("../../js/platform/contract.js");
const storage = require("../../js/platform/storage.js");
const transport = require("../../js/platform/transport.js");
const router = require("../../js/platform/router.js");

function response(status, body = {}, headers = { "content-type": "application/json" }) {
    const normalized = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: {
            forEach(callback) { Object.entries(normalized).forEach(([name, value]) => callback(value, name)); }
        },
        async text() { return typeof body === "string" ? body : JSON.stringify(body); }
    };
}

function extensionChrome() {
    return { runtime: { getURL: (value) => `chrome-extension://test-id/${String(value).replace(/^\//, "")}` } };
}

const todo = {
    id: "task-1",
    title: "Study",
    description: "Review notes",
    link: "https://canvas.example.edu/courses/1/assignments/2",
    completed: false,
    source_identity: { source_item_key: "assignment-2" }
};

test("todo route and payload allowlists admit only the Nest v1 methods and fields", () => {
    assert.equal(transport.validateTransportRequest({ method: "GET", path: "/api/extension/todos?limit=25&completed=false" }).method, "GET");
    assert.equal(transport.validateTransportRequest({ method: "POST", path: "/api/extension/todos", body: { title: "Study" } }).method, "POST");
    assert.equal(transport.validateTransportRequest({ method: "PATCH", path: "/api/extension/todos/task-1/completion", body: { completed: true } }).method, "PATCH");
    for (const spec of [
        { method: "PUT", path: "/api/extension/todos" },
        { method: "GET", path: "/api/extension/todos?unknown=value" },
        { method: "GET", path: "/api/extension/todos?completed=Bearer%20secret" },
        { method: "PATCH", path: "/api/extension/todos/task%2Fother/completion", body: { completed: true } },
        { method: "POST", path: "/api/extension/todos", body: { title: "Study", authorization: "Bearer secret" } }
    ]) assert.throws(() => transport.validateTransportRequest(spec), /NEST_PATH_METHOD_NOT_ALLOWLISTED|NEST_SECRET_BODY_FORBIDDEN/);
    assert.throws(() => transport.validateTodoCreatePayload({ description: "missing title" }), /NEST_TODO_CREATE_TITLE_REQUIRED/);
    assert.throws(() => transport.validateTodoCompletionPayload({ completed: true, extra: false }), /NEST_TODO_COMPLETION_PAYLOAD_INVALID/);
});

test("todo query serialization supports pagination and filters without accepting credentials", () => {
    assert.equal(
        transport.serializeTodoQuery({ limit: 25, page: 2, completed: false, undated: "only", start_date: "2026-08-01" }),
        "completed=false&limit=25&page=2&start_date=2026-08-01&undated=only"
    );
    assert.throws(() => transport.serializeTodoQuery({ limit: 1, access_token: "secret" }), /NEST_TODO_QUERY_FIELD_NOT_ALLOWLISTED/);
    assert.throws(() => transport.serializeTodoQuery({ completed: "Bearer secret" }), /NEST_TODO_QUERY_VALUE_INVALID/);
});

test("todo reads use credentialed no-store background fetch and preserve sanitized errors", async () => {
    const calls = [];
    const nest = transport.createNestTransport({
        fetchImpl: async (url, options) => {
            calls.push({ url, options });
            return response(422, {
                contractVersion: 1,
                ok: false,
                error: { code: "invalid_filter", message: "completed must be true, false, or all." },
                debug: "do-not-forward"
            });
        }
    });
    const result = await nest.todos.list({ limit: 10, offset: 20, completed: true }, { requestId: "todo-read-1" });
    assert.equal(result.status, 422);
    assert.equal(result.transport, "direct");
    assert.equal(calls[0].options.credentials, "include");
    assert.equal(calls[0].options.cache, "no-store");
    assert.match(calls[0].url, /\/api\/extension\/todos\?completed=true&limit=10&offset=20$/);
    assert.deepEqual(result.body.error, { code: "invalid_filter", message: "completed must be true, false, or all." });
    assert.equal(result.body.debug, undefined);
});

test("todo creates carry idempotency and CSRF headers while preserving replay and conflict statuses", async () => {
    const calls = [];
    let createStatus = 201;
    const nest = transport.createNestTransport({
        fetchImpl: async (url, options) => {
            calls.push({ url, options });
            if (url.endsWith("/csrf")) return response(200, {}, { "content-type": "application/json", "x-csrftoken": "csrf-1" });
            return response(createStatus, { contractVersion: 1, ok: createStatus !== 409, todo, list: null, idempotent: createStatus === 200, error: createStatus === 409 ? { code: "idempotency_conflict", message: "The idempotency key was already used with a different payload." } : undefined });
        }
    });
    const createPayload = { title: todo.title, description: todo.description, link: todo.link, idempotency_key: "create-key-1" };
    const first = await nest.todos.create(createPayload, { requestId: "todo-create-1", idempotencyKey: "create-key-1" });
    assert.equal(first.status, 201);
    assert.equal(first.body.todo.id, "task-1");
    const createCall = calls.find((call) => call.url.endsWith("/todos"));
    assert.equal(createCall.options.method, "POST");
    assert.equal(createCall.options.credentials, "include");
    assert.equal(createCall.options.headers["x-csrftoken"], "csrf-1");
    assert.equal(createCall.options.headers["idempotency-key"], "create-key-1");
    assert.deepEqual(JSON.parse(createCall.options.body), createPayload);

    createStatus = 200;
    const replay = await nest.todos.create(createPayload, { requestId: "todo-create-2", idempotencyKey: "create-key-1" });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.idempotent, true);

    createStatus = 409;
    const conflict = await nest.todos.create({ ...createPayload, title: "Different" }, { requestId: "todo-create-3", idempotencyKey: "create-key-1" });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.ok, false);
    assert.equal(conflict.body.error.code, "idempotency_conflict");
    assert.equal(conflict.body.error.message.includes("different payload"), true);
});

test("todo completion uses the exact PATCH route and validated pass-through payload", async () => {
    let mutation;
    const nest = transport.createNestTransport({
        fetchImpl: async (url, options) => {
            if (url.endsWith("/csrf")) return response(200, {}, { "content-type": "application/json", "x-csrftoken": "csrf-completion" });
            mutation = { url, options };
            return response(200, { contractVersion: 1, ok: true, todo: { ...todo, completed: true }, list: null });
        }
    });
    const result = await nest.todos.setCompletion("task-1", { completed: true }, { requestId: "todo-complete-1" });
    assert.equal(result.status, 200);
    assert.equal(mutation.url, "https://nest.apstudy.org/api/extension/todos/task-1/completion");
    assert.equal(mutation.options.method, "PATCH");
    assert.deepEqual(JSON.parse(mutation.options.body), { completed: true });
    assert.equal(mutation.options.headers["x-csrftoken"], "csrf-completion");
});

test("reads and idempotent writes fall back only through an exact-origin Nest tab", async () => {
    const sent = [];
    const nest = transport.createNestTransport({
        fetchImpl: async () => { throw new TypeError("offline"); },
        findExactNestTab: async () => ({ id: 17, url: "https://nest.apstudy.org/workspace" }),
        sendToTab: async (tabId, message) => {
            sent.push({ tabId, message });
            return { kind: "APSTUDYCANVAS_NEST_BRIDGE_RESPONSE", version: 1, request_id: message.request_id, ok: true, status: 200, headers: { "content-type": "application/json" }, body: { contractVersion: 1, ok: true, todos: [], idempotent: false } };
        }
    });
    const read = await nest.todos.list({ limit: 1 }, { requestId: "todo-tab-read" });
    assert.equal(read.transport, "tab");
    assert.equal(read.cache, "no-store");
    assert.equal(sent[0].tabId, 17);
    assert.equal(sent[0].message.request.path, "/api/extension/todos?limit=1");
    const create = await nest.todos.create({ title: "Study" }, { requestId: "todo-tab-create", idempotencyKey: "todo-tab-key" });
    assert.equal(create.transport, "tab");
    assert.deepEqual(sent[1].message.mutation, { idempotent: true, idempotency_key: "todo-tab-key" });
    assert.equal(sent[1].message.request.headers["x-csrftoken"], undefined);

    const foreignTab = transport.createNestTransport({
        fetchImpl: async () => { throw new TypeError("offline"); },
        findExactNestTab: async () => ({ id: 18, url: "https://nest.apstudy.org.evil.test/" })
    });
    await assert.rejects(foreignTab.todos.list({}, { requestId: "todo-tab-foreign" }), /NEST_TAB_ORIGIN_INVALID/);
});

test("router exposes stable todo messages, enforces extension senders, and never uses window.postMessage", async () => {
    const calls = [];
    const todoAdapter = {
        list: async (query, options) => { calls.push(["list", query, options]); return { ok: true, status: 200, body: { todos: [] } }; },
        create: async (payload, options) => { calls.push(["create", payload, options]); return { ok: true, status: 201, body: { todo } }; },
        setCompletion: async (taskId, payload, options) => { calls.push(["complete", taskId, payload, options]); return { ok: true, status: 200, body: { todo: { ...todo, completed: payload.completed } } }; }
    };
    const service = router.createRouter({ chromeApi: extensionChrome(), storage: storage.createMemoryStorage({ sync: {}, local: {}, session: {} }), transport: { todos: todoAdapter } });
    const sender = { url: "chrome-extension://test-id/html/popup.html" };
    const read = await service.handle(contract.createEnvelope("NEST_TODOS_GET", { limit: 2, completed: false }, "router-read"), sender);
    const create = await service.handle(contract.createEnvelope("NEST_TODO_CREATE", { title: "Study", idempotency_key: "router-key" }, "router-create"), sender);
    const complete = await service.handle(contract.createEnvelope("NEST_TODO_COMPLETION_SET", { task_id: "task-1", completed: true }, "router-complete"), sender);
    assert.equal(read.payload.status, 200);
    assert.equal(create.payload.status, 201);
    assert.equal(complete.payload.status, 200);
    assert.equal(calls[0][0], "list");
    assert.equal(calls[1][2].idempotencyKey, "router-key");
    assert.deepEqual(calls[2].slice(0, 3), ["complete", "task-1", { completed: true }]);

    for (const [index, blockedSender] of [
        { url: "https://nest.apstudy.org/workspace" },
        { url: "https://canvas.example.edu/courses/1" }
    ].entries()) {
        const blocked = await service.handle(contract.createEnvelope("NEST_TODOS_GET", {}, `blocked-${index}`), blockedSender);
        assert.equal(blocked.payload.code, blockedSender.url.startsWith("https://nest.apstudy.org") ? "SENDER_EXTENSION_REQUIRED" : "SENDER_NOT_ALLOWED");
    }
    const invalid = await service.handle(contract.createEnvelope("NEST_TODO_COMPLETION_SET", { task_id: "task-1", completed: true, token: "secret" }, "router-invalid"), sender);
    assert.equal(invalid.payload.code, "NEST_TODO_COMPLETION_PAYLOAD_INVALID");
    assert.doesNotMatch(fs.readFileSync(path.join(__dirname, "../../js/platform/nest-bridge.js"), "utf8"), /window\.postMessage/);
});
