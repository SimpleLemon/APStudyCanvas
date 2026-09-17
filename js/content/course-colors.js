(function (root, factory) {
    "use strict";
    const api = factory();
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) {
        root.APStudyCanvasCourseColors = api;
        root.APStudyCanvasContent = Object.assign(root.APStudyCanvasContent || {}, { CourseColors: api });
    }
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    function text(value, fallback = "") {
        if (value === null || value === undefined) return fallback;
        const result = String(value).replace(/[\u0000-\u001f\u007f]/g, "").trim();
        return result || fallback;
    }

    // Deterministic fallback palette: twelve muted hue families balanced
    // around the Nest navy/gold world — navy, teal, plum, forest, cranberry,
    // ochre, violet, cyan, olive, terracotta, mint, rose — so a typical course
    // load paints every dot a different color and hashed assignments never
    // stack earth tones against parchment surfaces. Shared by the sidebar rail
    // and the To-Do rail so both surfaces resolve the exact same course color
    // for the same course id; past twelve courses the deterministic hash
    // cycles, exactly like Nest's sixteen-color course palette.
    const FALLBACK_COURSE_PALETTE = Object.freeze([
        "#294d91", "#1e6f68", "#7d3f68", "#386641", "#b5484d", "#a8842c",
        "#55459c", "#2e7f95", "#6f7a2e", "#a25b3c", "#3f7f5f", "#a44a6b"
    ]);

    function normalizeHexColor(value) {
        const candidate = text(value).toLowerCase();
        return /^#[0-9a-f]{3,8}$/.test(candidate) ? candidate : null;
    }

    function fallbackCourseHash(key) {
        return Array.from(key).reduce((value, character) => ((value * 31) + character.charCodeAt(0)) >>> 0, 0);
    }

    function courseColor(course, index = 0) {
        const authoritative = normalizeHexColor(course?.color);
        if (authoritative) return authoritative;
        const key = text(course?.id || course?.course_id || course?.code || course?.label || course?.name);
        return FALLBACK_COURSE_PALETTE[(key ? fallbackCourseHash(key) : Math.max(0, index)) % FALLBACK_COURSE_PALETTE.length];
    }

    // One resolved color per displayed course. An authoritative color already
    // carried on the record (Canvas custom colors merge upstream, or the
    // Personal course's own gold) always wins and may legitimately repeat when
    // the user assigned the same color twice. Every other course takes a
    // deterministic palette slot keyed by its stable course id, probing
    // forward past colors already claimed in this displayed set — so displayed
    // fallback colors stay distinct (BC's index-collision duplicates are gone)
    // and rerenders, filter changes, and reloads reproduce the same set
    // because the assignment never depends on task or course arrival order.
    function resolveCourseColors(courses, palette = FALLBACK_COURSE_PALETTE) {
        const list = Array.isArray(courses) ? courses : [];
        const resolved = list.map((course) => normalizeHexColor(course?.color));
        const used = new Set(resolved.filter(Boolean));
        list
            .map((course, index) => ({ index, id: text(course?.id || course?.course_id || course?.code || course?.label || course?.name) }))
            .filter(({ index }) => !resolved[index])
            .sort((left, right) => (left.id === right.id ? left.index - right.index : left.id < right.id ? -1 : 1))
            .forEach(({ id, index }) => {
                const start = id ? fallbackCourseHash(id) % palette.length : 0;
                let assigned = null;
                for (let probe = 0; probe < palette.length && !assigned; probe += 1) {
                    const candidate = palette[(start + probe) % palette.length];
                    if (!used.has(candidate)) assigned = candidate;
                }
                resolved[index] = assigned || palette[start];
                used.add(resolved[index]);
            });
        return resolved;
    }

    return Object.freeze({
        FALLBACK_COURSE_PALETTE,
        normalizeHexColor,
        fallbackCourseHash,
        courseColor,
        resolveCourseColors
    });
}));
