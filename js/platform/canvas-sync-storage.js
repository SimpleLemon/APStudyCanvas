(function (root, factory) {
    "use strict";

    const api = factory();
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasPlatform = Object.assign(root.APStudyCanvasPlatform || {}, { CanvasSyncStorage: api });
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const VERSION = 1;
    const MAX_IDENTIFIER_LENGTH = 128;
    const MAX_TOKEN_LENGTH = 512;
    const MAX_SUMMARY_BYTES = 64 * 1024;
    const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
    const HASH = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
    const ACCOUNT_KEY = /^[a-f0-9]{64}$/;
    const SENSITIVE_KEY = /token|lease|cookie|csrf|proof|password|secret/i;

    function isPlainObject(value) {
        if (!value || typeof value !== "object" || Array.isArray(value)) return false;
        const prototype = Object.getPrototypeOf(value);
        return prototype === Object.prototype || prototype === null;
    }

    function clone(value) {
        if (value === undefined) return undefined;
        if (typeof structuredClone === "function") return structuredClone(value);
        return JSON.parse(JSON.stringify(value));
    }

    function jsonBytes(value) {
        const serialized = JSON.stringify(value);
        if (typeof serialized !== "string") return Number.POSITIVE_INFINITY;
        if (typeof TextEncoder === "function") return new TextEncoder().encode(serialized).length;
        return unescape(encodeURIComponent(serialized)).length;
    }

    function safeIdentifier(value) {
        return typeof value === "string"
            && value.length > 0
            && value.length <= MAX_IDENTIFIER_LENGTH
            && value === value.trim()
            && IDENTIFIER.test(value);
    }

    function safeHash(value) {
        return typeof value === "string" && value.length > 0 && value.length <= MAX_IDENTIFIER_LENGTH && HASH.test(value);
    }

    function bindingOf(value) {
        if (!isPlainObject(value) || !safeIdentifier(value.sourceId) || !safeIdentifier(value.runId)
            || !Number.isSafeInteger(value.generation) || value.generation <= 0) {
            throw new Error("STORAGE_BINDING_INVALID");
        }
        const accountKey = value.accountKey ?? value.account_key;
        if (accountKey !== undefined && !ACCOUNT_KEY.test(accountKey)) throw new Error("STORAGE_ACCOUNT_KEY_INVALID");
        return Object.freeze({ sourceId: value.sourceId, runId: value.runId, generation: value.generation, ...(accountKey === undefined ? {} : { accountKey }) });
    }

    function canonicalBinding(binding) {
        return JSON.stringify({ generation: binding.generation, runId: binding.runId, sourceId: binding.sourceId });
    }

    function hashed(hashKey, value) {
        let result;
        try { result = hashKey(value); } catch (error) { throw new Error("STORAGE_HASH_INVALID"); }
        if (!safeHash(result)) throw new Error("STORAGE_HASH_INVALID");
        return result;
    }

    function bindingKey(hashKey, prefix, binding) {
        return `${prefix}:${hashed(hashKey, canonicalBinding(binding))}`;
    }

    function bindingHash(hashKey, value) {
        return hashed(hashKey, value);
    }

    function summaryReference(hashKey, binding) {
        // The reference is deliberately derived from the canonical binding but
        // contains only the hash output. The approved safe summary remains the
        // value stored behind this opaque reference.
        return bindingHash(hashKey, canonicalBinding(binding));
    }

    function summaryKey(summaryRef) {
        return `aps-sync-summary:${summaryRef}`;
    }

    function accountIndexKey(hashKey, prefix, accountKey) {
        return `${prefix}:${hashed(hashKey, `account:${accountKey}`)}`;
    }

    function visitSafe(value, seen = new Set()) {
        if (value === null || typeof value !== "object") return;
        if (seen.has(value)) throw new Error("STORAGE_SUMMARY_CORRUPT");
        seen.add(value);
        if (!Array.isArray(value) && !isPlainObject(value)) throw new Error("STORAGE_SUMMARY_CORRUPT");
        if (!Array.isArray(value)) {
            for (const [key, child] of Object.entries(value)) {
                if (SENSITIVE_KEY.test(key)) throw new Error("STORAGE_SUMMARY_SECRET_FORBIDDEN");
                visitSafe(child, seen);
            }
        } else {
            value.forEach((child) => visitSafe(child, seen));
        }
        seen.delete(value);
    }

    function validToken(value) {
        return typeof value === "string" && value.length > 0 && value.length <= MAX_TOKEN_LENGTH;
    }

    function exactSummaryBinding(summary, binding) {
        const candidate = summary?.binding;
        if (!isPlainObject(candidate)) return true;
        const sourceId = candidate.source_id ?? candidate.sourceId;
        const runId = candidate.run_id ?? candidate.runId;
        const generation = candidate.generation;
        if (sourceId === undefined && runId === undefined && generation === undefined) return true;
        return sourceId === binding.sourceId && runId === binding.runId && generation === binding.generation;
    }

    function areaAvailable(area) {
        return area && typeof area.get === "function" && typeof area.set === "function" && typeof area.remove === "function";
    }

    function createCanvasSyncStorage({ storage, stateApi, hashKey } = {}) {
        if (!areaAvailable(storage?.session) || !areaAvailable(storage?.local)) throw new Error("STORAGE_SESSION_UNAVAILABLE");
        if (!stateApi || typeof stateApi.toSafeSummary !== "function" || typeof stateApi.restoreSafeSummary !== "function") {
            throw new Error("STORAGE_STATE_API_UNAVAILABLE");
        }
        if (typeof hashKey !== "function") throw new Error("STORAGE_HASH_KEY_UNAVAILABLE");

        const session = storage.session;
        const local = storage.local;

        async function readIndex(area, key) {
            const value = (await area.get(key))?.[key];
            return Array.isArray(value) ? value.filter((item) => safeHash(item)) : [];
        }

        async function updateIndex(area, key, ref, add) {
            if (!ref) return;
            const current = await readIndex(area, key);
            const next = add ? Array.from(new Set([...current, ref])) : current.filter((item) => item !== ref);
            if (next.length) await area.set({ [key]: next.slice(0, 256) });
            else await area.remove(key);
        }

        function accountKeyFor(value) {
            const accountKey = value?.accountKey ?? value?.account_key;
            return ACCOUNT_KEY.test(accountKey || "") ? accountKey : null;
        }

        const leaseStore = Object.freeze({
            async set(input, leaseToken) {
                const binding = bindingOf(input);
                if (!validToken(leaseToken)) throw new Error("STORAGE_LEASE_TOKEN_INVALID");
                const key = bindingKey(hashKey, "aps-sync-lease", binding);
                const value = {
                    v: VERSION,
                    sourceIdHash: bindingHash(hashKey, binding.sourceId),
                    runIdHash: bindingHash(hashKey, binding.runId),
                    generation: binding.generation,
                    leaseToken
                };
                await session.set({ [key]: value });
                const accountKey = accountKeyFor(input);
                if (accountKey) await updateIndex(session, accountIndexKey(hashKey, "aps-sync-leases", accountKey), key, true);
            },
            async get(input) {
                const binding = bindingOf(input);
                const key = bindingKey(hashKey, "aps-sync-lease", binding);
                try {
                    const result = await session.get(key);
                    const value = result?.[key];
                    if (!isPlainObject(value) || value.v !== VERSION || value.generation !== binding.generation
                        || value.sourceIdHash !== bindingHash(hashKey, binding.sourceId)
                        || value.runIdHash !== bindingHash(hashKey, binding.runId)
                        || !validToken(value.leaseToken)) return null;
                    return value.leaseToken;
                } catch (error) {
                    return null;
                }
            },
            async remove(input) {
                const binding = bindingOf(input);
                const leaseKey = bindingKey(hashKey, "aps-sync-lease", binding);
                await session.remove(leaseKey);
                const accountKey = accountKeyFor(input);
                if (accountKey) await updateIndex(session, accountIndexKey(hashKey, "aps-sync-leases", accountKey), leaseKey, false);
            },
            async removeAccount(accountKey) {
                if (!ACCOUNT_KEY.test(accountKey || "")) throw new Error("STORAGE_ACCOUNT_KEY_INVALID");
                const indexKey = accountIndexKey(hashKey, "aps-sync-leases", accountKey);
                const keys = await readIndex(session, indexKey);
                if (keys.length) await session.remove(keys);
                await session.remove(indexKey);
            }
        });

        async function restoredRun(summary) {
            const restored = await stateApi.restoreSafeSummary(clone(summary));
            if (!restored || restored.ok === false) return null;
            return restored.ok === true ? restored.state || restored.run || null : restored;
        }

        async function safeSummaryFor(input, candidate) {
            let summary = await stateApi.toSafeSummary(candidate);
            if (!isPlainObject(summary)) {
                const restored = await restoredRun(candidate);
                if (!restored) throw new Error("STORAGE_SUMMARY_CORRUPT");
                summary = await stateApi.toSafeSummary(restored);
            }
            if (!isPlainObject(summary)) throw new Error("STORAGE_SUMMARY_CORRUPT");
            visitSafe(summary);
            if (jsonBytes(summary) > MAX_SUMMARY_BYTES) throw new Error("STORAGE_SUMMARY_TOO_LARGE");
            if (!exactSummaryBinding(summary, input)) throw new Error("STORAGE_SUMMARY_BINDING_MISMATCH");
            return summary;
        }

        async function readByRef(summaryRef) {
            if (!safeHash(summaryRef)) return null;
            const key = summaryKey(summaryRef);
            try {
                const result = await local.get(key);
                const record = result?.[key];
                if (!isPlainObject(record) || record.v !== VERSION
                    || (record.summaryRef !== undefined && record.summaryRef !== summaryRef)
                    || !isPlainObject(record.summary)) return null;
                visitSafe(record.summary);
                if (jsonBytes(record.summary) > MAX_SUMMARY_BYTES) return null;
                const run = await restoredRun(record.summary);
                return run ? { summary: record.summary, run } : null;
            } catch (error) {
                return null;
            }
        }

        const summaryStore = Object.freeze({
            async set(input, run) {
                let binding = input;
                let candidate = run;
                if (candidate === undefined) {
                    const restored = await restoredRun(input);
                    if (!restored || !isPlainObject(restored.binding)) throw new Error("STORAGE_SUMMARY_CORRUPT");
                    binding = restored.binding;
                    candidate = restored;
                }
                binding = bindingOf(binding);
                const summary = await safeSummaryFor(binding, candidate);
                const summaryRef = summaryReference(hashKey, binding);
                await local.set({ [summaryKey(summaryRef)]: { v: VERSION, summaryRef, summary: clone(summary) } });
                const accountKey = accountKeyFor(binding);
                if (accountKey) await updateIndex(local, accountIndexKey(hashKey, "aps-sync-summaries", accountKey), summaryKey(summaryRef), true);
                return summaryRef;
            },
            async get(input) {
                const binding = bindingOf(input);
                const summaryRef = summaryReference(hashKey, binding);
                const record = await readByRef(summaryRef);
                if (!record || !exactSummaryBinding(record.summary, binding)) return null;
                return record.run;
            },
            async getByRef(summaryRef) {
                const record = await readByRef(summaryRef);
                return record?.run || null;
            },
            async getRef(input) {
                const binding = bindingOf(input);
                const summaryRef = summaryReference(hashKey, binding);
                return (await readByRef(summaryRef)) ? summaryRef : null;
            },
            async remove(input) {
                const binding = bindingOf(input);
                const key = summaryKey(summaryReference(hashKey, binding));
                await local.remove(key);
                const accountKey = accountKeyFor(binding);
                if (accountKey) await updateIndex(local, accountIndexKey(hashKey, "aps-sync-summaries", accountKey), key, false);
            },
            async removeAccount(accountKey) {
                if (!ACCOUNT_KEY.test(accountKey || "")) throw new Error("STORAGE_ACCOUNT_KEY_INVALID");
                const indexKey = accountIndexKey(hashKey, "aps-sync-summaries", accountKey);
                const keys = await readIndex(local, indexKey);
                if (keys.length) await local.remove(keys);
                await local.remove(indexKey);
            }
        });

        const runIndex = Object.freeze({
            async set(hashRef, summaryRef, bindingOrAccount) {
                if (!safeHash(hashRef) || !safeHash(summaryRef)) throw new Error("STORAGE_INDEX_REF_INVALID");
                await local.set({ [`aps-sync-index:${hashRef}`]: summaryRef });
                const accountKey = accountKeyFor(bindingOrAccount);
                if (accountKey) await updateIndex(local, accountIndexKey(hashKey, "aps-sync-runs", accountKey), hashRef, true);
            },
            async get(hashRef) {
                if (!safeHash(hashRef)) throw new Error("STORAGE_INDEX_REF_INVALID");
                try {
                    const key = `aps-sync-index:${hashRef}`;
                    const result = await local.get(key);
                    return safeHash(result?.[key]) ? result[key] : null;
                } catch (error) {
                    return null;
                }
            },
            async remove(hashRef, bindingOrAccount) {
                if (!safeHash(hashRef)) throw new Error("STORAGE_INDEX_REF_INVALID");
                await local.remove(`aps-sync-index:${hashRef}`);
                const accountKey = accountKeyFor(bindingOrAccount);
                if (accountKey) await updateIndex(local, accountIndexKey(hashKey, "aps-sync-runs", accountKey), hashRef, false);
            },
            async removeAccount(accountKey) {
                if (!ACCOUNT_KEY.test(accountKey || "")) throw new Error("STORAGE_ACCOUNT_KEY_INVALID");
                const indexKey = accountIndexKey(hashKey, "aps-sync-runs", accountKey);
                const refs = await readIndex(local, indexKey);
                if (refs.length) await local.remove(refs.map((ref) => `aps-sync-index:${ref}`));
                await local.remove(indexKey);
            }
        });

        async function publicSnapshot({ binding, hashRef } = {}) {
            const [lease, summary, index] = await Promise.all([
                binding ? leaseStore.get(binding) : null,
                binding ? summaryStore.get(binding) : null,
                hashRef ? runIndex.get(hashRef) : null
            ]);
            return Object.freeze({ hasLease: lease !== null, hasSummary: summary !== null, hasIndex: index !== null, indexCount: 0 });
        }

        const accountAlarmIndex = Object.freeze({
            async get(accountKey) {
                if (!ACCOUNT_KEY.test(accountKey || "")) throw new Error("STORAGE_ACCOUNT_KEY_INVALID");
                return readIndex(local, accountIndexKey(hashKey, "aps-sync-alarms", accountKey));
            },
            async add(accountKey, ref) {
                if (!ACCOUNT_KEY.test(accountKey || "")) throw new Error("STORAGE_ACCOUNT_KEY_INVALID");
                await updateIndex(local, accountIndexKey(hashKey, "aps-sync-alarms", accountKey), ref, true);
            },
            async remove(accountKey, ref) {
                if (!ACCOUNT_KEY.test(accountKey || "")) throw new Error("STORAGE_ACCOUNT_KEY_INVALID");
                await updateIndex(local, accountIndexKey(hashKey, "aps-sync-alarms", accountKey), ref, false);
            },
            async clear(accountKey) {
                if (!ACCOUNT_KEY.test(accountKey || "")) throw new Error("STORAGE_ACCOUNT_KEY_INVALID");
                await local.remove(accountIndexKey(hashKey, "aps-sync-alarms", accountKey));
            },
            async revoke(accountKey) {
                if (!ACCOUNT_KEY.test(accountKey || "")) throw new Error("STORAGE_ACCOUNT_KEY_INVALID");
                await local.set({ [accountIndexKey(hashKey, "aps-sync-alarm-revoked", accountKey)]: true });
            },
            async isRevoked(accountKey) {
                if (!ACCOUNT_KEY.test(accountKey || "")) throw new Error("STORAGE_ACCOUNT_KEY_INVALID");
                const key = accountIndexKey(hashKey, "aps-sync-alarm-revoked", accountKey);
                return (await local.get(key))?.[key] === true;
            },
            async revokeAccount(accountKey) {
                if (!ACCOUNT_KEY.test(accountKey || "")) throw new Error("STORAGE_ACCOUNT_KEY_INVALID");
                const [leaseIndex, summaryIndex, runIndexValues, alarmRefs] = await Promise.all([
                    readIndex(session, accountIndexKey(hashKey, "aps-sync-leases", accountKey)),
                    readIndex(local, accountIndexKey(hashKey, "aps-sync-summaries", accountKey)),
                    readIndex(local, accountIndexKey(hashKey, "aps-sync-runs", accountKey)),
                    readIndex(local, accountIndexKey(hashKey, "aps-sync-alarms", accountKey))
                ]);
                if (leaseIndex.length) await session.remove(leaseIndex);
                if (summaryIndex.length) await local.remove(summaryIndex);
                if (runIndexValues.length) await local.remove(runIndexValues.map((ref) => `aps-sync-index:${ref}`));
                if (alarmRefs.length) await local.remove(accountIndexKey(hashKey, "aps-sync-alarms", accountKey));
                await Promise.all([
                    session.remove(accountIndexKey(hashKey, "aps-sync-leases", accountKey)),
                    local.remove(accountIndexKey(hashKey, "aps-sync-summaries", accountKey)),
                    local.remove(accountIndexKey(hashKey, "aps-sync-runs", accountKey)),
                    local.remove(accountIndexKey(hashKey, "aps-sync-alarms", accountKey))
                ]);
            }
        });

        async function revokeAccount(accountKey) {
            if (!ACCOUNT_KEY.test(accountKey || "")) throw new Error("STORAGE_ACCOUNT_KEY_INVALID");
            await leaseStore.removeAccount(accountKey);
            await summaryStore.removeAccount(accountKey);
            await runIndex.removeAccount(accountKey);
            await accountAlarmIndex.revoke(accountKey);
            await accountAlarmIndex.revokeAccount(accountKey);
            return { ok: true, state: "revoked" };
        }

        return Object.freeze({ leaseStore, summaryStore, runIndex, accountAlarmIndex, publicSnapshot, revokeAccount });
    }

    return Object.freeze({ createCanvasSyncStorage });
}));
