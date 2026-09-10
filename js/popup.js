const syncedSwitches = ['tab_icons', 'hide_feedback', 'dark_mode', 'remlogo', 'full_width', 'auto_dark', 'assignments_due', 'gpa_calc', 'gradient_cards', 'disable_color_overlay', 'dashboard_grades', 'dashboard_notes', 'better_todo', 'better_sidebar', 'condensed_cards', 'dashboard_compact_padding', 'hide_dashboard_header', 'hide_infrastructure_footer'];
// Compatibility-only settings intentionally do not appear in this active
// popup synchronization list. Their stored values remain untouched.
const fontsDropdownStateKey = "fonts_dropdown_open";
const pendingCardColorsKey = "popup.pending_card_colors";

const settingsSchema = globalThis.APStudyCanvasSchema;
if (!settingsSchema) throw new Error("APStudyCanvas settings schema did not load.");
const settingsEditors = globalThis.APStudyCanvasSettingsEditors;
const defaultOptions = {
    local: settingsSchema.defaultsForArea("local"),
    sync: settingsSchema.defaultsForArea("sync")
};

const CANVAS_CONTEXT_REQUEST_VERSION = 1;
const CANVAS_CONTEXT_TIMEOUT_MS = 2500;
let canvasContextMemory = null;
let canvasContextSourceTabId = null;
let canvasContextCheck = null;

function extensionVersion() {
    try {
        return chrome.runtime.getManifest().version;
    } catch (error) {
        return "unknown";
    }
}

function safeCanvasContextFailure(state, code) {
    return { ok: false, state, code, canvasBinding: null };
}

const CANVAS_BINDING_CAPABILITIES = new Set(["supported", "unsupported"]);
const CANVAS_ACCOUNT_KEY_PATTERN = /^[a-f0-9]{64}$/;

function normalizePopupCanvasOrigin(value) {
    if (typeof value !== "string" || !value.trim()) return null;
    try {
        const url = new URL(value.trim());
        const hostname = url.hostname.toLowerCase();
        const labels = hostname.split(".");
        if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
            || (url.pathname !== "" && url.pathname !== "/") || !hostname
            || hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
            || labels.length < 2 || labels.some((label) => !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) return null;
        return url.origin;
    } catch (error) {
        return null;
    }
}

function normalizePopupCanvasUserId(value) {
    if (value === undefined || value === null || (typeof value !== "string" && !Number.isSafeInteger(value))) return null;
    const normalized = String(value).trim();
    return normalized && normalized.length <= 120 && /^[A-Za-z0-9._:@-]+$/.test(normalized) ? normalized : null;
}

function normalizePopupCanvasIdentifier(value) {
    if (typeof value !== "string") return null;
    const normalized = value.trim();
    return normalized && normalized.length <= 160 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(normalized) ? normalized : null;
}

function normalizePopupDisplayLabel(value) {
    if (typeof value !== "string") return null;
    const normalized = value.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, 120);
    return normalized && !/(?:bearer\s+|access[_-]?token|authorization|cookie|csrf|password|secret|session|token\s*[:=])/i.test(normalized)
        && !/^(?:account|profile|user|log ?in|sign ?in)$/i.test(normalized)
        ? normalized
        : null;
}

function normalizePopupCanvasAvatar(value) {
    if (typeof value !== "string" || !value.trim()) return null;
    try {
        const url = new URL(value.trim());
        if (url.protocol !== "https:" || url.username || url.password || url.hash || !url.hostname
            || /(?:access[_-]?token|api[_-]?key|authorization|cookie|credential|csrf|jwt|password|private|secret|session|token)/i.test(url.href)
            || /\.ics(?:$|[?#])/i.test(url.pathname)) return null;
        return url.href;
    } catch (error) {
        return null;
    }
}

function normalizePopupSidebarHref(value, origin, courseId = null) {
    if (typeof value !== "string" || !origin) return null;
    try {
        const url = new URL(value.trim(), origin);
        if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password || url.hash) return null;
        for (const [key, parameter] of url.searchParams.entries()) {
            if (/(?:access[_-]?token|api[_-]?key|authorization|bearer|cookie|credential|csrf|jwt|password|private|secret|session|signature|token)/i.test(key)
                || /(?:access[_-]?token|api[_-]?key|authorization|bearer|cookie|credential|csrf|jwt|password|private|secret|session|signature|token)/i.test(parameter)) return null;
        }
        if (courseId && url.pathname !== `/courses/${courseId}` && !url.pathname.startsWith(`/courses/${courseId}/`)) return null;
        return url.href;
    } catch (error) {
        return null;
    }
}

function normalizePopupSidebarColor(value) {
    if (typeof value !== "string") return null;
    const normalized = value.trim();
    return /^(?:#[0-9a-f]{3,8}|rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+(?:\s*,\s*[\d.]+)?\s*\))$/i.test(normalized) ? normalized : null;
}

function normalizePopupSidebarContext(response, binding) {
    if (!isPlainObject(response?.sidebarContext) || !binding) return null;
    const raw = response.sidebarContext;
    const origin = normalizePopupCanvasOrigin(raw.origin);
    if (!origin || origin !== binding.origin || typeof raw.accountKey !== "string" || raw.accountKey.trim().toLowerCase() !== binding.accountKey) return null;
    const stableId = (value, limit = 128) => {
        if (typeof value !== "string") return null;
        const id = value.trim();
        return id.length <= limit && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id) ? id : null;
    };
    const pages = [];
    const pageIds = new Set();
    (Array.isArray(raw.pages) ? raw.pages : []).forEach((page) => {
        if (!isPlainObject(page)) return;
        const id = stableId(page.id);
        const label = normalizePopupDisplayLabel(page.label);
        if (!id || !label || pageIds.has(id)) return;
        pageIds.add(id);
        const href = normalizePopupSidebarHref(page.href, origin);
        const available = page.available === true && Boolean(href);
        pages.push({
            id,
            label,
            href: available ? href : null,
            source: page.source === "apstudycanvas" ? "apstudycanvas" : "canvas",
            iconRole: stableId(page.iconRole, 64) || "canvas",
            available,
            known: page.known !== false,
            ...(Number.isSafeInteger(page.unreadCount) && page.unreadCount >= 0 ? { unreadCount: page.unreadCount } : {})
        });
    });
    const pageOrder = [];
    (Array.isArray(raw.pageOrder) ? raw.pageOrder : pages.map((page) => page.id)).forEach((value) => {
        const id = stableId(value);
        if (id && pageIds.has(id) && !pageOrder.includes(id)) pageOrder.push(id);
    });
    pages.forEach((page) => { if (!pageOrder.includes(page.id)) pageOrder.push(page.id); });
    const pageVisibility = {};
    if (isPlainObject(raw.pageVisibility)) {
        Object.entries(raw.pageVisibility).forEach(([id, visible]) => {
            if (pageIds.has(id) && typeof visible === "boolean") pageVisibility[id] = visible;
        });
    }

    const courses = [];
    const courseIds = new Set();
    (Array.isArray(raw.courses) ? raw.courses : []).forEach((course, sourceOrder) => {
        if (!isPlainObject(course)) return;
        const id = typeof course.id === "string" ? course.id.trim() : String(course.id ?? "");
        const name = normalizePopupDisplayLabel(course.name);
        if (!/^[1-9]\d{0,19}$/.test(id) || !name || course.available !== true || course.published === false || course.concluded === true || courseIds.has(id)) return;
        const href = normalizePopupSidebarHref(course.href, origin, id);
        if (!href) return;
        courseIds.add(id);
        courses.push({ id, name, href, color: normalizePopupSidebarColor(course.color), available: true, published: true, sourceOrder: Number.isSafeInteger(course.sourceOrder) && course.sourceOrder >= 0 ? course.sourceOrder : sourceOrder });
    });
    const courseOrder = [];
    (Array.isArray(raw.courseOrder) ? raw.courseOrder : courses.map((course) => course.id)).forEach((value) => {
        const id = typeof value === "string" ? value.trim() : String(value ?? "");
        if (/^[1-9]\d{0,19}$/.test(id) && courseIds.has(id) && !courseOrder.includes(id)) courseOrder.push(id);
    });
    courses.forEach((course) => { if (!courseOrder.includes(course.id)) courseOrder.push(course.id); });

    const rawRoute = isPlainObject(raw.route) ? raw.route : {};
    const pathname = typeof rawRoute.pathname === "string" && rawRoute.pathname.startsWith("/")
        ? rawRoute.pathname.replace(/\/+/g, "/").slice(0, 240)
        : "/";
    const route = {
        origin,
        pathname,
        kind: stableId(rawRoute.kind, 64) || "unknown",
        pageId: stableId(rawRoute.pageId),
        courseId: /^[1-9]\d{0,19}$/.test(String(rawRoute.courseId || "")) ? String(rawRoute.courseId) : null,
        resource: Array.isArray(rawRoute.resource) ? rawRoute.resource.map((value) => normalizePopupDisplayLabel(value)).filter(Boolean).slice(0, 8) : []
    };
    return { version: 1, origin, accountKey: binding.accountKey, route, pages, pageOrder, pageVisibility, courses, courseOrder };
}

function normalizePopupContextRevision(value) {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function normalizePopupSourceTabId(value) {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function hostedFlagActive(params, name) {
    return params.get(name) === "1";
}

function hostedRouteActive(params) {
    return hostedFlagActive(params, "fullscreen") || hostedFlagActive(params, "embedded");
}

function hostedRouteFromSearch(search) {
    if (typeof search !== "string") return false;
    try {
        return hostedRouteActive(new URLSearchParams(search));
    } catch (error) {
        return false;
    }
}

function parseHostedSourceTabId(search) {
    if (typeof search !== "string") return null;
    let params;
    try {
        params = new URLSearchParams(search);
    } catch (error) {
        return null;
    }
    const sourceValues = params.getAll("sourceCanvasTabId");
    if (!hostedRouteActive(params) || sourceValues.length !== 1 || !/^[1-9]\d*$/.test(sourceValues[0])) return null;
    const sourceTabId = Number(sourceValues[0]);
    return Number.isSafeInteger(sourceTabId) && sourceTabId > 0 ? sourceTabId : null;
}

function hostedSourceParamPresent(search) {
    if (typeof search !== "string") return false;
    try {
        const params = new URLSearchParams(search);
        return hostedRouteActive(params) && params.has("sourceCanvasTabId");
    } catch (error) {
        return false;
    }
}

// Snapshot the route synchronously while popup.js is evaluated. The first
// Canvas lookup must not depend on workspace initialization or script order.
const popupStartupSearch = typeof window !== "undefined" && window.location ? window.location.search : "";
const popupStartupIsHosted = hostedRouteFromSearch(popupStartupSearch);
const popupStartupSourceTabId = parseHostedSourceTabId(popupStartupSearch);
const popupStartupCanResolveEmbeddedSource = (() => {
    try {
        const params = new URLSearchParams(popupStartupSearch);
        const sessions = params.getAll("overlaySession");
        return params.get("embedded") === "1"
            && params.get("fullscreen") !== "1"
            && !params.has("sourceCanvasTabId")
            && sessions.length === 1
            && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(sessions[0]);
    } catch (error) {
        return false;
    }
})();

function requireHostedSourceAtStartup() {
    if (!popupStartupIsHosted) return null;
    if (Number.isSafeInteger(popupStartupSourceTabId) && popupStartupSourceTabId > 0) return popupStartupSourceTabId;
    if (popupStartupCanResolveEmbeddedSource) return null;
    const error = new Error("POPUP_HOSTED_SOURCE_INVALID");
    error.code = "POPUP_HOSTED_SOURCE_INVALID";
    throw error;
}

const OVERLAY_BRIDGE_REQUEST_TYPE = "apstudycanvas-overlay-control";
const OVERLAY_BRIDGE_RESPONSE_TYPE = "apstudycanvas-overlay-control-response";

function embeddedParentOrigin(documentRef, search = globalThis.window?.location?.search || "") {
    let declaredOrigin = "";
    let referrerOrigin = "";
    try {
        const declared = new URLSearchParams(search).get("overlayParentOrigin") || "";
        const url = new URL(declared);
        if ((url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password) declaredOrigin = url.origin;
    } catch (error) {}
    try { referrerOrigin = new URL(documentRef?.referrer || "").origin; } catch (error) {}
    // The Canvas host mints the declared origin into the session-bound frame
    // URL. Browsers that retain iframe referrers get a second proof; a
    // disagreement is never bridged. This lets an extension reload recover
    // even where Chromium temporarily reports the prior iframe URL to the
    // service worker for the first message from a replacement frame.
    if (declaredOrigin && referrerOrigin && declaredOrigin !== referrerOrigin) return "";
    return referrerOrigin || declaredOrigin;
}

function createEmbeddedOverlayChromeApi(chromeApi, { windowRef = globalThis.window, documentRef = globalThis.document, timeoutMs = 8000 } = {}) {
    const runtime = chromeApi?.runtime;
    const sendMessage = runtime?.sendMessage;
    if (typeof sendMessage !== "function" || !windowRef?.addEventListener || !windowRef?.parent || windowRef.parent === windowRef) return chromeApi;
    let query;
    try { query = new URLSearchParams(windowRef.location?.search || ""); } catch (error) { return chromeApi; }
    if (query.get("embedded") !== "1") return chromeApi;

    const directSendMessage = (message) => {
        if (message?.type !== "OVERLAY_CONTROL") return sendMessage.call(runtime, message);
        const overlaySession = message?.payload?.overlaySession;
        const parentOrigin = embeddedParentOrigin(documentRef, windowRef.location?.search || "");
        if (!overlaySession || !parentOrigin || typeof windowRef.parent.postMessage !== "function") return sendMessage.call(runtime, message);
        const requestId = typeof message.request_id === "string" && message.request_id
            ? message.request_id
            : `overlay-bridge-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        return new Promise((resolve, reject) => {
            let timer = null;
            const finish = (error, response) => {
                if (timer !== null) (windowRef.clearTimeout || clearTimeout)(timer);
                windowRef.removeEventListener("message", onMessage);
                if (error) reject(error); else resolve({ payload: response });
            };
            const onMessage = (event) => {
                const data = event?.data;
                if (event.source !== windowRef.parent
                    || event.origin !== parentOrigin
                    || data?.type !== OVERLAY_BRIDGE_RESPONSE_TYPE
                    || data.requestId !== requestId
                    || data.overlaySession !== overlaySession) return;
                finish(null, data.payload || { ok: false, code: "OVERLAY_CONTROL_FAILED" });
            };
            windowRef.addEventListener("message", onMessage);
            timer = (windowRef.setTimeout || setTimeout)(() => {
                const error = new Error("OVERLAY_HOST_UNAVAILABLE");
                error.code = "OVERLAY_HOST_UNAVAILABLE";
                finish(error);
            }, Math.max(1, Number(timeoutMs) || 8000));
            try {
                windowRef.parent.postMessage({
                    type: OVERLAY_BRIDGE_REQUEST_TYPE,
                    requestId,
                    overlaySession,
                    action: message.payload?.action,
                    payload: message.payload || {}
                }, parentOrigin);
            } catch (error) {
                finish(Object.assign(new Error("OVERLAY_HOST_UNAVAILABLE"), { code: "OVERLAY_HOST_UNAVAILABLE" }));
            }
        });
    };
    const wrappedRuntime = Object.assign({}, runtime, { sendMessage: directSendMessage });
    return Object.assign({}, chromeApi, { runtime: wrappedRuntime });
}

function isCanvasBindingRecord(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    try {
        const prototype = Object.getPrototypeOf(value);
        if (prototype === null || prototype === Object.prototype) return true;
        const constructor = Object.prototype.hasOwnProperty.call(prototype, "constructor")
            ? prototype.constructor
            : null;
        return typeof constructor === "function" && constructor.name === "Object" && constructor.prototype === prototype;
    } catch (error) {
        return false;
    }
}

function normalizeCanvasBinding(response, profile) {
    if (!isCanvasBindingRecord(response) || response.ok !== true || response.state !== "connected") return null;
    const rawBinding = isCanvasBindingRecord(response.canvasBinding)
        ? response.canvasBinding
        : isCanvasBindingRecord(response.binding) ? response.binding : null;
    if (!rawBinding) return null;

    const allowedKeys = new Set([
        "origin", "canvasUserId", "canvas_user_id", "userId", "user_id",
        "accountKey", "account_key", "sourceKey", "source_key",
        "label", "displayLabel", "display_label",
        "extraction", "extractionCapability", "extraction_capability",
        "sourceContextCapability", "source_context_capability", "capability"
    ]);
    let keys;
    try { keys = Reflect.ownKeys(rawBinding); } catch (error) { return null; }
    if (keys.some((key) => typeof key !== "string" || !allowedKeys.has(key))) return null;

    const origin = normalizePopupCanvasOrigin(rawBinding.origin);
    const responseOrigin = response.origin === undefined ? origin : normalizePopupCanvasOrigin(response.origin);
    const canvasUserId = normalizePopupCanvasUserId(rawBinding.canvasUserId ?? rawBinding.canvas_user_id ?? rawBinding.userId ?? rawBinding.user_id);
    const accountKey = typeof rawBinding.accountKey === "string"
        ? rawBinding.accountKey.trim().toLowerCase()
        : typeof rawBinding.account_key === "string" ? rawBinding.account_key.trim().toLowerCase() : null;
    const sourceKey = typeof rawBinding.sourceKey === "string"
        ? rawBinding.sourceKey.trim().toLowerCase()
        : typeof rawBinding.source_key === "string" ? rawBinding.source_key.trim().toLowerCase() : null;
    const label = normalizePopupDisplayLabel(rawBinding.label ?? rawBinding.displayLabel ?? rawBinding.display_label);
    const extraction = rawBinding.extraction
        ?? rawBinding.extractionCapability
        ?? rawBinding.extraction_capability
        ?? rawBinding.sourceContextCapability
        ?? rawBinding.source_context_capability
        ?? rawBinding.capability;
    if (!origin || !responseOrigin || origin !== responseOrigin || !canvasUserId
        || !accountKey || !CANVAS_ACCOUNT_KEY_PATTERN.test(accountKey)
        || sourceKey !== `canvas:${accountKey}` || !label
        || !CANVAS_BINDING_CAPABILITIES.has(extraction)) return null;
    return { origin, canvasUserId, accountKey, sourceKey, label, extraction };
}

function sanitizeCanvasContext(response) {
    const successStates = new Set(["connected", "signed_out", "not_canvas"]);
    const failureStates = new Set(["not_open", "setup_needed", "timeout", "error"]);
    if (!response || typeof response !== "object") return safeCanvasContextFailure("error", "INVALID_CANVAS_CONTEXT");
    if (response.ok === true && successStates.has(response.state)) {
        const rawProfile = response.profile && typeof response.profile === "object" ? response.profile : null;
        const profile = rawProfile ? {
            displayName: normalizePopupDisplayLabel(rawProfile.displayName),
            avatarUrl: normalizePopupCanvasAvatar(rawProfile.avatarUrl)
        } : null;
        const rawUnread = response.unread && typeof response.unread === "object" ? response.unread : null;
        const count = Number(rawUnread?.count);
        const categories = {};
        if (isPlainObject(rawUnread?.categories)) {
            Object.entries(rawUnread.categories).forEach(([key, value]) => {
                const categoryCount = Number(value);
                if (/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/.test(key) && !/(?:token|cookie|csrf|secret|password)/i.test(key)
                    && Number.isSafeInteger(categoryCount) && categoryCount >= 0) categories[key] = categoryCount;
            });
        }
        const unread = rawUnread && Number.isSafeInteger(count) && count >= 0 ? {
            count,
            categories
        } : null;
        const canvasBinding = normalizeCanvasBinding(response, profile);
        return {
            ok: true,
            state: response.state,
            profile,
            unread,
            canvasBinding,
            contextRevision: normalizePopupContextRevision(response.contextRevision),
            sidebarContext: response.state === "connected" ? normalizePopupSidebarContext(response, canvasBinding) : null
        };
    }
    if (response.ok === false && failureStates.has(response.state)) {
        return safeCanvasContextFailure(response.state, typeof response.code === "string" ? response.code : "CANVAS_CONTEXT_ERROR");
    }
    return safeCanvasContextFailure("error", "INVALID_CANVAS_CONTEXT");
}

function canvasContextEventDetail(response, sourceTabId = null) {
    const safe = sanitizeCanvasContext(response);
    return {
        state: safe.state,
        profile: safe.ok === true ? safe.profile : null,
        unread: safe.ok === true ? safe.unread : null,
        canvasBinding: safe.ok === true ? safe.canvasBinding : null,
        ...(safe.ok === true && safe.contextRevision !== null ? { contextRevision: safe.contextRevision } : {}),
        ...(safe.ok === true && safe.sidebarContext ? { sidebarContext: safe.sidebarContext } : {}),
        sourceTabId: normalizePopupSourceTabId(sourceTabId)
    };
}

window.APStudyCanvasPopupContext = Object.freeze({
    normalizeCanvasBinding,
    sanitizeCanvasContext,
    normalizePopupSidebarContext,
    normalizePopupContextRevision,
    canvasContextEventDetail,
    normalizePopupSourceTabId,
    hostedRouteFromSearch,
    parseHostedSourceTabId,
    hostedSourceParamPresent,
    requireHostedSourceAtStartup,
    createEmbeddedOverlayChromeApi,
    embeddedParentOrigin
});

function isPlainObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function asPlainObject(value) {
    return isPlainObject(value) ? value : {};
}

// Kept as the popup-context boundary for lightweight consumers. Source-tab
// resolution itself lives in diagnostics-transport.js.
function expandedRouteIsHosted() {
    return popupStartupIsHosted;
}

const popupDiagnosticsTransport = globalThis.APStudyCanvasDiagnosticsTransport;

function diagnosticsTransportUnavailable() {
    const error = new Error("DIAGNOSTICS_TRANSPORT_UNAVAILABLE");
    error.code = "DIAGNOSTICS_TRANSPORT_UNAVAILABLE";
    return error;
}

function sourceTabNeedsHttpsSetup(tab) {
    if (!tab?.url) return false;
    try {
        const url = new URL(tab.url);
        return url.protocol !== "https:";
    } catch (error) {
        return false;
    }
}

async function requestCanvasContext() {
    if (!popupDiagnosticsTransport?.resolvePopupSourceTab) throw diagnosticsTransportUnavailable();
    const source = await popupDiagnosticsTransport.resolvePopupSourceTab();
    if (source.state) return { response: safeCanvasContextFailure(source.state, source.code), sourceTabId: null };
    if (sourceTabNeedsHttpsSetup(source.tab)) {
        return { response: safeCanvasContextFailure("setup_needed", "CANVAS_HOST_HTTPS_REQUIRED"), sourceTabId: source.tabId };
    }
    if (!chrome.tabs?.sendMessage) {
        return { response: safeCanvasContextFailure("error", "CONTENT_MESSAGE_UNAVAILABLE"), sourceTabId: source.tabId };
    }

    const requestId = globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    let timer;
    try {
        const pending = chrome.tabs.sendMessage(source.tabId, {
            type: "GET_CANVAS_CONTEXT",
            version: CANVAS_CONTEXT_REQUEST_VERSION,
            requestId
        });
        const timedOut = new Promise((resolve) => {
            timer = setTimeout(() => resolve({ timeout: true }), CANVAS_CONTEXT_TIMEOUT_MS);
        });
        const result = await Promise.race([pending, timedOut]);
        if (result?.timeout) return { response: safeCanvasContextFailure("timeout", "CANVAS_CONTEXT_TIMEOUT"), sourceTabId: source.tabId };
        let currentTab;
        try {
            currentTab = await chrome.tabs.get(source.tabId);
        } catch (error) {
            return { response: safeCanvasContextFailure("not_open", "SOURCE_TAB_UNAVAILABLE"), sourceTabId: null };
        }
        const currentValidation = await popupDiagnosticsTransport.validateCanvasSourceTab(currentTab);
        if (!currentValidation.ok || currentValidation.origin !== source.origin) {
            return { response: safeCanvasContextFailure(currentValidation.state || "error", currentValidation.code || "SOURCE_TAB_CHANGED"), sourceTabId: null };
        }
        const contextResult = result?.type === "GET_CANVAS_CONTEXT" && isPlainObject(result.payload) ? result.payload : result;
        const mismatch = popupDiagnosticsTransport.validateCanvasContextForTab(contextResult, currentTab, source.origin);
        if (mismatch) return { response: safeCanvasContextFailure(mismatch.state, mismatch.code), sourceTabId: null };
        return { response: sanitizeCanvasContext(contextResult), sourceTabId: source.tabId };
    } catch (error) {
        try {
            await chrome.tabs.get(source.tabId);
        } catch (tabError) {
            return { response: safeCanvasContextFailure("not_open", "SOURCE_TAB_UNAVAILABLE"), sourceTabId: null };
        }
        return { response: safeCanvasContextFailure("error", "CANVAS_CONTEXT_ERROR"), sourceTabId: source.tabId };
    } finally {
        clearTimeout(timer);
    }
}

function ensureCanvasHeaderAction() {
    // The canonical Overview summary is the Canvas context readout. Keeping
    // this seam lets context startup remain independent of the Workspace DOM.
    return document.getElementById("overview-status-value");
}

function canvasInitials(displayName) {
    const parts = String(displayName || "").trim().split(/\s+/).filter(Boolean);
    return (parts.length > 1 ? `${parts[0][0]}${parts[parts.length - 1][0]}` : parts[0]?.[0] || "").toUpperCase().slice(0, 2);
}

function renderCanvasProfile(profile) {
    const name = profile?.displayName || "";
    const initials = canvasInitials(name);
    const avatars = ["workspace-account-avatar", "account-section-avatar"]
        .map((id) => document.getElementById(id))
        .filter(Boolean);
    const useFallback = (avatar) => {
        avatar.style.backgroundImage = name ? "" : `url(${chrome.runtime.getURL("icon/icon-19.png")})`;
        avatar.textContent = initials || (name ? "A" : "");
    };
    avatars.forEach((avatar) => {
        if (profile?.avatarUrl) avatar.dataset.avatarUrl = profile.avatarUrl;
        else delete avatar.dataset.avatarUrl;
        useFallback(avatar);
        if (!profile?.avatarUrl) return;
        const image = new Image();
        image.onload = () => {
            if (avatar.dataset.avatarUrl !== profile.avatarUrl) return;
            avatar.style.backgroundImage = `url("${profile.avatarUrl.replace(/"/g, "%22")}")`;
            avatar.textContent = "";
        };
        image.onerror = () => {
            if (avatar.dataset.avatarUrl === profile.avatarUrl) useFallback(avatar);
        };
        image.src = profile.avatarUrl;
    });
    ["workspace-account-name", "account-section-name"].forEach((id) => {
        const nameNode = document.getElementById(id);
        if (nameNode && name) nameNode.textContent = name;
    });
    ["workspace-account-source", "account-section-source"].forEach((id) => {
        const sourceNode = document.getElementById(id);
        if (sourceNode && name) sourceNode.textContent = "Canvas context";
    });
}

function setCanvasHeaderState(response, sourceTabId) {
    const status = ensureCanvasHeaderAction();
    const state = response?.ok ? response.state : response?.state || "error";
    const labels = {
        checking: "Checking Canvas",
        setup_needed: "Canvas setup needed",
        not_open: "Open Canvas to connect",
        not_canvas: "Open Canvas to connect",
        signed_out: "Sign in to Canvas",
        connected: "Canvas connected",
        timeout: "Canvas check unavailable — Retry",
        error: "Canvas check unavailable — Retry"
    };
    if (status) {
        status.textContent = labels[state] || labels.error;
        status.dataset.canvasState = state;
        status.classList.toggle("is-connected", state === "connected");
    }
    renderCanvasProfile(response?.ok ? response.profile : null);
    window.dispatchEvent(new CustomEvent("apstudycanvas-canvas-context", {
        // Only the already-normalized context crosses into the controller.
        // The source tab is included only as a validated opaque tab ID.
        detail: canvasContextEventDetail(response, sourceTabId)
    }));
}

async function openCanvasForConnection() {
    let domains = [];
    try {
        const stored = await chrome.storage.sync.get(["custom_domain"]);
        const normalized = popupDiagnosticsTransport?.normalizeCanvasDomains?.(stored.custom_domain);
        domains = normalized.valid ? normalized.value : [];
    } catch (error) {
        domains = [];
    }
    const origin = domains[0];
    if (origin && chrome.tabs?.create) {
        await chrome.tabs.create({ url: `${origin}/` });
        return;
    }
    window.APStudyCanvasWorkspace?.activateCategory?.("data-support");
    setCanvasHeaderState(safeCanvasContextFailure("setup_needed", "CANVAS_SETUP_REQUIRED"), null);
    ["save-status-live", "workspace-save-status"].forEach((id) => {
        const guidance = document.getElementById(id);
        if (guidance) guidance.textContent = "Set an HTTPS Canvas URL in Overview to connect.";
    });
}

async function checkCanvasContext() {
    if (canvasContextCheck) return canvasContextCheck;
    setCanvasHeaderState({ ok: false, state: "checking", code: "CANVAS_CONTEXT_CHECKING" }, null);
    canvasContextCheck = requestCanvasContext().then(({ response, sourceTabId }) => {
        canvasContextMemory = response;
        canvasContextSourceTabId = sourceTabId;
        setCanvasHeaderState(response, sourceTabId);
        renderNotifications().catch(() => {});
        return response;
    }).catch(() => {
        const response = safeCanvasContextFailure("error", "CANVAS_CONTEXT_ERROR");
        canvasContextMemory = response;
        canvasContextSourceTabId = null;
        setCanvasHeaderState(response, null);
        renderNotifications().catch(() => {});
        return response;
    }).finally(() => {
        canvasContextCheck = null;
    });
    return canvasContextCheck;
}

function setupCanvasConnection() {
    renderExtensionVersion();
    const action = ensureCanvasHeaderAction();
    action?.addEventListener("click", () => {
        if (action.dataset.canvasAction === "retry") checkCanvasContext();
        else openCanvasForConnection().catch(() => {});
    });
    return checkCanvasContext();
}

function renderExtensionVersion() {
    const version = extensionVersion();
    document.querySelectorAll("#extension-version").forEach((node) => { node.textContent = version; });
}

async function renderNotifications() {
    const badge = document.querySelector("#notifications-button .notification-badge");
    const content = document.querySelector("#notifications-popover .popover-empty");
    if (!badge || !content) return;
    let local = {};
    try {
        local = await boundedPopupRead(chrome.storage.local.get(["seen_update_version"]));
    } catch (error) {
        local = {};
    }
    const version = extensionVersion();
    const unseenUpdate = local.seen_update_version !== version;
    const canvasUnread = canvasContextMemory?.ok && (canvasContextMemory.state === "connected") && canvasContextMemory.unread && Number.isSafeInteger(canvasContextMemory.unread.count)
        ? canvasContextMemory.unread.count
        : null;
    const total = (canvasUnread === null ? 0 : canvasUnread) + (unseenUpdate ? 1 : 0);
    badge.textContent = String(total);
    badge.hidden = total === 0;
    badge.setAttribute("aria-label", `${total} unread notification${total === 1 ? "" : "s"}`);
    const messages = [];
    if (unseenUpdate) messages.push(`APStudyCanvas ${version} has an unseen extension update.`);
    if (canvasUnread !== null) messages.push(`Canvas unread: ${canvasUnread}.`);
    else messages.push("Canvas unread is unavailable until Canvas is connected.");
    messages.push("Reminders and issue-log status are informational and do not change this badge.");
    content.textContent = messages.join(" ");
}

async function markExtensionUpdateSeen() {
    await chrome.storage.local.set({ seen_update_version: extensionVersion() });
    await renderNotifications();
}

function setupNotifications() {
    document.getElementById("notifications-button")?.addEventListener("click", () => {
        markExtensionUpdateSeen().catch(() => {});
    });
    return renderNotifications();
}

let popupChromeSetupPromise = null;

function initializePopupChrome() {
    if (!popupChromeSetupPromise) {
        popupChromeSetupPromise = Promise.allSettled([
            setupCanvasConnection(),
            setupNotifications()
        ]);
    }
    return popupChromeSetupPromise;
}


const SETTINGS_SAVE_FAILURE_MESSAGE = settingsSchema.messages.saveFailure;
const INVALID_SETTINGS_JSON_MESSAGE = settingsSchema.messages.invalidImport;
const pendingKeys = new Set();
let knownSyncValues = {};

function boundedPopupRead(operation) {
    let timer;
    return Promise.race([Promise.resolve(operation), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Settings lookup timed out. Try again.")), 8000);
        timer?.unref?.();
    })]).finally(() => clearTimeout(timer));
}

function storageAreaCall(area, method, ...args) {
    const storage = chrome?.storage?.[area];
    if (!storage || typeof storage[method] !== "function") return Promise.reject(new Error(`storage.${area}.${method} unavailable`));
    try {
        const result = storage[method](...args);
        return method === "get" ? boundedPopupRead(result) : Promise.resolve(result);
    } catch (error) {
        return Promise.reject(error);
    }
}

function popupPlatformRequest(type, payload = {}) {
    const runtime = chrome?.runtime;
    if (!runtime?.sendMessage) return Promise.reject(new Error("RUNTIME_MESSAGE_UNAVAILABLE"));
    const contract = globalThis.APStudyCanvasPlatform?.Contract;
    const message = contract?.createEnvelope
        ? contract.createEnvelope(type, payload)
        : { version: 1, request_id: `popup-${Date.now()}`, type, payload };
    const operation = runtime.sendMessage(message);
    return (/_GET$|_LIST$|_STATUS$/.test(type) ? boundedPopupRead(operation) : Promise.resolve(operation)).then((response) => {
        if (response === null || response === undefined) throw new Error("PLATFORM_RESPONSE_MISSING");
        const result = response?.payload || response || {};
        if (result.ok === false) {
            const error = new Error(result.code || "PLATFORM_REQUEST_FAILED");
            error.code = result.code || "PLATFORM_REQUEST_FAILED";
            throw error;
        }
        return result;
    });
}

function setSaveStatus(message, error = false) {
    ["save-status-live", "workspace-save-status"].forEach((id) => {
        const status = document.getElementById(id);
        if (!status) return;
        status.textContent = message;
        status.classList.toggle("is-error", Boolean(error));
    });
    if (typeof postWorkspaceStatus === "function") postWorkspaceStatus(message, error);
}

const popupControllerApi = window.APStudyCanvasPopupController;

function updatePendingKey(key, pending) {
    const keys = settingsSchema.getAliasKeys(key);
    keys.forEach((item) => {
        if (pending) pendingKeys.add(item);
        else pendingKeys.delete(item);
    });
}

function cloneSetting(value) {
    return settingsSchema.clone(value);
}

function expandAliases(changes) {
    const expanded = {};
    Object.keys(changes || {}).forEach((key) => {
        const aliasKeys = settingsSchema.getAliasKeys(key);
        aliasKeys.forEach((aliasKey) => { expanded[aliasKey] = cloneSetting(changes[key]); });
    });
    return expanded;
}

function settingControlsForKey(key) {
    const controls = [];
    const direct = document.getElementById(key);
    if (direct) controls.push(direct);
    const escaped = globalThis.CSS?.escape ? CSS.escape(key) : key.replace(/(["\\])/g, "\\$1");
    document.querySelectorAll(`[data-setting-key="${escaped}"]`).forEach((item) => controls.push(item));
    return controls;
}

function restoreSettingUi(changes, snapshot) {
    Object.keys(changes || {}).forEach((key) => {
        const value = snapshot?.[key];
        settingControlsForKey(key).forEach((control) => {
            if (control.type === "checkbox") control.checked = value === true;
            else if (control.type === "radio") control.checked = control.value === value;
            else if (control.tagName === "INPUT" || control.tagName === "TEXTAREA" || control.tagName === "SELECT") control.value = value ?? "";
            const outputId = control.id ? `${control.id}Value` : "";
            const output = outputId ? document.getElementById(outputId) : null;
            if (output) output.textContent = control.value;
        });
    });
}

const popupSettingsStore = popupControllerApi?.createSettingsStore ? popupControllerApi.createSettingsStore({
    sendUpdate: (changes) => popupPlatformRequest("SETTINGS_UPDATE", { area: "sync", changes }).then((result) => {
        return result;
    }),
    sendReset: (keys) => popupPlatformRequest("SETTINGS_RESET", { area: "sync", keys }),
    read: (keys) => storageAreaCall("sync", "get", keys),
    aliases: settingsSchema.aliases,
    normalizers: { sidebar_page_order: popupControllerApi.normalizeSidebarOrder },
    onStatus: (message, error) => setSaveStatus(message, error),
    onSaved: (key, value) => {
        settingsSchema.getAliasKeys(key).forEach((item) => {
            if (value === undefined) delete knownSyncValues[item];
            else knownSyncValues[item] = cloneSetting(value);
        });
    },
    onPending: updatePendingKey,
    onRollback: (key, value) => {
        restoreSettingUi({ [key]: value }, { [key]: value });
        settingsSchema.getAliasKeys(key).forEach((item) => { knownSyncValues[item] = cloneSetting(value); });
        if (key === "canvas_calendar_mode") popupCalendarController?.applyCalendarModeSnapshot?.(value, "failed");
    }
}) : null;

const POPUP_CANVAS_CONSENT_VERSION = 1;
const POPUP_CANVAS_CONSENT_SCOPES = Object.freeze([
    "full_history_upload", "ongoing_read", "shares_ics_inclusion"
]);
const POPUP_CANVAS_SYNC_SCOPE = Object.freeze({
    types: Object.freeze(["assignment", "quiz", "discussion_topic", "planner_note", "calendar_event"]),
    context_ids: Object.freeze([]),
    context_codes: Object.freeze([]),
    lower_bounds: Object.freeze({}),
    window_days: 30,
    date_only_mode: false
});
const POPUP_CANVAS_SYNC_DESCRIPTORS = Object.freeze([
    Object.freeze({ id: "assignment:all", resource: "assignment", mode: "full_history" }),
    Object.freeze({ id: "quiz:all", resource: "quiz", mode: "full_history" }),
    Object.freeze({ id: "discussion_topic:all", resource: "discussion_topic", mode: "full_history" }),
    Object.freeze({ id: "planner_note:all", resource: "planner_note", mode: "full_history" }),
    Object.freeze({ id: "calendar_event:all", resource: "calendar_event", mode: "full_history" })
]);
const POPUP_SYNC_PUBLIC_RUN_ID_BLOCKER = "Refresh status to check the latest progress. Start a new sync if the previous attempt has stopped.";
let popupCalendarController = null;

function popupCalendarDeterministicSourceId(binding) {
    if (!binding || typeof binding.accountKey !== "string" || typeof binding.sourceKey !== "string") throw new Error("CANVAS_SYNC_BINDING_REQUIRED");
    const input = `canvas-source-v1\u0000${binding.accountKey}\u0000${binding.sourceKey}`;
    let first = 2166136261;
    let second = 2246822519;
    for (let index = 0; index < input.length; index += 1) {
        const code = input.charCodeAt(index);
        first = Math.imul(first ^ code, 16777619) >>> 0;
        second = Math.imul(second ^ code, 3266489917) >>> 0;
    }
    return `canvas-history-v1-${first.toString(16).padStart(8, "0")}${second.toString(16).padStart(8, "0")}`;
}

function popupCalendarContract(contract) {
    if (!contract?.createEnvelope) return contract;
    return Object.assign({}, contract, {
        createEnvelope(type, payload, requestId) {
            // The pre-existing controller owns generic popup behavior. Its
            // calendar placeholder requests are intentionally blocked here so
            // this slice cannot send legacy unscoped consent or calendar calls.
            if (["NEST_CONSENT_GET", "NEST_CONSENT_SET", "NEST_CALENDARS_GET"].includes(type)) {
                throw new Error("POPUP_LEGACY_CALENDAR_CONTRACT_DISABLED");
            }
            return contract.createEnvelope(type, payload, requestId);
        }
    });
}

function popupCalendarSafeCode(value, fallback = "SYNC_REQUEST_FAILED") {
    const code = typeof value === "string" ? value.trim() : "";
    return /^[A-Za-z][A-Za-z0-9_:-]{0,63}$/.test(code)
        && !/(?:TOKEN|COOKIE|CSRF|SECRET|PASSWORD|RAW|TITLE|DESCRIPTION|URL|URI|TAB|WINDOW|LEASE|PROOF|EVENT|PROVIDER)/i.test(code)
        ? code
        : fallback;
}

function popupCalendarClone(value) {
    if (value === undefined) return undefined;
    return settingsSchema.clone(value);
}

function popupCalendarSafeCounts(value, depth = 0, seen = new Set()) {
    if (depth > 5) return undefined;
    if (Number.isSafeInteger(value) && value >= 0) return value;
    if (typeof value === "boolean" || value === null) return value;
    if (!value || typeof value !== "object" || seen.has(value)) return undefined;
    seen.add(value);
    let result;
    if (Array.isArray(value)) {
        result = value.map((item) => popupCalendarSafeCounts(item, depth + 1, seen));
        if (result.some((item) => item === undefined)) result = undefined;
    } else if (isPlainObject(value)) {
        result = {};
        for (const [key, item] of Object.entries(value)) {
            if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/.test(key)
                || /(?:TOKEN|COOKIE|CSRF|SECRET|PASSWORD|RAW|TITLE|DESCRIPTION|URL|URI|TAB|WINDOW|LEASE|PROOF|EVENT|PROVIDER|ACCOUNT)/i.test(key)) {
                result = undefined;
                break;
            }
            const safe = popupCalendarSafeCounts(item, depth + 1, seen);
            if (safe === undefined) {
                result = undefined;
                break;
            }
            result[key] = safe;
        }
    }
    seen.delete(value);
    return result;
}

function popupCalendarSafeSyncResult(value) {
    const source = isPlainObject(value) ? value : {};
    const result = {};
    if (typeof source.state === "string") result.state = popupCalendarSafeCode(source.state, "unavailable");
    if (Object.prototype.hasOwnProperty.call(source, "counts")) {
        const counts = popupCalendarSafeCounts(source.counts);
        if (counts !== undefined) result.counts = counts;
    }
    if (Number.isSafeInteger(source.count) && source.count >= 0) result.count = source.count;
    if (Object.prototype.hasOwnProperty.call(source, "errorCode")) {
        result.errorCode = source.errorCode === null ? null : popupCalendarSafeCode(source.errorCode);
    } else if (Object.prototype.hasOwnProperty.call(source, "code")) {
        result.errorCode = source.code === null ? null : popupCalendarSafeCode(source.code);
    }
    const sourceRef = source.source_ref ?? source.sourceRef ?? source.binding?.source_ref ?? source.binding?.sourceRef;
    if (typeof sourceRef === "string" && /^src1:[A-Za-z0-9._~-]{1,128}$/.test(sourceRef)) result.source_ref = sourceRef;
    const timestamps = {};
    ["timestamp", "startedAt", "updatedAt", "completedAt"].forEach((key) => {
        const candidate = source[key];
        if (typeof candidate !== "string" || candidate.length > 64 || Number.isNaN(Date.parse(candidate))) return;
        timestamps[key] = new Date(candidate).toISOString();
    });
    if (Object.keys(timestamps).length) result.timestamps = timestamps;
    if (!result.state) result.state = "unavailable";
    return result;
}

function popupCalendarSafeRequestId() {
    const candidate = globalThis.crypto?.randomUUID?.();
    if (typeof candidate === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(candidate)) return candidate;
    return `popup-sync-${Date.now()}`;
}

function popupCalendarReadableLabel(value) {
    const label = String(value).replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_.]/g, " ");
    return label.charAt(0).toUpperCase() + label.slice(1).toLowerCase();
}

function popupCalendarCountSummary(value, prefix = "", output = [], depth = 0) {
    if (depth > 4 || output.length >= 24) return output;
    if (Number.isSafeInteger(value) && value >= 0) {
        output.push(`${popupCalendarReadableLabel(prefix || "Items")}: ${value.toLocaleString()}`);
        return output;
    }
    if (!value || typeof value !== "object") return output;
    Object.entries(value).forEach(([key, item]) => {
        if (output.length >= 24) return;
        const label = prefix ? `${prefix}.${key}` : key;
        popupCalendarCountSummary(item, label, output, depth + 1);
    });
    return output;
}

function popupCalendarSyncGuidance(result) {
    const state = result?.state || "unavailable";
    const code = result?.errorCode || "";
    if (state === "waiting_for_canvas_session" || state === "waiting" || /CANVAS_SESSION|SESSION_UNAVAILABLE/i.test(code)) {
        return "Open and sign in to the matching Canvas account to continue.";
    }
    if (/ACCOUNT_MISMATCH/i.test(code)) return "Open the verified matching Canvas account, then refresh status.";
    if (state === "signed_out" || /NEST_IDENTITY_REQUIRED|SIGNED_OUT/i.test(code)) return "Sign in to Nest, then refresh status.";
    if (/CONSENT_REQUIRED/i.test(code)) return "Allow Canvas data access for this account.";
    if (/OPT_IN_REQUIRED/i.test(code)) return "Enable the per-account opt-in after current consent is granted.";
    if (/FEATURE_DISABLED_UPLOAD|ROLLOUT/i.test(code)) return "Sync is not available for this connection. Nothing was uploaded.";
    if (["partial", "failed", "cancelled"].includes(state)) return POPUP_SYNC_PUBLIC_RUN_ID_BLOCKER;
    return "";
}

function popupCalendarConnection(controller) {
    return controller?.connection && typeof controller.connection === "object" ? controller.connection : null;
}

function popupCalendarConnectionSnapshot(controller) {
    const connection = popupCalendarConnection(controller);
    if (!connection || typeof connection.getSnapshot !== "function") return null;
    try {
        const snapshot = connection.getSnapshot();
        return isPlainObject(snapshot) ? snapshot : null;
    } catch (error) {
        return null;
    }
}

function popupCalendarIdentityStatus(controller) {
    const value = popupCalendarConnectionSnapshot(controller)?.identity?.state || controller?.state?.identity?.state;
    return ["authenticated", "signed_out", "expired", "unavailable"].includes(value) ? value : "unavailable";
}

function popupCalendarNormalizeCapabilities(value, flags = {}) {
    const source = isPlainObject(value) ? value : {};
    // Server names are defined by Nest's extension contract. Generic names are
    // the extension's effective capability snapshot, never inferred aliases.
    const remote = Object.keys(source).some((key) => key.startsWith("calendar_"));
    return remote ? {
        upload: flags.upload === true && source.calendar_upload === true,
        projection: flags.projection === true && source.calendar_projection === true,
        overlay: flags.overlay === true && source.calendar_projection === true,
        replacement: flags.replacement === true && flags.calendarReplacementParity?.ready === true && source.calendar_projection === true,
        mutation: flags.mutation === true && source.calendar_two_way_writeback === true,
        mirroring: flags.mirroring === true && source.calendar_mirroring === true
    } : Object.fromEntries(["upload", "projection", "overlay", "replacement", "mutation", "mirroring"].map((key) => [key, source[key] === true]));
}

function popupCalendarConnectionBinding(value) {
    const binding = isPlainObject(value) ? value : null;
    if (!binding) return null;
    return normalizeCanvasBinding({
        ok: true,
        state: "connected",
        origin: binding.origin,
        canvasBinding: binding
    }, null);
}

function popupCalendarNormalizeConnectionConsent(value, binding) {
    if (isPlainObject(value) && typeof value.valid === "boolean") {
        const sourceKey = value.sourceKey || value.source_key || null;
        const accountKey = value.accountKey || value.account_key || null;
        const version = value.version ?? value.consentVersion ?? value.consent_version;
        const scopes = Array.isArray(value.scopes) ? value.scopes.slice() : [];
        const scoped = value.valid === true
            && sourceKey === binding?.sourceKey
            && (!accountKey || accountKey === binding?.accountKey)
            && version === POPUP_CANVAS_CONSENT_VERSION
            && new Set(scopes).size === scopes.length
            && scopes.every((scope) => POPUP_CANVAS_CONSENT_SCOPES.includes(scope))
            && (value.current === false || scopes.length === POPUP_CANVAS_CONSENT_SCOPES.length);
        if (scoped) {
            return {
                valid: true,
                current: value.current === true && value.revoked !== true,
                revoked: value.revoked === true,
                sourceKey,
                accountKey: accountKey || binding.accountKey,
                version,
                scopes,
                code: null
            };
        }
    }
    return popupCalendarNormalizeConsent(value, binding);
}

function popupCalendarConsentCandidate(value) {
    const candidates = [];
    const add = (item) => { if (isPlainObject(item) && !candidates.includes(item)) candidates.push(item); };
    add(value);
    add(value?.payload);
    add(value?.body);
    add(value?.data);
    add(value?.consent);
    add(value?.payload?.body);
    add(value?.payload?.data);
    add(value?.body?.consent);
    add(value?.data?.consent);
    return candidates.find((item) => ["source_key", "sourceKey", "account_key", "accountKey", "consent_version", "consentVersion", "version", "scopes", "status", "current", "granted", "revoked"].some((key) => Object.prototype.hasOwnProperty.call(item, key))) || null;
}

function popupCalendarNormalizeConsent(value, binding) {
    const body = popupCalendarResponseBody(value);
    const nested = isPlainObject(body?.consent) ? body.consent : null;
    if (!body || !binding) return { valid: false, current: false, code: "CONSENT_RESPONSE_INVALID" };
    const field = (names) => {
        const values = [];
        for (const source of [body, nested]) {
            if (!isPlainObject(source)) continue;
            for (const name of names) if (Object.prototype.hasOwnProperty.call(source, name)) values.push(source[name]);
        }
        if (!values.length) return { present: false };
        const first = values[0];
        const equal = values.every((item) => Array.isArray(first)
            ? Array.isArray(item) && item.length === first.length && item.every((entry, index) => entry === first[index])
            : item === first);
        return { present: true, equal, value: first };
    };
    const version = field(["version"]);
    const current = field(["current"]);
    const grantedField = field(["granted"]);
    const source = field(["source_key", "sourceKey"]);
    const account = field(["account_key", "accountKey"]);
    const scopes = field(["scopes"]);
    const state = field(["state"]);
    const revokedField = field(["revoked"]);
    const hasScopedIdentity = (!body.contractVersion || body.contractVersion === 1)
        && body.ok !== false
        && version.present && version.equal && version.value === POPUP_CANVAS_CONSENT_VERSION
        && current.present && current.equal && typeof current.value === "boolean"
        && grantedField.present && grantedField.equal && typeof grantedField.value === "boolean"
        && source.present && source.equal && source.value === binding.sourceKey
        && (!account.present || (account.equal && account.value === binding.accountKey))
        && scopes.present && scopes.equal && Array.isArray(scopes.value)
        && new Set(scopes.value).size === scopes.value.length
        && scopes.value.every((scope) => POPUP_CANVAS_CONSENT_SCOPES.includes(scope))
        && (grantedField.value === false || scopes.value.length === POPUP_CANVAS_CONSENT_SCOPES.length);
    const granted = hasScopedIdentity && scopes.value.length === POPUP_CANVAS_CONSENT_SCOPES.length && grantedField.value === true && current.value === true;
    const revoked = hasScopedIdentity && (revokedField.value === true || state.value === "revoked");
    return {
        valid: hasScopedIdentity,
        current: hasScopedIdentity && granted && !revoked,
        revoked: hasScopedIdentity && revoked,
        sourceKey: hasScopedIdentity ? source.value : null,
        accountKey: hasScopedIdentity ? (account.present ? account.value : binding.accountKey) : null,
        version: hasScopedIdentity ? version.value : null,
        scopes: hasScopedIdentity ? scopes.value.slice() : [],
        code: hasScopedIdentity ? null : "CONSENT_RESPONSE_INVALID"
    };
}

function popupCalendarContextFromEvent(detail) {
    const state = detail?.state;
    const safeStates = new Set(["checking", "signed_out", "not_canvas", "not_open", "setup_needed", "timeout", "error", "unavailable"]);
    if (state !== "connected") return { state: safeStates.has(state) ? state : "unavailable", binding: null };
    const binding = normalizeCanvasBinding({
        ok: true,
        state: "connected",
        origin: detail?.canvasBinding?.origin,
        canvasBinding: detail?.canvasBinding
    }, detail?.profile || null);
    return { state: binding ? "connected" : "unavailable", binding };
}

const POPUP_CALENDAR_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const POPUP_CALENDAR_LABEL_PATTERN = /^[^\u0000-\u001f\u007f]{1,256}$/;

function popupCalendarSafeSourceRef(value) {
    return typeof value === "string" && /^src1:[A-Za-z0-9._~-]{1,128}$/.test(value) ? value : null;
}

function popupCalendarSafeId(value) {
    return typeof value === "string" && POPUP_CALENDAR_ID_PATTERN.test(value) ? value : null;
}

function popupCalendarSafeLabel(value) {
    if (typeof value !== "string" || !POPUP_CALENDAR_LABEL_PATTERN.test(value)) return null;
    const label = value.replace(/\s+/g, " ").trim();
    return label || null;
}

function popupCalendarResponseBody(value) {
    if (!isPlainObject(value)) return null;
    if (isPlainObject(value.payload)) return popupCalendarResponseBody(value.payload);
    if (isPlainObject(value.body)) return popupCalendarResponseBody(value.body);
    return value;
}

function popupCalendarNormalizeCalendars(value) {
    const body = popupCalendarResponseBody(value);
    if (!body || body.ok === false || !Array.isArray(body.calendars)) return null;
    const calendars = body.calendars.map((calendar) => {
        if (!isPlainObject(calendar)) return null;
        const id = popupCalendarSafeId(calendar.id);
        const label = popupCalendarSafeLabel(calendar.label);
        if (!id || !label || calendar.visible !== true || calendar.routing_eligible !== true) return null;
        return {
            id,
            label,
            readOnly: calendar.read_only === true,
            imported: calendar.imported === true,
            kind: popupCalendarSafeLabel(calendar.kind) || "calendar"
        };
    });
    if (calendars.some((calendar) => calendar === null)) return null;
    return { calendars, sourceRef: popupCalendarSafeSourceRef(body.source_ref), routing: body.routing };
}

function popupCalendarRoutingRecord(value, expectedState) {
    if (!isPlainObject(value)) return null;
    const state = value.state === "incomplete" || value.state === "completed" ? value.state : expectedState;
    const destination = popupCalendarSafeId(value.destination_calendar_id ?? value.destinationCalendarId);
    const fallbackValue = value.fallback_calendar_id ?? value.fallbackCalendarId;
    const fallback = fallbackValue === null || fallbackValue === undefined ? null : popupCalendarSafeId(fallbackValue);
    if (!state || !destination || (fallbackValue !== null && fallbackValue !== undefined && !fallback)) return null;
    return { state, destination, fallback };
}

function popupCalendarRoutingRecords(value) {
    const body = popupCalendarResponseBody(value);
    const source = isPlainObject(body?.routing) ? body.routing : body;
    const records = {};
    if (Array.isArray(source)) source.forEach((item) => {
        const record = popupCalendarRoutingRecord(item);
        if (record) records[record.state] = record;
    });
    ["incomplete", "completed"].forEach((state) => {
        const candidate = source?.[state] || source?.[`${state}_routing`];
        const record = popupCalendarRoutingRecord(candidate, state);
        if (record) records[state] = record;
    });
    const direct = popupCalendarRoutingRecord(source);
    if (direct) records[direct.state] = direct;
    return records;
}

function createPopupCanvasSyncSettingsStore() {
    if (!popupControllerApi?.createSettingsStore) return null;
    return popupControllerApi.createSettingsStore({
        sendUpdate: (changes) => popupPlatformRequest("SETTINGS_UPDATE", { area: "local", changes }),
        read: (keys) => storageAreaCall("local", "get", keys),
        normalizers: {
            canvas_sync_opt_in: (value) => settingsSchema.normalizeCanvasSyncOptIn(value) || {}
        },
        onStatus: () => {},
        onRollback: (_key, value) => popupCalendarController?.applyOptInSnapshot(value)
    });
}

const popupCanvasSyncSettingsStore = createPopupCanvasSyncSettingsStore();

const POPUP_CANVAS_WRITE_CONSENT_VERSION = 2;
const POPUP_CANVAS_WRITE_CONSENT_SCOPES = ["personal_events_write", "planner_items_write", "selected_item_mirroring"];

function popupCalendarNormalizeWriteConsent(value, binding) {
    const body = popupCalendarResponseBody(value);
    const consent = isPlainObject(body?.consent) ? body.consent : body;
    const invalid = { valid: false, current: false, scopes: [] };
    if (!binding || !consent || body.ok === false || consent.version !== POPUP_CANVAS_WRITE_CONSENT_VERSION
        || (consent.source_key ?? consent.sourceKey) !== binding.sourceKey
        || (consent.account_key ?? consent.accountKey) !== binding.accountKey
        || !Array.isArray(consent.scopes) || new Set(consent.scopes).size !== consent.scopes.length
        || consent.scopes.some((scope) => !POPUP_CANVAS_WRITE_CONSENT_SCOPES.includes(scope))) return invalid;
    return { valid: true, current: consent.current === true && (consent.granted === true || consent.valid === true) && consent.revoked !== true,
        version: 2, sourceKey: binding.sourceKey, accountKey: binding.accountKey, scopes: consent.scopes.slice() };
}

function createPopupCalendarController({ controller, document: doc, window: win } = {}) {
    const state = {
        contextState: "unavailable",
        binding: null,
        bindingGeneration: 0,
        consent: null,
        consentOperation: "idle",
        consentFailure: null,
        consentVerified: false,
        writeConsent: null,
        writeConsentLoading: false,
        writeConsentError: false,
        writeActivity: null,
        writeActivityBusy: false,
        optIns: {},
        rolloutEnabled: false,
        projectionEnabled: false,
        overlayEnabled: false,
        replacementEnabled: false,
        mutationEnabled: false,
        mirroringEnabled: false,
        capabilitiesFromConnection: false,
        capabilityError: false,
        localFlags: {},
        optInBusy: false,
        optInError: false,
        writeActivityError: false,
        calendarMode: "off",
        calendarModeLoading: false,
        calendarModeStatus: "Saved.",
        syncResult: null,
        syncBusy: false,
        syncRequestId: null,
        sourceRef: null,
        calendars: [],
        routing: { incomplete: null, completed: null },
        routeGeneration: { incomplete: 0, completed: 0 },
        routePending: { incomplete: false, completed: false },
        connectionGeneration: null,
        initialized: false
    };
    const actionListeners = [];
    function listen(node, type, handler) {
        node?.addEventListener?.(type, handler);
        if (node) actionListeners.push([node, type, handler]);
    }
    let consentOperationSequence = 0;
    let consentOperationQueue = Promise.resolve();
    let writeReadSequence = 0;
    let contextListenerBound = false;
    let actionListenersBound = false;
    let calendarModeListenerBound = false;
    let routeListenersBound = false;
    let storageListenerBound = false;
    let identitySignature = "";
    let destroyed = false;
    let contextListener = null;
    let connectionUnsubscribe = null;
    let identityObserver = null;
    let storageObserver = null;

    const q = (selector) => doc?.querySelector?.(selector) || null;
    const qa = (selector) => Array.from(doc?.querySelectorAll?.(selector) || []);
    const text = (selector, value) => {
        const node = q(selector);
        if (node) node.textContent = String(value ?? "");
    };
    const setDisabled = (control, disabled) => {
        if (!control) return;
        control.disabled = Boolean(disabled);
        control.setAttribute?.("aria-disabled", String(Boolean(disabled)));
    };

    function publishConnectionUpdate(update) {
        const connection = popupCalendarConnection(controller);
        if (!connection || typeof connection.update !== "function" || !isPlainObject(update)) return;
        try { connection.update(update); } catch (error) {}
    }

    function publishConnectionContext(binding) {
        const connection = popupCalendarConnection(controller);
        if (!connection || typeof connection.setContext !== "function") return;
        try { connection.setContext(binding || null); } catch (error) {}
    }

    function connectionGenerationToken() {
        const snapshot = popupCalendarConnectionSnapshot(controller);
        if (Number.isSafeInteger(snapshot?.generation) && snapshot.generation >= 0) {
            return { source: "connection", value: snapshot.generation };
        }
        return { source: "identity", value: controller?.state?.identityGeneration };
    }

    function applyCapabilities(capabilities, { fromConnection = false } = {}) {
        const normalized = popupCalendarNormalizeCapabilities(capabilities, state.localFlags);
        const previousProjection = state.projectionEnabled;
        state.rolloutEnabled = normalized.upload;
        state.projectionEnabled = normalized.projection;
        state.overlayEnabled = normalized.overlay;
        state.replacementEnabled = normalized.replacement;
        state.mutationEnabled = normalized.mutation;
        state.mirroringEnabled = normalized.mirroring;
        state.capabilitiesFromConnection = Boolean(fromConnection);
        if (previousProjection && !state.projectionEnabled) clearRoutingState(true);
    }

    function authenticated() {
        return popupCalendarIdentityStatus(controller) === "authenticated";
    }

    function currentBinding() {
        return state.contextState === "connected" && state.binding ? state.binding : null;
    }

    function consentCurrent() {
        return Boolean(state.consentVerified
            && state.consentOperation === "idle"
            && !state.consentFailure
            && state.consent?.valid
            && state.consent.current
            && !state.consent.revoked);
    }

    function consentBusy() {
        return ["checking", "saving", "revoking"].includes(state.consentOperation);
    }

    function invalidateConsentOperations() {
        consentOperationSequence += 1;
        consentOperationQueue = Promise.resolve();
        state.consentOperation = "idle";
        state.consentFailure = null;
        state.consentVerified = false;
    }

    function queueConsentOperation(operation, task) {
        const operationId = ++consentOperationSequence;
        const queued = consentOperationQueue.catch(() => {}).then(async () => {
            if (operationId !== consentOperationSequence || destroyed) return null;
            state.consentOperation = operation;
            state.consentFailure = null;
            state.consentVerified = false;
            publishConsentState();
            render();
            return task(operationId);
        });
        consentOperationQueue = queued.catch(() => {});
        return queued;
    }

    function isCurrentConsentOperation(operationId, generation, identityGeneration, binding) {
        return operationId === consentOperationSequence
            && isCurrentCompletion(generation, identityGeneration, binding);
    }

    function optInManageable() {
        return Boolean(authenticated() && currentBinding() && consentCurrent());
    }

    function optInEnabled() {
        return Boolean(optInManageable() && state.rolloutEnabled && currentBinding()?.extraction !== "unsupported");
    }

    function syncReady() {
        const binding = currentBinding();
        return Boolean(optInEnabled() && binding && state.optIns[binding.accountKey] === true);
    }

    function normalizeCalendarMode(value) {
        return ["off", "overlay", "replace"].includes(value) ? value : "off";
    }

    function overlayReady() {
        return Boolean(authenticated() && currentBinding() && consentCurrent() && state.projectionEnabled && state.overlayEnabled);
    }

    function calendarModeGuidance(mode) {
        if (mode === "replace") {
            return state.replacementEnabled
                ? "Experimental replacement is available."
                : "Experimental replacement is unavailable.";
        }
        if (mode === "off") return "";
        if (!authenticated()) {
            return popupCalendarIdentityStatus(controller) === "expired"
                ? "Sign in to Nest again for overlay."
                : "Sign in to Nest for overlay.";
        }
        if (!currentBinding()) return "Verify this Canvas account for overlay.";
        if (!consentCurrent()) return "Allow Canvas data access for overlay.";
        if (!state.projectionEnabled) return "Calendar overlay is not available for this connection.";
        if (!state.overlayEnabled) return "Overlay is unavailable on this platform.";
        return "Overlay is ready.";
    }

    function renderCalendarMode() {
        const mode = normalizeCalendarMode(state.calendarMode);
        const controls = qa("input[name=canvas-calendar-mode]");
        const status = q("#canvas-calendar-mode-status");
        controls.forEach((control) => {
            const value = normalizeCalendarMode(control.value);
            control.checked = value === mode;
            const model = presentation();
            const available = value === "off" || (value === "overlay" ? model.overlay : model.replacement);
            show(control.closest?.("label"), value === "off" || available);

            setDisabled(control, !available || state.calendarModeLoading || state.calendarModeLoadFailed === true);
        });
        if (status) {
            const statusValue = state.calendarModeLoading ? (state.calendarModeStatus === "Saving…" ? "Saving…" : "Loading calendar mode.") : state.calendarModeStatus || calendarModeGuidance(mode);
            status.textContent = statusValue;
            show(status, Boolean(statusValue && statusValue !== "Canvas only."));
            status.dataset.state = statusValue.startsWith("Saving") ? "saving" : statusValue.startsWith("Failed") ? "failed" : "saved";
        }
        const help = q("#canvas-calendar-mode-help");
        if (help) {
            const model = presentation();
            const fallback = mode !== "off" && !(mode === "overlay" ? model.overlay : model.replacement);
            help.textContent = fallback
                ? "Your saved calendar preference is unavailable. Canvas is shown instead. Choose Canvas only to change your preference."
                : "Overlay keeps the Canvas calendar visible.";
        }
    }

    async function loadCalendarMode() {
        state.calendarModeLoading = true;
        renderCalendarMode();
        try {
            const values = await storageAreaCall("sync", "get", ["canvas_calendar_mode"]);
            state.calendarModeLoadFailed = false;
            state.calendarMode = normalizeCalendarMode(values?.canvas_calendar_mode);
            state.calendarModeStatus = calendarModeGuidance(state.calendarMode);
        } catch (error) {
            state.calendarMode = "off";
            const retry = q("#workspace-account-retry");
            if (retry) retry.hidden = false;
            state.calendarModeLoadFailed = true;
            state.calendarModeStatus = "Failed — calendar mode could not be loaded. Retry account lookup to reload.";
        } finally {
            state.calendarModeLoading = false;
            render();
        }
        return state.calendarMode;
    }

    function applyCalendarModeSnapshot(value, status = "failed") {
        state.calendarMode = normalizeCalendarMode(value);
        state.calendarModeStatus = status === "failed" ? "Failed — calendar mode reverted." : calendarModeGuidance(state.calendarMode);
        renderCalendarMode();
    }

    function persistCalendarMode(value) {
        const next = normalizeCalendarMode(value);
        const previous = normalizeCalendarMode(state.calendarMode);
        const model = presentation();
        if (state.calendarModeLoading || (next !== "off" && !(next === "overlay" ? model.overlay : model.replacement))) {
            render();
            return Promise.reject(new Error("CALENDAR_MODE_UNAVAILABLE"));
        }
        state.calendarMode = next;
        state.calendarModeLoading = true;
        state.calendarModeStatus = "Saving…";
        renderCalendarMode();
        return queueSettingWrite({ canvas_calendar_mode: next }, "canvas-calendar-mode").then(() => {
            state.calendarModeLoading = false;
            state.calendarModeStatus = "Saved.";
            render();
            return next;
        }).catch((error) => {
            if (state.calendarMode === next) state.calendarMode = previous;
            state.calendarModeLoading = false;
            state.calendarModeStatus = "Failed — calendar mode reverted.";
            render();
            throw error;
        });
    }

    function syncPayload(binding, requestId) {
        if (!binding || typeof requestId !== "string") throw new Error("CANVAS_SYNC_BINDING_REQUIRED");
        return {
            contractVersion: 1,
            accountKey: binding.accountKey,
            origin: binding.origin,
            canvasUserId: binding.canvasUserId,
            sourceId: popupCalendarDeterministicSourceId(binding),
            label: binding.label,
            consentVersion: POPUP_CANVAS_CONSENT_VERSION,
            scope: popupCalendarClone(POPUP_CANVAS_SYNC_SCOPE),
            descriptors: popupCalendarClone(POPUP_CANVAS_SYNC_DESCRIPTORS),
            requestId
        };
    }

    function syncResultForRender() {
        return state.syncResult || { state: "idle" };
    }

    function renderSyncStatus() {
        const result = syncResultForRender();
        const status = q("#calendar-sync-status");
        if (!status) return;
        const stateLabel = popupCalendarSafeCode(result.state, "unavailable");
        status.dataset.state = stateLabel;
        let stateMessage = "Sync status is unavailable.";
        if (stateLabel === "idle") stateMessage = "Sync status is idle.";
        else if (stateLabel === "starting") stateMessage = "Sync is starting.";
        else if (stateLabel === "waiting_for_canvas_session" || stateLabel === "waiting") stateMessage = "Sync is waiting for the matching Canvas account session.";
        else if (stateLabel === "running") stateMessage = "Sync is running.";
        else if (stateLabel === "partial") stateMessage = "Sync is partial.";
        else if (stateLabel === "completed") stateMessage = "Sync is complete.";
        else if (stateLabel === "failed") stateMessage = "Sync failed.";
        else if (stateLabel === "cancelled") stateMessage = "Sync was cancelled.";
        text("#calendar-sync-status .calendar-sync-status-state", stateMessage);

        const progress = q("#calendar-sync-status [data-status-slot=progress]");
        const error = q("#calendar-sync-status [data-status-slot=error]");
        const countParts = popupCalendarCountSummary(result.counts);
        if (Number.isSafeInteger(result.count) && result.count >= 0) countParts.push(`Items: ${result.count.toLocaleString()}`);
        const guidance = popupCalendarSyncGuidance(result);
        const timestampParts = Object.entries(result.timestamps || {}).map(([key, value]) => {
            const date = new Date(value);
            const label = { timestamp: "Checked", startedAt: "Started", updatedAt: "Updated", completedAt: "Completed" }[key] || "Updated";
            return Number.isNaN(date.getTime()) ? "" : `${label} ${date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`;
        });
        if (progress) {
            progress.textContent = [...countParts, ...timestampParts, guidance].filter(Boolean).join(" · ");
            progress.hidden = !progress.textContent;
        }
        if (error) {
            error.textContent = result.errorCode ? "The last sync could not finish. Refresh status or try again." : "";
            error.hidden = !error.textContent;
        }
    }

    function identityGuidance() {
        const identityState = popupCalendarIdentityStatus(controller);
        if (identityState === "signed_out") return "Nest is signed out. Sign in to manage this Canvas account.";
        if (identityState === "expired") return "Nest session expired. Sign in again to manage this Canvas account.";
        if (identityState === "unavailable") return "Nest status is unavailable. Try again when transport is available.";
        return "";
    }

    function renderSafeLists() {
        const lists = [q("#workspace-canvas-account-list")].filter(Boolean);
        lists.forEach((list) => {
            list.replaceChildren?.();
            const binding = currentBinding();
            const accounts = [];

            const linked = []
                .concat(Array.isArray(controller?.state?.canvasAccounts) ? controller.state.canvasAccounts : [])
                .concat(authenticated() && Array.isArray(controller?.state?.nestLinkedAccounts) ? controller.state.nestLinkedAccounts : []);
            linked.forEach((account) => {
                const label = normalizePopupDisplayLabel(account?.displayName || account?.name || account?.label) || "Canvas account";
                const origin = normalizePopupCanvasOrigin(account?.origin);
                if (binding && (account?.accountKey || account?.account_key) === binding.accountKey) return;
                accounts.push({ state: "linked", label, origin, suffix: "linked" });
            });
            const pending = Array.isArray(controller?.state?.canvas?.pendingAccounts) ? controller.state.canvas.pendingAccounts : [];
            pending.forEach((account) => {
                if (binding && (account?.accountKey || account?.account_key) === binding.accountKey) return;
                const label = normalizePopupDisplayLabel(account?.displayName || account?.name || account?.label) || "Canvas account";
                const origin = normalizePopupCanvasOrigin(account?.origin);
                accounts.push({ state: "pending", label, origin, suffix: "pending verification" });
            });
            show(list, accounts.length > 0);
            show(q("#workspace-canvas-account-heading"), accounts.length > 0);
            accounts.forEach((account) => {
                const item = doc?.createElement?.("div");
                if (!item) return;
                item.className = account.state === "pending" ? "profile-account-card is-pending" : "profile-account-card";
                item.dataset.state = account.state;
                const host = account.origin ? account.origin.replace(/^https:\/\//, "") : "Canvas";
                item.textContent = `${account.label} · ${host} · ${account.suffix}`;
                list.appendChild(item);
            });
        });
    }

    function renderCurrentAccount() {
        const card = q("#canvas-current-account-card");
        const name = q("#canvas-current-account-name");
        const accountState = card?.querySelector?.(".calendar-account-state");
        const help = q("#canvas-current-account-help");
        const control = q("#canvas-current-account-sync-opt-in");
        const binding = currentBinding();
        const checked = Boolean(binding && state.optIns[binding.accountKey] === true);
        if (card) {
            card.hidden = !binding;
            card.inert = !binding;
            card.classList?.toggle("is-placeholder", !binding);
        }
        if (name) name.textContent = binding?.label || "Current Canvas account";
        if (accountState) accountState.textContent = binding ? "Verified Canvas account" : "Waiting for verified account context";
        if (control) {
            control.checked = checked;
            const canDisable = !authenticated() || !binding || (!checked && !optInEnabled()) || state.optInBusy;
            setDisabled(control, canDisable);
        }
        if (help) {
            if (state.optInError) help.textContent = "Sync preference could not be saved. Try the switch again.";
            else if (!binding) help.textContent = "A verified Canvas account is required before per-account settings are available.";
            else if (!authenticated()) help.textContent = identityGuidance();
            else if (!consentCurrent()) help.textContent = "Allow Canvas data access before turning on sync.";
            else if (!state.rolloutEnabled && !checked) help.textContent = "Sync is not available for this connection.";
            else help.textContent = "Choose Start sync to upload after turning this on.";
        }
    }

    function renderConsent() {
        const consentControl = q("#nest-consent-enabled");
        const consentRefresh = q("#nest-consent-refresh");
        const binding = currentBinding();
        const canManageConsent = Boolean(authenticated() && binding);
        setDisabled(consentControl, !canManageConsent || consentBusy() || Boolean(state.consentFailure));
        setDisabled(consentRefresh, !canManageConsent || consentBusy());
        if (consentControl) consentControl.checked = Boolean(state.consent?.current && !state.consent?.revoked);
        q("#nest-consent-status")?.classList?.toggle("is-error", Boolean(state.consentFailure || (state.consent && !state.consent.valid)));
        if (state.consentOperation === "checking") text("#nest-consent-status", "Checking Canvas data access…");
        else if (state.consentOperation === "saving") text("#nest-consent-status", "Saving Canvas data access…");
        else if (state.consentOperation === "revoking") text("#nest-consent-status", "Revoking Canvas data access…");
        else if (state.consentOperation === "verification-failed") text("#nest-consent-status", state.consentFailure === "verify-revoke"
            ? "Access was revoked, but could not be confirmed. Choose Check access to try again."
            : "Access was saved, but could not be confirmed. Choose Check access to try again.");
        else if (!binding) text("#nest-consent-status", "Verify a current Canvas account before managing consent.");
        else if (!authenticated()) text("#nest-consent-status", identityGuidance());
        else if (state.consentFailure === "save") text("#nest-consent-status", "Access could not be saved. Choose Check access to try again.");
        else if (state.consentFailure === "revoke") text("#nest-consent-status", "Access could not be revoked. Choose Check access to try again.");
        else if (state.consentFailure === "opt-in") text("#nest-consent-status", "Access was revoked, but the local sync preference could not be confirmed off.");
        else if (state.consentFailure === "check" || !state.consent?.valid) text("#nest-consent-status", "Access could not be checked. Choose Check access to try again.");
        else if (consentCurrent()) text("#nest-consent-status", "Consent is granted for this verified Canvas account.");
        else text("#nest-consent-status", "Consent is not granted for this verified Canvas account.");
    }

    function presentation() {
        const identity = popupCalendarConnectionSnapshot(controller)?.identity?.state || controller?.state?.identity?.state || "checking";
        const connected = identity === "authenticated";
        const bound = connected && Boolean(currentBinding());
        const access = bound && consentCurrent();
        const optedIn = Boolean(currentBinding() && state.optIns[currentBinding().accountKey]);
        const granted = (scope) => Boolean(state.writeConsent?.current && state.writeConsent.scopes.includes(scope));
        const permissions = Object.fromEntries(POPUP_CANVAS_WRITE_CONSENT_SCOPES.map((scope) => [scope,
            bound && (granted(scope) || (access && (scope === "selected_item_mirroring" ? state.mirroringEnabled : state.mutationEnabled)))]));
        const overlay = access && state.projectionEnabled && state.overlayEnabled;
        const replacement = access && state.projectionEnabled && state.replacementEnabled;
        const sync = access && state.rolloutEnabled && currentBinding()?.extraction !== "unsupported";
        const syncActivity = bound && Boolean(state.syncResult && state.syncResult.state !== "idle");
        const writeActivity = bound && Boolean(state.writeActivity?.length || state.writeActivityError || state.writeActivityBusy);
        let summary = "";
        let error = false;
        if (identity === "checking") summary = "Checking Nest connection…";
        else if (identity === "signed_out") summary = "Sign in to Nest to connect your Canvas account.";
        else if (identity === "expired") summary = "Your Nest session expired. Sign in again to continue.";
        else if (!connected) { summary = "Nest could not be checked. Retry to reconnect."; error = true; }
        else if (!bound) summary = "Open Settings from your signed-in Canvas page to verify this account.";
        else if (consentBusy() || state.consentOperation === "verification-failed" || state.consentFailure) summary = "";
        else if (!access) summary = "Allow Canvas data access to continue.";
        else if (state.capabilityError) { summary = "Available Nest features could not be checked. Retry to check again."; error = true; }
        else {
            const unavailable = [!sync && "sync", !overlay && "calendar overlay", !replacement && "calendar replacement",
                !state.mutationEnabled && "personal updates", !state.mirroringEnabled && "mirroring"].filter(Boolean);
            if (unavailable.length) summary = `Not available for this connection: ${unavailable.join(", ")}.`;
            else if (!optedIn) summary = "Turn on Sync this account when you’re ready. You choose when to start sync.";
        }
        return { identity, connected, bound, access, permissions, overlay, replacement, sync,
            optIn: bound && (optedIn || sync), syncActivity, writeActivity,
            calendar: overlay || replacement || state.calendarMode !== "off" || (access && state.projectionEnabled),
            summary, error };
    }

    function show(node, visible) {
        if (!node) return;
        node.hidden = !visible;
        node.inert = !visible;
    }

    function renderPresentation() {
        const model = presentation();
        state.presentation = model;
        const panel = (heading, visible) => show(q(`[aria-labelledby="${heading}-heading"]`), visible);
        panel("canvas-accounts", model.bound);
        panel("access-sync", model.bound);
        panel("calendar-display", model.calendar);
        panel("calendar-activity", model.syncActivity || model.writeActivity);
        show(q('#canvas-current-account-sync-opt-in')?.closest?.("label"), model.optIn);
        show(q('#canvas-current-account-help'), model.optIn);
        const permissionVisible = Object.values(model.permissions).some(Boolean);
        show(q('.account-permission-rows'), permissionVisible);
        qa('[data-write-scope]').forEach((control) => show(control.closest?.("label"), model.permissions[control.dataset.writeScope]));
        show(q('#nest-write-consent-status')?.closest?.('.account-tools-row'), permissionVisible);
        show(q('#calendar-mirror-select')?.closest?.('.account-tools-row'), model.access && state.mirroringEnabled && state.writeConsent?.current && state.writeConsent.scopes.includes("selected_item_mirroring"));
        show(q('#calendar-sync-controls'), model.sync);
        show(q('#calendar-sync-resume'), false);
        show(q('#calendar-sync-cancel'), false);
        show(q('#calendar-routing-controls'), model.access && state.projectionEnabled && Boolean(state.sourceRef));
        show(q('#calendar-sync-status'), model.syncActivity);
        show(q('#calendar-writeback-status')?.closest?.('.account-tools-row'), model.writeActivity);
        show(q('#calendar-writeback-items'), Boolean(model.writeActivity && state.writeActivity?.length));
        show(q('.calendar-capability-details'), false);
        ['#calendar-upload-capability', '#calendar-projection-capability'].forEach((selector) => show(q(selector), false));
        const status = q('#calendar-capability-status');
        text('#calendar-capability-status', model.summary);
        show(status, Boolean(model.summary));
        status?.classList?.toggle('is-error', model.error);
        // Binding and next-step copy share one owner; do not repeat a second explanation.
        show(q('#account-section-binding'), false);
        const login = q('#calendar-nest-login');
        show(login, ["signed_out", "expired"].includes(model.identity));
        setDisabled(login, !["signed_out", "expired"].includes(model.identity));
        login?.setAttribute?.('aria-hidden', String(login.hidden));
        if (login) login.textContent = model.identity === "expired" ? "Sign in again" : "Sign in to Nest";
        text('#calendar-accounts-status-value', model.connected ? "Nest connected" : model.identity === "checking" ? "Checking" : model.identity === "expired" ? "Session expired" : model.identity === "signed_out" ? "Signed out" : "Unavailable");
    }

    function renderSafeStatus() {
        renderSyncStatus();
    }

    function clearRoutingState(clearSource = true) {
        if (clearSource) state.sourceRef = null;
        state.calendars = [];
        state.routing = { incomplete: null, completed: null };
        state.routePending = { incomplete: false, completed: false };
        state.routeGeneration.incomplete += 1;
        state.routeGeneration.completed += 1;
    }

    function observeIdentity() {
        const current = `${controller?.state?.identityGeneration || 0}:${popupCalendarIdentityStatus(controller)}:${controller?.state?.identityUserKey || ""}`;
        if (identitySignature && identitySignature !== current) {
            clearRoutingState(true);
            invalidateConsentOperations();
            state.consent = null;
            state.writeConsent = null;
            state.writeConsentLoading = false;
            state.writeActivity = null;
            state.writeActivityBusy = false;
            state.syncResult = null;
            state.syncBusy = false;
            state.syncRequestId = null;
        }
        identitySignature = current;
    }

    function routeStageLabel(stage) {
        return stage === "completed" ? "completed" : "incomplete";
    }

    function routeDestinations() {
        return state.calendars.filter((calendar) => calendar && calendar.id && calendar.label);
    }

    function routeDestination(id) {
        return routeDestinations().find((calendar) => calendar.id === id) || null;
    }

    function routeFallback(stage, destination) {
        const current = state.routing[stage];
        const candidates = [current?.fallback, current?.destination, ...routeDestinations().map((calendar) => calendar.id)]
            .filter((id, index, values) => id && id !== destination && values.indexOf(id) === index);
        return candidates.find((id) => routeDestination(id)) || null;
    }

    function routeStatus(stage, message, status = "idle") {
        const node = q(`#calendar-route-${stage}-status`);
        if (!node) return;
        node.dataset.state = status;
        node.textContent = message;
    }

    function renderRouteSelector(stage) {
        const select = q(stage === "completed" ? "#calendar-route-completed-select" : "#calendar-route-select");
        if (!select) return;
        const destinations = routeDestinations();
        const current = state.routing[stage];
        const missing = current?.destination && !routeDestination(current.destination) ? current.destination : null;
        const display = routeDestination(current?.destination)
            ? current.destination
            : routeDestination(current?.fallback)?.id || destinations[0]?.id || "";
        select.replaceChildren?.();
        if (missing) {
            const unavailable = doc?.createElement?.("option");
            if (unavailable) {
                unavailable.value = missing;
                unavailable.textContent = `${missing} — unavailable; APStudy is showing the fallback`;
                unavailable.disabled = true;
                select.appendChild(unavailable);
            }
        }
        if (!destinations.length) {
            const empty = doc?.createElement?.("option");
            if (empty) {
                empty.value = "";
                empty.textContent = "No eligible destination available";
                empty.disabled = true;
                empty.selected = true;
                select.appendChild(empty);
            }
        } else destinations.forEach((calendar) => {
            const option = doc?.createElement?.("option");
            if (!option) return;
            option.value = calendar.id;
            const qualifier = calendar.readOnly || calendar.imported ? " — APStudy display override only" : "";
            option.textContent = `${calendar.label}${qualifier}`;
            option.selected = calendar.id === display;
            select.appendChild(option);
        });
        select.value = display;
        const disabled = !routingReady() || !destinations.length || state.routePending[stage];
        setDisabled(select, disabled);
        if (missing) {
            const fallback = routeDestination(display);
            routeStatus(stage, fallback
                ? `Destination unavailable. Showing ${fallback.label}; no data was removed.`
                : "Destination unavailable and no eligible fallback is available.", "degraded");
        } else if (state.routePending[stage]) {
            routeStatus(stage, "Saving…", "saving");
        } else if (routeDestination(display)?.readOnly || routeDestination(display)?.imported) {
            routeStatus(stage, "Saved. This is an APStudy display override only; the destination is read-only or imported.", "saved");
        } else if (destinations.length) {
            routeStatus(stage, "Saved.", "saved");
        } else {
            routeStatus(stage, routingGuidance(), "degraded");
        }
    }

    function routingGuidance() {
        if (!authenticated()) return identityGuidance();
        if (!currentBinding()) return "Verify the current Canvas account before routing calendars.";
        if (!consentCurrent()) return "Allow Canvas data access for this account.";
        if (!state.projectionEnabled) return "Calendar destinations are not available for this connection.";
        if (!state.sourceRef) return "Start or refresh sync to establish a safe calendar source reference.";
        if (!state.calendars.length) return "No visible routing-eligible calendars are available.";
        return "Calendar destinations are unavailable.";
    }

    function routingReady() {
        return Boolean(authenticated() && currentBinding() && consentCurrent() && state.projectionEnabled && popupCalendarSafeSourceRef(state.sourceRef));
    }

    function renderRouting() {
        const routing = q("#calendar-routing-controls");
        const availableContext = presentation().access && state.projectionEnabled;
        if (routing) {
            show(routing, availableContext && Boolean(state.sourceRef));
        }
        ["incomplete", "completed"].forEach(renderRouteSelector);
        if (!availableContext) return;
        if (!routingReady()) {
            routeStatus("incomplete", routingGuidance(), "degraded");
            routeStatus("completed", routingGuidance(), "degraded");
        }
    }

    function routingResponse(value, stage) {
        const records = popupCalendarRoutingRecords(value);
        return records[stage] || records.incomplete || records.completed || null;
    }

    async function saveRouting(stage, selected) {
        if (!routingReady()) return null;
        const destination = routeDestination(selected);
        if (!destination) return null;
        const generation = ++state.routeGeneration[stage];
        const identityGeneration = connectionGenerationToken();
        const binding = currentBinding();
        const sourceRef = state.sourceRef;
        const fallback = routeFallback(stage, destination.id);
        const previous = popupCalendarClone(state.routing[stage]);
        state.routing[stage] = { state: stage, destination: destination.id, fallback };
        state.routePending[stage] = true;
        renderRouteSelector(stage);
        try {
            const result = await popupPlatformRequest("NEST_ROUTING_SET", {
                source_ref: sourceRef,
                state: stage,
                destination_calendar_id: destination.id,
                fallback_calendar_id: fallback
            });
            const current = generation === state.routeGeneration[stage]
                && state.sourceRef === sourceRef
                && isCurrentCompletion(state.bindingGeneration, identityGeneration, binding);
            if (!current) return null;
            const serverRecord = routingResponse(result, stage);
            if (serverRecord) state.routing[stage] = serverRecord;
            state.routePending[stage] = false;
            renderRouteSelector(stage);
            routeStatus(stage, routeDestination(state.routing[stage]?.destination)?.readOnly || routeDestination(state.routing[stage]?.destination)?.imported
                ? "Saved. This is an APStudy display override only; the destination is read-only or imported."
                : "Saved.", "saved");
            return result;
        } catch (error) {
            const current = generation === state.routeGeneration[stage] && state.sourceRef === sourceRef;
            if (!current) return null;
            state.routing[stage] = previous;
            state.routePending[stage] = false;
            renderRouteSelector(stage);
            routeStatus(stage, "Failed — destination reverted.", "failed");
            return null;
        }
    }

    function bindRoutingActions() {
        if (routeListenersBound) return;
        routeListenersBound = true;
        ["incomplete", "completed"].forEach((stage) => {
            const select = q(stage === "completed" ? "#calendar-route-completed-select" : "#calendar-route-select");
            listen(select, "change", (event) => {
                event.stopImmediatePropagation?.();
                event.stopPropagation?.();
                const selected = popupCalendarSafeId(event.currentTarget?.value || event.target?.value);
                if (!selected || !routeDestination(selected)) {
                    renderRouteSelector(stage);
                    return;
                }
                void saveRouting(stage, selected);
            });
        });
    }

    function renderSyncControls() {
        setDisabled(q("#calendar-sync-start"), !syncReady() || state.syncBusy);
        setDisabled(q("#calendar-sync-refresh"), !syncReady() || state.syncBusy);
        // The public router intentionally redacts run/source/generation
        // references. Resume and Cancel stay inert until a safe public
        // identity exists; lease tokens are never accepted here.
        setDisabled(q("#calendar-sync-resume"), true);
        setDisabled(q("#calendar-sync-cancel"), true);
        renderRouting();
    }

    function render() {
        observeIdentity();
        renderSafeStatus();
        renderConsent();
        renderWriteConsent();
        renderWriteActivity();
        renderCurrentAccount();
        renderSafeLists();
        renderCalendarMode();
        renderSyncControls();
        renderPresentation();
    }

    function isCurrentCompletion(generation, identityGeneration, binding) {
        if (destroyed) return false;
        const current = currentBinding();
        if (identityGeneration?.source === "connection") {
            const connection = popupCalendarConnection(controller);
            if (typeof connection?.isCurrent === "function" && !connection.isCurrent(identityGeneration.value)) return false;
        } else if (identityGeneration?.source === "identity" && controller?.state?.identityGeneration !== identityGeneration.value) {
            return false;
        } else if (!identityGeneration?.source && controller?.state?.identityGeneration !== identityGeneration) {
            return false;
        }
        return state.bindingGeneration === generation
            && authenticated()
            && current?.accountKey === binding?.accountKey
            && current?.sourceKey === binding?.sourceKey;
    }

    async function runSyncRequest(type) {
        if (!syncReady()) return null;
        const binding = currentBinding();
        const generation = state.bindingGeneration;
        const identityGeneration = connectionGenerationToken();
        const requestId = type === "CANVAS_SYNC_START"
            ? popupCalendarSafeRequestId()
            : state.syncRequestId || popupCalendarSafeRequestId();
        state.syncRequestId = requestId;
        state.syncBusy = true;
        state.syncResult = { state: type === "CANVAS_SYNC_START" ? "starting" : "checking" };
        render();
        try {
            const result = await popupPlatformRequest(type, syncPayload(binding, requestId));
            if (!isCurrentCompletion(generation, identityGeneration, binding)) return null;
            state.syncResult = popupCalendarSafeSyncResult(result);
            if (state.syncResult.source_ref && ["CANVAS_SYNC_START", "CANVAS_SYNC_STATUS"].includes(type)) {
                state.sourceRef = state.syncResult.source_ref;
                void loadCalendars().catch(() => {});
            }
            return state.syncResult;
        } catch (error) {
            if (!isCurrentCompletion(generation, identityGeneration, binding)) return null;
            state.syncResult = {
                state: "failed",
                errorCode: popupCalendarSafeCode(error?.code || error?.message, "SYNC_TRANSPORT_UNAVAILABLE")
            };
            return state.syncResult;
        } finally {
            if (isCurrentCompletion(generation, identityGeneration, binding)) {
                state.syncBusy = false;
                render();
            }
        }
    }

    function startSync() {
        return runSyncRequest("CANVAS_SYNC_START");
    }

    function refreshSyncStatus() {
        return runSyncRequest("CANVAS_SYNC_STATUS");
    }

    async function loadOptIns() {
        try {
            const values = await storageAreaCall("local", "get", ["canvas_sync_opt_in"]);
            const normalized = settingsSchema.normalizeCanvasSyncOptIn(values?.canvas_sync_opt_in);
            state.optIns = normalized || {};
        } catch (error) {
            state.optIns = {};
        }
        render();
        return state.optIns;
    }

    async function loadRollout() {
        const generation = connectionGenerationToken();
        try {
            const values = await storageAreaCall("local", "get", ["platform.flags"]);
            if (JSON.stringify(generation) !== JSON.stringify(connectionGenerationToken())) return;
            const contract = globalThis.APStudyCanvasPlatform?.Contract;
            state.localFlags = contract?.normalizeFeatureFlags
                ? contract.normalizeFeatureFlags(values?.["platform.flags"])
                : values?.["platform.flags"] || {};
            state.capabilityError = false;
            const snapshot = popupCalendarConnectionSnapshot(controller);
            const capabilities = snapshot?.identity?.capabilities || snapshot?.capabilities;
            applyCapabilities(capabilities || {}, { fromConnection: Boolean(capabilities) });
        } catch (error) {
            if (JSON.stringify(generation) !== JSON.stringify(connectionGenerationToken())) return;
            state.capabilityError = true;
            applyCapabilities({});
        }
        render();
        if (state.projectionEnabled && routingReady() && state.sourceRef) void loadCalendars().catch(() => {});
        return state.rolloutEnabled;
    }

    async function loadCalendars() {
        const binding = currentBinding();
        if (!routingReady() || !binding) {
            state.calendars = [];
            renderRouting();
            return null;
        }
        const generation = state.bindingGeneration;
        const identityGeneration = connectionGenerationToken();
        const sourceRef = state.sourceRef;
        let normalized;
        try {
            const result = await popupPlatformRequest("NEST_CALENDARS_GET", { source_ref: sourceRef });
            normalized = popupCalendarNormalizeCalendars(result);
            if (!normalized || (normalized.sourceRef && normalized.sourceRef !== sourceRef)) throw new Error("NEST_CALENDARS_RESPONSE_INVALID");
        } catch (error) {
            if (isCurrentCompletion(generation, identityGeneration, binding) && state.sourceRef === sourceRef) {
                state.calendars = [];
                renderRouting();
            }
            return null;
        }
        if (!isCurrentCompletion(generation, identityGeneration, binding) || state.sourceRef !== sourceRef) return null;
        state.calendars = normalized.calendars;
        const records = popupCalendarRoutingRecords({ routing: normalized.routing });
        ["incomplete", "completed"].forEach((stage) => {
            const server = records[stage];
            if (server) state.routing[stage] = server;
            else if (!state.routing[stage] || !routeDestination(state.routing[stage].destination)) {
                state.routing[stage] = { state: stage, destination: state.calendars[0]?.id || "", fallback: null };
            }
        });
        renderRouting();
        return normalized;
    }

    async function persistOptIn(value, { requireGate = true } = {}) {
        const binding = currentBinding();
        if (!binding || !authenticated() || (requireGate && value === true && !consentCurrent()) || (requireGate && value === true && !state.rolloutEnabled)) {
            throw new Error("CANVAS_SYNC_OPT_IN_NOT_AVAILABLE");
        }
        if (!popupCanvasSyncSettingsStore) throw new Error("CANVAS_SYNC_SETTINGS_UNAVAILABLE");
        const previous = popupCalendarClone(state.optIns);
        const next = popupCalendarClone(state.optIns) || {};
        next[binding.accountKey] = Boolean(value);
        const normalized = settingsSchema.normalizeCanvasSyncOptIn(next);
        if (!normalized) throw new Error("CANVAS_SYNC_OPT_IN_INVALID");
        if (state.optInBusy) throw new Error("CANVAS_SYNC_OPT_IN_PENDING");
        const generation = state.bindingGeneration;
        const identityGeneration = connectionGenerationToken();
        state.optInBusy = true;
        state.optInError = false;
        state.optIns = normalized;
        render();
        try {
            await popupCanvasSyncSettingsStore.updateField("canvas_sync_opt_in", normalized);
            return normalized;
        } catch (error) {
            if (isCurrentCompletion(generation, identityGeneration, binding)) {
                state.optIns = previous || {};
                state.optInError = true;
            }
            throw error;
        } finally {
            if (isCurrentCompletion(generation, identityGeneration, binding)) { state.optInBusy = false; render(); }
        }
    }

    function publishConsentState() {
        let read = state.consent;
        if (read && !consentCurrent()) {
            read = { ...popupCalendarClone(read), current: false, granted: false };
        }
        publishConnectionUpdate({ consent: { read, write: state.writeConsent } });
    }

    function writeCapability() {
        return state.mutationEnabled || state.mirroringEnabled;
    }

    function renderWriteConsent() {
        const available = Boolean(authenticated() && currentBinding());
        qa("[data-write-scope]").forEach((control) => {
            control.checked = Boolean(state.writeConsent?.current && state.writeConsent.scopes.includes(control.dataset.writeScope));
            const supported = control.dataset.writeScope === "selected_item_mirroring" ? state.mirroringEnabled : state.mutationEnabled;
            setDisabled(control, !available || state.writeConsentLoading || !state.writeConsent?.valid || (!control.checked && (!consentCurrent() || !supported)));
        });
        setDisabled(q("#nest-write-consent-refresh"), !available || state.writeConsentLoading);
        setDisabled(q("#calendar-mirror-select"), !available || !state.writeConsent?.current
            || !state.writeConsent.scopes.includes("selected_item_mirroring") || !state.mirroringEnabled);
        text("#nest-write-consent-status", !available ? "Connect Nest and verify a Canvas account to manage personal item permissions."
            : state.writeConsentLoading ? "Saving or checking permissions…"
            : state.writeConsentError || !state.writeConsent?.valid ? "Personal item permissions could not be checked. Try refreshing."
            : state.writeConsent.current ? "Your selected permissions are saved for this Canvas account."
            : "Personal item updates and mirroring are off.");
    }

    async function loadWriteConsent() {
        const binding = currentBinding();
        if (!binding || !authenticated()) return;
        const sequence = ++writeReadSequence;
        const generation = state.bindingGeneration;
        const identityGeneration = connectionGenerationToken();
        state.writeConsentLoading = true;
        renderWriteConsent();
        let consent;
        try {
            const result = await popupPlatformRequest("NEST_CONSENT_GET", { source_key: binding.sourceKey, account_key: binding.accountKey, version: POPUP_CANVAS_WRITE_CONSENT_VERSION });
            consent = popupCalendarNormalizeWriteConsent(result, binding);
        } catch (_) { consent = { valid: false, current: false, scopes: [] }; }
        if (sequence !== writeReadSequence || !isCurrentCompletion(generation, identityGeneration, binding)) return;
        state.writeConsentError = !consent.valid;
        if (consent.valid || !state.writeConsent) state.writeConsent = consent;
        state.writeConsentLoading = false;
        publishConsentState();
        render();
    }

    async function setWriteConsentScope(scope, grant) {
        const binding = currentBinding();
        if (!binding || !authenticated() || state.writeConsentLoading || !POPUP_CANVAS_WRITE_CONSENT_SCOPES.includes(scope)) { renderWriteConsent(); return; }
        if (grant && (!consentCurrent() || !(scope === "selected_item_mirroring" ? state.mirroringEnabled : state.mutationEnabled))) { render(); return; }
        // Refresh is required before editing an unknown grant, so an unrelated scope cannot be overwritten.
        if (!state.writeConsent?.valid) { await loadWriteConsent(); return; }
        const generation = state.bindingGeneration;
        const identityGeneration = connectionGenerationToken();
        const confirmedConsent = state.writeConsent;
        state.writeConsentError = false;
        const scopes = new Set(state.writeConsent.current ? state.writeConsent.scopes : []);
        if (grant) scopes.add(scope); else scopes.delete(scope);
        state.writeConsentLoading = true;
        renderWriteConsent();
        try {
            const saved = await popupPlatformRequest("NEST_CONSENT_SET", { source_key: binding.sourceKey, account_key: binding.accountKey,
                version: POPUP_CANVAS_WRITE_CONSENT_VERSION, action: scopes.size ? "grant" : "revoke", scopes: [...scopes] });
            if (saved?.ok === false || popupCalendarResponseBody(saved)?.ok === false) throw new Error("CONSENT_SAVE_FAILED");
            if (!isCurrentCompletion(generation, identityGeneration, binding)) return;
            await loadWriteConsent();
            if (!isCurrentCompletion(generation, identityGeneration, binding)) return;
            if (state.writeConsentError || !state.writeConsent?.valid || Boolean(state.writeConsent.current && state.writeConsent.scopes.includes(scope)) !== grant) throw new Error("WRITE_CONSENT_NOT_CONFIRMED");
        } catch (_) {
            if (!isCurrentCompletion(generation, identityGeneration, binding)) return;
            state.writeConsent = confirmedConsent;
            state.writeConsentError = true;
            state.writeConsentLoading = false;
            render();
            text("#nest-write-consent-status", "Permissions could not be saved. Your previous choices are still shown.");
        }
    }

    function renderWriteActivity() {
        const ready = Boolean(authenticated() && currentBinding() && consentCurrent() && state.sourceRef && writeCapability());
        setDisabled(q("#calendar-writeback-refresh"), !ready || state.writeActivityBusy);
        text("#calendar-writeback-status", !ready ? "Personal item activity is available after connecting an account with personal updates enabled."
            : state.writeActivityBusy ? "Checking personal item activity…"
            : state.writeActivity === null ? "Refresh to check personal item activity."
            : state.writeActivity.length ? "Review the items below. Conflicts wait for your choice." : "No personal item changes need attention.");
        renderPresentation();
        const list = q("#calendar-writeback-items");
        list?.replaceChildren?.();
        if (!ready || !list) return;
        (state.writeActivity || []).forEach((item) => {
            const row = doc.createElement("div"); row.className = "account-activity-row";
            const summary = doc.createElement("p");
            summary.textContent = `${item.event_ref.startsWith("task:") ? "Planner item" : "Personal event"} ${item.event_ref.split(":").slice(1).join(":")} · ${popupCalendarReadableLabel(item.state)}`;
            row.appendChild(summary);
            if (item.state === "conflict") {
                const versions = doc.createElement("dl"); versions.className = "account-conflict-versions";
                for (const [label, snapshot] of [["Canvas version", item.conflict?.canvasSnapshot], ["Nest version", item.conflict?.nestSnapshot]]) {
                    const heading = doc.createElement("dt"); heading.textContent = label;
                    const details = doc.createElement("dd");
                    const fields = [["title", "Title"], ["description", "Description"], ["start", "Start"], ["end", "End"], ["is_all_day", "All day"], ["deadline_at", "Due"], ["completed", "Completed"], ["deleted", "Deleted"]];
                    details.textContent = snapshot ? fields.filter(([key]) => snapshot[key] !== undefined && snapshot[key] !== null).map(([key, name]) => `${name}: ${snapshot[key]}`).join("\n") : "Version unavailable. Open Canvas, then refresh activity.";
                    versions.appendChild(heading); versions.appendChild(details);
                }
                row.appendChild(versions);
            }
            const actions = doc.createElement("div"); actions.className = "account-activity-actions";
            const choices = item.state === "conflict" ? [["keep_canvas", "Keep Canvas"], ["apply_writeback", "Keep Nest"], ["unlink", "Unlink, keep copies"]]
                : ["failed", "retryable", "retryable_failed", "waiting_for_canvas_session"].includes(item.state) ? [["retry", "Retry"]] : [];
            choices.forEach(([choice, label]) => {
                const button = doc.createElement("button"); button.type = "button"; button.className = "workspace-action"; button.textContent = label;
                button.dataset.writebackKey = item.idempotency_key; button.dataset.writebackChoice = choice;
                setDisabled(button, state.writeActivityBusy || (["keep_canvas", "apply_writeback"].includes(choice) && (!item.conflict?.canvasSnapshot || !item.conflict?.expected_revision)) || (choice === "apply_writeback" && item.operation === "create"));
                button.addEventListener("click", () => { void actOnWriteActivity(item.idempotency_key, choice); });
                actions.appendChild(button);
            });
            row.appendChild(actions); list.appendChild(row);
        });
    }

    async function refreshWriteActivity() {
        return requestWriteActivity("CANVAS_WRITEBACK_STATUS");
    }

    async function actOnWriteActivity(key, choice) {
        if (!state.writeActivity?.some((item) => item.idempotency_key === key) || !["retry", "keep_canvas", "apply_writeback", "unlink"].includes(choice)) return;
        return requestWriteActivity(choice === "retry" ? "CANVAS_WRITEBACK_RETRY" : "CANVAS_WRITEBACK_RESOLVE",
            { idempotency_key: key, ...(choice === "retry" ? {} : { choice, expected_revision: state.writeActivity.find(item => item.idempotency_key === key)?.conflict?.expected_revision }) });
    }

    async function requestWriteActivity(type, extra = {}) {
        const binding = currentBinding();
        if (!authenticated() || !binding || !consentCurrent() || !state.sourceRef || !writeCapability() || state.writeActivityBusy) return;
        const generation = state.bindingGeneration;
        const identityGeneration = connectionGenerationToken();
        const sourceRef = state.sourceRef;
        const focusedAction = doc.activeElement?.dataset?.writebackKey ? { key: doc.activeElement.dataset.writebackKey, choice: doc.activeElement.dataset.writebackChoice } : null;
        const restoreFocus = () => {
            if (!focusedAction) return;
            const button = Array.from(q("#calendar-writeback-items")?.querySelectorAll?.("button") || []).find(node => node.dataset.writebackKey === focusedAction.key && node.dataset.writebackChoice === focusedAction.choice && !node.disabled);
            (button || q("#calendar-writeback-refresh"))?.focus?.({ preventScroll: true });
        };
        state.writeActivityBusy = true; renderWriteActivity();
        try {
            const result = await popupPlatformRequest(type, { account_key: binding.accountKey, source_ref: sourceRef, ...extra });
            if (!isCurrentCompletion(generation, identityGeneration, binding) || sourceRef !== state.sourceRef) return;
            if (popupCalendarResponseBody(result)?.ok === false) {
                if (popupCalendarResponseBody(result)?.code === "WRITEBACK_CONFLICT_CHANGED") {
                    state.writeActivityBusy = false;
                    await refreshWriteActivity();
                    restoreFocus();
                    text("#calendar-writeback-status", "This item changed. Review the refreshed versions before choosing again.");
                    return;
                }
                throw new Error("WRITE_ACTIVITY_UNAVAILABLE");
            }
            if (type !== "CANVAS_WRITEBACK_STATUS") {
                state.writeActivityBusy = false;
                await refreshWriteActivity();
                restoreFocus();
                return;
            }
            const items = popupCalendarResponseBody(result)?.items;
            if (!Array.isArray(items)) throw new Error("WRITE_ACTIVITY_INVALID");
            state.writeActivityError = false;
            state.writeActivity = items.slice(0, 100).filter((item) => isPlainObject(item)
                && typeof item.idempotency_key === "string" && /^[A-Za-z0-9._:-]{1,160}$/.test(item.idempotency_key)
                && typeof item.event_ref === "string" && /^(user|task|canvas):[A-Za-z0-9._:~-]{1,255}$/.test(item.event_ref)
                && typeof item.state === "string" && /^[a-z_]{1,60}$/.test(item.state));
            state.writeActivityBusy = false; renderWriteActivity();
            restoreFocus();
        } catch (_) {
            if (!isCurrentCompletion(generation, identityGeneration, binding)) return;
            state.writeActivityError = true;
            state.writeActivityBusy = false; renderWriteActivity();
            text("#calendar-writeback-status", "Personal item activity could not be refreshed. Try again.");
            restoreFocus();
        }
    }

    async function fetchConsent(binding) {
        try {
            const result = await popupPlatformRequest("NEST_CONSENT_GET", {
                source_key: binding.sourceKey,
                account_key: binding.accountKey,
                version: POPUP_CANVAS_CONSENT_VERSION
            });
            return popupCalendarNormalizeConsent(result, binding);
        } catch (error) {
            return { valid: false, current: false, revoked: false, code: popupCalendarSafeCode(error?.code || error?.message, "CONSENT_TRANSPORT_UNAVAILABLE") };
        }
    }

    function loadConsent() {
        const binding = currentBinding();
        if (!binding || !authenticated()) {
            invalidateConsentOperations();
            state.consent = null;
            state.writeConsent = null;
            state.writeConsentLoading = false;
            state.writeActivity = null;
            state.writeActivityBusy = false;
            publishConnectionUpdate({ consent: null });
            render();
            return Promise.resolve(null);
        }
        const generation = state.bindingGeneration;
        const identityGeneration = connectionGenerationToken();
        return queueConsentOperation("checking", async (operationId) => {
            const normalized = await fetchConsent(binding);
            if (!isCurrentConsentOperation(operationId, generation, identityGeneration, binding)) return null;
            const previous = state.consent;
            if (normalized.valid) {
                state.consent = normalized;
                state.consentVerified = true;
                state.consentFailure = null;
            } else {
                state.consentVerified = false;
                state.consentFailure = "check";
            }
            state.consentOperation = "idle";
            publishConsentState();
            if (normalized.valid && previous && JSON.stringify(previous) !== JSON.stringify(normalized)) clearRoutingState(true);
            render();
            if (state.optIns[binding.accountKey] === true && normalized.valid && !consentCurrent() && (normalized.revoked || !normalized.current)) {
                try { await persistOptIn(false, { requireGate: false }); } catch (error) {}
            }
            if (syncReady() && !state.sourceRef && !state.syncBusy) await refreshSyncStatus();
            return normalized.valid ? state.consent : null;
        });
    }

    function setConsent(grant) {
        const binding = currentBinding();
        if (!binding || !authenticated()) {
            renderConsent();
            return Promise.reject(new Error("CANVAS_CONSENT_NOT_AVAILABLE"));
        }
        const generation = state.bindingGeneration;
        const identityGeneration = connectionGenerationToken();
        const confirmedConsent = state.consent;
        const action = grant ? "grant" : "revoke";
        return queueConsentOperation(grant ? "saving" : "revoking", async (operationId) => {
            clearRoutingState(true);
            let optInError = null;
            let mutationSucceeded = false;
            try {
                if (!grant) {
                    try { await persistOptIn(false, { requireGate: false }); } catch (error) { optInError = error; }
                }
                if (!isCurrentConsentOperation(operationId, generation, identityGeneration, binding)) return null;
                const saved = await popupPlatformRequest("NEST_CONSENT_SET", {
                    source_key: binding.sourceKey,
                    account_key: binding.accountKey,
                    action,
                    scopes: POPUP_CANVAS_CONSENT_SCOPES.slice(),
                    version: POPUP_CANVAS_CONSENT_VERSION
                });
                if (!isCurrentConsentOperation(operationId, generation, identityGeneration, binding)) return null;
                if (saved?.ok === false || popupCalendarResponseBody(saved)?.ok === false) throw new Error("CONSENT_SAVE_FAILED");
                mutationSucceeded = true;
                const normalized = await fetchConsent(binding);
                if (!isCurrentConsentOperation(operationId, generation, identityGeneration, binding)) return null;
                if (!normalized.valid || Boolean(normalized.current && !normalized.revoked) !== grant) {
                    throw new Error("CONSENT_NOT_CONFIRMED");
                }
                state.consent = normalized;
                state.consentVerified = true;
                state.consentOperation = "idle";
                state.consentFailure = optInError ? "opt-in" : null;
                publishConsentState();
                render();
                return state.consent;
            } catch (error) {
                if (!isCurrentConsentOperation(operationId, generation, identityGeneration, binding)) return null;
                state.consent = confirmedConsent;
                state.consentVerified = false;
                state.consentOperation = mutationSucceeded ? "verification-failed" : "idle";
                state.consentFailure = mutationSucceeded ? (grant ? "verify-save" : "verify-revoke") : (grant ? "save" : "revoke");
                publishConsentState();
                render();
                throw error;
            }
        });
    }

    function applyConnectionSnapshot(snapshot, { loadFreshConsent = false } = {}) {
        if (!isPlainObject(snapshot) || destroyed) return;
        const nextBinding = popupCalendarConnectionBinding(snapshot.binding);
        const nextIdentity = ["authenticated", "signed_out", "expired", "unavailable"].includes(snapshot.identity?.state)
            ? snapshot.identity.state
            : popupCalendarIdentityStatus(controller);
        const nextState = nextBinding ? "connected" : "unavailable";
        const generationChanged = state.connectionGeneration !== null && snapshot.generation !== state.connectionGeneration;
        const bindingChanged = generationChanged || state.contextState !== nextState
            || state.binding?.accountKey !== nextBinding?.accountKey
            || state.binding?.sourceKey !== nextBinding?.sourceKey
            || state.binding?.origin !== nextBinding?.origin;
        if (Number.isSafeInteger(snapshot.generation) && snapshot.generation >= 0) state.connectionGeneration = snapshot.generation;
        applyCapabilities(snapshot.capabilities || {}, { fromConnection: true });
        if (bindingChanged) {
            invalidateConsentOperations();
            state.optInBusy = false;
            state.optInError = false;
            state.writeActivityError = false;
            state.contextState = nextState;
            state.binding = nextBinding;
            state.bindingGeneration += 1;
            state.consent = null;
            state.writeConsent = null;
            state.writeConsentLoading = false;
            state.writeActivity = null;
            state.writeActivityBusy = false;
            clearRoutingState(true);
            state.syncResult = null;
            state.syncBusy = false;
            state.syncRequestId = null;
        }
        const binding = currentBinding();
        const consentSnapshotBlocked = consentBusy()
            || state.consentOperation === "verification-failed"
            || Boolean(state.consentFailure);
        if (isPlainObject(snapshot.consent) && binding && !consentSnapshotBlocked) {
            const normalized = popupCalendarNormalizeConnectionConsent(snapshot.consent.read || snapshot.consent, binding);
            if (snapshot.consent.write && !state.writeConsentLoading) state.writeConsent = popupCalendarNormalizeWriteConsent(snapshot.consent.write, binding);
            const previous = state.consent;
            state.consent = normalized;
            state.consentVerified = normalized.valid;
            if (previous && JSON.stringify(previous) !== JSON.stringify(normalized)) clearRoutingState(true);
        }
        if (nextIdentity !== "authenticated") {
            invalidateConsentOperations();
            state.optInBusy = false;
            state.writeActivityError = false;
            state.consent = null;
            state.writeConsent = null;
            state.writeConsentLoading = false;
            state.writeActivity = null;
            state.writeActivityBusy = false;
            clearRoutingState(true);
            state.syncResult = null;
            state.syncBusy = false;
            state.syncRequestId = null;
        }
        render();
        if (state.initialized && bindingChanged && nextIdentity === "authenticated") void loadRollout();
        if (state.initialized && binding && nextIdentity === "authenticated" && !state.writeConsent && !state.writeConsentLoading) void loadWriteConsent();
        if (state.initialized && loadFreshConsent && binding && nextIdentity === "authenticated" && !state.consent && !consentBusy() && !state.consentFailure) void loadConsent();
    }

    function bindConnectionSnapshot() {
        const connection = popupCalendarConnection(controller);
        if (!connection) return;
        applyConnectionSnapshot(popupCalendarConnectionSnapshot(controller), { loadFreshConsent: false });
        if (typeof connection.subscribe === "function" && !connectionUnsubscribe) {
            try {
                const unsubscribe = connection.subscribe((snapshot) => {
                    applyConnectionSnapshot(snapshot, { loadFreshConsent: true });
                });
                if (typeof unsubscribe === "function") connectionUnsubscribe = unsubscribe;
            } catch (error) {}
        }
    }

    function onCanvasContext(event) {
        event?.stopPropagation?.();
        const context = popupCalendarContextFromEvent(event?.detail);
        const sourceTabId = normalizePopupSourceTabId(event?.detail?.sourceTabId);
        publishConnectionContext(context.binding);
        state.contextState = context.state;
        state.binding = context.binding;
        state.bindingGeneration += 1;
        invalidateConsentOperations();
        state.consent = null;
        state.writeConsent = null;
        state.writeConsentLoading = false;
        state.writeActivity = null;
        state.writeActivityBusy = false;
        clearRoutingState(true);
        state.syncResult = null;
        state.syncBusy = false;
        state.syncRequestId = null;
        if (controller?.state) {
            controller.state.canvas = {
                state: context.state,
                profile: event?.detail?.profile || null,
                unread: event?.detail?.unread || null,
                canvasBinding: context.binding,
                sourceTabId
            };
            controller.renderCanvasAvailability?.();
        }
        render();
        if (state.initialized && context.binding && authenticated()) void Promise.allSettled([loadConsent(), loadWriteConsent()]);
    }

    function bindActions() {
        if (actionListenersBound) return;
        actionListenersBound = true;
        bindRoutingActions();
        qa("[data-write-scope]").forEach((control) => listen(control, "change", (event) => {
            event.stopImmediatePropagation?.();
            void setWriteConsentScope(control.dataset.writeScope, control.checked);
        }));
        listen(q("#nest-write-consent-refresh"), "click", () => { void loadWriteConsent(); });
        listen(q("#calendar-mirror-select"), "click", async () => {
            const binding = currentBinding();
            if (!binding || !authenticated() || !state.writeConsent?.current
                || !state.writeConsent.scopes.includes("selected_item_mirroring") || !state.mirroringEnabled) return;
            try { await chrome.tabs.create({ url: `${binding.origin}/calendar` }); }
            catch (_) { text("#calendar-mirror-selection-help", "The calendar could not be opened. Open Canvas Calendar in your browser to select an item."); }
        });
        listen(q("#calendar-writeback-refresh"), "click", () => { void refreshWriteActivity(); });
        if (!calendarModeListenerBound) {
            calendarModeListenerBound = true;
            qa("input[name=canvas-calendar-mode]").forEach((control) => {
                listen(control, "change", (event) => {
                    event.stopImmediatePropagation?.();
                    event.stopPropagation?.();
                    if (event.currentTarget?.disabled) {
                        renderCalendarMode();
                        return;
                    }
                    persistCalendarMode(event.currentTarget?.value).catch(() => {});
                });
            });
        }
        listen(q("#nest-consent-enabled"), "change", (event) => {
            event.stopImmediatePropagation?.();
            event.stopPropagation?.();
            setConsent(Boolean(event.currentTarget?.checked)).catch(() => {});
        });
        listen(q("#nest-consent-refresh"), "click", (event) => {
            event.stopImmediatePropagation?.();
            event.stopPropagation?.();
            loadConsent().catch(() => {});
        });
        listen(q("#canvas-current-account-sync-opt-in"), "change", (event) => {
            event.stopImmediatePropagation?.();
            event.stopPropagation?.();
            persistOptIn(Boolean(event.currentTarget?.checked)).catch(() => {
                renderCurrentAccount();
            });
        });
        listen(q("#calendar-sync-start"), "click", (event) => {
            event.stopImmediatePropagation?.();
            event.stopPropagation?.();
            startSync().catch(() => {});
        });
        listen(q("#calendar-sync-refresh"), "click", (event) => {
            event.stopImmediatePropagation?.();
            event.stopPropagation?.();
            refreshSyncStatus().catch(() => {});
        });
    }

    if (win?.addEventListener && !contextListenerBound) {
        contextListenerBound = true;
        contextListener = onCanvasContext;
        win.addEventListener("apstudycanvas-canvas-context", contextListener);
        identityObserver = () => { if (!destroyed) render(); };
        win.addEventListener("focus", identityObserver);
        win.addEventListener("visibilitychange", identityObserver);
        win.addEventListener("pagehide", destroy, { once: true });
    }

    const chromeStorage = globalThis.chrome?.storage;
    if (!storageListenerBound && chromeStorage?.onChanged?.addListener) {
        storageListenerBound = true;
        storageObserver = (changes, areaName) => {
            if (destroyed) return;
            if (areaName === "local" && changes?.["platform.flags"]) void loadRollout();
            if (areaName === "local" && changes?.canvas_sync_opt_in) api.applyOptInSnapshot(changes.canvas_sync_opt_in.newValue);
            if (areaName === "sync" && changes?.canvas_calendar_mode && !state.calendarModeLoading) {
                state.calendarMode = normalizeCalendarMode(changes.canvas_calendar_mode.newValue);
                state.calendarModeStatus = calendarModeGuidance(state.calendarMode);
                render();
            }
        };
        chromeStorage.onChanged.addListener(storageObserver);
    }

    function destroy() {
        if (destroyed) return;
        destroyed = true;
        actionListeners.splice(0).forEach(([node, type, handler]) => node.removeEventListener?.(type, handler));
        if (contextListener && win?.removeEventListener) win.removeEventListener("apstudycanvas-canvas-context", contextListener);
        if (identityObserver && win?.removeEventListener) {
            win.removeEventListener("focus", identityObserver);
            win.removeEventListener("visibilitychange", identityObserver);
        }
        if (connectionUnsubscribe) {
            try { connectionUnsubscribe(); } catch (error) {}
            connectionUnsubscribe = null;
        }
        if (storageObserver && chromeStorage?.onChanged?.removeListener) chromeStorage.onChanged.removeListener(storageObserver);
        clearRoutingState(true);
        invalidateConsentOperations();
        state.consent = null;
        state.writeConsent = null;
        state.writeConsentLoading = false;
        state.writeActivity = null;
        state.writeActivityBusy = false;
        state.syncResult = null;
        renderRouting();
    }

    async function refreshSupplementaryData() {
        await Promise.allSettled([loadOptIns(), loadRollout(), loadCalendarMode(), loadConsent(), loadWriteConsent()]);
        render();
    }

    async function init() {
        if (state.initialized) return api;
        state.initialized = true;
        bindConnectionSnapshot();
        bindActions();
        render();
        await Promise.all([
            Promise.resolve(controller?.init?.()).then(() => { bindConnectionSnapshot(); }),
            loadOptIns(),
            loadRollout(),
            loadCalendarMode()
        ]);
        render();
        await Promise.allSettled([loadConsent(), loadWriteConsent()]);
        return api;
    }

    const api = {
        state,
        init,
        render,
        refreshSupplementaryData,
        loadConsent,
        setConsent,
        loadWriteConsent,
        setWriteConsentScope,
        refreshWriteActivity,
        actOnWriteActivity,
        loadOptIns,
        loadCalendarMode,
        persistCalendarMode,
        applyCalendarModeSnapshot,
        loadRollout,
        persistOptIn,
        loadCalendars,
        saveRouting,
        handleIdentityChange() {
            clearRoutingState(true);
            invalidateConsentOperations();
            state.consent = null;
            state.writeConsent = null;
            state.writeConsentLoading = false;
            state.writeActivity = null;
            state.writeActivityBusy = false;
            state.syncResult = null;
            state.syncBusy = false;
            state.syncRequestId = null;
            render();
        },
        destroy,
        applyOptInSnapshot(value) {
            state.optIns = settingsSchema.normalizeCanvasSyncOptIn(value) || {};
            render();
        }
    };
    return api;
}

let popupLiveApply = null;

function queueSettingWrite(changes, debounceKey = "settings") {
    void debounceKey;
    if (!popupSettingsStore) return Promise.reject(new Error("SETTINGS_STORE_UNAVAILABLE"));
    if (!isPlainObject(changes)) return Promise.resolve();
    const writes = Object.entries(changes).map(([key, value]) => popupSettingsStore.updateField(key, value));
    if (!writes.length) return Promise.resolve();
    return Promise.all(writes).then((results) => {
        const done = typeof popupLiveApply === "function" ? popupLiveApply(changes) : Promise.resolve();
        return done.then((outcome) => {
            if (outcome?.appliesNextLoad && outcome?.applied !== true) {
                setSaveStatus("Saved. Refresh Canvas to see this change.");
            }
            return results.length === 1 ? results[0] : results;
        });
    });
}

function flushPendingWrites() {
    return Promise.all([
        popupSettingsStore?.flush?.() || Promise.resolve(),
        popupCanvasSyncSettingsStore?.flush?.() || Promise.resolve()
    ]).then(() => undefined);
}

async function runExplicitTransaction(snapshot, validate, changes) {
    if (!popupSettingsStore) throw new Error("SETTINGS_STORE_UNAVAILABLE");
    let snapshotValues = {};
    let attemptedChanges = changes && typeof changes === "object" ? changes : {};
    try {
        const transactionChanges = typeof changes === "function"
            ? async (current) => {
                const next = await changes(current);
                if (next && typeof next === "object") attemptedChanges = next;
                return next;
            }
            : changes;
        return await popupSettingsStore.transaction(transactionChanges, {
            read: async () => {
                const resolvedSnapshot = typeof snapshot === "function" ? await snapshot() : snapshot;
                snapshotValues = cloneSetting(resolvedSnapshot ?? {});
                return snapshotValues;
            },
            validate: async (next, current) => {
                const result = typeof validate === "function" ? await validate(next, current) : true;
                if (result === false || (result && result.valid === false)) {
                    throw new Error(result?.message || "Settings validation failed.");
                }
                return true;
            }
        }).then((result) => {
            if (typeof popupLiveApply === "function" && isPlainObject(attemptedChanges)) {
                return popupLiveApply(attemptedChanges).then(() => result);
            }
            return result;
        });
    } catch (error) {
        restoreSettingUi(attemptedChanges, snapshotValues);
        setSaveStatus(error.message === SETTINGS_SAVE_FAILURE_MESSAGE ? error.message : SETTINGS_SAVE_FAILURE_MESSAGE, true);
        throw error;
    }
}

window.queueSettingWrite = queueSettingWrite;
window.flushPendingWrites = flushPendingWrites;
window.runExplicitTransaction = runExplicitTransaction;

function flushWritesOnTeardown() {
    flushPendingWrites().catch(() => setSaveStatus("Failed — pending changes could not be saved.", true));
}
window.addEventListener("pagehide", flushWritesOnTeardown);
window.addEventListener("beforeunload", flushWritesOnTeardown);
document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushWritesOnTeardown();
});

if (popupControllerApi?.createController) {
    const popupController = popupControllerApi.createController({
        document,
        window,
        chromeApi: createEmbeddedOverlayChromeApi(chrome, { windowRef: window, documentRef: document }),
        contract: popupCalendarContract(window.APStudyCanvasPlatform?.Contract),
        defaults: settingsSchema.syncDefaults,
        settingsStore: popupSettingsStore
    });
    popupLiveApply = (changes) => popupController.applyLiveChanges?.(changes) || Promise.resolve();
    popupCalendarController = createPopupCalendarController({ controller: popupController, document, window });
    const refreshIdentity = popupController.refreshIdentity;
    popupController.refreshIdentity = (...args) => {
        popupCalendarController.handleIdentityChange?.();
        return Promise.resolve(refreshIdentity.apply(popupController, args)).finally(() => popupCalendarController.render?.());
    };
    window.APStudyCanvasPopup = popupController;
    window.APStudyCanvasCalendarAccounts = popupCalendarController;
    window.APStudyCanvasPopupStartup = popupControllerApi.createStartup({
        controller: popupController,
        document,
        loaders: [
            () => requireHostedSourceAtStartup(),
            () => { void initializePopupChrome(); },
            () => window.APStudyCanvasEditCanvasStartup?.start?.()
        ],
        onReady: () => popupController.signalReady(),
        // Calendar/account discovery is supplementary workspace data. The
        // embedded shell must become interactive and acknowledge its active
        // session before a slow or failed optional lookup can delay it.
        afterReady: () => {
            // Keep the best-effort calendar initialization detached from the
            // session protocol. A transient account failure must not delay
            // initial draft protection or turn a ready frame back into error.
            Promise.resolve(popupController.state.accountLoadPromise).then(() => popupCalendarController.init()).catch(() => {});
            return popupController.signalDraftState({
                draft: window.APStudyCanvasThemeDraft?.isDirty?.() === true
            });
        },
        onAfterReadyError: (error) => popupController.reportDraftSyncFailure(error),
        onError: (error) => popupController.reportStartupFailure(error)
    });
}

document.addEventListener("change", () => { flushPendingWrites().catch(() => {}); });
document.addEventListener("blur", () => { flushPendingWrites().catch(() => {}); }, true);

chrome.storage.onChanged.addListener((changes) => {
    Object.keys(changes).forEach((key) => {
        if (pendingKeys.has(key)) return;
        const value = changes[key].newValue;
        knownSyncValues[key] = value;
        settingControlsForKey(key).forEach((control) => {
            if (control.type === "checkbox" || control.type === "radio") control.checked = value === true;
            else if (control.tagName === "INPUT" || control.tagName === "TEXTAREA" || control.tagName === "SELECT") control.value = value ?? "";
        });
    });
});
