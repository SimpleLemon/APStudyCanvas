"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const contract = require("../../js/platform/contract.js");
const storage = require("../../js/platform/storage.js");
const transport = require("../../js/platform/transport.js");
const router = require("../../js/platform/router.js");

const root = path.resolve(__dirname, "../..");
const popupSource = fs.readFileSync(path.join(root, "js/popup.js"), "utf8");
const accountKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const sourceKey = `canvas:${accountKey}`;
const sender = { url: "chrome-extension://test-id/html/popup.html" };

function response(status, body, headers = { "content-type": "application/json" }) {
    const entries = Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]);
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { forEach(callback) { entries.forEach(([key, value]) => callback(value, key)); } },
        async text() { return JSON.stringify(body); }
    };
}

function producerConsent(overrides = {}) {
    const consent = {
        version: 1, sourceKey, source_key: sourceKey, accountKey, account_key: accountKey,
        current: true, granted: false, state: "not_granted", scopes: [], ...overrides
    };
    return {
        contractVersion: 1, ok: true, consent, version: consent.version,
        current: consent.current, granted: consent.granted, scopes: consent.scopes, sourceKey: consent.sourceKey
    };
}

function testNode() {
    const listeners = new Map();
    return {
        checked: false, disabled: false, hidden: false, inert: false, textContent: "", dataset: {},
        classList: { toggle() {} }, setAttribute() {},
        addEventListener(type, listener) { listeners.set(type, [...(listeners.get(type) || []), listener]); },
        removeEventListener() {},
        dispatch(type) { for (const listener of listeners.get(type) || []) listener({ currentTarget: this, stopPropagation() {}, stopImmediatePropagation() {} }); }
    };
}

function harness(initialBody) {
    let producerBody = initialBody;
    const fetches = [];
    const nest = transport.createNestTransport({
        fetchImpl: async (url, options) => {
            fetches.push({ url, method: options.method });
            return response(200, producerBody);
        }
    });
    const service = router.createRouter({
        chromeApi: { runtime: { getURL: (value) => `chrome-extension://test-id/${String(value).replace(/^\//, "")}` } },
        storage: storage.createMemoryStorage({ sync: {}, local: {}, session: {} }),
        transport: nest
    });
    const elements = Object.fromEntries(["#nest-consent-enabled", "#nest-consent-refresh", "#nest-consent-status"].map((key) => [key, testNode()]));
    const document = { querySelector: (key) => elements[key] || null, querySelectorAll: () => [], getElementById: () => null };
    const localStorage = { get: async () => ({}), set: async () => undefined };
    const chrome = { runtime: {}, storage: { local: localStorage, sync: localStorage } };
    const context = vm.createContext({ URL, URLSearchParams, setTimeout, clearTimeout, console, window: {}, document, chrome });
    context.dispatchMessage = (message) => service.handle(JSON.parse(JSON.stringify(message)), sender);
    context.APStudyCanvasPlatform = { Contract: {
        ...contract,
        createEnvelope(type, payload, requestId) {
            return contract.createEnvelope(type, JSON.parse(JSON.stringify(payload)), requestId);
        }
    } };
    vm.runInContext(`chrome.runtime.sendMessage = message => dispatchMessage(message).then(value => JSON.parse(JSON.stringify(value)))`, context);
    vm.runInContext(fs.readFileSync(path.join(root, "js/settings-schema.js"), "utf8"), context);
    vm.runInContext(popupSource.slice(0, popupSource.indexOf("function queueSettingWrite")), context);
    return {
        elements, fetches,
        setBody(value) { producerBody = value; },
        run(code) { return vm.runInContext(code, context); },
        json(code) { return JSON.parse(vm.runInContext(`JSON.stringify(${code})`, context)); },
        async settle() { for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setImmediate(resolve)); }
    };
}

test("producer empty consent survives real transport and router before popup normalization", async () => {
    const h = harness(producerConsent());
    const normalized = await h.run(`popupPlatformRequest("NEST_CONSENT_GET", {
        source_key: "${sourceKey}", account_key: "${accountKey}", version: 1
    }).then(result => popupCalendarNormalizeConsent(result, {
        sourceKey: "${sourceKey}", accountKey: "${accountKey}"
    }))`);
    assert.deepEqual(JSON.parse(JSON.stringify(normalized)), {
        valid: true, current: false, revoked: false, sourceKey, accountKey, version: 1, scopes: [], code: null
    });
    assert.equal(h.fetches.length, 1);
    assert.equal(h.fetches[0].method, "GET");
});

test("synchronous consent-failure publication does not auto-retry without prior consent", async () => {
    const h = harness(producerConsent());
    h.run(`
        globalThis.binding = { accountKey: "${accountKey}", sourceKey: "${sourceKey}", origin: "https://canvas.emory.edu", canvasUserId: "123", label: "Canvas", extraction: "supported" };
        globalThis.snapshot = { generation: 1, identity: { state: "authenticated" }, binding, capabilities: {}, consent: null };
        globalThis.subscribers = [];
        globalThis.controller = { state: { identity: { state: "authenticated" }, identityGeneration: 1 }, connection: {
            getSnapshot: () => snapshot,
            isCurrent: (value) => value === snapshot.generation,
            subscribe(listener) { subscribers.push(listener); listener(snapshot); return () => {}; },
            update(value) { snapshot = { ...snapshot, ...value }; subscribers.forEach(listener => listener(snapshot)); }
        }};
        globalThis.calendar = createPopupCalendarController({ controller, document });
    `);
    await h.run("calendar.init()");
    await h.settle();
    const before = h.fetches.filter(({ url, method }) => method === "GET" && url.includes("/consent?") && url.includes("version=1")).length;
    h.setBody(producerConsent({ scopes: ["unknown_scope"] }));
    h.run("calendar.state.consent = null; calendar.state.consentVerified = false; calendar.state.consentFailure = null");
    await h.run("calendar.loadConsent()");
    await h.settle();
    const v1Gets = h.fetches.filter(({ url, method }) => method === "GET" && url.includes("/consent?") && url.includes("version=1"));
    assert.equal(v1Gets.length - before, 1, "failure replay through a synchronous subscriber must not schedule another check");
    assert.equal(h.run("calendar.state.consent"), null);
    assert.equal(h.run("calendar.state.consentVerified"), false);
    assert.equal(h.run("calendar.state.consentOperation"), "idle");
    assert.equal(h.run("calendar.state.consentFailure"), "check");
});


test("producer grant states and invalid grants retain meaning through the complete read pipeline", async () => {
    const scopes = ["full_history_upload", "ongoing_read", "shares_ics_inclusion"];
    for (const [label, overrides, expected] of [
        ["partial", { scopes: ["ongoing_read"] }, false],
        ["granted", { granted: true, scopes, state: "active" }, true],
        ["revoked", { granted: false, scopes: [], current: false, state: "revoked" }, false],
        ["contradictory revocation", { granted: true, scopes, revoked: true, state: "revoked" }, false]
    ]) {
        const h = harness(producerConsent(overrides));
        const value = await h.run(`popupPlatformRequest("NEST_CONSENT_GET", {source_key:"${sourceKey}",account_key:"${accountKey}",version:1}).then(result=>popupCalendarNormalizeConsent(result,{sourceKey:"${sourceKey}",accountKey:"${accountKey}"}))`);
        assert.equal(value.valid, true, label);
        assert.equal(value.current, expected, label);
    }
    for (const overrides of [
        {granted:true,scopes:["ongoing_read"]},
        {scopes:["ongoing_read","ongoing_read"]},
        {account_key:"b".repeat(64)},
        {source_key:"canvas:"+"b".repeat(64)},
        {version:2}
    ]) {
        const h = harness(producerConsent(overrides));
        await assert.rejects(h.run(`popupPlatformRequest("NEST_CONSENT_GET", {source_key:"${sourceKey}",account_key:"${accountKey}",version:1})`), /NEST_CONSENT_RESPONSE_INVALID/);
    }
});
