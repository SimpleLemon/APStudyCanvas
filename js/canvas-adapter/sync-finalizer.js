(function (root, factory) {
    "use strict";

    const api = factory();
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasCanvasAdapter = Object.assign(root.APStudyCanvasCanvasAdapter || {}, { SyncFinalizer: api });
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
    const UNSAFE_CODE = /TOKEN|COOKIE|CSRF|RAW|EVENT|TITLE|DESCRIPTION|URL|LEASE/i;
    const TERMINAL_STATES = new Set(["partial", "completed", "cancelled", "failed"]);

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

    function safeCode(value, fallback) {
        return typeof value === "string" && SAFE_CODE.test(value) && !UNSAFE_CODE.test(value) ? value : fallback;
    }

    function same(left, right) {
        if (left === right) return true;
        if (Array.isArray(left) || Array.isArray(right)) {
            return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => same(item, right[index]));
        }
        if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
        const keys = Object.keys(left);
        return keys.length === Object.keys(right).length && keys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && same(left[key], right[key]));
    }

    function safeCounts(summary) {
        const progress = isPlainObject(summary?.progress) ? summary.progress : {};
        const counts = {};
        for (const id of Object.keys(progress).sort()) {
            const source = progress[id]?.counts;
            if (!isPlainObject(source)) continue;
            const clean = {};
            for (const key of Object.keys(source).sort()) {
                if (/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(key) && Number.isSafeInteger(source[key]) && source[key] >= 0) clean[key] = source[key];
            }
            counts[id] = clean;
        }
        return counts;
    }

    function output(state, status, summary, errorCode = null) {
        return {
            state,
            status,
            tombstoneEligible: Boolean(summary?.tombstone_eligible && state === "completed" && status === "complete"),
            counts: safeCounts(summary),
            errorCode: errorCode || null
        };
    }

    function responseField(response, camel, snake) {
        if (!isPlainObject(response)) return undefined;
        return response[camel] !== undefined ? response[camel] : response[snake];
    }

    function responseCode(response) {
        const status = response?.status ?? response?.statusCode ?? response?.status_code;
        if (status === 401) return "UNAUTHENTICATED";
        if (status === 403) return "FORBIDDEN";
        return null;
    }

    function errorCode(error) {
        const status = error?.status ?? error?.statusCode ?? error?.status_code;
        if (status === 401) return "UNAUTHENTICATED";
        if (status === 403) return "FORBIDDEN";
        if (error?.offline === true || /offline|network|timeout|econn/i.test(String(error?.code || error?.name || ""))) return "OFFLINE";
        if (/malformed|invalid|response|schema/i.test(String(error?.code || ""))) return "MALFORMED";
        return safeCode(error?.code, "FINALIZE_FAILED");
    }

    function exactResponse(response, binding, target) {
        if (!isPlainObject(response) || response.ok === false) return false;
        const run = responseField(response, "runId", "run_id");
        const generation = response.generation;
        const status = response.status;
        return run === binding.runId && generation === binding.generation && status === target;
    }

    function partialRun(state, code) {
        return {
            version: state.version,
            binding: state.binding,
            state: "partial",
            progress: state.progress,
            complete: false,
            tombstoneEligible: false,
            errorCode: code || null,
            replayLedger: state.replayLedger
        };
    }

    function createSyncFinalizer({ stateApi, client, outbox, summaryStore } = {}) {
        const replayMemo = new Map();

        async function persist(summary) {
            const safe = clone(summary);
            if (typeof summaryStore?.set === "function") return summaryStore.set(safe);
            if (typeof summaryStore?.write === "function") return summaryStore.write(safe);
            if (typeof summaryStore?.save === "function") return summaryStore.save(safe);
            throw Object.assign(new Error("SUMMARY_STORE_UNAVAILABLE"), { code: "SUMMARY_STORE_UNAVAILABLE" });
        }

        function validBinding(input) {
            if (!stateApi || typeof stateApi.normalizeBinding !== "function" || !isPlainObject(input)) return null;
            const normalized = stateApi.normalizeBinding(input);
            const scope = input.scope ?? input.scopeValue ?? input.scope_value;
            if (!normalized || scope === undefined) return null;
            return {
                normalized,
                client: {
                    contractVersion: normalized.contractVersion,
                    accountKey: normalized.accountKey,
                    origin: normalized.origin,
                    userId: normalized.userId,
                    sourceId: normalized.sourceId,
                    ...(normalized.sourceRef ? { sourceRef: normalized.sourceRef } : {}),
                    runId: normalized.runId,
                    generation: normalized.generation,
                    consentVersion: normalized.consentVersion,
                    scope: clone(scope),
                    registeredDescriptorIds: normalized.registeredDescriptorIds.slice()
                }
            };
        }

        function bindingMatches(summaryBinding, normalized) {
            return isPlainObject(summaryBinding) && same(summaryBinding, {
                account_key: normalized.accountKey,
                origin: normalized.origin,
                user_id: normalized.userId,
                source_id: normalized.sourceId,
                ...(normalized.sourceRef ? { source_ref: normalized.sourceRef } : {}),
                run_id: normalized.runId,
                generation: normalized.generation,
                consent_version: normalized.consentVersion,
                scope_hash: normalized.scopeHash,
                registered_descriptor_ids: normalized.registeredDescriptorIds.slice().sort()
            });
        }

        function safeSummary(run) {
            const summary = stateApi?.toSafeSummary?.(run);
            return summary && isPlainObject(summary) ? summary : null;
        }

        function transition(run, requestId) {
            if (typeof stateApi?.transition !== "function") return null;
            const result = stateApi.transition(run, { type: "finalize", generation: run.binding.generation, ...(requestId === undefined ? {} : { requestId }) });
            return result?.ok === true ? result : null;
        }

        function requestSeen(summary, requestId) {
            return requestId !== undefined && Array.isArray(summary?.replay_ledger) && summary.replay_ledger.some((entry) => entry?.request_id === requestId);
        }

        async function finalizeIfReady({ enabled, binding, runSummary, requestId } = {}) {
            if (enabled !== true) return output("idle", "disabled", null, "FEATURE_DISABLED");

            const validated = validBinding(binding);
            if (!validated || typeof stateApi?.restoreSafeSummary !== "function") return output("partial", "failed", null, "INVALID_BINDING");

            const restored = stateApi.restoreSafeSummary(runSummary);
            if (!restored?.ok) return output("partial", "failed", null, safeCode(restored?.code, "MALFORMED"));
            const run = restored.state || restored.run;
            const restoredSummary = safeSummary(run);
            if (!run || !restoredSummary || !bindingMatches(restoredSummary.binding, validated.normalized)) return output("partial", "failed", restoredSummary, "BINDING_MISMATCH");

            const target = restoredSummary.tombstone_eligible === true
                && restoredSummary.state === "completed"
                && restoredSummary.progress
                && validated.normalized.registeredDescriptorIds.every((id) => restoredSummary.progress[id]?.state === "exhausted")
                ? "complete"
                : "partial";
            const base = output(target === "complete" ? "completed" : "partial", target, restoredSummary, target === "partial" ? "SYNC_DESCRIPTORS_INCOMPLETE" : null);
            const fingerprint = `${JSON.stringify(restoredSummary.binding)}:${target}`;
            if (requestId !== undefined) {
                const previous = replayMemo.get(requestId);
                if (previous && previous !== fingerprint) return output("partial", "failed", restoredSummary, "SYNC_REPLAY_CONFLICT");
                if (previous === fingerprint) return base;
                if (requestSeen(restoredSummary, requestId)) {
                    replayMemo.set(requestId, fingerprint);
                    return base;
                }
                replayMemo.set(requestId, fingerprint);
            }

            const namespace = {
                account: validated.normalized.accountKey,
                source: validated.normalized.sourceId,
                run: validated.normalized.runId,
                generation: validated.normalized.generation
            };
            try {
                if (typeof outbox?.pendingCount !== "function" || typeof outbox?.currentGeneration !== "function") throw Object.assign(new Error("OUTBOX_UNAVAILABLE"), { code: "OUTBOX_UNAVAILABLE" });
                const pending = await outbox.pendingCount(namespace);
                if (!Number.isSafeInteger(pending) || pending < 0) throw Object.assign(new Error("OUTBOX_COUNT_INVALID"), { code: "MALFORMED" });
                if (pending > 0) return output("running", "queued", restoredSummary, null);

                const before = await outbox.currentGeneration(namespace);
                if (before !== validated.normalized.generation) return output("superseded", "superseded", restoredSummary, "STALE_GENERATION");
                if (typeof client?.finalize !== "function") throw Object.assign(new Error("CLIENT_UNAVAILABLE"), { code: "CLIENT_UNAVAILABLE" });

                let response;
                try {
                    response = await client.finalize(validated.client, target);
                } catch (error) {
                    const code = errorCode(error);
                    const failed = safeSummary(partialRun(run, code));
                    try { if (failed) await persist(failed); } catch (ignored) { /* safe result remains bounded */ }
                    return output("partial", "failed", failed || restoredSummary, code);
                }

                const after = await outbox.currentGeneration(namespace);
                if (after !== validated.normalized.generation) return output("superseded", "superseded", restoredSummary, "STALE_GENERATION");
                const responseError = responseCode(response);
                if (responseError || !exactResponse(response, validated.normalized, target)) {
                    const code = responseError || "MALFORMED";
                    const failed = safeSummary(partialRun(run, code));
                    try { if (failed) await persist(failed); } catch (ignored) { /* safe result remains bounded */ }
                    return output("partial", "failed", failed || restoredSummary, code);
                }

                let persisted = restoredSummary;
                if (target === "complete") {
                    const transitioned = transition(run, requestId);
                    const candidate = transitioned?.state && safeSummary(transitioned.state);
                    if (candidate?.tombstone_eligible === true && candidate.state === "completed") persisted = candidate;
                } else {
                    const transitioned = transition(run, requestId);
                    const candidate = transitioned?.state && safeSummary(transitioned.state);
                    persisted = candidate?.state === "partial" && candidate.tombstone_eligible === false
                        ? candidate
                        : safeSummary(partialRun(run, "SYNC_DESCRIPTORS_INCOMPLETE"));
                }
                if (!persisted) throw Object.assign(new Error("SUMMARY_INVALID"), { code: "MALFORMED" });
                await persist(persisted);
                return output(target === "complete" ? "completed" : "partial", target, persisted, target === "complete" ? null : "SYNC_DESCRIPTORS_INCOMPLETE");
            } catch (error) {
                const code = errorCode(error);
                const failed = safeSummary(partialRun(run, code));
                try { if (failed) await persist(failed); } catch (ignored) { /* safe result remains bounded */ }
                return output("partial", "failed", failed || restoredSummary, code);
            }
        }

        return Object.freeze({ finalizeIfReady });
    }

    return Object.freeze({ createSyncFinalizer });
}));
