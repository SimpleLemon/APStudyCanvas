(function (root, factory) {
    "use strict";

    const api = factory(root);
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasCanvasAdapter = Object.assign(root.APStudyCanvasCanvasAdapter || {}, { SyncEngine: api });
}(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
    "use strict";

    const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
    const UNSAFE_CODE = /TOKEN|COOKIE|CSRF|RAW|EVENT|TITLE|DESCRIPTION|URL/i;
    const STATE_KEYS = new Set([
        "contractVersion", "contract_version", "accountKey", "account_key", "account", "origin",
        "userId", "user_id", "user", "sourceId", "source_id", "source", "sourceRef", "source_ref", "runId", "run_id", "run",
        "generation", "consentVersion", "consent_version", "consent", "scopeHash", "scope_hash",
        "scopeValue", "scope_value", "scope", "registeredDescriptorIds", "registered_descriptor_ids",
        "registeredDescriptors", "registered_descriptors"
    ]);

    function valueAt(input, ...names) {
        if (!input || typeof input !== "object") return undefined;
        for (const name of names) if (input[name] !== undefined) return input[name];
        return undefined;
    }

    function clone(value) {
        if (value === undefined) return undefined;
        if (typeof structuredClone === "function") return structuredClone(value);
        return JSON.parse(JSON.stringify(value));
    }

    function sameJson(left, right) {
        if (left === right) return true;
        if (Array.isArray(left) || Array.isArray(right)) {
            return Array.isArray(left) && Array.isArray(right) && left.length === right.length
                && left.every((item, index) => sameJson(item, right[index]));
        }
        if (left && right && typeof left === "object" && typeof right === "object") {
            const leftKeys = Object.keys(left);
            const rightKeys = Object.keys(right);
            return leftKeys.length === rightKeys.length
                && leftKeys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && sameJson(left[key], right[key]));
        }
        return false;
    }

    function stateInput(binding) {
        const input = {};
        if (!binding || typeof binding !== "object") return input;
        for (const key of Object.keys(binding)) if (STATE_KEYS.has(key)) input[key] = binding[key];
        return input;
    }

    function safeBinding(stateApi, binding) {
        if (!stateApi || typeof stateApi.normalizeBinding !== "function") return null;
        const normalized = stateApi.normalizeBinding(stateInput(binding));
        if (!normalized) return null;
        return {
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
        };
    }

    function codeFrom(error, fallback = "SYNC_DEPENDENCY_FAILED") {
        const code = error && typeof error.code === "string" ? error.code : "";
        return SAFE_CODE.test(code) && !UNSAFE_CODE.test(code) ? code : fallback;
    }

    function safeFailure(code) {
        return { state: "failed", errorCode: codeFrom({ code }, "SYNC_DEPENDENCY_FAILED") };
    }

    function safeCodeResult(code) {
        return { state: "failed", code: codeFrom({ code }, "SYNC_DEPENDENCY_FAILED") };
    }

    function accountMismatch() {
        const error = new Error("ACCOUNT_MISMATCH");
        error.code = "ACCOUNT_MISMATCH";
        return error;
    }

    function sessionMatches(binding, session) {
        if (!session || typeof session !== "object") return false;
        const account = valueAt(binding, "accountKey", "account_key", "account");
        const origin = valueAt(binding, "origin");
        const user = valueAt(binding, "userId", "user_id", "user");
        const sessionAccount = valueAt(session, "accountKey", "account_key", "account");
        const sessionOrigin = valueAt(session, "origin");
        const sessionUser = valueAt(session, "userId", "user_id", "user", "providerUserId", "provider_user_id");
        return sessionAccount === account && sessionOrigin === origin && String(sessionUser) === String(user);
    }

    function findField(value, names, depth = 0, seen = new Set()) {
        if (!value || typeof value !== "object" || depth > 5 || seen.has(value)) return undefined;
        seen.add(value);
        for (const [key, child] of Object.entries(value)) {
            if (names.includes(key)) {
                seen.delete(value);
                return child;
            }
            const nested = findField(child, names, depth + 1, seen);
            if (nested !== undefined) {
                seen.delete(value);
                return nested;
            }
        }
        seen.delete(value);
        return undefined;
    }

    function responseBinding(binding, sourceResponse, runResponse) {
        const sourceId = findField(sourceResponse, ["sourceId", "source_id"]);
        const sourceRef = findField(sourceResponse, ["sourceRef", "source_ref"]);
        const runId = findField(runResponse, ["runId", "run_id"]);
        const generation = findField(runResponse, ["generation"]);
        const result = { ...binding };
        if (sourceId !== undefined) result.sourceId = sourceId;
        if (sourceRef !== undefined) result.sourceRef = sourceRef;
        if (runId !== undefined) result.runId = runId;
        if (generation !== undefined) result.generation = generation;
        return result;
    }

    function responseGeneration(value) {
        const generation = findField(value, ["generation"]);
        return Number.isSafeInteger(generation) && generation > 0 ? generation : undefined;
    }

    function createSyncEngine({ stateApi, client, summaryStore, resolveCanvasSession } = {}) {
        const defaultStateApi = root?.APStudyCanvasCanvasAdapter?.SyncState;
        const state = stateApi || defaultStateApi;

        async function readSummary() {
            if (typeof summaryStore?.get === "function") return summaryStore.get();
            if (typeof summaryStore?.read === "function") return summaryStore.read();
            if (typeof summaryStore?.load === "function") return summaryStore.load();
            throw Object.assign(new Error("SUMMARY_STORE_UNAVAILABLE"), { code: "SUMMARY_STORE_UNAVAILABLE" });
        }

        async function persist(summary) {
            const safe = clone(summary);
            if (typeof summaryStore?.set === "function") return summaryStore.set(safe);
            if (typeof summaryStore?.write === "function") return summaryStore.write(safe);
            if (typeof summaryStore?.save === "function") return summaryStore.save(safe);
            throw Object.assign(new Error("SUMMARY_STORE_UNAVAILABLE"), { code: "SUMMARY_STORE_UNAVAILABLE" });
        }

        function restored(summary) {
            if (summary === undefined || summary === null) return null;
            const result = state.restoreSafeSummary(summary);
            if (!result || result.ok !== true) {
                const error = new Error(result?.code || "SYNC_SUMMARY_CORRUPT");
                error.code = result?.code || "SYNC_SUMMARY_CORRUPT";
                throw error;
            }
            return result.state || result.run;
        }

        function summaryOf(run) {
            const summary = state.toSafeSummary(run);
            if (!summary) throw Object.assign(new Error("SYNC_STATE_INVALID"), { code: "SYNC_STATE_INVALID" });
            return summary;
        }

        function transition(run, type, extra = {}) {
            const result = state.transition(run, { type, ...extra });
            if (!result || result.ok !== true) {
                const error = new Error(result?.code || "SYNC_STATE_TRANSITION_FAILED");
                error.code = result?.code || "SYNC_STATE_TRANSITION_FAILED";
                throw error;
            }
            return result.state || result.run;
        }

        async function saveTransition(run, type, extra = {}) {
            const next = transition(run, type, extra);
            const summary = summaryOf(next);
            await persist(summary);
            return summary;
        }

        function matchesSavedBinding(run, binding) {
            const candidate = safeBinding(state, binding);
            const saved = summaryOf(run).binding;
            return candidate !== null && sameJson(candidate, saved);
        }

        function clientBinding(binding, run) {
            const safe = run?.binding;
            return {
                ...binding,
                ...(safe ? {
                    accountKey: safe.accountKey,
                    origin: safe.origin,
                    userId: safe.userId,
                    sourceId: safe.sourceId,
                    ...(safe.sourceRef ? { sourceRef: safe.sourceRef } : {}),
                    runId: safe.runId,
                    generation: safe.generation,
                    consentVersion: safe.consentVersion
                } : {})
            };
        }

        async function resolve(binding) {
            if (typeof resolveCanvasSession !== "function") throw Object.assign(new Error("CANVAS_SESSION_RESOLVER_UNAVAILABLE"), { code: "CANVAS_SESSION_RESOLVER_UNAVAILABLE" });
            return resolveCanvasSession(binding);
        }

        async function failureFor(run, error) {
            const code = codeFrom(error);
            if (run) {
                try {
                    const failed = transition(run, "fail", { errorCode: code });
                    await persist(summaryOf(failed));
                } catch (ignored) {
                    // The public failure remains bounded even if failure persistence is unavailable.
                }
            }
            return safeFailure(code);
        }

        async function start(input = {}) {
            if (input.enabled !== true) return { state: "idle", code: "feature_disabled" };
            const binding = input.binding;
            let run = null;
            try {
                const session = await resolve(binding);
                if (session === null || session === undefined) {
                    run = state.createRun(stateInput(binding));
                    if (!run) throw Object.assign(new Error("SYNC_STATE_INVALID"), { code: "SYNC_STATE_INVALID" });
                    return await saveTransition(run, "wait");
                }
                if (!sessionMatches(binding, session)) throw accountMismatch();
                await client.preflight(input.proof, binding);
                const sourceResponse = await client.establishSource(binding);
                const sourceBinding = responseBinding(binding, sourceResponse, {});
                const runResponse = await client.startRun(sourceBinding);
                const finalBinding = responseBinding(sourceBinding, {}, runResponse);
                run = state.createRun(stateInput(finalBinding));
                if (!run) throw Object.assign(new Error("SYNC_STATE_INVALID"), { code: "SYNC_STATE_INVALID" });
                const summary = summaryOf(run);
                await persist(summary);
                return summary;
            } catch (error) {
                if (error?.code === "ACCOUNT_MISMATCH") throw accountMismatch();
                return failureFor(run, error);
            }
        }

        async function getStatus(input = {}) {
            if (input.enabled !== true) return { state: "idle", code: "feature_disabled" };
            let run = null;
            try {
                const stored = await readSummary();
                if (stored === undefined || stored === null) return { state: "idle" };
                run = restored(stored);
                const summary = summaryOf(run);
                if (!["running", "partial", "waiting_for_canvas_session"].includes(run.state)) return summary;
                if (!matchesSavedBinding(run, input.binding)) return safeCodeResult("ACCOUNT_MISMATCH");
                const response = await client.status(clientBinding(input.binding, run));
                const generation = responseGeneration(response);
                if (generation !== undefined && generation !== run.binding.generation) return safeCodeResult("STALE_GENERATION");
                return summary;
            } catch (error) {
                return failureFor(run, error);
            }
        }

        async function resume(input = {}) {
            if (input.enabled !== true) return { state: "idle", code: "feature_disabled" };
            let run = null;
            try {
                const stored = await readSummary();
                if (stored === undefined || stored === null) return { state: "idle", code: "no_saved_summary" };
                run = restored(stored);
                if (!matchesSavedBinding(run, input.binding)) throw accountMismatch();
                const session = await resolve(input.binding);
                if (session === null || session === undefined || !sessionMatches(input.binding, session)) {
                    if (run.state === "waiting_for_canvas_session") return summaryOf(run);
                    return await saveTransition(run, "wait");
                }
                await client.preflight(input.proof, input.binding);
                await client.resume(clientBinding(input.binding, run));
                return await saveTransition(run, "resume");
            } catch (error) {
                if (error?.code === "ACCOUNT_MISMATCH") throw accountMismatch();
                return failureFor(run, error);
            }
        }

        async function cancel(input = {}) {
            if (input.enabled !== true) return { state: "idle", code: "feature_disabled" };
            let run = null;
            try {
                const stored = await readSummary();
                if (stored === undefined || stored === null) return { state: "idle", code: "no_saved_summary" };
                run = restored(stored);
                if (!matchesSavedBinding(run, input.binding)) throw accountMismatch();
                if (run.state === "cancelled") return summaryOf(run);
                await client.cancel({ ...clientBinding(input.binding, run), ...(input.reason === undefined ? {} : { reason: input.reason }) });
                return await saveTransition(run, "cancel");
            } catch (error) {
                if (error?.code === "ACCOUNT_MISMATCH") throw accountMismatch();
                return failureFor(run, error);
            }
        }

        return Object.freeze({ start, getStatus, resume, cancel });
    }

    return Object.freeze({ createSyncEngine });
}));
