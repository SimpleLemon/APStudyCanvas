(function (root, factory) {
    "use strict";
    const api = factory();
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasContent = Object.assign(root.APStudyCanvasContent || {}, { DashboardCardWatchdog: api });
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    // This is deliberately a compatibility *watchdog*, not another dashboard
    // renderer. Canvas owns its React subtree and may delay or replace it
    // during navigation. We only fail open after its own card shell has
    // remained in a native loading state for the whole bounded observation.
    function isDashboardPath(pathname) {
        return pathname === "/" || pathname === "/dashboard" || String(pathname || "").startsWith("/dashboard/");
    }

    function createDashboardCardWatchdog({
        window: win = globalThis.window,
        document: doc = globalThis.document,
        rootSelector = "#DashboardCard_Container",
        cardSelector = ".ic-DashboardCard",
        isBlockingEnabled = () => false,
        onTerminal = () => {},
        timeoutMs = 20000,
        now = () => Date.now(),
        setTimer = setTimeout,
        clearTimer = clearTimeout,
        mutationObserver: MutationObserverClass = win?.MutationObserver || globalThis.MutationObserver
    } = {}) {
        let observer = null;
        let timer = null;
        let active = false;
        let reported = false;
        let routePath = null;

        function clearWatch() {
            if (timer !== null) clearTimer(timer);
            timer = null;
            observer?.disconnect?.();
            observer = null;
            active = false;
        }

        function cardsPresent() {
            try { return (doc?.querySelectorAll?.(cardSelector)?.length || 0) > 0; } catch (error) { return false; }
        }

        function dashboardRoot() {
            try { return doc?.querySelector?.(rootSelector) || null; } catch (error) { return null; }
        }

        // An empty dashboard is valid for a student with no active courses.
        // Other extensions may also append arbitrary markup, so only Canvas's
        // own dashboard-card loading shell can constitute terminal evidence.
        function hasNativeLoadingShell(node) {
            if (!node?.querySelector) return false;
            try {
                return Boolean(node.querySelector(
                    ".ic-DashboardCard__box, .ic-DashboardCard__header_hero, [class*='DashboardCard'], [data-testid*='dashboard-card']"
                ));
            } catch (error) { return false; }
        }

        function settleIfRendered() {
            if (cardsPresent()) {
                clearWatch();
                return true;
            }
            return false;
        }

        function evaluateTerminal() {
            timer = null;
            if (!active || reported || !isDashboardPath(routePath) || settleIfRendered()) return;
            const root = dashboardRoot();
            if (!root || !hasNativeLoadingShell(root)) {
                // No Canvas scaffold is not proof of a blocked chunk: Canvas
                // may still be navigating, or may legitimately render empty.
                clearWatch();
                return;
            }
            reported = true;
            clearWatch();
            try { onTerminal({ path: routePath, observedAt: Number(now()) || 0 }); } catch (error) {}
        }

        function start(pathname) {
            if (reported || active) return;
            active = true;
            routePath = pathname;
            if (typeof MutationObserverClass === "function") {
                observer = new MutationObserverClass(() => {
                    if (!active || !isDashboardPath(routePath)) return;
                    settleIfRendered();
                });
                observer.observe(doc?.documentElement || doc, { childList: true, subtree: true });
            }
            timer = setTimer(evaluateTerminal, Math.max(0, Number(timeoutMs) || 0));
            settleIfRendered();
        }

        function reconcile(pathname = win?.location?.pathname || "") {
            routePath = pathname;
            if (reported || !isBlockingEnabled?.() || !isDashboardPath(pathname)) {
                clearWatch();
                return;
            }
            if (active) {
                settleIfRendered();
                return;
            }
            start(pathname);
        }

        function dispose() { clearWatch(); }

        return Object.freeze({ reconcile, dispose, isActive: () => active, hasObserver: () => Boolean(observer), hasTimer: () => timer !== null, wasReported: () => reported });
    }

    return Object.freeze({ isDashboardPath, createDashboardCardWatchdog });
}));
