# Planner UI task record

- Owner: isolated Planner UI worker.
- Base: completed Foundation and `js/workspace-planner-adapter.js` already present in this worktree.
- Scope: only `js/workspace-planner.js`, `css/workspace-planner.css`, focused Planner UI tests, and this record.
- Reserved integration: shared wiring, manifests, adapter, router, backend, deployment, broad tests/builds, live Nest writes, and visual review remain manager-owned.
- Required lifecycle: injected adapter/context/host with `mount(context, route)`, `routeUpdate(route, context)`, `queryDirty()`, idempotent `dispose(reason)`, and `onDirtyChange` notifications.
- Required behavior: verified Nest/capability/consent gates; remembered Sunday week default, view, and date; day/week/month calendar views; source filters and details; explicit import; personal event create/edit/move/resize/delete; immutable Canvas due dates; retained failed drafts and honest permission/account failures.
- Explicit exclusions: auto-scheduling, five-day mode, recurrence, sharing, changes to Settings, and silent upload.
- Approved visual direction: established APStudyCanvas navy/gold/parchment system with Nest's compact calendar toolbar, filters, color semantics, and event-detail interaction used only as read-only reference.
- Initial evidence read: `PRODUCT.md`, `DESIGN.md`, redesign plan, Foundation record, Planner adapter record/implementation/tests, Notes lifecycle precedent, and Nest calendar template/view modules.
- Initial usage check: Codex primary window 48% used; mandatory stop threshold not approached.

## Units

- [x] Lifecycle, persistence, access gates, and honest async state.
- [x] Day, seven-column week, and seven-column month rendering.
- [x] Personal-event form operations, keyboard scheduling alternatives, details, filters, and explicit import.
- [x] Focused tests, syntax/diff checks, and one Impeccable detector run.

## Implemented units

- Lifecycle owns only the injected host and adapter, restores no fabricated state, emits dirty changes, and disposes subscriptions and pending adapter work idempotently.
- Account-scoped preferences remember Day/Week/Month and anchor date; Sunday is the Week default. Route intent overrides stored preference explicitly.
- Access states separate unverified identity, missing read capability/consent, and read-only write consent. Connect and consent are explicit injected actions.
- Day, Week, and Month share source filters and event details. Date-only all-day values remain civil dates rather than shifting through UTC.
- Canvas deadlines are always view-only. Personal operations call only adapter create/update/move/resize/delete, with form and 15-minute button alternatives to drag.
- Import opens a confirmation panel, preserves originals, and delegates durable deduplication to the injected adapter ledger.

## Exact checks

- `node --check js/workspace-planner.js` — passed.
- `node --test tests/extension/workspace-planner.test.js tests/extension/workspace-planner-adapter.test.js` — 16 passed, 0 failed.
- `git diff --check` — passed.
- `node /Users/derekchen/Desktop/APStudyCanvas/.agents/skills/impeccable/scripts/detect.mjs --json js/workspace-planner.js css/workspace-planner.css` — no findings (`[]`).
- No full suite, static check, build, screenshot/visual round, browser session, or live Nest write was run, as reserved for Integration.

## Precise integration contract

- Load `js/workspace-planner.js` after `js/workspace-planner-adapter.js`, load `css/workspace-planner.css`, and replace only the current Planner placeholder in the shared `routeModules()` map.
- Create a fresh adapter for each Planner mount with `send(type, payload)`, live `getAccount()`, the user timezone, and a durable account-scoped `importLedger`. The UI calls `adapter.dispose()` on module disposal, so a disposed adapter must not be reused on a later mount.
- Instantiate `createWorkspacePlanner({ adapter, host, preferences, onDirtyChange? })`. `host` must be the feature route host. `preferences` must expose async `get(key)` and either `set({ [key]: value })` or `set(key, value)`; keys are already namespaced by verified `context.account.scope`.
- Pass the frozen Foundation context to `mount(context, route)`. It must expose the live verified Canvas/Nest account used by the adapter, `account.scope`, `status(text, isError)`, and optionally `actions.connectNest()` plus `actions.reviewPlannerConsent()` (top-level aliases are also accepted).
- Route detail accepts `view=day|week|month`, `date=YYYY-MM-DD`, and optional `eventId`. The module returns `mount`, `routeUpdate`, synchronous `queryDirty`, and idempotent `dispose`; the shared host must continue honoring its existing dirty-leave guard.
- Call `adapter.refreshAccess()` through the normal route/context refresh whenever account, identity, capability, or consent changes. Do not promote display profile data into verified identity.
- Preserve adapter guarantees: Canvas deadlines remain immutable, imports are user-confirmed copies, and persistent deduplication depends on the injected ledger. Do not wire workspace-model v1 or derive the unresolved numeric Canvas account ID in this UI.

## Blockers and reserved work

No UI-module blocker. Shared wiring/manifests are intentionally untouched. Integration still owns script/style registration, adapter/context/action construction, generated-output parity, broad full test/build checks, visual review, and any real Nest roundtrip.
