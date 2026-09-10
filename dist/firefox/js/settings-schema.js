(function (root) {
    "use strict";

    const categories = [
        "overview",
        "appearance",
        "course-cards",
        "study-tools",
        "themes",
        "gpa-grades",
        "canvas-search",
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

    // These are stable extension-owned destinations, rather than discovered
    // Canvas links. Keep them after Canvas's canonical global-nav entries so
    // existing saved orders gain them without reshuffling a student's choices.
    const defaultSidebarPageOrder = Object.freeze(["dashboard", "courses", "calendar", "inbox", "history", "help", "apstudy:planner", "apstudy:notes", "apstudy:grades", "apstudy:study"]);
    const defaultSidebarPageVisibility = Object.freeze({ dashboard: true, courses: true, calendar: true, inbox: true, history: true, help: true, "apstudy:planner": true, "apstudy:notes": true, "apstudy:grades": true, "apstudy:study": true });
    const sidebarEnabledAliases = Object.freeze(["better_sidebar", "sidebar_enabled", "enable_sidebar", "enabled"]);
    const sidebarDefaultWidths = Object.freeze({ expanded: 180, collapsed: 86 });
    const sidebarSectionVisibilityKeys = Object.freeze([
        "sidebar_pages_visible_expanded",
        "sidebar_pages_visible_collapsed",
        "sidebar_courses_visible_expanded",
        "sidebar_courses_visible_collapsed"
    ]);
    const sidebarScalePresets = Object.freeze({
        tiny: Object.freeze({ icon: 12, label: 10 }),
        small: Object.freeze({ icon: 14, label: 12 }),
        medium: Object.freeze({ icon: 16, label: 14 }),
        large: Object.freeze({ icon: 18, label: 16 }),
        "extra-large": Object.freeze({ icon: 21, label: 18 })
    });
    // Canonical v1 ranges. Missing widths are resolved by the pure sidebar
    // model and are not written merely because they were absent.
    const sidebarNumericRanges = Object.freeze({
        sidebar_expanded_width: Object.freeze({ min: 160, max: 320 }),
        sidebar_collapsed_width: Object.freeze({ min: 48, max: 112 }),
        sidebar_icon_size: Object.freeze({ min: 12, max: 32 }),
        sidebar_label_size: Object.freeze({ min: 10, max: 20 }),
        sidebar_scale: Object.freeze({ min: 70, max: 150 })
    });
    const CANVAS_ACCOUNT_KEY_PATTERN = /^[a-f0-9]{64}$/;
    const CANVAS_SYNC_OPT_IN_MAX_ACCOUNTS = 64;
    const CANVAS_SYNC_OPT_IN_MAX_BYTES = 8192;

    const TODO_SCHEMA_VERSION = 1;
    const PHASE_ONE_SCHEMA_VERSION = 1;
    const phaseOneNumberRanges = Object.freeze({
        customBackgroundOpacity: Object.freeze({ min: 0, max: 100 }),
        customBackgroundBlur: Object.freeze({ min: 0, max: 32 }),
        cardImageRoundness: Object.freeze({ min: 0, max: 48 }),
        cardPadding: Object.freeze({ min: 0, max: 48 })
    });
    const phaseOneEnumValues = Object.freeze({
        todo_course_color_mode: Object.freeze(["inherit", "neutral"]),
        local_theme_sort: Object.freeze(["name", "newest", "saved"]),
        extension_theme: Object.freeze(["canvas", "light", "dark"])
    });
    const todoProgressStyles = Object.freeze(["none", "circle", "rainbow", "bar", "heart", "cloud", "oiia"]);
    // Pre-BC-alignment style names, mapped to the closest current style so an
    // explicit stored choice keeps its intent across the rename.
    const todoProgressStyleAliases = Object.freeze({ simple: "circle", nested: "rainbow", segmented: "bar", minimal: "bar" });
    const todoSettingOptions = Object.freeze({
        todo_progress_style: todoProgressStyles,
        todo_course_scope: Object.freeze(["active", "all"]),
        todo_date_format: Object.freeze(["absolute", "relative"]),
        todo_timeframe: Object.freeze(["day", "week", "month", "custom"]),
        todo_day_start: Object.freeze(["rolling"]),
        todo_week_start: Object.freeze(["rolling", "sunday", "saturday", "monday"]),
        todo_month_start: Object.freeze(["rolling-30", "first"]),
        todo_completion_authority: Object.freeze(["canvas", "manual"]),
        todo_missing_retention: Object.freeze(["never", "3-days", "1-week", "1-month", "always"]),
        todo_celebration: Object.freeze(["confetti", "fireworks", "stars", "hearts", "sparkle", "none"]),
        todo_celebration_intensity: Object.freeze(["none", "normal", "extra", "insane"]),
        todo_link_target: Object.freeze(["new-tab", "same-tab"]),
        todo_card_sort: Object.freeze(["urgency-balanced", "due-date", "course"]),
        todo_hide_completed: Object.freeze(["immediate", "keep-visible"])
    });
    const todoBooleanKeys = Object.freeze([
        "todo_enabled", "todo_course_card_tasks_enabled", "todo_streak_enabled", "todo_grouping",
        "todo_missing_enabled", "todo_urgency_enabled", "todo_reduced_motion_safe", "todo_hover_preview",
        "todo_course_filtering", "todo_hide_feedback", "todo_clock_24h", "todo_separate_scrollbar", "todo_full_height",
        "todo_institution_logo_visible"
    ]);
    const todoNumberRanges = Object.freeze({
        todo_custom_range_days: Object.freeze({ min: 1, max: 90 }),
        todo_card_max: Object.freeze({ min: 1, max: 10 })
    });
    const todoSettingDescriptors = Object.freeze([
        Object.freeze({ key: "todo_enabled", type: "boolean", section: "general" }),
        Object.freeze({ key: "todo_course_card_tasks_enabled", type: "boolean", section: "general" }),
        Object.freeze({ key: "todo_streak_enabled", type: "boolean", section: "general" }),
        Object.freeze({ key: "todo_institution_logo_visible", type: "boolean", section: "general" }),
        Object.freeze({ key: "todo_progress_style", type: "select", section: "display", options: todoProgressStyles }),
        Object.freeze({ key: "todo_course_scope", type: "select", section: "display", options: todoSettingOptions.todo_course_scope }),
        Object.freeze({ key: "todo_grouping", type: "boolean", section: "display" }),
        Object.freeze({ key: "todo_date_format", type: "select", section: "display", options: todoSettingOptions.todo_date_format }),
        Object.freeze({ key: "todo_timeframe", type: "select", section: "timeframe", options: todoSettingOptions.todo_timeframe }),
        Object.freeze({ key: "todo_week_start", type: "select", section: "timeframe", options: todoSettingOptions.todo_week_start }),
        Object.freeze({ key: "todo_month_start", type: "select", section: "timeframe", options: todoSettingOptions.todo_month_start }),
        Object.freeze({ key: "todo_custom_range_days", type: "number", section: "timeframe", min: 1, max: 90 }),
        Object.freeze({ key: "todo_completion_authority", type: "select", section: "completion", options: todoSettingOptions.todo_completion_authority }),
        Object.freeze({ key: "todo_missing_enabled", type: "boolean", section: "missing" }),
        Object.freeze({ key: "todo_missing_retention", type: "select", section: "missing", options: todoSettingOptions.todo_missing_retention }),
        Object.freeze({ key: "todo_urgency_enabled", type: "boolean", section: "missing" }),
        Object.freeze({ key: "todo_celebration", type: "select", section: "celebrations", options: todoSettingOptions.todo_celebration }),
        Object.freeze({ key: "todo_celebration_intensity", type: "select", section: "celebrations", options: todoSettingOptions.todo_celebration_intensity }),
        Object.freeze({ key: "todo_reduced_motion_safe", type: "boolean", section: "celebrations" }),
        Object.freeze({ key: "todo_link_target", type: "select", section: "behavior", options: todoSettingOptions.todo_link_target }),
        Object.freeze({ key: "todo_hover_preview", type: "boolean", section: "behavior" }),
        Object.freeze({ key: "todo_course_filtering", type: "boolean", section: "behavior" }),
        Object.freeze({ key: "todo_hide_feedback", type: "boolean", section: "behavior" }),
        Object.freeze({ key: "todo_card_max", type: "number", section: "course-cards", min: 1, max: 10 }),
        Object.freeze({ key: "todo_card_sort", type: "select", section: "course-cards", options: todoSettingOptions.todo_card_sort }),
        Object.freeze({ key: "todo_hide_completed", type: "select", section: "course-cards", options: todoSettingOptions.todo_hide_completed }),
        Object.freeze({ key: "todo_clock_24h", type: "boolean", section: "compatibility" }),
        Object.freeze({ key: "todo_separate_scrollbar", type: "boolean", section: "compatibility" }),
        Object.freeze({ key: "todo_full_height", type: "boolean", section: "compatibility" })
    ]);
    const todoSettingKeys = Object.freeze(["todo_settings_version", "todo_day_start", ...todoSettingDescriptors.map((descriptor) => descriptor.key)]);
    // Day start is retained only to read old backups; it has no current
    // runtime behavior or visible control. Every active To-Do preference is
    // reconciled by the mounted rail without a Canvas refresh.
    const todoRuntimeLiveKeys = Object.freeze(todoSettingDescriptors.map((descriptor) => descriptor.key));
    // Visible modern controls write these legacy mirrors in the same atomic
    // transaction. Treating a mirror as reload-only makes a successful live
    // update incorrectly report that Canvas still needs refreshing.
    const todoLegacyLiveKeys = Object.freeze([
        "better_todo", "streak_visible", "todo_progress_rings", "todo_confetti",
        "num_todo_items", "todo_hr24", "hover_preview"
    ]);
    const todoSettingsDefaults = Object.freeze({
        todo_settings_version: TODO_SCHEMA_VERSION,
        todo_enabled: true,
        todo_course_card_tasks_enabled: true,
        todo_streak_enabled: true,
        // Nest chrome replaces institutional branding: the To-Do rail hides
        // Canvas's institutional mark unless the user opts back in.
        todo_institution_logo_visible: false,
        todo_progress_style: "circle",
        todo_course_scope: "active",
        todo_grouping: true,
        todo_date_format: "absolute",
        todo_timeframe: "week",
        todo_day_start: "rolling",
        todo_week_start: "rolling",
        todo_month_start: "rolling-30",
        todo_custom_range_days: 7,
        todo_completion_authority: "canvas",
        todo_missing_enabled: true,
        todo_missing_retention: "always",
        todo_urgency_enabled: true,
        todo_celebration: "confetti",
        todo_celebration_intensity: "normal",
        todo_reduced_motion_safe: true,
        todo_link_target: "new-tab",
        todo_hover_preview: true,
        todo_course_filtering: true,
        todo_hide_feedback: true,
        todo_card_max: 4,
        todo_card_sort: "urgency-balanced",
        todo_hide_completed: "immediate",
        todo_clock_24h: false,
        todo_separate_scrollbar: false,
        todo_full_height: false
    });

    function isStableSidebarId(value) {
        return typeof value === "string"
            && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
            && !["__proto__", "prototype", "constructor"].includes(value);
    }

    function normalizeSidebarOrder(value, defaults = defaultSidebarPageOrder) {
        const known = Array.isArray(defaults)
            ? defaults.filter((page, index, pages) => isStableSidebarId(page) && pages.indexOf(page) === index)
            : Array.from(defaultSidebarPageOrder);
        const entries = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
        const seen = new Set();
        const knownEntries = [];
        const unknownEntries = [];
        entries.forEach((page) => {
            if (!isStableSidebarId(page) || seen.has(page)) return;
            seen.add(page);
            if (known.includes(page)) knownEntries.push(page);
            else unknownEntries.push(page);
        });
        known.forEach((page) => {
            if (seen.has(page)) return;
            seen.add(page);
            knownEntries.push(page);
        });
        return knownEntries.concat(unknownEntries);
    }

    function normalizeSidebarVisibility(value, defaults = defaultSidebarPageVisibility) {
        const source = isPlainObject(value) ? value : {};
        const known = isPlainObject(defaults) ? defaults : defaultSidebarPageVisibility;
        const normalized = {};
        Object.keys(known).forEach((page) => {
            if (isStableSidebarId(page)) normalized[page] = source[page] !== false;
        });
        Object.keys(source).forEach((page) => {
            if (!Object.prototype.hasOwnProperty.call(normalized, page) && isStableSidebarId(page) && typeof source[page] === "boolean") {
                normalized[page] = source[page];
            }
        });
        return normalized;
    }

    function normalizeSidebarNumber(key, value) {
        const range = sidebarNumericRanges[key];
        if (!range || typeof value !== "number" || !Number.isFinite(value)) return null;
        return Math.min(range.max, Math.max(range.min, Math.round(value)));
    }

    // These are defaults only. Consumers must merge them into reads and must
    // never write the whole object just because a key is absent.
    const syncDefaults = {
        dark_preset: darkPreset,
        new_install: true,
        remind: false,
        tab_icons: false,
        assignments_due: false,
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
        better_todo: true,
        better_sidebar: false,
        sidebar_scale: 100,
        todo_hr24: false,
        todo_separate_scrollbar: false,
        condensed_cards: false,
        // Hides Canvas's dashboard header row (the "Dashboard" title, the
        // "Switch to new Dashboard view" button, and the view options menu).
        hide_dashboard_header: false,
        // Compact-padding trim level for the dashboard card section and the
        // #content main column. "minimal" | "medium" | "high" narrow side
        // padding with increasing aggressiveness; "off" restores Canvas's own
        // padding. Legacy boolean installs normalize to "medium".
        dashboard_compact_padding: "medium",
        // Dashboard script hygiene. The background coordinator enforces each
        // switch with declarativeNetRequest rules: the tool-script ruleset
        // covers account-installed third-party scripts on every Canvas page,
        // and the dashboard-scoped editor switch blocks Instructure's
        // editor/media chunk bundles the dashboard never uses for students.
        // Compatibility blockers are intentionally opt-in. They alter Canvas
        // network loading, so an absent setting must remain fail-open.
        block_tool_scripts: false,
        block_editor_scripts: false,
        custom_cards: {},
        custom_cards_2: {},
        custom_cards_3: {},
        custom_assignments: [],
        custom_assignments_overflow: ["custom_assignments"],
        grade_hover: false,
        num_todo_items: 4,
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
        todo_hide_feedback: true,
        todo_full_height: false,
        todo_progress_rings: true,
        todo_confetti: true,
        streak_visible: true,
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
        // Phase 1 settings are lazy defaults: an absent key behaves exactly
        // like a fresh install but is not materialized into an existing sync
        // profile merely because the extension updated.
        phase_one_settings_version: PHASE_ONE_SCHEMA_VERSION,
        planner_tasks_enabled: false,
        quiz_safe_mode: true,
        todo_icons_visible: true,
        todo_course_color_mode: "inherit",
        customBackgroundOpacity: 100,
        customBackgroundBlur: 0,
        cardImageRoundness: 0,
        cardPadding: 0,
        assignment_sequence_footer_visible: true,
        // Canvas's vendor/privacy footer remains visible unless a student
        // explicitly chooses the cleaner page edge.
        hide_infrastructure_footer: false,
        local_theme_sort: "name",
        // Search stays off unless the student explicitly permits this device
        // to retain a bounded, extension-local Canvas metadata index.
        canvas_search_enabled: false,
        // Extension-owned chrome can follow Canvas or use an explicit scheme.
        // This does not change Canvas itself.
        extension_theme: "canvas",
        grade_analytics_enabled: false,
        card_letter_grade_visible: false,
        browser_show_likes: false,
        gpa_calc_weighted: false,
        gpa_calc_cumulative: false,
        gpa_calc_prepend: false,
        todo_progress_rings: true,
        show_updates: false,
        update_msg: "",
        // Popup-owned preferences. The current content seam applies these on
        // the next Canvas load until it accepts the richer sidebar contract.
        sidebar_scale_preset: "medium",
        sidebar_expanded_width: sidebarDefaultWidths.expanded,
        sidebar_collapsed_width: sidebarDefaultWidths.collapsed,
        sidebar_density: "cozy",
        sidebar_icon_size: 16,
        sidebar_label_size: 14,
        sidebar_logo_visible: true,
        sidebar_product_entry_visible: true,
        sidebar_avatar_size: "medium",
        sidebar_collapsed_labels: true,
        sidebar_page_order: Array.from(defaultSidebarPageOrder),
        sidebar_page_visibility: { ...defaultSidebarPageVisibility },
        sidebar_pages_visible_expanded: true,
        sidebar_pages_visible_collapsed: true,
        sidebar_courses_visible_expanded: true,
        sidebar_courses_visible_collapsed: false,
        sidebar_pages_folded: false,
        sidebar_courses_folded: false,
        sidebar_tooltips: true,
        sidebar_accessibility_labels: true,
        sidebar_preferred_state: "expanded",
        dashboard_sidebar_expanded: true,
        course_sidebar_expanded: true,
        canvas_calendar_mode: "off",
        ...todoSettingsDefaults
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

    // These keys are retained so old profiles can still be validated and read
    // by migrations, but no current settings surface owns them. In particular,
    // never materialize, reset, export, or route them through active settings
    // behavior: existing values must remain undisturbed in storage.
    const retiredReminderSyncSettingKeys = Object.freeze([
        "remind", "reminders", "reminder_count", "multi_remind",
        "scheduledReminder", "scheduledReminderTime"
    ]);
    const compatibilityOnlySyncSettingKeys = Object.freeze([
        "browser_show_likes",
        // The planner fingerprint was reassigned to Canvas's dashboard
        // bundle. Keep an old stored preference intact for compatibility, but
        // do not expose, default, export, reset, or route it as a control.
        "block_planner_script",
        ...retiredReminderSyncSettingKeys
    ]);
    const settingsOnlyExcludedKeys = Object.freeze([
        "assignments_done", "assignment_states", "custom_assignments", "custom_assignments_overflow",
        "custom_domain", "id", "new_browser",
        "show_updates", "update_msg",
        ...compatibilityOnlySyncSettingKeys
    ]);
    const lazySyncDefaultKeys = Object.freeze([
        "phase_one_settings_version", "planner_tasks_enabled", "quiz_safe_mode", "todo_icons_visible", "todo_course_color_mode",
        "customBackgroundOpacity", "customBackgroundBlur", "cardImageRoundness", "cardPadding",
        "assignment_sequence_footer_visible", "hide_infrastructure_footer", "local_theme_sort", "canvas_search_enabled", "extension_theme", "grade_analytics_enabled", "card_letter_grade_visible"
    ]);
    const exportableSyncSettingKeys = Object.freeze(Object.keys(syncDefaults).filter((key) => !settingsOnlyExcludedKeys.includes(key)));

    // The platform router is deliberately narrower than chrome.storage. These
    // are the user-owned settings that the popup/content seam is allowed to
    // read or mutate through SETTINGS_* messages. Keep compatibility keys here
    // instead of turning the router into an arbitrary storage proxy.
    const legacySyncKeys = Object.freeze([
        "card_colors",
        "scheduledReminder",
        "scheduledReminderTime",
        "sidebar_enabled",
        "enable_sidebar",
        "enabled"
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

    function normalizePhaseOneNumber(key, value) {
        const range = phaseOneNumberRanges[key];
        if (!range || typeof value !== "number" || !Number.isFinite(value)) return null;
        return Math.min(range.max, Math.max(range.min, Math.round(value)));
    }

    function normalizePhaseOneSettingValue(key, value) {
        if (Object.prototype.hasOwnProperty.call(phaseOneNumberRanges, key)) return normalizePhaseOneNumber(key, value);
        if (Object.prototype.hasOwnProperty.call(phaseOneEnumValues, key)) return phaseOneEnumValues[key].includes(value) ? value : null;
        if (["planner_tasks_enabled", "quiz_safe_mode", "todo_icons_visible", "assignment_sequence_footer_visible", "hide_infrastructure_footer", "canvas_search_enabled", "grade_analytics_enabled", "card_letter_grade_visible"].includes(key)) {
            return typeof value === "boolean" ? value : null;
        }
        if (key === "phase_one_settings_version") return Number.isInteger(value) && value >= 1 && value <= PHASE_ONE_SCHEMA_VERSION ? value : null;
        return null;
    }

    function resolveExtensionTheme(settings = {}) {
        if (settings?.extension_theme === "light" || settings?.extension_theme === "dark") return settings.extension_theme;
        if (settings?.device_dark === true) return "system";
        return settings?.dark_mode === true ? "dark" : "light";
    }

    // Background URLs become CSS `url()` values in the Canvas document. Keep
    // this preference deliberately narrower than a general string: accepting
    // an arbitrary scheme or credentials would turn a settings import into a
    // CSS-injection/privacy footgun. An empty value remains the supported way
    // to clear a user background.
    function normalizeCustomBackgroundUrl(value) {
        if (value === "") return "";
        if (typeof value !== "string" || value.length > 2048) return null;
        try {
            const url = new URL(value);
            if (url.protocol !== "https:" || url.username || url.password) return null;
            return url.href;
        } catch (error) {
            return null;
        }
    }

    // Canvas pages can only use faces shipped in this extension or a browser
    // system fallback. Older versions treated this setting as a Google Fonts
    // request descriptor; preserving arbitrary family names would silently
    // revive that network dependency. Keep the legacy object shape so imports
    // and stored profiles migrate without a broken setting, but canonicalize
    // every supported choice to a local-only descriptor.
    const customFontFamilies = Object.freeze({
        "": Object.freeze({ link: "", family: "" }),
        "Newsreader": Object.freeze({ link: "", family: "Newsreader" }),
        "Public Sans": Object.freeze({ link: "", family: "Public Sans" }),
        "IBM Plex Mono": Object.freeze({ link: "", family: "IBM Plex Mono" }),
        "System UI": Object.freeze({ link: "", family: "System UI" })
    });
    const customFontCssFamilies = Object.freeze({
        "Newsreader": '"Newsreader", ui-serif, serif',
        "Public Sans": '"Public Sans", system-ui, sans-serif',
        "IBM Plex Mono": '"IBM Plex Mono", ui-monospace, monospace',
        "System UI": "system-ui, sans-serif"
    });
    const customFontOptions = Object.freeze([
        Object.freeze({ value: "", label: "Canvas default" }),
        Object.freeze({ value: "Newsreader", label: "Newsreader (packaged)" }),
        Object.freeze({ value: "Public Sans", label: "Public Sans (packaged)" }),
        Object.freeze({ value: "IBM Plex Mono", label: "IBM Plex Mono (packaged)" }),
        Object.freeze({ value: "System UI", label: "System UI" })
    ]);

    function customFontFamilyName(value) {
        if (typeof value === "string") return value.trim().replace(/^['"]|['"]$/g, "");
        if (!isPlainObject(value) || typeof value.family !== "string") return "";
        return value.family.trim().replace(/^['"]|['"]$/g, "");
    }

    function normalizeCustomFont(value) {
        const family = customFontFamilyName(value);
        return clone(customFontFamilies[family] || customFontFamilies[""]);
    }

    function customFontCssFamily(value) {
        return customFontCssFamilies[normalizeCustomFont(value).family] || "";
    }

    function migrateCustomFont(value) {
        const normalized = normalizeCustomFont(value);
        const changed = value !== undefined && (!isPlainObject(value)
            || value.link !== normalized.link
            || value.family !== normalized.family
            || Object.keys(value).some((key) => key !== "link" && key !== "family"));
        return { setting: normalized, changed };
    }

    // This migration is deliberately pure and per-key. Consumers merge its
    // result into reads; background reconciliation must not write missing
    // Phase 1 preferences into established sync storage.
    function migratePhaseOneSettings(values) {
        const source = isPlainObject(values) ? values : {};
        const settings = {};
        const changes = {};
        lazySyncDefaultKeys.forEach((key) => {
            const candidate = source[key];
            const normalized = candidate === undefined ? clone(syncDefaults[key]) : normalizePhaseOneSettingValue(key, candidate);
            settings[key] = normalized === null ? clone(syncDefaults[key]) : normalized;
            if (candidate !== undefined && normalized !== null && normalized !== candidate) changes[key] = normalized;
        });
        // Intentionally narrow compatibility aliases from earlier APStudy
        // experiments; unrecognized upstream keys are never imported.
        if (source.quiz_safe !== undefined && source.quiz_safe_mode === undefined && typeof source.quiz_safe === "boolean") settings.quiz_safe_mode = source.quiz_safe;
        if (source.todo_hide_icons !== undefined && source.todo_icons_visible === undefined && typeof source.todo_hide_icons === "boolean") settings.todo_icons_visible = !source.todo_hide_icons;
        return { version: PHASE_ONE_SCHEMA_VERSION, settings, changes };
    }

    function isPlainObject(value) {
        if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
        const prototype = Object.getPrototypeOf(value);
        return prototype === Object.prototype || prototype === null;
    }

    function hasOwn(object, key) {
        return Object.prototype.hasOwnProperty.call(object || {}, key);
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

    function normalizeTodoSettingValue(key, value) {
        if (key === "todo_settings_version") {
            if (typeof value !== "number" || !Number.isFinite(value)) return null;
            return Math.min(TODO_SCHEMA_VERSION, Math.max(1, Math.round(value)));
        }
        if (todoBooleanKeys.includes(key)) return typeof value === "boolean" ? value : null;
        if (todoNumberRanges[key]) {
            if (typeof value !== "number" || !Number.isFinite(value)) return null;
            const range = todoNumberRanges[key];
            return Math.min(range.max, Math.max(range.min, Math.round(value)));
        }
        if (todoSettingOptions[key]) return typeof value === "string" && todoSettingOptions[key].includes(value) ? value : null;
        return undefined;
    }

    function legacyTodoValue(source, key) {
        if (key === "todo_enabled" && hasOwn(source, "better_todo") && typeof source.better_todo === "boolean") return source.better_todo;
        if (key === "todo_streak_enabled" && hasOwn(source, "streak_visible") && typeof source.streak_visible === "boolean") return source.streak_visible;
        if (key === "todo_progress_style" && hasOwn(source, "todo_progress_rings") && typeof source.todo_progress_rings === "boolean") return source.todo_progress_rings ? "circle" : "none";
        if (key === "todo_celebration" && hasOwn(source, "todo_confetti") && typeof source.todo_confetti === "boolean") return source.todo_confetti ? "confetti" : "none";
        if (key === "todo_celebration_intensity" && hasOwn(source, "todo_confetti") && typeof source.todo_confetti === "boolean") return source.todo_confetti ? "normal" : "none";
        if (key === "todo_card_max" && hasOwn(source, "num_todo_items") && typeof source.num_todo_items === "number" && Number.isFinite(source.num_todo_items)) return source.num_todo_items;
        if (key === "todo_clock_24h" && hasOwn(source, "todo_hr24") && typeof source.todo_hr24 === "boolean") return source.todo_hr24;
        if (key === "todo_hover_preview" && hasOwn(source, "hover_preview") && typeof source.hover_preview === "boolean") return source.hover_preview;
        return undefined;
    }

    function migrateTodoSettings(values) {
        const source = isPlainObject(values) ? values : {};
        const changes = {};
        const settings = {};
        todoSettingKeys.forEach((key) => {
            if (hasOwn(source, key)) {
                let stored = source[key];
                // Explicit values win over factory defaults. A stored value
                // that predates the BC style rename maps to the closest
                // current style once, so the choice survives the rename.
                if (key === "todo_progress_style" && !todoProgressStyles.includes(stored)) {
                    stored = todoProgressStyleAliases[stored] ?? stored;
                }
                settings[key] = clone(stored);
                return;
            }
            const candidate = legacyTodoValue(source, key);
            const normalized = candidate === undefined ? null : normalizeTodoSettingValue(key, candidate);
            const value = normalized === null || normalized === undefined ? todoSettingsDefaults[key] : normalized;
            settings[key] = clone(value);
            // This preference resolves on read rather than being backfilled:
            // an absent key means visible without modifying synced settings.
            if (key !== "todo_institution_logo_visible") changes[key] = clone(value);
        });
        if (source.todo_settings_version !== TODO_SCHEMA_VERSION) changes.todo_settings_version = TODO_SCHEMA_VERSION;
        // The loop-built settings carry the resolved todo_* values (aliased
        // renames and legacy derivations included); unknown source keys flow
        // through untouched underneath them.
        return { version: TODO_SCHEMA_VERSION, changes, settings: { ...clone(source), ...clone(settings) } };
    }

    function todoSettingsSnapshot(values) {
        const migrated = migrateTodoSettings(values);
        const snapshot = {};
        todoSettingKeys.forEach((key) => {
            const candidate = migrated.settings[key];
            const normalized = normalizeTodoSettingValue(key, candidate);
            snapshot[key] = normalized === null || normalized === undefined ? clone(todoSettingsDefaults[key]) : normalized;
        });
        return snapshot;
    }

    function normalizeTodoImport(values) {
        if (!isPlainObject(values)) return { valid: false, changes: {}, rejected: ["root"] };
        const changes = {};
        const rejected = [];
        Object.entries(values).forEach(([key, value]) => {
            if (!todoSettingKeys.includes(key)) return;
            const normalized = normalizeTodoSettingValue(key, value);
            if (normalized === null || normalized === undefined) rejected.push(key);
            else changes[key] = normalized;
        });
        return { valid: rejected.length === 0, changes, rejected };
    }

    function todoLegacyCompatibilityChanges(key, value) {
        if (key === "todo_enabled") return { better_todo: value === true };
        if (key === "todo_streak_enabled") return { streak_visible: value === true };
        if (key === "todo_progress_style") return { todo_progress_rings: value !== "none" };
        if (key === "todo_celebration" || key === "todo_celebration_intensity") return { todo_confetti: key === "todo_celebration" ? value !== "none" : value !== "none" };
        if (key === "todo_card_max") return { num_todo_items: value };
        if (key === "todo_clock_24h") return { todo_hr24: value === true };
        if (key === "todo_hover_preview") return { hover_preview: value === true };
        return {};
    }

    function courseCardTaskExclusivityChanges(key, value) {
        if (key === "todo_course_card_tasks_enabled" && value === true) return { assignments_due: false };
        if (key === "assignments_due" && value === true) return { todo_course_card_tasks_enabled: false };
        return {};
    }

    const dashboardCompactPaddingLevels = Object.freeze(["minimal", "medium", "high", "off"]);

    // Legacy installs stored a boolean (true = the old single trim level,
    // false = the old factory-off default). Both normalize to "medium": the
    // compact trim now ships on by default and "medium" preserves the old
    // on-state exactly, while the off state stays reachable through the UI.
    function normalizeDashboardCompactPadding(value) {
        if (typeof value === "boolean") return "medium";
        return dashboardCompactPaddingLevels.includes(value) ? value : null;
    }

    function validateSettingValue(area, key, value) {
        const defaults = area === "local" ? localDefaults : syncDefaults;
        const allowed = area === "local"
            ? new Set([...Object.keys(localDefaults), ...legacyLocalKeys])
            : new Set([...Object.keys(syncDefaults), ...legacySyncKeys, ...compatibilityOnlySyncSettingKeys]);
        if (!allowed.has(key) && !/^custom_assignments_[1-9][0-9]*$/.test(key)) return { valid: false, code: "SETTINGS_KEY_FORBIDDEN" };
        if (!isSafeJsonValue(value)) return { valid: false, code: "SETTINGS_VALUE_INVALID" };

        if (key === "custom_domain") {
            if (!Array.isArray(value)) return { valid: false, code: "SETTINGS_VALUE_INVALID" };
            const origins = value.map((item) => normalizeCanvasOrigin(item)).filter(Boolean);
            if (origins.length !== value.filter((item) => String(item || "").trim()).length || new Set(origins).size !== origins.length) return { valid: false, code: "SETTINGS_VALUE_INVALID" };
            return { valid: true, value: origins };
        }
        if (key === "customBackgroundLink") {
            const normalized = normalizeCustomBackgroundUrl(value);
            if (normalized === null) return { valid: false, code: "SETTINGS_VALUE_INVALID" };
            return { valid: true, value: normalized };
        }
        if (key === "custom_font") {
            const normalized = normalizeCustomFont(value);
            if (!isPlainObject(value) || normalized.family !== customFontFamilyName(value)) return { valid: false, code: "SETTINGS_VALUE_INVALID" };
            return { valid: true, value: normalized };
        }
        if (key === "sidebar_page_order") {
            if (!Array.isArray(value) || value.some((page) => !isStableSidebarId(page)) || new Set(value).size !== value.length) return { valid: false, code: "SETTINGS_VALUE_INVALID" };
            return { valid: true, value: normalizeSidebarOrder(value) };
        }
        if (key === "sidebar_page_visibility") {
            if (!isPlainObject(value) || Object.keys(value).some((page) => !isStableSidebarId(page) || typeof value[page] !== "boolean")) return { valid: false, code: "SETTINGS_VALUE_INVALID" };
            return { valid: true, value: normalizeSidebarVisibility(value) };
        }
        if (key === "sidebar_scale_preset" && !Object.prototype.hasOwnProperty.call(sidebarScalePresets, value)) {
            return { valid: false, code: "SETTINGS_VALUE_INVALID" };
        }
        if (key === "sidebar_preferred_state" && !["expanded", "collapsed"].includes(value)) {
            return { valid: false, code: "SETTINGS_VALUE_INVALID" };
        }
        if (key === "sidebar_density" && !["compact", "cozy", "comfortable", "dense"].includes(value)) {
            return { valid: false, code: "SETTINGS_VALUE_INVALID" };
        }
        if (key === "sidebar_avatar_size" && !["small", "medium", "large"].includes(value)) {
            return { valid: false, code: "SETTINGS_VALUE_INVALID" };
        }
        if (key === "canvas_sync_opt_in") {
            const normalized = normalizeCanvasSyncOptIn(value);
            if (normalized === null) return { valid: false, code: "SETTINGS_VALUE_INVALID" };
            return { valid: true, value: normalized };
        }
        if (key === "canvas_calendar_mode" && !["off", "overlay", "replace"].includes(value)) return { valid: false, code: "SETTINGS_VALUE_INVALID" };
        if (key === "dashboard_compact_padding") {
            const normalized = normalizeDashboardCompactPadding(value);
            if (normalized === null) return { valid: false, code: "SETTINGS_VALUE_INVALID" };
            return { valid: true, value: normalized };
        }
        if (lazySyncDefaultKeys.includes(key)) {
            const normalized = normalizePhaseOneSettingValue(key, value);
            if (normalized === null) return { valid: false, code: "SETTINGS_VALUE_INVALID" };
            return { valid: true, value: normalized };
        }
        if (area === "sync" && todoSettingKeys.includes(key)) {
            const normalized = normalizeTodoSettingValue(key, value);
            if (normalized === null || normalized === undefined) return { valid: false, code: "SETTINGS_VALUE_INVALID" };
            return { valid: true, value: clone(normalized) };
        }
        if (sidebarEnabledAliases.includes(key) && typeof value !== "boolean") return { valid: false, code: "SETTINGS_VALUE_INVALID" };
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
        if (sidebarNumericRanges[key]) return { valid: true, value: normalizeSidebarNumber(key, value) };
        return { valid: true, value: clone(value) };
    }

    function settingKeysForArea(area) {
        if (area === "sync") return Object.freeze(Array.from(new Set([
            ...Object.keys(syncDefaults).filter((key) => !compatibilityOnlySyncSettingKeys.includes(key)),
            ...legacySyncKeys.filter((key) => !compatibilityOnlySyncSettingKeys.includes(key))
        ])));
        if (area === "local") return Object.freeze(Array.from(new Set([...Object.keys(localDefaults), ...legacyLocalKeys])));
        return Object.freeze([]);
    }

    function isSettingKeyAllowed(area, key) {
        return settingKeysForArea(area).includes(key) || (area === "sync" && /^custom_assignments_[1-9][0-9]*$/.test(key));
    }

    // Deliberately excludes user data (cards, GPA bounds, fonts, saved themes,
    // errors, and unknown keys) from the support reset operation.
    const knownResettableKeys = [
        "tab_icons", "assignments_due", "gpa_calc", "dark_mode",
        "gradient_cards", "gradent_cards", "disable_color_overlay", "auto_dark",
        "auto_dark_start", "auto_dark_end", "num_assignments", "custom_domain",
        "dashboard_grades", "assignment_date_format", "dashboard_notes",
        "dashboard_notes_text", "better_todo", "better_sidebar", "sidebar_scale",
        "todo_hr24", "todo_separate_scrollbar", "condensed_cards", "grade_hover",
        "num_todo_items", "hover_preview", "full_width", "remlogo", "card_overdues",
        "hide_dashboard_header",
        "relative_dues", "hide_feedback", "todo_hide_feedback", "todo_full_height",
        "todo_progress_rings", "todo_confetti", "streak_visible", "device_dark", "card_method_date",
        "card_method_dashboard", "card_limit", "imageSize", "cardRoundness",
        "cardSpacing", "cardWidth", "cardHeight", "customCardStyles", "custom_styles",
        "dashboard_compact_padding",
        ...lazySyncDefaultKeys,
        "block_tool_scripts", "block_editor_scripts",
        "customBackgroundLink", "customBackgroundScale", "gpa_calc_weighted",
        "gpa_calc_cumulative", "gpa_calc_prepend",
        "sidebar_expanded_width", "sidebar_collapsed_width", "sidebar_density", "sidebar_scale_preset",
        "sidebar_icon_size", "sidebar_label_size", "sidebar_logo_visible",
        "sidebar_product_entry_visible", "sidebar_collapsed_labels", "sidebar_avatar_size",
        "sidebar_page_order", "sidebar_page_visibility", "sidebar_tooltips",
        "sidebar_pages_visible_expanded", "sidebar_pages_visible_collapsed",
        "sidebar_courses_visible_expanded", "sidebar_courses_visible_collapsed",
        "sidebar_pages_folded", "sidebar_courses_folded", "sidebar_preferred_state",
        "sidebar_accessibility_labels", "dashboard_sidebar_expanded",
        "course_sidebar_expanded", "canvas_calendar_mode",
        ...todoSettingKeys
    ];

    const aliases = Object.freeze({
        gradient_cards: ["gradient_cards", "gradent_cards"],
        gradent_cards: ["gradient_cards", "gradent_cards"],
        better_sidebar: sidebarEnabledAliases,
        sidebar_enabled: sidebarEnabledAliases,
        enable_sidebar: sidebarEnabledAliases,
        enabled: sidebarEnabledAliases
    });

    // Live-apply is CSS/style injection or reversible DOM. Reload is anything
    // that changes Canvas API fetches or markup Canvas owns and re-renders.
    const appearanceLiveKeys = Object.freeze([
        "dark_mode", "auto_dark", "auto_dark_start", "auto_dark_end", "device_dark", "extension_theme", "quiz_safe_mode",
        "custom_font", "remlogo", "hide_feedback", "full_width", "tab_icons", "disable_color_overlay",
        "assignment_sequence_footer_visible", "hide_infrastructure_footer", "card_letter_grade_visible"
    ]);
    const courseCardLiveKeys = Object.freeze([
        "condensed_cards", "gradient_cards", "gradent_cards", "custom_cards", "custom_cards_2", "custom_cards_3",
        "imageSize", "cardRoundness", "cardSpacing", "cardWidth", "cardHeight", "customCardStyles",
        "disable_color_overlay", "dashboard_compact_padding", "hide_dashboard_header", "cardImageRoundness", "cardPadding"
    ]);
    const themeLiveKeys = Object.freeze([
        "dark_preset", "custom_styles", "customBackgroundLink", "customBackgroundScale", "customBackgroundOpacity", "customBackgroundBlur"
    ]);
    const sidebarLiveKeys = Object.freeze([
        "better_sidebar", "sidebar_scale", "sidebar_scale_preset", "sidebar_expanded_width", "sidebar_collapsed_width", "sidebar_density",
        "sidebar_icon_size", "sidebar_label_size", "sidebar_logo_visible", "sidebar_product_entry_visible", "sidebar_collapsed_labels", "sidebar_page_order",
        "sidebar_page_visibility", "sidebar_tooltips", "sidebar_accessibility_labels", "sidebar_avatar_size",
        "sidebar_pages_visible_expanded", "sidebar_pages_visible_collapsed",
        "sidebar_courses_visible_expanded", "sidebar_courses_visible_collapsed",
        "sidebar_pages_folded", "sidebar_courses_folded", "sidebar_preferred_state",
        "dashboard_sidebar_expanded", "course_sidebar_expanded",
        "sidebar_enabled", "enable_sidebar", "enabled", "sidebar_page_labels", "sidebar_labels"
    ]);
    // These rail layout choices are applied by the owned To-Do root. They do
    // not require Canvas to rebuild its sidebar, so keep them in the same
    // live contract as the other reversible rail settings.
    // Dashboard rows and the GPA calculator own their injected DOM. Assignment
    // controls can refresh the planner snapshot, and grade/GPA controls can
    // fetch course scores on demand, so none of these require a Canvas reload.
    const dashboardLiveKeys = Object.freeze([
        "dashboard_notes", "assignments_due",
        "assignment_date_format", "card_overdues", "relative_dues", "num_assignments",
        "dashboard_grades", "grade_hover",
        "gpa_calc", "gpa_calc_prepend", "gpa_calc_weighted", "gpa_calc_cumulative", "gpa_calc_bounds"
    ]);
    const studyToolsLiveKeys = Object.freeze([
        "planner_tasks_enabled", ...todoRuntimeLiveKeys, ...todoLegacyLiveKeys,
        "canvas_search_enabled", "grade_analytics_enabled"
    ]);
    const liveApplyGroups = Object.freeze({
        appearance: appearanceLiveKeys,
        "course-cards": courseCardLiveKeys,
        themes: themeLiveKeys,
        sidebar: sidebarLiveKeys,
        dashboard: dashboardLiveKeys,
        "study-tools": studyToolsLiveKeys
    });
    const reloadApplyReasons = Object.freeze({
        custom_domain: "Changes which Canvas origin the extension injects on.",
        custom_assignments: "Rewrites assignment card content from planner data.",
        custom_assignments_overflow: "Rewrites assignment card content from planner data.",
        card_method_date: "Changes how dashboard cards are collected.",
        card_method_dashboard: "Changes how dashboard cards are collected.",
        card_limit: "Changes how dashboard cards are collected.",
        block_tool_scripts: "Only affects scripts Canvas loads after this setting changes.",
        block_editor_scripts: "Only affects scripts Canvas loads after this setting changes.",
        todo_settings_version: "Stores the To-Do settings schema version.",
        dark_mode_fix: "Rewrites Canvas-owned markup on specific paths."
    });
    const liveApplyKeySet = new Set([
        ...appearanceLiveKeys, ...courseCardLiveKeys, ...themeLiveKeys, ...sidebarLiveKeys, ...dashboardLiveKeys, ...studyToolsLiveKeys
    ]);

    function liveApplyMode(key) {
        const canonical = key === "gradent_cards" ? "gradient_cards" : sidebarEnabledAliases.includes(key) ? "better_sidebar" : key;
        if (liveApplyKeySet.has(key) || liveApplyKeySet.has(canonical)) return "live";
        if (Object.prototype.hasOwnProperty.call(reloadApplyReasons, key) || Object.prototype.hasOwnProperty.call(reloadApplyReasons, canonical)) return "reload";
        return "none";
    }

    function liveApplyGroup(key) {
        const canonical = key === "gradent_cards" ? "gradient_cards" : sidebarEnabledAliases.includes(key) ? "better_sidebar" : key;
        if (studyToolsLiveKeys.includes(key) || studyToolsLiveKeys.includes(canonical)) return "study-tools";
        if (dashboardLiveKeys.includes(key) || dashboardLiveKeys.includes(canonical)) return "dashboard";
        if (sidebarLiveKeys.includes(key) || sidebarLiveKeys.includes(canonical)) return "sidebar";
        if (themeLiveKeys.includes(key) || themeLiveKeys.includes(canonical)) return "themes";
        if (courseCardLiveKeys.includes(key) || courseCardLiveKeys.includes(canonical)) return "course-cards";
        if (appearanceLiveKeys.includes(key) || appearanceLiveKeys.includes(canonical)) return "appearance";
        if (liveApplyMode(key) === "reload") return "reload";
        return null;
    }

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
        sidebarDefaultWidths,
        sidebarSectionVisibilityKeys,
        sidebarScalePresets,
        sidebarEnabledAliases,
        sidebarNumericRanges,
        normalizeSidebarNumber,
        normalizeSidebarOrder,
        normalizeSidebarVisibility,
        isStableSidebarId,
        TODO_SCHEMA_VERSION,
        PHASE_ONE_SCHEMA_VERSION,
        phaseOneNumberRanges,
        phaseOneEnumValues,
        lazySyncDefaultKeys,
        normalizePhaseOneSettingValue,
        normalizeCustomBackgroundUrl,
        customFontFamilies,
        customFontOptions,
        normalizeCustomFont,
        customFontCssFamily,
        migrateCustomFont,
        migratePhaseOneSettings,
        todoProgressStyles,
        todoProgressStyleAliases,
        todoSettingOptions,
        todoBooleanKeys,
        todoNumberRanges,
        todoSettingDescriptors,
        todoSettingKeys,
        todoSettingsDefaults,
        normalizeTodoSettingValue,
        migrateTodoSettings,
        todoSettingsSnapshot,
        normalizeTodoImport,
        todoLegacyCompatibilityChanges,
        courseCardTaskExclusivityChanges,
        dashboardCompactPaddingLevels,
        normalizeDashboardCompactPadding,
        resolveExtensionTheme,
        settingsOnlyExcludedKeys,
        retiredReminderSyncSettingKeys,
        compatibilityOnlySyncSettingKeys,
        exportableSyncSettingKeys,
        knownResettableKeys: Object.freeze(knownResettableKeys.slice()),
        aliases,
        messages,
        isCategory,
        clone,
        liveApplyGroups,
        reloadApplyReasons,
        getAliasKeys(key) {
            return aliases[key] ? aliases[key].slice() : [key];
        },
        canonicalKey(key) {
            if (key === "gradent_cards") return "gradient_cards";
            return sidebarEnabledAliases.includes(key) ? "better_sidebar" : key;
        },
        liveApplyMode(key) {
            return liveApplyMode(key);
        },
        liveApplyGroup(key) {
            return liveApplyGroup(key);
        },
        reloadApplyReason(key) {
            const canonical = key === "gradent_cards" ? "gradient_cards" : sidebarEnabledAliases.includes(key) ? "better_sidebar" : key;
            return reloadApplyReasons[canonical] || reloadApplyReasons[key] || null;
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
