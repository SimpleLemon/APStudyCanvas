"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const schema = require("../../js/settings-schema.js");
const popup = require("../../js/popup-controller.js");

const html = fs.readFileSync(path.resolve(__dirname, "../../html/popup.html"), "utf8");

test("To-Do factory defaults are flat, versioned, and match the product brief", () => {
    const defaults = schema.todoSettingsDefaults;
    assert.equal(defaults.todo_settings_version, schema.TODO_SCHEMA_VERSION);
    assert.equal(defaults.todo_enabled, true);
    assert.equal(defaults.todo_course_card_tasks_enabled, true);
    assert.equal(defaults.todo_streak_enabled, true);
    assert.equal(defaults.todo_institution_logo_visible, false, "the institutional mark is hidden by default; Show School Logo is an opt-in");
    assert.equal(defaults.todo_progress_style, "circle");
    assert.equal(defaults.todo_course_scope, "active");
    assert.equal(defaults.todo_grouping, true);
    assert.equal(defaults.todo_date_format, "absolute");
    assert.equal(defaults.todo_timeframe, "week");
    assert.equal(defaults.todo_week_start, "rolling");
    assert.equal(defaults.todo_completion_authority, "canvas");
    assert.equal(defaults.todo_missing_enabled, true);
    assert.equal(defaults.todo_missing_retention, "always");
    assert.equal(defaults.todo_urgency_enabled, true);
    assert.equal(defaults.todo_celebration, "confetti");
    assert.equal(defaults.todo_celebration_intensity, "normal");
    assert.equal(defaults.todo_reduced_motion_safe, true);
    assert.equal(defaults.todo_link_target, "new-tab");
    assert.equal(defaults.todo_hover_preview, true);
    assert.equal(defaults.todo_course_filtering, true);
    assert.equal(defaults.todo_hide_feedback, true);
    assert.equal(defaults.todo_card_max, 4);
    assert.equal(defaults.todo_card_sort, "urgency-balanced");
    assert.equal(defaults.todo_hide_completed, "immediate");
});

test("legacy To-Do values override defaults once, while explicit todo_* values win", () => {
    const legacy = {
        better_todo: false,
        todo_progress_rings: false,
        todo_hide_feedback: false,
        todo_confetti: false,
        num_todo_items: 99,
        todo_hr24: true,
        todo_separate_scrollbar: true,
        todo_full_height: true,
        hover_preview: false,
        streak_visible: false
    };
    const first = schema.migrateTodoSettings(legacy);
    assert.equal(first.changes.todo_enabled, false);
    assert.equal(first.changes.todo_progress_style, "none", "todo_progress_rings false maps to None");
    assert.equal(first.changes.todo_hide_feedback, undefined, "the legacy semantic is preserved in place");
    assert.equal(first.settings.todo_hide_feedback, false);
    assert.equal(first.changes.todo_celebration, "none");
    assert.equal(first.changes.todo_celebration_intensity, "none");
    assert.equal(first.changes.todo_card_max, 10);
    assert.equal(first.changes.todo_clock_24h, true);
    assert.equal(first.changes.todo_separate_scrollbar, undefined);
    assert.equal(first.settings.todo_separate_scrollbar, true);
    assert.equal(first.changes.todo_full_height, undefined);
    assert.equal(first.settings.todo_full_height, true);
    assert.equal(first.changes.todo_hover_preview, false);
    assert.equal(first.changes.todo_streak_enabled, false);

    const ringsOn = schema.migrateTodoSettings({ todo_progress_rings: true });
    assert.equal(ringsOn.changes.todo_progress_style, "circle", "todo_progress_rings true maps to Circle");
    assert.equal(ringsOn.settings.todo_missing_enabled, true, "missing has no legacy key, so the new ON default applies");

    // Stored pre-rename style names keep their intent through the alias map.
    const renamed = schema.migrateTodoSettings({ todo_progress_style: "minimal" });
    assert.equal(renamed.settings.todo_progress_style, "bar");
    assert.equal(schema.migrateTodoSettings({ todo_progress_style: "simple" }).settings.todo_progress_style, "circle");
    assert.equal(schema.migrateTodoSettings({ todo_progress_style: "nested" }).settings.todo_progress_style, "rainbow");
    assert.equal(schema.migrateTodoSettings({ todo_progress_style: "segmented" }).settings.todo_progress_style, "bar");

    const explicit = schema.migrateTodoSettings({ ...legacy, todo_enabled: true, todo_progress_style: "cloud", todo_card_max: 2 });
    assert.equal(explicit.changes.todo_enabled, undefined);
    assert.equal(explicit.settings.todo_enabled, true);
    assert.equal(explicit.changes.todo_progress_style, undefined);
    assert.equal(explicit.settings.todo_progress_style, "cloud", "explicitly stored modern values always win");
    assert.equal(explicit.changes.todo_card_max, undefined);
    assert.equal(explicit.settings.todo_card_max, 2);

    const second = schema.migrateTodoSettings({ ...legacy, ...first.changes });
    assert.deepEqual(second.changes, {});
});

test("all seven progress styles validate, old names import-strict, and numeric imports clamp to product bounds", () => {
    assert.deepEqual(schema.todoProgressStyles, ["none", "circle", "rainbow", "bar", "heart", "cloud", "oiia"]);
    schema.todoProgressStyles.forEach((style) => assert.equal(schema.validateSettingValue("sync", "todo_progress_style", style).valid, true, style));
    assert.equal(schema.validateSettingValue("sync", "todo_progress_style", "circle").valid, true);
    ["simple", "nested", "segmented", "minimal"].forEach((old) => assert.equal(schema.validateSettingValue("sync", "todo_progress_style", old).valid, false, old));
    assert.deepEqual(schema.validateSettingValue("sync", "todo_custom_range_days", 0), { valid: true, value: 1 });
    assert.deepEqual(schema.validateSettingValue("sync", "todo_custom_range_days", 120), { valid: true, value: 90 });
    assert.deepEqual(schema.validateSettingValue("sync", "todo_card_max", 0), { valid: true, value: 1 });
    assert.deepEqual(schema.validateSettingValue("sync", "todo_card_max", 12), { valid: true, value: 10 });
    assert.equal(schema.validateSettingValue("sync", "todo_card_max", "4").valid, false);
});

test("institution logo visibility defaults independently without a migration write", () => {
    const missing = schema.migrateTodoSettings({ sidebar_logo_visible: false, remlogo: true });
    assert.equal(missing.settings.todo_institution_logo_visible, false, "the institutional mark is hidden unless the user opts in");
    assert.equal(missing.changes.todo_institution_logo_visible, undefined, "the preference resolves on read and is never backfilled");
    assert.equal(schema.todoSettingsSnapshot({ todo_institution_logo_visible: true, sidebar_logo_visible: true, remlogo: false }).todo_institution_logo_visible, true, "an explicit opt-in still wins");
    assert.equal(schema.validateSettingValue("sync", "todo_institution_logo_visible", false).valid, true);
    assert.equal(schema.liveApplyGroup("todo_institution_logo_visible"), "study-tools");
});

test("To-Do settings export/import is settings-only and excludes task and account state", () => {
    ["assignments_done", "assignment_states", "custom_assignments", "custom_assignments_overflow", "reminders", "custom_domain", "id"].forEach((key) => assert.equal(schema.exportableSyncSettingKeys.includes(key), false, `generic export includes ${key}`));
    const exported = popup.createTodoSettingsExport({
        ...schema.todoSettingsDefaults,
        tasks: [{ id: "task-1" }],
        todo_manual_completion_state: { "task-1": true },
        todo_task_cache: { "task-1": {} },
        assignment_states: { "task-1": "done" },
        assignments_done: ["task-1"],
        canvas_sync_opt_in: { account: true },
    });
    assert.deepEqual(Object.keys(exported).sort(), [...schema.todoSettingKeys].sort());
    ["tasks", "todo_manual_completion_state", "todo_task_cache", "assignment_states", "assignments_done", "canvas_sync_opt_in"].forEach((key) => assert.equal(Object.hasOwn(exported, key), false, key));

    const imported = popup.normalizeTodoSettingsImport({ todo_card_max: 99, todo_custom_range_days: 0, tasks: [{ id: "secret-task" }], canvas_sync_opt_in: { account: true } });
    assert.equal(imported.valid, true);
    assert.deepEqual(imported.changes, { todo_card_max: 10, todo_custom_range_days: 1 });
    assert.equal(popup.normalizeTodoSettingsImport({ todo_progress_style: "invalid" }).valid, false);
});

test("To-Do settings UI has schema parity and the Calendar & Accounts action", () => {
    schema.todoSettingDescriptors.forEach((descriptor) => {
        assert.match(html, new RegExp(`data-popup-setting="${descriptor.key}"`), descriptor.key);
        (descriptor.options || []).forEach((option) => assert.match(html, new RegExp(`value="${option}"`), `${descriptor.key}:${option}`));
    });
    assert.match(html, /id="todo-calendar-sync"/);
    assert.match(html, /id="todo-calendar-sync-status"/);
    assert.match(html, /id="todo-export-settings"/);
    assert.match(html, /id="todo-import-settings"/);
    assert.match(html, /id="workspace-section-calendar-accounts"/);
    assert.doesNotMatch(html, /data-popup-setting="todo_day_start"/, "the inert legacy day-start preference has no visible control");
    assert.ok(schema.todoSettingKeys.includes("todo_day_start"), "legacy backups still validate and round-trip day start safely");
});
