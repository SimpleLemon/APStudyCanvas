# Redesign shared integration

## Ownership and base checkpoint

- Owner: bounded shared redesign integration worker.
- Base: `d201888` (`docs: hand off resumed redesign to fresh manager`); worktree clean at start.
- Owned shared scope: `js/edit-canvas.js`, `html/options.html`, extension manifests/content entrypoints, focused shared wiring tests, and this record.
- Explicit exclusions: do not edit `js/workspace-grades*.js`, `css/workspace-grades*.css`, `js/workspace-planner*.js`, `css/workspace-planner*.css`, `js/workspace-notes*.js`, or `css/workspace-notes*.css`; preserve Settings (including Notifications) and Study behavior.
- Usage at start: 24% primary / 35% weekly. No reset requested or available.

## Initial evidence and contracts

- Read `PRODUCT.md`, `DESIGN.md`, the redesign manager/plan records, and Foundation/Notes/Planner/Grades domain records.
- Loaded the approved Impeccable UI context, new-work guidance, and craft floor. The brief pins the visual direction and explicitly waives another interview; final visual/full-suite/build passes remain reserved for the manager.
- Integration must expose verified legacy Canvas account ID without changing the hashed Foundation scope, provide fresh Planner adapters with live verified Nest access and persistent scoped preferences/import ledger, route Canvas search into the existing authenticated Canvas search UI, and prepare the Grades read seam against existing Canvas readers and legacy workspace storage.

## Next unit

Inspect current shared entrypoints, manifests, bridge/search implementations, and focused tests. Confirm concurrent ownership before editing; then implement independent Planner/search/context wiring first. Grades module registration may wait for the worker-owned UI API.

## Unit 1 checkpoint: Planner and Canvas Search shared wiring

- Ownership rechecked against a clean tracked base; only this force-added record is currently untracked. Prohibited feature module/style files remain untouched.
- Grades worker API coordination sent to the manager and worker before shared wiring edits. Integration will consume the worker's established `APStudyCanvasWorkspaceGradesUI` API rather than define a competing contract.
- Canvas Search implementation authority is the already-mounted `APStudyCanvasContent.CanvasSearchUI` in `js/content.js`. The shared bridge will add only an exact authenticated `canvas-search` overlay action; it will not expose arbitrary content messages or create a second search UI.
- Planner construction will be per mount. Its account getter will combine verified Canvas state with the live connection coordinator snapshot; bridge sends remain limited to the adapter's four existing Nest message families. Local workspace-v1 planner tasks are read-only additions to range responses. Persistent preference/import keys remain scoped by the verified Canvas account.

Next: register Planner assets, implement the scoped storage/account/range wrappers and fresh route module, then add the bounded Canvas Search host action and focused contract tests.

## Unit 1 complete

- Registered Planner CSS, adapter, and UI in popup dependency order. Every Planner mount creates a fresh UI/adapter and a dedicated route host; disposal unsubscribes the live connection observer, disposes the adapter through the UI, and removes only that host.
- `verifiedModuleAccount()` now combines the current popup Canvas binding with the connection coordinator's live verified Nest identity, raw capabilities, and normalized current read/write consent. Display-only profiles remain excluded by Foundation verification.
- Planner bridge calls are allowlisted to the existing range/create/update/delete message families. Range reads merge account-verified legacy workspace-v1 planner records as immutable all-day `Local tasks`; Nest writes never mutate or delete those originals.
- Planner view preferences use local storage under the UI's account-scoped key. Explicit imports use a separate bounded 500-entry account-scoped local ledger with serialized writes and an account-stale check.
- Dirty state continues through the Foundation route/close/unload guard and embedded host draft signal. Connect/consent actions route through the existing Settings account/calendar surface.
- Global Search's Canvas result now invokes the existing `CanvasSearchUI` through the exact authenticated overlay session action and closes the shell only after that UI actually opens. Standalone shells fail honestly instead of navigating to Settings.
- Added an authenticated `grades-read` seam that accepts only `courses` or a numeric `course` ID, uses the incumbent complete Canvas pagination reader, and rejects account changes after the read. It does not compute estimates or mutate Canvas.
- Focused checks: syntax passed for all four touched JS entrypoints; 120 Planner/Foundation/Search/context/overlay-host/overlay-transport cases passed; `git diff --check` passed. Full suite/static/build/visual/live Nest checks remain reserved for the manager.
- Required one-time Impeccable detector pass over `html/popup.html` and `js/edit-canvas.js`: `[]` (no findings).

## Next unit

Consume the worker-owned `APStudyCanvasWorkspaceGradesUI.createGradesWorkspace`/module contract after its commit: register browser assets in popup and Canvas content order, inject the verified read adapter, legacy workspace record/save seam, separate chart preferences, bounds/scenario adapters, and native Canvas mount. Re-run only the focused Grades/shared wiring risks, then detector/diff/syntax and commit.

## Checkpoint disposition

- Primary usage reached 81%, so this independent unit is being committed before the 90% mandatory stop threshold rather than risking an uncommitted cross-worker merge.
- Grades UI worker remains active at checkpoint. The authenticated Canvas read seam and exact requested UI API are documented above; no absent worker-owned asset is referenced by the current popup or manifest.
- No prohibited Planner/Notes/Grades feature JS or CSS file was edited. No backend, sync protocol, generated Firefox output, push, deployment, full suite, static suite, visual round, or live Nest mutation was run.
