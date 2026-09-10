(function (root, factory) {
    "use strict";
    const api = factory();
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasContent = Object.assign(root.APStudyCanvasContent || {}, { Lifecycle: api });
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const MARKER = "data-apstudycanvas-lifecycle";
    const CONTROLLER_SLOT = "__apstudycanvasLifecycleController";
    const SIDEBAR_ROOT_ID = "apstudycanvas-sidebar-root";
    const SIDEBAR_RECOVERY_ID = "apstudycanvas-sidebar-recovery";
    const SETTINGS_OVERLAY_ID = "apstudycanvas-overlay-root";
    const registry = typeof WeakMap === "function" ? new WeakMap() : new Map();

    function createContentLifecycle({
        window: win = globalThis.window,
        document: doc = globalThis.document,
        chromeApi = globalThis.chrome,
        onRoute = () => {},
        onRefresh = () => {},
        onDashboardHydrate = () => {},
        onMutation = () => true,
        onStorageChange = () => {},
        onPause = () => {},
        onResume = () => {},
        onDispose = () => {},
        debounceMs = 80,
        maxMutationRefreshes = 8,
        mutationWindowMs = 1000,
        now = () => Date.now(),
        setTimer = setTimeout,
        clearTimer = clearTimeout,
        mutationObserver: MutationObserverClass = win?.MutationObserver || globalThis.MutationObserver,
        isOwnedMutation: ownedMutationPredicate = null
    } = {}) {
        if (!doc) return { init() {}, refresh() {}, pause() {}, resume() {}, dispose() {} };
        const existing = registry.get(doc) || doc[CONTROLLER_SLOT];
        if (existing) return existing;

        let disposed = false;
        let initialized = false;
        let paused = false;
        let timer = null;
        let observer = null;
        let storageListener = null;
        let oldPushState = null;
        let oldReplaceState = null;
        let pushWrapper = null;
        let replaceWrapper = null;
        let routeListener = null;
        let hashRouteListener = null;
        let pagehideListener = null;
        let pageshowListener = null;
        let unloadListener = null;
        let markerOwner = false;
        let mutationWindowStarted = null;
        let mutationRefreshCount = 0;
        let api;

        function isOwnedNode(node) {
            let current = node;
            while (current) {
                const id = current.getAttribute?.("id") || current.id;
                if (id === SIDEBAR_ROOT_ID || id === SIDEBAR_RECOVERY_ID || id === SETTINGS_OVERLAY_ID) return true;
                if (current.getAttribute?.("data-apstudycanvas-owned") === "true" || current.getAttribute?.("data-apstudycanvas-sidebar-mounted") === "1") return true;
                const className = String(current.getAttribute?.("class") || current.className || "");
                if (className.split(/\s+/).some((name) => name === "apstudycanvas-sidebar" || name.startsWith("apstudycanvas-sidebar-"))) return true;
                current = current.parentNode;
            }
            return false;
        }
        function isOwnedMutationRecord(record) {
            if (!record) return false;
            if (typeof ownedMutationPredicate === "function") {
                try { return ownedMutationPredicate(record) === true; } catch (error) {}
            }
            if (isOwnedNode(record.target)) return true;
            if (record.type === "attributes" && record.attributeName === "style" && String(record.target?.getAttribute?.("style") || "").includes("--apstudy-sidebar-width")) return true;
            // A host can be inserted beneath a Canvas-owned parent, so the
            // record target alone is not enough to establish ownership. Pure
            // APStudy insertions are self-rendering work; a removal is never
            // ignored because Canvas may have replaced our host and needs the
            // normal, bounded recovery pass.
            const added = [...(record.addedNodes || [])];
            const removed = [...(record.removedNodes || [])];
            return added.length > 0 && removed.length === 0 && added.every((node) => isOwnedNode(node));
        }

        function clearRefreshTimer() {
            if (timer === null) return;
            clearTimer(timer);
            timer = null;
        }

        function resetMutationBudget() {
            mutationWindowStarted = null;
            mutationRefreshCount = 0;
        }

        function refresh(reason = "manual") {
            if (disposed || paused) return false;
            if (reason === "mutation") {
                const current = Number(now()) || 0;
                if (mutationWindowStarted === null || current - mutationWindowStarted >= mutationWindowMs) {
                    mutationWindowStarted = current;
                    mutationRefreshCount = 0;
                }
                if (mutationRefreshCount >= Math.max(0, Number(maxMutationRefreshes) || 0)) return false;
                mutationRefreshCount += 1;
            }
            clearRefreshTimer();
            timer = setTimer(() => {
                timer = null;
                if (!disposed && !paused) {
                    try { onRefresh(reason); } catch (error) {}
                    try { onDashboardHydrate(reason); } catch (error) {}
                }
            }, Math.max(0, Number(debounceMs) || 0));
            return true;
        }

        function route(reason = "history") {
            if (disposed || paused) return;
            resetMutationBudget();
            try { onRoute({ reason, href: win?.location?.href || "", path: win?.location?.pathname || "" }); } catch (error) {}
            refresh(reason);
        }

        function patchHistory() {
            if (!win?.history) return;
            oldPushState = typeof win.history.pushState === "function" ? win.history.pushState : null;
            oldReplaceState = typeof win.history.replaceState === "function" ? win.history.replaceState : null;
            const wrap = (original) => function (...args) {
                const result = original.apply(this, args);
                route("history");
                return result;
            };
            try {
                if (oldPushState) {
                    pushWrapper = wrap(oldPushState);
                    win.history.pushState = pushWrapper;
                }
                if (oldReplaceState) {
                    replaceWrapper = wrap(oldReplaceState);
                    win.history.replaceState = replaceWrapper;
                }
            } catch (error) {}
        }

        function addStorageListener() {
            if (storageListener || !chromeApi?.storage?.onChanged?.addListener) return;
            storageListener = (changes, areaName) => {
                if (disposed || paused) return;
                try { onStorageChange(changes || {}, areaName); } catch (error) {}
            };
            chromeApi.storage.onChanged.addListener(storageListener);
        }

        function init() {
            if (disposed || initialized) return api;
            if (doc.documentElement?.getAttribute?.(MARKER) === "1") return api;
            initialized = true;
            doc.documentElement?.setAttribute?.(MARKER, "1");
            markerOwner = true;
            patchHistory();
            routeListener = () => route("popstate");
            win?.addEventListener?.("popstate", routeListener);
            hashRouteListener = () => route("hashchange");
            win?.addEventListener?.("hashchange", hashRouteListener);
            pagehideListener = (event) => {
                if (event?.persisted) pause("bfcache");
                else dispose("pagehide");
            };
            pageshowListener = (event) => { if (event?.persisted) resume("bfcache"); };
            unloadListener = () => dispose("unload");
            win?.addEventListener?.("pagehide", pagehideListener);
            win?.addEventListener?.("pageshow", pageshowListener);
            win?.addEventListener?.("unload", unloadListener);
            addStorageListener();
            const target = doc.documentElement;
            if (target && typeof MutationObserverClass === "function") {
                observer = new MutationObserverClass((records) => {
                    if (disposed || paused) return;
                    if (Array.isArray(records) && records.length && records.every(isOwnedMutationRecord)) return;
                    let shouldRefresh = true;
                    try { shouldRefresh = onMutation(records) !== false; } catch (error) {}
                    if (shouldRefresh) refresh("mutation");
                });
                observer.observe(target, { childList: true, subtree: true });
            }
            refresh("init");
            return api;
        }

        function pause(reason = "pause") {
            if (disposed || paused) return;
            paused = true;
            clearRefreshTimer();
            observer?.disconnect?.();
            try { onPause({ reason }); } catch (error) {}
        }

        function resume(reason = "resume") {
            if (disposed || !paused) return;
            paused = false;
            const target = doc.documentElement;
            if (observer && target) observer.observe(target, { childList: true, subtree: true });
            try { onResume({ reason }); } catch (error) {}
            resetMutationBudget();
            refresh("pageshow");
        }

        function dispose(reason = "dispose") {
            if (disposed) return;
            disposed = true;
            clearRefreshTimer();
            observer?.disconnect?.();
            if (storageListener) chromeApi?.storage?.onChanged?.removeListener?.(storageListener);
            storageListener = null;
            if (oldPushState && win?.history?.pushState === pushWrapper) win.history.pushState = oldPushState;
            if (oldReplaceState && win?.history?.replaceState === replaceWrapper) win.history.replaceState = oldReplaceState;
            if (routeListener) win?.removeEventListener?.("popstate", routeListener);
            if (hashRouteListener) win?.removeEventListener?.("hashchange", hashRouteListener);
            if (pagehideListener) win?.removeEventListener?.("pagehide", pagehideListener);
            if (pageshowListener) win?.removeEventListener?.("pageshow", pageshowListener);
            if (unloadListener) win?.removeEventListener?.("unload", unloadListener);
            if (markerOwner) doc.documentElement?.removeAttribute?.(MARKER);
            try { onDispose({ reason }); } catch (error) {}
            initialized = false;
            paused = false;
            markerOwner = false;
            if (registry.get(doc) === api) registry.delete(doc);
            if (doc[CONTROLLER_SLOT] === api) {
                try { delete doc[CONTROLLER_SLOT]; } catch (error) { doc[CONTROLLER_SLOT] = null; }
            }
        }

        api = Object.freeze({
            init,
            refresh,
            pause,
            resume,
            dispose,
            isInitialized: () => initialized,
            isPaused: () => paused,
            isDisposed: () => disposed,
            hasObserver: () => Boolean(observer),
            hasStorageListener: () => Boolean(storageListener)
        });
        registry.set(doc, api);
        try { doc[CONTROLLER_SLOT] = api; } catch (error) {}
        return api;
    }

    return Object.freeze({ MARKER, createContentLifecycle });
}));
