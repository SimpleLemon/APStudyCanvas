"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const vm = require("node:vm");

const root = path.resolve(__dirname, "../..");
const buildScript = path.join(root, "scripts/build-firefox-manifest.mjs");
const artifactRoot = path.join(root, "dist/firefox");
const chromiumManifestPath = path.join(root, "manifest.json");
const expectedCanvasScripts = [
    "css/darkmodecss.js",
    "js/canvas-adapter/contracts.js",
    "js/canvas-adapter/identity.js",
    "js/canvas-adapter/normalizers.js",
    "js/canvas-adapter/pagination.js",
    "js/canvas-adapter/batch.js",
    "js/canvas-adapter/protocol.js",
    "js/canvas-adapter/extractor.js",
    "js/content/context.js",
    "js/content/sync-extraction.js",
    "js/content/sidebar.js",
    "js/content/lifecycle.js",
    "js/content/context-guard.js",
    "js/content/calendar-extension/calendar-extension.v1.js",
    "js/content/calendar-overlay.js",
    "js/content.js"
];
const firefoxBackgroundScripts = [
    "js/settings-schema.js",
    "js/platform/contract.js",
    "js/platform/security.js",
    "js/platform/storage.js",
    "js/platform/transport.js",
    "js/platform/idb.js",
    "js/canvas-adapter/identity.js",
    "js/canvas-adapter/outbox.js",
    "js/canvas-adapter/sync-state.js",
    "js/canvas-adapter/sync-client.js",
    "js/canvas-adapter/sync-engine.js",
    "js/canvas-adapter/sync-extract-stage.js",
    "js/canvas-adapter/sync-uploader.js",
    "js/canvas-adapter/sync-finalizer.js",
    "js/platform/canvas-sync-storage.js",
    "js/platform/canvas-session-resolver.js",
    "js/platform/canvas-extraction-messenger.js",
    "js/platform/canvas-sync-nest.js",
    "js/platform/canvas-sync-controller.js",
    "js/platform/canvas-sync-cycle.js",
    "js/platform/canvas-sync-core.js",
    "js/platform/canvas-sync-alarms.js",
    "js/platform/canvas-sync-browser.js",
    "js/platform/canvas-registration.js",
    "js/platform/fullscreen.js",
    "js/platform/router.js",
    "js/background.js"
];
const chromiumImportScripts = firefoxBackgroundScripts.slice(0, -1).map((file) => `./${file.slice(3)}`);
const platformGlobals = [
    "Contract", "Security", "Storage", "Transport", "IndexedDb",
    "CanvasSyncStorage", "CanvasSessionResolver", "CanvasExtractionMessenger",
    "CanvasSyncNest", "CanvasSyncController", "CanvasSyncCycle", "CanvasSyncCore", "CanvasSyncAlarms", "CanvasSyncBrowser",
    "CanvasRegistration", "Fullscreen", "Router"
];
const adapterGlobals = ["Identity", "Outbox", "SyncState", "SyncClient", "SyncEngine", "SyncExtractStage", "SyncUploader", "SyncFinalizer"];

function runBuild() {
    const result = spawnSync(process.execPath, [buildScript], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    return result.stdout;
}

function artifactSnapshot() {
    const files = [];
    function visit(directory) {
        fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name)).forEach((entry) => {
            const absolute = path.join(directory, entry.name);
            if (entry.isDirectory()) visit(absolute);
            else files.push([path.relative(artifactRoot, absolute), crypto.createHash("sha256").update(fs.readFileSync(absolute)).digest("hex")]);
        });
    }
    visit(artifactRoot);
    return files;
}

function manifestReferences(manifest) {
    const references = [];
    function collect(value) {
        if (typeof value === "string" && /^(?:[^:]+\/)*[^:]+\.(?:js|css|html|png|svg|json)$/i.test(value)) references.push(value);
        if (Array.isArray(value)) value.forEach(collect);
        else if (value && typeof value === "object") Object.values(value).forEach(collect);
    }
    collect(manifest);
    return Array.from(new Set(references));
}

function makeEvent(callbacks, name) {
    return {
        addListener(callback) {
            callbacks[name] = callbacks[name] || [];
            callbacks[name].push(callback);
        }
    };
}

function makeStorageArea(values = {}, calls = [], area = "storage") {
    return {
        async get(keys) {
            calls.push(`${area}.get`);
            if (keys === null || keys === undefined) return structuredClone(values);
            const requested = Array.isArray(keys) ? keys : [keys];
            return Object.fromEntries(requested.filter((key) => Object.prototype.hasOwnProperty.call(values, key)).map((key) => [key, structuredClone(values[key])]));
        },
        async set(changes) {
            calls.push(`${area}.set`);
            Object.assign(values, structuredClone(changes));
        },
        async remove(keys) {
            calls.push(`${area}.remove`);
            (Array.isArray(keys) ? keys : [keys]).forEach((key) => delete values[key]);
        }
    };
}

function createExtensionApi({ namespace, includeSession = true, includeOptionalApis = true } = {}) {
    const callbacks = {};
    const calls = [];
    const storage = {
        sync: makeStorageArea({}, calls, "sync"),
        local: makeStorageArea({}, calls, "local"),
        onChanged: makeEvent(callbacks, "storage")
    };
    if (includeSession) storage.session = makeStorageArea({}, calls, "session");
    const extensionScheme = namespace === "browser" ? "moz-extension" : "chrome-extension";
    const api = {
        runtime: {
            getURL: (value) => `${extensionScheme}://test-id/${String(value).replace(/^\//, "")}`,
            onMessage: makeEvent(callbacks, "message"),
            onInstalled: makeEvent(callbacks, "install")
        },
        storage,
        tabs: {
            async query() { calls.push("tabs.query"); return []; },
            async sendMessage() { calls.push("tabs.sendMessage"); return { ok: true }; }
        },
        windows: { onRemoved: makeEvent(callbacks, "window") },
        permissions: {
            onAdded: makeEvent(callbacks, "permission"),
            async contains() { return true; },
            async request() { return true; },
            async remove() { return true; }
        },
        scripting: {
            async getRegisteredContentScripts() { return []; },
            async registerContentScripts() {},
            async unregisterContentScripts() {}
        },
        alarms: { onAlarm: makeEvent(callbacks, "alarm") }
    };
    if (!includeOptionalApis) {
        delete api.windows;
        delete api.permissions;
        delete api.scripting;
    }
    return { api, callbacks, calls };
}

function createContext(namespace, options = {}) {
    const { api, callbacks, calls } = createExtensionApi({ namespace, ...options });
    const context = vm.createContext({
        [namespace]: api,
        console: { log() {}, warn() {}, error() {} },
        crypto: { randomUUID: () => "test-request-id" },
        fetch: async () => { throw new Error("fetch should not run during startup"); },
        structuredClone,
        TextEncoder,
        URL,
        URLSearchParams,
        setTimeout,
        clearTimeout,
        unescape
    });
    context.globalThis = context;
    return { context, api, callbacks, calls };
}

function loadScript(context, relativePath) {
    const source = fs.readFileSync(path.join(root, relativePath), "utf8");
    vm.runInContext(source, context, { filename: relativePath });
}

function loadFirefoxBackground(namespace, options = {}) {
    const environment = createContext(namespace, options);
    const manifest = JSON.parse(fs.readFileSync(path.join(artifactRoot, "manifest.json"), "utf8"));
    manifest.background.scripts.forEach((file) => loadScript(environment.context, path.join("dist/firefox", file)));
    return environment;
}

function loadChromiumBackground() {
    const environment = createContext("chrome");
    const imported = [];
    environment.context.importScripts = (...files) => {
        imported.push(...files);
        files.forEach((file) => loadScript(environment.context, path.join("js", file.replace(/^\.\//, ""))));
    };
    loadScript(environment.context, "js/background.js");
    return { ...environment, imported };
}

runBuild();

test("Firefox artifact is deterministic and keeps a drift-checked MV3 manifest", () => {
    const firstSnapshot = artifactSnapshot();
    runBuild();
    assert.deepEqual(artifactSnapshot(), firstSnapshot);

    const chromium = JSON.parse(fs.readFileSync(chromiumManifestPath, "utf8"));
    const firefox = JSON.parse(fs.readFileSync(path.join(artifactRoot, "manifest.json"), "utf8"));
    assert.equal(chromium.background.service_worker, "js/background.js");
    assert.equal(firefox.background.service_worker, undefined);
    assert.deepEqual(firefox.background.scripts, firefoxBackgroundScripts);
    assert.equal(firefox.background.persistent, false);
    assert.equal(firefox.manifest_version, 3);
    assert.equal(firefox.browser_specific_settings.gecko.id, chromium.browser_specific_settings.gecko.id);
    assert.equal(firefox.browser_specific_settings.gecko.strict_min_version, "115.0");
    assert.equal(chromium.browser_specific_settings.gecko.strict_min_version, "115.0");

    assert.deepEqual(chromium.content_scripts[0].js, expectedCanvasScripts);
    assert.deepEqual(firefox.content_scripts[0].js, expectedCanvasScripts);
    assert.equal(expectedCanvasScripts.at(-1), "js/content.js");
    assert.ok(!expectedCanvasScripts.some((file) => /sync-(?:client|engine|state|uploader|finalizer|extract-stage)\.js$/.test(file)));

    ["name", "description", "version", "icons", "action", "host_permissions", "optional_host_permissions", "content_scripts", "permissions", "options_page", "default_locale", "browser_specific_settings"].forEach((key) => {
        assert.deepEqual(firefox[key], chromium[key], `Firefox manifest drifted for ${key}`);
    });
    assert.equal(firefox.content_security_policy, undefined, "Firefox artifact must use the default MV3 extension CSP");
    manifestReferences(firefox).forEach((reference) => assert.ok(fs.existsSync(path.join(artifactRoot, reference)), `missing Firefox artifact reference: ${reference}`));
});

test("Chromium worker imports platform modules once in dependency order", () => {
    const environment = loadChromiumBackground();
    assert.deepEqual(environment.imported, chromiumImportScripts);
    assert.ok(environment.context.APStudyCanvasSchema);
    platformGlobals.forEach((name) => assert.ok(environment.context.APStudyCanvasPlatform?.[name], `missing Chromium module ${name}`));
    adapterGlobals.forEach((name) => assert.ok(environment.context.APStudyCanvasCanvasAdapter?.[name], `missing Chromium adapter ${name}`));
    assert.deepEqual(environment.calls, [], "worker module evaluation must not touch browser storage or tabs");
    assert.equal(environment.context.APStudyCanvasBackground.storageSessionAvailable, true);
    assert.deepEqual(Object.fromEntries(Object.entries(environment.callbacks).map(([name, listeners]) => [name, listeners.length])), {
        message: 1,
        install: 1,
        alarm: 1,
        window: 1,
        permission: 1,
        storage: 1
    });
});

test("Firefox classic scripts load in manifest order with one listener per event", () => {
    const environment = loadFirefoxBackground("browser");
    assert.ok(!("importScripts" in environment.context));
    assert.ok(environment.context.APStudyCanvasSchema);
    platformGlobals.forEach((name) => assert.ok(environment.context.APStudyCanvasPlatform?.[name], `missing Firefox module ${name}`));
    adapterGlobals.forEach((name) => assert.ok(environment.context.APStudyCanvasCanvasAdapter?.[name], `missing Firefox adapter ${name}`));
    assert.deepEqual(environment.calls, [], "worker module evaluation must not touch browser storage or tabs");
    assert.equal(environment.context.APStudyCanvasBackground.storageSessionAvailable, true);
    assert.deepEqual(Object.fromEntries(Object.entries(environment.callbacks).map(([name, listeners]) => [name, listeners.length])), {
        message: 1,
        install: 1,
        alarm: 1,
        window: 1,
        permission: 1,
        storage: 1
    });
});

test("Firefox startup remains safe when optional APIs and storage.session are unavailable", async () => {
    const environment = loadFirefoxBackground("browser", { includeSession: false, includeOptionalApis: false });
    assert.equal(environment.context.APStudyCanvasBackground.storageSessionAvailable, false);
    assert.equal(environment.callbacks.message.length, 1);
    assert.equal(environment.callbacks.install.length, 1);
    assert.equal(environment.callbacks.alarm.length, 1);
    assert.equal(environment.callbacks.storage.length, 1);
    assert.equal(environment.callbacks.window, undefined);
    assert.equal(environment.callbacks.permission, undefined);

    const request = vm.runInContext('APStudyCanvasPlatform.Contract.createEnvelope("POPUP_CONTEXT_GET", {}, "firefox-no-session")', environment.context);
    let response;
    assert.equal(environment.callbacks.message[0](request, { url: "moz-extension://test-id/popup.html" }, (value) => { response = value; }), true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(response.payload.code, "browser_unsupported");
});
