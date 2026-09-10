(function (root, factory) {
    "use strict";
    const api = factory(root?.APStudyCanvasContent?.CanvasSearchIndex);
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasContent = Object.assign(root.APStudyCanvasContent || {}, { CanvasSearchUI: api });
}(typeof globalThis !== "undefined" ? globalThis : this, function (defaultIndexApi) {
    "use strict";

    const ROOT_CLASS = "apstudy-canvas-search";
    const MAX_RENDERED_RESULTS = 40;
    const DEFAULT_DEBOUNCE_MS = 140;
    // The index has its own deadline, but the surface must also be able to
    // recover if an integration/provider violates that contract. This is a
    // UI ownership boundary: a command palette may never wait forever.
    const DEFAULT_REFRESH_TIMEOUT_MS = 35000;
    const TYPE_LABELS = Object.freeze({ assignment: "Assignments", file: "Files", page: "Pages", module: "Modules" });

    function node(doc, tag, className, value) {
        const result = /^(svg|path)$/.test(tag) && doc.createElementNS ? doc.createElementNS("http://www.w3.org/2000/svg", tag) : doc.createElement(tag);
        if (className) {
            if (/^(svg|path)$/.test(tag)) result.setAttribute("class", className);
            else result.className = className;
        }
        if (value !== undefined) result.textContent = String(value);
        return result;
    }
    function isEditable(target) {
        return Boolean(target?.isContentEditable || /^(?:input|textarea|select)$/i.test(target?.tagName || ""));
    }
    function ownSafeHref(value, origin) {
        if (typeof value !== "string" || !origin) return null;
        try {
            const url = new URL(value, origin);
            if (url.origin !== origin || url.protocol !== "https:" || url.username || url.password) return null;
            return `${url.pathname}${url.search}${url.hash}`;
        } catch (error) { return null; }
    }
    function grouping(items) {
        return items.reduce((groups, item) => {
            if (!TYPE_LABELS[item.type]) return groups;
            (groups[item.type] || (groups[item.type] = [])).push(item);
            return groups;
        }, {});
    }
    function searchIcon(doc, type = "search") {
        const icon = node(doc, "svg", type === "search" ? "apstudy-canvas-search__search-icon" : "apstudy-canvas-search__result-icon");
        icon.setAttribute("aria-hidden", "true"); icon.setAttribute("viewBox", "0 0 24 24"); icon.setAttribute("fill", "none");
        const path = node(doc, "path");
        const paths = {
            search: "m20 20-4.35-4.35m2.35-5.15a7.5 7.5 0 1 1-15 0 7.5 7.5 0 0 1 15 0Z",
            assignment: "M9 4H6v17h12V4h-3M9 3h6v4H9V3Zm0 9h6m-6 4h4",
            file: "M6 3h8l4 4v14H6V3Zm8 0v5h4",
            page: "M6 3h12v18H6V3Zm3 5h6m-6 4h6m-6 4h4",
            module: "M3 4h7v7H3V4Zm11 0h7v7h-7V4ZM3 15h7v6H3v-6Zm11 0h7v6h-7v-6Z"
        };
        path.setAttribute("d", paths[type] || paths.file); path.setAttribute("stroke", "currentColor"); path.setAttribute("stroke-linecap", "round"); path.setAttribute("stroke-width", "1.8");
        icon.append(path); return icon;
    }

    function createCanvasSearchUI({ document: doc = globalThis.document, window: win = globalThis.window, indexApi = defaultIndexApi, debounceMs = DEFAULT_DEBOUNCE_MS, refreshTimeoutMs = DEFAULT_REFRESH_TIMEOUT_MS } = {}) {
        let root = null; let host = null; let options = null; let open = false; let disposed = false;
        let previousFocus = null; let active = -1; let results = []; let query = ""; let timer = null; let generation = 0;
        let session = 0; let refreshController = null; let status = "idle"; let error = ""; let notice = ""; let input = null; let list = null; let statusNode = null;
        const listeners = [];
        let shortcutFrames = new WeakMap();
        const delay = Number.isFinite(debounceMs) ? Math.max(0, Math.min(500, debounceMs)) : DEFAULT_DEBOUNCE_MS;
        const refreshDeadline = Number.isFinite(refreshTimeoutMs) ? Math.max(1, Math.min(120000, Math.round(refreshTimeoutMs))) : DEFAULT_REFRESH_TIMEOUT_MS;
        const supported = () => Boolean(doc?.createElement && options?.index?.query && options?.origin && options?.accountId && options?.enabled && !options?.quizSafe);
        const add = (target, type, handler, config) => { if (!target?.addEventListener) return; target.addEventListener(type, handler, config); listeners.push(() => target.removeEventListener?.(type, handler, config)); };
        const clearTimer = () => { if (timer !== null) (win?.clearTimeout || clearTimeout)(timer); timer = null; };
        const cancelRefresh = () => { refreshController?.abort(); refreshController = null; };
        const safeHref = (href) => (indexApi?.safeHref || ownSafeHref)(href, options?.origin);
        const optionId = (position) => `apstudy-canvas-search-option-${position}`;

        function announce(message, mode = "polite") {
            if (!statusNode) return;
            statusNode.setAttribute("role", mode === "assertive" ? "alert" : "status");
            statusNode.textContent = message;
        }
        function setActive(next) {
            active = results.length ? Math.max(0, Math.min(results.length - 1, next)) : -1;
            if (input) input.setAttribute("aria-activedescendant", active >= 0 ? optionId(active) : "");
            root?.querySelectorAll?.("[data-canvas-search-result]").forEach?.((item) => {
                const selected = Number(item.dataset.canvasSearchResult) === active;
                item.setAttribute("aria-selected", String(selected));
                if (selected) item.scrollIntoView?.({ block: "nearest" });
            });
        }
        function render() {
            if (!root) return;
            const content = root.querySelector?.("[data-canvas-search-content]");
            if (!content) return;
            // Keep the same input and selection while replacing result/status nodes.
            const restoreInputFocus = doc?.activeElement === input;
            const selection = input ? [input.selectionStart, input.selectionEnd] : null;
            content.replaceChildren();
            const heading = node(doc, "h2", "apstudy-canvas-search__title apstudy-canvas-search__visually-hidden", "Search Canvas"); heading.id = "apstudy-canvas-search-title";
            const help = node(doc, "p", "apstudy-canvas-search__help apstudy-canvas-search__visually-hidden", "Search your local Canvas index. Use ↑ and ↓ to choose a result."); help.id = "apstudy-canvas-search-help";
            const field = node(doc, "div", "apstudy-canvas-search__field");
            input = input || node(doc, "input", "apstudy-canvas-search__input"); input.id = "apstudy-canvas-search-input"; input.type = "search"; input.autocomplete = "off"; input.spellcheck = false; input.value = query; input.placeholder = "Search assignments, files, pages…"; input.setAttribute("aria-label", "Search Canvas assignments, files, pages, and modules"); input.setAttribute("aria-describedby", help.id); input.setAttribute("role", "combobox"); input.setAttribute("aria-autocomplete", "list"); input.setAttribute("aria-controls", "apstudy-canvas-search-results"); input.setAttribute("aria-expanded", "true");
            field.append(searchIcon(doc), input); content.append(heading, help, field);
            statusNode = node(doc, "p", "apstudy-canvas-search__status apstudy-canvas-search__visually-hidden"); statusNode.setAttribute("aria-live", "polite"); statusNode.setAttribute("aria-atomic", "true"); content.append(statusNode);
            list = node(doc, "div", "apstudy-canvas-search__results"); list.id = "apstudy-canvas-search-results"; list.setAttribute("role", "listbox"); list.setAttribute("aria-label", "Canvas search results");
            if (status === "loading" || refreshController) {
                const state = node(doc, "p", "apstudy-canvas-search__state apstudy-canvas-search__state--loading");
                const spinner = node(doc, "span", "apstudy-canvas-search__spinner"); spinner.setAttribute("aria-hidden", "true");
                state.append(spinner, node(doc, "span", "apstudy-canvas-search__state-copy", refreshController ? "Refreshing your local Canvas index…" : "Searching your local Canvas index…")); list.append(state);
                announce(refreshController ? "Refreshing your local Canvas index" : "Searching your local Canvas index");
            }
            if (status === "error") {
                const message = node(doc, "p", "apstudy-canvas-search__state apstudy-canvas-search__state--error", error || "Canvas search is unavailable. Try again when Canvas is online.");
                const retry = node(doc, "button", "apstudy-canvas-search__retry", "Refresh local index"); retry.type = "button"; retry.dataset.canvasSearchAction = "refresh"; list.append(message, retry); announce(message.textContent, "assertive");
            }
            if (!query.trim() && !refreshController && status !== "error") {
                list.append(node(doc, "p", "apstudy-canvas-search__state", "Start typing to search the local index.")); announce("Start typing to search the local index");
            } else if (query.trim() && !results.length && !refreshController && status !== "loading" && status !== "error") {
                list.append(node(doc, "p", "apstudy-canvas-search__state", "No matching Canvas items in the local index.")); announce("No matching Canvas items");
            } else if (query.trim() && results.length) {
                const groups = grouping(results);
                Object.entries(TYPE_LABELS).forEach(([type, label]) => {
                    const items = groups[type]; if (!items?.length) return;
                    const group = node(doc, "section", "apstudy-canvas-search__group"); const title = node(doc, "h3", "apstudy-canvas-search__group-title", label); const entries = node(doc, "div", "apstudy-canvas-search__group-items");
                    items.forEach((item) => {
                        const position = results.indexOf(item); const result = node(doc, "button", "apstudy-canvas-search__result"); result.type = "button"; result.tabIndex = -1; result.id = optionId(position); result.dataset.canvasSearchResult = String(position); result.setAttribute("role", "option"); result.setAttribute("aria-selected", String(position === active));
                        const titleNode = node(doc, "span", "apstudy-canvas-search__result-title", item.title || "Untitled Canvas item"); const meta = node(doc, "span", "apstudy-canvas-search__result-meta", [item.courseName || item.course, item.moduleLabel || item.summary].filter(Boolean).join(" · ") || label.slice(0, -1)); const copy = node(doc, "span", "apstudy-canvas-search__result-copy"); copy.append(titleNode, meta);
                        const icon = searchIcon(doc, type);
                        result.append(icon, copy); entries.append(result);
                    }); group.append(title, entries); list.append(group);
                });
                if (status !== "error" && !refreshController) announce(`${results.length} matching Canvas item${results.length === 1 ? "" : "s"}`);
            }
            if (notice) {
                const message = node(doc, "p", "apstudy-canvas-search__notice", notice);
                const retry = node(doc, "button", "apstudy-canvas-search__retry", "Try refresh again"); retry.type = "button"; retry.dataset.canvasSearchAction = "refresh";
                content.append(message, retry);
            }
            content.append(list);
            const footer = node(doc, "div", "apstudy-canvas-search__footer");
            const navigateHint = node(doc, "span", "apstudy-canvas-search__hint"); const arrows = node(doc, "kbd", "apstudy-canvas-search__key", "↑↓"); navigateHint.append(arrows, node(doc, "span", "", "navigate"));
            const openHint = node(doc, "span", "apstudy-canvas-search__hint"); const enter = node(doc, "kbd", "apstudy-canvas-search__key", "Enter"); openHint.append(enter, node(doc, "span", "", "open"));
            const close = node(doc, "button", "apstudy-canvas-search__close"); close.type = "button"; close.dataset.canvasSearchAction = "close"; const escape = node(doc, "kbd", "apstudy-canvas-search__key", "Esc"); close.append(escape, node(doc, "span", "", "to close"));
            const reload = node(doc, "button", "apstudy-canvas-search__close", "Refresh"); reload.type = "button"; reload.dataset.canvasSearchAction = "refresh"; reload.disabled = Boolean(refreshController);
            footer.append(navigateHint, openHint, reload, close); content.append(footer); setActive(active);
            if (restoreInputFocus) { input?.focus?.(); if (selection && Number.isInteger(selection[0])) input?.setSelectionRange?.(...selection); }
        }
        async function queryIndex() {
            if (!open || !supported()) return;
            const thisGeneration = ++generation; status = "loading"; error = ""; render();
            try {
                const response = await options.index.query({ origin: options.origin, accountId: options.accountId, enabled: true, query, limit: MAX_RENDERED_RESULTS });
                if (!open || disposed || thisGeneration !== generation) return;
                results = Array.isArray(response?.items) ? response.items.filter((item) => TYPE_LABELS[item?.type] && safeHref(item?.href)).sort((a, b) => Object.keys(TYPE_LABELS).indexOf(a.type) - Object.keys(TYPE_LABELS).indexOf(b.type)) : [];
                active = results.length ? 0 : -1; status = "ready"; render();
                if (response?.stale) announce(`${results.length} matching Canvas items. The local index may be out of date.`);
            } catch (cause) {
                if (!open || disposed || thisGeneration !== generation) return;
                results = []; active = -1; status = "error"; error = "Canvas search could not read the local index. Try refreshing it when Canvas is online."; render();
            }
        }
        function scheduleQuery() { clearTimer(); timer = (win?.setTimeout || setTimeout)(queryIndex, delay); }
        async function refresh() {
            if (!open || !supported() || typeof options.collect !== "function" || typeof options.index.refresh !== "function") return;
            clearTimer(); cancelRefresh(); const controller = new AbortController(); refreshController = controller; status = "refreshing"; error = ""; notice = ""; render();
            let deadlineTimer = null;
            try {
                const outcome = await Promise.race([
                    Promise.resolve(options.index.refresh({ origin: options.origin, accountId: options.accountId, enabled: true, collect: options.collect, signal: controller.signal }))
                        .then((value) => ({ value }), (cause) => ({ cause })),
                    new Promise((resolve) => {
                        deadlineTimer = (win?.setTimeout || setTimeout)(() => {
                            controller.abort();
                            resolve({ timeout: true });
                        }, refreshDeadline);
                    })
                ]);
                if (outcome.timeout) throw new Error("CANVAS_SEARCH_TIMEOUT");
                if (outcome.cause) throw outcome.cause;
                const response = outcome.value;
                if (!open || disposed || controller.signal.aborted || refreshController !== controller) return;
                if (!response?.ok) throw new Error(response?.code || "refresh failed");
                notice = response.partial ? "Some Canvas resource types were unavailable or reached the search limit. Results may be incomplete." : "";
                refreshController = null; status = "ready"; await queryIndex();
            } catch (cause) {
                const code = cause?.message || cause?.code;
                // A user/route cancellation is intentionally quiet, while the
                // palette's own deadline abort is a recoverable failure that
                // must replace the loading state with a retry action.
                if (!open || disposed || refreshController !== controller || (controller.signal.aborted && code !== "CANVAS_SEARCH_TIMEOUT")) return;
                status = "error"; error = code === "CANVAS_SEARCH_RATE_LIMITED"
                    ? "Canvas asked us to slow down. Try refreshing the local index again in a moment; existing local results remain unchanged."
                    : code === "CANVAS_SEARCH_TIMEOUT"
                        ? "Canvas took too long to refresh the local index. Existing local results remain unchanged; try again when Canvas is responsive."
                        : code === "CANVAS_SEARCH_WRITE_FAILED"
                            ? "Canvas items were read, but the local index could not be saved. Try refreshing again; existing local results remain unchanged."
                            : code === "CANVAS_SEARCH_CANCELLED"
                                ? "Canvas index refresh was cancelled. Existing local results remain unchanged."
                                : "Canvas index refresh failed. Your existing local results remain private and unchanged."; render();
            } finally {
                if (deadlineTimer !== null) (win?.clearTimeout || clearTimeout)(deadlineTimer);
                if (refreshController === controller) { refreshController = null; render(); }
            }
        }
        function emitIntent(item, event) {
            const href = safeHref(item?.href); if (!href || !options?.onNavigate) return;
            const newTab = Boolean(event?.shiftKey || (event?.ctrlKey || event?.metaKey));
            options.onNavigate(Object.freeze({ type: "canvas-search-navigation", href, disposition: newTab ? "new-tab" : "current-tab", userGesture: true, source: "canvas-search" }));
            close();
        }
        function focusables() { return Array.from(root?.querySelectorAll?.("button:not([disabled]), input:not([disabled])") || []).filter((item) => item.tabIndex !== -1); }
        function onKeydown(event) {
            if (!open || event.isComposing) return;
            if (event.key === "Escape") { event.preventDefault?.(); close(); return; }
            if (event.key === "ArrowDown") { event.preventDefault?.(); setActive(active + 1); return; }
            if (event.key === "ArrowUp") { event.preventDefault?.(); setActive(active - 1); return; }
            if (event.key === "Home" && event.target !== input) { event.preventDefault?.(); setActive(0); return; }
            if (event.key === "End" && event.target !== input) { event.preventDefault?.(); setActive(results.length - 1); return; }
            if (event.key === "Enter" && active >= 0 && !event.target?.closest?.("[data-canvas-search-action]")) { event.preventDefault?.(); emitIntent(results[active], event); return; }
            if (event.key === "Tab") { const items = Array.from(focusables()); if (!items.length) return; const at = items.indexOf(doc.activeElement); const next = event.shiftKey ? (at <= 0 ? items.length - 1 : at - 1) : (at === items.length - 1 ? 0 : at + 1); event.preventDefault?.(); items[next]?.focus?.(); }
        }
        function onRootClick(event) {
            if (event.target === root) { close(); return; }
            const action = event.target?.closest?.("[data-canvas-search-action]")?.dataset?.canvasSearchAction;
            if (action === "close") { close(); return; }
            if (action === "refresh") { refresh(); return; }
            const result = event.target?.closest?.("[data-canvas-search-result]"); if (result) emitIntent(results[Number(result.dataset.canvasSearchResult)], event);
        }
        function onRootInput(event) { if (event.target !== input) return; query = input.value || ""; generation += 1; active = -1; results = []; scheduleQuery(); }
        function onGlobalKeydown(event) {
            if (event.defaultPrevented || event.isComposing || event.altKey || !(event.ctrlKey || event.metaKey) || String(event.key).toLowerCase() !== "k" || isEditable(event.target)) return;
            if (!open && supported()) { event.preventDefault?.(); show(); }
        }
        function bindFrameShortcut(frame) {
            if (!frame) return;
            // Canvas occasionally keeps the active surface in a same-origin
            // iframe. Keyboard events do not bubble from that document into
            // the host window, so attach the one command owner there too.
            // Access to a cross-origin frame throws and is intentionally
            // ignored; no frame content is read or retained.
            try {
                const frameWindow = frame.contentWindow;
                if (shortcutFrames.get(frame) === frameWindow) return;
                const wasBound = shortcutFrames.has(frame);
                shortcutFrames.set(frame, frameWindow);
                if (frameWindow && frameWindow !== win) add(frameWindow, "keydown", onGlobalKeydown);
                if (!wasBound) add(frame, "load", () => bindFrameShortcut(frame));
            } catch (error) {}
        }
        function bindFrameShortcuts() {
            doc?.querySelectorAll?.("iframe")?.forEach?.(bindFrameShortcut);
            const Observer = win?.MutationObserver || globalThis.MutationObserver;
            if (typeof Observer !== "function" || !doc?.documentElement) return;
            const observer = new Observer(() => doc?.querySelectorAll?.("iframe")?.forEach?.(bindFrameShortcut));
            observer.observe(doc.documentElement, { childList: true, subtree: true });
            listeners.push(() => observer.disconnect?.());
        }
        function mount(nextHost, nextOptions = {}) {
            destroy(); host = nextHost; options = { ...nextOptions }; disposed = false;
            if (!supported() || !host?.append) return false;
            root = node(doc, "div", ROOT_CLASS); root.dataset.apstudycanvasOwned = "true"; root.dataset.extensionTheme = ["light", "dark", "system"].includes(nextOptions.theme) ? nextOptions.theme : "light"; root.hidden = true; root.setAttribute("role", "dialog"); root.setAttribute("aria-modal", "true"); root.setAttribute("aria-labelledby", "apstudy-canvas-search-title");
            const content = node(doc, "div", "apstudy-canvas-search__content"); content.dataset.canvasSearchContent = "true"; root.append(content); host.append(root);
            add(root, "keydown", onKeydown); add(root, "click", onRootClick); add(root, "input", onRootInput); add(win, "keydown", onGlobalKeydown); bindFrameShortcuts(); return true;
        }
        function show() { if (!root || !supported() || open) return false; previousFocus = doc.activeElement || null; open = true; session += 1; root.hidden = false; query = ""; results = []; active = -1; status = "ready"; error = ""; notice = ""; render(); input?.focus?.(); if (typeof options.collect === "function") {
                const openingSession = session;
                if (typeof options.index.read !== "function") refresh();
                else Promise.resolve(options.index.read({ origin: options.origin, accountId: options.accountId, enabled: true })).then((cached) => {
                    if (!open || disposed || openingSession !== session) return;
                    if (!cached?.fresh) refresh();
                }, () => { if (open && !disposed && openingSession === session) refresh(); });
            } return true; }
        function close() { if (!open) return false; open = false; session += 1; generation += 1; clearTimer(); cancelRefresh(); if (root) root.hidden = true; const restore = previousFocus; previousFocus = null; restore?.focus?.(); return true; }
        function toggle() { return open ? close() : show(); }
        function setTheme(theme) { if (!root) return false; root.dataset.extensionTheme = ["light", "dark", "system"].includes(theme) ? theme : "light"; return true; }
        function bindTrigger(trigger) { if (!trigger?.addEventListener) return () => {}; const handler = (event) => { event.preventDefault?.(); show(); }; trigger.addEventListener("click", handler); return () => trigger.removeEventListener?.("click", handler); }
        function destroy() { close(); disposed = true; generation += 1; clearTimer(); cancelRefresh(); listeners.splice(0).forEach((remove) => remove()); shortcutFrames = new WeakMap(); root?.remove?.(); root = null; host = null; input = null; list = null; statusNode = null; results = []; options = null; }
        return { mount, show, close, toggle, setTheme, bindTrigger, refresh, destroy, isOpen: () => open, isMounted: () => Boolean(root), maxRenderedResults: MAX_RENDERED_RESULTS };
    }
    return { ROOT_CLASS, MAX_RENDERED_RESULTS, DEFAULT_DEBOUNCE_MS, DEFAULT_REFRESH_TIMEOUT_MS, TYPE_LABELS, createCanvasSearchUI };
}));
