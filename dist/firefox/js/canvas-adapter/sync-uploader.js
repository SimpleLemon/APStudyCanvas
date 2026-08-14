(function (root, factory) {
    "use strict";

    const api = factory();
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasCanvasAdapter = Object.assign(root.APStudyCanvasCanvasAdapter || {}, { SyncUploader: api });
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
"use strict";

const MAX_ITEMS = 80;
const MAX_RETRY_AFTER_MS = 300000;
const HASH_PATTERN = /^[a-f0-9]{64}$/i;
const SAFE_TEXT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SAFE_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const SECRET_KEY = /(?:access[_-]?token|refresh[_-]?token|id[_-]?token|oauth(?:2)?[_-]?token|authorization|bearer|password|passwd|secret|credential|api[_-]?key|client[_-]?secret|private[_-]?ics|set[-_]?cookie|csrf|cookie|session|lease)/i;
const SECRET_VALUE = /(?:bearer\s+|https?:\/\/[^\s]*\.ics(?:[?#]|$)|(?:access|refresh|id)[_-]?token\s*[:=])/i;

function isPlainObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function pick(value, ...keys) {
    if (!value || typeof value !== "object") return undefined;
    for (const key of keys) if (value[key] !== undefined) return value[key];
    return undefined;
}

function safeText(value) {
    return typeof value === "string" && SAFE_TEXT.test(value) && !SECRET_VALUE.test(value) ? value : null;
}

function safeInteger(value) {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function isHash(value) {
    return typeof value === "string" && HASH_PATTERN.test(value);
}

function stableStringify(value, seen = new Set()) {
    if (value === undefined) return "null";
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (seen.has(value)) return "[cycle]";
    seen.add(value);
    const result = Array.isArray(value)
        ? `[${value.map((item) => stableStringify(item, seen)).join(",")}]`
        : `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key], seen)}`).join(",")}}`;
    seen.delete(value);
    return result;
}

function correlationHash(value) {
    // A short non-secret correlation identifier is sufficient here; it is not
    // used as an integrity or authentication primitive.
    const text = stableStringify(value);
    let first = 2166136261;
    let second = 2654435761;
    for (let index = 0; index < text.length; index += 1) {
        const code = text.charCodeAt(index);
        first = Math.imul(first ^ code, 16777619) >>> 0;
        second = Math.imul(second ^ (code + index), 2246822519) >>> 0;
    }
    return `c-${first.toString(16).padStart(8, "0")}${second.toString(16).padStart(8, "0")}${(first ^ second).toString(16).padStart(8, "0")}`;
}

function now(clock) {
    if (typeof clock === "function") {
        const value = clock();
        if (Number.isFinite(value)) return value;
    }
    if (clock && typeof clock.now === "function") {
        const value = clock.now();
        if (Number.isFinite(value)) return value;
    }
    return Date.now();
}

function boundedDelay(value, clock) {
    if (Number.isFinite(value)) return Math.max(0, Math.min(MAX_RETRY_AFTER_MS, Math.floor(value)));
    if (Number.isFinite(Number(value))) return boundedDelay(Number(value), clock);
    if (typeof value === "string" && value.trim() !== "") {
        const seconds = Number(value);
        if (Number.isFinite(seconds) && seconds >= 0) return boundedDelay(seconds * 1000, clock);
        const date = Date.parse(value);
        if (Number.isFinite(date)) return boundedDelay(date - now(clock), clock);
    }
    return 0;
}

function retryAfter(value, clock) {
    const direct = pick(value, "retryAfterMs", "retry_after_ms");
    if (direct !== undefined) return boundedDelay(direct, clock);
    const seconds = pick(value, "retryAfterSeconds", "retry_after_seconds");
    if (seconds !== undefined) return boundedDelay(Number(seconds) * 1000, clock);
    const headers = pick(value, "headers");
    if (isPlainObject(headers)) {
        const header = Object.entries(headers).find(([key]) => key.toLowerCase() === "retry-after")?.[1];
        if (header !== undefined) return boundedDelay(header, clock);
    }
    return 0;
}

function safeCode(value, fallback) {
    if (typeof value !== "string") return fallback;
    const normalized = value.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
    return SAFE_CODE.test(normalized) && !/(?:token|cookie|secret|password|credential|authorization|bearer|raw|event|url|account|user|lease)/i.test(normalized)
        ? normalized
        : fallback;
}

function errorResult(state, code, details = {}) {
    const result = { state };
    if (code) result.code = code;
    if (details.counts) result.counts = details.counts;
    result.correlation_hash = correlationHash({ state, code: code || null, counts: details.counts || null, marker: details.marker || null });
    return result;
}

function countsFor(batch, receipt) {
    const items = Array.isArray(batch?.items) ? batch.items : Array.isArray(batch?.payload?.items) ? batch.payload.items : [];
    const result = { items: items.length };
    const source = isPlainObject(receipt?.counts) ? receipt.counts : isPlainObject(batch?.counts) ? batch.counts : null;
    if (source) {
        for (const [key, value] of Object.entries(source)) {
            if (/^[a-z][a-z0-9_]{0,31}$/.test(key) && Number.isSafeInteger(value) && value >= 0 && value <= 0x7fffffff) result[key] = value;
        }
    }
    return result;
}

function containsSecret(value, seen = new Set()) {
    if (typeof value === "string") return SECRET_VALUE.test(value);
    if (!value || typeof value !== "object") return false;
    if (seen.has(value)) return true;
    seen.add(value);
    const found = Object.entries(value).some(([key, child]) => SECRET_KEY.test(key) || containsSecret(child, seen));
    seen.delete(value);
    return found;
}

function normalizeBinding(binding) {
    if (!isPlainObject(binding)) return null;
    const account = pick(binding, "account", "accountKey", "account_key");
    const source = pick(binding, "source", "sourceId", "source_id");
    const run = pick(binding, "run", "runId", "run_id");
    const generation = binding.generation;
    if (!safeText(account) || !safeText(source) || !safeText(run) || !safeInteger(generation)) return null;
    for (const [left, right] of [["account", account], ["source", source], ["run", run]]) {
        const aliases = left === "account" ? ["account", "accountKey", "account_key"] : left === "source" ? ["source", "sourceId", "source_id"] : ["run", "runId", "run_id"];
        if (aliases.some((key) => binding[key] !== undefined && binding[key] !== right)) return null;
    }
    return Object.freeze({ account, source, run, generation });
}

function normalizeNamespace(value) {
    if (!isPlainObject(value)) return null;
    const account = pick(value, "account", "accountKey", "account_key");
    const source = pick(value, "source", "sourceId", "source_id");
    const run = pick(value, "run", "runId", "run_id");
    const generation = value.generation;
    if (safeText(account) && safeText(source) && safeText(run) && safeInteger(generation)) return { account, source, run, generation };
    const accountHash = pick(value, "accountHash", "account_hash");
    const sourceHash = pick(value, "sourceHash", "source_hash");
    const runHash = pick(value, "runHash", "run_hash");
    if (!isHash(accountHash) || !isHash(sourceHash) || !isHash(runHash) || !safeInteger(generation)) return null;
    return {
        account_hash: accountHash.toLowerCase(),
        source_hash: sourceHash.toLowerCase(),
        run_hash: runHash.toLowerCase(),
        generation,
        generation_hash: isHash(value.generation_hash) ? value.generation_hash.toLowerCase() : null,
        namespace_hash: isHash(value.namespace_hash) ? value.namespace_hash.toLowerCase() : null
    };
}

function sameNamespace(left, right) {
    const candidate = normalizeNamespace(left);
    if (!candidate || candidate.generation !== right.generation) return false;
    if (candidate.account !== undefined) return candidate.account === right.account && candidate.source === right.source && candidate.run === right.run;
    if (right.account_hash && right.source_hash && right.run_hash) {
        return candidate.account_hash === right.account_hash && candidate.source_hash === right.source_hash && candidate.run_hash === right.run_hash;
    }
    // leaseNext already selected a persisted namespace using the requested
    // namespace. Keep the public batch validation bounded without re-deriving
    // the outbox's private namespace hash here.
    return Boolean(candidate.namespace_hash || candidate.generation_hash);
}

function validLeaseMetadata(value) {
    if (value === undefined) return true;
    if (!isPlainObject(value)) return false;
    const allowed = new Set(["lease_id", "leaseId", "request_hash", "requestHash", "idempotency_hash", "idempotencyHash", "payload_hash", "payloadHash", "generation_hash", "generationHash", "issued_at", "issuedAt", "expires_at", "expiresAt", "attempt"]);
    if (Object.keys(value).some((key) => !allowed.has(key))) return false;
    for (const key of ["lease_id", "leaseId", "request_hash", "requestHash", "idempotency_hash", "idempotencyHash", "payload_hash", "payloadHash", "generation_hash", "generationHash"]) {
        if (value[key] !== undefined && !safeText(value[key])) return false;
    }
    for (const key of ["issued_at", "issuedAt", "expires_at", "expiresAt", "attempt"]) {
        if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || value[key] < 0)) return false;
    }
    return true;
}

function validateBatch(batch, namespace) {
    if (!isPlainObject(batch) || !validLeaseMetadata(batch.lease)) return false;
    const withoutLease = { ...batch };
    delete withoutLease.lease;
    if (containsSecret(withoutLease)) return false;
    if (!sameNamespace(batch.namespace, namespace)) return false;
    const items = Array.isArray(batch.items) ? batch.items : batch.payload?.items;
    if (!Array.isArray(items) || items.length > MAX_ITEMS) return false;
    return true;
}

function batchField(batch, ...keys) {
    return pick(batch, ...keys) ?? pick(batch?.metadata, ...keys);
}

function sanitizeReceipt(receipt, batch, namespace) {
    if (!isPlainObject(receipt)) return { ok: false, code: "malformed" };
    const receiptId = safeText(pick(receipt, "receiptId", "receipt_id", "receipt"));
    if (!receiptId) return { ok: false, code: "malformed" };
    const expectedBatchId = batchField(batch, "batchId", "batch_id", "id");
    const actualBatchId = pick(receipt, "batchId", "batch_id");
    if (actualBatchId !== undefined && (!safeText(actualBatchId) || (expectedBatchId !== undefined && actualBatchId !== expectedBatchId))) return { ok: false, code: expectedBatchId ? "receipt_mismatch" : "malformed" };

    const expectedIdempotency = batchField(batch, "idempotencyKey", "idempotency_key", "idempotencyHash", "idempotency_hash");
    const actualIdempotency = pick(receipt, "idempotencyKey", "idempotency_key", "idempotencyHash", "idempotency_hash");
    if (actualIdempotency !== undefined && (!safeText(actualIdempotency) || (expectedIdempotency !== undefined && actualIdempotency !== expectedIdempotency && !(isHash(actualIdempotency) && isHash(expectedIdempotency) && actualIdempotency.toLowerCase() === expectedIdempotency.toLowerCase())))) return { ok: false, code: expectedIdempotency ? "receipt_mismatch" : "malformed" };

    const expectedPayload = batchField(batch, "payloadHash", "payload_hash");
    const actualPayload = pick(receipt, "payloadHash", "payload_hash");
    if (actualPayload !== undefined && (!safeText(actualPayload) || (expectedPayload !== undefined && actualPayload !== expectedPayload && !(isHash(actualPayload) && isHash(expectedPayload) && actualPayload.toLowerCase() === expectedPayload.toLowerCase())))) return { ok: false, code: expectedPayload ? "receipt_mismatch" : "malformed" };

    const actualGeneration = pick(receipt, "generation");
    if (actualGeneration !== undefined && actualGeneration !== namespace.generation) return { ok: false, code: "receipt_mismatch" };
    const actualGenerationHash = pick(receipt, "generationHash", "generation_hash");
    const expectedGenerationHash = batchField(batch, "generationHash", "generation_hash") || batch.namespace?.generation_hash;
    if (actualGenerationHash !== undefined && (!safeText(actualGenerationHash) || (expectedGenerationHash !== undefined && actualGenerationHash !== expectedGenerationHash && !(isHash(actualGenerationHash) && isHash(expectedGenerationHash) && actualGenerationHash.toLowerCase() === expectedGenerationHash.toLowerCase())))) return { ok: false, code: "receipt_mismatch" };

    const sanitized = { receiptId };
    if (actualBatchId !== undefined) sanitized.batchId = actualBatchId;
    if (actualIdempotency !== undefined) sanitized.idempotencyKey = actualIdempotency;
    if (actualPayload !== undefined) sanitized.payloadHash = actualPayload;
    if (actualGeneration !== undefined) sanitized.generation = actualGeneration;
    if (actualGenerationHash !== undefined) sanitized.generationHash = actualGenerationHash;
    if (actualIdempotency !== undefined) sanitized.idempotencyHash = actualIdempotency;
    if (actualPayload !== undefined) sanitized.payloadHash = actualPayload;
    if (actualGenerationHash !== undefined) sanitized.generationHash = actualGenerationHash;
    if (typeof receipt.accepted === "boolean") sanitized.accepted = receipt.accepted;
    if (isPlainObject(receipt.counts)) sanitized.counts = countsFor(batch, receipt);
    return { ok: true, receipt: sanitized };
}

function classifyFailure(value) {
    const status = Number(value?.status);
    const code = String(value?.code || value?.errorCode || "").toLowerCase();
    if (status === 401 || code.includes("unauthenticated") || code === "401") return { kind: "fail", code: "unauthenticated" };
    if (status === 403 || code.includes("forbidden") || code === "403") return { kind: "fail", code: "forbidden" };
    if (status === 429 || code.includes("rate") || code.includes("throttl")) return { kind: "retry", code: "rate_limited" };
    if (status === 0 || value?.offline === true || /offline|network|econn|timeout/.test(code)) return { kind: "retry", code: "offline" };
    if (value?.retryable === true || status >= 500 || /retry|unavailable|temporary|server/.test(code)) return { kind: "retry", code: safeCode(value?.code, "retryable") };
    return { kind: "fail", code: "malformed" };
}

function attemptsFor(lease, batch) {
    const value = pick(lease, "attempts", "attempt") ?? pick(lease?.lease, "attempts", "attempt") ?? pick(batch, "attempts", "attempt");
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function leaseValue(lease) {
    const nested = pick(lease, "lease");
    if (isPlainObject(nested)) return nested;
    const leaseId = pick(lease, "leaseId", "lease_id");
    return leaseId === undefined ? null : { lease_id: leaseId, ...(pick(lease, "attempt", "attempts") === undefined ? {} : { attempt: pick(lease, "attempt", "attempts") }) };
}

function isEmptyLease(value) {
    return value === null || value === undefined || value.state === "empty" || value.lease === null;
}

function receiptForOutbox(result, batch, lease, namespace) {
    const batchNamespace = isPlainObject(batch?.namespace) ? batch.namespace : {};
    const idempotencyHash = batchField(batch, "idempotencyHash", "idempotency_hash") || result.receipt.idempotencyHash || result.receipt.idempotencyKey;
    const payloadHash = batchField(batch, "payloadHash", "payload_hash") || result.receipt.payloadHash;
    const generationHash = batchField(batch, "generationHash", "generation_hash") || batchNamespace.generation_hash || result.receipt.generationHash;
    const receipt = {
        ...(idempotencyHash === undefined ? {} : { idempotency_hash: idempotencyHash }),
        ...(payloadHash === undefined ? {} : { payload_hash: payloadHash }),
        ...(generationHash === undefined ? {} : { generation_hash: generationHash }),
        ...(result.receipt.accepted === undefined ? {} : { accepted: result.receipt.accepted })
    };
    if (receipt.idempotency_hash === undefined && result.receipt.idempotencyKey !== undefined) receipt.idempotencyKey = result.receipt.idempotencyKey;
    if (receipt.payload_hash === undefined && result.receipt.payloadHash !== undefined) receipt.payloadHash = result.receipt.payloadHash;
    if (receipt.generation_hash === undefined && result.receipt.generation !== undefined) receipt.generation = result.receipt.generation;
    return receipt;
}

function createSyncUploader({ client, outbox, clock } = {}) {
    const retryMethod = outbox?.scheduleRetry || outbox?.retry;

    async function releaseOrRetry(lease, code, delayMs = 0) {
        if (typeof retryMethod === "function") return retryMethod.call(outbox, { lease: leaseValue(lease), delayMs, errorClass: code });
        if (typeof outbox?.release === "function") return outbox.release(pick(lease, "leaseId", "lease_id"), { code });
        if (typeof outbox?.fail === "function") return outbox.fail(pick(lease, "leaseId", "lease_id"), { retryable: false, code });
        throw new Error("dependency_unavailable");
    }

    async function uploadNext({ enabled, binding } = {}) {
        if (enabled !== true) return { state: "idle" };
        const namespace = normalizeBinding(binding);
        if (!namespace) return errorResult("error", "invalid_binding");
        const readGeneration = outbox?.getCurrentGeneration || outbox?.currentGeneration;
        const acquireLease = outbox?.leaseNext || outbox?.acquireBatchLease;
        if (typeof acquireLease !== "function" || typeof readGeneration !== "function" || typeof outbox?.acknowledgeBatch !== "function" || typeof retryMethod !== "function" || typeof client?.uploadBatch !== "function") return errorResult("error", "dependency_unavailable");

        let lease;
        try {
            lease = await acquireLease.call(outbox, namespace);
            if (isEmptyLease(lease)) return { state: "idle" };
            if (lease?.state === "busy" || lease?.state === "paused") return errorResult(lease.state, lease.code || "lease_unavailable");
            const leaseMetadata = leaseValue(lease);
            if (!isPlainObject(lease) || !safeText(pick(leaseMetadata, "leaseId", "lease_id")) || !validateBatch(lease.batch, namespace)) return errorResult("error", "malformed");
            const currentBefore = await readGeneration.call(outbox, namespace);
            if (currentBefore !== namespace.generation) {
                await releaseOrRetry(lease, "conflict", MAX_RETRY_AFTER_MS);
                return errorResult("error", "stale_generation");
            }

            let response;
            try {
                response = await client.uploadBatch(namespace, lease.batch);
            } catch (error) {
                response = error;
            }
            const currentAfter = await readGeneration.call(outbox, namespace);
            if (currentAfter !== namespace.generation) {
                await releaseOrRetry(lease, "conflict", MAX_RETRY_AFTER_MS);
                return errorResult("error", "stale_generation");
            }

            if (!response || Number(response.status) >= 400 || response.ok === false || response.retryable === true || response.offline === true) {
                const failure = classifyFailure(response || {});
                if (failure.kind === "retry") {
                    const retryResult = await retryMethod.call(outbox, { lease: leaseValue(lease), delayMs: retryAfter(response, clock), errorClass: failure.code });
                    const exhausted = retryResult?.exhausted === true || retryResult?.paused === true || retryResult?.state === "exhausted" || retryResult?.state === "paused" || attemptsFor(lease, lease.batch) >= 8;
                    if (exhausted) {
                        return errorResult("paused", "retry_exhausted", { counts: countsFor(lease.batch, null), marker: failure.code });
                    }
                    return errorResult("queued", failure.code, { counts: countsFor(lease.batch, null), marker: failure.code });
                }
                await releaseOrRetry(lease, "validation", MAX_RETRY_AFTER_MS);
                return errorResult("error", failure.code, { counts: countsFor(lease.batch, null), marker: failure.code });
            }

            const receiptResult = sanitizeReceipt(response, lease.batch, namespace);
            if (!receiptResult.ok) {
                await releaseOrRetry(lease, "validation", MAX_RETRY_AFTER_MS);
                return errorResult("error", receiptResult.code, { counts: countsFor(lease.batch, null), marker: receiptResult.code });
            }
            await outbox.acknowledgeBatch({ lease: leaseValue(lease), receipt: receiptForOutbox(receiptResult, lease.batch, lease, namespace) });
            return errorResult("queued", null, { counts: countsFor(lease.batch, response), marker: "uploaded" });
        } catch (error) {
            const failure = classifyFailure(error);
            return errorResult("error", failure.code, { marker: "dependency" });
        }
    }

    return Object.freeze({ uploadNext });
}

    return Object.freeze({ createSyncUploader });
}));
