'use strict';
// Fixture acceptance uses production markup/styles/script, never a live account.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || '/Users/derekchen/Desktop/Nest.APStudy/node_modules/playwright');
const nest = process.env.NEST_ROOT || path.resolve(__dirname, '../../Nest.APStudy');
const output = process.env.NEST_REVIEW_OUTPUT || '/tmp/nest-connection-review';
const template = fs.readFileSync(path.join(nest, 'templates/settings.html'), 'utf8');
const article = template.match(/<article class="settings-card" id="extension-connection">[\s\S]*?<\/article>/)[0];
const styles = ['themes', 'global', 'tailwind', 'settings'].map(name => `<link rel="stylesheet" href="/static/css/${name}.css">`).join('');
const source = ref => ({source_ref: ref, label:'Personal Canvas account '+ 'LongAccountName'.repeat(12), sync_state:'waiting_for_canvas_session', access:{1:{granted:true},2:{granted:true,scopes:[]}},activity:[{id:'write1',event_ref:'user:personal-event',state:'conflict'}]});
(async () => {
 fs.mkdirSync(output,{recursive:true});
 const browser = await chromium.launch({headless:true,channel:'chromium'});
 const page = await browser.newPage();
 const errors = []; page.on('pageerror',error=>errors.push(error.message));
 let data, failing=false, decisions=[];
 const reset = () => { data={ok:true,sources:[source('src1:one'),source('src1:two')], capabilities:{calendar_upload:true,calendar_two_way_writeback:true,calendar_mirroring:true}}; };
 reset();
 await page.route('http://nest.test/**', async route => {
  const url=new URL(route.request().url());
  if(url.pathname.startsWith('/static/')) {
   const file=path.join(nest,url.pathname);
   return route.fulfill({body:fs.readFileSync(file),contentType:file.endsWith('.css')?'text/css':file.endsWith('.js')?'text/javascript; charset=utf-8':'application/octet-stream'});
  }
  if(url.pathname==='/') return route.fulfill({contentType:'text/html; charset=utf-8',body:`<!doctype html><html data-theme="system-match"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${styles}</head><body class="settings-body bg-surface text-on-surface font-body"><main class="settings-page-shell">${article}</main><script src="/static/js/settings/extension.js"></script></body></html>`});
  let body={ok:true};
  if(url.pathname==='/api/extension/connection') body=failing?{ok:false,error:{message:'Connection failed. '+ 'LongError'.repeat(30)}}:data;
  if(url.pathname.endsWith('/conflict')) body={ok:true,conflict:{expected_revision:'review-token',writeback:{operation:'update'},canvasSnapshot:{title:'Canvas title '+ 'LongTitle'.repeat(30),start:'2026-09-09T10:00:00Z'},nestSnapshot:{title:'Nest title',start:'2026-09-09T11:00:00Z'}}};
  if(url.pathname.endsWith('/resolve')) decisions.push(route.request().postDataJSON());
  return route.fulfill({status:failing?503:200,json:body});
 });
 try {
  const cases=[];
  for(const theme of ['light','dark']) for(const width of [360,490,700,1024,1440]) {
   reset(); failing=false;
   await page.setViewportSize({width,height:800}); await page.emulateMedia({colorScheme:theme}); await page.goto('http://nest.test/');
   await page.getByText('Connected to Nest. Account status is up to date.').waitFor();
   await page.getByRole('button',{name:'Review conflict'}).first().click();
   await page.getByText('Canvas version',{exact:true}).waitFor();
   const geometry=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth,smallButtons:[...document.querySelectorAll('button')].filter(n=>n.getBoundingClientRect().height<44).length}));
   assert.equal(geometry.overflow,false); assert.equal(geometry.smallButtons,0);
   cases.push({theme,width,...geometry});
   if(width===360||width===1024) await page.screenshot({path:path.join(output,`${theme}-${width}.png`),fullPage:true});
  }
  const groups=page.locator('.extension-account');
  await groups.nth(1).getByLabel('Edit planner tasks').check();
  await groups.nth(0).getByLabel('Edit personal events').check();
  await groups.nth(0).getByRole('button',{name:'Save write access'}).click();
  await page.getByText('Connection refreshed. Your unsaved access choices are preserved.').waitFor();
  assert.equal(await groups.nth(1).getByLabel('Edit planner tasks').isChecked(),true);
  await groups.nth(0).getByRole('button',{name:'Review conflict'}).click();
  await groups.nth(0).getByRole('button',{name:'Keep Canvas',exact:true}).click();
  assert.equal(decisions[0].expected_revision,'review-token');
  await page.getByRole('button',{name:'Refresh connection'}).click();
  await page.getByRole('button',{name:'Refresh connection'}).waitFor();
  data.capabilities.calendar_two_way_writeback=false;
  await page.getByRole('button',{name:'Refresh connection'}).click();
  await groups.nth(0).getByLabel('Edit personal events — unavailable on this server').waitFor();
  assert.equal(await groups.nth(0).getByLabel('Edit personal events — unavailable on this server').isDisabled(),true);
  data.sources=[]; await page.getByRole('button',{name:'Refresh connection'}).click();
  await page.getByText('No Canvas accounts connected.',{exact:false}).waitFor();
  failing=true; await page.getByRole('button',{name:'Refresh connection'}).click();
  await page.getByText('Connection failed.',{exact:false}).waitFor();
  await page.setViewportSize({width:360,height:320}); await page.evaluate(()=>document.body.style.zoom='2');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({cases,drafts:true,conflictToken:true,capabilityRefresh:true,empty:true,errors:true,zoom:true},null,2));
  console.log(`PASS: ${cases.length} responsive/theme cases; drafts, conflict token, capability refresh, empty/error, short height and zoom. ${output}`);
 } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
