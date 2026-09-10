"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const canvasRegistration = require(path.join(root, "js/platform/canvas-registration.js"));
assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.background.service_worker, "js/background.js");
assert.deepEqual(manifest.host_permissions, [
    "https://canvas.emory.edu/*",
    "https://nest.apstudy.org/*",
    "https://du11hjcvx0uqb.cloudfront.net/*",
    "https://instructure-uploads.s3.amazonaws.com/*",
    "https://emory.evaluationkit.com/*",
    "https://designplus.ciditools.com/*"
]);
assert.ok(!manifest.host_permissions.some((permission) => permission.includes("*/*")));
assert.deepEqual(manifest.optional_host_permissions, ["https://*/*"]);
assert.deepEqual([...manifest.permissions].sort(), ["alarms", "declarativeNetRequest", "scripting", "storage", "tabs", "webNavigation"]);
const dnrRuleResources = manifest.declarative_net_request?.rule_resources || [];
assert.deepEqual(dnrRuleResources.map((ruleset) => ruleset.id), ["ruleset_tool_scripts"]);
assert.equal(dnrRuleResources[0].enabled, true, "tool-script ruleset ships enabled; the settings toggle disables it at runtime");
const toolScriptRules = JSON.parse(fs.readFileSync(path.join(root, dnrRuleResources[0].path), "utf8"));
assert.equal(toolScriptRules.length, 3, "tool-script ruleset covers the S3 account JS, EvaluationKit, and DesignPlus");
assert.ok(toolScriptRules.every((rule) => rule.action?.type === "block"));
assert.ok(toolScriptRules.some((rule) => rule.condition?.regexFilter?.includes("emory_global\\.js")));
const thirdPartyToolRuleDomains = toolScriptRules.flatMap((rule) => rule.condition?.requestDomains || []);
const thirdPartyToolHostPermissions = manifest.host_permissions.filter((permission) => /(?:evaluationkit|ciditools)\.com/.test(permission));
assert.deepEqual(thirdPartyToolRuleDomains, [
    "emory.evaluationkit.com",
    "designplus.ciditools.com"
], "third-party tool rules must declare the complete, reviewed host set");
assert.deepEqual(thirdPartyToolHostPermissions, thirdPartyToolRuleDomains.map((domain) => `https://${domain}/*`), "third-party host permissions must exactly match tool-rule requestDomains");
assert.ok(!thirdPartyToolHostPermissions.some((permission) => /^https:\/\/\*\.(?:evaluationkit|ciditools)\.com\/\*$/.test(permission)), "third-party tool hosts must never use wildcard permissions");
assert.ok(!manifest.permissions.includes("windows"), "chrome.windows needs no permission; the legacy fullscreen window path is retired");
assert.equal(manifest.options_page, undefined, "popup is the only extension settings entrypoint");

const canvasScript = manifest.content_scripts.find((entry) => entry.js.includes("js/content.js"));
const watchdogScript = manifest.content_scripts.find((entry) => entry.js.includes("js/content/sidebar-watchdog.js"));
const nestScript = manifest.content_scripts.find((entry) => entry.js.includes("js/platform/nest-bridge.js"));
assert.ok(canvasScript);
assert.ok(watchdogScript, "Chromium must register a separate page-world watchdog entry");
assert.deepEqual(watchdogScript.matches, ["https://canvas.emory.edu/*"]);
assert.deepEqual(watchdogScript.js, ["js/content/sidebar-watchdog.js"]);
assert.equal(watchdogScript.run_at, "document_start");
assert.equal(watchdogScript.world, "MAIN");
assert.equal(manifest.content_scripts.filter((entry) => entry.js.includes("js/content/sidebar-watchdog.js")).length, 1);
assert.deepEqual(canvasScript.matches, ["https://canvas.emory.edu/*"]);
assert.deepEqual(canvasScript.js, canvasRegistration.CANVAS_CONTENT_SCRIPTS, "static Emory and dynamic Canvas module order must be identical");
assert.deepEqual(canvasScript.css, canvasRegistration.CANVAS_CSS, "static Emory and dynamic Canvas CSS order must be identical");
assert.equal(canvasScript.js.at(-1), "js/content.js", "content.js must be the final Canvas module");
assert.equal(canvasRegistration.CANVAS_CONTENT_SCRIPTS.at(-1), "js/content.js", "dynamic content.js must be final");
assert.ok(canvasScript.js.indexOf("js/content/calendar-extension/calendar-extension.v1.js") < canvasScript.js.indexOf("js/content/calendar-overlay.js"));
assert.ok(canvasScript.js.indexOf("js/content/calendar-overlay.js") < canvasScript.js.indexOf("js/content.js"));
assert.ok(canvasScript.js.includes("js/content/gpa.js"), "the pure GPA module must ship as a Canvas content script");
assert.ok(canvasScript.js.indexOf("js/content/gpa.js") < canvasScript.js.indexOf("js/content.js"), "gpa.js must register on APStudyCanvasContent before content.js reads it");
assert.ok(canvasScript.js.includes("js/content/planner-tasks.js"), "the planner-note domain must ship before the To-Do coordinator");
assert.ok(canvasScript.js.indexOf("js/content/planner-tasks.js") < canvasScript.js.indexOf("js/content/todo-model.js"), "planner marker parsing must exist before Canvas tasks normalize");
assert.ok(canvasScript.js.indexOf("js/content/planner-tasks.js") < canvasScript.js.indexOf("js/content/todo-api.js"), "planner transport must exist before completion dispatch is configured");
assert.ok(!canvasScript.js.includes("js/content/right-rail-data.js"), "the retired duplicate streak module must not ship");
assert.deepEqual(canvasScript.css, ["css/content.css", "css/canvas-search.css", "css/grade-analytics.css", "css/workspace.css", "css/sidebar.css", "css/todo-right-rail.css", "css/todo-course-cards.css", "js/content/calendar-extension/calendar-extension.v1.css"]);
assert.ok(nestScript);
assert.deepEqual(nestScript.matches, ["https://nest.apstudy.org/*"]);
assert.ok(!canvasScript.js.includes("js/platform/nest-bridge.js"));
assert.ok(!nestScript.js.includes("js/content.js"));
assert.ok(manifest.content_scripts.every((entry) => !entry.matches.includes("https://*/*")));

// The overlay embeds html/popup.html as an extension-origin iframe inside the
// Canvas page. Exposing it more widely than the statically matched Canvas
// origin would make the settings surface framable by any site.
assert.ok(Array.isArray(manifest.web_accessible_resources) && manifest.web_accessible_resources.length === 1, "overlay needs exactly one web-accessible resource entry");
const overlayResources = manifest.web_accessible_resources[0];
assert.deepEqual(overlayResources.matches, canvasScript.matches, "web-accessible overlay scope must equal the static Canvas content-script scope");
// css/content.css's families are declared by js/content/font-faces.js and
// overlay-host.js's fontFaceCss(), both loading faces by extension URL from
// inside the Canvas document, so every face either file declares has to be
// listed here or it 404s. The list stays exhaustive and stays scoped to the
// Canvas content-script matches, asserted just above.
assert.deepEqual(overlayResources.resources, [
    "html/popup.html",
    "font/newsreader-latin.woff2",
    "font/public-sans-latin.woff2",
    "font/ibm-plex-mono-latin-400.woff2",
    "font/ibm-plex-mono-latin-500.woff2"
]);
assert.ok(!overlayResources.resources.includes("js/content/sidebar-watchdog-loader.js"));
const watchdogSource = fs.readFileSync(path.join(root, "js/content/sidebar-watchdog.js"), "utf8");
assert.doesNotMatch(watchdogSource, /\beval\s*\(/, "watchdog must not use inline eval");
assert.ok(!fs.existsSync(path.join(root, "js/content/sidebar-watchdog-loader.js")), "obsolete watchdog loader must be removed");
const railCss = fs.readFileSync(path.join(root, "css/content.css"), "utf8");
const shellSource = fs.readFileSync(path.join(root, "js/content/overlay-host.js"), "utf8");
const fontFacesSource = fs.readFileSync(path.join(root, "js/content/font-faces.js"), "utf8");
const canvasFontSources = [railCss, shellSource, fontFacesSource];
const collectFontResources = (source) => Array.from(source.matchAll(/urlFor\("([\w.-]+\.woff2)"\)/g), (match) => `font/${match[1]}`)
    .concat(Array.from(source.matchAll(/url\("\.\.\/(font\/[\w.-]+)"\)/g), (match) => match[1]));
canvasFontSources.flatMap(collectFontResources).forEach((resource) => assert.ok(
    overlayResources.resources.includes(resource),
    `Canvas-origin font is not web-accessible and will 404: ${resource}`
));
overlayResources.resources.filter((resource) => resource.startsWith("font/")).forEach((resource) => {
    const file = resource.slice("font/".length);
    assert.ok(
        canvasFontSources.some((source) => collectFontResources(source).includes(resource)),
        `web-accessible font nothing references from the Canvas origin: ${resource}`
    );
});
assert.ok(!JSON.stringify(manifest.web_accessible_resources).includes("*/*"), "overlay resources must never be wildcard-exposed");
assert.ok(!JSON.stringify(manifest.web_accessible_resources).includes("<all_urls>"), "overlay resources must never be exposed to all urls");

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

const firefoxRoot = fs.mkdtempSync(path.join(os.tmpdir(), "apstudycanvas-firefox-test-"));
process.on("exit", () => fs.rmSync(firefoxRoot, { recursive: true, force: true }));
const firefoxBuild = spawnSync(process.execPath, [path.join(root, "scripts/build-firefox-manifest.mjs")], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, APSTUDY_FIREFOX_OUTPUT: firefoxRoot }
});
assert.equal(firefoxBuild.status, 0, `${firefoxBuild.stdout}\n${firefoxBuild.stderr}`);
const firefoxManifestPath = path.join(firefoxRoot, "manifest.json");
assert.ok(fs.existsSync(firefoxManifestPath), "missing generated Firefox manifest");
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
    "js/platform/planner-page-bridge.js",
    "js/platform/overlay-launcher.js",
    "js/platform/script-blocker.js",
    "js/canvas-adapter/writeback.js",
    "js/platform/writeback-consent.js",
    "js/platform/writeback-mirrors.js",
    "js/platform/writeback-executor.js",
    "js/platform/writeback.js",
    "js/platform/writeback-runtime.js",
    "js/platform/router.js",
    "js/background.js"
]);
assert.equal(firefoxManifest.background.persistent, false);
assert.equal(firefoxManifest.browser_specific_settings.gecko.id, manifest.browser_specific_settings.gecko.id);
assert.equal(firefoxManifest.browser_specific_settings.gecko.strict_min_version, "128.0");
assert.equal(manifest.browser_specific_settings.gecko.strict_min_version, "128.0");
["name", "description", "version", "icons", "action", "host_permissions", "optional_host_permissions", "permissions", "options_page", "default_locale", "browser_specific_settings", "web_accessible_resources"].forEach((key) => assert.deepEqual(firefoxManifest[key], manifest[key], `Firefox manifest drifted for ${key}`));
assert.deepEqual(
    firefoxManifest.host_permissions.filter((permission) => /(?:evaluationkit|ciditools)\.com/.test(permission)),
    thirdPartyToolHostPermissions,
    "generated Firefox manifest must retain the exact third-party tool host set"
);
const firefoxWatchdog = firefoxManifest.content_scripts.find((entry) => entry.js.includes("js/content/sidebar-watchdog.js"));
assert.ok(firefoxWatchdog, "Firefox must use the direct page-world watchdog");
assert.deepEqual(firefoxWatchdog.matches, watchdogScript.matches);
assert.deepEqual(firefoxWatchdog.js, ["js/content/sidebar-watchdog.js"]);
assert.equal(firefoxWatchdog.run_at, "document_start");
assert.equal(firefoxWatchdog.world, "MAIN");
assert.equal(firefoxManifest.content_scripts.filter((entry) => entry.js.includes("js/content/sidebar-watchdog.js")).length, 1);
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
    "./platform/planner-page-bridge.js",
    "./platform/overlay-launcher.js",
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
["FEATURE_DISABLED_UPLOAD", "FEATURE_DISABLED_PROJECTION", "FEATURE_DISABLED_MIRRORING", "FEATURE_DISABLED_MUTATION", "FEATURE_DISABLED_OVERLAY", "FEATURE_DISABLED_REPLACEMENT", "FEATURE_DISABLED_BROWSER_REPLACE", "FEATURE_DISABLED_CANVAS_OVERLAY"].forEach((code) => assert.ok(routerSource.includes(code), `missing explicit feature gate: ${code}`));

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
const popupScripts = Array.from(popupHtml.matchAll(/<script[^>]+src="([^"]+)"/g), (match) => match[1]);
const diagnosticsTransportIndex = popupScripts.indexOf("../js/diagnostics-transport.js");
const popupControllerIndex = popupScripts.indexOf("../js/popup-controller.js");
const workspaceStartupIndex = popupScripts.indexOf("../js/edit-canvas.js");
const popupRuntimeIndex = popupScripts.indexOf("../js/popup.js");
assert.ok(diagnosticsTransportIndex > -1 && diagnosticsTransportIndex < popupControllerIndex && popupControllerIndex < workspaceStartupIndex && workspaceStartupIndex < popupRuntimeIndex, "diagnostics transport must load before the controller and canonical Workspace startup");
["notifications-popover", "workspace-category-select", "workspace-section-sidebar", "workspace-section-calendar-accounts", "workspace-account-trigger", "workspace-account-avatar", "workspace-account-name", "workspace-account-source", "workspace-account-status", "account-section-avatar", "account-section-name", "account-section-source", "account-section-status", "account-section-binding", "sidebar-page-list", "popup-export-settings", "popup-import-settings", "todo-calendar-sync", "todo-calendar-sync-status", "todo-export-settings", "todo-import-settings", "popup-reset-settings", "compact-expand"].forEach((id) => assert.ok(popupHtml.includes(`id=\"${id}\"`), `missing popup id: ${id}`));
assert.ok(!popupHtml.includes('id="home-view"') && !popupHtml.includes('id="home-edit-canvas"'), "obsolete Home markup must be absent");
assert.ok(!popupHtml.includes('id="profile-button"') && !popupHtml.includes('id="profile-popover"'), "profile popover markup must be absent");
assert.match(popupHtml, /id="workspace-account-trigger"[^>]*data-workspace-target="calendar-accounts"/);
assert.equal(Array.from(popupHtml.matchAll(/data-workspace-target="calendar-accounts"/g)).length, 1, "only the account context may route to Account & calendar");
assert.match(popupHtml, /<section class="workspace-section" id="workspace-section-overview"[\s\S]*?<section class="nest-onboarding" id="nest-onboarding"[\s\S]*?id="nest-sign-in"[\s\S]*?id="nest-continue"/);
assert.match(popupHtml, /id="nest-onboarding"[\s\S]*?Keep Canvas settings independent/);
assert.match(popupHtml, /id="workspace-account-trigger"[^>]*aria-label="Open account and calendar settings"/);
assert.match(popupHtml, /id="modern-dark-palette"[\s\S]*?id="modern-dark-palette-apply"/);
assert.match(popupController, /function renderModernPalette\(\)/);
assert.match(popupController, /deps\.transaction\(\(\) => \(\{ dark_preset: palette \}\)\)/);
assert.doesNotMatch(popupHtml, /data-custom-dropdown/);
assert.doesNotMatch(popupController, /apstudy-select|preset-button/);
["NEST_IDENTITY_GET", "NEST_CONSENT_GET", "NEST_CONSENT_SET", "NEST_CALENDARS_GET", "OVERLAY_CONTROL", "SETTINGS_UPDATE"].forEach((family) => assert.ok(popupController.includes(`\"${family}\"`) || fs.readFileSync(path.join(root, "js/popup.js"), "utf8").includes(`\"${family}\"`), `missing popup family: ${family}`));
for (const file of ["js/edit-canvas.js", "js/popup.js", "js/background.js", "manifest.json"]) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    assert.ok(!source.includes("openOptionsPage"), `${file} still launches the legacy options page`);
    assert.ok(!source.includes("pendingWorkspaceRouteToken"), `${file} still uses the legacy route pointer`);
    assert.ok(!source.includes("workspaceRoute:"), `${file} still uses the legacy route token`);
}
assert.ok(!popupHtml.includes("options.html"), "popup must not link to the legacy options file");
assert.ok(fs.existsSync(path.join(root, "html/options.html")) && fs.existsSync(path.join(root, "css/options.css")), "legacy option files remain recoverable");

const fontDir = path.join(root, "font");
[
    "newsreader-latin.woff2",
    "public-sans-latin.woff2",
    "ibm-plex-mono-latin-400.woff2",
    "ibm-plex-mono-latin-500.woff2",
    "NEWSREADER-OFL.txt",
    "PUBLIC-SANS-OFL.txt",
    "IBM-PLEX-MONO-OFL.txt"
].forEach((file) => assert.ok(fs.existsSync(path.join(fontDir, file)), `missing self-hosted font asset: ${file}`));
const popupCss = fs.readFileSync(path.join(root, "css/popup.css"), "utf8");
assert.ok(popupCss.includes("url(\"../font/newsreader-latin.woff2\")"), "popup.css must self-host Newsreader");
assert.ok(popupCss.includes("url(\"../font/public-sans-latin.woff2\")"), "popup.css must self-host Public Sans");
assert.ok(!popupCss.includes("fonts.googleapis.com") && !popupCss.includes("fonts.gstatic.com"), "popup.css must not fetch fonts from a CDN");
assert.ok(fs.existsSync(path.join(firefoxRoot, "font/newsreader-latin.woff2")), "Firefox artifact must copy self-hosted fonts");

console.log("static manifest/script/security references: PASS");
