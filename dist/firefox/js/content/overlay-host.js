(function (root, factory) {
    "use strict";
    const historyApi = root?.APStudyCanvasContent?.OverlayHistory
        || (typeof require === "function" ? require("./overlay-history.js") : null);
    const previewApi = root?.APStudyCanvasContent?.OverlayPreview
        || (typeof require === "function" ? require("./overlay-preview.js") : null);
    const contextApi = root?.APStudyCanvasContent?.ExtensionContext
        || (typeof require === "function" ? require("./context-guard.js") : null);
    const api = factory(historyApi, previewApi, contextApi);
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasContent = Object.assign(root.APStudyCanvasContent || {}, { OverlayHost: api });
}(typeof globalThis !== "undefined" ? globalThis : this, function (historyApi, previewApi, contextApi) {
    "use strict";

    const ROOT_ID = "apstudycanvas-overlay-root";
    const FRAME_PAGE = "html/popup.html";
    const FULLSCREEN_KEY = "platform.overlayFullscreen";
    const OPEN_DURATION = 340;
    const CLOSE_DURATION = 180;
    const REDUCED_DURATION = 120;
    const EASING = "cubic-bezier(.16, 1, .3, 1)";
    const FULL_VIEWPORT_INSET = Object.freeze({ block: 0, inline: 0 });
    // Kept as a zero-value compatibility alias for callers that still pass the
    // retired windowed option. Geometry is now owned by the viewport shell.
    const WINDOWED_INSET = FULL_VIEWPORT_INSET;
    const WINDOWED_RADIUS = 16;
    const CATEGORY_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;
    const PANEL_PADDING = previewApi?.PANEL_PADDING ?? 16;
    const PANEL_GAP_CSS = previewApi?.PANEL_GAP_CSS ?? "clamp(24px, 4vw, 64px)";
    const EDITOR_LEFT_INSET_CSS = previewApi?.EDITOR_LEFT_INSET_CSS
        ?? "clamp(0px, 3vw, 48px)";
    const PREVIEW_RADIUS = previewApi?.PREVIEW_RADIUS ?? WINDOWED_RADIUS;
    const PREVIEW_UTILITY_HEADER_HEIGHT = previewApi?.PREVIEW_UTILITY_HEADER_HEIGHT ?? 58;
    // Shared with the preview engine's `splitPreviewSlot`: the toolbar owns
    // grid row 1 of the preview column and the live viewport owns row 2.
    const PREVIEW_TOOLBAR_HEIGHT = previewApi?.PREVIEW_TOOLBAR_HEIGHT ?? 56;
    const PREVIEW_TOOLBAR_GAP = previewApi?.PREVIEW_TOOLBAR_GAP ?? 12;
    const PREVIEW_MIN_VIEWPORT_WIDTH = previewApi?.PREVIEW_MIN_VIEWPORT_WIDTH ?? 720;
    const CONTEXT_POLL_MS = 2000;
    const READY_TIMEOUT_MS = 8000;
    const DRAFT_QUERY_TIMEOUT_MS = 500;
    const DRAFT_QUERY_TYPE = "apstudycanvas-draft-query";
    const DRAFT_RESPONSE_TYPE = "apstudycanvas-draft-response";
    const DRAFT_RECOVERY_MESSAGE = "Workspace did not respond. Unsaved theme edits may be lost.";
    const DRAFT_RECOVERY_BUTTON = "Close anyway";
    const DRAFT_RECOVERY_CONFIRM = "Discard unsaved theme edits and close APStudyCanvas? This cannot be undone.";
    const OVERLAY_BRIDGE_REQUEST_TYPE = "apstudycanvas-overlay-control";
    const OVERLAY_BRIDGE_RESPONSE_TYPE = "apstudycanvas-overlay-control-response";
    const OVERLAY_SESSION_PATTERN = /^[A-Za-z0-9._~-]{1,128}$/;
    const OVERLAY_CONTROL_ACTIONS = new Set([
        "ready", "error", "retry", "draft-state", "close", "discard-close", "fullscreen",
        "navigate", "zoom", "preview", "focus"
    ]);

    // Two slots live in this shadow root: the settings iframe on the left and
    // a transparent preview viewport on the right. The scaled Canvas <body>
    // shows through a clip-path hole; the preview shield swallows clicks so
    // the live page stays inert. Colors are Nest navy from DESIGN.md.
const SHELL_CSS = `
:host {
    all: initial;
    position: fixed;
    inset: 0;
    width: 100vw;
    height: 100vh;
    z-index: 2147483647;
    display: block;
    overflow: hidden;
    box-sizing: border-box;
    container: overlay-shell / inline-size;
}
.overlay {
    position: fixed;
    inset: 0;
    z-index: 0;
    display: block;
    overflow: hidden;
    pointer-events: auto;
}
.overlay[hidden] { display: none; }
.backdrop {
    position: absolute;
    inset: 0;
    background: #0a0f22;
    opacity: 0;
    transition: opacity ${OPEN_DURATION}ms ${EASING};
    pointer-events: auto;
}
.panel {
    position: absolute;
    inset: 0;
    display: grid;
    grid-template-columns: minmax(clamp(520px, 52%, 760px), 52fr) minmax(0, 48fr);
    align-items: stretch;
    column-gap: ${PANEL_GAP_CSS};
    padding: ${PANEL_PADDING}px ${PANEL_PADDING}px ${PANEL_PADDING}px calc(${PANEL_PADDING}px + ${EDITOR_LEFT_INSET_CSS});
    overflow: hidden;
    border-radius: 0;
    box-shadow: none;
    opacity: 0;
    transform: scale(.12);
    transform-origin: var(--apsc-origin-x, 100%) var(--apsc-origin-y, 0%);
    transition: opacity ${OPEN_DURATION}ms ${EASING}, transform ${OPEN_DURATION}ms ${EASING};
    pointer-events: none;
}
.panel-fill {
    position: absolute;
    inset: 0;
    z-index: 0;
    pointer-events: none;
    background: #0a0f22;
    border-radius: inherit;
}
.stage,
.preview {
    position: relative;
    z-index: 1;
    min-width: 0;
    min-height: 0;
    pointer-events: auto;
}
.stage {
    overflow: hidden;
    border-radius: ${PREVIEW_RADIUS}px;
    background: #f7f6f3;
}
.frame-state {
    position: absolute;
    inset: 0;
    z-index: 2;
    display: grid;
    align-content: center;
    justify-items: start;
    gap: 10px;
    box-sizing: border-box;
    padding: clamp(24px, 6vw, 56px);
    background: #f7f6f3;
    color: #1f1f1e;
    font-family: "Public Sans", system-ui, sans-serif;
    line-height: 1.5;
}
.frame-state[hidden] { display: none; }
.frame-state-title {
    margin: 0;
    color: #1f1f1e;
    font-size: 18px;
    font-weight: 700;
}
.frame-state-message {
    max-width: 48ch;
    margin: 0;
    color: #4b4a47;
    font-size: 14px;
}
.frame-state[data-kind="error"] .frame-state-title { color: #b3261e; }
.frame-state-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 4px;
}
.frame-state-actions button,
.frame-state-actions a {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 44px;
    box-sizing: border-box;
    border: 1px solid #0a0f22;
    border-radius: 6px;
    padding: 0 14px;
    background: #0a0f22;
    color: #ffffff;
    font: inherit;
    font-weight: 700;
    text-decoration: none;
    cursor: pointer;
}
.frame-state-actions a {
    background: transparent;
    color: #0a0f22;
}
.frame-state-actions button:hover,
.frame-state-actions a:hover { border-color: #D4AF37; }
.frame-state-actions button:focus-visible,
.frame-state-actions a:focus-visible {
    outline: 2px solid #D4AF37;
    outline-offset: 2px;
}
/* Host-owned recovery surface for a workspace that stopped answering the
   close-time draft check. It renders above the frame-state layer and never
   depends on the iframe being alive. */
.draft-recovery {
    position: absolute;
    inset: 0;
    z-index: 3;
    display: grid;
    align-content: center;
    justify-items: start;
    gap: 10px;
    box-sizing: border-box;
    padding: clamp(24px, 6vw, 56px);
    background: #f7f6f3;
    color: #1f1f1e;
    font-family: "Public Sans", system-ui, sans-serif;
    line-height: 1.5;
}
.draft-recovery[hidden] { display: none; }
.draft-recovery-message {
    max-width: 48ch;
    margin: 0;
    color: #1f1f1e;
    font-size: 14px;
    font-weight: 700;
}
.draft-recovery-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 4px;
}
.draft-recovery-actions button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 44px;
    box-sizing: border-box;
    border: 1px solid #0a0f22;
    border-radius: 6px;
    padding: 0 14px;
    background: #0a0f22;
    color: #ffffff;
    font: inherit;
    font-weight: 700;
    cursor: pointer;
}
.draft-recovery-actions button:hover { border-color: #D4AF37; }
.draft-recovery-actions button:focus-visible {
    outline: 2px solid #D4AF37;
    outline-offset: 2px;
}
.overlay[data-preview="off"] .panel {
    grid-template-columns: minmax(0, 1fr);
    column-gap: 0;
    padding-left: ${PANEL_PADDING}px;
}
.overlay[data-preview="off"] .preview { display: none; }
@container overlay-shell (max-width: ${PREVIEW_MIN_VIEWPORT_WIDTH - 0.02}px) {
    .panel {
        grid-template-columns: minmax(0, 1fr);
        column-gap: 0;
        padding-left: ${PANEL_PADDING}px;
    }
    .preview { display: none; }
}
.overlay[data-state="open"] .backdrop { opacity: 1; }
.overlay[data-state="open"] .panel { opacity: 1; transform: scale(1); }
.overlay[data-state="closing"] .backdrop,
.overlay[data-state="closing"] .panel { transition-duration: ${CLOSE_DURATION}ms; }
.frame {
    display: block;
    width: 100%;
    height: 100%;
    border: 0;
    background: transparent;
}
.frame[aria-hidden="true"] { visibility: hidden; }
.preview {
    display: grid;
    grid-template-rows: minmax(${PREVIEW_TOOLBAR_HEIGHT}px, max-content) 1fr;
    gap: ${PREVIEW_TOOLBAR_GAP}px;
    margin-top: ${PREVIEW_UTILITY_HEADER_HEIGHT}px;
    background: transparent;
}
.preview-viewport {
    position: relative;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    border-radius: ${PREVIEW_RADIUS}px;
    background: transparent;
}
.preview-shield {
    position: absolute;
    inset: 0;
    z-index: 1;
    border-radius: inherit;
    pointer-events: auto;
}
.preview-toolbar {
    position: relative;
    z-index: 2;
    display: flex;
    flex-wrap: wrap;
    align-content: center;
    align-items: center;
    gap: 6px;
    min-width: 0;
    min-height: ${PREVIEW_TOOLBAR_HEIGHT}px;
    height: auto;
    box-sizing: border-box;
    padding: 2px 8px;
    border-radius: 12px;
    background: #0d1328;
    color: #d6ddf0;
    font-family: "Public Sans", system-ui, sans-serif;
    font-size: 12px;
    pointer-events: auto;
}
.preview-toolbar-divider {
    flex: 0 0 auto;
    width: 1px;
    height: 24px;
    background: color-mix(in srgb, #0a0f22 45%, #a0a8c4);
}
.preview-toolbar-end {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    flex: 1 1 12rem;
    flex-wrap: wrap;
    justify-content: flex-end;
    margin-left: auto;
}
.preview-page-label {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    flex: 1 1 12rem;
    color: #a0a8c4;
}
.preview-page-glyph {
    flex: 0 0 auto;
    font-size: 13px;
    line-height: 1;
    color: #a0a8c4;
}
.preview-page-text {
    flex: 0 0 auto;
    white-space: nowrap;
}
.preview-toolbar select,
.preview-toolbar button {
    border: 1px solid color-mix(in srgb, #0a0f22 58%, #d6ddf0);
    border-radius: 6px;
    padding: 0 12px;
    background: #0d1328;
    color: #d6ddf0;
    font: inherit;
    cursor: pointer;
}
.preview-toolbar button {
    flex: 0 0 auto;
    min-height: 48px;
    min-width: 48px;
}
.preview-toolbar select {
    min-height: 40px;
    min-width: min(10em, 100%);
    max-width: 100%;
    flex: 1 1 10em;
}
.preview-toolbar button:hover,
.preview-toolbar select:hover {
    border-color: #D4AF37;
    background: #101730;
}
.preview-toolbar button:focus-visible,
.preview-toolbar select:focus-visible {
    outline: 2px solid #D4AF37;
    outline-offset: 2px;
}
.preview-zoom-value {
    flex: 0 0 auto;
    min-width: 4ch;
    color: #d6ddf0;
    font-family: "IBM Plex Mono", ui-monospace, monospace;
    font-size: 11px;
    font-weight: 500;
    text-align: center;
}
.preview-theme-switch {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-height: 48px;
    padding: 0 14px;
    border: 1px solid color-mix(in srgb, #0a0f22 58%, #d6ddf0);
    border-radius: 999px;
    background: #0d1328;
    color: #d6ddf0;
    font: inherit;
    white-space: nowrap;
    cursor: pointer;
}
.preview-theme-switch-track {
    position: relative;
    flex: 0 0 auto;
    width: 36px;
    height: 20px;
    border: 1px solid color-mix(in srgb, #0a0f22 55%, #a0a8c4);
    border-radius: 999px;
    background: #101730;
    transition: background-color 160ms ${EASING}, border-color 160ms ${EASING};
}
.preview-theme-switch-track::after {
    content: "";
    position: absolute;
    top: 2px;
    left: 2px;
    width: 14px;
    height: 14px;
    border-radius: 999px;
    background: #a0a8c4;
    transition: transform 160ms ${EASING}, background-color 160ms ${EASING};
}
.preview-theme-switch[aria-checked="true"] .preview-theme-switch-track {
    border-color: #D4AF37;
    background: color-mix(in srgb, #D4AF37 32%, #0d1328);
}
.preview-theme-switch[aria-checked="true"] .preview-theme-switch-track::after {
    background: #D4AF37;
    transform: translateX(16px);
}
.preview-theme-switch:hover {
    border-color: #D4AF37;
    background: #101730;
}
.preview-theme-switch:focus-visible {
    outline: 2px solid #D4AF37;
    outline-offset: 2px;
}
.overlay[data-reduced-motion="true"] .preview-theme-switch-track,
.overlay[data-reduced-motion="true"] .preview-theme-switch-track::after {
    transition: none;
}
.overlay[data-reduced-motion="true"] .backdrop,
.overlay[data-reduced-motion="true"] .panel {
    transition-property: opacity;
    transition-duration: ${REDUCED_DURATION}ms;
    transform: none;
}
.overlay[data-reduced-motion="true"] .backdrop {
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
}
`;

    function fontFaceCss(chromeApi) {
        const urlFor = (file) => {
            try { return chromeApi?.runtime?.getURL?.(`font/${file}`) || ""; } catch (error) { return ""; }
        };
        const sans = urlFor("public-sans-latin.woff2");
        const mono = urlFor("ibm-plex-mono-latin-400.woff2");
        const monoMedium = urlFor("ibm-plex-mono-latin-500.woff2");
        if (!sans && !mono) return "";
        return `
@font-face {
    font-family: "Public Sans";
    src: url("${sans}") format("woff2");
    font-weight: 400;
    font-style: normal;
    font-display: swap;
}
@font-face {
    font-family: "IBM Plex Mono";
    src: url("${mono}") format("woff2");
    font-weight: 400;
    font-style: normal;
    font-display: swap;
}
@font-face {
    font-family: "IBM Plex Mono";
    src: url("${monoMedium}") format("woff2");
    font-weight: 500;
    font-style: normal;
    font-display: swap;
}
`;
    }

    function safeCategory(value) {
        return typeof value === "string" && CATEGORY_PATTERN.test(value) ? value : null;
    }

    function createOverlaySessionToken(cryptoApi = globalThis?.crypto) {
        if (typeof cryptoApi?.randomUUID === "function") {
            try {
                const uuid = cryptoApi.randomUUID();
                if (/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid)) {
                    return `overlay-${uuid}`;
                }
            } catch (error) {}
        }
        if (typeof cryptoApi?.getRandomValues === "function") {
            try {
                const bytes = new Uint8Array(24);
                cryptoApi.getRandomValues(bytes);
                return `overlay-${Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")}`;
            } catch (error) {}
        }
        const error = new Error("OVERLAY_SESSION_ENTROPY_UNAVAILABLE");
        error.code = "OVERLAY_SESSION_ENTROPY_UNAVAILABLE";
        throw error;
    }

    function safeParentOrigin(value) {
        try {
            const url = new URL(value);
            return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password
                ? url.origin
                : null;
        } catch (error) {
            return null;
        }
    }

    function frameUrl(chromeApi, { tabId, category, overlaySession, parentOrigin } = {}) {
        const base = chromeApi?.runtime?.getURL?.(FRAME_PAGE) || FRAME_PAGE;
        const query = ["embedded=1"];
        if (Number.isInteger(tabId) && tabId > 0) query.push(`sourceCanvasTabId=${tabId}`);
        const selected = safeCategory(category);
        if (selected) query.push(`category=${selected}`);
        if (typeof overlaySession === "string" && OVERLAY_SESSION_PATTERN.test(overlaySession)) {
            query.push(`overlaySession=${encodeURIComponent(overlaySession)}`);
        }
        const trustedParentOrigin = safeParentOrigin(parentOrigin);
        if (trustedParentOrigin) query.push(`overlayParentOrigin=${encodeURIComponent(trustedParentOrigin)}`);
        // A URL hash would fail the router's exact-page check for Canvas sync
        // and Nest consent, so state always travels in the query string.
        return `${base}?${query.join("&")}`;
    }

    // Host-page mutations are recorded with their inverse so closing the
    // overlay restores the page exactly as it was found.
    function createRestoreLedger() {
        const entries = [];
        return {
            record(undo) { if (typeof undo === "function") entries.push(undo); },
            setStyle(node, property, value) {
                if (!node?.style) return;
                const previous = node.style.getPropertyValue(property);
                const priority = node.style.getPropertyPriority?.(property) || "";
                entries.push(() => {
                    if (previous) node.style.setProperty(property, previous, priority);
                    else node.style.removeProperty(property);
                });
                node.style.setProperty(property, value);
            },
            get size() { return entries.length; },
            restore() {
                while (entries.length) {
                    const undo = entries.pop();
                    try { undo(); } catch (error) {}
                }
            }
        };
    }

    function createOverlayHost({ documentRef, windowRef, chromeApi, onControl, overlayHistory, storageApi, previewEnabled: previewOptIn, themeToggle, readyTimeoutMs = READY_TIMEOUT_MS, draftQueryTimeoutMs = DRAFT_QUERY_TIMEOUT_MS, draftStateResolver, sessionTokenFactory } = {}) {
        const doc = documentRef || (typeof document !== "undefined" ? document : null);
        const win = windowRef || (typeof window !== "undefined" ? window : null);
        const api = chromeApi || (typeof chrome !== "undefined" ? chrome : null);
        if (!doc) return null;
        const localStorageApi = storageApi || api?.storage?.local || null;
        const historyModule = overlayHistory === undefined ? historyApi : overlayHistory;
        const previewModule = previewApi;

        let overlay = null;
        let panel = null;
        let panelFill = null;
        let backdrop = null;
        let stage = null;
        let frame = null;
        let frameState = null;
        let frameStateTitle = null;
        let frameStateMessage = null;
        let frameStateActions = null;
        let retryButton = null;
        let workspaceLink = null;
        let draftRecovery = null;
        let draftRecoveryClose = null;
        let draftRecoveryShown = false;
        let preview = null;
        let previewViewport = null;
        let previewShield = null;
        let previewToolbar = null;
        let previewToolbarEnd = null;
        let pageSelect = null;
        let zoomValue = null;
        let zoomOut = null;
        let zoomIn = null;
        let zoomReset = null;
        let themeSwitch = null;
        let container = null;
        let shadowRoot = null;
        let ledger = null;
        let closeTimer = null;
        let closeRequest = null;
        let closeGeneration = 0;
        let readyTimer = null;
        let readinessState = "closed";
        let overlaySession = null;
        // Each iframe navigation is an independent capability attempt. The
        // session is the authority used by messages; this generation also
        // makes a cancelled timeout incapable of changing a newer attempt.
        let frameAttempt = 0;
        let lastDraftSequence = 0;
        let frameIdentity = null;
        let currentCategory = null;
        let fullscreen = true;
        let fullscreenPreference = true;
        let preferenceLoaded = false;
        let previousFocus = null;
        let historyController = null;
        let previewEngine = null;
        let previewEnabled = previewOptIn !== false;
        let themeDraft = false;
        let lastTabId = null;
        let lastOpen = Object.freeze({ cold: false, frameReused: false, reopened: false });
        let draftQuerySequence = 0;
        const pendingDraftQueries = new Map();
        const listeners = [];

        function prefersReducedMotion() {
            try { return win?.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true; } catch (error) { return false; }
        }

        function storageGet(key) {
            if (!localStorageApi?.get) return Promise.resolve(undefined);
            try {
                const result = localStorageApi.get(key);
                if (result && typeof result.then === "function") {
                    return result.then((data) => data?.[key]).catch(() => undefined);
                }
                return new Promise((resolve) => {
                    localStorageApi.get(key, (data) => resolve(data?.[key]));
                });
            } catch (error) {
                return Promise.resolve(undefined);
            }
        }

        function storageSet(key, value) {
            if (!localStorageApi?.set) return;
            try {
                const result = localStorageApi.set({ [key]: value });
                if (result && typeof result.then === "function") result.catch(() => {});
            } catch (error) {}
        }

        const preferencePromise = storageGet(FULLSCREEN_KEY).then((value) => {
            // Full-page is now the default shell geometry. An explicitly
            // persisted false remains readable for the compact control's
            // compatibility state, but it never reintroduces a windowed panel.
            fullscreenPreference = value === undefined ? true : value === true;
            preferenceLoaded = true;
            return fullscreenPreference;
        });

        historyController = historyModule?.createOverlayHistory?.({
            windowRef: win,
            onClose: () => close("popstate")
        }) || null;

        function on(target, type, handler, options) {
            if (!target?.addEventListener) return;
            target.addEventListener(type, handler, options);
            listeners.push(() => target.removeEventListener(type, handler, options));
        }

        function extensionOrigin() {
            try {
                const url = new URL(api?.runtime?.getURL?.("/") || "");
                return `${url.protocol}//${url.host}`;
            } catch (error) { return ""; }
        }

        function settleDraftQuery(requestId, result) {
            const pending = pendingDraftQueries.get(requestId);
            if (!pending) return;
            pendingDraftQueries.delete(requestId);
            clearTimeout(pending.timer);
            pending.resolve(result);
        }

        function cancelDraftQueries(code = "OVERLAY_DRAFT_STATE_UNAVAILABLE") {
            for (const requestId of [...pendingDraftQueries.keys()]) {
                settleDraftQuery(requestId, { ok: false, code });
            }
        }

        function handleDraftResponse(event) {
            const data = event?.data;
            if (!data || data.type !== DRAFT_RESPONSE_TYPE || typeof data.requestId !== "string") return;
            const pending = pendingDraftQueries.get(data.requestId);
            if (!pending
                || event.source !== pending.source
                || event.origin !== pending.origin
                || data.overlaySession !== pending.overlaySession
                || typeof data.draft !== "boolean") return;
            settleDraftQuery(data.requestId, { ok: true, draft: data.draft });
        }

        // Every embedded control center can use this authenticated parent
        // channel. It avoids depending on Chromium's transient sender-frame
        // metadata while a replacement iframe is registering after an
        // extension reload. The host still binds the exact extension origin,
        // current iframe window, and active session before dispatching.
        function handleOverlayBridgeMessage(event) {
            const data = event?.data;
            const origin = extensionOrigin();
            if (!data
                || data.type !== OVERLAY_BRIDGE_REQUEST_TYPE
                || !event.source
                || event.source !== frame?.contentWindow
                || !origin
                || event.origin !== origin
                || !isOpen()
                || typeof data.requestId !== "string"
                || data.requestId.length < 1
                || data.requestId.length > 160
                || data.overlaySession !== overlaySession
                || typeof data.action !== "string") return;
            const input = data.payload && typeof data.payload === "object" && !Array.isArray(data.payload) ? data.payload : {};
            const result = handleControl(data.action, { ...input, overlaySession });
            Promise.resolve(result).then((payload) => {
                try {
                    event.source.postMessage({
                        type: OVERLAY_BRIDGE_RESPONSE_TYPE,
                        requestId: data.requestId,
                        overlaySession,
                        payload
                    }, origin);
                } catch (error) {}
            }).catch(() => {
                try {
                    event.source.postMessage({
                        type: OVERLAY_BRIDGE_RESPONSE_TYPE,
                        requestId: data.requestId,
                        overlaySession,
                        payload: { ok: false, state: readinessState, code: "OVERLAY_CONTROL_FAILED" }
                    }, origin);
                } catch (error) {}
            });
        }

        async function resolveAuthoritativeDraftState(session) {
            if (typeof draftStateResolver === "function") {
                try {
                    const result = await draftStateResolver({
                        overlaySession: session,
                        frame,
                        cachedDraft: themeDraft,
                        sequence: lastDraftSequence
                    });
                    return result?.ok === false || typeof result?.draft !== "boolean"
                        ? { ok: false, code: result?.code || "OVERLAY_DRAFT_STATE_UNAVAILABLE" }
                        : { ok: true, draft: result.draft };
                } catch (error) {
                    return { ok: false, code: "OVERLAY_DRAFT_STATE_UNAVAILABLE" };
                }
            }

            const source = frame?.contentWindow;
            const origin = extensionOrigin();
            if (!source?.postMessage || !origin || !session) {
                return { ok: false, code: "OVERLAY_DRAFT_STATE_UNAVAILABLE" };
            }
            const requestId = `${session}:${++draftQuerySequence}`;
            return new Promise((resolve) => {
                const timer = setTimeout(() => {
                    settleDraftQuery(requestId, { ok: false, code: "OVERLAY_DRAFT_STATE_UNAVAILABLE" });
                }, Math.max(0, Number(draftQueryTimeoutMs) || DRAFT_QUERY_TIMEOUT_MS));
                pendingDraftQueries.set(requestId, { resolve, timer, source, origin, overlaySession: session });
                try {
                    source.postMessage({ type: DRAFT_QUERY_TYPE, overlaySession: session, requestId }, origin);
                } catch (error) {
                    settleDraftQuery(requestId, { ok: false, code: "OVERLAY_DRAFT_STATE_UNAVAILABLE" });
                }
            });
        }

        function makeControl(tagName, className, attrs) {
            const node = doc.createElement(tagName);
            if (className) node.className = className;
            if (attrs) {
                for (const [name, value] of Object.entries(attrs)) {
                    if (name === "text") node.textContent = value;
                    else node.setAttribute(name, value);
                }
            }
            return node;
        }

        // The Theming switch is injected, not assumed: the settings shell owns
        // the theme draft, so the host only renders the control when a caller
        // supplies { label, pressed, onToggle }.
        function mountThemeSwitch() {
            if (!themeToggle || typeof themeToggle !== "object") return null;
            const label = typeof themeToggle.label === "string" && themeToggle.label ? themeToggle.label : "Theming";
            const button = makeControl("button", "preview-theme-switch", {
                type: "button",
                role: "switch",
                "aria-checked": themeToggle.pressed === true ? "true" : "false"
            });
            button.appendChild(makeControl("span", "preview-theme-switch-label", { text: label }));
            button.appendChild(makeControl("span", "preview-theme-switch-track", { "aria-hidden": "true" }));
            on(button, "click", () => {
                const next = button.getAttribute("aria-checked") !== "true";
                button.setAttribute("aria-checked", next ? "true" : "false");
                try { themeToggle.onToggle?.(next); } catch (error) {}
            });
            return button;
        }

        function mountPreviewChrome() {
            preview = makeControl("div", "preview", { "data-preview-slot": "canvas", "aria-label": "Canvas preview" });
            previewToolbar = makeControl("div", "preview-toolbar", { role: "toolbar", "aria-label": "Canvas preview" });
            // Row 2 is the only surface the engine letterboxes into, and the
            // only one that clips: the toolbar sits outside the rounded hole.
            previewViewport = makeControl("div", "preview-viewport", { "data-preview-slot": "viewport" });
            previewShield = makeControl("div", "preview-shield", { "aria-hidden": "true", tabindex: "-1" });

            const pageLabel = makeControl("label", "preview-page-label");
            pageLabel.appendChild(makeControl("span", "preview-page-glyph", { "aria-hidden": "true", text: "◉" }));
            pageLabel.appendChild(makeControl("span", "preview-page-text", { text: "Canvas:" }));
            pageSelect = makeControl("select", "preview-page", { "aria-label": "Canvas page" });
            const destinations = previewModule?.DESTINATIONS || [];
            for (const dest of destinations) {
                const option = makeControl("option", "", { value: dest.id, text: dest.label });
                option.value = dest.id;
                pageSelect.appendChild(option);
            }
            pageLabel.appendChild(pageSelect);

            const zoomOutBtn = makeControl("button", "preview-zoom-out", { type: "button", "aria-label": "Zoom out", text: "−" });
            zoomValue = makeControl("span", "preview-zoom-value", { "aria-live": "polite", text: "100%" });
            const zoomInBtn = makeControl("button", "preview-zoom-in", { type: "button", "aria-label": "Zoom in", text: "+" });
            const zoomResetBtn = makeControl("button", "preview-zoom-reset", { type: "button", "aria-label": "Reset preview zoom", text: "↺ Reset" });
            zoomOut = zoomOutBtn;
            zoomIn = zoomInBtn;
            zoomReset = zoomResetBtn;

            previewToolbarEnd = makeControl("div", "preview-toolbar-end");
            themeSwitch = mountThemeSwitch();
            if (themeSwitch) previewToolbarEnd.appendChild(themeSwitch);

            previewToolbar.appendChild(zoomOutBtn);
            previewToolbar.appendChild(zoomValue);
            previewToolbar.appendChild(zoomInBtn);
            previewToolbar.appendChild(makeControl("span", "preview-toolbar-divider", { "aria-hidden": "true" }));
            previewToolbar.appendChild(pageLabel);
            previewToolbar.appendChild(zoomResetBtn);
            previewToolbar.appendChild(previewToolbarEnd);
            previewViewport.appendChild(previewShield);
            preview.appendChild(previewToolbar);
            preview.appendChild(previewViewport);

            on(pageSelect, "change", () => {
                navigatePreview({ destination: pageSelect.value });
            });
            on(zoomOutBtn, "click", () => setPreviewZoom({ step: -1 }));
            on(zoomInBtn, "click", () => setPreviewZoom({ step: 1 }));
            on(zoomResetBtn, "click", () => setPreviewZoom({ reset: true }));
        }

        function clearReadyTimer() {
            if (readyTimer === null) return;
            const cancel = typeof win?.clearTimeout === "function"
                ? win.clearTimeout.bind(win)
                : (typeof clearTimeout === "function" ? clearTimeout : null);
            try { cancel?.(readyTimer); } catch (error) {}
            readyTimer = null;
        }

        function nextOverlaySession() {
            const token = typeof sessionTokenFactory === "function"
                ? sessionTokenFactory()
                : createOverlaySessionToken(win?.crypto || globalThis?.crypto);
            if (typeof token !== "string" || !OVERLAY_SESSION_PATTERN.test(token)) {
                const error = new Error("OVERLAY_SESSION_INVALID");
                error.code = "OVERLAY_SESSION_INVALID";
                throw error;
            }
            return token;
        }

        function workspaceTabUrl() {
            const base = api?.runtime?.getURL?.(`${FRAME_PAGE}?view=workspace`) || `${FRAME_PAGE}?view=workspace`;
            try {
                const url = new URL(base, api?.runtime?.getURL?.("/") || "https://extension.invalid/");
                if (currentCategory) url.searchParams.set("category", currentCategory);
                return url.href;
            } catch (error) {
                return base;
            }
        }

        function setFrameInteractive(ready) {
            if (!frame) return;
            frame.setAttribute("tabindex", ready ? "0" : "-1");
            if (ready) frame.removeAttribute("aria-hidden");
            else frame.setAttribute("aria-hidden", "true");
        }

        // The shadow host itself is a fixed, full-viewport element. Keep it
        // out of hit testing whenever the overlay is not actively open; the
        // hidden overlay cannot otherwise stop its host from swallowing page
        // clicks after a close.
        function setContainerInteractive(value) {
            container?.style?.setProperty?.("pointer-events", value ? "auto" : "none");
        }

        function createFrame() {
            const next = doc.createElement("iframe");
            next.className = "frame";
            next.setAttribute("title", "APStudyCanvas settings");
            next.setAttribute("tabindex", "-1");
            next.setAttribute("aria-hidden", "true");
            return next;
        }

        // Removing src leaves the extension document suspended in its browsing
        // context. Always navigate a retired capability away first, even when
        // a concurrent DOM change has already detached its iframe from stage.
        function revokeFrame(target = frame) {
            try { target?.setAttribute?.("src", "about:blank"); } catch (error) {}
        }

        // Replacing rather than retargeting a failed iframe cancels its
        // renderer, document lifecycle, and any stuck extension handshake.
        // Revoke and detach the old document before its replacement is added;
        // Chromium otherwise briefly has two extension iframe registrations
        // and can route the next startup through the retired one.
        function replaceFrame() {
            const previous = frame;
            const next = createFrame();
            revokeFrame(previous);
            if (previous?.parentNode === stage) {
                previous.remove?.();
                if (frameState && typeof stage?.insertBefore === "function") stage.insertBefore(next, frameState);
                else stage?.appendChild?.(next);
            } else {
                previous?.remove?.();
                stage?.appendChild?.(next);
            }
            frame = next;
            return frame;
        }

        function showFrameState(kind, message) {
            readinessState = kind;
            setFrameInteractive(false);
            if (!frameState) return;
            const failed = kind === "error";
            frameState.hidden = false;
            frameState.setAttribute("data-kind", failed ? "error" : "loading");
            frameState.setAttribute("role", failed ? "alert" : "status");
            frameStateTitle.textContent = failed ? "Workspace unavailable" : "Loading APStudyCanvas";
            frameStateMessage.textContent = message || (failed
                ? "The embedded workspace did not finish loading. Try again or open it in a new tab."
                : "Preparing your Canvas settings…");
            frameStateActions.hidden = !failed;
            workspaceLink?.setAttribute?.("href", workspaceTabUrl());
        }

        function showReady() {
            clearReadyTimer();
            readinessState = "ready";
            hideDraftRecovery();
            if (frameState) frameState.hidden = true;
            setFrameInteractive(true);
            if (isOpen()) frame?.focus?.();
        }

        function showFrameError(message) {
            clearReadyTimer();
            showFrameState("error", message);
            if (isOpen()) retryButton?.focus?.();
        }

        // The recovery surface is host-owned and shown once per session: the
        // first authoritative draft-state answer that never arrives (the 500ms
        // unavailable result) proves close-time protection cannot be verified.
        function showDraftRecovery() {
            if (!draftRecovery || draftRecoveryShown) return;
            draftRecoveryShown = true;
            draftRecovery.hidden = false;
            draftRecoveryClose?.focus?.();
        }

        function hideDraftRecovery() {
            if (!draftRecovery) return;
            draftRecovery.hidden = true;
        }

        // Clicking "Close anyway" demands its own confirmation before the
        // commit; denial keeps the overlay open with focus back on the action.
        function handleDraftRecoveryClose() {
            if (!draftRecovery || draftRecovery.hidden || !isOpen()) return;
            let confirmed = false;
            try {
                confirmed = typeof win?.confirm === "function"
                    && win.confirm(DRAFT_RECOVERY_CONFIRM) === true;
            } catch (error) {}
            if (!confirmed) {
                draftRecoveryClose?.focus?.();
                return;
            }
            hideDraftRecovery();
            commitClose("draft-recovery");
        }

        function scheduleReadyTimeout(session, attempt) {
            clearReadyTimer();
            const schedule = typeof win?.setTimeout === "function"
                ? win.setTimeout.bind(win)
                : (typeof setTimeout === "function" ? setTimeout : null);
            if (!schedule) {
                showFrameError("APStudyCanvas could not start its loading check. Try again or open the workspace in a new tab.");
                return false;
            }
            const duration = Number.isFinite(readyTimeoutMs) && readyTimeoutMs > 0 ? readyTimeoutMs : READY_TIMEOUT_MS;
            readyTimer = schedule(() => {
                readyTimer = null;
                if (!isOpen()
                    || readinessState !== "loading"
                    || overlaySession !== session
                    || frameAttempt !== attempt) return;
                showFrameError("APStudyCanvas took too long to load. Try again or open the workspace in a new tab.");
            }, duration);
            if (typeof readyTimer?.unref === "function") readyTimer.unref();
            return true;
        }

        function reloadFrame(session) {
            if (!frame) return { ok: false, code: "OVERLAY_FRAME_UNAVAILABLE" };
            let nextSession = session;
            if (!nextSession) {
                try {
                    nextSession = nextOverlaySession();
                } catch (error) {
                    return { ok: false, state: readinessState, code: error?.code || "OVERLAY_SESSION_ENTROPY_UNAVAILABLE" };
                }
            }
            // Invalidate the prior attempt before replacing the document. A
            // late ready/error from that document cannot reopen or alter this
            // session, and its timer is cancelled below.
            // A closed shell has deliberately cleared `overlaySession`, but
            // its iframe may still be navigating to about:blank. Retargeting
            // that same browsing context lets Chromium keep the old extension
            // frame registration long enough for the next ready message to be
            // authorized against the retired URL/session. Every fresh
            // capability therefore gets a new iframe browsing context; only
            // an already-open, still-authoritative workspace is ever reused.
            const replacingAttempt = Boolean(frame?.getAttribute?.("src"));
            clearReadyTimer();
            frameAttempt += 1;
            overlaySession = nextSession;
            lastDraftSequence = 0;
            themeDraft = false;
            frameIdentity = `${lastTabId || ""}:${currentCategory || ""}`;
            draftRecoveryShown = false;
            hideDraftRecovery();
            showFrameState("loading");
            if (replacingAttempt) replaceFrame();
            frame.setAttribute("src", frameUrl(api, {
                tabId: lastTabId,
                category: currentCategory,
                overlaySession,
                parentOrigin: win?.location?.href
            }));
            scheduleReadyTimeout(overlaySession, frameAttempt);
            if (isOpen()) frameState?.focus?.();
            return { ok: true, state: "loading", overlaySession };
        }

        function cancelPendingFrame({ discard = false } = {}) {
            clearReadyTimer();
            if (readinessState === "ready" && !discard) return;
            readinessState = "closed";
            overlaySession = null;
            lastDraftSequence = 0;
            frameIdentity = null;
            if (frameState) frameState.hidden = true;
            setFrameInteractive(false);
            // A discarded frame must really navigate, not just lose its src
            // attribute: removing the attribute leaves the old document
            // suspended in the frame, while about:blank unloads it.
            if (discard) revokeFrame();
        }

        function mount() {
            if (container) return;
            container = doc.createElement("div");
            container.id = ROOT_ID;
            setContainerInteractive(false);
            const shadow = typeof container.attachShadow === "function"
                ? container.attachShadow({ mode: "closed" })
                : container;
            shadowRoot = shadow;
            const style = doc.createElement("style");
            style.textContent = `${fontFaceCss(api)}${SHELL_CSS}`;
            shadow.appendChild(style);

            overlay = doc.createElement("div");
            overlay.className = "overlay";
            overlay.setAttribute("data-state", "closed");
            overlay.setAttribute("data-fullscreen", "true");
            overlay.setAttribute("data-preview", "off");
            overlay.hidden = true;

            backdrop = doc.createElement("div");
            backdrop.className = "backdrop";

            panel = doc.createElement("div");
            panel.className = "panel";
            panel.setAttribute("role", "dialog");
            panel.setAttribute("aria-modal", "true");
            panel.setAttribute("aria-label", "APStudyCanvas Edit Canvas");

            panelFill = doc.createElement("div");
            panelFill.className = "panel-fill";

            stage = doc.createElement("div");
            stage.className = "stage";

            frame = createFrame();
            stage.appendChild(frame);

            frameState = makeControl("div", "frame-state", {
                tabindex: "-1",
                role: "status",
                "aria-live": "polite",
                "data-kind": "loading"
            });
            frameStateTitle = makeControl("p", "frame-state-title", { text: "Loading APStudyCanvas" });
            frameStateMessage = makeControl("p", "frame-state-message", { text: "Preparing your Canvas settings…" });
            frameStateActions = makeControl("div", "frame-state-actions");
            retryButton = makeControl("button", "frame-state-retry", { type: "button", text: "Try again" });
            workspaceLink = makeControl("a", "frame-state-workspace", {
                target: "_blank",
                rel: "noopener",
                text: "Open workspace in a new tab"
            });
            frameStateActions.appendChild(retryButton);
            frameStateActions.appendChild(workspaceLink);
            frameState.appendChild(frameStateTitle);
            frameState.appendChild(frameStateMessage);
            frameState.appendChild(frameStateActions);
            stage.appendChild(frameState);
            on(retryButton, "click", () => handleControl("retry", { overlaySession }));

            draftRecovery = makeControl("div", "draft-recovery", {
                tabindex: "-1",
                role: "alert"
            });
            draftRecovery.hidden = true;
            draftRecovery.appendChild(makeControl("p", "draft-recovery-message", { text: DRAFT_RECOVERY_MESSAGE }));
            const recoveryActions = makeControl("div", "draft-recovery-actions");
            draftRecoveryClose = makeControl("button", "draft-recovery-close", {
                type: "button",
                text: DRAFT_RECOVERY_BUTTON
            });
            recoveryActions.appendChild(draftRecoveryClose);
            draftRecovery.appendChild(recoveryActions);
            stage.appendChild(draftRecovery);
            on(draftRecoveryClose, "click", handleDraftRecoveryClose);

            mountPreviewChrome();

            panel.appendChild(panelFill);
            panel.appendChild(stage);
            panel.appendChild(preview);
            overlay.appendChild(backdrop);
            overlay.appendChild(panel);
            shadow.appendChild(overlay);
            (doc.documentElement || doc.body)?.appendChild(container);

            previewEngine = previewModule?.createPreviewEngine?.({
                documentRef: doc,
                windowRef: win,
                overlay,
                fill: panelFill,
                backdrop,
                previewViewport,
                pageSelect,
                zoomValue,
                historyController,
                createLedger: createRestoreLedger,
                insets: FULL_VIEWPORT_INSET,
                onState: (state) => {
                    if (!previewEnabled || !overlay) return;
                    const shellState = overlay.getAttribute?.("data-state");
                    if (shellState === "closing" || shellState === "closed") return;
                    if (state?.previewState) setPreviewAttr(state.previewState);
                }
            }) || null;

            on(win, "message", handleDraftResponse);
            on(win, "message", handleOverlayBridgeMessage);
            on(backdrop, "click", () => close("backdrop"));
            on(doc, "keydown", (event) => {
                if (event?.key !== "Escape" || !isOpen()) return;
                // Escape has browser-level behavior in some embedded-frame
                // states. During a replacement frame's loading interval that
                // behavior can win after the host closes and move the Canvas
                // tab away from its current route. The host owns Escape for
                // the complete lifetime of an open shell, not only once the
                // popup iframe has completed its ready handshake.
                event.preventDefault?.();
                event.stopPropagation();
                close("escape");
            }, true);
            on(overlay, "keydown", (event) => {
                if (!isOpen() || event?.key !== "Tab" || event.shiftKey) return;
                if (readinessState !== "ready") return;
                const controls = toolbarControls();
                if (!controls.length) return;
                const active = shadowRoot?.activeElement;
                if (active !== controls[controls.length - 1]) return;
                event.preventDefault?.();
                event.stopPropagation?.();
                focusFrame();
            });
            on(panel, "transitionend", () => previewEngine?.applyLayout?.());
        }

        // DOM order, so "toolbar-end" is genuinely the last tab stop before the
        // Tab-to-frame wrap.
        function toolbarControls() {
            if (overlay?.getAttribute?.("data-preview") !== "on") return [];
            return [zoomOut, zoomIn, pageSelect, zoomReset, themeSwitch].filter((node) => node);
        }

        function focusToolbar(which) {
            const controls = toolbarControls();
            if (!controls.length || overlay?.getAttribute?.("data-preview") !== "on") {
                return { ok: false, code: "PREVIEW_INACTIVE" };
            }
            const target = which === "end" ? controls[controls.length - 1] : controls[0];
            target.focus?.();
            return { ok: true, target: which === "end" ? "toolbar-end" : "toolbar" };
        }

        function focusFrame() {
            if (readinessState !== "ready") return { ok: false, code: "OVERLAY_NOT_READY" };
            frame?.focus?.();
            return { ok: true, target: "frame" };
        }

        function applyLaunchOrigin(launchOrigin) {
            if (!panel?.style) return;
            const width = Number(win?.innerWidth) || 0;
            const x = Number.isFinite(launchOrigin?.x) ? launchOrigin.x : Math.max(0, width - 12);
            const y = Number.isFinite(launchOrigin?.y) ? launchOrigin.y : 0;
            panel.style.setProperty("--apsc-origin-x", width ? `${Math.round((x / width) * 100)}%` : "100%");
            panel.style.setProperty("--apsc-origin-y", `${Math.max(0, Math.round(y))}px`);
        }

        function lockHostScroll() {
            ledger = createRestoreLedger();
            const scrollX = Number(win?.scrollX);
            const scrollY = Number(win?.scrollY);
            const x = Number.isFinite(scrollX) ? scrollX : Number(doc.documentElement?.scrollLeft) || 0;
            const y = Number.isFinite(scrollY) ? scrollY : Number(doc.documentElement?.scrollTop) || 0;
            ledger.record(() => {
                if (typeof win?.scrollTo === "function") win.scrollTo(x, y);
                else if (doc.documentElement) {
                    doc.documentElement.scrollLeft = x;
                    doc.documentElement.scrollTop = y;
                }
            });
            ledger.setStyle(doc.documentElement, "overflow", "hidden");
            if (doc.body) ledger.setStyle(doc.body, "overflow", "hidden");
            const body = doc.body;
            if (body) {
                const hadInert = body.inert === true;
                const previousAttr = typeof body.getAttribute === "function" ? body.getAttribute("inert") : null;
                body.inert = true;
                body.setAttribute?.("inert", "");
                ledger.record(() => {
                    body.inert = hadInert;
                    if (previousAttr == null) body.removeAttribute?.("inert");
                    else body.setAttribute?.("inert", previousAttr);
                });
            }
            startContextWatch();
        }

        // A dead context has no live runtime handle at all, or one whose `id`
        // access throws. Either way no message can arrive to say so, so the
        // poll treats both as invalidated; only a readable, non-empty id
        // counts as alive.
        function contextInvalidated() {
            if (!api?.runtime) return true;
            try {
                return !api.runtime.id;
            } catch (error) {
                return true;
            }
        }

        // A background reload kills the iframe while the Canvas page is still
        // scaled and inert, and no message can arrive to say so. Poll the
        // runtime handle instead and tear down synchronously. Escape and the
        // backdrop keep working regardless — those listeners are in-page.
        function startContextWatch() {
            if (!ledger) return;
            const schedule = typeof win?.setInterval === "function"
                ? win.setInterval.bind(win)
                : (typeof setInterval === "function" ? setInterval : null);
            const cancel = typeof win?.clearInterval === "function"
                ? win.clearInterval.bind(win)
                : (typeof clearInterval === "function" ? clearInterval : null);
            if (!schedule) return;
            const timer = schedule(() => {
                if (contextInvalidated()) destroy("context-invalidated");
            }, CONTEXT_POLL_MS);
            if (typeof timer?.unref === "function") timer.unref();
            ledger.record(() => { try { cancel?.(timer); } catch (error) {} });
        }

        function setPreviewAttr(state) {
            const value = state === true || state === "on"
                ? "on"
                : state === "pending" ? "pending" : "off";
            overlay?.setAttribute?.("data-preview", value);
        }

        function stopPreview() {
            previewEngine?.stop?.();
            setPreviewAttr(false);
        }

        function startPreview() {
            const availability = previewModule?.canHostPreview?.({ documentRef: doc, container });
            if (previewEnabled === false || availability?.ok === false || !previewEngine) {
                stopPreview();
                return { ok: true, preview: false, reason: previewEnabled === false ? "disabled" : (availability?.reason || "unavailable") };
            }
            // Make the preview column measurable before asking for its rendered
            // viewport. Pending still paints a full navy mask.
            setPreviewAttr("pending");
            const started = previewEngine.start({ fullscreen });
            if (started?.ok === false) {
                stopPreview();
                return { ok: true, preview: false, reason: started.reason || "error" };
            }
            setPreviewAttr(started.preview === true ? "on" : (started.reason === "narrow" ? "off" : "pending"));
            return { ok: true, preview: started.preview === true, reason: started.reason, zoom: previewEngine.zoom };
        }

        function isOpen() {
            return overlay?.getAttribute?.("data-state") === "open";
        }

        function open({ tabId, category, launchOrigin, preview: previewFlag } = {}) {
            closeGeneration += 1;
            closeRequest = null;
            cancelDraftQueries("OVERLAY_CLOSE_STALE");
            const cold = !container;
            mount();
            if (previewFlag === false) previewEnabled = false;
            if (previewFlag === true) previewEnabled = true;
            if (Number.isInteger(tabId) && tabId > 0) lastTabId = tabId;
            const nextCategory = safeCategory(category);
            if (nextCategory) currentCategory = nextCategory;
            const priorState = overlay?.getAttribute?.("data-state");
            const reopening = priorState === "open" || priorState === "closing";
            const currentSrc = frame.getAttribute("src");
            const nextIdentity = `${lastTabId || ""}:${currentCategory || ""}`;
            const frameReused = Boolean(currentSrc)
                && frameIdentity === nextIdentity
                && (readinessState === "ready" || (readinessState === "loading" && priorState === "open"));
            // Fallible reopen preparation runs before the prior closing timer
            // is cancelled: a failed session mint must leave the in-flight
            // close free to finalize instead of stranding the shell in
            // "closing" with no way out.
            let nextSession = null;
            if (!frameReused) {
                try {
                    nextSession = nextOverlaySession();
                } catch (error) {
                    return { ok: false, state: "closed", code: error?.code || "OVERLAY_SESSION_ENTROPY_UNAVAILABLE" };
                }
            }
            if (closeTimer) {
                clearTimeout(closeTimer);
                closeTimer = null;
            }
            if (!reopening) {
                previousFocus = doc.activeElement || null;
                lockHostScroll();
            }
            if (!frameReused) reloadFrame(nextSession);
            lastOpen = Object.freeze({ cold, frameReused, reopened: reopening });
            overlay.hidden = false;
            setContainerInteractive(true);
            overlay.setAttribute("data-reduced-motion", prefersReducedMotion() ? "true" : "false");
            applyLaunchOrigin(launchOrigin);
            setFullscreen(fullscreenPreference, { persist: false });
            if (!preferenceLoaded) {
                preferencePromise.then((value) => {
                    if (overlay && overlay.getAttribute("data-state") !== "closed") {
                        setFullscreen(value, { persist: false });
                    }
                });
            }
            // Closing already called exit(); enter() here flips history to
            // REOPENING (or pushes a fresh marker if Back already settled).
            if (priorState !== "open") historyController?.enter?.();
            // Read layout once so the closed-state styles commit before the
            // open state flips; otherwise both frames coalesce and the panel
            // appears with no transition.
            void panel.offsetWidth;
            overlay.setAttribute("data-state", "open");
            let previewState;
            if (reopening && previewEngine?.active) {
                setPreviewAttr("pending");
                previewState = previewEngine.resume?.() || { ok: true, preview: previewEngine.available === true };
                setPreviewAttr(previewState.preview === true ? "on" : (previewState.reason === "narrow" ? "off" : "pending"));
            } else {
                previewState = startPreview();
            }
            previewEngine?.trackTransition?.();
            if (readinessState === "ready") frame.focus?.();
            else frameState?.focus?.();
            return {
                ok: true,
                state: "open",
                reopened: reopening,
                cold,
                frameReused,
                fullscreen,
                preview: previewState.preview === true
            };
        }

        // The tail of a close: the exit transition's timer runs it, and
        // destroy() runs it directly so a teardown mid-animation still restores
        // the page. Every step is idempotent, so calling it twice is a no-op.
        function finalizeClose() {
            if (closeTimer) {
                clearTimeout(closeTimer);
                closeTimer = null;
            }
            if (overlay) {
                overlay.setAttribute("data-state", "closed");
                overlay.hidden = true;
            }
            setContainerInteractive(false);
            setFullscreen(false, { persist: false });
            stopPreview();
            hideDraftRecovery();
            ledger?.restore();
            ledger = null;
            if (previousFocus?.focus && doc.contains?.(previousFocus)) previousFocus.focus();
            previousFocus = null;
        }

        function blockClose(reason, code) {
            return { ok: false, code, state: "open" };
        }

        function commitClose(reason) {
            if (!overlay) return { ok: true, state: "closed" };
            const state = overlay.getAttribute("data-state");
            if (state === "closed") return { ok: true, state: "closed" };
            if (state === "closing") {
                // A close whose finalize timer died can never finish alone;
                // finish it here rather than report a closing that never ends.
                if (!closeTimer) finalizeClose();
                return { ok: true, state: overlay?.getAttribute("data-state") || "closed" };
            }
            // Closing invalidates the iframe capability immediately. A close
            // animation may be interrupted by a reopen, so waiting for the
            // timer would let that reopen reuse a ready document and token.
            themeDraft = false;
            closeGeneration += 1;
            cancelDraftQueries("OVERLAY_SESSION_STALE");
            cancelPendingFrame({ discard: true });
            hideDraftRecovery();
            // Remove the cutout and body transform synchronously. The closing
            // panel may now animate without exposing stale Canvas geometry.
            previewEngine?.cover?.();
            setContainerInteractive(false);
            overlay.setAttribute("data-state", "closing");
            // A popstate close is still inside overlay-history's authorization
            // phase. That owner releases its retained marker only after this
            // commit succeeds; direct controls release their marker here.
            if (reason !== "popstate") historyController?.exit?.("ui");
            const duration = prefersReducedMotion() ? REDUCED_DURATION : CLOSE_DURATION;
            closeTimer = setTimeout(finalizeClose, duration);
            if (typeof onControl === "function") onControl({ action: "closed", reason });
            return { ok: true, state: "closing", reason };
        }

        function close(reason = "programmatic") {
            if (!overlay) return Promise.resolve({ ok: true, state: "closed" });
            const state = overlay.getAttribute("data-state");
            if (state === "closing" && !closeTimer) {
                // No live finalize timer means this close could never finish
                // on its own; heal by finalizing now instead of reporting a
                // transition that is already dead.
                finalizeClose();
                return Promise.resolve({ ok: true, state: "closed" });
            }
            if (state === "closed" || state === "closing") {
                return Promise.resolve({ ok: true, state: state || "closed" });
            }
            if (closeRequest) return closeRequest;
            if (readinessState !== "ready") return Promise.resolve(commitClose(reason));

            const session = overlaySession;
            const generation = closeGeneration;
            const operation = (async () => {
                const authoritative = await resolveAuthoritativeDraftState(session);
                if (generation !== closeGeneration
                    || session !== overlaySession
                    || readinessState !== "ready"
                    || !isOpen()) {
                    return { ok: false, code: "OVERLAY_CLOSE_STALE", state: isOpen() ? "open" : readinessState };
                }
                if (authoritative.ok !== true) {
                    // The first unavailable authoritative answer proves the
                    // close-time protection cannot be verified; surface the
                    // host-owned recovery panel instead of a silent dead end.
                    if (authoritative.code === "OVERLAY_DRAFT_STATE_UNAVAILABLE") showDraftRecovery();
                    return blockClose(reason, authoritative.code || "OVERLAY_DRAFT_STATE_UNAVAILABLE");
                }
                themeDraft = authoritative.draft;
                if (themeDraft) {
                    let discard = false;
                    try {
                        discard = typeof win?.confirm === "function"
                            && win.confirm("Discard unsaved theme edits?") === true;
                    } catch (error) {}
                    if (!discard) return blockClose(reason, "OVERLAY_DRAFT_PENDING");
                    themeDraft = false;
                }
                return commitClose(reason);
            })();
            const tracked = operation.finally(() => {
                if (closeRequest === tracked) closeRequest = null;
            });
            closeRequest = tracked;
            return tracked;
        }

        function discardAndClose(payload = {}) {
            if (payload.confirmDiscard !== true) {
                return { ok: false, code: "OVERLAY_DISCARD_CONFIRMATION_REQUIRED", state: "open" };
            }
            if (closeRequest) {
                return { ok: false, code: "OVERLAY_CLOSE_PENDING", state: "open" };
            }
            let confirmed = false;
            try {
                confirmed = typeof win?.confirm === "function"
                    && win.confirm("Discard unsaved theme edits and close APStudyCanvas? This cannot be undone.") === true;
            } catch (error) {
                return { ok: false, code: "OVERLAY_DISCARD_CONFIRMATION_UNAVAILABLE", state: "open" };
            }
            if (!confirmed) return { ok: false, code: "OVERLAY_DISCARD_CANCELLED", state: "open" };
            themeDraft = false;
            return commitClose("embedded-discard");
        }

        function setFullscreen(value, { persist = true } = {}) {
            fullscreen = value === true;
            fullscreenPreference = fullscreen;
            overlay?.setAttribute?.("data-fullscreen", fullscreen ? "true" : "false");
            previewEngine?.setFullscreen?.(fullscreen);
            previewEngine?.trackTransition?.();
            if (persist) storageSet(FULLSCREEN_KEY, fullscreen);
            return { ok: true, fullscreen };
        }

        function setPreviewEnabled(value) {
            previewEnabled = value === true;
            if (!isOpen()) {
                setPreviewAttr(false);
                return { ok: true, preview: false, reason: "closed" };
            }
            return previewEnabled ? startPreview() : (stopPreview(), { ok: true, preview: false, reason: "disabled" });
        }

        function setPreviewZoom(payload) {
            if (!previewEngine?.available) return { ok: false, code: "PREVIEW_INACTIVE" };
            return previewEngine.setZoom(payload);
        }

        function navigatePreview(payload) {
            if (!previewEngine?.available) return { ok: false, code: "PREVIEW_INACTIVE" };
            return previewEngine.navigate(payload);
        }

        // Called by the content lifecycle on every SPA route change, replacing
        // the preview engine's own history patch.
        function notifyRoute() {
            if (!previewEngine) return { ok: false, code: "PREVIEW_INACTIVE" };
            return previewEngine.notifyRoute();
        }

        function handleControl(action, payload = {}) {
            if (!OVERLAY_CONTROL_ACTIONS.has(action)) {
                return { ok: false, state: "unsupported", code: "OVERLAY_ACTION_UNSUPPORTED" };
            }
            if (!payload || !Object.prototype.hasOwnProperty.call(payload, "overlaySession") || typeof payload.overlaySession !== "string") {
                return { ok: false, state: "unauthenticated", code: "OVERLAY_SESSION_REQUIRED" };
            }
            if (!overlaySession || payload.overlaySession !== overlaySession) {
                return { ok: false, state: "stale", code: "OVERLAY_SESSION_STALE" };
            }
            if (!isOpen()) return { ok: false, state: readinessState, code: "OVERLAY_NOT_OPEN" };

            const loadingAction = action === "ready" || action === "error";
            const retryAction = action === "retry";
            const readyAction = !loadingAction && !retryAction;
            if ((loadingAction && readinessState !== "loading")
                || (retryAction && readinessState !== "error" && readinessState !== "loading")
                || (readyAction && readinessState !== "ready")) {
                return { ok: false, state: readinessState, code: "OVERLAY_ACTION_STATE_INVALID" };
            }

            if (action === "ready") {
                showReady();
                return {
                    ok: true,
                    state: "ready",
                    fullscreen,
                    preview: previewEngine?.available === true,
                    zoom: previewEngine?.zoom ?? previewModule?.ZOOM_DEFAULT ?? 100,
                    destination: previewModule?.destinationFromHref?.(win?.location?.href) || null
                };
            }
            if (action === "error") {
                showFrameError(payload?.code === "POPUP_INIT_FAILED"
                    ? "APStudyCanvas couldn’t initialize this workspace. Try again or open it in a new tab."
                    : "The embedded workspace could not load. Try again or open it in a new tab.");
                return { ok: true, state: "error", code: typeof payload?.code === "string" ? payload.code : "OVERLAY_FRAME_ERROR" };
            }
            if (action === "retry") return reloadFrame();
            if (action === "draft-state") {
                if (typeof payload.draft !== "boolean"
                    || !Number.isSafeInteger(payload.sequence)
                    || payload.sequence < 1) {
                    return { ok: false, code: "OVERLAY_DRAFT_STATE_INVALID" };
                }
                if (payload.sequence <= lastDraftSequence) {
                    return {
                        ok: false,
                        code: "OVERLAY_DRAFT_STATE_STALE",
                        draft: themeDraft,
                        sequence: lastDraftSequence
                    };
                }
                lastDraftSequence = payload.sequence;
                themeDraft = payload.draft;
                // The workspace answered again, so its recovery surface no
                // longer describes reality.
                hideDraftRecovery();
                return { ok: true, state: "ready", draft: themeDraft, sequence: lastDraftSequence };
            }
            if (action === "close") return close("embedded");
            if (action === "discard-close") return discardAndClose(payload);
            if (action === "fullscreen") return setFullscreen(payload.value === true);
            if (action === "navigate") return navigatePreview(payload);
            if (action === "zoom") return setPreviewZoom(payload);
            if (action === "preview") return setPreviewEnabled(payload.enabled === true);
            if (action === "focus") {
                if (payload.target === "toolbar" || payload.target === "toolbar-start") return focusToolbar("start");
                if (payload.target === "toolbar-end") return focusToolbar("end");
                if (payload.target === "frame") return focusFrame();
                return { ok: false, code: "OVERLAY_FOCUS_UNSUPPORTED" };
            }
            return { ok: false, state: "unsupported", code: "OVERLAY_ACTION_UNSUPPORTED" };
        }

        // Teardown is content-local and synchronous, so it survives pagehide.
        // historyController.destroy() is exit("destroy"): it detaches popstate
        // without a synthetic Back, so the abandoned marker makes a later Back
        // a no-op instead of closing a shell that no longer exists.
        function destroy(reason = "destroy") {
            closeGeneration += 1;
            closeRequest = null;
            cancelDraftQueries("OVERLAY_SESSION_STALE");
            cancelPendingFrame({ discard: true });
            finalizeClose();
            historyController?.destroy?.();
            historyController = null;
            stopPreview();
            previewEngine = null;
            while (listeners.length) {
                const off = listeners.pop();
                try { off(); } catch (error) {}
            }
            ledger?.restore();
            ledger = null;
            container?.remove?.();
            container = null;
            overlay = null;
            panel = null;
            panelFill = null;
            backdrop = null;
            stage = null;
            frameState = null;
            frameStateTitle = null;
            frameStateMessage = null;
            frameStateActions = null;
            retryButton = null;
            workspaceLink = null;
            draftRecovery = null;
            draftRecoveryClose = null;
            draftRecoveryShown = false;
            preview = null;
            previewViewport = null;
            previewShield = null;
            previewToolbar = null;
            previewToolbarEnd = null;
            pageSelect = null;
            zoomValue = null;
            zoomOut = null;
            zoomIn = null;
            zoomReset = null;
            themeSwitch = null;
            frame = null;
            shadowRoot = null;
            themeDraft = false;
            lastTabId = null;
            overlaySession = null;
            lastDraftSequence = 0;
            frameIdentity = null;
            readinessState = "closed";
            lastOpen = Object.freeze({ cold: false, frameReused: false, reopened: false });
            return { ok: true, state: "destroyed", reason };
        }

        return Object.freeze({
            open,
            close,
            setFullscreen,
            setPreviewEnabled,
            setPreviewZoom,
            navigatePreview,
            notifyRoute,
            handleControl,
            destroy,
            isOpen,
            get fullscreen() { return fullscreen; },
            get preview() { return previewEngine?.available === true; },
            get zoom() { return previewEngine?.zoom ?? previewModule?.ZOOM_DEFAULT ?? 100; },
            get category() { return currentCategory; },
            get frameSrc() { return frame?.getAttribute?.("src") || null; },
            get readiness() { return readinessState; },
            get overlaySession() { return overlaySession; },
            get lastOpen() { return lastOpen; }
        });
    }

    return Object.freeze({
        ROOT_ID,
        FRAME_PAGE,
        FULLSCREEN_KEY,
        READY_TIMEOUT_MS,
        DRAFT_QUERY_TIMEOUT_MS,
        DRAFT_QUERY_TYPE,
        DRAFT_RESPONSE_TYPE,
        DRAFT_RECOVERY_MESSAGE,
        DRAFT_RECOVERY_BUTTON,
        DRAFT_RECOVERY_CONFIRM,
        OVERLAY_BRIDGE_REQUEST_TYPE,
        OVERLAY_BRIDGE_RESPONSE_TYPE,
        OPEN_DURATION,
        CLOSE_DURATION,
        REDUCED_DURATION,
        EASING,
        FULL_VIEWPORT_INSET,
        WINDOWED_INSET,
        WINDOWED_RADIUS,
        SHELL_CSS,
        fontFaceCss,
        safeCategory,
        createOverlaySessionToken,
        safeParentOrigin,
        frameUrl,
        createRestoreLedger,
        createOverlayHost
    });
}));
