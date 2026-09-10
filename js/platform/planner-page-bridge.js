(function (root, factory) {
    "use strict";
    const registration = root?.APStudyCanvasPlatform?.CanvasRegistration || (typeof require === "function" ? require("./canvas-registration.js") : null);
    const api = factory(registration);
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasPlatform = Object.assign(root.APStudyCanvasPlatform || {}, { PlannerPageBridge: api });
}(typeof globalThis !== "undefined" ? globalThis : this, function (registration) {
    "use strict";
    const KIND = "APSTUDYCANVAS_PLANNER_PAGE_REQUEST", VERSION = 1, TIMEOUT_MS = 12000, MAX_RESPONSE_BYTES = 256 * 1024, MAX_LINK_BYTES = 4096, MAX_CONTENT_TYPE_BYTES = 512;
    const SESSION = /^[a-z0-9_-]{24,160}$/i, OPERATION = /^[a-z0-9_-]{12,160}$/i, NOTE_ID = /^\d{1,20}$/, DATE = /^\d{4}-\d{2}-\d{2}$/;
    const STATIC_CANVAS_ORIGINS = Object.freeze(registration?.STATIC_CANVAS_ORIGINS || ["https://canvas.emory.edu"]);
    function validOrigin(value) { try { const u = new URL(String(value)); return u.protocol === "https:" && !u.username && !u.password && u.origin === value ? u.origin : null; } catch (_) { return null; } }
    function bytes(value) { try { return new TextEncoder().encode(String(value)).length; } catch (_) { return unescape(encodeURIComponent(String(value))).length; } }
    function plain(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
    function validBody(body) {
        if (body === undefined || body === null) return body === null;
        if (!plain(body) || !Object.keys(body).every((key) => ["title", "todo_date", "course_id", "details"].includes(key))) return false;
        return typeof body.title === "string" && body.title.length > 0 && body.title.length <= 255 && typeof body.todo_date === "string" && DATE.test(body.todo_date) && typeof body.details === "string" && body.details.length <= 8000 && (body.course_id === undefined || /^\d+$/.test(String(body.course_id)));
    }
    function validateRequest(request, origin) {
        if (!plain(request) || !Object.keys(request).every((key) => ["method", "id", "query", "body"].includes(key))) return null;
        const method = String(request.method || "").toUpperCase(), id = request.id === undefined ? null : String(request.id), query = request.query || null;
        if (!validOrigin(origin) || !["GET", "POST", "PUT", "DELETE"].includes(method)) return null;
        if (method === "GET") {
            if (id !== null || !plain(query) || !DATE.test(String(query.start_date)) || !DATE.test(String(query.end_date)) || String(query.per_page) !== "100" || (query.page !== undefined && (!/^\d{1,3}$/.test(String(query.page)) || Number(query.page) < 1 || Number(query.page) > 999))) return null;
        } else if ((method === "POST" && id !== null) || ((method === "PUT" || method === "DELETE") && !NOTE_ID.test(id)) || ((method === "POST" || method === "PUT") && !validBody(request.body)) || (method === "DELETE" && request.body !== null)) return null;
        return { method, id, query: method === "GET" ? { start_date: String(query.start_date), end_date: String(query.end_date), per_page: "100", ...(query.page ? { page: String(query.page) } : {}) } : null, body: method === "POST" || method === "PUT" ? request.body : null };
    }
    function bounded(value, depth = 0) {
        if (depth > 5) return undefined;
        if (value === null || ["number", "boolean"].includes(typeof value)) return value;
        if (typeof value === "string") return value.length <= 8192 ? value : undefined;
        if (Array.isArray(value)) return value.length <= 100 ? value.map((entry) => bounded(entry, depth + 1)) : undefined;
        if (!plain(value) || Object.keys(value).length > 40) return undefined;
        const result = {}; for (const [key, entry] of Object.entries(value)) { const output = bounded(entry, depth + 1); if (!/^[A-Za-z0-9_.-]{1,80}$/.test(key) || output === undefined) return undefined; result[key] = output; } return result;
    }
    const PAGE_FAILURES = Object.freeze(new Set(["origin", "csrf", "response_too_large", "response_malformed", "response_headers", "aborted", "network"]));
    function protocolError() { return { ok: false, status: 0, error: "PLANNER_BRIDGE_PROTOCOL", diagnostic: "PBR-PROTOCOL" }; }
    function pageFailure(error) {
        return PAGE_FAILURES.has(error)
            ? { ok: false, status: 0, error, diagnostic: `PBR-${error.replace(/[^a-z]/g, "").toUpperCase().slice(0, 16)}` }
            : protocolError();
    }
    // Keep browser exception text out of content/UI. These categories identify
    // the extension boundary that failed without exposing page URLs, cookies,
    // CSRF material, or browser-specific implementation details.
    function executionFailure(error, chromeApi) {
        const text = String(error?.message || chromeApi?.runtime?.lastError?.message || "").toLowerCase();
        const diagnostic = /permission|cannot access contents|host permission/.test(text) ? "PBR-PERMISSION"
            : /world|main/.test(text) ? "PBR-MAIN-UNAVAILABLE"
                : /serializ|clone|data clone/.test(text) ? "PBR-SERIALIZATION"
                    : "PBR-EXECUTION";
        try { console.warn("APStudyCanvas planner MAIN execution failed", diagnostic); } catch (_) {}
        return { ok: false, status: 0, error: "PLANNER_BRIDGE_EXECUTION", diagnostic };
    }
    function validateResponse(operation, response) {
        if (plain(response) && response.ok === false && response.status === 0) return pageFailure(String(response.error || ""));
        if (!plain(response) || response.ok !== true || !Number.isInteger(response.status) || response.status < 100 || response.status > 599) return protocolError();
        const success = response.status >= 200 && response.status < 300, body = bounded(response.body);
        if (body === undefined || bytes(JSON.stringify(body)) > MAX_RESPONSE_BYTES || (success && operation.method === "GET" && (!Array.isArray(body) || !body.every(plain))) || (success && ["POST", "PUT"].includes(operation.method) && !plain(body)) || (success && operation.method === "DELETE" && body !== null && !plain(body)) || (!success && body !== null && !plain(body))) return protocolError();
        const headers = plain(response.headers) ? response.headers : {}, link = headers.link, contentType = headers["content-type"];
        if ((link !== undefined && (typeof link !== "string" || bytes(link) > MAX_LINK_BYTES)) || (contentType !== undefined && (typeof contentType !== "string" || bytes(contentType) > MAX_CONTENT_TYPE_BYTES))) return protocolError();
        return { ok: true, status: response.status, body, headers: { link: link || "", "content-type": contentType || "" } };
    }
    async function pageRequest(operation, expectedOrigin, timeoutMs, session, operationId) {
        if (location.origin !== expectedOrigin) return { ok: false, status: 0, error: "origin" };
        const maxResponseBytes = 256 * 1024, maxLinkBytes = 4096, maxContentTypeBytes = 512;
        const measure = (value) => { try { return new TextEncoder().encode(String(value)).length; } catch (_) { return unescape(encodeURIComponent(String(value))).length; } };
        async function readLimited(response) {
            const reader = response.body?.getReader?.();
            if (!reader) { const raw = await response.text(); return measure(raw) <= maxResponseBytes ? raw : null; }
            const chunks = []; let total = 0;
            for (;;) { const next = await reader.read(); if (next.done) break; total += next.value.byteLength; if (total > maxResponseBytes) { await reader.cancel().catch(() => {}); return null; } chunks.push(next.value); }
            const output = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; } return new TextDecoder().decode(output);
        }
        const controllers = globalThis.__APSTUDYCANVAS_PLANNER_CONTROLLERS__ || (globalThis.__APSTUDYCANVAS_PLANNER_CONTROLLERS__ = new Map()), key = `${session}:${operationId}`, controller = new AbortController();
        controllers.set(key, controller); const url = new URL("/api/v1/planner_notes", location.origin); if (operation.id) url.pathname += `/${encodeURIComponent(operation.id)}`; if (operation.query) Object.entries(operation.query).forEach(([name, value]) => url.searchParams.set(name, value));
        const timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(Number(timeoutMs) || 12000, 12000)));
        try {
            const cookie = String(document.cookie || "").match(/(?:^|;\s*)_csrf_token=([^;]*)/); let csrf = ""; try { csrf = cookie ? decodeURIComponent(cookie[1]) : ""; } catch (_) {}
            if (!csrf) csrf = document.querySelector('meta[name="csrf-token"], meta[name="csrf_token"]')?.getAttribute("content") || "";
            if (["POST", "PUT", "DELETE"].includes(operation.method) && (!csrf || csrf.length > 512 || /[\r\n]/.test(csrf))) return { ok: false, status: 0, error: "csrf" };
            const headers = { Accept: "application/json" }; if (operation.body) headers["Content-Type"] = "application/json"; if (csrf && operation.method !== "GET") headers["X-CSRF-Token"] = csrf;
            const response = await fetch(url.href, { method: operation.method, credentials: "include", cache: "no-store", headers, ...(operation.body ? { body: JSON.stringify(operation.body) } : {}), signal: controller.signal });
            const declaredLength = Number(response.headers.get("content-length") || ""); if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) return { ok: false, status: 0, error: "response_too_large" };
            const raw = await readLimited(response); if (raw === null) return { ok: false, status: 0, error: "response_too_large" };
            let body; try { body = raw ? JSON.parse(raw) : null; } catch (_) { return { ok: false, status: 0, error: "response_malformed" }; }
            const link = response.headers.get("link") || "", contentType = response.headers.get("content-type") || ""; if (measure(link) > maxLinkBytes || measure(contentType) > maxContentTypeBytes) return { ok: false, status: 0, error: "response_headers" };
            return { ok: true, status: Number(response.status) || 0, body, headers: { link, "content-type": contentType } };
        } catch (error) { return { ok: false, status: 0, error: error?.name === "AbortError" ? "aborted" : "network" }; } finally { clearTimeout(timer); controllers.delete(key); }
    }
    function pageCancel(expectedOrigin, session, operationId) { if (location.origin !== expectedOrigin) return false; const controller = globalThis.__APSTUDYCANVAS_PLANNER_CONTROLLERS__?.get(`${session}:${operationId}`); if (controller) controller.abort(); return Boolean(controller); }
    function createPlannerPageBridge({ chromeApi = globalThis.chrome, timeoutMs = TIMEOUT_MS, allowedOrigins = STATIC_CANVAS_ORIGINS } = {}) {
        const sessions = new Map(), active = new Map();
        // Chromium provides a documentId for modern top-frame messages. Bind
        // operations to it when present so a same-origin navigation cannot
        // inherit a prior document's authorization. Older engines retain the
        // existing tab/top-frame binding.
        const documentKey = (sender) => typeof sender?.documentId === "string" && sender.documentId.length > 0 && sender.documentId.length <= 160 ? sender.documentId : "no-document-id";
        const key = (sender) => `${sender?.tab?.id}:${sender?.frameId || 0}:${documentKey(sender)}`;
        const targetFor = (sender) => ({ tabId: sender.tab.id, ...(documentKey(sender) === "no-document-id" ? { frameIds: [0] } : { documentIds: [sender.documentId] }) });
        function senderOrigin(sender) { try { const senderUrl = new URL(sender?.url || ""), tabUrl = new URL(sender?.tab?.url || ""); return senderUrl.origin === tabUrl.origin ? senderUrl.origin : null; } catch (_) { return null; } }
        async function authorized(origin) { const values = typeof allowedOrigins === "function" ? await allowedOrigins() : allowedOrigins; return Array.isArray(values) && values.includes(origin); }
        async function cancel(binding, sender, operationId) { const activeKey = `${key(sender)}:${binding.session}:${operationId}`, running = active.get(activeKey); if (!running) return { ok: true, cancelled: false }; running.cancelled = true; try { await chromeApi.scripting.executeScript({ target: targetFor(sender), world: "MAIN", func: pageCancel, args: [binding.origin, binding.session, operationId] }); } catch (_) {} return { ok: true, cancelled: true }; }
        async function endSession(sessionKey, binding, sender) {
            for (const operationId of Array.from(active.keys()).filter((entry) => entry.startsWith(`${sessionKey}:${binding.session}:`)).map((entry) => entry.split(":").at(-1))) await cancel(binding, sender, operationId);
            if (sessions.get(sessionKey) === binding) sessions.delete(sessionKey);
        }
        async function handle(message, sender) {
            if (!message || message.kind !== KIND || message.version !== VERSION || !sender?.tab?.id || sender.frameId !== 0) return null;
            const origin = senderOrigin(sender); if (!validOrigin(origin) || !SESSION.test(String(message.session || "")) || !await authorized(origin)) return { ok: false, error: "PLANNER_BRIDGE_FORBIDDEN" };
            const sessionKey = key(sender); if (message.action === "open") {
                const existing = sessions.get(sessionKey);
                if (existing && (existing.session !== message.session || existing.origin !== origin)) await endSession(sessionKey, existing, sender);
                sessions.set(sessionKey, { session: message.session, origin, documentId: documentKey(sender) }); return { ok: true };
            }
            const binding = sessions.get(sessionKey); if (!binding || binding.session !== message.session || binding.origin !== origin) return { ok: false, status: 0, error: "PLANNER_BRIDGE_FORBIDDEN", preDispatch: "session" };
            if (message.action === "close") { await endSession(sessionKey, binding, sender); return { ok: true }; }
            if (message.action === "cancel") return OPERATION.test(String(message.operation || "")) ? cancel(binding, sender, message.operation) : { ok: false, error: "PLANNER_BRIDGE_FORBIDDEN" };
            const operation = message.action === "request" ? validateRequest(message.request, origin) : null, operationId = String(message.operation || ""); if (!operation || !OPERATION.test(operationId) || !chromeApi?.scripting?.executeScript) return { ok: false, error: "PLANNER_BRIDGE_FORBIDDEN" };
            const activeKey = `${sessionKey}:${binding.session}:${operationId}`; if (active.has(activeKey)) return { ok: false, status: 0, error: "PLANNER_BRIDGE_DUPLICATE" }; const running = { cancelled: false }; active.set(activeKey, running);
            try {
                // `func` and args cross a browser serialization boundary. Keep
                // this direct extension-controlled invocation rather than a
                // static MAIN-world DOM listener: a host page can interfere
                // with static MAIN code and therefore cannot safely be given a
                // reusable request surface.
                const results = await chromeApi.scripting.executeScript({ target: targetFor(sender), world: "MAIN", func: pageRequest, args: [operation, origin, timeoutMs, binding.session, operationId] });
                if (running.cancelled) return pageFailure("aborted");
                if (!Array.isArray(results) || results.length === 0) return { ok: false, status: 0, error: "PLANNER_BRIDGE_EXECUTION", diagnostic: "PBR-EMPTY-RESULT" };
                if (!Object.prototype.hasOwnProperty.call(results[0] || {}, "result")) return { ok: false, status: 0, error: "PLANNER_BRIDGE_EXECUTION", diagnostic: "PBR-MISSING-RESULT" };
                return validateResponse(operation, results[0].result);
            } catch (error) { return executionFailure(error, chromeApi); } finally { active.delete(activeKey); }
        }
        function disposeTab(tabId) { for (const [sessionKey, binding] of sessions) if (sessionKey.startsWith(`${tabId}:`)) { const sender = { tab: { id: tabId, url: binding.origin }, url: binding.origin, frameId: 0, ...(binding.documentId !== "no-document-id" ? { documentId: binding.documentId } : {}) }; endSession(sessionKey, binding, sender).catch(() => {}); } }
        function dispose(sender) { const sessionKey = key(sender), binding = sessions.get(sessionKey); if (binding) endSession(sessionKey, binding, sender).catch(() => {}); }
        return Object.freeze({ handle, dispose, disposeTab, constants: Object.freeze({ KIND, VERSION, TIMEOUT_MS, MAX_RESPONSE_BYTES }) });
    }
    return Object.freeze({ KIND, VERSION, TIMEOUT_MS, MAX_RESPONSE_BYTES, STATIC_CANVAS_ORIGINS, validateRequest, validateResponse, pageRequest, pageCancel, executionFailure, createPlannerPageBridge });
}));
