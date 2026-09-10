(function (root, factory) {
    "use strict";
    const model = root?.APStudyCanvasSidebarModel || (typeof require === "function" ? require("./sidebar-model.js") : null);
    const adapterApi = root?.APStudyCanvasContent?.SidebarAdapter || (typeof require === "function" ? require("./sidebar-adapter.js") : null);
    const courseCacheApi = root?.APStudyCanvasContent?.SidebarCourseCache || (typeof require === "function" ? require("./sidebar-course-cache.js") : null);
    const displayedCardCacheApi = root?.APStudyCanvasContent?.SidebarDisplayedCards || (typeof require === "function" ? require("./sidebar-displayed-cards.js") : null);
    const schema = root?.APStudyCanvasSchema || (typeof require === "function" ? require("../settings-schema.js") : null);
    const api = factory(model, adapterApi, courseCacheApi, schema, displayedCardCacheApi);
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasContent = Object.assign(root.APStudyCanvasContent || {}, { Sidebar: api });
}(typeof globalThis !== "undefined" ? globalThis : this, function (model, adapterApi, courseCacheApi, schema, displayedCardCacheApi) {
    "use strict";

    const NAMESPACE = "apstudycanvas-sidebar";
    const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
    const ROOT_ID = "apstudycanvas-sidebar-root";
    const RECOVERY_ID = "apstudycanvas-sidebar-recovery";
    const MARKER = "data-apstudycanvas-sidebar-mounted";
    const HEARTBEAT_ATTRIBUTE = "data-apstudycanvas-sidebar-heartbeat";
    const SESSION_ATTRIBUTE = "data-apstudycanvas-sidebar-session";
    const ACTIVE_ATTRIBUTE = "data-apstudycanvas-sidebar-active";
    // Prepaint handshake: the controller records the last rendered rail width;
    // the MAIN-world document-start watchdog replays it as a before-first-paint
    // gutter reservation so a navigation that will mount the rail never shows
    // the un-railed layout first. See sidebar-watchdog.js.
    const PREPAINT_STORAGE_KEY = "apstudycanvas-sidebar-prepaint";
    const PREPAINT_ATTRIBUTE = "data-apstudycanvas-sidebar-prepaint";
    // Route-diff stamp: render() records which model revision the rail DOM was
    // built from, so notifyRoute can update active markers in place instead of
    // rebuilding the rail on every SPA navigation. A mismatch (root replaced,
    // DOM tampered with) falls back to a full render.
    const REVISION_ATTRIBUTE = "data-apstudycanvas-sidebar-revision";
    // Cross-document hydration snapshot: after each populated render the
    // controller mirrors the last rendered model into sessionStorage (the
    // per-tab, cross-world channel the prepaint already uses). The next hard
    // navigation adopts it synchronously at mount, so the rail appears fully
    // populated with Canvas's nav instead of cycling loading → cache →
    // network. Provisional semantics keep it honest: the one-shot mount
    // refresh revalidates exactly as before.
    const SNAPSHOT_STORAGE_KEY = "apstudycanvas-sidebar-model";
    const SNAPSHOT_RECORD_VERSION = 1;
    const SNAPSHOT_TTL_MS = 6 * 60 * 60 * 1000;
    const SNAPSHOT_FLUSH_DELAY_MS = 500;
    const SNAPSHOT_MAX_BYTES = 32 * 1024;
    const SNAPSHOT_MAX_COURSES = 200;
    const WRAPPER_SELECTOR = "#wrapper";
    const GLOBAL_COURSES_FLYOUT_SELECTOR = "#nav-tray-portal .navigation-tray-container.courses-tray";
    const COURSE_NAVIGATION_SELECTORS = Object.freeze([
        ".ic-Layout-columns",
        "body.with-left-side.course-menu-expanded #left-side.ic-app-course-menu"
    ]);
    const LAYOUT_SELECTORS = Object.freeze([WRAPPER_SELECTOR, GLOBAL_COURSES_FLYOUT_SELECTOR, ...COURSE_NAVIGATION_SELECTORS]);
    const CONTROLLER_SLOT = "__apstudycanvasSidebarController";
    const DEFAULT_ORDER = Object.freeze(Array.from(schema?.defaultSidebarPageOrder || ["dashboard", "courses", "calendar", "inbox", "history", "help", "apstudy:planner", "apstudy:notes", "apstudy:grades", "apstudy:study"]));
    const DEFAULT_VISIBILITY = Object.freeze({ ...(schema?.defaultSidebarPageVisibility || { dashboard: true, courses: true, calendar: true, inbox: true, history: true, help: true, "apstudy:planner": true, "apstudy:notes": true, "apstudy:grades": true, "apstudy:study": true }) });
    const LABELS = Object.freeze({ dashboard: "Dashboard", courses: "Courses", calendar: "Calendar", inbox: "Inbox", history: "History", help: "Help", "apstudy:planner": "Planner", "apstudy:notes": "Notes", "apstudy:grades": "Grades", "apstudy:study": "Study" });
    const AVATAR_SIZE_PX = Object.freeze({ small: 32, medium: 44, large: 56 });
    // The profile picture stands in for the native Account button, so it opens
    // the same tray Canvas would: the classic global nav mounts the trigger as
    // #global_nav_profile_link, the newer SideNav as the #profile-tray item.
    const ACCOUNT_TRAY_SELECTORS = Object.freeze([
        "#global_nav_profile_link",
        "#profile-tray"
    ]);
    const ICON_PATHS = Object.freeze({
        dashboard: "M3 10.5 12 3l9 7.5V21H3z M8 21v-6h8v6",
        courses: "M4 5.5h16v13H4z M4 9h16 M9 5.5v13",
        calendar: "M5 4h14v16H5z M8 2v4 M16 2v4 M5 9h14",
        inbox: "M4 5h16v14H4z M4 13h4l2 3h4l2-3h4",
        history: "M4 12a8 8 0 1 0 2.3-5.7 M4 4v5h5 M12 7v5l3 2",
        help: "M9.5 9a2.7 2.7 0 1 1 4.5 2c-1.3 1-2 1.4-2 3 M12 18h.01 M4 4h16v16H4z",
        planner: "M5 5h14v15H5z M8 3v4 M16 3v4 M5 9h14 M8 13h3 M8 16h6",
        notes: "M5 4h11l3 3v13H5z M16 4v4h3 M8 12h8 M8 16h6",
        grades: "M4 20h16 M6 17l4-4 3 2 5-7 M16 8h2v2",
        study: "M4 5.5c3.2-.8 5.9-.3 8 1.5v13c-2.1-1.8-4.8-2.3-8-1.5z M20 5.5c-3.2-.8-5.9-.3-8 1.5v13c2.1-1.8 4.8-2.3 8-1.5z",
        // The APStudy egg is an original outline mark: a quiet oval shell
        // with a small Nest-like cradle, shared by every owned Page action.
        "apstudy-egg": "M12 3.4c-4.1 0-6.7 3.7-6.7 8.2 0 5.2 3.1 9 6.7 9s6.7-3.8 6.7-9c0-4.5-2.6-8.2-6.7-8.2Z M8.2 14.1c1.2.9 2.5 1.3 3.8 1.3s2.6-.4 3.8-1.3 M9.2 9.8h.01 M14.8 9.8h.01",
        settings: "M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.3.9a7.5 7.5 0 0 0-2-1.2L14.3 3h-4.6l-.4 2.6a7.5 7.5 0 0 0-2 1.2L5 5.9 3 9.3l2 1.5A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.5 2 3.4 2.3-.9a7.5 7.5 0 0 0 2 1.2l.4 2.6h4.6l.4-2.6a7.5 7.5 0 0 0 2-1.2l2.3.9 2-3.4-2-1.5c.1-.4.1-.8.1-1.2z",
        chevron: "M8 5l7 7-7 7",
        fallback: "M4 4h16v16H4z M8 8h8v8H8z"
    });
    const ITEM_SELECTORS = Object.freeze({
        dashboard: "#global_nav_dashboard_link, #global-nav-dashboard-link",
        courses: "#global_nav_courses_link, #global-nav-courses-link",
        calendar: "#global_nav_calendar_link, #global-nav-calendar-link",
        inbox: "#global_nav_conversations_link, #global_nav_inbox_link, #global-nav-inbox-link",
        history: "#global_nav_history_link, #global-nav-history-link",
        help: "#global_nav_help_link, #global-nav-help-link"
    });
    const SIDEBAR_LIVE_SETTING_KEYS = Object.freeze([
        "better_sidebar", "sidebar_enabled", "enable_sidebar", "enabled", "sidebar_preferred_state",
        "sidebar_scale_preset", "sidebar_scale", "sidebar_expanded_width", "sidebar_collapsed_width",
        "sidebar_density", "sidebar_icon_size", "sidebar_label_size", "sidebar_logo_visible",
        "sidebar_product_entry_visible", "sidebar_avatar_size", "sidebar_collapsed_labels", "sidebar_pages_visible_expanded",
        "sidebar_courses_visible_expanded", "sidebar_pages_visible_collapsed", "sidebar_courses_visible_collapsed",
        "sidebar_section_visibility", "sidebar_pages_folded", "sidebar_courses_folded", "sidebar_page_order",
        "sidebar_page_visibility", "sidebar_page_labels", "sidebar_labels", "sidebar_tooltips",
        "dashboard_sidebar_expanded", "course_sidebar_expanded"
    ]);
    const SIDEBAR_LEGACY_LIVE_SETTING_KEYS = Object.freeze(["sidebar_labels"]);
    const SIDEBAR_NUMERIC_RANGES = Object.freeze({
        sidebar_scale: Object.freeze({ min: 70, max: 150 }),
        sidebar_expanded_width: Object.freeze({ min: 160, max: 320 }),
        sidebar_collapsed_width: Object.freeze({ min: 48, max: 112 }),
        sidebar_icon_size: Object.freeze({ min: 12, max: 32 }),
        sidebar_label_size: Object.freeze({ min: 10, max: 20 })
    });
    const registry = typeof WeakMap === "function" ? new WeakMap() : new Map();

    function isPlainObject(value) {
        if (!value || typeof value !== "object" || Array.isArray(value)) return false;
        const prototype = Object.getPrototypeOf(value);
        if (prototype === Object.prototype || prototype === null) return true;
        // vm-cloned envelopes in tests (and structured-clone copies) live in
        // another Object realm than this required module; still treat ordinary
        // dictionaries as plain objects.
        return Object.prototype.toString.call(value) === "[object Object]";
    }
    function normalizeOrder(value, defaults = DEFAULT_ORDER) {
        const known = Array.isArray(defaults) ? defaults.filter((item, index, all) => typeof item === "string" && all.indexOf(item) === index) : DEFAULT_ORDER.slice();
        const values = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
        const seen = new Set();
        const output = [];
        values.forEach((item) => { if (typeof item === "string" && known.includes(item) && !seen.has(item)) { seen.add(item); output.push(item); } });
        known.forEach((item) => { if (!seen.has(item)) output.push(item); });
        return output;
    }
    // The keys settings-apply's validateSettingsUpdateRequest routes to this
    // module's sidebar validator. settings-apply splits each SETTINGS_UPDATE
    // payload on this exact set, so the two lists must stay aligned; a key
    // listed here but absent there would bypass validation, and one listed
    // there but absent here would wrongly reject a valid sidebar change.
    const SIDEBAR_VALIDATABLE_KEYS = Object.freeze(new Set([
        "better_sidebar", "sidebar_enabled", "enable_sidebar", "enabled",
        "sidebar_scale", "sidebar_scale_preset", "sidebar_expanded_width", "sidebar_collapsed_width",
        "sidebar_density", "sidebar_icon_size", "sidebar_label_size", "sidebar_logo_visible",
        "sidebar_product_entry_visible", "sidebar_avatar_size", "sidebar_collapsed_labels", "sidebar_tooltips",
        "sidebar_accessibility_labels", "sidebar_page_order", "sidebar_page_visibility",
        "sidebar_page_labels", "sidebar_labels",
        "sidebar_pages_visible_expanded", "sidebar_pages_visible_collapsed",
        "sidebar_courses_visible_expanded", "sidebar_courses_visible_collapsed",
        "sidebar_pages_folded", "sidebar_courses_folded", "sidebar_preferred_state",
        "dashboard_sidebar_expanded", "course_sidebar_expanded"
    ]));
    // sidebar_page_labels/sidebar_labels are BetterCampus compatibility keys
    // that the settings schema does not own, so they get a structural check.
    // Everything else defers to the schema's own sync validation, which also
    // supplies the clamped numeric values the storage seam would persist.
    function validateSidebarChange(key, value) {
        if (key === "sidebar_page_labels" || key === "sidebar_labels") return isPlainObject(value);
        if (schema?.validateSettingValue) return schema.validateSettingValue("sync", key, value).valid === true;
        if (typeof value === "boolean") return true;
        const range = SIDEBAR_NUMERIC_RANGES[key];
        if (range) return typeof value === "number" && Number.isFinite(value) && value >= range.min && value <= range.max;
        if (key === "sidebar_page_order") return Array.isArray(value) && value.every((item) => typeof item === "string");
        if (key === "sidebar_page_visibility") return isPlainObject(value) && Object.values(value).every((entry) => typeof entry === "boolean");
        if (key === "sidebar_density") return ["compact", "cozy", "comfortable", "dense"].includes(value);
        if (key === "sidebar_preferred_state") return ["expanded", "collapsed"].includes(value);
        if (key === "sidebar_scale_preset") return typeof value === "string" && ["tiny", "small", "medium", "large", "extra-large"].includes(value);
        return false;
    }
    function validateSettingsUpdateRequest(request) {
        if (!isPlainObject(request) || request.type !== "SETTINGS_UPDATE") return { ok: false, code: "SETTINGS_MESSAGE_INVALID" };
        const payload = request.payload;
        if (!isPlainObject(payload) || payload.area !== "sync" || !isPlainObject(payload.changes)) {
            return { ok: false, code: "SETTINGS_PAYLOAD_INVALID" };
        }
        const requestId = request.request_id ?? request.requestId;
        const entries = Object.entries(payload.changes);
        if (!entries.length) return { ok: true, requestId, payload: { area: "sync", changes: {}, reloadKeys: [] } };
        const changes = {};
        for (const [key, value] of entries) {
            if (!SIDEBAR_VALIDATABLE_KEYS.has(key)) return { ok: false, code: "SETTINGS_KEY_UNSUPPORTED" };
            if (key === "sidebar_page_labels" || key === "sidebar_labels") {
                if (!isPlainObject(value)) return { ok: false, code: "SETTINGS_VALUE_INVALID" };
                changes[key] = value;
                continue;
            }
            if (schema?.validateSettingValue) {
                const validated = schema.validateSettingValue("sync", key, value);
                if (!validated.valid) return { ok: false, code: validated.code || "SETTINGS_VALUE_INVALID" };
                changes[key] = validated.value;
                continue;
            }
            if (!validateSidebarChange(key, value)) return { ok: false, code: "SETTINGS_VALUE_INVALID" };
            changes[key] = value;
        }
        return { ok: true, requestId, payload: { area: "sync", changes, reloadKeys: [] } };
    }
    function attr(node, name) { return node?.getAttribute?.(name) ?? null; }
    function setAttr(node, name, value) {
        if (!node) return;
        if (value === null || value === undefined || value === false) {
            if (node.getAttribute?.(name) !== null) node.removeAttribute?.(name);
            return;
        }
        // Re-writing an identical attribute still emits a mutation record, so
        // identical writes are skipped: the rail re-renders on every apply and
        // Canvas-owned layout nodes must not feed the page observer churn.
        const next = value === true ? "" : String(value);
        if (node.getAttribute?.(name) !== next) node.setAttribute?.(name, next);
    }
    function text(value, fallback = "") { const result = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : ""; return result || fallback; }
    function safeCall(fn, fallback) { try { return fn(); } catch (error) { return fallback; } }
    function toggleClass(node, name, force) {
        if (!node) return;
        if (node.classList?.toggle) { node.classList.toggle(name, Boolean(force)); return; }
        const set = new Set(String(attr(node, "class") || "").split(/\s+/).filter(Boolean));
        if (force) set.add(name); else set.delete(name);
        setAttr(node, "class", Array.from(set).join(" ") || null);
    }
    function setStyle(node, name, value) {
        if (node?.style?.setProperty) node.style.setProperty(name, value);
        else if (node) setAttr(node, "style", `${attr(node, "style") || ""}${name}:${value};`);
    }
    function findById(doc, id) { return doc?.getElementById?.(id) || null; }
    function query(doc, selector) { return safeCall(() => doc?.querySelector?.(selector), null); }
    function listen(target, type, handler, options) {
        if (!target?.addEventListener) return () => {};
        target.addEventListener(type, handler, options);
        return () => target.removeEventListener?.(type, handler, options);
    }
    function focus(node) { try { node?.focus?.(); } catch (error) {} }
    function iconPath(role) { return ICON_PATHS[role] || ICON_PATHS.fallback; }
    function createSvgElement(doc, name) {
        return typeof doc?.createElementNS === "function" ? doc.createElementNS(SVG_NAMESPACE, name) : doc?.createElement?.(name);
    }
    function makeIcon(doc, role) {
        const svg = createSvgElement(doc, "svg");
        const knownRole = Object.prototype.hasOwnProperty.call(ICON_PATHS, role) ? role : "fallback";
        setAttr(svg, "class", `${NAMESPACE}-icon`); setAttr(svg, "xmlns", SVG_NAMESPACE); setAttr(svg, "viewBox", "0 0 24 24"); setAttr(svg, "preserveAspectRatio", "xMidYMid meet"); setAttr(svg, "aria-hidden", "true"); setAttr(svg, "focusable", "false"); setAttr(svg, "role", "presentation"); setAttr(svg, "fill", "none"); setAttr(svg, "stroke", "currentColor"); setAttr(svg, "data-apstudycanvas-icon", knownRole);
        const path = createSvgElement(doc, "path");
        setAttr(path, "class", `${NAMESPACE}-icon-path`); setAttr(path, "d", iconPath(knownRole)); setAttr(path, "fill", "none"); setAttr(path, "stroke", "currentColor"); setAttr(path, "stroke-width", "1.8"); setAttr(path, "stroke-linecap", "round"); setAttr(path, "stroke-linejoin", "round"); setAttr(path, "vector-effect", "non-scaling-stroke");
        svg.appendChild?.(path); return svg;
    }
    function normalizeSettings(settings) {
        if (model?.normalizeSidebarSettings) return model.normalizeSidebarSettings(settings || {});
        return { enabled: requestedEnabled(settings), preferredState: "expanded", widths: { expanded: 180, collapsed: 86 }, density: "cozy", scaleValues: { icon: 16, label: 14 }, logoVisible: true, productEntryVisible: true, avatarSize: "medium", collapsedLabels: true, sectionVisibility: { expanded: { pages: true, courses: true }, collapsed: { pages: true, courses: false } }, sectionFolded: { pages: false, courses: false }, pageOrder: DEFAULT_ORDER.slice(), pageVisibility: { ...DEFAULT_VISIBILITY }, tooltips: true };
    }
    function requestedEnabled(settings) {
        if (Object.prototype.hasOwnProperty.call(settings || {}, "better_sidebar")) return settings.better_sidebar === true;
        return ["sidebar_enabled", "enable_sidebar", "enabled"].some((key) => settings?.[key] === true);
    }

    const REFRESH_TIMEOUT_MS = 15000;
    // Bounded post-hydration reconciliation: Canvas paints dashboard cards
    // asynchronously, so an initial refresh can finish before any card exists.
    // The watch re-checks on card-container mutations and on a coarse timer
    // until the budget expires; it never polls forever and never refetches.
    const CARD_HYDRATION_INTERVAL_MS = 2000;
    const CARD_HYDRATION_BUDGET_MS = 12000;

    function createSidebarController({ document: doc = globalThis.document, window: win = globalThis.window, chromeApi = globalThis.chrome, listenStorage = true, root: injectedRoot = null, rootResolver = null, adapter = null, storageAdapter = null, readCourseOrder = null, writeCourseOrder = null, writeSettings = null, courseCache = null, displayedCardCache = null, readHiddenCardCourseIds = null, refreshTimeoutMs = REFRESH_TIMEOUT_MS, now = () => Date.now(), onModelChange = null } = {}) {
        if (!doc) return { init() {}, apply() {}, reset() {}, pause() {}, resume() {}, dispose() {}, needsRefresh() { return false; } };
        const existing = registry.get(doc) || doc[CONTROLLER_SLOT];
        if (existing) return existing;
        let nativeRoot = null; let customRoot = null; let recovery = null; let nativeLedger = null;
        let initialized = false; let paused = false; let recoveryOpen = false; let showingHidden = false; let state = {};
        let normalized = normalizeSettings({});
        let sidebarModel = { identity: {}, route: {}, pages: [], courses: [], pageOrder: [], pageVisibility: {}, courseState: { status: "loading", retryable: false, reason: null } };
        let courseDisclosure = new Map();
        const disclosureExitTimers = new Map();
        let cleanup = []; let refreshGeneration = 0; let refreshAbortController = null; let courseNavigationGeneration = 0; let heartbeatTimer = null; let pendingMountRefresh = false; let api;
        let mountRefreshDone = false;
        let cardWatch = null;
        let renderedRevision = 0;
        let renderedPageLinks = [];
        let snapshotTimer = null;
        let lastSnapshotRecord = null;
        const refreshTimeout = Number.isFinite(Number(refreshTimeoutMs)) && Number(refreshTimeoutMs) > 0 ? Number(refreshTimeoutMs) : REFRESH_TIMEOUT_MS;

        function readLocalValue(key) {
            if (typeof storageAdapter?.get === "function") {
                return Promise.resolve().then(() => storageAdapter.get(key, "local")).catch(() => undefined);
            }
            if (chromeApi?.storage?.local?.get) {
                return new Promise((resolve) => {
                    try {
                        const returned = chromeApi.storage.local.get(key, (result) => resolve(result?.[key]));
                        if (returned && typeof returned.then === "function") returned.then((result) => resolve(result?.[key]), () => resolve(undefined));
                    } catch (error) { resolve(undefined); }
                });
            }
            return Promise.resolve(undefined);
        }
        function writeLocalValue(key, value) {
            if (typeof storageAdapter?.set === "function") {
                return Promise.resolve().then(() => storageAdapter.set({ [key]: value }, "local")).then(() => true).catch(() => false);
            }
            if (chromeApi?.storage?.local?.set) {
                return new Promise((resolve) => {
                    try {
                        const returned = chromeApi.storage.local.set({ [key]: value }, () => {
                            const error = chromeApi.runtime?.lastError;
                            resolve(!error);
                        });
                        if (returned && typeof returned.then === "function") returned.then(() => resolve(true), () => resolve(false));
                    } catch (error) { resolve(false); }
                });
            }
            return Promise.resolve(false);
        }
        const activeCourseCache = courseCache
            || (courseCacheApi?.createSidebarCourseCache
                ? courseCacheApi.createSidebarCourseCache({
                    storage: { get: (key) => readLocalValue(key), set: (key, value) => writeLocalValue(key, value) }
                })
                : null);
        const displayedCardStore = displayedCardCache
            || (displayedCardCacheApi?.createDisplayedCardCache
                ? displayedCardCacheApi.createDisplayedCardCache({
                    storage: { get: (key) => readLocalValue(key), set: (key, value) => writeLocalValue(key, value) }
                })
                : null);
        function hiddenCardCourseIds() {
            try {
                const ids = typeof readHiddenCardCourseIds === "function" ? readHiddenCardCourseIds() : [];
                return Array.isArray(ids) ? ids : [];
            } catch (error) {
                return [];
            }
        }

        function heartbeatToken() {
            try {
                if (win?.crypto?.randomUUID) return win.crypto.randomUUID();
            } catch (error) {}
            return `apstudycanvas-${Number(now())}-${Math.random().toString(36).slice(2, 10)}`;
        }
        const sessionToken = heartbeatToken();
        function stopHeartbeat() {
            if (heartbeatTimer !== null) win?.clearInterval?.(heartbeatTimer);
            heartbeatTimer = null;
        }
        function clearHeartbeat() {
            stopHeartbeat();
            const element = doc.documentElement;
            if (attr(element, SESSION_ATTRIBUTE) === sessionToken) {
                setAttr(element, ACTIVE_ATTRIBUTE, null);
                setAttr(element, SESSION_ATTRIBUTE, null);
                setAttr(element, HEARTBEAT_ATTRIBUTE, null);
            }
        }
        function publishHeartbeat() {
            if (!extensionContextIsValid()) {
                restoreAfterContextInvalidation();
                return;
            }
            if (paused || !normalized.enabled) { stopHeartbeat(); return; }
            // A detached/replaced root means the content-script lifecycle died
            // unexpectedly. Stop this controller's timer, but preserve its last
            // session/heartbeat so the page-world watchdog can restore any
            // native and layout state that survived the root.
            if (!customRoot || !isConnected(customRoot)) { stopHeartbeat(); return; }
            const element = doc.documentElement;
            setAttr(element, MARKER, "1");
            setAttr(element, ACTIVE_ATTRIBUTE, "1");
            setAttr(element, SESSION_ATTRIBUTE, sessionToken);
            setAttr(element, HEARTBEAT_ATTRIBUTE, String(now()));
        }
        function startHeartbeat() {
            publishHeartbeat();
            if (heartbeatTimer !== null || typeof win?.setInterval !== "function") return;
            heartbeatTimer = win.setInterval(publishHeartbeat, 2000);
        }
        let lastPrepaintRecord = null;
        function persistPrepaintRecord(width, stateValue) {
            try {
                const record = JSON.stringify({ v: 1, width: Math.max(0, Math.round(Number(width) || 0)), state: String(stateValue || "") });
                if (record === lastPrepaintRecord) return;
                lastPrepaintRecord = record;
                win?.sessionStorage?.setItem?.(PREPAINT_STORAGE_KEY, record);
            } catch (error) { lastPrepaintRecord = null; }
        }
        function clearPrepaintRecord() {
            lastPrepaintRecord = null;
            try { win?.sessionStorage?.removeItem?.(PREPAINT_STORAGE_KEY); } catch (error) {}
            try { doc.documentElement?.removeAttribute?.(PREPAINT_ATTRIBUTE); } catch (error) {}
        }
        function clearSnapshotTimer() {
            if (snapshotTimer === null) return;
            (typeof win?.clearTimeout === "function" ? win.clearTimeout : clearTimeout)(snapshotTimer);
            snapshotTimer = null;
        }
        // Only a settled, populated model is worth hydrating from: loading,
        // error, and empty renders must never overwrite a good snapshot.
        function buildSnapshotRecord() {
            const courseState = resolvedCourseState();
            if (courseState.status !== "populated" || !Array.isArray(sidebarModel.pages) || !sidebarModel.pages.length) return null;
            const identity = sidebarModel.identity || {};
            const courses = (Array.isArray(sidebarModel.courses) ? sidebarModel.courses : [])
                .slice(0, SNAPSHOT_MAX_COURSES)
                .map((course) => ({
                    id: course?.id ?? null,
                    name: text(course?.name, "Course"),
                    href: course?.href ?? null,
                    color: typeof course?.color === "string" ? course.color : null
                }));
            const record = {
                v: SNAPSHOT_RECORD_VERSION,
                ts: Number(now()) || 0,
                pages: sidebarModel.pages.map((page) => ({
                    id: page?.id ?? null,
                    label: page?.label ?? null,
                    href: page?.href ?? null,
                    iconRole: page?.iconRole ?? null,
                    available: page?.available !== false
                })),
                pageOrder: Array.isArray(sidebarModel.pageOrder) ? sidebarModel.pageOrder.slice() : [],
                pageVisibility: isPlainObject(sidebarModel.pageVisibility) ? { ...sidebarModel.pageVisibility } : {},
                courses,
                courseOrder: Array.isArray(sidebarModel.courseOrder) ? sidebarModel.courseOrder.slice() : [],
                identity: {
                    institutionName: identity.institutionName ?? identity.institution?.name ?? null,
                    institutionMarkUrl: identity.institutionMarkUrl ?? identity.institution?.markUrl ?? null,
                    userName: identity.userName ?? identity.user?.name ?? null,
                    userAvatarUrl: identity.userAvatarUrl ?? identity.user?.avatarUrl ?? null
                },
                disclosure: []
            };
            courseDisclosure.forEach((entry, id) => {
                if (!entry?.open || entry.status !== "ready" || !Array.isArray(entry.tabs) || !entry.tabs.length) return;
                record.disclosure.push({ id, tabs: entry.tabs.map((tab) => ({ label: tab?.label ?? null, href: tab?.href ?? null })) });
            });
            return record;
        }
        function writeSnapshotRecord() {
            const record = buildSnapshotRecord();
            if (!record) return;
            let serialized = null;
            try {
                serialized = JSON.stringify(record);
                // Graceful degradation under the size cap: drop the open
                // course disclosures first, then the course list (the rail
                // still hydrates its page structure and falls back to the
                // loading state), and finally skip the write entirely.
                if (serialized.length > SNAPSHOT_MAX_BYTES) { record.disclosure = []; serialized = JSON.stringify(record); }
                if (serialized.length > SNAPSHOT_MAX_BYTES) { record.courses = []; record.courseOrder = []; serialized = JSON.stringify(record); }
                if (serialized.length > SNAPSHOT_MAX_BYTES) return;
            } catch (error) { return; }
            if (serialized === lastSnapshotRecord) return;
            lastSnapshotRecord = serialized;
            try { win?.sessionStorage?.setItem?.(SNAPSHOT_STORAGE_KEY, serialized); } catch (error) { lastSnapshotRecord = null; }
        }
        function persistSnapshotRecord() {
            clearSnapshotTimer();
            const schedule = typeof win?.setTimeout === "function" ? win.setTimeout.bind(win) : setTimeout;
            snapshotTimer = schedule(() => {
                snapshotTimer = null;
                if (customRoot && !paused) writeSnapshotRecord();
            }, SNAPSHOT_FLUSH_DELAY_MS);
        }
        // Synchronous pagehide/toggle-time write: the debounced render-path
        // timer cannot be relied on across a hard navigation. Deliberately not
        // gated on paused() — a bfcache eviction lands as a fresh document on
        // the next visit, and the record mirrors the last rendered model
        // either way.
        function flushSnapshotRecord() {
            clearSnapshotTimer();
            try { writeSnapshotRecord(); } catch (error) {}
        }
        function parseCurrentRoute() {
            const routeSource = adapter?.parseCanvasRoute || adapterApi?.parseCanvasRoute;
            if (typeof routeSource !== "function") return {};
            const route = safeCall(() => routeSource(win?.location, { origin: win?.location?.origin }), null);
            return isPlainObject(route) ? route : {};
        }
        function adoptSnapshotRecord() {
            let record = null;
            try { record = JSON.parse(win?.sessionStorage?.getItem?.(SNAPSHOT_STORAGE_KEY) || "null"); } catch (error) { record = null; }
            if (!record || record.v !== SNAPSHOT_RECORD_VERSION) return false;
            const ts = Number(record.ts);
            if (!Number.isFinite(ts) || ts <= 0 || (Number(now()) || 0) - ts > SNAPSHOT_TTL_MS) return false;
            const pages = Array.isArray(record.pages)
                ? record.pages.filter((page) => page && typeof page.id === "string" && page.id)
                : [];
            if (!pages.length) return false;
            const courses = Array.isArray(record.courses)
                ? record.courses.filter((course) => course && (typeof course.id === "string" ? Boolean(course.id) : Number.isFinite(Number(course.id)))).slice(0, SNAPSHOT_MAX_COURSES)
                : [];
            // The route is re-derived here (never trusted from the record) so
            // the very first render already highlights the active destination.
            sidebarModel = {
                identity: isPlainObject(record.identity) ? record.identity : {},
                route: parseCurrentRoute(),
                pages,
                pageOrder: Array.isArray(record.pageOrder) ? record.pageOrder.filter((id) => typeof id === "string") : [],
                pageVisibility: isPlainObject(record.pageVisibility) ? { ...record.pageVisibility } : {},
                courses,
                courseOrder: Array.isArray(record.courseOrder) ? record.courseOrder.slice() : [],
                courseState: { status: courses.length ? "populated" : "loading", retryable: false, reason: "snapshot", provisional: true }
            };
            courseDisclosure = new Map();
            (Array.isArray(record.disclosure) ? record.disclosure : []).forEach((entry) => {
                const id = String(entry?.id ?? "");
                if (!id || !Array.isArray(entry.tabs) || !entry.tabs.length) return;
                if (!courses.some((course) => String(course?.id) === id)) return;
                const tabs = entry.tabs
                    .filter((tab) => tab && typeof tab.href === "string" && safeHref(tab.href))
                    .map((tab) => ({ label: text(tab.label, "Course page"), href: tab.href }));
                if (!tabs.length) return;
                courseDisclosure.set(id, { open: true, status: "ready", tabs, generation: ++courseNavigationGeneration, abortController: null });
            });
            return true;
        }

        function findNativeRoot() { if (typeof rootResolver === "function") return rootResolver(); if (injectedRoot) return typeof injectedRoot === "function" ? injectedRoot() : injectedRoot; return query(doc, "#global_nav, #global-nav, .ic-app-header"); }
        function extensionContextIsValid() {
            const runtime = chromeApi?.runtime;
            if (!runtime) return true;
            try {
                const manifest = runtime.getManifest?.();
                if (!manifest || typeof manifest !== "object") return false;
                // Accessing id can itself throw after Chromium invalidates the
                // isolated-world extension wrapper. It is not otherwise used.
                void runtime.id;
                return true;
            } catch (error) { return false; }
        }
        function findLayoutNode(selector) {
            if (selector === GLOBAL_COURSES_FLYOUT_SELECTOR) {
                const portal = query(doc, "#nav-tray-portal");
                const direct = portal?.querySelector?.(".navigation-tray-container.courses-tray");
                if (direct) return direct;
                return Array.from(portal?.querySelectorAll?.(".navigation-tray-container") || [])
                    .find((node) => node.classList?.contains?.("courses-tray")) || null;
            }
            return query(doc, selector);
        }
        function nativeItem(key) { return query(nativeRoot || doc, ITEM_SELECTORS[key]) || query(doc, ITEM_SELECTORS[key]); }
        function rememberAttribute(node, name) {
            if (!node || !nativeLedger) return;
            if (!nativeLedger.attributes.has(node)) nativeLedger.attributes.set(node, new Map());
            const values = nativeLedger.attributes.get(node);
            if (!values.has(name)) values.set(name, attr(node, name));
        }
        function rememberStyle(node, name) {
            if (!node || !nativeLedger) return;
            if (!nativeLedger.styles.has(node)) nativeLedger.styles.set(node, new Map());
            const values = nativeLedger.styles.get(node);
            if (!values.has(name)) values.set(name, node.style?.getPropertyValue?.(name) || node.style?.[name] || "");
        }
        function rememberClass(node, name) {
            if (!node || !nativeLedger) return;
            if (!nativeLedger.classes.has(node)) nativeLedger.classes.set(node, new Map());
            const values = nativeLedger.classes.get(node);
            if (!values.has(name)) values.set(name, Boolean(node.classList?.contains?.(name)));
        }
        function isConnected(node) {
            if (!node) return false;
            if (typeof node.isConnected === "boolean") return node.isConnected;
            return Boolean(doc.documentElement?.contains?.(node));
        }
        function nativeRootIsCurrent() {
            if (!nativeRoot || !isConnected(nativeRoot)) return false;
            if (typeof rootResolver === "function") return rootResolver() === nativeRoot;
            if (typeof injectedRoot === "function") return injectedRoot() === nativeRoot;
            const discovered = query(doc, "#global_nav, #global-nav, .ic-app-header");
            return !discovered || discovered === nativeRoot;
        }
        function ledgerNodeIsCurrent(node) {
            if (!isConnected(node)) return false;
            if (node === doc.documentElement) return true;
            if (LAYOUT_SELECTORS.some((selector) => findLayoutNode(selector) === node)) return true;
            return nativeRootIsCurrent() && (node === nativeRoot || nativeRoot.contains?.(node));
        }
        function captureNative() {
            if (!nativeRoot || nativeLedger?.root === nativeRoot) return;
            // This is intentionally a mutation ledger, not a DOM snapshot: it
            // records only the Canvas nodes/properties this controller mutates.
            nativeLedger = { root: nativeRoot, attributes: new Map(), styles: new Map(), classes: new Map() };
            rememberAttribute(nativeRoot, MARKER);
            rememberAttribute(doc.documentElement, MARKER);
            [NAMESPACE, `${NAMESPACE}-hidden`].forEach((name) => rememberClass(nativeRoot, name));
            rememberStyle(doc.documentElement, "--apstudy-sidebar-width");
        }
        function markLayoutOwnership() {
            LAYOUT_SELECTORS.forEach((selector) => {
                const node = findLayoutNode(selector);
                if (!node) return;
                rememberAttribute(node, MARKER);
                setAttr(node, MARKER, "1");
            });
        }
        // Stacking parity with the native nav: the rail, Courses tray, and
        // recovery control key off the nav's own computed z-index, so page
        // overlays (file previews, modals) cover them exactly as they cover
        // the native nav. Non-numeric ("auto") values leave the CSS fallback.
        function stampNavLayerZ() {
            if (!nativeRoot) return;
            rememberStyle(doc.documentElement, "--apstudy-nav-layer-z");
            const raw = safeCall(() => String(win?.getComputedStyle?.(nativeRoot)?.zIndex ?? ""), "");
            const layer = Number.parseInt(raw, 10);
            if (Number.isFinite(layer) && layer >= 0) setStyle(doc.documentElement, "--apstudy-nav-layer-z", String(layer));
            else doc.documentElement?.style?.removeProperty?.("--apstudy-nav-layer-z");
        }
        function restoreNative() {
            if (!nativeLedger) return;
            nativeLedger.attributes.forEach((values, node) => {
                if (!ledgerNodeIsCurrent(node)) return;
                values.forEach((value, name) => setAttr(node, name, value));
            });
            nativeLedger.styles.forEach((values, node) => {
                if (!ledgerNodeIsCurrent(node)) return;
                values.forEach((value, name) => {
                    if (value) node.style?.setProperty?.(name, value);
                    else node.style?.removeProperty?.(name);
                });
            });
            nativeLedger.classes.forEach((values, node) => {
                if (!ledgerNodeIsCurrent(node)) return;
                values.forEach((present, name) => toggleClass(node, name, present));
            });
        }
        function removeOwnedNodes() {
            customRoot?.remove?.(); recovery?.remove?.();
            customRoot = null; recovery = null; courseDisclosure = new Map(); setAttr(doc.documentElement, "data-apstudycanvas-sidebar-state", null);
        }
        function cancelCourseNavigationLoads({ clear = false } = {}) {
            courseNavigationGeneration += 1;
            courseDisclosure.forEach((entry) => entry?.abortController?.abort?.());
            if (clear) courseDisclosure = new Map();
        }
        function cancelRefreshes() {
            refreshGeneration += 1;
            refreshAbortController?.abort?.();
            refreshAbortController = null;
            cancelCourseNavigationLoads({ clear: true });
            cancelCardHydrationWatch();
        }
        function cancelCardHydrationWatch() {
            if (!cardWatch) return;
            const watch = cardWatch;
            cardWatch = null;
            try { watch.observer?.disconnect?.(); } catch (error) {}
            if (watch.timer !== null) {
                try { (typeof win?.clearTimeout === "function" ? win.clearTimeout : clearTimeout)(watch.timer); } catch (error) {}
            }
        }
        // One bounded re-assembly with the active enrollment list the original
        // refresh already fetched, so hydration convergence costs no network
        // round trip. The adapter re-reads the now-hydrated card DOM and
        // narrows the courses to the authoritative displayed set; anything the
        // re-assembly cannot resolve keeps the previous model untouched.
        async function reconcileDisplayedCards(pinnedCourses, generation) {
            if (generation !== refreshGeneration || paused) return;
            const source = adapter?.assemble ? adapter : adapterApi;
            if (typeof source?.assemble !== "function" || !Array.isArray(pinnedCourses) || !pinnedCourses.length) return;
            let next = null;
            try {
                next = await source.assemble({
                    document: doc,
                    location: win?.location,
                    // Pinned inputs: no course fetch, no identity/unread probes.
                    courses: pinnedCourses,
                    apiUser: null,
                    unread: {},
                    savedOrder: normalized.pageOrder,
                    savedVisibility: normalized.pageVisibility,
                    displayedCardStore: displayedCardStore,
                    hiddenCardCourseIds: hiddenCardCourseIds()
                });
            } catch (error) { return; }
            if (generation !== refreshGeneration || paused) return;
            if (!isPlainObject(next) || next.displayedCardSource !== "dom" || !Array.isArray(next.courses) || !next.courses.length) return;
            const reconciled = model?.reconcileSidebarCourses
                ? model.reconcileSidebarCourses({ courses: next.courses, savedOrder: sidebarModel.courseOrder })
                : { courses: next.courses, order: next.courses.map((course) => course.id) };
            sidebarModel = {
                ...sidebarModel,
                courses: reconciled.courses,
                courseOrder: reconciled.order,
                displayedCardIds: Array.isArray(next.displayedCardIds) ? next.displayedCardIds : [],
                displayedCardSource: "dom",
                displayedCardsPending: false,
                courseState: { ...resolvedCourseState(), status: "populated", retryable: false, reason: null, provisional: false }
            };
            if (activeCourseCache) {
                void Promise.resolve(activeCourseCache.write({ origin: courseCacheContext(), userId: courseCacheUserId(), courses: reconciled.courses })).catch(() => {});
            }
            cancelCardHydrationWatch();
            render();
        }
        function displayedCardsObserved() {
            const discovery = adapterApi?.discoverDashboardCourses || adapter?.discoverDashboardCourses;
            if (typeof discovery !== "function") return Boolean(doc.querySelector?.("#DashboardCard_Container .ic-DashboardCard, .ic-DashboardCard__box__container .ic-DashboardCard"));
            try {
                return discovery({ document: doc, location: win?.location, hiddenCourseIds: hiddenCardCourseIds() }).length > 0;
            } catch (error) { return false; }
        }
        // Watches for asynchronous dashboard-card hydration after an assembly
        // that found no displayed-card evidence at all. Mutation-driven when
        // the browser provides an observer, with a coarse bounded timer as the
        // floor; both paths stop the moment cards appear, the budget expires,
        // or the controller refreshes/disposes.
        function armCardHydrationWatch(pinnedCourses) {
            cancelCardHydrationWatch();
            if (!Array.isArray(pinnedCourses) || !pinnedCourses.length) return;
            const generation = refreshGeneration;
            const startedAt = Number(now()) || 0;
            const watch = { observer: null, timer: null, reconciling: false, budgetTimer: null };
            cardWatch = watch;
            const check = () => {
                if (cardWatch !== watch || generation !== refreshGeneration || paused) { cancelCardHydrationWatch(); return; }
                if (!displayedCardsObserved()) return;
                if (watch.reconciling) return;
                watch.reconciling = true;
                void reconcileDisplayedCards(pinnedCourses, generation).catch(() => {}).then(() => { watch.reconciling = false; });
            };
            const observe = typeof win?.MutationObserver === "function" ? win.MutationObserver : typeof MutationObserver === "function" ? MutationObserver : null;
            if (observe) {
                try {
                    watch.observer = new observe(() => check());
                    watch.observer.observe(doc.body || doc.documentElement, { childList: true, subtree: true });
                } catch (error) {
                    try { watch.observer?.disconnect?.(); } catch (innerError) {}
                    watch.observer = null;
                }
            }
            const tick = () => {
                if (cardWatch !== watch) return;
                check();
                if (cardWatch !== watch) return;
                const elapsed = (Number(now()) || 0) - startedAt;
                if (elapsed >= CARD_HYDRATION_BUDGET_MS) { cancelCardHydrationWatch(); return; }
                const schedule = typeof win?.setTimeout === "function" ? win.setTimeout.bind(win) : setTimeout;
                watch.timer = schedule(tick, CARD_HYDRATION_INTERVAL_MS);
            };
            if (cardWatch === watch) tick();
        }
        function reset() {
            cancelRefreshes();
            clearSnapshotTimer();
            cleanup.forEach((fn) => safeCall(fn, undefined));
            cleanup = [];
            try {
                restoreNative();
                removeOwnedNodes();
            } catch (error) {
                // Stop refreshing the heartbeat, but leave its session and
                // timestamp behind so the page-world watchdog can finish a
                // restoration that this controller could not complete.
                stopHeartbeat();
                return false;
            }
            clearHeartbeat();
            clearPrepaintRecord();
            nativeRoot = null;
            nativeLedger = null;
            recoveryOpen = false;
            showingHidden = false;
            return true;
        }
        function restoreAfterContextInvalidation() {
            try {
                restoreNative();
                removeOwnedNodes();
            } catch (error) {
                // The invalid isolated world cannot recover. Dispose its
                // publisher without clearing the last evidence so the
                // MAIN-world watchdog can restore after the stale grace.
                stopHeartbeat();
                return false;
            }
            cancelRefreshes();
            cleanup.forEach((fn) => safeCall(fn, undefined));
            cleanup = [];
            clearHeartbeat();
            clearPrepaintRecord();
            nativeRoot = null;
            nativeLedger = null;
            recoveryOpen = false;
            showingHidden = false;
            return true;
        }
        function widthFor(runtimeState) { if (runtimeState === "hidden") return 0; return runtimeState === "collapsed" ? normalized.widths.collapsed : normalized.widths.expanded; }
        function viewportWidth() { const value = Number(win?.innerWidth); return Number.isFinite(value) && value > 0 ? value : 1200; }
        function deriveState() {
            const preferredWidth = normalized.preferredState === "collapsed" ? normalized.widths.collapsed : normalized.widths.expanded;
            const available = viewportWidth() - preferredWidth;
            if (model?.deriveRuntimeState) return model.deriveRuntimeState({ enabled: normalized.enabled, preferredState: normalized.preferredState, availableWidth: available, currentState: normalized.runtimeState, expandedWidth: normalized.widths.expanded, collapsedWidth: normalized.widths.collapsed });
            if (!normalized.enabled) return "native"; if (normalized.runtimeState === "hidden" && available < 688) return "hidden"; if (available < 640) return "hidden"; return normalized.preferredState;
        }
        function setCanvasWidth(value) { setStyle(doc.documentElement, "--apstudy-sidebar-width", `${value}px`); }
        function safeHref(value) {
            if (typeof value !== "string" || !value.trim()) return null;
            const raw = value.trim();
            if (raw.startsWith("//") || raw.includes("#") || raw.toLowerCase().startsWith("javascript:")) return null;
            try {
                const base = win?.location?.href || `${win?.location?.origin || "https://canvas.emory.edu"}/`;
                const url = new URL(raw, base);
                if (!["https:", "http:"].includes(url.protocol)) return null;
                if (win?.location?.origin && url.origin !== win.location.origin) return null;
                return url.href === `${url.origin}/` && raw.startsWith("/") ? raw : url.href;
            } catch (error) { return null; }
        }
        function shouldShowSection(section, runtimeState) { const mode = runtimeState === "collapsed" ? "collapsed" : "expanded"; return normalized.sectionVisibility?.[mode]?.[section] !== false; }
        function resolvedCourseState() {
            const status = sidebarModel?.courseState?.status;
            if (["loading", "populated", "empty", "error"].includes(status)) return { status, retryable: sidebarModel.courseState.retryable === true, reason: sidebarModel.courseState.reason || null, provisional: sidebarModel.courseState.provisional === true };
            return { status: Array.isArray(sidebarModel?.courses) && sidebarModel.courses.length ? "populated" : "empty", retryable: false, reason: null, provisional: false };
        }
        function pageLabel(page) { const labels = state.sidebar_page_labels || state.sidebar_labels; return text(labels?.[page.id], text(page.label, page.id)); }
        function pageAction(page) {
            const action = typeof page?.action === "string" ? page.action : "";
            return ["planner", "notes", "grades", "study"].includes(action) ? action : null;
        }
        function isRenderablePage(page) { return page?.available !== false && Boolean(pageAction(page) || safeHref(page?.href)); }
        function dispatchPageAction(page) {
            const action = pageAction(page);
            if (!action || !doc?.dispatchEvent) return false;
            const detail = Object.freeze({ action, pageId: String(page.id), label: pageLabel(page) });
            let event;
            try { event = new (win?.CustomEvent || globalThis.CustomEvent)("apstudycanvas:sidebar-page-action", { detail }); }
            catch (error) { event = { type: "apstudycanvas:sidebar-page-action", detail }; }
            // The production event exposes `detail` through CustomEvent's
            // prototype. Make it enumerable on this instance too so the
            // lightweight DOM harness's event-copying seam sees the same
            // payload without changing browser behavior.
            try { Object.defineProperty(event, "detail", { value: detail, enumerable: true }); } catch (error) {}
            doc.dispatchEvent(event);
            return true;
        }
        function currentRouteForMatching() {
            const route = sidebarModel?.route;
            if (isPlainObject(route)
                && ((typeof route.pathname === "string" && route.pathname.startsWith("/"))
                    || (typeof route.href === "string" && route.href.trim()))) return route;
            return win?.location || {};
        }
        function routeIsActive(page) {
            if (pageAction(page)) return false;
            if (!page || page.available === false || !safeHref(page.href)) return false;
            const route = currentRouteForMatching();
            if (adapterApi?.routeMatches) return Boolean(safeCall(() => adapterApi.routeMatches(page, route), false));
            const pathname = typeof route?.pathname === "string" ? route.pathname.replace(/\/{2,}/g, "/").replace(/\/$/, "") || "/" : "";
            if (page?.id === "courses" && (pathname === "/courses" || /^\/courses\/[1-9]\d*(?:\/|$)/.test(pathname))) return true;
            return Boolean(page?.href && pathname === safeCall(() => new URL(page.href, win?.location?.href).pathname.replace(/\/{2,}/g, "/").replace(/\/$/, "") || "/", null));
        }
        function append(parent, child) { parent?.appendChild?.(child); return child; }
        function button(label, role, className) { const node = doc.createElement("button"); setAttr(node, "type", "button"); setAttr(node, "aria-label", label); if (className) setAttr(node, "class", className); if (role) append(node, makeIcon(doc, role)); return node; }
        function announce(message) {
            const live = customRoot?.querySelector?.(`.${NAMESPACE}-live`);
            if (live) live.textContent = message;
        }
        async function writeSyncChanges(changes) {
            if (typeof writeSettings === "function") return writeSettings(changes);
            if (typeof storageAdapter?.set === "function") return storageAdapter.set(changes, "sync");
            if (chromeApi?.storage?.sync?.set) return chromeApi.storage.sync.set(changes);
            throw new Error("Sidebar settings storage unavailable");
        }
        function commitSidebarChanges(changes, successMessage, { renderImmediately = true } = {}) {
            const previous = { ...state };
            state = Object.assign({}, state, changes);
            normalized = normalizeSettings(state);
            if (renderImmediately) render();
            void Promise.resolve().then(() => writeSyncChanges(changes)).then(() => announce(successMessage)).catch(() => {
                state = previous;
                normalized = normalizeSettings(state);
                render();
                announce("Could not save navigation changes");
            });
        }
        function defer(callback) {
            const schedule = win?.requestAnimationFrame || globalThis.requestAnimationFrame;
            if (typeof schedule === "function") schedule(callback);
            else Promise.resolve().then(callback);
        }
        // Removing `hidden` and setting the final state in one frame is often
        // coalesced by the browser. Two frames give the opening keyframe a
        // committed style without forcing synchronous layout.
        function deferOpeningFrame(callback) { defer(() => defer(callback)); }
        function clearDisclosureExit(id) {
            const timer = disclosureExitTimers.get(id);
            if (timer !== undefined) (win?.clearTimeout || globalThis.clearTimeout)?.(timer);
            disclosureExitTimers.delete(id);
        }
        // The content stays mounted during a close so CSS can explain where it
        // went. aria-hidden changes at once; hidden follows the short exit.
        function setDisclosure(panel, toggle, expanded, id, section = null, middle = null) {
            if (!panel || !toggle) return;
            clearDisclosureExit(id);
            setAttr(toggle, "aria-expanded", expanded ? "true" : "false");
            setAttr(panel, "aria-hidden", expanded ? "false" : "true");
            const setFolded = (folded) => {
                if (section) setAttr(section, "data-folded", folded ? "true" : "false");
                if (middle && section?.classList?.contains(`${NAMESPACE}-pages-section`)) setAttr(middle, "data-pages-folded", folded ? "true" : "false");
                if (middle && section?.classList?.contains(`${NAMESPACE}-courses-section`)) setAttr(middle, "data-courses-folded", folded ? "true" : "false");
            };
            if (expanded) {
                setFolded(false);
                if (section) setAttr(section, "data-motion", "opening");
                setAttr(panel, "hidden", null);
                setAttr(panel, "data-motion", "opening");
                deferOpeningFrame(() => {
                    if (!panel.parentNode) return;
                    setAttr(panel, "data-motion", "open");
                    if (section) setAttr(section, "data-motion", "open");
                });
                return;
            }
            if (section) setAttr(section, "data-motion", "closing");
            setAttr(panel, "data-motion", "closing");
            let stop = () => {};
            const finish = () => {
                clearDisclosureExit(id);
                stop();
                if (!panel.parentNode) return;
                setAttr(panel, "hidden", true);
                setAttr(panel, "data-motion", "closed");
                setFolded(true);
                if (section) setAttr(section, "data-motion", "closed");
            };
            stop = listen(panel, "transitionend", (event) => {
                if (event?.target === panel && event.propertyName === "opacity") finish();
            });
            const timer = (win?.setTimeout || globalThis.setTimeout)?.(finish, 180);
            if (timer !== undefined) disclosureExitTimers.set(id, timer);
        }
        // The header is the user's profile picture standing in for Canvas's own
        // Account button: clicking it opens the native account tray exactly as
        // the hidden global-nav control would. No product copy competes here.
        function buildIdentity(rootNode) {
            const identity = sidebarModel.identity || {};
            const name = text(identity.userName || identity.user?.name, "");
            const header = doc.createElement("header"); setAttr(header, "class", `${NAMESPACE}-identity`); setAttr(header, "data-brand", "nest");
            const avatar = button(name ? `Canvas account — ${name}` : "Canvas account", null, `${NAMESPACE}-identity-avatar`);
            const avatarUrl = identity.userAvatarUrl || identity.user?.avatarUrl;
            if (avatarUrl) { const image = doc.createElement("img"); setAttr(image, "src", avatarUrl); setAttr(image, "alt", ""); setAttr(image, "draggable", "false"); append(avatar, image); } else { const initial = doc.createElement("span"); setAttr(initial, "class", `${NAMESPACE}-avatar-initial`); initial.textContent = text((name || "C").slice(0, 1).toUpperCase(), "C"); append(avatar, initial); }
            if (normalized.tooltips !== false) setAttr(avatar, "title", name || "Canvas account");
            setAttr(avatar, "aria-haspopup", "dialog");
            listen(avatar, "click", openAccountTray);
            append(header, avatar); append(rootNode, header);
        }
        function openAccountTray() {
            const trigger = ACCOUNT_TRAY_SELECTORS
                .map((selector) => query(nativeRoot || doc, selector) || query(doc, selector))
                .find(Boolean);
            if (trigger) { safeCall(() => trigger.click(), undefined); announce("Canvas account menu opened"); return; }
            // The native nav has not hydrated (or is absent). Fall back to the
            // account page the native Account button itself links to.
            const fallback = safeHref("/profile/settings") || safeHref("/profile");
            if (fallback) { announce("Opening Canvas account settings"); safeCall(() => win?.location?.assign?.(fallback), undefined); return; }
            announce("Canvas account menu is unavailable");
        }
        function renderPageRow(page, hiddenBySetting, runtimeState, active = false) {
            const action = pageAction(page); const href = safeHref(page?.href); if (!isRenderablePage(page)) return null;
            const label = pageLabel(page); const link = doc.createElement(action ? "button" : "a"); setAttr(link, "class", `${NAMESPACE}-page-row${active ? ` ${NAMESPACE}-active` : ""}`); if (action) { setAttr(link, "type", "button"); setAttr(link, "data-page-action", action); listen(link, "click", () => { dispatchPageAction(page); }); } else setAttr(link, "href", href); setAttr(link, "data-page-id", page.id); setAttr(link, "aria-label", label); if (!action && active) setAttr(link, "aria-current", "page"); if (normalized.tooltips !== false) setAttr(link, "title", label); const iconBox = doc.createElement("span"); setAttr(iconBox, "class", `${NAMESPACE}-page-icon`); append(iconBox, makeIcon(doc, page.iconRole || "fallback")); append(link, iconBox);
            const labelNode = doc.createElement("span"); setAttr(labelNode, "class", `${NAMESPACE}-page-label`); labelNode.textContent = label; append(link, labelNode);
            if (action) { const brand = doc.createElement("span"); setAttr(brand, "class", `${NAMESPACE}-page-brand`); setAttr(brand, "aria-hidden", "true"); append(brand, makeIcon(doc, "apstudy-egg")); append(link, brand); }
            const count = page.unread ?? page.count; if (Number.isSafeInteger(count) && count > 0) { const badge = doc.createElement("span"); setAttr(badge, "class", `${NAMESPACE}-badge`); setAttr(badge, "aria-label", `${count} unread`); badge.textContent = String(count); append(link, badge); }
            const row = doc.createElement("li"); setAttr(row, "class", `${NAMESPACE}-page-item${hiddenBySetting ? ` ${NAMESPACE}-saved-hidden` : ""}`); if (hiddenBySetting && !showingHidden) setAttr(row, "hidden", true); append(row, link); if (runtimeState === "collapsed" && normalized.collapsedLabels === false) setAttr(labelNode, "aria-hidden", true); renderedPageLinks.push({ id: String(page.id), link }); return row;
        }
        function visibleOrderedPages() {
            const pages = Array.isArray(sidebarModel.pages) ? sidebarModel.pages : [];
            const order = Array.isArray(sidebarModel.pageOrder) && sidebarModel.pageOrder.length ? sidebarModel.pageOrder : normalized.pageOrder;
            const byId = new Map(pages.map((page) => [page.id, page]));
            const ordered = order.map((id) => byId.get(id)).filter(Boolean);
            pages.forEach((page) => { if (!ordered.includes(page)) ordered.push(page); });
            return ordered.filter(isRenderablePage);
        }
        function renderPages(parent, runtimeState) {
            if (!shouldShowSection("pages", runtimeState)) return; const section = doc.createElement("section"); setAttr(section, "class", `${NAMESPACE}-section ${NAMESPACE}-pages-section`); setAttr(section, "data-folded", normalized.sectionFolded.pages ? "true" : "false"); const sectionId = `${NAMESPACE}-pages`; const heading = button("Pages", "chevron", `${NAMESPACE}-section-toggle`); const headingLabel = doc.createElement("span"); setAttr(headingLabel, "class", `${NAMESPACE}-section-label`); headingLabel.textContent = "Pages"; append(heading, headingLabel); setAttr(heading, "id", `${sectionId}-toggle`); if (normalized.tooltips !== false) setAttr(heading, "title", "Pages"); setAttr(heading, "aria-expanded", normalized.sectionFolded.pages ? "false" : "true"); setAttr(heading, "aria-controls", sectionId);
            const list = doc.createElement("ul"); setAttr(list, "id", sectionId); setAttr(list, "class", `${NAMESPACE}-page-list`); setAttr(list, "aria-hidden", normalized.sectionFolded.pages ? "true" : "false"); setAttr(list, "data-motion", normalized.sectionFolded.pages ? "closed" : "open"); if (normalized.sectionFolded.pages) setAttr(list, "hidden", true);
            const visiblePages = visibleOrderedPages();
            const activePage = visiblePages.find((page) => routeIsActive(page)) || null;
            visiblePages.forEach((page) => { const row = renderPageRow(page, sidebarModel.pageVisibility?.[page.id] === false || normalized.pageVisibility?.[page.id] === false, runtimeState, page === activePage); if (row) append(list, row); });
            const hiddenAvailable = visiblePages.some((page) => sidebarModel.pageVisibility?.[page.id] === false || normalized.pageVisibility?.[page.id] === false);
            if (hiddenAvailable) { const item = doc.createElement("li"); const show = button(showingHidden ? "Hide hidden pages" : "Show hidden pages", null, `${NAMESPACE}-show-hidden`); show.textContent = showingHidden ? "Hide hidden" : "Show hidden"; setAttr(show, "aria-pressed", showingHidden ? "true" : "false"); listen(show, "click", () => { showingHidden = !showingHidden; render(); }); append(item, show); append(list, item); }
            listen(heading, "click", () => { const folded = !normalized.sectionFolded.pages; setDisclosure(list, heading, !folded, "pages", section, parent); commitSidebarChanges({ sidebar_pages_folded: folded }, folded ? "Pages collapsed" : "Pages expanded", { renderImmediately: false }); }); const head = doc.createElement("div"); setAttr(head, "class", `${NAMESPACE}-section-head`); append(head, heading); append(section, head); append(section, list); append(parent, section);
        }
        function renderCourses(parent, runtimeState) {
            if (!shouldShowSection("courses", runtimeState)) return;
            const state = resolvedCourseState();
            const section = doc.createElement("section"); setAttr(section, "class", `${NAMESPACE}-section ${NAMESPACE}-courses-section`); setAttr(section, "data-folded", normalized.sectionFolded.courses ? "true" : "false"); setAttr(section, "data-course-state", state.status);
            const sectionId = `${NAMESPACE}-courses`; const bodyId = `${sectionId}-body`; const listId = `${sectionId}-list`;
            const heading = button("Courses", "chevron", `${NAMESPACE}-section-toggle`); const headingLabel = doc.createElement("span"); setAttr(headingLabel, "class", `${NAMESPACE}-section-label`); headingLabel.textContent = "Courses"; append(heading, headingLabel); setAttr(heading, "id", `${sectionId}-toggle`); if (normalized.tooltips !== false) setAttr(heading, "title", "Courses"); setAttr(heading, "aria-expanded", normalized.sectionFolded.courses ? "false" : "true"); setAttr(heading, "aria-controls", bodyId);
            const body = doc.createElement("div"); setAttr(body, "id", bodyId); setAttr(body, "class", `${NAMESPACE}-course-body`); setAttr(body, "data-course-state", state.status); setAttr(body, "data-course-provisional", state.provisional ? "true" : null); setAttr(body, "aria-busy", state.status === "loading" ? "true" : "false"); setAttr(body, "aria-hidden", normalized.sectionFolded.courses ? "true" : "false"); setAttr(body, "data-motion", normalized.sectionFolded.courses ? "closed" : "open"); if (normalized.sectionFolded.courses) setAttr(body, "hidden", true);
            const list = doc.createElement("ul"); setAttr(list, "id", listId); setAttr(list, "class", `${NAMESPACE}-course-list`); if (state.status !== "populated") setAttr(list, "hidden", true);
            (state.status === "populated" && Array.isArray(sidebarModel.courses) ? sidebarModel.courses : []).forEach((course) => {
                const href = safeHref(course?.href); if (!href) return;
                const item = doc.createElement("li"); setAttr(item, "class", `${NAMESPACE}-course-item`);
                const row = doc.createElement("div"); setAttr(row, "class", `${NAMESPACE}-course-row`);
                const link = doc.createElement("a"); setAttr(link, "class", `${NAMESPACE}-course-link`); setAttr(link, "href", href); setAttr(link, "aria-label", text(course.name, "Course")); if (normalized.tooltips !== false) setAttr(link, "title", text(course.name, "Course"));
                const dot = doc.createElement("span"); setAttr(dot, "class", `${NAMESPACE}-course-dot`); if (course.color) setStyle(dot, "--apstudycanvas-course-color", course.color);
                const name = doc.createElement("span"); setAttr(name, "class", `${NAMESPACE}-course-name`); name.textContent = text(course.name, "Course"); append(link, dot); append(link, name); append(row, link);
                const panelId = `${NAMESPACE}-course-${String(course.id).replace(/[^A-Za-z0-9_-]/g, "-")}-tabs`;
                const disclosure = courseDisclosure.get(String(course.id)) || { open: false, status: "closed", tabs: [] };
                const toggleLabel = disclosure.open ? `Collapse ${text(course.name, "course")} navigation` : `Expand ${text(course.name, "course")} navigation`; const toggle = button(toggleLabel, "chevron", `${NAMESPACE}-course-toggle`); if (normalized.tooltips !== false) setAttr(toggle, "title", toggleLabel); setAttr(toggle, "aria-expanded", disclosure.open ? "true" : "false"); setAttr(toggle, "aria-controls", panelId);
                listen(toggle, "click", () => toggleCourseNavigation(course)); append(row, toggle); append(item, row);
                const panel = doc.createElement("ul"); setAttr(panel, "id", panelId); setAttr(panel, "class", `${NAMESPACE}-course-tabs`); setAttr(panel, "aria-hidden", disclosure.open ? "false" : "true"); setAttr(panel, "data-motion", disclosure.open ? (disclosure.motion || "open") : "closed"); if (!disclosure.open) setAttr(panel, "hidden", true); if (disclosure.status === "loading") { const loading = doc.createElement("li"); loading.textContent = "Loading course navigation…"; append(panel, loading); } else if (disclosure.status === "error") { const errorItem = doc.createElement("li"); const retry = button("Retry course navigation", null, `${NAMESPACE}-course-retry`); retry.textContent = "Try again"; listen(retry, "click", () => toggleCourseNavigation(course, true)); append(errorItem, retry); append(panel, errorItem); } else if (disclosure.status === "ready" && disclosure.tabs.length) disclosure.tabs.forEach((tab) => { const tabHref = safeHref(tab.href); if (!tabHref) return; const tabItem = doc.createElement("li"); const tabLink = doc.createElement("a"); setAttr(tabLink, "href", tabHref); setAttr(tabLink, "class", `${NAMESPACE}-course-tab`); tabLink.textContent = text(tab.label, "Course page"); append(tabItem, tabLink); append(panel, tabItem); }); else if (disclosure.status === "ready") { const empty = doc.createElement("li"); empty.textContent = "No course navigation available"; append(panel, empty); } append(item, panel); if (disclosure.motion === "opening") deferOpeningFrame(() => { if (panel.parentNode) { setAttr(panel, "data-motion", "open"); const next = courseDisclosure.get(String(course.id)); if (next?.open) courseDisclosure.set(String(course.id), { ...next, motion: "open" }); } });
                append(list, item);
            });
            // The status row is the first grid child so loading, error, and
            // stale-cache notices lead the section instead of hiding at the
            // bottom of a short viewport. The list occupies the second row.
            if (state.status !== "populated" || (state.retryable && state.reason)) {
                const status = doc.createElement("div"); setAttr(status, "class", `${NAMESPACE}-course-status ${NAMESPACE}-course-status-${state.status}`); setAttr(status, "role", state.status === "error" ? "alert" : "status"); if (state.status === "populated") setAttr(status, "data-apstudycanvas-stale", "true");
                const message = doc.createElement("span"); setAttr(message, "class", `${NAMESPACE}-course-status-message`); message.textContent = state.status === "loading" ? "Loading courses…" : state.status === "error" ? "Courses could not be loaded." : state.status === "populated" ? "Course list may be out of date." : "No active courses."; append(status, message);
                if (state.retryable) { const retry = button("Retry loading courses", null, `${NAMESPACE}-course-retry`); retry.textContent = "Try again"; listen(retry, "click", () => { void refresh(); }); append(status, retry); }
                append(body, status);
            }
            append(body, list);
            listen(heading, "click", () => { const folded = !normalized.sectionFolded.courses; setDisclosure(body, heading, !folded, "courses", section, parent); commitSidebarChanges({ sidebar_courses_folded: folded }, folded ? "Courses collapsed" : "Courses expanded", { renderImmediately: false }); }); const head = doc.createElement("div"); setAttr(head, "class", `${NAMESPACE}-section-head`); append(head, heading); const gear = button("Customize course order in Control Center", "settings", `${NAMESPACE}-section-gear`); if (normalized.tooltips !== false) setAttr(gear, "title", "Customize courses"); listen(gear, "click", openControlCenter); append(head, gear); append(section, head); append(section, body); append(parent, section);
        }
        function openControlCenter() { const event = typeof CustomEvent === "function" ? new CustomEvent("apstudycanvas:open-control-center", { bubbles: true }) : { type: "apstudycanvas:open-control-center", bubbles: true }; doc.dispatchEvent?.(event); announce("APStudyCanvas settings opened"); }
        function currentAccountToken() {
            return accountTokenFor(sidebarModel);
        }
        function accountTokenFor(value) {
            const account = value?.account || {};
            const identity = value?.identity || {};
            return [account.accountKey || identity.accountKey || "", account.origin || identity.origin || win?.location?.origin || "", account.userId || identity.userId || ""].join("|");
        }
        function courseStillOwned(id, generation, accountToken, abortController) {
            const current = courseDisclosure.get(id);
            return Boolean(customRoot
                && isConnected(customRoot)
                && doc.getElementById?.(ROOT_ID) === customRoot
                && current?.open
                && current.generation === generation
                && current.abortController === abortController
                && !abortController?.signal?.aborted
                && currentAccountToken() === accountToken
                && (sidebarModel.courses || []).some((course) => String(course?.id || "") === id));
        }
        async function toggleCourseNavigation(course, retry = false) {
            const id = String(course?.id || ""); if (!id) return;
            const current = courseDisclosure.get(id) || { open: false, status: "closed", tabs: [] };
            if (current.open && !retry) {
                current.abortController?.abort?.();
                courseDisclosure.set(id, { open: false, status: "closed", tabs: [], generation: ++courseNavigationGeneration, abortController: null });
                const panelId = `${NAMESPACE}-course-${id.replace(/[^A-Za-z0-9_-]/g, "-")}-tabs`;
                const panel = findById(doc, panelId);
                const toggle = customRoot?.querySelector?.(`.${NAMESPACE}-course-toggle[aria-controls="${panelId}"]`);
                setDisclosure(panel, toggle, false, `course:${id}`);
                flushSnapshotRecord();
                return;
            }
            current.abortController?.abort?.();
            const generation = ++courseNavigationGeneration;
            const abortController = typeof AbortController === "function" ? new AbortController() : null;
            const accountToken = currentAccountToken();
            courseDisclosure.set(id, { open: true, status: "loading", tabs: [], generation, abortController, motion: "opening" }); render(); flushSnapshotRecord(); announce(`Loading ${text(course.name, "course")} navigation`);
            const loader = adapter?.getCourseNavigation || adapterApi?.getCourseNavigation;
            try {
                const result = typeof loader === "function" ? await loader.call(adapter || adapterApi, { course, origin: sidebarModel?.account?.origin || sidebarModel?.identity?.origin, signal: abortController?.signal }) : { tabs: [] };
                if (!courseStillOwned(id, generation, accountToken, abortController)) return;
                courseDisclosure.set(id, { open: true, status: "ready", tabs: Array.isArray(result?.tabs) ? result.tabs : [], generation, abortController: null }); render(); flushSnapshotRecord(); announce(result?.tabs?.length ? `${text(course.name, "Course")} navigation loaded` : "No course navigation available");
            } catch (error) {
                if (error?.name === "AbortError" || !courseStillOwned(id, generation, accountToken, abortController)) return;
                courseDisclosure.set(id, { open: true, status: "error", tabs: [], generation, abortController: null }); render(); flushSnapshotRecord(); announce("Course navigation could not be loaded");
            }
        }
        function dismissRecovery({ restoreFocus = true } = {}) { if (!recoveryOpen) return; recoveryOpen = false; render(); if (restoreFocus) focus(recovery); }
        function toggleRecovery() { recoveryOpen = !recoveryOpen; render(); if (recoveryOpen) focus(customRoot?.querySelector?.(`.${NAMESPACE}-page-row`)); }
        function buildFooter(rootNode, runtimeState) {
            const footer = doc.createElement("footer"); setAttr(footer, "class", `${NAMESPACE}-footer`);
            if (normalized.productEntryVisible !== false) { const settings = button("Open APStudyCanvas settings", "settings", `${NAMESPACE}-footer-action ${NAMESPACE}-product-entry`); const settingsLabel = doc.createElement("span"); setAttr(settingsLabel, "class", `${NAMESPACE}-footer-label`); settingsLabel.textContent = "APStudyCanvas"; append(settings, settingsLabel); if (normalized.tooltips !== false) setAttr(settings, "title", "Open APStudyCanvas settings"); listen(settings, "click", openControlCenter); append(footer, settings); }
            const toggleLabel = runtimeState === "collapsed" ? "Expand navigation" : "Collapse navigation"; const toggle = button(toggleLabel, "chevron", `${NAMESPACE}-footer-action ${NAMESPACE}-collapse-toggle`); if (normalized.tooltips !== false) setAttr(toggle, "title", toggleLabel); setAttr(toggle, "aria-expanded", runtimeState === "expanded" ? "true" : "false"); listen(toggle, "click", () => { const preferredState = runtimeState === "collapsed" ? "expanded" : "collapsed"; commitSidebarChanges({ sidebar_preferred_state: preferredState }, preferredState === "expanded" ? "Navigation expanded" : "Navigation collapsed"); }); append(footer, toggle); append(rootNode, footer);
        }
        function buildLocalModel() {
            const pages = DEFAULT_ORDER.map((id) => { const node = nativeItem(id); return { id, label: text(node?.textContent, LABELS[id]), href: attr(node, "href"), iconRole: id, available: Boolean(attr(node, "href")), source: "canvas", known: true }; });
            return { identity: {}, route: {}, pages, pageOrder: normalized.pageOrder, pageVisibility: normalized.pageVisibility, courses: [], courseOrder: [], courseState: { status: "loading", retryable: false, reason: null } };
        }
        function ensureRecovery() {
            const host = doc.body || doc.documentElement || nativeRoot?.parentNode;
            if (recovery && recovery.parentNode === host) return recovery;
            if (recovery && recovery.parentNode !== host) recovery = null;
            if (!recovery) { recovery = button("Show navigation", null, `${NAMESPACE}-recovery`); setAttr(recovery, "id", RECOVERY_ID); setAttr(recovery, MARKER, "1"); setAttr(recovery, "aria-controls", ROOT_ID); setAttr(recovery, "aria-expanded", recoveryOpen ? "true" : "false"); append(recovery, makeIcon(doc, "dashboard")); listen(recovery, "click", toggleRecovery); }
            host?.appendChild?.(recovery); return recovery;
        }
        function render() {
            if (!customRoot || paused || !normalized.enabled) return; const runtimeState = deriveState(); normalized.runtimeState = runtimeState; const hidden = runtimeState === "hidden"; const overlay = hidden && recoveryOpen; const width = overlay ? Math.max(0, Math.min(widthFor(normalized.preferredState), viewportWidth() - 16)) : widthFor(runtimeState);
            setAttr(customRoot, "data-apstudycanvas-sidebar-state", runtimeState); setAttr(customRoot, "data-apstudycanvas-sidebar-runtime-state", runtimeState); setAttr(customRoot, "data-apstudycanvas-sidebar-overlay", overlay ? "true" : null); setAttr(customRoot, "data-apstudycanvas-sidebar-density", normalized.density); setAttr(customRoot, "data-apstudycanvas-sidebar-scale", normalized.scale); toggleClass(customRoot, `${NAMESPACE}-expanded`, runtimeState === "expanded" || (overlay && normalized.preferredState === "expanded")); toggleClass(customRoot, `${NAMESPACE}-collapsed`, runtimeState === "collapsed" || (overlay && normalized.preferredState === "collapsed")); toggleClass(customRoot, `${NAMESPACE}-hidden`, hidden && !overlay); toggleClass(customRoot, `${NAMESPACE}-overlay`, overlay); setStyle(customRoot, "--apstudy-sidebar-width", `${width}px`); const iconSize = Number.isFinite(Number(state.sidebar_icon_size)) ? Math.round(Number(state.sidebar_icon_size)) : normalized.scaleValues?.icon || 16; const labelSize = Number.isFinite(Number(state.sidebar_label_size)) ? Math.round(Number(state.sidebar_label_size)) : normalized.scaleValues?.label || 14;             setStyle(customRoot, "--apstudy-sidebar-icon-size", `${iconSize}px`); setStyle(customRoot, "--apstudy-sidebar-label-size", `${labelSize}px`); const avatarSize = AVATAR_SIZE_PX[normalized.avatarSize] || AVATAR_SIZE_PX.medium; setStyle(customRoot, "--apstudy-sidebar-avatar-size", `${avatarSize}px`); setStyle(customRoot, "--apstudy-sidebar-row-gap", normalized.density === "compact" ? "2px" : "6px"); setCanvasWidth(hidden ? 0 : width); persistPrepaintRecord(hidden ? 0 : width, runtimeState);
            renderedPageLinks = []; while (customRoot.firstChild) customRoot.removeChild?.(customRoot.firstChild); buildIdentity(customRoot); const middle = doc.createElement("div"); const displayState = overlay ? normalized.preferredState : runtimeState; const pagesVisible = shouldShowSection("pages", displayState); const coursesVisible = shouldShowSection("courses", displayState); setAttr(middle, "class", `${NAMESPACE}-middle`); setAttr(middle, "data-pages-visible", pagesVisible ? "true" : "false"); setAttr(middle, "data-courses-visible", coursesVisible ? "true" : "false"); setAttr(middle, "data-pages-folded", normalized.sectionFolded.pages ? "true" : "false"); setAttr(middle, "data-courses-folded", normalized.sectionFolded.courses ? "true" : "false"); renderPages(middle, displayState); renderCourses(middle, displayState); append(customRoot, middle); buildFooter(customRoot, displayState);
            if (!hidden) { const edgePreferredState = displayState === "collapsed" ? "expanded" : "collapsed"; const edge = button(`${edgePreferredState === "collapsed" ? "Collapse" : "Expand"} Sidebar edge control`, null, `${NAMESPACE}-edge`); setAttr(edge, "aria-hidden", "true"); setAttr(edge, "tabindex", "-1"); listen(edge, "click", () => { commitSidebarChanges({ sidebar_preferred_state: edgePreferredState }, edgePreferredState === "expanded" ? "Navigation expanded" : "Navigation collapsed"); }); append(customRoot, edge); }
            if (hidden && !recoveryOpen) ensureRecovery(); else if (recovery) { recovery.remove?.(); recovery = null; }
            const live = doc.createElement("span"); setAttr(live, "class", `${NAMESPACE}-live`); setAttr(live, "aria-live", "polite"); setAttr(live, "aria-atomic", "true"); append(customRoot, live);
            markLayoutOwnership();
            if (nativeRoot) { setAttr(nativeRoot, MARKER, "1"); toggleClass(nativeRoot, NAMESPACE, true); toggleClass(nativeRoot, `${NAMESPACE}-hidden`, true); }
            // The revision stamp and the row registry move together: a diff
            // that finds a matching stamp can surgically update active
            // markers because this render just rebuilt both.
            renderedRevision += 1;
            setAttr(customRoot, REVISION_ATTRIBUTE, String(renderedRevision));
            persistSnapshotRecord();
            // The To-Do rail subscribes to model convergence here: render() is
            // the single point where the controller has accepted new courses
            // (provisional or final), so it is the safe place to notify. The
            // callback must stay cheap — the rail dedupes by course signature.
            if (typeof onModelChange === "function") safeCall(() => onModelChange(sidebarModel), undefined);
        }
        async function loadCourseOrder(identity) {
            const accountKey = typeof identity === "string" ? identity : identity?.accountKey;
            const key = model?.courseOrderStorageKey?.(accountKey); if (!key) return null;
            if (typeof readCourseOrder === "function") return await safeCall(() => readCourseOrder(key), null);
            if (typeof storageAdapter?.get === "function") return await safeCall(() => storageAdapter.get(key, "local"), null);
            if (chromeApi?.storage?.local?.get) { try { const result = await chromeApi.storage.local.get(key); return result?.[key] || null; } catch (error) { return null; } }
            return null;
        }
        function courseCacheContext() {
            const origin = sidebarModel?.account?.origin || sidebarModel?.identity?.origin || win?.location?.origin || "";
            return String(origin || "");
        }
        function courseCacheUserId() {
            return sidebarModel?.account?.userId ?? sidebarModel?.identity?.userId ?? null;
        }
        function timeoutError() {
            const error = new Error("Sidebar refresh timed out");
            error.name = "TimeoutError";
            error.code = "SIDEBAR_REFRESH_TIMEOUT";
            return error;
        }
        async function refresh() {
            if (!normalized.enabled || !adapterApi) return sidebarModel;
            recoveryOpen = false;
            const generation = ++refreshGeneration;
            refreshAbortController?.abort?.();
            // Abort in-flight course navigation loads but keep settled ones:
            // the mount refresh runs right after a snapshot render restored
            // open disclosures, and wiped entries would collapse them between
            // the provisional and the revalidated render. Stale entries whose
            // course vanished are never rendered and never match
            // courseStillOwned, so keeping them is harmless.
            cancelCourseNavigationLoads({ clear: false });
            cancelCardHydrationWatch();
            const abortController = typeof AbortController === "function" ? new AbortController() : null;
            refreshAbortController = abortController;
            const source = adapter?.assemble ? adapter : adapterApi;
            // The raw active-enrollment list behind the displayed-card filter.
            // If card hydration is still pending, the bounded watch re-uses
            // this list instead of refetching Canvas.
            let hydrationCourses = null;
            const hasCurrentCourseData = ["populated", "empty"].includes(resolvedCourseState().status);
            if (!hasCurrentCourseData) {
                sidebarModel = { ...sidebarModel, courseState: { status: "loading", retryable: false, reason: null, provisional: false } };
                render();
            }
            try {
                const renderCourses = (result) => {
                    if (generation !== refreshGeneration || abortController?.signal?.aborted || !Array.isArray(result?.courses)) return;
                    const reconciled = model?.reconcileSidebarCourses
                        ? model.reconcileSidebarCourses({ courses: result.courses, savedOrder: sidebarModel.courseOrder })
                        : { courses: result.courses, order: result.courses.map((course) => course.id) };
                    sidebarModel = {
                        ...sidebarModel,
                        courses: reconciled.courses,
                        courseOrder: reconciled.order,
                        courseState: {
                            status: result.status || (reconciled.courses.length ? "populated" : "empty"),
                            retryable: result.retryable === true,
                            reason: result.reason || null,
                            provisional: result.provisional === true
                        }
                    };
                    render();
                };
                // Stale-while-revalidate: publish the last-known course list for
                // this Canvas origin before the network answers. A fresh entry
                // renders indistinguishably from a live one; a stale entry is
                // replaced the moment the authoritative fetch lands.
                let liveCoursesPublished = false;
                const publishCourses = (result) => {
                    if (Array.isArray(result?.courses) && result.courses.length) hydrationCourses = result.courses.slice();
                    if (result?.provisional !== true) liveCoursesPublished = true;
                    renderCourses(result);
                };
                // Start assembly before an optional adapter identity probe. The
                // production adapter resolves identity inside assembly, where
                // course discovery runs in parallel; adapters that declare
                // `identityWithinAssembly` are never probed, because that probe
                // would duplicate the identity request on every refresh. Other
                // custom adapters can still clear a previous account's courses
                // as soon as they identify an account change.
                const assembly = source.assemble({
                    document: doc,
                    location: win?.location,
                    savedOrder: normalized.pageOrder,
                    savedVisibility: normalized.pageVisibility,
                    signal: abortController?.signal,
                    // Authoritative displayed-card evidence: the adapter reads
                    // the last observed dashboard card set when the current
                    // page renders none, and persists a fresh observation.
                    displayedCardStore: displayedCardStore,
                    hiddenCardCourseIds: hiddenCardCourseIds(),
                    // The production adapter calls this after each verified
                    // course page, so the rail becomes useful before slow
                    // identity/unread requests or later pagination complete.
                    onCourses: publishCourses
                });
                if (!hasCurrentCourseData && activeCourseCache) {
                    void Promise.resolve(activeCourseCache.read({ origin: courseCacheContext(), userId: courseCacheUserId() }))
                        .then((cached) => {
                            if (generation !== refreshGeneration || abortController?.signal?.aborted || liveCoursesPublished) return;
                            if (Array.isArray(cached?.courses) && cached.courses.length) {
                                renderCourses({ status: "populated", retryable: false, reason: cached.stale ? "stale-cache" : null, provisional: true, courses: cached.courses });
                            }
                        })
                        .catch(() => {});
                }
                // The account probe below may fail before this in-flight
                // assembly is awaited. Observe its rejection now so a slow
                // custom adapter never creates an unhandled rejection.
                void Promise.resolve(assembly).catch(() => {});
                if (adapter?.assemble && typeof source?.resolveIdentity === "function" && source.identityWithinAssembly !== true) {
                    const identityProbe = await source.resolveIdentity({
                        document: doc,
                        location: win?.location,
                        signal: abortController?.signal
                    });
                    if (generation !== refreshGeneration || abortController?.signal?.aborted) return sidebarModel;
                    if (!isPlainObject(identityProbe) || !isPlainObject(identityProbe.account)) throw new Error("Canvas identity is invalid");
                    if (accountTokenFor(identityProbe) !== currentAccountToken()) {
                        sidebarModel = {
                            ...sidebarModel,
                            identity: identityProbe.identity || {},
                            account: identityProbe.account,
                            courses: [],
                            courseOrder: [],
                            courseState: { status: "loading", retryable: false, reason: null, provisional: false }
                        };
                        render();
                    }
                }
                // A hung Canvas request must end in a retryable state, never in
                // an infinite spinner. The race rejects while the assembly keeps
                // running; its late `onCourses` callbacks are dropped by the
                // generation/abort guards above.
                let timeoutHandle = null;
                const clearTimeoutHandle = () => {
                    if (timeoutHandle === null) return;
                    (typeof win?.clearTimeout === "function" ? win.clearTimeout : clearTimeout)(timeoutHandle);
                    timeoutHandle = null;
                };
                const timeoutPromise = typeof win?.setTimeout === "function" || typeof setTimeout === "function"
                    ? new Promise((resolve, reject) => {
                        const schedule = typeof win?.setTimeout === "function" ? win.setTimeout.bind(win) : setTimeout;
                        timeoutHandle = schedule(() => reject(timeoutError()), refreshTimeout);
                        if (typeof timeoutHandle?.unref === "function") timeoutHandle.unref();
                    })
                    : null;
                // A timeout promise that loses the race must still be observed,
                // or the late rejection surfaces as an unhandled rejection.
                timeoutPromise?.catch?.(() => {});
                const next = await (timeoutPromise ? Promise.race([assembly, timeoutPromise]) : assembly);
                liveCoursesPublished = true;
                clearTimeoutHandle();
                if (generation !== refreshGeneration || abortController?.signal?.aborted) return sidebarModel;
                if (!isPlainObject(next) || !Array.isArray(next.pages) || !Array.isArray(next.courses)) throw new Error("Sidebar model is invalid");
                const identity = next?.account?.accountKey || next?.identity?.accountKey || null; const saved = await loadCourseOrder(identity);
                if (generation !== refreshGeneration || abortController?.signal?.aborted) return sidebarModel;
                if (Array.isArray(saved) && model?.reconcileSidebarCourses) { const reconciled = model.reconcileSidebarCourses({ courses: next?.courses, savedOrder: saved }); next.courses = reconciled.courses; next.courseOrder = reconciled.order; }
                if (generation !== refreshGeneration || abortController?.signal?.aborted) return sidebarModel;
                sidebarModel = next || sidebarModel;
                if (activeCourseCache && next?.courseState?.status === "populated" && Array.isArray(next.courses)) {
                    void activeCourseCache.write({ origin: courseCacheContext(), userId: courseCacheUserId(), courses: next.courses });
                }
                // Hydration convergence: when assembly found no displayed-card
                // evidence at all on a populated dashboard, the card DOM may
                // simply not be painted yet. Watch bounded for the cards and
                // narrow to the authoritative displayed set without refetching.
                if (next?.displayedCardsPending === true && Array.isArray(hydrationCourses) && hydrationCourses.length) {
                    armCardHydrationWatch(hydrationCourses);
                } else {
                    cancelCardHydrationWatch();
                }
            } catch (error) {
                // Superseded or aborted refreshes must stay silent; a genuine
                // timeout ends in a retryable state with any cached courses
                // kept on screen instead of an endless loading row. Structural
                // adapter failures still tear the rail down and restore native
                // navigation, matching the documented failure contract.
                if (generation !== refreshGeneration) return sidebarModel;
                if (error?.name === "TimeoutError") {
                    if (abortController?.signal?.aborted) return sidebarModel;
                    const current = resolvedCourseState();
                    sidebarModel = {
                        ...sidebarModel,
                        courseState: current.status === "populated"
                            ? { status: "populated", retryable: true, reason: "timeout", provisional: true }
                            : { status: "error", retryable: true, reason: "timeout", provisional: false }
                    };
                    console.info("[APStudyCanvas] sidebar courses timed out — retry available");
                    render();
                    return sidebarModel;
                }
                if (abortController?.signal?.aborted) return sidebarModel;
                reset();
                return sidebarModel;
            } finally {
                if (refreshAbortController === abortController) refreshAbortController = null;
            }
            const courseState = resolvedCourseState();
            if (courseState.status === "populated") console.info(`[APStudyCanvas] sidebar courses: ${sidebarModel.courses?.length ?? 0} loaded (${sidebarModel.route?.kind ?? "unknown-route"})`);
            else console.info(`[APStudyCanvas] sidebar courses ${courseState.status}${courseState.reason ? ` (${courseState.reason})` : ""} — retryable: ${courseState.retryable}`);
            render(); return sidebarModel;
        }
        // Surgical route update: the route only changes which page row is the
        // active destination, so when the rail DOM provably matches the model
        // revision, toggle the active markers on the existing rows in place.
        // Rebuilding would flicker the rail and discard scroll position,
        // focus, and open course disclosures on every SPA navigation.
        function diffActivePageRows() {
            if (!customRoot || !isConnected(customRoot)) return false;
            if (!renderedRevision || attr(customRoot, REVISION_ATTRIBUTE) !== String(renderedRevision)) return false;
            const links = Array.isArray(renderedPageLinks) ? renderedPageLinks : [];
            if (!links.length) return false;
            const visiblePages = visibleOrderedPages();
            if (!visiblePages.length) return false;
            const visibleIds = new Set(visiblePages.map((page) => String(page.id)));
            if (!links.every((entry) => entry?.link && isConnected(entry.link) && visibleIds.has(entry.id))) return false;
            const activePage = visiblePages.find((page) => routeIsActive(page)) || null;
            links.forEach((entry) => {
                const isActive = Boolean(activePage) && entry.id === String(activePage.id);
                toggleClass(entry.link, `${NAMESPACE}-active`, isActive);
                if (isActive) setAttr(entry.link, "aria-current", "page");
                else if (attr(entry.link, "aria-current") !== null) setAttr(entry.link, "aria-current", null);
            });
            renderedRevision += 1;
            setAttr(customRoot, REVISION_ATTRIBUTE, String(renderedRevision));
            return true;
        }
        function notifyRoute() {
            if (!customRoot || paused || !normalized.enabled) return false;
            sidebarModel = { ...sidebarModel, route: parseCurrentRoute() };
            if (diffActivePageRows()) return true;
            render();
            return true;
        }
        function onStorageChanged(changes, areaName) { if (areaName && areaName !== "sync") return; const updates = {}; Object.keys(changes || {}).forEach((key) => { if (SIDEBAR_LIVE_SETTING_KEYS.includes(key) || SIDEBAR_LEGACY_LIVE_SETTING_KEYS.includes(key)) updates[key] = changes[key]?.newValue; }); if (Object.keys(updates).length) apply(updates); }
        function bindGlobalListeners() {
            cleanup.push(listen(win, "resize", () => { const before = normalized.runtimeState; const next = deriveState(); if (before === "hidden" && next !== "hidden") { recoveryOpen = false; } render(); }));
            // Hard navigations leave before the debounced snapshot timer can
            // fire; the pagehide flush is what makes the next document's
            // hydration reflect this one's final state.
            cleanup.push(listen(doc, "pagehide", () => flushSnapshotRecord()));
            cleanup.push(listen(doc, "keydown", (event) => { if (event?.key === "Escape" && recoveryOpen) { event.preventDefault?.(); dismissRecovery(); } })); cleanup.push(listen(doc, "click", (event) => { markLayoutOwnership(); if (recoveryOpen && customRoot && !customRoot.contains?.(event?.target)) dismissRecovery(); }, true));
        }
        function reconcileCustomRoot() {
            if (!customRoot) return true;
            const mountedRoot = findById(doc, ROOT_ID);
            if (isConnected(customRoot) && mountedRoot === customRoot && attr(customRoot, MARKER) === "1") return true;
            cancelCourseNavigationLoads({ clear: false });
            cleanup.forEach((fn) => safeCall(fn, undefined));
            cleanup = [];
            [customRoot, mountedRoot].forEach((node, index, nodes) => {
                if (node && nodes.indexOf(node) === index && attr(node, MARKER) === "1") node.remove?.();
            });
            if (attr(recovery, MARKER) === "1") recovery?.remove?.();
            customRoot = null;
            recovery = null;
            recoveryOpen = false;
            return !findById(doc, ROOT_ID);
        }
        // The lifecycle's first refresh fires before Canvas mounts its native
        // nav, and mutation-driven applies intentionally never fetch (they would
        // feed the page observer their own output). The handoff that actually
        // starts course loading is therefore the first successful mount after
        // the nav exists: exactly one refresh, no user interaction, and no
        // refetch on later mutation remounts.
        function scheduleMountRefresh() {
            if (mountRefreshDone || paused || !pendingMountRefresh || !adapter?.assemble) return;
            mountRefreshDone = true;
            pendingMountRefresh = false;
            void Promise.resolve().then(() => {
                if (paused || !normalized.enabled || !customRoot || !isConnected(customRoot)) return;
                void refresh();
            });
        }
        function apply(settings = {}) {
            const nextRoot = findNativeRoot(); if (nextRoot !== nativeRoot) { if (!reset()) return false; nativeRoot = nextRoot; } state = Object.assign({}, state, Object.fromEntries(Object.entries(settings || {}).filter(([, value]) => value !== undefined))); normalized = normalizeSettings(state);
            if (!normalized.enabled) return reset(); if (!nativeRoot) return false;
            if (!reconcileCustomRoot()) return false;
            try { captureNative(); stampNavLayerZ(); if (!customRoot) { customRoot = doc.createElement("aside"); setAttr(customRoot, "id", ROOT_ID); setAttr(customRoot, "role", "navigation"); setAttr(customRoot, "aria-label", "APStudyCanvas navigation"); setAttr(customRoot, "class", NAMESPACE); setAttr(customRoot, MARKER, "1"); setStyle(customRoot, "display", "none"); const parent = nativeRoot.parentNode || doc.body || doc.documentElement; parent?.insertBefore?.(customRoot, nativeRoot); if (!customRoot.parentNode) parent?.appendChild?.(customRoot); if (!sidebarModel.pages?.length && !adoptSnapshotRecord()) sidebarModel = buildLocalModel(); bindGlobalListeners(); scheduleMountRefresh(); } render(); startHeartbeat(); return true; } catch (error) { reset(); return false; }
        }
        function init(settings = {}) { if (initialized) { apply(settings); return api; } pendingMountRefresh = !findNativeRoot(); initialized = true; if (listenStorage && chromeApi?.storage?.onChanged?.addListener) chromeApi.storage.onChanged.addListener(onStorageChanged); apply(settings); return api; }
        function pause() { paused = true; stopHeartbeat(); }
        function resume(settings = {}) { paused = false; apply(settings); }
        function needsRefresh(settings = state) { return requestedEnabled(settings) && (!nativeRoot || !customRoot || !findById(doc, ROOT_ID)); }
        function dispose() { if (listenStorage) chromeApi?.storage?.onChanged?.removeListener?.(onStorageChanged); cleanup.forEach((fn) => safeCall(fn, undefined)); cleanup = []; reset(); state = {}; normalized = normalizeSettings({}); initialized = false; paused = false; mountRefreshDone = false; pendingMountRefresh = false; if (registry.get(doc) === api) registry.delete(doc); if (doc[CONTROLLER_SLOT] === api) { try { delete doc[CONTROLLER_SLOT]; } catch (error) { doc[CONTROLLER_SLOT] = null; } } }
        api = Object.freeze({ init, apply, refresh, notifyRoute, reset, pause, resume, dispose, onStorageChanged, needsRefresh, isInitialized: () => initialized, isPaused: () => paused, handlesStorageChanges: listenStorage, isMountRefreshDone: () => mountRefreshDone, getModel: () => sidebarModel, getState: () => ({ ...normalized, runtimeState: normalized.runtimeState || deriveState(), recoveryOpen }), constants: Object.freeze({ NAMESPACE, ROOT_ID, RECOVERY_ID, MARKER, DEFAULT_ORDER, DEFAULT_VISIBILITY }) });
        registry.set(doc, api); try { doc[CONTROLLER_SLOT] = api; } catch (error) {}
        return api;
    }
    return Object.freeze({ NAMESPACE, ROOT_ID, RECOVERY_ID, MARKER, PREPAINT_STORAGE_KEY, PREPAINT_ATTRIBUTE, SNAPSHOT_STORAGE_KEY, SNAPSHOT_RECORD_VERSION, SNAPSHOT_TTL_MS, DEFAULT_ORDER, DEFAULT_VISIBILITY, SIDEBAR_LIVE_SETTING_KEYS, SIDEBAR_LEGACY_LIVE_SETTING_KEYS, SIDEBAR_NUMERIC_RANGES, SIDEBAR_VALIDATABLE_KEYS, normalizeOrder, validateSidebarChange, validateSettingsUpdateRequest, createSidebarController });
}));
