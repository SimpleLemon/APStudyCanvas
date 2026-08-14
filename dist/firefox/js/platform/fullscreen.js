(function (root, factory) {
    "use strict";

    const api = factory();
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasPlatform = Object.assign(root.APStudyCanvasPlatform || {}, { Fullscreen: api });
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const MARGIN = 32;
    const POPUP_URL = "html/popup.html?fullscreen=1";
    const WINDOW_MAPPING_KEY = "platform.tabWindowMappings";

    function apiCall(api, method, ...args) {
        if (!api || typeof api[method] !== "function") return Promise.reject(new Error(`WINDOWS_${method.toUpperCase()}_UNAVAILABLE`));
        try {
            const result = api[method](...args);
            return result && typeof result.then === "function" ? result : Promise.resolve(result);
        } catch (error) {
            return Promise.reject(error);
        }
    }

    async function readMapping(storage) {
        const result = await storage.get("session", WINDOW_MAPPING_KEY);
        return result?.[WINDOW_MAPPING_KEY] && typeof result[WINDOW_MAPPING_KEY] === "object" ? result[WINDOW_MAPPING_KEY] : {};
    }

    async function saveMapping(storage, mapping) {
        await storage.set("session", { [WINDOW_MAPPING_KEY]: mapping });
        return mapping;
    }

    async function associateWindow(storage, windowId, tabId) {
        if (!Number.isInteger(windowId) || !Number.isInteger(tabId)) throw new Error("FULLSCREEN_MAPPING_INVALID");
        const mapping = await readMapping(storage);
        mapping[String(windowId)] = tabId;
        await saveMapping(storage, mapping);
        return mapping;
    }

    async function removeWindow(storage, windowId) {
        if (!Number.isInteger(windowId)) return;
        const mapping = await readMapping(storage);
        delete mapping[String(windowId)];
        await saveMapping(storage, mapping);
    }

    async function fallbackBounds(windowsApi, created) {
        let reference = created || {};
        try { reference = await apiCall(windowsApi, "get", created?.id) || reference; } catch (error) {}
        const width = Math.max(640, Number(reference.width || 1280) - MARGIN * 2);
        const height = Math.max(480, Number(reference.height || 900) - MARGIN * 2);
        return { left: MARGIN, top: MARGIN, width, height, state: "normal" };
    }

    async function openFullscreen({ chromeApi, storage, sourceCanvasTabId, category, flags = {}, popupUrl } = {}) {
        if (flags.browserFullscreen === false) return { ok: false, code: "FEATURE_DISABLED_BROWSER_FULLSCREEN" };
        if (!Number.isInteger(sourceCanvasTabId)) return { ok: false, code: "FULLSCREEN_SOURCE_TAB_REQUIRED" };
        if (!chromeApi?.windows || !storage) return { ok: false, code: "FULLSCREEN_PLATFORM_UNAVAILABLE" };
        let created;
        try {
            let url = popupUrl || chromeApi.runtime?.getURL?.(POPUP_URL) || POPUP_URL;
            if (!popupUrl) {
                const parsed = new URL(url, chromeApi.runtime?.getURL?.("/") || "https://extension.invalid/");
                if (Number.isInteger(sourceCanvasTabId)) parsed.searchParams.set("sourceCanvasTabId", String(sourceCanvasTabId));
                if (typeof category === "string" && category) parsed.searchParams.set("category", category);
                url = parsed.href;
            }
            created = await apiCall(chromeApi.windows, "create", { url, type: "popup", focused: true });
            if (!created?.id || !Number.isInteger(created.id)) throw new Error("FULLSCREEN_WINDOW_CREATE_INVALID");
            await associateWindow(storage, created.id, sourceCanvasTabId);
            let maximized = false;
            try {
                const updated = await apiCall(chromeApi.windows, "update", created.id, { state: "maximized", focused: true });
                maximized = updated?.state === "maximized";
            } catch (error) {}
            if (!maximized) await apiCall(chromeApi.windows, "update", created.id, await fallbackBounds(chromeApi.windows, created));
            return { ok: true, windowId: created.id, sourceCanvasTabId, maximized };
        } catch (error) {
            if (created?.id && typeof chromeApi.windows.remove === "function") {
                try { await apiCall(chromeApi.windows, "remove", created.id); } catch (cleanupError) {}
            }
            return { ok: false, code: error?.message || "FULLSCREEN_OPEN_FAILED" };
        }
    }

    return Object.freeze({ MARGIN, POPUP_URL, WINDOW_MAPPING_KEY, associateWindow, removeWindow, openFullscreen });
}));
