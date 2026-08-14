"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const html = fs.readFileSync(path.join(root, "html/popup.html"), "utf8");
const css = fs.readFileSync(path.join(root, "css/popup.css"), "utf8");
const popupSource = fs.readFileSync(path.join(root, "js/popup.js"), "utf8");

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
        "workspace-section-calendar-accounts", "calendar-accounts-status-value", "nest-account-status-inline",
        "calendar-nest-login", "nest-consent-enabled", "nest-consent-refresh", "nest-consent-status",
        "calendar-capability-status", "calendar-routing-controls", "calendar-route-select", "workspace-canvas-account-list"
    ].forEach((id) => assert.ok(hasId(id), `preserved popup ID: ${id}`));
});

test("Calendar & Accounts disclosure states the API history, consent, and future capability boundary", () => {
    const section = html.match(/<section class="workspace-section" id="workspace-section-calendar-accounts"[\s\S]*?<\/section>\s*<section class="workspace-section" id="workspace-section-data-support"/i)?.[0] || "";
    const copy = section.toLowerCase();
    assert.match(section, /<details class="calendar-data-disclosure">/);
    assert.match(section, /<summary>What Canvas calendar sync can access<\/summary>/);
    assert.match(copy, /full canvas history available through the canvas api/);
    assert.match(copy, /ongoing reads/);
    assert.match(copy, /future two-way writes and mirroring are capability-gated/);
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

test("Canvas calendar mode exposes one labeled radio group with roadmap copy and live save status", () => {
    const section = html.match(/<section class="workspace-section" id="workspace-section-calendar-accounts"[\s\S]*?<\/section>\s*<section class="workspace-section" id="workspace-section-data-support"/i)?.[0] || "";
    assert.match(section, /<fieldset class="calendar-mode-panel" aria-describedby="canvas-calendar-mode-help canvas-calendar-mode-status">/);
    assert.match(section, /APStudy overlay keeps the native Canvas calendar visible/);
    assert.match(section, /signed-in Nest saved events plus consented Canvas projections/);
    assert.match(section, /Replace native Canvas is experimental/);
    assert.match(section, /native Canvas restoration is guaranteed/);
    assert.match(section, /id="canvas-calendar-mode-off"[^>]*name="canvas-calendar-mode"[^>]*value="off"/);
    assert.match(section, /id="canvas-calendar-mode-overlay"[^>]*name="canvas-calendar-mode"[^>]*value="overlay"/);
    assert.match(section, /id="canvas-calendar-mode-replace"[^>]*name="canvas-calendar-mode"[^>]*value="replace"[^>]*disabled[^>]*aria-disabled="true"/);
    ["canvas-calendar-mode-off", "canvas-calendar-mode-overlay", "canvas-calendar-mode-replace"].forEach((id) => {
        assert.match(section, new RegExp(`<label[^>]*for="${id}"`));
        assert.match(section, new RegExp(`id="${id}"[^>]*data-setting-key="canvas_calendar_mode"`));
    });
    assert.match(section, /id="canvas-calendar-mode-status"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"/);
});

test("Canvas calendar mode gates overlay and replacement without changing the saved preference", () => {
    assert.match(popupSource, /function overlayReady\(\)[\s\S]*authenticated\(\)[\s\S]*currentBinding\(\)[\s\S]*consentCurrent\(\)[\s\S]*state\.projectionEnabled[\s\S]*state\.overlayEnabled/);
    assert.match(popupSource, /Sign in to Nest to enable APStudy overlay/);
    assert.match(popupSource, /Verify the current Canvas account to enable APStudy overlay/);
    assert.match(popupSource, /Grant current-version consent for this verified Canvas account to enable APStudy overlay/);
    assert.match(popupSource, /platform overlay capability is disabled/);
    assert.match(popupSource, /state\.replacementEnabled/);
    assert.match(popupSource, /Replace native Canvas is experimental and remains disabled until the platform replacement capability is explicitly enabled/);
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
    assert.match(popupSource, /input\[name=canvas-calendar-mode\][\s\S]*?addEventListener/);
    assert.match(popupSource, /if \(!calendarModeListenerBound\)/);
    const modeWriter = popupSource.match(/function persistCalendarMode\([\s\S]*?\n    }/i)?.[0] || "";
    assert.doesNotMatch(modeWriter, /popupPlatformRequest\(/);
});

test("new sync and account actions are safe placeholders by default", () => {
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
