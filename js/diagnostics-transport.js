(() => {
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

function expandedRouteIsHosted() {
    try {
        const params = new URLSearchParams(globalThis.location?.search || "");
        return params.get("fullscreen") === "1" || params.get("embedded") === "1";
    } catch (error) {
        return false;
    }
}

function expandedRouteSourceTabId() {
    try {
        const params = new URLSearchParams(globalThis.location?.search || "");
        const values = params.getAll("sourceCanvasTabId");
        if (!expandedRouteIsHosted() || values.length !== 1 || !/^[1-9]\d*$/.test(values[0])) return null;
        const tabId = Number(values[0]);
        return Number.isSafeInteger(tabId) && tabId > 0 ? tabId : null;
    } catch (error) {
        return null;
    }
}

function embeddedRouteCanResolveSource() {
    try {
        const params = new URLSearchParams(globalThis.location?.search || "");
        const sessions = params.getAll("overlaySession");
        return params.get("embedded") === "1"
            && params.get("fullscreen") !== "1"
            && !params.has("sourceCanvasTabId")
            && sessions.length === 1
            && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(sessions[0]);
    } catch (error) {
        return false;
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
    const hosted = expandedRouteIsHosted();
    const urlSourceTabId = expandedRouteSourceTabId();
    if (hosted) {
        if (Number.isSafeInteger(urlSourceTabId) && urlSourceTabId > 0) {
            return getValidatedTab(urlSourceTabId);
        }
        if (embeddedRouteCanResolveSource()) {
            try {
                const context = await defaultPlatformRequest("POPUP_CONTEXT_GET", {});
                const sourceTabId = context?.sourceCanvasTabId;
                const resolved = await getValidatedTab(sourceTabId);
                if (resolved.state) return resolved;
                const reportedOrigin = context?.sourceCanvasOrigin === undefined
                    ? resolved.origin
                    : normalizePopupCanvasOrigin(context.sourceCanvasOrigin);
                if (!reportedOrigin || reportedOrigin !== resolved.origin) {
                    return { tab: null, tabId: null, state: "error", code: "SOURCE_TAB_CHANGED" };
                }
                return resolved;
            } catch (error) {
                return { tab: null, tabId: null, state: "not_open", code: "SOURCE_TAB_UNAVAILABLE" };
            }
        }
        return { tab: null, tabId: null, state: "not_open", code: "SOURCE_TAB_UNAVAILABLE" };
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

function defaultPlatformRequest(type, payload = {}) {
    if (typeof globalThis.popupPlatformRequest === "function") return globalThis.popupPlatformRequest(type, payload);
    const runtime = globalThis.chrome?.runtime;
    if (typeof runtime?.sendMessage !== "function") return Promise.reject(customDomainError("RUNTIME_MESSAGE_UNAVAILABLE", "Canvas connection is unavailable."));
    const contract = globalThis.APStudyCanvasPlatform?.Contract;
    const message = contract?.createEnvelope
        ? contract.createEnvelope(type, payload)
        : { version: 1, request_id: `popup-${Date.now()}`, type, payload };
    return Promise.resolve(runtime.sendMessage(message)).then((response) => {
        const result = response?.payload || response;
        if (!result || result.ok === false) throw customDomainError(result?.code || "PLATFORM_REQUEST_FAILED", "Canvas connection could not be completed.");
        return result;
    });
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
    request = defaultPlatformRequest,
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
            // The content-side verifier deliberately accepts an unverified
            // custom origin only when it is already in the durable allowlist.
            // Persist that provisional configuration after the exact
            // permission and registration succeed, then verify the account.
            // A failed verification (or metadata write) restores this
            // snapshot, so an unverified origin never survives the explicit
            // transaction.
            await platformOperation("SETTINGS_UPDATE", {
                area: "sync",
                changes: { custom_domain: nextOrigins },
                user_gesture: true,
                canvas_transaction: "persist_only"
            });
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
    const input = document?.querySelector?.("#customDomain");
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

// Modern editors use these narrow bridges instead of translating diagnostics
// into synthetic settings updates. Both preserve the validated source-tab and
// explicit permission-bearing production paths above.
async function inspectCanvas() {
    const source = await resolvePopupSourceTab();
    if (source.state || !Number.isInteger(source.tabId)) throw customDomainError(source.code || "SOURCE_TAB_UNAVAILABLE", "Open an eligible Canvas tab before running the inspector.");
    if (!chrome.tabs?.sendMessage) throw customDomainError("CONTENT_MESSAGE_UNAVAILABLE", "Canvas could not run the inspector.");
    const result = await chrome.tabs.sendMessage(source.tabId, { message: "inspect", options: {} });
    // The supported legacy inspector returns its selector report rather than a
    // generic { ok: true } acknowledgement. Treat any other response as a
    // failed inspection so UI status cannot claim a false success.
    if (!result || typeof result !== "object" || typeof result.selectors !== "string") {
        throw customDomainError(result?.code || "CANVAS_INSPECT_FAILED", "Canvas could not run the inspector.");
    }
    return result;
}

async function requestCustomOrigin(origin) {
    if (!customCanvasDomainFlow) {
        customCanvasDomainFlow = createCustomCanvasDomainFlow({
            chromeApi: globalThis.chrome,
            windowApi: globalThis.window,
            onStatus: () => {},
            onError: () => {}
        });
        await customCanvasDomainFlow.load();
    }
    return customCanvasDomainFlow.save(origin);
}

const diagnosticsTransport = Object.freeze({
    normalizeCanvasDomains,
    customPermissionPatterns,
    createCustomCanvasDomainFlow,
    resolvePopupSourceTab,
    validateCanvasSourceTab,
    validateCanvasContextForTab,
    inspectCanvas,
    requestCustomOrigin
});

const customDomainApi = Object.freeze({
    normalizeCanvasDomains,
    customPermissionPatterns,
    createFlow: createCustomCanvasDomainFlow,
    saveCustomCanvasDomain,
    setup: setupCustomCanvasDomainFlow,
    getFlow: () => customCanvasDomainFlow
});

if (typeof globalThis !== "undefined") {
    globalThis.APStudyCanvasCustomDomain = customDomainApi;
    globalThis.APStudyCanvasDiagnosticsTransport = diagnosticsTransport;
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = diagnosticsTransport;
}

if (typeof document !== "undefined") {
    if (document.readyState === "loading") document.addEventListener?.("DOMContentLoaded", setupCustomCanvasDomainFlow, { once: true });
    else setupCustomCanvasDomainFlow();
}
})();
