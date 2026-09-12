"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Document, walk } = require("./helpers/dom.js");
const analytics = require("../../js/content/grade-analytics.js");
const gpa = require("../../js/content/gpa.js");
globalThis.APStudyCanvasContent = { ...(globalThis.APStudyCanvasContent || {}), GradeAnalytics: analytics, Gpa: gpa };
const domain = require("../../js/workspace-grades-domain.js");
const gradesApi = require("../../js/workspace-grades.js");

const BOUNDS = { A: { cutoff: 90, gpa: 4 }, B: { cutoff: 80, gpa: 3 }, C: { cutoff: 70, gpa: 2 }, D: { cutoff: 60, gpa: 1 }, F: { cutoff: 0, gpa: 0 } };
const rawCourses = [
    { id: 7, name: "Biology", course_code: "BIO 101", enrollments: [{ type: "StudentEnrollment", computed_current_score: 92 }] },
    { id: 8, name: "History", enrollments: [{ type: "StudentEnrollment", computed_current_score: 84, official_final_score: 86 }] }
];
const source = analytics.normalizeGradeData({
    courseId: "7",
    assignmentGroups: [{ id: "tests", name: "Tests", group_weight: 60 }, { id: "labs", name: "Labs", group_weight: 40 }],
    assignments: [
        { id: "a", name: "Cells quiz", assignment_group_id: "tests", points_possible: 20, score: 18, due_at: "2026-08-20T12:00:00Z" },
        { id: "b", name: "Microscope lab", assignment_group_id: "labs", points_possible: 10, score: 8, due_at: "2026-09-05T12:00:00Z" },
        { id: "c", name: "Unscored reflection", assignment_group_id: "labs", points_possible: 5, score: null, due_at: null }
    ]
});

function documentHarness() {
    const doc = new Document();
    const create = doc.createElement.bind(doc);
    doc.createElement = tag => {
        const node = create(tag); node.type = ""; node.disabled = false; node.checked = false; node.hidden = false; node.tabIndex = -1; node.min = ""; node.max = ""; node.step = ""; node.title = "";
        return node;
    };
    doc.createElementNS = (_namespace, tag) => { const node = doc.createElement(tag); Object.defineProperty(node, "className", { get: () => ({ baseVal: node.getAttribute("class") || "" }) }); return node; };
    return doc;
}

function adapterHarness({ failOverview = false } = {}) {
    const calls = [];
    return {
        calls,
        async overview() { calls.push(["overview"]); if (failOverview) throw new Error("Verified Canvas read failed"); return { courses: domain.normalizeCourses(rawCourses) }; },
        async course(courseId) { calls.push(["course", courseId]); return { courseId, source: courseId === "7" ? source : analytics.normalizeGradeData({ courseId, assignments: [], assignmentGroups: [] }) }; },
        dispose(reason) { calls.push(["dispose", reason]); }
    };
}

async function harness(options = {}) {
    const doc = documentHarness(); const host = doc.createElement("main"); const adapter = options.adapter || adapterHarness(); const dirty = []; const navigated = []; const saved = [];
    const workspace = { version: 1, grades: { courses: { "7": { credits: 1, goal: 95, whatIf: 97, included: true, weight: "ap" }, "8": { credits: 1, goal: 85 } }, priorGpa: 3.5, priorCredits: 12 } };
    const module = gradesApi.createGradesWorkspace({
        document: doc, window: { location: { origin: "https://canvas.example.edu", href: "" } }, domain, analytics, adapter,
        getWorkspaceRecord: async () => structuredClone(workspace),
        saveWorkspaceGrades: options.readOnly ? undefined : async grades => { saved.push(["workspace", structuredClone(grades)]); return { ...workspace, grades }; },
        getBounds: () => BOUNDS,
        getScenario: async () => analytics.createScenario(),
        saveScenario: options.temporary ? undefined : async (_courseId, scenario) => { saved.push(["scenario", structuredClone(scenario)]); return scenario; },
        preferenceStore: { load: async () => options.preferences || null, save: async value => { saved.push(["preferences", structuredClone(value)]); return value; } },
        navigateCanvas: href => navigated.push(href), onDirtyChange: value => dirty.push(value)
    });
    await module.mount(host, { mode: options.mode || "popup", route: options.route || {}, context: { account: { scope: "canvas:test" } } });
    const all = () => walk(host); const text = () => all().map(node => node.textContent).join(" ");
    const role = name => all().find(node => node.dataset.gradesRole === name);
    const button = label => all().find(node => node.tagName === "button" && node.textContent === label);
    const click = label => { const node = button(label); assert.ok(node, `button ${label}`); node.dispatchEvent({ type: "click" }); };
    const settle = () => new Promise(resolve => setImmediate(resolve));
    return { module, host, adapter, dirty, navigated, saved, all, text, role, button, click, settle };
}

test("overview presents current truth, GPA, credits, goals, links, and no invented official final", async () => {
    const h = await harness();
    assert.match(h.text(), /Grades.*Current GPA.*What-if GPA.*Counted credits.*Biology.*92\.0%.*95\.0%.*3\.0 points to goal/);
    assert.match(h.text(), /Not an official final grade/);
    assert.match(h.text(), /Official final: 86\.0%/);
    h.click("Canvas gradebook");
    assert.deepEqual(h.navigated, ["/courses/7/grades"]);
    assert.doesNotMatch(h.text(), /final-grade history/i);
});

test("class breadcrumb exposes Overview, Assignments, Graphs, and What-if with honest assignment states", async () => {
    const h = await harness(); h.click("View class"); await h.settle();
    for (const label of ["Grades", "Biology", "Overview", "Assignments", "Graphs", "What-if"]) assert.match(h.text(), new RegExp(label));
    h.click("Assignments");
    assert.match(h.text(), /Cells quiz.*18 \/ 20.*Counted.*Unscored reflection.*Not graded.*Ungraded/);
    h.click("Grades");
    assert.match(h.text(), /Current classes/);
});

test("guided graph builder renders domain points, exact table rows, disclosures, tooltips, and keyboard traversal", async () => {
    const h = await harness({ route: { courseId: "7", tab: "graphs" } });
    assert.equal(h.role("chart-course").disabled, true);
    assert.match(h.text(), /1\. Course.*2\. Metric.*3\. Date range.*4\. Chart preset.*5\. Compare/);
    h.click("Generate graph"); await h.settle();
    assert.match(h.text(), /Assignment scores over time.*assignment due timestamps only.*not final-grade history/i);
    assert.equal(h.all().filter(node => node.dataset.gradesRole === "chart-point").length, 2);
    assert.equal(h.all().filter(node => node.dataset.gradesRole === "chart-row").length, 2);
    const marks = h.all().filter(node => node.dataset.gradesRole === "chart-point"); marks[0].focus(); marks[0].dispatchEvent({ type: "focus" });
    assert.match(h.role("chart-tooltip").textContent, /Cells quiz: 90\.0%/);
    assert.equal(h.all().find(node => node.tagName === "svg").attributes.preserveAspectRatio, "none");
    const line = h.all().find(node => node.tagName === "path");
    assert.ok(line.attributes.d.startsWith("M40,218"), "line and 90% mark share the same normalized plot coordinates");
    assert.equal(marks[0].style["--point-bottom"], "78.2%");
    assert.equal(marks[0].style["--point-left"], "4%");
    assert.equal(marks[1].style["--point-left"], "96%");
    marks[0].dispatchEvent({ type: "keydown", key: "ArrowRight", preventDefault() {} });
    assert.equal(h.host.ownerDocument.activeElement, marks[1]);
    assert.equal(h.saved.some(([kind, value]) => kind === "preferences" && value.chartType === "scores-over-time"), true);
});

test("histogram and group presets share current/scenario data with the equivalent table", async () => {
    const h = await harness({ route: { courseId: "7", tab: "graphs" } });
    h.role("chart-type").value = "score-histogram"; h.role("chart-comparison").value = "scenario"; h.click("Generate graph"); await h.settle();
    assert.match(h.text(), /Score histogram.*Local what-if assignment estimate/);
    assert.equal(h.all().filter(node => node.dataset.gradesRole === "chart-point").length, 10);
    assert.equal(h.all().filter(node => node.dataset.gradesRole === "chart-row").length, 10);
    h.role("chart-type").value = "assignment-group-bars"; h.click("Update graph"); await h.settle();
    assert.match(h.text(), /Assignment-group scores.*Tests.*Labs/);
    assert.equal(h.all().filter(node => node.dataset.gradesRole === "chart-point").length, 4);
});

test("hypothetical final is rejected for time plots instead of fabricating a timestamp", async () => {
    const h = await harness({ route: { courseId: "7", tab: "what-if" } });
    const fields = h.all().filter(node => node.tagName === "input" && node.type === "number");
    const finalScore = fields[fields.length - 2]; const finalPossible = fields[fields.length - 1]; finalScore.value = "90"; finalScore.dispatchEvent({ type: "input" }); finalPossible.value = "100"; finalPossible.dispatchEvent({ type: "input" });
    h.click("Graphs"); h.role("chart-comparison").value = "scenario"; h.click("Generate graph"); await h.settle();
    assert.match(h.text(), /hypothetical final has no assignment timestamp/i);
    assert.equal(h.all().filter(node => node.dataset.gradesRole === "chart-point").length, 0);
});

test("local GPA and scenario saves clear dirty state while failed or temporary changes remain honest", async () => {
    const h = await harness({ route: { courseId: "7", tab: "what-if" } });
    const credits = h.role("workspace-credits"); credits.value = "2"; credits.dispatchEvent({ type: "input" });
    assert.equal(h.module.queryDirty(), true); h.click("Save GPA settings"); await h.settle(); assert.equal(h.module.queryDirty(), false);
    const assignmentScore = h.all().find(node => node.tagName === "input" && node.value === "18"); assignmentScore.value = "20"; assignmentScore.dispatchEvent({ type: "input" });
    h.click("Save local scenario"); await h.settle(); assert.equal(h.module.queryDirty(), false);
    assert.deepEqual(h.dirty, [true, false, true, false]);

    const temporary = await harness({ route: { courseId: "7", tab: "what-if" }, readOnly: true, temporary: true, mode: "canvas" });
    assert.match(temporary.text(), /read-only in this host.*temporary and lasts only/i);
    assert.equal(temporary.role("workspace-credits").disabled, true);
    assert.equal(temporary.host.children[0].className.includes("workspace-grades--canvas"), true);
});

test("failure, account-change, and disposal states preserve truth and clean up exactly once", async () => {
    const failed = await harness({ adapter: adapterHarness({ failOverview: true }) });
    assert.match(failed.text(), /Grades are unavailable.*Verified Canvas read failed.*Retry/);

    const h = await harness({ route: { courseId: "7", tab: "what-if" } }); const credits = h.role("workspace-credits"); credits.value = "3"; credits.dispatchEvent({ type: "input" });
    const changed = await h.module.routeUpdate({ courseId: "7", tab: "overview" }, { account: { scope: "canvas:other" } });
    assert.equal(changed, false); assert.match(h.text(), /account changed.*Unsaved grade changes remain/i); assert.equal(h.module.queryDirty(), true);
    await h.module.dispose("route-change"); await h.module.dispose("route-change");
    assert.equal(h.host.children.length, 0); assert.equal(h.module.queryDirty(), false); assert.equal(h.adapter.calls.filter(([name]) => name === "dispose").length, 1);
});

test("Foundation wrapper and CSS keep one reusable renderer with responsive and accessible graph affordances", async () => {
    assert.equal(typeof gradesApi.createGradesModule, "function"); assert.equal(typeof gradesApi.GradesWorkspace, "function");
    const css = fs.readFileSync(path.join(__dirname, "../../css/workspace-grades.css"), "utf8");
    assert.match(css, /\.workspace-grades-course-row \{[^}]*display: grid/);
    assert.match(css, /\.workspace-grades-line path \{[^}]*stroke:/);
    assert.match(css, /\.workspace-grades-plot:is\(\.is-score-histogram, \.is-assignment-group-bars\)/);
    assert.match(css, /@container shell \(max-width: 620px\)/);
    assert.match(css, /:focus-visible \{ outline: 2px solid var\(--grades-gold\)/);
    assert.doesNotMatch(css, /grid-template-columns:\s*repeat\(5,\s*1fr\)/);
    assert.doesNotMatch(css, /var\(--point-(?:index|count|value)\)|var\(--bar-value\)/);
});

test("dirty scenario rejects breadcrumb, class, and external course transitions without losing focus or draft", async () => {
    const h = await harness({ route: { courseId: "7", tab: "what-if" } });
    let confirms = 0; let focused = 0;
    h.module.win.confirm = () => { confirms += 1; return false; };
    const focus = { focus() { focused += 1; } };
    h.module.scenario = analytics.scenarioAssignment(h.module.scenario, "a", { score: 12 });
    h.module.setDirty("scenario", true);
    const draft = structuredClone(h.module.scenario);
    assert.equal(h.module.leaveCourse(focus), false);
    assert.equal(await h.module.openCourse("8", "overview", focus), false);
    assert.equal(await h.module.routeUpdate({ courseId: "8" }), false);
    assert.equal(h.module.route.courseId, "7");
    assert.deepEqual(h.module.scenario, draft);
    assert.equal(h.module.queryDirty(), true);
    assert.equal(confirms, 3); assert.equal(focused, 2);
    h.module.win.confirm = () => true;
    assert.equal(await h.module.openCourse("8"), true);
    assert.equal(h.module.route.courseId, "8"); assert.equal(h.module.queryDirty(), false);
});

test("late saves never erase newer edits or replace another course's scenario", async () => {
    const h = await harness({ route: { courseId: "7", tab: "what-if" } });
    let resolve;
    h.module.saveScenario = () => new Promise(done => { resolve = done; });
    h.module.setDirty("scenario", true);
    const saving = h.module.saveCurrentScenario();
    h.module.scenario = analytics.scenarioAssignment(h.module.scenario, "a", { score: 11 });
    h.module.setDirty("scenario", true);
    resolve(analytics.createScenario()); await saving;
    assert.equal(h.module.scenario.assignments.a.score, 11); assert.equal(h.module.queryDirty(), true);
    const secondSave = h.module.saveCurrentScenario();
    h.module.win.confirm = () => true;
    await h.module.openCourse("8");
    const nextScenario = structuredClone(h.module.scenario);
    resolve(analytics.scenarioAssignment(analytics.createScenario(), "a", { score: 1 })); await secondSave;
    assert.deepEqual(h.module.scenario, nextScenario); assert.equal(h.module.route.courseId, "8");
    h.module.saveWorkspaceGrades = () => new Promise(done => { resolve = done; });
    h.module.setDirty("workspace", true);
    const settingsSave = h.module.saveSettings();
    h.module.workspace.grades.courses["8"].credits = 4; h.module.setDirty("workspace", true);
    resolve({ courses: {} }); await settingsSave;
    assert.equal(h.module.workspace.grades.courses["8"].credits, 4); assert.equal(h.module.workspaceDirty, true);
});
