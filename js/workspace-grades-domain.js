(function (root, factory) {
    "use strict";
    const api = factory(root?.APStudyCanvasContent?.GradeAnalytics, root?.APStudyCanvasContent?.Gpa);
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasWorkspaceGradesDomain = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function (defaultAnalytics, defaultGpa) {
    "use strict";

    const VERSION = 1;
    const METRICS = Object.freeze(["assignment-percentage"]);
    const CHART_TYPES = Object.freeze(["scores-over-time", "score-histogram", "assignment-group-bars"]);
    const DATE_RANGES = Object.freeze(["all", "last-30-days", "last-90-days", "custom"]);
    const COMPARISONS = Object.freeze(["current", "scenario"]);
    const MAX_COURSES = 200;
    const PREFS_PREFIX = "apstudycanvas.grades.chart-prefs.v1:";
    const DEFAULT_PREFS = Object.freeze({ version: VERSION, courseId: null, metric: "assignment-percentage", dateRange: "all", chartType: "scores-over-time", comparison: "current", start: null, end: null });

    function clone(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }
    function freeze(value) {
        if (Array.isArray(value)) value.forEach(freeze);
        else if (value && typeof value === "object") Object.values(value).forEach(freeze);
        return Object.freeze(value);
    }
    function text(value, max = 160) {
        return typeof value === "string" || typeof value === "number"
            ? String(value).replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, max)
            : "";
    }
    function id(value) { const result = text(value, 100); return result && !/[\\/]/.test(result) ? result : null; }
    function finite(value) { const result = value === "" || value === null || value === undefined ? NaN : Number(value); return Number.isFinite(result) ? result : null; }
    function iso(value) { if (typeof value !== "string" || value.length > 64) return null; const time = Date.parse(value); return Number.isFinite(time) ? new Date(time).toISOString() : null; }
    function error(code, message) { const result = new Error(message); result.code = code; return result; }
    function abortError() { return error("GRADES_READ_ABORTED", "The grade read was cancelled."); }
    function throwIfAborted(signal) { if (signal?.aborted) throw abortError(); }

    function verifiedAccount(value) {
        const account = value?.account && typeof value.account === "object" ? value.account : value;
        const canvas = account?.canvas && typeof account.canvas === "object" ? account.canvas : account;
        let origin = null;
        try { const parsed = new URL(String(canvas?.origin || "")); if (parsed.protocol === "https:" && parsed.origin === canvas.origin && !parsed.username && !parsed.password) origin = parsed.origin; } catch (ignored) {}
        const scope = typeof account?.scope === "string" && account.scope.startsWith("canvas:") ? account.scope : null;
        const explicitlyUnverified = account?.canvas && canvas?.verified !== true;
        if (!scope || explicitlyUnverified || !origin || !/^[a-f0-9]{64}$/.test(String(canvas.accountKey || ""))) {
            throw error("GRADES_ACCOUNT_UNVERIFIED", "Grades require a verified Canvas account. Reload Canvas and try again.");
        }
        return freeze({ scope, origin, accountKey: String(canvas.accountKey), accountId: /^\d+$/.test(String(canvas.accountId || "")) ? String(canvas.accountId) : null });
    }
    function accountFingerprint(value) { const account = verifiedAccount(value); return `${account.scope}|${account.origin}|${account.accountKey}|${account.accountId || ""}`; }
    function assertSameAccount(expected, actual) {
        if (accountFingerprint(actual) !== accountFingerprint(expected)) throw error("GRADES_ACCOUNT_STALE", "Your Canvas account changed while grades were loading. Close and reopen Grades.");
    }
    function completeCollection(value, label) {
        const items = Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : null;
        if (!items) throw error("GRADES_READ_INVALID", `Canvas returned invalid ${label} data.`);
        if (value?.complete === false || value?.truncated === true || value?.partial === true) throw error("GRADES_READ_INCOMPLETE", `Canvas returned incomplete ${label} data. No estimate was generated.`);
        return items;
    }
    function linkSignals(controller, signal) {
        if (!signal?.addEventListener) return () => {};
        const abort = () => controller.abort();
        signal.addEventListener("abort", abort, { once: true });
        return () => signal.removeEventListener?.("abort", abort);
    }

    function normalizeCourse(source) {
        const courseId = id(source?.id ?? source?.course_id);
        if (!courseId) return null;
        const enrollment = (Array.isArray(source?.enrollments) ? source.enrollments : []).find((item) => /student/i.test(String(item?.type || item?.role || ""))) || source?.enrollments?.[0] || {};
        const grades = enrollment.grades && typeof enrollment.grades === "object" ? enrollment.grades : {};
        const currentScore = finite(enrollment.computed_current_score ?? grades.current_score ?? source.currentScore);
        const officialScore = finite(enrollment.official_final_score ?? grades.official_final_score ?? source.officialScore);
        const name = text(source?.name ?? source?.course_name, 160) || `Course ${courseId}`;
        return {
            id: courseId,
            name,
            code: text(source?.course_code, 100) || null,
            currentGrade: currentScore === null ? null : { value: currentScore, status: "current", label: "Current Canvas grade" },
            officialGrade: officialScore === null ? null : { value: officialScore, status: "official", label: "Official final grade" },
            links: {
                overview: `/courses/${encodeURIComponent(courseId)}`,
                assignments: `/courses/${encodeURIComponent(courseId)}/assignments`,
                grades: `/courses/${encodeURIComponent(courseId)}/grades`
            }
        };
    }
    function normalizeCourses(source) {
        const complete = completeCollection(source, "course");
        if (complete.length > MAX_COURSES) throw error("GRADES_READ_INCOMPLETE", `Canvas returned more than ${MAX_COURSES} courses. No partial overview was generated.`);
        const rows = []; const seen = new Set();
        complete.some((entry) => {
            const row = normalizeCourse(entry);
            if (row && !seen.has(row.id)) { rows.push(row); seen.add(row.id); }
            return rows.length >= MAX_COURSES;
        });
        return freeze(rows);
    }

    function createGradeReadAdapter({ account, verifyAccount = async () => account, readCourses, readCourseGradeData, readAssignments, readAssignmentGroups, analytics = defaultAnalytics } = {}) {
        const expected = verifiedAccount(account);
        if (typeof readCourses !== "function") throw new TypeError("readCourses is required");
        if (typeof readCourseGradeData !== "function" && (typeof readAssignments !== "function" || typeof readAssignmentGroups !== "function")) throw new TypeError("A course grade-data reader or assignment and group readers are required");
        if (!analytics?.normalizeGradeData) throw new TypeError("GradeAnalytics is required");
        const active = new Set(); let disposed = false;

        async function run(reader, callerSignal) {
            if (disposed) throw error("GRADES_ADAPTER_DISPOSED", "The Grades reader is no longer active.");
            const controller = new AbortController(); const unlink = linkSignals(controller, callerSignal); active.add(controller);
            try {
                throwIfAborted(controller.signal);
                assertSameAccount(expected, await verifyAccount(controller.signal));
                const value = await reader(controller.signal);
                throwIfAborted(controller.signal);
                assertSameAccount(expected, await verifyAccount(controller.signal));
                return value;
            } catch (caught) {
                if (controller.signal.aborted || caught?.name === "AbortError" || caught?.code === "ABORT_ERR") throw abortError();
                throw caught;
            } finally { unlink(); active.delete(controller); }
        }
        async function overview(signal) {
            return run(async (requestSignal) => freeze({ account: expected, courses: normalizeCourses(await readCourses(requestSignal)) }), signal);
        }
        async function course(courseId, signal) {
            const key = id(courseId); if (!key) throw error("GRADES_COURSE_INVALID", "Choose a valid course.");
            return run(async (requestSignal) => {
                let result;
                if (typeof readCourseGradeData === "function") result = await readCourseGradeData(key, requestSignal);
                else {
                    const [assignments, groups] = await Promise.all([readAssignments(key, requestSignal), readAssignmentGroups(key, requestSignal)]);
                    result = { assignments, assignmentGroups: groups };
                }
                const assignments = completeCollection(result?.assignments, "assignment");
                const assignmentGroups = completeCollection(result?.assignmentGroups ?? result?.groups, "assignment group");
                if (assignments.length > analytics.MAX_ASSIGNMENTS || assignmentGroups.length > analytics.MAX_GROUPS) throw error("GRADES_READ_INCOMPLETE", "Canvas returned more grade data than the supported analytics bounds. No partial estimate was generated.");
                return freeze({ account: expected, courseId: key, source: analytics.normalizeGradeData({ courseId: key, assignments, assignmentGroups }) });
            }, signal);
        }
        function dispose() { disposed = true; active.forEach((controller) => controller.abort()); active.clear(); }
        return Object.freeze({ overview, course, dispose, get disposed() { return disposed; } });
    }

    function legacyGradeSettings(value) {
        const source = value?.grades && typeof value.grades === "object" ? value.grades : value;
        const courses = source?.courses && typeof source.courses === "object" && !Array.isArray(source.courses) ? clone(source.courses) : {};
        return { courses, priorGpa: source?.priorGpa ?? "", priorCredits: source?.priorCredits ?? "" };
    }
    function courseWeight(config) {
        if (config?.included === false) return "dnc";
        return ["regular", "honors", "ap", "dnc"].includes(config?.weight) ? config.weight : "regular";
    }
    function buildCourseOverview(courses, saved, { bounds, gpa = defaultGpa } = {}) {
        if (!gpa?.computeGpa || !gpa?.resolveGrade) throw new TypeError("Gpa is required");
        const settings = legacyGradeSettings(saved);
        const normalized = Array.isArray(courses) && courses.every((row) => row?.links && row?.currentGrade !== undefined) ? courses : normalizeCourses(courses || []);
        const rows = normalized.map((course) => {
            const config = settings.courses[course.id] && typeof settings.courses[course.id] === "object" ? settings.courses[course.id] : {};
            const current = course.currentGrade?.value ?? null;
            const whatIf = finite(config.whatIf);
            const credits = Math.max(0, finite(config.credits) ?? 0);
            const goal = finite(config.goal);
            return freeze({ ...course, credits, goal, included: config.included !== false, weight: courseWeight(config), scenarioGrade: whatIf === null ? null : { value: whatIf, status: "estimated", label: "Local what-if estimate" } });
        });
        const calculate = (scenario) => gpa.computeGpa({
            courses: rows.map((row) => ({ weight: row.weight, credits: row.credits, grade: scenario && row.scenarioGrade ? row.scenarioGrade.value : row.currentGrade?.value ?? "" })),
            bounds,
            weighted: true,
            cumulative: { grade: settings.priorGpa, credits: settings.priorCredits }
        });
        const current = calculate(false); const hasScenario = rows.some((row) => row.scenarioGrade);
        return freeze({ rows, credits: current.credits, current: { ...current, status: "current", label: "GPA from current Canvas grades and saved credits" }, scenario: hasScenario ? { ...calculate(true), status: "estimated", label: "GPA with local what-if estimates" } : null });
    }

    function normalizeChartConfig(input = {}, { now = new Date() } = {}) {
        const courseId = id(input.courseId); const metric = text(input.metric, 50) || DEFAULT_PREFS.metric;
        const chartType = text(input.chartType, 50) || DEFAULT_PREFS.chartType;
        const dateRange = text(input.dateRange, 50) || DEFAULT_PREFS.dateRange;
        const comparison = text(input.comparison, 50) || DEFAULT_PREFS.comparison;
        const errors = [];
        if (!courseId) errors.push({ field: "courseId", code: "COURSE_REQUIRED", message: "Choose a course." });
        if (!METRICS.includes(metric)) errors.push({ field: "metric", code: "METRIC_UNSUPPORTED", message: "Only assignment percentage is supported." });
        if (!CHART_TYPES.includes(chartType)) errors.push({ field: "chartType", code: "CHART_UNSUPPORTED", message: "Choose a supported chart preset." });
        if (!DATE_RANGES.includes(dateRange)) errors.push({ field: "dateRange", code: "DATE_RANGE_UNSUPPORTED", message: "Choose a supported date range." });
        if (!COMPARISONS.includes(comparison)) errors.push({ field: "comparison", code: "COMPARISON_UNSUPPORTED", message: "Choose current grades or a supported scenario comparison." });
        let start = null; let end = null;
        const endOfRange = new Date(now); if (!Number.isFinite(endOfRange.getTime())) errors.push({ field: "dateRange", code: "DATE_INVALID", message: "The date range could not be resolved." });
        else if (dateRange === "last-30-days" || dateRange === "last-90-days") { end = endOfRange.toISOString(); const first = new Date(endOfRange); first.setUTCDate(first.getUTCDate() - (dateRange === "last-30-days" ? 30 : 90)); start = first.toISOString(); }
        else if (dateRange === "custom") {
            start = iso(input.start); end = iso(input.end);
            if (!start || !end || start > end) errors.push({ field: "dateRange", code: "CUSTOM_RANGE_INVALID", message: "Choose a valid start and end date." });
        }
        return freeze({ ok: errors.length === 0, config: { version: VERSION, courseId, metric, chartType, dateRange, comparison, start, end }, errors });
    }
    function included(row) { return !row.hidden && !row.dropped && !row.excused && Number.isFinite(row.score) && Number.isFinite(row.pointsPossible) && row.pointsPossible > 0; }
    function within(row, config) { return (!config.start || (row.dueAt && row.dueAt >= config.start)) && (!config.end || (row.dueAt && row.dueAt <= config.end)); }
    function assignmentRows(source, config) {
        return source.assignments.filter(included).filter((row) => config.dateRange === "all" || within(row, config)).map((row) => ({ ...row, percentage: row.score / row.pointsPossible * 100 }));
    }
    function histogram(rows) {
        const bins = [{ key: "0-59", min: -Infinity, max: 60 }, { key: "60-69", min: 60, max: 70 }, { key: "70-79", min: 70, max: 80 }, { key: "80-89", min: 80, max: 90 }, { key: "90-100+", min: 90, max: Infinity }];
        return bins.map((bin) => ({ key: bin.key, label: `${bin.key}%`, x: bin.key, y: rows.filter((row) => row.percentage >= bin.min && row.percentage < bin.max).length, valueLabel: `${rows.filter((row) => row.percentage >= bin.min && row.percentage < bin.max).length} assignments` }));
    }
    function chartPoints(source, config) {
        const rows = assignmentRows(source, config);
        if (config.chartType === "scores-over-time") return rows.filter((row) => row.dueAt).sort((a, b) => a.dueAt.localeCompare(b.dueAt) || a.title.localeCompare(b.title)).map((row) => ({ key: row.id, label: row.title, x: row.dueAt, y: row.percentage, valueLabel: `${row.title}: ${row.percentage.toFixed(1)}% at assignment due timestamp ${row.dueAt}` }));
        if (config.chartType === "score-histogram") return histogram(rows);
        const groups = new Map(source.groups.map((group) => [group.id, group.name])); const grouped = new Map();
        rows.filter((row) => row.groupId).forEach((row) => { const list = grouped.get(row.groupId) || []; list.push(row); grouped.set(row.groupId, list); });
        return [...grouped].map(([groupId, values]) => { const earned = values.reduce((sum, row) => sum + row.score, 0); const possible = values.reduce((sum, row) => sum + row.pointsPossible, 0); const percentage = possible > 0 ? earned / possible * 100 : null; const label = groups.get(groupId) || `Group ${groupId}`; return { key: groupId, label, x: label, y: percentage, valueLabel: `${label}: ${percentage.toFixed(1)}% across ${values.length} assignments` }; }).sort((a, b) => a.label.localeCompare(b.label));
    }
    function scenarioCompatibility(scenario, chartType) {
        if (!scenario || typeof scenario !== "object") return { ok: false, code: "SCENARIO_REQUIRED", message: "Create or choose a what-if scenario before comparing it." };
        if (chartType === "scores-over-time" && scenario.final) return { ok: false, code: "SCENARIO_FINAL_TIME_UNSUPPORTED", message: "A hypothetical final has no assignment timestamp, so it cannot appear in scores over time." };
        return { ok: true, code: null, message: null };
    }
    function tableFromDatasets(chartType, datasets) {
        const columns = chartType === "scores-over-time" ? ["Series", "Assignment", "Assignment due timestamp", "Score"] : chartType === "score-histogram" ? ["Series", "Score range", "Assignments"] : ["Series", "Assignment group", "Score"];
        const rows = datasets.flatMap((dataset) => dataset.points.map((point) => ({ datasetId: dataset.id, pointKey: point.key, cells: [dataset.label, point.label, ...(chartType === "scores-over-time" ? [point.x, `${point.y.toFixed(1)}%`] : chartType === "score-histogram" ? [String(point.y)] : [`${point.y.toFixed(1)}%`])] })));
        return { caption: chartType === "scores-over-time" ? "Assignment scores by assignment due timestamp; this is not final-grade history." : chartType === "score-histogram" ? "Assignment score histogram." : "Assignment-group score bars.", columns, rows };
    }
    function buildChartDataset(source, input, { scenario = null, analytics = defaultAnalytics, now = new Date() } = {}) {
        if (!analytics?.normalizeGradeData || !analytics?.materializeScenario) throw new TypeError("GradeAnalytics is required");
        const validation = normalizeChartConfig(input, { now });
        if (!validation.ok) return freeze({ state: "unsupported", code: "CHART_CONFIG_INVALID", validation, datasets: [], table: null });
        const config = validation.config; const current = analytics.normalizeGradeData(source);
        if (current.courseId && current.courseId !== config.courseId) return freeze({ state: "unsupported", code: "COURSE_MISMATCH", validation, datasets: [], table: null });
        if (config.comparison === "scenario") {
            const support = scenarioCompatibility(scenario, config.chartType);
            if (!support.ok) return freeze({ state: "unsupported", code: support.code, message: support.message, validation, datasets: [], table: null });
        }
        const datasets = [{ id: "current", label: "Current Canvas assignment scores", status: "current", points: chartPoints(current, config) }];
        if (config.comparison === "scenario") datasets.push({ id: "scenario", label: "Local what-if assignment estimate", status: "estimated", points: chartPoints(analytics.materializeScenario(current, scenario), config) });
        const table = tableFromDatasets(config.chartType, datasets);
        const hasPoints = datasets.some((dataset) => dataset.points.length && (config.chartType !== "score-histogram" || dataset.points.some((point) => point.y > 0)));
        return freeze({ state: hasPoints ? "ready" : "empty", code: hasPoints ? null : "NO_SUPPORTED_DATA", validation, title: config.chartType === "scores-over-time" ? "Assignment scores over time" : config.chartType === "score-histogram" ? "Score histogram" : "Assignment-group scores", disclosure: config.chartType === "scores-over-time" ? "Points use assignment due timestamps only. They do not represent historical final grades." : "Values derive from supported assignment scores; local scenarios are estimates.", datasets, table });
    }

    function chartPreferenceKey(account) { return `${PREFS_PREFIX}${encodeURIComponent(verifiedAccount(account).scope)}`; }
    function normalizePreferences(value) {
        const source = value?.version === VERSION ? value : {};
        const candidate = { ...DEFAULT_PREFS, courseId: id(source.courseId), metric: METRICS.includes(source.metric) ? source.metric : DEFAULT_PREFS.metric, dateRange: DATE_RANGES.includes(source.dateRange) ? source.dateRange : DEFAULT_PREFS.dateRange, chartType: CHART_TYPES.includes(source.chartType) ? source.chartType : DEFAULT_PREFS.chartType, comparison: COMPARISONS.includes(source.comparison) ? source.comparison : DEFAULT_PREFS.comparison, start: iso(source.start), end: iso(source.end) };
        if (candidate.dateRange !== "custom" || !candidate.start || !candidate.end || candidate.start > candidate.end) { candidate.start = null; candidate.end = null; if (candidate.dateRange === "custom") candidate.dateRange = "all"; }
        return freeze(candidate);
    }
    function createChartPreferenceStore({ storage, account, verifyAccount = async () => account } = {}) {
        if (!storage?.get || !storage?.set) throw new TypeError("storage.get and storage.set are required");
        const expected = verifiedAccount(account); const key = chartPreferenceKey(expected);
        async function check() { assertSameAccount(expected, await verifyAccount()); }
        async function load() { await check(); const stored = await storage.get(key); await check(); return normalizePreferences(stored?.[key]); }
        async function save(value) { const next = normalizePreferences({ ...value, version: VERSION }); await check(); await storage.set({ [key]: next }); await check(); return next; }
        return Object.freeze({ key, load, save });
    }

    return freeze({ VERSION, METRICS, CHART_TYPES, DATE_RANGES, COMPARISONS, MAX_COURSES, PREFS_PREFIX, DEFAULT_PREFS, verifiedAccount, normalizeCourse, normalizeCourses, createGradeReadAdapter, legacyGradeSettings, buildCourseOverview, normalizeChartConfig, scenarioCompatibility, buildChartDataset, chartPreferenceKey, normalizePreferences, createChartPreferenceStore });
}));
