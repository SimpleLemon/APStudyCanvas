"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const contract = require("../../js/platform/contract.js");
const routerModule = require("../../js/platform/router.js");
const scriptBlocker = require("../../js/platform/script-blocker.js");

function makeDnr() {
    const sessionRules = new Map();
    const enabledRulesets = new Set(["ruleset_tool_scripts"]);
    return {
        sessionRules,
        enabledRulesets,
        async getSessionRules() {
            return Array.from(sessionRules.values());
        },
        async updateSessionRules({ addRules = [], removeRuleIds = [] } = {}) {
            removeRuleIds.forEach((id) => sessionRules.delete(id));
            addRules.forEach((rule) => sessionRules.set(rule.id, rule));
        },
        async updateEnabledRulesets({ enableRulesetIds = [], disableRulesetIds = [] } = {}) {
            enableRulesetIds.forEach((id) => enabledRulesets.add(id));
            disableRulesetIds.forEach((id) => enabledRulesets.delete(id));
        }
    };
}

function makeChromeApi({ dnr = makeDnr(), tabs = {} } = {}) {
    return { declarativeNetRequest: dnr, tabs };
}

test("dashboard path matching accepts only https dashboard URLs on allowed Canvas origins", () => {
    assert.equal(scriptBlocker.isDashboardPath("/"), true);
    assert.equal(scriptBlocker.isDashboardPath("/dashboard"), true);
    assert.equal(scriptBlocker.isDashboardPath("/dashboard/"), true);
    assert.equal(scriptBlocker.isDashboardPath("/courses/1"), false);
    assert.equal(scriptBlocker.isDashboardPath("/dashboard-ish"), false);
    assert.equal(scriptBlocker.isDashboardUrl("https://canvas.emory.edu/"), true);
    assert.equal(scriptBlocker.isDashboardUrl("https://canvas.emory.edu/dashboard"), true);
    assert.equal(scriptBlocker.isDashboardUrl("http://canvas.emory.edu/"), false);
    assert.equal(scriptBlocker.isDashboardUrl("https://canvas.emory.edu/courses/123"), false);
    assert.equal(scriptBlocker.isDashboardUrl("https://example.com/"), false, "path-only matches must not extend to other hosts");
    assert.equal(scriptBlocker.isDashboardUrl("https://canvas.example.edu/", ["https://canvas.example.edu"]), true, "configured custom origins are honored");
    assert.equal(scriptBlocker.isDashboardUrl("not a url"), false);
    assert.equal(scriptBlocker.isDashboardUrl(undefined), false);
});

test("enabled chunk ids map the settings onto the fingerprinted bundles", () => {
    assert.deepEqual(scriptBlocker.enabledChunkIds({ planner: false, editor: false }), []);
    // The planner block is a no-op pending recalibration: Instructure
    // reassigned its fingerprinted chunk id (929552) to the dashboard
    // feature bundle, and blocking it broke the course cards.
    assert.deepEqual(scriptBlocker.enabledChunkIds({ planner: true, editor: false }), []);
    assert.deepEqual(scriptBlocker.enabledChunkIds({ planner: false, editor: true }), ["468836", "833875", "549009", "465767"]);
    assert.deepEqual(scriptBlocker.enabledChunkIds({ planner: true, editor: true }), ["468836", "833875", "549009", "465767"]);
});

test("planner compatibility data cannot activate chunk blocking", () => {
    assert.deepEqual(
        scriptBlocker.enabledChunkIds({ editor: false, planner: true, block_planner_script: true }),
        [],
        "the retired planner preference is not a DNR input"
    );
});

test("session rules are tab-scoped script blocks keyed by stable chunk ids", () => {
    const rules = scriptBlocker.chunkSessionRules(42, ["929552", "468836"]);
    assert.equal(rules.length, 2);
    assert.deepEqual(rules.map((rule) => rule.id), [421, 422]);
    rules.forEach((rule) => {
        assert.equal(rule.priority, 1);
        assert.deepEqual(rule.condition.tabIds, [42]);
        assert.deepEqual(rule.condition.resourceTypes, ["script"]);
        assert.deepEqual(rule.action, { type: "block" });
        assert.match(rule.condition.urlFilter, /^\|\|du11hjcvx0uqb\.cloudfront\.net\/dist\/webpack-production\/\d+-chunk-$/);
    });
    assert.equal(scriptBlocker.chunkUrlFilter("929552"), "||du11hjcvx0uqb.cloudfront.net/dist/webpack-production/929552-chunk-");
    // Ids stay stable per tab+slot and never collide across adjacent slots.
    assert.equal(scriptBlocker.sessionRuleId(7, 0), scriptBlocker.sessionRuleId(7, 0));
    assert.notEqual(scriptBlocker.sessionRuleId(7, 0), scriptBlocker.sessionRuleId(8, 0));
});

test("coordinator applies dashboard rules, clears on navigation away, and fails open on report", async () => {
    const dnr = makeDnr();
    const chromeApi = makeChromeApi({ dnr });
    const coordinator = scriptBlocker.createScriptBlockCoordinator({
        chromeApi,
        readSettings: async () => ({ tool: true, editor: true, planner: true })
    });
    assert.equal(coordinator.isReady(), true);

    const dashboard = await coordinator.applyForTab(11, "https://canvas.emory.edu/");
    assert.equal(dashboard.blocked, 4);
    assert.equal(dnr.sessionRules.size, 4);

    const navigationAway = await coordinator.applyForTab(11, "https://canvas.emory.edu/courses/9");
    assert.equal(navigationAway.removed, 4);
    assert.equal(dnr.sessionRules.size, 0);

    await coordinator.applyForTab(12, "https://canvas.emory.edu/dashboard");
    assert.equal(dnr.sessionRules.size, 4);
    await coordinator.handleReport(12);
    assert.equal(dnr.sessionRules.size, 0, "fail-open report drops the tab's session rules");
});

test("coordinator respects settings, tolerates failing reads, and toggles the tool ruleset", async () => {
    const dnr = makeDnr();
    const chromeApi = makeChromeApi({ dnr });
    const coordinator = scriptBlocker.createScriptBlockCoordinator({
        chromeApi,
        readSettings: async () => ({ tool: false, editor: false, planner: true })
    });

    const result = await coordinator.applyForTab(21, "https://canvas.emory.edu/");
    assert.equal(result.blocked, 0, "editor switch off leaves no chunk blocks: the planner block is a no-op pending recalibration");
    assert.equal(dnr.sessionRules.size, 0);

    const toolState = await coordinator.applyToolRuleset();
    assert.equal(toolState.enabled, false);
    assert.equal(dnr.enabledRulesets.has("ruleset_tool_scripts"), false);

    const broken = scriptBlocker.createScriptBlockCoordinator({
        chromeApi,
        readSettings: async () => {
            throw new Error("storage offline");
        }
    });
    const safe = await broken.applyForTab(22, "https://canvas.emory.edu/");
    assert.equal(safe.blocked, 0, "failing settings read fails open with no rules");
    assert.equal(dnr.sessionRules.size, 0, "existing rules from the healthy coordinator stay untouched");
});

test("coordinator without declarativeNetRequest stays a no-op", async () => {
    const coordinator = scriptBlocker.createScriptBlockCoordinator({
        chromeApi: { tabs: {} },
        readSettings: async () => ({ tool: true, editor: true, planner: true })
    });
    assert.equal(coordinator.isReady(), false);
    const applied = await coordinator.applyForTab(3, "https://canvas.emory.edu/");
    assert.equal(applied.blocked, 0);
    const synced = await coordinator.syncFromSettings();
    assert.deepEqual(synced, { enabled: null, tabs: 0 }, "no-op coordinator reports neutral results");
});

test("coordinator syncs existing tabs and ignores tabs without ids", async () => {
    const dnr = makeDnr();
    let queried = 0;
    const chromeApi = makeChromeApi({
        dnr,
        tabs: {
            async query() {
                queried += 1;
                return [
                    { id: 31, url: "https://canvas.emory.edu/dashboard" },
                    { id: 32, url: "https://canvas.emory.edu/courses/5" },
                    { url: "https://canvas.emory.edu/" },
                    { id: 33, url: "https://example.com/" }
                ];
            }
        }
    });
    const coordinator = scriptBlocker.createScriptBlockCoordinator({
        chromeApi,
        readSettings: async () => ({ tool: true, editor: true, planner: true })
    });
    const synced = await coordinator.syncAllTabs();
    assert.equal(queried, 1);
    assert.equal(synced.tabs, 3);
    assert.equal(dnr.sessionRules.size, 4, "only the dashboard tab receives the four chunk blocks");
    assert.ok(Array.from(dnr.sessionRules.values()).every((rule) => rule.condition.tabIds[0] === 31));
});

test("the fail-open report travels the platform envelope contract", () => {
    const envelope = contract.createEnvelope("CANVAS_SCRIPT_BLOCK_REPORT", { outcome: "dashboard_fail_open" });
    assert.equal(envelope.type, "CANVAS_SCRIPT_BLOCK_REPORT");
    const validation = contract.validateEnvelope(envelope);
    assert.equal(validation.ok, true);

    const router = routerModule.createRouter({ storage: { async get() { return {}; } } });
    assert.ok(router.constants.SCRIPT_BLOCK_FAMILIES.has("CANVAS_SCRIPT_BLOCK_REPORT"));
    assert.equal(router.constants.SCRIPT_BLOCK_FAMILIES.has("CANVAS_SYNC_START"), false);
});
