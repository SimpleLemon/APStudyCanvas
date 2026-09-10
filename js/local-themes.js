(function (root, factory) {
    "use strict";
    const api = factory(root);
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasLocalThemes = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
    "use strict";

    const BUNDLED_THEMES = Object.freeze([
        Object.freeze({ id: "nest-day", name: "Nest Day", source: "bundled", createdAt: 0, settings: Object.freeze({ dark_mode: false, disable_color_overlay: false }) }),
        Object.freeze({ id: "nest-night", name: "Nest Night", source: "bundled", createdAt: 0, settings: Object.freeze({ dark_mode: true, disable_color_overlay: false }) }),
        Object.freeze({ id: "focused-cards", name: "Focused Cards", source: "bundled", createdAt: 0, settings: Object.freeze({ condensed_cards: true, cardImageRoundness: 12, cardPadding: 12 }) })
    ]);
    const mountedSetups = new WeakMap();

    function plainObject(value) {
        if (!value || typeof value !== "object" || Array.isArray(value)) return false;
        const prototype = Object.getPrototypeOf(value);
        return prototype === Object.prototype || prototype === null;
    }

    function clone(value) {
        return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
    }

    function validTimestamp(value) {
        const timestamp = Number(value);
        return Number.isSafeInteger(timestamp)
            && timestamp >= 0
            && Number.isFinite(new Date(timestamp).getTime())
            ? timestamp
            : null;
    }

    function themeDateLabel(timestamp) {
        try { return new Date(timestamp).toLocaleDateString(); }
        catch (error) { return String(timestamp); }
    }

    function normalizedThemeEntry(theme, fallback = {}) {
        if (!plainObject(theme) || !plainObject(theme.settings)) return null;
        const id = typeof theme.id === "string" && theme.id ? theme.id : fallback.id;
        const name = typeof theme.name === "string" && theme.name ? theme.name : fallback.name;
        if (typeof id !== "string" || !id || typeof name !== "string" || !name) return null;
        return {
            id,
            name,
            source: theme.source === "saved" ? "saved" : "bundled",
            // Bundled themes without date metadata remain sortable. Invalid
            // saved metadata is excluded at its storage boundary below.
            createdAt: validTimestamp(theme.createdAt) ?? 0,
            settings: clone(theme.settings)
        };
    }

    function savedThemeEntries(savedThemes) {
        if (!plainObject(savedThemes)) return [];
        return Object.entries(savedThemes).flatMap(([id, settings]) => {
            const createdAt = validTimestamp(id);
            // Number.isSafeInteger alone still permits timestamps outside the
            // range Date can render. A malformed local-storage key must not
            // prevent the entirely local theme list from rendering.
            if (createdAt === null || !plainObject(settings)) return [];
            return [{ id: `saved:${id}`, name: `Saved theme · ${themeDateLabel(createdAt)}`, source: "saved", createdAt, settings: clone(settings) }];
        });
    }

    function browseThemes({ catalogue = BUNDLED_THEMES, savedThemes = {}, query = "", sort = "name" } = {}) {
        const normalizedQuery = typeof query === "string" ? query.trim().toLocaleLowerCase() : "";
        const bundled = Array.isArray(catalogue)
            ? catalogue.map((theme) => normalizedThemeEntry(theme)).filter(Boolean)
            : [];
        const entries = [...bundled, ...savedThemeEntries(savedThemes)];
        const filtered = normalizedQuery ? entries.filter((theme) => theme.name.toLocaleLowerCase().includes(normalizedQuery)) : entries;
        return filtered.slice().sort((left, right) => {
            if (sort === "newest") return right.createdAt - left.createdAt || left.name.localeCompare(right.name);
            if (sort === "saved") return Number(right.source === "saved") - Number(left.source === "saved") || left.name.localeCompare(right.name);
            return left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
        });
    }

    function exportableKeys(schema) {
        return Array.from(schema?.exportableSyncSettingKeys || []).filter((key) => typeof key === "string" && key.length > 0);
    }

    function selectedExportKeys(schema, selected) {
        const allowed = new Set(exportableKeys(schema));
        return Array.from(new Set(Array.from(selected || []).filter((key) => allowed.has(key))));
    }

    function settingsForTheme(schema, settings) {
        if (!plainObject(settings)) return {};
        const output = {};
        for (const [key, value] of Object.entries(settings)) {
            const result = schema?.validateSettingValue?.("sync", key, value);
            if (result?.valid) output[key] = clone(result.value);
        }
        return output;
    }

    // The controller owns the atomic import/rollback transaction. This helper
    // intentionally only validates and forwards a local snapshot; it never
    // reimplements card-color queueing or rollback semantics.
    function importLocalTheme({ schema, theme, runThemeImportTransaction }) {
        if (typeof runThemeImportTransaction !== "function") return Promise.reject(new Error("THEME_IMPORT_TRANSACTION_UNAVAILABLE"));
        const settings = settingsForTheme(schema, theme?.settings);
        if (!Object.keys(settings).length) return Promise.reject(new Error("THEME_SETTINGS_EMPTY"));
        return runThemeImportTransaction({ settingsChanges: settings, cardColors: theme?.settings?.card_colors });
    }

    // Sorting changes only the local browser's presentation. Keep it outside
    // the controller's Canvas-settings transaction so an unrelated live-apply
    // failure cannot revert the selected order after the list has rendered.
    function persistSort(chromeApi, value) {
        const sort = ["name", "newest", "saved"].includes(value) ? value : "name";
        if (typeof chromeApi?.storage?.sync?.set !== "function") return Promise.resolve(sort);
        try {
            return Promise.resolve(chromeApi.storage.sync.set({ local_theme_sort: sort }))
                .then(() => sort)
                .catch(() => sort);
        } catch (error) {
            return Promise.resolve(sort);
        }
    }

    function setup(doc = root?.document, chromeApi = root?.chrome, schema = root?.APStudyCanvasSchema, mountOptions = {}) {
        if (!doc || !chromeApi?.storage?.sync || !schema) return;
        if (mountedSetups.has(doc)) return mountedSetups.get(doc);
        const q = (selector) => doc.querySelector(selector);
        const options = q("#local-export-options");
        const list = q("#local-theme-list");
        const search = q("#local-theme-search");
        const sort = q("#local-theme-sort");
        const output = q("#local-export-output");
        if (!options || !list || !search || !sort || !output) return;

        const keys = exportableKeys(schema);
        options.replaceChildren(...keys.map((key) => {
            const label = doc.createElement("label");
            const input = doc.createElement("input");
            input.type = "checkbox";
            input.value = key;
            input.checked = true;
            label.append(input, doc.createTextNode(key.replace(/_/g, " ")));
            return label;
        }));

        let savedThemes = {};
        const backgroundUrl = q('[data-popup-setting="customBackgroundLink"]');
        const backgroundPanel = q("#workspace-background-controls");
        function renderBackgroundDependency() {
            const active = Boolean(String(backgroundUrl?.value || "").trim());
            if (backgroundPanel?.dataset) backgroundPanel.dataset.backgroundActive = active ? "true" : "false";
            doc.querySelectorAll("[data-background-dependent]").forEach((control) => { control.disabled = !active; });
        }
        backgroundUrl?.addEventListener("input", renderBackgroundDependency);
        backgroundUrl?.addEventListener("change", renderBackgroundDependency);
        renderBackgroundDependency();
        function renderThemes() {
            const themes = browseThemes({ savedThemes, query: search.value, sort: sort.value });
            list.replaceChildren(...themes.map((theme) => {
                const item = doc.createElement("article");
                item.className = "local-theme-item";
                const heading = doc.createElement("strong");
                heading.textContent = theme.name;
                const detail = doc.createElement("small");
                detail.textContent = theme.source === "saved" ? "Saved on this device" : "Bundled with APStudyCanvas";
                const apply = doc.createElement("button");
                apply.type = "button";
                apply.className = "workspace-action";
                apply.textContent = "Apply";
                apply.addEventListener("click", async () => {
                    const status = q("#themes-status-value");
                    try {
                        await importLocalTheme({
                            schema,
                            theme,
                            runThemeImportTransaction: mountOptions.runThemeImportTransaction || root?.APStudyCanvasImportLocalTheme
                        });
                        if (status) status.textContent = `${theme.name} applied`;
                    } catch (error) {
                        if (status) status.textContent = "Theme could not be applied. Your settings were not changed.";
                    }
                });
                item.append(heading, detail, apply);
                return item;
            }));
            if (!themes.length) list.textContent = "No local themes match that search.";
        }
        Promise.all([chromeApi.storage.local.get("saved_themes"), chromeApi.storage.sync.get(["customBackgroundLink", "local_theme_sort"])]).then(([localValues, syncValues]) => {
            savedThemes = plainObject(localValues.saved_themes) ? clone(localValues.saved_themes) : {};
            if (backgroundUrl && !backgroundUrl.value) backgroundUrl.value = String(syncValues.customBackgroundLink || "");
            if (["name", "newest", "saved"].includes(syncValues.local_theme_sort)) sort.value = syncValues.local_theme_sort;
            committedSort = sort.value;
            renderBackgroundDependency();
            renderThemes();
        }).catch(renderThemes);
        search.addEventListener("input", renderThemes);
        let committedSort = sort.value;
        sort.addEventListener("change", () => {
            // Render first: the ordering is a local view preference, so it
            // stays responsive even when browser storage is temporarily busy.
            renderThemes();
            const selectedSort = sort.value;
            const commit = typeof mountOptions.persistSort === "function"
                ? mountOptions.persistSort(selectedSort)
                : persistSort(chromeApi, selectedSort);
            Promise.resolve(commit).then(() => {
                committedSort = selectedSort;
            }).catch(() => {
                // The controller transaction rejected the write. Restore both
                // the selected value and the rendered order instead of leaving
                // a local-only choice that was never saved.
                sort.value = committedSort;
                renderThemes();
            });
        });

        q("#local-export-select-all")?.addEventListener("click", () => options.querySelectorAll("input").forEach((input) => { input.checked = true; }));
        q("#local-export-select-none")?.addEventListener("click", () => options.querySelectorAll("input").forEach((input) => { input.checked = false; }));
        q("#local-export-selected")?.addEventListener("click", async () => {
            const selected = selectedExportKeys(schema, Array.from(options.querySelectorAll("input:checked"), (input) => input.value));
            const values = await chromeApi.storage.sync.get(selected);
            const defaults = schema.defaultsForArea("sync");
            output.value = JSON.stringify(Object.fromEntries(selected.map((key) => [key, values[key] === undefined ? clone(defaults[key]) : clone(values[key])])), null, 2);
        });
        const mounted = Object.freeze({ teardown: () => mountedSetups.delete(doc), renderThemes });
        mountedSetups.set(doc, mounted);
        return mounted;
    }

    // PopupController supplies the canonical settings transaction. Do not
    // self-mount here: doing so before that controller initializes would bind
    // the sort menu to chrome.storage.sync.set directly and bypass rollback,
    // live-apply status, and queued-write ordering.
    return Object.freeze({ BUNDLED_THEMES, validTimestamp, normalizedThemeEntry, browseThemes, exportableKeys, selectedExportKeys, settingsForTheme, importLocalTheme, persistSort, setup });
}));
