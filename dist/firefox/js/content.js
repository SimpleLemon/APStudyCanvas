const domain = window.location.origin;
let current_page = window.location.pathname;
const CANVAS_CONTEXT_VERSION = 1;
const BUILD_TAG = "sidebar-bc-parity-3";
const contentContextApi = globalThis.APStudyCanvasContent?.Context;
const contentSidebarApi = globalThis.APStudyCanvasContent?.Sidebar;
const contentSidebarAdapterApi = globalThis.APStudyCanvasContent?.SidebarAdapter;
const contentSidebarPageActionsApi = globalThis.APStudyCanvasContent?.SidebarPageActions;
const contentSettingsApplyApi = globalThis.APStudyCanvasContent?.SettingsApply;
const contentLifecycleApi = globalThis.APStudyCanvasContent?.Lifecycle;
const contentExtensionContextApi = globalThis.APStudyCanvasContent?.ExtensionContext;
const contentCalendarOverlayApi = globalThis.APStudyCanvasContent?.CalendarOverlay;
const contentSyncExtractionApi = globalThis.APStudyCanvasContent?.SyncExtraction;
const contentOverlayHostApi = globalThis.APStudyCanvasContent?.OverlayHost;
const contentIdentityApi = globalThis.APStudyCanvasCanvasAdapter?.Identity;
const contentExtractorApi = globalThis.APStudyCanvasCanvasAdapter?.Extractor;
const contentProtocolApi = globalThis.APStudyCanvasCanvasAdapter?.Protocol;
const contentCanvasPaginationApi = globalThis.APStudyCanvasCanvasAdapter?.Pagination;
const contentTodoTimeApi = globalThis.APStudyCanvasContent?.TodoTime;
const contentTodoModelApi = globalThis.APStudyCanvasContent?.TodoModel;
const contentPlannerTasksApi = globalThis.APStudyCanvasContent?.PlannerTasks;
const contentTodoStateApi = globalThis.APStudyCanvasContent?.TodoState;
const contentTodoStreakApi = globalThis.APStudyCanvasContent?.TodoStreak;
const contentTodoApi = globalThis.APStudyCanvasContent?.TodoApi;
const contentTodoRailApi = globalThis.APStudyCanvasContent?.TodoRightRail;
const contentTodoCourseCardsApi = globalThis.APStudyCanvasContent?.TodoCourseCards;
const contentSidebarDisplayedCardsApi = globalThis.APStudyCanvasContent?.SidebarDisplayedCards;
const contentCardAppearanceApi = globalThis.APStudyCanvasContent?.CardAppearance;
const contentDashboardCardWatchdogApi = globalThis.APStudyCanvasContent?.DashboardCardWatchdog;
const contentCanvasSearchIndexApi = globalThis.APStudyCanvasContent?.CanvasSearchIndex;
const contentCanvasSearchUiApi = globalThis.APStudyCanvasContent?.CanvasSearchUI;
const contentGradeAnalyticsApi = globalThis.APStudyCanvasContent?.GradeAnalytics;
const contentGradeAnalyticsUiApi = globalThis.APStudyCanvasContent?.GradeAnalyticsUI;
const contentGradeOverviewApi = globalThis.APStudyCanvasContent?.GradeOverview;
const contentTodoSchemaApi = globalThis.APStudyCanvasSchema;
const contentPlatformTransportApi = globalThis.APStudyCanvasPlatform?.Transport;
let contentContextService = null;
let contentSidebarController = null;
let contentSidebarPageActions = null;
let dashboardScriptBlockWatchdog = null;
let contentSettingsApplicator = null;
let contentLifecycle = null;
let contentExtractorService = null;
let contentSyncExtractionHandler = null;
let extensionStarted = false;
let accountBoundJobsPaused = false;
let contentCalendarOverlayController = null;
let contentOverlayHost = null;
let controlCenterListenerAttached = false;
let sidebarContextRevision = 0;
let contentTodoIntegration = null;
let contentTodoRefreshTimer = null;
let contentCanvasSearchIndex = null;
let contentCanvasSearchUi = null;
let contentCanvasSearchContext = null;
let contentCanvasSearchBootstrap = null;
// Every teardown invalidates an in-flight context lookup. Without this token,
// an off -> on transition could let the first (now stale) bootstrap mount
// after opt-out or route teardown had already released its ownership.
let contentCanvasSearchBootstrapGeneration = 0;
let contentCanvasSearchReadinessListenersAttached = false;
let contentGradeAnalyticsUi = null;
let contentGradeAnalyticsAbort = null;
let contentGradeAnalyticsRetryTimer = null;
let contentGradeAnalyticsRetryCount = 0;
let contentGradeOverviewUi = null;
let contentGradeOverviewState = null;
let contentGradeOverviewRetryTimer = null;
let contentGradeOverviewRetryCount = 0;
const CONTENT_GRADE_ANALYTICS_RETRY_DELAYS = Object.freeze([100, 250, 500, 1000, 1500]);

// Quiz attempts are deliberately a no-enhancement zone. Canvas and New
// Quizzes use several route families (including LTI launches) and a false
// positive is safer than inserting a rail, overlay, or card mutation into an
// assessment. Exported below for the focused URL-table tests.
function isQuizSafeRoute(locationLike = window.location) {
    let url;
    try { url = locationLike instanceof URL ? locationLike : new URL(String(locationLike?.href || locationLike || ""), window.location.origin); } catch (error) { return false; }
    const path = decodeURIComponent(url.pathname || "").toLowerCase();
    const query = url.searchParams;
    // The quiz landing and detail pages are ordinary Canvas navigation pages.
    // Only an actual attempt (or its submission/history) is a no-enhancement
    // zone; treating every quiz detail as an attempt prevented Cmd+K there.
    if (/\/quizzes\/\d+\/(?:take|history|submission|start)(?:\/|$)/.test(path)) return true;
    if (/\/(?:external_tools|lti)\//.test(path) && /(?:quiz|new_quiz|assessment)/.test(`${path} ${url.search}`)) return true;
    return query.get("quiz_lti") === "1" || query.get("new_quiz") === "1" || query.get("assessment") === "1";
}

function phaseOneSettings(values = {}) {
    const migrated = contentTodoSchemaApi?.migratePhaseOneSettings?.(values) || { settings: {} };
    // The Phase 1 migration predates these opt-in keys. Its defaults must not
    // overwrite an explicitly persisted Phase 4 preference during startup;
    // doing so made a saved true value become false until the popup emitted a
    // second storage event.
    const phaseFourOptIns = {};
    ["canvas_search_enabled", "grade_analytics_enabled"].forEach((key) => {
        if (typeof values?.[key] === "boolean") phaseFourOptIns[key] = values[key];
    });
    const customFont = contentTodoSchemaApi?.normalizeCustomFont?.(values?.custom_font) || { link: "", family: "" };
    return { ...values, ...(migrated.settings || {}), ...phaseFourOptIns, custom_font: customFont };
}

function resolvedExtensionTheme(settings = options) {
    return contentTodoSchemaApi?.resolveExtensionTheme?.(settings)
        || (settings?.extension_theme === "light" || settings?.extension_theme === "dark" ? settings.extension_theme : settings?.device_dark === true ? "system" : settings?.dark_mode === true ? "dark" : "light");
}

function applyQuizSafeRouteGuard() {
    const root = document.documentElement;
    const safe = options?.quiz_safe_mode !== false && isQuizSafeRoute();
    if (!safe) {
        root?.removeAttribute?.("data-apstudycanvas-quiz-safe");
        return false;
    }
    root?.setAttribute?.("data-apstudycanvas-quiz-safe", "true");
    contentCardAppearance?.stop?.();
    contentTodoIntegration?.pause?.("quiz-safe-route");
    contentSidebarController?.pause?.();
    teardownDashboardNotes();
    void teardownPhaseFourFeatures("quiz-safe-route", { clearSearch: true });
    if (typeof removeAssignmentNavigation === "function") removeAssignmentNavigation();
    teardownContentOverlayHost("quiz-safe-route");
    document.querySelectorAll?.("[data-apstudycanvas-owned], .canvasrefined-card-assignment, .canvasrefined-card-grade").forEach((node) => node.remove?.());
    return true;
}

function wasQuizSafeRoute() {
    return document.documentElement?.getAttribute?.("data-apstudycanvas-quiz-safe") === "true";
}

function safeCustomBackgroundUrl(value) {
    const validated = contentTodoSchemaApi?.validateSettingValue?.("sync", "customBackgroundLink", value);
    if (validated?.valid && typeof validated.value === "string" && validated.value) return validated.value;
    return "";
}

// Phase 4 surfaces intentionally share no Nest transport or Canvas mutation
// path. The content integration is their only consumer: it supplies already
// authenticated, same-origin read-only snapshots and destroys every owned root
// before a route, account, or safe-route boundary can expose stale data.
function phaseFourStorage() {
    return {
        get: (key) => storageAreaGet(chrome?.storage?.local, key),
        set: (key, value) => storageAreaSet(chrome?.storage?.local, { [key]: value }),
        remove: (key) => new Promise((resolve) => {
            try {
                const returned = chrome?.storage?.local?.remove?.(key, () => resolve());
                if (returned?.then) returned.then(() => resolve(), () => resolve());
                else if (!chrome?.storage?.local?.remove) resolve();
            } catch (error) { resolve(); }
        })
    };
}

async function phaseFourCanvasContext() {
    try {
        const context = await contentContextService?.getContext?.();
        const origin = context?.ok === true && context.origin === window.location.origin ? context.origin : null;
        const accountId = context?.canvasUser?.id ? String(context.canvasUser.id) : "";
        return origin && accountId ? { origin, accountId, courseId: context?.course?.id ? String(context.course.id) : "" } : null;
    } catch (error) {
        return null;
    }
}

function phaseFourCourseId() {
    return /^\/courses\/(\d+)(?:\/|$)/.exec(window.location.pathname || "")?.[1] || "";
}

// Canvas renders the Grades route after the document-start content scripts.
// Keep this matcher deliberately narrow: course home, assignments, and quiz
// paths must never become analytics hosts just because their URL mentions
// "grades" in a query or nested resource.
function phaseFourGradeCourseId(pathname = window.location.pathname) {
    return /^\/courses\/(\d+)\/grades(?:\/|$)/.exec(String(pathname || ""))?.[1] || "";
}

function phaseFourGradeAnalyticsHost(doc = document) {
    // `#content` is stable across the legacy and responsive Canvas grade
    // layouts; `#main` is the compatibility fallback used by older themes.
    return doc?.querySelector?.("#content, #main") || null;
}

async function fetchPhaseFourJson(path, signal, { timeoutMs = 8000, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
    const target = new URL(path, window.location.origin);
    if (target.origin !== window.location.origin || target.protocol !== "https:" || !target.pathname.startsWith("/api/v1/")) throw new Error("PHASE_FOUR_PATH_INVALID");
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) abort(); else signal?.addEventListener?.("abort", abort, { once: true });
    let timer = null;
    let timedOut = false;
    try {
        const deadline = new Promise((resolve, reject) => { timer = setTimeoutFn(() => { timedOut = true; controller.abort(); const error = new Error("CANVAS_SEARCH_TIMEOUT"); error.code = error.message; reject(error); }, timeoutMs); });
        const response = await Promise.race([
            fetch(target.href, { method: "GET", credentials: "include", headers: { Accept: "application/json" }, signal: controller.signal }),
            deadline
        ]);
        if (timedOut) throw Object.assign(new Error("CANVAS_SEARCH_TIMEOUT"), { code: "CANVAS_SEARCH_TIMEOUT" });
        if (!response.ok) {
            const error = new Error(`PHASE_FOUR_READ_${response.status}`);
            error.code = error.message;
            error.status = response.status;
            throw error;
        }
        // Canvas can resolve the response headers and then stall while decoding
        // a captive-portal/error body. Keep the same request deadline around
        // JSON parsing so collection pagination always settles.
        const payload = await Promise.race([response.json(), deadline]);
        const link = response.headers?.get?.("Link") || "";
        const next = link.match(/<([^>]+)>;\s*rel="?next"?/i)?.[1] || null;
        if (payload && typeof payload === "object" && link) Object.defineProperty(payload, "__apstudyCanvasLink", { value: link, enumerable: false });
        // The search collector predates the Canvas pagination adapter. Keep its
        // narrow compatibility field while Grade Analytics validates the whole
        // RFC5988 header below before it follows anything.
        if (payload && typeof payload === "object" && next) Object.defineProperty(payload, "__apstudyCanvasNext", { value: next, enumerable: false });
        return payload;
    } finally {
        if (timer !== null) clearTimeoutFn(timer);
        signal?.removeEventListener?.("abort", abort);
    }
}

function phaseFourCollectionItems(payload) {
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload?.data)) return payload.data;
    if (Array.isArray(payload?.items)) return payload.items;
    return [];
}

function phaseFourGradeAnalyticsError(code) {
    const error = new Error(code);
    error.code = code;
    return error;
}

// Grade estimates are only meaningful when the snapshot is complete. Canvas
// paginates both collections, so follow only a Link relation that the shared
// Canvas parser has accepted, remains on this exact collection endpoint, and
// has not already been visited. The domain itself accepts at most 100 groups
// and 500 assignments; matching those limits here avoids a later silent trim.
async function fetchPhaseFourGradeAnalyticsCollection(path, signal, { maxPages = 25, maxItems = 500, requestTimeoutMs = 8000, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
    const origin = window.location.origin;
    const initial = new URL(path, origin);
    if (initial.origin !== origin || initial.protocol !== "https:" || !initial.pathname.startsWith("/api/v1/")) throw phaseFourGradeAnalyticsError("GRADE_ANALYTICS_COLLECTION_INVALID");
    const pageLimit = Math.max(1, Math.min(50, Number(maxPages) || 1));
    const itemLimit = Math.max(1, Math.min(500, Number(maxItems) || 1));
    const items = [];
    const visited = new Set();
    let nextPath = initial.href;
    for (let page = 1; nextPath; page += 1) {
        if (signal?.aborted) throw new DOMException("Grade analytics collection cancelled", "AbortError");
        const target = new URL(nextPath, origin);
        const key = `${target.pathname}${target.search}`;
        if (visited.has(key)) throw phaseFourGradeAnalyticsError("GRADE_ANALYTICS_PAGINATION_CYCLE");
        visited.add(key);
        const payload = await fetchPhaseFourJson(target.href, signal, { timeoutMs: requestTimeoutMs, setTimeoutFn, clearTimeoutFn });
        if (signal?.aborted) throw new DOMException("Grade analytics collection cancelled", "AbortError");
        const batch = phaseFourCollectionItems(payload);
        if (items.length + batch.length > itemLimit) throw phaseFourGradeAnalyticsError("GRADE_ANALYTICS_COLLECTION_TRUNCATED");
        items.push(...batch);
        const parsed = contentCanvasPaginationApi?.parseLinkHeader?.(payload?.__apstudyCanvasLink, { expectedOrigin: origin, baseUrl: target.href });
        if (!parsed?.ok) throw phaseFourGradeAnalyticsError("GRADE_ANALYTICS_PAGINATION_INVALID");
        if (!parsed.next) return items;
        let next;
        try { next = new URL(parsed.next, origin); } catch (error) { throw phaseFourGradeAnalyticsError("GRADE_ANALYTICS_PAGINATION_INVALID"); }
        if (next.protocol !== "https:" || next.origin !== origin || next.pathname !== initial.pathname || next.username || next.password || next.hash) throw phaseFourGradeAnalyticsError("GRADE_ANALYTICS_PAGINATION_INVALID");
        if (page >= pageLimit) throw phaseFourGradeAnalyticsError("GRADE_ANALYTICS_COLLECTION_TRUNCATED");
        nextPath = next.href;
    }
    return items;
}

function phaseFourGradeAnalyticsFailureMessage(error) {
    if (error?.code === "GRADE_ANALYTICS_COLLECTION_TRUNCATED") return "This course has more grade data than Grade Analytics can safely read at once. No estimate is shown; reload this Grades page or try again after Canvas finishes loading. Canvas remains unchanged.";
    if (error?.code === "GRADE_ANALYTICS_PAGINATION_INVALID" || error?.code === "GRADE_ANALYTICS_PAGINATION_CYCLE") return "Canvas returned an unsafe or incomplete grade-data page sequence. No estimate is shown. Reload this Grades page and try again; Canvas remains unchanged.";
    return "Grade estimates could not be read from Canvas. Reload this Grades page to try again; Canvas remains unchanged.";
}

// The global /grades page is its own Canvas surface: it lists the student's
// courses with the scores Canvas already printed there. The Grade overview
// summarizes that exact list, read-only, and must never render on a course
// Grades route where the single-course analytics surface is the owner.
function phaseFourGlobalGradesRoute(pathname = window.location.pathname) {
    return /^\/grades\/?$/.test(String(pathname || ""));
}

function phaseFourGradeOverviewLetterResolver() {
    const gpaApi = globalThis.APStudyCanvasContent?.Gpa;
    if (typeof contentCardAppearanceApi?.resolveLetterGrade !== "function" || typeof gpaApi?.computeGpa !== "function") return null;
    const resolve = contentCardAppearanceApi.resolveLetterGrade;
    return (score, bounds) => resolve(score, bounds, gpaApi) ?? null;
}

function teardownPhaseFourGradeOverview(reason) {
    if (contentGradeOverviewRetryTimer !== null) clearTimeout(contentGradeOverviewRetryTimer);
    contentGradeOverviewRetryTimer = null;
    contentGradeOverviewRetryCount = 0;
    contentGradeOverviewState = null;
    contentGradeOverviewUi?.destroy?.();
    contentGradeOverviewUi = null;
}

function syncPhaseFourGradeOverview() {
    const attached = Boolean(contentGradeOverviewUi?.isAttached?.());
    if (attached && contentGradeOverviewState !== "loading") return false;
    if (!attached && contentGradeOverviewUi) teardownPhaseFourGradeOverview("overview-host-replaced");
    // The module-level state must mirror the UI's loading state: retry timers
    // and onRefresh probes key off it, so a null here would make every retry
    // see a "non-loading" mounted surface and bail before re-parsing.
    contentGradeOverviewState = "loading";
    const host = phaseFourGradeAnalyticsHost();
    if (!host) return schedulePhaseFourGradeOverviewRetry();
    let parsed = null;
    try { parsed = contentGradeOverviewApi?.parseGlobalGradeRows?.(host) || null; } catch (error) { parsed = null; }
    const summary = parsed?.rows?.length
        ? contentGradeOverviewApi?.summarizeGradeOverview?.(parsed.rows, { bounds: options.gpa_calc_bounds, letterFor: phaseFourGradeOverviewLetterResolver(), truncated: parsed.truncated === true }) || null
        : null;
    if (!contentGradeOverviewUi) {
        const ui = contentGradeOverviewApi?.createGradeOverviewUI?.({ document });
        if (!ui?.mount) return schedulePhaseFourGradeOverviewRetry();
        const mounted = ui.mount(host, { state: "loading", onRetry: () => {
            teardownPhaseFourGradeOverview("overview-retry");
            void ensurePhaseFourGradeOverview();
        } });
        if (mounted !== true) { ui.destroy?.(); return schedulePhaseFourGradeOverviewRetry(); }
        contentGradeOverviewUi = ui;
    }
    if (summary?.courses) {
        contentGradeOverviewRetryCount = 0;
        contentGradeOverviewState = "ready";
        contentGradeOverviewUi.update({ state: "ready", summary, onRetry: null });
        return true;
    }
    if (contentGradeOverviewRetryCount < CONTENT_GRADE_ANALYTICS_RETRY_DELAYS.length) return schedulePhaseFourGradeOverviewRetry();
    contentGradeOverviewRetryCount = 0;
    contentGradeOverviewState = "empty";
    // The UI is optional: a failed mount or a missing provider must degrade to
    // the native page instead of throwing out of every subsequent sync.
    contentGradeOverviewUi?.update?.({ state: "empty", summary: null, onRetry: () => {
        teardownPhaseFourGradeOverview("overview-retry");
        void ensurePhaseFourGradeOverview();
    } });
    return true;
}

function schedulePhaseFourGradeOverviewRetry() {
    if (contentGradeOverviewRetryTimer !== null || options?.grade_analytics_enabled !== true || wasQuizSafeRoute() || !phaseFourGlobalGradesRoute()) return false;
    const delay = CONTENT_GRADE_ANALYTICS_RETRY_DELAYS[contentGradeOverviewRetryCount++];
    if (!Number.isFinite(delay)) return false;
    contentGradeOverviewRetryTimer = setTimeout(() => {
        contentGradeOverviewRetryTimer = null;
        if (contentGradeOverviewUi?.isAttached?.() && contentGradeOverviewState !== "loading") return;
        if (contentGradeOverviewUi && !contentGradeOverviewUi?.isAttached?.()) teardownPhaseFourGradeOverview("overview-host-replaced");
        syncPhaseFourGradeOverview();
    }, delay);
    return true;
}

function ensurePhaseFourGradeOverview() {
    if (options?.grade_analytics_enabled !== true || wasQuizSafeRoute() || !phaseFourGlobalGradesRoute()) return false;
    if (contentGradeOverviewUi?.isAttached?.() && contentGradeOverviewState !== "loading") return false;
    if (contentGradeOverviewUi && !contentGradeOverviewUi?.isAttached?.()) teardownPhaseFourGradeOverview("overview-host-replaced");
    return syncPhaseFourGradeOverview();
}

async function fetchPhaseFourSearchCollection(path, signal, { maxPages = 3, perPage = 100, requestTimeoutMs = 8000, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
    const items = [];
    const visited = new Set();
    const pageLimit = Math.max(1, Math.min(5, Number(maxPages) || 1));
    const itemLimit = Math.max(1, Math.min(100, Number(perPage) || 100));
    let nextPath = path;
    for (let page = 1; page <= pageLimit && nextPath; page += 1) {
        if (signal?.aborted) throw new DOMException("Search collection cancelled", "AbortError");
        const target = new URL(nextPath, window.location.origin);
        target.searchParams.set("per_page", String(itemLimit));
        if (!target.searchParams.has("page")) target.searchParams.set("page", String(page));
        const key = `${target.pathname}${target.search}`;
        if (visited.has(key)) { const error = new Error("CANVAS_SEARCH_PAGINATION_CYCLE"); error.code = error.message; throw error; }
        visited.add(key);
        const payload = await fetchPhaseFourJson(key, signal, { timeoutMs: requestTimeoutMs, setTimeoutFn, clearTimeoutFn });
        const batch = phaseFourCollectionItems(payload);
        items.push(...batch.slice(0, itemLimit));
        const linked = payload?.__apstudyCanvasNext;
        if (linked) {
            const next = new URL(linked, window.location.origin);
            if (next.origin !== window.location.origin || next.protocol !== "https:" || next.pathname !== new URL(path, window.location.origin).pathname || next.username || next.password || next.hash) { const error = new Error("CANVAS_SEARCH_PAGINATION_INVALID"); error.code = error.message; throw error; }
            nextPath = `${next.pathname}${next.search}`;
        } else if (batch.length < itemLimit || payload?.__apstudyCanvasLink) break;
        else nextPath = path;
        if (page === pageLimit) Object.defineProperty(items, "truncated", { value: true });
    }
    return items;
}

function phaseFourSearchRecords(course, assignments, files, pages, modules) {
    const courseId = String(course?.id || "");
    const courseName = String(course?.name || "").slice(0, 160);
    const records = [];
    (Array.isArray(assignments) ? assignments : []).forEach((item) => records.push({ id: `assignment:${courseId}:${item?.id}`, type: "assignment", title: item?.name, href: item?.html_url || `/courses/${courseId}/assignments/${item?.id}`, courseId, courseName }));
    (Array.isArray(files) ? files : []).forEach((item) => records.push({ id: `file:${courseId}:${item?.id}`, type: "file", title: item?.display_name || item?.filename, href: `/courses/${courseId}/files/${item?.id}`, courseId, courseName }));
    (Array.isArray(pages) ? pages : []).forEach((item) => records.push({ id: `page:${courseId}:${item?.page_id || item?.url}`, type: "page", title: item?.title, href: item?.html_url || `/courses/${courseId}/pages/${encodeURIComponent(item?.url || "")}`, courseId, courseName }));
    (Array.isArray(modules) ? modules : []).forEach((module) => {
        (Array.isArray(module?.items) ? module.items : []).forEach((item) => records.push({ id: `module:${courseId}:${module?.id}:${item?.id}`, type: "module", title: item?.title, href: item?.html_url || `/courses/${courseId}/modules/items/${item?.id}`, courseId, courseName, moduleLabel: module?.name }));
    });
    return records;
}

async function collectPhaseFourSearchRecords({ signal, deadlineMs = 20000, requestTimeoutMs = 8000, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) abort(); else signal?.addEventListener?.("abort", abort, { once: true });
    const records = [];
    const failures = [];
    let timedOut = false;
    const deadline = setTimeoutFn(() => { timedOut = true; controller.abort(); }, deadlineMs);
    try {
    const courses = await fetchPhaseFourSearchCollection("/api/v1/courses?enrollment_state=active", controller.signal, { maxPages: 2, requestTimeoutMs, setTimeoutFn, clearTimeoutFn });
    if (courses.truncated || courses.length > 20) failures.push("CANVAS_SEARCH_LIMIT_REACHED");
    for (const course of courses.slice(0, 20)) {
        if (controller.signal.aborted) { if (timedOut) break; throw new DOMException("Search collection cancelled", "AbortError"); }
        const id = String(course?.id || "");
        if (!/^\d+$/.test(id)) continue;
        const settled = await Promise.allSettled([
            fetchPhaseFourSearchCollection(`/api/v1/courses/${id}/assignments`, controller.signal, { requestTimeoutMs, setTimeoutFn, clearTimeoutFn }),
            fetchPhaseFourSearchCollection(`/api/v1/courses/${id}/files`, controller.signal, { requestTimeoutMs, setTimeoutFn, clearTimeoutFn }),
            fetchPhaseFourSearchCollection(`/api/v1/courses/${id}/pages`, controller.signal, { requestTimeoutMs, setTimeoutFn, clearTimeoutFn }),
            fetchPhaseFourSearchCollection(`/api/v1/courses/${id}/modules?include[]=items`, controller.signal, { requestTimeoutMs, setTimeoutFn, clearTimeoutFn })
        ]);
        if (controller.signal.aborted && !timedOut) throw new DOMException("Search collection cancelled", "AbortError");
        if (settled.some((result) => result.status === "fulfilled" && result.value.truncated)) failures.push("CANVAS_SEARCH_LIMIT_REACHED");
        const [assignments, files, pages, modules] = settled.map((result) => result.status === "fulfilled" ? result.value : []);
        settled.filter((result) => result.status === "rejected").forEach((result) => failures.push(result.reason?.code || "CANVAS_SEARCH_RESOURCE_FAILED"));
        for (const module of modules) {
            if (Array.isArray(module.items) || !/^\d+$/.test(String(module.id || "")) || controller.signal.aborted) continue;
            try {
                module.items = await fetchPhaseFourSearchCollection(`/api/v1/courses/${id}/modules/${module.id}/items`, controller.signal, { requestTimeoutMs, setTimeoutFn, clearTimeoutFn });
                if (module.items.truncated) failures.push("CANVAS_SEARCH_LIMIT_REACHED");
            } catch (error) { failures.push(error?.code || "CANVAS_SEARCH_RESOURCE_FAILED"); }
        }
        records.push(...phaseFourSearchRecords(course, assignments, files, pages, modules));
        if (records.length >= 500) { failures.push("CANVAS_SEARCH_LIMIT_REACHED"); break; }
    }
    if (timedOut) failures.push("CANVAS_SEARCH_TIMEOUT");
    return { items: records.slice(0, 500), failures: Array.from(new Set(failures)).slice(0, 16) };
    } finally {
        clearTimeoutFn(deadline);
        signal?.removeEventListener?.("abort", abort);
    }
}

function validatePhaseFourNavigationIntent(intent, origin = window.location.origin) {
    if (!intent || intent.type !== "canvas-search-navigation" || intent.userGesture !== true || !["current-tab", "new-tab"].includes(intent.disposition)) return null;
    try {
        const target = new URL(intent.href, origin);
        if (target.protocol !== "https:" || target.origin !== origin || target.username || target.password) return null;
        return target;
    } catch (error) { return null; }
}

function executePhaseFourNavigationIntent(intent) {
    const target = validatePhaseFourNavigationIntent(intent);
    if (!target) return false;
    if (intent.disposition === "new-tab") {
        window.open(target.href, "_blank", "noopener");
        return true;
    }
    window.location.assign(target.href);
    return true;
}

async function teardownPhaseFourSearch(reason, { clear = false } = {}) {
    const index = contentCanvasSearchIndex;
    const context = contentCanvasSearchContext;
    // Context service can announce its initial identity while the very first
    // context probe is still resolving. That probe reads the post-transition
    // identity, so cancelling an otherwise unowned pre-mount probe would
    // strand the one-shot DOM readiness listener. Once any search owner has
    // been established, account changes still invalidate it immediately.
    const invalidateBootstrap = reason !== "account-change" || Boolean(index || context || contentCanvasSearchUi);
    if (invalidateBootstrap) {
        if (typeof contentCanvasSearchBootstrapGeneration === "number") contentCanvasSearchBootstrapGeneration += 1;
        if (typeof contentCanvasSearchBootstrap !== "undefined") contentCanvasSearchBootstrap = null;
    }
    contentCanvasSearchUi?.destroy?.();
    contentCanvasSearchUi = null;
    contentCanvasSearchIndex = null;
    contentCanvasSearchContext = null;
    if (clear) {
        // Opt-out/logout may arrive before a search root mounts or after context
        // extraction has failed. In that cold-start case clear the whole bounded
        // search blob rather than leaving another account's local metadata behind.
        const cleaner = index || contentCanvasSearchIndexApi?.createCanvasSearchIndex?.({ storage: phaseFourStorage() });
        await cleaner?.clear?.(context || {});
        if (cleaner && cleaner !== index) cleaner.dispose?.();
    }
    index?.dispose?.();
}

function teardownPhaseFourAnalytics(reason) {
    if (contentGradeAnalyticsRetryTimer !== null) clearTimeout(contentGradeAnalyticsRetryTimer);
    contentGradeAnalyticsRetryTimer = null;
    contentGradeAnalyticsRetryCount = 0;
    contentGradeAnalyticsAbort?.abort?.();
    contentGradeAnalyticsAbort = null;
    contentGradeAnalyticsUi?.destroy?.();
    contentGradeAnalyticsUi = null;
}

function schedulePhaseFourAnalyticsRetry() {
    if (contentGradeAnalyticsRetryTimer !== null || options?.grade_analytics_enabled !== true || wasQuizSafeRoute() || !phaseFourGradeCourseId()) return false;
    const delay = CONTENT_GRADE_ANALYTICS_RETRY_DELAYS[contentGradeAnalyticsRetryCount++];
    if (!Number.isFinite(delay)) return false;
    contentGradeAnalyticsRetryTimer = setTimeout(() => {
        contentGradeAnalyticsRetryTimer = null;
        if (contentGradeAnalyticsUi?.isAttached?.()) return;
        if (contentGradeAnalyticsUi) teardownPhaseFourAnalytics("analytics-host-replaced");
        void ensurePhaseFourAnalytics();
    }, delay);
    return true;
}

async function teardownPhaseFourFeatures(reason, { clearSearch = false } = {}) {
    teardownPhaseFourAnalytics(reason);
    teardownPhaseFourGradeOverview(reason);
    await teardownPhaseFourSearch(reason, { clear: clearSearch });
}

async function ensurePhaseFourSearch() {
    if (options?.canvas_search_enabled !== true || wasQuizSafeRoute() || contentCanvasSearchUi) return;
    // document_start precedes Canvas's application shell. Context deliberately
    // fails closed until that shell exists, so coalesce readiness/mutation
    // retries instead of treating the first pre-DOM result as an opt-out.
    if (contentCanvasSearchBootstrap) return contentCanvasSearchBootstrap;
    const bootstrapGeneration = contentCanvasSearchBootstrapGeneration;
    const bootstrap = (async () => {
        const context = await phaseFourCanvasContext();
        if (!context || bootstrapGeneration !== contentCanvasSearchBootstrapGeneration || options?.canvas_search_enabled !== true || wasQuizSafeRoute() || contentCanvasSearchUi) return;
        const index = contentCanvasSearchIndexApi?.createCanvasSearchIndex?.({ storage: phaseFourStorage() });
        const ui = contentCanvasSearchUiApi?.createCanvasSearchUI?.({ document, window });
        if (bootstrapGeneration !== contentCanvasSearchBootstrapGeneration || !index || !ui?.mount?.(document.body, { index, ...context, enabled: true, quizSafe: false, theme: resolvedExtensionTheme(), collect: collectPhaseFourSearchRecords, onNavigate: executePhaseFourNavigationIntent })) {
            index?.dispose?.();
            return;
        }
        if (bootstrapGeneration !== contentCanvasSearchBootstrapGeneration || options?.canvas_search_enabled !== true || wasQuizSafeRoute()) {
            ui.destroy?.();
            index.dispose?.();
            return;
        }
        contentCanvasSearchIndex = index;
        contentCanvasSearchUi = ui;
        contentCanvasSearchContext = context;
    })();
    contentCanvasSearchBootstrap = bootstrap;
    try {
        return await bootstrap;
    } finally {
        if (contentCanvasSearchBootstrap === bootstrap) contentCanvasSearchBootstrap = null;
    }
}

function schedulePhaseFourSearchReadiness() {
    if (contentCanvasSearchReadinessListenersAttached || options?.canvas_search_enabled !== true || contentCanvasSearchUi) return;
    contentCanvasSearchReadinessListenersAttached = true;
    const retry = () => {
        // A context/account invalidation can settle the original pre-shell
        // probe in the same turn as DOMContentLoaded. Re-probe once after
        // that promise releases its bootstrap slot; otherwise the one-shot
        // readiness event is spent on the stale promise.
        void ensurePhaseFourSearch().then(() => {
            if (options?.canvas_search_enabled === true && !wasQuizSafeRoute() && !contentCanvasSearchUi && document.readyState !== "loading") void ensurePhaseFourSearch();
        });
    };
    if (document.readyState === "loading") document.addEventListener?.("DOMContentLoaded", retry, { once: true });
    window.addEventListener?.("load", retry, { once: true });
}

async function ensurePhaseFourAnalytics() {
    const courseId = phaseFourGradeCourseId();
    if (options?.grade_analytics_enabled !== true || wasQuizSafeRoute() || !courseId) return false;
    if (contentGradeAnalyticsUi?.isAttached?.()) return false;
    if (contentGradeAnalyticsUi) teardownPhaseFourAnalytics("analytics-host-replaced");
    const host = phaseFourGradeAnalyticsHost();
    const ui = contentGradeAnalyticsUiApi?.createGradeAnalyticsUI?.({ document, domain: contentGradeAnalyticsApi });
    if (!host || !ui?.mount) return schedulePhaseFourAnalyticsRetry();
    const controller = new AbortController();
    if (ui.mount(host, { state: "loading", bounds: options.gpa_calc_bounds, zones: true, onRetry: () => {
        teardownPhaseFourAnalytics("analytics-retry");
        void ensurePhaseFourAnalytics();
    } }) !== true) {
        ui.destroy?.();
        return false;
    }
    contentGradeAnalyticsAbort = controller;
    contentGradeAnalyticsUi = ui;
    contentGradeAnalyticsRetryCount = 0;
    try {
        const [assignmentGroups, assignments] = await Promise.all([
            fetchPhaseFourGradeAnalyticsCollection(`/api/v1/courses/${courseId}/assignment_groups?per_page=100`, controller.signal, { maxItems: 100 }),
            fetchPhaseFourGradeAnalyticsCollection(`/api/v1/courses/${courseId}/assignments?include[]=submission&per_page=100`, controller.signal, { maxItems: 500 })
        ]);
        if (controller.signal.aborted || contentGradeAnalyticsUi !== ui) return;
        ui.update({ state: "ready", source: { courseId, assignmentGroups, assignments }, bounds: options.gpa_calc_bounds, zones: true });
    } catch (error) {
        if (!controller.signal.aborted && contentGradeAnalyticsUi === ui) ui.update({ state: "error", error: phaseFourGradeAnalyticsFailureMessage(error), onRetry: () => {
            teardownPhaseFourAnalytics("analytics-retry");
            void ensurePhaseFourAnalytics();
        } });
    }
    return true;
}

async function syncPhaseFourFeatures(reason, { clearSearch = false } = {}) {
    if (contentContextDead || applyQuizSafeRouteGuard()) {
        await teardownPhaseFourFeatures(reason || "safe-route", { clearSearch: true });
        return;
    }
    if (options?.canvas_search_enabled === true) {
        // A live popup change can arrive while Canvas is still building its
        // shell. Register the same readiness retry used at startup before the
        // first context probe, otherwise that failed probe leaves Cmd/Ctrl+K
        // without an owner for the rest of the document.
        schedulePhaseFourSearchReadiness();
        await ensurePhaseFourSearch();
    }
    // Disabled is also a cold-start privacy boundary: do not require a mounted
    // eligible page or a storage-change event before deleting an old local blob.
    else await teardownPhaseFourSearch(reason || "search-disabled", { clear: true });
    teardownPhaseFourAnalytics(reason || "analytics-refresh");
    // Ordinary Canvas refresh/mutation cycles must not reset the global
    // overview's bounded late-DOM retry. Route changes already use the shared
    // teardown above; the explicit off state owns settings cleanup here.
    if (options?.grade_analytics_enabled !== true) teardownPhaseFourGradeOverview(reason || "overview-disabled");
    await ensurePhaseFourAnalytics();
    return ensurePhaseFourGradeOverview();
}

if (contentContextApi?.createContextService) {
    contentContextService = contentContextApi.createContextService({
        window,
        document,
        chromeApi: chrome,
        onAccountChange: () => {
            accountBoundJobsPaused = true;
            contentCalendarOverlayController?.dispose?.("account-change");
            void teardownPhaseFourFeatures("account-change", { clearSearch: true }).then(() => syncPhaseFourFeatures("account-change"));
        },
        isExtractionReady: () => Boolean(contentSyncExtractionHandler && contentExtractorService)
    });
}

if (contentExtractorApi?.createExtractor) {
    try {
        contentExtractorService = contentExtractorApi.createExtractor({
            window,
            contextService: contentContextService,
            fetchImpl: (...args) => fetch(...args),
            runtime: chrome?.runtime
        });
    } catch (error) {
        contentExtractorService = null;
    }
}

if (contentSyncExtractionApi?.createContentSyncExtraction) {
    try {
        contentSyncExtractionHandler = contentSyncExtractionApi.createContentSyncExtraction({
            extractorFactory: () => contentExtractorService,
            getCanvasContext: async ({ expectedOrigin, canvasUserId }) => {
                const verified = await contentContextService?.verifyAccount?.({ expectedOrigin, expectedUserId: canvasUserId });
                if (!verified?.ok || verified.state !== "verified") return verified || { ok: false, state: "waiting", code: "CANVAS_ACCOUNT_VERIFICATION_WAITING" };
                const accountKey = await contentIdentityApi?.accountKey?.({ origin: verified.origin, userId: verified.userId });
                if (!accountKey) return { ok: false, state: "waiting", code: "CANVAS_ACCOUNT_KEY_UNAVAILABLE" };
                return { ...verified, accountKey };
            },
            runtimeId: chrome?.runtime?.id
        });
    } catch (error) {
        contentSyncExtractionHandler = null;
    }
}

function canvasContextFailure(state, code) {
    return { ok: false, state, code };
}

function normalizeCanvasContextHosts(rawValue) {
    const values = Array.isArray(rawValue) ? rawValue : String(rawValue || "").split(",");
    const hosts = [];
    let sawValue = false;
    for (const raw of values) {
        const candidate = String(raw || "").trim();
        if (!candidate) continue;
        sawValue = true;
        try {
            const url = new URL(candidate.includes("://") ? candidate : `https://${candidate}`);
            const hostname = url.hostname.toLowerCase();
            if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || (url.pathname !== "" && url.pathname !== "/") || !hostname || hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || !hostname.includes(".")) {
                return { valid: false, code: "CANVAS_HOST_HTTPS_REQUIRED" };
            }
            hosts.push(hostname);
        } catch (error) {
            return { valid: false, code: "CANVAS_HOST_INVALID" };
        }
    }
    if (!sawValue || hosts.length === 0) return { valid: false, code: "CANVAS_HOST_NOT_CONFIGURED" };
    return { valid: true, hosts: Array.from(new Set(hosts)) };
}

function isConfiguredCanvasHost(hostname, configuredHosts) {
    const currentHost = String(hostname || "").toLowerCase();
    return configuredHosts.some((configuredHost) => currentHost === configuredHost || currentHost.endsWith(`.${configuredHost}`));
}

function waitForCanvasDocument() {
    if (document.readyState !== "loading") return Promise.resolve();
    return new Promise((resolve) => {
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            document.removeEventListener("DOMContentLoaded", finish);
            resolve();
        };
        document.addEventListener("DOMContentLoaded", finish, { once: true });
        setTimeout(finish, 500);
    });
}

function isCanvasShellDocument() {
    return Boolean(document.querySelector(
        "#application, #wrapper.ic-app, .ic-app, #global_nav, #global_nav_profile_link, [data-react-class*='Canvas'], meta[name='application-name'][content*='Canvas' i]"
    ));
}

function cleanCanvasDisplayName(value) {
    if (typeof value !== "string") return "";
    let cleaned = value.replace(/\s+/g, " ").trim();
    cleaned = cleaned.replace(/^(?:account|profile)\s*[:,-]?\s*/i, "");
    if (cleaned.includes(",")) {
        const afterLabel = cleaned.split(",").slice(1).join(",").trim();
        if (afterLabel) cleaned = afterLabel;
    }
    if (!cleaned || /^(?:account|profile|user|log ?in|sign ?in)$/i.test(cleaned)) return "";
    return cleaned.slice(0, 120);
}

function normalizeCanvasAvatarUrl(value) {
    if (contentContextApi?.safeAvatar) return contentContextApi.safeAvatar(value, window.location.origin);
    if (typeof value !== "string" || !value.trim()) return null;
    try {
        const url = new URL(value, window.location.origin);
        if (url.protocol !== "https:" || url.username || url.password || url.hash || /(?:access[_-]?token|api[_-]?key|authorization|cookie|credential|csrf|jwt|password|private|secret|session|token)/i.test(url.href)) return null;
        return url.href;
    } catch (error) {
        return null;
    }
}

function readCanvasDomProfile() {
    const profileLink = document.querySelector("#global_nav_profile_link, [data-testid='account-nav'], [data-testid='global-nav-profile']");
    const image = profileLink?.querySelector?.("img") || document.querySelector("#global_nav_profile_link img");
    const displayName = cleanCanvasDisplayName(
        profileLink?.getAttribute?.("data-user-name") ||
        profileLink?.getAttribute?.("aria-label") ||
        profileLink?.getAttribute?.("title") ||
        image?.getAttribute?.("alt") ||
        ""
    );
    const avatarUrl = normalizeCanvasAvatarUrl(
        image?.getAttribute?.("src") ||
        image?.getAttribute?.("data-src") ||
        profileLink?.getAttribute?.("data-avatar-url") ||
        ""
    );
    return displayName || avatarUrl ? { displayName: displayName || null, avatarUrl } : null;
}

function hasCanvasSignInMarker() {
    return Boolean(document.querySelector(
        "#login_form, .ic-Login__container, form[action*='/login'], a[href*='/login'], a[href*='/login?']"
    ));
}

async function fetchCanvasJson(path, timeoutMs = 800) {
    if (typeof fetch !== "function") throw new Error("Canvas fetch is unavailable");
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = setTimeout(() => controller?.abort(), timeoutMs);
    try {
        const response = await fetch(new URL(path, window.location.origin).href, {
            method: "GET",
            credentials: "include",
            headers: { Accept: "application/json" },
            ...(controller ? { signal: controller.signal } : {})
        });
        if (!response.ok) {
            const error = new Error(`Canvas request failed: ${response.status}`);
            error.status = response.status;
            throw error;
        }
        return await response.json();
    } finally {
        clearTimeout(timer);
    }
}

async function readCanvasProfile() {
    const domProfile = readCanvasDomProfile();
    if (hasCanvasSignInMarker()) return { signedOut: true, profile: null };
    try {
        const apiProfile = await fetchCanvasJson("/api/v1/users/self");
        const displayName = cleanCanvasDisplayName(apiProfile?.display_name || apiProfile?.name || apiProfile?.short_name);
        const avatarUrl = normalizeCanvasAvatarUrl(apiProfile?.avatar_url);
        return {
            signedOut: false,
            profile: displayName || avatarUrl ? { displayName: displayName || null, avatarUrl } : domProfile
        };
    } catch (error) {
        if (error?.status === 401 || error?.status === 403) return { signedOut: true, profile: null };
        return { signedOut: false, profile: domProfile };
    }
}

function parseCanvasUnreadCount(node) {
    if (!node) return null;
    const raw = [
        node.getAttribute?.("data-unread-count"),
        node.getAttribute?.("data-count"),
        node.getAttribute?.("aria-label"),
        node.getAttribute?.("title"),
        node.textContent
    ].filter(Boolean).join(" ");
    const match = raw.match(/(?:unread|inbox|message|notification)?[^0-9]{0,24}(\d{1,6})\b/i);
    if (!match) return null;
    const count = Number(match[1]);
    return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

function readCanvasDomUnread() {
    const candidates = [
        ["#global_nav_inbox_link .menu-item__badge", "conversations"],
        ["#global_nav_inbox_link [data-unread-count]", "conversations"],
        ["#global_nav_inbox_link", "conversations"],
        ["[data-testid='inbox-unread-count']", "conversations"],
        ["[aria-label*='unread' i][data-count]", "notifications"]
    ];
    for (const [selector, category] of candidates) {
        const count = parseCanvasUnreadCount(document.querySelector(selector));
        if (count === null) continue;
        return { count, categories: { [category]: count } };
    }
    return null;
}

async function readCanvasUnread() {
    try {
        const data = await fetchCanvasJson("/api/v1/conversations/unread_count");
        const count = Number(data?.unread_count ?? data?.count);
        if (Number.isSafeInteger(count) && count >= 0) return { count, categories: { conversations: count } };
    } catch (error) {
        // The DOM signal below is intentionally the fallback. Missing or
        // inaccessible unread data remains null instead of becoming zero.
    }
    return readCanvasDomUnread();
}

const SIDEBAR_CONTEXT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SIDEBAR_CONTEXT_COURSE_ID = /^[1-9]\d{0,19}$/;
const SIDEBAR_CONTEXT_COLOR = /^(?:#[0-9a-f]{3,8}|rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+(?:\s*,\s*[\d.]+)?\s*\))$/i;

function safeSidebarContextText(value, limit = 120) {
    if (typeof value !== "string" && typeof value !== "number") return null;
    const normalized = String(value).replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, limit);
    return normalized || null;
}

function safeSidebarContextId(value) {
    const normalized = safeSidebarContextText(value, 128);
    return normalized && SIDEBAR_CONTEXT_ID.test(normalized) ? normalized : null;
}

function safeSidebarContextHref(value, origin, courseId = null) {
    if (typeof value !== "string" || !origin) return null;
    try {
        const url = new URL(value, origin);
        if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password || url.hash) return null;
        for (const [key, parameter] of url.searchParams.entries()) {
            if (/(?:access[_-]?token|api[_-]?key|authorization|bearer|cookie|credential|csrf|jwt|password|private|secret|session|signature|token)/i.test(key)
                || /(?:access[_-]?token|api[_-]?key|authorization|bearer|cookie|credential|csrf|jwt|password|private|secret|session|signature|token)/i.test(parameter)) return null;
        }
        if (courseId && (url.pathname !== `/courses/${courseId}` && !url.pathname.startsWith(`/courses/${courseId}/`))) return null;
        return url.href;
    } catch (error) {
        return null;
    }
}

function sanitizeSidebarContextForPopup(model, verifiedContext, binding) {
    if (!model || typeof model !== "object" || !verifiedContext || verifiedContext.state !== "verified" || !binding) return null;
    const origin = contentContextApi?.normalizeCanvasOrigin?.(model.account?.origin || model.identity?.origin || binding.origin);
    const bindingOrigin = contentContextApi?.normalizeCanvasOrigin?.(binding.origin);
    const accountKey = typeof binding.accountKey === "string" ? binding.accountKey.trim().toLowerCase() : null;
    if (!origin || origin !== bindingOrigin || !/^[a-f0-9]{64}$/.test(accountKey)) return null;
    if (model.account?.accountKey && String(model.account.accountKey).toLowerCase() !== accountKey) return null;
    const modelUserId = model.account?.userId ?? model.identity?.userId;
    if (modelUserId !== undefined && modelUserId !== null && String(modelUserId) !== String(verifiedContext.userId)) return null;

    const pages = [];
    const pageIds = new Set();
    (Array.isArray(model.pages) ? model.pages : []).forEach((page) => {
        const id = safeSidebarContextId(page?.id);
        const label = safeSidebarContextText(page?.label || page?.name);
        if (!id || !label || pageIds.has(id)) return;
        pageIds.add(id);
        const available = page?.available === true;
        const href = available ? safeSidebarContextHref(page?.href, origin) : null;
        pages.push({
            id,
            label,
            href,
            source: page?.source === "apstudycanvas" ? "apstudycanvas" : "canvas",
            iconRole: safeSidebarContextId(page?.iconRole) || "canvas",
            available: Boolean(available && href),
            known: page?.known !== false,
            ...(Number.isSafeInteger(page?.unreadCount ?? page?.unread ?? page?.count) && Number(page.unreadCount ?? page.unread ?? page.count) >= 0
                ? { unreadCount: Number(page.unreadCount ?? page.unread ?? page.count) }
                : {})
        });
    });
    const pageOrder = [];
    (Array.isArray(model.pageOrder) ? model.pageOrder : pages.map((page) => page.id)).forEach((value) => {
        const id = safeSidebarContextId(value);
        if (id && pageIds.has(id) && !pageOrder.includes(id)) pageOrder.push(id);
    });
    pages.forEach((page) => { if (!pageOrder.includes(page.id)) pageOrder.push(page.id); });
    const pageVisibility = {};
    if (model.pageVisibility && typeof model.pageVisibility === "object" && !Array.isArray(model.pageVisibility)) {
        Object.entries(model.pageVisibility).forEach(([id, visible]) => {
            if (pageIds.has(id) && typeof visible === "boolean") pageVisibility[id] = visible;
        });
    }

    const courses = [];
    const courseIds = new Set();
    (Array.isArray(model.courses) ? model.courses : []).forEach((course, sourceOrder) => {
        const id = safeSidebarContextText(course?.id ?? course?.courseId, 20);
        const name = safeSidebarContextText(course?.name || course?.courseName, 160);
        if (!id || !SIDEBAR_CONTEXT_COURSE_ID.test(id) || !name || course?.available !== true || course?.published === false || course?.concluded === true || courseIds.has(id)) return;
        const href = safeSidebarContextHref(course?.href, origin, id);
        if (!href) return;
        const color = typeof course?.color === "string" && SIDEBAR_CONTEXT_COLOR.test(course.color.trim()) ? course.color.trim() : null;
        courseIds.add(id);
        courses.push({ id, name, href, color, available: true, published: true, sourceOrder: Number.isSafeInteger(course?.sourceOrder) ? course.sourceOrder : sourceOrder });
    });
    const courseOrder = [];
    (Array.isArray(model.courseOrder) ? model.courseOrder : courses.map((course) => course.id)).forEach((value) => {
        const id = safeSidebarContextText(value, 20);
        if (id && courseIds.has(id) && !courseOrder.includes(id)) courseOrder.push(id);
    });
    courses.forEach((course) => { if (!courseOrder.includes(course.id)) courseOrder.push(course.id); });

    const rawRoute = model.route && typeof model.route === "object" ? model.route : {};
    const route = {
        origin,
        pathname: typeof rawRoute.pathname === "string" && rawRoute.pathname.startsWith("/") ? rawRoute.pathname.replace(/\/+/g, "/").slice(0, 240) : "/",
        kind: safeSidebarContextId(rawRoute.kind) || "unknown",
        pageId: safeSidebarContextId(rawRoute.pageId),
        courseId: SIDEBAR_CONTEXT_COURSE_ID.test(String(rawRoute.courseId || "")) ? String(rawRoute.courseId) : null,
        resource: Array.isArray(rawRoute.resource) ? rawRoute.resource.map((value) => safeSidebarContextText(value, 64)).filter(Boolean).slice(0, 8) : []
    };
    return { version: 1, origin, accountKey, route, pages, pageOrder, pageVisibility, courses, courseOrder };
}

async function getCanvasContext() {
    if (contentContextService) {
        const context = await contentContextService.getContext();
        if (context?.ok && context.state === "connected") {
            const contextRevision = ++sidebarContextRevision;
            // Keep the existing popup notification contract alive. This is a
            // read-only compatibility signal; it never leaves this tab except
            // through the sanitized context response below.
            context.unread = await readCanvasUnread();
            context.accountBoundJobsPaused = accountBoundJobsPaused || Boolean(context.accountBoundJobsPaused);

            let binding = null;
            let verified = null;
            try {
                const expectedOrigin = contextContextOrigin(context);
                const expectedUserId = context?.canvasUser?.id;
                verified = expectedOrigin && expectedUserId
                    ? await contentContextService.verifyAccount({ expectedOrigin, expectedUserId })
                    : null;
                const accountKey = verified?.ok && verified.state === "verified"
                    ? await contentIdentityApi?.accountKey?.({ origin: verified.origin, userId: verified.userId })
                    : null;
                binding = contentContextApi?.buildCanvasBinding?.({
                    verifiedContext: verified,
                    context,
                    accountKey,
                    extraction: context.capabilities?.extraction
                }) || null;
            } catch (error) {
                binding = null;
            }
            if (binding) context.canvasBinding = binding;

            // The sidebar controller is the only owner of the authoritative
            // normalized snapshot. Refresh through its public API, then expose
            // only the deliberately narrow popup contract.
            try { await contentSidebarController?.refresh?.(); } catch (error) {}
            const sidebarModel = contentSidebarController?.getModel?.();
            const sidebarContext = sanitizeSidebarContextForPopup(sidebarModel, verified, binding);
            context.contextRevision = contextRevision;
            if (sidebarContext) context.sidebarContext = sidebarContext;

            // The popup context is a narrow profile/notification seam. Keep
            // page location details inside the content script; they are not
            // part of the safe cross-extension response.
            delete context.tab;
            delete context.course;
        }
        return context;
    }
    let storage;
    try {
        storage = await chrome.storage.sync.get(["custom_domain"]);
    } catch (error) {
        return canvasContextFailure("error", "CANVAS_SETTINGS_UNAVAILABLE");
    }
    const configured = normalizeCanvasContextHosts(storage?.custom_domain);
    if (window.location.protocol !== "https:") return canvasContextFailure("setup_needed", "CANVAS_HOST_HTTPS_REQUIRED");
    const staticApproved = window.location.origin === "https://canvas.emory.edu";
    if (!staticApproved && !configured.valid) return canvasContextFailure("setup_needed", configured.code);
    if (!staticApproved && !isConfiguredCanvasHost(window.location.hostname, configured.hosts)) {
        return { ok: true, state: "not_canvas", profile: null, unread: null };
    }

    await waitForCanvasDocument();
    if (hasCanvasSignInMarker()) return { ok: true, state: "signed_out", profile: null, unread: null };
    if (!isCanvasShellDocument()) return { ok: true, state: "not_canvas", profile: null, unread: null };

    const [profileResult, unread] = await Promise.all([readCanvasProfile(), readCanvasUnread()]);
    if (profileResult.signedOut) return { ok: true, state: "signed_out", profile: null, unread: null };
    return { ok: true, state: "connected", profile: profileResult.profile || null, unread: unread || null };
}

function contextContextOrigin(context) {
    return contentContextApi?.normalizeCanvasOrigin?.(context?.origin) || null;
}

// Register before storage setup, DOM enhancements, or Canvas API calls. The
// legacy message switch below remains available for existing popup actions.
const LEGACY_CONTENT_MESSAGES = new Set(["getCards", "setcolors", "getcolors", "inspect", "fixdm", "updateBackground"]);
const UNSUPPORTED_PHASE5_FAMILIES = new Set([
    "CANVAS_SYNC_START", "CANVAS_SYNC_RESUME", "CANVAS_SYNC_STATUS",
    "CANVAS_SYNC_CANCEL", "CANVAS_WRITEBACK_DRAIN", "CANVAS_WRITEBACK_RESULT", "NEST_CALENDARS_GET",
    "NEST_IDENTITY_GET", "NEST_CONSENT_GET", "NEST_CONSENT_SET", "NEST_EVENT_MUTATE",
    "NEST_EVENT_OVERRIDE_SET", "NEST_ROUTING_SET", "POPUP_CONTEXT_GET",
    "SETTINGS_READ", "SETTINGS_RESET"
]);
const CONTENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const VERIFY_CONTENT_FIELDS = new Set([
    "expectedOrigin", "expected_origin", "origin", "expectedUserId", "expected_user_id",
    "userId", "user_id", "accountId", "account_id"
]);

function isPlainContentObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function hasOnlyContentKeys(value, allowed) {
    return isPlainContentObject(value) && Object.keys(value).every((key) => allowed.has(key));
}

function validateContentFamilyRequest(request) {
    if (!isPlainContentObject(request)) return { ok: false, code: "CONTENT_REQUEST_OBJECT_REQUIRED" };
    if (request.version !== undefined && request.version !== CANVAS_CONTEXT_VERSION) return { ok: false, code: "UNSUPPORTED_CONTEXT_VERSION" };
    if (request.requestId !== undefined && request.request_id !== undefined) return { ok: false, code: "CONTENT_REQUEST_ID_DUPLICATE" };
    const requestId = request.request_id !== undefined ? request.request_id : request.requestId;
    if (requestId !== undefined && (typeof requestId !== "string" || !CONTENT_REQUEST_ID_PATTERN.test(requestId))) {
        return { ok: false, code: "CONTENT_REQUEST_ID_INVALID" };
    }

    if (request.type === "GET_CANVAS_CONTEXT") {
        const allowed = new Set(["type", "version", "requestId", "request_id", "payload"]);
        if (!hasOnlyContentKeys(request, allowed)) return { ok: false, code: "CONTENT_FIELDS_UNSUPPORTED" };
        if (request.payload !== undefined && (!isPlainContentObject(request.payload) || Object.keys(request.payload).length)) {
            return { ok: false, code: "CONTENT_FIELDS_UNSUPPORTED" };
        }
        return { ok: true, requestId, payload: {} };
    }

    if (request.type === "SETTINGS_UPDATE") {
        const allowed = new Set(["type", "version", "requestId", "request_id", "payload"]);
        if (!hasOnlyContentKeys(request, allowed) || !hasOnlyContentKeys(request.payload, new Set(["area", "changes"]))) {
            return { ok: false, code: "CONTENT_FIELDS_UNSUPPORTED" };
        }
        if (typeof contentSettingsApplyApi?.validateSettingsUpdateRequest === "function") {
            const validation = contentSettingsApplyApi.validateSettingsUpdateRequest(request, {
                validateSidebar: contentSidebarApi?.validateSettingsUpdateRequest
            });
            return validation.ok ? { ...validation, requestId } : validation;
        }
        if (typeof contentSidebarApi?.validateSettingsUpdateRequest !== "function") {
            return { ok: false, code: "SIDEBAR_SETTINGS_VALIDATOR_UNAVAILABLE" };
        }
        const validation = contentSidebarApi.validateSettingsUpdateRequest(request);
        return validation.ok ? { ...validation, requestId } : validation;
    }

    if (request.type === "SIDEBAR_REFRESH") {
        const allowed = new Set(["type", "version", "requestId", "request_id", "payload"]);
        if (!hasOnlyContentKeys(request, allowed)
            || !hasOnlyContentKeys(request.payload, new Set(["reason"]))
            || request.payload.reason !== "course-order") {
            return { ok: false, code: "CONTENT_FIELDS_UNSUPPORTED" };
        }
        return { ok: true, requestId, payload: { reason: "course-order" } };
    }

    if (request.type === "CANVAS_ACCOUNT_VERIFY") {
        const allowed = new Set(["type", "version", "requestId", "request_id", "payload", ...VERIFY_CONTENT_FIELDS]);
        if (!hasOnlyContentKeys(request, allowed)) return { ok: false, code: "CONTENT_FIELDS_UNSUPPORTED" };
        const direct = Object.fromEntries(Object.entries(request).filter(([key]) => VERIFY_CONTENT_FIELDS.has(key)));
        const payload = request.payload === undefined ? {} : request.payload;
        if (!hasOnlyContentKeys(payload, VERIFY_CONTENT_FIELDS)) return { ok: false, code: "CONTENT_FIELDS_UNSUPPORTED" };
        for (const key of VERIFY_CONTENT_FIELDS) {
            if (Object.prototype.hasOwnProperty.call(direct, key) && Object.prototype.hasOwnProperty.call(payload, key)) {
                return { ok: false, code: "CONTENT_FIELDS_DUPLICATE" };
            }
        }
        return { ok: true, requestId, payload: { ...payload, ...direct } };
    }

    return { ok: false, code: "CONTENT_FAMILY_UNSUPPORTED" };
}

function sendContentFamilyResponse(request, sendResponse, result) {
    if (request?.request_id !== undefined) {
        sendResponse({ version: CANVAS_CONTEXT_VERSION, request_id: request.request_id, type: request.type, payload: result });
        return;
    }
    sendResponse(result);
}

function sendInternalContentResponse(request, sendResponse, result) {
    sendResponse({
        contract_version: contentProtocolApi?.CONTRACT_VERSION || 1,
        request_id: request?.request_id || null,
        type: request?.type || "CANVAS_EXTRACT_RESULT",
        payload: result
    });
}

function extractionUnavailable() {
    return { ok: false, state: "unsupported", code: "CANVAS_EXTRACTOR_UNAVAILABLE" };
}

function isTrustedContentSender(sender) {
    if (!sender) return true;
    const runtimeId = chrome?.runtime?.id;
    if (sender.id && runtimeId && sender.id !== runtimeId) return false;
    if (sender.url && runtimeId) {
        try {
            const url = new URL(sender.url);
            if (!((url.protocol === "chrome-extension:" || url.protocol === "moz-extension:") && url.host === runtimeId)) return false;
        } catch (error) { return false; }
    }
    return true;
}

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage?.addListener) {
    chrome.runtime.onMessage.addListener(recieveMessage);
}

function getCurrentCourseId() {
    const match = current_page.match(/^\/courses\/(\d+)(?:\/|$)/);
    return match ? parseInt(match[1]) : null;
}

function getSidebarLayoutMode() {
    if (current_page.match(/^\/courses\/(\d+)(?:\/|$)/)) return "course";
    if (isProfilePage()) return "course";
    if (current_page === "/courses" || current_page === "/courses/") return "dash";
    if (current_page === "/" || current_page === "") return "dash";
    return "dash";
}

function isGradesPage() {
    return /^\/courses\/\d+\/grades(?:\/|$)/.test(current_page);
}

function isCoursesIndexPage() {
    return /^\/courses\/?$/.test(current_page);
}

function isGroupsIndexPage() {
    return /^\/groups\/?$/.test(current_page);
}

function isConversationsPage() {
    return /^\/conversations(?:\/|$)/.test(current_page);
}

function isProfilePage() {
    return /^\/profile(?:\/|$)/.test(current_page);
}

function getSubmissionAssignmentLink() {
    return contentCardAppearanceApi?.submissionAssignmentDestination?.(window.location.href, domain)?.href || null;
}

let submissionPageButtonObserver = null;
let profileLogoutButtonObserver = null;
const ASSIGNMENT_NAVIGATION_IDS = Object.freeze([
    "canvasrefined-assignment-return",
    "canvasrefined-assignment-grades",
    "canvasrefined-grades-assignments"
]);

function removeAssignmentNavigation() {
    ASSIGNMENT_NAVIGATION_IDS.forEach((id) => document.getElementById(id)?.remove?.());
    document.documentElement?.removeAttribute?.("data-apstudycanvas-hide-sequence");
}

function addAssignmentNavigationButton({ id, destination, text, label }) {
    const content = document.getElementById("content");
    if (!content || !destination?.href) return false;
    const existing = content.querySelector(`#${id}`);
    if (existing) {
        if (existing.getAttribute("href") !== destination.href) existing.setAttribute("href", destination.href);
        if (existing.textContent !== text) existing.textContent = text;
        return true;
    }
    const button = makeElement("a", content, {
        id,
        className: "canvasrefined-custom-btn canvasrefined-assignment-navigation",
        href: destination.href,
        textContent: text,
        "aria-label": label,
        style: "display:inline-flex;align-items:center;justify-content:center;align-self:flex-start;margin:0 0 12px 0;padding:10px 14px;text-decoration:none;font-weight:700;"
    }, true);
    return Boolean(button);
}

function syncAssignmentNavigation() {
    const current = contentCardAppearanceApi?.canvasCourseLocation?.(window.location.href, domain);
    const isAssignmentDetail = current?.section === "assignments" && Boolean(current.assignmentId);
    const hideSequence = isAssignmentDetail && options?.assignment_sequence_footer_visible === false;
    document.documentElement?.toggleAttribute?.("data-apstudycanvas-hide-sequence", hideSequence);

    const submission = contentCardAppearanceApi?.submissionAssignmentDestination?.(window.location.href, domain);
    if (submission) {
        addAssignmentNavigationButton({
            id: "canvasrefined-assignment-return",
            destination: submission,
            text: "Back to Assignment",
            label: "Back to Assignment"
        });
        document.getElementById("canvasrefined-assignment-grades")?.remove?.();
        document.getElementById("canvasrefined-grades-assignments")?.remove?.();
        return true;
    }

    document.getElementById("canvasrefined-assignment-return")?.remove?.();
    if (isAssignmentDetail) {
        const gradesDestination = contentCardAppearanceApi?.courseDestination?.(domain, current.courseId, "grades");
        addAssignmentNavigationButton({
            id: "canvasrefined-assignment-grades",
            destination: gradesDestination,
            text: "View Course Grades",
            label: "View grades for this course"
        });
        document.getElementById("canvasrefined-grades-assignments")?.remove?.();
        return Boolean(gradesDestination);
    }
    if (current?.section === "grades") {
        const assignmentsDestination = contentCardAppearanceApi?.courseDestination?.(domain, current.courseId, "assignments");
        addAssignmentNavigationButton({
            id: "canvasrefined-grades-assignments",
            destination: assignmentsDestination,
            text: "View Assignments",
            label: "View assignments for this course"
        });
        document.getElementById("canvasrefined-assignment-grades")?.remove?.();
        return Boolean(assignmentsDestination);
    }
    document.getElementById("canvasrefined-assignment-grades")?.remove?.();
    document.getElementById("canvasrefined-grades-assignments")?.remove?.();
    return false;
}

function addSubmissionPageButton() {
    const assignmentLink = getSubmissionAssignmentLink();
    if (!assignmentLink) return;
    addAssignmentNavigationButton({
        id: "canvasrefined-assignment-return",
        destination: { href: assignmentLink },
        text: "Back to Assignment",
        label: "Back to Assignment"
    });
}

let sequenceFooterObserver = null;

function isAssignmentPage() {
    return /^\/courses\/\d+\/assignments\/\d+(?:\/|$)/.test(current_page);
}

function removeSequenceFooter() {
    syncAssignmentNavigation();
    return document.documentElement?.getAttribute?.("data-apstudycanvas-hide-sequence") === "";
}

function watchSequenceFooter() {
    syncAssignmentNavigation();
}

function ensureSubmissionPageButton() {
    const assignmentLink = getSubmissionAssignmentLink();
    if (!assignmentLink) return false;
    const content = document.getElementById("content");
    if (!content) return false;
    if (content.querySelector("#canvasrefined-assignment-return")) return true;
    addSubmissionPageButton();
    return Boolean(content.querySelector("#canvasrefined-assignment-return"));
}

function watchSubmissionPageButton() {
    if (!getSubmissionAssignmentLink()) return;
    if (ensureSubmissionPageButton()) return;
    if (submissionPageButtonObserver) return;

    submissionPageButtonObserver = new MutationObserver(() => {
        if (ensureSubmissionPageButton() && submissionPageButtonObserver) {
            submissionPageButtonObserver.disconnect();
            submissionPageButtonObserver = null;
        }
    });

    submissionPageButtonObserver.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => {
        if (submissionPageButtonObserver) {
            submissionPageButtonObserver.disconnect();
            submissionPageButtonObserver = null;
        }
    }, 10000);
}

function addProfileLogoutPageButton() {
    if (!isProfilePage()) return;
    const content = document.getElementById("content");
    if (!content || content.querySelector("#canvasrefined-profile-logout")) return;

    makeElement("a", content, {
        id: "canvasrefined-profile-logout",
        className: "canvasrefined-custom-btn",
        href: `${domain}/logout`,
        textContent: "Logout",
        style: "display:inline-flex;align-items:center;justify-content:center;align-self:flex-start;margin:0 0 12px 0;padding:10px 14px;text-decoration:none;font-weight:700;",
    }, true);
}

function ensureProfileLogoutPageButton() {
    if (!isProfilePage()) return false;
    const content = document.getElementById("content");
    if (!content) return false;
    if (content.querySelector("#canvasrefined-profile-logout")) return true;
    addProfileLogoutPageButton();
    return Boolean(content.querySelector("#canvasrefined-profile-logout"));
}

function watchProfileLogoutPageButton() {
    if (!isProfilePage()) return;
    if (ensureProfileLogoutPageButton()) return;
    if (profileLogoutButtonObserver) return;

    profileLogoutButtonObserver = new MutationObserver(() => {
        if (ensureProfileLogoutPageButton() && profileLogoutButtonObserver) {
            profileLogoutButtonObserver.disconnect();
            profileLogoutButtonObserver = null;
        }
    });

    profileLogoutButtonObserver.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => {
        if (profileLogoutButtonObserver) {
            profileLogoutButtonObserver.disconnect();
            profileLogoutButtonObserver = null;
        }
    }, 10000);
}

function getSidebarStateMode(mode = getSidebarLayoutMode()) {
    return mode === "course" ? "course" : "dashboard";
}

function getSidebarStateKey(mode = getSidebarLayoutMode()) {
    return `better_sidebar_expanded_${getSidebarStateMode(mode)}`;
}

async function getSidebarExpandedState(mode = getSidebarLayoutMode()) {
    return false;
}

function setSidebarExpandedState(mode, expanded) {
    chrome.storage.local.set({ [getSidebarStateKey(mode)]: expanded });
}

let assignments = null;
let grades = null;
let announcements = [];
let completed = [];
let assignmentsDue = [];
let options = {};
let timeCheck = null;
let recurringContentWorkStopped = false;
let contentContextDead = false;
let betterSidebarLoading = false;
let cardAssignmentsGeneration = 0;
let cardAssignments = null;

// Chrome can append punctuation or context to this error after an unpacked
// extension is reloaded. Keep the detector here so every recurring callback
// uses the same teardown path without hiding ordinary failures.
const CONTENT_CONTEXT_INVALIDATED = /\bExtension context(?: was)? invalidated\b/i;

function isContentContextInvalidated(error) {
    if (contentExtensionContextApi?.isInvalidated?.(error)) return true;
    const message = error instanceof Error ? error.message : error?.message ?? error;
    return CONTENT_CONTEXT_INVALIDATED.test(String(message || "").trim());
}

function invalidateContentContext(reason, error) {
    if (contentContextDead) return { ok: false, invalidated: true };
    contentContextDead = true;
    recurringContentWorkStopped = true;
    sidebarContextRevision += 1;
    cardAssignmentsGeneration += 1;
    if (contentTodoRefreshTimer !== null) {
        try { clearTimeout(contentTodoRefreshTimer); } catch (timerError) {}
        contentTodoRefreshTimer = null;
    }
    if (timeCheck !== null) {
        try { clearInterval(timeCheck); } catch (timerError) {}
        timeCheck = null;
    }
    try { sequenceFooterObserver?.disconnect?.(); } catch (observerError) {}
    sequenceFooterObserver = null;
    if (typeof removeAssignmentNavigation === "function") removeAssignmentNavigation();
    try { submissionPageButtonObserver?.disconnect?.(); } catch (observerError) {}
    submissionPageButtonObserver = null;
    try { profileLogoutButtonObserver?.disconnect?.(); } catch (observerError) {}
    profileLogoutButtonObserver = null;
    try { contentLifecycle?.dispose?.(reason || "context-invalidated"); } catch (disposeError) {}
    contentLifecycle = null;
    try { contentSidebarController?.dispose?.(); } catch (disposeError) {}
    contentSidebarController = null;
    try { contentTodoIntegration?.destroy?.(reason || "context-invalidated"); } catch (destroyError) {}
    contentTodoIntegration = null;
    try { teardownContentOverlayHost(reason || "context-invalidated"); } catch (overlayError) {}
    void teardownPhaseFourFeatures(reason || "context-invalidated", { clearSearch: true });
    accountBoundJobsPaused = true;
    return { ok: false, invalidated: true };
}

function stopRecurringContentWork() {
    if (recurringContentWorkStopped) return;
    invalidateContentContext("recurring-work-stopped");
}

function runRecurringContentWork(task, label) {
    if (contentContextDead || recurringContentWorkStopped) return Promise.resolve({ ok: false, stopped: true });
    const guarded = contentExtensionContextApi?.run
        ? contentExtensionContextApi.run(task, { onInvalidated: stopRecurringContentWork })
        : Promise.resolve().then(task);
    return Promise.resolve(guarded).catch((error) => {
        if (isContentContextInvalidated(error)) {
            stopRecurringContentWork();
            return { ok: false, invalidated: true };
        }
        console.error("[APStudyCanvas] content diagnostic: CONTENT_RUNTIME_FAILED");
        return { ok: false, code: `${String(label || "recurring work").toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_FAILED` };
    });
}

/*
Start
*/

const canvas_svg = `<svg xmlns="http://www.w3.org/2000/svg" fill="#ff4545" width="25px" height="25px" viewBox="-192 -192 2304.00 2304.00" stroke="white"><g stroke-width="0"><rect x="-192" y="-192" width="2304.00" height="2304.00" rx="0" fill="none" strokewidth="0"/></g><g stroke-linecap="round" stroke-linejoin="round"/><g> <path d="M958.568 277.97C1100.42 277.97 1216.48 171.94 1233.67 34.3881 1146.27 12.8955 1054.57 0 958.568 0 864.001 0 770.867 12.8955 683.464 34.3881 700.658 171.94 816.718 277.97 958.568 277.97ZM35.8207 682.031C173.373 699.225 279.403 815.285 279.403 957.136 279.403 1098.99 173.373 1215.05 35.8207 1232.24 12.8953 1144.84 1.43262 1051.7 1.43262 957.136 1.43262 862.569 12.8953 769.434 35.8207 682.031ZM528.713 957.142C528.713 1005.41 489.581 1044.55 441.31 1044.55 393.038 1044.55 353.907 1005.41 353.907 957.142 353.907 908.871 393.038 869.74 441.31 869.74 489.581 869.74 528.713 908.871 528.713 957.142ZM1642.03 957.136C1642.03 1098.99 1748.06 1215.05 1885.61 1232.24 1908.54 1144.84 1920 1051.7 1920 957.136 1920 862.569 1908.54 769.434 1885.61 682.031 1748.06 699.225 1642.03 815.285 1642.03 957.136ZM1567.51 957.142C1567.51 1005.41 1528.38 1044.55 1480.11 1044.55 1431.84 1044.55 1392.71 1005.41 1392.71 957.142 1392.71 908.871 1431.84 869.74 1480.11 869.74 1528.38 869.74 1567.51 908.871 1567.51 957.142ZM958.568 1640.6C816.718 1640.6 700.658 1746.63 683.464 1884.18 770.867 1907.11 864.001 1918.57 958.568 1918.57 1053.14 1918.57 1146.27 1907.11 1233.67 1884.18 1216.48 1746.63 1100.42 1640.6 958.568 1640.6ZM1045.98 1480.11C1045.98 1528.38 1006.85 1567.51 958.575 1567.51 910.304 1567.51 871.172 1528.38 871.172 1480.11 871.172 1431.84 910.304 1392.71 958.575 1392.71 1006.85 1392.71 1045.98 1431.84 1045.98 1480.11ZM1045.98 439.877C1045.98 488.148 1006.85 527.28 958.575 527.28 910.304 527.28 871.172 488.148 871.172 439.877 871.172 391.606 910.304 352.474 958.575 352.474 1006.85 352.474 1045.98 391.606 1045.98 439.877ZM1441.44 1439.99C1341.15 1540.29 1333.98 1697.91 1418.52 1806.8 1579 1712.23 1713.68 1577.55 1806.82 1418.5 1699.35 1332.53 1541.74 1339.7 1441.44 1439.99ZM1414.21 1325.37C1414.21 1373.64 1375.08 1412.77 1326.8 1412.77 1278.53 1412.77 1239.4 1373.64 1239.4 1325.37 1239.4 1277.1 1278.53 1237.97 1326.8 1237.97 1375.08 1237.97 1414.21 1277.1 1414.21 1325.37ZM478.577 477.145C578.875 376.846 586.039 219.234 501.502 110.339 341.024 204.906 206.338 339.592 113.203 498.637 220.666 584.607 378.278 576.01 478.577 477.145ZM679.155 590.32C679.155 638.591 640.024 677.723 591.752 677.723 543.481 677.723 504.349 638.591 504.349 590.32 504.349 542.048 543.481 502.917 591.752 502.917 640.024 502.917 679.155 542.048 679.155 590.32ZM1440 475.712C1540.3 576.01 1697.91 583.174 1806.8 498.637 1712.24 338.159 1577.55 203.473 1418.51 110.339 1332.54 217.801 1341.13 375.413 1440 475.712ZM1414.21 590.32C1414.21 638.591 1375.08 677.723 1326.8 677.723 1278.53 677.723 1239.4 638.591 1239.4 590.32 1239.4 542.048 1278.53 502.917 1326.8 502.917 1375.08 502.917 1414.21 542.048 1414.21 590.32ZM477.145 1438.58C376.846 1338.28 219.234 1331.12 110.339 1415.65 204.906 1576.13 339.593 1710.82 498.637 1805.39 584.607 1696.49 577.443 1538.88 477.145 1438.58ZM679.155 1325.37C679.155 1373.64 640.024 1412.77 591.752 1412.77 543.481 1412.77 504.349 1373.64 504.349 1325.37 504.349 1277.1 543.481 1237.97 591.752 1237.97 640.024 1237.97 679.155 1277.1 679.155 1325.37Z"/></g></svg>`;

const CONTENT_DIAGNOSTICS_MIGRATION_KEY = "content_diagnostics_v2";
// Previous builds stored raw exception stacks under `errors`. Remove that
// legacy value directly: do not read, transform, or expose its contents. The
// migration marker is separate, so future page loads retain safe diagnostics.
function clearLegacyErrorDiagnostics() {
    try {
        const local = chrome.storage.local;
        if (!local?.get || !local?.remove || !local?.set) return Promise.resolve();
        return Promise.resolve(local.get(CONTENT_DIAGNOSTICS_MIGRATION_KEY)).then((values) => {
            if (values?.[CONTENT_DIAGNOSTICS_MIGRATION_KEY] === true) return;
            return Promise.resolve(local.remove("errors"))
                .catch(() => {})
                .then(() => Promise.resolve(local.set({ [CONTENT_DIAGNOSTICS_MIGRATION_KEY]: true })).catch(() => {}));
        }).catch(() => {});
    } catch (error) { return Promise.resolve(); }
}

clearLegacyErrorDiagnostics().finally(isDomainCanvasPage);

function normalizeCanvasDomain(value) {
    if (contentContextApi?.normalizeCanvasOrigin) {
        const origin = contentContextApi.normalizeCanvasOrigin(value);
        if (!origin) return "";
        try { return new URL(origin).hostname; } catch (error) { return ""; }
    }
    if (typeof value !== "string") return "";
    const candidate = value.trim();
    if (!candidate) return "";

    try {
        const url = new URL(candidate.includes("://") ? candidate : `https://${candidate}`);
        const hostname = url.hostname.toLowerCase();
        if (url.protocol !== "https:" || hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || !hostname.includes(".")) return "";
        return hostname;
    } catch (error) {
        return candidate.split("/")[0].replace(/^https?:\/\//, "");
    }
}

function isDomainCanvasPage() {
    // One full sync read feeds both the origin approval and the startup
    // settings (startExtension consumes it verbatim), so initialization begins
    // a storage round trip earlier and injected chrome appears with Canvas's
    // own elements instead of after them.
    Promise.all([
        chrome.storage.sync.get(null),
        chrome.storage.local?.get?.(["platform.accountMetadata"]) || Promise.resolve({})
    ]).then(([result, localResult]) => {
        options = phaseOneSettings(result || {});
        const configuredOrigins = contentContextApi?.normalizeCanvasOrigins
            ? contentContextApi.normalizeCanvasOrigins(result?.custom_domain)
            : (Array.isArray(result?.custom_domain) ? result.custom_domain.map((item) => normalizeCanvasDomain(item)).filter(Boolean).map((host) => `https://${host}`) : []);
        const verifiedOrigins = contentContextApi?.verifiedOriginsFromMetadata
            ? contentContextApi.verifiedOriginsFromMetadata(localResult?.["platform.accountMetadata"])
            : [];
        const approved = contentContextApi?.isApprovedLocation
            ? contentContextApi.isApprovedLocation(window.location, { configuredOrigins, verifiedOrigins })
            : window.location.origin === "https://canvas.emory.edu" || (configuredOrigins.some((origin) => origin === window.location.origin) && verifiedOrigins.includes(window.location.origin));
        if (approved) {
            startExtension(result);
            return;
        }

        // Unapproved origins never receive Canvas enhancements or mutate
        // settings. The explicit settings/popup transaction is the sole
        // owner of custom-origin permission, verification, persistence, and
        // its intentional tab reload.
        abandonTodoInstitutionLogoPrepaint();
    }).catch(() => {
        abandonTodoInstitutionLogoPrepaint();
    });
}

function refreshContentSidebar(reason) {
    if (!contentSidebarController) return;
    // resume() reapplies exactly once; lifecycle's pageshow timer is retained
    // for generic consumers but must not double-apply this controller.
    if (reason === "pageshow") return;
    if (reason === "mutation") {
        // Canvas DOM churn may invalidate the native nav root, but it must
        // never schedule a network refresh: the rail re-render itself mutates
        // the page, so a refresh here would feed the mutation observer its own
        // output in a continuous fetch/re-render loop.
        if (contentSidebarController.needsRefresh(options)) contentSidebarController.apply(options);
        return;
    }
    if (reason === "init") {
        if (contentSidebarController.needsRefresh(options)) contentSidebarController.apply(options);
        else void contentSidebarController.refresh?.();
        return;
    }
    // pushState, popstate, and hashchange are all route-only events: when the
    // rail root is intact, notifyRoute re-derives the active destination in
    // place instead of re-applying (which would rebuild the rail DOM, discard
    // scroll position, and churn the page observer).
    if (reason === "history" || reason === "popstate" || reason === "hashchange") {
        if (contentSidebarController.needsRefresh(options)) contentSidebarController.apply(options);
        else contentSidebarController.notifyRoute?.();
        return;
    }
    contentSidebarController.apply(options);
}

function initializeCalendarOverlay() {
    if (!contentCalendarOverlayApi?.createCalendarOverlayController || contentCalendarOverlayController) return;
    contentCalendarOverlayController = contentCalendarOverlayApi.createCalendarOverlayController({
        window,
        document,
        chromeApi: chrome,
        contextService: contentContextService,
        getContext: () => contentContextService?.getContext?.(),
        getMode: () => options?.canvas_calendar_mode,
        getFlags: async () => (await chrome.storage.local?.get?.(["platform.flags"])) || {},
        onStatus: (status) => { if (status?.state === "error") logError(); }
    });
    contentCalendarOverlayController.init({ mode: options?.canvas_calendar_mode });
}

const TODO_ACCOUNT_KEY_PATTERN = /^[a-f0-9]{64}$/;
// Same-document route changes never change the task feed; a rail view from
// the last minute is re-rendered in place and only revalidated after this
// window. Keeps hard refetches off the soft-navigation path.
const TODO_ROUTE_REVALIDATE_MS = 60000;
// Canvas can paint the cards and right rail in separate commits after a hard
// reload or analytics route return. Retry only a short bounded handoff; the
// normal lifecycle remains the long-lived source of route changes.
const TODO_RAIL_READY_ATTEMPTS = 20;
const TODO_RAIL_READY_DELAY_MS = 100;
// Canvas can finish painting before its identity endpoint is ready after a
// hard reload. Keep that separate from anchor readiness: a verified binding
// is required before any task data is mounted, but a temporary miss must not
// permanently remove the rail after its initial loading shell has painted.
const TODO_BINDING_READY_ATTEMPTS = 20;
const TODO_BINDING_READY_DELAY_MS = 250;

function todoSettingsSnapshot(values = {}) {
    const migrated = contentTodoSchemaApi?.migrateTodoSettings?.(values) || { settings: { ...values }, changes: {} };
    const todoSettings = contentTodoSchemaApi?.todoSettingsSnapshot
        ? contentTodoSchemaApi.todoSettingsSnapshot(migrated.settings)
        : { ...migrated.settings };
    // `todoSettingsSnapshot()` is intentionally scoped to todo_* keys for
    // its many settings-only callers. The planner writer is a separate,
    // default-off Phase 1 preference, however, and its content-side feature
    // gate must retain that normalized value rather than silently treating
    // every persisted opt-in as false.
    const phaseOne = contentTodoSchemaApi?.migratePhaseOneSettings?.(migrated.settings) || { settings: migrated.settings };
    return {
        migrated,
        settings: {
            ...todoSettings,
            planner_tasks_enabled: phaseOne?.settings?.planner_tasks_enabled === true
        }
    };
}

function todoSettingsChanged(changes) {
    return Object.keys(changes || {}).some((key) => key === "planner_tasks_enabled" || key === "todo_settings_version" || key.startsWith("todo_"));
}

function todoCourseCardsOwnAssignments(settings = options) {
    return settings?.todo_enabled !== false && settings?.todo_course_card_tasks_enabled !== false;
}

function todoNodeAttribute(node, name) {
    return node?.getAttribute?.(name) || "";
}

function todoNodeOwned(node) {
    let current = node;
    while (current) {
        const marker = todoNodeAttribute(current, "data-apstudycanvas-owned");
        if (marker && marker.startsWith("todo-")) return true;
        current = current.parentNode;
    }
    return false;
}

function todoResponseBody(response) {
    if (response && Object.prototype.hasOwnProperty.call(response, "payload")) return response.payload;
    return response;
}

function createTodoRuntimeMessage(type, payload, requestId) {
    const contract = globalThis.APStudyCanvasPlatform?.Contract;
    if (contract?.createEnvelope) return contract.createEnvelope(type, payload, requestId);
    return { version: 1, request_id: requestId, type, payload };
}

function sendTodoRuntimeMessage(type, payload, { requestId, signal } = {}) {
    if (signal?.aborted) return Promise.reject(Object.assign(new Error("The task request was cancelled."), { name: "AbortError" }));
    if (typeof chrome?.runtime?.sendMessage !== "function") return Promise.resolve({ ok: false, state: "unavailable", error: { code: "NEST_RUNTIME_UNAVAILABLE" } });
    const id = requestId || `todo-runtime-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const message = createTodoRuntimeMessage(type, payload, id);
    return new Promise((resolve, reject) => {
        let settled = false;
        let returned;
        const cleanup = () => signal?.removeEventListener?.("abort", onAbort);
        const settle = (error, value) => {
            if (settled) return;
            settled = true;
            cleanup();
            if (error) reject(error);
            else resolve(todoResponseBody(value));
        };
        const onAbort = () => settle(Object.assign(new Error("The task request was cancelled."), { name: "AbortError" }));
        signal?.addEventListener?.("abort", onAbort, { once: true });
        try {
            returned = chrome.runtime.sendMessage(message, (response) => settle(null, response));
        } catch (error) {
            settle(error);
            return;
        }
        if (returned && typeof returned.then === "function") returned.then((value) => settle(null, value), (error) => settle(error));
    });
}

function createTodoNestAdapter() {
    return {
        todos: {
            list(query, options = {}) {
                return sendTodoRuntimeMessage("NEST_TODOS_GET", query, options);
            },
            create(payload, options = {}) {
                return sendTodoRuntimeMessage("NEST_TODO_CREATE", payload, options);
            },
            setCompletion(taskId, payload, options = {}) {
                return sendTodoRuntimeMessage("NEST_TODO_COMPLETION_SET", { task_id: String(taskId), completed: payload?.completed === true }, options);
            }
        }
    };
}

function storageAreaGet(area, key) {
    if (!area?.get) return Promise.resolve({});
    return new Promise((resolve) => {
        let settled = false;
        const finish = (value) => {
            if (settled) return;
            settled = true;
            resolve(value && typeof value === "object" ? value : {});
        };
        try {
            const returned = area.get(key, finish);
            if (returned && typeof returned.then === "function") returned.then(finish, () => finish({}));
        } catch (error) {
            finish({});
        }
    });
}

function storageAreaSet(area, value) {
    if (typeof area?.set !== "function") return Promise.reject(new Error("STORAGE_SET_UNAVAILABLE"));
    // Chrome supports both Promise and callback storage APIs. Do not treat an
    // undefined callback-API return as a completed write: callers that change
    // page eligibility must wait until storage has actually acknowledged it.
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error) => {
            if (settled) return;
            settled = true;
            error ? reject(error) : resolve();
        };
        const callback = () => {
            const lastError = chrome?.runtime?.lastError;
            finish(lastError ? new Error(lastError.message || "STORAGE_SET_FAILED") : null);
        };
        try {
            const returned = area.set(value, callback);
            if (returned && typeof returned.then === "function") returned.then(() => finish(null), finish);
            // Synchronous test doubles expose a one-argument setter. Production
            // callback implementations receive the callback above instead.
            else if (area.set.length < 2) finish(null);
        } catch (error) {
            finish(error);
        }
    });
}

// Canvas renders the dashboard institution mark outside the extension-owned
// rail on some dashboard variants. Own the mark by its Canvas-specific class,
// regardless of which dashboard wrapper Canvas chooses.
const TODO_INSTITUTION_LOGO_SELECTOR = ".ic-sidebar-logo, .ic-sidebar-logo__image";
const TODO_INSTITUTION_LOGO_OWNERSHIP_ATTRIBUTE = "data-apstudycanvas-todo-logo-visibility";

function createTodoInstitutionLogoController(documentRef) {
    const records = new Map();

    function restoreAttribute(node, name, hadAttribute, value) {
        if (hadAttribute) node.setAttribute?.(name, value);
        else node.removeAttribute?.(name);
    }

    function hide() {
        const logos = Array.from(documentRef?.querySelectorAll?.(TODO_INSTITUTION_LOGO_SELECTOR) || []);
        logos.forEach((logo) => {
            if (!logo || records.has(logo)) return;
            records.set(logo, {
                hadHidden: logo.getAttribute?.("hidden") !== null,
                hidden: logo.getAttribute?.("hidden"),
                hadAriaHidden: logo.getAttribute?.("aria-hidden") !== null,
                ariaHidden: logo.getAttribute?.("aria-hidden"),
                hadStyle: logo.getAttribute?.("style") !== null,
                style: logo.getAttribute?.("style"),
                hadOwnership: logo.getAttribute?.(TODO_INSTITUTION_LOGO_OWNERSHIP_ATTRIBUTE) !== null,
                ownership: logo.getAttribute?.(TODO_INSTITUTION_LOGO_OWNERSHIP_ATTRIBUTE)
            });
            logo.hidden = true;
            if (typeof logo.style?.setProperty === "function") logo.style.setProperty("display", "none", "important");
            else logo.setAttribute?.("style", `${logo.getAttribute?.("style") || ""}; display: none !important;`);
            logo.setAttribute?.("aria-hidden", "true");
            logo.setAttribute?.(TODO_INSTITUTION_LOGO_OWNERSHIP_ATTRIBUTE, "hidden");
        });
        return logos.length;
    }

    function restore() {
        records.forEach((record, logo) => {
            restoreAttribute(logo, "hidden", record.hadHidden, record.hidden);
            restoreAttribute(logo, "aria-hidden", record.hadAriaHidden, record.ariaHidden);
            restoreAttribute(logo, "style", record.hadStyle, record.style);
            restoreAttribute(logo, TODO_INSTITUTION_LOGO_OWNERSHIP_ATTRIBUTE, record.hadOwnership, record.ownership);
        });
        records.clear();
    }

    function apply(visible) {
        if (visible === false) return hide();
        restore();
        return 0;
    }

    return Object.freeze({ apply, restore });
}

// One controller instance is shared by the document_start prepaint and the
// To-Do runtime so ownership records (and their exact restore) never split
// across two maps.
let todoInstitutionLogoControllerInstance = null;
let todoInstitutionLogoPrepaintObserver = null;

function todoInstitutionLogoController() {
    if (!todoInstitutionLogoControllerInstance) todoInstitutionLogoControllerInstance = createTodoInstitutionLogoController(document);
    return todoInstitutionLogoControllerInstance;
}

function todoInstitutionLogoVisible() {
    return todoSettingsSnapshot(options).settings.todo_institution_logo_visible === true;
}

// Prepaint applies the current preference while Canvas is still inserting the
// mark. Before settings resolve, the schema's opt-out default is used; once a
// saved opt-in is available, the same controller restores the mark.
function startTodoInstitutionLogoPrepaint() {
    if (todoInstitutionLogoPrepaintObserver) return;
    const controller = todoInstitutionLogoController();
    if (typeof MutationObserver !== "function") {
        controller.apply(todoInstitutionLogoVisible());
        return;
    }
    const scan = () => {
        if (!todoInstitutionLogoPrepaintObserver) return;
        controller.apply(todoInstitutionLogoVisible());
        if ((document.querySelector?.("#right-side") || document.querySelector?.("#planner-todosidebar-item-list")) && !contentTodoIntegration?.getState?.().mounted) {
            contentTodoIntegration?.schedule?.("todo-target-ready");
        }
    };
    scan();
    todoInstitutionLogoPrepaintObserver = new MutationObserver(scan);
    todoInstitutionLogoPrepaintObserver.observe(document.documentElement || document, { childList: true, subtree: true });
}

function stopTodoInstitutionLogoPrepaint() {
    if (!todoInstitutionLogoPrepaintObserver) return;
    todoInstitutionLogoPrepaintObserver.disconnect();
    todoInstitutionLogoPrepaintObserver = null;
}

// Unapproved origins never run the To-Do runtime, so the prepaint must undo
// itself and restore the exact pre-prepaint attributes.
function abandonTodoInstitutionLogoPrepaint() {
    stopTodoInstitutionLogoPrepaint();
    todoInstitutionLogoController().restore();
}

// Canvas's authoritative course colors: GET /api/v1/users/self/colors returns
// { custom_colors: { "course_<id>": "#hex" } } for colors the user (or the
// institution) assigned in Canvas. The sidebar model's course_color is usually
// null, so without this merge the rail fell back to palette picks that
// collided across displayed courses. The cache is keyed by Canvas origin and
// lives for the page session: rerenders and SPA re-renders reuse the same
// stable course_<id> values instead of re-deriving or randomizing.
const todoCustomColorsState = { cache: new Map(), failureAt: new Map(), retryMs: 60000 };

function adoptCanvasCustomColors(origin, result) {
    if (!origin) return false;
    if (result?.ok !== true) {
        todoCustomColorsState.failureAt.set(origin, Date.now());
        return false;
    }
    todoCustomColorsState.failureAt.delete(origin);
    const colors = result.colors && typeof result.colors === "object" ? result.colors : {};
    const previous = todoCustomColorsState.cache.get(origin) || {};
    todoCustomColorsState.cache.set(origin, colors);
    return JSON.stringify(previous) !== JSON.stringify(colors);
}

function canvasCustomColorsFor(origin) {
    return todoCustomColorsState.cache.get(origin) || null;
}

// Merge the authoritative Canvas colors over the supplied rail course
// records. A course_<id> entry wins outright (manual Canvas colors are the
// user's own choice); missing ids and missing colors pass through untouched
// so the rail's deterministic collision-avoided fallbacks stay in charge.
function mergeCanvasCustomColors(courses, colors) {
    if (!colors || typeof colors !== "object") return Array.isArray(courses) ? courses : [];
    return (Array.isArray(courses) ? courses : []).map((course) => {
        const id = String(course?.id ?? "").trim();
        const authoritative = id ? colors[`course_${id}`] : null;
        if (!authoritative || authoritative === course?.color) return course;
        return { ...course, color: authoritative };
    });
}

function maybeFetchCanvasCustomColors(origin, signal) {
    if (!contentTodoApi?.fetchCanvasCustomColors) return Promise.resolve(null);
    if (todoCustomColorsState.cache.has(origin)) return Promise.resolve(null);
    const failedAt = todoCustomColorsState.failureAt.get(origin) || 0;
    if (Number.isFinite(failedAt) && failedAt > 0 && Date.now() - failedAt < todoCustomColorsState.retryMs) return Promise.resolve(null);
    return contentTodoApi.fetchCanvasCustomColors({ fetchImpl: (...args) => fetch(...args), origin, signal });
}

// Scroll ownership is settings-owned and fully reversible: the explicit
// todo_separate_scrollbar compatibility opt-in gives the Canvas sidebar
// wrapper one sticky viewport-bounded frame (the rail inside it is the only
// scrollport); the default clears every inline scroll/height value so the
// wrapper stays in the document flow and the rail moves with the Canvas page
// exactly like the competitor's default. Retired owners left sticky/height
// inline values behind; without this reconcile they would double-scroll or
// pin the rail against the current setting.
function reconcileRightSideWrapperScroll() {
    const wrapper = document.getElementById("right-side-wrapper");
    if (!wrapper?.style) return;
    if (options?.todo_separate_scrollbar === true) {
        wrapper.style.setProperty("position", "sticky");
        wrapper.style.setProperty("top", "0");
        wrapper.style.setProperty("height", "calc(100dvh - 48px)");
        wrapper.style.setProperty("overflow-y", "auto");
        return;
    }
    ["position", "top", "height", "overflow-y"].forEach((property) => wrapper.style.removeProperty(property));
}

function createTodoIntegration() {
    if (!contentTodoTimeApi?.buildRange
        || !contentTodoModelApi?.normalizeCanvasTask
        || !contentTodoModelApi?.normalizeNestTask
        || !contentTodoApi?.createTodoApi
        || !contentTodoStreakApi?.plan
        || !contentTodoRailApi?.create
        || !contentTodoCourseCardsApi?.create
        || !contentPlannerTasksApi?.createTransport) return null;

    let destroyed = false;
    let generation = 0;
    let timer = null;
    let refreshAbortController = null;
    let rangeOverride = null;
    let binding = null;
    let nativeRail = null;
    let nativeNodes = new Map();
    let nativeObserver = null;
    let railHost = null;
    let rail = null;
    let railMounted = false;
    let railPlacement = "";
    let railDiagnostic = "missing-anchor";
    let railReadyTimer = null;
    let railReadyAttempts = 0;
    let bindingReadyTimer = null;
    let bindingReadyAttempts = 0;
    let rolloverTimer = null;
    let rolloverDayKey = "";
    let plannerTaskTransport = null;
    let plannerPageTransport = null;
    let plannerTransportGeneration = 0;
    let activePlannerOperations = 0;
    const cardRenderers = new Map();
    const institutionLogo = todoInstitutionLogoController();
    const streakHistoryCoordinator = contentTodoStreakApi.createHistoryCoordinator({
        read: async () => {
            const stored = await storageAreaGet(chrome.storage.local, contentTodoStreakApi.STORAGE_KEY);
            const all = stored?.[contentTodoStreakApi.STORAGE_KEY];
            return all && typeof all === "object" && !Array.isArray(all) ? all : {};
        },
        write: (all) => storageAreaSet(chrome.storage.local, { [contentTodoStreakApi.STORAGE_KEY]: all })
    });
    function plannerTasksFeatureEnabled() {
        // This opt-in is intentionally local to the user's Canvas session.
        // The transport, ownership marker, CSRF requirement, route teardown,
        // and rail's explicit action remain independent fail-closed guards.
        return settings().planner_tasks_enabled === true;
    }

    function disposePlannerTaskTransport() {
        // A Canvas same-document route can replace the authenticated page
        // context while a write is in flight. Dispose both halves first, then
        // make every caller that captured the prior generation fail stale.
        // The planner domain preserves ambiguous POSTs as uncertain; this
        // boundary never retries them on the new route.
        plannerTransportGeneration += 1;
        plannerTaskTransport?.dispose?.();
        plannerPageTransport?.dispose?.();
        plannerTaskTransport = null;
        plannerPageTransport = null;
    }

    function resetPlannerTaskTransport() {
        disposePlannerTaskTransport();
        // Do not leave an inert transport associated with a disabled feature
        // or unsupported Canvas surface. A later enabled, supported-route
        // lifecycle creates the current page-bound transport exactly once.
        if (!plannerTasksFeatureEnabled() || !routeIsSupported()) return null;
        plannerPageTransport = globalThis.APStudyCanvasContent?.PlannerPageTransport?.create?.({ runtime: chrome.runtime, origin: domain }) || null;
        plannerTaskTransport = contentPlannerTasksApi.createTransport({
            fetchImpl: plannerPageTransport?.fetchImpl || ((...args) => fetch(...args)),
            origin: domain,
            document,
            enabled: true
        });
        return plannerTaskTransport;
    }

    function stalePlannerRouteResult() {
        return { ok: false, state: "stale", error: { code: "PLANNER_REQUEST_STALE_ROUTE", message: "Canvas changed before this planner request could finish. Your draft was not retried." } };
    }

    async function runPlannerOperation(operation) {
        const operationGeneration = plannerTransportGeneration;
        activePlannerOperations += 1;
        try {
            const result = await operation();
            return operationGeneration === plannerTransportGeneration && !destroyed ? result : stalePlannerRouteResult();
        } catch (error) {
            if (operationGeneration !== plannerTransportGeneration || destroyed) return stalePlannerRouteResult();
            throw error;
        } finally {
            activePlannerOperations = Math.max(0, activePlannerOperations - 1);
        }
    }

    function plannerNoteResourceId(item) {
        const raw = item && typeof item === "object" ? item : {};
        const nested = raw.plannable && typeof raw.plannable === "object" ? raw.plannable : {};
        const numericId = (value) => {
            const normalized = String(value ?? "").trim();
            return /^\d+$/.test(normalized) ? normalized : null;
        };
        const supplied = (value) => value !== null && value !== undefined && String(value).trim() !== "";
        const outerSupplied = supplied(raw.plannable_id);
        const nestedSupplied = supplied(nested.id);
        const outer = numericId(raw.plannable_id);
        const inner = numericId(nested.id);
        // Canvas's Planner feed has both a transient row id and the mutable
        // Planner Note resource id.  Only matching (or one-sided) resource
        // ids are safe to mutate.  An invalid or disagreeing pair is visible
        // for the student, but deliberately has no write target.
        const conflict = (outerSupplied && !outer) || (nestedSupplied && !inner) || Boolean(outer && inner && outer !== inner);
        return { id: conflict ? null : outer || inner, conflict };
    }

    function plannerBindingTimeZone(record = binding) {
        // `binding.timeZone` is the presentation clock assembled by
        // `resolveBinding()` and may be the browser fallback. It is not proof
        // of the Canvas account's Planner timezone, so only an explicitly
        // verified context tier may participate in Planner date conversion.
        return record && Object.prototype.hasOwnProperty.call(record, "plannerTimeZone")
            ? record.plannerTimeZone
            : undefined;
    }

    function plannerNoteTodoDateKey(value, { bindingTimeZone } = {}) {
        const source = String(value ?? "").trim();
        // Planner Notes are intentionally date-only in APStudyCanvas. Canvas
        // may round-trip such a value as an ISO instant at the account's local
        // midnight; convert that representation with the account/task zone,
        // never by slicing a UTC string (which changes calendar days east or
        // west of UTC). Invalid values deliberately remain null so the strict
        // Planner transport fails closed before it can construct a mutation.
        if (contentTodoTimeApi.dateKeyValid?.(source)) return source;
        // `resolveTimeZone()` is intentionally not used here: it treats an
        // invalid argument as permission to substitute the browser zone. That
        // remains useful for rail presentation, but is unsafe for a Planner
        // mutation. Only the authenticated profile timezone may convert ISO.
        const validZone = (candidate) => contentTodoTimeApi.validTimeZone?.(candidate) || null;
        const zone = validZone(bindingTimeZone);
        if (!zone) return null;
        return contentTodoTimeApi.localDateKey?.(source, zone) || null;
    }

    function plannerNoteTarget(task, { requiresTodoDate = true } = {}) {
        const raw = task?.raw && typeof task.raw === "object" ? task.raw : {};
        const nested = raw.plannable && typeof raw.plannable === "object" ? raw.plannable : {};
        const resource = plannerNoteResourceId(raw);
        if (!resource.id) return { note: null, failure: plannerNoteTargetFailure() };
        const courseId = (value) => {
            const normalized = String(value ?? "").trim();
            return /^\d+$/.test(normalized) ? normalized : undefined;
        };
        const todoDate = plannerNoteTodoDateKey(raw.todo_date ?? nested.todo_date ?? task?.due?.date, {
            bindingTimeZone: plannerBindingTimeZone()
        });
        if (requiresTodoDate && !todoDate) {
            return {
                note: null,
                failure: {
                    ok: false,
                    state: "unavailable",
                    error: {
                        code: "PLANNER_TIMEZONE_UNAVAILABLE",
                        message: "Canvas account timezone is unavailable. Reload Canvas before editing or completing this task."
                    }
                }
            };
        }
        return { note: {
            // Keep the owned-note fields explicit: compact planner rows often
            // expose only context_code, which the normalized task translates
            // to task.course.id. A completion or edit must not clear it.
            id: resource.id,
            title: nested.title ?? raw.title ?? raw.name ?? task?.title,
            // `plannerItem()` projects the one canonical date-key into the
            // mapped top-level field. Prefer it over the nested transport
            // shape so display, edit, and completion cannot disagree.
            todo_date: todoDate,
            course_id: courseId(nested.course_id ?? raw.course_id ?? task?.course?.id),
            details: nested.details ?? raw.details
        }, failure: null };
    }

    function plannerNoteFromTask(task) {
        return plannerNoteTarget(task).note;
    }

    function plannerNoteTargetFailure() {
        return { ok: false, state: "forbidden", error: { code: "PLANNER_NOTE_ID_CONFLICT", message: "Canvas returned conflicting planner note identifiers. Reload before trying again." } };
    }

    async function setPlannerNoteCompletion(task, payload, request = {}) {
        // Check provenance before constructing a request. The transport repeats
        // the marker check, which makes an accidental caller fail closed too.
        if (task?.source !== "canvas-planner-note" || task?.mutationAuthority !== "canvas_planner_note") {
            return { ok: false, state: "forbidden", error: { code: "PLANNER_NOTE_NOT_OWNED", message: "Only APStudy-created planner notes can be changed." } };
        }
        if (!plannerTasksFeatureEnabled()) return { ok: false, state: "disabled", error: { code: "PLANNER_TASKS_DISABLED", message: "Enable Canvas planner tasks before editing one." } };
        const target = plannerNoteTarget(task);
        if (!target.note) return target.failure;
        const note = target.note;
        const parts = contentPlannerTasksApi.splitDetails?.(note.details) || { description: "" };
        const transport = plannerTaskTransport || resetPlannerTaskTransport();
        if (!transport) return stalePlannerRouteResult();
        return runPlannerOperation(() => transport.update(note, {
            title: note.title,
            todoDate: note.todo_date,
            courseId: note.course_id,
            description: parts.description,
            link: parts.link,
            completed: payload?.completed === true
        }, request));
    }

    async function createPlannerTask(draft, request = {}) {
        if (!plannerTasksFeatureEnabled()) {
            return { ok: false, state: "disabled", error: { code: "PLANNER_TASKS_DISABLED", message: "Enable Canvas planner tasks in APStudy settings before creating one." } };
        }
        const transport = plannerTaskTransport || resetPlannerTaskTransport();
        return transport ? runPlannerOperation(() => transport.create(draft, request)) : stalePlannerRouteResult();
    }

    async function updatePlannerTask(task, draft, request = {}) {
        if (!plannerTasksFeatureEnabled()) return { ok: false, state: "disabled", error: { code: "PLANNER_TASKS_DISABLED", message: "Enable Canvas planner tasks before editing one." } };
        const target = plannerNoteTarget(task);
        if (!target.note) return target.failure;
        const note = target.note;
        const transport = plannerTaskTransport || resetPlannerTaskTransport();
        return transport ? runPlannerOperation(() => transport.update(note, draft, request)) : stalePlannerRouteResult();
    }

    function plannerTaskDraft(task) {
        const note = plannerNoteFromTask(task);
        if (!note) return {};
        const parts = contentPlannerTasksApi.splitDetails?.(note.details) || { description: "" };
        return { title: note.title, todoDate: note.todo_date, courseId: note.course_id, description: parts.description, link: parts.link || "" };
    }

    async function deletePlannerTask(task, request = {}) {
        if (!plannerTasksFeatureEnabled()) return { ok: false, state: "disabled", error: { code: "PLANNER_TASKS_DISABLED", message: "Enable Canvas planner tasks before deleting one." } };
        const target = plannerNoteTarget(task, { requiresTodoDate: false });
        if (!target.note) return target.failure;
        const note = target.note;
        const transport = plannerTaskTransport || resetPlannerTaskTransport();
        return transport ? runPlannerOperation(() => transport.remove(note, request)) : stalePlannerRouteResult();
    }

    resetPlannerTaskTransport();
    const canvasTodoApi = contentTodoApi.createTodoApi({
        nest: createTodoNestAdapter(),
        canvas: { writePlannerOverride, markAnnouncementRead, setPlannerNoteCompletion },
        manualState: {
            get: async (key) => (await storageAreaGet(chrome.storage.local, key))?.[key],
            set: (key, value) => storageAreaSet(chrome.storage.local, { [key]: value })
        }
    });

    function settings() {
        return todoSettingsSnapshot(options).settings;
    }

    function routeIsSupported() {
        return current_page === "/"
            || current_page === ""
            || current_page === "/courses"
            || /^\/courses\/\d+(?:\/|$)/.test(current_page || "");
    }

    function enabled() { return settings().todo_enabled !== false; }

    function abortRefresh() {
        if (!refreshAbortController) return;
        try { refreshAbortController.abort(); } catch (error) {}
        refreshAbortController = null;
    }

    function currentTimeZone() {
        // The To-Do clock is presentation/range state only. It must never be
        // reused as authority for a serialized Planner Note date.
        return contentTodoTimeApi.resolveTimeZone(contentTodoTimeApi.browserTimeZone?.());
    }

    // The rail authors custom windows through rangeOverride (starting today,
    // todo_custom_range_days long) because custom start/end pairs are not
    // persisted settings. A settings echo clears the override, so a custom
    // timeframe must still rebuild a valid rolling window here or every
    // refresh after the echo fails with TODO_RANGE_UNAVAILABLE.
    function todoRefreshRange(currentSettings) {
        if (currentSettings?.todo_timeframe === "custom") {
            const start = contentTodoTimeApi.localDateKey(Date.now(), currentTimeZone());
            const days = Math.min(90, Math.max(1, Math.round(Number(currentSettings.todo_custom_range_days) || 7)));
            const end = start ? contentTodoTimeApi.shiftDateKey(start, days - 1) : null;
            const custom = start && end ? contentTodoTimeApi.buildRange({ timeframe: "custom", customStart: start, customEnd: end })?.value : null;
            if (custom) return custom;
        }
        return contentTodoTimeApi.buildRange({ timeframe: currentSettings.todo_timeframe, now: Date.now(), timeZone: currentTimeZone(), customStart: currentSettings.todo_custom_start, customEnd: currentSettings.todo_custom_end })?.value;
    }

    function cardCourses() {
        return Array.from(document.querySelectorAll?.(".ic-DashboardCard") || []).map((card) => {
            const link = card.querySelector?.(".ic-DashboardCard__link, a[href*='/courses/']");
            const href = link?.getAttribute?.("href") || link?.href || "";
            const match = String(href).match(/\/courses\/(\d+)/);
            const id = card.getAttribute?.("data-course-id") || match?.[1] || "";
            const title = card.querySelector?.(".ic-DashboardCard__header-title, .ic-DashboardCard__header_title, .ic-DashboardCard__header a")?.textContent?.trim();
            const code = card.querySelector?.(".ic-DashboardCard__course-code, .ic-DashboardCard__header-subtitle")?.textContent?.trim();
            return { card, course: { id, name: title || code || (id ? `Course ${id}` : "Course"), code, label: title || code || (id ? `Course ${id}` : "Course") } };
        }).filter(({ course }) => course.id);
    }

    function captureNativeNode(node) {
        if (!node || node === railHost || todoNodeOwned(node) || nativeNodes.has(node)) return;
        const record = {
            hidden: Boolean(node.hidden),
            ariaHidden: node.getAttribute?.("aria-hidden"),
            hadAriaHidden: node.getAttribute?.("aria-hidden") !== null
        };
        nativeNodes.set(node, record);
        node.hidden = true;
        node.setAttribute?.("aria-hidden", "true");
    }

    function captureNativeRail(host) {
        if (!host) return;
        if (nativeRail !== host) {
            restoreNativeRail();
            nativeRail = host;
            Array.from(host.children || host.childNodes || []).forEach(captureNativeNode);
            if (typeof MutationObserver === "function") {
                nativeObserver = new MutationObserver((records) => {
                    records.forEach((record) => {
                        Array.from(record.addedNodes || []).forEach((node) => {
                            if (node?.parentNode === nativeRail) captureNativeNode(node);
                        });
                    });
                });
                nativeObserver.observe(host, { childList: true });
            }
        } else {
            Array.from(host.children || host.childNodes || []).forEach(captureNativeNode);
        }
    }

    function restoreNativeRail() {
        nativeObserver?.disconnect?.();
        nativeObserver = null;
        nativeNodes.forEach((record, node) => {
            if (node.parentNode !== nativeRail) return;
            node.hidden = record.hidden;
            if (record.hadAriaHidden) node.setAttribute?.("aria-hidden", record.ariaHidden);
            else node.removeAttribute?.("aria-hidden");
        });
        nativeNodes = new Map();
        nativeRail = null;
    }

    function removeRail() {
        institutionLogo.restore();
        rail?.destroy?.();
        rail = null;
        railMounted = false;
        railHost?.remove?.();
        railHost = null;
        railPlacement = "";
        restoreNativeRail();
        // A removed rail leaves no scroll owner behind: stale wrapper inline
        // styles must not pin or scroll the emptied sidebar column.
        reconcileRightSideWrapperScroll();
    }

    function clearRailReadiness() {
        if (railReadyTimer !== null) clearTimeout(railReadyTimer);
        railReadyTimer = null;
        railReadyAttempts = 0;
    }

    function scheduleRailReadiness(reason = "anchor") {
        if (destroyed || !enabled() || !routeIsSupported() || railMounted || railReadyTimer !== null) return;
        if (railReadyAttempts >= TODO_RAIL_READY_ATTEMPTS) return;
        railReadyAttempts += 1;
        railReadyTimer = setTimeout(() => {
            railReadyTimer = null;
            if (destroyed || !enabled() || !routeIsSupported() || railMounted) return;
            if (lastView) {
                try { render({ ...lastView, courses: displayedRailCourses() }); } catch (error) { schedule("rail-anchor-retry"); }
            } else {
                schedule("rail-anchor-retry");
            }
            if (!railMounted) scheduleRailReadiness(reason);
        }, TODO_RAIL_READY_DELAY_MS);
    }

    function clearBindingReadiness() {
        if (bindingReadyTimer !== null) clearTimeout(bindingReadyTimer);
        bindingReadyTimer = null;
        bindingReadyAttempts = 0;
    }

    function scheduleBindingReadiness() {
        if (destroyed || !enabled() || !routeIsSupported() || bindingReadyTimer !== null) return false;
        if (bindingReadyAttempts >= TODO_BINDING_READY_ATTEMPTS) return false;
        bindingReadyAttempts += 1;
        bindingReadyTimer = setTimeout(() => {
            bindingReadyTimer = null;
            if (destroyed || !enabled() || !routeIsSupported()) return;
            refresh("canvas-binding-retry").catch((error) => logError(error));
        }, TODO_BINDING_READY_DELAY_MS);
        return true;
    }

    // Canvas's current Dashboard no longer exposes the historical #right-side
    // rail. Its native To Do list is still stable, but is React-owned: never
    // mount into it (TodoRightRail.mount clears its host) and never capture it
    // as a native rail (captureNativeRail hides its children). The sibling we
    // create below is deliberately an extension-owned, normal-flow boundary.
    function dashboardNativeTodoRegion() {
        const list = document.querySelector?.("#planner-todosidebar-item-list");
        if (!list) return null;
        let candidate = list.parentNode;
        for (let depth = 0; candidate && depth < 5; depth += 1, candidate = candidate.parentNode) {
            if (candidate === document.body || candidate === document.documentElement) break;
            if (candidate !== list && nativeTodoRegionOwnsList(candidate, list)) return candidate;
        }
        return null;
    }

    function nativeTodoRegionOwnsList(region, list) {
        if (!region?.contains?.(list)) return false;
        const id = String(region.getAttribute?.("id") || "").toLowerCase();
        const testId = String(region.getAttribute?.("data-testid") || "").toLowerCase();
        // These are Canvas's explicit region identities when present. The
        // semantic fallback below accommodates their responsive React markup
        // without accepting a generic column or the list's unqualified parent.
        if (id === "planner-todosidebar" || testId === "planner-todosidebar" || testId === "planner-todosidebar-container") return true;
        const lists = Array.from(region.querySelectorAll?.("#planner-todosidebar-item-list") || []);
        if (lists.length !== 1 || lists[0] !== list) return false;
        const headings = Array.from(region.querySelectorAll?.("h1, h2, h3, h4, h5, h6, [role='heading']") || []);
        const toDoHeading = headings.find((heading) => String(heading.textContent || "").replace(/\s+/g, " ").trim().toLowerCase() === "to do");
        if (!toDoHeading) return false;
        const labelledBy = String(region.getAttribute?.("aria-labelledby") || "").split(/\s+/).filter(Boolean);
        const labelsToDo = labelledBy.includes(String(toDoHeading.getAttribute?.("id") || ""));
        const className = String(region.getAttribute?.("class") || "");
        return (String(region.getAttribute?.("role") || "").toLowerCase() === "region" && labelsToDo)
            || /(?:^|\s)ToDoSidebar(?:__|\s|$)/.test(className);
    }

    function immediateFollowingElement(node) {
        const children = Array.from(node?.parentNode?.children || []);
        const index = children.indexOf(node);
        return index >= 0 ? children[index + 1] || null : null;
    }

    function dashboardNativeTodoHost(region) {
        const parent = region?.parentNode;
        if (!parent || parent === document.body || parent === document.documentElement) return null;
        const next = immediateFollowingElement(region);
        if (next?.getAttribute?.("data-apstudycanvas-owned") === "todo-right-rail-host"
            && next.getAttribute?.("data-apstudycanvas-todo-placement") === "dashboard-native-todo-adjacent") return next;
        const host = document.createElement("div");
        host.setAttribute("data-apstudycanvas-owned", "todo-right-rail-host");
        host.setAttribute("data-apstudycanvas-todo-placement", "dashboard-native-todo-adjacent");
        parent.insertBefore(host, next);
        return host;
    }

    function removeOrphanedOwnedRailHosts(keep = null) {
        Array.from(document.querySelectorAll?.('[data-apstudycanvas-owned="todo-right-rail-host"]') || []).forEach((host) => {
            if (host !== keep && host !== railHost) host.remove?.();
        });
    }

    function placementFailureReason() {
        const dashboard = current_page === "/" || current_page === "";
        const width = Number(window.innerWidth);
        const medium = Number.isFinite(width) && width >= 768 && width <= 1100;
        return dashboard && medium ? "missing-cards-anchor" : "missing-anchor";
    }

    function placement() {
        const railTarget = document.querySelector?.("#right-side");
        const cardsTarget = document.querySelector?.("#DashboardCard_Container") || document.querySelector?.(".ic-DashboardCard__box__container");
        const width = Number(window.innerWidth);
        const medium = Number.isFinite(width) && width >= 768 && width <= 1100;
        // The card anchor belongs only to Canvas's dashboard. Course routes
        // still expose the native right-side rail at tablet widths, but do not
        // render dashboard cards; choosing the card anchor there caused the
        // bounded readiness retry to expire and removed To-Do. Keep courses
        // in their native rail at every width, while preserving the dashboard
        // below-card geometry precisely where that anchor exists.
        const dashboard = current_page === "/" || current_page === "";
        if (medium && dashboard) {
            if (!cardsTarget) return null;
            return { host: cardsTarget, value: "below-course-cards", native: railTarget };
        }
        if (railTarget) return { host: railTarget, value: "right-rail", native: railTarget };
        // Dashboard only: retain the native list, then place our own empty
        // sibling immediately after its verified region. Course pages never
        // infer a Dashboard anchor.
        if (!dashboard) return null;
        const nativeRegion = dashboardNativeTodoRegion();
        const host = dashboardNativeTodoHost(nativeRegion);
        return host ? { host, value: "dashboard-native-todo-adjacent", native: null, ownedHost: true } : null;
    }

    function ensureRail(view) {
        const target = placement();
        if (!target) {
            railDiagnostic = placementFailureReason();
            removeRail();
            scheduleRailReadiness("canvas-anchor");
            return false;
        }
        clearRailReadiness();
        reconcileRightSideWrapperScroll();
        if (target.ownedHost && railHost && railHost !== target.host) removeRail();
        removeOrphanedOwnedRailHosts(target.ownedHost ? target.host : railHost);
        captureNativeRail(target.native);
        if ((target.ownedHost ? railHost !== target.host : railHost?.parentNode !== target.host) || railPlacement !== target.value) {
            removeRail();
            captureNativeRail(target.native);
            railPlacement = target.value;
            railHost = target.ownedHost ? target.host : document.createElement("div");
            // An orphaned fallback host is extension-owned, so clear it before
            // handing it to mount. This preserves TodoRightRail's invariant
            // that it only ever receives an empty extension wrapper.
            railHost.replaceChildren?.();
            railHost.setAttribute("data-apstudycanvas-owned", "todo-right-rail-host");
            railHost.setAttribute("data-apstudycanvas-todo-placement", target.value);
            if (!target.ownedHost) target.host.appendChild(railHost);
            rail = contentTodoRailApi.create({
                document,
                window,
                domain: { state: contentTodoStateApi, time: contentTodoTimeApi, api: canvasTodoApi },
                completionDispatcher,
                describeTask: describeTodoTask,
                createNestTask,
                createPlannerTask,
                updatePlannerTask,
                deletePlannerTask,
                plannerTaskDraft,
                plannerTaskOperationId: () => contentPlannerTasksApi.makeStableId?.(),
                plannerTasksEnabled: plannerTasksFeatureEnabled,
                plannerCourses: () => displayedRailCourses(),
                onTaskCreated: () => schedule("nest-created"),
                onTimeframeChange: ({ range, settings: nextSettings } = {}) => {
                    rangeOverride = range || null;
                    // The rail leads: its select and range are already
                    // committed internally. The storage-derived snapshot must
                    // agree before the scheduled refresh renders, or the stale
                    // todo_timeframe merges back over the user's choice and
                    // the select visibly reverts to Week. Seed the in-memory
                    // options synchronously, then persist — the storage echo
                    // re-renders with identical values and converges.
                    const writes = {};
                    const timeframe = nextSettings?.todo_timeframe;
                    if (timeframe && timeframe !== options.todo_timeframe) {
                        options = { ...options, todo_timeframe: timeframe };
                        writes.todo_timeframe = timeframe;
                    }
                    const customDays = Math.round(Number(nextSettings?.todo_custom_range_days));
                    if (Number.isFinite(customDays) && customDays > 0 && customDays !== Number(options.todo_custom_range_days)) {
                        options = { ...options, todo_custom_range_days: customDays };
                        writes.todo_custom_range_days = customDays;
                    }
                    if (Object.keys(writes).length) void storageAreaSet(chrome.storage.sync, writes);
                    schedule("timeframe");
                },
                onOpenCalendarAccounts: () => ensureOverlayHost()?.open?.({ category: "calendar-accounts" }),
                onOpenCalendarSettings: () => ensureOverlayHost()?.open?.({ category: "calendar-accounts" }),
                onOpenTodoSettings: () => ensureOverlayHost()?.open?.({ category: "study-tools" }),
                onOpenGrades: () => { window.location.href = `${domain}/courses/${getCurrentCourseId() || ""}/grades`; },
                onConnectNest: () => ensureOverlayHost()?.open?.({ category: "calendar-accounts" })
            });
            const mounted = rail.mount({ ...view, host: railHost, placement: target.value });
            railMounted = mounted?.ok === true;
            railDiagnostic = railMounted ? "mounted" : "missing-anchor";
            return railMounted;
        }
        if (!railMounted) railMounted = rail.mount({ ...view, host: railHost, placement: target.value })?.ok === true;
        else rail.update({ ...view, placement: target.value });
        railDiagnostic = railMounted ? "mounted" : "missing-anchor";
        return railMounted;
    }

    // Session-authenticated Canvas writes are CSRF protected: Rails rejects
    // a non-GET request carrying only the session cookie with a bare 422
    // (Unprocessable Entity) HTML page. Canvas's own frontend sends the
    // token from the non-httpOnly _csrf_token cookie as X-CSRF-Token.
    function canvasCsrfToken() {
        const match = document.cookie?.match(/(?:^|;\s*)_csrf_token=([^;]*)/) || null;
        return match ? decodeURIComponent(match[1]) : "";
    }

    function canvasWriteHeaders(extra = {}) {
        const token = canvasCsrfToken();
        // A session write without the token is always rejected with a bare
        // 422, so fail fast with an actionable message instead.
        if (!token) return null;
        return { "X-CSRF-Token": token, ...extra };
    }

    const CANVAS_SESSION_TOKEN_ERROR = () => ({ ok: false, status: 0, body: { error: { code: "CANVAS_SESSION_TOKEN_UNAVAILABLE", message: "Canvas session token unavailable. Reload Canvas, then try again." } } });

    function writePlannerOverride(task, payload) {
        const overrideId = task?.mutation?.plannerOverrideId;
        if (!overrideId) return Promise.resolve({ ok: false, status: 409, body: { error: { code: "CANVAS_PLANNER_OVERRIDE_REQUIRED", message: "Canvas did not provide a planner override." } } });
        const headers = canvasWriteHeaders({ Accept: "application/json", "Content-Type": "application/json" });
        if (!headers) return Promise.resolve(CANVAS_SESSION_TOKEN_ERROR());
        return fetch(`${domain}/api/v1/planner/overrides/${encodeURIComponent(overrideId)}`, {
            method: "PUT",
            credentials: "include",
            headers,
            body: JSON.stringify(payload)
        }).then(async (response) => ({ ok: response.ok, status: response.status, body: await response.json().catch(() => ({})) }));
    }

    function announcementReadTarget(task) {
        const raw = task?.raw && typeof task.raw === "object" ? task.raw : {};
        const asId = (value) => String(value ?? "").trim();
        const contextCode = asId(raw.context_code);
        const courseId = asId(task?.course?.id) || asId(raw.course_id) || (contextCode.startsWith("course_") ? contextCode.slice(7) : "");
        const topicId = asId(task?.remoteId) || asId(raw.id);
        return /^\d+$/.test(courseId) && /^\d+$/.test(topicId) ? { courseId, topicId } : null;
    }

    // Canvas marks a discussion topic (and its entries) read for the current
    // user via the discussion_topics read endpoint — the same write Canvas's
    // own UI performs, so the change clears the unread state on Canvas itself.
    function markAnnouncementRead(task, payload) {
        const target = announcementReadTarget(task);
        const read = payload?.read !== false;
        if (!target) return Promise.resolve({ ok: false, status: 422, body: { error: { code: "CANVAS_ANNOUNCEMENT_TARGET_INVALID", message: "Canvas did not provide a course and topic for this announcement." } } });
        const headers = canvasWriteHeaders({ Accept: "application/json" });
        if (!headers) return Promise.resolve(CANVAS_SESSION_TOKEN_ERROR());
        return fetch(`${domain}/api/v1/courses/${target.courseId}/discussion_topics/${target.topicId}/read`, {
            method: read ? "PUT" : "DELETE",
            credentials: "include",
            headers
        }).then(async (response) => ({ ok: response.ok, status: response.status, body: await response.json().catch(() => ({})) }));
    }

    // Todo previews render item bodies on demand: planner rows omit bodies,
    // so the Canvas detail endpoint for the task's plannable supplies the
    // text the first time a preview opens. Returns raw HTML-ish text or
    // null; the rail strips tags before rendering.
    function todoPreviewTarget(task) {
        const raw = task?.raw && typeof task.raw === "object" ? task.raw : {};
        const plannable = raw.plannable && typeof raw.plannable === "object" ? raw.plannable : {};
        const courseId = String(task?.course?.id ?? raw.course_id ?? String(raw.context_code || "").replace(/^course_/, "") ?? "").trim();
        const plannableId = String(raw.plannable_id ?? plannable.id ?? raw.id ?? "").trim();
        if (!/^\d+$/.test(courseId) || !/^\d+$/.test(plannableId)) return null;
        return { courseId, plannableId };
    }

    async function describeTodoTask(task) {
        const target = todoPreviewTarget(task);
        const type = String(task?.type || "");
        const path = !target ? null
            : type === "announcement" || type === "discussion" ? `/api/v1/courses/${target.courseId}/discussion_topics/${target.plannableId}`
            : type === "quiz" ? `/api/v1/courses/${target.courseId}/quizzes/${target.plannableId}`
            : type === "assignment" ? `/api/v1/courses/${target.courseId}/assignments/${target.plannableId}`
            : type === "calendar" ? `/api/v1/calendar_events/${target.plannableId}`
            : null;
        if (!path) return null;
        try {
            const body = await fetchCanvasJson(path, 4000);
            return typeof body?.message === "string" ? body.message : typeof body?.description === "string" ? body.description : null;
        } catch (error) { return null; }
    }

    async function resolveBinding() {        let context = null;
        try { context = await contentContextService?.getContext?.(); } catch (error) { context = null; }
        let origin = context?.origin || domain;
        let userId = context?.canvasUser?.id;
        if (!userId && !contentContextService) {
            try { userId = (await fetchCanvasJson("/api/v1/users/self"))?.id; } catch (error) { userId = null; }
        }
        if (!origin || !userId) return null;
        const accountKey = context?.canvasBinding?.accountKey || await contentIdentityApi?.accountKey?.({ origin, userId, forceFallback: true });
        if (!TODO_ACCOUNT_KEY_PATTERN.test(String(accountKey || "").toLowerCase())) return null;
        const plannerTimeZone = contentContextApi?.normalizePlannerTimeZone?.(context?.canvasUser?.plannerTimeZone) || null;
        return {
            origin,
            userId: String(userId),
            accountKey: String(accountKey).toLowerCase(),
            timeZone: currentTimeZone(),
            ...(plannerTimeZone ? { plannerTimeZone } : {})
        };
    }

    function plannerItem(item, bindingTimeZone = plannerBindingTimeZone()) {
        const source = item && typeof item === "object" ? item : {};
        const nested = source.plannable && typeof source.plannable === "object" ? source.plannable : {};
        // `/planner/items` gives Planner Notes a presentation-row id and
        // keeps the mutable note under `plannable`.  Unlike other planner
        // rows, a Note's details contain APStudyCanvas's ownership marker, so
        // normalize its immutable Canvas note id and its canonical fields
        // before TodoModel decides whether it can be changed.
        const plannerNote = String(source.plannable_type || source.type || nested.plannable_type || nested.type || "").toLowerCase() === "planner_note";
        const plannerNoteResource = plannerNote ? plannerNoteResourceId(source) : null;
        const plannerNoteDetails = plannerNote ? source.details ?? nested.details : undefined;
        const plannerNoteTodoDate = plannerNote ? plannerNoteTodoDateKey(source.todo_date ?? nested.todo_date, {
            bindingTimeZone
        }) : undefined;
        // Retain the raw details for marker-based authority, but project the
        // user-facing portion once at the Canvas shape boundary. This makes a
        // malformed resource-id row previewable without ever exposing the
        // ownership protocol to the DOM.
        const plannerNotePreview = plannerNote ? contentPlannerTasksApi.splitDetails?.(plannerNoteDetails)?.description : undefined;
        const course = source.course && typeof source.course === "object" ? source.course : nested.course && typeof nested.course === "object" ? nested.course : {};
        const href = source.html_url || source.url || nested.html_url || nested.url;
        return {
            ...source,
            // Preserve each non-Note mapping exactly. Planner Notes instead
            // use the actual /planner_notes id for normalized identity and
            // every later PUT/DELETE, never the transient feed-row id.
            ...(plannerNote ? {
                // This is the one canonical mutation/dedup identity.  A
                // malformed pair remains visible under its feed-row identity,
                // explicitly marked untrusted so TodoModel fails closed.
                id: plannerNoteResource.id || (source.id ?? source.plannable_id ?? nested.id),
                plannable_id: plannerNoteResource.id || (source.plannable_id ?? nested.id),
                planner_item_id: source.id,
                planner_note_resource_id: plannerNoteResource.id,
                planner_note_resource_id_conflict: plannerNoteResource.conflict
            } : {
                id: source.id ?? source.plannable_id ?? nested.id,
                plannable_id: source.plannable_id ?? nested.id
            }),
            name: source.name || source.title || nested.title || nested.name,
            due_at: source.due_at || source.plannable_date || nested.due_at,
            ...(plannerNote ? {
                // A top-level value is canonical when Canvas supplies one;
                // current compact Planner Note rows nest both fields.
                details: plannerNoteDetails,
                todo_date: plannerNoteTodoDate,
                planner_note_date_mutation_blocked: Boolean(String(source.todo_date ?? nested.todo_date ?? "").trim() && !plannerNoteTodoDate),
                planner_note_preview: plannerNotePreview
            } : {}),
            course_id: source.course_id ?? nested.course_id ?? course.id,
            context_code: source.context_code || nested.context_code,
            context_name: source.context_name || nested.context_name || course.name || course.label,
            course_name: source.course_name || nested.course_name || course.name,
            course_code: source.course_code || nested.course_code || course.course_code || course.code,
            course_color: source.course_color || nested.course_color || course.color,
            posted_at: source.posted_at || nested.posted_at,
            read_state: source.read_state || nested.read_state,
            author: source.author || nested.author,
            ...(href && String(href).startsWith("/") ? { html_url: new URL(href, domain).href } : {})
        };
    }

    function activeAnnouncementContextCodes() {
        const codes = cardCourses().map(({ course }) => `course_${course.id}`);
        const currentCourseId = getCurrentCourseId();
        if (currentCourseId) codes.push(`course_${currentCourseId}`);
        return Array.from(new Set(codes));
    }

    async function normalizeCanvasItems(items, currentBinding, { skipUnsupported = false } = {}) {
        const localCompletionKey = `todo-completion:${currentBinding.accountKey}`;
        const storedLocalCompletions = await storageAreaGet(chrome.storage.local, localCompletionKey);
        const localCompletions = storedLocalCompletions?.[localCompletionKey] && typeof storedLocalCompletions[localCompletionKey] === "object"
            ? storedLocalCompletions[localCompletionKey]
            : {};
        const tasks = [];
        let complete = true;
        for (const item of items || []) {
            const raw = plannerItem(item, plannerBindingTimeZone(currentBinding));
            const result = await contentTodoModelApi.normalizeCanvasTask(raw.plannable_type || raw.type || (raw.posted_at ? "announcement" : null), raw, {
                origin: currentBinding.origin,
                userId: currentBinding.userId,
                accountKey: currentBinding.accountKey,
                timeZone: currentBinding.timeZone,
                forceFallback: true
            });
            if (result?.ok) {
                const task = result.task;
                // Assignment completion is an extension-only checklist state.
                // Canvas's submitted/graded result remains authoritative, but
                // a local user mark is restored on every feed refresh.
                const locallyCompleted = task.type !== "announcement" && task.type !== "planner_note"
                    && localCompletions[task.id] === true;
                tasks.push(locallyCompleted ? { ...task, completion: true, mutationAuthority: "manual_extension_local", mutation: { ...task.mutation, authority: "manual_extension_local" } } : task);
            }
            // Unsupported planner types (Canvas also streams assessment
            // requests, wiki pages, …) are outside the To-Do surface and every
            // consumer already drops them from the visible list. For streak
            // settlement they must not count as an incomplete read either —
            // otherwise one such row freezes settlement forever and the streak
            // never advances. Genuine read/identity failures still do.
            else if (skipUnsupported && result?.code === "TODO_CANVAS_TYPE_UNSUPPORTED") continue;
            else complete = false;
        }
        return { tasks, complete };
    }

    async function trackedStreak(currentBinding, now, signal, isCurrent = () => !signal?.aborted) {
        const scope = { accountKey: currentBinding.accountKey, timeZone: currentBinding.timeZone, today: contentTodoTimeApi.localDateKey(now, currentBinding.timeZone) };
        const stored = await storageAreaGet(chrome.storage.local, contentTodoStreakApi.STORAGE_KEY);
        if (!isCurrent()) return contentTodoStreakApi.freeze(null, scope);
        const all = stored?.[contentTodoStreakApi.STORAGE_KEY] && typeof stored[contentTodoStreakApi.STORAGE_KEY] === "object" ? stored[contentTodoStreakApi.STORAGE_KEY] : {};
        const scopedKey = contentTodoStreakApi.scopeKey(scope);
        const previous = all[scopedKey] || null;
        const planned = contentTodoStreakApi.plan(previous, scope);
        if (planned.reason === "first-run" || planned.reason === "seed-required") {
            // Seed once from one bounded historical read so a user with
            // qualifying completed due dates is not pinned at zero. This path
            // also upgrades pre-seeding v2 records (tracked start, zero
            // settled days) through the same fetch; a partial or failed read
            // never fabricates settled days, and the coordinator derive
            // re-checks the plan so a concurrently seeded record wins
            // untouched. A seed-required upgrade keeps its stored marker when
            // the read fails, so the next refresh retries the seed.
            const seedRange = contentTodoStreakApi.seedWindow(scope);
            let seedTasks = null;
            if (seedRange) {
                const seedResult = await contentTodoApi.fetchCanvasPlanner({ fetchImpl: (...args) => fetch(...args), origin: currentBinding.origin, range: seedRange, signal });
                if (!isCurrent()) return contentTodoStreakApi.freeze(previous, scope);
                if (seedResult?.ok === true && seedResult?.state === "live") {
                    const normalizedSeed = await normalizeCanvasItems(seedResult.items || [], currentBinding, { skipUnsupported: true });
                    if (!isCurrent()) return contentTodoStreakApi.freeze(previous, scope);
                    if (normalizedSeed.complete) seedTasks = normalizedSeed.tasks;
                }
            }
            const committed = await streakHistoryCoordinator.update(scope, (latest) => {
                const latestPlan = contentTodoStreakApi.plan(latest, scope);
                if (latestPlan.reason !== "first-run" && latestPlan.reason !== "seed-required") return { write: false, history: contentTodoStreakApi.normalize(latest, scope) };
                if (!seedRange || !seedTasks) return { write: latestPlan.reason === "first-run", history: latestPlan.state };
                const seeded = contentTodoStreakApi.advance(latest, seedTasks, scope, { range: seedRange });
                return { write: seeded.changed, history: seeded.history };
            }, { isCurrent });
            return contentTodoStreakApi.summarize(committed.history || previous, scope);
        }
        if (!planned.range) return contentTodoStreakApi.summarize(previous, scope);
        const result = await contentTodoApi.fetchCanvasPlanner({ fetchImpl: (...args) => fetch(...args), origin: currentBinding.origin, range: planned.range, signal });
        if (!isCurrent()) return contentTodoStreakApi.freeze(previous, scope);
        if (result?.ok !== true || result?.state !== "live") {
            return contentTodoStreakApi.freeze(previous, scope);
        }
        const normalized = await normalizeCanvasItems(result.items || [], currentBinding, { skipUnsupported: true });
        if (!isCurrent()) return contentTodoStreakApi.freeze(previous, scope);
        if (!normalized.complete) return contentTodoStreakApi.freeze(previous, scope);
        const committed = await streakHistoryCoordinator.update(scope, (latest) => {
            const latestPlan = contentTodoStreakApi.plan(latest, scope);
            if (!latestPlan.range) return { write: false, history: contentTodoStreakApi.normalize(latest, scope) };
            if (latestPlan.range.start !== planned.range.start || latestPlan.range.end !== planned.range.end) {
                return { write: false, history: contentTodoStreakApi.normalize(latest, scope) };
            }
            const advanced = contentTodoStreakApi.advance(latest, normalized.tasks, scope);
            return { write: advanced.changed, history: advanced.history };
        }, { isCurrent });
        return contentTodoStreakApi.summarize(committed.history || previous, scope);
    }

    function associateNestTask(task, currentBinding) {
        const raw = task?.raw || {};
        const explicitCourse = raw.canvas_course_id ?? raw.canvasCourseId ?? raw.course_id;
        const explicitAssociation = raw.canvas_account_key || raw.canvasAccountKey || raw.source_identity?.canvas_account_key || raw.source_identity?.canvasAccountKey;
        if (explicitCourse === undefined && explicitAssociation === undefined) return task;
        const course = task.course ? { ...task.course, canvasAccountKey: currentBinding.accountKey } : task.course;
        return {
            ...task,
            course,
            courseAssociation: { canvasAccountKey: currentBinding.accountKey, courseId: String(explicitCourse || task.course?.id || ""), source: "course-card-metadata" },
            canvasAccountKey: currentBinding.accountKey
        };
    }

    async function createNestTask(payload, request = {}) {
        const enriched = {
            ...payload,
            canvas_account_key: binding?.accountKey,
            source_identity: {
                ...(payload?.source_identity || {}),
                source: "nest",
                account_key: binding?.accountKey
            }
        };
        return canvasTodoApi.createNestTask(enriched, { ...request, accountKey: binding?.accountKey });
    }

    async function completionDispatcher(task, desired, request = {}) {
        // Announcement "completion" is a Canvas read-state write, independent
        // of the completion-authority setting: read state has no local variant
        // and is owned by Canvas the same way Canvas owns the unread badge.
        if (task?.type === "planner_note" && task?.mutationAuthority !== "canvas_planner_note") {
            return { ok: false, state: "forbidden", error: { code: "PLANNER_NOTE_NOT_OWNED", message: "Only APStudy-created planner notes can be changed." } };
        }
        const mode = task?.source === "nest"
            ? "nest"
            : task?.mutationAuthority === "canvas_planner_note" ? "canvas_planner_note"
            : task?.type === "announcement" ? "canvas_announcement_read"
            : "manual_extension_local";
        return canvasTodoApi.dispatchCompletion(task, desired, { ...request, mode, accountKey: binding?.accountKey });
    }

    function renderCards(view) {
        const cards = cardCourses();
        const seen = new Set(cards.map(({ card }) => card));
        Array.from(cardRenderers.entries()).forEach(([card, renderer]) => {
            if (!seen.has(card)) {
                renderer.destroy?.();
                cardRenderers.delete(card);
            }
        });
        cards.forEach(({ card, course }) => {
            const normalizedCourse = { ...course, accountKey: view.binding.accountKey };
            let renderer = cardRenderers.get(card);
            if (!renderer) {
                renderer = contentTodoCourseCardsApi.create({ document, window, completionDispatcher, onCompletionSuccess: () => schedule("card-completed") });
                cardRenderers.set(card, renderer);
                renderer.mount({ card, course: normalizedCourse, canvasAccountKey: view.binding.accountKey, canvasTasks: view.canvasTasks, nestTasks: view.nestTasks, settings: view.settings });
            } else {
                renderer.update({ card, course: normalizedCourse, canvasAccountKey: view.binding.accountKey, canvasTasks: view.canvasTasks, nestTasks: view.nestTasks, settings: view.settings });
            }
        });
    }

    // Date rollover: a dashboard left open across local midnight kept a frozen
    // `now`, so the streak card kept yesterday's verified readout and the day
    // groups never re-settled. A cheap minute cadence detects the day-key
    // change and schedules one refresh; the timer re-arms itself and dies with
    // the integration.
    function armDayRolloverWatch() {
        if (rolloverTimer !== null) { clearTimeout(rolloverTimer); rolloverTimer = null; }
        if (destroyed) return;
        const zone = binding?.timeZone || currentTimeZone();
        const today = contentTodoTimeApi.localDateKey(Date.now(), zone);
        if (today) rolloverDayKey = today;
        rolloverTimer = setTimeout(() => {
            rolloverTimer = null;
            if (destroyed) return;
            const nextZone = binding?.timeZone || currentTimeZone();
            const day = contentTodoTimeApi.localDateKey(Date.now(), nextZone);
            if (day && rolloverDayKey && day !== rolloverDayKey && enabled() && routeIsSupported()) schedule("day-rollover");
            armDayRolloverWatch();
        }, 60000);
    }

    // Stable loading shell note: refresh() projects the owned rail surface
    // before any async work (see the "Earliest safe paint" block below) so the
    // To-Do chrome never pops in late, and the explicit loading copy — never
    // animation concealment — stands in until real data converges.

    // The complete active displayed-course model the sidebar already resolved
    // (active enrollments narrowed to the dashboard's actual card set). Feeding
    // it into the rail's suppliedCourses input lets the rail render every
    // displayed course under the "All courses" ring scope — including courses
    // with zero tasks in the current timeframe — while the default "Courses
    // with active tasks" scope narrows the legend, graphic, and course
    // dropdown to courses that have in-range work — open or already completed.
    function displayedRailCourses() {
        const model = contentSidebarController?.getModel?.();
        const courses = Array.isArray(model?.courses) ? model.courses : [];
        return courses
            .map((course) => {
                const id = String(course?.id ?? course?.courseId ?? "").trim();
                if (!/^[1-9]\d{0,19}$/.test(id)) return null;
                const record = { id };
                const label = String(course?.name || course?.course_code || "").trim();
                if (label) record.label = label;
                if (typeof course?.color === "string" && /^#[0-9a-fA-F]{3,8}$/.test(course.color)) record.color = course.color;
                return record;
            })
            .filter(Boolean);
    }

    let lastView = null;
    let lastCourseSignature = "";
    function railCourseSignature(courses) {
        return Array.isArray(courses) ? courses.map((course) => String(course?.id || "")).join(",") : "";
    }
    // The sidebar model converges asynchronously (provisional cache, card
    // hydration, account switches) while the rail keeps whatever course set it
    // was last rendered with. The sidebar controller notifies every model
    // change through render(); this light path re-renders the rail with the
    // same tasks and the converged course set — no network, and the rail's own
    // render signature collapses duplicate notifications into one repaint.
    function syncSidebarCourses() {
        if (destroyed || !railMounted || !lastView) return;
        const courses = mergeCanvasCustomColors(displayedRailCourses(), canvasCustomColorsFor(binding?.origin || domain));
        const signature = railCourseSignature(courses);
        if (signature === lastCourseSignature) return;
        lastCourseSignature = signature;
        try { render({ ...lastView, courses }); } catch (error) { /* The next full refresh heals a failed paint. */ }
    }

    function render(view) {
        if (!enabled()) {
            railDiagnostic = "todo-disabled";
            removeRail();
            cardRenderers.forEach((renderer) => renderer.destroy?.());
            cardRenderers.clear();
            return { ok: true, state: "disabled" };
        }
        if (!routeIsSupported()) {
            railDiagnostic = "unsupported-route";
            removeRail();
            cardRenderers.forEach((renderer) => renderer.destroy?.());
            cardRenderers.clear();
            return { ok: true, state: "disabled" };
        }
        binding = view.binding;
        try {
            ensureRail(view);
        } catch (error) {
            institutionLogo.restore();
            throw error;
        }
        institutionLogo.apply(settings().todo_institution_logo_visible === true);
        if (railMounted) stopTodoInstitutionLogoPrepaint();
        renderCards(view);
        return { ok: true, state: "rendered", placement: railPlacement };
    }

    async function refresh(reason = "manual") {
        abortRefresh();
        if (destroyed || !enabled() || !routeIsSupported()) {
            render({ settings: settings(), binding: binding || { accountKey: "" }, canvasTasks: [], nestTasks: [], tasks: [], range: null, feedback: [] });
            return { ok: true, state: "disabled", reason };
        }
        const run = ++generation;
        const controller = typeof AbortController === "function" ? new AbortController() : null;
        refreshAbortController = controller;
        const signal = controller?.signal;
        const stale = () => run !== generation || destroyed || signal?.aborted || contentContextDead;
        try {
            const currentSettings = settings();
            const range = rangeOverride || todoRefreshRange(currentSettings);
            if (!range) {
                institutionLogo.restore();
                return { ok: false, state: "waiting", code: "TODO_RANGE_UNAVAILABLE" };
            }
            // Earliest safe paint: before any network work, project the rail
            // shell (loading states, no fabricated tasks) so the To-Do surface
            // appears together with Canvas's own right rail instead of popping
            // in after every fetch settles. The capture ledger keeps every
            // hidden Canvas node restorable, and a failed binding below
            // removes the shell entirely. Once real data has been rendered,
            // refreshes keep the current view until the next one converges.
            if (!railMounted) {
                render({
                    settings: currentSettings,
                    binding: binding || { accountKey: "" },
                    canvasTasks: [],
                    nestTasks: [],
                    tasks: [],
                    courses: mergeCanvasCustomColors(displayedRailCourses(), canvasCustomColorsFor(binding?.origin || domain)),
                    range,
                    feedback: [],
                    calendar: contentCalendarOverlayController?.getState?.() || { state: "unavailable" },
                    streak: { state: "loading" },
                    now: Date.now(),
                    canvasState: "loading",
                    nestState: "loading",
                    announcementState: "loading",
                    sourceState: {
                        planner: { state: "loading", complete: false, partial: false, truncated: false, error: null },
                        announcements: { state: "loading", complete: false, partial: false, truncated: false, error: null },
                        nest: { state: "loading", error: null }
                    }
                });
                if (stale()) return { ok: false, state: "stale" };
                armDayRolloverWatch();
            }
            const currentBinding = await resolveBinding();
            if (stale()) return { ok: false, state: "stale" };
            if (!currentBinding) {
                institutionLogo.restore();
                railDiagnostic = "binding-unavailable";
                removeRail();
                scheduleBindingReadiness();
                return { ok: false, state: "waiting", code: "CANVAS_ACCOUNT_BINDING_UNAVAILABLE" };
            }
            clearBindingReadiness();
            const [canvasResult, announcementResult, nestResult, streak, colorsResult] = await Promise.all([
                contentTodoApi.fetchCanvasPlanner({ fetchImpl: (...args) => fetch(...args), origin: currentBinding.origin, range, signal }),
                contentTodoApi.fetchCanvasAnnouncements?.({ fetchImpl: (...args) => fetch(...args), origin: currentBinding.origin, contextCodes: activeAnnouncementContextCodes(), signal }) || Promise.resolve({ ok: false, state: "unavailable", items: [], partial: false, truncated: false }),
                canvasTodoApi.readNestTasks({}, { accountKey: currentBinding.accountKey, timeZone: currentBinding.timeZone, signal }),
                trackedStreak(currentBinding, Date.now(), signal, () => !stale()).catch(() => ({ state: "unavailable", current: 0, since: null })),
                // Authoritative Canvas course colors ride the same refresh
                // round. A failed or skipped read stays non-fatal: the cache
                // (or the rail's fallbacks) covers the surface until the next
                // bounded retry.
                maybeFetchCanvasCustomColors(currentBinding.origin, signal)
            ]);
            if (stale()) return { ok: false, state: "stale" };
            if (colorsResult) adoptCanvasCustomColors(currentBinding.origin, colorsResult);
            const railCourses = mergeCanvasCustomColors(displayedRailCourses(), canvasCustomColorsFor(currentBinding.origin));
            const normalizedCanvas = await normalizeCanvasItems((canvasResult?.items || []).concat(announcementResult?.items || []), currentBinding);
            // The planner feed and the announcements endpoint can both deliver
            // the same announcement under different source item keys, so
            // occurrence-level id dedupe alone leaves a "Course <id>" twin.
            const canvasTasks = contentTodoApi.dedupeCanvasTasks(normalizedCanvas.tasks);
            if (stale()) return { ok: false, state: "stale" };
            const nestTasks = (nestResult?.tasks || []).map((task) => associateNestTask(task, currentBinding));
            const view = {
                binding: currentBinding,
                settings: currentSettings,
                range,
                courses: railCourses,
                canvasTasks,
                nestTasks,
                tasks: canvasTasks.concat(nestTasks),
                feedback: [],
                calendar: contentCalendarOverlayController?.getState?.() || { state: "unavailable" },
                streak,
                now: Date.now(),
                nestState: nestResult?.state || "unavailable",
                canvasState: canvasResult?.state || "unavailable",
                announcementState: announcementResult?.state || "unavailable",
                sourceState: {
                    planner: { state: canvasResult?.state || "unavailable", complete: canvasResult?.complete === true, partial: canvasResult?.partial === true, truncated: canvasResult?.truncated === true, error: canvasResult?.error || null },
                    announcements: { state: announcementResult?.state || "unavailable", complete: announcementResult?.complete === true, partial: announcementResult?.partial === true, truncated: announcementResult?.truncated === true, error: announcementResult?.error || null },
                    nest: { state: nestResult?.state || "unavailable", error: nestResult?.error || null }
                }
            };
            if (stale()) return { ok: false, state: "stale" };
            lastView = view;
            lastCourseSignature = railCourseSignature(railCourses);
            return { ...render(view), view };
        } catch (error) {
            if (stale() || error?.name === "AbortError") return { ok: false, state: "stale" };
            institutionLogo.restore();
            removeRail();
            throw error;
        } finally {
            if (refreshAbortController === controller) refreshAbortController = null;
        }
    }

    function schedule(reason = "scheduled") {
        if (timer !== null) clearTimeout(timer);
        timer = setTimeout(() => {
            timer = null;
            refresh(reason).catch((error) => logError(error));
        }, 0);
    }

    function settingsChanged() {
        rangeOverride = null;
        // Keep one current transport through ordinary To-Do setting echoes.
        // Only a Planner gate/route transition needs creation or disposal;
        // recreating unconditionally here caused startup's first settings
        // application to replace the transport createTodoIntegration() had
        // just made.
        if (!plannerTasksFeatureEnabled() || !routeIsSupported()) {
            if (plannerTaskTransport || plannerPageTransport) disposePlannerTaskTransport();
        } else if (!plannerTaskTransport) {
            resetPlannerTaskTransport();
        }
        if (!enabled()) {
            railDiagnostic = "todo-disabled";
            clearRailReadiness();
            clearBindingReadiness();
            generation += 1;
            abortRefresh();
            removeRail();
            cardRenderers.forEach((renderer) => renderer.destroy?.());
            cardRenderers.clear();
            return true;
        }
        if (!routeIsSupported()) {
            railDiagnostic = "unsupported-route";
            clearRailReadiness();
            clearBindingReadiness();
            generation += 1;
            abortRefresh();
            removeRail();
            cardRenderers.forEach((renderer) => renderer.destroy?.());
            cardRenderers.clear();
            return true;
        }
        institutionLogo.apply(settings().todo_institution_logo_visible === true);
        schedule("settings");
        return true;
    }

    function pause(reason = "pause") {
        clearRailReadiness();
        clearBindingReadiness();
        generation += 1;
        abortRefresh();
        disposePlannerTaskTransport();
        if (timer !== null) clearTimeout(timer);
        timer = null;
        if (rolloverTimer !== null) { clearTimeout(rolloverTimer); rolloverTimer = null; }
        removeRail();
        lastView = null;
        lastCourseSignature = "";
        cardRenderers.forEach((renderer) => renderer.destroy?.());
        cardRenderers.clear();
        return { ok: true, state: "paused", reason };
    }

    function route(path) {
        current_page = path || window.location.pathname || "/";
        rangeOverride = null;
        clearBindingReadiness();
        const interruptedPlannerOperation = activePlannerOperations > 0;
        // SPA navigation retains this content script but not necessarily the
        // page-world session, CSRF context, or rail modal that started a
        // Planner mutation. Invalidate before touching the reused view. A
        // mutation interrupted here is never replayed; its captured caller
        // receives a stale result instead of applying old-route UI state.
        disposePlannerTaskTransport();
        if (interruptedPlannerOperation) removeRail();
        if (!enabled() || !routeIsSupported()) {
            railDiagnostic = !enabled() ? "todo-disabled" : "unsupported-route";
            clearRailReadiness();
            generation += 1;
            abortRefresh();
            removeRail();
            lastView = null;
            lastCourseSignature = "";
            cardRenderers.forEach((renderer) => renderer.destroy?.());
            cardRenderers.clear();
            return;
        }
        // Only an enabled Planner gets a fresh page-bound transport on the
        // new route. `reset` has already disposed the old route's session.
        resetPlannerTaskTransport();
        // Same-document navigation between supported routes: the tasks on
        // screen are route-independent and seconds old, so keep the view —
        // ensureRail remounts the host when Canvas replaced the anchor — and
        // revalidate only when the last fetch is older than the route window.
        // The previous teardown + schedule() cost a rail rebuild plus a full
        // four-endpoint refetch on every click.
        generation += 1;
        abortRefresh();
        if (lastView) {
            const courses = mergeCanvasCustomColors(displayedRailCourses(), canvasCustomColorsFor(binding?.origin || domain));
            lastCourseSignature = railCourseSignature(courses);
            try { render({ ...lastView, courses }); } catch (error) { schedule("route"); }
            const fetchedAt = Number(lastView.now);
            if (!(Number.isFinite(fetchedAt) && Date.now() - fetchedAt < TODO_ROUTE_REVALIDATE_MS)) schedule("route");
            return;
        }
        schedule("route");
    }

    function isOwnedMutation(records) {
        const list = Array.isArray(records) ? records : [];
        return list.length > 0 && list.every((record) => todoNodeOwned(record?.target) && Array.from(record?.addedNodes || []).every(todoNodeOwned));
    }

    function destroy(reason = "destroy") {
        destroyed = true;
        pause(reason);
        window.removeEventListener?.("resize", resize);
        return { ok: true, state: "destroyed", reason };
    }

    const resize = () => schedule("resize");
    window.addEventListener?.("resize", resize);
    return Object.freeze({ refresh, schedule, settingsChanged, route, pause, destroy, isOwnedMutation, syncSidebarCourses, getState: () => ({ binding, placement: railPlacement, mounted: railMounted, reason: railDiagnostic }) });
}

// Earliest lifecycle point: content.js evaluates at document_start, so the
// institutional mark is owned before Canvas parses the sidebar. The runtime
// adopts it via createTodoIntegration(); unapproved origins abandon it in
// isDomainCanvasPage().
startTodoInstitutionLogoPrepaint();

function initializeTodoIntegration() {
    if (contentTodoIntegration || !contentTodoApi?.createTodoApi) return contentTodoIntegration;
    contentTodoIntegration = createTodoIntegration();
    return contentTodoIntegration;
}

globalThis.APStudyCanvasTodoRuntime = Object.freeze({
    refresh: (...args) => contentTodoIntegration?.refresh?.(...args),
    schedule: (...args) => contentTodoIntegration?.schedule?.(...args),
    destroy: (...args) => contentTodoIntegration?.destroy?.(...args),
    state: () => contentTodoIntegration?.getState?.() || { mounted: false, placement: "", reason: "missing-anchor" }
});

function ensureSettingsApplicator() {
    if (contentSettingsApplicator || !contentSettingsApplyApi?.createSettingsApplicator) return contentSettingsApplicator;
    contentSettingsApplicator = contentSettingsApplyApi.createSettingsApplicator({
        document,
        createRestoreLedger: contentOverlayHostApi?.createRestoreLedger,
        operations: {
            darkMode() { toggleDarkMode(); return true; },
            autoDark() { toggleAutoDarkMode(); return true; },
            extensionTheme(settings) { contentCanvasSearchUi?.setTheme?.(resolvedExtensionTheme(settings)); return true; },
            routeSafety() {
                const wasSafe = wasQuizSafeRoute();
                const isSafe = applyQuizSafeRouteGuard();
                // A direct SETTINGS_UPDATE bypasses storage's route helper.
                // Restore our paused owners immediately when safe mode is
                // switched off during an active assessment route.
                if (wasSafe && !isSafe) resumeQuizSafeRouteEnhancements();
                return true;
            },
            assignmentNavigation() { return syncAssignmentNavigation() || true; },
            cardGrades() {
                // Dashboard grades are fetched by their own opt-in. This only
                // reconciles already-owned grade rows, preserving the explicit
                // unavailable state when Canvas supplied no numeric score.
                insertGrades();
                return true;
            },
            font() { loadCustomFont(); return true; },
            aesthetics() { applyAestheticChanges(); return true; },
            background() {
                if (options.customBackgroundLink) applyCustomBackground();
                else clearCustomBackground();
                return true;
            },
            gradient() { changeGradientCards(); return true; },
            cards() { applyCourseCardsLive(); return true; },
            favicon() { changeFavicon(); return true; },
            rightRail() { return contentTodoIntegration?.settingsChanged?.(options) === true; },
            dashboardNotes() { return reconcileDashboardNotes(); },
            cardAssignments() { return reconcileCardAssignments(); },
            dashboardGrades() { return reconcileDashboardGrades(); },
            phaseFour() {
                // Search and analytics have their own ownership and abort
                // ledgers. A single sync path covers popup updates and their
                // storage echo without touching Canvas-owned markup.
                void syncPhaseFourFeatures("settings", { clearSearch: options?.canvas_search_enabled !== true });
                return true;
            },
            sidebar(settings) { return contentSidebarController?.apply?.(settings) === true; }
        }
    });
    return contentSettingsApplicator;
}

function applyCurrentSettings(source = "startup") {
    ensureSettingsApplicator();
    if (contentSettingsApplicator) return contentSettingsApplicator.apply(options, { source });
    toggleDarkMode();
    toggleAutoDarkMode();
    loadCustomFont();
    applyAestheticChanges();
    changeFavicon();
    if (options.customBackgroundLink) applyCustomBackground();
    else clearCustomBackground();
    changeGradientCards();
    applyCourseCardsLive();
    contentSidebarController?.apply?.(options);
    return { applied: true, rendered: true, appliedKeys: [], reloadKeys: [] };
}

// The overlay host mutates the live Canvas page (scaled, inert body), so it
// must be torn down before the document is disposed or frozen for bfcache —
// otherwise the snapshot keeps a scaled, inert page behind a dead iframe.
function teardownContentOverlayHost(reason) {
    if (!contentOverlayHost) return;
    try { contentOverlayHost.destroy?.(reason); } catch (error) {}
    contentOverlayHost = null;
}

// Extracted from the sidebar bootstrap so the overlay host can own a lifecycle
// even on pages where the sidebar controller never loads. The lifecycle module
// memoizes per document, so calling this twice returns the same controller.
function ensureContentLifecycle() {
    if (contentLifecycle) return contentLifecycle;
    if (!contentLifecycleApi?.createContentLifecycle) return null;
    contentLifecycle = contentLifecycleApi.createContentLifecycle({
        window,
        document,
        chromeApi: chrome,
        // The default 80ms coalesce adds a visible beat between Canvas
        // painting its nav and the rail replacing it. 16ms still batches a
        // burst of mutations into one refresh while keeping the rail's first
        // paint within a frame of the native root appearing.
        debounceMs: 16,
        onRoute: ({ path, href }) => {
            current_page = path || "/";
            dashboardScriptBlockWatchdog?.reconcile?.(current_page);
            cardAssignmentsGeneration += 1;
            const wasSafe = wasQuizSafeRoute();
            if (applyQuizSafeRouteGuard()) return;
            void teardownPhaseFourFeatures("route");
            if (wasSafe) resumeQuizSafeRouteEnhancements();
            syncAssignmentNavigation();
            if ((current_page === "/" || current_page === "") && options?.assignments_due === true && !todoCourseCardsOwnAssignments()) getAssignments();
            contentCalendarOverlayController?.route?.({ path: current_page, href });
            contentTodoIntegration?.route?.(current_page);
            void syncPhaseFourFeatures("route");
            // This is the only history patch: the preview engine no longer
            // wraps pushState, so the lifecycle drives its re-layout.
            contentOverlayHost?.notifyRoute?.();
        },
        onRefresh: (reason) => {
            if (applyQuizSafeRouteGuard()) return;
            syncAssignmentNavigation();
            refreshContentSidebar(reason);
            contentTodoIntegration?.schedule?.(reason);
            // The initial content-script pass can precede Canvas inserting
            // #content. Retry only an unmounted eligible analytics surface;
            // an existing root owns its fetch/error state and is never
            // duplicated by dashboard or portal mutations.
            if (!contentContextDead && options?.canvas_search_enabled === true && !contentCanvasSearchUi) void ensurePhaseFourSearch();
            void ensurePhaseFourAnalytics();
            void ensurePhaseFourGradeOverview();
        },
        onDashboardHydrate: hydrateDashboard,
        onMutation: (records) => {
            // The todo integration's own ownership filter recognizes the
            // todo-* subtrees the sidebar-shaped built-in check cannot see.
            // Everything else refreshes unconditionally: gating on sidebar
            // readiness would freeze dashboard hydration whenever the sidebar
            // controller is missing or not yet initialized, and a missing
            // sidebar is handled inside refreshContentSidebar, not here.
            if (contentTodoIntegration?.isOwnedMutation?.(records)) return false;
            return true;
        },
        onStorageChange: applyOptionsChanges,
        onPause: ({ reason } = {}) => {
            dashboardScriptBlockWatchdog?.dispose?.();
            cardAssignmentsGeneration += 1;
            removeAssignmentNavigation();
            teardownDashboardNotes();
            contentSidebarController?.pause();
            contentTodoIntegration?.pause?.(reason || "pause");
            void teardownPhaseFourFeatures(reason || "pause");
            teardownContentOverlayHost(reason || "pause");
        },
        onResume: () => {
            syncAssignmentNavigation();
            contentSidebarController?.resume(options);
            contentTodoIntegration?.schedule?.("resume");
            void syncPhaseFourFeatures("resume");
        },
        onDispose: ({ reason } = {}) => {
            dashboardScriptBlockWatchdog?.dispose?.();
            removeAssignmentNavigation();
            contentSidebarController?.dispose();
            contentTodoIntegration?.destroy?.(reason || "dispose");
            void teardownPhaseFourFeatures(reason || "dispose", { clearSearch: true });
            teardownContentOverlayHost(reason || "dispose");
        }
    });
    contentLifecycle.init();
    return contentLifecycle;
}

function ensureControlCenterListener() {
    if (controlCenterListenerAttached || typeof document?.addEventListener !== "function") return;
    const openControlCenter = (event) => {
        const host = ensureOverlayHost();
        if (!host?.open) return;
        host.open({ category: event?.detail?.category === "study-tools" ? "study-tools" : "sidebar" });
    };
    document.addEventListener("apstudycanvas:open-control-center", openControlCenter);
    controlCenterListenerAttached = true;
}

let contentWorkspace = null;
function openSidebarWorkspace(page) {
    if (!contentWorkspace) {
        const api = globalThis.APStudyCanvasContent;
        if (!api?.WorkspaceUI || !api?.WorkspaceModel) return false;
        contentWorkspace = api.WorkspaceUI.createWorkspace({
            document, window, model: api.WorkspaceModel, gpa: api.Gpa,
            storage: { get: key => chrome.storage.local.get(key), set: value => storageAreaSet(chrome.storage.local, value) },
            verify: async signal => {
                const profile = await fetchPhaseFourJson("/api/v1/users/self/profile", signal);
                return { origin: window.location.origin, accountId: String(profile.id || "") };
            },
            readCourses: signal => fetchPhaseFourGradeAnalyticsCollection("/api/v1/courses?enrollment_state=active&include[]=total_scores&include[]=computed_current_score&per_page=100", signal),
            readPlanner: (range, signal) => fetchPhaseFourGradeAnalyticsCollection(`/api/v1/planner/items?start_date=${encodeURIComponent(range.start.toISOString())}&end_date=${encodeURIComponent(range.end.toISOString())}&per_page=100`, signal),
            getBounds: () => options.gpa_calc_bounds,
            openSettings: () => ensureOverlayHost()?.open?.({ category: "gpa-grades" })
        });
    }
    return contentWorkspace.open(page);
}

function ensureSidebarPageActions() {
    if (contentSidebarPageActions || !contentSidebarPageActionsApi?.createSidebarPageActions) return contentSidebarPageActions;
    contentSidebarPageActions = contentSidebarPageActionsApi.createSidebarPageActions({ document, openWorkspace: openSidebarWorkspace });
    contentSidebarPageActions.attach?.();
    return contentSidebarPageActions;
}

function initializeContentSidebarLifecycle({ refresh = false } = {}) {
    if (!contentSidebarApi?.createSidebarController) {
        initializeCalendarOverlay();
        return;
    }
    if (!contentSidebarController) {
        ensureSidebarPageActions();
        const sidebarAdapter = contentSidebarAdapterApi?.createSidebarAdapter?.({
            origin: window.location.origin,
            fetchImpl: (...args) => fetch(...args)
        });
        contentSidebarController = contentSidebarApi.createSidebarController({
            document,
            window,
            chromeApi: chrome,
            listenStorage: !contentLifecycleApi?.createContentLifecycle,
            adapter: sidebarAdapter,
            // The To-Do rail mirrors the sidebar's displayed-card model. The
            // callback fires on every accepted model change (provisional and
            // final); syncSidebarCourses dedupes by course signature so the
            // rail repaints only when the displayed set actually moved.
            onModelChange: () => { try { contentTodoIntegration?.syncSidebarCourses?.(); } catch (error) {} },
            // Authoritative displayed-card evidence for the rail: the persisted
            // dashboard card subset plus the course ids our own card
            // customization currently hides (custom_cards hidden flag).
            displayedCardCache: contentSidebarDisplayedCardsApi?.createDisplayedCardCache
                ? contentSidebarDisplayedCardsApi.createDisplayedCardCache({
                    storage: {
                        get: (key) => new Promise((resolve) => {
                            try {
                                const returned = chrome.storage.local.get(key, (result) => resolve(result?.[key]));
                                if (returned && typeof returned.then === "function") returned.then(resolve, () => resolve(undefined));
                            } catch (error) { resolve(undefined); }
                        }),
                        set: (key, value) => new Promise((resolve) => {
                            try {
                                const returned = chrome.storage.local.set({ [key]: value }, () => resolve(true));
                                if (returned && typeof returned.then === "function") returned.then(() => resolve(true), () => resolve(false));
                            } catch (error) { resolve(false); }
                        })
                    }
                })
                : null,
            readHiddenCardCourseIds: () => Object.entries(options?.custom_cards || {})
                .filter(([, card]) => card && typeof card === "object" && card.hidden === true)
                .map(([id]) => String(id).trim())
                .filter(Boolean)
        });
        contentSidebarController.init(options);
        // One-time mount marker so a stale injection can be told apart from a
        // fresh one in DevTools (compare against the manifest version).
        try { console.info(`[APStudyCanvas] sidebar mounted (v${chrome?.runtime?.getManifest?.()?.version || "?"}, build ${BUILD_TAG})`); } catch (error) {}
        // The lifecycle owns the debounced initial adapter refresh when it is
        // present. Keep a direct refresh only for compatibility environments
        // where that module was not injected.
        if (!contentLifecycleApi?.createContentLifecycle) void contentSidebarController.refresh?.();
    } else if (refresh) {
        contentSidebarController.apply(options);
    }
    ensureContentLifecycle();
    ensureControlCenterListener();
    initializeCalendarOverlay();
}

function startCanvasEnhancements(source = "startup") {
    if (applyQuizSafeRouteGuard()) {
        // The lifecycle is a route/storage observer only at this point: it
        // does not mount an APStudy surface, but lets a same-document exit
        // from a quiz (or a live safe-mode toggle) restore the feature owners.
        ensureContentLifecycle();
        return;
    }
    // The watcher starts before the lifecycle so card insertions are
    // customized in the insertion microtask; the debounced hydrate below
    // remains the fallback for data-driven card work.
    ensureCardAppearance();
    initializeTodoIntegration();
    contentCardAppearance?.start?.();
    initializeContentSidebarLifecycle();
    if (source === "quiz-safe-resume") {
        contentSidebarController?.resume?.(options);
        contentTodoIntegration?.settingsChanged?.(options);
    }
    applyCurrentSettings(source);
    contentTodoIntegration?.schedule?.(source);
    getApiData();
    void syncPhaseFourFeatures(source);
    schedulePhaseFourSearchReadiness();
    watchSequenceFooter();
    watchSubmissionPageButton();
    watchProfileLogoutPageButton();
    setTimeout(() => runDarkModeFixer(false), 800);
    setTimeout(() => runDarkModeFixer(false), 4500);
    return true;
}

// A safe route can be entered and left without a document reload. The guard
// pauses only feature owners; this restart path revives those owners from the
// current settings without recreating their lifecycle controller/listeners.
function resumeQuizSafeRouteEnhancements() {
    return startCanvasEnhancements("quiz-safe-resume");
}

function startExtension(preloadedSyncSettings = null) {
    if (extensionStarted) return;
    extensionStarted = true;

    const boot = (result) => {
        const migrated = todoSettingsSnapshot({ ...options, ...result });
        options = phaseOneSettings({ ...options, ...result, ...migrated.settings });
        const migrationChanges = { ...(migrated.migrated?.changes || {}) };
        const customFontMigration = contentTodoSchemaApi?.migrateCustomFont?.(result?.custom_font);
        if (customFontMigration?.changed) {
            options.custom_font = customFontMigration.setting;
            migrationChanges.custom_font = customFontMigration.setting;
        }
        if (todoCourseCardsOwnAssignments(options) && options.assignments_due === true) {
            options.assignments_due = false;
            migrationChanges.assignments_due = false;
        }
        if (Object.keys(migrationChanges).length) void storageAreaSet(chrome.storage.sync, migrationChanges);
        // Leave Canvas's quiz UI entirely native. The root marker is the sole
        // scoped CSS contract; a later same-document route or settings change
        // goes through resumeQuizSafeRouteEnhancements().
        startCanvasEnhancements("startup");
    };

    // isDomainCanvasPage already resolved the full sync store for the origin
    // check; reusing it removes the second serial read from the startup path.
    if (preloadedSyncSettings && typeof preloadedSyncSettings === "object" && !Array.isArray(preloadedSyncSettings)) boot(preloadedSyncSettings);
    else chrome.storage.sync.get(null, boot);

    console.log("[APStudyCanvas] running");
}

function reconcileDashboardNotes() {
    loadDashboardNotes();
    return true;
}

function reconcileCardAssignments() {
    if (options?.assignments_due === true && !todoCourseCardsOwnAssignments()) {
        getAssignments();
        setupCardAssignments();
        loadCardAssignments();
    } else {
        cardAssignmentsGeneration += 1;
        document.querySelectorAll(".canvasrefined-card-assignment").forEach((card) => {
            if (card.style.display !== "none") card.style.display = "none";
        });
    }
    return true;
}

function reconcileDashboardGrades() {
    // Course scores are lazy because Canvas only needs this endpoint for a
    // visible dashboard grade or GPA calculator. Once fetched, the same
    // promise is reused by every subsequent in-place rendering change.
    if ((options?.dashboard_grades === true || options?.gpa_calc === true) && !grades) getGrades();
    insertGrades();
    setupGPACalc();
    return true;
}

function normalizeTodoRuntimeSettings(changes) {
    if (!todoSettingsChanged(changes)) return false;
    const migrated = todoSettingsSnapshot(options);
    options = { ...options, ...migrated.settings };
    return true;
}

function applyOptionsChanges(changes, areaName) {
    if (contentContextDead) return;
    contentContextService?.onStorageChanged?.(changes, areaName);
    contentCalendarOverlayController?.update?.(changes, areaName);
    const rewrite = {};
    Object.keys(changes || {}).forEach((key) => {
        rewrite[key] = changes[key].newValue;
    });
    const wasSafe = wasQuizSafeRoute();
    options = phaseOneSettings({ ...options, ...rewrite });
    if (applyQuizSafeRouteGuard()) return;
    if (wasSafe) {
        resumeQuizSafeRouteEnhancements();
        return;
    }
    const exclusivityChanges = {};
    Object.entries(rewrite).forEach(([key, value]) => Object.assign(exclusivityChanges, contentTodoSchemaApi?.courseCardTaskExclusivityChanges?.(key, value) || {}));
    if (Object.keys(exclusivityChanges).length) {
        options = { ...options, ...exclusivityChanges };
        void storageAreaSet(chrome.storage.sync, exclusivityChanges);
    }
    if (areaName && areaName !== "sync") return;
    normalizeTodoRuntimeSettings(changes);
    ensureSettingsApplicator();
    if (contentSettingsApplicator) {
        contentSettingsApplicator.applyChanges(rewrite, options, { source: "storage" });
        return;
    }
    if (["dashboard_notes", "dashboard_notes_text"].some((key) => Object.prototype.hasOwnProperty.call(rewrite, key))) reconcileDashboardNotes();
    if (["assignments_due", "num_assignments", "hide_completed_cards", "card_overdues", "assignment_states"].some((key) => Object.prototype.hasOwnProperty.call(rewrite, key))) reconcileCardAssignments();
    if (todoSettingsChanged(changes)) {
        initializeTodoIntegration();
        contentTodoIntegration?.settingsChanged?.(options);
    }
    if (contentSidebarController) contentSidebarController.apply(options);
}

function resetBetterSidebarLayout() {
    if (contentSidebarController) {
        contentSidebarController.reset();
        return;
    }
    document.getElementById("header")?.style.removeProperty("display");
    document.querySelector(".ic-Layout-wrapper")?.style.removeProperty("margin-left");
    document.querySelector("#main")?.style.removeProperty("margin-left");
    document.querySelector(".ic-app-nav-toggle-and-crumbs")?.style.removeProperty("display");
    document.getElementById("not_right_side")?.style.removeProperty("display");
    document.getElementById("not_right_side")?.style.removeProperty("flex");
    document.getElementById("not_right_side")?.style.removeProperty("min-width");
    document.getElementById("right-side-wrapper")?.style.removeProperty("flex");
    document.getElementById("right-side-wrapper")?.style.removeProperty("width");
    document.getElementById("right-side-wrapper")?.style.removeProperty("max-width");
    document.querySelector(".ic-Layout-contentWrapper")?.style.removeProperty("display");
    document.querySelector(".ic-Layout-contentWrapper")?.style.removeProperty("align-items");
    document.querySelector(".ic-Layout-contentWrapper")?.style.removeProperty("min-width");
    document.querySelector(".ic-Layout-contentMain")?.style.removeProperty("flex");
    document.querySelector(".ic-Layout-contentMain")?.style.removeProperty("min-width");
    document.querySelector(".ic-Layout-contentMain")?.style.removeProperty("margin");
    document.querySelector(".ic-Layout-contentMain")?.style.removeProperty("padding");
    document.querySelector(".ic-Layout-contentMain")?.style.removeProperty("background");
    document.querySelector(".ic-Layout-contentMain")?.style.removeProperty("backdrop-filter");
    document.querySelector(".ic-Layout-contentMain")?.style.removeProperty("-webkit-backdrop-filter");
    document.getElementById("left-side")?.style.removeProperty("display");
    document.getElementById("left-side")?.style.removeProperty("padding-top");
    document.getElementById("left-side")?.style.removeProperty("padding-left");
    document.getElementById("section-tabs")?.style.removeProperty("padding-top");
    document.getElementById("better-sidebar-container")?.remove();
    clearBetterSidebarLayoutFix();
}

function ensureBetterSidebar() {
    if (contentSidebarApi?.createSidebarController) {
        if (!contentSidebarController) initializeContentSidebarLifecycle();
        else if (!contentLifecycle) ensureContentLifecycle();
        ensureControlCenterListener();
        return;
    }
    if (!options.better_sidebar) return;
    const existingSidebar = document.querySelector("#better-sidebar-container");
    if (existingSidebar) {
        const expander = existingSidebar.querySelector(".better-sidebar-expander");
        existingSidebar.dataset.expanded = "false";
        setSidebarExpandedState(getSidebarLayoutMode(), false);
        updateSidebar(false, existingSidebar, expander);
        return;
    }
    if (!document.querySelector("#wrapper") || !document.querySelector(".ic-Layout-contentWrapper")) return;
    setupBetterSidebar(getSidebarLayoutMode());
}

function applyCustomBackground() {
    // let style = document.querySelector("#DashboardCard_Container")
    let style = document.querySelector("#canvasrefined-background") || document.createElement('style');
    style.id = "canvasrefined-background";
    
    const backgroundUrl = safeCustomBackgroundUrl(options.customBackgroundLink);
    if (backgroundUrl) {
        const backgroundScale = Number(options.customBackgroundScale) || 100;
        const opacity = Math.min(100, Math.max(0, Number(options.customBackgroundOpacity ?? 100))) / 100;
        const blur = Math.min(32, Math.max(0, Number(options.customBackgroundBlur ?? 0)));
        style.textContent = `
        #wrapper {
            --apstudy-background-opacity: ${opacity};
            --apstudy-background-blur: ${blur}px;
            background-image: linear-gradient(rgb(10 15 34 / calc(1 - var(--apstudy-background-opacity))), rgb(10 15 34 / calc(1 - var(--apstudy-background-opacity)))), url(${JSON.stringify(backgroundUrl)}) !important;
            background-size: ${backgroundScale}% auto !important;
            background-repeat: no-repeat !important;
            background-position: center center !important;
            background-attachment: fixed !important;
        }
        .ic-Dashboard-header__layout {
            background: none !important;
            /* backdrop-filter: blur(10px) !important; */
            border-radius: 12px;
        }
        #right-side-wrapper {
            // backdrop-filter: blur(10px) !important;
            background-color: color-mix(in srgb, var(--bcbackground-0), transparent 35%);
            border-radius: 12px;
        }
        .header-bar {
            background: none !important;
            padding: 0 !important;
            border: none !important;
        }
        .item-group-condensed,
        .item-group-container {
            background: transparent !important;
            /* backdrop-filter: blur(14px) saturate(120%) !important;
               -webkit-backdrop-filter: blur(14px) saturate(120%) !important; */
            border-radius: 12px !important;
            border: 1px solid color-mix(in srgb, var(--bcborders) 75%, transparent) !important;
            /* box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12) !important; */
        }
        #context_modules_sortable_container {
            border: none !important;
            background: none !important;
            padding: 0 !important;
            /* backdrop-filter: blur(0) !important; */
        }
        .item-group-condensed .ig-header,
        .item-group-condensed .ig-row,
        .item-group-container .ig-header,
        .item-group-container .ig-row,
        .item-group-condensed .header,
        .item-group-container .header {
            background: transparent !important;
        }
        .item-group-condensed .ig-header.header,
        .item-group-container .ig-header.header {
            background: none !important;
            border: none !important;
            border-radius: 0 !important;
        }
        #assignments.ui-tabs-panel {
            background-color: color-mix(in srgb, var(--bcbackground-0), transparent 35%) !important;
            border-radius: 12px !important;
        }
        #assignments {
            padding-top: 0px !important;
            padding-bottom: 0px !important;
            padding-left: 10px !important;
            padding-right: 10px !important;
        }
        ${isCoursesIndexPage() ? `
        #content {
            margin: 36px 48px 48px !important;
            padding: 10px !important;
            background-color: color-mix(in srgb, var(--bcbackground-0), transparent 35%) !important;
            border-radius: 12px !important;
            box-sizing: border-box !important;
        }
        ` : ""}
        ${isGroupsIndexPage() ? `
        #content {
            margin: 36px 48px 48px !important;
            padding: 10px !important;
            background-color: color-mix(in srgb, var(--bcbackground-0), transparent 35%) !important;
            border-radius: 12px !important;
            box-sizing: border-box !important;
        }
        ` : ""}
        ${isConversationsPage() ? `
        .css-1nh4pc4-view-flexItem {
            background-color: color-mix(in srgb, var(--bcbackground-0), transparent 35%) !important;
            border-radius: 12px !important;
            box-sizing: border-box !important;
        }
        .css-1nh4pc4-view-flexItem svg,
        .css-1nh4pc4-view-flexItem svg * {
            fill: currentColor !important;
            stroke: currentColor !important;
            color: var(--bctext-0) !important;
        }
        ` : ""}
        .item-group-condensed .ig-row.ig-published.no-estimated-duration {
            color: var(--bctext-1) !important;
            border: 1px solid color-mix(in srgb, var(--bcborders) 60%, transparent) !important;
            border-radius: 0 !important;
            padding: 10px 12px !important;
        }
        .item-group-condensed .context_module_item,
        .item-group-container .context_module_item {
            background: transparent !important;
            /* backdrop-filter: blur(10px) saturate(115%) !important;
               -webkit-backdrop-filter: blur(10px) saturate(115%) !important; */
        }
        .item-group-condensed .context_module_item:hover,
        .item-group-container .context_module_item:hover,
        .item-group-condensed .context_module_item.context_module_item_hover,
        .item-group-container .context_module_item.context_module_item_hover {
            background: transparent !important;
            border-radius: 12px !important;
        }
        .item-group-container {
            background: transparent !important;
            border-radius: 12px !important;
            border: 1px solid color-mix(in srgb, var(--bcborders) 75%, transparent) !important;
        }
        .ig-header {
            /* backdrop-filter: blur(10px) !important; */
        }
        .item-group-condensed.context_module,
        .item-group-condensed.context_module_item,
        .item-group-condensed[class~="context_module"] {
            margin-bottom: 10px !important;
            padding-top: 0 !important;
            padding-bottom: 0 !important;
        }

        .item-group-condensed .ig-header.header,
        .item-group-container .ig-header.header {
            padding-top: 0 !important;
        }

        /* Apply backdrop blur only to module panels, not to all headers */
        .item-group-condensed.context_module,
        .item-group-condensed.context_module_item,
        .item-group-condensed.context_module:hover,
        .item-group-condensed.context_module_item:hover,
        .item-group-condensed.context_module.context_module_item_hover,
        .item-group-condensed.context_module_item.context_module_item_hover {
            backdrop-filter: blur(var(--apstudy-background-blur)) !important;
            -webkit-backdrop-filter: blur(var(--apstudy-background-blur)) !important;
        }
        .canvasrefined-gpa-card,
        .canvasrefined-gpa,
        .ic-DashboardCard {
            background: var(--bcbackground-0) !important;
        }
        tr.student_assignment.assignment_graded.editable > * {
            border:none!important
        }`; 
        // TODO: liquid glass?
    }
    
    if (style.textContent) document.documentElement.appendChild(style);
    else style.remove();
}
function clearCustomBackground() {
	let style = document.querySelector("#canvasrefined-background");
	if (style) style.remove();
}

function applyBetterSidebarLayoutFix() {
    let style = document.querySelector("#canvasrefined-sidebar-layout-fix") || document.createElement("style");
    style.id = "canvasrefined-sidebar-layout-fix";
    style.textContent = `
        #wrapper,
        .ic-Layout-wrapper,
        #main {
            margin-left: 0 !important;
        }
    `;
    document.documentElement.appendChild(style);
}

function clearBetterSidebarLayoutFix() {
	let style = document.querySelector("#canvasrefined-sidebar-layout-fix");
	if (style) style.remove();
}

// Fail open only after Canvas's own dashboard-card loading shell survives a
// bounded observation window. The old one-shot 8s selector ran on every
// route and mistook React's delayed/replaced dashboard root for a blocked
// chunk, producing a warning on otherwise healthy reloads.
function ensureDashboardScriptBlockWatchdog() {
    if (dashboardScriptBlockWatchdog || !contentDashboardCardWatchdogApi?.createDashboardCardWatchdog) return dashboardScriptBlockWatchdog;
    dashboardScriptBlockWatchdog = contentDashboardCardWatchdogApi.createDashboardCardWatchdog({
        window,
        document,
        isBlockingEnabled: () => {
            try {
                if (sessionStorage.getItem("apstudycanvas_script_block_fail_open") === "1") return false;
            } catch (error) {}
            // Only the editor/media switch installs dashboard chunk rules.
            // The retired planner preference is absent on current installs,
            // so treating its undefined value as enabled restarted this
            // watchdog on every dashboard hydration.
            return options?.block_editor_scripts === true;
        },
        onTerminal: () => {
            try { sessionStorage.setItem("apstudycanvas_script_block_fail_open", "1"); } catch (error) {}
            console.warn("APStudyCanvas: dashboard cards did not render with script blocks active; failing open for this session.");
            const contract = globalThis.APStudyCanvasPlatform?.Contract;
            if (!contract?.createEnvelope || typeof chrome?.runtime?.sendMessage !== "function") return;
            try {
                const envelope = contract.createEnvelope("CANVAS_SCRIPT_BLOCK_REPORT", { outcome: "dashboard_fail_open" });
                chrome.runtime.sendMessage(envelope, () => void chrome.runtime.lastError);
            } catch (error) {}
        }
    });
    return dashboardScriptBlockWatchdog;
}

function hydrateDashboard() {
    if (applyQuizSafeRouteGuard()) return;
    ensureDashboardScriptBlockWatchdog()?.reconcile?.(current_page || window.location.pathname);
    // The lifecycle invokes this on initial start, coalesced relevant
    // external mutation, and route change, ignoring lifecycle-owned DOM.
    // The guarded setup calls below cannot create the retired
    // #better-sidebar-container implementation; work stays scoped to
    // cards/todos/GPA/dashboard.
    applyDashboardHeaderHide();
    const dashboardCards = document.querySelector("#DashboardCard_Container");
    if (dashboardCards) {
        let cards = document.querySelectorAll(".ic-DashboardCard");
        changeGradientCards();
        setupCardAssignments();
        loadCardAssignments();
        customizeCards(cards);
        insertGrades();
        loadDashboardNotes();
        contentSidebarPageActions?.consumePending?.();
        setupGPACalc();
        showUpdateMsg();
    }

    contentTodoIntegration?.schedule?.("dashboard-ready");
}

// The card appearance watcher customizes cards inside the same mutation
// microtask Canvas uses to insert them, so hidden courses and card design land
// in the first paint instead of one debounced lifecycle beat later. It only
// runs the synchronous appearance passes; data-driven passes (assignment
// counts, grades) stay on the hydrate path above.
let contentCardAppearance = null;

function applyCardAppearance() {
    customizeCards();
    changeGradientCards();
}

function ensureCardAppearance() {
    if (contentCardAppearance || !contentCardAppearanceApi?.createCardAppearance) return contentCardAppearance;
    contentCardAppearance = contentCardAppearanceApi.createCardAppearance({
        document,
        apply: applyCardAppearance
    });
    contentCardAppearance.start();
    return contentCardAppearance;
}

function ensureOverlayHost() {
    if (contentOverlayHost) return contentOverlayHost;
    if (typeof contentOverlayHostApi?.createOverlayHost !== "function") return null;
    // The lifecycle owns the single history patch and the teardown hooks, so it
    // has to exist before the host can leave the page scaled.
    ensureContentLifecycle();
    contentOverlayHost = contentOverlayHostApi.createOverlayHost({
        documentRef: document,
        windowRef: window,
        chromeApi: chrome
    });
    return contentOverlayHost;
}

function sendOverlayResponse(request, sendResponse, payload) {
    sendResponse({
        contract_version: contentProtocolApi?.CONTRACT_VERSION || 1,
        request_id: request?.request_id || null,
        type: request?.type || "OVERLAY_CONTROL",
        payload
    });
}

function handleOverlayMessage(request, sendResponse) {
    // Only the top frame owns the shell. The overlay's own iframe lives in this
    // same tab, so without this guard it would mount a second overlay inside
    // itself the moment the launcher broadcasts.
    if (window.top !== window) {
        sendOverlayResponse(request, sendResponse, { ok: false, state: "unsupported", code: "OVERLAY_TOP_FRAME_REQUIRED" });
        return false;
    }
    const host = ensureOverlayHost();
    if (!host) {
        sendOverlayResponse(request, sendResponse, { ok: false, state: "unsupported", code: "OVERLAY_HOST_UNAVAILABLE" });
        return false;
    }
    const payload = request?.payload && typeof request.payload === "object" ? request.payload : {};
    if (request?.type === "OVERLAY_OPEN") {
        sendOverlayResponse(request, sendResponse, host.open({
            tabId: payload.tabId,
            category: payload.category,
            launchOrigin: payload.launchOrigin
        }));
        return false;
    }
    const result = host.handleControl(payload.action, payload);
    if (result && typeof result.then === "function") {
        Promise.resolve(result)
            .then((resolved) => sendOverlayResponse(request, sendResponse, resolved))
            .catch(() => sendOverlayResponse(request, sendResponse, {
                ok: false,
                state: host.readiness,
                code: "OVERLAY_CONTROL_FAILED"
            }));
        return true;
    }
    sendOverlayResponse(request, sendResponse, result);
    return false;
}

function recieveMessage(request, sender, sendResponse) {
    if (!isTrustedContentSender(sender)) {
        sendResponse({ ok: false, state: "unsupported", code: "SENDER_NOT_ALLOWED" });
        return false;
    }
    if (request?.type === "OVERLAY_OPEN" || request?.type === "OVERLAY_CONTROL") {
        return handleOverlayMessage(request, sendResponse);
    }
    if (request?.type === "GET_CANVAS_CONTEXT" || request?.type === "CANVAS_ACCOUNT_VERIFY") {
        const validation = validateContentFamilyRequest(request);
        if (!validation.ok) {
            sendContentFamilyResponse(request, sendResponse, canvasContextFailure("unsupported", validation.code));
            return false;
        }
        if (request.type === "GET_CANVAS_CONTEXT") {
            getCanvasContext().then((result) => sendContentFamilyResponse(request, sendResponse, result)).catch(() => sendContentFamilyResponse(request, sendResponse, canvasContextFailure("error", "CANVAS_CONTEXT_ERROR")));
            return true;
        }
        const verify = contentContextService?.verifyAccount;
        if (typeof verify !== "function") {
            sendContentFamilyResponse(request, sendResponse, canvasContextFailure("waiting", "CANVAS_ACCOUNT_VERIFICATION_WAITING"));
            return false;
        }
        verify(validation.payload).then((result) => sendContentFamilyResponse(request, sendResponse, result)).catch(() => sendContentFamilyResponse(request, sendResponse, canvasContextFailure("error", "CANVAS_ACCOUNT_VERIFY_ERROR")));
        return true;
    }
    if (request?.type === "SIDEBAR_REFRESH") {
        const validation = validateContentFamilyRequest(request);
        if (!validation.ok || typeof contentSidebarController?.refresh !== "function") {
            sendContentFamilyResponse(request, sendResponse, { ok: false, refreshed: false, code: validation.ok ? "SIDEBAR_UNAVAILABLE" : validation.code });
            return false;
        }
        Promise.resolve(contentSidebarController.refresh())
            .then(() => sendContentFamilyResponse(request, sendResponse, { ok: true, refreshed: true }))
            .catch(() => sendContentFamilyResponse(request, sendResponse, { ok: false, refreshed: false, code: "SIDEBAR_REFRESH_FAILED" }));
        return true;
    }
    if (request?.type === "SETTINGS_UPDATE") {
        const validation = validateContentFamilyRequest(request);
        if (!validation.ok) {
            sendContentFamilyResponse(request, sendResponse, canvasContextFailure("unsupported", validation.code));
            return false;
        }
        const changes = validation.payload.changes || {};
        const reloadChanges = validation.payload.reloadChanges || {};
        const reloadKeys = Array.isArray(validation.payload.reloadKeys) ? validation.payload.reloadKeys.slice() : Object.keys(reloadChanges);
        try {
            options = Object.assign({}, options, reloadChanges, changes);
            normalizeTodoRuntimeSettings(changes);
            ensureSettingsApplicator();
            const result = contentSettingsApplicator
                ? contentSettingsApplicator.applyChanges(changes, options, { source: "settings-update" })
                : { applied: contentSidebarController?.apply?.(changes) === true, rendered: false, appliedKeys: [], reloadKeys };
            const applied = result.applied === true;
            sendContentFamilyResponse(request, sendResponse, {
                ok: true,
                state: applied ? "applied" : (reloadKeys.length ? "pending_reload" : "applied"),
                applied,
                rendered: result.rendered === true || applied,
                appliedKeys: result.appliedKeys || [],
                reloadKeys: result.reloadKeys?.length ? result.reloadKeys : reloadKeys,
                changes: Object.keys(changes)
            });
        } catch (error) {
            sendContentFamilyResponse(request, sendResponse, canvasContextFailure("error", "SETTINGS_APPLY_FAILED"));
        }
        return false;
    }
    if (request?.type === "CANVAS_SYNC_EXTRACT_INTERNAL") {
        if (!contentSyncExtractionHandler) {
            sendInternalContentResponse(request, sendResponse, extractionUnavailable());
            return false;
        }
        contentSyncExtractionHandler.handle(request, sender)
            .then((result) => sendInternalContentResponse(request, sendResponse, result))
            .catch(() => sendInternalContentResponse(request, sendResponse, extractionUnavailable()));
        return true;
    }
    if (UNSUPPORTED_PHASE5_FAMILIES.has(request?.type)) {
        sendResponse({ ok: false, state: "unsupported", code: "PHASE5_FAMILY_UNSUPPORTED" });
        return false;
    }
    if (request?.version === CANVAS_CONTEXT_VERSION && request?.type) {
        sendResponse({ ok: false, state: "unsupported", code: "CONTENT_FAMILY_UNSUPPORTED" });
        return false;
    }
    if (!LEGACY_CONTENT_MESSAGES.has(request?.message)) {
        sendResponse({ ok: false, state: "unsupported", code: "CONTENT_MESSAGE_UNSUPPORTED" });
        return false;
    }
    switch (request.message) {
        case ("getCards"):
            if (options["card_method_dashboard"] === true) {
                getCardsFromDashboard();
            } else {
                getCards();
            }
            sendResponse(true);
            break;
        case ("setcolors"): changeColorPreset(request.options); sendResponse(true); break;
        case ("getcolors"): sendResponse(getCardColors()); break;
        case ("inspect"): sendResponse(inspectDarkMode(true)); break;
        case ("fixdm"): sendResponse(runDarkModeFixer(true)); break;
		case ("updateBackground"): clearCustomBackground(); sendResponse(true); break;
        default: sendResponse({ ok: false, state: "unsupported", code: "CONTENT_MESSAGE_UNSUPPORTED" });
    }
}

function hexToRgb(hex) {
    let match = (/#(.{2})(.{2})(.{2})/).exec(hex);
    if (match) {
        return { "r": parseInt(match[1], 16), "g": parseInt(match[2], 16), "b": parseInt(match[3], 16) };
    }
}

function inspectDarkMode(withOutput = false) {
    let output = "";
    let bgcount = 0, textcount = 0, time = performance.now();
    let bg0 = hexToRgb(options.dark_preset["background-0"]);
    let bg1 = hexToRgb(options.dark_preset["background-1"]);
    let txt = hexToRgb(options.dark_preset["text-0"]);
    let bdr = hexToRgb(options.dark_preset["borders"]);
    let lnk = hexToRgb(options.dark_preset["links"]);
    document.querySelectorAll("*").forEach(el => {
        let style = getComputedStyle(el);
        let bgcolor = style.getPropertyValue("background").match(/rgb\((?<r>\d*)\, ?(?<g>\d*)\, ?(?<b>\d*)\) none/);
        let selector = "class=." + el.className + ",id=#" + el.id;

        if (bgcolor) {
            const r = parseInt(bgcolor.groups["r"]);
            const g = parseInt(bgcolor.groups["g"]);
            const b = parseInt(bgcolor.groups["b"]);
            /*
            if (el.classList.contains("no-touch")) {
            }
            */
            if (r > 245 && g > 245 && b > 245 && !(r === bg0.r && g === bg0.g && b === bg0.b) && !(r === lnk.r && g === lnk.g && b === lnk.b)) {
                el.style.cssText = (";background:" + options.dark_preset["background-0"] + "!important;color" + options.dark_preset["text-0"] + "!important;") + el.style.cssText;
                if (withOutput === true) output += selector + "{background: background-0, color: text-0}\n";
                bgcount++;
            } else if (r > 225 && r < 245 && g > 225 && g < 245 && b > 225 && b < 245 && !(r === bg1.r && g === bg1.g && b === bg1.b) && !(r === lnk.r && g === lnk.g && b === lnk.b)) {
                el.style.cssText = (";background:" + options.dark_preset["background-1"] + "!important;color" + options.dark_preset["text-0"] + "!important;") + el.style.cssText;
                if (withOutput === true) output += selector + "{background: background-1, color: text-0}";
                bgcount++;
            }
        }


        let bordercolor = style.getPropertyValue("border-color").match(/rgb\((?<r>\d*)\, ?(?<g>\d*)\, ?(?<b>\d*)/);
        if (bordercolor) {
            const r = parseInt(bordercolor.groups["r"]);
            const g = parseInt(bordercolor.groups["g"]);
            const b = parseInt(bordercolor.groups["b"]);
            if (r > 195 && g > 195 && b > 195 && !(r === bdr.r && g === bdr.g && b === bdr.b) && !(r === lnk.r && g === lnk.g && b === lnk.b)) {
                el.style.cssText = "border-color:" + options.dark_preset["borders"] + "!important;" + el.style.cssText;
                if (withOutput === true) output += selector + "{border: borders}";
            }
        }

        let text = style.getPropertyValue("color").match(/rgb\((?<r>\d*)\, ?(?<g>\d*)\, ?(?<b>\d*)/);
        if (text) {
            const r = parseInt(text.groups["r"]);
            const g = parseInt(text.groups["g"]);
            const b = parseInt(text.groups["b"]);
            if (r <= 70 && g <= 70 && b <= 70 && !(r === txt.r && g === txt.g && b === txt.b)) {
                el.style.cssText = "color:" + options.dark_preset["text-0"] + "!important;" + el.style.cssText;
                if (withOutput === true) output += selector + "{text: text-0}";
                textcount++;
            }
        }

    });
    return { "selectors": output === "" ? "no gaps determined" : output, "time": performance.now() - time };
}

function getCardColors() {
    let cards = document.querySelectorAll(".ic-DashboardCard__header");
    let colors = [];
    cards.forEach(card => {
        const destination = getDashboardCardDestination(card);
        const hero = card.querySelector(".ic-DashboardCard__header_hero");
        if (!destination || !hero?.style) return;
        let rgbColor = hero.style.backgroundColor;
        colors.push({ "href": destination.href, "color": rgbToHex(rgbColor) });
    });
    colors.sort((a, b) => a.href > b.href ? 1 : -1);
    colors = colors.map(x => x.color);
    return colors;
}

function getCardsFromDashboard() {
    const dashboard_cards = document.querySelectorAll(".ic-DashboardCard");
    chrome.storage.sync.get(["custom_cards", "custom_cards_2", "custom_cards_3"], storage => {
        let cards = storage["custom_cards"] || {};
        let cards_2 = storage["custom_cards_2"] || {};
        let cards_3 = storage["custom_cards_3"] || {};
        let newCards = false;
        let count = 0;
        try {
            dashboard_cards.forEach(card => {
                const id = getCardId(card);
                if (!id) return;
                if (count >= (options["card_limit"] || 25)) return;

                if (!cards[id]) {
                    newCards = true;
                    cards[id] = { "default": card.querySelector(".ic-DashboardCard__header-subtitle")?.textContent?.substring(0, 20) || "", "name": "", "code": "", "img": "", "hidden": false, "weight": "regular", "credits": 1, "eid": 100000 - count, "gr": null };
    
                    let links = [];
                    for (let i = 0; i < 4; i++) {
                        links.push({ "path": "default", "is_default": true });
                    }
                    cards_2[id] = { "links": links };
        
                    cards_3[id] = { "url": domain };
                }
                count++;
            });

            // there shouldn't be 0 cards
            if (count === 0) return;

            //delete cards that aren't on the dashboard anymore
            Object.keys(cards).forEach(key => {
                let found = false;
                // ignore cards that are not for the current url
                if (cards_3[key] && cards_3[key].url !== domain) {
                    found = true;
                } else {
                    dashboard_cards.forEach(card => {
                        const id = getCardId(card);
                        if (parseInt(key) === parseInt(id)) found = true;
                    });
                }

                if (found === false) {
                    cards[key] && delete cards[key];
                    cards_2[key] && delete cards_2[key];
                    cards_3[key] && delete cards_3[key];
                    newCards = true;
                }

            });

        } catch (e) {
            logError(e);
            logError(e);
        } finally {
            if(newCards !== true) return;
            chrome.storage.sync.set({ "custom_cards": cards, "custom_cards_2": cards_2, "custom_cards_3": cards_3 }).catch((error) => logError(error));
        }
    });
}

async function getCards(api = null) {
    let dashboard_cards = api ? api : await getData(`${domain}/api/v1/courses?${/*enrollment_state=active&*/""}per_page=100`);
    chrome.storage.sync.get(["custom_cards", "custom_cards_2", "custom_cards_3"], storage => {
        let cards = storage["custom_cards"] || {};
        let cards_2 = storage["custom_cards_2"] || {};
        let cards_3 = storage["custom_cards_3"] || {};
        let newCards = false;
        let count = 0;
        // sort cards by enrollment id (i think the higher the id, the more recent it is)
        if (options["card_method_date"] === true) {
            dashboard_cards.sort((a, b) => (b?.created_at) > (a?.created_at) ? 1 : -1);
        } else {
            dashboard_cards.sort((a, b) => (b?.enrollment_term_id || 0) - (a?.enrollment_term_id || 0));
        }
        try {
            dashboard_cards.forEach(card => {
                if (!card.course_code || count >= (options["card_limit"] || 25)) return;
                let id = card.id;
                if (!cards || !cards[id]) {
                    newCards = true;
                    cards[id] = { "default": card.course_code.substring(0, 20), "name": "", "code": "", "img": "", "hidden": false, "weight": "regular", "credits": 1, "eid": card.enrollment_term_id || 0, "gr": null };
                } else if (cards && cards[id]) {
                    newCards = true;
                    cards[id].default = card.course_code.substring(0, 20);
                    cards[id].eid = card.enrollment_term_id || 0;
                    if (!cards[id].code) cards[id].code = "";
                }
                if (!cards_2 || !cards_2[id]) {
                    newCards = true;
                    let links = [];

                    for (let i = 0; i < 4; i++) {
                        links.push({ "path": "default", "is_default": true });
                    }

                    cards_2[id] = { "links": links };
                }

                if (!cards_3 || !cards_3[id]) {
                    newCards = true;
                    cards_3[id] = { "url": domain };
                }
                count++;

            });

            //delete cards that aren't on the dashboard anymore
            Object.keys(cards).forEach(key => {
                let found = false;
                // ignore cards that are not for the current url
                if (cards_3[key] && cards_3[key].url !== domain) {
                    found = true;
                } else {
                    dashboard_cards.forEach(card => {
                        if (parseInt(key) === card.id) found = true;
                    });
                }

                if (found === false) {
                    cards[key] && delete cards[key];
                    cards_2[key] && delete cards_2[key];
                    cards_3[key] && delete cards_3[key];
                    newCards = true;
                }

            });

        } catch (e) {
            logError(e);
        } finally {
            return chrome.storage.sync.set(newCards ? { "custom_cards": cards, "custom_cards_2": cards_2, "custom_cards_3": cards_3 } : {}).catch((error) => logError(error));
        }
    });
}

/* 
Better todo list
*/

function retiredLegacyTodoCreateBtn(location) {
    // Retired: Canvas assignments/planner notes are never a To-Do creation
    // authority. The live renderer creates only Nest tasks.
    return null;
    /* istanbul ignore next -- retained source is unreachable compatibility code */
    let confirmButton = makeElement("button", location, { "className": "canvasrefined-custom-btn", "textContent": "Create" });
    confirmButton.addEventListener("click", () => {
        chrome.storage.sync.get("custom_assignments_overflow", overflow => {
            chrome.storage.sync.get(overflow["custom_assignments_overflow"], storage => {
                let course_id = parseInt(location.querySelector("#canvasrefined-custom-course").value);

                const assignment = {
                    "plannable_id": new Date().getTime(),
                    "context_name": options.custom_cards[location.querySelector("#canvasrefined-custom-course").value].default,
                    "plannable": { "title": location.querySelector("#canvasrefined-custom-name").value },
                    "plannable_date": location.querySelector("#canvasrefined-custom-date").value + "T" + location.querySelector("#canvasrefined-custom-time").value + ":00",
                    "planner_override": { "marked_complete": false, "custom": true },
                    "plannable_type": "assignment",
                    "submissions": { "submitted": false },
                    "course_id": course_id,
                    "html_url": `/courses/${course_id}/assignments`
                };

                /* handling overflow since the limit is 8kb per key */

                let found = false;
                let reload = () => {
                    location.classList.toggle("canvasrefined-custom-open");
                    retiredLegacyTodoLoad();
                    loadCardAssignments();
                }

                /* find the first available overflow with space */
                /* or create a new one if all are full */
                let findOpenOverflow = (num) => {
                    let current_overflow = overflow["custom_assignments_overflow"][num];
                    storage[current_overflow].push(assignment);
                    chrome.storage.sync.set({ [current_overflow]: storage[current_overflow] }, () => {
                        /* assuming any error is because the limit is exceeded */
                        if (chrome.runtime.lastError) {
                            if (num === overflow["custom_assignments_overflow"].length - 1) {
                                let new_overflow = "custom_assignments_" + (overflow["custom_assignments_overflow"].length + 1);
                                overflow["custom_assignments_overflow"].push(new_overflow);
                                chrome.storage.sync.set({ [new_overflow]: [assignment], "custom_assignments_overflow": overflow["custom_assignments_overflow"] }).then(reload);
                            } else {
                                findOpenOverflow(num + 1);
                            }
                        } else {
                            reload();
                        }
                    });
                }

                findOpenOverflow(0);

            });
        })
    });
}

function convertToDueDate(dueAt) {
	final = "due ";
	let date = new Date(dueAt);
	final += date.toLocaleString("en-US", { month: "short", day: "numeric" });
	final += " at " + date.toLocaleString("en-US", { hour: "numeric", minute: "numeric", hour12: !options.todo_hr24 });
	return final;
}
function updateIndicator(element) {
	const indicator = document.getElementById("better-todo-indicator");
	if (!indicator || !element) return;
	indicator.style.width = `${element.offsetWidth*2}px`;
	indicator.style.left = `${element.offsetLeft - (element.offsetWidth * .5)}px`;

	const buttons = ["announcement", "assignments", "completed"];
	buttons.forEach(button => {
		const btn = document.getElementById(`better-todo-${button}`);
		const icon = btn?.firstElementChild;
		if (!icon) return;
		if (btn == element) {
			icon.style.opacity = "1";
			// btn.style.filter = "none";
		}
		else {
			icon.style.opacity = ".5";
			// btn.style.filter = "grayscale(100%)";
		}
	})

}
// better todo html
betterTodoFilter = "tasks";
let domContainers = {};

function formatDateForInput(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

function formatTimeForInput(date) {
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    return `${hours}:${minutes}`;
}

function renderProgressRings(container, scopedData) {
    const allAssignments = scopedData.filter(item => (item.plannable_type == "assignment" || item.plannable_type == "planner_note"));

    // exclude items older than one month
    const oneMonthAgo = Date.now() - 1000 * 60 * 60 * 24 * 30;
    const recentAssignments = allAssignments.filter(item => {
        const dateStr = item.plannable_date || item.todo_date || item.plannable?.due_at || item.plannable?.plannable_date;
        if (!dateStr) return true; // keep items without a date
        const ts = Date.parse(dateStr);
        if (Number.isNaN(ts)) return true;
        return ts >= oneMonthAgo;
    });
    const groups = {};
    recentAssignments.forEach(item => {
        const cid = String(item.course_id || item.context_id || item.plannable?.course_id || "personal");
        groups[cid] = groups[cid] || [];
        groups[cid].push(item);
    });

    const ringScope = options.todo_course_scope === "all" ? "all" : "active";
    const entries = Object.keys(groups).map(cid => {
        const arr = groups[cid];
        const completed = arr.filter(it => (it.submissions?.submitted || it.planner_override?.marked_complete)).length;
        return { courseId: cid, total: arr.length, completed };
    }).filter(e => e.total > 0 && (ringScope === "all" || e.completed < e.total));

    if (!entries.length) {
        container.innerHTML = "";
        return;
    }

    // sort by total desc and limit rings to 6
    entries.sort((a, b) => b.total - a.total);
    const shown = entries.slice(0, 6);

    const totalAll = shown.reduce((s, e) => s + e.total, 0);
    const completedAll = shown.reduce((s, e) => s + e.completed, 0);
    const percent = totalAll === 0 ? 0 : Math.round((completedAll / totalAll) * 100);

    // build SVG rings with visible gaps and a larger central hole.
    // calculate available width from the container so the outer ring is slightly inset
    const containerWidth = (container.clientWidth || 240);
    const maxSize = Math.min(280, Math.floor(containerWidth * 0.99));
    const size = maxSize; // svg square size
    const cx = size / 2;
    const cy = size / 2;

    const ringCount = shown.length;
    const stroke = 8; // ring thickness (thinner)
    const gap = 4; // visible gap between rings (reduced)
    const decrement = stroke + gap; // radius difference per ring ensures gap

    // make outer ring extend closer to container edges by using a small padding
    const padding = 2;
    const startRadius = Math.floor((size / 2) - padding - (stroke / 2));

    // ensure radii stay positive; if too small, reduce stroke/gap
    const minCenterRadius = 28; // minimum desired central hole radius
    const requiredSpace = (ringCount - 1) * decrement + stroke / 2 + minCenterRadius;
    let adjustFactor = 1;
    if (requiredSpace > startRadius) {
        // scale down decrement to fit
        adjustFactor = (startRadius - minCenterRadius - stroke / 2) / Math.max(1, (ringCount - 1) * decrement);
    }

    // center overlay text positioned inside the hole
    // Reuse existing elements when possible to avoid DOM replacement flicker
    let wrapper = container.querySelector('.canvasrefined-progress-wrapper');
    if (!wrapper) {
        wrapper = document.createElement('div');
        wrapper.className = 'canvasrefined-progress-wrapper';
        wrapper.style.display = 'flex';
        wrapper.style.flexDirection = 'column';
        wrapper.style.alignItems = 'center';
        wrapper.style.position = 'relative';
        container.appendChild(wrapper);
    }

    // svg container
    let svg = wrapper.querySelector('svg.canvasrefined-progress-svg');
    if (!svg) {
        svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('class', 'canvasrefined-progress-svg');
        svg.setAttribute('width', String(size));
        svg.setAttribute('height', String(size));
        svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
        svg.style.display = 'block';
        wrapper.appendChild(svg);
    } else {
        svg.setAttribute('width', String(size));
        svg.setAttribute('height', String(size));
        svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
    }

    // ensure overlay text exists
    let overlay = wrapper.querySelector('.canvasrefined-progress-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.className = 'canvasrefined-progress-overlay';
        overlay.style.position = 'absolute';
        overlay.style.left = '0';
        overlay.style.top = '0';
        overlay.style.width = '100%';
        overlay.style.height = '100%';
        overlay.style.display = 'flex';
        overlay.style.alignItems = 'center';
        overlay.style.justifyContent = 'center';
        overlay.style.pointerEvents = 'none';
        const textWrap = document.createElement('div');
        textWrap.style.textAlign = 'center';
        textWrap.style.color = 'var(--bctext-0, #1f1f1e)';
        textWrap.innerHTML = `<div class='canvasrefined-progress-percent' style='font-weight:400;font-size:23px;line-height:1;'>${percent}%</div><div class='canvasrefined-progress-count' style='font-size:12px;margin-top:5px;'>${completedAll}/${totalAll} done</div>`;
        overlay.appendChild(textWrap);
        wrapper.appendChild(overlay);
    } else {
        const pc = overlay.querySelector('.canvasrefined-progress-percent');
        const cnt = overlay.querySelector('.canvasrefined-progress-count');
        if (pc) pc.textContent = `${percent}%`;
        if (cnt) cnt.textContent = `${completedAll}/${totalAll} done`;
    }

    // Update or create rings in-place: reuse or create circles per shown entry
    shown.forEach((entry, idx) => {
        const radius = startRadius - idx * Math.max(1, Math.floor(decrement * adjustFactor));
        const circumference = 2 * Math.PI * radius;
        const prog = entry.total === 0 ? 0 : (entry.completed / entry.total);
        const color = options.custom_cards_3?.[String(entry.courseId)]?.color || options.custom_cards_3?.[entry.courseId]?.color || `hsl(${(idx * 60) % 360} 70% 50%)`;

        // background circle
        let bg = svg.querySelector(`circle.canvasrefined-ring-bg[data-idx='${idx}']`);
        if (!bg) {
            bg = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            bg.classList.add('canvasrefined-ring-bg');
            bg.setAttribute('data-idx', String(idx));
            svg.appendChild(bg);
        }
        bg.setAttribute('cx', String(cx));
        bg.setAttribute('cy', String(cy));
        bg.setAttribute('r', String(radius));
        bg.setAttribute('stroke', color);
        bg.setAttribute('stroke-opacity', '0.25');
        bg.setAttribute('stroke-width', String(stroke));
        bg.setAttribute('fill', 'none');

        // foreground (progress) circle
        let fg = svg.querySelector(`circle.canvasrefined-progress-ring[data-idx='${idx}']`);
        const dasharrayVal = circumference.toFixed(3);
        const dashoffsetTarget = (circumference * (1 - prog)).toFixed(3);
        if (!fg) {
            fg = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            fg.classList.add('canvasrefined-progress-ring');
            fg.setAttribute('data-idx', String(idx));
            fg.setAttribute('stroke-linecap', 'round');
            fg.setAttribute('transform', `rotate(-90 ${cx} ${cy})`);
            fg.setAttribute('stroke-dasharray', dasharrayVal);
            fg.setAttribute('stroke-dashoffset', dasharrayVal); // start empty
            fg.style.transition = 'stroke-dashoffset .8s cubic-bezier(.2,.9,.2,1), opacity .3s ease';
            svg.appendChild(fg);
        }
        fg.setAttribute('cx', String(cx));
        fg.setAttribute('cy', String(cy));
        fg.setAttribute('r', String(radius));
        fg.setAttribute('stroke', color);
        fg.setAttribute('stroke-width', String(stroke));
        fg.setAttribute('fill', 'none');
        fg.setAttribute('stroke-dasharray', dasharrayVal);
        fg.setAttribute('data-target', dashoffsetTarget);

        // request animation frame to set dashoffset to target (triggers transition)
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                fg.setAttribute('stroke-dashoffset', dashoffsetTarget);
            });
        });
    });

    // remove any extra existing circles
    const maxIdx = shown.length - 1;
    svg.querySelectorAll('circle.canvasrefined-ring-bg, circle.canvasrefined-progress-ring').forEach(c => {
        const idx = parseInt(c.getAttribute('data-idx'));
        if (Number.isNaN(idx) || idx > maxIdx) c.remove();
    });
}

function buildPlannerNotePayload(form) {
    const title = form.querySelector("#better-todo-new-task-title")?.value?.trim();
    const details = form.querySelector("#better-todo-new-task-details")?.value?.trim();
    const courseIdRaw = form.querySelector("#better-todo-new-task-course")?.value;
    const dateValue = form.querySelector("#better-todo-new-task-date")?.value;
    const timeValue = form.querySelector("#better-todo-new-task-time")?.value;

    if (!title) {
        throw new Error("Task title is required.");
    }

    if (!dateValue || !timeValue) {
        throw new Error("Please choose both a date and time.");
    }

    const localDateTime = new Date(`${dateValue}T${timeValue}:00`);
    if (Number.isNaN(localDateTime.getTime())) {
        throw new Error("Invalid task date.");
    }

    return {
        title,
        details,
        courseId: courseIdRaw ? parseInt(courseIdRaw) : null,
        // Canvas accepts local timestamp strings more reliably than UTC ISO strings for planner notes.
        todoDate: `${dateValue}T${timeValue}:00`,
    };
}

async function retiredLegacyCanvasPlannerNote(payload) {
    // Retired. Keep this guard at the old seam so a stale page callback cannot
    // submit a Canvas planner note after the new lifecycle has mounted.
    return { ok: false, state: "disabled", code: "CANVAS_PLANNER_NOTE_RETIRED" };
    /* istanbul ignore next -- retained source is unreachable compatibility code */
    const csrfToken = CSRFtoken();
    const plannerNote = {
        title: payload.title,
        todo_date: payload.todoDate,
    };
    if (payload.details) plannerNote.details = payload.details;
    if (payload.courseId) plannerNote.course_id = payload.courseId;

    const attempts = [
        {
            headers: {
                "content-type": "application/json",
                "accept": "application/json",
                "X-CSRF-Token": csrfToken,
            },
            body: JSON.stringify({ planner_note: plannerNote }),
        },
        {
            headers: {
                "content-type": "application/json",
                "accept": "application/json",
                "X-CSRF-Token": csrfToken,
            },
            body: JSON.stringify(plannerNote),
        },
        {
            headers: {
                "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
                "accept": "application/json",
                "X-CSRF-Token": csrfToken,
            },
            body: (() => {
                const formBody = new URLSearchParams();
                formBody.set("planner_note[title]", plannerNote.title);
                formBody.set("planner_note[todo_date]", plannerNote.todo_date);
                if (plannerNote.details) formBody.set("planner_note[details]", plannerNote.details);
                if (plannerNote.course_id) formBody.set("planner_note[course_id]", plannerNote.course_id);
                return formBody.toString();
            })(),
        },
    ];

    let lastError = "Canvas rejected task creation.";
    for (const attempt of attempts) {
        const response = await fetch(domain + "/api/v1/" + ["planner", "notes"].join("_"), {
            method: "POST",
            headers: attempt.headers,
            body: attempt.body,
        });

        if (response.status === 200 || response.status === 201) {
            return response.json();
        }

        try {
            const errData = await response.json();
            if (errData?.errors?.length) {
                lastError = errData.errors.join(" ");
            } else if (errData?.message) {
                lastError = errData.message;
            }
        } catch (_) {
            // Keep prior error text when body is not JSON.
        }
    }

    throw new Error(lastError || "Canvas rejected task creation.");
}

function fillTaskCourseOptions(courseSelect) {
    const cards = options.custom_cards || {};
    const courseColors = options.custom_cards_3 || {};
    const currentCourseId = getCurrentCourseId();
    const entries = Object.entries(cards)
        .map(([id, card]) => ({
            id,
            label: card?.default || `Course ${id}`,
            color:
                courseColors?.[String(id)]?.color ??
                courseColors?.[id]?.color ??
                "#c7cdd1",
        }))
        .sort((a, b) => a.label.localeCompare(b.label));

    courseSelect.innerHTML = '<option value="">Personal task</option>';
    courseSelect.options[0].dataset.color = "#c7cdd1";
    entries.forEach(entry => {
        const option = makeElement("option", courseSelect, {
            value: entry.id,
            textContent: entry.label,
        });
        option.dataset.color = entry.color;
        option.style.color = entry.color;
        if (currentCourseId && String(currentCourseId) === String(entry.id)) {
            option.selected = true;
        }
    });
}

function updateTaskCourseSelectColor(courseSelect) {
    const selectedOption = courseSelect?.options?.[courseSelect.selectedIndex];
    // The selected course reads through a full outline plus a faint wash of its
    // own color rather than a slab down one edge.
    const color = selectedOption?.dataset?.color || "color-mix(in srgb, var(--bctext-0, #1f1f1e), transparent 65%)";
    courseSelect.style.border = `1px solid ${color}`;
    courseSelect.style.backgroundColor = `color-mix(in srgb, ${color} 12%, transparent)`;
    courseSelect.style.paddingLeft = "8px";
}

function retiredLegacyTodoTaskMenu(location, feedbackElement) {
    // Retired: Add Task is owned by TodoRightRail and calls Nest only.
    return null;
    /* istanbul ignore next -- retained source is unreachable compatibility code */
    let actionsRow = location.querySelector("#better-todo-actions-row");

    if (!actionsRow) {
        actionsRow = makeElement("div", location, {
            id: "better-todo-actions-row",
            style: "display:flex;flex-direction:column;gap:8px;margin-top:14px;",
        });

        const addTaskButton = makeElement("button", actionsRow, {
            id: "better-todo-add-task-btn",
            className: "canvasrefined-custom-btn",
            textContent: "+ Add Task",
            style: "width:100%;padding:6px 8px;cursor:pointer;",
        });

        const menu = makeElement("div", actionsRow, {
            id: "better-todo-add-task-menu",
            className: "canvasrefined-add-assignment",
        });

        menu.innerHTML = `
            <div style="display:flex;flex-direction:column;gap:8px;padding:8px;border:1px solid color-mix(in srgb, var(--bctext-0, #1f1f1e), transparent 78%);border-radius:6px;background:var(--bcbackground-2, #f7f6f3);">
                <input type="text" id="better-todo-new-task-title" class="canvasrefined-custom-input" placeholder="Task title" maxlength="255">
                <textarea id="better-todo-new-task-details" class="canvasrefined-custom-input" placeholder="Details (optional)" style="min-height:70px;resize:vertical;padding-top:6px;padding-bottom:6px;"></textarea>
                <select id="better-todo-new-task-course" class="canvasrefined-custom-input"></select>
                <div style="display:flex;gap:6px;">
                    <input type="date" id="better-todo-new-task-date" class="canvasrefined-custom-input">
                    <input type="time" id="better-todo-new-task-time" class="canvasrefined-custom-input">
                </div>
                <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
                    <span id="better-todo-add-task-status" style="font-size:12px;color:var(--bctext-0, #1f1f1e);"></span>
                    <button id="better-todo-add-task-submit" class="canvasrefined-custom-btn" style="padding:4px 10px;cursor:pointer;" type="button">Create</button>
                </div>
            </div>
        `;

        const today = new Date();
        menu.querySelector("#better-todo-new-task-date").value = formatDateForInput(today);
        menu.querySelector("#better-todo-new-task-time").value = formatTimeForInput(today);
        const courseSelect = menu.querySelector("#better-todo-new-task-course");
        fillTaskCourseOptions(courseSelect);
        updateTaskCourseSelectColor(courseSelect);
        courseSelect.addEventListener("change", () => updateTaskCourseSelectColor(courseSelect));

        addTaskButton.addEventListener("click", () => {
            menu.classList.toggle("canvasrefined-custom-open");
        });

        menu.querySelector("#better-todo-add-task-submit").addEventListener("click", async () => {
            const status = menu.querySelector("#better-todo-add-task-status");
            const submitButton = menu.querySelector("#better-todo-add-task-submit");
            status.textContent = "";
            submitButton.disabled = true;

            try {
                const payload = buildPlannerNotePayload(menu);
                await retiredLegacyCanvasPlannerNote(payload);
                status.textContent = "Task created.";
                status.style.color = "#198754";
                menu.querySelector("#better-todo-new-task-title").value = "";
                menu.querySelector("#better-todo-new-task-details").value = "";
                menu.classList.remove("canvasrefined-custom-open");

                getAssignments();
                clearTodoList();
                retiredLegacyTodoSections(location);
            } catch (e) {
                status.textContent = e?.message || "Could not create task.";
                status.style.color = "#db3754";
            } finally {
                submitButton.disabled = false;
            }
        });
    }

    if (feedbackElement) {
        if (actionsRow.nextSibling !== feedbackElement) {
            location.insertBefore(actionsRow, feedbackElement);
        }
    } else if (actionsRow.parentElement !== location) {
        location.append(actionsRow);
    }
}

async function retiredLegacyTodoSections(location) {
	if (!location.querySelector("#better-todo-header")) {
		let header = makeElement("div", location, { id: "better-todo-header" });
		header.style = "display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--bcbackground-1, #ffffff);padding-bottom:-2px;";
		let today = new Date();
		today.setHours(0,0,0,0);
		const todayString = today.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
        header.innerHTML = `
                <h2 style="border:none !important;padding: 0">Tasks</h2>
                <h2 style="border:none !important;padding: 0">${todayString}</h2>
            `;

        // placeholder for progress rings above the tab/filter control
        makeElement("div", location, { id: "better-todo-progress-placeholder", style: "display:flex;justify-content:center;margin-top:8px;" });

		let filterControl = makeElement("div", location, { "id": "better-todo-filter" });
		filterControl.innerHTML = `
		<div style="display:flex;justify-content:center;margin-top:20px;">
			<div id="better-todo-filterbuttongroup" style="display:flex;gap:50px;justify-content:space-between;position:relative;padding-bottom:5px;width:70%;height:30px;">
				<div id="better-todo-announcement" style="color:black !important;width:25px;cursor:pointer;">
					<svg fill="var(--bctext-0, #1f1f1e)" viewBox="0 0 1920 1920" xmlns="http://www.w3.org/2000/svg" style="transition:all .3s ease;">
						<g id="SVGRepo_bgCarrier" stroke-width="0"></g><g id="SVGRepo_tracerCarrier" stroke-linecap="round" stroke-linejoin="round"></g>
						<g id="SVGRepo_iconCarrier">
							<path d="M1587.162 31.278c11.52-23.491 37.27-35.689 63.473-29.816 25.525 6.099 43.483 28.8 43.483 55.002V570.46C1822.87 596.662 1920 710.733 1920 847.053c0 136.32-97.13 250.503-225.882 276.705v513.883c0 26.202-17.958 49.016-43.483 55.002a57.279 57.279 0 0 1-12.988 1.468c-21.12 0-40.772-11.745-50.485-31.171C1379.238 1247.203 964.18 1242.347 960 1242.347H564.706v564.706h87.755c-11.859-90.127-17.506-247.003 63.473-350.683 52.405-67.087 129.657-101.082 229.948-101.082v112.941c-64.49 0-110.57 18.861-140.837 57.487-68.781 87.868-45.064 263.83-30.269 324.254 4.18 16.828.34 34.673-10.277 48.34-10.73 13.665-27.219 21.684-44.499 21.684H508.235c-31.171 0-56.47-25.186-56.47-56.47v-621.177h-56.47c-155.747 0-282.354-126.607-282.354-282.353v-56.47h-56.47C25.299 903.523 0 878.336 0 847.052c0-31.172 25.299-56.471 56.47-56.471h56.471v-56.47c0-155.634 126.607-282.354 282.353-282.354h564.593c16.941-.112 420.48-7.002 627.275-420.48Zm-5.986 218.429c-194.71 242.371-452.216 298.164-564.705 311.04v572.724c112.489 12.876 369.995 68.556 564.705 311.04ZM903.53 564.7H395.294c-93.402 0-169.412 76.01-169.412 169.411v225.883c0 93.402 76.01 169.412 169.412 169.412H903.53V564.7Zm790.589 123.444v317.93c65.618-23.379 112.94-85.497 112.94-159.021 0-73.525-47.322-135.53-112.94-158.909Z" fill-rule="evenodd"></path>
						</g>
					</svg>
				</div>
				<div id="better-todo-assignments" style="color:black !important;width:25px;cursor:pointer;">
					<svg fill="var(--bctext-0, #1f1f1e)" viewBox="0 0 1920 1920" xmlns="http://www.w3.org/2000/svg" stroke="#ffffff" style="transition:all .3s ease;">
						<g id="SVGRepo_bgCarrier" stroke-width="1"></g><g id="SVGRepo_tracerCarrier" stroke-linecap="round" stroke-linejoin="round"></g>
						<g id="SVGRepo_iconCarrier">
							<path d="M1468.214 0v551.145L840.27 1179.089c-31.623 31.623-49.693 74.54-49.693 119.715v395.289h395.288c45.176 0 88.093-18.07 119.716-49.694l162.633-162.633v438.206H0V0h1468.214Zm129.428 581.3c22.137-22.136 57.825-22.136 79.962 0l225.879 225.879c22.023 22.023 22.023 57.712 0 79.848l-677.638 677.637c-10.616 10.503-24.96 16.49-39.98 16.49H903.516v-282.35c0-15.02 5.986-29.364 16.49-39.867Zm-920.005 548.095H338.82v112.94h338.818v-112.94Zm225.88-225.879H338.818v112.94h564.697v-112.94Zm734.106-202.5-89.561 89.56 146.03 146.031 89.562-89.56-146.031-146.031Zm-508.228-362.197H338.82v338.818h790.576V338.82Z" fill-rule="evenodd"></path>
						</g>
					</svg>
				</div>
				<div id="better-todo-completed" style="color:black !important;width:25px;cursor:pointer;">
					<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="transition:all .3s ease;">
						<g id="SVGRepo_bgCarrier" stroke-width="0"></g>
						<g id="SVGRepo_tracerCarrier" stroke-linecap="round" stroke-linejoin="round"></g>
						<g id="SVGRepo_iconCarrier"> <g id="Interface / Checkbox_Check">
							<path id="Vector" d="M8 12L11 15L16 9M4 16.8002V7.2002C4 6.08009 4 5.51962 4.21799 5.0918C4.40973 4.71547 4.71547 4.40973 5.0918 4.21799C5.51962 4 6.08009 4 7.2002 4H16.8002C17.9203 4 18.4796 4 18.9074 4.21799C19.2837 4.40973 19.5905 4.71547 19.7822 5.0918C20 5.5192 20 6.07899 20 7.19691V16.8036C20 17.9215 20 18.4805 19.7822 18.9079C19.5905 19.2842 19.2837 19.5905 18.9074 19.7822C18.48 20 17.921 20 16.8031 20H7.19691C6.07899 20 5.5192 20 5.0918 19.7822C4.71547 19.5905 4.40973 19.2842 4.21799 18.9079C4 18.4801 4 17.9203 4 16.8002Z" stroke="var(--bctext-0, #1f1f1e)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path>
						</g></g>
					</svg>
				</div>
				<div id="better-todo-indicator" style="position:absolute;bottom:4px;left:0;height:3px;background-color:var(--bctext-0, #1f1f1e);border-radius:999px 999px 0 0;transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);"></div>
			</div>
		</div>
		`;
		setTimeout(() => updateIndicator(document.getElementById("better-todo-assignments")), 10);

		document.getElementById("better-todo-announcement").addEventListener("click", (e) => {
			betterTodoFilter = "announcements";
			moreAnnouncementCount = 0;
			updateIndicator(e.currentTarget);
			clearTodoList();
			retiredLegacyTodoSections(location);
		});
		document.getElementById("better-todo-assignments").addEventListener("click", (e) => {
			betterTodoFilter = "tasks";
			moreAssignmentCount = 0;
			updateIndicator(e.currentTarget);
			clearTodoList();
			retiredLegacyTodoSections(location);
		});
		document.getElementById("better-todo-completed").addEventListener("click", (e) => {
			betterTodoFilter = "completed";
			moreCompletedCount = 0;
			updateIndicator(e.currentTarget);
			clearTodoList();
			retiredLegacyTodoSections(location);
		});

		let mainSection = makeElement("div", location, {
			id: "better-todo-main",
		});
		mainSection.style = "display:flex;flex-direction:column;";
	}
	let mainSection = location.querySelector("#better-todo-main");
	assignments.then(data => {
        const courseId = getCurrentCourseId();
        const scopedData = courseId
            ? data.filter(item => {
                const itemCourseId = parseInt(item.course_id || item.context_id || item?.plannable?.course_id);
                return itemCourseId === courseId;
            })
            : data;

        announcements = scopedData.filter(item => item.plannable_type == "announcement");
        assignmentsDue = scopedData.filter(item => (item.plannable_type == "assignment" || item.plannable_type == "planner_note") && !item.submissions?.submitted && !item.planner_override?.marked_complete);
        completed = scopedData.filter(item => (item.plannable_type == "assignment" || item.plannable_type == "planner_note") && (item.submissions?.submitted || item.planner_override?.marked_complete));
		// console.log("assignments", assignmentsDue);
		// console.log("announcements", announcements);
		// console.log("completed", completed);

        if (document.getElementById("better-todo-announcement-badge")) {
            document.getElementById("better-todo-announcement-badge").remove();
        }
        let isAnnoucementBadge = 0;
        announcements.forEach(item => {
            if (item.plannable.read_state == "unread") {
                isAnnoucementBadge++;
                return;
            }
        })
        if (isAnnoucementBadge > 0) {
            makeElement("div", document.getElementById("better-todo-announcement"), {
                id: "better-todo-announcement-badge",
                style: "background-color:#b3261e;width:15px;height:15px;border-radius:50%;font-size:12px;position:absolute;top:-7px;left:16px;display:flex;justify-content:center;align-items:center;", // TODO: theme compatibility
                innerHTML: `<span style="color:white;">${isAnnoucementBadge}</span>`
            })
		}

		domContainers = {};
		const groupKeys = ["-1", "0", "1", "2", "3", "4", "5", "6", "7", "14", "21", "30", "Later", "New", "Seen", "Ungraded", "Graded"];
        for (const key of groupKeys) {
            let wrapper = makeElement("div", mainSection, {
                style: "display:none;margin-top:10px;",
                className: "better-todo-dueheader",
            });
            let label = "";
            if (key == "-1") label = "<strong>Overdue</strong>";
            else if (key == "0") label = "Due <strong>Today</strong>";
            else if (key == "1") label = "Due <strong>Tomorrow</strong>";
            else if (key >= 2 && key < 7) label = "Due in <strong>" + key + " days</strong>";
            else if (key >= 7 && key < 30) label = "Due in <strong>" + key/7 + " weeks</strong>";
            else if (key == "30") label = "Due in <strong>1 month</strong>";
            else if (key === "Later") label = "Due <strong>Later</strong>";
            else label = "<strong>" + key + "</strong>";
            makeElement("div", wrapper, {
                className: "canvasrefined-todo-dueheader-label",
                innerHTML: "<span>" + label + "</span>",
                style: "display:flex;flex-direction:column;gap:10px;font-size:12px;color:var(--bctext-0, #1f1f1e);"
            })

            let listContainer = makeElement("div", wrapper, { className: "todo-group-list" });
            listContainer.style = "display:flex;flex-direction:column;gap:10px;";

            domContainers[key] = { wrapper, listContainer };
        }


        if (betterTodoFilter == "tasks") {
            populateAssignments();
        }
        if (betterTodoFilter == "announcements") {
            populateAnnouncements();
        }
        if (betterTodoFilter == "completed") {
            populateAssignments(true);
        }

        const feedbackElement = location.querySelector(".recent_feedback");

        // populate progress rings placeholder (respect user toggle)
        const progressPlaceholder = document.getElementById("better-todo-progress-placeholder");
        if (progressPlaceholder) {
            if (options.todo_progress_rings === undefined || options.todo_progress_rings === true) {
                renderProgressRings(progressPlaceholder, scopedData);
            } else {
                progressPlaceholder.innerHTML = "";
            }
        }

        // Only show the Add Task control on the Assignments (tasks) tab.
        if (betterTodoFilter === "tasks") {
            retiredLegacyTodoTaskMenu(location, feedbackElement);
        } else {
            const existing = location.querySelector("#better-todo-actions-row");
            if (existing) existing.remove();
        }

        if (feedbackElement) {
            if (options.todo_hide_feedback == true) {
                feedbackElement.style.display = "none";
            } else {
                feedbackElement.style.display = "block";
            }
        }

        const sidebar = document.getElementById("right-side-wrapper");
        ensureRightSideWrapperScrollbarHidden();
        sidebar.style.setProperty("scrollbar-width", "none");
        sidebar.style.setProperty("-ms-overflow-style", "none");
		if (options.todo_full_height) {
			sidebar.style.minHeight = "100vh";
		} else {
			sidebar.style.minHeight = "";
		}
		if (options.todo_separate_scrollbar) {
			sidebar.style.position = "sticky";
			sidebar.style.top = "0";
			sidebar.style.height = "100vh";
			sidebar.style.overflowY = "auto";
		} else {
			sidebar.style.position = "";
			sidebar.style.top = "";
			sidebar.style.height = "";
			sidebar.style.overflowY = "";
			// maybe invisible scrollbar?
		}
	});
}

function ensureRightSideWrapperScrollbarHidden() {
    let style = document.getElementById("canvasrefined-hide-right-sidebar-scrollbar") || document.createElement("style");
    style.id = "canvasrefined-hide-right-sidebar-scrollbar";
    style.textContent = `
        #right-side-wrapper {
            scrollbar-width: none !important;
            -ms-overflow-style: none !important;
        }
        #right-side-wrapper::-webkit-scrollbar {
            width: 0 !important;
            height: 0 !important;
            display: none !important;
        }
    `;
    document.head.append(style);
}

function clearTodoList() {
    const seeMoreBtn = document.getElementById("better-todo-see-more");
    if (seeMoreBtn) {
        seeMoreBtn.remove();
    }

	document.getElementById("better-todo-main").querySelectorAll(".todo-group-list").forEach(list => {
		list.innerHTML = "";
	});
	document.querySelectorAll(".better-todo-dueheader").forEach(header => {
		header.remove();
	});
}

function populateAssignments(iscompleted = false) {
	const today = new Date();
	today.setHours(0,0,0,0);
    let assignments = (iscompleted ? completed : assignmentsDue).slice();
    if (iscompleted) {
        assignments.sort((a, b) => {
            const aIsGraded = Boolean(a.submissions?.graded);
            const bIsGraded = Boolean(b.submissions?.graded);
            if (aIsGraded !== bIsGraded) {
                return aIsGraded - bIsGraded;
            }
            return new Date(b.plannable_date) - new Date(a.plannable_date);
        });
    }

	let assignmentCount = 0;
	const maxElements = options.num_todo_items;

	assignments.forEach((item) => {
		let dueGroup = -1;
		if (!iscompleted) {
			let dueDate = new Date(item.plannable_date);
			dueDate.setHours(0,0,0,0);
			const diffDays = Math.round((dueDate - today) / (1000 * 60 * 60 * 24));
			if (diffDays < 0) {dueGroup = -1;}
			else if (diffDays <= 1) { dueGroup = diffDays.toString(); }
			else if (diffDays <= 7) { dueGroup = diffDays.toString(); }
			else if (diffDays <= 14) {dueGroup = 14;}
			else if (diffDays <= 21) {dueGroup = 21;}
			else if (diffDays <= 30) {dueGroup = 30;}
			else {dueGroup = "Later"};
		} else {
			dueGroup = item.submissions?.graded ? "Graded" : "Ungraded";
		}

		let assignment
		const targetContainer = domContainers[dueGroup];
		assignmentCount++;
		let isHidden = assignmentCount > maxElements;

		if (targetContainer) {
			if (!isHidden) {
				targetContainer.wrapper.style.display = "block";
				targetContainer.wrapper.setAttribute("data-has-visible", "true");
			}
			else {
				if (!targetContainer.wrapper.hasAttribute("data-has-visible")) {
					targetContainer.wrapper.classList.add(
						"better-todo-hidden-wrapper",
					);
				}
			}

			// targetContainer.wrapper.style.display = "block";
			assignment = makeElement("div", targetContainer.listContainer, {
				class: "better-todo-assignment",
			});
			if (isHidden) {
				assignment.style.display = "none";
				assignment.classList.add("better-todo-hidden-assignment");
			}
		}

		const courseColor =
			options.custom_cards_3?.[String(item.course_id)]?.color ??
			options.custom_cards_3?.[item.course_id]?.color ??
			options.custom_cards_3?.[item.plannable.course_id]?.color ??
			"#cccccc";

        const isCustomTask = item.plannable_type == "planner_note" || item.planner_override?.custom === true;
        const iconSize = isCustomTask ? 26 : 20;
        const iconLeftOffset = isCustomTask ? 2 : 5;
        const taskIcon = isCustomTask
            ? `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:100%;display:block;">
                <path d="M19.8201 14H15.6001C15.04 14 14.76 14 14.5461 14.109C14.3579 14.2049 14.2049 14.3578 14.1091 14.546C14.0001 14.7599 14.0001 15.0399 14.0001 15.6V19.82M20 12.7269V7.2C20 6.0799 20 5.51984 19.782 5.09202C19.5903 4.71569 19.2843 4.40973 18.908 4.21799C18.4802 4 17.9201 4 16.8 4H7.2C6.0799 4 5.51984 4 5.09202 4.21799C4.71569 4.40973 4.40973 4.71569 4.21799 5.09202C4 5.51984 4 6.0799 4 7.2V16.8C4 17.9201 4 18.4802 4.21799 18.908C4.40973 19.2843 4.71569 19.5903 5.09202 19.782C5.51984 20 6.0799 20 7.2 20H12.9496C13.4578 20 13.7118 20 13.9498 19.9407C14.1608 19.8882 14.3618 19.8016 14.5449 19.6844C14.7515 19.5522 14.926 19.3675 15.2751 18.9983L19.1254 14.9252C19.4486 14.5833 19.6101 14.4124 19.7255 14.2156C19.8278 14.041 19.903 13.8519 19.9486 13.6548C20 13.4325 20 13.1973 20 12.7269Z" stroke="var(--bctext-0, #1f1f1e)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path>
            </svg>`
            : `<svg fill="var(--bctext-0, #1f1f1e)" viewBox="0 0 1920 1920" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:100%;display:block;">
                <g id="SVGRepo_bgCarrier" stroke-width="1"></g><g id="SVGRepo_tracerCarrier" stroke-linecap="round" stroke-linejoin="round"></g>
                <g id="SVGRepo_iconCarrier">
                    <path d="M1468.214 0v551.145L840.27 1179.089c-31.623 31.623-49.693 74.54-49.693 119.715v395.289h395.288c45.176 0 88.093-18.07 119.716-49.694l162.633-162.633v438.206H0V0h1468.214Zm129.428 581.3c22.137-22.136 57.825-22.136 79.962 0l225.879 225.879c22.023 22.023 22.023 57.712 0 79.848l-677.638 677.637c-10.616 10.503-24.96 16.49-39.98 16.49H903.516v-282.35c0-15.02 5.986-29.364 16.49-39.867Zm-920.005 548.095H338.82v112.94h338.818v-112.94Zm225.88-225.879H338.818v112.94h564.697v-112.94Zm734.106-202.5-89.561 89.56 146.03 146.031 89.562-89.56-146.031-146.031Zm-508.228-362.197H338.82v338.818h790.576V338.82Z" fill-rule="evenodd"></path>
                </g>
            </svg>`;

		assignment.style.overflowX = "hidden";
		assignment.innerHTML = `
		<div style="display:flex;align-items:center;gap:5px;width:100%;height:60px;background:var(--bcbackground-2, #f7f6f3);border-radius:12px;transition:all .4s ease;overflow:hidden;">
			<div style="width:40px;display:flex;align-items:center;justify-content:center;background-color:${courseColor};height:100%;border-radius:12px 0 0 12px;">
                <div style="width:${iconSize}px;height:${iconSize}px;display:flex;margin-left:${iconLeftOffset}px;">
                    ${taskIcon}
				</div>
			</div>
			<div style="width:calc(100% - 40px);height:80%;display:flex;flex-direction:column;gap:5px;padding-left:2px;box-sizing:border-box;overflow:hidden;position:relative;">
				<div style="display:flex;flex-direction:column;gap:3px;">
					<span style="color:${courseColor};font-size:12px;margin-top:-2px;">${item.context_name}</span>
					<a href="${domain + item.html_url}" style="color:inherit;text-decoration:none;font-weight:bold;text-overflow:ellipsis;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:-5px;">${item.plannable.title}</a>
					<span class="canvasrefined-todoitem-due" style="font-size:12px;margin-top:-5px;">${convertToDueDate(item.plannable_date)}</span>
				</div>
				<svg class="better-todo-assignment-checkmark" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="width:15px;height:15px;position:absolute;top:0px;right:5px;opacity:0.3;transition:all .3s ease;cursor:pointer;" onmouseover="this.style.opacity='1'" onmouseout="this.style.opacity='0.3'">
					<g id="SVGRepo_bgCarrier" stroke-width="0"></g>
					<g id="SVGRepo_tracerCarrier" stroke-linecap="round" stroke-linejoin="round"></g>
					<g id="SVGRepo_iconCarrier"> <g id="Interface / Checkbox_Check">
						<path id="Vector" d="M8 12L11 15L16 9M4 16.8002V7.2002C4 6.08009 4 5.51962 4.21799 5.0918C4.40973 4.71547 4.71547 4.40973 5.0918 4.21799C5.51962 4 6.08009 4 7.2002 4H16.8002C17.9203 4 18.4796 4 18.9074 4.21799C19.2837 4.40973 19.5905 4.71547 19.7822 5.0918C20 5.5192 20 6.07899 20 7.19691V16.8036C20 17.9215 20 18.4805 19.7822 18.9079C19.5905 19.2842 19.2837 19.5905 18.9074 19.7822C18.48 20 17.921 20 16.8031 20H7.19691C6.07899 20 5.5192 20 5.0918 19.7822C4.71547 19.5905 4.40973 19.2842 4.21799 18.9079C4 18.4801 4 17.9203 4 16.8002Z" stroke="var(--bctext-0, #1f1f1e)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path>
					</g></g>
				</svg>
			</div>
		</div>
		`;
		assignment.querySelector(".better-todo-assignment-checkmark").addEventListener("click", () => {
			markAs(item, assignment.firstElementChild);
		});
	});

	if (document.getElementById("better-todo-see-more")) {
		document.getElementById("better-todo-see-more").remove();
	}

	if (assignmentCount > maxElements) {
		let isExpanded = false;

		let seeMoreButton = makeElement("button", document.getElementById("better-todo-main"), {
			textContent: `View More (${assignmentCount - maxElements})`,
			className: "canvasrefined-custom-btn",
			id: "better-todo-see-more",
			style: "width:100%;margin-top:15px;cursor:pointer;"
		})
		seeMoreButton.addEventListener("click", () => {
			if (!isExpanded) {
				document.querySelectorAll(".better-todo-hidden-assignment").forEach(element => element.style.display = "block");
				document.querySelectorAll(".better-todo-hidden-wrapper").forEach(element => element.style.display = "block");
				seeMoreButton.textContent = "View Less";
			} else {
				document.querySelectorAll(".better-todo-hidden-assignment").forEach(element => element.style.display = "none");
				document.querySelectorAll(".better-todo-hidden-wrapper").forEach(element => element.style.display = "none");
				seeMoreButton.textContent = `View More (${assignmentCount - maxElements})`;
			}
			isExpanded = !isExpanded;
		})
	}
}

function populateAnnouncements() {
	const today = new Date();
	today.setHours(0,0,0,0);

	announcements.forEach((item) => {
		let dueGroup = item.plannable.read_state == "read" ? "Seen" : "New";

		let announcement;
		// console.log(domContainers)
		const targetContainer = domContainers[dueGroup];
		if (targetContainer) {
			targetContainer.wrapper.style.display = "block";
			announcement = makeElement("div", targetContainer.listContainer, {
				class: "better-todo-announcement",
			});
		}

		const courseColor =
			options.custom_cards_3?.[String(item.course_id)]?.color ??
			options.custom_cards_3?.[item.course_id]?.color ??
			options.custom_cards_3?.[item.plannable.course_id]?.color ??
			"#cccccc";

		let filter = "";
		if (item.plannable.read_state == "read") {
			filter = "filter: grayscale(40%);"
		}

		announcement.innerHTML = `
		<div style="display:flex;align-items:center;gap:5px;width:100%;height:60px;background:var(--bcbackground-2, #f7f6f3);border-radius:12px;${filter}">
			<div style="width:40px;display:flex;align-items:center;justify-content:center;background-color:${courseColor};height:100%;border-radius:12px 0 0 12px;">
				<div style="width:23px;height:23px;display:flex;margin-left:0px;">
					<svg fill="var(--bctext-0, #1f1f1e)" viewBox="0 0 1920 1920" xmlns="http://www.w3.org/2000/svg" style="transition:all .3s ease;">
						<g id="SVGRepo_bgCarrier" stroke-width="0"></g><g id="SVGRepo_tracerCarrier" stroke-linecap="round" stroke-linejoin="round"></g>
						<g id="SVGRepo_iconCarrier">
							<path d="M1587.162 31.278c11.52-23.491 37.27-35.689 63.473-29.816 25.525 6.099 43.483 28.8 43.483 55.002V570.46C1822.87 596.662 1920 710.733 1920 847.053c0 136.32-97.13 250.503-225.882 276.705v513.883c0 26.202-17.958 49.016-43.483 55.002a57.279 57.279 0 0 1-12.988 1.468c-21.12 0-40.772-11.745-50.485-31.171C1379.238 1247.203 964.18 1242.347 960 1242.347H564.706v564.706h87.755c-11.859-90.127-17.506-247.003 63.473-350.683 52.405-67.087 129.657-101.082 229.948-101.082v112.941c-64.49 0-110.57 18.861-140.837 57.487-68.781 87.868-45.064 263.83-30.269 324.254 4.18 16.828.34 34.673-10.277 48.34-10.73 13.665-27.219 21.684-44.499 21.684H508.235c-31.171 0-56.47-25.186-56.47-56.47v-621.177h-56.47c-155.747 0-282.354-126.607-282.354-282.353v-56.47h-56.47C25.299 903.523 0 878.336 0 847.052c0-31.172 25.299-56.471 56.47-56.471h56.471v-56.47c0-155.634 126.607-282.354 282.353-282.354h564.593c16.941-.112 420.48-7.002 627.275-420.48Zm-5.986 218.429c-194.71 242.371-452.216 298.164-564.705 311.04v572.724c112.489 12.876 369.995 68.556 564.705 311.04ZM903.53 564.7H395.294c-93.402 0-169.412 76.01-169.412 169.411v225.883c0 93.402 76.01 169.412 169.412 169.412H903.53V564.7Zm790.589 123.444v317.93c65.618-23.379 112.94-85.497 112.94-159.021 0-73.525-47.322-135.53-112.94-158.909Z" fill-rule="evenodd"></path>
						</g>
					</svg>
				</div>
			</div>
			<div style="width:calc(100% - 40px);height:80%;display:flex;flex-direction:column;gap:5px;padding-left:2px;box-sizing:border-box;overflow:hidden;">
				<div style="display:flex;flex-direction:column;gap:3px;">
					<span style="color:${courseColor};font-size:12px;margin-top:-2px;">${item.context_name}</span>
					<a href="${domain + item.html_url}" style="color:inherit;text-decoration:none;font-weight:bold;text-overflow:ellipsis;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:-5px;">${item.plannable.title}</a>
					<span class="canvasrefined-todoitem-due" style="font-size:12px;margin-top:-5px;">${convertToDueDate(item.plannable_date)}</span>
				</div>
			</div>
		</div>
		`;
	});
}

function createConfettiBurst(targetElement, opts = {}) {
    try {
        if (options.todo_confetti === false) return;

        const count = opts.count || 48;
        const colors = opts.colors || ['#ff4d4f', '#ffc107', '#28a745', '#17a2b8', '#6f42c1', '#ff6b6b', '#ff8a65', '#ffd54f'];
        const rect = targetElement.getBoundingClientRect();
        const container = document.createElement('div');
        container.className = 'canvasrefined-confetti-container';
        container.style.position = 'fixed';
        container.style.left = '0';
        container.style.top = '0';
        container.style.pointerEvents = 'none';
        container.style.overflow = 'visible';
        container.style.zIndex = '2147483647';
        document.body.appendChild(container);

        const originX = rect.left + rect.width / 2;
        const originY = rect.top + rect.height * 0.35;
        const particles = [];

        for (let i = 0; i < count; i++) {
            const el = document.createElement('div');
            el.className = 'canvasrefined-confetti';
            const w = 4 + Math.floor(Math.random() * 7); // smaller pieces
            const h = Math.max(3, Math.floor(w * (0.4 + Math.random() * 0.8)));
            el.style.position = 'absolute';
            el.style.width = w + 'px';
            el.style.height = h + 'px';
            el.style.background = colors[Math.floor(Math.random() * colors.length)];
            el.style.left = (originX - w / 2) + 'px';
            el.style.top = (originY - h / 2) + 'px';
            el.style.opacity = '1';
            el.style.borderRadius = Math.random() > 0.75 ? '50%' : '2px';
            el.style.boxShadow = '0 2px 6px rgba(0,0,0,0.18)';
            el.style.transformOrigin = 'center center';
            el.style.willChange = 'transform, opacity';
            container.appendChild(el);

            const duration = 850 + Math.floor(Math.random() * 500);
            const delay = Math.floor(Math.random() * 90);
            const spread = opts.spread || 110;
            const horizontalBias = (Math.random() - 0.5) * 2;

            // Arc stays lower and wider than the old cone-shaped burst.
            const endX = originX + horizontalBias * (spread * (0.7 + Math.random() * 0.6));
            const endY = originY - (16 + Math.random() * 34);
            const ctrlX = originX + horizontalBias * (spread * 0.25) + (Math.random() - 0.5) * 14;
            const ctrlY = originY - (30 + Math.random() * 55);

            particles.push({
                el,
                delay,
                duration,
                originX,
                originY,
                ctrlX,
                ctrlY,
                endX,
                endY,
                rotate: (Math.random() * 260) - 130,
                scale: 0.8 + Math.random() * 0.5,
            });
        }

        const startTime = performance.now();
        let rafId = null;

        const animate = now => {
            let active = false;

            for (let i = particles.length - 1; i >= 0; i--) {
                const particle = particles[i];
                const elapsed = now - startTime - particle.delay;
                if (elapsed < 0) {
                    active = true;
                    continue;
                }

                const progress = Math.min(1, elapsed / particle.duration);
                const eased = 1 - Math.pow(1 - progress, 3);

                const x = (1 - eased) * (1 - eased) * particle.originX + 2 * (1 - eased) * eased * particle.ctrlX + eased * eased * particle.endX;
                const y = (1 - eased) * (1 - eased) * particle.originY + 2 * (1 - eased) * eased * particle.ctrlY + eased * eased * particle.endY;

                particle.el.style.transform = `translate(${Math.round(x - particle.originX)}px, ${Math.round(y - particle.originY)}px) rotate(${particle.rotate * eased}deg) scale(${particle.scale * (1 - eased * 0.15)})`;
                particle.el.style.opacity = String(1 - progress);

                if (progress < 1) {
                    active = true;
                } else {
                    particle.el.remove();
                    particles.splice(i, 1);
                }
            }

            if (active) {
                rafId = requestAnimationFrame(animate);
            } else {
                try { container.remove(); } catch (e) { /* ignore */ }
                if (rafId) cancelAnimationFrame(rafId);
            }
        };

        rafId = requestAnimationFrame(animate);

        // cleanup container after animations
        setTimeout(() => {
            try { container.remove(); } catch (e) { /* ignore */ }
        }, 2400);
    } catch (e) {
        logError(e);
    }
}

function markAs(item, element) {
	const csrfToken = CSRFtoken();
	const completeState = item.planner_override ? !item.planner_override.marked_complete : true;
    fetch(domain + "/api/v1/planner/overrides" + (item.planner_override ? "/" + item.planner_override.id : ""), {
		method: item.planner_override ? "PUT" : "POST",
		headers: {
			"content-type":"application/json",
			"accept":"application/json",
			"X-CSRF-Token": csrfToken
		},
		body: JSON.stringify({
			id: item.planner_override ? item.planner_override.id : null,
			marked_complete: completeState,
			plannable_id: item.plannable_id,
			plannable_type: item.plannable_type
		})
	})
	.then(resp => {
        if (resp.status == 200 || resp.status == 201 || resp.status == 204) {
			console.log("marked as complete");
			item.planner_override = item.planner_override || {};
			item.planner_override.marked_complete = completeState;
			element.style.transform = "translate(100%)";
			element.style.opacity = "0";

            // fire confetti only when marking complete (not when unmarking)
            if (completeState) {
                try { createConfettiBurst(element); } catch (e) { logError(e); }
            }

        // update progress rings immediately so they animate while the item slides/fades
        const progressPlaceholder = document.getElementById("better-todo-progress-placeholder");
        if (progressPlaceholder && typeof assignments?.then === 'function' && (options.todo_progress_rings === undefined || options.todo_progress_rings === true)) {
            assignments.then(data => {
                const courseId = getCurrentCourseId();
                const scopedData = courseId
                    ? data.map(d => Object.assign({}, d)) // shallow copy
                        .filter(d => {
                            const itemCourseId = parseInt(d.course_id || d.context_id || d?.plannable?.course_id);
                            return itemCourseId === courseId;
                        })
                    : data.map(d => Object.assign({}, d));

                // reflect the updated state for this item in the snapshot
                for (let i = 0; i < scopedData.length; i++) {
                    if (scopedData[i].plannable_id === item.plannable_id && scopedData[i].plannable_type === item.plannable_type) {
                        scopedData[i].planner_override = scopedData[i].planner_override || {};
                        scopedData[i].planner_override.marked_complete = item.planner_override.marked_complete;
                        break;
                    }
                }

                renderProgressRings(progressPlaceholder, scopedData);
            });
        }

        setTimeout(() => {
            clearTodoList();
            retiredLegacyTodoSections(document.querySelector("#canvasrefined-todo-list"));
        }, 400);
		}
	})
	.catch(err => logError(err));

}

function retiredLegacyTodoViewMore(location, type) {
    let viewMoreButton = makeElement("button", location, { "className": "canvasrefined-custom-btn canvasrefined-viewmore-btn", "textContent": "View More" });
    //viewMoreButton.classList.add("canvasrefined-viewmore-btn");
    const showMoreCount = 3;
    viewMoreButton.addEventListener("click", function (e) {
        if (type === "announcement") {
            moreAnnouncementCount += showMoreCount;
        } else {
            moreAssignmentCount += showMoreCount;
        }
        retiredLegacyTodoLoad();
    });
}

// better todo init
function retiredLegacyTodoSetup() {
    // Retired legacy setupBetterTodo: the integration below owns its child
    // host and never clears native #right-side content.
    return { ok: false, state: "retired" };
    /* istanbul ignore next -- retained source is unreachable compatibility code */
    if (options.better_todo !== true || isGradesPage()) return;
    if (document.querySelector('#canvasrefined-todo-list')) return;
    let list = document.querySelector("#right-side");
    if (!list) return;
    //if (!list || list.childElementCount === 0 || list.children[0].id === "canvasrefined-todo-list") return;
    try {
        /* save the feedback to append it later */
        const feedback = list.querySelector(".events_list.recent_feedback");

        list.textContent = "";
        list = makeElement("div", list, { "className": "canvasrefined-todosidebar","id": "canvasrefined-todo-list"});
        retiredLegacyTodoSections(list);

        if (feedback) list.append(feedback);

    } catch (e) {
        logError(e);
    }
}

function getSidebarScale() {
    const rawScale = parseInt(options.sidebar_scale || 100);
    if (isNaN(rawScale)) return 1;
    return Math.max(0.7, Math.min(1.5, rawScale / 100));
}

function applySidebarScaleStyles(sidebarList) {
    const scale = getSidebarScale();
    sidebarList.style.setProperty("--bc-sidebar-icon-size", `${Math.round(20 * scale)}px`);
    sidebarList.style.setProperty("--bc-sidebar-btn-height", `${Math.round(30 * scale)}px`);
    sidebarList.style.setProperty("--bc-sidebar-btn-gap", `${Math.round(8 * scale)}px`);
    sidebarList.style.setProperty("--bc-sidebar-label-size", `${Math.round(14 * scale)}px`);
}

async function setupBetterSidebar(mode = getSidebarLayoutMode()) {
    if (contentSidebarApi?.createSidebarController) {
        return;
    }
    if (!options.better_sidebar) return;
    if (document.querySelector('#better-sidebar-container')) return;
    let wrapper = document.querySelector("#wrapper");
    if (!wrapper || betterSidebarLoading) return;
    betterSidebarLoading = true;
    try {
        const layoutMode = mode === "course" || mode === "dash" ? mode : getSidebarLayoutMode();
        const outerWrapper = document.getElementById("main");
        outerWrapper?.style.setProperty("display", "flex", "important");
        // document.getElementById("not_right_side").style.setProperty("display", "none", "important");
        const leftSide = document.getElementById("left-side");
        leftSide?.style.setProperty("opacity", "1");
        leftSide?.style.setProperty("position", "static");
        const mainWrapper = document.querySelector(".ic-Layout-contentWrapper");
        if (!mainWrapper) return;
        applyBetterSidebarLayoutFix();
        mainWrapper.style.display = "flex";
        mainWrapper.style.alignItems = "stretch";
        mainWrapper.style.minWidth = "0";
        const contentMain = document.querySelector(".ic-Layout-contentMain");
        contentMain?.style.setProperty("flex", "1 1 auto");
        contentMain?.style.setProperty("min-width", "0");
        if (layoutMode === "course" && leftSide) {
            const notRightSide = document.getElementById("not_right_side");
            const rightSideWrapper = document.getElementById("right-side-wrapper");
            const sectionTabs = document.getElementById("section-tabs");
            leftSide.style.setProperty("padding-top", "0", "important");
            leftSide.style.setProperty("padding-left", "0", "important");
            if (sectionTabs) {
                if (getCurrentCourseId() !== null || isProfilePage()) {
                    sectionTabs.style.setProperty("padding-top", "40px", "important");
                } else {
                    sectionTabs.style.removeProperty("padding-top");
                }
            }
            leftSide.style.flex = "0 0 250px";
            leftSide.style.width = "250px";
            leftSide.style.maxWidth = "250px";
            if (notRightSide) {
                notRightSide.style.display = "flex";
                notRightSide.style.flex = "1 1 auto";
                notRightSide.style.minWidth = "0";
            }
            if (rightSideWrapper) {
                rightSideWrapper.style.flex = "0 0 280px";
                rightSideWrapper.style.width = "280px";
                rightSideWrapper.style.maxWidth = "280px";
            }
            contentMain?.style.setProperty("margin", "26px 38px 38px", "important");
            contentMain?.style.setProperty("padding", "10px", "important");
            contentMain?.style.setProperty("border-radius", "10px", "important");
            contentMain?.style.setProperty("background", "color-mix(in srgb, var(--bcbackground-0) 45%, transparent)", "important");
            contentMain?.style.setProperty("backdrop-filter", "blur(5px)", "important");
            contentMain?.style.setProperty("-webkit-backdrop-filter", "blur(5px)", "important");
        }
        const sidebarParent = layoutMode === "course" && leftSide ? leftSide : mainWrapper;
        if (layoutMode === "course" && leftSide) {
            leftSide.style.display = "flex";
            leftSide.style.flexDirection = "row";
            leftSide.style.alignItems = "stretch";
            leftSide.style.minWidth = "0";
            leftSide.style.gap = "0";
        }
        document.querySelector(".ic-app-nav-toggle-and-crumbs")?.style.setProperty("display", "none");
        if (layoutMode !== "course") {
            document.getElementById("left-side")?.style.removeProperty("display");
        }
        if (layoutMode == "dash") {
            document.getElementById("header")?.style.setProperty("display", "none");
        }
        else if (layoutMode == "course") {
            document.getElementById("header")?.style.setProperty("display", "none");
        }

        let sidebarList = makeElement("div", sidebarParent, { id: "better-sidebar-container",
            style: `display:flex;flex-direction:column;width:50px;justify-content:center;align-items:center;box-sizing:border-box;position:relative;background-color:var(--bcbackground-0);height:100vh;position:sticky;top:0;left:0;`
        }, true);
        let sidebarContent = makeElement("div", sidebarList, {
            style: "display:flex;flex-direction:column;gap:20px;width:100%;flex:1;justify-content:flex-start;align-items:center;margin:40px;"
        });
        applySidebarScaleStyles(sidebarList);
        let expander = makeElement("div", sidebarList, {
            className: "better-sidebar-expander",
            style: "display:flex;flex-direction:column;gap:0px;margin-top:auto;width:100%;justify-content:center;align-items:center;cursor:pointer;",
        });
        expander.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="width:30px;height:30px;transition:all .3s ease;">
                <g id="SVGRepo_bgCarrier" stroke-width="0"></g>
                <g id="SVGRepo_tracerCarrier" stroke-linecap="round" stroke-linejoin="round"></g>
                <g id="SVGRepo_iconCarrier">
                    <path d="M20 4V20M4 12H16M16 12L12 8M16 12L12 16" stroke="var(--bctext-0)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path>
                </g>
            </svg>
        `
        sidebarList.dataset.expanded = "false";
        updateSidebar(false, sidebarList, expander);
        requestAnimationFrame(() => populateSidebarFromNav(sidebarContent));

        let expanded = false;
        sidebarList.dataset.expanded = expanded ? "true" : "false";
        updateSidebar(expanded, sidebarList, expander);
        setSidebarExpandedState(layoutMode, expanded);
        // const labels = document.querySelectorAll(".better-sidebar-label");
        // labels.forEach(label => label.style.display = "none");
        expander.addEventListener("click", () => {
            expanded = !expanded;
            sidebarList.dataset.expanded = expanded ? "true" : "false";
            setSidebarExpandedState(layoutMode, expanded);
            updateSidebar(expanded, sidebarList, expander);
        })
    } catch (e) {
        logError(e);
    } finally {
        betterSidebarLoading = false;
    }
}
function createSidebarButton(text, url, parent, icon) {
	let button = makeElement("a", parent, {
        style: "width:40%;height:var(--bc-sidebar-btn-height,30px);cursor:pointer;text-align:center;text-decoration:none;display:inline-flex;justify-content:center;align-items:center;gap:var(--bc-sidebar-btn-gap,8px);color:var(--bctext-0) !important;font-weight:bold;position:relative;",
		className: "canvasrefined-custom-btn better-sidebar-btn",
		href: url,
	});
    button.innerHTML = `${icon ? `${icon}<span class="better-sidebar-label" style="font-size:var(--bc-sidebar-label-size,14px);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;">${text}</span>` : `<span class="better-sidebar-label" style="font-size:var(--bc-sidebar-label-size,14px);">${text}</span>`}`;
    return button;
}

function getNavBadgeCount(item) {
    const badge = item.querySelector(".menu-item__badge");
    if (!badge) return 0;
    const badgeText = badge.querySelector('[aria-hidden="true"]')?.textContent?.trim() || badge.textContent?.trim() || "";
    const count = parseInt(badgeText, 10);
    return Number.isFinite(count) && count > 0 ? count : 0;
}

function addSidebarButtonBadge(button, count) {
    if (!button || !count) return;
    button.querySelector(".better-sidebar-badge")?.remove();
    makeElement("div", button, {
        className: "better-sidebar-badge",
        style: "position:absolute;top:-6px;right:-6px;min-width:16px;height:16px;padding:0 4px;border-radius:999px;background-color:#b3261e;color:white;font-size:11px;line-height:16px;display:flex;justify-content:center;align-items:center;box-sizing:border-box;pointer-events:none;",
        textContent: String(count),
    });
}
function populateSidebarFromNav(sidebarContent) {
	const excludeIds = ["global_nav_help_link", "global_nav_history_link"];
	const customIcons = {
		"global_nav_profile_link": `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="width:20px;height:20px;"><g id="SVGRepo_bgCarrier" stroke-width="0"></g><g id="SVGRepo_tracerCarrier" stroke-linecap="round" stroke-linejoin="round"></g><g id="SVGRepo_iconCarrier"><path d="M12 12C14.21 12 16 10.21 16 8C16 5.79 14.21 4 12 4C9.79 4 8 5.79 8 8C8 10.21 9.79 12 12 12ZM12 14C9.33 14 4 15.34 4 18V20H20V18C20 15.34 14.67 14 12 14Z" fill="white"></path></g></svg>`,
		"global_nav_dashboard_link": `<svg fill="white" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" style="width:20px;height:20px;"><g id="SVGRepo_bgCarrier" stroke-width="0"></g><g id="SVGRepo_tracerCarrier" stroke-linecap="round" stroke-linejoin="round"></g><g id="SVGRepo_iconCarrier"><rect x="2" y="2" width="9" height="11" rx="2"></rect><rect x="13" y="2" width="9" height="7" rx="2"></rect><rect x="2" y="15" width="9" height="7" rx="2"></rect><rect x="13" y="11" width="9" height="11" rx="2"></rect></g></svg>`,
		"global_nav_conversations_link": `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="width:20px;height:20px;"><g id="SVGRepo_bgCarrier" stroke-width="0"></g><g id="SVGRepo_tracerCarrier" stroke-linecap="round" stroke-linejoin="round"></g><g id="SVGRepo_iconCarrier"><path d="M4 18L9 12M20 18L15 12M3 8L10.225 12.8166C10.8665 13.2443 11.1872 13.4582 11.5339 13.5412C11.8403 13.6147 12.1597 13.6147 12.4661 13.5412C12.8128 13.4582 13.1335 13.2443 13.775 12.8166L21 8M6.2 19H17.8C18.9201 19 19.4802 19 19.908 18.782C20.2843 18.5903 20.5903 18.2843 20.782 17.908C21 17.4802 21 16.9201 21 15.8V8.2C21 7.0799 21 6.51984 20.782 6.09202C20.5903 5.71569 20.2843 5.40973 19.908 5.21799C19.4802 5 18.9201 5 17.8 5H6.2C5.0799 5 4.51984 5 4.09202 5.21799C3.71569 5.40973 3.40973 5.71569 3.21799 6.09202C3 6.51984 3 7.07989 3 8.2V15.8C3 16.9201 3 17.4802 3.21799 17.908C3.40973 18.2843 3.71569 18.5903 4.09202 18.782C4.51984 19 5.07989 19 6.2 19Z" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path></g></svg>`,
		"global_nav_calendar_link": `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="width:20px;height:20px;"><g id="SVGRepo_bgCarrier" stroke-width="0"></g><g id="SVGRepo_tracerCarrier" stroke-linecap="round" stroke-linejoin="round"></g><g id="SVGRepo_iconCarrier"><path d="M3 9H21M7 3V5M17 3V5M6 12H8M11 12H13M16 12H18M6 15H8M11 15H13M16 15H18M6 18H8M11 18H13M16 18H18M6.2 21H17.8C18.9201 21 19.4802 21 19.908 20.782C20.2843 20.5903 20.5903 20.2843 20.782 19.908C21 19.4802 21 18.9201 21 17.8V8.2C21 7.07989 21 6.51984 20.782 6.09202C20.5903 5.71569 20.2843 5.40973 19.908 5.21799C19.4802 5 18.9201 5 17.8 5H6.2C5.0799 5 4.51984 5 4.09202 5.21799C3.71569 5.40973 3.40973 5.71569 3.21799 6.09202C3 6.51984 3 7.07989 3 8.2V17.8C3 18.9201 3 19.4802 3.21799 19.908C3.40973 20.2843 3.71569 20.5903 4.09202 20.782C4.51984 21 5.07989 21 6.2 21Z" stroke="white" stroke-width="2" stroke-linecap="round"></path></g></svg>`,
		"global_nav_courses_link": `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="width:20px;height:20px;"><g id="SVGRepo_bgCarrier" stroke-width="0"></g><g id="SVGRepo_tracerCarrier" stroke-linecap="round" stroke-linejoin="round"></g><g id="SVGRepo_iconCarrier"><path d="M20 12V4C20 2.89543 19.1046 2 18 2H6C4.89543 2 4 2.89543 4 4V20C4 21.1046 4.89543 22 6 22H18C19.1046 22 20 21.1046 20 20V18.5" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path><path d="M13 2V14L16.8182 11L20 14V5" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path></g></svg>`,
		"global_nav_groups_link": `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="width:20px;height:20px;"><g id="SVGRepo_bgCarrier" stroke-width="0"></g><g id="SVGRepo_tracerCarrier" stroke-linecap="round" stroke-linejoin="round"></g><g id="SVGRepo_iconCarrier"><path fill-rule="evenodd" clip-rule="evenodd" d="M16 6C14.3432 6 13 7.34315 13 9C13 10.6569 14.3432 12 16 12C17.6569 12 19 10.6569 19 9C19 7.34315 17.6569 6 16 6ZM11 9C11 6.23858 13.2386 4 16 4C18.7614 4 21 6.23858 21 9C21 10.3193 20.489 11.5193 19.6542 12.4128C21.4951 13.0124 22.9176 14.1993 23.8264 15.5329C24.1374 15.9893 24.0195 16.6114 23.5631 16.9224C23.1068 17.2334 22.4846 17.1155 22.1736 16.6591C21.1979 15.2273 19.4178 14 17 14C13.166 14 11 17.0742 11 19C11 19.5523 10.5523 20 10 20C9.44773 20 9.00001 19.5523 9.00001 19C9.00001 18.308 9.15848 17.57 9.46082 16.8425C9.38379 16.7931 9.3123 16.7323 9.24889 16.6602C8.42804 15.7262 7.15417 15 5.50001 15C3.84585 15 2.57199 15.7262 1.75114 16.6602C1.38655 17.075 0.754692 17.1157 0.339855 16.7511C-0.0749807 16.3865 -0.115709 15.7547 0.248886 15.3398C0.809035 14.7025 1.51784 14.1364 2.35725 13.7207C1.51989 12.9035 1.00001 11.7625 1.00001 10.5C1.00001 8.01472 3.01473 6 5.50001 6C7.98529 6 10 8.01472 10 10.5C10 11.7625 9.48013 12.9035 8.64278 13.7207C9.36518 14.0785 9.99085 14.5476 10.5083 15.0777C11.152 14.2659 11.9886 13.5382 12.9922 12.9945C11.7822 12.0819 11 10.6323 11 9ZM3.00001 10.5C3.00001 9.11929 4.1193 8 5.50001 8C6.88072 8 8.00001 9.11929 8.00001 10.5C8.00001 11.8807 6.88072 13 5.50001 13C4.1193 13 3.00001 11.8807 3.00001 10.5Z" fill="white"></path></g></svg>`,
		"globalNavExternalTool-69": `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="width:20px;height:20px;"><g id="SVGRepo_bgCarrier" stroke-width="0"></g><g id="SVGRepo_tracerCarrier" stroke-linecap="round" stroke-linejoin="round"></g><g id="SVGRepo_iconCarrier"><path fill-rule="evenodd" clip-rule="evenodd" d="M6 1C4.34315 1 3 2.34315 3 4V17V20C3 21.6569 4.34315 23 6 23H18C19.6569 23 21 21.6569 21 20V17V4C21 2.34315 19.6569 1 18 1H6ZM5 20V17C5 16.4477 5.44772 16 6 16H18C18.5523 16 19 16.4477 19 17V20C19 20.5523 18.5523 21 18 21H6C5.44772 21 5 20.5523 5 20ZM18 14C18.3506 14 18.6872 14.0602 19 14.1707V4C19 3.44772 18.5523 3 18 3H6C5.44772 3 5 3.44772 5 4V14.1707C5.31278 14.0602 5.64936 14 6 14H18ZM14.5 19.25C15.1904 19.25 15.75 18.6904 15.75 18C15.75 17.3096 15.1904 16.75 14.5 16.75C13.8096 16.75 13.25 17.3096 13.25 18C13.25 18.6904 13.8096 19.25 14.5 19.25Z" fill="white"></path></g></svg>`,
	};
	
	const navMenu = document.getElementById("menu");
    let hasDashboardButton = false;

    if (navMenu) {
        const menuItems = navMenu.querySelectorAll("a[id^='global_nav'], .globalNavExternalTool a");
        menuItems.forEach(item => {
            const itemId = item.id;
            if (excludeIds.includes(itemId)) return;

            const href = item.getAttribute("href");
            let textEl = item.querySelector(".menu-item__text");
            let text = textEl?.textContent?.trim();
		
            // If text not found, try other sources
            if (!text) {
                text = item.getAttribute("aria-label")?.trim() || 
                        item.getAttribute("title")?.trim() || 
                        item.textContent?.trim();
            }
		
            if (!text || !href) return;

            let icon = customIcons[itemId] || "";
            if (!icon) {
                const svg = item.querySelector("svg");
                if (svg) {
                    icon = svg.outerHTML;
                    // Detect and scale down large viewBox SVGs
                    const viewBoxMatch = icon.match(/viewBox="([^"]+)"/);
                    if (viewBoxMatch) {
                        const [, viewBox] = viewBoxMatch;
                        const parts = viewBox.split(/\s+/);
                        const width = parseFloat(parts[2]);
                        const height = parseFloat(parts[3]);
                        // If viewBox is large, add fixed size to scale it down
                        if (width > 32 || height > 32) {
                            // Check if svg already has a style attribute
                            if (icon.includes('style="')) {
                                // Append to existing style
                                icon = icon.replace(/style="([^"]*)"/, `style="$1 width:20px;height:20px;flex-shrink:0;fill:white;stroke:white;"`);
                            } else {
                                // Add new style attribute
                                icon = icon.replace("<svg", '<svg style="width:20px;height:20px;flex-shrink:0;fill:white;stroke:white;"');
                            }
                        } else {
                            // Smaller SVG - just add colors
                            if (icon.includes('style="')) {
                                icon = icon.replace(/style="([^"]*)"/, `style="$1 fill:white;stroke:white;flex-shrink:0;"`);
                            } else {
                                icon = icon.replace("<svg", '<svg style="fill:white;stroke:white;flex-shrink:0;"');
                            }
                        }
                    } else {
                        // No viewBox - just add colors
                        if (icon.includes('style="')) {
                            icon = icon.replace(/style="([^"]*)"/, `style="$1 fill:white;stroke:white;"`);
                        } else {
                            icon = icon.replace("<svg", '<svg style="fill:white;stroke:white;"');
                        }
                    }
                }
            }

            if (itemId === "global_nav_dashboard_link") hasDashboardButton = true;
            const button = createSidebarButton(text, href, sidebarContent, icon);
            addSidebarButtonBadge(button, getNavBadgeCount(item));
        });
    }

    if (!hasDashboardButton) {
        createSidebarButton("Dashboard", `${domain}/`, sidebarContent, customIcons["global_nav_dashboard_link"]);
    }
}
function updateSidebar(expanded, sidebarList, expander) {
    const scale = getSidebarScale();
    const expandedWidth = Math.round(150 * scale);
    const collapsedWidth = Math.round(50 * scale);
    sidebarList.style.width = expanded ? `${expandedWidth}px` : `${collapsedWidth}px`;
    applySidebarScaleStyles(sidebarList);

    expander.style.transform = expanded ? "rotate(180deg)" : "rotate(0deg)";
    expander.querySelector("svg").style.width = `${Math.round(30 * scale)}px`;
    expander.querySelector("svg").style.height = `${Math.round(30 * scale)}px`;
    const labels = document.querySelectorAll(".better-sidebar-label");
    labels.forEach(label => label.style.display = expanded ? "block" : "none");
    const buttons = document.querySelectorAll(".better-sidebar-btn");
    buttons.forEach(label => label.style.width = expanded ? "80%" : "40%");
    sidebarList.querySelectorAll(".better-sidebar-btn svg").forEach(svg => {
        svg.style.width = "var(--bc-sidebar-icon-size,20px)";
        svg.style.height = "var(--bc-sidebar-icon-size,20px)";
    });

    // Expand (or restore) the entire left-side column when the sidebar toggles
    const leftSide = document.getElementById("left-side");
    if (leftSide) {
        // on first run store the original width (prefer computed) and inline flex/maxWidth
        if (!leftSide.dataset.bcOrigWidth) {
            const computed = getComputedStyle(leftSide).width || "";
            leftSide.dataset.bcOrigWidth = leftSide.style.width || "";
            leftSide.dataset.bcOrigFlex = leftSide.style.flex || "";
            leftSide.dataset.bcOrigMaxWidth = leftSide.style.maxWidth || "";
            leftSide.dataset.bcOrigWidthPx = parseFloat(computed) || 0;
        }

        const origPx = parseFloat(leftSide.dataset.bcOrigWidthPx || 0);
        const delta = expandedWidth - collapsedWidth;

        if (expanded) {
            if (origPx > 0) {
                const newWidth = Math.round(origPx + delta);
                leftSide.style.flex = `0 0 ${newWidth}px`;
                leftSide.style.width = `${newWidth}px`;
                leftSide.style.maxWidth = `${newWidth}px`;
            } else {
                leftSide.style.flex = `0 0 ${expandedWidth}px`;
                leftSide.style.width = `${expandedWidth}px`;
                leftSide.style.maxWidth = `${expandedWidth}px`;
            }
        } else {
            // restore original inline values if present, otherwise remove the properties
            if (leftSide.dataset.bcOrigWidth !== "") leftSide.style.width = leftSide.dataset.bcOrigWidth; else leftSide.style.removeProperty('width');
            if (leftSide.dataset.bcOrigFlex !== "") leftSide.style.flex = leftSide.dataset.bcOrigFlex; else leftSide.style.removeProperty('flex');
            if (leftSide.dataset.bcOrigMaxWidth !== "") leftSide.style.maxWidth = leftSide.dataset.bcOrigMaxWidth; else leftSide.style.removeProperty('max-width');
        }
    }

    const courseLinksTitle = document.getElementById("better-course-links-title");
    if (courseLinksTitle) {
        courseLinksTitle.style.display = expanded ? "block" : "none";
        // Also hide separator when collapsed
        const separator = courseLinksTitle.nextElementSibling;
        if (separator) separator.style.display = expanded ? "block" : "none";
        
        const container = document.getElementById("better-course-links");
        if (container) {
            container.style.opacity = expanded ? "1" : "0.6";
            container.style.gap = expanded ? "12px" : "8px";
        }
    }
}
function getCourseLinks() {
	const linkList = document.getElementById("section-tabs");
	if (!linkList) return [];
	const links = linkList.querySelectorAll("a");
	const courseLinks = [];
	links.forEach(link => {
		const url = new URL(link.href).pathname;
		courseLinks.push({
			name: link.textContent.trim(),
			url: url
		});
	})
	return courseLinks;
}

let delay;
let moreAssignmentCount = 0;
let moreAnnouncementCount = 0;
let filter = "todo";
async function retiredLegacyTodoLoad() {
    // Retired legacy loadBetterTodo: data and rendering now flow through the
    // bounded Canvas/Nest integration created above.
    return { ok: false, state: "retired" };
    /* istanbul ignore next -- retained source is unreachable compatibility code */
    if (options.better_todo !== true || isGradesPage()) return;
    try {
        await getColors();
        const discussion_svg = '<svg class="canvasrefined-todo-svg" name="IconDiscussion" viewBox="0 0 1920 1920" rotate="0" aria-hidden="true" role="presentation" focusable="false"  ><g role="presentation"><path d="M677.647059,16 L677.647059,354.936471 L790.588235,354.936471 L790.588235,129.054118 L1807.05882,129.054118 L1807.05882,919.529412 L1581.06353,919.529412 L1581.06353,1179.29412 L1321.41176,919.529412 L1242.24,919.529412 L1242.24,467.877647 L677.647059,467.877647 L0,467.877647 L0,1484.34824 L338.710588,1484.34824 L338.710588,1903.24706 L756.705882,1484.34824 L1242.24,1484.34824 L1242.24,1032.47059 L1274.99294,1032.47059 L1694.11765,1451.59529 L1694.11765,1032.47059 L1920,1032.47059 L1920,16 L677.647059,16 Z M338.789647,919.563294 L903.495529,919.563294 L903.495529,806.622118 L338.789647,806.622118 L338.789647,919.563294 Z M338.789647,1145.44565 L677.726118,1145.44565 L677.726118,1032.39153 L338.789647,1032.39153 L338.789647,1145.44565 Z M112.941176,580.705882 L1129.41176,580.705882 L1129.41176,1371.40706 L710.4,1371.40706 L451.651765,1631.05882 L451.651765,1371.40706 L112.941176,1371.40706 L112.941176,580.705882 Z" fill-rule="evenodd" stroke="none" stroke-width="1"></path></g></svg>';
        const quiz_svg = '<svg class="canvasrefined-todo-svg" label="Quiz" name="IconQuiz" viewBox="0 0 1920 1920" rotate="0" aria-hidden="true" role="presentation" focusable="false"  ><g role="presentation"><g fill-rule="evenodd" stroke="none" stroke-width="1"><path d="M746.255375,1466.76417 L826.739372,1547.47616 L577.99138,1796.11015 L497.507383,1715.51216 L746.255375,1466.76417 Z M580.35118,1300.92837 L660.949178,1381.52637 L329.323189,1713.15236 L248.725192,1632.55436 L580.35118,1300.92837 Z M414.503986,1135.20658 L495.101983,1215.80457 L80.5979973,1630.30856 L0,1549.71056 L414.503986,1135.20658 Z M1119.32036,264.600006 C1475.79835,-91.8779816 1844.58834,86.3040124 1848.35034,88.1280123 L1848.35034,88.1280123 L1865.45034,96.564012 L1873.88634,113.664011 C1875.71034,117.312011 2053.89233,486.101999 1697.30034,842.693987 L1697.30034,842.693987 L1550.69635,989.297982 L1548.07435,1655.17196 L1325.43235,1877.81395 L993.806366,1546.30196 L415.712386,968.207982 L84.0863971,636.467994 L306.72839,413.826001 L972.602367,411.318001 Z M1436.24035,1103.75398 L1074.40436,1465.70397 L1325.43235,1716.61796 L1434.30235,1607.74796 L1436.24035,1103.75398 Z M1779.26634,182.406009 C1710.18234,156.41401 1457.90035,87.1020124 1199.91836,345.198004 L1199.91836,345.198004 L576.90838,968.207982 L993.806366,1385.10597 L1616.70235,762.095989 C1873.65834,505.139998 1804.68834,250.920007 1779.26634,182.406009 Z M858.146371,525.773997 L354.152388,527.597997 L245.282392,636.467994 L496.310383,887.609985 L858.146371,525.773997 Z"></path><path d="M1534.98715,372.558003 C1483.91515,371.190003 1403.31715,385.326002 1321.69316,466.949999 L1281.22316,507.305998 L1454.61715,680.585992 L1494.97315,640.343994 C1577.16715,558.035996 1591.87315,479.033999 1589.82115,427.164001 L1587.65515,374.610003 L1534.98715,372.558003 Z"></path></g></g></svg>';
        const announcement_svg = '<svg class="canvasrefined-todo-svg" label="Announcement" name="IconAnnouncement" viewBox="0 0 1920 1920" rotate="0" aria-hidden="true" role="presentation" focusable="false" ><g role="presentation"><path d="M1587.16235,31.2784941 C1598.68235,7.78672942 1624.43294,-4.41091764 1650.63529,1.46202354 C1676.16,7.56084707 1694.11765,30.2620235 1694.11765,56.4643765 L1694.11765,56.4643765 L1694.11765,570.459671 C1822.87059,596.662024 1920,710.732612 1920,847.052612 C1920,983.372612 1822.87059,1097.55614 1694.11765,1123.75849 L1694.11765,1123.75849 L1694.11765,1637.64085 C1694.11765,1663.8432 1676.16,1686.65732 1650.63529,1692.6432 C1646.23059,1693.65967 1641.93882,1694.11144 1637.64706,1694.11144 C1616.52706,1694.11144 1596.87529,1682.36555 1587.16235,1662.93967 C1379.23765,1247.2032 964.178824,1242.34673 960,1242.34673 L960,1242.34673 L564.705882,1242.34673 L564.705882,1807.05261 L652.461176,1807.05261 C640.602353,1716.92555 634.955294,1560.05026 715.934118,1456.37026 C768.338824,1389.2832 845.590588,1355.28791 945.882353,1355.28791 L945.882353,1355.28791 L945.882353,1468.22908 C881.392941,1468.22908 835.312941,1487.09026 805.044706,1525.71614 C736.263529,1613.58438 759.981176,1789.54673 774.776471,1849.97026 C778.955294,1866.79849 775.115294,1884.6432 764.498824,1898.30908 C753.769412,1911.97496 737.28,1919.99379 720,1919.99379 L720,1919.99379 L508.235294,1919.99379 C477.063529,1919.99379 451.764706,1894.80791 451.764706,1863.5232 L451.764706,1863.5232 L451.764706,1242.34673 L395.294118,1242.34673 C239.548235,1242.34673 112.941176,1115.73967 112.941176,959.993788 L112.941176,959.993788 L112.941176,903.5232 L56.4705882,903.5232 C25.2988235,903.5232 0,878.337318 0,847.052612 C0,815.880847 25.2988235,790.582024 56.4705882,790.582024 L56.4705882,790.582024 L112.941176,790.582024 L112.941176,734.111435 C112.941176,578.478494 239.548235,451.758494 395.294118,451.758494 L395.294118,451.758494 L959.887059,451.758494 C976.828235,451.645553 1380.36706,444.756141 1587.16235,31.2784941 Z M1581.17647,249.706729 C1386.46588,492.078494 1128.96,547.871435 1016.47059,560.746729 L1016.47059,560.746729 L1016.47059,1133.47144 C1128.96,1146.34673 1386.46588,1202.02673 1581.17647,1444.51144 L1581.17647,1444.51144 Z M903.529412,564.699671 L395.294118,564.699671 C301.891765,564.699671 225.882353,640.709082 225.882353,734.111435 L225.882353,734.111435 L225.882353,959.993788 C225.882353,1053.39614 301.891765,1129.40555 395.294118,1129.40555 L395.294118,1129.40555 L903.529412,1129.40555 L903.529412,564.699671 Z M1694.11765,688.144376 L1694.11765,1006.07379 C1759.73647,982.694965 1807.05882,920.577318 1807.05882,847.052612 C1807.05882,773.527906 1759.73647,711.5232 1694.11765,688.144376 L1694.11765,688.144376 Z" fill-rule="evenodd" stroke="none" stroke-width="1"></path></g></svg>';
        const assignment_svg = '<svg class="canvasrefined-todo-svg" label="Assignment" name="IconAssignment" viewBox="0 0 1920 1920" rotate="0" aria-hidden="true" role="presentation" focusable="false"><g role="presentation"><path d="M1468.2137,0 L1468.2137,564.697578 L1355.27419,564.697578 L1355.27419,112.939516 L112.939516,112.939516 L112.939516,1807.03225 L1355.27419,1807.03225 L1355.27419,1581.15322 L1468.2137,1581.15322 L1468.2137,1919.97177 L2.5243549e-29,1919.97177 L2.5243549e-29,0 L1468.2137,0 Z M1597.64239,581.310981 C1619.77853,559.174836 1655.46742,559.174836 1677.60356,581.310981 L1677.60356,581.310981 L1903.4826,807.190012 C1925.5058,829.213217 1925.5058,864.902104 1903.4826,887.038249 L1903.4826,887.038249 L1225.8455,1564.67534 C1215.22919,1575.17872 1200.88587,1581.16451 1185.86491,1581.16451 L1185.86491,1581.16451 L959.985883,1581.16451 C928.814576,1581.16451 903.516125,1555.86606 903.516125,1524.69475 L903.516125,1524.69475 L903.516125,1298.81572 C903.516125,1283.79477 909.501919,1269.45145 920.005294,1258.94807 L920.005294,1258.94807 Z M1442.35055,896.29929 L1016.45564,1322.1942 L1016.45564,1468.225 L1162.48643,1468.225 L1588.38135,1042.33008 L1442.35055,896.29929 Z M677.637094,1242.34597 L677.637094,1355.28548 L338.818547,1355.28548 L338.818547,1242.34597 L677.637094,1242.34597 Z M903.516125,1016.46693 L903.516125,1129.40645 L338.818547,1129.40645 L338.818547,1016.46693 L903.516125,1016.46693 Z M1637.62298,701.026867 L1522.19879,816.451052 L1668.22958,962.481846 L1783.65377,847.057661 L1637.62298,701.026867 Z M1129.39516,338.829841 L1129.39516,790.587903 L338.818547,790.587903 L338.818547,338.829841 L1129.39516,338.829841 Z M1016.45564,451.769356 L451.758062,451.769356 L451.758062,677.648388 L1016.45564,677.648388 L1016.45564,451.769356 Z" fill-rule="evenodd" stroke="none" stroke-width="1"></path></g></svg>';
        const x_svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path stroke="none" d="M0 0h24v24H0z" fill="none"></path><path d="M18 6l-12 12"></path><path d="M6 6l12 12"></path></svg>';
        const check_svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path stroke="none" d="M0 0h24v24H0z" fill="none"></path><path d="M5 12l5 5l10 -10"></path></svg>';
        const tag_svg = '<svg  xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"  fill="none"  stroke="currentColor"  stroke-width="2"  stroke-linecap="round"  stroke-linejoin="round"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M7.5 7.5m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" /><path d="M3 6v5.172a2 2 0 0 0 .586 1.414l7.71 7.71a2.41 2.41 0 0 0 3.408 0l5.592 -5.592a2.41 2.41 0 0 0 0 -3.408l-7.71 -7.71a2 2 0 0 0 -1.414 -.586h-5.172a3 3 0 0 0 -3 3z" /></svg>';
        // end of SVGs

        const maxAssignmentCount = parseInt(options.num_todo_items) + moreAssignmentCount;
        const maxAnnouncementCount = parseInt(options.num_todo_items) + moreAnnouncementCount;
        const hr24 = options.todo_hr24;
        const now = new Date();
        //const csrfToken = CSRFtoken();
        let todoAnnouncements = document.querySelector("#canvasrefined-announcement-list");
        let todoAssignments = document.querySelector("#canvasrefined-todo-list");
        let assignmentsToInsert = [];
        let announcementsToInsert = [];

        assignments.then(data => {
            chrome.storage.sync.get(options.custom_assignments_overflow, storage => {
                //assignmentData = assignmentData === null ? data : assignmentData;
                let items = combineAssignments(data);
                items.forEach((item, index) => {
                    let date = new Date(item.plannable_date);
                    let itemState = options.assignment_states[item.plannable_id];

                    let svg;
                    switch (item.plannable_type) {
                        case "assignment": svg = assignment_svg; break;
                        case "discussion_topic": svg = discussion_svg; break;
                        case "quiz": svg = quiz_svg; break;
                        case "announcement": svg = announcement_svg; break;
                        default: return;
                    }

                    // if (item.plannable_type === "announcement") {
                    //if (announcementsToInsert.length >= maxAnnouncementCount + 1) return;
                    if (item.plannable_type !== "announcement") {
                        // leaving one extra assignment in the array to indicate there are more and the "view more" button should be created
                        if (assignmentsToInsert.length >= maxAssignmentCount + 1) return;
                        if (filter === "todo" && options.hide_completed === true && item.submissions.submitted === true) return;
                        if (filter === "todo" && ((options.todo_overdues !== true && now >= date) || (options.todo_overdues === true && item.submissions.submitted === true))) return;
                        if (filter === "done" && now <= date && !(itemState?.["rem"] === true || item?.submissions?.submitted === true)) return;
                        //if (item.plannable_type !== "assignment" && item.plannable_type !== "quiz" && item.plannable_type !== "discussion_topic") return;
                    }
                    if (filter === "todo" && ((itemState && itemState["rem"] === true) || (item.planner_override && item.planner_override.marked_complete === true))) return;

                    let listItemContainer = document.createElement("div");
                    listItemContainer.classList.add("canvasrefined-todo-container");
                    listItemContainer.innerHTML = '<div class="canvasrefined-hover-preview"><p class="canvasrefined-preview-title"></p><p class="canvasrefined-preview-text"></p></div><div class="canvasrefined-todo-actions"></div><div class="canvasrefined-todo-icon"></div><a class="canvasrefined-todo-item"><div class="canvasrefined-todo-item-header"></div></a><button class="canvasrefined-todo-actions-btn"><i class="icon-more canvasrefined-dots-icon" aria-hidden="true"></i></button>';
                    listItemContainer.querySelector(".canvasrefined-todo-item").href = item.html_url;
                    listItemContainer.dataset.id = item.plannable_id;
                    listItemContainer.querySelector('.canvasrefined-todo-icon').innerHTML += svg;

                    let listItem = listItemContainer.querySelector(".canvasrefined-todo-item");
                    const courseColor =
                        options.custom_cards_3?.[String(item.course_id)]?.color ??
                        options.custom_cards_3?.[item.course_id]?.color ??
                        options.custom_cards_3?.[item.plannable?.course_id]?.color ??
                        "#cccccc";
                    if (itemState?.["lbl"] && itemState["lbl"] !== "") {
                        makeElement("span", listItem.querySelector(".canvasrefined-todo-item-header"), { "className": "canvasrefined-todo-label", "textContent": itemState["lbl"] });
                    }
                    if (itemState?.["crs"] === true) {
                        listItemContainer.querySelector(".canvasrefined-todo-item").style.textDecoration = "line-through";
                    }
                    let title = makeElement("a", listItem.querySelector(".canvasrefined-todo-item-header"), { "className": "canvasrefined-todoitem-title", "textContent": item.plannable.title });
                    if (options.todo_hide_feedback === true) title.style = "color:" + courseColor + "!important;";
                    let course = makeElement("p", listItem, { "className": "canvasrefined-todoitem-course", "textContent": item.context_name });
                    course.style.color = courseColor;
                    let format = formatTodoDate(date, item.submissions, hr24);
                    let todoDate = makeElement("p", listItem, { "className": "canvasrefined-todoitem-date", "textContent": format.date });
                    if (format.dueSoon) todoDate.classList.add("canvasrefined-due-soon");

                    if (options.hover_preview === true) {
                        const customItem = item.planner_override && item.planner_override.custom && item.planner_override.custom === true;
                        listItem.addEventListener("mouseover", () => {
                            listItem.classList.add("canvasrefined-todo-hover");
                            let preview = listItemContainer.querySelector(".canvasrefined-hover-preview");
                            let previewTitle = preview.querySelector(".canvasrefined-preview-title");
                            let previewText = preview.querySelector(".canvasrefined-preview-text");
                            clearTimeout(delay);
                            delay = setTimeout(async () => {
                                if (listItem.classList.contains("canvasrefined-todo-hover")) {
                                    previewTitle.textContent = item.plannable.title;
                                    // custom assignment
                                    if (customItem) {
                                        previewText.textContent = "Custom assignment";
                                    } else {
                                        let found = false;
                                        let searchCount = 1;
                                        while (searchCount < 5 && found === false) {
                                            for (let i = 0; i < announcements.length; i++) {
                                                if (announcements[i].id === item.plannable_id) {
                                                    found = true;
                                                    if (previewText.textContent === "") {
                                                        let description = item.plannable_type === "announcement" ? announcements[i].message : announcements[i].description;
                                                        previewText.textContent = description === "" ? "No details given" : description.replace(/<\/?[^>]+(>|$)/g, " ");
                                                    }
                                                    break;
                                                }
                                            }
                                            if (found === false) {
                                                let apiLink = domain + "/api/v1/";
                                                if (item.plannable_type === "assignment") {
                                                    apiLink += `courses/${item.course_id}/assignments/${item.plannable_id}`;
                                                } else if (item.plannable_type === "announcement") {
                                                    apiLink += `announcements?context_codes[]=course_${item.course_id}&per_page=3&page=${searchCount}`;
                                                }
                                                let data = await getData(apiLink);
                                                item.plannable_type === "announcement" ? announcements.push(...data) : announcements.push(data);
                                                searchCount++;
                                            }
                                        }
                                        if (found === false) {
                                            previewText.textContent = "Couldn't load preview";
                                        }
                                    }
                                    preview.style.display = "block";
                                }
                            }, 250);
                        });

                        listItem.addEventListener("mouseleave", () => {
                            listItem.classList.remove("canvasrefined-todo-hover");
                            listItemContainer.querySelector(".canvasrefined-hover-preview").style.display = "none";
                        });
                    }

                    const actions = listItemContainer.querySelector(".canvasrefined-todo-actions");

                    let clickOutActions = (e) => {
                        if (e.target.className.includes("canvasrefined")) return;
                        document.body.removeEventListener("click", clickOutActions);
                        actions.style.display = "none";
                    }

                    listItemContainer.querySelector(".canvasrefined-todo-actions-btn").addEventListener("click", () => {
                        actions.style.display = "block";
                        setTimeout(() => {
                            document.body.addEventListener("click", clickOutActions);
                        }, 100);
                    });

                    let removeBtn = makeElement("div", actions, { "className": "canvasrefined-todo-action", "textContent": "Remove" });
                    removeBtn.innerHTML += x_svg;
                    const dueAt = new Date(item.plannable_date).getTime();

                    let crossOffBtn = makeElement("div", actions, { "className": "canvasrefined-todo-action", "textContent": "Cross off" });
                    crossOffBtn.innerHTML += check_svg;
                    crossOffBtn.addEventListener("click", () => {
                        setAssignmentState(item.plannable_id, { "crs": listItemContainer.querySelector(".canvasrefined-todo-item").style.textDecoration === "line-through" ? false : true, "expire": dueAt });
                    });
                    let label = makeElement("span", actions, { "className": "canvasrefined-todo-action-tag", "textContent": "Label:" });
                    label.innerHTML += tag_svg;
                    let labelInput = makeElement("input", actions, { "className": "canvasrefined-todo-input", "type": "text", "placeholder": "Label", "value": itemState && itemState["lbl"] ? itemState["lbl"] : "" });
                    labelInput.addEventListener("change", (e) => {
                        setAssignmentState(item.plannable_id, { "lbl": e.target.value, "expire": dueAt });
                    });

                    removeBtn.addEventListener('click', function () {
                        setAssignmentState(item.plannable_id, { "rem": filter === "todo", "expire": dueAt });
                        if (item.planner_override && item.planner_override.custom && item.planner_override.custom === true) {
                            // set item as complete locally
                            chrome.storage.sync.get("custom_assignments_overflow", overflow => {
                                chrome.storage.sync.get(overflow["custom_assignments_overflow"], storage => {
                                    overflow["custom_assignments_overflow"].forEach(overflow => {
                                        for (let i = 0; i < storage[overflow].length; i++) {
                                            if (storage[overflow][i].plannable_id === item.plannable_id) {
                                                storage[overflow].splice(i, 1);
                                                chrome.storage.sync.set({ [overflow]: storage[overflow] }).then(() => {
                                                }).catch((error) => logError(error));
                                                break;
                                            }
                                        }
                                    });
                                });
                            });
                        }
                    });
                    if (item.plannable_type === "announcement") {
                        announcementsToInsert.push(listItemContainer);
                    } else {
                        assignmentsToInsert.push(listItemContainer);
                        if (item.submissions && item.submissions.submitted) {
                            listItemContainer.classList.add("canvasrefined-todo-item-completed");
                        }
                    }
                });

                // appending assignments all at once
                todoAssignments.textContent = "";
                if (assignmentsToInsert.length > 0) {
                    let i;
                    for (i = 0; i < (assignmentsToInsert.length > maxAssignmentCount ? maxAssignmentCount : assignmentsToInsert.length); i++) {
                        todoAssignments.append(assignmentsToInsert[i]);
                    }
                    if (i !== assignmentsToInsert.length) retiredLegacyTodoViewMore(todoAssignments, "assignment");
                } else {
                    makeElement("p", todoAssignments, { "className": "canvasrefined-none-due", "textContent": "None" });
                }

                // appending announcements all at once
                todoAnnouncements.textContent = "";
                if (announcementsToInsert.length > 0) {
                    let i;
                    for (i = announcementsToInsert.length - 1; i >= (announcementsToInsert.length - maxAnnouncementCount < 0 ? 0 : announcementsToInsert.length - maxAnnouncementCount); i--) {
                        todoAnnouncements.append(announcementsToInsert[i]);
                    }
                    if (i !== -1) retiredLegacyTodoViewMore(todoAnnouncements, "announcement");
                } else {
                    makeElement("p", todoAnnouncements, { "className": "canvasrefined-none-due", "textContent": "None" });
                }

                cleanCustomAssignments();
            });
        });

    } catch (e) {
        logError(e);
    }
}

/*
Card color palettes
*/

let changeColorInterval = null;
let colorChanges = [];
async function changeColorPreset(colors) {

    if (colors.length === 0) return;

    // reset everything
    //let res = await getData(`${domain}/api/v1/users/self/colors`);
    clearInterval(changeColorInterval);
    const csrfToken = CSRFtoken();
    const delay = 250;
    previous = []
    colorChanges = [];

    // sort cards
    let cards = document.querySelectorAll(".ic-DashboardCard__header");
    let sortedCards = [];
    cards.forEach(card => {
        sortedCards.push({ "href": card.querySelector(".ic-DashboardCard__link").href, "el": card });
    });
    sortedCards.sort((a, b) => a.href > b.href ? 1 : -1);

    // push each color change into a queue
    try {
        sortedCards.forEach((card, i) => {
            let previousColor = rgbToHex(card.el.querySelector(".ic-DashboardCard__header_hero").style.backgroundColor);
            previous.push(previousColor);

            // Object.keys(res.custom_colors).forEach(item => {
            //let item_id = item.split("_")[1];
            let course_id = card.href.split("courses/")[1];

            //if (card.href.includes(item_id)) {
            let cnum = i % colors.length;

            let changeCardColor = () => {
                fetch(domain + "/api/v1/users/self/colors/courses_" + course_id,
                    {
                        method: "PUT",
                        headers: {
                            "content-type": "application/json",
                            'accept': 'application/json',
                            'X-CSRF-Token': csrfToken,
                        },
                        body: JSON.stringify({ "hexcode": colors[cnum] })
                    }).then(() => {
                        card.el.querySelector(".ic-DashboardCard__header_hero").style.backgroundColor = colors[cnum];
                        card.el.querySelector(".ic-DashboardCard__header-title span").style.color = colors[cnum];
                        card.el.querySelector(".ic-DashboardCard__header-button-bg").style.backgroundColor = colors[cnum];
                    });
            }

            colorChanges.push(changeCardColor);

            card.el.querySelector(".ic-DashboardCard__header_hero").style.backgroundColor = colors[cnum];
            card.el.querySelector(".ic-DashboardCard__header-title span").style.color = colors[cnum];
            card.el.querySelector(".ic-DashboardCard__header-button-bg").style.backgroundColor = colors[cnum];
            //}
            // });
        });
    } catch (e) {
        logError(e);
        colorChanges = [];
    }

    changeGradientCards();

    // go through the queue until empty
    changeColorInterval = setInterval(() => {
        if (colorChanges.length > 0) {
            let current = colorChanges.shift();
            current();
        } else {
            clearInterval(changeColorInterval);
        }
    }, delay);

    // set colors to revert back to
    chrome.storage.local.get("previous_colors", local => {
        const now = Date.now();
        if (local["previous_colors"] === null || now >= local["previous_colors"].expire) {
            chrome.storage.local.set({ "previous_colors": { "colors": previous, "expire": now + 86400000 } });
        }
    });
}

/*
Dark mode
*/

function generateDarkModeCSS() {
    let css =
		(options.device_dark === true
			? "@media (prefers-color-scheme: dark) {\n"
			: "") + ":root{\n";
	if (options.dark_preset) {
		Object.keys(options.dark_preset).forEach((key) => {
			css += "    --bc" + key + ": " + options.dark_preset[key] + ";\n";
		});
	}
	css += "}\n\n";
	css += DARKMODE_CSS;
	css += options.device_dark === true ? "\n}" : "";
	return css;
}

let darkStyleInserted = false;
function toggleDarkMode() {
    const css = generateDarkModeCSS();
    const enabled = options.dark_mode === true || options.device_dark === true;
    if (enabled && !darkStyleInserted) {
        let style = document.createElement('style');
        style.textContent = css;
        document.documentElement.append(style);
        style.id = 'darkcss';
        style.className = "canvasrefined-darkmode-enabled";
        darkStyleInserted = true;
    } else if (darkStyleInserted) {
        let style = document.querySelector("#darkcss");
        if (enabled) {
            style.textContent = css;
            style.className = "canvasrefined-darkmode-enabled";
        } else if (style) {
            style.textContent = "";
            style.className = "";
            style.remove();
            darkStyleInserted = false;
        }
    }
    runiframeChecker();
}

function runDarkModeFixer(override = false) {
    if (options.dark_mode !== true) return { "path": "canvasrefined-darkmode_off", "time": "" };
    if (override === false && !options["dark_mode_fix"].includes(window.location.pathname)) return { "path": "canvasrefined-none", "time": "" };
    let output = inspectDarkMode();
    return { "path": window.location.pathname, "time": output.time };
}

function autoDarkModeCheck() {
    let date = new Date();
    let currentHour = date.getHours();
    let currentMinute = date.getMinutes();
    let status = false;
    if (options.auto_dark === false) return;
    let startHour = parseInt(options.auto_dark_start["hour"]);
    let startMinute = parseInt(options.auto_dark_start["minute"]);
    let endHour = parseInt(options.auto_dark_end["hour"]);
    let endMinute = parseInt(options.auto_dark_end["minute"]);
    if (currentHour === startHour) {
        status = currentMinute >= startMinute;
    } else if (currentHour === endHour) {
        status = currentMinute <= endMinute;
    } else if (startHour > endHour) {
        status = currentHour > startHour || currentHour < endHour;
    } else if (startHour < endHour) {
        status = currentHour > startHour && currentHour < endHour;
    }
    if (options.auto_dark === true) {
        options.dark_mode = status;
        const save = chrome.storage.sync.set({ "dark_mode": status }, () => {
            runRecurringContentWork(() => toggleDarkMode(), "auto-dark mode update");
        });
        if (save && typeof save.then === "function") {
            save.catch((error) => {
                if (isContentContextInvalidated(error)) {
                    invalidateContentContext("auto-dark-save", error);
                    return;
                }
                logError(error);
            });
        }
    }
}

function runAutoDarkModeCheck() {
    return runRecurringContentWork(() => autoDarkModeCheck(), "auto-dark mode");
}

function toggleAutoDarkMode() {
    clearInterval(timeCheck);
    timeCheck = null;
    if (recurringContentWorkStopped) return;
    if (options.auto_dark && options.auto_dark === false) return;
    runAutoDarkModeCheck();
    timeCheck = setInterval(runAutoDarkModeCheck, 60000);
}

let iframeObserver;
function runiframeChecker() {
    if (current_page === "/" || current_page === "") return;

    if (iframeObserver) {
        iframeObserver.disconnect();
        iframeObserver = null;
    }

    if (options.dark_mode !== true) {
        document.querySelectorAll('iframe').forEach((frame) => {
            if (frame.contentDocument && frame.contentDocument.documentElement && frame.contentDocument.documentElement.querySelector('#darkcss')) {
                frame.contentDocument.documentElement.querySelector('#darkcss').textContent = '';
                frame.contentDocument.body.classList.remove("canvasrefined--darkmode--enabled");
            }
        });
        return;
    }

    const callback = (mutationList) => {
        for (const mutation of mutationList) {
            if (mutation.type === 'childList' && mutation.addedNodes.length > 0 && mutation.addedNodes[0].nodeName == "IFRAME") {
                const frame = mutation.addedNodes[0];
                const new_style_element = document.createElement("style");
                new_style_element.textContent = generateDarkModeCSS();
                new_style_element.id = "darkcss";
                frame.contentDocument.body.classList.add("canvasrefined--darkmode--enabled");
                frame.contentDocument.documentElement.prepend(new_style_element);
            }
        }
    };

    iframeObserver = new MutationObserver(callback);
    iframeObserver.observe(document.querySelector('html'), { childList: true, subtree: true });
}

/* 
Dashboard grades 
*/

function insertGrades() {
    if (options.dashboard_grades === true) {
        grades.then(data => {
            // A pending score request may finish after the control is turned
            // off. Do not let that stale callback revive hidden grade badges.
            if (options.dashboard_grades !== true) return;
            try {
                let cards = document.querySelectorAll('.ic-DashboardCard');
                if (cards.length === 0 || cards[0].querySelectorAll(".ic-DashboardCard__link").length === 0) return;
                for (let i = 0; i < cards.length; i++) {
                    const cardLink = cards[i].querySelector(".ic-DashboardCard__link");
                    const course = contentCardAppearanceApi?.canvasCourseLocation?.(cardLink?.href, domain);
                    if (!course) continue;
                    const grade = Array.isArray(data) ? data.find((candidate) => String(candidate?.id) === course.courseId) : null;
                    if (!grade) continue;
                    const enrollment = grade?.enrollments?.[0];
                    const rawScore = enrollment?.has_grading_periods === true
                        ? enrollment?.current_period_computed_current_score
                        : enrollment?.computed_current_score;
                    const score = typeof rawScore === "number" ? rawScore : Number.parseFloat(String(rawScore ?? "").trim());
                    const available = Number.isFinite(score);
                    const letter = options.card_letter_grade_visible === true
                        ? contentCardAppearanceApi?.resolveLetterGrade?.(score, options.gpa_calc_bounds, contentGpaApi)
                        : null;
                    const text = available ? `${rawScore}%${letter ? ` · ${letter}` : ""}` : "Grade unavailable";
                    const gradeContainer = cards[i].querySelector(".canvasrefined-card-grade") || makeElement("a", cards[i].querySelector(".ic-DashboardCard__header"), { "className": "canvasrefined-card-grade" });
                    if (!gradeContainer) continue;
                    if (gradeContainer.textContent !== text) gradeContainer.textContent = text;
                    gradeContainer.setAttribute("aria-label", available ? `Course grade: ${text}` : "Course grade unavailable");
                    gradeContainer.classList.toggle("canvasrefined-hover-only", options.grade_hover === true);
                    const gradeDestination = contentCardAppearanceApi?.courseDestination?.(domain, course.courseId, "grades");
                    const gradeHref = gradeDestination?.href || "";
                    if (available && gradeHref) {
                        if (gradeContainer.getAttribute("href") !== gradeHref) gradeContainer.setAttribute("href", gradeHref);
                        gradeContainer.removeAttribute("aria-disabled");
                        gradeContainer.removeAttribute("tabindex");
                    } else {
                        gradeContainer.removeAttribute("href");
                        gradeContainer.setAttribute("aria-disabled", "true");
                        gradeContainer.setAttribute("tabindex", "-1");
                    }
                    if (gradeContainer.style.display !== "block") gradeContainer.style.display = "block";

                }
            } catch (e) {
                logError(e);
            }
        });
    } else {
        document.querySelectorAll('.canvasrefined-card-grade').forEach(grade => {
            if (grade.style.display !== "none") grade.style.display = "none";
        });
    }
}

/*
Card assignments
*/

function cardAssignmentKey(assignment) {
    return `${assignment?.course_id ?? ""}:${assignment?.plannable_type ?? ""}:${assignment?.plannable_id ?? ""}`;
}

function updateCardAssignment(assignmentContainer, assignment, courseId) {
    const assignmentName = assignmentContainer.querySelector(".canvasrefined-assignment-link");
    const assignmentDueAt = assignmentContainer.querySelector(".canvasrefined-assignment-dueat");
    const title = String(assignment?.plannable?.title || "");
    const destination = contentCardAppearanceApi?.sameCourseCanvasLocation?.(assignment?.html_url, {
        origin: domain,
        courseId,
        section: "assignments"
    });
    const dueText = formatCardDue(new Date(assignment?.plannable_date));
    if (assignmentName.textContent !== title) assignmentName.textContent = title;
    if (destination?.href) {
        if (assignmentName.getAttribute("href") !== destination.href) assignmentName.setAttribute("href", destination.href);
        assignmentName.removeAttribute("aria-disabled");
    } else {
        assignmentName.removeAttribute("href");
        assignmentName.setAttribute("aria-disabled", "true");
    }
    if (assignmentDueAt.textContent !== dueText) assignmentDueAt.textContent = dueText;
    assignmentDueAt.classList.toggle("canvasrefined-assignment-overdue", assignment?.overdue === true);
    const completed = assignment?.submissions?.submitted === true
        || options?.assignment_states?.[assignment?.plannable_id]?.crs === true;
    assignmentContainer.classList.toggle("canvasrefined-completed", completed);
    assignmentContainer.__apstudyAssignment = assignment;
}

function createCardAssignment(assignment, courseId) {
    let assignmentContainer = document.createElement("div");
    assignmentContainer.className = "canvasrefined-assignment-container";
    assignmentContainer.dataset.apstudyAssignmentKey = cardAssignmentKey(assignment);
    makeElement("a", assignmentContainer, { "className": "canvasrefined-assignment-link" });
    let assignmentDueAt = makeElement("span", assignmentContainer, { "className": "canvasrefined-assignment-dueat" });
    updateCardAssignment(assignmentContainer, assignment, courseId);
    assignmentDueAt.addEventListener('mouseup', function () {
        assignmentContainer.classList.toggle("canvasrefined-completed");
        const status = assignmentContainer.classList.contains("canvasrefined-completed");
        const current = assignmentContainer.__apstudyAssignment;
        if (typeof setAssignmentState === "function") {
            setAssignmentState(current?.plannable_id, { "crs": status, "expire": current?.plannable_date });
        }
    });
    return assignmentContainer;
}

function preloadAssignmentEls() {
    return new Promise((resolve) => {
        let assignmentEls = {};
        const now = new Date();
        Promise.resolve(assignments).then((data) => {
            data = combineAssignments(data);
            data.forEach(item => {
                let due = new Date(item.plannable_date);
                item.overdue = now >= due;
                let o = {
                    "item": item,
                    "submitted": item.submissions && item.submissions.submitted === true,
                    "override": item.planner_override && item.planner_override.marked_complete,
                    "type": item.plannable_type,
                    "due": due
                }
                if (assignmentEls[item.course_id]) {
                    assignmentEls[item.course_id].push(o);
                } else {
                    assignmentEls[item.course_id] = [o];
                }
            });
            resolve(assignmentEls);
        });
    });
}

function loadCardAssignments() {
    if (options?.assignments_due !== true || todoCourseCardsOwnAssignments()) {
        document.querySelectorAll(".canvasrefined-card-assignment").forEach(card => {
            if (card.style.display !== "none") card.style.display = "none";
        });
        return;
    }
    setupCardAssignments();
    const generation = cardAssignmentsGeneration;
    Promise.resolve(cardAssignments).then(els => {
        if (generation !== cardAssignmentsGeneration || options?.assignments_due !== true || todoCourseCardsOwnAssignments() || !els) return;
        try {
            let cards = document.querySelectorAll('.ic-DashboardCard');
            if (cards.length === 0) return;
            const now = new Date();

            cards.forEach(card => {
                let count = 0;
                let link = card.querySelector(".ic-DashboardCard__link");
                if (!link) return;
                const course = contentCardAppearanceApi?.canvasCourseLocation?.(link.href, domain);
                if (!course) return;
                const course_id = course.courseId;
                let cardContainer = card.querySelector('.canvasrefined-card-container');
                if (!cardContainer) return;
                if (cardContainer.parentElement) {
                    if (cardContainer.parentElement.style.display !== "block") cardContainer.parentElement.style.display = "block";
                }

                const desired = [];
                if (els[course_id]) {
                    els[course_id].forEach(assignment => {
                        if (count >= Number(options?.num_assignments ?? 4)) return;
                        if (options?.hide_completed_cards === true && assignment.submitted === true) return;
                        if ((options?.card_overdues !== true && now >= assignment.due) || (options?.card_overdues === true && assignment.submitted === true)) return;
                        if (assignment.type !== "assignment" && assignment.type !== "quiz" && assignment.type !== "discussion_topic") return;
                        if (assignment.override === true) return;
                        desired.push(assignment.item);
                        count++;
                    });
                }

                cardContainer.querySelector(".canvasrefined-skeleton-text")?.remove();
                const existing = new Map(Array.from(cardContainer.children)
                    .filter((node) => node.dataset?.apstudyAssignmentKey)
                    .map((node) => [node.dataset.apstudyAssignmentKey, node]));
                const wantedKeys = new Set(desired.map(cardAssignmentKey));
                existing.forEach((node, key) => {
                    if (!wantedKeys.has(key)) node.remove();
                });

                let cursor = cardContainer.firstElementChild;
                desired.forEach((item) => {
                    const key = cardAssignmentKey(item);
                    const row = existing.get(key) || createCardAssignment(item, course_id);
                    updateCardAssignment(row, item, course_id);
                    if (row !== cursor) cardContainer.insertBefore(row, cursor || null);
                    cursor = row.nextElementSibling;
                });

                let empty = cardContainer.querySelector("[data-apstudy-assignment-empty]");
                if (desired.length === 0) {
                    if (!empty) {
                        empty = document.createElement("div");
                        empty.className = "canvasrefined-assignment-container";
                        empty.dataset.apstudyAssignmentEmpty = "true";
                        makeElement("a", empty, { "className": "canvasrefined-assignment-link", "textContent": "None" });
                    }
                    if (empty.parentElement !== cardContainer) cardContainer.appendChild(empty);
                } else if (empty) {
                    empty.remove();
                }
            });
        } catch (e) {
            logError(e);
        }
    }).catch(() => {
        // A rejected planner read (offline, invalidated context) must not
        // surface as an unhandled rejection; the previous card state simply
        // stays until the next hydration re-runs the keyed reconciliation.
    });
}

function setupCardAssignments() {
    if (options?.assignments_due !== true || todoCourseCardsOwnAssignments()) return;
    try {
        let cards = document.querySelectorAll('.ic-DashboardCard');
        cards.forEach(card => {
            let assignmentContainer = card.querySelector(".canvasrefined-card-assignment") || makeElement("div", card, { "className": "canvasrefined-card-assignment" });
            let assignmentsDueHeader = card.querySelector(".canvasrefined-card-header-container") || makeElement("div", assignmentContainer, { "className": "canvasrefined-card-header-container" });
            let assignmentsDueLabel = card.querySelector(".canvasrefined-card-header") || makeElement("h3", assignmentsDueHeader, { "className": "canvasrefined-card-header", "textContent": chrome.i18n.getMessage("due") });
            let cardContainer = card.querySelector(".canvasrefined-card-container") || makeElement("div", assignmentContainer, { "className": "canvasrefined-card-container" });
            // The skeleton is a placeholder for the in-flight planner read only.
            // loadCardAssignments removes it once data lands; recreating it here
            // after that point would append-and-remove on every hydration cycle
            // and self-sustain the mutation-driven refresh pipeline.
            if (!card.querySelector(".canvasrefined-skeleton-text") && cardAssignments === null) {
                makeElement("div", cardContainer, { "className": "canvasrefined-skeleton-text" });
            }
        });
    } catch (e) {
        logError(e);
    }
}

/*
Card customization
*/

function getDashboardCardDestination(card) {
    return contentCardAppearanceApi?.dashboardCardDestination?.(card, domain) || null;
}

function getCardId(card) {
    let id = getDashboardCardDestination(card)?.courseId;
    if (!id) return null;
    // no ~
    if (!id.includes("~")) return id;

    // has ~ but dashboard card method is used
    if (options["custom_cards"][id]) return id;

    // weird case, some canvases replace consecutive 0s with a ~ in the id
    // but the number of 0s isn't consistent between schools
    id = id.split("~");
    let re = new RegExp(`${id[0]}0+${id[1]}`);
    for (const c of Object.keys(options["custom_cards"])) {
        if (c.match(re)) return c;
    }
    return -1;
}

let courseCardRestore = null;
const courseCardOriginals = new WeakMap();

function rememberCourseCardOriginal(card) {
    if (!card || courseCardOriginals.has(card)) return courseCardOriginals.get(card) || null;
    const title = card.querySelector(".ic-DashboardCard__header-title span");
    const subtitle = card.querySelector(".ic-DashboardCard__header-subtitle");
    const image = card.querySelector(".ic-DashboardCard__header_image");
    const hero = card.querySelector(".ic-DashboardCard__header_hero");
    const original = Object.freeze({
        display: card.style?.display || "",
        titleText: title?.textContent,
        subtitleText: subtitle?.textContent,
        imageBackground: image?.style?.backgroundImage,
        heroOpacity: hero?.style?.opacity
    });
    courseCardOriginals.set(card, original);
    return original;
}

function restoreCourseCardPresentation(card, original = rememberCourseCardOriginal(card)) {
    if (!card || !original) return;
    if (card.style) card.style.display = original.display;
    const title = card.querySelector(".ic-DashboardCard__header-title span");
    const subtitle = card.querySelector(".ic-DashboardCard__header-subtitle");
    const image = card.querySelector(".ic-DashboardCard__header_image");
    const hero = card.querySelector(".ic-DashboardCard__header_hero");
    if (title && original.titleText !== undefined && title.textContent !== original.titleText) title.textContent = original.titleText;
    if (subtitle && original.subtitleText !== undefined && subtitle.textContent !== original.subtitleText) subtitle.textContent = original.subtitleText;
    if (image?.style && original.imageBackground !== undefined) image.style.backgroundImage = original.imageBackground;
    if (hero?.style && original.heroOpacity !== undefined) hero.style.opacity = original.heroOpacity;
}

function applyCourseCardsLive() {
    const cards = Array.from(document.querySelectorAll(".ic-DashboardCard"));
    const stale = !courseCardRestore
        || courseCardRestore.length !== cards.length
        || courseCardRestore.some((entry, index) => entry.card !== cards[index]);
    if (stale) {
        courseCardRestore = cards.map((card) => {
            const original = rememberCourseCardOriginal(card);
            return {
                card,
                original
            };
        });
    } else {
        courseCardRestore.forEach((entry) => {
            restoreCourseCardPresentation(entry.card, entry.original);
        });
    }
    customizeCards();
}

function customizeCards(c = null) {
    if (!options.custom_cards) return;
    try {
        let cards = c ? c : document.querySelectorAll('.ic-DashboardCard');
        if (cards.length && cards.length > 0 && cards[0].querySelectorAll(".ic-DashboardCard__link").length === 0) return;

        cards.forEach(card => {
            const original = rememberCourseCardOriginal(card);
            const id = getCardId(card);
            if (!id) return;
            let cardOptions = options["custom_cards"][id] || null;
            let cardOptions_2 = options["custom_cards_2"][id] || null;
            if (!cardOptions) {
                restoreCourseCardPresentation(card, original);
                return;
            }
            // Every write below is hydration-safe: hydrate recomputes this per
            // refresh, so identical values must not touch the DOM.
            // hide card
            const nextDisplay = cardOptions.hidden === true ? "none" : "inline-block";
            if (card.style.display !== nextDisplay) card.style.display = nextDisplay;

            // card image
            if (cardOptions.img === "none") {
                let currentImg = card.querySelector(".ic-DashboardCard__header_image");
                if (currentImg) {
                    card.querySelector(".ic-DashboardCard__header_hero").style.opacity = original?.heroOpacity || "1";
                }
            } else if (cardOptions.img !== "") {
                let topColor = card.querySelector(".ic-DashboardCard__header_hero");
                let container = card.querySelector(".ic-DashboardCard__header_image") || makeElement("div", card, { "className": "ic-DashboardCard__header_image" });
                let header = card.querySelector(".ic-DashboardCard__header");
                if (header && (container.parentNode !== header || header.firstElementChild !== container)) header.prepend(container);
                if (topColor && topColor.parentNode !== container) container.appendChild(topColor);
                const nextBackground = "url(\"" + cardOptions.img + "\")";
                if (container.style.backgroundImage !== nextBackground) container.style.backgroundImage = nextBackground;
                if (topColor && topColor.style.opacity !== "0.5") topColor.style.opacity = .5;
            } else {
                const image = card.querySelector(".ic-DashboardCard__header_image");
                const hero = card.querySelector(".ic-DashboardCard__header_hero");
                if (image?.style && original?.imageBackground !== undefined) image.style.backgroundImage = original.imageBackground;
                if (hero?.style && original?.heroOpacity !== undefined) hero.style.opacity = original.heroOpacity;
            }

            // card name
            if (cardOptions.name !== "") {
                let titleNode = card.querySelector(".ic-DashboardCard__header-title > span");
                if (titleNode && titleNode.textContent !== cardOptions.name) titleNode.textContent = cardOptions.name;
            } else {
                const titleNode = card.querySelector(".ic-DashboardCard__header-title > span");
                if (titleNode && original?.titleText !== undefined && titleNode.textContent !== original.titleText) titleNode.textContent = original.titleText;
            }

            // card code
            if (cardOptions.code !== "") {
                let codeNode = card.querySelector(".ic-DashboardCard__header-subtitle");
                if (codeNode && codeNode.textContent !== cardOptions.code) codeNode.textContent = cardOptions.code;
            } else {
                const codeNode = card.querySelector(".ic-DashboardCard__header-subtitle");
                if (codeNode && original?.subtitleText !== undefined && codeNode.textContent !== original.subtitleText) codeNode.textContent = original.subtitleText;
            }

            // card links
            const cardLinks = Array.isArray(cardOptions_2?.links) ? cardOptions_2.links : [];
            let links = card.querySelectorAll(".ic-DashboardCard__action");
            for (let i = links.length; i < 4; i++) {
                makeElement("a", card.querySelector(".ic-DashboardCard__action-container"), { "className": "ic-DashboardCard__action" });
            }
            links = card.querySelectorAll(".ic-DashboardCard__action");
            for (let i = 0; i < 4; i++) {
                const linkOption = cardLinks[i] || { path: "none", is_default: true };
                let img = links[i].querySelector(".canvasrefined-link-image") || makeElement("img", links[i], { "className": "canvasrefined-link-image" });
                if (links[i].style.display !== "inherit") links[i].style.display = "inherit";
                if (linkOption.path === "none") {
                    if (links[i].style.display !== "none") links[i].style.display = "none";
                } else if (linkOption.is_default === false) {
                    const rawHref = linkOption.path;
                    let resolvedHref = rawHref;
                    try { resolvedHref = new URL(rawHref, window.location.href).href; } catch (e) {}
                    if (links[i].href !== resolvedHref) links[i].href = rawHref;
                    const nextSrc = getCustomLinkImage(linkOption.path);
                    if (img.getAttribute("src") !== nextSrc) img.src = nextSrc;
                    if (links[i].querySelector(".ic-DashboardCard__action-layout")) links[i].querySelector(".ic-DashboardCard__action-layout").style.display = "none";
                    if (img.style.display !== "block") img.style.display = "block";
                } else {
                    if (links[i].querySelector(".ic-DashboardCard__action-layout")) links[i].querySelector(".ic-DashboardCard__action-layout").style.display = "inherit";
                    if (img.style.display !== "none") img.style.display = "none";
                }
                if (img.dataset.apstudyErrorBound !== "true") {
                    img.dataset.apstudyErrorBound = "true";
                    img.addEventListener("error", () => {
                        img.src = "https://www.instructure.com/favicon.ico";
                    });
                }
            }

        });

    } catch (e) {
        logError(e);
    }
}

function getCustomLinkImage(path) {
    if (path.includes("webassign.net")) {
        return "https://www.cengage.com/favicon.ico";
    } else if (path.includes("docs.google")) {
        return "https://ssl.gstatic.com/docs/documents/images/kix-favicon7.ico";
    } else {
        let url = { "hostname": "instructure.com/" };
        try {
            url = new URL(path);
        } catch (e) {
            logError(e);
        }
        return "https://" + url.hostname + "/favicon.ico";;
    }
}

/*
GPA calculator
*/

const contentGpaApi = globalThis.APStudyCanvasContent?.Gpa;

function readGPACourseRow(course) {
    return {
        weight: course?.querySelector?.(".canvasrefined-course-weight")?.value,
        credits: course?.querySelector?.(".canvasrefined-course-credit")?.value,
        grade: course?.querySelector?.(".canvasrefined-course-percent")?.value
    };
}

function ensureGPAStatusRegion(card) {
    if (!card?.querySelector) return null;
    const existing = card.querySelector(".canvasrefined-gpa-status");
    if (existing) return existing;
    const status = document.createElement("div");
    status.className = "canvasrefined-gpa-status";
    // Persistent live region: it stays in the accessibility tree so inserting
    // or removing the explanatory line inside it is what gets announced.
    status.setAttribute?.("aria-live", "polite");
    const editButton = card.querySelector(".canvasrefined-gpa-edit-btn");
    if (editButton && card.insertBefore) card.insertBefore(status, editButton);
    else card.appendChild?.(status);
    return status;
}

function renderGPAEmptyState(card, empty) {
    const status = ensureGPAStatusRegion(card);
    if (!status) return;
    const next = empty ? "empty" : "ready";
    // Only mutate on a real state change, so recomputing after every keystroke
    // does not re-announce the same sentence.
    if (status.dataset?.canvasrefinedGpaState === next) return;
    if (status.dataset) status.dataset.canvasrefinedGpaState = next;
    const previous = status.querySelector?.(".canvasrefined-gpa-note");
    if (previous?.remove) previous.remove();
    if (!empty) return;
    const note = document.createElement("p");
    note.className = "canvasrefined-gpa-note";
    note.textContent = contentGpaApi.EMPTY_MESSAGE;
    if (note.style) {
        note.style.marginTop = "10px";
        note.style.fontSize = "12px";
        note.style.lineHeight = "1.45";
    }
    status.appendChild?.(note);
}

function calculateGPA2() {
    if (!contentGpaApi) return;
    const courseNodes = Array.from(document.querySelectorAll(".canvasrefined-gpa-course") || []);
    const priorNode = document.querySelector("#canvasrefined-cumulative-gpa");
    const result = contentGpaApi.computeGpa({
        courses: courseNodes.map(readGPACourseRow),
        bounds: options.gpa_calc_bounds,
        weighted: options.gpa_calc_weighted === true,
        cumulative: priorNode ? {
            grade: priorNode.querySelector(".canvasrefined-course-percent")?.value,
            credits: priorNode.querySelector(".canvasrefined-course-credit")?.value
        } : null
    });

    courseNodes.forEach((course, index) => {
        const letter = course.querySelector(".canvasrefined-gpa-letter-grade");
        const nextLetter = result.courses[index]?.letter ?? contentGpaApi.NO_LETTER;
        // Conditional write: calculateGPA2 runs on every dashboard hydration,
        // and rewriting identical text re-triggers the mutation observer.
        if (letter && letter.textContent !== nextLetter) letter.textContent = nextLetter;
    });

    const unweighted = document.querySelector("#canvasrefined-gpa-unweighted");
    const weighted = document.querySelector("#canvasrefined-gpa-weighted");
    const cumulative = document.querySelector("#canvasrefined-gpa-cumulative");
    const unweightedText = contentGpaApi.formatGpa(result.unweighted);
    const weightedText = contentGpaApi.formatGpa(result.weighted);
    const cumulativeText = contentGpaApi.formatGpa(result.cumulative);
    if (unweighted && unweighted.textContent !== unweightedText) unweighted.textContent = unweightedText;
    if (weighted && weighted.textContent !== weightedText) weighted.textContent = weightedText;
    if (cumulative && cumulative.textContent !== cumulativeText) cumulative.textContent = cumulativeText;

    // An unconfigured calculator has nothing to average. Show the em-dash plus
    // one factual line instead of dividing zero credits into zero points.
    renderGPAEmptyState(document.querySelector(".canvasrefined-gpa-card"), result.unweighted === null);
}

function changeGPASettings(course_id, update) {
    calculateGPA2();
    chrome.storage.sync.get(["custom_cards", "cumulative_gpa"], storage => {
        if (course_id === "cumulative") {
            chrome.storage.sync.set({ "cumulative_gpa": { ...storage["cumulative_gpa"], ...update } });
        } else {
            chrome.storage.sync.set({ "custom_cards": { ...storage["custom_cards"], [course_id]: { ...storage["custom_cards"][course_id], ...update } } }).catch((error) => logError(error));
        }
    });
}

function createGPACalcCourse(location, course) {

    let customs;
    if (course.access_restricted_by_date === true) {
        return null;
    } if (course.id === "cumulative") {
        customs = options["cumulative_gpa"];
    } else if (options.custom_cards && options.custom_cards[course.id]) {
        customs = options.custom_cards[course.id];
    } else {
        return;
        customs = { "name": course.name, "hidden": false, "weight": "regular", "credits": 1, "gr": null };
    }
    if (customs.hidden === true) return;

    let courseContainer = makeElement("div", location, { "className": course.id === "cumulative" ? "canvasrefined-gpa-cumulative" : "canvasrefined-gpa-course", "innerHTML": '<div class="canvasrefined-gpa-letter-grade"></div>' });
    let courseName = makeElement("p", courseContainer, { "className": "canvasrefined-gpa-name", "textContent": customs.name === "" ? course.course_code : customs.name });
    let changerContainer = makeElement("div", courseContainer, { "className": "canvasrefined-gpa-percent-container" });

    let credits = makeElement("div", courseContainer, { "className": "canvasrefined-course-credits", "innerHTML": '<input class="canvasrefined-course-credit" value="1"></input><span class="canvasrefined-course-percent-sign">cr</span>' });
    let creditsChanger = credits.querySelector(".canvasrefined-course-credit");
    creditsChanger.value = customs.credits;
    let changer = makeElement("input", changerContainer, { "className": "canvasrefined-course-percent" });
    let percent = makeElement("span", changerContainer, { "className": "canvasrefined-course-percent-sign", "textContent": course.id === "cumulative" ? "/4" : "%" });
    let courseGrade = course?.enrollments[0].has_grading_periods === true ? course.enrollments[0].current_period_computed_current_score : course.enrollments[0].computed_current_score;

    if (customs["gr"] !== null) {
        changer.value = customs["gr"];
    } else if (courseGrade) {
        changer.value = courseGrade;
    } else {
        changer.value = "--";
    }

    if (course.id !== "cumulative") {
        let weightSelections = makeElement("form", courseContainer, { "className": "canvasrefined-course-weights" });
        weightSelections.innerHTML = '<select name="weight-selection" class="canvasrefined-course-weight"><option value="dnc">Do not count</option><option value="regular">Regular/College</option><option value="honors">Honors</option><option value="ap">AP/IB</option></select>';
        let weightChanger = weightSelections.querySelector(".canvasrefined-course-weight");
        weightChanger.value = changer.value === "--" ? "dnc" : customs.weight;   
        weightChanger.addEventListener('change', () => changeGPASettings(course.id, { "weight": weightSelections.querySelector(".canvasrefined-course-weight").value }));

        let useCustomGr = makeElement("input", courseContainer, { "className": "canvasrefined-course-customgr", "type": "checkbox", "checked": customs.gr !== null ? true : false });
        let useCustomGrLabel = makeElement("span", courseContainer, { "className": "canvasrefined-course-customgr-label", "textContent": "Save custom grade" });
        useCustomGr.addEventListener("input", () => {
            if (options["custom_cards"][course.id]) {
                if (options["custom_cards"][course.id]["gr"] !== undefined && options["custom_cards"][course.id]["gr"] !== null) {
                    changer.value = courseGrade;
                    changeGPASettings(course.id, { "gr": null });
                } else {
                    changeGPASettings(course.id, { "gr": changer.value });
                }
            }
        });
    }   

    changer.addEventListener('input', (e) => {
        if (course.id === "cumulative" || (options["custom_cards"][course.id]["gr"] !== undefined && options["custom_cards"][course.id]["gr"] !== null)) {
            changeGPASettings(course.id, { "gr": e.target.value });
        } else {
            calculateGPA2();
        }
    });

    credits.querySelector(".canvasrefined-course-credit").addEventListener('input', () => changeGPASettings(course.id, { "credits": credits.querySelector(".canvasrefined-course-credit").value }));
    return courseContainer;
}

function setupGPACalc() {
    if (current_page !== "/" && current_page !== "") return;
    if (options.gpa_calc !== true) {
        document.querySelectorAll(".canvasrefined-gpa-card, .canvasrefined-gpa").forEach((container) => {
            if (container.style.display !== "none") container.style.display = "none";
        });
        return;
    }
    try {
        grades?.then(result => {
            // The calculator can be disabled while the lazy grade request is
            // in flight. Its old callback must not restore or reorder UI.
            if (options.gpa_calc !== true) return;

            const dashboardContainer = document.querySelector(".ic-DashboardCard__box__container");
            if (!dashboardContainer) return;

            let container2 = document.querySelector(".canvasrefined-gpa-card");
            let container = document.querySelector(".canvasrefined-gpa");
            const alreadyRendered = container2?.dataset?.canvasrefinedGpaRendered === "true" && container?.dataset?.canvasrefinedGpaRendered === "true";

            if (!container2) {
                container2 = document.createElement("div");
                container2.className = "canvasrefined-gpa-card";
            }
            if (!container) {
                container = document.createElement("div");
                container.className = "canvasrefined-gpa";
            }

            container2.style.display = options.gpa_calc === true ? "inline-block" : "none";

            if (!alreadyRendered) {
                container2.innerHTML = `<h3 class="canvasrefined-gpa-header">GPA</h3><div><div><p id="canvasrefined-gpa-unweighted"></p><p>Current</p></div><div style="display:${options["gpa_calc_weighted"] ? "block" : "none"}"><p id="canvasrefined-gpa-weighted"></p><p>Weighted</p></div><div style="display:${options["gpa_calc_cumulative"] ? "block" : "none"}"><p id="canvasrefined-gpa-cumulative"></p><p>Cumulative</p></div></div>`;
                let editBtn = makeElement("button", container2, { "className": "canvasrefined-gpa-edit-btn", "textContent": "Edit Calculator" });

                container.innerHTML = '<h3 class="canvasrefined-gpa-header">GPA Calculator</h3><div class="canvasrefined-gpa-courses-container"><div class="canvasrefined-gpa-courses"></div></div>';

                if (options.gpa_calc_prepend === true) {
                    dashboardContainer.prepend(container2);
                    dashboardContainer.prepend(container);
                } else {
                    dashboardContainer.appendChild(container2);
                    dashboardContainer.appendChild(container);
                }

                let location = document.querySelector(".canvasrefined-gpa-courses");
                if (!location) return;

                let cumulative = createGPACalcCourse(location, { "id": "cumulative", "enrollments": [{ "has_grading_periods": true, "current_period_computed_current_score": 0 }] });
                cumulative.id = "canvasrefined-cumulative-gpa";
                result.forEach(course => createGPACalcCourse(location, course));

                container.style.display = "none";

                editBtn.addEventListener("click", () => {
                    if (container.style.display === "none") {
                        container.style.display = "inline-block";
                        editBtn.textContent = "Close Calculator";
                    } else {
                        container.style.display = "none";
                        editBtn.textContent = "Edit Calculator";
                    }
                });

                container2.dataset.canvasrefinedGpaRendered = "true";
                container.dataset.canvasrefinedGpaRendered = "true";
            } else {
                const weighted = container2.querySelector("#canvasrefined-gpa-weighted")?.parentElement;
                const cumulative = container2.querySelector("#canvasrefined-gpa-cumulative")?.parentElement;
                if (weighted) weighted.style.display = options.gpa_calc_weighted ? "block" : "none";
                if (cumulative) cumulative.style.display = options.gpa_calc_cumulative ? "block" : "none";

                const shouldPrepend = options.gpa_calc_prepend === true;
                const firstCard = shouldPrepend ? container : container2;
                const secondCard = shouldPrepend ? container2 : container;

                // Re-insert both owned siblings even when they already share
                // the dashboard parent: Canvas can place unrelated cards
                // between them, and a prior setting change can invert them.
                if (shouldPrepend) {
                    dashboardContainer.prepend(container2);
                    dashboardContainer.prepend(container);
                } else {
                    dashboardContainer.appendChild(container2);
                    dashboardContainer.appendChild(container);
                }
            }

            calculateGPA2();
        });
    } catch (e) {
        logError(e);
    }
}

/*
Dashboard notes
*/

let dashboardNotesController = null;

function teardownDashboardNotes() {
    dashboardNotesController?.destroy();
    dashboardNotesController = null;
}

function loadDashboardNotes() {
    if (options.dashboard_notes === true) {
        const api = globalThis.APStudyCanvasContent?.DashboardNotes;
        if (!api) return;
        if (!dashboardNotesController) dashboardNotesController = api.createDashboardNotes();
        dashboardNotesController.reconcile?.({
            enabled: true,
            source: options.dashboard_notes_text,
            getContainer: () => document.querySelector("#DashboardCard_Container")
        });
    } else {
        dashboardNotesController?.destroy();
        dashboardNotesController = null;
    }
}

/*
Custom font
*/

function loadCustomFont() {
    let style = document.querySelector("#custom_font");
    // `font-faces.js` declares the package URLs. This override only selects
    // one of their fixed CSS stacks and never creates a remote stylesheet.
    document.querySelector("#custom_font_link")?.remove();
    const family = contentTodoSchemaApi?.customFontCssFamily?.(options.custom_font) || "";

    if (!family) {
        if (style) {
            style.textContent = "";
            style.remove();
        }
        return;
    }

    const load = () => {
        if (!style) {
            style = document.createElement("style");
            style.id = "custom_font";
        }
        style.textContent = `*, input, a, button, h1, h2, h3, h4, h5, h6, p, span {font-family: ${family}!important}`;
        const parent = document.head || document.documentElement;
        if (parent && !style.parentNode) parent.appendChild(style);
    };

    if (document.readyState !== "loading") {
        load();
    } else {
        document.addEventListener("DOMContentLoaded", load, { once: true });
    }
}

/*
Smaller features
*/

function applyDashboardCompactPadding() {
    // Canvas re-renders its dashboard subtree freely, so the opt-in state lives
    // on the root element, which Canvas never replaces; css/content.css keys
    // the minimal/medium/high padding rules on this namespaced attribute and
    // every rule is inert while it is absent. Writes are conditional so
    // repeated applies never hand the lifecycle's observer its own output.
    const root = document.documentElement;
    if (!root) return;
    const attribute = "data-apstudycanvas-dashboard-compact-padding";
    // Shared normalizer (js/settings-schema.js): legacy booleans map to the
    // shipped "medium" default, strings must be a known level, and anything
    // else comes back null and clears the attribute.
    const normalized = globalThis.APStudyCanvasSchema?.normalizeDashboardCompactPadding?.(options.dashboard_compact_padding);
    const level = typeof normalized === "string" && normalized !== "off" ? normalized : "";
    const current = root.getAttribute?.(attribute) || "";
    if (level) {
        if (current !== level) root.setAttribute?.(attribute, level);
    } else if (root.hasAttribute?.(attribute)) {
        root.removeAttribute?.(attribute);
    }
}

// Canvas owns #dashboard_header_container and React can re-render or replace
// it, so the row is hidden two ways at once: a dedicated stylesheet keeps
// matching every element Canvas recreates under that id, and an inline
// display assertion pins the live node. Both writes are idempotent and only
// ever reversed by this same applier, matching the aesthetics operation's
// live-apply contract.
function applyDashboardHeaderHide() {
    const enabled = options.hide_dashboard_header === true;
    const style = document.getElementById("apstudycanvas-dashboard-header-hide") || document.createElement("style");
    style.id = "apstudycanvas-dashboard-header-hide";
    const text = enabled ? "#dashboard_header_container{display:none!important}" : "";
    if (style.textContent !== text) style.textContent = text;
    if (text && !style.isConnected) document.documentElement.appendChild(style);
    if (!text && style.isConnected) style.remove();
    const container = document.getElementById("dashboard_header_container");
    if (!container) return;
    if (enabled) {
        if (container.style.display !== "none" || container.style.getPropertyPriority("display") !== "important") {
            container.style.setProperty("display", "none", "important");
        }
    } else if (container.style.display === "none" && container.style.getPropertyPriority("display") === "important") {
        container.style.removeProperty("display");
    }
}

// Keep Canvas's infrastructure footer in the DOM: it is restored immediately
// when the setting is turned back off, and this selector continues to apply if
// Canvas recreates the footer during client-side navigation.
function applyInfrastructureFooterHide() {
    const enabled = options.hide_infrastructure_footer === true;
    const style = document.getElementById("apstudycanvas-infrastructure-footer-hide") || document.createElement("style");
    style.id = "apstudycanvas-infrastructure-footer-hide";
    const text = enabled ? "footer#footer.ic-app-footer[role='contentinfo']{display:none!important}" : "";
    if (style.textContent !== text) style.textContent = text;
    if (text && !style.isConnected) document.documentElement.appendChild(style);
    if (!text && style.isConnected) style.remove();
}

function applyAestheticChanges() {
    applyDashboardCompactPadding();
    applyDashboardHeaderHide();
    applyInfrastructureFooterHide();
    let style = document.querySelector("#canvasrefined-aesthetics") || document.createElement('style');
    style.id = "canvasrefined-aesthetics";
    style.textContent = "";
    if (options.condensed_cards === true) style.textContent += ".ic-DashboardCard__header_hero {height:60px!important}.ic-DashboardCard__header-subtitle, .ic-DashboardCard__header-term{display:none}";
    if (options.remlogo === true) style.textContent += ".ic-app-header__logomark-container{display:none}";
    if (options.disable_color_overlay === true) style.textContent += ".ic-DashboardCard__header_hero{opacity: 0!important} .ic-DashboardCard__header-button-bg{opacity: 1!important}";
    if (options.hide_feedback === true) style.textContent += ".recent_feedback {display: none}";
    if (options.full_width === true) style.textContent += "#wrapper,.ic-Layout-wrapper{max-width:100%!important}";

    if (options.customCardStyles === true) {
        if (options.imageSize !== undefined && options.imageSize !== 100) style.textContent += `.ic-DashboardCard__header_image {transform: scale(${options.imageSize / 100})!important; }`;
        if (options.cardRoundness !== undefined && options.cardRoundness !== 5) style.textContent += `.ic-DashboardCard {border-radius: ${options.cardRoundness}px!important;}`;
        if (options.cardImageRoundness > 0) style.textContent += `.ic-DashboardCard__header_image{border-radius:${options.cardImageRoundness}px!important;overflow:hidden!important;}`;
        if (options.cardPadding > 0) style.textContent += `.ic-DashboardCard__header_content{padding:${options.cardPadding}px!important;}`;
        if (options.cardSpacing !== undefined && options.cardSpacing !== 0) style.textContent += `.ic-DashboardCard {margin-right: ${options.cardSpacing / 2}px!important; margin-bottom: ${options.cardSpacing / 2}px!important;}`;
        if (options.cardWidth !== undefined && options.cardWidth !== 262) style.textContent += `.ic-DashboardCard {width: ${options.cardWidth}px!important;}`;
        // Assignment rows are real card content. A fixed height clips them at
        // the small end of the range, so the preference establishes a visual
        // minimum while content is always allowed to grow.
        if (options.cardHeight !== undefined && options.cardHeight !== 250) style.textContent += `.ic-DashboardCard {min-height: ${options.cardHeight}px!important;height:auto!important;}`;
    }

    if (options.custom_styles !== "") style.textContent += options.custom_styles;
    if (!style.textContent) {
        if (style.parentNode) style.remove();
        return;
    }
    document.documentElement.appendChild(style);
}

function changeGradientCards() {
    // Hydration runs on every debounced lifecycle refresh, so every write here
    // must be conditional: rewriting identical rules (or re-appending an
    // already-connected style node) would hand the mutation observer its own
    // output back and self-sustain the refresh pipeline.
    const cardcss = document.querySelector("#gradientcss") || document.createElement('style');
    cardcss.id = "gradientcss";
    if (options.gradient_cards === true) {
        let css = "";
        const cardheads = document.querySelectorAll('.ic-DashboardCard__header_hero');
        for (let i = 0; i < cardheads.length; i++) {
            let colorone = cardheads[i].style.backgroundColor.split(',');
            let [r, g, b] = [parseInt(colorone[0].split('(')[1]), parseInt(colorone[1]), parseInt(colorone[2])];
            let [h, s, l] = [rgbToHsl(r, g, b)[0], rgbToHsl(r, g, b)[1], rgbToHsl(r, g, b)[2]];
            let degree = ((h % 60) / 60) >= .66 ? 30 : ((h % 60) / 60) <= .33 ? -30 : 15;
            let newh = h > 300 ? (360 - (h + 65)) + (65 + degree) : h + 65 + degree;
            css += ".ic-DashboardCard:nth-of-type(" + (i + 1) + ") .ic-DashboardCard__header_hero{background: linear-gradient(115deg, hsl(" + h + "deg," + s + "%," + l + "%) 5%, hsl(" + newh + "deg," + s + "%," + l + "%) 100%)!important}";
        }
        if (!cardcss.isConnected) document.documentElement.appendChild(cardcss);
        if (cardcss.textContent !== css) cardcss.textContent = css;
    } else if (cardcss.isConnected && cardcss.textContent !== "") {
        cardcss.textContent = "";
    }
}

function showUpdateMsg() {
    // dont run if not on dashboard
    const el = document.getElementById("announcementWrapper");
    if (!el) return;

    // option off or div already created
    let div = document.getElementById("canvasrefined-update-msg");
    if (options.show_updates !== true || options.update_msg === "") {
        if (div) div.style.display = "none";
        return;
    } else if (div) {
        div.style.display = "flex";
        return;
    }

    // first creation
    div = makeElement("div", el, { "id": "canvasrefined-update-msg" });
    makeElement("p", div, { "textContent": options.update_msg });
    const close = makeElement("button", div, { "id": "canvasrefined-update-close", "textContent": "Close" });
    close.addEventListener("click", () => {
        readUpdate();
        div.remove();
    });
}

function readUpdate() {
    chrome.storage.sync.set({ "update_msg": "" });
}

/*
Other functions 
*/

function combineAssignments(data) {
    let combined = data;
    try {
        options.custom_assignments_overflow.forEach(overflow => {
            combined = combined.concat(options[overflow]);
        });
    } catch (e) {
        logError(e);
    }
    return combined.sort((a, b) => new Date(a.plannable_date).getTime() - new Date(b.plannable_date).getTime());
}

function cleanCustomAssignments() {
    chrome.storage.sync.get("custom_assignments_overflow", overflows => {
        chrome.storage.sync.get(overflows["custom_assignments_overflow"], storage => {
            const now = new Date();

            overflows["custom_assignments_overflow"].forEach(overflow => {
                let changed = false;
                for (let i = 0; i < storage[overflow].length; i++) {
                    let assignmentDate = new Date(storage[overflow][i].plannable_date);
                    if (!assignmentDate.getTime() || assignmentDate < now) {
                        storage[overflow].splice(i, 1);
                        changed = true;
                    }
                }
                if (changed) chrome.storage.sync.set({ [overflow]: storage[overflow] }).catch((error) => logError(error));
            });

        });
    });
}

function getGrades() {
    if (options.gpa_calc === true || options.dashboard_grades === true) {
        grades = getData(`${domain}/api/v1/courses?${/*enrollment_state=active&*/""}include[]=concluded&include[]=total_scores&include[]=computed_current_score&include[]=current_grading_period_scores&per_page=100`);
    }
}

function getColors() {
    if (options.tab_icons || options.todo_enabled || options.better_sidebar) {
        return getData(`${domain}/api/v1/users/self/colors`).then(data => {
            let cards = options.custom_cards_3;
            Object.keys(cards).forEach(key => {
                cards[key] = { ...cards[key], "color": data["custom_colors"]["course_" + key] ? data["custom_colors"]["course_" + key] : null };
            });
            chrome.storage.sync.set({ "custom_cards_3": cards }).catch((error) => logError(error));
            return cards;
        });
    }
}

let originalFaviconHref = null;
function changeFavicon() {
    const icon = document.querySelector('link[rel="icon"]');
    if (icon && originalFaviconHref === null) originalFaviconHref = icon.href || icon.getAttribute("href");
    if (options.tab_icons !== true) {
        if (icon && originalFaviconHref) icon.href = originalFaviconHref;
        return;
    }
    let match = current_page.match(/courses\/(?<id>\d*)/);
    if (match && match.groups.id && options.custom_cards_3[match.groups.id]?.color) {
        document.querySelector('link[rel="icon"').href = `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" fill="white" width="128px" height="128px" viewBox="-192 -192 2304.00 2304.00" stroke="white"><g stroke-width="0"><rect x="-192" y="-192" width="2304.00" height="2304.00" rx="0" fill="${options.custom_cards_3[match.groups.id].color.replace("#", "%23")}" strokewidth="0"/></g><g stroke-linecap="round" stroke-linejoin="round"/><g> <path d="M958.568 277.97C1100.42 277.97 1216.48 171.94 1233.67 34.3881 1146.27 12.8955 1054.57 0 958.568 0 864.001 0 770.867 12.8955 683.464 34.3881 700.658 171.94 816.718 277.97 958.568 277.97ZM35.8207 682.031C173.373 699.225 279.403 815.285 279.403 957.136 279.403 1098.99 173.373 1215.05 35.8207 1232.24 12.8953 1144.84 1.43262 1051.7 1.43262 957.136 1.43262 862.569 12.8953 769.434 35.8207 682.031ZM528.713 957.142C528.713 1005.41 489.581 1044.55 441.31 1044.55 393.038 1044.55 353.907 1005.41 353.907 957.142 353.907 908.871 393.038 869.74 441.31 869.74 489.581 869.74 528.713 908.871 528.713 957.142ZM1642.03 957.136C1642.03 1098.99 1748.06 1215.05 1885.61 1232.24 1908.54 1144.84 1920 1051.7 1920 957.136 1920 862.569 1908.54 769.434 1885.61 682.031 1748.06 699.225 1642.03 815.285 1642.03 957.136ZM1567.51 957.142C1567.51 1005.41 1528.38 1044.55 1480.11 1044.55 1431.84 1044.55 1392.71 1005.41 1392.71 957.142 1392.71 908.871 1431.84 869.74 1480.11 869.74 1528.38 869.74 1567.51 908.871 1567.51 957.142ZM958.568 1640.6C816.718 1640.6 700.658 1746.63 683.464 1884.18 770.867 1907.11 864.001 1918.57 958.568 1918.57 1053.14 1918.57 1146.27 1907.11 1233.67 1884.18 1216.48 1746.63 1100.42 1640.6 958.568 1640.6ZM1045.98 1480.11C1045.98 1528.38 1006.85 1567.51 958.575 1567.51 910.304 1567.51 871.172 1528.38 871.172 1480.11 871.172 1431.84 910.304 1392.71 958.575 1392.71 1006.85 1392.71 1045.98 1431.84 1045.98 1480.11ZM1045.98 439.877C1045.98 488.148 1006.85 527.28 958.575 527.28 910.304 527.28 871.172 488.148 871.172 439.877 871.172 391.606 910.304 352.474 958.575 352.474 1006.85 352.474 1045.98 391.606 1045.98 439.877ZM1441.44 1439.99C1341.15 1540.29 1333.98 1697.91 1418.52 1806.8 1579 1712.23 1713.68 1577.55 1806.82 1418.5 1699.35 1332.53 1541.74 1339.7 1441.44 1439.99ZM1414.21 1325.37C1414.21 1373.64 1375.08 1412.77 1326.8 1412.77 1278.53 1412.77 1239.4 1373.64 1239.4 1325.37 1239.4 1277.1 1278.53 1237.97 1326.8 1237.97 1375.08 1237.97 1414.21 1277.1 1414.21 1325.37ZM478.577 477.145C578.875 376.846 586.039 219.234 501.502 110.339 341.024 204.906 206.338 339.592 113.203 498.637 220.666 584.607 378.278 576.01 478.577 477.145ZM679.155 590.32C679.155 638.591 640.024 677.723 591.752 677.723 543.481 677.723 504.349 638.591 504.349 590.32 504.349 542.048 543.481 502.917 591.752 502.917 640.024 502.917 679.155 542.048 679.155 590.32ZM1440 475.712C1540.3 576.01 1697.91 583.174 1806.8 498.637 1712.24 338.159 1577.55 203.473 1418.51 110.339 1332.54 217.801 1341.13 375.413 1440 475.712ZM1414.21 590.32C1414.21 638.591 1375.08 677.723 1326.8 677.723 1278.53 677.723 1239.4 638.591 1239.4 590.32 1239.4 542.048 1278.53 502.917 1326.8 502.917 1375.08 502.917 1414.21 542.048 1414.21 590.32ZM477.145 1438.58C376.846 1338.28 219.234 1331.12 110.339 1415.65 204.906 1576.13 339.593 1710.82 498.637 1805.39 584.607 1696.49 577.443 1538.88 477.145 1438.58ZM679.155 1325.37C679.155 1373.64 640.024 1412.77 591.752 1412.77 543.481 1412.77 504.349 1373.64 504.349 1325.37 504.349 1277.1 543.481 1237.97 591.752 1237.97 640.024 1237.97 679.155 1277.1 679.155 1325.37Z"/></g></svg>`;
    }
}


function getAssignments() {
    cardAssignmentsGeneration += 1;
    if (options?.assignments_due === true && !todoCourseCardsOwnAssignments()) {
        let weekAgo = new Date(new Date() - 604800000);
        //let weekAgo = new Date(new Date() - (604800000 * 10));
        assignments = getData(`${domain}/api/v1/planner/items?start_date=${weekAgo.toISOString()}&per_page=75`);
        cardAssignments = preloadAssignmentEls();
    } else {
        assignments = Promise.resolve([]);
        cardAssignments = Promise.resolve({});
    }
}

function getApiData() {
    if (current_page === "/" || current_page === "" || options.assignments_due || options.better_sidebar) {
        getAssignments();
        getGrades();
        getColors();
    }
}


function makeElement(element, location, options, prepend = false) {
    let creation = document.createElement(element);
    Object.keys(options).forEach(key => {
        creation[key] = options[key];
    });
    if (prepend) {
        location.insertBefore(creation, location.firstChild);
    } else {
        location.appendChild(creation);
    }
    return creation
}


function makeElement2(element, elclass, location, text) {
    let creation = document.createElement(element);
    creation.classList.add(elclass);
    creation.textContent = text;
    location.appendChild(creation);
    return creation
}

async function getData(url) {
    let response = await fetch(url, {
        method: 'GET',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        }
    });
    let data = await response.json();
    return data
}

function hexToHsl(hex) {
    var result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return rgbToHsl(parseInt(result[1], 16), parseInt(result[2], 16), parseInt(result[3], 16));
}

function rgbToHex(rgb) {
    try {
        let pat = /^rgb\(\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*\)$/;
        let exec = pat.exec(rgb);
        return "#" + parseInt(exec[1]).toString(16).padStart(2, "0") + parseInt(exec[2]).toString(16).padStart(2, "0") + parseInt(exec[3]).toString(16).padStart(2, "0");
    } catch (e) {
        logError(e);
    }
}

function rgbToHsl(r, g, b) {
    r /= 255, g /= 255, b /= 255;
    var max = Math.max(r, g, b),
        min = Math.min(r, g, b);
    var h, s, l = (max + min) / 2;
    if (max == min) {
        h = s = 0;
    } else {
        var d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch (max) {
            case r:
                h = (g - b) / d + (g < b ? 6 : 0); break;
            case g:
                h = (b - r) / d + 2; break;
            case b:
                h = (r - g) / d + 4; break;
        }
        h /= 6;
    }
    return [h * 360, s * 100, l * 100];
}

function getRelativeDate(date, short = false) {
    let now = new Date();
    let timeSince = (now.getTime() - date.getTime()) / 60000;
    let time = "min";
    timeSince = Math.abs(timeSince);
    if (timeSince >= 60) {
        timeSince /= 60;
        time = short ? "h" : "hour";
        if (timeSince >= 24) {
            timeSince /= 24;
            time = short ? "d" : "day";
            if (timeSince >= 7) {
                timeSince /= 7;
                time = short ? "w" : "week";
            }
        }
    }
    timeSince = Math.round(timeSince);
    let relative = timeSince + (short ? "" : " ") + time + (timeSince > 1 && !short ? "s" : "");
    return { time: relative, ms: now.getTime() - date.getTime() };
}

const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function formatTodoDate(date, submissions, hr24) {
    let { time, ms } = getRelativeDate(date);
    let fromNow = ms < 0 ? "in " + time : time + " ago";
    let dueSoon = false;
    if (submissions && submissions.submitted === false && ms >= -21600000) {
        dueSoon = true;
    }
    return { "dueSoon": dueSoon, "date": months[date.getMonth()] + " " + date.getDate() + " at " + (date.getHours() - (hr24 ? "" : date.getHours() > 12 ? 12 : 0)) + ":" + (date.getMinutes() < 10 ? "0" : "") + date.getMinutes() + (hr24 ? "" : date.getHours() >= 12 ? "pm" : "am") + " (" + fromNow + ")" };
}

function formatCardDue(date) {
    let due = new Date(date);
    if (options.relative_dues === true) {
        let relative = getRelativeDate(due, true);
        return relative.ms > 0 ? relative.time + " ago" : "in " + relative.time;
    }
    return options.assignment_date_format ? (due.getDate()) + "/" + (due.getMonth() + 1) : (due.getMonth() + 1) + "/" + (due.getDate());
}

const CONTENT_DIAGNOSTIC = Object.freeze({ code: "CONTENT_RUNTIME_FAILED", category: "runtime" });
function logError() {
    // A fixed singleton is intentionally bounded and contains no exception,
    // URL, account identifier, or caller-controlled text. Overwriting avoids
    // reading legacy raw stacks during both normal writes and cleanup races.
    const record = [{ ...CONTENT_DIAGNOSTIC }];
    try {
        const saved = chrome.storage.local?.set?.({ errors: record });
        if (saved && typeof saved.catch === "function") saved.catch(() => {});
    } catch (error) {}
    try { console.warn("[APStudyCanvas] content diagnostic: CONTENT_RUNTIME_FAILED"); } catch (error) {}
}

const CSRFtoken = function () {
    return decodeURIComponent((document.cookie.match('(^|;) *_csrf_token=([^;]*)') || '')[2])
}
