"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const canvasRegistration = require(path.join(root, "js/platform/canvas-registration.js"));
assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.background.service_worker, "js/background.js");
assert.deepEqual(manifest.host_permissions, ["https://nest.apstudy.org/*"]);
assert.ok(!manifest.host_permissions.some((permission) => permission.includes("*/*")));
assert.deepEqual(manifest.optional_host_permissions, ["https://*/*"]);
assert.deepEqual([...manifest.permissions].sort(), ["alarms", "scripting", "storage", "tabs", "windows"]);
assert.equal(manifest.options_page, undefined, "popup is the only extension settings entrypoint");

const canvasScript = manifest.content_scripts.find((entry) => entry.js.includes("js/content.js"));
const nestScript = manifest.content_scripts.find((entry) => entry.js.includes("js/platform/nest-bridge.js"));
assert.ok(canvasScript);
assert.deepEqual(canvasScript.matches, ["https://canvas.emory.edu/*"]);
assert.deepEqual(canvasScript.js, canvasRegistration.CANVAS_CONTENT_SCRIPTS, "static Emory and dynamic Canvas module order must be identical");
assert.deepEqual(canvasScript.css, canvasRegistration.CANVAS_CSS, "static Emory and dynamic Canvas CSS order must be identical");
assert.equal(canvasScript.js.at(-1), "js/content.js", "content.js must be the final Canvas module");
assert.equal(canvasRegistration.CANVAS_CONTENT_SCRIPTS.at(-1), "js/content.js", "dynamic content.js must be final");
assert.ok(canvasScript.js.indexOf("js/content/calendar-extension/calendar-extension.v1.js") < canvasScript.js.indexOf("js/content/calendar-overlay.js"));
assert.ok(canvasScript.js.indexOf("js/content/calendar-overlay.js") < canvasScript.js.indexOf("js/content.js"));
assert.deepEqual(canvasScript.css, ["css/content.css", "js/content/calendar-extension/calendar-extension.v1.css"]);
assert.ok(nestScript);
assert.deepEqual(nestScript.matches, ["https://nest.apstudy.org/*"]);
assert.ok(!canvasScript.js.includes("js/platform/nest-bridge.js"));
assert.ok(!nestScript.js.includes("js/content.js"));
assert.ok(manifest.content_scripts.every((entry) => !entry.matches.includes("https://*/*")));

const manifestReferences = [];
for (const key of ["background", "action"]) {
    const value = manifest[key];
    if (typeof value === "string") manifestReferences.push(value);
    if (value && typeof value === "object") Object.values(value).forEach((item) => {
        if (typeof item === "string") manifestReferences.push(item);
        if (item && typeof item === "object") Object.values(item).filter((nested) => typeof nested === "string").forEach((nested) => manifestReferences.push(nested));
    });
}
manifest.content_scripts.forEach((entry) => manifestReferences.push(...entry.js, ...(entry.css || [])));
function collectAssetReferences(value) {
    if (typeof value === "string" && /\.(?:js|css|html|png|svg)$/i.test(value)) manifestReferences.push(value);
    if (Array.isArray(value)) value.forEach(collectAssetReferences);
    else if (value && typeof value === "object") Object.values(value).forEach(collectAssetReferences);
}
collectAssetReferences(manifest);
Array.from(new Set(manifestReferences)).filter((reference) => reference && (reference.includes("/") || /\.(?:js|css|html|png|svg)$/i.test(reference))).forEach((reference) => assert.ok(fs.existsSync(path.join(root, reference)), `missing manifest reference: ${reference}`));

const firefoxRoot = path.join(root, "dist", "firefox");
const firefoxManifestPath = path.join(firefoxRoot, "manifest.json");
assert.ok(fs.existsSync(firefoxManifestPath), "missing generated Firefox manifest; run npm run build:firefox first");
const firefoxManifest = JSON.parse(fs.readFileSync(firefoxManifestPath, "utf8"));
assert.equal(firefoxManifest.manifest_version, 3);
assert.equal(firefoxManifest.background.service_worker, undefined);
assert.deepEqual(firefoxManifest.background.scripts, [
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
]);
assert.equal(firefoxManifest.background.persistent, false);
assert.equal(firefoxManifest.browser_specific_settings.gecko.id, manifest.browser_specific_settings.gecko.id);
assert.equal(firefoxManifest.browser_specific_settings.gecko.strict_min_version, "115.0");
assert.equal(manifest.browser_specific_settings.gecko.strict_min_version, "115.0");
["name", "description", "version", "icons", "action", "host_permissions", "optional_host_permissions", "content_scripts", "permissions", "options_page", "default_locale", "browser_specific_settings"].forEach((key) => assert.deepEqual(firefoxManifest[key], manifest[key], `Firefox manifest drifted for ${key}`));
assert.equal(firefoxManifest.content_security_policy, undefined, "Firefox artifact must use the default MV3 extension CSP");
const firefoxReferences = [];
function collectFirefoxReferences(value) {
    if (typeof value === "string" && /\.(?:js|css|html|png|svg)$/i.test(value)) firefoxReferences.push(value);
    if (Array.isArray(value)) value.forEach(collectFirefoxReferences);
    else if (value && typeof value === "object") Object.values(value).forEach(collectFirefoxReferences);
}
collectFirefoxReferences(firefoxManifest);
Array.from(new Set(firefoxReferences)).filter((reference) => reference && (reference.includes("/") || /\.(?:js|css|html|png|svg)$/i.test(reference))).forEach((reference) => assert.ok(fs.existsSync(path.join(firefoxRoot, reference)), `missing Firefox manifest reference: ${reference}`));

const background = fs.readFileSync(path.join(root, "js/background.js"), "utf8");
[
    "./settings-schema.js",
    "./platform/contract.js",
    "./platform/security.js",
    "./platform/storage.js",
    "./platform/transport.js",
    "./platform/idb.js",
    "./canvas-adapter/identity.js",
    "./canvas-adapter/outbox.js",
    "./canvas-adapter/sync-state.js",
    "./canvas-adapter/sync-client.js",
    "./canvas-adapter/sync-engine.js",
    "./canvas-adapter/sync-extract-stage.js",
    "./canvas-adapter/sync-uploader.js",
    "./canvas-adapter/sync-finalizer.js",
    "./platform/canvas-sync-storage.js",
    "./platform/canvas-session-resolver.js",
    "./platform/canvas-extraction-messenger.js",
    "./platform/canvas-sync-nest.js",
    "./platform/canvas-sync-controller.js",
    "./platform/canvas-sync-cycle.js",
    "./platform/canvas-sync-core.js",
    "./platform/canvas-sync-alarms.js",
    "./platform/canvas-sync-browser.js",
    "./platform/canvas-registration.js",
    "./platform/fullscreen.js",
    "./platform/router.js"
].forEach((reference) => assert.ok(background.includes(reference), `missing worker import: ${reference}`));
assert.ok(background.includes("typeof importScripts === \"function\""), "background must feature-detect importScripts");
assert.ok(background.includes("globalThis.chrome || globalThis.browser"), "background must support the browser namespace fallback");
assert.ok(background.includes("browser_unsupported"), "background must expose safe browser fallbacks");

const bridge = fs.readFileSync(path.join(root, "js/platform/nest-bridge.js"), "utf8");
assert.ok(bridge.includes("https://nest.apstudy.org"));
assert.ok(!bridge.includes("document.cookie"));
assert.ok(!bridge.includes("set-cookie"));
assert.ok(!bridge.includes("appwrite"));

const routerSource = fs.readFileSync(path.join(root, "js/platform/router.js"), "utf8");
["FEATURE_DISABLED_UPLOAD", "FEATURE_DISABLED_PROJECTION", "FEATURE_DISABLED_MIRRORING", "FEATURE_DISABLED_MUTATION", "FEATURE_DISABLED_OVERLAY", "FEATURE_DISABLED_REPLACEMENT", "FEATURE_DISABLED_BROWSER_FULLSCREEN", "FEATURE_DISABLED_BROWSER_REPLACE"].forEach((code) => assert.ok(routerSource.includes(code), `missing explicit feature gate: ${code}`));

const storageSource = fs.readFileSync(path.join(root, "js/platform/storage.js"), "utf8");
assert.ok(!storageSource.includes('"pendingWorkspaceRouteToken"'));
assert.ok(!storageSource.includes('"workspace_target"'));
const registrationSource = fs.readFileSync(path.join(root, "js/platform/canvas-registration.js"), "utf8");
assert.ok(registrationSource.includes("permissions.contains"));
assert.ok(registrationSource.includes("registerContentScripts"));
assert.ok(registrationSource.includes('code: "permission_required"'));
assert.ok(registrationSource.includes('code: "browser_unsupported"'));
assert.ok(registrationSource.includes("CANVAS_CONTENT_SCRIPTS.slice()"));

const contentSource = fs.readFileSync(path.join(root, "js/content.js"), "utf8");
assert.ok(contentSource.includes("verifyAccount"), "content must handle live CANVAS_ACCOUNT_VERIFY");
assert.ok(contentSource.includes("CANVAS_SYNC_START") && contentSource.includes("CANVAS_WRITEBACK_DRAIN"), "sync/writeback families must be explicitly unsupported");
assert.ok(!contentSource.includes("window.postMessage"), "Canvas content must not use a page bridge");

const popupHtml = fs.readFileSync(path.join(root, "html/popup.html"), "utf8");
const popupController = fs.readFileSync(path.join(root, "js/popup-controller.js"), "utf8");
assert.ok(popupHtml.includes("../js/popup-controller.js"));
assert.ok(popupHtml.includes("../js/platform/contract.js"));
["nest-onboarding", "nest-sign-in", "nest-continue", "profile-popover", "workspace-category-select", "workspace-section-sidebar", "workspace-section-calendar-accounts", "sidebar-page-list", "popup-export-settings", "popup-import-settings", "popup-reset-settings", "compact-expand"].forEach((id) => assert.ok(popupHtml.includes(`id=\"${id}\"`), `missing popup id: ${id}`));
["NEST_IDENTITY_GET", "NEST_CONSENT_GET", "NEST_CONSENT_SET", "NEST_CALENDARS_GET", "POPUP_FULLSCREEN_OPEN", "SETTINGS_UPDATE"].forEach((family) => assert.ok(popupController.includes(`\"${family}\"`) || fs.readFileSync(path.join(root, "js/popup.js"), "utf8").includes(`\"${family}\"`), `missing popup family: ${family}`));
for (const file of ["js/edit-canvas.js", "js/popup.js", "js/background.js", "manifest.json"]) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    assert.ok(!source.includes("openOptionsPage"), `${file} still launches the legacy options page`);
    assert.ok(!source.includes("pendingWorkspaceRouteToken"), `${file} still uses the legacy route pointer`);
    assert.ok(!source.includes("workspaceRoute:"), `${file} still uses the legacy route token`);
}
assert.ok(!popupHtml.includes("options.html"), "popup must not link to the legacy options file");
assert.ok(fs.existsSync(path.join(root, "html/options.html")) && fs.existsSync(path.join(root, "css/options.css")), "legacy option files remain recoverable");

console.log("static manifest/script/security references: PASS");
