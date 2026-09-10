(function(root, factory) {
    "use strict";
    const api = factory();
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasContent = Object.assign(root.APStudyCanvasContent || {}, { WorkspaceModel: api });
}(typeof globalThis !== "undefined" ? globalThis : this, function() {
    "use strict";
    const PAGES = Object.freeze(["planner", "notes", "grades", "study"]);
    const clone = value => JSON.parse(JSON.stringify(value));
    function storageKey(context) {
        const url = new URL(context?.origin || "https://invalid.invalid");
        if (url.protocol !== "https:" || url.origin !== context?.origin || !/^\d+$/.test(String(context?.accountId || ""))) throw new Error("Canvas account could not be verified. Reload Canvas and try again.");
        return `apstudycanvas.workspace.v1:${url.origin}:${context.accountId}`;
    }
    function empty() { return { version: 1, notes: [], study: [], planner: [], grades: { courses: {}, priorGpa: "", priorCredits: "" } }; }
    function normalize(value) {
        if (!value) return empty();
        if (value.version !== 1 || !["notes", "study", "planner"].every(key => Array.isArray(value[key])) || !value.grades?.courses) throw new Error("Saved workspace data could not be read. It has not been overwritten.");
        validate(value);
        return clone(value);
    }
    function validate(value) {
        const invalid = () => { throw new Error("Workspace data is invalid or exceeds its limits. Saved materials have not been overwritten."); };
        const text = (v, max) => typeof v === "string" && v.length <= max;
        for (const kind of ["notes", "study", "planner"]) {
            const ids = new Set();
            if (value[kind].length > 500) invalid();
            for (const r of value[kind]) {
                if (!r || !text(r.id, 100) || !r.id || ids.has(r.id) || !text(r.title, 160) || !r.title.trim() || !text(r.courseId, 100) || !Number.isFinite(r.updatedAt)) invalid();
                ids.add(r.id);
                if (kind === "notes" && !text(r.body, 100000)) invalid();
                if (kind === "planner" && (!/^\d{4}-\d{2}-\d{2}$/.test(r.date) || !Number.isFinite(new Date(r.date).getTime()))) invalid();
                if (kind === "study") {
                    if (!Array.isArray(r.cards) || !r.cards.length || r.cards.length > 200) invalid();
                    const cardIds = new Set();
                    for (const c of r.cards) {
                        if (!c || !text(c.id,100) || cardIds.has(c.id) || !text(c.question,4000) || !c.question.trim() || !text(c.answer,4000) || !c.answer.trim()) invalid();
                        cardIds.add(c.id);
                    }
                }
            }
        }
        const number = (v, max) => v === undefined || v === "" || (Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= max);
        if (!value.grades || typeof value.grades.courses !== "object" || Array.isArray(value.grades.courses) || !number(value.grades.priorGpa,10) || !number(value.grades.priorCredits,10000)) invalid();
        for (const r of Object.values(value.grades.courses)) {
            if (!r || !number(r.credits,60) || !number(r.goal,200) || !number(r.whatIf,200)) invalid();
        }
    }
    function createStore({ storage, context, verify = async () => context, lock = async (key, operation) => operation() }) {
        const key = storageKey(context);
        let state = null, tail = Promise.resolve();
        async function check() { if (storageKey(await verify()) !== key) throw new Error("Your Canvas account changed. Close and reopen this workspace."); }
        async function load() { await check(); state = normalize((await storage.get(key))[key]); return clone(state); }
        function transact(change) {
            const operation = tail.then(() => lock(key, async () => {
                await check();
                // Re-read before every operation so sequential edits from another tab survive.
                const next = normalize((await storage.get(key))[key]);
                change(next);
                if (["notes", "study", "planner"].some(kind => next[kind].length > 500)) throw new Error("This workspace supports up to 500 items of each type.");
                if (new TextEncoder().encode(JSON.stringify(next)).length > 4000000) throw new Error("Workspace storage is full. Shorten an item and try again.");
                validate(next);
                await check();
                await storage.set({ [key]: next }); state = next; return clone(state);
            }));
            tail = operation.catch(() => {}); return operation;
        }
        return Object.freeze({ load, transact, snapshot: () => state ? clone(state) : null });
    }
    function dateKey(date) { return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`; }
    function range(date, mode) {
        const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
        if (mode === "month") start.setDate(1);
        const end = new Date(start);
        if (mode === "month") end.setMonth(end.getMonth()+1); else end.setDate(end.getDate()+(mode === "week" ? 7 : 1));
        return { start, end };
    }
    function answerMatches(actual, expected) { const clean = value => String(value).normalize("NFKC").trim().replace(/\s+/g," ").toLocaleLowerCase(); return clean(actual) === clean(expected); }
    function gradeSummary(courses, settings, bounds, gpa, whatIf = false) {
        const rows = courses.map(course => {
            const config = settings.courses[String(course.id)] || {};
            const enrollment = course.enrollments?.find(item => item.type === "student" || item.type === "StudentEnrollment") || course.enrollments?.[0];
            const raw = enrollment?.computed_current_score ?? enrollment?.grades?.current_score;
            const current = raw !== null && raw !== undefined && raw !== "" && Number.isFinite(Number(raw)) ? Number(raw) : null;
            const hypothetical = config.whatIf !== "" && config.whatIf !== undefined ? Number(config.whatIf) : null;
            const score = whatIf && hypothetical !== null && Number.isFinite(hypothetical) ? hypothetical : current;
            const credits = Number(config.credits ?? 0);
            return { course, config, current, score, credits, letter: score === null ? null : gpa.resolveGrade(score, bounds)?.letter, weight: config.included === false ? "dnc" : "regular", grade: score };
        });
        const result = gpa.computeGpa({ courses: rows.map(row => ({ ...row, grade: row.score === null ? "" : row.score })), bounds, weighted: false });
        const counted = rows.filter(row => row.weight !== "dnc" && row.score !== null && row.credits > 0 && gpa.resolveGrade(row.score, bounds));
        const credits = counted.reduce((sum,row) => sum+row.credits,0);
        const points = counted.reduce((sum,row) => sum+gpa.resolveGrade(row.score,bounds).gpa*row.credits,0);
        const priorGpa = settings.priorGpa === "" || settings.priorGpa === undefined ? NaN : Number(settings.priorGpa);
        const priorCredits = Number.isFinite(priorGpa) && priorGpa >= 0 ? Math.max(0, Number(settings.priorCredits) || 0) : 0;
        return { rows, result, term: credits ? points/credits : null, cumulative: credits+priorCredits > 0 ? (points+(priorCredits ? priorCredits*priorGpa : 0))/(credits+priorCredits) : null };
    }
    return Object.freeze({ PAGES, storageKey, empty, normalize, createStore, dateKey, range, answerMatches, gradeSummary });
}));
