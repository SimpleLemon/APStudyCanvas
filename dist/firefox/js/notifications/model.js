(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.APStudyNotifications = api;
}(globalThis, function () {
    'use strict';
    const DAY = 86400000;
    function preferences(value = {}) {
        const result = { version: 1, leadMinutes: [0, 15, 60, 180, 1440].includes(value.leadMinutes) ? value.leadMinutes : 180, overdue: ['never', 'once', 'daily'].includes(value.overdue) ? value.overdue : 'never' };
        for (const kind of ['announcements', 'grades', 'due']) result[kind] = { inbox: value[kind]?.inbox !== false, desktop: value[kind]?.desktop === true };
        return result;
    }
    function safeUrl(value, origin) {
        if (typeof value !== 'string' || !value.trim()) return null;
        try { const url = new URL(value, origin); return url.origin === origin && url.protocol === 'https:' && !url.username && !url.password ? url.href : null; } catch { return null; }
    }
    function dueTime(due) {
        if (due?.kind !== 'date') return Date.parse(due?.utcInstant || '');
        // Find midnight after the date in its named zone, including DST changes.
        const target = Date.parse(`${due.date}T00:00:00Z`) + DAY;
        let guess = target;
        try {
            const format = new Intl.DateTimeFormat('en-CA', { timeZone: due.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
            for (let i = 0; i < 4; i++) {
                const p = Object.fromEntries(format.formatToParts(new Date(guess)).map(part => [part.type, part.value]));
                guess += target - Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);
            }
            return guess - 1;
        } catch { return NaN; }
    }
    function empty(binding) { return { version: 1, binding, preferences: preferences(), inbox: [], baseline: {}, delivered: {}, lastFetched: null, status: 'paused' }; }
    function reconcile(previous, snapshot, now = Date.now()) {
        const state = JSON.parse(JSON.stringify(previous));
        state.preferences = preferences(state.preferences);
        state.inbox = (state.inbox || []).filter(row => row.createdAt > now - 30 * DAY);
        state.delivered = Object.fromEntries(Object.entries(state.delivered || {}).filter(([, at]) => at > now - 90 * DAY));
        state.sourceSeenAt = state.sourceSeenAt || {};
        state.revisionCount = state.revisionCount || {};
        const first = !state.lastFetched;
        const resumed = !first && (state.status !== 'live' || now - state.lastFetched > 10 * 60000);
        const events = [], reminders = [];
        const add = (id, kind, item, title = item.title) => {
            if (state.delivered[id]) return;
            state.delivered[id] = now;
            if (state.preferences[kind].inbox || state.preferences[kind].desktop) events.push({ id, kind, title: String(title).slice(0, 255), course: String(item.course || '').slice(0, 120), url: safeUrl(item.url, state.binding.origin), createdAt: now, read: false });
        };
        for (const item of snapshot.activities) {
            const old = state.baseline[item.id];
            const revision = String(item.revision);
            if (old !== revision) state.revisionCount[item.id] = (state.revisionCount[item.id] || 0) + 1;
            if (!first && ((item.kind === 'announcements' && old === undefined) || (item.kind === 'grades' && revision !== 'ungraded' && old !== undefined && old !== revision))) add(`${item.id}:${state.revisionCount[item.id]}`, item.kind, item);
            state.baseline[item.id] = revision;
            state.sourceSeenAt[item.id] = now;
        }
        for (const item of snapshot.tasks) {
            const due = dueTime(item.due);
            if (!Number.isFinite(due) || item.completed || item.submitted) continue;
            const advance = due - state.preferences.leadMinutes * 60000;
            let occurrence = null;
            if (now >= advance && (now <= due + 5 * 60000 || (resumed && due >= previous.lastFetched))) occurrence = 'before';
            else if (now > due && state.preferences.overdue !== 'never' && due > now - 30 * DAY) occurrence = state.preferences.overdue === 'daily' ? `after-${Math.floor((now - due) / DAY)}` : 'after';
            if (!occurrence) continue;
            const id = `${item.id}:${due}:${occurrence}`;
            if (state.delivered[id]) continue;
            if (resumed) { state.delivered[id] = now; reminders.push(item); }
            else add(id, 'due', item, `${occurrence === 'before' ? (now >= due ? 'Due now' : 'Due soon') : 'Overdue'}: ${item.title}`);
        }
        if (reminders.length) add(`summary:${now}`, 'due', { title: `${reminders.length} task reminder${reminders.length === 1 ? '' : 's'} while updates were paused`, url: '/planner', course: '' });
        const desktop = events.filter(row => state.preferences[row.kind].desktop);
        state.inbox = [...events.filter(row => state.preferences[row.kind].inbox), ...state.inbox].sort((a, b) => b.createdAt - a.createdAt).slice(0, 200);
        // Retain recently absent sources so pagination windows and read-state changes cannot replay them.
        for (const [id, seen] of Object.entries(state.sourceSeenAt)) if (seen < now - 90 * DAY) { delete state.sourceSeenAt[id]; delete state.baseline[id]; delete state.revisionCount[id]; }
        state.desktopLinks = [...desktop, ...(state.desktopLinks || [])].filter(row => row.createdAt > now - 30 * DAY).slice(0, 200);
        state.lastFetched = now;
        state.status = 'live';
        return { state, desktop };
    }
    return Object.freeze({ DAY, preferences, safeUrl, dueTime, empty, reconcile });
}));
