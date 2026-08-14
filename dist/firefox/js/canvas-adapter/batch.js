(function (root, factory) {
    "use strict";

    const identity = root?.APStudyCanvasCanvasAdapter?.Identity || (typeof require === "function" ? require("./identity.js") : null);
    const contracts = root?.APStudyCanvasCanvasAdapter?.Contracts || (typeof require === "function" ? require("./contracts.js") : null);
    const api = factory(identity, contracts);
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasCanvasAdapter = Object.assign(root.APStudyCanvasCanvasAdapter || {}, { Batch: api });
}(typeof globalThis !== "undefined" ? globalThis : this, function (identity, contracts) {
    "use strict";

    const VERSION = 1;
    const MAX_ITEMS = Number(contracts?.MAX_BATCH_ITEMS || 100);
    const MAX_BYTES = Number(contracts?.MAX_BATCH_BYTES || 512 * 1024);
    const SECRET_FIELD = /(?:access[_-]?token|refresh[_-]?token|id[_-]?token|oauth(?:2)?[_-]?token|authorization|bearer|password|passwd|secret|credential|api[_-]?key|client[_-]?secret|private[_-]?ics|raw[_-]?email|set[-_]?cookie)/i;

    function stableStringify(value) {
        if (value === undefined) return "null";
        if (value === null || typeof value !== "object") {
            if (typeof value === "number" && !Number.isFinite(value)) return "null";
            return JSON.stringify(value);
        }
        if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
    }

    function bytes(text) {
        if (typeof TextEncoder === "function") return new TextEncoder().encode(text).length;
        try { return unescape(encodeURIComponent(text)).length; } catch (error) { return Number.POSITIVE_INFINITY; }
    }

    function checksum(value) {
        if (identity?.sha256HexSync) return identity.sha256HexSync(stableStringify(value));
        let output = 2166136261;
        for (const character of stableStringify(value)) output = Math.imul(output ^ character.charCodeAt(0), 16777619) >>> 0;
        return output.toString(16).padStart(8, "0");
    }

    function safeItem(value, seen = new Set()) {
        if (value === null || typeof value === "string" || typeof value === "boolean") return value;
        if (typeof value === "number") return Number.isFinite(value) ? value : null;
        if (typeof value === "bigint") return String(value);
        if (typeof value !== "object" || seen.has(value)) return null;
        seen.add(value);
        if (Array.isArray(value)) {
            const result = value.map((item) => safeItem(item, seen));
            seen.delete(value);
            return result;
        }
        const result = {};
        Object.keys(value).sort().forEach((key) => {
            if (SECRET_FIELD.test(key)) return;
            const child = safeItem(value[key], seen);
            if (child !== undefined) result[key] = child;
        });
        seen.delete(value);
        return result;
    }

    function itemSortKey(item) {
        return String(item?.eventRef || item?.event_ref || item?.source?.key || item?.key || checksum(item));
    }

    function makeBody(items) {
        return stableStringify({ items });
    }

    function buildBatches(input = [], { maxItems = MAX_ITEMS, maxBytes = MAX_BYTES } = {}) {
        if (!Array.isArray(input)) return { ok: false, state: "invalid", code: "CANVAS_BATCH_ITEMS_REQUIRED" };
        const itemLimit = Math.min(MAX_ITEMS, Math.max(1, Number(maxItems) || MAX_ITEMS));
        const byteLimit = Math.min(MAX_BYTES, Math.max(1, Number(maxBytes) || MAX_BYTES));
        const prepared = input.map((item, originalIndex) => ({ item: safeItem(item), originalIndex }));
        prepared.sort((left, right) => itemSortKey(left.item).localeCompare(itemSortKey(right.item)) || left.originalIndex - right.originalIndex);
        const batches = [];
        const quarantined = [];
        let current = [];
        const flush = () => {
            if (!current.length) return;
            const body = makeBody(current);
            batches.push({ index: batches.length, items: current, body, byte_length: bytes(body), item_count: current.length, checksum: checksum(current) });
            current = [];
        };
        for (const entry of prepared) {
            const singleBody = makeBody([entry.item]);
            const singleBytes = bytes(singleBody);
            if (singleBytes > byteLimit) {
                flush();
                quarantined.push({ original_index: entry.originalIndex, reason: "item_too_large", item: entry.item, byte_length: singleBytes, checksum: checksum(entry.item) });
                continue;
            }
            const candidate = current.concat([entry.item]);
            if (current.length >= itemLimit || bytes(makeBody(candidate)) > byteLimit) flush();
            current.push(entry.item);
        }
        flush();
        const acceptedItems = batches.flatMap((batch) => batch.items);
        const result = {
            ok: true,
            state: "batched",
            version: VERSION,
            batches,
            quarantined,
            input_item_count: input.length,
            item_count: acceptedItems.length,
            quarantined_count: quarantined.length,
            checksum: checksum(acceptedItems),
            input_checksum: checksum(prepared.map((entry) => entry.item)),
            limits: { max_items: itemLimit, max_bytes: byteLimit }
        };
        return result;
    }

    function buildBatch(input, options) { return buildBatches(input, options); }

    return Object.freeze({
        VERSION,
        MAX_ITEMS,
        MAX_BYTES,
        stableStringify,
        safeItem,
        checksum,
        buildBatches,
        buildBatch,
        createBatches: buildBatches
    });
}));
