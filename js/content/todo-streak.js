(function (root, factory) {
    "use strict";
    const time = root?.APStudyCanvasContent?.TodoTime || (typeof require === "function" ? require("./todo-time.js") : null);
    const api = factory(time);
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasContent = Object.assign(root.APStudyCanvasContent || {}, { TodoStreak: api });
}(typeof globalThis !== "undefined" ? globalThis : this, function (time) {
    "use strict";
    const POLICY_VERSION = 4, HISTORY_VERSION = 4;
    const STORAGE_KEY = "todo_streak_history_v4";
    const MAX_DAYS_PER_FETCH = 90, SEED_DAYS = 180;
    const CLEAR = "clear", MISSED = "missed", NONE = "none";
    const key = value => time.dateKeyValid(value) ? value : null;
    function scopeKey({ accountKey, timeZone, policyVersion = POLICY_VERSION } = {}) {
        return `${policyVersion}:${String(accountKey || "").toLowerCase()}:${timeZone || ""}`;
    }
    function empty({ accountKey = "", timeZone = "" } = {}) {
        return { v: HISTORY_VERSION, policyVersion: POLICY_VERSION, accountKey: accountKey.toLowerCase(), timeZone,
            since: null, startedAt: null, lastSettledDate: null, lastVerified: null, current: 0, best: 0,
            days: {}, forgiven: [], revision: 0, correctionRevision: 0, todayComplete: false };
    }
    function normalize(history, scope) {
        const base = empty(scope);
        if (!history || history.v !== HISTORY_VERSION || history.policyVersion !== POLICY_VERSION || history.accountKey !== base.accountKey || history.timeZone !== base.timeZone) return base;
        const days = Object.fromEntries(Object.entries(history.days || {}).filter(([d, v]) => key(d) && [CLEAR, MISSED, NONE].includes(v)));
        // v4 originally anchored a clean first seed to "today", even when the
        // fetched Canvas history contained weeks of completed work. The daily
        // outcomes retain enough evidence to repair those records in place:
        // CLEAR/MISSED are observed due-task days, while NONE is an empty day.
        const firstObserved = Object.entries(days).filter(([, state]) => state !== NONE).map(([date]) => date).sort()[0] || null;
        const recordedSince = key(history.since);
        const since = firstObserved && (!recordedSince || firstObserved < recordedSince) ? firstObserved : recordedSince;
        return { ...base, since, startedAt: key(history.startedAt), lastSettledDate: key(history.lastSettledDate),
            lastVerified: history.lastVerified || null, days, forgiven: (Array.isArray(history.forgiven) ? history.forgiven : []).filter(key),
            current: Math.max(0, Number(history.current) || 0), best: Math.max(0, Number(history.best) || 0),
            revision: Math.max(0, Number(history.revision) || 0), correctionRevision: Math.max(0, Number(history.correctionRevision) || 0), todayComplete: history.todayComplete === true };
    }
    function seedWindow(scope) {
        const today = key(scope.today);
        return today ? { start: time.shiftDateKey(today, -SEED_DAYS), end: today, timeZone: scope.timeZone } : null;
    }
    function requiresSeed(history, scope) { return !normalize(history, scope).since; }
    function plan(history, scope) {
        const state = normalize(history, scope), today = key(scope.today);
        if (!today) return { state, range: null, reason: "clock-unavailable" };
        if (!state.since) return { state, range: seedWindow(scope), reason: "first-run" };
        const recent = time.shiftDateKey(today, -2);
        const next = state.lastSettledDate ? time.shiftDateKey(state.lastSettledDate, 1) : state.since;
        return { state, reason: "advance", range: { start: [state.since, next < recent ? next : recent].sort().at(-1), end: today, timeZone: scope.timeZone } };
    }
    function bucket(tasks, timeZone) {
        const byDay = new Map();
        for (const task of tasks || []) {
            if (!["canvas", "canvas-planner-note"].includes(task?.source) || task.type === "announcement") continue;
            const date = time.dueDateKey(task.due, timeZone);
            if (!date) continue;
            const row = byDay.get(date) || { total: 0, incomplete: 0, tasks: [] };
            row.total++; if (task.completion !== true) { row.incomplete++; row.tasks.push(task); }
            byDay.set(date, row);
        }
        return byDay;
    }
    function recalculate(state, today) {
        if (!state.since || !key(today)) return state;
        const forgiven = new Set(state.forgiven);
        let run = 0, best = 0, start = state.since;
        for (let d = state.since; d && d < today; d = time.shiftDateKey(d, 1)) {
            if (!state.days[d]) break; // Unknown is never a successful day.
            if (state.days[d] === MISSED && !forgiven.has(d)) { run = 0; start = time.shiftDateKey(d, 1); }
            else { run++; best = Math.max(best, run); }
        }
        if (state.todayComplete && state.lastSettledDate === time.shiftDateKey(today, -1)) run++;
        return { ...state, startedAt: start, current: run, best: Math.max(best, run) };
    }
    function advance(history, tasks, scope, { complete = true, range = null } = {}) {
        const planned = plan(history, scope);
        if (!complete || !planned.range) return { history: planned.state, changed: false, state: "partial", settled: 0 };
        range = range || planned.range;
        if (!key(range.start) || !key(range.end) || range.start > range.end || range.end !== scope.today || range.start !== planned.range.start)
            return { history: planned.state, changed: false, state: "partial", settled: 0 };
        const byDay = bucket(tasks, scope.timeZone), days = { ...planned.state.days };
        let settled = 0;
        for (let d = range.start; d < scope.today; d = time.shiftDateKey(d, 1)) {
            const row = byDay.get(d);
            // A detected break stays recorded even if the task is completed later.
            days[d] = days[d] === MISSED || row?.incomplete ? MISSED : row?.total ? CLEAR : NONE;
            settled++;
        }
        // Start with the earliest day on which Canvas actually observed due
        // work. Empty days after that count, but the seed window itself is not
        // fabricated as study activity. This also turns a first sync with 50
        // days of completed work into a 50-day run instead of day one.
        const firstObserved = Array.from(byDay.keys()).filter(d => d <= scope.today).sort()[0];
        const since = planned.state.since || firstObserved || scope.today;
        const todayRow = byDay.get(scope.today);
        const next = recalculate({ ...planned.state, since, days, lastSettledDate: time.shiftDateKey(scope.today, -1),
            todayComplete: !todayRow?.incomplete, lastVerified: new Date(scope.now || Date.now()).toISOString() }, scope.today);
        return { history: next, changed: JSON.stringify(next) !== JSON.stringify(history), state: "verified", settled };
    }
    function recentDays(history, scope, count = 7) {
        const state = normalize(history, scope), today = key(scope.today);
        if (!today) return [];
        const forgiven = new Set(state.forgiven);
        const length = Math.max(1, Math.min(31, Number(count) || 7));
        const rows = [];
        for (let offset = length - 1; offset >= 0; offset--) {
            const date = time.shiftDateKey(today, -offset);
            const recorded = state.days[date];
            let outcome = "unknown";
            if (date === today) outcome = state.todayComplete ? "complete" : "pending";
            else if (state.since && date < state.since) outcome = "unknown";
            else if (recorded === CLEAR || recorded === NONE || (recorded === MISSED && forgiven.has(date))) outcome = "complete";
            else if (recorded === MISSED) outcome = "missed";
            rows.push({ date, outcome, today: date === today });
        }
        return rows;
    }
    function summarize(history, scope, tasks = []) {
        const state = normalize(history, scope), row = bucket(tasks, scope.timeZone).get(scope.today);
        if (!state.since) return { state: "unavailable", current: 0, since: null };
        return { state: state.todayComplete ? "verified" : "pending", current: state.current, best: state.best, since: state.startedAt,
            lastVerified: state.lastVerified, totalToday: row?.total || 0, completedToday: (row?.total || 0) - (row?.incomplete || 0),
            remainingTasks: (row?.tasks || []).map(task => ({ id: task.id, title: task.title, url: task.url })),
            week: recentDays(state, scope), forgiven: state.forgiven,
            lastMissed: Object.keys(state.days).filter(d => state.days[d] === MISSED && !state.forgiven.includes(d)).sort().at(-1) || null };
    }
    function freeze(history, scope) {
        const summary = summarize(history, scope);
        return summary.state === "unavailable" ? summary : { ...summary, state: "stale" };
    }
    function createHistoryCoordinator({ read, write } = {}) {
        let tail = Promise.resolve();
        function update(scope, derive, { isCurrent = () => true } = {}) {
            const operation = async () => {
                if (!isCurrent()) return { written: false, stale: true, history: null };
                const all = await read();
                if (!isCurrent()) return { written: false, stale: true, history: null };
                const keyForScope = scopeKey(scope);
                const result = await derive(all?.[keyForScope] || null);
                if (!result?.write || !result.history) return { written: false, stale: false, ...result };
                if (!isCurrent()) return { written: false, stale: true, history: null };
                await write({ ...(all && typeof all === "object" ? all : {}), [keyForScope]: result.history });
                return { written: true, stale: false, ...result };
            };
            const queued = tail.catch(() => {}).then(operation);
            tail = queued;
            queued.then(() => { if (tail === queued) tail = Promise.resolve(); }, () => { if (tail === queued) tail = Promise.resolve(); });
            return queued;
        }
        return Object.freeze({ update });
    }
    return Object.freeze({ POLICY_VERSION, HISTORY_VERSION, STORAGE_KEY, MAX_DAYS_PER_FETCH, SEED_DAYS, CLEAR, MISSED, NONE,
        scopeKey, empty, normalize, requiresSeed, seedWindow, plan, advance, recentDays, summarize, freeze, recalculate, createHistoryCoordinator });
}));
