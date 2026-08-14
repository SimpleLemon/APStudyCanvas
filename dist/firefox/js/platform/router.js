(function (root, factory) {
    "use strict";

    const api = factory(root?.APStudyCanvasPlatform?.Contract);
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasPlatform = Object.assign(root.APStudyCanvasPlatform || {}, { Router: api });
}(typeof globalThis !== "undefined" ? globalThis : this, function (contract) {
    "use strict";

    const FALLBACK_FLAGS = {
        ...(contract?.FEATURE_FLAGS || {
            identity: true,
            upload: true,
            projection: true,
            mirroring: false,
            mutation: false,
            overlay: true,
            replacement: false,
            calendarReplacementParity: { version: 1, ready: false },
            browserFullscreen: true,
            browserReplace: false
        })
    };
    const FEATURE_CODES = Object.freeze({
        upload: "FEATURE_DISABLED_UPLOAD",
        projection: "FEATURE_DISABLED_PROJECTION",
        mirroring: "FEATURE_DISABLED_MIRRORING",
        mutation: "FEATURE_DISABLED_MUTATION",
        overlay: "FEATURE_DISABLED_OVERLAY",
        replacement: "FEATURE_DISABLED_REPLACEMENT",
        browserFullscreen: "FEATURE_DISABLED_BROWSER_FULLSCREEN",
        browserReplace: "FEATURE_DISABLED_BROWSER_REPLACE",
        identity: "FEATURE_DISABLED_IDENTITY"
    });
    const CANVAS_FAMILIES = new Set([
        "CANVAS_ACCOUNT_VERIFY",
        "CANVAS_SYNC_START",
        "CANVAS_SYNC_RESUME",
        "CANVAS_SYNC_STATUS",
        "CANVAS_SYNC_CANCEL",
        "CANVAS_WRITEBACK_DRAIN",
        "CANVAS_WRITEBACK_RESULT"
    ]);
    const PUBLIC_CANVAS_SYNC_FAMILIES = new Set([
        "CANVAS_SYNC_START",
        "CANVAS_SYNC_RESUME",
        "CANVAS_SYNC_STATUS",
        "CANVAS_SYNC_CANCEL"
    ]);
    const PUBLIC_SYNC_FORBIDDEN_KEYS = new Set([
        "tabid", "windowid", "url", "uri", "href", "headers", "header", "authorization", "cookie",
        "token", "lease", "proof", "provider", "providerid", "event", "account", "accountkey",
        "canvasuserid", "origin", "sourceid", "sourceref"
    ]);
    const PUBLIC_SYNC_INPUT_FORBIDDEN_KEYS = new Set(Array.from(PUBLIC_SYNC_FORBIDDEN_KEYS).filter((key) => key !== "account" && key !== "accountkey"));
    const NEST_FAMILIES = new Set([
        "NEST_IDENTITY_GET",
        "NEST_CONSENT_GET",
        "NEST_CONSENT_SET",
        "NEST_CALENDARS_GET",
        "NEST_CALENDAR_RANGE_GET",
        "NEST_ROUTING_SET",
        "NEST_EVENT_OVERRIDE_SET",
        "NEST_EVENT_MUTATE"
    ]);
    const NEST_CONSENT_FAMILIES = new Set(["NEST_CONSENT_GET", "NEST_CONSENT_SET"]);
    const CONSENT_GET_KEYS = new Set(["source_key", "sourceKey", "account_key", "version"]);
    const CONSENT_SET_KEYS = new Set(["source_key", "sourceKey", "account_key", "action", "scopes", "version"]);
    const CONSENT_VERSION = 1;
    const CONSENT_ACCOUNT_PATTERN = /^[a-f0-9]{64}$/;
    const CONSENT_SOURCE_PATTERN = /^canvas:[a-f0-9]{64}$/;
    const CONSENT_SCOPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
    // Nest contract v1 is intentionally exact here. Legacy string versions and
    // legacy scope names may be recognized by internal migration code, but they
    // cannot cross this public router boundary or grant consent.
    const CONSENT_SCOPE_VALUES = Object.freeze(["full_history_upload", "ongoing_read", "shares_ics_inclusion"]);
    const CONSENT_SCOPES = new Set(CONSENT_SCOPE_VALUES);
    const CANVAS_ACCOUNT_KEY_PATTERN = /^[a-f0-9]{64}$/;
    const NEST_USER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
    const SOURCE_REF_PATTERN = /^src1:[A-Za-z0-9._~-]{1,128}$/;
    const SAFE_CALENDAR_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
    const SAFE_METADATA_TEXT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._:/@()&+-]{0,255}$/;
    const SOURCE_METADATA_KEY = "platform.sourceMetadata";
    const CANVAS_SYNC_OPT_IN_MAX_ACCOUNTS = 64;
    const CANVAS_SYNC_OPT_IN_MAX_BYTES = 8192;
    const CALENDAR_ROUTE_PATH = "/calendar";

    function errorPayload(code, message) {
        return { ok: false, code, ...(message ? { message } : {}) };
    }

    function okPayload(data = {}) {
        return Object.assign({ ok: true }, data);
    }

    function cleanString(value, maxLength) {
        return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, maxLength) : "";
    }

    function hasExactOwnKeys(value, allowed) {
        if (!value || typeof value !== "object" || Array.isArray(value)) return false;
        const keys = Reflect.ownKeys(value);
        return keys.length === allowed.size && keys.every((key) => typeof key === "string" && allowed.has(key));
    }

    function hasConsentKeys(value, allowed, required) {
        if (!value || typeof value !== "object" || Array.isArray(value)) return false;
        const keys = Reflect.ownKeys(value);
        return keys.every((key) => typeof key === "string" && allowed.has(key))
            && required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
            && (Object.prototype.hasOwnProperty.call(value, "source_key") || Object.prototype.hasOwnProperty.call(value, "sourceKey"));
    }

    function safeConsentText(value, pattern) {
        return typeof value === "string" && pattern.test(value) && !/[\u0000-\u001f\u007f]/.test(value);
    }

    function canonicalConsentSource(payload) {
        const snake = Object.prototype.hasOwnProperty.call(payload || {}, "source_key") ? payload.source_key : undefined;
        const camel = Object.prototype.hasOwnProperty.call(payload || {}, "sourceKey") ? payload.sourceKey : undefined;
        if (snake !== undefined && camel !== undefined && snake !== camel) return null;
        const value = snake ?? camel;
        return safeConsentText(value, CONSENT_SOURCE_PATTERN) ? value : null;
    }

    function safeSourceRef(value) {
        return typeof value === "string" && SOURCE_REF_PATTERN.test(value) && !/[\u0000-\u001f\u007f]/.test(value);
    }

    function safeCalendarId(value, { nullable = false } = {}) {
        if (nullable && value === null) return true;
        return typeof value === "string" && SAFE_CALENDAR_ID_PATTERN.test(value) && !/[\u0000-\u001f\u007f]/.test(value);
    }

    function safeMetadataText(value, max = 256) {
        return typeof value === "string"
            && value.length > 0
            && value.length <= max
            && SAFE_METADATA_TEXT_PATTERN.test(value)
            && !/[\u0000-\u001f\u007f]/.test(value);
    }

    function isPlainObject(value) {
        if (!value || typeof value !== "object" || Array.isArray(value)) return false;
        const prototype = Object.getPrototypeOf(value);
        return prototype === Object.prototype || prototype === null;
    }

    function accountKeyFromPayload(payload) {
        const value = typeof payload?.accountKey === "string"
            ? payload.accountKey
            : typeof payload?.account_key === "string" ? payload.account_key : "";
        const accountKey = value.trim().toLowerCase();
        return /^[a-f0-9]{64}$/.test(accountKey) ? accountKey : null;
    }

    function normalizeAccountOptIns(value) {
        if (!isPlainObject(value)) return {};
        const entries = Object.entries(value);
        if (entries.length > CANVAS_SYNC_OPT_IN_MAX_ACCOUNTS) return {};
        const normalized = {};
        for (const [accountKey, optedIn] of entries) {
            if (!CANVAS_ACCOUNT_KEY_PATTERN.test(accountKey) || typeof optedIn !== "boolean") return {};
            normalized[accountKey] = optedIn;
        }
        const serialized = JSON.stringify(normalized);
        const bytes = typeof TextEncoder === "function"
            ? new TextEncoder().encode(serialized).length
            : unescape(encodeURIComponent(serialized)).length;
        if (bytes > CANVAS_SYNC_OPT_IN_MAX_BYTES) return {};
        return normalized;
    }

    function validateConsentGetPayload(payload) {
        if (!hasConsentKeys(payload, CONSENT_GET_KEYS, ["account_key", "version"])
            || !safeConsentText(payload.account_key, CONSENT_ACCOUNT_PATTERN)
            || canonicalConsentSource(payload) !== `canvas:${payload.account_key}`
            || payload.version !== CONSENT_VERSION) {
            return { ok: false, code: "NEST_CONSENT_GET_PAYLOAD_INVALID" };
        }
        return {
            ok: true,
            value: {
                source_key: canonicalConsentSource(payload),
                account_key: payload.account_key,
                version: payload.version
            }
        };
    }

    function validateConsentSetPayload(payload) {
        if (!hasConsentKeys(payload, CONSENT_SET_KEYS, ["account_key", "action", "scopes", "version"])
            || !safeConsentText(payload.account_key, CONSENT_ACCOUNT_PATTERN)
            || canonicalConsentSource(payload) !== `canvas:${payload.account_key}`
            || (payload.action !== "grant" && payload.action !== "revoke")
            || !Array.isArray(payload.scopes)
            || payload.scopes.length !== CONSENT_SCOPES.size
            || payload.scopes.some((scope) => !safeConsentText(scope, CONSENT_SCOPE_PATTERN) || !CONSENT_SCOPES.has(scope))
            || new Set(payload.scopes).size !== payload.scopes.length
            || payload.version !== CONSENT_VERSION) {
            return { ok: false, code: "NEST_CONSENT_SET_PAYLOAD_INVALID" };
        }
        return {
            ok: true,
            value: {
                source_key: canonicalConsentSource(payload),
                account_key: payload.account_key,
                action: payload.action,
                scopes: payload.scopes.slice(),
                version: CONSENT_VERSION
            }
        };
    }

    function consentQuery(payload) {
        return ["source_key", "account_key", "version"]
            .map((key) => `${key}=${encodeURIComponent(payload[key])}`)
            .join("&");
    }

    function accountOrigins(metadata) {
        const accounts = Array.isArray(metadata?.accounts) ? metadata.accounts : [];
        return Array.from(new Set(accounts.map((account) => account?.origin).filter((origin) => typeof origin === "string")));
    }

    function validateCalendarsPayload(payload) {
        if (!isPlainObject(payload)) return { ok: false, code: "NEST_CALENDARS_PAYLOAD_INVALID" };
        const keys = Object.keys(payload);
        if (keys.some((key) => key !== "source_ref") || (keys.includes("source_ref") && !safeSourceRef(payload.source_ref))) {
            return { ok: false, code: "NEST_CALENDARS_PAYLOAD_INVALID" };
        }
        return { ok: true, value: Object.freeze(keys.includes("source_ref") ? { source_ref: payload.source_ref } : {}) };
    }

    function validateCalendarRangePayload(payload) {
        if (typeof contract?.validateCalendarRangePayload !== "function") return { ok: false, code: "NEST_CALENDAR_RANGE_CONTRACT_UNAVAILABLE" };
        return contract.validateCalendarRangePayload(payload);
    }

    function validateRoutingSetPayload(payload) {
        const keys = new Set(["source_ref", "state", "destination_calendar_id", "fallback_calendar_id"]);
        if (!hasExactOwnKeys(payload, keys)
            || !safeSourceRef(payload.source_ref)
            || (payload.state !== "incomplete" && payload.state !== "completed")
            || !safeCalendarId(payload.destination_calendar_id)
            || !safeCalendarId(payload.fallback_calendar_id, { nullable: true })) {
            return { ok: false, code: "NEST_ROUTING_PAYLOAD_INVALID" };
        }
        return {
            ok: true,
            value: Object.freeze({
                source_ref: payload.source_ref,
                state: payload.state,
                destination_calendar_id: payload.destination_calendar_id,
                fallback_calendar_id: payload.fallback_calendar_id
            })
        };
    }

    function transportBody(value) {
        if (isPlainObject(value?.body) || Array.isArray(value?.body)) return value.body;
        if (isPlainObject(value?.payload?.body) || Array.isArray(value?.payload?.body)) return value.payload.body;
        if (isPlainObject(value?.payload) || Array.isArray(value?.payload)) return value.payload;
        return isPlainObject(value) || Array.isArray(value) ? value : null;
    }

    function transportFailed(value) {
        const status = Number(value?.status);
        return value?.ok === false || (Number.isInteger(status) && status >= 400);
    }

    function safeNestFailure(value, fallback) {
        const candidate = value?.code;
        return typeof candidate === "string" && /^[A-Z][A-Z0-9_:-]{0,63}$/.test(candidate)
            && !/(?:TOKEN|COOKIE|CSRF|SECRET|PASSWORD|PROOF|LEASE|RAW|ACCOUNT|PROVIDER|EVENT|TITLE|DESCRIPTION|URL)/i.test(candidate)
            ? candidate
            : fallback;
    }

    function calendarRecord(value) {
        const keys = new Set(["id", "label", "visible", "read_only", "imported", "kind", "routing_eligible", "routing_degraded"]);
        if (!isPlainObject(value) || !hasExactOwnKeys(value, keys)
            || !safeCalendarId(value.id)
            || !safeMetadataText(value.label)
            || typeof value.visible !== "boolean"
            || typeof value.read_only !== "boolean"
            || typeof value.imported !== "boolean"
            || !safeMetadataText(value.kind, 64)
            || typeof value.routing_eligible !== "boolean"
            || typeof value.routing_degraded !== "boolean") return null;
        return {
            id: value.id,
            label: value.label,
            visible: value.visible,
            read_only: value.read_only,
            imported: value.imported,
            kind: value.kind,
            routing_eligible: value.routing_eligible,
            routing_degraded: value.routing_degraded
        };
    }

    function validateCalendarsResponse(value) {
        const body = transportBody(value);
        const keys = new Set(["contractVersion", "ok", "calendars"]);
        if (transportFailed(value) || !isPlainObject(body) || !hasExactOwnKeys(body, keys)
            || body.contractVersion !== 1 || body.ok !== true || !Array.isArray(body.calendars)) {
            return { ok: false, code: safeNestFailure(body || value, "NEST_CALENDARS_RESPONSE_INVALID") };
        }
        const calendars = body.calendars.map(calendarRecord);
        if (calendars.some((calendar) => calendar === null) || calendars.length > 256) {
            return { ok: false, code: "NEST_CALENDARS_RESPONSE_INVALID" };
        }
        return { ok: true, value: { contractVersion: 1, ok: true, calendars } };
    }

    function aliasedValue(value, names, fallback) {
        const present = names.filter((name) => Object.prototype.hasOwnProperty.call(value || {}, name));
        if (!present.length) return { present: false, value: fallback };
        const first = value[present[0]];
        return { present: true, conflict: present.some((name) => value[name] !== first), value: first };
    }

    function routingRecord(value, expectedSourceRef) {
        if (!isPlainObject(value)) return null;
        const source = aliasedValue(value, ["source_ref", "sourceRef"]);
        const destination = aliasedValue(value, ["destination_calendar_id", "destinationCalendarId"]);
        const fallback = aliasedValue(value, ["fallback_calendar_id", "fallbackCalendarId"], null);
        if (source.conflict || destination.conflict || fallback.conflict
            || (source.present && (!safeSourceRef(source.value) || source.value !== expectedSourceRef))
            || (value.state !== "incomplete" && value.state !== "completed")
            || !destination.present || !safeCalendarId(destination.value)
            || !safeCalendarId(fallback.value, { nullable: true })) return null;
        return {
            state: value.state,
            destination_calendar_id: destination.value,
            fallback_calendar_id: fallback.value
        };
    }

    function routingCandidates(body) {
        if (Array.isArray(body)) return body;
        if (!isPlainObject(body)) return null;
        if (Array.isArray(body.routing)) return body.routing;
        if (isPlainObject(body.routing)) return [body.routing];
        return [body];
    }

    function validateRoutingResponse(value, expectedSourceRef, { collection = false } = {}) {
        const body = transportBody(value);
        if (transportFailed(value)) return { ok: false, code: "NEST_ROUTING_RESPONSE_INVALID" };
        const candidates = routingCandidates(body);
        if (!candidates || candidates.length > 2 || (!collection && candidates.length !== 1)) return { ok: false, code: "NEST_ROUTING_RESPONSE_INVALID" };
        const records = { incomplete: null, completed: null };
        for (const candidate of candidates) {
            const record = routingRecord(candidate, expectedSourceRef);
            if (!record || records[record.state]) return { ok: false, code: "NEST_ROUTING_RESPONSE_INVALID" };
            records[record.state] = record;
        }
        if (collection) return { ok: true, value: records };
        const record = records.incomplete || records.completed;
        return {
            ok: true,
            value: {
                ok: true,
                contractVersion: 1,
                routing: record,
                ...(isPlainObject(body) && body.idempotent === true ? { idempotent: true } : {})
            }
        };
    }

    function sourceMetadataEntries(value) {
        const accounts = value?.accounts;
        if (!isPlainObject(accounts)) return [];
        return Object.entries(accounts).filter(([accountKey, record]) =>
            CANVAS_ACCOUNT_KEY_PATTERN.test(accountKey)
            && isPlainObject(record)
            && safeSourceRef(record.source_ref)
            && record.source_key === `canvas:${accountKey}`
            && typeof record.nest_user_id === "string"
            && NEST_USER_ID_PATTERN.test(record.nest_user_id));
    }

    function sourceMetadataFor(value, sourceRef) {
        const matches = sourceMetadataEntries(value).filter(([, record]) => record.source_ref === sourceRef);
        if (matches.length !== 1) return null;
        const [accountKey, record] = matches[0];
        if (record.active === false || record.archived === true) return null;
        return { accountKey, record };
    }

    function nestedField(value, names, seen = new Set()) {
        if (!isPlainObject(value) || seen.has(value)) return undefined;
        seen.add(value);
        for (const name of names) if (Object.prototype.hasOwnProperty.call(value, name)) {
            const result = value[name];
            seen.delete(value);
            return result;
        }
        for (const child of Object.values(value)) {
            const result = nestedField(child, names, seen);
            if (result !== undefined) {
                seen.delete(value);
                return result;
            }
        }
        seen.delete(value);
        return undefined;
    }

    function consentField(body, nested, names) {
        const values = [];
        for (const source of [body, nested]) {
            if (!isPlainObject(source)) continue;
            for (const name of names) if (Object.prototype.hasOwnProperty.call(source, name)) values.push(source[name]);
        }
        if (!values.length) return { present: false, value: undefined };
        const first = values[0];
        if (values.some((value) => Array.isArray(first) ? !Array.isArray(value) || value.length !== first.length || value.some((item, index) => item !== first[index]) : value !== first)) return { present: true, mismatch: true };
        return { present: true, value: first };
    }

    function responseContractVersion(value) {
        const aliased = aliasedValue(value, ["contractVersion", "contract_version"]);
        if (aliased.conflict || (aliased.present && (typeof aliased.value !== "number" || !Number.isInteger(aliased.value)))) return null;
        return aliased;
    }

    function consentContractVersion(value, body, consentVersion) {
        const envelope = responseContractVersion(value);
        const payload = responseContractVersion(body);
        if (!envelope || !payload || (envelope.present && payload.present && envelope.value !== payload.value)) return false;
        const version = payload.present ? payload.value : envelope.present ? envelope.value : undefined;
        return version === undefined ? consentVersion === CONSENT_VERSION : version === CONSENT_VERSION;
    }

    function normalizeConsentResponse(value, accountKey, sourceKey) {
        const body = transportBody(value);
        if (transportFailed(value) || !isPlainObject(body)) return null;
        const nested = isPlainObject(body.consent) ? body.consent : null;
        const fields = {
            version: consentField(body, nested, ["version"]),
            current: consentField(body, nested, ["current"]),
            granted: consentField(body, nested, ["granted"]),
            scopes: consentField(body, nested, ["scopes"]),
            source: consentField(body, nested, ["source_key", "sourceKey"]),
            account: consentField(body, nested, ["account_key", "accountKey"])
        };
        if (Object.values(fields).some((field) => field.mismatch)
            || !fields.version.present || fields.version.value !== CONSENT_VERSION
            || !consentContractVersion(value, body, fields.version.value)
            || !fields.current.present || typeof fields.current.value !== "boolean"
            || !fields.granted.present || typeof fields.granted.value !== "boolean"
            || !fields.scopes.present || !Array.isArray(fields.scopes.value) || fields.scopes.value.length !== CONSENT_SCOPES.size
            || new Set(fields.scopes.value).size !== CONSENT_SCOPES.size
            || fields.scopes.value.some((scope) => !CONSENT_SCOPES.has(scope))
            || !fields.source.present || fields.source.value !== sourceKey
            || sourceKey !== `canvas:${accountKey}`
            || (fields.account.present && fields.account.value !== accountKey)) return null;
        const consent = {
            version: CONSENT_VERSION,
            current: fields.current.value,
            granted: fields.granted.value,
            account_key: accountKey,
            source_key: sourceKey,
            scopes: fields.scopes.value.slice()
        };
        return {
            contractVersion: CONSENT_VERSION,
            ok: body.ok === undefined ? true : body.ok,
            consent,
            version: CONSENT_VERSION,
            current: fields.current.value,
            granted: fields.granted.value,
            account_key: accountKey,
            source_key: sourceKey,
            sourceKey,
            scopes: fields.scopes.value.slice()
        };
    }

    function activeConsentFor(value, accountKey, sourceKey) {
        const normalized = normalizeConsentResponse(value, accountKey, sourceKey);
        return Boolean(normalized?.ok === true && normalized.current === true && normalized.granted === true);
    }

    function calendarBindingForOrigin(state, origin) {
        const accounts = Array.isArray(state.accountMetadata?.accounts)
            ? state.accountMetadata.accounts.filter((account) => account?.origin === origin)
            : [];
        const sourceEntries = sourceMetadataEntries(state.sourceMetadata).filter(([, record]) =>
            record.origin === origin && record.active !== false && record.archived !== true);
        if (accounts.length !== 1 || sourceEntries.length !== 1) return { ok: false, code: "CANVAS_ACCOUNT_BINDING_REQUIRED" };
        const [accountKey, record] = sourceEntries[0];
        const declaredAccount = accounts[0].accountKey ?? accounts[0].account_key;
        if (record.source_key !== `canvas:${accountKey}` || (declaredAccount !== undefined && declaredAccount !== accountKey)) return { ok: false, code: "CANVAS_ACCOUNT_MISMATCH" };
        return { ok: true, accountKey, sourceRef: record.source_ref, record };
    }

    function exactCanvasCalendarPage(sender, origin) {
        try {
            const url = new URL(sender?.url || "");
            return url.origin === origin && url.pathname === CALENDAR_ROUTE_PATH && !url.hash;
        } catch (error) {
            return false;
        }
    }

    function calendarRangeFailure(value) {
        const status = Number(value?.status);
        if (status === 401 || value?.body?.state === "signed_out" || value?.body?.status === "signed_out") return "NEST_SIGNED_OUT";
        if (status === 419 || value?.body?.state === "expired" || value?.body?.status === "expired") return "NEST_SESSION_EXPIRED";
        if (!value || status === 0 || [502, 503, 504].includes(status)) return "NEST_UNAVAILABLE";
        return "NEST_CALENDAR_RANGE_UNAVAILABLE";
    }

    function validateCalendarRangeResponse(value, allowedCanvasOrigins, transportApi) {
        if (transportFailed(value)) return { ok: false, code: calendarRangeFailure(value) };
        const body = transportBody(value);
        if (!isPlainObject(body)) return { ok: false, code: "NEST_CALENDAR_RANGE_RESPONSE_INVALID" };
        if (body.contractVersion !== 1) return { ok: false, code: "NEST_CALENDAR_RANGE_VERSION_UNSUPPORTED" };
        if (body.ok !== true) {
            const state = body.state || body.status;
            if (state === "signed_out") return { ok: false, code: "NEST_SIGNED_OUT" };
            if (state === "expired") return { ok: false, code: "NEST_SESSION_EXPIRED" };
            return { ok: false, code: "NEST_CALENDAR_RANGE_UNAVAILABLE" };
        }
        if (typeof transportApi?.sanitizeCalendarRangeResponse !== "function") return { ok: false, code: "NEST_CALENDAR_RANGE_SANITIZER_UNAVAILABLE" };
        const sanitized = transportApi.sanitizeCalendarRangeResponse(body, { allowedCanvasOrigins });
        if (!isPlainObject(sanitized) || sanitized.contractVersion !== 1 || sanitized.ok !== true || !Array.isArray(sanitized.events)) {
            return { ok: false, code: "NEST_CALENDAR_RANGE_RESPONSE_INVALID" };
        }
        return { ok: true, value: sanitized };
    }

    async function authorizeCalendarRange(state, sender, requestId, messageContract) {
        const origin = messageContractOrigin(state, sender, messageContract);
        if (!origin || !exactCanvasCalendarPage(sender, origin)) return { ok: false, code: "SENDER_CANVAS_CALENDAR_REQUIRED" };
        const binding = calendarBindingForOrigin(state, origin);
        if (!binding.ok) return binding;
        const identityResponse = await state.transport?.identityGet?.({ requestId });
        const identityBody = transportBody(identityResponse);
        if (transportFailed(identityResponse)) {
            if (Number(identityResponse?.status) === 401) return { ok: false, code: "NEST_SIGNED_OUT" };
            if (Number(identityResponse?.status) === 419) return { ok: false, code: "NEST_SESSION_EXPIRED" };
            if ([502, 503, 504].includes(Number(identityResponse?.status)) || Number(identityResponse?.status) === 0) return { ok: false, code: "NEST_UNAVAILABLE" };
            return { ok: false, code: "NEST_AUTHENTICATION_REQUIRED" };
        }
        if (!isPlainObject(identityBody)) return { ok: false, code: "NEST_AUTHENTICATION_REQUIRED" };
        const identityState = nestedField(identityBody, ["state", "status"]);
        if (identityState === "signed_out" || identityState === "expired") return { ok: false, code: identityState === "expired" ? "NEST_SESSION_EXPIRED" : "NEST_SIGNED_OUT" };
        if (identityBody.authenticated !== true && identityState !== "authenticated") return { ok: false, code: "NEST_AUTHENTICATION_REQUIRED" };
        const identityAccount = nestedField(identityBody, ["account_key", "accountKey"]);
        if (identityAccount !== binding.accountKey) return { ok: false, code: "NEST_ACCOUNT_MISMATCH" };
        const sourceKey = `canvas:${binding.accountKey}`;
        const consentResponse = await state.transport?.request?.({
            method: "GET",
            path: `/api/extension/consent?source_key=${encodeURIComponent(sourceKey)}&account_key=${binding.accountKey}&version=${CONSENT_VERSION}`,
            headers: { Accept: "application/json", "X-Request-ID": requestId }
        }, { requestId });
        if (transportFailed(consentResponse)) {
            if (Number(consentResponse?.status) === 401) return { ok: false, code: "NEST_SIGNED_OUT" };
            if (Number(consentResponse?.status) === 419) return { ok: false, code: "NEST_SESSION_EXPIRED" };
            if ([502, 503, 504].includes(Number(consentResponse?.status)) || Number(consentResponse?.status) === 0) return { ok: false, code: "NEST_UNAVAILABLE" };
        }
        if (!activeConsentFor(consentResponse, binding.accountKey, sourceKey)) return { ok: false, code: "NEST_CURRENT_READ_CONSENT_REQUIRED" };
        return { ok: true, origin, ...binding };
    }

    function normalizedAccountKey(value) {
        const candidate = typeof value === "string" ? value.trim().toLowerCase() : "";
        return CONSENT_ACCOUNT_PATTERN.test(candidate) ? candidate : null;
    }

    function recordAccountKey(value) {
        if (!value || typeof value !== "object") return null;
        const direct = value.accountKey ?? value.account_key;
        const normalized = normalizedAccountKey(direct);
        if (normalized) return normalized;
        const source = value.source_key ?? value.sourceKey;
        const match = typeof source === "string" ? source.match(/^canvas:([a-f0-9]{64})$/i) : null;
        return match ? match[1].toLowerCase() : null;
    }

    function sanitizedRevocationSummary(state, now = () => Date.now()) {
        const fullyRevoked = state === "revoked";
        const serverRevoked = fullyRevoked || state === "server_revoked_local_cleanup_pending";
        const safeState = fullyRevoked ? "revoked" : "revoke_pending";
        const timestamp = now();
        return {
            version: 1,
            state: safeState,
            retry_required: !fullyRevoked,
            revoke_pending: !fullyRevoked,
            server_revoked: serverRevoked,
            local_cleanup_pending: serverRevoked && !fullyRevoked,
            local_stopped: true,
            updated_at: Number.isFinite(timestamp) ? timestamp : Date.now()
        };
    }

    function createRevocationCleanupCoordinator({ storage, outbox, alarms, syncStorage, now = () => Date.now() } = {}) {
        if (!storage || typeof storage.get !== "function" || typeof storage.set !== "function") throw new Error("REVOCATION_STORAGE_REQUIRED");

        async function updateSummary(accountKey, state) {
            const stored = await storage.get("local", "platform.revocationSummaries");
            const current = stored["platform.revocationSummaries"];
            const accounts = current && typeof current === "object" && !Array.isArray(current) && current.accounts && typeof current.accounts === "object" && !Array.isArray(current.accounts)
                ? { ...current.accounts }
                : {};
            accounts[accountKey] = sanitizedRevocationSummary(state, now);
            await storage.set("local", { "platform.revocationSummaries": { version: 1, accounts } });
            return accounts[accountKey];
        }

        async function clearAccountMetadata(accountKey) {
            const local = await storage.get("local", ["canvas_sync_opt_in", SOURCE_METADATA_KEY, "platform.accountMetadata"]);
            const optIns = normalizeAccountOptIns(local.canvas_sync_opt_in);
            optIns[accountKey] = false;
            const sourceMetadata = local[SOURCE_METADATA_KEY];
            if (sourceMetadata && typeof sourceMetadata === "object" && sourceMetadata.accounts && typeof sourceMetadata.accounts === "object" && !Array.isArray(sourceMetadata.accounts)) {
                const accounts = Object.fromEntries(Object.entries(sourceMetadata.accounts).filter(([key]) => key !== accountKey));
                await storage.set("local", { [SOURCE_METADATA_KEY]: { version: 1, accounts } });
            }
            const accountMetadata = local["platform.accountMetadata"];
            if (accountMetadata && Array.isArray(accountMetadata.accounts)) {
                const accounts = accountMetadata.accounts.filter((record) => recordAccountKey(record) !== accountKey);
                await storage.set("local", { "platform.accountMetadata": { ...accountMetadata, accounts } });
            }
            await storage.set("local", { canvas_sync_opt_in: optIns });
        }

        async function clearSessionMappings(accountKey) {
            const session = await storage.get("session", ["platform.currentProfile", "platform.tabWindowMappings"]);
            if (recordAccountKey(session["platform.currentProfile"]) === accountKey) await storage.remove("session", "platform.currentProfile");
            const mappings = session["platform.tabWindowMappings"];
            if (!mappings || typeof mappings !== "object" || Array.isArray(mappings)) return;
            const next = Object.fromEntries(Object.entries(mappings).filter(([key, value]) => key !== accountKey && recordAccountKey(value) !== accountKey));
            if (JSON.stringify(next) !== JSON.stringify(mappings)) {
                if (Object.keys(next).length) await storage.set("session", { "platform.tabWindowMappings": next });
                else await storage.remove("session", "platform.tabWindowMappings");
            }
        }

        async function cleanup(accountKeyInput) {
            const accountKey = normalizedAccountKey(accountKeyInput);
            if (!accountKey) return { ok: false, state: "revoke_pending", code: "CANVAS_ACCOUNT_KEY_INVALID", retry_required: true, revoke_pending: true };
            let failed = false;
            for (const operation of [
                () => outbox?.revokeAccount?.({ accountKey }),
                () => alarms?.cancelAccount?.(accountKey),
                () => syncStorage?.revokeAccount?.(accountKey),
                () => clearAccountMetadata(accountKey),
                () => clearSessionMappings(accountKey)
            ]) {
                try { await operation(); } catch (error) { failed = true; }
            }
            let summary;
            try {
                summary = await updateSummary(accountKey, "revoke_pending");
            } catch (error) {
                failed = true;
                summary = sanitizedRevocationSummary("revoke_pending", now);
            }
            return { ok: !failed, accountKey, retry_required: failed, revoke_pending: failed, local_cleanup_pending: failed, ...summary };
        }

        async function mark(accountKeyInput, state) {
            const accountKey = normalizedAccountKey(accountKeyInput);
            return accountKey ? updateSummary(accountKey, state) : null;
        }

        return Object.freeze({ cleanup, mark, updateSummary });
    }

    function responseBody(value) {
        if (!value || typeof value !== "object") return null;
        if (value.body && typeof value.body === "object" && !Array.isArray(value.body)) return value.body;
        if (value.payload?.body && typeof value.payload.body === "object" && !Array.isArray(value.payload.body)) return value.payload.body;
        if (value.payload && typeof value.payload === "object" && !Array.isArray(value.payload)) return value.payload;
        return value;
    }

    function successfulConsentRevoke(value, accountKey, sourceKey) {
        if (!value || typeof value !== "object" || value.ok === false || Number(value.status) >= 400) return false;
        const body = responseBody(value);
        if (body?.ok === false) return false;
        const returnedAccount = body?.account_key ?? body?.accountKey;
        const returnedSource = body?.source_key ?? body?.sourceKey;
        return (returnedAccount === undefined || returnedAccount === accountKey)
            && (returnedSource === undefined || returnedSource === sourceKey);
    }

    function messageContractOrigin(state, sender, messageContract) {
        const origin = messageContract?.senderOrigin?.(sender);
        return state?.configuredOrigins?.includes?.(origin) ? origin : null;
    }

    async function authorizeRoutingSource(state, sourceRef, requestId) {
        const metadata = sourceMetadataFor(state.sourceMetadata, sourceRef);
        if (!metadata) return { ok: false, code: "NEST_SOURCE_REF_INVALID" };
        const { accountKey, record } = metadata;
        if (record.routing_eligible === false) return { ok: false, code: "NEST_ROUTING_NOT_ELIGIBLE" };
        const identityResponse = await state.transport?.identityGet?.({ requestId });
        const identityBody = transportBody(identityResponse);
        if (transportFailed(identityResponse) || !isPlainObject(identityBody)) return { ok: false, code: "NEST_AUTHENTICATION_REQUIRED" };
        const identityState = nestedField(identityBody, ["state", "status"]);
        if (identityState === "signed_out" || (identityBody.authenticated !== true && identityState !== "authenticated")) {
            return { ok: false, code: "NEST_AUTHENTICATION_REQUIRED" };
        }
        const identityUserId = nestedField(identityBody, ["user_id", "userId", "userid"]);
        if (typeof identityUserId !== "string" || !NEST_USER_ID_PATTERN.test(identityUserId)
            || identityUserId !== record.nest_user_id) return { ok: false, code: "NEST_IDENTITY_MISMATCH" };
        const sourceKey = `canvas:${accountKey}`;
        const consentResponse = await state.transport?.request?.({
            method: "GET",
            path: `/api/extension/consent?source_key=${encodeURIComponent(sourceKey)}&account_key=${accountKey}&version=${CONSENT_VERSION}`,
            headers: { Accept: "application/json", "X-Request-ID": requestId }
        }, { requestId });
        if (!activeConsentFor(consentResponse, accountKey, sourceKey)) return { ok: false, code: "NEST_CURRENT_READ_CONSENT_REQUIRED" };
        return { ok: true, accountKey, sourceRef, record };
    }

    function createRouter({
        chromeApi = globalThis.chrome,
        storage,
        transport,
        fullscreen,
        idb,
        canvasRegistration,
        canvasSync,
        withCanvasSyncAccount,
        revocationCleanup,
        featureFlags = FALLBACK_FLAGS,
        now = () => Date.now(),
        messageContract = contract
    } = {}) {
        if (!messageContract) throw new Error("PLATFORM_CONTRACT_UNAVAILABLE");
        if (!storage) throw new Error("PLATFORM_STORAGE_UNAVAILABLE");

        async function context() {
            const suppliedFlags = typeof contract.normalizeFeatureFlags === "function"
                ? contract.normalizeFeatureFlags(featureFlags, FALLBACK_FLAGS)
                : Object.assign({}, FALLBACK_FLAGS, featureFlags || {});
            const [sync, local, flags] = await Promise.all([
                storage.get("sync", ["custom_domain", "platform.routing"]),
                storage.get("local", ["platform.accountMetadata", "canvas_sync_opt_in", SOURCE_METADATA_KEY]),
                typeof storage.readFlags === "function" ? storage.readFlags(suppliedFlags) : suppliedFlags
            ]);
            const optIns = normalizeAccountOptIns(local.canvas_sync_opt_in);
            return {
                configuredOrigins: messageContract.normalizeCanvasOrigins(sync.custom_domain),
                verifiedOrigins: accountOrigins(local["platform.accountMetadata"]),
                accountMetadata: local["platform.accountMetadata"],
                accountOptIn: optIns,
                sourceMetadata: local[SOURCE_METADATA_KEY],
                transport,
                flags: typeof contract.normalizeFeatureFlags === "function"
                    ? contract.normalizeFeatureFlags(flags, suppliedFlags)
                    : Object.assign({}, suppliedFlags, flags || {})
            };
        }

        function accountOptedIn(state, payload) {
            const accountKey = accountKeyFromPayload(payload);
            return accountKey !== null && state.accountOptIn?.[accountKey] === true;
        }

        async function senderKind(message, sender) {
            const state = await context();
            return {
                state,
                decision: messageContract.classifySender(sender, {
                    runtimeApi: chromeApi?.runtime,
                    configuredOrigins: state.configuredOrigins,
                    verifiedOrigins: state.verifiedOrigins,
                    allowUnverifiedCanvas: message.type === "CANVAS_ACCOUNT_VERIFY"
                })
            };
        }

        function response(request, payload) {
            return messageContract.createResponse(request, payload);
        }

        function invalidResponse(validation) {
            return { version: 1, request_id: null, type: "ERROR", payload: errorPayload(validation.code) };
        }

    function featureResponse(request, flag) {
        return response(request, errorPayload(FEATURE_CODES[flag] || "FEATURE_DISABLED"));
    }

    function safeSyncCode(value, fallback = "CANVAS_SYNC_FAILED") {
        return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_:-]{0,63}$/.test(value)
            && !/(?:TAB|WINDOW|URL|URI|HEADER|TOKEN|COOKIE|CSRF|SECRET|PASSWORD|PROOF|LEASE|RAW|ACCOUNT|PROVIDER|EVENT)/i.test(value)
            ? value
            : fallback;
    }

    function safeSyncCounts(value, depth = 0, seen = new Set()) {
        if (depth > 5) return undefined;
        if (Number.isSafeInteger(value) && value >= 0) return value;
        if (typeof value === "boolean" || value === null) return value;
        if (!value || typeof value !== "object" || seen.has(value)) return undefined;
        seen.add(value);
        let output;
        if (Array.isArray(value)) {
            output = value.map((item) => safeSyncCounts(item, depth + 1, seen));
            if (output.some((item) => item === undefined)) {
                seen.delete(value);
                return undefined;
            }
        } else {
            output = {};
            for (const [key, item] of Object.entries(value)) {
                if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/.test(key) || PUBLIC_SYNC_FORBIDDEN_KEYS.has(key.replace(/[^A-Za-z0-9]/g, "").toLowerCase())) {
                    seen.delete(value);
                    return undefined;
                }
                const safe = safeSyncCounts(item, depth + 1, seen);
                if (safe === undefined) {
                    seen.delete(value);
                    return undefined;
                }
                output[key] = safe;
            }
        }
        seen.delete(value);
        return output;
    }

    function safePublicSyncResult(value) {
        const source = value && typeof value === "object" ? value : {};
        const output = {};
        if (typeof source.state === "string") output.state = safeSyncCode(source.state, "unavailable");
        if (Object.prototype.hasOwnProperty.call(source, "counts")) {
            const counts = safeSyncCounts(source.counts);
            if (counts !== undefined) output.counts = counts;
        }
        if (Object.prototype.hasOwnProperty.call(source, "count") && Number.isSafeInteger(source.count) && source.count >= 0) output.count = source.count;
        const error = source.errorCode ?? source.code ?? source.error?.code;
        if (error !== undefined) output.errorCode = error === null ? null : safeSyncCode(error);
        const sourceRef = safeSourceRef(source.source_ref)
            ? source.source_ref
            : safeSourceRef(source.sourceRef)
                ? source.sourceRef
                : safeSourceRef(source.binding?.source_ref)
                    ? source.binding.source_ref
                    : null;
        if (sourceRef) output.source_ref = sourceRef;
        if (!Object.keys(output).length) output.state = "unavailable";
        return output;
    }

    function publicSyncInputError(value, seen = new Set()) {
        if (!value || typeof value !== "object") return null;
        if (seen.has(value)) return "CANVAS_SYNC_PAYLOAD_INVALID";
        seen.add(value);
        for (const key of Object.keys(value)) {
            const normalized = key.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
            if (normalized === "tabid" || normalized === "windowid") return "REQUEST_CONTEXT_FORBIDDEN";
            if (PUBLIC_SYNC_INPUT_FORBIDDEN_KEYS.has(normalized)) return "CANVAS_SYNC_PAYLOAD_INVALID";
            const nested = publicSyncInputError(value[key], seen);
            if (nested) return nested;
        }
        seen.delete(value);
        return null;
    }

    function exactSyncExtensionPage(sender, runtimeApi, messageContract) {
        if (!messageContract.isExactExtensionSender(sender, messageContract.extensionOrigin(runtimeApi))) return false;
        try {
            const url = new URL(sender?.url || "");
            return (url.pathname === "/html/popup.html" || url.pathname === "/popup.html") && !url.hash;
        } catch (error) {
            return false;
        }
    }

    async function activeCanvasTabId(chromeApi, state, messageContract) {
        if (!chromeApi?.tabs?.query) return null;
        let tabs = [];
        try {
            tabs = await chromeApi.tabs.query({ active: true, lastFocusedWindow: true });
        } catch (error) {
            try { tabs = await chromeApi.tabs.query({ active: true, currentWindow: true }); } catch (fallbackError) { return null; }
        }
        for (const tab of Array.isArray(tabs) ? tabs : []) {
            if (!Number.isInteger(tab?.id)) continue;
            const origin = messageContract.senderOrigin({ url: tab.url || "" });
            const isDefaultCanvas = origin === "https://canvas.emory.edu";
            if (origin && (isDefaultCanvas || state.configuredOrigins.includes(origin))) return tab.id;
        }
        return null;
    }

        async function verifyCanvasAccount(request, sender, state) {
            const origin = messageContract.senderOrigin(sender);
            if (!state.configuredOrigins.includes(origin)) return errorPayload("CANVAS_ORIGIN_NOT_CONFIGURED");
            const accountId = cleanString(request.payload.account_id || request.payload.accountId, 128);
            if (!accountId || !/^[A-Za-z0-9._:@-]+$/.test(accountId)) return errorPayload("CANVAS_ACCOUNT_ID_INVALID");
            const displayName = cleanString(request.payload.display_name || request.payload.displayName, 120);
            const existing = await storage.get("local", "platform.accountMetadata");
            const accounts = Array.isArray(existing["platform.accountMetadata"]?.accounts) ? existing["platform.accountMetadata"].accounts.slice() : [];
            const nextAccount = { origin, accountId, ...(displayName ? { displayName } : {}), verifiedAt: now() };
            const nextAccounts = accounts.filter((account) => account?.origin !== origin);
            nextAccounts.push(nextAccount);
            await storage.set("local", { "platform.accountMetadata": { version: 1, accounts: nextAccounts.slice(-20) } });
            return okPayload({ account: nextAccount });
        }

        async function recordExtensionCanvasAccount(request, state) {
            const origin = messageContract.normalizeOrigin(request.payload.origin || "");
            if (!origin || !state.configuredOrigins.includes(origin)) return errorPayload("CANVAS_ORIGIN_NOT_CONFIGURED");
            const accountId = cleanString(request.payload.account_id || request.payload.accountId, 128);
            if (!accountId || !/^[A-Za-z0-9._:@-]+$/.test(accountId)) return errorPayload("CANVAS_ACCOUNT_ID_INVALID");
            const displayName = cleanString(request.payload.display_name || request.payload.displayName, 120);
            const existing = await storage.get("local", "platform.accountMetadata");
            const accounts = Array.isArray(existing["platform.accountMetadata"]?.accounts) ? existing["platform.accountMetadata"].accounts.slice() : [];
            const account = { origin, accountId, ...(displayName ? { displayName } : {}), verifiedAt: now() };
            const nextAccounts = accounts.filter((item) => item?.origin !== origin);
            nextAccounts.push(account);
            await storage.set("local", { "platform.accountMetadata": { version: 1, accounts: nextAccounts.slice(-20) } });
            return okPayload({ account });
        }

        async function removeCanvasAccountMetadata(origins) {
            if (!origins.length) return;
            const existing = await storage.get("local", "platform.accountMetadata");
            const metadata = existing["platform.accountMetadata"];
            if (!Array.isArray(metadata?.accounts)) return;
            const removed = new Set(origins);
            const accounts = metadata.accounts.filter((account) => !removed.has(account?.origin));
            if (accounts.length !== metadata.accounts.length) {
                await storage.set("local", { "platform.accountMetadata": { version: 1, accounts } });
            }
        }

        async function handleSettings(request) {
            if (request.type === "SETTINGS_READ") {
                const area = request.payload.area || "local";
                const keys = request.payload.keys;
                if (!Array.isArray(keys) || !keys.length) return errorPayload("SETTINGS_KEYS_REQUIRED");
                if (typeof storage.settingsRead !== "function") return errorPayload("SETTINGS_STORAGE_UNAVAILABLE");
                return storage.settingsRead(area, keys);
            }
            if (request.type === "SETTINGS_UPDATE") {
                const area = request.payload.area || "local";
                const changes = request.payload.changes;
                if (!changes || typeof changes !== "object" || Array.isArray(changes)) return errorPayload("SETTINGS_CHANGES_REQUIRED");
                if (typeof storage.settingsUpdate !== "function") return errorPayload("SETTINGS_STORAGE_UNAVAILABLE");
                const customDomainChange = Object.prototype.hasOwnProperty.call(changes, "custom_domain");
                if (customDomainChange && request.payload.user_gesture !== true) return errorPayload("SETTINGS_USER_GESTURE_REQUIRED");
                const persistOnly = customDomainChange && request.payload.canvas_transaction === "persist_only";
                const before = customDomainChange ? (await context()).configuredOrigins : [];
                const next = customDomainChange ? messageContract.normalizeCanvasOrigins(changes.custom_domain) : [];
                if (customDomainChange) {
                    const rawDomains = Array.isArray(changes.custom_domain) ? changes.custom_domain : [];
                    const nonEmptyDomains = rawDomains.filter((item) => String(item || "").trim());
                    if (!Array.isArray(changes.custom_domain) || next.length !== nonEmptyDomains.length || new Set(next).size !== next.length) {
                        return { ok: false, area, code: "SETTINGS_VALUE_INVALID", results: { custom_domain: { ok: false, code: "SETTINGS_VALUE_INVALID" } } };
                    }
                }
                const additions = next.filter((origin) => !before.includes(origin));
                const removals = before.filter((origin) => !next.includes(origin));
                const dynamicRemovals = removals.filter((origin) => origin !== "https://canvas.emory.edu");
                const dynamicTargets = next.filter((origin) => origin !== "https://canvas.emory.edu");
                const registeredAdditions = [];
                if (customDomainChange && !persistOnly && (dynamicTargets.length || dynamicRemovals.length)) {
                    if (!canvasRegistration || (!canvasRegistration.apiAvailable?.() || (dynamicRemovals.length && !chromeApi?.permissions?.remove))) return { ok: false, area, code: "browser_unsupported", results: Object.fromEntries(Object.keys(changes).map((key) => [key, { ok: false, code: "browser_unsupported" }])) };
                    for (const origin of dynamicTargets) {
                        const registration = await canvasRegistration.ensureOrigin(origin, { configuredOrigins: next });
                        if (!registration.ok) return { ok: false, area, code: registration.code || "permission_required", results: Object.fromEntries(Object.keys(changes).map((key) => [key, { ok: false, code: registration.code || "permission_required" }])) };
                        if (registration.state === "registered") registeredAdditions.push(origin);
                    }
                }
                const result = await storage.settingsUpdate(area, changes, { requireUserGesture: request.payload.user_gesture === true });
                if (!result.ok) {
                    for (const origin of registeredAdditions) await canvasRegistration.unregisterOrigin(origin).catch(() => {});
                    return result;
                }
                if (customDomainChange && !persistOnly) {
                    for (const origin of dynamicRemovals) {
                        const removed = await canvasRegistration.unregisterOrigin(origin);
                        if (!removed.ok) return { ok: false, area, code: removed.code || "browser_unsupported", results: Object.fromEntries(Object.keys(changes).map((key) => [key, { ok: false, code: removed.code || "browser_unsupported" }])) };
                        try {
                            const permissionRemoved = await chromeApi.permissions.remove({ origins: [canvasRegistration.patternForOrigin(origin)] });
                            if (!permissionRemoved) return { ok: false, area, code: "browser_unsupported", results: Object.fromEntries(Object.keys(changes).map((key) => [key, { ok: false, code: "browser_unsupported" }])) };
                        } catch (error) {
                            return { ok: false, area, code: "browser_unsupported", results: Object.fromEntries(Object.keys(changes).map((key) => [key, { ok: false, code: "browser_unsupported" }])) };
                        }
                    }
                    await removeCanvasAccountMetadata(dynamicRemovals);
                }
                return result;
            }
            const area = request.payload.area || "local";
            const keys = Array.isArray(request.payload.keys) ? request.payload.keys : [];
            if (!keys.length) return errorPayload("SETTINGS_RESET_KEYS_REQUIRED");
            if (typeof storage.settingsReset !== "function") return errorPayload("SETTINGS_STORAGE_UNAVAILABLE");
            return storage.settingsReset(area, keys);
        }

        async function handleNest(request, state) {
            if (!transport) return errorPayload("NEST_TRANSPORT_UNAVAILABLE");
            if (request.type === "NEST_IDENTITY_GET") {
                if (state.flags.identity === false) return errorPayload(FEATURE_CODES.identity);
                return transport.identityGet({ requestId: request.request_id });
            }
            if (request.type === "NEST_CONSENT_GET") {
                const validated = validateConsentGetPayload(request.payload);
                if (!validated.ok) return errorPayload(validated.code);
                const responseValue = await transport.request({
                    method: "GET",
                    path: `/api/extension/consent?${consentQuery(validated.value)}`,
                    headers: { Accept: "application/json", "X-Request-ID": request.request_id }
                }, { requestId: request.request_id });
                const body = transportBody(responseValue);
                const looksLikeConsent = isPlainObject(body) && (body.consent !== undefined
                    || ["version", "current", "granted", "scopes", "source_key", "sourceKey"].some((key) => Object.prototype.hasOwnProperty.call(body, key)));
                if (looksLikeConsent) {
                    const normalized = normalizeConsentResponse(responseValue, validated.value.account_key, validated.value.source_key);
                    if (!normalized) return errorPayload("NEST_CONSENT_RESPONSE_INVALID");
                    return { ...responseValue, body: normalized };
                }
                return responseValue;
            }
            if (request.type === "NEST_CONSENT_SET") {
                const validated = validateConsentSetPayload(request.payload);
                if (!validated.ok) return errorPayload(validated.code);
                const mutation = {
                    method: "PUT",
                    path: "/api/extension/consent",
                    body: validated.value,
                    headers: { Accept: "application/json" }
                };
                if (validated.value.action === "grant") {
                    return transport.mutate(mutation, { requestId: request.request_id, idempotent: true });
                }
                const cleanup = revocationCleanup || createRevocationCleanupCoordinator({ storage });
                const accountKey = validated.value.account_key;
                const sourceKey = validated.value.source_key;
                let cleanupResult;
                try {
                    cleanupResult = await cleanup.cleanup(accountKey);
                } catch (error) {
                    cleanupResult = { ok: false };
                }
                let result;
                try {
                    result = await transport.mutate(mutation, { requestId: request.request_id, idempotent: true });
                } catch (error) {
                    await cleanup.mark(accountKey, "revoke_pending").catch(() => {});
                    return errorPayload("NEST_REVOKE_RETRY_REQUIRED");
                }
                if (!successfulConsentRevoke(result, accountKey, sourceKey)) {
                    await cleanup.mark(accountKey, "revoke_pending").catch(() => {});
                    return errorPayload("NEST_REVOKE_RETRY_REQUIRED");
                }
                if (!cleanupResult?.ok) {
                    let summary = null;
                    try { summary = await cleanup.mark(accountKey, "server_revoked_local_cleanup_pending"); } catch (error) {}
                    return {
                        ok: false,
                        code: "SERVER_REVOKED_LOCAL_CLEANUP_PENDING",
                        state: "revoke_pending",
                        server_revoked: true,
                        local_cleanup_pending: true,
                        retry_required: true,
                        revoke_pending: true,
                        ...(summary && typeof summary === "object" ? summary : {})
                    };
                }
                let summary;
                try { summary = await cleanup.mark(accountKey, "revoked"); } catch (error) { summary = null; }
                if (!summary) {
                    try { await cleanup.mark(accountKey, "server_revoked_local_cleanup_pending"); } catch (error) {}
                    return errorPayload("SERVER_REVOKED_LOCAL_CLEANUP_PENDING");
                }
                return { ok: true, state: "revoked", revoked: true };
            }
            if (request.type === "NEST_CALENDARS_GET") {
                const validated = validateCalendarsPayload(request.payload);
                if (!validated.ok) return errorPayload(validated.code);
                if (state.flags.projection === false) return errorPayload(FEATURE_CODES.projection);
                const calendarsResponse = await transport.request({ method: "GET", path: "/api/extension/calendars", headers: { Accept: "application/json", "X-Request-ID": request.request_id } }, { requestId: request.request_id });
                const calendars = validateCalendarsResponse(calendarsResponse);
                if (!calendars.ok) return errorPayload(calendars.code);
                if (!validated.value.source_ref) return calendars.value;
                const authorization = await authorizeRoutingSource(state, validated.value.source_ref, request.request_id);
                if (!authorization.ok) return errorPayload(authorization.code);
                const routingResponse = await transport.request({
                    method: "GET",
                    path: `/api/extension/calendar/sources/${encodeURIComponent(validated.value.source_ref)}/routing`,
                    headers: { Accept: "application/json", "X-Request-ID": request.request_id }
                }, { requestId: request.request_id });
                const routing = validateRoutingResponse(routingResponse, validated.value.source_ref, { collection: true });
                if (!routing.ok) return errorPayload(routing.code);
                return { ...calendars.value, source_ref: validated.value.source_ref, routing: routing.value };
            }
            if (request.type === "NEST_CALENDAR_RANGE_GET") {
                const validated = validateCalendarRangePayload(request.payload);
                if (!validated.ok) return errorPayload(validated.code);
                if (state.flags.projection === false) return errorPayload(FEATURE_CODES.projection);
                if (state.flags.overlay === false) return errorPayload(FEATURE_CODES.overlay);
                const authorization = await authorizeCalendarRange(state, request.sender, request.request_id, messageContract);
                if (!authorization.ok) return errorPayload(authorization.code);
                const path = typeof messageContract.buildCalendarRangePath === "function"
                    ? messageContract.buildCalendarRangePath(validated.value.start, validated.value.end)
                    : null;
                if (!path) return errorPayload("NEST_CALENDAR_RANGE_CONTRACT_UNAVAILABLE");
                const responseValue = await transport.request({
                    method: "GET",
                    path,
                    headers: { Accept: "application/json", "X-Request-ID": request.request_id }
                }, { requestId: request.request_id });
                const result = validateCalendarRangeResponse(responseValue, [authorization.origin], transport);
                return result.ok ? result.value : errorPayload(result.code);
            }
            if (request.type === "NEST_ROUTING_SET") {
                const validated = validateRoutingSetPayload(request.payload);
                if (!validated.ok) return errorPayload(validated.code);
                if (state.flags.projection === false) return errorPayload(FEATURE_CODES.projection);
                const authorization = await authorizeRoutingSource(state, validated.value.source_ref, request.request_id);
                if (!authorization.ok) return errorPayload(authorization.code);
                const responseValue = await transport.mutate({
                    method: "PUT",
                    path: `/api/extension/calendar/sources/${encodeURIComponent(validated.value.source_ref)}/routing`,
                    body: {
                        state: validated.value.state,
                        destination_calendar_id: validated.value.destination_calendar_id,
                        fallback_calendar_id: validated.value.fallback_calendar_id
                    },
                    headers: { Accept: "application/json" }
                }, { requestId: request.request_id, idempotent: true, idempotencyKey: request.request_id });
                const routing = validateRoutingResponse(responseValue, validated.value.source_ref);
                if (!routing.ok) return errorPayload(routing.code);
                return routing.value;
            }
            if (request.type === "NEST_EVENT_OVERRIDE_SET") {
                if (state.flags.overlay === false) return errorPayload(FEATURE_CODES.overlay);
                if (state.flags.replacement === false) return errorPayload(FEATURE_CODES.replacement);
                return transport.mutate({ method: "PUT", path: "/api/extension/events/override", body: request.payload, headers: { Accept: "application/json" } }, { requestId: request.request_id, idempotent: true });
            }
            if (request.type === "NEST_EVENT_MUTATE") {
                if (state.flags.mutation === false) return errorPayload(FEATURE_CODES.mutation);
                return transport.mutate({ method: "POST", path: "/api/extension/events/mutate", body: request.payload, headers: { Accept: "application/json" } }, { requestId: request.request_id, idempotent: false });
            }
            return errorPayload("UNSUPPORTED_FAMILY");
        }

        async function handleCanvas(request, state) {
            const feature = request.type.startsWith("CANVAS_SYNC_")
                ? "upload"
                : request.type === "CANVAS_WRITEBACK_RESULT" ? "mutation" : "mirroring";
            if (state.flags[feature] === false) return errorPayload(FEATURE_CODES[feature]);
            return errorPayload("UNSUPPORTED_FAMILY");
        }

        async function handle(request, sender) {
            if (request?.type === "GET_CANVAS_CONTEXT" && request.version === 1 && typeof request.requestId === "string") {
                return { ok: false, state: "unsupported", code: "COMPAT_DIRECT_CONTENT_ONLY" };
            }
            const validation = messageContract.validateEnvelope(request);
            if (!validation.ok) return invalidResponse(validation);
            const envelope = validation.value;
            let senderResult;
            try {
                senderResult = await senderKind(envelope, sender);
            } catch (error) {
                return response(envelope, errorPayload("SENDER_VALIDATION_UNAVAILABLE"));
            }
            const { state, decision } = senderResult;
            if (!decision.ok) return response(envelope, errorPayload(decision.code));
            if (envelope.type === "NEST_CALENDAR_RANGE_GET") {
                if (decision.kind !== "canvas") return response(envelope, errorPayload("SENDER_CANVAS_REQUIRED"));
                if (!exactCanvasCalendarPage(sender, decision.origin)) return response(envelope, errorPayload("SENDER_CANVAS_CALENDAR_REQUIRED"));
                if (state.flags.projection === false) return featureResponse(envelope, "projection");
                if (state.flags.overlay === false) return featureResponse(envelope, "overlay");
            }
        if (PUBLIC_CANVAS_SYNC_FAMILIES.has(envelope.type)) {
                // Upload is the rollout kill switch. Account opt-in is a
                // separate user setting and is required for every runtime
                // entry point, including cancellation, so another account
                // cannot wake or touch sync work.
                if (state.flags.upload === false) return featureResponse(envelope, "upload");
                const inputError = publicSyncInputError(envelope.payload);
                if (inputError) return response(envelope, errorPayload(inputError));
                if (!accountOptedIn(state, envelope.payload)) {
                    return response(envelope, errorPayload("CANVAS_SYNC_OPT_IN_REQUIRED"));
                }
                if (decision.kind !== "extension" || !exactSyncExtensionPage(sender, chromeApi?.runtime, messageContract)) {
                    return response(envelope, errorPayload("SENDER_EXTENSION_REQUIRED"));
                }
                const method = envelope.type === "CANVAS_SYNC_START" ? "start"
                    : envelope.type === "CANVAS_SYNC_RESUME" ? "resume"
                        : envelope.type === "CANVAS_SYNC_STATUS" ? "status" : "cancel";
                if (typeof canvasSync?.[method] !== "function") return response(envelope, errorPayload("CANVAS_SYNC_UNAVAILABLE"));
                const accountKey = accountKeyFromPayload(envelope.payload);
                const runtimePayload = { ...envelope.payload, accountKey };
                const invoke = () => canvasSync[method](runtimePayload);
                const result = typeof withCanvasSyncAccount === "function"
                    ? await withCanvasSyncAccount(accountKey, invoke)
                    : await invoke();
                return response(envelope, safePublicSyncResult(result));
            }
            if (CANVAS_FAMILIES.has(envelope.type) && envelope.type !== "CANVAS_ACCOUNT_VERIFY" && decision.kind !== "canvas") return response(envelope, errorPayload("SENDER_CANVAS_REQUIRED"));
            if (envelope.type === "CANVAS_ACCOUNT_VERIFY" && decision.kind !== "canvas" && decision.kind !== "extension") return response(envelope, errorPayload("SENDER_CANVAS_REQUIRED"));
            if (NEST_FAMILIES.has(envelope.type) && envelope.type !== "NEST_CALENDAR_RANGE_GET" && decision.kind !== "extension") return response(envelope, errorPayload("SENDER_EXTENSION_REQUIRED"));
            if (NEST_CONSENT_FAMILIES.has(envelope.type) && !exactSyncExtensionPage(sender, chromeApi?.runtime, messageContract)) return response(envelope, errorPayload("SENDER_EXTENSION_REQUIRED"));
            if (["POPUP_FULLSCREEN_OPEN", "POPUP_CONTEXT_GET", "SETTINGS_READ", "SETTINGS_UPDATE", "SETTINGS_RESET"].includes(envelope.type) && decision.kind !== "extension") return response(envelope, errorPayload("SENDER_EXTENSION_REQUIRED"));

            try {
                if (envelope.type === "NEST_CALENDAR_RANGE_GET") {
                    return response(envelope, await handleNest({ ...envelope, sender }, state));
                }
                if (envelope.type === "CANVAS_ACCOUNT_VERIFY" && decision.kind === "extension") {
                    if (!canvasRegistration) return response(envelope, errorPayload("browser_unsupported"));
                    const origin = messageContract.normalizeOrigin(envelope.payload.origin || "");
                    const configuredOrigins = state.configuredOrigins.includes(origin) || envelope.payload.user_gesture === true
                        ? Array.from(new Set([...state.configuredOrigins, origin].filter(Boolean)))
                        : state.configuredOrigins;
                    if (envelope.payload.user_gesture !== true && (envelope.payload.operation === "register" || envelope.payload.operation === "unregister")) {
                        return response(envelope, errorPayload("SETTINGS_USER_GESTURE_REQUIRED"));
                    }
                    if (envelope.payload.operation === "register") {
                        return response(envelope, await canvasRegistration.ensureOrigin(origin, { configuredOrigins }));
                    }
                    if (envelope.payload.operation === "unregister") {
                        return response(envelope, await canvasRegistration.unregisterOrigin(origin));
                    }
                    const registration = await canvasRegistration.ensureOrigin(origin, { configuredOrigins });
                    if (!registration.ok) return response(envelope, registration);
                    if (envelope.payload.account_id || envelope.payload.accountId) return response(envelope, await recordExtensionCanvasAccount(envelope, { ...state, configuredOrigins }));
                    return response(envelope, registration);
                }
                if (envelope.type === "CANVAS_ACCOUNT_VERIFY") return response(envelope, await verifyCanvasAccount(envelope, sender, state));
                if (CANVAS_FAMILIES.has(envelope.type)) return response(envelope, await handleCanvas(envelope, state));
                if (NEST_FAMILIES.has(envelope.type)) return response(envelope, await handleNest(envelope, state));
                if (envelope.type === "POPUP_FULLSCREEN_OPEN") {
                    const sourceCanvasTabId = Number.isInteger(envelope.payload.sourceCanvasTabId)
                        ? envelope.payload.sourceCanvasTabId
                        : Number.isInteger(sender?.tab?.id)
                            ? sender.tab.id
                            : await activeCanvasTabId(chromeApi, state, messageContract);
                    if (state.flags.browserFullscreen === false) return featureResponse(envelope, "browserFullscreen");
                    if (envelope.payload.replaceBrowser === true && state.flags.browserReplace === false) return featureResponse(envelope, "browserReplace");
                    return response(envelope, await fullscreen.openFullscreen({ chromeApi, storage, sourceCanvasTabId, category: envelope.payload.category, flags: state.flags }));
                }
                if (envelope.type === "POPUP_CONTEXT_GET") {
                    const mappings = await storage.get("session", "platform.tabWindowMappings");
                    return response(envelope, okPayload({ mappings: mappings["platform.tabWindowMappings"] || {} }));
                }
                if (["SETTINGS_READ", "SETTINGS_UPDATE", "SETTINGS_RESET"].includes(envelope.type)) return response(envelope, await handleSettings(envelope));
                return response(envelope, errorPayload("UNSUPPORTED_FAMILY"));
            } catch (error) {
                const code = safeSyncCode(error?.code || error?.message, "PLATFORM_REQUEST_FAILED");
                return response(envelope, errorPayload(code));
            }
        }

        return Object.freeze({ handle, context, constants: Object.freeze({
            CANVAS_FAMILIES,
            NEST_FAMILIES,
            FEATURE_CODES,
            CONSENT_VERSION,
            CONSENT_SCOPES: CONSENT_SCOPE_VALUES.slice(),
            CANVAS_ACCOUNT_KEY_PATTERN,
            SOURCE_REF_PATTERN,
            CANVAS_SYNC_OPT_IN_MAX_ACCOUNTS,
            CANVAS_SYNC_OPT_IN_MAX_BYTES
        }) });
    }

    return Object.freeze({
        createRouter,
        FALLBACK_FLAGS,
        FEATURE_CODES,
        CONSENT_VERSION,
        CONSENT_SCOPES: CONSENT_SCOPE_VALUES.slice(),
        CANVAS_ACCOUNT_KEY_PATTERN,
        SOURCE_REF_PATTERN,
        CANVAS_SYNC_OPT_IN_MAX_ACCOUNTS,
        CANVAS_SYNC_OPT_IN_MAX_BYTES,
        createRevocationCleanupCoordinator
    });
}));
