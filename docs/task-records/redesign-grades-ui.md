# Redesign Grades UI

## Scope
Implement the approved Grades presentation as one reusable class-backed component for both the popup workspace and the native Canvas grades enhancement. Cover the overview, per-class navigation, guided honest chart presets, equivalent tables, and existing what-if scenarios without shared entrypoint or manifest edits.

## Base and ownership
- Base includes Foundation `d201888`, Grades domain `741a75f`, and Planner UI `ba9d454`.
- Owned files: `js/workspace-grades.js`, `css/workspace-grades.css`, `tests/extension/workspace-grades.test.js`, and this record.
- Shared shell wiring, `content.js`, manifests, and broad visual/build verification remain Integration-owned.

## Reusable contract
- Browser export: `globalThis.APStudyCanvasWorkspaceGradesUI`.
- `createGradesWorkspace(options)` returns a class-backed lifecycle with `mount(host, { mode, route })`, `routeUpdate(route)`, `queryDirty()`, and idempotent `dispose(reason)`.
- `createGradesModule(options)` wraps the same component for Foundation `mount(context, route)` use.
- Exact `createGradesWorkspace` options: `{ document, window, domain, analytics, adapter, preferenceStore?, getWorkspaceRecord, saveWorkspaceGrades?, getBounds, getScenario?, saveScenario?, navigateCanvas?, onDirtyChange? }`.
- `adapter.overview(signal)` returns the domain `{ account, courses }`; `adapter.course(courseId, signal)` returns `{ account, courseId, source }`; `dispose()` is called exactly once.
- `getWorkspaceRecord()` returns workspace-v1 `{ version, grades: { courses: { [courseId]: { credits?, goal?, whatIf?, included?, weight? } }, priorGpa?, priorCredits? } }`; `saveWorkspaceGrades(grades)` accepts that complete `grades` object and returns either the saved record or grades object. Without this callback, legacy grade settings render read-only.
- `getBounds()` returns the incumbent GPA cutoff map. `preferenceStore.load()/save(config)` uses the Grades domain preference contract.
- `getScenario(courseId)` and `saveScenario(courseId, scenario)` exchange GradeAnalytics v1 scenarios (`{ version: 1, assignments, groups, final, pinnedFinal }`). Without a scenario store, the native enhancement keeps the incumbent honest session-only scenario behavior and labels it temporary.
- `navigateCanvas(href)` receives only domain-generated same-origin course paths. `onDirtyChange(boolean)` synchronizes popup leave protection.
- Integrators inject the fixed Grades domain, GradeAnalytics helpers, and the seams above. Popup and native Canvas hosts share all rendering and interaction code.

## Planned units
- [x] Overview with current grades, GPA, credits, goals, and Canvas links.
- [x] Class breadcrumb and Overview / Assignments / Graphs / What-if views.
- [x] Guided course / metric / date range / chart type / comparison controls.
- [x] Honest line/point, histogram, and group-bar rendering with table, tooltips, and keyboard equivalence.
- [x] Focused lifecycle, state, compatibility, and CSS tests authored.
- [x] Exact verification, detector result, fix pass, final commit, and integration handoff.

## Constraints and next checks
No final-grade history inference, transcript import, AI analysis, arbitrary multi-series builder, Canvas grade mutations, Study/Settings edits, or shared wiring. Before implementation, inspect base ownership and domain exports. After each completed unit, update this record, inspect ownership diff, and run only the focused Grades UI checks at the final unit.

## Unit checkpoint: presentation
The shared renderer now covers the overview ledger and summary, class breadcrumb/tabs, Canvas links, assignment evidence table, guided graph builder, all three supported domain presets, exact point-to-row mapping, keyboard point traversal, focus tooltips, and local scenario/GPA-setting surfaces. Popup and Canvas modes differ only by a root modifier class. Base ownership check remains limited to the four owned new files. Next: focused lifecycle/state tests, syntax/diff checks, one Impeccable detector run, then commit.

## Mandatory usage checkpoint
Account-wide five-hour usage reached 93%, above the manager's 90% hard stop, immediately before the planned focused test run. Implementation and focused tests are authored in the four owned files, but no test command, syntax check after the final test edit, diff check, or Impeccable detector has run. This checkpoint therefore makes no passing claim and must not be integrated as complete.

Exact resume work:
1. Read this record and inspect only the four owned files against base ownership.
2. Run `node --test tests/extension/workspace-grades.test.js tests/extension/workspace-grades-domain.test.js` and fix only Grades UI regressions.
3. Run `node --check js/workspace-grades.js`, `git diff --check`, and once only `node /Users/derekchen/Desktop/APStudyCanvas/.agents/skills/impeccable/scripts/detect.mjs --json js/workspace-grades.js css/workspace-grades.css`.
4. Review the chart CSS positioning expression in `.workspace-grades-mark` for browser support; if needed, calculate a direct percentage custom property in JS.
5. Update exact results here, commit the completed bounded unit, and send commit/API/checks to the manager and integration worker. No broad suite, build, or visual round.

## Completion: focused verification and compatibility
- Ownership remained limited to `js/workspace-grades.js`, `css/workspace-grades.css`, `tests/extension/workspace-grades.test.js`, and this record.
- The first focused run exposed the Node harness's missing GPA dependency; the browser receives GPA from the existing content bundle. The focused test now injects that existing module before loading the domain.
- Replaced CSS Values Level 4 multiplication/division in chart marker positioning and bar sizing with direct percentage/pixel custom properties calculated in JS. Line points use their dataset-local index so current and scenario markers align with each series path.
- Focused command: `node --test tests/extension/workspace-grades.test.js tests/extension/workspace-grades-domain.test.js` — 17 passed, 0 failed.
- Syntax: `node --check js/workspace-grades.js` — passed.
- Diff: `git diff --check` — passed before this record update and again in the final ownership review.
- Impeccable detector, run exactly once after fixes: `[]`.
- No broad suite, build, visual round, shared entrypoint edit, push, or deployment was performed.
