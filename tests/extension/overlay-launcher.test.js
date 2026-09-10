"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const overlayLauncher = require("../../js/platform/overlay-launcher.js");

const EMORY = "https://canvas.emory.edu";
const CUSTOM = "https://canvas.example.edu";

function createEvent() {
    const listeners = new Set();
    return {
        addListener(listener) { listeners.add(listener); },
        removeListener(listener) { listeners.delete(listener); },
        emit(...args) { for (const listener of Array.from(listeners)) listener(...args); },
        size() { return listeners.size; }
    };
}

function createTimers() {
    const pending = new Map();
    let nextId = 1;
    return {
        setTimeoutImpl(callback) {
            const id = nextId++;
            pending.set(id, callback);
            return id;
        },
        clearTimeoutImpl(id) { pending.delete(id); },
        fireAll() {
            for (const [id, callback] of Array.from(pending)) {
                pending.delete(id);
                callback();
            }
        },
        size() { return pending.size; }
    };
}

function createChrome({ tabs = [], sendResults = {}, reloadBehavior = "complete" } = {}) {
    const messages = [];
    const created = [];
    const focused = [];
    const reloads = [];
    const responses = new Map(Object.entries(sendResults).map(([tabId, result]) => [Number(tabId), Array.isArray(result) ? result.slice() : [result]]));
    const onUpdated = createEvent();
    const onRemoved = createEvent();
    const timers = createTimers();
    const chromeApi = {
        runtime: { getURL: (value) => `chrome-extension://id/${value}` },
        tabs: {
            onUpdated,
            onRemoved,
            async query() { return tabs.slice(); },
            async sendMessage(tabId, envelope, options) {
                messages.push({ tabId, type: envelope?.type, source: envelope?.payload?.source, options });
                if (responses.has(tabId)) {
                    const results = responses.get(tabId);
                    const result = results.length > 1 ? results.shift() : results[0];
                    if (result instanceof Error) throw result;
                    return result;
                }
                return { ok: true };
            },
            async update(tabId, update) { focused.push({ tabId, update }); },
            async reload(tabId) {
                reloads.push(tabId);
                if (reloadBehavior instanceof Error) throw reloadBehavior;
                if (reloadBehavior === "complete") queueMicrotask(() => onUpdated.emit(tabId, { status: "complete" }));
                if (reloadBehavior === "removed") queueMicrotask(() => onRemoved.emit(tabId));
            },
            async create(createProperties) {
                created.push(createProperties);
                return { id: 99, ...createProperties };
            }
        },
        windows: {
            async update(windowId, update) { focused.push({ windowId, update }); }
        }
    };
    return {
        chromeApi,
        launcherOptions: {
            chromeApi,
            reloadReadyTimeoutMs: 25,
            setTimeoutImpl: timers.setTimeoutImpl,
            clearTimeoutImpl: timers.clearTimeoutImpl
        },
        messages,
        created,
        focused,
        reloads,
        onUpdated,
        onRemoved,
        timers
    };
}

test("overlayable origins stay aligned with the Emory-only WAR matches", () => {
    assert.deepEqual(overlayLauncher.OVERLAY_WEB_ACCESSIBLE_ORIGINS, [EMORY]);
    assert.equal(overlayLauncher.DEFAULT_CANVAS_ORIGIN, EMORY);
    const origins = overlayLauncher.eligibleOrigins([CUSTOM]);
    assert.equal(origins.has(EMORY), true);
    assert.equal(origins.has(CUSTOM), true);
});

test("an Emory Canvas tab opens the in-page overlay", async () => {
    const emoryTab = { id: 4, windowId: 1, url: `${EMORY}/courses/1` };
    const { chromeApi, messages, created } = createChrome({ tabs: [emoryTab] });
    const launcher = overlayLauncher.createOverlayLauncher({ chromeApi });

    const result = await launcher.launch(emoryTab, { configuredOrigins: [CUSTOM], flags: { canvasOverlay: true } });
    assert.deepEqual(result, { ok: true, state: "opened", tabId: 4 });
    assert.equal(messages.length, 1);
    assert.equal(messages[0].tabId, 4);
    assert.equal(messages[0].options.frameId, 0);
    assert.equal(created.length, 0);
});

test("a stale Emory receiver reloads the same tab and retries once", async () => {
    const emoryTab = { id: 5, windowId: 1, url: `${EMORY}/courses/1` };
    const { launcherOptions, messages, created, reloads, onUpdated, onRemoved, timers } = createChrome({
        tabs: [emoryTab],
        sendResults: { 5: [new Error("receiver missing"), { ok: true }] }
    });
    const launcher = overlayLauncher.createOverlayLauncher(launcherOptions);

    const result = await launcher.launch(emoryTab, { flags: { canvasOverlay: true } });
    assert.deepEqual(result, { ok: true, state: "opened", tabId: 5 });
    assert.equal(messages.length, 2);
    assert.deepEqual(reloads, [5]);
    assert.equal(created.length, 0);
    assert.equal(onUpdated.size(), 0);
    assert.equal(onRemoved.size(), 0);
    assert.equal(timers.size(), 0);
});

test("a healthy Emory receiver does not reload", async () => {
    const emoryTab = { id: 6, windowId: 1, url: `${EMORY}/courses/1` };
    const { launcherOptions, reloads, onUpdated, onRemoved, timers } = createChrome({ tabs: [emoryTab] });
    const launcher = overlayLauncher.createOverlayLauncher(launcherOptions);

    await launcher.launch(emoryTab, { flags: { canvasOverlay: true } });
    assert.equal(reloads.length, 0);
    assert.equal(onUpdated.size(), 0);
    assert.equal(onRemoved.size(), 0);
    assert.equal(timers.size(), 0);
});

test("an unrecoverable Emory launch stays on the reloaded tab without workspace fallback", async () => {
    const emoryTab = { id: 7, windowId: 1, url: `${EMORY}/courses/1` };
    const { launcherOptions, messages, created, reloads, onUpdated, onRemoved, timers } = createChrome({
        tabs: [emoryTab],
        sendResults: { 7: [new Error("receiver missing"), new Error("still missing")] }
    });
    const launcher = overlayLauncher.createOverlayLauncher(launcherOptions);

    const result = await launcher.launch(emoryTab, { flags: { canvasOverlay: true } });
    assert.deepEqual(result, { ok: false, code: "OVERLAY_LAUNCH_FAILED", tabId: 7 });
    assert.equal(messages.length, 2);
    assert.deepEqual(reloads, [7]);
    assert.equal(created.length, 0);
    assert.equal(onUpdated.size(), 0);
    assert.equal(onRemoved.size(), 0);
    assert.equal(timers.size(), 0);
});

test("a reload readiness timeout cleans up and fails in the same tab without retry or fallback", async () => {
    const emoryTab = { id: 9, windowId: 1, url: `${EMORY}/courses/1` };
    const { launcherOptions, messages, created, reloads, onUpdated, onRemoved, timers } = createChrome({
        tabs: [emoryTab],
        reloadBehavior: "timeout",
        sendResults: { 9: new Error("receiver missing") }
    });
    const launcher = overlayLauncher.createOverlayLauncher(launcherOptions);

    const launchPromise = launcher.launch(emoryTab, { flags: { canvasOverlay: true } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(onUpdated.size(), 1);
    assert.equal(onRemoved.size(), 1);
    assert.equal(timers.size(), 1);
    timers.fireAll();

    const result = await launchPromise;
    assert.deepEqual(result, { ok: false, code: "OVERLAY_LAUNCH_FAILED", tabId: 9 });
    assert.equal(messages.length, 1);
    assert.deepEqual(reloads, [9]);
    assert.equal(created.length, 0);
    assert.equal(onUpdated.size(), 0);
    assert.equal(onRemoved.size(), 0);
    assert.equal(timers.size(), 0);
});

test("a custom-origin Canvas tab falls back to the workspace tab instead of a broken overlay", async () => {
    const customTab = { id: 8, windowId: 2, url: `${CUSTOM}/courses/1` };
    const { chromeApi, messages, created } = createChrome({
        tabs: [customTab],
        sendResults: { 8: { ok: true } }
    });
    const launcher = overlayLauncher.createOverlayLauncher({ chromeApi });

    const result = await launcher.launch(customTab, { configuredOrigins: [CUSTOM], flags: { canvasOverlay: true } });
    assert.deepEqual(result, { ok: true, state: "workspace_tab", tabId: 99 });
    assert.equal(messages.length, 0, "must not notify a tab whose origin is outside WAR matches");
    assert.equal(created.length, 1);
    assert.match(created[0].url, /html\/popup\.html\?view=workspace/);
});

test("a custom-origin click still hands off to an existing Emory tab", async () => {
    const customTab = { id: 8, windowId: 2, url: `${CUSTOM}/dashboard` };
    const emoryTab = { id: 4, windowId: 1, url: `${EMORY}/` };
    const { chromeApi, messages, created, focused } = createChrome({ tabs: [customTab, emoryTab] });
    const launcher = overlayLauncher.createOverlayLauncher({ chromeApi });

    const result = await launcher.launch(customTab, { configuredOrigins: [CUSTOM], flags: { canvasOverlay: true } });
    assert.deepEqual(result, { ok: true, state: "handoff", tabId: 4 });
    assert.equal(messages.length, 1);
    assert.equal(messages[0].tabId, 4);
    assert.equal(messages[0].source, "handoff");
    assert.equal(created.length, 0);
    assert.ok(focused.some((entry) => entry.tabId === 4 || entry.windowId === 1));
});
