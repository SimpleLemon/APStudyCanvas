(function () {
    "use strict";

    // popup.html loads the schema before this file. Keep this fallback for
    // direct legacy-file inspection without adding a runtime route.
    function ensureSchema() {
        if (typeof APStudyCanvasSchema !== "undefined") return;
        if (typeof document === "undefined" || !document.currentScript) return;
        const source = new URL("settings-schema.js", document.currentScript.src).href;
        document.write(`<script type="text/javascript" src="${source}"><\/script>`);
    }

    ensureSchema();

    const schema = typeof APStudyCanvasSchema !== "undefined" ? APStudyCanvasSchema : null;
    const categories = schema ? schema.categories : ["overview", "appearance", "sidebar", "course-cards", "study-tools", "themes", "gpa-grades", "calendar-accounts", "data-support"];
    const startupQuery = new URLSearchParams(window.location.search);
    const isPopupWorkspace = startupQuery.get("view") === "workspace" || startupQuery.get("fullscreen") === "1";
    let workspaceSourceTabId = null;
    let workspaceCategory = "overview";
    let workspaceReady = false;
    let workspaceSetupPromise = null;
    let workspaceInteractionsBound = false;
    let legacyRadioInteractionsBound = false;

    const searchDefinitions = [
        {
            inputId: "global-search-input",
            resultsId: "global-search-results",
            emptyId: null,
            scope: ".global-search"
        },
        {
            inputId: "workspace-search-input",
            resultsId: "workspace-search-results",
            emptyId: "workspace-search-empty",
            scope: ".workspace-search-wrap"
        }
    ];

    function storageCall(area, method, ...args) {
        const storage = chrome?.storage?.[area];
        if (!storage || typeof storage[method] !== "function") return Promise.reject(new Error(`storage.${area}.${method} unavailable`));
        try {
            const result = storage[method](...args);
            return result && typeof result.then === "function" ? result : Promise.resolve(result);
        } catch (error) {
            return Promise.reject(error);
        }
    }

    function setHomeStatus(message, isError) {
        const status = document.getElementById("home-save-status");
        if (!status) return;
        status.textContent = message;
        status.classList.toggle("is-error", Boolean(isError));
    }

    function setWorkspaceStatus(message, isError) {
        const status = document.getElementById("workspace-save-status");
        if (status) {
            status.textContent = message;
            status.classList.toggle("is-error", Boolean(isError));
        }
        const lastSaved = document.getElementById("workspace-last-saved-value");
        if (lastSaved && !isError) lastSaved.textContent = message;
        if (window.parent !== window) {
            window.parent.postMessage({ type: "apstudycanvas-status", message, error: Boolean(isError) }, window.location.origin);
        }
    }

    function readText(node) {
        return node?.textContent?.replace(/\s+/g, " ").trim() || "";
    }

    function categoryForLegacyNode(node) {
        const explicit = node?.closest?.("[data-category]")?.dataset.category;
        if (validateCategory(explicit)) return explicit;
        const tab = node?.closest?.(".tab");
        const tabCategories = {
            "customize-dark": "appearance",
            advanced: "course-cards",
            "import-export": "themes",
            "gpa-bounds-container": "gpa-grades",
            "custom-font-container": "appearance",
            "report-issue-container": "data-support"
        };
        return tabCategories[tab?.classList?.[0]] || "overview";
    }

    function createSearchLiveRegion() {
        let live = document.getElementById("global-search-live");
        if (!live) {
            live = document.createElement("span");
            live.id = "global-search-live";
            live.className = "sr-only";
            live.setAttribute("role", "status");
            live.setAttribute("aria-live", "polite");
            document.body.appendChild(live);
        }
        return live;
    }

    function buildSettingsIndex() {
        const entries = [];
        const seen = new Set();
        document.querySelectorAll("#legacy-interface input, #legacy-interface textarea, #legacy-interface select, #legacy-interface button[data-search-terms]").forEach((target) => {
            if (!target.id && !target.dataset.searchTerms) return;
            const id = target.id || `${target.tagName.toLowerCase()}-${entries.length}`;
            if (seen.has(id)) return;
            seen.add(id);
            const label = document.querySelector(`label[for="${id}"]`) || target.closest(".option-container")?.querySelector(".option-name, h3, h2");
            const container = target.closest(".option-container, .tab") || target;
            const helper = container.querySelector(".sub-text, .workspace-helper, p") || target.parentElement;
            const category = categoryForLegacyNode(target);
            const terms = [category, readText(label), readText(helper), target.dataset.searchTerms || "", target.name || "", id].join(" ").toLowerCase();
            entries.push({ id, target, category, label: readText(label) || id, helper: readText(helper), terms });
        });
        document.querySelectorAll(".workspace-section[data-category]").forEach((target) => {
            const category = target.dataset.category;
            entries.push({
                id: target.id,
                target,
                category,
                label: readText(target.querySelector("h2")) || category,
                helper: readText(target.querySelector(".workspace-helper")),
                terms: [category, readText(target.querySelector("h2")), readText(target.querySelector(".workspace-helper")), target.dataset.searchTerms || ""].join(" ").toLowerCase()
            });
        });
        return entries;
    }

    function searchNodes(definition) {
        return {
            input: document.getElementById(definition.inputId),
            results: document.getElementById(definition.resultsId),
            empty: definition.emptyId ? document.getElementById(definition.emptyId) : null
        };
    }

    function closeSearchResults(definition = null) {
        const definitions = definition ? [definition] : searchDefinitions;
        definitions.forEach((item) => {
            const { input, results, empty } = searchNodes(item);
            if (results) results.hidden = true;
            if (empty) empty.hidden = true;
            input?.setAttribute("aria-expanded", "false");
        });
    }

    function clearSearchInputs() {
        searchDefinitions.forEach((definition) => {
            const { input } = searchNodes(definition);
            if (input) input.value = "";
        });
        closeSearchResults();
        const live = document.getElementById("global-search-live");
        if (live) live.textContent = "";
    }

    function synchronizeSearchInputs(sourceInput) {
        searchDefinitions.forEach((definition) => {
            const { input } = searchNodes(definition);
            if (input && input !== sourceInput && input.value !== sourceInput.value) input.value = sourceInput.value;
        });
    }

    function primarySearchInput() {
        const global = document.getElementById("global-search-input");
        const workspace = document.getElementById("workspace-search-input");
        return document.body?.dataset.mode === "workspace" ? (workspace || global) : (global || workspace);
    }

    function createSearchResultItem(entry, index, sourceInput) {
        const item = document.createElement("button");
        item.type = "button";
        item.role = "option";
        item.dataset.searchIndex = String(index);
        item.style.display = "block";
        item.style.width = "100%";
        item.style.border = "0";
        item.style.padding = "8px";
        item.style.background = "transparent";
        item.style.color = "inherit";
        item.style.textAlign = "left";
        item.textContent = `${entry.label} · ${entry.category}`;
        item.addEventListener("click", () => {
            clearSearchInputs();
            openLegacyTarget(entry.target, entry.category, sourceInput);
        });
        return item;
    }

    function renderSearch(definition) {
        const { input, results, empty } = searchNodes(definition);
        if (!input || !results) return;
        const live = createSearchLiveRegion();
        synchronizeSearchInputs(input);
        closeSearchResults(searchDefinitions.filter((item) => item !== definition)[0]);
        results.replaceChildren();
        const query = input.value.trim().toLowerCase();
        if (!query) {
            closeSearchResults(definition);
            live.textContent = "";
            return;
        }
        const matches = buildSettingsIndex().filter((entry) => entry.terms.includes(query)).slice(0, 12);
        results.hidden = false;
        input.setAttribute("aria-expanded", "true");
        if (empty) empty.hidden = Boolean(matches.length);
        if (!matches.length) {
            results.appendChild(Object.assign(document.createElement("div"), { textContent: "No settings match that search." }));
            live.textContent = "No settings match that search.";
            return;
        }
        live.textContent = `${matches.length} setting${matches.length === 1 ? "" : "s"} found.`;
        matches.forEach((entry, index) => results.appendChild(createSearchResultItem(entry, index, input)));
    }

    async function openLegacyTarget(target, category, sourceInput = null) {
        await enterWorkspace(category);
        if (target.closest(".tab")) {
            const tab = target.closest(".tab");
            const tabButton = {
                "customize-dark": "customize-dark-btn",
                advanced: "advanced-settings",
                "import-export": "import-export-btn",
                "gpa-bounds-container": "gpa-bounds-btn",
                "custom-font-container": "custom-font-btn",
                "report-issue-container": "report-issue-btn"
            }[tab.classList[0]];
            document.getElementById(tabButton)?.click();
        } else {
            hideLegacyTabs();
            const main = document.querySelector(".main");
            if (main) {
                main.style.display = "block";
                setAccessibleVisibility(main, true);
            }
            window.APStudyCanvasWorkspace?.syncCategoryFromLegacy(category);
        }
        target.scrollIntoView?.({ block: "center", behavior: "smooth" });
        const focusTarget = target.matches?.("input, textarea, select, button") ? target : target.querySelector?.("input, textarea, select, button");
        focusTarget?.focus?.();
        target.style.outline = "2px solid #8f98ff";
        target.style.outlineOffset = "3px";
        setTimeout(() => {
            target.style.outline = "";
            target.style.outlineOffset = "";
        }, 1400);
        sourceInput?.blur?.();
    }

    function setupGlobalSearch() {
        searchDefinitions.forEach((definition) => {
            const { input } = searchNodes(definition);
            if (!input) return;
            input.addEventListener("input", () => renderSearch(definition));
            input.addEventListener("keydown", (event) => {
                if (event.key !== "Escape") return;
                event.stopPropagation();
                if (typeof window.closeCompactPopovers === "function" && window.closeCompactPopovers()) return;
                clearSearchInputs();
                input.focus();
            });
        });
        document.addEventListener("mousedown", (event) => {
            if (!event.target.closest?.(".global-search, .workspace-search-wrap")) closeSearchResults();
        });
    }

    function setupPopovers() {
        const pairs = [
            ["notifications-button", "notifications-popover"],
            ["profile-button", "profile-popover"]
        ];
        let openTrigger = null;
        const close = () => {
            const hadOpen = Boolean(document.querySelector(".compact-popover:not([hidden])"));
            const openPopover = document.querySelector(".compact-popover:not([hidden])");
            if (openPopover?.contains?.(document.activeElement)) {
                const trigger = openTrigger || document.querySelector(`[aria-controls="${openPopover.id}"]`);
                trigger?.focus?.();
            }
            document.querySelectorAll(".compact-popover").forEach((popover) => setAccessibleVisibility(popover, false));
            document.querySelectorAll("[aria-controls$='-popover']").forEach((button) => button.setAttribute("aria-expanded", "false"));
            return hadOpen;
        };
        window.closeCompactPopovers = close;
        pairs.forEach(([buttonId, popoverId]) => {
            const button = document.getElementById(buttonId);
            const popover = document.getElementById(popoverId);
            if (!button || !popover) return;
            button.addEventListener("click", () => {
                const isOpen = !popover.hidden;
                close();
                if (!isOpen) {
                    setAccessibleVisibility(popover, true);
                    button.setAttribute("aria-expanded", "true");
                    openTrigger = button;
                }
            });
            popover.querySelector(".popover-close")?.addEventListener("click", close);
        });
        document.addEventListener("mousedown", (event) => {
            if (!event.target.closest(".compact-popover-anchor")) close();
        });
        document.addEventListener("keydown", (event) => {
            if (event.key === "/" && document.activeElement?.tagName !== "INPUT" && document.activeElement?.tagName !== "TEXTAREA") {
                event.preventDefault();
                primarySearchInput()?.focus();
                return;
            }
            if (window.APStudyCanvasPopupController?.handlePopoverEscape(event, close, openTrigger)) return;
            if (event.key !== "Escape") return;
            const input = primarySearchInput();
            if (searchDefinitions.some((definition) => searchNodes(definition).input?.value)) {
                clearSearchInputs();
                input?.focus();
            }
        });
    }

    function isPlausibleCanvasDomain(value) {
        if (typeof value !== "string" || !value.trim()) return false;
        const candidate = value.trim().includes("://") ? value.trim() : `https://${value.trim()}`;
        try {
            const url = new URL(candidate);
            if (url.protocol !== "http:" && url.protocol !== "https:") return false;
            const hostname = url.hostname.toLowerCase();
            if (url.username || url.password || (!hostname.includes(".") && hostname !== "localhost")) return false;
            return hostname === "localhost" || hostname.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
        } catch (error) {
            return false;
        }
    }

    function validateCategory(value) {
        return schema ? schema.isCategory(value) : categories.includes(value);
    }

    function getCurrentTab() {
        if (chrome?.tabs?.getCurrent) {
            return Promise.resolve(chrome.tabs.getCurrent()).then((tab) => {
                if (tab?.id !== undefined) return tab;
                return chrome.tabs?.query ? chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => tabs?.[0] || null) : null;
            }).catch(() => null);
        }
        return chrome?.tabs?.query ? chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => tabs?.[0] || null).catch(() => null) : Promise.resolve(null);
    }

    async function flushBeforeNavigation() {
        if (typeof window.flushPendingWrites !== "function") return;
        await window.flushPendingWrites();
    }

    async function openExpandedWorkspace(category) {
        const target = validateCategory(category) ? category : "overview";
        try {
            await flushBeforeNavigation();
            const currentTab = await getCurrentTab();
            const sourceTabId = Number.isInteger(currentTab?.id) ? currentTab.id : null;
            const contract = globalThis.APStudyCanvasPlatform?.Contract;
            const message = contract?.createEnvelope
                ? contract.createEnvelope("POPUP_FULLSCREEN_OPEN", { sourceCanvasTabId: sourceTabId, category: target })
                : { version: 1, request_id: `popup-${Date.now()}`, type: "POPUP_FULLSCREEN_OPEN", payload: { sourceCanvasTabId: sourceTabId, category: target } };
            const response = await chrome.runtime.sendMessage(message);
            const result = response?.payload || response || {};
            if (result.ok === false) throw new Error(result.code || "FULLSCREEN_OPEN_FAILED");
            setHomeStatus("Fullscreen workspace opened.");
        } catch (error) {
            setHomeStatus("Fullscreen could not open. Your settings are still open here.", true);
        }
    }

    function readWorkspaceContext() {
        const query = new URLSearchParams(window.location.search);
        const sourceValue = query.get("sourceCanvasTabId");
        const source = /^(?:[1-9]\d*)$/.test(sourceValue || "") ? Number(sourceValue) : null;
        return {
            category: validateCategory(query.get("category")) ? query.get("category") : "overview",
            sourceTabId: Number.isSafeInteger(source) && source > 0 ? source : null
        };
    }

    function setViewMode(mode) {
        document.body.dataset.mode = mode;
        const home = document.getElementById("home-view");
        const legacy = document.getElementById("legacy-interface");
        const workspace = document.getElementById("workspace-view");
        if (mode === "home") {
            setAccessibleVisibility(home, true);
            const returnTarget = document.getElementById("compact-home-trigger") || home?.querySelector?.("button, a, input");
            setAccessibleVisibility(workspace, false, returnTarget);
            setAccessibleVisibility(legacy, false, returnTarget);
            return;
        }
        setAccessibleVisibility(workspace, true);
        setAccessibleVisibility(legacy, true);
        const workspaceTarget = document.getElementById("workspace-category-select") || workspace?.querySelector?.("button, select, input");
        setAccessibleVisibility(home, false, workspaceTarget);
    }

    function isHiddenFocusTarget(target) {
        for (let current = target; current; current = current.parentElement) {
            if (current.hidden || current.inert || current.getAttribute?.("aria-hidden") === "true") return true;
        }
        return false;
    }

    function moveFocusBeforeHiding(node, focusTarget = null) {
        if (!node?.contains?.(document.activeElement)) return;
        const home = document.getElementById("home-view");
        const workspace = document.getElementById("workspace-view");
        const candidates = [
            focusTarget,
            document.getElementById("compact-home-trigger"),
            document.getElementById("workspace-category-select"),
            home?.querySelector?.("button, a, input"),
            workspace?.querySelector?.("button, select, input")
        ];
        for (const candidate of candidates) {
            if (!candidate?.focus || candidate === node || node.contains?.(candidate) || isHiddenFocusTarget(candidate)) continue;
            candidate.focus();
            if (!node.contains?.(document.activeElement)) return;
        }
        document.activeElement?.blur?.();
    }

    function setAccessibleVisibility(node, visible, focusTarget = null) {
        if (!node) return;
        if (!visible) moveFocusBeforeHiding(node, focusTarget);
        node.hidden = !visible;
        node.inert = !visible;
        if (visible) node.removeAttribute("aria-hidden");
        else node.setAttribute("aria-hidden", "true");
        if (visible) {
            node.removeAttribute("hidden");
            node.removeAttribute("inert");
        } else {
            node.setAttribute("hidden", "");
            node.setAttribute("inert", "");
        }
    }

    function bindLegacyRadioInteractions() {
        if (legacyRadioInteractionsBound) return;
        legacyRadioInteractionsBound = true;
        document.querySelectorAll("#legacy-interface .option > input[type='radio']").forEach((control) => {
            control.addEventListener("change", () => {
                const option = control.closest(".option");
                const setting = option?.id;
                if (!control.checked || !setting || typeof window.queueSettingWrite !== "function") return;
                option.querySelectorAll("input[type='radio']").forEach((radio) => radio.classList.toggle("checked", radio.checked));
                const enabled = control.id === `${setting}-on`;
                const write = window.queueSettingWrite({ [setting]: enabled }, setting);
                Promise.resolve(write).then(() => setWorkspaceStatus("Saved.")).catch(() => setWorkspaceStatus("Failed — changes reverted.", true));
                if (setting === "auto_dark" && typeof window.toggleDarkModeDisable === "function") window.toggleDarkModeDisable(enabled);
            });
        });
    }

    function sidebarOrderFromDom(list) {
        return Array.from(list?.querySelectorAll?.("[data-sidebar-page]") || [])
            .map((row) => row.dataset.sidebarPage)
            .filter(Boolean);
    }

    function reorderSidebarDom(list, order) {
        if (!list) return;
        const rows = new Map(Array.from(list.querySelectorAll("[data-sidebar-page]")).map((row) => [row.dataset.sidebarPage, row]));
        const current = sidebarOrderFromDom(list);
        const requested = Array.isArray(order) ? order : current;
        const canonical = [...requested.filter((page) => rows.has(page)), ...current.filter((page) => !requested.includes(page))];
        canonical.forEach((page) => list.appendChild(rows.get(page)));
    }

    function focusSidebarRow(list, page) {
        list?.querySelector?.(`[data-sidebar-page="${String(page).replace(/"/g, "\\\"")}"]`)?.focus?.();
    }

    function setSidebarMoveStatus(message, isError = false) {
        setWorkspaceStatus(message, isError);
        const error = document.getElementById("workspace-error-area");
        if (!error) return;
        if (isError) {
            error.textContent = message;
            setAccessibleVisibility(error, true);
        } else {
            error.textContent = "";
            setAccessibleVisibility(error, false);
        }
    }

    function localReorder(items, index, direction) {
        const next = items.slice();
        const target = direction === "up" ? index - 1 : index + 1;
        if (index < 0 || target < 0 || target >= next.length) return next;
        [next[index], next[target]] = [next[target], next[index]];
        return next;
    }

    function setupSidebarReorderRenderer() {
        const list = document.getElementById("sidebar-page-list");
        if (!list || list.dataset.rendererBound === "true") return;
        list.dataset.rendererBound = "true";
        let latestMoveId = 0;

        const move = (event, row, direction) => {
            const controller = window.APStudyCanvasPopup;
            if (!controller?.persistSidebarOrder || !row) return;
            const page = row.dataset.sidebarPage;
            const current = sidebarOrderFromDom(list);
            const index = current.indexOf(page);
            const next = localReorder(current, index, direction);
            if (next.join("\u0000") === current.join("\u0000")) return;
            event.preventDefault();
            event.stopImmediatePropagation?.();
            reorderSidebarDom(list, next);
            focusSidebarRow(list, page);
            const moveId = ++latestMoveId;

            const isCurrentOutcome = (outcome) => moveId === latestMoveId && outcome?.current !== false;

            const restore = (restoredOrder, outcome) => {
                if (!isCurrentOutcome(outcome)) return;
                reorderSidebarDom(list, restoredOrder);
                focusSidebarRow(list, page);
                setSidebarMoveStatus("Failed — changes reverted.", true);
            };
            const result = (outcome) => {
                if (!isCurrentOutcome(outcome)) return;
                if (outcome?.ok === false) {
                    restore(outcome.restoredOrder || outcome.order || current, outcome);
                    return;
                }
                reorderSidebarDom(list, outcome?.order || next);
                focusSidebarRow(list, page);
                setSidebarMoveStatus("Saved.");
            };
            let pending;
            try {
                pending = controller.persistSidebarOrder(next, page, { onRollback: restore, onResult: result });
            } catch (error) {
                restore(error?.restoredOrder || current, error?.result || error);
                return;
            }
            Promise.resolve(pending).catch((error) => restore(error?.restoredOrder || current, error?.result || error));
        };

        list.addEventListener("click", (event) => {
            const button = event.target.closest?.("[data-sidebar-move]");
            if (!button) return;
            move(event, button.closest?.("[data-sidebar-page]"), button.dataset.sidebarMove);
        }, true);
        list.addEventListener("keydown", (event) => {
            if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
            const row = event.target.closest?.("[data-sidebar-page]");
            move(event, row, event.key === "ArrowUp" ? "up" : "down");
        }, true);
    }

    function targetToLegacyButton(target) {
        return {
            appearance: "customize-dark-btn",
            sidebar: null,
            "course-cards": "advanced-settings",
            "study-tools": null,
            themes: null,
            "gpa-grades": "gpa-bounds-btn",
            "calendar-accounts": null,
            "data-support": "report-issue-btn",
            overview: null
        }[target] ?? null;
    }

    function hideLegacyTabs() {
        document.querySelectorAll(".tab").forEach((tab) => {
            tab.style.display = "none";
            setAccessibleVisibility(tab, false);
        });
    }

    function showLegacyMain(target = "overview") {
        hideLegacyTabs();
        const main = document.querySelector(".main");
        if (main) {
            setAccessibleVisibility(main, true);
            main.style.display = "block";
        }
        if (target === "study-tools") {
            const studyTools = document.getElementById("assignments_due")?.closest(".option-container") || document.getElementById("better_todo")?.closest(".option-container");
            if (studyTools) studyTools.scrollIntoView({ block: "start" });
        } else {
            window.scrollTo(0, 0);
        }
    }

    function sendWorkspaceNavigation(target) {
        const buttonId = targetToLegacyButton(target);
        hideLegacyTabs();
        if (!buttonId) {
            showLegacyMain(target);
            return;
        }
        const button = document.getElementById(buttonId);
        if (button) button.click();
        else showLegacyMain(target);
    }

    function updateCategoryChrome(target) {
        const next = validateCategory(target) ? target : "overview";
        workspaceCategory = next;
        document.querySelectorAll("[data-workspace-target]").forEach((item) => {
            const active = item.dataset.workspaceTarget === next;
            item.classList.toggle("is-active", active);
            if (active) item.setAttribute("aria-current", "page");
            else item.removeAttribute("aria-current");
        });
        const select = document.getElementById("workspace-category-select");
        if (select) {
            select.value = next;
            Array.from(select.options).forEach((option) => { option.selected = option.value === next; });
        }
        const sections = Array.from(document.querySelectorAll(".workspace-section[data-category]"));
        const nextSection = sections.find((section) => section.dataset.category === next);
        const active = document.activeElement;
        if (nextSection) setAccessibleVisibility(nextSection, true);
        if (sections.some((section) => section !== nextSection && section.contains?.(active))) {
            document.getElementById("workspace-category-select")?.focus?.();
        }
        sections.forEach((section) => setAccessibleVisibility(section, section === nextSection));
        return next;
    }

    function activateCategory(target, persist = true) {
        const next = updateCategoryChrome(target);
        sendWorkspaceNavigation(next);
        if (persist) window.APStudyCanvasPopup?.updateCategory?.(next);
        setWorkspaceStatus(`Showing ${next}. Settings sync automatically.`);
    }

    function bindWorkspaceInteractions() {
        if (workspaceInteractionsBound) return;
        document.querySelectorAll("[data-workspace-target]").forEach((item) => {
            item.addEventListener("click", () => {
                enterWorkspace(item.dataset.workspaceTarget).catch(() => setWorkspaceStatus("Workspace settings are temporarily unavailable.", true));
            });
        });
        document.querySelectorAll("[data-legacy-target]").forEach((item) => {
            item.addEventListener("click", () => {
                const button = document.getElementById(item.dataset.legacyTarget);
                if (button) button.click();
            });
        });
        document.querySelectorAll(".workspace-home-link").forEach((link) => {
            link.addEventListener("click", (event) => {
                event.preventDefault();
                clearSearchInputs();
                setViewMode("home");
            });
        });
        workspaceInteractionsBound = true;
    }

    function ensureWorkspaceReady() {
        if (!workspaceSetupPromise) {
            const legacySetup = typeof window.ensureLegacySetup === "function"
                ? window.ensureLegacySetup()
                : Promise.resolve();
            workspaceSetupPromise = Promise.resolve(legacySetup).then(() => {
                bindLegacyRadioInteractions();
                bindWorkspaceInteractions();
                setupSidebarReorderRenderer();
                workspaceReady = true;
            });
        }
        return workspaceSetupPromise;
    }

    function enterWorkspace(category) {
        clearSearchInputs();
        setViewMode("workspace");
        return ensureWorkspaceReady().then(() => {
            activateCategory(category);
        });
    }

    function setupHome() {
        const home = document.getElementById("home-view");
        if (!home) return;
        setViewMode("home");
        home.querySelectorAll("[data-home-target]").forEach((button) => {
            button.addEventListener("click", () => enterWorkspace(button.dataset.homeTarget).catch(() => setHomeStatus("Workspace settings are temporarily unavailable.", true)));
        });
        document.getElementById("home-edit-canvas")?.addEventListener("click", () => enterWorkspace("overview").catch(() => setHomeStatus("Workspace settings are temporarily unavailable.", true)));

        const search = document.getElementById("home-search-input");
        const emptySearch = document.getElementById("home-empty-search");
        const tiles = Array.from(document.querySelectorAll(".feature-tile"));
        const filterTiles = () => {
            const query = search.value.trim().toLowerCase();
            let visibleCount = 0;
            tiles.forEach((tile) => {
                const terms = `${tile.dataset.search || ""} ${tile.dataset.searchTerms || ""}`.toLowerCase();
                const matches = !query || terms.includes(query);
                tile.hidden = !matches;
                if (matches) visibleCount += 1;
            });
            if (emptySearch) emptySearch.hidden = visibleCount !== 0;
        };
        search?.addEventListener("input", filterTiles);
        search?.addEventListener("keydown", (event) => {
            if (event.key === "Escape") {
                event.stopPropagation();
                search.value = "";
                filterTiles();
            }
        });

        const settings = Array.from(document.querySelectorAll("[data-home-setting]"));
        storageCall("sync", "get", [...settings.map((input) => input.dataset.homeSetting), "custom_domain"]).then((stored) => {
            settings.forEach((input) => { input.checked = stored[input.dataset.homeSetting] === true; });
            const connection = document.getElementById("home-connection-status");
            const domains = Array.isArray(stored.custom_domain) ? stored.custom_domain : [];
            if (connection) {
                connection.textContent = domains.some(isPlausibleCanvasDomain) ? "Canvas connected" : "Canvas setup needed";
                connection.classList.toggle("is-connected", connection.textContent === "Canvas connected");
            }
        }).catch(() => setHomeStatus("Settings are temporarily unavailable.", true));
        settings.forEach((input) => {
            input.addEventListener("change", () => {
                if (typeof window.queueSettingWrite !== "function") return;
                window.queueSettingWrite({ [input.dataset.homeSetting]: input.checked }, `home:${input.dataset.homeSetting}`)
                    .then(() => setHomeStatus("Saved just now."))
                    .catch(() => setHomeStatus(schema?.messages.saveFailure || "Could not save settings. Changes were reverted.", true));
            });
        });
    }

    function showManualClosePrompt() {
        const prompt = document.getElementById("manual-close-prompt");
        if (!prompt) return;
        if (typeof prompt.showModal === "function" && !prompt.open) prompt.showModal();
        else prompt.hidden = false;
    }

    async function closeWorkspaceOrPopup() {
        try {
            await flushBeforeNavigation();
            if (isPopupWorkspace) {
                const currentTab = await chrome.tabs?.getCurrent?.();
                if (currentTab?.id !== undefined && chrome.tabs?.remove) {
                    await chrome.tabs.remove(currentTab.id);
                } else {
                    window.close();
                }
            } else {
                window.close();
            }
        } catch (error) {
            showManualClosePrompt();
        }
    }

    function setupHeader() {
        document.getElementById("compact-home-trigger")?.addEventListener("click", () => {
            clearSearchInputs();
            setViewMode("home");
            setHomeStatus("Settings sync automatically.");
        });
        document.getElementById("compact-close")?.addEventListener("click", () => closeWorkspaceOrPopup());
        document.querySelector("#manual-close-prompt form")?.addEventListener("submit", (event) => {
            if (event.submitter?.value === "close") {
                event.preventDefault();
                window.close();
            }
        });
    }

    async function setupWorkspace() {
        const workspace = document.getElementById("workspace-view");
        if (!workspace) return;
        setViewMode("workspace");
        const context = readWorkspaceContext();
        workspaceSourceTabId = context.sourceTabId;
        updateCategoryChrome(context.category);
        await ensureWorkspaceReady();
        activateCategory(context.category, false);
        setWorkspaceStatus(`Showing ${context.category}. Settings sync automatically.`);
    }

    function getWorkspaceSourceTabId() {
        return workspaceSourceTabId;
    }

    window.APStudyCanvasWorkspace = {
        get category() { return workspaceCategory; },
        get sourceTabId() { return getWorkspaceSourceTabId(); },
        activateCategory,
        syncCategoryFromLegacy(target) { updateCategoryChrome(target); },
        openExpandedWorkspace
    };

    document.addEventListener("DOMContentLoaded", () => {
        setupGlobalSearch();
        setupPopovers();
        setupHeader();
        if (isPopupWorkspace) setupWorkspace();
        else setupHome();
    });
}());
