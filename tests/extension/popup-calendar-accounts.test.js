"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const html = fs.readFileSync(path.join(root, "html/popup.html"), "utf8");
const css = fs.readFileSync(path.join(root, "css/popup.css"), "utf8");
const popupSource = fs.readFileSync(path.join(root, "js/popup.js"), "utf8");
const popupControllerSource = fs.readFileSync(path.join(root, "js/popup-controller.js"), "utf8");
const editCanvasSource = fs.readFileSync(path.join(root, "js/edit-canvas.js"), "utf8");

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function openingTagFor(id) {
    const match = html.match(new RegExp(`<[^>]*\\bid="${escapeRegExp(id)}"[^>]*>`, "i"));
    assert.ok(match, `missing element: ${id}`);
    return match[0];
}

function hasId(id) {
    return new RegExp(`\\bid="${escapeRegExp(id)}"`, "i").test(html);
}

test("Calendar & Accounts keeps IDs unique and preserves the controller contract", () => {
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
    assert.equal(ids.length, new Set(ids).size, "popup IDs must remain unique");
    [
        "workspace-section-calendar-accounts", "calendar-accounts-status-value",
        "calendar-nest-login", "nest-consent-enabled", "nest-consent-refresh", "nest-consent-status",
        "calendar-capability-status", "calendar-routing-controls", "calendar-route-select", "workspace-canvas-account-list",
        "account-section-avatar", "account-section-name", "account-section-source", "account-section-status", "account-section-binding"
    ].forEach((id) => assert.ok(hasId(id), `preserved popup ID: ${id}`));
});

test("Calendar & Accounts uses the approved grouped account and sync layout", () => {
    const section = html.match(/<section class="workspace-section" id="workspace-section-calendar-accounts"[\s\S]*?<\/section>\s*<section class="workspace-section" id="workspace-section-data-support"/i)?.[0] || "";
    ["Nest connection", "Canvas accounts", "Access &amp; sync", "Calendar display", "Activity &amp; conflicts"].forEach((heading) => {
        assert.match(section, new RegExp(`<h3[^>]*>${heading}</h3>`), `group heading: ${heading}`);
    });
    assert.match(section, /id="calendar-upload-capability"[^>]*>Read sync checking<\/span>/);
    assert.match(section, /id="calendar-projection-capability"[^>]*>Projection checking<\/span>/);
    assert.match(section, /id="calendar-overlay-capability"[^>]*>Overlay checking<\/span>/);
    assert.match(section, /id="calendar-replacement-capability"[^>]*>Replacement experimental<\/span>/);
    assert.match(section, /id="calendar-mutation-capability"[^>]*>Personal updates checking<\/span>/);
    assert.doesNotMatch(section, /Lifecycle actions remain unavailable until controller wiring|<span[^>]*>Not enabled<\/span>|Placeholder/i);
});

test("popup loads the connection coordinator before the base popup controller", () => {
    const scripts = Array.from(html.matchAll(/<script[^>]+src="([^"]+)"/g), (match) => match[1]);
    assert.ok(scripts.includes("../js/platform/connection-coordinator.js"));
    assert.ok(scripts.indexOf("../js/platform/connection-coordinator.js") < scripts.indexOf("../js/popup-controller.js"));
});

test("Calendar & Accounts owns the account identity card and the sidebar owns its route", () => {
    const section = html.match(/<section class="workspace-section" id="workspace-section-calendar-accounts"[\s\S]*?<\/section>\s*<section class="workspace-section" id="workspace-section-data-support"/i)?.[0] || "";
    const nav = html.match(/<nav class="workspace-nav"[\s\S]*?<\/nav>/i)?.[0] || "";
    assert.match(section, /id="account-section-avatar"/);
    assert.match(section, /id="account-section-name"/);
    assert.match(section, /id="account-section-source"/);
    assert.match(section, /id="account-section-status"/);
    assert.match(section, /id="account-section-binding"/);
    assert.doesNotMatch(nav, /data-workspace-target="calendar-accounts"/);
    assert.match(html, /id="workspace-account-trigger"[^>]*data-workspace-target="calendar-accounts"/);
});

test("scoped calendar controller exclusively owns consent controls", () => {
    const baseBindings = popupControllerSource.match(/function bindActions\(\) \{[\s\S]*?\n        \}/)?.[0] || "";
    const identityRefresh = popupControllerSource.match(/async function refreshIdentity\(\) \{[\s\S]*?\n        \}/)?.[0] || "";
    assert.doesNotMatch(baseBindings, /#nest-consent-enabled|#nest-consent-refresh/);
    assert.doesNotMatch(identityRefresh, /loadConsent\(|loadCalendars\(/);
    assert.match(popupSource, /#nest-consent-enabled[\s\S]*?stopImmediatePropagation/);
    assert.match(popupSource, /#nest-consent-refresh[\s\S]*?stopImmediatePropagation/);
});

test("Calendar & Accounts disclosure states the API history, consent, and future capability boundary", () => {
    const section = html.match(/<section class="workspace-section" id="workspace-section-calendar-accounts"[\s\S]*?<\/section>\s*<section class="workspace-section" id="workspace-section-data-support"/i)?.[0] || "";
    const copy = section.toLowerCase();
    assert.match(section, /<details class="calendar-data-disclosure">/);
    assert.match(section, /<summary>What Canvas calendar sync can access<\/summary>/);
    assert.match(copy, /full canvas history available through the canvas api/);
    assert.match(copy, /ongoing reads/);
    assert.match(copy, /personal event updates, planner updates, and selected item mirroring each require separate permission/);
    assert.match(copy, /automatically included in nest shares and ics/);
    assert.match(copy, /no canvas data uploads before per-account consent for the current sync version/);
});

test("Calendar & Accounts wires labels and live status regions accessibly", () => {
    ["nest-consent-enabled", "calendar-route-select", "calendar-route-completed-select", "canvas-current-account-sync-opt-in"].forEach((id) => {
        assert.match(openingTagFor(id), new RegExp(`\\bid="${id}"`));
        assert.match(html, new RegExp(`<label[^>]*\\bfor="${id}"[^>]*>`), `explicit label for ${id}`);
    });

    assert.match(openingTagFor("calendar-route-select"), /aria-describedby="calendar-route-incomplete-help calendar-route-incomplete-status"/);
    assert.match(openingTagFor("calendar-route-completed-select"), /aria-describedby="calendar-route-completed-help calendar-route-completed-status"/);
    assert.match(openingTagFor("calendar-sync-status"), /role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"/);
    assert.match(openingTagFor("nest-consent-status"), /role="status"[^>]*aria-live="polite"/);
    ["calendar-route-incomplete-status", "calendar-route-completed-status"].forEach((id) => assert.match(openingTagFor(id), /role="status"/));
});

test("Canvas calendar mode exposes one concise labeled radio group with trailing controls and live save status", () => {
    const section = html.match(/<section class="workspace-section" id="workspace-section-calendar-accounts"[\s\S]*?<\/section>\s*<section class="workspace-section" id="workspace-section-data-support"/i)?.[0] || "";
    assert.match(section, /<fieldset class="calendar-mode-panel" aria-describedby="canvas-calendar-mode-help canvas-calendar-mode-status">/);
    assert.match(section, /Overlay keeps Canvas visible\. Replacement is experimental\./);
    assert.match(section, /<span><strong>Canvas only<\/strong><small>Use the native Canvas calendar\.<\/small><\/span>\s*<input type="radio" id="canvas-calendar-mode-off"/);
    assert.match(section, /<span><strong>APStudy overlay<\/strong><small>Add Nest and synced Canvas items while keeping Canvas visible\.<\/small><\/span>\s*<input type="radio" id="canvas-calendar-mode-overlay"/);
    assert.match(section, /<span><strong>Replace Canvas <em>Experimental<\/em><\/strong><small>Use APStudy as the calendar surface when available\.<\/small><\/span>\s*<input type="radio" id="canvas-calendar-mode-replace"/);
    assert.match(section, /id="canvas-calendar-mode-off"[^>]*name="canvas-calendar-mode"[^>]*value="off"/);
    assert.match(section, /id="canvas-calendar-mode-overlay"[^>]*name="canvas-calendar-mode"[^>]*value="overlay"/);
    assert.match(section, /id="canvas-calendar-mode-replace"[^>]*name="canvas-calendar-mode"[^>]*value="replace"[^>]*disabled[^>]*aria-disabled="true"/);
    ["canvas-calendar-mode-off", "canvas-calendar-mode-overlay", "canvas-calendar-mode-replace"].forEach((id) => {
        assert.match(section, new RegExp(`<label[^>]*for="${id}"`));
        assert.match(section, new RegExp(`id="${id}"[^>]*data-setting-key="canvas_calendar_mode"`));
    });
    assert.match(section, /id="canvas-calendar-mode-status"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"/);
});

test("account controls use live status guidance instead of startup-only disabled reasons", () => {
    assert.doesNotMatch(editCanvasSource, /Consent cannot be changed until Nest identity loads/);
    assert.doesNotMatch(editCanvasSource, /Consent cannot be refreshed until Nest identity loads/);
    assert.match(editCanvasSource, /\["#nest-consent-enabled", "nest-consent-status"\]/);
    assert.match(editCanvasSource, /\["#nest-consent-refresh", "nest-consent-status"\]/);
    assert.match(editCanvasSource, /\["#canvas-calendar-mode-overlay", "canvas-calendar-mode-help canvas-calendar-mode-status"\]/);
    assert.match(editCanvasSource, /\["#canvas-current-account-sync-opt-in", "canvas-current-account-help"\]/);
});

test("Canvas calendar mode gates overlay and replacement without changing the saved preference", () => {
    assert.match(popupSource, /function overlayReady\(\)[\s\S]*authenticated\(\)[\s\S]*currentBinding\(\)[\s\S]*consentCurrent\(\)[\s\S]*state\.projectionEnabled[\s\S]*state\.overlayEnabled/);
    assert.match(popupSource, /Sign in to Nest for overlay/);
    assert.match(popupSource, /Verify this Canvas account for overlay/);
    assert.match(popupSource, /Allow Canvas data access for overlay/);
    assert.match(popupSource, /Overlay is unavailable on this platform/);
    assert.match(popupSource, /state\.replacementEnabled/);
    assert.match(popupSource, /Experimental replacement is unavailable/);
    assert.match(popupSource, /state\.calendarMode = normalizeCalendarMode\(values\?\.canvas_calendar_mode\)/);
    assert.doesNotMatch(popupSource, /onCanvasContext[\s\S]*?state\.calendarMode\s*=\s*["']off/);
    assert.doesNotMatch(popupSource, /handleIdentityChange[\s\S]*?state\.calendarMode\s*=\s*["']off/);
});

test("Canvas calendar mode uses the existing debounced writer, key-scoped rollback, and teardown flush", () => {
    assert.match(popupSource, /queueSettingWrite\(\{ canvas_calendar_mode: next \}, "canvas-calendar-mode"\)/);
    assert.match(popupSource, /applyCalendarModeSnapshot\?\.\(value, "failed"\)/);
    assert.match(popupSource, /state\.calendarModeStatus = "Saving…"/);
    assert.match(popupSource, /state\.calendarModeStatus = "Saved\."/);
    assert.match(popupSource, /state\.calendarModeStatus = "Failed — calendar mode reverted\."/);
    assert.match(popupSource, /function flushPendingWrites\(\)[\s\S]*popupSettingsStore\?\.flush/);
    assert.match(popupSource, /input\[name=canvas-calendar-mode\][\s\S]*?listen\(control/);
    assert.match(popupSource, /if \(!calendarModeListenerBound\)/);
    const modeWriter = popupSource.match(/function persistCalendarMode\([\s\S]*?\n    }/i)?.[0] || "";
    assert.doesNotMatch(modeWriter, /popupPlatformRequest\(/);
});

test("sync and account actions are live-gated by context, consent, and capabilities", () => {
    ["calendar-sync-controls", "calendar-routing-controls", "canvas-current-account-card"].forEach((id) => {
        const tag = openingTagFor(id);
        assert.match(tag, /\bhidden\b/);
        assert.match(tag, /\binert\b/);
    });
    ["calendar-sync-start", "calendar-sync-resume", "calendar-sync-cancel", "calendar-sync-refresh", "canvas-current-account-sync-opt-in"].forEach((id) => {
        const tag = openingTagFor(id);
        assert.match(tag, /\bdisabled\b/);
        assert.match(tag, /aria-disabled="true"/);
    });
    assert.doesNotMatch(openingTagFor("calendar-sync-status"), /assignment|lesson|educational|payload|title/i);
    assert.match(openingTagFor("calendar-sync-status"), /data-state="idle"/);
    assert.match(popupSource, /function presentation\(\)/);
    assert.match(popupSource, /setDisabled\(q\("#calendar-sync-start"\), !syncReady\(\) \|\| state\.syncBusy\)/);
    assert.match(popupSource, /const availableContext = presentation\(\)\.access && state\.projectionEnabled/);
    assert.match(popupSource, /show\(routing, availableContext && Boolean\(state\.sourceRef\)\)/);
});

test("calendar controller subscribes to the connection coordinator and publishes loaded state", () => {
    assert.match(popupSource, /popupCalendarConnection\(controller\)/);
    assert.match(popupSource, /connection\.getSnapshot\(\)/);
    assert.match(popupSource, /connection\.subscribe\(\(snapshot\) =>/);
    assert.match(popupSource, /connection\.setContext\(binding \|\| null\)/);
    assert.match(popupSource, /connection\.update\(update\)/);
    assert.match(popupSource, /applyCapabilities\(snapshot\.capabilities \|\| \{\}/);
    assert.match(popupSource, /if \(read && !consentCurrent\(\)\)[\s\S]*?current: false, granted: false/);
    assert.match(popupSource, /publishConnectionUpdate\(\{ consent: \{ read, write: state.writeConsent \} \}\)/);
    assert.match(popupSource, /connection\.isCurrent\(identityGeneration\.value\)/);
    assert.match(popupSource, /applyConnectionSnapshot\(snapshot, \{ loadFreshConsent: true \}\)/);
});

test("sync lifecycle uses the exact safe binding payload and public-result boundary", () => {
    assert.match(popupSource, /contractVersion:\s*1/);
    assert.match(popupSource, /accountKey:\s*binding\.accountKey/);
    assert.match(popupSource, /origin:\s*binding\.origin/);
    assert.match(popupSource, /canvasUserId:\s*binding\.canvasUserId/);
    assert.match(popupSource, /sourceId:\s*popupCalendarDeterministicSourceId\(binding\)/);
    assert.match(popupSource, /label:\s*binding\.label/);
    assert.match(popupSource, /consentVersion:\s*POPUP_CANVAS_CONSENT_VERSION/);
    assert.match(popupSource, /scope:\s*popupCalendarClone\(POPUP_CANVAS_SYNC_SCOPE\)/);
    assert.match(popupSource, /descriptors:\s*popupCalendarClone\(POPUP_CANVAS_SYNC_DESCRIPTORS\)/);
    assert.match(popupSource, /requestId/);
    assert.match(popupSource, /popupPlatformRequest\(type,\s*syncPayload\(binding,\s*requestId\)\)/);
    assert.doesNotMatch(popupSource, /popupPlatformRequest\(\"CANVAS_SYNC_(?:RESUME|CANCEL)\"/);
    assert.match(popupSource, /setDisabled\(q\(\"#calendar-sync-resume\"\),\s*true\)/);
    assert.match(popupSource, /setDisabled\(q\(\"#calendar-sync-cancel\"\),\s*true\)/);
    assert.match(popupSource, /POPUP_SYNC_PUBLIC_RUN_ID_BLOCKER/);
    assert.match(popupSource, /POPUP_CANVAS_CONSENT_VERSION\s*=\s*1/);
    assert.match(popupSource, /"full_history_upload",\s*"ongoing_read"/);
    assert.match(popupSource, /source_ref/);
});

test("sync account changes clear stale public status and keep refresh gated", () => {
    assert.match(popupSource, /state\.syncResult\s*=\s*null/);
    assert.match(popupSource, /state\.syncBusy\s*=\s*false/);
    assert.match(popupSource, /state\.syncRequestId\s*=\s*null/);
    assert.match(popupSource, /setDisabled\(q\(\"#calendar-sync-start\"\),\s*!syncReady\(\)\s*\|\|\s*state\.syncBusy\)/);
    assert.match(popupSource, /setDisabled\(q\(\"#calendar-sync-refresh\"\),\s*!syncReady\(\)\s*\|\|\s*state\.syncBusy\)/);
    assert.match(popupSource, /waiting_for_canvas_session/);
    assert.match(popupSource, /matching Canvas account/);
    assert.doesNotMatch(popupSource, /calendar-sync-controls[^\\n]*CANVAS_SYNC_(?:RESUME|CANCEL)/);
});

test("routing provides separate incomplete and completed selectors with degraded read-only affordances", () => {
    assert.match(openingTagFor("calendar-routing-controls"), /hidden/);
    assert.match(html, /<legend>Incomplete Canvas items<\/legend>/);
    assert.match(html, /<legend>Completed Canvas items<\/legend>/);
    assert.match(html, /id="calendar-route-incomplete-status"[^>]*data-state="degraded"[^>]*role="status"/);
    assert.match(html, /id="calendar-route-completed-status"[^>]*data-state="degraded"[^>]*role="status"/);
    assert.match(html.toLowerCase(), /read-only destinations affect apstudy presentation only/);
    assert.match(css, /\.calendar-route-degraded/);
    assert.match(css, /\.calendar-sync-status\[data-state="error"\]/);
    assert.match(css, /\.calendar-sync-status-progress, \.calendar-sync-status-error/);
});
