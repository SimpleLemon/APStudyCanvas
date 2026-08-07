# Settings migration — CanvasRefined → APStudyCanvas

Runbook for copying your live settings from the Web Store **CanvasRefined** install into the unpacked **APStudyCanvas** fork in Brave.

| | Store copy (source) | Fork (destination) |
|---|---|---|
| Name | CanvasRefined | APStudyCanvas |
| Extension ID | `ihienfbdfdamhmhhiokjnjmpjgbenedg` | **new ID** Brave assigns after Load unpacked |
| Location | Web Store install | `/Users/derekchen/Desktop/APStudyCanvas` |

The fork had the manifest `key` removed, so Brave gives it a **separate storage namespace**. Export and re-import are required; the two extensions do not share settings automatically.

**Do not** open or edit Brave's LevelDB folders under `Local Extension Settings/` or `Sync Extension Settings/`. Everything below uses the extension service-worker DevTools console only.

---

## 1. Load the fork first

1. Open `brave://extensions`.
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked**.
4. Select `/Users/derekchen/Desktop/APStudyCanvas`.
5. Confirm **APStudyCanvas** appears in the list and is **enabled**.
6. Copy and save the **new extension ID** shown under the fork's card. You will need it in steps 4–7.

Leave the store CanvasRefined (`ihienfbdfdamhmhhiokjnjmpjgbenedg`) **enabled** for now. You still need its service worker to export settings.

---

## 2. Why this order matters

`js/background.js` runs on `chrome.runtime.onInstalled` and fills in any missing keys from its default option set. If you imported settings *before* loading the fork, that install handler would write defaults on top of (or instead of) your imported values.

Correct sequence:

1. Load unpacked (install fires once; defaults land in the empty namespace).
2. Export from the store copy.
3. Import into the fork (**overwrites** those defaults with your real settings).
4. Confirm `new_install` is `false` (step 5).

---

## 3. Export from the store copy

### Open DevTools on CanvasRefined's service worker

1. Go to `brave://extensions`.
2. Find **CanvasRefined** — ID must be `ihienfbdfdamhmhhiokjnjmpjgbenedg`.
3. Under that card, click the **service worker** / **Inspect views: service worker** link (wording varies slightly by Brave version).
4. A DevTools window opens. Use the **Console** tab.

> **Wrong console = wrong data.** Every snippet in this step is for the **store** service worker only (`ihienfbdfdamhmhhiokjnjmpjgbenedg`). Do not paste these into the fork's DevTools.

### Export `chrome.storage.sync`

Paste into the **store** service-worker console and press Enter:

```js
chrome.storage.sync.get(null, d => copy(JSON.stringify(d)));
```

DevTools' `copy()` puts the full JSON on your clipboard (unlike `console.log`, which truncates large objects — theme-related data can be large).

1. Open a plain-text editor.
2. Paste and save as something like `canvasrefined-sync-storage-export.json`.

### Export `chrome.storage.local`

Still in the **same store** service-worker console:

```js
chrome.storage.local.get(null, d => copy(JSON.stringify(d)));
```

Paste and save as something like `canvasrefined-local-storage-export.json`.

### Privacy / git

These files contain your personal UI toggles, themes, GPA config, and dashboard preferences.

- **Do not commit them.**
- Prefer names matching `*-storage-export.json` or `storage-export-*.json` — the repo `.gitignore` already ignores those patterns.
- Keep them outside the repo, or delete them after a successful migration.

### What lives where (from `background.js` defaults)

Useful when checking an export or diagnosing quota issues. Runtime may also create extra keys (e.g. `update_msg`, overflow buckets); export dumps **everything**, not only defaults.

**`chrome.storage.local` keys**

- `previous_colors`
- `previous_theme`
- `errors`
- `saved_themes`
- `liked_themes`

**`chrome.storage.sync` keys** (non-exhaustive of runtime, but the full default set)

- Theme / appearance: `dark_preset`, `dark_mode`, `gradent_cards`, `disable_color_overlay`, `auto_dark`, `auto_dark_start`, `auto_dark_end`, `device_dark`, `custom_font`, `custom_styles`, `customBackgroundLink`, `customBackgroundScale`, `imageSize`, `cardRoundness`, `cardSpacing`, `cardWidth`, `cardHeight`, `customCardStyles`, `full_width`, `remlogo`, `tab_icons`
- First-run / identity: `new_install`, `id`, `new_browser`
- Assignments / todo: `assignments_due`, `num_assignments`, `assignments_done`, `assignment_date_format`, `assignment_states`, `better_todo`, `todo_hr24`, `todo_separate_scrollbar`, `num_todo_items`, `todo_hide_feedback`, `todo_full_height`, `custom_assignments`, `custom_assignments_overflow`, `hover_preview`, `relative_dues`, `hide_feedback`
- Dashboard / cards: `dashboard_grades`, `dashboard_notes`, `dashboard_notes_text`, `better_sidebar`, `condensed_cards`, `custom_cards`, `custom_cards_2`, `custom_cards_3`, `card_overdues`, `card_method_date`, `card_method_dashboard`, `card_limit`
- GPA: `gpa_calc`, `gpa_calc_bounds`, `cumulative_gpa`, `gpa_calc_cumulative`, `gpa_calc_weighted`, `grade_hover`
- Reminders: `remind`, `reminders`, `reminder_count`, `multi_remind`
- Other: `custom_domain`, `dark_mode_fix`, `browser_show_likes`

`saved_themes` and `liked_themes` are the usual large **local** payloads. Oversized **sync** candidates are often `custom_cards*`, `custom_styles`, `dark_preset`, or assignment overflow keys.

---

## 4. Import into the fork

### Open DevTools on the fork's service worker

1. Go to `brave://extensions`.
2. Find **APStudyCanvas** — ID must be the **new** ID from step 1 (not `ihienfbdfdamhmhhiokjnjmpjgbenedg`).
3. Click **service worker** / **Inspect views: service worker** on **that** card.
4. Open the **Console** tab.

> **Critical:** Every snippet below goes into the **fork** service-worker console only. Pasting into the store copy would overwrite your backup settings.

### Measure size before importing (recommended)

In the **fork** console, paste your sync JSON into a const (replace the placeholder), then measure:

```js
const syncData = /* paste the full sync JSON object here */;
const syncBytes = new Blob([JSON.stringify(syncData)]).size;
const perItem = Object.entries(syncData).map(([k, v]) => [k, new Blob([JSON.stringify(v)]).size]);
console.log({ syncBytes, overQuota: syncBytes > 102400, perItem: perItem.sort((a, b) => b[1] - a[1]) });
```

`chrome.storage.sync` limits are roughly **102,400 bytes total** and **8,192 bytes per item**. If `overQuota` is true, or any item exceeds ~8192, see step 6 before calling `set`.

### Import sync

Still in the **fork** console — assign first, then set, then confirm:

```js
const syncData = /* paste the full sync JSON object from canvasrefined-sync-storage-export.json */;
chrome.storage.sync.set(syncData, () => {
  if (chrome.runtime.lastError) {
    console.error(chrome.runtime.lastError);
  } else {
    chrome.storage.sync.get(null, d => console.log("sync import OK, keys:", Object.keys(d).length));
  }
});
```

### Import local

```js
const localData = /* paste the full local JSON object from canvasrefined-local-storage-export.json */;
chrome.storage.local.set(localData, () => {
  if (chrome.runtime.lastError) {
    console.error(chrome.runtime.lastError);
  } else {
    chrome.storage.local.get(null, d => console.log("local import OK, keys:", Object.keys(d).length));
  }
});
```

Paste the JSON **object** (starts with `{`), not a quoted string. If you only have a stringified file, use `JSON.parse(...)` once when assigning the const.

---

## 5. Handle `new_install`

Defaults include `new_install: true`. On a normal first install, background code opens the options page and then sets it to `false`. After import you must ensure it stays off so first-run UI does not replay.

In the **fork** service-worker console:

```js
chrome.storage.sync.get("new_install", d => console.log("new_install =", d.new_install));
```

If it is anything other than `false`:

```js
chrome.storage.sync.set({ new_install: false }, () => {
  chrome.storage.sync.get("new_install", d => console.log("new_install now =", d.new_install));
});
```

---

## 6. Quota warning and fallback

If `chrome.storage.sync.set` fails with a quota error, or step 4's size check flagged oversized items:

1. Identify oversized keys from the `perItem` list (anything near or over **8192** bytes, or the largest keys when total exceeds **102400**).
2. Move those keys into **local** instead, and remove them from the sync payload.
3. Record which keys you relocated (write them down — the fork expects some of them in sync for normal UI; relocating is a last resort and may need follow-up if a feature stops reading a key).

Example pattern in the **fork** console:

```js
const syncData = /* full sync export */;
const oversizedKeys = ["custom_styles"]; // replace with keys you measured as too large
const relocated = {};
for (const k of oversizedKeys) {
  if (syncData[k] !== undefined) {
    relocated[k] = syncData[k];
    delete syncData[k];
  }
}
chrome.storage.local.set(relocated, () => {
  chrome.storage.sync.set(syncData, () => {
    console.log("relocated to local:", Object.keys(relocated));
    console.log(chrome.runtime.lastError || "sync set OK");
  });
});
```

Keep a note of relocated key names next to your export files.

---

## 7. Verification

1. Open a Canvas page that normally shows CanvasRefined customizations (dashboard, course home, etc.).
2. Confirm APStudyCanvas is active for that site (extension enabled; page matches your `custom_domain` if you use one).
3. Spot-check imported behavior:
   - Dark mode / theme colors match what you had before.
   - GPA calculator bounds and cumulative GPA look right.
   - Dashboard card prefs, notes, and assignment/todo toggles match.
4. Optionally re-check storage from the **fork** service-worker console:

```js
chrome.storage.sync.get(["new_install", "dark_mode", "gpa_calc"], d => console.log(d));
chrome.storage.local.get(["saved_themes", "liked_themes"], d => console.log(Object.keys(d)));
```

If something is missing, re-import from your scratch JSON (store copy is still enabled as backup). Do **not** disable the store copy until this step looks good.

---

## 8. Disable the store copy

Only after step 7 succeeds:

1. Open `brave://extensions`.
2. Find **CanvasRefined** (`ihienfbdfdamhmhhiokjnjmpjgbenedg`).
3. **Disable** it — do **not** uninstall.
4. Leave it installed as the rollback path and as a settings backup.

Both can remain installed; only one needs to be enabled for day-to-day use.

---

## 9. Rollback

If the fork misbehaves:

1. `brave://extensions` → remove **APStudyCanvas** (the unpacked extension).
2. Re-enable **CanvasRefined** (`ihienfbdfdamhmhhiokjnjmpjgbenedg`).
3. Your original settings remain under the store ID; no LevelDB repair needed if you never touched those folders.

Optional: keep or delete `/Users/derekchen/Desktop/APStudyCanvas` separately — removing the unpacked extension does not delete the folder on disk.
