// Synthetic browser acceptance; no live Canvas data or account mutations.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || '/Users/derekchen/Desktop/Nest.APStudy/node_modules/playwright');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
(async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        const errors = [];
        page.on('pageerror', e => errors.push(e.message));
        await page.setContent('<html><body style="margin:24px;font-family:Arial,sans-serif"><main><h1>Canvas dashboard</h1><div id="host" style="max-width:320px"></div></main></body></html>');
        await page.addStyleTag({path:path.join(root,'css/todo-right-rail.css')});
        for (const file of ['todo-time','todo-state','todo-model','todo-api','todo-streak','todo-effects','todo-right-rail']) await page.addScriptTag({path:path.join(root,`js/content/${file}.js`)});
        await page.evaluate(() => {
            window.fixture = APStudyCanvasContent.TodoRightRail.create({document,window});
            fixture.mount({host:document.getElementById('host'),tasks:[],range:{start:'2026-09-12',end:'2026-09-18',timeZone:'America/New_York'},
                streak:{state:'pending',current:12,best:24,since:'2026-08-31',totalToday:2,completedToday:1,syncState:'synced',lastVerified:'2026-09-12T14:30:00Z',
                    week:['2026-09-07','2026-09-08','2026-09-09','2026-09-10','2026-09-11','2026-09-12','2026-09-13'].map((date,index)=>({date,outcome:index===5?'missed':index===6?'pending':'complete',today:index===6})),
                    remainingTasks:[{id:'lab',title:'Finish the cellular respiration lab report',url:'https://canvas.emory.edu/courses/1/assignments/2'}]}});
        });
        assert.equal(await page.getByRole('dialog').count(),0);
        assert.equal(await page.locator('.apstudy-todo-streak-summary .apstudy-streak-day').count(),0);
        assert.equal(await page.locator('.apstudy-streak-egg-flame').count(),1);
        assert.doesNotMatch(await page.locator('.apstudy-todo-streak-summary').innerText(),/Your last seven days/);
        assert.doesNotMatch(await page.locator('.apstudy-todo-streak-summary').innerText(),/without missing a due task/);
        for (const width of [1280,390]) {
            await page.setViewportSize({width,height:850});
            for (const theme of ['light','dark']) {
                await page.evaluate(theme => document.querySelector('.apstudy-todo-right-rail').style.cssText = theme === 'dark' ? '--todo-surface:#172033;--todo-text:#f4f3ef;--todo-muted:#d0d3db;--todo-border:#596274;--todo-low:#202a40;--todo-container:#273249' : '', theme);
                await page.locator('.apstudy-todo-streak-summary').click();
                assert.equal(await page.getByRole('dialog',{name:'Your streak'}).isVisible(), true);
                assert.equal(await page.locator('.apstudy-streak-popup .apstudy-streak-day').count(),7);
                assert.match(await page.getByRole('dialog',{name:'Your streak'}).innerText(),/without missing a due task/);
                assert.equal(await page.locator('.apstudy-streak-popup .is-close path').count(),2);
                assert.equal(await page.getByRole('button',{name:'Close streak details'}).evaluate(el=>el===document.activeElement),true);
                const bounds=await page.locator('.apstudy-streak-popup').boundingBox();
                assert.ok(bounds.x>=0 && bounds.x+bounds.width<=width && bounds.y+bounds.height<=850);
                await page.screenshot({path:`/tmp/apstudy-streak-${theme}-${width}.png`});
                await page.keyboard.press('Escape');
                assert.equal(await page.locator('.apstudy-todo-streak-summary').evaluate(el=>el===document.activeElement),true);
            }
        }
        await page.locator('.apstudy-todo-streak-summary').click();
        await page.evaluate(()=>fixture.update({streak:{state:'verified',current:13,best:24,totalToday:2,completedToday:2,remainingTasks:[],syncState:'synced'}}));
        assert.equal(await page.getByRole('button',{name:'Close streak details'}).evaluate(el=>el===document.activeElement),true);
        assert.match(await page.getByRole('dialog').innerText(),/13 days/);
        await page.getByRole('heading',{name:'Canvas dashboard'}).click();
        assert.equal(await page.getByRole('dialog').count(),0);
        await page.evaluate(()=>fixture.update({streak:{state:'verified',current:50,best:50,totalToday:0,completedToday:0,remainingTasks:[],syncState:'synced',
            week:['2026-09-07','2026-09-08','2026-09-09','2026-09-10','2026-09-11','2026-09-12','2026-09-13'].map((date,index)=>({date,outcome:'complete',today:index===6}))}}));
        assert.equal(await page.getByRole('dialog').count(),0);
        assert.equal(await page.locator('.apstudy-todo-streak[data-streak-milestone="50"]').count(),1);
        assert.equal(await page.locator('.apstudy-todo-streak [data-effect-type="confetti"]').count(),8);
        await page.screenshot({path:'/tmp/apstudy-streak-milestone-50.png'});
        assert.deepEqual(errors,[]);
        console.log('PASS: desktop/narrow, light/dark, popup bounds, focus, live update, milestone glow/confetti without auto-popup, Escape/outside dismissal; no browser errors.');
    } finally { await browser.close(); }
})().catch(error => {console.error(error); process.exitCode=1;});
