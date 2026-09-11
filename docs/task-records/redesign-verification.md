# Final redesign verification

## Status
Pending integration of Grades UI and shared wiring. No redesign final broad checks or visual rounds have run.

## Single broad check batch
- `npm run test:extension` (record failures, distinguish pre-existing evidence from new failures).
- `npm run check:extension`.
- `npm run build:firefox`; review generated manifest/assets and diff.

## Batched visual acceptance
Settings overview and account/save/notifications preservation; Planner day/week/month; Notes list/editor; Grades overview and class Overview/Assignments/Graphs/What-if. Explicit light/dark at wide/narrow viewports. Verify full feature width, Settings-only preview release, no clipped controls, keyboard focus and equivalent chart table. One fix batch, then one confirmation round only.

## Focused interaction acceptance
- Notes legacy origin/numeric-ID storage, explicit save, dirty route/close/back cancellation, trash/restore, local search.
- Planner fail-closed identity/consent, immutable Canvas deadlines, personal event form alternatives and failed drafts, explicit import dedup across remount, source filtering, DST-safe civil days.
- Grades shared popup/native component, real read loading/failure, local credits/goals/scenarios, honest assignment timestamp chart labels, table/marks parity.
- Actual Canvas search entry, not Settings category; Study unchanged.

## Live Nest evidence
Existing Brave Canvas Dashboard found through CUA; visible To-Do sync status says Unavailable. This is not proof of final Planner connection state. After integration, inspect account controls and attempt isolated authorized create/read/update/delete only if existing verified access permits. Never report mocked operations as live success.
