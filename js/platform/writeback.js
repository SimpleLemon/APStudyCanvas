(function (root, factory) {
    "use strict";
    const load = (name, file) => root?.APStudyCanvasPlatform?.[name] || (typeof require === "function" ? require(file) : null);
    const identity = root?.APStudyCanvasCanvasAdapter?.Identity || (typeof require === "function" ? require("../canvas-adapter/identity.js") : null);
    const api = factory(identity, load("WritebackConsent", "./writeback-consent.js"), load("WritebackExecutor", "./writeback-executor.js"), load("WritebackMirrors", "./writeback-mirrors.js"));
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasPlatform = Object.assign(root.APStudyCanvasPlatform || {}, { Writeback: api });
}(globalThis, function (identity, consent, executorApi, mirrors) {
    "use strict";
    const CONTRACT_VERSION = 1, ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
    const ok = data => ({ ok: true, contractVersion: 1, ...data });
    const fail = code => ({ ok: false, contractVersion: 1, code });
    function bodyOf(value) { return value?.body || value?.payload?.body || value?.payload || value; }
    function normalizeIntent(value) {
        if (!value || !["create", "update", "delete"].includes(value.operation) || !/^(user|task):[A-Za-z0-9._-]{1,150}$/.test(value.event_ref || "") || !ID.test(value.idempotency_key || "")) return null;
        const kind = value.event_ref.split(":")[0];
        const payload = executorApi.normalizePayload(kind, value.payload || {}, value.operation);
        if (!payload || (value.operation !== "create" && (typeof value.expected_revision !== "string" || !value.expected_revision || value.expected_revision.length > 256))) return null;
        if (typeof value.target_account !== "string" || !/^[a-f0-9]{64}$/.test(value.target_account)) return null;
        if (value.target_calendar != null && !/^user_[1-9]\d{0,19}$/.test(value.target_calendar)) return null;
        return { operation: value.operation, event_ref: value.event_ref, expected_revision: value.expected_revision || null, idempotency_key: value.idempotency_key, target_account: value.target_account, ...(value.target_calendar ? { target_calendar: value.target_calendar } : {}), payload, kind };
    }
    function responseIntents(value) {
        const body = bodyOf(value);
        return Array.isArray(body?.writebacks) ? body.writebacks.map(item => ({ ...item,
            payload: item.payload?.operation === item.operation && item.payload?.event_ref === item.event_ref ? item.payload.payload : item.payload
        })) : [];
    }
    function createWritebackService({ storage, store, transport, executor, now = () => Date.now() } = {}) {
        if (!storage || !store?.put || !store?.get || !store?.list) throw new Error("WRITEBACK_DURABLE_STORE_REQUIRED");
        let tail = Promise.resolve();
        function serial(fn) { const run = tail.then(fn); tail = run.catch(() => {}); return run; }
        const prefix = (a, s, u) => `writeback:${identity.sha256HexSync(`${a}:${s}:${u}`)}:`;
        const keyFor = (ctx, id) => prefix(ctx.accountKey, ctx.sourceRef, ctx.userId) + identity.sha256HexSync(id);
        async function save(key, record) { const result = await store.put(key, record); if (result?.ok !== true) throw new Error(result?.code || "WRITEBACK_PERSIST_FAILED"); }
        async function api(ctx, method, suffix, body) {
            const call = method === "GET" ? transport.request.bind(transport) : transport.mutate.bind(transport);
            const response = await call({ method, path: `/api/extension/calendar/sources/${encodeURIComponent(ctx.sourceRef)}${suffix}`, ...(body ? { body } : {}), headers: { Accept: "application/json", "X-Request-ID": ctx.requestId } }, { requestId: ctx.requestId, idempotent: true, idempotencyKey: body?.idempotency_key || identity.sha256HexSync(`${ctx.userId}:${suffix}:${identity.stableStringify(body || {})}`) });
            if (response?.ok === false || Number(response?.status) >= 400 || bodyOf(response)?.ok === false) throw new Error("NEST_WRITEBACK_UNAVAILABLE");
            return bodyOf(response);
        }
        async function context(payload, options) {
            const accountKey = payload.account_key, sourceRef = payload.source_ref;
            const record = options.metadata;
            if (!/^[a-f0-9]{64}$/.test(accountKey || "") || !/^src1:[A-Za-z0-9._~-]{1,128}$/.test(sourceRef || "") || record?.source_ref !== sourceRef || record?.source_key !== `canvas:${accountKey}` || !record?.nest_user_id) return fail("NEST_SOURCE_REF_INVALID");
            const auth = await consent.requireWritebackConsent({ transport, accountKey, sourceRef, requestId: options.requestId, expectedUserId: record.nest_user_id, requiredScopes: ["selected_item_mirroring"] });
            return auth.ok ? { ok: true, accountKey, sourceRef, userId: record.nest_user_id, origin: record.origin, requestId: options.requestId } : auth;
        }
        async function records(ctx) { return (await store.list()).filter(r => r.key.startsWith(prefix(ctx.accountKey, ctx.sourceRef, ctx.userId))).map(r => r.value); }
        function publicItem(r) { return { idempotency_key: r.intent.idempotency_key, event_ref: r.intent.event_ref, operation: r.intent.operation, state: r.state, expected_revision: r.intent.expected_revision, result_revision: r.result?.result_revision || null, error_code: r.result?.error_code || null, writeback_id: r.writeback_id || null }; }
        async function reauthorize(ctx, intent) {
            const auth = await consent.requireWritebackConsent({ transport, accountKey: ctx.accountKey, sourceRef: ctx.sourceRef, requestId: ctx.requestId, expectedUserId: ctx.userId, requiredScopes: ["selected_item_mirroring", ...(intent ? [intent.kind === "user" ? "personal_events_write" : "planner_items_write"] : [])] });
            if (!auth.ok) throw new Error(auth.code);
        }
        async function report(ctx, key, record) {
            await reauthorize(ctx, record.intent);
            await reconcileCancellation(ctx, record);
            if (record.state === "cancelled") return;
            const result = record.result;
            if (result.state === "applied" && record.intent.operation === "create" && !record.event_link_id) {
                if (!record.remote_id || !result.canvas_context_id) throw new Error("WRITEBACK_LINK_IDENTITY_REQUIRED");
                const linked = await api(ctx, "POST", "/event-links", { account_key: ctx.accountKey, event_ref: record.intent.event_ref, event_kind: "native", nest_event_id: record.intent.event_ref.split(":")[1], canvas_item_type: record.intent.kind === "user" ? "calendar_event" : "planner_note", canvas_item_id: record.remote_id, canvas_context_id: result.canvas_context_id, canvas_calendar_id: result.canvas_context_id, source_revision: result.result_revision || null, mirror_state: "applied" });
                const link = linked.eventLink || linked.event_link;
                if (!ID.test(String(link?.id || ""))) throw new Error("WRITEBACK_EVENT_LINK_INVALID");
                record.event_link_id = String(link.id); await save(key, record);
            }
            const state = result.state === "uncertain" ? "conflict" : result.state;
            const acknowledged = await api(ctx, "POST", `/writebacks/${encodeURIComponent(record.writeback_id)}/result`, { state, expected_revision: record.intent.expected_revision, result_revision: result.result_revision || null, error_code: result.error_code || null, retry_count: record.retry_count || 0, next_retry_at: null });
            if (acknowledged.writebackResult?.state === "conflict") record.state = "conflict";
            if (state === "conflict" && result.result_revision && result.canvas_snapshot) {
                await api(ctx, "POST", `/writebacks/${encodeURIComponent(record.writeback_id)}/conflict`, { canvas_revision: result.result_revision, canvas_snapshot: result.canvas_snapshot });
            }
            record.reported = true; await save(key, record);
        }
        async function reconcileCancellation(ctx, record) {
            if (!record.writeback_id || record.state === "cancelled" || record.state === "unlinked") return record;
            const response = await api(ctx, "GET", `/writebacks/${encodeURIComponent(record.writeback_id)}/result`);
            const remote = response.writebackResult;
            if (remote?.id !== record.writeback_id || typeof remote.state !== "string") throw new Error("WRITEBACK_RESPONSE_INVALID");
            if (remote.state === "cancelled") {
                record.state = "cancelled";
                // Keep any already-observed Canvas outcome, but never recreate an
                // unlinked mirror while retrying delivery after a worker restart.
                record.reported = true;
                await save(keyFor(ctx, record.intent.idempotency_key), record);
            }
            return record;
        }
        async function run(ctx, key, record) {
            await reauthorize(ctx, record.intent);
            if (["cancelled", "unlinked"].includes(record.state)) return record;
            if (record.result && !record.reported && record.writeback_id) { await report(ctx, key, record); return record; }
            if (["applied", "cancelled", "unlinked", "forbidden", "conflict"].includes(record.state)) return record;
            if (!record.writeback_id) {
                const { kind, ...body } = record.intent;
                const response = await api(ctx, "POST", "/writebacks", { ...body, account_key: ctx.accountKey, state: "queued" });
                const id = response?.writeback?.id || response?.writeback?.writeback_id || response?.id;
                if (!ID.test(String(id || ""))) throw new Error("WRITEBACK_RESPONSE_INVALID");
                record.writeback_id = String(id); await save(key, record);
            }
            const reconcile = record.state === "executing" || record.state === "uncertain";
            await reauthorize(ctx, record.intent);
            await reconcileCancellation(ctx, record);
            if (record.state === "cancelled") return record;
            record.state = "executing"; await save(key, record);
            let result;
            try { result = await executor.execute({ ...record.intent, remoteId: record.remote_id }, { origin: ctx.origin, accountKey: ctx.accountKey, reconcile }); }
            catch (_) { result = { state: "uncertain", error_code: "WRITEBACK_OUTCOME_UNCERTAIN" }; }
            record.result = result; record.state = result.state; record.reported = false;
            if (result.remote_id) record.remote_id = result.remote_id;
            await save(key, record);
            await report(ctx, key, record);
            return record;
        }
        async function refreshMirrors(ctx) {
            await reauthorize(ctx);
            const response = await api(ctx, "POST", "/mirrors/refresh", {});
            const links = response?.eventLinks || response?.event_links;
            if (!Array.isArray(links) || links.length > 50) throw new Error("WRITEBACK_MIRROR_RESPONSE_INVALID");
            for (const link of links) {
                if (!ID.test(link?.id || "") || link.account_key !== ctx.accountKey || !/^(user|task):[A-Za-z0-9._-]{1,150}$/.test(link.event_ref || "") || !/^[1-9]\d{0,19}$/.test(link.canvas_item_id || "") || !/^[a-f0-9]{64}$/.test(link.expected_revision || "")) continue;
                const kind = link.event_ref.split(":")[0];
                if (link.canvas_item_type !== (kind === "user" ? "calendar_event" : "planner_note")) continue;
                try {
                    await reauthorize(ctx, { kind });
                    const observation = await executor.execute({ operation: "observe", kind, remoteId: link.canvas_item_id, payload: {} }, ctx);
                    if (!["observed", "conflict"].includes(observation?.state) || !observation.result_revision || !observation.canvas_snapshot) continue;
                    await reauthorize(ctx, { kind });
                    await api(ctx, "POST", "/mirrors/refresh", { link_id: link.id, expected_revision: link.expected_revision, canvas_revision: observation.result_revision, canvas_snapshot: observation.canvas_snapshot });
                } catch (_) { /* A changed or unavailable mirror retries independently next cycle. */ }
            }
        }
        async function drain(payload = {}, options = {}) {
            return serial(async () => {
                const ctx = await context(payload, options); if (!ctx.ok) return ctx;
                const fromServer = !payload.writebacks;
                if (fromServer) await refreshMirrors(ctx);
                const supplied = payload.writebacks || responseIntents(await api(ctx, "GET", `/writebacks?account_key=${ctx.accountKey}&states=waiting_for_canvas_session,queued,retryable_failed,conflict&limit=50`));
                if (!Array.isArray(supplied) || supplied.length > 50) return fail("WRITEBACK_INTENTS_INVALID");
                const rejected = [];
                for (const raw of supplied) {
                    const intent = normalizeIntent(raw);
                    if (!intent || intent.target_account !== ctx.accountKey) { rejected.push({ code: "WRITEBACK_INTENT_INVALID" }); continue; }
                    const key = keyFor(ctx, intent.idempotency_key), previous = await store.get(key);
                    if (previous) {
                        // Only an authenticated queue response can reopen a resolved conflict.
                        // Successful or ambiguous creates retain their original operation identity.
                        if (fromServer && previous.state === "conflict" && previous.reported &&
                            previous.writeback_id === String(raw.id) && previous.intent.operation !== "create" &&
                            previous.intent.operation === intent.operation && previous.intent.event_ref === intent.event_ref &&
                            ["queued", "waiting_for_canvas_session"].includes(raw.state)) {
                            previous.intent = intent; previous.state = "queued";
                            previous.result = null; previous.reported = false;
                            await save(key, previous);
                            continue;
                        }
                        if (identity.stableStringify(previous.intent) !== identity.stableStringify(intent)) rejected.push({ code: "WRITEBACK_IDEMPOTENCY_CONFLICT" });
                        continue;
                    }
                    let link = null;
                    if (intent.operation !== "create") {
                        const response = await api(ctx, "GET", `/event-links?event_ref=${encodeURIComponent(intent.event_ref)}`);
                        link = response.eventLink || response.event_link;
                        if (!link || link.account_key !== ctx.accountKey || link.event_ref !== intent.event_ref || !/^[1-9]\d{0,19}$/.test(String(link.canvas_item_id || "")) || link.canvas_item_type !== (intent.kind === "user" ? "calendar_event" : "planner_note")) { rejected.push({ code: "WRITEBACK_EVENT_LINK_INVALID" }); continue; }
                    }
                    await save(key, { ...(ID.test(String(raw.id || "")) ? { writeback_id: String(raw.id) } : {}), accountKey: ctx.accountKey, source_ref: ctx.sourceRef, nest_user_id: ctx.userId, intent, remote_id: link ? String(link.canvas_item_id) : null, event_link_id: link?.id || null, state: fromServer && raw.state === "conflict" ? "conflict" : "queued", reported: fromServer && raw.state === "conflict", result: fromServer && raw.state === "conflict" ? { state: "conflict", result_revision: raw.result_revision, error_code: raw.error_code } : null, created_at: now() });
                }
                const pending = await records(ctx), blocked = new Set();
                let deliveryError = null;
                for (const record of pending) {
                    try { await reconcileCancellation(ctx, record); }
                    catch (error) { deliveryError ||= error; }
                    if (["conflict", "uncertain"].includes(record.state)) blocked.add(record.intent.event_ref);
                }
                for (const record of pending) {
                    if (blocked.has(record.intent.event_ref) && !["conflict", "uncertain"].includes(record.state)) continue;
                    try { await run(ctx, keyFor(ctx, record.intent.idempotency_key), record); }
                    catch (error) { deliveryError ||= error; }
                    if (["conflict", "uncertain"].includes(record.state) || (record.result && !record.reported)) blocked.add(record.intent.event_ref);
                }
                if (deliveryError) throw deliveryError;
                return ok({ state: "ready", items: (await records(ctx)).map(publicItem), rejected, mirrored_count: 0 });
            });
        }
        async function readStatus(payload = {}, options = {}) {
            const ctx = await context(payload, options); if (!ctx.ok) return ctx;
            const items = [];
            for (const record of (await records(ctx)).slice(0, 100)) {
                await reconcileCancellation(ctx, record);
                const item = publicItem(record);
                if (record.state === "conflict" && record.writeback_id) {
                    try {
                        const response = await api(ctx, "GET", `/writebacks/${encodeURIComponent(record.writeback_id)}/conflict`);
                        item.conflict = response.conflict || response;
                    } catch (_) { item.conflict_unavailable = true; }
                }
                items.push(item);
            }
            return ok({ state: "ready", items });
        }
        async function retry(payload = {}, options = {}) {
            return serial(async () => {
                const ctx = await context(payload, options); if (!ctx.ok) return ctx;
                const key = keyFor(ctx, payload.idempotency_key), record = await store.get(key); if (!record) return fail("WRITEBACK_NOT_FOUND");
                if (["waiting_for_canvas_session", "retryable_failed"].includes(record.state) && record.reported) { record.result = null; record.state = "queued"; record.retry_count = (record.retry_count || 0) + 1; await save(key, record); }
                return ok({ item: publicItem(await run(ctx, key, record)) });
            });
        }
        async function resolve(payload = {}, options = {}) {
            return serial(async () => {
                const ctx = await context(payload, options); if (!ctx.ok) return ctx;
                const key = keyFor(ctx, payload.idempotency_key), record = await store.get(key); if (!record?.writeback_id) return fail("WRITEBACK_NOT_FOUND");
                const choice = payload.choice === "apply_writeback" ? "keep_nest" : payload.choice;
                if (!["keep_canvas", "keep_nest", "unlink"].includes(choice)) return fail("WRITEBACK_CHOICE_INVALID");
                if (choice === "unlink") {
                    if (!record.event_link_id) return fail("WRITEBACK_EVENT_LINK_REQUIRED");
                    await api(ctx, "POST", `/event-links/${encodeURIComponent(record.event_link_id)}/unlink`, {}); record.state = "unlinked";
                } else {
                    const inspected = await api(ctx, "GET", `/writebacks/${encodeURIComponent(record.writeback_id)}/conflict`);
                    const conflict = inspected.conflict || inspected;
                    const revision = conflict.canvas_revision;
                    if (typeof revision !== "string" || !revision || typeof conflict.expected_revision !== "string" || !conflict.expected_revision) return fail("WRITEBACK_CONFLICT_REVISION_REQUIRED");
                    if (typeof payload.expected_revision !== "string" || payload.expected_revision !== conflict.expected_revision) return fail("WRITEBACK_CONFLICT_CHANGED");
                    if (choice === "keep_nest" && record.intent.operation === "create") return fail("WRITEBACK_CREATE_OUTCOME_UNCERTAIN");
                    const resolved = await api(ctx, "POST", `/writebacks/${encodeURIComponent(record.writeback_id)}/resolve`, { choice, expected_revision: payload.expected_revision });
                    record.state = choice === "keep_canvas" ? "cancelled" : "queued";
                    if (choice === "keep_nest") {
                        const next = normalizeIntent(responseIntents({ writebacks: [resolved.conflict?.writeback || resolved.writeback] })[0]);
                        if (!next || next.idempotency_key !== record.intent.idempotency_key || next.event_ref !== record.intent.event_ref || next.operation !== record.intent.operation || next.target_account !== ctx.accountKey || next.expected_revision !== revision) return fail("WRITEBACK_RESPONSE_INVALID");
                        record.intent = next; record.result = null; record.reported = false;
                    }
                }
                await save(key, record);
                return ok({ item: publicItem(choice === "keep_nest" ? await run(ctx, key, record) : record) });
            });
        }
        // Result entrypoint reconciles durable state; callers cannot assert a write succeeded.
        return Object.freeze({ drain, status: (payload, options) => serial(() => readStatus(payload, options)), retry, resolve, result: retry, mirror: (payload, options) => drain({ account_key: payload.account_key, source_ref: payload.source_ref, writebacks: [{ ...payload, operation: "create", target_account: payload.account_key }] }, options) });
    }
    return Object.freeze({ CONTRACT_VERSION, normalizeIntent, responseIntents, createWritebackService });
}));
