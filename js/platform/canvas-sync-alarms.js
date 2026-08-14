(function (root, factory) {
    "use strict";

    const api = factory();
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasPlatform = Object.assign(root.APStudyCanvasPlatform || {}, { CanvasSyncAlarms: api });
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const PREFIX = "aps-canvas-sync:";
    const MIN_DELAY_MS = 60000;
    const MAX_DELAY_MS = 300000;
    const MAX_REF_LENGTH = 128;
    const REF = /^[A-Za-z0-9_-]{1,128}$/;
    const MAX_BINDING_ID_LENGTH = 512;
    const ACCOUNT_KEY = /^[a-f0-9]{64}$/;
    const PAUSED_UNAVAILABLE = Object.freeze({ state: "paused", errorCode: "alarms_unavailable" });

    function isPlainObject(value) {
        if (!value || typeof value !== "object" || Array.isArray(value)) return false;
        const prototype = Object.getPrototypeOf(value);
        return prototype === Object.prototype || prototype === null;
    }

    function validBindingId(value) {
        return typeof value === "string"
            && value.length > 0
            && value.length <= MAX_BINDING_ID_LENGTH
            && !/[\u0000-\u001F\u007F]/.test(value);
    }

    function canonicalBinding(value) {
        if (!isPlainObject(value)
            || !validBindingId(value.sourceId)
            || !validBindingId(value.runId)
            || !Number.isSafeInteger(value.generation)
            || value.generation <= 0) return null;
        const accountKey = value.accountKey ?? value.account_key;
        if (accountKey !== undefined && !ACCOUNT_KEY.test(accountKey)) return null;
        return JSON.stringify({ ...(accountKey === undefined ? {} : { accountKey }), generation: value.generation, runId: value.runId, sourceId: value.sourceId });
    }

    function boundedRef(hashKey, canonical) {
        let result;
        try { result = hashKey(canonical); } catch (error) { return null; }
        return typeof result === "string"
            && result.length <= MAX_REF_LENGTH
            && REF.test(result)
            ? result
            : null;
    }

    function clampDelay(delayMs) {
        const value = Number(delayMs);
        if (!Number.isFinite(value)) return MIN_DELAY_MS;
        return Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, value));
    }

    function safeWhen(clock, delayMs) {
        let now;
        try { now = Number(clock()); } catch (error) { now = Date.now(); }
        if (!Number.isFinite(now)) now = Date.now();
        return now + delayMs;
    }

    function alarmRef(alarm) {
        const name = typeof alarm === "string" ? alarm : alarm?.name;
        if (typeof name !== "string" || !name.startsWith(PREFIX)) return null;
        const ref = name.slice(PREFIX.length);
        return REF.test(ref) && name === `${PREFIX}${ref}` ? ref : null;
    }

    function unavailable() {
        return Object.freeze({
            available: false,
            schedule: () => PAUSED_UNAVAILABLE,
            consume: async () => null,
            cancel: () => PAUSED_UNAVAILABLE
        });
    }

    function scheduleInput(delayOrSummaryRef, maybeSummaryRef) {
        if (isPlainObject(delayOrSummaryRef)) {
            return {
                delayMs: delayOrSummaryRef.delayMs ?? delayOrSummaryRef.delay_ms,
                summaryRef: delayOrSummaryRef.summaryRef ?? delayOrSummaryRef.summary_ref
            };
        }
        if (typeof delayOrSummaryRef === "string" && REF.test(delayOrSummaryRef)) {
            return { delayMs: maybeSummaryRef, summaryRef: delayOrSummaryRef };
        }
        return { delayMs: delayOrSummaryRef, summaryRef: maybeSummaryRef };
    }

    function createCanvasSyncAlarms({ alarms, runIndex, summaryStore, accountAlarmIndex, hashKey, clock = () => Date.now() } = {}) {
        if (typeof alarms?.create !== "function"
            || typeof alarms?.clear !== "function"
            || !runIndex
            || typeof runIndex.set !== "function"
            || typeof runIndex.get !== "function"
            || typeof runIndex.remove !== "function"
            || typeof hashKey !== "function") return unavailable();

        const consumed = new Set();

        function bindingRef(binding) {
            const canonical = canonicalBinding(binding);
            if (canonical === null) return null;
            const ref = boundedRef(hashKey, `canvas-sync-alarm:${canonical}`);
            return ref === null ? null : { ref };
        }

        async function resolveSummaryRef(binding, supplied) {
            if (typeof supplied === "string" && REF.test(supplied)) return supplied;
            const getRef = summaryStore?.getRef || summaryStore?.getSummaryRef;
            if (typeof getRef === "function") {
                try {
                    const result = await getRef.call(summaryStore, binding);
                    if (typeof result === "string" && REF.test(result)) return result;
                } catch (error) {
                    return null;
                }
            }
            if (typeof summaryStore?.get === "function" && typeof summaryStore?.set === "function") {
                try {
                    const run = await summaryStore.get(binding);
                    if (run !== null && run !== undefined) {
                        const result = await summaryStore.set(binding, run);
                        if (typeof result === "string" && REF.test(result)) return result;
                    }
                } catch (error) {
                    return null;
                }
            }
            return null;
        }

        async function schedule(binding, delayOrSummaryRef, maybeSummaryRef) {
            const identity = bindingRef(binding);
            if (identity === null) return { state: "paused", errorCode: "binding_invalid" };
            const accountKey = binding.accountKey ?? binding.account_key;
            if (accountAlarmIndex?.isRevoked && ACCOUNT_KEY.test(accountKey || "") && await accountAlarmIndex.isRevoked(accountKey)) {
                return { state: "cancelled", errorCode: "account_revoked" };
            }
            const input = scheduleInput(delayOrSummaryRef, maybeSummaryRef);
            const summaryRef = await resolveSummaryRef(binding, input.summaryRef);
            if (summaryRef === null) return { state: "paused", errorCode: "summary_ref_unavailable" };
            const delay = clampDelay(input.delayMs);
            const name = `${PREFIX}${identity.ref}`;
            consumed.delete(identity.ref);
            try {
                // The durable index contains only alarmRef -> summaryRef.
                await runIndex.set(identity.ref, summaryRef, binding);
                if (accountAlarmIndex?.add && ACCOUNT_KEY.test(accountKey || "")) await accountAlarmIndex.add(accountKey, identity.ref);
                try {
                    await alarms.create(name, { when: safeWhen(clock, delay) });
                } catch (error) {
                    await runIndex.remove(identity.ref).catch(() => {});
                    if (accountAlarmIndex?.remove && ACCOUNT_KEY.test(accountKey || "")) await accountAlarmIndex.remove(accountKey, identity.ref).catch(() => {});
                    throw error;
                }
                return { state: "scheduled" };
            } catch (error) {
                return { state: "paused", errorCode: "alarm_schedule_failed" };
            }
        }

        async function consume(alarm) {
            const ref = alarmRef(alarm);
            if (ref === null || consumed.has(ref)) return null;
            consumed.add(ref);
            try {
                const summaryRef = await runIndex.get(ref);
                await runIndex.remove(ref).catch(() => {});
                return typeof summaryRef === "string" && REF.test(summaryRef) ? summaryRef : null;
            } catch (error) {
                consumed.delete(ref);
                return null;
            }
        }

        async function cancel(binding) {
            const identity = bindingRef(binding);
            if (identity === null) return { state: "paused", errorCode: "binding_invalid" };
            const name = `${PREFIX}${identity.ref}`;
            let clearFailed = false;
            try { await alarms.clear(name); } catch (error) { clearFailed = true; }
            try {
                await runIndex.remove(identity.ref);
                const accountKey = binding.accountKey ?? binding.account_key;
                if (accountAlarmIndex?.remove && ACCOUNT_KEY.test(accountKey || "")) await accountAlarmIndex.remove(accountKey, identity.ref);
            } catch (error) {
                return { state: "paused", errorCode: clearFailed ? "alarm_cancel_failed" : "index_remove_failed" };
            }
            return clearFailed ? { state: "paused", errorCode: "alarm_cancel_failed" } : { state: "cancelled" };
        }

        async function cancelAccount(accountKey) {
            if (!ACCOUNT_KEY.test(accountKey || "")) return { state: "paused", errorCode: "account_invalid" };
            if (typeof accountAlarmIndex?.get !== "function") return { state: "paused", errorCode: "alarm_account_index_unavailable" };
            const refs = await accountAlarmIndex.get(accountKey);
            let failed = false;
            for (const ref of refs) {
                try { await alarms.clear(`${PREFIX}${ref}`); } catch (error) { failed = true; }
                try { await runIndex.remove(ref); } catch (error) { failed = true; }
            }
            if (typeof accountAlarmIndex.clear === "function") await accountAlarmIndex.clear(accountKey);
            if (typeof accountAlarmIndex.revoke === "function") {
                try { await accountAlarmIndex.revoke(accountKey); } catch (error) { failed = true; }
            }
            return failed ? { state: "paused", errorCode: "alarm_cancel_failed" } : { state: "cancelled", count: refs.length };
        }

        return Object.freeze({ available: true, schedule, consume, cancel, cancelAccount });
    }

    return Object.freeze({ createCanvasSyncAlarms });
}));
