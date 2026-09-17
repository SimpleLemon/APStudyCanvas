# APStudyCanvas design system

## Direction
APStudyCanvas is a calm operating surface around Canvas, not a replacement for Canvas itself. The persistent brand/search/navigation shell connects Settings, Grades, Planner, Notes, and the Study placeholder. Settings alone earns the split-view live preview because its controls visibly alter Canvas; task surfaces use the full content width.

The approved redesign sketch is the compositional authority. The existing Settings interior is the component and palette authority.

## Visual language
- Navy (`#0a0f22`, `#0d1328`, `#101730`) carries global chrome. Gold (`#D4AF37`) marks focus, selection, and affirmative state. White/parchment fields carry dense operating content.
- Newsreader is reserved for page and section headings. Public Sans is the interface workhorse. IBM Plex Mono is limited to measurements, key hints, and machine-readable values.
- Use crisp one-pixel separators and restrained offset shadows. Controls use 6px corners, content groups 12px, and major surfaces 16px. Pills are reserved for compact status or bounded controls.
- The shell must remain equally legible in explicit light, explicit dark, and Canvas-matched theme modes. Do not infer theme from product category.

## Shell and responsive behavior
- Header order: product brand, global Canvas/local Notes search, truthful notification state, fullscreen, close.
- Persistent route order: Settings, Grades, Planner, Notes, Study. Route selection is always keyboard visible and represented in URL state.
- Settings retains its category rail and saved controls. In an eligible Canvas overlay, the sharp live preview sits beside Settings while the underlying Canvas field is dimmed. At narrow widths the preview disappears before the Settings editor is squeezed.
- Grades, Planner, Notes, and Study mount into the full-width feature host. Study shows “Study” and “Coming soon.” without launching the legacy workspace or changing its records. Settings, Grades, and Study share identical outer panel bounds and 16px gutters.

- Account is the first row in the scrolling Settings rail, immediately above Overview. Its detail centers the actual avatar, name, and optional email, followed by Nest personal-information and connected-account links that open new tabs. Existing extension connection and gated calendar groups follow.
- Preview toolbar order is zoom out, percentage, zoom in, eye-icon page selector, and Reset. It wraps above the preview with at least 44px controls; measured toolbar height determines the preview cutout. Theme controls remain in Settings.

## Interaction contracts
- The outer overlay uses a theme-matched dim surface behind the opaque app panel. It never clones Canvas; the real Canvas page remains available only through the functional Settings preview. Preview controls and letterboxing follow the extension's resolved light/dark theme, with neutral grouped zoom controls and no toolbar theme switch.
- Motion uses a 220ms subtle panel entrance, 160ms exit, 150ms route/category reveal, 120ms ready-content reveal, and 200ms fullscreen feedback. Opening paints the lightweight shell before iframe startup; preview layout signals are coalesced rather than polled throughout the animation.
- Loading placeholders reserve layout immediately, pulse gently over 1.4 seconds only after 150ms while visible, and disappear immediately when data arrives. Reduced motion uses static placeholders and immediate state changes. Same-view refreshes retain valid account/query-matched content. Loading observers, animation handles, and timers are released on settlement or disposal; no prewarming, cached hidden feature trees, or new persistent data caches.
- Route chrome updates after the dirty guard, before destination data finishes loading. Shell mounts use `deferInitialLoad` to show loading states immediately; disposal invalidates pending reads so late responses cannot repaint another route.
- Embedded Settings keeps the same full-width iframe, compact header, tabs, and background as every other page. Its editor responds to its own container width, and the preview occupies the reserved right-hand area below the tabs. Navigation groups never shrink inside their scroll pane.
- Route changes query dirty state before history mutation. Declined transitions preserve route and focus. Escape closes search/popovers first, then returns feature routes to Settings, Settings detail to Overview, and finally closes the shell. Browser Back uses the same dirty guard.
- Every feature module implements `mount(context, route)`, optional `routeUpdate(route, context)`, `queryDirty()`, and `dispose(reason)`. Disposal is idempotent and releases DOM ownership, listeners, observers, timers, pending operations, and input shields.
- The module context exposes only verified account scope for persistence and mutations. Display profiles may be rendered but never treated as verified Canvas or Nest identity.
- Search may navigate to Canvas Search or Notes. Notes providers must return local, account-scoped results and pass the search query through route state; no remote transfer or fabricated matches.

## Honesty and accessibility
Never fabricate unread badges, account verification, calendar capability, grade history, or save success. Use explicit loading, unavailable, empty, dirty, and failed states. Keep 44px minimum interactive targets where space permits, strong visible focus, semantic navigation, live status announcements, reduced-motion support, and focus restoration across route changes.

## Implemented feature surfaces
Notes uses an adjacent list/editor with a narrow list-to-editor transition and explicit local save. Planner uses a shared horizontal week scroll so weekday headings align with hour cells. Grades uses the same class component in popup and native Canvas, with a native responsive container and Canvas theme tokens. Charts expose keyboard-focusable marks and equivalent data tables; SVG and mark coordinates share a normalized plot frame. Unverified Grades and Planner connections render explicit recovery states.
