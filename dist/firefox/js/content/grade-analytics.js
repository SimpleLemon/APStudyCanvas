(function (root, factory) {
    "use strict";
    const api = factory();
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasContent = Object.assign(root.APStudyCanvasContent || {}, { GradeAnalytics: api });
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    // This module deliberately has no DOM, storage, or Canvas transport dependency.
    // Its input is a caller-owned snapshot of grade data already available to the
    // extension; all returned records are copies so an Imagine-If sandbox cannot
    // alter Canvas data or the caller's source objects.
    const VERSION = 1;
    const MAX_ASSIGNMENTS = 500;
    const MAX_GROUPS = 100;
    const MAX_SCENARIO_ADDITIONS = 50;
    const MAX_TEXT = 160;
    const EMPTY_SCORE = null;
    const LETTER_ORDER = Object.freeze(["A+", "A", "A-", "B+", "B", "B-", "C+", "C", "C-", "D+", "D", "D-", "F"]);
    const ZONES = Object.freeze([
        Object.freeze({ name: "excellent", minimum: 90 }),
        Object.freeze({ name: "on-track", minimum: 80 }),
        Object.freeze({ name: "watch", minimum: 70 }),
        Object.freeze({ name: "at-risk", minimum: 0 })
    ]);

    function finite(value) {
        if (typeof value === "number") return Number.isFinite(value) ? value : null;
        if (typeof value !== "string" || !value.trim()) return null;
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    function text(value, fallback) {
        if (typeof value !== "string" && typeof value !== "number") return fallback;
        const cleaned = String(value).replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_TEXT);
        return cleaned || fallback;
    }
    function identifier(value) {
        const candidate = text(value, null);
        return candidate && !/[\\/]/.test(candidate) ? candidate : null;
    }
    function freeze(value) {
        if (Array.isArray(value)) value.forEach(freeze);
        else if (value && typeof value === "object") Object.values(value).forEach(freeze);
        return Object.freeze(value);
    }
    function sourceArray(value) { return Array.isArray(value) ? value : []; }
    function safeDate(value) {
        if (typeof value !== "string" || value.length > 64) return null;
        const timestamp = Date.parse(value);
        return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
    }
    function percentage(score, possible) {
        return Number.isFinite(score) && Number.isFinite(possible) && possible > 0 ? (score / possible) * 100 : null;
    }
    function normalizedWeight(value) {
        const numeric = finite(value);
        if (!Number.isFinite(numeric) || numeric < 0) return null;
        return numeric > 1 ? numeric / 100 : numeric;
    }
    function groupFrom(source, index) {
        const id = identifier(source?.id ?? source?.assignment_group_id);
        if (!id) return null;
        return {
            id,
            name: text(source?.name, `Group ${index + 1}`),
            weight: normalizedWeight(source?.group_weight ?? source?.weight),
            dropped: Boolean(source?.dropped || source?.hidden)
        };
    }
    function assignmentFrom(source, index) {
        const id = identifier(source?.id ?? source?.assignment_id);
        if (!id) return null;
        const possible = finite(source?.points_possible ?? source?.pointsPossible);
        const rawScore = finite(source?.score ?? source?.submission?.score);
        const missing = Boolean(source?.missing ?? source?.submission?.missing);
        const excused = Boolean(source?.excused ?? source?.submission?.excused);
        const hidden = Boolean(source?.hidden || source?.hide_in_gradebook_column || source?.submission?.hidden);
        const dropped = Boolean(source?.dropped || source?.submission?.dropped || source?.submission?.drop);
        const groupId = identifier(source?.assignment_group_id ?? source?.groupId ?? source?.assignmentGroupId);
        // Canvas may report a missing submission without a numeric score. Treat it
        // as zero only when the assignment itself can meaningfully be scored.
        const score = rawScore === null && missing && Number.isFinite(possible) && possible > 0 ? 0 : rawScore;
        return {
            id,
            title: text(source?.name ?? source?.title, `Assignment ${index + 1}`),
            // Keep an unknown group identifier so a later scenario can add that
            // group; without a known weight it naturally falls back to points.
            groupId,
            pointsPossible: Number.isFinite(possible) && possible >= 0 ? possible : null,
            score,
            dueAt: safeDate(source?.due_at ?? source?.dueAt),
            hidden,
            dropped,
            missing,
            excused,
            ungraded: score === null,
            synthetic: Boolean(source?.synthetic)
        };
    }
    function normalizeGradeData(input) {
        const source = input && typeof input === "object" ? input : {};
        const groups = [];
        const seenGroups = new Set();
        sourceArray(source.assignmentGroups ?? source.groups).some((entry, index) => {
            const group = groupFrom(entry, index);
            if (group && !seenGroups.has(group.id)) { groups.push(group); seenGroups.add(group.id); }
            return groups.length >= MAX_GROUPS;
        });
        const assignments = [];
        const seenAssignments = new Set();
        sourceArray(source.assignments).some((entry, index) => {
            const assignment = assignmentFrom(entry, index);
            if (assignment && !seenAssignments.has(assignment.id)) { assignments.push(assignment); seenAssignments.add(assignment.id); }
            return assignments.length >= MAX_ASSIGNMENTS;
        });
        return freeze({ version: VERSION, courseId: identifier(source.courseId ?? source.course_id), groups, assignments });
    }
    function letterFor(score, bounds) {
        if (!Number.isFinite(score) || !bounds || typeof bounds !== "object") return null;
        for (const letter of LETTER_ORDER) {
            const tier = bounds[letter];
            const cutoff = finite(tier?.cutoff);
            if (Number.isFinite(cutoff) && score >= cutoff) return letter;
        }
        return Number.isFinite(finite(bounds.F?.cutoff)) ? "F" : null;
    }
    function zoneFor(score) {
        if (!Number.isFinite(score)) return null;
        return ZONES.find((zone) => score >= zone.minimum)?.name || null;
    }
    function included(assignment) {
        return !assignment.hidden && !assignment.dropped && !assignment.excused && Number.isFinite(assignment.score) && Number.isFinite(assignment.pointsPossible) && assignment.pointsPossible > 0;
    }
    function calculateScore(snapshot) {
        const assignments = snapshot.assignments.filter(included);
        const byGroup = new Map();
        assignments.forEach((assignment) => {
            const key = assignment.groupId || "__ungrouped__";
            const rows = byGroup.get(key) || [];
            rows.push(assignment); byGroup.set(key, rows);
        });
        const groups = new Map(snapshot.groups.map((group) => [group.id, group]));
        const weighted = [];
        byGroup.forEach((rows, id) => {
            const points = rows.reduce((sum, row) => sum + row.pointsPossible, 0);
            const earned = rows.reduce((sum, row) => sum + row.score, 0);
            const group = groups.get(id);
            const weight = group?.weight;
            if (Number.isFinite(weight) && weight > 0) weighted.push({ id, score: percentage(earned, points), weight });
        });
        const totalPossible = assignments.reduce((sum, row) => sum + row.pointsPossible, 0);
        const totalEarned = assignments.reduce((sum, row) => sum + row.score, 0);
        const pointsScore = percentage(totalEarned, totalPossible);
        if (!weighted.length) return { score: pointsScore, method: "points", earned: totalEarned, possible: totalPossible };
        const weights = weighted.reduce((sum, row) => sum + row.weight, 0);
        return { score: weights > 0 ? weighted.reduce((sum, row) => sum + row.score * row.weight, 0) / weights : pointsScore, method: "weighted-groups", earned: totalEarned, possible: totalPossible };
    }
    function historyFor(assignments, bounds, zones) {
        const rows = assignments.filter(included).slice().sort((left, right) => (left.dueAt || "9999").localeCompare(right.dueAt || "9999") || left.title.localeCompare(right.title) || left.id.localeCompare(right.id));
        let earned = 0; let possible = 0;
        return rows.map((assignment) => {
            earned += assignment.score; possible += assignment.pointsPossible;
            const score = percentage(assignment.score, assignment.pointsPossible);
            return { id: assignment.id, title: assignment.title, dueAt: assignment.dueAt, score, runningScore: percentage(earned, possible), letter: letterFor(score, bounds), zone: zones ? zoneFor(score) : null };
        });
    }
    function distributionFor(assignments, bounds) {
        const bins = new Map();
        assignments.filter(included).forEach((assignment) => {
            const score = percentage(assignment.score, assignment.pointsPossible);
            const key = letterFor(score, bounds) || "Unscaled";
            bins.set(key, (bins.get(key) || 0) + 1);
        });
        return [...LETTER_ORDER, "Unscaled"].map((letter) => ({ letter, count: bins.get(letter) || 0 })).filter((row) => row.count > 0);
    }
    function calculateAnalytics(source, { bounds = null, zones = false } = {}) {
        const snapshot = normalizeGradeData(source);
        const score = calculateScore(snapshot);
        const active = snapshot.assignments.filter(included);
        const history = historyFor(snapshot.assignments, bounds, zones === true);
        const statuses = snapshot.assignments.reduce((result, assignment) => {
            if (assignment.hidden) result.hidden += 1;
            else if (assignment.dropped) result.dropped += 1;
            else if (assignment.excused) result.excused += 1;
            else if (assignment.ungraded) result.ungraded += 1;
            else if (assignment.missing) result.missing += 1;
            return result;
        }, { hidden: 0, dropped: 0, excused: 0, ungraded: 0, missing: 0 });
        return freeze({
            version: VERSION,
            source: snapshot,
            overview: { score: score.score, letter: letterFor(score.score, bounds), zone: zones === true ? zoneFor(score.score) : null, method: score.method, earned: score.earned, possible: score.possible, counted: active.length, ...statuses, estimate: true },
            distribution: distributionFor(snapshot.assignments, bounds),
            history,
            lastFive: history.slice(-5),
            heatmap: history.map((row) => ({ id: row.id, title: row.title, score: row.score, letter: row.letter, zone: row.zone, label: Number.isFinite(row.score) ? `${row.title}: ${row.score.toFixed(1)}%${row.letter ? ` (${row.letter})` : ""}` : `${row.title}: ungraded` }))
        });
    }
    function blankScenario() { return { version: VERSION, assignments: {}, groups: {}, final: null, pinnedFinal: null }; }
    function cloneScenario(scenario) {
        const source = scenario?.version === VERSION && scenario && typeof scenario === "object" ? scenario : blankScenario();
        return { version: VERSION, assignments: { ...(source.assignments || {}) }, groups: { ...(source.groups || {}) }, final: source.final ? { ...source.final } : null, pinnedFinal: source.pinnedFinal ? { ...source.pinnedFinal } : null };
    }
    function createScenario() { return freeze(blankScenario()); }
    function scenarioAssignment(scenario, id, patch) {
        const key = identifier(id); if (!key || !patch || typeof patch !== "object") return freeze(cloneScenario(scenario));
        const next = cloneScenario(scenario); next.assignments[key] = { ...(next.assignments[key] || {}), ...patch };
        return freeze(next);
    }
    function addScenarioAssignment(scenario, assignment) {
        const id = identifier(assignment?.id); const next = cloneScenario(scenario);
        if (!id || Object.keys(next.assignments).filter((key) => next.assignments[key]?.add).length >= MAX_SCENARIO_ADDITIONS) return freeze(next);
        next.assignments[id] = { ...assignment, id, add: true, synthetic: true };
        return freeze(next);
    }
    function removeScenarioAssignment(scenario, id) { return scenarioAssignment(scenario, id, { remove: true }); }
    function scenarioGroup(scenario, id, patch) {
        const key = identifier(id); if (!key || !patch || typeof patch !== "object") return freeze(cloneScenario(scenario));
        const next = cloneScenario(scenario); next.groups[key] = { ...(next.groups[key] || {}), ...patch };
        return freeze(next);
    }
    function addScenarioGroup(scenario, group) {
        const id = identifier(group?.id); const next = cloneScenario(scenario);
        if (!id || Object.keys(next.groups).filter((key) => next.groups[key]?.add).length >= MAX_GROUPS) return freeze(next);
        next.groups[id] = { ...group, id, add: true };
        return freeze(next);
    }
    function removeScenarioGroup(scenario, id) { return scenarioGroup(scenario, id, { remove: true }); }
    function setScenarioFinal(scenario, final) {
        const next = cloneScenario(scenario); const pointsPossible = finite(final?.pointsPossible); const score = finite(final?.score);
        next.final = Number.isFinite(pointsPossible) && pointsPossible > 0 && Number.isFinite(score) ? { id: "__final__", title: text(final?.title, "Final assessment"), groupId: identifier(final?.groupId), pointsPossible, score } : null;
        next.pinnedFinal = null; return freeze(next);
    }
    function resetScenario() { return createScenario(); }
    function materializeScenario(source, scenario) {
        const snapshot = normalizeGradeData(source); const changes = cloneScenario(scenario);
        const groups = snapshot.groups.filter((group) => !changes.groups[group.id]?.remove).map((group) => ({ ...group, ...changes.groups[group.id] }));
        Object.entries(changes.groups).forEach(([id, change]) => { if (change?.add && !groups.some((group) => group.id === id)) groups.push({ ...change, id }); });
        const known = new Set(snapshot.assignments.map((assignment) => assignment.id));
        const assignments = snapshot.assignments.filter((assignment) => !changes.assignments[assignment.id]?.remove).map((assignment) => ({ ...assignment, ...changes.assignments[assignment.id] }));
        Object.entries(changes.assignments).forEach(([id, change]) => { if (change?.add && !known.has(id)) assignments.push({ ...change, id }); });
        if (changes.final) assignments.push({ ...changes.final, synthetic: true });
        return normalizeGradeData({ courseId: snapshot.courseId, groups, assignments });
    }
    function pinFinalEstimate(source, scenario, options) {
        const next = cloneScenario(scenario); const analytics = calculateAnalytics(materializeScenario(source, next), options);
        next.pinnedFinal = { score: analytics.overview.score, letter: analytics.overview.letter, method: analytics.overview.method, estimate: true };
        return freeze(next);
    }

    return freeze({ VERSION, MAX_ASSIGNMENTS, MAX_GROUPS, MAX_SCENARIO_ADDITIONS, EMPTY_SCORE, LETTER_ORDER, ZONES, normalizeGradeData, calculateAnalytics, createScenario, scenarioAssignment, addScenarioAssignment, removeScenarioAssignment, scenarioGroup, addScenarioGroup, removeScenarioGroup, setScenarioFinal, pinFinalEstimate, resetScenario, materializeScenario });
}));
