(function (root, factory) {
    "use strict";

    const api = factory();
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasCanvasAdapter = Object.assign(root.APStudyCanvasCanvasAdapter || {}, { SyncClient: api });
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const CONTRACT_VERSION = 1;
    const MAX_ID = 160;
    const MAX_TEXT = 512;
    const MAX_REASON = 160;
    const MAX_ITEMS = 80;
    const MAX_REQUEST_BYTES = 48 * 1024;
    const MAX_RETRY_AFTER_MS = 5 * 60 * 1000;
    const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
    const SOURCE_REF_PATTERN = /^src1:[A-Za-z0-9._~-]{1,128}$/;
    const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
    const SECRET_KEY = /(?:access[_-]?token|refresh[_-]?token|id[_-]?token|oauth(?:2)?[_-]?token|authorization|bearer|password|passwd|secret|credential|api[_-]?key|client[_-]?secret|private[_-]?ics|raw[_-]?email|set[-_]?cookie|csrf|cookie|session)/i;
    const WRAPPER_KEY = /^(?:raw|rawresponse|response|responsebody|request|headers|body|events|results|data)$/i;

    function isPlainObject(value) {
        if (!value || typeof value !== "object" || Array.isArray(value)) return false;
        const prototype = Object.getPrototypeOf(value);
        return prototype === Object.prototype || prototype === null;
    }

    function isJson(value, seen = new Set()) {
        if (value === null || typeof value === "string" || typeof value === "boolean") return true;
        if (typeof value === "number") return Number.isFinite(value);
        if (!value || typeof value !== "object" || seen.has(value)) return false;
        if (!Array.isArray(value) && !isPlainObject(value)) return false;
        seen.add(value);
        const valid = Array.isArray(value)
            ? value.every((item) => isJson(item, seen))
            : Object.entries(value).every(([key, item]) => typeof key === "string" && isJson(item, seen));
        seen.delete(value);
        return valid;
    }

    function clone(value) {
        if (value === undefined) return undefined;
        if (typeof structuredClone === "function") return structuredClone(value);
        return JSON.parse(JSON.stringify(value));
    }

    function bytes(value) {
        let serialized;
        try { serialized = typeof value === "string" ? value : JSON.stringify(value); } catch (error) { return Number.POSITIVE_INFINITY; }
        if (typeof TextEncoder === "function") return new TextEncoder().encode(serialized).length;
        try { return unescape(encodeURIComponent(serialized)).length; } catch (error) { return Number.POSITIVE_INFINITY; }
    }

    function error(code, status, retryAfterMs) {
        const result = new Error(code);
        result.code = code;
        if (Number.isInteger(status) && status >= 0 && status <= 599) result.status = status;
        if (Number.isFinite(retryAfterMs) && retryAfterMs >= 0) result.retryAfterMs = Math.min(MAX_RETRY_AFTER_MS, Math.floor(retryAfterMs));
        return result;
    }

    function fail(code) { throw error(code); }

    function keyName(key) { return String(key).toLowerCase().replace(/[^a-z0-9]/g, ""); }

    function valueAt(object, ...names) {
        if (!isPlainObject(object)) return undefined;
        for (const name of names) {
            if (Object.prototype.hasOwnProperty.call(object, name)) return object[name];
        }
        return undefined;
    }

    function text(value, code, max = MAX_TEXT) {
        if (typeof value !== "string" || !value || value.length > max || /[\r\n]/.test(value)) fail(code);
        return value;
    }

    function boundedId(value, code) {
        const result = text(value, code, MAX_ID);
        if (!ID_PATTERN.test(result)) fail(code);
        return result;
    }

    function consentVersion(value) {
        if (value === 1) return 1;
        fail("SYNC_CONSENT_VERSION_INVALID");
    }
    function accountKey(value) { return boundedId(value, "SYNC_ACCOUNT_KEY_INVALID"); }
    function sourceId(value) { return boundedId(value, "SYNC_SOURCE_ID_INVALID"); }
    function sourceRef(value) {
        const result = boundedId(value, "SYNC_SOURCE_REF_INVALID");
        if (!SOURCE_REF_PATTERN.test(result)) fail("SYNC_SOURCE_REF_INVALID");
        return result;
    }
    function runId(value) { return boundedId(value, "SYNC_RUN_ID_INVALID"); }

    function deterministicLegacySourceId(account, sourceKey) {
        const input = `canvas-source-v1\u0000${account}\u0000${sourceKey}`;
        let first = 2166136261;
        let second = 2246822519;
        for (let index = 0; index < input.length; index += 1) {
            const code = input.charCodeAt(index);
            first = Math.imul(first ^ code, 16777619) >>> 0;
            second = Math.imul(second ^ code, 3266489917) >>> 0;
        }
        return `canvas-history-v1-${first.toString(16).padStart(8, "0")}${second.toString(16).padStart(8, "0")}`;
    }

    function sourceKey(value, account) {
        const result = value === undefined ? `canvas:${account}` : text(value, "SYNC_SOURCE_KEY_INVALID", MAX_ID);
        if (result !== `canvas:${account}` || !ID_PATTERN.test(result)) fail("SYNC_SOURCE_KEY_INVALID");
        return result;
    }

    function safeHttpsOrigin(value, code) {
        const result = text(value, code, 2048);
        let parsed;
        try { parsed = new URL(result); } catch (parseError) { fail(code); }
        if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) fail(code);
        return parsed.origin;
    }

    function credentialLike(value) {
        if (typeof value !== "string") return false;
        const trimmed = value.trim();
        return /(?:bearer\s+|(?:access|refresh|id)?[_ .-]*token\s*[:=]|authorization\s*[:=]|csrf(?:token)?\s*[:=]|set-cookie\s*:)/i.test(trimmed)
            || /eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/.test(trimmed);
    }

    function assertSafeTree(value, { rejectWrappers = false, origin = null, path = "", seen = new Set() } = {}) {
        if (!isJson(value)) fail("SYNC_JSON_INVALID");
        if (typeof value === "string") {
            if (credentialLike(value)) fail("SYNC_SECRET_REJECTED");
            if (/^(?:javascript|data|file):/i.test(value.trim())) fail("SYNC_UNSAFE_URL_REJECTED");
            if (/^https?:\/\//i.test(value.trim())) {
                let parsed;
                try { parsed = new URL(value); } catch (parseError) { fail("SYNC_UNSAFE_URL_REJECTED"); }
                if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash || !origin || parsed.origin !== origin) fail("SYNC_UNSAFE_URL_REJECTED");
                for (const [name, item] of parsed.searchParams.entries()) if (SECRET_KEY.test(name) || credentialLike(item)) fail("SYNC_UNSAFE_URL_REJECTED");
            }
            return;
        }
        if (value === null || typeof value !== "object") return;
        if (seen.has(value)) fail("SYNC_JSON_INVALID");
        seen.add(value);
        const entries = Array.isArray(value) ? value.map((item, index) => [String(index), item]) : Object.entries(value);
        for (const [key, item] of entries) {
            if (SECRET_KEY.test(key)) fail("SYNC_SECRET_REJECTED");
            if (rejectWrappers && WRAPPER_KEY.test(key)) fail("SYNC_RAW_ITEM_REJECTED");
            assertSafeTree(item, { rejectWrappers, origin, path: `${path}.${key}`, seen });
        }
        seen.delete(value);
    }

    function requestId(idFactory, label) {
        let value;
        try { value = typeof idFactory === "function" ? idFactory(label) : undefined; } catch (cause) { fail("SYNC_ID_FACTORY_FAILED"); }
        if (value === undefined || value === null) {
            if (globalThis.crypto?.randomUUID) value = globalThis.crypto.randomUUID();
            else value = `sync-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
        }
        return boundedId(String(value), "SYNC_REQUEST_ID_INVALID");
    }

    function readProofValue(object, camel, snake) { return valueAt(object, camel, snake); }

    function validateProof(proof) {
        if (!isPlainObject(proof)) fail("SYNC_PREFLIGHT_PROOF_REQUIRED");
        if (valueAt(proof, "contractVersion", "contract_version") !== undefined && valueAt(proof, "contractVersion", "contract_version") !== CONTRACT_VERSION) fail("SYNC_CONTRACT_VERSION_UNSUPPORTED");
        try { assertSafeTree(proof); } catch (cause) { if (cause?.code === "SYNC_SECRET_REJECTED") throw cause; fail("SYNC_PREFLIGHT_PROOF_INVALID"); }
        const topAccount = readProofValue(proof, "accountKey", "account_key");
        const topConsent = readProofValue(proof, "consentVersion", "consent_version");
        const identity = valueAt(proof, "identity", "nestIdentity", "nest_identity");
        const consent = valueAt(proof, "consent");
        if (!isPlainObject(identity) || (identity.authenticated !== true && identity.state !== "authenticated")) fail("SYNC_NEST_IDENTITY_REQUIRED");
        if (!isPlainObject(consent)) fail("SYNC_CURRENT_CONSENT_REQUIRED");
        const account = accountKey(topAccount);
        const version = consentVersion(topConsent);
        const identityAccount = readProofValue(identity, "accountKey", "account_key");
        if (identityAccount !== undefined && accountKey(identityAccount) !== account) fail("SYNC_PREFLIGHT_ACCOUNT_MISMATCH");
        const nestUserId = boundedId(readProofValue(identity, "userId", "user_id", "userid"), "SYNC_NEST_USER_ID_INVALID");
        if (accountKey(readProofValue(consent, "accountKey", "account_key")) !== account) fail("SYNC_PREFLIGHT_ACCOUNT_MISMATCH");
        if (consentVersion(readProofValue(consent, "consentVersion", "consent_version")) !== version) fail("SYNC_PREFLIGHT_CONSENT_MISMATCH");
        const current = consent.current === true || consent.granted === true || consent.status === "current";
        if (!current) fail("SYNC_CURRENT_CONSENT_REQUIRED");
        if (Array.isArray(consent.scopes)) {
            if (!consent.scopes.length || consent.scopes.some((scope) => scope !== "full_history_upload" && scope !== "ongoing_read")) fail("SYNC_CONSENT_SCOPES_INVALID");
            if (!consent.scopes.includes("ongoing_read")) fail("SYNC_CURRENT_CONSENT_REQUIRED");
        }
        return Object.freeze({ accountKey: account, consentVersion: version, nestUserId });
    }

    function validateScope(scope) {
        if (!isPlainObject(scope)) fail("SYNC_SCOPE_INVALID");
        assertSafeTree(scope, { rejectWrappers: true });
        if (bytes(scope) > 8192) fail("SYNC_SCOPE_TOO_LARGE");
        return clone(scope);
    }

    function validateBinding(input, { requireRun = false, requireScope = false, requireSourceDetails = false, requireSourceRef = false } = {}) {
        if (!isPlainObject(input)) fail("SYNC_BINDING_REQUIRED");
        if (valueAt(input, "contractVersion", "contract_version") !== CONTRACT_VERSION) fail("SYNC_CONTRACT_VERSION_UNSUPPORTED");
        const account = accountKey(valueAt(input, "accountKey", "account_key"));
        const rawSourceRef = valueAt(input, "sourceRef", "source_ref");
        const binding = {
            accountKey: account,
            consentVersion: consentVersion(valueAt(input, "consentVersion", "consent_version")),
            sourceKey: sourceKey(valueAt(input, "sourceKey", "source_key"), account)
        };
        if (rawSourceRef !== undefined) binding.sourceRef = sourceRef(rawSourceRef);
        if (requireSourceRef && binding.sourceRef === undefined) fail("SYNC_SOURCE_REF_REQUIRED");
        const rawSourceId = valueAt(input, "sourceId", "source_id");
        const derivedSourceId = deterministicLegacySourceId(account, binding.sourceKey);
        if (rawSourceId !== undefined && sourceId(rawSourceId) !== derivedSourceId) fail("SYNC_SOURCE_ID_MISMATCH");
        binding.sourceId = derivedSourceId;
        if (requireRun) {
            binding.runId = runId(valueAt(input, "runId", "run_id"));
            const generation = valueAt(input, "generation");
            if (!Number.isInteger(generation) || generation <= 0 || generation > 0x7fffffff) fail("SYNC_GENERATION_INVALID");
            binding.generation = generation;
        }
        if (requireScope) binding.scope = validateScope(valueAt(input, "scope"));
        if (requireSourceDetails) {
            binding.origin = safeHttpsOrigin(valueAt(input, "origin", "sourceOrigin", "source_origin"), "SYNC_ORIGIN_INVALID");
            binding.providerUserId = text(valueAt(input, "providerUserId", "provider_user_id"), "SYNC_PROVIDER_USER_ID_INVALID", MAX_TEXT);
            binding.label = text(valueAt(input, "label"), "SYNC_LABEL_INVALID", 256);
            if (credentialLike(binding.providerUserId) || credentialLike(binding.label)) fail("SYNC_SECRET_REJECTED");
        }
        return Object.freeze(binding);
    }

    function keyFor(binding) {
        return `apsc-sync-v1:${binding.accountKey}:${binding.sourceRef || binding.sourceId}:${binding.runId}:${binding.generation}`;
    }

    function leaseToken(value) {
        if (typeof value !== "string" || !value || value.length > MAX_TEXT || /[\r\n]/.test(value)) fail("SYNC_LEASE_INVALID");
        return value;
    }

    function findLease(value, seen = new Set()) {
        if (!value || typeof value !== "object" || seen.has(value)) return undefined;
        seen.add(value);
        const entries = Array.isArray(value) ? value.map((item) => ["", item]) : Object.entries(value);
        for (const [key, item] of entries) {
            if (keyName(key) === "leasetoken") return item;
            const nested = findLease(item, seen);
            if (nested !== undefined) return nested;
        }
        seen.delete(value);
        return undefined;
    }

    function redactLease(value, seen = new Set()) {
        if (Array.isArray(value)) return value.map((item) => redactLease(item, seen));
        if (!value || typeof value !== "object") return value;
        if (seen.has(value)) return undefined;
        seen.add(value);
        const result = {};
        Object.entries(value).forEach(([key, item]) => {
            if (keyName(key) === "leasetoken") return;
            const child = redactLease(item, seen);
            if (child !== undefined) result[key] = child;
        });
        seen.delete(value);
        return result;
    }

    function retryAfter(response) {
        const direct = response?.retryAfterMs;
        if (Number.isFinite(direct)) return direct;
        const header = response?.headers?.["retry-after"] ?? response?.headers?.["Retry-After"];
        const seconds = Number(header);
        return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
    }

    function responseStatus(response) {
        return Number.isInteger(response?.status) ? response.status : undefined;
    }

    function responseError(response) {
        const status = responseStatus(response);
        const retry = retryAfter(response);
        if (status === 0) return error("SYNC_OFFLINE", status, retry);
        if (status === 401) return error("SYNC_UNAUTHENTICATED", status, retry);
        if (status === 403) return error("SYNC_FORBIDDEN", status, retry);
        if (status === 429) return error("SYNC_RATE_LIMITED", status, retry);
        if (status !== undefined && status >= 500) return error("SYNC_UNAVAILABLE", status, retry);
        return error("SYNC_REQUEST_FAILED", status, retry);
    }

    function validateIdempotency(value) { return boundedId(value, "SYNC_IDEMPOTENCY_KEY_INVALID"); }

    function validateReason(value) {
        if (value === undefined) return undefined;
        const result = text(value, "SYNC_REASON_INVALID", MAX_REASON);
        if (!/^[A-Za-z0-9 .,_:-]+$/.test(result) || credentialLike(result)) fail("SYNC_REASON_INVALID");
        return result;
    }

    function normalizedItem(item, origin) {
        if (!isPlainObject(item)) fail("SYNC_ITEM_INVALID");
        const version = valueAt(item, "schemaVersion", "schema_version");
        if (version !== 1) fail("SYNC_ITEM_NOT_NORMALIZED");
        const eventRef = valueAt(item, "eventRef", "event_ref");
        if (typeof eventRef !== "string" || eventRef.length < 1 || eventRef.length > MAX_TEXT || /[\r\n]/.test(eventRef)) fail("SYNC_ITEM_INVALID");
        if (!isPlainObject(valueAt(item, "source")) || !isPlainObject(valueAt(item, "payload"))) fail("SYNC_ITEM_INVALID");
        assertSafeTree(item, { rejectWrappers: true, origin });
        return clone(item);
    }

    function validateBatch(input, origin, binding, idFactory) {
        if (!isPlainObject(input)) fail("SYNC_BATCH_REQUIRED");
        assertSafeTree(input, { rejectWrappers: true, origin });
        const items = valueAt(input, "items");
        if (!Array.isArray(items) || items.length > MAX_ITEMS) fail("SYNC_BATCH_LIMIT_EXCEEDED");
        const checkpoint = valueAt(input, "checkpoint");
        if (!isPlainObject(checkpoint)) fail("SYNC_CHECKPOINT_INVALID");
        if (checkpoint.page !== undefined && (!Number.isInteger(checkpoint.page) || checkpoint.page < 0 || checkpoint.page > 0x7fffffff)) fail("SYNC_CHECKPOINT_INVALID");
        const idempotency = validateIdempotency(valueAt(input, "idempotencyKey", "idempotency_key") ?? requestId(idFactory, "batch-idempotency"));
        const safeItems = items.map((item) => normalizedItem(item, origin));
        assertSafeTree(checkpoint, { rejectWrappers: true, origin });
        const body = {
            items: safeItems,
            generation: binding.generation,
            lease_token: undefined,
            idempotency_key: idempotency,
            checkpoint: clone(checkpoint)
        };
        return { body, idempotency };
    }

    function createSyncClient({ transport, sessionSecretStore, sourceMetadataStore, idFactory } = {}) {
        if (typeof transport !== "function" && (!transport || typeof transport.request !== "function" && typeof transport.mutate !== "function")) fail("SYNC_TRANSPORT_REQUIRED");
        if (!sessionSecretStore || typeof sessionSecretStore.get !== "function" || typeof sessionSecretStore.set !== "function" || typeof sessionSecretStore.remove !== "function") fail("SYNC_SECRET_STORE_REQUIRED");
        let authorization = null;

        function requirePreflight() {
            if (!authorization) fail("SYNC_PREFLIGHT_REQUIRED");
            return authorization;
        }

        function bind(input, options) {
            const auth = requirePreflight();
            const binding = validateBinding(input, options);
            if (binding.accountKey !== auth.accountKey || binding.consentVersion !== auth.consentVersion) fail("SYNC_BINDING_AUTH_MISMATCH");
            return binding;
        }

        async function loadLease(binding) {
            let stored;
            try { stored = await sessionSecretStore.get(keyFor(binding)); } catch (cause) { throw error("SYNC_SECRET_STORE_FAILED"); }
            if (typeof stored !== "string" || !stored) throw error("SYNC_LEASE_MISSING");
            return leaseToken(stored);
        }

        async function saveLease(binding, token) {
            const value = leaseToken(token);
            try { await sessionSecretStore.set(keyFor(binding), value); } catch (cause) { throw error("SYNC_SECRET_STORE_FAILED"); }
        }

        async function removeLease(binding) {
            try { await sessionSecretStore.remove(keyFor(binding)); } catch (cause) { throw error("SYNC_SECRET_STORE_FAILED"); }
        }

        async function persistSourceMetadata(binding, response, returnedSourceRef, nestUserId) {
            if (!sourceMetadataStore || typeof sourceMetadataStore.get !== "function" || typeof sourceMetadataStore.set !== "function") return;
            if (typeof nestUserId !== "string" || !ID_PATTERN.test(nestUserId)) fail("SYNC_NEST_IDENTITY_REQUIRED");
            let current;
            try { current = await sourceMetadataStore.get(); } catch (cause) { throw error("SYNC_SOURCE_METADATA_STORE_FAILED"); }
            const accounts = isPlainObject(current?.accounts) ? clone(current.accounts) : {};
            for (const [account, record] of Object.entries(accounts)) {
                if (account !== binding.accountKey && isPlainObject(record) && record.source_ref === returnedSourceRef) fail("SYNC_SOURCE_REF_ACCOUNT_MISMATCH");
            }
            const canvasUserId = findField(response, ["canvasUserId", "canvas_user_id", "userId", "user_id"]);
            const record = {
                source_ref: returnedSourceRef,
                source_key: binding.sourceKey,
                origin: binding.origin,
                nest_user_id: nestUserId,
                ...(canvasUserId === undefined ? {} : { canvas_user_id: boundedId(String(canvasUserId), "SYNC_CANVAS_USER_ID_INVALID") }),
                provider_user_id: binding.providerUserId,
                label: binding.label,
                active: true,
                archived: false,
                routing_eligible: true
            };
            try {
                await sourceMetadataStore.set({ version: 1, accounts: { ...accounts, [binding.accountKey]: record } });
            } catch (cause) { throw error("SYNC_SOURCE_METADATA_STORE_FAILED"); }
        }

        async function invoke({ path, method, body, query, idempotencyKey, allowLease = false }) {
            const request = { path, method, ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }), requestId: requestId(idFactory, "request"), ...(idempotencyKey ? { idempotencyKey } : {}) };
            if (bytes(request) > MAX_REQUEST_BYTES) fail("SYNC_REQUEST_BYTES_EXCEEDED");
            let raw;
            try {
                if (typeof transport === "function") raw = await transport(request);
                else if (method === "GET" && typeof transport.request === "function") {
                    const queryText = query ? `?${Object.entries(query).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`).join("&")}` : "";
                    raw = await transport.request({ method, path: `${path}${queryText}` }, { requestId: request.requestId, allowLeaseToken: allowLease });
                } else if (typeof transport.mutate === "function") {
                    raw = await transport.mutate({ method, path, body }, { requestId: request.requestId, idempotent: true, idempotencyKey: idempotencyKey || request.requestId, internalLease: allowLease });
                } else fail("SYNC_TRANSPORT_METHOD_UNAVAILABLE");
            } catch (cause) {
                if (cause?.code && /^SYNC_[A-Z0-9_]+$/.test(cause.code)) throw error(cause.code, cause.status, cause.retryAfterMs);
                const status = Number.isInteger(cause?.status) ? cause.status : (cause?.unavailable ? 0 : undefined);
                throw responseError({ status, retryAfterMs: cause?.retryAfterMs });
            }
            if (raw?.ok === false || (responseStatus(raw) !== undefined && responseStatus(raw) >= 400)) throw responseError(raw);
            const token = findLease(raw);
            if (token !== undefined) leaseToken(token);
            return { value: redactLease(raw), token };
        }

        async function rememberResponseLease(response, fallbackBinding) {
            const returned = validateResponseBinding(response.value, fallbackBinding);
            if (response.token === undefined) {
                if (!fallbackBinding.runId) fail("SYNC_LEASE_MISSING");
                return;
            }
            const binding = Object.freeze({ ...fallbackBinding, runId: returned.runId || fallbackBinding.runId, generation: returned.generation ?? fallbackBinding.generation });
            if (!binding.runId || !Number.isInteger(binding.generation) || binding.generation <= 0) fail("SYNC_LEASE_BINDING_MISSING");
            await saveLease(binding, response.token);
        }

        function findField(value, names, seen = new Set()) {
            if (!value || typeof value !== "object" || seen.has(value)) return undefined;
            seen.add(value);
            const keys = new Set(names.map(keyName));
            for (const [key, item] of Object.entries(value)) {
                if (keys.has(keyName(key))) return item;
                const nested = findField(item, names, seen);
                if (nested !== undefined) return nested;
            }
            seen.delete(value);
            return undefined;
        }

        function sameJsonValue(left, right) {
            if (left === right) return true;
            if (Array.isArray(left) || Array.isArray(right)) {
                return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => sameJsonValue(item, right[index]));
            }
            if (isPlainObject(left) || isPlainObject(right)) {
                if (!isPlainObject(left) || !isPlainObject(right)) return false;
                const leftKeys = Object.keys(left);
                const rightKeys = Object.keys(right);
                return leftKeys.length === rightKeys.length && leftKeys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && sameJsonValue(left[key], right[key]));
            }
            return false;
        }

        function validateResponseBinding(value, expected, { requireSourceRef = false } = {}) {
            const returnedAccount = findField(value, ["accountKey", "account_key"]);
            if (returnedAccount !== undefined && accountKey(returnedAccount) !== expected.accountKey) fail("SYNC_RESPONSE_ACCOUNT_MISMATCH");
            const returnedConsent = findField(value, ["consentVersion", "consent_version"]);
            if (returnedConsent !== undefined && consentVersion(returnedConsent) !== expected.consentVersion) fail("SYNC_RESPONSE_CONSENT_MISMATCH");
            const returnedSource = findField(value, ["sourceId", "source_id"]);
            if (returnedSource !== undefined && sourceId(returnedSource) !== expected.sourceId) fail("SYNC_RESPONSE_SOURCE_MISMATCH");
            const returnedSourceKey = findField(value, ["sourceKey", "source_key"]);
            if (returnedSourceKey !== undefined && sourceKey(returnedSourceKey, expected.accountKey) !== expected.sourceKey) fail("SYNC_RESPONSE_SOURCE_KEY_MISMATCH");
            const rawSourceRef = findField(value, ["sourceRef", "source_ref"]);
            const returnedSourceRef = rawSourceRef === undefined ? undefined : sourceRef(rawSourceRef);
            if (requireSourceRef && returnedSourceRef === undefined) fail("SYNC_SOURCE_REF_MISSING");
            if (returnedSourceRef !== undefined && expected.sourceRef !== undefined && returnedSourceRef !== expected.sourceRef) fail("SYNC_RESPONSE_SOURCE_REF_MISMATCH");
            const rawRun = findField(value, ["runId", "run_id"]);
            const returnedRun = rawRun === undefined ? undefined : runId(rawRun);
            if (returnedRun !== undefined && expected.runId && returnedRun !== expected.runId) fail("SYNC_RESPONSE_RUN_MISMATCH");
            const rawGeneration = findField(value, ["generation"]);
            let returnedGeneration;
            if (rawGeneration !== undefined) {
                if (!Number.isInteger(rawGeneration) || rawGeneration <= 0 || rawGeneration > 0x7fffffff) fail("SYNC_RESPONSE_GENERATION_INVALID");
                returnedGeneration = rawGeneration;
                if (expected.generation !== undefined && returnedGeneration !== expected.generation) fail("SYNC_RESPONSE_GENERATION_MISMATCH");
            }
            const returnedScope = findField(value, ["scope"]);
            if (returnedScope !== undefined) {
                const scope = validateScope(returnedScope);
                if (expected.scope !== undefined && !sameJsonValue(scope, expected.scope)) fail("SYNC_RESPONSE_SCOPE_MISMATCH");
            }
            return { sourceRef: returnedSourceRef, runId: returnedRun, generation: returnedGeneration };
        }

        function isTerminalResponse(value) {
            const state = findField(value, ["state", "status", "completionStatus", "completion_status"]);
            return typeof state === "string" && /^(?:complete|partial|cancelled|canceled|failed|error|expired|terminated)$/i.test(state);
        }

        async function runWithLease(binding, operation) {
            const token = await loadLease(binding);
            const response = await operation(token);
            await rememberResponseLease(response, binding);
            return response.value;
        }

        async function preflight(proof) {
            authorization = null;
            authorization = validateProof(proof);
            return Object.freeze({ ok: true, contractVersion: CONTRACT_VERSION });
        }

        async function establishSource(input) {
            const authorization = requirePreflight();
            const binding = validateBinding(input, { requireSourceDetails: true });
            if (binding.accountKey !== authorization.accountKey || binding.consentVersion !== authorization.consentVersion) fail("SYNC_BINDING_AUTH_MISMATCH");
            const response = await invoke({
                path: "/api/extension/calendar/sources",
                method: "POST",
                body: { account_key: binding.accountKey, source_id: binding.sourceId, origin: binding.origin, provider_user_id: binding.providerUserId, label: binding.label, consent_version: binding.consentVersion },
                idempotencyKey: requestId(idFactory, "source-establish"),
                allowLease: false
            });
            const returned = validateResponseBinding(response.value, binding, { requireSourceRef: true });
            await persistSourceMetadata(binding, response.value, returned.sourceRef, authorization.nestUserId);
            return response.value;
        }

        async function startRun(input) {
            const binding = bind(input, { requireScope: true, requireSourceRef: true });
            const idempotencyKey = validateIdempotency(valueAt(input, "idempotencyKey", "idempotency_key") ?? requestId(idFactory, "run-start-idempotency"));
            const response = await invoke({
                path: `/api/extension/calendar/sources/${encodeURIComponent(binding.sourceRef)}/sync`,
                method: "POST",
                body: { scope: binding.scope, consent_version: binding.consentVersion, idempotency_key: idempotencyKey },
                idempotencyKey,
                allowLease: true
            });
            validateResponseBinding(response.value, binding);
            await rememberResponseLease(response, binding);
            return response.value;
        }

        async function status(input) {
            const binding = bind(input, { requireRun: true, requireScope: true, requireSourceRef: true });
            await loadLease(binding);
            const response = await invoke({
                path: `/api/extension/calendar/sources/${encodeURIComponent(binding.sourceRef)}/sync/${encodeURIComponent(binding.runId)}`,
                method: "GET",
                query: { generation: binding.generation },
                allowLease: true
            });
            await rememberResponseLease(response, binding);
            if (isTerminalResponse(response.value)) await removeLease(binding);
            return response.value;
        }

        async function resume(input) { return leaseOperation(input, "resume"); }
        async function renew(input) { return leaseOperation(input, "renew"); }

        async function leaseOperation(input, action) {
            const binding = bind(input, { requireRun: true, requireScope: true, requireSourceRef: true });
            return runWithLease(binding, (token) => invoke({
                path: `/api/extension/calendar/sources/${encodeURIComponent(binding.sourceRef)}/sync/${encodeURIComponent(binding.runId)}/${action}`,
                method: "PUT",
                body: { generation: binding.generation, lease_token: token },
                allowLease: true
            }));
        }

        async function cancel(input) {
            const binding = bind(input, { requireRun: true, requireScope: true, requireSourceRef: true });
            const token = await loadLease(binding);
            const reason = validateReason(valueAt(input, "reason"));
            try {
                const response = await invoke({
                    path: `/api/extension/calendar/sources/${encodeURIComponent(binding.sourceRef)}/sync/${encodeURIComponent(binding.runId)}/cancel`,
                    method: "POST",
                    body: { generation: binding.generation, lease_token: token, ...(reason === undefined ? {} : { reason }) },
                    allowLease: true
                });
                validateResponseBinding(response.value, binding);
                return response.value;
            } finally {
                await removeLease(binding);
            }
        }

        async function uploadBatch(input, batch) {
            const binding = bind(input, { requireRun: true, requireScope: true, requireSourceRef: true });
            const token = await loadLease(binding);
            const prepared = validateBatch(batch, input.origin || input.sourceOrigin || input.source_origin, binding, idFactory);
            prepared.body.lease_token = token;
            if (bytes(prepared.body) > MAX_REQUEST_BYTES) fail("SYNC_BATCH_BYTES_EXCEEDED");
            const response = await invoke({
                path: `/api/extension/calendar/sources/${encodeURIComponent(binding.sourceRef)}/sync/${encodeURIComponent(binding.runId)}/batch`,
                method: "POST",
                body: prepared.body,
                idempotencyKey: prepared.idempotency,
                allowLease: true
            });
            await rememberResponseLease(response, binding);
            return response.value;
        }

        async function finalize(input, finalStatus) {
            const binding = bind(input, { requireRun: true, requireScope: true, requireSourceRef: true });
            if (finalStatus !== "complete" && finalStatus !== "partial") fail("SYNC_FINAL_STATUS_INVALID");
            const token = await loadLease(binding);
            try {
                const response = await invoke({
                    path: `/api/extension/calendar/sources/${encodeURIComponent(binding.sourceRef)}/sync/${encodeURIComponent(binding.runId)}/finalize`,
                    method: "POST",
                    body: { scope: binding.scope, generation: binding.generation, lease_token: token, status: finalStatus },
                    allowLease: true
                });
                validateResponseBinding(response.value, binding);
                return response.value;
            } finally {
                await removeLease(binding);
            }
        }

        return Object.freeze({ preflight, establishSource, startRun, status, resume, renew, cancel, uploadBatch, finalize });
    }

    createSyncClient.createSyncClient = createSyncClient;
    createSyncClient.CONTRACT_VERSION = CONTRACT_VERSION;
    createSyncClient.MAX_ITEMS = MAX_ITEMS;
    createSyncClient.MAX_REQUEST_BYTES = MAX_REQUEST_BYTES;
    return Object.freeze(createSyncClient);
}));
