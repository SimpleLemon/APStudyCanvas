"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const consent = require("../../js/platform/writeback-consent.js");
const executor = require("../../js/platform/writeback-executor.js");
const writeback = require("../../js/platform/writeback.js");
const idb = require("../../js/platform/idb.js");
const storageApi = require("../../js/platform/storage.js");
const account = "a".repeat(64), source = "src1:test";
const metadata = { source_ref: source, source_key: `canvas:${account}`, origin: "https://canvas.example.edu", nest_user_id: "nest1" };
const intent = { operation: "create", event_ref: "task:personal1", idempotency_key: "intent1", target_account: account, payload: { title: "Reminder", todo_date: "2026-09-08" } };
function harness({ execute, failReport = false } = {}) {
    const calls = [], store = idb.createMemoryBoundedStore(), storage = storageApi.createMemoryStorage();
    const transport = {
        identityGet: async () => ({ body: { authenticated: true, profile: { id: "nest1" }, capabilities: { calendar_two_way_writeback: true, calendar_mirroring: true } } }),
        request: async spec => {
            calls.push(spec);
            if (spec.path.endsWith("version=1")) return { body: { consent: { version: 1, current: true, granted: true, account_key: account, source_key: `canvas:${account}`, scopes: ["full_history_upload", "ongoing_read", "shares_ics_inclusion"] } } };
            if (spec.path.startsWith("/api/extension/consent")) return { body: { contractVersion: 1, consent: { version: 2, current: true, granted: true, account_key: account, source_key: `canvas:${account}`, scopes: consent.REQUIRED_SCOPES } } };
            if (spec.method === "GET" && spec.path.endsWith("/result")) return { body: { writebackResult: { id: "wb1", state: "queued" } } };
            if (spec.path.endsWith("/mirrors/refresh")) return { body: { eventLinks: [] } };
            if (spec.path.endsWith("/result") && failReport) throw new Error("offline");
            return { body: { ok: true, writeback: { id: "wb1" }, eventLink: { id: "link1" } } };
        }
    };
    transport.mutate = (...args) => transport.request(...args);
    const options = { storage, store, transport, executor: { execute: execute || (async () => ({ state: "applied", remote_id: "55", canvas_context_id: "user_123", result_revision: "r2" })) } };
    return { calls, store, options, service: writeback.createWritebackService(options) };
}
test("v2 consent uses envelope1 and binds profile.id, rejects old combined scope and missing identity metadata", () => {
    assert.equal(consent.normalizeIdentity({ authenticated: true, profile: { id: "nest1" } }, "nest1").ok, true);
    assert.equal(consent.normalizeIdentity({ authenticated: true, profile: { id: "nest1" } }).ok, false);
    const value = { contractVersion: 1, version: 2, current: true, granted: true, account_key: account, source_key: `canvas:${account}`, scopes: [...consent.REQUIRED_SCOPES] };
    assert.equal(consent.normalizeConsent(value, account).ok, true);
    assert.equal(consent.normalizeConsent({ ...value, scopes: ["personal_item_writeback"] }, account).ok, false);
});
test("personal writes validate kind, strict planner date and expected revision", () => {
    assert.ok(writeback.normalizeIntent(intent));
    assert.equal(writeback.normalizeIntent({ ...intent, operation: "update" }), null);
    assert.equal(writeback.normalizeIntent({ ...intent, event_ref: "assignment:1" }), null);
    for (const todo_date of ["2026-02-30", "2026-09-08T10:00:00Z"]) assert.equal(executor.normalizePayload("task", { title: "x", todo_date }, "create"), null);
    assert.equal(executor.normalizePayload("user", { course_id: 1 }, "update"), null);
});
test("durable write posts exact creation/result and duplicate drain executes once", async () => {
    let executed = 0; const h = harness({ execute: async () => { executed++; return { state: "applied", remote_id: "55", canvas_context_id: "user_123", result_revision: "r2" }; } });
    const payload = { account_key: account, source_ref: source, writebacks: [intent] };
    assert.equal((await h.service.drain(payload, { metadata })).ok, true);
    await h.service.drain(payload, { metadata });
    assert.equal(executed, 1);
    const created = h.calls.find(c => c.method === "POST" && c.path.endsWith("/writebacks"));
    assert.equal(created.body.operation, "create"); assert.equal(created.body.account_key, account);
    assert.equal(h.calls.find(c => c.method === "POST" && c.path.endsWith("/result")).body.result_revision, "r2");
});
test("restart retries result delivery without repeating Canvas mutation", async () => {
    let executed = 0; const h = harness({ failReport: true, execute: async () => { executed++; return { state: "applied", remote_id: "55", canvas_context_id: "user_123", result_revision: "r2" }; } });
    await assert.rejects(h.service.drain({ account_key: account, source_ref: source, writebacks: [intent] }, { metadata }));
    const originalRequest = h.options.transport.request;
    h.options.transport.request = async spec => spec.path.endsWith("version=1") ? originalRequest(spec) : ({ body: { contractVersion: 1, consent: { version: 2, current: true, granted: true, account_key: account, source_key: `canvas:${account}`, scopes: consent.REQUIRED_SCOPES }, eventLink: { id: "link1" }, writebackResult: { id: "wb1", state: "queued" }, ok: true } });
    const restarted = writeback.createWritebackService(h.options);
    await restarted.retry({ account_key: account, source_ref: source, idempotency_key: "intent1" }, { metadata });
    assert.equal(executed, 1);
});
test("MAIN executor verifies current account and never writes course events", async () => {
    const methods = [];
    const context = { location: { origin: metadata.origin }, document: { cookie: "_csrf_token=fake" }, URL, AbortController, setTimeout, clearTimeout,
        fetch: async (url, opts) => { methods.push(opts.method); return { status: 200, text: async () => JSON.stringify(url.endsWith("/profile") ? { id: 123 } : { id: 1, context_code: "course_1", updated_at: "r1" }) }; } };
    const run = vm.runInNewContext(`(${executor.pageOperation.toString()})`, context);
    const result = await run({ origin: metadata.origin, userId: "123", kind: "user", operation: "delete", remoteId: "1", expected_revision: "r1", payload: {} });
    assert.equal(result.state, "forbidden"); assert.deepEqual(methods, ["GET", "GET"]);
});
test("reconciliation accepts planner details alias/date response without rewriting", async () => {
    const methods = [];
    const run = vm.runInNewContext(`(${executor.pageOperation.toString()})`, { location: { origin: metadata.origin }, URL, AbortController, setTimeout, clearTimeout,
        fetch: async (url, opts) => { methods.push(opts.method); return { status: 200, text: async () => JSON.stringify(url.endsWith("/profile") ? { id: 123 } : { id: 1, user_id: 123, details: "hello", todo_date: "2026-09-08T00:00:00Z", updated_at: "r2" }) }; } });
    const result = await run({ origin: metadata.origin, userId: "123", kind: "task", operation: "update", remoteId: "1", expected_revision: "r1", payload: { details: "hello", todo_date: "2026-09-08" }, reconcile: true });
    assert.equal(result.state, "applied"); assert.deepEqual(methods, ["GET", "GET"]);
});

test("conflicts report terminal state before snapshot and resolve with the server decision token", async () => {
    const h = harness({ execute: async () => ({ state: "conflict", result_revision: "canvas-r2", canvas_snapshot: { title: "Canvas title" } }) });
    const baseRequest = h.options.transport.request;
    h.options.transport.request = async spec => {
        if (spec.method === "GET" && spec.path.includes("/event-links?")) return { body: { eventLink: { id: "link1", account_key: account, event_ref: intent.event_ref, canvas_item_id: "55", canvas_item_type: "planner_note" } } };
        if (spec.method === "GET" && spec.path.endsWith("/conflict")) return { body: { canvas_revision: "canvas-r2", expected_revision: "decision-token" } };
        return baseRequest(spec);
    };
    await h.service.drain({ account_key: account, source_ref: source, writebacks: [{ ...intent, operation: "update", expected_revision: "canvas-r1" }] }, { metadata });
    const report = h.calls.findIndex(c => c.method === "POST" && c.path.endsWith("/result"));
    const snapshot = h.calls.findIndex(c => c.path.endsWith("/conflict"));
    assert.ok(report >= 0 && snapshot > report);
    assert.deepEqual(h.calls[snapshot].body.canvas_snapshot, { title: "Canvas title" });
    await h.service.resolve({ account_key: account, source_ref: source, idempotency_key: intent.idempotency_key, choice: "keep_canvas", expected_revision: "decision-token" }, { metadata });
    assert.equal(h.calls.find(c => c.path.endsWith("/resolve")).body.expected_revision, "decision-token");
});

test("revision conflicts include the current personal Canvas snapshot without a mutation", async () => {
    const methods = [];
    const run = vm.runInNewContext(`(${executor.pageOperation.toString()})`, { location: { origin: metadata.origin }, URL, AbortController, setTimeout, clearTimeout,
        fetch: async (url, opts) => { methods.push(opts.method); return { status: 200, text: async () => JSON.stringify(url.endsWith("/profile") ? { id: 123 } : { id: 1, context_code: "user_123", title: "Changed", start_at: "2026-09-09T10:00:00Z", updated_at: "r2", all_day: false }) }; } });
    const result = await run({ origin: metadata.origin, userId: "123", kind: "user", operation: "update", remoteId: "1", expected_revision: "r1", payload: { title: "Nest" } });
    assert.equal(result.state, "conflict");
    assert.equal(result.canvas_snapshot.title, "Changed");
    assert.equal(result.canvas_snapshot.start, "2026-09-09T10:00:00Z");
    assert.deepEqual(methods, ["GET", "GET"]);
});

test("shared server fixture survives transport and unwraps durable write payloads", () => {
    const transport = require('../../js/platform/transport.js');
    const fixture = require('../fixtures/bridge-writeback-v2.json');
    const response = transport.validateBridgeResponse({ kind: 'APSTUDYCANVAS_NEST_BRIDGE_RESPONSE', version: 1, request_id: 'fixture', body: structuredClone(fixture) }, 'fixture');
    const [intent] = writeback.responseIntents(response);
    assert.equal(writeback.normalizeIntent(intent).payload.start_at, fixture.writebacks[0].payload.payload.start_at);
    assert.deepEqual(response.body.conflict, fixture.conflict);
});

test("server kill switches and revoked read consent suspend queued writes", async () => {
    for (const reason of ['capability', 'reads']) {
        let executed = 0;
        const h = harness({ execute: async () => { executed++; return {state:'applied'}; } });
        if (reason === 'capability') h.options.transport.identityGet = async () => ({ body: { authenticated: true, profile: { id: 'nest1' }, capabilities: { calendar_mirroring: true, calendar_two_way_writeback: false } } });
        else {
            const original = h.options.transport.request;
            h.options.transport.request = spec => spec.path.endsWith('version=1') ? Promise.resolve({ body: { consent: { version: 1, granted: false } } }) : original(spec);
        }
        const result = await h.service.drain({ account_key: account, source_ref: source, writebacks: [intent] }, { metadata });
        assert.equal(result.ok, false);
        assert.equal(executed, 0);
        assert.equal((await h.store.list()).length, 0);
    }
});


test("a changed conflict token cannot apply a choice the user did not review", async () => {
    const h = harness({ execute: async () => ({ state: "conflict", result_revision: "r2" }) });
    await h.service.drain({ account_key: account, source_ref: source, writebacks: [intent] }, { metadata });
    const base = h.options.transport.request;
    h.options.transport.request = spec => spec.path.endsWith("/conflict") ? Promise.resolve({body:{conflict:{canvas_revision:"r3", expected_revision:"new-token", canvasSnapshot:{title:"New"}, nestSnapshot:{title:"Nest"}}}}) : base(spec);
    const status = await h.service.status({ account_key: account, source_ref: source }, { metadata });
    assert.equal(status.items[0].conflict.canvasSnapshot.title, "New");
    const result = await h.service.resolve({ account_key: account, source_ref: source, idempotency_key: intent.idempotency_key, choice: "keep_canvas", expected_revision: "old-token" }, { metadata });
    assert.equal(result.code, "WRITEBACK_CONFLICT_CHANGED");
    assert.equal(h.calls.some(spec => spec.path.endsWith("/resolve")), false);
});

test("server-resolved update resumes with the new payload but page-supplied updates cannot reopen conflicts", async () => {
    const executed = [];
    const h = harness({ execute: async value => { executed.push(value); return executed.length === 1 ? {state:"conflict",result_revision:"r2"} : {state:"applied",result_revision:"r3"}; } });
    const update = {...intent, operation:"update",expected_revision:"r1"};
    const base = h.options.transport.request;
    h.options.transport.request = spec => spec.path.includes("/event-links?") ? Promise.resolve({body:{eventLink:{id:"link1",account_key:account,event_ref:intent.event_ref,canvas_item_id:"55",canvas_item_type:"planner_note"}}}) : base(spec);
    await h.service.drain({account_key:account,source_ref:source,writebacks:[update]}, {metadata});
    const resolved = {...update,id:"wb1",state:"queued",expected_revision:"r2",payload:{title:"Reviewed new title",todo_date:"2026-09-09"}};
    await h.service.drain({account_key:account,source_ref:source,writebacks:[resolved]}, {metadata});
    assert.equal(executed.length,1);
    const original = h.options.transport.request;
    h.options.transport.request = spec => spec.path.includes("/writebacks?") ? Promise.resolve({body:{writebacks:[resolved]}}) : original(spec);
    await h.service.drain({account_key:account,source_ref:source}, {metadata});
    assert.equal(executed.length,2);
    assert.equal(executed[1].payload.title,"Reviewed new title");
    assert.equal(executed[1].expected_revision,"r2");
    await h.service.drain({account_key:account,source_ref:source}, {metadata});
    assert.equal(executed.length,2);
});

test("Keep Nest consumes the real nested resolution response", async () => {
    const seen = [];
    const h = harness({execute: async next => {seen.push(next); return seen.length === 1 ? {state:'conflict',result_revision:'r2'} : {state:'applied',result_revision:'r3'};}});
    const update = {...intent,operation:'update',expected_revision:'r1'};
    const base = h.options.transport.request;
    h.options.transport.request = spec => {
        if(spec.path.includes('/event-links?')) return Promise.resolve({body:{eventLink:{id:'link1',account_key:account,event_ref:intent.event_ref,canvas_item_id:'55',canvas_item_type:'planner_note'}}});
        if(spec.path.endsWith('/conflict')) return Promise.resolve({body:{conflict:{canvas_revision:'r2',expected_revision:'token'}}});
        if(spec.path.endsWith('/resolve')) return Promise.resolve({body:{ok:true,conflict:{choice:'keep_nest',writeback:{...update,id:'wb1',expected_revision:'r2',payload:{...update,payload:{title:'Reviewed',todo_date:'2026-09-09'}}}}}});
        return base(spec);
    };
    await h.service.drain({account_key:account,source_ref:source,writebacks:[update]},{metadata});
    const result=await h.service.resolve({account_key:account,source_ref:source,idempotency_key:intent.idempotency_key,choice:'keep_nest',expected_revision:'token'},{metadata});
    assert.equal(result.ok,true);
    assert.equal(seen[1].payload.title,'Reviewed');
});

test("a cancelled server conflict is reflected locally without replaying Canvas", async () => {
    let count=0;
    const h=harness({execute:async()=>{count++;return {state:'conflict',result_revision:'r2'};}});
    await h.service.drain({account_key:account,source_ref:source,writebacks:[intent]},{metadata});
    const base=h.options.transport.request;
    h.options.transport.request=spec=>spec.path.endsWith('/result')?Promise.resolve({body:{writebackResult:{id:'wb1',state:'cancelled'}}}):base(spec);
    const status=await h.service.status({account_key:account,source_ref:source},{metadata});
    assert.equal(status.items[0].state,'cancelled');
    assert.equal(count,1);
});

test("missing Canvas items produce deletion snapshots while session failures do not", async () => {
    for(const status of [404,401,503]) {
        const run=vm.runInNewContext(`(${executor.pageOperation.toString()})`,{location:{origin:metadata.origin},URL,AbortController,setTimeout,clearTimeout,
            fetch:async url=>({status:url.endsWith('/profile')?200:status,text:async()=>JSON.stringify(url.endsWith('/profile')?{id:123}:{})})});
        const result=await run({origin:metadata.origin,userId:'123',kind:'user',operation:'update',remoteId:'1',expected_revision:'r1',payload:{title:'Nest'}});
        assert.equal(Boolean(result.canvas_snapshot?.deleted),status===404);
        assert.equal(result.state==='conflict',status===404);
    }
});

test("conflicts pause later writes to that item while independent items continue", async () => {
    const seen=[];
    const h=harness({execute:async value=>{seen.push(value.idempotency_key);return value.event_ref===intent.event_ref?{state:'conflict',result_revision:'r2'}:{state:'applied',remote_id:'56',canvas_context_id:'user_123',result_revision:'r3'};}});
    await h.service.drain({account_key:account,source_ref:source,writebacks:[intent,{...intent,idempotency_key:'later-same-item'},{...intent,idempotency_key:'other-item',event_ref:'task:other'}]},{metadata});
    assert.deepEqual(seen,['intent1','other-item']);
});

test("failed result delivery does not block independent personal items", async () => {
    const seen=[];
    const h=harness({failReport:true,execute:async value=>{seen.push(value.idempotency_key);return {state:'applied',remote_id:'56',canvas_context_id:'user_123',result_revision:'r3'};}});
    await assert.rejects(h.service.drain({account_key:account,source_ref:source,writebacks:[intent,{...intent,idempotency_key:'other-item',event_ref:'task:other'}]},{metadata}));
    assert.deepEqual(seen,['intent1','other-item']);
});

test("server unlink cancels a durable retry before Canvas executes again", async () => {
    let executions = 0;
    const h = harness({ execute: async () => { executions++; return { state: "waiting_for_canvas_session" }; } });
    await h.service.drain({ account_key: account, source_ref: source, writebacks: [intent] }, { metadata });
    const base = h.options.transport.request;
    h.options.transport.request = spec => spec.method === "GET" && spec.path.endsWith("/result")
        ? Promise.resolve({ body: { writebackResult: { id: "wb1", state: "cancelled" } } }) : base(spec);
    const restarted = writeback.createWritebackService(h.options);
    const result = await restarted.retry({ account_key: account, source_ref: source, idempotency_key: intent.idempotency_key }, { metadata });
    assert.equal(result.item.state, "cancelled");
    assert.equal(executions, 1);
});

test("cancellation during Canvas execution retains the outcome without recreating a mirror", async () => {
    let cancelled = false;
    const h = harness({ execute: async () => {
        cancelled = true;
        return { state: "applied", remote_id: "55", canvas_context_id: "user_123", result_revision: "r2" };
    } });
    const base = h.options.transport.request;
    h.options.transport.request = spec => cancelled && spec.method === "GET" && spec.path.endsWith("/result")
        ? Promise.resolve({ body: { writebackResult: { id: "wb1", state: "cancelled" } } }) : base(spec);
    const result = await h.service.drain({ account_key: account, source_ref: source, writebacks: [intent] }, { metadata });
    assert.equal(result.items[0].state, "cancelled");
    assert.equal(h.calls.some(spec => spec.method === "POST" && spec.path.endsWith("/event-links")), false);
    const [saved] = await h.store.list();
    assert.equal(saved.value.result.remote_id, "55");
    assert.equal(saved.value.reported, true);
});

test("malformed server cancellation checks suspend execution", async () => {
    let executions = 0;
    const h = harness({ execute: async () => { executions++; return { state: "applied" }; } });
    const base = h.options.transport.request;
    h.options.transport.request = spec => spec.method === "GET" && spec.path.endsWith("/result")
        ? Promise.resolve({ body: { writebackResult: { id: "another-operation", state: "queued" } } }) : base(spec);
    await assert.rejects(h.service.drain({ account_key: account, source_ref: source, writebacks: [intent] }, { metadata }), /WRITEBACK_RESPONSE_INVALID/);
    assert.equal(executions, 0);
});

test("activity refresh waits for durable execution before reconciling cancellation", async () => {
    let finish, started;
    const executing = new Promise(resolve => { started = resolve; });
    const h = harness({ execute: () => new Promise(resolve => { finish = resolve; started(); }) });
    const drain = h.service.drain({ account_key: account, source_ref: source, writebacks: [intent] }, { metadata });
    await executing;
    let refreshed = false;
    const status = h.service.status({ account_key: account, source_ref: source }, { metadata }).then(value => { refreshed = true; return value; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(refreshed, false);
    finish({ state: "applied", remote_id: "55", canvas_context_id: "user_123", result_revision: "r2" });
    await drain;
    assert.equal((await status).items[0].state, "applied");
});

test("read revocation during execution preserves the outcome for consented delivery only", async () => {
    let revoked = false, executions = 0;
    const h = harness({ execute: async () => {
        executions++;
        revoked = true;
        return { state: "applied", remote_id: "55", canvas_context_id: "user_123", result_revision: "r2" };
    } });
    const base = h.options.transport.request;
    h.options.transport.request = spec => revoked && spec.path.endsWith("version=1")
        ? Promise.resolve({ body: { consent: { version: 1, current: false, granted: false } } }) : base(spec);
    await assert.rejects(h.service.drain({ account_key: account, source_ref: source, writebacks: [intent] }, { metadata }));
    assert.equal(h.calls.some(spec => spec.method === "POST" && spec.path.endsWith("/event-links")), false);
    const [saved] = await h.store.list();
    assert.equal(saved.value.result.remote_id, "55");
    assert.equal(saved.value.reported, false);
    const restarted = writeback.createWritebackService(h.options);
    assert.equal((await restarted.retry({ account_key: account, source_ref: source, idempotency_key: intent.idempotency_key }, { metadata })).ok, false);
    revoked = false;
    assert.equal((await restarted.retry({ account_key: account, source_ref: source, idempotency_key: intent.idempotency_key }, { metadata })).item.state, "applied");
    assert.equal(executions, 1);
});

test("worker restart marks an ambiguous create for reconciliation instead of replay", async () => {
    const h = harness({ execute: async () => { throw new Error("lost browser reply"); } });
    await h.service.drain({ account_key: account, source_ref: source, writebacks: [intent] }, { metadata });
    const reconciliations = [];
    const restarted = writeback.createWritebackService({ ...h.options, executor: { execute: async (value, options) => {
        reconciliations.push(options.reconcile);
        return { state: "conflict", error_code: "WRITEBACK_CREATE_OUTCOME_UNCERTAIN" };
    } } });
    await restarted.retry({ account_key: account, source_ref: source, idempotency_key: intent.idempotency_key }, { metadata });
    assert.deepEqual(reconciliations, [true]);
});

test("shared personal-write fixtures pass through authenticated response normalization", () => {
    for (const entry of require('../fixtures/bridge-personal-write-fields.json')) {
        const queued = { operation: entry.operation, event_ref: entry.ref, idempotency_key: 'fixture', target_account: account,
            expected_revision: entry.operation === 'create' ? null : 'r1' };
        const [normalized] = writeback.responseIntents({ body: { writebacks: [{ ...queued, payload: { ...queued, payload: entry.fields } }] } });
        assert.equal(Boolean(writeback.normalizeIntent(normalized)), entry.valid, entry.name);
    }
});


test("mirror observation reads personal fields without a Canvas mutation", async () => {
    const methods = [];
    const run = vm.runInNewContext(`(${executor.pageOperation.toString()})`, { location: { origin: metadata.origin }, URL, AbortController, setTimeout, clearTimeout,
        fetch: async (url, opts) => { methods.push(opts.method); return { status: 200, text: async () => JSON.stringify(url.endsWith("/profile") ? { id: 123 } : { id: 55, context_code: "user_123", title: "Remote edit", description: "", start_at: "2026-09-09T10:00:00Z", end_at: "2026-09-09T11:00:00Z", updated_at: "r2", all_day: false }) }; } });
    const result = await run({ origin: metadata.origin, userId: "123", kind: "user", operation: "observe", remoteId: "55", payload: {} });
    assert.equal(result.state, "observed");
    assert.equal(result.canvas_snapshot.title, "Remote edit");
    assert.deepEqual(methods, ["GET", "GET"]);
});

test("automatic drain refreshes bound mirrors before fetching pending writes", async () => {
    const executed = [], seen = [];
    const h = harness({execute: async value => { executed.push(value); return {state:"observed",result_revision:"r2",canvas_snapshot:{title:"Canvas task",deadline_at:"2026-09-10"}}; }});
    const base = h.options.transport.request;
    h.options.transport.request = async spec => {
        seen.push(spec);
        if (spec.path.endsWith("/mirrors/refresh")) return spec.body.link_id ? {body:{result:{state:"applied"}}} : {body:{eventLinks:[{id:"link1",account_key:account,event_ref:"task:personal1",canvas_item_type:"planner_note",canvas_item_id:"55",expected_revision:"b".repeat(64)}]}};
        if (spec.path.includes("/writebacks?")) return {body:{writebacks:[]}};
        return base(spec);
    };
    await h.service.drain({account_key:account,source_ref:source},{metadata});
    assert.equal(executed.length,1);
    assert.equal(executed[0].operation,"observe");
    const index=seen.findIndex(spec=>spec.body?.link_id);
    assert.ok(index>=0 && index<seen.findIndex(spec=>spec.path.includes("/writebacks?")));
    assert.equal(seen[index].body.expected_revision,"b".repeat(64));
    assert.equal(seen[index].body.canvas_snapshot.title,"Canvas task");
});


test("server-discovered deletion conflicts enter activity without executing a write", async () => {
    let executed = 0;
    const h = harness({execute:async()=>{executed++;return {state:"applied"};}});
    const base = h.options.transport.request;
    h.options.transport.request = async spec => {
        if(spec.path.includes("/writebacks?")) return {body:{writebacks:[{...intent,operation:"update",expected_revision:"r1",id:"wb1",state:"conflict",result_revision:"deleted",error_code:"CANVAS_ITEM_MISSING"}]}};
        if(spec.path.includes("/event-links?")) return {body:{eventLink:{id:"link1",account_key:account,event_ref:intent.event_ref,canvas_item_id:"55",canvas_item_type:"planner_note"}}};
        if(spec.path.endsWith("/result")) return {body:{writebackResult:{id:"wb1",state:"conflict"}}};
        if(spec.path.endsWith("/conflict")) return {body:{canvas_snapshot:{deleted:true},expected_revision:"decision",canvas_revision:"deleted"}};
        return base(spec);
    };
    const result=await h.service.drain({account_key:account,source_ref:source},{metadata});
    assert.equal(executed,0);
    assert.equal(result.items[0].state,"conflict");
    assert.equal(result.items[0].result_revision,"deleted");
});

test("mirror refresh requests and observations survive the real transport boundary", () => {
    const transport = require('../../js/platform/transport.js');
    const path = `/api/extension/calendar/sources/${encodeURIComponent(source)}/mirrors/refresh`;
    assert.equal(transport.validateTransportRequest({method:'POST',path,body:{}}).method,'POST');
    assert.throws(()=>transport.validateTransportRequest({method:'GET',path}));
    const response = transport.validateBridgeResponse({kind:'APSTUDYCANVAS_NEST_BRIDGE_RESPONSE',version:1,request_id:'mirror-sync',body:{eventLinks:[{
        id:'link1',account_key:account,event_ref:'task:personal1',canvas_item_type:'planner_note',canvas_item_id:'55',expected_revision:'b'.repeat(64)
    }]}},'mirror-sync');
    assert.equal(response.body.eventLinks[0].expected_revision,'b'.repeat(64));
    const body={link_id:'link1',expected_revision:'b'.repeat(64),canvas_revision:'r2',canvas_snapshot:{title:'Task',deadline_at:'2026-09-09'}};
    assert.deepEqual(JSON.parse(transport.validateTransportRequest({method:'POST',path,body}).body),body);
});


test("server null optional calendar leaves the verified personal destination implicit", () => {
    assert.ok(writeback.normalizeIntent({...intent,target_calendar:null}));
    assert.equal(writeback.normalizeIntent({...intent,target_calendar:null}).target_calendar,undefined);
    assert.equal(writeback.normalizeIntent({...intent,target_calendar:""}),null);
});
