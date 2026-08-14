(function (root, factory) {
    "use strict";

    const api = factory();
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasCanvasAdapter = Object.assign(root.APStudyCanvasCanvasAdapter || {}, { SyncState: api });
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const VERSION = 1;
    const SUMMARY_VERSION = 1;
    const STATES = Object.freeze(["running", "waiting_for_canvas_session", "partial", "completed", "cancelled", "failed"]);
    const DESCRIPTOR_STATES = Object.freeze(["exhausted", "partial", "disabled", "failed"]);
    const ACTIONS = Object.freeze(["wait", "resume", "progress", "finalize", "cancel", "fail", "supersede"]);
    const STATE_SET = new Set(STATES);
    const DESCRIPTOR_STATE_SET = new Set(DESCRIPTOR_STATES);
    const ACTION_SET = new Set(ACTIONS);
    const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
    const HASH = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
    const COUNT_KEY = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
    const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
    const MAX_COUNT = 1000000000;
    const MAX_REPLAYS = 128;

    const BINDING_KEYS = new Set([
        "contractVersion", "contract_version", "accountKey", "account_key", "account", "origin",
        "userId", "user_id", "user", "sourceId", "source_id", "source", "sourceRef", "source_ref", "runId", "run_id", "run",
        "generation", "consentVersion", "consent_version", "consent", "scopeHash", "scope_hash", "scope",
        "scopeValue", "scope_value", "registeredDescriptorIds", "registered_descriptor_ids",
        "registeredDescriptors", "registered_descriptors"
    ]);
    const ACTION_KEYS = new Set([
        "type", "action", "transition", "requestId", "request_id", "expectedGeneration", "expected_generation",
        "generation", "binding", "accountKey", "account_key", "origin", "userId", "user_id", "sourceId",
        "source_id", "runId", "run_id", "consentVersion", "consent_version", "scopeHash", "scope_hash",
        "registeredDescriptorIds", "registered_descriptor_ids", "descriptorId", "descriptor_id", "state",
        "counts", "count", "checkpointHash", "checkpoint_hash", "errorCode", "error_code", "code",
        "progress", "record", "records", "nextBinding", "next_binding", "replacementBinding", "replacement_binding"
    ]);
    const SUMMARY_KEYS = new Set([
        "summary_version", "contract_version", "state", "binding", "progress", "complete", "tombstone_eligible",
        "error_code", "replay_ledger"
    ]);
    const SUMMARY_BINDING_KEYS = new Set([
        "account_key", "origin", "user_id", "source_id", "source_ref", "run_id", "generation", "consent_version", "scope_hash",
        "registered_descriptor_ids"
    ]);
    const SUMMARY_PROGRESS_KEYS = new Set(["state", "counts", "checkpoint_hash", "error_code"]);
    const SUMMARY_REPLAY_KEYS = new Set(["request_id", "payload_hash"]);

    function isPlainObject(value) {
        if (!value || typeof value !== "object" || Array.isArray(value)) return false;
        const prototype = Object.getPrototypeOf(value);
        return prototype === Object.prototype || prototype === null;
    }

    function stableStringify(value, seen = new Set()) {
        if (value === null || typeof value !== "object") return JSON.stringify(value);
        if (seen.has(value)) throw new Error("cyclic value");
        seen.add(value);
        let result;
        if (Array.isArray(value)) result = `[${value.map((item) => stableStringify(item, seen)).join(",")}]`;
        else result = `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key], seen)}`).join(",")}}`;
        seen.delete(value);
        return result;
    }

    function hash(value) {
        let first = 2166136261;
        let second = 2246822519;
        const text = stableStringify(value);
        for (let index = 0; index < text.length; index += 1) {
            const code = text.charCodeAt(index);
            first = Math.imul(first ^ code, 16777619) >>> 0;
            second = Math.imul(second ^ code, 3266489917) >>> 0;
        }
        return `h-${first.toString(16).padStart(8, "0")}${second.toString(16).padStart(8, "0")}`;
    }

    function clone(value) {
        if (value === undefined) return undefined;
        if (typeof structuredClone === "function") return structuredClone(value);
        return JSON.parse(JSON.stringify(value));
    }

    function freeze(value, seen = new Set()) {
        if (!value || typeof value !== "object" || seen.has(value)) return value;
        seen.add(value);
        Object.values(value).forEach((item) => freeze(item, seen));
        return Object.freeze(value);
    }

    function failure(code, run) {
        return Object.freeze({ ok: false, code, state: run, run });
    }

    function success(run, replayed = false) {
        return Object.freeze({ ok: true, state: run, run, value: run, replayed });
    }

    function identifier(value, pattern = IDENTIFIER) {
        return typeof value === "string" && value.length > 0 && value === value.trim() && pattern.test(value) ? value : null;
    }

    function origin(value) {
        if (typeof value !== "string") return null;
        try {
            const parsed = new URL(value);
            if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
            if (parsed.pathname !== "" && parsed.pathname !== "/") return null;
            return parsed.origin;
        } catch (error) {
            return null;
        }
    }

    function sourceRef(value) {
        return typeof value === "string" && /^src1:[A-Za-z0-9._~-]{1,128}$/.test(value) ? value : null;
    }

    function userId(value) {
        if (typeof value !== "string" && typeof value !== "number") return null;
        if (typeof value === "number" && !Number.isSafeInteger(value)) return null;
        const result = String(value);
        return /^[1-9][0-9]{0,19}$/.test(result) ? result : null;
    }

    function forbiddenKey(key) {
        return /lease|token|cookie|csrf|raw|event|title|description|url/i.test(String(key));
    }

    function forbiddenValue(value) {
        return typeof value === "string" && /bearer\s|access[_-]?token|refresh[_-]?token|csrf|set-cookie|document\.cookie|private[_-]?ics|data:text|<script/i.test(value);
    }

    function containsForbidden(value, seen = new Set()) {
        if (forbiddenValue(value)) return true;
        if (!value || typeof value !== "object" || seen.has(value)) return false;
        seen.add(value);
        if (Array.isArray(value)) return value.some((item) => containsForbidden(item, seen));
        return Object.entries(value).some(([key, child]) => forbiddenKey(key) || containsForbidden(child, seen));
    }

    function safeScope(value, depth = 0, seen = new Set()) {
        if (depth > 5 || value === undefined || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") return false;
        if (value === null || typeof value === "boolean") return true;
        if (typeof value === "number") return Number.isFinite(value);
        if (typeof value === "string") return value.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(value) && !forbiddenValue(value);
        if (!Array.isArray(value) && !isPlainObject(value)) return false;
        if (seen.has(value)) return false;
        seen.add(value);
        const valid = Array.isArray(value)
            ? value.length <= 64 && value.every((item) => safeScope(item, depth + 1, seen))
            : Object.entries(value).every(([key, child]) => /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key) && !forbiddenKey(key) && safeScope(child, depth + 1, seen));
        seen.delete(value);
        return valid;
    }

    function pick(input, ...names) {
        for (const name of names) if (input[name] !== undefined) return input[name];
        return undefined;
    }

    function normalizeBinding(input, { summary = false } = {}) {
        if (!isPlainObject(input) || containsForbidden(input)) return null;
        const allowed = summary ? SUMMARY_BINDING_KEYS : BINDING_KEYS;
        if (Object.keys(input).some((key) => !allowed.has(key))) return null;
        const contractVersion = summary ? VERSION : (pick(input, "contractVersion", "contract_version") ?? VERSION);
        if (contractVersion !== VERSION) return null;
        const accountKey = identifier(pick(input, "accountKey", "account_key", "account"));
        const canvasOrigin = origin(input.origin);
        const canvasUser = userId(pick(input, "userId", "user_id", "user"));
        const sourceId = identifier(pick(input, "sourceId", "source_id", "source"));
        const sourceRefValue = pick(input, "sourceRef", "source_ref");
        const normalizedSourceRef = sourceRefValue === undefined ? null : sourceRef(sourceRefValue);
        const runId = identifier(pick(input, "runId", "run_id", "run"));
        const generation = input.generation;
        const consentVersion = pick(input, "consentVersion", "consent_version", "consent");
        const registeredInput = pick(input, "registeredDescriptorIds", "registered_descriptor_ids", "registeredDescriptors", "registered_descriptors");
        if (!accountKey || !canvasOrigin || !canvasUser || !sourceId || !runId || consentVersion !== 1 || (sourceRefValue !== undefined && !normalizedSourceRef) || !Number.isSafeInteger(generation) || generation <= 0 || !Array.isArray(registeredInput) || registeredInput.length === 0) return null;
        const registeredDescriptorIds = registeredInput.map((id) => identifier(id));
        if (registeredDescriptorIds.some((id) => !id) || new Set(registeredDescriptorIds).size !== registeredDescriptorIds.length) return null;
        const scopeHashInput = pick(input, "scopeHash", "scope_hash");
        const scopeInput = pick(input, "scopeValue", "scope_value", "scope");
        if (summary && scopeHashInput === undefined) return null;
        if (!summary && scopeInput === undefined && scopeHashInput === undefined) return null;
        if (scopeInput !== undefined && !safeScope(scopeInput)) return null;
        const scopeObject = isPlainObject(scopeInput) && scopeInput.hash !== undefined ? scopeInput.hash : scopeInput;
        const scopeHash = identifier(scopeHashInput, HASH) || (scopeInput !== undefined ? hash(scopeObject) : null);
        if (!scopeHash) return null;
        return {
            contractVersion: VERSION,
            accountKey,
            origin: canvasOrigin,
            userId: canvasUser,
            sourceId,
            ...(normalizedSourceRef ? { sourceRef: normalizedSourceRef } : {}),
            runId,
            generation,
            consentVersion,
            scopeHash,
            registeredDescriptorIds: registeredDescriptorIds.slice().sort()
        };
    }

    function same(left, right) {
        try { return stableStringify(left) === stableStringify(right); } catch (error) { return false; }
    }

    function allExhausted(binding, progress) {
        return binding.registeredDescriptorIds.every((id) => progress[id]?.state === "exhausted");
    }

    function sanitizeError(value) {
        if (value === undefined || value === null) return null;
        if (typeof value !== "string" || !ERROR_CODE.test(value) || forbiddenValue(value) || /TOKEN|COOKIE|CSRF|RAW|EVENT|TITLE|DESCRIPTION|URL/i.test(value)) return null;
        return value;
    }

    function normalizeCounts(value) {
        if (value === undefined) return {};
        if (!isPlainObject(value)) return null;
        const result = {};
        for (const key of Object.keys(value).sort()) {
            if (!COUNT_KEY.test(key) || !Number.isSafeInteger(value[key]) || value[key] < 0 || value[key] > MAX_COUNT) return null;
            result[key] = value[key];
        }
        return result;
    }

    function normalizeProgress(input, expectedId) {
        if (!isPlainObject(input) || containsForbidden(input)) return null;
        const allowed = new Set(["descriptorId", "descriptor_id", "state", "counts", "count", "checkpointHash", "checkpoint_hash", "errorCode", "error_code"]);
        if (Object.keys(input).some((key) => !allowed.has(key))) return null;
        const id = identifier(pick(input, "descriptorId", "descriptor_id") ?? expectedId);
        const state = input.state;
        if (!id || (expectedId && id !== expectedId) || !DESCRIPTOR_STATE_SET.has(state)) return null;
        const counts = normalizeCounts(input.counts);
        if (!counts) return null;
        if (input.count !== undefined) {
            if (!Number.isSafeInteger(input.count) || input.count < 0 || input.count > MAX_COUNT || (counts.items !== undefined && counts.items !== input.count)) return null;
            counts.items = input.count;
        }
        const checkpointInput = pick(input, "checkpointHash", "checkpoint_hash");
        const checkpointHash = checkpointInput === undefined || checkpointInput === null ? null : identifier(checkpointInput, HASH);
        if (checkpointInput !== undefined && checkpointInput !== null && !checkpointHash) return null;
        const errorInput = pick(input, "errorCode", "error_code");
        const errorCode = errorInput === undefined || errorInput === null ? null : sanitizeError(errorInput);
        if (errorInput !== undefined && errorInput !== null && !errorCode) return null;
        return { state, counts, checkpointHash, errorCode };
    }

    function makeRun(binding, state, progress, errorCode, replayLedger) {
        const complete = state === "completed" && allExhausted(binding, progress);
        return freeze({
            version: VERSION,
            binding: freeze(binding),
            state,
            progress: freeze(progress),
            complete,
            tombstoneEligible: complete,
            errorCode: errorCode || null,
            replayLedger: freeze(replayLedger || [])
        });
    }

    function unwrap(input) {
        if (input && input.ok === true && input.run) return input.run;
        return input;
    }

    function validRun(input) {
        const run = unwrap(input);
        if (!isPlainObject(run) || run.version !== VERSION || !STATE_SET.has(run.state) || !isPlainObject(run.binding) || !isPlainObject(run.progress)) return null;
        const binding = normalizeBinding(run.binding);
        if (!binding || !same(binding, run.binding)) return null;
        const progress = {};
        for (const [id, record] of Object.entries(run.progress)) {
            if (!binding.registeredDescriptorIds.includes(id)) return null;
            progress[id] = normalizeProgress(record, id);
            if (!progress[id] || !same(progress[id], record)) return null;
        }
        if (typeof run.complete !== "boolean" || typeof run.tombstoneEligible !== "boolean" || run.complete !== (run.state === "completed" && allExhausted(binding, progress)) || run.tombstoneEligible !== run.complete) return null;
        if (run.errorCode !== null && !sanitizeError(run.errorCode)) return null;
        if (!Array.isArray(run.replayLedger) || run.replayLedger.length > MAX_REPLAYS) return null;
        const ledger = [];
        const ids = new Set();
        for (const entry of run.replayLedger) {
            if (!isPlainObject(entry) || ids.has(entry.requestId) || !identifier(entry.requestId) || !identifier(entry.payloadHash, HASH)) return null;
            ids.add(entry.requestId);
            ledger.push({ requestId: entry.requestId, payloadHash: entry.payloadHash });
        }
        return run;
    }

    function requestId(action) {
        return pick(action, "requestId", "request_id");
    }

    function actionType(action) {
        return pick(action, "type", "action", "transition");
    }

    function fenceMatches(run, action) {
        const generation = pick(action, "expectedGeneration", "expected_generation", "generation");
        if (generation !== undefined && (generation !== run.binding.generation || !Number.isSafeInteger(generation) || generation <= 0)) return false;
        if (action.binding !== undefined) {
            const candidate = normalizeBinding(action.binding);
            if (!candidate || !same(candidate, run.binding)) return false;
        }
        const direct = {};
        const fields = [
            ["accountKey", "account_key"], ["origin", "origin"], ["userId", "user_id"], ["sourceId", "source_id"],
            ["runId", "run_id"], ["consentVersion", "consent_version"], ["scopeHash", "scope_hash"],
            ["registeredDescriptorIds", "registered_descriptor_ids"]
        ];
        let hasDirect = false;
        for (const [camel, snake] of fields) {
            const value = action[camel] ?? action[snake];
            if (value !== undefined) { direct[camel] = value; hasDirect = true; }
        }
        if (hasDirect) {
            const candidate = normalizeBinding({ ...run.binding, ...direct, generation: run.binding.generation });
            if (!candidate || !same(candidate, run.binding)) return false;
        }
        return true;
    }

    function normalizedAction(input) {
        const action = typeof input === "string" ? { type: input } : input;
        if (!isPlainObject(action) || !ACTION_SET.has(actionType(action)) || Object.keys(action).some((key) => !ACTION_KEYS.has(key)) || containsForbidden(action)) return null;
        const id = requestId(action);
        if (id !== undefined && !identifier(id)) return null;
        return { ...action, type: actionType(action) };
    }

    function progressRecords(action, binding) {
        let raw = action.records ?? action.progress ?? action.record;
        if (raw === undefined && action.descriptorId !== undefined) raw = action;
        if (isPlainObject(raw) && !raw.state && !raw.descriptorId && !raw.descriptor_id) {
            return Object.entries(raw).map(([id, record]) => ({ ...record, descriptorId: id }));
        }
        const records = Array.isArray(raw) ? raw : [raw];
        if (!records.length || records.some((record) => !isPlainObject(record))) return null;
        return records;
    }

    function applyProgress(run, action) {
        const records = progressRecords(action, run.binding);
        if (!records) return failure("SYNC_PROGRESS_INVALID", run);
        const nextProgress = clone(run.progress);
        for (const input of records) {
            const record = normalizeProgress({
                descriptorId: pick(input, "descriptorId", "descriptor_id"),
                state: input.state,
                counts: input.counts,
                count: input.count,
                checkpointHash: pick(input, "checkpointHash", "checkpoint_hash"),
                errorCode: pick(input, "errorCode", "error_code")
            });
            const id = identifier(pick(input, "descriptorId", "descriptor_id"));
            if (!record || !id || !run.binding.registeredDescriptorIds.includes(id)) return failure("SYNC_PROGRESS_INVALID", run);
            const existing = nextProgress[id];
            if (existing && !same(existing, record) && ["exhausted", "disabled", "failed"].includes(existing.state)) return failure("SYNC_PROGRESS_CONFLICT", run);
            nextProgress[id] = record;
        }
        const nextState = Object.values(nextProgress).some((record) => record.state !== "exhausted") ? "partial" : "running";
        return makeRun(run.binding, nextState, nextProgress, null, []);
    }

    function transition(input, inputAction) {
        const run = validRun(input);
        if (!run) return failure("SYNC_STATE_INVALID");
        const action = normalizedAction(inputAction);
        if (!action) return failure("SYNC_ACTION_INVALID", run);
        if (!fenceMatches(run, action)) return failure("SYNC_BINDING_OR_GENERATION_MISMATCH", run);
        const id = requestId(action);
        let payloadHash = null;
        if (id !== undefined) {
            const payload = { ...action };
            delete payload.requestId;
            delete payload.request_id;
            try { payloadHash = hash(payload); } catch (error) { return failure("SYNC_ACTION_INVALID", run); }
            const replay = run.replayLedger.find((entry) => entry.requestId === id);
            if (replay) return replay.payloadHash === payloadHash ? success(run, true) : failure("SYNC_REPLAY_CONFLICT", run);
        }

        const allowed = {
            wait: ["running", "partial"],
            resume: ["waiting_for_canvas_session", "partial"],
            progress: ["running", "partial"],
            finalize: ["running", "partial", "waiting_for_canvas_session"],
            cancel: ["running", "partial", "waiting_for_canvas_session"],
            fail: ["running", "partial", "waiting_for_canvas_session"],
            supersede: STATES
        };
        if (!allowed[action.type].includes(run.state)) return failure("SYNC_TRANSITION_NOT_ALLOWED", run);

        let next;
        if (action.type === "wait") next = makeRun(run.binding, "waiting_for_canvas_session", run.progress, null, []);
        else if (action.type === "resume") next = makeRun(run.binding, "running", run.progress, null, []);
        else if (action.type === "progress") {
            const result = applyProgress(run, action);
            if (!result.ok && result.run === run) return result;
            next = result;
        } else if (action.type === "finalize") {
            const complete = allExhausted(run.binding, run.progress);
            next = makeRun(run.binding, complete ? "completed" : "partial", run.progress, complete ? null : "SYNC_DESCRIPTORS_INCOMPLETE", []);
        } else if (action.type === "cancel") next = makeRun(run.binding, "cancelled", run.progress, null, []);
        else if (action.type === "fail") {
            const errorCode = sanitizeError(pick(action, "errorCode", "error_code", "code"));
            if (!errorCode) return failure("SYNC_ERROR_CODE_INVALID", run);
            next = makeRun(run.binding, "failed", run.progress, errorCode, []);
        } else {
            const replacementInput = pick(action, "nextBinding", "next_binding", "replacementBinding", "replacement_binding");
            const replacement = normalizeBinding(replacementInput);
            if (!replacement || replacement.generation <= run.binding.generation) return failure("SYNC_SUPERSEDE_BINDING_MISMATCH", run);
            const currentWithoutGeneration = { ...run.binding, generation: 0 };
            const replacementWithoutGeneration = { ...replacement, generation: 0 };
            if (!same(currentWithoutGeneration, replacementWithoutGeneration)) return failure("SYNC_SUPERSEDE_BINDING_MISMATCH", run);
            next = makeRun(replacement, "running", {}, null, []);
        }
        if (!id) return success(next);
        const ledger = run.replayLedger.concat([{ requestId: id, payloadHash }]).slice(-MAX_REPLAYS);
        return success(makeRun(next.binding, next.state, next.progress, next.errorCode, ledger));
    }

    function toSafeSummary(input) {
        const run = validRun(input);
        if (!run) return null;
        const progress = {};
        for (const [id, record] of Object.entries(run.progress)) {
            progress[id] = {
                state: record.state,
                counts: clone(record.counts),
                checkpoint_hash: record.checkpointHash,
                error_code: record.errorCode
            };
        }
        return {
            summary_version: SUMMARY_VERSION,
            contract_version: VERSION,
            state: run.state,
            binding: {
                account_key: run.binding.accountKey,
                origin: run.binding.origin,
                user_id: run.binding.userId,
                source_id: run.binding.sourceId,
                ...(run.binding.sourceRef ? { source_ref: run.binding.sourceRef } : {}),
                run_id: run.binding.runId,
                generation: run.binding.generation,
                consent_version: run.binding.consentVersion,
                scope_hash: run.binding.scopeHash,
                registered_descriptor_ids: run.binding.registeredDescriptorIds.slice()
            },
            progress,
            complete: run.complete,
            tombstone_eligible: run.tombstoneEligible,
            error_code: run.errorCode,
            replay_ledger: run.replayLedger.map((entry) => ({ request_id: entry.requestId, payload_hash: entry.payloadHash }))
        };
    }

    function restoreSafeSummary(input) {
        let summary = input;
        if (typeof summary === "string") {
            try { summary = JSON.parse(summary); } catch (error) { return failure("SYNC_SUMMARY_CORRUPT"); }
        }
        if (!isPlainObject(summary) || containsForbidden(summary) || Object.keys(summary).some((key) => !SUMMARY_KEYS.has(key))) return failure("SYNC_SUMMARY_CORRUPT");
        if (summary.summary_version !== SUMMARY_VERSION || summary.contract_version !== VERSION) return failure("SYNC_SUMMARY_VERSION_UNSUPPORTED");
        if (!STATE_SET.has(summary.state) || !isPlainObject(summary.binding) || !isPlainObject(summary.progress) || !Array.isArray(summary.replay_ledger)) return failure("SYNC_SUMMARY_CORRUPT");
        const binding = normalizeBinding(summary.binding, { summary: true });
        if (!binding || Object.keys(summary.binding).some((key) => !SUMMARY_BINDING_KEYS.has(key))) return failure("SYNC_SUMMARY_CORRUPT");
        const progress = {};
        for (const [id, raw] of Object.entries(summary.progress)) {
            if (!binding.registeredDescriptorIds.includes(id) || !isPlainObject(raw) || Object.keys(raw).some((key) => !SUMMARY_PROGRESS_KEYS.has(key))) return failure("SYNC_SUMMARY_CORRUPT");
            const record = normalizeProgress({ state: raw.state, counts: raw.counts, checkpoint_hash: raw.checkpoint_hash, error_code: raw.error_code }, id);
            if (!record || !same(record.counts, raw.counts) || record.checkpointHash !== (raw.checkpoint_hash ?? null) || record.errorCode !== (raw.error_code ?? null)) return failure("SYNC_SUMMARY_CORRUPT");
            progress[id] = record;
        }
        if (typeof summary.complete !== "boolean" || typeof summary.tombstone_eligible !== "boolean") return failure("SYNC_SUMMARY_CORRUPT");
        const complete = summary.state === "completed" && allExhausted(binding, progress);
        if (summary.complete !== complete || summary.tombstone_eligible !== complete) return failure("SYNC_SUMMARY_CORRUPT");
        if (summary.error_code !== null && !sanitizeError(summary.error_code)) return failure("SYNC_SUMMARY_CORRUPT");
        const ledger = [];
        const ids = new Set();
        for (const entry of summary.replay_ledger) {
            if (!isPlainObject(entry) || Object.keys(entry).some((key) => !SUMMARY_REPLAY_KEYS.has(key)) || ids.has(entry.request_id) || !identifier(entry.request_id) || !identifier(entry.payload_hash, HASH)) return failure("SYNC_SUMMARY_CORRUPT");
            ids.add(entry.request_id);
            ledger.push({ requestId: entry.request_id, payloadHash: entry.payload_hash });
        }
        return success(makeRun(binding, summary.state, progress, summary.error_code, ledger));
    }

    const api = {
        VERSION,
        SUMMARY_VERSION,
        STATES,
        DESCRIPTOR_STATES,
        ACTIONS,
        createRun(binding) {
            const normalized = normalizeBinding(binding);
            return normalized ? makeRun(normalized, "running", {}, null, []) : null;
        },
        transition,
        toSafeSummary,
        restoreSafeSummary,
        // Kept as small compatibility aliases for adapter callers that use the older names.
        restoreSummary: restoreSafeSummary,
        safeSummary: toSafeSummary,
        normalizeBinding,
        containsForbidden
    };
    return Object.freeze(api);
}));
