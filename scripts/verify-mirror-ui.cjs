'use strict';
// Production editor and adapter with synthetic responses; no signed-in browser profile.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || '/Users/derekchen/Desktop/Nest.APStudy/node_modules/playwright');
const nest=path.resolve(__dirname,'../../Nest.APStudy');
const output='/tmp/mirror-ui-review';
(async()=>{
 fs.mkdirSync(output,{recursive:true});
 const browser=await chromium.launch({headless:true,channel:'chromium'});
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 let writes=[],fail=false,revision=1,sources;
 const reset=()=>{sources=[{source_ref:'src1:one',label:'Personal '+ 'Long account name '.repeat(15),destination:'Personal Canvas calendar',allowed:true,linked:false,state:'not_selected',pending_id:null},{source_ref:'src1:two',label:'Second account',destination:'Personal Canvas calendar',allowed:true,linked:false,state:'not_selected',pending_id:null}];};reset();
 await page.route('http://nest.test/**',async route=>{
  const url=new URL(route.request().url());
  if(url.pathname.startsWith('/static/')){const file=path.join(nest,url.pathname);return route.fulfill({body:fs.readFileSync(file),contentType:file.endsWith('.css')?'text/css':file.endsWith('.js')?'text/javascript; charset=utf-8':'application/octet-stream'});}
  if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:`<!doctype html><html data-theme="system-match"><head><meta name="viewport" content="width=device-width,initial-scale=1">${['themes','global','calendar-overlays'].map(x=>`<link rel="stylesheet" href="/static/css/${x}.css">`).join('')}</head><body><button id="opener">Personal item</button><script src="/static/js/calendar/events/mirrors.js"></script><script type="module">import {createCalendarDataAdapter} from '/static/js/calendar/adapter.js';window.APStudyCalendarDataAdapter=createCalendarDataAdapter();document.querySelector('#opener').onclick=()=>window.APStudyCalendarMirrors.open({event:{event_ref:'user:one',title:'Personal '+ 'Long title '.repeat(30)},opener:document.querySelector('#opener')});</script></body></html>`});
  if(fail)return route.fulfill({status:503,json:{ok:false}});
  if(route.request().method()==='POST'){
   const data=route.request().postDataJSON();writes.push(data);
   if(data.expected_revision!==String(revision))return route.fulfill({status:409,json:{ok:false}});
   const choice=sources.find(x=>x.source_ref===data.source_ref);
   revision++;
   if(data.action==='mirror'){choice.pending_id='operation';choice.state='queued';}
   if(data.action==='unlink'){choice.pending_id=null;choice.linked=false;choice.state='not_selected';}
   return route.fulfill({json:{ok:true,result:{state:data.action==='unlink'?'unlinked':data.action==='delete_local'?'deleted_local':'queued'}}});
  }
  return route.fulfill({json:{ok:true,contractVersion:1,item:{event_ref:'user:one',title:'Personal '+ 'Long title '.repeat(30),expected_revision:String(revision),sources},capabilities:{calendar_two_way_writeback:true,calendar_mirroring:true}}});
 });
 try{
  await page.goto('http://nest.test/');await page.locator('#opener').click();await page.getByRole('button',{name:'Mirror to Canvas',exact:true}).waitFor();
  await page.waitForFunction(()=>!document.querySelector('[data-refresh]').disabled);
  let cases=0;
  for(const theme of ['light','dark'])for(const width of [360,490,700,1024,1440]){
   await page.emulateMedia({colorScheme:theme});await page.setViewportSize({width,height:800});
   const dialog=page.getByRole('dialog');assert.equal(await dialog.evaluate(n=>n.scrollWidth>n.clientWidth+1),false);
   for(const button of await dialog.locator('button:visible').all())assert.ok(await button.evaluate(n=>n.getBoundingClientRect().height)>=44);
   if(width===360||width===1024)await page.screenshot({path:`${output}/${theme}-${width}.png`});cases++;
  }
  await page.locator('[data-account]').selectOption('src1:two');await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('[data-refresh]').disabled);assert.equal(await page.locator('[data-account]').inputValue(),'src1:two');
  await page.getByRole('button',{name:'Mirror to Canvas',exact:true}).click();await page.getByText('Queued. Keep the extension running',{exact:false}).waitFor();assert.equal(writes[0].source_ref,'src1:two');assert.equal(await page.locator('[data-action="mirror"]').isDisabled(),true);
  await page.getByRole('button',{name:'Unlink, keep copies',exact:true}).click();await page.getByText('Unlinked. Both copies are retained.',{exact:true}).waitFor();
  revision++;await page.getByRole('button',{name:'Mirror to Canvas',exact:true}).click();await page.getByText('The choice was not confirmed.',{exact:false}).waitFor();assert.equal(writes.at(-1).expected_revision,String(revision-1));
  await page.getByRole('button',{name:'Deletion options…',exact:true}).click();assert.equal(await page.locator('[data-action="delete_local"]').isDisabled(),true);await page.locator('[data-confirm]').check();assert.equal(await page.locator('[data-action="delete_local"]').isEnabled(),true);
  await page.setViewportSize({width:360,height:430});await page.evaluate(()=>document.documentElement.style.zoom='2');await page.locator('[data-action="delete_local"]').scrollIntoViewIfNeeded();assert.equal(await page.getByRole('dialog').evaluate(n=>n.scrollWidth>n.clientWidth+1),false);await page.evaluate(()=>document.documentElement.style.zoom='');
  await page.getByRole('button',{name:'Close',exact:true}).click();assert.equal(await page.locator('#opener').evaluate(n=>n===document.activeElement),true);
  fail=true;await page.locator('#opener').click();await page.getByText('Could not load this item.',{exact:false}).waitFor();assert.equal(await page.locator('[data-action="mirror"]').isDisabled(),true);
  fail=false;sources=[];await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.getByText('No connected Canvas accounts.',{exact:false}).waitFor();await page.keyboard.press('Escape');assert.equal(await page.getByRole('dialog').count(),0);
  assert.deepEqual(errors,[]);console.log(JSON.stringify({cases,interactions:['account draft','mirror queue','unlink','stale token','explicit deletion','short 200% zoom','focus','error','empty'],output},null,2));
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
