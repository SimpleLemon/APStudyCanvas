"use strict";

// Optional real-browser acceptance check. Run separately from the fast Node suite.
// PLAYWRIGHT_MODULE and BROWSER_EXECUTABLE can point at an existing local runtime.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = path.resolve(__dirname, "..");
const output = process.env.POPUP_REVIEW_OUTPUT || fs.mkdtempSync(path.join(os.tmpdir(), "popup-review-"));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "popup-browser-"));

(async () => {
    fs.mkdirSync(output, { recursive: true });
    const context = await chromium.launchPersistentContext(profile, {
        headless: true,
        ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : { channel: "chromium" }),
        args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
        viewport: { width: 1024, height: 800 }
    });
    const report = { cases: [], errors: [], missingResources: [], screenshots: [], interactions: {} };
    try {
        const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
        const id = new URL(worker.url()).host;
        const page = await context.newPage();
        page.on("pageerror", (error) => report.errors.push(error.message));
        page.on("requestfailed", (request) => {
            if (request.url().startsWith(`chrome-extension://${id}/`)) report.missingResources.push(request.url());
        });
        page.on("response", (response) => {
            if (response.url().startsWith(`chrome-extension://${id}/`) && response.status() >= 400) report.missingResources.push(response.url());
        });
        page.on("dialog", (dialog) => dialog.accept());
        const popupUrl = `chrome-extension://${id}/html/popup.html`;
        // Synthetic Canvas content exercises the production overlay/session bridge.
        // No personal Canvas session or personal browser profile is used.
        await page.route("https://canvas.emory.edu/**", (route) => {
            const url = new URL(route.request().url());
            if (url.pathname.startsWith("/api/")) return route.fulfill({ contentType: "application/json", body: url.pathname.includes("/users/self/profile") ? JSON.stringify({ id: 123, name: "Popup test student", short_name: "Test student" }) : "[]" });
            return route.fulfill({ contentType: "text/html", body: '<!doctype html><html><head><title>Canvas test fixture</title><style>body{margin:0;background:#e3edf4}#header{height:90px;background:#356b95;color:white}#content{height:900px;background:linear-gradient(110deg,#dae6ef 0 30%,#f5e5c8 30% 65%,#cfdfce 65%)}</style></head><body class="dashboard"><div id="application"><header id="header">Canvas</header><main id="main"><div id="content">Canvas preview fixture</div></main></div></body></html>' });
        });
        await page.setViewportSize({ width: 1440, height: 832 });
        await page.goto("https://canvas.emory.edu/");
        await page.waitForTimeout(500);
        const launch = await worker.evaluate(async () => {
            const tabs = await chrome.tabs.query({ url: "https://canvas.emory.edu/*" });
            return overlayLauncher.launch(tabs[0], {});
        });
        assert.equal(launch.ok, true);
        let frame;
        for (let attempt = 0; attempt < 50 && !frame; attempt += 1) {
            frame = page.frames().find((candidate) => candidate.url().includes("html/popup.html"));
            if (!frame) await page.waitForTimeout(100);
        }
        assert.ok(frame, "production overlay mounted the popup iframe");
        await frame.waitForFunction(() => document.body.dataset.settingsState === "ready");
        await frame.evaluate(() => document.fonts.ready);
        assert.equal(await frame.locator("#global-search-input").isVisible(), true);

        const routeTiming = await frame.evaluate(async () => {
            const samples = [];
            for (const route of ['grades', 'planner', 'notes', 'study', 'settings']) {
                const start = performance.now();
                const result = await APStudyCanvasWorkspace.navigate(route);
                samples.push({ route, ms: performance.now() - start, ok: result.ok });
            }
            return samples;
        });
        assert.ok(routeTiming.every(sample => sample.ok));
        console.log('Route transition timing:', JSON.stringify(routeTiming));


        if (!process.env.FUNCTIONAL_ONLY) for (const scheme of ['light','dark']) for (const width of [390,720,1440]) {
            await page.setViewportSize({width,height:832});
            await frame.evaluate(s => document.documentElement.dataset.extensionTheme=s,scheme);
            let baseline;
            for (const route of ['settings','grades','study','account']) {
                await frame.evaluate(async route => {
                    await APStudyCanvasWorkspace.navigate(route==='account'?'settings':route);
                    if(route==='account') APStudyCanvasWorkspace.activateCategory('calendar-accounts');
                    if(route==='settings') APStudyCanvasWorkspace.activateCategory('overview');
                },route);
                await page.waitForTimeout(450);
                const previewTheme = await (await frame.frameElement()).evaluate(node => {
                    const root = node.getRootNode(), overlay = root.querySelector('.overlay'), backdrop = root.querySelector('.canvas-backdrop');
                    return { theme:overlay.dataset.theme, toolbar:getComputedStyle(root.querySelector('.preview-toolbar')).backgroundColor,
                        blur:backdrop && getComputedStyle(backdrop).filter, inert:backdrop?.inert, aria:backdrop?.getAttribute('aria-hidden'),
                        fill:getComputedStyle(root.querySelector('.panel-fill')).backgroundColor };
                });
                assert.equal(previewTheme.theme, scheme);
                assert.equal(previewTheme.toolbar, scheme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(13, 19, 40)');
                assert.equal(previewTheme.blur, null);
                assert.equal(previewTheme.inert, undefined);
                assert.equal(previewTheme.aria, undefined);
                assert.equal(previewTheme.fill, 'rgba(0, 0, 0, 0)');
                const geometry=await (await frame.frameElement()).evaluate(node=>{
                    const root=node.getRootNode(),panel=root.querySelector('.panel'),r=panel.getBoundingClientRect();
                    return {x:r.x,y:r.y,width:r.width,height:r.height};
                });
                baseline ||= geometry; assert.deepEqual(geometry,baseline);
                const shell = await frame.evaluate(() => {
                    const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { x:r.x, width:r.width }; };
                    return { app:rect('#app-scroll'), header:rect('.compact-header'), tabs:rect('#workspace-route-nav'), width:innerWidth };
                });
                assert.equal(shell.header.width, shell.width, 'header spans the complete iframe on every page');
                assert.equal(shell.app.width, shell.width);
                assert.equal(shell.tabs.width, shell.width);
                const iframeBounds = await (await frame.frameElement()).boundingBox();
                assert.equal(iframeBounds.width, width - 32, 'Settings retains the same full-width app as other pages');
                assert.equal(await frame.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
                if(route==='study') assert.equal(await frame.locator('#feature-route-description').textContent(),'Coming soon.');
                await page.screenshot({path:path.join(output,`${scheme}-${width}-${route}.png`)});
            }
        }
        await page.setViewportSize({width:1440,height:832});
        await frame.evaluate(async () => {
            await APStudyCanvasWorkspace.navigate('settings');
            document.querySelector('.workspace-nav').scrollTop = 0;
            document.querySelector('.workspace-sidebar').scrollTop = 0;
        });
        const rail = await frame.evaluate(() => {
            const avatar = document.querySelector('#workspace-account-avatar').getBoundingClientRect();
            const sidebar = document.querySelector('.workspace-sidebar').getBoundingClientRect();
            const nav = document.querySelector('#workspace-route-nav').getBoundingClientRect();
            return { avatarTop:avatar.top, sidebarTop:sidebar.top, tabsBottom:nav.bottom,
                shrink:getComputedStyle(document.querySelector('.workspace-nav-group')).flexShrink };
        });
        assert.ok(rail.avatarTop >= rail.sidebarTop && rail.avatarTop >= rail.tabsBottom, 'account avatar is fully below the tabs');
        assert.equal(rail.shrink, '0', 'navigation groups do not compress and clip their rows');
        await frame.evaluate(()=>APStudyCanvasWorkspace.activateCategory('calendar-accounts'));
        await context.route('https://nest.apstudy.org/**',route=>route.fulfill({contentType:'text/html',body:'<title>Synthetic Nest destination</title>'}));
        for(const [selector,hash] of [['#account-personal-link','#account'],['#account-data-link','#data']]) {
            const popupPromise=context.waitForEvent('page');
            await frame.locator(selector).click();
            const popup=await popupPromise;
            await popup.waitForLoadState();
            assert.equal(popup.url(),`https://nest.apstudy.org/settings/${hash}`);
            assert.equal(await popup.evaluate(()=>window.opener===null),true);
            await popup.close();
        }
        for (const width of [720, 1024, 1440]) {
            await page.setViewportSize({width, height:832});
            await page.waitForTimeout(450);
            const handle = await frame.frameElement();
            const result = await handle.evaluate(async node => {
                const root=node.getRootNode();
                const bar=root.querySelector('.preview-toolbar');
                const select=bar.querySelector('select');
                const out=bar.querySelector('.preview-zoom-out');
                const plus=bar.querySelector('.preview-zoom-in');
                const reset=bar.querySelector('.preview-zoom-reset');
                const value=bar.querySelector('.preview-zoom-value');
                const destinations=[...select.options].map(o=>({value:o.value,disabled:o.disabled}));
                for(let i=0;i<12;i++) plus.click();
                const max={value:value.textContent,disabled:plus.disabled};
                for(let i=0;i<12;i++) out.click();
                const min={value:value.textContent,disabled:out.disabled};
                reset.click();
                select.options[0].textContent='Canvas: A very long localized dashboard destination label';
                await new Promise(r=>setTimeout(r,100));
                const rect=n=>{const r=n.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height}};
                return {width:innerWidth,bar:rect(bar),viewport:rect(root.querySelector('.preview-viewport')),controls:[...bar.querySelectorAll('button,select')].map(rect),max,min,reset:value.textContent,destinations,theme:!!bar.querySelector('[role="switch"]'),trailing:!!bar.querySelector('.preview-toolbar-end'),icons:bar.querySelectorAll('svg').length};
            });
            assert.deepEqual(result.max,{value:'200%',disabled:true});
            assert.deepEqual(result.min,{value:'50%',disabled:true});
            assert.equal(result.reset,'100%');
            assert.equal(result.theme,false);assert.equal(result.trailing,false);assert.equal(result.icons,4);
            assert.ok(result.viewport.y>=result.bar.bottom+7);
            for(const c of result.controls){assert.ok(c.height>=44);assert.ok(c.x>=result.bar.x && c.right<=result.bar.right+1);assert.ok(c.bottom<=result.bar.bottom);}
            console.log(JSON.stringify(result));
            await handle.evaluate(node=>node.getRootNode().querySelector('.preview-zoom-out').focus());
            await page.keyboard.press('Tab');
            assert.equal(await handle.evaluate(node=>node.getRootNode().activeElement.className),'preview-zoom-in');
            await page.keyboard.press('Tab');
            assert.equal(await handle.evaluate(node=>node.getRootNode().activeElement.className),'preview-page');
            await page.keyboard.press('Tab');
            assert.equal(await handle.evaluate(node=>node.getRootNode().activeElement.className),'preview-zoom-reset');
        }
        await page.evaluate(()=>{
            for(const [id,href] of [['dashboard','/'],['courses','/courses'],['calendar','/calendar'],['inbox','/conversations'],['course-home','/courses/7']]) {
                const a=document.createElement('a'); a.href=href;
                a.onclick=e=>{e.preventDefault();window.fixtureDestination=id;history.pushState(history.state,'',href)};
                document.querySelector('#application').appendChild(a);
            }
        });
        const handle=await frame.frameElement();
        for(const id of ['courses','calendar','inbox','dashboard']) {
            await handle.evaluate((node,id)=>{const s=node.getRootNode().querySelector('select.preview-page');s.value=id;s.dispatchEvent(new Event('change',{bubbles:true}))},id);
            await page.waitForFunction(id=>window.fixtureDestination===id,id);
        }
        await page.evaluate(()=>history.replaceState(history.state,'','/courses/7'));
        await handle.evaluate(node=>{const s=node.getRootNode().querySelector('select.preview-page');s.querySelector('[value="course-home"]').disabled=false;s.value='course-home';s.dispatchEvent(new Event('change',{bubbles:true}))});
        await page.waitForFunction(()=>window.fixtureDestination==='course-home');
        console.log('PASS all five toolbar destination activations against synthetic Canvas anchors');
        await frame.evaluate(()=>APStudyCanvasWorkspace.navigate('study'));
        await frame.locator('#feature-route-title').click();
        await page.keyboard.press('Escape');
        await frame.waitForFunction(()=>APStudyCanvasWorkspace.route==='settings');
        await frame.evaluate(()=>APStudyCanvasWorkspace.navigate('study'));
        await frame.evaluate(()=>history.back());
        await frame.waitForFunction(()=>APStudyCanvasWorkspace.route==='settings');
        await page.waitForTimeout(600);
        const restored=await (await frame.frameElement()).evaluate(node=>{
            const root=node.getRootNode();root.querySelector('.preview-zoom-in').click();
            return {state:root.querySelector('.overlay').getAttribute('data-state'),preview:root.querySelector('.overlay').getAttribute('data-preview'),value:root.querySelector('.preview-zoom-value').textContent};
        });
        assert.equal(restored.value,'125%',JSON.stringify(restored));
        console.log('PASS Account new tabs, Study Escape, browser Back and restored preview zoom');
        console.log("Screenshots: " + output);
    } finally { await context.close(); fs.rmSync(profile,{recursive:true,force:true}); }
})().catch(error=>{console.error(error);process.exitCode=1;});
