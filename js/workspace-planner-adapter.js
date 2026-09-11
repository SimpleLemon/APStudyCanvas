(function (root, factory) {
    "use strict";
    const api = factory();
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasWorkspacePlannerAdapter = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const READ_FAMILY = "NEST_CALENDAR_RANGE_GET";
    const WRITE_FAMILIES = Object.freeze({
        create: "NEST_CALENDAR_EVENT_CREATE",
        update: "NEST_CALENDAR_EVENT_UPDATE",
        delete: "NEST_CALENDAR_EVENT_DELETE"
    });
    const VIEWS = new Set(["day", "week", "month"]);
    const READ_CAPABILITIES = ["calendar_integration", "calendar_read", "calendar_projection"];
    const WRITE_CAPABILITIES = ["calendar_two_way_writeback"];
    const READ_SCOPES = ["ongoing_read"];
    const WRITE_SCOPES = ["personal_events_write"];

    function clone(value) {
        if (value === undefined) return undefined;
        return JSON.parse(JSON.stringify(value));
    }

    function deepFreeze(value) {
        if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        Object.freeze(value);
        for (const item of Object.values(value)) deepFreeze(item);
        return value;
    }

    function cleanText(value, max = 512) {
        return typeof value === "string"
            ? value.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, max)
            : "";
    }

    function safeTimeZone(value) {
        const candidate = cleanText(value, 80) || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
        try {
            new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(new Date());
            return candidate;
        } catch (error) {
            return "UTC";
        }
    }

    function zonedParts(value, timeZone) {
        const date = value instanceof Date ? value : new Date(value);
        if (!Number.isFinite(date.getTime())) throw new Error("PLANNER_DATE_INVALID");
        const fields = {};
        const formatter = new Intl.DateTimeFormat("en-CA", {
            timeZone: safeTimeZone(timeZone), hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
            hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short"
        });
        for (const part of formatter.formatToParts(date)) if (part.type !== "literal") fields[part.type] = part.value;
        return {
            year: Number(fields.year), month: Number(fields.month), day: Number(fields.day),
            hour: Number(fields.hour), minute: Number(fields.minute), second: Number(fields.second),
            weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(fields.weekday)
        };
    }

    function normalizeCivil(parts) {
        const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour || 0, parts.minute || 0, parts.second || 0, parts.millisecond || 0));
        return {
            year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(),
            hour: date.getUTCHours(), minute: date.getUTCMinutes(), second: date.getUTCSeconds(), millisecond: date.getUTCMilliseconds()
        };
    }

    function civilShift(parts, { days = 0, months = 0 } = {}) {
        return normalizeCivil({ ...parts, month: parts.month + months, day: parts.day + days });
    }

    // Converts a civil wall-clock time to an instant. Iteration accounts for
    // offset changes at DST boundaries without slicing or constructing UTC dates.
    function zonedInstant(parts, timeZone) {
        const zone = safeTimeZone(timeZone);
        const civil = normalizeCivil(parts);
        const target = Date.UTC(civil.year, civil.month - 1, civil.day, civil.hour, civil.minute, civil.second, civil.millisecond);
        let guess = target;
        for (let pass = 0; pass < 4; pass += 1) {
            const seen = zonedParts(guess, zone);
            const represented = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute, seen.second, civil.millisecond);
            const next = guess + target - represented;
            if (next === guess) break;
            guess = next;
        }
        return new Date(guess);
    }

    function localDateKey(value, timeZone) {
        const part = zonedParts(value, timeZone);
        return `${part.year}-${String(part.month).padStart(2, "0")}-${String(part.day).padStart(2, "0")}`;
    }

    function rangeForView(anchor, view = "week", timeZone) {
        const zone = safeTimeZone(timeZone);
        const mode = VIEWS.has(view) ? view : "week";
        const anchorDate = anchor instanceof Date ? anchor : new Date(anchor);
        if (!Number.isFinite(anchorDate.getTime())) throw new Error("PLANNER_DATE_INVALID");
        const local = zonedParts(anchorDate, zone);
        let startParts = { ...local, hour: 0, minute: 0, second: 0, millisecond: 0 };
        if (mode === "week") startParts = civilShift(startParts, { days: -local.weekday });
        if (mode === "month") startParts = { ...startParts, day: 1 };
        const endParts = mode === "day" ? civilShift(startParts, { days: 1 })
            : mode === "week" ? civilShift(startParts, { days: 7 })
                : civilShift(startParts, { months: 1 });
        const start = zonedInstant(startParts, zone);
        const end = zonedInstant(endParts, zone);
        return deepFreeze({ view: mode, timeZone: zone, anchor: anchorDate.toISOString(), start: start.toISOString(), end: end.toISOString() });
    }

    function monthGridRange(anchor, timeZone) {
        const zone = safeTimeZone(timeZone);
        const month = rangeForView(anchor, "month", zone);
        const first = zonedParts(month.start, zone);
        const startParts = civilShift({ ...first, hour: 0, minute: 0, second: 0, millisecond: 0 }, { days: -first.weekday });
        const monthEnd = zonedParts(month.end, zone);
        const trailing = monthEnd.weekday === 0 ? 0 : 7 - monthEnd.weekday;
        const endParts = civilShift({ ...monthEnd, hour: 0, minute: 0, second: 0, millisecond: 0 }, { days: trailing });
        return deepFreeze({ ...month, start: zonedInstant(startParts, zone).toISOString(), end: zonedInstant(endParts, zone).toISOString() });
    }

    function snapInstant(value, minutes = 15, mode = "nearest") {
        const date = value instanceof Date ? value : new Date(value);
        if (!Number.isFinite(date.getTime())) throw new Error("PLANNER_DATE_INVALID");
        const step = Math.max(1, Math.min(60, Number(minutes) || 15)) * 60 * 1000;
        const operation = mode === "floor" ? Math.floor : mode === "ceil" ? Math.ceil : Math.round;
        return new Date(operation(date.getTime() / step) * step);
    }

    function defaultTimedRange(value) {
        const start = snapInstant(value, 15, "nearest");
        return deepFreeze({ start: start.toISOString(), end: new Date(start.getTime() + 60 * 60 * 1000).toISOString() });
    }

    function accountFingerprint(account) {
        const canvas = account?.canvas || {};
        const nest = account?.nest || {};
        return canvas.verified === true && /^[a-f0-9]{64}$/.test(String(canvas.accountKey || "")) && nest.verified === true && cleanText(nest.identity, 160)
            ? `${canvas.accountKey}:${cleanText(nest.identity, 160)}` : null;
    }

    function capabilityEnabled(capabilities, names) {
        return names.every((name) => capabilities?.[name] === true);
    }

    function consentCandidates(consent) {
        if (Array.isArray(consent)) return consent;
        if (!consent || typeof consent !== "object") return [];
        return [consent.read, consent.write, consent.v1, consent.v2, consent].filter((item) => item && typeof item === "object");
    }

    function hasConsent(consent, accountKey, scopes) {
        return consentCandidates(consent).some((item) => {
            const key = item.account_key ?? item.accountKey;
            const grantedScopes = Array.isArray(item.scopes) ? item.scopes : [];
            return item.current === true && item.granted === true && item.revoked !== true && item.state !== "revoked"
                && key === accountKey && scopes.every((scope) => grantedScopes.includes(scope));
        });
    }

    function accessFor(account) {
        const fingerprint = accountFingerprint(account);
        if (!fingerprint) return deepFreeze({ read: false, write: false, code: "PLANNER_ACCOUNT_UNVERIFIED" });
        const capabilities = account.nest.capabilities || {};
        if (!capabilityEnabled(capabilities, READ_CAPABILITIES)) return deepFreeze({ read: false, write: false, code: "PLANNER_READ_CAPABILITY_REQUIRED" });
        if (!hasConsent(account.nest.consent, account.canvas.accountKey, READ_SCOPES)) return deepFreeze({ read: false, write: false, code: "PLANNER_READ_CONSENT_REQUIRED" });
        const write = capabilityEnabled(capabilities, WRITE_CAPABILITIES)
            && hasConsent(account.nest.consent, account.canvas.accountKey, WRITE_SCOPES);
        return deepFreeze({ read: true, write, code: write ? null : "PLANNER_WRITE_CONSENT_REQUIRED" });
    }

    function eventKey(event) {
        return cleanText(event?.event_ref || event?.id || event?.source_url, 320) || null;
    }

    function isPersonalEvent(event) {
        return Boolean(event && event.editable === true && ["user", "native"].includes(event.source_type) && /^user:[A-Za-z0-9]/.test(String(event.event_ref || "")));
    }

    function normalizeDraft(input, { partial = false } = {}) {
        const source = input && typeof input === "object" ? input : {};
        const output = {};
        if (!partial || Object.prototype.hasOwnProperty.call(source, "title")) {
            output.title = cleanText(source.title, 512);
            if (!partial && !output.title) throw new Error("PLANNER_TITLE_REQUIRED");
        }
        for (const key of ["start", "end"]) {
            if (!partial || Object.prototype.hasOwnProperty.call(source, key)) {
                const date = new Date(source[key]);
                if (!Number.isFinite(date.getTime())) throw new Error("PLANNER_DATE_INVALID");
                output[key] = date.toISOString();
            }
        }
        if (!partial && !(Date.parse(output.start) < Date.parse(output.end))) throw new Error("PLANNER_RANGE_INVALID");
        if (output.start && output.end && !(Date.parse(output.start) < Date.parse(output.end))) throw new Error("PLANNER_RANGE_INVALID");
        for (const key of ["description", "calendar_id", "color"]) if (Object.prototype.hasOwnProperty.call(source, key)) output[key] = cleanText(source[key], key === "description" ? 4096 : 160);
        if (Object.prototype.hasOwnProperty.call(source, "all_day")) output.all_day = source.all_day === true;
        if (Object.prototype.hasOwnProperty.call(source, "reminder_minutes")) {
            const reminder = Number(source.reminder_minutes);
            if (!Number.isInteger(reminder) || reminder < 0 || reminder > 525600) throw new Error("PLANNER_REMINDER_INVALID");
            output.reminder_minutes = reminder;
        }
        return output;
    }

    function createPlannerAdapter({ send, getAccount, timeZone, now = () => new Date(), importLedger } = {}) {
        if (typeof send !== "function" || typeof getAccount !== "function") throw new Error("PLANNER_ADAPTER_DEPENDENCIES_REQUIRED");
        const zone = safeTimeZone(timeZone);
        let generation = 0;
        let draftSequence = 0;
        let activeFingerprint = accountFingerprint(getAccount());
        const sessionImports = new Set();
        let state = {
            access: accessFor(getAccount()), loading: false, range: null, events: [], visibleEvents: [], sources: [],
            filters: { sourceIds: [], kinds: [], showCompleted: true }, drafts: {}, importedSourceIds: [], import: null, error: null
        };
        const listeners = new Set();

        function snapshot() { return deepFreeze(clone(state)); }
        function publish(patch) {
            state = { ...state, ...patch };
            const value = snapshot();
            for (const listener of listeners) listener(value);
            return value;
        }
        function currentProof(permission) {
            const account = getAccount();
            const access = accessFor(account);
            const fingerprint = accountFingerprint(account);
            return { account, access, fingerprint, allowed: Boolean(fingerprint && access[permission]) };
        }
        function filtered(events, filters = state.filters) {
            return events.filter((event) => {
                const source = cleanText(event.calendar_id || event.source_label, 160);
                const kind = cleanText(event.source_type, 32);
                return (!filters.sourceIds.length || filters.sourceIds.includes(source))
                    && (!filters.kinds.length || filters.kinds.includes(kind))
                    && (filters.showCompleted || event.completed !== true);
            });
        }
        function refreshAccess() {
            generation += 1;
            const account = getAccount();
            const fingerprint = accountFingerprint(account);
            const changedAccount = fingerprint !== activeFingerprint;
            activeFingerprint = fingerprint;
            const access = accessFor(account);
            return publish({
                access, loading: false, error: access.read ? (changedAccount ? null : state.error) : access.code,
                ...(changedAccount ? { range: null, events: [], visibleEvents: [], sources: [], drafts: {}, importedSourceIds: [], import: null } : {})
            });
        }
        function setFilters(next = {}) {
            const filters = {
                sourceIds: Array.isArray(next.sourceIds) ? [...new Set(next.sourceIds.map((item) => cleanText(item, 160)).filter(Boolean))] : state.filters.sourceIds,
                kinds: Array.isArray(next.kinds) ? [...new Set(next.kinds.map((item) => cleanText(item, 32)).filter(Boolean))] : state.filters.kinds,
                showCompleted: typeof next.showCompleted === "boolean" ? next.showCompleted : state.filters.showCompleted
            };
            return publish({ filters, visibleEvents: filtered(state.events, filters) });
        }
        function retainDraft(id, draft, error) {
            const drafts = { ...state.drafts, [id]: { ...clone(draft), error: cleanText(error?.message || error, 160) || "PLANNER_OPERATION_FAILED" } };
            publish({ drafts, error: drafts[id].error });
        }
        function clearDraft(id) {
            if (!Object.prototype.hasOwnProperty.call(state.drafts, id)) return;
            const drafts = { ...state.drafts };
            delete drafts[id];
            publish({ drafts });
        }
        async function loadRange({ anchor = now(), view = "week", useMonthGrid = false } = {}) {
            const proof = currentProof("read");
            if (!proof.allowed) return publish({ access: proof.access, loading: false, error: proof.access.code });
            const range = view === "month" && useMonthGrid ? monthGridRange(anchor, zone) : rangeForView(anchor, view, zone);
            const token = ++generation;
            publish({ access: proof.access, loading: true, range, error: null });
            try {
                const response = await send(READ_FAMILY, { start: range.start, end: range.end });
                const after = currentProof("read");
                if (token !== generation || after.fingerprint !== proof.fingerprint) return snapshot();
                if (!after.allowed) return publish({ access: after.access, loading: false, error: after.access.code });
                const body = response?.payload && typeof response.payload === "object" ? response.payload : response;
                if (body?.ok !== true || !Array.isArray(body.events)) throw new Error(body?.code || "PLANNER_RANGE_FAILED");
                const events = clone(body.events);
                return publish({ loading: false, events, visibleEvents: filtered(events), sources: clone(body.sources || []), error: null });
            } catch (error) {
                const after = currentProof("read");
                if (token !== generation || after.fingerprint !== proof.fingerprint) return snapshot();
                if (!after.allowed) return publish({ access: after.access, loading: false, error: after.access.code });
                return publish({ loading: false, error: cleanText(error?.message, 160) || "PLANNER_RANGE_FAILED" });
            }
        }
        async function mutate(kind, payload, draftId) {
            const proof = currentProof("write");
            if (!proof.allowed) {
                retainDraft(draftId, payload, proof.access.code);
                return { ok: false, code: proof.access.code };
            }
            const token = generation;
            try {
                const response = await send(WRITE_FAMILIES[kind], payload);
                const after = currentProof("write");
                if (token !== generation || after.fingerprint !== proof.fingerprint) return { ok: false, code: "PLANNER_STALE_RESPONSE" };
                if (!after.allowed) {
                    retainDraft(draftId, payload, after.access.code);
                    publish({ access: after.access });
                    return { ok: false, code: after.access.code };
                }
                const body = response?.payload && typeof response.payload === "object" ? response.payload : response;
                if (body?.ok !== true) throw new Error(body?.code || "PLANNER_OPERATION_FAILED");
                clearDraft(draftId);
                publish({ access: proof.access, error: null });
                return { ok: true, value: clone(body) };
            } catch (error) {
                const after = currentProof("write");
                if (token !== generation || after.fingerprint !== proof.fingerprint) return { ok: false, code: "PLANNER_STALE_RESPONSE" };
                if (!after.allowed) {
                    retainDraft(draftId, payload, after.access.code);
                    publish({ access: after.access });
                    return { ok: false, code: after.access.code };
                }
                retainDraft(draftId, payload, error);
                return { ok: false, code: cleanText(error?.message, 160) || "PLANNER_OPERATION_FAILED" };
            }
        }
        function nextDraftId(prefix) { draftSequence += 1; return `${prefix}-${draftSequence}`; }
        async function createEvent(draft, options = {}) {
            const payload = normalizeDraft(draft);
            return mutate("create", payload, options.draftId || nextDraftId("create"));
        }
        async function updateEvent(event, changes, options = {}) {
            if (!isPersonalEvent(event)) return { ok: false, code: "PLANNER_PERSONAL_EVENT_REQUIRED" };
            const normalized = normalizeDraft(changes, { partial: true });
            if ((normalized.start || normalized.end) && !(Date.parse(normalized.start || event.start) < Date.parse(normalized.end || event.end))) {
                return { ok: false, code: "PLANNER_RANGE_INVALID" };
            }
            const payload = { event_id: event.event_ref, ...normalized };
            return mutate("update", payload, options.draftId || nextDraftId("update"));
        }
        async function moveEvent(event, start, end, options) { return updateEvent(event, { start, end }, options); }
        async function resizeEvent(event, end, options) { return updateEvent(event, { end }, options); }
        async function deleteEvent(event, options = {}) {
            if (!isPersonalEvent(event)) return { ok: false, code: "PLANNER_PERSONAL_EVENT_REQUIRED" };
            return mutate("delete", { event_id: event.event_ref }, options.draftId || nextDraftId("delete"));
        }
        async function ledgerHas(key) { return sessionImports.has(key) || Boolean(await importLedger?.has?.(key)); }
        async function ledgerAdd(key) { sessionImports.add(key); await importLedger?.add?.(key); }
        async function importEvents(items, { calendar_id, color } = {}) {
            const originals = clone(Array.isArray(items) ? items : []);
            const seen = new Set();
            const results = [];
            publish({ import: { running: true, total: originals.length, results: [] }, error: null });
            for (const source of originals) {
                const sourceId = eventKey(source);
                if (!sourceId) { results.push({ sourceId: null, ok: false, code: "PLANNER_IMPORT_SOURCE_ID_REQUIRED" }); continue; }
                if (seen.has(sourceId) || await ledgerHas(sourceId)) { results.push({ sourceId, ok: true, skipped: true, code: "PLANNER_IMPORT_DUPLICATE" }); continue; }
                seen.add(sourceId);
                const range = source.all_day === true
                    ? { start: source.start, end: source.end }
                    : defaultTimedRange(source.start);
                const draft = {
                    title: source.title, description: source.description || "", start: range.start, end: range.end,
                    all_day: source.all_day === true, ...(calendar_id ? { calendar_id } : {}), ...(color ? { color } : {})
                };
                const result = await createEvent(draft, { draftId: `import:${sourceId}` });
                results.push({ sourceId, ...result });
                if (result.ok) await ledgerAdd(sourceId);
                publish({ import: { running: true, total: originals.length, results: clone(results) } });
            }
            const importedSourceIds = [...sessionImports];
            publish({ importedSourceIds, import: { running: false, total: originals.length, results: clone(results) } });
            return deepFreeze({ originals, results: clone(results) });
        }
        function subscribe(listener) {
            if (typeof listener !== "function") return () => {};
            listeners.add(listener);
            listener(snapshot());
            return () => listeners.delete(listener);
        }
        function dispose() { generation += 1; listeners.clear(); }

        return Object.freeze({
            snapshot, subscribe, refreshAccess, setFilters, loadRange, createEvent, updateEvent, moveEvent, resizeEvent,
            deleteEvent, importEvents, dispose, helpers: Object.freeze({ localDateKey, rangeForView, monthGridRange, snapInstant, defaultTimedRange })
        });
    }

    return Object.freeze({
        READ_FAMILY, WRITE_FAMILIES, accessFor, isPersonalEvent, localDateKey, rangeForView, monthGridRange,
        snapInstant, defaultTimedRange, createPlannerAdapter
    });
}));
