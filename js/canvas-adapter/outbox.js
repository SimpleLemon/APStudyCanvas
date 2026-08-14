(function (root, factory) {
    "use strict";

    const identity = root?.APStudyCanvasCanvasAdapter?.Identity || (typeof require === "function" ? require("./identity.js") : null);
    const indexedDb = root?.APStudyCanvasPlatform?.IndexedDb || (typeof require === "function" ? require("../platform/idb.js") : null);
    const security = root?.APStudyCanvasPlatform?.Security || (typeof require === "function" ? require("../platform/security.js") : null);
    const api = factory(identity, indexedDb, security);
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasCanvasAdapter = Object.assign(root.APStudyCanvasCanvasAdapter || {}, { Outbox: api });
}(typeof globalThis !== "undefined" ? globalThis : this, function (identity, indexedDb, security) {
    "use strict";

    const VERSION = 1;
    const MAX_BYTES = 25 * 1024 * 1024;
    const MAX_RECORDS = 10000;
    const MAX_BATCH_BYTES = 512 * 1024;
    const MAX_BATCH_ITEMS = 100;
    const MAX_CHECKPOINT_BYTES = 64 * 1024;
    const MAX_RECEIPT_BYTES = 32 * 1024;
    const MAX_INTENT_BYTES = 64 * 1024;
    const LEASE_MS = 60 * 1000;
    const KEY_PREFIX = "apsc-outbox-v1";
    const HASH_PATTERN = /^[a-f0-9]{64}$/i;
    const EVENT_REF_PATTERN = /^canvas:([a-f0-9]{64}):([a-f0-9]{64})$/i;
    const SOURCE_TYPES = new Set(["assignment", "quiz", "discussion_topic", "planner_note", "calendar_event"]);
    const RECORD_TYPES = Object.freeze({
        CHECKPOINT: "checkpoint",
        NORMALIZED_BATCH: "normalized_batch",
        UPLOAD_RECEIPT: "upload_receipt",
        WRITEBACK_INTENT: "writeback_intent",
        WRITEBACK_RESULT: "writeback_result",
        GENERATION_META: "generation_meta",
        ACCOUNT_REVOCATION: "account_revocation",
        JOURNAL: "journal"
    });
    const WRITEBACK_STATES = Object.freeze([
        "waiting_for_canvas_session",
        "queued",
        "applied",
        "unsupported",
        "forbidden",
        "conflict",
        "retryable_failed",
        "cancelled"
    ]);
    const TERMINAL_WRITEBACK_STATES = new Set(["applied", "unsupported", "forbidden", "conflict", "cancelled"]);
    const ERROR_CLASSES = new Set(["quota", "capacity", "paused", "validation", "conflict", "lease", "cancelled", "forbidden", "unsupported", "server", "network", "offline", "rate_limited", "retryable", "malformed", "unknown"]);
    const SAFE_STATUS_KEYS = new Set(["state", "status", "error_class", "code", "count", "bytes", "pending", "acknowledged", "paused", "attempt", "generation"]);
    const FORBIDDEN_KEY = /^(?:raw|rawdescription|description|details|message|email|rawemail|access[_-]?token|refresh[_-]?token|id[_-]?token|oauth(?:2)?[_-]?token|authorization|bearer|password|passwd|secret|credential|api[_-]?key|client[_-]?secret|private[_-]?ics|csrf|rawcsrf|cookie|set[-_]?cookie|session|id|user[_-]?id|context[_-]?id|course[_-]?id|remote[_-]?id|occurrence[_-]?id|source[_-]?key|canvas[_-]?id|nest[_-]?id)$/i;
    const SAFE_ERROR_CLASS = /^(?:capacity|quota|validation|conflict|lease|cancelled|forbidden|unsupported|server|network|offline|rate_limited|retryable|malformed|unknown)$/;

    function clone(value) {
        if (value === undefined) return undefined;
        if (typeof structuredClone === "function") return structuredClone(value);
        return JSON.parse(JSON.stringify(value));
    }

    function isPlainObject(value) {
        if (!value || typeof value !== "object" || Array.isArray(value)) return false;
        const prototype = Object.getPrototypeOf(value);
        return prototype === Object.prototype || prototype === null;
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

    function byteLength(value) {
        const text = typeof value === "string" ? value : stableStringify(value);
        if (typeof TextEncoder === "function") return new TextEncoder().encode(text).length;
        try { return unescape(encodeURIComponent(text)).length; } catch (error) { return Number.POSITIVE_INFINITY; }
    }

    function hash(value) {
        if (!identity?.sha256HexSync) throw new Error("OUTBOX_HASH_PRIMITIVE_MISSING");
        return identity.sha256HexSync(typeof value === "string" ? value : stableStringify(value));
    }

    function isHash(value) { return HASH_PATTERN.test(String(value || "")); }

    function error(code, details = {}) {
        const result = new Error(String(code));
        result.code = String(code);
        Object.assign(result, details);
        return result;
    }

    function validation(code) { return error(code, { outboxValidation: true }); }

    function assertJson(value, code = "OUTBOX_JSON_INVALID") {
        if (!security?.isJsonSerializable?.(value)) throw validation(code);
        return value;
    }

    function assertNoSecrets(value, path = "", seen = new Set()) {
        assertJson(value, "OUTBOX_RECORD_NOT_SERIALIZABLE");
        if (value === null || typeof value !== "object") {
            if (typeof value === "string" && (security?.hasCredentialLikeScalar?.(value) || /https?:\/\/[^\s"'<>]*\.ics(?:[?#]|$)/i.test(value))) {
                throw validation("OUTBOX_SECRET_REJECTED");
            }
            return;
        }
        if (seen.has(value)) throw validation("OUTBOX_RECORD_CYCLE");
        seen.add(value);
        const entries = Array.isArray(value) ? value.map((item, index) => [String(index), item]) : Object.entries(value);
        for (const [key, child] of entries) {
            if (!Array.isArray(value) && FORBIDDEN_KEY.test(key)) throw validation("OUTBOX_RAW_DATA_REJECTED");
            if (security?.findSensitiveData?.(child, `${path}${key}`)) throw validation("OUTBOX_SECRET_REJECTED");
            assertNoSecrets(child, `${path}${key}.`, seen);
        }
        seen.delete(value);
        return value;
    }

    function safeString(value, max, code = "OUTBOX_STRING_INVALID") {
        if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw validation(code);
        if (security?.hasCredentialLikeScalar?.(value)) throw validation("OUTBOX_SECRET_REJECTED");
        return value.trim();
    }

    function safeHash(value, code = "OUTBOX_HASH_INVALID") {
        if (!isHash(value)) throw validation(code);
        return String(value).toLowerCase();
    }

    function safeInteger(value, { min = 0, max = Number.MAX_SAFE_INTEGER, code = "OUTBOX_INTEGER_INVALID" } = {}) {
        if (!Number.isSafeInteger(value) || value < min || value > max) throw validation(code);
        return value;
    }

    function safeDatePart(value) {
        if (!isPlainObject(value)) throw validation("OUTBOX_DATE_INVALID");
        const allowed = new Set(["kind", "date", "utcInstant", "sourceTimezone", "sourceOffset"]);
        for (const key of Object.keys(value)) if (!allowed.has(key)) throw validation("OUTBOX_DATE_INVALID");
        const result = {};
        if (value.kind !== undefined) result.kind = safeString(value.kind, 32, "OUTBOX_DATE_INVALID");
        if (value.date !== undefined) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value.date))) throw validation("OUTBOX_DATE_INVALID");
            result.date = String(value.date);
        }
        if (value.utcInstant !== undefined) {
            if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(String(value.utcInstant)) || !Number.isFinite(Date.parse(value.utcInstant))) throw validation("OUTBOX_DATE_INVALID");
            result.utcInstant = String(value.utcInstant);
        }
        if (value.sourceTimezone !== undefined) result.sourceTimezone = safeString(value.sourceTimezone, 128, "OUTBOX_DATE_INVALID");
        if (value.sourceOffset !== undefined) {
            if (value.sourceOffset !== "Z" && !/^[+-]\d{2}:\d{2}$/.test(String(value.sourceOffset))) throw validation("OUTBOX_DATE_INVALID");
            result.sourceOffset = String(value.sourceOffset);
        }
        if (!result.date && !result.utcInstant) throw validation("OUTBOX_DATE_INVALID");
        return result;
    }

    function sanitizeCompletion(value) {
        if (value === undefined || value === null) return undefined;
        if (typeof value === "string") {
            const normalized = value.trim().toLowerCase();
            const match = normalized.match(/^(completed|incomplete|not_applicable)(?:\/(none|submission|planner_override|submission\+planner_override))?$/);
            if (!match) throw validation("OUTBOX_COMPLETION_INVALID");
            const status = match[1] === "completed" ? "complete" : match[1];
            return { status, source: match[2] || (status === "complete" ? "unknown" : "none") };
        }
        if (!isPlainObject(value)) throw validation("OUTBOX_COMPLETION_INVALID");
        const allowed = new Set(["status", "source", "submission", "plannerOverride"]);
        for (const key of Object.keys(value)) if (!allowed.has(key)) throw validation("OUTBOX_COMPLETION_INVALID");
        const result = {};
        if (value.status !== undefined) {
            if (!["complete", "incomplete", "not_applicable", "unknown"].includes(String(value.status))) throw validation("OUTBOX_COMPLETION_INVALID");
            result.status = String(value.status);
        }
        if (value.source !== undefined) {
            if (typeof value.source !== "string" || !/^(?:none|submission|planner_override|submission\+planner_override|unknown)$/.test(value.source)) throw validation("OUTBOX_COMPLETION_INVALID");
            result.source = value.source;
        }
        for (const key of ["submission", "plannerOverride"]) {
            if (value[key] === undefined) continue;
            if (!isPlainObject(value[key])) throw validation("OUTBOX_COMPLETION_INVALID");
            const child = value[key];
            if (Object.keys(child).some((name) => !["present", "complete"].includes(name)) || typeof child.present !== "boolean" || typeof child.complete !== "boolean") throw validation("OUTBOX_COMPLETION_INVALID");
            result[key] = { present: child.present, complete: child.complete };
        }
        return result;
    }

    function sanitizeNormalizedPayload(value) {
        if (value === undefined || value === null) return {};
        if (!isPlainObject(value)) throw validation("OUTBOX_BATCH_PAYLOAD_INVALID");
        const allowed = new Set(["title", "date", "deadline", "recurrence", "end", "locationName", "locationAddress", "completion"]);
        for (const key of Object.keys(value)) if (!allowed.has(key)) throw validation("OUTBOX_RAW_DATA_REJECTED");
        const result = {};
        if (value.title !== undefined) result.title = safeString(value.title, 1000, "OUTBOX_BATCH_PAYLOAD_INVALID");
        if (value.date !== undefined) result.date = safeDatePart(value.date);
        if (value.end !== undefined) result.end = safeDatePart(value.end);
        if (value.deadline !== undefined) {
            if (typeof value.deadline !== "boolean") throw validation("OUTBOX_BATCH_PAYLOAD_INVALID");
            result.deadline = value.deadline;
        }
        if (value.locationName !== undefined) result.locationName = safeString(value.locationName, 1000, "OUTBOX_BATCH_PAYLOAD_INVALID");
        if (value.locationAddress !== undefined) result.locationAddress = safeString(value.locationAddress, 2000, "OUTBOX_BATCH_PAYLOAD_INVALID");
        if (value.completion !== undefined) result.completion = sanitizeCompletion(value.completion);
        if (value.recurrence !== undefined) {
            if (!isPlainObject(value.recurrence)) throw validation("OUTBOX_BATCH_PAYLOAD_INVALID");
            const recurrence = {};
            if (value.recurrence.rule !== undefined) recurrence.rule = safeString(value.recurrence.rule, 512, "OUTBOX_BATCH_PAYLOAD_INVALID");
            if (value.recurrence.seriesHash !== undefined) recurrence.series_hash = safeHash(value.recurrence.seriesHash);
            if (value.recurrence.series_hash !== undefined) recurrence.series_hash = safeHash(value.recurrence.series_hash);
            if (Object.keys(value.recurrence).some((key) => !["rule", "seriesHash", "series_hash"].includes(key))) throw validation("OUTBOX_RAW_DATA_REJECTED");
            result.recurrence = recurrence;
        }
        assertNoSecrets(result);
        return result;
    }

    function safeSourceIdentity(value) {
        if (value === undefined || value === null) return undefined;
        if (!isPlainObject(value)) throw validation("OUTBOX_BATCH_SOURCE_INVALID");
        const allowed = new Set(["context", "calendar", "remote", "occurrence", "item_key", "url", "timezone", "offset"]);
        if (Object.keys(value).some((key) => !allowed.has(key))) throw validation("OUTBOX_BATCH_SOURCE_INVALID");
        const result = {};
        for (const key of ["context", "calendar", "remote", "occurrence", "item_key"]) {
            if (value[key] === undefined) continue;
            if (typeof value[key] !== "string" || !value[key].trim() || value[key].length > 512 || /[\u0000-\u001f\u007f]/.test(value[key])) throw validation("OUTBOX_BATCH_SOURCE_INVALID");
            result[key] = value[key].trim();
        }
        if (result.remote !== undefined && !/^[1-9]\d{0,19}$/.test(result.remote)) throw validation("OUTBOX_BATCH_SOURCE_INVALID");
        if (result.occurrence !== undefined && !/^[1-9]\d{0,19}$/.test(result.occurrence)) throw validation("OUTBOX_BATCH_SOURCE_INVALID");
        if (value.url !== undefined) {
            if (typeof value.url !== "string" || value.url.length > 2048 || !/^https:\/\//i.test(value.url)) throw validation("OUTBOX_BATCH_SOURCE_INVALID");
            result.url = value.url;
        }
        if (value.timezone !== undefined) {
            if (typeof value.timezone !== "string" || value.timezone.length > 128 || !/^[A-Za-z0-9_./+ -]+$/.test(value.timezone)) throw validation("OUTBOX_BATCH_SOURCE_INVALID");
            result.timezone = value.timezone;
        }
        if (value.offset !== undefined) {
            if (value.offset !== "Z" && (typeof value.offset !== "string" || !/^[+-]\d{2}:\d{2}$/.test(value.offset))) throw validation("OUTBOX_BATCH_SOURCE_INVALID");
            result.offset = value.offset;
        }
        assertNoSecrets(result);
        return result;
    }

    function sanitizeNormalizedItem(value) {
        if (!isPlainObject(value)) throw validation("OUTBOX_BATCH_ITEM_INVALID");
        const allowed = new Set(["schemaVersion", "eventRef", "event_ref", "source", "payload", "type", "date", "completion", "payloadHash", "payload_hash", "revision", "revision_hash"]);
        if (Object.keys(value).some((key) => !allowed.has(key))) throw validation("OUTBOX_BATCH_ITEM_INVALID");
        const eventRef = value.eventRef ?? value.event_ref;
        const match = String(eventRef || "").match(EVENT_REF_PATTERN);
        if (!match) throw validation("OUTBOX_EVENT_REF_INVALID");
        const source = value.source && isPlainObject(value.source) ? value.source : {};
        const sourceAllowed = new Set(["type", "payloadHash", "payload_hash", "revision", "revision_hash", "accountKey", "account_hash", "identity", "meta"]);
        if (Object.keys(source).some((key) => !sourceAllowed.has(key))) throw validation("OUTBOX_BATCH_SOURCE_INVALID");
        const type = source.type ?? value.type;
        if (!SOURCE_TYPES.has(String(type || ""))) throw validation("OUTBOX_BATCH_SOURCE_INVALID");
        const payloadInput = value.payload ?? { ...(value.date !== undefined ? { date: value.date } : {}), ...(value.completion !== undefined ? { completion: value.completion } : {}) };
        const payload = sanitizeNormalizedPayload(payloadInput);
        const suppliedPayloadHash = value.payloadHash ?? value.payload_hash ?? source.payloadHash ?? source.payload_hash;
        const payloadHash = suppliedPayloadHash === undefined ? hash(payload) : safeHash(suppliedPayloadHash);
        const revisionInput = value.revision_hash ?? source.revision_hash ?? value.revision ?? source.revision;
        const revisionHash = revisionInput === undefined ? hash({ payload_hash: payloadHash, event_ref: String(eventRef).toLowerCase() }) : (isHash(revisionInput) ? String(revisionInput).toLowerCase() : hash(String(revisionInput)));
        if (source.accountKey !== undefined && !isHash(source.accountKey) || source.account_hash !== undefined && !isHash(source.account_hash)) throw validation("OUTBOX_BATCH_SOURCE_INVALID");
        if (source.accountKey !== undefined && String(source.accountKey).toLowerCase() !== match[1].toLowerCase() || source.account_hash !== undefined && String(source.account_hash).toLowerCase() !== match[1].toLowerCase()) throw validation("OUTBOX_BATCH_SOURCE_INVALID");
        const sourceIdentity = safeSourceIdentity(source.identity ?? source.meta);
        const safeCandidate = {
            schemaVersion: Number.isInteger(value.schemaVersion) ? value.schemaVersion : 1,
            eventRef: String(eventRef).toLowerCase(),
            source: {
                type: String(type),
                payloadHash,
                revision_hash: revisionHash,
                account_hash: match[1].toLowerCase(),
                ...(sourceIdentity ? { identity: sourceIdentity } : {})
            },
            payload: payloadInput
        };
        assertNoSecrets({
            ...safeCandidate,
            payload
        });
        return {
            schema_version: Number.isInteger(value.schemaVersion) ? value.schemaVersion : 1,
            event_ref: String(eventRef).toLowerCase(),
            source: {
                type: String(type),
                payload_hash: payloadHash,
                revision_hash: revisionHash,
                account_hash: match[1].toLowerCase(),
                ...(sourceIdentity ? { identity: sourceIdentity } : {})
            },
            payload
        };
    }

    function parseBatchPayload(input) {
        let candidate = input?.body ?? input?.payload ?? input;
        if (typeof candidate === "string") {
            try { candidate = JSON.parse(candidate); } catch (parseError) { throw validation("OUTBOX_BATCH_JSON_INVALID"); }
        }
        if (Array.isArray(candidate)) candidate = { items: candidate };
        if (!isPlainObject(candidate) || !Array.isArray(candidate.items)) throw validation("OUTBOX_BATCH_ITEMS_REQUIRED");
        if (candidate.items.length > MAX_BATCH_ITEMS) throw validation("OUTBOX_BATCH_ITEM_LIMIT");
        const items = candidate.items.map(sanitizeNormalizedItem).sort((left, right) => left.event_ref.localeCompare(right.event_ref));
        const payload = { items };
        const bytes = byteLength(payload);
        if (bytes > MAX_BATCH_BYTES) throw validation("OUTBOX_BATCH_SIZE_LIMIT");
        return { items, byte_length: bytes, item_count: items.length, checksum: hash(payload) };
    }

    function namespace(input = {}) {
        if (!isPlainObject(input)) throw validation("OUTBOX_NAMESPACE_REQUIRED");
        const accountValue = input.accountHash ?? input.account_hash;
        let accountHash;
        if (accountValue !== undefined) accountHash = safeHash(accountValue, "OUTBOX_ACCOUNT_HASH_INVALID");
        else {
            const account = input.account;
            if (isPlainObject(account)) {
                const normalized = identity?.normalizeAccount?.(account);
                if (!normalized) throw validation("OUTBOX_ACCOUNT_INVALID");
                accountHash = hash(`canvas-account-v1\u0000${normalized.origin}\u0000${normalized.userId}`);
            } else accountHash = hash(`account\u0000${safeString(account, 256, "OUTBOX_ACCOUNT_INVALID")}`);
        }
        const sourceValue = input.sourceHash ?? input.source_hash ?? input.source;
        const sourceHash = sourceValue !== undefined && isHash(sourceValue)
            ? String(sourceValue).toLowerCase()
            : hash(`source\u0000${typeof sourceValue === "string" ? safeString(sourceValue, 256, "OUTBOX_SOURCE_INVALID") : stableStringify(assertJson(sourceValue, "OUTBOX_SOURCE_INVALID"))}`);
        const runValue = input.runHash ?? input.run_hash ?? input.run ?? input.runId ?? input.run_id;
        const runHash = runValue !== undefined && isHash(runValue)
            ? String(runValue).toLowerCase()
            : hash(`run\u0000${safeString(runValue, 256, "OUTBOX_RUN_INVALID")}`);
        const generation = safeInteger(input.generation, { max: 0xffffffff, code: "OUTBOX_GENERATION_INVALID" });
        const generationHash = hash(`generation\u0000${generation}`);
        const scopeHash = hash({ account_hash: accountHash, source_hash: sourceHash, run_hash: runHash });
        return Object.freeze({
            account_hash: accountHash,
            source_hash: sourceHash,
            run_hash: runHash,
            generation,
            generation_hash: generationHash,
            scope_hash: scopeHash,
            namespace_hash: hash({ account_hash: accountHash, source_hash: sourceHash, run_hash: runHash, generation_hash: generationHash })
        });
    }

    function keyFor(ns, type, extra = "") {
        const suffix = extra ? `:${extra}` : "";
        return `${KEY_PREFIX}:n:${ns.namespace_hash}:${type}${suffix}`;
    }

    function keyForScope(ns, type, extra = "") {
        const suffix = extra ? `:${extra}` : "";
        return `${KEY_PREFIX}:s:${ns.scope_hash}:${type}${suffix}`;
    }

    function keyForBatch(ns, idempotencyHash) { return keyFor(ns, "b", hash(`batch\u0000${idempotencyHash}`)); }
    function keyForReceipt(ns, idempotencyHash) { return keyFor(ns, "r", hash(`receipt\u0000${idempotencyHash}`)); }
    function keyForIntent(ns, idempotencyHash) { return keyFor(ns, "i", hash(`intent\u0000${idempotencyHash}`)); }
    function keyForCheckpoint(ns) { return keyFor(ns, "c"); }
    function keyForGeneration(ns) { return keyForScope(ns, "generation"); }
    function keyForAccountRevocation(accountHash) { return `${KEY_PREFIX}:a:${accountHash}`; }
    function keyForJournal(commitId) { return `${KEY_PREFIX}:j:${hash(`journal\u0000${commitId}`)}`; }

    function persistedNamespace(ns) {
        return {
            account_hash: ns.account_hash,
            source_hash: ns.source_hash,
            run_hash: ns.run_hash,
            generation: ns.generation,
            generation_hash: ns.generation_hash,
            scope_hash: ns.scope_hash,
            namespace_hash: ns.namespace_hash
        };
    }

    function isOutboxValue(value) { return isPlainObject(value) && value.schema_version === VERSION && typeof value.record_type === "string" && value.key_prefix === KEY_PREFIX; }

    function isSimulatedCrash(error) { return error?.code === "OUTBOX_SIMULATED_CRASH" || error?.simulatedCrash === true; }

    function sanitizeErrorClass(value, fallback = "unknown") {
        const candidate = String(value || "").toLowerCase();
        return SAFE_ERROR_CLASS.test(candidate) && ERROR_CLASSES.has(candidate) ? candidate : fallback;
    }

    function makeStorageError(result, thrown) {
        if (result?.ok === false) {
            const out = error(result.code || "OUTBOX_STORAGE_FAILED", { outboxStorage: true, paused: Boolean(result.paused), storageResult: { code: result.code, paused: Boolean(result.paused), reason: result.reason ? { code: result.reason.code, message: result.reason.message } : null } });
            return out;
        }
        if (thrown) {
            if (indexedDb?.isQuotaExceededError?.(thrown) || thrown?.name === "QuotaExceededError") return error("IDB_QUOTA_EXCEEDED", { outboxStorage: true, paused: true, storageResult: { code: "IDB_QUOTA_EXCEEDED", paused: true } });
            return error("OUTBOX_STORAGE_FAILED", { outboxStorage: true });
        }
        return error("OUTBOX_STORAGE_FAILED", { outboxStorage: true });
    }

    function publicSummary(status) {
        const safe = {};
        for (const key of SAFE_STATUS_KEYS) if (status?.[key] !== undefined) safe[key] = typeof status[key] === "string" ? status[key].slice(0, 80) : status[key];
        return safe;
    }

    function createOutbox(options = {}) {
        const store = options.store || indexedDb?.createIndexedDbStore?.({
            indexedDB: options.indexedDB,
            dbName: options.dbName,
            storeName: options.storeName || "canvas_outbox",
            maxBytes: options.maxBytes ?? MAX_BYTES,
            maxRecords: options.maxRecords ?? MAX_RECORDS,
            now: options.now
        });
        if (!store || typeof store.list !== "function" || typeof store.put !== "function") throw new Error("OUTBOX_STORE_REQUIRED");
        const now = typeof options.now === "function" ? options.now : () => Date.now();
        const leaseMs = safeInteger(options.leaseMs ?? LEASE_MS, { min: 1, max: 24 * 60 * 60 * 1000, code: "OUTBOX_LEASE_INVALID" });
        const hooks = options.hooks || {};
        let recovering = false;

        async function records() {
            const all = await store.list();
            return (Array.isArray(all) ? all : []).filter((entry) => isOutboxValue(entry?.value));
        }

        async function findByKey(key) {
            const current = await records();
            return current.find((entry) => entry.key === key) || null;
        }

        async function write(key, value, state = "pending", { bypass = false, createdAt } = {}) {
            assertJson(value, "OUTBOX_RECORD_NOT_SERIALIZABLE");
            assertNoSecrets(value);
            if (byteLength(value) > (value.record_type === RECORD_TYPES.NORMALIZED_BATCH ? MAX_BATCH_BYTES + 4096 : value.record_type === RECORD_TYPES.CHECKPOINT ? MAX_CHECKPOINT_BYTES : value.record_type === RECORD_TYPES.UPLOAD_RECEIPT ? MAX_RECEIPT_BYTES : MAX_INTENT_BYTES)) throw validation("OUTBOX_RECORD_SIZE_LIMIT");
            const method = bypass && typeof store.putBypassPause === "function" ? store.putBypassPause : store.put;
            let result;
            try { result = await method.call(store, key, clone(value), { state, createdAt: Number.isFinite(createdAt) ? createdAt : now() }); }
            catch (thrown) { throw makeStorageError(null, thrown); }
            if (!result?.ok) throw makeStorageError(result);
            return result;
        }

        async function acknowledgeKey(key) {
            if (typeof store.acknowledge !== "function") throw error("OUTBOX_ACK_PRIMITIVE_MISSING", { outboxStorage: true });
            let result;
            try { result = await store.acknowledge(key); } catch (thrown) { throw makeStorageError(null, thrown); }
            if (!result?.ok) throw makeStorageError(result);
            return result;
        }

        async function removeKey(key) {
            try { await store.delete(key); } catch (thrown) { throw makeStorageError(null, thrown); }
        }

        async function storageStatus() {
            try { return typeof store.status === "function" ? await store.status() : {}; } catch (thrown) { throw makeStorageError(null, thrown); }
        }

        async function atomicStoreMutate(mutator) {
            if (typeof store.atomicMutate !== "function") throw error("OUTBOX_ATOMIC_PRIMITIVE_MISSING", { outboxStorage: true });
            let result;
            try { result = await store.atomicMutate(mutator); } catch (thrown) { throw makeStorageError(null, thrown); }
            if (result?.ok === false) throw makeStorageError(result);
            return result?.result;
        }

        async function status() {
            const [all, underlying] = await Promise.all([records(), storageStatus()]);
            const batches = all.filter((entry) => entry.value.record_type === RECORD_TYPES.NORMALIZED_BATCH);
            const intents = all.filter((entry) => entry.value.record_type === RECORD_TYPES.WRITEBACK_INTENT);
            const receipts = all.filter((entry) => entry.value.record_type === RECORD_TYPES.UPLOAD_RECEIPT);
            const checkpoints = all.filter((entry) => entry.value.record_type === RECORD_TYPES.CHECKPOINT && entry.value.committed === true);
            const pendingBatches = batches.filter((entry) => entry.state !== "acknowledged" && entry.value.status === "pending");
            const acknowledgedBatches = batches.filter((entry) => entry.state === "acknowledged" || entry.value.status === "acknowledged");
            const paused = Boolean(underlying?.paused);
            const pauseReason = underlying?.pauseReason ? { code: String(underlying.pauseReason.code || "IDB_PAUSED"), message: String(underlying.pauseReason.message || "Local storage is paused.") } : null;
            return {
                schema_version: VERSION,
                state: paused ? "paused" : "ready",
                paused,
                pause_reason: pauseReason,
                error_class: pauseReason ? (pauseReason.code.includes("QUOTA") ? "quota" : "capacity") : null,
                limits: { max_bytes: Number(underlying?.maxBytes ?? MAX_BYTES), max_records: Number(underlying?.maxRecords ?? MAX_RECORDS) },
                counters: {
                    underlying_records: Number(underlying?.count ?? all.length),
                    underlying_bytes: Number(underlying?.bytes ?? 0),
                    pending_batches: pendingBatches.length,
                    acknowledged_batches: acknowledgedBatches.length,
                    receipts: receipts.length,
                    checkpoints: checkpoints.length,
                    writeback_intents: intents.length,
                    pending_writeback_intents: intents.filter((entry) => !TERMINAL_WRITEBACK_STATES.has(entry.value.state)).length,
                    leased_batches: batches.filter((entry) => entry.value.lease && Number(entry.value.lease.expires_at) > now()).length
                },
                correlation_hash: `c-${hash({ paused, code: pauseReason?.code || null, count: all.length }).slice(0, 24)}`
            };
        }

        async function mutation(operation) {
            try { return await operation(); }
            catch (caught) {
                if (!caught?.outboxStorage) throw caught;
                const summary = await status();
                return {
                    ok: false,
                    state: caught.paused || summary.paused ? "paused" : "error",
                    code: caught.code || "OUTBOX_STORAGE_FAILED",
                    paused: Boolean(caught.paused || summary.paused),
                    reason: caught.storageResult?.reason || summary.pause_reason || { code: caught.code || "OUTBOX_STORAGE_FAILED", message: "Outbox storage operation failed." },
                    summary: publicSummary(summary)
                };
            }
        }

        async function callHook(step) {
            if (typeof hooks.afterStep === "function") await hooks.afterStep(step);
            if (options.crashAtStep === step) throw error("OUTBOX_SIMULATED_CRASH", { simulatedCrash: true });
        }

        async function runPrepared({ transaction, ns, targets, extra = {} }) {
            const commitId = hash({ transaction, namespace_hash: ns.namespace_hash, target_keys: targets.map((target) => target.key), at: now(), nonce: Math.random() });
            const journalKey = keyForJournal(commitId);
            const targetKeys = targets.map((target) => target.key);
            const previous = [];
            for (const target of targets) {
                const old = await findByKey(target.key);
                previous.push(old ? { key: target.key, value: old.value, state: old.state, created_at: old.createdAt } : { key: target.key, absent: true });
            }
            const journal = {
                schema_version: VERSION,
                key_prefix: KEY_PREFIX,
                record_type: RECORD_TYPES.JOURNAL,
                transaction,
                transaction_state: "prepared",
                commit_id: commitId,
                namespace_hash: ns.namespace_hash,
                target_keys: targetKeys,
                prepared_target_keys: [],
                previous,
                extra: extra.safe || null,
                committed: false
            };
            try {
                await write(journalKey, journal, "pending");
                await callHook("journal_prepared");
                const preparedTargetKeys = [];
                for (const target of targets) {
                    await write(target.key, { ...target.value, committed: false }, target.state || "pending", { createdAt: target.createdAt });
                    preparedTargetKeys.push(target.key);
                    await write(journalKey, { ...journal, prepared_target_keys: preparedTargetKeys.slice() }, "pending");
                    await callHook(`target_prepared:${target.key}`);
                }
                for (const target of targets) {
                    const prepared = await findByKey(target.key);
                    if (!prepared) throw error("OUTBOX_TARGET_MISSING", { outboxStorage: true });
                    await write(target.key, { ...prepared.value, committed: true }, target.state || "pending", { createdAt: target.createdAt });
                    await callHook(`target_committed:${target.key}`);
                }
                await write(journalKey, { ...journal, transaction_state: "committed", committed: true }, "pending");
                await callHook("journal_committed");
                await acknowledgeKey(journalKey);
                await callHook("journal_acknowledged");
                await removeKey(journalKey);
                return { ok: true, commit_id: commitId };
            } catch (caught) {
                if (isSimulatedCrash(caught)) throw caught;
                try {
                    for (const old of previous) {
                        if (old.absent) await removeKey(old.key);
                        else await write(old.key, old.value, old.state === "acknowledged" ? "acknowledged" : "pending", { createdAt: old.created_at });
                    }
                    await removeKey(journalKey);
                } catch (cleanupError) {
                    // Recovery will reconcile any prepared records. Do not
                    // expose cleanup details or replace the original reason.
                }
                throw caught;
            }
        }

        function matchingNamespace(value, ns, { scopeOnly = false } = {}) {
            const candidate = value?.namespace;
            if (!candidate) return false;
            return scopeOnly
                ? candidate.scope_hash === ns.scope_hash
                : candidate.namespace_hash === ns.namespace_hash;
        }

        async function generationMeta(ns) {
            const entry = await findByKey(keyForGeneration(ns));
            return entry?.value?.record_type === RECORD_TYPES.GENERATION_META ? entry : null;
        }

        async function accountRevoked(accountHash) {
            const entry = await findByKey(keyForAccountRevocation(accountHash));
            return entry?.value?.record_type === RECORD_TYPES.ACCOUNT_REVOCATION && entry.value.revoked === true;
        }

        async function updateGeneration(ns, { cancelled, revoked, reason, drainState, drainCommitId, persist = false } = {}) {
            const key = keyForGeneration(ns);
            const existing = await generationMeta(ns);
            const current = existing?.value || {
                schema_version: VERSION,
                key_prefix: KEY_PREFIX,
                record_type: RECORD_TYPES.GENERATION_META,
                account_hash: ns.account_hash,
                scope_hash: ns.scope_hash,
                latest_generation: ns.generation,
                latest_generation_hash: ns.generation_hash,
                cancelled: false,
                revoked: false,
                updated_at: now()
            };
            const latest = Math.max(Number(current.latest_generation || 0), ns.generation);
            const next = {
                ...current,
                latest_generation: latest,
                latest_generation_hash: latest === ns.generation ? ns.generation_hash : current.latest_generation_hash,
                cancelled: cancelled === undefined ? Boolean(current.cancelled) : Boolean(cancelled),
                revoked: Boolean(current.revoked) || Boolean(revoked),
                ...(drainCommitId ? { drain_commit_id: drainCommitId } : {}),
                ...(reason ? { reason_hash: hash(String(reason)) } : {}),
                updated_at: now()
            };
            const nextDrainState = drainState || current.drain_state || (current.cancelled || current.revoked ? "closed" : null);
            if (nextDrainState) next.drain_state = nextDrainState;
            else delete next.drain_state;
            if (!existing || next.latest_generation !== current.latest_generation || next.cancelled !== current.cancelled || next.revoked !== current.revoked || next.drain_state !== current.drain_state || next.drain_commit_id !== current.drain_commit_id || (persist && !existing)) {
                await write(key, next, "acknowledged", { bypass: true });
            }
            return next;
        }

        function validatedCurrentGeneration(value, ns) {
            if (!isPlainObject(value)
                || value.schema_version !== VERSION
                || value.key_prefix !== KEY_PREFIX
                || value.record_type !== RECORD_TYPES.GENERATION_META
                || value.scope_hash !== ns.scope_hash) return null;
            const generation = value.latest_generation;
            if (!Number.isSafeInteger(generation) || generation <= 0 || generation > 0xffffffff) return null;
            if (!isHash(value.latest_generation_hash) || value.latest_generation_hash.toLowerCase() !== hash(`generation\u0000${generation}`)) return null;
            return generation;
        }

        async function getCurrentGeneration(input = {}) {
            const ns = namespace(input.namespace || input);
            const generation = await atomicStoreMutate((all) => {
                const key = keyForGeneration(ns);
                const entry = all.find((candidate) => candidate.key === key);
                return { result: validatedCurrentGeneration(entry?.value, ns) };
            });
            return Number.isSafeInteger(generation) && generation > 0 ? generation : null;
        }

        async function scopeWritable(ns) {
            const meta = await generationMeta(ns);
            if (await accountRevoked(ns.account_hash)) return false;
            return !(meta?.value?.cancelled || meta?.value?.revoked || meta?.value?.drain_state === "closing" || meta?.value?.drain_state === "closed");
        }

        function drainRejected() {
            return { ok: false, state: "cancelled", code: "OUTBOX_DRAIN_CANCELLED" };
        }

        async function safeCheckpoint(value) {
            if (!isPlainObject(value)) throw validation("OUTBOX_CHECKPOINT_REQUIRED");
            assertNoSecrets(value);
            const allowed = new Set(["contract_version", "source_hash", "account_hash", "expected_origin_hash", "expected_user_hash", "consent_version", "scope", "filter", "window", "generation", "window_index", "page", "counters", "overlap_watermark", "retry_attempt", "page_url", "page_url_hash", "cursor"]);
            if (Object.keys(value).some((key) => !allowed.has(key))) throw validation("OUTBOX_CHECKPOINT_INVALID");
            const result = {
                contract_version: safeInteger(value.contract_version, { min: 1, max: 100, code: "OUTBOX_CHECKPOINT_INVALID" }),
                source_hash: safeHash(value.source_hash, "OUTBOX_CHECKPOINT_INVALID"),
                account_hash: safeHash(value.account_hash, "OUTBOX_CHECKPOINT_INVALID"),
                expected_origin_hash: safeHash(value.expected_origin_hash, "OUTBOX_CHECKPOINT_INVALID"),
                expected_user_hash: safeHash(value.expected_user_hash, "OUTBOX_CHECKPOINT_INVALID"),
                consent_version: safeString(String(value.consent_version ?? ""), 128, "OUTBOX_CHECKPOINT_INVALID"),
                generation: safeInteger(value.generation, { max: 0xffffffff, code: "OUTBOX_CHECKPOINT_INVALID" }),
                window_index: safeInteger(value.window_index, { max: 1000000, code: "OUTBOX_CHECKPOINT_INVALID" }),
                page: safeInteger(value.page, { min: 1, max: 100000000, code: "OUTBOX_CHECKPOINT_INVALID" }),
                retry_attempt: safeInteger(value.retry_attempt ?? 0, { max: 1000, code: "OUTBOX_CHECKPOINT_INVALID" }),
                counters: {}
            };
            if (value.account_hash !== undefined && !isHash(value.account_hash)) throw validation("OUTBOX_CHECKPOINT_INVALID");
            for (const key of ["pages", "items", "windows", "retries"]) {
                if (value.counters?.[key] !== undefined) result.counters[key] = safeInteger(value.counters[key], { max: 1000000000, code: "OUTBOX_CHECKPOINT_INVALID" });
            }
            if (value.overlap_watermark !== undefined && value.overlap_watermark !== null) result.overlap_watermark = safeString(String(value.overlap_watermark), 128, "OUTBOX_CHECKPOINT_INVALID");
            for (const key of ["scope", "filter", "window"]) if (value[key] !== undefined) result[`${key}_hash`] = hash(value[key]);
            if (value.page_url_hash !== undefined) result.position_hash = safeHash(value.page_url_hash, "OUTBOX_CHECKPOINT_INVALID");
            else if (value.page_url !== undefined) result.position_hash = hash(String(value.page_url));
            else if (value.cursor !== undefined) result.position_hash = hash(String(value.cursor));
            else result.position_hash = hash({ page: result.page, window_index: result.window_index });
            result.checkpoint_hash = hash(result);
            if (byteLength(result) > MAX_CHECKPOINT_BYTES) throw validation("OUTBOX_CHECKPOINT_SIZE_LIMIT");
            return result;
        }

        async function checkpointFor(ns) {
            const entry = await findByKey(keyForCheckpoint(ns));
            if (!entry || entry.value.record_type !== RECORD_TYPES.CHECKPOINT || entry.value.committed !== true) return null;
            return entry;
        }

        async function enqueueBatch(input = {}) {
            return mutation(async () => {
                const ns = namespace(input.namespace || input);
                const idempotencyKey = safeString(input.idempotencyKey ?? input.idempotency_key, 256, "OUTBOX_IDEMPOTENCY_KEY_INVALID");
                const idempotencyHash = hash(`idempotency\u0000${idempotencyKey}`);
                const parsed = parseBatchPayload(input.batch ?? input);
                const sequence = safeInteger(input.batchSequence ?? input.batch_sequence ?? 0, { max: MAX_RECORDS - 1, code: "OUTBOX_BATCH_SEQUENCE_INVALID" });
                const key = keyForBatch(ns, idempotencyHash);
                const existing = await findByKey(key);
                if (existing?.value?.record_type === RECORD_TYPES.NORMALIZED_BATCH) {
                    if (existing.value.payload_hash !== parsed.checksum) return { ok: false, state: "conflict", code: "OUTBOX_IDEMPOTENCY_CONFLICT", idempotency_hash: idempotencyHash };
                    return { ok: true, duplicate: true, batch: publicBatch(existing) };
                }
                if (!await scopeWritable(ns)) return drainRejected();
                const meta = await updateGeneration(ns);
                if (meta.revoked || meta.cancelled) return { ok: false, state: "cancelled", code: "OUTBOX_DRAIN_CANCELLED" };
                const value = {
                    schema_version: VERSION,
                    key_prefix: KEY_PREFIX,
                    record_type: RECORD_TYPES.NORMALIZED_BATCH,
                    namespace: persistedNamespace(ns),
                    idempotency_hash: idempotencyHash,
                    payload_hash: parsed.checksum,
                    batch_sequence: sequence,
                    status: "pending",
                    attempt: 0,
                    retry_after: 0,
                    payload: parsed,
                    committed: false
                };
                const targets = [{ key, value, state: "pending" }];
                if (input.checkpoint !== undefined) {
                    const checkpoint = await safeCheckpoint(input.checkpoint);
                    if (checkpoint.generation !== ns.generation) throw validation("OUTBOX_CHECKPOINT_GENERATION_MISMATCH");
                    targets.push({ key: keyForCheckpoint(ns), value: { schema_version: VERSION, key_prefix: KEY_PREFIX, record_type: RECORD_TYPES.CHECKPOINT, namespace: persistedNamespace(ns), checkpoint, committed: false }, state: "acknowledged" });
                }
                const committed = await runPrepared({ transaction: input.checkpoint === undefined ? "batch" : "batch_checkpoint", ns, targets });
                const stored = await findByKey(key);
                return { ok: true, duplicate: false, commit_id: committed.commit_id, batch: publicBatch(stored) };
            });
        }

        function publicBatch(entry) {
            if (!entry?.value || entry.value.record_type !== RECORD_TYPES.NORMALIZED_BATCH) return null;
            return {
                batch_key: hash(entry.key),
                namespace: clone(entry.value.namespace),
                idempotency_hash: entry.value.idempotency_hash,
                payload_hash: entry.value.payload_hash,
                batch_sequence: entry.value.batch_sequence,
                status: entry.state === "acknowledged" ? "acknowledged" : entry.value.status,
                attempt: entry.value.attempt,
                retry_after: entry.value.retry_after,
                lease: entry.value.lease ? clone(entry.value.lease) : null,
                payload: clone(entry.value.payload)
            };
        }

        async function listPending(input = {}) {
            const ns = input.namespace ? namespace(input.namespace) : null;
            const entries = (await records()).filter((entry) => entry.value.record_type === RECORD_TYPES.NORMALIZED_BATCH && entry.value.committed === true && entry.state !== "acknowledged" && entry.value.status === "pending" && (!ns || matchingNamespace(entry.value, ns)));
            const grouped = new Map();
            for (const entry of entries) {
                const scope = entry.value.namespace.scope_hash;
                if (!grouped.has(scope)) {
                    const meta = await generationMeta({ ...nsFromPersisted(entry.value.namespace), scope_hash: scope });
                    grouped.set(scope, Number(meta?.value?.latest_generation ?? Math.max(...entries.filter((candidate) => candidate.value.namespace.scope_hash === scope).map((candidate) => candidate.value.namespace.generation))));
                }
            }
            const filtered = entries.filter((entry) => {
                const latestGeneration = grouped.get(entry.value.namespace.scope_hash);
                if (input.includeSuperseded) return true;
                return entry.value.namespace.generation >= latestGeneration;
            });
            filtered.sort((left, right) => left.value.namespace.scope_hash.localeCompare(right.value.namespace.scope_hash) || left.value.namespace.generation - right.value.namespace.generation || left.value.batch_sequence - right.value.batch_sequence || left.value.idempotency_hash.localeCompare(right.value.idempotency_hash));
            return filtered.map(publicBatch);
        }

        function nsFromPersisted(value) {
            return {
                account_hash: value.account_hash,
                source_hash: value.source_hash,
                run_hash: value.run_hash,
                generation: value.generation,
                generation_hash: value.generation_hash,
                scope_hash: value.scope_hash,
                namespace_hash: value.namespace_hash
            };
        }

        async function resumePending(input = {}) {
            return { ok: true, state: "ready", pending: await listPending(input) };
        }

        async function saveCheckpoint(input = {}) {
            return mutation(async () => {
                const ns = namespace(input.namespace || input);
                const checkpoint = await safeCheckpoint(input.checkpoint ?? input.value);
                if (checkpoint.generation !== ns.generation) throw validation("OUTBOX_CHECKPOINT_GENERATION_MISMATCH");
                if (!await scopeWritable(ns)) return drainRejected();
                await updateGeneration(ns);
                const existing = await checkpointFor(ns);
                if (existing?.value?.checkpoint?.checkpoint_hash === checkpoint.checkpoint_hash) return { ok: true, duplicate: true, checkpoint: clone(existing.value.checkpoint) };
                const key = keyForCheckpoint(ns);
                await runPrepared({ transaction: "checkpoint", ns, targets: [{ key, value: { schema_version: VERSION, key_prefix: KEY_PREFIX, record_type: RECORD_TYPES.CHECKPOINT, namespace: persistedNamespace(ns), checkpoint, committed: false }, state: "acknowledged" }] });
                const saved = await checkpointFor(ns);
                return { ok: true, duplicate: false, checkpoint: clone(saved.value.checkpoint) };
            });
        }

        async function commitBatchAndCheckpoint(input = {}) {
            return enqueueBatch({ ...input, checkpoint: input.checkpoint });
        }

        async function getCheckpoint(input = {}) {
            const ns = namespace(input.namespace || input);
            const entry = await checkpointFor(ns);
            return entry ? clone(entry.value.checkpoint) : null;
        }

        async function canFetchNext(input = {}) {
            const ns = namespace(input.namespace || input);
            const meta = await generationMeta(ns);
            if (meta?.value?.cancelled || meta?.value?.revoked || meta?.value?.drain_state === "closing" || meta?.value?.drain_state === "closed") return drainRejected();
            const checkpoint = await checkpointFor(ns);
            if (!checkpoint) return { ok: false, state: "blocked", code: "OUTBOX_CHECKPOINT_REQUIRED" };
            return { ok: true, state: "permitted", permission_hash: hash({ namespace_hash: ns.namespace_hash, checkpoint_hash: checkpoint.value.checkpoint.checkpoint_hash }), checkpoint_hash: checkpoint.value.checkpoint.checkpoint_hash };
        }

        async function leaseNext(input = {}) {
            return mutation(async () => {
                const currentStatus = await status();
                if (currentStatus.paused) return { ok: false, state: "paused", code: currentStatus.pause_reason?.code || "IDB_PAUSED", paused: true, summary: publicSummary(currentStatus) };
                const requestedNs = input.namespace ? namespace(input.namespace) : null;
                const requestValue = input.requestKey ?? input.request_key;
                const requestHashValue = requestValue === undefined ? null : hash(`request\u0000${safeString(requestValue, 256, "OUTBOX_REQUEST_KEY_INVALID")}`);
                const result = await atomicStoreMutate((all) => {
                    const validLease = all.find((candidate) => candidate.value?.record_type === RECORD_TYPES.NORMALIZED_BATCH
                        && candidate.state !== "acknowledged"
                        && candidate.value.lease
                        && Number(candidate.value.lease.expires_at) > now());
                    if (validLease) return { result: { kind: "busy", lease: clone(validLease.value.lease) } };
                    const candidates = [];
                    for (const candidate of all) {
                        if (candidate.value?.record_type !== RECORD_TYPES.NORMALIZED_BATCH || candidate.value.committed !== true || candidate.state === "acknowledged" || candidate.value.status !== "pending") continue;
                        if (requestedNs && !matchingNamespace(candidate.value, requestedNs)) continue;
                        const meta = all.find((metaEntry) => metaEntry.value?.record_type === RECORD_TYPES.GENERATION_META && metaEntry.value.scope_hash === candidate.value.namespace.scope_hash);
                        if (meta?.value?.cancelled || meta?.value?.revoked || meta?.value?.drain_state === "closing" || meta?.value?.drain_state === "closed") continue;
                        if (meta?.value && candidate.value.namespace.generation < Number(meta.value.latest_generation || candidate.value.namespace.generation)) continue;
                        if (candidate.value.retry_state === "exhausted") continue;
                        if (Number(candidate.value.retry_after || 0) > now()) continue;
                        candidates.push(candidate);
                    }
                    candidates.sort((left, right) => left.value.namespace.scope_hash.localeCompare(right.value.namespace.scope_hash) || left.value.batch_sequence - right.value.batch_sequence || left.value.idempotency_hash.localeCompare(right.value.idempotency_hash));
                    const entry = candidates[0];
                    if (!entry) return { result: { kind: "empty" } };
                    const nextAttempt = Number(entry.value.attempt || 0) + 1;
                    const issuedAt = now();
                    const leaseId = hash({ batch_key: entry.key, attempt: nextAttempt, issued_at: issuedAt, nonce: Math.random() });
                    const requestHash = requestHashValue || hash(`request\u0000${entry.key}\u0000${nextAttempt}`);
                    const lease = { lease_id: leaseId, request_hash: requestHash, idempotency_hash: entry.value.idempotency_hash, payload_hash: entry.value.payload_hash, generation_hash: entry.value.namespace.generation_hash, issued_at: issuedAt, expires_at: issuedAt + leaseMs, attempt: nextAttempt };
                    const value = { ...entry.value, attempt: nextAttempt, lease };
                    return { puts: [{ ...entry, value, state: "pending" }], result: { kind: "leased", key: entry.key, value, state: "pending", lease } };
                });
                if (result?.kind === "busy") return { ok: false, state: "busy", code: "OUTBOX_LEASE_ACTIVE", lease: clone(result.lease) };
                if (result?.kind === "empty") return { ok: true, state: "empty", lease: null };
                const leased = { key: result.key, value: result.value, state: result.state, createdAt: now() };
                return { ok: true, state: "leased", lease: clone(result.lease), batch: publicBatch(leased) };
            });
        }

        async function scheduleRetry(input = {}) {
            return mutation(async () => {
                const lease = input.lease || {};
                const leaseId = safeHash(lease.lease_id ?? input.leaseId, "OUTBOX_LEASE_INVALID");
                const all = await records();
                const entry = all.find((candidate) => candidate.value.record_type === RECORD_TYPES.NORMALIZED_BATCH && candidate.value.lease?.lease_id === leaseId);
                if (!entry) return { ok: false, state: "conflict", code: "OUTBOX_LEASE_NOT_FOUND" };
                if (!await scopeWritable(nsFromPersisted(entry.value.namespace))) return drainRejected();
                const delay = safeInteger(input.delayMs ?? input.delay_ms ?? 0, { max: 24 * 60 * 60 * 1000, code: "OUTBOX_RETRY_DELAY_INVALID" });
                const errorClass = sanitizeErrorClass(input.errorClass ?? input.error_class, "unknown");
                const exhausted = Number(entry.value.attempt || entry.value.lease?.attempt || 0) >= 8;
                const retryAfterAt = now() + delay;
                await write(entry.key, {
                    ...entry.value,
                    lease: null,
                    retry_after: retryAfterAt,
                    last_error_class: errorClass,
                    ...(exhausted ? { retry_state: "exhausted" } : { retry_state: "scheduled" })
                }, "pending");
                return {
                    ok: true,
                    state: exhausted ? "exhausted" : "scheduled",
                    paused: exhausted,
                    exhausted,
                    retry_after: retryAfterAt,
                    error_class: errorClass,
                    pending: true
                };
            });
        }

        function validateReceipt(receipt, expected) {
            if (!isPlainObject(receipt)) throw validation("OUTBOX_RECEIPT_INVALID");
            assertNoSecrets(receipt);
            const idempotencyHash = receipt.idempotency_hash ?? (receipt.idempotencyKey === undefined ? undefined : hash(`idempotency\u0000${safeString(receipt.idempotencyKey, 256, "OUTBOX_RECEIPT_INVALID")}`));
            const payloadHash = receipt.payload_hash ?? receipt.payloadHash;
            const generationHash = receipt.generation_hash ?? (receipt.generation === undefined ? undefined : hash(`generation\u0000${safeInteger(receipt.generation, { max: 0xffffffff, code: "OUTBOX_RECEIPT_INVALID" })}`));
            if (!isHash(idempotencyHash) || !isHash(payloadHash) || !isHash(generationHash)) throw validation("OUTBOX_RECEIPT_INVALID");
            if (idempotencyHash.toLowerCase() !== expected.idempotency_hash || payloadHash.toLowerCase() !== expected.payload_hash || generationHash.toLowerCase() !== expected.namespace.generation_hash) throw validation("OUTBOX_RECEIPT_MISMATCH");
            const receiptHash = receipt.receipt_hash && isHash(receipt.receipt_hash) ? receipt.receipt_hash.toLowerCase() : hash({ idempotency_hash: idempotencyHash, payload_hash: payloadHash, generation_hash: generationHash, accepted: receipt.accepted === true, server_version_hash: receipt.server_version_hash && isHash(receipt.server_version_hash) ? receipt.server_version_hash.toLowerCase() : null });
            return { idempotency_hash: idempotencyHash.toLowerCase(), payload_hash: payloadHash.toLowerCase(), generation_hash: generationHash.toLowerCase(), receipt_hash: receiptHash, accepted: receipt.accepted !== false };
        }

        async function acknowledgeBatch(input = {}) {
            return mutation(async () => {
                const leaseValue = input.lease?.lease || input.lease || {};
                const leaseIdInput = input.leaseId ?? leaseValue.lease_id;
                const idempotencyHash = input.idempotency_hash || input.idempotencyHash;
                const ns = input.namespace ? namespace(input.namespace) : null;
                let entries = await records();
                let entry = leaseIdInput ? entries.find((candidate) => candidate.value.record_type === RECORD_TYPES.NORMALIZED_BATCH && candidate.value.lease?.lease_id === leaseIdInput) : null;
                if (!entry && ns && idempotencyHash && isHash(idempotencyHash)) entry = entries.find((candidate) => candidate.value.record_type === RECORD_TYPES.NORMALIZED_BATCH && matchingNamespace(candidate.value, ns) && candidate.value.idempotency_hash === String(idempotencyHash).toLowerCase());
                if (!entry && ns && input.idempotencyKey !== undefined) {
                    const idem = hash(`idempotency\u0000${safeString(input.idempotencyKey, 256, "OUTBOX_IDEMPOTENCY_KEY_INVALID")}`);
                    entry = entries.find((candidate) => candidate.value.record_type === RECORD_TYPES.NORMALIZED_BATCH && matchingNamespace(candidate.value, ns) && candidate.value.idempotency_hash === idem);
                }
                if (!entry) return { ok: false, state: "conflict", code: "OUTBOX_BATCH_NOT_FOUND" };
                const expected = entry.value;
                if (!await scopeWritable(nsFromPersisted(expected.namespace))) return drainRejected();
                const receipt = validateReceipt(input.receipt, expected);
                const receiptKey = keyForReceipt(nsFromPersisted(expected.namespace), expected.idempotency_hash);
                const existingReceipt = entries.find((candidate) => candidate.key === receiptKey);
                if (existingReceipt?.value?.record_type === RECORD_TYPES.UPLOAD_RECEIPT) {
                    if (existingReceipt.value.receipt_hash !== receipt.receipt_hash || existingReceipt.value.payload_hash !== receipt.payload_hash) return { ok: false, state: "conflict", code: "OUTBOX_RECEIPT_CONFLICT" };
                    return { ok: true, duplicate: true, receipt: publicReceipt(existingReceipt) };
                }
                const ackPending = { idempotency_hash: receipt.idempotency_hash, payload_hash: receipt.payload_hash, generation_hash: receipt.generation_hash, receipt_hash: receipt.receipt_hash, accepted: receipt.accepted };
                await write(entry.key, { ...expected, ack_pending: ackPending }, "pending", { bypass: true });
                await callHook("ack_prepared");
                await acknowledgeKey(entry.key);
                await callHook("acknowledged");
                const receiptValue = { schema_version: VERSION, key_prefix: KEY_PREFIX, record_type: RECORD_TYPES.UPLOAD_RECEIPT, namespace: expected.namespace, idempotency_hash: receipt.idempotency_hash, payload_hash: receipt.payload_hash, generation_hash: receipt.generation_hash, receipt_hash: receipt.receipt_hash, accepted: receipt.accepted, transaction_state: "committed", committed: true };
                await write(receiptKey, receiptValue, "acknowledged", { bypass: true });
                await callHook("receipt_committed");
                const after = await findByKey(entry.key);
                if (after) {
                    const cleaned = { ...after.value };
                    delete cleaned.ack_pending;
                    cleaned.status = "acknowledged";
                    cleaned.lease = null;
                    await write(entry.key, cleaned, "acknowledged", { bypass: true });
                }
                if (typeof store.resume === "function") await store.resume();
                const savedReceipt = await findByKey(receiptKey);
                return { ok: true, duplicate: false, receipt: publicReceipt(savedReceipt), summary: publicSummary(await status()) };
            });
        }

        function publicReceipt(entry) {
            if (!entry?.value || entry.value.record_type !== RECORD_TYPES.UPLOAD_RECEIPT) return null;
            return { receipt_hash: entry.value.receipt_hash, idempotency_hash: entry.value.idempotency_hash, payload_hash: entry.value.payload_hash, generation_hash: entry.value.generation_hash, accepted: entry.value.accepted };
        }

        function sanitizeMutation(input) {
            if (!isPlainObject(input)) throw validation("OUTBOX_MUTATION_REQUIRED");
            assertNoSecrets(input);
            const allowed = new Set(["completed", "submitted", "status", "due_at", "value_hash", "answer_hash", "target_hash", "revision_hash", "marked_complete"]);
            if (Object.keys(input).some((key) => !allowed.has(key))) throw validation("OUTBOX_MUTATION_FIELDS_INVALID");
            const result = {};
            for (const key of ["completed", "submitted", "marked_complete"]) if (input[key] !== undefined) {
                if (typeof input[key] !== "boolean") throw validation("OUTBOX_MUTATION_FIELDS_INVALID");
                result[key] = input[key];
            }
            if (input.status !== undefined) result.status = safeString(input.status, 64, "OUTBOX_MUTATION_FIELDS_INVALID");
            for (const key of ["value_hash", "answer_hash", "target_hash", "revision_hash"]) if (input[key] !== undefined) result[key] = safeHash(input[key], "OUTBOX_MUTATION_FIELDS_INVALID");
            if (input.due_at !== undefined) {
                if (typeof input.due_at !== "string" || !Number.isFinite(Date.parse(input.due_at)) || input.due_at.length > 128) throw validation("OUTBOX_MUTATION_FIELDS_INVALID");
                result.due_at = input.due_at;
            }
            if (!Object.keys(result).length) throw validation("OUTBOX_MUTATION_FIELDS_INVALID");
            return result;
        }

        function transitionAllowed(from, to) {
            if (!WRITEBACK_STATES.includes(from) || !WRITEBACK_STATES.includes(to)) return false;
            if (from === to) return true;
            const allowed = {
                waiting_for_canvas_session: new Set(["queued", "unsupported", "forbidden", "conflict", "retryable_failed", "cancelled"]),
                queued: new Set(["applied", "unsupported", "forbidden", "conflict", "retryable_failed", "cancelled"]),
                retryable_failed: new Set(["queued", "applied", "unsupported", "forbidden", "conflict", "cancelled"]),
                applied: new Set(), unsupported: new Set(), forbidden: new Set(), conflict: new Set(), cancelled: new Set()
            };
            return allowed[from]?.has(to) || false;
        }

        function makeWritebackResult(entry, state, input) {
            const ns = nsFromPersisted(entry.value.namespace);
            const resultKey = keyFor(ns, "wr", hash(`result\u0000${entry.value.idempotency_hash}\u0000${state}`));
            const resultValue = {
                schema_version: VERSION,
                key_prefix: KEY_PREFIX,
                record_type: RECORD_TYPES.WRITEBACK_RESULT,
                namespace: entry.value.namespace,
                idempotency_hash: entry.value.idempotency_hash,
                payload_hash: entry.value.payload_hash,
                expected_revision_hash: entry.value.expected_revision_hash,
                target_account_hash: entry.value.target_account_hash,
                state,
                error_class: sanitizeErrorClass(input?.errorClass ?? input?.error_class, state === "applied" ? "unknown" : state),
                correlation_hash: `c-${hash(input?.correlation ?? `${entry.value.idempotency_hash}:${state}`).slice(0, 24)}`,
                committed: true
            };
            return { resultKey, resultValue };
        }

        async function enqueueWritebackIntent(input = {}) {
            return mutation(async () => {
                const ns = namespace(input.namespace || input);
                const idempotencyKey = safeString(input.idempotencyKey ?? input.idempotency_key, 256, "OUTBOX_IDEMPOTENCY_KEY_INVALID");
                const idempotencyHash = hash(`writeback\u0000${idempotencyKey}`);
                const mutationFields = sanitizeMutation(input.mutation ?? input.fields ?? input.payload);
                const payloadHash = input.payloadHash ?? input.payload_hash;
                const computedPayloadHash = payloadHash === undefined ? hash(mutationFields) : safeHash(payloadHash, "OUTBOX_PAYLOAD_HASH_INVALID");
                const targetAccountValue = input.targetAccountHash ?? input.target_account_hash ?? input.targetAccount ?? input.target_account;
                let targetAccountHash;
                if (isHash(targetAccountValue)) targetAccountHash = String(targetAccountValue).toLowerCase();
                else if (isPlainObject(targetAccountValue)) {
                    const normalized = identity?.normalizeAccount?.(targetAccountValue);
                    if (!normalized) throw validation("OUTBOX_TARGET_ACCOUNT_INVALID");
                    targetAccountHash = hash(`canvas-account-v1\u0000${normalized.origin}\u0000${normalized.userId}`);
                } else targetAccountHash = hash(`target-account\u0000${safeString(targetAccountValue, 256, "OUTBOX_TARGET_ACCOUNT_INVALID")}`);
                const expectedRevision = input.expectedRevisionHash ?? input.expected_revision_hash ?? input.expectedRevision ?? input.expected_revision;
                const expectedRevisionHash = expectedRevision === undefined ? null : (isHash(expectedRevision) ? String(expectedRevision).toLowerCase() : hash(String(expectedRevision)));
                const state = input.state === undefined ? "waiting_for_canvas_session" : String(input.state);
                if (!WRITEBACK_STATES.includes(state)) throw validation("OUTBOX_WRITEBACK_STATE_INVALID");
                const key = keyForIntent(ns, idempotencyHash);
                const existing = await findByKey(key);
                if (existing?.value?.record_type === RECORD_TYPES.WRITEBACK_INTENT) {
                    if (existing.value.payload_hash !== computedPayloadHash) return { ok: false, state: "conflict", code: "OUTBOX_IDEMPOTENCY_CONFLICT", idempotency_hash: idempotencyHash };
                    return { ok: true, duplicate: true, intent: publicIntent(existing) };
                }
                if (!await scopeWritable(ns)) return drainRejected();
                const meta = await updateGeneration(ns);
                if (meta.revoked || meta.cancelled) return { ok: false, state: "cancelled", code: "OUTBOX_DRAIN_CANCELLED" };
                const value = { schema_version: VERSION, key_prefix: KEY_PREFIX, record_type: RECORD_TYPES.WRITEBACK_INTENT, namespace: persistedNamespace(ns), idempotency_hash: idempotencyHash, target_account_hash: targetAccountHash, expected_revision_hash: expectedRevisionHash, payload_hash: computedPayloadHash, mutation: mutationFields, state, attempt: 0, committed: true };
                await write(key, value, TERMINAL_WRITEBACK_STATES.has(state) ? "acknowledged" : "pending");
                const stored = await findByKey(key);
                return { ok: true, duplicate: false, intent: publicIntent(stored) };
            });
        }

        function publicIntent(entry) {
            if (!entry?.value || entry.value.record_type !== RECORD_TYPES.WRITEBACK_INTENT) return null;
            return { intent_key: hash(entry.key), namespace: clone(entry.value.namespace), idempotency_hash: entry.value.idempotency_hash, target_account_hash: entry.value.target_account_hash, expected_revision_hash: entry.value.expected_revision_hash, payload_hash: entry.value.payload_hash, mutation: clone(entry.value.mutation), state: entry.value.state, attempt: entry.value.attempt };
        }

        async function transitionWriteback(input = {}) {
            return mutation(async () => {
                const intentKey = input.intentKey ?? input.intent_key;
                const all = await records();
                const entry = all.find((candidate) => candidate.value.record_type === RECORD_TYPES.WRITEBACK_INTENT && (candidate.key === intentKey || hash(candidate.key) === intentKey));
                if (!entry) return { ok: false, state: "conflict", code: "OUTBOX_INTENT_NOT_FOUND" };
                const from = entry.value.state;
                const to = String(input.state || "");
                if (!transitionAllowed(from, to)) return { ok: false, state: "conflict", code: "OUTBOX_WRITEBACK_TRANSITION_INVALID" };
                const ns = nsFromPersisted(entry.value.namespace);
                if (from === to) {
                    if (!TERMINAL_WRITEBACK_STATES.has(to)) return { ok: true, duplicate: true, intent: publicIntent(entry) };
                    const terminal = makeWritebackResult(entry, to, input);
                    const existingResult = await findByKey(terminal.resultKey);
                    if (existingResult?.value?.record_type === RECORD_TYPES.WRITEBACK_RESULT && existingResult.value.committed === true) return { ok: true, duplicate: true, intent: publicIntent(entry) };
                    await runPrepared({
                        transaction: "writeback_terminal",
                        ns,
                        targets: [
                            { key: entry.key, value: { ...entry.value, state: to }, state: "acknowledged" },
                            { key: terminal.resultKey, value: terminal.resultValue, state: "acknowledged" }
                        ],
                        extra: { safe: { intent_key_hash: hash(entry.key), state: to } }
                    });
                    const repaired = await findByKey(entry.key);
                    return { ok: true, duplicate: true, repaired: true, intent: publicIntent(repaired) };
                }
                if (!await scopeWritable(ns)) return drainRejected();
                const next = { ...entry.value, state: to, attempt: to === "retryable_failed" ? Number(entry.value.attempt || 0) + 1 : entry.value.attempt };
                if (TERMINAL_WRITEBACK_STATES.has(to)) {
                    const terminal = makeWritebackResult(entry, to, input);
                    await runPrepared({
                        transaction: "writeback_terminal",
                        ns,
                        targets: [
                            { key: entry.key, value: next, state: "acknowledged" },
                            { key: terminal.resultKey, value: terminal.resultValue, state: "acknowledged" }
                        ],
                        extra: { safe: { intent_key_hash: hash(entry.key), state: to } }
                    });
                } else {
                    await write(entry.key, next, "pending", { bypass: true });
                }
                const updated = await findByKey(entry.key);
                return { ok: true, intent: publicIntent(updated) };
            });
        }

        async function drainIntents(ns, intentKeys, { afterStep } = {}) {
            const selected = new Set(intentKeys || []);
            const entries = (await records()).filter((entry) => entry.value.record_type === RECORD_TYPES.WRITEBACK_INTENT
                && matchingNamespace(entry.value, ns, { scopeOnly: true })
                && (!selected.size || selected.has(entry.key)));
            let affected = 0;
            for (const entry of entries) {
                let current = entry;
                if (!TERMINAL_WRITEBACK_STATES.has(current.value.state)) {
                    await write(current.key, { ...current.value, state: "cancelled", committed: true }, "acknowledged", { bypass: true });
                    affected += 1;
                    if (afterStep) await afterStep(`cancel_intent_prepared:${current.key}`);
                    current = await findByKey(current.key);
                }
                if (current?.value?.state === "cancelled") {
                    const terminal = makeWritebackResult(current, "cancelled", { errorClass: "cancelled" });
                    const result = await findByKey(terminal.resultKey);
                    if (!result || result.value.committed !== true) {
                        await write(terminal.resultKey, terminal.resultValue, "acknowledged", { bypass: true });
                        if (afterStep) await afterStep(`cancel_result_prepared:${terminal.resultKey}`);
                    }
                }
            }
            return { affected };
        }

        async function cancel(input = {}) {
            return mutation(async () => {
                const ns = namespace(input.namespace || input);
                let existingMeta = await generationMeta(ns);
                if (existingMeta?.value?.drain_state === "closing") {
                    await recover();
                    existingMeta = await generationMeta(ns);
                }
                const requestedRevoke = Boolean(input.revoke ?? input.revoked);
                if (existingMeta?.value?.drain_state === "closed" && existingMeta.value.cancelled && (!requestedRevoke || existingMeta.value.revoked)) return { ok: true, state: "cancelled", revoked: Boolean(existingMeta.value.revoked), cancelled_intent_count: 0, correlation_hash: `c-${hash({ scope_hash: ns.scope_hash, count: 0 }).slice(0, 24)}` };
                const commitId = hash({ transaction: "cancel", scope_hash: ns.scope_hash, at: now(), nonce: Math.random() });
                const revoke = requestedRevoke || Boolean(existingMeta?.value?.revoked);
                const closing = await updateGeneration(ns, { cancelled: true, revoked: revoke, reason: input.reason || "cancelled", drainState: "closing", drainCommitId: commitId, persist: true });
                await callHook("cancel_marked_closing");
                const intents = (await records()).filter((entry) => entry.value.record_type === RECORD_TYPES.WRITEBACK_INTENT
                    && matchingNamespace(entry.value, ns, { scopeOnly: true })
                    && !TERMINAL_WRITEBACK_STATES.has(entry.value.state));
                const intentKeys = intents.map((entry) => entry.key);
                const targetKeys = [keyForGeneration(ns), ...intentKeys];
                for (const intent of intents) targetKeys.push(makeWritebackResult(intent, "cancelled", { errorClass: "cancelled" }).resultKey);
                const previous = [];
                for (const key of targetKeys) {
                    const old = await findByKey(key);
                    previous.push(old ? { key, value: old.value, state: old.state, created_at: old.createdAt } : { key, absent: true });
                }
                const journalKey = keyForJournal(commitId);
                const journal = {
                    schema_version: VERSION,
                    key_prefix: KEY_PREFIX,
                    record_type: RECORD_TYPES.JOURNAL,
                    transaction: "cancel",
                    transaction_state: "draining",
                    commit_id: commitId,
                    namespace: persistedNamespace(ns),
                    namespace_hash: ns.namespace_hash,
                    scope_hash: ns.scope_hash,
                    target_keys: targetKeys,
                    intent_keys: intentKeys,
                    previous,
                    revoke,
                    reason_hash: closing.reason_hash || hash(String(input.reason || "cancelled")),
                    committed: false
                };
                await write(journalKey, journal, "pending");
                await callHook("cancel_journal_prepared");
                const drained = await drainIntents(ns, intentKeys, { afterStep: callHook });
                await write(journalKey, { ...journal, transaction_state: "committed", committed: true }, "pending");
                await callHook("cancel_journal_committed");
                const closed = await updateGeneration(ns, { cancelled: true, revoked: revoke, drainState: "closed", drainCommitId: commitId, reason: input.reason || "cancelled", persist: true });
                await callHook("cancel_closed");
                await acknowledgeKey(journalKey);
                await removeKey(journalKey);
                return { ok: true, state: "cancelled", revoked: Boolean(closed.revoked), cancelled_intent_count: drained.affected, correlation_hash: `c-${hash({ scope_hash: ns.scope_hash, count: drained.affected }).slice(0, 24)}` };
            });
        }

        async function supersedeGeneration(input = {}) {
            return mutation(async () => {
                const ns = namespace(input.namespace || input);
                if (!await scopeWritable(ns)) return drainRejected();
                const meta = await updateGeneration(ns, { persist: true });
                return { ok: true, state: "superseded", latest_generation: meta.latest_generation, latest_generation_hash: meta.latest_generation_hash };
            });
        }

        async function revokeAccount(input = {}) {
            const accountValue = input.accountKey ?? input.account_key;
            if (!isHash(accountValue) || !/^[a-f0-9]{64}$/.test(String(accountValue).toLowerCase())) throw validation("OUTBOX_ACCOUNT_HASH_INVALID");
            const accountHash = String(accountValue).toLowerCase();
            const deleted = await atomicStoreMutate((all) => {
                const accountEntries = all.filter((entry) => {
                    const namespaceAccount = entry.value?.namespace?.account_hash ?? entry.value?.account_hash;
                    return namespaceAccount === accountHash;
                });
                const targetKeys = new Set(accountEntries.map((entry) => entry.key));
                const scopes = new Map();
                for (const entry of accountEntries) {
                    const persisted = entry.value?.namespace;
                    if (!persisted || persisted.account_hash !== accountHash) continue;
                    scopes.set(persisted.scope_hash, persisted);
                }
                for (const entry of all) {
                    if (entry.value?.record_type !== RECORD_TYPES.JOURNAL) continue;
                    if ((entry.value.target_keys || []).some((key) => targetKeys.has(key))) targetKeys.add(entry.key);
                }
                const deletes = accountEntries
                    .filter((entry) => entry.value.record_type !== RECORD_TYPES.GENERATION_META)
                    .map((entry) => entry.key)
                    .concat(all.filter((entry) => targetKeys.has(entry.key) && entry.value.record_type === RECORD_TYPES.JOURNAL).map((entry) => entry.key));
                const puts = [];
                for (const persisted of scopes.values()) {
                    const metaKey = keyForScope(persisted, "generation");
                    const existing = all.find((entry) => entry.key === metaKey)?.value;
                    const generation = Math.max(Number(existing?.latest_generation || 0), Number(persisted.generation || 0), 1);
                    puts.push({
                        key: metaKey,
                        value: {
                            schema_version: VERSION,
                            key_prefix: KEY_PREFIX,
                            record_type: RECORD_TYPES.GENERATION_META,
                            account_hash: accountHash,
                            scope_hash: persisted.scope_hash,
                            latest_generation: generation,
                            latest_generation_hash: hash(`generation\u0000${generation}`),
                            cancelled: true,
                            revoked: true,
                            drain_state: "closed",
                            updated_at: now()
                        },
                        state: "acknowledged"
                    });
                }
                puts.push({
                    key: keyForAccountRevocation(accountHash),
                    value: { schema_version: VERSION, key_prefix: KEY_PREFIX, record_type: RECORD_TYPES.ACCOUNT_REVOCATION, account_hash: accountHash, revoked: true, updated_at: now() },
                    state: "acknowledged"
                });
                return { deletes: Array.from(new Set(deletes)), puts, result: deletes.length };
            });
            return { ok: true, state: "revoked", account_hash: accountHash, deleted_count: Number(deleted || 0) };
        }

        async function recover() {
            if (recovering) return { ok: true, state: "busy" };
            recovering = true;
            try {
                const all = await records();
                const byKey = new Map(all.map((entry) => [entry.key, entry]));
                const journals = all.filter((entry) => entry.value.record_type === RECORD_TYPES.JOURNAL);
                for (const journalEntry of journals) {
                    const journal = journalEntry.value;
                    if (journal.transaction === "cancel") {
                        const ns = namespace(journal.namespace || journal);
                        await drainIntents(ns, journal.intent_keys || []);
                        await updateGeneration(ns, { cancelled: true, revoked: Boolean(journal.revoke), drainState: "closed", drainCommitId: journal.commit_id, persist: true });
                        await removeKey(journalEntry.key).catch(() => {});
                        continue;
                    }
                    const targets = (journal.target_keys || []).map((key) => byKey.get(key)).filter(Boolean);
                    const prepared = (journal.prepared_target_keys || []).length === (journal.target_keys || []).length
                        && (journal.target_keys || []).every((key) => journal.prepared_target_keys.includes(key));
                    if (prepared || journal.transaction_state === "committed") {
                        for (const target of targets) {
                            if (target.value.committed !== true) await write(target.key, { ...target.value, committed: true }, target.state === "acknowledged" ? "acknowledged" : "pending", { bypass: true });
                        }
                        await acknowledgeKey(journalEntry.key).catch(() => {});
                    } else {
                        const oldByKey = new Map((journal.previous || []).map((item) => [item.key, item]));
                        for (const key of journal.target_keys || []) {
                            const old = oldByKey.get(key);
                            if (old?.absent) await removeKey(key);
                            else if (old) await write(key, old.value, old.state === "acknowledged" ? "acknowledged" : "pending", { createdAt: old.created_at, bypass: true });
                            else await removeKey(key);
                        }
                    }
                    await removeKey(journalEntry.key).catch(() => {});
                }
                let after = await records();
                // A worker can stop after the closing marker is durable but
                // before the cancel journal itself is written. Complete that
                // marker-driven drain on restart as well.
                for (const metaEntry of after.filter((entry) => entry.value.record_type === RECORD_TYPES.GENERATION_META && entry.value.drain_state === "closing")) {
                    const intent = after.find((entry) => entry.value.record_type === RECORD_TYPES.WRITEBACK_INTENT && entry.value.namespace.scope_hash === metaEntry.value.scope_hash);
                    if (intent) {
                        const ns = nsFromPersisted(intent.value.namespace);
                        await drainIntents(ns, []);
                        await updateGeneration(ns, { cancelled: true, revoked: Boolean(metaEntry.value.revoked), drainState: "closed", drainCommitId: metaEntry.value.drain_commit_id, persist: true });
                    } else {
                        await write(metaEntry.key, { ...metaEntry.value, drain_state: "closed", updated_at: now() }, "acknowledged", { bypass: true });
                    }
                }
                after = await records();
                for (const entry of after.filter((candidate) => candidate.value.record_type === RECORD_TYPES.NORMALIZED_BATCH && candidate.value.ack_pending)) {
                    const pending = entry.value.ack_pending;
                    const receiptKey = keyForReceipt(nsFromPersisted(entry.value.namespace), entry.value.idempotency_hash);
                    const receipt = (await findByKey(receiptKey))?.value;
                    if (entry.state === "acknowledged" || receipt) {
                        if (!receipt) await write(receiptKey, { schema_version: VERSION, key_prefix: KEY_PREFIX, record_type: RECORD_TYPES.UPLOAD_RECEIPT, namespace: entry.value.namespace, ...pending, transaction_state: "committed", committed: true }, "acknowledged", { bypass: true });
                        const current = await findByKey(entry.key);
                        if (current) {
                            const value = { ...current.value, status: "acknowledged" };
                            delete value.ack_pending;
                            await write(entry.key, value, "acknowledged", { bypass: true });
                        }
                    } else {
                        const value = { ...entry.value };
                        delete value.ack_pending;
                        await write(entry.key, value, "pending", { bypass: true });
                    }
                }
                if (typeof store.resume === "function") await store.resume();
                return { ok: true, state: "recovered", summary: publicSummary(await status()) };
            } finally { recovering = false; }
        }

        async function init() {
            if (typeof store.init === "function") await store.init();
            await recover();
            return status();
        }

        return Object.freeze({
            init,
            status,
            recover,
            namespace,
            enqueueBatch,
            enqueue: enqueueBatch,
            enqueueNormalizedBatch: enqueueBatch,
            commitBatchAndCheckpoint,
            saveCheckpoint,
            persistCheckpoint: saveCheckpoint,
            getCheckpoint,
            canFetchNext,
            listPending,
            pendingCount: async (input = {}) => (await listPending({ namespace: input.namespace || input })).length,
            resumePending,
            leaseNext,
            leaseBatch: leaseNext,
            getCurrentGeneration,
            currentGeneration: getCurrentGeneration,
            acknowledgeBatch,
            acknowledge: acknowledgeBatch,
            scheduleRetry,
            retry: scheduleRetry,
            enqueueWritebackIntent,
            transitionWriteback,
            updateWritebackIntent: transitionWriteback,
            supersedeGeneration,
            revokeAccount,
            cancel,
            revoke: (input = {}) => cancel({ ...input, revoke: true })
        });
    }

    return Object.freeze({
        VERSION,
        MAX_BYTES,
        MAX_RECORDS,
        MAX_BATCH_BYTES,
        MAX_BATCH_ITEMS,
        RECORD_TYPES,
        WRITEBACK_STATES,
        createOutbox,
        namespace,
        stableStringify
    });
}));
