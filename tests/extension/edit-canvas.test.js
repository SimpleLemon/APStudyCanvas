"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.resolve(__dirname, "../../js/edit-canvas.js"), "utf8");

test("workspace shell startup is promise-guarded and registered once", () => {
    assert.match(source, /if \(shellStartupPromise\) return shellStartupPromise;/);
    assert.match(source, /window\.APStudyCanvasEditCanvasStartup = Object\.freeze\(\{ start: startShell \}\);/);
    assert.match(source, /document\.addEventListener\("DOMContentLoaded", startShell, \{ once: true \}\);/);
    assert.match(source, /setupGlobalSearch\(\);[\s\S]*setupPopovers\(\);[\s\S]*setupHeader\(\);[\s\S]*await setupWorkspace\(\);/);
    assert.match(source, /Promise\.resolve\(popupSetup\)/);
    assert.doesNotMatch(source, /ensureLegacySetup|setupLegacy/);
});

test("embedded close delegates to the host and recovery awaits a distinct confirmed discard action", () => {
    assert.match(source, /if \(isEmbeddedShell\) \{[\s\S]*overlayControl\?\.\("close"\)/);
    assert.match(source, /if \(ownsHostTab\) \{[\s\S]*chrome\.tabs\?\.remove/);
    assert.match(source, /await window\.APStudyCanvasPopup\?\.overlayControl\?\.\("discard-close", \{ confirmDiscard: true \}\)/);
    assert.match(source, /if \(result\?\.ok !== true\) \{[\s\S]*manualCloseFailureMessage\(result\?\.code\)/);
    assert.match(source, /if \(isEmbeddedShell\) await requestEmbeddedDiscardClose\(\);[\s\S]*else window\.close\(\);/);
    assert.doesNotMatch(source, /submit[\s\S]{0,420}overlayControl\?\.\("close"\)/);
    assert.doesNotMatch(source, /tabs\?*\.create|openExpandedWorkspace/);
});

test("theme drafts use the sequenced controller transport and observe synchronization failures", () => {
    assert.match(source, /signalDraftState\?\.\(\{ draft: this\.isDirty\(\) \}\)/);
    assert.match(source, /\.catch\(\(error\) => \{[\s\S]*reportDraftSyncFailure\?\.\(error\)/);
    assert.doesNotMatch(source, /overlayControl\?\.\(\"draft-state\"/);
    assert.match(source, /APStudyCanvasPopup\?\.discardModernDrafts\?\.\(\)/);
    assert.doesNotMatch(source, /discard-custom-styles|discard-dark-palette/);
});

test("the embedded editor answers authenticated host draft queries from current local state", () => {
    assert.match(source, /event\.source !== window\.parent/);
    assert.match(source, /message\.overlaySession !== embeddedOverlaySession/);
    assert.match(source, /type: "apstudycanvas-draft-response"[\s\S]*draft: themeDraft\.isDirty\(\)/);
    assert.match(source, /overlayParentOrigin/);
    assert.match(source, /declaredOrigin && referrerOrigin && declaredOrigin !== referrerOrigin/);
});

test("embedded Escape leaves local controls first, then delegates to the authenticated host close path", () => {
    assert.match(source, /if \(!isEmbeddedShell\) return;[\s\S]*void closeWorkspaceOrPopup\(\);/);
    assert.match(source, /clearSearchInputs\(\);[\s\S]*input\?\.focus\(\);[\s\S]*return;[\s\S]*\/\/ Keyboard events focused inside the iframe/);
});
