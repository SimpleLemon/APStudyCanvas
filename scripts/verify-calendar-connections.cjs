'use strict';
// Browser checks use synthetic account/event data; no live provider writes.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const nest = process.env.NEST_REPO_PATH || path.resolve(root, '../Nest.APStudy');
const { chromium } = require(path.join(nest, 'node_modules/playwright'));
const output = process.env.CALENDAR_REVIEW_OUTPUT || '/private/tmp/calendar-connections-review';
(async () => {
    fs.mkdirSync(output, {recursive:true});
    const browser = await chromium.launch({headless:true, channel:'chromium'});
    const page = await browser.newPage(); const errors=[];
    page.on('pageerror', error=>errors.push(error.message));
    await page.route('https://calendar-ui.test/**', route => {
        const pathname = new URL(route.request().url()).pathname;
        if (pathname.startsWith('/static/')) {
            const file=path.join(nest,pathname);
            return route.fulfill({body:fs.readFileSync(file),contentType:file.endsWith('.css')?'text/css':'application/octet-stream'});
        }
        if(pathname==='/connections.js')return route.fulfill({body:fs.readFileSync(path.join(root,'js/calendar-connections.js')),contentType:'text/javascript; charset=utf-8'});
        if(pathname==='/connections.css')return route.fulfill({body:fs.readFileSync(path.join(root,'css/calendar-connections.css')),contentType:'text/css'});
        return route.fulfill({contentType:'text/html; charset=utf-8',body:'<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/static/css/fonts.css"><link rel="stylesheet" href="/static/css/tailwind.css"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/static/css/themes.css"><link rel="stylesheet" href="/static/css/global.css"><link rel="stylesheet" href="/connections.css"></head><body class="bg-surface text-on-surface font-body"><main class="calendar-connections" style="padding:24px"><h1>Calendar connections</h1><div id="connections"></div></main><script src="/connections.js"></script></body></html>'});
    });
    try {
        await page.goto('https://calendar-ui.test/');
        await page.evaluate(()=>{
            const id='a'.repeat(32);window.calls=[];window.opened=[];
            const connection={id,provider:'google',label:'student@example.test',status:'active',last_sync_at:Date.now()/1000,pending:2,conflicts:1,last_error:null,export_sources:['personal','tasks'],suppressed:[],calendars:[{id:'b'.repeat(32),name:'Personal',writable:true,selected:true},{id:'c'.repeat(32),name:'Shared study group',writable:false,selected:false}]};
            window.fixture=connection;
            const body={title:'Study',start:'2026-09-14T15:00:00Z',end:'2026-09-14T16:00:00Z',timezone:'America/New_York',all_day:false,reminder_minutes:10,description:'Read Chapter 5',location:'Library'};
            window.component=APStudyCalendarConnections.mount(document.getElementById('connections'),{openUrl:url=>opened.push(url),request:async(path,payload)=>{
                calls.push({path,payload});
                if(path==='/connections')return {connections:[connection],capabilities:{providers:{google:true,microsoft:true}},window:{start:'2026-08-15',end:'2027-09-15'}};
                if(path==='/calendar-conflicts')return {conflicts:[{id:'d'.repeat(32),revision:'conflict-revision',local_body:body,remote_body:{...body,title:'Study chemistry',location:'Science lab'}}]};
                if(path.endsWith('/configure')){connection.export_sources=payload.export_sources;return {ok:true};}
                if(path.endsWith('/resolve')){connection.conflicts=0;return {ok:true};}
                if(path.endsWith('/disconnect')){connection.status='disconnected';return {ok:true};}
                return {ok:true,state:'queued'};
            }});
        });
        await page.getByRole('heading',{name:'Review conflicting changes'}).waitFor();
        for(const theme of ['light','dark'])for(const width of [360,1280]){
            await page.emulateMedia({colorScheme:theme});await page.evaluate(theme=>document.documentElement.dataset.theme=theme==='dark'?'nest-dark':'nest-light',theme);
            await page.setViewportSize({width,height:900});
            assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
            await page.screenshot({path:path.join(output,`${theme}-${width}.png`),fullPage:true});
        }
        await page.getByRole('button',{name:'Connect Google',exact:true}).focus();await page.keyboard.press('Enter');
        assert.equal(await page.evaluate(()=>opened.at(-1)),'https://nest.apstudy.org/calendar/connections');
        await page.getByRole('checkbox',{name:'Shared study group (read only)',exact:true}).check();
        await page.getByRole('button',{name:'Save synchronization choices',exact:true}).click();
        await page.getByText('Choices saved. Synchronization is queued.').waitFor();
        const saved=await page.evaluate(()=>calls.find(x=>x.path.endsWith('/configure')).payload);
        assert.equal(saved.consent_version,1);assert.equal(saved.calendar_ids.length,2);
        await page.getByRole('button',{name:'Keep calendar version',exact:true}).click();
        await page.getByRole('heading',{name:'Review conflicting changes'}).waitFor({state:'detached'});
        assert.equal(await page.evaluate(()=>calls.find(x=>x.path.endsWith('/resolve')).payload.revision),'conflict-revision');
        assert.equal(await page.getByRole('button',{name:'Connect Microsoft',exact:true}).count(),0);
        await page.getByText('Disconnect account',{exact:true}).click();
        assert.equal(await page.getByRole('checkbox',{name:/Also remove APStudy-managed exports/}).isChecked(),false);
        await page.getByRole('button',{name:'Disconnect',exact:true}).click();
        await page.getByRole('button',{name:'Reconnect',exact:true}).waitFor();
        assert.equal(await page.evaluate(()=>calls.find(x=>x.path.endsWith('/disconnect')).payload.cleanup),false);
        await page.evaluate(()=>component.dispose());
        assert.equal(await page.locator('#connections').textContent(),'');
        assert.deepEqual(errors,[]);
        console.log('PASS: narrow/desktop light/dark layout, keyboard connection, explicit choices, revisioned conflict resolution, default-retain disconnect, cleanup. Screenshots: '+output);
    } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
