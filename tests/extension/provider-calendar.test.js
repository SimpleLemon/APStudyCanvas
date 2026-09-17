"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const transport = require("../../js/platform/transport.js");
const contract = require("../../js/platform/contract.js");
const router = require("../../js/platform/router.js");
const storage = require("../../js/platform/storage.js");
const planner = require("../../js/workspace-planner-adapter.js");
const ID = "a".repeat(32);
const raw = { id: `external:${ID}`, event_ref: `external:${ID}`, source_type: "external", provider: "google", editable: true,
    title: "Personal event", start: "2026-09-14T12:00:00.000Z", end: "2026-09-14T13:00:00.000Z", calendar_id: `external:${ID}`,
    revision: '"etag-1"', timezone: "America/New_York", sync_state: "synchronized", connection_id: ID,
    source_url: "https://calendar.google.com/calendar/event?eid=abc", credentials: "must never survive" };

test("provider event transport retains editing evidence and rejects arbitrary source links", () => {
    const result = transport.sanitizeCalendarRangeResponse({ ok: true, contractVersion: 1, events: [raw] });
    assert.equal(result.events[0].editable, true);
    assert.equal(result.events[0].revision, raw.revision);
    assert.equal(result.events[0].credentials, undefined);
    assert.equal(result.events[0].source_url, raw.source_url);
    const rejected = transport.sanitizeCalendarRangeResponse({events:[{...raw,source_url:"https://attacker.test/event"}]});
    assert.equal(rejected.events[0].source_url, undefined);
});
test("provider routes are explicitly allowlisted, and range reads are bounded", () => {
    for (const spec of [
        {path:"/api/extension/calendar/connections",method:"GET"},
        {path:`/api/extension/calendar/connections/${ID}/configure`,method:"POST",body:{calendar_ids:[ID],export_sources:["personal"],consent_version:1}},
        {path:`/api/extension/calendar/external-events/${ID}`,method:"PUT",body:{title:"Update",revision:"r1",idempotency_key:"operation-1"}},
        {path:"/api/extension/calendar/planner-events?"+new URLSearchParams({start:raw.start,end:raw.end}),method:"GET"}
    ]) assert.doesNotThrow(()=>transport.validateTransportRequest(spec));
    assert.throws(()=>transport.validateTransportRequest({path:"/api/extension/calendar/connections/connect/google",method:"POST"}));
    assert.throws(()=>transport.validateTransportRequest({path:"/api/extension/calendar/planner-events?start=2020&end=2030",method:"GET"}));
});
test("connection metadata survives the general sanitizer without exposing tokens", () => {
    const input={connections:[{id:ID,provider:"google",last_sync_at:123,calendars:[{id:ID,name:"Work",selected:1,writable:1,is_primary:1}],export_sources:["personal"],pending:0,conflicts:0,suppressed:[]}],capabilities:{providers:{google:true,microsoft:false},provider_calendar_write:true},window:{start:"2026-08-14",end:"2027-09-14"}};
    assert.deepEqual(transport.sanitizeResponseValue(input),input);
    assert.throws(()=>transport.sanitizeResponseValue({access_token:"secret"}));
});
test("provider requests require the same verified Nest user and never grant Canvas writeback", async () => {
    const calls=[];
    const nest={identityGet:async()=>({ok:true,body:{authenticated:true,profile:{id:"u1"}}}),request:async operation=>{calls.push(operation);return {ok:true,body:{ok:true,contractVersion:1,connections:[]}};}};
    const service=router.createRouter({chromeApi:{runtime:{getURL:path=>"chrome-extension://test/"+path}},storage:storage.createMemoryStorage({sync:{},local:{},session:{}}),transport:nest});
    const sender={url:"chrome-extension://test/html/popup.html"};
    let result=await service.handle(contract.createEnvelope("NEST_PROVIDER_CALENDAR",{path:"/connections",expected_user_id:"u1"},"provider-1"),sender);
    assert.equal(result.payload.ok,true);
    assert.equal(calls[0].path,"/api/extension/calendar/connections");
    result=await service.handle(contract.createEnvelope("NEST_PROVIDER_CALENDAR",{path:"/connections",expected_user_id:"u2"},"provider-2"),sender);
    assert.equal(result.payload.code,"NEST_IDENTITY_MISMATCH");
    result=await service.handle(contract.createEnvelope("NEST_PROVIDER_CALENDAR",{path:"/events",method:"POST",expected_user_id:"u1"},"provider-3"),sender);
    assert.equal(result.payload.code,"PROVIDER_ROUTE_INVALID");
});
test("provider editing cannot authorize a native Canvas or Nest mutation", async () => {
    const account={canvas:{verified:true,accountKey:"a".repeat(64),origin:"https://canvas.example.edu"},nest:{verified:true,identity:"u1",capabilities:{provider_calendar_read:true,provider_calendar_write:true},consent:[]}};
    const sent=[];const adapter=planner.createPlannerAdapter({getAccount:()=>account,send:async(type,payload)=>{sent.push({type,payload});return {ok:true,state:"queued"};},timeZone:"UTC"});
    const native=await adapter.createEvent({title:"Block",start:raw.start,end:raw.end,calendar_id:"local:default"});
    assert.equal(native.ok,false);assert.equal(sent.length,0);
    const external=await adapter.updateEvent(raw,{title:"Changed"});
    assert.equal(external.ok,true);assert.equal(sent[0].type,"NEST_PROVIDER_CALENDAR");
    assert.equal(sent[0].payload.body.revision,raw.revision);
});
test('an uncertain provider create retries with the same idempotency key',async()=>{
    const account={canvas:{verified:true,accountKey:'a'.repeat(64),origin:'https://canvas.example.edu'},nest:{verified:true,identity:'u1',capabilities:{provider_calendar_read:true,provider_calendar_write:true},consent:[]}};
    const sent=[];const adapter=planner.createPlannerAdapter({getAccount:()=>account,timeZone:'America/New_York',send:async(type,payload)=>{sent.push(payload);if(sent.length===1)throw Error('network timeout');return {ok:true,state:'queued'};}});
    const draft={title:'Holiday',start:'2026-11-01',end:'2026-11-02',all_day:true,calendar_id:`external:${ID}`};
    assert.equal((await adapter.createEvent(draft)).ok,false);
    assert.equal((await adapter.createEvent(draft)).ok,true);
    assert.equal(sent[0].body.idempotency_key,sent[1].body.idempotency_key);
    assert.equal(sent[1].body.start,'2026-11-01');assert.equal(sent[1].body.end,'2026-11-02');
});
