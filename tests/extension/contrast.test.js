"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const helper = require("./helpers/contrast.js");

const {
    compositeOver,
    contrastRatio,
    mixSrgb,
    ratio,
    readRootTokens,
    resolveColour,
    tokenColour
} = helper;

const root = path.resolve(__dirname, "../..");
const popupCss = fs.readFileSync(path.join(root, "css/popup.css"), "utf8");
const contentCss = fs.readFileSync(path.join(root, "css/content.css"), "utf8");
const sidebarCss = fs.readFileSync(path.join(root, "css/sidebar.css"), "utf8");
const shellCss = require("../../js/content/overlay-host.js").SHELL_CSS;

const tokens = readRootTokens(popupCss);
const T = (name) => tokenColour(tokens, name);

// AA thresholds. Normal-size text 4.5:1, large text (>=24px, or >=18.66px bold)
// 3:1, non-text UI components and states 3:1.
const AA_TEXT = 4.5;
const AA_LARGE = 3;
const AA_NON_TEXT = 3;

// ---------------------------------------------------------------------------
// The helper itself, so the numbers the rest of this file asserts are trusted.
// ---------------------------------------------------------------------------

test("contrast helper reproduces the WCAG reference ratios", () => {
    assert.equal(ratio("#000000", "#ffffff"), 21);
    assert.equal(ratio("#ffffff", "#ffffff"), 1);
    // The two canonical boundary greys: #767676 is the darkest grey that still
    // clears 4.5:1 on white, #949494 the darkest that clears 3:1.
    assert.ok(ratio("#767676", "#ffffff") >= 4.5, "#767676 on white must clear 4.5:1");
    assert.ok(ratio("#777777", "#ffffff") < 4.5, "#777777 on white must fall short of 4.5:1");
    assert.ok(ratio("#949494", "#ffffff") >= 3, "#949494 on white must clear 3:1");
    assert.ok(ratio("#959595", "#ffffff") < 3, "#959595 on white must fall short of 3:1");
    // Symmetric in its arguments.
    assert.equal(ratio("#1f1f1e", "#ffffff"), ratio("#ffffff", "#1f1f1e"));
    // Three-digit hex expands.
    assert.equal(ratio("#eee", "#eeeeee"), 1);
    // Ratios are floored, never rounded up past a threshold: 2.996 must not
    // present itself as 3.00 and satisfy a ">= 3" assertion.
    assert.ok(contrastRatio("#959595", "#ffffff") > 2.99);
    assert.equal(ratio("#959595", "#ffffff"), 2.99);
});

test("contrast helper resolves hex, var(), fallbacks, and color-mix(in srgb)", () => {
    assert.equal(mixSrgb("#000000", 0.5, "#ffffff"), "#808080");
    assert.equal(mixSrgb("#000000", 0, "#ffffff"), "#ffffff");
    assert.equal(mixSrgb("#000000", 1, "#ffffff"), "#000000");
    assert.equal(compositeOver("#000000", 0.5, "#ffffff"), "#808080");
    assert.equal(compositeOver("#000000", 1, "#ffffff"), "#000000");

    const map = { "--a": "#102030", "--b": "var(--a)", "--c": "color-mix(in srgb, #ffffff 25%, var(--a))" };
    assert.equal(resolveColour("var(--b)", map), "#102030");
    assert.equal(resolveColour("var(--missing, #abcdef)", map), "#abcdef");
    assert.equal(resolveColour("var(--c)", map), mixSrgb("#ffffff", 0.25, "#102030"));
    assert.throws(() => resolveColour("var(--nope)", map), /undefined token/);
    assert.throws(() => resolveColour("rgb(1 2 3)", map), /unsupported colour value/);

    // The real token table parses, and the values are the DESIGN.md literals.
    assert.equal(T("--navy"), "#0a0f22");
    assert.equal(T("--gold"), "#d4af37");
    assert.equal(T("--parchment"), "#ffffff");
    assert.equal(T("--alert"), "#b3261e");
    // Aliases chase all the way through.
    assert.equal(T("--light-text"), "#1f1f1e");
    assert.equal(T("--light-muted"), "#4b4a47");
});

// ---------------------------------------------------------------------------
// Text contrast, both surfaces.
// ---------------------------------------------------------------------------

test("every text token clears AA on every surface it is painted on", () => {
    const parchment = ["--light-card", "--light-card-low", "--light-card-inset", "--light-hover", "--gold-tint-light"];
    // Every opaque surface token, not a hand-picked few: --surface-hover was
    // painting muted ink at 4.15:1 and only a full sweep found it.
    const navy = [
        "--navy", "--navy-mid", "--navy-raised", "--page", "--surface",
        "--surface-raised", "--surface-soft", "--inputbg", "--containerbg", "--surface-hover"
    ];

    parchment.forEach((surface) => {
        ["--light-text", "--light-muted"].forEach((ink) => {
            const measured = ratio(T(ink), T(surface));
            assert.ok(measured >= AA_TEXT, `${ink} on ${surface} measured ${measured}:1`);
        });
    });
    navy.forEach((surface) => {
        // --error-text is in the sweep because the failed sync pill paints it on
        // --surface-hover, where it measured 3.36:1.
        ["--on-dark", "--muted-dark", "--gold", "--error-text"].forEach((ink) => {
            const measured = ratio(T(ink), T(surface));
            assert.ok(measured >= AA_TEXT, `${ink} on ${surface} measured ${measured}:1`);
        });
    });
    // --surface-hover doubles as a hover fill, so it still has to read as a lift
    // off the resting navies rather than collapsing into them.
    ["--navy", "--navy-mid", "--navy-raised"].forEach((resting) => {
        assert.ok(
            ratio(T("--surface-hover"), T(resting)) > 1.25,
            `--surface-hover is no longer a perceptible lift over ${resting}`
        );
    });
    assert.match(popupCss, /--surface-hover:\s*color-mix\(in srgb, #101730 84%, #d6ddf0\)/);
    assert.match(popupCss, /--error-text:\s*color-mix\(in srgb, #b3261e 48%, #ffffff\)/);

    // The one named state colour carries white text at AA, as DESIGN.md claims.
    assert.ok(ratio("#ffffff", T("--alert")) >= AA_TEXT);
    // Gold is a navy-surface ink only: on parchment it is decorative.
    assert.ok(ratio(T("--gold"), T("--parchment")) < AA_LARGE);
});

test("the semantic sidebar redesign keeps the light-canvas and dark-canvas navy families above AA", () => {
    const lightSurface = "#002f6c";
    const darkSurface = "#0a0f22";
    assert.ok(ratio("#f7f9fc", lightSurface) >= AA_TEXT, "primary light-canvas rail ink");
    assert.ok(ratio("#cbd7e6", lightSurface) >= AA_TEXT, "muted light-canvas rail ink");
    assert.ok(ratio("#f7f9fc", darkSurface) >= AA_TEXT, "primary dark-canvas rail ink");
    assert.ok(ratio("#cbd7e6", darkSurface) >= AA_TEXT, "muted dark-canvas rail ink");
    assert.ok(ratio("#d4af37", darkSurface) >= AA_NON_TEXT, "gold focus edge on dark rail");
    assert.ok(ratio("#002f6c", "#f7f6f3") >= AA_TEXT, "active light-canvas destination ink");
    assert.ok(ratio("#0a0f22", "#f7f9fc") >= AA_TEXT, "active dark-canvas destination ink");
    assert.match(sidebarCss, /--apstudy-sidebar-surface:\s*var\(--apstudy-sidebar-navy\)/);
    assert.match(sidebarCss, /--apstudy-sidebar-active:\s*var\(--apstudy-sidebar-parchment\)/);
    assert.match(sidebarCss, /html:has\(#darkcss\)\s*\{[\s\S]*--apstudy-sidebar-surface:\s*var\(--apstudy-sidebar-dark-navy\)/);
    assert.doesNotMatch(sidebarCss, /background:\s*(?:linear-gradient|radial-gradient)/i);
});

test("course dots retain identity colors while a system-independent ring survives themes", () => {
    const dot = sidebarCss.match(/\.apstudycanvas-sidebar-course-dot\s*\{([^}]*)\}/)?.[1] || "";
    assert.match(dot, /background:\s*var\(--apstudycanvas-course-color,\s*var\(--apstudy-sidebar-gold\)\)/);
    assert.match(dot, /outline:\s*1px solid var\(--apstudy-sidebar-surface\)/);
    assert.match(dot, /box-shadow:\s*0 0 0 1px var\(--apstudy-sidebar-text\)/);

    const forcedStart = sidebarCss.indexOf("@media (forced-colors: active)");
    const forcedColors = sidebarCss.slice(forcedStart, sidebarCss.indexOf("@media print", forcedStart));
    assert.match(forcedColors, /\.apstudycanvas-sidebar-course-dot\s*\{[\s\S]*forced-color-adjust:\s*none[\s\S]*outline:\s*1px solid Canvas[\s\S]*box-shadow:\s*0 0 0 1px CanvasText/);
});

// ---------------------------------------------------------------------------
// Non-text contrast: the pill toggle is the sharp case, because it has neither
// a text label nor a glyph. Its track and knob are the only thing identifying
// the control and its state, so both edges must clear 3:1.
// ---------------------------------------------------------------------------

test("the pill toggle has a 3:1 edge in both states, on every row background", () => {
    const track = T("--track-off-light");
    const knobOff = T("--parchment");
    const knobOn = T("--navy");
    const rows = ["--light-card", "--light-card-low"];

    assert.ok(ratio(knobOff, track) >= AA_NON_TEXT, `resting knob against track measured ${ratio(knobOff, track)}:1`);
    rows.forEach((surface) => {
        const measured = ratio(track, T(surface));
        assert.ok(measured >= AA_NON_TEXT, `resting track against ${surface} measured ${measured}:1`);
    });
    // Checked: gold track against parchment is only 2.10:1, so the navy knob is
    // what carries the state. It has to be the strong edge.
    assert.ok(ratio(knobOn, T("--gold")) >= AA_NON_TEXT, "checked knob against the gold track");
    rows.forEach((surface) => {
        assert.ok(ratio(knobOn, T(surface)) >= AA_NON_TEXT, `checked knob against ${surface}`);
    });

    // Regression guard on the value itself: the original 18% navy tint put both
    // edges at 1.70:1.
    assert.ok(ratio(mixSrgb(T("--navy"), 0.18, T("--parchment-container")), knobOff) < AA_NON_TEXT);
    assert.match(popupCss, /--track-off-light:\s*color-mix\(in srgb, #0a0f22 50%, #f0eeeb\)/);
});

test("field boundaries use the strong border token and clear 3:1; hairlines stay hairlines", () => {
    const strong = T("--light-border-strong");
    ["--light-card", "--light-card-low", "--light-card-inset", "--gold-tint-light"].forEach((surface) => {
        const measured = ratio(strong, T(surface));
        assert.ok(measured >= AA_NON_TEXT, `--light-border-strong against ${surface} measured ${measured}:1`);
    });
    // The decorative hairline is deliberately below 3:1 and must not be used as
    // a control boundary, so record that it really is the weaker of the two.
    assert.ok(ratio(T("--light-border"), T("--light-card")) < AA_NON_TEXT);

    // Every field whose only affordance is its outline carries the strong token.
    [
        '.workspace-setting input[type="number"], .workspace-setting select {',
        ".workspace-search-wrap input {",
        ".workspace-category-select-wrap select {",
        ".sidebar-preset-setting select {"
    ].forEach((selector) => {
        const start = popupCss.indexOf(selector);
        assert.notEqual(start, -1, `missing rule: ${selector}`);
        const block = popupCss.slice(start, popupCss.indexOf("}", start));
        assert.match(block, /--light-border-strong/, `${selector} still uses the decorative hairline`);
    });
});

test("the parchment focus ring pairs gold with a navy hairline so one edge clears 3:1", () => {
    const gold = T("--gold");
    const navy = T("--navy");
    // Gold alone is the failure this rule exists to fix.
    assert.ok(ratio(gold, T("--light-card")) < AA_NON_TEXT);
    assert.ok(ratio(gold, T("--light-card-low")) < AA_NON_TEXT);
    // Navy carries it, against both the surface and the gold band beside it.
    ["--light-card", "--light-card-low", "--light-card-inset", "--gold-tint-light"].forEach((surface) => {
        assert.ok(ratio(navy, T(surface)) >= AA_NON_TEXT, `navy hairline against ${surface}`);
    });
    assert.ok(ratio(navy, gold) >= AA_NON_TEXT, "navy hairline against the gold outline");
    assert.match(
        popupCss,
        /\.workspace-stage :is\(a, button, input, select, textarea, summary, \[tabindex\]\):focus-visible \{\s*box-shadow: 0 0 0 1px var\(--navy\);/
    );
    // On navy the gold ring is already strong, so nothing was changed there.
    assert.ok(ratio(gold, T("--navy-mid")) >= AA_NON_TEXT);
});

test("dimming a row never dims the sentence explaining why it is dimmed", () => {
    // Composited at the row's own .55 opacity, the muted ink lands at 2.70:1 —
    // this is exactly why .control-disabled-reason is excluded from the dimming.
    const dimmedMuted = compositeOver(T("--light-muted"), 0.55, T("--light-card"));
    assert.ok(ratio(dimmedMuted, T("--light-card")) < AA_TEXT);
    // Undimmed, the reason line is comfortably readable.
    assert.ok(ratio(T("--light-muted"), T("--light-card")) >= AA_TEXT);

    [
        '.workspace-setting[aria-disabled="true"]',
        '.workspace-group[data-dependency="off"] .workspace-setting.is-dependent',
        '.sidebar-settings-section[data-sidebar-enabled="false"] .sidebar-control.is-disabled',
        '.sidebar-settings-section .sidebar-control[aria-disabled="true"]'
    ].forEach((selector) => {
        assert.ok(
            popupCss.includes(`${selector} > :not(.control-disabled-reason)`),
            `dimming must exclude the reason line for ${selector}`
        );
    });
    assert.doesNotMatch(popupCss, /\.workspace-setting\[aria-disabled="true"\],/, "the bare row selector would fade the reason with it");
});

// ---------------------------------------------------------------------------
// The shadow-root preview toolbar. Colours there are literals, not tokens,
// because :host { all: initial } cuts the cascade off from css/popup.css.
// ---------------------------------------------------------------------------

test("the preview toolbar clears AA on navy and its controls have a 3:1 boundary", () => {
    const toolbar = "#0d1328";
    const hover = "#101730";
    assert.ok(ratio("#d6ddf0", toolbar) >= AA_TEXT, "toolbar text");
    assert.ok(ratio("#a0a8c4", toolbar) >= AA_TEXT, "toolbar page label");
    assert.ok(ratio("#d4af37", toolbar) >= AA_NON_TEXT, "gold focus ring on navy");

    const border = resolveColour("color-mix(in srgb, #0a0f22 58%, #d6ddf0)", {});
    assert.ok(ratio(border, toolbar) >= AA_NON_TEXT, `toolbar control border measured ${ratio(border, toolbar)}:1`);
    assert.ok(ratio(border, hover) >= AA_NON_TEXT, "toolbar control border on hover");
    assert.match(shellCss, /border: 1px solid color-mix\(in srgb, #0a0f22 58%, #d6ddf0\)/);
    // The 68% mix it replaced measured 2.33:1.
    assert.ok(ratio(resolveColour("color-mix(in srgb, #0a0f22 68%, #d6ddf0)", {}), toolbar) < AA_NON_TEXT);

    // The theme switch is a role="switch" with a track and knob, so the knob has
    // to carry the state on both sides.
    const trackOn = resolveColour("color-mix(in srgb, #D4AF37 32%, #0d1328)", {});
    assert.ok(ratio("#d4af37", trackOn) >= AA_NON_TEXT, "checked knob against its track");
    assert.ok(ratio("#a0a8c4", hover) >= AA_NON_TEXT, "resting knob against its track");
});

// ---------------------------------------------------------------------------
// The right rail lives in Canvas's own DOM behind the --bc* theme layer. Light
// mode is owned by the var() fallbacks in css/content.css; dark mode is owned by
// settings-schema's dark_preset, which the user can edit.
// ---------------------------------------------------------------------------

test("the right rail clears AA in light mode through its var() fallbacks", () => {
    const fallback = (name) => {
        const match = contentCss.match(new RegExp(`var\\(${name},\\s*([^)]*(?:\\([^)]*\\))?[^)]*)\\)`));
        assert.ok(match, `no fallback declared for ${name}`);
        return resolveColour(match[1].trim(), {});
    };
    const ink = fallback("--bctext-0");
    const muted = fallback("--bctext-2");
    const surface = fallback("--bcbackground-2");

    assert.equal(ink, "#1f1f1e", "the rail's primary ink is the on-light token");
    assert.equal(muted, "#4b4a47", "the rail's muted ink is the muted-light token");
    assert.ok(ratio(ink, surface) >= AA_TEXT, `rail ink on its card measured ${ratio(ink, surface)}:1`);
    assert.ok(ratio(muted, surface) >= AA_TEXT, `rail muted ink on its card measured ${ratio(muted, surface)}:1`);
    assert.ok(ratio(ink, "#ffffff") >= AA_TEXT);
    assert.ok(ratio(muted, "#ffffff") >= AA_TEXT);

    // The alert chip is the rail's only state colour and it carries white text.
    assert.ok(ratio("#ffffff", "#b3261e") >= AA_TEXT);
    assert.match(contentCss, /\.canvasrefined-due-soon \{background: #b3261e; padding: 1px 4px; color: #ffffff/);

    // Phase 7 raised .extension-linkpreview's #6C757C-on-#eee from 4.05:1 to
    // 7.64:1. Phase 9 then proved the whole .extension-* / .hypo* legacy family
    // dead — no .js/.html/.json reference anywhere in the tree or at HEAD — and
    // deleted it, along with the banned `background-color: red` it carried. Both
    // the class family and its sub-AA grey are pinned out so neither returns.
    assert.ok(ratio("#6c757c", "#eee") < AA_TEXT, `the deleted grey measured ${ratio("#6c757c", "#eee")}:1`);
    assert.doesNotMatch(contentCss, /#6C757C/i);
    assert.doesNotMatch(contentCss, /\.extension-|\.hypo/, "the dead legacy class block must not come back");
    assert.doesNotMatch(contentCss, /background-color:\s*red/);
});

test("the rail clears AA in dark mode through the shipped dark_preset", () => {
    const preset = require("../../js/settings-schema.js").syncDefaults.dark_preset;
    const ink = preset["text-0"];
    const muted = preset["text-2"];

    [preset["background-0"], preset["background-1"], preset["background-2"]].forEach((surface) => {
        assert.ok(ratio(ink, surface) >= AA_TEXT, `dark --bctext-0 on ${surface} measured ${ratio(ink, surface)}:1`);
        assert.ok(ratio(muted, surface) >= AA_TEXT, `dark --bctext-2 on ${surface} measured ${ratio(muted, surface)}:1`);
    });
    // The gold focus ring the rail draws is a literal, not a --bc* token, so it
    // has to clear 3:1 against the darkest preset surface too.
    assert.ok(ratio("#D4AF37", preset["background-0"]) >= AA_NON_TEXT);
    assert.match(contentCss, /outline: 2px solid #D4AF37;/);

    // css/darkmodecss.js carried a SECOND `.discussion-section.message_wrapper
    // table` rule — `border:4px solid red!important` — 495 lines below the
    // tokenised one, so equal specificity plus source order made the debug red
    // win on every Canvas discussion table in dark mode. DESIGN.md bans red
    // outright. The duplicate is gone and the tokenised rule is back in force.
    const darkCss = fs.readFileSync(path.join(root, "css/darkmodecss.js"), "utf8");
    assert.equal(
        (darkCss.match(/\.discussion-section\.message_wrapper table \{/g) || []).length,
        1,
        "the duplicate rule that shadowed the tokenised border is back"
    );
    assert.match(darkCss, /\.discussion-section\.message_wrapper table \{\s*border:4px solid var\(--bcborders\)!important/);
    assert.doesNotMatch(darkCss, /:\s*(?:red|#ff0000|#f00)\b/i, "the dark theme paints only --bc* tokens, never a literal red");
});

// ---------------------------------------------------------------------------
// The dashboard update banner. It shipped as a three-stop coral -> orange ->
// pink gradient carrying white text, which DESIGN.md bans twice over (multi-hue
// decorative gradient, coral/pink family) and which failed AA on every stop.
// It is now a flat Nest surface routed through the same --bc* theme layer as the
// rest of this file, so dark mode reaches it.
// ---------------------------------------------------------------------------

test("the update banner is a flat Nest surface in both modes, not the coral gradient", () => {
    const preset = require("../../js/settings-schema.js").syncDefaults.dark_preset;
    // Dark mode declares --bc<key> on :root from dark_preset
    // (js/content.js generateDarkModeCSS), so the same declarations resolve to
    // the preset in dark mode and to their var() fallbacks in light mode.
    const darkTokens = {};
    Object.keys(preset).forEach((key) => { darkTokens[`--bc${key}`] = preset[key]; });

    const ruleBody = (selector) => {
        const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const match = contentCss.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
        assert.ok(match, `no rule for ${selector}`);
        return match[1];
    };
    const declared = (body, property) => {
        const match = body.match(new RegExp(`(?:^|;|\\{)\\s*${property}\\s*:\\s*([^;]+)`));
        assert.ok(match, `no ${property} declaration in ${body}`);
        return match[1].trim();
    };
    const both = (value) => ({
        light: resolveColour(value, {}),
        dark: resolveColour(value, darkTokens)
    });

    const banner = ruleBody("#canvasrefined-update-msg");
    const paragraph = ruleBody("#canvasrefined-update-msg p");
    const close = ruleBody("#canvasrefined-update-close");

    // The banned treatment is gone, and the stops it used are recorded here as
    // the reason: white text cleared AA on none of them.
    assert.doesNotMatch(banner, /gradient/, "the banner must not carry a decorative gradient");
    assert.doesNotMatch(contentCss, /255,\s*53,\s*88|255,\s*131,\s*73|255,\s*103,\s*187/);
    assert.ok(ratio("#ffffff", "#ff3558") < AA_TEXT, `old stop 1 measured ${ratio("#ffffff", "#ff3558")}:1`);
    assert.ok(ratio("#ffffff", "#ff8349") < AA_TEXT, `old stop 2 measured ${ratio("#ffffff", "#ff8349")}:1`);
    assert.ok(ratio("#ffffff", "#ff67bb") < AA_TEXT, `old stop 3 measured ${ratio("#ffffff", "#ff67bb")}:1`);

    const surface = both(declared(banner, "background"));
    const ink = both(declared(banner, "color"));
    assert.deepEqual(surface, { light: "#ffffff", dark: preset["background-1"] });
    assert.deepEqual(ink, { light: "#1f1f1e", dark: preset["text-0"] });
    // The paragraph's !important colour must not diverge from the container's.
    assert.deepEqual(both(declared(paragraph, "color").replace(/\s*!important$/, "")), ink);

    const closeFill = both(declared(close, "background"));
    const closeInk = both(declared(close, "color").replace(/\s*!important$/, ""));
    const closeEdge = both(declared(close, "border").replace(/^1px\s+solid\s+/, ""));

    ["light", "dark"].forEach((mode) => {
        assert.ok(
            ratio(ink[mode], surface[mode]) >= AA_TEXT,
            `banner text measured ${ratio(ink[mode], surface[mode])}:1 in ${mode} mode`
        );
        assert.ok(
            ratio(closeInk[mode], closeFill[mode]) >= AA_TEXT,
            `close-button text measured ${ratio(closeInk[mode], closeFill[mode])}:1 in ${mode} mode`
        );
        // The Close button is a real control, so SC 1.4.11 applies to its
        // boundary — against its own fill and against the banner behind it.
        assert.ok(
            ratio(closeEdge[mode], closeFill[mode]) >= AA_NON_TEXT,
            `close-button edge vs fill measured ${ratio(closeEdge[mode], closeFill[mode])}:1 in ${mode} mode`
        );
        assert.ok(
            ratio(closeEdge[mode], surface[mode]) >= AA_NON_TEXT,
            `close-button edge vs banner measured ${ratio(closeEdge[mode], surface[mode])}:1 in ${mode} mode`
        );
    });

    // The update notice shares Canvas's one-pixel separator language instead
    // of advertising itself with a decorative side tab. Gold remains reserved
    // for controls and semantic emphasis, not a low-contrast text fill.
    assert.match(banner, /border: 1px solid var\(--bcborders,/);
    assert.doesNotMatch(banner, /border-(?:inline-start|left):/);
    assert.doesNotMatch(declared(banner, "background"), /#D4AF37/i);
    assert.ok(ratio("#ffffff", "#D4AF37") < AA_TEXT);

    // DESIGN.md shapes: the banner is a card (12px), the Close button a control
    // (6px). Neither 4px nor 3px is on the scale.
    assert.equal(declared(banner, "border-radius"), "12px");
    assert.equal(declared(close, "border-radius"), "6px");

    // Border-only elevation: DESIGN.md forbids pairing a border with a shadow.
    assert.doesNotMatch(banner, /box-shadow/);
    assert.doesNotMatch(close, /box-shadow/);

    // WCAG 2.2 SC 2.5.8 (AA): the Close button is a pointer target and must be
    // at least 24x24 CSS px. `padding: 3px 6px` around a 15px label cannot get
    // there on its own, so the floor is declared. Parsed from the same real rule
    // as the colours above, so a future restyle cannot quietly drop it.
    const TARGET_MIN_PX = 24;
    const minHeight = declared(close, "min-height");
    assert.match(minHeight, /^\d+px$/, `min-height must be a plain px floor, got "${minHeight}"`);
    assert.ok(
        parseInt(minHeight, 10) >= TARGET_MIN_PX,
        `close-button min-height is ${minHeight}; SC 2.5.8 needs >= ${TARGET_MIN_PX}px`
    );
    // `height: 100%` is what broke the target in the first place: its computed
    // value is not `auto`, so it cancelled the flex default `align-self: stretch`
    // and then resolved against the banner's indefinite content height. It must
    // not come back -- with a percentage height present, min-height is the only
    // thing holding the floor and the box stops tracking the banner.
    assert.doesNotMatch(close, /height:\s*\d+%/, "a percentage height cancels align-self: stretch");
    // The fix is confined to the button: the banner is still the same
    // space-between flex row it was before.
    assert.match(banner, /display:\s*flex/);
    assert.match(banner, /justify-content:\s*space-between/);
});
