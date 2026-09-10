"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "../../js/content.js"), "utf8");
const css = fs.readFileSync(path.join(__dirname, "../../css/content.css"), "utf8");

test("content runtime and stylesheet contain no retired reminder implementation", () => {
    for (const pattern of [
        /(?:function|const|let)\s+(?:insertReminders|hideReminder|createReminder|reminderWatch|stopReminderWatch|runReminderWatch|updateReminders|showExampleReminder)\b/,
        /canvasrefined-reminder/,
        /canvasrefined-reminders/,
        /chrome\.storage\.sync\.(?:get|set)\([^\n]*(?:reminders|remind|reminder_count)/,
        /scheduledReminder/,
        /reminder(?:Timeout|Interval|StorageListener|WatchStopped|Check)/
    ]) assert.doesNotMatch(source, pattern);

    assert.doesNotMatch(css, /canvasrefined-reminder/);
    assert.doesNotMatch(css, /canvasrefined-reminders/);
});

function createUnapprovedStartup({ origin = "https://canvas.example.edu", customDomain = ["https://canvas.example.edu"], accounts = [] } = {}) {
    const start = source.indexOf("function isDomainCanvasPage");
    const end = source.indexOf("\nfunction refreshContentSidebar", start);
    assert.ok(start >= 0 && end > start, "content startup helpers are present");

    const calls = { startExtension: 0, abandon: 0, storageSet: 0, reload: 0, timers: 0, listeners: 0 };
    const factory = new Function("calls", "origin", "customDomain", "accounts", `
        const window = { location: new URL(origin) };
        const chrome = {
            storage: {
                sync: {
                    get: async () => ({ custom_domain: customDomain }),
                    set: () => { calls.storageSet += 1; }
                },
                local: { get: async () => ({ "platform.accountMetadata": { accounts } }) },
                onChanged: { addListener: () => { calls.listeners += 1; } }
            }
        };
        const contentContextApi = {
            normalizeCanvasOrigins: (origins) => origins,
            verifiedOriginsFromMetadata: (metadata) => metadata.accounts.map((account) => account.origin),
            isApprovedLocation: (location, state) => location.origin === "https://canvas.emory.edu"
                || (state.configuredOrigins.includes(location.origin) && state.verifiedOrigins.includes(location.origin))
        };
        const phaseOneSettings = (value) => value;
        let options = {};
        const startExtension = () => { calls.startExtension += 1; };
        const abandonTodoInstitutionLogoPrepaint = () => { calls.abandon += 1; };
        const setTimeout = () => { calls.timers += 1; };
        const setInterval = () => { calls.timers += 1; };
        const globalThis = { location: { reload: () => { calls.reload += 1; } } };
        ${source.slice(start, end)}
        return { start: isDomainCanvasPage, calls };
    `);
    return factory(calls, origin, customDomain, accounts);
}

test("separate unverified custom-origin document startups are inert", async () => {
    const documents = [
        createUnapprovedStartup({ accounts: [] }),
        createUnapprovedStartup({ accounts: [{ origin: "https://other.canvas.example.edu" }] })
    ];

    for (const document of documents) {
        document.start();
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(document.calls, {
            startExtension: 0,
            abandon: 1,
            storageSet: 0,
            reload: 0,
            timers: 0,
            listeners: 0
        });
    }
});

test("static Emory and configured verified custom startups initialize without requesting a reload", async () => {
    const documents = [
        createUnapprovedStartup({ origin: "https://canvas.emory.edu", customDomain: [], accounts: [] }),
        createUnapprovedStartup({
            origin: "https://canvas.example.edu",
            customDomain: ["https://canvas.example.edu"],
            accounts: [{ origin: "https://canvas.example.edu" }]
        })
    ];

    for (const document of documents) {
        document.start();
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(document.calls, {
            startExtension: 1,
            abandon: 0,
            storageSet: 0,
            reload: 0,
            timers: 0,
            listeners: 0
        });
    }
});
