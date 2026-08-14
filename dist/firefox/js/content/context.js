(function (root, factory) {
    "use strict";
    const api = factory();
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasContent = Object.assign(root.APStudyCanvasContent || {}, { Context: api });
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const STATIC_CANVAS_ORIGIN = "https://canvas.emory.edu";
    const NEST_ORIGIN = "https://nest.apstudy.org";
    const CONTEXT_VERSION = 1;
    const APPROVED_PAGE_PATTERN = /^\/(?:courses\/\d+(?:\/|$)|dashboard(?:\/|$)|calendar(?:\/|$)|conversations(?:\/|$)|profile(?:\/|$)|groups(?:\/|$)|)$/;
    const SENSITIVE_URL_PART = /(?:access[_-]?token|api[_-]?key|authorization|cookie|credential|csrf|jwt|password|private|secret|session|token)/i;
    const SENSITIVE_SCALAR = /(?:bearer\s+|raw[_-]?csrf|(?:access[_-]?token|authorization|cookie|password|private[_-]?key|secret|session|token)\s*[:=])/i;

    function isPlainObject(value) {
        if (!value || typeof value !== "object" || Array.isArray(value)) return false;
        const prototype = Object.getPrototypeOf(value);
        return prototype === Object.prototype || prototype === null;
    }

    function clone(value) {
        if (value === undefined) return undefined;
        if (typeof structuredClone === "function") return structuredClone(value);
        return JSON.parse(JSON.stringify(value));
    }

    function normalizeCanvasOrigin(value) {
        if (typeof value !== "string" || !value.trim()) return null;
        const candidate = value.trim();
        try {
            const url = new URL(candidate.includes("://") ? candidate : `https://${candidate}`);
            if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
            if (url.pathname !== "" && url.pathname !== "/") return null;
            const labels = url.hostname.toLowerCase().split(".");
            if (!url.hostname || url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]" || labels.length < 2 || labels.some((label) => !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) return null;
            return url.origin;
        } catch (error) {
            return null;
        }
    }

    function normalizeCanvasOrigins(value) {
        const values = Array.isArray(value) ? value : String(value || "").split(",");
        return Array.from(new Set(values.map(normalizeCanvasOrigin).filter((origin) => origin && origin !== NEST_ORIGIN)));
    }

    function verifiedOriginsFromMetadata(metadata) {
        const accounts = Array.isArray(metadata?.accounts) ? metadata.accounts : [];
        return Array.from(new Set(accounts.map((account) => normalizeCanvasOrigin(account?.origin)).filter((origin) => origin && origin !== NEST_ORIGIN)));
    }

    function currentOrigin(location) {
        if (!location) return null;
        return normalizeCanvasOrigin(`${location.protocol}//${location.host}`);
    }

    function isApprovedOrigin(origin, { configuredOrigins = [], verifiedOrigins = [] } = {}) {
        const normalized = normalizeCanvasOrigin(origin);
        if (!normalized) return false;
        if (normalized === STATIC_CANVAS_ORIGIN) return true;
        if (normalized === NEST_ORIGIN) return false;
        const configured = new Set(normalizeCanvasOrigins(configuredOrigins));
        const verified = new Set(normalizeCanvasOrigins(verifiedOrigins));
        return configured.has(normalized) && verified.has(normalized);
    }

    function isApprovedLocation(location, state = {}) {
        const origin = currentOrigin(location);
        return Boolean(origin && isApprovedOrigin(origin, state));
    }

    function cleanName(value) {
        if (typeof value !== "string") return null;
        const name = value.replace(/\s+/g, " ").trim().slice(0, 120);
        return name && !SENSITIVE_SCALAR.test(name) && !/^(?:account|profile|user|log ?in|sign ?in)$/i.test(name) ? name : null;
    }

    function normalizeCanvasUserId(value) {
        if (value === undefined || value === null) return null;
        const id = String(value).trim();
        if (!id || id.length > 120 || !/^[A-Za-z0-9._:@-]+$/.test(id)) return null;
        return id;
    }

    function safeAvatar(value, baseOrigin) {
        if (typeof value !== "string" || !value.trim()) return null;
        try {
            const url = new URL(value, baseOrigin);
            if (url.protocol !== "https:" || url.username || url.password || url.hash || !url.hostname || url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]" || SENSITIVE_SCALAR.test(url.href)) return null;
            if (/\.ics(?:$|[?#])/i.test(url.pathname)) return null;
            for (const [key, parameter] of url.searchParams.entries()) {
                if (SENSITIVE_URL_PART.test(key) || SENSITIVE_SCALAR.test(parameter)) return null;
            }
            return url.href;
        } catch (error) {
            return null;
        }
    }

    function sanitizeCanvasUser(rawUser, origin) {
        const user = isPlainObject(rawUser) ? rawUser : {};
        const id = normalizeCanvasUserId(user.id);
        const name = cleanName(user.name || user.display_name || user.short_name);
        const avatarUrl = safeAvatar(user.avatar_url, origin);
        return { id, name, avatarUrl };
    }

    function buildCanvasBinding({ verifiedContext, context, accountKey, extraction } = {}) {
        const verified = isPlainObject(verifiedContext) ? verifiedContext : {};
        const current = isPlainObject(context) ? context : {};
        if (verified.ok !== true || verified.state !== "verified") return null;

        const origin = normalizeCanvasOrigin(verified.origin || current.origin);
        const canvasUserId = normalizeCanvasUserId(verified.userId ?? verified.canvasUser?.id ?? current.canvasUser?.id);
        const hash = typeof accountKey === "string" ? accountKey.trim().toLowerCase() : "";
        if (!origin || !canvasUserId || !/^[a-f0-9]{64}$/.test(hash)) return null;

        const label = cleanName(verified.profile?.displayName || current.profile?.displayName);
        if (!label) return null;

        const extractionCapability = extraction === "supported" ? "supported" : "unsupported";
        return {
            origin,
            canvasUserId,
            accountKey: hash,
            sourceKey: `canvas:${hash}`,
            label,
            extraction: extractionCapability
        };
    }

    function readDomProfile(doc, origin) {
        const profile = doc?.querySelector?.("#global_nav_profile_link, [data-testid='account-nav'], [data-testid='global-nav-profile']");
        const image = profile?.querySelector?.("img") || doc?.querySelector?.("#global_nav_profile_link img");
        const displayName = cleanName(profile?.getAttribute?.("data-user-name") || profile?.getAttribute?.("aria-label") || profile?.getAttribute?.("title") || image?.getAttribute?.("alt"));
        const avatarUrl = safeAvatar(image?.getAttribute?.("src") || image?.getAttribute?.("data-src") || profile?.getAttribute?.("data-avatar-url"), origin);
        return displayName || avatarUrl ? { displayName: displayName || null, avatarUrl } : null;
    }

    function hasSignInMarker(doc) {
        return Boolean(doc?.querySelector?.("#login_form, .ic-Login__container, form[action*='/login'], a[href*='/login'], a[href*='/login?']"));
    }

    function hasCanvasShell(doc) {
        return Boolean(doc?.querySelector?.("#application, #wrapper.ic-app, .ic-app, #global_nav, #global_nav_profile_link, [data-react-class*='Canvas'], meta[name='application-name'][content*='Canvas' i]"));
    }

    function courseContext(location, doc) {
        const match = String(location?.pathname || "").match(/^\/courses\/(\d+)(?:\/|$)/);
        if (!match) return null;
        const title = doc?.querySelector?.("#breadcrumbs .crumb:last-child, h1")?.textContent?.replace(/\s+/g, " ").trim() || null;
        return { id: match[1], name: title ? title.slice(0, 160) : null };
    }

    function makeCapabilities({ signedOut = false, identity = false, extractionReady = false } = {}) {
        return {
            identity: signedOut ? "signed_out" : identity ? "ready" : "unavailable",
            extraction: signedOut ? "unsupported" : identity && extractionReady ? "supported" : "unsupported",
            upload: "unsupported",
            writeback: "unsupported",
            calendar: "unsupported"
        };
    }

    function unavailableContext(state, code, accountBoundJobsPaused = false) {
        return {
            version: CONTEXT_VERSION,
            ok: state === "not_canvas" || state === "signed_out",
            state,
            ...(code ? { code } : {}),
            profile: null,
            canvasUser: null,
            capabilities: makeCapabilities({ signedOut: state === "signed_out" }),
            tab: null,
            course: null,
            unread: null,
            accountBoundJobsPaused
        };
    }

    function createContextService({
        window: win = globalThis.window,
        document: doc = globalThis.document,
        chromeApi = globalThis.chrome,
        fetchImpl = globalThis.fetch,
        onAccountChange = () => {},
        isExtractionReady = () => false,
        now = () => Date.now(),
        setTimer = setTimeout,
        clearTimer = clearTimeout,
        selfTimeoutMs = 1500
    } = {}) {
        let lifecyclePaused = false;
        let accountBoundJobsPaused = false;
        let lastIdentity = "";
        let generation = 0;
        let disposed = false;

        function invalidate(reason = "context_invalidated") {
            accountBoundJobsPaused = true;
            generation += 1;
            try { onAccountChange({ reason, generation }); } catch (error) {}
        }

        async function readStorage() {
            const sync = await chromeApi?.storage?.sync?.get?.(["custom_domain"]);
            const local = await chromeApi?.storage?.local?.get?.(["platform.accountMetadata"]);
            return { sync: sync || {}, local: local || {} };
        }

        async function fetchSelf(origin) {
            if (typeof fetchImpl !== "function") throw new Error("CANVAS_FETCH_UNAVAILABLE");
            const controller = typeof AbortController === "function" ? new AbortController() : null;
            const timer = setTimer(() => controller?.abort(), selfTimeoutMs);
            try {
                const response = await fetchImpl(`${origin}/api/v1/users/self`, {
                    method: "GET",
                    credentials: "include",
                    headers: { Accept: "application/json" },
                    ...(controller ? { signal: controller.signal } : {})
                });
                if (!response?.ok) {
                    const error = new Error(`CANVAS_SELF_${response?.status || 0}`);
                    error.status = response?.status;
                    throw error;
                }
                const body = await response.json();
                if (!isPlainObject(body)) throw new Error("CANVAS_SELF_SHAPE_INVALID");
                return body;
            } finally {
                clearTimer(timer);
            }
        }

        function baseContext(origin) {
            const path = String(win?.location?.pathname || "/");
            return {
                version: CONTEXT_VERSION,
                origin,
                tab: { path: path.slice(0, 500), title: typeof doc?.title === "string" ? doc.title.slice(0, 200) : "" },
                course: courseContext(win?.location, doc),
                capabilities: makeCapabilities(),
                accountBoundJobsPaused,
                generatedAt: now()
            };
        }

        async function getLiveContext({ allowUnverified = false, forceSelf = false } = {}) {
            if (disposed) return { ok: false, state: "error", code: "CANVAS_CONTEXT_DISPOSED" };
            let storage;
            try { storage = await readStorage(); }
            catch (error) { return { ok: false, state: "error", code: "CANVAS_SETTINGS_UNAVAILABLE" }; }

            const origin = currentOrigin(win?.location);
            if (win?.location?.protocol !== "https:") return { ok: false, state: "setup_needed", code: "CANVAS_HOST_HTTPS_REQUIRED" };
            if (!origin) return unavailableContext("not_canvas");

            const configuredOrigins = normalizeCanvasOrigins(storage.sync.custom_domain);
            const verifiedOrigins = verifiedOriginsFromMetadata(storage.local["platform.accountMetadata"]);
            const approved = isApprovedOrigin(origin, { configuredOrigins, verifiedOrigins });
            const canVerifyUnverified = allowUnverified && configuredOrigins.includes(origin);
            if (!approved && !canVerifyUnverified) return unavailableContext("not_canvas");

            const hasShell = hasCanvasShell(doc);
            const hasSignIn = hasSignInMarker(doc);
            if (!hasShell && !hasSignIn) return unavailableContext(forceSelf ? "waiting" : "not_canvas", forceSelf ? "CANVAS_CONTEXT_WAITING" : undefined);

            let rawUser;
            try { rawUser = await fetchSelf(origin); }
            catch (error) {
                if (error?.status === 401 || error?.status === 403) {
                    if (lastIdentity && lastIdentity !== "signed_out") invalidate("canvas_account_signed_out");
                    lastIdentity = "signed_out";
                    return unavailableContext("signed_out", "CANVAS_ACCOUNT_NOT_AUTHENTICATED", accountBoundJobsPaused);
                }
                return { ok: false, state: "error", code: "CANVAS_SELF_UNAVAILABLE" };
            }

            const user = sanitizeCanvasUser(rawUser, origin);
            const identity = `${origin}:${user.id || user.name || "unknown"}`;
            if (lastIdentity && lastIdentity !== identity) invalidate("canvas_account_changed");
            lastIdentity = identity;
            const context = baseContext(origin);
            context.ok = true;
            context.state = "connected";
            context.profile = { displayName: user.name, avatarUrl: user.avatarUrl };
            context.canvasUser = user;
            context.capabilities = makeCapabilities({ identity: Boolean(user.id), extractionReady: Boolean(isExtractionReady()) });
            context.accountBoundJobsPaused = accountBoundJobsPaused;
            return clone(context);
        }

        async function getContext() {
            // This is intentionally live. The popup can query after a Canvas
            // account switch without relying on a stale content-script cache.
            return getLiveContext({ forceSelf: false });
        }

        async function verifyAccount({ expectedOrigin, expectedUserId, origin, userId, accountId } = {}) {
            const suppliedOrigin = expectedOrigin !== undefined ? expectedOrigin : origin;
            const suppliedUserId = expectedUserId !== undefined
                ? expectedUserId
                : userId !== undefined
                    ? userId
                    : accountId;
            const normalizedExpectedOrigin = suppliedOrigin === undefined ? null : normalizeCanvasOrigin(suppliedOrigin);
            if (suppliedOrigin !== undefined && !normalizedExpectedOrigin) return { ok: false, state: "mismatch", code: "CANVAS_ORIGIN_INVALID" };
            const normalizedExpectedUserId = suppliedUserId === undefined ? null : normalizeCanvasUserId(suppliedUserId);
            if (suppliedUserId !== undefined && !normalizedExpectedUserId) return { ok: false, state: "mismatch", code: "CANVAS_USER_ID_INVALID" };

            const context = await getLiveContext({ allowUnverified: true, forceSelf: true });
            if (context.state === "signed_out") return { ok: false, state: "signed_out", code: "CANVAS_ACCOUNT_NOT_AUTHENTICATED" };
            if (!context.ok) {
                if (context.state === "waiting") return { ok: false, state: "waiting", code: "CANVAS_ACCOUNT_VERIFICATION_WAITING" };
                return context;
            }
            if (normalizedExpectedOrigin && normalizedExpectedOrigin !== context.origin) {
                return { ok: false, state: "mismatch", code: "CANVAS_ORIGIN_MISMATCH", origin: context.origin };
            }
            if (normalizedExpectedUserId && normalizedExpectedUserId !== context.canvasUser?.id) {
                return { ok: false, state: "mismatch", code: "CANVAS_USER_ID_MISMATCH", origin: context.origin };
            }
            if (!context.canvasUser?.id) return { ok: false, state: "waiting", code: "CANVAS_USER_ID_UNAVAILABLE" };
            return {
                ok: true,
                state: "verified",
                verified: true,
                origin: context.origin,
                userId: context.canvasUser.id,
                profile: context.profile,
                canvasUser: context.canvasUser,
                accountBoundJobsPaused: context.accountBoundJobsPaused
            };
        }

        function onStorageChanged(changes, areaName) {
            if ((areaName === "sync" && changes?.custom_domain) || (areaName === "local" && changes?.["platform.accountMetadata"])) invalidate("canvas_origin_or_account_changed");
        }

        function pause() { lifecyclePaused = true; }
        function resume() { lifecyclePaused = false; }
        function resumeAccountJobs() {
            accountBoundJobsPaused = false;
        }
        function dispose() {
            disposed = true;
            lastIdentity = "";
        }

        return Object.freeze({
            getContext,
            verifyAccount,
            invalidate,
            onStorageChanged,
            pause,
            resume,
            resumeAccountJobs,
            dispose,
            isAccountJobsPaused: () => accountBoundJobsPaused,
            isLifecyclePaused: () => lifecyclePaused,
            isDisposed: () => disposed,
            getGeneration: () => generation,
            constants: Object.freeze({ CONTEXT_VERSION, STATIC_CANVAS_ORIGIN, APPROVED_PAGE_PATTERN })
        });
    }

    return Object.freeze({
        CONTEXT_VERSION,
        STATIC_CANVAS_ORIGIN,
        APPROVED_PAGE_PATTERN,
        normalizeCanvasOrigin,
        normalizeCanvasOrigins,
        verifiedOriginsFromMetadata,
        isApprovedOrigin,
        isApprovedLocation,
        normalizeCanvasUserId,
        safeAvatar,
        sanitizeCanvasUser,
        buildCanvasBinding,
        createContextService
    });
}));
