'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('../../js/notifications/model.js');
const { create, KEY } = require('../../js/notifications/runtime.js');
const identity = require('../../js/canvas-adapter/identity.js');
const now = Date.parse('2026-09-11T12:00:00Z');
const binding = { origin: 'https://canvas.example.edu', canvasUserId: '42', accountKey: 'a'.repeat(64) };
const activity = (kind = 'grades', revision = 'ungraded') => ({ id: `${kind}:1`, kind, revision, title: 'Biology', course: 'BIO', url: '/courses/1/assignments/1' });
const task = (overrides = {}) => ({ id: 'task:1', title: 'Essay', url: '/courses/1/assignments/1', due: { kind: 'instant', utcInstant: new Date(now + 3600000).toISOString() }, ...overrides });
const snapshot = (activities = [], tasks = []) => ({ activities, tasks });
function initial(data = snapshot()) { return model.reconcile(model.empty(binding), data, now).state; }

test('first activity read is a baseline, new announcements and grade changes notify once', () => {
    const first = initial(snapshot([activity(), activity('announcements', 'new')]));
    assert.equal(first.inbox.length, 0);
    const second = model.reconcile(first, snapshot([activity('grades', 'A'), activity('announcements', 'new'), { ...activity('announcements', 'new'), id: 'announcements:2' }]), now + 60000);
    assert.equal(second.state.inbox.length, 2);
    assert.equal(model.reconcile(second.state, snapshot([activity('grades', 'A'), activity('announcements', 'new'), { ...activity('announcements', 'new'), id: 'announcements:2' }]), now + 120000).state.inbox.length, 2);
});
test('new course grades baseline quietly and grade reversions are separate events', () => {
    let state = initial(snapshot([activity('grades', 'A')]));
    state = model.reconcile(state, snapshot([activity('grades', 'B'), { ...activity('grades', 'A'), id: 'new-course' }]), now + 1).state;
    state = model.reconcile(state, snapshot([activity('grades', 'A')]), now + 2).state;
    state = model.reconcile(state, snapshot([activity('grades', 'B')]), now + 3).state;
    assert.equal(state.inbox.length, 3);
});
test('task completion and submission suppress reminders; changing the deadline reschedules', () => {
    let state = initial(snapshot([], [task({ submitted: true }), task({ id: 'completed', completed: true })]));
    assert.equal(state.inbox.length, 0);
    state = model.reconcile(state, snapshot([], [task()]), now + 60000).state;
    assert.equal(state.inbox.length, 1);
    state = model.reconcile(state, snapshot([], [task({ due: { kind: 'instant', utcInstant: new Date(now + 7200000).toISOString() } })]), now + 120000).state;
    assert.equal(state.inbox.length, 2);
});
test('at-due reminders tolerate alarm latency and overdue daily events deduplicate', () => {
    let state = model.empty(binding); state.preferences.leadMinutes = 0;
    const due = task({ due: { kind: 'instant', utcInstant: new Date(now).toISOString() } });
    state = model.reconcile(state, snapshot([], [due]), now + 1000).state;
    assert.equal(state.inbox.length, 1);
    state.preferences.overdue = 'daily';
    state = model.reconcile(state, snapshot([], [due]), now + 6 * 60000).state;
    assert.equal(state.inbox.length, 2);
    state = model.reconcile(state, snapshot([], [due]), now + 7 * 60000).state;
    assert.equal(state.inbox.length, 2);
});
test('reconnection consolidates missed reminders and does not replay them', () => {
    let state = initial(); state.status = 'paused';
    const tasks = [task(), task({ id: 'two' })];
    state = model.reconcile(state, snapshot([], tasks), now + 7200000).state;
    assert.equal(state.inbox.length, 1);
    assert.match(state.inbox[0].title, /2 task reminders/);
    assert.equal(model.reconcile(state, snapshot([], tasks), now + 7260000).state.inbox.length, 1);
});
test('date-only deadlines use the account timezone across both DST boundaries', () => {
    assert.equal(new Date(model.dueTime({ kind: 'date', date: '2026-03-08', timeZone: 'America/New_York' })).toISOString(), '2026-03-09T03:59:59.999Z');
    assert.equal(new Date(model.dueTime({ kind: 'date', date: '2026-11-01', timeZone: 'America/New_York' })).toISOString(), '2026-11-02T04:59:59.999Z');
});
test('retention bounds inbox and channels independently control inbox and desktop', () => {
    let state = initial(); state.preferences.due = { inbox: false, desktop: true };
    const result = model.reconcile(state, snapshot([], [task()]), now + 1);
    assert.equal(result.state.inbox.length, 0); assert.equal(result.desktop.length, 1); assert.equal(result.state.desktopLinks.length, 1);
    state = initial(); state.inbox = Array.from({ length: 250 }, (_, i) => ({ id: String(i), createdAt: now }));
    assert.equal(model.reconcile(state, snapshot(), now + 1).state.inbox.length, 200);
    assert.equal(model.reconcile(state, snapshot(), now + 31 * model.DAY).state.inbox.length, 0);
});
test('unsafe destinations and invalid preference values are rejected or normalized', () => {
    for (const url of [null, '', 'javascript:alert(1)', 'https://evil.test/', 'https://user:pass@canvas.example.edu/']) assert.equal(model.safeUrl(url, binding.origin), null);
    assert.equal(model.safeUrl('/courses/1', binding.origin), `${binding.origin}/courses/1`);
    assert.equal(model.preferences({ leadMinutes: -3, overdue: 'always' }).leadMinutes, 180);
});
async function runtimeFixture() {
    const key = await identity.accountKey({ origin: binding.origin, userId: '42' });
    const account = model.empty({ ...binding, accountKey: key });
    let values = { [KEY]: { [key]: account } }, open = true, permit = false, failWrite = false, snapshotValue = snapshot([], [task()]);
    const delivered = [], opened = []; let collections = 0;
    const browser = {
        runtime: { id: 'test', getURL: path => `chrome-extension://test/${path}` },
        storage: { local: { async get() { return structuredClone(values); }, async set(patch) { if (failWrite) throw new Error('disk'); values = structuredClone(patch); } } },
        tabs: { async query() { return open ? [{ id: 1, url: binding.origin }, { id: 2, url: binding.origin }] : []; }, async sendMessage() { return { ok: true, state: 'connected', origin: binding.origin, canvasUser: { id: '42', name: 'Student' } }; }, async create(value) { opened.push(value); } },
        scripting: { async executeScript() { collections++; return [{ result: snapshotValue }]; } },
        alarms: { async create() {} },
        permissions: { async contains() { return permit; } },
        notifications: { async getPermissionLevel() { return 'granted'; }, async create(id, options) { delivered.push({ id, options }); }, async clear() {} }
    };
    const runtime = create({ browser, origins: async () => [binding.origin], identity, collect() {}, now: () => now });
    const sender = { id: 'test', url: 'chrome-extension://test/html/popup.html' };
    const send = (action, extra = {}, from = sender) => runtime.handle({ type: 'APSTUDY_NOTIFICATIONS', version: 1, action, accountKey: key, ...extra }, from);
    return { runtime, send, key, delivered, opened, get state() { return values[KEY][key]; }, get collections() { return collections; }, set open(v) { open = v; }, set permit(v) { permit = v; }, set failWrite(v) { failWrite = v; }, set snapshot(v) { snapshotValue = v; }, browser };
}
test('runtime coalesces tabs and concurrent refreshes, persists across worker restart, and pauses when closed', async () => {
    const f = await runtimeFixture();
    await Promise.all([f.runtime.refresh(), f.runtime.refresh()]); assert.equal(f.collections, 1); assert.equal(f.state.inbox.length, 1);
    const restarted = create({ browser: f.browser, origins: async () => [binding.origin], identity, collect() {}, now: () => now });
    await restarted.refresh(); assert.equal(f.state.inbox.length, 1);
    f.open = false; await f.runtime.refresh(); assert.equal(f.state.status, 'paused');
});
test('runtime rejects page senders and unknown accounts; mark-read stays local', async () => {
    const f = await runtimeFixture(); await f.runtime.refresh();
    assert.equal((await f.send('read', {}, { id: 'test', url: binding.origin })).ok, false);
    assert.equal((await f.send('read', { accountKey: 'b'.repeat(64) })).ok, false);
    await f.send('markRead', { id: 'all' }); assert.equal(f.state.inbox[0].read, true);
});
test('permission denial prevents desktop opt-in and storage failure prevents delivery', async () => {
    const f = await runtimeFixture(); const prefs = model.preferences(); prefs.due.desktop = true;
    assert.equal((await f.send('preferences', { preferences: prefs })).ok, false);
    f.permit = true; await f.send('preferences', { preferences: prefs }); f.failWrite = true;
    await assert.rejects(f.runtime.refresh(), /disk/); assert.equal(f.delivered.length, 0);
    f.failWrite = false; await f.runtime.refresh(); assert.equal(f.delivered.length, 1);
    await f.runtime.click(f.delivered[0].id); assert.equal(f.opened[0].url, `${binding.origin}/courses/1/assignments/1`);
});
test('partial or malformed Canvas refresh retains inbox without new alerts', async () => {
    const f = await runtimeFixture(); await f.runtime.refresh(); f.snapshot = null;
    await f.runtime.refresh(); assert.equal(f.state.status, 'error'); assert.equal(f.state.inbox.length, 1);
});

const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
async function collected({ changedUser = false, failure = false, next = null } = {}) {
    let selfReads = 0;
    const requests = [];
    const sandbox = {
        location: { origin: binding.origin }, URL, AbortController, setTimeout, clearTimeout,
        chrome: { storage: { local: { async get() { return {}; } } } },
        APStudyCanvasCanvasAdapter: { Identity: identity },
        APStudyCanvasContent: { TodoApi: require('../../js/content/todo-api.js'), TodoModel: require('../../js/content/todo-model.js'), TodoTime: require('../../js/content/todo-time.js') },
        fetch: async value => {
            const url = new URL(value); requests.push(url.href);
            if (url.pathname.endsWith('/profile')) { selfReads++; return new Response(JSON.stringify({ id: changedUser && selfReads > 1 ? '99' : '42', time_zone: 'America/New_York' })); }
            if (url.pathname === '/api/v1/courses') return new Response(JSON.stringify([{ id: 1, name: 'Biology' }]));
            if (url.pathname.endsWith('/assignments')) return new Response(JSON.stringify([{ id: 2, name: 'Essay', due_at: new Date(now + 3600000).toISOString(), html_url: binding.origin + '/courses/1/assignments/2', submission: { workflow_state: 'graded', grade: 'A', score: 95, posted_at: null } }]), { headers: next ? { Link: `<${next}>; rel="next"` } : {} });
            if (url.pathname.endsWith('/announcements')) return new Response(JSON.stringify([]), { status: failure ? 403 : 200 });
            if (url.pathname.endsWith('/planner/items')) return new Response(JSON.stringify([]));
            throw new Error('unexpected URL');
        }
    };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../../js/notifications/collector.js'), 'utf8'), sandbox);
    return sandbox.collectCanvasNotifications(binding.origin, '42');
}
test('collector normalizes real assignment data and does not expose unposted grades', async () => {
    const data = await collected(); assert.equal(data.tasks.length, 1); assert.equal(data.tasks[0].title, 'Essay'); assert.equal(data.activities[0].revision, 'ungraded');
});
test('collector discards partial failures, account changes and off-origin pagination', async () => {
    await assert.rejects(collected({ changedUser: true }), /account changed/);
    await assert.rejects(collected({ failure: true }), /Announcements unavailable/);
    await assert.rejects(collected({ next: 'https://evil.test/api/v1/courses/1/assignments' }), /Invalid Canvas URL/);
});
test('Notifications category is registered in both schema and controller navigation', () => {
    assert.ok(require('../../js/settings-schema.js').categories.includes('notifications'));
    const controller = require('../../js/popup-controller.js');
    assert.ok(controller.CATEGORIES.includes('notifications'));
    const html = fs.readFileSync(path.join(__dirname, '../../html/popup.html'), 'utf8');
    assert.match(html, /id="nav-group-account">Account<\/p>\s*<button[^>]*data-workspace-target="notifications"/);
});
