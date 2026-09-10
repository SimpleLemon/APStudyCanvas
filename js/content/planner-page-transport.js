(function (root, factory) {
    "use strict";
    const api = factory();
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasContent = Object.assign(root.APStudyCanvasContent || {}, { PlannerPageTransport: api });
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";
    const KIND = "APSTUDYCANVAS_PLANNER_PAGE_REQUEST";
    const VERSION = 1;
    const sessionId = () => {
        try {
            if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID().replace(/-/g, "");
            if (typeof globalThis.crypto?.getRandomValues === "function" && typeof Uint8Array === "function") { const bytes = new Uint8Array(24); globalThis.crypto.getRandomValues(bytes); return Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 48); }
        } catch (_) {}
        return "";
    };
    const operationId = sessionId;
    function create({ runtime = globalThis.chrome?.runtime, origin = globalThis.location?.origin } = {}) {
        const session = sessionId(); let closed = false, openInFlight = null;
        // Chromium's Promise form and Brave's callback form have not always
        // advanced in lockstep. Settle from either shape exactly once.
        const message = (value) => new Promise((resolve) => {
            if (typeof runtime?.sendMessage !== "function") {
                resolve({ ok: false, status: 0, error: "PLANNER_BRIDGE_RUNTIME_UNAVAILABLE", diagnostic: "PBR-RUNTIME", preDispatch: "runtime" });
                return;
            }
            let settled = false;
            const finish = (reply) => {
                if (settled) return;
                settled = true;
                resolve(reply === undefined && runtime?.lastError
                    ? { ok: false, status: 0, error: "PLANNER_BRIDGE_RUNTIME_UNAVAILABLE", diagnostic: "PBR-RUNTIME", preDispatch: "runtime" }
                    : reply);
            };
            try {
                const returned = runtime.sendMessage({ kind: KIND, version: VERSION, session, ...value }, finish);
                if (returned && typeof returned.then === "function") returned.then(finish, () => finish({ ok: false, status: 0, error: "PLANNER_BRIDGE_RUNTIME_UNAVAILABLE", diagnostic: "PBR-RUNTIME", preDispatch: "runtime" }));
            } catch (_) {
                finish({ ok: false, status: 0, error: "PLANNER_BRIDGE_RUNTIME_UNAVAILABLE", diagnostic: "PBR-RUNTIME", preDispatch: "runtime" });
            }
        });
        function aborted() { return Object.assign(new Error("aborted"), { name: "AbortError" }); }
        function diagnostic(value, fallback = "PBR-UNKNOWN") { return /^[A-Z0-9-]{4,32}$/.test(String(value || "")) ? String(value) : fallback; }
        function preDispatchUnavailable(value = "PBR-PREDISPATCH") {
            return Object.assign(new TypeError("Canvas planner is unavailable before dispatch."), {
                code: "CANVAS_PLANNER_PRE_DISPATCH_UNAVAILABLE",
                phase: "pre-dispatch",
                indeterminate: false,
                diagnostic: diagnostic(value, "PBR-PREDISPATCH")
            });
        }
        function lostSession(reply) { return reply?.ok === false && reply?.status === 0 && reply?.error === "PLANNER_BRIDGE_FORBIDDEN" && reply?.preDispatch === "session"; }
        function unavailable(reply) {
            if (lostSession(reply)) return preDispatchUnavailable("PBR-SESSION");
            const error = new TypeError("Canvas planner request could not complete.");
            const replyDiagnostic = diagnostic(reply?.diagnostic, reply?.error === "PLANNER_BRIDGE_FORBIDDEN" ? "PBR-FORBIDDEN" : reply?.error === "PLANNER_BRIDGE_DUPLICATE" ? "PBR-DUPLICATE" : "PBR-UNKNOWN");
            const pagePreDispatch = reply?.error === "csrf" || reply?.error === "origin" || reply?.preDispatch === "runtime" || reply?.error === "PLANNER_BRIDGE_FORBIDDEN" || reply?.error === "PLANNER_BRIDGE_DUPLICATE";
            error.code = pagePreDispatch ? "CANVAS_PLANNER_PAGE_PRE_DISPATCH_UNAVAILABLE" : "CANVAS_PLANNER_MAIN_EXECUTION_FAILED";
            error.phase = pagePreDispatch ? "pre-dispatch" : "main-world";
            // A browser execution rejection, empty result, malformed result,
            // or post-dispatch page failure can occur after Canvas accepted a
            // POST. Preserve the domain's marker reconciliation invariant.
            error.indeterminate = !pagePreDispatch;
            error.diagnostic = replyDiagnostic;
            return error;
        }
        function raceAbort(promise, signal, cancel) {
            if (!signal) return promise;
            if (signal.aborted) { cancel(); return Promise.reject(aborted()); }
            return new Promise((resolve, reject) => {
                const onAbort = () => { cancel(); reject(aborted()); };
                signal.addEventListener("abort", onAbort, { once: true });
                promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
            });
        }
        function openSession() {
            if (closed) return Promise.reject(aborted());
            if (openInFlight) return openInFlight;
            const pending = Promise.resolve().then(() => message({ action: "open" })).then((reply) => {
                if (closed) {
                    message({ action: "close" }).catch(() => {});
                    throw aborted();
                }
                if (reply?.ok !== true) throw preDispatchUnavailable(diagnostic(reply?.diagnostic, reply?.preDispatch === "runtime" ? "PBR-RUNTIME" : "PBR-OPEN"));
                return reply;
            }).catch((error) => {
                if (error?.name === "AbortError" || error?.code === "CANVAS_PLANNER_PRE_DISPATCH_UNAVAILABLE") throw error;
                throw preDispatchUnavailable();
            });
            openInFlight = pending;
            pending.then(
                () => { if (openInFlight === pending) openInFlight = null; },
                () => { if (openInFlight === pending) openInFlight = null; }
            );
            return pending;
        }
        async function fetchImpl(url, options = {}) {
            if (closed || options.signal?.aborted) throw aborted();
            const parsed = new URL(url); const base = new URL("/api/v1/planner_notes", origin);
            if (parsed.origin !== base.origin || !parsed.pathname.startsWith(base.pathname)) throw new TypeError("planner path forbidden");
            const suffix = parsed.pathname.slice(base.pathname.length).replace(/^\//, "");
            const method = String(options.method || "GET").toUpperCase();
            const request = { method, ...(suffix ? { id: suffix } : {}), ...(method === "GET" ? { query: Object.fromEntries(parsed.searchParams) } : { body: options.body ? JSON.parse(options.body) : null }) };
            const operation = operationId();
            if (!operation) throw new TypeError("planner bridge unavailable");
            await raceAbort(openSession(), options.signal, () => {});
            if (closed || options.signal?.aborted) throw aborted();
            const send = () => raceAbort(message({ action: "request", operation, request }), options.signal, () => message({ action: "cancel", operation }).catch(() => {}));
            let reply = await send();
            // A missing worker-local binding is the only response that proves
            // the operation never reached MAIN or Canvas. Reopen once with the
            // same nonce and operation id; every other failure is ambiguous
            // and must flow to the planner's reconciliation policy unchanged.
            if (lostSession(reply)) {
                await raceAbort(openSession(), options.signal, () => {});
                if (closed || options.signal?.aborted) throw aborted();
                reply = await send();
            }
            if (!reply?.ok || !Number.isInteger(reply.status) || reply.status === 0) throw unavailable(reply);
            return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, headers: { get: (name) => reply.headers?.[String(name).toLowerCase()] || null }, json: async () => reply.body };
        }
        return Object.freeze({ fetchImpl, dispose() { closed = true; message({ action: "close" }).catch(() => {}); } });
    }
    return Object.freeze({ KIND, VERSION, create });
}));
