(function () {
    "use strict";

    // popup.html loads the schema before this file. Keep this fallback for
    function ensureSchema() {
        if (typeof APStudyCanvasSchema !== "undefined") return;
        if (typeof document === "undefined" || !document.currentScript) return;
        const source = new URL("settings-schema.js", document.currentScript.src).href;
        document.write(`<script type="text/javascript" src="${source}"><\/script>`);
    }

    ensureSchema();

    const schema = typeof APStudyCanvasSchema !== "undefined" ? APStudyCanvasSchema : null;
    const categories = schema ? schema.categories : ["overview", "appearance", "sidebar", "course-cards", "study-tools", "themes", "gpa-grades", "canvas-search", "calendar-accounts", "data-support"];
    const startupQuery = new URLSearchParams(window.location.search);
    // popup-controller.js loads first and owns the route vocabulary. The inline
    // fallback keeps this file inspectable on its own without duplicating the
    // rule anywhere that matters at runtime.
    const shellApi = typeof APStudyCanvasPopupController !== "undefined" ? APStudyCanvasPopupController : null;
    const shellHost = shellApi?.shellHost?.(window.location.search)
        || (startupQuery.get("embedded") === "1" ? "embedded"
            : startupQuery.get("view") === "workspace" || startupQuery.get("fullscreen") === "1" ? "tab"
                : "popup");
    const isEmbeddedShell = shellHost === "embedded";
    // Workspace is the only shell surface. Embedded frames retain their
    // host-minted capability while category changes stay local to this
    // document.
    // Only a document that owns its own tab may close that tab.
    const ownsHostTab = shellHost === "tab";
    let workspaceSourceTabId = null;
    let workspaceCategory = "overview";
    let workspaceReady = false;
    let workspaceSetupPromise = null;
    let workspaceNavigationBound = false;
    let workspaceInteractionsBound = false;
    let navKeyboardBound = false;
    let embeddedFocusBound = false;
    let shellStartupPromise = null;

    const themeDraft = {
        css: false,
        palette: false,
        imported: false,
        isDirty() { return this.css || this.palette || this.imported; },
        notify() {
            if (!isEmbeddedShell) return;
            const popup = window.APStudyCanvasPopup;
            Promise.resolve(popup?.signalDraftState?.({ draft: this.isDirty() })).catch((error) => {
                popup?.reportDraftSyncFailure?.(error);
            });
        },
        setCss(dirty) { this.css = Boolean(dirty); this.notify(); },
        setPalette(dirty) { this.palette = Boolean(dirty); this.notify(); },
        setImport(dirty) { this.imported = Boolean(dirty); this.notify(); },
        confirmLeave(message) {
            if (!this.isDirty()) return true;
            let confirmed = false;
            try {
                confirmed = typeof window.confirm === "function"
                    && window.confirm(message || "Discard unsaved theme edits?") === true;
            } catch (error) {}
            if (!confirmed) return false;
            window.APStudyCanvasPopup?.discardModernDrafts?.();
            if (this.imported) {
                const input = document.getElementById("popup-import-input");
                if (input) input.value = "";
            }
            this.css = false;
            this.palette = false;
            this.imported = false;
            this.notify();
            return true;
        }
    };
    window.APStudyCanvasThemeDraft = themeDraft;

    const embeddedOverlaySession = startupQuery.get("overlaySession") || "";
    const embeddedParentOrigin = (() => {
        const declared = startupQuery.get("overlayParentOrigin") || "";
        let declaredOrigin = "";
        let referrerOrigin = "";
        try {
            const url = new URL(declared);
            if ((url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password) declaredOrigin = url.origin;
        } catch (error) {}
        try { referrerOrigin = new URL(document.referrer).origin; } catch (error) {}
        // Referrer remains the preferred browser-supplied proof. The host
        // minted overlayParentOrigin is a session-bound fallback for browsers
        // that suppress iframe referrer metadata; disagreement fails closed.
        if (declaredOrigin && referrerOrigin && declaredOrigin !== referrerOrigin) return "";
        return referrerOrigin || declaredOrigin;
    })();
    window.addEventListener("message", (event) => {
        const message = event?.data;
        if (!isEmbeddedShell
            || event.source !== window.parent
            || !embeddedParentOrigin
            || event.origin !== embeddedParentOrigin
            || message?.type !== "apstudycanvas-draft-query"
            || message.overlaySession !== embeddedOverlaySession
            || typeof message.requestId !== "string"
            || !message.requestId.startsWith(`${embeddedOverlaySession}:`)) return;
        event.source.postMessage({
            type: "apstudycanvas-draft-response",
            overlaySession: embeddedOverlaySession,
            requestId: message.requestId,
            draft: themeDraft.isDirty()
        }, event.origin);
    });

    const searchDefinitions = [
        {
            inputId: "global-search-input",
            resultsId: "global-search-results",
            emptyId: null,
            scope: ".global-search"
        },
    ];

    function prefersReducedMotion() {
        try { return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true; } catch (error) { return false; }
    }

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

    function setCanonicalSaveStatus(message) {
        const live = document.getElementById("save-status-live");
        if (live && live.textContent !== message) live.textContent = message;
    }

    function setWorkspaceStatus(message, isError) {
        const status = document.getElementById("workspace-save-status");
        if (status) {
            status.textContent = message;
            status.classList.toggle("is-error", Boolean(isError));
        }
        setCanonicalSaveStatus(message);
        if (window.parent !== window) {
            window.parent.postMessage({ type: "apstudycanvas-status", message, error: Boolean(isError) }, window.location.origin);
        }
    }

    function readText(node) {
        return node?.textContent?.replace(/\s+/g, " ").trim() || "";
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
        // The active Workspace is the only searchable settings owner.
        document.querySelectorAll(".workspace-section[data-category] :is([data-popup-setting], input, textarea, select, button, summary)").forEach((target) => {
            const section = target.closest(".workspace-section[data-category]");
            const category = section?.dataset.category || "overview";
            const id = target.id || target.dataset.popupSetting || `${category}-${entries.length}`;
            if (!id || seen.has(id)) return;
            seen.add(id);
            const row = target.closest(".workspace-setting, .workspace-subsection") || target;
            const label = row.querySelector("strong, h3") || target;
            const helper = row.querySelector("small, .workspace-helper");
            entries.push({ id, target, category, label: readText(label) || id, helper: readText(helper), terms: [category, readText(label), readText(helper), target.dataset.searchTerms || "", target.dataset.popupSetting || ""].join(" ").toLowerCase() });
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
        return global;
    }

    function createSearchResultItem(entry, index, sourceInput) {
        const item = document.createElement("button");
        item.type = "button";
        item.role = "option";
        item.setAttribute("role", "option");
        item.setAttribute("aria-selected", "false");
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
            openModernTarget(entry.target, entry.category, sourceInput);
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

    async function openModernTarget(target, category, sourceInput = null) {
        if (await enterWorkspace(category) === false) return;
        let disclosure = target.parentElement?.closest?.("details");
        while (disclosure) {
            disclosure.open = true;
            disclosure = disclosure.parentElement?.closest?.("details");
        }
        target.scrollIntoView?.({ block: "center", behavior: prefersReducedMotion() ? "auto" : "smooth" });
        const focusTarget = target.matches?.("input, textarea, select, button") ? target : target.querySelector?.("input, textarea, select, button");
        focusTarget?.focus?.({ preventScroll: true });
        if (prefersReducedMotion()) return;
        target.style.outline = "2px solid #D4AF37";
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
                if (event.key === "Escape") {
                    event.stopPropagation();
                    if (typeof window.closeCompactPopovers === "function" && window.closeCompactPopovers()) return;
                    clearSearchInputs();
                    input.focus();
                    return;
                }
                const results = searchNodes(definition).results;
                const options = Array.from(results?.querySelectorAll?.('[role="option"]') || []);
                if (!options.length) return;
                const selected = options.findIndex((item) => item.getAttribute("aria-selected") === "true");
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault();
                    const delta = event.key === "ArrowDown" ? 1 : -1;
                    const next = selected < 0 ? (delta > 0 ? 0 : options.length - 1) : Math.max(0, Math.min(options.length - 1, selected + delta));
                    options.forEach((item, index) => item.setAttribute("aria-selected", index === next ? "true" : "false"));
                    options[next]?.focus?.();
                    return;
                }
                if (event.key === "Enter") {
                    const current = selected >= 0 ? options[selected] : options[0];
                    if (!current) return;
                    event.preventDefault();
                    current.click();
                }
            });
        });
        document.addEventListener("mousedown", (event) => {
            if (!event.target.closest?.(".global-search, .workspace-search-wrap")) closeSearchResults();
        });
    }

    function setupPopovers() {
        const button = document.getElementById("notifications-button");
        const popover = document.getElementById("notifications-popover");
        if (!button || !popover) return;
        let openTrigger = null;

        const positionVisibleTray = () => {
            if (popover.hidden) return;
            const triggerRect = button.getBoundingClientRect?.();
            const documentRect = document.documentElement?.getBoundingClientRect?.();
            const documentWidth = Number(document.documentElement?.clientWidth) || Number(documentRect?.width) || Number(window.innerWidth);
            const documentHeight = Number(document.documentElement?.clientHeight) || Number(documentRect?.height) || Number(window.innerHeight);
            if (!triggerRect || !Number.isFinite(documentWidth) || !Number.isFinite(documentHeight) || documentWidth <= 0 || documentHeight <= 0) return;

            const documentLeft = Number.isFinite(documentRect?.left) ? documentRect.left : 0;
            const documentTop = Number.isFinite(documentRect?.top) ? documentRect.top : 0;
            const documentRight = documentLeft + documentWidth;
            const documentBottom = documentTop + documentHeight;
            const triggerLeft = Number(triggerRect.left) || 0;
            const triggerTop = Number(triggerRect.top) || 0;
            const triggerRight = Number.isFinite(triggerRect.right) ? triggerRect.right : triggerLeft + (Number(triggerRect.width) || 0);
            const triggerBottom = Number.isFinite(triggerRect.bottom) ? triggerRect.bottom : triggerTop + (Number(triggerRect.height) || 0);
            const trayWidth = Number(popover.getBoundingClientRect?.()?.width) || 320;
            const inset = 12;
            const gap = 8;
            const below = Math.max(0, documentBottom - triggerBottom - gap - inset);
            const above = Math.max(0, triggerTop - documentTop - gap - inset);
            const openBelow = below >= above;
            const maxHeight = Math.floor(openBelow ? below : above);
            const left = Math.max(documentLeft + inset, Math.min(triggerRight - trayWidth, documentRight - trayWidth - inset));

            popover.style.position = "fixed";
            popover.style.left = `${Math.round(left)}px`;
            popover.style.right = "auto";
            popover.style.maxHeight = `${maxHeight}px`;
            if (openBelow) {
                popover.style.top = `${Math.round(triggerBottom + gap)}px`;
                popover.style.bottom = "auto";
            } else {
                popover.style.top = "auto";
                popover.style.bottom = `${Math.round(documentBottom - triggerTop + gap)}px`;
            }
        };
        const close = () => {
            const hadOpen = !popover.hidden;
            if (popover.contains?.(document.activeElement)) {
                (openTrigger || button).focus?.();
            }
            setAccessibleVisibility(popover, false);
            button.setAttribute("aria-expanded", "false");
            openTrigger = null;
            return hadOpen;
        };
        window.closeCompactPopovers = close;
        button.addEventListener("click", () => {
            const isOpen = !popover.hidden;
            close();
            if (!isOpen) {
                setAccessibleVisibility(popover, true);
                button.setAttribute("aria-expanded", "true");
                openTrigger = button;
                positionVisibleTray();
            }
        });
        popover.querySelector(".popover-close")?.addEventListener("click", close);
        window.addEventListener?.("resize", positionVisibleTray);
        document.addEventListener("mousedown", (event) => {
            if (!event.target?.closest?.(".compact-popover-anchor")) close();
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
                return;
            }
            // Keyboard events focused inside the iframe do not bubble to the
            // Canvas document. Once local Escape affordances have had first
            // refusal, use the same authenticated close path as the header.
            if (!isEmbeddedShell) return;
            event.preventDefault();
            event.stopPropagation();
            void closeWorkspaceOrPopup();
        });
    }

    function validateCategory(value) {
        return schema ? schema.isCategory(value) : categories.includes(value);
    }

    async function flushBeforeNavigation() {
        if (typeof window.flushPendingWrites !== "function") return;
        await window.flushPendingWrites();
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
        // Which view is showing and which host is showing it are independent:
        // the overlay shows the same workspace as a tab does, but is sized by
        // its panel rather than the viewport.
        document.body.dataset.shell = shellHost;
        document.body.dataset.mode = mode;
    }

    function replaceWorkspaceViewInUrl() {
        if (!window.history?.replaceState || !window.location?.href) return;
        try {
            const url = new URL(window.location.href);
            url.searchParams.set("view", "workspace");
            window.history.replaceState(window.history.state, "", url.href);
        } catch (error) {}
    }

    function isHiddenFocusTarget(target) {
        for (let current = target; current; current = current.parentElement) {
            if (current.hidden || current.inert || current.getAttribute?.("aria-hidden") === "true") return true;
        }
        return false;
    }

    function moveFocusBeforeHiding(node, focusTarget = null) {
        if (!node?.contains?.(document.activeElement)) return;
        const workspace = document.getElementById("workspace-view");
        const candidates = [
            focusTarget,
            document.getElementById("compact-home-trigger"),
            document.getElementById("workspace-category-select"),
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
        let draggedPage = null;

        const persist = (event, row, next, current) => {
            const controller = window.APStudyCanvasPopup;
            if (!controller?.persistSidebarOrder || !row) return;
            const page = row.dataset.sidebarPage;
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

        const move = (event, row, direction) => {
            if (!row) return;
            const current = sidebarOrderFromDom(list);
            const index = current.indexOf(row.dataset.sidebarPage);
            persist(event, row, localReorder(current, index, direction), current);
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
        list.addEventListener("dragstart", (event) => {
            const row = event.target.closest?.("[data-sidebar-page]");
            if (!row) return;
            draggedPage = row.dataset.sidebarPage;
            row.classList?.add("is-dragging");
            row.setAttribute?.("aria-grabbed", "true");
            if (event.dataTransfer) {
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData?.("text/plain", draggedPage);
            }
        });
        list.addEventListener("dragover", (event) => {
            const row = event.target.closest?.("[data-sidebar-page]");
            if (!row || !draggedPage || row.dataset.sidebarPage === draggedPage) return;
            event.preventDefault();
            if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
            row.classList?.add("is-drag-over");
        });
        list.addEventListener("dragleave", (event) => {
            const row = event.target.closest?.("[data-sidebar-page]");
            if (row && !row.contains?.(event.relatedTarget)) row.classList?.remove("is-drag-over");
        });
        list.addEventListener("drop", (event) => {
            const target = event.target.closest?.("[data-sidebar-page]");
            if (!target || !draggedPage || target.dataset.sidebarPage === draggedPage) return;
            event.preventDefault();
            const current = sidebarOrderFromDom(list);
            const next = current.filter((page) => page !== draggedPage);
            let targetIndex = next.indexOf(target.dataset.sidebarPage);
            const rect = target.getBoundingClientRect?.();
            const midpoint = Number(rect?.top || 0) + Number(rect?.height || 0) / 2;
            if (Number.isFinite(event.clientY) && midpoint && event.clientY > midpoint) targetIndex += 1;
            next.splice(Math.max(0, targetIndex), 0, draggedPage);
            persist(event, target, next, current);
            target.classList?.remove("is-drag-over");
        });
        list.addEventListener("dragend", (event) => {
            const row = event.target.closest?.("[data-sidebar-page]");
            row?.classList?.remove("is-dragging", "is-drag-over");
            row?.removeAttribute?.("aria-grabbed");
            list.querySelectorAll?.("[data-sidebar-page]").forEach((item) => item.classList?.remove("is-drag-over"));
            draggedPage = null;
        });
    }

    function updateCategoryChrome(target) {
        const next = validateCategory(target) ? target : "overview";
        workspaceCategory = next;
        document.querySelectorAll(".workspace-nav [data-workspace-target]").forEach((item) => {
            const active = item.dataset.workspaceTarget === next;
            item.classList.toggle("is-active", active);
            item.tabIndex = active ? 0 : -1;
            if (active) item.setAttribute("aria-current", "page");
            else item.removeAttribute("aria-current");
        });
        const accountRoute = document.getElementById("workspace-account-trigger");
        if (accountRoute) {
            const active = next === "calendar-accounts";
            accountRoute.classList.toggle("is-active", active);
            if (active) accountRoute.setAttribute("aria-current", "page");
            else accountRoute.removeAttribute("aria-current");
        }
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
            nextSection?.focus?.({ preventScroll: true });
        }
        sections.forEach((section) => setAccessibleVisibility(section, section === nextSection));
        window.APStudyCanvasPopup?.syncWorkspaceNavigationMode?.();
        return next;
    }

    function navButtons() {
        return Array.from(document.querySelectorAll(".workspace-nav [data-workspace-target]"));
    }

    function bindNavKeyboard() {
        const nav = document.querySelector(".workspace-nav");
        if (!nav || navKeyboardBound) return;
        navKeyboardBound = true;
        nav.addEventListener("keydown", (event) => {
            const buttons = navButtons();
            const current = event.target?.closest?.("[data-workspace-target]");
            const index = buttons.indexOf(current);
            if (index < 0) return;
            let nextIndex = -1;
            if (event.key === "ArrowDown" || event.key === "ArrowRight") nextIndex = Math.min(buttons.length - 1, index + 1);
            else if (event.key === "ArrowUp" || event.key === "ArrowLeft") nextIndex = Math.max(0, index - 1);
            else if (event.key === "Home") nextIndex = 0;
            else if (event.key === "End") nextIndex = buttons.length - 1;
            else return;
            event.preventDefault();
            const next = buttons[nextIndex];
            next?.focus?.();
            if (next?.dataset?.workspaceTarget) activateWorkspaceCategory(next.dataset.workspaceTarget);
        });
    }

    function visibleFocusables() {
        return Array.from(document.querySelectorAll("a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])"))
            .filter((node) => !isHiddenFocusTarget(node) && node.getAttribute("tabindex") !== "-1");
    }

    function bindEmbeddedFocusBridge() {
        if (!isEmbeddedShell || embeddedFocusBound) return;
        embeddedFocusBound = true;
        document.addEventListener("keydown", (event) => {
            if (event.key !== "Tab" || !event.shiftKey) return;
            const items = visibleFocusables();
            if (!items.length || document.activeElement !== items[0]) return;
            event.preventDefault();
            const control = window.APStudyCanvasPopup?.overlayControl;
            if (typeof control !== "function") {
                items[items.length - 1]?.focus?.();
                return;
            }
            Promise.resolve(control("focus", { target: "toolbar-end" })).then((result) => {
                if (result?.ok === false) items[items.length - 1]?.focus?.();
            }).catch(() => items[items.length - 1]?.focus?.());
        }, true);
    }

    function explainDisabledControls() {
        const guidance = [
            ["#nest-consent-enabled", "nest-consent-status"],
            ["#nest-consent-refresh", "nest-consent-status"],
            ["#canvas-calendar-mode-overlay", "canvas-calendar-mode-help canvas-calendar-mode-status"],
            ["#canvas-calendar-mode-replace", "canvas-calendar-mode-help canvas-calendar-mode-status"],
            ["#calendar-sync-start", "calendar-sync-status"],
            ["#calendar-sync-resume", "calendar-sync-status"],
            ["#calendar-sync-cancel", "calendar-sync-status"],
            ["#calendar-sync-refresh", "calendar-sync-status"],
            ["#canvas-current-account-sync-opt-in", "canvas-current-account-help"]
        ];
        guidance.forEach(([selector, describedBy]) => {
            const control = document.querySelector(selector);
            if (!control) return;
            if (!control.getAttribute?.("aria-describedby")) control.setAttribute?.("aria-describedby", describedBy);
        });
    }

    function activateCategory(target, persist = true, { focus = true, enterDetail = true } = {}) {
        const next = validateCategory(target) ? target : "overview";
        if (next !== workspaceCategory && themeDraft.isDirty() && !themeDraft.confirmLeave()) return false;
        const applied = updateCategoryChrome(next);
        if (persist) replaceWorkspaceCategoryInUrl(applied);
        if (window.APStudyCanvasPopup?.updateCategory) {
            window.APStudyCanvasPopup.updateCategory(applied, focus, enterDetail, true);
        } else if (enterDetail) {
            const content = document.querySelector(".workspace-content");
            if (content) content.scrollTop = 0;
        }
        return applied;
    }

    function replaceWorkspaceCategoryInUrl(category) {
        if (!window.history?.replaceState || !window.location?.href) return;
        try {
            const url = new URL(window.location.href);
            if (category === "overview") url.searchParams.delete("category");
            else url.searchParams.set("category", category);
            window.history.replaceState(window.history.state, "", url.href);
        } catch (error) {}
    }

    // Category selection is a local, synchronous operation. Do not make the
    // rail or compact picker wait for account/calendar initialization: that
    // work can legitimately be unavailable while an embedded frame is
    // recovering its host session.
    function activateWorkspaceCategory(category) {
        const applied = activateCategory(category);
        if (applied === false) return false;
        clearSearchInputs();
        void ensureWorkspaceReady().catch(() => {
            setWorkspaceStatus("Workspace settings are temporarily unavailable.", true);
        });
        return applied;
    }

    function bindWorkspaceNavigation() {
        if (workspaceNavigationBound) return;
        document.querySelectorAll("[data-workspace-target]").forEach((item) => {
            item.addEventListener("click", () => {
                activateWorkspaceCategory(item.dataset.workspaceTarget);
            });
        });
        bindNavKeyboard();
        document.getElementById("workspace-category-select")?.addEventListener("change", (event) => {
            activateWorkspaceCategory(event.target.value);
        });
        workspaceNavigationBound = true;
    }

    function bindWorkspaceInteractions() {
        if (workspaceInteractionsBound) return;
        bindWorkspaceNavigation();
        bindEmbeddedFocusBridge();
        explainDisabledControls();
        document.querySelectorAll(".workspace-overview-link[data-workspace-overview]").forEach((link) => {
            link.addEventListener("click", (event) => {
                event.preventDefault();
                if (!themeDraft.confirmLeave()) return;
                clearSearchInputs();
                enterWorkspace("overview");
            });
        });
        workspaceInteractionsBound = true;
    }

    function ensureWorkspaceReady() {
        if (!workspaceSetupPromise) {
            const popupSetup = typeof window.APStudyCanvasPopup?.init === "function"
                ? window.APStudyCanvasPopup.init()
                : Promise.resolve();
            workspaceSetupPromise = Promise.resolve(popupSetup).then(() => {
                bindWorkspaceInteractions();
                setupSidebarReorderRenderer();
                workspaceReady = true;
            });
        }
        return workspaceSetupPromise;
    }

    function enterWorkspace(category) {
        setViewMode("workspace");
        setAccessibleVisibility(document.getElementById("workspace-view"), true);
        replaceWorkspaceViewInUrl();
        bindWorkspaceNavigation();
        // Make the visible category and URL state immediate even if optional
        // identity/account work is still pending in this embedded session.
        const applied = activateCategory(category);
        if (applied === false) return Promise.resolve(false);
        clearSearchInputs();
        return ensureWorkspaceReady().then(() => {
            return true;
        });
    }

    function setManualCloseStatus(message = "", isError = false) {
        const status = document.getElementById("manual-close-status");
        if (!status) return;
        status.textContent = message;
        status.classList.toggle("is-error", Boolean(isError));
    }

    function showManualClosePrompt(message = "") {
        const prompt = document.getElementById("manual-close-prompt");
        if (!prompt) return;
        setManualCloseStatus(message, Boolean(message));
        if (typeof prompt.showModal === "function" && !prompt.open) prompt.showModal();
        else prompt.hidden = false;
    }

    function manualCloseFailureMessage(code) {
        if (code === "OVERLAY_DISCARD_CANCELLED") return "Close cancelled. Your edits are still open.";
        if (code === "OVERLAY_SESSION_REQUIRED" || code === "OVERLAY_SESSION_STALE" || code === "OVERLAY_SESSION_MISMATCH") {
            return "This workspace session is no longer active. Reload the workspace before trying again.";
        }
        if (code === "OVERLAY_CLOSE_PENDING") return "A close check is still in progress. Wait a moment, then try again.";
        return "APStudyCanvas could not confirm the discard. Your edits are still open.";
    }

    async function requestEmbeddedDiscardClose() {
        const discardButton = document.getElementById("manual-close-discard");
        if (discardButton) discardButton.disabled = true;
        setManualCloseStatus("Waiting for Canvas to confirm the discard…");
        try {
            const result = await window.APStudyCanvasPopup?.overlayControl?.("discard-close", { confirmDiscard: true });
            if (result?.ok !== true) {
                showManualClosePrompt(manualCloseFailureMessage(result?.code));
                return result || { ok: false, code: "OVERLAY_HOST_UNAVAILABLE" };
            }
            setManualCloseStatus("");
            return result;
        } catch (error) {
            showManualClosePrompt(manualCloseFailureMessage("OVERLAY_HOST_UNAVAILABLE"));
            return { ok: false, code: "OVERLAY_HOST_UNAVAILABLE" };
        } finally {
            if (discardButton) discardButton.disabled = false;
        }
    }

    async function closeWorkspaceOrPopup() {
        try {
            if (!themeDraft.confirmLeave()) return;
            await flushBeforeNavigation();
            if (isEmbeddedShell) {
                // window.close() is inert in an iframe and tabs.remove would
                // take the Canvas page down with the overlay. Ask the host to
                // run its close transition instead.
                const result = await window.APStudyCanvasPopup?.overlayControl?.("close");
                if (result?.ok !== true) showManualClosePrompt("Canvas could not verify whether theme edits are still pending. Discard only if you are ready to lose them.");
                return;
            }
            if (ownsHostTab) {
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
            if (!themeDraft.confirmLeave()) return;
            void enterWorkspace("overview").catch(() => {
                setWorkspaceStatus("Workspace settings are temporarily unavailable.", true);
            });
        });
        document.getElementById("compact-close")?.addEventListener("click", () => closeWorkspaceOrPopup());
        document.querySelector("#manual-close-prompt form")?.addEventListener("submit", async (event) => {
            if (event.submitter?.value === "close") {
                event.preventDefault();
                if (isEmbeddedShell) await requestEmbeddedDiscardClose();
                else window.close();
            } else {
                setManualCloseStatus("");
            }
        });
    }

    async function setupWorkspace() {
        const workspace = document.getElementById("workspace-view");
        if (!workspace) return;
        setViewMode("workspace");
        setAccessibleVisibility(workspace, true);
        replaceWorkspaceViewInUrl();
        const context = readWorkspaceContext();
        workspaceSourceTabId = context.sourceTabId;
        updateCategoryChrome(context.category);
        // The category shell remains usable even if optional settings data is
        // still loading (or the host has asked this frame to retry).
        bindWorkspaceNavigation();
        await ensureWorkspaceReady();
        setViewMode("workspace");
        // Hydration is not a category entry and must preserve user navigation and scroll.
        window.APStudyCanvasPopup?.syncWorkspaceNavigationMode?.();
    }

    function getWorkspaceSourceTabId() {
        return workspaceSourceTabId;
    }

    window.APStudyCanvasWorkspace = {
        get category() { return workspaceCategory; },
        get sourceTabId() { return getWorkspaceSourceTabId(); },
        activateCategory,
        confirmLeave: (message) => themeDraft.confirmLeave(message),
        get themeDraftDirty() { return themeDraft.isDirty(); }
    };

    function startShell() {
        if (shellStartupPromise) return shellStartupPromise;
        shellStartupPromise = Promise.resolve().then(async () => {
            setupGlobalSearch();
            setupPopovers();
            setupHeader();
            await setupWorkspace();
            return window.APStudyCanvasWorkspace;
        });
        shellStartupPromise.catch(() => setWorkspaceStatus("Workspace settings are temporarily unavailable.", true));
        return shellStartupPromise;
    }

    window.APStudyCanvasEditCanvasStartup = Object.freeze({ start: startShell });
    document.addEventListener("DOMContentLoaded", startShell, { once: true });
}());
