(function (root, factory) {
    "use strict";

    const api = factory();
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasCanvasAdapter = Object.assign(root.APStudyCanvasCanvasAdapter || {}, { SyncExtractStage: api });
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const MAX_ITEMS = 80;
    const MAX_PAYLOAD_BYTES = 48 * 1024;
    const MAX_VALIDATION_STRING = MAX_PAYLOAD_BYTES * 2;
    const MAX_TEXT = 512;
    const MAX_COUNT = 1000000000;
    const HASH = /^[a-f0-9]{64}$/i;
    const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/+%-]{0,255}$/;
    const TYPES = new Set(["assignment", "quiz", "discussion_topic", "planner_note", "calendar_event"]);
    const RESULT_KEYS = new Set(["batches", "descriptorProgress", "quarantineCount", "checkpointHash", "complete"]);
    const BATCH_KEYS = new Set(["items", "checkpoint", "payloadHash"]);
    const ITEM_KEYS = new Set(["schemaVersion", "eventRef", "source", "payload"]);
    const SOURCE_KEYS = new Set(["type", "accountKey", "payloadHash", "revision", "identity"]);
    const IDENTITY_KEYS = new Set(["context", "calendar", "remote", "occurrence", "item_key", "timezone", "offset"]);
    const PAYLOAD_KEYS = new Set(["title", "date", "deadline", "recurrence", "end", "locationName", "locationAddress", "completion"]);
    const DATE_KEYS = new Set(["kind", "date", "utcInstant", "sourceTimezone", "sourceOffset"]);
    const RECURRENCE_KEYS = new Set(["rule", "seriesHash"]);
    const COMPLETION_KEYS = new Set(["status", "source", "submission", "plannerOverride"]);
    const COMPLETION_DETAIL_KEYS = new Set(["present", "complete"]);
    const SECRET_KEY = /(?:access[_-]?token|refresh[_-]?token|id[_-]?token|oauth(?:2)?[_-]?token|authorization|bearer|password|passwd|secret|credential|api[_-]?key|client[_-]?secret|private|cookie|csrf|session|raw|response|description|details|message|email|html|url)/i;
    const SECRET_VALUE = /(?:bearer\s+|(?:access|refresh|id)[_-]?token\s*[:=]|-----begin\s+(?:private|openpgp)\s+key)/i;
    const URL_VALUE = /(?:https?|ftp):\/\//i;

    function isPlainObject(value) {
        if (!value || typeof value !== "object" || Array.isArray(value)) return false;
        const prototype = Object.getPrototypeOf(value);
        return prototype === Object.prototype || prototype === null;
    }

    function failure(code) {
        const error = new Error(code);
        error.stageCode = code;
        return error;
    }

    function safeText(value, max = MAX_TEXT) {
        return typeof value === "string"
            && value.length > 0
            && value.length <= max
            && !/[\u0000-\u001f\u007f]/.test(value)
            && !SECRET_VALUE.test(value)
            && !URL_VALUE.test(value)
            && SAFE_ID.test(value);
    }

    function safeCount(value) {
        return Number.isSafeInteger(value) && value >= 0 && value <= MAX_COUNT;
    }

    function safeKey(key, { allowTitle = false } = {}) {
        const normalized = String(key).toLowerCase();
        if (allowTitle && normalized === "title") return true;
        return !SECRET_KEY.test(normalized) && normalized !== "title";
    }

    function cloneSafe(value, seen = new Set(), options = {}) {
        if (value === null || typeof value === "boolean") return value;
        if (typeof value === "string") {
            const maxStringLength = options.maxStringLength || MAX_TEXT;
            if (value.length > maxStringLength || /[\u0000-\u001f\u007f]/.test(value) || SECRET_VALUE.test(value) || URL_VALUE.test(value)) throw failure("unsafe_value");
            return value;
        }
        if (typeof value === "number") {
            if (!Number.isFinite(value)) throw failure("unsafe_value");
            return value;
        }
        if (!value || typeof value !== "object" || seen.has(value)) throw failure("unsafe_value");
        if (Array.isArray(value)) {
            seen.add(value);
            const output = value.map((item) => cloneSafe(item, seen, options));
            seen.delete(value);
            return output;
        }
        if (!isPlainObject(value)) throw failure("unsafe_value");
        seen.add(value);
        const output = {};
        for (const key of Object.keys(value).sort()) {
            if (!safeKey(key, options)) throw failure("raw_data_rejected");
            output[key] = cloneSafe(value[key], seen, options);
        }
        seen.delete(value);
        return output;
    }

    function exactKeys(value, allowed, code) {
        if (!isPlainObject(value) || Object.keys(value).some((key) => !allowed.has(key))) throw failure(code);
    }

    function normalizedText(value, max = MAX_TEXT, code = "normalized_item_invalid") {
        if (typeof value !== "string"
            || value.length === 0
            || value.length > max
            || /[\u0000-\u001f\u007f]/.test(value)
            || SECRET_VALUE.test(value)
            || URL_VALUE.test(value)) throw failure(code);
        return value;
    }

    function normalizedDate(value) {
        if (!isPlainObject(value)) throw failure("normalized_item_invalid");
        exactKeys(value, DATE_KEYS, "normalized_item_invalid");
        const output = cloneSafe(value);
        if (output.kind !== undefined) normalizedText(output.kind, 32);
        if (output.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(output.date)) throw failure("normalized_item_invalid");
        if (output.utcInstant !== undefined && !/^\d{4}-\d{2}-\d{2}T[^\s]+Z$/.test(output.utcInstant)) throw failure("normalized_item_invalid");
        if (output.sourceTimezone !== undefined) normalizedText(output.sourceTimezone, 128);
        if (output.sourceOffset !== undefined && output.sourceOffset !== "Z" && !/^[+-]\d{2}:\d{2}$/.test(output.sourceOffset)) throw failure("normalized_item_invalid");
        if (output.date === undefined && output.utcInstant === undefined) throw failure("normalized_item_invalid");
        return output;
    }

    function normalizedCompletion(value) {
        if (typeof value === "string") {
            normalizedText(value, 128);
            if (!/^(?:completed|incomplete|not_applicable)(?:\/(?:none|submission|planner_override|submission\+planner_override))?$/.test(value)) throw failure("normalized_item_invalid");
            return value;
        }
        if (!isPlainObject(value)) throw failure("normalized_item_invalid");
        exactKeys(value, COMPLETION_KEYS, "normalized_item_invalid");
        const output = cloneSafe(value);
        if (output.status !== undefined && !["complete", "incomplete", "not_applicable", "unknown"].includes(output.status)) throw failure("normalized_item_invalid");
        if (output.source !== undefined) normalizedText(output.source, 64);
        for (const key of ["submission", "plannerOverride"]) {
            if (output[key] === undefined) continue;
            if (!isPlainObject(output[key])) throw failure("normalized_item_invalid");
            exactKeys(output[key], COMPLETION_DETAIL_KEYS, "normalized_item_invalid");
            if (typeof output[key].present !== "boolean" || typeof output[key].complete !== "boolean") throw failure("normalized_item_invalid");
        }
        return output;
    }

    function normalizedPayload(value) {
        if (!isPlainObject(value)) throw failure("normalized_item_invalid");
        exactKeys(value, PAYLOAD_KEYS, "normalized_item_invalid");
        const output = cloneSafe(value, new Set(), { allowTitle: true, maxStringLength: MAX_VALIDATION_STRING });
        if (output.title !== undefined) normalizedText(output.title, 1000);
        if (output.date !== undefined) output.date = normalizedDate(output.date);
        if (output.end !== undefined) output.end = normalizedDate(output.end);
        if (output.deadline !== undefined && typeof output.deadline !== "boolean") throw failure("normalized_item_invalid");
        if (output.locationName !== undefined) normalizedText(output.locationName, 1000);
        if (output.locationAddress !== undefined) normalizedText(output.locationAddress, 2000);
        if (output.completion !== undefined) output.completion = normalizedCompletion(output.completion);
        if (output.recurrence !== undefined) {
            if (!isPlainObject(output.recurrence)) throw failure("normalized_item_invalid");
            exactKeys(output.recurrence, RECURRENCE_KEYS, "normalized_item_invalid");
            if (output.recurrence.rule !== undefined) normalizedText(output.recurrence.rule, 512);
            if (output.recurrence.seriesHash !== undefined && !HASH.test(output.recurrence.seriesHash)) throw failure("normalized_item_invalid");
        }
        return output;
    }

    function normalizedItem(value) {
        if (!isPlainObject(value)) throw failure("normalized_item_invalid");
        exactKeys(value, ITEM_KEYS, "normalized_item_invalid");
        const output = cloneSafe(value, new Set(), { allowTitle: true, maxStringLength: MAX_PAYLOAD_BYTES });
        if (output.schemaVersion !== 1) throw failure("normalized_item_invalid");
        if (typeof output.eventRef !== "string" || !/^canvas:[a-f0-9]{64}:[a-f0-9]{64}$/i.test(output.eventRef)) throw failure("normalized_item_invalid");
        if (!isPlainObject(output.source)) throw failure("normalized_item_invalid");
        exactKeys(output.source, SOURCE_KEYS, "normalized_item_invalid");
        if (!TYPES.has(output.source.type)) throw failure("normalized_item_invalid");
        if (!HASH.test(String(output.source.accountKey || "")) || !HASH.test(String(output.source.payloadHash || ""))) throw failure("normalized_item_invalid");
        normalizedText(output.source.revision, 256);
        if (!isPlainObject(output.source.identity)) throw failure("normalized_item_invalid");
        exactKeys(output.source.identity, IDENTITY_KEYS, "normalized_item_invalid");
        for (const valuePart of Object.values(output.source.identity)) normalizedText(String(valuePart), 512);
        output.payload = normalizedPayload(output.payload);
        return output;
    }

    function normalizedCheckpoint(value) {
        if (!isPlainObject(value)) throw failure("checkpoint_invalid");
        return cloneSafe(value, new Set(), { maxStringLength: MAX_VALIDATION_STRING });
    }

    function normalizedBatch(value) {
        if (!isPlainObject(value)) throw failure("batch_invalid");
        exactKeys(value, BATCH_KEYS, "batch_invalid");
        if (!Array.isArray(value.items)) throw failure("batch_invalid");
        if (value.items.length > MAX_ITEMS) throw failure("batch_item_limit");
        if (!Object.prototype.hasOwnProperty.call(value, "checkpoint")) throw failure("checkpoint_invalid");
        const output = cloneSafe(value, new Set(), { allowTitle: true, maxStringLength: MAX_VALIDATION_STRING });
        output.items = value.items.map(normalizedItem);
        output.checkpoint = normalizedCheckpoint(value.checkpoint);
        if (value.payloadHash !== undefined) normalizedText(value.payloadHash, 128);
        return output;
    }

    function normalizedResult(value) {
        if (!isPlainObject(value)) throw failure("result_invalid");
        exactKeys(value, RESULT_KEYS, "result_invalid");
        const output = cloneSafe(value, new Set(), { allowTitle: true, maxStringLength: MAX_VALIDATION_STRING });
        if (!Array.isArray(value.batches)) throw failure("result_invalid");
        if (!safeCount(value.descriptorProgress) || !safeCount(value.quarantineCount) || typeof value.complete !== "boolean") throw failure("result_invalid");
        if (value.checkpointHash !== null && !safeText(value.checkpointHash, 128)) throw failure("result_invalid");
        output.batches = value.batches.map(normalizedBatch);
        return output;
    }

    function namespaceFor(binding) {
        if (!isPlainObject(binding)
            || !safeText(binding.accountKey, 256)
            || !safeText(binding.sourceId, 256)
            || !safeText(binding.runId, 256)
            || !Number.isSafeInteger(binding.generation)
            || binding.generation <= 0) throw failure("invalid_binding");
        return Object.freeze({ account: binding.accountKey, source: binding.sourceId, run: binding.runId, generation: binding.generation });
    }

    function idFactoryFunction(idFactory) {
        if (typeof idFactory === "function") return idFactory;
        if (idFactory && typeof idFactory.create === "function") return idFactory.create.bind(idFactory);
        return null;
    }

    function safeIdempotencyKey(value) {
        if (!safeText(value, 256)) throw failure("idempotency_key_invalid");
        return value;
    }

    function serializedBytes(value) {
        const text = stableStringify(value);
        if (typeof TextEncoder === "function") return new TextEncoder().encode(text).length;
        try { return unescape(encodeURIComponent(text)).length; } catch (error) { return Number.POSITIVE_INFINITY; }
    }

    function stableStringify(value) {
        if (value === null || typeof value !== "object") return JSON.stringify(value);
        if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
    }

    function safeResult(state, values = {}) {
        return {
            state,
            queued: Number.isSafeInteger(values.queued) ? values.queued : 0,
            quarantined: Number.isSafeInteger(values.quarantined) ? values.quarantined : 0,
            descriptorProgress: Number.isSafeInteger(values.descriptorProgress) ? values.descriptorProgress : 0,
            checkpointHash: values.checkpointHash === undefined ? null : values.checkpointHash,
            errorCode: values.errorCode || null
        };
    }

    function capacityError(value) {
        const code = String(value?.stageCode || value?.code || value?.errorCode || value?.state || "").toLowerCase();
        return Boolean(value?.paused || value?.capacity || /capacity|quota|limit|full|paused|size/.test(code));
    }

    function createSyncExtractStage({ outbox, idFactory } = {}) {
        async function queueResult({ enabled, binding, result } = {}) {
            if (enabled !== true) return safeResult("idle");
            let namespace;
            let validated;
            try {
                namespace = namespaceFor(binding);
                validated = normalizedResult(result);
                if (typeof outbox?.currentGeneration !== "function" || typeof outbox?.enqueue !== "function") throw failure("dependency_unavailable");
            } catch (error) {
                return safeResult("error", { errorCode: error.stageCode || "invalid_result" });
            }

            const makeId = idFactoryFunction(idFactory);
            const prepared = [];
            try {
                for (const [index, batch] of validated.batches.entries()) {
                    const idempotencyKey = makeId
                        ? await makeId({ namespace: { ...namespace }, batch: batch, index })
                        : batch.payloadHash;
                    const key = safeIdempotencyKey(idempotencyKey);
                    const enqueuePayload = { namespace: { ...namespace }, batch, idempotencyKey: key };
                    if (serializedBytes(enqueuePayload) > MAX_PAYLOAD_BYTES) throw failure("payload_too_large");
                    prepared.push({ batch, key, enqueuePayload });
                }
            } catch (error) {
                return safeResult("error", {
                    quarantined: validated.quarantineCount,
                    descriptorProgress: validated.descriptorProgress,
                    checkpointHash: validated.checkpointHash,
                    errorCode: error.stageCode || "idempotency_key_invalid"
                });
            }

            let queued = 0;
            const counted = new Set();
            for (const entry of prepared) {
                try {
                    const current = await outbox.currentGeneration(namespace);
                    if (current !== namespace.generation) {
                        return safeResult("superseded", { queued, quarantined: validated.quarantineCount, descriptorProgress: validated.descriptorProgress, checkpointHash: validated.checkpointHash, errorCode: "generation_superseded" });
                    }
                    const response = await outbox.enqueue({ namespace, batch: entry.batch, idempotencyKey: entry.key });
                    if (response?.state === "superseded") {
                        return safeResult("superseded", { queued, quarantined: validated.quarantineCount, descriptorProgress: validated.descriptorProgress, checkpointHash: validated.checkpointHash, errorCode: "generation_superseded" });
                    }
                    if (response?.ok === false) {
                        if (capacityError(response)) return safeResult("paused", { queued, quarantined: validated.quarantineCount, descriptorProgress: validated.descriptorProgress, checkpointHash: validated.checkpointHash, errorCode: "capacity" });
                        return safeResult("error", { queued, quarantined: validated.quarantineCount, descriptorProgress: validated.descriptorProgress, checkpointHash: validated.checkpointHash, errorCode: "enqueue_failed" });
                    }
                    if (!counted.has(entry.key)) {
                        counted.add(entry.key);
                        queued += 1;
                    }
                } catch (error) {
                    if (capacityError(error)) return safeResult("paused", { queued, quarantined: validated.quarantineCount, descriptorProgress: validated.descriptorProgress, checkpointHash: validated.checkpointHash, errorCode: "capacity" });
                    return safeResult("error", { queued, quarantined: validated.quarantineCount, descriptorProgress: validated.descriptorProgress, checkpointHash: validated.checkpointHash, errorCode: "enqueue_failed" });
                }
            }
            return safeResult(queued ? "queued" : "idle", { queued, quarantined: validated.quarantineCount, descriptorProgress: validated.descriptorProgress, checkpointHash: validated.checkpointHash });
        }

        return Object.freeze({ queueResult });
    }

    return Object.freeze({ createSyncExtractStage, MAX_ITEMS, MAX_PAYLOAD_BYTES });
}));
