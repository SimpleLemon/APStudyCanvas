(function (root, factory) {
    "use strict";

    const contract = root?.APStudyCanvasPlatform?.Contract || (typeof require === "function" ? require("./contract.js") : null);
    const api = factory(contract);
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasPlatform = Object.assign(root.APStudyCanvasPlatform || {}, { OverlayLauncher: api });
}(typeof globalThis !== "undefined" ? globalThis : this, function (contract) {
    "use strict";

    const DEFAULT_CANVAS_ORIGIN = "https://canvas.emory.edu";
    const WORKSPACE_TAB_URL = "html/popup.html?view=workspace";
    const RELOAD_READY_TIMEOUT_MS = 15000;
    // Must stay aligned with manifest.json web_accessible_resources.matches.
    // Custom Canvas origins get content scripts, but the overlay iframe is
    // not web-accessible there; those clicks fall through to a workspace tab.
    const OVERLAY_WEB_ACCESSIBLE_ORIGINS = Object.freeze([DEFAULT_CANVAS_ORIGIN]);

    function originOf(url) {
        try {
            const parsed = new URL(String(url || ""));
            return parsed.protocol === "https:" ? parsed.origin : null;
        } catch (error) {
            return null;
        }
    }

    function eligibleOrigins(configuredOrigins) {
        const origins = Array.isArray(configuredOrigins) ? configuredOrigins : [];
        return new Set([DEFAULT_CANVAS_ORIGIN, ...origins.map(originOf).filter(Boolean)]);
    }

    function isEligibleTab(tab, origins) {
        return Number.isInteger(tab?.id) && origins.has(originOf(tab?.url));
    }

    function createOverlayLauncher({
        chromeApi = globalThis.chrome,
        reloadReadyTimeoutMs = RELOAD_READY_TIMEOUT_MS,
        setTimeoutImpl = globalThis.setTimeout,
        clearTimeoutImpl = globalThis.clearTimeout
    } = {}) {
        async function notifyTab(tabId, payload) {
            if (!chromeApi?.tabs?.sendMessage || !Number.isInteger(tabId)) return false;
            const envelope = contract.createEnvelope("OVERLAY_OPEN", { ...payload, tabId });
            try {
                // Frame 0 only: the overlay iframe is an extension document in
                // the same tab and must not receive its own open command.
                const response = await chromeApi.tabs.sendMessage(tabId, envelope, { frameId: 0 });
                // A tab with no content script rejects or answers nothing. Treat
                // an explicit failure payload as ineligible too, so the caller
                // can fall through to tab handoff instead of silently no-oping.
                const result = response?.payload || response;
                return result?.ok !== false;
            } catch (error) {
                return false;
            }
        }

        function reloadTabAndWait(tabId) {
            const tabs = chromeApi?.tabs;
            const onUpdated = tabs?.onUpdated;
            const onRemoved = tabs?.onRemoved;
            if (!Number.isInteger(tabId)
                || typeof tabs?.reload !== "function"
                || typeof onUpdated?.addListener !== "function"
                || typeof onUpdated?.removeListener !== "function"
                || typeof onRemoved?.addListener !== "function"
                || typeof onRemoved?.removeListener !== "function"
                || typeof setTimeoutImpl !== "function"
                || typeof clearTimeoutImpl !== "function") return Promise.resolve(false);

            return new Promise((resolve) => {
                let settled = false;
                let timeoutId;
                const finish = (ready) => {
                    if (settled) return;
                    settled = true;
                    onUpdated.removeListener(handleUpdated);
                    onRemoved.removeListener(handleRemoved);
                    if (timeoutId !== undefined) clearTimeoutImpl(timeoutId);
                    resolve(ready);
                };
                const handleUpdated = (updatedTabId, changeInfo) => {
                    if (updatedTabId === tabId && changeInfo?.status === "complete") finish(true);
                };
                const handleRemoved = (removedTabId) => {
                    if (removedTabId === tabId) finish(false);
                };

                onUpdated.addListener(handleUpdated);
                onRemoved.addListener(handleRemoved);
                const timeoutMs = Number.isFinite(reloadReadyTimeoutMs) && reloadReadyTimeoutMs >= 0
                    ? reloadReadyTimeoutMs
                    : RELOAD_READY_TIMEOUT_MS;
                timeoutId = setTimeoutImpl(() => finish(false), timeoutMs);
                Promise.resolve().then(() => tabs.reload(tabId)).catch(() => finish(false));
            });
        }

        async function focusTab(tab) {
            try {
                if (chromeApi?.tabs?.update) await chromeApi.tabs.update(tab.id, { active: true });
                if (Number.isInteger(tab.windowId) && chromeApi?.windows?.update) await chromeApi.windows.update(tab.windowId, { focused: true });
            } catch (error) {}
        }

        async function openWorkspaceTab(category) {
            if (!chromeApi?.tabs?.create) return { ok: false, code: "OVERLAY_TAB_UNAVAILABLE" };
            let url = chromeApi.runtime?.getURL?.(WORKSPACE_TAB_URL) || WORKSPACE_TAB_URL;
            if (typeof category === "string" && category) {
                try {
                    const parsed = new URL(url, chromeApi.runtime?.getURL?.("/") || "https://extension.invalid/");
                    parsed.searchParams.set("category", category);
                    url = parsed.href;
                } catch (error) {}
            }
            try {
                const created = await chromeApi.tabs.create({ url, active: true });
                return { ok: true, state: "workspace_tab", tabId: Number.isInteger(created?.id) ? created.id : null };
            } catch (error) {
                return { ok: false, code: "OVERLAY_TAB_UNAVAILABLE" };
            }
        }

        async function launch(clickedTab, { configuredOrigins = [], flags = {}, category } = {}) {
            if (flags.canvasOverlay === false) return { ok: false, code: "FEATURE_DISABLED_CANVAS_OVERLAY" };
            // configuredOrigins still arrive from the worker, but overlay
            // targeting is WAR matches only. Custom Canvas origins are not
            // web-accessible for html/popup.html.
            const overlayOrigins = new Set(OVERLAY_WEB_ACCESSIBLE_ORIGINS);
            const payload = { source: "toolbar", ...(typeof category === "string" && category ? { category } : {}) };

            if (isEligibleTab(clickedTab, overlayOrigins)) {
                if (await notifyTab(clickedTab.id, payload)) {
                    return { ok: true, state: "opened", tabId: clickedTab.id };
                }
                // An extension reload can leave the existing document without
                // its receiver. Reloading the same tab gives the manifest's
                // content scripts a fresh isolated world without duplicating
                // declarations or listeners in the stale one.
                if (await reloadTabAndWait(clickedTab.id) && await notifyTab(clickedTab.id, payload)) {
                    return { ok: true, state: "opened", tabId: clickedTab.id };
                }
                return { ok: false, code: "OVERLAY_LAUNCH_FAILED", tabId: clickedTab.id };
            }

            // The clicked tab is not overlayable (custom Canvas origin, missing
            // content script, or not Canvas). Hand off only to a WAR-covered
            // Emory tab before falling back to our own workspace page.
            let tabs = [];
            try { tabs = (await chromeApi?.tabs?.query?.({})) || []; } catch (error) { tabs = []; }
            for (const tab of tabs) {
                if (tab?.id === clickedTab?.id || !isEligibleTab(tab, overlayOrigins)) continue;
                await focusTab(tab);
                if (await notifyTab(tab.id, { ...payload, source: "handoff" })) {
                    return { ok: true, state: "handoff", tabId: tab.id };
                }
            }

            return openWorkspaceTab(category);
        }

        return Object.freeze({ launch });
    }

    return Object.freeze({
        DEFAULT_CANVAS_ORIGIN,
        RELOAD_READY_TIMEOUT_MS,
        WORKSPACE_TAB_URL,
        OVERLAY_WEB_ACCESSIBLE_ORIGINS,
        eligibleOrigins,
        isEligibleTab,
        createOverlayLauncher
    });
}));
