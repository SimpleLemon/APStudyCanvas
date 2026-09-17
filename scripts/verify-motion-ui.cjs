'use strict';
// Synthetic production-extension acceptance and CDP traces; no personal profile.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || '/Users/derekchen/Desktop/Nest.APStudy/node_modules/playwright');
const root = path.resolve(__dirname, '..');
const output = process.env.MOTION_OUTPUT || fs.mkdtempSync(path.join(os.tmpdir(), 'motion-review-'));
const baseline = process.env.MOTION_BASELINE === '1';
(async () => {
 fs.mkdirSync(output, { recursive: true });
 const context = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'motion-browser-')), {headless:true,channel:'chromium',args:[`--disable-extensions-except=${root}`,`--load-extension=${root}`],viewport:{width:1440,height:900}});
 const report = {synthetic:true,baseline,errors:[],samples:[],memory:[]};
 try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const page = await context.newPage(); page.on('pageerror',e=>report.errors.push(e.stack || e.message)); page.on('dialog',d=>d.accept());
  await page.route('https://canvas.emory.edu/**', route => {
   const u = new URL(route.request().url());
   if(u.pathname.startsWith('/api/')) return route.fulfill({json:u.pathname.includes('/users/self')?{id:123,name:'Synthetic student'}:[]});
   return route.fulfill({contentType:'text/html',body:`<!doctype html><html><head><style>body{margin:0;background:#e3edf4}#header{height:80px;background:#356b95}article{padding:12px;border-bottom:1px solid #aaa}</style></head><body class="dashboard"><div id="application"><header id="header">Canvas motion fixture</header><main id="main"><div id="content">${Array.from({length:800},(_,i)=>`<article><h3>Assignment ${i}</h3><p>Dense synthetic course content</p><span>Upcoming</span></article>`).join('')}</div></main></div></body></html>`});
  });
  await page.goto('https://canvas.emory.edu/');
  await page.waitForTimeout(500);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  async function launch() {
   const start=Date.now();
   const result=await worker.evaluate(async()=>{const [tab]=await chrome.tabs.query({url:'https://canvas.emory.edu/*'});return overlayLauncher.launch(tab,{})});assert.equal(result.ok,true);
   await page.waitForFunction(()=>!!document.getElementById('apstudycanvas-overlay-root'));
   let frame;
   for(let i=0;i<80&&!frame;i++){frame=page.frames().find(f=>f.url().includes('/html/popup.html'));if(!frame)await page.waitForTimeout(25)}
   assert.ok(frame);await frame.waitForFunction(()=>window.APStudyCanvasWorkspace && document.body.dataset.settingsState==='ready');
   const ms=Date.now()-start; await page.waitForTimeout(300); return {frame,ms};
  }
  async function close(frame) { await frame.evaluate(()=>APStudyCanvasPopup.overlayControl('close')).catch(e=>{if(!/Execution context was destroyed|Frame was detached/.test(e.message))throw e});await page.waitForTimeout(240); }
  async function memory(label) { await cdp.send('HeapProfiler.collectGarbage');const dom=await cdp.send('Memory.getDOMCounters');const m=await cdp.send('Performance.getMetrics');report.memory.push({label,...dom,heap:m.metrics.find(x=>x.name==='JSHeapUsedSize')?.value}); }
  async function trace(name,action) {
   await cdp.send('Tracing.start',{categories:'devtools.timeline,blink.user_timing,disabled-by-default-devtools.timeline,toplevel',transferMode:'ReturnAsStream'});
   await action();
   const complete=new Promise(r=>cdp.once('Tracing.tracingComplete',r));await cdp.send('Tracing.end');const {stream}=await complete;let trace='';
   for(;;){const part=await cdp.send('IO.read',{handle:stream});trace+=part.data;if(part.eof)break}await cdp.send('IO.close',{handle:stream});fs.writeFileSync(path.join(output,`${name}.json`),trace);
   const events=JSON.parse(trace).traceEvents.filter(e=>e.name==='RunTask'&&e.ph==='X'&&e.dur>50000);
   report.samples.push({name,longTasks:events.length,maxTaskMs:Math.max(0,...events.map(e=>e.dur/1000))});
  }
  for(const rate of [1,4]) {
   await cdp.send('Emulation.setCPUThrottlingRate',{rate});
   await trace(`open-navigation-${rate}x`,async()=>{
    const {frame,ms}=await launch();report.samples.push({name:`open-${rate}x`,ms});
    for(const route of ['grades','planner','notes','study','settings'])assert.equal((await frame.evaluate(r=>APStudyCanvasWorkspace.navigate(r),route)).ok,true);
    await frame.evaluate(()=>APStudyCanvasPopup.overlayControl('fullscreen'));
    await page.waitForTimeout(250);await close(frame);
   });
  }
  await cdp.send('Emulation.setCPUThrottlingRate',{rate:1});
  await memory('warm-closed');
  for(let i=0;i<30;i++){const {frame}=await launch();await close(frame);if([9,19,29].includes(i))await memory(`closed-${i+1}`)}
  const {frame}=await launch();await memory('tabs-start');
  const frameCDP=await context.newCDPSession(frame); await frameCDP.send('Performance.enable');
  report.frameMemory=[];
  async function frameMemory(label) {
   await frameCDP.send('HeapProfiler.collectGarbage');const dom=await frameCDP.send('Memory.getDOMCounters');const metrics=await frameCDP.send('Performance.getMetrics');
   report.frameMemory.push({label,...dom,heap:metrics.metrics.find(x=>x.name==='JSHeapUsedSize')?.value});
  }
  for(let i=0;i<100;i++){
   await frame.evaluate(r=>APStudyCanvasWorkspace.navigate(r),['grades','planner','notes','study','settings'][i%5]);
   if([24,49,99].includes(i)){await page.waitForTimeout(300);await frameMemory(`tabs-${i+1}`)}
  }
  await page.waitForTimeout(300);await memory('tabs-100');
  report.overlay=await (await frame.frameElement()).evaluate(n=>({snapshot:!!n.getRootNode().querySelector('.canvas-backdrop'),preview:n.getRootNode().querySelector('.overlay').dataset.preview}));
  if(!baseline)assert.equal(report.overlay.snapshot,false);
  for(const scheme of ['light','dark'])for(const width of [390,1440]) {
   await page.setViewportSize({width,height:900});await frame.evaluate(s=>document.documentElement.dataset.extensionTheme=s,scheme);
   await frame.evaluate(()=>APStudyCanvasWorkspace.navigate('settings'));await page.waitForTimeout(250);
   await page.screenshot({path:path.join(output,`${scheme}-${width}.png`)});
  }
  // Real Notes module with a controllable local-storage read: no fabricated network success.
  await page.setViewportSize({width:1440,height:900});
  await frame.evaluate(async()=>{
   await APStudyCanvasWorkspace.navigate('study');
   const host=document.querySelector('#feature-route-host');host.replaceChildren();
   window.motionFixture=APStudyCanvasWorkspaceNotes.createWorkspaceNotes({document,window,host,
    storage:{get:()=>new Promise(resolve=>window.motionResolve=()=>resolve({})),set:async()=>{}},
    verifyAccount:async()=>({origin:'https://canvas.emory.edu',accountId:'123'}),readCourses:async()=>[]});
   await motionFixture.mount({deferInitialLoad:true,account:{scope:'canvas:'+ 'a'.repeat(64),canvas:{verified:true,accountKey:'a'.repeat(64),accountId:'123',origin:'https://canvas.emory.edu'}}});
  });
  await frame.waitForFunction(()=>typeof window.motionResolve==='function');
  const skeleton=frame.locator('.apstudy-loading--notes');await skeleton.waitFor();
  await frame.waitForFunction(()=>document.querySelector('.apstudy-loading')?.getAttribute('data-motion-visible')==='true');
  report.loading=await frame.evaluate(()=>{
   const node=document.querySelector('.apstudy-skeleton'),effect=node.getAnimations()[0];
   effect.pause();effect.currentTime=100;const early=getComputedStyle(node).opacity;
   effect.currentTime=850;const pulse=getComputedStyle(node).opacity;effect.play();
   return {early,pulse,delay:getComputedStyle(node).animationDelay,hidden:node.getAttribute('aria-hidden')};
  });
  assert.equal(report.loading.early,'1');assert.ok(Number(report.loading.pulse)<1);assert.equal(report.loading.delay,'0.15s');assert.equal(report.loading.hidden,'true');
  await page.screenshot({path:path.join(output,'notes-loading.png')});
  await page.emulateMedia({reducedMotion:'reduce'});
  assert.equal(await frame.locator('.apstudy-skeleton').evaluate(n=>getComputedStyle(n).animationName),'none');
  await frame.evaluate(()=>motionResolve());
  await frame.waitForFunction(()=>!document.querySelector('.apstudy-loading'));
  assert.equal(await frame.locator('#feature-route-host').getAttribute('aria-busy'),null);
  await frame.evaluate(async()=>{await motionFixture.dispose();delete window.motionFixture;delete window.motionResolve});
  await frame.evaluate(()=>APStudyCanvasWorkspace.navigate('notes'));
  const settled=report.memory.filter(x=>/^closed-/.test(x.label));
  assert.equal(new Set(settled.map(x=>x.nodes)).size,1,'closed DOM count must plateau');
  assert.equal(new Set(settled.map(x=>x.jsEventListeners)).size,1,'closed listeners must plateau');
  const last=report.frameMemory.at(-1),warm=report.frameMemory[0];
  assert.ok(last.nodes<=warm.nodes+10,'workspace DOM must plateau across route disposal');
  assert.ok(last.jsEventListeners<=warm.jsEventListeners+3,'workspace listeners must plateau');
  await close(frame);await memory('final-closed');
  assert.deepEqual(report.errors,[]);
 } catch(e){report.fatal=e.stack;process.exitCode=1} finally{fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));await context.close();console.log(JSON.stringify({output,...report},null,2))}
})();
