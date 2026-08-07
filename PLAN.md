# APStudyCanvas — Fork & Customization Plan

Fork [GuySandler/CanvasRefined](https://github.com/GuySandler/CanvasRefined) into a personal,
editable Brave extension named **APStudyCanvas**, living at `~/Desktop/APStudyCanvas`, carrying
over the settings currently saved by the Web Store copy of CanvasRefined.

Execution is performed entirely by Cursor Grok 4.5 subagents. The orchestrating agent acts as
manager and does not edit files directly except under the exception clause at the end of this
document.

---

## Locked decisions

These were confirmed by the user before planning and are not open for reinterpretation.

| # | Decision | Choice |
|---|----------|--------|
| 1 | Clone location | `~/Desktop/APStudyCanvas` (new top-level folder) |
| 2 | Extension identity | **Remove** the inherited `key` from `manifest.json` → fresh extension ID |
| 3 | Settings transfer | DevTools console export/import (no direct LevelDB access) |
| 4 | Store CanvasRefined | **Disable**, do not uninstall — it stays as the settings backup |
| 5 | Rebrand scope | `manifest.json` name/description, `README.md`, popup title, **and** icons |
| 6 | Git | Rename `origin` → `upstream`; create new GitHub repo and push as `origin` |
| 7 | Docs | `PLAN.md` + `CONTEXT.md` written to `~/Desktop` first, then moved into the repo root |

**Manager default, flagged for reversal:** the new GitHub repo is created **private** under account
`SimpleLemon`. MIT permits public redistribution with attribution, so this can be flipped later with
`gh repo edit --visibility public`.

---

## Why removing the `key` matters

`CanvasRefined/manifest.json` ships a `key` field that pins the extension ID to
`ihienfbdfdamhmhhiokjnjmpjgbenedg` even when loaded unpacked. Two consequences:

- **Left in place**, Brave treats the fork as the same extension as the store install. The two cannot
  both be enabled, and the fork silently inherits the existing storage.
- **Removed** (decision 2), Brave derives a fresh ID from the unpacked directory path. The fork and
  the store copy coexist, which is what makes decision 4 possible — but it also means the saved
  settings live under a different storage namespace and must be genuinely migrated (Phase 3).

Removing the `key` also drops `update_url`, so the fork will never be silently overwritten by a Web
Store update.

---

## Phase 0 — Preflight (Subagent A)

1. Confirm `~/Desktop/APStudyCanvas` does **not** already exist. Abort rather than overwrite.
2. Confirm `git`, `gh`, and `sips` are available and `gh auth status` is healthy.
3. Record the resolved upstream commit SHA of `main` for provenance.

## Phase 1 — Clone and git setup (Subagent A)

1. `git clone https://github.com/GuySandler/CanvasRefined.git ~/Desktop/APStudyCanvas`
   Clone the `main` branch. History is preserved (decision 6 rules out a fresh `init`).
2. `git remote rename origin upstream` so upstream updates remain pullable.
3. `gh repo create APStudyCanvas --private --source=. --remote=origin --push`
4. Verify `git remote -v` shows both `upstream` (GuySandler) and `origin` (SimpleLemon).
5. Move `~/Desktop/PLAN.md` and `~/Desktop/CONTEXT.md` into the repo root.
6. Add `.DS_Store` to `.gitignore` if not already ignored.

**Do not** commit anything yet beyond what `gh repo create --push` produces; Phase 2 owns the first
substantive commit.

## Phase 2 — Rebrand (Subagent B)

### In scope

- `manifest.json`
  - `name`: `CanvasRefined` → `APStudyCanvas`
  - `description`: rewrite to describe the personal AP-study-oriented build
  - `action.default_title`: `Canvas Refined` → `APStudyCanvas`
  - **delete** the `key` field
  - **delete** the `update_url` field
  - reset `version` to `5.12.6` retained, or bump — leave as-is unless it breaks loading
- `_locales/en/messages.json` — only the entry that renders the extension name (1 known match)
- `html/popup.html` and `html/options.html` — only user-visible title/heading text (2 and 3 matches)
- `README.md` — full rewrite per the attribution requirements below
- Icons — replace with the APStudy logo (see below)

### Explicitly OUT of scope — do not touch

`js/content.js` (209 matches), `css/content.css` (109 matches), `css/darkmodecss.js` (40 matches),
`js/themes.js`, `js/popup.js`, `js/background.js`.

These matches are **internal CSS class prefixes, DOM IDs, and storage keys**, not branding. Renaming
them is a functional refactor that will break styling and stored-settings compatibility, and it would
guarantee merge conflicts against `upstream`. Leave every internal identifier spelled
`canvasrefined`. If a subagent believes a specific match is genuinely user-facing branding, it must
report it to the manager rather than change it unilaterally.

### Icons

Source: `https://resources.apstudy.org/images/AP-Resources-Logo.png` (verified HTTP 200, PNG, 290 KB).

Download once, then generate with `sips` (ImageMagick is not installed):

- `icon/icon-16.png`, `icon-32.png`, `icon-48.png`, `icon-128.png` — referenced by `manifest.icons`
- `icon/icon-19.png`, `icon-38.png` — referenced by `manifest.action.default_icon`
- `icon/NEWtitle.png` — the README banner image

Preserve the exact filenames; the manifest and README reference them by path. Do not delete
`icon/dropdownArrow.svg`, which is functional UI, not branding.

### README attribution (required)

The MIT license obliges attribution, and the fork chain has two ancestors. The new `README.md` must:

- state that APStudyCanvas is a personal fork of
  [CanvasRefined by GuySandler](https://github.com/GuySandler/CanvasRefined)
- note that CanvasRefined is itself a fork of the MIT-licensed BetterCanvas (now BetterCampus)
- retain `LICENSE-MIT` unmodified in the repo root
- keep the original copyright line intact
- describe the actual dev-install workflow for this fork (load unpacked, not Web Store)
- remove Web Store install instructions, which no longer apply

Keep `CODE_OF_CONDUCT.md`, `PRIVACY_POLICY.md`, and `theStory.md` in place; `theStory.md` is part of
the upstream provenance record.

Commit as a single logical change with a descriptive message.

## Phase 3 — Settings migration (Subagent C)

Deliverable is `MIGRATION.md` in the repo root plus any helper snippet files. This phase produces
**instructions the user runs**, because export requires a live browser session — no subagent should
attempt to read or write Brave's LevelDB files.

`MIGRATION.md` must document, in order:

1. **Load the fork.** `brave://extensions` → Developer mode → Load unpacked → `~/Desktop/APStudyCanvas`.
   Record the new extension ID that Brave assigns.
2. **Order matters.** Load the fork *before* importing. `js/background.js` writes its default option
   set on `chrome.runtime.onInstalled`; importing first would have those defaults overwrite the
   imported values.
3. **Export from the store copy.** Open DevTools on CanvasRefined's service worker
   (`ihienfbdfdamhmhhiokjnjmpjgbenedg`) and dump both namespaces. Use DevTools' `copy()` rather than
   `console.log`, because the console truncates large objects and `js/themes.js`-related data is
   large:
   ```js
   chrome.storage.sync.get(null, d => copy(JSON.stringify(d)));
   chrome.storage.local.get(null, d => copy(JSON.stringify(d)));
   ```
   Save each to a scratch file. These files contain personal settings and must **not** be committed;
   `MIGRATION.md` should say so and `.gitignore` should cover them.
4. **Import into the fork.** DevTools on the fork's service worker, `chrome.storage.sync.set(...)`
   and `chrome.storage.local.set(...)`.
5. **Handle `new_install`.** The defaults include `new_install: true`. After import, confirm it is
   `false` so the fork does not replay first-run behavior.
6. **Quota warning.** `chrome.storage.sync` caps at ~102 KB total and ~8 KB per item. If the sync
   export exceeds this, document the fallback: import the oversized keys into `local` instead, and
   note which keys were relocated.
7. **Disable the store copy** (decision 4) only after the fork is confirmed working.

## Phase 4 — Verification (Subagent D)

Read-only audit. Report findings; do not fix silently.

- `manifest.json` parses as valid JSON, contains no `key` and no `update_url`, and `name` is `APStudyCanvas`
- All six icon paths plus `NEWtitle.png` referenced by `manifest.json` and `README.md` exist and are valid PNGs
- `git remote -v` shows `upstream` → GuySandler and `origin` → SimpleLemon/APStudyCanvas
- `LICENSE-MIT` is present and byte-identical to upstream
- `README.md` credits both CanvasRefined and BetterCanvas
- No internal `canvasrefined` identifier in `js/` or `css/` was altered — verify with
  `git diff upstream/main --stat` that no out-of-scope file appears
- `PLAN.md`, `CONTEXT.md`, `MIGRATION.md` are all in the repo root
- No exported settings JSON is tracked by git

---

## Rollback

The store CanvasRefined install stays enabled until Phase 3 succeeds, so the working setup is never
at risk. If the fork misbehaves: remove the unpacked extension in `brave://extensions`, re-enable the
store copy, and delete `~/Desktop/APStudyCanvas`. Nothing in this plan modifies Brave's own profile
data, and the original extension directory under `Profile 1/Extensions/` is never written to.

## Manager exception clause

The orchestrating agent may edit files directly **only** if a subagent fails outright or deviates
materially from this plan. Any such intervention must be recorded here, appended below, stating what
the subagent did wrong and what the manager changed.

### Interventions

_None recorded._
