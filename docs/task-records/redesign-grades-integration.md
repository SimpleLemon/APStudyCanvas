# Redesign Grades shared integration

## Scope and base

- Owner: bounded Grades shared integration worker.
- Base: `1e64c1d` (`docs: renew redesign manager after usage reset`).
- Owned shared files: popup/native entrypoints, manifests/content registration, focused shared wiring tests, and this durable record.
- Explicit exclusions: no edits to Grades UI/domain/CSS/tests, Planner, Notes, Settings interiors, Notifications, palette, Study, broad verification, generated Firefox output, backend, push, or deployment.
- Grades UI checkpoint `a48bfab` is read-only input. Integration consumes exactly `APStudyCanvasWorkspaceGradesUI.createGradesWorkspace` and `createGradesModule`.

## Required behavior

- The popup and native Canvas Grades page mount the same Grades component.
- Canvas reads stay behind the existing authenticated, bounded `grades-read` bridge and recheck the verified Canvas account after asynchronous reads.
- Legacy workspace-v1 records retain their origin plus numeric Canvas account-ID key and scenario compatibility; chart preferences use the separate Grades preference key.
- Settings/account/save/Notifications/palette and Study behavior remain unchanged.
- Errors remain explicit; stale or unverified account state must fail closed.

## Checkpoint 0: evidence loaded

- Read the redesign manager, plan, shared integration record, Grades domain record, PRODUCT, DESIGN, the Grades UI checkpoint record, and checkpoint JavaScript source.
- Loaded the absolute Impeccable skill, project context, new-work guidance, and craft floor. The approved direction and user instruction waive a new interview.
- Usage before implementation: 17% primary / 50% weekly. Mandatory pause remains above 90% primary.

## Next unit

Inspect the current popup module factory, native Grades lifecycle, manifest ordering, legacy workspace/scenario stores, and focused shared tests. Then add the popup/native Grades construction seams without changing feature-owned files.

## Unit 1 checkpoint: popup and registration plan

- Popup Grades will use `APStudyCanvasWorkspaceGradesUI.createGradesModule` with a dedicated feature host and fresh adapter per mount.
- The adapter will call only the existing authenticated `grades-read` overlay action and convert bridge failures into explicit user-facing errors.
- Workspace saves will transact through `APStudyCanvasContent.WorkspaceModel` with the existing `apstudycanvas.workspace.v1:<origin>:<numeric accountID>` key. Chart preferences remain under the domain-owned hashed-scope prefix. Assignment scenarios use a separate bounded v1 key scoped by the same legacy origin and numeric account ID.
- Popup assets will load GradeAnalytics, GPA, Grades domain, and Grades UI before `edit-canvas.js`. Canvas registration will load the same domain/UI after their dependencies and add the shared Grades stylesheet.

Next: implement and focused-test popup construction plus deterministic static/dynamic asset order before starting native lifecycle wiring.

## Unit 1 complete

- Registered the shared Grades stylesheet, GradeAnalytics, GPA, Grades domain, and Grades UI in deterministic popup and static/dynamic Canvas order. Updated the exact static CSS expectation without running the manager-owned static suite.
- Popup Grades now constructs `createGradesModule` with the authenticated `grades-read` bridge, verified-account read adapter, legacy workspace transaction, separate chart preferences, bounded scenario storage, current GPA bounds, same-origin Canvas navigation, and parent dirty-state signaling.
- Focused popup/registration wiring test: 4 passed, 0 failed. `node --check js/edit-canvas.js` and `git diff --check` passed before this record update.

Next: checkpoint this independent unit, import the completed Grades UI commits as separate dependencies, then wire the same component into the native Canvas Grades lifecycle.

## Mandatory usage checkpoint during native wiring

- Manager reported primary usage at 88%; no further implementation or verification units may start before reset.
- Popup/registration unit is safely committed as `73a0164` and already integrated by the manager as `b9828be`.
- Grades UI dependencies wered were imported separately as `fd7b81b` and `698a04e`; they must remain excluded from the integration commit report.
- Native shared-component wiring and three focused source-contract tests are present but unverified and uncommitted. No syntax, focused native test, diff, detector, static, broad suite, build, browser, visual, or live check has run after the native edit.
- Manager review found two popup follow-ups still required after reset: resolve GPA bounds from the actual popup settings state rather than the currently uncertain `state.popupSettings`, and make `getScenario` always return a Promise before the UI calls `.catch()`.
- Exact resume: inspect the current native diff, fix only those two popup seams, run `node --check js/content.js js/edit-canvas.js`, `node --test tests/extension/redesign-grades-integration.test.js tests/extension/workspace-grades.test.js tests/extension/workspace-grades-domain.test.js`, and `git diff --check`; then update this record and commit the bounded native/follow-up unit. Full/static/build/browser/visual checks remain manager-owned.

## Unit 2 checkpoint: native shared component

- Imported `a48bfab` and `aceefa9` as separate dependency commits (`fd7b81b`, `698a04e`). Their four Grades-owned files remain excluded from integration commits.
- Native `/grades` and numeric `/courses/:id/grades` routes will mount `APStudyCanvasWorkspaceGradesUI.createGradesWorkspace` into a dedicated owned child of Canvas `#content`/`#main`, leaving Canvas-owned children intact.
- Native construction will derive the same hashed verified account scope while retaining origin/numeric account ID for workspace and scenario storage, use direct bounded authenticated Canvas reads, and inject the same preference/workspace/scenario/bounds/navigation contracts as popup mode.
- Account, route, opt-out, safe-route, host replacement, and lifecycle teardown will dispose the shared component and abort its domain adapter. Legacy native implementations remain defined for compatibility but stop owning active rendering.

Next: implement native lifecycle wiring, add focused source/lifecycle assertions, and run the actual Grades UI/domain plus shared integration checks.

## Direct native completion
- Native wiring integrated into saved checkout. Added pre-mount generation/route/opt-out guard so a late account read cannot mount a stale host. Scenario readers now always return Promises.
- Popup bounds field verified against popup-controller.js; state.popupSettings.gpa_calc_bounds is correct.
- Combined focused checks26 passed; content/edit-canvas/Grades syntax and diff passed. Final broad/browser acceptance starts next.
