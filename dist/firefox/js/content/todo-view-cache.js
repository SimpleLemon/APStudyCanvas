(function (root, factory) {
    "use strict";
    const api = factory();
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasContent = Object.assign(root.APStudyCanvasContent || {}, { TodoViewCache: api });
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const CACHE_VERSION = 1;
    const STORAGE_KEY = "apstudycanvas.todo.view.v1";
    const DEFAULT_FRESH_TTL_MS = 60 * 1000;
    const DEFAULT_MAX_AGE_MS = 10 * 60 * 1000;
    const DEFAULT_MAX_ENTRIES = 4;
    const DEFAULT_MAX_TASKS = 500;
    const DEFAULT_MAX_BYTES = 768 * 1024;
    const ACCOUNT_KEY = /^[a-f0-9]{64}$/;
    const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

    function plain(value) {
        return Boolean(value) && typeof value === "object" && !Array.isArray(value)
            && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
    }

    function normalizeOrigin(value) {
        if (typeof value !== "string" || !value.trim()) return null;
        try {
            const url = new URL(value);
            return url.protocol === "https:" && url.hostname ? url.origin : null;
        } catch (error) { return null; }
    }

    function text(value, max = 512) {
        if (typeof value !== "string" && typeof value !== "number") return null;
        const result = String(value).replace(/[\u0000-\u001f\u007f]/g, " ").trim();
        return result ? result.slice(0, max) : null;
    }

    function httpsUrl(value) {
        if (typeof value !== "string") return null;
        try {
            const url = new URL(value);
            return url.protocol === "https:" && !url.username && !url.password ? url.href.slice(0, 2048) : null;
        } catch (error) { return null; }
    }

    function hashContext(value) {
        const source = String(value || "");
        let hash = 0x811c9dc5;
        for (let index = 0; index < source.length; index += 1) {
            hash ^= source.charCodeAt(index);
            hash = Math.imul(hash, 0x01000193) >>> 0;
        }
        return hash.toString(16).padStart(8, "0");
    }

    function normalizeRange(value) {
        if (!plain(value)) return null;
        const start = text(value.start, 10), end = text(value.end, 10), timeZone = text(value.timeZone, 96);
        if (!DATE_KEY.test(start || "") || !DATE_KEY.test(end || "") || start > end) return null;
        const result = { start, end, timeZone: timeZone || "UTC" };
        if (Number.isFinite(Number(value.length))) result.length = Math.max(1, Math.min(90, Math.round(Number(value.length))));
        if (value.inclusive === true) result.inclusive = true;
        const kind = text(value.kind, 32);
        if (kind) result.kind = kind;
        return result;
    }

    function settingsSignature(settings = {}) {
        const authority = settings?.todo_completion_authority === "manual" ? "manual" : "canvas";
        return `v1:completion=${authority}`;
    }

    function scopeKey({ origin, accountKey, range, settingsSignature: signature } = {}) {
        const normalizedOrigin = normalizeOrigin(origin);
        const normalizedAccountKey = String(accountKey || "").toLowerCase();
        const normalizedRange = normalizeRange(range);
        const normalizedSignature = text(signature, 160);
        if (!normalizedOrigin || !ACCOUNT_KEY.test(normalizedAccountKey) || !normalizedRange || !normalizedSignature) return null;
        return hashContext([normalizedOrigin, normalizedAccountKey, normalizedRange.start, normalizedRange.end, normalizedRange.timeZone, normalizedSignature].join("|"));
    }

    function safeJson(value, depth = 0) {
        if (depth > 4) return undefined;
        if (value === null || typeof value === "boolean") return value;
        if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
        if (typeof value === "string") return text(value, 2048) ?? "";
        if (Array.isArray(value)) return value.slice(0, 64).map((item) => safeJson(item, depth + 1)).filter((item) => item !== undefined);
        if (!plain(value)) return undefined;
        const output = {};
        Object.keys(value).slice(0, 64).forEach((key) => {
            const safeKey = text(key, 96);
            const safeValue = safeJson(value[key], depth + 1);
            if (safeKey && safeValue !== undefined) output[safeKey] = safeValue;
        });
        return output;
    }

    function safeCourse(value) {
        if (!plain(value)) return null;
        const result = {};
        [["id", 128], ["name", 240], ["code", 160], ["label", 240], ["fullLabel", 320], ["color", 32], ["canvasAccountKey", 64]].forEach(([key, max]) => {
            const candidate = text(value[key], max);
            if (candidate) result[key] = candidate;
        });
        return Object.keys(result).length ? result : null;
    }

    function safeDue(value) {
        if (!plain(value)) return null;
        const kind = value.kind === "date" ? "date" : value.kind === "instant" ? "instant" : null;
        if (!kind) return null;
        const result = { kind };
        if (kind === "date") {
            const date = text(value.date, 10);
            if (!DATE_KEY.test(date || "")) return null;
            result.date = date;
        } else {
            const instant = text(value.utcInstant, 64);
            if (!instant || !Number.isFinite(Date.parse(instant))) return null;
            result.utcInstant = instant;
        }
        const timeZone = text(value.timeZone, 96);
        if (timeZone) result.timeZone = timeZone;
        if (value.allDay === true) result.allDay = true;
        return result;
    }

    function safeRaw(value) {
        if (!plain(value)) return {};
        const output = {};
        const textFields = [
            ["id", 128], ["plannable_id", 128], ["course_id", 128], ["context_code", 160], ["todo_date", 64],
            ["title", 512], ["name", 512], ["details", 4096], ["description", 4096], ["message", 4096],
            ["planner_note_preview", 4096], ["plannable_type", 64], ["type", 64], ["task_type", 64], ["custom_type", 64]
        ];
        textFields.forEach(([key, max]) => {
            const candidate = text(value[key], max);
            if (candidate) output[key] = candidate;
        });
        if (value.planner_note_date_mutation_blocked === true) output.planner_note_date_mutation_blocked = true;
        const nested = plain(value.plannable) ? safeJson(Object.fromEntries([
            "id", "course_id", "todo_date", "title", "details", "description", "message", "plannable_type", "type"
        ].filter((key) => value.plannable[key] !== undefined).map((key) => [key, value.plannable[key]]))) : null;
        if (nested && Object.keys(nested).length) output.plannable = nested;
        return output;
    }

    function safeTask(value, accountKey) {
        if (!plain(value)) return null;
        const id = text(value.id, 256), source = text(value.source, 64), type = text(value.type, 64);
        if (!id || !source || !type) return null;
        const taskAccountKey = text(value.accountKey, 64);
        if (taskAccountKey && taskAccountKey !== accountKey && source !== "nest") return null;
        const task = { id, source, type, accountKey: taskAccountKey || accountKey };
        ["sourceItemKey", "eventRef", "remoteId", "sourceType", "taskType", "customType", "title", "timezone", "priority", "workflowState", "status", "readState", "mutationAuthority", "visibility", "canvasAccountKey", "description"].forEach((key) => {
            const candidate = text(value[key], key === "title" || key === "description" ? 1024 : 512);
            if (candidate) task[key] = candidate;
        });
        const url = httpsUrl(value.url);
        if (url) task.url = url;
        ["completion", "submitted", "graded", "needsGrading", "excused", "late", "missing", "unread"].forEach((key) => {
            if (typeof value[key] === "boolean") task[key] = value[key];
        });
        const course = safeCourse(value.course);
        if (course) task.course = course;
        const due = safeDue(value.due);
        if (due) task.due = due;
        const points = plain(value.points) ? safeJson(value.points) : undefined;
        if (points && Object.keys(points).length) task.points = points;
        const mutation = plain(value.mutation) ? safeJson(value.mutation) : undefined;
        if (mutation && Object.keys(mutation).length) task.mutation = mutation;
        const association = plain(value.courseAssociation) ? safeJson(value.courseAssociation) : undefined;
        if (association && Object.keys(association).length) task.courseAssociation = association;
        const raw = safeRaw(value.raw);
        if (Object.keys(raw).length) task.raw = raw;
        return task;
    }

    function safeCourses(value) {
        return (Array.isArray(value) ? value : []).slice(0, 500).map(safeCourse).filter(Boolean);
    }

    function sanitizeView(value, accountKey, maxTasks = DEFAULT_MAX_TASKS) {
        if (!plain(value) || !ACCOUNT_KEY.test(String(accountKey || ""))) return null;
        const canvasTasks = (Array.isArray(value.canvasTasks) ? value.canvasTasks : []).slice(0, maxTasks).map((task) => safeTask(task, accountKey)).filter(Boolean);
        const nestTasks = (Array.isArray(value.nestTasks) ? value.nestTasks : []).slice(0, maxTasks).map((task) => safeTask(task, accountKey)).filter(Boolean);
        const result = {
            canvasTasks,
            nestTasks,
            courses: safeCourses(value.courses),
            canvasState: text(value.canvasState, 32) || "live",
            nestState: text(value.nestState, 32) || "unavailable",
            announcementState: text(value.announcementState, 32) || "unavailable",
            sourceState: safeJson(value.sourceState) || {},
            streak: safeJson(value.streak) || { state: "unavailable", current: 0, since: null }
        };
        return result;
    }

    function byteLength(value) {
        const serialized = JSON.stringify(value);
        return typeof TextEncoder === "function" ? new TextEncoder().encode(serialized).length : unescape(encodeURIComponent(serialized)).length;
    }

    function clone(value) {
        try { return typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value)); }
        catch (error) { return null; }
    }

    function createTodoViewCache({
        storage = null,
        storageKey = STORAGE_KEY,
        now = () => Date.now(),
        freshTtlMs = DEFAULT_FRESH_TTL_MS,
        maxAgeMs = DEFAULT_MAX_AGE_MS,
        maxEntries = DEFAULT_MAX_ENTRIES,
        maxTasks = DEFAULT_MAX_TASKS,
        maxBytes = DEFAULT_MAX_BYTES
    } = {}) {
        const freshTtl = Number.isFinite(freshTtlMs) && freshTtlMs >= 0 ? freshTtlMs : DEFAULT_FRESH_TTL_MS;
        const maxAge = Number.isFinite(maxAgeMs) && maxAgeMs >= freshTtl ? maxAgeMs : DEFAULT_MAX_AGE_MS;
        const entryLimit = Number.isFinite(maxEntries) ? Math.max(1, Math.min(16, Math.round(maxEntries))) : DEFAULT_MAX_ENTRIES;
        const taskLimit = Number.isFinite(maxTasks) ? Math.max(1, Math.min(1000, Math.round(maxTasks))) : DEFAULT_MAX_TASKS;
        let memoryBlob;
        let loaded = false;

        async function readBlob() {
            if (loaded) return memoryBlob || null;
            loaded = true;
            if (!storage?.get) return null;
            try {
                const stored = await storage.get(storageKey);
                const candidate = plain(stored) && Object.prototype.hasOwnProperty.call(stored, storageKey) ? stored[storageKey] : stored;
                memoryBlob = sanitizeBlob(candidate);
            } catch (error) { memoryBlob = null; }
            return memoryBlob || null;
        }

        function sanitizeBlob(value) {
            if (!plain(value) || value.version !== CACHE_VERSION || !plain(value.entries)) return null;
            const entries = {};
            Object.entries(value.entries).slice(0, 32).forEach(([key, candidate]) => {
                const entry = sanitizeEntry(candidate);
                if (entry && key === entry.scopeKey) entries[key] = entry;
            });
            return { version: CACHE_VERSION, entries };
        }

        function sanitizeEntry(value) {
            if (!plain(value)) return null;
            const origin = normalizeOrigin(value.origin), accountKey = String(value.accountKey || "").toLowerCase();
            const range = normalizeRange(value.range), signature = text(value.settingsSignature, 160), savedAt = Number(value.savedAt);
            if (!origin || !ACCOUNT_KEY.test(accountKey) || !range || !signature || !Number.isFinite(savedAt) || savedAt <= 0) return null;
            const key = scopeKey({ origin, accountKey, range, settingsSignature: signature });
            if (!key || value.scopeKey !== key) return null;
            const view = sanitizeView(value.view, accountKey, taskLimit);
            if (!view) return null;
            return { scopeKey: key, origin, accountKey, range, settingsSignature: signature, savedAt: Math.round(savedAt), view };
        }

        async function read(context = {}) {
            const key = scopeKey(context);
            if (!key) return null;
            const blob = await readBlob();
            const entry = blob?.entries?.[key];
            if (!entry) return null;
            const timestamp = Number(now()), age = timestamp - entry.savedAt;
            if (!Number.isFinite(timestamp) || age < 0 || age > maxAge) return null;
            const view = clone(entry.view);
            if (!view) return null;
            return { view, savedAt: entry.savedAt, fresh: age <= freshTtl, stale: age > freshTtl, ageMs: age };
        }

        async function write(context = {}, view, { isCurrent = () => true } = {}) {
            if (!isCurrent()) return false;
            const origin = normalizeOrigin(context.origin), accountKey = String(context.accountKey || "").toLowerCase();
            const range = normalizeRange(context.range), signature = text(context.settingsSignature, 160);
            const key = scopeKey({ origin, accountKey, range, settingsSignature: signature });
            if (!key || !storage?.set) return false;
            const safeView = sanitizeView(view, accountKey, taskLimit);
            if (!safeView) return false;
            const timestamp = Number(now());
            if (!Number.isFinite(timestamp) || timestamp <= 0) return false;
            const source = (await readBlob()) || { version: CACHE_VERSION, entries: {} };
            if (!isCurrent()) return false;
            const blob = { version: CACHE_VERSION, entries: { ...source.entries } };
            blob.entries[key] = { scopeKey: key, origin, accountKey, range, settingsSignature: signature, savedAt: Math.round(timestamp), view: safeView };
            const ordered = Object.keys(blob.entries).sort((left, right) => blob.entries[left].savedAt - blob.entries[right].savedAt);
            while (ordered.length > entryLimit) delete blob.entries[ordered.shift()];
            if (byteLength(blob) > maxBytes) return false;
            const snapshot = clone(blob);
            if (!snapshot || !isCurrent()) return false;
            try {
                await storage.set(storageKey, snapshot);
                memoryBlob = blob;
                loaded = true;
                return true;
            } catch (error) { return false; }
        }

        async function clear() {
            memoryBlob = null;
            loaded = true;
            if (!storage?.set) return;
            try { await storage.set(storageKey, null); } catch (error) {}
        }

        return Object.freeze({ read, write, clear });
    }

    return Object.freeze({
        CACHE_VERSION,
        STORAGE_KEY,
        DEFAULT_FRESH_TTL_MS,
        DEFAULT_MAX_AGE_MS,
        DEFAULT_MAX_ENTRIES,
        DEFAULT_MAX_TASKS,
        DEFAULT_MAX_BYTES,
        normalizeOrigin,
        normalizeRange,
        settingsSignature,
        scopeKey,
        sanitizeView,
        createTodoViewCache
    });
}));
