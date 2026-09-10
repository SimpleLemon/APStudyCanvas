"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const settingsSources = [
    "html/popup.html",
    "css/popup.css",
    "js/edit-canvas.js",
    "js/popup.js",
    "js/popup-controller.js"
].map((relative) => [relative, read(relative)]);

test("production settings sources have no retired interface hooks", () => {
    const retired = [
        /legacy-interface/i,
        /setupLegacy/,
        /data-legacy-target/,
        /openLegacyTarget/,
        /#legacy-interface/,
        /\.main\[inert\]/,
        /\.tab\[aria-hidden/,
        /workspace-search-input/,
        /data-home-target/,
        /data-home-setting/
    ];
    settingsSources.forEach(([relative, source]) => {
        retired.forEach((marker) => assert.doesNotMatch(source, marker, `${relative} retains ${marker}`));
    });
});

test("the canonical settings surface uses Workspace as its only route", () => {
    const source = Object.fromEntries(settingsSources);
    assert.match(source["html/popup.html"], /<body data-mode="workspace"[^>]*>/);
    assert.doesNotMatch(source["html/popup.html"], /id="home-view"|id="home-edit-canvas"/);
    assert.doesNotMatch(source["js/edit-canvas.js"], /startsInWorkspace|function setupHome\(\)/);
    assert.match(source["js/edit-canvas.js"], /enterWorkspace\("overview"\)/);
    assert.match(source["js/edit-canvas.js"], /startupQuery\.get\("embedded"\) === "1" \? "embedded"/);
    assert.match(source["js/edit-canvas.js"], /startupQuery\.get\("view"\) === "workspace" \|\| startupQuery\.get\("fullscreen"\) === "1" \? "tab"/);
    assert.match(source["js/edit-canvas.js"], /function setupGlobalSearch\(\)/);
    assert.match(source["js/edit-canvas.js"], /function bindEmbeddedFocusBridge\(\)/);
    assert.match(source["js/edit-canvas.js"], /function bindNavKeyboard\(\)/);
});
