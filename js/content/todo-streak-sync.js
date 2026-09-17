(function (root, factory) {
    const api = factory();
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasContent = Object.assign(root.APStudyCanvasContent || {}, { TodoStreakSync: api });
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";
    function decode(value) {
        if (value?.ok !== true || value.contractVersion !== 1 || !value.history || !Array.isArray(value.history.days) || !Array.isArray(value.marks)) return null;
        return { ...value, history: { ...value.history, days: Object.fromEntries(value.history.days.map(row => [row.date, row.state])) } };
    }
    function observation(history, previous = {}) {
        return { since: history.since, lastSettledDate: history.lastSettledDate, todayComplete: history.todayComplete,
            days: Object.entries(history.days).filter(([d, state]) => d >= history.since && previous.days?.[d] !== state).map(([date, state]) => ({ date, state })) };
    }
    function create({ read, write, send }) {
        async function prepare(scope, { signal, isCurrent = () => true } = {}) {
            const payload = { accountKey: scope.accountKey, timeZone: scope.timeZone };
            const localKey = `todo-completion:${scope.accountKey}`;
            const metaKey = `todo-streak-sync:${scope.accountKey}:${scope.timeZone}`;
            const [local, meta] = await Promise.all([read(localKey), read(metaKey)]);
            // A browser that has never connected to Nest can still track
            // locally when its optional transport is unavailable.
            let response;
            try { response = await send("NEST_STREAK_GET", payload, { signal }); }
            catch (error) {
                if (signal?.aborted || error?.name === "AbortError") throw error;
                return { connected: false, state: meta?.nestUserId ? "pending" : "local" };
            }
            let remote = decode(response);
            const disconnected = ["NEST_SIGNED_OUT", "NEST_EXTENSION_SIGNED_OUT", "NEST_IDENTITY_MISMATCH", "CANVAS_ACCOUNT_BINDING_REQUIRED"].includes(response?.code);
            if (!remote || !isCurrent()) return { connected: false, state: !disconnected && meta?.nestUserId ? "pending" : "local" };
            const known = meta?.nestUserId === remote.nestUserId ? meta : null;
            const remoteMarks = Object.fromEntries(remote.marks.map(m => [m.id, m]));
            const changes = [];
            for (const [id, completed] of Object.entries(local || {})) {
                if (typeof completed !== "boolean") continue;
                const previous = known?.applied?.[id];
                // First connection imports only marks that the account has not seen.
                if (!known && remoteMarks[id]) continue;
                if (previous === completed) continue;
                const baseRevision = known?.revisions?.[id] || 0;
                // A newer server edit wins a stale offline edit to the same task.
                if ((remoteMarks[id]?.revision || 0) !== baseRevision) continue;
                changes.push({ id, completed, revision: baseRevision });
            }
            for (let i = 0; i < changes.length; i += 200) {
                const result = decode(await send("NEST_STREAK_SYNC", { ...payload, expectedRevision: remote.revision, marks: changes.slice(i, i + 200) }, { signal }));
                if (!result || !isCurrent()) return { connected: false, state: "pending" };
                remote = result;
            }
            const applied = Object.fromEntries(remote.marks.map(m => [m.id, m.completed]));
            const latest = await read(localKey) || {};
            if (!isCurrent()) return { connected: false, state: "pending" };
            // Preserve a checklist click that happened while the network read ran.
            const merged = { ...applied };
            for (const [id, value] of Object.entries(latest)) if (value !== local?.[id]) merged[id] = value;
            await write(localKey, merged);
            await write(metaKey, { nestUserId: remote.nestUserId, applied, revisions: Object.fromEntries(remote.marks.map(m => [m.id, m.revision])) });
            return { connected: true, state: "synced", remote, payload, localKey, applied };
        }
        async function publish(session, history, options) {
            const current = await read(session.localKey) || {};
            if (JSON.stringify(Object.entries(current).sort()) !== JSON.stringify(Object.entries(session.applied).sort())) return null;
            if (!options.isCurrent()) return null;
            return decode(await send("NEST_STREAK_SYNC", { ...session.payload, expectedRevision: session.remote.revision, history: observation(history, session.remote.history) }, options));
        }
        return Object.freeze({ prepare, publish });
    }
    return Object.freeze({ create, decode, observation });
}));
