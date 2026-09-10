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
const categories = ["overview", "appearance", "sidebar", "course-cards", "study-tools", "themes", "gpa-grades", "canvas-search", "calendar-accounts", "data-support"];
const widths = [360, 490, 700, 1024, 1440];
const accountPanelExpectations = {
    disconnected: ["nest-connection-heading"],
    "consent-required": ["nest-connection-heading", "canvas-accounts-heading", "access-sync-heading"],
    "fully-available": ["nest-connection-heading", "canvas-accounts-heading", "access-sync-heading", "calendar-display-heading"],
    "unavailable-feature": ["nest-connection-heading", "canvas-accounts-heading", "access-sync-heading"]
};

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
        await page.goto(popupUrl);
        await page.waitForFunction(() => document.body.dataset.settingsState === "ready");
        await page.evaluate(() => document.fonts.ready);

        async function inspect(target, mode, width, scheme) {
            await target.evaluate(scheme=>{document.documentElement.dataset.extensionTheme=scheme},scheme);
            for (const category of categories) {
                await target.evaluate((next) => {
                    // Enter from a genuinely scrolled detail; never repair scroll in inspection.
                    window.APStudyCanvasWorkspace.activateCategory("appearance");
                    document.querySelectorAll("#workspace-section-appearance details").forEach(node => { node.open = true; });
                    document.querySelector(".workspace-content").scrollTop = 500;
                    window.APStudyCanvasWorkspace.activateCategory(next);
                    document.querySelectorAll(".workspace-section:not([hidden]) details").forEach((node) => { node.open = true; });
                }, category);
                await target.evaluate(() => new Promise(requestAnimationFrame));
                const geometry = await target.evaluate(() => {
                    const pane = document.querySelector(".workspace-content");

                    const section = document.querySelector(".workspace-section:not([hidden])");
                    const clipped = [...section.querySelectorAll("*")].filter((node) => {
                        if (node.closest("[hidden]") || !node.clientWidth || node.matches("input, textarea, .sr-only, .workspace-info")) return false;
                        return node.scrollWidth > node.clientWidth + 1;
                    }).map((node) => node.id || `${node.tagName}.${node.className}`);
                    return { scrollTop: pane.scrollTop, width: document.documentElement.clientWidth, overflow: pane.scrollWidth > pane.clientWidth + 1, clipped, inert: pane.inert, settingsReady: document.body.dataset.settingsState === "ready" };
                });
                report.cases.push({ mode, width, scheme, category, ...geometry });
                if ((width === 490 && scheme === "light") || (width === 1024 && scheme === "dark")) {
                    const file = path.join(output, `${mode}-${scheme}-${width}-${category}.png`);
                    if (mode === "embedded") await (await target.frameElement()).screenshot({ path: file });
                    else await page.screenshot({ path: file });
                    report.screenshots.push(file);
                }
            }
        }

        for (const scheme of ["light", "dark"]) {
            await page.emulateMedia({ colorScheme: scheme });
            for (const width of widths) {
                await page.setViewportSize({ width, height: 800 });
                await inspect(page, "standalone", width, scheme);
            }
        }
        // Explicit navigation resets; ordinary render, edits, and canceled leave preserve position.
        await page.setViewportSize({ width: 1024, height: 600 });
        report.interactions.navigation = await page.evaluate(async () => {
            const pane = document.querySelector('.workspace-content');
            window.APStudyCanvasWorkspace.activateCategory('appearance');
            document.querySelectorAll('#workspace-section-appearance details').forEach(node => {node.open = true});
            pane.scrollTop = 250;
            const before = pane.scrollTop;
            window.APStudyCanvasCalendarAccounts.render();
            const afterRender = pane.scrollTop;
            window.APStudyCanvasPopup.renderProfile();
            const afterProfile = pane.scrollTop;
            window.APStudyCanvasWorkspace.activateCategory('appearance');
            const same = pane.scrollTop;
            pane.scrollTop = 250;
            document.querySelector('#workspace-account-trigger').click();
            const shortcut = pane.scrollTop;
            window.APStudyCanvasWorkspace.activateCategory('themes');
            document.querySelectorAll('#workspace-section-themes details').forEach(node => {node.open = true});
            pane.scrollTop = 150;
            document.querySelector('#workspace-section-themes').focus({preventScroll:true});
            const originalFocus = document.activeElement;
            const originalScroll = pane.scrollTop;
            const confirm = window.confirm;
            window.confirm = () => false;
            window.APStudyCanvasThemeDraft.setCss(true);
            const canceled = window.APStudyCanvasPopup.updateCategory('calendar-accounts', true);
            const preserved = pane.scrollTop === originalScroll && document.activeElement === originalFocus;
            window.APStudyCanvasThemeDraft.setCss(false);
            window.confirm = confirm;
            return {before, afterRender, afterProfile, same, shortcut, canceled, preserved};
        });
        assert.ok(report.interactions.navigation.before > 0);
        assert.equal(report.interactions.navigation.before, report.interactions.navigation.afterRender);
        assert.equal(report.interactions.navigation.before, report.interactions.navigation.afterProfile);
        assert.equal(report.interactions.navigation.same, 0);
        assert.equal(report.interactions.navigation.shortcut, 0);
        assert.equal(report.interactions.navigation.canceled, false);
        assert.equal(report.interactions.navigation.preserved, true);
        await page.setViewportSize({ width: 490, height: 600 });
        await page.evaluate(() => window.APStudyCanvasPopup.showCategoryList());
        await page.locator('.workspace-nav [data-workspace-target="appearance"]').click();
        await page.evaluate(() => { document.querySelector('.workspace-content').scrollTop = 250; });
        await page.locator("#workspace-back").click();
        report.interactions.back = await page.evaluate(() => ({ mode: document.body.dataset.navigationPage, focus: document.activeElement.dataset.workspaceTarget }));
        assert.deepEqual(report.interactions.back, { mode: "list", focus: "appearance" });
        await page.locator('.workspace-nav [data-workspace-target="appearance"]').click();
        assert.equal(await page.locator('.workspace-content').evaluate(node => node.scrollTop), 0);
        await page.locator("#workspace-back").click();
        await page.locator("#global-search-input").fill("dark mode");
        await page.locator('#global-search-results [role="option"]').filter({ hasText: '· appearance' }).first().click();
        assert.equal(await page.locator("body").getAttribute("data-navigation-page"), "detail");
        assert.equal(await page.locator("#workspace-section-appearance").isVisible(), true);
        report.interactions.search = true;
        const toggle = page.locator('#workspace-section-appearance [data-popup-setting="dark_mode"]');
        const original = await toggle.isChecked();
        await toggle.setChecked(!original);
        await page.evaluate(() => window.flushPendingWrites());
        await page.reload();
        await page.waitForFunction(() => document.body.dataset.settingsState === "ready");
        assert.equal(await toggle.isChecked(), !original);
        await toggle.setChecked(original);
        await page.evaluate(() => window.flushPendingWrites());
        report.interactions.saveAndReopen = true;
        await page.locator("#notifications-button").click();
        assert.equal(await page.locator("#notifications-popover").isVisible(), true);
        await page.keyboard.press("Escape");
        assert.equal(await page.locator("#notifications-button").evaluate((node) => node === document.activeElement), true);
        report.interactions.notifications = true;
        await page.evaluate(() => {
            document.documentElement.style.zoom = "2";
            document.querySelector("#manual-close-prompt").showModal();
        });
        await page.screenshot({ path: path.join(output, "dialog-200-percent.png") });
        const dialog = page.locator("#manual-close-prompt");
        assert.equal(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth + 1), true);
        await page.locator('#manual-close-prompt button[value="cancel"]').click();
        await page.evaluate(() => { document.documentElement.style.zoom = ""; });
        report.interactions.zoomAndDialog = true;

        // Synthetic Canvas content exercises the production overlay/session bridge.
        // No personal Canvas session or personal browser profile is used.
        await page.route("https://canvas.emory.edu/**", (route) => {
            const url = new URL(route.request().url());
            if (url.pathname.startsWith("/api/")) return route.fulfill({ contentType: "application/json", body: url.pathname.includes("/users/self/profile") ? JSON.stringify({ id: 123, name: "Popup test student", short_name: "Test student" }) : "[]" });
            return route.fulfill({ contentType: "text/html", body: '<!doctype html><html><head><title>Canvas test fixture</title></head><body class="dashboard"><div id="application"><header id="header">Canvas</header><main id="main"><div id="content">Canvas preview fixture</div></main></div></body></html>' });
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
        await page.screenshot({ path: path.join(output, "production-overlay.png") });
        for (const scheme of ["light", "dark"]) {
            await page.emulateMedia({ colorScheme: scheme });
            for (const width of widths) {
                await page.setViewportSize({ width: width + 850, height: 832 });
                const iframe = await frame.frameElement();
                // Size only the test host's grid track; the extension iframe uses its normal CSS.
                await iframe.evaluate((node, size) => {
                    node.getRootNode().querySelector(".panel").style.gridTemplateColumns = `${size}px minmax(0, 1fr)`;
                }, width);
                await inspect(frame, "embedded", width, scheme);
            }
        }
        await page.setViewportSize({ width: 1210, height: 432 });
        await (await frame.frameElement()).evaluate((node) => { node.getRootNode().querySelector(".panel").style.gridTemplateColumns = "360px minmax(0, 1fr)"; });
        await frame.evaluate(() => { document.documentElement.style.zoom = "2"; window.APStudyCanvasPopup.showCategoryList(); });
        await frame.locator('.workspace-nav [data-workspace-target="data-support"]').click();
        await frame.locator("#workspace-back").click();
        report.interactions.shortEmbeddedZoom = true;
        async function accountFixtures(target, mode) {
            await target.evaluate(async () => {
                await window.APStudyCanvasPopup.state.accountLoadPromise;
                await window.APStudyCanvasCalendarAccounts.init();
                window.APStudyCanvasCalendarAccounts.destroy();
                const binding = {accountKey:'a'.repeat(64),sourceKey:'canvas:'+'a'.repeat(64),origin:'https://canvas.emory.edu',canvasUserId:'123',extraction:'supported',label:'Alexandra '+ 'Long family name '.repeat(6)};
                const base = window.APStudyCanvasPopup;
                const caps = {upload:true,projection:true,overlay:true,replacement:false,mutation:true,mirroring:true};
                const snapshot = {generation:1, identity:{state:'authenticated'}, binding, capabilities:caps, consent:null};
                const listeners = new Set();
                const connection = {getSnapshot:()=>snapshot,isCurrent:g=>g===snapshot.generation,
                    subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},
                    update: patch=>{Object.assign(snapshot,patch);listeners.forEach(fn=>fn(snapshot))}};
                const readConsent = current => ({consent:{version:1,source_key:binding.sourceKey,account_key:binding.accountKey,scopes:current?POPUP_CANVAS_CONSENT_SCOPES.slice():[],current:true,granted:current,state:current?'active':'not_granted'}});
                window.accountFixture = {snapshot, connection, binding, caps, readConsent, granted:false, writeScopes:[], calls:[], fail:false};
                const productionRequest = popupPlatformRequest;
                popupPlatformRequest = async (type,payload) => {
                    if (type === 'SETTINGS_UPDATE') return productionRequest(type,payload);
                    const f = window.accountFixture;
                    f.calls.push({type,payload});
                    if (f.fail) throw new Error('FIXTURE_REQUEST_FAILED');
                    if (type === 'NEST_CONSENT_SET') {
                        if (payload.version === 1) f.granted = payload.action === 'grant';
                        else f.writeScopes = payload.action === 'grant' ? payload.scopes : [];
                        if (payload.version === 1 && f.failReadAfterSet) {
                            f.failNextRead = true;
                            f.failReadAfterSet = false;
                        }
                        return {ok:true};
                    }
                    if (type === 'NEST_CONSENT_GET' && payload.version === 1 && f.failNextRead) {
                        f.failNextRead = false;
                        throw new Error('FIXTURE_CONFIRMATION_UNAVAILABLE');
                    }
                    if (type === 'NEST_CONSENT_GET') return payload.version === 1 ? readConsent(f.granted) : {consent:{version:2,source_key:binding.sourceKey,account_key:binding.accountKey,scopes:f.writeScopes,current:f.writeScopes.length>0,granted:f.writeScopes.length>0}};
                    if (type === 'CANVAS_SYNC_STATUS') return {state:'idle'};
                    return {ok:true};
                };
                const calendar = createPopupCalendarController({controller:{state:base.state,connection},document});
                popupCalendarController = calendar;
                window.APStudyCanvasCalendarAccounts = calendar;
                await calendar.init();
                const applyAccountFixture = (identityState, capabilities, granted) => {
                    const f = window.accountFixture;
                    f.snapshot.identity = {state:identityState,profile:{name:binding.label},identity:'fixture'};
                    f.snapshot.capabilities = capabilities;
                    f.granted = granted;
                    f.snapshot.consent = {read:popupCalendarNormalizeConsent(f.readConsent(f.granted), binding)};
                    base.state.identity = f.snapshot.identity;
                    base.state.canvas = {state:'connected',canvasBinding:binding};
                    base.state.canvasAccounts = [{accountKey:binding.accountKey,name:'Duplicate current'}, {accountKey:'b'.repeat(64),name:'Other Canvas account'}];
                    base.renderProfile();
                    f.connection.update({});
                    document.querySelector('.account-lookup-row').hidden = true;
                    window.APStudyCanvasWorkspace.activateCategory('calendar-accounts');
                };
                window.setAccountFixture = (state) => applyAccountFixture(state==='disconnected'?'signed_out':'authenticated', state==='unavailable-feature'?{}:caps, state==='fully-available'||state==='unavailable-feature');
                window.setAccountCapabilities = (capabilities) => applyAccountFixture('authenticated', capabilities, true);
            });
            for (const state of ['disconnected','consent-required','fully-available','unavailable-feature']) {
                await target.evaluate(state => window.setAccountFixture(state),state);
                for (const scheme of ['light','dark']) for (const width of [360,490,700,1024,1440]) {
                    await page.emulateMedia({colorScheme:scheme});
                    await target.evaluate(scheme=>{document.documentElement.dataset.extensionTheme=scheme},scheme);
                    if (mode === 'standalone') await page.setViewportSize({width,height:800});
                    else {
                        await page.setViewportSize({width:width+850,height:832});
                        await (await target.frameElement()).evaluate((node,size)=>{node.getRootNode().querySelector('.panel').style.gridTemplateColumns=`${size}px minmax(0,1fr)`},width);
                    }
                    const geometry = await target.evaluate(() => {
                        const section = document.querySelector('#workspace-section-calendar-accounts');
                        const allPanels = [...section.querySelectorAll('.account-panel')];
                        const panels = allPanels.filter(node=>!node.hidden);
                        const gaps = panels.slice(1).map((node,i)=>node.getBoundingClientRect().top-panels[i].getBoundingClientRect().bottom);
                        return {gaps, hiddenBoxes:[...section.querySelectorAll('[hidden]')].filter(node=>node.getClientRects().length).length,
                            overflow:section.scrollWidth>section.clientWidth+1,
                            duplicate:document.querySelector('#workspace-canvas-account-list').textContent.includes('Duplicate current'),
                            panels:panels.map(node=>node.getAttribute('aria-labelledby')),
                            panelStates:allPanels.map(node=>({heading:node.getAttribute('aria-labelledby'),hidden:node.hidden,inert:node.inert})),
                            lookup:document.querySelector('.account-lookup-row').getClientRects().length};
                    });
                    assert.equal(geometry.hiddenBoxes,0);
                    assert.equal(geometry.lookup,0);
                    assert.equal(geometry.overflow,false);
                    assert.equal(geometry.duplicate,false);
                    assert.deepEqual(geometry.panels, accountPanelExpectations[state]);
                    geometry.panelStates.filter(panel=>!accountPanelExpectations[state].includes(panel.heading)).forEach(panel=>{
                        assert.equal(panel.hidden,true,`${state}: hidden account groups stay hidden`);
                        assert.equal(panel.inert,true,`${state}: hidden account groups stay inert`);
                    });
                    geometry.gaps.forEach(gap=>assert.equal(gap,16));
                    if (width===490&&scheme==='light'||width===1024&&scheme==='dark') {
                        const file = path.join(output,`${mode}-account-${state}-${scheme}-${width}.png`);
                        if(mode==='embedded') await (await target.frameElement()).screenshot({path:file}); else await page.screenshot({path:file});
                        report.screenshots.push(file);
                    }
                }
            }
            const capabilityCases = [
                {name:'projection-without-overlay',capabilities:{upload:true,projection:true,overlay:false,replacement:false,mutation:false,mirroring:false},panels:['nest-connection-heading','canvas-accounts-heading','access-sync-heading','calendar-display-heading'],sync:true,calendar:true,overlay:false,replacement:false,permissions:false},
                {name:'upload-only',capabilities:{upload:true,projection:false,overlay:false,replacement:false,mutation:false,mirroring:false},panels:['nest-connection-heading','canvas-accounts-heading','access-sync-heading'],sync:true,calendar:false,overlay:false,replacement:false,permissions:false},
                {name:'personal-write',capabilities:{upload:false,projection:false,overlay:false,replacement:false,mutation:true,mirroring:true},panels:['nest-connection-heading','canvas-accounts-heading','access-sync-heading'],sync:false,calendar:false,overlay:false,replacement:false,permissions:true},
                {name:'replacement-ready',capabilities:{upload:false,projection:true,overlay:true,replacement:true,mutation:false,mirroring:false},panels:['nest-connection-heading','canvas-accounts-heading','access-sync-heading','calendar-display-heading'],sync:false,calendar:true,overlay:true,replacement:true,permissions:false}
            ];
            for (const capability of capabilityCases) {
                await target.evaluate(capabilities => window.setAccountCapabilities(capabilities), capability.capabilities);
                for (const scheme of ['light','dark']) for (const width of [360,490,1024,1440]) {
                    await page.emulateMedia({colorScheme:scheme});
                    await target.evaluate(scheme=>{document.documentElement.dataset.extensionTheme=scheme},scheme);
                    if (mode === 'standalone') await page.setViewportSize({width,height:800});
                    else {
                        await page.setViewportSize({width:width+850,height:832});
                        await (await target.frameElement()).evaluate((node,size)=>{node.getRootNode().querySelector('.panel').style.gridTemplateColumns=`${size}px minmax(0,1fr)`},width);
                    }
                    const geometry = await target.evaluate(() => {
                        const section = document.querySelector('#workspace-section-calendar-accounts');
                        const panels = [...section.querySelectorAll('.account-panel')];
                        return {
                            panels:panels.filter(node=>!node.hidden).map(node=>node.getAttribute('aria-labelledby')),
                            hiddenPanels:panels.filter(node=>node.hidden).map(node=>({heading:node.getAttribute('aria-labelledby'),inert:node.inert})),
                            overflow:section.scrollWidth>section.clientWidth+1
                        };
                    });
                    assert.deepEqual(geometry.panels,capability.panels,`${capability.name}: visible account groups`);
                    geometry.hiddenPanels.forEach(panel=>assert.equal(panel.inert,true,`${capability.name}: hidden account groups stay inert`));
                    assert.equal(geometry.overflow,false,`${capability.name}: account groups stay within the shell`);
                    assert.equal(await target.locator('#calendar-sync-controls').isVisible(),capability.sync,`${capability.name}: sync controls`);
                    assert.equal(await target.locator('#calendar-display-heading').isVisible(),capability.calendar,`${capability.name}: calendar display group`);
                    assert.equal(await target.locator('label[for="canvas-calendar-mode-overlay"]').isVisible(),capability.overlay,`${capability.name}: overlay option visibility`);
                    assert.equal(await target.locator('#canvas-calendar-mode-overlay').isEnabled(),capability.overlay,`${capability.name}: overlay option capability`);
                    assert.equal(await target.locator('label[for="canvas-calendar-mode-replace"]').isVisible(),capability.replacement,`${capability.name}: replacement option visibility`);
                    assert.equal(await target.locator('#canvas-calendar-mode-replace').isEnabled(),capability.replacement,`${capability.name}: replacement option capability`);
                    assert.equal(await target.locator('.account-permission-rows').isVisible(),capability.permissions,`${capability.name}: personal-item permissions`);
                    report.accountCapabilityCases = (report.accountCapabilityCases || 0) + 1;
                }
            }
            await target.evaluate(()=>window.setAccountFixture('consent-required'));
            await target.locator('#nest-consent-enabled').hover();
            assert.equal(await target.locator('#nest-consent-enabled').evaluate(el => getComputedStyle(el).outlineStyle), 'solid');
            await target.locator('#nest-consent-refresh').hover();
            assert.equal(await target.locator('#nest-consent-refresh').evaluate(el => getComputedStyle(el).cursor), 'pointer');
            await target.locator('#nest-consent-enabled').check();
            await target.waitForFunction(()=>window.APStudyCanvasCalendarAccounts.state.presentation.sync);
            const messages = await target.evaluate(()=>window.accountFixture.calls);
            assert.ok(messages.some(call=>call.type==='NEST_CONSENT_SET'&&call.payload.version===1&&call.payload.action==='grant'));
            assert.equal(messages.some(call=>call.type==='CANVAS_SYNC_START'),false);
            // Persist opt-in without a sync start, then save/reload the real calendar preference.
            await target.locator('#canvas-current-account-sync-opt-in').check();
            await target.evaluate(()=>window.flushPendingWrites());
            assert.equal(await target.evaluate(()=>window.accountFixture.calls.some(call=>call.type==='CANVAS_SYNC_START')),false);
            await target.locator('#canvas-calendar-mode-overlay').check();
            await target.evaluate(()=>window.flushPendingWrites());
            await target.evaluate(()=>window.APStudyCanvasCalendarAccounts.loadCalendarMode());
            assert.equal(await target.locator('#canvas-calendar-mode-overlay').isChecked(),true);
            await target.evaluate(()=>window.accountFixture.connection.update({capabilities:{}}));
            assert.equal(await target.evaluate(()=>window.APStudyCanvasCalendarAccounts.state.calendarMode),'overlay');
            assert.equal(await target.locator('#canvas-calendar-mode-off').isEnabled(),true);
            await target.locator('#canvas-current-account-sync-opt-in').uncheck();
            await target.evaluate(()=>window.flushPendingWrites());
            await target.locator('#canvas-calendar-mode-off').check();
            await target.evaluate(()=>window.flushPendingWrites());
            await target.evaluate(()=>window.accountFixture.connection.update({capabilities:window.accountFixture.caps}));
            await target.evaluate(()=>{window.savedQueueSettingWrite=queueSettingWrite; queueSettingWrite=()=>Promise.reject(new Error('FIXTURE_SAVE_FAILED'))});
            await target.locator('#canvas-calendar-mode-overlay').click();
            await target.waitForFunction(()=>window.APStudyCanvasCalendarAccounts.state.calendarModeStatus.startsWith('Failed'));
            assert.equal(await target.locator('#canvas-calendar-mode-off').isChecked(),true);
            await target.evaluate(()=>{queueSettingWrite=window.savedQueueSettingWrite});
            await target.waitForFunction(()=>window.APStudyCanvasCalendarAccounts.state.writeConsent?.valid);
            await target.locator('#nest-write-personal_events_write').check();
            await target.waitForFunction(()=>window.APStudyCanvasCalendarAccounts.state.writeConsent?.scopes.includes('personal_events_write'));
            assert.equal(await target.locator('#nest-consent-enabled').isChecked(),true);
            await target.evaluate(()=>window.accountFixture.connection.update({capabilities:{}}));
            assert.equal(await target.locator('#nest-write-personal_events_write').isEnabled(),true);
            await target.locator('#nest-write-personal_events_write').uncheck();
            await target.waitForFunction(()=>!window.APStudyCanvasCalendarAccounts.state.writeConsent?.current);
            await target.evaluate(()=>{window.accountFixture.fail=true});
            await target.locator('#nest-consent-refresh').click();
            await target.waitForFunction(()=>window.APStudyCanvasCalendarAccounts.state.consentFailure);
            assert.match(await target.locator('#nest-consent-status').textContent(),/could not be checked/);
            await target.evaluate(()=>{window.accountFixture.fail=false});
            await target.locator('#nest-consent-refresh').click();
            await target.waitForFunction(()=>!window.APStudyCanvasCalendarAccounts.state.consentFailure);
            await target.locator('#nest-consent-enabled').click();
            await target.waitForFunction(()=>!['checking','saving','revoking'].includes(window.APStudyCanvasCalendarAccounts.state.consentOperation) && !window.APStudyCanvasCalendarAccounts.state.presentation.access);
            assert.equal(await target.locator('#calendar-sync-controls').isVisible(),false);
            await target.evaluate(()=>{window.accountFixture.failReadAfterSet=true});
            await target.locator('#nest-consent-enabled').click();
            await target.waitForFunction(()=>!['checking','saving','revoking'].includes(window.APStudyCanvasCalendarAccounts.state.consentOperation) && window.APStudyCanvasCalendarAccounts.state.consentFailure);
            assert.match(await target.locator('#nest-consent-status').textContent(),/could not be confirmed/);
            assert.equal(await target.locator('#calendar-capability-status').isVisible(),false);
            assert.equal(await target.locator('#calendar-accounts-status-value').textContent(),'Nest connected');
            assert.equal(await target.locator('#nest-consent-enabled').isChecked(),false);
            assert.equal(await target.evaluate(()=>window.APStudyCanvasCalendarAccounts.state.presentation.access),false);
            const writesBeforeRetry = await target.evaluate(()=>window.accountFixture.calls.filter(call=>call.type==='NEST_CONSENT_SET').length);
            await target.locator('#nest-consent-refresh').press('Enter');
            await target.waitForFunction(()=>!['checking','saving','revoking'].includes(window.APStudyCanvasCalendarAccounts.state.consentOperation) && window.APStudyCanvasCalendarAccounts.state.presentation.access);
            assert.equal(await target.locator('#nest-consent-enabled').isChecked(),true);
            assert.equal(await target.evaluate(()=>window.APStudyCanvasCalendarAccounts.state.consentFailure),null);
            assert.equal(await target.evaluate(()=>window.accountFixture.calls.filter(call=>call.type==='NEST_CONSENT_SET').length),writesBeforeRetry);
            assert.equal(await target.evaluate(()=>window.accountFixture.calls.some(call=>call.type==='CANVAS_SYNC_START')),false);
            assert.equal(await target.locator('#nest-consent-status').getAttribute('aria-live'),'polite');
            report.interactions[`${mode}ConsentVerificationRecovery`] = true;
            report.interactions[`${mode}AccountHandlers`] = true;
        }
        await frame.evaluate(()=>{document.documentElement.style.zoom=''});
        await accountFixtures(frame,'embedded');
        await page.goto(popupUrl);
        await page.waitForFunction(()=>document.body.dataset.settingsState==='ready');
        await accountFixtures(page,'standalone');
        // Render real activity controls with a reviewed conflict and stale-choice response.
        await page.goto(popupUrl);
        await page.waitForFunction(() => document.body.dataset.settingsState === "ready");
        await page.evaluate(async () => {
            // Replace the account controller only after its detached startup settles;
            // otherwise it races the fixture and clears the rendered activity.
            await window.APStudyCanvasPopup.state.accountLoadPromise;
            await window.APStudyCanvasCalendarAccounts.init();
            window.APStudyCanvasCalendarAccounts.destroy();
            const binding = { accountKey: "a".repeat(64), sourceKey: "canvas:" + "a".repeat(64), origin: "https://canvas.emory.edu", canvasUserId: "123" };
            const snapshot = { generation: 1, identity: { state: "authenticated" }, binding, capabilities: { mutation: true }, consent: null };
            const controller = { state: { identity: { state: "authenticated" } }, connection: { getSnapshot: () => snapshot, isCurrent: () => true } };
            const calendar = createPopupCalendarController({ controller, document });
            const item = { idempotency_key: "reviewed", event_ref: "user:personal", operation: "update", state: "conflict", conflict: { expected_revision: "token-one", canvasSnapshot: { title: "Canvas " + "Long title ".repeat(30), start: "2026-09-09T10:00:00Z" }, nestSnapshot: { title: "Nest version", start: "2026-09-09T11:00:00Z" } } };
            Object.assign(calendar.state, { binding, contextState: "connected", consent: { valid: true, current: true, revoked: false }, consentVerified: true, sourceRef: "src1:test", mutationEnabled: true, writeActivity: [item] });
            window.fixtureDecisions = [];
            popupPlatformRequest = async (type, payload) => {
                if (type === "CANVAS_WRITEBACK_RESOLVE") { window.fixtureDecisions.push(payload); item.conflict.expected_revision = "token-two"; return { ok: false, code: "WRITEBACK_CONFLICT_CHANGED" }; }
                return { items: [item] };
            };
            popupCalendarController = calendar;
            // Profile rendering also uses the public controller during resize.
            // Keep both production entry points on the fixture, not the destroyed instance.
            window.APStudyCanvasCalendarAccounts = calendar;
            window.fixtureCalendar = calendar;
            window.APStudyCanvasCalendarAccounts = calendar;
            window.APStudyCanvasWorkspace.activateCategory("calendar-accounts");
            calendar.render();
        });
        for (const scheme of ["light", "dark"]) for (const width of widths) {
            await page.emulateMedia({ colorScheme: scheme });
            await page.setViewportSize({ width, height: 800 });
            await page.evaluate(scheme => {document.documentElement.dataset.extensionTheme=scheme; window.fixtureCalendar.render()},scheme);
            const activity = page.locator("#calendar-writeback-items");
            await activity.scrollIntoViewIfNeeded();
            assert.equal(await activity.evaluate(node => node.scrollWidth > node.clientWidth + 1), false);
            assert.equal(await activity.getByText("Canvas version", { exact: true }).count(), 1, "the reviewed Canvas snapshot is rendered");
            if (width === 490 || width === 1024) await page.screenshot({ path: path.join(output, `conflict-${scheme}-${width}.png`) });
        }
        await page.getByRole("button", { name: "Keep Canvas", exact: true }).click();
        await page.getByText("This item changed. Review the refreshed versions before choosing again.", { exact: true }).waitFor();
        assert.equal(await page.evaluate(() => window.fixtureDecisions[0].expected_revision), "token-one");
        assert.equal(await page.evaluate(() => document.activeElement.textContent), "Keep Canvas");
        report.interactions.reviewedConflictAndFocus = true;
        report.failures = report.cases.filter((item) => item.scrollTop !== 0 || item.overflow || item.clipped.length || item.inert || !item.settingsReady);
        assert.equal(report.errors.length, 0, "no uncaught popup or host errors");
        assert.equal(report.missingResources.length, 0, "all packaged resources resolve");
        assert.equal(report.failures.length, 0, "no clipped content or broken readiness in the layout matrix");
        console.log(JSON.stringify({ cases: report.cases.length, interactions: report.interactions, output }, null, 2));
    } finally {
        fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2));
        await context.close();
        fs.rmSync(profile, { recursive: true, force: true });
    }
})().catch((error) => { console.error(error); process.exitCode = 1; });
