(function (root, factory) {
    "use strict";

    const api = factory();
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasPlatform = Object.assign(root.APStudyCanvasPlatform || {}, { WritebackConsent: api });
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const CONSENT_VERSION = 2;
    const REQUIRED_SCOPES = Object.freeze(["personal_events_write", "planner_items_write", "selected_item_mirroring"]);
    const ACCOUNT = /^[a-f0-9]{64}$/;
    const SOURCE_REF = /^src1:[A-Za-z0-9._~-]{1,128}$/;
    const NEST_USER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

    function isPlainObject(value) {
        if (!value || typeof value !== "object" || Array.isArray(value)) return false;
        const prototype = Object.getPrototypeOf(value);
        return prototype === Object.prototype || prototype === null;
    }

    function bodyOf(value) {
        if (isPlainObject(value?.body)) return value.body;
        if (isPlainObject(value?.payload?.body)) return value.payload.body;
        if (isPlainObject(value?.payload)) return value.payload;
        return isPlainObject(value) ? value : null;
    }

    function field(value, ...names) {
        if (!isPlainObject(value)) return undefined;
        for (const name of names) if (Object.prototype.hasOwnProperty.call(value, name)) return value[name];
        return undefined;
    }

    function transportFailed(value) {
        const status = Number(value?.status);
        return value?.ok === false || (Number.isInteger(status) && status >= 400);
    }

    function sourceKey(accountKey) { return `canvas:${accountKey}`; }

    function normalizeIdentity(value, expectedUserId) {
        if (transportFailed(value)) return { ok: false, code: Number(value?.status) === 419 ? "NEST_SESSION_EXPIRED" : Number(value?.status) === 401 ? "NEST_SIGNED_OUT" : "NEST_AUTHENTICATION_REQUIRED" };
        const body = bodyOf(value);
        if (!isPlainObject(body)) return { ok: false, code: "NEST_AUTHENTICATION_REQUIRED" };
        const state = field(body, "state", "status");
        if (state === "expired") return { ok: false, code: "NEST_SESSION_EXPIRED" };
        if (state === "signed_out") return { ok: false, code: "NEST_SIGNED_OUT" };
        if (body.authenticated !== true && state !== "authenticated") return { ok: false, code: "NEST_AUTHENTICATION_REQUIRED" };
        const userId = body.profile?.id;
        if (typeof userId !== "string" || !NEST_USER.test(userId)) return { ok: false, code: "NEST_IDENTITY_INVALID" };
        if (typeof expectedUserId !== "string" || userId !== expectedUserId) return { ok: false, code: "NEST_IDENTITY_MISMATCH" };
        return { ok: true, userId };
    }

    function normalizeConsent(value, accountKey, requiredScopes = REQUIRED_SCOPES) {
        if (transportFailed(value)) return { ok: false, code: Number(value?.status) === 419 ? "NEST_SESSION_EXPIRED" : Number(value?.status) === 401 ? "NEST_SIGNED_OUT" : "NEST_WRITEBACK_CONSENT_REQUIRED" };
        const body = bodyOf(value);
        const nested = isPlainObject(body?.consent) ? body.consent : body;
        if (!isPlainObject(nested)) return { ok: false, code: "NEST_WRITEBACK_CONSENT_INVALID" };
        const version = field(nested, "version", "consent_version", "consentVersion");
        const contractVersion = field(body, "contractVersion", "contract_version");
        const current = field(nested, "current");
        const granted = field(nested, "granted");
        const account = field(nested, "account_key", "accountKey");
        const source = field(nested, "source_key", "sourceKey");
        const scopes = field(nested, "scopes");
        if (version !== CONSENT_VERSION
            || (contractVersion !== undefined && contractVersion !== 1)
            || current !== true
            || granted !== true
            || account !== accountKey
            || source !== sourceKey(accountKey)
            || !Array.isArray(scopes)
            || !requiredScopes.every((scope) => scopes.includes(scope))
            || scopes.some((scope) => typeof scope !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(scope))) {
            return { ok: false, code: "NEST_WRITEBACK_CONSENT_REQUIRED" };
        }
        return { ok: true, consent: { version: CONSENT_VERSION, account_key: accountKey, source_key: sourceKey(accountKey), scopes: scopes.slice() } };
    }

    async function requireWritebackConsent({ transport, accountKey, sourceRef, requestId, expectedUserId, requiredScopes = REQUIRED_SCOPES } = {}) {
        if (!transport || typeof transport.request !== "function" || typeof transport.identityGet !== "function") return { ok: false, code: "NEST_TRANSPORT_UNAVAILABLE" };
        if (typeof accountKey !== "string" || !ACCOUNT.test(accountKey)) return { ok: false, code: "CANVAS_ACCOUNT_KEY_INVALID" };
        if (typeof sourceRef !== "string" || !SOURCE_REF.test(sourceRef)) return { ok: false, code: "NEST_SOURCE_REF_INVALID" };
        const identityResponse = await transport.identityGet({ requestId });
        const identity = normalizeIdentity(identityResponse, expectedUserId);
        if (!identity.ok) return identity;
        const capabilities = bodyOf(identityResponse)?.capabilities;
        if (capabilities?.calendar_two_way_writeback !== true || (requiredScopes.includes("selected_item_mirroring") && capabilities?.calendar_mirroring !== true)) return { ok: false, code: "NEST_WRITEBACK_CAPABILITY_REQUIRED" };
        const readResponse = await transport.request({ method: "GET", path: `/api/extension/consent?source_key=${encodeURIComponent(sourceKey(accountKey))}&account_key=${accountKey}&version=1`, headers: { Accept: "application/json", "X-Request-ID": requestId } }, { requestId });
        const readBody = bodyOf(readResponse);
        const read = readBody?.consent || readBody;
        if (transportFailed(readResponse) || read?.version !== 1 || read?.current !== true || read?.granted !== true || read?.account_key !== accountKey || read?.source_key !== sourceKey(accountKey) || !["full_history_upload", "ongoing_read", "shares_ics_inclusion"].every(scope => read?.scopes?.includes(scope))) return { ok: false, code: "NEST_READ_CONSENT_REQUIRED" };
        const query = `source_key=${encodeURIComponent(sourceKey(accountKey))}&account_key=${accountKey}&version=${CONSENT_VERSION}`;
        const consent = normalizeConsent(await transport.request({
            method: "GET",
            path: `/api/extension/consent?${query}`,
            headers: { Accept: "application/json", "X-Request-ID": requestId }
        }, { requestId }), accountKey, requiredScopes);
        if (!consent.ok) return consent;
        return { ok: true, accountKey, sourceRef, sourceKey: sourceKey(accountKey), consent: consent.consent };
    }

    return Object.freeze({
        CONSENT_VERSION,
        REQUIRED_SCOPES,
        sourceKey,
        normalizeIdentity,
        normalizeConsent,
        requireWritebackConsent
    });
}));
