(function (root, factory) {
    "use strict";
    const api = factory();
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasContent = Object.assign(root.APStudyCanvasContent || {}, { TodoTime: api });
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
    const MAX_CUSTOM_RANGE_DAYS = 90;

    function dateKeyValid(value) {
        if (!DATE_KEY.test(String(value || ""))) return false;
        const [year, month, day] = String(value).split("-").map(Number);
        const date = new Date(Date.UTC(year, month - 1, day));
        return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
    }

    function dateKey(value) {
        if (typeof value === "string" && DATE_KEY.test(value.trim())) return dateKeyValid(value.trim()) ? value.trim() : null;
        const timestamp = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(String(value || ""));
        if (!Number.isFinite(timestamp)) return null;
        return new Date(timestamp).toISOString().slice(0, 10);
    }

    function shiftDateKey(value, days) {
        const key = dateKey(value);
        const amount = Number(days);
        if (!key || !Number.isInteger(amount)) return null;
        const [year, month, day] = key.split("-").map(Number);
        const shifted = new Date(Date.UTC(year, month - 1, day));
        shifted.setUTCDate(shifted.getUTCDate() + amount);
        return shifted.toISOString().slice(0, 10);
    }

    function daysInclusive(start, end) {
        if (!dateKeyValid(start) || !dateKeyValid(end)) return 0;
        const from = Date.parse(`${start}T00:00:00Z`);
        const to = Date.parse(`${end}T00:00:00Z`);
        return to >= from ? Math.floor((to - from) / 86400000) + 1 : 0;
    }

    function validTimeZone(value) {
        if (typeof value !== "string" || !value.trim()) return null;
        try {
            new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
            return value;
        } catch (error) {
            return null;
        }
    }

    function browserTimeZone() {
        try { return validTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone) || "UTC"; }
        catch (error) { return "UTC"; }
    }

    function resolveTimeZone(canvasUserTimeZone, fallback = browserTimeZone()) {
        return validTimeZone(canvasUserTimeZone) || validTimeZone(fallback) || browserTimeZone();
    }

    function localDateKey(value, timeZone) {
        const timestamp = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(String(value || ""));
        if (!Number.isFinite(timestamp)) return null;
        const zone = resolveTimeZone(timeZone);
        try {
            const parts = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(timestamp));
            const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
            const result = `${values.year}-${values.month}-${values.day}`;
            return dateKeyValid(result) ? result : null;
        } catch (error) { return null; }
    }

    function normalizeAnchor(value, timeZone) {
        return dateKeyValid(value) ? value : localDateKey(value === undefined ? Date.now() : value, timeZone);
    }

    function normalizeCustomRange(start, end) {
        if (!dateKeyValid(start) || !dateKeyValid(end) || start > end) {
            return { ok: false, code: "TODO_CUSTOM_RANGE_INVALID" };
        }
        const length = daysInclusive(start, end);
        if (length < 1 || length > MAX_CUSTOM_RANGE_DAYS) return { ok: false, code: "TODO_CUSTOM_RANGE_LIMIT" };
        return { ok: true, value: { start, end, length, inclusive: true, kind: "custom" } };
    }

    function buildRange({ timeframe = "day", now = Date.now(), timeZone, customStart, customEnd } = {}) {
        const zone = resolveTimeZone(timeZone);
        const anchor = normalizeAnchor(now, zone);
        if (!anchor) return { ok: false, code: "TODO_TIME_ANCHOR_INVALID" };
        if (timeframe === "custom") return normalizeCustomRange(customStart, customEnd);
        const lengths = { day: 1, week: 7, month: 30 };
        const length = lengths[timeframe];
        if (!length) return { ok: false, code: "TODO_TIMEFRAME_INVALID" };
        const end = shiftDateKey(anchor, length - 1);
        return { ok: true, value: { start: anchor, end, length, inclusive: true, kind: timeframe, timeZone: zone } };
    }

    function shiftRange(range, direction) {
        if (!range || !dateKeyValid(range.start) || !dateKeyValid(range.end)) return { ok: false, code: "TODO_RANGE_INVALID" };
        const sign = Number(direction);
        if (!Number.isInteger(sign) || ![-1, 1].includes(sign)) return { ok: false, code: "TODO_RANGE_DIRECTION_INVALID" };
        const length = daysInclusive(range.start, range.end);
        const start = shiftDateKey(range.start, sign * length);
        const end = shiftDateKey(range.end, sign * length);
        return { ok: true, value: { ...range, start, end, length, inclusive: true } };
    }

    function dueDateKey(due, timeZone) {
        if (!due) return null;
        if (typeof due === "string" && dateKeyValid(due)) return due;
        if (due.kind === "date" && dateKeyValid(due.date)) return due.date;
        return localDateKey(due.utcInstant || due.at || due.value || due, timeZone);
    }

    function dueIsInRange(due, range, timeZone) {
        const key = dueDateKey(due, timeZone);
        return Boolean(key && range && key >= range.start && key <= range.end);
    }

    function parseDue(value, { timeZone, allDay = false } = {}) {
        if (value === null || value === undefined || value === "") return null;
        const raw = String(value).trim();
        if (dateKeyValid(raw)) return { kind: "date", date: raw, timeZone: resolveTimeZone(timeZone), raw };
        const timestamp = Date.parse(raw);
        if (!Number.isFinite(timestamp)) return null;
        return {
            kind: allDay ? "date" : "instant",
            ...(allDay ? { date: localDateKey(timestamp, timeZone) } : { utcInstant: new Date(timestamp).toISOString() }),
            timeZone: resolveTimeZone(timeZone),
            raw
        };
    }

    return Object.freeze({
        DATE_KEY,
        MAX_CUSTOM_RANGE_DAYS,
        dateKey,
        dateKeyValid,
        shiftDateKey,
        daysInclusive,
        validTimeZone,
        browserTimeZone,
        resolveTimeZone,
        localDateKey,
        buildRange,
        shiftRange,
        dueDateKey,
        dueIsInRange,
        parseDue
    });
}));
