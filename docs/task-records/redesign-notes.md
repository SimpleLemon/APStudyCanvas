# Redesign Notes

## Scope
Implement the bounded Notes feature for the approved workspace redesign. Own only `js/workspace-notes.js`, `css/workspace-notes.css`, focused Notes tests, and this record. Preserve the existing account-scoped local text storage key and transaction behavior. Do not modify shared entrypoints, manifests, the Study surface, or Planner records.

## Planned units
- [x] Inspect Foundation lifecycle/context and incumbent Notes model/UI/storage contracts.
- [x] Define a Notes module factory with `mount`, `routeUpdate`, synchronous `queryDirty`, local `search`, and idempotent `dispose`.
- [x] Implement account-verified local persistence, search/filter/sort, editor, save/trash/restore, excerpts, status, failed-draft preservation, and narrow list/editor navigation.
- [x] Add focused tests for exact legacy persistence, Study/planner record preservation, account changes, failures, dirty navigation, search, focus retention, and trash/restore.
- [x] Run bounded syntax/tests/detector/diff checks and document exact integration needs.

## Checks
- `node --check js/workspace-notes.js` — pass.
- `node --test tests/extension/workspace-notes.test.js tests/extension/workspace-model.test.js tests/extension/workspace-foundation.test.js` — 16/16 pass.
- `node /Users/derekchen/Desktop/APStudyCanvas/.agents/skills/impeccable/scripts/detect.mjs --json js/workspace-notes.js css/workspace-notes.css` — `[]` (the single authorized mechanical detector run).
- `git diff --check` — pass before record update.
- No full suite, build, or visual/browser round was run; those remain reserved for manager integration.
- Latest five-hour usage check before final record/commit: 28% used, 72% remaining.

## Blockers and contracts
Foundation at this checkpoint exposes verified `canvas.origin` and the hashed `canvas.accountKey`, but omits the already-sanitized numeric `canvasBinding.canvasUserId` from feature context. Notes must remain gated until Integration exposes that raw ID as `context.account.canvas.accountId` or injects an equivalent live verifier. `context.account.scope` must not replace the incumbent `apstudycanvas.workspace.v1:<origin>:<accountId>` key.

## Completed Notes unit
- `js/workspace-notes.js` contains the UMD module factory, exact numeric-account storage gating, explicit-save editor lifecycle, course/search/sort/trash controls, dirty/failure preservation, and account-scoped local search provider.
- `css/workspace-notes.css` contains the adjacent library/editor layout, 44px interactive targets, focus treatment, and narrow list-to-editor/Back behavior.
- `tests/extension/workspace-notes.test.js` is the focused risk suite.
- No shared entrypoint, manifest, Foundation, Study, planner, or backend file was changed.

## Precise Integration needs
1. Extend the trusted Foundation account adapter to carry the sanitized raw numeric `canvasBinding.canvasUserId` as `context.account.canvas.accountId`; keep `canvas.accountKey` and `account.scope` unchanged for their existing consumers.
2. Load `js/content/workspace-model.js`, `js/workspace-notes.js`, and `css/workspace-notes.css` in the popup workspace. Instantiate `createWorkspaceNotes({ document, window, model, storage, host, verifyAccount, readCourses, onDirtyChange })` and register the returned module at `routeModules().notes`.
3. Change the module-host `confirmLeave(from, to)` callback so Notes dirty state receives an actual discard confirmation. Include module-host dirty state in shell close, parent-overlay close/Escape/outside-click, and `beforeunload` handling. `queryDirty()` is synchronous; `onDirtyChange(boolean)` fires only on transitions and is reset to `false` on save/discard/dispose.
4. Merge `await notesModule.search(query, moduleContext)` into global-search results. It returns up to eight recent active matches shaped as `{ id, route: "notes", label, helper, terms, detail: { query, noteId } }`; pass `detail` to `moduleHost.navigate(result.route, result.detail)`. The module also accepts `{ q, note }` route aliases.
5. Keep Study and Planner records untouched by reusing `WorkspaceModel.createStore().transact`, which re-reads and writes the full existing v1 workspace object under the legacy origin/account ID key.

## Next action
Commit this completed bounded unit and hand the commit ID plus the integration contract above to the redesign manager. Manager integration owns shared wiring and the later batched visual/full-suite/build checks.
