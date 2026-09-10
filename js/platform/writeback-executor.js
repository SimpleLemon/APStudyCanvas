(function (root, factory) {
    "use strict";
    const identity = root?.APStudyCanvasCanvasAdapter?.Identity || (typeof require === "function" ? require("../canvas-adapter/identity.js") : null);
    const api = factory(identity);
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasPlatform = Object.assign(root.APStudyCanvasPlatform || {}, { WritebackExecutor: api });
}(globalThis, function (identity) {
    "use strict";
    function normalizePayload(kind, payload, operation) {
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
        const allowed = kind === "user" ? ["title", "description", "start_at", "end_at", "all_day", "location_name", "location_address"] : ["title", "details", "todo_date"];
        if (Object.keys(payload).some(key => !allowed.includes(key)) || (operation === "delete" && Object.keys(payload).length)) return null;
        const result = {};
        for (const [key, value] of Object.entries(payload)) {
            if (key === "all_day") { if (typeof value !== "boolean") return null; }
            else if (typeof value !== "string" || value.length > (key === "description" || key === "details" ? 8192 : 512)) return null;
            if (["start_at", "end_at", "todo_date"].includes(key)) {
                if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/.test(value) || Number(value.slice(11, 13)) > 23 || !Number.isFinite(Date.parse(value))) return null;
                const datePart = value.slice(0, 10);
                const day = new Date(`${datePart}T00:00:00Z`);
                if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== datePart) return null;
            }
            if (key === "title" && !value.trim()) return null;
            if (key === "todo_date" && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || new Date(value).toISOString().slice(0, 10) !== value)) return null;
            result[key] = value;
        }
        if (operation === "create" && (!result.title?.trim() || !(kind === "user" ? result.start_at : result.todo_date))) return null;
        return result;
    }
    // Serialized by scripting.executeScript; no outer lexical dependencies.
    async function pageOperation(input) {
        if (location.origin !== input.origin) return { state: "waiting_for_canvas_session", error_code: "CANVAS_ORIGIN_MISMATCH" };
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 12000);
        let dispatched = false;
        try {
            async function request(path, method = "GET", body) {
                const headers = { Accept: "application/json" };
                if (method !== "GET") {
                    const match = document.cookie.match(/(?:^|;\s*)_csrf_token=([^;]*)/);
                    const csrf = match ? decodeURIComponent(match[1]) : document.querySelector('meta[name="csrf-token"]')?.content;
                    if (!csrf || csrf.length > 512 || /[\r\n]/.test(csrf)) throw new Error("CSRF");
                    headers["X-CSRF-Token"] = csrf; headers["Content-Type"] = "application/json";
                    dispatched = true;
                }
                const response = await fetch(new URL(path, input.origin).href, { method, headers, credentials: "include", redirect: "error", cache: "no-store", signal: controller.signal, ...(body ? { body: JSON.stringify(body) } : {}) });
                const raw = await response.text();
                if (raw.length > 262144) throw new Error("SIZE");
                return { status: response.status, body: raw ? JSON.parse(raw) : null };
            }
            const profile = await request("/api/v1/users/self/profile");
            if (profile.status !== 200 || String(profile.body?.id) !== input.userId) return { state: "waiting_for_canvas_session", error_code: "CANVAS_ACCOUNT_MISMATCH" };
            if (input.inspect) return { state: "verified", userId: String(profile.body.id) };
            const path = input.kind === "user" ? "/api/v1/calendar_events" : "/api/v1/planner_notes";
            let current;
            if (input.operation !== "create") {
                current = await request(`${path}/${input.remoteId}`);
                if (current.status === 404 && input.operation === "delete" && input.reconcile) return { state: "applied", result_revision: "deleted" };
                if (current.status === 404) return { state: "conflict", error_code: "CANVAS_ITEM_MISSING", result_revision: "deleted", canvas_snapshot: { deleted: true } };
                if (current.status !== 200) return { state: current.status >= 500 ? "waiting_for_canvas_session" : "forbidden", error_code: `CANVAS_HTTP_${current.status}` };
                const item = current.body;
                if (input.kind === "user" ? item.context_code !== `user_${input.userId}` || item.appointment_group_id || item.parent_event_id : String(item.user_id) !== input.userId || item.course_id || item.linked_object_id) return { state: "forbidden", error_code: "CANVAS_PERSONAL_ITEM_REQUIRED" };
                const revision = String(item.updated_at || "");
                const canvas_snapshot = input.kind === "user"
                    ? { title: String(item.title || ""), description: String(item.description || ""), start: item.start_at || null, end: item.end_at || null, is_all_day: item.all_day === true }
                    : { title: String(item.title || ""), deadline_at: item.todo_date || null };

                if (input.operation === "observe") return { state: "observed", result_revision: revision, canvas_snapshot };
                const fields = input.kind === "user" ? input.payload : Object.fromEntries(Object.entries(input.payload).map(([k,v]) => [k === "details" ? "description" : k,v]));
                if (input.reconcile && input.operation === "update" && Object.entries(fields).every(([k,v]) => (k === "description" ? (item.details ?? item.description) : k === "todo_date" ? String(item[k] || "").slice(0, 10) : item[k]) === v)) return { state: "applied", result_revision: revision, remote_id: String(item.id) };
                if (input.reconcile) return { state: "conflict", error_code: "WRITEBACK_OUTCOME_UNCERTAIN", result_revision: revision, canvas_snapshot };
                if (!revision || revision !== input.expected_revision) return { state: "conflict", error_code: "WRITEBACK_REVISION_CONFLICT", result_revision: revision, canvas_snapshot };
            } else if (input.reconcile) return { state: "conflict", error_code: "WRITEBACK_CREATE_OUTCOME_UNCERTAIN" };
            const body = input.kind === "user" ? { calendar_event: { ...input.payload, ...(input.operation === "create" ? { context_code: `user_${input.userId}` } : {}) } } : input.payload;
            const result = await request(input.operation === "create" ? path : `${path}/${input.remoteId}`, { create: "POST", update: "PUT", delete: "DELETE" }[input.operation], input.operation === "delete" ? undefined : body);
            if (result.status >= 200 && result.status < 300) return { state: "applied", canvas_context_id: `user_${input.userId}`, remote_id: String(result.body?.id || input.remoteId || ""), result_revision: input.operation === "delete" ? "deleted" : String(result.body?.updated_at || "") };
            return { state: result.status >= 500 ? "uncertain" : result.status === 409 ? "conflict" : "forbidden", error_code: `CANVAS_HTTP_${result.status}` };
        } catch (_) { return { state: dispatched ? "uncertain" : "waiting_for_canvas_session", error_code: dispatched ? "WRITEBACK_OUTCOME_UNCERTAIN" : "CANVAS_SESSION_UNAVAILABLE" }; }
        finally { clearTimeout(timer); }
    }
    function createWritebackExecutor({ chromeApi, allowedOrigins } = {}) {
        async function execute(intent, { origin, accountKey, reconcile = false } = {}) {
            const origins = typeof allowedOrigins === "function" ? await allowedOrigins() : allowedOrigins;
            if (!origins?.includes(origin) || !chromeApi?.scripting?.executeScript) return { state: "waiting_for_canvas_session" };
            const tabs = await chromeApi.tabs.query({});
            for (const tab of tabs) {
                if (!Number.isSafeInteger(tab.id)) continue;
                try {
                    if (new URL(tab.url).origin !== origin) continue;
                    const context = await chromeApi.tabs.sendMessage(tab.id, { type: "GET_CANVAS_CONTEXT", version: 1, requestId: `writeback-${Date.now()}` }, { frameId: 0 });
                    const userId = String(context?.canvasUser?.id || "");
                    if (!context?.ok || context.origin !== origin || !/^[1-9]\d{0,19}$/.test(userId) || await identity.accountKey({ origin, userId }) !== accountKey) continue;
                    if (intent.target_calendar && intent.target_calendar !== `user_${userId}`) return { state: "forbidden", error_code: "CANVAS_PERSONAL_CALENDAR_REQUIRED" };
                    const result = await chromeApi.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, world: "MAIN", func: pageOperation, args: [{ ...intent, origin, userId, reconcile }] });
                    return result?.[0]?.result || { state: "uncertain", error_code: "WRITEBACK_OUTCOME_UNCERTAIN" };
                } catch (_) { return { state: "uncertain", error_code: "WRITEBACK_OUTCOME_UNCERTAIN" }; }
            }
            return { state: "waiting_for_canvas_session", error_code: "CANVAS_SESSION_UNAVAILABLE" };
        }
        return Object.freeze({ execute });
    }
    return Object.freeze({ normalizePayload, pageOperation, createWritebackExecutor });
}));
