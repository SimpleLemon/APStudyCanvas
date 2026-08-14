(function (root) {
    "use strict";

    const categories = [
        "overview",
        "appearance",
        "course-cards",
        "study-tools",
        "themes",
        "gpa-grades",
        "data-support",
        "sidebar",
        "calendar-accounts"
    ];

    const darkPreset = {
        "background-0": "#161616",
        "background-1": "#1e1e1e",
        "background-2": "#262626",
        borders: "#3c3c3c",
        "text-0": "#f5f5f5",
        "text-1": "#e2e2e2",
        "text-2": "#ababab",
        links: "#56Caf0",
        sidebar: "#1e1e1e",
        "sidebar-text": "#f5f5f5"
    };

    const gpaBounds = {
        "A+": { cutoff: 97, gpa: 4.3 },
        A: { cutoff: 93, gpa: 4 },
        "A-": { cutoff: 90, gpa: 3.7 },
        "B+": { cutoff: 87, gpa: 3.3 },
        B: { cutoff: 83, gpa: 3 },
        "B-": { cutoff: 80, gpa: 2.7 },
        "C+": { cutoff: 77, gpa: 2.3 },
        C: { cutoff: 73, gpa: 2 },
        "C-": { cutoff: 70, gpa: 1.7 },
        "D+": { cutoff: 67, gpa: 1.3 },
        D: { cutoff: 63, gpa: 1 },
        "D-": { cutoff: 60, gpa: 0.7 },
        F: { cutoff: 0, gpa: 0 }
    };

    const defaultSidebarPageOrder = Object.freeze(["dashboard", "courses", "calendar", "inbox", "history", "help"]);
    const defaultSidebarPageVisibility = Object.freeze({ dashboard: true, courses: true, calendar: true, inbox: true, history: true, help: true });
    const CANVAS_ACCOUNT_KEY_PATTERN = /^[a-f0-9]{64}$/;
    const CANVAS_SYNC_OPT_IN_MAX_ACCOUNTS = 64;
    const CANVAS_SYNC_OPT_IN_MAX_BYTES = 8192;

    function normalizeSidebarOrder(value, defaults = defaultSidebarPageOrder) {
        const known = Array.isArray(defaults)
            ? defaults.filter((page, index, pages) => typeof page === "string" && pages.indexOf(page) === index)
            : Array.from(defaultSidebarPageOrder);
        const entries = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
        const seen = new Set();
        const normalized = [];
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

    // These are defaults only. Consumers must merge them into reads and must
    // never write the whole object just because a key is absent.
    const syncDefaults = {
        dark_preset: darkPreset,
        new_install: true,
        remind: false,
        tab_icons: false,
        assignments_due: true,
        gpa_calc: false,
        dark_mode: true,
        gradient_cards: false,
        gradent_cards: false,
        disable_color_overlay: false,
        auto_dark: false,
        auto_dark_start: { hour: "20", minute: "00" },
        auto_dark_end: { hour: "08", minute: "00" },
        num_assignments: 4,
        custom_domain: [""],
        assignments_done: [],
        dashboard_grades: false,
        assignment_date_format: false,
        dashboard_notes: false,
        dashboard_notes_text: "",
        better_todo: false,
        better_sidebar: false,
        sidebar_scale: 100,
        todo_hr24: false,
        todo_separate_scrollbar: false,
        condensed_cards: false,
        custom_cards: {},
        custom_cards_2: {},
        custom_cards_3: {},
        custom_assignments: [],
        custom_assignments_overflow: ["custom_assignments"],
        grade_hover: false,
        num_todo_items: 10,
        custom_font: { link: "", family: "" },
        hover_preview: true,
        full_width: null,
        remlogo: null,
        gpa_calc_bounds: gpaBounds,
        card_overdues: false,
        relative_dues: false,
        hide_feedback: false,
        dark_mode_fix: [],
        assignment_states: {},
        todo_hide_feedback: false,
        todo_full_height: false,
        todo_progress_rings: true,
        todo_confetti: true,
        device_dark: false,
        cumulative_gpa: { name: "Cumulative GPA", hidden: false, weight: "dnc", credits: 999, gr: 3.21 },
        card_method_date: false,
        card_method_dashboard: true,
        card_limit: 25,
        reminders: [],
        reminder_count: 1,
        multi_remind: false,
        id: "",
        new_browser: null,
        imageSize: 100,
        cardRoundness: 5,
        cardSpacing: 0,
        cardWidth: 262,
        cardHeight: 250,
        customCardStyles: false,
        custom_styles: "",
        customBackgroundLink: "",
        customBackgroundScale: 100,
        browser_show_likes: false,
        gpa_calc_weighted: false,
        gpa_calc_cumulative: false,
        gpa_calc_prepend: false,
        todo_progress_rings: true,
        show_updates: false,
        update_msg: "",
        // Popup-owned preferences. The current content seam applies these on
        // the next Canvas load until it accepts the richer sidebar contract.
        sidebar_expanded_width: 280,
        sidebar_collapsed_width: 56,
        sidebar_density: "comfortable",
        sidebar_icon_size: 18,
        sidebar_label_size: 13,
        sidebar_logo_visible: true,
        sidebar_page_order: Array.from(defaultSidebarPageOrder),
        sidebar_page_visibility: { ...defaultSidebarPageVisibility },
        sidebar_tooltips: true,
        sidebar_accessibility_labels: true,
        dashboard_sidebar_expanded: true,
        course_sidebar_expanded: true,
        canvas_calendar_mode: "off"
    };

    const localDefaults = {
        previous_colors: null,
        previous_theme: null,
        errors: [],
        saved_themes: {},
        liked_themes: [],
        fonts_dropdown_open: true,
        seen_update_version: null,
        nest_onboarding_dismissed: false,
        // Explicit per-Canvas-account opt-in. This is deliberately separate
        // from platform.flags.upload, which is an operator rollout switch.
        canvas_sync_opt_in: {}
    };

    // The platform router is deliberately narrower than chrome.storage. These
    // are the user-owned settings that the popup/content seam is allowed to
    // read or mutate through SETTINGS_* messages. Keep compatibility keys here
    // instead of turning the router into an arbitrary storage proxy.
    const legacySyncKeys = Object.freeze([
        "card_colors",
        "scheduledReminder",
        "scheduledReminderTime"
    ]);
    const legacyLocalKeys = Object.freeze([
        "better_sidebar_expanded_dashboard",
        "better_sidebar_expanded_course"
    ]);

    const syncValueKinds = Object.freeze({
        boolean: new Set(Object.keys(syncDefaults).filter((key) => typeof syncDefaults[key] === "boolean")),
        number: new Set(Object.keys(syncDefaults).filter((key) => typeof syncDefaults[key] === "number")),
        string: new Set(Object.keys(syncDefaults).filter((key) => typeof syncDefaults[key] === "string")),
        array: new Set(Object.keys(syncDefaults).filter((key) => Array.isArray(syncDefaults[key]))),
        object: new Set(Object.keys(syncDefaults).filter((key) => syncDefaults[key] !== null && typeof syncDefaults[key] === "object" && !Array.isArray(syncDefaults[key])))
    });

    function isPlainObject(value) {
        if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
        const prototype = Object.getPrototypeOf(value);
        return prototype === Object.prototype || prototype === null;
    }

    function canvasSyncOptInBytes(value) {
        const serialized = JSON.stringify(value);
        if (typeof TextEncoder === "function") return new TextEncoder().encode(serialized).length;
        return unescape(encodeURIComponent(serialized)).length;
    }

    function normalizeCanvasSyncOptIn(value) {
        if (!isPlainObject(value)) return null;
        const entries = Object.entries(value);
        if (entries.length > CANVAS_SYNC_OPT_IN_MAX_ACCOUNTS) return null;
        const normalized = {};
        for (const [accountKey, optedIn] of entries) {
            // Account keys are opaque, lowercase hashes. Raw Canvas IDs,
            // URLs, and credentials cannot cross this settings boundary.
            if (!CANVAS_ACCOUNT_KEY_PATTERN.test(accountKey) || typeof optedIn !== "boolean") return null;
            normalized[accountKey] = optedIn;
        }
        if (canvasSyncOptInBytes(normalized) > CANVAS_SYNC_OPT_IN_MAX_BYTES) return null;
        return normalized;
    }

    function isSafeJsonValue(value, depth = 0) {
        if (depth > 12 || value === undefined || typeof value === "function" || typeof value === "symbol") return false;
        if (value === null || typeof value === "string" || typeof value === "boolean") return true;
        if (typeof value === "number") return Number.isFinite(value);
        if (Array.isArray(value)) return value.every((item) => isSafeJsonValue(item, depth + 1));
        return isPlainObject(value) && Object.keys(value).every((key) => {
            if (key === "__proto__" || key === "prototype" || key === "constructor") return false;
            return isSafeJsonValue(value[key], depth + 1);
        });
    }

    function normalizeCanvasOrigin(value) {
        if (typeof value !== "string" || !value.trim()) return null;
        try {
            const candidate = value.trim();
            const url = new URL(candidate.includes("://") ? candidate : `https://${candidate}`);
            const labels = url.hostname.toLowerCase().split(".");
            if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || (url.pathname !== "" && url.pathname !== "/") || !url.hostname || url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]" || labels.length < 2 || labels.some((label) => !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) return null;
            return url.origin;
        } catch (error) {
            return null;
        }
    }

    function validateSettingValue(area, key, value) {
        const defaults = area === "local" ? localDefaults : syncDefaults;
        const allowed = area === "local" ? new Set([...Object.keys(localDefaults), ...legacyLocalKeys]) : new Set([...Object.keys(syncDefaults), ...legacySyncKeys]);
        if (!allowed.has(key) && !/^custom_assignments_[1-9][0-9]*$/.test(key)) return { valid: false, code: "SETTINGS_KEY_FORBIDDEN" };
        if (!isSafeJsonValue(value)) return { valid: false, code: "SETTINGS_VALUE_INVALID" };

        if (key === "custom_domain") {
            if (!Array.isArray(value)) return { valid: false, code: "SETTINGS_VALUE_INVALID" };
            const origins = value.map((item) => normalizeCanvasOrigin(item)).filter(Boolean);
            if (origins.length !== value.filter((item) => String(item || "").trim()).length || new Set(origins).size !== origins.length) return { valid: false, code: "SETTINGS_VALUE_INVALID" };
            return { valid: true, value: origins };
        }
        if (key === "sidebar_page_order") {
            if (!Array.isArray(value) || JSON.stringify(normalizeSidebarOrder(value)) !== JSON.stringify(value)) return { valid: false, code: "SETTINGS_VALUE_INVALID" };
        }
        if (key === "sidebar_page_visibility") {
            if (!isPlainObject(value) || Object.keys(defaultSidebarPageVisibility).some((page) => typeof value[page] !== "boolean") || Object.keys(value).some((page) => !Object.prototype.hasOwnProperty.call(defaultSidebarPageVisibility, page))) return { valid: false, code: "SETTINGS_VALUE_INVALID" };
        }
        if (key === "canvas_sync_opt_in") {
            const normalized = normalizeCanvasSyncOptIn(value);
            if (normalized === null) return { valid: false, code: "SETTINGS_VALUE_INVALID" };
            return { valid: true, value: normalized };
        }
        if (key === "canvas_calendar_mode" && !["off", "overlay", "replace"].includes(value)) return { valid: false, code: "SETTINGS_VALUE_INVALID" };
        if (key === "dark_preset") {
            if (!isPlainObject(value) || Object.keys(darkPreset).some((color) => typeof value[color] !== "string" || !/^(?:#[0-9a-f]{3,8}|(?:linear-gradient|url)\()/i.test(value[color])) || Object.keys(value).some((color) => !Object.prototype.hasOwnProperty.call(darkPreset, color))) return { valid: false, code: "SETTINGS_VALUE_INVALID" };
        }
        if (key === "auto_dark_start" || key === "auto_dark_end") {
            if (!isPlainObject(value) || !/^([01][0-9]|2[0-3])$/.test(value.hour) || !/^[0-5][0-9]$/.test(value.minute) || Object.keys(value).some((part) => !["hour", "minute"].includes(part))) return { valid: false, code: "SETTINGS_VALUE_INVALID" };
        }
        if (syncValueKinds.boolean.has(key) && typeof value !== "boolean") return { valid: false, code: "SETTINGS_VALUE_INVALID" };
        if (syncValueKinds.number.has(key) && (typeof value !== "number" || !Number.isFinite(value))) return { valid: false, code: "SETTINGS_VALUE_INVALID" };
        if (syncValueKinds.string.has(key) && typeof value !== "string") return { valid: false, code: "SETTINGS_VALUE_INVALID" };
        if (syncValueKinds.array.has(key) && !Array.isArray(value)) return { valid: false, code: "SETTINGS_VALUE_INVALID" };
        if (syncValueKinds.object.has(key) && !isPlainObject(value)) return { valid: false, code: "SETTINGS_VALUE_INVALID" };
        if (Object.prototype.hasOwnProperty.call(defaults, key) && defaults[key] === null && value !== null && typeof value !== "boolean" && typeof value !== "string") return { valid: false, code: "SETTINGS_VALUE_INVALID" };
        return { valid: true, value: clone(value) };
    }

    function settingKeysForArea(area) {
        if (area === "sync") return Object.freeze(Array.from(new Set([...Object.keys(syncDefaults), ...legacySyncKeys])));
        if (area === "local") return Object.freeze(Array.from(new Set([...Object.keys(localDefaults), ...legacyLocalKeys])));
        return Object.freeze([]);
    }

    function isSettingKeyAllowed(area, key) {
        return settingKeysForArea(area).includes(key) || (area === "sync" && /^custom_assignments_[1-9][0-9]*$/.test(key));
    }

    // Deliberately excludes user data (cards, GPA bounds, fonts, saved themes,
    // errors, and unknown keys) from the support reset operation.
    const knownResettableKeys = [
        "remind", "tab_icons", "assignments_due", "gpa_calc", "dark_mode",
        "gradient_cards", "gradent_cards", "disable_color_overlay", "auto_dark",
        "auto_dark_start", "auto_dark_end", "num_assignments", "custom_domain",
        "dashboard_grades", "assignment_date_format", "dashboard_notes",
        "dashboard_notes_text", "better_todo", "better_sidebar", "sidebar_scale",
        "todo_hr24", "todo_separate_scrollbar", "condensed_cards", "grade_hover",
        "num_todo_items", "hover_preview", "full_width", "remlogo", "card_overdues",
        "relative_dues", "hide_feedback", "todo_hide_feedback", "todo_full_height",
        "todo_progress_rings", "todo_confetti", "device_dark", "card_method_date",
        "card_method_dashboard", "card_limit", "imageSize", "cardRoundness",
        "cardSpacing", "cardWidth", "cardHeight", "customCardStyles", "custom_styles",
        "customBackgroundLink", "customBackgroundScale", "gpa_calc_weighted",
        "gpa_calc_cumulative", "gpa_calc_prepend", "browser_show_likes",
        "sidebar_expanded_width", "sidebar_collapsed_width", "sidebar_density",
        "sidebar_icon_size", "sidebar_label_size", "sidebar_logo_visible",
        "sidebar_page_order", "sidebar_page_visibility", "sidebar_tooltips",
        "sidebar_accessibility_labels", "dashboard_sidebar_expanded",
        "course_sidebar_expanded", "canvas_calendar_mode"
    ];

    const aliases = Object.freeze({
        gradient_cards: ["gradient_cards", "gradent_cards"],
        gradent_cards: ["gradient_cards", "gradent_cards"]
    });

    const messages = Object.freeze({
        invalidImport: "Invalid settings JSON. No changes were applied.",
        saveFailure: "Could not save settings. Changes were reverted."
    });

    function isCategory(value) {
        return categories.includes(value);
    }

    function clone(value) {
        if (value === undefined) return undefined;
        if (typeof structuredClone === "function") return structuredClone(value);
        return JSON.parse(JSON.stringify(value));
    }

    function defaultsForArea(area) {
        return clone(area === "local" ? localDefaults : syncDefaults);
    }

    const api = Object.freeze({
        categories: Object.freeze(categories.slice()),
        syncDefaults: Object.freeze(syncDefaults),
        localDefaults: Object.freeze(localDefaults),
        legacySyncKeys,
        legacyLocalKeys,
        settingKeysForArea,
        isSettingKeyAllowed,
        validateSettingValue,
        normalizeCanvasOrigin,
        normalizeCanvasSyncOptIn,
        canvasSyncOptInBytes,
        CANVAS_ACCOUNT_KEY_PATTERN,
        CANVAS_SYNC_OPT_IN_MAX_ACCOUNTS,
        CANVAS_SYNC_OPT_IN_MAX_BYTES,
        defaultsForArea,
        defaultSidebarPageOrder,
        defaultSidebarPageVisibility,
        normalizeSidebarOrder,
        knownResettableKeys: Object.freeze(knownResettableKeys.slice()),
        aliases,
        messages,
        isCategory,
        clone,
        getAliasKeys(key) {
            return aliases[key] ? aliases[key].slice() : [key];
        },
        canonicalKey(key) {
            return key === "gradent_cards" ? "gradient_cards" : key;
        },
        categoryLabels: Object.freeze({
            overview: "Overview",
            appearance: "Appearance",
            sidebar: "Sidebar",
            "course-cards": "Course Cards",
            "study-tools": "Study Tools",
            themes: "Themes",
            "gpa-grades": "GPA & Grades",
            "calendar-accounts": "Calendar & Accounts",
            "data-support": "Data & Support"
        })
    });

    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasSchema = api;
}(typeof globalThis !== "undefined" ? globalThis : this));
