(function (root, factory) {
    "use strict";
    const overlayHost = root?.APStudyCanvasContent?.OverlayHost
        || (typeof require === "function" ? require("./overlay-host.js") : null);
    const api = factory(overlayHost);
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasContent = Object.assign(root.APStudyCanvasContent || {}, { SettingsApply: api });
}(typeof globalThis !== "undefined" ? globalThis : this, function (overlayHost) {
    "use strict";

    const APPEARANCE_LIVE_KEYS = Object.freeze([
        "dark_mode", "auto_dark", "auto_dark_start", "auto_dark_end", "device_dark", "extension_theme", "quiz_safe_mode",
        "custom_font", "remlogo", "hide_feedback", "full_width", "tab_icons", "disable_color_overlay",
        "assignment_sequence_footer_visible", "hide_infrastructure_footer", "card_letter_grade_visible"
    ]);
    const COURSE_CARD_LIVE_KEYS = Object.freeze([
        "condensed_cards", "gradient_cards", "gradent_cards", "custom_cards", "custom_cards_2", "custom_cards_3",
        "imageSize", "cardRoundness", "cardSpacing", "cardWidth", "cardHeight", "customCardStyles",
        "disable_color_overlay", "dashboard_compact_padding", "hide_dashboard_header", "cardImageRoundness", "cardPadding"
    ]);
    const THEME_LIVE_KEYS = Object.freeze([
        "dark_preset", "custom_styles", "customBackgroundLink", "customBackgroundScale", "customBackgroundOpacity", "customBackgroundBlur"
    ]);
    const SIDEBAR_LIVE_KEYS = Object.freeze([
        "better_sidebar", "sidebar_scale", "sidebar_expanded_width", "sidebar_collapsed_width", "sidebar_density",
        "sidebar_icon_size", "sidebar_label_size", "sidebar_logo_visible", "sidebar_page_order",
        "sidebar_page_visibility", "sidebar_tooltips", "sidebar_accessibility_labels",
        "dashboard_sidebar_expanded", "course_sidebar_expanded",
        "sidebar_enabled", "enable_sidebar", "enabled", "sidebar_page_labels", "sidebar_labels",
        "sidebar_preferred_state", "sidebar_scale_preset", "sidebar_product_entry_visible", "sidebar_avatar_size",
        "sidebar_collapsed_labels", "sidebar_pages_visible_expanded", "sidebar_courses_visible_expanded",
        "sidebar_pages_visible_collapsed", "sidebar_courses_visible_collapsed",
        "sidebar_pages_folded", "sidebar_courses_folded"
    ]);
    // The mounted To-Do owner keeps a restore ledger and can reconcile every
    // active todo_* preference immediately. todo_day_start is legacy storage
    // only: it has no current UI or runtime behavior.
    const RIGHT_RAIL_LIVE_KEYS = Object.freeze([
        "streak_visible", "planner_tasks_enabled", "better_todo", "todo_progress_rings", "todo_confetti",
        "num_todo_items", "todo_hr24", "hover_preview",
        "todo_enabled", "todo_course_card_tasks_enabled", "todo_streak_enabled", "todo_institution_logo_visible",
        "todo_progress_style", "todo_course_scope", "todo_grouping", "todo_date_format", "todo_timeframe",
        "todo_week_start", "todo_month_start", "todo_custom_range_days", "todo_completion_authority",
        "todo_missing_enabled", "todo_missing_retention", "todo_urgency_enabled", "todo_celebration",
        "todo_celebration_intensity", "todo_reduced_motion_safe", "todo_link_target", "todo_hover_preview",
        "todo_course_filtering", "todo_hide_feedback", "todo_card_max", "todo_card_sort", "todo_hide_completed",
        "todo_clock_24h", "todo_separate_scrollbar", "todo_full_height"
    ]);
    // The dashboard owns assignment rows, grade badges, and GPA DOM. Its
    // content operations safely reconcile these controls in place.
    const DASHBOARD_LIVE_KEYS = Object.freeze([
        "dashboard_notes", "assignments_due",
        "assignment_date_format", "card_overdues", "relative_dues", "num_assignments",
        "dashboard_grades", "grade_hover",
        "gpa_calc", "gpa_calc_prepend", "gpa_calc_weighted", "gpa_calc_cumulative", "gpa_calc_bounds"
    ]);
    const STUDY_TOOLS_LIVE_KEYS = Object.freeze([
        ...RIGHT_RAIL_LIVE_KEYS,
        "canvas_search_enabled", "grade_analytics_enabled"
    ]);
    const LIVE_APPLY_GROUPS = Object.freeze({
        appearance: APPEARANCE_LIVE_KEYS,
        "course-cards": COURSE_CARD_LIVE_KEYS,
        themes: THEME_LIVE_KEYS,
        sidebar: SIDEBAR_LIVE_KEYS,
        dashboard: DASHBOARD_LIVE_KEYS,
        "study-tools": STUDY_TOOLS_LIVE_KEYS
    });
    const RELOAD_APPLY_REASONS = Object.freeze({
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
    const LIVE_KEY_SET = new Set([
        ...APPEARANCE_LIVE_KEYS, ...COURSE_CARD_LIVE_KEYS, ...THEME_LIVE_KEYS, ...SIDEBAR_LIVE_KEYS,
        ...DASHBOARD_LIVE_KEYS, ...STUDY_TOOLS_LIVE_KEYS
    ]);
    const SIDEBAR_KEY_SET = new Set(SIDEBAR_LIVE_KEYS);
    const OPERATION_KEYS = Object.freeze({
        darkMode: Object.freeze(["dark_mode", "dark_preset", "device_dark"]),
        autoDark: Object.freeze(["auto_dark", "auto_dark_start", "auto_dark_end"]),
        extensionTheme: Object.freeze(["extension_theme", "dark_mode", "device_dark"]),
        routeSafety: Object.freeze(["quiz_safe_mode"]),
        assignmentNavigation: Object.freeze(["assignment_sequence_footer_visible"]),
        cardGrades: Object.freeze(["card_letter_grade_visible"]),
        font: Object.freeze(["custom_font"]),
        aesthetics: Object.freeze([
            "remlogo", "hide_feedback", "full_width", "disable_color_overlay", "condensed_cards",
            "custom_styles", "imageSize", "cardRoundness", "cardSpacing", "cardWidth", "cardHeight", "customCardStyles",
            "dashboard_compact_padding", "hide_dashboard_header", "hide_infrastructure_footer", "cardImageRoundness", "cardPadding"
        ]),
        background: Object.freeze(["customBackgroundLink", "customBackgroundScale", "customBackgroundOpacity", "customBackgroundBlur"]),
        gradient: Object.freeze(["gradient_cards", "gradent_cards"]),
        cards: Object.freeze(["custom_cards", "custom_cards_2", "custom_cards_3"]),
        favicon: Object.freeze(["tab_icons", "custom_cards_3"]),
        rightRail: RIGHT_RAIL_LIVE_KEYS,
        dashboardNotes: Object.freeze(["dashboard_notes"]),
        cardAssignments: Object.freeze(["assignments_due", "assignment_date_format", "card_overdues", "relative_dues", "num_assignments"]),
        dashboardGrades: Object.freeze(["dashboard_grades", "grade_hover", "gpa_calc", "gpa_calc_prepend", "gpa_calc_weighted", "gpa_calc_cumulative", "gpa_calc_bounds"]),
        phaseFour: Object.freeze(["canvas_search_enabled", "grade_analytics_enabled"]),
        sidebar: SIDEBAR_LIVE_KEYS
    });
    const KEY_TO_OPERATIONS = (() => {
        const map = new Map();
        Object.entries(OPERATION_KEYS).forEach(([operation, keys]) => {
            keys.forEach((key) => {
                const list = map.get(key) || [];
                list.push(operation);
                map.set(key, list);
            });
        });
        return map;
    })();

    function isPlainObject(value) {
        if (!value || typeof value !== "object" || Array.isArray(value)) return false;
        const prototype = Object.getPrototypeOf(value);
        if (prototype === Object.prototype || prototype === null) return true;
        // vm-cloned envelopes in tests live in another Object realm than this
        // required module; still treat ordinary dictionaries as plain objects.
        return Object.prototype.toString.call(value) === "[object Object]";
    }

    function canonicalKey(key) {
        if (key === "gradent_cards") return "gradient_cards";
        return SIDEBAR_KEY_SET.has(key) && ["sidebar_enabled", "enable_sidebar", "enabled"].includes(key)
            ? "better_sidebar"
            : key;
    }

    function classifyKey(key) {
        const canonical = canonicalKey(key);
        if (LIVE_KEY_SET.has(key) || LIVE_KEY_SET.has(canonical)) return "live";
        if (Object.prototype.hasOwnProperty.call(RELOAD_APPLY_REASONS, key) || Object.prototype.hasOwnProperty.call(RELOAD_APPLY_REASONS, canonical)) {
            return "reload";
        }
        return "none";
    }

    function liveApplyGroup(key) {
        const canonical = canonicalKey(key);
        if (STUDY_TOOLS_LIVE_KEYS.includes(key) || STUDY_TOOLS_LIVE_KEYS.includes(canonical)) return "study-tools";
        if (DASHBOARD_LIVE_KEYS.includes(key) || DASHBOARD_LIVE_KEYS.includes(canonical)) return "dashboard";
        if (SIDEBAR_LIVE_KEYS.includes(key) || SIDEBAR_LIVE_KEYS.includes(canonical)) return "sidebar";
        if (THEME_LIVE_KEYS.includes(key) || THEME_LIVE_KEYS.includes(canonical)) return "themes";
        if (COURSE_CARD_LIVE_KEYS.includes(key) || COURSE_CARD_LIVE_KEYS.includes(canonical)) return "course-cards";
        if (APPEARANCE_LIVE_KEYS.includes(key) || APPEARANCE_LIVE_KEYS.includes(canonical)) return "appearance";
        if (classifyKey(key) === "reload") return "reload";
        return null;
    }

    function fingerprint(value) {
        try {
            return JSON.stringify(value);
        } catch (error) {
            return String(value);
        }
    }

    function valuesEqual(left, right) {
        if (left === right) return true;
        if (left === undefined) return right === undefined;
        return fingerprint(left) === fingerprint(right);
    }

    function createFallbackLedger() {
        const entries = [];
        return {
            record(undo) { if (typeof undo === "function") entries.push(undo); },
            setStyle(node, property, value) {
                if (!node?.style) return;
                const previous = node.style.getPropertyValue?.(property);
                const priority = node.style.getPropertyPriority?.(property) || "";
                entries.push(() => {
                    if (previous) node.style.setProperty?.(property, previous, priority);
                    else node.style.removeProperty?.(property);
                });
                node.style.setProperty?.(property, value);
            },
            get size() { return entries.length; },
            restore() {
                while (entries.length) {
                    const undo = entries.pop();
                    try { undo(); } catch (error) {}
                }
            }
        };
    }

    function classifyChanges(changes) {
        const live = {};
        const reload = {};
        const ignored = {};
        Object.entries(isPlainObject(changes) ? changes : {}).forEach(([key, value]) => {
            const mode = classifyKey(key);
            if (mode === "live") live[key] = value;
            else if (mode === "reload") reload[key] = value;
            else ignored[key] = value;
        });
        return { live, reload, ignored };
    }

    function validateSettingsUpdateRequest(request, { validateSidebar } = {}) {
        if (!isPlainObject(request) || request.type !== "SETTINGS_UPDATE") return { ok: false, code: "SETTINGS_MESSAGE_INVALID" };
        const payload = request.payload;
        if (!isPlainObject(payload) || payload.area !== "sync" || !isPlainObject(payload.changes)) {
            return { ok: false, code: "SETTINGS_PAYLOAD_INVALID" };
        }
        const requestId = request.request_id ?? request.requestId;
        const entries = Object.entries(payload.changes);
        if (!entries.length) return { ok: true, requestId, payload: { area: "sync", changes: {}, reloadKeys: [] } };

        const sidebarChanges = {};
        const otherChanges = {};
        for (const [key, value] of entries) {
            if (SIDEBAR_KEY_SET.has(key)) sidebarChanges[key] = value;
            else otherChanges[key] = value;
        }

        if (!Object.keys(otherChanges).length && typeof validateSidebar === "function") {
            return validateSidebar(request);
        }

        let sidebarValidated = sidebarChanges;
        if (Object.keys(sidebarChanges).length && typeof validateSidebar === "function") {
            const sidebarRequest = {
                version: request.version,
                request_id: requestId,
                type: "SETTINGS_UPDATE",
                payload: { area: "sync", changes: sidebarChanges }
            };
            const result = validateSidebar(sidebarRequest);
            if (!result.ok) return result;
            sidebarValidated = result.payload?.changes || sidebarChanges;
        }

        const liveChanges = { ...sidebarValidated };
        const reloadKeys = [];
        const reloadChanges = {};
        for (const [key, value] of Object.entries(otherChanges)) {
            const mode = classifyKey(key);
            if (mode === "live") liveChanges[key] = value;
            else if (mode === "reload") {
                reloadKeys.push(key);
                reloadChanges[key] = value;
            } else {
                return { ok: false, code: "SETTINGS_KEY_UNSUPPORTED" };
            }
        }

        return {
            ok: true,
            requestId,
            payload: { area: "sync", changes: liveChanges, reloadKeys, reloadChanges }
        };
    }

    function createSettingsApplicator({
        document: doc = globalThis.document,
        operations = {},
        sidebarController = null,
        createRestoreLedger = overlayHost?.createRestoreLedger || createFallbackLedger
    } = {}) {
        let state = {};
        const snapshot = {};
        const ledgers = {};
        const styleNodes = new Map();
        const stats = Object.create(null);
        const renderedOps = Object.create(null);
        let applying = false;

        function findById(id) {
            return doc?.getElementById?.(id) || styleNodes.get(id) || null;
        }

        function upsertStyle(id, css) {
            let node = findById(id);
            const text = typeof css === "string" ? css : "";
            if (!text) {
                if (node) {
                    if (node.parentNode?.removeChild) node.parentNode.removeChild(node);
                    else node.remove?.();
                }
                styleNodes.delete(id);
                return null;
            }
            if (!node && doc?.createElement) {
                node = doc.createElement("style");
                if (node.setAttribute) node.setAttribute("id", id);
                else node.id = id;
                (doc.head || doc.documentElement)?.appendChild?.(node);
            }
            if (node) node.textContent = text;
            if (node) styleNodes.set(id, node);
            return node;
        }

        function helpersFor(operation) {
            return {
                upsertStyle,
                ledger() {
                    ledgers[operation]?.restore();
                    const ledger = createRestoreLedger();
                    ledgers[operation] = ledger;
                    return ledger;
                }
            };
        }

        function markSnapshot(changes) {
            Object.entries(changes || {}).forEach(([key, value]) => {
                snapshot[canonicalKey(key)] = value;
                snapshot[key] = value;
            });
        }

        function dirtyOperations(changes) {
            const dirty = new Set();
            Object.keys(changes || {}).forEach((key) => {
                if (classifyKey(key) !== "live") return;
                const canonical = canonicalKey(key);
                const current = snapshot[canonical] !== undefined ? snapshot[canonical] : snapshot[key];
                const unchanged = valuesEqual(current, changes[key]);
                (KEY_TO_OPERATIONS.get(key) || KEY_TO_OPERATIONS.get(canonical) || []).forEach((operation) => {
                    if (operation === "sidebar" && unchanged && renderedOps.sidebar) return;
                    if (operation !== "sidebar" && unchanged) return;
                    dirty.add(operation);
                });
            });
            return dirty;
        }

        function runOperation(name, settings) {
            const handler = typeof operations[name] === "function"
                ? operations[name]
                : name === "sidebar" && sidebarController?.apply
                    ? (next) => sidebarController.apply(next)
                    : null;
            if (typeof handler !== "function") return { ran: false, rendered: false };
            stats[name] = (stats[name] || 0) + 1;
            const helpers = helpersFor(name);
            let rendered = handler(settings, helpers);
            if (rendered === undefined) rendered = true;
            return { ran: true, rendered: rendered !== false };
        }

        function applyChanges(changes, settings = {}, { source = "settings-update" } = {}) {
            void source;
            if (applying) {
                return {
                    applied: false,
                    rendered: false,
                    appliedKeys: [],
                    reloadKeys: Object.keys(classifyChanges(changes).reload),
                    skipped: true
                };
            }
            const classified = classifyChanges(changes);
            state = Object.assign({}, state, settings, classified.live, classified.reload);
            const dirty = dirtyOperations(classified.live);
            const appliedKeys = [];
            let rendered = false;
            let alreadyLive = false;
            applying = true;
            try {
                dirty.forEach((name) => {
                    const result = runOperation(name, state);
                    if (!result.ran) return;
                    (OPERATION_KEYS[name] || []).forEach((key) => {
                        if (Object.prototype.hasOwnProperty.call(classified.live, key) || Object.prototype.hasOwnProperty.call(classified.live, canonicalKey(key))) {
                            appliedKeys.push(key);
                        }
                    });
                    if (result.rendered) {
                        rendered = true;
                        renderedOps[name] = true;
                    }
                });
                // A direct client message can race the storage echo that already
                // applied the same value (popup SETTINGS_UPDATE vs the content
                // script's own storage.onChanged apply). The snapshot marks the
                // value clean, so nothing re-renders, but the caller still needs
                // the truth: the live page already reflects this change. Report
                // those keys as applied without re-running the operation —
                // storage echoes keep reporting applied:false (nothing ran).
                if (source === "settings-update" && dirty.size === 0) {
                    alreadyLive = true;
                    Object.keys(classified.live).forEach((key) => {
                        const canonical = canonicalKey(key);
                        const operations = KEY_TO_OPERATIONS.get(key) || KEY_TO_OPERATIONS.get(canonical) || [];
                        if (!operations.length || !operations.every((name) => renderedOps[name])) return;
                        appliedKeys.push(key);
                    });
                }
                markSnapshot(classified.live);
            } finally {
                applying = false;
            }
            const uniqueApplied = Array.from(new Set(appliedKeys));
            return {
                applied: uniqueApplied.length > 0 && (rendered || alreadyLive),
                rendered,
                appliedKeys: uniqueApplied,
                reloadKeys: Object.keys(classified.reload),
                ignoredKeys: Object.keys(classified.ignored),
                source
            };
        }

        function apply(settings = {}, options = {}) {
            const source = options.source || "startup";
            state = Object.assign({}, state, settings);
            if (source === "startup") {
                Object.keys(snapshot).forEach((key) => { delete snapshot[key]; });
                Object.keys(renderedOps).forEach((key) => { delete renderedOps[key]; });
            }
            const live = {};
            Object.keys(settings || {}).forEach((key) => {
                if (classifyKey(key) === "live") live[key] = settings[key];
            });
            if (source === "startup") {
                LIVE_KEY_SET.forEach((key) => {
                    if (Object.prototype.hasOwnProperty.call(state, key) && live[key] === undefined) live[key] = state[key];
                });
            }
            return applyChanges(live, state, { source });
        }

        function reset() {
            Object.values(ledgers).forEach((ledger) => ledger?.restore?.());
            Object.keys(ledgers).forEach((key) => { delete ledgers[key]; });
            Array.from(styleNodes.keys()).forEach((id) => upsertStyle(id, ""));
            Object.keys(snapshot).forEach((key) => { delete snapshot[key]; });
            Object.keys(stats).forEach((key) => { delete stats[key]; });
            Object.keys(renderedOps).forEach((key) => { delete renderedOps[key]; });
            sidebarController?.reset?.();
            state = {};
        }

        function dispose() {
            reset();
        }

        return {
            apply,
            applyChanges,
            reset,
            dispose,
            stats: () => ({ ...stats }),
            snapshot: () => ({ ...snapshot }),
            upsertStyle
        };
    }

    return Object.freeze({
        LIVE_APPLY_GROUPS,
        STUDY_TOOLS_LIVE_KEYS,
        RELOAD_APPLY_REASONS,
        OPERATION_KEYS,
        classifyKey,
        liveApplyGroup,
        classifyChanges,
        canonicalKey,
        validateSettingsUpdateRequest,
        createSettingsApplicator,
        createFallbackLedger
    });
}));
