"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const contract = require("../../js/platform/contract.js");
const storage = require("../../js/platform/storage.js");
const router = require("../../js/platform/router.js");
const canvasRegistration = require("../../js/platform/canvas-registration.js");
const contentContext = require("../../js/content/context.js");

const DIAGNOSTICS_SOURCE = fs.readFileSync(path.join(__dirname, "../../js/diagnostics-transport.js"), "utf8");
const SCHEMA_SOURCE = fs.readFileSync(path.join(__dirname, "../../js/settings-schema.js"), "utf8");
const EMORY = "https://canvas.emory.edu";
const OLD = "https://old.canvas.example.edu";
const NEW = "https://new.canvas.example.edu";
const UNRELATED = "https://unrelated.canvas.example.edu";

function clone(value) {
    return typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

function createChromeEnvironment({
    sync = {},
    local = {},
    granted = [],
    registered = [],
    requestResult = true,
    fail = {}
} = {}) {
    const areas = { sync: clone(sync), local: clone(local), session: {} };
    const grantedPatterns = new Set(granted);
    const scripts = clone(registered);
    const events = [];
    const requestCalls = [];
    const removeCalls = [];

    function area(name) {
        return {
            async get(keys) {
                const source = areas[name];
                if (keys === null || keys === undefined) return clone(source);
                const requested = Array.isArray(keys) ? keys : [keys];
                return Object.fromEntries(requested.filter((key) => Object.prototype.hasOwnProperty.call(source, key)).map((key) => [key, clone(source[key])]));
            },
            async set(changes) {
                events.push(`storage:${name}:set`);
                if (name === "local" && Object.prototype.hasOwnProperty.call(changes, "platform.accountMetadata") && fail.metadataPersistOnce) {
                    fail.metadataPersistOnce -= 1;
                    throw new Error("metadata_persist_failed");
                }
                Object.assign(areas[name], clone(changes));
            },
            async remove(keys) {
                events.push(`storage:${name}:remove`);
                for (const key of (Array.isArray(keys) ? keys : [keys])) delete areas[name][key];
            }
        };
    }

    const chromeApi = {
        runtime: { getURL: (url) => `chrome-extension://test-id/${url.replace(/^\//, "")}` },
        storage: { sync: area("sync"), local: area("local"), session: area("session"), onChanged: { addListener() {} } },
        permissions: {
            async contains(query) {
                events.push(`permission:contains:${query.origins[0]}`);
                return query.origins.every((origin) => grantedPatterns.has(origin));
            },
            async request(query) {
                const pattern = query.origins[0];
                events.push(`permission:request:${pattern}`);
                requestCalls.push(clone(query));
                if (fail.request) throw new Error("permission_request_failed");
                if (!requestResult) return false;
                query.origins.forEach((origin) => grantedPatterns.add(origin));
                return true;
            },
            async remove(query) {
                const pattern = query.origins[0];
                events.push(`permission:remove:${pattern}`);
                removeCalls.push(clone(query));
                if (fail.remove) return false;
                query.origins.forEach((origin) => grantedPatterns.delete(origin));
                return true;
            }
        },
        scripting: {
            async getRegisteredContentScripts() {
                events.push("scripts:list");
                if (fail.list) throw new Error("script_list_failed");
                return clone(scripts);
            },
            async registerContentScripts(items) {
                events.push(`scripts:register:${items[0].matches[0]}`);
                if (fail.register) throw new Error("script_register_failed");
                scripts.push(...clone(items));
            },
            async unregisterContentScripts({ ids }) {
                events.push(`scripts:unregister:${ids.join(",")}`);
                if (fail.unregister) throw new Error("script_unregister_failed");
                for (const id of ids) {
                    const index = scripts.findIndex((script) => script.id === id);
                    if (index >= 0) scripts.splice(index, 1);
                }
            }
        },
        tabs: {}
    };

    const platformStorage = storage.createChromeStorageAdapter(chromeApi.storage);
    const registration = canvasRegistration.createCanvasRegistration({ chromeApi });
    const service = router.createRouter({
        chromeApi,
        storage: platformStorage,
        transport: {},
        canvasRegistration: registration
    });
    let requestNumber = 0;
    const request = async (type, payload) => {
        events.push(`platform:${type}:${payload.operation || payload.canvas_transaction || ""}`);
        if (fail.persist && type === "SETTINGS_UPDATE" && payload.canvas_transaction === "persist_only") {
            return { payload: { ok: false, code: "SETTINGS_PERSIST_FAILED" } };
        }
        let response;
        try {
            response = await service.handle(
                contract.createEnvelope(type, clone(payload), `custom-origin-${++requestNumber}`),
                { url: "chrome-extension://test-id/popup.html" }
            );
        } catch (error) {
            events.push(`request-error:${error?.message || error}`);
            throw error;
        }
        events.push(`response:${type}:${response?.payload?.code || response?.payload?.ok}`);
        return response;
    };

    return {
        chromeApi,
        service,
        registration,
        request,
        areas,
        scripts,
        grantedPatterns,
        events,
        requestCalls,
        removeCalls,
        async reconcile() {
            return registration.reconcile({ configuredOrigins: Object.keys(areas.sync).includes("custom_domain") ? areas.sync.custom_domain : [], verifiedOrigins: [] });
        }
    };
}

function loadPopupExport() {
    const context = {
        console: { log() {} },
        URL,
        URLSearchParams,
        Promise,
        Set,
        Map,
        Object,
        Array,
        Number,
        String,
        Boolean,
        Math,
        Date,
        JSON,
        RegExp,
        Error,
        TypeError,
        structuredClone,
        setTimeout,
        clearTimeout,
        crypto: { randomUUID: () => "test-request-id" },
        themes: [],
        document: { addEventListener() {}, getElementById() { return null; } },
        addEventListener() {},
        window: { addEventListener() {} },
        location: { search: "", origin: "chrome-extension://test-id" },
        chrome: null
    };
    context.window = context;
    context.globalThis = context;
    vm.runInNewContext(SCHEMA_SOURCE, context, { filename: "js/settings-schema.js" });
    return (environment) => {
        context.chrome = environment.chromeApi;
        vm.runInNewContext(DIAGNOSTICS_SOURCE, context, { filename: "js/diagnostics-transport.js" });
        return { customDomain: context.APStudyCanvasCustomDomain, diagnostics: context.APStudyCanvasDiagnosticsTransport };
    };
}

async function createFlow(environment, options = {}) {
    const exportFactory = loadPopupExport();
    const { customDomain: api } = exportFactory(environment);
    const configuration = {
        chromeApi: environment.chromeApi,
        windowApi: { confirm: () => true },
        request: environment.request,
        confirm: options.confirm || (() => true),
        sleep: async () => {}
    };
    if (!options.productionVerify) configuration.verifyOrigin = options.verifyOrigin || (async () => ({ ok: true, state: "verified", userId: "canvas-user", profile: { displayName: "Canvas User" } }));
    const flow = api.createFlow(configuration);
    await flow.load();
    return flow;
}

function eventIndex(events, prefix) {
    const index = events.findIndex((event) => event.startsWith(prefix));
    assert.notEqual(index, -1, `missing event ${prefix}`);
    return index;
}

function exactPattern(origin) {
    return `${origin}/*`;
}

function oldScript() {
    const id = canvasRegistration.scriptIdForOrigin(OLD);
    return {
        id,
        matches: [exactPattern(OLD)],
        js: canvasRegistration.CANVAS_CONTENT_SCRIPTS.slice(),
        css: canvasRegistration.CANVAS_CSS.slice(),
        runAt: "document_start"
    };
}

function oldScripts() {
    const id = canvasRegistration.scriptIdForOrigin(OLD);
    return [{ id: `${id}-watchdog`, matches: [exactPattern(OLD)], js: [canvasRegistration.CANVAS_WATCHDOG_SCRIPT], runAt: "document_start", world: "MAIN" }, oldScript()];
}

function attachProductionCanvasTab(environment, { existing = true, status = 200 } = {}) {
    const tab = { id: 73, url: `${NEW}/courses/1` };
    const service = contentContext.createContextService({
        window: { location: new URL(tab.url) },
        document: {
            title: "Canvas",
            querySelector(selector) {
                return selector.includes("#application") || selector.includes("#wrapper.ic-app") || selector.includes(".ic-app") ? {} : null;
            }
        },
        chromeApi: environment.chromeApi,
        fetchImpl: async (url) => {
            if (status !== 200) return { ok: false, status, async json() { return {}; } };
            if (String(url).endsWith("/profile")) return { ok: true, status: 200, async json() { return { id: "canvas-user", time_zone: "America/New_York" }; } };
            return { ok: true, status: 200, async json() { return { id: "canvas-user", name: "Canvas User" }; } };
        }
    });
    const reloads = [];
    environment.chromeApi.tabs = {
        async query(query) {
            environment.events.push(`tabs:query:${query.url?.[0] || ""}`);
            return existing ? [clone(tab)] : [];
        },
        async create({ url }) {
            environment.events.push(`tabs:create:${url}`);
            return { ...tab, url };
        },
        async reload(tabId) {
            environment.events.push(`tabs:reload:${tabId}`);
            reloads.push(tabId);
        },
        async sendMessage(tabId, message) {
            environment.events.push(`tabs:send:${tabId}:${message.type}`);
            assert.equal(tabId, tab.id);
            assert.equal(message.type, "CANVAS_ACCOUNT_VERIFY");
            return service.verifyAccount(message.payload);
        }
    };
    return { tab, reloads };
}

test("denial requests only exact origin/* and leaves registration and metadata untouched", async () => {
    const environment = createChromeEnvironment({ requestResult: false });
    const flow = await createFlow(environment);
    await assert.rejects(flow.save(NEW), (error) => error.code === "permission_denied");
    assert.deepEqual(environment.requestCalls, [{ origins: [exactPattern(NEW)] }]);
    assert.equal(environment.scripts.length, 0);
    assert.deepEqual(environment.areas.sync, {});
    assert.deepEqual(environment.areas.local, {});
    assert.deepEqual(environment.events.filter((event) => event.startsWith("scripts:register")), []);
});

test("invalid custom origins are rejected before requesting permission or persisting", async () => {
    const environment = createChromeEnvironment();
    const flow = await createFlow(environment);
    await assert.rejects(flow.save("http://canvas.example.edu"), (error) => error.code === "SETTINGS_VALUE_INVALID");
    assert.deepEqual(environment.requestCalls, []);
    assert.deepEqual(environment.areas.sync, {});
    assert.deepEqual(environment.areas.local, {});
});

test("diagnostics inspector sends the supported inspect message only to an eligible Canvas source tab", async () => {
    const environment = createChromeEnvironment();
    const { diagnostics } = loadPopupExport()(environment);
    await assert.rejects(diagnostics.inspectCanvas(), (error) => error.code === "SOURCE_TAB_UNAVAILABLE");

    const messages = [];
    environment.chromeApi.tabs = {
        async query() { return [{ id: 42, url: `${EMORY}/courses/1` }]; },
        async sendMessage(tabId, message) { messages.push([tabId, clone(message)]); return { selectors: ".canvas" }; }
    };
    assert.deepEqual(await diagnostics.inspectCanvas(), { selectors: ".canvas" });
    assert.deepEqual(messages, [[42, { message: "inspect", options: {} }]]);

    environment.chromeApi.tabs.sendMessage = async () => { throw new Error("content_unavailable"); };
    await assert.rejects(diagnostics.inspectCanvas(), /content_unavailable/);
});

test("successful custom-origin transaction persists provisional configuration before verification", async () => {
    const environment = createChromeEnvironment();
    const flow = await createFlow(environment, {
        verifyOrigin: async () => {
            environment.events.push("verify:custom-origin");
            return { ok: true, state: "verified", userId: "canvas-user", profile: { displayName: "Canvas User" } };
        }
    });
    const result = await flow.save(NEW);
    assert.equal(result.ok, true);
    assert.deepEqual(environment.requestCalls, [{ origins: [exactPattern(NEW)] }]);
    assert.deepEqual(environment.areas.sync.custom_domain, [NEW]);
    assert.equal(environment.areas.local["platform.accountMetadata"].accounts[0].origin, NEW);
    assert.deepEqual(environment.scripts.map((script) => script.matches), [[exactPattern(NEW)], [exactPattern(NEW)]]);
    const watchdogScript = environment.scripts.find((script) => script.id.endsWith("-watchdog"));
    const contentScript = environment.scripts.find((script) => script.id === canvasRegistration.scriptIdForOrigin(NEW));
    assert.equal(watchdogScript.id, `${canvasRegistration.scriptIdForOrigin(NEW)}-watchdog`);
    assert.deepEqual(watchdogScript.js, [canvasRegistration.CANVAS_WATCHDOG_SCRIPT]);
    assert.deepEqual(watchdogScript.css || [], []);
    assert.equal(watchdogScript.world, "MAIN");
    assert.equal(watchdogScript.runAt, "document_start");
    assert.equal(contentScript.id, canvasRegistration.scriptIdForOrigin(NEW));
    assert.deepEqual(contentScript.js, canvasRegistration.CANVAS_CONTENT_SCRIPTS);
    assert.deepEqual(contentScript.css, canvasRegistration.CANVAS_CSS);
    assert.equal(contentScript.runAt, "document_start");
    assert.equal(new Set(environment.scripts.map((script) => script.id)).size, 2, "one stable watchdog and one stable Canvas registration");
    assert.ok(eventIndex(environment.events, `permission:request:${exactPattern(NEW)}`) < eventIndex(environment.events, `scripts:register:${exactPattern(NEW)}`));
    assert.ok(eventIndex(environment.events, `scripts:register:${exactPattern(NEW)}`) < eventIndex(environment.events, "storage:sync:set"));
    assert.ok(eventIndex(environment.events, "storage:sync:set") < eventIndex(environment.events, "verify:custom-origin"));
    assert.ok(eventIndex(environment.events, "platform:SETTINGS_UPDATE:persist_only") < environment.events.length);
});

test("production custom-origin verification sees provisional configuration and reloads an existing target once", async () => {
    const environment = createChromeEnvironment();
    const target = attachProductionCanvasTab(environment);
    const flow = await createFlow(environment, { productionVerify: true });

    const result = await flow.save(NEW);

    assert.equal(result.ok, true);
    assert.deepEqual(environment.areas.sync.custom_domain, [NEW]);
    assert.deepEqual(environment.areas.local["platform.accountMetadata"].accounts.map((account) => account.origin), [NEW]);
    assert.deepEqual(target.reloads, [target.tab.id], "an already-open target receives one deliberate post-registration reload");
    assert.ok(eventIndex(environment.events, "storage:sync:set") < eventIndex(environment.events, `tabs:reload:${target.tab.id}`));
    assert.ok(eventIndex(environment.events, `tabs:reload:${target.tab.id}`) < eventIndex(environment.events, `tabs:send:${target.tab.id}:CANVAS_ACCOUNT_VERIFY`));
    assert.equal(environment.events.filter((event) => event === `tabs:reload:${target.tab.id}`).length, 1);
});

test("verification failure unregisters the new origin, removes only its new permission, and restores prior state", async () => {
    const previousMetadata = { version: 1, accounts: [{ origin: OLD, accountId: "old-user", verifiedAt: 1 }] };
    const environment = createChromeEnvironment({
        sync: { custom_domain: [OLD] },
        local: { "platform.accountMetadata": previousMetadata },
        granted: [exactPattern(OLD), exactPattern(UNRELATED)],
        registered: oldScripts()
    });
    const target = attachProductionCanvasTab(environment, { status: 401 });
    const flow = await createFlow(environment, { productionVerify: true });
    await assert.rejects(flow.save(NEW), (error) => error.code === "CANVAS_ACCOUNT_NOT_AUTHENTICATED");
    assert.deepEqual(environment.areas.sync.custom_domain, [OLD]);
    assert.deepEqual(environment.areas.local["platform.accountMetadata"], previousMetadata);
    assert.deepEqual(environment.scripts.map((script) => script.matches), [[exactPattern(OLD)], [exactPattern(OLD)]]);
    assert.equal(environment.grantedPatterns.has(exactPattern(OLD)), true);
    assert.equal(environment.grantedPatterns.has(exactPattern(NEW)), false);
    assert.equal(environment.grantedPatterns.has(exactPattern(UNRELATED)), true);
    assert.deepEqual(environment.removeCalls, [{ origins: [exactPattern(NEW)] }]);
    assert.equal(environment.events.filter((event) => event.startsWith("scripts:unregister")).length >= 1, true);
    assert.deepEqual(target.reloads, [target.tab.id]);
});

test("persist failure restores the old domain registration, metadata, and permission", async () => {
    const previousMetadata = { version: 1, accounts: [{ origin: OLD, accountId: "old-user", verifiedAt: 1 }] };
    const environment = createChromeEnvironment({
        sync: { custom_domain: [OLD] },
        local: { "platform.accountMetadata": previousMetadata },
        granted: [exactPattern(OLD), exactPattern(UNRELATED)],
        registered: oldScripts(),
        fail: { persist: true }
    });
    const flow = await createFlow(environment);
    await assert.rejects(flow.save(NEW), (error) => error.code === "SETTINGS_PERSIST_FAILED");
    assert.deepEqual(environment.areas.sync.custom_domain, [OLD]);
    assert.deepEqual(environment.areas.local["platform.accountMetadata"], previousMetadata);
    assert.deepEqual(environment.scripts.map((script) => script.matches), [[exactPattern(OLD)], [exactPattern(OLD)]]);
    assert.equal(environment.grantedPatterns.has(exactPattern(OLD)), true);
    assert.equal(environment.grantedPatterns.has(exactPattern(NEW)), false);
    assert.equal(environment.grantedPatterns.has(exactPattern(UNRELATED)), true);
    assert.deepEqual(environment.removeCalls, [{ origins: [exactPattern(NEW)] }]);
});

test("verified-metadata persistence failure restores provisional configuration, registration, and permission", async () => {
    const previousMetadata = { version: 1, accounts: [{ origin: OLD, accountId: "old-user", verifiedAt: 1 }] };
    const environment = createChromeEnvironment({
        sync: { custom_domain: [OLD] },
        local: { "platform.accountMetadata": previousMetadata },
        granted: [exactPattern(OLD), exactPattern(UNRELATED)],
        registered: oldScripts(),
        fail: { metadataPersistOnce: 1 }
    });
    const flow = await createFlow(environment);
    const failure = await flow.save(NEW).then(() => null, (error) => error);
    assert.equal(failure?.code, "metadata_persist_failed");
    assert.deepEqual(environment.areas.sync.custom_domain, [OLD]);
    assert.deepEqual(environment.areas.local["platform.accountMetadata"], previousMetadata);
    assert.deepEqual(environment.scripts.map((script) => script.matches), [[exactPattern(OLD)], [exactPattern(OLD)]]);
    assert.equal(environment.grantedPatterns.has(exactPattern(NEW)), false);
    assert.equal(environment.grantedPatterns.has(exactPattern(OLD)), true);
    assert.equal(environment.grantedPatterns.has(exactPattern(UNRELATED)), true);
});

test("explicit removal unregisters and removes only the exact old origin", async () => {
    const environment = createChromeEnvironment({
        sync: { custom_domain: [OLD] },
        local: { "platform.accountMetadata": { version: 1, accounts: [{ origin: OLD, accountId: "old-user", verifiedAt: 1 }] } },
        granted: [exactPattern(OLD), exactPattern(UNRELATED)],
        registered: oldScripts()
    });
    const flow = await createFlow(environment);
    const result = await flow.save("");
    assert.equal(result.ok, true);
    assert.deepEqual(environment.areas.sync.custom_domain, []);
    assert.deepEqual(environment.areas.local["platform.accountMetadata"].accounts, []);
    assert.equal(environment.scripts.length, 0);
    assert.deepEqual(environment.removeCalls, [{ origins: [exactPattern(OLD)] }]);
    assert.equal(environment.grantedPatterns.has(exactPattern(OLD)), false);
    assert.equal(environment.grantedPatterns.has(exactPattern(UNRELATED)), true);
    assert.deepEqual(environment.requestCalls, []);
});

test("Emory is static and never prompts for optional permission", async () => {
    const environment = createChromeEnvironment();
    const flow = await createFlow(environment);
    const result = await flow.save(EMORY);
    assert.equal(result.ok, true);
    assert.deepEqual(environment.requestCalls, []);
    assert.deepEqual(environment.scripts, []);
    assert.deepEqual(environment.areas.sync.custom_domain, [EMORY]);
});

test("startup reconciliation checks existing permission but never calls permissions.request", async () => {
    const environment = createChromeEnvironment({
        sync: { custom_domain: [NEW] },
        granted: [exactPattern(NEW)]
    });
    const result = await environment.registration.reconcile({ configuredOrigins: [NEW], verifiedOrigins: [NEW] });
    assert.equal(result[0].ok, true);
    assert.equal(environment.requestCalls.length, 0);
    assert.deepEqual(environment.events.filter((event) => event.startsWith("permission:request")), []);
});

test("permission-event reconciliation preserves only active exact-origin transactions until durable verification settles", async () => {
    const other = "https://other.canvas.example.edu";
    const environment = createChromeEnvironment({ granted: [exactPattern(NEW), exactPattern(other)] });

    // This is the state reached after permissions.onAdded, registration, and
    // before the popup has written its account/configuration records.
    await environment.registration.ensureOrigin(NEW, { configuredOrigins: [NEW] });
    await environment.registration.ensureOrigin(other, { configuredOrigins: [other] });
    assert.equal(environment.scripts.length, 4);

    // An onAdded snapshot is still empty. It must not classify either active
    // transaction as stale, including when the two origins interleave.
    await environment.registration.reconcile({ configuredOrigins: [], verifiedOrigins: [] });
    assert.equal(environment.scripts.length, 4);

    // One origin reaches durable configured + verified state while the other
    // remains mid-transaction. Both remain, but only the first is now durable.
    await environment.registration.reconcile({ configuredOrigins: [NEW], verifiedOrigins: [NEW] });
    assert.equal(environment.scripts.length, 4);

    // A later stale snapshot can no longer retain the committed origin. The
    // still-active second transaction remains protected until it settles.
    await environment.registration.reconcile({ configuredOrigins: [], verifiedOrigins: [] });
    assert.deepEqual(environment.scripts.map((script) => script.matches), [[exactPattern(other)], [exactPattern(other)]]);
});

test("transaction rollback, revoked permission, and worker restart fail closed for pending registrations", async () => {
    const environment = createChromeEnvironment({ granted: [exactPattern(NEW)] });
    await environment.registration.ensureOrigin(NEW, { configuredOrigins: [NEW] });
    assert.equal(environment.scripts.length, 2);

    // A flow failure compensates through unregister; a queued reconciliation
    // cannot resurrect the script after that rollback.
    await Promise.all([
        environment.registration.unregisterOrigin(NEW),
        environment.registration.reconcile({ configuredOrigins: [], verifiedOrigins: [] })
    ]);
    assert.equal(environment.scripts.length, 0);

    await environment.registration.ensureOrigin(NEW, { configuredOrigins: [NEW] });
    environment.grantedPatterns.delete(exactPattern(NEW));
    await environment.registration.reconcile({ configuredOrigins: [], verifiedOrigins: [] });
    assert.equal(environment.scripts.length, 0, "a pending origin without its exact permission is removed");

    environment.grantedPatterns.add(exactPattern(NEW));
    await environment.registration.ensureOrigin(NEW, { configuredOrigins: [NEW] });
    const restartedWorker = canvasRegistration.createCanvasRegistration({ chromeApi: environment.chromeApi });
    await restartedWorker.reconcile({ configuredOrigins: [], verifiedOrigins: [] });
    assert.equal(environment.scripts.length, 0, "a restarted worker does not retain an interrupted unverified transaction");
});

test("rollback API failure is surfaced as CANVAS_TRANSACTION_ROLLBACK_FAILED", async () => {
    const environment = createChromeEnvironment({ fail: { unregister: true } });
    const flow = await createFlow(environment, { verifyOrigin: async () => ({ ok: false, code: "canvas_verification_required" }) });
    await assert.rejects(flow.save(NEW), (error) => error.code === "CANVAS_TRANSACTION_ROLLBACK_FAILED");
});

test("settings save/read/reset covers dark mode, sidebar, aliases, and value rejection", async () => {
    const environment = createChromeEnvironment({ sync: { dark_mode: true, sidebar_scale: 100, keep_me: "untouched" } });
    async function request(type, payload) {
        return environment.service.handle(contract.createEnvelope(type, payload, `settings-${type}-${Date.now()}-${Math.random()}`), { url: "chrome-extension://test-id/popup.html" });
    }

    const saved = await request("SETTINGS_UPDATE", { area: "sync", changes: { dark_mode: false, sidebar_scale: 115 } });
    assert.equal(saved.payload.ok, true);
    const read = await request("SETTINGS_READ", { area: "sync", keys: ["dark_mode", "sidebar_scale"] });
    assert.deepEqual(read.payload.values, { dark_mode: false, sidebar_scale: 115 });

    const alias = await request("SETTINGS_UPDATE", { area: "sync", changes: { gradent_cards: true } });
    assert.equal(alias.payload.ok, true);
    assert.equal(environment.areas.sync.gradient_cards, true);
    assert.equal(environment.areas.sync.gradent_cards, true);
    const aliasConflict = await request("SETTINGS_UPDATE", { area: "sync", changes: { gradient_cards: true, gradent_cards: false } });
    assert.equal(aliasConflict.payload.results.gradent_cards.code, "SETTINGS_ALIAS_CONFLICT");

    const invalid = await request("SETTINGS_UPDATE", { area: "sync", changes: { dark_mode: "yes", sidebar_scale: "large" } });
    assert.equal(invalid.payload.ok, false);
    assert.equal(invalid.payload.results.dark_mode.code, "SETTINGS_VALUE_INVALID");
    assert.equal(invalid.payload.results.sidebar_scale.code, "SETTINGS_VALUE_INVALID");
    assert.equal(environment.areas.sync.dark_mode, false);
    assert.equal(environment.areas.sync.sidebar_scale, 115);

    const reset = await request("SETTINGS_RESET", { area: "sync", keys: ["dark_mode", "sidebar_scale", "gradent_cards"] });
    assert.equal(reset.payload.ok, true);
    assert.equal(environment.areas.sync.dark_mode, undefined);
    assert.equal(environment.areas.sync.sidebar_scale, undefined);
    assert.equal(environment.areas.sync.gradient_cards, undefined);
    assert.equal(environment.areas.sync.gradent_cards, undefined);
    assert.equal(environment.areas.sync.keep_me, "untouched");
});
