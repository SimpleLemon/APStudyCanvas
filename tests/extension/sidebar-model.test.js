"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const model = require("../../js/content/sidebar-model.js");

test("raw-presence-aware width resolution distinguishes missing, explicit, and invalid values", () => {
    const missing = {};
    const resolvedMissing = model.resolveSidebarWidths(missing);
    assert.deepEqual(resolvedMissing.expanded, 180);
    assert.deepEqual(resolvedMissing.collapsed, 86);
    assert.deepEqual(resolvedMissing.presence, { expanded: false, collapsed: false });
    assert.deepEqual(missing, {});

    const explicit = { sidebar_expanded_width: 280, sidebar_collapsed_width: 56 };
    const resolvedExplicit = model.resolveSidebarWidths(explicit);
    assert.deepEqual(resolvedExplicit.expanded, 280);
    assert.deepEqual(resolvedExplicit.collapsed, 56);
    assert.deepEqual(resolvedExplicit.presence, { expanded: true, collapsed: true });
    assert.deepEqual(explicit, { sidebar_expanded_width: 280, sidebar_collapsed_width: 56 });

    const invalid = { sidebar_expanded_width: "wide", sidebar_collapsed_width: NaN };
    assert.deepEqual(model.resolveSidebarWidths(invalid), {
        expanded: 180,
        collapsed: 86,
        presence: { expanded: true, collapsed: true },
        usedStored: { expanded: false, collapsed: false }
    });
    assert.equal(model.resolveSidebarWidths({ sidebar_expanded_width: 150 }).expanded, 160);
    assert.equal(model.resolveSidebarWidths({ sidebar_expanded_width: 400 }).expanded, 320);
    assert.equal(model.resolveSidebarWidths({ sidebar_collapsed_width: 20 }).collapsed, 48);
    assert.equal(model.resolveSidebarWidths({ sidebar_collapsed_width: 200 }).collapsed, 112);
});

test("canonical sidebar settings normalize legacy density, scale pairs, sections, and accessible names", () => {
    assert.equal(model.normalizeDensity("comfortable"), "cozy");
    assert.equal(model.normalizeDensity("dense"), "compact");
    assert.equal(model.normalizeDensity("unexpected"), "cozy");
    assert.equal(model.normalizePreferredState("hidden"), "expanded");
    assert.equal(model.normalizeAvatarSize("small"), "small");
    assert.equal(model.normalizeAvatarSize("huge"), "medium");
    assert.equal(model.normalizeAvatarSize(undefined), "medium");

    const values = model.normalizeSidebarSettings({
        better_sidebar: true,
        sidebar_density: "comfortable",
        sidebar_icon_size: 24,
        sidebar_label_size: 16,
        sidebar_avatar_size: "large",
        sidebar_collapsed_labels: false,
        sidebar_pages_visible_expanded: false,
        sidebar_courses_visible_collapsed: true,
        sidebar_section_visibility: { expanded: { pages: false, courses: false }, collapsed: { pages: false, courses: false } },
        sidebar_pages_folded: true,
        sidebar_accessibility_labels: false,
        sidebar_preferred_state: "collapsed"
    });
    assert.equal(values.enabled, true);
    assert.equal(values.density, "cozy");
    assert.equal(values.scale, "extra-large");
    assert.deepEqual(values.scaleValues, { icon: 21, label: 18 });
    assert.equal(values.avatarSize, "large");
    assert.equal(values.collapsedLabels, false);
    assert.deepEqual(values.sectionVisibility, {
        expanded: { pages: false, courses: true },
        collapsed: { pages: true, courses: true }
    });
    assert.deepEqual(values.sectionFolded, { pages: true, courses: false });
    assert.equal(values.preferredState, "collapsed");
    assert.equal(values.accessibleNames, true);
    assert.equal(Object.prototype.hasOwnProperty.call(values, "runtimeState"), false);
});

test("runtime state uses enter and exit hysteresis while keeping hidden transient", () => {
    assert.equal(model.deriveRuntimeState({ enabled: false, preferredState: "expanded", availableWidth: 100 }), "native");
    assert.equal(model.deriveRuntimeState({ enabled: true, preferredState: "expanded", availableWidth: 639 }), "hidden");
    assert.equal(model.deriveRuntimeState({ enabled: true, preferredState: "expanded", availableWidth: 640 }), "expanded");
    assert.equal(model.deriveRuntimeState({ enabled: true, preferredState: "collapsed", availableWidth: 639 }), "hidden");
    assert.equal(model.deriveRuntimeState({ enabled: true, preferredState: "collapsed", currentState: "hidden", availableWidth: 687 }), "hidden");
    assert.equal(model.deriveRuntimeState({ enabled: true, preferredState: "collapsed", currentState: "hidden", availableWidth: 688 }), "collapsed");
    assert.equal(model.deriveRuntimeState({ enabled: true, preferredState: "expanded", currentState: "collapsed", availableWidth: 700 }), "collapsed");
    assert.equal(model.deriveRuntimeState({ enabled: true, preferredState: "expanded", currentState: "hidden", availableWidth: 700 }), "expanded");
});

test("page reconciliation separates visibility and retains unknown IDs after known pages", () => {
    const knownPages = [
        { id: "dashboard", label: "Dashboard" },
        { id: "calendar", label: "Calendar" },
        { id: "nest:study", label: "Study" }
    ];
    const result = model.reconcileSidebarPages({
        knownPages,
        savedOrder: ["unknown:page", "calendar", "dashboard", "nest:study"],
        savedVisibility: { dashboard: false, "unknown:page": false }
    });
    assert.deepEqual(result.order, ["calendar", "dashboard", "nest:study", "unknown:page"]);
    assert.equal(result.visibility.dashboard, false);
    assert.equal(result.visibility["unknown:page"], false);
    assert.deepEqual(result.unknownIds, ["unknown:page"]);
    assert.deepEqual(result.pages.map((page) => page.id), ["calendar", "dashboard", "nest:study", "unknown:page"]);
    assert.equal(result.pages.at(-1).transportable, true);
    assert.equal(result.pages.at(-1).available, false);
});

test("saved page settings append the canonical APStudy actions without changing saved native order", () => {
    const result = model.reconcileSidebarPages({
        knownPages: [
            { id: "dashboard", label: "Dashboard" }, { id: "courses", label: "Courses" }, { id: "calendar", label: "Calendar" },
            { id: "inbox", label: "Inbox" }, { id: "history", label: "History" }, { id: "help", label: "Help" },
            { id: "apstudy:planner", label: "Planner", action: "planner" }, { id: "apstudy:notes", label: "Notes", action: "notes" },
            { id: "apstudy:grades", label: "Grades", action: "grades" }, { id: "apstudy:study", label: "Study", action: "study" }
        ],
        savedOrder: ["courses", "dashboard", "calendar", "inbox", "history", "help"],
        savedVisibility: { dashboard: false }
    });
    assert.deepEqual(result.order, ["courses", "dashboard", "calendar", "inbox", "history", "help", "apstudy:planner", "apstudy:notes", "apstudy:grades", "apstudy:study"]);
    assert.equal(result.visibility.dashboard, false);
    ["apstudy:planner", "apstudy:notes", "apstudy:grades", "apstudy:study"].forEach((id) => assert.equal(result.visibility[id], true));
});

test("course reconciliation preserves saved survivors and appends new source courses", () => {
    const result = model.reconcileSidebarCourses({
        courses: [{ id: 12, name: "New source order" }, { id: 7, name: "Saved first" }, { id: 20, name: "New last" }],
        savedOrder: [7, 999, 12]
    });
    assert.deepEqual(result.order, ["7", "12", "20"]);
    assert.deepEqual(result.courses.map((course) => course.id), ["7", "12", "20"]);
    assert.equal(result.courses[0].name, "Saved first");
});

test("course order keys accept only opaque Canvas account keys", () => {
    const first = model.courseOrderStorageKey("a".repeat(64));
    const equivalent = model.buildCourseOrderStorageKey("A".repeat(64));
    const otherAccount = model.courseOrderStorageKey("b".repeat(64));
    assert.equal(first, equivalent);
    assert.notEqual(first, otherAccount);
    assert.match(first, /^apstudycanvas\.sidebar\.course-order\.v1:[a-f0-9]{64}$/);
    assert.equal(first.includes("999"), false);
    assert.equal(model.courseOrderStorageKey({ origin: "https://canvas.emory.edu", userId: 42 }), null);
    assert.equal(model.courseOrderStorageKey("https://canvas.emory.edu"), null);
    assert.equal(model.courseOrderStorageKey("4".repeat(63)), null);
});

test("shared course colors resolve deterministically, avoid collisions, and honor authoritative hex", () => {
    const palette = model.FALLBACK_COURSE_PALETTE;
    assert.ok(Array.isArray(palette) && palette.length >= 12, "the shared fallback palette covers a typical course load");
    const spread = Array.from({ length: palette.length }, (_, index) => ({ id: String(index + 1), name: `Course ${index + 1}` }));
    const spreadColors = model.resolveCourseColors(spread);
    assert.equal(new Set(spreadColors).size, spread.length, "a full palette of displayed courses stays distinct");
    const courses = [
        { id: "7", name: "Biology" },
        { id: "9", name: "Chemistry" },
        { id: "12", name: "History" },
        { id: "18", name: "Studio", color: "#008400" }
    ];
    const first = model.resolveCourseColors(courses);
    assert.equal(first.length, courses.length);
    assert.ok(first.every((color) => /^#[0-9a-f]{3,8}$/.test(color)), "every course resolves to usable hex");
    assert.equal(first[3], "#008400", "authoritative Canvas colors win verbatim");
    assert.equal(new Set(first).size, first.length, "displayed fallbacks stay distinct");
    assert.deepEqual(model.resolveCourseColors(courses.slice().reverse()).length, first.length);
    const byId = new Map(courses.map((course, index) => [course.id, first[index]]));
    const reversed = courses.slice().reverse();
    model.resolveCourseColors(reversed).forEach((color, index) => {
        assert.equal(color, byId.get(reversed[index].id), "arrival order cannot change a course color");
    });
    const duplicate = model.resolveCourseColors([
        { id: "21", name: "One", color: "#b3261e" },
        { id: "22", name: "Two", color: "#b3261e" },
        { id: "23", name: "Three" }
    ]);
    assert.equal(duplicate[0], "#b3261e");
    assert.equal(duplicate[1], "#b3261e", "user-assigned duplicate colors are allowed");
    assert.notEqual(duplicate[2], "#b3261e", "a fallback never reuses an authoritative color");
});

test("courses default visible in the compact rail", () => {
    const values = model.normalizeSidebarSettings({ better_sidebar: true, sidebar_preferred_state: "collapsed" });
    assert.deepEqual(values.sectionVisibility.collapsed, { pages: true, courses: true });
});
