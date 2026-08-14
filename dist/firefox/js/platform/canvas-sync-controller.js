(function (root, factory) {
    "use strict";

    const api = factory();
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasPlatform = Object.assign(root.APStudyCanvasPlatform || {}, { CanvasSyncController: api });
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const CONTRACT_VERSION = 1;
    const REQUEST_KEYS = new Set([
        "contractVersion", "accountKey", "origin", "canvasUserId", "sourceId",
        "label", "consentVersion", "scope", "descriptors", "requestId"
    ]);
    const SECRET_KEY = /TOKEN|COOKIE|CSRF|SECRET|PASSWORD|PROVIDER|TAB|WINDOW|URL|RAW/i;
    const SAFE_CODE = /^[A-Za-z][A-Za-z0-9_:-]{0,63}$/;
    const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

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

    function sameJson(left, right) {
        if (left === right) return true;
        if (Array.isArray(left) || Array.isArray(right)) {
            return Array.isArray(left) && Array.isArray(right) && left.length === right.length
                && left.every((item, index) => sameJson(item, right[index]));
        }
        if (isPlainObject(left) || isPlainObject(right)) {
            if (!isPlainObject(left) || !isPlainObject(right)) return false;
            const leftKeys = Object.keys(left).sort();
            const rightKeys = Object.keys(right).sort();
            return leftKeys.length === rightKeys.length
                && leftKeys.every((key, index) => key === rightKeys[index] && sameJson(left[key], right[key]));
        }
        return false;
    }

    function boundedText(value, field, { allowNumber = false } = {}) {
        if (allowNumber && Number.isSafeInteger(value) && value >= 0) return value;
        if (typeof value !== "string" || !value || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${field}_INVALID`);
        return value;
    }

    function validateSafeTree(value, depth = 0, seen = new Set()) {
        if (depth > 8) throw new Error("REQUEST_TOO_DEEP");
        if (value === null || typeof value === "string" || typeof value === "boolean") {
            if (typeof value === "string" && (value.length > 2048 || /[\u0000-\u001f\u007f]/.test(value))) throw new Error("REQUEST_VALUE_INVALID");
            return;
        }
        if (typeof value === "number") {
            if (!Number.isFinite(value) || !Number.isSafeInteger(value) || value < 0) throw new Error("REQUEST_NUMBER_INVALID");
            return;
        }
        if (!Array.isArray(value) && !isPlainObject(value)) throw new Error("REQUEST_VALUE_INVALID");
        if (seen.has(value)) throw new Error("REQUEST_CYCLE_INVALID");
        seen.add(value);
        if (Array.isArray(value)) value.forEach((item) => validateSafeTree(item, depth + 1, seen));
        else Object.entries(value).forEach(([key, item]) => {
            if (!key || key.length > 128 || SECRET_KEY.test(key)) throw new Error("REQUEST_FIELD_INVALID");
            validateSafeTree(item, depth + 1, seen);
        });
        seen.delete(value);
    }

    function validateOrigin(value) {
        if (typeof value !== "string" || value.length > 256) throw new Error("ORIGIN_INVALID");
        let parsed;
        try { parsed = new URL(value); } catch (error) { throw new Error("ORIGIN_INVALID"); }
        if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash || value !== parsed.origin) throw new Error("ORIGIN_INVALID");
        return value;
    }

    function validateBinding(request) {
        if (!isPlainObject(request)) throw new Error("REQUEST_OBJECT_REQUIRED");
        for (const key of Object.keys(request)) {
            if (key === "tabId" || key === "windowId") throw new Error("REQUEST_CONTEXT_FORBIDDEN");
            if (!REQUEST_KEYS.has(key)) throw new Error("REQUEST_FIELD_UNKNOWN");
        }
        if (request.contractVersion !== CONTRACT_VERSION) throw new Error("CONTRACT_VERSION_UNSUPPORTED");
        const binding = {
            contractVersion: CONTRACT_VERSION,
            accountKey: boundedText(request.accountKey, "ACCOUNT_KEY"),
            origin: validateOrigin(request.origin),
            canvasUserId: boundedText(request.canvasUserId, "CANVAS_USER_ID", { allowNumber: true }),
            sourceId: boundedText(request.sourceId, "SOURCE_ID"),
            label: boundedText(request.label, "LABEL"),
            consentVersion: boundedText(request.consentVersion, "CONSENT_VERSION"),
            scope: clone(request.scope),
            descriptors: clone(request.descriptors),
            requestId: boundedText(request.requestId, "REQUEST_ID")
        };
        if (!isPlainObject(binding.scope)) throw new Error("SCOPE_INVALID");
        if (!Array.isArray(binding.descriptors) || binding.descriptors.length > 256) throw new Error("DESCRIPTORS_INVALID");
        validateSafeTree(binding.scope);
        validateSafeTree(binding.descriptors);
        if (!SAFE_ID.test(binding.requestId)) throw new Error("REQUEST_ID_INVALID");
        return Object.freeze(binding);
    }

    function valueAt(value, names) {
        if (!value || typeof value !== "object") return undefined;
        for (const name of names) if (value[name] !== undefined) return value[name];
        return undefined;
    }

    function nestedValue(value, names) {
        const direct = valueAt(value, names);
        if (direct !== undefined) return direct;
        for (const childName of ["identity", "nestIdentity", "nest_identity", "consent", "proof", "data"]) {
            const child = value?.[childName];
            const nested = valueAt(child, names);
            if (nested !== undefined) return nested;
        }
        return undefined;
    }

    function accountMatches(value, expected) {
        const actual = nestedValue(value, ["accountKey", "account_key", "account"]);
        return actual === undefined || String(actual) === String(expected);
    }

    function authenticated(identity) {
        const state = identity?.identity && typeof identity.identity === "object" ? identity.identity : identity;
        return state?.authenticated === true || state?.state === "authenticated";
    }

    function sessionMatches(binding, session) {
        if (!isPlainObject(session)) return false;
        const account = valueAt(session, ["accountKey", "account_key", "account"]);
        const origin = valueAt(session, ["origin"]);
        const user = valueAt(session, ["canvasUserId", "canvas_user_id", "userId", "user_id", "providerUserId", "provider_user_id"]);
        return account !== undefined && origin !== undefined && user !== undefined
            && String(account) === String(binding.accountKey)
            && origin === binding.origin
            && String(user) === String(binding.canvasUserId);
    }

    function consentMatches(binding, proof) {
        if (!proof || typeof proof !== "object") return false;
        const consent = isPlainObject(proof.consent) ? proof.consent : proof;
        const granted = consent.granted === true || consent.current === true || consent.status === "current"
            || proof.granted === true || proof.current === true;
        const account = nestedValue(proof, ["accountKey", "account_key", "account"]);
        const version = nestedValue(proof, ["consentVersion", "consent_version"]);
        const scope = nestedValue(proof, ["scope", "scopes"]);
        return granted
            && account !== undefined && String(account) === String(binding.accountKey)
            && version !== undefined && String(version) === String(binding.consentVersion)
            && scope !== undefined && sameJson(scope, binding.scope);
    }

    function safeCode(value, fallback = "SYNC_DEPENDENCY_FAILED") {
        const code = typeof value === "string" ? value : "";
        return SAFE_CODE.test(code) && !SECRET_KEY.test(code) ? code : fallback;
    }

    function safeCorrelation(value, fallback) {
        const candidate = typeof value === "string" ? value : fallback;
        return SAFE_ID.test(candidate || "") ? candidate : fallback;
    }

    function safeCounts(value, depth = 0, seen = new Set()) {
        if (depth > 5 || value === null) return value === null ? null : undefined;
        if (Number.isSafeInteger(value) && value >= 0) return value;
        if (typeof value === "boolean") return value;
        if (Array.isArray(value)) {
            if (seen.has(value)) return undefined;
            seen.add(value);
            const output = value.map((item) => safeCounts(item, depth + 1, seen));
            seen.delete(value);
            return output.every((item) => item !== undefined) ? output : undefined;
        }
        if (!isPlainObject(value) || seen.has(value)) return undefined;
        seen.add(value);
        const output = {};
        for (const [key, item] of Object.entries(value)) {
            if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/.test(key) || SECRET_KEY.test(key)) { seen.delete(value); return undefined; }
            const safe = safeCounts(item, depth + 1, seen);
            if (safe === undefined) { seen.delete(value); return undefined; }
            output[key] = safe;
        }
        seen.delete(value);
        return output;
    }

    function safeResult(value, correlation) {
        const output = {};
        const state = value?.state;
        output.state = typeof state === "string" && SAFE_CODE.test(state) && !SECRET_KEY.test(state) ? state : "failed";
        if (value && Object.prototype.hasOwnProperty.call(value, "counts")) {
            const counts = safeCounts(value.counts);
            if (counts !== undefined) output.counts = counts;
        }
        const hasErrorCode = value && (Object.prototype.hasOwnProperty.call(value, "errorCode") || Object.prototype.hasOwnProperty.call(value, "code"));
        const errorCode = value?.errorCode ?? value?.code;
        if (hasErrorCode) output.errorCode = errorCode === null || errorCode === undefined ? null : safeCode(errorCode);
        if (correlation) output.correlation = correlation;
        return output;
    }

    function createCanvasSyncController({ getFeatureFlags, getNestIdentity, getConsentProof, resolveCanvasSession, engine, idFactory } = {}) {
        function disabled() {
            return { state: "idle", errorCode: "feature_disabled" };
        }

        function enabled() {
            try {
                const flags = typeof getFeatureFlags === "function" ? getFeatureFlags() : getFeatureFlags;
                return flags && flags.upload === true;
            } catch (error) {
                return false;
            }
        }

        function correlation(operation, binding) {
            let value;
            if (typeof idFactory === "function") value = idFactory(`${operation}-correlation`);
            return safeCorrelation(value, binding.requestId);
        }

        function failure(errorCode, correlationId, state = "failed") {
            return safeResult({ state, errorCode }, correlationId);
        }

        async function authorize(binding, operation) {
            if (typeof getNestIdentity !== "function") return { ok: false, result: failure("IDENTITY_UNAVAILABLE", operation.correlation) };
            let identity;
            try { identity = await getNestIdentity(); } catch (error) { return { ok: false, result: failure(safeCode(error?.code, "IDENTITY_UNAVAILABLE"), operation.correlation) }; }
            if (!authenticated(identity)) return { ok: false, result: failure("SYNC_NEST_IDENTITY_REQUIRED", operation.correlation, "signed_out") };
            if (!accountMatches(identity, binding.accountKey)) return { ok: false, result: failure("ACCOUNT_MISMATCH", operation.correlation) };
            return { ok: true, identity };
        }

        async function startOrResume(method, request) {
            if (!enabled()) return disabled();
            let binding;
            try { binding = validateBinding(request); } catch (error) { return failure(safeCode(error?.message, "REQUEST_INVALID")); }
            let correlationId = binding.requestId;
            const operation = { correlation: binding.requestId };
            const authorization = await authorize(binding, operation);
            if (!authorization.ok) return authorization.result;
            try { correlationId = correlation(method, binding); } catch (error) { return failure("CORRELATION_UNAVAILABLE", binding.requestId); }
            if (typeof resolveCanvasSession !== "function") return failure("CANVAS_SESSION_UNAVAILABLE", correlationId);
            let session;
            try { session = await resolveCanvasSession(binding); } catch (error) { return failure(safeCode(error?.code, "CANVAS_SESSION_UNAVAILABLE"), correlationId); }
            if (session !== null && session !== undefined && !sessionMatches(binding, session)) return failure("CANVAS_ACCOUNT_MISMATCH", correlationId);
            if (session === null || session === undefined) {
                if (typeof engine?.[method] !== "function") return failure("ENGINE_UNAVAILABLE", correlationId);
                try {
                    return safeResult(await engine[method]({ enabled: true, binding, session: null }), correlationId);
                } catch (error) {
                    return failure(safeCode(error?.code), correlationId);
                }
            }
            if (typeof getConsentProof !== "function") return failure("SYNC_CURRENT_CONSENT_REQUIRED", correlationId);
            let proof;
            try { proof = await getConsentProof(binding); } catch (error) { return failure(safeCode(error?.code, "SYNC_CURRENT_CONSENT_REQUIRED"), correlationId); }
            if (!consentMatches(binding, proof)) return failure("SYNC_CURRENT_CONSENT_REQUIRED", correlationId);
            if (typeof engine?.[method] !== "function") return failure("ENGINE_UNAVAILABLE", correlationId);
            try {
                const identityUserId = nestedValue(authorization.identity, ["userId", "user_id", "userid"]);
                const engineProof = isPlainObject(proof) && identityUserId !== undefined
                    ? { ...proof, identity: clone(authorization.identity) }
                    : proof;
                return safeResult(await engine[method]({ enabled: true, binding, proof: engineProof }), correlationId);
            } catch (error) {
                return failure(safeCode(error?.code), correlationId);
            }
        }

        async function status(request) {
            if (!enabled()) return disabled();
            let binding;
            try { binding = validateBinding(request); } catch (error) { return failure(safeCode(error?.message, "REQUEST_INVALID")); }
            let correlationId;
            try { correlationId = correlation("status", binding); } catch (error) { return failure("CORRELATION_UNAVAILABLE"); }
            if (typeof engine?.getStatus !== "function") return failure("ENGINE_UNAVAILABLE", correlationId);
            try { return safeResult(await engine.getStatus({ enabled: true, binding }), correlationId); } catch (error) { return failure(safeCode(error?.code), correlationId); }
        }

        async function cancel(request) {
            if (!enabled()) return disabled();
            let binding;
            try { binding = validateBinding(request); } catch (error) { return failure(safeCode(error?.message, "REQUEST_INVALID")); }
            let correlationId = binding.requestId;
            const authorization = await authorize(binding, { correlation: binding.requestId });
            if (!authorization.ok) return authorization.result;
            try { correlationId = correlation("cancel", binding); } catch (error) { return failure("CORRELATION_UNAVAILABLE", binding.requestId); }
            if (typeof engine?.cancel !== "function") return failure("ENGINE_UNAVAILABLE", correlationId);
            try { return safeResult(await engine.cancel({ enabled: true, binding }), correlationId); } catch (error) { return failure(safeCode(error?.code), correlationId); }
        }

        return Object.freeze({ start: (request) => startOrResume("start", request), resume: (request) => startOrResume("resume", request), status, cancel });
    }

    return Object.freeze({ createCanvasSyncController });
}));
