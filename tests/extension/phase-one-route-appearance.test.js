"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const content = fs.readFileSync(path.join(root, "js/content.js"), "utf8");
const css = fs.readFileSync(path.join(root, "css/content.css"), "utf8");

test("quiz-safe guard is conservative and runs before extension UI boot", () => {
    assert.match(content, /function isQuizSafeRoute\(locationLike = window\.location\)/);
    assert.doesNotMatch(content, /\/courses\\\/\\d\+\\\/quizzes\(\?:\\\/\\d\+\)\?/, "quiz detail pages must not be treated as active attempts");
    assert.match(content, /(?:take\|history\|submission\|start)/);
    assert.match(content, /applyQuizSafeRouteGuard\(\)\)\s*\{[\s\S]{0,500}?return;/);
    assert.match(content, /contentTodoIntegration\?\.pause\?\.\("quiz-safe-route"\)/);
    assert.match(content, /contentCardAppearance\?\.stop\?\.\(\)/);
    assert.match(content, /teardownContentOverlayHost\("quiz-safe-route"\)/);
    assert.match(content, /if \(applyQuizSafeRouteGuard\(\)\)\s*\{[\s\S]{0,280}?ensureContentLifecycle\(\);/);
    assert.match(content, /const wasSafe = wasQuizSafeRoute\(\);[\s\S]{0,200}?if \(applyQuizSafeRouteGuard\(\)\) return;[\s\S]{0,120}?if \(wasSafe\) resumeQuizSafeRouteEnhancements\(\)/);
    assert.match(content, /function resumeQuizSafeRouteEnhancements\(\)[\s\S]{0,180}?startCanvasEnhancements\("quiz-safe-resume"\)/);
    assert.match(content, /routeSafety\(\) \{[\s\S]{0,420}?if \(wasSafe && !isSafe\) resumeQuizSafeRouteEnhancements\(\)/, "a live safe-mode opt-out restores only APStudy owners");
});

test("appearance primitives remain owned, inert at defaults, and reversible", () => {
    assert.match(content, /--apstudy-background-opacity/);
    assert.match(content, /--apstudy-background-blur/);
    assert.match(content, /options\.cardImageRoundness > 0/);
    assert.match(content, /options\.cardPadding > 0/);
    assert.match(content, /function clearCustomBackground\(\)/);
    assert.match(css, /data-apstudycanvas-quiz-safe="true"/);
    assert.doesNotMatch(css, /html\[data-apstudycanvas-quiz-safe="true"\]\s+\.ic-/);
});

test("custom background URLs are validated and CSS-escaped before they become a style rule", () => {
    assert.match(content, /function safeCustomBackgroundUrl\(value\)/);
    assert.match(content, /const backgroundUrl = safeCustomBackgroundUrl\(options\.customBackgroundLink\)/);
    assert.match(content, /url\(\$\{JSON\.stringify\(backgroundUrl\)\}\)/);
    assert.doesNotMatch(content, /url\('\$\{options\.customBackgroundLink\}'\)/);
});
