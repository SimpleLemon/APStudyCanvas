(function (root, factory) {
    "use strict";
    const api = factory();
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasContent = Object.assign(root.APStudyCanvasContent || {}, { PlannerTasks: api });
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    // Plain text survives Canvas's rich-text sanitization and makes ownership
    // auditable without relying on an invisible DOM convention.
    const MARKER_PREFIX = "APSTUDYCANVAS_PLANNER_NOTE:";
    // Version 2 appends one compact, URL-safe metadata token to the same
    // marker line. Version 1 notes stay readable: their metadata resolves to
    // the documented defaults, so an upgrade never reinterprets old work.
    const MARKER_VERSION = 2;
    const MARKER_LINE = new RegExp(`^${MARKER_PREFIX}(\\d+):([a-z0-9_-]{8,64}):([01])(?::([A-Za-z0-9_-]{2,2048}))?$`, "i");
    const MAX_TITLE = 255;
    const MAX_DETAILS = 8000;
    const DATE = /^\d{4}-\d{2}-\d{2}$/;
    // User-facing task types carried by the extension marker. "task" is the
    // neutral default that version-1 notes resolve to.
    const TASK_TYPES = Object.freeze(["task", "assignment", "quiz", "discussion", "study", "custom"]);
    const PRIORITY_VALUES = Object.freeze(["low", "normal", "high"]);
    const CUSTOM_TYPE_MAX = 40;
    const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

    function utf8Bytes(value) {
        const source = String(value ?? "");
        if (typeof TextEncoder === "function") return Array.from(new TextEncoder().encode(source));
        const escaped = encodeURIComponent(source);
        const bytes = [];
        for (let index = 0; index < escaped.length; index += 1) {
            if (escaped[index] === "%") { bytes.push(parseInt(escaped.slice(index + 1, index + 3), 16)); index += 2; }
            else bytes.push(escaped.charCodeAt(index));
        }
        return bytes;
    }

    function utf8Text(bytes) {
        if (typeof TextDecoder === "function") return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
        let escaped = "";
        bytes.forEach((byte) => { escaped += `%${byte.toString(16).padStart(2, "0")}`; });
        return decodeURIComponent(escaped);
    }

    // A tiny self-contained base64url codec: no Buffer/btoa dependency, so the
    // same source runs in a content script and under node --test.
    function base64UrlEncode(value) {
        const bytes = utf8Bytes(value);
        let output = "";
        for (let index = 0; index < bytes.length; index += 3) {
            const first = bytes[index];
            const second = bytes[index + 1];
            const third = bytes[index + 2];
            output += BASE64URL[first >> 2];
            output += BASE64URL[((first & 3) << 4) | (second === undefined ? 0 : second >> 4)];
            output += second === undefined ? "" : BASE64URL[((second & 15) << 2) | (third === undefined ? 0 : third >> 6)];
            output += third === undefined ? "" : BASE64URL[third & 63];
        }
        return output;
    }

    function base64UrlDecode(value) {
        const cleaned = String(value || "");
        const bytes = [];
        let buffer = 0;
        let bits = 0;
        for (const character of cleaned) {
            const index = BASE64URL.indexOf(character);
            if (index < 0) return null;
            buffer = (buffer << 6) | index;
            bits += 6;
            if (bits >= 8) { bits -= 8; bytes.push((buffer >> bits) & 0xff); }
        }
        try { return utf8Text(bytes); } catch (error) { return null; }
    }

    function numericPoints(value) {
        if (value === null || value === undefined || value === "") return null;
        const numeric = Number(value);
        return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
    }

    function metaDefaults() {
        return Object.freeze({ type: "task", customType: "", priority: "", points: null });
    }

    // The single normalizer for extension task metadata: unknown or malformed
    // values collapse to the version-1 defaults instead of failing a write.
    function normalizeTaskMeta(value) {
        const source = value && typeof value === "object" ? value : {};
        const type = TASK_TYPES.includes(source.type) ? source.type : "task";
        const customType = type === "custom" ? cleanText(source.customType, CUSTOM_TYPE_MAX) : "";
        const priority = PRIORITY_VALUES.includes(source.priority) ? source.priority : "";
        const pointsSource = source.points && typeof source.points === "object" ? source.points : {};
        const earned = numericPoints(pointsSource.earned ?? source.earned);
        const possible = numericPoints(pointsSource.possible ?? source.possible);
        return Object.freeze({
            type,
            customType,
            priority,
            points: earned === null && possible === null ? null : Object.freeze({ earned, possible })
        });
    }

    function metaToken(meta) {
        const normalized = normalizeTaskMeta(meta);
        const payload = { t: normalized.type };
        if (normalized.customType) payload.c = normalized.customType;
        if (normalized.priority) payload.p = normalized.priority;
        if (normalized.points) {
            if (normalized.points.earned !== null) payload.e = normalized.points.earned;
            if (normalized.points.possible !== null) payload.o = normalized.points.possible;
        }
        return base64UrlEncode(JSON.stringify(payload));
    }

    function metaFromToken(token) {
        if (!token || token.length > 2048) return metaDefaults();
        const decoded = base64UrlDecode(token);
        if (!decoded || decoded.length > 512) return metaDefaults();
        let parsed;
        try { parsed = JSON.parse(decoded); } catch (error) { return metaDefaults(); }
        return normalizeTaskMeta({ type: parsed?.t, customType: parsed?.c, priority: parsed?.p, points: { earned: parsed?.e ?? null, possible: parsed?.o ?? null } });
    }
    // Reconciliation is a duplicate-prevention guard, not a history sync.
    // Canvas emits at most 100 notes per page, so cap the bounded read at five
    // same-origin pages and leave the outcome uncertain beyond that point.
    const RECONCILE_PAGE_LIMIT = 5;

    function cleanText(value, max, fallback = "") {
        if (typeof value !== "string") return fallback;
        return value.replace(/[\u0000-\u001f\u007f]/g, (character) => character === "\n" ? "\n" : "").trim().slice(0, max) || fallback;
    }
    function safeLink(value) {
        if (!value) return null;
        try {
            const url = new URL(String(value));
            return url.protocol === "https:" && !url.username && !url.password && !url.hash ? url.href : null;
        } catch (error) { return null; }
    }
    function stableId(value) {
        const candidate = String(value || "").trim().toLowerCase();
        return /^[a-z0-9][a-z0-9_-]{7,63}$/.test(candidate) ? candidate : null;
    }
    function makeStableId(random = Math.random) {
        const segment = () => Math.floor(Math.max(0, Math.min(.999999999999, Number(random()) || 0)) * 0x100000000).toString(36).padStart(7, "0");
        return `pt-${segment()}${segment()}-${segment()}`;
    }
    function marker(metadata) {
        return `${MARKER_PREFIX}${MARKER_VERSION}:${metadata.id}:${metadata.completed ? "1" : "0"}:${metaToken(metadata.meta)}`;
    }
    function parseMarkerLine(line) {
        const match = String(line || "").trim().match(MARKER_LINE);
        if (!match) return null;
        const version = Number(match[1]);
        // A future marker version is not an owned note for this build: fail
        // closed (read-only) rather than guess at its format.
        if (!Number.isInteger(version) || version < 1 || version > MARKER_VERSION) return null;
        return Object.freeze({
            version,
            id: match[2].toLowerCase(),
            completed: match[3] === "1",
            meta: version >= 2 && match[4] ? metaFromToken(match[4]) : metaDefaults()
        });
    }
    function parseMarker(details) {
        for (const line of String(details || "").split(/\r?\n/)) {
            const parsed = parseMarkerLine(line);
            if (parsed) return parsed;
        }
        return null;
    }
    function stripMarkerLines(source) {
        return String(source || "").split(/\r?\n/).filter((line) => !MARKER_LINE.test(line.trim())).join("\n");
    }
    function splitDetails(details) {
        const source = String(details || "");
        const metadata = parseMarker(source);
        if (!metadata) return { metadata: null, description: cleanText(source, MAX_DETAILS), link: null };
        const withoutMarker = cleanText(stripMarkerLines(source), MAX_DETAILS);
        const linkMatch = withoutMarker.match(/(?:^|\n\n)Link: (https:\/\/[^\n]+)(?:$|\n\n)/);
        const link = safeLink(linkMatch?.[1]);
        return { metadata, description: cleanText(link && linkMatch ? withoutMarker.replace(linkMatch[0], "\n\n") : withoutMarker, MAX_DETAILS), link };
    }
    function encodeDetails({ description, id, completed = false, link, meta }) {
        const markerLine = marker({ id, completed: completed === true, meta });
        const head = [cleanText(description, MAX_DETAILS), safeLink(link) ? `Link: ${safeLink(link)}` : null].filter(Boolean).join("\n\n");
        // The ownership marker is never the part that gets truncated: it is
        // appended after the human-readable budget is bounded.
        const budget = Math.max(0, MAX_DETAILS - markerLine.length - 2);
        const bounded = head.length > budget ? head.slice(0, budget).replace(/\s+$/, "") : head;
        return bounded ? `${bounded}\n\n${markerLine}` : markerLine;
    }
    function owned(note) { return Boolean(parseMarker(note?.details)); }
    function plannerPath(origin, id) {
        try {
            const url = new URL("/api/v1/planner_notes", origin);
            if (id !== undefined && id !== null && String(id).trim()) url.pathname += `/${encodeURIComponent(String(id).trim())}`;
            return url.href;
        } catch (error) { return null; }
    }
    function sameHttpsOrigin(origin, documentRef) {
        try {
            const target = new URL(String(origin || ""));
            const page = new URL(String(documentRef?.location?.href || documentRef?.location?.origin || ""));
            return target.protocol === "https:" && !target.username && !target.password && target.origin === page.origin ? target.origin : null;
        } catch (error) { return null; }
    }
    function plannerNoteId(value) {
        const id = String(value ?? "").trim();
        return /^\d{1,20}$/.test(id) ? id : null;
    }
    function csrfToken(documentRef) {
        const match = String(documentRef?.cookie || "").match(/(?:^|;\s*)_csrf_token=([^;]*)/);
        let cookie = "";
        try { cookie = match ? decodeURIComponent(match[1]) : ""; } catch (error) {}
        // Canvas exposes the same Rails token in its document head on some
        // deployments. Content scripts share the document but not page-world
        // JavaScript state, so read only this declarative, same-document
        // fallback rather than injecting a page-world bridge.
        let meta = "";
        try {
            const node = documentRef?.querySelector?.('meta[name="csrf-token"], meta[name="csrf_token"]');
            meta = node?.getAttribute?.("content") || node?.content || "";
        } catch (error) {}
        const token = String(cookie || meta || "").trim();
        return token && token.length <= 512 && !/[\r\n]/.test(token) ? token : "";
    }
    function normalizeDraft(draft, { random } = {}) {
        const title = cleanText(draft?.title, MAX_TITLE);
        const todoDate = String(draft?.todoDate || draft?.todo_date || "");
        const id = stableId(draft?.stableId || draft?.id) || makeStableId(random);
        if (!title) return { ok: false, error: { code: "PLANNER_TITLE_REQUIRED", message: "A planner task needs a title." } };
        if (!DATE.test(todoDate)) return { ok: false, error: { code: "PLANNER_DATE_INVALID", message: "Choose a valid due date." } };
        const courseId = draft?.courseId === undefined || draft?.courseId === null || String(draft.courseId).trim() === "" ? null : String(draft.courseId).trim();
        if (courseId && !/^\d+$/.test(courseId)) return { ok: false, error: { code: "PLANNER_COURSE_INVALID", message: "Choose an available Canvas course." } };
        const link = safeLink(draft?.link);
        if (draft?.link && !link) return { ok: false, error: { code: "PLANNER_LINK_INVALID", message: "Links must be secure HTTPS URLs." } };
        const meta = normalizeTaskMeta(draft);
        return { ok: true, value: Object.freeze({ title, todo_date: todoDate, ...(courseId ? { course_id: courseId } : {}), details: encodeDetails({ description: draft?.description, id, completed: draft?.completed === true, link, meta }), stableId: id, meta }) };
    }
    const SAFE_HTTP_DETAILS = Object.freeze({
        "Invalid request.": "Canvas rejected the task details.",
        "Unauthorized.": "Canvas needs you to sign in again.",
        "Forbidden.": "Canvas denied this planner request.",
        "Not Found.": "Canvas could not find that planner task."
    });
    const SAFE_HTTP_CODES = new Set(["invalid_request", "unauthorized", "forbidden", "not_found"]);
    function responseError(response, fallback) {
        const source = response?.body?.error || response?.body?.errors || response?.body || {};
        const status = httpStatus(response);
        const serverCode = String(source?.code || "").trim();
        const detail = SAFE_HTTP_DETAILS[String(source?.message || "").trim()] || "Canvas rejected the planner request.";
        return {
            code: SAFE_HTTP_CODES.has(serverCode) ? serverCode : fallback,
            ...(status === null ? {} : { status }),
            // Never let a response body contradict or replace the authenticated
            // outer HTTP status (for example, a body that claims “status 0”).
            message: `${detail} (HTTP ${status === null ? "unknown" : status}).`
        };
    }
    function ambiguousCreateStatus(status) {
        return status === 408 || (Number.isInteger(status) && status >= 500 && status <= 599);
    }
    function httpStatus(response) {
        const status = Number(response?.status);
        return Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
    }
    function networkFailure(method, options = {}) {
        return {
            ok: false,
            state: "network",
            indeterminate: method === "POST",
            recoverable: true,
            error: {
                code: options.code || "CANVAS_PLANNER_NOTE_NETWORK_UNAVAILABLE",
                message: options.message || "Canvas could not reach the planner service. Check your connection, then retry.",
                ...(options.diagnostic ? { diagnostic: options.diagnostic } : {})
            }
        };
    }
    function preDispatchFailure(method, diagnostic = "") {
        const messages = {
            POST: "This task wasn’t sent to Canvas. Check your connection or reload Canvas, then try again.",
            PUT: "Your changes weren’t sent to Canvas. Check your connection or reload Canvas, then try again.",
            DELETE: "The task wasn’t deleted in Canvas. Check your connection or reload Canvas, then try again."
        };
        return {
            ok: false,
            state: "unavailable",
            indeterminate: false,
            recoverable: true,
            error: {
                code: "CANVAS_PLANNER_PRE_DISPATCH_UNAVAILABLE",
                message: messages[method] || "Canvas planner is unavailable. Check your connection or reload Canvas, then try again.",
                ...(diagnostic ? { diagnostic, phase: "pre-dispatch" } : {})
            }
        };
    }
    function nextPageUrl(response, currentUrl, pageOrigin) {
        const header = response?.headers?.get?.("link") || response?.headers?.get?.("Link") || "";
        const links = String(header).matchAll(/<([^>]+)>\s*((?:;\s*[^,;]+)*)/g);
        const match = Array.from(links).find((entry) => /(?:^|;)\s*rel\s*=\s*(?:"[^"]*\bnext\b[^"]*"|next)\s*(?:;|$)/i.test(entry[2]));
        if (!match) return { ok: true, url: null };
        try {
            const next = new URL(match[1], currentUrl);
            const expected = new URL(plannerPath(pageOrigin));
            if (next.origin !== pageOrigin || next.pathname !== expected.pathname || next.searchParams.get("start_date") !== currentUrl.searchParams.get("start_date") || next.searchParams.get("end_date") !== currentUrl.searchParams.get("end_date")) return { ok: false };
            return { ok: true, url: next };
        } catch (error) { return { ok: false }; }
    }
    function canvasPayload(value) {
        return Object.freeze({
            title: value.title,
            todo_date: value.todo_date,
            ...(value.course_id ? { course_id: value.course_id } : {}),
            details: value.details
        });
    }
    function mergeOwnedDraft(note, draft = {}) {
        const parsed = parseMarker(note?.details);
        if (!parsed) return null;
        const parts = splitDetails(note.details);
        const has = (key) => Object.prototype.hasOwnProperty.call(draft, key);
        return {
            title: has("title") ? draft.title : note.title,
            todoDate: has("todoDate") || has("todo_date") ? (draft.todoDate || draft.todo_date) : note.todo_date,
            courseId: has("courseId") || has("course_id") ? (draft.courseId ?? draft.course_id) : note.course_id,
            description: has("description") ? draft.description : parts.description,
            link: has("link") ? draft.link : parts.link,
            completed: has("completed") ? draft.completed === true : parsed.completed,
            stableId: parsed.id,
            type: has("type") ? draft.type : parsed.meta.type,
            customType: has("customType") ? draft.customType : parsed.meta.customType,
            priority: has("priority") ? draft.priority : parsed.meta.priority,
            points: has("points") ? draft.points : parsed.meta.points
        };
    }
    function createTransport({ fetchImpl = (...args) => fetch(...args), origin, document: documentRef = globalThis.document, enabled = false } = {}) {
        let controller = null;
        let disposed = false;
        const inFlight = new Map();
        const createOutcomes = new Map();
        function unavailable() { return { ok: false, state: "disabled", error: { code: "PLANNER_TASKS_DISABLED", message: "Canvas planner tasks are not enabled for this account yet." } }; }
        async function request(method, path, body, signal) {
            if (!enabled) return unavailable();
            if (disposed) return { ok: false, state: "aborted", error: { code: "PLANNER_REQUEST_ABORTED", message: "The planner request was cancelled." } };
            if (signal?.aborted) return { ok: false, state: "aborted", error: { code: "PLANNER_REQUEST_ABORTED", message: "The planner request was cancelled." } };
            const pageOrigin = sameHttpsOrigin(origin, documentRef);
            const id = method === "POST" ? null : plannerNoteId(path);
            const url = pageOrigin && (method === "POST" || id) ? plannerPath(pageOrigin, id) : null;
            const token = csrfToken(documentRef);
            if (!pageOrigin) return { ok: false, state: "unavailable", error: { code: "CANVAS_ORIGIN_UNAVAILABLE", message: "Reload Canvas, then try again." } };
            if (method !== "POST" && !id) return { ok: false, state: "validation", error: { code: "PLANNER_NOTE_ID_INVALID", message: "This Canvas planner note has an invalid identifier." } };
            if (!url || !token) return { ok: false, state: "unavailable", error: { code: "CANVAS_SESSION_TOKEN_UNAVAILABLE", message: "Reload Canvas, then try again." } };
            controller?.abort(); controller = new AbortController();
            const active = controller;
            const abort = () => active.abort(); signal?.addEventListener?.("abort", abort, { once: true });
            try {
                const response = await fetchImpl(url, { method, credentials: "include", cache: "no-store", signal: active.signal, headers: { Accept: "application/json", "Content-Type": "application/json", "X-CSRF-Token": token }, ...(body ? { body: JSON.stringify(canvasPayload(body)) } : {}) });
                // Fetch rejects network failures. A status of zero is likewise
                // not an HTTP response (for example, an opaque/blocked
                // response supplied by a browser boundary), so never display
                // it as a Canvas HTTP failure.
                const status = httpStatus(response);
                if (status === null) return networkFailure(method);
                const parsed = await response.json().catch(() => ({}));
                const result = { ok: status >= 200 && status < 300, status, body: parsed };
                return result.ok ? result : {
                    ...result,
                    state: "error",
                    // A timeout or server failure can arrive after Canvas has
                    // committed the POST. Keep its marker until a read proves
                    // the outcome; validation/auth failures are definitive.
                    indeterminate: method === "POST" && ambiguousCreateStatus(response.status),
                    error: responseError(result, `CANVAS_PLANNER_NOTE_${method}_FAILED`)
                };
            } catch (error) {
                if (["CANVAS_PLANNER_PRE_DISPATCH_UNAVAILABLE", "CANVAS_PLANNER_PAGE_PRE_DISPATCH_UNAVAILABLE"].includes(error?.code) && error?.phase === "pre-dispatch" && error?.indeterminate === false) return preDispatchFailure(method, error.diagnostic);
                if (error?.code === "CANVAS_PLANNER_MAIN_EXECUTION_FAILED") return networkFailure(method, {
                    code: "CANVAS_PLANNER_MAIN_EXECUTION_FAILED",
                    message: "Canvas could not complete the planner request. Check Canvas, then try again.",
                    diagnostic: /^[A-Z0-9-]{4,32}$/.test(String(error.diagnostic || "")) ? error.diagnostic : "PBR-UNKNOWN"
                });
                return error?.name === "AbortError"
                    ? { ok: false, state: "aborted", indeterminate: method === "POST", error: { code: "PLANNER_REQUEST_ABORTED", message: "The planner request was cancelled." } }
                    : networkFailure(method);
            } finally { signal?.removeEventListener?.("abort", abort); if (controller === active) controller = null; }
        }
        async function reconcileCreate(stableIdValue, todoDate, signal) {
            if (disposed || signal?.aborted) return { ok: false, state: "aborted" };
            const pageOrigin = sameHttpsOrigin(origin, documentRef);
            if (!pageOrigin || !DATE.test(String(todoDate || ""))) return { ok: false, state: "unavailable" };
            let url = new URL(plannerPath(pageOrigin));
            url.searchParams.set("start_date", todoDate);
            url.searchParams.set("end_date", todoDate);
            url.searchParams.set("per_page", "100");
            controller?.abort(); controller = new AbortController();
            const active = controller;
            const abort = () => active.abort(); signal?.addEventListener?.("abort", abort, { once: true });
            try {
                for (let page = 0; page < RECONCILE_PAGE_LIMIT; page += 1) {
                    const response = await fetchImpl(url.href, { method: "GET", credentials: "include", cache: "no-store", signal: active.signal, headers: { Accept: "application/json" } });
                    if (!response.ok) return { ok: false, state: "error", status: response.status };
                    const body = await response.json().catch(() => null);
                    if (!Array.isArray(body)) return { ok: false, state: "error" };
                    const note = body.find((candidate) => parseMarker(candidate?.details)?.id === stableIdValue) || null;
                    if (note) return { ok: true, state: "found", note };
                    const next = nextPageUrl(response, url, pageOrigin);
                    if (!next.ok) return { ok: false, state: "incomplete" };
                    if (next.url) { url = next.url; continue; }
                    // Only a short final page proves that no further matching
                    // note exists. A full page without a valid next link is
                    // incomplete rather than an absence assertion.
                    return body.length < 100 ? { ok: true, state: "absent", note: null } : { ok: false, state: "incomplete" };
                }
                return { ok: false, state: "incomplete" };
            } catch (error) {
                return { ok: false, state: error?.name === "AbortError" ? "aborted" : "error" };
            } finally {
                signal?.removeEventListener?.("abort", abort);
                if (controller === active) controller = null;
            }
        }
        function bridgeContext(result) {
            return result?.error?.code === "CANVAS_PLANNER_MAIN_EXECUTION_FAILED"
                ? { diagnostic: /^[A-Z0-9-]{4,32}$/.test(String(result.error.diagnostic || "")) ? result.error.diagnostic : "PBR-UNKNOWN", phase: "main-world" }
                : {};
        }
        function uncertainResult(context = {}) {
            return { ok: false, state: "outcome-uncertain", retryBlocked: true, error: { code: "PLANNER_CREATE_OUTCOME_UNCERTAIN", message: "Canvas may have created this task, but APStudyCanvas could not verify the result. Retry checks Canvas first and will not create a duplicate.", ...(context.diagnostic ? { diagnostic: context.diagnostic, phase: context.phase || "main-world" } : {}) } };
        }
        function confirmedAbsentResult(context = {}) {
            return { ok: false, state: "confirmed-absent", retryBlocked: false, error: { code: "PLANNER_CREATE_CONFIRMED_ABSENT", message: "Canvas confirmed that the task was not created. Retry is safe.", ...(context.diagnostic ? { diagnostic: context.diagnostic, phase: context.phase || "main-world" } : {}) } };
        }
        async function runCreate(normalized, options) {
            const stableIdValue = normalized.value.stableId;
            const fingerprint = JSON.stringify(canvasPayload(normalized.value));
            const prior = createOutcomes.get(stableIdValue);
            if (prior && prior.fingerprint !== fingerprint) return { ok: false, state: "conflict", retryBlocked: true, error: { code: "PLANNER_CREATE_OPERATION_CONFLICT", message: "This pending task changed before Canvas confirmed its outcome. Keep the draft open and reload Canvas." } };
            if (prior?.state === "uncertain") {
                const check = await reconcileCreate(stableIdValue, normalized.value.todo_date, options.signal);
                if (!check.ok) return uncertainResult(prior);
                if (check.note) { createOutcomes.delete(stableIdValue); return { ok: true, state: "reconciled", status: 200, body: check.note, reconciled: true }; }
                createOutcomes.set(stableIdValue, { state: "confirmed-absent", fingerprint, diagnostic: prior.diagnostic, phase: prior.phase });
            }
            const result = await request("POST", "", normalized.value, options.signal);
            if (result.ok) { createOutcomes.delete(stableIdValue); return result; }
            if (!result.indeterminate) { createOutcomes.delete(stableIdValue); return result; }
            if (disposed) {
                const context = bridgeContext(result);
                createOutcomes.set(stableIdValue, { state: "uncertain", fingerprint, ...context });
                return uncertainResult(context);
            }
            const check = await reconcileCreate(stableIdValue, normalized.value.todo_date, options.signal);
            if (check.ok && check.note) { createOutcomes.delete(stableIdValue); return { ok: true, state: "reconciled", status: 200, body: check.note, reconciled: true }; }
            if (check.ok && check.state === "absent") {
                const context = bridgeContext(result);
                createOutcomes.set(stableIdValue, { state: "confirmed-absent", fingerprint, ...context });
                return confirmedAbsentResult(context);
            }
            const context = bridgeContext(result);
            createOutcomes.set(stableIdValue, { state: "uncertain", fingerprint, ...context });
            return uncertainResult(context);
        }
        function create(draft, options = {}) {
            const normalized = normalizeDraft(draft, options);
            if (!normalized.ok) return { ok: false, state: "validation", error: normalized.error };
            // A modal click and its form submit can arrive in the same event
            // turn. Reuse that exact request rather than creating two Canvas
            // notes; the stable marker is also retained for a later retry.
            const key = `POST:${normalized.value.stableId}`;
            if (inFlight.has(key)) return inFlight.get(key);
            const pending = runCreate(normalized, options).finally(() => inFlight.delete(key));
            inFlight.set(key, pending);
            return pending;
        }
        async function update(note, draft, options = {}) {
            if (!owned(note)) return { ok: false, state: "forbidden", error: { code: "PLANNER_NOTE_NOT_OWNED", message: "Only APStudy-created planner notes can be changed." } };
            const normalized = normalizeDraft(mergeOwnedDraft(note, draft), options);
            return normalized.ok ? request("PUT", note.id, normalized.value, options.signal) : { ok: false, state: "validation", error: normalized.error };
        }
        async function remove(note, options = {}) {
            if (!owned(note)) return { ok: false, state: "forbidden", error: { code: "PLANNER_NOTE_NOT_OWNED", message: "Only APStudy-created planner notes can be deleted." } };
            return request("DELETE", note?.id, null, options.signal);
        }
        function dispose() { disposed = true; controller?.abort(); controller = null; inFlight.clear(); }
        return Object.freeze({ create, update, remove, dispose, enabled: Boolean(enabled) });
    }

    return Object.freeze({ MARKER_PREFIX, MARKER_VERSION, TASK_TYPES, PRIORITY_VALUES, CUSTOM_TYPE_MAX, parseMarker, splitDetails, encodeDetails, normalizeTaskMeta, owned, plannerPath, csrfToken, normalizeDraft, makeStableId, mergeOwnedDraft, createTransport });
}));
