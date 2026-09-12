(function () {
    'use strict';
    let accountKey = null, current = null, started = false, request = 0, busy = false;
    const $ = id => document.getElementById(id);
    const model = globalThis.APStudyNotifications;
    function status(message) { $('notification-save-status').textContent = message; }
    async function send(action, extra = {}) {
        const result = await Promise.race([
            chrome.runtime.sendMessage({ type: 'APSTUDY_NOTIFICATIONS', version: 1, action, accountKey, ...extra }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Notifications timed out. Try again.')), 10000))
        ]);
        if (!result?.ok) throw new Error(result?.error || 'Notifications are unavailable. Try again.');
        return result;
    }
    function el(tag, text, className) { const node = document.createElement(tag); if (text) node.textContent = text; if (className) node.className = className; return node; }
    async function inbox(account) {
        const content = document.querySelector('#notifications-popover .popover-empty');
        if (!content) return;
        const stored = await chrome.storage.local.get('seen_update_version');
        const version = chrome.runtime.getManifest().version;
        const unseen = stored.seen_update_version !== version;
        const rows = account?.inbox || [];
        const unread = rows.filter(row => !row.read).length + (unseen ? 1 : 0);
        const badge = document.querySelector('#notifications-button .notification-badge');
        badge.textContent = String(unread); badge.hidden = unread === 0;
        badge.setAttribute('aria-label', `${unread} unread notification${unread === 1 ? '' : 's'}`);
        content.replaceChildren();
        const toolbar = el('div', '', 'notification-inbox-toolbar');
        const settings = el('button', 'Notification settings', 'workspace-action'); settings.type = 'button';
        settings.onclick = () => { document.querySelector('#notifications-popover .popover-close')?.click(); window.APStudyCanvasWorkspace?.navigate('settings', { category: 'notifications' }).catch(error => status(error.message)); };
        const mark = el('button', 'Mark all read', 'workspace-action'); mark.type = 'button'; mark.disabled = !unread;
        mark.onclick = async () => { try { if (account) await send('markRead', { id: 'all' }); await chrome.storage.local.set({ seen_update_version: version }); await refresh(); } catch (error) { status(error.message); } };
        toolbar.append(settings, mark); content.append(toolbar);
        if (!account || account.status !== 'live') content.append(el('p', account?.status === 'error' ? 'Canvas refresh failed. Updates will retry while Canvas is open.' : 'Updates paused. Open Canvas to connect.', 'workspace-helper'));
        if (unseen) {
            const item = el('div', '', 'notification-inbox-row');
            item.append(el('strong', `APStudyCanvas ${version} is ready`), el('small', 'Extension update'));
            const seen = el('button', 'Mark read', 'workspace-action'); seen.type = 'button'; seen.onclick = async () => { await chrome.storage.local.set({ seen_update_version: version }); await refresh(); }; item.append(seen); content.append(item);
        }
        if (!rows.length) content.append(el('p', account ? 'No Canvas notifications yet. New activity and reminders will appear here.' : 'Choose a Canvas account in Notification settings to see its inbox.', 'workspace-helper'));
        for (const row of rows) {
            const item = el('div', '', `notification-inbox-row${row.read ? ' is-read' : ''}`);
            const href = model.safeUrl(row.url, account.binding.origin);
            const title = el(href ? 'a' : 'strong', row.title);
            if (href) { title.href = href; title.target = '_blank'; title.rel = 'noopener noreferrer'; title.onclick = () => send('markRead', { id: row.id }).then(refresh).catch(error => status(error.message)); }
            item.append(title, el('small', [row.course, new Date(row.createdAt).toLocaleString()].filter(Boolean).join(' · ')));
            if (!row.read) { const read = el('button', 'Mark read', 'workspace-action'); read.type = 'button'; read.onclick = () => send('markRead', { id: row.id }).then(refresh).catch(error => status(error.message)); item.append(read); }
            content.append(item);
        }
    }
    async function refresh() {
        if (!started || busy) return;
        const sequence = ++request;
        try {
            const result = await send('read');
            if (sequence !== request) return;
            current = result.account;
            const select = $('notification-account');
            select.replaceChildren(new Option('Choose a Canvas account', ''));
            for (const binding of result.accounts) select.add(new Option(`${binding.label} · ${new URL(binding.origin).hostname}`, binding.accountKey));
            select.value = accountKey || '';
            const prefs = model.preferences(current?.preferences);
            for (const input of document.querySelectorAll('[data-notification-channel]')) { input.checked = prefs[input.dataset.notificationKind][input.dataset.notificationChannel]; input.disabled = !current; }
            $('notification-lead').value = String(prefs.leadMinutes); $('notification-overdue').value = prefs.overdue;
            $('notification-lead').disabled = $('notification-overdue').disabled = !current;
            $('notification-test').disabled = !current;
            const state = current?.status === 'live' ? 'Connected. Checks every 5 minutes while Canvas is open.' : current?.status === 'error' ? 'Canvas refresh failed. Retrying while Canvas is open.' : 'Updates paused. Open Canvas to connect.';
            $('notification-connection').textContent = state + (current?.lastFetched ? ` Last updated ${new Date(current.lastFetched).toLocaleString()}.` : '');
            $('notification-permission').textContent = current?.deliveryError || (result.permission === 'granted' ? 'Desktop permission enabled.' : result.permission === 'denied' ? 'Desktop alerts blocked. Check browser and system settings.' : 'Enable a Desktop switch to allow alerts.');
            await inbox(current);
        } catch (error) { if (sequence === request) { status(error.message); await inbox(null); } }
    }
    async function save(event) {
        if (!current || busy) return;
        const target = event.target;
        const kind = target.dataset.notificationKind, channel = target.dataset.notificationChannel;
        const prefs = model.preferences(current.preferences);
        // Request permission directly from the initiating click, before other asynchronous work.
        const approval = channel === 'desktop' && target.checked ? chrome.permissions.request({ permissions: ['notifications'] }) : Promise.resolve(true);
        busy = true; status('Saving…');
        $('notification-account').disabled = true;
        for (const input of document.querySelectorAll('[data-notification-channel], #notification-lead, #notification-overdue')) input.disabled = true;
        try {
            if (!await approval) throw new Error('Desktop permission was not granted. Your previous settings are unchanged.');
            if (kind) prefs[kind][channel] = target.checked;
            else if (target.id === 'notification-lead') prefs.leadMinutes = Number(target.value);
            else prefs.overdue = target.value;
            await send('preferences', { preferences: prefs });
            status('Saved to this device.');
        } catch (error) { status(error.message); }
        finally { busy = false; $('notification-account').disabled = false; await refresh(); }
    }
    async function start() {
        if (started) return refresh();
        started = true;
        $('notification-account').addEventListener('change', event => { accountKey = event.target.value || null; refresh(); });
        for (const input of document.querySelectorAll('[data-notification-channel], #notification-lead, #notification-overdue')) input.addEventListener('change', save);
        $('notification-test').addEventListener('click', async () => {
            try {
                const allowed = await chrome.permissions.request({ permissions: ['notifications'] });
                if (!allowed) throw new Error('Desktop permission was not granted.');
                await send('test'); status('Test sent. Check your system notifications.'); await refresh();
            } catch (error) { status(error.message); }
        });
        $('notifications-button').addEventListener('click', refresh);
        chrome.storage.onChanged?.addListener((changes, area) => { if (area === 'local' && (changes['notifications.accounts.v1'] || changes.seen_update_version)) refresh(); });
        chrome.permissions.onRemoved?.addListener(refresh);
        chrome.permissions.onAdded?.addListener(refresh);
        return refresh();
    }
    window.addEventListener('apstudycanvas-canvas-context', event => {
        if (event.detail.canvasBinding?.accountKey) accountKey = event.detail.canvasBinding.accountKey;
        refresh();
    });
    window.APStudyNotificationUI = { start, refresh };
}());
