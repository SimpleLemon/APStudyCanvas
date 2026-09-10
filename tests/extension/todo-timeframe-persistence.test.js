"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const contentSource = fs.readFileSync(path.join(root, "js/content.js"), "utf8");

test("the rail's timeframe change seeds the options cache before scheduling the refresh", () => {
    const handler = contentSource.match(/onTimeframeChange: \(\{ range, settings: nextSettings \} = \{\}\) => \{[\s\S]*?\n                \},/)?.[0];
    assert.ok(handler, "the integration wires a timeframe-change handler");
    assert.match(handler, /rangeOverride = range \|\| null;/, "the committed range still drives the next fetch");
    assert.match(handler, /options = \{ \.\.\.options, todo_timeframe: timeframe \};/, "the in-memory snapshot is updated synchronously");
    assert.match(handler, /writes\.todo_timeframe = timeframe;/, "the selection is persisted");
    assert.match(handler, /todo_custom_range_days/, "custom window length persists with the custom timeframe");
    assert.match(handler, /storageAreaSet\(chrome\.storage\.sync, writes\)/, "persistence flows through the sync settings store");
    assert.match(handler, /schedule\("timeframe"\);/, "the refresh is scheduled after the snapshot agrees");
    // Order is the whole fix: the snapshot must be seeded before the
    // scheduled refresh can read settings(), so the handler must not
    // schedule first and persist later.
    assert.ok(handler.indexOf("options = { ...options, todo_timeframe: timeframe };") < handler.indexOf("schedule(\"timeframe\")"), "persistence precedes the scheduled refresh");
});

test("refresh rebuilds a rolling custom window when the override is gone", () => {
    assert.match(contentSource, /const range = rangeOverride \|\| todoRefreshRange\(currentSettings\);/, "refresh range resolution funnels through the custom-aware helper");
    const helper = contentSource.match(/function todoRefreshRange\(currentSettings\) \{[\s\S]*?\n    \}/)?.[0];
    assert.ok(helper, "the custom range helper exists");
    assert.match(helper, /currentSettings\?\.todo_timeframe === "custom"/, "custom gets its own rebuild path");
    assert.match(helper, /todo_custom_range_days/, "the persisted custom length feeds the rolling window");
    assert.match(helper, /localDateKey\(Date\.now\(\), currentTimeZone\(\)\)/, "the rolling window starts today");
    assert.match(helper, /buildRange\(\{ timeframe: "custom", customStart: start, customEnd: end \}\)/, "the rebuilt window goes through the shared range builder");
});

test("the rail reports committed settings on every timeframe commit path", () => {
    const railSource = fs.readFileSync(path.join(root, "js/content/todo-right-rail.js"), "utf8");
    const commit = railSource.match(/function commitTimeframe\(timeframe, custom = \{\}\) \{[\s\S]*?\n        \}/)?.[0];
    assert.ok(commit, "commitTimeframe exists");
    assert.match(commit, /callbacks\.onTimeframeChange\?\.\(\{ timeframe, range: state\.range, settings: nextSettings \}\)/, "commits carry the next settings so the owner can persist them");
});
