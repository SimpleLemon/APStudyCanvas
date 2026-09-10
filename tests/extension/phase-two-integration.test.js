"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const registration = require(path.join(root, "js/platform/canvas-registration.js"));
const schema = require(path.join(root, "js/settings-schema.js"));
const planner = require(path.join(root, "js/content/planner-tasks.js"));
const content = fs.readFileSync(path.join(root, "js/content.js"), "utf8");

function response(status, body = {}) {
    return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function extractFunction(name) {
    const start = content.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `missing ${name}`);
    const bodyStart = content.indexOf("{", content.indexOf(")", start));
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

function contentTodoSnapshot(values) {
    const source = extractFunction("todoSettingsSnapshot");
    return new Function("contentTodoSchemaApi", `${source}\nreturn todoSettingsSnapshot;`)(schema)(values);
}

test("Phase 2 registers the planner domain exactly before its To-Do consumers", () => {
    const canvas = manifest.content_scripts.find((entry) => entry.js?.includes("js/content.js"));
    assert.ok(canvas, "Canvas isolated-world registration exists");
    const scripts = canvas.js;
    const plannerIndex = scripts.indexOf("js/content/planner-tasks.js");
    assert.ok(plannerIndex > -1, "planner domain is packaged");
    assert.ok(plannerIndex < scripts.indexOf("js/content/todo-model.js"), "planner marker parser exists before task normalization");
    assert.ok(plannerIndex < scripts.indexOf("js/content/todo-api.js"), "planner transport exists before the API dispatcher");
    assert.equal(scripts.at(-1), "js/content.js", "coordinator remains last");
    assert.deepEqual(scripts, registration.CANVAS_CONTENT_SCRIPTS, "dynamic Canvas registration preserves the static dependency order");
});

test("Phase 2 preference is disabled by default and content preserves its normalized planner gate", () => {
    assert.equal(schema.syncDefaults.planner_tasks_enabled, false);
    assert.equal(schema.migratePhaseOneSettings({}).settings.planner_tasks_enabled, false, "legacy profiles receive a read-only default without a storage write");
    assert.equal(schema.migratePhaseOneSettings({ planner_tasks_enabled: true }).settings.planner_tasks_enabled, true, "an explicit local preference enables the explicitly requested writer");
    assert.equal(schema.todoSettingsSnapshot({ planner_tasks_enabled: true }).planner_tasks_enabled, undefined, "the schema's To-Do-only snapshot remains intentionally scoped");
    assert.equal(contentTodoSnapshot({ planner_tasks_enabled: true }).settings.planner_tasks_enabled, true, "the content runtime retains the separate normalized planner opt-in");
    assert.equal(contentTodoSnapshot({ planner_tasks_enabled: false }).settings.planner_tasks_enabled, false, "the content runtime retains an explicit planner opt-out");
    assert.match(content, /return settings\(\)\.planner_tasks_enabled === true;/);
    assert.match(content, /key === "planner_tasks_enabled"/, "a storage-only planner change refreshes the mounted integration");
    assert.match(content, /createPlannerTask,\n\s*updatePlannerTask,\n\s*deletePlannerTask,\n\s*plannerTaskDraft/);
});

test("Phase 2 writer has ownership, gate, and lifecycle teardown seams", async () => {
    assert.match(content, /canvas: \{ writePlannerOverride, markAnnouncementRead, setPlannerNoteCompletion \}/);
    assert.match(content, /task\?\.mutationAuthority === "canvas_planner_note" \? "canvas_planner_note"/);
    assert.match(content, /plannerTaskTransport\?\.dispose\?\.\(\);/);

    let calls = 0;
    const transport = planner.createTransport({
        origin: "https://canvas.example.edu",
        document: { cookie: "_csrf_token=token" },
        fetchImpl: async () => { calls += 1; return response(200); }
    });
    const disabled = await transport.update({ id: 7, details: planner.encodeDetails({ id: "pt-abcdefg-1234567" }) }, { title: "Never sent", todoDate: "2026-09-05" });
    assert.equal(disabled.error.code, "PLANNER_TASKS_DISABLED");
    assert.equal(calls, 0, "a registered domain does not write without both integration gates");

    const enabled = planner.createTransport({
        origin: "https://canvas.example.edu",
        enabled: true,
        document: { cookie: "_csrf_token=token" },
        fetchImpl: async () => { calls += 1; return response(200); }
    });
    const foreign = await enabled.remove({ id: 7, details: "not extension owned" });
    assert.equal(foreign.error.code, "PLANNER_NOTE_NOT_OWNED");
    assert.equal(calls, 0, "ownership failure never reaches Canvas");
    enabled.dispose();
});
