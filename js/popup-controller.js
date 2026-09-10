(function (root, factory) {
    "use strict";

    const api = factory(root);
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasPopupController = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
    "use strict";

    const settingsSchemaApi = root?.APStudyCanvasSchema || (typeof require === "function" ? require("./settings-schema.js") : null);

    const CATEGORIES = Object.freeze([
        "overview", "appearance", "sidebar", "course-cards", "study-tools",
        "themes", "gpa-grades", "canvas-search", "calendar-accounts", "data-support"
    ]);
    const CATEGORY_LABELS = Object.freeze({
        overview: "Overview",
        appearance: "Appearance",
        sidebar: "Sidebar",
        "course-cards": "Course Cards",
        "study-tools": "Study Tools",
        themes: "Themes",
        "gpa-grades": "GPA & Grades",
        "canvas-search": "Canvas Search",
        "calendar-accounts": "Calendar & Accounts",
        "data-support": "Data & Support"
    });
    const ONBOARDING_KEY = "nest_onboarding_dismissed";
    const FULLSCREEN_URL = "https://nest.apstudy.org/extension/connect";
    const connectionApi = root?.APStudyCanvasPlatform?.ConnectionCoordinator || (typeof require === "function" ? require("./platform/connection-coordinator.js") : null);
    const DEFAULT_SIDEBAR_PAGE_ORDER = Object.freeze(Array.from(settingsSchemaApi?.defaultSidebarPageOrder || ["dashboard", "courses", "calendar", "inbox", "history", "help"]));
    const DEFAULT_SIDEBAR_VISIBILITY = Object.freeze({ ...(settingsSchemaApi?.defaultSidebarPageVisibility || { dashboard: true, courses: true, calendar: true, inbox: true, history: true, help: true }) });
    const SIDEBAR_PAGE_LABELS = Object.freeze({ "apstudy:planner": "Planner", "apstudy:notes": "Notes", "apstudy:grades": "Grades", "apstudy:study": "Study" });
    const SIDEBAR_LIVE_SETTING_KEYS = Object.freeze(Array.from(new Set(settingsSchemaApi?.liveApplyGroups?.sidebar || [
        "better_sidebar", "sidebar_scale_preset", "sidebar_scale", "sidebar_expanded_width", "sidebar_collapsed_width", "sidebar_density",
        "sidebar_icon_size", "sidebar_label_size", "sidebar_logo_visible", "sidebar_product_entry_visible", "sidebar_collapsed_labels",
        "sidebar_page_order", "sidebar_page_visibility", "sidebar_tooltips", "sidebar_accessibility_labels",
        "sidebar_pages_visible_expanded", "sidebar_pages_visible_collapsed", "sidebar_courses_visible_expanded", "sidebar_courses_visible_collapsed",
        "sidebar_pages_folded", "sidebar_courses_folded", "sidebar_preferred_state", "dashboard_sidebar_expanded", "course_sidebar_expanded"
    ])));
    const SIDEBAR_LEGACY_LIVE_SETTING_KEYS = Object.freeze([
        "sidebar_enabled", "enable_sidebar", "enabled", "sidebar_page_labels", "sidebar_labels"
    ]);
    const SIDEBAR_ALL_LIVE_SETTING_KEYS = Object.freeze([
        ...SIDEBAR_LIVE_SETTING_KEYS,
        ...SIDEBAR_LEGACY_LIVE_SETTING_KEYS
    ]);
    const SIDEBAR_SETTING_KEYS = Object.freeze(Array.from(new Set(
        SIDEBAR_LIVE_SETTING_KEYS.filter((key) => !SIDEBAR_LEGACY_LIVE_SETTING_KEYS.includes(key))
    )));
    const SIDEBAR_READ_KEYS = Object.freeze(Array.from(new Set([
        ...SIDEBAR_SETTING_KEYS,
        "sidebar_enabled", "enable_sidebar", "enabled"
    ])));
    const SIDEBAR_LEGACY_LOCAL_EXPANSION_KEYS = Object.freeze([
        "better_sidebar_expanded_dashboard", "better_sidebar_expanded_course"
    ]);
    const SCHEMA_SIDEBAR_DEFAULTS = settingsSchemaApi?.syncDefaults || {};
    const DEFAULT_SIDEBAR_SETTINGS = Object.freeze(Object.fromEntries(SIDEBAR_SETTING_KEYS.map((key) => [
        key,
        SCHEMA_SIDEBAR_DEFAULTS[key] !== undefined
            ? clone(SCHEMA_SIDEBAR_DEFAULTS[key])
            : ({ better_sidebar: false, sidebar_scale: 100, sidebar_scale_preset: "medium", sidebar_expanded_width: 180, sidebar_collapsed_width: 86, sidebar_density: "cozy", sidebar_icon_size: 16, sidebar_label_size: 14, sidebar_logo_visible: true, sidebar_product_entry_visible: true, sidebar_collapsed_labels: true, sidebar_tooltips: true, sidebar_accessibility_labels: true, sidebar_pages_visible_expanded: true, sidebar_pages_visible_collapsed: true, sidebar_courses_visible_expanded: true, sidebar_courses_visible_collapsed: false, sidebar_pages_folded: false, sidebar_courses_folded: false, sidebar_preferred_state: "expanded", dashboard_sidebar_expanded: true, course_sidebar_expanded: true, sidebar_page_order: DEFAULT_SIDEBAR_PAGE_ORDER, sidebar_page_visibility: DEFAULT_SIDEBAR_VISIBILITY }[key])
    ])));
    const SIDEBAR_SIZE_PRESETS = Object.freeze(settingsSchemaApi?.sidebarScalePresets || {
        tiny: Object.freeze({ icon: 12, label: 10 }),
        small: Object.freeze({ icon: 14, label: 12 }),
        medium: Object.freeze({ icon: 16, label: 14 }),
        large: Object.freeze({ icon: 18, label: 16 }),
        "extra-large": Object.freeze({ icon: 21, label: 18 })
    });
    const SIDEBAR_NUMERIC_RANGES = Object.freeze(settingsSchemaApi?.sidebarNumericRanges || {
        sidebar_scale: Object.freeze({ min: 70, max: 150 }),
        sidebar_expanded_width: Object.freeze({ min: 160, max: 320 }),
        sidebar_collapsed_width: Object.freeze({ min: 48, max: 112 }),
        sidebar_icon_size: Object.freeze({ min: 12, max: 32 }),
        sidebar_label_size: Object.freeze({ min: 10, max: 20 })
    });
    const COMPATIBILITY_ONLY_SYNC_SETTING_KEYS = new Set(settingsSchemaApi?.compatibilityOnlySyncSettingKeys || []);
    const THEME_ALLOWED_SETTING_KEYS = Object.freeze([
        "tab_icons", "hide_feedback", "dark_mode", "remlogo", "full_width", "auto_dark", "assignments_due", "gpa_calc", "gradient_cards", "gradent_cards", "disable_color_overlay", "dashboard_grades", "dashboard_notes", "better_todo", "better_sidebar", "condensed_cards", "dashboard_compact_padding", "hide_dashboard_header", "quiz_safe_mode", "todo_icons_visible", "todo_course_color_mode", "customBackgroundOpacity", "customBackgroundBlur", "cardImageRoundness", "cardPadding", "assignment_sequence_footer_visible", "local_theme_sort", "extension_theme", "grade_analytics_enabled", "card_letter_grade_visible",
        "todo_hide_feedback", "todo_full_height", "todo_confetti", "device_dark", "relative_dues", "card_overdues", "gpa_calc_prepend", "auto_dark_start", "auto_dark_end", "num_assignments", "assignment_date_format", "todo_hr24", "todo_separate_scrollbar", "grade_hover", "num_todo_items", "hover_preview", "customCardStyles", "imageSize", "cardRoundness", "cardSpacing", "cardWidth", "cardHeight", "customBackgroundLink", "customBackgroundScale", "sidebar_scale",
        "dark_preset", "custom_font", "gpa_calc_bounds", "custom_cards", "custom_styles", "sidebar_page_order", "sidebar_page_visibility"
    ]);
    const THEME_BOOLEAN_KEYS = new Set([
        "tab_icons", "hide_feedback", "dark_mode", "remlogo", "full_width", "auto_dark", "assignments_due", "gpa_calc", "gradient_cards", "gradent_cards", "disable_color_overlay", "dashboard_grades", "dashboard_notes", "better_todo", "better_sidebar", "condensed_cards", "hide_dashboard_header", "todo_hide_feedback", "todo_full_height", "todo_confetti", "device_dark", "relative_dues", "card_overdues", "gpa_calc_prepend", "todo_hr24", "todo_separate_scrollbar", "grade_hover", "hover_preview", "customCardStyles", "quiz_safe_mode", "todo_icons_visible", "assignment_sequence_footer_visible", "grade_analytics_enabled", "card_letter_grade_visible"
    ]);
    // dashboard_compact_padding is a level enum ("minimal"|"medium"|"high"|"off");
    // legacy backups may still carry the old boolean, which the schema
    // normalizer folds into "medium".
    const THEME_COMPACT_PADDING_LEVELS = Object.freeze(Array.from(settingsSchemaApi?.dashboardCompactPaddingLevels || ["minimal", "medium", "high", "off"]));
    const THEME_NUMBER_KEYS = new Set(["num_assignments", "num_todo_items", "imageSize", "cardRoundness", "cardSpacing", "cardWidth", "cardHeight", "customBackgroundScale", "sidebar_scale", "customBackgroundOpacity", "customBackgroundBlur", "cardImageRoundness", "cardPadding"]);
    const THEME_STRING_KEYS = new Set(["customBackgroundLink", "custom_styles", "todo_course_color_mode", "local_theme_sort", "extension_theme"]);
    const THEME_ARRAY_KEYS = new Set(["custom_domain", "assignments_done", "dark_mode_fix", "sidebar_page_order"]);
    const THEME_OBJECT_KEYS = new Set(["auto_dark_start", "auto_dark_end", "dark_preset", "custom_font", "gpa_calc_bounds", "custom_cards", "sidebar_page_visibility"]);
    const TODO_SETTING_KEYS = Object.freeze(Array.from(settingsSchemaApi?.todoSettingKeys || []));
    const TODO_SETTINGS_DEFAULTS = settingsSchemaApi?.todoSettingsDefaults || {};
    const SETTINGS_EXPORT_KEYS = Object.freeze(Array.from(settingsSchemaApi?.exportableSyncSettingKeys || []));
    // Popup controls are a schema-owned view of sync settings. Keep the
    // unsupported legacy planner block switch out of the interactive path
    // while retaining it in complete import/export/reset compatibility flows.
    const UNSUPPORTED_POPUP_SETTING_KEYS = Object.freeze(["block_planner_script"]);
    const POPUP_ACTIVE_SETTING_KEYS = Object.freeze(SETTINGS_EXPORT_KEYS.filter((key) => !UNSUPPORTED_POPUP_SETTING_KEYS.includes(key)));
    const POPUP_ACTIVE_SETTING_KEY_SET = new Set(POPUP_ACTIVE_SETTING_KEYS);

    function isPlainObject(value) {
        if (!value || typeof value !== "object" || Array.isArray(value)) return false;
        const prototype = Object.getPrototypeOf(value);
        return prototype === Object.prototype || prototype === null;
    }

    function isCanvasContextEventRecord(value) {
        if (!value || typeof value !== "object" || Array.isArray(value)) return false;
        try {
            const prototype = Object.getPrototypeOf(value);
            if (prototype === null || prototype === Object.prototype) return true;
            const constructor = Object.prototype.hasOwnProperty.call(prototype, "constructor")
                ? prototype.constructor
                : null;
            return typeof constructor === "function" && constructor.name === "Object" && constructor.prototype === prototype;
        } catch (error) {
            return false;
        }
    }

    function normalizeSourceCanvasTabId(value) {
        return Number.isSafeInteger(value) && value >= 0 ? value : null;
    }

    // Which host the page is running in is independent of which view it shows.
    // `popup` is the action popup, `tab` is a window or tab this document owns,
    // and `embedded` is the in-page overlay iframe, which shows the workspace
    // but owns neither its window nor its tab.
    const SHELL_HOSTS = Object.freeze({ POPUP: "popup", TAB: "tab", EMBEDDED: "embedded" });

    function shellHost(search) {
        let query;
        try {
            query = new URLSearchParams(typeof search === "string" ? search : "");
        } catch (error) {
            return SHELL_HOSTS.POPUP;
        }
        if (query.get("embedded") === "1") return SHELL_HOSTS.EMBEDDED;
        if (query.get("view") === "workspace" || query.get("fullscreen") === "1") return SHELL_HOSTS.TAB;
        return SHELL_HOSTS.POPUP;
    }

    function shellOpensWorkspace(host) {
        return host === SHELL_HOSTS.TAB || host === SHELL_HOSTS.EMBEDDED;
    }

    const OVERLAY_SESSION_PATTERN = /^[A-Za-z0-9._~-]{1,128}$/;

    function overlaySessionToken(search) {
        try {
            const query = new URLSearchParams(typeof search === "string" ? search : "");
            const values = query.getAll("overlaySession");
            return values.length === 1 && OVERLAY_SESSION_PATTERN.test(values[0]) ? values[0] : null;
        } catch (error) {
            return null;
        }
    }

    function isWorkspaceRoute(search) {
        return shellOpensWorkspace(shellHost(search));
    }

    function clone(value) {
        if (value === undefined) return undefined;
        if (typeof structuredClone === "function") return structuredClone(value);
        return JSON.parse(JSON.stringify(value));
    }

    function isHttpsAvatar(value) {
        if (typeof value !== "string" || !value.trim()) return false;
        try {
            const url = new URL(value.trim());
            return url.protocol === "https:" && !url.username && !url.password && Boolean(url.hostname);
        } catch (error) {
            return false;
        }
    }

    function cleanName(value) {
        return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, 120) : "";
    }

    function initials(value) {
        const parts = cleanName(value).split(" ").filter(Boolean);
        if (!parts.length) return "?";
        return (parts.length === 1 ? parts[0][0] : `${parts[0][0]}${parts[parts.length - 1][0]}`).toUpperCase().slice(0, 2);
    }

    function profileFrom(value) {
        const source = isPlainObject(value) ? value : {};
        const profile = isPlainObject(source.profile) ? source.profile : source;
        const name = cleanName(profile.displayName || profile.displayname || profile.name || source.displayName || source.name);
        const avatarUrl = isHttpsAvatar(profile.avatarUrl || profile.avatarurl || source.avatarUrl || source.avatarurl)
            ? (profile.avatarUrl || profile.avatarurl || source.avatarUrl || source.avatarurl).trim()
            : null;
        return { name, avatarUrl };
    }

    function normalizeIdentityResponse(response) {
        const envelope = isPlainObject(response) ? response : {};
        const payload = isPlainObject(envelope.payload) ? envelope.payload : envelope;
        const body = isPlainObject(payload.body) ? payload.body : isPlainObject(payload.data) ? payload.data : payload;
        const code = String(payload.code || body.code || "").toUpperCase();
        const status = Number(payload.status || body.status || 0);
        if (status === 419 || body.state === "expired" || code.includes("EXPIRED") || code.includes("TOKEN_EXPIRED") || code.includes("SESSION_EXPIRED")) {
            return { state: "expired", profile: null, raw: payload };
        }
        if (payload.ok === false || envelope.ok === false || (status >= 400 && status < 500)) {
            if (status === 401 || status === 403 || code.includes("SIGNED_OUT") || code.includes("UNAUTHENTICATED")) {
                return { state: "signed_out", profile: null, raw: payload };
            }
            return { state: "unavailable", profile: null, raw: payload };
        }
        if (body.authenticated === false || body.identity === null || body.identity === "signed_out" || body.state === "signed_out") {
            return { state: "signed_out", profile: null, raw: payload };
        }
        const identity = body.identity || body.accountId || body.accountid || body.userId || body.userid || body.profile?.id;
        const profile = profileFrom(body);
        if (typeof identity === "string" && identity.trim() && (body.state === "authenticated" || body.authenticated === true || payload.ok === true || envelope.ok === true)) {
            const linkedAccounts = Array.isArray(body.linkedAccounts || body.linked_accounts)
                ? (body.linkedAccounts || body.linked_accounts).filter((account) => isPlainObject(account)).map(clone)
                : [];
            return { state: "authenticated", profile, identity: cleanName(identity), linkedAccounts, capabilities: isPlainObject(body.capabilities) ? clone(body.capabilities) : null, raw: payload };
        }
        return { state: "unavailable", profile: null, raw: payload };
    }

    function resolveProfile(nestProfile, canvasProfile, fallbackName = "") {
        const nest = profileFrom(nestProfile);
        const canvas = profileFrom(canvasProfile);
        const name = nest.name || canvas.name || cleanName(fallbackName);
        const avatarUrl = nest.avatarUrl || canvas.avatarUrl || null;
        const source = nest.name || nest.avatarUrl ? "nest" : canvas.name || canvas.avatarUrl ? "canvas" : "fallback";
        return { name, avatarUrl, initials: initials(name), source };
    }

    function reorderItems(items, index, direction) {
        const next = Array.isArray(items) ? items.slice() : [];
        const from = Number(index);
        const to = from + (direction === "up" ? -1 : 1);
        if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= next.length || to >= next.length) return next;
        [next[from], next[to]] = [next[to], next[from]];
        return next;
    }

    function normalizeSidebarOrder(value, defaults = DEFAULT_SIDEBAR_PAGE_ORDER) {
        if (settingsSchemaApi?.normalizeSidebarOrder) return settingsSchemaApi.normalizeSidebarOrder(value, defaults);
        const known = Array.isArray(defaults)
            ? defaults.filter((page, index, pages) => typeof page === "string" && pages.indexOf(page) === index)
            : Array.from(DEFAULT_SIDEBAR_PAGE_ORDER);
        const seen = new Set();
        const normalized = [];
        const entries = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
        entries.forEach((page) => {
            if (typeof page !== "string" || !known.includes(page) || seen.has(page)) return;
            seen.add(page);
            normalized.push(page);
        });
        known.forEach((page) => {
            if (seen.has(page)) return;
            seen.add(page);
            normalized.push(page);
        });
        return normalized;
    }

    function sidebarDefaults(defaults = {}) {
        const source = isPlainObject(defaults) ? defaults : {};
        return Object.assign({}, DEFAULT_SIDEBAR_SETTINGS, {
            sidebar_page_order: clone(DEFAULT_SIDEBAR_PAGE_ORDER),
            sidebar_page_visibility: clone(DEFAULT_SIDEBAR_VISIBILITY)
        }, Object.fromEntries(SIDEBAR_SETTING_KEYS
            .filter((key) => Object.prototype.hasOwnProperty.call(source, key))
            .map((key) => [key, clone(source[key])])))
    }

    function normalizeSidebarNumber(key, value) {
        const range = SIDEBAR_NUMERIC_RANGES[key];
        if (!range || typeof value !== "number" || !Number.isFinite(value)) return null;
        return Math.min(range.max, Math.max(range.min, Math.round(value)));
    }

    function normalizeSidebarVisibility(value) {
        if (settingsSchemaApi?.normalizeSidebarVisibility) return settingsSchemaApi.normalizeSidebarVisibility(value, DEFAULT_SIDEBAR_VISIBILITY);
        const source = isPlainObject(value) ? value : {};
        return Object.fromEntries(DEFAULT_SIDEBAR_PAGE_ORDER.map((page) => [page, source[page] !== false]));
    }

    function normalizeSidebarSettingValue(key, value) {
        if (SIDEBAR_NUMERIC_RANGES[key]) return normalizeSidebarNumber(key, value);
        if (["better_sidebar", "sidebar_logo_visible", "sidebar_product_entry_visible", "sidebar_collapsed_labels", "sidebar_tooltips", "sidebar_pages_visible_expanded", "sidebar_pages_visible_collapsed", "sidebar_courses_visible_expanded", "sidebar_courses_visible_collapsed", "sidebar_pages_folded", "sidebar_courses_folded", "dashboard_sidebar_expanded", "course_sidebar_expanded"].includes(key)) {
            return typeof value === "boolean" ? value : null;
        }
        if (key === "sidebar_accessibility_labels") return value === true ? true : null;
        if (key === "sidebar_density") return ["cozy", "compact", "comfortable", "dense"].includes(value) ? (value === "comfortable" ? "cozy" : value === "dense" ? "compact" : value) : null;
        if (key === "sidebar_scale_preset") return settingsSchemaApi?.sidebarScalePresets?.[value] ? value : null;
        if (key === "sidebar_avatar_size") return ["small", "medium", "large"].includes(value) ? value : null;
        if (key === "sidebar_preferred_state") return ["expanded", "collapsed"].includes(value) ? value : null;
        if (key === "sidebar_page_order") return normalizeSidebarOrder(value);
        if (key === "sidebar_page_visibility") return normalizeSidebarVisibility(value);
        return clone(value);
    }

    // Cozy/compact are the user-facing terms; comfortable/compact remain the
    // stored values for compatibility with the Canvas content seam.
    function sidebarDensityPreset(value) {
        return ["compact", "dense"].includes(value) ? "compact" : "cozy";
    }

    function sidebarWidthPreset(values = {}) {
        const source = isPlainObject(values) ? values : {};
        // A preset represents both route states. If an older/custom profile
        // has split states, Dashboard is the deterministic popup fallback.
        const preferred = source.sidebar_preferred_state;
        if (preferred === "expanded" || preferred === "collapsed") return preferred;
        const expanded = typeof source.dashboard_sidebar_expanded === "boolean"
            ? source.dashboard_sidebar_expanded
            : typeof source.course_sidebar_expanded === "boolean"
                ? source.course_sidebar_expanded
                : true;
        return expanded ? "expanded" : "collapsed";
    }

    function sidebarSizePreset(values = {}) {
        const icon = Number(values?.sidebar_icon_size);
        const label = Number(values?.sidebar_label_size);
        if (!Number.isFinite(icon) || !Number.isFinite(label)) return "medium";
        const order = Object.keys(SIDEBAR_SIZE_PRESETS);
        return order.reduce((best, key) => {
            const candidate = SIDEBAR_SIZE_PRESETS[key];
            const bestCandidate = SIDEBAR_SIZE_PRESETS[best];
            const distance = Math.abs(candidate.icon - icon) + Math.abs(candidate.label - label);
            const bestDistance = Math.abs(bestCandidate.icon - icon) + Math.abs(bestCandidate.label - label);
            return distance < bestDistance ? key : best;
        }, "medium");
    }

    function sidebarPresetValue(kind, value) {
        if (kind === "width") return value === "collapsed" ? "collapsed" : "expanded";
        if (kind === "density") return value === "compact" ? "compact" : "cozy";
        if (kind === "size") return Object.prototype.hasOwnProperty.call(SIDEBAR_SIZE_PRESETS, value) ? value : "medium";
        return null;
    }

    function sidebarPresetChanges(kind, value, current = {}) {
        const preset = sidebarPresetValue(kind, value);
        if (!preset) return null;
        if (kind === "width") return { sidebar_preferred_state: preset };
        if (kind === "density") return { sidebar_density: preset === "compact" ? "compact" : "cozy" };
        const sizes = SIDEBAR_SIZE_PRESETS[preset];
        return { sidebar_scale_preset: preset, sidebar_icon_size: sizes.icon, sidebar_label_size: sizes.label };
    }

    function normalizeSidebarLiveChanges(changes) {
        if (!isPlainObject(changes)) return null;
        const normalized = {};
        for (const [key, value] of Object.entries(changes)) {
            if (!SIDEBAR_ALL_LIVE_SETTING_KEYS.includes(key)) return null;
            if (SIDEBAR_LEGACY_LIVE_SETTING_KEYS.includes(key)) {
                if (["sidebar_enabled", "enable_sidebar", "enabled"].includes(key) && typeof value !== "boolean") return null;
                if (["sidebar_page_labels", "sidebar_labels"].includes(key) && !isPlainObject(value)) return null;
                normalized[key] = clone(value);
                continue;
            }
            const next = normalizeSidebarSettingValue(key, value);
            if (next === null) return null;
            normalized[key] = next;
        }
        return normalized;
    }

    function createSidebarSettingsUpdateMessage(changes, requestId = `popup-sidebar-${Date.now()}`) {
        const normalized = normalizeSidebarLiveChanges(changes);
        if (!normalized || !Object.keys(normalized).length) return null;
        return {
            version: 1,
            request_id: String(requestId).slice(0, 160),
            type: "SETTINGS_UPDATE",
            payload: { area: "sync", changes: normalized }
        };
    }

    function liveApplyMode(key) {
        return settingsSchemaApi?.liveApplyMode?.(key) || "none";
    }

    function reloadApplyCopy(reason) {
        return `Needs a Canvas refresh — ${reason}`;
    }

    const RELOAD_CONTROL_IDS = Object.freeze({
        num_assignments: "numAssignmentsSlider",
        num_todo_items: "numTodoItemsSlider",
        custom_assignments: "custom_assignments",
        custom_assignments_overflow: "custom_assignments_overflow",
        dark_mode_fix: "dark_mode_fix"
    });

    function annotateReloadApplyReasons(documentRef, schemaApi) {
        const doc = documentRef;
        const reasonFor = (key) => schemaApi?.reloadApplyReason?.(key) || settingsSchemaApi?.reloadApplyReason?.(key);
        if (!doc?.querySelectorAll) return 0;
        let count = 0;

        function mark(control, key) {
            const reason = reasonFor(key);
            if (!reason || !control) return;
            count += 1;
            const id = `reload-reason-${String(key).replace(/[^a-z0-9_-]/gi, "")}`;
            const host = control.closest?.(".workspace-setting, .quick-control, .option-container, .sub-option, .option") || control.parentElement;
            const existing = host?.querySelector?.("small, .reload-apply-reason");
            let hint = doc.getElementById?.(id) || null;
            if (existing && /Canvas refresh|Needs a Canvas/i.test(existing.textContent || "")) {
                if (!existing.id) existing.id = id;
                hint = existing;
            } else if (!hint && host && typeof doc.createElement === "function") {
                hint = doc.createElement("small");
                hint.id = id;
                hint.className = "reload-apply-reason";
                hint.textContent = reloadApplyCopy(reason);
                host.appendChild(hint);
            } else if (hint && !hint.textContent) {
                hint.textContent = reloadApplyCopy(reason);
            }
            if (hint?.id) {
                const described = control.getAttribute?.("aria-describedby") || "";
                if (!described.includes(hint.id)) control.setAttribute?.("aria-describedby", `${described} ${hint.id}`.trim());
            }
            if (control.setAttribute && !control.getAttribute?.("title")) {
                control.setAttribute("title", reloadApplyCopy(reason));
            }
        }

        doc.querySelectorAll("[data-popup-setting]").forEach((control) => {
            mark(control, control.dataset?.popupSetting);
        });
        const reasons = schemaApi?.reloadApplyReasons || settingsSchemaApi?.reloadApplyReasons || {};
        Object.keys(reasons).forEach((key) => {
            const mappedId = RELOAD_CONTROL_IDS[key];
            const byId = (mappedId && doc.getElementById?.(mappedId)) || doc.getElementById?.(key);
            if (byId) {
                const control = byId.matches?.("input, textarea, select, button") ? byId : byId.querySelector?.("input, textarea, select, button") || byId;
                mark(control, key);
            }
            const named = doc.querySelector?.(`[name="${key}"]`);
            if (named && named !== byId) mark(named, key);
        });
        return count;
    }

    function createLiveSettingsUpdateMessage(changes, requestId = `popup-live-${Date.now()}`) {
        if (!isPlainObject(changes)) return null;
        const payload = {};
        for (const [key, value] of Object.entries(changes)) {
            const mode = liveApplyMode(key);
            if (mode === "live" || mode === "reload") payload[key] = clone(value);
        }
        if (!Object.keys(payload).length) return null;
        const keys = Object.keys(payload);
        if (keys.every((key) => SIDEBAR_ALL_LIVE_SETTING_KEYS.includes(key))) {
            return createSidebarSettingsUpdateMessage(payload, requestId);
        }
        return {
            version: 1,
            request_id: String(requestId).slice(0, 160),
            type: "SETTINGS_UPDATE",
            payload: { area: "sync", changes: payload }
        };
    }

    function identityKey(identity) {
        if (!isPlainObject(identity)) return "";
        return cleanName(identity.identity || identity.accountId || identity.accountid || identity.userId || identity.userid || identity.profile?.name || identity.profile?.displayName || "");
    }

    function sameArray(left, right) {
        return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => value === right[index]);
    }

    function normalizedCategory(value, fallback = "overview") {
        return CATEGORIES.includes(value) ? value : fallback;
    }

    function callStorage(chromeApi, area, method, ...args) {
        const storage = chromeApi?.storage?.[area];
        if (!storage || typeof storage[method] !== "function") return Promise.reject(new Error(`storage.${area}.${method} unavailable`));
        try {
            const result = storage[method](...args);
            return result && typeof result.then === "function" ? result : Promise.resolve(result);
        } catch (error) {
            return Promise.reject(error);
        }
    }

    function writeResultError(result, fallbackCode) {
        if (result === null || result === false || (isPlainObject(result) && result.ok === false)) {
            const error = new Error(result?.code || fallbackCode);
            error.code = result?.code || fallbackCode;
            return error;
        }
        return null;
    }

    function createSettingsStore({ sendUpdate, sendReset, read = async () => ({}), aliases = {}, normalizers = {}, debounceMs = 180, setTimer = setTimeout, clearTimer = clearTimeout, onStatus = () => {}, onSaved = () => {}, onRollback = () => {}, onPending = () => {} } = {}) {
        if (typeof sendUpdate !== "function") throw new Error("SETTINGS_UPDATE_REQUIRED");
        const pending = new Map();
        const latestEntries = new Map();
        let operationTail = Promise.resolve();
        let activeDrain = null;
        let debounceTimer = null;
        let sequence = 0;

        function normalizeValue(key, value) {
            return typeof normalizers[key] === "function" ? normalizers[key](clone(value)) : clone(value);
        }

        function expand(key, value) {
            const keys = Array.isArray(aliases[key]) ? aliases[key] : [key];
            return Object.fromEntries(keys.map((item) => [item, clone(value)]));
        }

        function notifyPending(key, value) {
            try { onPending(key, value); } catch (error) {}
        }

        function notifySaved(key, value) {
            try { onSaved(key, clone(value)); } catch (error) {}
        }

        function notifyRollback(key, value) {
            try { onRollback(key, clone(value)); } catch (error) {}
        }

        function notifyStatus(message, error = false) {
            try { onStatus(message, error); } catch (ignored) {}
        }

        function clearDebounceTimer() {
            if (debounceTimer === null) return;
            clearTimer(debounceTimer);
            debounceTimer = null;
        }

        function scheduleDrain() {
            clearDebounceTimer();
            debounceTimer = setTimer(() => {
                debounceTimer = null;
                flush().catch(() => {});
            }, Math.max(0, Number(debounceMs) || 0));
        }

        function createSettingsError(error, fallbackCode = "SETTINGS_UPDATE_FAILED") {
            const rawCode = typeof error?.code === "string" ? error.code : typeof error?.message === "string" ? error.message : fallbackCode;
            const code = rawCode.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 80) || fallbackCode;
            const rawMessage = typeof error?.message === "string" ? error.message : code;
            const message = /(?:password|passphrase|secret|token|csrf|cookie|authorization|credential|private[_-]?key|api[_-]?key)/i.test(rawMessage)
                ? "Settings operation failed; sensitive details were redacted."
                : rawMessage.slice(0, 200);
            const sanitized = new Error(message || code);
            sanitized.code = code;
            return sanitized;
        }

        function aggregateSettingsErrors(failures) {
            const details = failures.map(({ key, error }) => ({ key, code: error.code, message: error.message }));
            const aggregate = new Error("SETTINGS_FLUSH_FAILED");
            aggregate.name = "SettingsFlushError";
            aggregate.code = "SETTINGS_FLUSH_FAILED";
            aggregate.errors = details;
            aggregate.failures = details;
            return aggregate;
        }

        function responsePayload(result) {
            return isPlainObject(result?.payload) ? result.payload : isPlainObject(result) ? result : {};
        }

        function keyedStatusFailure(status, key) {
            if (status === undefined || status === true || status === "ok" || status === "success") return null;
            if (status === null || status === false || status === "failed" || status === "error") {
                return createSettingsError({ code: "SETTINGS_KEY_UPDATE_FAILED", message: `Setting ${key} failed.` }, "SETTINGS_KEY_UPDATE_FAILED");
            }
            if (!isPlainObject(status)) return null;
            if (status.ok === false || status.success === false || status.failed === true || status.status === "failed" || status.status === "error" || status.error || status.failure) {
                return createSettingsError(status.error || status.failure || status, "SETTINGS_KEY_UPDATE_FAILED");
            }
            return null;
        }

        function failureForEntry(result, entry) {
            const payload = responsePayload(result);
            const expandedKeys = entry.expandedKeys;
            const keyedContainers = [payload.results, payload.perKey, payload.per_key, payload.keyResults, payload.key_results, payload.keys]
                .filter((value) => isPlainObject(value));
            let hasExplicitKeyStatus = false;
            for (const container of keyedContainers) {
                for (const key of expandedKeys) {
                    if (!Object.prototype.hasOwnProperty.call(container, key)) continue;
                    hasExplicitKeyStatus = true;
                    const failure = keyedStatusFailure(container[key], key);
                    if (failure) return failure;
                }
            }
            if (hasExplicitKeyStatus || keyedContainers.length) return null;

            const failedKeys = payload.failedKeys || payload.failed_keys || payload.failed || payload.errors;
            const hasExplicitFailedKeyList = Array.isArray(payload.failedKeys) || Array.isArray(payload.failed_keys) || isPlainObject(payload.failedKeys) || isPlainObject(payload.failed_keys);
            if (Array.isArray(failedKeys) && expandedKeys.some((key) => failedKeys.includes(key))) {
                return createSettingsError({ code: "SETTINGS_KEY_UPDATE_FAILED", message: `Setting ${entry.key} failed.` }, "SETTINGS_KEY_UPDATE_FAILED");
            }
            if (isPlainObject(failedKeys) && expandedKeys.some((key) => Object.prototype.hasOwnProperty.call(failedKeys, key))) {
                const failedKey = expandedKeys.find((key) => Object.prototype.hasOwnProperty.call(failedKeys, key));
                return createSettingsError(failedKeys[failedKey], "SETTINGS_KEY_UPDATE_FAILED");
            }
            if (hasExplicitFailedKeyList) return null;
            if (payload.ok === false || result === null || result === false) return createSettingsError(payload, "SETTINGS_UPDATE_FAILED");
            return null;
        }

        function rollbackValue(snapshot, entry) {
            if (!isPlainObject(snapshot)) return undefined;
            if (Object.prototype.hasOwnProperty.call(snapshot, entry.key)) return snapshot[entry.key];
            const aliasKey = entry.expandedKeys.find((key) => Object.prototype.hasOwnProperty.call(snapshot, key));
            return aliasKey ? snapshot[aliasKey] : undefined;
        }

        function isCurrent(entry) {
            return latestEntries.get(entry.key) === entry;
        }

        function finishEntry(entry) {
            if (!isCurrent(entry)) return;
            latestEntries.delete(entry.key);
            notifyPending(entry.key, false);
        }

        function settleEntry(entry, succeeded, value) {
            if (entry.settled) return;
            entry.settled = true;
            const callers = entry.callers.splice(0);
            callers.forEach(({ resolve, reject }) => {
                if (succeeded) resolve(value);
                else reject(value);
            });
        }

        function updateField(key, value) {
            let entry = pending.get(key);
            if (!entry) {
                entry = { key, value: undefined, expandedKeys: [], callers: [], settled: false, sequence: ++sequence };
                latestEntries.set(key, entry);
                notifyPending(key, true);
            }
            entry.value = normalizeValue(key, value);
            entry.expandedKeys = Object.keys(expand(key, entry.value));
            pending.set(key, entry);
            const result = new Promise((resolve, reject) => {
                entry.callers.push({ resolve, reject });
            });
            scheduleDrain();
            notifyStatus("Saving…", false);
            return result;
        }

        function takePendingBatch() {
            clearDebounceTimer();
            const entries = Array.from(pending.values());
            pending.clear();
            return entries;
        }

        async function commitBatch(entries) {
            const changes = Object.assign({}, ...entries.map((entry) => expand(entry.key, entry.value)));
            const keys = Object.keys(changes);
            let snapshot = {};
            let result;
            let transportError = null;
            try {
                const readResult = await read(keys);
                snapshot = isPlainObject(readResult) ? readResult : {};
                result = await sendUpdate(changes);
            } catch (error) {
                transportError = createSettingsError(error, "SETTINGS_UPDATE_FAILED");
            }

            const failures = [];
            entries.forEach((entry) => {
                const failure = transportError || failureForEntry(result, entry);
                if (failure) {
                    if (isCurrent(entry)) notifyRollback(entry.key, rollbackValue(snapshot, entry));
                    settleEntry(entry, false, failure);
                    failures.push({ key: entry.key, error: failure });
                } else {
                    if (isCurrent(entry)) notifySaved(entry.key, entry.value);
                    settleEntry(entry, true, result);
                }
                finishEntry(entry);
            });
            if (failures.length) notifyStatus("Failed — changes reverted.", true);
            else notifyStatus("Saved.", false);
            return failures;
        }

        async function drainLoop() {
            const failures = [];
            while (pending.size) {
                const entries = takePendingBatch();
                failures.push(...await commitBatch(entries));
            }
            if (failures.length) throw aggregateSettingsErrors(failures);
        }

        function drain() {
            if (activeDrain) return activeDrain;
            const run = drainLoop();
            const tracked = run.finally(() => {
                if (activeDrain === tracked) activeDrain = null;
                if (pending.size && debounceTimer === null) scheduleDrain();
            });
            activeDrain = tracked;
            return tracked;
        }

        function enqueue(operation) {
            const run = operationTail.then(operation, operation);
            operationTail = run.catch(() => {});
            return run;
        }

        function flush() {
            if (activeDrain) return activeDrain;
            return enqueue(() => drain());
        }

        function transaction(changes, options = {}) {
            const config = isPlainObject(options) ? options : {};
            return enqueue(async () => {
                await drain();
                const current = typeof config.read === "function" ? await config.read(keysForRead(changes)) : await read(keysForRead(changes));
                const rawNext = typeof changes === "function" ? await changes(clone(current)) : changes;
                const next = isPlainObject(rawNext)
                    ? Object.fromEntries(Object.entries(rawNext).map(([key, value]) => [key, normalizeValue(key, value)]))
                    : {};
                if (typeof config.validate === "function") {
                    const validation = await config.validate(next, clone(current));
                    if (validation === false || validation?.valid === false) throw new Error(validation?.message || "Settings validation failed.");
                }
                if (!Object.keys(next).length) return {};
                const expanded = Object.assign({}, ...Object.keys(next).map((key) => expand(key, next[key])));
                const keys = Object.keys(next);
                const token = { transaction: true, sequence: ++sequence };
                keys.forEach((key) => { latestEntries.set(key, token); notifyPending(key, true); });

                let result;
                let operationError = null;
                let failures = [];
                try {
                    result = await sendUpdate(expanded);
                    failures = keys.map((key) => ({ key, entry: { key, value: next[key], expandedKeys: Object.keys(expand(key, next[key])) } }))
                        .map(({ key, entry }) => ({ key, entry, error: failureForEntry(result, entry) }))
                        .filter(({ error }) => error);
                } catch (error) {
                    const failure = createSettingsError(error, "SETTINGS_UPDATE_FAILED");
                    failures = keys.map((key) => ({ key, entry: { key, value: next[key], expandedKeys: Object.keys(expand(key, next[key])) }, error: failure }));
                    operationError = aggregateSettingsErrors(failures);
                }

                keys.forEach((key) => {
                    const entry = { key, value: next[key], expandedKeys: Object.keys(expand(key, next[key])) };
                    const failure = failures.find((item) => item.key === key)?.error || null;
                    if (failure) {
                        if (latestEntries.get(key) === token) notifyRollback(key, rollbackValue(current, entry));
                    } else if (latestEntries.get(key) === token) {
                        notifySaved(key, next[key]);
                    }
                    if (latestEntries.get(key) === token) {
                        latestEntries.delete(key);
                        notifyPending(key, false);
                    }
                });
                if (failures.length) {
                    if (!operationError) operationError = aggregateSettingsErrors(failures);
                    notifyStatus("Failed — no changes applied.", true);
                } else {
                    notifyStatus("Saved.", false);
                }

                let trailingError = null;
                try { await drain(); } catch (error) { trailingError = error; }
                if (operationError) throw operationError;
                if (trailingError) throw trailingError;
                return result;
            });
        }

        function keysForRead(changes) {
            const raw = typeof changes === "function" ? [] : Object.keys(isPlainObject(changes) ? changes : {});
            return raw;
        }

        function reset(keys, options = {}) {
            const config = isPlainObject(options) ? options : {};
            return enqueue(async () => {
                await drain();
                if (typeof sendReset !== "function") throw new Error("SETTINGS_RESET_UNAVAILABLE");
                const list = Array.from(new Set((Array.isArray(keys) ? keys : [keys]).filter((key) => typeof key === "string")));
                if (!list.length) return {};
                const current = typeof config.read === "function" ? await config.read() : await read(list);
                const token = { reset: true, sequence: ++sequence };
                list.forEach((key) => { latestEntries.set(key, token); notifyPending(key, true); });
                let result;
                let operationError = null;
                let failures = [];
                try {
                    result = await sendReset(list);
                    failures = list.map((key) => ({ key, entry: { key, expandedKeys: [key] }, error: failureForEntry(result, { key, expandedKeys: [key] }) })).filter(({ error }) => error);
                } catch (error) {
                    const failure = createSettingsError(error, "SETTINGS_RESET_FAILED");
                    failures = list.map((key) => ({ key, entry: { key, expandedKeys: [key] }, error: failure }));
                    operationError = aggregateSettingsErrors(failures);
                }
                list.forEach((key) => {
                    const failure = failures.find((item) => item.key === key)?.error || null;
                    if (failure) {
                        if (latestEntries.get(key) === token) notifyRollback(key, rollbackValue(current, { key, expandedKeys: [key] }));
                    } else if (latestEntries.get(key) === token) {
                        notifySaved(key, undefined);
                    }
                    if (latestEntries.get(key) === token) {
                        latestEntries.delete(key);
                        notifyPending(key, false);
                    }
                });
                if (failures.length) {
                    if (!operationError) operationError = aggregateSettingsErrors(failures);
                    notifyStatus("Failed — settings were not fully reset.", true);
                } else {
                    notifyStatus("Saved.", false);
                }
                let trailingError = null;
                try { await drain(); } catch (error) { trailingError = error; }
                if (operationError) throw operationError;
                if (trailingError) throw trailingError;
                return result;
            });
        }

        return Object.freeze({ updateField, flush, transaction, reset });
    }

    const FORBIDDEN_IMPORT_KEY = /^(?:__proto__|prototype|constructor)$/i;
    const SECRET_IMPORT_KEY = /(?:password|passphrase|secret|token|csrf|cookie|authorization|credential|private[_-]?key|api[_-]?key|client[_-]?secret)/i;

    function isSafeImportKey(key) {
        return typeof key === "string" && !FORBIDDEN_IMPORT_KEY.test(key) && !SECRET_IMPORT_KEY.test(key);
    }

    function isSafeImportValue(value, depth = 0) {
        if (depth > 12 || value === undefined || typeof value === "function" || typeof value === "symbol") return false;
        if (value === null || typeof value === "string" || typeof value === "boolean") return true;
        if (typeof value === "number") return Number.isFinite(value);
        if (Array.isArray(value)) return value.every((item) => isSafeImportValue(item, depth + 1));
        if (!isPlainObject(value)) return false;
        return Object.entries(value).every(([key, item]) => isSafeImportKey(key) && isSafeImportValue(item, depth + 1));
    }

    function validateCardColors(value) {
        return Array.isArray(value) && value.length <= 256 && value.every((color) => typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color));
    }

    function createTodoSettingsExport(values = {}) {
        if (typeof settingsSchemaApi?.todoSettingsSnapshot === "function") return settingsSchemaApi.todoSettingsSnapshot(values);
        return Object.fromEntries(TODO_SETTING_KEYS.map((key) => [key, clone(values[key] === undefined ? TODO_SETTINGS_DEFAULTS[key] : values[key])]));
    }

    function normalizeTodoSettingsImport(values) {
        if (typeof settingsSchemaApi?.normalizeTodoImport === "function") return settingsSchemaApi.normalizeTodoImport(values);
        if (!isPlainObject(values)) return { valid: false, changes: {}, rejected: ["root"] };
        const changes = Object.fromEntries(Object.entries(values).filter(([key]) => TODO_SETTING_KEYS.includes(key)).map(([key, value]) => [key, clone(value)]));
        return { valid: Object.keys(changes).length > 0, changes, rejected: [] };
    }

    function todoImportChangesWithCompatibility(changes) {
        const output = { ...clone(changes) };
        Object.entries(changes || {}).forEach(([key, value]) => {
            const compatibility = settingsSchemaApi?.todoLegacyCompatibilityChanges?.(key, value) || {};
            Object.assign(output, compatibility);
        });
        return output;
    }

    function validateImportValue(key, value) {
        if (!isSafeImportValue(value)) return false;
        if (typeof settingsSchemaApi?.normalizePhaseOneSettingValue === "function" && settingsSchemaApi.lazySyncDefaultKeys?.includes(key)) return settingsSchemaApi.normalizePhaseOneSettingValue(key, value) !== null;
        if (key === "dashboard_compact_padding") return typeof value === "boolean" || THEME_COMPACT_PADDING_LEVELS.includes(value);
        if (THEME_BOOLEAN_KEYS.has(key)) return typeof value === "boolean";
        if (THEME_NUMBER_KEYS.has(key)) return typeof value === "number" && Number.isFinite(value);
        if (THEME_STRING_KEYS.has(key)) return typeof value === "string";
        if (THEME_ARRAY_KEYS.has(key)) return Array.isArray(value);
        if (THEME_OBJECT_KEYS.has(key)) return isPlainObject(value);
        return true;
    }

    function validateImportData(settingsChanges, cardColors, allowedKeys = THEME_ALLOWED_SETTING_KEYS) {
        if (!isPlainObject(settingsChanges) || !isSafeImportValue(settingsChanges)) return false;
        const allowed = allowedKeys instanceof Set ? allowedKeys : new Set(Array.isArray(allowedKeys) ? allowedKeys : THEME_ALLOWED_SETTING_KEYS);
        if (Object.keys(settingsChanges).some((key) => !allowed.has(key) || !validateImportValue(key, settingsChanges[key]))) return false;
        return cardColors === undefined || validateCardColors(cardColors);
    }

    // Imports are validated permissively (legacy booleans are accepted) but
    // never stored raw: every recognized value is folded to its canonical
    // string before the transaction writes it.
    function normalizeImportedSettingChanges(changes) {
        if (!isPlainObject(changes)) return changes;
        const output = { ...changes };
        if (Object.prototype.hasOwnProperty.call(output, "dashboard_compact_padding")) {
            const normalized = settingsSchemaApi?.normalizeDashboardCompactPadding?.(output.dashboard_compact_padding);
            if (typeof normalized === "string") output.dashboard_compact_padding = normalized;
        }
        return output;
    }

    function hasFailedOperation(result, fallbackCode) {
        const error = writeResultError(result, fallbackCode);
        return error;
    }

    function validateQueuedSnapshot(snapshot) {
        if (snapshot === undefined || snapshot === null) return { present: false };
        if (!isPlainObject(snapshot) || typeof snapshot.present !== "boolean") throw new Error("THEME_QUEUED_COLORS_SNAPSHOT_FAILED");
        if (snapshot.present && !validateCardColors(snapshot.value)) throw new Error("THEME_QUEUED_COLORS_SNAPSHOT_FAILED");
        return clone(snapshot);
    }

    function sanitizeTransactionError(error, fallbackCode = "THEME_TRANSACTION_FAILED") {
        const rawCode = typeof error?.code === "string" ? error.code : typeof error?.message === "string" ? error.message : fallbackCode;
        const code = rawCode.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 80) || fallbackCode;
        const rawMessage = typeof error?.message === "string" ? error.message : "Theme transaction failed.";
        const message = /(?:password|passphrase|secret|token|csrf|cookie|authorization|credential|private[_-]?key|api[_-]?key)/i.test(rawMessage)
            ? "Theme transaction failed; sensitive details were redacted."
            : rawMessage.slice(0, 200);
        return { code, message };
    }

    async function runThemeImportTransaction({ settingsChanges, cardColors, hasCanvas, readSettings, writeSettings, restoreSettings, readCanvasColors, writeCanvasColors, readQueuedColors = async () => undefined, queueCanvasColors = async () => {}, restoreQueuedColors = async () => {}, allowedSettingsKeys = THEME_ALLOWED_SETTING_KEYS } = {}) {
        if (!validateImportData(settingsChanges, cardColors, allowedSettingsKeys) || typeof readSettings !== "function" || typeof writeSettings !== "function" || typeof restoreSettings !== "function") {
            throw new Error("THEME_TRANSACTION_INVALID");
        }
        const normalizedChanges = normalizeImportedSettingChanges(settingsChanges);
        const settingsSnapshot = await readSettings();
        if (!isPlainObject(settingsSnapshot) || !isSafeImportValue(settingsSnapshot)) throw new Error("THEME_SETTINGS_SNAPSHOT_FAILED");
        const hasColorChange = cardColors !== undefined;
        let canvasSnapshot = null;
        let queuedSnapshot = { present: false };

        if (hasColorChange && hasCanvas) {
            if (typeof readCanvasColors !== "function" || typeof writeCanvasColors !== "function") throw new Error("CANVAS_COLORS_UNAVAILABLE");
            canvasSnapshot = await readCanvasColors();
            if (!validateCardColors(canvasSnapshot)) throw new Error("CANVAS_COLORS_SNAPSHOT_FAILED");
        } else if (hasColorChange) {
            queuedSnapshot = validateQueuedSnapshot(await readQueuedColors());
        }

        try {
            const settingsResult = await writeSettings(clone(normalizedChanges));
            const settingsError = hasFailedOperation(settingsResult, "THEME_SETTINGS_WRITE_FAILED");
            if (settingsError) throw settingsError;
            if (hasColorChange && hasCanvas) {
                const colorResult = await writeCanvasColors(clone(cardColors));
                const colorError = hasFailedOperation(colorResult, "CANVAS_COLORS_WRITE_FAILED");
                if (colorError) throw colorError;
            } else if (hasColorChange) {
                const queueResult = await queueCanvasColors(clone(cardColors));
                const queueError = hasFailedOperation(queueResult, "CANVAS_COLORS_QUEUE_FAILED");
                if (queueError) throw queueError;
            }
            return {
                settings: clone(normalizedChanges),
                canvasColorsApplied: hasColorChange && Boolean(hasCanvas),
                canvasColorsQueued: hasColorChange && !hasCanvas,
                canvasColorsPending: hasColorChange && !hasCanvas,
                canvasColorsNotApplied: hasColorChange && !hasCanvas
            };
        } catch (error) {
            const compensation = [Promise.resolve().then(() => restoreSettings(clone(settingsSnapshot)))];
            if (hasColorChange && hasCanvas) compensation.push(Promise.resolve().then(() => writeCanvasColors(clone(canvasSnapshot))));
            else if (hasColorChange) compensation.push(Promise.resolve().then(() => restoreQueuedColors(clone(queuedSnapshot))));
            const results = await Promise.allSettled(compensation);
            if (results.some((result) => result.status === "rejected" || hasFailedOperation(result.value, "THEME_COMPENSATION_FAILED"))) {
                const failure = new Error("THEME_TRANSACTION_COMPENSATION_FAILED");
                failure.code = "THEME_TRANSACTION_COMPENSATION_FAILED";
                failure.state = {
                    ok: false,
                    code: failure.code,
                    primary: sanitizeTransactionError(error),
                    compensation: results.map((result) => result.status === "fulfilled" ? { ok: true } : { ok: false, error: sanitizeTransactionError(result.reason, "THEME_COMPENSATION_FAILED") })
                };
                throw failure;
            }
            throw error;
        }
    }

    function handlePopoverEscape(event, close, trigger) {
        if (event?.key !== "Escape" || typeof close !== "function" || !close()) return false;
        event.preventDefault?.();
        trigger?.focus?.();
        return true;
    }

    function createStartup({ controller, document: documentRef, loaders = [], onReady, afterReady, onAfterReadyError, onError } = {}) {
        const doc = documentRef || root?.document;
        let started = false;
        let startupPromise = null;
        let postReadyPromise = null;

        function start() {
            if (started) return startupPromise;
            started = true;
            startupPromise = Promise.resolve().then(async () => {
                const phases = [() => controller?.init?.(), ...Array.from(loaders || [])];
                const results = await Promise.all(phases.map((phase) => {
                    if (typeof phase !== "function") throw new Error("POPUP_STARTUP_LOADER_INVALID");
                    return phase();
                }));
                await onReady?.(results);
                if (typeof afterReady === "function") {
                    postReadyPromise = Promise.resolve().then(() => afterReady(results)).catch(async (error) => {
                        try { return await onAfterReadyError?.(error); } catch (callbackError) {
                            return { ok: false, code: "POPUP_POST_READY_FAILED" };
                        }
                    });
                    postReadyPromise.catch(() => {});
                }
                return results[0];
            }).catch(async (error) => {
                try { await onError?.(error); } catch (callbackError) {}
                throw error;
            });
            // Keep the browser from treating an automatically-started failure
            // as unobserved. Callers still receive the original rejecting
            // startupPromise through start()/promise.
            startupPromise.catch(() => {});
            return startupPromise;
        }

        if (doc?.readyState === "loading") doc.addEventListener?.("DOMContentLoaded", start, { once: true });
        else start();

        return Object.freeze({
            start,
            get started() { return started; },
            get promise() { return startupPromise; },
            get postReadyPromise() { return postReadyPromise; }
        });
    }

    function createController({ document, window, chromeApi, contract, defaults = {}, now = () => Date.now(), settingsStore, liveApply } = {}) {
        const doc = document || root?.document;
        const win = window || root;
        const chromeService = chromeApi || root?.chrome;
        const messageContract = contract || root?.APStudyCanvasPlatform?.Contract;
        const initialSidebarSettings = sidebarDefaults(defaults);
        const state = {
            identity: { state: "checking", profile: null },
            canvas: null,
            canvasAccounts: [],
            nestLinkedAccounts: [],
            category: "overview",
            consent: null,
            calendars: null,
            identityGeneration: 0,
            identityUserKey: "",
            onboardingDismissed: false,
            onboardingReady: false,
            sidebarSettings: clone(initialSidebarSettings),
            sidebarOrder: clone(DEFAULT_SIDEBAR_PAGE_ORDER),
            persistedSidebarOrder: clone(DEFAULT_SIDEBAR_PAGE_ORDER),
            persistedSidebarSettings: clone(initialSidebarSettings),
            sidebarVisibility: clone(DEFAULT_SIDEBAR_VISIBILITY),
            sidebarPages: [],
            sidebarShowHidden: false,
            sidebarCourses: [],
            sidebarCourseOrder: [],
            sidebarCourseOrderKey: null,
            sidebarCourseOrderAvailable: false,
            sidebarRawPresence: {},
            sidebarNeedsNextLoad: false,
            sidebarReorderGeneration: 0,
            sidebarContextGeneration: 0,
            sidebarContextRevision: null,
            popupSettings: {},
            modernDarkPaletteDraft: null,
            initialized: false,
            initPromise: null,
            readySignalPromise: null,
            startupFailurePromise: null,
            draftSyncError: null
        };

        let sidebarPersistTail = Promise.resolve();
        let sidebarOperationSequence = 0;
        const sidebarSettingGenerations = new Map();
        let sidebarLiveSequence = 0;
        let sidebarDrag = null;
        let draftStateSequence = 0;
        let draftStateTail = Promise.resolve();
        const draftSyncWarning = "Unsaved-change protection could not sync. Keep this workspace open and try again.";

        function beginSidebarOperation(keys) {
            const generation = ++sidebarOperationSequence;
            const generations = {};
            Array.from(new Set(keys)).forEach((key) => {
                sidebarSettingGenerations.set(key, generation);
                generations[key] = generation;
            });
            if (keys.includes("sidebar_page_order")) state.sidebarReorderGeneration = generation;
            return { generation, generations };
        }

        function isCurrentSidebarOperation(operation, key) {
            return operation?.generations?.[key] !== undefined && sidebarSettingGenerations.get(key) === operation.generations[key];
        }

        function enqueueSidebarOperation(work) {
            const operation = sidebarPersistTail.then(work, work);
            sidebarPersistTail = operation.catch(() => {});
            return operation;
        }

        function persistedSidebarValue(key, fallback) {
            if (Object.prototype.hasOwnProperty.call(state.persistedSidebarSettings || {}, key)) return clone(state.persistedSidebarSettings[key]);
            if (key === "sidebar_page_order" && Array.isArray(state.persistedSidebarOrder)) return state.persistedSidebarOrder.slice();
            return clone(fallback);
        }

        function markSidebarPersisted(key, value) {
            state.persistedSidebarSettings[key] = clone(value);
            if (key === "sidebar_page_order") state.persistedSidebarOrder = normalizeSidebarOrder(value);
        }

        function failedSidebarKeys(error, keys, succeededKeys = []) {
            const explicit = Array.isArray(error?.errors) ? new Set(error.errors.map((item) => item?.key).filter(Boolean)) : new Set();
            if (explicit.size) return explicit;
            const succeeded = new Set(succeededKeys);
            return new Set(keys.filter((key) => !succeeded.has(key)));
        }

        function restoreSidebarKey(key, fallback) {
            const value = persistedSidebarValue(key, fallback);
            state.sidebarSettings[key] = clone(value);
            if (key === "sidebar_page_order") state.sidebarOrder = normalizeSidebarOrder(value);
            if (key === "sidebar_page_visibility") state.sidebarVisibility = normalizeSidebarVisibility(value);
        }

        const q = (selector) => doc?.querySelector?.(selector) || null;
        const qa = (selector) => Array.from(doc?.querySelectorAll?.(selector) || []);
        const text = (selector, value) => { const node = q(selector); if (node) node.textContent = String(value ?? ""); return node; };
        const hidden = (selector, value) => { const node = q(selector); if (node) node.hidden = Boolean(value); return node; };

        function setStatus(message, error = false) {
            ["#workspace-save-status"].forEach((selector) => {
                const node = q(selector);
                if (!node) return;
                node.textContent = message;
                node.hidden = false;
                node.classList?.toggle("is-error", Boolean(error));
                node.dataset.state = error ? "failed" : /^Saving/i.test(String(message)) ? "saving" : /^Saved/i.test(String(message)) ? "saved" : "idle";
            });
            const live = q("#save-status-live");
            if (live && live.textContent !== message) live.textContent = message;
            const sidebarStatus = q("#sidebar-status-value");
            if (sidebarStatus) {
                sidebarStatus.textContent = message;
                sidebarStatus.dataset.state = error ? "failed" : /^Saving/i.test(String(message)) ? "saving" : /^Saved/i.test(String(message)) ? "saved" : "idle";
            }
        }

        function setError(message) {
            const node = q("#workspace-error-area");
            if (!node) return;
            const messageNode = q("#workspace-error-message");
            if (messageNode) messageNode.textContent = message || "";
            else node.textContent = message || "";
            node.hidden = !message;
            node.setAttribute?.("data-state", message ? "error" : "idle");
        }

        function boundedRead(operation, label) {
            const setTimer = win?.setTimeout?.bind(win) || setTimeout;
            const clearTimer = win?.clearTimeout?.bind(win) || clearTimeout;
            let timer;
            return Promise.race([Promise.resolve(operation), new Promise((_, reject) => {
                timer = setTimer(() => reject(new Error(`${label} timed out. Try again.`)), 8000);
                timer?.unref?.();
            })]).finally(() => clearTimer(timer));
        }

        function request(type, payload = {}) {
            if (!chromeService?.runtime?.sendMessage) return Promise.reject(new Error("RUNTIME_MESSAGE_UNAVAILABLE"));
            const message = messageContract?.createEnvelope ? messageContract.createEnvelope(type, payload) : { version: 1, request_id: `popup-${now()}`, type, payload };
            const operation = chromeService.runtime.sendMessage(message);
            return (/_GET$|_LIST$|_STATUS$/.test(type) ? boundedRead(operation, "Account request") : Promise.resolve(operation)).then((response) => response?.payload || response || {});
        }

        function storageGet(area, keys) { return boundedRead(callStorage(chromeService, area, "get", keys), "Settings read"); }
        function storageSet(area, value) { return callStorage(chromeService, area, "set", value); }

        function isActivePopupSettingKey(key) {
            return typeof key === "string" && POPUP_ACTIVE_SETTING_KEY_SET.has(key);
        }

        function renderProfile() {
            const canvasProfile = state.canvas?.profile || state.canvas?.response?.profile || null;
            const profile = resolveProfile(state.identity.state === "authenticated" ? state.identity.profile : null, canvasProfile);
            [q("#workspace-account-avatar"), q("#account-section-avatar")].filter(Boolean).forEach((avatar) => {
                avatar.textContent = profile.avatarUrl ? "" : profile.name ? profile.initials : "C";
                avatar.dataset.source = profile.source;
                avatar.style.backgroundImage = profile.avatarUrl ? `url("${profile.avatarUrl.replace(/"/g, "%22")}")` : "";
            });
            const profileName = profile.name || "Canvas workspace";
            const profileSource = profile.source === "nest" ? "Nest account" : profile.source === "canvas" ? "Canvas context" : "Local fallback";
            text("#workspace-account-name", profileName);
            text("#workspace-account-source", profileSource);
            const status = state.identity.state;
            const statusText = status === "checking" ? "Checking Nest connection…" : status === "authenticated" ? "Nest connected" : status === "signed_out" ? "Nest signed out" : status === "expired" ? "Nest session expired" : "Nest unavailable";
            const bindingText = state.canvas?.canvasBinding?.accountKey
                ? "Verified Canvas binding available."
                : "No verified Canvas binding in this workspace.";
            text("#workspace-account-status", statusText);
            text("#account-section-name", profileName);
            text("#account-section-source", profileSource);
            text("#account-section-status", statusText);
            text("#account-section-binding", bindingText);
            const identityCard = q(".account-identity-card");
            if (identityCard) identityCard.dataset.identityState = status;
            const calendarStatusText = status === "authenticated"
                ? "Nest connected. Open Account & calendar to review Canvas access."
                : status === "signed_out"
                    ? "Nest is signed out. Open Account & calendar to sign in."
                    : status === "expired"
                        ? "Your Nest session expired. Open Account & calendar to sign in again."
                        : "Nest connection status is unavailable.";
            text("#todo-calendar-sync-status", calendarStatusText);
            renderCanvasAccounts();
            renderModernEditors();
        }

        function renderCanvasAccounts() {
            const lists = [q("#workspace-canvas-account-list")].filter(Boolean);
            if (!lists.length || !doc?.createElement) return;
            const localAccounts = state.canvasAccounts.length ? state.canvasAccounts : (state.canvas?.accounts || []);
            const accounts = localAccounts.concat(state.identity.state === "authenticated" ? state.nestLinkedAccounts : []);
            const pending = state.canvas?.pendingAccounts || [];
            lists.forEach((list) => {
                list.replaceChildren();
                if (!accounts.length && !pending.length) {
                    const empty = doc.createElement("p");
                    empty.className = "profile-empty";
                    empty.textContent = "No linked Canvas accounts in this browser.";
                    list.appendChild(empty);
                    return;
                }
                accounts.forEach((account) => {
                    const card = doc.createElement("div");
                    card.className = "profile-account-card";
                    card.dataset.state = "linked";
                    card.textContent = `${cleanName(account.displayName || account.name) || "Canvas account"} · ${String(account.origin || "").replace(/^https:\/\//, "")}`;
                    list.appendChild(card);
                });
                pending.forEach((account) => {
                    const card = doc.createElement("div");
                    card.className = "profile-account-card is-pending";
                    card.dataset.state = "pending";
                    card.textContent = `${cleanName(account.displayName || account.name) || "Canvas account"} · pending verification`;
                    list.appendChild(card);
                });
            });
        }

        function renderIdentity() {
            const onboarding = q("#nest-onboarding");
            const nestEnabled = state.identity.state === "authenticated";
            const canSignIn = ["signed_out", "expired", "unavailable"].includes(state.identity.state);
            if (onboarding) {
                onboarding.hidden = !state.onboardingReady || !canSignIn || state.onboardingDismissed;
                onboarding.inert = onboarding.hidden;
                onboarding.setAttribute?.("aria-hidden", String(onboarding.hidden));
            }
            ["#nest-sign-in", "#calendar-nest-login"].map(q).filter(Boolean).forEach((cta) => {
                cta.hidden = !canSignIn;
                cta.inert = !canSignIn;
                cta.disabled = !canSignIn;
                cta.setAttribute?.("aria-hidden", String(!canSignIn));
                cta.setAttribute?.("aria-disabled", String(!canSignIn));
            });
            renderProfile();
        }

        const connection = connectionApi.create({
            readIdentity: () => request("NEST_IDENTITY_GET"),
            normalizeIdentity: normalizeIdentityResponse
        });
        connection.subscribe((snapshot) => {
            state.identityGeneration = snapshot.generation;
            state.identity = snapshot.identity;
            state.identityUserKey = snapshot.identity.state === "authenticated" ? identityKey(snapshot.identity) : "";
            state.nestLinkedAccounts = snapshot.identity.linkedAccounts || [];
            if (snapshot.identity.state !== "authenticated") {
                state.consent = null;
                state.calendars = null;
                const consentControl = q("#nest-consent-enabled");
                if (consentControl) consentControl.checked = false;
            }
            renderIdentity();
        });

        async function refreshIdentity() {
            connection.setContext(state.canvas?.canvasBinding || null);
            return (await connection.refresh({ force: true })).identity;
        }

        async function dismissOnboarding() {
            try { await storageSet("local", { [ONBOARDING_KEY]: true }); } catch (error) {}
            state.onboardingDismissed = true;
            renderIdentity();
        }

        let loginTabId = null;
        let loginAttempt = null;
        async function openNestLogin() {
            if (loginAttempt) return loginAttempt;
            loginAttempt = (async () => {
                let failure = null;
                if (Number.isInteger(loginTabId) && chromeService?.tabs?.get && chromeService?.tabs?.update) {
                    try {
                        const tab = await chromeService.tabs.get(loginTabId);
                        if (new URL(tab.url).origin === "https://nest.apstudy.org") return await chromeService.tabs.update(loginTabId, { active: true });
                    } catch (_) { /* A closed or navigated tab starts a fresh attempt. */ }
                    loginTabId = null;
                }
                if (typeof chromeService?.tabs?.create === "function") {
                    try {
                        const url = new URL(FULLSCREEN_URL);
                        const origin = state.canvas?.canvasBinding?.origin;
                        if (origin && /^https:\/\//.test(origin)) url.searchParams.set("return_to", `${new URL(origin).origin}/`);
                        const tab = await chromeService.tabs.create({ url: url.href });
                        loginTabId = Number.isInteger(tab?.id) ? tab.id : null;
                        return tab;
                    } catch (error) { failure = error; }
                }
                if (typeof win?.open === "function") {
                    try {
                        const opened = win.open(FULLSCREEN_URL, "_blank", "noopener");
                        if (!opened) throw new Error("NEST_LOGIN_BLOCKED");
                        return opened;
                    } catch (error) { failure = error; }
                }
                setStatus("Nest sign-in could not open. Try again.", true);
                throw failure || new Error("NEST_LOGIN_UNAVAILABLE");
            })();
            try { return await loginAttempt; } finally { loginAttempt = null; }
        }

        async function setupOnboarding() {
            try { state.onboardingDismissed = (await storageGet("local", ONBOARDING_KEY))[ONBOARDING_KEY] === true; } catch (error) { state.onboardingDismissed = false; }
            state.onboardingReady = true;
            renderIdentity();
        }

        function updateCategory(category, focus = false, enterDetail = true, confirmed = false) {
            if (!confirmed && win?.APStudyCanvasWorkspace?.activateCategory) {
                return win.APStudyCanvasWorkspace.activateCategory(category, true, { focus, enterDetail });
            }
            const nav = q(".workspace-nav");
            if (enterDetail && doc?.body?.dataset.navigationPage === "list") {
                categoryListScroll = nav?.scrollTop || 0;
                categoryListFocus = nav?.contains?.(doc.activeElement) ? doc.activeElement : q(`.workspace-nav [data-workspace-target="${category}"]`);
            }
            if (enterDetail && doc?.body) doc.body.dataset.navigationPage = "detail";
            state.category = normalizedCategory(category);
            qa(".workspace-nav [data-workspace-target]").forEach((node) => {
                const active = node.dataset.workspaceTarget === state.category;
                node.classList?.toggle("is-active", active);
                if (node.tabIndex !== undefined) node.tabIndex = active ? 0 : -1;
                if (active) node.setAttribute?.("aria-current", "page");
                else node.removeAttribute?.("aria-current");
            });
            const accountRoute = q("#workspace-account-trigger");
            if (accountRoute) {
                const active = state.category === "calendar-accounts";
                accountRoute.classList?.toggle("is-active", active);
                if (active) accountRoute.setAttribute?.("aria-current", "page");
                else accountRoute.removeAttribute?.("aria-current");
            }
            const nextSection = q(`#workspace-section-${state.category}`);
            if (nextSection) nextSection.hidden = false;
            if (focus || qa(".workspace-section[data-category]").some((section) => section !== nextSection && section.contains?.(doc.activeElement))) nextSection?.focus?.({ preventScroll: true });
            qa(".workspace-section[data-category]").forEach((section) => { section.hidden = section.dataset.category !== state.category; });
            const select = q("#workspace-category-select");
            if (select) {
                select.value = state.category;
                Array.from(select.options || []).forEach((option) => { option.selected = option.value === state.category; });
            }
            text("#workspace-category-count-value", `${CATEGORIES.length} categories`);
            syncWorkspaceNavigationMode();
            if (enterDetail) {
                const content = q(".workspace-content");
                if (content) content.scrollTop = 0;
            }
            if (focus) nextSection?.focus?.({ preventScroll: true });
            return state.category;
        }

        let categoryListScroll = 0;
        let categoryListFocus = null;

        function syncWorkspaceNavigationMode() {
            const nav = q(".workspace-nav");
            const back = q("#workspace-back");
            const content = q(".workspace-content");
            const sidebar = q(".workspace-sidebar");
            if (!nav) return;
            // CSS owns the breakpoint, including an iframe's zero-width first layout.
            const compact = Boolean(back && win?.getComputedStyle?.(back)?.display !== "none");
            state.compactNavigation = compact;
            const list = compact && doc?.body?.dataset.navigationPage !== "detail";
            // Expose the destination before moving focus, then hide the old pane.
            if (list) {
                if (sidebar) sidebar.inert = false;
                nav.inert = false;
                if (content?.contains?.(doc.activeElement)) (categoryListFocus || nav.querySelector?.("button"))?.focus?.();
            } else {
                if (content) content.inert = false;
                if (compact && sidebar?.contains?.(doc.activeElement)) back?.focus?.();
            }
            if (sidebar) {
                sidebar.inert = compact && !list;
                sidebar.setAttribute?.("aria-hidden", String(sidebar.inert));
            }
            if (content) {
                content.inert = list;
                content.setAttribute?.("aria-hidden", String(list));
            }
            nav.inert = compact && !list;
            nav.setAttribute?.("aria-hidden", String(nav.inert));
            qa(".workspace-nav [data-workspace-target]").forEach((node) => {
                node.tabIndex = list || node.dataset.workspaceTarget === state.category ? 0 : -1;
            });
            const select = q("#workspace-category-select");
            if (select) { select.tabIndex = -1; select.setAttribute?.("aria-hidden", "true"); }
            if (list && content?.contains?.(doc.activeElement)) (categoryListFocus || nav.querySelector?.("button"))?.focus?.();
            if (compact && !list && sidebar?.contains?.(doc.activeElement)) back?.focus?.();
        }

        function showCategoryList() {
            if (win?.APStudyCanvasWorkspace?.themeDraftDirty && !win.APStudyCanvasWorkspace.confirmLeave()) return false;
            if (doc?.body) doc.body.dataset.navigationPage = "list";
            syncWorkspaceNavigationMode();
            const nav = q(".workspace-nav");
            if (nav) nav.scrollTop = categoryListScroll;
            (categoryListFocus || q(`.workspace-nav [data-workspace-target="${state.category}"]`) || nav?.querySelector?.("button"))?.focus?.({ preventScroll: true });
        }

        function bindCategories() {
            q("#workspace-back")?.addEventListener?.("click", showCategoryList);
            qa("[data-workspace-target]").forEach((node) => node.addEventListener?.("click", () => {
                // edit-canvas owns draft confirmation and URL updates when present.
                if (win?.APStudyCanvasWorkspace?.activateCategory) return;
                updateCategory(node.dataset.workspaceTarget, true);
            }));
        }

        function renderCanvasAvailability() {
            const hasCanvas = Number.isInteger(state.canvas?.sourceTabId) || state.canvas?.state === "connected" || state.canvas?.response?.state === "connected";
            const liveCategories = new Set(["appearance", "sidebar", "course-cards", "themes"]);
            qa("[data-canvas-load-note]").forEach((node) => {
                const category = node.closest?.(".workspace-section")?.dataset?.category;
                if (!hasCanvas) {
                    node.textContent = "No Canvas tab is open — changes save now and apply next Canvas load.";
                    node.hidden = false;
                    return;
                }
                if (liveCategories.has(category)) {
                    node.hidden = true;
                    return;
                }
                if (category === "study-tools" || category === "gpa-grades") {
                    node.textContent = "These settings need a Canvas refresh to take effect.";
                    node.hidden = false;
                    return;
                }
                node.hidden = true;
            });
            const sidebarNote = q("#workspace-section-sidebar [data-canvas-load-note]");
            if (sidebarNote && state.sidebarNeedsNextLoad) {
                sidebarNote.textContent = "Saved. Applies on the next Canvas load.";
                sidebarNote.hidden = false;
            } else if (sidebarNote && hasCanvas) {
                sidebarNote.hidden = true;
            }
            const notice = q("#no-canvas-notice");
            if (notice) {
                notice.textContent = hasCanvas ? "Changes save now and appear after the next Canvas load when the setting is supported." : "No Canvas tab is open — changes save now and apply next Canvas load.";
                notice.hidden = hasCanvas;
            }
        }

        function hasTimeObject(control) {
            return control?.hasAttribute?.("data-time-object") === true
                || Object.prototype.hasOwnProperty.call(control?.dataset || {}, "timeObject");
        }

        function setControlValue(control, value) {
            if (!control) return;
            if (control.type === "checkbox" || control.type === "radio") {
                if (control.dataset?.settingValue !== undefined) {
                    const key = control.dataset?.popupSetting;
                    const normalized = key === "dashboard_compact_padding"
                        ? (settingsSchemaApi?.normalizeDashboardCompactPadding?.(value) ?? value)
                        : value;
                    control.checked = String(control.dataset.settingValue) === String(normalized);
                } else {
                    control.checked = value === true;
                }
            }
            else if (value !== undefined && value !== null) control.value = hasTimeObject(control) && typeof value === "object"
                ? `${value.hour}:${value.minute}` : String(value);
            // The native control remains authoritative; this event preserves
            // the programmatic-value notification contract for consumers.
            try { control.dispatchEvent?.(new Event("apstudy:value", { bubbles: true })); } catch (error) {}
        }

        function canonicalTimeValue(value) {
            if (!value || typeof value !== "object") return null;
            const hour = String(value.hour ?? "");
            const minute = String(value.minute ?? "");
            return /^(?:[01]\d|2[0-3])$/.test(hour) && /^[0-5]\d$/.test(minute)
                ? { hour, minute }
                : null;
        }

        function savedPopupSetting(key) {
            return Object.prototype.hasOwnProperty.call(state.popupSettings, key)
                ? clone(state.popupSettings[key])
                : clone(defaults[key]);
        }

        function renderBackgroundDependencies() {
            const url = q("#custom-background-link-workspace")?.value || "";
            const valid = isHttpsAvatar(url);
            q("#workspace-background-controls")?.setAttribute("data-background-active", String(valid));
            qa("[data-background-dependent]").forEach((control) => {
                control.disabled = !valid;
                control.setAttribute("aria-disabled", String(!valid));
            });
        }

        function isSidebarSettingKey(key) {
            return SIDEBAR_SETTING_KEYS.includes(key);
        }

        function sidebarControlValue(key) {
            return Object.prototype.hasOwnProperty.call(state.sidebarSettings, key)
                ? state.sidebarSettings[key]
                : sidebarDefaults(defaults)[key];
        }

        // These rows are the only ones that actually get dimmed at runtime, and
        // dimming on its own says nothing: it has to be aria-disabled plus a
        // sentence the user can read. The reason sits inside the row's <label>,
        // which is safe here only because every dependent control carries an
        // explicit aria-label, so label text never reaches the accessible name.
        const SIDEBAR_DEPENDENCY_REASON = "Turn on Enable New Sidebar to change this.";

        function setSidebarDependencyReason(row, disabled, index) {
            if (!row?.querySelector) return;
            const existing = row.querySelector(".control-disabled-reason");
            if (!disabled) {
                existing?.remove?.();
                row.querySelectorAll?.("input, select, button, textarea").forEach((control) => {
                    if (control.getAttribute?.("aria-describedby")?.startsWith("sidebar-dependency-reason-")) {
                        control.removeAttribute?.("aria-describedby");
                    }
                });
                return;
            }
            const id = `sidebar-dependency-reason-${index}`;
            let reason = existing;
            if (!reason) {
                reason = doc.createElement("span");
                reason.className = "control-disabled-reason";
                reason.textContent = SIDEBAR_DEPENDENCY_REASON;
                row.appendChild?.(reason);
            }
            reason.id = id;
            row.querySelectorAll?.("input, select, button, textarea").forEach((control) => {
                if (!control.getAttribute?.("aria-describedby")) control.setAttribute?.("aria-describedby", id);
            });
        }

        function renderSidebarDependencies() {
            const enabled = state.sidebarSettings.better_sidebar === true;
            const section = q("#workspace-section-sidebar");
            if (section) {
                section.dataset.sidebarEnabled = enabled ? "true" : "false";
                section.setAttribute?.("aria-busy", "false");
            }
            qa("[data-sidebar-control]").forEach((node, index) => {
                const kind = node.dataset?.sidebarControl;
                const dependent = ["layout", "collapsed", "advanced-layout"].includes(kind);
                if (!dependent) return;
                node.classList?.toggle("is-disabled", !enabled);
                node.setAttribute?.("aria-disabled", String(!enabled));
                node.querySelectorAll?.("input, select, button, textarea").forEach((control) => {
                    control.disabled = !enabled;
                    control.setAttribute?.("aria-disabled", String(!enabled));
                });
                setSidebarDependencyReason(node, !enabled, index);
            });
        }

        function sidebarCanvasSnapshot() {
            const source = state.canvas?.sidebarContext || {};
            const accountKey = typeof source.accountKey === "string" && /^[a-f0-9]{64}$/.test(source.accountKey) ? source.accountKey : null;
            const courses = source.courses || source.activeCourses || source.courseRecords;
            return { source, accountKey, courses: Array.isArray(courses) ? courses : [] };
        }

        function sidebarCourseOrderStorageKey(accountKey) {
            if (typeof accountKey !== "string" || !/^[a-f0-9]{64}$/.test(accountKey)) return null;
            return settingsSchemaApi?.courseOrderStorageKey?.(accountKey)
                || `apstudycanvas.sidebar.course-order.v1:${accountKey}`;
        }

        function normalizePopupCourseColor(value) {
            if (typeof value !== "string") return "";
            const normalized = value.trim();
            return /^(?:#[0-9a-f]{3,8}|rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+(?:\s*,\s*[\d.]+)?\s*\))$/i.test(normalized) ? normalized : "";
        }

        function normalizePopupCourseHref(value, origin, id) {
            if (typeof value !== "string" || !origin || !id) return "";
            try {
                const url = new URL(value, origin);
                if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password || url.hash) return "";
                if (url.pathname !== `/courses/${id}` && !url.pathname.startsWith(`/courses/${id}/`)) return "";
                return url.href;
            } catch (error) { return ""; }
        }

        function normalizePopupCourses(courses, origin) {
            const result = [];
            const seen = new Set();
            courses.forEach((course, index) => {
                const id = String(course?.id ?? course?.courseId ?? course?.course_id ?? "").trim();
                const name = cleanName(course?.name || course?.courseName || course?.course_code || "");
                const href = normalizePopupCourseHref(course?.href || course?.url, origin, id);
                if (!/^[1-9]\d{0,19}$/.test(id) || !name || !href || course?.available === false || course?.published === false || course?.concluded === true || seen.has(id)) return;
                seen.add(id);
                result.push({ id, name, href, color: normalizePopupCourseColor(course.color), sourceOrder: index });
            });
            return result;
        }

        function reconcilePopupCourseOrder(courses, saved) {
            const byId = new Map(courses.map((course) => [course.id, course]));
            const order = [];
            const seen = new Set();
            (Array.isArray(saved) ? saved : []).forEach((id) => {
                const value = String(id || "");
                if (byId.has(value) && !seen.has(value)) { seen.add(value); order.push(value); }
            });
            courses.forEach((course) => { if (!seen.has(course.id)) { seen.add(course.id); order.push(course.id); } });
            return { order, courses: order.map((id) => byId.get(id)).filter(Boolean) };
        }

        async function loadSidebarCourseOrder(expectedGeneration = state.sidebarContextGeneration) {
            const { accountKey, source, courses: rawCourses } = sidebarCanvasSnapshot();
            const courses = normalizePopupCourses(rawCourses, source.origin);
            const key = sidebarCourseOrderStorageKey(accountKey);
            state.sidebarCourseOrderKey = key;
            state.sidebarCourseOrderAvailable = Boolean(key && courses.length);
            state.sidebarCourses = courses;
            state.sidebarCourseOrder = courses.map((course) => course.id);
            if (key && courses.length) {
                try {
                    const stored = await storageGet("local", [key]);
                    if (expectedGeneration !== state.sidebarContextGeneration || key !== state.sidebarCourseOrderKey) return false;
                    const reconciled = reconcilePopupCourseOrder(courses, stored?.[key]);
                    state.sidebarCourses = reconciled.courses;
                    state.sidebarCourseOrder = reconciled.order;
                } catch (error) {
                    if (expectedGeneration !== state.sidebarContextGeneration || key !== state.sidebarCourseOrderKey) return false;
                    state.sidebarCourseOrderAvailable = false;
                }
            }
            if (expectedGeneration !== state.sidebarContextGeneration) return false;
            renderSidebarCourseEditor();
            return state.sidebarCourseOrderAvailable;
        }

        async function persistSidebarCourseOrder(next, focusCourse = null) {
            const key = state.sidebarCourseOrderKey;
            if (!key || !state.sidebarCourseOrderAvailable) throw new Error("SIDEBAR_COURSE_ORDER_UNAVAILABLE");
            const previous = state.sidebarCourseOrder.slice();
            const canonical = reconcilePopupCourseOrder(state.sidebarCourses, next).order;
            state.sidebarCourseOrder = canonical;
            state.sidebarCourses = canonical.map((id) => state.sidebarCourses.find((course) => course.id === id)).filter(Boolean);
            renderSidebarCourseEditor();
            if (focusCourse) q(`#sidebar-course-order-editor [data-course-id="${focusCourse}"]`)?.focus?.();
            try {
                await storageSet("local", { [key]: canonical });
                const refresh = await refreshSidebarCourseOrderLive();
                const nextLoad = setSidebarApplyOutcome(refresh);
                setStatus(nextLoad ? "Saved. Applies next Canvas load." : "Saved.");
                return { ok: true, order: canonical.slice(), ...refresh, appliesNextLoad: nextLoad };
            } catch (error) {
                state.sidebarCourseOrder = previous;
                state.sidebarCourses = previous.map((id) => state.sidebarCourses.find((course) => course.id === id)).filter(Boolean);
                renderSidebarCourseEditor();
                if (focusCourse) q(`#sidebar-course-order-editor [data-course-id="${focusCourse}"]`)?.focus?.();
                setStatus("Failed — course order reverted.", true);
                throw error;
            }
        }

        function clearSidebarDrag() {
            const active = sidebarDrag;
            sidebarDrag = null;
            if (active?.row?.classList?.remove) active.row.classList.remove("is-dragging", "is-drag-over");
            try {
                doc?.querySelectorAll?.(".sidebar-page-row, .sidebar-course-order-row")?.forEach?.((row) => row.classList?.remove?.("is-dragging", "is-drag-over"));
            } catch (error) {}
        }

        function sidebarDragAccountKey(kind) {
            if (kind === "course") return state.sidebarCourseOrderKey;
            return sidebarCanvasSnapshot().accountKey || "";
        }

        function bindSidebarDrag(row, kind, id) {
            const handle = row.querySelector?.("[data-sidebar-drag-handle]");
            if (!handle || !row.addEventListener) return;
            handle.draggable = true;
            handle.addEventListener("dragstart", (event) => {
                const stableId = String(id || "");
                const valid = kind === "course" ? /^[1-9]\d{0,19}$/.test(stableId) : /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(stableId);
                const accountKey = sidebarDragAccountKey(kind);
                if (!valid || (kind === "course" && !accountKey)) { event.preventDefault?.(); return; }
                sidebarDrag = { kind, id: stableId, accountKey, row };
                row.classList?.add?.("is-dragging");
                try {
                    event.dataTransfer?.setData?.("text/plain", `${kind}:${stableId}`);
                    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
                } catch (error) {}
            });
            handle.addEventListener("dragend", () => clearSidebarDrag());
            row.addEventListener("dragover", (event) => {
                if (!sidebarDrag || sidebarDrag.kind !== kind || sidebarDrag.id === String(id) || sidebarDrag.accountKey !== sidebarDragAccountKey(kind)) return;
                event.preventDefault?.();
                try { if (event.dataTransfer) event.dataTransfer.dropEffect = "move"; } catch (error) {}
                row.classList?.add?.("is-drag-over");
            });
            row.addEventListener("dragleave", () => row.classList?.remove?.("is-drag-over"));
            row.addEventListener("drop", (event) => {
                event.preventDefault?.();
                const active = sidebarDrag;
                const targetId = String(id || "");
                clearSidebarDrag();
                if (!active || active.kind !== kind || active.id === targetId || active.accountKey !== sidebarDragAccountKey(kind)) return;
                const current = kind === "page" ? state.sidebarOrder.slice() : state.sidebarCourseOrder.slice();
                const from = current.indexOf(active.id);
                const to = current.indexOf(targetId);
                if (from < 0 || to < 0) return;
                current.splice(from, 1);
                current.splice(to, 0, active.id);
                const label = kind === "page"
                    ? state.sidebarPages.find((page) => page.id === active.id)?.label || active.id
                    : state.sidebarCourses.find((course) => course.id === active.id)?.name || active.id;
                const onResult = (result) => {
                    if (result?.ok) setStatus(`Moved ${label}.`);
                    else if (result?.current !== false) setStatus(`Failed — ${kind} order reverted.`, true);
                };
                const operation = kind === "page"
                    ? persistSidebarOrder(current, active.id, { onResult })
                    : persistSidebarCourseOrder(current, active.id);
                Promise.resolve(operation).then((result) => { if (kind === "course" && result?.ok) setStatus(`Moved ${label}.`); }).catch(() => {});
            });
        }

        function renderSidebarCourseEditor() {
            const editor = q("#sidebar-course-order-editor");
            if (!editor || !doc?.createElement) return;
            editor.replaceChildren?.();
            if (!state.sidebarCourseOrderAvailable || !state.sidebarCourses.length) {
                const empty = doc.createElement("p");
                empty.className = "sidebar-empty-state";
                empty.textContent = "Open this editor from a Canvas tab to load active courses for ordering.";
                editor.appendChild?.(empty);
                return;
            }
            const list = doc.createElement("ol");
            list.className = "sidebar-course-order-list";
            list.setAttribute?.("aria-label", "Course order for this Canvas account");
            state.sidebarCourses.forEach((course, index) => {
                const row = doc.createElement("li");
                row.className = "sidebar-course-order-row";
                row.dataset.courseId = course.id;
                row.draggable = false;
                row.innerHTML = `<span class="drag-handle" data-sidebar-drag-handle="true" role="img" aria-label="Drag to reorder ${course.name}">⠿</span><span class="sidebar-course-dot" aria-hidden="true"></span><span class="sidebar-course-name"></span><button type="button" class="workspace-action" data-course-move="up" aria-label="Move ${course.name} up">↑</button><button type="button" class="workspace-action" data-course-move="down" aria-label="Move ${course.name} down">↓</button>`;
                bindSidebarDrag(row, "course", course.id);
                const name = row.querySelector?.(".sidebar-course-name");
                if (name) name.textContent = course.name;
                const dot = row.querySelector?.(".sidebar-course-dot");
                if (dot && course.color) dot.style.backgroundColor = course.color;
                row.querySelectorAll?.("[data-course-move]").forEach((button) => button.addEventListener?.("click", () => {
                    const direction = button.dataset.courseMove === "up" ? -1 : 1;
                    const nextIndex = index + direction;
                    if (nextIndex < 0 || nextIndex >= state.sidebarCourses.length) return;
                    const next = state.sidebarCourses.map((item) => item.id);
                    [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
                    persistSidebarCourseOrder(next, course.id).catch(() => {});
                }));
                list.appendChild?.(row);
            });
            editor.appendChild?.(list);
        }

        function renderSidebarControls() {
            qa("[data-popup-setting]").filter((control) => isSidebarSettingKey(control.dataset?.popupSetting)).forEach((control) => {
                const key = control.dataset.popupSetting;
                const value = sidebarControlValue(key);
                const displayValue = key === "sidebar_density" ? sidebarDensityPreset(value) === "compact" ? "compact" : "comfortable" : value;
                setControlValue(control, displayValue);
                if (control.dataset) control.dataset.sidebarCommittedValue = String(displayValue ?? "");
            });
            const width = q("[data-sidebar-preset='width']");
            const density = q("[data-sidebar-preset='density']");
            const size = q("[data-sidebar-preset='size']");
            setControlValue(width, sidebarWidthPreset(state.sidebarSettings));
            setControlValue(density, sidebarDensityPreset(state.sidebarSettings.sidebar_density));
            setControlValue(size, sidebarSizePreset(state.sidebarSettings));
            const hiddenToggle = q("#sidebar-toggle-hidden");
            const hiddenCount = state.sidebarOrder.filter((page) => state.sidebarVisibility?.[page] === false).length;
            if (hiddenToggle) {
                hiddenToggle.hidden = hiddenCount === 0;
                hiddenToggle.textContent = state.sidebarShowHidden ? "Hide hidden" : `Show hidden (${hiddenCount})`;
                hiddenToggle.setAttribute?.("aria-pressed", String(state.sidebarShowHidden));
                if (hiddenToggle.dataset?.sidebarBound !== "true") {
                    hiddenToggle.addEventListener?.("click", () => {
                        state.sidebarShowHidden = !state.sidebarShowHidden;
                        renderSidebarOrder(state.sidebarOrder);
                        renderSidebarControls();
                    });
                    if (hiddenToggle.dataset) hiddenToggle.dataset.sidebarBound = "true";
                }
            }
            renderSidebarCourseEditor();
            renderSidebarDependencies();
        }

        function setSidebarApplyOutcome(outcome) {
            const nextLoad = outcome?.appliesNextLoad === true || outcome?.applied !== true;
            state.sidebarNeedsNextLoad = nextLoad;
            const note = q("#workspace-section-sidebar [data-canvas-load-note]");
            if (note) {
                note.textContent = nextLoad ? "Saved. Applies on the next Canvas load." : "Canvas updated live.";
                note.hidden = !nextLoad;
            }
            return nextLoad;
        }

        async function resolveLiveCanvasTab() {
            const tabId = normalizeSourceCanvasTabId(state.canvas?.sourceTabId);
            if (tabId === null || !chromeService?.tabs?.sendMessage) return null;
            let tab = { id: tabId };
            if (typeof chromeService.tabs.get === "function") {
                try { tab = await chromeService.tabs.get(tabId); } catch (error) { return null; }
            }
            if (!Number.isSafeInteger(tab?.id) || tab.id !== tabId) return null;
            if (typeof tab.url === "string" && tab.url) {
                try {
                    if (new URL(tab.url).protocol !== "https:") return null;
                } catch (error) { return null; }
            }
            if (state.canvas?.state && state.canvas.state !== "connected") return null;
            return tab;
        }

        async function refreshSidebarCourseOrderLive() {
            const tab = await resolveLiveCanvasTab();
            if (!tab) return { ok: true, refreshed: false, applied: false, appliesNextLoad: true };
            const message = {
                version: 1,
                request_id: String(`popup-sidebar-refresh-${now()}-${++sidebarLiveSequence}`).slice(0, 160),
                type: "SIDEBAR_REFRESH",
                payload: { reason: "course-order" }
            };
            try {
                const response = await chromeService.tabs.sendMessage(tab.id, message, { frameId: 0 });
                const result = response?.payload || response;
                const refreshed = result?.ok === true && result?.refreshed === true;
                return {
                    ok: true,
                    refreshed,
                    applied: refreshed,
                    appliesNextLoad: !refreshed,
                    tabId: tab.id,
                    response: result
                };
            } catch (error) {
                return { ok: true, refreshed: false, applied: false, appliesNextLoad: true, error };
            }
        }

        async function applyLiveSettings(changes) {
            const liveKeys = Object.keys(changes || {}).filter((key) => liveApplyMode(key) === "live");
            const reloadKeys = Object.keys(changes || {}).filter((key) => liveApplyMode(key) === "reload");
            if (!liveKeys.length && reloadKeys.length) {
                return { ok: true, applied: false, appliesNextLoad: true, reloadKeys };
            }
            if (!liveKeys.length) return { ok: true, applied: false, appliesNextLoad: false, ignored: true, reloadKeys };
            try {
                if (typeof liveApply === "function") {
                    const result = await liveApply(clone(changes), clone(state.canvas));
                    if (result === false || result?.ok === false) throw new Error(result?.code || "CANVAS_SETTINGS_APPLY_FAILED");
                    const applied = result === true || result?.applied === true;
                    return {
                        ok: true,
                        ...(isPlainObject(result) ? result : {}),
                        applied,
                        appliesNextLoad: result?.appliesNextLoad === true || !applied || reloadKeys.length > 0,
                        reloadKeys
                    };
                }
                const tab = await resolveLiveCanvasTab();
                if (!tab) return { ok: true, applied: false, appliesNextLoad: true, reloadKeys };
                const message = createLiveSettingsUpdateMessage(changes, `popup-live-${now()}-${++sidebarLiveSequence}`);
                if (!message) return { ok: true, applied: false, appliesNextLoad: reloadKeys.length > 0, reloadKeys };
                const response = await chromeService.tabs.sendMessage(tab.id, message, { frameId: 0 });
                const result = response?.payload || response;
                if (result === false || result?.ok === false) throw new Error(result?.code || "CANVAS_SETTINGS_APPLY_FAILED");
                const applied = result?.applied === true;
                return {
                    ok: true,
                    applied,
                    appliesNextLoad: result?.appliesNextLoad === true || !applied || reloadKeys.length > 0,
                    tabId: tab.id,
                    rendered: result?.rendered === true,
                    appliedKeys: result?.appliedKeys,
                    reloadKeys: result?.reloadKeys?.length ? result.reloadKeys : reloadKeys
                };
            } catch (error) {
                return { ok: true, applied: false, appliesNextLoad: true, reloadKeys, error };
            }
        }

        async function applySidebarLive(changes) {
            return applyLiveSettings(changes);
        }

        async function persistSidebarField(key, value) {
            if (!settingsStore?.updateField) throw new Error("SETTINGS_STORE_UNAVAILABLE");
            const pending = Promise.resolve(settingsStore.updateField(key, clone(value)));
            const flush = typeof settingsStore.flush === "function" ? Promise.resolve(settingsStore.flush()) : pending;
            await Promise.all([pending, flush]);
        }

        async function commitSidebarChanges(changes, previous = {}, { transaction = false } = {}) {
            const normalized = normalizeSidebarLiveChanges(changes);
            if (!normalized || !Object.keys(normalized).length) throw new Error("SIDEBAR_SETTING_INVALID");
            const keys = Object.keys(normalized);
            const before = Object.fromEntries(keys.map((key) => [key, clone(Object.prototype.hasOwnProperty.call(previous, key) ? previous[key] : sidebarControlValue(key))]));
            const operation = beginSidebarOperation(keys);
            Object.entries(normalized).forEach(([key, value]) => { state.sidebarSettings[key] = clone(value); });
            if (Object.prototype.hasOwnProperty.call(normalized, "sidebar_page_order")) {
                state.sidebarOrder = normalized.sidebar_page_order.slice();
                renderSidebarOrder(state.sidebarOrder);
            }
            if (Object.prototype.hasOwnProperty.call(normalized, "sidebar_page_visibility")) {
                state.sidebarVisibility = clone(normalized.sidebar_page_visibility);
                renderSidebarOrder(state.sidebarOrder);
            }
            renderSidebarControls();
            setStatus("Saving…");
            return enqueueSidebarOperation(async () => {
                const succeededKeys = [];
                try {
                    if (transaction) {
                        await settingsStore.transaction(normalized, { read: () => storageGet("sync", keys) });
                        keys.forEach((key) => { markSidebarPersisted(key, normalized[key]); succeededKeys.push(key); });
                    } else {
                        for (const [key, value] of Object.entries(normalized)) {
                            await persistSidebarField(key, value);
                            markSidebarPersisted(key, value);
                            succeededKeys.push(key);
                        }
                    }
                    const currentKeys = keys.filter((key) => isCurrentSidebarOperation(operation, key));
                    const liveChanges = Object.fromEntries(currentKeys.map((key) => [key, normalized[key]]));
                    const outcome = Object.keys(liveChanges).length
                        ? await applySidebarLive(liveChanges)
                        : { ok: true, applied: false, appliesNextLoad: true, stale: true };
                    if (Object.keys(liveChanges).length) {
                        const nextLoad = setSidebarApplyOutcome(outcome);
                        if (currentKeys.length) setStatus(nextLoad ? "Saved. Applies next Canvas load." : "Saved.");
                        return { ok: true, changes: clone(normalized), ...outcome, appliesNextLoad: nextLoad, current: currentKeys.length === keys.length };
                    }
                    return { ok: true, changes: clone(normalized), ...outcome, appliesNextLoad: true, current: false };
                } catch (error) {
                    const failedKeys = failedSidebarKeys(error, keys, succeededKeys);
                    let restored = false;
                    keys.forEach((key) => {
                        if (!failedKeys.has(key) || !isCurrentSidebarOperation(operation, key)) return;
                        restoreSidebarKey(key, before[key]);
                        restored = true;
                    });
                    if (restored) {
                        renderSidebarOrder(state.sidebarOrder);
                        renderSidebarControls();
                        setStatus("Failed — changes reverted.", true);
                    }
                    throw error;
                }
            });
        }

        function readSidebarControlValue(control) {
            if (control.type === "checkbox") return control.checked === true;
            return control.value;
        }

        function commitSidebarControl(control) {
            const key = control?.dataset?.popupSetting;
            if (!isSidebarSettingKey(key) || control.disabled) return Promise.resolve({ ok: false, disabled: true });
            const raw = readSidebarControlValue(control);
            if (control.dataset?.valueType === "number") {
                const candidate = String(raw ?? "").trim();
                if (!candidate || !/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(candidate) || !Number.isFinite(Number(candidate))) {
                    setControlValue(control, sidebarControlValue(key));
                    control.setAttribute?.("aria-invalid", "true");
                    setStatus("Failed — enter a valid number; nothing was saved.", true);
                    return Promise.resolve({ ok: false, invalid: true });
                }
                const value = normalizeSidebarNumber(key, Number(candidate));
                control.setAttribute?.("aria-invalid", "false");
                setControlValue(control, value);
                return commitSidebarChanges({ [key]: value }, { [key]: sidebarControlValue(key) });
            }
            return commitSidebarChanges({ [key]: raw }, { [key]: sidebarControlValue(key) });
        }

        function commitSidebarPreset(control) {
            if (!control || control.disabled) return Promise.resolve({ ok: false, disabled: true });
            const kind = control.dataset?.sidebarPreset;
            const changes = sidebarPresetChanges(kind, control.value, state.sidebarSettings);
            if (!changes) return Promise.resolve({ ok: false, invalid: true });
            if (state.sidebarSettings.better_sidebar !== true) return Promise.resolve({ ok: false, disabled: true });
            const previous = Object.fromEntries(Object.keys(changes).map((key) => [key, clone(sidebarControlValue(key))]));
            return commitSidebarChanges(changes, previous, { transaction: true });
        }

        // U-8: better_todo is destructive to Canvas-owned content — enabling it
        // empties Canvas's own #right-side (js/content.js setupBetterTodo) and
        // keeps only .events_list.recent_feedback. The factory default is on,
        // while the readout makes
        // the current side of that line unambiguous next to the toggle.
        function renderBetterTodoOptIn(value) {
            const readout = q("#better-todo-optin-state");
            if (!readout) return;
            const on = value === true;
            // Latch, matching the GPA live region: loadPopupSettings() and every
            // SETTINGS_UPDATE broadcast re-render this row, and rewriting the
            // same sentence into an aria-live region makes screen readers
            // announce it again. The markup already ships the "off" copy.
            const next = on ? "on" : "off";
            const current = readout.dataset ? readout.dataset.state : readout.getAttribute?.("data-state");
            if (current === next) return;
            readout.textContent = on
                ? "On — APStudy owns Canvas\u2019s right sidebar and updates it live."
                : "Off — Canvas still owns its right sidebar.";
            if (readout.dataset) readout.dataset.state = on ? "on" : "off";
            else readout.setAttribute?.("data-state", on ? "on" : "off");
        }

        function resolvedExtensionTheme(overrides = {}) {
            const settings = {
                extension_theme: overrides.extension_theme ?? state.popupSettings.extension_theme ?? defaults.extension_theme ?? "canvas",
                device_dark: overrides.device_dark ?? state.popupSettings.device_dark ?? defaults.device_dark,
                dark_mode: overrides.dark_mode ?? state.popupSettings.dark_mode ?? defaults.dark_mode
            };
            return settingsSchemaApi?.resolveExtensionTheme?.(settings)
                || (settings.extension_theme === "light" || settings.extension_theme === "dark" ? settings.extension_theme : settings.device_dark === true ? "system" : settings.dark_mode === true ? "dark" : "light");
        }

        function renderExtensionTheme(overrides = {}) {
            const theme = resolvedExtensionTheme(overrides);
            if (theme === "system") doc?.documentElement?.removeAttribute?.("data-extension-theme");
            else doc?.documentElement?.setAttribute?.("data-extension-theme", theme);
        }

        async function loadPopupSettings() {
            const controls = qa("[data-popup-setting]").filter((control) => {
                const key = control.dataset?.popupSetting;
                return isActivePopupSettingKey(key) && !isSidebarSettingKey(key) && !COMPATIBILITY_ONLY_SYNC_SETTING_KEYS.has(key);
            });
            if (!controls.length) return;
            const keys = Array.from(new Set(controls.map((control) => control.dataset.popupSetting)));
            let values = {};
            try {
                values = await storageGet("sync", Array.from(new Set([...keys, "better_todo", "streak_visible", "todo_progress_rings", "todo_confetti", "num_todo_items", "todo_hr24", "hover_preview"])));
            } catch (error) { setStatus("Settings unavailable.", true); throw error; }
            const todoSnapshot = settingsSchemaApi?.todoSettingsSnapshot?.(values) || {};
            controls.forEach((control) => {
                const key = control.dataset.popupSetting;
                const value = TODO_SETTING_KEYS.includes(key)
                    ? (todoSnapshot[key] !== undefined ? todoSnapshot[key] : defaults[key])
                    : (values[key] !== undefined ? values[key] : defaults[key]);
                state.popupSettings[key] = clone(value);
                setControlValue(control, hasTimeObject(control) && value && typeof value === "object"
                    ? `${value.hour}:${value.minute}` : value);
                const output = control.dataset.output ? q(`#${control.dataset.output}`) : null;
                if (output) output.textContent = String(value);
                if (key === "better_todo") renderBetterTodoOptIn(value);
                if (key === "todo_enabled") renderBetterTodoOptIn(value);
            });
            renderExtensionTheme();
            renderBackgroundDependencies();
        }

        function bindPopupSettings() {
            if (!settingsStore) return;
            qa("[data-popup-setting]").forEach((control) => {
                const key = control.dataset?.popupSetting;
                if (!isActivePopupSettingKey(key) || COMPATIBILITY_ONLY_SYNC_SETTING_KEYS.has(key)) return;
                if (isSidebarSettingKey(key)) {
                    const commit = () => { commitSidebarControl(control).catch(() => {}); };
                    control.addEventListener?.("change", commit);
                    if (control.dataset?.valueType === "number") {
                        control.addEventListener?.("blur", commit);
                        control.addEventListener?.("keydown", (event) => {
                            if (event.key !== "Enter") return;
                            event.preventDefault?.();
                            commit();
                        });
                    }
                    return;
                }
                control.addEventListener?.("change", () => {
                    // The compact-padding trio shares one storage key: checking
                    // a segment clears its siblings here so the UI never shows
                    // two levels, and unchecking the active segment stores the
                    // explicit "off" level.
                    if (control.type === "checkbox" && control.dataset?.settingValue !== undefined && control.checked) {
                        qa(`[data-popup-setting="${key}"]`).forEach((peer) => {
                            if (peer !== control && peer.dataset?.settingValue !== undefined) peer.checked = false;
                        });
                    }
                    const rawValue = control.type === "checkbox"
                        ? (control.dataset?.settingValue !== undefined ? (control.checked ? control.dataset.settingValue : "off") : control.checked)
                        : control.value;
                    const timeObject = hasTimeObject(control);
                    const timeParts = timeObject ? /^(?:[01]\d|2[0-3]):[0-5]\d$/.exec(String(rawValue)) : null;
                    if (timeObject && !timeParts) {
                        const saved = canonicalTimeValue(savedPopupSetting(key));
                        setControlValue(control, saved ? `${saved.hour}:${saved.minute}` : "");
                        control.setAttribute?.("aria-invalid", "true");
                        setStatus("Failed — enter a valid time; nothing was saved.", true);
                        return;
                    }
                    const value = timeObject
                        ? { hour: rawValue.slice(0, 2), minute: rawValue.slice(3, 5) }
                        : control.dataset.valueType === "number" ? Number(rawValue) : rawValue;
                    if (timeObject) control.setAttribute?.("aria-invalid", "false");
                    const output = control.dataset.output ? q(`#${control.dataset.output}`) : null;
                    if (output) output.textContent = String(value);
                    if (key === "better_todo") renderBetterTodoOptIn(value);
                    if (key === "todo_enabled") renderBetterTodoOptIn(value);
                    const changes = {
                        [key]: value,
                        ...(settingsSchemaApi?.todoLegacyCompatibilityChanges?.(key, value) || {}),
                        ...(settingsSchemaApi?.courseCardTaskExclusivityChanges?.(key, value) || {})
                    };
                    if (["extension_theme", "dark_mode", "device_dark"].some((themeKey) => Object.prototype.hasOwnProperty.call(changes, themeKey))) renderExtensionTheme(changes);
                    Object.entries(changes).forEach(([changedKey, changedValue]) => {
                        if (changedKey === key) return;
                        qa(`[data-popup-setting="${changedKey}"]`).forEach((peer) => setControlValue(peer, changedValue));
                    });
                    qa(`[data-popup-setting="${key}"]`).forEach((peer) => {
                        if (peer !== control) setControlValue(peer, value);
                    });
                    settingsStore.transaction(changes)
                        .then(() => applyLiveSettings(changes))
                        .then((outcome) => {
                            Object.entries(changes).forEach(([changedKey, changedValue]) => {
                                state.popupSettings[changedKey] = clone(changedValue);
                            });
                            const nextLoad = outcome?.appliesNextLoad === true && outcome?.applied !== true;
                            setStatus(nextLoad ? "Saved. Refresh Canvas to see this change." : "Saved.");
                        })
                        .catch(() => {
                            loadPopupSettings().finally(() => setStatus("Failed — changes reverted.", true));
                        });
                    if (key === "customBackgroundLink") renderBackgroundDependencies();
                });
            });
            qa("[data-sidebar-preset]").forEach((control) => {
                control.addEventListener?.("change", () => { commitSidebarPreset(control).catch(() => {}); });
            });
        }

        async function persistSidebarOrder(next, focusPage = null, options = {}) {
            if (!settingsStore) throw new Error("SETTINGS_STORE_UNAVAILABLE");
            const callbacks = isPlainObject(options) ? options : {};
            const canonical = normalizeSidebarOrder(next);
            const operation = beginSidebarOperation(["sidebar_page_order"]);
            const operationId = operation.generation;
            state.sidebarOrder = canonical.slice();
            state.sidebarSettings.sidebar_page_order = canonical.slice();
            renderSidebarOrder(canonical);
            if (focusPage) q(`#sidebar-page-list [data-sidebar-page="${focusPage}"]`)?.focus?.();
            const queuedOperation = enqueueSidebarOperation(async () => {
                try {
                    await persistSidebarField("sidebar_page_order", canonical);
                    const current = operationId === state.sidebarReorderGeneration;
                    state.persistedSidebarOrder = canonical.slice();
                    state.persistedSidebarSettings.sidebar_page_order = canonical.slice();
                    if (current) {
                        state.sidebarOrder = canonical.slice();
                        state.sidebarSettings.sidebar_page_order = canonical.slice();
                        renderSidebarOrder(canonical);
                        if (focusPage) q(`#sidebar-page-list [data-sidebar-page="${focusPage}"]`)?.focus?.();
                    }
                    const apply = current ? await applySidebarLive({ sidebar_page_order: canonical }) : { ok: true, applied: false, appliesNextLoad: true };
                    if (current) {
                        const nextLoad = setSidebarApplyOutcome(apply);
                        setStatus(nextLoad ? "Saved. Applies next Canvas load." : "Saved.");
                    }
                    const result = { ok: true, order: canonical.slice(), operationId, current, ...apply, appliesNextLoad: apply.appliesNextLoad === true || apply.applied !== true };
                    callbacks.onResult?.(result);
                    return result;
                } catch (error) {
                    const current = operationId === state.sidebarReorderGeneration;
                    const restoredOrder = state.persistedSidebarOrder.slice();
                    if (current) {
                        state.sidebarOrder = restoredOrder.slice();
                        state.sidebarSettings.sidebar_page_order = restoredOrder.slice();
                        renderSidebarOrder(restoredOrder);
                        if (focusPage) q(`#sidebar-page-list [data-sidebar-page="${focusPage}"]`)?.focus?.();
                        setStatus("Failed — changes reverted.", true);
                    }
                    const result = { ok: false, order: restoredOrder.slice(), restoredOrder: restoredOrder.slice(), error, operationId, current };
                    if (current) callbacks.onRollback?.(restoredOrder.slice(), error);
                    callbacks.onResult?.(result);
                    const reported = error instanceof Error ? error : new Error("SIDEBAR_ORDER_SAVE_FAILED");
                    reported.restoredOrder = restoredOrder.slice();
                    reported.result = result;
                    reported.operationId = operationId;
                    reported.current = current;
                    throw reported;
                }
            });
            return queuedOperation;
        }

        function renderSidebarOrder(order) {
            const list = q("#sidebar-page-list");
            if (!list || !doc?.createElement) return;
            const visibility = state.sidebarVisibility || DEFAULT_SIDEBAR_VISIBILITY;
            const discovered = Array.isArray(state.sidebarPages) ? state.sidebarPages : [];
            const labels = new Map(discovered.map((page) => [page.id, page.label || page.name || page.id]));
            list.replaceChildren();
            const canonical = normalizeSidebarOrder(order);
            state.sidebarOrder = canonical.slice();
            canonical.forEach((page) => {
                const row = doc.createElement("li");
                row.dataset.sidebarPage = page;
                row.className = "sidebar-page-row";
                row.tabIndex = 0;
                row.draggable = false;
                row.setAttribute?.("draggable", "false");
                const label = String(labels.get(page) || SIDEBAR_PAGE_LABELS[page] || page).replace(/\s+/g, " ").trim();
                row.innerHTML = `<span class="drag-handle" data-sidebar-drag-handle="true" role="img" aria-label="Drag to reorder ${label}">⠿</span><span class="sidebar-page-name"></span><label class="sidebar-visibility"><input type="checkbox" class="settings-switch" role="switch" data-sidebar-visibility="${page}" aria-label="Show ${label} in the sidebar"></label><button type="button" class="workspace-action" data-sidebar-move="up" aria-label="Move ${label} up">↑</button><button type="button" class="workspace-action" data-sidebar-move="down" aria-label="Move ${label} down">↓</button>`;
                bindSidebarDrag(row, "page", page);
                row.querySelector(".sidebar-page-name").textContent = label;
                const checkbox = row.querySelector("[data-sidebar-visibility]");
                checkbox.checked = visibility[page] !== false;
                checkbox.addEventListener?.("change", () => { persistSidebarVisibility(page, checkbox.checked).catch(() => {}); });
                if (visibility[page] === false) {
                    row.classList?.add?.("is-saved-hidden");
                    row.setAttribute?.("aria-label", `${label}, hidden from the sidebar`);
                    row.hidden = !state.sidebarShowHidden;
                }
                list.appendChild(row);
            });
        }

        async function persistSidebarVisibility(page, visible) {
            const stable = settingsSchemaApi?.isStableSidebarId?.(page) || /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(String(page || ""));
            if (!stable || !state.sidebarOrder.includes(page)) throw new Error("SIDEBAR_PAGE_INVALID");
            const previous = clone(state.sidebarVisibility || DEFAULT_SIDEBAR_VISIBILITY);
            const next = Object.assign({}, previous, { [page]: visible === true });
            state.sidebarVisibility = next;
            try {
                const result = await commitSidebarChanges({ sidebar_page_visibility: next }, { sidebar_page_visibility: previous });
                return result;
            } catch (error) {
                state.sidebarVisibility = previous;
                renderSidebarOrder(state.sidebarOrder);
                throw error;
            }
        }

        async function loadSidebarSettings() {
            try {
                const values = await storageGet("sync", SIDEBAR_READ_KEYS);
                let legacy = {};
                try { legacy = await storageGet("local", SIDEBAR_LEGACY_LOCAL_EXPANSION_KEYS); } catch (error) {}
                const merged = sidebarDefaults(defaults);
                state.sidebarRawPresence = Object.fromEntries(Object.keys(values || {}).map((key) => [key, true]));
                SIDEBAR_SETTING_KEYS.forEach((key) => {
                    if (Object.prototype.hasOwnProperty.call(values || {}, key)) merged[key] = clone(values[key]);
                });
                if (!Object.prototype.hasOwnProperty.call(values || {}, "better_sidebar")) {
                    for (const alias of ["sidebar_enabled", "enable_sidebar", "enabled"]) {
                        if (typeof values?.[alias] === "boolean") { merged.better_sidebar = values[alias]; break; }
                    }
                }
                if (!Object.prototype.hasOwnProperty.call(values || {}, "dashboard_sidebar_expanded") && typeof legacy.better_sidebar_expanded_dashboard === "boolean") merged.dashboard_sidebar_expanded = legacy.better_sidebar_expanded_dashboard;
                if (!Object.prototype.hasOwnProperty.call(values || {}, "course_sidebar_expanded") && typeof legacy.better_sidebar_expanded_course === "boolean") merged.course_sidebar_expanded = legacy.better_sidebar_expanded_course;
                if (!Object.prototype.hasOwnProperty.call(values || {}, "sidebar_preferred_state")) merged.sidebar_preferred_state = sidebarWidthPreset(merged);
                merged.sidebar_expanded_width = normalizeSidebarNumber("sidebar_expanded_width", Number(merged.sidebar_expanded_width)) ?? DEFAULT_SIDEBAR_SETTINGS.sidebar_expanded_width;
                merged.sidebar_collapsed_width = normalizeSidebarNumber("sidebar_collapsed_width", Number(merged.sidebar_collapsed_width)) ?? DEFAULT_SIDEBAR_SETTINGS.sidebar_collapsed_width;
                merged.sidebar_icon_size = normalizeSidebarNumber("sidebar_icon_size", Number(merged.sidebar_icon_size)) ?? DEFAULT_SIDEBAR_SETTINGS.sidebar_icon_size;
                merged.sidebar_label_size = normalizeSidebarNumber("sidebar_label_size", Number(merged.sidebar_label_size)) ?? DEFAULT_SIDEBAR_SETTINGS.sidebar_label_size;
                merged.sidebar_scale = normalizeSidebarNumber("sidebar_scale", Number(merged.sidebar_scale)) ?? DEFAULT_SIDEBAR_SETTINGS.sidebar_scale;
                merged.sidebar_density = sidebarDensityPreset(merged.sidebar_density);
                merged.sidebar_scale_preset = settingsSchemaApi?.sidebarScalePresets?.[merged.sidebar_scale_preset]
                    ? merged.sidebar_scale_preset
                    : sidebarSizePreset(merged);
                merged.sidebar_accessibility_labels = true;
                merged.sidebar_page_visibility = normalizeSidebarVisibility(merged.sidebar_page_visibility);
                const canonical = normalizeSidebarOrder(merged.sidebar_page_order);
                merged.sidebar_page_order = canonical.slice();
                state.sidebarSettings = merged;
                state.persistedSidebarSettings = clone(merged);
                state.sidebarVisibility = clone(merged.sidebar_page_visibility);
                state.sidebarOrder = canonical.slice();
                state.persistedSidebarOrder = canonical.slice();
                renderSidebarControls();
                renderSidebarOrder(canonical);
                if (!sameArray(values?.sidebar_page_order, canonical) && settingsStore?.transaction) await settingsStore.transaction({ sidebar_page_order: canonical });
            } catch (error) {
                setStatus("Sidebar settings unavailable.", true);
                throw error;
            }
        }

        async function loadAccounts() {
            try {
                const local = await storageGet("local", ["platform.accountMetadata"]);
                const accounts = local["platform.accountMetadata"]?.accounts;
                state.canvasAccounts = Array.isArray(accounts) ? accounts.filter((account) => isPlainObject(account)) : [];
            } catch (error) { state.canvasAccounts = []; }
            renderCanvasAccounts();
        }

        function isCurrentIdentity(generation, userKey) {
            return generation === state.identityGeneration && state.identity.state === "authenticated" && state.identityUserKey === userKey;
        }

        async function loadConsent(generation = state.identityGeneration, userKey = identityKey(state.identity)) {
            if (!isCurrentIdentity(generation, userKey)) return null;
            let consent;
            try { consent = await request("NEST_CONSENT_GET"); }
            catch (error) { consent = { ok: false, code: error.message }; }
            if (!isCurrentIdentity(generation, userKey)) return null;
            state.consent = consent;
            const enabled = state.consent?.consent?.granted ?? state.consent?.granted ?? state.consent?.enabled;
            const control = q("#nest-consent-enabled");
            if (control && typeof enabled === "boolean") control.checked = enabled;
            text("#nest-consent-status", state.consent?.ok === false ? "Consent status unavailable." : enabled ? "Consent granted." : "Consent not granted.");
            return state.consent;
        }

        async function setConsent(value) {
            const generation = state.identityGeneration;
            const userKey = identityKey(state.identity);
            if (!isCurrentIdentity(generation, userKey)) {
                text("#nest-consent-status", "Connect Nest to manage calendar consent.");
                throw new Error("NEST_AUTHENTICATION_REQUIRED");
            }
            try {
                const consent = await request("NEST_CONSENT_SET", { granted: Boolean(value) });
                if (!isCurrentIdentity(generation, userKey)) throw new Error("STALE_IDENTITY_COMPLETION");
                if (consent?.ok === false) throw new Error(consent.code || "NEST_CONSENT_SET_FAILED");
                state.consent = consent;
                text("#nest-consent-status", state.consent?.ok === false ? "Consent could not be saved." : "Consent saved.");
                return state.consent;
            } catch (error) {
                if (isCurrentIdentity(generation, userKey)) {
                    const enabled = state.consent?.consent?.granted ?? state.consent?.granted ?? state.consent?.enabled;
                    const control = q("#nest-consent-enabled");
                    if (control && typeof enabled === "boolean") control.checked = enabled;
                    text("#nest-consent-status", "Consent could not be saved.");
                }
                throw error;
            }
        }

        function renderCalendarStatus() {
            const status = q("#calendar-capability-status");
            if (!status) return;
            if (state.identity.state !== "authenticated") status.textContent = "Connect Nest to check calendar sync capability.";
            else if (!state.calendars) status.textContent = "Available after calendar sync is enabled.";
            else if (state.calendars.ok === false) status.textContent = "Available after calendar sync is enabled.";
            else status.textContent = "Calendar sync is enabled.";
            const selectors = q("#calendar-routing-controls");
            if (selectors) {
                const available = state.identity.state === "authenticated" && state.calendars?.ok && Array.isArray(state.calendars.calendars || state.calendars.body?.calendars);
                selectors.hidden = !available;
                selectors.inert = !available;
            }
        }

        async function loadCalendars(generation = state.identityGeneration, userKey = identityKey(state.identity)) {
            if (!isCurrentIdentity(generation, userKey)) {
                state.calendars = null;
                renderCalendarStatus();
                return null;
            }
            let flags = {};
            try { flags = (await storageGet("local", ["platform.flags"]))["platform.flags"] || {}; } catch (error) {}
            if (!isCurrentIdentity(generation, userKey)) return null;
            if (flags.projection !== true) { state.calendars = null; renderCalendarStatus(); return; }
            let calendars;
            try { calendars = await request("NEST_CALENDARS_GET"); }
            catch (error) { calendars = { ok: false, code: error.message }; }
            if (!isCurrentIdentity(generation, userKey)) return null;
            state.calendars = calendars;
            renderCalendarStatus();
            return state.calendars;
        }

        // Shell commands travel iframe -> background -> the top frame of the
        // same tab. The overlay host is the only thing that can move the shell,
        // because it lives in the Canvas page and this document does not.
        async function overlayControl(action, payload = {}) {
            if (shellHost(win?.location?.search) !== SHELL_HOSTS.EMBEDDED) {
                return { ok: false, code: "OVERLAY_NOT_EMBEDDED" };
            }
            const overlaySession = overlaySessionToken(win?.location?.search);
            if (!overlaySession) return { ok: false, code: "OVERLAY_SESSION_REQUIRED" };
            try {
                const result = await request("OVERLAY_CONTROL", { ...payload, action, overlaySession });
                return result?.ok === false ? result : { ok: true, ...(result || {}) };
            } catch (error) {
                return { ok: false, code: "OVERLAY_HOST_UNAVAILABLE" };
            }
        }

        function initializationFailureMessage() {
            return shellHost(win?.location?.search) === SHELL_HOSTS.EMBEDDED
                ? "APStudyCanvas couldn’t load this workspace. Reload it or open the workspace in a new tab."
                : "APStudyCanvas couldn’t load this workspace. Reload it or reopen the workspace.";
        }

        function reportStartupFailure(error) {
            if (state.startupFailurePromise) return state.startupFailurePromise;
            state.startupFailurePromise = (async () => {
                setError(initializationFailureMessage());
                if (shellHost(win?.location?.search) !== SHELL_HOSTS.EMBEDDED) {
                    return { ok: true, state: "error", standalone: true };
                }
                // The host was already told that this iframe is a live,
                // interactive shell. Do not turn a later optional-data or
                // post-shell failure into a second host transition: `error`
                // is intentionally invalid after `ready`, and attempting it
                // used to leave a fresh Retry iframe under the host's stale
                // “Workspace unavailable” state. Keep the recovery UI inside
                // the loaded iframe instead.
                if (state.readySignalPromise) {
                    return { ok: true, state: "error", embeddedReady: true };
                }
                return overlayControl("error", {
                    code: "POPUP_INIT_FAILED",
                    recoverable: true
                });
            })();
            return state.startupFailurePromise;
        }

        function reportDraftSyncFailure(error) {
            const code = typeof error?.code === "string" && error.code
                ? error.code
                : "OVERLAY_DRAFT_STATE_FAILED";
            state.draftSyncError = { code, at: now() };
            setStatus(draftSyncWarning, true);
            return { ok: false, code };
        }

        function clearDraftSyncFailure() {
            state.draftSyncError = null;
            const defaults = new Map([
                ["#save-status-live", "Settings sync automatically."],
                ["#workspace-save-status", "Settings sync automatically."],
                ["#sidebar-status-value", ""]
            ]);
            for (const [selector, fallback] of defaults) {
                const node = q(selector);
                if (!node || node.textContent !== draftSyncWarning) continue;
                node.textContent = fallback;
                node.hidden = false;
                node.classList?.toggle("is-error", false);
                node.dataset.state = "idle";
            }
        }

        function signalReady() {
            if (shellHost(win?.location?.search) !== SHELL_HOSTS.EMBEDDED) {
                return Promise.resolve({ ok: true, state: "ready", standalone: true });
            }
            if (state.startupFailurePromise) {
                return Promise.reject(Object.assign(new Error("POPUP_STARTUP_FAILED"), { code: "POPUP_STARTUP_FAILED" }));
            }
            if (state.readySignalPromise) return state.readySignalPromise;
            const operation = (async () => {
                const result = await overlayControl("ready");
                if (result?.ok === false) {
                    throw Object.assign(new Error(result.code || "OVERLAY_READY_FAILED"), { code: result.code || "OVERLAY_READY_FAILED" });
                }
                setError("");
                return result;
            })();
            state.readySignalPromise = operation;
            // A failed handshake must not poison every later signal: drop the
            // cached promise once it rejects so the next signalReady() can
            // retry the ready exchange.
            operation.catch(() => {
                if (state.readySignalPromise === operation) state.readySignalPromise = null;
            });
            return operation;
        }

        function signalDraftState({ draft = false } = {}) {
            const draftValue = draft === true;
            if (shellHost(win?.location?.search) !== SHELL_HOSTS.EMBEDDED) {
                return Promise.resolve({ ok: true, state: "ready", standalone: true, draft: draftValue });
            }
            const sequence = ++draftStateSequence;
            const operation = draftStateTail.then(async () => {
                await signalReady();
                const result = await overlayControl("draft-state", { draft: draftValue, sequence });
                if (result?.ok === false) {
                    throw Object.assign(new Error(result.code || "OVERLAY_DRAFT_STATE_FAILED"), { code: result.code || "OVERLAY_DRAFT_STATE_FAILED" });
                }
                clearDraftSyncFailure();
                return result;
            });
            // A failed transition must reject its own returned promise while
            // leaving the queue live for the next, newer logical state.
            draftStateTail = operation.catch(() => {});
            return operation;
        }

        async function exportSettings() {
            try {
                const keys = SETTINGS_EXPORT_KEYS.length ? SETTINGS_EXPORT_KEYS : Object.keys(defaults);
                const values = await storageGet("sync", keys);
                const output = q("#popup-export-output");
                const snapshot = Object.fromEntries(keys.map((key) => [key, values[key] === undefined ? clone(defaults[key]) : clone(values[key])]));
                if (output) output.value = JSON.stringify(snapshot, null, 2);
            } catch (error) { setStatus("Export failed.", true); }
        }

        async function exportTodoSettings() {
            try {
                const values = await storageGet("sync", TODO_SETTING_KEYS);
                const output = q("#todo-export-output");
                if (output) output.value = JSON.stringify(createTodoSettingsExport({ ...defaults, ...values }), null, 2);
                setStatus("To-Do settings exported.");
            } catch (error) { setStatus("To-Do export failed.", true); }
        }

        async function importSettings() {
            const input = q("#popup-import-input");
            if (!input || !settingsStore) return;
            let parsed;
            try { parsed = JSON.parse(input.value); } catch (error) { setStatus("Invalid settings JSON. No changes were applied.", true); return; }
            if (!isPlainObject(parsed)) { setStatus("Invalid settings JSON. No changes were applied.", true); return; }
            const exportable = new Set(SETTINGS_EXPORT_KEYS.length ? SETTINGS_EXPORT_KEYS : Object.keys(defaults));
            const changes = Object.fromEntries(Object.entries(parsed).filter(([key]) => exportable.has(key)));
            if (Object.prototype.hasOwnProperty.call(changes, "sidebar_page_order")) changes.sidebar_page_order = normalizeSidebarOrder(changes.sidebar_page_order);
            if (!Object.keys(changes).length) { setStatus("Invalid settings JSON. No changes were applied.", true); return; }
            try { await settingsStore.transaction(changes); setStatus("Saved."); win?.APStudyCanvasThemeDraft?.setImport(false); }
            catch (error) { setStatus("Failed — no changes applied.", true); }
        }

        async function importTodoSettings() {
            const input = q("#todo-import-input");
            if (!input || !settingsStore) return;
            let parsed;
            try { parsed = JSON.parse(input.value); } catch (error) { setStatus("Invalid To-Do JSON. No changes were applied.", true); return; }
            const normalized = normalizeTodoSettingsImport(parsed);
            if (!normalized.valid || !Object.keys(normalized.changes).length) {
                setStatus("Invalid To-Do settings. No changes were applied.", true);
                return;
            }
            try {
                await settingsStore.transaction(todoImportChangesWithCompatibility(normalized.changes));
                setStatus("To-Do settings imported.");
                win?.APStudyCanvasThemeDraft?.setImport(false);
            } catch (error) { setStatus("To-Do import failed — no changes applied.", true); }
        }

        async function resetSettings() {
            if (typeof win?.confirm === "function" && !win.confirm("Reset supported Canvas settings to defaults? User data stays intact.")) return;
            if (!settingsStore) return;
            const keys = settingsSchemaApi?.knownResettableKeys || Object.keys(defaults);
            const changes = Object.fromEntries(keys.filter((key) => Object.prototype.hasOwnProperty.call(defaults, key)).map((key) => [key, clone(defaults[key])]));
            try { await settingsStore.transaction(changes); await loadPopupSettings(); setStatus("Saved."); }
            catch (error) { setStatus("Failed — no changes applied.", true); }
        }

        async function resetSidebarSettings() {
            if (!settingsStore) throw new Error("SETTINGS_STORE_UNAVAILABLE");
            const fallback = sidebarDefaults(defaults);
            const keys = SIDEBAR_SETTING_KEYS;
            const previous = Object.fromEntries(keys.map((key) => [key, clone(sidebarControlValue(key))]));
            const changes = {
                better_sidebar: fallback.better_sidebar,
                sidebar_scale: fallback.sidebar_scale,
                sidebar_scale_preset: fallback.sidebar_scale_preset,
                sidebar_expanded_width: fallback.sidebar_expanded_width,
                sidebar_collapsed_width: fallback.sidebar_collapsed_width,
                sidebar_density: fallback.sidebar_density,
                sidebar_icon_size: fallback.sidebar_icon_size,
                sidebar_label_size: fallback.sidebar_label_size,
                sidebar_logo_visible: fallback.sidebar_logo_visible,
                sidebar_product_entry_visible: fallback.sidebar_product_entry_visible,
                sidebar_avatar_size: fallback.sidebar_avatar_size,
                sidebar_collapsed_labels: fallback.sidebar_collapsed_labels,
                sidebar_page_order: clone(DEFAULT_SIDEBAR_PAGE_ORDER),
                sidebar_page_visibility: clone(DEFAULT_SIDEBAR_VISIBILITY),
                sidebar_tooltips: fallback.sidebar_tooltips,
                sidebar_accessibility_labels: true,
                sidebar_pages_visible_expanded: fallback.sidebar_pages_visible_expanded,
                sidebar_pages_visible_collapsed: fallback.sidebar_pages_visible_collapsed,
                sidebar_courses_visible_expanded: fallback.sidebar_courses_visible_expanded,
                sidebar_courses_visible_collapsed: fallback.sidebar_courses_visible_collapsed,
                sidebar_pages_folded: fallback.sidebar_pages_folded,
                sidebar_courses_folded: fallback.sidebar_courses_folded,
                sidebar_preferred_state: fallback.sidebar_preferred_state,
                dashboard_sidebar_expanded: fallback.dashboard_sidebar_expanded,
                course_sidebar_expanded: fallback.course_sidebar_expanded
            };
            return commitSidebarChanges(changes, previous, { transaction: true });
        }

        // Phase 3 editor mounts deliberately consume the extracted Worker A
        // contracts. They receive the controller's queue, rendering, status,
        // confirmation, and Canvas bridge instead of creating parallel storage
        // listeners or reviving a legacy tab as an implementation detail.
        function modernEditorDependencies() {
            const editorKeys = ["custom_cards", "custom_cards_2", "custom_cards_3", "gpa_calc_bounds", "custom_font", "custom_styles", "dark_mode_fix", "dark_preset", "customBackgroundLink", "customBackgroundScale"];
            const read = async () => ({ ...Object.fromEntries(editorKeys.map((key) => [key, clone(defaults[key])])), ...await storageGet("sync", editorKeys) });
            const transaction = async (changes) => {
                if (!settingsStore) throw new Error("SETTINGS_STORE_UNAVAILABLE");
                const current = await read();
                const resolved = typeof changes === "function" ? await changes(clone(current)) : changes;
                await settingsStore.transaction(resolved);
                Object.assign(state.popupSettings, clone(resolved));
                await applyLiveSettings(resolved);
                return resolved;
            };
            return Object.freeze({
                store: Object.freeze({ transaction, localGet: (key) => storageGet("local", key), reset: (keys) => settingsStore?.reset?.(keys) }),
                transaction,
                read,
                render: () => renderModernEditors(),
                confirm: (message) => typeof win?.confirm !== "function" || win.confirm(message),
                status: (message, error = false) => setStatus(message, error),
                sendToCanvas: (action, payload = {}) => applyLiveSettings({ __modernEditorAction: action, ...payload }),
                validateHttpsUrl: (value) => {
                    try { const url = new URL(String(value || "").trim()); return { valid: url.protocol === "https:", value: url.href }; }
                    catch (error) { return { valid: false, value: String(value || "").trim() }; }
                }
            });
        }

        function renderModernEditors() {
            const profile = profileFrom(state.canvas?.profile);
            const binding = state.canvas?.canvasBinding;
            text("#modern-canvas-profile-state", profile.name ? `${profile.name} · Canvas context available.` : "Canvas profile is unavailable in this workspace.");
            text("#modern-canvas-binding-state", binding?.accountKey ? `Verified for ${binding.origin || "this Canvas origin"}.` : "No verified Canvas sync binding.");
            const font = q("#modern-custom-font");
            if (font && !font.dataset.dirty) font.value = String(state.popupSettings.custom_font?.family || "");
            const css = q("#modern-custom-css");
            if (css && !css.dataset.dirty) css.value = String(state.popupSettings.custom_styles || "");
            const fixer = q("#modern-dark-fixer-urls");
            if (fixer && !fixer.dataset.dirty) fixer.value = Array.isArray(state.popupSettings.dark_mode_fix) ? state.popupSettings.dark_mode_fix.join("\n") : "";
        }

        function currentDarkPalette() {
            return clone(state.modernDarkPaletteDraft || state.popupSettings.dark_preset || settingsSchemaApi?.syncDefaults?.dark_preset || {});
        }

        function setModernPaletteStatus(message, error = false) {
            const output = q("#modern-dark-palette-status");
            if (output) {
                output.textContent = message;
                output.classList?.toggle("is-error", error);
            }
        }

        function discardModernDrafts() {
            const css = q("#modern-custom-css");
            if (css) { css.value = String(state.popupSettings.custom_styles || ""); delete css.dataset.dirty; }
            const fixer = q("#modern-dark-fixer-urls");
            if (fixer) { fixer.value = Array.isArray(state.popupSettings.dark_mode_fix) ? state.popupSettings.dark_mode_fix.join("\n") : ""; delete fixer.dataset.dirty; }
            state.modernDarkPaletteDraft = null;
            renderModernPalette();
            win?.APStudyCanvasThemeDraft?.setCss?.(false);
            win?.APStudyCanvasThemeDraft?.setPalette?.(false);
            return true;
        }

        function renderModernPalette() {
            const container = q("#modern-dark-palette");
            const palette = currentDarkPalette();
            if (!container || !doc?.createElement) return;
            container.replaceChildren(...Object.entries(palette).filter(([, color]) => /^#[0-9a-f]{6}$/i.test(color)).map(([key, color]) => {
                const label = doc.createElement("label");
                label.className = "workspace-setting modern-palette-field";
                const name = doc.createElement("span"); name.textContent = key.replace(/-/g, " ");
                const input = doc.createElement("input"); input.type = "color"; input.value = color;
                input.setAttribute("aria-label", `${key} dark palette color`);
                input.addEventListener("input", () => {
                    const next = currentDarkPalette();
                    next[key] = input.value;
                    state.modernDarkPaletteDraft = next;
                    win?.APStudyCanvasThemeDraft?.setPalette?.(true);
                    setModernPaletteStatus("Palette draft changed. Apply to save.");
                });
                label.append(name, input); return label;
            }));
        }

        function mountModernEditors() {
            const editors = root?.APStudyCanvasSettingsEditors;
            if (!editors || !q("#modern-course-save")) return;
            const deps = modernEditorDependencies();
            const course = editors.createCourseCardEditor(deps);
            let renderGpaBounds = () => {};
            const gpa = editors.createGpaBoundsEditor({ ...deps, render: () => renderGpaBounds() });
            const appearance = editors.createAppearanceTools({ ...deps, draft: win?.APStudyCanvasThemeDraft });
            const diagnosticsTransport = win?.APStudyCanvasDiagnosticsTransport;
            const diagnostics = editors.createDiagnosticsTools({
                ...deps,
                inspectCanvas: () => diagnosticsTransport?.inspectCanvas?.(),
                requestCustomOrigin: (origin) => diagnosticsTransport?.requestCustomOrigin?.(origin)
            });
            const value = (selector) => String(q(selector)?.value || "").trim();
            renderGpaBounds = () => {
                const container = q("#modern-gpa-bounds");
                const bounds = state.popupSettings.gpa_calc_bounds;
                if (!container || !bounds || !doc?.createElement) return;
                container.replaceChildren(...gpa.order.map((letter) => {
                    const entry = bounds[letter];
                    if (!entry) return doc.createElement("span");
                    const label = doc.createElement("label"); label.className = "workspace-setting";
                    const name = doc.createElement("strong"); name.textContent = letter;
                    const cutoff = doc.createElement("input"); cutoff.type = "number"; cutoff.min = "0"; cutoff.max = "101"; cutoff.step = "1"; cutoff.value = String(entry.cutoff); cutoff.setAttribute("aria-label", `${letter} cutoff`);
                    const points = doc.createElement("input"); points.type = "number"; points.min = "0"; points.max = "5"; points.step = ".1"; points.value = String(entry.gpa); points.setAttribute("aria-label", `${letter} GPA points`);
                    cutoff.addEventListener("change", () => gpa.update(letter, "cutoff", cutoff.value).catch(() => {}));
                    points.addEventListener("change", () => gpa.update(letter, "gpa", points.value).catch(() => {}));
                    label.append(name, cutoff, points); return label;
                }));
            };
            const courseDraft = () => ({ name: value("#modern-course-name"), code: value("#modern-course-code"), img: value("#modern-course-image"), hidden: q("#modern-course-hidden")?.checked === true });
            q("#modern-course-preview")?.addEventListener?.("click", () => {
                const draft = courseDraft();
                text("#modern-course-preview-output", `${draft.hidden ? "Hidden" : "Visible"} · ${draft.name || "Canvas name"}${draft.code ? ` · ${draft.code}` : ""}`);
            });
            const setCardStatus = (message, error = false) => {
                const output = q("#modern-card-status");
                if (output) { output.textContent = message; output.classList?.toggle("is-error", error); }
            };
            q("#modern-course-save")?.addEventListener?.("click", () => course.save(value("#modern-course-id"), courseDraft())
                .then(() => setCardStatus("Course card saved."))
                .catch((error) => setCardStatus(error?.message === "COURSE_IMAGE_INVALID" ? "Use an http(s) image URL, or leave it blank." : "Course card could not be saved. Your draft is still here.", true)));
            q("#modern-course-reset")?.addEventListener?.("click", () => course.reset(value("#modern-course-id"))
                .then((result) => setCardStatus(result?.cancelled ? "Course card reset cancelled." : "Course card reset to Canvas defaults."))
                .catch(() => setCardStatus("Course card could not be reset.", true)));
            q("#modern-custom-font")?.addEventListener?.("change", (event) => {
                const normalized = appearance.normalizeFont(event.target.value);
                deps.transaction(() => ({ custom_font: normalized })).then(() => setStatus("Custom font saved.")).catch(() => setStatus("Font could not be saved.", true));
            });
            q("#modern-custom-css")?.addEventListener?.("input", (event) => { event.target.dataset.dirty = "true"; win?.APStudyCanvasThemeDraft?.setCss?.(true); });
            q("#modern-css-apply")?.addEventListener?.("click", () => appearance.applyCss(value("#modern-custom-css"), state.popupSettings.custom_styles).then(() => { const node = q("#modern-custom-css"); if (node) delete node.dataset.dirty; }).catch(() => setStatus("Custom CSS could not be applied.", true)));
            q("#modern-css-discard")?.addEventListener?.("click", () => { const node = q("#modern-custom-css"); if (node) { node.value = appearance.discardCss(state.popupSettings.custom_styles); delete node.dataset.dirty; } });
            q("#modern-dark-fixer-urls")?.addEventListener?.("input", (event) => { event.target.dataset.dirty = "true"; });
            q("#modern-dark-fixer-save")?.addEventListener?.("click", () => appearance.setDarkFixUrls(value("#modern-dark-fixer-urls").split(/\n+/).map((item) => item.trim()).filter(Boolean)).then(() => { const fixer = q("#modern-dark-fixer-urls"); if (fixer) delete fixer.dataset.dirty; setModernPaletteStatus("Dark fixer URLs saved."); }).catch(() => setModernPaletteStatus("Dark fixer URLs could not be saved.", true)));
            q("#modern-dark-palette-apply")?.addEventListener?.("click", () => {
                const palette = currentDarkPalette();
                deps.transaction(() => ({ dark_preset: palette })).then(() => {
                    state.modernDarkPaletteDraft = null;
                    win?.APStudyCanvasThemeDraft?.setPalette?.(false);
                    setModernPaletteStatus("Dark palette applied.");
                    renderModernPalette();
                }).catch(() => {
                    // Keep both the draft object and rendered controls intact.
                    setModernPaletteStatus("Dark palette could not be saved. Your draft is still here.", true);
                });
            });
            q("#modern-dark-palette-discard")?.addEventListener?.("click", () => {
                state.modernDarkPaletteDraft = null;
                win?.APStudyCanvasThemeDraft?.setPalette?.(false);
                setModernPaletteStatus("Dark palette draft discarded.");
                renderModernPalette();
            });
            const plusMinusPreset = Object.freeze({ "A+": { cutoff: 97, gpa: 4 }, A: { cutoff: 93, gpa: 4 }, "A-": { cutoff: 90, gpa: 3.7 }, "B+": { cutoff: 87, gpa: 3.3 }, B: { cutoff: 83, gpa: 3 }, "B-": { cutoff: 80, gpa: 2.7 }, "C+": { cutoff: 77, gpa: 2.3 }, C: { cutoff: 73, gpa: 2 }, "C-": { cutoff: 70, gpa: 1.7 }, "D+": { cutoff: 67, gpa: 1.3 }, D: { cutoff: 63, gpa: 1 }, "D-": { cutoff: 60, gpa: .7 }, F: { cutoff: 0, gpa: 0 } });
            q("#modern-gpa-preset-apstudy")?.addEventListener?.("click", () => gpa.applyPreset(plusMinusPreset).then(() => setStatus("+/- GPA preset saved.")).catch(() => setStatus("Grade preset could not be saved.", true)));
            q("#modern-gpa-preset-four-point")?.addEventListener?.("click", () => gpa.applyPreset(editors.GPA_BY_LETTER_PRESET).then(() => setStatus("By-letter GPA preset saved.")).catch(() => setStatus("Grade preset could not be saved.", true)));
            q("#modern-diagnostics-load")?.addEventListener?.("click", () => diagnostics.loadErrors().then((errors) => { const output = q("#modern-diagnostics-output"); if (output) output.value = errors.join("\n"); }).catch(() => setStatus("Diagnostics are unavailable.", true)));
            q("#modern-inspector")?.addEventListener?.("click", () => diagnostics.inspect().then((result) => { const output = q("#modern-diagnostics-output"); if (output) output.value = String(result.selectors || ""); }).catch((error) => setStatus(error?.message || "Canvas inspector is unavailable.", true)));
            q("#modern-canvas-origin-save")?.addEventListener?.("click", () => diagnostics.requestCustomOrigin(value("#modern-canvas-origin")).catch((error) => setStatus(error?.message || "Canvas origin request was not saved.", true)));
            const presets = q("#modern-background-presets");
            if (presets && root?.APStudyCanvasBackgrounds?.presets) {
                presets.replaceChildren(...root.APStudyCanvasBackgrounds.presets.map((preset) => {
                    const button = doc.createElement("button"); button.type = "button"; button.className = "workspace-action"; button.textContent = preset.title;
                    button.addEventListener("click", () => appearance.applyBackground(preset).catch(() => setStatus("Background could not be applied.", true)));
                    return button;
                }));
            }
            renderModernEditors();
            renderModernPalette();
            renderGpaBounds();
            return deps.read().then((values) => {
                ["dark_preset", "custom_styles", "custom_font", "dark_mode_fix", "gpa_calc_bounds"].forEach((key) => {
                    if (values?.[key] !== undefined) state.popupSettings[key] = clone(values[key]);
                });
                renderModernEditors();
                renderModernPalette();
                renderGpaBounds();
            }).catch((error) => { setModernPaletteStatus("Appearance settings are unavailable.", true); throw error; });
        }

        function mountLocalThemeBrowser() {
            const localThemes = root?.APStudyCanvasLocalThemes;
            if (!localThemes?.setup || !settingsStore) return;
            const localThemeSort = q("#local-theme-sort");
            const persistLocalThemeSort = async (value) => {
                const validation = settingsSchemaApi?.validateSettingValue?.("sync", "local_theme_sort", value);
                if (!validation?.valid) throw new Error("LOCAL_THEME_SORT_INVALID");
                const snapshot = await storageGet("sync", ["local_theme_sort"]);
                await settingsStore.transaction({ local_theme_sort: validation.value }, { read: () => Promise.resolve(snapshot) });
                state.popupSettings.local_theme_sort = validation.value;
                if (localThemeSort) localThemeSort.value = validation.value;
            };
            const runLocalThemeTransaction = ({ settingsChanges, cardColors } = {}) => runThemeImportTransaction({
                settingsChanges,
                cardColors,
                hasCanvas: false,
                readSettings: () => storageGet("sync", SETTINGS_EXPORT_KEYS),
                writeSettings: (changes) => settingsStore.transaction(changes),
                restoreSettings: (snapshot) => settingsStore.transaction(snapshot),
                readQueuedColors: async () => ({ present: false }),
                queueCanvasColors: async () => ({ ok: false, code: "CANVAS_COLORS_UNAVAILABLE" }),
                restoreQueuedColors: async () => ({ ok: true }),
                // Local themes are full schema snapshots, not an appearance
                // subset. This preserves Canvas Search and Planner Tasks in
                // local export/import just as full workspace backups do.
                allowedSettingsKeys: SETTINGS_EXPORT_KEYS
            });
            localThemes.setup(doc, chromeService, settingsSchemaApi, {
                runThemeImportTransaction: runLocalThemeTransaction,
                persistSort: persistLocalThemeSort
            });
        }

        function bindActions() {
            const bindNestLogin = (selector) => q(selector)?.addEventListener?.("click", (event) => {
                event.preventDefault?.();
                openNestLogin().catch(() => {});
            });
            bindNestLogin("#nest-sign-in");
            q("#nest-continue")?.addEventListener?.("click", () => dismissOnboarding());
            bindNestLogin("#calendar-nest-login");
            q("#todo-calendar-sync")?.addEventListener?.("click", () => {
                updateCategory("calendar-accounts", true);
            });
            q("#sidebar-reset-defaults")?.addEventListener?.("click", () => {
                resetSidebarSettings().catch(() => {});
            });
            q("#popup-export-settings")?.addEventListener?.("click", () => exportSettings());
            q("#popup-import-settings")?.addEventListener?.("click", () => importSettings());
            q("#todo-export-settings")?.addEventListener?.("click", () => exportTodoSettings());
            q("#todo-import-settings")?.addEventListener?.("click", () => importTodoSettings());
            q("#popup-import-input")?.addEventListener?.("input", (event) => {
                win?.APStudyCanvasThemeDraft?.setImport(Boolean(String(event.target?.value || "").trim()));
            });
            q("#popup-reset-settings")?.addEventListener?.("click", () => resetSettings());
            q("#workspace-error-retry")?.addEventListener?.("click", () => win?.location?.reload?.());
            const expand = q("#compact-expand");
            const host = shellHost(win?.location?.search);
            if (expand) {
                expand.hidden = true;
                if (host === SHELL_HOSTS.EMBEDDED) {
                    expand.removeAttribute?.("aria-label");
                    expand.removeAttribute?.("aria-pressed");
                    expand.removeAttribute?.("title");
                    const sr = expand.querySelector?.(".sr-only");
                    if (sr) sr.textContent = "";
                }
            }
            bindSettingInfo();
        }

        // The note under a setting is clamped to one line so rows stay scannable.
        // The info button expands it, so aria-expanded describes something real.
        function bindSettingInfo() {
            qa(".workspace-info").forEach((button) => {
                const row = button.closest?.(".workspace-setting") || button.parentElement || null;
                button.addEventListener?.("click", (event) => {
                    event?.preventDefault?.();
                    const next = button.getAttribute?.("aria-expanded") !== "true";
                    button.setAttribute?.("aria-expanded", String(next));
                    if (row?.dataset) row.dataset.infoOpen = String(next);
                });
            });
        }

        function flushPendingSettings() {
                if (!settingsStore?.flush) return Promise.resolve();
                return settingsStore.flush().catch((error) => {
                    setStatus("Failed — pending changes could not be saved.", true);
                    throw error;
                });
        }

    function bindLifecycle() {
            const flush = () => { flushPendingSettings().catch(() => {}); };
            win?.addEventListener?.("pagehide", flush);
            win?.addEventListener?.("beforeunload", flush);
            const reconnect = () => { if (doc?.visibilityState !== "hidden") void loadOptionalAccounts(); };
            win?.addEventListener?.("focus", reconnect);
            doc?.addEventListener?.("visibilitychange", () => { if (doc.visibilityState === "hidden") flush(); else reconnect(); });
            const tabUpdated = (tabId, change, tab) => {
                if (tabId !== loginTabId || change?.status !== "complete") return;
                try { if (new URL(tab?.url || change.url).origin === "https://nest.apstudy.org") void loadOptionalAccounts({ force: true }); } catch (_) {}
            };
            const tabRemoved = (tabId) => { if (tabId === loginTabId) { loginTabId = null; reconnect(); } };
            chromeService?.tabs?.onUpdated?.addListener?.(tabUpdated);
            chromeService?.tabs?.onRemoved?.addListener?.(tabRemoved);
            win?.addEventListener?.("pagehide", () => {
                chromeService?.tabs?.onUpdated?.removeListener?.(tabUpdated);
                chromeService?.tabs?.onRemoved?.removeListener?.(tabRemoved);
                connection.dispose();
            }, { once: true });
            win?.addEventListener?.("apstudycanvas-canvas-context", (event) => {
                const detail = isCanvasContextEventRecord(event?.detail) ? event.detail : null;
                const sourceTabId = normalizeSourceCanvasTabId(detail?.sourceTabId);
                const revision = Number.isSafeInteger(detail?.contextRevision) && detail.contextRevision >= 0 ? detail.contextRevision : null;
                const previousSourceTabId = normalizeSourceCanvasTabId(state.canvas?.sourceTabId);
                const previousRevision = Number.isSafeInteger(state.sidebarContextRevision) ? state.sidebarContextRevision : null;
                if (detail && sourceTabId !== null && sourceTabId === previousSourceTabId
                    && revision !== null && previousRevision !== null && revision < previousRevision) return;
                state.sidebarContextGeneration += 1;
                state.sidebarContextRevision = revision;
                state.canvas = detail ? { ...detail, sourceTabId } : null;
                connection.setContext(state.canvas?.canvasBinding || null);
                void loadOptionalAccounts({ force: true });
                const canvasSnapshot = state.canvas?.sidebarContext || null;
                state.sidebarPages = Array.isArray(canvasSnapshot?.pages) ? canvasSnapshot.pages.map(clone).filter((page) => page && typeof page.id === "string") : [];
                if (state.sidebarPages.length) {
                    const discoveredOrder = state.sidebarPages.map((page) => page.id);
                    state.sidebarOrder = normalizeSidebarOrder([...state.sidebarOrder, ...discoveredOrder]);
                    state.sidebarSettings.sidebar_page_order = state.sidebarOrder.slice();
                    state.sidebarVisibility = normalizeSidebarVisibility({ ...state.sidebarVisibility, ...(canvasSnapshot?.pageVisibility || {}) });
                    renderSidebarOrder(state.sidebarOrder);
                }
                renderProfile();
                renderCanvasAvailability();
                void loadSidebarCourseOrder(state.sidebarContextGeneration);
            });
        }

        function setInitialMode() {
            const search = win?.location?.search || "";
            const host = shellHost(search);
            const query = new URLSearchParams(search);
            if (doc?.body) {
                doc.body.dataset.shell = host;
                doc.body.dataset.mode = "workspace";
            }
            updateCategory(query.get("category") || "overview", false, query.has("category"));
        }

        function loadOptionalAccounts({ force = false } = {}) {
            if (state.accountLoading) {
                if (force) state.accountReloadRequested = true;
                return state.accountLoadPromise;
            }
            state.accountLoading = true;
            const lookupRow = q(".account-lookup-row");
            if (lookupRow) lookupRow.hidden = false;
            text("#workspace-account-loading", "Checking account availability…");
            const retry = q("#workspace-account-retry");
            if (retry) retry.hidden = true;
            state.accountLoadPromise = Promise.allSettled([setupOnboarding(), loadAccounts(), refreshIdentity()]).then(async (results) => {
                const calendar = win?.APStudyCanvasCalendarAccounts;
                if (calendar?.state?.initialized) await boundedRead(calendar.refreshSupplementaryData?.(), "Calendar connection");
                const unavailable = calendar?.state?.calendarModeLoadFailed === true || results.some((result) => result.status === "rejected") || state.identity?.state === "unavailable";
                text("#workspace-account-loading", unavailable ? "Account lookup unavailable. Your Canvas settings still work." : "");
                if (retry) retry.hidden = !unavailable;
                if (lookupRow) lookupRow.hidden = !unavailable;
            }).catch(() => {
                text("#workspace-account-loading", "Nest could not finish loading. Your Canvas settings still work.");
                if (retry) retry.hidden = false;
            }).finally(() => {
                state.accountLoading = false;
                win?.APStudyCanvasCalendarAccounts?.render?.();
                if (state.accountReloadRequested) { state.accountReloadRequested = false; void loadOptionalAccounts(); }
            });
            return state.accountLoadPromise;
        }

        async function init() {
            if (state.initPromise) return state.initPromise;
            if (!doc) return controller;
            state.initialized = true;
            state.initPromise = (async () => {
                setInitialMode();
                bindCategories();
                q("#workspace-account-retry")?.addEventListener?.("click", () => { void loadOptionalAccounts(); });
                syncWorkspaceNavigationMode();
                if (typeof win?.ResizeObserver === "function") {
                    const observer = new win.ResizeObserver(() => syncWorkspaceNavigationMode());
                    observer.observe(q("#app-scroll"));
                }
                // ResizeObserver is not guaranteed to report the iframe's
                // first usable layout. Reconcile once at the next paint; this
                // is layout synchronization, not an async readiness delay.
                win?.requestAnimationFrame?.(() => syncWorkspaceNavigationMode());
                bindActions();
                bindPopupSettings();
                bindLifecycle();
                annotateReloadApplyReasons(doc, settingsSchemaApi);
                mountLocalThemeBrowser();
                // A replacement iframe is usable as soon as its shell,
                // navigation, and lifecycle bindings exist. Account, Canvas,
                // and settings reads below can be slow after an extension
                // reload; they must not consume the host's bounded handshake
                // window and strand a loaded Retry frame in host recovery.
                // The aggregate startup path calls signalReady again after
                // completion, but its cached promise makes this one exchange.
                signalReady().catch(() => {});
                const settingMap = q(".workspace-category-map");
                if (settingMap) { settingMap.inert = true; settingMap.setAttribute?.("aria-busy", "true"); }
                void loadOptionalAccounts();
                await Promise.all([loadPopupSettings(), loadSidebarSettings()]);
                await mountModernEditors();
                if (settingMap) { settingMap.inert = false; settingMap.setAttribute?.("aria-busy", "false"); }
                if (doc?.body) doc.body.dataset.settingsState = "ready";
                text("#workspace-loading-status", "");
                renderCanvasAvailability();
                if (!state.startupFailurePromise) setError("");
                return controller;
            })().catch(async (error) => {
                if (doc?.body) doc.body.dataset.settingsState = "error";
                text("#workspace-loading-status", "Saved settings could not load. Reload the workspace to retry.");
                await reportStartupFailure(error);
                throw error;
            });
            return state.initPromise;
        }

        const controller = {
            state,
            connection,
            init,
            updateCategory,
            showCategoryList,
            syncWorkspaceNavigationMode,
            loadOptionalAccounts,
            refreshIdentity,
            openNestLogin,
            overlayControl,
            signalReady,
            signalDraftState,
            reportDraftSyncFailure,
            reportStartupFailure,
            annotateReloadApplyReasons,
            get shellHost() { return shellHost(win?.location?.search); },
            renderProfile,
            renderCanvasAvailability,
            dismissOnboarding,
            loadConsent,
            setConsent,
            loadCalendars,
            loadSidebarSettings,
            persistSidebarOrder,
            persistSidebarVisibility,
            loadSidebarCourseOrder,
            persistSidebarCourseOrder,
            resetSettings,
            resetSidebarSettings,
            applySidebarSettings: applySidebarLive,
            applyLiveChanges: applyLiveSettings,
            discardModernDrafts,
            flush: flushPendingSettings
        };
        return controller;
    }

    return Object.freeze({
        CATEGORIES,
        CATEGORY_LABELS,
        DEFAULT_SIDEBAR_PAGE_ORDER,
        DEFAULT_SIDEBAR_VISIBILITY,
        SIDEBAR_LIVE_SETTING_KEYS,
        SIDEBAR_SETTING_KEYS,
        SIDEBAR_SIZE_PRESETS,
        SIDEBAR_NUMERIC_RANGES,
        DEFAULT_SIDEBAR_SETTINGS,
        ONBOARDING_KEY,
        FULLSCREEN_URL,
        SHELL_HOSTS,
        shellHost,
        shellOpensWorkspace,
        overlaySessionToken,
        isPlainObject,
        isHttpsAvatar,
        cleanName,
        initials,
        normalizeIdentityResponse,
        resolveProfile,
        reorderItems,
        normalizeSidebarOrder,
        normalizeSidebarNumber,
        normalizeSidebarVisibility,
        normalizeSidebarLiveChanges,
        sidebarDensityPreset,
        sidebarWidthPreset,
        sidebarSizePreset,
        sidebarPresetChanges,
        createSidebarSettingsUpdateMessage,
        createLiveSettingsUpdateMessage,
        sidebarDefaults,
        normalizedCategory,
        createSettingsStore,
        validateCardColors,
        validateImportData,
        TODO_SETTING_KEYS,
        POPUP_ACTIVE_SETTING_KEYS,
        UNSUPPORTED_POPUP_SETTING_KEYS,
        createTodoSettingsExport,
        normalizeTodoSettingsImport,
        todoImportChangesWithCompatibility,
        runThemeImportTransaction,
        handlePopoverEscape,
        createStartup,
        annotateReloadApplyReasons,
        createController
    });
}));
