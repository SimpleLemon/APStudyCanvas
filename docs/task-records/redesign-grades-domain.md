# Redesign Grades domain

## Scope
Implement the approved bounded Grades domain phase only: a verified-account Canvas read adapter, backwards-compatible overview/GPA projection, guided chart configuration and honest chart datasets, scenario compatibility, separate chart preferences, and focused domain tests. Do not change shared entrypoints, manifests, CSS, markup, or feature UI.

## Base and inputs
- Approved product/design inputs: `PRODUCT.md`, `DESIGN.md`, and `docs/task-records/redesign-plan.md`.
- Foundation contract: `docs/task-records/redesign-foundation.md`.
- Existing behavior sources: `js/content/grade-analytics.js`, `js/content/gpa.js`, and `js/content/workspace-model.js`.

## Owned files
- `js/workspace-grades-domain.js`
- `tests/extension/workspace-grades-domain.test.js`
- `docs/task-records/redesign-grades-domain.md`

## Planned units
- [x] Verified, injected, abortable Canvas grade read adapter with stale-account rejection.
- [x] Course overview projection preserving legacy credits/goals/what-if settings and incumbent GPA behavior.
- [x] Guided chart configuration validation for assignment scores over time, score histogram, and assignment-group bars.
- [x] Honest current/scenario datasets and accessible table data produced from the same points.
- [x] Separate account-scoped chart preference persistence without migrating or overwriting workspace records.
- [x] Focused risk tests and exact checks.
- [x] Integration contract and next action.

## Constraints
- Assignment timestamps may be plotted and must be labeled as assignment timestamps; no final-grade history may be inferred.
- No transcript import, AI analysis, arbitrary/general multi-series builder, backend change, or Canvas mutation.
- No shared wiring, broad suite/build, or visual review in this phase.

## Exact checks
- `node --test tests/extension/workspace-grades-domain.test.js tests/extension/grade-analytics.test.js tests/extension/gpa.test.js tests/extension/workspace-model.test.js` — 37 passed, 0 failed.
- `node --check js/workspace-grades-domain.js` — passed.
- `git diff --check` — passed.
- Broad extension suite, build, and visual checks intentionally remain reserved for Integration.

## Integration contract
- Load `js/workspace-grades-domain.js` after `js/content/grade-analytics.js` and `js/content/gpa.js`; the browser export is `globalThis.APStudyCanvasWorkspaceGradesDomain`. This phase does not register the script in a manifest or shared entrypoint.
- Create reads with `createGradeReadAdapter({ account: context.account, verifyAccount, readCourses, readCourseGradeData })`. `verifyAccount(signal)` must return the current Foundation account context. `readCourses(signal)` returns an array or `{ items, complete }`; `readCourseGradeData(courseId, signal)` returns complete `assignments` and `assignmentGroups` arrays or the same collection wrapper. Existing split assignment/group readers are also accepted as `readAssignments` plus `readAssignmentGroups`.
- Call `adapter.dispose()` from the Grades module lifecycle. It aborts pending reads; reads also reject unverified, switched, incomplete, oversized, malformed, or caller-aborted results with stable `GRADES_*` codes. No partial estimate should be rendered after these failures.
- Feed adapter overview courses plus the existing workspace-v1 `grades` object into `buildCourseOverview(courses, workspaceRecord, { bounds })`. It returns current Canvas grades, explicit official grades only when the input explicitly supplies `official_final_score`, saved credits/goals/class links, incumbent GPA results, and a separately labeled local what-if GPA when legacy `whatIf` values exist. It never migrates or writes the workspace record.
- Guide graph controls in the order course → `assignment-percentage` metric → date range → one of `scores-over-time`, `score-histogram`, or `assignment-group-bars` → current/scenario. Validate with `normalizeChartConfig`, then call `buildChartDataset(source, config, { scenario })`.
- Render chart marks and the equivalent table from the returned `datasets` and `table`; table rows carry `datasetId` and `pointKey` back to the exact chart point. The time preset uses `dueAt` only and explicitly labels it an assignment due timestamp, never final-grade history. A hypothetical final is therefore unsupported for that preset but remains available to compatible histogram/group scenarios through the incumbent analytics materializer.
- Only `current` and `scenario` comparisons are supported. Returned series label Canvas assignment data as `current` and local what-if data as `estimated`; no arbitrary multi-series builder is exposed.
- Persist only the guided chart controls through `createChartPreferenceStore({ storage, account: context.account, verifyAccount })`. Its `apstudycanvas.grades.chart-prefs.v1:*` key is intentionally separate from `apstudycanvas.workspace.v1:*`; continue using the incumbent workspace store for credits, goals, and existing what-if values.

## Next action
Implement the Grades UI against this contract, then register the domain/UI entrypoints and run broad extension/build/visual checks during Integration.
