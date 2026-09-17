/* Shared connection controls. The caller owns authenticated transport and navigation. */
(function (root) {
    'use strict';
    function mount(host, { request, openUrl = url => root.open(url, '_blank', 'noopener'), native = false } = {}) {
        const doc = host.ownerDocument;
        let disposed = false, generation = 0, busy = false;
        const resolutionAttempts = new Map();
        const controller = new AbortController();
        function node(tag, text, attrs = {}) {
            const element = doc.createElement(tag);
            if (text) element.textContent = text;
            for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value);
            return element;
        }
        const message = node('p', 'Loading calendar connections…', { role: 'status', 'aria-live': 'polite' });
        const content = node('div'); host.replaceChildren(message, content);
        function button(label, action) {
            const element = node('button', label, { type: 'button', class: 'calendar-connect-button' });
            element.addEventListener('click', () => perform(action), { signal: controller.signal });
            return element;
        }
        async function perform(action) {
            if (busy || disposed) return;
            busy = true; host.setAttribute('aria-busy', 'true');
            host.querySelectorAll('button').forEach(element => { element.disabled = true; });
            try { await action(); }
            catch (error) { if (!disposed) message.textContent = readable(error.code || error.message); }
            finally {
                busy = false;
                if (!disposed) { host.removeAttribute('aria-busy'); host.querySelectorAll('button').forEach(element => { element.disabled = element.dataset.unavailable === 'true'; }); }
            }
        }
        function readable(code) {
            const messages = {
                provider_not_configured: 'Calendar connection is not enabled yet. Try again after setup is complete.',
                reconnect_required: 'Access expired. Reconnect this account to resume synchronization.',
                sync_in_progress: 'A sync is finishing. Wait a moment and try again.',
                sync_rate_limited: 'Your calendar just synced. Try again in 30 seconds.',
                calendar_permission_denied: 'Calendar access changed. Refresh calendars or reconnect the account.',
                calendar_consent_incomplete: 'Calendar permissions were not fully granted. Reconnect and allow calendar access.',
                export_calendar_setup_interrupted: 'Export calendar setup was interrupted. Refresh calendars, then select the APStudy calendar to recover it.',
                calendar_consent_cancelled: 'Calendar connection was cancelled. You can connect again whenever you are ready.',
                event_revision_conflict: 'This event changed elsewhere. Refresh before editing it again.',
                export_calendar_unavailable: 'The APStudy export calendar is unavailable. Refresh calendars or reconnect to restore access.',
                provider_review_required: 'This event now requires Google or Outlook. Open it there, then recheck its changes.',
                provider_unavailable: 'The calendar provider is unavailable. Nest will retry automatically.',
            };
            return messages[code] || 'Unable to complete this action. Refresh and try again.';
        }
        async function connect(provider, connectionId) {
            if (!native) { openUrl('https://nest.apstudy.org/calendar/connections'); return; }
            const payload = await request('/connections/connect/' + provider, { connection_id: connectionId || null });
            const url = new URL(payload.authorization_url);
            const expected = provider === 'google' ? 'accounts.google.com' : 'login.microsoftonline.com';
            if (url.protocol !== 'https:' || url.hostname !== expected) throw new Error('Invalid connection destination');
            root.location.assign(url.href);
        }
        function checkbox(container, name, value, label, checked) {
            const row = node('label', '', { class: 'calendar-connect-choice' });
            const input = node('input', '', { type: 'checkbox', name, value }); input.checked = Boolean(checked);
            row.append(input, node('span', label)); container.append(row);
        }
        function renderConnection(item) {
            const section = node('section', '', { class: 'calendar-connect-account', 'aria-label': item.label });
            section.append(node('h3', (item.provider === 'google' ? 'Google · ' : 'Microsoft · ') + item.label));
            const last = item.last_sync_at ? new Date(item.last_sync_at * 1000).toLocaleString() : 'Not synced yet';
            section.append(node('p', `${item.status === 'active' ? 'Connected' : item.status.replaceAll('_', ' ')} · ${last} · ${item.pending} pending`));
            if (item.export_error) section.append(node('p', readable(item.export_error), { role: 'status' }));
            if (item.failed?.length) section.append(node('p', `${item.failed.length} event changes failed. Refresh calendars to check access, then use Sync now to retry.`));
            if (item.last_error) section.append(node('p', readable(item.last_error), { role: 'status' }));
            const controls = node('div', '', { class: 'calendar-connect-actions' }); section.append(controls);
            if (['disconnected', 'reconnect'].includes(item.status)) {
                controls.append(button('Reconnect', () => connect(item.provider, item.id)));
                return section;
            }
            controls.append(button('Refresh calendars', async () => { await request(`/connections/${item.id}/calendars`, {}); await refresh(); }));
            controls.append(button('Sync now', async () => { await request(`/connections/${item.id}/sync`, {}); message.textContent = 'Sync queued. Nest will continue in the background.'; }));
            const form = node('form'); section.append(form);
            const imports = node('fieldset'); imports.append(node('legend', 'Calendars to show in APStudy'));
            for (const calendar of item.calendars) checkbox(imports, 'calendar', calendar.id, calendar.name + (calendar.available === 0 ? ' (access unavailable)' : calendar.writable ? '' : ' (read only)'), calendar.selected);
            if (!item.calendars.length) imports.append(node('p', 'Refresh calendars to choose which calendars to synchronize.'));
            const exports = node('fieldset'); exports.append(node('legend', 'Publish to the APStudy calendar'));
            const defaults = item.status === 'setup' && !item.export_sources.length ? ['personal', 'canvas', 'tasks', 'courses'] : item.export_sources;
            for (const [id, label] of [['personal','Personal events'],['canvas','Canvas deadlines'],['tasks','Nest tasks'],['courses','Saved course meetings']]) checkbox(exports, 'source', id, label, defaults.includes(id));
            form.append(imports, exports, node('p', 'Saving allows Nest to read your selected calendars, edit personal events you change in APStudy, and publish these sources. Guest meetings and series rules are managed in Google or Outlook.'));
            form.append(button('Save synchronization choices', async () => {
                const data = new FormData(form);
                await request(`/connections/${item.id}/configure`, { calendar_ids: data.getAll('calendar'), export_sources: data.getAll('source'), consent_version: 1 });
                await refresh(); message.textContent = 'Choices saved. Synchronization is queued.';
            }));
            if ((item.export_error || item.last_error) === 'export_calendar_setup_interrupted') {
                const label = node('label', 'Existing APStudy calendar '); const select = node('select', '', { 'aria-label': 'Existing APStudy calendar' });
                item.calendars.filter(x => x.writable).forEach(x => select.append(node('option', x.name, { value: x.id })));
                label.append(select); section.append(label, button('Use this as the APStudy export calendar', async () => {
                    await request(`/connections/${item.id}/recover-calendar`, { calendar_id: select.value, confirm_managed_calendar: true }); await refresh();
                }));
            }
            for (const exported of item.suppressed || []) section.append(button('Restore removed export', async () => {
                await request(`/connections/${item.id}/exports/${exported.id}/restore`, {}); await refresh();
            }));
            const disconnect = node('details'); disconnect.append(node('summary', 'Disconnect account'));
            disconnect.append(node('p', 'Imported events disappear from APStudy. Exported events stay in your connected calendar unless you choose cleanup.'));
            const cleanup = node('label', '', { class: 'calendar-connect-choice' }); const check = node('input', '', { type: 'checkbox' });
            cleanup.append(check, node('span', 'Also remove APStudy-managed exports. This cannot be undone.')); disconnect.append(cleanup);
            disconnect.append(button(item.status === 'cleanup' ? 'Retry cleanup or disconnect without cleanup' : 'Disconnect', async () => {
                await request(`/connections/${item.id}/disconnect`, { cleanup: check.checked }); await refresh();
            })); section.append(disconnect);
            return section;
        }
        async function refresh() {
            const turn = ++generation;
            const payload = await request('/connections');
            if (disposed || turn !== generation) return;
            const fragment = doc.createDocumentFragment();
            fragment.append(node('p', `Automatically syncs every few minutes, including when your browser is closed. Active range: ${payload.window.start} to ${payload.window.end}. Older exports remain in your calendar.`));
            const actions = node('div', '', { class: 'calendar-connect-actions' });
            for (const [provider, label] of [['google', 'Connect Google']]) {
                const control = button(label, () => connect(provider));
                control.disabled = payload.capabilities.providers[provider] !== true;
                control.dataset.unavailable = String(control.disabled);
                actions.append(control);
            }
            actions.append(button('Refresh status', refresh)); fragment.append(actions);
            if (!Object.values(payload.capabilities.providers).some(Boolean)) fragment.append(node('p', 'Direct calendar connections are awaiting server configuration.'));
            if (!payload.connections.length) fragment.append(node('p', 'Connect an account to choose calendars. Your current calendar and ICS links keep working.'));
            payload.connections.forEach(item => fragment.append(renderConnection(item)));
            content.replaceChildren(fragment);
            message.textContent = native && new URLSearchParams(root.location.search).has('error') ? readable(new URLSearchParams(root.location.search).get('error')) : 'Calendar connection status is up to date.';
            if (payload.connections.some(item => item.conflicts)) {
                const result = await request('/calendar-conflicts');
                if (disposed || turn !== generation) return;
                const section = node('section', '', { class: 'calendar-connect-conflicts' }); section.append(node('h3', 'Review conflicting changes'));
                for (const item of result.conflicts) {
                    const group = node('section');
                    for (const [key, label] of [['local_body', 'APStudy version'], ['remote_body', 'Calendar version']]) {
                        group.append(node('h4', label)); const body = item[key];
                        group.append(node('p', body ? `${body.title} · ${body.start} — ${body.end} (${body.timezone})` : 'Event deleted'));
                        if (body?.description) group.append(node('p', body.description));
                        if (body) group.append(node('p', `${body.all_day ? 'All day · ' : ''}Location: ${body.location || 'None'} · Reminder: ${body.reminder_minutes < 0 ? 'None' : body.reminder_minutes + ' minutes before'}`));
                    }
                    const reviewOnly = item.reason === 'provider_review_required';
                    if (reviewOnly) {
                        group.append(node('p', readable(item.reason)));
                        if (item.source_url) {
                            const url = new URL(item.source_url);
                            if (url.protocol === 'https:' && ['calendar.google.com','www.google.com','outlook.office.com','outlook.office365.com','outlook.live.com'].includes(url.hostname)) {
                                const link = node('a', 'Open calendar event', {href: url.href, target: '_blank', rel: 'noopener noreferrer'}); group.append(link);
                            }
                        }
                    }
                    const choices = reviewOnly ? [['retry', 'Recheck provider changes']] : [['local', 'Keep APStudy version'], ['remote', 'Keep calendar version']];
                    for (const [choice, label] of choices) group.append(button(label, async () => {
                        const key = `${item.id}:${item.revision}:${choice}`;
                        if (!resolutionAttempts.has(key)) resolutionAttempts.set(key, root.crypto.randomUUID());
                        await request(`/calendar-conflicts/${item.id}/resolve`, { choice, revision: item.revision, idempotency_key: resolutionAttempts.get(key) });
                        resolutionAttempts.delete(key); await refresh();
                    }));
                    section.append(group);
                }
                content.append(section);
            }
        }
        perform(refresh);
        const focus = () => { if (!busy && !disposed && !host.contains(doc.activeElement)) perform(refresh); };
        root.addEventListener('focus', focus, { signal: controller.signal });
        return { refresh, dispose() { disposed = true; generation++; controller.abort(); host.replaceChildren(); } };
    }
    root.APStudyCalendarConnections = { mount };
    async function boot() {
        const host = root.document.querySelector('[data-calendar-connections-native]'); if (!host) return;
        let csrf;
        mount(host, { native: true, request: async (path, body, method) => {
            if (body !== undefined && !csrf) {
                const response = await fetch('/api/extension/csrf', { credentials: 'same-origin', cache: 'no-store' }); csrf = response.headers.get('X-CSRFToken');
            }
            const response = await fetch('/api/calendar' + path, { credentials: 'same-origin', cache: 'no-store', method: method || (body === undefined ? 'GET' : 'POST'),
                headers: { 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRFToken': csrf } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
            const payload = await response.json();
            if (!response.ok || payload.ok !== true) { const error = new Error(payload.code); error.code = payload.code; throw error; }
            return payload;
        } });
    }
    if (root.document?.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', boot, { once: true });
    else if (root.document) boot();
}(typeof window !== 'undefined' ? window : globalThis));
