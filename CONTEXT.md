# CONTEXT — Extension source locations on this machine

Reference material for anyone (human or agent) working on **APStudyCanvas**. Everything below was
verified on this machine on 2026-08-07.

---

## Browser profile

Brave installs extensions per profile. Both relevant extensions live in **Profile 1**, whose display
name is "Personal" and which is the last-used profile.

```
/Users/derekchen/Library/Application Support/BraveSoftware/Brave-Browser/Profile 1/
```

Profile 2 ("Alt") has only uBlock Origin and Proton VPN. Profile 3 ("Tax") has no extensions
directory at all. Neither is relevant here.

---

## CanvasRefined — the fork parent

| | |
|---|---|
| Extension ID | `ihienfbdfdamhmhhiokjnjmpjgbenedg` |
| Installed version | `5.12.6` |
| Upstream | https://github.com/GuySandler/CanvasRefined |
| License | MIT (`LICENSE-MIT` ships in the package) |

```
/Users/derekchen/Library/Application Support/BraveSoftware/Brave-Browser/Profile 1/Extensions/ihienfbdfdamhmhhiokjnjmpjgbenedg/5.12.6_0/
```

**This is readable, unminified source.** Brave unpacks the CRX on install, so the Web Store copy is
effectively a source checkout: `js/` (`content.js` 218 KB, `popup.js` 96 KB, `themes.js` 589 KB,
`background.js` 5.6 KB, `backgrounds.js`), `css/`, `html/` (`popup.html`, `options.html`), `icon/`,
`_locales/` in 11 languages, plus `README.md`, `LICENSE-MIT`, `PRIVACY_POLICY.md`,
`CODE_OF_CONDUCT.md`, and `theStory.md`.

**Do not edit files in this directory.** Brave overwrites it on update and validates contents against
`_metadata/computed_hashes.json`. It is useful strictly for reading — comparing the shipped 5.12.6
build against whatever the GitHub `main` branch currently holds, if the two ever drift.

### Saved settings (LevelDB, not JSON)

```
Profile 1/Local Extension Settings/ihienfbdfdamhmhhiokjnjmpjgbenedg/
Profile 1/Sync Extension Settings/ihienfbdfdamhmhhiokjnjmpjgbenedg/
```

These are LevelDB directories holding the live UI toggles, theme choices, GPA-calculator config, and
dashboard preferences. Reading them off disk requires Brave to be fully quit and risks corrupting the
store, which is why `MIGRATION.md` uses a DevTools export instead. **Treat these paths as read-only
and, in practice, do not touch them at all.**

The default option set written on install is visible in plain text at `js/background.js` inside the
extension directory — a useful reference for what keys exist and what shape their values take.

---

## BetterCampus (prev. BetterCanvas) — reference only

| | |
|---|---|
| Extension ID | `cndibmoanboadcifjkjbdpjgfedanolh` |
| Installed versions | `9.0.0`, `9.2.0`, `9.3.0`, `9.4.0` (9.4.0 is current) |
| License in package | **None shipped** |

```
/Users/derekchen/Library/Application Support/BraveSoftware/Brave-Browser/Profile 1/Extensions/cndibmoanboadcifjkjbdpjgfedanolh/9.4.0_0/
```

**This code is bundled and minified.** `content-scripts/all.js` is 4.5 MB across 2,189 lines
(~2,100 chars per line), `content-scripts/extension-bridge.js` is 4.0 MB, `background.js` is 338 KB
across 249 lines. There are no source maps. Variables are single letters. Layout: `background.js`,
`content-scripts/`, `navigator/`, `first-time/`, `assets/`, `referrals/`.

No BetterCampus or BetterCanvas git clone exists anywhere on this machine — only these installed
builds.

### How to use BetterCampus: consult, never copy

CanvasRefined's own README states it forked from the MIT-licensed version of BetterCanvas before that
project changed its license. BetterCampus 9.x ships **no license file**, so its current code must be
assumed proprietary regardless of what its ancestor was licensed under.

**Permitted** — treat it as a product you are looking at, not a codebase you are reading:

- Observing behavior in the browser: what a feature does, when it triggers, how the UI is arranged
- Noting which Canvas DOM elements or API endpoints a feature evidently interacts with
- Describing a feature in your own words as a specification, then implementing it independently

**Not permitted:**

- Copying any code from `9.x_0/` into APStudyCanvas, including de-minified or reformatted code
- Running the bundles through a de-minifier or an LLM to reconstruct source and adapting the output
- Translating a BetterCampus implementation line-by-line into differently-named variables
- Copying non-code assets — images, `.webm` files, icons, or bundled `_locales` strings

Facts and ideas are not copyrightable; a specific implementation is. The safe pattern is to write
down *what* a feature should do without reference to the bundle, then build it from the Canvas API
and the existing CanvasRefined code. When in doubt, prefer CanvasRefined's own patterns — that code
is genuinely MIT and genuinely yours to reuse.

If a feature idea does come from observing BetterCampus, note the inspiration in the commit message.
Attribution of an idea costs nothing and makes the provenance clear.

---

## Quick reference

| What | Where |
|---|---|
| Fork working copy | `~/Desktop/APStudyCanvas` |
| CanvasRefined shipped source (read-only) | `…/Profile 1/Extensions/ihienfbdfdamhmhhiokjnjmpjgbenedg/5.12.6_0/` |
| CanvasRefined settings (do not touch) | `…/Profile 1/{Local,Sync} Extension Settings/ihienf…/` |
| BetterCampus bundles (reference only) | `…/Profile 1/Extensions/cndibmoanboadcifjkjbdpjgfedanolh/9.4.0_0/` |
| Extensions page | `brave://extensions` |

Unrelated but easy to confuse: `~/Desktop/Canvas.APStudy` is a MongoDB Atlas scratch folder with its
own git repo. It has nothing to do with this project.
