(function (root, factory) {
    "use strict";

    const identity = root?.APStudyCanvasCanvasAdapter?.Identity || (typeof require === "function" ? require("./identity.js") : null);
    const contracts = root?.APStudyCanvasCanvasAdapter?.Contracts || (typeof require === "function" ? require("./contracts.js") : null);
    const api = factory(identity, contracts);
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasCanvasAdapter = Object.assign(root.APStudyCanvasCanvasAdapter || {}, { Pagination: api });
}(typeof globalThis !== "undefined" ? globalThis : this, function (identity, contracts) {
    "use strict";

    const VERSION = 1;
    const MAX_PER_PAGE = Number(contracts?.MAX_PER_PAGE || 100);
    const MAX_RETRY_ATTEMPTS = Number(contracts?.MAX_RETRY_ATTEMPTS || 8);
    const BACKOFF_BASE_MS = Number(contracts?.BACKOFF_BASE_MS || 2000);
    const BACKOFF_MAX_MS = Number(contracts?.BACKOFF_MAX_MS || 300000);
    const DEFAULT_OVERLAP_MS = Number(contracts?.INCREMENTAL_OVERLAP_MS || 86400000);
    const SECRET_QUERY_KEY = /(?:access[_-]?token|refresh[_-]?token|id[_-]?token|oauth(?:2)?[_-]?token|auth(?:orization)?|bearer|password|passwd|secret|credential|api[_-]?key|client[_-]?secret|signature|sig)/i;
    const SECRET_FIELD = /(?:access[_-]?token|refresh[_-]?token|id[_-]?token|oauth(?:2)?[_-]?token|authorization|bearer|password|passwd|secret|credential|api[_-]?key|client[_-]?secret|private[_-]?ics|raw[_-]?email|set[-_]?cookie)/i;
    const PAGINATION_QUERY_KEYS = new Set(["page", "per_page"]);
    const UNSUPPORTED_PAGINATION_QUERY_KEY = /^(?:cursor|continuation(?:_?token)?|page_?token|next_?(?:page_?)?(?:cursor|token)|after|before|offset|marker|start(?:ing)?_?after|end(?:ing)?_?before)$/i;
    const SECRET_QUERY_VALUE = /(?:bearer\s+\S+|basic\s+\S+|^eyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+$|(?:access|refresh|id|oauth|auth)[_-]?(?:token|key)|(?:token|secret|password|credential|signature)[=:]|^(?:token|secret|credential)[_-])/i;

    function clone(value) {
        if (value === undefined) return undefined;
        if (typeof structuredClone === "function") return structuredClone(value);
        return JSON.parse(JSON.stringify(value));
    }

    function stableStringify(value) {
        if (value === undefined) return "null";
        if (value === null || typeof value !== "object") {
            if (typeof value === "number" && !Number.isFinite(value)) return "null";
            return JSON.stringify(value);
        }
        if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
    }

    function hash(value) {
        if (identity?.sha256HexSync) return identity.sha256HexSync(String(value));
        // This branch is only a last-resort browser fallback when this file is
        // loaded without the identity module. It is deterministic, but all
        // normal extension builds load identity.js first and use SHA-256.
        let first = 2166136261;
        let second = 16777619;
        for (const character of String(value)) {
            first ^= character.charCodeAt(0);
            first = Math.imul(first, 16777619) >>> 0;
            second ^= character.charCodeAt(0) + 31;
            second = Math.imul(second, 2166136261) >>> 0;
        }
        return `${first.toString(16).padStart(8, "0")}${second.toString(16).padStart(8, "0")}`.repeat(4);
    }

    function correlationHash(value) {
        if (identity?.safeCorrelationId) return identity.safeCorrelationId(value);
        return `c-${hash(value).slice(0, 24)}`;
    }

    function byteLength(value) {
        const text = typeof value === "string" ? value : stableStringify(value);
        if (typeof TextEncoder === "function") return new TextEncoder().encode(text).length;
        try { return unescape(encodeURIComponent(text)).length; } catch (error) { return Number.POSITIVE_INFINITY; }
    }

    function nowValue(clock) {
        if (typeof clock === "function") return Number(clock());
        if (clock && typeof clock.now === "function") return Number(clock.now());
        return Date.now();
    }

    function normalizedOrigin(value) {
        if (identity?.normalizeCanvasOrigin) return identity.normalizeCanvasOrigin(value);
        try {
            const url = new URL(String(value));
            if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" && url.pathname !== "" || url.search || url.hash) return null;
            return url.origin;
        } catch (error) { return null; }
    }

    function normalizedAccount(options = {}) {
        if (identity?.normalizeAccount) return identity.normalizeAccount({ origin: options.origin || options.expectedOrigin, userId: options.userId ?? options.expectedUserId ?? options.user_id });
        const origin = normalizedOrigin(options.origin || options.expectedOrigin);
        const userId = String(options.userId ?? options.expectedUserId ?? options.user_id ?? "").trim();
        return origin && /^[1-9]\d{0,19}$/.test(userId) ? { origin, userId } : null;
    }

    function isAllowedApiPath(pathname) {
        return pathname === "/api/v1" || pathname.startsWith("/api/v1/");
    }

    function hasSecretQueryKey(url) {
        for (const [key] of url.searchParams.entries()) if (SECRET_QUERY_KEY.test(key)) return true;
        return false;
    }

    function isSecretQueryValue(value) {
        return SECRET_QUERY_VALUE.test(String(value || ""));
    }

    function hasSecretQueryData(url) {
        for (const [key, value] of url.searchParams.entries()) {
            if (SECRET_QUERY_KEY.test(key) || isSecretQueryValue(value)) return true;
        }
        return false;
    }

    function isPaginationKey(key) { return PAGINATION_QUERY_KEYS.has(String(key).toLowerCase()); }

    function isUnsupportedPaginationKey(key) {
        return UNSUPPORTED_PAGINATION_QUERY_KEY.test(String(key).replace(/\[\]$/, ""));
    }

    function paginationValueValid(key, value) {
        const name = String(key).toLowerCase();
        if (name === "page") return /^[1-9]\d{0,8}$/.test(String(value));
        if (name === "per_page") return /^[1-9]\d{0,8}$/.test(String(value));
        return false;
    }

    function urlQueryEntries(url, { includePagination = true } = {}) {
        const result = [];
        for (const [key, value] of url.searchParams.entries()) {
            if (!includePagination && isPaginationKey(key)) continue;
            result.push([String(key), String(value)]);
        }
        return result.sort((left, right) => left[0].localeCompare(right[0]) || left[1].localeCompare(right[1]));
    }

    function validatePaginationQuery(url) {
        const seen = new Set();
        for (const [key, value] of url.searchParams.entries()) {
            if (isUnsupportedPaginationKey(key)) return { ok: false, code: "CANVAS_CURSOR_PAGINATION_UNSUPPORTED" };
            if (!isPaginationKey(key)) continue;
            const normalized = String(key).toLowerCase();
            if (seen.has(normalized) || !paginationValueValid(normalized, value)) return { ok: false, code: "CANVAS_PAGINATION_QUERY_INVALID" };
            seen.add(normalized);
        }
        return { ok: true };
    }

    function capPerPage(value) {
        const candidate = Number(value);
        if (!Number.isInteger(candidate) || candidate < 1) return MAX_PER_PAGE;
        return Math.min(candidate, MAX_PER_PAGE);
    }

    function withCappedPerPage(value, requested = MAX_PER_PAGE) {
        const url = value instanceof URL ? new URL(value.href) : new URL(String(value));
        const present = url.searchParams.get("per_page");
        url.searchParams.set("per_page", capPerPage(present === null ? requested : present));
        return url;
    }

    function descriptorWindow(descriptor, windowIndex = 0) {
        return descriptor?.windows?.[Number(windowIndex)] || descriptor;
    }

    function validateBoundUrl(url, { descriptor, windowIndex = 0 } = {}) {
        if (!descriptor) return { ok: true };
        if (url.origin !== descriptor.origin) return { ok: false, code: "CANVAS_LINK_ORIGIN_DRIFT" };
        if (url.pathname !== descriptor.endpoint_path) return { ok: false, code: "CANVAS_LINK_PATH_DRIFT" };
        const expected = descriptorWindow(descriptor, windowIndex);
        const expectedQuery = expected?.query || descriptor.fixed_query || [];
        if (stableStringify(urlQueryEntries(url, { includePagination: false })) !== stableStringify(expectedQuery)) {
            return { ok: false, code: "CANVAS_LINK_FILTER_DRIFT" };
        }
        return { ok: true };
    }

    function validateNextUrl(value, { expectedOrigin, baseUrl, descriptor, planDescriptor, windowIndex = 0 } = {}) {
        const binding = descriptor || planDescriptor;
        const origin = normalizedOrigin(expectedOrigin);
        if (!origin) return { ok: false, code: "CANVAS_EXPECTED_ORIGIN_INVALID" };
        let url;
        try { url = new URL(String(value), baseUrl || origin); } catch (error) { return { ok: false, code: "CANVAS_LINK_URL_INVALID" }; }
        if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password || url.hash) {
            return { ok: false, code: "CANVAS_LINK_ORIGIN_INVALID" };
        }
        if (!isAllowedApiPath(url.pathname)) return { ok: false, code: "CANVAS_LINK_PATH_INVALID" };
        const pagination = validatePaginationQuery(url);
        if (!pagination.ok) return pagination;
        if (hasSecretQueryData(url)) return { ok: false, code: "CANVAS_LINK_SECRET_QUERY" };
        const capped = withCappedPerPage(url);
        const bound = validateBoundUrl(capped, { descriptor: binding, windowIndex });
        if (!bound.ok) return bound;
        return { ok: true, url: capped };
    }

    function splitLinkEntries(header) {
        const result = [];
        let start = 0;
        let angle = false;
        let quote = false;
        let escaped = false;
        for (let index = 0; index < header.length; index += 1) {
            const character = header[index];
            if (quote) {
                if (escaped) escaped = false;
                else if (character === "\\") escaped = true;
                else if (character === '"') quote = false;
                continue;
            }
            if (character === '"') { quote = true; continue; }
            if (character === "<") { if (angle) return null; angle = true; continue; }
            if (character === ">") { if (!angle) return null; angle = false; continue; }
            if (character === "," && !angle) {
                const entry = header.slice(start, index).trim();
                if (!entry) return null;
                result.push(entry);
                start = index + 1;
            }
        }
        if (angle || quote) return null;
        const last = header.slice(start).trim();
        if (!last) return null;
        result.push(last);
        return result;
    }

    function splitParameters(value) {
        const result = [];
        let start = 0;
        let quote = false;
        let escaped = false;
        for (let index = 0; index < value.length; index += 1) {
            const character = value[index];
            if (quote) {
                if (escaped) escaped = false;
                else if (character === "\\") escaped = true;
                else if (character === '"') quote = false;
            } else if (character === '"') quote = true;
            else if (character === ";") { result.push(value.slice(start, index).trim()); start = index + 1; }
        }
        if (quote) return null;
        result.push(value.slice(start).trim());
        return result;
    }

    function unquote(value) {
        const candidate = String(value || "").trim();
        if (!candidate.startsWith('"')) return candidate;
        if (!candidate.endsWith('"') || candidate.length < 2) return null;
        return candidate.slice(1, -1).replace(/\\([\\"])/g, "$1");
    }

    function parseLinkHeader(header, { expectedOrigin, baseUrl, descriptor, planDescriptor, windowIndex = 0 } = {}) {
        if (header === undefined || header === null || header === "") return { ok: true, links: [], next: null };
        if (typeof header !== "string") return { ok: false, code: "CANVAS_LINK_HEADER_INVALID" };
        const trimmed = header.trim();
        if (!trimmed) return { ok: true, links: [], next: null };
        const entries = splitLinkEntries(trimmed);
        if (!entries) return { ok: false, code: "CANVAS_LINK_HEADER_MALFORMED" };
        const links = [];
        let next = null;
        for (const entry of entries) {
            const close = entry.indexOf(">");
            if (!entry.startsWith("<") || close < 2) return { ok: false, code: "CANVAS_LINK_ENTRY_MALFORMED" };
            const target = entry.slice(1, close);
            const parameters = splitParameters(entry.slice(close + 1));
            if (!parameters) return { ok: false, code: "CANVAS_LINK_PARAMETERS_MALFORMED" };
            let rel = "";
            for (const parameter of parameters.slice(1)) {
                if (!parameter) return { ok: false, code: "CANVAS_LINK_PARAMETER_MALFORMED" };
                const separator = parameter.indexOf("=");
                if (separator < 1) return { ok: false, code: "CANVAS_LINK_PARAMETER_MALFORMED" };
                const name = parameter.slice(0, separator).trim().toLowerCase();
                const value = unquote(parameter.slice(separator + 1));
                if (!name || value === null) return { ok: false, code: "CANVAS_LINK_PARAMETER_MALFORMED" };
                if (name === "rel") rel = value;
            }
            const link = { target, rel: rel.split(/\s+/).filter(Boolean).map((item) => item.toLowerCase()) };
            links.push(link);
            if (link.rel.includes("next")) {
                if (next) return { ok: false, code: "CANVAS_LINK_MULTIPLE_NEXT" };
                const checked = validateNextUrl(target, { expectedOrigin, baseUrl, descriptor, planDescriptor, windowIndex });
                if (!checked.ok) return checked;
                next = checked.url.href;
            }
        }
        return { ok: true, links, next };
    }

    function queryEntries(target, value) {
        if (value === undefined || value === null) return;
        if (Array.isArray(value)) return value.forEach((item) => queryEntries(target, item));
        if (typeof value === "object") return;
        target.push([String(value), ""]);
    }

    function appendQuery(url, key, value) {
        if (SECRET_QUERY_KEY.test(String(key))) throw Object.assign(new Error("CANVAS_SECRET_QUERY_KEY"), { code: "CANVAS_SECRET_QUERY_KEY" });
        if (isUnsupportedPaginationKey(key)) throw Object.assign(new Error("CANVAS_CURSOR_PAGINATION_UNSUPPORTED"), { code: "CANVAS_CURSOR_PAGINATION_UNSUPPORTED" });
        if (isPaginationKey(key)) throw Object.assign(new Error("CANVAS_PAGINATION_QUERY_FIXED"), { code: "CANVAS_PAGINATION_QUERY_FIXED" });
        if (Array.isArray(value)) return value.forEach((item) => {
            if (item !== undefined && item !== null && typeof item !== "object") {
                if (isSecretQueryValue(item)) throw Object.assign(new Error("CANVAS_SECRET_QUERY_VALUE"), { code: "CANVAS_SECRET_QUERY_VALUE" });
                url.searchParams.append(`${key}[]`, String(item));
            }
        });
        if (value && typeof value === "object") return;
        if (value !== undefined && value !== null) {
            if (isSecretQueryValue(value)) throw Object.assign(new Error("CANVAS_SECRET_QUERY_VALUE"), { code: "CANVAS_SECRET_QUERY_VALUE" });
            url.searchParams.append(String(key), String(value));
        }
    }

    function applyObjectQuery(url, values) {
        if (!values || typeof values !== "object") return;
        Object.keys(values).sort().forEach((key) => appendQuery(url, key, values[key]));
    }

    function replacePathTemplate(path, options) {
        return String(path || "").replace(/\{contextId\}/g, () => {
            const value = options.contextId ?? options.context_id;
            if (value === undefined || value === null || !/^[^\u0000-\u001f\u007f/]+$/.test(String(value))) throw Object.assign(new Error("CANVAS_CONTEXT_REQUIRED"), { code: "CANVAS_CONTEXT_REQUIRED" });
            return encodeURIComponent(String(value));
        }).replace(/\{remoteId\}/g, () => encodeURIComponent(String(options.remoteId ?? "")));
    }

    function buildRequestUrl({ type, origin, expectedOrigin, contextId, context_id, scope = {}, filter = {}, window, perPage = MAX_PER_PAGE, pageSize, query = {} } = {}) {
        const capability = contracts?.getCapability?.(type);
        const source = capability?.source?.list;
        const normalized = normalizedOrigin(origin || expectedOrigin);
        if (!capability || !source?.path) return { ok: false, state: "unsupported", code: "CANVAS_CONTRACT_UNSUPPORTED" };
        if (!normalized) return { ok: false, state: "waiting", code: "CANVAS_EXPECTED_ORIGIN_INVALID" };
        let url;
        try { url = new URL(replacePathTemplate(source.path, { contextId: contextId ?? context_id }), normalized); }
        catch (error) { return { ok: false, state: "unsupported", code: error.code || "CANVAS_ENDPOINT_INVALID" }; }
        if (!isAllowedApiPath(url.pathname)) return { ok: false, state: "unsupported", code: "CANVAS_ENDPOINT_PATH_INVALID" };
        try {
            const listQuery = capability.source.listQuery || {};
            if (Array.isArray(listQuery.include)) listQuery.include.forEach((item) => appendQuery(url, "include", item));
            Object.keys(scope || {}).sort().forEach((key) => appendQuery(url, key, scope[key]));
            Object.keys(filter || {}).sort().forEach((key) => appendQuery(url, key, filter[key]));
            Object.keys(query || {}).sort().forEach((key) => appendQuery(url, key, query[key]));
            if (window && capability.source.window?.mode === "date_range") {
                appendQuery(url, capability.source.window.startParam, window.start);
                appendQuery(url, capability.source.window.endParam, window.end);
            }
            url.searchParams.set("per_page", capPerPage(pageSize ?? perPage));
        } catch (error) { return { ok: false, state: "unsupported", code: error.code || "CANVAS_QUERY_INVALID" }; }
        return { ok: true, url: url.href };
    }

    function dateOnly(value) { return /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")); }

    function validDate(value) {
        const parsed = dateOnly(value) ? Date.parse(`${value}T00:00:00.000Z`) : Date.parse(String(value));
        return Number.isFinite(parsed) ? parsed : null;
    }

    function formatDateOnly(timestamp) { return new Date(timestamp).toISOString().slice(0, 10); }

    function buildDateWindows({ lowerBound, now, windowDays = 30, dateOnlyMode } = {}) {
        const lower = typeof lowerBound === "object" ? lowerBound.value : lowerBound;
        const upper = typeof now === "object" ? now.value : now;
        const lowerTime = validDate(lower);
        const upperTime = validDate(upper);
        if (lowerTime === null || upperTime === null || lowerTime > upperTime) return { ok: false, state: "unsupported", code: "CANVAS_DATE_WINDOW_INVALID" };
        const size = Number(windowDays);
        if (!Number.isInteger(size) || size < 1 || size > 3660) return { ok: false, state: "unsupported", code: "CANVAS_DATE_WINDOW_SIZE_INVALID" };
        const asDate = dateOnlyMode === undefined ? dateOnly(lower) && dateOnly(upper) : Boolean(dateOnlyMode);
        const windows = [];
        let cursor = lowerTime;
        let index = 0;
        while (cursor <= upperTime) {
            const candidateEnd = cursor + size * 86400000 - (asDate ? 86400000 : 1);
            const end = Math.min(candidateEnd, upperTime);
            windows.push({ index, start: asDate ? formatDateOnly(cursor) : new Date(cursor).toISOString(), end: asDate ? formatDateOnly(end) : new Date(end).toISOString(), inclusive: true });
            cursor = end + (asDate ? 86400000 : 1);
            index += 1;
        }
        return { ok: true, windows, dateOnly: asDate };
    }

    function verifiedLowerBound(value) {
        if (!value || typeof value !== "object" || value.verified !== true) return null;
        const candidate = value.value ?? value.date ?? value.lowerBound;
        return validDate(candidate) === null ? null : { value: String(candidate), verified: true, source: String(value.source || "verified") };
    }

    function safeCheckpointValue(value, userId, seen = new Set()) {
        if (value === null || value === undefined || typeof value === "boolean") return value;
        if (typeof value === "number") return userId && String(value) === String(userId) ? `<user:${hash(userId).slice(0, 16)}>` : value;
        if (typeof value === "string") {
            if (isSecretQueryValue(value)) return undefined;
            if (userId && value.includes(String(userId))) return value.split(String(userId)).join(`<user:${hash(userId).slice(0, 16)}>`);
            return value;
        }
        if (typeof value !== "object" || seen.has(value)) return undefined;
        seen.add(value);
        if (Array.isArray(value)) return value.map((item) => safeCheckpointValue(item, userId, seen)).filter((item) => item !== undefined);
        const result = {};
        Object.keys(value).sort().forEach((key) => {
            if (SECRET_FIELD.test(key)) return;
            if (/^user(?:_?id)?$/i.test(key)) {
                result[key] = `<user:${hash(value[key]).slice(0, 16)}>`;
                return;
            }
            const item = safeCheckpointValue(value[key], userId, seen);
            if (item !== undefined) result[key] = item;
        });
        seen.delete(value);
        return result;
    }

    function watermarkValue(item, fields) {
        for (const field of fields || []) {
            const parts = String(field).split(".");
            let value = item;
            for (const part of parts) value = value?.[part];
            if (typeof value === "string" || typeof value === "number") return String(value);
        }
        return null;
    }

    function greaterWatermark(previous, current) {
        if (current === null || current === undefined || current === "") return previous ?? null;
        if (previous === null || previous === undefined || previous === "") return String(current);
        const previousTime = validDate(previous);
        const currentTime = validDate(current);
        if (previousTime !== null && currentTime !== null) return currentTime >= previousTime ? String(current) : String(previous);
        return String(current) >= String(previous) ? String(current) : String(previous);
    }

    function checkpointPagination(url, page, perPage) {
        const result = { page: Number.isInteger(page) && page >= 1 ? page : 1, per_page: capPerPage(perPage) };
        try {
            const parsed = new URL(String(url || ""));
            if (parsed.username || parsed.password || parsed.hash || hasSecretQueryData(parsed)) return result;
            const pageValue = parsed.searchParams.get("page");
            const perPageValue = parsed.searchParams.get("per_page");
            if (/^[1-9]\d{0,8}$/.test(String(pageValue || ""))) result.page = Number(pageValue);
            if (/^[1-9]\d{0,8}$/.test(String(perPageValue || ""))) result.per_page = capPerPage(perPageValue);
        } catch (error) {
            // The run path validates URLs before checkpointing; do not persist
            // a raw fallback when a caller supplies an invalid URL directly.
        }
        return result;
    }

    function checkpointWindow(window) {
        if (!window || typeof window !== "object") return { mode: "full_history" };
        const allowed = ["index", "mode", "start", "end", "inclusive", "startParam", "endParam", "lower_bound_supported"];
        const result = {};
        for (const key of allowed) if (window[key] !== undefined) result[key] = window[key];
        return result;
    }

    function createCheckpoint(plan, { pageUrl, windowIndex = 0, page = 1, retryAttempt = 0, counters = {}, overlapWatermark, previous } = {}) {
        const userId = plan.expectedUserId;
        const priorCounters = previous?.counters || {};
        const mergedCounters = {
            pages: Math.max(Number(priorCounters.pages || 0), Number(counters.pages || 0)),
            items: Math.max(Number(priorCounters.items || 0), Number(counters.items || 0)),
            windows: Math.max(Number(priorCounters.windows || 0), Number(counters.windows || 0)),
            retries: Math.max(Number(priorCounters.retries || 0), Number(counters.retries || 0))
        };
        const priorWatermark = previous?.overlap_watermark ?? plan.overlapWatermark ?? null;
        const pagination = checkpointPagination(pageUrl, page, plan.perPage);
        const checkpoint = {
            contract_version: plan.contract_version,
            source_hash: plan.source_hash,
            plan_descriptor_hash: plan.descriptor_hash,
            account_hash: plan.account_hash,
            expected_origin_hash: plan.expected_origin_hash,
            expected_user_hash: plan.expected_user_hash,
            consent_version: plan.consent_version,
            scope: safeCheckpointValue(plan.scope, userId),
            filter: safeCheckpointValue(plan.filter, userId),
            window: safeCheckpointValue(checkpointWindow(plan.windows[windowIndex] || { mode: "full_history" }), userId),
            generation: plan.generation,
            window_index: windowIndex,
            page: pagination.page,
            per_page: pagination.per_page,
            counters: mergedCounters,
            overlap_watermark: greaterWatermark(priorWatermark, overlapWatermark),
            retry_attempt: retryAttempt
        };
        return checkpoint;
    }

    function makeProgress(state, counters, startedAt, clock, errorClass, correlation) {
        return {
            state,
            count: Number(counters?.items || 0),
            duration: Math.max(0, nowValue(clock) - startedAt),
            error_class: errorClass || null,
            correlation_hash: correlationHash(correlation || "canvas-pagination")
        };
    }

    function retryAfterMs(headers, clock) {
        const value = getHeader(headers, "retry-after");
        if (value === null || value === undefined || value === "") return null;
        const text = String(value).trim();
        if (/^\d+(?:\.\d+)?$/.test(text)) return Math.min(BACKOFF_MAX_MS, Math.max(0, Number(text) * 1000));
        const date = Date.parse(text);
        return Number.isFinite(date) ? Math.min(BACKOFF_MAX_MS, Math.max(0, date - nowValue(clock))) : null;
    }

    function getHeader(headers, name) {
        if (!headers) return null;
        if (typeof headers.get === "function") return headers.get(name) ?? headers.get(name.toLowerCase());
        const target = String(name).toLowerCase();
        const entry = Object.keys(headers).find((key) => key.toLowerCase() === target);
        return entry ? headers[entry] : null;
    }

    function defaultWait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

    function thrownError(error) {
        const code = String(error?.code || "").toUpperCase();
        const name = String(error?.name || "").toLowerCase();
        const message = String(error?.message || "").toLowerCase();
        const aborted = Boolean(error?.aborted) || ["ABORT_ERR", "TAB_CLOSED", "INVALID_STATE_ERR"].includes(code) || name === "aborterror" || message.includes("aborted") || message.includes("tab closed");
        if (aborted) return { retryable: false, errorClass: "aborted", state: "partial", code: "CANVAS_FETCH_ABORTED" };
        const offline = Boolean(error?.offline) || ["OFFLINE", "ENETUNREACH", "ERR_INTERNET_DISCONNECTED", "ERR_NETWORK", "NETWORK_OFFLINE"].includes(code);
        if (offline) return { retryable: false, errorClass: "offline", state: "partial", code: "CANVAS_FETCH_OFFLINE" };
        const timeout = Boolean(error?.timeout) || ["TIMEOUT", "ETIMEDOUT", "ESOCKETTIMEDOUT"].includes(code) || name === "timeouterror" || message.includes("timeout");
        if (timeout) return { retryable: true, errorClass: "timeout", state: "partial", code: "CANVAS_FETCH_TIMEOUT" };
        return { retryable: false, errorClass: "network", state: "partial", code: "CANVAS_FETCH_NETWORK" };
    }

    function responsePayload(response) {
        if (Array.isArray(response)) return { status: 200, headers: {}, payload: response };
        const status = Number(response?.status ?? 200);
        const headers = response?.headers || {};
        const payload = response?.data ?? response?.payload ?? response?.body;
        return { status, headers, payload, response };
    }

    function httpFailure(status) {
        if (status === 401 || status === 403) return { retryable: false, state: "waiting", errorClass: "session", code: "CANVAS_SESSION_WAITING" };
        if (status === 429) return { retryable: true, state: "partial", errorClass: "rate_limited", code: "CANVAS_RATE_LIMITED" };
        if (status >= 500 && status <= 599) return { retryable: true, state: "partial", errorClass: "server", code: "CANVAS_SERVER_ERROR" };
        return { retryable: false, state: "partial", errorClass: "http", code: "CANVAS_HTTP_ERROR" };
    }

    async function callPageWithRetry({ url, plan, position, deps, counters, correlation }) {
        const fetchPage = deps.fetchPage;
        if (typeof fetchPage !== "function") return { ok: false, state: "partial", errorClass: "configuration", code: "CANVAS_FETCH_PAGE_REQUIRED" };
        const wait = deps.wait || defaultWait;
        const random = typeof deps.random === "function" ? deps.random : Math.random;
        let lastFailure = null;
        let retryHeaders = {};
        let checkpoint = null;
        for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt += 1) {
            const revalidate = deps.revalidateCurrentContext || deps.revalidateContext || deps.verifyContext || deps.revalidate;
            const context = typeof revalidate === "function" ? await Promise.resolve().then(() => revalidate({
                expectedOrigin: plan.expectedOrigin,
                expectedUserId: plan.expectedUserId,
                expectedOriginHash: plan.expected_origin_hash,
                expectedUserHash: plan.expected_user_hash,
                scope: clone(plan.scope),
                window: clone(plan.windows[position.windowIndex]),
                page: position.page,
                url
            })).catch(() => ({ ok: false, state: "waiting", code: "CANVAS_ACCOUNT_VERIFICATION_WAITING" })) : { ok: true };
            if (context === false || context?.state === "mismatch" || context?.code === "CANVAS_ACCOUNT_MISMATCH" || context?.ok === false && context?.state !== "waiting") {
                return { ok: false, state: "mismatch", errorClass: "account_mismatch", code: context?.code || "CANVAS_ACCOUNT_MISMATCH" };
            }
            if (context?.state === "waiting" || context?.ok === false) return { ok: false, state: "waiting", errorClass: "session", code: context?.code || "CANVAS_ACCOUNT_VERIFICATION_WAITING" };
            checkpoint = createCheckpoint(plan, { ...position, pageUrl: url, retryAttempt: attempt, counters, previous: checkpoint || deps.previousCheckpoint });
            try {
                await Promise.resolve(deps.saveCheckpoint ? deps.saveCheckpoint(clone(checkpoint)) : undefined);
            } catch (error) {
                return { ok: false, state: "partial", errorClass: "checkpoint", code: "CANVAS_CHECKPOINT_SAVE_FAILED", checkpoint };
            }
            let raw;
            try { raw = await fetchPage(url, { ...clone(position), plan: clone(plan), checkpoint: clone(checkpoint) }); }
            catch (error) {
                lastFailure = Number(error?.status) ? httpFailure(Number(error.status)) : thrownError(error);
                retryHeaders = error?.headers || {};
                if (!lastFailure.retryable || attempt + 1 >= MAX_RETRY_ATTEMPTS) return { ok: false, ...lastFailure, checkpoint };
            }
            if (raw !== undefined) {
                const response = responsePayload(raw);
                if (!Number.isFinite(response.status)) return { ok: false, state: "partial", errorClass: "malformed", code: "CANVAS_RESPONSE_STATUS_INVALID", checkpoint };
                if (response.status < 200 || response.status >= 300) {
                    lastFailure = httpFailure(response.status);
                    retryHeaders = response.headers;
                    if (!lastFailure.retryable || attempt + 1 >= MAX_RETRY_ATTEMPTS) return { ok: false, ...lastFailure, checkpoint };
                } else {
                    let payload = response.payload;
                    if (payload === undefined && typeof response.response?.json === "function") {
                        try { payload = await response.response.json(); } catch (error) { return { ok: false, state: "partial", errorClass: "malformed", code: "CANVAS_PAYLOAD_MALFORMED", checkpoint }; }
                    }
                    if (!Array.isArray(payload)) return { ok: false, state: "partial", errorClass: "malformed", code: "CANVAS_PAYLOAD_MALFORMED", checkpoint };
                    return { ok: true, items: payload, headers: response.headers, checkpoint };
                }
            }
            const retryAfter = retryAfterMs(retryHeaders, deps.clock);
            const randomValue = Number(random());
            const jitter = Number.isFinite(randomValue) ? Math.min(1, Math.max(0, randomValue)) : 0;
            const delay = retryAfter === null ? Math.max(0, Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * (2 ** attempt)) * jitter) : retryAfter;
            counters.retries = Number(counters.retries || 0) + 1;
            checkpoint = createCheckpoint(plan, { ...position, pageUrl: url, retryAttempt: attempt + 1, counters, previous: checkpoint || deps.previousCheckpoint });
            try {
                await Promise.resolve(deps.saveCheckpoint ? deps.saveCheckpoint(clone(checkpoint)) : undefined);
            } catch (error) {
                return { ok: false, state: "partial", errorClass: "checkpoint", code: "CANVAS_CHECKPOINT_SAVE_FAILED", checkpoint };
            }
            try { await wait(delay, { attempt: attempt + 1, delay, reason: lastFailure?.errorClass || "retry", correlation_hash: correlationHash(correlation) }); }
            catch (error) { return { ok: false, state: "partial", errorClass: "aborted", code: "CANVAS_FETCH_ABORTED", checkpoint }; }
        }
        return { ok: false, state: "partial", errorClass: lastFailure?.errorClass || "network", code: lastFailure?.code || "CANVAS_FETCH_FAILED" };
    }

    function planAccount(options) {
        const account = normalizedAccount({ origin: options.origin || options.expectedOrigin, userId: options.userId ?? options.expectedUserId ?? options.user_id });
        if (!account) return null;
        return {
            origin: account.origin,
            userId: account.userId,
            account_hash: hash(`canvas-account-v1\u0000${account.origin}\u0000${account.userId}`),
            expected_origin_hash: hash(account.origin),
            expected_user_hash: hash(account.userId)
        };
    }

    function deepFreeze(value, seen = new Set()) {
        if (!value || typeof value !== "object" || seen.has(value)) return value;
        seen.add(value);
        Object.values(value).forEach((item) => deepFreeze(item, seen));
        return Object.freeze(value);
    }

    function makePlanDescriptor({ type, source, account, contextId, windows, requests, scopeHash, filterHash, generation, consentVersion }) {
        const firstRequest = requests[0];
        const firstUrl = new URL(firstRequest.url);
        const windowNames = new Set();
        windows.forEach((window) => {
            if (window.startParam) windowNames.add(window.startParam);
            if (window.endParam) windowNames.add(window.endParam);
        });
        const fixedQuery = urlQueryEntries(firstUrl, { includePagination: false }).filter(([key]) => !windowNames.has(key));
        const descriptor = {
            version: VERSION,
            origin: account.origin,
            endpoint_path_template: source.path,
            endpoint_path: firstUrl.pathname,
            resource: type,
            context_hash: hash(contextId === undefined || contextId === null ? "none" : String(contextId)),
            fixed_query: fixedQuery,
            allowed_fixed_query: fixedQuery,
            windows: windows.map((window, index) => ({
                ...checkpointWindow(window),
                query: urlQueryEntries(new URL(requests[index].url), { includePagination: false })
            })),
            expected_origin_hash: account.expected_origin_hash,
            expected_user_hash: account.expected_user_hash,
            account_hash: account.account_hash,
            generation,
            scope_hash: scopeHash,
            filter_hash: filterHash,
            consent_version: consentVersion,
            pagination_keys: Array.from(PAGINATION_QUERY_KEYS).sort()
        };
        return deepFreeze(descriptor);
    }

    function planDescriptorMatches(plan) {
        const descriptor = plan?.plan_descriptor || plan?.descriptor;
        return Boolean(descriptor && descriptor.descriptor_hash === undefined && descriptor.origin === plan.expectedOrigin && descriptor.resource === plan.type && descriptor.account_hash === plan.account_hash && descriptor.expected_user_hash === plan.expected_user_hash && descriptor.expected_origin_hash === plan.expected_origin_hash && descriptor.generation === plan.generation && descriptor.scope_hash === plan.scope_hash && descriptor.filter_hash === plan.filter_hash && descriptor.consent_version === plan.consent_version && plan.descriptor_hash === hash(stableStringify(descriptor)));
    }

    function planResultFailure(options, state, code, errorClass, reason) {
        const started = nowValue(options.clock);
        const progress = makeProgress(state, { items: 0 }, started, options.clock, errorClass, options.correlation);
        return { ok: false, state, code, reason, partial: state === "partial", progress, telemetry: progress, tombstone_eligible: false };
    }

    function createPlan(options = {}) {
        const started = nowValue(options.clock);
        const type = options.type;
        const capability = contracts?.getCapability?.(type);
        if (!capability) return planResultFailure(options, "unsupported", "CANVAS_CONTRACT_UNSUPPORTED", "unsupported", "No official registry contract exists for this item family.");
        const account = planAccount(options);
        if (!account) return planResultFailure(options, "waiting", "CANVAS_ACCOUNT_EXPECTED_INVALID", "account", "A normalized Canvas HTTPS origin and numeric user ID are required.");
        const source = capability.source?.list;
        const scope = clone(options.scope || {});
        const filter = clone(options.filter || {});
        const consentVersion = String(options.consentVersion ?? options.consent_version ?? "1");
        const generation = Number.isInteger(options.generation) && options.generation >= 0 ? options.generation : 1;
        const sourceHash = hash(stableStringify({ type, path: source?.path, method: source?.method, contract_version: capability.version }));
        const dateWindowed = capability.source?.window?.mode === "date_range";
        let windows;
        let authoritative = true;
        if (dateWindowed) {
            const verified = verifiedLowerBound(options.lowerBound ?? options.verifiedLowerBound);
            if (!verified) return planResultFailure(options, "unsupported", "CANVAS_HISTORY_LOWER_BOUND_UNSUPPORTED", "unsupported", "The official registry requires a verified lower bound for this date-windowed endpoint.");
            const upper = options.now ?? new Date(nowValue(options.clock)).toISOString();
            const built = buildDateWindows({ lowerBound: verified.value, now: upper, windowDays: options.windowDays, dateOnlyMode: options.dateOnlyMode });
            if (!built.ok) return planResultFailure(options, built.state, built.code, "window", "The verified date window could not be constructed.");
            windows = built.windows.map((window) => ({ ...window, mode: "date_range", startParam: capability.source.window.startParam, endParam: capability.source.window.endParam }));
        } else {
            windows = [{ index: 0, mode: "full_history", lower_bound_supported: false }];
            authoritative = capability.source?.window?.lowerBoundSupported !== true || options.lowerBound ? true : true;
        }
        const plan = {
            ok: true,
            version: VERSION,
            type,
            contract_version: capability.version,
            expectedOrigin: account.origin,
            expectedUserId: account.userId,
            account_hash: account.account_hash,
            expected_origin_hash: account.expected_origin_hash,
            expected_user_hash: account.expected_user_hash,
            source_hash: sourceHash,
            consent_version: consentVersion,
            generation,
            scope,
            filter,
            windows,
            authoritative,
            date_windowed: dateWindowed,
            overlapWatermark: options.overlapWatermark ?? null,
            watermark_fields: options.watermarkFields || (capability.dates?.fields || []).map((field) => field.replace(/\[\].*$/, "")),
            correlation: correlationHash(options.correlation || `${type}:${source?.path || ""}`),
            created_at: new Date(started).toISOString()
        };
        plan.requests = windows.map((window) => {
            const built = buildRequestUrl({ type, origin: account.origin, contextId: options.contextId ?? options.context_id, scope, filter, window: dateWindowed ? window : null, perPage: options.perPage, pageSize: options.pageSize, query: options.query });
            return built.ok ? { window_index: window.index, url: built.url } : built;
        });
        const invalid = plan.requests.find((request) => !request.url);
        if (invalid) return planResultFailure(options, invalid.state || "unsupported", invalid.code || "CANVAS_ENDPOINT_INVALID", "configuration", "The registry endpoint could not be safely constructed.");
        plan.scope_hash = hash(stableStringify(safeCheckpointValue(scope, account.userId)));
        plan.filter_hash = hash(stableStringify(safeCheckpointValue(filter, account.userId)));
        plan.gate_hash = hash(stableStringify({ generation, scope_hash: plan.scope_hash, filter_hash: plan.filter_hash, consent_version: consentVersion }));
        plan.plan_descriptor = makePlanDescriptor({
            type,
            source,
            account,
            contextId: options.contextId ?? options.context_id,
            windows,
            requests: plan.requests,
            scopeHash: plan.scope_hash,
            filterHash: plan.filter_hash,
            generation,
            consentVersion
        });
        plan.descriptor = plan.plan_descriptor;
        plan.descriptor_hash = hash(stableStringify(plan.plan_descriptor));
        return plan;
    }

    function subtractOverlap(value, overlapMs) {
        const timestamp = validDate(value);
        if (timestamp === null) return null;
        const dateOnlyInput = dateOnly(value);
        const result = timestamp - Number(overlapMs);
        return dateOnlyInput ? formatDateOnly(result) : new Date(result).toISOString();
    }

    function buildFullHistoryPlan(options = {}) { return createPlan({ ...options, incremental: false }); }

    function buildIncrementalPlan(options = {}) {
        const watermark = options.watermark ?? options.storedWatermark;
        const overlapMs = Number(options.overlapMs ?? options.overlap ?? DEFAULT_OVERLAP_MS);
        const start = subtractOverlap(watermark, overlapMs);
        if (start === null) return planResultFailure(options, "unsupported", "CANVAS_INCREMENTAL_WATERMARK_INVALID", "watermark", "Incremental history requires a valid stored watermark.");
        const capability = contracts?.getCapability?.(options.type);
        if (!capability) return planResultFailure(options, "unsupported", "CANVAS_CONTRACT_UNSUPPORTED", "unsupported", "No official registry contract exists for this item family.");
        const plan = createPlan({ ...options, lowerBound: { value: start, verified: true, source: "stored_watermark_minus_overlap" }, overlapWatermark: start, incremental: true });
        if (plan.ok) {
            plan.incremental = true;
            plan.stored_watermark = String(watermark);
            plan.overlap_ms = overlapMs;
            plan.incremental_start = start;
        }
        return plan;
    }

    function sameResumeGate(plan, checkpoint) {
        if (!checkpoint) return true;
        const expectedWindow = plan.windows[Number(checkpoint.window_index) || 0] || plan.windows[0];
        return checkpoint.contract_version === plan.contract_version && checkpoint.source_hash === plan.source_hash && checkpoint.plan_descriptor_hash === plan.descriptor_hash && checkpoint.account_hash === plan.account_hash && checkpoint.expected_origin_hash === plan.expected_origin_hash && checkpoint.expected_user_hash === plan.expected_user_hash && checkpoint.consent_version === plan.consent_version && checkpoint.generation === plan.generation && stableStringify(checkpoint.scope) === stableStringify(safeCheckpointValue(plan.scope, plan.expectedUserId)) && stableStringify(checkpoint.filter) === stableStringify(safeCheckpointValue(plan.filter, plan.expectedUserId)) && stableStringify(checkpoint.window) === stableStringify(safeCheckpointValue(checkpointWindow(expectedWindow), plan.expectedUserId)) && !Object.prototype.hasOwnProperty.call(checkpoint, "page_url") && !Object.prototype.hasOwnProperty.call(checkpoint, "page_url_hash") && !Object.prototype.hasOwnProperty.call(checkpoint, "cursor") && Number.isInteger(checkpoint.page) && checkpoint.page >= 1 && Number.isInteger(checkpoint.per_page) && checkpoint.per_page >= 1 && checkpoint.per_page <= MAX_PER_PAGE;
    }

    function checkpointRequiresPartial(plan, checkpoint) {
        return Boolean(checkpoint && (
            checkpoint.plan_descriptor_hash !== plan.descriptor_hash ||
            Object.prototype.hasOwnProperty.call(checkpoint, "page_url") ||
            Object.prototype.hasOwnProperty.call(checkpoint, "page_url_hash") ||
            Object.prototype.hasOwnProperty.call(checkpoint, "cursor") ||
            stableStringify(checkpoint.window) !== stableStringify(safeCheckpointValue(checkpointWindow(plan.windows[Number(checkpoint.window_index) || 0]), plan.expectedUserId)) ||
            stableStringify(checkpoint.scope) !== stableStringify(safeCheckpointValue(plan.scope, plan.expectedUserId)) ||
            stableStringify(checkpoint.filter) !== stableStringify(safeCheckpointValue(plan.filter, plan.expectedUserId))
        ));
    }

    function resumeUrl(plan, request, checkpoint, windowIndex) {
        if (!checkpoint || Object.prototype.hasOwnProperty.call(checkpoint, "page_url") || Object.prototype.hasOwnProperty.call(checkpoint, "page_url_hash")) {
            return { ok: false, code: "CANVAS_CHECKPOINT_URL_INVALID" };
        }
        const url = new URL(request.url);
        for (const key of PAGINATION_QUERY_KEYS) url.searchParams.delete(key);
        url.searchParams.set("page", String(checkpoint.page));
        url.searchParams.set("per_page", String(checkpoint.per_page || MAX_PER_PAGE));
        return validateNextUrl(url.href, { expectedOrigin: plan.expectedOrigin, descriptor: plan.plan_descriptor, windowIndex });
    }

    function resultFor(plan, state, counters, startedAt, clock, errorClass, extra = {}) {
        const progress = makeProgress(state, counters, startedAt, clock, errorClass, plan?.correlation);
        return { ok: state === "complete", state, progress, telemetry: progress, ...extra, tombstone_eligible: state === "complete" && plan?.authoritative === true && extra.gate_valid === true };
    }

    async function runPlan(plan, deps = {}) {
        const startedAt = nowValue(deps.clock);
        if (!plan?.ok) return plan || planResultFailure(deps, "unsupported", "CANVAS_PLAN_INVALID", "configuration", "A valid history plan is required.");
        if (!planDescriptorMatches(plan)) return resultFor(plan, "partial", { items: 0, pages: 0, windows: 0, retries: 0 }, startedAt, deps.clock, "plan_descriptor", { code: "CANVAS_PLAN_DESCRIPTOR_INVALID", gate_valid: false });
        const resume = deps.resumeCheckpoint || deps.checkpoint;
        if (!sameResumeGate(plan, resume)) {
            const partial = checkpointRequiresPartial(plan, resume);
            return resultFor(plan, partial ? "partial" : "mismatch", { items: 0, pages: 0, windows: 0, retries: 0 }, startedAt, deps.clock, partial ? "checkpoint" : "account_mismatch", { code: partial ? "CANVAS_CHECKPOINT_DESCRIPTOR_MISMATCH" : "CANVAS_CHECKPOINT_SCOPE_MISMATCH", gate_valid: false });
        }
        if (deps.generation !== undefined && Number(deps.generation) !== plan.generation || deps.consentVersion !== undefined && String(deps.consentVersion) !== plan.consent_version) {
            return resultFor(plan, "mismatch", { items: 0, pages: 0, windows: 0, retries: 0 }, startedAt, deps.clock, "scope_mismatch", { code: "CANVAS_RUN_GATE_MISMATCH", gate_valid: false });
        }
        const counters = {
            items: Number(resume?.counters?.items || 0),
            pages: Number(resume?.counters?.pages || 0),
            windows: Number(resume?.counters?.windows || 0),
            retries: Number(resume?.counters?.retries || 0)
        };
        const collected = [];
        const collectItems = deps.collectItems !== false;
        let checkpoint = resume ? clone(resume) : null;
        let startWindow = Number.isInteger(resume?.window_index) ? resume.window_index : 0;
        if (startWindow < 0 || startWindow >= plan.windows.length) startWindow = 0;
        for (let windowIndex = startWindow; windowIndex < plan.windows.length; windowIndex += 1) {
            const request = plan.requests[windowIndex];
            const initial = validateNextUrl(request.url, { expectedOrigin: plan.expectedOrigin, descriptor: plan.plan_descriptor, windowIndex });
            if (!initial.ok) return resultFor(plan, "partial", counters, startedAt, deps.clock, "checkpoint", { code: initial.code || "CANVAS_PLAN_REQUEST_INVALID", checkpoint, items: collected, gate_valid: false });
            let url = initial.url.href;
            if (windowIndex === startWindow && resume) {
                const safeResume = resumeUrl(plan, request, resume, windowIndex);
                if (!safeResume.ok) return resultFor(plan, "partial", counters, startedAt, deps.clock, "checkpoint", { code: safeResume.code || "CANVAS_CHECKPOINT_URL_INVALID", checkpoint, items: collected, gate_valid: false });
                url = safeResume.url.href;
            }
            let page = windowIndex === startWindow && Number.isInteger(resume?.page) ? resume.page : 1;
            let seen = new Set();
            while (url) {
                const position = { windowIndex, page };
                const response = await callPageWithRetry({ url, plan, position, deps: { ...deps, previousCheckpoint: checkpoint }, counters, correlation: plan.correlation });
                counters.retries = Math.max(counters.retries, Number(response.checkpoint?.counters?.retries || 0));
                if (!response.ok) {
                    const failedCheckpoint = response.checkpoint || createCheckpoint(plan, { pageUrl: url, windowIndex, page, counters, previous: checkpoint });
                    checkpoint = failedCheckpoint;
                    return resultFor(plan, response.state || "partial", counters, startedAt, deps.clock, response.errorClass || "failed", { code: response.code, checkpoint, items: collected, gate_valid: false });
                }
                counters.pages += 1;
                counters.items += response.items.length;
                if (collectItems) collected.push(...response.items);
                if (typeof deps.onPage === "function") {
                    let pageResult;
                    try {
                        pageResult = await deps.onPage(clone(response.items), {
                            window_index: windowIndex,
                            page,
                            checkpoint: clone(response.checkpoint),
                            headers: clone(response.headers || {})
                        });
                    } catch (error) {
                        pageResult = { ok: false, code: "CANVAS_PAGE_HANDOFF_FAILED" };
                    }
                    if (pageResult?.ok === false) {
                        checkpoint = response.checkpoint || createCheckpoint(plan, { pageUrl: url, windowIndex, page, counters, previous: checkpoint });
                        return resultFor(plan, "partial", counters, startedAt, deps.clock, "batch", {
                            code: pageResult.code || "CANVAS_PAGE_HANDOFF_FAILED",
                            checkpoint,
                            items: collectItems ? collected : [],
                            gate_valid: false
                        });
                    }
                }
                const parsed = parseLinkHeader(getHeader(response.headers, "link"), { expectedOrigin: plan.expectedOrigin, baseUrl: url, descriptor: plan.plan_descriptor, windowIndex });
                if (!parsed.ok) {
                    checkpoint = createCheckpoint(plan, { pageUrl: url, windowIndex, page, counters, overlapWatermark: plan.overlapWatermark, previous: checkpoint });
                    try { if (deps.saveCheckpoint) await deps.saveCheckpoint(clone(checkpoint)); } catch (error) { /* retain the in-memory checkpoint */ }
                    return resultFor(plan, "partial", counters, startedAt, deps.clock, "malformed", { code: parsed.code || "CANVAS_LINK_HEADER_MALFORMED", checkpoint, items: collected, gate_valid: false });
                }
                for (const item of response.items) {
                    const watermark = watermarkValue(item, plan.watermark_fields);
                    plan.overlapWatermark = greaterWatermark(plan.overlapWatermark, watermark);
                }
                if (parsed.next) {
                    if (seen.has(parsed.next) || parsed.next === url) {
                        checkpoint = createCheckpoint(plan, { pageUrl: url, windowIndex, page, counters, previous: checkpoint });
                        return resultFor(plan, "partial", counters, startedAt, deps.clock, "malformed", { code: "CANVAS_LINK_LOOP", checkpoint, items: collected, gate_valid: false });
                    }
                    seen.add(url);
                    url = parsed.next;
                    page += 1;
                } else {
                    counters.windows += 1;
                    checkpoint = createCheckpoint(plan, { pageUrl: url, windowIndex, page, counters, overlapWatermark: plan.overlapWatermark, previous: checkpoint });
                    try {
                        if (deps.saveCheckpoint) await deps.saveCheckpoint(clone(checkpoint));
                    } catch (error) {
                        return resultFor(plan, "partial", counters, startedAt, deps.clock, "checkpoint", {
                            code: "CANVAS_CHECKPOINT_SAVE_FAILED",
                            checkpoint,
                            items: collectItems ? collected : [],
                            gate_valid: false
                        });
                    }
                    url = null;
                }
            }
        }
        const gateValid = (!resume || sameResumeGate(plan, resume)) && (deps.generation === undefined || Number(deps.generation) === plan.generation) && (deps.consentVersion === undefined || String(deps.consentVersion) === plan.consent_version);
        return resultFor(plan, "complete", counters, startedAt, deps.clock, null, { items: collected, checkpoint, gate_valid: gateValid, lower_bound_authoritative: plan.authoritative });
    }

    async function runHistory(options = {}, deps = {}) {
        const plan = options.incremental ? buildIncrementalPlan(options) : buildFullHistoryPlan(options);
        if (!plan.ok) return plan;
        return runPlan(plan, deps);
    }

    return Object.freeze({
        VERSION,
        MAX_PER_PAGE,
        MAX_RETRY_ATTEMPTS,
        BACKOFF_BASE_MS,
        BACKOFF_MAX_MS,
        capPerPage,
        withCappedPerPage,
        validateNextUrl,
        parseLinkHeader,
        buildRequestUrl,
        buildDateWindows,
        createCheckpoint,
        makeProgress,
        retryAfterMs,
        calculateRetryDelay: ({ headers, attempt = 0, clock, random = Math.random } = {}) => {
            const retryAfter = retryAfterMs(headers, clock);
            if (retryAfter !== null) return retryAfter;
            const randomValue = Number(random());
            const jitter = Number.isFinite(randomValue) ? Math.min(1, Math.max(0, randomValue)) : 0;
            return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * (2 ** Number(attempt))) * jitter;
        },
        buildFullHistoryPlan,
        createFullHistoryPlan: buildFullHistoryPlan,
        buildIncrementalPlan,
        createIncrementalPlan: buildIncrementalPlan,
        runPlan,
        executePlan: runPlan,
        runHistory,
        collectHistory: runHistory
    });
}));
