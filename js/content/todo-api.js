(function (root, factory) {
    "use strict";
    const model = root?.APStudyCanvasContent?.TodoModel || (typeof require === "function" ? require("./todo-model.js") : null);
    const time = root?.APStudyCanvasContent?.TodoTime || (typeof require === "function" ? require("./todo-time.js") : null);
    const state = root?.APStudyCanvasContent?.TodoState || (typeof require === "function" ? require("./todo-state.js") : null);
    const api = factory(model, time, state);
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasContent = Object.assign(root.APStudyCanvasContent || {}, { TodoApi: api });
}(typeof globalThis !== "undefined" ? globalThis : this, function (model, time, state) {
    "use strict";

    const MAX_PAGES = 50;
    const ANNOUNCEMENT_MAX_PAGES = 100;
    const ANNOUNCEMENT_CONTEXT_BATCH_SIZE = 50;
    const PAGE_SIZE = 100;
    // A short read-only tail gives recent context without presenting an
    // unbounded announcement archive as part of the Todo surface.
    const RECENT_ANNOUNCEMENT_TAIL_MS = 14 * 86400000;

    function safeError(error, fallback = "TODO_OPERATION_FAILED") {
        return { code: String(error?.code || fallback).replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 80), ...(Number.isInteger(error?.status) ? { status: error.status } : {}), message: String(error?.message || "Task operation failed.").slice(0, 200) };
    }
    function responseError(response, fallback) {
        const error = response?.body?.error || response?.body?.errors || response?.error;
        return { code: error?.code || response?.body?.code || fallback, ...(Number.isInteger(response?.status) ? { status: response.status } : {}), message: String(error?.message || response?.body?.message || `Request failed with status ${response?.status || 0}.`).slice(0, 200) };
    }
    function successful(response) { return Boolean(response && response.ok !== false && Number(response.status) >= 200 && Number(response.status) < 300); }
    function bodyObject(response) { return response?.body && typeof response.body === "object" && !Array.isArray(response.body) ? response.body : null; }
    function bodyItems(body) { return Array.isArray(body?.todos) ? body.todos : Array.isArray(body?.list) ? body.list : Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : null; }

    function abortError() { return Object.assign(new Error("The planner request was aborted."), { name: "AbortError" }); }
    function isAbortError(error) { return error?.name === "AbortError"; }

    function nextPage(body, currentPage) {
        const pagination = body?.pagination || {};
        if (pagination.next === true || body?.has_more === true || body?.hasMore === true) return { page: currentPage + 1 };
        if (Number.isInteger(Number(body?.next_offset))) return { offset: Number(body.next_offset) };
        if (Number.isInteger(Number(pagination.next_offset))) return { offset: Number(pagination.next_offset) };
        if (typeof pagination.next === "number") return { page: pagination.next };
        return null;
    }

    function dedupeTasks(tasks, options = {}) {
        const seen = new Set();
        const result = [];
        for (const raw of tasks) {
            const normalized = model.normalizeNestTask(raw, options);
            if (!normalized.ok || seen.has(normalized.task.id)) continue;
            seen.add(normalized.task.id);
            result.push(normalized.task);
        }
        return result;
    }

    function createTodoApi({ nest, canvas, manualState } = {}) {
        let lastNestRead = null;

        async function readNestTasks(query = {}, options = {}) {
            if (!nest?.todos?.list) return { ok: false, state: "unavailable", tasks: [], error: { code: "NEST_TRANSPORT_UNAVAILABLE", message: "Nest task transport is unavailable." } };
            const limit = Math.max(1, Math.min(PAGE_SIZE, Number(options.limit || query.limit || PAGE_SIZE)));
            let next = { ...query, limit, page: Number(query.page || 1) };
            const rawTasks = [];
            let pages = 0;
            let lastResponse = null;
            try {
                while (next && pages < Math.min(MAX_PAGES, Number(options.maxPages || MAX_PAGES))) {
                    pages += 1;
                    lastResponse = await nest.todos.list(next, { requestId: options.requestId, signal: options.signal });
                    if (!successful(lastResponse)) throw Object.assign(new Error(responseError(lastResponse, "NEST_TODO_READ_FAILED").message), responseError(lastResponse, "NEST_TODO_READ_FAILED"));
                    const body = bodyObject(lastResponse);
                    const items = body ? bodyItems(body) : null;
                    if (!items) throw Object.assign(new Error("Nest returned a malformed task list."), { code: "NEST_TODO_RESPONSE_MALFORMED", status: lastResponse.status });
                    rawTasks.push(...items);
                    next = nextPage(body, Number(next.page || pages));
                    if (next?.page) next = { ...query, limit, page: next.page };
                    else if (next?.offset !== undefined) next = { ...query, limit, offset: next.offset };
                }
                const tasks = dedupeTasks(rawTasks, { accountKey: options.accountKey, timeZone: options.timeZone });
                lastNestRead = { tasks, pages, status: lastResponse?.status || 200 };
                return { ok: true, state: "live", stale: false, readOnly: false, tasks, pages, status: lastResponse?.status || 200 };
            } catch (error) {
                const failure = safeError(error, "NEST_TODO_READ_FAILED");
                if (lastNestRead) return { ok: false, state: "stale", stale: true, readOnly: true, tasks: lastNestRead.tasks.slice(), pages: lastNestRead.pages, status: failure.status, error: failure };
                return { ok: false, state: "unavailable", stale: false, readOnly: true, tasks: [], pages, status: failure.status, error: failure };
            }
        }

        async function createNestTask(payload, options = {}) {
            if (!nest?.todos?.create) return { ok: false, state: "unavailable", error: { code: "NEST_TRANSPORT_UNAVAILABLE", message: "Nest task transport is unavailable." } };
            try {
                const response = await nest.todos.create({ ...payload }, { requestId: options.requestId, idempotencyKey: options.idempotencyKey });
                if (!successful(response)) return { ok: false, state: "error", status: response?.status, error: responseError(response, "NEST_TODO_CREATE_FAILED") };
                const body = bodyObject(response);
                const raw = body?.todo || body?.task;
                const task = raw ? model.normalizeNestTask(raw, { accountKey: options.accountKey }).task : null;
                return { ok: true, state: "created", status: response.status, idempotent: body?.idempotent === true, task: task || null, response };
            } catch (error) { return { ok: false, state: "error", error: safeError(error, "NEST_TODO_CREATE_FAILED") }; }
        }

        async function dispatchCompletion(task, completed, options = {}) {
            const desired = completed === true;
            const authority = options.mode || task?.mutationAuthority;
            let response;
            try {
                if (task?.type === "planner_note" && authority !== "canvas_planner_note") {
                    throw Object.assign(new Error("Only APStudy-created planner notes can be changed."), { code: "PLANNER_NOTE_NOT_OWNED" });
                }
                if (authority === "manual_extension_local" || authority === "manual") {
                    const accountKey = String(options.accountKey || task?.accountKey || "");
                    if (!accountKey || !manualState?.get || !manualState?.set) throw Object.assign(new Error("Manual completion state is unavailable."), { code: "TODO_MANUAL_STATE_UNAVAILABLE" });
                    const key = `todo-completion:${accountKey}`;
                    const current = await manualState.get(key) || {};
                    const next = { ...current, [task.id]: desired };
                    await manualState.set(key, next);
                    return { ok: true, state: "confirmed", authority: "manual_extension_local", task: state.applyConfirmedCompletion(task, desired), storedKey: key };
                }
                if (authority === "canvas_planner_note") {
                    if (!canvas?.setPlannerNoteCompletion) throw Object.assign(new Error("Canvas planner-note completion is unavailable."), { code: "CANVAS_PLANNER_NOTE_UNAVAILABLE" });
                    response = await canvas.setPlannerNoteCompletion(task, { completed: desired }, { requestId: options.requestId, idempotencyKey: options.idempotencyKey, signal: options.signal });
                } else if (authority === "nest") {
                    if (!nest?.todos?.setCompletion) throw Object.assign(new Error("Nest completion transport is unavailable."), { code: "NEST_TRANSPORT_UNAVAILABLE" });
                    response = await nest.todos.setCompletion(task.remoteId, { completed: desired }, { requestId: options.requestId, idempotencyKey: options.idempotencyKey });
                } else if (authority === "canvas_announcement_read") {
                    // Announcements carry no completable work: "complete" means
                    // the discussion topic itself is marked read on Canvas
                    // (PUT/DELETE …/discussion_topics/:id/read), so the state
                    // change is visible outside the extension.
                    if (!canvas?.markAnnouncementRead) throw Object.assign(new Error("Canvas announcement read writer is unavailable."), { code: "CANVAS_ANNOUNCEMENT_READ_UNAVAILABLE" });
                    response = await canvas.markAnnouncementRead(task, { read: desired }, { requestId: options.requestId, idempotencyKey: options.idempotencyKey });
                    if (!successful(response)) return { ok: false, state: "error", status: response?.status, authority, task, error: responseError(response, "CANVAS_ANNOUNCEMENT_READ_FAILED") };
                    return { ok: true, state: "confirmed", status: response.status, authority, task: state.applyConfirmedAnnouncementRead(task, desired), response };
                } else if (authority === "canvas_planner_override" || authority === "canvas") {
                    if (!canvas?.writePlannerOverride) throw Object.assign(new Error("Canvas planner override writer is unavailable."), { code: "CANVAS_PLANNER_OVERRIDE_UNAVAILABLE" });
                    // This is intentionally the only Canvas mutation seam. The
                    // domain never calls a submission endpoint.
                    response = await canvas.writePlannerOverride(task, { marked_complete: desired }, { requestId: options.requestId, idempotencyKey: options.idempotencyKey });
                } else throw Object.assign(new Error("Task has no supported completion authority."), { code: "TODO_COMPLETION_AUTHORITY_INVALID" });
                if (!successful(response)) return { ok: false, state: "error", status: response?.status, authority, task, error: responseError(response, "TODO_COMPLETION_FAILED") };
                return { ok: true, state: "confirmed", status: response.status, authority, task: state.applyConfirmedCompletion(task, desired), response };
            } catch (error) {
                return { ok: false, state: "error", authority, task, error: safeError(error, "TODO_COMPLETION_FAILED") };
            }
        }

        return Object.freeze({ readNestTasks, createNestTask, dispatchCompletion });
    }

    function plannerPath(origin, range, { perPage = PAGE_SIZE, filter = null } = {}) {
        const url = new URL("/api/v1/planner/items", origin);
        url.searchParams.set("start_date", range.start);
        url.searchParams.set("end_date", range.end);
        url.searchParams.set("per_page", String(Math.min(PAGE_SIZE, Math.max(1, Number(perPage) || PAGE_SIZE))));
        // Canvas ships a literal `submissions: false` placeholder on planner
        // rows unless this include is requested. Without real submission
        // state every historical assignment normalizes to incomplete, which
        // pinned the seeded streak at zero for users whose qualifying work
        // was all genuinely submitted — the exact signal the seed must see.
        url.searchParams.append("include[]", "submissions");
        if (filter) url.searchParams.set("filter", filter);
        return url.href;
    }

    function plannerItemKey(item) {
        const nested = item?.plannable && typeof item.plannable === "object" ? item.plannable : {};
        const type = String(item?.plannable_type || item?.type || "").trim();
        const plannableId = item?.plannable_id ?? nested.id;
        if (!type || plannableId === undefined || plannableId === null || String(plannableId).trim() === "") return null;
        // Canvas planner dates and row ids are presentation data.  The
        // plannable type/id pair is the immutable source identity.
        return `${type}:${String(plannableId)}`;
    }

    function plannerCompletionMetadata(item) {
        const sources = [item, item?.submission, item?.submissions, item?.assignment?.submission].filter((value) => value && typeof value === "object");
        const has = (name) => sources.some((source) => source[name] === true);
        const workflow = sources.map((source) => String(source.workflow_state || source.status || "").toLowerCase()).find(Boolean) || "";
        const submitted = has("submitted") || sources.some((source) => Boolean(source.submitted_at)) || ["submitted", "graded", "pending_review", "needs_grading"].includes(workflow);
        const hasPostedGrade = (value) => value !== undefined && value !== null && String(value).trim() !== "";
        const graded = has("graded") || workflow === "graded" || sources.some((source) => hasPostedGrade(source.posted_grade) || hasPostedGrade(source.grade));
        const excused = has("excused");
        return { submitted, graded, excused, missing: has("missing"), late: has("late"), score: Number(submitted) + Number(graded) + Number(excused) + Number(has("needs_grading")) };
    }

    function plannerRichness(item) {
        return [item?.title, item?.name, item?.html_url, item?.url, item?.plannable_date, item?.due_at, item?.updated_at, item?.submission, item?.submissions, item?.planner_override].filter((value) => value !== undefined && value !== null && value !== "").length;
    }

    function mergePlannerItems(existing, candidate) {
        const left = plannerCompletionMetadata(existing), right = plannerCompletionMetadata(candidate);
        const leftUpdated = Date.parse(existing?.updated_at || existing?.plannable?.updated_at || "") || 0;
        const rightUpdated = Date.parse(candidate?.updated_at || candidate?.plannable?.updated_at || "") || 0;
        const preferred = right.score > left.score || (right.score === left.score && (rightUpdated > leftUpdated || (rightUpdated === leftUpdated && plannerRichness(candidate) > plannerRichness(existing)))) ? candidate : existing;
        const combined = {
            submitted: left.submitted || right.submitted,
            graded: left.graded || right.graded,
            excused: left.excused || right.excused,
            late: left.late || right.late,
            // A positive completion observation supersedes a stale missing
            // marker when the two feeds describe the same immutable item.
            missing: !(left.submitted || left.graded || left.excused || right.submitted || right.graded || right.excused) && (left.missing || right.missing)
        };
        return { ...preferred, submissions: { ...(preferred?.submissions && typeof preferred.submissions === "object" ? preferred.submissions : {}), ...combined } };
    }

    function linkNext(response) {
        const link = response.headers?.get?.("link") || response.headers?.get?.("Link") || "";
        return link.match(/<([^>]+)>\s*;\s*rel="?next"?/i)?.[1] || null;
    }

    async function fetchPlannerFeed({ fetchImpl, origin, range, signal, maxPages, filter = null } = {}) {
        let url = plannerPath(origin, range, { filter });
        const seenUrls = new Set(), items = [];
        let pages = 0;
        try {
            while (url && pages < maxPages) {
                if (signal?.aborted) throw abortError();
                if (seenUrls.has(url)) throw Object.assign(new Error("Canvas pagination repeated a page."), { code: "CANVAS_PLANNER_PAGINATION_LOOP" });
                seenUrls.add(url);
                pages += 1;
                const response = await fetchImpl(url, { method: "GET", credentials: "include", cache: "no-store", signal, headers: { Accept: "application/json" } });
                if (!response || !Number.isInteger(Number(response.status)) || response.status < 200 || response.status >= 300) throw Object.assign(new Error(`Canvas planner request failed with status ${response?.status || 0}.`), { code: "CANVAS_PLANNER_HTTP_ERROR", status: response?.status });
                const body = await response.json();
                if (!Array.isArray(body)) throw Object.assign(new Error("Canvas planner returned a malformed response."), { code: "CANVAS_PLANNER_RESPONSE_MALFORMED" });
                items.push(...body.filter((item) => item && typeof item === "object"));
                const nextHref = linkNext(response);
                if (!nextHref) { url = null; continue; }
                const next = new URL(nextHref, url);
                if (next.origin !== new URL(origin).origin || next.pathname !== "/api/v1/planner/items" || next.searchParams.get("start_date") !== range.start || next.searchParams.get("end_date") !== range.end) throw Object.assign(new Error("Canvas pagination left the bounded planner range."), { code: "CANVAS_PLANNER_LINK_INVALID" });
                // Canvas's next links echo the original query. Re-assert the
                // submissions include so later pages keep real submission
                // state instead of silently degrading to the placeholder.
                next.searchParams.set("include[]", "submissions");
                url = next.href;
            }
            if (url) return { ok: false, items, pages, truncated: true, error: { code: "CANVAS_PLANNER_PAGE_LIMIT", message: "Canvas planner pagination exceeded the page limit." } };
            return { ok: true, items, pages, truncated: false, error: null };
        } catch (error) {
            if (isAbortError(error)) throw error;
            return { ok: false, items, pages, truncated: false, error: safeError(error, "CANVAS_PLANNER_READ_FAILED") };
        }
    }

    async function fetchCanvasPlanner({ fetchImpl = (...args) => fetch(...args), origin, range, signal, maxPages = MAX_PAGES } = {}) {
        if (signal?.aborted) throw abortError();
        if (!origin || !range?.start || !range?.end || time.daysInclusive(range.start, range.end) < 1 || time.daysInclusive(range.start, range.end) > 90) return { ok: false, state: "error", error: { code: "CANVAS_PLANNER_RANGE_INVALID", message: "Canvas planner range must be bounded to 1–90 inclusive days." } };
        // Canvas deployments differ: some unfiltered feeds include completed
        // work and others return only active work. Retain that compatible feed
        // and merge the explicit completed feed, so either deployment covers
        // both states without relying on a submission mutation endpoint.
        const feeds = await Promise.all([fetchPlannerFeed({ fetchImpl, origin, range, signal, maxPages }), fetchPlannerFeed({ fetchImpl, origin, range, signal, maxPages, filter: "completed" })]);
        const itemsByIdentity = new Map();
        feeds.forEach((feed) => feed.items.forEach((item) => {
            const key = plannerItemKey(item);
            // A planner row without a plannable id cannot be normalized to a
            // stable Canvas source identity, so never retain or resurrect it.
            if (!key) return;
            itemsByIdentity.set(key, itemsByIdentity.has(key) ? mergePlannerItems(itemsByIdentity.get(key), item) : item);
        }));
        const items = Array.from(itemsByIdentity.values());
        const partial = feeds.some((feed) => !feed.ok);
        const truncated = feeds.some((feed) => feed.truncated);
        const errors = feeds.filter((feed) => feed.error).map((feed) => feed.error);
        return { ok: !partial, state: partial ? "partial" : "live", items, pages: feeds.reduce((total, feed) => total + feed.pages, 0), range, complete: !partial, partial, truncated, feeds: feeds.map((feed, index) => ({ filter: index ? "completed" : null, ok: feed.ok, pages: feed.pages, truncated: feed.truncated, error: feed.error })), ...(errors.length ? { error: errors[0], errors } : {}) };
    }

    function announcementPath(origin, contextCodes, { perPage = PAGE_SIZE } = {}) {
        const url = new URL("/api/v1/announcements", origin);
        contextCodes.forEach((contextCode) => url.searchParams.append("context_codes[]", contextCode));
        url.searchParams.set("per_page", String(Math.min(PAGE_SIZE, Math.max(1, Number(perPage) || PAGE_SIZE))));
        return url.href;
    }

    function announcementKey(item) { return `${item?.context_code || item?.course_id || ""}:${item?.id ?? ""}`; }
    function announcementDate(item) { return Date.parse(item?.posted_at || item?.created_at || item?.updated_at || ""); }
    function announcementReadState(item) {
        if (item?.read_state === "unread" || item?.unread === true || item?.read === false) return "unread";
        if (item?.read_state === "read" || item?.read === true || item?.unread === false) return "read";
        return "unknown";
    }
    function normalizeContextCodes(contextCodes) {
        return Array.from(new Set((Array.isArray(contextCodes) ? contextCodes : []).map((value) => String(value || "").trim()).filter((value) => /^course_\d+$/.test(value)))).sort();
    }

    async function fetchCanvasAnnouncements({ fetchImpl = (...args) => fetch(...args), origin, contextCodes, signal, maxPages = ANNOUNCEMENT_MAX_PAGES, now = Date.now() } = {}) {
        if (signal?.aborted) throw abortError();
        const contexts = normalizeContextCodes(contextCodes);
        if (!origin) return { ok: false, state: "error", items: [], partial: false, truncated: false, error: { code: "CANVAS_ANNOUNCEMENTS_ORIGIN_INVALID", message: "Canvas announcements require an origin." } };
        if (!contexts.length) return { ok: true, state: "live", items: [], pages: 0, partial: false, truncated: false, complete: true, batches: [] };
        const cutoff = Number(now) - RECENT_ANNOUNCEMENT_TAIL_MS;
        const batches = [];
        for (let start = 0; start < contexts.length; start += ANNOUNCEMENT_CONTEXT_BATCH_SIZE) {
            let url = announcementPath(origin, contexts.slice(start, start + ANNOUNCEMENT_CONTEXT_BATCH_SIZE));
            const seenUrls = new Set(), batchItems = [];
            let pages = 0, error = null, truncated = false;
            try {
                while (url && pages < maxPages) {
                    if (signal?.aborted) throw abortError();
                    if (seenUrls.has(url)) throw Object.assign(new Error("Canvas announcement pagination repeated a page."), { code: "CANVAS_ANNOUNCEMENTS_PAGINATION_LOOP" });
                    seenUrls.add(url); pages += 1;
                    const response = await fetchImpl(url, { method: "GET", credentials: "include", cache: "no-store", signal, headers: { Accept: "application/json" } });
                    if (!response || !Number.isInteger(Number(response.status)) || response.status < 200 || response.status >= 300) throw Object.assign(new Error(`Canvas announcement request failed with status ${response?.status || 0}.`), { code: "CANVAS_ANNOUNCEMENTS_HTTP_ERROR", status: response?.status });
                    const body = await response.json();
                    if (!Array.isArray(body)) throw Object.assign(new Error("Canvas announcements returned a malformed response."), { code: "CANVAS_ANNOUNCEMENTS_RESPONSE_MALFORMED" });
                    batchItems.push(...body.filter((item) => item && typeof item === "object"));
                    const nextHref = linkNext(response);
                    if (!nextHref) { url = null; continue; }
                    const next = new URL(nextHref, url);
                    if (next.origin !== new URL(origin).origin || next.pathname !== "/api/v1/announcements") throw Object.assign(new Error("Canvas announcement pagination left its endpoint."), { code: "CANVAS_ANNOUNCEMENTS_LINK_INVALID" });
                    url = next.href;
                }
                if (url) { truncated = true; error = { code: "CANVAS_ANNOUNCEMENTS_PAGE_LIMIT", message: "Canvas announcement pagination exceeded the page limit." }; }
            } catch (caught) {
                if (isAbortError(caught)) throw caught;
                error = safeError(caught, "CANVAS_ANNOUNCEMENTS_READ_FAILED");
            }
            batches.push({ contextCodes: contexts.slice(start, start + ANNOUNCEMENT_CONTEXT_BATCH_SIZE), items: batchItems, pages, truncated, error, ok: !error });
        }
        const seen = new Set(), items = [];
        batches.forEach((batch) => batch.items.forEach((item) => {
            const readState = announcementReadState(item);
            // Missing read state is unknown, never an implicit unread item.
            // Keep it only in the same bounded recent tail as known reads.
            if (readState !== "unread" && (!Number.isFinite(announcementDate(item)) || announcementDate(item) < cutoff)) return;
            const key = announcementKey(item);
            if (!seen.has(key)) { seen.add(key); items.push(item); }
        }));
        const partial = batches.some((batch) => !batch.ok);
        const truncated = batches.some((batch) => batch.truncated);
        const errors = batches.filter((batch) => batch.error).map((batch) => batch.error);
        return { ok: !partial, state: partial ? "partial" : "live", items, pages: batches.reduce((total, batch) => total + batch.pages, 0), complete: !partial, partial, truncated, batches: batches.map(({ items: ignored, ...batch }) => batch), ...(errors.length ? { error: errors[0], errors } : {}) };
    }

    // Canvas's authoritative per-user course colors live outside the planner
    // feed: GET /api/v1/users/self/colors returns { custom_colors: { "course_<id>": "#hex" } }
    // (user- or institution-assigned in Canvas). This is the only source whose
    // colors reflect what the user picked in Canvas, so the To-Do merge treats
    // it as authoritative over every derived color.
    const CANVAS_CUSTOM_COLORS_PATH = "/api/v1/users/self/colors";
    const CANVAS_CUSTOM_COLORS_TIMEOUT_MS = 8000;
    const CANVAS_CUSTOM_COLORS_KEY = /^course_\d{1,20}$/;

    function customColorHex(value) {
        const candidate = typeof value === "string" ? value.trim().toLowerCase() : "";
        return /^#[0-9a-f]{3,8}$/.test(candidate) ? candidate : null;
    }

    // Keep Canvas's own `course_<id>` keys verbatim (lowercased hex values
    // only); anything else in the payload — account colors, malformed hex,
    // non-course keys — is dropped rather than guessed at.
    function normalizeCustomColors(payload) {
        const source = payload && typeof payload === "object" && !Array.isArray(payload)
            && payload.custom_colors && typeof payload.custom_colors === "object" && !Array.isArray(payload.custom_colors)
            ? payload.custom_colors
            : null;
        if (!source) return {};
        return Object.keys(source).reduce((colors, key) => {
            if (!CANVAS_CUSTOM_COLORS_KEY.test(String(key))) return colors;
            const color = customColorHex(source[key]);
            if (color) colors[key] = color;
            return colors;
        }, {});
    }

    // One bounded, failure-tolerant read: a single GET, an internal timeout
    // that cooperates with any caller signal, and a settled failure result —
    // never a throw, so a colors outage can never break a refresh that
    // otherwise succeeded.
    async function fetchCanvasCustomColors({ fetchImpl = (...args) => fetch(...args), origin, signal, timeoutMs = CANVAS_CUSTOM_COLORS_TIMEOUT_MS } = {}) {
        const failed = (code, message) => ({ ok: false, state: "unavailable", colors: {}, error: { code, message } });
        if (!origin) return failed("CANVAS_CUSTOM_COLORS_ORIGIN_INVALID", "Canvas custom colors require an origin.");
        if (signal?.aborted) return failed("CANVAS_CUSTOM_COLORS_ABORTED", "The custom colors request was aborted.");
        const controller = typeof AbortController === "function" ? new AbortController() : null;
        const timeout = Math.max(0, Number.isFinite(Number(timeoutMs)) ? Number(timeoutMs) : CANVAS_CUSTOM_COLORS_TIMEOUT_MS);
        const timer = controller && timeout > 0 ? setTimeout(() => controller.abort(), timeout) : null;
        const onExternalAbort = () => controller?.abort();
        if (controller && signal) signal.addEventListener?.("abort", onExternalAbort, { once: true });
        try {
            const response = await fetchImpl(new URL(CANVAS_CUSTOM_COLORS_PATH, origin).href, {
                method: "GET", credentials: "include", cache: "no-store",
                signal: controller?.signal || signal, headers: { Accept: "application/json" }
            });
            if (!response || !Number.isInteger(Number(response.status)) || response.status < 200 || response.status >= 300) {
                throw Object.assign(new Error(`Canvas custom colors request failed with status ${response?.status || 0}.`), { code: "CANVAS_CUSTOM_COLORS_HTTP_ERROR", status: response?.status });
            }
            const body = await response.json();
            return { ok: true, state: "live", status: Number(response.status), colors: normalizeCustomColors(body) };
        } catch (error) {
            return failed("CANVAS_CUSTOM_COLORS_READ_FAILED", error?.message || "The Canvas custom colors request failed.");
        } finally {
            if (timer !== null) clearTimeout(timer);
            if (controller && signal) signal.removeEventListener?.("abort", onExternalAbort);
        }
    }

    function canvasPlannableIdentity(task) {
        const raw = task?.raw && typeof task.raw === "object" ? task.raw : {};
        const courseId = task?.course?.id;
        // plannerItem() guarantees plannable_id on planner rows; the
        // announcements feed returns bare discussion topics whose id is the
        // plannable id itself.
        const plannableId = raw.plannable_id ?? raw.plannable?.id ?? raw.id;
        if (courseId === undefined || courseId === null || String(courseId).trim() === "") return null;
        if (plannableId === undefined || plannableId === null || String(plannableId).trim() === "") return null;
        return `${task?.source || "canvas"}:${task?.type || ""}:${String(courseId)}:${String(plannableId)}`;
    }

    function canvasTaskMetadataRank(task) {
        // A real course name only arrives with the planner row; the
        // announcements feed leaves course metadata at the "Course <id>"
        // fallback, so it ranks lower when both feeds describe one item.
        return task?.course && typeof task.course === "object" && String(task.course.name || "").trim() ? 1 : 0;
    }

    function canvasRawPreviewBody(task) {
        const raw = task?.raw && typeof task.raw === "object" ? task.raw : {};
        const plannable = raw.plannable && typeof raw.plannable === "object" ? raw.plannable : {};
        const value = raw.message ?? plannable.message ?? raw.description ?? plannable.description ?? raw.details;
        return typeof value === "string" && value.trim() ? value : null;
    }

    function withMergedPreviewBody(task, twin) {
        const body = canvasRawPreviewBody(twin);
        if (!body || canvasRawPreviewBody(task)) return task;
        // Tasks are frozen; the dropped feed twin is often the only copy that
        // carries a renderable body (announcement `message`), so the kept
        // task inherits it instead of previewing as empty.
        return Object.freeze({ ...task, raw: { ...task.raw, message: body } });
    }

    function dedupeCanvasTasks(tasks) {
        const byIdentity = new Map(), seenIds = new Set(), result = [];
        for (const task of tasks || []) {
            if (!task) continue;
            const identity = canvasPlannableIdentity(task);
            if (identity) {
                const existing = byIdentity.get(identity);
                if (existing) {
                    // The planner feed and /api/v1/announcements both deliver
                    // the same announcement under different source item keys
                    // (planner row id vs discussion topic id). Keep one row.
                    const preferred = canvasTaskMetadataRank(task) > canvasTaskMetadataRank(existing) ? task : existing;
                    const dropped = preferred === existing ? task : existing;
                    const merged = withMergedPreviewBody(preferred, dropped);
                    result.splice(result.indexOf(existing), 1, merged);
                    byIdentity.set(identity, merged);
                    continue;
                }
                byIdentity.set(identity, task);
                result.push(task);
                continue;
            }
            const key = task.id || `${task.source}:${task.remoteId}:${task.sourceItemKey}`;
            if (seenIds.has(key)) continue;
            seenIds.add(key);
            result.push(task);
        }
        return result;
    }

    function buildNestCreatePayload(task, { idempotencyKey, description } = {}) {
        const payload = {
            title: task?.title || "Untitled task",
            ...(description ? { description } : {}),
            ...(task?.url ? { link: task.url } : {}),
            ...(task?.due?.utcInstant ? { due_at: task.due.utcInstant } : task?.due?.date ? { due_date: task.due.date } : {}),
            ...(task?.timezone ? { timezone: task.timezone } : {}),
            ...(task?.priority ? { priority: task.priority } : {}),
            ...(task?.course?.id ? { canvas_course_id: task.course.id } : {}),
            ...(task?.course?.label ? { canvas_course_label: task.course.label } : {}),
            source_identity: Object.fromEntries(Object.entries({ source: task?.source, account_key: task?.accountKey, source_item_key: task?.sourceItemKey, event_ref: task?.eventRef }).filter(([, value]) => value !== undefined && value !== null)),
            ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {})
        };
        return Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined));
    }

    return Object.freeze({ createTodoApi, fetchCanvasPlanner, plannerPath, fetchCanvasAnnouncements, announcementPath, buildNestCreatePayload, successful, responseError, plannerItemKey, mergePlannerItems, announcementReadState, canvasPlannableIdentity, dedupeCanvasTasks, fetchCanvasCustomColors, normalizeCustomColors, customColorHex, CANVAS_CUSTOM_COLORS_TIMEOUT_MS });
}));
