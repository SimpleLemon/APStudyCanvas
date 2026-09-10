(function (root, factory) {
    "use strict";

    const schema = root?.APStudyCanvasSchema || (typeof require === "function" ? require("../settings-schema.js") : null);
    const api = factory(schema);
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasSidebarModel = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function (schema) {
    "use strict";

    const DEFAULT_WIDTHS = Object.freeze({ expanded: 180, collapsed: 86 });
    const WIDTH_BOUNDS = Object.freeze({
        expanded: Object.freeze({ min: 160, max: 320 }),
        collapsed: Object.freeze({ min: 48, max: 112 })
    });
    const DEFAULT_PAGE_ORDER = Object.freeze(schema?.defaultSidebarPageOrder
        ? Array.from(schema.defaultSidebarPageOrder)
        : ["dashboard", "courses", "calendar", "inbox", "history", "help", "apstudy:planner", "apstudy:notes", "apstudy:grades", "apstudy:study"]);
    const DEFAULT_PAGE_VISIBILITY = Object.freeze(schema?.defaultSidebarPageVisibility
        ? { ...schema.defaultSidebarPageVisibility }
        : { dashboard: true, courses: true, calendar: true, inbox: true, history: true, help: true, "apstudy:planner": true, "apstudy:notes": true, "apstudy:grades": true, "apstudy:study": true });
    const SCALE_PRESETS = Object.freeze(schema?.sidebarScalePresets || {
        tiny: Object.freeze({ icon: 12, label: 10 }),
        small: Object.freeze({ icon: 14, label: 12 }),
        medium: Object.freeze({ icon: 16, label: 14 }),
        large: Object.freeze({ icon: 18, label: 16 }),
        "extra-large": Object.freeze({ icon: 21, label: 18 })
    });
    const SCALE_ORDER = Object.freeze(["tiny", "small", "medium", "large", "extra-large"]);
    const ENTER_HIDDEN_WIDTH = 640;
    const EXIT_HIDDEN_WIDTH = 688;
    const ENABLED_ALIASES = Object.freeze(["better_sidebar", "sidebar_enabled", "enable_sidebar", "enabled"]);

    function isPlainObject(value) {
        if (!value || typeof value !== "object" || Array.isArray(value)) return false;
        const prototype = Object.getPrototypeOf(value);
        return prototype === Object.prototype || prototype === null;
    }

    function clone(value) {
        if (value === undefined) return undefined;
        if (typeof structuredClone === "function") return structuredClone(value);
        return JSON.parse(JSON.stringify(value));
    }

    function isStableId(value) {
        if (schema?.isStableSidebarId) return schema.isStableSidebarId(value);
        return typeof value === "string"
            && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
            && !["__proto__", "prototype", "constructor"].includes(value);
    }

    function normalizeWidth(kind, value) {
        const bounds = WIDTH_BOUNDS[kind];
        if (!bounds || typeof value !== "number" || !Number.isFinite(value)) return null;
        return Math.min(bounds.max, Math.max(bounds.min, Math.round(value)));
    }

    // The presence flags let a storage reader distinguish a missing default
    // from an explicit value. This function never mutates or writes `raw`.
    function resolveSidebarWidths(raw) {
        const source = isPlainObject(raw) ? raw : {};
        const expandedPresent = Object.prototype.hasOwnProperty.call(source, "sidebar_expanded_width");
        const collapsedPresent = Object.prototype.hasOwnProperty.call(source, "sidebar_collapsed_width");
        const expandedValue = normalizeWidth("expanded", source.sidebar_expanded_width);
        const collapsedValue = normalizeWidth("collapsed", source.sidebar_collapsed_width);
        return {
            expanded: expandedValue ?? DEFAULT_WIDTHS.expanded,
            collapsed: collapsedValue ?? DEFAULT_WIDTHS.collapsed,
            presence: { expanded: expandedPresent, collapsed: collapsedPresent },
            usedStored: { expanded: expandedValue !== null, collapsed: collapsedValue !== null }
        };
    }

    function normalizeDensity(value, fallback = "cozy") {
        if (value === "compact" || value === "cozy") return value;
        // These are accepted only as compatibility inputs. Comfortable was
        // the old name for cozy; dense was the old compact-like variant.
        if (value === "comfortable") return "cozy";
        if (value === "dense") return "compact";
        return fallback === "compact" ? "compact" : "cozy";
    }

    function normalizePreferredState(value, fallback = "expanded") {
        if (value === "collapsed") return "collapsed";
        if (value === "expanded") return "expanded";
        return fallback === "collapsed" ? "collapsed" : "expanded";
    }

    const AVATAR_SIZES = Object.freeze(["small", "medium", "large"]);

    function normalizeAvatarSize(value, fallback = "medium") {
        if (AVATAR_SIZES.includes(value)) return value;
        return AVATAR_SIZES.includes(fallback) ? fallback : "medium";
    }

    function normalizeScalePreset(value, fallback = "medium") {
        if (typeof value !== "string") return SCALE_PRESETS[fallback] ? fallback : "medium";
        const normalized = value.trim().toLowerCase().replace(/_/g, "-");
        const aliases = { "extra-large": "extra-large", xlarge: "extra-large", "x-large": "extra-large", xl: "extra-large" };
        const candidate = aliases[normalized] || normalized;
        return SCALE_PRESETS[candidate] ? candidate : (SCALE_PRESETS[fallback] ? fallback : "medium");
    }

    function nearestScalePreset(icon, label) {
        const numericIcon = Number(icon);
        const numericLabel = Number(label);
        if (!Number.isFinite(numericIcon) || !Number.isFinite(numericLabel)) return "medium";
        return SCALE_ORDER.reduce((best, name) => {
            const candidate = SCALE_PRESETS[name];
            const current = SCALE_PRESETS[best];
            const distance = Math.abs(candidate.icon - numericIcon) + Math.abs(candidate.label - numericLabel);
            const bestDistance = Math.abs(current.icon - numericIcon) + Math.abs(current.label - numericLabel);
            return distance < bestDistance ? name : best;
        }, "medium");
    }

    function scalePresetFromLegacy(raw) {
        const source = isPlainObject(raw) ? raw : {};
        if (typeof source.sidebar_scale_preset === "string") return normalizeScalePreset(source.sidebar_scale_preset);
        if (source.sidebar_icon_size !== undefined || source.sidebar_label_size !== undefined) {
            return nearestScalePreset(source.sidebar_icon_size, source.sidebar_label_size);
        }
        const numeric = Number(source.sidebar_scale);
        if (!Number.isFinite(numeric)) return "medium";
        const icon = 16 * numeric / 100;
        const label = 14 * numeric / 100;
        return nearestScalePreset(icon, label);
    }

    function booleanValue(source, key, fallback) {
        return typeof source[key] === "boolean" ? source[key] : fallback;
    }

    function normalizeSectionVisibility(raw) {
        const source = isPlainObject(raw) ? raw : {};
        return {
            expanded: {
                pages: booleanValue(source, "sidebar_pages_visible_expanded", true),
                courses: booleanValue(source, "sidebar_courses_visible_expanded", true)
            },
            collapsed: {
                pages: booleanValue(source, "sidebar_pages_visible_collapsed", true),
                courses: booleanValue(source, "sidebar_courses_visible_collapsed", false)
            }
        };
    }

    function readEnabled(source) {
        for (const key of ENABLED_ALIASES) {
            if (typeof source[key] === "boolean") return source[key];
        }
        return false;
    }

    function normalizeSidebarSettings(raw) {
        const source = isPlainObject(raw) ? raw : {};
        const widths = resolveSidebarWidths(source);
        const preferredState = source.sidebar_preferred_state === undefined
            ? typeof source.dashboard_sidebar_expanded === "boolean"
                ? normalizePreferredState(source.dashboard_sidebar_expanded ? "expanded" : "collapsed")
                : typeof source.course_sidebar_expanded === "boolean"
                    ? normalizePreferredState(source.course_sidebar_expanded ? "expanded" : "collapsed")
                    : "expanded"
            : normalizePreferredState(source.sidebar_preferred_state);
        const scale = scalePresetFromLegacy(source);
        const pageOrder = normalizePageOrder(source.sidebar_page_order);
        const pageVisibility = normalizePageVisibility(source.sidebar_page_visibility);
        return {
            enabled: readEnabled(source),
            preferredState,
            widths: { expanded: widths.expanded, collapsed: widths.collapsed },
            density: normalizeDensity(source.sidebar_density),
            scale,
            scaleValues: clone(SCALE_PRESETS[scale]),
            logoVisible: booleanValue(source, "sidebar_logo_visible", true),
            productEntryVisible: booleanValue(source, "sidebar_product_entry_visible", true),
            avatarSize: normalizeAvatarSize(source.sidebar_avatar_size),
            collapsedLabels: booleanValue(source, "sidebar_collapsed_labels", true),
            sectionVisibility: normalizeSectionVisibility(source),
            sectionFolded: {
                pages: booleanValue(source, "sidebar_pages_folded", false),
                courses: booleanValue(source, "sidebar_courses_folded", false)
            },
            pageOrder,
            pageVisibility,
            tooltips: booleanValue(source, "sidebar_tooltips", true),
            // Accessible names are structural, not an optional visual setting.
            accessibleNames: true
        };
    }

    function normalizePageIds(pages) {
        const entries = Array.isArray(pages) ? pages : [];
        const ids = [];
        const seen = new Set();
        entries.forEach((page) => {
            const id = typeof page === "string" ? page : page?.id;
            if (!isStableId(id) || seen.has(id)) return;
            seen.add(id);
            ids.push(id);
        });
        return ids;
    }

    function normalizePageOrder(value, defaults = DEFAULT_PAGE_ORDER) {
        if (schema?.normalizeSidebarOrder) return schema.normalizeSidebarOrder(value, defaults);
        const known = normalizePageIds(defaults);
        const knownEntries = [];
        const unknownEntries = [];
        const seen = new Set();
        (Array.isArray(value) ? value : []).forEach((id) => {
            if (!isStableId(id) || seen.has(id)) return;
            seen.add(id);
            (known.includes(id) ? knownEntries : unknownEntries).push(id);
        });
        known.forEach((id) => {
            if (!seen.has(id)) knownEntries.push(id);
        });
        return knownEntries.concat(unknownEntries);
    }

    function normalizePageVisibility(value, defaults = DEFAULT_PAGE_VISIBILITY) {
        if (schema?.normalizeSidebarVisibility) return schema.normalizeSidebarVisibility(value, defaults);
        const source = isPlainObject(value) ? value : {};
        const result = {};
        Object.keys(defaults).forEach((id) => { result[id] = source[id] !== false; });
        Object.keys(source).forEach((id) => {
            if (!Object.prototype.hasOwnProperty.call(result, id) && isStableId(id) && typeof source[id] === "boolean") result[id] = source[id];
        });
        return result;
    }

    function reconcileSidebarPages({ knownPages, savedOrder, savedVisibility } = {}) {
        const pages = Array.isArray(knownPages) ? knownPages : [];
        const knownIds = normalizePageIds(pages);
        const order = normalizePageOrder(savedOrder, knownIds.length ? knownIds : DEFAULT_PAGE_ORDER);
        const visibility = normalizePageVisibility(savedVisibility, Object.fromEntries((knownIds.length ? knownIds : DEFAULT_PAGE_ORDER).map((id) => [id, true])));
        const byId = new Map(pages.map((page) => [typeof page === "string" ? page : page?.id, page]));
        const unknownIds = order.filter((id) => !byId.has(id));
        unknownIds.forEach((id) => {
            byId.set(id, {
                id,
                label: "Canvas destination",
                href: null,
                source: "canvas",
                iconRole: "canvas",
                available: false,
                known: false,
                transportable: true
            });
        });
        return {
            order,
            visibility,
            pages: order.map((id) => byId.get(id)).filter(Boolean),
            unknownIds
        };
    }

    function courseId(course) {
        const value = course && typeof course === "object" ? course.id ?? course.courseId ?? course.course_id : course;
        if (typeof value !== "string" && typeof value !== "number") return null;
        const normalized = String(value).trim();
        return normalized && normalized.length <= 128 && !/[\u0000-\u001f\u007f]/.test(normalized) ? normalized : null;
    }

    function reconcileSidebarCourses({ courses, savedOrder } = {}) {
        const source = Array.isArray(courses) ? courses : [];
        const unique = [];
        const byId = new Map();
        source.forEach((course) => {
            const id = courseId(course);
            if (!id || byId.has(id)) return;
            const record = typeof course === "object" && course !== null ? { ...course, id } : { id };
            byId.set(id, record);
            unique.push(record);
        });
        const sourceIds = unique.map((course) => course.id);
        const seen = new Set();
        const order = [];
        (Array.isArray(savedOrder) ? savedOrder : []).forEach((value) => {
            const id = courseId(value);
            if (!id || seen.has(id) || !byId.has(id)) return;
            seen.add(id);
            order.push(id);
        });
        sourceIds.forEach((id) => {
            if (!seen.has(id)) order.push(id);
        });
        return { order, courses: order.map((id) => byId.get(id)) };
    }

    function normalizeCanvasOrigin(value) {
        if (schema?.normalizeCanvasOrigin) return schema.normalizeCanvasOrigin(value);
        if (typeof value !== "string" || !value.trim()) return null;
        try {
            const candidate = value.trim();
            const url = new URL(candidate.includes("://") ? candidate : `https://${candidate}`);
            if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || (url.pathname !== "" && url.pathname !== "/") || !url.hostname || url.hostname === "localhost" || url.hostname === "127.0.0.1") return null;
            return url.origin;
        } catch (error) {
            return null;
        }
    }

    function normalizeCanvasIdentity(value = {}) {
        if (!isPlainObject(value)) return null;
        const origin = normalizeCanvasOrigin(value.origin || value.canvasOrigin);
        const rawId = value.userId ?? value.user_id ?? value.canvasUser?.id ?? value.user?.id ?? value.accountId ?? value.account_id;
        if (!origin || (typeof rawId !== "string" && typeof rawId !== "number")) return null;
        const userId = String(rawId);
        if (!/^[1-9]\d{0,19}$/.test(userId) || typeof rawId === "number" && !Number.isSafeInteger(rawId)) return null;
        return { origin, userId };
    }

    function courseOrderStorageKey(accountKey) {
        if (typeof accountKey !== "string" || !/^[a-f0-9]{64}$/i.test(accountKey)) return null;
        return `apstudycanvas.sidebar.course-order.v1:${accountKey.toLowerCase()}`;
    }

    function deriveRuntimeState({ enabled, preferredState, viewportWidth, availableWidth, currentState, expandedWidth = DEFAULT_WIDTHS.expanded, collapsedWidth = DEFAULT_WIDTHS.collapsed } = {}) {
        if (enabled !== true) return "native";
        const preferred = normalizePreferredState(preferredState);
        const railWidth = preferred === "collapsed" ? collapsedWidth : expandedWidth;
        const available = Number.isFinite(availableWidth)
            ? availableWidth
            : Number.isFinite(viewportWidth)
                ? viewportWidth - railWidth
                : Infinity;
        if (currentState === "hidden") return available >= EXIT_HIDDEN_WIDTH ? preferred : "hidden";
        if (available < ENTER_HIDDEN_WIDTH) return "hidden";
        return currentState === "expanded" || currentState === "collapsed" ? currentState : preferred;
    }

    return Object.freeze({
        DEFAULT_WIDTHS,
        WIDTH_BOUNDS,
        DEFAULT_PAGE_ORDER,
        DEFAULT_PAGE_VISIBILITY,
        SCALE_PRESETS,
        SCALE_ORDER,
        ENTER_HIDDEN_WIDTH,
        EXIT_HIDDEN_WIDTH,
        isPlainObject,
        clone,
        isStableId,
        resolveSidebarWidths,
        normalizeDensity,
        normalizePreferredState,
        normalizeAvatarSize,
        AVATAR_SIZES,
        normalizeScalePreset,
        nearestScalePreset,
        scalePresetFromLegacy,
        normalizeSidebarSettings,
        normalizePageOrder,
        normalizePageVisibility,
        reconcileSidebarPages,
        courseId,
        reconcileSidebarCourses,
        normalizeCanvasOrigin,
        normalizeCanvasIdentity,
        courseOrderStorageKey,
        buildCourseOrderStorageKey: courseOrderStorageKey,
        deriveRuntimeState
    });
}));
