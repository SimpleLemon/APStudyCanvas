// Synthetic shared Grades browser acceptance. No live Canvas account is used.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || '/Users/derekchen/Desktop/Nest.APStudy/node_modules/playwright');
const fs=require('fs'); const path=require('path'); const assert=require('assert/strict');
const root=path.resolve(__dirname, "..");
(async()=>{
 const browser=await chromium.launch({headless:true}); const page=await browser.newPage(); const errors=[]; page.on('pageerror',e=>errors.push(e.message));
 await page.setContent('<html><body style="margin:0"><div id="host" style="container:shell / inline-size"></div></body></html>');
 await page.addStyleTag({path:path.join(root,'css/workspace-grades.css')});
 for(const f of ['js/content/gpa.js','js/content/grade-analytics.js','js/workspace-grades-domain.js','js/workspace-grades.js'])await page.addScriptTag({path:path.join(root,f)});
 await page.evaluate(async()=>{
 const analytics=APStudyCanvasContent.GradeAnalytics,domain=APStudyCanvasWorkspaceGradesDomain;
 const source=analytics.normalizeGradeData({groups:[{id:'1',name:'Exams',group_weight:60},{id:'2',name:'Coursework',group_weight:40}], assignments:Array.from({length:125},(_,i)=>({id:String(i+1),title:i?'Assignment '+(i+1):'Cellular respiration and the relationship between energy production and photosynthesis',score:i%4?8:9,pointsPossible:10,groupId:i%2?'1':'2',dueAt:new Date(Date.UTC(2026,8,1+i%10)).toISOString()}))});
 let record={version:1,grades:{courses:{7:{credits:3,goal:90}},priorGpa:'',priorCredits:''}};
 window.fixture=APStudyCanvasWorkspaceGradesUI.createGradesWorkspace({document,window,domain,analytics,adapter:{overview:async()=>({account:{scope:'canvas:test'},courses:[{id:7,name:'Biology',currentScore:85}]}),course:async()=>({courseId:'7',source}),dispose(){}},getBounds:()=>domain.gradingPreset(),getWorkspaceRecord:()=>record,saveWorkspaceGrades:async grades=>(record={...record,grades}),saveScenario:async(_,s)=>s});
 await fixture.mount(document.getElementById('host'),{route:{courseId:'7',tab:'what-if'}});
 });
 for(const width of [1440,390]){
 await page.setViewportSize({width,height:1000}); await page.screenshot({path:'/tmp/grades-whatif-'+width+'.png',fullPage:true});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'horizontal overflow '+width);
 await page.evaluate(()=>document.getElementById('host').style.cssText += ';--light-card-low:#161b25;--light-card:#202735;--light-card-inset:#2c3442;--light-text:#f1f2f5;--light-muted:#ced3dd;--light-border-strong:#8a94a5');
 await page.screenshot({path:'/tmp/grades-whatif-dark-'+width+'.png',fullPage:true});
 await page.evaluate(()=>document.getElementById('host').style.cssText='container:shell / inline-size');
 }
 await page.getByLabel('New group name',{exact:true}).fill('Final exam'); await page.getByRole('button',{name:'Add group',exact:true}).click();
 await page.getByLabel('New assignment name',{exact:true}).fill('New final'); await page.getByLabel('New assignment earned',{exact:true}).fill('90'); await page.getByLabel('New assignment possible',{exact:true}).fill('100');
 await page.getByLabel('New assignment group',{exact:true}).selectOption({label:'Final exam'}); await page.getByRole('button',{name:'Add assignment',exact:true}).click();
 assert.equal(await page.getByText('New final',{exact:true}).count(),1);
 await page.getByRole('button',{name:'Use scenario for GPA',exact:true}).click(); await page.getByRole('button',{name:'Save GPA settings',exact:true}).click();
 await page.evaluate(()=>fixture.openTab('assignments')); await page.getByLabel('Search assignments',{exact:true}).fill('Assignment 125'); await page.getByRole('button',{name:'Apply filters',exact:true}).click();
 assert.equal(await page.locator('tbody tr').count(),1);
 await page.evaluate(()=>{fixture.history=[{courseId:'7',score:80,at:'2026-09-01T12:00:00Z'},{courseId:'7',score:85,at:'2026-09-12T12:00:00Z'}];fixture.openTab('graphs')});
 await page.getByText('Assignment score heatmap',{exact:true}).click(); await page.getByRole('button',{name:'Generate graph',exact:true}).click();
 await page.screenshot({path:'/tmp/grades-graphs-390.png',fullPage:true});
 assert.equal(await page.locator('.workspace-grades-heat-cell').count(),125);
 await page.evaluate(()=>{fixture.mode='canvas';fixture.render()});
 assert.equal(await page.getByRole('button',{name:'Open grade tools',exact:true}).count(),1);
 await page.getByRole('button',{name:'Open grade tools',exact:true}).click();
 assert.equal(await page.getByRole('button',{name:'Collapse grade tools',exact:true}).count(),1);
 await page.screenshot({path:'/tmp/grades-companion-390.png',fullPage:true});
 assert.deepEqual(errors,[]); console.log('PASS: desktop/narrow layout, scenario additions and saves, filters, history, heatmap, companion; no browser errors.');
 await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
