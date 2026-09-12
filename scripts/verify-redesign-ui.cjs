'use strict';
// Bounded acceptance batch. All data and the browser profile are synthetic.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || '/Users/derekchen/Desktop/Nest.APStudy/node_modules/playwright');
const root = path.resolve(__dirname, '..');
const output = process.env.REDESIGN_REVIEW_OUTPUT || fs.mkdtempSync(path.join(os.tmpdir(), 'redesign-review-'));
const report = { synthetic: true, cases: [], errors: [], resources: [], interactions: {} };
(async () => {
 fs.mkdirSync(output, { recursive: true });
 const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'redesign-browser-'));
 const context = await chromium.launchPersistentContext(profile, { headless: true, channel: 'chromium', args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`], viewport: { width: 1280, height: 900 } });
 try {
 const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
 const id = new URL(worker.url()).host;
 const page = await context.newPage();
 page.on('pageerror', e => report.errors.push(e.message));
 page.on('requestfailed', r => { if (r.url().startsWith('chrome-extension:')) report.resources.push(r.url()); });
 page.on('dialog', d => d.accept());
 await page.goto(`chrome-extension://${id}/html/popup.html`);
 await page.waitForFunction(() => document.body.dataset.settingsState === 'ready');
 await page.evaluate(() => document.fonts.ready);
 // Production route registration first, before populated component fixtures.
 for (const route of ['notes', 'planner', 'grades', 'settings']) {
  await page.evaluate(route => window.APStudyCanvasWorkspace.navigate(route), route);
  report.interactions[`registered-${route}`] = await page.evaluate(() => ({ route: window.APStudyCanvasWorkspace.route, text: document.querySelector('#feature-route-host')?.innerText.slice(0, 250) }));
 }
 await page.evaluate(() => {
  const account = { scope: `canvas:${'a'.repeat(64)}`, canvas: { verified: true, accountKey: 'a'.repeat(64), accountId: '123', origin: 'https://canvas.emory.edu' }, nest: { verified: true, identity: 'fixture' } };
  const courses = [{id:7,name:'Biology · synthetic course',course_code:'BIO 141', enrollments:[{type:'StudentEnrollment',computed_current_score:88}]}, {id:8,name:'Chemistry · synthetic course',course_code:'CHEM 150',enrollments:[{type:'StudentEnrollment',computed_current_score:92}]}];
  const source = { courseId:'7', course: courses[0], assignmentGroups: [{id:'10',name:'Coursework'},{id:'11',name:'Exams'}], assignments: [
   {id:'101',name:'Cell structure',assignment_group_id:'10',points_possible:20,submission:{score:18},due_at:'2026-09-01T12:00:00Z'},
   {id:'102',name:'Lab analysis',assignment_group_id:'10',points_possible:20,submission:{score:16},due_at:'2026-09-05T12:00:00Z'},
   {id:'103',name:'Unit exam',assignment_group_id:'11',points_possible:100,submission:{score:90},due_at:'2026-09-10T12:00:00Z'}] };
  const workspace = {version:1,notes:[{id:'n1',title:'Cell division · synthetic note',courseId:'7',body:'Mitosis preserves chromosome number.\n\nReview the sequence: prophase, metaphase, anaphase, telophase.',updatedAt:1789128000000},{id:'n2',title:'Exam preparation',courseId:'8',body:'Practice chemical bonding and electron configurations.',updatedAt:1789127000000}],study:[],planner:[],grades:{courses:{7:{credits:4,goal:90},8:{credits:3,goal:93}},priorGpa:'',priorCredits:''}};
  const storage = { get: async key => ({[key]:structuredClone(workspace)}), set: async data => Object.assign(workspace, structuredClone(Object.values(data)[0])) };
  window.reviewFixture = {account,courses,source,workspace,storage,module:null};
 });
 async function mount(kind, route = {}) {
  await page.evaluate(async ({kind,route}) => {
   const f = window.reviewFixture; await f.module?.dispose(); f.module = null;
   await window.APStudyCanvasWorkspace.navigate(kind);
   const host = document.querySelector('#feature-route-host');
   host.replaceChildren();
   if (kind === 'notes') {
    f.module = APStudyCanvasWorkspaceNotes.createWorkspaceNotes({document,window,host,storage:f.storage,verifyAccount:async()=>({origin:f.account.canvas.origin,accountId:'123'}),readCourses:async()=>f.courses});
    await f.module.mount({account:f.account,courses:f.courses},route);
   } else if (kind === 'grades') {
    f.module = APStudyCanvasWorkspaceGradesUI.createGradesWorkspace({document,window,domain:APStudyCanvasWorkspaceGradesDomain,analytics:APStudyCanvasContent.GradeAnalytics,adapter:{overview:async()=>({account:f.account,courses:APStudyCanvasWorkspaceGradesDomain.normalizeCourses(f.courses)}),course:async()=>({account:f.account,courseId:'7',source:APStudyCanvasContent.GradeAnalytics.normalizeGradeData(f.source)}),dispose(){}},getWorkspaceRecord:async()=>f.workspace,getBounds:()=>APStudyCanvasSchema.defaultsForArea('sync').gpa_calc_bounds,saveWorkspaceGrades:async grades=>(f.workspace.grades=grades),getScenario:async()=>null});
    await f.module.mount(host,{route});
   } else if (kind === 'planner') {
    const helpers = APStudyCanvasWorkspacePlannerAdapter;
    let state = {access:{read:true,write:true,code:null},loading:false,range:null,events:[{event_ref:'user:1',source_type:'user',editable:true,title:'Biology study · synthetic',start:'2026-09-11T14:00:00Z',end:'2026-09-11T15:00:00Z',calendar_id:'personal',color:'#355f8a'},{event_ref:'canvas:1',source_type:'canvas',editable:false,title:'Lab report due · synthetic',start:'2026-09-11T17:00:00Z',end:'2026-09-11T18:00:00Z',source_label:'Canvas',source_color:'#8a4b35'}],sources:[{id:'personal',label:'Personal',color:'#355f8a',writable:true},{id:'Canvas',label:'Canvas',color:'#8a4b35',writable:false}],filters:{sourceIds:[],kinds:[],showCompleted:true},drafts:{},import:null,error:null};
    state.visibleEvents=state.events; const listeners=new Set();
    const adapter={helpers,snapshot:()=>structuredClone(state),subscribe(fn){listeners.add(fn);fn(structuredClone(state));return()=>listeners.delete(fn)},refreshAccess:()=>state,async loadRange({anchor,view,useMonthGrid}){state.range=view==='month'&&useMonthGrid?helpers.monthGridRange(anchor,'America/New_York'):helpers.rangeForView(anchor,view,'America/New_York');listeners.forEach(fn=>fn(structuredClone(state)));return state},setFilters(filters){state.filters={...state.filters,...filters};listeners.forEach(fn=>fn(structuredClone(state)))},dispose(){listeners.clear()}};
    f.module=APStudyCanvasWorkspacePlanner.createWorkspacePlanner({document,window,host,adapter,now:()=>new Date('2026-09-11T14:30:00Z')});
    await f.module.mount({account:f.account},route);
   }
  }, {kind,route});
 }
 async function capture(name, theme, width) {
  await page.evaluate(() => new Promise(requestAnimationFrame));
  const geometry = await page.evaluate(() => {
   const host=document.querySelector('#feature-route-host');
   const clipped=[...document.querySelectorAll('button,input,select,textarea')].filter(n=>{if(n.closest('.workspace-planner-main,.workspace-grades-table-wrap'))return false;const r=n.getBoundingClientRect();return r.width&&r.height&&!n.closest('[hidden]')&&(r.left < -1||r.right>innerWidth+1)}).map(n=>n.id||n.textContent.slice(0,50));
   return {pageOverflow:document.documentElement.scrollWidth>innerWidth+1,clipped,featureWidth:host?.getBoundingClientRect().width,route:document.body.dataset.workspaceRoute};
  });
  const file=path.join(output,`${theme}-${width}-${name}.png`);await page.screenshot({path:file}); report.cases.push({name,theme,width,...geometry,file});
 }
 for(const theme of ['light','dark']) for(const width of [390,1280]) {
  await page.setViewportSize({width,height:900});
  await page.evaluate(theme=>document.documentElement.dataset.extensionTheme=theme,theme);
  await page.evaluate(async()=>{await window.reviewFixture.module?.dispose();window.reviewFixture.module=null;await APStudyCanvasWorkspace.navigate('settings')});
  for(const category of ['overview','calendar-accounts','notifications']) {await page.evaluate(c=>APStudyCanvasWorkspace.activateCategory(c),category);await capture(`settings-${category}`,theme,width)}
  await mount('notes',{noteId:'n1'});await capture('notes-editor',theme,width);if(width===390){await page.getByRole('button',{name:'Back to notes',exact:true}).click();await capture('notes-list',theme,width);}
  for(const view of ['day','week','month']) {await mount('planner',{view,date:'2026-09-11'});await capture(`planner-${view}`,theme,width)}
  await mount('grades');await capture('grades-overall',theme,width);
  for(const tab of ['overview','assignments','graphs','what-if']) {await page.evaluate(tab=>reviewFixture.module.routeUpdate({courseId:'7',tab}),tab);if(tab==='graphs') {
    await page.locator('[data-grades-role="generate-chart"]').click();
    await page.locator('[data-grades-role="chart-point"]').first().waitFor();
    const points=page.locator('[data-grades-role="chart-point"]');await points.first().focus();await page.keyboard.press('ArrowRight');
    report.interactions[`chart-${theme}-${width}`]=await page.evaluate(()=>({marks:document.querySelectorAll('[data-grades-role="chart-point"]').length,rows:document.querySelectorAll('[data-grades-role="chart-row"]').length,focused:document.activeElement?.dataset.gradesRole,tooltip:document.querySelector('[data-grades-role="chart-tooltip"]')?.textContent}));
   }await capture(`grades-class-${tab}`,theme,width)}
 }
 // Production overlay: verify real bridge mounting and Settings-only preview release.
 await page.route('https://canvas.emory.edu/**', async route => {
  const url = new URL(route.request().url());
  if (url.pathname.startsWith('/api/')) {
   const json = /\/users\/self(?:\/profile)?$/.test(url.pathname) ? {id:123,name:'Synthetic review student',short_name:'Review student'} : url.pathname==='/api/v1/courses' ? [{id:7,name:'Biology · synthetic course',course_code:'BIO 141',enrollments:[{type:'StudentEnrollment',computed_current_score:88}]}] : url.pathname.endsWith('/assignments') ? [{id:101,name:'Cell structure',assignment_group_id:10,points_possible:20,submission:{score:18},due_at:'2026-09-01T12:00:00Z'}] : url.pathname.endsWith('/assignment_groups') ? [{id:10,name:'Coursework'}] : [];
   return route.fulfill({json});
  }
  return route.fulfill({contentType:'text/html',body:'<!doctype html><html><head><title>Synthetic Canvas review</title></head><body class="dashboard"><div id="application"><header id="header">Canvas fixture</header><main id="main"><div id="content">Synthetic preview content</div></main></div></body></html>'});
 });
 await page.goto('https://canvas.emory.edu/');
 const launch = await worker.evaluate(async()=>{const tabs=await chrome.tabs.query({url:'https://canvas.emory.edu/*'});return overlayLauncher.launch(tabs[0],{})});
 report.interactions.overlayLaunch=launch.ok;
 let frame;
 for(let i=0;i<40&&!frame;i++){frame=page.frames().find(f=>f.url().includes('html/popup.html'));if(!frame)await page.waitForTimeout(100)}
 if(!frame)throw new Error('Production overlay iframe did not mount');
 await frame.waitForFunction(()=>document.body.dataset.settingsState==='ready');
 await frame.evaluate(()=>APStudyCanvasPopup.state.accountLoadPromise);
 for(const theme of ['light','dark'])for(const width of [390,1440]){
  await page.setViewportSize({width,height:900});
  await frame.evaluate(theme=>document.documentElement.dataset.extensionTheme=theme,theme);
  for(const route of ['settings','notes','grades','planner']){
   await frame.evaluate(route=>APStudyCanvasWorkspace.navigate(route),route);
   await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
   await frame.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
   const geometry=await frame.evaluate(()=>({route:APStudyCanvasWorkspace.route,featureWidth:document.querySelector('#feature-route-host')?.getBoundingClientRect().width,frameWidth:innerWidth,text:document.querySelector('#feature-route-host')?.innerText.slice(0,200)}));
   const hostState=await (await frame.frameElement()).evaluate(node=>{const root=node.getRootNode();return{preview:root.querySelector('.overlay')?.dataset.preview,previewVisible:!!root.querySelector('.preview')?.getBoundingClientRect().width,iframeWidth:node.getBoundingClientRect().width,panelWidth:root.querySelector('.panel')?.getBoundingClientRect().width}});
   const file=path.join(output,`overlay-${theme}-${width}-${route}.png`);await page.screenshot({path:file});report.cases.push({name:`overlay-${route}`,theme,width,...geometry,hostState,file,clipped:[]});
  }
 }
 await worker.evaluate(()=>chrome.storage.sync.set({grade_analytics_enabled:true}));
 await page.goto('https://canvas.emory.edu/courses/7/grades');
 await page.locator('.workspace-grades--canvas').waitFor({timeout:20000});
 await page.locator('.workspace-grades--canvas [data-grades-role="tab-graphs"]').click();
 await page.locator('.workspace-grades--canvas [data-grades-role="generate-chart"]').click();
 await page.locator('.workspace-grades--canvas [data-grades-role="chart-point"]').first().waitFor();
 report.interactions.nativeGrades=await page.evaluate(()=>({shared:!!document.querySelector('.workspace-grades--canvas'),marks:document.querySelectorAll('[data-grades-role="chart-point"]').length,rows:document.querySelectorAll('[data-grades-role="chart-row"]').length,canvasPreserved:document.querySelector('#content')?.textContent.includes('Synthetic preview content')}));
 for(const width of [390,1280]){await page.setViewportSize({width,height:900});const file=path.join(output,`native-${width}.png`);await page.screenshot({path:file});report.cases.push({name:'native-grades',width,file,clipped:[]})}
 } catch(error) {report.fatal=error.stack;process.exitCode=1} finally {fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));await context.close();console.log(JSON.stringify({output,cases:report.cases.length,errors:report.errors,resources:report.resources,fatal:report.fatal,overflow:report.cases.filter(c=>c.pageOverflow||c.clipped.length).map(({name,theme,width,clipped})=>({name,theme,width,clipped}))},null,2));}
})();
