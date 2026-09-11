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
    const categories = schema ? schema.categories : ["overview", "appearance", "sidebar", "course-cards", "study-tools", "themes", "gpa-grades", "canvas-search", "calendar-accounts", "notifications", "data-support"];
    const startupQuery = new URLSearchParams(window.location.search);
    // popup-controller.js loads first and owns the route vocabulary. The inline
    // fallback keeps this file inspectable on its own without duplicating the
    // rule anywhere that matters at runtime.
    const shellApi = typeof APStudyCanvasPopupController !== "undefined" ? APStudyCanvasPopupController : null;
    const foundationApi = typeof APStudyCanvasWorkspaceFoundation !== "undefined" ? APStudyCanvasWorkspaceFoundation : null;
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
    let workspaceRoute = foundationApi?.parseRoute?.(window.location.search)?.name || "settings";
    let workspaceModuleHost = null;
    let routeTrigger = null;
    let embeddedFullscreen = false;
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
            Promise.resolve(popup?.signalDraftState?.({ draft: this.isDirty() || Boolean(workspaceModuleHost?.queryDirtySync?.()) })).catch((error) => {
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
            draft: themeDraft.isDirty() || Boolean(workspaceModuleHost?.queryDirtySync?.())
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
        entries.push({ id: "route-notes", route: "notes", label: "Notes", helper: "Search and edit local notes", terms: "notes local text course recent search" });
        entries.push({ id: "route-grades", route: "grades", label: "Grades", helper: "Open grade workspace", terms: "grades gpa analytics graph class course" });
        entries.push({ id: "route-planner", route: "planner", label: "Planner", helper: "Open calendar workspace", terms: "planner calendar schedule day week month" });
        const canvasSearch = document.getElementById("workspace-section-canvas-search");
        if (canvasSearch) entries.unshift({ id: "canvas-search-route", action: "canvas-search", label: "Search Canvas", helper: "Open local Canvas search", terms: "canvas search courses assignments pages people local" });
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
        item.textContent = `${entry.label} · ${entry.route ? "workspace" : entry.action === "canvas-search" ? "Canvas" : entry.category}`;
        item.addEventListener("click", () => {
            clearSearchInputs();
            if (entry.action === "canvas-search") void openCanvasSearch(sourceInput);
            else if (entry.route) void navigateWorkspaceRoute(entry.route, { trigger: sourceInput, detail: entry.detail });
            else openModernTarget(entry.target, entry.category, sourceInput);
        });
        return item;
    }

    let searchGeneration = 0;
    async function renderSearch(definition) {
        const generation = ++searchGeneration;
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
        let noteMatches = [];
        try { noteMatches = await getNotesModule()?.search(query, makeModuleContext()) || []; } catch (_) {}
        if (generation !== searchGeneration || input.value.trim().toLowerCase() !== query) return;
        const matches = [...noteMatches, ...buildSettingsIndex().filter((entry) => entry.terms.includes(query))].slice(0, 12);
        results.hidden = false;
        input.setAttribute("aria-expanded", "true");
        if (empty) empty.hidden = Boolean(matches.length);
        if (!matches.length) {
            results.appendChild(Object.assign(document.createElement("div"), { textContent: "No local notes or settings match that search." }));
            live.textContent = "No local notes or settings match that search.";
            return;
        }
        live.textContent = `${matches.length} result${matches.length === 1 ? "" : "s"} found.`;
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

    async function openCanvasSearch(sourceInput = null) {
        if (!isEmbeddedShell) {
            setWorkspaceStatus("Open APStudyCanvas from a verified Canvas page to search its local Canvas index.", true);
            sourceInput?.focus?.();
            return false;
        }
        const result = await window.APStudyCanvasPopup?.overlayControl?.("canvas-search");
        if (result?.ok === true) return true;
        setWorkspaceStatus("Canvas Search is unavailable in this Canvas session. Reload Canvas and try again.", true);
        sourceInput?.focus?.();
        return false;
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

    const FEATURE_COPY = Object.freeze({
        grades: Object.freeze({ title: "Grades", description: "Your grade overview and class analytics will mount here. Canvas remains the source of truth; this Foundation route does not calculate or change grades." }),
        planner: Object.freeze({ title: "Planner", description: "Your connected planning workspace will mount here after verified Nest capability and consent checks. Canvas deadlines remain authoritative." }),
        notes: Object.freeze({ title: "Notes", description: "Your local, account-scoped notes workspace will mount here. Notes remain on this device unless you explicitly save them through an approved feature adapter." }),
        study: Object.freeze({ title: "Study", description: "Study remains the existing Canvas workspace and keeps its current records. Open this route from a connected Canvas page." })
    });

    function renderFeatureRoute(route, status = "") {
        const copy = FEATURE_COPY[route] || FEATURE_COPY.notes;
        const title = document.getElementById("feature-route-title");
        const description = document.getElementById("feature-route-description");
        const state = document.getElementById("feature-route-status");
        if (title) title.textContent = copy.title;
        if (description) description.textContent = copy.description;
        if (state) state.textContent = status;
    }

    function setRouteChrome(route) {
        workspaceRoute = foundationApi?.normalizeRoute?.(route) || "settings";
        document.body.dataset.workspaceRoute = workspaceRoute;
        document.querySelectorAll("[data-workspace-route]").forEach((button) => {
            if (button === document.body) return;
            const active = button.dataset.workspaceRoute === workspaceRoute;
            button.classList.toggle("is-active", active);
            if (active) button.setAttribute("aria-current", "page");
            else button.removeAttribute("aria-current");
        });
    }

    function replaceWorkspaceRouteInUrl(route, { replace = false } = {}) {
        if (!window.location?.href) return;
        try {
            const href = foundationApi?.routeUrl?.(window.location.href, route, workspaceCategory);
            if (!href) return;
            const method = replace ? "replaceState" : "pushState";
            window.history?.[method]?.({ ...(window.history.state || {}), apstudyWorkspaceRoute: route }, "", href);
        } catch (error) {}
    }

    let notesModule = null;
    function getNotesModule() {
        if (!notesModule && window.APStudyCanvasWorkspaceNotes) {
            const host = document.createElement("div");
            host.id = "notes-module-host";
            document.getElementById("feature-route-host")?.append(host);
            notesModule = window.APStudyCanvasWorkspaceNotes.createWorkspaceNotes({
                document, window, host,
                readCourses: async () => window.APStudyCanvasPopup?.state?.sidebarCourses || [],
                onDirtyChange: () => themeDraft.notify()
            });
        }
        return notesModule;
    }

    const PLANNER_BRIDGE_FAMILIES = new Set([
        "NEST_CALENDAR_RANGE_GET",
        "NEST_CALENDAR_EVENT_CREATE",
        "NEST_CALENDAR_EVENT_UPDATE",
        "NEST_CALENDAR_EVENT_DELETE"
    ]);
    const PLANNER_IMPORT_LEDGER_PREFIX = "apstudycanvas.planner.import-ledger.v1:";

    function plannerConsentSnapshot(value) {
        const normalize = (item) => {
            if (!item || typeof item !== "object" || Array.isArray(item)) return item;
            return {
                ...item,
                account_key: item.account_key ?? item.accountKey ?? null,
                granted: item.granted === true || (item.valid === true && item.current === true && item.revoked !== true)
            };
        };
        if (!value || typeof value !== "object" || Array.isArray(value)) return value;
        return { ...value, ...(value.read ? { read: normalize(value.read) } : {}), ...(value.write ? { write: normalize(value.write) } : {}) };
    }

    function liveControllerState() {
        const popup = window.APStudyCanvasPopup;
        const state = popup?.state && typeof popup.state === "object" ? popup.state : {};
        let connection = null;
        try { connection = popup?.connection?.getSnapshot?.() || null; } catch (error) {}
        return {
            ...state,
            identity: connection?.identity || state.identity,
            capabilities: connection?.capabilities || connection?.identity?.capabilities || null,
            consent: plannerConsentSnapshot(connection?.consent || null)
        };
    }

    function verifiedModuleAccount() {
        return foundationApi?.verifiedAccountContext?.(liveControllerState()) || null;
    }

    function localStorageAdapter() {
        return Object.freeze({
            get: (key) => storageCall("local", "get", key),
            set: (value) => storageCall("local", "set", value)
        });
    }

    function legacyWorkspaceContext(account = verifiedModuleAccount()) {
        const origin = account?.canvas?.origin;
        const accountId = account?.canvas?.accountId;
        return origin && /^\d+$/.test(String(accountId || "")) ? { origin, accountId: String(accountId) } : null;
    }

    function createLegacyWorkspaceStore(account = verifiedModuleAccount()) {
        const model = window.APStudyCanvasContent?.WorkspaceModel;
        const context = legacyWorkspaceContext(account);
        if (!model?.createStore || !context) return null;
        return model.createStore({
            storage: localStorageAdapter(),
            context,
            verify: async () => {
                const current = legacyWorkspaceContext();
                if (!current) throw new Error("Your Canvas account changed. Close and reopen this workspace.");
                return current;
            }
        });
    }

    function plannerTimeZone() {
        try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch (error) { return "UTC"; }
    }

    async function localPlannerEvents(range, account) {
        const store = createLegacyWorkspaceStore(account);
        const helper = window.APStudyCanvasWorkspacePlannerAdapter?.localDateKey;
        if (!store || typeof helper !== "function") return [];
        const record = await store.load();
        const zone = plannerTimeZone();
        const first = helper(range.start, zone);
        const last = helper(range.end, zone);
        return (record.planner || []).filter((task) => task.date >= first && task.date < last).map((task) => ({
            id: `local:${task.id}`,
            event_ref: `local:${task.id}`,
            title: task.title,
            start: task.date,
            end: task.date,
            all_day: true,
            editable: false,
            completed: false,
            source_type: "local",
            source_label: "Local tasks",
            calendar_id: "local-workspace",
            source_color: "#8a6d1d",
            course_id: task.courseId || null
        }));
    }

    async function sendPlannerBridge(type, payload) {
        if (!PLANNER_BRIDGE_FAMILIES.has(type)) throw new Error("PLANNER_BRIDGE_FAMILY_UNSUPPORTED");
        const contract = window.APStudyCanvasPlatform?.Contract;
        const runtime = chrome?.runtime;
        if (!contract?.createEnvelope || typeof runtime?.sendMessage !== "function") throw new Error("PLANNER_BRIDGE_UNAVAILABLE");
        const requestId = `planner-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        const response = await runtime.sendMessage(contract.createEnvelope(type, payload || {}, requestId));
        const result = response?.payload || response;
        if (!result || result.ok === false) throw new Error(result?.code || "PLANNER_BRIDGE_FAILED");
        if (type !== "NEST_CALENDAR_RANGE_GET") return result;
        const local = await localPlannerEvents(payload, verifiedModuleAccount());
        if (!local.length) return result;
        const sources = Array.isArray(result.sources) ? result.sources.slice() : [];
        if (!sources.some((source) => source?.id === "local-workspace")) sources.push({ id: "local-workspace", label: "Local tasks", color: "#8a6d1d" });
        return { ...result, events: [...(Array.isArray(result.events) ? result.events : []), ...local], sources };
    }

    function createPlannerImportLedger(account) {
        const scope = typeof account?.scope === "string" && account.scope.startsWith("canvas:") ? account.scope : null;
        if (!scope) return null;
        const key = `${PLANNER_IMPORT_LEDGER_PREFIX}${encodeURIComponent(scope)}`;
        let tail = Promise.resolve();
        const read = async () => {
            const value = (await storageCall("local", "get", key))?.[key];
            return Array.isArray(value) ? value.filter((item) => typeof item === "string").slice(-500) : [];
        };
        return Object.freeze({
            async has(value) { return (await read()).includes(String(value)); },
            add(value) {
                const operation = tail.then(async () => {
                    if (verifiedModuleAccount()?.scope !== scope) throw new Error("PLANNER_ACCOUNT_STALE");
                    const values = await read();
                    const next = [...values.filter((item) => item !== String(value)), String(value)].slice(-500);
                    await storageCall("local", "set", { [key]: next });
                });
                tail = operation.catch(() => {});
                return operation;
            }
        });
    }

    function createPlannerRouteModule() {
        let ui = null;
        let unsubscribe = null;
        let currentRoute = null;
        let refreshTail = Promise.resolve();
        return Object.freeze({
            async mount(context, route) {
                const plannerApi = window.APStudyCanvasWorkspacePlanner;
                const adapterApi = window.APStudyCanvasWorkspacePlannerAdapter;
                if (!plannerApi?.createWorkspacePlanner || !adapterApi?.createPlannerAdapter) throw new Error("PLANNER_MODULE_UNAVAILABLE");
                const featureHost = document.getElementById("feature-route-host");
                const placeholder = featureHost?.querySelector(".feature-route-placeholder");
                if (placeholder) placeholder.hidden = true;
                const host = document.createElement("div");
                host.id = "planner-module-host";
                featureHost?.append(host);
                setAccessibleVisibility(document.getElementById("workspace-view"), false);
                setAccessibleVisibility(featureHost, true);
                const account = verifiedModuleAccount();
                const adapter = adapterApi.createPlannerAdapter({
                    send: sendPlannerBridge,
                    getAccount: verifiedModuleAccount,
                    timeZone: plannerTimeZone(),
                    importLedger: createPlannerImportLedger(account)
                });
                ui = plannerApi.createWorkspacePlanner({
                    document,
                    window,
                    host,
                    adapter,
                    preferences: localStorageAdapter(),
                    onDirtyChange: () => themeDraft.notify()
                });
                currentRoute = route;
                const mounted = await ui.mount(context, route);
                unsubscribe = window.APStudyCanvasPopup?.connection?.subscribe?.(() => {
                    refreshTail = refreshTail.then(() => ui?.routeUpdate?.(currentRoute || {}, makeModuleContext())).catch(() => {});
                }) || null;
                return Object.freeze({
                    routeUpdate(nextRoute, nextContext) { currentRoute = nextRoute; return ui?.routeUpdate?.(nextRoute, nextContext); },
                    queryDirty: () => ui?.queryDirty?.() === true,
                    async dispose(reason) {
                        unsubscribe?.(); unsubscribe = null;
                        const active = ui; ui = null; currentRoute = null;
                        await active?.dispose?.(reason);
                        host.remove?.();
                    },
                    mounted
                });
            }
        });
    }

    function routeModules() {
        const settings = {
            async mount(_context, route) {
                setAccessibleVisibility(document.getElementById("feature-route-host"), false);
                setAccessibleVisibility(document.getElementById("workspace-view"), true);
                if (route.category) activateCategory(route.category, false, { focus: false, enterDetail: false });
                await ensureWorkspaceReady();
                return {
                    routeUpdate: (nextRoute) => activateCategory(nextRoute.category || "overview", false, { focus: false, enterDetail: false }),
                    queryDirty: () => themeDraft.isDirty(),
                    dispose() {}
                };
            }
        };
        const feature = (name) => ({
            async mount() {
                setAccessibleVisibility(document.getElementById("workspace-view"), false, document.querySelector(`[data-workspace-route="${name}"]`));
                const host = document.getElementById("feature-route-host");
                const placeholder = host?.querySelector(".feature-route-placeholder");
                if (placeholder) placeholder.hidden = false;
                renderFeatureRoute(name);
                setAccessibleVisibility(host, true);
                if (name === "study" && isEmbeddedShell) {
                    const result = await window.APStudyCanvasPopup?.overlayControl?.("legacy-route", { route: "study" });
                    if (result?.ok !== true) renderFeatureRoute(name, "Study could not open from this Canvas session. Your existing Study data was not changed.");
                }
                return { queryDirty: () => false, dispose() {} };
            }
        });
        return { settings, grades: feature("grades"), planner: createPlannerRouteModule(), notes: {
            async mount(context, route) {
                const module = getNotesModule();
                if (!module) throw new Error("NOTES_MODULE_UNAVAILABLE");
                setAccessibleVisibility(document.getElementById("workspace-view"), false);
                const host = document.getElementById("feature-route-host");
                const placeholder = host?.querySelector(".feature-route-placeholder");
                if (placeholder) placeholder.hidden = true;
                setAccessibleVisibility(host, true);
                return module.mount(context, route);
            }
        }, study: feature("study") };
    }

    function makeModuleContext() {
        return Object.freeze({
            get account() { return verifiedModuleAccount(); },
            get shellHost() { return shellHost; },
            get sourceTabId() { return workspaceSourceTabId; },
            status: setWorkspaceStatus,
            onDirtyChange: () => themeDraft.notify(),
            actions: Object.freeze({
                connectNest: () => navigateWorkspaceRoute("settings", { category: "calendar-accounts" }),
                reviewPlannerConsent: () => navigateWorkspaceRoute("settings", { category: "calendar-accounts" })
            })
        });
    }

    function ensureModuleHost() {
        if (workspaceModuleHost || !foundationApi?.createModuleHost) return workspaceModuleHost;
        workspaceModuleHost = foundationApi.createModuleHost({
            modules: routeModules(),
            context: makeModuleContext(),
            confirmLeave: (from) => from === "settings"
                ? themeDraft.confirmLeave("Discard unsaved theme edits before leaving Settings?")
                : window.confirm("Discard unsaved changes before leaving this page?") === true,
            beforeRoute: async (from, to) => {
                routeTrigger = document.activeElement;
                if (to !== "settings" && isEmbeddedShell) {
                    const released = await window.APStudyCanvasPopup?.overlayControl?.("preview", { enabled: false });
                    if (released?.ok !== true) throw new Error("WORKSPACE_PREVIEW_RELEASE_FAILED");
                }
            },
            afterRoute: async (route) => {
                setRouteChrome(route);
                if (route === "settings" && isEmbeddedShell) await window.APStudyCanvasPopup?.overlayControl?.("preview", { enabled: true });
                const destination = route === "settings"
                    ? document.querySelector('[data-workspace-route="settings"]')
                    : document.getElementById("feature-route-host");
                destination?.focus?.({ preventScroll: true });
            }
        });
        return workspaceModuleHost;
    }

    function showRouteFailure(result) {
        if (result?.code === "WORKSPACE_DIRTY_BLOCKED") return;
        setWorkspaceStatus("That workspace destination is temporarily unavailable.", true);
        routeTrigger?.focus?.({ preventScroll: true });
    }

    async function navigateWorkspaceRoute(route, { history = true, replace = false, trigger = null, category = workspaceCategory, detail = {} } = {}) {
        const next = foundationApi?.normalizeRoute?.(route) || "settings";
        if (trigger) routeTrigger = trigger;
        const result = await ensureModuleHost()?.navigate(next, { ...detail, category });
        if (result?.ok !== true) { showRouteFailure(result); return result; }
        if (history && (!result.reused || replace)) replaceWorkspaceRouteInUrl(next, { replace });
        clearSearchInputs();
        return result;
    }

    function bindRouteNavigation() {
        document.querySelectorAll("#workspace-route-nav [data-workspace-route]").forEach((button) => {
            button.addEventListener("click", () => void navigateWorkspaceRoute(button.dataset.workspaceRoute, { trigger: button }));
        });
        window.addEventListener("popstate", () => {
            const route = foundationApi?.parseRoute?.(window.location.search) || { name: "settings", category: "overview" };
            void navigateWorkspaceRoute(route.name, { history: false, category: route.category }).then((result) => {
                if (result?.ok !== true) replaceWorkspaceRouteInUrl(workspaceRoute, { replace: true });
            });
        });
        window.addEventListener("pagehide", () => { void workspaceModuleHost?.dispose?.("pagehide"); }, { once: true });
        window.addEventListener("beforeunload", (event) => {
            if (!themeDraft.isDirty() && !workspaceModuleHost?.queryDirtySync?.()) return;
            event.preventDefault();
            event.returnValue = "";
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
        const storageHint = document.querySelector(".workspace-sidebar-footer span:last-child");
        if (storageHint) storageHint.textContent = next === "notifications" ? "Notifications save to this device" : "Changes save to sync";
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
        if (workspaceModuleHost?.route && workspaceModuleHost.route !== "settings") {
            return navigateWorkspaceRoute("settings", { category }).then((result) => result?.ok === true);
        }
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
            if (workspaceModuleHost?.route !== "settings" && await workspaceModuleHost?.queryDirty?.()
                && window.confirm("Discard unsaved changes and close the workspace?") !== true) return;
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
            void navigateWorkspaceRoute("settings", { category: "overview" }).catch(() => {
                setWorkspaceStatus("Workspace settings are temporarily unavailable.", true);
            });
        });
        document.getElementById("compact-close")?.addEventListener("click", () => closeWorkspaceOrPopup());
        const expand = document.getElementById("compact-expand");
        if (expand) {
            expand.hidden = false;
            expand.title = "Toggle fullscreen";
            expand.setAttribute("aria-label", "Toggle fullscreen");
            expand.addEventListener("click", async () => {
                if (isEmbeddedShell) {
                    embeddedFullscreen = !embeddedFullscreen;
                    const result = await window.APStudyCanvasPopup?.overlayControl?.("fullscreen", { value: embeddedFullscreen });
                    if (result?.ok !== true) embeddedFullscreen = !embeddedFullscreen;
                    expand.setAttribute("aria-pressed", embeddedFullscreen ? "true" : "false");
                    return;
                }
                try {
                    if (document.fullscreenElement) await document.exitFullscreen?.();
                    else await document.documentElement?.requestFullscreen?.();
                } catch (error) { setWorkspaceStatus("Fullscreen is unavailable in this window.", true); }
            });
        }
        document.querySelector("#manual-close-prompt form")?.addEventListener("submit", async (event) => {
            if (event.submitter?.value === "close") {
                event.preventDefault();
                if (isEmbeddedShell) await requestEmbeddedDiscardClose();
                else window.close();
            } else {
                setManualCloseStatus("");
            }
        });
        document.addEventListener("keydown", (event) => {
            if (event.key !== "Escape" || event.defaultPrevented) return;
            if (workspaceRoute !== "settings") {
                event.preventDefault();
                void navigateWorkspaceRoute("settings", { trigger: document.querySelector(`[data-workspace-route="${workspaceRoute}"]`) });
                return;
            }
            if (workspaceCategory !== "overview") {
                event.preventDefault();
                activateWorkspaceCategory("overview");
                return;
            }
            event.preventDefault();
            void closeWorkspaceOrPopup();
        });
    }

    async function setupWorkspace() {
        const workspace = document.getElementById("workspace-view");
        if (!workspace) return;
        setViewMode("workspace");
        setAccessibleVisibility(workspace, workspaceRoute === "settings");
        replaceWorkspaceViewInUrl();
        const context = readWorkspaceContext();
        workspaceSourceTabId = context.sourceTabId;
        const initialRoute = foundationApi?.parseRoute?.(window.location.search) || { name: "settings", category: context.category };
        workspaceRoute = initialRoute.name;
        updateCategoryChrome(initialRoute.category || context.category);
        // The category shell remains usable even if optional settings data is
        // still loading (or the host has asked this frame to retry).
        bindWorkspaceNavigation();
        bindRouteNavigation();
        await ensureWorkspaceReady();
        await navigateWorkspaceRoute(workspaceRoute, { history: false, category: initialRoute.category });
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
        get themeDraftDirty() { return themeDraft.isDirty(); },
        get route() { return workspaceRoute; },
        navigate: navigateWorkspaceRoute,
        get accountContext() { return foundationApi?.verifiedAccountContext?.(window.APStudyCanvasPopup?.state) || null; }
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
