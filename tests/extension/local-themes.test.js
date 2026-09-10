"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const schema = require("../../js/settings-schema.js");
const localThemes = require("../../js/local-themes.js");

test("local theme browsing searches and sorts copies without mutating bundled or saved input", () => {
    const catalogue = Object.freeze([
        Object.freeze({ id: "b", name: "Beta", source: "bundled", createdAt: 0, settings: Object.freeze({ dark_mode: true }) }),
        Object.freeze({ id: "a", name: "Alpha", source: "bundled", createdAt: 0, settings: Object.freeze({ dark_mode: false }) })
    ]);
    const saved = Object.freeze({
        "20": Object.freeze({ dark_mode: true }),
        "10": Object.freeze({ condensed_cards: true })
    });
    const beforeCatalogue = JSON.stringify(catalogue);
    const beforeSaved = JSON.stringify(saved);

    assert.deepEqual(localThemes.browseThemes({ catalogue, savedThemes: saved, sort: "name" }).map((theme) => theme.id), ["a", "b", "saved:10", "saved:20"]);
    assert.deepEqual(localThemes.browseThemes({ catalogue, savedThemes: saved, sort: "newest" }).slice(0, 2).map((theme) => theme.id), ["saved:20", "saved:10"]);
    assert.deepEqual(localThemes.browseThemes({ catalogue, savedThemes: saved, sort: "saved", query: "saved" }).map((theme) => theme.id), ["saved:10", "saved:20"]);
    assert.equal(JSON.stringify(catalogue), beforeCatalogue);
    assert.equal(JSON.stringify(saved), beforeSaved);
});

test("local themes accept only schema-valid setting snapshots and export keys stay allowlisted", () => {
    assert.deepEqual(localThemes.settingsForTheme(schema, { dark_mode: true, customBackgroundBlur: 99, invented: "no" }), { dark_mode: true, customBackgroundBlur: 32 });
    const selected = localThemes.selectedExportKeys(schema, ["dark_mode", "saved_themes", "invented", "dark_mode"]);
    assert.deepEqual(selected, ["dark_mode"]);
    assert.equal(localThemes.exportableKeys(schema).includes("saved_themes"), false);
    assert.equal(localThemes.exportableKeys(schema).includes("dark_mode"), true);
});

test("malformed saved-theme timestamps are ignored without breaking local browsing", () => {
    const themes = localThemes.browseThemes({
        catalogue: [],
        savedThemes: {
            [String(Number.MAX_SAFE_INTEGER)]: { dark_mode: true },
            "100": { dark_mode: false }
        }
    });
    assert.deepEqual(themes.map((theme) => theme.id), ["saved:100"]);
});

test("newest ordering normalizes all local date metadata without mutating or throwing", () => {
    const catalogue = Object.freeze([
        Object.freeze({ id: "dated", name: "Dated", source: "bundled", createdAt: 10, settings: Object.freeze({ dark_mode: true }) }),
        Object.freeze({ id: "undated", name: "Undated", source: "bundled", createdAt: "not-a-date", settings: Object.freeze({ dark_mode: false }) }),
        Object.freeze({ id: "broken", name: "Broken", createdAt: Number.MAX_SAFE_INTEGER, settings: Object.freeze({ dark_mode: false }) })
    ]);
    const savedThemes = Object.freeze({
        "20": Object.freeze({ dark_mode: true }),
        "9007199254740991": Object.freeze({ dark_mode: false })
    });
    const before = JSON.stringify({ catalogue, savedThemes });

    assert.deepEqual(localThemes.browseThemes({ catalogue, savedThemes, sort: "newest" }).map((theme) => theme.id), ["saved:20", "dated", "broken", "undated"]);
    assert.equal(JSON.stringify({ catalogue, savedThemes }), before);
});

test("local sort persistence is independent of controller transactions and tolerates storage failure", async () => {
    const writes = [];
    const chromeApi = { storage: { sync: { set: async (value) => writes.push(value) } } };
    assert.equal(await localThemes.persistSort(chromeApi, "newest"), "newest");
    assert.deepEqual(writes, [{ local_theme_sort: "newest" }]);
    assert.equal(await localThemes.persistSort({ storage: { sync: { set: async () => { throw new Error("quota"); } } } }, "saved"), "saved");
    assert.equal(await localThemes.persistSort(chromeApi, "unexpected"), "name");
});

test("local theme import validates settings then delegates the canonical controller transaction", async () => {
    const calls = [];
    await localThemes.importLocalTheme({
        schema,
        theme: { settings: { dark_mode: true, invented: "no" } },
        runThemeImportTransaction: async (request) => calls.push(request)
    });
    assert.deepEqual(calls, [{ settingsChanges: { dark_mode: true }, cardColors: undefined }]);
    await assert.rejects(localThemes.importLocalTheme({ schema, theme: { settings: { invented: true } }, runThemeImportTransaction: async () => {} }), /THEME_SETTINGS_EMPTY/);
});

test("mounted local-theme setup is idempotent and uses injected transactions for apply and sort", async () => {
    class Element {
        constructor() { this.children = []; this.listeners = {}; this.value = ""; this.dataset = {}; }
        append(...nodes) { this.children.push(...nodes); }
        replaceChildren(...nodes) { this.children = nodes; }
        addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
        querySelectorAll() { return []; }
    }
    const nodes = Object.fromEntries(["#local-export-options", "#local-theme-list", "#local-theme-search", "#local-theme-sort", "#local-export-output", "#themes-status-value"].map((key) => [key, new Element()]));
    const doc = { querySelector: (selector) => nodes[selector] || null, querySelectorAll: () => [], createElement: () => new Element(), createTextNode: () => ({}) };
    const chromeApi = { storage: { local: { get: async () => ({ saved_themes: {} }) }, sync: { get: async () => ({}) } } };
    let imports = 0;
    const sortWrites = [];
    const first = localThemes.setup(doc, chromeApi, schema, {
        runThemeImportTransaction: async () => { imports += 1; },
        persistSort: async (value) => { sortWrites.push(value); }
    });
    const second = localThemes.setup(doc, chromeApi, schema, {
        runThemeImportTransaction: async () => { imports += 1; },
        persistSort: async (value) => { sortWrites.push(value); }
    });
    assert.equal(first, second);
    await new Promise((resolve) => setImmediate(resolve));
    const item = nodes["#local-theme-list"].children.find((entry) => entry.children[0].textContent === "Nest Day");
    const apply = item.children[2];
    await apply.listeners.click[0]();
    assert.equal(imports, 1);
    assert.equal(apply.listeners.click.length, 1);
    nodes["#local-theme-sort"].value = "newest";
    nodes["#local-theme-sort"].listeners.change[0]();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(sortWrites, ["newest"], "the controller transaction owns the sort write");
});
