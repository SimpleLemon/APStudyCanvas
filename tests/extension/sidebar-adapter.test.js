"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const adapter = require("../../js/content/sidebar-adapter.js");
const identity = require("../../js/canvas-adapter/identity.js");

const ORIGIN = "https://canvas.example.edu";

class Node {
    constructor(tagName, attributes = {}, textContent = "") {
        this.tagName = tagName.toUpperCase();
        this.nodeType = 1;
        this.textContent = textContent;
        this.attributes = new Map(Object.entries(attributes));
        this.children = [];
    }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
    matches(selector) {
        return selector.split(",").some((part) => {
            const value = part.trim();
            const id = value.match(/#([\w-]+)/)?.[1];
            if (id && this.getAttribute("id") !== id) return false;
            const classNames = Array.from(value.matchAll(/\.([\w-]+)/g), (match) => match[1]);
            if (classNames.length) {
                const own = String(this.getAttribute("class") || "").split(/\s+/).filter(Boolean);
                if (classNames.some((name) => !own.includes(name))) return false;
            }
            const tag = value.match(/^([a-z]+)/i)?.[1];
            if (tag && this.tagName !== tag.toUpperCase()) return false;
            if (value.includes("[href]")) return this.getAttribute("href") !== null;
            if (value === "img" && this.tagName !== "IMG") return false;
            return true;
        });
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    querySelectorAll(selector) {
        const result = [];
        for (const child of this.children) {
            if (child.matches?.(selector)) result.push(child);
            result.push(...(child.querySelectorAll?.(selector) || []));
        }
        return result;
    }
}

function documentWithPages({ unknownLabel = "Custom page", includeIdentity = true } = {}) {
    const html = new Node("html");
    const nav = new Node("nav", { id: "global_nav" });
    const logo = new Node("div", { id: "global_nav_logo", title: "Emory Canvas" });
    if (includeIdentity) logo.appendChild(new Node("img", { src: `${ORIGIN}/logo.png`, alt: "Emory University" }));
    nav.appendChild(logo);
    const profile = new Node("a", { id: "global_nav_profile_link", "data-user-name": "Canvas Student" });
    if (includeIdentity) profile.appendChild(new Node("img", { src: "https://cdn.example/avatar.png", alt: "Canvas Student" }));
    nav.appendChild(profile);
    const links = [
        ["dashboard", "/"], ["courses", "/courses"], ["calendar", "/calendar"],
        ["inbox", "/conversations"], ["history", "/users/self/history"], ["help", "/help"]
    ];
    for (const [id, href] of links) {
        const domId = id === "inbox" ? "global_nav_conversations_link" : `global_nav_${id}_link`;
        const link = new Node("a", { id: domId, href, "aria-label": id === "inbox" ? "Inbox" : id[0].toUpperCase() + id.slice(1) }, id);
        if (id === "inbox") link.appendChild(new Node("span", { "data-unread-count": "4" }, "4"));
        nav.appendChild(link);
    }
    nav.appendChild(new Node("a", { href: "/custom/route" }, unknownLabel));
    html.appendChild(nav);
    return { querySelector: (selector) => html.querySelector(selector), querySelectorAll: (selector) => html.querySelectorAll(selector) };
}

function documentWithDashboardCourses({ hidden = false } = {}) {
    const document = documentWithPages();
    const html = new Node("div");
    const cards = new Node("div", { id: "DashboardCard_Container" });
    const visible = new Node("div", { class: "ic-DashboardCard" });
    visible.appendChild(new Node("a", { href: "/courses/42", class: "ic-DashboardCard__link" }, "Biology"));
    const concealed = new Node("div", { class: `ic-DashboardCard${hidden ? " is-hidden" : ""}` });
    concealed.appendChild(new Node("a", { href: "/courses/43", class: "ic-DashboardCard__link" }, "Hidden Chemistry"));
    cards.appendChild(visible);
    cards.appendChild(concealed);
    html.appendChild(cards);
    return {
        querySelector: (selector) => html.querySelector(selector) || document.querySelector(selector),
        querySelectorAll: (selector) => [...document.querySelectorAll(selector), ...html.querySelectorAll(selector)]
    };
}

function response(body, headers = {}, status = 200) {
    return { status, headers, async json() { return body; } };
}

test("normalizes known and unknown native destinations without using localized labels", () => {
    const document = documentWithPages();
    const pages = adapter.discoverPages({ document, location: { origin: ORIGIN, pathname: "/courses/42" } });
    assert.deepEqual(pages.slice(0, 6).map((page) => page.id), ["dashboard", "courses", "calendar", "inbox", "history", "help"]);
    const unknown = pages.find((page) => !page.known);
    assert.match(unknown.id, /^canvas-route:/);
    assert.equal(unknown.href, `${ORIGIN}/custom/route`);
    assert.equal(unknown.source, "canvas");
    assert.equal(unknown.available, true);
    assert.equal(unknown.label, "Custom page");
    const changed = adapter.discoverPages({ document: documentWithPages({ unknownLabel: "Localized replacement" }), location: { origin: ORIGIN, pathname: "/" } }).find((page) => !page.known);
    assert.equal(changed.id, unknown.id);
});

test("appends four APStudy action records with feature icons and trailing egg branding", () => {
    const pages = adapter.discoverPages({ document: documentWithPages(), location: { origin: ORIGIN, pathname: "/" } });
    const custom = pages.filter((page) => page.source === "apstudycanvas");
    assert.deepEqual(custom.map((page) => page.id), ["apstudy:planner", "apstudy:notes", "apstudy:grades", "apstudy:study"]);
    assert.deepEqual(custom.map((page) => page.label), ["Planner", "Notes", "Grades", "Study"]);
    assert.deepEqual(custom.map((page) => page.action), ["planner", "notes", "grades", "study"]);
    assert.ok(custom.every((page) => page.available === true));
    assert.deepEqual(custom.map((page) => page.iconRole), ["planner", "notes", "grades", "study"]);
    assert.equal(pages.indexOf(custom[0]) > pages.findIndex((page) => page.source === "canvas"), true);
});

test("discovers History from Canvas history selectors and canonical routes", () => {
    const document = documentWithPages();
    const history = adapter.discoverPages({ document, location: { origin: ORIGIN, pathname: "/users/self/history" } }).find((page) => page.id === "history");
    assert.equal(history.href, `${ORIGIN}/users/self/history`);
    assert.equal(history.available, true);
    assert.equal(adapter.parseCanvasRoute(`${ORIGIN}/users/self/history`).pageId, "history");
    assert.equal(adapter.parseCanvasRoute(`${ORIGIN}/history`).pageId, "history");
});

test("rejects anchor-only and executable destination hrefs before normalization", () => {
    ["", "#", "#history", `${ORIGIN}/#history`, "javascript:void(0)", "JAVASCRIPT:alert(1)", "//other.example/path"].forEach((href) => {
        assert.equal(adapter.safeUrl(href, ORIGIN), null, `unsafe placeholder survived: ${href}`);
    });
    assert.equal(adapter.safeUrl("/users/self/history", ORIGIN, { available: false }), null);
    assert.equal(adapter.safeUrl("/users/self/history", ORIGIN, { verified: false }), null);
    assert.equal(adapter.safeUrl("/users/self/history", ORIGIN), `${ORIGIN}/users/self/history`);
    const placeholderDocument = documentWithPages();
    const history = placeholderDocument.querySelector("#global_nav_history_link");
    history.setAttribute("href", "#");
    const help = placeholderDocument.querySelector("#global_nav_help_link");
    help.setAttribute("href", "javascript:void(0)");
    const pages = adapter.discoverPages({ document: placeholderDocument, location: { origin: ORIGIN, pathname: "/users/self/history" } });
    assert.equal(pages.find((page) => page.id === "history").available, false);
    assert.equal(pages.find((page) => page.id === "help").available, false);
});

test("parses canonical routes and rejects substring false positives", () => {
    assert.equal(adapter.parseCanvasRoute(`${ORIGIN}/courses/42`).kind, "course");
    assert.equal(adapter.parseCanvasRoute(`${ORIGIN}/courses/42/assignments`).courseId, "42");
    assert.equal(adapter.parseCanvasRoute(`${ORIGIN}/courses/420`).courseId, "420");
    assert.equal(adapter.parseCanvasRoute(`${ORIGIN}/courses/42x`).kind, "unknown");
    assert.equal(adapter.parseCanvasRoute(`${ORIGIN}/not-courses/42`).kind, "unknown");
    assert.equal(adapter.routeMatches("courses", adapter.parseCanvasRoute(`${ORIGIN}/courses/42`)), true);
    assert.equal(adapter.routeMatches("courses", adapter.parseCanvasRoute(`${ORIGIN}/courseshelf`)), false);
    assert.equal(adapter.routeMatches({ id: "calendar", href: `${ORIGIN}/calendar` }, `${ORIGIN}/calendarize`), false);
    assert.equal(adapter.routeMatches({ id: "dashboard", href: "#", available: true }, adapter.parseCanvasRoute(`${ORIGIN}/`)), false);
    assert.equal(adapter.routeMatches({ id: "history", href: "javascript:void(0)", available: true }, adapter.parseCanvasRoute(`${ORIGIN}/users/self/history`)), false);
    assert.equal(adapter.routeMatches({ id: "help", href: `${ORIGIN}/help`, available: false }, adapter.parseCanvasRoute(`${ORIGIN}/help`)), false);
});

test("keeps unread counts and nullable identity fallbacks", () => {
    const pages = adapter.discoverPages({ document: documentWithPages(), location: { origin: ORIGIN, pathname: "/" }, unread: { count: 9, categories: { conversations: 7 } } });
    assert.equal(pages.find((page) => page.id === "inbox").unread, 4, "DOM count is preferred when present");
    const identityRecord = adapter.discoverIdentity({ document: documentWithPages({ includeIdentity: false }), location: { origin: ORIGIN, pathname: "/" }, apiUser: { id: "123", name: "Student", avatar_url: "http://unsafe/avatar.png" } });
    assert.equal(identityRecord.institution.markUrl, null);
    assert.equal(identityRecord.user.avatarUrl, null);
    assert.equal(identityRecord.user.name, "Student");
    assert.equal(identityRecord.origin, ORIGIN);
});

test("discovers the institution logomark from an image or a declared CSS background", () => {
    const imaged = adapter.discoverIdentity({ document: documentWithPages(), location: { origin: ORIGIN, pathname: "/" }, apiUser: { id: "123", name: "Student" } });
    assert.equal(imaged.institutionMarkUrl, `${ORIGIN}/logo.png`);
    assert.equal(imaged.institutionName, "Emory University");

    const html = new Node("html");
    const nav = new Node("nav", { id: "global_nav" });
    const logo = new Node("div", { class: "ic-app-header__logomark", title: "Emory Canvas" });
    logo.style = { backgroundImage: `url("${ORIGIN}/brand/mark.png")` };
    nav.appendChild(logo);
    html.appendChild(nav);
    const background = adapter.discoverIdentity({
        document: { querySelector: (selector) => html.querySelector(selector), querySelectorAll: (selector) => html.querySelectorAll(selector) },
        location: { origin: ORIGIN, pathname: "/" },
        apiUser: null
    });
    assert.equal(background.institutionMarkUrl, `${ORIGIN}/brand/mark.png`);
    assert.equal(background.institutionName, "Emory Canvas");
});

test("filters courses by active published state, independent of favorites, and verifies href/color/order", () => {
    const raw = [
        { id: "42", name: "Active unfavorited", workflow_state: "available", favorite: false, course_color: "#123456" },
        { id: 43, name: "Concluded", workflow_state: "completed", favorite: true },
        { id: 44, name: "Unpublished", workflow_state: "unpublished", favorite: true },
        { id: 45, name: "Active", workflow_state: "available", enrollments: [{ enrollment_state: "active" }] },
        { id: 46, name: "Completed enrollment", workflow_state: "available", enrollments: [{ enrollment_state: "completed" }] }
    ];
    const courses = raw.map((course, index) => adapter.normalizeCourse(course, { origin: ORIGIN, sourceOrder: index })).filter(Boolean);
    assert.deepEqual(courses.map((course) => course.id), ["42", "45"]);
    assert.equal(courses[0].href, `${ORIGIN}/courses/42`);
    assert.equal(courses[0].color, "#123456");
    assert.equal(courses[0].sourceOrder, 0);
    assert.equal(courses[0].available, true);
});

test("fails closed for explicit course availability and enrollment states while tolerating API omissions", () => {
    const candidates = [
        { id: 1, name: "Unavailable", available: false },
        { id: 2, name: "Unpublished", published: false },
        { id: 3, name: "Concluded", concluded: true },
        { id: 4, name: "No active enrollment", enrollments: [] },
        { id: 5, name: "Completed", enrollments: [{ enrollment_state: "completed" }] },
        { id: 6, name: "Omitted Canvas fields" }
    ];
    assert.deepEqual(
        candidates.map((course) => adapter.normalizeCourse(course, { origin: ORIGIN })).filter(Boolean).map((course) => course.id),
        ["6"]
    );
});

test("uses only currently visible Canvas dashboard cards for the immediate course paint", () => {
    const visible = adapter.discoverDashboardCourses({ document: documentWithDashboardCourses(), location: { origin: ORIGIN, pathname: "/" } });
    assert.deepEqual(visible.map((course) => course.id), ["42", "43"]);
    const filtered = adapter.discoverDashboardCourses({ document: documentWithDashboardCourses({ hidden: true }), location: { origin: ORIGIN, pathname: "/" } });
    assert.deepEqual(filtered.map((course) => course.id), ["42"]);
    assert.deepEqual(adapter.discoverDashboardCourses({ document: documentWithDashboardCourses(), location: { origin: ORIGIN, pathname: "/courses/42" } }), []);
});

test("returns only verified Canvas course tabs and leaves navigation failures retryable", async () => {
    const tabs = await adapter.getCourseNavigation({
        course: { id: 42 },
        origin: ORIGIN,
        tabs: [
            { id: "assignments", label: "Assignments", html_url: `${ORIGIN}/courses/42/assignments` },
            { id: "external", label: "External", html_url: "https://evil.example/courses/42/external" },
            { id: "hidden", label: "Hidden", html_url: `${ORIGIN}/courses/42/hidden`, visibility: "hidden" }
        ]
    });
    assert.equal(tabs.available, true);
    assert.deepEqual(tabs.tabs.map((tab) => tab.id), ["assignments"]);
    assert.equal(tabs.tabs[0].disclosure, true);
    await assert.rejects(
        adapter.getCourseNavigation({ courseId: 42, origin: ORIGIN, fetchImpl: async () => response({ malformed: true }) }),
        /course navigation response is not an array/
    );
});

test("propagates AbortError from identity, unread, course, and tab requests", async () => {
    const abort = new DOMException("The operation was aborted", "AbortError");
    const fetchImpl = async () => { throw abort; };
    const signal = new AbortController().signal;
    await assert.rejects(adapter.fetchCurrentUser({ fetchImpl, origin: ORIGIN, signal }), (error) => error === abort);
    await assert.rejects(adapter.fetchUnread({ fetchImpl, origin: ORIGIN, signal }), (error) => error === abort);
    await assert.rejects(adapter.fetchCourseNavigation({ fetchImpl, origin: ORIGIN, courseId: 42, signal }), (error) => error === abort);
    await assert.rejects(adapter.getCourseNavigation({ fetchImpl, origin: ORIGIN, courseId: 42, signal }), (error) => error === abort);
});

test("fetches paginated courses and fails safely on API or pagination errors", async () => {
    const calls = [];
    const fetchImpl = async (url) => {
        calls.push(url);
        if (calls.length === 1) return response([{ id: 1, name: "First", workflow_state: "available" }], { Link: `<${ORIGIN}/api/v1/courses?page=2&per_page=100>; rel="next"` });
        return response([{ id: 2, name: "Second", workflow_state: "available" }]);
    };
    const courses = await adapter.fetchCourses({ fetchImpl, origin: ORIGIN });
    assert.deepEqual(courses.map((course) => course.id), ["1", "2"]);
    assert.equal(calls.length, 2);
    const failed = await adapter.fetchCourses({ fetchImpl: async () => response({ malformed: true }), origin: ORIGIN });
    assert.deepEqual(failed, []);
    const badPagination = await adapter.fetchCourses({
        fetchImpl: async () => response([{ id: 1, name: "First", workflow_state: "available" }], { Link: `<https://evil.example/api/v1/courses?page=2>; rel="next"` }),
        origin: ORIGIN
    });
    assert.deepEqual(badPagination, []);
});

test("publishes the first verified course page before later pagination completes", async () => {
    let releaseSecondPage;
    const updates = [];
    const loading = adapter.fetchCoursesState({
        origin: ORIGIN,
        onProgress: (state) => updates.push(state.courses.map((course) => course.id)),
        fetchImpl: async (url) => {
            if (new URL(url).searchParams.get("page") === "2") {
                return new Promise((resolve) => { releaseSecondPage = () => resolve(response([{ id: 2, name: "Second", workflow_state: "available" }])); });
            }
            return response([{ id: 1, name: "First", workflow_state: "available" }], { Link: `<${ORIGIN}/api/v1/courses?page=2&per_page=100>; rel="next"` });
        }
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(updates, [["1"]]);
    releaseSecondPage();
    const result = await loading;
    assert.deepEqual(result.courses.map((course) => course.id), ["1", "2"]);
    assert.deepEqual(updates, [["1"], ["1", "2"]]);
});

test("loads active, available courses directly so hidden favorites never reach the rail", async () => {
    const calls = [];
    const result = await adapter.fetchCoursesState({
        origin: ORIGIN,
        fetchImpl: async (url) => {
            calls.push(url);
            const parsed = new URL(url);
            assert.equal(parsed.pathname, "/api/v1/courses");
            assert.equal(parsed.searchParams.get("enrollment_state"), "active");
            assert.deepEqual(parsed.searchParams.getAll("state[]"), ["available"]);
            return response([
                { id: 11, name: "Current Chemistry", workflow_state: "available", enrollments: [] },
                { id: 12, name: "Hidden favorite", workflow_state: "available", enrollment_state: "completed", enrollments: [] },
                { id: 13, name: "Concluded favorite", workflow_state: "completed", enrollments: [] }
            ]);
        }
    });
    assert.equal(result.status, "populated");
    assert.deepEqual(result.courses.map((course) => course.id), ["11"]);
    assert.equal(calls.length, 1);
});

test("course collection state distinguishes populated, successful empty, and retryable failure", async () => {
    const populated = await adapter.fetchCoursesState({
        origin: ORIGIN,
        fetchImpl: async () => response([{ id: 7, name: "Biology", workflow_state: "available", enrollments: [] }])
    });
    assert.equal(populated.status, "populated");
    assert.deepEqual(populated.courses.map((course) => course.id), ["7"]);
    assert.equal(populated.retryable, false);

    const empty = await adapter.fetchCoursesState({ origin: ORIGIN, fetchImpl: async () => response([]) });
    assert.deepEqual(empty, { status: "empty", courses: [], retryable: false, reason: null });

    const failed = await adapter.fetchCoursesState({ origin: ORIGIN, fetchImpl: async () => response({ malformed: true }) });
    assert.deepEqual(failed, { status: "error", courses: [], retryable: true, reason: "request-failed" });
});

test("trusts the server-filtered active-course request without trusting explicit course-level inactive state", async () => {
    const courses = await adapter.fetchCourses({
        origin: ORIGIN,
        fetchImpl: async (url) => {
            const parsed = new URL(url);
            assert.equal(parsed.pathname, "/api/v1/courses");
            assert.equal(parsed.searchParams.get("enrollment_state"), "active");
            assert.deepEqual(parsed.searchParams.getAll("state[]"), ["available"]);
            return response([
                { id: 1, name: "Server-filtered active", workflow_state: "available", enrollments: [] },
                { id: 2, name: "Explicitly completed", workflow_state: "available", enrollment_state: "completed", enrollments: [] },
                { id: 3, name: "Concluded", workflow_state: "completed", enrollments: [] },
                { id: 4, name: "Explicitly unpublished", published: false, enrollments: [] }
            ]);
        }
    });
    assert.deepEqual(courses.map((course) => course.id), ["1"]);
});

test("assembles the real async Canvas course response path from a top-level array", async () => {
    const requests = [];
    const result = await adapter.assembleSidebarModel({
        document: documentWithPages(),
        location: { origin: ORIGIN, pathname: "/" },
        apiUser: { id: "123", name: "Student" },
        unread: {},
        fetchImpl: async (url) => {
            requests.push(url);
            return response([{ id: 42, name: "Current course", workflow_state: "available", enrollments: [] }]);
        }
    });
    assert.deepEqual(result.courses.map((course) => course.id), ["42"]);
    assert.deepEqual(result.courseState, { status: "populated", retryable: false, reason: null });
    assert.deepEqual(requests.map((url) => new URL(url).pathname).sort(), ["/api/v1/courses"], "the broad dashboard_cards menu endpoint is not consulted as card evidence");
});

test("discovery excludes cards hidden inline, by attribute, by class, and by known hidden course ids", () => {
    const html = new Node("html");
    const container = new Node("div", { id: "DashboardCard_Container" });
    const card = (id, name, extraAttributes = {}, extraStyle = {}) => {
        const wrapper = new Node("div", { class: "ic-DashboardCard", ...extraAttributes });
        wrapper.style = { ...wrapper.style, ...extraStyle };
        wrapper.appendChild(new Node("a", { href: `/courses/${id}`, class: "ic-DashboardCard__link" }, name));
        container.appendChild(wrapper);
        return wrapper;
    };
    card("42", "Biology");
    card("43", "Inline-hidden Chemistry", {}, { display: "none" });
    card("44", "Attribute-hidden Statistics", { hidden: "hidden" });
    card("45", "Class-hidden History", { class: "ic-DashboardCard is-hidden" });
    card("46", "Custom-card hidden lab", {}, { display: "none" });
    card("47", "Aria-hidden elective", { "aria-hidden": "true" });
    html.appendChild(container);
    const document = { querySelector: (selector) => html.querySelector(selector), querySelectorAll: (selector) => html.querySelectorAll(selector) };
    const discovered = adapter.discoverDashboardCourses({ document, location: { origin: ORIGIN, pathname: "/" } });
    assert.deepEqual(discovered.map((course) => course.id), ["42"]);
    // The extension's own card customization (custom_cards hidden flag) can
    // also be excluded by id before its inline style ever lands.
    const fresh = new Node("html");
    const freshContainer = new Node("div", { id: "DashboardCard_Container" });
    const rendered = (id, name) => {
        const wrapper = new Node("div", { class: "ic-DashboardCard" });
        wrapper.appendChild(new Node("a", { href: `/courses/${id}`, class: "ic-DashboardCard__link" }, name));
        freshContainer.appendChild(wrapper);
    };
    rendered("42", "Biology");
    rendered("46", "Custom-card hidden lab");
    fresh.appendChild(freshContainer);
    const withHiddenIds = adapter.discoverDashboardCourses({
        document: { querySelector: (selector) => fresh.querySelector(selector), querySelectorAll: (selector) => fresh.querySelectorAll(selector) },
        location: { origin: ORIGIN, pathname: "/" },
        hiddenCourseIds: ["46"]
    });
    assert.deepEqual(withHiddenIds.map((course) => course.id), ["42"], "known hidden course ids are excluded even while still rendered");
});

test("assembly without authoritative displayed-card evidence falls open instead of emptying the rail", async () => {
    const courses = await adapter.assembleSidebarModel({
        document: documentWithPages(),
        location: { origin: ORIGIN, pathname: "/courses/42" },
        apiUser: { id: "123", name: "Student" },
        unread: {},
        fetchImpl: async (url) => response([
            { id: 42, name: "Biology", workflow_state: "available" },
            { id: 43, name: "Chemistry", workflow_state: "available" }
        ])
    });
    assert.deepEqual(courses.courses.map((course) => course.id), ["42", "43"], "no displayed evidence keeps every active course");
    assert.equal(courses.displayedCardSource, "none");
});

test("assembled courses mirror the displayed dashboard card set from the page DOM", async () => {
    const document = documentWithDashboardCourses({ hidden: true });
    const result = await adapter.assembleSidebarModel({
        document,
        location: { origin: ORIGIN, pathname: "/" },
        apiUser: { id: "123", name: "Student" },
        unread: {},
        fetchImpl: async (url) => response([
            { id: 42, name: "Biology", workflow_state: "available" },
            { id: 43, name: "Hidden Chemistry", workflow_state: "available" },
            { id: 44, name: "Statistics", workflow_state: "available" }
        ])
    });
    // The DOM renders Biology only (Hidden Chemistry carries is-hidden); the
    // displayed set — never the broader enrollment list — decides the rail.
    assert.deepEqual(result.courses.map((course) => course.id), ["42"]);
    assert.deepEqual(result.displayedCardIds, ["42"]);
    assert.equal(result.displayedCardSource, "dom");
    assert.equal(result.courseState.status, "populated");
});

test("twelve active enrollments collapse to the eight cards the dashboard displays", async () => {
    const activeCourses = Array.from({ length: 12 }, (_, index) => ({
        id: 100 + index,
        name: `Course ${index + 1}`,
        workflow_state: "available"
    }));
    const document = (() => {
        const base = documentWithPages();
        const html = new Node("div");
        const cards = new Node("div", { id: "DashboardCard_Container" });
        // The dashboard renders 8 of the 12 active enrollments; the remaining
        // four are unpublished/hidden and never produce card nodes.
        for (let index = 0; index < 8; index += 1) {
            const card = new Node("div", { class: "ic-DashboardCard" });
            card.appendChild(new Node("a", { href: `/courses/${100 + index}`, class: "ic-DashboardCard__link" }, `Course ${index + 1}`));
            cards.appendChild(card);
        }
        html.appendChild(cards);
        return {
            querySelector: (selector) => html.querySelector(selector) || base.querySelector(selector),
            querySelectorAll: (selector) => [...base.querySelectorAll(selector), ...html.querySelectorAll(selector)]
        };
    })();
    const result = await adapter.assembleSidebarModel({
        document,
        location: { origin: ORIGIN, pathname: "/" },
        apiUser: { id: "123", name: "Student" },
        unread: {},
        fetchImpl: async (url) => response(activeCourses)
    });
    assert.equal(result.courseState.status, "populated");
    assert.deepEqual(result.displayedCardIds, activeCourses.slice(0, 8).map((course) => String(course.id)));
    assert.equal(result.displayedCardSource, "dom");
    assert.deepEqual(
        result.courses.map((course) => course.id),
        ["100", "101", "102", "103", "104", "105", "106", "107"],
        "the rail shows the 8 displayed cards, never the 12-row active enrollment ceiling"
    );
});

test("a displayed-card store keeps off-dashboard pages mirroring the last displayed set", async () => {
    const storeWrites = [];
    const dashboard = await adapter.assembleSidebarModel({
        document: documentWithDashboardCourses(),
        location: { origin: ORIGIN, pathname: "/" },
        apiUser: { id: "123", name: "Student" },
        unread: {},
        displayedCardStore: { read: async () => null, write: async (entry) => { storeWrites.push(entry); return true; } },
        fetchImpl: async (url) => response([
            { id: 42, name: "Biology", workflow_state: "available" },
            { id: 43, name: "Hidden Chemistry", workflow_state: "available" }
        ])
    });
    assert.deepEqual(dashboard.courses.map((course) => course.id), ["42", "43"]);
    assert.equal(storeWrites.length, 1);
    assert.deepEqual(storeWrites[0].courseIds, ["42", "43"]);
    const offDashboard = await adapter.assembleSidebarModel({
        document: documentWithPages(),
        location: { origin: ORIGIN, pathname: "/courses/42" },
        apiUser: { id: "123", name: "Student" },
        unread: {},
        displayedCardStore: { read: async () => ({ courseIds: ["42"], savedAt: Date.now() }), write: async () => true },
        fetchImpl: async (url) => response([
            { id: 42, name: "Biology", workflow_state: "available" },
            { id: 43, name: "Hidden Chemistry", workflow_state: "available" }
        ])
    });
    assert.deepEqual(offDashboard.courses.map((course) => course.id), ["42"], "the persisted displayed subset outranks the active list off-dashboard");
    assert.equal(offDashboard.displayedCardSource, "cache");
    const brokenStore = await adapter.assembleSidebarModel({
        document: documentWithPages(),
        location: { origin: ORIGIN, pathname: "/courses/42" },
        apiUser: { id: "123", name: "Student" },
        unread: {},
        displayedCardStore: { read: async () => { throw new Error("storage unavailable"); }, write: async () => false },
        fetchImpl: async (url) => response([{ id: 42, name: "Biology", workflow_state: "available" }])
    });
    assert.deepEqual(brokenStore.courses.map((course) => course.id), ["42"], "a failing cache reads as no evidence and falls open");
});

test("assembled courses exclude enrollments outside the authoritative displayed-card evidence", async () => {
    const pinned = await adapter.assembleSidebarModel({
        document: documentWithPages(),
        location: { origin: ORIGIN, pathname: "/" },
        apiUser: { id: "123", name: "Student" },
        unread: {},
        dashboardCards: [{ id: 99 }],
        courses: [{ id: 42, name: "Biology", workflow_state: "available" }]
    });
    assert.deepEqual(pinned.courses, []);
    assert.equal(pinned.displayedCardSource, "pinned");
    const emptyCardSet = await adapter.assembleSidebarModel({
        document: documentWithPages(),
        location: { origin: ORIGIN, pathname: "/" },
        apiUser: { id: "123", name: "Student" },
        unread: {},
        dashboardCards: [],
        courses: [{ id: 42, name: "Biology", workflow_state: "available" }]
    });
    assert.deepEqual(emptyCardSet.courses.map((course) => course.id), ["42"], "an empty pinned set is a safe fallback, not a hidden set");
    const filtered = adapter.filterCoursesToDashboardCards([{ id: "42" }, { id: "43" }], ["42", "42", "44"]);
    assert.deepEqual(filtered.map((course) => course.id), ["42"]);
});

test("an eight-card dashboard with twelve active enrollments assembles exactly the displayed eight", async () => {
    // Luna's live failure: 12 active enrollments, 8 cards on screen, 4 of them
    // hidden client-side by the extension's own card customization (inline
    // display:none) — the rail must list the displayed 8, not the enrolled 12.
    const html = new Node("html");
    const container = new Node("div", { id: "DashboardCard_Container" });
    const displayedIds = [101, 102, 103, 104, 105, 106, 107, 108];
    const hiddenIds = [109, 110, 111, 112];
    const card = (id, name, style = {}) => {
        const wrapper = new Node("div", { class: "ic-DashboardCard" });
        wrapper.style = { ...style };
        wrapper.appendChild(new Node("a", { href: `/courses/${id}`, class: "ic-DashboardCard__link" }, name));
        container.appendChild(wrapper);
    };
    displayedIds.forEach((id, index) => card(id, `Course ${id}`, {}));
    hiddenIds.forEach((id) => card(id, `Hidden course ${id}`, { display: "none" }));
    html.appendChild(container);
    const document = { querySelector: (selector) => html.querySelector(selector), querySelectorAll: (selector) => html.querySelectorAll(selector) };
    const activeCourses = [...displayedIds, ...hiddenIds].map((id) => ({ id, name: `Course ${id}`, workflow_state: "available" }));
    const result = await adapter.assembleSidebarModel({
        document,
        location: { origin: ORIGIN, pathname: "/" },
        apiUser: { id: "123", name: "Student" },
        unread: {},
        displayedCardStore: { read: async () => null, write: async () => true },
        fetchImpl: async (url) => response(activeCourses)
    });
    assert.equal(activeCourses.length, 12);
    assert.deepEqual(result.courses.map((course) => course.id), displayedIds.map(String), "the rail mirrors the eight rendered cards");
    assert.equal(result.displayedCardSource, "dom");
    assert.equal(result.courseState.status, "populated");
});

test("starts active-course discovery before identity and unread requests have settled", async () => {
    let releaseUser;
    let courseRequested = false;
    let unreadRequested = false;
    const assembling = adapter.assembleSidebarModel({
        document: documentWithPages(),
        location: { origin: ORIGIN, pathname: "/" },
        fetchImpl: async (url) => {
            const pathname = new URL(url).pathname;
            if (pathname === "/api/v1/users/self") {
                return new Promise((resolve) => { releaseUser = resolve; });
            }
            if (pathname === "/api/v1/courses") {
                courseRequested = true;
                return response([{ id: 42, name: "Current course", workflow_state: "available" }]);
            }
            if (pathname === "/api/v1/conversations/unread_count") {
                unreadRequested = true;
                return response({});
            }
            throw new Error(`Unexpected Canvas path: ${pathname}`);
        }
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(courseRequested, true);
    assert.equal(unreadRequested, true);
    releaseUser(response({ id: "123", name: "Student" }));
    const result = await assembling;
    assert.deepEqual(result.courses.map((course) => course.id), ["42"]);
});

test("reports courses before delayed identity resolution completes", async () => {
    let releaseUser;
    const updates = [];
    const assembling = adapter.assembleSidebarModel({
        document: documentWithPages(),
        location: { origin: ORIGIN, pathname: "/" },
        onCourses: (state) => updates.push(state.courses.map((course) => course.id)),
        fetchImpl: async (url) => {
            const pathname = new URL(url).pathname;
            if (pathname === "/api/v1/users/self") return new Promise((resolve) => { releaseUser = resolve; });
            if (pathname === "/api/v1/courses") return response([{ id: 42, name: "Current course", workflow_state: "available" }]);
            if (pathname === "/api/v1/conversations/unread_count") return response({});
            throw new Error(`Unexpected Canvas path: ${pathname}`);
        }
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(updates, [["42"]]);
    releaseUser(response({ id: "123", name: "Student" }));
    await assembling;
});

test("reports visible dashboard cards before the Canvas course request resolves", async () => {
    let releaseCourses;
    const updates = [];
    const assembling = adapter.assembleSidebarModel({
        document: documentWithDashboardCourses({ hidden: true }),
        location: { origin: ORIGIN, pathname: "/" },
        apiUser: { id: "123", name: "Student" },
        unread: {},
        onCourses: (state) => updates.push(state.courses.map((course) => course.id)),
        fetchImpl: async (url) => {
            if (new URL(url).pathname !== "/api/v1/courses") throw new Error("Unexpected request");
            return new Promise((resolve) => { releaseCourses = () => resolve(response([{ id: 42, name: "Biology", workflow_state: "available" }])); });
        }
    });
    assert.deepEqual(updates, [["42"]]);
    releaseCourses();
    await assembling;
});

test("assembles identity, account key, pages, courses, and preserves account switching output", async () => {
    const first = await adapter.assembleSidebarModel({
        document: documentWithPages(),
        location: { origin: ORIGIN, pathname: "/courses/42" },
        apiUser: { id: "123", name: "Student", avatar_url: "https://cdn.example/avatar.png" },
        courses: [{ id: 42, name: "Current", workflow_state: "available" }],
        savedCourseOrder: ["42"]
    });
    const second = await adapter.assembleSidebarModel({
        document: documentWithPages(),
        location: { origin: ORIGIN, pathname: "/courses/42" },
        apiUser: { id: "124", name: "Other Student", avatar_url: "https://cdn.example/avatar-2.png" },
        courses: [{ id: 42, name: "Current", workflow_state: "available" }]
    });
    assert.equal(first.identity.userId, "123");
    assert.equal(second.identity.userId, "124");
    assert.notEqual(first.account.accountKey, second.account.accountKey);
    assert.equal(first.courses[0].href, `${ORIGIN}/courses/42`);
    assert.equal(first.route.courseId, "42");
    assert.equal(first.pages.find((page) => page.id === "courses").available, true);
    assert.equal(first.account.accountKey, await identity.accountKey({ origin: ORIGIN, userId: "123" }));
});

test("rejects a caller-supplied account key that is not the identity-derived opaque key", async () => {
    const result = await adapter.assembleSidebarModel({
        document: documentWithPages(),
        location: { origin: ORIGIN, pathname: "/" },
        apiUser: { id: "123", name: "Student" },
        accountKey: "a".repeat(64),
        courses: [{ id: 42, name: "Current" }]
    });
    assert.equal(result.account.accountKey, null);
});
