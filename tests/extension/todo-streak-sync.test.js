"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const sync = require("../../js/content/todo-streak-sync.js");
const transport = require("../../js/platform/transport.js");
const scope = { accountKey: "a".repeat(64), timeZone: "UTC" };
const localKey = `todo-completion:${scope.accountKey}`;
const metaKey = `todo-streak-sync:${scope.accountKey}:UTC`;
const remote = (marks = []) => ({ ok: true, contractVersion: 1, nestUserId: "one", revision: 2,
    marks, history: { v: 4, policyVersion: 4, accountKey: scope.accountKey, timeZone: "UTC", days: [], forgiven: [], todayComplete: true } });

test("streak response survives the transport sanitizer including date outcomes", () => {
    const data = remote(); data.history.days.push({ date: "2026-09-11", state: "missed" });
    const clean = transport.sanitizeResponseValue(data);
    assert.deepEqual(clean, data);
    assert.equal(sync.decode(clean).history.days["2026-09-11"], "missed");
});
test("first connection imports local marks and adopts server marks", async () => {
    const store = { [localKey]: { local: true, shared: false } };
    const calls = [];
    const api = sync.create({ read: async k => store[k], write: async (k,v) => { store[k]=v; }, send: async (type,payload) => {
        calls.push({ type,payload });
        return type === 'NEST_STREAK_GET' ? remote([{id:'shared',completed:true,revision:1}]) : remote([{id:'shared',completed:true,revision:1},{id:'local',completed:true,revision:2}]);
    } });
    const result = await api.prepare(scope);
    assert.equal(result.connected, true);
    assert.deepEqual(calls[1].payload.marks, [{id:'local',completed:true,revision:0}]);
    assert.deepEqual(store[localKey], {shared:true,local:true});
});
test("newer server mark wins conflicting offline change", async () => {
    const store = { [localKey]: { task:false }, [metaKey]: {nestUserId:'one',applied:{task:true},revisions:{task:1}} };
    let writes = 0;
    const api = sync.create({read:async k=>store[k],write:async(k,v)=>{store[k]=v;},send:async type=>{
        if(type==='NEST_STREAK_SYNC') writes++;
        return remote([{id:'task',completed:true,revision:2}]);
    }});
    await api.prepare(scope);
    assert.equal(writes,0); assert.equal(store[localKey].task,true);
});
test("click during a sync read survives and defers observation upload", async () => {
    const store = { [localKey]: { task:false }, [metaKey]: {nestUserId:'one',applied:{task:false},revisions:{task:1}} };
    const api = sync.create({read:async k=>store[k],write:async(k,v)=>{store[k]=v;},send:async ()=>{
        store[localKey]={task:true}; return remote([{id:'task',completed:false,revision:1}]);
    }});
    const session = await api.prepare(scope);
    assert.equal(store[localKey].task,true);
    assert.equal(await api.publish(session, {}, {isCurrent:()=>true}),null);
});
test("failed reconciliation does not overwrite completion marks", async () => {
    const store = {[localKey]:{task:true},[metaKey]:{nestUserId:'one'}};
    const api=sync.create({read:async k=>store[k],write:async()=>{throw Error('must not write');},send:async()=>({ok:false})});
    assert.equal((await api.prepare(scope)).state,'pending');
});

test("background streak routes bind dashboard origin and Nest identity before syncing", async () => {
    const contract = require('../../js/platform/contract.js');
    const storage = require('../../js/platform/storage.js');
    const router = require('../../js/platform/router.js');
    const origin='https://canvas.example.edu';
    const source={source_ref:'src1:streak',source_key:`canvas:${scope.accountKey}`,origin,nest_user_id:'one',provider_user_id:'canvas-user',active:true};
    const area=storage.createMemoryStorage({sync:{custom_domain:[origin]},local:{'platform.accountMetadata':{version:1,accounts:[{origin,accountKey:scope.accountKey}]},'platform.sourceMetadata':{version:1,accounts:{[scope.accountKey]:source}}},session:{}});
    let identity='one',writes=0;
    const nest={identityGet:async()=>({ok:true,body:{state:'authenticated',profile:{id:identity}}}),
        request:async()=>({ok:true,status:200,body:remote()}),mutate:async()=>{writes++;return {ok:true,status:200,body:remote()};}};
    const service=router.createRouter({chromeApi:{runtime:{getURL:v=>`chrome-extension://test/${v}`}},storage:area,transport:nest});
    const get=()=>service.handle(contract.createEnvelope('NEST_STREAK_GET',scope,'read'),{url:origin+'/'});
    const first=await get(); assert.equal(first.payload.ok,true,JSON.stringify(first));
    const write=await service.handle(contract.createEnvelope('NEST_STREAK_SYNC',{...scope,expectedRevision:0,marks:[]},'write'),{url:origin+'/'});
    assert.equal(write.payload.ok,true); assert.equal(writes,1);
    identity='other'; assert.equal((await get()).payload.code,'NEST_IDENTITY_MISMATCH');
    const foreign=await service.handle(contract.createEnvelope('NEST_STREAK_GET',{...scope,accountKey:'b'.repeat(64)},'foreign'),{url:origin+'/'});
    assert.equal(foreign.payload.code,'CANVAS_ACCOUNT_BINDING_REQUIRED');
});

test("explicit disconnection resumes local tracking and uploads only changed day outcomes", async () => {
    const api=sync.create({read:async()=>({nestUserId:'one'}),write:async()=>{throw Error('unexpected write');},send:async()=>({ok:false,code:'NEST_SIGNED_OUT'})});
    assert.equal((await api.prepare(scope)).state,'local');
    const data={since:'2026-09-10',lastSettledDate:'2026-09-11',todayComplete:true,days:{'2026-09-10':'missed','2026-09-11':'none'}};
    assert.deepEqual(sync.observation(data,{days:{'2026-09-10':'missed'}}).days,[{date:'2026-09-11',state:'none'}]);
});

test("an unavailable optional transport allows local tracking but preserves a connected account's pending state", async () => {
    for (const [meta, expected] of [[null, 'local'], [{nestUserId:'one'}, 'pending']]) {
        const api = sync.create({read:async key=>key===metaKey?meta:null,write:async()=>{throw Error('unexpected write');},send:async()=>{throw Error('offline');}});
        assert.equal((await api.prepare(scope)).state,expected);
    }
});
