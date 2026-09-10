(function (root, factory) {
    "use strict";

    const contract = root?.APStudyCanvasPlatform?.Contract || (typeof require === "function" ? require("./contract.js") : null);
    const api = factory(contract);
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasPlatform = Object.assign(root.APStudyCanvasPlatform || {}, { CanvasRegistration: api });
}(typeof globalThis !== "undefined" ? globalThis : this, function (contract) {
    "use strict";

    const DEFAULT_CANVAS_ORIGIN = "https://canvas.emory.edu";
    // This is the static registration authority.  Dynamic origins are added
    // only after the existing configured + permission + verification flow.
    // Consumers that need an origin allowlist must start here, not accept a
    // generic HTTPS URL.
    const STATIC_CANVAS_ORIGINS = Object.freeze([DEFAULT_CANVAS_ORIGIN]);
    const SCRIPT_PREFIX = "apstudycanvas-canvas-";
    const CANVAS_WATCHDOG_SCRIPT = "js/content/sidebar-watchdog.js";
    // Keep this list in the same order as manifest.json. Dynamic registration
    // must expose the same isolated-world module namespace before content.js.
    const CANVAS_CONTENT_SCRIPTS = Object.freeze([
        "js/content/font-faces.js",
        "css/darkmodecss.js",
        "js/canvas-adapter/contracts.js",
        "js/canvas-adapter/identity.js",
        "js/canvas-adapter/normalizers.js",
        "js/canvas-adapter/pagination.js",
        "js/canvas-adapter/batch.js",
        "js/canvas-adapter/protocol.js",
        "js/canvas-adapter/extractor.js",
        "js/settings-schema.js",
        "js/content/canvas-search-index.js",
        "js/content/canvas-search-ui.js",
        "js/content/grade-analytics.js",
        "js/content/grade-analytics-ui.js",
        "js/content/grade-overview.js",
        "js/platform/contract.js",
        "js/content/context.js",
        "js/content/sync-extraction.js",
        "js/content/sidebar-model.js",
        "js/content/sidebar-adapter.js",
        "js/content/sidebar-page-actions.js",
        "js/content/sidebar-course-cache.js",
        "js/content/sidebar-displayed-cards.js",
        "js/content/sidebar.js",
        "js/content/lifecycle.js",
        "js/content/context-guard.js",
        "js/content/calendar-extension/calendar-extension.v1.js",
        "js/content/calendar-overlay.js",
        "js/content/overlay-history.js",
        "js/content/overlay-preview.js",
        "js/content/overlay-host.js",
        "js/content/settings-apply.js",
        "js/content/card-appearance.js",
        "js/content/dashboard-card-watchdog.js",
        "js/content/dashboard-notes.js",
        "js/content/gpa.js",
        "js/content/workspace-model.js",
        "js/content/workspace-ui.js",
        "js/content/todo-time.js",
        "js/content/planner-page-transport.js",
        "js/content/planner-tasks.js",
        "js/content/todo-model.js",
        "js/content/todo-state.js",
        "js/content/todo-streak.js",
        "js/content/todo-api.js",
        "js/content/todo-effects.js",
        "js/content/todo-right-rail.js",
        "js/content/todo-course-cards.js",
        "js/content.js"
    ]);
    const CANVAS_JS = CANVAS_CONTENT_SCRIPTS;
    const CANVAS_CSS = Object.freeze([
        "css/content.css",
        "css/canvas-search.css",
        "css/grade-analytics.css", "css/workspace.css",
        "css/sidebar.css",
        "css/todo-right-rail.css",
        "css/todo-course-cards.css",
        "js/content/calendar-extension/calendar-extension.v1.css"
    ]);

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

    function exactWatchdogScript(script, origin) {
        const pattern = patternForOrigin(origin);
        return Boolean(script && script.id === `${scriptIdForOrigin(origin)}-watchdog` && Array.isArray(script.matches) && script.matches.length === 1 && script.matches[0] === pattern);
    }

    function createCanvasRegistration({ chromeApi = globalThis.chrome } = {}) {
        // Permission events may be delivered while the explicit popup flow is
        // between its exact-origin grant and durable account/config writes.
        // Keep that narrow, in-memory transaction separate from the durable
        // allowlist. It is deliberately lost on a worker restart: an
        // interrupted flow must fail closed rather than leave an unverified
        // registration behind.
        const pendingOrigins = new Set();
        let operationQueue = Promise.resolve();

        function serialize(operation) {
            const result = operationQueue.then(operation, operation);
            operationQueue = result.catch(() => {});
            return result;
        }

        async function registered() {
            return chromeApi.scripting.getRegisteredContentScripts();
        }

        async function permissionGranted(origin) {
            try {
                return Boolean(await chromeApi.permissions.contains({ origins: [patternForOrigin(origin)] }));
            } catch (error) {
                return false;
            }
        }

        async function ensureOriginNow(rawOrigin, options = {}, knownPermission) {
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
            const permitted = knownPermission === undefined ? await permissionGranted(origin) : knownPermission;
            if (!permitted) return { ok: false, code: "permission_required", origin, permission: pattern };
            const id = scriptIdForOrigin(origin);
            const watchdogId = `${id}-watchdog`;
            try {
                const existing = await registered();
                const matching = (existing || []).find((script) => script.id === id);
                const matchingWatchdog = (existing || []).find((script) => script.id === watchdogId);
                const sameScripts = Array.isArray(matching?.js) && matching.js.length === CANVAS_CONTENT_SCRIPTS.length && matching.js.every((script, index) => script === CANVAS_CONTENT_SCRIPTS[index]);
                const sameCss = Array.isArray(matching?.css) && matching.css.length === CANVAS_CSS.length && matching.css.every((sheet, index) => sheet === CANVAS_CSS[index]);
                const sameRunAt = matching?.runAt === undefined || matching.runAt === "document_start";
                const sameWatchdog = Array.isArray(matchingWatchdog?.js) && matchingWatchdog.js.length === 1 && matchingWatchdog.js[0] === CANVAS_WATCHDOG_SCRIPT && (!matchingWatchdog.css || matchingWatchdog.css.length === 0) && matchingWatchdog.world === "MAIN" && (matchingWatchdog.runAt === undefined || matchingWatchdog.runAt === "document_start") && Array.isArray(matchingWatchdog.matches) && matchingWatchdog.matches.length === 1 && matchingWatchdog.matches[0] === pattern;
                if (matching && sameWatchdog && Array.isArray(matching.matches) && matching.matches.length === 1 && matching.matches[0] === pattern && sameScripts && sameCss && sameRunAt) {
                    if (!Object.prototype.hasOwnProperty.call(options, "verifiedOrigins")) pendingOrigins.add(origin);
                    return { ok: true, state: "already_registered", origin, id };
                }
                const staleIds = [matching?.id, matchingWatchdog?.id].filter(Boolean);
                if (staleIds.length) await chromeApi.scripting.unregisterContentScripts({ ids: staleIds });
                const watchdogRegistration = {
                    id: watchdogId,
                    matches: [pattern],
                    js: [CANVAS_WATCHDOG_SCRIPT],
                    runAt: "document_start",
                    world: "MAIN"
                };
                await chromeApi.scripting.registerContentScripts([watchdogRegistration, {
                    id,
                    matches: [pattern],
                    js: CANVAS_CONTENT_SCRIPTS.slice(),
                    css: CANVAS_CSS.slice(),
                    runAt: "document_start"
                }]);
                if (!Object.prototype.hasOwnProperty.call(options, "verifiedOrigins")) pendingOrigins.add(origin);
                return { ok: true, state: "registered", origin, id };
            } catch (error) {
                return { ok: false, code: "browser_unsupported", origin };
            }
        }

        function ensureOrigin(rawOrigin, options = {}) {
            return serialize(() => ensureOriginNow(rawOrigin, options));
        }

        async function unregisterOriginNow(rawOrigin) {
            const origin = normalizeCanvasOrigin(rawOrigin);
            if (!origin || origin === DEFAULT_CANVAS_ORIGIN) return { ok: true, state: "already_static", origin };
            pendingOrigins.delete(origin);
            if (!apiAvailable(chromeApi)) return { ok: false, code: "browser_unsupported", origin };
            const id = scriptIdForOrigin(origin);
            try {
                const existing = await registered();
                const ids = (existing || []).filter((script) => exactRegisteredScript(script, origin) || exactWatchdogScript(script, origin)).map((script) => script.id);
                if (!ids.length) return { ok: true, state: "already_unregistered", origin, id };
                await chromeApi.scripting.unregisterContentScripts({ ids });
                return { ok: true, state: "unregistered", origin, id };
            } catch (error) {
                return { ok: false, code: "browser_unsupported", origin };
            }
        }

        function unregisterOrigin(rawOrigin) {
            return serialize(() => unregisterOriginNow(rawOrigin));
        }

        async function reconcileNow({ configuredOrigins = [], verifiedOrigins = [] } = {}) {
            const configured = normalizeOriginList(configuredOrigins);
            const verified = new Set(normalizeOriginList(verifiedOrigins));
            const eligible = configured.filter((origin) => origin === DEFAULT_CANVAS_ORIGIN || verified.has(origin));
            if (!apiAvailable(chromeApi)) {
                return eligible.map((origin) => ({ ok: origin === DEFAULT_CANVAS_ORIGIN, code: origin === DEFAULT_CANVAS_ORIGIN ? undefined : "browser_unsupported", origin }));
            }
            const permissionStatus = new Map();
            async function permissionFor(origin) {
                if (!permissionStatus.has(origin)) permissionStatus.set(origin, await permissionGranted(origin));
                return permissionStatus.get(origin);
            }
            try {
                const existing = await registered();
                // A durable registration is retained only after all three
                // facts are true: exact optional permission, configured
                // origin, and verified account. A pending origin is the sole
                // short-lived exception while the popup transaction is still
                // running; it must still hold the exact permission.
                const durableOrigins = eligible.filter((origin) => origin !== DEFAULT_CANVAS_ORIGIN);
                const permittedDurable = [];
                for (const origin of durableOrigins) {
                    if (await permissionFor(origin)) permittedDurable.push(origin);
                }
                const permittedPending = [];
                for (const origin of pendingOrigins) {
                    if (await permissionFor(origin)) permittedPending.push(origin);
                    else pendingOrigins.delete(origin);
                }
                const retainedIds = new Set([...permittedDurable, ...permittedPending].map(scriptIdForOrigin));
                const staleIds = (existing || []).filter((script) => script.id?.startsWith(SCRIPT_PREFIX) && !retainedIds.has(script.id) && !retainedIds.has(script.id?.replace(/-watchdog$/, ""))).map((script) => script.id);
                if (staleIds.length) await chromeApi.scripting.unregisterContentScripts({ ids: staleIds });
            } catch (error) {
                return eligible.map((origin) => ({ ok: false, code: "browser_unsupported", origin }));
            }
            const results = [];
            for (const origin of eligible) {
                const result = await ensureOriginNow(origin, { configuredOrigins: configured, verifiedOrigins: Array.from(verified) }, origin === DEFAULT_CANVAS_ORIGIN ? undefined : await permissionFor(origin));
                results.push(result);
                if (result.ok) pendingOrigins.delete(origin);
            }
            return results;
        }

        function reconcile(options = {}) {
            return serialize(() => reconcileNow(options));
        }

        return Object.freeze({ ensureOrigin, unregisterOrigin, reconcile, patternForOrigin, apiAvailable: () => apiAvailable(chromeApi) });
    }

    return Object.freeze({
        DEFAULT_CANVAS_ORIGIN,
        STATIC_CANVAS_ORIGINS,
        SCRIPT_PREFIX,
        CANVAS_JS,
        CANVAS_CONTENT_SCRIPTS,
        CANVAS_WATCHDOG_SCRIPT,
        CANVAS_CSS,
        patternForOrigin,
        scriptIdForOrigin,
        exactRegisteredScript,
        exactWatchdogScript,
        normalizeCanvasOrigin,
        apiAvailable,
        createCanvasRegistration
    });
}));
