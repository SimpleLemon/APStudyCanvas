(function (root, factory) {
    "use strict";
    const api = factory();
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasContent = Object.assign(root.APStudyCanvasContent || {}, { CanvasSearchIndex: api });
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    // Search records are deliberately small, disclosed display metadata. This
    // module never retains Canvas response bodies/descriptions or fetches Canvas.
    const INDEX_VERSION = 1;
    const STORAGE_KEY = "apstudycanvas.canvas-search.v1";
    const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
    const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
    const DEFAULT_MAX_ENTRIES = 4;
    const DEFAULT_MAX_ITEMS = 500;
    const DEFAULT_MAX_BYTES = 512 * 1024;
    const DEFAULT_REFRESH_TIMEOUT_MS = 30 * 1000;
    const TYPE_ORDER = { assignment: 0, file: 1, page: 2, module: 3 };
    const ALLOWED_TYPES = new Set(Object.keys(TYPE_ORDER));

    function isPlainObject(value) {
        return Boolean(value) && typeof value === "object" && !Array.isArray(value)
            && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
    }

    function normalizeOrigin(value) {
        if (typeof value !== "string" || !value.trim()) return null;
        try {
            const url = new URL(value.includes("://") ? value : `https://${value}`);
            return url.protocol === "https:" && url.hostname ? url.origin : null;
        } catch (error) {
            return null;
        }
    }

    function hashContext(value) {
        const text = String(value || "");
        let hash = 0x811c9dc5;
        for (let index = 0; index < text.length; index += 1) {
            hash ^= text.charCodeAt(index);
            hash = Math.imul(hash, 0x01000193) >>> 0;
        }
        return hash.toString(16).padStart(8, "0");
    }

    function safeText(value, maximum) {
        if (typeof value !== "string") return "";
        return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum);
    }

    function safeHref(value, origin) {
        if (typeof value !== "string" || !origin) return null;
        try {
            const url = new URL(value, origin);
            if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password) return null;
            return `${url.pathname}${url.search}${url.hash}`;
        } catch (error) {
            return null;
        }
    }

    function safeRecord(value, origin) {
        if (!isPlainObject(value)) return null;
        const type = safeText(value.type, 24).toLowerCase();
        const id = typeof value.id === "string" || typeof value.id === "number" ? String(value.id).trim().slice(0, 160) : "";
        const title = safeText(value.title || value.name, 240);
        const href = safeHref(value.href || value.url || value.html_url, origin);
        if (!ALLOWED_TYPES.has(type) || !id || !title || !href) return null;
        const record = {
            id,
            type,
            title,
            href,
            courseId: typeof value.courseId === "string" || typeof value.courseId === "number" ? String(value.courseId).trim().slice(0, 128) : "",
            courseName: safeText(value.courseName || value.course, 160),
            moduleLabel: safeText(value.moduleLabel, 160)
        };
        return record;
    }

    function byteLength(value) {
        const serialized = JSON.stringify(value);
        if (typeof TextEncoder === "function") return new TextEncoder().encode(serialized).length;
        return unescape(encodeURIComponent(serialized)).length;
    }

    function clone(value) {
        try { return typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value)); } catch (error) { return undefined; }
    }

    function normalizeQuery(value) {
        return safeText(value, 240).toLocaleLowerCase().split(/\s+/).filter(Boolean).slice(0, 12);
    }

    function compareText(left, right) {
        return left < right ? -1 : left > right ? 1 : 0;
    }

    function rankRecord(record, terms) {
        const title = record.title.toLocaleLowerCase();
        const course = record.courseName.toLocaleLowerCase();
        const moduleLabel = record.moduleLabel.toLocaleLowerCase();
        let score = 0;
        for (const term of terms) {
            if (title === term) score += 120;
            else if (title.startsWith(term)) score += 80;
            else if (title.includes(term)) score += 50;
            else if (course.includes(term)) score += 25;
            else if (moduleLabel.includes(term)) score += 10;
            else return -1;
        }
        return score;
    }

    function createCanvasSearchIndex({
        storage = null,
        storageKey = STORAGE_KEY,
        now = () => Date.now(),
        ttlMs = DEFAULT_TTL_MS,
        maxAgeMs = DEFAULT_MAX_AGE_MS,
        maxEntries = DEFAULT_MAX_ENTRIES,
        maxItems = DEFAULT_MAX_ITEMS,
        maxBytes = DEFAULT_MAX_BYTES,
        refreshTimeoutMs = DEFAULT_REFRESH_TIMEOUT_MS,
        setTimeoutFn = globalThis.setTimeout,
        clearTimeoutFn = globalThis.clearTimeout
    } = {}) {
        const ttl = Number.isFinite(ttlMs) && ttlMs >= 0 ? ttlMs : DEFAULT_TTL_MS;
        const maxAge = Number.isFinite(maxAgeMs) && maxAgeMs >= 0 ? maxAgeMs : DEFAULT_MAX_AGE_MS;
        const entryLimit = Number.isFinite(maxEntries) ? Math.max(1, Math.min(16, Math.round(maxEntries))) : DEFAULT_MAX_ENTRIES;
        const itemLimit = Number.isFinite(maxItems) ? Math.max(1, Math.min(2000, Math.round(maxItems))) : DEFAULT_MAX_ITEMS;
        const byteLimit = Number.isFinite(maxBytes) ? Math.max(1, Math.min(2 * 1024 * 1024, Math.round(maxBytes))) : DEFAULT_MAX_BYTES;
        const refreshDeadline = Number.isFinite(refreshTimeoutMs) ? Math.max(1, Math.min(120000, Math.round(refreshTimeoutMs))) : DEFAULT_REFRESH_TIMEOUT_MS;
        let blob = null;
        let loaded = false;
        let disposed = false;
        let generation = 0;
        let activeController = null;

        function context(origin, accountId) {
            const normalized = normalizeOrigin(origin);
            const account = safeText(String(accountId || ""), 160);
            if (!normalized || !account) return null;
            const accountHash = hashContext(account);
            return { origin: normalized, accountHash, key: hashContext(`${normalized}|${accountHash}`) };
        }

        function sanitizeEntry(value) {
            if (!isPlainObject(value)) return null;
            const origin = normalizeOrigin(value.origin);
            const savedAt = Number(value.savedAt);
            const accountHash = typeof value.accountHash === "string" && /^[a-f0-9]{8}$/.test(value.accountHash) ? value.accountHash : null;
            if (!origin || !accountHash || !Number.isFinite(savedAt) || savedAt <= 0) return null;
            const items = Array.isArray(value.items) ? value.items.map((item) => safeRecord(item, origin)).filter(Boolean).slice(0, itemLimit) : [];
            return { origin, accountHash, savedAt: Math.round(savedAt), items };
        }

        function sanitizeBlob(value) {
            if (!isPlainObject(value) || value.version !== INDEX_VERSION || !isPlainObject(value.entries)) return null;
            const entries = {};
            Object.keys(value.entries).forEach((key) => {
                const entry = sanitizeEntry(value.entries[key]);
                if (entry) entries[key] = entry;
            });
            return { version: INDEX_VERSION, entries };
        }

        async function load() {
            if (loaded) return pruneExpired(blob);
            loaded = true;
            if (!storage || typeof storage.get !== "function") return null;
            try {
                const stored = await storage.get(storageKey);
                blob = sanitizeBlob(isPlainObject(stored) && Object.hasOwn(stored, storageKey) ? stored[storageKey] : stored);
            } catch (error) {
                blob = null;
            }
            return pruneExpired(blob);
        }

        async function persist(next, isCurrent = () => true) {
            const snapshot = clone(next);
            if (!snapshot || !isCurrent()) return false;
            // Persistent storage is optional: an unavailable storage adapter
            // still permits this tab's bounded in-memory session index.
            if (!storage || typeof storage.set !== "function") {
                if (!isCurrent()) return false;
                blob = next;
                return true;
            }
            try {
                if (!Object.keys(snapshot.entries || {}).length && typeof storage.remove === "function") await storage.remove(storageKey);
                else await storage.set(storageKey, snapshot);
                if (!isCurrent()) return false;
                blob = next;
                return true;
            } catch (error) {
                return false;
            }
        }

        async function pruneExpired(source) {
            if (!source) return source;
            const timestamp = Number(now());
            if (!Number.isFinite(timestamp)) return source;
            const entries = {};
            let changed = false;
            Object.entries(source.entries).forEach(([key, entry]) => {
                const age = timestamp - entry.savedAt;
                if (age < 0 || age > maxAge) { changed = true; return; }
                entries[key] = entry;
            });
            if (!changed) return source;
            const next = { version: INDEX_VERSION, entries };
            // Expiration is retention, not merely a read filter: remove stale
            // entries from chrome.storage.local before returning any result.
            if (!await persist(next)) {
                blob = next;
                loaded = true;
            }
            return next;
        }

        function usable(entry) {
            const timestamp = Number(now());
            if (!entry || !Number.isFinite(timestamp)) return null;
            const age = timestamp - entry.savedAt;
            if (age < 0 || age > maxAge) return null;
            return { items: entry.items.map((item) => ({ ...item })), savedAt: entry.savedAt, fresh: age <= ttl, stale: age > ttl };
        }

        async function read({ origin, accountId, enabled = false } = {}) {
            if (disposed || !enabled) return null;
            const identity = context(origin, accountId);
            if (!identity) return null;
            const source = await load();
            const entry = source && source.entries[identity.key];
            return entry && entry.origin === identity.origin && entry.accountHash === identity.accountHash ? usable(entry) : null;
        }

        async function write({ origin, accountId, items, enabled = false, allowEmpty = false, isCurrent } = {}) {
            if (disposed || !enabled) return false;
            const identity = context(origin, accountId);
            const timestamp = Number(now());
            if (!identity || !Number.isFinite(timestamp)) return false;
            const sanitized = Array.isArray(items) ? items.map((item) => safeRecord(item, identity.origin)).filter(Boolean).slice(0, itemLimit) : [];
            if (!sanitized.length && !allowEmpty) return false;
            const source = (await load()) || { version: INDEX_VERSION, entries: {} };
            const entries = { ...source.entries, [identity.key]: { origin: identity.origin, accountHash: identity.accountHash, savedAt: Math.round(timestamp), items: sanitized } };
            const keys = Object.keys(entries).sort((left, right) => entries[left].savedAt - entries[right].savedAt || compareText(left, right));
            while (keys.length > entryLimit) delete entries[keys.shift()];
            while (byteLength({ version: INDEX_VERSION, entries }) > byteLimit && keys.length > 1) delete entries[keys.shift()];
            const candidate = { version: INDEX_VERSION, entries };
            if (byteLength(candidate) > byteLimit || !candidate.entries[identity.key]) return false;
            return persist(candidate, isCurrent);
        }

        async function clear({ origin, accountId } = {}) {
            generation += 1;
            if (activeController) activeController.abort();
            const identity = context(origin, accountId);
            if (!identity) {
                blob = null;
                loaded = true;
                if (storage && typeof storage.remove === "function") {
                    try { await storage.remove(storageKey); } catch (error) { /* fail closed in memory */ }
                } else if (storage && typeof storage.set === "function") {
                    try { await storage.set(storageKey, { version: INDEX_VERSION, entries: {} }); } catch (error) { /* fail closed in memory */ }
                }
                return;
            }
            const source = (await load()) || { version: INDEX_VERSION, entries: {} };
            const entries = { ...source.entries };
            delete entries[identity.key];
            const next = { version: INDEX_VERSION, entries };
            // A failed extension-storage write must not keep serving the entry
            // during this page session. A later load may retry from storage,
            // but this instance fails closed immediately.
            if (!await persist(next)) {
                blob = next;
                loaded = true;
            }
        }

        async function refresh({ origin, accountId, enabled = false, collect, signal } = {}) {
            if (disposed || !enabled || typeof collect !== "function") return { ok: false, code: "CANVAS_SEARCH_DISABLED" };
            const identity = context(origin, accountId);
            if (!identity) return { ok: false, code: "CANVAS_SEARCH_CONTEXT_INVALID" };
            generation += 1;
            const requestGeneration = generation;
            if (activeController) activeController.abort();
            const controller = new AbortController();
            activeController = controller;
            const abort = () => controller.abort();
            if (signal) {
                if (signal.aborted) abort();
                else signal.addEventListener("abort", abort, { once: true });
            }
            let deadlineTimer = null;
            let timedOut = false;
            const current = () => !disposed && requestGeneration === generation && !controller.signal.aborted && !timedOut;
            const deadline = new Promise((resolve) => {
                deadlineTimer = (setTimeoutFn || setTimeout)(() => {
                    timedOut = true;
                    controller.abort();
                    resolve({ timeout: true });
                }, refreshDeadline);
            });
            try {
                let collectedPromise;
                try { collectedPromise = Promise.resolve(collect({ origin: identity.origin, signal: controller.signal })); } catch (error) { collectedPromise = Promise.reject(error); }
                const outcome = await Promise.race([collectedPromise.then((value) => ({ value }), (error) => ({ error })), deadline]);
                if (outcome.timeout || timedOut) return { ok: false, code: "CANVAS_SEARCH_TIMEOUT" };
                if (outcome.error) throw outcome.error;
                const collected = outcome.value;
                if (!current()) return { ok: false, code: "CANVAS_SEARCH_CANCELLED" };
                const records = Array.isArray(collected) ? collected : Array.isArray(collected?.items) ? collected.items : [];
                const failures = Array.isArray(collected?.failures) ? collected.failures.filter((code) => typeof code === "string").slice(0, 16) : [];
                // Do not replace a usable cache with an empty result produced
                // solely by endpoint failures. A genuinely empty Canvas account
                // is still a valid, fresh empty index.
                if (!records.length && failures.length) return { ok: false, code: failures.includes("PHASE_FOUR_READ_429") ? "CANVAS_SEARCH_RATE_LIMITED" : failures.includes("CANVAS_SEARCH_TIMEOUT") ? "CANVAS_SEARCH_TIMEOUT" : "CANVAS_SEARCH_REFRESH_FAILED" };
                const savedOutcome = await Promise.race([write({ origin: identity.origin, accountId, items: records, enabled: true, allowEmpty: true, isCurrent: current }).then((value) => ({ value })), deadline]);
                if (savedOutcome.timeout || timedOut) return { ok: false, code: "CANVAS_SEARCH_TIMEOUT" };
                const saved = savedOutcome.value;
                return saved ? (failures.length ? { ok: true, partial: true } : { ok: true }) : { ok: false, code: "CANVAS_SEARCH_WRITE_FAILED" };
            } catch (error) {
                return { ok: false, code: timedOut ? "CANVAS_SEARCH_TIMEOUT" : controller.signal.aborted ? "CANVAS_SEARCH_CANCELLED" : error?.status === 429 ? "CANVAS_SEARCH_RATE_LIMITED" : "CANVAS_SEARCH_REFRESH_FAILED" };
            } finally {
                if (deadlineTimer !== null) (clearTimeoutFn || clearTimeout)(deadlineTimer);
                if (signal) signal.removeEventListener("abort", abort);
                if (activeController === controller) activeController = null;
            }
        }

        async function query({ origin, accountId, enabled = false, query, limit = 20 } = {}) {
            const cached = await read({ origin, accountId, enabled });
            const terms = normalizeQuery(query);
            if (!cached || !terms.length) return { items: [], stale: Boolean(cached && cached.stale) };
            const resultLimit = Number.isFinite(limit) ? Math.max(1, Math.min(100, Math.round(limit))) : 20;
            const items = cached.items.map((item) => ({ item, score: rankRecord(item, terms) }))
                .filter((entry) => entry.score >= 0)
                .sort((left, right) => right.score - left.score || TYPE_ORDER[left.item.type] - TYPE_ORDER[right.item.type] || compareText(left.item.title, right.item.title) || compareText(left.item.id, right.item.id))
                .slice(0, resultLimit)
                .map((entry) => ({ ...entry.item }));
            return { items, stale: cached.stale };
        }

        function dispose() {
            disposed = true;
            generation += 1;
            if (activeController) activeController.abort();
            activeController = null;
            blob = null;
        }

        return { read, write, clear, refresh, query, dispose };
    }

    return { INDEX_VERSION, STORAGE_KEY, DEFAULT_TTL_MS, DEFAULT_MAX_AGE_MS, DEFAULT_MAX_ENTRIES, DEFAULT_MAX_ITEMS, DEFAULT_MAX_BYTES, DEFAULT_REFRESH_TIMEOUT_MS, normalizeOrigin, safeHref, safeRecord, createCanvasSearchIndex };
}));
