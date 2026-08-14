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

const POPUP_SOURCE = fs.readFileSync(path.join(__dirname, "../../js/popup.js"), "utf8");
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
        fullscreen: {},
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
        vm.runInNewContext(POPUP_SOURCE, context, { filename: "js/popup.js" });
        return context.APStudyCanvasCustomDomain;
    };
}

async function createFlow(environment, options = {}) {
    const exportFactory = loadPopupExport();
    const api = exportFactory(environment);
    const flow = api.createFlow({
        chromeApi: environment.chromeApi,
        windowApi: { confirm: () => true },
        request: environment.request,
        verifyOrigin: options.verifyOrigin || (async () => ({ ok: true, state: "verified", userId: "canvas-user", profile: { displayName: "Canvas User" } })),
        confirm: options.confirm || (() => true),
        sleep: async () => {}
    });
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

test("successful custom-origin transaction orders request, register, verify, and persist", async () => {
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
    assert.deepEqual(environment.scripts.map((script) => script.matches), [[exactPattern(NEW)]]);
    assert.ok(eventIndex(environment.events, `permission:request:${exactPattern(NEW)}`) < eventIndex(environment.events, `scripts:register:${exactPattern(NEW)}`));
    assert.ok(eventIndex(environment.events, `scripts:register:${exactPattern(NEW)}`) < eventIndex(environment.events, "verify:custom-origin"));
    assert.ok(eventIndex(environment.events, "verify:custom-origin") < eventIndex(environment.events, "storage:sync:set"));
    assert.ok(eventIndex(environment.events, "platform:SETTINGS_UPDATE:persist_only") < environment.events.length);
});

test("verification failure unregisters the new origin, removes only its new permission, and restores prior state", async () => {
    const previousMetadata = { version: 1, accounts: [{ origin: OLD, accountId: "old-user", verifiedAt: 1 }] };
    const environment = createChromeEnvironment({
        sync: { custom_domain: [OLD] },
        local: { "platform.accountMetadata": previousMetadata },
        granted: [exactPattern(OLD), exactPattern(UNRELATED)],
        registered: [oldScript()]
    });
    const flow = await createFlow(environment, { verifyOrigin: async () => ({ ok: false, code: "canvas_verification_required" }) });
    await assert.rejects(flow.save(NEW), (error) => error.code === "canvas_verification_required");
    assert.deepEqual(environment.areas.sync.custom_domain, [OLD]);
    assert.deepEqual(environment.areas.local["platform.accountMetadata"], previousMetadata);
    assert.deepEqual(environment.scripts.map((script) => script.matches), [[exactPattern(OLD)]]);
    assert.equal(environment.grantedPatterns.has(exactPattern(OLD)), true);
    assert.equal(environment.grantedPatterns.has(exactPattern(NEW)), false);
    assert.equal(environment.grantedPatterns.has(exactPattern(UNRELATED)), true);
    assert.deepEqual(environment.removeCalls, [{ origins: [exactPattern(NEW)] }]);
    assert.equal(environment.events.filter((event) => event.startsWith("scripts:unregister")).length >= 1, true);
});

test("persist failure restores the old domain registration, metadata, and permission", async () => {
    const previousMetadata = { version: 1, accounts: [{ origin: OLD, accountId: "old-user", verifiedAt: 1 }] };
    const environment = createChromeEnvironment({
        sync: { custom_domain: [OLD] },
        local: { "platform.accountMetadata": previousMetadata },
        granted: [exactPattern(OLD), exactPattern(UNRELATED)],
        registered: [oldScript()],
        fail: { persist: true }
    });
    const flow = await createFlow(environment);
    await assert.rejects(flow.save(NEW), (error) => error.code === "SETTINGS_PERSIST_FAILED");
    assert.deepEqual(environment.areas.sync.custom_domain, [OLD]);
    assert.deepEqual(environment.areas.local["platform.accountMetadata"], previousMetadata);
    assert.deepEqual(environment.scripts.map((script) => script.matches), [[exactPattern(OLD)]]);
    assert.equal(environment.grantedPatterns.has(exactPattern(OLD)), true);
    assert.equal(environment.grantedPatterns.has(exactPattern(NEW)), false);
    assert.equal(environment.grantedPatterns.has(exactPattern(UNRELATED)), true);
    assert.deepEqual(environment.removeCalls, [{ origins: [exactPattern(NEW)] }]);
});

test("explicit removal unregisters and removes only the exact old origin", async () => {
    const environment = createChromeEnvironment({
        sync: { custom_domain: [OLD] },
        local: { "platform.accountMetadata": { version: 1, accounts: [{ origin: OLD, accountId: "old-user", verifiedAt: 1 }] } },
        granted: [exactPattern(OLD), exactPattern(UNRELATED)],
        registered: [oldScript()]
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
