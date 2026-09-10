import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUTPUT = path.join(ROOT, "dist", "firefox");
const OUTPUT_OVERRIDE = process.env.APSTUDY_FIREFOX_OUTPUT || "";
const OUTPUT = OUTPUT_OVERRIDE ? path.resolve(OUTPUT_OVERRIDE) : DEFAULT_OUTPUT;
export const FIREFOX_TEMP_OUTPUT_PREFIX = "apstudycanvas-firefox-test-";
// Firefox 128 is the first release that supports MAIN execution worlds in
// both static content_scripts and dynamic scripting registration. CSS :has()
// arrived earlier (Firefox 121), so the execution-world boundary wins.
export const FIREFOX_ESR_MIN_VERSION = "128.0";
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
    "platform/planner-page-bridge.js",
    "platform/overlay-launcher.js",
    "platform/script-blocker.js",
    "canvas-adapter/writeback.js",
    "platform/writeback-consent.js",
    "platform/writeback-mirrors.js",
    "platform/writeback-executor.js",
    "platform/writeback.js",
    "platform/writeback-runtime.js",
    "platform/router.js",
    "background.js"
].map((file) => `js/${file}`));

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, "utf8"));
}

function isSamePathOrAncestor(candidate, target) {
    const relative = path.relative(candidate, target);
    return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function assertCanonicalDefaultOutput(output) {
    const rootRealPath = fs.realpathSync(ROOT);
    let existingPath = output;
    while (!fs.existsSync(existingPath)) existingPath = path.dirname(existingPath);

    const expectedRealPath = path.join(rootRealPath, path.relative(ROOT, existingPath));
    if (fs.realpathSync(existingPath) !== expectedRealPath) {
        throw new Error("Refusing Firefox default output through a symlink outside the repository.");
    }
    if (fs.existsSync(output) && fs.lstatSync(output).isSymbolicLink()) {
        throw new Error("Refusing Firefox default output because it is a symbolic link.");
    }
}

export function validateFirefoxOutput(output, { isOverride = false } = {}) {
    const resolvedOutput = path.resolve(output);
    if (resolvedOutput === path.parse(resolvedOutput).root) {
        throw new Error(`Refusing Firefox output at filesystem root: ${resolvedOutput}`);
    }
    if (isSamePathOrAncestor(resolvedOutput, ROOT)) {
        throw new Error(`Refusing Firefox output at the repository root or one of its ancestors: ${resolvedOutput}`);
    }

    if (!isOverride) {
        if (resolvedOutput !== DEFAULT_OUTPUT) {
            throw new Error(`Firefox default output must be exactly ${DEFAULT_OUTPUT}`);
        }
        assertCanonicalDefaultOutput(resolvedOutput);
        return resolvedOutput;
    }

    const tempRoot = path.resolve(os.tmpdir());
    const outputName = path.basename(resolvedOutput);
    if (path.dirname(resolvedOutput) !== tempRoot || !outputName.startsWith(FIREFOX_TEMP_OUTPUT_PREFIX)) {
        throw new Error(`APSTUDY_FIREFOX_OUTPUT must be a direct child of ${tempRoot} named ${FIREFOX_TEMP_OUTPUT_PREFIX}*`);
    }
    if (!fs.existsSync(resolvedOutput)) {
        throw new Error("APSTUDY_FIREFOX_OUTPUT must be an existing temporary artifact directory created by the test.");
    }
    const outputStats = fs.lstatSync(resolvedOutput);
    if (!outputStats.isDirectory() || outputStats.isSymbolicLink()) {
        throw new Error("APSTUDY_FIREFOX_OUTPUT must be a real directory, not a file or symbolic link.");
    }

    const tempRootRealPath = fs.realpathSync(tempRoot);
    const outputRealPath = fs.realpathSync(resolvedOutput);
    if (path.dirname(outputRealPath) !== tempRootRealPath || path.basename(outputRealPath) !== outputName) {
        throw new Error("APSTUDY_FIREFOX_OUTPUT must not escape the OS temporary directory through a symbolic link.");
    }
    return resolvedOutput;
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
    ["_locales", "css", "font", "html", "icon", "js", "rules"].forEach((directory) => {
        const source = path.join(ROOT, directory);
        if (fs.existsSync(source)) fs.cpSync(source, path.join(OUTPUT, directory), { recursive: true });
    });
}

export function buildFirefoxArtifact() {
    validateFirefoxOutput(OUTPUT, { isOverride: Boolean(OUTPUT_OVERRIDE) });
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
    console.log(`Firefox minimum: ${FIREFOX_ESR_MIN_VERSION} (MAIN-world content scripts; CSS :has() is available from 121)`);
    console.log("Firefox lint: web-ext unavailable locally; JSON/schema/reference checks are run by the extension tests.");
}
