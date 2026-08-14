"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

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

function lifecycleHarness() {
    let teardownCount = 0;
    const context = vm.createContext({
        console: { error() {} },
        Error,
        Promise,
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
        },
        clearInterval() {},
        stopReminderWatch() { teardownCount += 1; }
    });
    vm.runInContext(`
        let timeCheck = null;
        let recurringContentWorkStopped = false;
        ${source.match(/const CONTENT_CONTEXT_INVALIDATED[\s\S]*?function isContentContextInvalidated\([^]*?\n\}/)?.[0] || ""}
        ${extractFunction("stopRecurringContentWork")}
        ${extractFunction("runRecurringContentWork")}
    `, context);
    return { context, getTeardownCount: () => teardownCount };
}

test("reminder and auto-dark recurrence use the centralized invalidation guard", () => {
    assert.match(source, /return runRecurringContentWork\(\(\) => reminderWatch\(\), "reminder watch"\)/);
    assert.match(source, /runAutoDarkModeCheck\(\);/);
    assert.match(source, /timeCheck = setInterval\(runAutoDarkModeCheck, 60000\)/);
    assert.match(source, /runRecurringContentWork\(\(\) => autoDarkModeCheck\(\), "auto-dark mode"\)/);
});

test("invalidating reminder recurrence tears down all recurring content work once", async () => {
    const harness = lifecycleHarness();
    const result = await vm.runInContext(
        'runRecurringContentWork(() => Promise.reject(new Error("Extension context invalidated.")), "reminder watch")',
        harness.context
    );
    assert.equal(result.ok, false);
    assert.equal(result.invalidated, true);
    assert.equal(harness.getTeardownCount(), 1);
    const stopped = await vm.runInContext('runRecurringContentWork(() => { throw new Error("must not run"); }, "reminder watch")', harness.context);
    assert.equal(stopped.ok, false);
    assert.equal(stopped.stopped, true);
});

test("ordinary auto-dark recurrence failures remain reported", async () => {
    const harness = lifecycleHarness();
    const result = await vm.runInContext(
        'runRecurringContentWork(() => Promise.reject(new Error("storage unavailable")), "auto-dark mode")',
        harness.context
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, "AUTO_DARK_MODE_FAILED");
    assert.equal(harness.getTeardownCount(), 0);
});
