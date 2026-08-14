(function (root, factory) {
    "use strict";

    const security = root?.APStudyCanvasPlatform?.Security || (typeof require === "function" ? require("./security.js") : null);
    const api = factory(security);
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasPlatform = Object.assign(root.APStudyCanvasPlatform || {}, { IndexedDb: api });
}(typeof globalThis !== "undefined" ? globalThis : this, function (security) {
    "use strict";

    const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
    const DEFAULT_MAX_RECORDS = 10000;
    const DEFAULT_DB_NAME = "apstudycanvas-platform-v1";
    const DEFAULT_STORE_NAME = "bounded_queue";
    const PENDING_LIMIT_REASON = Object.freeze({ code: "IDB_PENDING_LIMIT", message: "Pending batches reached the local capacity limit." });
    const QUOTA_REASON = Object.freeze({ code: "IDB_QUOTA_EXCEEDED", message: "Browser storage quota was exceeded." });

    function byteLength(value) {
        const serialized = JSON.stringify(value);
        if (typeof TextEncoder === "function") return new TextEncoder().encode(serialized).length;
        return unescape(encodeURIComponent(serialized)).length;
    }

    function clone(value) {
        if (value === undefined) return undefined;
        if (typeof structuredClone === "function") return structuredClone(value);
        return JSON.parse(JSON.stringify(value));
    }

    function assertRecordSafe(key, value) {
        if (typeof key !== "string" || !key || key.length > 256 || security.isSensitiveKey(key)) throw new Error("IDB_RECORD_KEY_INVALID");
        if (!security.isJsonSerializable(value)) throw new Error("IDB_RECORD_NOT_SERIALIZABLE");
        if (security.findSensitiveData(value, key)) throw new Error("IDB_SECRET_STORAGE_FORBIDDEN");
        return true;
    }

    function isQuotaExceededError(error) {
        return error?.name === "QuotaExceededError" || error?.code === 22 || error?.code === 1014;
    }

    function normalizeRecord(record) {
        return {
            key: record.key,
            value: record.value,
            bytes: Number(record.bytes || byteLength(record.value)),
            state: record.state === "acknowledged" ? "acknowledged" : "pending",
            createdAt: Number.isFinite(record.createdAt) ? record.createdAt : 0
        };
    }

    function totals(records) {
        return {
            count: records.length,
            bytes: records.reduce((sum, record) => sum + normalizeRecord(record).bytes, 0),
            pending: records.filter((record) => normalizeRecord(record).state === "pending").length,
            acknowledged: records.filter((record) => normalizeRecord(record).state === "acknowledged").length
        };
    }

    const fallbackMutexes = new WeakMap();

    async function withMutex(target, operation) {
        let mutex = fallbackMutexes.get(target);
        if (!mutex) {
            mutex = Promise.resolve();
            fallbackMutexes.set(target, mutex);
        }
        let release;
        const next = new Promise((resolve) => { release = resolve; });
        fallbackMutexes.set(target, mutex.then(() => next));
        await mutex;
        try { return await operation(); } finally { release(); }
    }

    function createBoundedStore({ backend, maxBytes, maxRecords, now }) {
        let pauseReason = null;
        let blockedWrite = null;

        async function records() {
            return (await backend.list()).map(normalizeRecord);
        }

        async function status() {
            const current = totals(await records());
            return Object.assign(current, {
                maxBytes,
                maxRecords,
                paused: Boolean(pauseReason),
                pauseReason: pauseReason ? clone(pauseReason) : null
            });
        }

        async function atomicMutate(mutator, { bypassPause = false } = {}) {
            if (pauseReason && !bypassPause) return { ok: false, code: pauseReason.code, paused: true, reason: clone(pauseReason), status: await status() };
            if (typeof backend.atomicMutate === "function") {
                return backend.atomicMutate((current) => {
                    const plan = mutator(current.map(normalizeRecord));
                    if (plan && typeof plan.then === "function") throw new Error("IDB_ATOMIC_MUTATOR_MUST_BE_SYNC");
                    if (!plan) return { result: undefined };
                    return {
                        result: plan.result,
                        deletes: Array.isArray(plan.deletes) ? plan.deletes : [],
                        puts: Array.isArray(plan.puts) ? plan.puts.map(normalizeRecord) : []
                    };
                });
            }
            // Keep custom/legacy backends safe for concurrent callers in this
            // worker. The built-in IndexedDB and memory backends implement a
            // stronger transactional primitive below.
            return withMutex(backend, async () => {
                const before = await backend.list();
                const plan = await mutator(before.map(normalizeRecord));
                if (!plan) return { result: undefined };
                const deletes = Array.isArray(plan.deletes) ? plan.deletes : [];
                const puts = Array.isArray(plan.puts) ? plan.puts.map(normalizeRecord) : [];
                try {
                    for (const key of deletes) await backend.delete(key);
                    for (const record of puts) await backend.put(record);
                } catch (caught) {
                    try {
                        const after = await backend.list();
                        for (const record of after) await backend.delete(record.key);
                        for (const record of before) await backend.put(record);
                    } catch (rollbackError) {
                        // Preserve the original storage error.
                    }
                    throw caught;
                }
                return { result: plan.result };
            });
        }

        async function evictAcknowledgedFor(incomingBytes, incomingCount, { forceOne = false, excludeKey = null } = {}) {
            const current = await records();
            const acknowledged = current
                .filter((record) => record.state === "acknowledged" && record.key !== excludeKey)
                .sort((left, right) => left.createdAt - right.createdAt || left.key.localeCompare(right.key));
            let currentTotals = totals(current);
            const evictedKeys = [];
            for (const record of acknowledged) {
                const needsCapacity = currentTotals.bytes + incomingBytes > maxBytes || currentTotals.count + incomingCount > maxRecords;
                if (!needsCapacity && !(forceOne && evictedKeys.length === 0)) break;
                evictedKeys.push(record.key);
                currentTotals.bytes -= record.bytes;
                currentTotals.count -= 1;
                currentTotals.acknowledged -= 1;
            }
            if (evictedKeys.length) await atomicMutate(() => ({ deletes: evictedKeys }));
            return { evicted: evictedKeys.length, totals: currentTotals };
        }

        async function pause(reason, pendingWrite) {
            pauseReason = clone(reason);
            blockedWrite = pendingWrite ? clone(pendingWrite) : null;
            return { ok: false, code: reason.code, paused: true, reason: clone(reason), status: await status() };
        }

        async function putRecord(key, value, options = {}, { bypassPause = false, forceEviction = false } = {}) {
            assertRecordSafe(key, value);
            if (pauseReason && !bypassPause) return { ok: false, code: pauseReason.code, paused: true, reason: clone(pauseReason), status: await status() };
            const state = options.state === "acknowledged" ? "acknowledged" : "pending";
            const createdAt = Number.isFinite(options.createdAt) ? options.createdAt : now();
            const nextBytes = byteLength(value);
            const pendingWrite = { key, value: clone(value), options: { state, createdAt } };
            // Reject impossible writes before planning any eviction.
            if (nextBytes > maxBytes || maxRecords < 1) return pause(PENDING_LIMIT_REASON, pendingWrite);
            try {
                const transaction = await atomicMutate((current) => {
                    const previous = current.find((record) => record.key === key);
                    const incomingBytes = nextBytes - (previous?.bytes || 0);
                    const incomingCount = previous ? 0 : 1;
                    const currentTotals = totals(current);
                    const acknowledged = current
                        .filter((record) => record.state === "acknowledged" && record.key !== key)
                        .sort((left, right) => left.createdAt - right.createdAt || left.key.localeCompare(right.key));
                    const evicted = [];
                    let bytes = currentTotals.bytes;
                    let count = currentTotals.count;
                    for (const record of acknowledged) {
                        if (bytes + incomingBytes <= maxBytes && count + incomingCount <= maxRecords && !(forceEviction && evicted.length === 0)) break;
                        evicted.push(record.key);
                        bytes -= record.bytes;
                        count -= 1;
                    }
                    if (bytes + incomingBytes > maxBytes || count + incomingCount > maxRecords) {
                        return { result: { kind: "pending_limit" } };
                    }
                    return {
                        deletes: evicted,
                        puts: [{ key, value: clone(value), bytes: nextBytes, state, createdAt }],
                        result: { kind: "stored" }
                    };
                }, { bypassPause });
                if (transaction?.ok === false) return transaction;
                if (transaction?.result?.kind === "pending_limit") return pause(PENDING_LIMIT_REASON, pendingWrite);
            } catch (error) {
                if (isQuotaExceededError(error)) return pause(QUOTA_REASON, pendingWrite);
                throw error;
            }
            return { ok: true, status: await status() };
        }

        async function put(key, value, options = {}) {
            return putRecord(key, value, options);
        }

        // Recovery/acknowledgement metadata sometimes has to be written after
        // a pending-limit pause has been raised. This still applies the same
        // capacity calculation and never permits pending records to be
        // evicted; it only bypasses the latched pause gate for this one write.
        async function putBypassPause(key, value, options = {}) {
            return putRecord(key, value, options, { bypassPause: true });
        }

        async function acknowledge(key) {
            try {
                const transaction = await atomicMutate((current) => {
                    const record = current.find((candidate) => candidate.key === key);
                    if (!record) return { result: { kind: "missing" } };
                    if (record.state === "acknowledged") return { result: { kind: "stored" } };
                    return { puts: [{ ...record, state: "acknowledged" }], result: { kind: "stored" } };
                }, { bypassPause: true });
                if (transaction?.result?.kind === "missing") return { ok: false, code: "IDB_RECORD_NOT_FOUND", status: await status() };
            } catch (error) {
                if (isQuotaExceededError(error)) return pause(QUOTA_REASON, blockedWrite);
                throw error;
            }
            return { ok: true, status: await status() };
        }

        async function resume() {
            if (!pauseReason) return status();
            const pending = blockedWrite;
            if (pauseReason.code === QUOTA_REASON.code) {
                const current = await records();
                if (!current.some((record) => record.state === "acknowledged" && record.key !== pending?.key)) return status();
            }
            if (pending?.key && pending.value) {
                const retried = await putRecord(pending.key, pending.value, pending.options || {}, { bypassPause: true, forceEviction: pauseReason.code === QUOTA_REASON.code });
                if (retried?.ok) {
                    pauseReason = null;
                    blockedWrite = null;
                }
            }
            return status();
        }

        return Object.freeze({
            async init() { return status(); },
            status,
            atomicMutate,
            async get(key) { return clone((await records()).find((record) => record.key === key)?.value); },
            async list() { return (await records()).map((record) => clone(record)); },
            put,
            putBypassPause,
            acknowledge,
            async delete(key) {
                await atomicMutate(() => ({ deletes: [key] }), { bypassPause: true });
                return { ok: true, status: await status() };
            },
            async clear() {
                const current = await backend.list();
                if (typeof backend.atomicMutate === "function") await backend.atomicMutate(() => ({ deletes: current.map((record) => record.key) }));
                else await backend.clear();
                pauseReason = null;
                blockedWrite = null;
                return { ok: true, status: await status() };
            },
            resume
        });
    }

    function createMemoryBackend(initial = [], { failQuotaWrites = 0 } = {}) {
        const map = new Map(initial.map((record) => [record.key, clone(record)]));
        let remainingQuotaFailures = failQuotaWrites;
        return {
            async list() { return Array.from(map.values(), clone); },
            async put(record) {
                if (remainingQuotaFailures > 0) {
                    remainingQuotaFailures -= 1;
                    const error = new Error("sensitive browser quota details");
                    error.name = "QuotaExceededError";
                    throw error;
                }
                map.set(record.key, clone(record));
            },
            async delete(key) { map.delete(key); },
            async clear() { map.clear(); },
            async atomicMutate(mutator) {
                return withMutex(map, async () => {
                    const before = new Map(Array.from(map.entries(), ([key, value]) => [key, clone(value)]));
                    try {
                        const plan = mutator(Array.from(map.values(), clone));
                        if (plan && typeof plan.then === "function") throw new Error("IDB_ATOMIC_MUTATOR_MUST_BE_SYNC");
                        if (!plan) return { result: undefined };
                        for (const key of (plan.deletes || [])) map.delete(key);
                        for (const record of (plan.puts || [])) {
                            if (remainingQuotaFailures > 0) {
                                remainingQuotaFailures -= 1;
                                const error = new Error("sensitive browser quota details");
                                error.name = "QuotaExceededError";
                                throw error;
                            }
                            map.set(record.key, clone(record));
                        }
                        return { result: plan.result };
                    } catch (caught) {
                        map.clear();
                        for (const [key, value] of before) map.set(key, value);
                        throw caught;
                    }
                });
            }
        };
    }

    function createMemoryBoundedStore({ maxBytes = DEFAULT_MAX_BYTES, maxRecords = DEFAULT_MAX_RECORDS, now = () => Date.now(), backend } = {}) {
        return createBoundedStore({ backend: backend || createMemoryBackend(), maxBytes, maxRecords, now });
    }

    function createIndexedDbBackend({ indexedDB, dbName, storeName }) {
        let databasePromise;

        function open() {
            if (!indexedDB || typeof indexedDB.open !== "function") return Promise.reject(new Error("IDB_UNAVAILABLE"));
            if (databasePromise) return databasePromise;
            databasePromise = new Promise((resolve, reject) => {
                const request = indexedDB.open(dbName, 1);
                request.onerror = () => reject(request.error || new Error("IDB_OPEN_FAILED"));
                request.onupgradeneeded = () => {
                    if (!request.result.objectStoreNames.contains(storeName)) request.result.createObjectStore(storeName, { keyPath: "key" });
                };
                request.onsuccess = () => resolve(request.result);
            });
            return databasePromise;
        }

        async function operation(mode, action) {
            const database = await open();
            return new Promise((resolve, reject) => {
                const transaction = database.transaction(storeName, mode);
                const request = action(transaction.objectStore(storeName));
                request.onerror = () => reject(request.error || new Error("IDB_OPERATION_FAILED"));
                request.onsuccess = () => resolve(request.result);
            });
        }

        async function atomicMutate(mutator) {
            const database = await open();
            return new Promise((resolve, reject) => {
                const transaction = database.transaction(storeName, "readwrite");
                const objectStore = transaction.objectStore(storeName);
                let result;
                let settled = false;
                const fail = (error) => {
                    if (settled) return;
                    settled = true;
                    reject(error || new Error("IDB_OPERATION_FAILED"));
                };
                transaction.onerror = () => fail(transaction.error || new Error("IDB_OPERATION_FAILED"));
                transaction.onabort = () => fail(transaction.error || new Error("IDB_OPERATION_ABORTED"));
                transaction.oncomplete = () => {
                    if (!settled) {
                        settled = true;
                        resolve({ result });
                    }
                };
                const read = objectStore.getAll();
                read.onerror = () => {
                    try { transaction.abort(); } catch (abortError) { fail(read.error || abortError); }
                };
                read.onsuccess = () => {
                    try {
                        const plan = mutator(read.result || []);
                        if (plan && typeof plan.then === "function") throw new Error("IDB_ATOMIC_MUTATOR_MUST_BE_SYNC");
                        if (!plan) return;
                        for (const key of (plan.deletes || [])) objectStore.delete(key);
                        for (const record of (plan.puts || [])) objectStore.put(record);
                        result = plan.result;
                    } catch (caught) {
                        try { transaction.abort(); } catch (abortError) { fail(caught); }
                    }
                };
            });
        }

        return {
            list: () => operation("readonly", (store) => store.getAll()).then((items) => items || []),
            put: (record) => operation("readwrite", (store) => store.put(record)),
            delete: (key) => operation("readwrite", (store) => store.delete(key)),
            clear: () => operation("readwrite", (store) => store.clear()),
            atomicMutate
        };
    }

    function createIndexedDbStore({
        indexedDB = globalThis.indexedDB,
        dbName = DEFAULT_DB_NAME,
        storeName = DEFAULT_STORE_NAME,
        maxBytes = DEFAULT_MAX_BYTES,
        maxRecords = DEFAULT_MAX_RECORDS,
        now = () => Date.now(),
        backend
    } = {}) {
        const selectedBackend = backend || createIndexedDbBackend({ indexedDB, dbName, storeName });
        return createBoundedStore({ backend: selectedBackend, maxBytes, maxRecords, now });
    }

    return Object.freeze({
        DEFAULT_MAX_BYTES,
        DEFAULT_MAX_RECORDS,
        DEFAULT_DB_NAME,
        DEFAULT_STORE_NAME,
        PENDING_LIMIT_REASON,
        QUOTA_REASON,
        assertRecordSafe,
        isQuotaExceededError,
        createMemoryBackend,
        createMemoryBoundedStore,
        createIndexedDbStore
    });
}));
