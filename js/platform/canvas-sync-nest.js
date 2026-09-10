(function (root, factory) {
    "use strict";

    const security = root?.APStudyCanvasPlatform?.Security || (typeof require === "function" ? require("./security.js") : null);
    const api = factory(security);
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasPlatform = Object.assign(root.APStudyCanvasPlatform || {}, { CanvasSyncNest: api });
}(typeof globalThis !== "undefined" ? globalThis : this, function (security) {
    "use strict";

    const CONTRACT_VERSION = 1;
    const MAX_TEXT = 512;
    const MAX_ID = 160;
    const MAX_SCOPE = 128;
    const MAX_RETRY_AFTER_MS = 5 * 60 * 1000;
    const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
    const SCOPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
    const SAFE_CODE_PATTERN = /^NEST_[A-Z0-9_]{1,63}$/;
    const CONSENT_VERSION = 1;
    const CONSENT_SCOPES = Object.freeze(["full_history_upload", "ongoing_read", "shares_ics_inclusion"]);
    const ACCOUNT_KEY_PATTERN = /^[a-f0-9]{64}$/;
    const SOURCE_KEY_PATTERN = /^canvas:[a-f0-9]{64}$/;
    const SENSITIVE_KEY_PATTERN = /(?:access[_-]?token|refresh[_-]?token|id[_-]?token|authorization|bearer|password|passwd|secret|credential|api[_-]?key|client[_-]?secret|private[_-]?ics|raw[_-]?email|set[-_]?cookie|csrf|cookie|session|appwrite)/i;

    function isPlainObject(value) {
        if (!value || typeof value !== "object" || Array.isArray(value)) return false;
        const prototype = Object.getPrototypeOf(value);
        return prototype === Object.prototype || prototype === null;
    }

    function valueAt(value, ...names) {
        if (!isPlainObject(value)) return undefined;
        for (const name of names) {
            if (Object.prototype.hasOwnProperty.call(value, name)) return value[name];
        }
        return undefined;
    }

    function credentialLike(value) {
        if (security?.hasCredentialLikeScalar) return security.hasCredentialLikeScalar(value);
        return typeof value === "string" && /(?:bearer\s+|token\s*[:=]|authorization\s*[:=]|csrf\s*[:=]|set-cookie\s*:)/i.test(value);
    }

    function recursivelySafe(value, seen = new Set()) {
        if (value === null || typeof value === "boolean") return true;
        if (typeof value === "string") return value.length <= MAX_TEXT && !credentialLike(value);
        if (typeof value === "number") return Number.isFinite(value);
        if (!value || typeof value !== "object" || seen.has(value)) return false;
        if (!Array.isArray(value) && !isPlainObject(value)) return false;
        seen.add(value);
        const safe = (Array.isArray(value) ? value.map((item) => ["", item]) : Object.entries(value)).every(([key, item]) => {
            if (key && SENSITIVE_KEY_PATTERN.test(key)) return true;
            return recursivelySafe(item, seen);
        });
        seen.delete(value);
        return safe;
    }

    function text(value, { field, max = MAX_TEXT, pattern } = {}) {
        if (typeof value !== "string" || !value || value.length > max || /[\u0000-\u001f\u007f]/.test(value) || credentialLike(value)) throw new Error(`${field}_INVALID`);
        if (pattern && !pattern.test(value)) throw new Error(`${field}_INVALID`);
        return value;
    }

    function optionalText(value, max = MAX_TEXT) {
        if (value === undefined || value === null || value === "") return null;
        if (typeof value !== "string" || value.length > max || /[\u0000-\u001f\u007f]/.test(value) || credentialLike(value)) return null;
        return value;
    }

    function identifier(value, field) {
        return text(value, { field, max: MAX_ID, pattern: ID_PATTERN });
    }

    function contractVersion(value) {
        return value === CONTRACT_VERSION;
    }

    function deepFreeze(value, seen = new Set()) {
        if (!value || typeof value !== "object" || seen.has(value)) return value;
        seen.add(value);
        Object.values(value).forEach((child) => deepFreeze(child, seen));
        return Object.freeze(value);
    }

    function cloneSafeTimestamps(value) {
        const output = {};
        for (const [key, candidate] of Object.entries(value)) {
            if (!/^[A-Za-z][A-Za-z0-9_:-]{0,31}$/.test(key) || typeof candidate !== "string" || candidate.length > 64) continue;
            const parsed = new Date(candidate);
            if (Number.isFinite(parsed.getTime())) output[key] = parsed.toISOString();
        }
        return output;
    }

    function bodyOf(response) {
        if (!isPlainObject(response)) return null;
        if (isPlainObject(response.body)) return response.body;
        if (isPlainObject(response.payload?.body)) return response.payload.body;
        if (isPlainObject(response.payload)) return response.payload;
        return response;
    }

    function contractVersionValues(value) {
        if (!isPlainObject(value)) return [];
        return ["contractVersion", "contract_version"]
            .filter((name) => Object.prototype.hasOwnProperty.call(value, name))
            .map((name) => value[name]);
    }

    function statusOf(value) {
        const status = Number(isPlainObject(value) ? valueAt(value, "status") : value?.status);
        return Number.isInteger(status) && status >= 0 && status <= 599 ? status : undefined;
    }

    function retryAfterMs(value) {
        const direct = isPlainObject(value) ? valueAt(value, "retryAfterMs", "retry_after_ms") : value?.retryAfterMs;
        if (Number.isFinite(direct) && direct >= 0) return Math.min(MAX_RETRY_AFTER_MS, Math.floor(direct));
        const headers = isPlainObject(value) ? valueAt(value, "headers") : value?.headers;
        const header = valueAt(headers, "retry-after", "Retry-After");
        const seconds = Number(header);
        if (Number.isFinite(seconds) && seconds >= 0) return Math.min(MAX_RETRY_AFTER_MS, Math.floor(seconds * 1000));
        return undefined;
    }

    function offline(value) {
        const status = statusOf(value);
        const code = String(isPlainObject(value) ? valueAt(value, "code") : value?.code || "").toUpperCase();
        return status === 0 || value?.unavailable === true || code === "NEST_OFFLINE" || code === "NEST_UNAVAILABLE";
    }

    function minimalState(state, retry) {
        const result = { state, userId: null, displayName: null, username: null, avatarUrl: null };
        if (retry !== undefined) result.retryAfterMs = retry;
        return deepFreeze(result);
    }

    function safeTransport(transport, path) {
        const request = { method: "GET", path };
        if (typeof transport === "function") return transport(request);
        if (transport && typeof transport.request === "function") return transport.request(request);
        throw Object.assign(new Error("NEST_TRANSPORT_UNAVAILABLE"), { code: "NEST_TRANSPORT_UNAVAILABLE" });
    }

    function identityPayload(response) {
        const body = bodyOf(response);
        if (!body || !recursivelySafe(body)) throw new Error("NEST_IDENTITY_INVALID");
        const nested = isPlainObject(body.identity) ? body.identity : null;
        const source = nested ? Object.assign({}, body, nested) : body;
        if (!contractVersion(valueAt(body, "contractVersion", "contract_version") ?? valueAt(nested, "contractVersion", "contract_version"))) throw new Error("NEST_IDENTITY_VERSION_UNSUPPORTED");
        const state = valueAt(source, "state", "status");
        if (state !== "authenticated" && state !== "signed_out") throw new Error("NEST_IDENTITY_STATE_INVALID");
        if (state === "signed_out") return minimalState("signed_out");
        const profile = isPlainObject(source.profile) ? source.profile : {};
        const userId = identifier(valueAt(source, "userId", "user_id", "userid") ?? profile.id, "NEST_IDENTITY_USER_ID");
        const displayName = optionalText(valueAt(source, "displayName", "display_name", "displayname") ?? valueAt(profile, "displayName", "name"), 256);
        const username = optionalText(valueAt(source, "username", "user_name") ?? profile.username, 256);
        const candidateAvatar = optionalText(valueAt(source, "avatarUrl", "avatar_url", "avatarurl") ?? profile.avatarUrl, 2048);
        const avatarUrl = candidateAvatar && (security?.validateSafeHttpsUrl ? security.validateSafeHttpsUrl(candidateAvatar) : /^https:\/\/[^\s]+$/i.test(candidateAvatar))
            ? candidateAvatar
            : null;
        return deepFreeze({ state, userId, displayName, username, avatarUrl });
    }

    function validateBinding(binding) {
        if (!isPlainObject(binding)) throw new Error("NEST_CONSENT_BINDING_REQUIRED");
        const allowed = new Set(["accountKey", "sourceKey", "consentVersion", "requiredScopes"]);
        if (Object.keys(binding).some((key) => !allowed.has(key))) throw new Error("NEST_CONSENT_BINDING_INVALID");
        const accountKey = identifier(binding.accountKey, "NEST_ACCOUNT_KEY");
        const sourceKey = identifier(binding.sourceKey, "NEST_SOURCE_KEY");
        if (!ACCOUNT_KEY_PATTERN.test(accountKey) || !SOURCE_KEY_PATTERN.test(sourceKey)) throw new Error("NEST_CONSENT_BINDING_INVALID");
        const consentVersion = binding.consentVersion === CONSENT_VERSION ? CONSENT_VERSION : (() => { throw new Error("NEST_CONSENT_VERSION_INVALID"); })();
        if (sourceKey !== `canvas:${accountKey}` || !Array.isArray(binding.requiredScopes) || binding.requiredScopes.length !== CONSENT_SCOPES.length) throw new Error("NEST_REQUIRED_SCOPES_INVALID");
        const requiredScopes = binding.requiredScopes.map((scope) => text(scope, { field: "NEST_SCOPE", max: MAX_SCOPE, pattern: SCOPE_PATTERN }));
        if (new Set(requiredScopes).size !== requiredScopes.length || CONSENT_SCOPES.some((scope) => !requiredScopes.includes(scope))) throw new Error("NEST_REQUIRED_SCOPES_INVALID");
        return Object.freeze({ accountKey, sourceKey, consentVersion, requiredScopes });
    }

    function consentPayload(response, binding) {
        const body = bodyOf(response);
        if (!body || !recursivelySafe(body)) return null;
        if (security?.findSensitiveData?.(body)) return null;
        const nested = isPlainObject(body.consent) ? body.consent : null;
        const field = (names) => {
            const values = [];
            for (const source of [body, nested]) {
                if (!isPlainObject(source)) continue;
                for (const name of names) if (Object.prototype.hasOwnProperty.call(source, name)) values.push(source[name]);
            }
            if (!values.length) return { present: false };
            const first = values[0];
            const equal = values.every((value) => Array.isArray(first)
                ? Array.isArray(value) && value.length === first.length && value.every((item, index) => item === first[index])
                : value === first);
            return { present: true, equal, value: first };
        };
        if (body.ok !== undefined && body.ok !== true) return null;
        const version = field(["version"]);
        const current = field(["current"]);
        const granted = field(["granted"]);
        const source = field(["source_key", "sourceKey"]);
        const account = field(["account_key", "accountKey"]);
        const scopeField = field(["scopes"]);
        const outerContractVersions = [
            ...contractVersionValues(response),
            ...contractVersionValues(response?.payload)
        ];
        const bodyContractVersions = [
            ...contractVersionValues(body),
            ...contractVersionValues(nested)
        ];
        const contractVersions = [...outerContractVersions, ...bodyContractVersions];
        if (contractVersions.some((value) => value !== CONTRACT_VERSION)
            || (!outerContractVersions.length && (!version.present || !version.equal || version.value !== CONSENT_VERSION))) return null;
        if (!version.present || !version.equal || version.value !== CONSENT_VERSION
            || !current.present || !current.equal || typeof current.value !== "boolean"
            || !granted.present || !granted.equal || typeof granted.value !== "boolean"
            || !source.present || !source.equal || !SOURCE_KEY_PATTERN.test(source.value || "") || source.value !== binding.sourceKey
            || (account.present && (!account.equal || account.value !== binding.accountKey))
            || !scopeField.present || !scopeField.equal || !Array.isArray(scopeField.value) || scopeField.value.length !== CONSENT_SCOPES.length) return null;
        let scopes;
        try { scopes = scopeField.value.map((scope) => text(scope, { field: "NEST_SCOPE", max: MAX_SCOPE, pattern: SCOPE_PATTERN })); }
        catch (error) { return null; }
        const scopeSet = new Set(scopes);
        if (scopeSet.size !== CONSENT_SCOPES.length || CONSENT_SCOPES.some((scope) => !scopeSet.has(scope)) || !binding.requiredScopes.every((scope) => scopeSet.has(scope))) return null;
        if (current.value !== true || granted.value !== true) return null;
        return deepFreeze({
            version: CONSENT_VERSION,
            current: true,
            granted: true,
            accountKey: binding.accountKey,
            sourceKey: binding.sourceKey,
            source_key: binding.sourceKey,
            scopes: scopes.slice(),
            state: typeof body.state === "string" ? body.state : "current",
            timestamps: isPlainObject(body.timestamps) ? cloneSafeTimestamps(body.timestamps) : {}
        });
    }

    function safeFactoryError(error, fallback) {
        const code = String(error?.code || "");
        const safeCode = SAFE_CODE_PATTERN.test(code) ? code : fallback;
        const result = new Error(safeCode);
        result.code = safeCode;
        return result;
    }

    function createCanvasSyncNest({ transport, syncClientFactory, sessionSecretStore, sourceMetadataStore } = {}) {
        async function getIdentity() {
            let response;
            try {
                response = await safeTransport(transport, "/api/extension/identity");
                const status = statusOf(response);
                if (status === 401) return minimalState("signed_out");
                if (offline(response)) return minimalState("unavailable", retryAfterMs(response));
                if (response?.ok === false || (status !== undefined && status >= 400)) return minimalState("unavailable", retryAfterMs(response));
                return identityPayload(response);
            } catch (error) {
                if (statusOf(error) === 401) return minimalState("signed_out");
                return minimalState("unavailable", retryAfterMs(error));
            }
        }

        async function getConsentProof(input) {
            let binding;
            try {
                binding = validateBinding(input);
            } catch (error) {
                return null;
            }
            const query = [
                ["source_key", binding.sourceKey],
                ["account_key", binding.accountKey],
                ["version", binding.consentVersion]
            ].map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("&");
            let response;
            try {
                response = await safeTransport(transport, `/api/extension/consent?${query}`);
                const status = statusOf(response);
                if (offline(response) || response?.ok === false || (status !== undefined && status >= 400)) return null;
                return consentPayload(response, binding);
            } catch (error) {
                return null;
            }
        }

        function createClient() {
            const factory = syncClientFactory;
            try {
                const dependencies = { transport, sessionSecretStore, sourceMetadataStore };
                if (typeof factory === "function") return factory(dependencies);
                if (factory && typeof factory.createSyncClient === "function") return factory.createSyncClient(dependencies);
                if (factory && typeof factory.createClient === "function") return factory.createClient(dependencies);
            } catch (error) {
                throw safeFactoryError(error, "NEST_SYNC_CLIENT_FACTORY_FAILED");
            }
            throw safeFactoryError(null, "NEST_SYNC_CLIENT_FACTORY_REQUIRED");
        }

        return Object.freeze({ getIdentity, getConsentProof, createClient });
    }

    createCanvasSyncNest.CONTRACT_VERSION = CONTRACT_VERSION;
    createCanvasSyncNest.MAX_RETRY_AFTER_MS = MAX_RETRY_AFTER_MS;
    return Object.freeze(createCanvasSyncNest);
}));
