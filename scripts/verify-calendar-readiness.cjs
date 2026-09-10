'use strict';
// Real shared artifact and overlay controller; synthetic runtime responses only.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || '/Users/derekchen/Desktop/Nest.APStudy/node_modules/playwright');
const root = path.resolve(__dirname, '..');
const nest = path.resolve(root, '../Nest.APStudy');
const output = '/tmp/calendar-readiness-review';
(async () => {
 fs.mkdirSync(output, {recursive:true});
 const browser = await chromium.launch({headless:true, channel:'chromium'});
 const page = await browser.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
 await page.route('https://canvas.example.edu/**', async route => {
  const url = new URL(route.request().url());
  if (url.pathname.startsWith('/static/')) {
   const file = path.join(nest, url.pathname);
   return route.fulfill({body:fs.readFileSync(file), contentType:file.endsWith('.css')?'text/css':file.endsWith('.js')?'text/javascript; charset=utf-8':'application/octet-stream'});
  }
  if (url.pathname.startsWith('/js/')) {
   const file = path.join(root, url.pathname);
   return route.fulfill({body:fs.readFileSync(file), contentType:file.endsWith('.css')?'text/css':'text/javascript; charset=utf-8'});
  }
  if (url.pathname !== '/calendar') throw Error(`Unexpected request: ${url}`);
  return route.fulfill({contentType:'text/html; charset=utf-8',body:`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/static/css/themes.css"><link rel="stylesheet" href="/static/css/global.css"><link rel="stylesheet" href="/js/content/calendar-extension/calendar-extension.v1.css"></head><body><main id="calendar-app"><button id="native-event">Native Canvas calendar</button></main><script src="/js/content/calendar-extension/calendar-extension.v1.js"></script><script src="/js/content/calendar-overlay.js"></script></body></html>`});
 });
 async function setup(failure = '', delay = false) {
  await page.goto('https://canvas.example.edu/calendar');
  await page.evaluate(({failure, delay}) => {
   window.reads = [];
   const sendMessage = async message => {
    window.reads.push(message.type);
    if (message.type === 'NEST_CALENDAR_PREFERENCES_GET' && delay) await new Promise(resolve => { window.releasePreferences = resolve; });
    if (message.type === failure) return {payload:{ok:false,code:'FIXTURE_READ_FAILED'}};
    const payload = message.type === 'NEST_CALENDAR_PREFERENCES_GET'
     ? {ok:true,contractVersion:1,preferences:[{calendar_name:'local:default',visible:false,color_hex:'#123456'}]}
     : message.type === 'NEST_CALENDAR_SAVED_COURSES_GET'
      ? {ok:true,contractVersion:1,supported:true,courses:[{id:'saved-course',section_id:'saved-course',course_code:'TEST 101',course_title:'العربية 中文 🧭',section_number:'1',instructor:'Professor',date_range:{start:'2020-01-01',end:'2030-12-31'},meetings:['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(day=>({day,start:'0900',end:'1000'}))}]}
      : message.type === 'NEST_CALENDAR_COURSES_GET'
       ? {ok:true,contractVersion:1,terms:['Fall_2026'],sections:[{id:'remote-course',course_code:'TEST 202',course_title:'Remote result',term:'Fall_2026',meetings:[]}],count:1,total:75,offset:0,limit:50,has_more:true}
       : message.type === 'NEST_CALENDAR_SHARES_GET'
        ? {ok:true,contractVersion:1,shares:[{id:'share-1',shareCode:'safe-code',shareUrl:'https://nest.apstudy.org/calendar/shared/safe-code',icsConfigured:true}]}
        : {ok:true,contractVersion:1,events:[{id:'user:one',event_ref:'user:one',title:'Saved hidden personal event',start:new Date().toISOString(),end:new Date(Date.now()+3600000).toISOString(),calendar_id:'local:default',source_type:'user'}],sources:[{id:'local:default',name:'Personal',kind:'local'}]};
    return {payload};
   };
   // Test-only readiness marker: production artifact stays gated.
   const artifact = {...APStudyCalendarExtension,calendarReplacementParity:{version:1,ready:true}};
   window.controller = APStudyCanvasContent.CalendarOverlay.createCalendarOverlayController({
    window,document,chromeApi:{runtime:{sendMessage},storage:{sync:{set:async()=>{}}}},
    getContext:()=>({ok:true,state:'connected',origin:location.origin,canvasUser:{id:'1'},profile:{timeZone:'America/New_York'}}),
    getFlags:()=>({projection:true,overlay:true,replacement:true,calendarReplacementParity:{version:1,ready:true}}),
    getMode:()=> 'replace',getArtifact:()=>artifact,anchorStableMs:0,mountTimeoutMs:3000,
   });
   window.result = null; window.initialization = controller.init().then(value => {window.result=value;});
  },{failure,delay});
 }
 try {
  await setup('', true);
  await page.waitForFunction(()=>typeof releasePreferences==='function');
  assert.equal(await page.locator('#calendar-app').isVisible(),true);
  assert.equal(await page.locator('[data-apstudycanvas-calendar-ready="1"]').count(),0);
  await page.evaluate(()=>releasePreferences());await page.waitForFunction(()=>result!==null);
  assert.equal(await page.evaluate(()=>result.state),'mounted');
  assert.equal(await page.locator('#calendar-app').isVisible(),false);
  assert.equal(await page.evaluate(()=>state.calendars['local:default'].visible),false);
  assert.equal(await page.evaluate(()=>reads.includes('NEST_CALENDAR_PREFERENCES_GET')),true);
  assert.equal(await page.evaluate(()=>reads.includes('NEST_CALENDAR_SAVED_COURSES_GET')),true);
  assert.deepEqual(await page.evaluate(()=>[...state.courses.selectedSectionIds]),['saved-course']);
  assert.equal(await page.getByText('TEST 101',{exact:true}).count()>0,true);
  const auxiliary = await page.evaluate(async()=>{
   const courses=await APStudyCalendarDataAdapter.loadCourses({query:'TEST',term:'Fall_2026',limit:50,offset:0});
   const shares=await APStudyCalendarDataAdapter.loadShares();
   return {course:courses.sectionsPayload,shares:shares.payload};
  });
  assert.equal(auxiliary.course.has_more,true);assert.equal(auxiliary.course.total,75);
  assert.equal(auxiliary.shares.shares[0].shareUrl,'https://nest.apstudy.org/calendar/shared/safe-code');
  assert.equal(await page.locator('#calendar-new-event').isVisible(),false);
  assert.equal(await page.locator('#calendar-title').textContent(),'Calendar');
  let cases=0;
  for(const theme of ['light','dark'])for(const width of [360,490,700,1024,1440]) {
   await page.emulateMedia({colorScheme:theme});await page.setViewportSize({width,height:800});
   assert.equal(await page.locator('#apstudycanvas-calendar-overlay-root').evaluate(n=>n.scrollWidth>n.clientWidth+1),false);
   assert.equal(await page.locator('#calendar-view-week').evaluate(n=>getComputedStyle(n).color===getComputedStyle(n).backgroundColor),false);
   if(width===360||width===1024)await page.screenshot({path:`${output}/${theme}-${width}.png`});cases++;
  }
  await page.setViewportSize({width:490,height:420});
  assert.equal(await page.locator('#apstudycanvas-calendar-overlay-root').evaluate(n=>n.scrollWidth>n.clientWidth+1),false);
  await page.screenshot({path:`${output}/short-height-490.png`});
  // A 350 CSS-pixel viewport is the layout viewport produced by 200% browser
  // zoom on a 700-pixel host; this exercises the responsive composition rather
  // than CSS `zoom`, which is a different rendering feature.
  await page.setViewportSize({width:350,height:800});
  assert.equal(await page.locator('#apstudycanvas-calendar-overlay-root').evaluate(n=>n.scrollWidth>n.clientWidth+1),false);
  await page.screenshot({path:`${output}/text-zoom-200.png`});
  await page.getByRole('button',{name:'Use native Canvas calendar',exact:true}).click();
  assert.equal(await page.locator('#calendar-app').isVisible(),true);
  for(const failure of ['NEST_CALENDAR_RANGE_GET','NEST_CALENDAR_PREFERENCES_GET','NEST_CALENDAR_SAVED_COURSES_GET']) {
   await setup(failure);await page.waitForFunction(()=>result!==null);
   assert.equal(await page.locator('#calendar-app').isVisible(),true);
   assert.equal(await page.locator('[data-apstudycanvas-calendar-ready="1"]').count(),0);
   assert.notEqual(await page.evaluate(()=>result.state),'mounted');
  }
  await setup('',true);await page.waitForFunction(()=>typeof releasePreferences==='function');
  await page.evaluate(()=>controller.dispose('fixture-route-exit'));
  assert.equal(await page.locator('#calendar-app').isVisible(),true);
  await page.evaluate(()=>releasePreferences());await page.waitForFunction(()=>result!==null);
  assert.equal(await page.locator('[data-apstudycanvas-calendar-ready="1"]').count(),0);
  assert.deepEqual(errors,[]);console.log(JSON.stringify({cases,checks:['pending preferences','saved read-only filters','saved simulated meetings','bounded remote courses','safe share metadata','manual restoration','range failure','preference failure','saved-course failure','disposed load'],output},null,2));
 } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
