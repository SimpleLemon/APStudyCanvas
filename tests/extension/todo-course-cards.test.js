"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const cardsApi = require("../../js/content/todo-course-cards.js");

class FakeElement {
    constructor(documentRef, tagName) {
        this.ownerDocument = documentRef;
        this.nodeName = String(tagName).toUpperCase();
        this.parentNode = null;
        this.childNodes = [];
        this.attributes = new Map();
        this.listeners = new Map();
        this.style = { setProperty: (key, value) => { this.style[key] = value; } };
        this.disabled = false;
        this._text = "";
        this._className = "";
    }
    get children() { return this.childNodes.filter((node) => node instanceof FakeElement); }
    get firstChild() { return this.childNodes[0] || null; }
    get isConnected() { return this.nodeName === "BODY" || Boolean(this.parentNode?.isConnected); }
    get className() { return this._className; }
    set className(value) { this._className = String(value || ""); this.attributes.set("class", this._className); }
    get id() { return this.getAttribute("id"); }
    set id(value) { this.setAttribute("id", value); }
    get textContent() { return this._text || this.childNodes.map((node) => node.textContent || "").join(""); }
    set textContent(value) { this._text = String(value ?? ""); this.replaceChildren(); }
    append(...nodes) { nodes.forEach((node) => this.appendChild(node)); }
    appendChild(node) { node?.parentNode?.removeChild?.(node); if (node) { node.parentNode = this; this.childNodes.push(node); } return node; }
    removeChild(node) { const index = this.childNodes.indexOf(node); if (index >= 0) this.childNodes.splice(index, 1); if (node) node.parentNode = null; return node; }
    replaceChildren(...nodes) { this.childNodes.forEach((node) => { node.parentNode = null; }); this.childNodes = []; nodes.forEach((node) => this.appendChild(node)); }
    remove() { this.parentNode?.removeChild?.(this); }
    setAttribute(name, value) { const key = String(name); this.attributes.set(key, String(value)); if (key === "class") this._className = String(value); }
    getAttribute(name) { return this.attributes.get(String(name)) ?? null; }
    addEventListener(type, handler) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(handler); }
    dispatch(type, properties = {}) { const event = { type, target: this, currentTarget: this, preventDefault() {}, ...properties }; (this.listeners.get(type) || []).slice().forEach((handler) => handler(event)); return event; }
    focus() { this.ownerDocument.activeElement = this; }
    contains(node) { return node === this || this.childNodes.some((child) => child.contains?.(node)); }
    matches(selector) {
        const simple = selector.trim();
        const tag = simple.match(/^[a-zA-Z][\w-]*/)?.[0];
        if (tag && this.nodeName.toLowerCase() !== tag.toLowerCase()) return false;
        const id = simple.match(/#([\w:-]+)/)?.[1];
        if (id && this.id !== id) return false;
        const classes = Array.from(simple.matchAll(/\.([\w-]+)/g), (match) => match[1]);
        if (classes.some((name) => !this.className.split(/\s+/).includes(name))) return false;
        const attrs = Array.from(simple.matchAll(/\[([^\]=]+)(?:=['"]?([^\]'" ]+)['"]?)?\]/g));
        return attrs.every(([, name, expected]) => this.getAttribute(name) !== null && (expected === undefined || this.getAttribute(name) === expected));
    }
    querySelectorAll(selector) {
        const selectors = String(selector).split(",").map((item) => item.trim()).filter(Boolean);
        const found = [];
        const visit = (node) => node.childNodes.forEach((child) => { if (!(child instanceof FakeElement)) return; if (selectors.some((candidate) => child.matches(candidate))) found.push(child); visit(child); });
        visit(this);
        return found;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

class FakeDocument {
    constructor() { this.body = new FakeElement(this, "body"); this.activeElement = null; }
    createElement(tagName) { return new FakeElement(this, tagName); }
    contains(node) { return this.body.contains(node); }
}

class CountingDocument extends FakeDocument {
    constructor() { super(); this.elementMutations = 0; }
    createElement(tagName) { this.elementMutations += 1; return super.createElement(tagName); }
}

const ACCOUNT_A = "a".repeat(64);
const ACCOUNT_B = "b".repeat(64);

function task(id, source, overrides = {}) {
    return {
        id,
        source,
        title: `${source} ${id}`,
        course: { id: "42", label: "BIO 141", color: "#294d91" },
        accountKey: source === "canvas" ? ACCOUNT_A : undefined,
        due: { kind: "instant", utcInstant: "2026-08-27T12:00:00.000Z", timeZone: "UTC" },
        completion: false,
        missing: false,
        priority: "normal",
        url: source === "canvas" ? `https://canvas.emory.edu/tasks/${id}` : `https://nest.apstudy.org/tasks/${id}`,
        ...overrides
    };
}

function card(documentRef) {
    const node = documentRef.createElement("article");
    node.setAttribute("data-course-id", "42");
    documentRef.body.append(node);
    return node;
}

function tick() { return new Promise((resolve) => setImmediate(resolve)); }

function percentile(samples, fraction) {
    const ordered = samples.slice().sort((left, right) => left - right);
    return ordered[Math.min(ordered.length - 1, Math.max(0, Math.ceil(ordered.length * fraction) - 1))];
}

function viewModel(overrides = {}) {
    return {
        course: { id: "42", label: "BIO 141" },
        canvasAccountKey: ACCOUNT_A,
        canvasTasks: [
            task("canvas-a", "canvas"),
            task("canvas-b", "canvas", { due: { kind: "date", date: "2026-09-02", timeZone: "UTC" } })
        ],
        nestTasks: [task("nest-a", "nest", { canvasAccountKey: ACCOUNT_A })],
        settings: { todo_card_max: 4 },
        ...overrides
    };
}

test("associates Canvas and Nest records only at the exact opaque account/course boundary", () => {
    const canvas = task("canvas-match", "canvas");
    const nestMatch = task("nest-match", "nest", { canvasAccountKey: ACCOUNT_A });
    const unmatchedNest = task("nest-other-account", "nest", { canvasAccountKey: ACCOUNT_B });
    const unmatchedCourse = task("nest-other-course", "nest", { canvasAccountKey: ACCOUNT_A, course: { id: "99" } });
    const merged = cardsApi.mergeCourseTasks({ course: { id: 42, label: "BIO 141" }, canvasAccountKey: ACCOUNT_A, canvasTasks: [canvas], nestTasks: [nestMatch, unmatchedNest, unmatchedCourse] });
    assert.deepEqual(merged.map((entry) => entry.id), ["canvas-match", "nest-match"]);
    assert.deepEqual(merged[1].courseAssociation, { canvasAccountKey: ACCOUNT_A, courseId: "42", source: "course-card-metadata" });
    assert.equal(nestMatch.courseAssociation, undefined, "association is metadata on the returned copy, not the input");
    assert.deepEqual(cardsApi.mergeCourseTasks({ course: { id: "42" }, canvasAccountKey: ACCOUNT_B, canvasTasks: [canvas], nestTasks: [nestMatch] }), []);
    assert.deepEqual(cardsApi.mergeCourseTasks({ course: { id: "42" }, canvasAccountKey: ACCOUNT_A, canvasTasks: [canvas], nestTasks: [task("nest-unmatched", "nest")] }), [canvas]);
});

test("selects active tasks in balanced urgency rounds with deterministic ties", () => {
    const make = (id, date, extra = {}) => task(id, "canvas", { due: { kind: "date", date, timeZone: "UTC" }, ...extra });
    const selected = cardsApi.selectCourseCardTasks([
        make("overdue-b", "2026-08-20"), make("overdue-a", "2026-08-20"),
        make("urgent", "2026-08-26"), make("soon", "2026-08-28"), make("later", "2026-09-04"),
        make("already-done", "2026-08-26", { completion: true })
    ], { cap: 5, now: Date.parse("2026-08-26T12:00:00Z"), timeZone: "UTC" });
    assert.deepEqual(selected.map((entry) => entry.task.id), ["overdue-a", "urgent", "soon", "later", "overdue-b"]);
    assert.deepEqual(selected.map((entry) => entry.classification.bucket), ["overdue", "urgent", "soon", "later", "overdue"]);
    assert.equal(cardsApi.selectCourseCardTasks([make("only", "2026-08-26")], { cap: 10 }).length, 1);
    assert.equal(cardsApi.normalizeSettings({}).todo_card_max, 4);
    assert.equal(cardsApi.normalizeSettings({ todo_card_max: 0 }).todo_card_max, 1);
    assert.equal(cardsApi.normalizeSettings({ todo_card_max: 99 }).todo_card_max, 10);
    assert.equal(cardsApi.normalizeSettings({ todo_card_max: "bad" }).todo_card_max, 4);
});

test("course-card order honors every visible mode with deterministic ties", () => {
    const make = (id, date, course) => task(id, "canvas", {
        due: { kind: "date", date, timeZone: "UTC" },
        course: { id: course, code: course, label: course }
    });
    const tasks = [
        make("biology-later", "2026-09-04", "BIO 141"),
        make("chemistry-first", "2026-08-26", "CHEM 150"),
        make("biology-first", "2026-08-28", "BIO 141")
    ];
    const options = { cap: 3, now: Date.parse("2026-08-26T12:00:00Z"), timeZone: "UTC" };
    assert.equal(cardsApi.normalizeSettings({ todo_card_sort: "due-date" }).todo_card_sort, "due-date");
    assert.equal(cardsApi.normalizeSettings({ todo_card_sort: "course" }).todo_card_sort, "course");
    assert.equal(cardsApi.normalizeSettings({ todo_card_sort: "invalid" }).todo_card_sort, "urgency-balanced");
    assert.deepEqual(cardsApi.selectCourseCardTasks(tasks, { ...options, sort: "due-date" }).map((entry) => entry.task.id), ["chemistry-first", "biology-first", "biology-later"]);
    assert.deepEqual(cardsApi.selectCourseCardTasks(tasks, { ...options, sort: "course" }).map((entry) => entry.task.id), ["biology-first", "biology-later", "chemistry-first"]);
});

test("defaults to enabled, hides completed records immediately, and exposes medium-width placement hooks", () => {
    assert.equal(cardsApi.normalizeSettings({}).todo_enabled, true);
    assert.equal(cardsApi.normalizeSettings({}).todo_course_card_tasks_enabled, true);
    const done = task("done", "canvas", { completion: true });
    assert.deepEqual(cardsApi.selectCourseCardTasks([done], { cap: 4 }).map((entry) => entry.task.id), []);
    assert.deepEqual(cardsApi.getPlacementHooks().mediumWidth, { min: 768, max: 1100, railPlacement: "below-course-cards" });
    assert.equal(cardsApi.PLACEMENT_HOOKS.cardAttachment, "course-card");
});

test("mount/update/destroy is idempotent, survives missing cards, and uses accessible task semantics", () => {
    const documentRef = new FakeDocument();
    const courseCard = card(documentRef);
    const controller = cardsApi.create({ document: documentRef, now: Date.parse("2026-08-26T12:00:00Z") });
    const mounted = controller.mount({ card: courseCard, course: { id: "42", label: "BIO 141" }, canvasAccountKey: ACCOUNT_A, canvasTasks: [task("one", "canvas")] });
    assert.equal(mounted.ok, true);
    assert.equal(courseCard.querySelectorAll("[data-apstudycanvas-owned='todo-course-card-tasks']").length, 1);
    assert.equal(controller.mount({ card: courseCard, canvasTasks: [task("two", "canvas")] }).state, "mounted");
    const root = controller.getRoot();
    assert.equal(courseCard.querySelectorAll("[data-apstudycanvas-owned='todo-course-card-tasks']").length, 1);
    assert.equal(root.querySelector("h3").textContent, "To-do");
    assert.equal(root.getAttribute("role"), "region");
    assert.equal(root.querySelector("ul").getAttribute("aria-label"), "Tasks for BIO 141");
    const link = root.querySelector("a");
    assert.equal(link.getAttribute("target"), "_blank");
    assert.equal(link.getAttribute("rel"), "noopener noreferrer");
    const complete = root.querySelector("button[data-action='complete-task']");
    assert.equal(complete.getAttribute("type"), "button");
    assert.match(complete.getAttribute("aria-label"), /Mark/);
    assert.equal(complete.getAttribute("aria-pressed"), "false");
    controller.update({ canvasTasks: [] });
    assert.match(controller.getRoot().textContent, /No active tasks/);
    courseCard.remove();
    assert.equal(controller.update().state, "card-missing");
    assert.equal(controller.getRoot(), null);
    assert.equal(controller.destroy().state, "destroyed");
    assert.equal(controller.mount({ card: null }).code, "TODO_COURSE_CARD_MISSING");
});

test("completion is pessimistic: pending disables, success hides or keeps, failure preserves retryable state", async () => {
    const documentRef = new FakeDocument();
    const courseCard = card(documentRef);
    let resolveCompletion;
    const calls = [];
    const dispatcher = (record, desired, context) => {
        calls.push({ record, desired, context });
        return new Promise((resolve) => { resolveCompletion = resolve; });
    };
    const controller = cardsApi.create({ document: documentRef, completionDispatcher: dispatcher, now: Date.parse("2026-08-26T12:00:00Z") });
    controller.mount({ card: courseCard, course: { id: "42" }, canvasAccountKey: ACCOUNT_A, canvasTasks: [task("pending", "canvas")] });
    controller.getRoot().querySelector("button[data-action='complete-task']").dispatch("click");
    assert.equal(controller.getRoot().querySelector("button[data-action='complete-task']").disabled, true);
    assert.equal(controller.getRoot().querySelector("[data-status='active']").getAttribute("data-status"), "active");
    await tick();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].context.mode, "canvas");
    resolveCompletion({ ok: true });
    await tick();
    assert.equal(controller.getRoot().querySelector("[data-task-id='pending']"), null, "success hides immediately by default");

    let rejectCompletion;
    const failing = cardsApi.create({ document: documentRef, completionDispatcher: () => new Promise((resolve, reject) => { rejectCompletion = reject; }), now: Date.parse("2026-08-26T12:00:00Z") });
    documentRef.body.append(courseCard);
    failing.mount({ card: courseCard, course: { id: "42" }, canvasAccountKey: ACCOUNT_A, canvasTasks: [task("failure", "canvas")] });
    failing.getRoot().querySelector("button[data-action='complete-task']").dispatch("click");
    await tick();
    rejectCompletion(new Error("offline"));
    await tick();
    assert.ok(failing.getRoot().querySelector("[data-task-id='failure']"));
    assert.equal(failing.getRoot().querySelector("[data-task-id='failure']").getAttribute("data-status"), "active");
    assert.match(failing.getRoot().querySelector("[role='alert']").textContent, /offline/);
    assert.equal(failing.getRoot().querySelector("button[data-action='complete-task']").disabled, false, "retry remains available");

    const keep = cardsApi.create({ document: documentRef, completionDispatcher: async () => ({ ok: true }), now: Date.parse("2026-08-26T12:00:00Z") });
    keep.mount({ card: courseCard, course: { id: "42" }, canvasAccountKey: ACCOUNT_A, settings: { todo_hide_completed: "keep-visible" }, canvasTasks: [task("keep", "canvas")] });
    keep.getRoot().querySelector("button[data-action='complete-task']").dispatch("click");
    await tick();
    assert.equal(keep.getRoot().querySelector("[data-task-id='keep']").getAttribute("data-status"), "completed");
    assert.equal(keep.getRoot().querySelector("[data-status-label='Completed']").textContent, "Completed");
    keep.destroy();
    failing.destroy();
});

test("identical update on the same mounted card skips clear/rebuild and returns rendered:false", () => {
    const documentRef = new CountingDocument();
    const courseCard = card(documentRef);
    const controller = cardsApi.create({ document: documentRef, now: Date.parse("2026-08-26T12:00:00Z") });
    const mounted = controller.mount({ card: courseCard, ...viewModel() });
    assert.equal(mounted.ok, true);
    assert.equal(mounted.rendered, true);
    const root = controller.getRoot();
    const heading = root.querySelector("h3");
    const childrenBefore = Array.from(root.children);
    assert.equal(courseCard.querySelectorAll("li").length, 3);

    // Convergence means zero DOM writes of any kind, not merely no structural
    // change: attribute sets, text rewrites, and node insertion/removal are
    // all mutation-observer-visible and would feed the refresh pipeline.
    const domWrites = { attributes: 0, text: 0, structure: 0 };
    const proto = FakeElement.prototype;
    const originalSetAttribute = proto.setAttribute;
    const textDescriptor = Object.getOwnPropertyDescriptor(proto, "textContent");
    const originalReplaceChildren = proto.replaceChildren;
    const originalAppendChild = proto.appendChild;
    const originalRemove = proto.remove;
    proto.setAttribute = function (name, value) { domWrites.attributes += 1; return originalSetAttribute.call(this, name, value); };
    Object.defineProperty(proto, "textContent", {
        ...textDescriptor,
        set(value) { domWrites.text += 1; textDescriptor.set.call(this, value); }
    });
    proto.replaceChildren = function (...nodes) { domWrites.structure += 1; return originalReplaceChildren.apply(this, nodes); };
    proto.appendChild = function (node) { domWrites.structure += 1; return originalAppendChild.call(this, node); };
    proto.remove = function () { domWrites.structure += 1; return originalRemove.call(this); };
    let result;
    try {
        documentRef.elementMutations = 0;
        result = controller.update({ card: courseCard, ...viewModel() });
        assert.equal(result.ok, true);
        assert.equal(result.state, "unchanged");
        assert.equal(result.rendered, false);
        assert.equal(documentRef.elementMutations, 0, "identical inputs must not create elements");
        assert.equal(domWrites.attributes, 0, "identical inputs must not write attributes");
        assert.equal(domWrites.text, 0, "identical inputs must not rewrite text");
        assert.equal(domWrites.structure, 0, "identical inputs must not insert or remove nodes");
    } finally {
        proto.setAttribute = originalSetAttribute;
        Object.defineProperty(proto, "textContent", textDescriptor);
        proto.replaceChildren = originalReplaceChildren;
        proto.appendChild = originalAppendChild;
        proto.remove = originalRemove;
    }
    assert.equal(controller.getRoot(), root, "root node identity is preserved");
    const childrenAfter = Array.from(root.children);
    assert.equal(childrenAfter.length, childrenBefore.length, "root child count is preserved");
    childrenBefore.forEach((child, index) => assert.equal(childrenAfter[index], child, "root child nodes are retained"));
    assert.equal(root.querySelector("h3"), heading, "no clear/rebuild occurred");
    assert.equal(courseCard.querySelectorAll("li").length, 3);
});

test("time passage that changes a rendered bucket re-renders, while harmless clock drift stays fast", () => {
    const documentRef = new CountingDocument();
    const courseCard = card(documentRef);
    const model = { course: { id: "42" }, canvasAccountKey: ACCOUNT_A, canvasTasks: [task("timely", "canvas")] };
    const controller = cardsApi.create({ document: documentRef, now: Date.parse("2026-08-26T00:00:00Z") });
    controller.mount({ card: courseCard, ...model });
    const row = () => controller.getRoot().querySelector("[data-task-id='timely']");
    const root = controller.getRoot();
    assert.equal(row().getAttribute("data-urgency"), "soon");
    const dueText = row().querySelector("time").textContent;

    const drift = controller.update({ ...model, now: Date.parse("2026-08-26T01:00:00Z") });
    assert.equal(drift.rendered, false, "clock drift that changes no derived output must not re-render");
    assert.equal(controller.getRoot(), root);

    const crossed = controller.update({ ...model, now: Date.parse("2026-08-28T00:00:00Z") });
    assert.equal(crossed.rendered, true, "crossing a due threshold re-renders with no other input change");
    assert.equal(crossed.root, controller.getRoot());
    assert.equal(row().getAttribute("data-urgency"), "overdue");
    assert.ok(row().querySelector("[data-status-label='Overdue']"));
    assert.equal(row().querySelector("time").textContent, dueText, "absolute due text is time-stable");
});

test("update fails open by rendering when signature serialization throws", () => {
    const documentRef = new CountingDocument();
    const courseCard = card(documentRef);
    const circular = {};
    circular.self = circular;
    const model = { course: { id: "42" }, canvasAccountKey: ACCOUNT_A, canvasTasks: [task("boom", "canvas", { due: { kind: "instant", utcInstant: circular } })] };
    const controller = cardsApi.create({ document: documentRef, now: Date.parse("2026-08-26T00:00:00Z") });
    const mounted = controller.mount({ card: courseCard, ...model });
    assert.equal(mounted.ok, true, "mount also fails open instead of throwing");
    const boomRow = controller.getRoot().querySelector("[data-task-id='boom']");
    assert.equal(boomRow.querySelector("[data-status-label]").textContent, "Upcoming");
    assert.match(boomRow.textContent, /Due date unavailable/);

    const result = controller.update({ ...model, canvasTasks: [task("boom", "canvas", { title: "renamed boom", due: { kind: "instant", utcInstant: circular } })] });
    assert.equal(result.rendered, true, "an unprovable signature never takes the fast path");
    assert.match(controller.getRoot().querySelector("[data-task-id='boom']").textContent, /renamed boom/);
});

test("a representative visible change in each input family re-renders", () => {
    const documentRef = new CountingDocument();
    const courseCard = card(documentRef);
    const controller = cardsApi.create({ document: documentRef, now: Date.parse("2026-08-26T12:00:00Z") });
    controller.mount({ card: courseCard, ...viewModel() });
    const root = () => controller.getRoot();

    documentRef.elementMutations = 0;
    let result = controller.update(viewModel({ course: { id: "42", label: "BIO 201" } }));
    assert.equal(result.rendered, true);
    assert.ok(documentRef.elementMutations > 0);
    assert.equal(root().querySelector("ul").getAttribute("aria-label"), "Tasks for BIO 201");

    documentRef.elementMutations = 0;
    result = controller.update(viewModel({ canvasAccountKey: ACCOUNT_B }));
    assert.equal(result.rendered, true);
    assert.ok(documentRef.elementMutations > 0);
    assert.match(root().textContent, /No active tasks/);

    documentRef.elementMutations = 0;
    result = controller.update(viewModel({ canvasTasks: [task("canvas-new", "canvas")] }));
    assert.equal(result.rendered, true);
    assert.ok(documentRef.elementMutations > 0);
    assert.ok(root().querySelector("[data-task-id='canvas-new']"));

    documentRef.elementMutations = 0;
    result = controller.update(viewModel({ nestTasks: [task("nest-new", "nest", { canvasAccountKey: ACCOUNT_A })] }));
    assert.equal(result.rendered, true);
    assert.ok(documentRef.elementMutations > 0);
    const nestRow = root().querySelector("[data-task-id='nest-new']");
    assert.ok(nestRow);
    assert.equal(nestRow.querySelector("[data-source-label='Nest']").textContent, "Nest");

    documentRef.elementMutations = 0;
    result = controller.update(viewModel({ settings: { todo_card_max: 1 } }));
    assert.equal(result.rendered, true);
    assert.ok(documentRef.elementMutations > 0);
    assert.equal(root().querySelectorAll("li").length, 1);
});

test("mounting onto a replacement card and destroy/remount always render fresh", () => {
    const documentRef = new CountingDocument();
    const cardA = card(documentRef);
    const cardB = card(documentRef);
    const controller = cardsApi.create({ document: documentRef, now: Date.parse("2026-08-26T12:00:00Z") });
    const first = controller.mount({ card: cardA, ...viewModel() });
    const rootA = controller.getRoot();
    assert.equal(first.rendered, true);

    const moved = controller.mount({ card: cardB, ...viewModel() });
    assert.equal(moved.ok, true);
    assert.equal(moved.rendered, true, "mount to another card renders even with an identical signature");
    const rootB = controller.getRoot();
    assert.notEqual(rootB, rootA);
    assert.equal(cardA.querySelectorAll("[data-apstudycanvas-owned='todo-course-card-tasks']").length, 0, "old card is cleaned up");
    assert.equal(cardB.querySelectorAll("[data-apstudycanvas-owned='todo-course-card-tasks']").length, 1);

    documentRef.elementMutations = 0;
    assert.equal(controller.update(viewModel()).rendered, false, "signature baseline is reset by the new mount");
    assert.equal(documentRef.elementMutations, 0);

    controller.destroy();
    assert.equal(controller.getRoot(), null);
    const remounted = controller.mount({ card: cardA, ...viewModel() });
    assert.equal(remounted.ok, true);
    assert.equal(remounted.rendered, true, "remount after destroy renders fresh");
    assert.notEqual(controller.getRoot(), rootB);
    assert.equal(cardA.querySelectorAll("li").length, 3);
});

test("course-card CSS has the responsive, focus, and medium-width placement contract", () => {
    const css = fs.readFileSync(path.join(__dirname, "../../css/todo-course-cards.css"), "utf8");
    assert.match(css, /container-type:\s*inline-size/);
    assert.match(css, /min-width:\s*0/);
    assert.match(css, /:focus-visible/);
    assert.match(css, /@media\s*\(min-width:\s*768px\)\s*and\s*\(max-width:\s*1100px\)/);
    assert.match(css, /data-apstudycanvas-todo-placement="below-course-cards"/);
    assert.match(css, /grid-column:\s*1\s*\/\s*-1/);
    assert.doesNotMatch(css, /fonts\.googleapis\.com|fonts\.gstatic\.com/);
});

test("200 normalized Canvas planner tasks stay below the To-Do render/update p95 budget", (t) => {
    const plannerTasks = Array.from({ length: 200 }, (_, index) => task(`planner-${index}`, "canvas", {
        type: ["assignment", "quiz", "discussion", "planner_note"][index % 4],
        title: `Planner task ${String(index).padStart(3, "0")}`,
        due: { kind: "instant", utcInstant: new Date(Date.parse("2026-08-20T12:00:00Z") + index * 3600000).toISOString(), timeZone: "UTC" },
        missing: index % 37 === 0,
        priority: index % 19 === 0 ? "urgent" : "normal"
    }));
    const run = () => {
        const documentRef = new CountingDocument();
        const courseCard = card(documentRef);
        const controller = cardsApi.create({ document: documentRef, now: Date.parse("2026-08-26T12:00:00Z") });
        const started = process.hrtime.bigint();
        const mounted = controller.mount({
            card: courseCard,
            course: { id: "42", label: "BIO 141" },
            canvasAccountKey: ACCOUNT_A,
            canvasTasks: plannerTasks,
            settings: { todo_card_max: 10 }
        });
        assert.equal(mounted.ok, true);
        const updated = controller.update({
            canvasTasks: plannerTasks.map((entry, index) => index === 0 ? { ...entry, title: "Planner task updated" } : entry)
        });
        assert.equal(updated.rendered, true, "benchmark exercises the renderer's normal changed-model update path");
        assert.equal(controller.getRoot().querySelectorAll("li").length, 10, "the actual card renderer caps the visible planner list");
        controller.destroy();
        return Number(process.hrtime.bigint() - started) / 1e6;
    };
    // JIT and module-local shape warmup are intentionally outside the sample
    // population; the gate evaluates repeated complete domain/render/update
    // passes rather than one wall-clock observation.
    for (let index = 0; index < 4; index += 1) run();
    const samples = Array.from({ length: 20 }, run);
    const p95 = percentile(samples, 0.95);
    assert.ok(p95 < 100, `200-task To-Do/planner render-update p95 ${p95.toFixed(3)} ms must remain below 100 ms`);
    t.diagnostic(`todo-200 samples=${samples.length} warmup=4 p50=${percentile(samples, 0.5).toFixed(3)}ms p95=${p95.toFixed(3)}ms node=${process.version} platform=${process.platform}/${process.arch}`);
});
