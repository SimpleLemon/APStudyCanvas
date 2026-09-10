"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const lifecycle = require("../../js/content/lifecycle.js");
const { canvasCompatibilityFixture, addCanvasPortals, createWindow, createObserverClass } = require("./helpers/canvas-compatibility-dom.js");

const source = fs.readFileSync(path.join(__dirname, "../../js/content.js"), "utf8");

function extractFunction(name) {
    const start = source.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `missing ${name}`);
    const bodyStart = source.indexOf("{", start);
    let depth = 0;
    for (let index = bodyStart; index < source.length; index += 1) {
        if (source[index] === "{") depth += 1;
        if (source[index] === "}") {
            depth -= 1;
            if (depth === 0) return source.slice(start, index + 1);
        }
    }
    throw new Error(`unterminated ${name}`);
}

const TIMER_IDS = { contentTodoRefreshTimer: 15, timeCheck: 11 };
const EXPECTED_CLEARED_TIMERS = [15, 11];

function lifecycleHarness() {
    const counters = {
        clearTimeout: 0,
        clearInterval: 0,
        disconnect: 0,
        lifecycleDispose: 0,
        sidebarDispose: 0,
        todoDestroy: 0,
        overlayTeardown: 0
    };
    const clearedTimers = [];
    const context = vm.createContext({
        console: { error() {} },
        Error,
        Promise,
        counters,
        clearedTimers,
        clearTimeout(timer) { counters.clearTimeout += 1; clearedTimers.push(timer); },
        clearInterval(timer) { counters.clearInterval += 1; clearedTimers.push(timer); },
        teardownContentOverlayHost(reason) {
            counters.overlayTeardown += 1;
            counters.overlayReason = reason;
        },
        teardownPhaseFourFeatures() { return Promise.resolve(); },
        removeAssignmentNavigation() {},
        contentExtensionContextApi: {
            isInvalidated(error) {
                return /\bExtension context(?: was)? invalidated\b/i.test(String(error?.message || error || ""));
            },
            run(task, { onInvalidated }) {
                return Promise.resolve().then(task).catch((error) => {
                    if (!this.isInvalidated(error)) throw error;
                    onInvalidated(error);
                    return { ok: false, invalidated: true };
                });
            }
        }
    });
    vm.runInContext(`
        let timeCheck = ${TIMER_IDS.timeCheck};
        let contentTodoRefreshTimer = ${TIMER_IDS.contentTodoRefreshTimer};
        let recurringContentWorkStopped = false;
        let contentContextDead = false;
        let sidebarContextRevision = 0;
        let cardAssignmentsGeneration = 0;
        let accountBoundJobsPaused = false;
        let contentLifecycle = { dispose() { counters.lifecycleDispose += 1; } };
        let contentSidebarController = { dispose() { counters.sidebarDispose += 1; } };
        let contentTodoIntegration = { destroy() { counters.todoDestroy += 1; } };
        let sequenceFooterObserver = { disconnect() { counters.disconnect += 1; } };
        let submissionPageButtonObserver = { disconnect() { counters.disconnect += 1; } };
        let profileLogoutButtonObserver = { disconnect() { counters.disconnect += 1; } };
        ${source.match(/const CONTENT_CONTEXT_INVALIDATED[\s\S]*?function isContentContextInvalidated\([^]*?\n\}/)?.[0] || ""}
        ${extractFunction("invalidateContentContext")}
        ${extractFunction("stopRecurringContentWork")}
        ${extractFunction("runRecurringContentWork")}
    `, context);
    return { context, counters, clearedTimers };
}

function readState(harness) {
    return vm.runInContext(`({
        contentContextDead,
        recurringContentWorkStopped,
        sidebarContextRevision,
        cardAssignmentsGeneration,
        accountBoundJobsPaused,
        timeCheck,
        contentTodoRefreshTimer,
        sequenceFooterObserver,
        submissionPageButtonObserver,
        profileLogoutButtonObserver,
        contentLifecycle,
        contentSidebarController,
        contentTodoIntegration
    })`, harness.context);
}

function assertInvalidatedState(state) {
    assert.equal(state.contentContextDead, true);
    assert.equal(state.recurringContentWorkStopped, true);
    assert.equal(state.sidebarContextRevision, 1);
    assert.equal(state.cardAssignmentsGeneration, 1);
    assert.equal(state.accountBoundJobsPaused, true);
    assert.equal(state.timeCheck, null);
    assert.equal(state.contentTodoRefreshTimer, null);
    assert.equal(state.sequenceFooterObserver, null);
    assert.equal(state.submissionPageButtonObserver, null);
    assert.equal(state.profileLogoutButtonObserver, null);
    assert.equal(state.contentLifecycle, null);
    assert.equal(state.contentSidebarController, null);
    assert.equal(state.contentTodoIntegration, null);
}

function assertFullTeardownOnce(harness) {
    assert.deepEqual(harness.clearedTimers, EXPECTED_CLEARED_TIMERS);
    assert.equal(harness.counters.clearTimeout, 1);
    assert.equal(harness.counters.clearInterval, 1);
    assert.equal(harness.counters.disconnect, 3);
    assert.equal(harness.counters.lifecycleDispose, 1);
    assert.equal(harness.counters.sidebarDispose, 1);
    assert.equal(harness.counters.todoDestroy, 1);
    assert.equal(harness.counters.overlayTeardown, 1);
}

test("retired reminder resources are not created, tracked, or torn down", () => {
    assert.doesNotMatch(source, /\b(?:reminderWatch|reminderCheck|reminderTimeout|reminderInterval|reminderStorageListener|reminderWatchStopped)\b/);
    assert.doesNotMatch(source, /\b(?:setTimeout|setInterval)\([^;\n]*\breminder/i);
    assert.doesNotMatch(source, /\b(?:clearTimeout|clearInterval|removeListener)\([^;\n]*\breminder/i);
});

test("auto-dark recurrence uses the centralized invalidation guard", () => {
    assert.match(source, /runAutoDarkModeCheck\(\);/);
    assert.match(source, /timeCheck = setInterval\(runAutoDarkModeCheck, 60000\)/);
    assert.match(source, /runRecurringContentWork\(\(\) => autoDarkModeCheck\(\), "auto-dark mode"\)/);
    assert.match(source, /invalidateContentContext\("auto-dark-save", error\);/);
    assert.match(source, /function applyOptionsChanges\(changes, areaName\) \{\s*if \(contentContextDead\) return;/);
});

test("invalidating auto-dark recurrence tears down all recurring content work exactly once", async () => {
    const harness = lifecycleHarness();
    const result = await vm.runInContext(
        'runRecurringContentWork(() => Promise.reject(new Error("Extension context invalidated.")), "auto-dark mode")',
        harness.context
    );
    assert.equal(result.ok, false);
    assert.equal(result.invalidated, true);
    assertFullTeardownOnce(harness);
    assertInvalidatedState(readState(harness));

    const repeat = await vm.runInContext('invalidateContentContext("repeat")', harness.context);
    assert.equal(repeat.ok, false);
    assert.equal(repeat.invalidated, true);
    assertFullTeardownOnce(harness);

    const stopped = await vm.runInContext(
        'runRecurringContentWork(() => { throw new Error("must not run"); }, "auto-dark mode")',
        harness.context
    );
    assert.equal(stopped.ok, false);
    assert.equal(stopped.stopped, true);
    assertFullTeardownOnce(harness);
    assertInvalidatedState(readState(harness));
});

test("direct invalidateContentContext calls are idempotent", () => {
    const harness = lifecycleHarness();
    const first = vm.runInContext(
        'invalidateContentContext("manual", new Error("Extension context was invalidated."))',
        harness.context
    );
    assert.equal(first.ok, false);
    assert.equal(first.invalidated, true);
    assertFullTeardownOnce(harness);
    assertInvalidatedState(readState(harness));

    const second = vm.runInContext('invalidateContentContext("manual-again")', harness.context);
    assert.equal(second.ok, false);
    assert.equal(second.invalidated, true);
    assertFullTeardownOnce(harness);
    assertInvalidatedState(readState(harness));
});

test("ordinary auto-dark recurrence failures remain reported", async () => {
    const harness = lifecycleHarness();
    const result = await vm.runInContext(
        'runRecurringContentWork(() => Promise.reject(new Error("storage unavailable")), "auto-dark mode")',
        harness.context
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, "AUTO_DARK_MODE_FAILED");
    assert.deepEqual(harness.clearedTimers, []);
    assert.equal(harness.counters.clearTimeout, 0);
    assert.equal(harness.counters.clearInterval, 0);
    assert.equal(harness.counters.disconnect, 0);
    assert.equal(harness.counters.lifecycleDispose, 0);
    assert.equal(harness.counters.sidebarDispose, 0);
    assert.equal(harness.counters.todoDestroy, 0);
    assert.equal(harness.counters.overlayTeardown, 0);
    const state = readState(harness);
    assert.equal(state.contentContextDead, false);
    assert.equal(state.recurringContentWorkStopped, false);
    assert.equal(state.accountBoundJobsPaused, false);
    assert.equal(state.timeCheck, TIMER_IDS.timeCheck);
    assert.notEqual(state.contentLifecycle, null);
});

test("real lifecycle pause/resume/dispose ignores APStudy mutations, coalesces Canvas portal replacement, and releases every observer/listener", () => {
    const fixture = canvasCompatibilityFixture();
    const portals = addCanvasPortals(fixture.document);
    const window = createWindow();
    const Observer = createObserverClass();
    const timers = [];
    const cleared = [];
    const refreshes = [];
    const events = [];
    const controller = lifecycle.createContentLifecycle({
        document: fixture.document,
        window,
        mutationObserver: Observer,
        debounceMs: 0,
        setTimer(callback) { const token = { callback }; timers.push(token); return token; },
        clearTimer(token) { cleared.push(token); },
        onRefresh: (reason) => refreshes.push(reason),
        onPause: ({ reason }) => events.push(`pause:${reason}`),
        onResume: ({ reason }) => events.push(`resume:${reason}`),
        onDispose: ({ reason }) => events.push(`dispose:${reason}`)
    });
    const flush = () => { while (timers.length) timers.shift().callback(); };
    controller.init(); flush();
    const observer = Observer.instances[0];
    const canvasTodoColumn = fixture.document.createElement("section");
    fixture.document.body.append(canvasTodoColumn);
    canvasTodoColumn.append(fixture.todo);
    observer.trigger([{ type: "childList", target: canvasTodoColumn, addedNodes: [fixture.todo], removedNodes: [] }]);
    assert.deepEqual(refreshes, ["init"], "inserting an APStudy To-Do host beneath a Canvas column does not self-refresh");

    fixture.todo.remove();
    observer.trigger([{ type: "childList", target: canvasTodoColumn, addedNodes: [], removedNodes: [fixture.todo] }]);
    flush();
    assert.deepEqual(refreshes, ["init", "mutation"], "Canvas removing an APStudy To-Do host still schedules bounded recovery");

    portals.tray.remove();
    const replacement = addCanvasPortals(fixture.document).tray;
    observer.trigger([{ type: "childList", target: fixture.document.body, removedNodes: [portals.tray], addedNodes: [replacement] }]);
    flush();
    assert.deepEqual(refreshes, ["init", "mutation", "mutation"], "a native Canvas portal replacement takes the normal bounded refresh path");

    window.dispatch("pagehide", { persisted: true });
    observer.trigger([{ type: "childList", target: fixture.document.body, addedNodes: [replacement] }]);
    flush();
    assert.equal(controller.isPaused(), true);
    assert.deepEqual(events, ["pause:bfcache"]);
    assert.equal(refreshes.length, 3, "paused lifecycle does not refresh from a portal mutation");
    window.dispatch("pageshow", { persisted: true }); flush();
    assert.equal(controller.isPaused(), false);
    assert.deepEqual(events, ["pause:bfcache", "resume:bfcache"]);
    assert.equal(refreshes.at(-1), "pageshow");

    window.dispatch("pagehide", { persisted: false });
    window.dispatch("unload");
    assert.equal(controller.isDisposed(), true);
    assert.equal(fixture.document.documentElement.getAttribute(lifecycle.MARKER), null);
    assert.equal(Observer.instances[0].disconnectCalls, 2, "pause and final disposal each disconnect the retained observer once");
    assert.equal(window.listeners.get("pagehide").length, 0);
    assert.equal(window.listeners.get("pageshow").length, 0);
    assert.equal(window.listeners.get("unload").length, 0);
    assert.deepEqual(events, ["pause:bfcache", "resume:bfcache", "dispose:pagehide"]);
    assert.ok(cleared.length >= 0, "timer cleanup remains safe when no timer is pending");
});
