"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "../..");
const sourceDirectories = ["js", "css", "html", "font"];
const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "apstudycanvas-firefox-test-"));
const buildScript = path.join(root, "scripts/build-firefox-manifest.mjs");
const copiedExtensions = new Set([".js", ".css", ".html", ".woff2", ".txt"]);

function sourcePaths(directory, relative = directory) {
    return fs.readdirSync(path.join(root, relative), { withFileTypes: true }).flatMap((entry) => {
        const child = path.join(relative, entry.name);
        return entry.isDirectory() ? sourcePaths(directory, child) : copiedExtensions.has(path.extname(entry.name)) ? [child] : [];
    });
}

test.after(() => fs.rmSync(artifactRoot, { recursive: true, force: true }));

test("Firefox copied sources retain byte parity while the generated manifest records intentional transforms", () => {
    const build = spawnSync(process.execPath, [buildScript], {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, APSTUDY_FIREFOX_OUTPUT: artifactRoot }
    });
    assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);
    const paths = sourceDirectories.flatMap((directory) => sourcePaths(directory)).sort();
    assert.ok(paths.length > 0, "expected copied Firefox source files");

    paths.forEach((relative) => {
        const source = fs.readFileSync(path.join(root, relative));
        const artifactPath = path.join(artifactRoot, relative);
        assert.ok(fs.existsSync(artifactPath), `missing Firefox artifact for ${relative}`);
        assert.equal(Buffer.compare(source, fs.readFileSync(artifactPath)), 0, `Firefox artifact drifted from ${relative}`);
    });

    const chromium = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
    const firefox = JSON.parse(fs.readFileSync(path.join(artifactRoot, "manifest.json"), "utf8"));
    assert.deepEqual(firefox.content_scripts.slice(1), chromium.content_scripts.slice(1));
    assert.deepEqual(firefox.content_scripts[0], chromium.content_scripts[0]);
});
