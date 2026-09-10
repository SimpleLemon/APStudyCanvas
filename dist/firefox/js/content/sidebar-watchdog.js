(function (root, factory) {
    "use strict";
    const api = factory();
    const commonJs = typeof module !== "undefined" && module?.exports && typeof require === "function";
    if (commonJs) module.exports = api;
    // CommonJS is a library/test entry point.  Never start a real interval as
    // a side effect of require(), even when a test happens to expose a global
    // document.  The page-world manifest entry is the only automatic install
    // path, and it must have the browser DOM/timer surface first.
    if (!commonJs && api.isBrowserLikeRoot(root)) {
        api.installPageWatchdog({ window: root, document: root.document });
    }
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const VERSION = 2;
    const ROOT_ID = "apstudycanvas-sidebar-root";
    const RECOVERY_ID = "apstudycanvas-sidebar-recovery";
    const LEGACY_LAYOUT_STYLE_ID = "canvasrefined-sidebar-layout-fix";
    const MOUNTED_ATTRIBUTE = "data-apstudycanvas-sidebar-mounted";
    const ACTIVE_ATTRIBUTE = "data-apstudycanvas-sidebar-active";
    const SESSION_ATTRIBUTE = "data-apstudycanvas-sidebar-session";
    const HEARTBEAT_ATTRIBUTE = "data-apstudycanvas-sidebar-heartbeat";
    const STATE_ATTRIBUTE = "data-apstudycanvas-sidebar-state";
    const RUNTIME_STATE_ATTRIBUTE = "data-apstudycanvas-sidebar-runtime-state";
    const OVERLAY_ATTRIBUTE = "data-apstudycanvas-sidebar-overlay";
    const DENSITY_ATTRIBUTE = "data-apstudycanvas-sidebar-density";
    const SCALE_ATTRIBUTE = "data-apstudycanvas-sidebar-scale";
    const WIDTH_PROPERTY = "--apstudy-sidebar-width";
    const NATIVE_SELECTORS = Object.freeze(["#global_nav", "#global-nav", ".ic-app-header"]);
    const WRAPPER_SELECTOR = "#wrapper";
    const GLOBAL_COURSES_FLYOUT_SELECTOR = "#nav-tray-portal .navigation-tray-container.courses-tray";
    const COURSE_NAVIGATION_SELECTORS = Object.freeze([
        ".ic-Layout-columns",
        "body.with-left-side.course-menu-expanded #left-side.ic-app-course-menu"
    ]);
    const LAYOUT_SELECTORS = Object.freeze([WRAPPER_SELECTOR, GLOBAL_COURSES_FLYOUT_SELECTOR, ...COURSE_NAVIGATION_SELECTORS]);
    const NATIVE_CLASSES = Object.freeze(["apstudycanvas-sidebar", "apstudycanvas-sidebar-hidden"]);
    const TIMER_INTERVAL_MS = 2500;
    const STALE_HEARTBEAT_MS = 10000;
    const VISIBLE_GRACE_MS = 3500;
    const UNHEALTHY_EVIDENCE_MS = 15000;
    const WATCHDOG_LIVENESS_MS = 7500;
    const WATCHDOG_MARKER_SLOT = `__APSTUDYCANVAS_SIDEBAR_WATCHDOG_V${VERSION}__`;
    const WATCHDOG_VERSION_ATTRIBUTE = "data-apstudycanvas-sidebar-watchdog-version";
    const WATCHDOG_TOKEN_ATTRIBUTE = "data-apstudycanvas-sidebar-watchdog-token";
    const WATCHDOG_LIVENESS_ATTRIBUTE = "data-apstudycanvas-sidebar-watchdog-liveness";
    // Prepaint handshake (paired with the isolated-world controller): the
    // controller stores its last rendered rail width under this key; the
    // document-start watchdog replays it before first paint so pages that will
    // mount the rail reserve the gutter immediately instead of reflowing when
    // the rail appears. If the controller never mounts, the grace below clears
    // the reservation and restores the native layout.
    const PREPAINT_STORAGE_KEY = "apstudycanvas-sidebar-prepaint";
    const PREPAINT_ATTRIBUTE = "data-apstudycanvas-sidebar-prepaint";
    const PREPAINT_RECORD_VERSION = 1;
    const PREPAINT_MAX_WIDTH_PX = 400;
    const PREPAINT_GRACE_MS = 7000;

    function safeCall(fn, fallback) {
        try { return fn(); } catch (error) { return fallback; }
    }
    function getAttribute(node, name) { return node?.getAttribute?.(name) ?? null; }
    function removeAttribute(node, name) { try { node?.removeAttribute?.(name); } catch (error) {} }
    function removeNode(node) {
        try { node?.remove?.(); } catch (error) {
            try { node?.parentNode?.removeChild?.(node); } catch (ignored) {}
        }
    }
    function isVisible(doc) {
        return !doc || doc.visibilityState === undefined || doc.visibilityState === "visible";
    }
    function uniqueNodes(doc, selectors) {
        const nodes = [];
        selectors.forEach((selector) => {
            const found = safeCall(() => Array.from(doc?.querySelectorAll?.(selector) || []), []);
            if (!found.length) {
                const single = safeCall(() => doc?.querySelector?.(selector), null);
                if (single) found.push(single);
            }
            found.forEach((node) => { if (node && !nodes.includes(node)) nodes.push(node); });
        });
        return nodes;
    }

    function isBrowserLikeRoot(value) {
        const doc = value?.document;
        return Boolean(
            value && doc && doc.documentElement &&
            typeof value.setInterval === "function" &&
            typeof value.clearInterval === "function" &&
            typeof doc.getElementById === "function" &&
            typeof doc.querySelector === "function" &&
            typeof doc.querySelectorAll === "function" &&
            typeof doc.addEventListener === "function" &&
            typeof doc.removeEventListener === "function"
        );
    }

    function createSidebarWatchdog({
        window: win = globalThis.window,
        document: doc = globalThis.document,
        now = () => Date.now(),
        setInterval: schedule = win?.setInterval,
        clearInterval: cancel = win?.clearInterval,
        intervalMs = TIMER_INTERVAL_MS,
        staleMs = STALE_HEARTBEAT_MS,
        visibleGraceMs = VISIBLE_GRACE_MS,
        unhealthyEvidenceMs = UNHEALTHY_EVIDENCE_MS,
        prepaintGraceMs = PREPAINT_GRACE_MS,
        installToken = null
    } = {}) {
        let timer = null;
        let running = false;
        let visibleSince = null;
        let observedSession = null;
        let latestHeartbeat = 0;
        let unhealthySince = null;
        let cleanupCount = 0;
        let visibilityListener = null;
        let prepaintApplied = false;
        let prepaintSince = null;

        function documentElement() { return doc?.documentElement || null; }
        function applyPrepaint() {
            if (prepaintApplied) return;
            const element = documentElement();
            if (!element) return;
            let record = null;
            try { record = JSON.parse(win?.sessionStorage?.getItem?.(PREPAINT_STORAGE_KEY) || "null"); } catch (error) { record = null; }
            if (!record || record.v !== PREPAINT_RECORD_VERSION) return;
            const width = Math.round(Number(record.width));
            if (!Number.isFinite(width) || width < 0 || width > PREPAINT_MAX_WIDTH_PX) return;
            safeCall(() => element.setAttribute(PREPAINT_ATTRIBUTE, "1"));
            safeCall(() => element.style?.setProperty?.(WIDTH_PROPERTY, `${width}px`));
            prepaintApplied = true;
            prepaintSince = Number(now()) || null;
        }
        function clearPrepaint({ forgetRecord = true } = {}) {
            const element = documentElement();
            safeCall(() => element?.removeAttribute?.(PREPAINT_ATTRIBUTE));
            safeCall(() => element?.style?.removeProperty?.(WIDTH_PROPERTY));
            if (forgetRecord) { try { win?.sessionStorage?.removeItem?.(PREPAINT_STORAGE_KEY); } catch (error) {} }
            prepaintApplied = false;
            prepaintSince = null;
        }
        function publishLiveness(current) {
            if (!installToken || !Number.isFinite(current)) return;
            const element = documentElement();
            safeCall(() => element?.setAttribute?.(WATCHDOG_VERSION_ATTRIBUTE, String(VERSION)), undefined);
            safeCall(() => element?.setAttribute?.(WATCHDOG_TOKEN_ATTRIBUTE, installToken), undefined);
            safeCall(() => element?.setAttribute?.(WATCHDOG_LIVENESS_ATTRIBUTE, String(current)), undefined);
        }
        function hasOwnedState() {
            const element = documentElement();
            if (getAttribute(element, ACTIVE_ATTRIBUTE) === "1") return true;
            if (getAttribute(element, SESSION_ATTRIBUTE) || getAttribute(element, HEARTBEAT_ATTRIBUTE)) return true;
            if (getAttribute(element, STATE_ATTRIBUTE) || getAttribute(element, RUNTIME_STATE_ATTRIBUTE)) return true;
            if (getAttribute(element, OVERLAY_ATTRIBUTE) || getAttribute(element, DENSITY_ATTRIBUTE) || getAttribute(element, SCALE_ATTRIBUTE)) return true;
            // A width set only by the prepaint replay is not a live rail; the
            // grace path below owns clearing it.
            if (!prepaintApplied && safeCall(() => element?.style?.getPropertyValue?.(WIDTH_PROPERTY), "")) return true;
            return uniqueNodes(doc, NATIVE_SELECTORS).some((node) =>
                getAttribute(node, MOUNTED_ATTRIBUTE) === "1" || NATIVE_CLASSES.some((name) => Boolean(node.classList?.contains?.(name)))
            ) || uniqueNodes(doc, LAYOUT_SELECTORS).some((node) => getAttribute(node, MOUNTED_ATTRIBUTE) === "1");
        }
        function activeRail() {
            return hasOwnedState();
        }
        function cleanupOwnedState() {
            if (!activeRail()) return false;

            [ROOT_ID, RECOVERY_ID].forEach((id) => {
                const node = safeCall(() => doc?.getElementById?.(id), null);
                if (getAttribute(node, MOUNTED_ATTRIBUTE) === "1" || getAttribute(node, "data-apstudycanvas-owned") === "true") removeNode(node);
            });
            const legacyStyle = safeCall(() => doc?.getElementById?.(LEGACY_LAYOUT_STYLE_ID), null);
            if (legacyStyle?.tagName?.toLowerCase?.() === "style" || legacyStyle?.nodeName?.toLowerCase?.() === "style") removeNode(legacyStyle);

            uniqueNodes(doc, NATIVE_SELECTORS).forEach((node) => {
                NATIVE_CLASSES.forEach((name) => { try { node.classList?.remove?.(name); } catch (error) {} });
                removeAttribute(node, MOUNTED_ATTRIBUTE);
            });
            uniqueNodes(doc, LAYOUT_SELECTORS).forEach((node) => removeAttribute(node, MOUNTED_ATTRIBUTE));
            const element = documentElement();
            [MOUNTED_ATTRIBUTE, ACTIVE_ATTRIBUTE, SESSION_ATTRIBUTE, HEARTBEAT_ATTRIBUTE, STATE_ATTRIBUTE, RUNTIME_STATE_ATTRIBUTE, OVERLAY_ATTRIBUTE, DENSITY_ATTRIBUTE, SCALE_ATTRIBUTE, PREPAINT_ATTRIBUTE].forEach((name) => removeAttribute(element, name));
            try { element?.style?.removeProperty?.(WIDTH_PROPERTY); } catch (error) {}
            try { win?.sessionStorage?.removeItem?.(PREPAINT_STORAGE_KEY); } catch (error) {}
            prepaintApplied = false;
            prepaintSince = null;
            cleanupCount += 1;
            observedSession = null;
            latestHeartbeat = 0;
            unhealthySince = null;
            return true;
        }
        function check() {
            if (!running) return false;
            const current = Number(now());
            if (!Number.isFinite(current)) return false;
            publishLiveness(current);
            if (!activeRail()) {
                observedSession = null;
                latestHeartbeat = 0;
                unhealthySince = null;
                // The prepaint reservation is only trustworthy while the
                // controller is on its way; if no rail evidence appears within
                // the grace, restore the native layout.
                if (prepaintApplied && Number.isFinite(current) && Number.isFinite(prepaintSince) && current - prepaintSince >= Number(prepaintGraceMs)) {
                    clearPrepaint();
                }
                return false;
            }
            if (!isVisible(doc)) { visibleSince = null; return false; }
            if (visibleSince === null) visibleSince = current;

            const element = documentElement();
            const session = getAttribute(element, SESSION_ATTRIBUTE);
            const heartbeatRaw = getAttribute(element, HEARTBEAT_ATTRIBUTE);
            const heartbeatPresent = typeof heartbeatRaw === "string" && heartbeatRaw.trim() !== "";
            const heartbeat = heartbeatPresent ? Number(heartbeatRaw) : NaN;
            const evidenceHealthy = Boolean(session) && heartbeatPresent && Number.isFinite(heartbeat) && heartbeat >= 0 && heartbeat <= current;
            if (!evidenceHealthy) {
                observedSession = null;
                latestHeartbeat = 0;
                if (unhealthySince === null) unhealthySince = current;
                if (current - visibleSince < Number(visibleGraceMs) || current - unhealthySince < Number(unhealthyEvidenceMs)) return false;
                return cleanupOwnedState();
            }
            unhealthySince = null;
            if (session !== observedSession) {
                observedSession = session;
                latestHeartbeat = heartbeat;
                return false;
            }
            if (heartbeat > latestHeartbeat) { latestHeartbeat = heartbeat; return false; }
            if (current < heartbeat || current - heartbeat < Number(staleMs) || current - visibleSince < Number(visibleGraceMs)) return false;
            return cleanupOwnedState();
        }
        function start() {
            if (running) return api;
            running = true;
            applyPrepaint();
            visibleSince = isVisible(doc) ? Number(now()) : null;
            if (typeof doc?.addEventListener === "function") {
                visibilityListener = () => { visibleSince = isVisible(doc) ? Number(now()) : null; };
                doc.addEventListener("visibilitychange", visibilityListener);
            }
            check();
            if (typeof schedule === "function") timer = schedule(check, Math.max(250, Number(intervalMs) || TIMER_INTERVAL_MS));
            return api;
        }
        function stop() {
            if (!running) return api;
            running = false;
            if (timer !== null && typeof cancel === "function") cancel(timer);
            timer = null;
            if (visibilityListener) doc?.removeEventListener?.("visibilitychange", visibilityListener);
            visibilityListener = null;
            return api;
        }
        const api = {
            version: VERSION,
            start,
            stop,
            check,
            cleanupOwnedState,
            isRunning: () => running,
            cleanupCount: () => cleanupCount
        };
        return api;
    }

    function watchdogToken(now = () => Date.now()) {
        const current = Number(safeCall(now, Date.now()));
        return `watchdog-${Number.isFinite(current) ? current : Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    }
    function hasLiveInstallation(marker, doc, now = () => Date.now()) {
        if (!marker || marker.version !== VERSION || typeof marker.token !== "string" || !marker.token) return false;
        const element = doc?.documentElement;
        const current = Number(safeCall(now, NaN));
        const heartbeat = Number(getAttribute(element, WATCHDOG_LIVENESS_ATTRIBUTE));
        return getAttribute(element, WATCHDOG_VERSION_ATTRIBUTE) === String(VERSION)
            && getAttribute(element, WATCHDOG_TOKEN_ATTRIBUTE) === marker.token
            && Number.isFinite(current)
            && Number.isFinite(heartbeat)
            && heartbeat <= current
            && current - heartbeat <= WATCHDOG_LIVENESS_MS;
    }
    function installPageWatchdog(options = {}) {
        const win = options.window || globalThis.window;
        const doc = options.document || win?.document;
        const marker = win?.[WATCHDOG_MARKER_SLOT];
        if (hasLiveInstallation(marker, doc, options.now)) return marker;
        const token = marker?.version === VERSION && typeof marker.token === "string" ? marker.token : watchdogToken(options.now);
        const watchdog = createSidebarWatchdog({ ...options, window: win, document: doc, installToken: token });
        watchdog.start();
        if (win) {
            try {
                Object.defineProperty(win, WATCHDOG_MARKER_SLOT, {
                    value: Object.freeze({ version: VERSION, token }),
                    configurable: false,
                    enumerable: false,
                    writable: false
                });
            } catch (error) {}
        }
        return win?.[WATCHDOG_MARKER_SLOT] || Object.freeze({ version: VERSION, token });
    }

    return Object.freeze({
        VERSION,
        ROOT_ID,
        RECOVERY_ID,
        LEGACY_LAYOUT_STYLE_ID,
        MOUNTED_ATTRIBUTE,
        ACTIVE_ATTRIBUTE,
        SESSION_ATTRIBUTE,
        HEARTBEAT_ATTRIBUTE,
        LAYOUT_SELECTORS,
        WIDTH_PROPERTY,
        TIMER_INTERVAL_MS,
        STALE_HEARTBEAT_MS,
        VISIBLE_GRACE_MS,
        UNHEALTHY_EVIDENCE_MS,
        WATCHDOG_LIVENESS_MS,
        WATCHDOG_MARKER_SLOT,
        WATCHDOG_VERSION_ATTRIBUTE,
        WATCHDOG_TOKEN_ATTRIBUTE,
        WATCHDOG_LIVENESS_ATTRIBUTE,
        PREPAINT_STORAGE_KEY,
        PREPAINT_ATTRIBUTE,
        PREPAINT_RECORD_VERSION,
        PREPAINT_MAX_WIDTH_PX,
        PREPAINT_GRACE_MS,
        isBrowserLikeRoot,
        createSidebarWatchdog,
        installPageWatchdog
    });
}));
