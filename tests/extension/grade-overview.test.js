"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const overview = require("../../js/content/grade-overview.js");
const { Document, walk } = require("./helpers/dom.js");

function el(doc, tag, attrs = {}, text = "") {
    const node = doc.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    if (text) node.textContent = text;
    if (tag === "A") node.getAttribute = (key) => (key in node.attributes ? node.attributes[key] : null);
    return node;
}

function courseRow(doc, courseId, title, scoreText) {
    const tr = doc.createElement("TR");
    const nameCell = doc.createElement("TD");
    nameCell.append(el(doc, "A", { href: `/courses/${courseId}/grades` }, title));
    tr.append(nameCell);
    if (scoreText !== null) {
        const scoreCell = doc.createElement("TD");
        scoreCell.textContent = scoreText;
        tr.append(scoreCell);
    }
    return tr;
}

function nativeCourseRow(doc, courseId, userId, title, scoreText) {
    const tr = doc.createElement("TR");
    const nameCell = doc.createElement("TD");
    nameCell.className = "course";
    nameCell.append(el(doc, "A", { href: `/courses/${courseId}/grades/${userId}` }, title));
    tr.append(nameCell);
    const scoreCell = doc.createElement("TD");
    scoreCell.className = "percent";
    scoreCell.textContent = scoreText;
    tr.append(scoreCell);
    return tr;
}

function globalGradesHost(doc, rows, { ownedExtra = null } = {}) {
    const host = doc.createElement("DIV");
    const table = doc.createElement("TABLE");
    const body = doc.createElement("TBODY");
    rows.forEach((row) => body.append(row));
    table.append(body);
    host.append(table);
    if (ownedExtra) {
        const owned = doc.createElement("DIV");
        owned.dataset.apstudycanvasOwned = "true";
        owned.append(ownedExtra);
        host.append(owned);
    }
    return host;
}

function text(root) { return walk(root).map((node) => node.textContent).join(" "); }

test("parses native descendant course-grade links and printed scores into frozen read-only rows", () => {
    const doc = new Document();
    const host = globalGradesHost(doc, [
        courseRow(doc, "42", "Biology", "89.5%"),
        courseRow(doc, "43", "History", "72 %"),
        courseRow(doc, "44", "Seminar", "100%")
    ]);
    const parsed = overview.parseGlobalGradeRows(host);
    assert.equal(Object.isFrozen(parsed), true);
    assert.deepEqual(JSON.parse(JSON.stringify(parsed.rows)), [
        { courseId: "42", title: "Biology", score: 89.5, scoreLabel: "89.5%" },
        { courseId: "43", title: "History", score: 72, scoreLabel: "72 %" },
        { courseId: "44", title: "Seminar", score: 100, scoreLabel: "100%" }
    ]);
    assert.equal(parsed.truncated, false);
    assert.deepEqual(overview.parseGlobalGradeRows(null), { rows: [], truncated: false });
});

test("parses the native user-suffixed grades href into the course id, dedupes across the optional suffix, and reads td.percent states", () => {
    const doc = new Document();
    const host = globalGradesHost(doc, [
        nativeCourseRow(doc, "42", "9001", "Biology", "91.11%"),
        courseRow(doc, "42", "Biology listing", null),
        courseRow(doc, "43", "History", "100%"),
        nativeCourseRow(doc, "44", "777", "Seminar", "no grade"),
        nativeCourseRow(doc, "45", "778", "Studio", "--")
    ]);
    const parsed = overview.parseGlobalGradeRows(host);
    assert.deepEqual(JSON.parse(JSON.stringify(parsed.rows)), [
        { courseId: "42", title: "Biology", score: 91.11, scoreLabel: "91.11%" },
        { courseId: "43", title: "History", score: 100, scoreLabel: "100%" },
        { courseId: "44", title: "Seminar", score: null, scoreLabel: "" },
        { courseId: "45", title: "Studio", score: null, scoreLabel: "" }
    ], "the user-id suffix is dropped, the suffix-less duplicate dedupes, and no-grade/-- stay unavailable");

    const uiDoc = new Document();
    const uiHost = uiDoc.createElement("MAIN");
    const controller = overview.createGradeOverviewUI({ document: uiDoc });
    controller.mount(uiHost, { state: "ready", summary: overview.summarizeGradeOverview(parsed.rows) });
    const link = walk(uiHost).find((node) => String(node.tagName).toUpperCase() === "A");
    assert.equal(link.className, "apstudy-grade-overview__link");
    assert.equal(link.attributes.href, "/courses/42/grades", "the generated link stays canonical without the user-id suffix");
    assert.equal(link.textContent, "Biology", "the anchor renders text only");
});

test("dedupes repeated course anchors and keeps list anchors as score-less rows", () => {
    const doc = new Document();
    const host = globalGradesHost(doc, [courseRow(doc, "7", "First listing", null), courseRow(doc, "7", "Second listing", "80%")]);
    const sidebar = doc.createElement("UL");
    const item = doc.createElement("LI");
    item.append(el(doc, "A", { href: "/courses/8/grades" }, "Sidebar link"));
    sidebar.append(item);
    host.append(sidebar);
    const parsed = overview.parseGlobalGradeRows(host);
    assert.deepEqual(JSON.parse(JSON.stringify(parsed.rows)), [
        { courseId: "7", title: "First listing", score: null, scoreLabel: "" },
        { courseId: "8", title: "Sidebar link", score: null, scoreLabel: "" }
    ]);
});

test("rejects malicious and non-course hrefs, self-owned roots, and implausible scores", () => {
    const doc = new Document();
    const hostile = doc.createElement("TABLE");
    const row = doc.createElement("TR");
    for (const href of ["javascript:alert(1)", "https://evil.example/courses/7/grades", "//evil.test/courses/7/grades", "https://user:pass@canvas.emory.edu/courses/7/grades", "/courses/7/grades?spoof=1", "/courses/7/grades/9001?spoof=1", "/courses/7/grades#u9001", "/courses/nope/grades", "/courses/7/grades-export", "/courses/7/grades/nope", "/courses/7/grades/9001/extra"]) {
        const cell = doc.createElement("TD");
        cell.append(el(doc, "A", { href }, "Hostile"));
        row.append(cell);
    }
    const listingCell = doc.createElement("TD");
    listingCell.append(el(doc, "A", { href: "/grades", class: "no-hover" }, "All courses"));
    row.append(listingCell);
    hostile.append(row);
    const host = globalGradesHost(doc, [courseRow(doc, "42", "Biology", null)], { ownedExtra: (() => { const table = doc.createElement("TABLE"); const ownedRow = doc.createElement("TR"); const ownedCell = doc.createElement("TD"); ownedCell.append(el(doc, "A", { href: "/courses/9/grades" }, "Owned echo")); ownedRow.append(ownedCell); table.append(ownedRow); return table; })() });
    host.append(hostile);
    const parsed = overview.parseGlobalGradeRows(host);
    assert.deepEqual(JSON.parse(JSON.stringify(parsed.rows.map((row) => row.courseId))), ["42"], "only the native link survives");
    assert.equal(parsed.rows[0].score, null);

    const implausible = globalGradesHost(doc, [courseRow(doc, "42", "Biology", "1234%"), courseRow(doc, "43", "Chemistry", "-4%"), courseRow(doc, "44", "Physics", "999%")]);
    assert.deepEqual(overview.parseGlobalGradeRows(implausible).rows.map((row) => row.score), [null, null, 999]);
});

test("caps the parse at MAX_COURSES and discloses truncation", () => {
    const doc = new Document();
    const rows = Array.from({ length: overview.MAX_COURSES + 5 }, (_, index) => courseRow(doc, String(index + 1), `Course ${index + 1}`, "70%"));
    const parsed = overview.parseGlobalGradeRows(globalGradesHost(doc, rows));
    assert.equal(parsed.rows.length, overview.MAX_COURSES);
    assert.equal(parsed.truncated, true);
});

test("summaries count scored and unavailable courses and summarize letter estimates read-only", () => {
    const summary = overview.summarizeGradeOverview([
        { courseId: "42", title: "Biology", score: 92, scoreLabel: "92%" },
        { courseId: "43", title: "History", score: null, scoreLabel: "" }
    ], { bounds: {}, letterFor: (score) => (score >= 90 ? "A" : "B") });
    assert.equal(Object.isFrozen(summary), true);
    assert.deepEqual(JSON.parse(JSON.stringify(summary)), {
        courses: 2, scored: 1, unavailable: 1, truncated: false,
        rows: [
            { courseId: "42", title: "Biology", score: 92, scoreLabel: "92%", letter: "A" },
            { courseId: "43", title: "History", score: null, scoreLabel: "", letter: null }
        ]
    });
    assert.equal(overview.summarizeGradeOverview("not-a-list").courses, 0);
    assert.match(overview.summaryLine(summary), /^1 of 2 courses report a score\. 1 course has no score on this page\.$/);
    assert.match(overview.summaryLine(overview.summarizeGradeOverview([{ courseId: "1", title: "Solo", score: 50, scoreLabel: "50%" }])), /^1 of 1 course reports a score\.$/);
    assert.equal(overview.summaryLine(null), "Canvas lists no courses on this page yet.");
    const truncated = overview.summarizeGradeOverview([{ courseId: "1", title: "Solo", score: null, scoreLabel: "" }], { truncated: true });
    assert.match(overview.summaryLine(truncated), /Showing the first 100 courses Canvas lists\.$/);
});

test("renders loading, empty, and ready states with accessible status regions", () => {
    const doc = new Document();
    const host = doc.createElement("MAIN");
    const controller = overview.createGradeOverviewUI({ document: doc });
    assert.equal(controller.mount(host, { state: "loading" }), true);
    const root = host.children[0];
    assert.equal(root.className, overview.ROOT_CLASS);
    assert.equal(root.dataset.apstudycanvasOwned, "true");
    assert.equal(root.attributes["aria-labelledby"], "apstudy-grade-overview-title");
    const loading = walk(root).find((node) => node.attributes.role === "status");
    assert.match(loading.textContent, /Reading the courses Canvas lists/);

    let retries = 0;
    controller.update({ state: "empty", onRetry: () => { retries += 1; } });
    const empty = walk(root).find((node) => node.attributes.role === "status");
    assert.match(empty.textContent, /Canvas lists no course grades here yet/);
    const retry = walk(root).find((node) => node.dataset.action === "retry");
    root.dispatchEvent({ type: "click", target: retry });
    assert.equal(retries, 1, "the empty state offers an explicit retry");

    controller.update({ state: "ready", summary: overview.summarizeGradeOverview([
        { courseId: "42", title: "Biology", score: 89.5, scoreLabel: "89.5%" },
        { courseId: "43", title: "History", score: null, scoreLabel: "" }
    ]) });
    assert.match(text(root), /Grade overview/);
    assert.match(text(root), /A local summary of the courses Canvas lists on this page/);
    assert.match(text(root), /1 of 2 courses report a score\./);
    const headers = walk(root).filter((node) => String(node.tagName).toUpperCase() === "TH");
    assert.deepEqual(headers.map((node) => node.textContent), ["Course", "Score", "Letter estimate"]);
    assert.ok(headers.every((node) => node.attributes.scope === "col"));
    const unavailable = walk(root).find((node) => node.dataset.state === "unavailable");
    assert.match(unavailable.textContent, /No score on this page/);
    assert.equal(walk(root).find((node) => String(node.tagName).toUpperCase() === "CAPTION").textContent, "Text equivalent: courses Canvas lists on this page");
});

test("overview anchors are same-origin course grade links built from text, never markup", () => {
    const doc = new Document();
    const host = doc.createElement("MAIN");
    const controller = overview.createGradeOverviewUI({ document: doc });
    controller.mount(host, { state: "ready", summary: overview.summarizeGradeOverview([
        { courseId: "42", title: "\u0000<script>alert(1)</script>", score: 10, scoreLabel: "10%" }
    ]) });
    const link = walk(host).find((node) => String(node.tagName).toUpperCase() === "A");
    assert.equal(link.attributes.href, "/courses/42/grades");
    assert.equal(link.textContent, "<script>alert(1)</script>", "control characters are stripped and textContent is the only sink");
    assert.ok(walk(host).every((node) => node.innerHTML === undefined), "textContent is the only rendering sink");
});

test("ready clears a stale retry handler, destroy detaches, and remount stays single-rooted", () => {
    const doc = new Document();
    const host = doc.createElement("MAIN");
    const controller = overview.createGradeOverviewUI({ document: doc });
    let staleRetries = 0;
    controller.mount(host, { state: "loading", onRetry: () => { staleRetries += 1; } });
    controller.update({ state: "ready", summary: overview.summarizeGradeOverview([{ courseId: "1", title: "Solo", score: 50, scoreLabel: "50%" }]), onRetry: null });
    controller.update({ state: "empty" });
    const retry = walk(host).find((node) => node.dataset.action === "retry");
    host.children[0].dispatchEvent({ type: "click", target: retry });
    assert.equal(staleRetries, 0, "an explicit onRetry: null must retire the previous closure");

    assert.equal(controller.isAttached(), true);
    controller.destroy();
    assert.equal(host.children.length, 0);
    assert.equal(controller.isMounted(), false);
    assert.equal(controller.isAttached(), false);
    assert.equal(controller.update({ state: "ready" }), false, "updates after destroy fail open");
    assert.equal(controller.mount(null, { state: "loading" }), false, "missing container fails open");

    const second = doc.createElement("SECTION");
    assert.equal(controller.mount(second, { state: "loading" }), true, "a destroyed controller can be remounted");
    assert.equal(second.children.length, 1);
    controller.destroy();
    assert.equal(second.children.length, 0);
});

test("overview parser/UI stay read-only and CSS keeps responsive, reduced-motion, and keyboard contracts", () => {
    const root = path.resolve(__dirname, "../..");
    const source = fs.readFileSync(path.join(root, "js/content/grade-overview.js"), "utf8");
    const css = fs.readFileSync(path.join(root, "css/grade-analytics.css"), "utf8");
    assert.doesNotMatch(source, /\b(?:fetch\s*\(|XMLHttpRequest|chrome\.storage|localStorage|innerHTML|location\.(?:assign|href)|window\.open\s*\()/);
    assert.match(source, /hasOwnedAncestor/);
    assert.match(source, /MAX_COURSES/);
    assert.match(css, /\.apstudy-grade-overview/);
    assert.match(css, /@media \(max-width:700px\)/);
    assert.match(css, /prefers-reduced-motion:reduce/);
    assert.match(css, /:focus-visible/);
    assert.match(css, /overflow:auto/);
    assert.match(css, /data-state="unavailable"/);
});
