(function (root, factory) {
    "use strict";
    const api = factory();
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasContent = Object.assign(root.APStudyCanvasContent || {}, { SidebarPageActions: api });
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const EVENT_NAME = "apstudycanvas:sidebar-page-action";
    const PENDING_ACTION_KEY = "apstudycanvas.sidebar.pending-action.v1";
    const PENDING_ACTION_TTL_MS = 5000;
    const ACTIONS = Object.freeze({ planner: null, grades: null, notes: null, study: null });

    function isDashboardPath(pathname) {
        const path = typeof pathname === "string" ? pathname.replace(/\/{2,}/g, "/").replace(/\/$/, "") || "/" : "";
        return path === "/" || path === "/dashboard";
    }

    function readPending(storage, now) {
        try {
            const value = JSON.parse(storage?.getItem?.(PENDING_ACTION_KEY) || "null");
            return value?.version === 1 && value.action === "notes" && Number.isFinite(value.expiresAt) && value.expiresAt >= now
                ? value
                : null;
        } catch (error) {
            return null;
        }
    }

    function clearPending(storage) {
        try { storage?.removeItem?.(PENDING_ACTION_KEY); } catch (error) {}
    }

    // Search can be enabled before its account/context bootstrap has mounted
    // the dialog. Treat that state as handled, then show the existing UI once
    // its bounded bootstrap settles; do not send the student to settings just
    // because the first synchronous lookup found no root.
    function showStudyWhenReady({ showStudy = () => false, ensureStudy = null, openStudyTools = () => false } = {}) {
        if (showStudy() === true) return true;
        if (typeof ensureStudy !== "function") return false;
        Promise.resolve().then(() => ensureStudy()).then(
            () => { if (showStudy() !== true) openStudyTools(); },
            () => { openStudyTools(); }
        );
        return true;
    }

    function createSidebarPageActions({ document: doc = globalThis.document, openWorkspace = () => false } = {}) {
        let attached = false;
        function handle(action) { return Object.hasOwn(ACTIONS, action) && openWorkspace(action) === true; }
        function onAction(event) { if (typeof event?.detail?.action === "string") handle(event.detail.action); }
        function attach() { if (!attached && doc?.addEventListener) { doc.addEventListener(EVENT_NAME, onAction); attached = true; } return attached; }
        function destroy() { if (attached) doc?.removeEventListener?.(EVENT_NAME, onAction); attached = false; }
        return Object.freeze({ attach, destroy, handle, consumePending: () => false });
    }
    return Object.freeze({ EVENT_NAME, showStudyWhenReady, createSidebarPageActions });
}));
