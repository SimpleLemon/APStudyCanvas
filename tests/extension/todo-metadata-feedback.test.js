"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const model = require("../../js/content/todo-model.js");
const planner = require("../../js/content/planner-tasks.js");
const viewCache = require("../../js/content/todo-view-cache.js");
const railApi = require("../../js/content/todo-right-rail.js");
const transport = require("../../js/platform/transport.js");

const ACCOUNT_KEY = "a".repeat(64);
const source = fs.readFileSync(path.resolve(__dirname, "../../js/content.js"), "utf8");

// The extraction helpers live inside content.js (a page script, not a module).
// Slice only that block so the test exercises the shipped code without booting
// the whole Canvas integration.
const extractorStart = source.indexOf("function feedbackNodeText");
const extractorEnd = source.indexOf("function removeRail()", extractorStart);
assert.ok(extractorStart >= 0 && extractorEnd > extractorStart, "content.js owns the Recent Feedback extractor");
const createExtractor = new Function("document", `${source.slice(extractorStart, extractorEnd)}\nreturn extractRecentFeedback;`);

function feedbackEntry({ title, href, course, text }) {
    const anchor = href === undefined ? null : {
        href,
        textContent: title || "",
        getAttribute: (name) => name === "href" ? href : null
    };
    const item = {
        textContent: text ?? [title, course].filter(Boolean).join(" "),
        querySelectorAll: (selector) => selector === "a[href]" && anchor ? [anchor] : [],
        querySelector: (selector) => selector.includes("course") && course ? { textContent: course } : null
    };
    return item;
}

function feedbackDocument(items) {
    const root = { querySelectorAll: (selector) => selector === "li" ? items : [], children: items };
    return {
        documentStub: {
            querySelector: (selector) => selector.includes("recent_feedback") ? root : null,
            location: { origin: "https://canvas.example.edu", href: "https://canvas.example.edu/" }
        }
    };
}

test("Recent Feedback extraction is sanitized, origin-bounded, and never projects View Grades", () => {
    const { documentStub } = feedbackDocument([
        feedbackEntry({ title: "Lab report", href: "https://canvas.example.edu/courses/42/assignments/7", course: "BIO 141", text: "Lab report BIO 141 Score: 8 out of 10" }),
        feedbackEntry({ title: "View Grades", href: "https://canvas.example.edu/courses/42/grades", course: "BIO 141", text: "BIO 141 View Grades" }),
        feedbackEntry({ title: "External", href: "https://other.example.edu/courses/42/assignments/9", course: "BIO 141", text: "External BIO 141 10/20" })
    ]);
    const entries = createExtractor(documentStub)();
    assert.equal(entries.length, 3);
    assert.equal(entries[0].title, "Lab report");
    assert.equal(entries[0].url, "https://canvas.example.edu/courses/42/assignments/7");
    assert.equal(entries[0].courseId, "42");
    assert.equal(entries[0].courseLabel, "BIO 141");
    assert.deepEqual(entries[0].score, { earned: 8, possible: 10 });
    assert.equal(entries[1].url, null, "a View Grades link is navigation, not feedback");
    assert.equal(entries[2].url, null, "cross-origin links never enter the rail");
    assert.equal(entries[2].score.earned, 10);
    assert.ok(Object.isFrozen(entries[0]), "entries are immutable projections");
    assert.equal(createExtractor({ querySelector: () => null, location: { origin: "https://canvas.example.edu" } })().length, 0, "a missing native list yields no fabricated feedback");
    // Extraction reads only: it never moves, hides, or rewrites native markup.
    const snippet = source.slice(extractorStart, extractorEnd);
    assert.doesNotMatch(snippet, /\.remove\(|innerHTML|appendChild|insertBefore|style\./);
    assert.match(source, /const railView = \{ \.\.\.view, feedback: extractRecentFeedback\(\) \};/, "every render re-extracts feedback so account or route switches cannot leak stale entries");
});

test("the owned planner-note marker round-trips through normalization with its metadata", async () => {
    const details = planner.encodeDetails({
        description: "Read the chapter",
        id: "pt-abcdefg-1234567",
        completed: false,
        meta: { type: "custom", customType: "Physics lab", priority: "high", points: { earned: 8.5, possible: 10 } }
    });
    const owned = await model.normalizeCanvasTask("planner_note", {
        id: 91,
        plannable_id: 91,
        course_id: 42,
        todo_date: "2026-09-05",
        title: "Owned note",
        details,
        plannable: { id: 91, details, todo_date: "2026-09-05" }
    }, { origin: "https://canvas.example.edu", userId: "7", accountKey: ACCOUNT_KEY });
    assert.equal(owned.ok, true);
    assert.equal(owned.task.type, "planner_note", "the transport discriminator still authorizes the writer");
    assert.equal(owned.task.source, "canvas-planner-note");
    assert.equal(owned.task.mutationAuthority, "canvas_planner_note");
    assert.equal(owned.task.taskType, "custom");
    assert.equal(owned.task.customType, "Physics lab");
    assert.equal(owned.task.priority, "high");
    assert.deepEqual(owned.task.points, { earned: 8.5, possible: 10 });

    const legacy = "APSTUDYCANVAS_PLANNER_NOTE:1:pt-legacy-1234567:0";
    const legacyTask = await model.normalizeCanvasTask("planner_note", {
        id: 92, plannable_id: 92, course_id: 42, todo_date: "2026-09-06", title: "Legacy note",
        details: legacy, plannable: { id: 92, details: legacy, todo_date: "2026-09-06" }
    }, { origin: "https://canvas.example.edu", userId: "7", accountKey: ACCOUNT_KEY });
    assert.equal(legacyTask.task.taskType, "task", "version-1 notes resolve to the neutral default");
    assert.equal(legacyTask.task.customType, null);
});

test("Nest normalization keeps type, custom type, description, priority, and structured points", () => {
    const result = model.normalizeNestTask({
        id: "n1",
        title: "Study block",
        task_type: "custom",
        custom_type: "Physics lab",
        description: "Chapter 4 problems",
        priority: "high",
        points: { earned: 3, possible: 5 }
    }, { accountKey: "nest" });
    assert.equal(result.ok, true);
    assert.equal(result.task.taskType, "custom");
    assert.equal(result.task.customType, "Physics lab");
    assert.equal(result.task.description, "Chapter 4 problems");
    assert.equal(result.task.priority, "high");
    assert.deepEqual(result.task.points, { earned: 3, possible: 5 });
    const numeric = model.normalizeNestTask({ id: "n2", title: "Legacy", points: 12 }, { accountKey: "nest" });
    assert.deepEqual(numeric.task.points, { earned: null, possible: 12 }, "a bare numeric points value still means possible points");

    // The supported Nest contract echoes a custom name in `type_label` and
    // points as scalars; both must normalize without loss.
    const echoed = model.normalizeNestTask({
        id: "n3", title: "Echoed custom", type: "custom", type_label: "Physics lab",
        points_earned: 3, points_possible: 5
    }, { accountKey: "nest" });
    assert.equal(echoed.task.taskType, "custom");
    assert.equal(echoed.task.customType, "Physics lab");
    assert.deepEqual(echoed.task.points, { earned: 3, possible: 5 });
});

test("the rail's Nest create payload uses only transport-allowlisted fields", () => {
    const payload = railApi.buildNestCreatePayload({
        title: "Study block", type: "custom", customType: "Physics lab",
        description: "Chapter 4", link: "https://canvas.example.edu/courses/42",
        dueDate: "2026-09-05", dueTime: "23:59", timezone: "America/New_York",
        priority: "high", courseId: "42", earned: "9", possible: "10"
    }, "idem-1");
    assert.doesNotThrow(() => transport.validateTodoCreatePayload(payload), "the production transport accepts the rail's Nest payload");
    assert.equal(payload.type_label, "Physics lab");
    assert.equal(payload.points_earned, 9);
    assert.equal(payload.points_possible, 10);
    assert.equal(payload.custom_type, undefined, "custom_type is not on the transport allowlist");
    assert.equal(payload.points, undefined, "the structured points object is not on the transport allowlist");
    assert.equal(payload.due_at, "2026-09-05T23:59:00");
});

test("the view cache preserves task metadata and raw markers across a reload", () => {
    const details = planner.encodeDetails({ description: "Cached", id: "pt-cached-1234567", meta: { type: "study", priority: "low" } });
    const view = {
        canvasTasks: [{
            id: "canvas:42:7", source: "canvas-planner-note", type: "planner_note", accountKey: ACCOUNT_KEY,
            title: "Cached note", taskType: "study", customType: null, priority: "low", points: { earned: null, possible: 5 },
            raw: { id: 7, plannable_id: 7, course_id: 42, todo_date: "2026-09-08", details, plannable_type: "planner_note" }
        }],
        nestTasks: [{
            id: "nest:cached", source: "nest", type: "nest_task", accountKey: ACCOUNT_KEY,
            title: "Nest study", taskType: "quiz", customType: "Pop quiz", description: "Chapter 2",
            raw: { id: "cached", task_type: "quiz", custom_type: "Pop quiz", description: "Chapter 2" }
        }],
        courses: [],
        canvasState: "live",
        nestState: "live",
        announcementState: "live",
        sourceState: {},
        streak: { state: "verified", current: 3 }
    };
    const sanitized = viewCache.sanitizeView(view, ACCOUNT_KEY);
    assert.equal(sanitized.canvasTasks[0].taskType, "study");
    assert.equal(sanitized.canvasTasks[0].priority, "low");
    assert.match(sanitized.canvasTasks[0].raw.details, /APSTUDYCANVAS_PLANNER_NOTE:2:/);
    assert.deepEqual(sanitized.canvasTasks[0].points, { earned: null, possible: 5 });
    assert.equal(sanitized.nestTasks[0].taskType, "quiz");
    assert.equal(sanitized.nestTasks[0].customType, "Pop quiz");
    assert.equal(sanitized.nestTasks[0].description, "Chapter 2");
    assert.equal(sanitized.nestTasks[0].raw.custom_type, "Pop quiz");
});
