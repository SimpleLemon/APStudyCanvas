"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const gpa = require("../../js/content/gpa.js");
const schema = require("../../js/settings-schema.js");

const BOUNDS = schema.defaultsForArea("sync").gpa_calc_bounds;
const SHIPPED_CUMULATIVE = schema.defaultsForArea("sync").cumulative_gpa;

function assertNeverNaNText(result) {
    for (const key of ["unweighted", "weighted", "cumulative"]) {
        const value = result[key];
        assert.ok(value === null || Number.isFinite(value), `${key} must be a finite number or null, got ${String(value)}`);
        assert.notEqual(String(value), "NaN", `${key} must never stringify to "NaN"`);
        assert.notEqual(gpa.formatGpa(value), "NaN", `${key} must never format to "NaN"`);
    }
}

test("no counted credits yields null, not the string NaN", () => {
    const result = gpa.computeGpa({ courses: [], bounds: BOUNDS, weighted: false, cumulative: null });
    assert.equal(result.unweighted, null);
    assert.equal(result.weighted, null);
    assert.equal(result.cumulative, null);
    assert.equal(result.counted, 0);
    assert.equal(result.credits, 0);
    assertNeverNaNText(result);
    assert.equal(gpa.formatGpa(result.unweighted), gpa.EMPTY_DISPLAY);
    assert.equal(gpa.EMPTY_DISPLAY, "—");
});

test("every course skipped reproduces the original NaN scenario and returns null instead", () => {
    // This is the shipped pre-configuration state: blank Canvas grades force the
    // weight select to "dnc", so the old code divided 0 points by 0 credits.
    const result = gpa.computeGpa({
        courses: [
            { weight: "dnc", credits: "1", grade: "91" },
            { weight: "regular", credits: "1", grade: "--" },
            { weight: "regular", credits: "", grade: "88" }
        ],
        bounds: BOUNDS,
        weighted: true,
        cumulative: null
    });
    assert.equal(result.counted, 0);
    assert.equal(result.credits, 0);
    assert.equal(result.unweighted, null);
    assert.equal(result.weighted, null);
    assert.equal(result.cumulative, null);
    assertNeverNaNText(result);
    assert.deepEqual(result.courses.map((row) => row.letter), [gpa.NO_LETTER, gpa.NO_LETTER, gpa.NO_LETTER]);
    assert.deepEqual(result.courses.map((row) => row.counted), [false, false, false]);
});

test("a legitimate 0% grade is counted rather than discarded as falsy", () => {
    const result = gpa.computeGpa({
        courses: [{ weight: "regular", credits: 1, grade: 0 }],
        bounds: BOUNDS,
        weighted: false,
        cumulative: null
    });
    assert.equal(result.counted, 1);
    assert.equal(result.credits, 1);
    assert.equal(result.courses[0].letter, "F");
    assert.equal(result.courses[0].counted, true);
    assert.equal(result.unweighted, 0);
    assert.equal(gpa.formatGpa(result.unweighted), "0.00");
    assertNeverNaNText(result);
});

test("a 0% grade string from the input field is counted too", () => {
    const result = gpa.computeGpa({
        courses: [
            { weight: "regular", credits: "3", grade: "0" },
            { weight: "regular", credits: "1", grade: "93" }
        ],
        bounds: BOUNDS,
        weighted: false,
        cumulative: null
    });
    assert.equal(result.counted, 2);
    assert.equal(result.credits, 4);
    // (0 * 3 + 4 * 1) / 4 — the 0% row contributes credits but no points.
    assert.equal(result.unweighted, 1);
    assert.equal(gpa.formatGpa(result.unweighted), "1.00");
    assert.deepEqual(result.courses.map((row) => row.letter), ["F", "A"]);
});

test("blank, placeholder, and non-numeric grades or credits are skipped", () => {
    const result = gpa.computeGpa({
        courses: [
            { weight: "regular", credits: "1", grade: "--" },
            { weight: "regular", credits: "1", grade: "" },
            { weight: "regular", credits: "1", grade: "   " },
            { weight: "regular", credits: "1", grade: null },
            { weight: "regular", credits: "1", grade: undefined },
            { weight: "regular", credits: "1", grade: NaN },
            { weight: "regular", credits: "--", grade: "95" },
            { weight: "regular", credits: "", grade: "95" },
            { weight: "regular", credits: 2, grade: 95 }
        ],
        bounds: BOUNDS,
        weighted: false,
        cumulative: null
    });
    assert.equal(result.counted, 1);
    assert.equal(result.credits, 2);
    assert.equal(result.unweighted, 4);
    assert.deepEqual(result.courses.map((row) => row.counted), [false, false, false, false, false, false, false, false, true]);
});

test("weight dnc excludes a course that is otherwise fully specified", () => {
    const courses = [
        { weight: "dnc", credits: 4, grade: 100 },
        { weight: "regular", credits: 1, grade: 83 }
    ];
    const result = gpa.computeGpa({ courses, bounds: BOUNDS, weighted: false, cumulative: null });
    assert.equal(result.counted, 1);
    assert.equal(result.credits, 1);
    assert.equal(result.unweighted, 3);
    assert.equal(result.courses[0].letter, gpa.NO_LETTER);
    assert.equal(result.courses[0].gpa, null);
    assert.equal(result.courses[1].letter, "B");
    assert.equal(gpa.EXCLUDED_WEIGHT, "dnc");

    // The shipped cumulative_gpa row ships weight "dnc" on purpose.
    assert.equal(SHIPPED_CUMULATIVE.weight, gpa.EXCLUDED_WEIGHT);
});

test("weighted adds the honors and AP bonus while unweighted does not", () => {
    const courses = [
        { weight: "ap", credits: 1, grade: 93 },
        { weight: "honors", credits: 1, grade: 93 },
        { weight: "regular", credits: 1, grade: 93 }
    ];
    const result = gpa.computeGpa({ courses, bounds: BOUNDS, weighted: false, cumulative: null });
    assert.equal(result.unweighted, 4);
    // (5 + 4.5 + 4) / 3
    assert.equal(Number(result.weighted.toFixed(4)), 4.5);
    assert.equal(result.qualityPoints, 12);
    assert.equal(result.weightedQualityPoints, 13.5);
    assert.deepEqual(result.courses.map((row) => row.letter), ["A", "A", "A"]);
});

test("grade tiers resolve in descending cutoff order across the shipped bounds", () => {
    const samples = [
        [100, "A+"], [97, "A+"], [96, "A"], [93, "A"], [92, "A-"], [90, "A-"],
        [89, "B+"], [87, "B+"], [86, "B"], [83, "B"], [82, "B-"], [80, "B-"],
        [79, "C+"], [77, "C+"], [76, "C"], [73, "C"], [72, "C-"], [70, "C-"],
        [69, "D+"], [67, "D+"], [66, "D"], [63, "D"], [62, "D-"], [60, "D-"],
        [59, "F"], [0, "F"]
    ];
    const result = gpa.computeGpa({
        courses: samples.map(([grade]) => ({ weight: "regular", credits: 1, grade })),
        bounds: BOUNDS,
        weighted: false,
        cumulative: null
    });
    assert.deepEqual(result.courses.map((row) => row.letter), samples.map(([, letter]) => letter));
    assert.equal(result.counted, samples.length);
    assert.deepEqual(gpa.GRADE_ORDER.slice(0, 3), ["A+", "A", "A-"]);
});

test("cumulative blends the prior row against whichever base the weighted flag selects", () => {
    const courses = [{ weight: "ap", credits: 2, grade: 93 }];
    const prior = { grade: 3.21, credits: 8 };

    const unweightedRun = gpa.computeGpa({ courses, bounds: BOUNDS, weighted: false, cumulative: prior });
    // (4 * 2 + 3.21 * 8) / 10
    assert.equal(Number(unweightedRun.cumulative.toFixed(4)), 3.368);
    assert.equal(unweightedRun.priorCounted, true);

    const weightedRun = gpa.computeGpa({ courses, bounds: BOUNDS, weighted: true, cumulative: prior });
    // (5 * 2 + 3.21 * 8) / 10
    assert.equal(Number(weightedRun.cumulative.toFixed(4)), 3.568);
    assert.notEqual(weightedRun.cumulative, unweightedRun.cumulative);

    assertNeverNaNText(unweightedRun);
    assertNeverNaNText(weightedRun);
});

test("the cumulative (g * c) term is guarded against blank, placeholder, and zero prior rows", () => {
    const courses = [{ weight: "regular", credits: 2, grade: 93 }];
    const guarded = [
        null,
        undefined,
        {},
        { grade: "--", credits: "999" },
        { grade: "", credits: "999" },
        { grade: "3.21", credits: "--" },
        { grade: "3.21", credits: "" },
        { grade: NaN, credits: NaN },
        { grade: "3.21", credits: 0 }
    ];
    for (const cumulative of guarded) {
        const result = gpa.computeGpa({ courses, bounds: BOUNDS, weighted: false, cumulative });
        assert.equal(result.priorCounted, false, `prior row ${JSON.stringify(cumulative)} must not count`);
        // Falls back to the current-term average rather than poisoning it.
        assert.equal(result.cumulative, 4, `prior row ${JSON.stringify(cumulative)} must not change the average`);
        assertNeverNaNText(result);
    }
});

test("a guarded prior row with no counted courses still yields null rather than NaN", () => {
    const result = gpa.computeGpa({
        courses: [{ weight: "dnc", credits: 1, grade: 95 }],
        bounds: BOUNDS,
        weighted: false,
        cumulative: { grade: "--", credits: "--" }
    });
    assert.equal(result.cumulative, null);
    assert.equal(result.unweighted, null);
    assert.equal(result.weighted, null);
    assertNeverNaNText(result);
});

test("a valid prior row alone carries the cumulative average when no course counts", () => {
    const result = gpa.computeGpa({
        courses: [{ weight: "dnc", credits: 1, grade: 95 }],
        bounds: BOUNDS,
        weighted: false,
        cumulative: { grade: SHIPPED_CUMULATIVE.gr, credits: SHIPPED_CUMULATIVE.credits }
    });
    assert.equal(result.unweighted, null);
    assert.equal(result.weighted, null);
    assert.equal(Number(result.cumulative.toFixed(4)), 3.21);
    assertNeverNaNText(result);
});

test("malformed and missing bounds skip the course instead of producing NaN", () => {
    const courses = [{ weight: "regular", credits: 1, grade: 95 }];
    for (const bounds of [undefined, null, {}, { A: { cutoff: "x", gpa: "y" } }, { F: { cutoff: 0, gpa: null } }]) {
        const result = gpa.computeGpa({ courses, bounds, weighted: false, cumulative: null });
        assert.equal(result.counted, 0, `bounds ${JSON.stringify(bounds)} must not count a course`);
        assert.equal(result.unweighted, null);
        assertNeverNaNText(result);
    }
});

test("computeGpa tolerates a missing argument object and a non-array courses value", () => {
    for (const input of [undefined, {}, { courses: null }, { courses: "nope" }, { courses: [null, undefined] }]) {
        const result = input === undefined ? gpa.computeGpa() : gpa.computeGpa(input);
        assert.equal(result.unweighted, null);
        assert.equal(result.weighted, null);
        assert.equal(result.cumulative, null);
        assertNeverNaNText(result);
    }
});

test("formatGpa renders the em-dash for every non-finite value and two decimals otherwise", () => {
    for (const value of [null, undefined, NaN, Infinity, -Infinity, "3.5"]) {
        assert.equal(gpa.formatGpa(value), gpa.EMPTY_DISPLAY);
    }
    assert.equal(gpa.formatGpa(3.456), "3.46");
    assert.equal(gpa.formatGpa(0), "0.00");
    assert.equal(gpa.formatGpa(4), "4.00");
    assert.equal(gpa.formatGpa(null, { empty: "n/a" }), "n/a");
});

test("the empty-state copy is factual and the module registers on the content namespace", () => {
    assert.equal(typeof gpa.EMPTY_MESSAGE, "string");
    assert.ok(gpa.EMPTY_MESSAGE.length > 0 && gpa.EMPTY_MESSAGE.length < 160);
    assert.doesNotMatch(gpa.EMPTY_MESSAGE, /NaN|error|failed|broken|invalid/i);
    assert.equal(globalThis.APStudyCanvasContent?.Gpa, gpa);
    assert.throws(() => { gpa.computeGpa = null; }, TypeError);
});

test("results are frozen so callers cannot mutate a computed GPA in place", () => {
    const result = gpa.computeGpa({
        courses: [{ weight: "regular", credits: 1, grade: 95 }],
        bounds: BOUNDS,
        weighted: false,
        cumulative: null
    });
    assert.throws(() => { result.unweighted = 9; }, TypeError);
    assert.throws(() => { result.courses[0].letter = "Z"; }, TypeError);
});
