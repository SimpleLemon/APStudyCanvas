'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const model = require('../js/notifications/model.js');
const root = path.resolve(__dirname, '..');
(async () => {
    const output = fs.mkdtempSync(path.join(os.tmpdir(), 'notifications-review-'));
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'notifications-browser-'));
    const context = await chromium.launchPersistentContext(profile, { headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : { channel: 'chromium' }), args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`] });
    try {
        const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
        const id = new URL(worker.url()).host;
        const page = await context.newPage();
        const errors = []; page.on('pageerror', error => errors.push(error.message));
        await worker.evaluate(() => notificationRuntime.refresh());
        const key = 'a'.repeat(64);
        const account = model.empty({ accountKey: key, origin: 'https://canvas.emory.edu', canvasUserId: '42', label: 'Test student' });
        account.inbox = [{ id: 'test-announcement', kind: 'announcements', title: 'Lab report feedback is ready', course: 'BIO 101', url: 'https://canvas.emory.edu/courses/1', createdAt: Date.now(), read: false }];
        await worker.evaluate(async ({ key, account }) => { await chrome.storage.local.set({ 'notifications.accounts.v1': { [key]: account }, seen_update_version: chrome.runtime.getManifest().version }); }, { key, account });
        await page.goto(`chrome-extension://${id}/html/popup.html?view=workspace&category=notifications`);
        await page.waitForFunction(() => document.body.dataset.settingsState === 'ready');
        await page.locator('#notification-account option[value="' + key + '"]').waitFor({ state: 'attached', timeout: 10000 }).catch(async error => { console.log(await page.evaluate(() => ({ status: document.getElementById('notification-save-status').textContent, html: document.getElementById('notification-account').innerHTML }))); console.log(await worker.evaluate(() => chrome.storage.local.get('notifications.accounts.v1'))); throw error; });
        await page.locator('#notification-account').selectOption(key);
        await page.waitForFunction(() => !document.getElementById('notification-lead').disabled);
        assert.equal(await page.locator('#workspace-section-notifications').isVisible(), true);
        await page.locator('#notification-lead').selectOption('60');
        await page.waitForFunction(() => document.getElementById('notification-save-status').textContent === 'Saved to this device.');
        assert.equal(await worker.evaluate(async key => (await chrome.storage.local.get('notifications.accounts.v1'))['notifications.accounts.v1'][key].preferences.leadMinutes, key), 60);
        for (const [width, theme] of [[1440, 'light'], [1024, 'dark'], [390, 'light'], [390, 'dark']]) {
            await page.setViewportSize({ width, height: 1000 });
            await page.evaluate(theme => { document.documentElement.dataset.extensionTheme = theme; window.APStudyCanvasWorkspace.activateCategory('notifications'); }, theme);
            await page.screenshot({ path: path.join(output, `${width}-${theme}.png`) });
            assert.equal(await page.locator('#workspace-section-notifications').isVisible(), true);
            assert.equal(await page.locator('#workspace-section-notifications').evaluate(node => node.scrollWidth > node.clientWidth), false);
            assert.equal(await page.locator('#notifications-button').isVisible(), true);
        }
        assert.equal(await page.locator('[aria-label="Notes nudges desktop unavailable"]').isDisabled(), true);
        await page.locator('#notifications-button').click();
        await page.getByRole('link', { name: 'Lab report feedback is ready' }).waitFor();
        await page.getByRole('button', { name: 'Mark all read', exact: true }).click();
        await page.waitForFunction(() => document.querySelector('.notification-badge').hidden);
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('#notifications-button').evaluate(node => document.activeElement === node), true);
        await page.evaluate(() => window.APStudyCanvasWorkspace.navigate('notes'));
        await page.locator('#notifications-button').click();
        await page.getByRole('button', { name: 'Notification settings', exact: true }).click();
        await page.waitForFunction(() => window.APStudyCanvasWorkspace.route === 'settings' && window.APStudyCanvasWorkspace.category === 'notifications');
        await page.reload();
        await page.waitForFunction(() => document.body.dataset.settingsState === 'ready');
        await page.locator('#notification-account option[value="' + key + '"]').waitFor({ state: 'attached' });
        await page.locator('#notification-account').selectOption(key);
        await page.waitForFunction(() => document.getElementById('notification-lead').value === '60');
        assert.deepEqual(errors, []);
        console.log(JSON.stringify({ ok: true, output, checks: ['category route', 'account selection', 'preferences persist', 'wide/narrow light/dark layouts', 'bell remains visible', 'inbox read state', 'Escape focus', 'unsupported controls'] }, null, 2));
    } finally { await context.close(); fs.rmSync(profile, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
