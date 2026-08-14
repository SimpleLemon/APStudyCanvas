const syncedSwitches = ['remind', 'tab_icons', 'hide_feedback', 'dark_mode', 'remlogo', 'full_width', 'auto_dark', 'assignments_due', 'gpa_calc', 'gradient_cards', 'disable_color_overlay', 'dashboard_grades', 'dashboard_notes', 'better_todo', 'better_sidebar', 'condensed_cards'];
const syncedSubOptions = [
	"todo_hide_feedback",
	"todo_full_height",
    "todo_confetti",
	"device_dark",
	"relative_dues",
	"card_overdues",
	// "todo_overdues",
	"gpa_calc_prepend",
	"auto_dark",
	"auto_dark_start",
	"auto_dark_end",
	"num_assignments",
	"assignment_date_format",
	"todo_hr24",
	"todo_separate_scrollbar",
	"grade_hover",
	// "hide_completed",
	"num_todo_items",
	"hover_preview",
	// "scheduledReminder",
	// "scheduledReminderTime",
	"customCardStyles",
	"imageSize",
	"cardRoundness",
	"cardSpacing",
	"cardWidth",
	"cardHeight",
	"customBackgroundLink",
    "customBackgroundScale",
    "sidebar_scale",
];
const localSwitches = [];
const fontsDropdownStateKey = "fonts_dropdown_open";
const pendingCardColorsKey = "popup.pending_card_colors";

//const apiurl = "http://localhost:3000";
// const apiurl = "https://canvasrefined.diditupe.dev";
const apiurl = "none";

const settingsSchema = globalThis.APStudyCanvasSchema;
if (!settingsSchema) throw new Error("APStudyCanvas settings schema did not load.");
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

function normalizePopupSourceTabId(value) {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function parseFullscreenSourceTabId(search) {
    if (typeof search !== "string") return null;
    let params;
    try {
        params = new URLSearchParams(search);
    } catch (error) {
        return null;
    }
    const fullscreenValues = params.getAll("fullscreen");
    const sourceValues = params.getAll("sourceCanvasTabId");
    if (fullscreenValues.length !== 1 || fullscreenValues[0] !== "1"
        || sourceValues.length !== 1 || !/^[1-9]\d*$/.test(sourceValues[0])) return null;
    const sourceTabId = Number(sourceValues[0]);
    return Number.isSafeInteger(sourceTabId) && sourceTabId > 0 ? sourceTabId : null;
}

function fullscreenSourceParamPresent(search) {
    if (typeof search !== "string") return false;
    try {
        const params = new URLSearchParams(search);
        return params.getAll("fullscreen").length === 1
            && params.get("fullscreen") === "1"
            && params.has("sourceCanvasTabId");
    } catch (error) {
        return false;
    }
}

// Snapshot the route synchronously while popup.js is evaluated. The first
// Canvas lookup must not depend on workspace initialization or script order.
const popupStartupSearch = typeof window !== "undefined" && window.location ? window.location.search : "";
const popupStartupHasFullscreenSource = fullscreenSourceParamPresent(popupStartupSearch);
const popupStartupSourceTabId = parseFullscreenSourceTabId(popupStartupSearch);

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
        return { ok: true, state: response.state, profile, unread, canvasBinding: normalizeCanvasBinding(response, profile) };
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
        sourceTabId: normalizePopupSourceTabId(sourceTabId)
    };
}

window.APStudyCanvasPopupContext = Object.freeze({ normalizeCanvasBinding, sanitizeCanvasContext, canvasContextEventDetail, normalizePopupSourceTabId, parseFullscreenSourceTabId });

function expandedRouteHasSource() {
    return popupStartupHasFullscreenSource;
}

function expandedRouteSourceTabId() {
    return popupStartupSourceTabId;
}

function platformEnvelope(type, payload = {}) {
    const contract = globalThis.APStudyCanvasPlatform?.Contract;
    return contract?.createEnvelope
        ? contract.createEnvelope(type, payload)
        : { version: 1, request_id: `popup-${Date.now()}-${Math.random().toString(16).slice(2)}`, type, payload };
}

async function mappedPopupSourceTabId() {
    if (!chrome.runtime?.sendMessage || !chrome.windows?.getCurrent) return { present: false, tabId: null };
    let currentWindow;
    try {
        currentWindow = await chrome.windows.getCurrent();
    } catch (error) {
        return { present: false, tabId: null };
    }
    if (!Number.isSafeInteger(currentWindow?.id)) return { present: false, tabId: null };
    try {
        const response = await chrome.runtime.sendMessage(platformEnvelope("POPUP_CONTEXT_GET"));
        const result = response?.payload || response || {};
        const mappings = result?.mappings;
        const key = String(currentWindow.id);
        if (!isPlainObject(mappings) || !Object.prototype.hasOwnProperty.call(mappings, key)) {
            return { present: false, tabId: null };
        }
        const tabId = normalizePopupSourceTabId(mappings[key]);
        return { present: true, tabId: Number.isSafeInteger(tabId) && tabId > 0 ? tabId : null };
    } catch (error) {
        return { present: false, tabId: null };
    }
}

async function allowedCanvasSourceOrigins() {
    const origins = new Set(["https://canvas.emory.edu"]);
    try {
        const stored = await chrome.storage?.sync?.get?.(["custom_domain"]);
        const configured = normalizeCanvasDomains(stored?.custom_domain);
        if (configured.valid) configured.value.forEach((origin) => origins.add(origin));
    } catch (error) {}
    return origins;
}

function tabOrigin(tab) {
    try {
        return normalizePopupCanvasOrigin(new URL(tab?.url || "").origin);
    } catch (error) {
        return null;
    }
}

async function validateCanvasSourceTab(tab) {
    const origin = tabOrigin(tab);
    if (!origin) return { ok: false, state: "not_canvas", code: "SOURCE_TAB_NOT_CANVAS" };
    const allowed = await allowedCanvasSourceOrigins();
    if (!allowed.has(origin)) return { ok: false, state: "not_canvas", code: "SOURCE_TAB_NOT_CANVAS" };
    return { ok: true, origin };
}

function validateCanvasContextForTab(response, tab, expectedOrigin) {
    if (!response || typeof response !== "object") return { ok: false, state: "error", code: "INVALID_CANVAS_CONTEXT" };
    const responseOrigin = response.origin === undefined ? null : normalizePopupCanvasOrigin(response.origin);
    const bindingOrigin = response.canvasBinding?.origin === undefined
        ? null
        : normalizePopupCanvasOrigin(response.canvasBinding.origin);
    const currentOrigin = tabOrigin(tab);
    if (!currentOrigin || currentOrigin !== expectedOrigin) return { ok: false, state: "error", code: "SOURCE_TAB_CHANGED" };
    if (response.ok === true && response.state === "connected") {
        if (!responseOrigin || responseOrigin !== expectedOrigin || (bindingOrigin && bindingOrigin !== expectedOrigin)) {
            return { ok: false, state: "error", code: "CANVAS_CONTEXT_TAB_MISMATCH" };
        }
    } else if (responseOrigin && responseOrigin !== expectedOrigin) {
        return { ok: false, state: "error", code: "CANVAS_CONTEXT_TAB_MISMATCH" };
    }
    return null;
}

async function getValidatedTab(tabId) {
    if (!Number.isSafeInteger(tabId) || tabId <= 0 || !chrome.tabs?.get) {
        return { tab: null, tabId: null, state: "not_open", code: "SOURCE_TAB_UNAVAILABLE" };
    }
    let tab;
    try {
        tab = await chrome.tabs.get(tabId);
    } catch (error) {
        return { tab: null, tabId: null, state: "not_open", code: "SOURCE_TAB_UNAVAILABLE" };
    }
    if (!Number.isSafeInteger(tab?.id) || tab.id !== tabId) {
        return { tab: null, tabId: null, state: "not_open", code: "SOURCE_TAB_UNAVAILABLE" };
    }
    const validation = await validateCanvasSourceTab(tab);
    if (!validation.ok) return { tab: null, tabId: null, state: validation.state, code: validation.code };
    return { tab, tabId, origin: validation.origin };
}

async function resolvePopupSourceTab() {
    const hasUrlSource = expandedRouteHasSource();
    const urlSourceTabId = expandedRouteSourceTabId();
    if (hasUrlSource) {
        if (!Number.isSafeInteger(urlSourceTabId)) return { tab: null, tabId: null, state: "not_open", code: "SOURCE_TAB_UNAVAILABLE" };
        return getValidatedTab(urlSourceTabId);
    }

    const mapped = await mappedPopupSourceTabId();
    if (mapped.present) {
        if (!Number.isSafeInteger(mapped.tabId)) return { tab: null, tabId: null, state: "not_open", code: "SOURCE_TAB_UNAVAILABLE" };
        return getValidatedTab(mapped.tabId);
    }

    if (!chrome.tabs?.query) return { tab: null, tabId: null, state: "not_open", code: "SOURCE_TAB_UNAVAILABLE" };
    try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        const tab = tabs?.[0] || null;
        if (!Number.isSafeInteger(tab?.id)) return { tab: null, tabId: null, state: "not_open", code: "SOURCE_TAB_UNAVAILABLE" };
        const validated = await validateCanvasSourceTab(tab);
        return validated.ok
            ? { tab, tabId: tab.id, origin: validated.origin }
            : { tab: null, tabId: null, state: validated.state, code: validated.code };
    } catch (error) {
        return { tab: null, tabId: null, state: "not_open", code: "SOURCE_TAB_UNAVAILABLE" };
    }
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
    const source = await resolvePopupSourceTab();
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
        const currentValidation = await validateCanvasSourceTab(currentTab);
        if (!currentValidation.ok || currentValidation.origin !== source.origin) {
            return { response: safeCanvasContextFailure(currentValidation.state || "error", currentValidation.code || "SOURCE_TAB_CHANGED"), sourceTabId: null };
        }
        const contextResult = result?.type === "GET_CANVAS_CONTEXT" && isPlainObject(result.payload) ? result.payload : result;
        const mismatch = validateCanvasContextForTab(contextResult, currentTab, source.origin);
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
    const status = document.getElementById("home-connection-status");
    if (!status?.parentElement) return null;
    let action = document.getElementById("canvas-connection-action");
    if (!action) {
        action = document.createElement("button");
        action.type = "button";
        action.id = "canvas-connection-action";
        action.className = "home-secondary-button";
        status.parentElement.appendChild(action);
    }
    return action;
}

function ensureCanvasRefreshAction() {
    const status = document.getElementById("home-connection-status");
    if (!status?.parentElement) return null;
    let action = document.getElementById("canvas-refresh-action");
    if (!action) {
        action = document.createElement("button");
        action.type = "button";
        action.id = "canvas-refresh-action";
        action.className = "home-secondary-button";
        action.textContent = "Refresh Canvas";
        status.parentElement.appendChild(action);
        action.addEventListener("click", async () => {
            if (!Number.isInteger(canvasContextSourceTabId) || !chrome.tabs?.reload) return;
            try {
                await chrome.tabs.get(canvasContextSourceTabId);
                await chrome.tabs.reload(canvasContextSourceTabId);
            } catch (error) {
                setCanvasHeaderState(safeCanvasContextFailure("not_open", "SOURCE_TAB_UNAVAILABLE"), null);
            }
        });
    }
    return action;
}

function canvasInitials(displayName) {
    const parts = String(displayName || "").trim().split(/\s+/).filter(Boolean);
    return (parts.length > 1 ? `${parts[0][0]}${parts[parts.length - 1][0]}` : parts[0]?.[0] || "").toUpperCase().slice(0, 2);
}

function renderCanvasProfile(profile) {
    const avatar = document.querySelector("#profile-button .profile-avatar");
    const popover = document.getElementById("profile-popover");
    if (!avatar) return;
    const name = profile?.displayName || "";
    const initials = canvasInitials(name);
    const useFallback = () => {
        avatar.style.backgroundImage = name ? "" : `url(${chrome.runtime.getURL("icon/icon-19.png")})`;
        avatar.textContent = initials || (name ? "A" : "");
    };
    if (profile?.avatarUrl) avatar.dataset.avatarUrl = profile.avatarUrl;
    else delete avatar.dataset.avatarUrl;
    useFallback();
    if (profile?.avatarUrl) {
        const image = new Image();
        image.onload = () => {
            if (avatar.dataset.avatarUrl !== profile.avatarUrl) return;
            avatar.style.backgroundImage = `url("${profile.avatarUrl.replace(/"/g, "%22")}")`;
            avatar.textContent = "";
        };
        image.onerror = () => {
            if (avatar.dataset.avatarUrl === profile.avatarUrl) useFallback();
        };
        image.src = profile.avatarUrl;
    }
    if (!popover) return;
    let nameNode = popover.querySelector(".profile-display-name");
    if (!nameNode) {
        nameNode = document.createElement("p");
        nameNode.className = "profile-display-name";
        popover.querySelector(".popover-heading")?.after(nameNode);
    }
    nameNode.textContent = name;
    nameNode.hidden = !name;
}

function setCanvasHeaderState(response, sourceTabId) {
    const status = document.getElementById("home-connection-status");
    if (!status) return;
    const action = ensureCanvasHeaderAction();
    const refresh = ensureCanvasRefreshAction();
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
    status.textContent = labels[state] || labels.error;
    status.dataset.canvasState = state;
    status.classList.toggle("is-connected", state === "connected");
    if (action) {
        const isRetry = state === "timeout" || state === "error";
        action.hidden = state === "checking" || state === "connected";
        action.textContent = isRetry ? "Retry" : state === "signed_out" ? "Sign in to Canvas" : "Open Canvas to connect";
        action.dataset.canvasAction = isRetry ? "retry" : "open";
    }
    if (refresh) {
        refresh.hidden = !(Number.isInteger(sourceTabId) && (state === "connected" || state === "signed_out"));
    }
    renderCanvasProfile(response?.ok ? response.profile : null);
    const profileStatus = document.querySelector("#profile-popover .popover-status span:last-child");
    if (profileStatus) profileStatus.textContent = labels[state] || labels.error;
    const profileHelp = document.querySelector("#profile-popover .popover-help");
    if (profileHelp) profileHelp.textContent = "Canvas profile and unread status are read from the open Canvas tab and kept in memory for this popup.";
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
        const normalized = normalizeCanvasDomains(stored.custom_domain);
        domains = normalized.valid ? normalized.value : [];
    } catch (error) {
        domains = [];
    }
    const origin = domains[0];
    if (origin && chrome.tabs?.create) {
        await chrome.tabs.create({ url: `${origin}/` });
        return;
    }
    document.getElementById("home-edit-canvas")?.click();
    setCanvasHeaderState(safeCanvasContextFailure("setup_needed", "CANVAS_SETUP_REQUIRED"), null);
    ["home-save-status", "workspace-save-status"].forEach((id) => {
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
    checkCanvasContext();
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
        local = await chrome.storage.local.get(["seen_update_version"]);
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
    renderNotifications().catch(() => {});
}

document.addEventListener("DOMContentLoaded", () => {
    setupCanvasConnection();
    setupNotifications();
});

function isPlainObject(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function asPlainObject(value) {
    return isPlainObject(value) ? value : {};
}

function validateSafeHttpsUrl(value, allowBlank = false) {
    const candidate = typeof value === "string" ? value.trim() : "";
    if (!candidate && allowBlank) return { valid: true, value: "" };
    try {
        const url = new URL(candidate);
        const hostname = url.hostname.toLowerCase();
        if (url.protocol !== "https:") {
            return { valid: false, value: candidate, message: "Use an HTTPS URL. HTTP and localhost require a permission expansion." };
        }
        if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || !hostname.includes(".")) {
            return { valid: false, value: candidate, message: "Use a public HTTPS hostname. HTTP and localhost require a permission expansion." };
        }
        return { valid: true, value: url.href };
    } catch (error) {
        return { valid: false, value: candidate, message: "Enter a valid HTTPS URL." };
    }
}

function normalizeCanvasDomains(rawValue) {
    const values = Array.isArray(rawValue) ? rawValue : String(rawValue || "").split(",");
    const domains = [];
    for (const raw of values) {
        const candidate = String(raw || "").trim();
        if (!candidate) continue;
        let url;
        try {
            url = new URL(candidate.includes("://") ? candidate : `https://${candidate}`);
        } catch (error) {
            return { valid: false, message: "Use a valid HTTPS Canvas hostname. HTTP and localhost require a permission expansion." };
        }
            if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || (url.pathname !== "" && url.pathname !== "/") || url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]" || !url.hostname.includes(".")) {
            return { valid: false, message: "Use a valid HTTPS Canvas hostname. HTTP and localhost require a permission expansion." };
        }
        domains.push(url.origin);
    }
    return { valid: true, value: domains };
}

function permissionApi(chromeApi = globalThis.chrome) {
    return chromeApi?.permissions || globalThis.browser?.permissions || null;
}

function permissionCall(method, query, chromeApi = globalThis.chrome) {
    const api = permissionApi(chromeApi);
    if (!api || typeof api[method] !== "function") return Promise.reject(Object.assign(new Error("browser_unsupported"), { code: "browser_unsupported" }));
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (callback, value) => {
            if (settled) return;
            settled = true;
            callback(value);
        };
        const callback = (value) => finish(resolve, value);
        try {
            const result = api[method](query, callback);
            if (result && typeof result.then === "function") result.then((value) => finish(resolve, value), (error) => finish(reject, error));
        } catch (error) {
            finish(reject, error);
        }
    });
}

function customPermissionPatterns(origins) {
    return origins.filter((origin) => origin !== "https://canvas.emory.edu").map((origin) => `${origin}/*`);
}

function customDomainError(code, message, extra = {}) {
    const error = new Error(message || code);
    error.code = code;
    Object.assign(error, extra);
    return error;
}

function popupStorageCall(chromeApi, area, method, value) {
    const storage = chromeApi?.storage?.[area];
    if (!storage || typeof storage[method] !== "function") return Promise.reject(customDomainError("browser_unsupported", `storage.${area}.${method} unavailable`));
    try {
        const result = value === undefined ? storage[method]() : storage[method](value);
        return result && typeof result.then === "function" ? result : Promise.resolve(result);
    } catch (error) {
        return Promise.reject(customDomainError("browser_unsupported", `storage.${area}.${method} unavailable`));
    }
}

function cloneCustomDomainValue(value) {
    if (value === undefined) return undefined;
    if (typeof structuredClone === "function") return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
}

function waitForCanvasMessage(tabId, message, attempts = 16) {
    if (!Number.isInteger(tabId) || !chrome.tabs?.sendMessage) return Promise.reject(customDomainError("browser_unsupported", "This browser cannot connect to a custom Canvas domain."));
    let attempt = 0;
    const trySend = async () => {
        try {
            const result = await chrome.tabs.sendMessage(tabId, message);
            if (result?.state === "waiting" || result?.code === "CANVAS_ACCOUNT_VERIFICATION_WAITING") throw customDomainError("canvas_verification_waiting", "Canvas is still loading.");
            return result;
        } catch (error) {
            attempt += 1;
            if (attempt >= attempts) throw error;
            await new Promise((resolve) => setTimeout(resolve, 250));
            return trySend();
        }
    };
    return trySend();
}

async function verifyCustomCanvasOrigin(origin) {
    if (!chrome.tabs?.query || !chrome.tabs?.create || !chrome.tabs?.sendMessage) throw customDomainError("browser_unsupported", "This browser cannot load a custom Canvas content script.");
    let tabs = await chrome.tabs.query({ url: [`${origin}/*`] });
    let tab = tabs?.find((item) => Number.isInteger(item?.id)) || null;
    if (!tab) tab = await chrome.tabs.create({ url: `${origin}/` });
    if (!Number.isInteger(tab?.id)) throw customDomainError("canvas_verification_waiting", "Open the custom Canvas domain and sign in to continue.");
    if (chrome.tabs.reload && tabs?.length) {
        try { await chrome.tabs.reload(tab.id); } catch (error) {}
    }
    const requestId = globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `canvas-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const result = await waitForCanvasMessage(tab.id, {
        type: "CANVAS_ACCOUNT_VERIFY",
        version: 1,
        requestId,
        payload: { expectedOrigin: origin }
    });
    if (!result?.ok || result.state !== "verified" || !result.userId) {
        throw customDomainError(result?.code || "canvas_verification_required", "Sign in to Canvas before connecting this domain.", { result });
    }
    return result;
}

function createCustomCanvasDomainFlow({
    chromeApi = globalThis.chrome,
    windowApi = globalThis.window,
    request = (type, payload) => popupPlatformRequest(type, payload),
    verifyOrigin = verifyCustomCanvasOrigin,
    confirm = (message) => windowApi?.confirm?.(message) !== false,
    onStatus = () => {},
    onError = () => {},
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
} = {}) {
    const state = { configured: [], loaded: false, busy: false };

    function dynamicOrigins(origins) {
        return origins.filter((origin) => origin !== "https://canvas.emory.edu");
    }

    function pattern(origin) {
        return `${origin}/*`;
    }

    function exactScriptForOrigin(script, origin) {
        return Array.isArray(script?.matches) && script.matches.length === 1 && script.matches[0] === pattern(origin);
    }

    async function readSnapshot(origins) {
        const [sync, local] = await Promise.all([
            popupStorageCall(chromeApi, "sync", "get", ["custom_domain"]),
            popupStorageCall(chromeApi, "local", "get", ["platform.accountMetadata"])
        ]);
        const configuredPresent = Object.prototype.hasOwnProperty.call(sync || {}, "custom_domain");
        const metadataPresent = Object.prototype.hasOwnProperty.call(local || {}, "platform.accountMetadata");
        const currentOrigins = normalizeCanvasDomains(Array.isArray(sync?.custom_domain) ? sync.custom_domain : []).value;
        const allOrigins = Array.from(new Set([...dynamicOrigins(currentOrigins), ...dynamicOrigins(origins)]));
        const permissions = {};
        const scripts = {};
        let registered = [];
        if (allOrigins.length && chromeApi?.scripting?.getRegisteredContentScripts) {
            try { registered = await chromeApi.scripting.getRegisteredContentScripts(); } catch (error) { throw customDomainError("browser_unsupported", "Canvas registration state is unavailable."); }
        } else if (allOrigins.length) {
            throw customDomainError("browser_unsupported", "Canvas registration state is unavailable.");
        }
        for (const origin of allOrigins) {
            try {
                permissions[origin] = Boolean(await permissionCall("contains", { origins: [pattern(origin)] }, chromeApi));
            } catch (error) {
                throw customDomainError("browser_unsupported", "Canvas permission state is unavailable.");
            }
            const matching = (registered || []).find((script) => exactScriptForOrigin(script, origin));
            if (matching) scripts[origin] = cloneCustomDomainValue(matching);
        }
        return {
            configured: currentOrigins,
            configuredPresent,
            metadata: cloneCustomDomainValue(local?.["platform.accountMetadata"]),
            metadataPresent,
            permissions,
            scripts
        };
    }

    async function platformOperation(type, payload) {
        let result;
        try { result = await request(type, payload); } catch (error) { throw customDomainError(error?.code || "CANVAS_TRANSACTION_FAILED", "Canvas connection could not be completed."); }
        const payloadResult = result?.payload || result || {};
        if (payloadResult.ok === false) throw customDomainError(payloadResult.code || "CANVAS_TRANSACTION_FAILED", "Canvas connection could not be completed.");
        return payloadResult;
    }

    async function restoreSnapshot(snapshot, affectedOrigins, newlyGranted) {
        const compensationErrors = [];
        try {
            if (snapshot.configuredPresent) await popupStorageCall(chromeApi, "sync", "set", { custom_domain: cloneCustomDomainValue(snapshot.configured) });
            else await popupStorageCall(chromeApi, "sync", "remove", "custom_domain");
        } catch (error) { compensationErrors.push("configured"); }
        try {
            if (snapshot.metadataPresent) await popupStorageCall(chromeApi, "local", "set", { "platform.accountMetadata": cloneCustomDomainValue(snapshot.metadata) });
            else await popupStorageCall(chromeApi, "local", "remove", "platform.accountMetadata");
        } catch (error) { compensationErrors.push("metadata"); }

        for (const origin of affectedOrigins) {
            const wantedPermission = snapshot.permissions[origin] === true;
            try {
                const currentPermission = Boolean(await permissionCall("contains", { origins: [pattern(origin)] }, chromeApi));
                if (wantedPermission && !currentPermission) {
                    const restored = await permissionCall("request", { origins: [pattern(origin)] }, chromeApi);
                    if (!restored) throw new Error("permission_restore_denied");
                } else if (!wantedPermission && currentPermission && newlyGranted.has(origin)) {
                    const removed = await permissionCall("remove", { origins: [pattern(origin)] }, chromeApi);
                    if (!removed) throw new Error("permission_remove_failed");
                }
            } catch (error) { compensationErrors.push(`permission:${origin}`); }
        }

        for (const origin of affectedOrigins) {
            try {
                if (snapshot.scripts[origin]) await platformOperation("CANVAS_ACCOUNT_VERIFY", { origin, operation: "register", user_gesture: true });
                else await platformOperation("CANVAS_ACCOUNT_VERIFY", { origin, operation: "unregister", user_gesture: true });
            } catch (error) { compensationErrors.push(`registration:${origin}`); }
        }
        if (compensationErrors.length) throw customDomainError("CANVAS_TRANSACTION_ROLLBACK_FAILED", "Canvas connection rollback was incomplete.");
    }

    async function save(rawValue) {
        const normalized = normalizeCanvasDomains(rawValue);
        if (!normalized.valid) throw customDomainError("SETTINGS_VALUE_INVALID", normalized.message);
        if (state.busy) throw customDomainError("CANVAS_TRANSACTION_BUSY", "Canvas connection is already being updated.");
        const nextOrigins = normalized.value;
        const removedOrigins = state.configured.filter((origin) => !nextOrigins.includes(origin));
        if (removedOrigins.length && !confirm("Remove access for the Canvas domain(s) no longer listed?")) return { ok: false, cancelled: true };

        state.busy = true;
        let snapshot;
        const affectedOrigins = Array.from(new Set([...dynamicOrigins(state.configured), ...dynamicOrigins(nextOrigins)]));
        const newlyGranted = new Set();
        try {
            snapshot = await readSnapshot(nextOrigins);
            // The permission request is the first browser-side mutation in the
            // explicit Save gesture. Only origins absent from the snapshot are
            // requested, and every request is exact origin/*.
            for (const origin of dynamicOrigins(nextOrigins)) {
                if (snapshot.permissions[origin] === true) continue;
                const granted = await permissionCall("request", { origins: [pattern(origin)] }, chromeApi);
                if (!granted) throw customDomainError("permission_denied", "Canvas permission was denied.");
                newlyGranted.add(origin);
            }
            for (const origin of dynamicOrigins(nextOrigins)) {
                await platformOperation("CANVAS_ACCOUNT_VERIFY", { origin, operation: "register", user_gesture: true });
            }
            const verifiedAccounts = [];
            for (const origin of dynamicOrigins(nextOrigins)) {
                const verified = await verifyOrigin(origin);
                if (!verified?.ok || verified.state !== "verified" || !verified.userId) throw customDomainError(verified?.code || "canvas_verification_required", "Canvas identity verification failed.");
                verifiedAccounts.push({ origin, verified });
            }
            for (const { origin, verified } of verifiedAccounts) {
                await platformOperation("CANVAS_ACCOUNT_VERIFY", {
                    origin,
                    account_id: verified.userId,
                    display_name: verified.profile?.displayName || verified.canvasUser?.name || "",
                    user_gesture: true
                });
            }
            await platformOperation("SETTINGS_UPDATE", {
                area: "sync",
                changes: { custom_domain: nextOrigins },
                user_gesture: true,
                canvas_transaction: "persist_only"
            });

            const removedSet = new Set(dynamicOrigins(removedOrigins));
            if (removedSet.size) {
                const currentMetadataResult = await popupStorageCall(chromeApi, "local", "get", ["platform.accountMetadata"]);
                const currentMetadata = currentMetadataResult?.["platform.accountMetadata"];
                if (currentMetadata && Array.isArray(currentMetadata.accounts)) {
                    const retainedAccounts = currentMetadata.accounts.filter((account) => !removedSet.has(account?.origin));
                    await popupStorageCall(chromeApi, "local", "set", {
                        "platform.accountMetadata": { ...cloneCustomDomainValue(currentMetadata), accounts: retainedAccounts }
                    });
                }
            }

            // Explicit removal is deliberately after the new state is saved.
            for (const origin of dynamicOrigins(removedOrigins)) {
                await platformOperation("CANVAS_ACCOUNT_VERIFY", { origin, operation: "unregister", user_gesture: true });
                const removed = await permissionCall("remove", { origins: [pattern(origin)] }, chromeApi);
                if (!removed) throw customDomainError("permission_remove_failed", "Canvas permission could not be removed.");
            }
            state.configured = nextOrigins.slice();
            state.loaded = true;
            onStatus(dynamicOrigins(nextOrigins).length ? "Canvas domain connected and account verified." : "Canvas domain saved.", false);
            return { ok: true, configured: nextOrigins.slice() };
        } catch (error) {
            if (snapshot) {
                try { await restoreSnapshot(snapshot, affectedOrigins, newlyGranted); }
                catch (rollbackError) { error = customDomainError("CANVAS_TRANSACTION_ROLLBACK_FAILED", "Canvas connection rollback was incomplete."); }
            }
            state.configured = snapshot?.configured?.slice?.() || state.configured;
            state.loaded = true;
            const sanitized = customDomainError(error?.code || "CANVAS_TRANSACTION_FAILED", "Canvas connection could not be completed.");
            onError(sanitized);
            throw sanitized;
        } finally {
            state.busy = false;
        }
    }

    async function load() {
        const snapshot = await readSnapshot([]);
        state.configured = snapshot.configured.slice();
        state.loaded = true;
        return state.configured.slice();
    }

    return Object.freeze({ state, load, save, snapshot: readSnapshot, restore: restoreSnapshot });
}

let customCanvasDomainFlow = null;

function saveCustomCanvasDomain() {
    const input = document.getElementById("customDomain");
    if (!customCanvasDomainFlow || !input) return Promise.resolve({ ok: false });
    input.disabled = true;
    return customCanvasDomainFlow.save(input.value).then((result) => {
        if (result?.ok) {
            input.value = result.configured.join(",");
            clearAlert();
        }
        return result;
    }).catch((error) => {
        if (error.code === "permission_denied" || error.code === "permission_required") {
            setSaveStatus("Canvas permission was denied; nothing was saved.", true);
            displayAlert(true, "Canvas permission is required to connect this domain.");
        } else if (error.code === "browser_unsupported") {
            setSaveStatus("This browser cannot connect a custom Canvas domain. Emory Canvas remains available.", true);
            displayAlert(true, "Custom Canvas domains are not supported by this browser.");
        } else {
            setSaveStatus("Canvas domain could not be saved; previous access was restored.", true);
            displayAlert(true, "Canvas domain could not be saved; previous access was restored.");
        }
        throw error;
    }).finally(() => { input.disabled = false; });
}

function setupCustomCanvasDomainFlow() {
    const input = document.querySelector("#customDomain");
    if (!input) return;
    let action = document.querySelector("#customDomainSave");
    if (!action) {
        action = document.createElement("button");
        action.type = "button";
        action.id = "customDomainSave";
        action.className = "customization-button";
        action.textContent = "Save & Connect Canvas";
        input.parentElement?.appendChild(action);
    }
    customCanvasDomainFlow = createCustomCanvasDomainFlow({
        chromeApi: chrome,
        windowApi: window,
        onStatus: (message, error) => setSaveStatus(message, error),
        onError: () => {}
    });
    action.disabled = true;
    input.addEventListener("input", () => setSaveStatus("Click Save & Connect Canvas to apply this domain."));
    action.addEventListener("click", () => saveCustomCanvasDomain().catch(() => {}));
    customCanvasDomainFlow.load().then((domains) => {
        input.value = domains.join(",");
        action.disabled = false;
    }).catch(() => {
        setSaveStatus("Canvas domain settings are unavailable.", true);
    });
}

window.APStudyCanvasCustomDomain = Object.freeze({
    normalizeCanvasDomains,
    customPermissionPatterns,
    createFlow: createCustomCanvasDomainFlow,
    saveCustomCanvasDomain,
    setup: setupCustomCanvasDomainFlow,
    getFlow: () => customCanvasDomainFlow
});

const SETTINGS_SAVE_FAILURE_MESSAGE = settingsSchema.messages.saveFailure;
const INVALID_SETTINGS_JSON_MESSAGE = settingsSchema.messages.invalidImport;
const pendingKeys = new Set();
let knownSyncValues = {};

function storageAreaCall(area, method, ...args) {
    const storage = chrome?.storage?.[area];
    if (!storage || typeof storage[method] !== "function") return Promise.reject(new Error(`storage.${area}.${method} unavailable`));
    try {
        const result = storage[method](...args);
        return result && typeof result.then === "function" ? result : Promise.resolve(result);
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
    return Promise.resolve(runtime.sendMessage(message)).then((response) => {
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
    ["home-save-status", "workspace-save-status"].forEach((id) => {
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
const POPUP_SYNC_PUBLIC_RUN_ID_BLOCKER = "Resume and Cancel are unavailable because the public sync contract does not expose a safe run identity.";
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

function popupCalendarCountSummary(value, prefix = "", output = [], depth = 0) {
    if (depth > 4 || output.length >= 24) return output;
    if (Number.isSafeInteger(value) && value >= 0) {
        output.push(`${prefix || "count"}: ${value}`);
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
    if (/CONSENT_REQUIRED/i.test(code)) return "Grant current-version consent for this verified Canvas account.";
    if (/OPT_IN_REQUIRED/i.test(code)) return "Enable the per-account opt-in after current consent is granted.";
    if (/FEATURE_DISABLED_UPLOAD|ROLLOUT/i.test(code)) return "Sync rollout is disabled; no upload was attempted.";
    if (["partial", "failed", "cancelled"].includes(state)) return POPUP_SYNC_PUBLIC_RUN_ID_BLOCKER;
    return "";
}

function popupCalendarIdentityStatus(controller) {
    const value = controller?.state?.identity?.state;
    return ["authenticated", "signed_out", "expired", "unavailable"].includes(value) ? value : "unavailable";
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
        && scopes.value.length === POPUP_CANVAS_CONSENT_SCOPES.length
        && new Set(scopes.value).size === POPUP_CANVAS_CONSENT_SCOPES.length
        && POPUP_CANVAS_CONSENT_SCOPES.every((scope) => scopes.value.includes(scope));
    const granted = hasScopedIdentity && grantedField.value === true && current.value === true;
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

function createPopupCalendarController({ controller, document: doc, window: win } = {}) {
    const state = {
        contextState: "unavailable",
        binding: null,
        bindingGeneration: 0,
        consent: null,
        consentLoading: false,
        optIns: {},
        rolloutEnabled: false,
        projectionEnabled: false,
        overlayEnabled: false,
        replacementEnabled: false,
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
        initialized: false
    };
    let contextListenerBound = false;
    let actionListenersBound = false;
    let calendarModeListenerBound = false;
    let routeListenersBound = false;
    let storageListenerBound = false;
    let identitySignature = "";
    let destroyed = false;
    let contextListener = null;
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

    function authenticated() {
        return popupCalendarIdentityStatus(controller) === "authenticated";
    }

    function currentBinding() {
        return state.contextState === "connected" && state.binding ? state.binding : null;
    }

    function consentCurrent() {
        return Boolean(state.consent?.valid && state.consent.current && !state.consent.revoked);
    }

    function optInManageable() {
        return Boolean(authenticated() && currentBinding() && consentCurrent());
    }

    function optInEnabled() {
        return Boolean(optInManageable() && state.rolloutEnabled);
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
                ? "Replace native Canvas is experimental. Native Canvas restoration is guaranteed before future activation."
                : "Replace native Canvas is experimental and remains disabled until the platform replacement capability is explicitly enabled.";
        }
        if (mode === "off") return "Native Canvas calendar only.";
        if (!authenticated()) {
            return popupCalendarIdentityStatus(controller) === "expired"
                ? "Nest session expired. Sign in again to enable APStudy overlay."
                : "Sign in to Nest to enable APStudy overlay.";
        }
        if (!currentBinding()) return "Verify the current Canvas account to enable APStudy overlay.";
        if (!consentCurrent()) return "Grant current-version consent for this verified Canvas account to enable APStudy overlay.";
        if (!state.projectionEnabled) return "APStudy overlay is unavailable because calendar projection is disabled.";
        if (!state.overlayEnabled) return "APStudy overlay is unavailable because the platform overlay capability is disabled.";
        return "APStudy overlay is ready. Native Canvas remains visible; APStudy uses signed-in Nest saved events and consented Canvas projections.";
    }

    function renderCalendarMode() {
        const mode = normalizeCalendarMode(state.calendarMode);
        const controls = qa("input[name=canvas-calendar-mode]");
        const status = q("#canvas-calendar-mode-status");
        controls.forEach((control) => {
            const value = normalizeCalendarMode(control.value);
            control.checked = value === mode;
            const available = value === "off" || (value === "overlay" ? overlayReady() : state.replacementEnabled);
            setDisabled(control, !available);
        });
        if (status) {
            const statusValue = state.calendarModeLoading ? "Loading calendar mode." : state.calendarModeStatus || calendarModeGuidance(mode);
            status.textContent = statusValue;
            status.dataset.state = statusValue.startsWith("Saving") ? "saving" : statusValue.startsWith("Failed") ? "failed" : "saved";
        }
        const help = q("#canvas-calendar-mode-help");
        if (help) help.textContent = mode === "overlay"
            ? calendarModeGuidance("overlay")
            : "APStudy overlay keeps the native Canvas calendar visible and uses signed-in Nest saved events plus consented Canvas projections. Replace native Canvas is experimental; native Canvas restoration is guaranteed before any future activation.";
    }

    async function loadCalendarMode() {
        state.calendarModeLoading = true;
        renderCalendarMode();
        try {
            const values = await storageAreaCall("sync", "get", ["canvas_calendar_mode"]);
            state.calendarMode = normalizeCalendarMode(values?.canvas_calendar_mode);
            state.calendarModeStatus = calendarModeGuidance(state.calendarMode);
        } catch (error) {
            state.calendarMode = "off";
            state.calendarModeStatus = "Failed — calendar mode could not be loaded.";
        } finally {
            state.calendarModeLoading = false;
            renderCalendarMode();
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
        state.calendarMode = next;
        state.calendarModeStatus = "Saving…";
        renderCalendarMode();
        return queueSettingWrite({ canvas_calendar_mode: next }, "canvas-calendar-mode").then(() => {
            state.calendarModeStatus = "Saved.";
            renderCalendarMode();
            return next;
        }).catch((error) => {
            if (state.calendarMode === next) state.calendarMode = previous;
            state.calendarModeStatus = "Failed — calendar mode reverted.";
            renderCalendarMode();
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
        if (Number.isSafeInteger(result.count) && result.count >= 0) countParts.push(`count: ${result.count}`);
        const guidance = popupCalendarSyncGuidance(result);
        const timestampParts = Object.entries(result.timestamps || {}).map(([key, value]) => `${key}: ${value}`);
        if (progress) {
            progress.textContent = [...countParts, ...timestampParts, guidance].filter(Boolean).join(" · ");
            progress.hidden = !progress.textContent;
        }
        if (error) {
            error.textContent = result.errorCode ? `Error class: ${result.errorCode}.` : "";
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
        const lists = [q("#canvas-account-list"), q("#workspace-canvas-account-list")].filter(Boolean);
        lists.forEach((list) => {
            list.replaceChildren?.();
            const binding = currentBinding();
            const item = doc?.createElement?.("div");
            if (!item) return;
            item.className = "profile-account-card";
            item.dataset.state = binding ? "verified" : "unavailable";
            item.textContent = binding ? `${binding.label} · verified` : "No verified Canvas account is available.";
            list.appendChild(item);
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
            const canDisable = !optInManageable() || (!state.rolloutEnabled && !checked);
            setDisabled(control, canDisable);
        }
        if (help) {
            if (!binding) help.textContent = "A verified Canvas account is required before per-account settings are available.";
            else if (!authenticated()) help.textContent = identityGuidance();
            else if (!consentCurrent()) help.textContent = "Current-version scoped consent is required before this account can opt in.";
            else if (!state.rolloutEnabled && !checked) help.textContent = "Sync rollout is disabled; this account cannot opt in yet.";
            else help.textContent = "This local per-account setting does not start sync or upload Canvas records.";
        }
    }

    function renderConsent() {
        const consentControl = q("#nest-consent-enabled");
        const consentRefresh = q("#nest-consent-refresh");
        const binding = currentBinding();
        const canManageConsent = Boolean(authenticated() && binding);
        setDisabled(consentControl, !canManageConsent || state.consentLoading);
        setDisabled(consentRefresh, !canManageConsent || state.consentLoading);
        if (consentControl) consentControl.checked = Boolean(state.consent?.current && !state.consent?.revoked);
        if (state.consentLoading) text("#nest-consent-status", "Checking consent status.");
        else if (!binding) text("#nest-consent-status", "Verify a current Canvas account before managing consent.");
        else if (!authenticated()) text("#nest-consent-status", identityGuidance());
        else if (!state.consent?.valid) text("#nest-consent-status", "Consent status unavailable.");
        else if (consentCurrent()) text("#nest-consent-status", "Consent is granted for this verified Canvas account.");
        else text("#nest-consent-status", "Consent is not granted for this verified Canvas account.");
    }

    function renderSafeStatus() {
        const output = q("#calendar-accounts-status-value");
        const inline = q("#nest-account-status-inline");
        const capability = q("#calendar-capability-status");
        const identityState = popupCalendarIdentityStatus(controller);
        const binding = currentBinding();
        if (output) output.textContent = binding ? "Verified account" : identityState === "authenticated" ? "Awaiting Canvas" : "Unavailable";
        if (inline) {
            inline.textContent = identityState === "authenticated"
                ? "Nest is connected."
                : identityState === "signed_out"
                    ? "Nest is signed out."
                    : identityState === "expired"
                        ? "Nest session expired."
                        : "Nest status is unavailable.";
        }
        if (capability) {
            capability.dataset.state = binding && authenticated() ? "ready" : "unavailable";
            if (!binding) capability.textContent = "No verified Canvas account is available; sync remains unavailable.";
            else if (!authenticated()) capability.textContent = identityGuidance();
            else if (!consentCurrent()) capability.textContent = "Current-version scoped consent is required before any upload.";
            else if (!state.rolloutEnabled) capability.textContent = "Sync rollout is disabled; no sync action is available.";
            else capability.textContent = "Consent is current; sync lifecycle controls remain unavailable in this UI slice.";
        }
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
        if (identitySignature && identitySignature !== current) clearRoutingState(true);
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
        if (!consentCurrent()) return "Grant current-version consent for this verified Canvas account.";
        if (!state.projectionEnabled) return "Calendar projection is disabled by the platform.";
        if (!state.sourceRef) return "Start or refresh sync to establish a safe calendar source reference.";
        if (!state.calendars.length) return "No visible routing-eligible calendars are available.";
        return "Calendar destinations are unavailable.";
    }

    function routingReady() {
        return Boolean(authenticated() && currentBinding() && consentCurrent() && state.projectionEnabled && popupCalendarSafeSourceRef(state.sourceRef));
    }

    function renderRouting() {
        const routing = q("#calendar-routing-controls");
        const availableContext = Boolean(authenticated() && currentBinding() && consentCurrent() && state.projectionEnabled);
        if (routing) {
            routing.hidden = !availableContext;
            routing.inert = !availableContext;
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
        const identityGeneration = controller?.state?.identityGeneration;
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
            select?.addEventListener?.("change", (event) => {
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
        const syncPanel = q("#calendar-sync-controls");
        const hasContext = Boolean(currentBinding() && authenticated());
        if (syncPanel) { syncPanel.hidden = !hasContext; syncPanel.inert = !hasContext; }
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
        renderCurrentAccount();
        renderSafeLists();
        renderCalendarMode();
        renderSyncControls();
    }

    function isCurrentCompletion(generation, identityGeneration, binding) {
        const current = currentBinding();
        return state.bindingGeneration === generation
            && controller?.state?.identityGeneration === identityGeneration
            && authenticated()
            && current?.accountKey === binding?.accountKey
            && current?.sourceKey === binding?.sourceKey;
    }

    async function runSyncRequest(type) {
        if (!syncReady()) return null;
        const binding = currentBinding();
        const generation = state.bindingGeneration;
        const identityGeneration = controller?.state?.identityGeneration;
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
        renderCurrentAccount();
        return state.optIns;
    }

    async function loadRollout() {
        const previousProjection = state.projectionEnabled;
        try {
            const values = await storageAreaCall("local", "get", ["platform.flags"]);
            const flags = values?.["platform.flags"] || {};
            state.rolloutEnabled = flags.upload === true;
            state.projectionEnabled = flags.projection === true;
            state.overlayEnabled = flags.overlay === true;
            state.replacementEnabled = flags.replacement === true;
        } catch (error) {
            state.rolloutEnabled = false;
            state.projectionEnabled = false;
            state.overlayEnabled = false;
            state.replacementEnabled = false;
        }
        if (previousProjection && !state.projectionEnabled) clearRoutingState(true);
        renderSafeStatus();
        renderCurrentAccount();
        renderCalendarMode();
        renderRouting();
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
        const identityGeneration = controller?.state?.identityGeneration;
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
        if (!binding || !authenticated() || (requireGate && !consentCurrent()) || (requireGate && value === true && !state.rolloutEnabled)) {
            throw new Error("CANVAS_SYNC_OPT_IN_NOT_AVAILABLE");
        }
        if (!popupCanvasSyncSettingsStore) throw new Error("CANVAS_SYNC_SETTINGS_UNAVAILABLE");
        const previous = popupCalendarClone(state.optIns);
        const next = popupCalendarClone(state.optIns) || {};
        next[binding.accountKey] = Boolean(value);
        const normalized = settingsSchema.normalizeCanvasSyncOptIn(next);
        if (!normalized) throw new Error("CANVAS_SYNC_OPT_IN_INVALID");
        state.optIns = normalized;
        renderCurrentAccount();
        try {
            await popupCanvasSyncSettingsStore.updateField("canvas_sync_opt_in", normalized);
            return normalized;
        } catch (error) {
            state.optIns = previous || {};
            renderCurrentAccount();
            throw error;
        }
    }

    async function loadConsent() {
        const binding = currentBinding();
        if (!binding || !authenticated()) {
            state.consent = null;
            state.consentLoading = false;
            render();
            return null;
        }
        const generation = state.bindingGeneration;
        const identityGeneration = controller?.state?.identityGeneration;
        state.consentLoading = true;
        renderConsent();
        let normalized;
        try {
            const result = await popupPlatformRequest("NEST_CONSENT_GET", {
                source_key: binding.sourceKey,
                account_key: binding.accountKey,
                version: POPUP_CANVAS_CONSENT_VERSION
            });
            normalized = popupCalendarNormalizeConsent(result, binding);
        } catch (error) {
            normalized = { valid: false, current: false, revoked: false, code: popupCalendarSafeCode(error?.code || error?.message, "CONSENT_TRANSPORT_UNAVAILABLE") };
        }
        if (!isCurrentCompletion(generation, identityGeneration, binding)) return null;
        const previous = state.consent;
        state.consent = normalized;
        state.consentLoading = false;
        if (previous && JSON.stringify(previous) !== JSON.stringify(normalized)) clearRoutingState(true);
        render();
        if (state.optIns[binding.accountKey] === true && !consentCurrent() && normalized.valid && (normalized.revoked || !normalized.current)) {
            try { await persistOptIn(false, { requireGate: false }); } catch (error) {}
        }
        return state.consent;
    }

    async function setConsent(grant) {
        const binding = currentBinding();
        if (!binding || !authenticated()) {
            text("#nest-consent-status", "Connect Nest and verify a Canvas account before managing consent.");
            throw new Error("CANVAS_CONSENT_NOT_AVAILABLE");
        }
        const generation = state.bindingGeneration;
        const identityGeneration = controller?.state?.identityGeneration;
        const action = grant ? "grant" : "revoke";
        clearRoutingState(true);
        state.consentLoading = true;
        renderConsent();
        let optInError = null;
        try {
            if (!grant) {
                try { await persistOptIn(false, { requireGate: false }); } catch (error) { optInError = error; }
            }
            if (!isCurrentCompletion(generation, identityGeneration, binding)) throw new Error("STALE_CANVAS_CONTEXT");
            await popupPlatformRequest("NEST_CONSENT_SET", {
                source_key: binding.sourceKey,
                account_key: binding.accountKey,
                action,
                scopes: POPUP_CANVAS_CONSENT_SCOPES.slice(),
                version: POPUP_CANVAS_CONSENT_VERSION
            });
            state.consentLoading = false;
            await loadConsent();
            if (optInError) text("#nest-consent-status", "Consent was revoked, but the local opt-in could not be confirmed off.");
            return state.consent;
        } catch (error) {
            state.consentLoading = false;
            render();
            text("#nest-consent-status", grant ? "Consent could not be saved." : "Consent could not be revoked.");
            throw error;
        }
    }

    function onCanvasContext(event) {
        event?.stopPropagation?.();
        const context = popupCalendarContextFromEvent(event?.detail);
        const sourceTabId = normalizePopupSourceTabId(event?.detail?.sourceTabId);
        state.contextState = context.state;
        state.binding = context.binding;
        state.bindingGeneration += 1;
        state.consent = null;
        state.consentLoading = false;
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
        if (state.initialized && context.binding && authenticated()) void loadConsent().catch(() => {});
    }

    function bindActions() {
        if (actionListenersBound) return;
        actionListenersBound = true;
        bindRoutingActions();
        if (!calendarModeListenerBound) {
            calendarModeListenerBound = true;
            qa("input[name=canvas-calendar-mode]").forEach((control) => {
                control.addEventListener?.("change", (event) => {
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
        q("#nest-consent-enabled")?.addEventListener?.("change", (event) => {
            event.stopImmediatePropagation?.();
            event.stopPropagation?.();
            setConsent(Boolean(event.currentTarget?.checked)).catch(() => {});
        });
        q("#nest-consent-refresh")?.addEventListener?.("click", (event) => {
            event.stopImmediatePropagation?.();
            event.stopPropagation?.();
            loadConsent().catch(() => {});
        });
        q("#canvas-current-account-sync-opt-in")?.addEventListener?.("change", (event) => {
            event.stopImmediatePropagation?.();
            event.stopPropagation?.();
            persistOptIn(Boolean(event.currentTarget?.checked)).catch(() => {
                renderCurrentAccount();
            });
        });
        q("#calendar-sync-start")?.addEventListener?.("click", (event) => {
            event.stopImmediatePropagation?.();
            event.stopPropagation?.();
            startSync().catch(() => {});
        });
        q("#calendar-sync-refresh")?.addEventListener?.("click", (event) => {
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
            if (destroyed || areaName !== "local" || !changes?.["platform.flags"]) return;
            const flags = changes["platform.flags"].newValue || {};
            const projection = flags.projection === true;
            state.rolloutEnabled = flags.upload === true;
            state.overlayEnabled = flags.overlay === true;
            state.replacementEnabled = flags.replacement === true;
            if (state.projectionEnabled && !projection) clearRoutingState(true);
            state.projectionEnabled = projection;
            render();
            if (projection && routingReady() && state.sourceRef) void loadCalendars().catch(() => {});
        };
        chromeStorage.onChanged.addListener(storageObserver);
    }

    function destroy() {
        if (destroyed) return;
        destroyed = true;
        if (contextListener && win?.removeEventListener) win.removeEventListener("apstudycanvas-canvas-context", contextListener);
        if (identityObserver && win?.removeEventListener) {
            win.removeEventListener("focus", identityObserver);
            win.removeEventListener("visibilitychange", identityObserver);
        }
        if (storageObserver && chromeStorage?.onChanged?.removeListener) chromeStorage.onChanged.removeListener(storageObserver);
        clearRoutingState(true);
        state.consent = null;
        state.syncResult = null;
        renderRouting();
    }

    async function init() {
        if (state.initialized) return api;
        state.initialized = true;
        bindActions();
        render();
        await Promise.all([
            controller?.init?.(),
            loadOptIns(),
            loadRollout(),
            loadCalendarMode()
        ]);
        render();
        await loadConsent();
        return api;
    }

    const api = {
        state,
        init,
        render,
        loadConsent,
        setConsent,
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
            state.consent = null;
            state.syncResult = null;
            state.syncBusy = false;
            state.syncRequestId = null;
            render();
        },
        destroy,
        applyOptInSnapshot(value) {
            state.optIns = settingsSchema.normalizeCanvasSyncOptIn(value) || {};
            renderCurrentAccount();
        }
    };
    return api;
}

function queueSettingWrite(changes, debounceKey = "settings") {
    void debounceKey;
    if (!popupSettingsStore) return Promise.reject(new Error("SETTINGS_STORE_UNAVAILABLE"));
    if (!isPlainObject(changes)) return Promise.resolve();
    const writes = Object.entries(changes).map(([key, value]) => popupSettingsStore.updateField(key, value));
    if (!writes.length) return Promise.resolve();
    return Promise.all(writes).then((results) => results.length === 1 ? results[0] : results);
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
        chromeApi: chrome,
        contract: popupCalendarContract(window.APStudyCanvasPlatform?.Contract),
        defaults: settingsSchema.syncDefaults,
        settingsStore: popupSettingsStore
    });
    popupCalendarController = createPopupCalendarController({ controller: popupController, document, window });
    const refreshIdentity = popupController.refreshIdentity;
    popupController.refreshIdentity = (...args) => {
        popupCalendarController.handleIdentityChange?.();
        return Promise.resolve(refreshIdentity.apply(popupController, args)).finally(() => popupCalendarController.render?.());
    };
    window.APStudyCanvasPopup = popupController;
    window.APStudyCanvasCalendarAccounts = popupCalendarController;
    document.addEventListener("DOMContentLoaded", () => {
        popupCalendarController.init().catch(() => {});
        applyQueuedCardColors().catch(() => setSaveStatus("Queued Canvas colors still apply on the next Canvas load.", true));
    });
}

document.addEventListener("change", () => { flushPendingWrites().catch(() => {}); });
document.addEventListener("blur", () => { flushPendingWrites().catch(() => {}); }, true);


sendFromPopup("getCards");

// refresh the cards if new ones were just recieved
chrome.storage.onChanged.addListener((changes) => {
    if (changes["custom_cards"]) {
        const previous = asPlainObject(changes["custom_cards"].oldValue);
        const next = asPlainObject(changes["custom_cards"].newValue);
        if (Object.keys(previous).length !== Object.keys(next).length) {
            displayAdvancedCards();
        }
    }
    if (changes["gpa_calc_bounds"] && !pendingKeys.has("gpa_calc_bounds")) displayGPABounds();
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

function displayErrors() {
    chrome.storage.local.get("errors", storage => {
        const output = document.querySelector("#error_log_output");
        if (!output) return;
        output.value = "";
        (Array.isArray(storage["errors"]) ? storage["errors"] : []).forEach(e => {
            output.value += (e + "\n\n");
        })
    });
}

function displayDarkModeFixUrls() {
    let output = document.getElementById("dark-mode-fix-urls");
    if (!output) return;
    output.textContent = "";
    chrome.storage.sync.get("dark_mode_fix", sync => {
        (Array.isArray(sync["dark_mode_fix"]) ? sync["dark_mode_fix"] : []).forEach(url => {
            //let div = makeElement("div", "customization-button", output, url);
            let div = makeElement("div", output, { "className": "customization-button", "textContent": url });
            div.classList.add("fixed-url");
            let btn = makeElement("button", div, { "className": "dd", "textContent": "x" });
            btn.addEventListener("click", () => {
                chrome.storage.sync.get("dark_mode_fix", sync => {
                    const values = Array.isArray(sync["dark_mode_fix"]) ? sync["dark_mode_fix"].slice() : [];
                    const index = values.indexOf(url);
                    if (index >= 0) {
                        values.splice(index, 1);
                        queueSettingWrite({ dark_mode_fix: values }, "dark-mode-fix").then(() => div.remove()).catch(() => {});
                    }
                });
            })
        })
    })
}

let legacySetupPromise = null;

function ensureLegacySetup() {
    if (!legacySetupPromise) {
        legacySetupPromise = Promise.resolve().then(() => setupLegacy());
    }
    return legacySetupPromise;
}

function setup() {
    return ensureLegacySetup();
}

window.ensureLegacySetup = ensureLegacySetup;

document.addEventListener("DOMContentLoaded", () => {
    if (document.body?.dataset.mode !== "home") ensureLegacySetup();
});

function hideLegacyTabs() {
    document.querySelectorAll(".tab").forEach((tab) => setLegacyControlVisibility(tab, false));
}

function setLegacyControlVisibility(node, visible) {
    if (!node) return;
    if (!visible && node.contains?.(document.activeElement)) {
        document.getElementById("compact-home-trigger")?.focus?.();
    }
    node.style.display = visible ? "block" : "none";
    node.hidden = !visible;
    node.inert = !visible;
    if (visible) node.removeAttribute("aria-hidden");
    else node.setAttribute("aria-hidden", "true");
}

function showLegacyMain(target = "overview") {
    hideLegacyTabs();
    const main = document.querySelector(".main");
    setLegacyControlVisibility(main, true);
    if (target === "study-tools") {
        const studyTools = document.getElementById("assignments_due")?.closest(".option-container") || document.getElementById("better_todo")?.closest(".option-container");
        if (studyTools) studyTools.scrollIntoView({ block: "start" });
    } else {
        window.scrollTo(0, 0);
    }
}

window.addEventListener("message", (event) => {
    if (event.origin !== window.location.origin || !event.data || event.data.type !== "apstudycanvas-navigate") return;
    hideLegacyTabs();
    const buttonId = event.data.legacyButtonId;
    if (!buttonId) {
        showLegacyMain(event.data.target || "overview");
        return;
    }
    const button = document.getElementById(buttonId);
    if (button) button.click();
    else showLegacyMain();
});

function setupAssignmentsSlider(initial) {
    let el = document.querySelector('#numAssignmentsSlider');
    if (!el) return;
    el.value = initial;
    document.querySelector('#numAssignments').textContent = initial;
    el.addEventListener('input', function () {
        document.querySelector('#numAssignments').textContent = this.value;
        queueSettingWrite({ num_assignments: parseInt(this.value, 10) }, "num_assignments");
    });
}

function setupTodoSlider(initial) {
    let el = document.querySelector('#numTodoItemsSlider');
    if (!el) return;
    el.value = initial;
    document.querySelector('#numTodoItems').textContent = initial;
    document.querySelector('#numTodoItemsSlider').addEventListener('input', function () {
        document.querySelector('#numTodoItems').textContent = this.value;
        queueSettingWrite({ num_todo_items: parseInt(this.value, 10) }, "num_todo_items");
    });
}

function setupSidebarScaleSlider(initial) {
    let el = document.querySelector("#sidebarScaleSlider");
    if (!el) return;
    el.value = initial;
    document.querySelector("#sidebarScaleValue").textContent = initial;
    el.addEventListener("input", function () {
        document.querySelector("#sidebarScaleValue").textContent = this.value;
        queueSettingWrite({ sidebar_scale: parseInt(this.value, 10) }, "sidebar_scale");
    });
}

function setupAutoDarkInput(initial, time) {
    let el = document.querySelector('#' + time);
    if (!el) return;
    el.value = initial.hour + ":" + initial.minute;
    el.addEventListener('change', function () {
        let timeinput = { "hour": this.value.split(':')[0], "minute": this.value.split(':')[1] };
        queueSettingWrite({ [time]: timeinput }, time);
    });
}

// function setupScheduledReminderInput(initial) {
//     let el = document.querySelector('#scheduledReminderTime');
//     el.value = initial.hour + ":" + initial.minute;
//     el.addEventListener('change', function () {
//         let timeinput = { "hour": this.value.split(':')[0], "minute": this.value.split(':')[1] };
//         chrome.storage.sync.set({ scheduledReminderTime: timeinput });
//     });
// }

function setupCardLimitSlider(initial) {
    let el = document.querySelector("#card_limit");
    if (!el) return;
    el.value = initial;
    document.querySelector("#card_limit_num").textContent = initial;
    el.addEventListener("change", (e) => {
        if (!window.confirm("Changing the card limit clears your configured course cards. Continue?")) return;
        runExplicitTransaction(
            () => chrome.storage.sync.get(["custom_cards", "custom_cards_2", "custom_cards_3", "card_limit"]),
            (next) => Number.isInteger(next.card_limit) && next.card_limit >= 5 && next.card_limit <= 40,
            { custom_cards: {}, custom_cards_2: {}, custom_cards_3: {}, card_limit: parseInt(e.target.value, 10) }
        ).catch(() => {});
    });
    el.addEventListener("input", (e) => {
        document.querySelector("#card_limit_num").textContent = e.target.value;
    })
}

function setupDashboardMethod(initial) {
    const el = document.getElementById("card_method_dashboard");
    if (!el) return;
    el.checked = initial === true ? true : false;

    el.addEventListener("change", (e) => {
        if (!window.confirm("Changing the card method clears your configured course cards. Continue?")) {
            e.target.checked = initial === true;
            return;
        }
        runExplicitTransaction(
            () => chrome.storage.sync.get(["custom_cards", "custom_cards_2", "custom_cards_3", "card_method_dashboard"]),
            (next) => typeof next.card_method_dashboard === "boolean",
            { custom_cards: {}, custom_cards_2: {}, custom_cards_3: {}, card_method_dashboard: e.target.checked }
        ).catch(() => {});
    });
}

function setupImageSizeInput(initial) {
    let el = document.querySelector("#imageSize");
    if (!el) return;
    el.value = initial;
    document.querySelector("#imageSizeValue")?.replaceChildren(`${initial}%`);
    el.addEventListener("input", (e) => {
        const value = parseInt(e.target.value, 10);
        document.querySelector("#imageSizeValue")?.replaceChildren(`${value}%`);
        queueSettingWrite({ imageSize: value }, "custom-card-style");
    });
}

function setupCardRoundnessInput(initial) {
    let el = document.querySelector("#cardRoundness");
    if (!el) return;
    el.value = initial;
    document.querySelector("#cardRoundnessValue")?.replaceChildren(`${initial}px`);
    el.addEventListener("input", (e) => {
        const value = parseInt(e.target.value, 10);
        document.querySelector("#cardRoundnessValue")?.replaceChildren(`${value}px`);
        queueSettingWrite({ cardRoundness: value }, "custom-card-style");
    });
}

function setupCardSpacingInput(initial) {
    let el = document.querySelector("#cardSpacing");
    if (!el) return;
    el.value = initial;
    document.querySelector("#cardSpacingValue")?.replaceChildren(`${initial}px`);
    el.addEventListener("input", (e) => {
        const value = parseInt(e.target.value, 10);
        document.querySelector("#cardSpacingValue")?.replaceChildren(`${value}px`);
        queueSettingWrite({ cardSpacing: value }, "custom-card-style");
    });
}

function setupCardWidthInput(initial) {
    let el = document.querySelector("#cardWidth");
    if (!el) return;
    el.value = initial;
    document.querySelector("#cardWidthValue")?.replaceChildren(`${initial}%`);
    el.addEventListener("input", (e) => {
        const value = parseInt(e.target.value, 10);
        document.querySelector("#cardWidthValue")?.replaceChildren(`${value}%`);
        queueSettingWrite({ cardWidth: value }, "custom-card-style");
    });
}

function setupCardHeightInput(initial) {
	let el = document.querySelector("#cardHeight");
	if (!el) return;
	el.value = initial;
	document.querySelector("#cardHeightValue")?.replaceChildren(`${initial}%`);
	el.addEventListener("input", (e) => {
		const value = parseInt(e.target.value, 10);
		document.querySelector("#cardHeightValue")?.replaceChildren(`${value}%`);
		queueSettingWrite({ cardHeight: value }, "custom-card-style");
	});
}

function setupCustomBackgroundLink(initial) {
    let el = document.querySelector("#customBackgroundLink");
    if (!el) return;
    el.value = initial || "";
    el.addEventListener("input", (e) => {
        const value = validateSafeHttpsUrl(e.target.value, true);
        if (!value.valid) {
            displayAlert(true, value.message);
            return;
        }
        queueSettingWrite({ customBackgroundLink: value.value }, "custom-background");
        renderBackgroundPresetSelection();
    })
}

function setupCustomBackgroundScale(initial) {
    const el = document.querySelector("#customBackgroundScale");
    const output = document.querySelector("#customBackgroundScaleValue");
    if (!el || !output) return;
    const value = Number(initial) || 100;
    el.value = value;
    output.textContent = `${value}%`;
    el.addEventListener("input", (e) => {
        const nextValue = parseInt(e.target.value);
        output.textContent = `${nextValue}%`;
        queueSettingWrite({ customBackgroundScale: nextValue }, "custom-background");
        renderBackgroundPresetSelection();
    });
}

function renderBackgroundPresetSelection() {
    const currentLink = document.querySelector("#customBackgroundLink")?.value || "";
    const currentScale = String(document.querySelector("#customBackgroundScale")?.value || "100");
    document.querySelectorAll(".background-preset-card").forEach(button => {
        const matchesLink = button.dataset.backgroundUrl === currentLink;
        const matchesScale = button.dataset.backgroundScale === currentScale;
        button.classList.toggle("selected", matchesLink && matchesScale);
    });
}

function displayBackgroundPresets() {
    const container = document.querySelector("#background-presets");
    if (!container || container.dataset.rendered === "true" || typeof backgroundPresets === "undefined") return;
    container.dataset.rendered = "true";
    container.innerHTML = backgroundPresets.map(preset => `
        <button type="button" class="theme-button customization-button background-preset-card" data-background-url="${preset.url}" data-background-scale="${preset.scale}" style="background-image: linear-gradient(rgba(0, 0, 0, 0.42), rgba(0, 0, 0, 0.42)), url('${preset.url}');">
            <p class="theme-button-title">${preset.title}</p>
            <p class="theme-button-creator">${preset.credit}</p>
            <p class="background-preset-scale">Scale ${preset.scale}%</p>
        </button>
    `).join("");

    container.querySelectorAll(".background-preset-card").forEach(button => {
        button.addEventListener("click", () => {
            const backgroundUrl = button.dataset.backgroundUrl;
            const backgroundScale = parseInt(button.dataset.backgroundScale);
            document.querySelector("#customBackgroundLink").value = backgroundUrl;
            document.querySelector("#customBackgroundScale").value = backgroundScale;
            document.querySelector("#customBackgroundScaleValue").textContent = `${backgroundScale}%`;
            const safeBackground = validateSafeHttpsUrl(backgroundUrl, true);
            if (!safeBackground.valid) {
                displayAlert(true, safeBackground.message);
                return;
            }
            queueSettingWrite({ customBackgroundLink: safeBackground.value, customBackgroundScale: backgroundScale }, "custom-background");
            renderBackgroundPresetSelection();
        });
    });
    renderBackgroundPresetSelection();
}

function setupLegacy() {

    const menu = {
		switches: syncedSwitches,
		checkboxes: [
			"browser_show_likes",
			"gpa_calc_weighted",
			"gpa_calc_cumulative",
			// /*'card_method_date',*/ "show_updates",
            "todo_hide_feedback",
            "todo_progress_rings",
            "todo_confetti",
			"todo_full_height",
			"device_dark",
			"relative_dues",
			"card_overdues",
			// "todo_overdues",
			"gpa_calc_prepend",
			"auto_dark",
			"assignment_date_format",
			"todo_hr24",
			"todo_separate_scrollbar",
			"grade_hover",
			// "hide_completed",
			"hover_preview",
			// "scheduledReminder",
			"customCardStyles",
		],
		tabs: {
			"advanced-settings": {
				setup: displayAdvancedCards,
				tab: ".advanced",
			},
			"gpa-bounds-btn": {
				setup: displayGPABounds,
				tab: ".gpa-bounds-container",
			},
			"custom-font-btn": {
				setup: displayCustomFont,
				tab: ".custom-font-container",
			},
			"card-colors-btn": { setup: null, tab: ".card-colors-container" },
			"customize-dark-btn": {
				setup: displayDarkModeFixUrls,
				tab: ".customize-dark",
			},
			"import-export-btn": {
				setup: displayThemeList,
				tab: ".import-export",
			},
			"report-issue-btn": {
				setup: displayErrors,
				tab: ".report-issue-container",
			},
			"updates-btn": { setup: null, tab: ".updates-container" },
		},
		special: [
			{
				identifier: "auto_dark_start",
				setup: (initial) =>
					setupAutoDarkInput(initial, "auto_dark_start"),
			},
			{
				identifier: "auto_dark_end",
				setup: (initial) =>
					setupAutoDarkInput(initial, "auto_dark_end"),
			},
			{
				identifier: "num_assignments",
				setup: (initial) => setupAssignmentsSlider(initial),
			},
			{
				identifier: "num_todo_items",
				setup: (initial) => setupTodoSlider(initial),
			},
            {
                identifier: "sidebar_scale",
                setup: (initial) => setupSidebarScaleSlider(initial),
            },
			{
				identifier: "card_limit",
				setup: (initial) => setupCardLimitSlider(initial),
			},
			{
				identifier: "card_method_dashboard",
				setup: (initial) => setupDashboardMethod(initial),
			},
			{
				identifier: "custom_styles",
				setup: (initial) => setupCustomStyle(initial),
			},
			// {
			// 	identifier: "scheduledReminderTime",
			// 	setup: (initial) => setupScheduledReminderInput(initial),
			// },
			{
				identifier: "imageSize",
				setup: (initial) => setupImageSizeInput(initial),
			},
			{
				identifier: "cardRoundness",
				setup: (initial) => setupCardRoundnessInput(initial),
			},
			{
				identifier: "cardSpacing",
				setup: (initial) => setupCardSpacingInput(initial),
			},
			{
				identifier: "cardWidth",
				setup: (initial) => setupCardWidthInput(initial),
			},
			{
				identifier: "cardHeight",
				setup: (initial) => setupCardHeightInput(initial),
			},
			{
				identifier: "customBackgroundLink",
				setup: (initial) => setupCustomBackgroundLink(initial),
			},
            {
                identifier: "customBackgroundScale",
                setup: (initial) => setupCustomBackgroundScale(initial),
            },
		],
	};

    chrome.storage.sync.get(menu.switches, sync => {
        menu.switches.forEach(option => {
            let optionSwitch = document.getElementById(option);
            if (!optionSwitch) return;
            const onControl = optionSwitch.querySelector(`#${option}-on`);
            const offControl = optionSwitch.querySelector(`#${option}-off`);
            if (!onControl || !offControl) return;
            let status = sync[option] === true;
            const activeControl = status ? onControl : offControl;
            activeControl.checked = true;
            activeControl.classList.add('checked');

            optionSwitch.querySelector(".slider").addEventListener("mouseup", () => {
                status = !onControl.checked;
                onControl.checked = status;
                onControl.classList.toggle("checked");
                offControl.checked = !status;
                offControl.classList.toggle("checked");
                queueSettingWrite({ [option]: status }, option);
                if (option === "auto_dark") {
                    toggleDarkModeDisable(status);
                }
            });
        });
    });

    chrome.storage.sync.get(menu.checkboxes, sync => {
        menu.checkboxes.forEach(option => {
			const checkbox = document.querySelector("#" + option);
			if (!checkbox) {console.log(option); return;}
            checkbox.addEventListener("change", function (e) {
                let status = this.checked;
                queueSettingWrite({ [option]: status }, option);
            });
            const value = sync[option] !== undefined ? sync[option] : defaultOptions.sync[option];
            document.querySelector("#" + option).checked = value;
        });
        /*
        document.querySelector('#autodark_start').value = result.auto_dark_start["hour"] + ":" + result.auto_dark_start["minute"];
        document.querySelector('#autodark_end').value = result.auto_dark_end["hour"] + ":" + result.auto_dark_end["minute"];
        document.querySelector("#assignment_date_format").checked = result.assignment_date_format == true;
        document.querySelector("#todo_hr24").checked = result.todo_hr24 == true;
        */
        toggleDarkModeDisable(sync.auto_dark);
        displayBackgroundPresets();
    });

    const specialOptions = menu.special.map(obj => obj.identifier);
    chrome.storage.sync.get(specialOptions, sync => {
        console.log(sync);
        menu.special.forEach(option => {
            if (option.setup !== null) {
                const value = sync[option.identifier] !== undefined ? sync[option.identifier] : defaultOptions.sync[option.identifier];
                option.setup(value);
            }
        });
    })

    /*
    // checkboxes
    menu.checkboxes.forEach(checkbox => {
        document.querySelector("#" + checkbox).addEventListener('change', function () {
            let status = this.checked;
            chrome.storage.sync.set(JSON.parse(`{"${checkbox}": ${status}}`));
        });
    });
    */

    // activate tab buttons
    document.querySelectorAll(".tab-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            hideLegacyTabs();
            if (menu.tabs[btn.id].setup !== null) menu.tabs[btn.id].setup();
            setLegacyControlVisibility(document.querySelector(".main"), false);
            setLegacyControlVisibility(document.querySelector(menu.tabs[btn.id].tab), true);
            window.scrollTo(0, 0);
            window.APStudyCanvasWorkspace?.syncCategoryFromLegacy(btn.dataset.category || "overview");
        });
    });

    // activate the back buttons on each tab
    document.querySelectorAll(".back-btn").forEach(btn => {
        btn.addEventListener("click", function () {
            hideLegacyTabs();
            setLegacyControlVisibility(document.querySelector(".main"), true);
            window.APStudyCanvasWorkspace?.syncCategoryFromLegacy(this.closest(".tab")?.dataset.category || window.APStudyCanvasWorkspace?.category || "overview");
        });
    });

    // give everything the appropirate i18n text
    document.querySelectorAll('[data-i18n]').forEach(text => {
        text.innerText = chrome.i18n.getMessage(text.dataset.i18n);
    });

    // activate dark mode inspector button
    document.querySelector("#inspector-btn").addEventListener("click", async function () {
        document.querySelector("#inspector-output").textContent = (await sendFromPopup("inspect"))["selectors"];
    });

    // activate dark mode fixer button
    document.querySelector("#fix-dm-btn").addEventListener("click", async function () {
        let output = await sendFromPopup("fixdm");
        if (!output || typeof output !== "object") {
            displayAlert(true, "Canvas did not return a dark mode fix result. Refresh the Canvas tab and try again.");
            return;
        }
        if (output.path === "canvasrefined-none" || output.path === "canvasrefined-darkmode_off") return;
        let rating = "bad";
        if (output.time < 100) {
            rating = "good";
        } else if (output.time < 250) {
            rating = "ok";
        }
        document.getElementById("fix-dm-output").textContent = "Fix took " + Math.round(output.time) + "ms (rating: " + rating + ")";
        chrome.storage.sync.get("dark_mode_fix", sync => {
            const urls = Array.isArray(sync["dark_mode_fix"]) ? sync["dark_mode_fix"].slice() : [];
            if (urls.includes(output.path)) return;
            urls.push(output.path);
            queueSettingWrite({ dark_mode_fix: urls }, "dark-mode-fix").then(() => displayDarkModeFixUrls()).catch(() => {});
        })
    });

    // activate storage dump button
    document.querySelector("#rk_btn").addEventListener("click", () => {
        chrome.storage.local.get(null, local => {
            chrome.storage.sync.get(null, sync => {
                document.querySelector("#rk_output").value = JSON.stringify(local) + JSON.stringify(sync);
            })
        })
    });

    // activate storage reset button
    document.querySelector("#storage-reset-btn").addEventListener("click", () => {
        if (!window.confirm("Reset known APStudyCanvas settings to their defaults? Saved themes, cards, GPA, fonts, errors, and unknown data will be kept.")) return;
        const reset = {};
        settingsSchema.knownResettableKeys.forEach((key) => {
            if (Object.prototype.hasOwnProperty.call(defaultOptions.sync, key)) reset[key] = cloneSetting(defaultOptions.sync[key]);
        });
        runExplicitTransaction(
            () => chrome.storage.sync.get(settingsSchema.knownResettableKeys),
            () => true,
            reset
        ).catch(() => {});
    });

    // Custom Canvas is an explicit permission-bearing action. Typing or
    // startup reconciliation never requests permission and never persists a
    // domain. The button is created here because the legacy markup only had a
    // free-form input.
    setupCustomCanvasDomainFlow();

    // Import only after an explicit change/commit gesture; never parse or
    // apply a partially typed JSON document.
    document.querySelector("#import-input").addEventListener("change", (e) => {
        importThemeText(e.target.value);
    });

    // activate export checkbox
    document.querySelectorAll(".export-details input").forEach(input => {
        input.addEventListener("change", () => {
            chrome.storage.sync.get(syncedSwitches.concat(syncedSubOptions).concat(["dark_preset", "custom_cards", "custom_font", "gpa_calc_bounds"]), async storage => {
                //chrome.storage.local.get(["dark_preset"], async local => {
                let final = {};
                for await (item of document.querySelectorAll(".export-details input")) {
                    if (item.checked) {
                        switch (item.id) {
                            case "export-toggles":
                                final = { ...final, ...(await getExport(storage, syncedSwitches.concat(syncedSubOptions))) };
                                break;
                            case "export-dark":
                                final = { ...final, ...(await getExport(storage, ["dark_preset"])) };
                                break;
                            case "export-cards":
                                final = { ...final, ...(await getExport(storage, ["custom_cards"])) };
                                break;
                            case "export-font":
                                final = { ...final, ...(await getExport(storage, ["custom_font"])) };
                                break;
                            case "export-colors":
                                final = { ...final, ...(await getExport(storage, ["card_colors"])) }
                                break;
                            case "export-gpa":
                                final = { ...final, ...(await getExport(storage, ["gpa_calc_bounds"])) }
                                break;
							case "export-customStyles":
								final = { ...final, ...(await getExport(storage, ["custom_styles"])) };
								break;
							case "export-background":
                                final = { ...final, ...(await getExport(storage, ["customBackgroundLink", "customBackgroundScale"])) };
								break;
                        }
                    }
                }
                document.querySelector("#export-output").value = JSON.stringify(final);
                //});
            });
        });
    });

    // activate revert to original button
    document.querySelector("#theme-revert").addEventListener("click", () => {
        chrome.storage.local.get("previous_theme", local => {
            if (local["previous_theme"] === null || local["previous_theme"] === undefined) return;
            if (!window.confirm("Revert the current theme to the saved original?")) return;
            importTheme(local["previous_theme"]);
        });
    });

    document.querySelector("#alert").addEventListener("click", clearAlert);
    // TODO: maybe fix this at some point, idk what is causing the error here
    document.querySelectorAll(".preset-button.customization-button").forEach(btn => btn.addEventListener("click", changeToPresetCSS));

    // activate card color inputs
    document.querySelector("#singleColorInput").addEventListener("change", e => document.querySelector("#singleColorText").value = e.target.value);
    document.querySelector("#singleColorText").addEventListener("change", e => document.querySelector("#singleColorInput").value = e.target.value);
    document.querySelector("#gradientColorFrom").addEventListener("change", e => document.querySelector("#gradientColorFromText").value = e.target.value);
    document.querySelector("#gradientColorFromText").addEventListener("change", e => document.querySelector("#gradientColorFrom").value = e.target.value);
    document.querySelector("#gradientColorTo").addEventListener("change", e => document.querySelector("#gradientColorToText").value = e.target.value);
    document.querySelector("#gradientColorToText").addEventListener("change", e => document.querySelector("#gradientColorTo").value = e.target.value);
    document.querySelector("#setSingleColor").addEventListener("click", () => {
        let colors = [document.querySelector("#singleColorInput").value];;
        sendFromPopup("setcolors", colors);
    });
    document.querySelector("#setGradientColor").addEventListener("click", () => {
        chrome.storage.sync.get("custom_cards", sync => {
            length = 0;
            Object.keys(sync["custom_cards"]).forEach(key => {
                if (sync["custom_cards"][key].hidden !== true) length++;
            });
            let colors = [];
            let from = document.querySelector("#gradientColorFrom").value;
            let to = document.querySelector("#gradientColorTo").value;
            for (let i = 1; i <= length; i++) {
                colors.push(getColorInGradient(i / length, from, to));
            }
            sendFromPopup("setcolors", colors);
        });
    });

    // activate revert to original card colors button
    document.querySelector("#revert-colors").addEventListener("click", () => {
        chrome.storage.local.get("previous_colors", local => {
            if (local["previous_colors"] !== null) {
                sendFromPopup("setcolors", local["previous_colors"].colors);
            }
        })
    })

    // activate every card color palette button
    document.querySelectorAll(".preset-button.colors-button").forEach(btn => {
        const colors = getPalette(btn.querySelector("p").textContent);
        let preview = btn.querySelector(".colors-preview");
        colors.forEach(color => {
            let div = makeElement("div", preview, { "className": "color-preview"});
            div.style.background = color;
        });
        btn.addEventListener("click", () => {
            sendFromPopup("setcolors", colors);
        })
    });

    /*
    ['autodark_start', 'autodark_end'].forEach(function (timeset) {
        document.querySelector('#' + timeset).addEventListener('change', function () {
            let timeinput = { "hour": this.value.split(':')[0], "minute": this.value.split(':')[1] };
            timeset === "autodark_start" ? chrome.storage.sync.set({ auto_dark_start: timeinput }) : chrome.storage.sync.set({ auto_dark_end: timeinput });
        });
    });
    */

    // activate sidebar tool radio
    ["#radio-sidebar-image", "#radio-sidebar-gradient", "#radio-sidebar-solid"].forEach(radio => {
        document.querySelector(radio).addEventListener("click", () => {
            chrome.storage.sync.get(["dark_preset"], storage => {
                let mode = radio === "#radio-sidebar-image" ? "image" : radio === "#radio-sidebar-gradient" ? "gradient" : "solid";
                displaySidebarMode(mode, storage["dark_preset"]["sidebar"]);
            });
        })
    });

    // theme browser controls
    document.getElementById("premade-themes-left").addEventListener("click", () => changePage(-1));
    document.getElementById("premade-themes-right").addEventListener("click", () => changePage(1));
    document.getElementById("theme-sorts").addEventListener("click", () => {
        const el = document.getElementById("theme-sort-selector");
        if (el.classList.contains("open")) {
            clickout();
        } else {
            el.classList.add("open");
            setTimeout(() => {
                document.addEventListener("click", clickout);
        }, 10);
        }
    });
    document.getElementById("theme-search").addEventListener("change", async (e) => {
        searchFor = e.target.value;
        console.log(searchFor);
        // current_page_num = 1;
        // displayThemeList(0);
        // linear search
        let themesToShow = [];
        for (let i = 0; i < themes.length; i++) {
            if (themes[i].title.toLowerCase().includes(searchFor.toLowerCase())) {
                themesToShow.push(themes[i]);
            }
        }
        console.log(themesToShow);
        displayThemeSearchList(themesToShow);
    });

    // activate theme save button
    document.getElementById("save-theme").addEventListener("click", saveCurrentTheme);

    // activate submit theme button
    // document.getElementById("submit-theme-btn").addEventListener("click", submitTheme);

    document.getElementById("submit-theme-btn-1").addEventListener("click", () => {
        document.getElementById("submit-popup").classList.add("open");
    });

    document.getElementById("cancel-theme-btn").addEventListener("click", () => {
        document.getElementById("submit-popup").classList.remove("open");
    })

    // update theme button preview on input
    document.getElementById("submit-title").addEventListener("input", (e) => {
        document.getElementById("theme-button-title-preview").textContent = e.target.value.replaceAll(" ", "");
    });

    // update theme button preview on input
    document.getElementById("submit-credits").addEventListener("input", (e) => {
        document.getElementById("theme-button-creator-preview").textContent = e.target.value;
    });

    // activate the show button to open the theme submission drawer
    document.getElementById("show-submit-form").addEventListener("click",  (e) => {
        const drawer = document.getElementById("submit-drawer");
        if (drawer.style.display === "none") {
            drawer.style.display = "block";
            e.target.textContent = "Hide";
        } else {
            drawer.style.display = "none";
            e.target.textContent = "Show";
        }
    });

    // activate theme browser opt in
    // document.getElementById("new_browser_in").addEventListener("click", registerUser);

    document.querySelectorAll(".theme-sort-btn").forEach(btn => {
        btn.addEventListener("click", (e) => {
            themeSort(e.target.textContent);
        });
    });

    // browser settings buttons
    document.getElementById("browser-settings-btn").addEventListener("click", () => {
        document.getElementById("browser-settings-popup").classList.add("open");
    });

    document.getElementById("close-settings-btn").addEventListener("click", () => {
        displayThemeList(0);
        document.getElementById("browser-settings-popup").classList.remove("open");
    });

    // document.getElementById("reset-optin").addEventListener("click", () => {
    //     chrome.storage.sync.set({ "new_browser": null });
    //     document.getElementById("opt-in").style.display = "block";
    // });

    // document.getElementById("view-submissions-btn").addEventListener("click", displayMySubmissions);
    document.getElementById("submit-form-btn").addEventListener("click", displayThemeSubmissionForm);

    document.getElementById("gpa-plus-minus").addEventListener("click", () => {
        applyGPAPreset({
            "A+": { "cutoff": 97, "gpa": 4.0 },
            "A": { "cutoff": 93, "gpa": 4.0 },
            "A-": { "cutoff": 90, "gpa": 3.7 },
            "B+": { "cutoff": 87, "gpa": 3.3 },
            "B": { "cutoff": 83, "gpa": 3.0 },
            "B-": { "cutoff": 80, "gpa": 2.7 },
            "C+": { "cutoff": 77, "gpa": 2.3 },
            "C": { "cutoff": 73, "gpa": 2.0 },
            "C-": { "cutoff": 70, "gpa": 1.7 },
            "D+": { "cutoff": 67, "gpa": 1.3 },
            "D": { "cutoff": 63, "gpa": 1.0 },
            "D-": { "cutoff": 60, "gpa": 0.7 },
            "F": { "cutoff": 0, "gpa": 0 }
        });
    });
    document.getElementById("gpa-by-letter").addEventListener("click", () => {
        applyGPAPreset({
            "A+": { "cutoff": 97, "gpa": 4.0 },
            "A": { "cutoff": 93, "gpa": 4.0 },
            "A-": { "cutoff": 90, "gpa": 4.0 },
            "B+": { "cutoff": 87, "gpa": 3.0 },
            "B": { "cutoff": 83, "gpa": 3.0 },
            "B-": { "cutoff": 89, "gpa": 3.0 },
            "C+": { "cutoff": 77, "gpa": 2.0 },
            "C": { "cutoff": 73, "gpa": 2.0 },
            "C-": { "cutoff": 70, "gpa": 2.0 },
            "D+": { "cutoff": 67, "gpa": 1.0 },
            "D": { "cutoff": 63, "gpa": 1.0 },
            "D-": { "cutoff": 60, "gpa": 1.0 },
            "F": { "cutoff": 0, "gpa": 0 }
        });
    });
    
    document.getElementById("clearCustomBackground").addEventListener("click", () => {
        queueSettingWrite({ customBackgroundLink: "", customBackgroundScale: 100 }, "custom-background");
        document.querySelector("#customBackgroundLink").value = "";
		document.querySelector("#customBackgroundScale").value = 100;
		document.querySelector("#customBackgroundScaleValue").textContent = "100%";
		renderBackgroundPresetSelection();
		sendFromPopup("updateBackground");
    });

    const applyFontsDropdownState = (isOpen) => {
        const el = document.getElementById("quick-fonts");
        const el2 = document.getElementsByClassName("custom-font")[0];
        const arrow = document.getElementById("fontsDropdownArrow");
        if (!el || !el2 || !arrow) return;
        el.style.display = isOpen ? "flex" : "none";
        el2.style.display = isOpen ? "block" : "none";
        arrow.style.transform = isOpen ? "rotate(180deg)" : "rotate(0deg)";
    };

    chrome.storage.local.get([fontsDropdownStateKey], (storage) => {
        const isOpen = storage[fontsDropdownStateKey] !== false;
        applyFontsDropdownState(isOpen);
    });

    document.getElementById("fontsDropdown").addEventListener("click", () => {
        const el = document.getElementById("quick-fonts");
        const el2 = document.getElementsByClassName("custom-font")[0];
        if (!el || !el2) return;
        const isCurrentlyOpen = getComputedStyle(el).display !== "none" && getComputedStyle(el2).display !== "none";
        const nextOpen = !isCurrentlyOpen;
        applyFontsDropdownState(nextOpen);
        chrome.storage.local.set({ [fontsDropdownStateKey]: nextOpen });
    });

}

function applyGPAPreset(bounds) {
    runExplicitTransaction(
        () => chrome.storage.sync.get(["gpa_calc_bounds"]),
        (next) => isPlainObject(next.gpa_calc_bounds) && Object.keys(bounds).length > 0,
        { gpa_calc_bounds: cloneSetting(bounds) }
    ).then(() => displayGPABounds()).catch(() => {});
}

function setupCustomStyle(initial) {
    const el = document.getElementById("custom-styles");
    if (!el) return;
    el.value = initial;
    el.addEventListener("change", (e) => {
        queueSettingWrite({ custom_styles: e.target.value }, "custom-styles");
    });
}


function displayThemeSubmissionForm() {
    document.getElementById("submit-form").style.display = "block";
    document.getElementById("view-submissions").style.display = "none";
    document.getElementById("submit-form-btn").classList.add("active");
    document.getElementById("view-submissions-btn").classList.remove("active");
}

async function displayMySubmissions() { //TODO: remake
    const sync = await chrome.storage.sync.get("id");
    const res = await fetch(`${apiurl}/api/themes/submissions?id=${sync["id"]}`);
    const data = await res.json();

    //if (data?.errors !== false) return;

    document.getElementById("submit-form").style.display = "none";
    document.getElementById("view-submissions").style.display = "block";
    document.getElementById("submit-form-btn").classList.remove("active");
    document.getElementById("view-submissions-btn").classList.add("active");

    const el = document.getElementById("latest-submissions");
    el.textContent = "";

    if (data.message.length === 0) {
        el.textContent = "You haven't submitted any themes yet.";
    }

    data.message.forEach(theme => {
        const container = makeElement("div", el, {"className": "submitted-theme" });
        const btn = makeElement("button", container, { "className": "theme-button clickable customization-button", "style": `min-width:105px;max-width:105px;background-image:linear-gradient(rgba(0, 0, 0, 0.44), rgba(0, 0, 0, 0.44)), url(${theme.preview})` });
        const title = makeElement("p", btn, { "className": "theme-button-title clickable", "textContent": theme.title });
        const credits = makeElement("p", btn, { "className": "theme-button-creator clickable", "textContent": theme.credits });
        const details = makeElement("div", container, { "className": "submitted-theme-details" });
        const top = makeElement("div", details, { "style": "display:flex;justify-content:space-between;align-items:center" });
        const tag = makeElement("span", top, { "className": "submitted-theme-tag", "textContent": theme.approved === 1 ? "Approved" : theme.approved === 0 ? "Pending" : "Rejected", "style": `background: ${theme.approved === 1 ? "#ad3a74" : theme.approved === 0 ? "#514e4e": "#000"}` });
        const msg = makeElement("p", details, { "textContent": theme.approved === 1 ? "Looks great! Thanks for submitting" : theme.approved === 0 ? "Your theme is still awaiting approval." : `Your theme was rejected${theme.reason ? (": " + theme.reason) : " because it did not meet the theme guidelines."}`});
        const ago = makeElement("span", top, { "className": "submitted-theme-time", "textContent": `${getRelativeDate(new Date(parseInt(theme.time))).time} ago` });
    });
}

async function getExport(storage, options) {
    let final = {};
    for (const option of options) {
        switch (option) {
            case "custom_cards":
                let arr = [];
                Object.keys(asPlainObject(storage["custom_cards"])).forEach(key => {
                    if (storage["custom_cards"][key]?.img !== "") arr.push(storage["custom_cards"][key].img);
                });
                if (arr.length === 0) {
                    arr = ["none"];
                }
                final["custom_cards"] = arr;
                break;
            case "card_colors":
                final["card_colors"] = [];
                try {
                    final["card_colors"] = await sendFromPopup("getcolors");
                } catch (e) {
                    console.log(e);
                }
                break;
			case "custom_styles":
				final["customCardStyles"] = storage["customCardStyles"];
				final["imageSize"] = storage["imageSize"];
				final["cardRoundness"] = storage["cardRoundness"];
				final["cardSpacing"] = storage["cardSpacing"];
				final["cardWidth"] = storage["cardWidth"];
				final["cardHeight"] = storage["cardHeight"];
				break;
            default:
                final[option] = storage[option];
        }
    }
    return final;
}

let pageTimeout = false;

function changePage(direction) {
    if (pageTimeout) return;
    pageTimeout = true;
    displayThemeList(direction);
    setTimeout(() => {
        pageTimeout = false;
    }, 500);
}

const colorValues = {
    "red": 1,
    "pink": 2,
    "orange": 3,
    "yellow": 4,
    "lightgreen": 5,
    "green": 6,
    "lightblue": 7,
    "blue": 8,
    "lightpurple": 9,
    "purple": 10,
    "lightpurple": 11,
    "beige": 12,
    "brown": 13,
    "gray": 14,
}

function themeSortFn(method) {
    let themes = getTheme("all");
    switch (method) {
        case "New":
            return themes.reverse();
        case "Old":
            return themes;
        case "Color":
            return themes.sort((a, b) => {
                //return (colorValues[a.color] || 88) - (colorValues[b.color] || 88)
                return (colorValues[a.color] || (a.color !== "whiteblack" && a.color.includes("white") ? 15 : 16)) - (colorValues[b.color] || (b.color !== "whiteblack" && b.color.includes("white") ? 15 : 16))
            })
            return themes.sort((a, b) => {
                return a.color < b.color ? 1 : -1;
            })
        case "ABC":
            return themes.sort((a, b) => {
                return a.title.toLowerCase() > b.title.toLowerCase() ? 1 : -1;
            })
        default:
            return shuffle(themes).sort((a, b) => {
                a = a.score + "";
                b = b.score + "";
                a = parseInt(a.charAt(0)) + parseInt(a.charAt(1)) + parseInt(a.charAt(2)) + parseInt(a.charAt(3));
                b = parseInt(b.charAt(0)) + parseInt(b.charAt(1)) + parseInt(b.charAt(2)) + parseInt(b.charAt(3));
                return b - a;
            });
    }
}

let cache = {};

// new theme sort button
function themeSort(sort) {
    current_sort = sort;
    current_page_num = 1;
    allThemes = themeSortFn(current_sort);
    displayThemeList(0);
}

function clickout() {
    setTimeout(() => {
        document.getElementById("theme-sort-selector").classList.remove("open");
        document.removeEventListener("click", clickout);
    }, 10);
}

// shuffle function for the score sorting so theres no order bias
function shuffle (arr) {
    var j, x, index;
    for (index = arr.length - 1; index > 0; index--) {
        j = Math.floor(Math.random() * (index + 1));
        x = arr[index];
        arr[index] = arr[j];
        arr[j] = x;
    }
    return arr;
}

let current_page_num = 1;
let maxPage = 0;
let searchFor = "";
let current_sort = "Popular";
let allThemes = themeSortFn(current_sort);

//sortThemes(current_sort);

function shortScore(score) {
    if (score >= 1400) {
        return (Math.floor(score / 1000) + "." +  Math.round((score % 1000) / 100)) + "k";
    }
    return score;
}

let fallback = false;

async function submitTheme() { //TODO: remake

    const sync = await chrome.storage.sync.get(null);

    // if (sync["new_browser"] !== true) {
    //     displayAlert(true, "You'll need to opt in to the new browser if you want to submit your theme. If you've opted out and want to opt in, you can scroll down to the bottom of this page and opt back in.");
    //     return;
    // }

    const theme = await getExport(sync, [
        ...syncedSwitches,
        ...syncedSubOptions,
        "custom_cards",
        "card_colors",
        "dark_preset",
        "custom_font",
        "gradient_cards",
        "disable_color_overlay",
    ]);
    const title = document.getElementById("submit-title");
    const credits = document.getElementById("submit-credits");

    if (title.value === "") {
        displayAlert(true, "The title of your theme can't be empty");
        return;
    }

    if (credits.value === "") {
        displayAlert(true, "The credits for your theme can't be empty");
        return;
    }
    const body = JSON.stringify({
        "identity": sync["id"],
        "title": title.value,
        "credits": credits.value,
        "theme": JSON.stringify(theme)
    });

    fetch(`${apiurl}/api/themes/submit`, { //
        "method": "POST",
        "body": body,
        "headers": {
            "Content-Type": "application/json",
          },
    }).then(res => res.json())
    .then(data => {
        console.log(data);
        if (data.errors === false) {
            displayAlert(false, "Thanks for submitting your theme! I will try to approve it soon, but not every theme may be accepted.");
            document.getElementById("submit-popup").classList.remove("open");
        } else {
            displayAlert(true, `Submission error: ${data.message} Please contact sandlerguy5@gmail.com if you believe this is incorrect.`);
        }
    });
}

async function registerUser() { // TODO: remake
    try {
        let id;

        const sync = await chrome.storage.sync.get("id");

        if (sync["id"] && sync["id"] !== "") {
            id = sync["id"]
        } else {
            const res = await fetch(`${apiurl}/api/register`);
            const data = await res.json();
            id = data.id;
        }

        queueSettingWrite({ id }, "theme-account").then(async () => {
            // test to see if the id was set correctly
            // don't know why this is happening ??
            const test = await chrome.storage.sync.get("id");
            if (test["id"] === undefined || test["id"] === "") throw new Error();

            // show the new browser
            queueSettingWrite({ new_browser: true }, "theme-account").then(() => {
                document.getElementById("opt-in").style.display = "none";
                current_page_num = 1;
                displayThemeList(0);
                displayAlert(false, "Success! You should be able to see the new themes browser now. Enjoy!");
            });

        }).catch(e => {
            displayAlert(true, "There was an error connecting an ID to your account. Please try again, and if this error persists, contact sandlerguy5@gmail.com!");
        });

    } catch (e) {
        console.log(e);
        displayAlert(true, "There was an error opting in. Please contact sandlerguy5@gmail.com if this error persists!");
    }
}

function saveCurrentTheme() {
    const allOptions = syncedSwitches.concat(syncedSubOptions).concat(["dark_preset", "custom_cards", "custom_font", "gpa_calc_bounds", "card_colors"]);
    chrome.storage.local.get("saved_themes", local => {
        chrome.storage.sync.get(allOptions, async sync => {
            let current = await getExport(sync, allOptions);
            let trimmed = { 
                "disable_color_overlay": current["disable_color_overlay"], 
                "gradient_cards": current["gradient_cards"],
                "dark_mode": current["dark_mode"],
                "dark_preset": current["dark_preset"],
                "custom_cards": current["custom_cards"],
                "card_colors": current["card_colors"] === null ? [current["dark_preset"]["links"]] : current["card_colors"],
                "custom_font": current["custom_font"],
                "better_todo": current["better_todo"],
                "todo_hide_feedback": current["todo_hide_feedback"],
                "todo_full_height": current["todo_full_height"],
                "todo_hr24": current["todo_hr24"],
                "todo_separate_scrollbar": current["todo_separate_scrollbar"],
                "num_todo_items": current["num_todo_items"],
                "hover_preview": current["hover_preview"],
                "better_sidebar": current["better_sidebar"],
                "sidebar_scale": current["sidebar_scale"],
				"imageSize": current["imageSize"],
				"cardRoundness": current["cardRoundness"],
				"cardSpacing": current["cardSpacing"],
				"cardWidth": current["cardWidth"],
				"cardHeight": current["cardHeight"],
				"customBackgroundLink": current["customBackgroundLink"],
				"customBackgroundScale": current["customBackgroundScale"],
            }
            const now = new Date();
            const savedThemes = asPlainObject(local["saved_themes"]);
            savedThemes[now.getTime()] = trimmed;
            chrome.storage.local.set({ "saved_themes": savedThemes }).then(() => {
                displaySavedThemes();
            });
        });        
    });
}


async function displayThemeList(direction = 0) {
    // const sync = await chrome.storage.sync.get("new_browser");
    // if (sync["new_browser"] === true && fallback === false) {
        // displayThemeListNew(direction);
    // } else {
        displayThemeListOld(direction);
    // }
    // remove the opt-in notice
    // if (sync["new_browser"] !== null && document.getElementById("opt-in")) document.getElementById("opt-in").style.display = "none";
}

function createThemeButton(location, theme) {
    let themeBtn = makeElement("button", location, { "className": "theme-button clickable" });
    themeBtn.classList.add("customization-button");
    if (!themeBtn.style.background) themeBtn.style.backgroundImage = "linear-gradient(#00000070, #00000070), url(" + theme.preview + ")";
    if (theme.title) makeElement("p", themeBtn, { "className": "theme-button-title clickable", "textContent": theme.title.replaceAll(" ", "") });
    if (theme.credits) makeElement("p", themeBtn, { "className": "theme-button-creator clickable", "textContent": theme.credits });
    return themeBtn;
}

function createThemeLikeBtn(location, initial, score, show) {
    const likeBtn = makeElement("div", location, {"className": "theme-button-like"});
    if (initial === true) {
        likeBtn.classList.add("theme-liked");
        score += 1;
    }
    const amount = makeElement("span", likeBtn, { "className": "theme-button-like-amount", "textContent": shortScore(score) });
    if (show === true) amount.classList.add("showalways");
    likeBtn.innerHTML += `<svg  xmlns="http://www.w3.org/2000/svg"  width="12"  height="12"  viewBox="0 0 24 24"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M6.979 3.074a6 6 0 0 1 4.988 1.425l.037 .033l.034 -.03a6 6 0 0 1 4.733 -1.44l.246 .036a6 6 0 0 1 3.364 10.008l-.18 .185l-.048 .041l-7.45 7.379a1 1 0 0 1 -1.313 .082l-.094 -.082l-7.493 -7.422a6 6 0 0 1 3.176 -10.215z" /></svg>`;
    return likeBtn;
}

let likeThemeTimeout = false;

function setLikeTimeout() {
    if (likeThemeTimeout === true) return;
    likeThemeTimeout = true;
    setTimeout(() => {
        likeThemeTimeout = false;
    }, 1000);
}

async function likeTheme(location, code, score) { // TODO: remake

    if (likeThemeTimeout === true) return;

    const sync = await chrome.storage.sync.get("id");
    const local = await chrome.storage.local.get("liked_themes");

    const setLikeStatus = (direction) => {

        let output = local;
    
        if (direction === -1) {
            location.classList.remove("theme-liked");
            location.querySelector(".theme-button-like-amount").textContent = shortScore(score);
            output = local["liked_themes"].filter(x => x !== code);
        } else if (direction === 1) {
            location.classList += (" theme-liked animate-like");
            location.querySelector(".theme-button-like-amount").textContent = shortScore(score + 1);
            output = [...local["liked_themes"], code];
        }
    
        return output;
    }

    // show the updated like status immediately
    setLikeStatus(location.classList.contains("theme-liked") ? -1 : 1);

    const res = await fetch(`${apiurl}/api/themes/theme/${code}/like`, { 
        "method": "POST", 
        "body": JSON.stringify({ "id": sync["id"] }), 
        "headers": {
            "Content-Type": "application/json"
        },
    });

    const data = await res.json();

    if (data.errors === false) {
        const direction = parseInt(data.message);
        // update the like status if there is some disagreement with the server
        const update = setLikeStatus(direction);
        chrome.storage.local.set({ "liked_themes": update }).then(setLikeTimeout);
    } else {
        setLikeTimeout();
    }
}

async function getAndLoadTheme(code) { // todo: remake
    const key = `themes/${code}`;
    let output = {};
    if (cache[key]) {
        output = cache[key];
        console.log("got this theme from the cache.");
    } else {
        const res = await fetch(`${apiurl}/api/themes/theme/${code}`);
        const data = await res.json();
        output = JSON.parse(data.message.exports);
        cache[key] = output;
    }
    importTheme(output);
}

async function displayThemeListNew(direction) { // TODO: remake
    
    document.getElementById("theme-current-sort").textContent = current_sort;
    if (direction === -1 && current_page_num > 1) current_page_num--;
    if (direction === 1 && current_page_num < maxPage) current_page_num++;

    let themes = [];
    let apiLink = `${current_sort.toLowerCase()}?page=${current_page_num}` + (searchFor === "" ? "" : `&searchFor=${searchFor}`);
    if (current_sort === "Liked") {
        const sync = await chrome.storage.sync.get("id");
        const local = await chrome.storage.local.get("liked_themes");
        if (sync["id"] && sync["id"] !== "") {
            apiLink += `&id=${sync["id"]}`;
            maxPage = Math.ceil(local["liked_themes"].length / 28);
        } else { // fallback if there is no id
            current_page_num = 1;
            apiLink = `popular?page=${current_page_num}` + (searchFor === "" ? "" : `&searchFor=${searchFor}`);
        }
    }

    // fetch api, fallback if necessary
    if (cache[apiLink]) {
        themes = cache[apiLink]["themes"];
        maxPage = cache[apiLink]["pages"] || maxPage;
    } else {
        try {
            const res = await fetch(`${apiurl}/api/themes/${apiLink}`, {
                method: "get",
                headers: {
                    "Content-Type": "application/json"
               },
            });
            const data = await res.json();
            if (data.errors === true) throw new Error(data.message);
            themes = data.message.themes;
            cache[apiLink] = data.message;
            if (data?.message?.pages) {
                maxPage = data.message.pages;
            }
        } catch (e) {
            console.log(e);
            current_page_num = 1;
            fallback = true;
            displayAlert(true, "there is no server you should not be seeing this. There was a problem getting themes from the Canvas Refined server, so the old themes browser is being displayed for now.");
            displayThemeListOld(0);
            return;
        }
    }

    let container = document.getElementById("premade-themes");
    container.textContent = "";

    const local = await chrome.storage.local.get("liked_themes");
    const sync = await chrome.storage.sync.get("browser_show_likes");

    themes.forEach(theme => {

        const themeBtn = createThemeButton(container, theme);
        themeBtn.addEventListener("click", (e) => {
            if (!e.target.classList.contains("clickable")) return;
            // getAndLoadTheme(theme.code)
        }); 

        const liked = local["liked_themes"].includes(theme.code);
        // TODO: remake
        const likeBtn = createThemeLikeBtn(themeBtn, liked, theme.score, sync["browser_show_likes"]);
        // likeBtn.addEventListener("click" , (e) => likeTheme(likeBtn, theme.code, theme.score));

    });

    if (themes.length === 0) {
        container.innerHTML = `<div id="themes-empty">Nothing here</div>`;
    }

    document.getElementById("premade-themes-pagenum").textContent = current_page_num + " of " + maxPage;

    // set the submit theme button to the first custom card image

    try {
        const sync = await chrome.storage.sync.get("custom_cards");
        const exports = await getExport(sync, ["custom_cards"]);
        document.getElementById("theme-button-img").style.background = `linear-gradient(#00000070, #00000070), url(${exports["custom_cards"][0]}) no-repeat center center / cover`;
    } catch (e) {
        console.log(e);
    }

    displaySavedThemes();

}

function displayThemeListOld(pageDir = 0) {
    //const keys = Object.keys(themes);
    document.getElementById("theme-current-sort").textContent = current_sort;
    const perPage = 24;
    const maxPage = Math.ceil(allThemes.length / perPage);
    if (pageDir === -1 && current_page_num > 1) current_page_num--;
    if (pageDir === 1 && current_page_num < maxPage) current_page_num++;
    let container = document.getElementById("premade-themes");
    container.textContent = "";
    let start = (current_page_num - 1) * perPage, end = start + perPage;
    allThemes.forEach((theme, index) => {
        if (index < start || index >= end) return;
        let themeBtn = makeElement("button", container, { "className": "theme-button" });
        themeBtn.classList.add("customization-button");
        if (!themeBtn.style.background) themeBtn.style.backgroundImage = "linear-gradient(#00000070, #00000070), url(" + theme.preview + ")";
        let split = theme.title.split(" by ");
        makeElement("p", themeBtn, {"className": "theme-button-title", "textContent":  split[0] });
        makeElement("p", themeBtn, {"className": "theme-button-creator", "textContent": split[1] });
        themeBtn.addEventListener("click", () => {

            const allOptions = syncedSwitches.concat(syncedSubOptions).concat(["dark_preset", "custom_cards", "custom_font", "gpa_calc_bounds", "card_colors"]);
            chrome.storage.sync.get(allOptions, sync => {
                chrome.storage.local.get(["previous_theme"], async local => {
                    if (local["previous_theme"] === null) {
                        let previous = await getExport(sync, allOptions);
                        chrome.storage.local.set({ "previous_theme": previous });
                    }
                    importTheme(theme.exports);
                });
            });
        });
    });
    document.getElementById("premade-themes-pagenum").textContent = current_page_num + " of " + maxPage;
    displaySavedThemes();
}

function displayThemeSearchList(themesToShow, pageDir = 0) {
    document.getElementById("theme-current-sort").textContent = current_sort;
    const perPage = 24;
    const maxPage = Math.ceil(themesToShow.length / perPage);
    if (pageDir == -1 && current_page_num > 1) current_page_num--;
    if (pageDir == 1 && curren_page_num < maxPage) current_page_num++;
    let container = document.getElementById("premade-themes");
    container.textContent = "";
    let start = (current_page_num - 1) * perPage, end = start + perPage;
    themesToShow.forEach((theme, index) => {
            if (index < start || index >= end) return;
            let themeBtn = makeElement("button", container, { "className": "theme-button" });
            themeBtn.classList.add("customization-button");
            if (!themeBtn.style.background) themeBtn.style.backgroundImage = "linear-gradient(#00000070, #00000070), url(" + theme.preview + ")";
            let split = theme.title.split(" by ");
            makeElement("p", themeBtn, {"className": "theme-button-title", "textContent":  split[0] });
            makeElement("p", themeBtn, {"className": "theme-button-creator", "textContent": split[1] });
            themeBtn.addEventListener("click", () => {
                const allOptions = syncedSwitches.concat(syncedSubOptions).concat(["dark_preset", "custom_cards", "custom_font", "gpa_calc_bounds", "card_colors"]);
                chrome.storage.sync.get(allOptions, sync => {
                    chrome.storage.local.get(["previous_theme"], async local => {
                        if (local["previous_theme"] === null) {
                            let previous = await getExport(sync, allOptions);
                            chrome.storage.local.set({ "previous_theme": previous });
                        }
                        importTheme(theme.exports);
                    });
                });
            });
        }
    )
}

function getRelativeDate(date, short = false) {
    let now = new Date();
    let timeSince = (now.getTime() - date.getTime()) / 60000;
    let time = "min";
    timeSince = Math.abs(timeSince);
    if (timeSince >= 60) {
        timeSince /= 60;
        time = short ? "h" : "hour";
        if (timeSince >= 24) {
            timeSince /= 24;
            time = short ? "d" : "day";
            if (timeSince >= 7) {
                timeSince /= 7;
                time = short ? "w" : "week";
            }
        }
    }
    timeSince = Math.round(timeSince);
    let relative = timeSince + (short ? "" : " ") + time + (timeSince > 1 && !short ? "s" : "");
    return { time: relative, ms: now.getTime() - date.getTime() };
}

function displaySavedThemes() {
    chrome.storage.local.get("saved_themes", local => {
        const target = document.getElementById("saved-themes");
        if (!target) return;
        target.textContent = "";
        const savedThemes = asPlainObject(local["saved_themes"]);
        Object.keys(savedThemes).forEach((key, index) => {
            const created = new Date(parseInt(key));
            let btn = makeElement("div", target, { "className": "saved-theme" });
            let title = makeElement("p", btn, { "className": "theme-button-title", "textContent": `Theme ${index + 1}`});
            let date = makeElement("p", btn, { "className": "theme-button-creator", "textContent": `${getRelativeDate(created).time} ago` });
            let remove = makeElement("div", btn, { "className": "theme-button-remove", "textContent": "x" });
            btn.style.backgroundImage = `linear-gradient(rgba(0, 0, 0, 0.44), rgba(0, 0, 0, 0.44)), url(${savedThemes[key]?.["custom_cards"]?.[0] || ""})`;
            btn.addEventListener("click", () => {
                importTheme(savedThemes[key]);
            });
            remove.addEventListener("click", () => {
                if (!window.confirm("Delete this saved theme?")) return;
                chrome.storage.local.get("saved_themes", local => {
                    const next = asPlainObject(local["saved_themes"]);
                    delete next[key];
                    chrome.storage.local.set({ "saved_themes": next }).then(() => {
                        btn.remove();
                    })
                })
            });
        });
    });
}

function getTheme(name) {

    // get localThemes from themes.js
    console.log(themes);

    if (name === "all") return themes;
    for (const theme in themes) if (theme.title === name) return theme
    return {};
}

function importThemeText(rawText) {
    let parsed;
    try {
        parsed = JSON.parse(rawText);
    } catch (error) {
        displayAlert(true, INVALID_SETTINGS_JSON_MESSAGE);
        return Promise.reject(error);
    }
    if (!isPlainObject(parsed)) {
        displayAlert(true, INVALID_SETTINGS_JSON_MESSAGE);
        return Promise.reject(new Error(INVALID_SETTINGS_JSON_MESSAGE));
    }
    return importTheme(parsed);
}

function isSafeDarkPreset(value) {
    if (!isPlainObject(value)) return false;
    const allowedKeys = new Set(Object.keys(asPlainObject(defaultOptions.sync.dark_preset)));
    return Object.keys(value).every((key) => allowedKeys.has(key) && !/^(?:__proto__|prototype|constructor)$/i.test(key) && !/(?:password|passphrase|secret|token|csrf|cookie|authorization|credential|private[_-]?key|api[_-]?key)/i.test(key) && (/^#[0-9a-f]{6}$/i.test(String(value[key])) || String(value[key]).startsWith("linear-gradient(")));
}

function validateImportedTheme(theme) {
    if (!isPlainObject(theme)) throw new Error(INVALID_SETTINGS_JSON_MESSAGE);
    const allowedKeys = new Set(syncedSwitches.concat(syncedSubOptions, [
        "dark_preset", "custom_font", "gpa_calc_bounds", "custom_cards", "card_colors", "custom_styles", "customCardStyles", "sidebar_page_order", "sidebar_page_visibility"
    ]));
    if (Object.keys(theme).some((key) => !allowedKeys.has(key) || /^(?:__proto__|prototype|constructor)$/i.test(key) || /(?:password|passphrase|secret|token|csrf|cookie|authorization|credential|private[_-]?key|api[_-]?key)/i.test(key))) throw new Error(INVALID_SETTINGS_JSON_MESSAGE);
    const booleanKeys = new Set(syncedSwitches.concat(syncedSubOptions).filter((key) => !["auto_dark_start", "auto_dark_end", "num_assignments", "num_todo_items", "imageSize", "cardRoundness", "cardSpacing", "cardWidth", "cardHeight", "customBackgroundScale", "sidebar_scale", "customBackgroundLink", "custom_styles"].includes(key)));
    const numberKeys = new Set(["num_assignments", "num_todo_items", "imageSize", "cardRoundness", "cardSpacing", "cardWidth", "cardHeight", "customBackgroundScale", "sidebar_scale"]);
    Object.entries(theme).forEach(([key, value]) => {
        if (booleanKeys.has(key) && value !== null && typeof value !== "boolean") throw new Error(INVALID_SETTINGS_JSON_MESSAGE);
        if (numberKeys.has(key) && (typeof value !== "number" || !Number.isFinite(value))) throw new Error(INVALID_SETTINGS_JSON_MESSAGE);
        if (["auto_dark_start", "auto_dark_end"].includes(key) && (!isPlainObject(value) || typeof value.hour !== "string" || typeof value.minute !== "string")) throw new Error(INVALID_SETTINGS_JSON_MESSAGE);
    });
    if (theme.dark_preset !== undefined && !isSafeDarkPreset(theme.dark_preset)) throw new Error(INVALID_SETTINGS_JSON_MESSAGE);
    if (theme.custom_font !== undefined && (!isPlainObject(theme.custom_font) || Object.keys(theme.custom_font).some((key) => !["link", "family"].includes(key)) || Object.values(theme.custom_font).some((value) => typeof value !== "string"))) throw new Error(INVALID_SETTINGS_JSON_MESSAGE);
    if (theme.gpa_calc_bounds !== undefined && (!isPlainObject(theme.gpa_calc_bounds) || Object.values(theme.gpa_calc_bounds).some((value) => !isPlainObject(value) || typeof value.cutoff !== "number" || !Number.isFinite(value.cutoff) || typeof value.gpa !== "number" || !Number.isFinite(value.gpa)))) throw new Error(INVALID_SETTINGS_JSON_MESSAGE);
    if (theme.custom_cards !== undefined && (!Array.isArray(theme.custom_cards) || theme.custom_cards.length > 256 || theme.custom_cards.some((value) => typeof value !== "string"))) throw new Error(INVALID_SETTINGS_JSON_MESSAGE);
    if (theme.sidebar_page_order !== undefined && !popupControllerApi.normalizeSidebarOrder) throw new Error(INVALID_SETTINGS_JSON_MESSAGE);
    if (theme.sidebar_page_visibility !== undefined && (!isPlainObject(theme.sidebar_page_visibility) || Object.keys(theme.sidebar_page_visibility).some((key) => !popupControllerApi.DEFAULT_SIDEBAR_PAGE_ORDER.includes(key) || typeof theme.sidebar_page_visibility[key] !== "boolean"))) throw new Error(INVALID_SETTINGS_JSON_MESSAGE);
    if (theme.customBackgroundLink !== undefined) {
        const safeBackground = validateSafeHttpsUrl(theme.customBackgroundLink, true);
        if (!safeBackground.valid) throw new Error(INVALID_SETTINGS_JSON_MESSAGE);
    }
    if (theme.card_colors !== undefined && !Array.isArray(theme.card_colors)) throw new Error(INVALID_SETTINGS_JSON_MESSAGE);
    return theme;
}

function buildImportedThemeChanges(theme, current) {
    validateImportedTheme(theme);
    const final = {};
    const copyKeys = syncedSwitches.concat(syncedSubOptions).concat([
        "dark_preset", "custom_font", "gpa_calc_bounds", "customCardStyles", "custom_styles",
        "imageSize", "cardRoundness", "cardSpacing", "cardWidth", "cardHeight",
        "customBackgroundLink", "customBackgroundScale", "sidebar_page_order", "sidebar_page_visibility"
    ]);
    copyKeys.forEach((key) => {
        if (theme[key] !== undefined) final[key] = cloneSetting(theme[key]);
    });
    if (theme.custom_cards !== undefined) {
        const cards = cloneSetting(asPlainObject(current.custom_cards));
        let position = 0;
        Object.keys(cards).forEach((courseId) => {
            if (!isPlainObject(cards[courseId])) cards[courseId] = {};
            cards[courseId].img = theme.custom_cards.length ? theme.custom_cards[position] : "";
            position = theme.custom_cards.length ? (position + 1) % theme.custom_cards.length : 0;
        });
        final.custom_cards = cards;
    }
    if (theme.customBackgroundLink !== undefined) {
        const safeBackground = validateSafeHttpsUrl(theme.customBackgroundLink, true);
        final.customBackgroundLink = safeBackground.value;
    }
    if (theme.sidebar_page_order !== undefined) final.sidebar_page_order = popupControllerApi.normalizeSidebarOrder(theme.sidebar_page_order);
    return final;
}

async function capturePreviousTheme() {
    const local = await chrome.storage.local.get(["previous_theme"]);
    if (local.previous_theme !== null && local.previous_theme !== undefined) return;
    const sync = await chrome.storage.sync.get(syncedSwitches.concat(syncedSubOptions).concat(["dark_preset", "custom_cards", "custom_font", "gpa_calc_bounds", "card_colors"]));
    const previous = await getExport(sync, syncedSwitches.concat(syncedSubOptions).concat(["dark_preset", "custom_cards", "custom_font", "gpa_calc_bounds", "card_colors"]));
    await chrome.storage.local.set({ previous_theme: previous });
}

async function restoreImportedThemeSettings(snapshot, keys) {
    if (!popupSettingsStore) throw new Error("SETTINGS_STORE_UNAVAILABLE");
    const changes = {};
    const removals = [];
    keys.forEach((key) => {
        if (Object.prototype.hasOwnProperty.call(snapshot, key)) changes[key] = cloneSetting(snapshot[key]);
        else removals.push(key);
    });
    if (Object.keys(changes).length) await popupSettingsStore.transaction(changes, { read: async () => cloneSetting(snapshot) });
    if (removals.length) await popupSettingsStore.reset(removals, { read: async () => cloneSetting(snapshot) });
    keys.forEach((key) => {
        if (Object.prototype.hasOwnProperty.call(snapshot, key)) knownSyncValues[key] = cloneSetting(snapshot[key]);
        else delete knownSyncValues[key];
    });
    return { ok: true };
}

async function sendToCanvasSourceStrict(source, message, options = {}) {
    if (source?.state || !Number.isInteger(source?.tabId) || !chrome.tabs?.sendMessage) throw new Error(source?.code || "SOURCE_TAB_UNAVAILABLE");
    const result = await chrome.tabs.sendMessage(source.tabId, { message, options });
    if (message === "getcolors") {
        if (!popupControllerApi.validateCardColors(result)) throw new Error("CANVAS_COLORS_RESPONSE_INVALID");
    } else if (result !== true && (!isPlainObject(result) || result.ok !== true)) {
        throw new Error(result?.code || "CANVAS_MESSAGE_FAILED");
    }
    return result;
}

async function importTheme(theme) {
    try {
        validateImportedTheme(theme);
    } catch (error) {
        displayAlert(true, INVALID_SETTINGS_JSON_MESSAGE);
        throw error;
    }
    try {
        await flushPendingWrites();
        await capturePreviousTheme();
        const current = await storageAreaCall("sync", "get", null);
        if (!isPlainObject(current)) throw new Error("THEME_SETTINGS_SNAPSHOT_FAILED");
        const changes = buildImportedThemeChanges(theme, current);
        const expanded = expandAliases(changes);
        const keys = Object.keys(expanded);
        const settingsSnapshot = Object.fromEntries(keys.filter((key) => Object.prototype.hasOwnProperty.call(current, key)).map((key) => [key, cloneSetting(current[key])]));
        const source = await resolvePopupSourceTab();
        const hasCanvas = !source.state && Number.isInteger(source.tabId);
        const result = await window.APStudyCanvasPopupController.runThemeImportTransaction({
            settingsChanges: expanded,
            cardColors: theme.card_colors,
            hasCanvas,
            readSettings: async () => cloneSetting(settingsSnapshot),
            writeSettings: (next) => popupSettingsStore.transaction(next, { read: async () => cloneSetting(settingsSnapshot) }),
            restoreSettings: (snapshot) => restoreImportedThemeSettings(snapshot, keys),
            readCanvasColors: () => sendToCanvasSourceStrict(source, "getcolors"),
            writeCanvasColors: (colors) => sendToCanvasSourceStrict(source, "setcolors", colors),
            readQueuedColors: async () => {
                const local = await storageAreaCall("local", "get", [pendingCardColorsKey]);
                return Object.prototype.hasOwnProperty.call(local, pendingCardColorsKey)
                    ? { present: true, value: cloneSetting(local[pendingCardColorsKey]) }
                    : { present: false };
            },
            queueCanvasColors: async (colors) => {
                await storageAreaCall("local", "set", { [pendingCardColorsKey]: cloneSetting(colors) });
                return { ok: true };
            },
            restoreQueuedColors: async (snapshot) => {
                if (snapshot?.present) await storageAreaCall("local", "set", { [pendingCardColorsKey]: cloneSetting(snapshot.value) });
                else await storageAreaCall("local", "remove", [pendingCardColorsKey]);
                return { ok: true };
            }
        });
        if (changes.dark_preset) refreshColors();
        if (changes.gpa_calc_bounds) displayGPABounds();
        displayAlert(false, result.canvasColorsQueued ? "Settings imported. Canvas colors are queued for the next Canvas load." : "Settings imported.");
        return changes;
    } catch (error) {
        const message = error.message === INVALID_SETTINGS_JSON_MESSAGE ? INVALID_SETTINGS_JSON_MESSAGE : SETTINGS_SAVE_FAILURE_MESSAGE;
        displayAlert(true, message);
        throw error;
    }
}

async function applyQueuedCardColors() {
    const local = await storageAreaCall("local", "get", [pendingCardColorsKey]);
    const colors = local[pendingCardColorsKey];
    if (!Array.isArray(colors)) return false;
    const source = await resolvePopupSourceTab();
    if (source.state || !Number.isInteger(source.tabId)) return false;
    await sendToCanvasSourceStrict(source, "setcolors", colors);
    await storageAreaCall("local", "remove", [pendingCardColorsKey]);
    setSaveStatus("Queued Canvas colors applied.");
    return true;
}

function displayCustomFont() {
    chrome.storage.sync.get(["custom_font"], storage => {
        let el = document.querySelector(".custom-font");
        if (!el) return;
        const customFont = isPlainObject(storage.custom_font) ? storage.custom_font : cloneSetting(defaultOptions.sync.custom_font);
        let linkContainer = document.querySelector(".custom-font-flex") || makeElement("div", el, {"className": "custom-font-flex"});
        linkContainer.innerHTML = '<span>https://fonts.googleapis.com/css2?family=</span><input class="card-input" id="custom-font-link"></input>';
        let link = linkContainer.querySelector("#custom-font-link");
        link.value = customFont.link;

        link.addEventListener("change", function (e) {
            let linkVal = e.target.value.split(":")[0];
            let familyVal = linkVal.replace("+", " ");
            linkVal += linkVal === "" ? "" : ":wght@400;700";
            familyVal = linkVal === "" ? "" : "'" + familyVal + "'";
            queueSettingWrite({ custom_font: { link: linkVal, family: familyVal } }, "custom-font");
            link.value = linkVal;
        });

        const popularFonts = ["Arimo", "Barriecito", "Barlow", "Caveat", "Cinzel", "Comfortaa", "Corben", "DM Sans", "Expletus Sans", "Gluten", "Happy Monkey", "Inconsolata", "Inria Sans", "Jost", "Kanit", "Karla", "Kode Mono", "Lobster", "Lora", "Madimi One", "Mali", "Montserrat", "Nanum Myeongjo", "Open Sans", "Oswald", "Permanent Marker", "Playfair Display", "Poetsen One", "Poppins", "Quicksand", "Rakkas", "Redacted Script", "Roboto Mono", "Rubik", "Silkscreen", "Sixtyfour", "Syne Mono", "Tektur", "Texturina", "Ysabeau Infant", "Yuji Syuku"];
        let quickFonts = document.querySelector("#quick-fonts");
        quickFonts.textContent = "";
        let noFont = makeElement("button", quickFonts, { "className": "customization-button", "textContent": "None" });
        noFont.addEventListener("click", () => {
            queueSettingWrite({ custom_font: { link: "", family: "" } }, "custom-font");
            link.value = "";
        })
        popularFonts.forEach(font => {
            let btn = makeElement("button", quickFonts, { "className":"customization-button", "textContent": font });
            btn.addEventListener("click", () => {
                let linkVal = font.replace(" ", "+") + ":wght@400;700";
                queueSettingWrite({ custom_font: { link: linkVal, family: "'" + font + "'" } }, "custom-font");
                link.value = linkVal;
            });
        });
    });
}

function displayGPABounds() {
    chrome.storage.sync.get(["gpa_calc_bounds"], storage => {
        const order = ["A+", "A", "A-", "B+", "B", "B-", "C+", "C", "C-", "D+", "D", "D-", "F"];
        const el = document.querySelector(".gpa-bounds");
        if (!el) return;
        const bounds = isPlainObject(storage.gpa_calc_bounds) ? storage.gpa_calc_bounds : cloneSetting(defaultOptions.sync.gpa_calc_bounds);
        el.textContent = "";
        order.forEach(key => {
            let inputs = makeElement("div", el, { "className": "gpa-bounds-item" });
            inputs.innerHTML += '<div><span class="gpa-bounds-grade"></span><input class="gpa-bounds-input gpa-bounds-cutoff" type="text"></input><span style="margin-left:6px;margin-right:6px;">%</span><input class="gpa-bounds-input gpa-bounds-gpa" type="text" value=></input><span style="margin-left:6px">GPA</span></div>';
            inputs.querySelector(".gpa-bounds-grade").textContent = key;
            inputs.querySelector(".gpa-bounds-cutoff").value = bounds[key].cutoff;
            inputs.querySelector(".gpa-bounds-gpa").value = bounds[key].gpa;

            inputs.querySelector(".gpa-bounds-cutoff").addEventListener("change", function (e) {
                const value = parseFloat(e.target.value);
                runExplicitTransaction(
                    () => chrome.storage.sync.get(["gpa_calc_bounds"]),
                    () => Number.isFinite(value) && value >= 0 && value <= 101,
                    (existing) => ({ gpa_calc_bounds: { ...existing.gpa_calc_bounds, [key]: { ...existing.gpa_calc_bounds[key], cutoff: value } } })
                ).catch(() => displayGPABounds());
            });

            inputs.querySelector(".gpa-bounds-gpa").addEventListener("change", function (e) {
                const value = parseFloat(e.target.value);
                runExplicitTransaction(
                    () => chrome.storage.sync.get(["gpa_calc_bounds"]),
                    () => Number.isFinite(value) && value >= 0 && value <= 5,
                    (existing) => ({ gpa_calc_bounds: { ...existing.gpa_calc_bounds, [key]: { ...existing.gpa_calc_bounds[key], gpa: value } } })
                ).catch(() => displayGPABounds());
            });
        });
    });
}

let removeAlert = null;

function clearAlert() {
    clearTimeout(removeAlert);
    document.querySelector("#alert").style.bottom = "-400px";
}

function displayAlert(bad, msg) {
    clearTimeout(removeAlert);
    document.querySelector("#alert").style.bottom = "0";
    document.querySelector("#alert").textContent = msg;
    document.querySelector("#alert").style.background = bad ? "#e7495ed9" : "#468b46d9";
    removeAlert = setTimeout(() => {
        clearAlert();
    }, 15000);
}


let activeCourseCard = null;
let courseCardSaveQueue = Promise.resolve();

function postWorkspaceStatus(message, error = false) {
    if (window.parent !== window) {
        window.parent.postMessage({ type: "apstudycanvas-status", message, error }, window.location.origin);
    }
}

function setEditorStatus(message, error = false) {
    const status = document.getElementById("card-editor-status");
    if (status) {
        status.textContent = message;
        status.classList.toggle("is-error", error);
    }
    postWorkspaceStatus(message, error);
}

function validateCourseImage(value) {
    const candidate = typeof value === "string" ? value.trim() : "";
    if (!candidate || candidate.toLowerCase() === "none") return { valid: true, value: candidate.toLowerCase() === "none" ? "none" : "" };
    try {
        const url = new URL(candidate);
        if (url.protocol !== "http:" && url.protocol !== "https:") return { valid: false, value: candidate };
        return { valid: true, value: url.href };
    } catch (error) {
        return { valid: false, value: candidate };
    }
}

function createEditorNode(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function renderCourseImagePreview(value) {
    const preview = document.getElementById("card-image-preview");
    if (!preview) return;
    preview.replaceChildren();
    preview.classList.remove("has-image");
    const result = validateCourseImage(value);
    if (!result.valid) {
        preview.appendChild(createEditorNode("span", "", "Use an http(s) image URL, or leave this blank."));
        return;
    }
    if (!result.value || result.value === "none") {
        preview.appendChild(createEditorNode("span", "", result.value === "none" ? "Canvas image will be hidden." : "No custom image"));
        return;
    }
    const image = createEditorNode("img");
    image.alt = "Live course card image preview";
    image.addEventListener("error", () => {
        preview.replaceChildren(createEditorNode("span", "", "Image preview unavailable"));
        preview.classList.remove("has-image");
    }, { once: true });
    image.src = result.value;
    preview.appendChild(image);
    preview.classList.add("has-image");
}

function renderCourseLivePreview(courseData) {
    const nameInput = document.getElementById("card-name-input");
    const codeInput = document.getElementById("card-code-input");
    const imageInput = document.getElementById("card-image-input");
    const name = nameInput?.value || courseData?.name || courseData?.default || "Untitled course";
    const code = codeInput?.value || courseData?.code || courseData?.default || "Canvas course";
    const preview = document.getElementById("card-live-preview");
    if (!preview) return;
    const previewName = preview.querySelector(".card-live-preview-name");
    const previewCode = preview.querySelector(".card-live-preview-code");
    if (previewName) previewName.textContent = name;
    if (previewCode) previewCode.textContent = code;
    const media = preview.querySelector(".card-live-preview-media");
    if (!media) return;
    media.replaceChildren();
    const result = validateCourseImage(imageInput?.value || courseData?.img || "");
    if (result.valid && result.value && result.value !== "none") {
        const image = createEditorNode("img");
        image.alt = "Course card preview image";
        image.addEventListener("error", () => {
            media.replaceChildren(createEditorNode("span", "", "Course image preview unavailable"));
        }, { once: true });
        image.src = result.value;
        media.appendChild(image);
    } else {
        media.appendChild(createEditorNode("span", "", result.valid ? "APStudyCanvas course card" : "Preview needs an http(s) image URL"));
    }
}

function enqueueCourseCardSave(operation) {
    const queuedSave = courseCardSaveQueue.then(operation, operation);
    courseCardSaveQueue = queuedSave.catch(() => {});
    return queuedSave;
}

function persistCourseCard(courseId, updates, successMessage) {
    const fallback = { ...asPlainObject(activeCourseCard) };
    const safeUpdates = { ...asPlainObject(updates) };
    return enqueueCourseCardSave(async () => {
        const nextCourseRef = {};
        await runExplicitTransaction(
            () => chrome.storage.sync.get(["custom_cards"]),
            (next) => isPlainObject(next.custom_cards),
            (storage) => {
                const customCards = asPlainObject(storage.custom_cards);
                const existing = asPlainObject(customCards[courseId]);
                const nextCourse = { ...existing };
                ["default", "eid", "weight", "credits", "gr"].forEach((key) => {
                    if (nextCourse[key] === undefined && fallback[key] !== undefined) nextCourse[key] = fallback[key];
                });
                Object.assign(nextCourse, safeUpdates);
                nextCourseRef.value = nextCourse;
                return { custom_cards: { ...customCards, [courseId]: nextCourse } };
            }
        );
        setEditorStatus(successMessage);
        return nextCourseRef.value;
    });
}

async function displayAdvancedCards() {
    const cardGrid = document.getElementById("card-grid");
    if (!cardGrid) return;
    setEditorStatus("Loading configured Canvas courses…");
    sendFromPopup("getCards").catch(() => {});
    try {
        const storage = await chrome.storage.sync.get(["custom_cards", "custom_cards_2", "custom_cards_3"]);
        const customCards = asPlainObject(storage.custom_cards);
        const customCards2 = asPlainObject(storage.custom_cards_2);
        const customCards3 = asPlainObject(storage.custom_cards_3);
        const courseIds = new Set([...Object.keys(customCards), ...Object.keys(customCards2), ...Object.keys(customCards3)]);
        const allCards = {};
        courseIds.forEach((courseId) => {
            allCards[courseId] = {
                ...asPlainObject(customCards[courseId]),
                ...asPlainObject(customCards2[courseId]),
                ...asPlainObject(customCards3[courseId])
            };
        });
        cardGrid.replaceChildren();
        const courseIdsWithData = Object.keys(allCards).filter((courseId) => isPlainObject(allCards[courseId]));
        if (courseIdsWithData.length === 0) {
            const empty = createEditorNode("div", "card-editor-empty");
            empty.appendChild(createEditorNode("strong", "", "No Canvas courses found yet."));
            empty.appendChild(createEditorNode("p", "", "Open your Canvas dashboard and refresh it once so APStudyCanvas can load your configured courses. If Canvas is not connected, check your Canvas URL under Appearance."));
            cardGrid.appendChild(empty);
            setEditorStatus("No Canvas courses are configured yet.");
            return;
        }
        courseIdsWithData.sort((a, b) => String(allCards[b].default || b).localeCompare(String(allCards[a].default || a)));
        courseIdsWithData.forEach((courseId) => cardGrid.appendChild(createCourseButton(courseId, allCards[courseId])));
        setEditorStatus("Select a course to edit its card.");
    } catch (error) {
        cardGrid.replaceChildren();
        const empty = createEditorNode("div", "card-editor-empty", "We could not read your saved course cards. Try reopening Edit Canvas or refreshing your Canvas dashboard.");
        cardGrid.appendChild(empty);
        setEditorStatus("Course cards could not be loaded.", true);
    }
}

function createCourseButton(courseId, courseData) {
    const button = createEditorNode("button", "course-card-button", courseData.name || courseData.default || courseData.code || `Course ${courseId}`);
    button.type = "button";
    button.dataset.courseId = courseId;
    if (courseData.img || courseData.hidden === true || courseData.hide === true) button.classList.add("customized");
    button.addEventListener("click", () => {
        document.querySelectorAll(".course-card-button").forEach((item) => item.classList.remove("active"));
        button.classList.add("active");
        showCardEditMenu(courseId, courseData);
    });
    return button;
}

function showCardEditMenu(courseId, courseData) {
    const editMenu = document.getElementById("card-edit-menu");
    const cardGrid = document.getElementById("card-grid");
    if (!editMenu || !cardGrid) return;
    const safeCourseData = asPlainObject(courseData);
    activeCourseCard = { ...safeCourseData };
    cardGrid.style.display = "none";
    editMenu.style.display = "block";
    editMenu.replaceChildren();

    const displayName = safeCourseData.name || safeCourseData.default || safeCourseData.code || `Course ${courseId}`;
    const header = createEditorNode("div", "card-edit-header");
    const headerCopy = createEditorNode("div");
    headerCopy.appendChild(createEditorNode("h3", "card-edit-title", displayName));
    headerCopy.appendChild(createEditorNode("p", "card-edit-subtitle", `Course ID ${courseId} · changes save together`));
    const closeButton = createEditorNode("button", "big-button card-close-btn", "Cancel");
    closeButton.type = "button";
    closeButton.addEventListener("click", hideCardEditMenu);
    header.append(headerCopy, closeButton);
    editMenu.appendChild(header);

    const nameSection = createEditorNode("div", "card-edit-section");
    const nameLabel = createEditorNode("label", "card-edit-label", "Course name");
    nameLabel.htmlFor = "card-name-input";
    const nameInput = createEditorNode("input", "card-input");
    nameInput.type = "text";
    nameInput.id = "card-name-input";
    nameInput.placeholder = "Use the Canvas course name";
    nameInput.value = safeCourseData.name || "";
    nameSection.append(nameLabel, nameInput);

    const codeSection = createEditorNode("div", "card-edit-section");
    const codeLabel = createEditorNode("label", "card-edit-label", "Course code");
    codeLabel.htmlFor = "card-code-input";
    const codeInput = createEditorNode("input", "card-input");
    codeInput.type = "text";
    codeInput.id = "card-code-input";
    codeInput.placeholder = "Use the Canvas course code";
    codeInput.value = safeCourseData.code || "";
    codeSection.append(codeLabel, codeInput);

    const imageSection = createEditorNode("div", "card-edit-section");
    const imageLabel = createEditorNode("label", "card-edit-label", "Card image URL");
    imageLabel.htmlFor = "card-image-input";
    const imageInput = createEditorNode("input", "card-input");
    imageInput.type = "url";
    imageInput.id = "card-image-input";
    imageInput.placeholder = "https://… or none";
    imageInput.value = safeCourseData.img || "";
    imageInput.setAttribute("aria-describedby", "card-image-help");
    const imageHelp = createEditorNode("p", "card-edit-help", "Only http(s) image URLs are stored. Image files and base64 data are not stored.");
    imageHelp.id = "card-image-help";
    const imagePreview = createEditorNode("div", "card-image-preview");
    imagePreview.id = "card-image-preview";
    imageSection.append(imageLabel, imageInput, imageHelp, imagePreview);

    const visibilitySection = createEditorNode("label", "card-edit-section custom-card-hide");
    const hideInput = createEditorNode("input");
    hideInput.type = "checkbox";
    hideInput.id = "card-hide-input";
    hideInput.checked = safeCourseData.hidden === true || safeCourseData.hide === true;
    const hideCopy = createEditorNode("span", "card-edit-label", "Hide this card on the Canvas dashboard");
    visibilitySection.append(hideInput, hideCopy);

    const livePreview = createEditorNode("section", "card-live-preview");
    livePreview.id = "card-live-preview";
    livePreview.setAttribute("aria-label", "Live course card preview");
    const liveMedia = createEditorNode("div", "card-live-preview-media");
    const liveCopy = createEditorNode("div", "card-live-preview-copy");
    liveCopy.append(createEditorNode("div", "card-live-preview-name"), createEditorNode("div", "card-live-preview-code"));
    livePreview.append(liveMedia, liveCopy);

    const actions = createEditorNode("div", "card-edit-actions");
    const saveButton = createEditorNode("button", "big-button", "Save changes");
    saveButton.type = "button";
    const resetButton = createEditorNode("button", "customization-button", "Reset to default");
    resetButton.type = "button";
    actions.append(saveButton, resetButton);
    editMenu.append(nameSection, codeSection, imageSection, visibilitySection, livePreview, actions);

    const updatePreview = () => {
        renderCourseImagePreview(imageInput.value);
        renderCourseLivePreview(safeCourseData);
        const validation = validateCourseImage(imageInput.value);
        if (!validation.valid) setEditorStatus("Use an http(s) image URL, or leave the image blank.", true);
        else setEditorStatus("Unsaved course card changes.");
    };
    [nameInput, codeInput, imageInput, hideInput].forEach((input) => input.addEventListener("input", updatePreview));
    saveButton.addEventListener("click", () => saveCardChanges(courseId));
    resetButton.addEventListener("click", () => resetCardToDefault(courseId));
    updatePreview();
}

function updateImagePreview() {
    const input = document.getElementById("card-image-input");
    if (input) renderCourseImagePreview(input.value);
}

async function saveCardChanges(courseId) {
    const nameInput = document.getElementById("card-name-input");
    const codeInput = document.getElementById("card-code-input");
    const imageInput = document.getElementById("card-image-input");
    const hideInput = document.getElementById("card-hide-input");
    if (!nameInput || !codeInput || !imageInput || !hideInput) return;
    const image = validateCourseImage(imageInput.value);
    if (!image.valid) {
        setEditorStatus("Use an http(s) image URL, or leave the image blank.", true);
        imageInput.focus();
        return;
    }
    try {
        await persistCourseCard(courseId, {
            name: nameInput.value.trim(),
            code: codeInput.value.trim(),
            img: image.value,
            hidden: hideInput.checked,
            hide: hideInput.checked
        }, "Course card saved.");
        hideCardEditMenu();
        await displayAdvancedCards();
    } catch (error) {
        setEditorStatus("Course card could not be saved. Your changes are still on this screen.", true);
    }
}

async function resetCardToDefault(courseId) {
    if (!window.confirm("Reset this course card to its Canvas defaults?")) return;
    try {
        await persistCourseCard(courseId, { name: "", code: "", img: "", hidden: false, hide: false }, "Course card reset to Canvas defaults.");
        hideCardEditMenu();
        await displayAdvancedCards();
    } catch (error) {
        setEditorStatus("Course card could not be reset.", true);
    }
}

function hideCardEditMenu() {
    const editMenu = document.getElementById("card-edit-menu");
    const cardGrid = document.getElementById("card-grid");
    if (editMenu) {
        editMenu.style.display = "none";
        editMenu.replaceChildren();
    }
    if (cardGrid) cardGrid.style.display = "grid";
    document.querySelectorAll(".course-card-button").forEach((button) => button.classList.remove("active"));
    activeCourseCard = null;
}

function toggleDarkModeDisable(disabled) {
    let darkSwitch = document.querySelector('#dark_mode');
    if (disabled === true) {
        darkSwitch.classList.add('switch_disabled');
        darkSwitch.style.pointerEvents = "none";
    } else {
        darkSwitch.classList.remove('switch_disabled');
        darkSwitch.style.pointerEvents = "auto";
    }
}

// customization tab

function getPalette(name) {
    const colors = {
        "Blues": ["#ade8f4", "#90e0ef", "#48cae4", "#00b4d8", "#0096c7"],
        "Reds": ["#e01e37", "#c71f37", "#b21e35", "#a11d33", "#6e1423"],
        "Rainbow": ["#ff0000", "#ff5200", "#efea5a", "#3cf525", "#147df5", "#be0aff"],
        "Candy": ["#cdb4db", "#ffc8dd", "#ffafcc", "#bde0fe", "#a2d2ff"],
        "Purples": ["#e0aaff", "#c77dff", "#9d4edd", "#7b2cbf", "#5a189a"],
        "Pastels": ["#fff1e6", "#fde2e4", "#fad2e1", "#bee1e6", "#cddafd"],
        "Ocean": ["#22577a", "#38a3a5", "#57cc99", "#80ed99", "#c7f9cc"],
        "Sunset": ["#eaac8b", "#e56b6f", "#b56576", "#6d597a", "#355070"],
        "Army": ["#6b705c", "#a5a58d", "#b7b7a4", "#ffe8d6", "#ddbea9", "#cb997e"],
        "Pinks": ["#ff0a54", "#ff5c8a", "#ff85a1", "#ff99ac", "#fbb1bd"],
        "Watermelon": ["#386641", "#6a994e", "#a7c957", "#f2e8cf", "#bc4749"],
        "Popsicle": ["#70d6ff", "#ff70a6", "#ff9770", "#ffd670", "#e9ff70"],
        "Chess": ["#ffffff", "#000000"],
        "Greens": ["#d8f3dc", "#b7e4c7", "#95d5b2", "#74c69d", "#52b788"],
        "Fade": ["#ff69eb", "#ff86c8", "#ffa3a5", "#ffbf81", "#ffdc5e"],
        "Oranges": ["#ffc971", "#ffb627", "#ff9505", "#e2711d", "#cc5803"],
        "Mesa": ["#f6bd60", "#f28482", "#f5cac3", "#84a59d", "#f7ede2"],
        "Berries": ["#4cc9f0", "#4361ee", "#713aed", "#9348c3", "#f72585"],
        "Fade2": ["#f2f230", "#C2F261", "#91f291", "#61F2C2", "#30f2f2"],
        "Muted": ["#E7E6F7", "#E3D0D8", "#AEA3B0", "#827081", "#C6D2ED"],
        "Base": ["#e3b505", "#95190C", "#610345", "#107E7D", "#044B7F"],
        "Fruit": ["#7DDF64", "#C0DF85", "#DEB986", "#DB6C79", "#ED4D6E"],
        "Night": ["#25171A", "#4B244A", "#533A7B", "#6969B3", "#7F86C6"]
    }
    return colors[name] || [];
}

function componentToHex(c) {
    var hex = c.toString(16);
    return hex.length == 1 ? "0" + hex : hex;
}

function getColorInGradient(d, from, to) {
    let pat = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i;
    var exec1 = pat.exec(from);
    var exec2 = pat.exec(to);
    let a1 = [parseInt(exec1[1], 16), parseInt(exec1[2], 16), parseInt(exec1[3], 16)];
    let a2 = [parseInt(exec2[1], 16), parseInt(exec2[2], 16), parseInt(exec2[3], 16)];
    let rgb = a1.map((x, i) => Math.floor(a1[i] + d * (a2[i] - a1[i])));
    return "#" + componentToHex(rgb[0]) + componentToHex(rgb[1]) + componentToHex(rgb[2]);
}

function displaySidebarMode(mode, style) {
    style = style.replace(" ", "");
    let match = style.match(/linear-gradient\((?<color1>\#\w*),(?<color2>\#\w*)\)/);
    let c1 = c2 = "#000000";

    if (mode === "image") {
        document.querySelector("#radio-sidebar-image").checked = true;
        document.querySelector("#sidebar-color2").style.display = "flex";
        document.querySelector("#sidebar-image").style.display = "flex";
        if (style.includes("url") && match) {
            if (match.groups.color1) c1 = match.groups.color1.replace("c7", "");
            if (match.groups.color2) c2 = match.groups.color2.replace("c7", "");
        }
        let url = style.match(/url\(\"(?<url>.*)\"\)/);
        document.querySelector('#sidebar-image input[type="text"]').value = url && url.groups.url ? url.groups.url : "";
    } else if (mode === "gradient") {
        document.querySelector("#radio-sidebar-gradient").checked = true;
        document.querySelector("#sidebar-color2").style.display = "flex";
        document.querySelector("#sidebar-image").style.display = "none";
        if (!style.includes("url") && match) {
            if (match.groups.color1) c1 = match.groups.color1;
            if (match.groups.color2) c2 = match.groups.color2;
        }
    } else {
        document.querySelector("#radio-sidebar-solid").checked = true;
        document.querySelector("#sidebar-color2").style.display = "none";
        document.querySelector("#sidebar-image").style.display = "none";
        c1 = match ? "#000000" : style;
    }

    document.querySelector('#sidebar-color1 input[type="text"]').value = c1;
    document.querySelector('#sidebar-color1 input[type="color"]').value = c1;
    document.querySelector('#sidebar-color2 input[type="text"]').value = c2;
    document.querySelector('#sidebar-color2 input[type="color"]').value = c2;
}

let presetChangeTimeout = null;

chrome.storage.sync.get(["dark_preset"], storage => {
    let tab = document.querySelector(".customize-dark");
    if (!tab) return;
    const preset = isPlainObject(storage["dark_preset"]) ? storage["dark_preset"] : cloneSetting(defaultOptions.sync.dark_preset);
    Object.keys(preset).forEach(key => {
        if (key !== "sidebar") {
            let c = tab.querySelector("#dp_" + key);
            if (!c) return;
            let color = c.querySelector('input[type="color"]');
            let text = c.querySelector('input[type="text"]');
            if (!color || !text) return;
            [color, text].forEach(changer => {
                changer.value = preset[key];
                changer.addEventListener("input", function (e) {
                    clearTimeout(presetChangeTimeout);
                    presetChangeTimeout = setTimeout(() => changeCSS(key, e.target.value), 200);
                });
            });
        } else {
            let mode = preset[key].includes("url") ? "image" : preset[key].includes("gradient") ? "gradient" : "solid";
            displaySidebarMode(mode, preset[key]);
            let changeSidebar = () => {
                let c1 = tab.querySelector('#sidebar-color1 input[type="text"]').value.replace("c7", "");
                let c2 = tab.querySelector('#sidebar-color2 input[type="text"]').value.replace("c7", "");
                let url = tab.querySelector('#sidebar-image input[type="text"]').value;
                if (tab.querySelector("#radio-sidebar-image").checked) {
                    changeCSS(key, `linear-gradient(${c1}c7, ${c2}c7), center url("${url}")`);
                } else if (tab.querySelector("#radio-sidebar-gradient").checked) {
                    changeCSS(key, `linear-gradient(${c1}, ${c2})`);
                } else {
                    changeCSS(key, c1);
                }
            }
            ["#sidebar-color1", "#sidebar-color2"].forEach(group => {
                ['input[type="text"]', 'input[type="color"]'].forEach(input => {
                    document.querySelector(group + " " + input).addEventListener("input", e => {
                        ['input[type="text"]', 'input[type="color"]'].forEach(i => {
                            document.querySelector(group + " " + i).value = e.target.value;
                        });
                        clearTimeout(presetChangeTimeout);
                        presetChangeTimeout = setTimeout(() => changeSidebar(), 200);
                    });
                });
            });
            document.querySelector('#sidebar-image input[type="text"]').addEventListener("change", () => changeSidebar());
        }
    });
});

function refreshColors() {
    chrome.storage.sync.get(["dark_preset"], storage => {
        Object.keys(storage["dark_preset"]).forEach(key => {
            let c = document.querySelector("#dp_" + key);
            let color = c.querySelector('input[type="color"]');
            let text = c.querySelector('input[type="text"]');
            color.value = storage["dark_preset"][key];
            text.value = storage["dark_preset"][key];
        });
        let mode = storage["dark_preset"]["sidebar"].includes("url") ? "image" : storage["dark_preset"]["sidebar"].includes("gradient") ? "gradient" : "solid";
        displaySidebarMode(mode, storage["dark_preset"]["sidebar"]);
    });
}

function changeCSS(name, color) {
    chrome.storage.sync.get("dark_preset").then((storage) => {
        const preset = { ...asPlainObject(storage.dark_preset), [name]: color };
        if (!isSafeDarkPreset(preset)) return;
        queueSettingWrite({ dark_preset: preset }, "theme-preview").then(() => refreshColors()).catch(() => {});
    }).catch(() => {});
}

function changeToPresetCSS(e, preset = null) {
    const presets = {
        "dark-lighter": { "background-0": "#272727", "background-1": "#353535", "background-2": "#404040", "borders": "#454545", "sidebar": "#353535", "text-0": "#f5f5f5", "text-1": "#e2e2e2", "text-2": "#ababab", "links": "#56Caf0", "sidebar-text": "#f5f5f5" },
        "dark-light": { "background-0": "#202020", "background-1": "#2e2e2e", "background-2": "#4e4e4e", "borders": "#404040", "sidebar": "#2e2e2e", "text-0": "#f5f5f5", "text-1": "#e2e2e2", "text-2": "#ababab", "links": "#56Caf0", "sidebar-text": "#f5f5f5" },
        "dark-default": { "background-0": "#161616", "background-1": "#1e1e1e", "background-2": "#262626", "borders": "#3c3c3c", "text-0": "#f5f5f5", "text-1": "#e2e2e2", "text-2": "#ababab", "links": "#56Caf0", "sidebar": "#1e1e1e", "sidebar-text": "#f5f5f5" },
        "dark-dark": { "background-0": "#101010", "background-1": "#121212", "background-2": "#1a1a1a", "borders": "#272727", "sidebar": "#121212", "text-0": "#f5f5f5", "text-1": "#e2e2e2", "text-2": "#ababab", "links": "#56Caf0", "sidebar-text": "#f5f5f5" },
        "dark-darker": { "background-0": "#000000", "background-1": "#000000", "background-2": "#000000", "borders": "#000000", "sidebar": "#000000", "text-0": "#c5c5c5", "text-1": "#c5c5c5", "text-2": "#c5c5c5", "links": "#c5c5c5", "sidebar-text": "#c5c5c5" },
        "dark-blue": { "background-0": "#14181d", "background-1": "#1a2026", "background-2": "#212930", "borders": "#2e3943", "sidebar": "#1a2026", "text-0": "#f5f5f5", "text-1": "#e2e2e2", "text-2": "#ababab", "links": "#56Caf0", "sidebar-text": "#f5f5f5" },
        "dark-mint": { "background-0": "#0f0f0f", "background-1": "#0c0c0c", "background-2": "#141414", "borders": "#1e1e1e", "sidebar": "#0c0c0c", "text-0": "#f5f5f5", "text-1": "#e2e2e2", "text-2": "#ababab", "links": "#7CF3CB", "sidebar-text": "#f5f5f5" },
        "dark-burn": { "background-0": "#ffffff", "background-1": "#ffffff", "background-2": "#ffffff", "borders": "#cccccc", "sidebar": "#ffffff", "text-0": "#cccccc", "text-1": "#cccccc", "text-2": "#cccccc", "links": "#cccccc", "sidebar-text": "#cccccc" },
        "dark-unicorn": { "background-0": "#ff6090", "background-1": "#00C1FF", "background-2": "#FFFF00", "borders": "#FFFF00", "sidebar": "#00C1FF", "text-0": "#ffffff", "text-1": "#ffffff", "text-2": "#ffffff", "links": "#000000", "sidebar-text": "#ffffff" },
        "dark-lightmode": { "background-0": "#ffffff", "background-1": "#f5f5f5", "background-2": "#d4d4d4", "borders": "#c7cdd1", "links": "#04ff00", "sidebar": "#04ff00", "sidebar-text": "#ffffff", "text-0": "#2d3b45", "text-1": "#919191", "text-2": "#a5a5a5" },
        "dark-catppuccin": { "background-0": "#11111b", "background-1": "#181825", "background-2": "#1e1e2e", "borders": "#4f5463", "text-0": "#cdd6f4", "text-1": "#7f849c", "text-2": "#a6e3a1", "links": "#f5c2e7", "sidebar": "#181825", "sidebar-text": "#7f849c" },
        "dark-sage": { "background-0": "#2f3e46", "background-1": "#354f52", "background-2": "#52796f", "borders": "#84a98c", "links": "#d8f5c7", "sidebar": "#354f52", "sidebar-text": "#e2e8de", "text-0": "#e2e8de", "text-1": "#cad2c5", "text-2": "#adb1aa" },
        "dark-pink": { "background-0": "#ffffff", "background-1": "#ffe0ed", "background-2": "#ff0066", "borders": "#ff007b", "links": "#ff0088", "sidebar": "#f490b3", "sidebar-text": "#ffffff", "text-0": "#ff0095", "text-1": "#ff8f8f", "text-2": "#ff5c5c" },
        "dark-coral": {"background-0":"#131c26","background-1":"#0e1721","background-2":"#151c24","borders":"#0e1721","links":"#f88379","sidebar":"#131c26","sidebar-text":"#f88379","text-0":"#f88379","text-1":"#f88379","text-2":"#f88379"},
    }
    if (preset === null) preset = presets[e.target.id] || presets["default"];
    applyPreset(preset);
}

function applyPreset(preset) {
    runExplicitTransaction(
        () => chrome.storage.sync.get(["dark_preset"]),
        (next) => isSafeDarkPreset(next.dark_preset),
        { dark_preset: cloneSetting(preset) }
    ).then(() => refreshColors()).catch(() => {});
}

function makeElement(element, location, options) {
    let creation = document.createElement(element);
    Object.keys(options).forEach(key => {
        creation[key] = options[key];
    });
    location.appendChild(creation);
    return creation
}

async function sendFromPopup(message, options = {}) {
    const source = await resolvePopupSourceTab();
    if (source.state || !Number.isInteger(source.tabId) || !chrome.tabs?.sendMessage) return null;
    try {
        return await chrome.tabs.sendMessage(source.tabId, { message, options });
    } catch (error) {
        return null;
    }
}
