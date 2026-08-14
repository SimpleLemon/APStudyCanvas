(function (root, factory) {
    "use strict";

    const api = factory();
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasCanvasAdapter = Object.assign(root.APStudyCanvasCanvasAdapter || {}, { Identity: api });
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const SHA256_K = new Uint32Array([
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
    ]);

    function utf8Bytes(value) {
        const text = String(value);
        if (typeof TextEncoder === "function") return new TextEncoder().encode(text);
        const output = [];
        for (let index = 0; index < text.length; index += 1) {
            let code = text.charCodeAt(index);
            if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
                const next = text.charCodeAt(index + 1);
                if (next >= 0xdc00 && next <= 0xdfff) {
                    code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
                    index += 1;
                }
            }
            if (code < 0x80) output.push(code);
            else if (code < 0x800) output.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
            else if (code < 0x10000) output.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
            else output.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
        }
        return Uint8Array.from(output);
    }

    function rightRotate(value, amount) { return (value >>> amount) | (value << (32 - amount)); }

    function sha256Bytes(input) {
        const bytes = input instanceof Uint8Array ? input : Uint8Array.from(input || []);
        const bitLength = bytes.length * 8;
        const paddedLength = ((bytes.length + 9 + 63) >> 6) << 6;
        const padded = new Uint8Array(paddedLength);
        padded.set(bytes);
        padded[bytes.length] = 0x80;
        const view = new DataView(padded.buffer);
        const highLength = Math.floor(bitLength / 0x100000000);
        const lowLength = bitLength >>> 0;
        view.setUint32(paddedLength - 8, highLength >>> 0);
        view.setUint32(paddedLength - 4, lowLength);

        let h0 = 0x6a09e667;
        let h1 = 0xbb67ae85;
        let h2 = 0x3c6ef372;
        let h3 = 0xa54ff53a;
        let h4 = 0x510e527f;
        let h5 = 0x9b05688c;
        let h6 = 0x1f83d9ab;
        let h7 = 0x5be0cd19;
        const schedule = new Uint32Array(64);

        for (let offset = 0; offset < padded.length; offset += 64) {
            for (let index = 0; index < 16; index += 1) schedule[index] = view.getUint32(offset + index * 4);
            for (let index = 16; index < 64; index += 1) {
                const value0 = rightRotate(schedule[index - 15], 7) ^ rightRotate(schedule[index - 15], 18) ^ (schedule[index - 15] >>> 3);
                const value1 = rightRotate(schedule[index - 2], 17) ^ rightRotate(schedule[index - 2], 19) ^ (schedule[index - 2] >>> 10);
                schedule[index] = (schedule[index - 16] + value0 + schedule[index - 7] + value1) >>> 0;
            }

            let a = h0;
            let b = h1;
            let c = h2;
            let d = h3;
            let e = h4;
            let f = h5;
            let g = h6;
            let h = h7;
            for (let index = 0; index < 64; index += 1) {
                const sigma1 = rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25);
                const choice = (e & f) ^ (~e & g);
                const temp1 = (h + sigma1 + choice + SHA256_K[index] + schedule[index]) >>> 0;
                const sigma0 = rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22);
                const majority = (a & b) ^ (a & c) ^ (b & c);
                const temp2 = (sigma0 + majority) >>> 0;
                h = g;
                g = f;
                f = e;
                e = (d + temp1) >>> 0;
                d = c;
                c = b;
                b = a;
                a = (temp1 + temp2) >>> 0;
            }
            h0 = (h0 + a) >>> 0;
            h1 = (h1 + b) >>> 0;
            h2 = (h2 + c) >>> 0;
            h3 = (h3 + d) >>> 0;
            h4 = (h4 + e) >>> 0;
            h5 = (h5 + f) >>> 0;
            h6 = (h6 + g) >>> 0;
            h7 = (h7 + h) >>> 0;
        }

        const digest = new Uint8Array(32);
        const result = [h0, h1, h2, h3, h4, h5, h6, h7];
        result.forEach((value, index) => new DataView(digest.buffer).setUint32(index * 4, value));
        return digest;
    }

    function bytesToHex(bytes) { return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join(""); }

    function stableStringify(value) {
        if (value === null || typeof value !== "object") return JSON.stringify(value);
        if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
        const keys = Object.keys(value).sort();
        return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
    }

    async function sha256Hex(value, { cryptoImpl = typeof globalThis !== "undefined" ? globalThis.crypto : null, forceFallback = false } = {}) {
        const bytes = utf8Bytes(value);
        if (!forceFallback && cryptoImpl?.subtle?.digest) {
            try {
                const digest = await cryptoImpl.subtle.digest("SHA-256", bytes);
                return bytesToHex(new Uint8Array(digest));
            } catch (error) {
                // The deterministic local implementation is also the browser test fallback.
            }
        }
        return bytesToHex(sha256Bytes(bytes));
    }

    function sha256HexSync(value) { return bytesToHex(sha256Bytes(utf8Bytes(value))); }

    function normalizeCanvasOrigin(value) {
        if (typeof value !== "string" || !value.trim()) return null;
        try {
            const url = new URL(value.trim());
            if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
            if (url.pathname !== "" && url.pathname !== "/") return null;
            if (!url.hostname || url.hostname.includes("..")) return null;
            return url.origin;
        } catch (error) {
            return null;
        }
    }

    function normalizeUserId(value) {
        if (typeof value !== "string" && typeof value !== "number") return null;
        const result = String(value);
        // Canvas documents integer IDs, including 64-bit IDs. Do not accept a
        // display name, SIS label, or opaque caller-provided account token here.
        if (!/^[1-9]\d{0,19}$/.test(result)) return null;
        if (typeof value === "number" && !Number.isSafeInteger(value)) return null;
        return result;
    }

    function normalizeAccount({ origin, userId, user_id } = {}) {
        const normalizedOrigin = normalizeCanvasOrigin(origin);
        const normalizedUserId = normalizeUserId(userId ?? user_id);
        if (!normalizedOrigin || !normalizedUserId) return null;
        return { origin: normalizedOrigin, userId: normalizedUserId };
    }

    async function accountKey({ origin, userId, user_id, cryptoImpl, forceFallback } = {}) {
        const account = normalizeAccount({ origin, userId, user_id });
        if (!account) return null;
        return sha256Hex(`canvas-account-v${1}\u0000${account.origin}\u0000${account.userId}`, { cryptoImpl, forceFallback });
    }

    function encodeSegment(value) { return encodeURIComponent(String(value)); }

    function keySegment(value) {
        if (typeof value !== "string" && typeof value !== "number") return null;
        if (typeof value === "number" && !Number.isSafeInteger(value)) return null;
        const result = String(value).trim();
        if (!result || result.length > 256 || /[\u0000-\u001f\u007f]/.test(result)) return null;
        return result;
    }

    function canvasIdSegment(value) {
        if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
        if (typeof value !== "string" || !/^[1-9]\d{0,19}$/.test(value)) return null;
        return value;
    }

    function sourceItemKey({ type, contextId, calendarId, remoteId, occurrenceId } = {}) {
        const normalizedType = keySegment(type);
        const context = keySegment(contextId ?? calendarId);
        const remote = canvasIdSegment(remoteId);
        const occurrence = canvasIdSegment(occurrenceId);
        // The key is exactly the four contract components. There is no
        // synthetic "base" fallback: an official stable occurrence is needed.
        if (!normalizedType || !context || !remote || !occurrence) return null;
        return [normalizedType, context, remote, occurrence].map(encodeSegment).join(":");
    }

    async function buildEventRef({ accountKey: sourceHash, sourceHash: explicitSourceHash, sourceItemKey: itemKey, itemHash } = {}) {
        const source = sourceHash || explicitSourceHash;
        if (!/^[a-f0-9]{64}$/i.test(String(source || "")) || typeof itemKey !== "string" || !itemKey) return null;
        const item = await sha256Hex(itemKey);
        if (itemHash !== undefined && String(itemHash).toLowerCase() !== item) return null;
        return `canvas:${String(source).toLowerCase()}:${item}`;
    }

    async function verifyEventRef({ eventRef, accountKey, sourceItemKey } = {}) {
        if (typeof eventRef !== "string" || !/^canvas:[a-f0-9]{64}:[a-f0-9]{64}$/.test(eventRef)) return false;
        if (typeof sourceItemKey !== "string" || !sourceItemKey || !/^[a-f0-9]{64}$/.test(String(accountKey || ""))) return false;
        const expected = await buildEventRef({ accountKey, sourceItemKey });
        return expected === eventRef;
    }

    function safeCorrelationId(value) {
        const candidate = String(value || "").trim();
        // Correlation IDs are telemetry. Hash all caller input so a raw Canvas
        // user/context/item ID can never be returned as telemetry.
        return `c-${sha256HexSync(candidate || String(Date.now())).slice(0, 24)}`;
    }

    function actualAccountFrom(value) {
        if (!value || typeof value !== "object") return null;
        return normalizeAccount({ origin: value.origin || value.canvasOrigin, userId: value.userId ?? value.user_id ?? value.canvasUser?.id ?? value.user?.id });
    }

    async function revalidateAccount({ expectedOrigin, expectedUserId, actual, verifyContext, cryptoImpl, forceFallback } = {}) {
        const expected = normalizeAccount({ origin: expectedOrigin, userId: expectedUserId });
        if (!expected) return { ok: false, state: "waiting", code: "CANVAS_ACCOUNT_EXPECTED_INVALID" };
        let observed = actual;
        if (typeof verifyContext === "function") {
            try { observed = await verifyContext({ expectedOrigin: expected.origin, expectedUserId: expected.userId }); }
            catch (error) { return { ok: false, state: "waiting", code: "CANVAS_ACCOUNT_VERIFICATION_WAITING" }; }
        }
        if (observed?.state === "waiting" || observed?.state === "signed_out" || observed?.ok === false && !observed.origin) {
            return { ok: false, state: "waiting", code: observed.code || "CANVAS_ACCOUNT_VERIFICATION_WAITING" };
        }
        if (observed?.state === "mismatch") return { ok: false, state: "mismatch", code: observed.code || "CANVAS_ACCOUNT_MISMATCH" };
        const current = actualAccountFrom(observed);
        if (!current) return { ok: false, state: "waiting", code: "CANVAS_ACCOUNT_VERIFICATION_WAITING" };
        if (current.origin !== expected.origin) return { ok: false, state: "mismatch", code: "CANVAS_ORIGIN_MISMATCH" };
        if (current.userId !== expected.userId) return { ok: false, state: "mismatch", code: "CANVAS_USER_ID_MISMATCH" };
        return {
            ok: true,
            state: "verified",
            origin: current.origin,
            userId: current.userId,
            accountKey: await accountKey({ origin: current.origin, userId: current.userId, cryptoImpl, forceFallback })
        };
    }

    return Object.freeze({
        utf8Bytes,
        sha256Bytes,
        sha256Hex,
        sha256HexSync,
        stableStringify,
        normalizeCanvasOrigin,
        normalizeUserId,
        normalizeAccount,
        accountKey,
        sourceItemKey,
        buildEventRef,
        verifyEventRef,
        safeCorrelationId,
        actualAccountFrom,
        revalidateAccount
    });
}));
