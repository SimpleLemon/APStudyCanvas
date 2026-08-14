(function (root, factory) {
    "use strict";

    const api = factory();
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasPlatform = Object.assign(root.APStudyCanvasPlatform || {}, { CanvasSessionResolver: api });
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const CONTEXT_VERSION = 1;
    const BINDING_KEYS = new Set(["accountKey", "origin", "canvasUserId"]);

    function isPlainObject(value) {
        if (!value || typeof value !== "object" || Array.isArray(value)) return false;
        const prototype = Object.getPrototypeOf(value);
        return prototype === Object.prototype || prototype === null;
    }

    function normalizeOrigin(value, { requireOrigin = false } = {}) {
        if (typeof value !== "string" || !value.trim()) return null;
        const candidate = value.trim();
        try {
            const parsed = new URL(candidate.includes("://") ? candidate : `https://${candidate}`);
            if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
            const hostname = parsed.hostname.toLowerCase();
            const labels = hostname.split(".");
            if (!hostname || hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
                || labels.length < 2 || labels.some((label) => !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) return null;
            if (requireOrigin && parsed.pathname !== "" && parsed.pathname !== "/") return null;
            return parsed.origin;
        } catch (error) {
            return null;
        }
    }

    function normalizeConfiguredOrigins(value) {
        const values = Array.isArray(value)
            ? value
            : value && typeof value !== "string" && typeof value[Symbol.iterator] === "function"
                ? Array.from(value)
                : String(value || "").split(",");
        return new Set(values.map((item) => normalizeOrigin(item, { requireOrigin: true })).filter(Boolean));
    }

    function normalizeIdentifier(value) {
        if (typeof value === "number") {
            if (!Number.isSafeInteger(value)) return null;
            value = String(value);
        }
        if (typeof value !== "string") return null;
        const normalized = value.trim();
        return normalized && !/[\u0000-\u001f\u007f]/.test(normalized) ? normalized : null;
    }

    function normalizeBinding(binding, configuredOrigins) {
        if (!isPlainObject(binding)) return null;
        let keys;
        try { keys = Reflect.ownKeys(binding); } catch (error) { return null; }
        if (keys.length !== BINDING_KEYS.size || keys.some((key) => typeof key !== "string" || !BINDING_KEYS.has(key))) return null;

        const accountKey = normalizeIdentifier(binding.accountKey);
        const origin = normalizeOrigin(binding.origin, { requireOrigin: true });
        const canvasUserId = normalizeIdentifier(binding.canvasUserId);
        if (!accountKey || !origin || !canvasUserId || !configuredOrigins.has(origin)) return null;
        return { accountKey, origin, canvasUserId };
    }

    function tabOrigin(url) {
        if (typeof url !== "string" || !url.trim()) return null;
        try {
            const parsed = new URL(url.trim());
            if (parsed.username || parsed.password) return null;
            return normalizeOrigin(parsed.origin, { requireOrigin: true });
        } catch (error) {
            return null;
        }
    }

    function returnedAccountMatches(value, expected) {
        if (!isPlainObject(value)) return false;
        for (const key of ["accountKey", "account_key", "account"]) {
            if (Object.prototype.hasOwnProperty.call(value, key)) return String(value[key]) === expected;
        }
        return true;
    }

    function contextMatches(value, binding) {
        if (!isPlainObject(value) || value.ok !== true) return false;
        if (normalizeOrigin(value.origin, { requireOrigin: true }) !== binding.origin) return false;
        if (String(value.canvasUser?.id ?? "") !== binding.canvasUserId) return false;
        return returnedAccountMatches(value, binding.accountKey);
    }

    function verificationMatches(value, binding) {
        if (!isPlainObject(value) || value.ok !== true || value.verified !== true) return false;
        if (normalizeOrigin(value.origin, { requireOrigin: true }) !== binding.origin) return false;
        if (String(value.userId ?? "") !== binding.canvasUserId) return false;
        return returnedAccountMatches(value, binding.accountKey);
    }

    function fallbackIdFactory() {
        let next = 0;
        return () => `canvas-session-${++next}`;
    }

    function createCanvasSessionResolver({ tabs, configuredOrigins, idFactory = fallbackIdFactory() } = {}) {
        const configured = normalizeConfiguredOrigins(configuredOrigins);
        const makeRequestId = typeof idFactory === "function" ? idFactory : fallbackIdFactory();
        const sessionBrand = new WeakSet();

        function request(type, payload) {
            const message = { type, version: CONTEXT_VERSION, requestId: makeRequestId() };
            if (payload !== undefined) message.payload = payload;
            return message;
        }

        async function inspectTab(tab, binding) {
            if (!Number.isSafeInteger(tab?.id) || tab.id < 0 || tabOrigin(tab.url) !== binding.origin) return null;
            try {
                const context = await tabs.sendMessage(tab.id, request("GET_CANVAS_CONTEXT"));
                if (!contextMatches(context, binding)) return null;
                const verified = await tabs.sendMessage(tab.id, request("CANVAS_ACCOUNT_VERIFY", {
                    expectedOrigin: binding.origin,
                    expectedUserId: binding.canvasUserId
                }));
                if (!verificationMatches(verified, binding)) return null;
                return { tab, session: Object.freeze({
                    tabId: tab.id,
                    origin: binding.origin,
                    canvasUserId: binding.canvasUserId,
                    accountKey: binding.accountKey
                }) };
            } catch (error) {
                return null;
            }
        }

        async function resolve(binding) {
            const normalized = normalizeBinding(binding, configured);
            if (!normalized || typeof tabs?.query !== "function" || typeof tabs?.sendMessage !== "function") return null;

            let candidates;
            try { candidates = await tabs.query({}); } catch (error) { return null; }
            if (!Array.isArray(candidates)) return null;

            const matches = [];
            for (const tab of candidates) {
                const inspected = await inspectTab(tab, normalized);
                if (inspected) matches.push(inspected);
            }
            matches.sort((left, right) => {
                const rank = (item) => item.tab.active === true && item.tab.currentWindow === true ? 0 : item.tab.active === true ? 1 : 2;
                return rank(left) - rank(right) || left.tab.id - right.tab.id;
            });
            const selected = matches[0];
            if (!selected) return null;
            sessionBrand.add(selected.session);
            return selected.session;
        }

        function isOwnedSession(session) {
            return isPlainObject(session) && sessionBrand.has(session);
        }

        return Object.freeze({ resolve, isOwnedSession });
    }

    return Object.freeze({ createCanvasSessionResolver });
}));
