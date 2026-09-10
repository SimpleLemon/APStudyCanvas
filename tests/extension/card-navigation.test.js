"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const cards = require("../../js/content/card-appearance.js");
const gpa = require("../../js/content/gpa.js");
const schema = require("../../js/settings-schema.js");

const origin = "https://canvas.emory.edu";
const bounds = schema.defaultsForArea("sync").gpa_calc_bounds;
const content = fs.readFileSync(path.join(__dirname, "../../js/content.js"), "utf8");
const css = fs.readFileSync(path.join(__dirname, "../../css/content.css"), "utf8");

test("course destinations accept only same-origin Canvas course identities", () => {
    const assignment = cards.sameCourseCanvasLocation(`${origin}/courses/42/assignments/9`, {
        origin, courseId: "42", section: "assignments"
    });
    assert.equal(assignment.href, `${origin}/courses/42/assignments/9`);
    assert.equal(cards.sameCourseCanvasLocation("https://example.test/courses/42/assignments/9", { origin, courseId: "42", section: "assignments" }), null);
    assert.equal(cards.sameCourseCanvasLocation(`${origin}/courses/99/assignments/9`, { origin, courseId: "42", section: "assignments" }), null);
    assert.equal(cards.sameCourseCanvasLocation(`${origin}/courses/42/grades`, { origin, courseId: "42", section: "assignments" }), null);
    assert.equal(cards.sameCourseCanvasLocation(`https://student:secret@canvas.emory.edu/courses/42/assignments/9`, { origin, courseId: "42", section: "assignments" }), null);
    assert.equal(cards.courseDestination(origin, "42", "grades").href, `${origin}/courses/42/grades`);
    assert.equal(cards.courseDestination(origin, "42", "files"), null);
});

test("submission back links retain the assignment identity and reject lookalike routes", () => {
    assert.equal(
        cards.submissionAssignmentDestination(`${origin}/courses/42/assignments/9/submissions/17`, origin).href,
        `${origin}/courses/42/assignments/9`
    );
    assert.equal(cards.submissionAssignmentDestination(`${origin}/courses/42/assignments/9`, origin), null);
    assert.equal(cards.submissionAssignmentDestination(`${origin}/courses/42/assignments/9/submissions/not-a-number`, origin), null);
    assert.equal(cards.submissionAssignmentDestination("javascript:alert(1)", origin), null);
});

function dashboardCard(href = null) {
    let anchor = href === null ? null : {
        href,
        getAttribute(name) { return name === "href" ? href : null; }
    };
    return {
        querySelector(selector) { return selector === ".ic-DashboardCard__link" ? anchor : null; },
        replaceAnchor(nextHref) {
            anchor = nextHref === null ? null : {
                href: nextHref,
                getAttribute(name) { return name === "href" ? nextHref : null; }
            };
        }
    };
}

test("dashboard card destinations fail closed while Canvas inserts and replaces course anchors", () => {
    const card = dashboardCard();
    assert.equal(cards.dashboardCardDestination(card, origin), null, "the initial card shell has no anchor");

    card.replaceAnchor("/courses/42");
    assert.equal(cards.dashboardCardDestination(card, origin)?.href, `${origin}/courses/42`, "a delayed valid anchor is accepted");

    card.replaceAnchor("https://example.test/courses/42");
    assert.equal(cards.dashboardCardDestination(card, origin), null, "a replacement from another origin is rejected");
    card.replaceAnchor("javascript:alert(1)");
    assert.equal(cards.dashboardCardDestination(card, origin), null, "a malformed replacement is rejected");

    card.replaceAnchor("/courses/42");
    assert.equal(cards.dashboardCardDestination(card, origin)?.courseId, "42", "route re-entry accepts the current replacement, not stale state");
    assert.equal(cards.dashboardCardDestination(card, origin)?.courseId, "42", "repeated mutation passes remain idempotent");
    card.replaceAnchor("/courses/42/assignments");
    assert.equal(cards.dashboardCardDestination(card, origin), null, "only a course-root card link seeds card state");
});

test("card letter grades reuse GPA bounds and preserve unavailable-grade semantics", () => {
    assert.equal(cards.resolveLetterGrade(93, bounds, gpa), "A");
    assert.equal(cards.resolveLetterGrade(0, bounds, gpa), "F", "zero is a valid grade");
    assert.equal(cards.resolveLetterGrade("", bounds, gpa), null);
    assert.equal(cards.resolveLetterGrade(undefined, bounds, gpa), null);
    assert.equal(cards.resolveLetterGrade(93, {}, gpa), null);
});

test("content keeps navigation reversible, validates assignment rows, and lets cards grow for rows", () => {
    assert.match(content, /data-apstudycanvas-hide-sequence/);
    assert.match(content, /options\?\.assignment_sequence_footer_visible === false/);
    assert.match(content, /removeAssignmentNavigation\(\)/);
    assert.match(content, /dashboardCardDestination\?\.\(card, domain\)/, "card link extraction must use the null-safe resolver");
    assert.match(content, /function getCardId\(card\) \{\s*let id = getDashboardCardDestination\(card\)\?\.courseId;/, "card state must derive IDs from the null-safe resolver");
    assert.match(content, /sameCourseCanvasLocation\?\.\(assignment\?\.html_url/);
    assert.match(content, /text = available \? `\$\{rawScore\}%/);
    assert.match(content, /"Grade unavailable"/);
    assert.match(content, /resolveLetterGrade\?\.\(score, options\.gpa_calc_bounds, contentGpaApi\)/);
    assert.match(content, /cardGrades\(\) \{[\s\S]{0,260}?insertGrades\(\)/, "a live letter-grade update reconciles current dashboard rows");
    assert.match(content, /assignmentNavigation\(\) \{ return syncAssignmentNavigation\(\) \|\| true; \}/, "the sequence footer and APStudy navigation share one reversible owner");
    assert.match(content, /min-height: \$\{options\.cardHeight\}px!important;height:auto!important/);
    assert.match(css, /html\[data-apstudycanvas-hide-sequence\] #sequence_footer/);
    assert.match(css, /\.canvasrefined-card-assignment \{min-width:0;overflow-wrap:anywhere;/);
    assert.match(css, /\.canvasrefined-card-grade\[aria-disabled="true"\]/);
});
