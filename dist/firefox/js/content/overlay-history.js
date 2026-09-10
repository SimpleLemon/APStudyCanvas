(function (root, factory) {
    "use strict";
    const api = factory();
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasContent = Object.assign(root.APStudyCanvasContent || {}, { OverlayHistory: api });
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const MARKER_KEY = "apstudycanvasOverlay";
    const MARKER_VALUE = 1;
    const PHASES = Object.freeze({
        CLOSED: "closed",
        OPEN: "open",
        AUTHORIZING: "authorizing",
        EXITING: "exiting",
        REOPENING: "reopening"
    });

    function isOverlayState(state) {
        return Boolean(state && typeof state === "object" && state[MARKER_KEY] === MARKER_VALUE);
    }

    function markerRecord() {
        return { [MARKER_KEY]: MARKER_VALUE };
    }

    function createOverlayHistory({ windowRef, onClose } = {}) {
        const win = windowRef || (typeof window !== "undefined" ? window : null);
        let phase = PHASES.CLOSED;
        let listener = null;
        let exitRestore = null;

        function currentState() {
            try { return win?.history?.state; } catch (error) { return null; }
        }

        function currentIsOurs() {
            return isOverlayState(currentState());
        }

        function currentHref() {
            try { return typeof win?.location?.href === "string" ? win.location.href : ""; } catch (error) { return ""; }
        }

        function attach() {
            if (listener || !win?.addEventListener) return;
            listener = (event) => onPopState(event);
            win.addEventListener("popstate", listener);
        }

        function detach() {
            if (listener && win?.removeEventListener) win.removeEventListener("popstate", listener);
            listener = null;
        }

        function pushMarker() {
            if (!win?.history || typeof win.history.pushState !== "function") return false;
            const href = currentHref();
            try {
                if (href) win.history.pushState(markerRecord(), "", href);
                else win.history.pushState(markerRecord(), "");
                return true;
            } catch (error) {
                return false;
            }
        }

        function pushEntry(state, href) {
            if (!win?.history || typeof win.history.pushState !== "function") return false;
            try {
                if (href) win.history.pushState(state, "", href);
                else win.history.pushState(state, "");
                return true;
            } catch (error) {
                return false;
            }
        }

        function goBack() {
            if (typeof win?.history?.back !== "function") return false;
            try {
                win.history.back();
                return true;
            } catch (error) {
                return false;
            }
        }

        function enter() {
            attach();
            if (phase === PHASES.OPEN) return { ok: true, phase, pushed: false, reason: "already-open" };
            if (phase === PHASES.AUTHORIZING) {
                return { ok: true, phase, pushed: false, reason: "authorization-pending" };
            }
            if (phase === PHASES.EXITING || phase === PHASES.REOPENING) {
                phase = PHASES.REOPENING;
                return { ok: true, phase, pushed: false, reason: "reopen-pending" };
            }
            if (currentIsOurs()) {
                phase = PHASES.OPEN;
                return { ok: true, phase, pushed: false, reason: "marker-present" };
            }
            const pushed = pushMarker();
            phase = PHASES.OPEN;
            return { ok: true, phase, pushed };
        }

        function exit(via = "ui") {
            if (via === "popstate") {
                phase = PHASES.CLOSED;
                exitRestore = null;
                return { ok: true, phase, popped: false, reason: "popstate" };
            }
            if (via === "destroy") {
                phase = PHASES.CLOSED;
                exitRestore = null;
                detach();
                return { ok: true, phase, popped: false, reason: "destroy" };
            }
            if (phase === PHASES.CLOSED) return { ok: true, phase, popped: false, reason: "already" };
            if (phase === PHASES.EXITING) return { ok: true, phase, popped: false, reason: "exiting" };
            if (phase === PHASES.AUTHORIZING && via !== "authorized") {
                return { ok: true, phase, popped: false, reason: "authorization-pending" };
            }
            if (phase === PHASES.REOPENING) {
                phase = PHASES.EXITING;
                return { ok: true, phase, popped: false, reason: "cancel-reopen" };
            }
            if (!currentIsOurs()) {
                // A preview route is a same-document entry above our marker.
                // Walk back through that owned chain, pass the marker, then
                // re-push the captured live route. The push truncates the old
                // marker/preview branch without assigning location or causing
                // a Canvas unload.
                exitRestore = {
                    state: currentState(),
                    href: currentHref(),
                    markerSeen: false
                };
                phase = PHASES.EXITING;
                const popped = goBack();
                if (!popped) {
                    exitRestore = null;
                    phase = PHASES.CLOSED;
                }
                return { ok: true, phase, popped, reason: "restore-preview" };
            }
            phase = PHASES.EXITING;
            const popped = goBack();
            if (!popped) phase = PHASES.CLOSED;
            return { ok: true, phase, popped };
        }

        function onPopState(event) {
            const ours = isOverlayState(event?.state);
            if (phase === PHASES.EXITING) {
                if (exitRestore) {
                    if (!exitRestore.markerSeen) {
                        if (ours) exitRestore.markerSeen = true;
                        if (goBack()) return;
                        exitRestore = null;
                        phase = PHASES.CLOSED;
                        return;
                    }
                    const restore = exitRestore;
                    exitRestore = null;
                    pushEntry(restore.state, restore.href);
                }
                phase = PHASES.CLOSED;
                return;
            }
            if (phase === PHASES.REOPENING) {
                const restore = exitRestore;
                exitRestore = null;
                if (restore) pushEntry(restore.state, restore.href);
                pushMarker();
                phase = PHASES.OPEN;
                return;
            }
            if (phase === PHASES.AUTHORIZING) {
                // Back has just left our state-only marker. Recreate it before
                // returning to the browser so rapid repeats cannot reach the
                // Canvas entry underneath while the host decides whether the
                // draft may close.
                if (!ours) pushMarker();
                return;
            }
            if (phase !== PHASES.OPEN) return;
            if (ours) return;
            phase = PHASES.AUTHORIZING;
            if (!pushMarker()) {
                phase = PHASES.OPEN;
                return;
            }

            function settleAuthorization(result) {
                if (phase !== PHASES.AUTHORIZING) return;
                if (result?.ok !== false) {
                    exit("authorized");
                    return;
                }
                // Authorization was denied or unavailable. The marker was
                // retained throughout, so reopening only changes ownership
                // phase and never synthesizes another navigation.
                phase = PHASES.OPEN;
                if (!currentIsOurs()) pushMarker();
            }

            let authorization;
            try {
                authorization = typeof onClose === "function"
                    ? onClose({ reason: "popstate" })
                    : { ok: true };
            } catch (error) {
                authorization = { ok: false };
            }
            if (authorization && typeof authorization.then === "function") {
                Promise.resolve(authorization).then(settleAuthorization, () => {
                    if (phase !== PHASES.AUTHORIZING) return;
                    phase = PHASES.OPEN;
                    if (!currentIsOurs()) pushMarker();
                });
            } else {
                settleAuthorization(authorization);
            }
        }

        function destroy() {
            exit("destroy");
        }

        // Preview navigations may stack only while the overlay marker is the
        // live history entry's parent: phase OPEN, and never via a synthetic
        // popstate that would look like Back leaving the marker.
        function canStackPreview() {
            return phase === PHASES.OPEN;
        }

        return Object.freeze({
            enter,
            exit,
            destroy,
            currentIsOurs,
            canStackPreview,
            get phase() { return phase; },
            get attached() { return Boolean(listener); }
        });
    }

    return Object.freeze({
        MARKER_KEY,
        MARKER_VALUE,
        PHASES,
        isOverlayState,
        markerRecord,
        createOverlayHistory
    });
}));
