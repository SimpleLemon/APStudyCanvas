(function (root, factory) {
    const api = factory(root.APStudyNotifications);
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.APStudyNotificationRuntime = api;
}(globalThis, function (model) {
    'use strict';
    const KEY = 'notifications.accounts.v1';
    const ALARM = 'apstudy-notifications';
    function create({ browser, origins, collect, identity, now = Date.now }) {
        let queue = Promise.resolve(), pendingRefresh = null;
        const serialized = operation => { const run = queue.then(operation); queue = run.catch(() => {}); return run; };
        const load = async () => (await browser.storage.local.get(KEY))[KEY] || {};
        const save = accounts => browser.storage.local.set({ [KEY]: accounts });
        async function sessions() {
            const allowed = new Set(await origins());
            const found = new Map();
            const tabs = await browser.tabs.query({});
            for (const tab of tabs) {
                let origin;
                try { origin = new URL(tab.url).origin; } catch { continue; }
                if (!allowed.has(origin)) continue;
                try {
                    const context = await Promise.race([
                        browser.tabs.sendMessage(tab.id, { type: 'GET_CANVAS_CONTEXT', version: 1, requestId: 'notification-context' }),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2500))
                    ]);
                    const userId = String(context?.canvasUser?.id || context?.canvasBinding?.canvasUserId || '');
                    if (!context?.ok || context.state !== 'connected' || context.origin !== origin || !userId) continue;
                    const accountKey = await identity.accountKey({ origin, userId });
                    found.set(accountKey, { tabId: tab.id, binding: { accountKey, origin, canvasUserId: userId, label: String(context.canvasUser?.name || userId).slice(0, 120) } });
                } catch { /* A loading or signed-out tab is not an authenticated session. */ }
            }
            return found;
        }
        async function permission() {
            if (!await browser.permissions.contains({ permissions: ['notifications'] })) return 'not-granted';
            return browser.notifications?.getPermissionLevel ? browser.notifications.getPermissionLevel() : 'granted';
        }
        async function deliver(account, events) {
            if (!events.length || await permission() !== 'granted') return;
            for (const row of events) {
                try {
                    await browser.notifications.create(`${ALARM}:${account.binding.accountKey}:${encodeURIComponent(row.id)}`, { type: 'basic', iconUrl: browser.runtime.getURL('icon/icon-128.png'), title: row.title, message: row.course || 'APStudyCanvas' });
                } catch { account.deliveryError = 'Desktop delivery failed. Check browser and system notification settings.'; }
            }
        }
        async function refreshInternal() {
            const accounts = await load();
            const live = await sessions();
            const deliveries = [];
            let next = now() + 5 * 60000;
            for (const account of Object.values(accounts)) if (!live.has(account.binding.accountKey)) account.status = 'paused';
            for (const [key, session] of live) {
                let account = accounts[key] || model.empty(session.binding);
                try {
                    const results = await browser.scripting.executeScript({ target: { tabId: session.tabId }, func: collect, args: [session.binding.origin, session.binding.canvasUserId] });
                    const snapshot = results?.[0]?.result;
                    if (!snapshot || !Array.isArray(snapshot.tasks) || !Array.isArray(snapshot.activities)) throw new Error('Invalid snapshot');
                    const reconciled = model.reconcile(account, snapshot, now());
                    account = reconciled.state;
                    account.deliveryError = null;
                    account.binding = session.binding;
                    deliveries.push([account, reconciled.desktop]);
                    for (const task of snapshot.tasks) {
                        if (task.completed || task.submitted) continue;
                        const due = model.dueTime(task.due);
                        for (const time of [due - account.preferences.leadMinutes * 60000, due + 1000]) if (time > now()) next = Math.min(next, time);
                    }
                } catch { account.status = 'error'; }
                accounts[key] = account;
            }
            // Persist occurrence IDs before external delivery. A worker restart cannot replay them.
            await save(accounts);
            for (const [account, events] of deliveries) await deliver(account, events);
            if (deliveries.some(([account]) => account.deliveryError)) await save(accounts);
            await browser.alarms.create(`${ALARM}-due`, { when: Math.max(now() + 1000, next) });
        }
        function refresh() {
            if (!pendingRefresh) pendingRefresh = serialized(refreshInternal).finally(() => { pendingRefresh = null; });
            return pendingRefresh;
        }
        async function response(accounts, key) {
            const account = key ? accounts[key] : null;
            return { ok: true, account: account || null, accounts: Object.values(accounts).map(a => a.binding), permission: await permission() };
        }
        function trusted(sender) {
            if (sender?.id !== browser.runtime.id) return false;
            try { const url = new URL(sender.url); const expected = new URL(browser.runtime.getURL('html/popup.html')); return url.origin === expected.origin && url.pathname === expected.pathname; } catch { return false; }
        }
        async function handle(message, sender) {
            if (!trusted(sender) || message.version !== 1) return { ok: false, error: 'Notification request rejected.' };
            return serialized(async () => {
                const accounts = await load();
                const key = message.accountKey;
                if (key != null && (!/^[a-f0-9]{64}$/.test(key) || !accounts[key])) return { ok: false, error: 'Connect this Canvas account to load notifications.' };
                const account = accounts[key];
                if (message.action === 'read') {
                    const live = await sessions();
                    for (const value of Object.values(accounts)) if (!live.has(value.binding.accountKey)) value.status = 'paused';
                    return response(accounts, key);
                }
                if (!account) return { ok: false, error: 'Choose a connected Canvas account.' };
                if (message.action === 'preferences') {
                    if (!message.preferences || typeof message.preferences !== 'object' || JSON.stringify(message.preferences).length > 2000) return { ok: false, error: 'Invalid notification preferences.' };
                    const prefs = model.preferences(message.preferences);
                    if (['announcements', 'grades', 'due'].some(kind => prefs[kind].desktop && !account.preferences[kind].desktop) && await permission() !== 'granted') return { ok: false, error: 'Allow desktop notifications in your browser first.' };
                    account.preferences = prefs;
                } else if (message.action === 'markRead') {
                    for (const row of account.inbox) if (message.id === 'all' || row.id === message.id) row.read = true;
                } else if (message.action === 'test') {
                    if (await permission() !== 'granted') return { ok: false, error: 'Desktop permission is not enabled.' };
                    await browser.notifications.create(`${ALARM}-test`, { type: 'basic', iconUrl: browser.runtime.getURL('icon/icon-128.png'), title: 'Notifications are ready', message: 'Canvas alerts will appear here while Canvas is connected.' });
                } else return { ok: false, error: 'Unknown notification action.' };
                await save(accounts);
                return response(accounts, key);
            });
        }
        async function click(id) {
            if (!id.startsWith(`${ALARM}:`)) return;
            await serialized(async () => {
                const [, key, ...parts] = id.split(':');
                const accounts = await load();
                const account = accounts[key];
                const row = [...(account?.inbox || []), ...(account?.desktopLinks || [])].find(item => encodeURIComponent(item.id) === parts.join(':'));
                if (!account || !(await origins()).includes(account.binding.origin)) return;
                if (!row) return;
                const url = model.safeUrl(row.url || '/planner', account.binding.origin);
                if (!url) return;
                if (row) row.read = true;
                await save(accounts);
                await browser.tabs.create({ url });
                await browser.notifications.clear(id);
            });
        }
        return { handle, refresh, click, alarm: ALARM, key: KEY };
    }
    return { create, KEY, ALARM };
}));
