(function (root, factory) {
    "use strict";

    const api = factory();
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasPlatform = Object.assign(root.APStudyCanvasPlatform || {}, { ScriptBlocker: api });
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    // Instructure serves Canvas production bundles from one CloudFront
    // distribution. Webpack chunk ids are stable across deploys; only the
    // content hash suffix after "-chunk-" rotates, so blocking by
    // "<id>-chunk-" survives Instructure's frequent rebuilds.
    const CANVAS_CHUNK_CDN_HOST = "du11hjcvx0uqb.cloudfront.net";
    const CANVAS_CHUNK_PATH_PREFIX = "/dist/webpack-production/";

    // Fingerprinted from the live dashboard resource list: the others carry
    // tinymce, /api/v1/media_objects, and kaltura markers (editor + media
    // player code the dashboard never invokes for students).
    //
    // CALIBRATION UPDATE: the planner entry (chunk 929552) has been removed.
    // Instructure's rebuild reassigned that id to the dashboard feature
    // bundle (featureBundles.ts -> Object.dashboard), so blocking it left
    // the dashboard as permanent skeletons and the course cards never
    // rendered. Chunk ids are not a stable fingerprint after all; do not
    // re-add a planner block until the live planner chunk id has been
    // re-fingerprinted against the current build.
    const DASHBOARD_CHUNK_BLOCKS = Object.freeze([
        Object.freeze({ key: "editor_rce", chunkId: "468836" }),
        Object.freeze({ key: "editor_plugins", chunkId: "833875" }),
        Object.freeze({ key: "media_player", chunkId: "549009" }),
        Object.freeze({ key: "media_kaltura", chunkId: "465767" })
    ]);

    const TOOL_SCRIPTS_RULESET_ID = "ruleset_tool_scripts";

    // The static content-script match. Configured custom Canvas origins are
    // merged in by the background coordinator from the user's settings.
    const DEFAULT_CANVAS_ORIGINS = Object.freeze(["https://canvas.emory.edu"]);

    function normalizeAllowedOrigins(origins) {
        const list = (Array.isArray(origins) ? origins : []).map((value) => {
            try {
                const url = new URL(String(value));
                return url.protocol === "https:" ? url.origin : null;
            } catch (error) {
                return null;
            }
        }).filter(Boolean);
        return Object.freeze(Array.from(new Set([...DEFAULT_CANVAS_ORIGINS, ...list])));
    }

    function isDashboardPath(pathname) {
        return pathname === "/" || pathname === "/dashboard" || pathname.startsWith("/dashboard/");
    }

    function isDashboardUrl(value, allowedOrigins = DEFAULT_CANVAS_ORIGINS) {
        if (typeof value !== "string" || value.length > 2048) return false;
        try {
            const url = new URL(value);
            return url.protocol === "https:"
                && normalizeAllowedOrigins(allowedOrigins).includes(url.origin)
                && isDashboardPath(url.pathname);
        } catch (error) {
            return false;
        }
    }

    // Only the editor switch maps to chunk blocks. The former planner switch
    // is compatibility-only: its old fingerprint was reassigned to the
    // dashboard bundle and must never be consulted here.
    function enabledChunkIds(settings) {
        const ids = [];
        if (settings?.editor === true) {
            DASHBOARD_CHUNK_BLOCKS.forEach((block) => ids.push(block.chunkId));
        }
        return Object.freeze(ids);
    }

    function chunkUrlFilter(chunkId) {
        return `||${CANVAS_CHUNK_CDN_HOST}${CANVAS_CHUNK_PATH_PREFIX}${chunkId}-chunk-`;
    }

    // Session rule ids must be unique per tab and deterministic so a later
    // removal pass can find them without keeping worker-global state alive.
    function sessionRuleId(tabId, index) {
        return (Math.abs(Math.trunc(Number(tabId)) || 0) % 100000000) * 10 + index + 1;
    }

    function chunkSessionRules(tabId, chunkIds) {
        return (Array.isArray(chunkIds) ? chunkIds : []).map((chunkId, index) => ({
            id: sessionRuleId(tabId, index),
            priority: 1,
            condition: {
                tabIds: [tabId],
                urlFilter: chunkUrlFilter(chunkId),
                resourceTypes: ["script"]
            },
            action: { type: "block" }
        }));
    }

    function createScriptBlockCoordinator({ chromeApi, readSettings } = {}) {
        const dnr = chromeApi?.declarativeNetRequest;
        const dnrReady = Boolean(
            dnr
            && typeof dnr.getSessionRules === "function"
            && typeof dnr.updateSessionRules === "function"
            && typeof dnr.updateEnabledRulesets === "function"
        );

        async function currentSettings() {
            try {
                return (await readSettings?.()) || {};
            } catch (error) {
                return {};
            }
        }

        function rulesForTab(rules, tabId) {
            return (rules || [])
                .filter((rule) => Array.isArray(rule?.condition?.tabIds) && rule.condition.tabIds.includes(tabId))
                .map((rule) => rule.id);
        }

        async function removeForTab(tabId) {
            if (!dnrReady || typeof tabId !== "number") return { removed: 0 };
            const rules = await dnr.getSessionRules();
            const staleIds = rulesForTab(rules, tabId);
            if (staleIds.length) await dnr.updateSessionRules({ removeRuleIds: staleIds });
            return { removed: staleIds.length };
        }

        async function applyForTab(tabId, url) {
            if (!dnrReady || typeof tabId !== "number") return { blocked: 0 };
            const settings = await currentSettings();
            const chunkIds = isDashboardUrl(url, settings.origins) ? enabledChunkIds(settings) : [];
            const rules = await dnr.getSessionRules();
            const staleIds = rulesForTab(rules, tabId);
            const addRules = chunkIds.length ? chunkSessionRules(tabId, chunkIds) : [];
            if (staleIds.length || addRules.length) {
                await dnr.updateSessionRules({ removeRuleIds: staleIds, addRules });
            }
            return { blocked: addRules.length, removed: staleIds.length };
        }

        async function syncAllTabs() {
            if (!dnrReady) return { tabs: 0 };
            const tabs = await chromeApi.tabs?.query?.({}) || [];
            let touched = 0;
            for (const tab of tabs) {
                if (typeof tab?.id !== "number") continue;
                await applyForTab(tab.id, tab.url || tab.pendingUrl || "");
                touched += 1;
            }
            return { tabs: touched };
        }

        async function applyToolRuleset() {
            if (!dnrReady) return { enabled: null };
            const settings = await currentSettings();
            if (settings.tool === true) {
                await dnr.updateEnabledRulesets({ enableRulesetIds: [TOOL_SCRIPTS_RULESET_ID] });
            } else {
                await dnr.updateEnabledRulesets({ disableRulesetIds: [TOOL_SCRIPTS_RULESET_ID] });
            }
            return { enabled: settings.tool === true };
        }

        async function syncFromSettings() {
            const toolResult = await applyToolRuleset();
            const tabResult = await syncAllTabs();
            return { ...toolResult, ...tabResult };
        }

        // Content-side fail-safe: when a dashboard with blocks active never
        // renders its cards, the tab reports back and this session drops its
        // rules so the next navigation loads unmodified Canvas.
        async function handleReport(tabId) {
            return removeForTab(tabId);
        }

        function attach() {
            const tabs = chromeApi?.tabs;
            if (tabs?.onUpdated?.addListener) {
                tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
                    if (typeof tabId !== "number") return;
                    const url = typeof changeInfo?.url === "string"
                        ? changeInfo.url
                        : (changeInfo?.status === "loading" && typeof tab?.url === "string" ? tab.url : null);
                    if (!url) return;
                    Promise.resolve(applyForTab(tabId, url)).catch(() => {});
                });
            }
            if (tabs?.onRemoved?.addListener) {
                tabs.onRemoved.addListener((tabId) => {
                    if (typeof tabId !== "number") return;
                    Promise.resolve(removeForTab(tabId)).catch(() => {});
                });
            }
        }

        return Object.freeze({
            isReady: () => dnrReady,
            attach,
            applyForTab,
            removeForTab,
            syncAllTabs,
            applyToolRuleset,
            syncFromSettings,
            handleReport
        });
    }

    return Object.freeze({
        CANVAS_CHUNK_CDN_HOST,
        CANVAS_CHUNK_PATH_PREFIX,
        DEFAULT_CANVAS_ORIGINS,
        DASHBOARD_CHUNK_BLOCKS,
        TOOL_SCRIPTS_RULESET_ID,
        normalizeAllowedOrigins,
        isDashboardPath,
        isDashboardUrl,
        enabledChunkIds,
        chunkUrlFilter,
        sessionRuleId,
        chunkSessionRules,
        createScriptBlockCoordinator
    });
}));
