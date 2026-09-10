(function (root, factory) {
    "use strict";

    const adapter = root?.APStudyCanvasCanvasAdapter?.Writeback || (typeof require === "function" ? require("../canvas-adapter/writeback.js") : null);
    const api = factory(adapter);
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasPlatform = Object.assign(root.APStudyCanvasPlatform || {}, { WritebackMirrors: api });
}(typeof globalThis !== "undefined" ? globalThis : this, function (adapter) {
    "use strict";

    const STORAGE_KEY = "platform.writebackMirrors";
    const VERSION = 1;
    const ACCOUNT = /^[a-f0-9]{64}$/;
    const SOURCE_REF = /^src1:[A-Za-z0-9._~-]{1,128}$/;
    const MAX_ITEMS_PER_ACCOUNT = 100;

    function clone(value) {
        if (value === undefined) return undefined;
        if (typeof structuredClone === "function") return structuredClone(value);
        return JSON.parse(JSON.stringify(value));
    }

    function emptyStore() { return { version: VERSION, accounts: {} }; }

    function validStore(value) {
        if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== VERSION || !value.accounts || typeof value.accounts !== "object" || Array.isArray(value.accounts)) return false;
        return Object.entries(value.accounts).every(([accountKey, account]) => ACCOUNT.test(accountKey)
            && account && typeof account === "object" && !Array.isArray(account)
            && SOURCE_REF.test(String(account.source_ref || ""))
            && account.items && typeof account.items === "object" && !Array.isArray(account.items));
    }

    async function read(storage) {
        const current = await storage.get("local", STORAGE_KEY);
        const value = current[STORAGE_KEY];
        return validStore(value) ? clone(value) : emptyStore();
    }

    async function write(storage, value) {
        await storage.set("local", { [STORAGE_KEY]: value });
        return value;
    }

    async function captureSelected({ storage, accountKey, sourceRef, items = [], now = () => Date.now() } = {}) {
        if (!storage || typeof storage.get !== "function" || typeof storage.set !== "function") throw new Error("WRITEBACK_STORAGE_REQUIRED");
        if (!ACCOUNT.test(String(accountKey || ""))) return { ok: false, code: "CANVAS_ACCOUNT_KEY_INVALID", mirrors: [] };
        if (!SOURCE_REF.test(String(sourceRef || ""))) return { ok: false, code: "NEST_SOURCE_REF_INVALID", mirrors: [] };
        if (!Array.isArray(items) || items.length > MAX_ITEMS_PER_ACCOUNT) return { ok: false, code: "WRITEBACK_SELECTED_ITEMS_INVALID", mirrors: [] };
        const accepted = [];
        const rejected = [];
        for (const item of items) {
            const result = adapter?.classifyNormalizedItem?.(item, accountKey);
            if (result?.ok) accepted.push(result.value);
            else rejected.push({ code: result?.code || "WRITEBACK_ITEM_INVALID" });
        }
        const store = await read(storage);
        const account = store.accounts[accountKey] && store.accounts[accountKey].source_ref === sourceRef
            ? clone(store.accounts[accountKey])
            : { source_ref: sourceRef, updated_at: 0, items: {} };
        const stamp = now();
        accepted.forEach((mirror) => { account.items[mirror.event_ref] = { ...mirror, selected_at: stamp }; });
        const ordered = Object.values(account.items).sort((left, right) => Number(right.selected_at || 0) - Number(left.selected_at || 0) || left.event_ref.localeCompare(right.event_ref));
        account.items = Object.fromEntries(ordered.slice(0, MAX_ITEMS_PER_ACCOUNT).map((item) => [item.event_ref, item]));
        account.updated_at = stamp;
        store.accounts[accountKey] = account;
        await write(storage, store);
        return { ok: true, mirrors: accepted, rejected, mirrored_count: accepted.length };
    }

    async function getMirrors({ storage, accountKey, sourceRef } = {}) {
        if (!storage || typeof storage.get !== "function") throw new Error("WRITEBACK_STORAGE_REQUIRED");
        if (!ACCOUNT.test(String(accountKey || "")) || !SOURCE_REF.test(String(sourceRef || ""))) return {};
        const store = await read(storage);
        const account = store.accounts[accountKey];
        return account?.source_ref === sourceRef && account.items ? clone(account.items) : {};
    }

    async function updateMirror({ storage, accountKey, sourceRef, mirror, now = () => Date.now() } = {}) {
        if (!mirror?.event_ref) return { ok: false, code: "WRITEBACK_MIRROR_INVALID" };
        const store = await read(storage);
        const account = store.accounts[accountKey] && store.accounts[accountKey].source_ref === sourceRef
            ? clone(store.accounts[accountKey])
            : { source_ref: sourceRef, updated_at: 0, items: {} };
        account.items[mirror.event_ref] = { ...mirror, selected_at: now(), reconciled_at: now() };
        store.accounts[accountKey] = account;
        await write(storage, store);
        return { ok: true };
    }

    return Object.freeze({
        VERSION,
        STORAGE_KEY,
        MAX_ITEMS_PER_ACCOUNT,
        captureSelected,
        getMirrors,
        updateMirror
    });
}));
