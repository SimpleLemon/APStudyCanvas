"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const editors = require("../../js/themes.js");
const backgroundsSource = require("node:fs").readFileSync(require("node:path").join(__dirname, "../../js/backgrounds.js"), "utf8");
const popupSource = require("node:fs").readFileSync(require("node:path").join(__dirname, "../../js/popup.js"), "utf8");
const controllerSource = require("node:fs").readFileSync(require("node:path").join(__dirname, "../../js/popup-controller.js"), "utf8");
const schemaSource = require("node:fs").readFileSync(require("node:path").join(__dirname, "../../js/settings-schema.js"), "utf8");

test("course-card editor resolves all partitions atomically and removes stale course copies", async () => {
    let current = { custom_cards: { one: { default: "Biology", eid: "1", name: "Old" }, two: { name: "Untouched" } }, custom_cards_2: { one: { code: "OLD" } }, custom_cards_3: { one: { credits: "4" } } };
    const messages = [];
    const editor = editors.createCourseCardEditor({
        transaction: async (changes) => { current = changes(current); return current; },
        status: (message, error) => messages.push([message, error]),
        sendToCanvas: async () => true
    });
    await editor.save("one", { name: "Biology 101", code: "BIO 101", img: "https://example.edu/card.png", hidden: true });
    assert.deepEqual(current.custom_cards.one, { default: "Biology", eid: "1", name: "Biology 101", code: "BIO 101", credits: "4", img: "https://example.edu/card.png", hidden: true, hide: true });
    assert.deepEqual(current.custom_cards.two, { name: "Untouched" });
    assert.deepEqual(current.custom_cards_2, {});
    assert.deepEqual(current.custom_cards_3, {});
    assert.deepEqual(messages, [["Course card saved.", undefined]]);
});

test("course-card reset clears every partition and a failed transaction leaves the draft intact", async () => {
    let current = { custom_cards: { one: { name: "Primary" } }, custom_cards_2: { one: { code: "Stale" } }, custom_cards_3: { one: { img: "https://example.edu/a.jpg" } } };
    const editor = editors.createCourseCardEditor({ transaction: async (changes) => { current = changes(current); return current; }, confirm: () => true });
    await editor.reset("one");
    assert.deepEqual(current, { custom_cards: {}, custom_cards_2: {}, custom_cards_3: {} });
    const draft = { name: "Still here", img: "https://example.edu/a.jpg" };
    const failing = editors.createCourseCardEditor({ transaction: async () => { throw new Error("storage unavailable"); } });
    await assert.rejects(failing.save("one", draft), /storage unavailable/);
    assert.deepEqual(draft, { name: "Still here", img: "https://example.edu/a.jpg" });
});

test("course-card editor rejects invalid images and honours reset cancellation", async () => {
    let writes = 0;
    const editor = editors.createCourseCardEditor({ transaction: async () => { writes += 1; }, confirm: () => false });
    await assert.rejects(editor.save("one", { img: "file:///private/card.png" }), /COURSE_IMAGE_INVALID/);
    assert.deepEqual(await editor.reset("one"), { cancelled: true });
    assert.equal(writes, 0);
});

test("GPA editor validates bounds, preserves state on rejected reordering, and applies presets", async () => {
    let state = { gpa_calc_bounds: { "A+": { cutoff: 97, gpa: 4 }, A: { cutoff: 93, gpa: 4 }, "A-": { cutoff: 90, gpa: 3.7 }, "B+": { cutoff: 87, gpa: 3.3 }, B: { cutoff: 83, gpa: 3 }, "B-": { cutoff: 80, gpa: 2.7 }, "C+": { cutoff: 77, gpa: 2.3 }, C: { cutoff: 73, gpa: 2 }, "C-": { cutoff: 70, gpa: 1.7 }, "D+": { cutoff: 67, gpa: 1.3 }, D: { cutoff: 63, gpa: 1 }, "D-": { cutoff: 60, gpa: 0.7 }, F: { cutoff: 0, gpa: 0 } } };
    const before = JSON.stringify(state);
    let writes = 0;
    let renders = 0;
    const editor = editors.createGpaBoundsEditor({ read: async () => state, transaction: async (changes) => { writes += 1; state = changes(state); return state; }, render: () => { renders += 1; } });
    await assert.rejects(editor.update("A", "cutoff", 102), /GPA_BOUND_INVALID/);
    assert.equal(JSON.stringify(state), before);
    await editor.update("A", "cutoff", 94);
    assert.equal(state.gpa_calc_bounds.A.cutoff, 94);
    const beforeInvalidOrder = JSON.stringify(state);
    const writesBeforeInvalidOrder = writes;
    await assert.rejects(editor.update("B-", "cutoff", 89), /GPA_BOUND_ORDER_INVALID/);
    assert.equal(writes, writesBeforeInvalidOrder, "a reordered cutoff does not start a transaction");
    assert.equal(JSON.stringify(state), beforeInvalidOrder, "a reordered cutoff keeps the prior bounds");
    assert.ok(renders > 0, "a rejected edit re-renders the stored bounds");
    await assert.rejects(editor.applyPreset({ A: { cutoff: 1, gpa: 1 } }), /GPA_PRESET_INVALID/);
    const invalidOrder = JSON.parse(JSON.stringify(state.gpa_calc_bounds));
    invalidOrder.B.cutoff = 99;
    await assert.rejects(editor.applyPreset(invalidOrder), /GPA_PRESET_INVALID/);
    const invalidRange = JSON.parse(JSON.stringify(state.gpa_calc_bounds));
    invalidRange.A.gpa = 6;
    await assert.rejects(editor.applyPreset(invalidRange), /GPA_PRESET_INVALID/);
});

test("the popup's by-letter GPA control uses the valid shared letter-scale preset", () => {
    const cutoffs = editors.GPA_ORDER.map((letter) => editors.GPA_BY_LETTER_PRESET[letter].cutoff);
    assert.deepEqual(cutoffs, [97, 93, 90, 87, 83, 80, 77, 73, 70, 67, 63, 60, 0]);
    assert.match(controllerSource, /modern-gpa-preset-four-point[\s\S]*?applyPreset\(editors\.GPA_BY_LETTER_PRESET\)/);
});

test("appearance tools preserve CSS draft recovery and enforce HTTPS background presets", async () => {
    const writes = [];
    const draft = { changes: [], setCss(value) { this.changes.push(value); } };
    const tools = editors.createAppearanceTools({
        transaction: async (changes) => { writes.push(changes({})); return changes({}); },
        draft,
        validateHttpsUrl: (value) => ({ valid: String(value).startsWith("https://"), value })
    });
    assert.deepEqual(tools.normalizeFont("Newsreader"), { link: "", family: "Newsreader" });
    assert.deepEqual(tools.normalizeFont("DM Sans"), { link: "", family: "" }, "unpackaged remote families safely become Canvas default");
    await tools.applyCss("body { color: navy; }", "");
    await assert.rejects(tools.applyBackground({ url: "http://example.edu/a.jpg", scale: 100 }), /BACKGROUND_PRESET_INVALID/);
    await tools.applyBackground({ url: "https://example.edu/a.jpg", scale: 115 });
    assert.deepEqual(draft.changes, [false]);
    assert.deepEqual(writes.at(-1), { customBackgroundLink: "https://example.edu/a.jpg", customBackgroundScale: 115 });
});

test("diagnostics invokes explicit inspector and custom-origin transports without false success", async () => {
    const calls = [];
    const cancelled = editors.createDiagnosticsTools({ confirm: () => false, store: { reset: async () => calls.push("reset") } });
    assert.deepEqual(await cancelled.resetSupported(["dark_mode"]), { cancelled: true });
    const statuses = [];
    const active = editors.createDiagnosticsTools({
        confirm: () => true,
        status: (...args) => statuses.push(args),
        store: { localGet: async () => ({ errors: [{ code: "CONTENT_RUNTIME_FAILED", category: "runtime" }, "legacy raw stack"] }), reset: async (keys) => calls.push(keys) },
        inspectCanvas: async () => { calls.push("inspect"); return { selectors: "body" }; },
        requestCustomOrigin: async (origin) => { calls.push(["custom-origin", origin]); return { ok: true, configured: [origin] }; }
    });
    assert.deepEqual(await active.loadErrors(), ["CONTENT_RUNTIME_FAILED (runtime)"]);
    await active.resetSupported(["dark_mode"]);
    assert.deepEqual(await active.inspect(), { selectors: "body" });
    await active.requestCustomOrigin("https://canvas.example.edu");
    assert.deepEqual(calls, [["dark_mode"], "inspect", ["custom-origin", "https://canvas.example.edu"]]);
    assert.deepEqual(statuses, [["Supported settings reset."], ["Dark-mode inspection complete."], ["Canvas origin connected and saved."]]);

    const denied = editors.createDiagnosticsTools({ confirm: () => true, status: (...args) => statuses.push(args), inspectCanvas: async () => { throw new Error("SOURCE_TAB_UNAVAILABLE"); }, requestCustomOrigin: async () => { throw new Error("permission_denied"); } });
    await assert.rejects(denied.inspect(), /SOURCE_TAB_UNAVAILABLE/);
    await assert.rejects(denied.requestCustomOrigin("https://canvas.example.edu"), /permission_denied/);
    assert.deepEqual(statuses, [["Supported settings reset."], ["Dark-mode inspection complete."], ["Canvas origin connected and saved."]], "failed operations never report success");

    const incomplete = editors.createDiagnosticsTools({ confirm: () => true, requestCustomOrigin: async () => ({ ok: false }) });
    await assert.rejects(incomplete.requestCustomOrigin("https://canvas.example.edu"), /CANVAS_ORIGIN_REQUEST_FAILED/);
});

test("backgrounds exposes a frozen local Appearance gallery without changing manual URL semantics", () => {
    assert.match(backgroundsSource, /APStudyCanvasBackgrounds/);
    assert.match(backgroundsSource, /customBackgroundLink/);
    assert.match(backgroundsSource, /https:\/\//);
});

test("shipped theme runtime keeps active exports and local editor integrations", () => {
    assert.doesNotMatch(require("node:fs").readFileSync(require("node:path").join(__dirname, "../../js/themes.js"), "utf8"), /\/api\/themes/);
    assert.doesNotMatch(popupSource, /apiurl|\/api\/themes|displayMySubmissions|submitTheme|registerUser|likeTheme|getAndLoadTheme|displayThemeListNew|displayThemeListOld|themeSortFn|let cache/);
    assert.doesNotMatch(popupSource, /\b(?:remind|scheduledReminder|scheduledReminderTime)\b/);
    assert.match(schemaSource, /retiredReminderSyncSettingKeys/);
    assert.match(controllerSource, /COMPATIBILITY_ONLY_SYNC_SETTING_KEYS/);
});
