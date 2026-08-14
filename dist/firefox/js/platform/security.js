(function (root, factory) {
    "use strict";

    const api = factory();
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasPlatform = Object.assign(root.APStudyCanvasPlatform || {}, { Security: api });
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const JWT_PATTERN = /(?:^|[^A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}(?:$|[^A-Za-z0-9_-])/;
    const LABELED_SECRET_PATTERN = /(?:bearer\s+[A-Za-z0-9._~+/=-]+|(?:access|refresh|id)?[\s_.-]*token\s*[:=]|authorization\s*[:=]|appwrite\s*[:=]|(?:raw[\s_.-]*)?csrf(?:token)?\s*[:=]|set-cookie\s*:)/i;
    const RAW_CSRF_PATTERN = /^(?:raw[\s_.-]*)?csrf(?:token)?[\s_.:=/-]+[A-Za-z0-9._~+/=-]{4,}$/i;

    function normalizeKey(key) {
        return String(key || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    }

    function isSensitiveKey(key) {
        const normalized = normalizeKey(key);
        return Boolean(normalized && (
            normalized.includes("token") ||
            normalized.includes("authorization") ||
            normalized.includes("bearer") ||
            normalized.includes("password") ||
            normalized.includes("secret") ||
            normalized.includes("appwrite") ||
            normalized.includes("cookie") ||
            normalized.includes("csrf") ||
            normalized.includes("privateics") ||
            normalized.includes("canonicalhistory") ||
            normalized === "jwt"
        ));
    }

    function isPlainObject(value) {
        if (!value || typeof value !== "object" || Array.isArray(value)) return false;
        const prototype = Object.getPrototypeOf(value);
        return prototype === Object.prototype || prototype === null;
    }

    function isJsonSerializable(value, seen = new Set()) {
        if (value === null || typeof value === "string" || typeof value === "boolean") return true;
        if (typeof value === "number") return Number.isFinite(value);
        if (typeof value !== "object") return false;
        if (seen.has(value)) return false;
        if (!Array.isArray(value) && !isPlainObject(value)) return false;
        seen.add(value);
        const valid = Array.isArray(value)
            ? value.every((item) => isJsonSerializable(item, seen))
            : Object.entries(value).every(([key, item]) => typeof key === "string" && isJsonSerializable(item, seen));
        seen.delete(value);
        return valid;
    }

    function urlHasCredentials(value) {
        if (typeof value !== "string" || !/^https?:\/\//i.test(value.trim())) return false;
        try {
            const url = new URL(value.trim());
            if (url.username || url.password || /\.ics$/i.test(url.pathname)) return true;
            for (const [key, item] of url.searchParams.entries()) {
                if (isSensitiveKey(key) || hasCredentialLikeScalar(item)) return true;
            }
            return false;
        } catch (error) {
            return true;
        }
    }

    function hasCredentialLikeScalar(value) {
        if (typeof value !== "string") return false;
        const text = value.trim();
        if (!text) return false;
        if (JWT_PATTERN.test(` ${text} `) || LABELED_SECRET_PATTERN.test(text) || RAW_CSRF_PATTERN.test(text)) return true;
        const urls = text.match(/https?:\/\/[^\s"'<>]+/gi) || [];
        return urls.some(urlHasCredentials);
    }

    function parseNestedJsonString(value) {
        if (typeof value !== "string") return undefined;
        const trimmed = value.trim();
        if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return undefined;
        try { return JSON.parse(trimmed); } catch (error) { return undefined; }
    }

    function findSensitiveData(value, path = "", seen = new Set()) {
        if (path && isSensitiveKey(path)) return { path, reason: "sensitive_key" };
        if (typeof value === "string") {
            if (hasCredentialLikeScalar(value)) return { path, reason: "sensitive_value" };
            const parsed = parseNestedJsonString(value);
            if (parsed !== undefined) return findSensitiveData(parsed, path, seen);
            return null;
        }
        if (value === null || typeof value !== "object") return null;
        if (seen.has(value)) return { path, reason: "non_json_value" };
        seen.add(value);
        const entries = Array.isArray(value) ? value.map((item, index) => [String(index), item]) : Object.entries(value);
        for (const [key, item] of entries) {
            const childPath = Array.isArray(value) ? `${path}[${key}]` : key;
            const found = findSensitiveData(item, childPath, seen);
            if (found) {
                seen.delete(value);
                return found;
            }
        }
        seen.delete(value);
        return null;
    }

    function parseJsonObject(value, invalidCode = "JSON_OBJECT_REQUIRED") {
        let parsed = value;
        if (typeof value === "string") {
            try { parsed = JSON.parse(value); } catch (error) { throw new Error("JSON_BODY_INVALID"); }
        }
        if (!isPlainObject(parsed)) throw new Error(invalidCode);
        if (!isJsonSerializable(parsed)) throw new Error("JSON_BODY_NOT_SERIALIZABLE");
        return parsed;
    }

    function validateSafeHttpsUrl(value) {
        if (typeof value !== "string" || value.length > 2048) return false;
        try {
            const url = new URL(value);
            if (url.protocol !== "https:" || url.username || url.password || /\.ics$/i.test(url.pathname)) return false;
            for (const [key, item] of url.searchParams.entries()) {
                if (isSensitiveKey(key) || hasCredentialLikeScalar(item)) return false;
            }
            return true;
        } catch (error) {
            return false;
        }
    }

    return Object.freeze({
        normalizeKey,
        isSensitiveKey,
        isPlainObject,
        isJsonSerializable,
        hasCredentialLikeScalar,
        urlHasCredentials,
        findSensitiveData,
        parseJsonObject,
        validateSafeHttpsUrl
    });
}));
