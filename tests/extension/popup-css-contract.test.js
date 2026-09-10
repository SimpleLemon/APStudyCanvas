const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "../..");
const css = fs.readFileSync(path.join(root, "css/popup.css"), "utf8");
const html = fs.readFileSync(path.join(root, "html/popup.html"), "utf8");

function rule(selector, fromEnd = false) {
    const start = fromEnd ? css.lastIndexOf(selector) : css.indexOf(selector);
    assert.notEqual(start, -1, `missing CSS selector: ${selector}`);
    const open = css.indexOf("{", start);
    const close = css.indexOf("}", open);
    assert.ok(open > start && close > open, `could not read CSS rule: ${selector}`);
    return css.slice(start, close + 1);
}

test("the Workspace shell is fluid and the embedded host uses percentages", () => {
    const baseBody = rule("body {");
    const workspaceHtml = rule('html:has(> body[data-mode="workspace"])');
    const workspaceBody = rule('body[data-mode="workspace"], body[data-mode="workspace"] #app-scroll {');
    const embeddedHtml = rule('html:has(> body[data-shell="embedded"])');
    const embeddedBody = rule('body[data-shell="embedded"] {');

    assert.match(baseBody, /width:\s*100%/);
    assert.match(baseBody, /min-width:\s*0/);
    assert.match(baseBody, /max-width:\s*none/);
    assert.match(baseBody, /height:\s*100%/);
    assert.match(baseBody, /overflow-x:\s*hidden/);
    assert.doesNotMatch(baseBody, /transition:[^;]*\bheight\b/);

    assert.match(workspaceHtml, /width:\s*100%/);
    assert.match(workspaceBody, /width:\s*100%/);
    assert.match(workspaceBody, /height:\s*100%/);
    assert.doesNotMatch(css, /505px/, "the 505px action-popup contract is retired; the shell has no fixed width");
    assert.doesNotMatch(css, /^\s*width:\s*(?:760|780)px/m);
    assert.doesNotMatch(css, /^\s*width:\s*min\(780px/m);

    assert.match(embeddedHtml, /width:\s*100%/);
    assert.match(embeddedHtml, /height:\s*100%/);
    assert.doesNotMatch(embeddedHtml, /100v[hw]/);
    assert.match(embeddedBody, /width:\s*100%/);
    assert.match(embeddedBody, /height:\s*100%/);
    assert.doesNotMatch(embeddedBody, /100v[hw]/);
});

// #app-scroll, html, and body never scroll. Every pane owns its own scroll;
// the shell roots stay clamped so nothing becomes a second page-level scroller.
test("popup shell keeps its roots unscrollable and lets the Workspace panes own their scroll", () => {
    const shell = rule("#app-scroll { position: relative");
    const workspacePane = rule(".workspace-content {");
    const workspaceView = rule('body[data-mode="workspace"] #workspace-view {');
    const baseBody = rule("body {");

    assert.match(shell, /overflow:\s*visible/);
    assert.doesNotMatch(shell, /overflow-y:\s*auto|overflow:\s*auto/);
    assert.match(baseBody, /overflow-y:\s*hidden/);
    assert.match(workspacePane, /overflow-y:\s*auto/);
    assert.match(workspaceView, /overflow:\s*hidden/);
    const rail = rule("\n.workspace-nav {");
    assert.match(rail, /overflow-y:\s*auto/);
    assert.match(rail, /overscroll-behavior:\s*contain/);
    assert.doesNotMatch(css, /#app-scroll[^{}]*overflow-y:\s*auto/);
    assert.match(css, /html:has\(> body\[data-mode="workspace"\]\)[^{]*\{[^}]*overflow:\s*hidden/);
});

// The embedded settings iframe is only ~490px wide, so viewport-width media
// queries fired the mobile collapse in a perfectly roomy 31.5% column. The
// shell box is measured instead, and the thresholds are retuned to honest
// values. rule() cannot read inside @container, so these are whole-file regex.
test("workspace layout collapses on the shell container, not the viewport", () => {
    const shell = rule("#app-scroll { position: relative");

    assert.match(shell, /container-type:\s*inline-size/);
    assert.match(shell, /container-name:\s*shell/);
    assert.doesNotMatch(css, /@media \(max-width: (?:960|760|640|570|520)px\)/);
    assert.match(css, /@container shell \(max-width: 560px\)/);
    assert.match(css, /body\[data-navigation-page="detail"\] \.workspace-sidebar \{\s*display:\s*none/);
    assert.match(css, /@container shell \(width < 700px\)/);
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});

// Defect 3. The conversion above was audited in Brave against the shell widths
// the panel really takes, and the @container mechanism itself is sound: at a
// 370px shell the 380px block applies in full, and at 490px the 700/620/560px
// blocks apply while 420/380px correctly do not. Exactly one threshold was wrong
// — the workspace stacking rules came from a 570px *viewport* query, which did
// fire inside the ~490-660px iframe because it measured the iframe, and retuning
// them to 380px put them below every width the panel takes. So this pins the
// mechanism, not the numbers: a container query is only alive if its prelude
// names a container that some element actually declares, and that element has to
// generate a real box.
test("every @container prelude names a declared container that generates a real box", () => {
    const shell = rule("#app-scroll { position: relative");

    const declared = new Set(Array.from(css.matchAll(/container-name:\s*([A-Za-z][\w-]*)/g), (m) => m[1]));
    const queried = new Set(Array.from(css.matchAll(/@container\s+([A-Za-z][\w-]*)\s*\(/g), (m) => m[1]));
    assert.ok(queried.size > 0, "the workspace collapse is supposed to be container-driven");
    queried.forEach((name) => {
        assert.ok(declared.has(name), `@container ${name} (…) has no matching container-name: ${name}`);
    });
    declared.forEach((name) => {
        assert.ok(queried.has(name), `container-name: ${name} is declared but never queried`);
    });

    // A query container must be a real box. display: contents or an inline outer
    // display would stop #app-scroll generating one, and every rule keyed on
    // `shell` would go quiet with no error anywhere.
    assert.match(shell, /container-type:\s*inline-size/);
    assert.match(shell, /display:\s*flex/);
    assert.doesNotMatch(shell, /display:\s*(?:contents|inline|none)\s*;/);

    // Thresholds at or below 420px are the narrow-panel floor, below the panel's
    // ~490px minimum. Nothing the embedded panel depends on may live only there.
    const thresholds = Array.from(css.matchAll(/@container shell \(max-width: (\d+)px\)/g), (m) => Number(m[1]));
    assert.ok(thresholds.some((value) => value >= 490), "no shell query reaches the embedded panel's own width");
});

test("workspace content omits the redundant settings header chrome", () => {
    assert.doesNotMatch(html, /class="workspace-header"|id="workspace-title"|id="workspace-save-status"|data-workspace-overview/);
    assert.doesNotMatch(css, /\.workspace-header|\.workspace-header-actions|\.workspace-save-status|\.workspace-description/);
});

// Defect 2. Per CSS Overflow 3 a `visible` on one axis computes to `auto` when
// the other is not `visible`, so `overflow-y: auto` alone gave the rail a
// scrolling horizontal axis — measured at a 400px shell it scrolled 116px of
// content through a 107px box — and clipped any label wider than its box
// ("Appearance" wanted 73px in a 57px box at 490px). Labels wrap at spaces now;
// text-overflow is only the backstop for a single unbreakable word.
test("the nav rail hides its horizontal axis and no nav label is clipped", () => {
    const rail = rule("\n.workspace-nav {");
    const label = rule(".workspace-nav button > span:not(.workspace-nav-chevron) {");
    const row = rule(".workspace-nav button {");

    assert.match(rail, /overflow-x:\s*hidden/, "an implicit overflow-x: auto is what produced the scrollbar");
    assert.match(rail, /overflow-y:\s*auto/);
    assert.doesNotMatch(label, /text-overflow:\s*ellipsis/);
    assert.match(label, /white-space:\s*normal/);
    assert.match(label, /white-space:\s*normal/);
    assert.match(label, /line-height:\s*1\.15/);
    assert.match(label, /flex:\s*1 1 auto/);
    // Mid-word breaking rendered "Appeara / nce", and hyphens: auto silently
    // degrades to break-word wherever the hyphenation dictionary is missing.
    assert.doesNotMatch(label, /overflow-wrap:\s*(?:anywhere|break-word)|hyphens/);

    // The 20px the row handed back to the label is what lets "Appearance" read in
    // full at the 490px embedded width; the 48px target is untouched.
    assert.match(row, /min-height:\s*48px/);
    assert.match(row, /gap:\s*8px/);
    assert.match(row, /padding:\s*8px/);
    assert.match(rule(".workspace-sidebar {"), /padding:\s*20px 16px 16px/);
    assert.match(rule(".workspace-stage { display: grid"), /grid-template-columns:\s*clamp\(220px,\s*25%,\s*300px\)\s*minmax\(0,\s*1fr\)/);
    assert.match(css, /\.workspace-nav button:focus-visible \{[^}]*outline:\s*2px solid var\(--gold\)/);
});

// DESIGN.md bans vh/vw inside the overlay iframe: there they measure the Canvas
// page behind the overlay, not the panel. The base workspace rules must not
// depend on the embedded overrides winning on specificity.
test("workspace shell sizes in percentages, never viewport units", () => {
    const workspaceHtml = rule('html:has(> body[data-mode="workspace"])');
    const workspaceHtmlLast = rule('html:has(> body[data-mode="workspace"])', true);
    const workspaceBody = rule('body[data-mode="workspace"], body[data-mode="workspace"] #app-scroll {');
    const workspaceShell = rule('body[data-mode="workspace"], body[data-mode="workspace"] #app-scroll {');

    [workspaceHtml, workspaceHtmlLast, workspaceBody, workspaceShell].forEach((block) => {
        assert.doesNotMatch(block, /100v[hw]/);
        assert.match(block, /height:\s*100%/);
    });
});

// The overlay host draws the global search while category recovery stays available.
test("embedded shell suppresses duplicate global chrome without hiding workspace recovery", () => {
    const suppressed = rule('body[data-shell="embedded"] .compact-brand span');

    assert.match(suppressed, /display:\s*none/);
    [
        'body[data-shell="embedded"] .compact-brand span',
        'body[data-shell="embedded"] .compact-expand',
        'body[data-shell="embedded"] .workspace-nav-label'
    ].forEach((selector) => assert.ok(suppressed.includes(selector), `chrome suppression is missing ${selector}`));
    assert.match(css, /body\[data-shell="embedded"\] \.workspace-recovery-link\[data-recovery-shell="embedded"\] \{[^}]*display:\s*inline-flex/);
});

test("workspace two-tone composition uses light-card tokens and bounded columns", () => {
    const view = rule('body[data-mode="workspace"] #workspace-view {');
    const stage = rule(".workspace-stage { display: grid");
    const content = rule(".workspace-content {");
    const embedded = rule('body[data-shell="embedded"][data-mode="workspace"] #workspace-view {');

    assert.match(css, /--light-card:\s*var\(--parchment\)/);
    assert.match(css, /--light-text:\s*var\(--on-light\)/);
    assert.match(css, /--light-muted:\s*var\(--muted-light\)/);
    assert.match(view, /grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    assert.match(view, /overflow:\s*hidden/);
    assert.match(stage, /grid-template-columns:\s*clamp\(220px,\s*25%,\s*300px\)\s*minmax\(0,\s*1fr\)/);
    assert.match(stage, /background:\s*var\(--light-card\)/);
    assert.match(stage, /color:\s*var\(--light-text\)/);
    assert.match(content, /overflow-y:\s*auto/);
    assert.match(css, /\.workspace-nav button\.is-active/);
    assert.match(embedded, /padding:\s*0/);
    assert.doesNotMatch(css, /\.workspace-preview/);
});

test("desktop overlay keeps the settings rail beside detail until the intermediate floor", () => {
    assert.match(css, /@container shell \(max-width: 560px\)/);
    assert.match(css, /body\[data-navigation-page="detail"\] \.workspace-sidebar \{\s*display:\s*none/);
    assert.match(css, /\.workspace-stage \{ display: grid; grid-template-columns: clamp\(220px, 25%, 300px\)/);
    assert.match(css, /body\[data-shell="embedded"\]\[data-mode="workspace"\] #workspace-view \{\s*padding: 0/);
});

// Active state is never colour-only, the eyebrow uses the body face (IBM Plex
// Mono is reserved for genuine data), and the rail is width-capped so fullscreen
// does not hand it a 400px column.
test("nav rail separates hover from active and caps its own width", () => {
    const railLabel = rule(".workspace-nav-group-label {");
    const sidebar = rule(".workspace-sidebar {");
    const active = rule(".workspace-nav button.is-active {");

    assert.match(css, /--gold-tint-light:\s*color-mix\(in srgb, #D4AF37 14%, #ffffff\)/);
    assert.match(railLabel, /text-transform:\s*none/);
    assert.match(railLabel, /letter-spacing:\s*normal/);
    assert.match(railLabel, /font-family:\s*var\(--font-body\)/);
    assert.doesNotMatch(railLabel, /var\(--font-meta\)/);
    assert.match(sidebar, /max-width:\s*none/);
    assert.match(active, /background:\s*var\(--gold-tint-light\)/);
    assert.match(active, /font-weight:\s*650/);
    assert.match(rule(".workspace-nav button:hover {"), /background:\s*var\(--light-hover\)/);
    assert.match(rule(".workspace-nav-icon {"), /width:\s*24px/);
    assert.match(rule(".workspace-nav-icon {"), /background:\s*var\(--light-card-inset\)/);
    assert.match(css, /\.workspace-nav-chevron \{/);
    assert.doesNotMatch(css, /workspace-nav-lock/);
});

test("the one workspace search control lives in the global header", () => {
    assert.match(css, /\.global-search \{/);
    assert.doesNotMatch(html, /class="workspace-header"/);
});

test("compact navigation replaces the dropdown with list and detail below 700px", () => {
    assert.match(css, /@container shell \(width < 700px\)/);
    assert.match(css, /body\[data-navigation-page="list"\] \.workspace-content \{ display: none/);
    assert.match(css, /body\[data-navigation-page="detail"\] \.workspace-sidebar \{ display: none/);
    assert.match(rule(".workspace-category-select-wrap {"), /display: none/);
    assert.match(html, /id="workspace-back"/);
});

// One border, no shadow, hairline row separators — never a border paired with a
// wide shadow, and never nested cards as elevation.
test("grouped setting rows use hairlines, pill toggles, and 40px selects", () => {
    const group = rule(".workspace-group {");
    const heading = rule(".workspace-group-heading {");
    const toggle = rule('.settings-switch {');
    const knob = rule('.settings-switch::before {');
    const select = rule('.workspace-setting input[type="number"], .workspace-setting select {');

    assert.match(group, /border:\s*1px solid var\(--light-border\)/);
    assert.match(group, /border-radius:\s*var\(--radius-card\)/);
    assert.doesNotMatch(group, /box-shadow/);
    assert.match(heading, /text-transform:\s*none/);
    assert.match(heading, /font-size:\s*12px/);
    assert.match(heading, /color:\s*var\(--light-muted\)/);
    assert.match(css, /\.workspace-setting \+ \.workspace-setting[^{]*\{[^}]*border-top:\s*1px solid var\(--light-border\)/);
    assert.match(css, /\.workspace-group \.workspace-control-grid[^{]*\{[^}]*gap:\s*0/);

    assert.match(toggle, /width:\s*40px/);
    assert.match(toggle, /height:\s*24px/);
    assert.match(toggle, /border-radius:\s*var\(--radius-pill\)/);
    assert.match(toggle, /background:\s*var\(--track-off-light\)/);
    assert.match(knob, /width:\s*18px/);
    assert.match(knob, /transition:\s*transform \.14s ease/);
    assert.doesNotMatch(css, /cubic-bezier\([^)]*-\d/);
    assert.match(css, /\.settings-switch:checked \{[^}]*background:\s*var\(--gold\)/);
    assert.match(css, /:checked::before \{[^}]*transform:\s*translateX\(16px\)/);

    assert.match(select, /min-height:\s*44px/);
    assert.match(select, /border:\s*1px solid var\(--light-border-strong\)/);
    assert.match(select, /background:\s*var\(--light-card-low\)/);
    assert.match(select, /color:\s*var\(--light-text\)/);
    assert.doesNotMatch(css, /min-height:\s*31px/);

    assert.doesNotMatch(css, /\.apstudy-select-trigger/, "Workspace uses labelled native selects rather than a second custom-dropdown interaction model");
});

// Never opacity alone — aria-disabled plus .control-disabled-reason carry the
// state. .55 keeps AA text contrast on parchment.
test("info affordance and dependent dimming are styled and focusable", () => {
    const info = rule(".workspace-info {");

    assert.match(info, /width:\s*24px/);
    assert.match(info, /height:\s*24px/);
    assert.match(css, /\.workspace-info:focus-visible \{[^}]*outline:\s*2px solid var\(--gold\)/);
    assert.match(css, /\.workspace-setting\.has-info > label \{/);
    // The info button forces div > label > input, so the pill toggle rule has to
    // reach through the label or those rows fall back to a native checkbox.
    assert.match(css, /\.settings-switch \{/);
    assert.match(css, /\.settings-switch:checked \{/);
    assert.match(css, /\.workspace-setting\.has-info\[data-info-open="true"\]/);
    assert.match(css, /\.workspace-setting\[aria-disabled="true"\] > :not\(\.control-disabled-reason\),[\s\S]{0,420}?opacity:\s*\.55/);
    assert.match(css, /\.workspace-group\[data-dependency="off"\] \.workspace-setting\.is-dependent/);
    assert.match(css, /\.control-disabled-reason/);
    assert.doesNotMatch(css, /opacity:\s*\.46/);

    // The info dot stays 24px but its target does not: a transparent overlay
    // reaches 48px, and the 12px inset is exactly the row's column-gap so it
    // stops at the toggle's edge instead of stealing from it.
    assert.match(css, /\.workspace-setting\.has-info \{[^}]*column-gap:\s*16px/);
    assert.match(css, /\.workspace-info::after \{[^}]*inset:\s*-10px/);
    assert.match(info, /position:\s*relative/);
    // align-items: center left the label at its content height, so the toggle's
    // real target was short of the 48px the row advertises.
    assert.match(css, /\.workspace-setting\.has-info > label \{[^}]*min-height:\s*48px/);
});

// Phase 7. Gold measures 2.10:1 on #ffffff, so a gold-only ring is not a 3:1
// state indicator on the parchment card; the navy hairline is what carries it.
// tests/extension/contrast.test.js computes every ratio named here.
test("parchment focus rings, control boundaries, and the toggle track carry a 3:1 edge", () => {
    assert.match(css, /--light-border-strong:\s*color-mix\(in srgb, #1f1f1e 55%, #f0eeeb\)/);
    assert.match(css, /--track-off-light:\s*color-mix\(in srgb, #0a0f22 50%, #f0eeeb\)/);
    assert.doesNotMatch(css, /--track-off-light:\s*color-mix\(in srgb, #0a0f22 18%/);
    assert.match(css, /\.workspace-stage :is\(a, button, input, select, textarea, summary, \[tabindex\]\):focus-visible \{\s*box-shadow:\s*0 0 0 1px var\(--navy\);/);
    // DESIGN.md bans glow shadows: the ring is one solid 1px containment band.
    assert.doesNotMatch(css, /box-shadow:\s*0 0 0 1px var\(--navy\)[^;]*,/);
    assert.match(rule(".global-search {"), /border:\s*1px solid var\(--border\)/);
    assert.match(rule(".workspace-category-select-wrap select {"), /var\(--light-border-strong\)/);
    assert.match(rule(".sidebar-preset-setting select {"), /var\(--light-border-strong\)/);
    // The decorative hairline keeps its own job: group cards and row rules.
    assert.match(rule(".workspace-group {"), /border:\s*1px solid var\(--light-border\)/);
});

// The compact header is the one place DESIGN.md allows below 48px, and it floors
// at 40px. The rail is the pane that has to survive 200% text zoom, so it is the
// only flexible child of the sidebar.
test("compact header holds its 40px floor and the rail stays the scrolling child", () => {
    assert.match(rule(".global-search {"), /min-height:\s*40px/);
    assert.doesNotMatch(css, /\.global-search \{[^}]*min-height:\s*3[0-9]px/);
    [".compact-brand"].forEach((selector) => {
        assert.match(rule(`${selector} {`), /min-height:\s*40px/, `${selector} is below the compact-header floor`);
    });
    assert.match(rule(".icon-button {"), /min-height:\s*44px/);

    const rail = rule("\n.workspace-nav {");
    const railLabel = rule(".workspace-nav-label {");
    assert.match(rail, /flex:\s*1 1 auto/, "the rail must absorb the sidebar's spare space, not the label");
    assert.match(rail, /overflow-y:\s*auto/);
    assert.match(rail, /overscroll-behavior:\s*contain/);
    assert.match(railLabel, /flex:\s*0 0 auto/, "the label must not be squeezed into the scroller at 200% zoom");
    assert.match(rule(".workspace-sidebar {"), /min-height:\s*0/);
    // Reduced motion has to reach the pill toggle's transform, which is the only
    // motion the settings column ships.
    assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\*, \*::before, \*::after \{[^}]*transition-duration:\s*\.01ms\s*!important/);
});

test("Workspace identity uses the agreed overview and account route contract", () => {
    assert.match(html, /id="compact-home-trigger"[^>]*data-route="overview"[^>]*data-workspace-target="overview"/);
    assert.match(html, /<button type="button" class="workspace-account-context" id="workspace-account-trigger"[^>]*data-workspace-target="calendar-accounts"/);
    [
        "workspace-account-avatar",
        "workspace-account-name",
        "workspace-account-source",
        "workspace-account-status",
        "account-section-avatar",
        "account-section-name",
        "account-section-source",
        "account-section-status",
        "account-section-binding"
    ].forEach((id) => assert.match(html, new RegExp(`id="${id}"`), `missing #${id}`));
    ["home-view", "home-edit-canvas", "profile-button", "profile-popover"].forEach((id) => {
        assert.doesNotMatch(html, new RegExp(`id="${id}"`), `retired #${id} remains in popup markup`);
    });
    assert.doesNotMatch(html, /<button[^>]*data-workspace-target="calendar-accounts"[^>]*>[\s\S]*?<span>Account &amp; calendar<\/span>/);
    assert.match(html, /id="calendar-nest-login"/);
    assert.match(html, /class="account-identity-card" data-identity-state="unavailable"/);
});

test("compact popovers are fixed, host-bounded scroll trays", () => {
    const tray = rule(".compact-popover {");

    assert.match(tray, /position:\s*fixed/);
    assert.match(tray, /box-sizing:\s*border-box/);
    assert.match(tray, /width:\s*min\(320px,\s*calc\(100% - 24px\)\)/);
    assert.match(tray, /max-height:\s*min\(360px,\s*calc\(100% - 24px\)\)/);
    assert.match(tray, /overflow-y:\s*auto/);
    assert.doesNotMatch(tray, /right:/);
    assert.doesNotMatch(tray, /100v[hw]/);
});

test("account routes and identity card preserve touch targets and visible states", () => {
    const route = rule(".workspace-account-context {");
    const identity = rule(".account-identity-card {");

    assert.match(route, /min-height:\s*44px/);
    assert.match(route, /cursor:\s*pointer/);
    assert.match(css, /\.workspace-account-context:focus-visible \{[^}]*outline:\s*2px solid var\(--gold\)/);
    assert.match(css, /\.workspace-account-context\.is-active \{[^}]*background:\s*var\(--gold-tint-light\)/);
    assert.match(identity, /border:\s*1px solid var\(--light-border\)/);
    assert.match(identity, /background:\s*var\(--light-card-low\)/);
    assert.match(css, /\.account-identity-card \.workspace-action \{[^}]*min-height:\s*44px/);
    assert.match(css, /\.account-identity-card\[data-identity-state="authenticated"\] #calendar-nest-login \{[^}]*display:\s*none/);
    assert.match(css, /\.nest-onboarding\[hidden\] \{[^}]*display:\s*none/);
});

test("Sidebar styling contract covers grouped presets, dependency state, rows, status, and focus", () => {
    [
        ".sidebar-control-group",
        ".sidebar-preset-grid",
        ".sidebar-preset-setting",
        '[data-sidebar-enabled="false"]',
        ".sidebar-page-row[draggable=\"true\"]",
        ".drag-handle",
        ".sidebar-visibility",
        ".sidebar-advanced-disclosure",
        "#sidebar-status-value[data-state=\"saving\"]",
        ".sidebar-settings-section :is(input, select, button, summary):focus-visible"
    ].forEach((selector) => assert.match(css, new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `missing Sidebar styling hook: ${selector}`));
});

// The coral hex is long gone; what lingered was semantic drift — class names for
// colours we no longer ship, --error-text worn by non-error states, and angled
// gradients between two identical stops.
test("popup CSS carries no banned colour, dead colour name, or fake gradient", () => {
    assert.doesNotMatch(css, /#f27c70/i);
    assert.doesNotMatch(css, /#ff0000/i);
    assert.doesNotMatch(css, /-coral|-violet/);
    assert.doesNotMatch(css, /Inter|Space Grotesk/);
    assert.match(css, /--gold:\s*#D4AF37/);
    assert.match(css, /--navy:\s*#0a0f22/);
    assert.doesNotMatch(rule('.nest-status-pill[data-identity-state="expired"]'), /--error-text/);

    // Every remaining --error-text use must name a real failure state.
    Array.from(css.matchAll(/([^\n{}]+)\{[^}]*var\(--error-text\)/g), (match) => match[1].trim())
        .forEach((selector) => {
            assert.match(selector, /error|failed|disabled|notice|:root|prefers-color-scheme/, `--error-text on a non-error state: ${selector}`);
        });

    Array.from(css.matchAll(/linear-gradient\(((?:[^()]|\([^()]*\))*)\)/g), (match) => match[1])
        .forEach((body) => {
            const stops = body.split(/,(?![^(]*\))/).map((part) => part.trim()).filter(Boolean)
                .filter((part) => !/^-?[\d.]+(?:deg|turn|rad)$|^to /.test(part));
            assert.ok(new Set(stops).size > 1, `fake single-colour gradient: linear-gradient(${body})`);
        });
});

// The preview toolbar has exactly one owner now — the overlay shadow root. The
// in-iframe copy is gone, so nothing here may reference it.
test("parchment nav and compact header chrome both have visible focus-visible states", () => {
    assert.match(css, /\.workspace-nav button:focus-visible/);
    assert.match(css, /\.workspace-stage button:focus-visible/);
    assert.match(css, /\.compact-expand:focus-visible/);
    assert.match(css, /\.compact-close:focus-visible/);
    assert.match(css, /min-height:\s*48px/);
    assert.doesNotMatch(css, /embedded-preview/);
});

test("sidebar status rows use Nest surfaces and one-pixel separators instead of accent side tabs", () => {
    const optInState = rule('.workspace-optin-state[data-state="on"] {');
    const canvasLoadNote = rule('#workspace-section-sidebar [data-canvas-load-note] {');

    assert.match(optInState, /background:\s*var\(--gold-tint-light\)/);
    assert.doesNotMatch(optInState, /border-left|border-inline-start/);
    assert.match(canvasLoadNote, /border-top:\s*1px solid var\(--light-border\)/);
    assert.match(canvasLoadNote, /padding-top:\s*8px/);
    assert.doesNotMatch(canvasLoadNote, /border-left|border-inline-start/);
});

test("popover, Workspace actions, and reordering controls meet the 44px touch floor at every width", () => {
    assert.match(rule(".popover-close {"), /width:\s*44px/);
    assert.match(rule(".popover-close {"), /min-width:\s*44px/);
    assert.match(rule(".popover-close {"), /min-height:\s*44px/);
    [".sidebar-page-row .workspace-action {", ".sidebar-course-order-row .workspace-action {"]
        .forEach((selector) => {
            const action = rule(selector);
            assert.match(action, /width:\s*44px/);
            assert.match(action, /min-width:\s*44px/);
            assert.match(action, /min-height:\s*44px/);
        });
    const narrow = css.match(/@container shell \(max-width: 560px\) \{[\s\S]*$/)?.[0] || "";
    assert.match(narrow, /\.workspace-action, \.local-theme-item \.workspace-action \{ min-height: 44px; \}/);
    assert.match(narrow, /\.sidebar-page-row \.workspace-action, \.sidebar-course-order-row \.workspace-action \{ width: 44px; min-width: 44px; min-height: 44px; \}/);
    assert.match(narrow, /\.sidebar-page-row, \.sidebar-course-order-row \{ grid-template-columns:/);
});

test("popup boolean controls have explicit switch semantics and full labels across nesting shapes", () => {
    const checkboxes = Array.from(html.matchAll(/<input\b[^>]*type="checkbox"[^>]*>/g), (match) => match[0]);
    assert.ok(checkboxes.length > 30);
    checkboxes.forEach((markup) => {
        assert.match(markup, /class="settings-switch"/);
        assert.match(markup, /role="switch"/);
    });
    assert.match(rule(".settings-switch {"), /appearance:\s*none/);
    assert.doesNotMatch(css, /font-size:\s*(?:9|10|11)px/);
    assert.match(rule(".workspace-setting.has-info > label small {"), /white-space:\s*normal/);
    assert.match(css, /@media \(prefers-color-scheme: light\)/);
    assert.match(css, /@media \(prefers-color-scheme: dark\)/);
    assert.match(rule(".sr-only {"), /clip-path:\s*inset\(50%\)/);
});
