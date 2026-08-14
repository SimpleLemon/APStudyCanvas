import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = path.join(ROOT, "dist", "firefox");
export const FIREFOX_ESR_MIN_VERSION = "115.0";
export const FIREFOX_BACKGROUND_SCRIPTS = Object.freeze([
    "settings-schema.js",
    "platform/contract.js",
    "platform/security.js",
    "platform/storage.js",
    "platform/transport.js",
    "platform/idb.js",
    "canvas-adapter/identity.js",
    "canvas-adapter/outbox.js",
    "canvas-adapter/sync-state.js",
    "canvas-adapter/sync-client.js",
    "canvas-adapter/sync-engine.js",
    "canvas-adapter/sync-extract-stage.js",
    "canvas-adapter/sync-uploader.js",
    "canvas-adapter/sync-finalizer.js",
    "platform/canvas-sync-storage.js",
    "platform/canvas-session-resolver.js",
    "platform/canvas-extraction-messenger.js",
    "platform/canvas-sync-nest.js",
    "platform/canvas-sync-controller.js",
    "platform/canvas-sync-cycle.js",
    "platform/canvas-sync-core.js",
    "platform/canvas-sync-alarms.js",
    "platform/canvas-sync-browser.js",
    "platform/canvas-registration.js",
    "platform/fullscreen.js",
    "platform/router.js",
    "background.js"
].map((file) => `js/${file}`));

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, "utf8"));
}

function firefoxManifestFrom(chromiumManifest) {
    if (chromiumManifest.manifest_version !== 3) throw new Error("Chromium source manifest must be Manifest V3.");
    if (chromiumManifest.background?.service_worker !== "js/background.js") throw new Error("Chromium source must retain js/background.js as its service worker.");
    const gecko = chromiumManifest.browser_specific_settings?.gecko;
    if (!gecko?.id) throw new Error("Chromium source manifest must provide the Firefox Gecko ID.");

    const firefoxManifest = structuredClone(chromiumManifest);
    firefoxManifest.background = { scripts: FIREFOX_BACKGROUND_SCRIPTS.slice(), persistent: false };
    firefoxManifest.browser_specific_settings.gecko.strict_min_version = FIREFOX_ESR_MIN_VERSION;
    return firefoxManifest;
}

function copyExtensionSources() {
    ["_locales", "css", "html", "icon", "js"].forEach((directory) => {
        const source = path.join(ROOT, directory);
        if (fs.existsSync(source)) fs.cpSync(source, path.join(OUTPUT, directory), { recursive: true });
    });
}

export function buildFirefoxArtifact() {
    const chromiumManifest = readJson(path.join(ROOT, "manifest.json"));
    const firefoxManifest = firefoxManifestFrom(chromiumManifest);
    fs.rmSync(OUTPUT, { recursive: true, force: true });
    fs.mkdirSync(OUTPUT, { recursive: true });
    copyExtensionSources();
    fs.writeFileSync(path.join(OUTPUT, "manifest.json"), `${JSON.stringify(firefoxManifest, null, 2)}\n`);
    return { output: OUTPUT, manifest: firefoxManifest };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const result = buildFirefoxArtifact();
    console.log(`Firefox MV3 artifact: ${path.relative(ROOT, result.output)}`);
    console.log(`Firefox background: ordered classic scripts via background.scripts (event page, persistent=false)`);
    console.log(`Firefox minimum: ESR ${FIREFOX_ESR_MIN_VERSION} (storage.session compatibility boundary)`);
    console.log("Firefox lint: web-ext unavailable locally; JSON/schema/reference checks are run by the extension tests.");
}
