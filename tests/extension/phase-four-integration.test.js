"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const registration = require("../../js/platform/canvas-registration.js");
const searchIndexApi = require("../../js/content/canvas-search-index.js");
const gradeAnalyticsApi = require("../../js/content/grade-analytics.js");
const gradeOverviewApi = require("../../js/content/grade-overview.js");
const canvasPaginationApi = require("../../js/canvas-adapter/pagination.js");
const { createCanvasSearchStorage } = require("./helpers/canvas-search-storage.js");
const { Document, walk } = require("./helpers/dom.js");

const root = path.resolve(__dirname, "../..");
const content = fs.readFileSync(path.join(root, "js/content.js"), "utf8");

function indexOf(file) {
    const index = registration.CANVAS_CONTENT_SCRIPTS.indexOf(file);
    assert.notEqual(index, -1, `missing registered provider: ${file}`);
    return index;
}

function extractFunction(name) {
    let start = content.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `missing ${name}`);
    if (content.slice(Math.max(0, start - 6), start) === "async ") start -= 6;
    let parenthesisDepth = 0;
    let bodyStart = -1;
    for (let index = content.indexOf("(", start); index < content.length; index += 1) {
        if (content[index] === "(") parenthesisDepth += 1;
        if (content[index] === ")") parenthesisDepth -= 1;
        if (parenthesisDepth === 0 && content[index] === "{") { bodyStart = index; break; }
    }
    assert.notEqual(bodyStart, -1, `missing body for ${name}`);
    let depth = 0;
    for (let index = bodyStart; index < content.length; index += 1) {
        if (content[index] === "{") depth += 1;
        if (content[index] === "}") {
            depth -= 1;
            if (depth === 0) return content.slice(start, index + 1);
        }
    }
    throw new Error(`unterminated ${name}`);
}

test("Phase 4 providers and isolated styles load before their consumers and content runtime", () => {
    const searchIndex = indexOf("js/content/canvas-search-index.js");
    const searchUi = indexOf("js/content/canvas-search-ui.js");
    const analytics = indexOf("js/content/grade-analytics.js");
    const analyticsUi = indexOf("js/content/grade-analytics-ui.js");
    const gradeOverview = indexOf("js/content/grade-overview.js");
    const runtime = indexOf("js/content.js");
    assert.ok(searchIndex < searchUi && searchUi < runtime);
    assert.ok(analytics < analyticsUi && analyticsUi < runtime);
    assert.ok(gradeOverview < runtime, "the grade overview provider loads before the content runtime");
    assert.ok(searchUi < analytics && analyticsUi < runtime, "providers have one deterministic topological order");
    assert.deepEqual(registration.CANVAS_CSS.slice(0, 3), ["css/content.css", "css/canvas-search.css", "css/grade-analytics.css"]);
});

test("Phase 4 activation is explicit opt-in and disposes/clears at every privacy boundary", () => {
    assert.match(content, /options\?\.canvas_search_enabled !== true/);
    assert.match(content, /options\?\.grade_analytics_enabled !== true/);
    assert.match(content, /teardownPhaseFourFeatures\("quiz-safe-route", \{ clearSearch: true \}\)/);
    assert.match(content, /teardownPhaseFourFeatures\("account-change", \{ clearSearch: true \}\)/);
    assert.match(content, /teardownPhaseFourFeatures\(reason \|\| "context-invalidated", \{ clearSearch: true \}\)/);
    assert.match(content, /phaseFour\(\) \{[\s\S]{0,420}?syncPhaseFourFeatures\("settings", \{ clearSearch: options\?\.canvas_search_enabled !== true \}\)/);
    assert.match(content, /teardownPhaseFourSearch\(reason \|\| "search-disabled", \{ clear: true \}\)/);
    assert.match(content, /teardownPhaseFourFeatures\("route"\)/);
    assert.match(content, /contentGradeAnalyticsAbort\?\.abort\?\.\(\)/);
    assert.match(content, /contentGradeAnalyticsUi\?\.isAttached\?\.\(\)/);
    assert.match(content, /schedulePhaseFourAnalyticsRetry/);
    assert.match(content, /analytics-host-replaced/);
    assert.match(content, /onRetry: \(\) =>/);
    assert.match(content, /void ensurePhaseFourAnalytics\(\);/);
    assert.match(content, /const cleaner = index \|\| contentCanvasSearchIndexApi\?\.createCanvasSearchIndex\?\.\(\{ storage: phaseFourStorage\(\) \}\)/);
    assert.match(content, /await cleaner\?\.clear\?\.\(context \|\| \{\}\)/);
    assert.match(content, /index\?\.dispose\?\.\(\)/);
});

test("search stays summonable on actual Dashboard, course, assignment, and quiz-detail URLs while active attempts remain safe", () => {
    const route = extractFunction("isQuizSafeRoute");
    const sandbox = { URL, window: { location: { origin: "https://canvas.emory.edu" } } };
    vm.runInNewContext(`${route}\nglobalThis.isSafe = isQuizSafeRoute;`, sandbox);
    for (const pathname of ["/", "/courses/42", "/courses/42/assignments/8", "/courses/42/quizzes/9"]) {
        assert.equal(sandbox.isSafe(`https://canvas.emory.edu${pathname}`), false, pathname);
    }
    for (const pathname of ["/courses/42/quizzes/9/take", "/quizzes/9/submission", "/external_tools/retrieve?new_quiz=1"]) {
        assert.equal(sandbox.isSafe(`https://canvas.emory.edu${pathname}`), true, pathname);
    }
});

test("grade analytics uses only Canvas course Grades routes and retries after the Grades host arrives", () => {
    const route = extractFunction("phaseFourGradeCourseId");
    const host = extractFunction("phaseFourGradeAnalyticsHost");
    const gradeContent = { id: "content" };
    const mainFallback = { id: "main" };
    const sandbox = {
        window: { location: { pathname: "/courses/42/grades" } },
        document: { querySelector(selector) { assert.equal(selector, "#content, #main"); return gradeContent; } }
    };
    vm.runInNewContext(`${route}\n${host}\nglobalThis.course = phaseFourGradeCourseId; globalThis.host = phaseFourGradeAnalyticsHost;`, sandbox);
    assert.equal(sandbox.course("/courses/42/grades"), "42");
    assert.equal(sandbox.course("/courses/42/grades/"), "42");
    for (const path of ["/courses/42", "/courses/42/assignments", "/courses/42/grades-export", "/courses/42/quizzes/5?grades=1", "/grades"]) assert.equal(sandbox.course(path), "", path);
    assert.equal(sandbox.host(), gradeContent, "the real Canvas Grades #content root is selected when it arrives");
    assert.equal(sandbox.host({ querySelector() { return mainFallback; } }), mainFallback, "older Canvas layouts retain the #main fallback");
    assert.match(extractFunction("ensurePhaseFourAnalytics"), /if \(!host \|\| !ui\?\.mount\) return schedulePhaseFourAnalyticsRetry\(\)/);
    assert.match(extractFunction("ensurePhaseFourAnalytics"), /ui\.mount\(host, \{ state: "loading"/);
});

test("storage-enabled grade analytics retries a late Canvas Grades host and remounts after Canvas replaces it", async () => {
    const timers = new Map(); let timerId = 0; let host = null; let mounts = 0; let aborts = 0;
    const controller = { signal: { aborted: false }, abort() { this.signal.aborted = true; aborts += 1; } };
    const sandbox = {
        window: { location: { pathname: "/courses/42/grades" } },
        document: { querySelector() { return host; } },
        options: { grade_analytics_enabled: true, gpa_calc_bounds: {} },
        contentGradeAnalyticsUi: null,
        contentGradeAnalyticsAbort: null,
        contentGradeAnalyticsRetryTimer: null,
        contentGradeAnalyticsRetryCount: 0,
        CONTENT_GRADE_ANALYTICS_RETRY_DELAYS: [0, 0],
        wasQuizSafeRoute: () => false,
        clearTimeout(id) { timers.delete(id); },
        setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id; },
        AbortController: class { constructor() { return controller; } },
        fetchPhaseFourGradeAnalyticsCollection: async () => [],
        phaseFourGradeAnalyticsFailureMessage: () => "Grade estimates could not be read from Canvas.",
        contentGradeAnalyticsApi: {},
        contentGradeAnalyticsUiApi: { createGradeAnalyticsUI() { return { mount(target) { mounts += 1; this.target = target; return true; }, update() {}, destroy() {}, isAttached() { return this.target === host; } }; } }
    };
    vm.runInNewContext(`${extractFunction("phaseFourGradeCourseId")}\n${extractFunction("phaseFourGradeAnalyticsHost")}\n${extractFunction("teardownPhaseFourAnalytics")}\n${extractFunction("schedulePhaseFourAnalyticsRetry")}\n${extractFunction("ensurePhaseFourAnalytics")}\nglobalThis.ensure = ensurePhaseFourAnalytics;`, sandbox);
    assert.equal(await sandbox.ensure(), true, "an enabled setting schedules a bounded retry when Canvas has not inserted its Grades host");
    host = { id: "content" };
    timers.values().next().value();
    await Promise.resolve(); await Promise.resolve();
    assert.equal(mounts, 1, "the delayed Canvas host receives the read-only analytics root");
    host = { id: "replacement-content" };
    await sandbox.ensure();
    assert.equal(aborts, 1, "a Canvas replacement aborts the old snapshot before remounting");
    assert.equal(mounts, 2, "the replacement host receives a fresh root");
});

test("grade analytics follows validated Canvas next links and calculates from page-two assignments", async () => {
    const origin = "https://canvas.emory.edu";
    const first = `${origin}/api/v1/courses/42/assignments?include[]=submission&per_page=100`;
    const second = `${origin}/api/v1/courses/42/assignments?include[]=submission&page=2&per_page=100`;
    const reads = [];
    const firstPage = [{ id: 1, name: "First page", points_possible: 10, submission: { score: 8 } }];
    const secondPage = [{ id: 2, name: "Second page", points_possible: 10, submission: { score: 10 } }];
    Object.defineProperty(firstPage, "__apstudyCanvasLink", { value: `<${second}>; rel="next", <${first}>; rel="current"` });
    const sandbox = {
        URL, DOMException, setTimeout, clearTimeout, window: { location: { origin } }, contentCanvasPaginationApi: canvasPaginationApi,
        fetchPhaseFourJson: async (href) => { reads.push(href); return new URL(href).searchParams.get("page") === "2" ? secondPage : firstPage; }
    };
    vm.runInNewContext(`${extractFunction("phaseFourCollectionItems")}\n${extractFunction("phaseFourGradeAnalyticsError")}\n${extractFunction("fetchPhaseFourGradeAnalyticsCollection")}\nglobalThis.collect = fetchPhaseFourGradeAnalyticsCollection;`, sandbox);
    const assignments = await sandbox.collect("/api/v1/courses/42/assignments?include[]=submission&per_page=100", new AbortController().signal);
    assert.deepEqual(JSON.parse(JSON.stringify(assignments.map((row) => row.id))), [1, 2]);
    assert.equal(reads.length, 2);
    assert.equal(new URL(reads[1]).searchParams.get("page"), "2");
    assert.equal(gradeAnalyticsApi.calculateAnalytics({ assignments }).overview.score, 90, "the overview includes page-two scores");
});

test("grade analytics rejects malformed, hostile, cyclic, and capped page sequences without a partial estimate", async () => {
    const origin = "https://canvas.emory.edu";
    const path = "/api/v1/courses/42/assignments?per_page=100";
    const base = `${origin}${path}`;
    const collectWith = async ({ link, maxPages, rows = [{ id: 1 }] }) => {
        const payload = rows.slice();
        if (link !== undefined) Object.defineProperty(payload, "__apstudyCanvasLink", { value: link });
        const sandbox = { URL, DOMException, setTimeout, clearTimeout, window: { location: { origin } }, contentCanvasPaginationApi: canvasPaginationApi, fetchPhaseFourJson: async () => payload };
        vm.runInNewContext(`${extractFunction("phaseFourCollectionItems")}\n${extractFunction("phaseFourGradeAnalyticsError")}\n${extractFunction("fetchPhaseFourGradeAnalyticsCollection")}\nglobalThis.collect = fetchPhaseFourGradeAnalyticsCollection;`, sandbox);
        return sandbox.collect(path, new AbortController().signal, { maxPages, maxItems: 500 });
    };
    for (const link of [
        "not a Link header",
        "<https://outside.example/api/v1/courses/42/assignments?page=2>; rel=\"next\"",
        `<${origin}/api/v1/courses/42/quizzes?page=2>; rel="next"`
    ]) await assert.rejects(collectWith({ link }), (error) => error.code === "GRADE_ANALYTICS_PAGINATION_INVALID");
    await assert.rejects(collectWith({ link: `<${base}>; rel="next"` }), (error) => error.code === "GRADE_ANALYTICS_PAGINATION_CYCLE");
    await assert.rejects(collectWith({ link: `<${origin}/api/v1/courses/42/assignments?page=2&per_page=100>; rel="next"`, maxPages: 1 }), (error) => error.code === "GRADE_ANALYTICS_COLLECTION_TRUNCATED");
    await assert.rejects(collectWith({ rows: Array.from({ length: 501 }, (_, id) => ({ id })) }), (error) => error.code === "GRADE_ANALYTICS_COLLECTION_TRUNCATED");
});

test("grade analytics stops page reads on cancellation and lets a partial-page failure retry cleanly", async () => {
    const origin = "https://canvas.emory.edu";
    const path = "/api/v1/courses/42/assignments?per_page=100";
    const next = `${origin}/api/v1/courses/42/assignments?page=2&per_page=100`;
    const controller = new AbortController(); let reads = 0;
    const first = [{ id: 1 }]; Object.defineProperty(first, "__apstudyCanvasLink", { value: `<${next}>; rel="next"` });
    const sandbox = {
        URL, DOMException, setTimeout, clearTimeout, window: { location: { origin } }, contentCanvasPaginationApi: canvasPaginationApi,
        fetchPhaseFourJson: async () => { reads += 1; controller.abort(); return first; }
    };
    vm.runInNewContext(`${extractFunction("phaseFourCollectionItems")}\n${extractFunction("phaseFourGradeAnalyticsError")}\n${extractFunction("fetchPhaseFourGradeAnalyticsCollection")}\nglobalThis.collect = fetchPhaseFourGradeAnalyticsCollection;`, sandbox);
    await assert.rejects(sandbox.collect(path, controller.signal), (error) => error.name === "AbortError");
    assert.equal(reads, 1, "route teardown prevents a second page request");

    let failPageTwo = true;
    const recoveredPage = [{ id: 2 }];
    sandbox.fetchPhaseFourJson = async (href) => {
        if (new URL(href).searchParams.get("page") !== "2") return first;
        if (failPageTwo) throw Object.assign(new Error("PHASE_FOUR_READ_500"), { code: "PHASE_FOUR_READ_500" });
        return recoveredPage;
    };
    await assert.rejects(sandbox.collect(path, new AbortController().signal), (error) => error.code === "PHASE_FOUR_READ_500", "a failed second page rejects the entire snapshot");
    failPageTwo = false;
    const recovered = await sandbox.collect(path, new AbortController().signal);
    assert.deepEqual(JSON.parse(JSON.stringify(recovered.map((row) => row.id))), [1, 2], "retry starts over and returns both pages, never a retained partial page");

    let attempts = 0; let retry; const updates = [];
    const readySource = { assignmentGroups: [{ id: 1, name: "Tests", group_weight: 100 }], assignments: [{ id: 1, name: "Recovered page", assignment_group_id: 1, points_possible: 10, submission: { score: 9 } }] };
    const integration = {
        window: { location: { pathname: "/courses/42/grades" } }, document: { querySelector() { return { id: "content" }; } }, options: { grade_analytics_enabled: true, gpa_calc_bounds: {} },
        contentGradeAnalyticsUi: null, contentGradeAnalyticsAbort: null, contentGradeAnalyticsRetryCount: 0, wasQuizSafeRoute: () => false,
        AbortController,
        phaseFourGradeAnalyticsFailureMessage: (error) => error.code === "PHASE_FOUR_READ_500" ? "Canvas page two failed. No estimate is shown; try again." : "unexpected",
        fetchPhaseFourGradeAnalyticsCollection: async () => { attempts += 1; if (attempts <= 2) throw Object.assign(new Error("PHASE_FOUR_READ_500"), { code: "PHASE_FOUR_READ_500" }); return attempts === 3 ? readySource.assignmentGroups : readySource.assignments; },
        contentGradeAnalyticsApi: {},
        contentGradeAnalyticsUiApi: { createGradeAnalyticsUI() { return { mount() { return true; }, update(config) { updates.push(config); if (config.onRetry) retry = config.onRetry; }, destroy() {}, isAttached() { return false; } }; } },
        teardownPhaseFourAnalytics() { this.contentGradeAnalyticsUi = null; }, ensurePhaseFourAnalytics: null
    };
    vm.runInNewContext(`${extractFunction("phaseFourGradeCourseId")}\n${extractFunction("phaseFourGradeAnalyticsHost")}\nfunction teardownPhaseFourAnalytics() { contentGradeAnalyticsAbort?.abort?.(); contentGradeAnalyticsAbort = null; contentGradeAnalyticsUi?.destroy?.(); contentGradeAnalyticsUi = null; }\n${extractFunction("ensurePhaseFourAnalytics")}\nglobalThis.ensurePhaseFourAnalytics = ensurePhaseFourAnalytics;`, integration);
    integration.ensurePhaseFourAnalytics = integration.ensurePhaseFourAnalytics;
    await integration.ensurePhaseFourAnalytics();
    assert.match(updates.at(-1).error, /No estimate is shown/);
    retry(); await new Promise((resolve) => setTimeout(resolve, 0));
    const ready = updates.find((update) => update.state === "ready");
    assert.equal(ready.source.assignments[0].name, "Recovered page", "retry replaces the failed partial snapshot with complete data");
});

test("search privacy teardown aborts route, quiz, account, and dispose work and clears local storage", async () => {
    const teardown = extractFunction("teardownPhaseFourSearch");
    for (const reason of ["route", "quiz-safe-route", "account-change", "dispose"]) {
        const storage = createCanvasSearchStorage();
        const index = searchIndexApi.createCanvasSearchIndex({ storage });
        const context = { origin: "https://canvas.example.edu", accountId: "student-42" };
        let signal;
        const pending = index.refresh({
            ...context,
            enabled: true,
            collect: ({ signal: supplied }) => new Promise((resolve) => { signal = supplied; supplied.addEventListener("abort", () => resolve([]), { once: true }); })
        });
        await Promise.resolve();
        const sandbox = {
            contentCanvasSearchIndex: index,
            contentCanvasSearchContext: context,
            contentCanvasSearchUi: { destroy() {} },
            contentCanvasSearchIndexApi: searchIndexApi,
            phaseFourStorage: () => storage
        };
        vm.runInNewContext(`${teardown}\nglobalThis.teardown = teardownPhaseFourSearch;`, sandbox);
        await sandbox.teardown(reason, { clear: true });
        assert.equal(signal.aborted, true, `${reason} aborts an active local-index collection`);
        assert.deepEqual(await pending, { ok: false, code: "CANVAS_SEARCH_CANCELLED" });
        assert.equal(storage.value(searchIndexApi.STORAGE_KEY), undefined, `${reason} physically clears the local index`);
    }
});

test("search record collection excludes Canvas bodies and descriptions before indexing", () => {
    const sandbox = {};
    vm.runInNewContext(`${extractFunction("phaseFourSearchRecords")}\nglobalThis.records = phaseFourSearchRecords;`, sandbox);
    const records = sandbox.records(
        { id: 7, name: "Biology" },
        [{ id: 1, name: "Assignment", html_url: "/courses/7/assignments/1", description: "private assignment body" }],
        [{ id: 2, display_name: "File", url: "/courses/7/files/2", description: "private file description" }],
        [{ page_id: 3, title: "Page", url: "page", body: "private page body" }],
        [{ id: 4, name: "Module label", items: [{ id: 5, title: "Module item", url: "/courses/7/modules/items/5" }] }]
    );
    assert.deepEqual(JSON.parse(JSON.stringify(records.map((record) => Object.keys(record).sort()))), [
        ["courseId", "courseName", "href", "id", "title", "type"],
        ["courseId", "courseName", "href", "id", "title", "type"],
        ["courseId", "courseName", "href", "id", "title", "type"],
        ["courseId", "courseName", "href", "id", "moduleLabel", "title", "type"]
    ]);
    assert.equal(JSON.stringify(records).includes("private"), false);
});

test("search collector accepts Canvas collection envelopes, pages bounded reads, and retains successful resource types after a resource failure", async () => {
    const sandbox = {
        URL,
        DOMException,
        AbortController,
        setTimeout,
        clearTimeout,
        window: { location: { origin: "https://canvas.emory.edu" } },
        fetchPhaseFourJson: async (path) => {
            const url = new URL(path, "https://canvas.emory.edu");
            assert.equal(url.searchParams.get("per_page"), "100");
            assert.match(url.searchParams.get("page"), /^[1-5]$/);
            if (url.pathname === "/api/v1/courses") return { data: [{ id: 42, name: "Biology" }] };
            if (url.pathname.endsWith("/assignments")) return [{ id: 8, name: "Envelope-safe assignment", html_url: "/courses/42/assignments/8", description: "do not retain" }];
            if (url.pathname.endsWith("/files")) {
                const error = new Error("PHASE_FOUR_READ_403"); error.code = error.message; error.status = 403; throw error;
            }
            if (url.pathname.endsWith("/pages")) return { data: [{ page_id: 3, title: "Course page", url: "course-page", body: "do not retain" }] };
            if (url.pathname.endsWith("/modules")) return [{ id: 5, name: "Week 1", items: [{ id: 7, title: "Module item", html_url: "/courses/42/modules/items/7" }] }];
            throw new Error(`unexpected ${path}`);
        }
    };
    vm.runInNewContext(`${extractFunction("phaseFourCollectionItems")}\n${extractFunction("fetchPhaseFourSearchCollection")}\n${extractFunction("phaseFourSearchRecords")}\n${extractFunction("collectPhaseFourSearchRecords")}\nglobalThis.collect = collectPhaseFourSearchRecords;`, sandbox);
    const collected = await sandbox.collect({});
    assert.deepEqual(JSON.parse(JSON.stringify(collected.items.map((item) => item.type).sort())), ["assignment", "module", "page"]);
    assert.deepEqual(JSON.parse(JSON.stringify(collected.failures)), ["PHASE_FOUR_READ_403"]);
    assert.equal(JSON.stringify(collected.items).includes("do not retain"), false);
});

test("search collection bounds repeated Link pagination and per-request timeouts without waiting for ignored aborts", async () => {
    const timers = new Map(); let timerId = 0;
    const clock = { setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id; }, clearTimeout(id) { timers.delete(id); }, fire() { [...timers.values()].forEach((callback) => callback()); timers.clear(); } };
    const sandbox = {
        URL, DOMException, AbortController, window: { location: { origin: "https://canvas.emory.edu" } },
        setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
        fetch: async () => new Promise(() => {})
    };
    vm.runInNewContext(`${extractFunction("phaseFourCollectionItems")}\n${extractFunction("fetchPhaseFourJson")}\n${extractFunction("fetchPhaseFourSearchCollection")}\nglobalThis.fetchCollection = fetchPhaseFourSearchCollection;`, sandbox);
    const stalled = sandbox.fetchCollection("/api/v1/courses", new AbortController().signal, { requestTimeoutMs: 1, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout });
    clock.fire();
    await assert.rejects(stalled, (error) => error.code === "CANVAS_SEARCH_TIMEOUT");

    sandbox.fetchPhaseFourJson = async (path) => {
        const payload = [{ id: path }];
        Object.defineProperty(payload, "__apstudyCanvasNext", { value: "/api/v1/courses?page=1&per_page=1" });
        return payload;
    };
    await assert.rejects(sandbox.fetchCollection("/api/v1/courses?page=1", new AbortController().signal, { maxPages: 5, perPage: 1 }), (error) => error.code === "CANVAS_SEARCH_PAGINATION_CYCLE");
});

test("read-only Canvas snapshots are same-origin, API-scoped, and bounded before local indexing", () => {
    const reader = extractFunction("fetchPhaseFourJson");
    const collector = extractFunction("collectPhaseFourSearchRecords");
    assert.match(reader, /target\.origin !== window\.location\.origin/);
    assert.match(reader, /target\.pathname\.startsWith\("\/api\/v1\/"\)/);
    assert.match(reader, /method: "GET"/);
    assert.doesNotMatch(reader, /\b(?:POST|PUT|PATCH|DELETE)\b/);
    assert.match(collector, /courses\.slice\(0, 20\)/);
    assert.match(collector, /Promise\.allSettled/);
    assert.match(collector, /records\.length >= 500/);
    assert.match(collector, /items: records\.slice\(0, 500\)/);
});

test("only same-origin user-gesture search intents are executable", () => {
    const context = { URL, window: { location: { origin: "https://canvas.example.edu" } } };
    vm.runInNewContext(`${extractFunction("validatePhaseFourNavigationIntent")}\nglobalThis.validate = validatePhaseFourNavigationIntent;`, context);
    const valid = context.validate({ type: "canvas-search-navigation", href: "/courses/7/assignments/9", disposition: "new-tab", userGesture: true }, "https://canvas.example.edu");
    assert.equal(valid.href, "https://canvas.example.edu/courses/7/assignments/9");
    for (const intent of [
        { type: "canvas-search-navigation", href: "https://outside.example/item", disposition: "current-tab", userGesture: true },
        { type: "canvas-search-navigation", href: "javascript:alert(1)", disposition: "current-tab", userGesture: true },
        { type: "canvas-search-navigation", href: "/courses/7", disposition: "current-tab", userGesture: false },
        { type: "not-search", href: "/courses/7", disposition: "current-tab", userGesture: true }
    ]) assert.equal(context.validate(intent, "https://canvas.example.edu"), null);
    assert.match(extractFunction("executePhaseFourNavigationIntent"), /window\.open\(target\.href, "_blank", "noopener"\)/);
    assert.match(extractFunction("executePhaseFourNavigationIntent"), /window\.location\.assign\(target\.href\)/);
});

test("the global grade overview is bound to the exact /grades route and tears down on course routes", () => {
    const route = extractFunction("phaseFourGlobalGradesRoute");
    const sandbox = { window: { location: { pathname: "/grades" } } };
    vm.runInNewContext(`${route}\nglobalThis.globalRoute = phaseFourGlobalGradesRoute;`, sandbox);
    for (const pathname of ["/grades", "/grades/"]) assert.equal(sandbox.globalRoute(pathname), true, pathname);
    for (const pathname of ["/", "/gradesx", "/courses/42/grades", "/courses/42/grades/", "/grades/export", "/grades/42"]) assert.equal(sandbox.globalRoute(pathname), false, pathname);

    const ensure = extractFunction("ensurePhaseFourGradeOverview");
    assert.match(ensure, /grade_analytics_enabled !== true/, "the overview shares the explicit analytics opt-in");
    assert.match(ensure, /wasQuizSafeRoute\(\)/, "quiz-safe routes never host the overview");
    assert.match(ensure, /phaseFourGlobalGradesRoute\(\)/, "only the global /grades route hosts the overview");
    assert.match(extractFunction("teardownPhaseFourFeatures"), /teardownPhaseFourGradeOverview\(reason\)/, "every phase-four teardown also removes the overview");
    assert.match(extractFunction("syncPhaseFourGradeOverview"), /contentGradeOverviewUi\?\.update\?\.\(/, "a missing or failed overview UI degrades instead of throwing");
});

function globalGradesContent(doc) {
    const content = doc.createElement("DIV");
    const table = doc.createElement("TABLE");
    const body = doc.createElement("TBODY");
    const row = doc.createElement("TR");
    const nameCell = doc.createElement("TD");
    nameCell.className = "course";
    const anchor = doc.createElement("A");
    anchor.setAttribute("href", "/courses/42/grades/9001");
    anchor.textContent = "Biology";
    anchor.getAttribute = (key) => (key in anchor.attributes ? anchor.attributes[key] : null);
    nameCell.append(anchor);
    row.append(nameCell);
    const scoreCell = doc.createElement("TD");
    scoreCell.className = "percent";
    scoreCell.textContent = "89.5%";
    row.append(scoreCell);
    body.append(row);
    const listingRow = doc.createElement("TR");
    const listingCell = doc.createElement("TD");
    const listing = doc.createElement("A");
    listing.className = "no-hover";
    listing.setAttribute("href", "/grades");
    listing.textContent = "All courses";
    listing.getAttribute = (key) => (key in listing.attributes ? listing.attributes[key] : null);
    listingCell.append(listing);
    listingRow.append(listingCell);
    body.append(listingRow);
    table.append(body);
    content.append(table);
    return content;
}

test("the grade overview mounts cold, late, and after Canvas replaces the host without duplicating roots", () => {
    const doc = new Document();
    let host = null;
    doc.querySelector = () => host;
    const timers = new Map(); let timerId = 0;
    const fireTimers = () => { const pending = [...timers.values()]; timers.clear(); pending.forEach((callback) => callback()); };
    const sandbox = {
        window: { location: { pathname: "/grades" } },
        document: doc,
        options: { grade_analytics_enabled: true, gpa_calc_bounds: {} },
        contentGradeOverviewApi: gradeOverviewApi,
        contentCardAppearanceApi: null,
        contentGradeOverviewUi: null,
        contentGradeOverviewState: null,
        contentGradeOverviewRetryTimer: null,
        contentGradeOverviewRetryCount: 0,
        CONTENT_GRADE_ANALYTICS_RETRY_DELAYS: [0, 0, 0, 0, 0],
        wasQuizSafeRoute: () => false,
        setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id; },
        clearTimeout(id) { timers.delete(id); }
    };
    vm.runInNewContext(`${[
        extractFunction("phaseFourGlobalGradesRoute"),
        extractFunction("phaseFourGradeAnalyticsHost"),
        extractFunction("phaseFourGradeOverviewLetterResolver"),
        extractFunction("teardownPhaseFourGradeOverview"),
        extractFunction("syncPhaseFourGradeOverview"),
        extractFunction("schedulePhaseFourGradeOverviewRetry"),
        extractFunction("ensurePhaseFourGradeOverview")
    ].join("\n")}\nglobalThis.ensure = ensurePhaseFourGradeOverview;\nglobalThis.teardown = teardownPhaseFourGradeOverview;`, sandbox);

    assert.equal(sandbox.ensure(), true, "an enabled /grades visit schedules a bounded retry before Canvas paints its course table");
    assert.equal(timers.size, 1, "exactly one retry timer is outstanding");
    assert.equal(sandbox.contentGradeOverviewUi, null, "nothing mounts without a host");

    host = globalGradesContent(doc);
    for (let refresh = 0; refresh < 8; refresh += 1) sandbox.ensure();
    assert.equal(timers.size, 1, "repeated Canvas refresh probes preserve the single late-host retry");
    fireTimers();
    assert.equal(sandbox.contentGradeOverviewState, "ready", "the late Canvas table is summarized on the first retry");
    assert.equal(timers.size, 0, "a ready overview stops the retry loop");
    assert.equal(walk(host).filter((node) => node.className === gradeOverviewApi.ROOT_CLASS).length, 1);
    assert.match(walk(host).map((node) => node.textContent).join(" "), /Biology/);
    assert.match(walk(host).map((node) => node.textContent).join(" "), /89\.5%/);
    const overviewLink = walk(host).find((node) => String(node.tagName).toUpperCase() === "A" && node.className === "apstudy-grade-overview__link");
    assert.equal(overviewLink.attributes.href, "/courses/42/grades", "the native user-suffixed row renders one canonical text-only course link");
    assert.equal(overviewLink.textContent, "Biology");

    const replaced = host;
    replaced.replaceChildren();
    host = globalGradesContent(doc);
    assert.equal(sandbox.ensure(), true, "a Canvas-replaced host is detected and remounted");
    assert.equal(replaced.children.length, 0, "the detached overview root is destroyed, never left behind");
    assert.equal(walk(host).filter((node) => node.className === gradeOverviewApi.ROOT_CLASS).length, 1, "the replacement host owns exactly one root");
});

test("grade overview empties only after bounded retries, recovers through its retry action, and cleans up when disabled or routed to a course", () => {
    const doc = new Document();
    let host = doc.createElement("DIV");
    doc.querySelector = () => host;
    const timers = new Map(); let timerId = 0;
    const fireTimers = () => { const pending = [...timers.values()]; timers.clear(); pending.forEach((callback) => callback()); };
    const sandbox = {
        window: { location: { pathname: "/grades" } },
        document: doc,
        options: { grade_analytics_enabled: true, gpa_calc_bounds: {} },
        contentGradeOverviewApi: gradeOverviewApi,
        contentCardAppearanceApi: null,
        contentGradeOverviewUi: null,
        contentGradeOverviewState: null,
        contentGradeOverviewRetryTimer: null,
        contentGradeOverviewRetryCount: 0,
        CONTENT_GRADE_ANALYTICS_RETRY_DELAYS: [0, 0, 0, 0, 0],
        wasQuizSafeRoute: () => false,
        setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id; },
        clearTimeout(id) { timers.delete(id); }
    };
    vm.runInNewContext(`${[
        extractFunction("phaseFourGlobalGradesRoute"),
        extractFunction("phaseFourGradeAnalyticsHost"),
        extractFunction("phaseFourGradeOverviewLetterResolver"),
        extractFunction("teardownPhaseFourGradeOverview"),
        extractFunction("syncPhaseFourGradeOverview"),
        extractFunction("schedulePhaseFourGradeOverviewRetry"),
        extractFunction("ensurePhaseFourGradeOverview")
    ].join("\n")}\nglobalThis.ensure = ensurePhaseFourGradeOverview;\nglobalThis.teardown = teardownPhaseFourGradeOverview;`, sandbox);

    assert.equal(sandbox.ensure(), true, "an empty /grades page keeps retrying while Canvas hydrates");
    for (let attempt = 0; timers.size > 0 && attempt < 10; attempt += 1) fireTimers();
    assert.equal(sandbox.contentGradeOverviewState, "empty", "bounded retries end in a disclosed empty state");
    assert.equal(timers.size, 0);
    const root = walk(host).find((node) => node.className === gradeOverviewApi.ROOT_CLASS);
    const retryButton = walk(root).find((node) => node.dataset.action === "retry");
    assert.ok(retryButton, "the empty state offers an explicit retry");
    root.dispatchEvent({ type: "click", target: retryButton });
    assert.equal(timers.size, 1, "the retry action restarts a bounded retry loop instead of giving up permanently");

    sandbox.teardown("disabled-cleanup");
    assert.equal(host.children.length, 0, "disabling removes the overview root");
    assert.equal(sandbox.contentGradeOverviewUi, null);
    sandbox.options.grade_analytics_enabled = false;
    assert.equal(sandbox.ensure(), false, "a disabled setting never remounts the overview");
    assert.equal(host.children.length, 0);
    assert.equal(timers.size, 0, "no retry timer survives a disabled cleanup");
    sandbox.options.grade_analytics_enabled = true;

    sandbox.window.location.pathname = "/courses/42/grades";
    assert.equal(sandbox.ensure(), false, "the course Grades route never hosts the global overview");
    assert.equal(host.children.length, 0);
    assert.equal(timers.size, 0, "course routes schedule no global overview retries");

    sandbox.window.location.pathname = "/grades";
    assert.equal(sandbox.ensure(), true, "returning to /grades remounts exactly one overview");
    fireTimers();
    assert.equal(walk(host).filter((node) => node.className === gradeOverviewApi.ROOT_CLASS).length, 1, "global and course handoffs never duplicate roots");
});

test("manifest and registration agree that grade-overview loads before the content runtime", () => {
    const manifestScripts = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8")).content_scripts.flatMap((entry) => entry.js || []);
    assert.ok(manifestScripts.includes("js/content/grade-overview.js"), "manifest registers the grade overview provider");
    assert.ok(manifestScripts.indexOf("js/content/grade-overview.js") < manifestScripts.indexOf("js/content.js"), "the provider precedes the runtime in manifest.json");
    assert.match(fs.readFileSync(path.join(root, "html/popup.html"), "utf8"), /read-only Grade overview to the global Grades page and per-course analytics to each course Grades page/, "the popup copy stays truthful about both surfaces");
});

test("ordinary phase-four sync preserves a loading global overview while disabled state still tears it down", () => {
    const sync = extractFunction("syncPhaseFourFeatures");
    assert.doesNotMatch(sync, /^\s*teardownPhaseFourGradeOverview\(reason \|\| "overview-refresh"\);/m);
    assert.match(sync, /if \(options\?\.grade_analytics_enabled !== true\) teardownPhaseFourGradeOverview\(reason \|\| "overview-disabled"\)/);
    assert.match(sync, /return ensurePhaseFourGradeOverview\(\)/);
});

test("search uses Canvas file previews instead of rejected download hosts and retrieves omitted module items", async () => {
    const sandbox = {
        URL, DOMException, AbortController, setTimeout, clearTimeout,
        window: { location: { origin: "https://canvas.emory.edu" } },
        fetchPhaseFourJson: async (path) => {
            const route = new URL(path, "https://canvas.emory.edu").pathname;
            if (route === "/api/v1/courses") return [{ id: 42, name: "Biology" }];
            if (route.endsWith("/files")) return [{ id: 8, display_name: "Reading", url: "https://downloads.example/file?token=secret" }];
            if (route.endsWith("/modules")) return [{ id: 9, name: "Week one", items_count: 1 }];
            if (route.endsWith("/modules/9/items")) return [{ id: 10, title: "Module reading", url: "/api/v1/courses/42/pages/reading" }];
            return [];
        }
    };
    vm.runInNewContext(`${["phaseFourCollectionItems", "fetchPhaseFourSearchCollection", "phaseFourSearchRecords", "collectPhaseFourSearchRecords"].map(extractFunction).join("\n")}\nglobalThis.collect = collectPhaseFourSearchRecords;`, sandbox);
    const data = JSON.parse(JSON.stringify(await sandbox.collect()));
    assert.deepEqual(data.items.map((item) => item.href), ["/courses/42/files/8", "/courses/42/modules/items/10"]);
    const index = searchIndexApi.createCanvasSearchIndex();
    await index.write({ origin: sandbox.window.location.origin, accountId: "1", enabled: true, items: data.items });
    const matches = await index.query({ origin: sandbox.window.location.origin, accountId: "1", enabled: true, query: "reading" });
    assert.equal(matches.items.length, 2);
    assert.doesNotMatch(JSON.stringify(matches), /secret|downloads.example|api\/v1/);
});
