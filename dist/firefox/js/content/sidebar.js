(function (root, factory) {
    "use strict";
    const api = factory();
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasContent = Object.assign(root.APStudyCanvasContent || {}, { Sidebar: api });
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const NAMESPACE = "apstudycanvas-sidebar";
    const STYLE_ID = "apstudycanvas-sidebar-style";
    const MARKER = "data-apstudycanvas-sidebar-mounted";
    const CONTROLLER_SLOT = "__apstudycanvasSidebarController";
    const DEFAULT_ORDER = Object.freeze(["dashboard", "courses", "calendar", "inbox", "history", "help"]);
    const DEFAULT_VISIBILITY = Object.freeze({ dashboard: true, courses: true, calendar: true, inbox: true, history: true, help: true });
    const ITEM_SELECTORS = Object.freeze({
        dashboard: "#global_nav_dashboard_link",
        courses: "#global_nav_courses_link",
        calendar: "#global_nav_calendar_link",
        inbox: "#global_nav_conversations_link, #global_nav_inbox_link",
        history: "#global_nav_history_link",
        help: "#global_nav_help_link"
    });
    const LOGO_SELECTORS = "#global_nav_logo, #global-nav-logo, .ic-app-header__logomark, .ic-app-header__brand";
    const LABELS = Object.freeze({ dashboard: "Dashboard", courses: "Courses", calendar: "Calendar", inbox: "Inbox", history: "History", help: "Help" });
    const registry = typeof WeakMap === "function" ? new WeakMap() : new Map();

    function normalizeOrder(value, defaults = DEFAULT_ORDER) {
        const known = Array.isArray(defaults)
            ? defaults.filter((item, index, all) => typeof item === "string" && all.indexOf(item) === index)
            : DEFAULT_ORDER.slice();
        const values = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
        const seen = new Set();
        const output = [];
        values.forEach((item) => {
            if (typeof item !== "string" || !known.includes(item) || seen.has(item)) return;
            seen.add(item);
            output.push(item);
        });
        known.forEach((item) => {
            if (seen.has(item)) return;
            seen.add(item);
            output.push(item);
        });
        return output;
    }

    function isPlainObject(value) {
        if (!value || typeof value !== "object" || Array.isArray(value)) return false;
        const prototype = Object.getPrototypeOf(value);
        return prototype === Object.prototype || prototype === null;
    }

    function asBoolean(value, fallback) { return typeof value === "boolean" ? value : fallback; }
    function asNumber(value, fallback, min, max) {
        const number = Number(value);
        return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback;
    }
    function attr(node, name) { return node?.getAttribute?.(name) ?? null; }
    function setAttr(node, name, value) {
        if (!node) return;
        if (value === null || value === undefined) node.removeAttribute?.(name);
        else node.setAttribute?.(name, String(value));
    }
    function childNodes(parent) { return Array.from(parent?.childNodes || parent?.children || []); }
    function getItemContainer(node) { return node?.parentElement || node?.parentNode || node; }

    function toggleClass(node, name, value) {
        if (!node) return;
        if (node.classList?.toggle) {
            node.classList.toggle(name, Boolean(value));
            return;
        }
        const classes = new Set(String(attr(node, "class") || "").split(/\s+/).filter(Boolean));
        if (value) classes.add(name); else classes.delete(name);
        setAttr(node, "class", Array.from(classes).join(" ") || null);
    }

    function captureAttributes(node) {
        if (!node) return [];
        const output = [];
        const attributes = node.attributes;
        if (attributes && typeof attributes[Symbol.iterator] === "function") {
            for (const item of attributes) output.push([String(item.name), String(item.value)]);
        } else if (attributes && Number.isInteger(attributes.length)) {
            for (let index = 0; index < attributes.length; index += 1) {
                const item = attributes[index];
                if (item) output.push([String(item.name), String(item.value)]);
            }
        }
        return output;
    }

    function restoreAttributes(node, saved) {
        if (!node) return;
        captureAttributes(node).forEach(([name]) => node.removeAttribute?.(name));
        (saved || []).forEach(([name, value]) => node.setAttribute?.(name, value));
    }

    function findById(doc, id) { return doc?.getElementById?.(id) || doc?.querySelector?.(`#${id}`) || null; }

    function createSidebarController({
        document: doc = globalThis.document,
        window: win = globalThis.window,
        chromeApi = globalThis.chrome,
        listenStorage = true,
        root: injectedRoot = null,
        rootResolver = null,
        itemNodes = null,
        itemResolver = null
    } = {}) {
        if (!doc) return { init() {}, apply() {}, reset() {}, pause() {}, resume() {}, dispose() {}, needsRefresh() { return false; } };
        const existing = registry.get(doc) || doc[CONTROLLER_SLOT];
        if (existing) return existing;

        let root = null;
        let snapshot = null;
        let styleNode = null;
        let styleOwned = false;
        let storageListener = null;
        let initialized = false;
        let paused = false;
        let state = {};
        let api;

        function findRoot() {
            if (typeof rootResolver === "function") return rootResolver();
            if (injectedRoot) return typeof injectedRoot === "function" ? injectedRoot() : injectedRoot;
            return doc?.querySelector?.("#global_nav, #global-nav, .ic-app-header") || null;
        }

        function queryWithinRoot(selector) {
            return root?.querySelector?.(selector) || null;
        }

        function getItemNode(key) {
            if (typeof itemResolver === "function") return itemResolver(key);
            if (itemNodes && itemNodes[key]) return typeof itemNodes[key] === "function" ? itemNodes[key]() : itemNodes[key];
            return queryWithinRoot(ITEM_SELECTORS[key]) || doc?.querySelector?.(ITEM_SELECTORS[key]) || null;
        }

        function getLogo() { return queryWithinRoot(LOGO_SELECTORS) || doc?.querySelector?.(LOGO_SELECTORS) || null; }

        function rememberParent(parent) {
            if (!parent || !snapshot || snapshot.parents.has(parent)) return;
            snapshot.parents.set(parent, { children: childNodes(parent) });
        }

        function capturePlacement(node) {
            const candidate = getItemContainer(node);
            // Canvas normally wraps links in menu-item elements. If a shell
            // exposes direct links under the injected root, touching the root
            // as every item's container would hide/reorder the whole nav.
            const item = candidate === root ? node : candidate;
            const parent = item?.parentNode || null;
            rememberParent(parent);
            return {
                node,
                item,
                parent,
                index: parent ? childNodes(parent).indexOf(item) : 0,
                itemAttributes: captureAttributes(item),
                nodeAttributes: captureAttributes(node)
            };
        }

        function captureDirectPlacement(node) {
            const parent = node?.parentNode || null;
            rememberParent(parent);
            return {
                node,
                parent,
                index: parent ? childNodes(parent).indexOf(node) : 0,
                nodeAttributes: captureAttributes(node)
            };
        }

        function capture() {
            if (!root) return;
            if (!snapshot || snapshot.root !== root) {
                const existingStyle = findById(doc, STYLE_ID);
                snapshot = {
                    root,
                    rootAttributes: captureAttributes(root),
                    rootPlacement: null,
                    logo: null,
                    items: {},
                    parents: new Map(),
                    style: existingStyle ? {
                        node: existingStyle,
                        attributes: captureAttributes(existingStyle),
                        textContent: existingStyle.textContent
                    } : null
                };
                snapshot.rootPlacement = captureDirectPlacement(root);
            }

            const logo = getLogo();
            if (logo && snapshot.logo !== logo) {
                if (snapshot.logo) restoreAttributes(snapshot.logo.node, snapshot.logo.nodeAttributes);
                snapshot.logo = captureDirectPlacement(logo);
            }

            DEFAULT_ORDER.forEach((key) => {
                const node = getItemNode(key);
                if (!node) return;
                const previous = snapshot.items[key];
                if (previous?.node === node) return;
                if (previous) {
                    restoreAttributes(previous.item, previous.itemAttributes);
                    restoreAttributes(previous.node, previous.nodeAttributes);
                }
                snapshot.items[key] = capturePlacement(node);
            });
        }

        function ensureStyle() {
            if (!doc?.createElement) return null;
            let style = findById(doc, STYLE_ID);
            if (!style) {
                style = doc.createElement("style");
                setAttr(style, "id", STYLE_ID);
                setAttr(style, "data-apstudycanvas", "sidebar");
                (doc.head || doc.documentElement || root)?.appendChild?.(style);
                styleOwned = true;
            }
            styleNode = style;
            style.textContent = `
#global_nav.${NAMESPACE}, #global-nav.${NAMESPACE}, .ic-app-header.${NAMESPACE} { --apstudycanvas-sidebar-expanded-width: 280px; --apstudycanvas-sidebar-collapsed-width: 56px; --apstudycanvas-sidebar-icon-size: 18px; --apstudycanvas-sidebar-label-size: 13px; }
#global_nav.${NAMESPACE}.apstudycanvas-sidebar-expanded, #global-nav.${NAMESPACE}.apstudycanvas-sidebar-expanded, .ic-app-header.${NAMESPACE}.apstudycanvas-sidebar-expanded { width: var(--apstudycanvas-sidebar-expanded-width) !important; }
#global_nav.${NAMESPACE}.apstudycanvas-sidebar-collapsed, #global-nav.${NAMESPACE}.apstudycanvas-sidebar-collapsed, .ic-app-header.${NAMESPACE}.apstudycanvas-sidebar-collapsed { width: var(--apstudycanvas-sidebar-collapsed-width) !important; }
#global_nav.${NAMESPACE} .ic-app-header__menu-list-item-label, #global-nav.${NAMESPACE} .ic-app-header__menu-list-item-label, .ic-app-header.${NAMESPACE} .ic-app-header__menu-list-item-label { font-size: var(--apstudycanvas-sidebar-label-size) !important; }
#global_nav.${NAMESPACE} svg, #global-nav.${NAMESPACE} svg, .ic-app-header.${NAMESPACE} svg { width: var(--apstudycanvas-sidebar-icon-size); height: var(--apstudycanvas-sidebar-icon-size); }
#global_nav.${NAMESPACE}.apstudycanvas-sidebar-compact .ic-app-header__menu-list-item, #global-nav.${NAMESPACE}.apstudycanvas-sidebar-compact .ic-app-header__menu-list-item, .ic-app-header.${NAMESPACE}.apstudycanvas-sidebar-compact .ic-app-header__menu-list-item { min-height: 36px !important; }
#global_nav.${NAMESPACE}.apstudycanvas-sidebar-comfortable .ic-app-header__menu-list-item, #global-nav.${NAMESPACE}.apstudycanvas-sidebar-comfortable .ic-app-header__menu-list-item, .ic-app-header.${NAMESPACE}.apstudycanvas-comfortable .ic-app-header__menu-list-item { min-height: 48px !important; }
#global_nav.${NAMESPACE}.apstudycanvas-sidebar-collapsed .ic-app-header__menu-list-item-label, #global-nav.${NAMESPACE}.apstudycanvas-sidebar-collapsed .ic-app-header__menu-list-item-label, .ic-app-header.${NAMESPACE}.apstudycanvas-sidebar-collapsed .ic-app-header__menu-list-item-label { display: none !important; }
#global_nav.${NAMESPACE} .${NAMESPACE}-hidden, #global-nav.${NAMESPACE} .${NAMESPACE}-hidden, .ic-app-header.${NAMESPACE} .${NAMESPACE}-hidden { display: none !important; }
#global_nav.${NAMESPACE} .${NAMESPACE}-logo-hidden, #global-nav.${NAMESPACE} .${NAMESPACE}-logo-hidden, .ic-app-header.${NAMESPACE} .${NAMESPACE}-logo-hidden { display: none !important; }
`;
            return style;
        }

        function requestedEnabled(settings) {
            for (const key of ["sidebar_enabled", "enable_sidebar", "enabled", "better_sidebar"]) {
                if (typeof settings?.[key] === "boolean") return settings[key];
            }
            return false;
        }

        function labelsFor(settings) {
            const candidate = settings.sidebar_page_labels || settings.sidebar_labels;
            if (!isPlainObject(candidate)) return LABELS;
            return Object.fromEntries(DEFAULT_ORDER.map((key) => [
                key,
                typeof candidate[key] === "string" && candidate[key].trim()
                    ? candidate[key].replace(/\s+/g, " ").trim().slice(0, 80)
                    : LABELS[key]
            ]));
        }

        function visibilityFor(settings) {
            const candidate = settings.sidebar_page_visibility;
            if (!isPlainObject(candidate)) return DEFAULT_VISIBILITY;
            return Object.fromEntries(DEFAULT_ORDER.map((key) => [key, typeof candidate[key] === "boolean" ? candidate[key] : DEFAULT_VISIBILITY[key]]));
        }

        function setStyleProperty(node, name, value) {
            if (node?.style?.setProperty) node.style.setProperty(name, value);
            else if (node) setAttr(node, "style", `${attr(node, "style") || ""}${name}:${value};`);
        }

        function reorderKnownItems(parent, orderedItems) {
            if (!parent || orderedItems.length < 2) return;
            const unique = Array.from(new Set(orderedItems.filter((item) => item?.parentNode === parent)));
            if (unique.length < 2) return;
            const known = new Set(unique);
            const unknown = childNodes(parent).filter((child) => !known.has(child));
            unique.forEach((item) => parent.removeChild?.(item));
            const anchor = unknown[0]?.parentNode === parent ? unknown[0] : null;
            unique.forEach((item) => {
                if (anchor) parent.insertBefore?.(item, anchor);
                else parent.appendChild?.(item);
            });
        }

        function originalAttribute(entry, attribute) {
            return entry?.nodeAttributes?.find?.(([name]) => name === attribute)?.[1] ?? null;
        }

        function originalItemAttribute(entry, attribute) {
            return entry?.itemAttributes?.find?.(([name]) => name === attribute)?.[1] ?? null;
        }

        function apply(settings = {}) {
            const nextRoot = findRoot();
            if (nextRoot !== root) {
                reset();
                root = nextRoot;
            }
            state = Object.assign({}, state, Object.fromEntries(Object.entries(settings || {}).filter(([, value]) => value !== undefined)));
            if (!root || paused) return false;
            capture();
            if (!requestedEnabled(state)) {
                reset();
                return false;
            }

            ensureStyle();
            setAttr(root, MARKER, "1");
            toggleClass(root, NAMESPACE, true);
            const scale = asNumber(state.sidebar_scale, 100, 70, 150) / 100;
            const expandedWidth = asNumber(asNumber(state.sidebar_expanded_width, 280, 180, 420) * scale, 280, 180, 630);
            const collapsedWidth = asNumber(asNumber(state.sidebar_collapsed_width, 56, 40, 120) * scale, 56, 40, 180);
            const iconSize = asNumber(asNumber(state.sidebar_icon_size, 18, 12, 32) * scale, 18, 8, 48);
            const labelSize = asNumber(asNumber(state.sidebar_label_size, 13, 10, 20) * scale, 13, 8, 30);
            setStyleProperty(root, "--apstudycanvas-sidebar-expanded-width", `${expandedWidth}px`);
            setStyleProperty(root, "--apstudycanvas-sidebar-collapsed-width", `${collapsedWidth}px`);
            setStyleProperty(root, "--apstudycanvas-sidebar-icon-size", `${iconSize}px`);
            setStyleProperty(root, "--apstudycanvas-sidebar-label-size", `${labelSize}px`);

            const density = ["compact", "dense"].includes(state.sidebar_density) ? "compact" : "comfortable";
            toggleClass(root, `${NAMESPACE}-compact`, density === "compact");
            toggleClass(root, `${NAMESPACE}-comfortable`, density !== "compact");
            const mode = /^\/courses\/\d+(?:\/|$)/.test(win?.location?.pathname || "") ? "course" : "dashboard";
            const expandedKey = mode === "course" ? "course_sidebar_expanded" : "dashboard_sidebar_expanded";
            const expanded = asBoolean(state[expandedKey], true);
            toggleClass(root, `${NAMESPACE}-expanded`, expanded);
            toggleClass(root, `${NAMESPACE}-collapsed`, !expanded);
            setAttr(root, "data-apstudycanvas-sidebar-state", expanded ? "expanded" : "collapsed");
            setAttr(root, "data-apstudycanvas-sidebar-mode", mode);

            const visibility = visibilityFor(state);
            const labels = labelsFor(state);
            const order = normalizeOrder(state.sidebar_page_order);
            const knownItems = [];
            order.forEach((key) => {
                const node = getItemNode(key);
                const entry = snapshot?.items[key];
                if (!node || !entry) return;
                const item = entry.item;
                if (!knownItems.includes(item)) knownItems.push(item);
                const hidden = visibility[key] === false;
                toggleClass(item, `${NAMESPACE}-hidden`, hidden);
                setAttr(item, "hidden", hidden ? "" : originalItemAttribute(entry, "hidden"));
                setAttr(item, "aria-hidden", hidden ? "true" : originalItemAttribute(entry, "aria-hidden"));
                if (!expanded && state.sidebar_tooltips !== false) setAttr(node, "title", labels[key]);
                else setAttr(node, "title", originalAttribute(entry, "title"));
                if (!expanded && state.sidebar_accessibility_labels !== false) setAttr(node, "aria-label", labels[key]);
                else setAttr(node, "aria-label", originalAttribute(entry, "aria-label"));
            });

            const parents = new Set(knownItems.map((item) => item?.parentNode).filter(Boolean));
            parents.forEach((parent) => reorderKnownItems(parent, knownItems.filter((item) => item?.parentNode === parent)));
            const logo = getLogo();
            if (logo && snapshot.logo) toggleClass(logo, `${NAMESPACE}-logo-hidden`, state.sidebar_logo_visible === false);
            return true;
        }

        function restoreChildren(parent, children) {
            if (!parent || !children) return;
            children.forEach((child) => {
                if (child?.parentNode === parent) parent.appendChild?.(child);
            });
        }

        function restoreSnapshot() {
            if (!snapshot) return;
            const saved = snapshot;
            restoreAttributes(saved.root, saved.rootAttributes);
            Object.values(saved.items).forEach((entry) => {
                restoreAttributes(entry.item, entry.itemAttributes);
                restoreAttributes(entry.node, entry.nodeAttributes);
            });
            if (saved.logo) restoreAttributes(saved.logo.node, saved.logo.nodeAttributes);
            saved.parents.forEach((entry, parent) => restoreChildren(parent, entry.children));
            if (saved.style) {
                restoreAttributes(saved.style.node, saved.style.attributes);
                saved.style.node.textContent = saved.style.textContent;
            } else if (styleOwned && styleNode) {
                styleNode.remove?.();
            } else if (styleOwned) {
                findById(doc, STYLE_ID)?.remove?.();
            }
        }

        function reset() {
            restoreSnapshot();
            root = null;
            snapshot = null;
            styleNode = null;
            styleOwned = false;
        }

        function needsRefresh(settings = state) {
            if (!requestedEnabled(settings)) return false;
            const nextRoot = findRoot();
            if (!nextRoot || nextRoot !== root) return true;
            return DEFAULT_ORDER.some((key) => !getItemNode(key));
        }

        function onStorageChanged(changes, areaName) {
            if (areaName !== "sync" || !changes) return;
            const relevant = [
                "better_sidebar", "sidebar_enabled", "enable_sidebar", "sidebar_scale", "sidebar_expanded_width", "sidebar_collapsed_width",
                "sidebar_density", "sidebar_icon_size", "sidebar_label_size", "sidebar_logo_visible", "sidebar_page_order",
                "sidebar_page_visibility", "sidebar_page_labels", "sidebar_labels", "sidebar_tooltips", "sidebar_accessibility_labels",
                "dashboard_sidebar_expanded", "course_sidebar_expanded"
            ];
            if (!relevant.some((key) => Object.prototype.hasOwnProperty.call(changes, key))) return;
            const updates = {};
            relevant.forEach((key) => {
                if (Object.prototype.hasOwnProperty.call(changes, key)) updates[key] = changes[key]?.newValue;
            });
            apply(updates);
        }

        function init(settings = {}) {
            if (initialized) {
                apply(settings);
                return api;
            }
            initialized = true;
            if (listenStorage && chromeApi?.storage?.onChanged?.addListener) {
                storageListener = onStorageChanged;
                chromeApi.storage.onChanged.addListener(storageListener);
            }
            apply(settings);
            return api;
        }

        function pause() { paused = true; }
        function resume(settings = {}) { paused = false; apply(settings); }
        function dispose() {
            if (storageListener) chromeApi?.storage?.onChanged?.removeListener?.(storageListener);
            storageListener = null;
            reset();
            state = {};
            initialized = false;
            paused = false;
            if (registry.get(doc) === api) registry.delete(doc);
            if (doc[CONTROLLER_SLOT] === api) {
                try { delete doc[CONTROLLER_SLOT]; } catch (error) { doc[CONTROLLER_SLOT] = null; }
            }
        }

        api = Object.freeze({
            init,
            apply,
            reset,
            pause,
            resume,
            dispose,
            onStorageChanged,
            needsRefresh,
            isInitialized: () => initialized,
            isPaused: () => paused,
            handlesStorageChanges: listenStorage,
            constants: Object.freeze({ NAMESPACE, MARKER, DEFAULT_ORDER, DEFAULT_VISIBILITY })
        });
        registry.set(doc, api);
        try { doc[CONTROLLER_SLOT] = api; } catch (error) {}
        return api;
    }

    return Object.freeze({ NAMESPACE, STYLE_ID, MARKER, DEFAULT_ORDER, DEFAULT_VISIBILITY, normalizeOrder, createSidebarController });
}));
