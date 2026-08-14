(function (root, factory) {
    "use strict";

    const security = root?.APStudyCanvasPlatform?.Security || (typeof require === "function" ? require("./security.js") : null);
    const schema = root?.APStudyCanvasSchema || (typeof require === "function" ? require("../settings-schema.js") : null);
    const contract = root?.APStudyCanvasPlatform?.Contract || (typeof require === "function" ? require("./contract.js") : null);
    const api = factory(security, schema, contract);
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasPlatform = Object.assign(root.APStudyCanvasPlatform || {}, { Storage: api });
}(typeof globalThis !== "undefined" ? globalThis : this, function (security, schema, contract) {
    "use strict";

    const PLATFORM_SYNC_KEYS = Object.freeze([
        "platform.preferences",
        "platform.ui",
        "platform.routing",
        "gradient_cards",
        "gradent_cards",
        "custom_domain"
    ]);
    const PLATFORM_LOCAL_KEYS = Object.freeze([
        "platform.accountMetadata",
        "platform.sourceMetadata",
        "platform.migration",
        "platform.syncSummaries",
        "platform.flags",
        "platform.sanitizedErrors",
        "platform.revocationSummaries"
    ]);
    const PLATFORM_SESSION_KEYS = Object.freeze([
        "platform.tabWindowMappings",
        "platform.workspaceContext",
        "platform.currentProfile",
        "platform.csrfState"
    ]);
    const SAFE_KEYS = Object.freeze({
        sync: new Set([...PLATFORM_SYNC_KEYS, ...(schema?.settingKeysForArea?.("sync") || [])]),
        local: new Set([...PLATFORM_LOCAL_KEYS, ...(schema?.settingKeysForArea?.("local") || [])]),
        session: new Set(PLATFORM_SESSION_KEYS)
    });
    const AREA_LIMITS = Object.freeze({ sync: 8192, local: 64 * 1024, session: 32 * 1024 });
    const ALIAS_GROUPS = Object.freeze([
        Object.freeze(["gradient_cards", "gradent_cards"])
    ]);
    const SOURCE_METADATA_KEY = "platform.sourceMetadata";
    const SOURCE_METADATA_ACCOUNT = /^[a-f0-9]{64}$/;
    const SOURCE_METADATA_REF = /^src1:[A-Za-z0-9._~-]{1,128}$/;
    const SOURCE_METADATA_ORIGIN = /^https:\/\/[^\s/?#]+$/;
    const SOURCE_METADATA_TEXT = /^[A-Za-z0-9][A-Za-z0-9 ._:/@()&+-]{0,255}$/;
    const SOURCE_METADATA_NEST_USER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
    const SOURCE_METADATA_MAX_ACCOUNTS = 64;
    const SOURCE_METADATA_MAX_BYTES = 8192;

    function hasOwn(object, key) {
        return Object.prototype.hasOwnProperty.call(object || {}, key);
    }

    function clone(value) {
        if (value === undefined) return undefined;
        if (typeof structuredClone === "function") return structuredClone(value);
        return JSON.parse(JSON.stringify(value));
    }

    function jsonBytes(value) {
        const serialized = JSON.stringify(value);
        if (typeof TextEncoder === "function") return new TextEncoder().encode(serialized).length;
        return unescape(encodeURIComponent(serialized)).length;
    }

    function containsSensitiveKey(key) {
        return security.isSensitiveKey(key);
    }

    function containsSensitiveValue(value, path = "") {
        return Boolean(security.findSensitiveData(value, path));
    }

    function assertSafeValue(value, area, key) {
        if (area === "local" && key === SOURCE_METADATA_KEY) validateSourceMetadata(value);
        if (containsSensitiveKey(key) || containsSensitiveValue(value, key)) {
            throw new Error("PLATFORM_SECRET_STORAGE_FORBIDDEN");
        }
        const size = jsonBytes(value);
        if (!Number.isFinite(size) || size > (AREA_LIMITS[area] || AREA_LIMITS.local)) throw new Error("PLATFORM_STORAGE_VALUE_TOO_LARGE");
        return true;
    }

    function validMetadataText(value, max = 256) {
        return typeof value === "string" && value.length > 0 && value.length <= max && SOURCE_METADATA_TEXT.test(value)
            && !/[\u0000-\u001f\u007f]/.test(value);
    }

    function validateSourceMetadata(value) {
        if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== 1
            || !value.accounts || typeof value.accounts !== "object" || Array.isArray(value.accounts)) {
            throw new Error("PLATFORM_SOURCE_METADATA_INVALID");
        }
        const accounts = Object.entries(value.accounts);
        if (accounts.length > SOURCE_METADATA_MAX_ACCOUNTS) throw new Error("PLATFORM_SOURCE_METADATA_INVALID");
        const allowed = new Set(["source_ref", "source_key", "origin", "nest_user_id", "canvas_user_id", "provider_user_id", "label", "active", "archived", "routing_eligible"]);
        const sourceRefs = new Set();
        for (const [accountKey, record] of accounts) {
            if (!SOURCE_METADATA_ACCOUNT.test(accountKey) || !record || typeof record !== "object" || Array.isArray(record)
                || Object.keys(record).some((key) => !allowed.has(key))
                || !SOURCE_METADATA_REF.test(record.source_ref)
                || sourceRefs.has(record.source_ref)
                || record.source_key !== `canvas:${accountKey}`
                || !SOURCE_METADATA_ORIGIN.test(record.origin)
                || typeof record.nest_user_id !== "string"
                || !SOURCE_METADATA_NEST_USER_ID.test(record.nest_user_id)
                || !validMetadataText(record.provider_user_id)
                || !validMetadataText(record.label)
                || (record.canvas_user_id !== undefined && !validMetadataText(String(record.canvas_user_id), 128))
                || (record.active !== undefined && typeof record.active !== "boolean")
                || (record.archived !== undefined && typeof record.archived !== "boolean")
                || (record.routing_eligible !== undefined && typeof record.routing_eligible !== "boolean")) {
                throw new Error("PLATFORM_SOURCE_METADATA_INVALID");
            }
            sourceRefs.add(record.source_ref);
        }
        if (jsonBytes(value) > SOURCE_METADATA_MAX_BYTES) throw new Error("PLATFORM_SOURCE_METADATA_INVALID");
        return true;
    }

    function assertAllowedKey(area, key) {
        if (!SAFE_KEYS[area]?.has(key) && !schema?.isSettingKeyAllowed?.(area, key)) throw new Error("PLATFORM_STORAGE_KEY_FORBIDDEN");
        return true;
    }

    function settingsArea(area) {
        if (area !== "sync" && area !== "local") throw new Error("SETTINGS_AREA_UNSUPPORTED");
        return area;
    }

    function settingKeyAllowed(area, key) {
        return Boolean(schema?.isSettingKeyAllowed?.(area, key));
    }

    function settingFailure(key, code, message) {
        return { ok: false, code, ...(message ? { message } : {}) };
    }

    function validateSettingEntry(area, key, value) {
        if (typeof key !== "string" || !settingKeyAllowed(area, key)) return settingFailure(key, "SETTINGS_KEY_FORBIDDEN");
        const validation = schema?.validateSettingValue?.(area, key, value);
        return validation?.valid === false
            ? settingFailure(key, validation.code || "SETTINGS_VALUE_INVALID", validation.message)
            : { ok: true, value: clone(validation?.value === undefined ? value : validation.value) };
    }

    function validateSettingKeys(area, keys) {
        settingsArea(area);
        if (!Array.isArray(keys) || !keys.length || keys.some((key) => typeof key !== "string")) throw new Error("SETTINGS_KEYS_REQUIRED");
        return Array.from(new Set(keys));
    }

    function failureMap(keys, code, message) {
        return Object.fromEntries(keys.map((key) => [key, settingFailure(key, code, message)]));
    }

    function normalizeLegacyAliases(values) {
        const source = values && typeof values === "object" ? values : {};
        const changes = {};
        const result = {};
        ALIAS_GROUPS.forEach((group) => {
            const canonical = group[0];
            const sourceKey = group.find((key) => hasOwn(source, key));
            if (!sourceKey) return;
            const value = clone(source[sourceKey]);
            result[canonical] = value;
            group.forEach((key) => {
                if (!hasOwn(source, key)) changes[key] = clone(value);
            });
        });
        return { values: result, changes };
    }

    function sanitizeError(error, fallbackCode = "PLATFORM_ERROR") {
        const status = Number.isInteger(error?.status) ? error.status : undefined;
        const rawCode = typeof error?.code === "string" ? error.code : fallbackCode;
        const code = rawCode.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 80) || fallbackCode;
        const rawMessage = typeof error?.message === "string" ? error.message : "Platform operation failed.";
        const message = security.hasCredentialLikeScalar(rawMessage) ? "Platform operation failed; sensitive details were redacted." : rawMessage.slice(0, 200);
        return { code, ...(status === undefined ? {} : { status }), message };
    }

    function createChromeStorageAdapter(storageApi) {
        if (!storageApi) throw new Error("PLATFORM_STORAGE_API_UNAVAILABLE");

        function areaApi(area) {
            const api = storageApi[area];
            if (!api || typeof api.get !== "function" || typeof api.set !== "function") throw new Error("PLATFORM_STORAGE_AREA_UNAVAILABLE");
            return api;
        }

        async function get(area, keys) {
            const api = areaApi(area);
            const requested = Array.isArray(keys) ? keys : [keys];
            requested.filter((key) => key !== null && key !== undefined).forEach((key) => assertAllowedKey(area, key));
            const result = await api.get(requested.length === 1 ? requested[0] : requested);
            return result || {};
        }

        async function set(area, values) {
            if (!values || typeof values !== "object" || Array.isArray(values)) throw new Error("PLATFORM_STORAGE_OBJECT_REQUIRED");
            const entries = Object.entries(values);
            entries.forEach(([key, value]) => {
                assertAllowedKey(area, key);
                assertSafeValue(value, area, key);
            });
            if (jsonBytes(values) > (AREA_LIMITS[area] || AREA_LIMITS.local)) throw new Error("PLATFORM_STORAGE_BATCH_TOO_LARGE");
            await areaApi(area).set(values);
            return { ok: true };
        }

        async function remove(area, keys) {
            const list = Array.isArray(keys) ? keys : [keys];
            list.forEach((key) => assertAllowedKey(area, key));
            if (typeof areaApi(area).remove !== "function") throw new Error("PLATFORM_STORAGE_REMOVE_UNAVAILABLE");
            await areaApi(area).remove(list.length === 1 ? list[0] : list);
            return { ok: true };
        }

        async function settingsRead(area, keys) {
            const requested = validateSettingKeys(area, keys);
            const results = {};
            const allowed = requested.filter((key) => settingKeyAllowed(area, key));
            requested.filter((key) => !settingKeyAllowed(area, key)).forEach((key) => { results[key] = settingFailure(key, "SETTINGS_KEY_FORBIDDEN"); });
            if (allowed.length !== requested.length) return { ok: false, area, code: "SETTINGS_KEY_FORBIDDEN", values: {}, results };
            const values = await get(area, requested);
            requested.forEach((key) => { results[key] = { ok: true, present: hasOwn(values, key) }; });
            return { ok: true, area, values, results };
        }

        async function settingsUpdate(area, changes, { requireUserGesture = false } = {}) {
            settingsArea(area);
            if (!changes || typeof changes !== "object" || Array.isArray(changes)) throw new Error("SETTINGS_CHANGES_REQUIRED");
            const requested = Object.keys(changes);
            if (!requested.length) throw new Error("SETTINGS_CHANGES_REQUIRED");
            const results = {};
            const normalized = {};
            const canonicalValues = {};
            let hasFailure = false;
            for (const key of requested) {
                if (key === "custom_domain" && requireUserGesture !== true) {
                    results[key] = settingFailure(key, "SETTINGS_USER_GESTURE_REQUIRED");
                    hasFailure = true;
                    continue;
                }
                const validation = validateSettingEntry(area, key, changes[key]);
                if (!validation.ok) {
                    results[key] = validation;
                    hasFailure = true;
                    continue;
                }
                const canonical = schema?.canonicalKey?.(key) || key;
                if (Object.prototype.hasOwnProperty.call(canonicalValues, canonical) && JSON.stringify(canonicalValues[canonical]) !== JSON.stringify(validation.value)) {
                    results[key] = settingFailure(key, "SETTINGS_ALIAS_CONFLICT");
                    hasFailure = true;
                    continue;
                }
                canonicalValues[canonical] = validation.value;
                normalized[key] = validation.value;
            }
            if (hasFailure) {
                requested.filter((key) => !results[key]).forEach((key) => { results[key] = settingFailure(key, "SETTINGS_TRANSACTION_REJECTED"); });
                return { ok: false, area, code: "SETTINGS_VALIDATION_FAILED", results };
            }
            Object.entries(normalized).forEach(([key, value]) => {
                const aliases = schema?.getAliasKeys?.(key) || [key];
                aliases.forEach((alias) => { normalized[alias] = clone(value); });
            });
            const expanded = Object.fromEntries(Object.entries(normalized));
            try {
                await set(area, expanded);
            } catch (error) {
                const failure = sanitizeError(error, "SETTINGS_UPDATE_FAILED");
                return { ok: false, area, code: failure.code, results: failureMap(requested, failure.code, failure.message) };
            }
            requested.forEach((key) => { results[key] = { ok: true, status: "success" }; });
            return { ok: true, area, changed: requested, results };
        }

        async function settingsReset(area, keys) {
            const requested = validateSettingKeys(area, keys);
            const results = {};
            const expanded = new Set();
            requested.forEach((key) => {
                if (!settingKeyAllowed(area, key)) results[key] = settingFailure(key, "SETTINGS_KEY_FORBIDDEN");
                else (schema?.getAliasKeys?.(key) || [key]).forEach((alias) => expanded.add(alias));
            });
            if (Object.keys(results).length) return { ok: false, area, code: "SETTINGS_KEY_FORBIDDEN", results };
            try {
                await remove(area, Array.from(expanded));
            } catch (error) {
                const failure = sanitizeError(error, "SETTINGS_RESET_FAILED");
                return { ok: false, area, code: failure.code, results: failureMap(requested, failure.code, failure.message) };
            }
            requested.forEach((key) => { results[key] = { ok: true, status: "reset" }; });
            return { ok: true, area, reset: requested, results };
        }

        async function migrateLegacyAliases() {
            const values = await get("sync", ["gradient_cards", "gradent_cards"]);
            const migration = normalizeLegacyAliases(values);
            if (Object.keys(migration.changes).length) await set("sync", migration.changes);
            return migration;
        }

        async function readFlags(defaults) {
            const stored = await get("local", "platform.flags");
            return typeof contract?.normalizeFeatureFlags === "function"
                ? contract.normalizeFeatureFlags(stored["platform.flags"], defaults || contract.FEATURE_FLAGS)
                : Object.assign({}, defaults || {}, stored["platform.flags"] || {});
        }

        return Object.freeze({ get, set, remove, settingsRead, settingsUpdate, settingsReset, migrateLegacyAliases, readFlags, limits: AREA_LIMITS });
    }

    function createMemoryStorage(initial = {}) {
        const areas = {
            sync: Object.assign({}, initial.sync || {}),
            local: Object.assign({}, initial.local || {}),
            session: Object.assign({}, initial.session || {})
        };
        const adapter = {
            async get(area, keys) {
                const requested = Array.isArray(keys) ? keys : [keys];
                requested.forEach((key) => assertAllowedKey(area, key));
                return Object.fromEntries(requested.filter((key) => hasOwn(areas[area], key)).map((key) => [key, clone(areas[area][key])]));
            },
            async set(area, values) {
                Object.entries(values).forEach(([key, value]) => {
                    assertAllowedKey(area, key);
                    assertSafeValue(value, area, key);
                    areas[area][key] = clone(value);
                });
                return { ok: true };
            },
            async remove(area, keys) {
                (Array.isArray(keys) ? keys : [keys]).forEach((key) => {
                    assertAllowedKey(area, key);
                    delete areas[area][key];
                });
                return { ok: true };
            },
            async migrateLegacyAliases() {
                const migration = normalizeLegacyAliases(areas.sync);
                Object.assign(areas.sync, migration.changes);
                return migration;
            },
            async readFlags(defaults) {
                return typeof contract?.normalizeFeatureFlags === "function"
                    ? contract.normalizeFeatureFlags(areas.local["platform.flags"], defaults || contract.FEATURE_FLAGS)
                    : Object.assign({}, defaults || {}, areas.local["platform.flags"] || {});
            },
            async settingsRead(area, keys) {
                const requested = validateSettingKeys(area, keys);
                const results = {};
                const invalid = requested.filter((key) => !settingKeyAllowed(area, key));
                invalid.forEach((key) => { results[key] = settingFailure(key, "SETTINGS_KEY_FORBIDDEN"); });
                if (invalid.length) return { ok: false, area, code: "SETTINGS_KEY_FORBIDDEN", values: {}, results };
                const values = Object.fromEntries(requested.filter((key) => hasOwn(areas[area], key)).map((key) => [key, clone(areas[area][key])]));
                requested.forEach((key) => { results[key] = { ok: true, present: hasOwn(values, key) }; });
                return { ok: true, area, values, results };
            },
            async settingsUpdate(area, changes, options = {}) {
                settingsArea(area);
                if (!changes || typeof changes !== "object" || Array.isArray(changes)) throw new Error("SETTINGS_CHANGES_REQUIRED");
                const requested = Object.keys(changes);
                const results = {};
                const normalized = {};
                const canonicalValues = {};
                let hasFailure = false;
                for (const key of requested) {
                    if (key === "custom_domain" && options.requireUserGesture !== true) { results[key] = settingFailure(key, "SETTINGS_USER_GESTURE_REQUIRED"); hasFailure = true; continue; }
                    const validation = validateSettingEntry(area, key, changes[key]);
                    if (!validation.ok) { results[key] = validation; hasFailure = true; continue; }
                    const canonical = schema?.canonicalKey?.(key) || key;
                    if (Object.prototype.hasOwnProperty.call(canonicalValues, canonical) && JSON.stringify(canonicalValues[canonical]) !== JSON.stringify(validation.value)) { results[key] = settingFailure(key, "SETTINGS_ALIAS_CONFLICT"); hasFailure = true; continue; }
                    canonicalValues[canonical] = validation.value;
                    normalized[key] = validation.value;
                }
                if (hasFailure) {
                    requested.filter((key) => !results[key]).forEach((key) => { results[key] = settingFailure(key, "SETTINGS_TRANSACTION_REJECTED"); });
                    return { ok: false, area, code: "SETTINGS_VALIDATION_FAILED", results };
                }
                Object.entries(normalized).forEach(([key, value]) => (schema?.getAliasKeys?.(key) || [key]).forEach((alias) => { normalized[alias] = clone(value); }));
                try { await adapter.set(area, normalized); } catch (error) {
                    const failure = sanitizeError(error, "SETTINGS_UPDATE_FAILED");
                    return { ok: false, area, code: failure.code, results: failureMap(requested, failure.code, failure.message) };
                }
                requested.forEach((key) => { results[key] = { ok: true, status: "success" }; });
                return { ok: true, area, changed: requested, results };
            },
            async settingsReset(area, keys) {
                const requested = validateSettingKeys(area, keys);
                const results = {};
                const expanded = new Set();
                requested.forEach((key) => {
                    if (!settingKeyAllowed(area, key)) results[key] = settingFailure(key, "SETTINGS_KEY_FORBIDDEN");
                    else (schema?.getAliasKeys?.(key) || [key]).forEach((alias) => expanded.add(alias));
                });
                if (Object.keys(results).length) return { ok: false, area, code: "SETTINGS_KEY_FORBIDDEN", results };
                try { await adapter.remove(area, Array.from(expanded)); } catch (error) {
                    const failure = sanitizeError(error, "SETTINGS_RESET_FAILED");
                    return { ok: false, area, code: failure.code, results: failureMap(requested, failure.code, failure.message) };
                }
                requested.forEach((key) => { results[key] = { ok: true, status: "reset" }; });
                return { ok: true, area, reset: requested, results };
            },
            snapshot() {
                return clone(areas);
            }
        };
        return adapter;
    }

    return Object.freeze({
        PLATFORM_SYNC_KEYS,
        PLATFORM_LOCAL_KEYS,
        PLATFORM_SESSION_KEYS,
        AREA_LIMITS,
        ALIAS_GROUPS,
        SOURCE_METADATA_KEY,
        containsSensitiveKey,
        containsSensitiveValue,
        assertSafeValue,
        assertAllowedKey,
        validateSourceMetadata,
        normalizeLegacyAliases,
        sanitizeError,
        createChromeStorageAdapter,
        createMemoryStorage
    });
}));
