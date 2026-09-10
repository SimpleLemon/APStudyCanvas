(function (root, factory) {
    "use strict";
    const api = factory();
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasContent = Object.assign(root.APStudyCanvasContent || {}, { SidebarDisplayedCards: api });
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    // Bounded last-known displayed-card subset, keyed by Canvas origin so the
    // stored state never carries a reusable account identifier. The rail reads
    // this on pages without a rendered card section so the sidebar keeps
    // mirroring the dashboard's actual card set instead of falling open to
    // every active enrollment.
    const CACHE_VERSION = 1;
    const STORAGE_KEY = "apstudycanvas.sidebar.displayed-cards.v1";
    const DEFAULT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
    const DEFAULT_MAX_ENTRIES = 4;
    const DEFAULT_MAX_COURSES = 200;
    const DEFAULT_MAX_BYTES = 64 * 1024;

    function isPlainObject(value) {
        return Boolean(value) && typeof value === "object" && !Array.isArray(value)
            && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
    }

    function normalizeOrigin(value) {
        if (typeof value !== "string" || !value.trim()) return null;
        try {
            const url = new URL(value.includes("://") ? value : `https://${value}`);
            if (url.protocol !== "https:" || !url.hostname) return null;
            return url.origin;
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

    function safeCourseId(value) {
        if (typeof value !== "string" && typeof value !== "number") return null;
        const candidate = String(value).trim();
        return /^[1-9]\d{0,19}$/.test(candidate) ? candidate : null;
    }

    function byteLength(value) {
        const serialized = JSON.stringify(value);
        if (typeof TextEncoder === "function") return new TextEncoder().encode(serialized).length;
        return unescape(encodeURIComponent(serialized)).length;
    }

    function createDisplayedCardCache({
        storage = null,
        storageKey = STORAGE_KEY,
        now = () => Date.now(),
        maxAgeMs = DEFAULT_MAX_AGE_MS,
        maxEntries = DEFAULT_MAX_ENTRIES,
        maxCourses = DEFAULT_MAX_COURSES,
        maxBytes = DEFAULT_MAX_BYTES
    } = {}) {
        const maxAge = Number.isFinite(maxAgeMs) && maxAgeMs >= 0 ? maxAgeMs : DEFAULT_MAX_AGE_MS;
        const entryLimit = Number.isFinite(maxEntries) ? Math.max(1, Math.min(16, Math.round(maxEntries))) : DEFAULT_MAX_ENTRIES;
        const courseLimit = Number.isFinite(maxCourses) ? Math.max(1, Math.min(500, Math.round(maxCourses))) : DEFAULT_MAX_COURSES;
        let memoryBlob = null;
        let memoryLoaded = false;

        async function readBlob() {
            if (memoryLoaded) return memoryBlob;
            memoryLoaded = true;
            if (!storage || typeof storage.get !== "function") return null;
            try {
                const stored = await storage.get(storageKey);
                const value = isPlainObject(stored) && Object.prototype.hasOwnProperty.call(stored, storageKey)
                    ? stored[storageKey]
                    : stored;
                memoryBlob = sanitizeBlob(value);
            } catch (error) {
                memoryBlob = null;
            }
            return memoryBlob;
        }

        function sanitizeBlob(value) {
            if (!isPlainObject(value) || value.version !== CACHE_VERSION || !isPlainObject(value.entries)) return null;
            const entries = {};
            Object.keys(value.entries).forEach((key) => {
                const entry = sanitizeEntry(value.entries[key]);
                if (entry) entries[key] = entry;
            });
            return { version: CACHE_VERSION, entries };
        }

        function sanitizeEntry(value) {
            if (!isPlainObject(value)) return null;
            const origin = normalizeOrigin(value.origin);
            const savedAt = Number(value.savedAt);
            if (!origin || !Number.isFinite(savedAt) || savedAt <= 0) return null;
            const courseIds = Array.isArray(value.courseIds) ? value.courseIds.map(safeCourseId).filter(Boolean).slice(0, courseLimit) : [];
            const userId = typeof value.userId === "string" && value.userId.length <= 32 ? value.userId : null;
            return { origin, userId, savedAt: Math.round(savedAt), courseIds };
        }

        async function read({ origin } = {}) {
            const normalized = normalizeOrigin(origin);
            if (!normalized) return null;
            const blob = await readBlob();
            if (!blob) return null;
            const entry = blob.entries[hashContext(normalized)];
            // A hash collision must not serve another origin's card set.
            if (!entry || entry.origin !== normalized) return null;
            const age = Number(now()) - entry.savedAt;
            if (!Number.isFinite(age) || age < 0 || age > maxAge) return null;
            return { courseIds: entry.courseIds.slice(), savedAt: entry.savedAt };
        }

        async function write({ origin, userId, courseIds } = {}) {
            const normalized = normalizeOrigin(origin);
            if (!normalized || !storage || typeof storage.set !== "function") return false;
            const ids = Array.isArray(courseIds) ? courseIds.map(safeCourseId).filter(Boolean).slice(0, courseLimit) : [];
            if (!ids.length) return false;
            const timestamp = Number(now());
            if (!Number.isFinite(timestamp)) return false;
            const source = (await readBlob()) || { version: CACHE_VERSION, entries: {} };
            // Stage the write on a shallow copy: a rejected write must never
            // leak its staged entry into the in-memory blob that later reads
            // serve or later writes persist.
            const blob = { version: CACHE_VERSION, entries: { ...source.entries } };
            const key = hashContext(normalized);
            blob.entries[key] = { origin: normalized, userId: typeof userId === "string" ? userId.slice(0, 32) : null, savedAt: Math.round(timestamp), courseIds: ids };
            const keys = Object.keys(blob.entries)
                .sort((left, right) => blob.entries[left].savedAt - blob.entries[right].savedAt);
            while (keys.length > entryLimit) delete blob.entries[keys.shift()];
            if (byteLength(blob) > maxBytes) return false;
            try {
                await storage.set(storageKey, blob);
                memoryBlob = blob;
                return true;
            } catch (error) {
                return false;
            }
        }

        async function clear() {
            memoryBlob = null;
            memoryLoaded = true;
            if (!storage || typeof storage.set !== "function") return;
            try { await storage.set(storageKey, null); } catch (error) {}
        }

        return Object.freeze({ read, write, clear, constants: Object.freeze({ CACHE_VERSION, STORAGE_KEY }) });
    }

    return Object.freeze({
        CACHE_VERSION,
        STORAGE_KEY,
        DEFAULT_MAX_AGE_MS,
        DEFAULT_MAX_ENTRIES,
        DEFAULT_MAX_COURSES,
        hashContext,
        normalizeOrigin,
        createDisplayedCardCache
    });
}));
