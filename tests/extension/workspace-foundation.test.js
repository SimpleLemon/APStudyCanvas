"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const foundation = require("../../js/workspace-foundation.js");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "../..");

test("workspace routes are canonical and preserve nested Settings category compatibility", () => {
    assert.deepEqual(foundation.ROUTES, ["settings", "grades", "planner", "notes", "study"]);
    assert.deepEqual(foundation.parseRoute("?view=workspace&route=planner&category=themes"), { name: "planner", category: "themes" });
    assert.equal(foundation.parseRoute("?route=unknown").name, "settings");
    assert.equal(foundation.routeUrl("https://extension.invalid/html/popup.html?view=workspace", "settings", "themes"), "https://extension.invalid/html/popup.html?view=workspace&category=themes");
    assert.equal(foundation.routeUrl("https://extension.invalid/html/popup.html?view=workspace&category=themes", "notes"), "https://extension.invalid/html/popup.html?view=workspace&route=notes");
});

test("verified account context never promotes display-only profile data", () => {
    const displayOnly = foundation.verifiedAccountContext({
        canvas: { profile: { name: "Canvas Student" }, canvasBinding: { origin: "https://canvas.example.edu", accountKey: "short" } },
        identity: { state: "unavailable", identity: "remembered-user", profile: { name: "Remembered" } }
    });
    assert.equal(displayOnly.scope, null);
    assert.equal(displayOnly.canvas.verified, false);
    assert.equal(displayOnly.nest.verified, false);
    assert.equal(displayOnly.nest.profile, null);

    const key = "a".repeat(64);
    const verified = foundation.verifiedAccountContext({
        canvas: { profile: { name: "Canvas Student" }, canvasBinding: { origin: "https://canvas.example.edu/path", accountKey: key } },
        identity: { state: "authenticated", identity: "nest-user", profile: { name: "Nest Student" }, linkedAccounts: [{ id: "1" }] },
        capabilities: { calendar: true }, consent: { granted: true }
    });
    assert.equal(verified.scope, `canvas:${key}`);
    assert.equal(verified.canvas.origin, "https://canvas.example.edu");
    assert.equal(verified.nest.verified, true);
    assert.deepEqual(verified.nest.capabilities, { calendar: true });
});

test("module host guards dirty transitions and disposes each mounted module once", async () => {
    const events = [];
    let dirty = true;
    const modules = {
        settings: { mount() { events.push("mount:settings"); return { queryDirty: () => dirty, dispose: reason => events.push(`dispose:settings:${reason}`) }; } },
        notes: { mount() { events.push("mount:notes"); return { routeUpdate: route => events.push(`update:${route.name}`), dispose: reason => events.push(`dispose:notes:${reason}`) }; } }
    };
    const host = foundation.createModuleHost({
        modules,
        beforeRoute: (from, to) => events.push(`before:${from || "none"}:${to}`),
        afterRoute: route => events.push(`after:${route}`),
        confirmLeave: () => false
    });
    assert.equal((await host.navigate("settings")).ok, true);
    assert.deepEqual(await host.navigate("notes"), { ok: false, code: "WORKSPACE_DIRTY_BLOCKED", route: "settings" });
    assert.equal(host.route, "settings");
    dirty = false;
    assert.equal((await host.navigate("notes")).ok, true);
    assert.equal((await host.navigate("notes")).reused, true);
    await host.dispose("pagehide");
    await host.dispose("again");
    assert.deepEqual(events, [
        "before:none:settings", "mount:settings", "after:settings",
        "before:settings:notes", "dispose:settings:route-change", "mount:notes", "after:notes",
        "update:notes", "dispose:notes:pagehide"
    ]);
});

test("popup shell exposes persistent routes, honest search copy, and the Foundation entrypoint", () => {
    const popup = fs.readFileSync(path.join(root, "html/popup.html"), "utf8");
    assert.match(popup, /id="workspace-route-nav"[\s\S]*data-workspace-route="settings"[\s\S]*data-workspace-route="grades"[\s\S]*data-workspace-route="planner"[\s\S]*data-workspace-route="notes"[\s\S]*data-workspace-route="study"/);
    assert.match(popup, /Search Canvas and local notes/);
    assert.match(popup, /src="\.\.\/js\/workspace-foundation\.js"/);
    assert.doesNotMatch(popup, /notification-badge[^>]*>\s*[1-9]/, "the shell does not hard-code unread state");
});

test("legacy numeric Canvas account ID is available only with verified binding", () => {
    const binding = { origin: "https://canvas.example.edu", accountKey: "a".repeat(64), canvasUserId: "123" };
    assert.equal(foundation.verifiedAccountContext({ canvas: { canvasBinding: binding } }).canvas.accountId, "123");
    assert.equal(foundation.verifiedAccountContext({ canvas: { canvasBinding: { ...binding, accountKey: "bad" } } }).canvas.accountId, null);
    assert.equal(foundation.verifiedAccountContext({ canvas: { canvasBinding: { ...binding, canvasUserId: "bad" } } }).canvas.accountId, null);
});

test("dirty feature guard blocks navigation and supports synchronous unload state", async () => {
    let dirty = true;
    const host = foundation.createModuleHost({ modules: {
        notes: { mount: () => ({ queryDirty: () => dirty }) },
        grades: { mount: () => ({ queryDirty: () => false }) }
    }, confirmLeave: () => false });
    await host.navigate("notes");
    assert.equal(host.queryDirtySync(), true);
    assert.equal((await host.navigate("grades")).code, "WORKSPACE_DIRTY_BLOCKED");
    dirty = false;
    assert.equal(host.queryDirtySync(), false);
    assert.equal((await host.navigate("grades")).ok, true);
});
