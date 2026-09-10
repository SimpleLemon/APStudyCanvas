"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const schema = require("../../js/settings-schema.js");
const popup = require("../../js/popup-controller.js");

const ACCOUNT_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

test("per-account opt-in is local-only, default-isolated, and excluded from reset/import", () => {
    const first = schema.defaultsForArea("local");
    first.canvas_sync_opt_in[ACCOUNT_KEY] = true;
    assert.deepEqual(schema.defaultsForArea("local").canvas_sync_opt_in, {});
    assert.equal(Object.prototype.hasOwnProperty.call(schema.defaultsForArea("sync"), "canvas_sync_opt_in"), false);
    assert.equal(schema.knownResettableKeys.includes("canvas_sync_opt_in"), false);
    assert.equal(popup.validateImportData({ canvas_sync_opt_in: { [ACCOUNT_KEY]: true } }), false);
});

test("compatibility-only settings remain validated but absent from active schema flows", () => {
    const defaults = schema.defaultsForArea("sync");
    const compatibilityValues = {
        browser_show_likes: true,
        remind: true,
        reminders: [],
        reminder_count: 2,
        multi_remind: true,
        scheduledReminder: true,
        scheduledReminderTime: "09:00",
        block_planner_script: false
    };
    assert.equal(defaults.browser_show_likes, false);
    Object.entries(compatibilityValues).forEach(([key, value]) => {
        assert.equal(schema.compatibilityOnlySyncSettingKeys.includes(key), true, `${key} is compatibility-only`);
        assert.equal(schema.validateSettingValue("sync", key, value).valid, true, `${key} remains readable from old storage`);
        assert.equal(schema.settingKeysForArea("sync").includes(key), false, `${key} is not routed through active settings`);
        assert.equal(schema.exportableSyncSettingKeys.includes(key), false, `${key} is not exported`);
        assert.equal(schema.knownResettableKeys.includes(key), false, `${key} is not reset`);
    });
    assert.equal(schema.exportableSyncSettingKeys.includes("dark_mode"), true, "active settings remain exportable");
    assert.equal(schema.knownResettableKeys.includes("dark_mode"), true, "active settings remain resettable");
});

test("active script blockers remain valid, resettable, and backup-safe", () => {
    for (const key of ["block_tool_scripts", "block_editor_scripts"]) {
        assert.equal(schema.defaultsForArea("sync")[key], false, `${key} is an explicit compatibility opt-in`);
        assert.equal(schema.validateSettingValue("sync", key, false).valid, true, `${key} accepts its active boolean value`);
        assert.equal(schema.validateSettingValue("sync", key, "false").valid, false, `${key} rejects a coerced boolean`);
        assert.equal(schema.settingKeysForArea("sync").includes(key), true, `${key} remains writable through the active settings contract`);
        assert.equal(schema.exportableSyncSettingKeys.includes(key), true, `${key} is included in full settings backups`);
        assert.equal(schema.knownResettableKeys.includes(key), true, `${key} is reset with active settings`);
    }
});

test("per-account opt-in rejects malformed, oversized, and secret-shaped values", () => {
    const oversized = Object.fromEntries(Array.from({ length: schema.CANVAS_SYNC_OPT_IN_MAX_ACCOUNTS + 1 }, (_, index) => [index.toString(16).padStart(64, "0"), true]));
    for (const value of [
        { [ACCOUNT_KEY]: "yes" },
        oversized,
        { "Bearer secret": true },
        { [ACCOUNT_KEY]: true, authorization: false }
    ]) {
        const result = schema.validateSettingValue("local", "canvas_sync_opt_in", value);
        assert.equal(result.valid, false, JSON.stringify(value));
        assert.equal(result.code, "SETTINGS_VALUE_INVALID");
    }
    assert.equal(schema.validateSettingValue("local", "canvas_sync_opt_in", { [ACCOUNT_KEY]: true }).valid, true);
});

test("live-apply classification covers appearance, course cards, themes, and sidebar", () => {
    assert.equal(schema.liveApplyMode("dark_mode"), "live");
    assert.equal(schema.liveApplyMode("dark_preset"), "live");
    assert.equal(schema.liveApplyMode("custom_cards"), "live");
    assert.equal(schema.liveApplyMode("customBackgroundLink"), "live");
    assert.equal(schema.liveApplyMode("better_sidebar"), "live");
    assert.equal(schema.liveApplyMode("gradent_cards"), "live");
    assert.equal(schema.liveApplyGroup("dark_mode"), "appearance");
    assert.equal(schema.liveApplyGroup("condensed_cards"), "course-cards");
    assert.equal(schema.liveApplyGroup("custom_styles"), "themes");
    assert.equal(schema.liveApplyGroup("sidebar_logo_visible"), "sidebar");
    assert.equal(schema.liveApplyGroup("sidebar_avatar_size"), "sidebar");
});

test("owned To-Do layout controls apply live, while script blockers accurately require a refresh", () => {
    for (const key of ["todo_separate_scrollbar", "todo_full_height"]) {
        assert.equal(schema.liveApplyMode(key), "live", `${key} applies on the open Canvas page`);
        assert.equal(schema.liveApplyGroup(key), "study-tools");
        assert.equal(schema.reloadApplyReason(key), null, `${key} must not advertise a false refresh requirement`);
    }
    for (const key of ["block_tool_scripts", "block_editor_scripts"]) {
        assert.equal(schema.liveApplyMode(key), "reload", `${key} affects only subsequently loaded Canvas scripts`);
        assert.match(schema.reloadApplyReason(key), /after this setting changes/);
    }
});

test("Workspace defaults are lazy, strict, and retained by active backup/reset flows", () => {
    const defaults = schema.defaultsForArea("sync");
    assert.equal(defaults.quiz_safe_mode, true);
    assert.equal(defaults.todo_icons_visible, true);
    assert.equal(defaults.todo_course_color_mode, "inherit");
    assert.equal(defaults.customBackgroundOpacity, 100);
    assert.equal(defaults.customBackgroundBlur, 0);
    assert.equal(defaults.cardImageRoundness, 0);
    assert.equal(defaults.cardPadding, 0);
    assert.equal(defaults.assignment_sequence_footer_visible, true);
    assert.equal(defaults.hide_infrastructure_footer, false);
    assert.equal(defaults.local_theme_sort, "name");
    assert.equal(defaults.canvas_search_enabled, false);
    assert.equal(defaults.extension_theme, "canvas");
    assert.equal(defaults.grade_analytics_enabled, false);
    assert.equal(defaults.card_letter_grade_visible, false);
    const workspaceBooleans = [
        "assignment_sequence_footer_visible", "hide_infrastructure_footer", "card_letter_grade_visible", "quiz_safe_mode",
        "canvas_search_enabled", "grade_analytics_enabled", "planner_tasks_enabled"
    ];
    workspaceBooleans.forEach((key) => {
        assert.equal(schema.lazySyncDefaultKeys.includes(key), true, `${key} remains lazy for established profiles`);
        assert.equal(schema.validateSettingValue("sync", key, true).valid, true, `${key} accepts boolean true`);
        assert.equal(schema.validateSettingValue("sync", key, "true").valid, false, `${key} rejects string coercion`);
        assert.equal(schema.exportableSyncSettingKeys.includes(key), true, `${key} remains in full settings backups`);
        assert.equal(schema.knownResettableKeys.includes(key), true, `${key} is reset with active settings`);
    });
    assert.equal(schema.validateSettingValue("sync", "customBackgroundBlur", 99).value, 32);
    assert.equal(schema.validateSettingValue("sync", "cardPadding", -3).value, 0);
    assert.equal(schema.validateSettingValue("sync", "todo_course_color_mode", "neutral").valid, true);
    assert.equal(schema.validateSettingValue("sync", "todo_course_color_mode", "rainbow").valid, false);
    assert.equal(schema.validateSettingValue("sync", "local_theme_sort", "remote").valid, false);
    assert.equal(schema.liveApplyGroup("customBackgroundBlur"), "themes");
    assert.equal(schema.liveApplyGroup("cardPadding"), "course-cards");
});

test("extension chrome can follow Canvas or force an explicit scheme", () => {
    assert.equal(schema.validateSettingValue("sync", "extension_theme", "canvas").valid, true);
    assert.equal(schema.validateSettingValue("sync", "extension_theme", "light").valid, true);
    assert.equal(schema.validateSettingValue("sync", "extension_theme", "dark").valid, true);
    assert.equal(schema.validateSettingValue("sync", "extension_theme", "system").valid, false);
    assert.equal(schema.resolveExtensionTheme({ extension_theme: "light", dark_mode: true }), "light");
    assert.equal(schema.resolveExtensionTheme({ extension_theme: "dark", dark_mode: false }), "dark");
    assert.equal(schema.resolveExtensionTheme({ extension_theme: "canvas", dark_mode: true }), "dark");
    assert.equal(schema.resolveExtensionTheme({ extension_theme: "canvas", dark_mode: false }), "light");
    assert.equal(schema.resolveExtensionTheme({ extension_theme: "canvas", device_dark: true, dark_mode: false }), "system");
    assert.equal(schema.liveApplyGroup("extension_theme"), "appearance");
});

test("Workspace live metadata matches the content-worker application contract", () => {
    assert.equal(schema.liveApplyMode("quiz_safe_mode"), "live");
    assert.equal(schema.liveApplyGroup("quiz_safe_mode"), "appearance");
    assert.equal(schema.liveApplyMode("planner_tasks_enabled"), "live");
    assert.equal(schema.liveApplyGroup("planner_tasks_enabled"), "study-tools");
    for (const key of ["assignment_sequence_footer_visible", "hide_infrastructure_footer", "card_letter_grade_visible"]) {
        assert.equal(schema.liveApplyMode(key), "live", `${key} is claimed by the shared live applicator`);
        assert.equal(schema.liveApplyGroup(key), "appearance");
    }
    for (const key of ["canvas_search_enabled", "grade_analytics_enabled"]) {
        assert.equal(schema.liveApplyMode(key), "live", `${key} is claimed by the shared live applicator`);
        assert.equal(schema.liveApplyGroup(key), "study-tools");
    }
});

test("Phase 1 migration resolves absent values without claiming a storage write", () => {
    const absent = schema.migratePhaseOneSettings({});
    assert.equal(absent.settings.quiz_safe_mode, true);
    assert.equal(absent.settings.canvas_search_enabled, false);
    assert.deepEqual(absent.changes, {});
    const legacy = schema.migratePhaseOneSettings({ quiz_safe: false, todo_hide_icons: true });
    assert.equal(legacy.settings.quiz_safe_mode, false);
    assert.equal(legacy.settings.todo_icons_visible, false);
    const malformed = schema.migratePhaseOneSettings({ customBackgroundOpacity: "opaque", cardPadding: 80 });
    assert.equal(malformed.settings.customBackgroundOpacity, 100);
    assert.equal(malformed.settings.cardPadding, 48);
    assert.deepEqual(malformed.changes, { cardPadding: 48 });
});

test("custom background URLs are HTTPS-only and normalized before storage", () => {
    assert.equal(schema.validateSettingValue("sync", "customBackgroundLink", "https://images.example.test/study%20desk.jpg").value, "https://images.example.test/study%20desk.jpg");
    assert.equal(schema.validateSettingValue("sync", "customBackgroundLink", "").value, "");
    for (const value of ["http://images.example.test/background.jpg", "javascript:alert(1)", "https://user:password@images.example.test/background.jpg"]) {
        assert.equal(schema.validateSettingValue("sync", "customBackgroundLink", value).valid, false, value);
    }
    const escaped = schema.validateSettingValue("sync", "customBackgroundLink", "https://images.example.test/a')}; body { display:none }");
    assert.equal(escaped.valid, true);
    assert.match(escaped.value, /%7D/i, "URL parsing encodes a CSS-closing brace before the content serializer quotes it");
});

test("custom fonts are constrained to packaged faces or system UI", () => {
    assert.deepEqual(schema.normalizeCustomFont({ link: "Newsreader:wght@400;700", family: "'Newsreader'" }), { link: "", family: "Newsreader" });
    assert.deepEqual(schema.normalizeCustomFont({ link: "DM+Sans:wght@400;700", family: "'DM Sans'" }), { link: "", family: "" });
    assert.equal(schema.customFontCssFamily({ family: "IBM Plex Mono" }), '"IBM Plex Mono", ui-monospace, monospace');
    assert.equal(schema.customFontCssFamily({ family: "Remote Family" }), "");
    assert.deepEqual(schema.migrateCustomFont({ link: "https://fonts.example.test/font.css", family: "Public Sans" }), { setting: { link: "", family: "Public Sans" }, changed: true });
    assert.deepEqual(schema.validateSettingValue("sync", "custom_font", { link: "", family: "Public Sans" }), { valid: true, value: { link: "", family: "Public Sans" } });
    assert.equal(schema.validateSettingValue("sync", "custom_font", { link: "", family: "Remote Family" }).valid, false);
});

test("live classification names settings reconciled by their current owners", () => {
    assert.equal(schema.liveApplyMode("assignments_due"), "live");
    assert.equal(schema.liveApplyGroup("assignments_due"), "dashboard");
    assert.equal(schema.liveApplyMode("dashboard_notes"), "live");
    for (const key of [
        "assignment_date_format", "card_overdues", "relative_dues", "num_assignments",
        "dashboard_grades", "grade_hover",
        "gpa_calc", "gpa_calc_prepend", "gpa_calc_weighted", "gpa_calc_cumulative", "gpa_calc_bounds"
    ]) {
        assert.equal(schema.liveApplyMode(key), "live", `${key} is reconciled by the open dashboard`);
        assert.equal(schema.liveApplyGroup(key), "dashboard", `${key} belongs to the dashboard owner`);
        assert.equal(schema.reloadApplyReason(key), null, `${key} must not advertise a reload`);
    }
    assert.equal(schema.liveApplyMode("better_todo"), "live");
    assert.equal(schema.liveApplyMode("custom_domain"), "reload");
    assert.equal(schema.liveApplyMode("saved_themes"), "none");
});

test("legacy mirrors emitted by live To-Do controls never create a false reload notice", () => {
    const examples = {
        todo_enabled: true,
        todo_streak_enabled: true,
        todo_progress_style: "circle",
        todo_celebration: "confetti",
        todo_celebration_intensity: "normal",
        todo_card_max: 4,
        todo_clock_24h: false,
        todo_hover_preview: true
    };
    for (const [key, value] of Object.entries(examples)) {
        assert.equal(schema.liveApplyMode(key), "live", `${key} is live`);
        for (const mirror of Object.keys(schema.todoLegacyCompatibilityChanges(key, value))) {
            assert.equal(schema.liveApplyMode(mirror), "live", `${key} mirror ${mirror} is live too`);
            assert.equal(schema.reloadApplyReason(mirror), null, `${mirror} has no reload copy`);
        }
    }
});

test("owned To-Do feedback visibility has no stale reload reason", () => {
    assert.equal(schema.liveApplyMode("todo_hide_feedback"), "live");
    assert.equal(schema.liveApplyGroup("todo_hide_feedback"), "study-tools");
    assert.equal(schema.reloadApplyReason("todo_hide_feedback"), null);
});

test("sidebar schema ships opt-in canonical defaults without eagerly owning widths", () => {
    const defaults = schema.defaultsForArea("sync");
    assert.equal(defaults.better_sidebar, false);
    assert.equal(defaults.sidebar_expanded_width, 180);
    assert.equal(defaults.sidebar_collapsed_width, 86);
    assert.equal(defaults.sidebar_density, "cozy");
    assert.equal(defaults.sidebar_scale_preset, "medium");
    assert.equal(defaults.sidebar_avatar_size, "medium");
    assert.equal(defaults.sidebar_preferred_state, "expanded");
    assert.equal(defaults.sidebar_pages_visible_expanded, true);
    assert.equal(defaults.sidebar_courses_visible_collapsed, false);
    assert.equal(defaults.sidebar_accessibility_labels, true);
    assert.equal(Object.prototype.hasOwnProperty.call(defaults, "runtime_sidebar_state"), false);
});

test("sidebar schema validates canonical values and accepts legacy density aliases", () => {
    for (const value of ["compact", "cozy", "comfortable", "dense"]) {
        assert.equal(schema.validateSettingValue("sync", "sidebar_density", value).valid, true, value);
    }
    for (const value of ["tiny", "small", "medium", "large", "extra-large"]) {
        assert.equal(schema.validateSettingValue("sync", "sidebar_scale_preset", value).valid, true, value);
    }
    assert.equal(schema.validateSettingValue("sync", "sidebar_scale_preset", "giant").valid, false);
    for (const value of ["small", "medium", "large"]) {
        assert.equal(schema.validateSettingValue("sync", "sidebar_avatar_size", value).valid, true, value);
    }
    assert.equal(schema.validateSettingValue("sync", "sidebar_avatar_size", "huge").valid, false);
    assert.equal(schema.validateSettingValue("sync", "sidebar_avatar_size", 44).valid, false);
    assert.equal(schema.validateSettingValue("sync", "sidebar_preferred_state", "hidden").valid, false);
    assert.equal(schema.normalizeSidebarNumber("sidebar_expanded_width", 150), 160);
    assert.equal(schema.normalizeSidebarNumber("sidebar_expanded_width", 400), 320);
    assert.equal(schema.normalizeSidebarNumber("sidebar_collapsed_width", 20), 48);
    assert.equal(schema.normalizeSidebarNumber("sidebar_collapsed_width", 200), 112);
    assert.equal(schema.validateSettingValue("sync", "sidebar_expanded_width", "280").valid, false);
});

test("sidebar page normalization keeps unknown stable destinations after known destinations", () => {
    const order = schema.normalizeSidebarOrder(["nest:study", "calendar", "dashboard", "nest:study", "__proto__"]);
    assert.deepEqual(order, ["calendar", "dashboard", "courses", "inbox", "history", "help", "apstudy:planner", "apstudy:notes", "apstudy:grades", "apstudy:study", "nest:study"]);
    const visibility = schema.normalizeSidebarVisibility({ dashboard: false, "nest:study": false });
    assert.equal(visibility.dashboard, false);
    ["apstudy:planner", "apstudy:notes", "apstudy:grades", "apstudy:study"].forEach((id) => assert.equal(visibility[id], true));
    assert.equal(visibility["nest:study"], false);
    assert.equal(schema.validateSettingValue("sync", "sidebar_page_visibility", { ...schema.defaultSidebarPageVisibility, "nest:study": false }).valid, true);
});

test("course-card task exclusivity flips in both directions and defaults let To-Do suppress Due", () => {
    assert.deepEqual(schema.courseCardTaskExclusivityChanges("todo_course_card_tasks_enabled", true), { assignments_due: false });
    assert.deepEqual(schema.courseCardTaskExclusivityChanges("assignments_due", true), { todo_course_card_tasks_enabled: false });
    assert.deepEqual(schema.courseCardTaskExclusivityChanges("todo_course_card_tasks_enabled", false), {}, "turning a feature off never flips its peer");
    assert.deepEqual(schema.courseCardTaskExclusivityChanges("assignments_due", false), {}, "turning a feature off never flips its peer");
    assert.deepEqual(schema.courseCardTaskExclusivityChanges("todo_enabled", true), {});
    assert.deepEqual(schema.courseCardTaskExclusivityChanges("dark_mode", true), {});
    assert.equal(schema.todoSettingsDefaults.todo_course_card_tasks_enabled, true);
    assert.equal(schema.defaultsForArea("sync").assignments_due, false, "factory defaults keep the To-do rail owning course cards");
});
