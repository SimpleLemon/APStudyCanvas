(function (root, factory) {
    "use strict";
    const api = factory();
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasContent = Object.assign(root.APStudyCanvasContent || {}, { Gpa: api });
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    // Displayed when no course contributes credits. The shipped cumulative_gpa
    // default (js/settings-schema.js) uses weight "dnc", and every course whose
    // Canvas grade is blank is initialised to "dnc" too, so an unconfigured
    // calculator legitimately has nothing to average. That is an empty state,
    // not a failure, and it must never render as the string "NaN".
    const EMPTY_DISPLAY = "—";
    const EMPTY_MESSAGE = "No courses are counted yet. Open Edit Calculator to set a grade, credits, and a weight for each course.";
    const NO_LETTER = "--";
    const EXCLUDED_WEIGHT = "dnc";
    // Descending cutoff order. Resolution walks this list and takes the first
    // tier the grade clears, so the order is part of the contract.
    const GRADE_ORDER = Object.freeze(["A+", "A", "A-", "B+", "B", "B-", "C+", "C", "C-", "D+", "D", "D-", "F"]);
    const FALLBACK_LETTER = "F";
    const WEIGHT_BONUS = Object.freeze({ ap: 1, honors: 0.5 });

    function toNumber(value) {
        if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
        if (typeof value !== "string") return NaN;
        const trimmed = value.trim();
        if (!trimmed) return NaN;
        return Number.parseFloat(trimmed);
    }

    function finiteOrNull(value) {
        return Number.isFinite(value) ? value : null;
    }

    function tierFor(letter, bounds) {
        const tier = bounds?.[letter];
        if (!tier || typeof tier !== "object") return null;
        const gpa = toNumber(tier.gpa);
        if (!Number.isFinite(gpa)) return null;
        return { letter, gpa, cutoff: toNumber(tier.cutoff) };
    }

    function resolveGrade(grade, bounds) {
        if (!Number.isFinite(grade)) return null;
        for (const letter of GRADE_ORDER) {
            const tier = tierFor(letter, bounds);
            if (!tier || !Number.isFinite(tier.cutoff)) continue;
            if (grade >= tier.cutoff) return { letter: tier.letter, gpa: tier.gpa };
        }
        const fallback = tierFor(FALLBACK_LETTER, bounds);
        return fallback ? { letter: fallback.letter, gpa: fallback.gpa } : null;
    }

    function weightBonus(weight) {
        const bonus = WEIGHT_BONUS[weight];
        return Number.isFinite(bonus) ? bonus : 0;
    }

    // Pure. `courses` are plain rows read out of the DOM by the caller:
    // { weight, credits, grade } where credits/grade may be raw input strings.
    // `cumulative` is the optional prior-GPA row: { grade, credits }.
    function computeGpa({ courses, bounds, weighted, cumulative } = {}) {
        const rows = Array.isArray(courses) ? courses : [];
        const resolved = [];
        let qualityPoints = 0;
        let weightedQualityPoints = 0;
        let numCredits = 0;
        let counted = 0;

        for (const row of rows) {
            const weight = typeof row?.weight === "string" ? row.weight : "";
            const credits = toNumber(row?.credits);
            const grade = toNumber(row?.grade);
            // Number.isFinite, not falsiness: a legitimate 0% grade counts.
            if (weight === EXCLUDED_WEIGHT || !Number.isFinite(grade) || !Number.isFinite(credits)) {
                resolved.push(Object.freeze({ letter: NO_LETTER, gpa: null, counted: false }));
                continue;
            }
            const tier = resolveGrade(grade, bounds);
            if (!tier) {
                resolved.push(Object.freeze({ letter: NO_LETTER, gpa: null, counted: false }));
                continue;
            }
            qualityPoints += tier.gpa * credits;
            weightedQualityPoints += (tier.gpa + weightBonus(weight)) * credits;
            numCredits += credits;
            counted += 1;
            resolved.push(Object.freeze({ letter: tier.letter, gpa: tier.gpa, counted: true }));
        }

        // The original defect: numCredits === 0 divided into 0 quality points,
        // then .toFixed(2) turned NaN into the literal text "NaN".
        const unweighted = numCredits === 0 ? null : finiteOrNull(qualityPoints / numCredits);
        const weightedGpa = numCredits === 0 ? null : finiteOrNull(weightedQualityPoints / numCredits);

        const priorGrade = toNumber(cumulative?.grade);
        const priorCredits = toNumber(cumulative?.credits);
        // Guard the (g * c) term: a blank or "--" prior row must contribute
        // neither points nor credits rather than poisoning the average.
        const priorCounted = Number.isFinite(priorGrade) && Number.isFinite(priorCredits) && priorCredits > 0;
        const basePoints = weighted === true ? weightedQualityPoints : qualityPoints;
        const cumulativeCredits = numCredits + (priorCounted ? priorCredits : 0);
        const cumulativePoints = basePoints + (priorCounted ? priorGrade * priorCredits : 0);
        const cumulativeGpa = cumulativeCredits > 0 ? finiteOrNull(cumulativePoints / cumulativeCredits) : null;

        return Object.freeze({
            courses: Object.freeze(resolved),
            counted,
            credits: numCredits,
            qualityPoints,
            weightedQualityPoints,
            priorCounted,
            unweighted,
            weighted: weightedGpa,
            cumulative: cumulativeGpa
        });
    }

    function formatGpa(value, { digits = 2, empty = EMPTY_DISPLAY } = {}) {
        return Number.isFinite(value) ? value.toFixed(digits) : empty;
    }

    return Object.freeze({
        EMPTY_DISPLAY,
        EMPTY_MESSAGE,
        NO_LETTER,
        EXCLUDED_WEIGHT,
        GRADE_ORDER,
        resolveGrade,
        computeGpa,
        formatGpa
    });
}));
