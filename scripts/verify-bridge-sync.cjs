'use strict';
// Production executor + transport + durable service against isolated Flask/Canvas fixtures.
const path=require('node:path'), fs=require('node:fs'), assert=require('node:assert/strict');
const {spawn}=require('node:child_process');const readline=require('node:readline');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || '/Users/derekchen/Desktop/Nest.APStudy/node_modules/playwright');
const nest=path.resolve(__dirname,'../../Nest.APStudy');
const transportApi=require('../js/platform/transport.js');
const executorApi=require('../js/platform/writeback-executor.js');
const writeback=require('../js/platform/writeback.js');
const idb=require('../js/platform/idb.js');const storageApi=require('../js/platform/storage.js');
(async()=>{
 const child=spawn(path.join(nest,'.venv/bin/python'),[path.join(__dirname,'bridge-sync-fixture.py')],{cwd:nest,env:{...process.env,PYTHONPATH:nest},stdio:['pipe','pipe','pipe']});
 const errors=[];child.stderr.on('data',data=>errors.push(String(data)));const pending=[];
 readline.createInterface({input:child.stdout}).on('line',line=>{const job=pending.shift();if(!job)return;try{const value=JSON.parse(line);value.ok?job.resolve(value.result):job.reject(new Error(value.error));}catch(e){job.reject(e);}});
 child.on('exit',code=>{while(pending.length)pending.shift().reject(new Error('Fixture exited '+code));});
 const rpc=message=>new Promise((resolve,reject)=>{pending.push({resolve,reject});child.stdin.write(JSON.stringify(message)+'\n');});
 let browser;
 try{
  const accounts=await rpc({action:'seed'});
  let loseNextResult=false;
  const transport=transportApi.createNestTransport({fetchImpl:async(url,options)=>{
   const u=new URL(url);const result=await rpc({action:'request',path:u.pathname+u.search,method:options.method,headers:options.headers,body:options.body});
   if(loseNextResult && options.method==='POST' && u.pathname.endsWith('/result')){loseNextResult=false;throw new Error('Simulated response loss after backend commit');}
   return new Response(result.body,{status:result.status,headers:result.headers});
  }});
  const identity=await transport.identityGet({requestId:'fixture-identity'});
  assert.equal(identity.body.capabilities?.calendar_two_way_writeback,true,'Real identity response must expose the capability the executor checks');
  browser=await chromium.launch({headless:true,channel:'chromium'});
  const page=await browser.newPage();const origin=accounts[0].origin;let currentUser='1',revision=0,nextId=50;
  const canvas=new Map(), canvasWrites=[], browserErrors=[];page.on('pageerror',e=>browserErrors.push(e.message));
  await page.route(origin+'/**',async route=>{
   const req=route.request(),url=new URL(req.url());
   if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><title>Isolated Canvas fixture</title>'});
   if(url.pathname.endsWith('/profile'))return route.fulfill({json:{id:currentUser}});
   const id=url.pathname.split('/').at(-1);let item=canvas.get(id);
   if(req.method()==='GET')return route.fulfill(item?{json:item}:{status:404,json:{}});
   canvasWrites.push({method:req.method(),id,user:currentUser});
   if(req.method()==='POST'){const fields=req.postDataJSON().calendar_event;item={...fields,id:String(++nextId),updated_at:'r'+(++revision)};canvas.set(item.id,item);return route.fulfill({json:item});}
   if(req.method()==='PUT'){Object.assign(item,req.postDataJSON().calendar_event,{updated_at:'r'+(++revision)});return route.fulfill({json:item});}
   if(req.method()==='DELETE'){canvas.delete(id);return route.fulfill({json:{id}});}
   throw new Error('Unexpected Canvas request');
  });
  await page.goto(origin);await page.context().addCookies([{name:'_csrf_token',value:'fixture-only',url:origin}]);
  const chromeApi={tabs:{query:async()=>[{id:1,url:origin}],sendMessage:async()=>({ok:true,origin,canvasUser:{id:currentUser}})},scripting:{executeScript:async spec=>[{result:await page.evaluate(({fn,arg})=>(0,eval)('('+fn+')')(arg),{fn:spec.func.toString(),arg:spec.args[0]})}]}};
  const executor=executorApi.createWritebackExecutor({chromeApi,allowedOrigins:[origin]});
  const store=idb.createMemoryBoundedStore(),storage=storageApi.createMemoryStorage();
  const options={store,storage,transport,executor};let service=writeback.createWritebackService(options);
  const drain=async(index=0)=>{const metadata=accounts[index];const result=await service.drain({account_key:metadata.account_key,source_ref:metadata.source_ref},{metadata,requestId:'fixture-drain'});assert.equal(result.ok,true,JSON.stringify(result));return result;};
  const state=()=>rpc({action:'state'});const title=async item=>(await state()).user_events.find(row=>row.id===item).title;
  await rpc({action:'mirror',item:'one'});const initial=await drain();assert.equal(canvasWrites.length,1,JSON.stringify(initial));assert.equal(canvas.size,1);
  const remote=[...canvas.values()][0];
  await rpc({action:'edit',title:'Nest edit 1'});await drain();assert.equal(remote.title,'Nest edit 1');assert.equal(canvasWrites.length,2);
  remote.title='Canvas edit 1';remote.updated_at='r'+(++revision);await drain();assert.equal(await title('one'),'Canvas edit 1');assert.equal(canvasWrites.length,2);
  await rpc({action:'edit',title:'Nest conflict'});remote.title='Canvas conflict';remote.updated_at='r'+(++revision);await drain();
  let status=await service.status({account_key:accounts[0].account_key,source_ref:accounts[0].source_ref},{metadata:accounts[0],requestId:"fixture-action"});
  let conflict=status.items.find(item=>item.state==='conflict');assert.ok(conflict?.conflict?.canvasSnapshot);
  let result=await service.resolve({account_key:accounts[0].account_key,source_ref:accounts[0].source_ref,idempotency_key:conflict.idempotency_key,choice:'keep_canvas',expected_revision:conflict.conflict.expected_revision},{metadata:accounts[0],requestId:"fixture-action"});assert.equal(result.ok,true);assert.equal(await title('one'),'Canvas conflict');
  await drain();assert.equal(canvasWrites.length,2);
  await rpc({action:'edit',title:'Keep Nest value'});remote.title='Other Canvas edit';remote.updated_at='r'+(++revision);await drain();
  status=await service.status({account_key:accounts[0].account_key,source_ref:accounts[0].source_ref},{metadata:accounts[0],requestId:'fixture-conflict'});
  conflict=status.items.find(item=>item.state==='conflict');
  result=await service.resolve({account_key:accounts[0].account_key,source_ref:accounts[0].source_ref,idempotency_key:conflict.idempotency_key,choice:'keep_nest',expected_revision:conflict.conflict.expected_revision},{metadata:accounts[0],requestId:'fixture-choice'});assert.equal(result.ok,true);
  await drain();assert.equal(remote.title,'Keep Nest value');assert.equal(canvasWrites.length,3);
  await rpc({action:'edit',title:'Concurrent refresh edit'});await Promise.all([drain(),drain()]);assert.equal(canvasWrites.length,4);assert.equal(remote.title,'Concurrent refresh edit');
  await rpc({action:'mirror',item:'three'});loseNextResult=true;await assert.rejects(drain());assert.equal(canvasWrites.length,5);
  service=writeback.createWritebackService(options);await drain();assert.equal(canvasWrites.length,5,'restart must not duplicate a create or update');
  await rpc({action:'mirror',item:'two',account:1});await drain(1);assert.equal(canvasWrites.length,5,'wrong Canvas account must not write');currentUser='2';await drain(1);assert.equal(canvasWrites.length,6);currentUser='1';
  canvas.delete(remote.id);await drain();status=await service.status({account_key:accounts[0].account_key,source_ref:accounts[0].source_ref},{metadata:accounts[0],requestId:"fixture-action"});conflict=status.items.find(item=>item.state==='conflict');assert.equal(conflict.conflict.canvasSnapshot.deleted,true);assert.equal(await title('one'),'Concurrent refresh edit');
  await rpc({action:'unlink',item:'one'});await drain();assert.equal(canvasWrites.length,6);
  assert.deepEqual(browserErrors,[]);
  console.log(JSON.stringify({passed:['real identity/capabilities','CSRF and response sanitization','create','Nest edit','Canvas edit','conflict snapshots/Keep Canvas','Keep Nest','concurrent refreshes','response loss after commit','restart','account isolation','remote deletion','unlink'],canvasWrites:canvasWrites.length},null,2));
 }catch(error){fs.writeFileSync('/tmp/bridge-sync-fixture-errors.log',errors.join(''));throw error;}
 finally{await browser?.close();child.stdin.end();}
})().catch(error=>{console.error(error);process.exitCode=1;});
