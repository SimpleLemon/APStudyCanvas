(function (root, factory) {
    "use strict";
    const api = factory();
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasWorkspaceFoundation = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const ROUTES = Object.freeze(["settings", "grades", "planner", "notes", "study"]);
    const ROUTE_SET = new Set(ROUTES);

    function cleanText(value, max = 160) {
        return typeof value === "string"
            ? value.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, max)
            : "";
    }

    function normalizeRoute(value) {
        const route = cleanText(value, 32).toLowerCase();
        return ROUTE_SET.has(route) ? route : "settings";
    }

    function parseRoute(search) {
        let query;
        try { query = new URLSearchParams(typeof search === "string" ? search : ""); }
        catch (error) { query = new URLSearchParams(); }
        return Object.freeze({
            name: normalizeRoute(query.get("route")),
            category: cleanText(query.get("category"), 64) || "overview"
        });
    }

    function routeUrl(href, route, category) {
        const url = new URL(href);
        const next = normalizeRoute(route);
        if (next === "settings") url.searchParams.delete("route");
        else url.searchParams.set("route", next);
        if (next !== "settings" || !category || category === "overview") url.searchParams.delete("category");
        else url.searchParams.set("category", cleanText(category, 64));
        return url.href;
    }

    function clone(value) {
        if (value === undefined) return undefined;
        return JSON.parse(JSON.stringify(value));
    }

    function verifiedAccountContext(controllerState) {
        const state = controllerState && typeof controllerState === "object" ? controllerState : {};
        const canvas = state.canvas && typeof state.canvas === "object" ? state.canvas : {};
        const binding = canvas.canvasBinding && typeof canvas.canvasBinding === "object" ? canvas.canvasBinding : {};
        const canvasAccountKey = /^[a-f0-9]{64}$/.test(String(binding.accountKey || "")) ? String(binding.accountKey) : null;
        const canvasOrigin = (() => {
            try {
                const url = new URL(String(binding.origin || ""));
                return url.protocol === "https:" && !url.username && !url.password ? url.origin : null;
            } catch (error) { return null; }
        })();
        const identity = state.identity && typeof state.identity === "object" ? state.identity : {};
        const nestIdentity = identity.state === "authenticated" ? cleanText(identity.identity, 160) || null : null;
        const canvasVerified = Boolean(canvasAccountKey && canvasOrigin);
        const nestVerified = Boolean(nestIdentity);
        return Object.freeze({
            scope: canvasVerified ? `canvas:${canvasAccountKey}` : nestVerified ? `nest:${nestIdentity}` : null,
            canvas: Object.freeze({
                verified: canvasVerified,
                accountKey: canvasVerified ? canvasAccountKey : null,
                origin: canvasVerified ? canvasOrigin : null,
                accountId: canvasVerified && /^\d+$/.test(String(binding.canvasUserId || "")) ? String(binding.canvasUserId) : null,
                profile: clone(canvas.profile || null)
            }),
            nest: Object.freeze({
                verified: nestVerified,
                identity: nestVerified ? nestIdentity : null,
                profile: nestVerified ? clone(identity.profile || null) : null,
                linkedAccounts: nestVerified && Array.isArray(identity.linkedAccounts) ? clone(identity.linkedAccounts) : [],
                capabilities: nestVerified ? clone(state.capabilities || identity.capabilities || null) : null,
                consent: nestVerified ? clone(state.consent || null) : null
            })
        });
    }

    function normalizeHooks(module, mounted) {
        const source = mounted && typeof mounted === "object" ? mounted : module;
        return Object.freeze({
            routeUpdate: typeof source?.routeUpdate === "function" ? source.routeUpdate.bind(source) : null,
            queryDirty: typeof source?.queryDirty === "function" ? source.queryDirty.bind(source) : () => false,
            dispose: typeof source?.dispose === "function" ? source.dispose.bind(source) : () => {}
        });
    }

    function createModuleHost({ modules = {}, context = {}, beforeRoute, afterRoute, confirmLeave } = {}) {
        let current = null;
        let transition = null;
        let disposed = false;

        async function navigate(route, detail = {}) {
            const next = normalizeRoute(route);
            if (disposed) return { ok: false, code: "WORKSPACE_HOST_DISPOSED" };
            if (transition) return { ok: false, code: "WORKSPACE_ROUTE_PENDING", route: current?.route || null };
            transition = (async () => {
                if (current?.route === next) {
                    await current.hooks.routeUpdate?.(Object.freeze({ name: next, ...detail }), context);
                    return { ok: true, route: next, reused: true };
                }
                const dirty = current ? await current.hooks.queryDirty() === true : false;
                if (dirty && typeof confirmLeave === "function" && await confirmLeave(current.route, next) !== true) {
                    return { ok: false, code: "WORKSPACE_DIRTY_BLOCKED", route: current.route };
                }
                await beforeRoute?.(current?.route || null, next, { dirty });
                if (current) await current.hooks.dispose("route-change");
                current = null;
                const module = modules[next];
                if (!module || typeof module.mount !== "function") return { ok: false, code: "WORKSPACE_MODULE_MISSING", route: next };
                const routeState = Object.freeze({ name: next, ...detail });
                const mounted = await module.mount(context, routeState);
                current = { route: next, hooks: normalizeHooks(module, mounted) };
                await afterRoute?.(next, routeState);
                return { ok: true, route: next, reused: false };
            })();
            try { return await transition; }
            catch (error) {
                return { ok: false, code: cleanText(error?.message, 80) || "WORKSPACE_ROUTE_FAILED", route: current?.route || null };
            }
            finally { transition = null; }
        }

        async function dispose(reason = "host-dispose") {
            if (disposed) return;
            disposed = true;
            const active = current;
            current = null;
            await active?.hooks.dispose(reason);
        }

        return Object.freeze({
            navigate,
            dispose,
            get route() { return current?.route || null; },
            queryDirtySync() {
                if (!current) return false;
                const result = current.hooks.queryDirty();
                // Async modules must conservatively guard the synchronous unload event.
                return result === true || Boolean(result && typeof result.then === "function");
            },
            async queryDirty() { return current ? await current.hooks.queryDirty() === true : false; }
        });
    }

    return Object.freeze({ ROUTES, normalizeRoute, parseRoute, routeUrl, verifiedAccountContext, createModuleHost });
}));
