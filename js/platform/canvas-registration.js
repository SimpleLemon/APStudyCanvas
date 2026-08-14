(function (root, factory) {
    "use strict";

    const contract = root?.APStudyCanvasPlatform?.Contract || (typeof require === "function" ? require("./contract.js") : null);
    const api = factory(contract);
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasPlatform = Object.assign(root.APStudyCanvasPlatform || {}, { CanvasRegistration: api });
}(typeof globalThis !== "undefined" ? globalThis : this, function (contract) {
    "use strict";

    const DEFAULT_CANVAS_ORIGIN = "https://canvas.emory.edu";
    const SCRIPT_PREFIX = "apstudycanvas-canvas-";
    // Keep this list in the same order as manifest.json. Dynamic registration
    // must expose the same isolated-world module namespace before content.js.
    const CANVAS_CONTENT_SCRIPTS = Object.freeze([
        "css/darkmodecss.js",
        "js/canvas-adapter/contracts.js",
        "js/canvas-adapter/identity.js",
        "js/canvas-adapter/normalizers.js",
        "js/canvas-adapter/pagination.js",
        "js/canvas-adapter/batch.js",
        "js/canvas-adapter/protocol.js",
        "js/canvas-adapter/extractor.js",
        "js/content/context.js",
        "js/content/sync-extraction.js",
        "js/content/sidebar.js",
        "js/content/lifecycle.js",
        "js/content/context-guard.js",
        "js/content/calendar-extension/calendar-extension.v1.js",
        "js/content/calendar-overlay.js",
        "js/content.js"
    ]);
    const CANVAS_JS = CANVAS_CONTENT_SCRIPTS;
    const CANVAS_CSS = Object.freeze(["css/content.css", "js/content/calendar-extension/calendar-extension.v1.css"]);

    function patternForOrigin(origin) {
        const normalized = normalizeCanvasOrigin(origin);
        return normalized ? `${normalized}/*` : null;
    }

    function scriptIdForOrigin(origin) {
        let hash = 2166136261;
        for (const character of origin) {
            hash ^= character.charCodeAt(0);
            hash = Math.imul(hash, 16777619);
        }
        return `${SCRIPT_PREFIX}${(hash >>> 0).toString(16)}`;
    }

    function normalizeCanvasOrigin(value) {
        if (typeof value !== "string" || !value.trim()) return null;
        try {
            const candidate = value.trim();
            const url = new URL(candidate.includes("://") ? candidate : `https://${candidate}`);
            if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
            if (url.pathname !== "" && url.pathname !== "/") return null;
            const labels = url.hostname.toLowerCase().split(".");
            if (!url.hostname || url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]" || labels.length < 2 || labels.some((label) => !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) return null;
            const origin = url.origin;
            if (!origin || origin === contract.NEST_ORIGIN) return null;
            return origin;
        } catch (error) {
            return null;
        }
    }

    function normalizeOriginList(value) {
        const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
        return Array.from(new Set(values.map(normalizeCanvasOrigin).filter(Boolean)));
    }

    function apiAvailable(chromeApi) {
        return Boolean(
            chromeApi?.permissions?.contains &&
            chromeApi?.scripting?.getRegisteredContentScripts &&
            chromeApi?.scripting?.registerContentScripts &&
            chromeApi?.scripting?.unregisterContentScripts
        );
    }

    function exactRegisteredScript(script, origin) {
        const pattern = patternForOrigin(origin);
        return Boolean(script && script.id === scriptIdForOrigin(origin) && Array.isArray(script.matches) && script.matches.length === 1 && script.matches[0] === pattern);
    }

    function createCanvasRegistration({ chromeApi = globalThis.chrome } = {}) {
        async function registered() {
            return chromeApi.scripting.getRegisteredContentScripts();
        }

        async function ensureOrigin(rawOrigin, options = {}) {
            const { configuredOrigins = [], verifiedOrigins } = options;
            const origin = normalizeCanvasOrigin(rawOrigin);
            if (origin === DEFAULT_CANVAS_ORIGIN) return { ok: true, state: "already_static", origin };
            const configured = new Set(normalizeOriginList(configuredOrigins));
            if (!origin || !configured.has(origin)) return { ok: false, code: "CANVAS_ORIGIN_NOT_CONFIGURED" };
            // The background's first permission request is intentionally a
            // configured-only compatibility path. Reconciliation always
            // supplies verifiedOrigins, so registration for a custom origin
            // cannot proceed without both account verification and permission.
            if (Object.prototype.hasOwnProperty.call(options, "verifiedOrigins") && !new Set(normalizeOriginList(verifiedOrigins)).has(origin)) {
                return { ok: false, code: "CANVAS_ORIGIN_NOT_VERIFIED", origin };
            }
            if (!apiAvailable(chromeApi)) return { ok: false, code: "browser_unsupported", origin };
            const pattern = patternForOrigin(origin);
            let permitted;
            try { permitted = await chromeApi.permissions.contains({ origins: [pattern] }); } catch (error) {
                return { ok: false, code: "browser_unsupported", origin };
            }
            if (!permitted) return { ok: false, code: "permission_required", origin, permission: pattern };
            const id = scriptIdForOrigin(origin);
            try {
                const existing = await registered();
                const matching = (existing || []).find((script) => script.id === id);
                const sameScripts = Array.isArray(matching?.js) && matching.js.length === CANVAS_CONTENT_SCRIPTS.length && matching.js.every((script, index) => script === CANVAS_CONTENT_SCRIPTS[index]);
                const sameCss = Array.isArray(matching?.css) && matching.css.length === CANVAS_CSS.length && matching.css.every((sheet, index) => sheet === CANVAS_CSS[index]);
                const sameRunAt = matching?.runAt === undefined || matching.runAt === "document_start";
                if (matching && Array.isArray(matching.matches) && matching.matches.length === 1 && matching.matches[0] === pattern && sameScripts && sameCss && sameRunAt) {
                    return { ok: true, state: "already_registered", origin, id };
                }
                if (matching) await chromeApi.scripting.unregisterContentScripts({ ids: [id] });
                await chromeApi.scripting.registerContentScripts([{
                    id,
                    matches: [pattern],
                    js: CANVAS_CONTENT_SCRIPTS.slice(),
                    css: CANVAS_CSS.slice(),
                    runAt: "document_start"
                }]);
                return { ok: true, state: "registered", origin, id };
            } catch (error) {
                return { ok: false, code: "browser_unsupported", origin };
            }
        }

        async function unregisterOrigin(rawOrigin) {
            const origin = normalizeCanvasOrigin(rawOrigin);
            if (!origin || origin === DEFAULT_CANVAS_ORIGIN) return { ok: true, state: "already_static", origin };
            if (!apiAvailable(chromeApi)) return { ok: false, code: "browser_unsupported", origin };
            const id = scriptIdForOrigin(origin);
            try {
                const existing = await registered();
                const matching = (existing || []).find((script) => exactRegisteredScript(script, origin));
                if (!matching) return { ok: true, state: "already_unregistered", origin, id };
                await chromeApi.scripting.unregisterContentScripts({ ids: [id] });
                return { ok: true, state: "unregistered", origin, id };
            } catch (error) {
                return { ok: false, code: "browser_unsupported", origin };
            }
        }

        async function reconcile({ configuredOrigins = [], verifiedOrigins = [] } = {}) {
            const configured = normalizeOriginList(configuredOrigins);
            const verified = new Set(normalizeOriginList(verifiedOrigins));
            const eligible = configured.filter((origin) => origin === DEFAULT_CANVAS_ORIGIN || verified.has(origin));
            if (!apiAvailable(chromeApi)) {
                return eligible.map((origin) => ({ ok: origin === DEFAULT_CANVAS_ORIGIN, code: origin === DEFAULT_CANVAS_ORIGIN ? undefined : "browser_unsupported", origin }));
            }
            const desiredIds = new Set(eligible.filter((origin) => origin !== DEFAULT_CANVAS_ORIGIN).map(scriptIdForOrigin));
            try {
                const existing = await registered();
                const staleIds = (existing || []).filter((script) => script.id?.startsWith(SCRIPT_PREFIX) && !desiredIds.has(script.id)).map((script) => script.id);
                if (staleIds.length) await chromeApi.scripting.unregisterContentScripts({ ids: staleIds });
            } catch (error) {
                return eligible.map((origin) => ({ ok: false, code: "browser_unsupported", origin }));
            }
            return Promise.all(eligible.map((origin) => ensureOrigin(origin, { configuredOrigins: configured, verifiedOrigins: Array.from(verified) })));
        }

        return Object.freeze({ ensureOrigin, unregisterOrigin, reconcile, patternForOrigin, apiAvailable: () => apiAvailable(chromeApi) });
    }

    return Object.freeze({
        DEFAULT_CANVAS_ORIGIN,
        SCRIPT_PREFIX,
        CANVAS_JS,
        CANVAS_CONTENT_SCRIPTS,
        CANVAS_CSS,
        patternForOrigin,
        scriptIdForOrigin,
        exactRegisteredScript,
        normalizeCanvasOrigin,
        apiAvailable,
        createCanvasRegistration
    });
}));
