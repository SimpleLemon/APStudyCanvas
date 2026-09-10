"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const bridgeApi = require("../../js/platform/planner-page-bridge.js");
const transportApi = require("../../js/content/planner-page-transport.js");
const ORIGIN = "https://canvas.example.edu";
const sender = { tab: { id: 7, url: `${ORIGIN}/calendar` }, url: `${ORIGIN}/calendar`, frameId: 0 };
const session = "s".repeat(32);
const draft = { title: "Study", todo_date: "2026-09-05", details: "APSTUDYCANVAS_PLANNER_NOTE:1:pt-abcdefg-1234567:0" };

function serializedPageRequest({ cookie = "", metaToken = "", fetchImpl } = {}) {
    const context = {
        AbortController,
        TextDecoder,
        TextEncoder,
        URL,
        Uint8Array,
        clearTimeout,
        document: {
            cookie,
            querySelector: () => metaToken ? { getAttribute: (name) => name === "content" ? metaToken : null } : null
        },
        fetch: fetchImpl,
        location: { origin: ORIGIN },
        setTimeout
    };
    context.globalThis = context;
    // chrome.scripting.executeScript serializes func with Function#toString
    // and evaluates it in the target world.  Do the same here so the test
    // fails if pageRequest accidentally captures module-local helpers.
    return vm.runInNewContext(`(${bridgeApi.pageRequest.toString()})`, context);
}

function mainResponse(status, body) {
    return {
        status,
        body: undefined,
        headers: { get: () => null },
        text: async () => JSON.stringify(body)
    };
}

function operationUrl(method) {
    return method === "GET"
        ? `${ORIGIN}/api/v1/planner_notes?start_date=2026-09-05&end_date=2026-09-05&per_page=100`
        : `${ORIGIN}/api/v1/planner_notes${["PUT", "DELETE"].includes(method) ? "/91" : ""}`;
}

function operationOptions(method) {
    return {
        method,
        ...(["POST", "PUT"].includes(method) ? { body: JSON.stringify(draft) } : {})
    };
}

function restartableRuntime({ restartAfterFirstOpen = true } = {}) {
    const messages = [];
    const canvasOperations = [];
    const makeBridge = () => bridgeApi.createPlannerPageBridge({
        allowedOrigins: [ORIGIN],
        chromeApi: { scripting: { async executeScript(options) {
            if (options.func === bridgeApi.pageCancel) return [{ result: false }];
            const operation = options.args[0];
            canvasOperations.push(operation);
            return [{ result: { ok: true, status: operation.method === "POST" ? 201 : 200, body: operation.method === "GET" ? [] : operation.method === "DELETE" ? null : { id: 91 }, headers: {} } }];
        } } }
    });
    let bridge = makeBridge();
    let restart = restartAfterFirstOpen;
    return {
        messages,
        canvasOperations,
        runtime: { async sendMessage(message) {
            messages.push(message);
            const reply = await bridge.handle(message, sender);
            if (restart && message.action === "open") { restart = false; bridge = makeBridge(); }
            return reply;
        } }
    };
}

test("page-world broker only accepts a nonce-bound top-frame Canvas session and fixed planner operations", async () => {
    const calls = [];
    const api = bridgeApi.createPlannerPageBridge({ allowedOrigins: [ORIGIN], chromeApi: { scripting: { async executeScript(options) { calls.push(options); return [{ result: { ok: true, status: 201, body: { id: 9 }, headers: { link: "" } } }]; } } } });
    assert.deepEqual(await api.handle({ kind: bridgeApi.KIND, version: 1, action: "open", session }, sender), { ok: true });
    const reply = await api.handle({ kind: bridgeApi.KIND, version: 1, action: "request", session, operation: "o".repeat(24), request: { method: "POST", body: draft } }, sender);
    assert.equal(reply.status, 201);
    assert.equal(calls[0].world, "MAIN");
    assert.deepEqual(calls[0].args[0], { method: "POST", id: null, query: null, body: draft });
    for (const hostile of [
        { ...sender, frameId: 1 },
        { ...sender, url: "https://attacker.example/" },
        sender
    ]) {
        const forged = await api.handle({ kind: bridgeApi.KIND, version: 1, action: "request", session: hostile === sender ? "x".repeat(32) : session, request: { method: "POST", body: draft } }, hostile);
        assert.ok(forged === null || forged.ok === false);
    }
    assert.equal(calls.length, 1, "forged origin/frame/session messages never reach page world");
});

test("broker rejects arbitrary URLs, methods, bodies, and invalid planner pagination before injection", () => {
    for (const request of [
        { method: "PATCH", body: draft },
        { method: "POST", url: "https://attacker.example/", body: draft },
        { method: "POST", body: { ...draft, csrf: "no" } },
        { method: "GET", query: { start_date: "2026-09-05", end_date: "2026-09-05", per_page: "99" } },
        { method: "GET", query: { start_date: "2026-09-05", end_date: "2026-09-05", per_page: "100", page: "1000" } }
    ]) assert.equal(bridgeApi.validateRequest(request, ORIGIN), null);
    assert.deepEqual(bridgeApi.validateRequest({ method: "GET", query: { start_date: "2026-09-05", end_date: "2026-09-05", per_page: "100", page: "2" } }, ORIGIN).query.page, "2");
});

test("serialized MAIN-world function sends the exact authenticated Canvas create with decoded cookie or meta CSRF", async () => {
    const calls = [];
    const request = { method: "POST", id: null, query: null, body: draft };
    const fromCookie = serializedPageRequest({
        cookie: "theme=night; _csrf_token=cookie%2Ftoken%3D; locale=en",
        fetchImpl: async (url, options) => { calls.push({ url, options }); return mainResponse(201, { id: 91 }); }
    });
    const result = JSON.parse(JSON.stringify(await fromCookie(request, ORIGIN, 100, session, "p".repeat(24))));
    assert.deepEqual(result, { ok: true, status: 201, body: { id: 91 }, headers: { link: "", "content-type": "" } });
    assert.equal(calls[0].url, `${ORIGIN}/api/v1/planner_notes`);
    assert.deepEqual(JSON.parse(JSON.stringify(calls[0].options.headers)), { Accept: "application/json", "Content-Type": "application/json", "X-CSRF-Token": "cookie/token=" });
    assert.equal(calls[0].options.credentials, "include");
    assert.equal(calls[0].options.cache, "no-store");
    assert.deepEqual(JSON.parse(calls[0].options.body), draft);

    const fromMeta = serializedPageRequest({
        metaToken: "meta-token",
        fetchImpl: async (_url, options) => { calls.push({ meta: options.headers["X-CSRF-Token"] }); return mainResponse(201, { id: 92 }); }
    });
    assert.equal((await fromMeta(request, ORIGIN, 100, session, "m".repeat(24))).status, 201);
    assert.equal(calls[1].meta, "meta-token");
});

test("serialized MAIN-world function classifies network exceptions and timeout aborts without leaking an HTTP status", async () => {
    const request = { method: "POST", id: null, query: null, body: draft };
    const network = serializedPageRequest({ cookie: "_csrf_token=token", fetchImpl: async () => { throw new TypeError("Failed to fetch"); } });
    assert.deepEqual(JSON.parse(JSON.stringify(await network(request, ORIGIN, 100, session, "n".repeat(24)))), { ok: false, status: 0, error: "network" });

    const timeout = serializedPageRequest({
        cookie: "_csrf_token=token",
        fetchImpl: async (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true }))
    });
    assert.deepEqual(JSON.parse(JSON.stringify(await timeout(request, ORIGIN, 1, session, "t".repeat(24)))), { ok: false, status: 0, error: "aborted" });
});

test("broker forwards bounded page failures instead of relabeling them as protocol errors", () => {
    const request = { method: "POST", body: draft };
    for (const failure of ["origin", "csrf", "network", "aborted", "response_too_large", "response_malformed", "response_headers"]) {
        const result = bridgeApi.validateResponse(request, { ok: false, status: 0, error: failure });
        assert.equal(result.error, failure, failure);
        assert.match(result.diagnostic, /^PBR-[A-Z]+$/);
        assert.doesNotMatch(JSON.stringify(result), /cookie|csrf_token|token=/i);
    }
    assert.equal(bridgeApi.validateResponse(request, { ok: false, status: 0, error: "not-allowed" }).error, "PLANNER_BRIDGE_PROTOCOL");
});

test("content transport keeps the nonce private, exposes only safe response fields, and aborts before a write", async () => {
    const messages = [];
    const runtime = { async sendMessage(message) { messages.push(message); return message.action === "open" ? { ok: true } : { ok: true, status: 422, body: { error: { message: "invalid" } }, headers: { link: "" } }; } };
    const transport = transportApi.create({ runtime, origin: ORIGIN });
    const response = await transport.fetchImpl(`${ORIGIN}/api/v1/planner_notes`, { method: "POST", body: JSON.stringify(draft) });
    assert.equal(response.status, 422);
    assert.equal((await response.json()).error.message, "invalid");
    assert.equal(messages[1].request.method, "POST");
    assert.equal(messages[1].request.url, undefined);
    const abort = new AbortController(); abort.abort();
    await assert.rejects(transport.fetchImpl(`${ORIGIN}/api/v1/planner_notes`, { method: "POST", body: JSON.stringify(draft), signal: abort.signal }), { name: "AbortError" });
    transport.dispose();
    assert.equal(messages.at(-1).action, "close");
});

test("content transport exposes only bounded diagnostic categories for page and MAIN failures", async () => {
    for (const [error, diagnostic, code, phase, indeterminate] of [
        ["csrf", "PBR-CSRF", "CANVAS_PLANNER_PAGE_PRE_DISPATCH_UNAVAILABLE", "pre-dispatch", false],
        ["network", "PBR-NETWORK", "CANVAS_PLANNER_MAIN_EXECUTION_FAILED", "main-world", true],
        ["PLANNER_BRIDGE_EXECUTION", "PBR-EMPTY-RESULT", "CANVAS_PLANNER_MAIN_EXECUTION_FAILED", "main-world", true]
    ]) {
        const runtime = { async sendMessage(message) { return message.action === "open" ? { ok: true } : { ok: false, status: 0, error, diagnostic }; } };
        const transport = transportApi.create({ runtime, origin: ORIGIN });
        await assert.rejects(transport.fetchImpl(operationUrl("POST"), operationOptions("POST")), (failure) => {
            assert.equal(failure.code, code);
            assert.equal(failure.phase, phase);
            assert.equal(failure.indeterminate, indeterminate);
            assert.equal(failure.diagnostic, diagnostic);
            assert.doesNotMatch(failure.message, /csrf|cookie|token|nonce|session/i);
            return true;
        });
        transport.dispose();
    }
});

test("transport safely reopens once after worker-state loss before GET, POST, PUT, and DELETE", async () => {
    for (const method of ["GET", "POST", "PUT", "DELETE"]) {
        const harness = restartableRuntime();
        const transport = transportApi.create({ runtime: harness.runtime, origin: ORIGIN });
        const response = await transport.fetchImpl(operationUrl(method), operationOptions(method));
        assert.equal(response.status, method === "POST" ? 201 : 200, method);
        assert.deepEqual(harness.messages.map(({ action }) => action), ["open", "request", "open", "request"], method);
        assert.deepEqual(harness.canvasOperations.map(({ method: sentMethod }) => sentMethod), [method], `${method} reaches MAIN exactly once`);
        assert.equal(harness.messages[1].operation, harness.messages[3].operation, `${method} recovery retains the operation nonce`);
        transport.dispose();
    }
});

test("concurrent callers coalesce initial and recovery opens without duplicating a Canvas write", async () => {
    const harness = restartableRuntime();
    const transport = transportApi.create({ runtime: harness.runtime, origin: ORIGIN });
    const [read, write] = await Promise.all([
        transport.fetchImpl(operationUrl("GET"), operationOptions("GET")),
        transport.fetchImpl(operationUrl("POST"), operationOptions("POST"))
    ]);
    assert.equal(read.status, 200);
    assert.equal(write.status, 201);
    assert.equal(harness.messages.filter(({ action }) => action === "open").length, 2, "one coalesced initial open and one coalesced recovery open");
    assert.deepEqual(harness.canvasOperations.map(({ method }) => method).sort(), ["GET", "POST"]);
    assert.equal(harness.canvasOperations.filter(({ method }) => method === "POST").length, 1);
    transport.dispose();
});

test("failed recovery open stops before dispatching or retrying the operation", async () => {
    const messages = [];
    let opens = 0;
    const runtime = { async sendMessage(message) {
        messages.push(message);
        if (message.action === "open") return ++opens === 1 ? { ok: true } : { ok: false, error: "PLANNER_BRIDGE_FORBIDDEN" };
        if (message.action === "request") return { ok: false, status: 0, error: "PLANNER_BRIDGE_FORBIDDEN", preDispatch: "session" };
        return { ok: true };
    } };
    const transport = transportApi.create({ runtime, origin: ORIGIN });
    await assert.rejects(transport.fetchImpl(operationUrl("POST"), operationOptions("POST")), (error) => {
        assert.equal(error.code, "CANVAS_PLANNER_PRE_DISPATCH_UNAVAILABLE");
        assert.equal(error.phase, "pre-dispatch");
        assert.equal(error.indeterminate, false);
        assert.doesNotMatch(error.message, /nonce|session/i);
        return true;
    });
    assert.deepEqual(messages.map(({ action }) => action), ["open", "request", "open"]);
    transport.dispose();
});

test("abort ignores a late stale pre-dispatch response and never reopens or resends", async () => {
    const messages = [];
    let resolveRequest;
    const runtime = { sendMessage(message) {
        messages.push(message);
        if (message.action === "open" || message.action === "cancel" || message.action === "close") return Promise.resolve({ ok: true });
        return new Promise((resolve) => { resolveRequest = resolve; });
    } };
    const controller = new AbortController();
    const transport = transportApi.create({ runtime, origin: ORIGIN });
    const pending = transport.fetchImpl(operationUrl("POST"), { ...operationOptions("POST"), signal: controller.signal });
    while (!resolveRequest) await Promise.resolve();
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
    resolveRequest({ ok: false, status: 0, error: "PLANNER_BRIDGE_FORBIDDEN", preDispatch: "session" });
    await Promise.resolve(); await Promise.resolve();
    assert.equal(messages.filter(({ action }) => action === "open").length, 1);
    assert.equal(messages.filter(({ action }) => action === "request").length, 1);
    assert.equal(messages.filter(({ action }) => action === "cancel").length, 1);
    transport.dispose();
});

test("ambiguous execution, timeout, network, and protocol failures are never reopened or retried", async () => {
    for (const error of ["PLANNER_BRIDGE_EXECUTION", "aborted", "network", "PLANNER_BRIDGE_PROTOCOL"]) {
        const messages = [];
        const runtime = { async sendMessage(message) {
            messages.push(message);
            return message.action === "open" ? { ok: true } : { ok: false, status: 0, error };
        } };
        const transport = transportApi.create({ runtime, origin: ORIGIN });
        await assert.rejects(transport.fetchImpl(operationUrl("POST"), operationOptions("POST")), (failure) => {
            assert.equal(failure.code, "CANVAS_PLANNER_MAIN_EXECUTION_FAILED");
            assert.equal(failure.phase, "main-world");
            assert.equal(failure.indeterminate, true);
            assert.doesNotMatch(failure.message, /PLANNER_BRIDGE|nonce|session/i);
            return true;
        });
        assert.deepEqual(messages.map(({ action }) => action), ["open", "request"], error);
        transport.dispose();
    }
});

test("fixed origin binding rejects attackers, subdomains, ports, schemes, and sender/tab disagreement", async () => {
    const api = bridgeApi.createPlannerPageBridge({ allowedOrigins: ["https://canvas.emory.edu"], chromeApi: { scripting: { async executeScript() { throw new Error("must not inject"); } } } });
    for (const senderCandidate of [
        { tab: { id: 1, url: "https://attacker.example/" }, url: "https://attacker.example/", frameId: 0 },
        { tab: { id: 2, url: "https://canvas.emory.edu.evil.example/" }, url: "https://canvas.emory.edu.evil.example/", frameId: 0 },
        { tab: { id: 3, url: "https://canvas.emory.edu:8443/" }, url: "https://canvas.emory.edu:8443/", frameId: 0 },
        { tab: { id: 4, url: "http://canvas.emory.edu/" }, url: "http://canvas.emory.edu/", frameId: 0 },
        { tab: { id: 5, url: "https://canvas.emory.edu/" }, url: "https://attacker.example/", frameId: 0 }
    ]) assert.equal((await api.handle({ kind: bridgeApi.KIND, version: 1, action: "open", session }, senderCandidate)).ok, false);
});

test("Brave-shaped top-frame sender injects MAIN only with the static Canvas host permission", async () => {
    const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../manifest.json"), "utf8"));
    assert.ok(manifest.host_permissions.includes("https://canvas.emory.edu/*"), "scripting.executeScript needs a host grant even though static content scripts match Canvas");
    const braveSender = {
        id: "apstudycanvas@localhost",
        origin: "https://canvas.emory.edu",
        url: "https://canvas.emory.edu/calendar?view=week",
        frameId: 0,
        documentId: "A4E67A39C9E0B0C1E5D2",
        tab: { id: 184, url: "https://canvas.emory.edu/calendar?view=week", windowId: 8 }
    };
    const calls = [];
    const api = bridgeApi.createPlannerPageBridge({ allowedOrigins: ["https://canvas.emory.edu"], chromeApi: { scripting: { async executeScript(options) { calls.push(options); return [{ result: { ok: true, status: 201, body: { id: 9 }, headers: {} } }]; } } } });
    assert.deepEqual(await api.handle({ kind: bridgeApi.KIND, version: 1, action: "open", session }, braveSender), { ok: true });
    assert.equal((await api.handle({ kind: bridgeApi.KIND, version: 1, action: "request", session, operation: "b".repeat(24), request: { method: "POST", body: draft } }, braveSender)).status, 201);
    assert.deepEqual(calls[0].target, { tabId: 184, documentIds: ["A4E67A39C9E0B0C1E5D2"] });
    assert.equal(calls[0].world, "MAIN");

    const noMain = bridgeApi.createPlannerPageBridge({ allowedOrigins: ["https://canvas.emory.edu"], chromeApi: {} });
    await noMain.handle({ kind: bridgeApi.KIND, version: 1, action: "open", session }, braveSender);
    assert.equal((await noMain.handle({ kind: bridgeApi.KIND, version: 1, action: "request", session, operation: "c".repeat(24), request: { method: "POST", body: draft } }, braveSender)).error, "PLANNER_BRIDGE_FORBIDDEN");
});

test("broker distinguishes rejected, empty, and resultless MAIN injections without exposing browser errors", async () => {
    const request = { method: "POST", body: draft };
    for (const [executeScript, diagnostic] of [
        [async () => { throw new Error("Cannot access contents of the page because host permission is missing"); }, "PBR-PERMISSION"],
        [async () => [], "PBR-EMPTY-RESULT"],
        [async () => [{}], "PBR-MISSING-RESULT"]
    ]) {
        const api = bridgeApi.createPlannerPageBridge({ allowedOrigins: [ORIGIN], chromeApi: { scripting: { executeScript } } });
        await api.handle({ kind: bridgeApi.KIND, version: 1, action: "open", session }, sender);
        const result = await api.handle({ kind: bridgeApi.KIND, version: 1, action: "request", session, operation: `${diagnostic.replace(/[^a-z]/gi, "x").slice(0, 16)}${"o".repeat(16)}`, request }, sender);
        assert.equal(result.error, "PLANNER_BRIDGE_EXECUTION");
        assert.equal(result.diagnostic, diagnostic);
        assert.doesNotMatch(JSON.stringify(result), /host permission|contents|error message/i);
    }
});

test("caller abort sends one cancellation and ignores a late response", async () => {
    const messages = []; let resolveRequest;
    const runtime = { sendMessage(message) {
        messages.push(message);
        if (message.action === "open") return Promise.resolve({ ok: true });
        if (message.action === "request") return new Promise((resolve) => { resolveRequest = resolve; });
        return Promise.resolve({ ok: true });
    } };
    const transport = transportApi.create({ runtime, origin: ORIGIN }), abort = new AbortController();
    const pending = transport.fetchImpl(`${ORIGIN}/api/v1/planner_notes?start_date=2026-09-05&end_date=2026-09-05&per_page=100`, { signal: abort.signal });
    while (!resolveRequest) await Promise.resolve();
    abort.abort();
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(messages.filter((message) => message.action === "cancel").length, 1);
    resolveRequest({ ok: true, status: 200, body: [], headers: {} });
    transport.dispose();
});

test("broker cancellation, disposal, and bounded response validation fail closed", async () => {
    const calls = []; let resolveRequest;
    const chromeApi = { scripting: { executeScript(options) {
        calls.push(options);
        if (options.func === bridgeApi.pageCancel) return Promise.resolve([{ result: true }]);
        return new Promise((resolve) => { resolveRequest = resolve; });
    } } };
    const api = bridgeApi.createPlannerPageBridge({ chromeApi, allowedOrigins: [ORIGIN] });
    const request = { method: "GET", query: { start_date: "2026-09-05", end_date: "2026-09-05", per_page: "100" } };
    await api.handle({ kind: bridgeApi.KIND, version: 1, action: "open", session }, sender);
    const pending = api.handle({ kind: bridgeApi.KIND, version: 1, action: "request", session, operation: "q".repeat(24), request }, sender);
    await Promise.resolve();
    assert.deepEqual(await api.handle({ kind: bridgeApi.KIND, version: 1, action: "cancel", session, operation: "q".repeat(24) }, sender), { ok: true, cancelled: true });
    assert.deepEqual(await api.handle({ kind: bridgeApi.KIND, version: 1, action: "cancel", session, operation: "q".repeat(24) }, sender), { ok: true, cancelled: true });
    resolveRequest([{ result: { ok: true, status: 200, body: [], headers: {} } }]);
    assert.equal((await pending).error, "aborted");
    api.disposeTab(7);
    assert.equal((await api.handle({ kind: bridgeApi.KIND, version: 1, action: "request", session, operation: "z".repeat(24), request }, sender)).ok, false);
    assert.equal(bridgeApi.validateResponse(request, { ok: true, status: 200, body: {}, headers: {} }).error, "PLANNER_BRIDGE_PROTOCOL");
    assert.equal(bridgeApi.validateResponse(request, { ok: true, status: 200, body: ["x".repeat(9000)], headers: {} }).error, "PLANNER_BRIDGE_PROTOCOL");
    assert.equal(bridgeApi.validateResponse(request, { ok: true, status: 200, body: [], headers: { link: "x".repeat(5000) } }).error, "PLANNER_BRIDGE_PROTOCOL");
});
