(function (root, factory) {
    "use strict";
    const api = factory();
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasPlatform = Object.assign(root.APStudyCanvasPlatform || {}, { ConnectionCoordinator: api });
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    function copy(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
    function freeze(value) {
        if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
        return value;
    }
    function bindingKey(binding) { return binding ? `${binding.origin || ""}:${binding.accountKey || binding.account_key || ""}` : ""; }

    function create({ readIdentity, normalizeIdentity, timeoutMs = 12000 } = {}) {
        if (typeof readIdentity !== "function" || typeof normalizeIdentity !== "function") throw new Error("CONNECTION_DEPENDENCIES_REQUIRED");
        let state = freeze({ generation: 0, identity: { state: "checking", profile: null, linkedAccounts: [] }, binding: null, consent: null, capabilities: null });
        let pending = null;
        let activeAbort = null;
        let disposed = false;
        const listeners = new Set();
        function publish(change) {
            if (disposed) return state;
            state = freeze({ ...state, ...copy(change) });
            for (const listener of listeners) { try { listener(state); } catch (_) { /* One view cannot block other subscribers. */ } }
            return state;
        }
        function invalidate(change = {}) {
            activeAbort?.abort();
            activeAbort = null;
            pending = null;
            return publish({ generation: state.generation + 1, consent: null, capabilities: null, ...change });
        }
        function refresh({ force = false } = {}) {
            if (disposed) return Promise.resolve(state);
            if (pending && !force) return pending;
            invalidate({ identity: { state: "checking", profile: null, linkedAccounts: [] } });
            const generation = state.generation;
            const abort = new AbortController();
            activeAbort = abort;
            let timer;
            const timed = new Promise((_, reject) => {
                abort.signal.addEventListener("abort", () => reject(new Error("NEST_REQUEST_ABORTED")), { once: true });
                timer = setTimeout(() => { abort.abort(); reject(new Error("NEST_REQUEST_TIMEOUT")); }, timeoutMs);
            });
            const operation = Promise.race([Promise.resolve().then(() => readIdentity({ signal: abort.signal })), timed])
                .then(normalizeIdentity)
                .catch((error) => ({ state: "unavailable", profile: null, linkedAccounts: [], code: error?.message || "NEST_UNAVAILABLE" }))
                .then((identity) => {
                    if (disposed || generation !== state.generation) return state;
                    const safeIdentity = identity?.state === "authenticated" ? identity : { ...identity, profile: null, linkedAccounts: [] };
                    return publish({ identity: safeIdentity, capabilities: safeIdentity.state === "authenticated" ? safeIdentity.capabilities || null : null });
                })
                .finally(() => {
                    clearTimeout(timer);
                    if (pending === operation) { pending = null; activeAbort = null; }
                });
            pending = operation;
            return operation;
        }
        return Object.freeze({
            getSnapshot: () => state,
            isCurrent: (generation) => !disposed && generation === state.generation,
            subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
            refresh,
            setContext(binding) {
                if (bindingKey(binding) === bindingKey(state.binding)) return state;
                return invalidate({ binding: copy(binding), identity: { state: "checking", profile: null, linkedAccounts: [] } });
            },
            update(change, generation = state.generation) {
                if (disposed || generation !== state.generation || state.identity.state !== "authenticated") return state;
                const patch = {};
                for (const key of ["consent", "capabilities"]) if (Object.prototype.hasOwnProperty.call(change || {}, key)) patch[key] = change[key];
                return publish(patch);
            },
            dispose() { activeAbort?.abort(); disposed = true; listeners.clear(); }
        });
    }
    return Object.freeze({ create });
}));
