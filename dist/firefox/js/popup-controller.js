(function (root, factory) {
    "use strict";

    const api = factory(root);
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasPopupController = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
    "use strict";

    const CATEGORIES = Object.freeze([
        "overview", "appearance", "sidebar", "course-cards", "study-tools",
        "themes", "gpa-grades", "calendar-accounts", "data-support"
    ]);
    const CATEGORY_LABELS = Object.freeze({
        overview: "Overview",
        appearance: "Appearance",
        sidebar: "Sidebar",
        "course-cards": "Course Cards",
        "study-tools": "Study Tools",
        themes: "Themes",
        "gpa-grades": "GPA & Grades",
        "calendar-accounts": "Calendar & Accounts",
        "data-support": "Data & Support"
    });
    const ONBOARDING_KEY = "nest_onboarding_dismissed";
    const FULLSCREEN_URL = "https://nest.apstudy.org/login";
    const DEFAULT_SIDEBAR_PAGE_ORDER = Object.freeze(["dashboard", "courses", "calendar", "inbox", "history", "help"]);
    const DEFAULT_SIDEBAR_VISIBILITY = Object.freeze({ dashboard: true, courses: true, calendar: true, inbox: true, history: true, help: true });
    const THEME_ALLOWED_SETTING_KEYS = Object.freeze([
        "remind", "tab_icons", "hide_feedback", "dark_mode", "remlogo", "full_width", "auto_dark", "assignments_due", "gpa_calc", "gradient_cards", "gradent_cards", "disable_color_overlay", "dashboard_grades", "dashboard_notes", "better_todo", "better_sidebar", "condensed_cards",
        "todo_hide_feedback", "todo_full_height", "todo_confetti", "device_dark", "relative_dues", "card_overdues", "gpa_calc_prepend", "auto_dark_start", "auto_dark_end", "num_assignments", "assignment_date_format", "todo_hr24", "todo_separate_scrollbar", "grade_hover", "num_todo_items", "hover_preview", "customCardStyles", "imageSize", "cardRoundness", "cardSpacing", "cardWidth", "cardHeight", "customBackgroundLink", "customBackgroundScale", "sidebar_scale",
        "dark_preset", "custom_font", "gpa_calc_bounds", "custom_cards", "custom_styles", "sidebar_page_order", "sidebar_page_visibility"
    ]);
    const THEME_BOOLEAN_KEYS = new Set([
        "remind", "tab_icons", "hide_feedback", "dark_mode", "remlogo", "full_width", "auto_dark", "assignments_due", "gpa_calc", "gradient_cards", "gradent_cards", "disable_color_overlay", "dashboard_grades", "dashboard_notes", "better_todo", "better_sidebar", "condensed_cards", "todo_hide_feedback", "todo_full_height", "todo_confetti", "device_dark", "relative_dues", "card_overdues", "gpa_calc_prepend", "todo_hr24", "todo_separate_scrollbar", "grade_hover", "hover_preview", "customCardStyles"
    ]);
    const THEME_NUMBER_KEYS = new Set(["num_assignments", "num_todo_items", "imageSize", "cardRoundness", "cardSpacing", "cardWidth", "cardHeight", "customBackgroundScale", "sidebar_scale"]);
    const THEME_STRING_KEYS = new Set(["customBackgroundLink", "custom_styles"]);
    const THEME_ARRAY_KEYS = new Set(["custom_domain", "assignments_done", "dark_mode_fix", "sidebar_page_order"]);
    const THEME_OBJECT_KEYS = new Set(["auto_dark_start", "auto_dark_end", "dark_preset", "custom_font", "gpa_calc_bounds", "custom_cards", "sidebar_page_visibility"]);

    function isPlainObject(value) {
        if (!value || typeof value !== "object" || Array.isArray(value)) return false;
        const prototype = Object.getPrototypeOf(value);
        return prototype === Object.prototype || prototype === null;
    }

    function isCanvasContextEventRecord(value) {
        if (!value || typeof value !== "object" || Array.isArray(value)) return false;
        try {
            const prototype = Object.getPrototypeOf(value);
            if (prototype === null || prototype === Object.prototype) return true;
            const constructor = Object.prototype.hasOwnProperty.call(prototype, "constructor")
                ? prototype.constructor
                : null;
            return typeof constructor === "function" && constructor.name === "Object" && constructor.prototype === prototype;
        } catch (error) {
            return false;
        }
    }

    function normalizeSourceCanvasTabId(value) {
        return Number.isSafeInteger(value) && value >= 0 ? value : null;
    }

    function isWorkspaceRoute(search) {
        const query = new URLSearchParams(search || "");
        return query.get("view") === "workspace" || query.get("fullscreen") === "1";
    }

    function clone(value) {
        if (value === undefined) return undefined;
        if (typeof structuredClone === "function") return structuredClone(value);
        return JSON.parse(JSON.stringify(value));
    }

    function isHttpsAvatar(value) {
        if (typeof value !== "string" || !value.trim()) return false;
        try {
            const url = new URL(value.trim());
            return url.protocol === "https:" && !url.username && !url.password && Boolean(url.hostname);
        } catch (error) {
            return false;
        }
    }

    function cleanName(value) {
        return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, 120) : "";
    }

    function initials(value) {
        const parts = cleanName(value).split(" ").filter(Boolean);
        if (!parts.length) return "?";
        return (parts.length === 1 ? parts[0][0] : `${parts[0][0]}${parts[parts.length - 1][0]}`).toUpperCase().slice(0, 2);
    }

    function profileFrom(value) {
        const source = isPlainObject(value) ? value : {};
        const profile = isPlainObject(source.profile) ? source.profile : source;
        const name = cleanName(profile.displayName || profile.displayname || profile.name || source.displayName || source.name);
        const avatarUrl = isHttpsAvatar(profile.avatarUrl || profile.avatarurl || source.avatarUrl || source.avatarurl)
            ? (profile.avatarUrl || profile.avatarurl || source.avatarUrl || source.avatarurl).trim()
            : null;
        return { name, avatarUrl };
    }

    function normalizeIdentityResponse(response) {
        const envelope = isPlainObject(response) ? response : {};
        const payload = isPlainObject(envelope.payload) ? envelope.payload : envelope;
        const body = isPlainObject(payload.body) ? payload.body : isPlainObject(payload.data) ? payload.data : payload;
        const code = String(payload.code || body.code || "").toUpperCase();
        const status = Number(payload.status || body.status || 0);
        if (code.includes("EXPIRED") || code.includes("TOKEN_EXPIRED") || code.includes("SESSION_EXPIRED")) {
            return { state: "expired", profile: null, raw: payload };
        }
        if (payload.ok === false || envelope.ok === false || (status >= 400 && status < 500)) {
            if (status === 401 || status === 403 || code.includes("SIGNED_OUT") || code.includes("UNAUTHENTICATED")) {
                return { state: "signed_out", profile: null, raw: payload };
            }
            return { state: "unavailable", profile: null, raw: payload };
        }
        if (body.authenticated === false || body.identity === null || body.identity === "signed_out" || body.state === "signed_out") {
            return { state: "signed_out", profile: null, raw: payload };
        }
        const identity = body.identity || body.accountId || body.accountid || body.userId || body.userid;
        const profile = profileFrom(body);
        if (payload.ok === true || envelope.ok === true || identity || profile.name || profile.avatarUrl) {
            const linkedAccounts = Array.isArray(body.linkedAccounts || body.linked_accounts)
                ? (body.linkedAccounts || body.linked_accounts).filter((account) => isPlainObject(account)).map(clone)
                : [];
            return { state: "authenticated", profile, identity: cleanName(identity), linkedAccounts, raw: payload };
        }
        return { state: "unavailable", profile: null, raw: payload };
    }

    function resolveProfile(nestProfile, canvasProfile, fallbackName = "") {
        const nest = profileFrom(nestProfile);
        const canvas = profileFrom(canvasProfile);
        const name = nest.name || canvas.name || cleanName(fallbackName);
        const avatarUrl = nest.avatarUrl || canvas.avatarUrl || null;
        const source = nest.name || nest.avatarUrl ? "nest" : canvas.name || canvas.avatarUrl ? "canvas" : "fallback";
        return { name, avatarUrl, initials: initials(name), source };
    }

    function reorderItems(items, index, direction) {
        const next = Array.isArray(items) ? items.slice() : [];
        const from = Number(index);
        const to = from + (direction === "up" ? -1 : 1);
        if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= next.length || to >= next.length) return next;
        [next[from], next[to]] = [next[to], next[from]];
        return next;
    }

    function normalizeSidebarOrder(value, defaults = DEFAULT_SIDEBAR_PAGE_ORDER) {
        const known = Array.isArray(defaults)
            ? defaults.filter((page, index, pages) => typeof page === "string" && pages.indexOf(page) === index)
            : Array.from(DEFAULT_SIDEBAR_PAGE_ORDER);
        const seen = new Set();
        const normalized = [];
        const entries = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
        entries.forEach((page) => {
            if (typeof page !== "string" || !known.includes(page) || seen.has(page)) return;
            seen.add(page);
            normalized.push(page);
        });
        known.forEach((page) => {
            if (seen.has(page)) return;
            seen.add(page);
            normalized.push(page);
        });
        return normalized;
    }

    function identityKey(identity) {
        if (!isPlainObject(identity)) return "";
        return cleanName(identity.identity || identity.accountId || identity.accountid || identity.userId || identity.userid || identity.profile?.name || identity.profile?.displayName || "");
    }

    function sameArray(left, right) {
        return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => value === right[index]);
    }

    function normalizedCategory(value, fallback = "overview") {
        return CATEGORIES.includes(value) ? value : fallback;
    }

    function callStorage(chromeApi, area, method, ...args) {
        const storage = chromeApi?.storage?.[area];
        if (!storage || typeof storage[method] !== "function") return Promise.reject(new Error(`storage.${area}.${method} unavailable`));
        try {
            const result = storage[method](...args);
            return result && typeof result.then === "function" ? result : Promise.resolve(result);
        } catch (error) {
            return Promise.reject(error);
        }
    }

    function writeResultError(result, fallbackCode) {
        if (result === null || result === false || (isPlainObject(result) && result.ok === false)) {
            const error = new Error(result?.code || fallbackCode);
            error.code = result?.code || fallbackCode;
            return error;
        }
        return null;
    }

    function createSettingsStore({ sendUpdate, sendReset, read = async () => ({}), aliases = {}, normalizers = {}, debounceMs = 180, setTimer = setTimeout, clearTimer = clearTimeout, onStatus = () => {}, onSaved = () => {}, onRollback = () => {}, onPending = () => {} } = {}) {
        if (typeof sendUpdate !== "function") throw new Error("SETTINGS_UPDATE_REQUIRED");
        const pending = new Map();
        const latestEntries = new Map();
        let operationTail = Promise.resolve();
        let activeDrain = null;
        let debounceTimer = null;
        let sequence = 0;

        function normalizeValue(key, value) {
            return typeof normalizers[key] === "function" ? normalizers[key](clone(value)) : clone(value);
        }

        function expand(key, value) {
            const keys = Array.isArray(aliases[key]) ? aliases[key] : [key];
            return Object.fromEntries(keys.map((item) => [item, clone(value)]));
        }

        function notifyPending(key, value) {
            try { onPending(key, value); } catch (error) {}
        }

        function notifySaved(key, value) {
            try { onSaved(key, clone(value)); } catch (error) {}
        }

        function notifyRollback(key, value) {
            try { onRollback(key, clone(value)); } catch (error) {}
        }

        function notifyStatus(message, error = false) {
            try { onStatus(message, error); } catch (ignored) {}
        }

        function clearDebounceTimer() {
            if (debounceTimer === null) return;
            clearTimer(debounceTimer);
            debounceTimer = null;
        }

        function scheduleDrain() {
            clearDebounceTimer();
            debounceTimer = setTimer(() => {
                debounceTimer = null;
                flush().catch(() => {});
            }, Math.max(0, Number(debounceMs) || 0));
        }

        function createSettingsError(error, fallbackCode = "SETTINGS_UPDATE_FAILED") {
            const rawCode = typeof error?.code === "string" ? error.code : typeof error?.message === "string" ? error.message : fallbackCode;
            const code = rawCode.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 80) || fallbackCode;
            const rawMessage = typeof error?.message === "string" ? error.message : code;
            const message = /(?:password|passphrase|secret|token|csrf|cookie|authorization|credential|private[_-]?key|api[_-]?key)/i.test(rawMessage)
                ? "Settings operation failed; sensitive details were redacted."
                : rawMessage.slice(0, 200);
            const sanitized = new Error(message || code);
            sanitized.code = code;
            return sanitized;
        }

        function aggregateSettingsErrors(failures) {
            const details = failures.map(({ key, error }) => ({ key, code: error.code, message: error.message }));
            const aggregate = new Error("SETTINGS_FLUSH_FAILED");
            aggregate.name = "SettingsFlushError";
            aggregate.code = "SETTINGS_FLUSH_FAILED";
            aggregate.errors = details;
            aggregate.failures = details;
            return aggregate;
        }

        function responsePayload(result) {
            return isPlainObject(result?.payload) ? result.payload : isPlainObject(result) ? result : {};
        }

        function keyedStatusFailure(status, key) {
            if (status === undefined || status === true || status === "ok" || status === "success") return null;
            if (status === null || status === false || status === "failed" || status === "error") {
                return createSettingsError({ code: "SETTINGS_KEY_UPDATE_FAILED", message: `Setting ${key} failed.` }, "SETTINGS_KEY_UPDATE_FAILED");
            }
            if (!isPlainObject(status)) return null;
            if (status.ok === false || status.success === false || status.failed === true || status.status === "failed" || status.status === "error" || status.error || status.failure) {
                return createSettingsError(status.error || status.failure || status, "SETTINGS_KEY_UPDATE_FAILED");
            }
            return null;
        }

        function failureForEntry(result, entry) {
            const payload = responsePayload(result);
            const expandedKeys = entry.expandedKeys;
            const keyedContainers = [payload.results, payload.perKey, payload.per_key, payload.keyResults, payload.key_results, payload.keys]
                .filter((value) => isPlainObject(value));
            let hasExplicitKeyStatus = false;
            for (const container of keyedContainers) {
                for (const key of expandedKeys) {
                    if (!Object.prototype.hasOwnProperty.call(container, key)) continue;
                    hasExplicitKeyStatus = true;
                    const failure = keyedStatusFailure(container[key], key);
                    if (failure) return failure;
                }
            }
            if (hasExplicitKeyStatus || keyedContainers.length) return null;

            const failedKeys = payload.failedKeys || payload.failed_keys || payload.failed || payload.errors;
            const hasExplicitFailedKeyList = Array.isArray(payload.failedKeys) || Array.isArray(payload.failed_keys) || isPlainObject(payload.failedKeys) || isPlainObject(payload.failed_keys);
            if (Array.isArray(failedKeys) && expandedKeys.some((key) => failedKeys.includes(key))) {
                return createSettingsError({ code: "SETTINGS_KEY_UPDATE_FAILED", message: `Setting ${entry.key} failed.` }, "SETTINGS_KEY_UPDATE_FAILED");
            }
            if (isPlainObject(failedKeys) && expandedKeys.some((key) => Object.prototype.hasOwnProperty.call(failedKeys, key))) {
                const failedKey = expandedKeys.find((key) => Object.prototype.hasOwnProperty.call(failedKeys, key));
                return createSettingsError(failedKeys[failedKey], "SETTINGS_KEY_UPDATE_FAILED");
            }
            if (hasExplicitFailedKeyList) return null;
            if (payload.ok === false || result === null || result === false) return createSettingsError(payload, "SETTINGS_UPDATE_FAILED");
            return null;
        }

        function rollbackValue(snapshot, entry) {
            if (!isPlainObject(snapshot)) return undefined;
            if (Object.prototype.hasOwnProperty.call(snapshot, entry.key)) return snapshot[entry.key];
            const aliasKey = entry.expandedKeys.find((key) => Object.prototype.hasOwnProperty.call(snapshot, key));
            return aliasKey ? snapshot[aliasKey] : undefined;
        }

        function isCurrent(entry) {
            return latestEntries.get(entry.key) === entry;
        }

        function finishEntry(entry) {
            if (!isCurrent(entry)) return;
            latestEntries.delete(entry.key);
            notifyPending(entry.key, false);
        }

        function settleEntry(entry, succeeded, value) {
            if (entry.settled) return;
            entry.settled = true;
            const callers = entry.callers.splice(0);
            callers.forEach(({ resolve, reject }) => {
                if (succeeded) resolve(value);
                else reject(value);
            });
        }

        function updateField(key, value) {
            let entry = pending.get(key);
            if (!entry) {
                entry = { key, value: undefined, expandedKeys: [], callers: [], settled: false, sequence: ++sequence };
                latestEntries.set(key, entry);
                notifyPending(key, true);
            }
            entry.value = normalizeValue(key, value);
            entry.expandedKeys = Object.keys(expand(key, entry.value));
            pending.set(key, entry);
            const result = new Promise((resolve, reject) => {
                entry.callers.push({ resolve, reject });
            });
            scheduleDrain();
            notifyStatus("Saving…", false);
            return result;
        }

        function takePendingBatch() {
            clearDebounceTimer();
            const entries = Array.from(pending.values());
            pending.clear();
            return entries;
        }

        async function commitBatch(entries) {
            const changes = Object.assign({}, ...entries.map((entry) => expand(entry.key, entry.value)));
            const keys = Object.keys(changes);
            let snapshot = {};
            let result;
            let transportError = null;
            try {
                const readResult = await read(keys);
                snapshot = isPlainObject(readResult) ? readResult : {};
                result = await sendUpdate(changes);
            } catch (error) {
                transportError = createSettingsError(error, "SETTINGS_UPDATE_FAILED");
            }

            const failures = [];
            entries.forEach((entry) => {
                const failure = transportError || failureForEntry(result, entry);
                if (failure) {
                    if (isCurrent(entry)) notifyRollback(entry.key, rollbackValue(snapshot, entry));
                    settleEntry(entry, false, failure);
                    failures.push({ key: entry.key, error: failure });
                } else {
                    if (isCurrent(entry)) notifySaved(entry.key, entry.value);
                    settleEntry(entry, true, result);
                }
                finishEntry(entry);
            });
            if (failures.length) notifyStatus("Failed — changes reverted.", true);
            else notifyStatus("Saved.", false);
            return failures;
        }

        async function drainLoop() {
            const failures = [];
            while (pending.size) {
                const entries = takePendingBatch();
                failures.push(...await commitBatch(entries));
            }
            if (failures.length) throw aggregateSettingsErrors(failures);
        }

        function drain() {
            if (activeDrain) return activeDrain;
            const run = drainLoop();
            const tracked = run.finally(() => {
                if (activeDrain === tracked) activeDrain = null;
                if (pending.size && debounceTimer === null) scheduleDrain();
            });
            activeDrain = tracked;
            return tracked;
        }

        function enqueue(operation) {
            const run = operationTail.then(operation, operation);
            operationTail = run.catch(() => {});
            return run;
        }

        function flush() {
            if (activeDrain) return activeDrain;
            return enqueue(() => drain());
        }

        function transaction(changes, options = {}) {
            const config = isPlainObject(options) ? options : {};
            return enqueue(async () => {
                await drain();
                const current = typeof config.read === "function" ? await config.read() : undefined;
                const rawNext = typeof changes === "function" ? await changes(clone(current)) : changes;
                const next = isPlainObject(rawNext)
                    ? Object.fromEntries(Object.entries(rawNext).map(([key, value]) => [key, normalizeValue(key, value)]))
                    : {};
                if (typeof config.validate === "function") {
                    const validation = await config.validate(next, clone(current));
                    if (validation === false || validation?.valid === false) throw new Error(validation?.message || "Settings validation failed.");
                }
                if (!Object.keys(next).length) return {};
                const expanded = Object.assign({}, ...Object.keys(next).map((key) => expand(key, next[key])));
                const keys = Object.keys(next);
                const token = { transaction: true, sequence: ++sequence };
                keys.forEach((key) => { latestEntries.set(key, token); notifyPending(key, true); });

                let result;
                let operationError = null;
                let failures = [];
                try {
                    result = await sendUpdate(expanded);
                    failures = keys.map((key) => ({ key, entry: { key, value: next[key], expandedKeys: Object.keys(expand(key, next[key])) } }))
                        .map(({ key, entry }) => ({ key, entry, error: failureForEntry(result, entry) }))
                        .filter(({ error }) => error);
                } catch (error) {
                    const failure = createSettingsError(error, "SETTINGS_UPDATE_FAILED");
                    failures = keys.map((key) => ({ key, entry: { key, value: next[key], expandedKeys: Object.keys(expand(key, next[key])) }, error: failure }));
                    operationError = aggregateSettingsErrors(failures);
                }

                keys.forEach((key) => {
                    const entry = { key, value: next[key], expandedKeys: Object.keys(expand(key, next[key])) };
                    const failure = failures.find((item) => item.key === key)?.error || null;
                    if (failure) {
                        if (latestEntries.get(key) === token) notifyRollback(key, rollbackValue(current, entry));
                    } else if (latestEntries.get(key) === token) {
                        notifySaved(key, next[key]);
                    }
                    if (latestEntries.get(key) === token) {
                        latestEntries.delete(key);
                        notifyPending(key, false);
                    }
                });
                if (failures.length) {
                    if (!operationError) operationError = aggregateSettingsErrors(failures);
                    notifyStatus("Failed — no changes applied.", true);
                } else {
                    notifyStatus("Saved.", false);
                }

                let trailingError = null;
                try { await drain(); } catch (error) { trailingError = error; }
                if (operationError) throw operationError;
                if (trailingError) throw trailingError;
                return result;
            });
        }

        function reset(keys, options = {}) {
            const config = isPlainObject(options) ? options : {};
            return enqueue(async () => {
                await drain();
                if (typeof sendReset !== "function") throw new Error("SETTINGS_RESET_UNAVAILABLE");
                const list = Array.from(new Set((Array.isArray(keys) ? keys : [keys]).filter((key) => typeof key === "string")));
                if (!list.length) return {};
                const current = typeof config.read === "function" ? await config.read() : await read(list);
                const token = { reset: true, sequence: ++sequence };
                list.forEach((key) => { latestEntries.set(key, token); notifyPending(key, true); });
                let result;
                let operationError = null;
                let failures = [];
                try {
                    result = await sendReset(list);
                    failures = list.map((key) => ({ key, entry: { key, expandedKeys: [key] }, error: failureForEntry(result, { key, expandedKeys: [key] }) })).filter(({ error }) => error);
                } catch (error) {
                    const failure = createSettingsError(error, "SETTINGS_RESET_FAILED");
                    failures = list.map((key) => ({ key, entry: { key, expandedKeys: [key] }, error: failure }));
                    operationError = aggregateSettingsErrors(failures);
                }
                list.forEach((key) => {
                    const failure = failures.find((item) => item.key === key)?.error || null;
                    if (failure) {
                        if (latestEntries.get(key) === token) notifyRollback(key, rollbackValue(current, { key, expandedKeys: [key] }));
                    } else if (latestEntries.get(key) === token) {
                        notifySaved(key, undefined);
                    }
                    if (latestEntries.get(key) === token) {
                        latestEntries.delete(key);
                        notifyPending(key, false);
                    }
                });
                if (failures.length) {
                    if (!operationError) operationError = aggregateSettingsErrors(failures);
                    notifyStatus("Failed — settings were not fully reset.", true);
                } else {
                    notifyStatus("Saved.", false);
                }
                let trailingError = null;
                try { await drain(); } catch (error) { trailingError = error; }
                if (operationError) throw operationError;
                if (trailingError) throw trailingError;
                return result;
            });
        }

        return Object.freeze({ updateField, flush, transaction, reset });
    }

    const FORBIDDEN_IMPORT_KEY = /^(?:__proto__|prototype|constructor)$/i;
    const SECRET_IMPORT_KEY = /(?:password|passphrase|secret|token|csrf|cookie|authorization|credential|private[_-]?key|api[_-]?key|client[_-]?secret)/i;

    function isSafeImportKey(key) {
        return typeof key === "string" && !FORBIDDEN_IMPORT_KEY.test(key) && !SECRET_IMPORT_KEY.test(key);
    }

    function isSafeImportValue(value, depth = 0) {
        if (depth > 12 || value === undefined || typeof value === "function" || typeof value === "symbol") return false;
        if (value === null || typeof value === "string" || typeof value === "boolean") return true;
        if (typeof value === "number") return Number.isFinite(value);
        if (Array.isArray(value)) return value.every((item) => isSafeImportValue(item, depth + 1));
        if (!isPlainObject(value)) return false;
        return Object.entries(value).every(([key, item]) => isSafeImportKey(key) && isSafeImportValue(item, depth + 1));
    }

    function validateCardColors(value) {
        return Array.isArray(value) && value.length <= 256 && value.every((color) => typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color));
    }

    function validateImportValue(key, value) {
        if (!isSafeImportValue(value)) return false;
        if (THEME_BOOLEAN_KEYS.has(key)) return typeof value === "boolean";
        if (THEME_NUMBER_KEYS.has(key)) return typeof value === "number" && Number.isFinite(value);
        if (THEME_STRING_KEYS.has(key)) return typeof value === "string";
        if (THEME_ARRAY_KEYS.has(key)) return Array.isArray(value);
        if (THEME_OBJECT_KEYS.has(key)) return isPlainObject(value);
        return true;
    }

    function validateImportData(settingsChanges, cardColors, allowedKeys = THEME_ALLOWED_SETTING_KEYS) {
        if (!isPlainObject(settingsChanges) || !isSafeImportValue(settingsChanges)) return false;
        const allowed = allowedKeys instanceof Set ? allowedKeys : new Set(Array.isArray(allowedKeys) ? allowedKeys : THEME_ALLOWED_SETTING_KEYS);
        if (Object.keys(settingsChanges).some((key) => !allowed.has(key) || !validateImportValue(key, settingsChanges[key]))) return false;
        return cardColors === undefined || validateCardColors(cardColors);
    }

    function hasFailedOperation(result, fallbackCode) {
        const error = writeResultError(result, fallbackCode);
        return error;
    }

    function validateQueuedSnapshot(snapshot) {
        if (snapshot === undefined || snapshot === null) return { present: false };
        if (!isPlainObject(snapshot) || typeof snapshot.present !== "boolean") throw new Error("THEME_QUEUED_COLORS_SNAPSHOT_FAILED");
        if (snapshot.present && !validateCardColors(snapshot.value)) throw new Error("THEME_QUEUED_COLORS_SNAPSHOT_FAILED");
        return clone(snapshot);
    }

    function sanitizeTransactionError(error, fallbackCode = "THEME_TRANSACTION_FAILED") {
        const rawCode = typeof error?.code === "string" ? error.code : typeof error?.message === "string" ? error.message : fallbackCode;
        const code = rawCode.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 80) || fallbackCode;
        const rawMessage = typeof error?.message === "string" ? error.message : "Theme transaction failed.";
        const message = /(?:password|passphrase|secret|token|csrf|cookie|authorization|credential|private[_-]?key|api[_-]?key)/i.test(rawMessage)
            ? "Theme transaction failed; sensitive details were redacted."
            : rawMessage.slice(0, 200);
        return { code, message };
    }

    async function runThemeImportTransaction({ settingsChanges, cardColors, hasCanvas, readSettings, writeSettings, restoreSettings, readCanvasColors, writeCanvasColors, readQueuedColors = async () => undefined, queueCanvasColors = async () => {}, restoreQueuedColors = async () => {}, allowedSettingsKeys = THEME_ALLOWED_SETTING_KEYS } = {}) {
        if (!validateImportData(settingsChanges, cardColors, allowedSettingsKeys) || typeof readSettings !== "function" || typeof writeSettings !== "function" || typeof restoreSettings !== "function") {
            throw new Error("THEME_TRANSACTION_INVALID");
        }
        const settingsSnapshot = await readSettings();
        if (!isPlainObject(settingsSnapshot) || !isSafeImportValue(settingsSnapshot)) throw new Error("THEME_SETTINGS_SNAPSHOT_FAILED");
        const hasColorChange = cardColors !== undefined;
        let canvasSnapshot = null;
        let queuedSnapshot = { present: false };

        if (hasColorChange && hasCanvas) {
            if (typeof readCanvasColors !== "function" || typeof writeCanvasColors !== "function") throw new Error("CANVAS_COLORS_UNAVAILABLE");
            canvasSnapshot = await readCanvasColors();
            if (!validateCardColors(canvasSnapshot)) throw new Error("CANVAS_COLORS_SNAPSHOT_FAILED");
        } else if (hasColorChange) {
            queuedSnapshot = validateQueuedSnapshot(await readQueuedColors());
        }

        try {
            const settingsResult = await writeSettings(clone(settingsChanges));
            const settingsError = hasFailedOperation(settingsResult, "THEME_SETTINGS_WRITE_FAILED");
            if (settingsError) throw settingsError;
            if (hasColorChange && hasCanvas) {
                const colorResult = await writeCanvasColors(clone(cardColors));
                const colorError = hasFailedOperation(colorResult, "CANVAS_COLORS_WRITE_FAILED");
                if (colorError) throw colorError;
            } else if (hasColorChange) {
                const queueResult = await queueCanvasColors(clone(cardColors));
                const queueError = hasFailedOperation(queueResult, "CANVAS_COLORS_QUEUE_FAILED");
                if (queueError) throw queueError;
            }
            return {
                settings: clone(settingsChanges),
                canvasColorsApplied: hasColorChange && Boolean(hasCanvas),
                canvasColorsQueued: hasColorChange && !hasCanvas,
                canvasColorsPending: hasColorChange && !hasCanvas,
                canvasColorsNotApplied: hasColorChange && !hasCanvas
            };
        } catch (error) {
            const compensation = [Promise.resolve().then(() => restoreSettings(clone(settingsSnapshot)))];
            if (hasColorChange && hasCanvas) compensation.push(Promise.resolve().then(() => writeCanvasColors(clone(canvasSnapshot))));
            else if (hasColorChange) compensation.push(Promise.resolve().then(() => restoreQueuedColors(clone(queuedSnapshot))));
            const results = await Promise.allSettled(compensation);
            if (results.some((result) => result.status === "rejected" || hasFailedOperation(result.value, "THEME_COMPENSATION_FAILED"))) {
                const failure = new Error("THEME_TRANSACTION_COMPENSATION_FAILED");
                failure.code = "THEME_TRANSACTION_COMPENSATION_FAILED";
                failure.state = {
                    ok: false,
                    code: failure.code,
                    primary: sanitizeTransactionError(error),
                    compensation: results.map((result) => result.status === "fulfilled" ? { ok: true } : { ok: false, error: sanitizeTransactionError(result.reason, "THEME_COMPENSATION_FAILED") })
                };
                throw failure;
            }
            throw error;
        }
    }

    function handlePopoverEscape(event, close, trigger) {
        if (event?.key !== "Escape" || typeof close !== "function" || !close()) return false;
        event.preventDefault?.();
        trigger?.focus?.();
        return true;
    }

    function createController({ document, window, chromeApi, contract, defaults = {}, now = () => Date.now(), settingsStore } = {}) {
        const doc = document || root?.document;
        const win = window || root;
        const chromeService = chromeApi || root?.chrome;
        const messageContract = contract || root?.APStudyCanvasPlatform?.Contract;
        const state = {
            identity: { state: "unavailable", profile: null },
            canvas: null,
            canvasAccounts: [],
            nestLinkedAccounts: [],
            category: "overview",
            consent: null,
            calendars: null,
            identityGeneration: 0,
            identityUserKey: "",
            sidebarOrder: clone(DEFAULT_SIDEBAR_PAGE_ORDER),
            persistedSidebarOrder: clone(DEFAULT_SIDEBAR_PAGE_ORDER),
            sidebarReorderGeneration: 0,
            initialized: false
        };

        let sidebarPersistTail = Promise.resolve();

        const q = (selector) => doc?.querySelector?.(selector) || null;
        const qa = (selector) => Array.from(doc?.querySelectorAll?.(selector) || []);
        const text = (selector, value) => { const node = q(selector); if (node) node.textContent = String(value ?? ""); return node; };
        const hidden = (selector, value) => { const node = q(selector); if (node) node.hidden = Boolean(value); return node; };

        function setStatus(message, error = false) {
            ["#home-save-status", "#workspace-save-status", "#popup-settings-status"].forEach((selector) => {
                const node = q(selector);
                if (!node) return;
                node.textContent = message;
                node.classList?.toggle("is-error", Boolean(error));
            });
        }

        function setError(message) {
            const node = q("#workspace-error-area");
            if (!node) return;
            node.textContent = message || "";
            node.hidden = !message;
        }

        function request(type, payload = {}) {
            if (!chromeService?.runtime?.sendMessage) return Promise.reject(new Error("RUNTIME_MESSAGE_UNAVAILABLE"));
            const message = messageContract?.createEnvelope ? messageContract.createEnvelope(type, payload) : { version: 1, request_id: `popup-${now()}`, type, payload };
            return Promise.resolve(chromeService.runtime.sendMessage(message)).then((response) => response?.payload || response || {});
        }

        function storageGet(area, keys) { return callStorage(chromeService, area, "get", keys); }
        function storageSet(area, value) { return callStorage(chromeService, area, "set", value); }

        function renderProfile() {
            const canvasProfile = state.canvas?.profile || state.canvas?.response?.profile || null;
            const profile = resolveProfile(state.identity.state === "authenticated" ? state.identity.profile : null, canvasProfile);
            const avatar = q("#profile-button .profile-avatar");
            if (avatar) {
                avatar.textContent = profile.avatarUrl ? "" : profile.initials;
                avatar.dataset.source = profile.source;
                if (profile.avatarUrl) avatar.style.backgroundImage = `url("${profile.avatarUrl.replace(/"/g, "%22")}")`;
                else avatar.style.backgroundImage = "";
                avatar.setAttribute("aria-label", profile.name ? `${profile.name} profile` : "Profile");
            }
            text("#profile-display-name", profile.name || "Canvas workspace");
            text("#profile-display-source", profile.source === "nest" ? "Nest account" : profile.source === "canvas" ? "Canvas context" : "Local fallback");
            const status = state.identity.state;
            text("#nest-account-status", status === "authenticated" ? "Connected" : status === "signed_out" ? "Signed out" : status === "expired" ? "Session expired" : "Unavailable");
            text("#nest-account-status-inline", status === "authenticated" ? "Nest is connected." : status === "signed_out" ? "Nest is signed out." : status === "expired" ? "Nest session expired." : "Nest status is unavailable.");
            const dot = q("#profile-button .profile-status-dot");
            if (dot) dot.dataset.state = status;
            renderCanvasAccounts();
        }

        function renderCanvasAccounts() {
            const lists = [q("#canvas-account-list"), q("#workspace-canvas-account-list")].filter(Boolean);
            if (!lists.length || !doc?.createElement) return;
            const localAccounts = state.canvasAccounts.length ? state.canvasAccounts : (state.canvas?.accounts || []);
            const accounts = localAccounts.concat(state.identity.state === "authenticated" ? state.nestLinkedAccounts : []);
            const pending = state.canvas?.pendingAccounts || [];
            lists.forEach((list) => {
                list.replaceChildren();
                if (!accounts.length && !pending.length) {
                    const empty = doc.createElement("p");
                    empty.className = "profile-empty";
                    empty.textContent = "No linked Canvas accounts in this browser.";
                    list.appendChild(empty);
                    return;
                }
                accounts.forEach((account) => {
                    const card = doc.createElement("div");
                    card.className = "profile-account-card";
                    card.dataset.state = "linked";
                    card.textContent = `${cleanName(account.displayName || account.name) || "Canvas account"} · ${String(account.origin || "").replace(/^https:\/\//, "")}`;
                    list.appendChild(card);
                });
                pending.forEach((account) => {
                    const card = doc.createElement("div");
                    card.className = "profile-account-card is-pending";
                    card.dataset.state = "pending";
                    card.textContent = `${cleanName(account.displayName || account.name) || "Canvas account"} · pending verification`;
                    list.appendChild(card);
                });
            });
        }

        function renderIdentity() {
            const stateLabel = state.identity.state;
            const badge = q("#home-nest-status");
            if (badge) {
                badge.textContent = stateLabel === "authenticated" ? "Nest connected" : stateLabel === "signed_out" ? "Connect Nest" : stateLabel === "expired" ? "Nest session expired" : "Nest unavailable";
                badge.dataset.identityState = stateLabel;
            }
            const onboarding = q("#nest-onboarding");
            if (onboarding && state.identity.state === "authenticated") onboarding.hidden = true;
            const cta = q("#nest-connect-cta");
            if (cta) cta.hidden = state.identity.state === "authenticated";
            const nestEnabled = state.identity.state === "authenticated";
            [q("#nest-consent-enabled"), q("#nest-consent-refresh")].filter(Boolean).forEach((control) => {
                control.disabled = !nestEnabled;
                control.setAttribute?.("aria-disabled", String(!nestEnabled));
            });
            qa("#calendar-routing-controls input, #calendar-routing-controls select, #calendar-routing-controls button").forEach((control) => {
                control.disabled = !nestEnabled;
            });
            renderProfile();
            renderCalendarStatus();
        }

        function clearNestDerivedState(identity) {
            Object.assign(state, {
                identity: { ...identity, profile: null, linkedAccounts: [] },
                consent: null,
                calendars: null,
                nestLinkedAccounts: [],
                identityUserKey: ""
            });
            const consentControl = q("#nest-consent-enabled");
            if (consentControl) consentControl.checked = false;
            text("#nest-consent-status", "Connect Nest to manage calendar consent.");
        }

        async function refreshIdentity() {
            const generation = ++state.identityGeneration;
            state.identityUserKey = "";
            const checking = { state: "unavailable", profile: null, linkedAccounts: [] };
            clearNestDerivedState(checking);
            renderIdentity();
            let result;
            try { result = await request("NEST_IDENTITY_GET"); }
            catch (error) { result = { ok: false, code: error.message }; }
            if (generation !== state.identityGeneration) return state.identity;
            const identity = normalizeIdentityResponse(result);
            if (identity.state === "authenticated") {
                Object.assign(state, {
                    identity,
                    nestLinkedAccounts: Array.isArray(identity.linkedAccounts) ? identity.linkedAccounts.map(clone) : [],
                    identityUserKey: identityKey(identity)
                });
            } else {
                identity.profile = null;
                clearNestDerivedState(identity);
            }
            renderIdentity();
            if (state.identity.state === "authenticated") {
                const userKey = state.identityUserKey;
                await Promise.all([loadConsent(generation, userKey), loadCalendars(generation, userKey)]);
            }
            return state.identity;
        }

        async function dismissOnboarding() {
            try { await storageSet("local", { [ONBOARDING_KEY]: true }); } catch (error) {}
            hidden("#nest-onboarding", true);
        }

        function openNestLogin() {
            if (chromeService?.tabs?.create) return Promise.resolve(chromeService.tabs.create({ url: FULLSCREEN_URL }));
            if (win?.open) { win.open(FULLSCREEN_URL, "_blank", "noopener"); return Promise.resolve(); }
            return Promise.reject(new Error("NEST_LOGIN_UNAVAILABLE"));
        }

        async function setupOnboarding() {
            let dismissed = false;
            try { dismissed = (await storageGet("local", ONBOARDING_KEY))[ONBOARDING_KEY] === true; } catch (error) {}
            if (!dismissed && state.identity.state !== "authenticated") hidden("#nest-onboarding", false);
        }

        function updateCategory(category, focus = false) {
            state.category = normalizedCategory(category);
            qa("[data-workspace-target]").forEach((node) => {
                const active = node.dataset.workspaceTarget === state.category;
                node.classList?.toggle("is-active", active);
                if (active) node.setAttribute?.("aria-current", "page");
                else node.removeAttribute?.("aria-current");
            });
            qa(".workspace-section[data-category]").forEach((section) => { section.hidden = section.dataset.category !== state.category; });
            const select = q("#workspace-category-select");
            if (select) {
                select.value = state.category;
                Array.from(select.options || []).forEach((option) => { option.selected = option.value === state.category; });
            }
            text("#workspace-category-count-value", `${CATEGORIES.length} categories`);
            if (focus) q(`#workspace-section-${state.category}`)?.focus?.();
            win?.APStudyCanvasWorkspace?.syncCategoryFromLegacy?.(state.category);
            return state.category;
        }

        function bindCategories() {
            qa("[data-workspace-target]").forEach((node) => node.addEventListener?.("click", () => {
                updateCategory(node.dataset.workspaceTarget);
                win?.APStudyCanvasWorkspace?.activateCategory?.(state.category, false);
            }));
            q("#workspace-category-select")?.addEventListener?.("change", (event) => {
                updateCategory(event.target.value);
                win?.APStudyCanvasWorkspace?.activateCategory?.(state.category, false);
            });
            qa("[data-home-target]").forEach((node) => node.addEventListener?.("click", () => updateCategory(node.dataset.homeTarget)));
        }

        function renderCanvasAvailability() {
            const hasCanvas = Number.isInteger(state.canvas?.sourceTabId) || state.canvas?.state === "connected" || state.canvas?.response?.state === "connected";
            qa("[data-canvas-load-note]").forEach((node) => {
                node.textContent = hasCanvas ? "Changes save now and appear after the next Canvas load when the setting is supported." : "No Canvas tab is open — changes save now and apply next Canvas load.";
                node.hidden = false;
            });
            const notice = q("#no-canvas-notice");
            if (notice) {
                notice.textContent = hasCanvas ? "Changes save now and appear after the next Canvas load when the setting is supported." : "No Canvas tab is open — changes save now and apply next Canvas load.";
                notice.hidden = hasCanvas;
            }
        }

        function setControlValue(control, value) {
            if (!control) return;
            if (control.type === "checkbox" || control.type === "radio") control.checked = value === true;
            else if (value !== undefined && value !== null) control.value = value;
        }

        async function loadPopupSettings() {
            const controls = qa("[data-popup-setting]");
            if (!controls.length) return;
            const keys = Array.from(new Set(controls.map((control) => control.dataset.popupSetting)));
            let values = {};
            try { values = await storageGet("sync", keys); } catch (error) { setStatus("Settings unavailable.", true); return; }
            controls.forEach((control) => {
                const key = control.dataset.popupSetting;
                const value = values[key] !== undefined ? values[key] : defaults[key];
                setControlValue(control, value);
                const output = control.dataset.output ? q(`#${control.dataset.output}`) : null;
                if (output) output.textContent = String(value);
            });
        }

        function bindPopupSettings() {
            if (!settingsStore) return;
            qa("[data-popup-setting]").forEach((control) => {
                control.addEventListener?.("change", () => {
                    const key = control.dataset.popupSetting;
                    const rawValue = control.type === "checkbox" ? control.checked : control.value;
                    const value = control.dataset.valueType === "number" ? Number(rawValue) : rawValue;
                    const output = control.dataset.output ? q(`#${control.dataset.output}`) : null;
                    if (output) output.textContent = String(value);
                    settingsStore.updateField(key, value).then(() => setStatus("Saved.")).catch(() => setStatus("Failed — changes reverted.", true));
                });
            });
        }

        async function persistSidebarOrder(next, focusPage = null, options = {}) {
            if (!settingsStore) throw new Error("SETTINGS_STORE_UNAVAILABLE");
            const callbacks = isPlainObject(options) ? options : {};
            const canonical = normalizeSidebarOrder(next);
            const operationId = ++state.sidebarReorderGeneration;
            state.sidebarOrder = canonical.slice();
            renderSidebarOrder(canonical);
            if (focusPage) q(`#sidebar-page-list [data-sidebar-page="${focusPage}"]`)?.focus?.();
            const operation = sidebarPersistTail.then(async () => {
                try {
                    await settingsStore.updateField("sidebar_page_order", canonical);
                    const current = operationId === state.sidebarReorderGeneration;
                    state.persistedSidebarOrder = canonical.slice();
                    if (current) {
                        state.sidebarOrder = canonical.slice();
                        renderSidebarOrder(canonical);
                        if (focusPage) q(`#sidebar-page-list [data-sidebar-page="${focusPage}"]`)?.focus?.();
                        setStatus("Saved.");
                    }
                    const result = { ok: true, order: canonical.slice(), operationId, current };
                    callbacks.onResult?.(result);
                    return result;
                } catch (error) {
                    const current = operationId === state.sidebarReorderGeneration;
                    const restoredOrder = current ? state.persistedSidebarOrder.slice() : state.sidebarOrder.slice();
                    if (current) {
                        state.sidebarOrder = restoredOrder.slice();
                        renderSidebarOrder(restoredOrder);
                        if (focusPage) q(`#sidebar-page-list [data-sidebar-page="${focusPage}"]`)?.focus?.();
                        setStatus("Failed — changes reverted.", true);
                    }
                    const result = { ok: false, order: restoredOrder.slice(), restoredOrder: restoredOrder.slice(), error, operationId, current };
                    if (current) callbacks.onRollback?.(restoredOrder.slice(), error);
                    callbacks.onResult?.(result);
                    const reported = error instanceof Error ? error : new Error("SIDEBAR_ORDER_SAVE_FAILED");
                    reported.restoredOrder = restoredOrder.slice();
                    reported.result = result;
                    reported.operationId = operationId;
                    reported.current = current;
                    throw reported;
                }
            });
            sidebarPersistTail = operation.catch(() => {});
            return operation;
        }

        function renderSidebarOrder(order) {
            const list = q("#sidebar-page-list");
            if (!list || !doc?.createElement) return;
            const visibility = state.sidebarVisibility || DEFAULT_SIDEBAR_VISIBILITY;
            list.replaceChildren();
            const canonical = normalizeSidebarOrder(order);
            state.sidebarOrder = canonical.slice();
            canonical.forEach((page, index) => {
                const row = doc.createElement("li");
                row.dataset.sidebarPage = page;
                row.className = "sidebar-page-row";
                row.tabIndex = 0;
                row.innerHTML = `<span class="drag-handle" aria-hidden="true">⠿</span><span class="sidebar-page-name"></span><label class="sidebar-visibility"><input type="checkbox" data-sidebar-visibility="${page}"><span>Visible</span></label><button type="button" class="workspace-action" data-sidebar-move="up" aria-label="Move ${page} up">↑</button><button type="button" class="workspace-action" data-sidebar-move="down" aria-label="Move ${page} down">↓</button>`;
                row.querySelector(".sidebar-page-name").textContent = String(page).replace(/-/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
                const checkbox = row.querySelector("[data-sidebar-visibility]");
                checkbox.checked = visibility[page] !== false;
                checkbox.addEventListener("change", () => {
                    const nextVisibility = Object.assign({}, visibility, { [page]: checkbox.checked });
                    state.sidebarVisibility = nextVisibility;
                    settingsStore?.updateField("sidebar_page_visibility", nextVisibility).then(() => setStatus("Saved.")).catch(() => setStatus("Failed — changes reverted.", true));
                });
                row.querySelectorAll("[data-sidebar-move]").forEach((button) => button.addEventListener("click", () => {
                    const next = reorderItems(state.sidebarOrder, index, button.dataset.sidebarMove);
                    persistSidebarOrder(next, page, { onRollback: (restored) => renderSidebarOrder(restored) }).catch(() => {});
                }));
                row.addEventListener("keydown", (event) => {
                    if ((event.key !== "ArrowUp" && event.key !== "ArrowDown") || !event.altKey) return;
                    event.preventDefault();
                    const direction = event.key === "ArrowUp" ? "up" : "down";
                    const next = reorderItems(state.sidebarOrder, index, direction);
                    persistSidebarOrder(next, page, { onRollback: (restored) => renderSidebarOrder(restored) }).catch(() => {});
                });
                list.appendChild(row);
            });
        }

        async function loadSidebarSettings() {
            try {
                const values = await storageGet("sync", ["sidebar_page_order", "sidebar_page_visibility"]);
                state.sidebarVisibility = isPlainObject(values.sidebar_page_visibility) ? values.sidebar_page_visibility : clone(DEFAULT_SIDEBAR_VISIBILITY);
                const canonical = normalizeSidebarOrder(values.sidebar_page_order);
                state.sidebarOrder = canonical.slice();
                state.persistedSidebarOrder = canonical.slice();
                renderSidebarOrder(canonical);
                if (!sameArray(values.sidebar_page_order, canonical) && settingsStore) await settingsStore.transaction({ sidebar_page_order: canonical });
            } catch (error) {
                state.sidebarOrder = clone(DEFAULT_SIDEBAR_PAGE_ORDER);
                state.persistedSidebarOrder = clone(DEFAULT_SIDEBAR_PAGE_ORDER);
                renderSidebarOrder(DEFAULT_SIDEBAR_PAGE_ORDER);
                setStatus("Failed — sidebar order could not be normalized.", true);
            }
        }

        async function loadAccounts() {
            try {
                const local = await storageGet("local", ["platform.accountMetadata"]);
                const accounts = local["platform.accountMetadata"]?.accounts;
                state.canvasAccounts = Array.isArray(accounts) ? accounts.filter((account) => isPlainObject(account)) : [];
            } catch (error) { state.canvasAccounts = []; }
            renderCanvasAccounts();
        }

        function isCurrentIdentity(generation, userKey) {
            return generation === state.identityGeneration && state.identity.state === "authenticated" && state.identityUserKey === userKey;
        }

        async function loadConsent(generation = state.identityGeneration, userKey = identityKey(state.identity)) {
            if (!isCurrentIdentity(generation, userKey)) return null;
            let consent;
            try { consent = await request("NEST_CONSENT_GET"); }
            catch (error) { consent = { ok: false, code: error.message }; }
            if (!isCurrentIdentity(generation, userKey)) return null;
            state.consent = consent;
            const enabled = state.consent?.consent?.granted ?? state.consent?.granted ?? state.consent?.enabled;
            const control = q("#nest-consent-enabled");
            if (control && typeof enabled === "boolean") control.checked = enabled;
            text("#nest-consent-status", state.consent?.ok === false ? "Consent status unavailable." : enabled ? "Consent granted." : "Consent not granted.");
            return state.consent;
        }

        async function setConsent(value) {
            const generation = state.identityGeneration;
            const userKey = identityKey(state.identity);
            if (!isCurrentIdentity(generation, userKey)) {
                text("#nest-consent-status", "Connect Nest to manage calendar consent.");
                throw new Error("NEST_AUTHENTICATION_REQUIRED");
            }
            try {
                const consent = await request("NEST_CONSENT_SET", { granted: Boolean(value) });
                if (!isCurrentIdentity(generation, userKey)) throw new Error("STALE_IDENTITY_COMPLETION");
                if (consent?.ok === false) throw new Error(consent.code || "NEST_CONSENT_SET_FAILED");
                state.consent = consent;
                text("#nest-consent-status", state.consent?.ok === false ? "Consent could not be saved." : "Consent saved.");
                return state.consent;
            } catch (error) {
                if (isCurrentIdentity(generation, userKey)) {
                    const enabled = state.consent?.consent?.granted ?? state.consent?.granted ?? state.consent?.enabled;
                    const control = q("#nest-consent-enabled");
                    if (control && typeof enabled === "boolean") control.checked = enabled;
                    text("#nest-consent-status", "Consent could not be saved.");
                }
                throw error;
            }
        }

        function renderCalendarStatus() {
            const status = q("#calendar-capability-status");
            if (!status) return;
            if (state.identity.state !== "authenticated") status.textContent = "Connect Nest to check calendar sync capability.";
            else if (!state.calendars) status.textContent = "Available after calendar sync is enabled.";
            else if (state.calendars.ok === false) status.textContent = "Available after calendar sync is enabled.";
            else status.textContent = "Calendar sync is enabled.";
            const selectors = q("#calendar-routing-controls");
            if (selectors) {
                const available = state.identity.state === "authenticated" && state.calendars?.ok && Array.isArray(state.calendars.calendars || state.calendars.body?.calendars);
                selectors.hidden = !available;
                selectors.inert = !available;
            }
        }

        async function loadCalendars(generation = state.identityGeneration, userKey = identityKey(state.identity)) {
            if (!isCurrentIdentity(generation, userKey)) {
                state.calendars = null;
                renderCalendarStatus();
                return null;
            }
            let flags = {};
            try { flags = (await storageGet("local", ["platform.flags"]))["platform.flags"] || {}; } catch (error) {}
            if (!isCurrentIdentity(generation, userKey)) return null;
            if (flags.projection !== true) { state.calendars = null; renderCalendarStatus(); return; }
            let calendars;
            try { calendars = await request("NEST_CALENDARS_GET"); }
            catch (error) { calendars = { ok: false, code: error.message }; }
            if (!isCurrentIdentity(generation, userKey)) return null;
            state.calendars = calendars;
            renderCalendarStatus();
            return state.calendars;
        }

        async function openFullscreen() {
            const sourceTabId = normalizeSourceCanvasTabId(state.canvas?.sourceTabId);
            try {
                const result = await request("POPUP_FULLSCREEN_OPEN", { sourceCanvasTabId: sourceTabId, category: state.category });
                if (result?.ok === false || result?.payload?.ok === false) throw new Error(result.code || result.payload.code || "FULLSCREEN_OPEN_FAILED");
                text("#fullscreen-status", "Fullscreen workspace opened.");
                setError("");
                return result;
            } catch (error) {
                const message = "Fullscreen could not open. Your current settings remain available here.";
                text("#fullscreen-status", message);
                setError(message);
                throw error;
            }
        }

        async function exportSettings() {
            try {
                const keys = Object.keys(defaults);
                const values = await storageGet("sync", keys);
                const output = q("#popup-export-output");
                if (output) output.value = JSON.stringify(values, null, 2);
            } catch (error) { setStatus("Export failed.", true); }
        }

        async function importSettings() {
            const input = q("#popup-import-input");
            if (!input || !settingsStore) return;
            let parsed;
            try { parsed = JSON.parse(input.value); } catch (error) { setStatus("Invalid settings JSON. No changes were applied.", true); return; }
            if (!isPlainObject(parsed)) { setStatus("Invalid settings JSON. No changes were applied.", true); return; }
            const changes = Object.fromEntries(Object.entries(parsed).filter(([key]) => Object.prototype.hasOwnProperty.call(defaults, key)));
            if (Object.prototype.hasOwnProperty.call(changes, "sidebar_page_order")) changes.sidebar_page_order = normalizeSidebarOrder(changes.sidebar_page_order);
            if (!Object.keys(changes).length) { setStatus("Invalid settings JSON. No changes were applied.", true); return; }
            try { await settingsStore.transaction(changes); setStatus("Saved."); }
            catch (error) { setStatus("Failed — no changes applied.", true); }
        }

        async function resetSettings() {
            if (typeof win?.confirm === "function" && !win.confirm("Reset supported Canvas settings to defaults? User data stays intact.")) return;
            if (!settingsStore) return;
            const keys = root?.APStudyCanvasSchema?.knownResettableKeys || Object.keys(defaults);
            const changes = Object.fromEntries(keys.filter((key) => Object.prototype.hasOwnProperty.call(defaults, key)).map((key) => [key, clone(defaults[key])]));
            try { await settingsStore.transaction(changes); await loadPopupSettings(); setStatus("Saved."); }
            catch (error) { setStatus("Failed — no changes applied.", true); }
        }

        function bindActions() {
            q("#nest-sign-in")?.addEventListener?.("click", () => openNestLogin().catch(() => {}));
            q("#nest-connect-cta")?.addEventListener?.("click", () => openNestLogin().catch(() => {}));
            q("#nest-continue")?.addEventListener?.("click", () => dismissOnboarding());
            q("#profile-nest-login")?.addEventListener?.("click", () => openNestLogin().catch(() => {}));
            q("#nest-consent-enabled")?.addEventListener?.("change", (event) => setConsent(event.target.checked).catch(() => {}));
            q("#nest-consent-refresh")?.addEventListener?.("click", () => loadConsent().catch(() => {}));
            q("#calendar-nest-login")?.addEventListener?.("click", () => openNestLogin().catch(() => {}));
            q("#sidebar-reset-defaults")?.addEventListener?.("click", () => {
                if (!settingsStore) return;
                settingsStore.transaction({
                    better_sidebar: false,
                    sidebar_expanded_width: defaults.sidebar_expanded_width,
                    sidebar_collapsed_width: defaults.sidebar_collapsed_width,
                    sidebar_density: defaults.sidebar_density,
                    sidebar_icon_size: defaults.sidebar_icon_size,
                    sidebar_label_size: defaults.sidebar_label_size,
                    sidebar_logo_visible: defaults.sidebar_logo_visible,
                    sidebar_page_order: clone(DEFAULT_SIDEBAR_PAGE_ORDER),
                    sidebar_page_visibility: clone(DEFAULT_SIDEBAR_VISIBILITY),
                    sidebar_tooltips: defaults.sidebar_tooltips,
                    sidebar_accessibility_labels: defaults.sidebar_accessibility_labels,
                    dashboard_sidebar_expanded: defaults.dashboard_sidebar_expanded,
                    course_sidebar_expanded: defaults.course_sidebar_expanded
                }).then(() => {
                    state.sidebarVisibility = clone(DEFAULT_SIDEBAR_VISIBILITY);
                    renderSidebarOrder(DEFAULT_SIDEBAR_PAGE_ORDER);
                    loadPopupSettings();
                    setStatus("Saved.");
                }).catch(() => setStatus("Failed — no changes applied.", true));
            });
            q("#popup-export-settings")?.addEventListener?.("click", () => exportSettings());
            q("#popup-import-settings")?.addEventListener?.("click", () => importSettings());
            q("#popup-reset-settings")?.addEventListener?.("click", () => resetSettings());
            q("#compact-expand")?.addEventListener?.("click", (event) => {
                event.preventDefault();
                if (isWorkspaceRoute(win?.location?.search)) return;
                openFullscreen().catch(() => {});
            });
            const isWorkspace = isWorkspaceRoute(win?.location?.search);
            const fullscreen = q("#compact-expand");
            if (fullscreen) fullscreen.hidden = isWorkspace;
        }

        function flushPendingSettings() {
                if (!settingsStore?.flush) return Promise.resolve();
                return settingsStore.flush().catch((error) => {
                    setStatus("Failed — pending changes could not be saved.", true);
                    throw error;
                });
        }

    function bindLifecycle() {
            const flush = () => { flushPendingSettings().catch(() => {}); };
            win?.addEventListener?.("pagehide", flush);
            win?.addEventListener?.("beforeunload", flush);
            doc?.addEventListener?.("visibilitychange", () => { if (doc.visibilityState === "hidden") flush(); });
            win?.addEventListener?.("apstudycanvas-canvas-context", (event) => {
                const detail = isCanvasContextEventRecord(event?.detail) ? event.detail : null;
                const sourceTabId = normalizeSourceCanvasTabId(detail?.sourceTabId);
                state.canvas = detail ? { ...detail, sourceTabId } : null;
                renderProfile();
                renderCanvasAvailability();
            });
        }

        function setInitialMode() {
            const isWorkspace = isWorkspaceRoute(win?.location?.search);
            if (doc?.body) doc.body.dataset.mode = isWorkspace ? "workspace" : "home";
            updateCategory(new URLSearchParams(win?.location?.search || "").get("category") || "overview");
        }

        async function init() {
            if (state.initialized || !doc) return controller;
            state.initialized = true;
            setInitialMode();
            bindCategories();
            bindActions();
            bindPopupSettings();
            bindLifecycle();
            await Promise.all([setupOnboarding(), loadPopupSettings(), loadSidebarSettings(), loadAccounts(), refreshIdentity()]);
            renderCanvasAvailability();
            return controller;
        }

        const controller = {
            state,
            init,
            updateCategory,
            refreshIdentity,
            openNestLogin,
            openFullscreen,
            renderProfile,
            renderCanvasAvailability,
            dismissOnboarding,
            loadConsent,
            setConsent,
            loadCalendars,
            loadSidebarSettings,
            persistSidebarOrder,
            flush: flushPendingSettings
        };
        return controller;
    }

    return Object.freeze({
        CATEGORIES,
        CATEGORY_LABELS,
        DEFAULT_SIDEBAR_PAGE_ORDER,
        DEFAULT_SIDEBAR_VISIBILITY,
        ONBOARDING_KEY,
        FULLSCREEN_URL,
        isPlainObject,
        isHttpsAvatar,
        cleanName,
        initials,
        normalizeIdentityResponse,
        resolveProfile,
        reorderItems,
        normalizeSidebarOrder,
        normalizedCategory,
        createSettingsStore,
        validateCardColors,
        validateImportData,
        runThemeImportTransaction,
        handlePopoverEscape,
        createController
    });
}));
