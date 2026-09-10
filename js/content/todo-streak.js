(function (root, factory) {
    "use strict";
    const time = root?.APStudyCanvasContent?.TodoTime || (typeof require === "function" ? require("./todo-time.js") : null);
    const api = factory(time);
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasContent = Object.assign(root.APStudyCanvasContent || {}, { TodoStreak: api });
}(typeof globalThis !== "undefined" ? globalThis : this, function (time) {
    "use strict";

    // Policy 2 settles positively submitted Canvas work as complete. Old
    // policy-1 histories remain isolated rather than being reinterpreted.
    const POLICY_VERSION = 3;
    // History v1 was seeded from a planner feed that shipped Canvas's
    // `submissions: false` placeholder (no include[]=submissions), so its
    // settled days can wrongly read MISSED. v2 isolates that era: old records
    // normalize away and one fresh bounded seed runs against real submission
    // state, exactly like the policy-v1 isolation below.
    const HISTORY_VERSION = 3;
    // Storage is versioned independently from the record policy.  Policy-v1
    // histories must remain untouched instead of sharing a map with v2.
    const STORAGE_KEY = "todo_streak_history_v3";
    const MAX_DAYS_PER_FETCH = 90;
    const MAX_DAY_ENTRIES = 400;
    const CLEAR = "clear";
    const MISSED = "missed";
    const NONE = "none";

    function key(value) { return /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")) ? String(value) : null; }
    function scopeKey({ accountKey, timeZone, policyVersion = POLICY_VERSION } = {}) {
        return `${String(policyVersion)}:${String(accountKey || "").toLowerCase()}:${String(timeZone || "")}`;
    }
    function empty({ accountKey = "", timeZone = "", today = null } = {}) {
        return { v: HISTORY_VERSION, accountKey: String(accountKey).toLowerCase(), timeZone: String(timeZone), policyVersion: POLICY_VERSION, since: key(today), lastSettledDate: null, current: 0, best: 0, days: {} };
    }
    function normalize(history, scope = {}) {
        // Reading a missing/foreign record is not a tracking start. Only plan()
        // creates the first-run record after it has a trustworthy local date.
        const base = empty({ ...scope, today: null });
        if (!history || typeof history !== "object" || Array.isArray(history) || history.v !== HISTORY_VERSION
            || history.accountKey !== base.accountKey || history.timeZone !== base.timeZone || history.policyVersion !== POLICY_VERSION) return base;
        const days = {};
        Object.entries(history.days && typeof history.days === "object" ? history.days : {}).forEach(([date, state]) => {
            if (key(date) && [CLEAR, MISSED, NONE].includes(state)) days[date] = state;
        });
        return { ...base, since: key(history.since), lastSettledDate: key(history.lastSettledDate), current: Math.max(0, Number(history.current) || 0), best: Math.max(0, Number(history.best) || 0), days };
    }
    function trim(days) {
        const dates = Object.keys(days).sort();
        if (dates.length <= MAX_DAY_ENTRIES) return days;
        return Object.fromEntries(dates.slice(-MAX_DAY_ENTRIES).map((date) => [date, days[date]]));
    }
    function plan(history, scope) {
        const state = normalize(history, scope);
        const today = key(scope?.today);
        if (!today) return { state, range: null, reason: "clock-unavailable" };
        if (!state.since) return { state: empty({ ...scope, today }), range: null, reason: "first-run" };
        // A stored record that started tracking but never settled a single day
        // (the pre-seeding v2 shape: zero counts, no days) must not be pinned
        // at zero forever. It is classified as seed-required so the next
        // refresh routes it through the same bounded seed fetch as first run.
        // Anything with settled evidence — any day, any settled date, or a
        // nonzero count — keeps its history untouched.
        if (requiresSeedState(state)) return { state, range: null, reason: "seed-required" };
        const range = forwardRange(state, today);
        if (!range) return { state, range: null, reason: "current" };
        return { state, range: { ...range, timeZone: scope.timeZone }, reason: "advance" };
    }
    // The ordinary forward fetch window: the unsettled local days after the
    // last settled edge (or the tracking start), bounded to the same
    // MAX_DAYS_PER_FETCH cap as every other read and never reaching today.
    function forwardRange(state, today) {
        const yesterday = time.shiftDateKey(today, -1);
        const start = time.shiftDateKey(state.lastSettledDate || state.since, state.lastSettledDate ? 1 : 0);
        if (!start || !yesterday || start > yesterday) return null;
        const end = time.shiftDateKey(start, MAX_DAYS_PER_FETCH - 1);
        return { start, end: end && end < yesterday ? end : yesterday };
    }
    // Pure predicate over an already-normalized record: true only for v2
    // histories that began tracking but hold no settled evidence at all.
    // Settled v1/v2 histories and foreign records never qualify, so the
    // migration can never reinterpret existing history.
    function requiresSeedState(state) {
        if (!state || typeof state !== "object") return false;
        if (!state.since || state.lastSettledDate) return false;
        if (state.current !== 0 || state.best !== 0) return false;
        return !state.days || typeof state.days !== "object" || Array.isArray(state.days) || Object.keys(state.days).length === 0;
    }
    // Stored-state upgrade predicate: classifies a raw stored record for the
    // caller's scope without mutating it. Reading a missing or foreign record
    // is not a migration target.
    function requiresSeed(history, scope) {
        return requiresSeedState(normalize(history, scope));
    }
    // First-run seed read: the bounded window of settled local days ending
    // yesterday. Seeding lets one historical read establish qualifying
    // completion dates so an eligible user is not pinned at zero; today never
    // takes part, and the window never consults a selected Todo range.
    function seedWindow(scope) {
        const today = key(scope?.today);
        const yesterday = time.shiftDateKey(today, -1);
        if (!yesterday) return null;
        const start = time.shiftDateKey(yesterday, -(MAX_DAYS_PER_FETCH - 1));
        if (!start) return null;
        return { start, end: yesterday, timeZone: String(scope?.timeZone || "") };
    }
    // An explicit seed range is honored only inside the settled past: clamped
    // to at most MAX_DAYS_PER_FETCH local days and never reaching today.
    function clampSeedRange(range, today) {
        if (!range || typeof range !== "object") return null;
        const yesterday = time.shiftDateKey(today, -1);
        let start = key(range.start);
        let end = key(range.end);
        if (!start || !end || !yesterday) return null;
        if (end > yesterday) end = yesterday;
        const earliest = time.shiftDateKey(end, -(MAX_DAYS_PER_FETCH - 1));
        if (earliest && start < earliest) start = earliest;
        if (start > end) return null;
        return { start, end };
    }
    function bucket(tasks, timeZone) {
        const byDay = new Map();
        (Array.isArray(tasks) ? tasks : []).forEach((task) => {
            if (task?.source !== "canvas" || task?.type === "announcement") return;
            const date = time.dueDateKey(task?.due, timeZone);
            if (!date) return;
            const row = byDay.get(date) || { total: 0, incomplete: 0, late: false };
            row.total += 1;
            if (task.completion !== true) row.incomplete += 1;
            if (task.late === true) row.late = true;
            byDay.set(date, row);
        });
        return byDay;
    }
    // `complete` means the bounded Canvas read and normalization both covered
    // every item in the requested window. A partial read must never turn an
    // unknown date into a missed or clear date.
    function advance(history, tasks, scope, { complete = true, range: seedRange = null } = {}) {
        const planned = plan(history, scope);
        if (!complete) return { history: planned.state, changed: false, settled: 0, state: "partial" };
        // The seed path runs for a first-run record and for the stored-state
        // upgrade of an unseeded zero history (seed-required): both settle one
        // bounded historical read and then behave exactly like the forward
        // policy. A tracked record with settled evidence ignores the seed
        // entirely, so already settled days stay immutable and re-seeding is a
        // no-op.
        const seedable = planned.reason === "first-run" || planned.reason === "seed-required";
        const seed = seedable ? clampSeedRange(seedRange, key(scope?.today)) : null;
        // A seedable plan with no usable seed window still settles forward
        // from its tracking start: a freshly planned zero history and an
        // unseeded record advance through the ordinary policy instead of
        // being pinned. The integration routes both reasons through the
        // dedicated seed window; this fallback only covers direct advances
        // that carry no seed read, so migration targeting is unchanged.
        let range = seed ? { ...seed, timeZone: scope.timeZone } : planned.range;
        if (!range && seedable) {
            const forward = forwardRange(planned.state, key(scope?.today));
            if (forward) range = { ...forward, timeZone: scope.timeZone };
        }
        if (!range) return { history: planned.state, changed: JSON.stringify(planned.state) !== JSON.stringify(history || null), settled: 0, state: planned.reason === "clock-unavailable" ? "unavailable" : "tracking" };
        const days = { ...planned.state.days };
        const byDay = bucket(tasks, scope.timeZone);
        let current = planned.state.current;
        let best = planned.state.best;
        let cursor = range.start;
        let settled = 0;
        while (cursor && cursor <= range.end && settled < MAX_DAYS_PER_FETCH) {
            if (!days[cursor]) {
                const entries = byDay.get(cursor);
                // A streak records qualifying due-work days. Days without due
                // work do not add a point or break it; unfinished or late
                // Canvas work resets it. Multiple clear assignments on one
                // day still add one day, never multiple streak points.
                if (entries?.incomplete || entries?.late) { days[cursor] = MISSED; current = 0; }
                else if (entries?.total) { days[cursor] = CLEAR; current += 1; best = Math.max(best, current); }
                else days[cursor] = NONE;
            }
            settled += 1;
            cursor = time.shiftDateKey(cursor, 1);
        }
        // First run adopts the seed window's start as its tracking start; a
        // seed-required upgrade keeps the stored record's own start because it
        // was already recorded for the user.
        const next = { ...planned.state, ...(seed && planned.reason === "first-run" ? { since: seed.start } : {}), current, best, lastSettledDate: range.end, days: trim(days) };
        return { history: next, changed: JSON.stringify(next) !== JSON.stringify(history || null), settled, state: "verified" };
    }
    function summarize(history, scope) {
        const state = normalize(history, scope);
        if (!state.since) return { state: "unavailable", current: 0, since: null };
        return { state: state.lastSettledDate ? "verified" : "tracking", current: state.current, since: state.since, best: state.best, noTaskDates: "skip" };
    }
    function freeze(history, scope) {
        const summary = summarize(history, scope);
        return summary.state === "verified" ? { ...summary, state: "stale" } : { state: "unavailable", current: 0, since: null };
    }

    // All scopes share one local-storage map, so serializing only a scope would
    // still allow two full-map writes to erase each other. Each operation reads
    // the map only after earlier writes settle, derives from that current scope,
    // and checks its caller's lifecycle fence before committing.
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
    return Object.freeze({ POLICY_VERSION, HISTORY_VERSION, STORAGE_KEY, MAX_DAYS_PER_FETCH, MAX_DAY_ENTRIES, CLEAR, MISSED, NONE, scopeKey, empty, normalize, requiresSeed, plan, seedWindow, advance, summarize, freeze, createHistoryCoordinator });
}));
