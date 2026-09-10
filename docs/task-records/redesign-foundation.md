# Redesign foundation

## Scope
Implement the approved shared APStudyCanvas workspace foundation only: persistent product shell and route state, shared theme/fullscreen/close behavior, Canvas plus local Notes search routing, Settings-only live-preview lifecycle, feature-module lifecycle contract, verified account-context adapter, placeholder routes for Grades/Planner/Notes, and focused shell/preview contract tests. Preserve the existing Settings interior, account/save behavior and storage compatibility. Preserve the existing Study destination and records. Do not implement feature redesigns, backend changes, push, deploy, full-suite, Firefox build, or visual review rounds.

## Base
- Worktree base: `4f3f8ac` plus docs-only cherry-pick `73f2bc4` from main.
- Approved inputs: `PRODUCT.md`, `docs/task-records/redesign-manager.md`, `docs/task-records/redesign-plan.md`, and the supplied sketch.
- Existing Settings markup/controller and preview engine are implementation evidence and remain the behavioral base.

## Owned files
- Shared popup workspace markup/styles/controller entrypoints as needed.
- New shared workspace shell, module lifecycle, and account-context modules.
- Shared extension manifests only if a new entrypoint must be loaded.
- Focused Foundation tests.
- This task record and the durable design record required by the approved redesign.

## Decisions and contracts
- Settings owns the live Canvas preview. Every transition away from Settings must synchronously request preview cover/release before another module mounts; returning may reacquire it only after the Settings route is active.
- Top-level routes are `settings`, `grades`, `planner`, `notes`, and the existing external `study` destination. Settings category state is nested under `settings` and remains backward compatible with the existing `category` query parameter.
- Feature modules receive a frozen context and implement `mount(context)`, optional `routeUpdate(route, context)`, `queryDirty()`, and `dispose(reason)`. Mount may return the same hook set. Dirty queries are async-safe. Dispose is idempotent and must release listeners, observers, timers, pending work, and DOM ownership.
- Route transitions consult the mounted module's dirty query before history mutation, restore focus after successful transitions, and leave the current route intact when declined.
- Verified account context distinguishes Canvas identity, verified Nest identity, capability/consent state, and account scope; it never promotes display/profile data into verified identity.
- Placeholder feature routes expose integration slots only. They do not fabricate data, unread state, or feature success.

## Completed units
- [x] Approved inputs and incumbent Settings/preview architecture inspected.
- [x] Shared route/module/account contracts implemented in `js/workspace-foundation.js`.
- [x] Persistent shell and honest placeholder route surfaces wired without changing Settings interior controls.
- [x] Settings-only preview, dirty navigation, focus, Escape/Back, theme/fullscreen/close lifecycle wired.
- [x] Focused tests added and passing.
- [x] Durable `DESIGN.md` and implementation contract finalized; Foundation commit created.

## Exact checks
- `node --test tests/extension/workspace-foundation.test.js tests/extension/overlay-preview.test.js tests/extension/overlay-host.test.js tests/extension/workspace-ia.test.js tests/extension/content-lifecycle-invalidation.test.js` — 100 passed, 0 failed.
- JavaScript syntax checks for `js/edit-canvas.js`, `js/workspace-foundation.js`, `js/content/overlay-host.js`, and `js/content.js` — passed.
- `git diff --check` — passed.
- `node /Users/derekchen/Desktop/APStudyCanvas/.agents/skills/impeccable/scripts/detect.mjs --json html/popup.html css/popup.css js/edit-canvas.js js/workspace-foundation.js` — no findings (`[]`).

## Blockers
None. The requested Impeccable skill is available only from the saved checkout; its instructions were loaded from that read-only path. The approved brief pins direction and supersedes redundant interview/concept selection.

The approved phase explicitly reserves screenshot comparison and finish-review rounds for Integration. Foundation therefore records the visual contract but does not claim final visual verification.

## Downstream integration contract
- Register a feature implementation in the `routeModules()` map without changing shell navigation. Its `mount` receives the frozen shared context and route state; return lifecycle hooks from `mount` or define them on the module.
- Account-scoped storage must use `context.account.scope`; treat `null` as unverified and render a gated/unavailable state. `context.account.canvas.profile` is display data even when `canvas.verified` is false.
- Notes search owns local note matching. The shell routes `notes` search intent into the Notes module; do not send note text to Nest or Canvas.
- Settings preview ownership is enforced before feature mount through authenticated overlay control. Do not apply Canvas body transforms, clipping, observers, or shields from feature modules.
- The Study nav invokes the existing Canvas workspace through `legacy-route`; no Study storage or UI is copied into the shell.

## Next action
Integrate the Foundation commit, then dispatch feature workers against the documented route/module/account contracts. Reserve full suite/build and visual rounds for Integration as planned.
