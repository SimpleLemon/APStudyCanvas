"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const actionsApi = require("../../js/content/sidebar-page-actions.js");

function memoryStorage() {
    const values = new Map();
    return { getItem: (key) => values.get(key) || null, setItem: (key, value) => values.set(key, String(value)), removeItem: (key) => values.delete(key), values };
}

function eventDocument() {
    const listeners = new Map();
    return {
        addEventListener(type, listener) { listeners.set(type, listener); },
        removeEventListener(type) { listeners.delete(type); },
        dispatchEvent(event) { listeners.get(event.type)?.(event); return true; }
    };
}

test("all four Page actions open real workspaces independent of optional widgets", () => {
    const calls = [], document = eventDocument();
    const service = actionsApi.createSidebarPageActions({ document, openWorkspace: page => { calls.push(page); return true; } });
    assert.equal(service.attach(), true);
    service.attach();
    for (const page of ["planner", "notes", "grades", "study"]) document.dispatchEvent({ type: actionsApi.EVENT_NAME, detail: { action: page } });
    assert.deepEqual(calls, ["planner", "notes", "grades", "study"]);
    assert.equal(service.handle("__proto__"), false);
    assert.equal(service.handle("/planner"), false);
    service.destroy();
    document.dispatchEvent({ type: actionsApi.EVENT_NAME, detail: { action: "notes" } });
    assert.equal(calls.length, 4);
});

test("enabled Study waits for Canvas Search bootstrap before opening Study Tools as a failure fallback", async () => {
    let resolveBootstrap;
    let mounted = false;
    let settings = 0;
    const bootstrap = new Promise((resolve) => { resolveBootstrap = resolve; });
    assert.equal(actionsApi.showStudyWhenReady({
        showStudy: () => mounted,
        ensureStudy: () => bootstrap,
        openStudyTools: () => { settings += 1; return true; }
    }), true, "an enabled but unmounted search surface is still handled");
    await Promise.resolve();
    assert.equal(settings, 0, "settings does not open while bootstrap is pending");
    mounted = true;
    resolveBootstrap();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(settings, 0, "the mounted Canvas Search UI receives the action after bootstrap");

    assert.equal(actionsApi.showStudyWhenReady({
        showStudy: () => false,
        ensureStudy: async () => undefined,
        openStudyTools: () => { settings += 1; return true; }
    }), true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settings, 1, "a completed bootstrap without a UI falls back to existing Study Tools");
});
