(function (root, factory) {
    "use strict";
    const api = factory();
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasContent = Object.assign(root.APStudyCanvasContent || {}, { SidebarCourseCache: api });
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    // v1 stores one bounded blob under a single local key. The key hashes the
    // Canvas origin, so stored state never carries a reusable account identifier.
    const CACHE_VERSION = 1;
    const STORAGE_KEY = "apstudycanvas.sidebar.courses.v1";
    const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
    const DEFAULT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
    const DEFAULT_MAX_ENTRIES = 4;
    const DEFAULT_MAX_COURSES = 200;
    // A course record is intentionally tiny (id, name, href, color). The byte
    // cap only guards against a hostile or corrupted storage payload.
    const DEFAULT_MAX_BYTES = 256 * 1024;

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

    // FNV-1a keeps the storage key opaque without importing the adapter's
    // crypto helpers into every content page. Collisions are additionally
    // rejected on read because each entry carries its own origin.
    function hashContext(value) {
        const text = String(value || "");
        let hash = 0x811c9dc5;
        for (let index = 0; index < text.length; index += 1) {
            hash ^= text.charCodeAt(index);
            hash = Math.imul(hash, 0x01000193) >>> 0;
        }
        return hash.toString(16).padStart(8, "0");
    }

    function safeCourse(value) {
        if (!isPlainObject(value)) return null;
        const id = typeof value.id === "string" || typeof value.id === "number" ? String(value.id).trim() : "";
        const name = typeof value.name === "string" ? value.name.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 160) : "";
        const href = typeof value.href === "string" && /^https:\/\//.test(value.href) ? value.href : null;
        if (!id || id.length > 128 || !name || !href) return null;
        const course = { id, name, href };
        if (typeof value.color === "string" && /^#[0-9a-fA-F]{3,8}$/.test(value.color)) course.color = value.color;
        return course;
    }

    function byteLength(value) {
        const serialized = JSON.stringify(value);
        if (typeof TextEncoder === "function") return new TextEncoder().encode(serialized).length;
        return unescape(encodeURIComponent(serialized)).length;
    }

    function clone(value) {
        if (value === undefined) return undefined;
        if (typeof structuredClone === "function") {
            try { return structuredClone(value); } catch (error) { return undefined; }
        }
        try { return JSON.parse(JSON.stringify(value)); } catch (error) { return undefined; }
    }

    /**
     * Bounded last-known course cache with stale-while-revalidate semantics.
     *
     * const cache = createSidebarCourseCache({ storage: { async get(k) {}, async set(k, v) {} } });
     * cache.read({ origin, userId })   -> { courses, savedAt, fresh } | null
     * cache.write({ origin, userId, courses }) -> true | false
     * cache.clear()
     *
     * Reads never throw: storage failures behave like a cold cache so the rail
     * always falls back to its live fetch path.
     */
    function createSidebarCourseCache({
        storage = null,
        storageKey = STORAGE_KEY,
        now = () => Date.now(),
        ttlMs = DEFAULT_TTL_MS,
        maxAgeMs = DEFAULT_MAX_AGE_MS,
        maxEntries = DEFAULT_MAX_ENTRIES,
        maxCourses = DEFAULT_MAX_COURSES,
        maxBytes = DEFAULT_MAX_BYTES
    } = {}) {
        const ttl = Number.isFinite(ttlMs) && ttlMs >= 0 ? ttlMs : DEFAULT_TTL_MS;
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
            const courses = Array.isArray(value.courses) ? value.courses.map(safeCourse).filter(Boolean).slice(0, courseLimit) : [];
            const userId = typeof value.userId === "string" && value.userId.length <= 32 ? value.userId : null;
            return { origin, userId, savedAt: Math.round(savedAt), courses };
        }

        function entryUsable(entry, { userId } = {}) {
            if (!entry) return null;
            const timestamp = Number(now());
            if (!Number.isFinite(timestamp)) return null;
            const age = timestamp - entry.savedAt;
            if (age < 0 || age > maxAge) return null;
            if (userId && entry.userId && String(userId) !== String(entry.userId)) return null;
            return { courses: entry.courses, savedAt: entry.savedAt, fresh: age <= ttl, stale: age > ttl };
        }

        async function read({ origin, userId } = {}) {
            const normalized = normalizeOrigin(origin);
            if (!normalized) return null;
            const blob = await readBlob();
            if (!blob) return null;
            const entry = blob.entries[hashContext(normalized)];
            // A hash collision must not serve another origin's courses.
            if (!entry || entry.origin !== normalized) return null;
            return entryUsable(entry, { userId });
        }

        async function write({ origin, userId, courses } = {}) {
            const normalized = normalizeOrigin(origin);
            if (!normalized || !storage || typeof storage.set !== "function") return false;
            const list = Array.isArray(courses) ? courses.map(safeCourse).filter(Boolean).slice(0, courseLimit) : [];
            if (!list.length) return false;
            const timestamp = Number(now());
            if (!Number.isFinite(timestamp)) return false;
            const source = (await readBlob()) || { version: CACHE_VERSION, entries: {} };
            // Stage the write on a shallow copy: a rejected write must never
            // leak its staged entry into the in-memory blob that later reads
            // serve or later writes persist.
            const blob = { version: CACHE_VERSION, entries: { ...source.entries } };
            const key = hashContext(normalized);
            blob.entries[key] = { origin: normalized, userId: typeof userId === "string" ? userId.slice(0, 32) : null, savedAt: Math.round(timestamp), courses: list };
            const keys = Object.keys(blob.entries)
                .sort((left, right) => blob.entries[left].savedAt - blob.entries[right].savedAt);
            while (keys.length > entryLimit) delete blob.entries[keys.shift()];
            if (byteLength(blob) > maxBytes) return false;
            const snapshot = clone(blob);
            if (!snapshot) return false;
            memoryBlob = blob;
            try {
                await storage.set(storageKey, snapshot);
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
        DEFAULT_TTL_MS,
        DEFAULT_MAX_AGE_MS,
        DEFAULT_MAX_ENTRIES,
        DEFAULT_MAX_COURSES,
        hashContext,
        normalizeOrigin,
        createSidebarCourseCache
    });
}));
