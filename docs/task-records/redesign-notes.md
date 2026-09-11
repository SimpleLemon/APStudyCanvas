# Redesign Notes

## Scope
Implement the bounded Notes feature for the approved workspace redesign. Own only `js/workspace-notes.js`, `css/workspace-notes.css`, focused Notes tests, and this record. Preserve the existing account-scoped local text storage key and transaction behavior. Do not modify shared entrypoints, manifests, the Study surface, or Planner records.

## Planned units
- [x] Inspect Foundation lifecycle/context and incumbent Notes model/UI/storage contracts.
- [x] Define a Notes module factory with `mount`, `routeUpdate`, `queryDirty`, and idempotent `dispose` (checkpointed, untested).
- [ ] Implement account-verified local persistence, search/filter/sort, editor, save/trash/restore, excerpts, status, failure preservation, and narrow navigation (initial implementation present; review and verification remain).
- [ ] Add focused tests for persistence, account changes, failures, dirty navigation, and trash/restore.
- [ ] Run bounded syntax/tests/detector/diff checks and document exact integration needs.

## Checks
Not run. The manager reported account usage above the required 90% stop threshold, and a direct check showed 99% used. Per instruction, no syntax check, focused test, detector, build, or browser round was started.

## Blockers and contracts
Foundation currently exposes verified `canvas.origin` and the hashed `canvas.accountKey`, but omits the already-sanitized numeric `canvasBinding.canvasUserId` from feature context. Notes must remain gated until Integration exposes that raw ID (for example as `context.account.canvas.accountId`) or injects an equivalent live verifier. `context.account.scope` must not replace the incumbent `apstudycanvas.workspace.v1:<origin>:<accountId>` key.

## Partial checkpoint
- `js/workspace-notes.js` contains an untested UMD module factory and the intended lifecycle/UI/persistence implementation.
- `css/workspace-notes.css` contains the untested adjacent library/editor layout and narrow list/editor/back behavior.
- Focused tests have not been added.
- No shared file has been changed.

## Precise Integration needs
1. Extend the trusted Foundation account adapter to carry the sanitized raw numeric `canvasBinding.canvasUserId` as `context.account.canvas.accountId`; keep `canvas.accountKey` and `account.scope` unchanged for their existing consumers.
2. Load `js/content/workspace-model.js`, `js/workspace-notes.js`, and `css/workspace-notes.css` in the popup workspace, instantiate `createWorkspaceNotes` with local storage and the existing course reader, and register the returned module at `routeModules().notes`.
3. Change the module-host `confirmLeave(from, to)` callback so Notes dirty state receives an actual discard confirmation. The current callback only checks `themeDraft`, so it silently approves a dirty Notes transition. Include module-host dirty state in `beforeunload` handling.
4. Feed global-search local-note matches into route detail as `{ query, noteId }` (or `{ q, note }`). The module supports both forms and opens a matching saved note; current shell search only provides one static Notes route result.
5. Keep Study and Planner records untouched by reusing `WorkspaceModel.createStore().transact`, which re-reads and writes the full existing v1 workspace object under the legacy origin/account ID key.

## Next action
After usage resets and explicit manager instruction: inspect the partial source, add focused Notes tests, run syntax plus only the focused Notes/model/Foundation checks, run the detector once on the two new UI files, update this record with exact results, and commit the completed unit separately if needed.
