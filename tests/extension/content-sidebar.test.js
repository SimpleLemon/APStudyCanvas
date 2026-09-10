"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const sidebar = require("../../js/content/sidebar.js");
const sidebarAdapter = require("../../js/content/sidebar-adapter.js");
const sidebarWatchdog = require("../../js/content/sidebar-watchdog.js");

class FakeNode {
    constructor(tagName = "div", attributes = {}, namespaceURI = null) {
        this.tagName = tagName.toUpperCase();
        this.namespaceURI = namespaceURI;
        this.nodeType = 1;
        this.parentNode = null;
        this.parentElement = null;
        this.childNodes = [];
        this.textContent = "";
        this.listeners = new Map();
        this.focused = false;
        this._attributes = new Map();
        this.style = {
            setProperty: (name, value) => {
                this.style[name] = String(value);
                this._syncStyleAttribute();
            },
            removeProperty: (name) => {
                delete this.style[name];
                this._syncStyleAttribute();
            }
        };
        Object.entries(attributes).forEach(([name, value]) => this.setAttribute(name, value));
        this.classList = {
            add: (...names) => names.forEach((name) => this.classList.toggle(name, true)),
            remove: (...names) => names.forEach((name) => this.classList.toggle(name, false)),
            toggle: (name, force) => {
                const classes = new Set(String(this.getAttribute("class") || "").split(/\s+/).filter(Boolean));
                const next = force === undefined ? !classes.has(name) : Boolean(force);
                if (next) classes.add(name); else classes.delete(name);
                this.setAttribute("class", Array.from(classes).join(" "));
                return next;
            },
            contains: (name) => String(this.getAttribute("class") || "").split(/\s+/).includes(name)
        };
    }

    get id() { return this.getAttribute("id") || ""; }
    set id(value) { this.setAttribute("id", value); }
    get firstChild() { return this.childNodes[0] || null; }
    get children() { return this.childNodes; }
    get attributes() { return Array.from(this._attributes, ([name, value]) => ({ name, value })); }

    _syncStyleAttribute() {
        const values = Object.entries(this.style)
            .filter(([name, value]) => !["setProperty", "removeProperty"].includes(name) && typeof value !== "function")
            .map(([name, value]) => `${name}:${value};`);
        if (values.length) this._attributes.set("style", values.join(""));
        else this._attributes.delete("style");
    }

    _syncStyleObject(value) {
        Object.keys(this.style).forEach((name) => {
            if (!["setProperty", "removeProperty"].includes(name)) delete this.style[name];
        });
        String(value || "").split(";").forEach((part) => {
            const separator = part.indexOf(":");
            if (separator > 0) this.style[part.slice(0, separator).trim()] = part.slice(separator + 1).trim();
        });
    }

    setAttribute(name, value) {
        const key = String(name);
        const stringValue = String(value);
        this._attributes.set(key, stringValue);
        if (key === "style") this._syncStyleObject(stringValue);
    }

    getAttribute(name) { return this._attributes.has(String(name)) ? this._attributes.get(String(name)) : null; }
    removeAttribute(name) {
        const key = String(name);
        this._attributes.delete(key);
        if (key === "style") this._syncStyleObject("");
    }

    appendChild(node) {
        if (node.parentNode) node.parentNode.removeChild(node);
        this.childNodes.push(node);
        node.parentNode = this;
        node.parentElement = this;
        return node;
    }

    insertBefore(node, anchor) {
        if (!anchor || !this.childNodes.includes(anchor)) return this.appendChild(node);
        if (node.parentNode) node.parentNode.removeChild(node);
        this.childNodes.splice(this.childNodes.indexOf(anchor), 0, node);
        node.parentNode = this;
        node.parentElement = this;
        return node;
    }

    removeChild(node) {
        const index = this.childNodes.indexOf(node);
        if (index >= 0) this.childNodes.splice(index, 1);
        node.parentNode = null;
        node.parentElement = null;
        return node;
    }

    remove() { this.parentNode?.removeChild(this); }

    addEventListener(type, listener) { const values = this.listeners.get(type) || []; values.push(listener); this.listeners.set(type, values); }
    removeEventListener(type, listener) { this.listeners.set(type, (this.listeners.get(type) || []).filter((candidate) => candidate !== listener)); }
    dispatchEvent(event = {}) { (this.listeners.get(event.type) || []).slice().forEach((listener) => listener({ ...event, target: event.target || this })); return true; }
    focus() { this.focused = true; }
    contains(node) { let current = node; while (current) { if (current === this) return true; current = current.parentNode; } return false; }

    _matches(selector) {
        const trimmed = selector.trim();
        if (!trimmed) return false;
        if (trimmed.includes(",")) return trimmed.split(",").some((part) => this._matches(part));
        if (trimmed === "#nav-tray-portal .navigation-tray-container.courses-tray") {
            return this.parentNode?.id === "nav-tray-portal"
                && this.classList.contains("navigation-tray-container")
                && this.classList.contains("courses-tray");
        }
        if (trimmed === "body.with-left-side.course-menu-expanded #left-side.ic-app-course-menu") {
            const body = this.parentNode?.parentNode;
            return this.id === "left-side"
                && this.classList.contains("ic-app-course-menu")
                && body?.tagName === "BODY"
                && body.classList.contains("with-left-side")
                && body.classList.contains("course-menu-expanded");
        }
        const id = trimmed.match(/#([A-Za-z0-9_-]+)/)?.[1];
        if (id && this.id !== id) return false;
        const classNames = Array.from(trimmed.matchAll(/\.([A-Za-z0-9_-]+)/g), (match) => match[1]);
        if (classNames.some((name) => !this.classList.contains(name))) return false;
        const tag = trimmed.match(/^([A-Za-z][A-Za-z0-9-]*)/)?.[1];
        return !tag || this.tagName === tag.toUpperCase();
    }

    querySelector(selector) {
        for (const child of this.childNodes) {
            if (child._matches?.(selector)) return child;
            const nested = child.querySelector?.(selector);
            if (nested) return nested;
        }
        return null;
    }
}

class FakeDocument {
    constructor() {
        this.documentElement = new FakeNode("html");
        this.head = new FakeNode("head");
        this.body = new FakeNode("body");
        this.documentElement.appendChild(this.head);
        this.documentElement.appendChild(this.body);
        this.listeners = new Map();
    }

    createElement(tagName) { return new FakeNode(tagName); }
    createElementNS(namespaceURI, tagName) { return new FakeNode(tagName, {}, namespaceURI); }
    getElementById(id) { return this.documentElement.querySelector(`#${id}`); }
    querySelector(selector) { return this.documentElement.querySelector(selector); }
    addEventListener(type, listener) { const values = this.listeners.get(type) || []; values.push(listener); this.listeners.set(type, values); }
    removeEventListener(type, listener) { this.listeners.set(type, (this.listeners.get(type) || []).filter((candidate) => candidate !== listener)); }
    dispatchEvent(event = {}) { (this.listeners.get(event.type) || []).slice().forEach((listener) => listener({ ...event, target: event.target || this })); return true; }
}

function makeSidebarDocument() {
    const document = new FakeDocument();
    const root = new FakeNode("nav", { id: "global_nav", class: "native-root", style: "width:99px;" });
    const logo = new FakeNode("div", { id: "global_nav_logo", class: "native-logo", title: "Native logo" });
    const list = new FakeNode("ul", { class: "native-list" });
    root.appendChild(logo);
    root.appendChild(list);
    const items = {};
    const order = ["dashboard", "calendar", "unknown", "courses", "help", "inbox", "history"];
    order.forEach((key) => {
        if (key === "unknown") {
            list.appendChild(new FakeNode("li", { id: "native-unknown", class: "unknown" }));
            return;
        }
        const id = key === "inbox" ? "global_nav_conversations_link" : `global_nav_${key}_link`;
        const item = new FakeNode("li", { class: `native-item ${key}` });
        const link = new FakeNode("a", { id, href: `/${key}`, title: key === "dashboard" ? "Native dashboard" : "" });
        item.appendChild(link);
        list.appendChild(item);
        items[key] = link;
    });
    document.documentElement.appendChild(root);
    return { document, root, logo, list, items };
}

function attrs(node) { return node.attributes.map(({ name, value }) => [name, value]); }
function listIds(list) { return list.children.map((child) => child.id || child.querySelector?.("a")?.id || ""); }
function allNodes(node, predicate = () => true, result = []) { if (!node) return result; if (predicate(node)) result.push(node); node.childNodes?.forEach((child) => allNodes(child, predicate, result)); return result; }
function byClass(node, name) { return allNodes(node, (candidate) => candidate.classList?.contains(name)); }

function parseCssRules(source, media = "screen", output = []) {
    const css = String(source).replace(/\/\*[\s\S]*?\*\//g, "");
    let cursor = 0;
    while (cursor < css.length) {
        const open = css.indexOf("{", cursor);
        if (open < 0) break;
        const prelude = css.slice(cursor, open).trim();
        let depth = 1;
        let close = open + 1;
        while (close < css.length && depth > 0) {
            if (css[close] === "{") depth += 1;
            else if (css[close] === "}") depth -= 1;
            close += 1;
        }
        const body = css.slice(open + 1, close - 1);
        if (prelude.startsWith("@media")) {
            const condition = prelude.slice(6).trim();
            parseCssRules(body, condition, output);
        } else if (prelude && !prelude.startsWith("@")) {
            const declarations = {};
            body.split(";").forEach((entry) => {
                const colon = entry.indexOf(":");
                if (colon < 1) return;
                const property = entry.slice(0, colon).trim();
                const raw = entry.slice(colon + 1).trim();
                declarations[property] = { value: raw.replace(/\s*!important\s*$/, "").trim(), important: /!important\s*$/.test(raw) };
            });
            output.push({ selectors: prelude.split(",").map((selector) => selector.trim()), declarations, media });
        }
        cursor = close;
    }
    return output;
}

function selectorSpecificity(selector) {
    const ids = (selector.match(/#[\w-]+/g) || []).length;
    const classes = (selector.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g) || []).length;
    const elements = (selector.replace(/:[\w-]+(?:\([^)]*\))?/g, "").match(/(?:^|[\s>+~])(?:html|a|button|li|ul|ol)(?=[\s.#[:>+~]|$)/g) || []).length;
    return ids * 100 + classes * 10 + elements;
}

function evaluateCourseTrayCss(css, scenario) {
    const rules = parseCssRules(css);
    const applied = {};
    const target = scenario.target || "tray";
    function mediaMatches(media) {
        if (media === "screen") return true;
        if (media.includes("print")) return scenario.print === true;
        if (media.includes("screen") && scenario.print === true) return false;
        const minWidth = media.match(/min-width:\s*(\d+)px/);
        if (minWidth && scenario.viewport < Number(minWidth[1])) return false;
        const maxWidth = media.match(/max-width:\s*(\d+)px/);
        if (maxWidth && scenario.viewport > Number(maxWidth[1])) return false;
        return Boolean(minWidth || maxWidth);
    }
    function selectorMatches(selector) {
        if (selector.includes('html[data-apstudycanvas-sidebar-mounted="1"]') && !scenario.mounted) return false;
        if (selector.includes(":has(")) {
            if (scenario.overlay) return false;
            if (!selector.includes(`.apstudycanvas-sidebar-${scenario.state}`)) return false;
        }
        if (target === "generic-dialog") {
            if (!selector.includes("#nav-tray-portal")) return false;
            const html = new FakeNode("html", scenario.mounted ? { "data-apstudycanvas-sidebar-mounted": "1" } : {});
            const body = new FakeNode("body");
            const portal = new FakeNode("div", { id: "nav-tray-portal" });
            const fixture = new FakeNode("div", { class: "generic-dialog popover", role: "dialog" });
            html.appendChild(body); body.appendChild(portal); portal.appendChild(fixture);
            const compounds = selector.trim().split(/\s+|>/).filter(Boolean);
            let candidate = fixture;
            return compounds.reverse().every((raw, index) => {
                const compound = raw.replace(/:has\(.*$/, "");
                const matches = (node) => {
                    if (!node) return false;
                    const id = compound.match(/#([\w-]+)/)?.[1];
                    if (id && node.id !== id) return false;
                    const tag = compound.match(/^([A-Za-z][\w-]*)/)?.[1];
                    if (tag && node.tagName !== tag.toUpperCase()) return false;
                    const classes = Array.from(compound.matchAll(/\.([\w-]+)/g), (match) => match[1]);
                    if (classes.some((name) => !node.classList.contains(name))) return false;
                    const attributes = Array.from(compound.matchAll(/\[([\w-]+)(?:=["']?([^"'\]]+))?\]/g));
                    return attributes.every(([, name, value]) => node.getAttribute(name) !== null && (value === undefined || node.getAttribute(name) === value));
                };
                if (index === 0) return matches(candidate);
                do { candidate = candidate?.parentNode; } while (candidate && !matches(candidate));
                return Boolean(candidate);
            });
        }
        if (target === "course-columns") return selector.includes("body.with-left-side.course-menu-expanded .ic-Layout-columns");
        if (target === "course-menu") return selector.includes("body.with-left-side.course-menu-expanded #left-side.ic-app-course-menu");
        // The tray panel is the inner of two spans under the portal — the fixed
        // inst-ui Tray element; the tray containers inside it only carry
        // content-fitting rules.
        if (target === "tray") return /#nav-tray-portal\s*>\s*span\s*>\s*span$/.test(selector.trim());
        if (!selector.includes("#nav-tray-portal .navigation-tray-container.courses-tray")) return false;
        const suffix = selector.slice(selector.indexOf(".navigation-tray-container.courses-tray") + ".navigation-tray-container.courses-tray".length).trim();
        if (target === "direct-child") return suffix === "> *";
        if (target === "content") return /\.(?:tray-with-space-for-global-nav|tray-content)$/.test(suffix);
        if (target === "link") return /(?:a|button|li|\[role="menuitem"\])$/.test(suffix);
        return false;
    }
    rules.forEach((rule, order) => {
        if (!mediaMatches(rule.media)) return;
        rule.selectors.forEach((selector) => {
            if (!selectorMatches(selector)) return;
            const specificity = selectorSpecificity(selector);
            Object.entries(rule.declarations).forEach(([property, declaration]) => {
                const previous = applied[property];
                const priority = (declaration.important ? 100000 : 0) + specificity;
                if (!previous || priority > previous.priority || (priority === previous.priority && order >= previous.order)) {
                    applied[property] = { ...declaration, priority, order };
                }
            });
        });
    });
    const values = Object.fromEntries(Object.entries(applied).map(([property, declaration]) => [property, declaration.value]));
    const width = Number(scenario.width || 0);
    const viewport = Number(scenario.viewport || 1200);
    if (values["inset-inline-start"] === "var(--apstudy-sidebar-width)") values["inset-inline-start"] = `${width}px`;
    if (values["left"] === "var(--apstudy-sidebar-width)") values["left"] = `${width}px`;
    if (values["max-inline-size"] === "100vw") values["max-inline-size"] = `${viewport}px`;
    if (values["max-inline-size"] === "max(0px, calc(100vw - var(--apstudy-sidebar-width)))") values["max-inline-size"] = `${Math.max(0, viewport - width)}px`;
    ["padding-inline-start", "inline-size", "max-inline-size"].forEach((property) => {
        if (values[property] === "var(--apstudy-canvas-course-menu-width)") values[property] = "192px";
    });
    if (values["z-index"] === "calc(var(--apstudy-nav-layer-z, 100) + 2)") values["z-index"] = "102";
    if (values["z-index"] === "calc(var(--apstudy-nav-layer-z, 100) + 3)") values["z-index"] = "103";
    return values;
}

test("sidebar applies safe settings without mutating the hidden native rail's items", () => {
    const { document, root, logo, list, items } = makeSidebarDocument();
    const window = { location: { pathname: "/courses/42" } };
    const controller = sidebar.createSidebarController({ document, window, root });
    controller.init({
        sidebar_enabled: true,
        sidebar_expanded_width: 320,
        sidebar_collapsed_width: 64,
        sidebar_density: "compact",
        sidebar_icon_size: 22,
        sidebar_label_size: 15,
        sidebar_logo_visible: false,
        sidebar_page_order: ["courses", "courses", "not-a-page", "dashboard"],
        sidebar_page_visibility: { dashboard: false },
        course_sidebar_expanded: false,
        sidebar_tooltips: true,
        sidebar_accessibility_labels: true
    });

    assert.equal(root.getAttribute(sidebar.MARKER), "1");
    assert.equal(root.classList.contains(sidebar.NAMESPACE), true);
    assert.equal(root.classList.contains(`${sidebar.NAMESPACE}-hidden`), true);
    assert.equal(root.getAttribute("hidden"), null);
    assert.equal(root.getAttribute("aria-hidden"), null);
    assert.equal(root.getAttribute("data-apstudycanvas-sidebar-mode"), null);
    assert.equal(root.style["--apstudycanvas-sidebar-expanded-width"], undefined);
    assert.equal(root.style["--apstudycanvas-sidebar-collapsed-width"], undefined);
    assert.equal(logo.classList.contains(`${sidebar.NAMESPACE}-logo-hidden`), false);
    assert.equal(items.dashboard.parentNode.getAttribute("hidden"), null);
    assert.equal(items.dashboard.parentNode.getAttribute("aria-hidden"), null);
    assert.equal(items.dashboard.getAttribute("title"), "Native dashboard");
    assert.equal(items.dashboard.getAttribute("aria-label"), null);
    assert.deepEqual(listIds(list), ["global_nav_dashboard_link", "global_nav_calendar_link", "native-unknown", "global_nav_courses_link", "global_nav_help_link", "global_nav_conversations_link", "global_nav_history_link"]);
    assert.deepEqual(sidebar.normalizeOrder(["courses", "courses", "unknown", "dashboard"]), ["courses", "dashboard", "calendar", "inbox", "history", "help", "apstudy:planner", "apstudy:notes", "apstudy:grades", "apstudy:study"]);
});

test("APStudy Page actions are egg-icon buttons while Canvas pages remain native links", async () => {
    const { document, root } = makeSidebarDocument();
    const adapter = {
        async assemble() {
            return {
                identity: {}, route: { pathname: "/", kind: "dashboard", pageId: "dashboard" },
                pages: [
                    { id: "dashboard", label: "Dashboard", href: "/", source: "canvas", iconRole: "dashboard", available: true },
                    { id: "apstudy:planner", label: "Planner", href: "/planner", source: "apstudycanvas", action: "planner", iconRole: "planner", available: true },
                    { id: "apstudy:notes", label: "Notes", source: "apstudycanvas", action: "notes", iconRole: "notes", available: true },
                    { id: "apstudy:grades", label: "Grades", href: "/grades", source: "apstudycanvas", action: "grades", iconRole: "grades", available: true },
                    { id: "apstudy:study", label: "Study", source: "apstudycanvas", action: "study", iconRole: "study", available: true }
                ],
                pageOrder: ["dashboard", "apstudy:planner", "apstudy:notes", "apstudy:grades", "apstudy:study"], pageVisibility: {}, courses: []
            };
        }
    };
    const events = [];
    document.addEventListener("apstudycanvas:sidebar-page-action", (event) => events.push(event.detail));
    const controller = sidebar.createSidebarController({ document, root, adapter, window: { innerWidth: 1200, location: { href: "https://canvas.emory.edu/", origin: "https://canvas.emory.edu", pathname: "/" } } });
    controller.init({ better_sidebar: true });
    await controller.refresh();

    const custom = document.getElementById(sidebar.ROOT_ID);
    const dashboard = allNodes(custom, (node) => node.getAttribute?.("data-page-id") === "dashboard")[0];
    assert.equal(dashboard.tagName, "A");
    const actions = allNodes(custom, (node) => node.getAttribute?.("data-page-action"));
    assert.deepEqual(actions.map((node) => node.getAttribute("data-page-action")), ["planner", "notes", "grades", "study"]);
    actions.forEach((node, index) => {
        assert.equal(node.tagName, "BUTTON");
        assert.equal(node.getAttribute("type"), "button");
        assert.equal(node.getAttribute("aria-current"), null);
        const icons = allNodes(node, (child) => child.tagName === "SVG");
        assert.equal(icons[0].getAttribute("data-apstudycanvas-icon"), ["planner", "notes", "grades", "study"][index]);
        assert.equal(icons[1].getAttribute("data-apstudycanvas-icon"), "apstudy-egg");
        assert.equal(icons[1].parentNode.getAttribute("class"), `${sidebar.NAMESPACE}-page-brand`);
    });
    actions[1].dispatchEvent({ type: "click" });
    assert.deepEqual(events, [{ action: "notes", pageId: "apstudy:notes", label: "Notes" }]);

    const css = fs.readFileSync(path.join(__dirname, "../../css/sidebar.css"), "utf8");
    assert.match(css, /#apstudycanvas-sidebar-root \.apstudycanvas-sidebar-page-row,[\s\S]*appearance:\s*none;[\s\S]*color:\s*var\(--apstudy-sidebar-text\)\s*!important;[\s\S]*background:\s*transparent;[\s\S]*font:\s*inherit;/);
    assert.match(css, /\.apstudycanvas-sidebar-page-brand\s*\{[\s\S]*margin-inline-start:\s*auto;[\s\S]*color:\s*var\(--apstudy-sidebar-muted-text\)/);
});

test("sidebar chrome shares the native global-nav stacking layer", () => {
    const css = fs.readFileSync(path.join(__dirname, "../../css/sidebar.css"), "utf8");
    assert.match(css, /--apstudy-nav-layer-z:\s*100/);
    assert.match(css, /#apstudycanvas-sidebar-root \{[\s\S]*?z-index:\s*var\(--apstudy-nav-layer-z, 100\)/);
    assert.match(css, /\.apstudycanvas-sidebar-recovery \{[\s\S]*?z-index:\s*calc\(var\(--apstudy-nav-layer-z, 100\) \+ 1\)/);
    assert.doesNotMatch(css, /z-index:\s*1000[012]\b/, "sidebar chrome must not hard-code a layer above page overlays");

    const { document, root } = makeSidebarDocument();
    const controller = sidebar.createSidebarController({
        document,
        root,
        window: { location: { pathname: "/courses/42" }, getComputedStyle: () => ({ zIndex: "250" }) }
    });
    controller.init({ better_sidebar: true });
    assert.equal(document.documentElement.style["--apstudy-nav-layer-z"], "250", "the rail mirrors the native nav's computed layer");
    controller.dispose();

    const auto = makeSidebarDocument();
    const fallback = sidebar.createSidebarController({
        document: auto.document,
        root: auto.root,
        window: { location: { pathname: "/courses/42" }, getComputedStyle: () => ({ zIndex: "auto" }) }
    });
    fallback.init({ better_sidebar: true });
    assert.equal(auto.document.documentElement.style["--apstudy-nav-layer-z"], undefined, "a non-numeric native layer leaves the CSS fallback in place");
    fallback.dispose();
});

test("sidebar heartbeat preserves watchdog evidence while paused and clears only after successful restoration", () => {
    const { document, root } = makeSidebarDocument();
    const timers = new Map();
    let nextTimer = 1;
    const window = {
        crypto: { randomUUID: () => "sidebar-session-test" },
        location: { href: "https://canvas.emory.edu/", origin: "https://canvas.emory.edu", pathname: "/" },
        setInterval(callback) { const id = nextTimer++; timers.set(id, callback); return id; },
        clearInterval(id) { timers.delete(id); }
    };
    const controller = sidebar.createSidebarController({ document, window, root });
    controller.init({ better_sidebar: true });
    assert.equal(timers.size, 1);
    assert.equal(document.documentElement.getAttribute("data-apstudycanvas-sidebar-active"), "1");
    assert.equal(document.documentElement.getAttribute("data-apstudycanvas-sidebar-session"), "sidebar-session-test");
    assert.match(document.documentElement.getAttribute("data-apstudycanvas-sidebar-heartbeat"), /^\d+$/);

    controller.pause();
    assert.equal(timers.size, 0);
    assert.equal(document.documentElement.getAttribute("data-apstudycanvas-sidebar-active"), "1");
    assert.equal(document.documentElement.getAttribute("data-apstudycanvas-sidebar-session"), "sidebar-session-test");
    assert.match(document.documentElement.getAttribute("data-apstudycanvas-sidebar-heartbeat"), /^\d+$/);
    assert.equal(root.classList.contains(`${sidebar.NAMESPACE}-hidden`), true);
    controller.resume({ better_sidebar: true });
    assert.equal(timers.size, 1);
    assert.equal(document.documentElement.getAttribute("data-apstudycanvas-sidebar-session"), "sidebar-session-test");

    const teardownOrder = [];
    const originalToggle = root.classList.toggle;
    root.classList.toggle = (name, force) => {
        if (name === `${sidebar.NAMESPACE}-hidden` && force === false) teardownOrder.push("restore-native");
        return originalToggle(name, force);
    };
    const originalRemoveAttribute = document.documentElement.removeAttribute.bind(document.documentElement);
    document.documentElement.removeAttribute = (name) => {
        if (["data-apstudycanvas-sidebar-session", "data-apstudycanvas-sidebar-heartbeat"].includes(name)) teardownOrder.push(`clear-${name}`);
        originalRemoveAttribute(name);
    };
    const originalClearInterval = window.clearInterval;
    window.clearInterval = (id) => { teardownOrder.push("clear-timer"); originalClearInterval(id); };
    controller.reset();
    assert.equal(timers.size, 0);
    assert.equal(document.documentElement.getAttribute("data-apstudycanvas-sidebar-active"), null);
    assert.equal(document.documentElement.getAttribute("data-apstudycanvas-sidebar-heartbeat"), null);
    assert.ok(teardownOrder.indexOf("restore-native") < teardownOrder.indexOf("clear-timer"));
    assert.ok(teardownOrder.indexOf("restore-native") < teardownOrder.indexOf("clear-data-apstudycanvas-sidebar-session"));
    assert.ok(teardownOrder.indexOf("restore-native") < teardownOrder.indexOf("clear-data-apstudycanvas-sidebar-heartbeat"));
    controller.dispose();
    assert.equal(timers.size, 0);
});

test("resume remounts exactly one rail after paused watchdog cleanup without leaking timers", () => {
    const { document, root } = makeSidebarDocument();
    const timers = new Map();
    let nextTimer = 1;
    let now = 1000;
    const window = {
        crypto: { randomUUID: () => "sidebar-session-pause-recovery" },
        location: { href: "https://canvas.emory.edu/", origin: "https://canvas.emory.edu", pathname: "/" },
        setInterval(callback, delay) { const id = nextTimer++; timers.set(id, { callback, delay }); return id; },
        clearInterval(id) { timers.delete(id); }
    };
    const controller = sidebar.createSidebarController({ document, window, root });
    controller.init({ better_sidebar: true });
    const initialRail = document.getElementById(sidebar.ROOT_ID);
    controller.pause();
    assert.equal(timers.size, 0);
    now = Number(document.documentElement.getAttribute("data-apstudycanvas-sidebar-heartbeat"));

    const watchdog = sidebarWatchdog.createSidebarWatchdog({ window, document, now: () => now, staleMs: 10000, visibleGraceMs: 0 });
    watchdog.start();
    now += 10001;
    Array.from(timers.values())[0].callback();
    assert.equal(watchdog.cleanupCount(), 1);
    assert.equal(initialRail.parentNode, null);
    assert.equal(root.classList.contains(`${sidebar.NAMESPACE}-hidden`), false);

    controller.resume({ better_sidebar: true });
    const connectedRails = allNodes(document.documentElement, (node) => node.id === sidebar.ROOT_ID);
    assert.equal(connectedRails.length, 1);
    assert.notEqual(connectedRails[0], initialRail);
    assert.equal(connectedRails[0].getAttribute(sidebar.MARKER), "1");
    assert.equal(root.classList.contains(`${sidebar.NAMESPACE}-hidden`), true);
    assert.equal(document.documentElement.getAttribute("data-apstudycanvas-sidebar-active"), "1");
    assert.equal(document.documentElement.getAttribute("data-apstudycanvas-sidebar-session"), "sidebar-session-pause-recovery");
    assert.equal(timers.size, 2, "one watchdog timer and one restarted heartbeat");

    watchdog.stop();
    assert.equal(timers.size, 1, "only the restarted heartbeat remains");
    controller.dispose();
    assert.equal(timers.size, 0);
});

test("failed direct restoration stops updates but preserves stale evidence for watchdog fallback", () => {
    const { document, root } = makeSidebarDocument();
    const timers = new Map();
    let nextTimer = 1;
    const window = {
        crypto: { randomUUID: () => "sidebar-session-restore-failure" },
        location: { href: "https://canvas.emory.edu/", origin: "https://canvas.emory.edu", pathname: "/" },
        setInterval(callback) { const id = nextTimer++; timers.set(id, callback); return id; },
        clearInterval(id) { timers.delete(id); }
    };
    const controller = sidebar.createSidebarController({ document, window, root });
    controller.init({ better_sidebar: true });
    const originalToggle = root.classList.toggle;
    let failOnce = true;
    root.classList.toggle = (name, force) => {
        if (failOnce && name === `${sidebar.NAMESPACE}-hidden` && force === false) {
            failOnce = false;
            throw new Error("native restoration failed");
        }
        return originalToggle(name, force);
    };

    assert.equal(controller.reset(), false);
    assert.equal(timers.size, 0, "failed teardown stops heartbeat updates so evidence can become stale");
    assert.equal(document.documentElement.getAttribute("data-apstudycanvas-sidebar-active"), "1");
    assert.equal(document.documentElement.getAttribute("data-apstudycanvas-sidebar-session"), "sidebar-session-restore-failure");
    const lastBeat = Number(document.documentElement.getAttribute("data-apstudycanvas-sidebar-heartbeat"));
    assert.ok(Number.isFinite(lastBeat));

    let watchdogNow = lastBeat;
    const service = sidebarWatchdog.createSidebarWatchdog({ window, document, now: () => watchdogNow, staleMs: 10000, visibleGraceMs: 0 });
    service.start();
    watchdogNow += 10001;
    Array.from(timers.values())[0]();
    assert.equal(service.cleanupCount(), 1);
    assert.equal(root.classList.contains(`${sidebar.NAMESPACE}-hidden`), false);
    assert.equal(document.documentElement.getAttribute("data-apstudycanvas-sidebar-session"), null);
    service.stop();
    controller.dispose();
});

test("runtime invalidation on a heartbeat tick restores directly or leaves stale evidence for watchdog recovery", () => {
    [false, true].forEach((forceRestoreFailure) => {
        const { document, root } = makeSidebarDocument();
        const timers = new Map();
        let nextTimer = 1;
        let clock = 1000;
        let runtimeValid = true;
        const window = {
            crypto: { randomUUID: () => `sidebar-session-runtime-${forceRestoreFailure ? "fallback" : "direct"}` },
            location: { href: "https://canvas.emory.edu/", origin: "https://canvas.emory.edu", pathname: "/" },
            setInterval(callback, delay) { const id = nextTimer++; timers.set(id, { callback, delay }); return id; },
            clearInterval(id) { timers.delete(id); }
        };
        const chromeApi = {
            runtime: {
                id: "apstudycanvas-test",
                getManifest() {
                    if (!runtimeValid) throw new Error("Extension context invalidated.");
                    return { manifest_version: 3 };
                }
            }
        };
        const controller = sidebar.createSidebarController({ document, window, root, chromeApi, now: () => clock });
        controller.init({ better_sidebar: true });
        const customRoot = document.getElementById(sidebar.ROOT_ID);
        const heartbeatTimer = Array.from(timers.values()).find((entry) => entry.delay === 2000);
        assert.ok(heartbeatTimer);
        assert.equal(document.documentElement.getAttribute("data-apstudycanvas-sidebar-heartbeat"), "1000");

        if (forceRestoreFailure) {
            const originalToggle = root.classList.toggle;
            let failOnce = true;
            root.classList.toggle = (name, force) => {
                if (failOnce && name === `${sidebar.NAMESPACE}-hidden` && force === false) {
                    failOnce = false;
                    throw new Error("forced direct restoration failure");
                }
                return originalToggle(name, force);
            };
        }

        runtimeValid = false;
        clock += 2000;
        heartbeatTimer.callback();

        if (!forceRestoreFailure) {
            assert.equal(customRoot.parentNode, null);
            assert.equal(root.classList.contains(`${sidebar.NAMESPACE}-hidden`), false);
            assert.equal(document.documentElement.getAttribute("data-apstudycanvas-sidebar-session"), null);
            assert.equal(document.documentElement.getAttribute("data-apstudycanvas-sidebar-heartbeat"), null);
            assert.equal(timers.size, 0);
        } else {
            assert.equal(customRoot.parentNode, document.documentElement);
            assert.equal(document.documentElement.getAttribute("data-apstudycanvas-sidebar-active"), "1");
            assert.equal(document.documentElement.getAttribute("data-apstudycanvas-sidebar-heartbeat"), "1000", "invalid context never republishes the heartbeat");
            assert.equal(timers.size, 0, "failed direct restoration disposes the invalid isolated-world publisher");

            const service = sidebarWatchdog.createSidebarWatchdog({ window, document, now: () => clock, staleMs: 10000, visibleGraceMs: 0 });
            service.start();
            assert.equal(timers.size, 1, "the MAIN-world watchdog owns the only remaining timer");
            clock = 11001;
            Array.from(timers.values()).find((entry) => entry.delay === sidebarWatchdog.TIMER_INTERVAL_MS).callback();
            assert.equal(service.cleanupCount(), 1);
            assert.equal(customRoot.parentNode, null);
            assert.equal(root.classList.contains(`${sidebar.NAMESPACE}-hidden`), false);
            assert.equal(document.documentElement.getAttribute("data-apstudycanvas-sidebar-session"), null);
            service.stop();
        }

        controller.dispose();
        assert.equal(timers.size, 0);
    });
});

test("unexpected sidebar root removal or replacement leaves a stale heartbeat for watchdog restoration", () => {
    ["removed", "replaced"].forEach((failureMode) => {
        const { document, root } = makeSidebarDocument();
        const wrapper = new FakeNode("main", { id: "wrapper", "data-canvas-state": "keep" });
        const portal = new FakeNode("div", { id: "nav-tray-portal" });
        const tray = new FakeNode("div", { class: "navigation-tray-container courses-tray", "data-canvas-tray-state": "keep" });
        portal.appendChild(tray);
        document.body.appendChild(wrapper);
        document.body.appendChild(portal);
        const timers = new Map();
        let nextTimer = 1;
        const window = {
            crypto: { randomUUID: () => `sidebar-session-${failureMode}` },
            location: { href: "https://canvas.emory.edu/", origin: "https://canvas.emory.edu", pathname: "/" },
            setInterval(callback) { const id = nextTimer++; timers.set(id, callback); return id; },
            clearInterval(id) { timers.delete(id); }
        };
        const controller = sidebar.createSidebarController({ document, window, root });
        controller.init({ better_sidebar: true, sidebar_expanded_width: 280 });
        const customRoot = document.getElementById(sidebar.ROOT_ID);
        customRoot.remove();
        let replacement = null;
        if (failureMode === "replaced") {
            replacement = new FakeNode("aside", { id: sidebar.ROOT_ID, "data-canvas-owned": "false" });
            document.body.appendChild(replacement);
        }

        const sidebarHeartbeat = Array.from(timers.values())[0];
        assert.equal(typeof sidebarHeartbeat, "function");
        sidebarHeartbeat();
        assert.equal(timers.size, 0, `${failureMode}: detached controller timer stops`);
        assert.equal(document.documentElement.getAttribute("data-apstudycanvas-sidebar-active"), "1");
        assert.equal(document.documentElement.getAttribute("data-apstudycanvas-sidebar-session"), `sidebar-session-${failureMode}`);
        const lastBeat = Number(document.documentElement.getAttribute("data-apstudycanvas-sidebar-heartbeat"));
        assert.ok(Number.isFinite(lastBeat));

        let watchdogNow = lastBeat;
        const service = sidebarWatchdog.createSidebarWatchdog({
            window,
            document,
            now: () => watchdogNow,
            staleMs: 10000,
            visibleGraceMs: 0
        });
        service.start();
        assert.equal(timers.size, 1, `${failureMode}: watchdog owns the only remaining interval`);
        watchdogNow += 10001;
        Array.from(timers.values())[0]();

        assert.equal(service.cleanupCount(), 1, `${failureMode}: stale evidence triggers cleanup`);
        assert.equal(root.classList.contains(`${sidebar.NAMESPACE}-hidden`), false);
        assert.equal(root.classList.contains(sidebar.NAMESPACE), false);
        assert.equal(root.getAttribute(sidebar.MARKER), null);
        assert.equal(wrapper.getAttribute(sidebar.MARKER), null);
        assert.equal(wrapper.getAttribute("data-canvas-state"), "keep");
        assert.equal(tray.getAttribute(sidebar.MARKER), null);
        assert.equal(tray.getAttribute("data-canvas-tray-state"), "keep");
        assert.equal(document.documentElement.style["--apstudy-sidebar-width"], undefined);
        assert.equal(document.documentElement.getAttribute("data-apstudycanvas-sidebar-session"), null);
        if (replacement) assert.equal(document.getElementById(sidebar.ROOT_ID), replacement, "an unowned replacement root survives cleanup");

        service.stop();
        controller.dispose();
        assert.equal(timers.size, 0, `${failureMode}: all intervals dispose`);
        assert.ok(Array.from(document.listeners.values()).every((listeners) => listeners.length === 0), `${failureMode}: document listeners dispose`);
    });
});

test("intentional sidebar disable restores directly and leaves no evidence for watchdog cleanup", () => {
    const { document, root } = makeSidebarDocument();
    const wrapper = new FakeNode("main", { id: "wrapper", "data-canvas-state": "keep" });
    document.body.appendChild(wrapper);
    const timers = new Map();
    let nextTimer = 1;
    const window = {
        crypto: { randomUUID: () => "sidebar-session-disable" },
        location: { href: "https://canvas.emory.edu/", origin: "https://canvas.emory.edu", pathname: "/" },
        setInterval(callback) { const id = nextTimer++; timers.set(id, callback); return id; },
        clearInterval(id) { timers.delete(id); }
    };
    const controller = sidebar.createSidebarController({ document, window, root });
    controller.init({ better_sidebar: true });
    controller.apply({ better_sidebar: false });
    assert.equal(timers.size, 0);
    assert.equal(document.documentElement.getAttribute("data-apstudycanvas-sidebar-session"), null);
    assert.equal(document.documentElement.getAttribute("data-apstudycanvas-sidebar-heartbeat"), null);
    assert.equal(root.classList.contains(`${sidebar.NAMESPACE}-hidden`), false);
    assert.equal(root.getAttribute(sidebar.MARKER), null);
    assert.equal(wrapper.getAttribute(sidebar.MARKER), null);
    assert.equal(wrapper.getAttribute("data-canvas-state"), "keep");

    let watchdogNow = Date.now() + 20000;
    const service = sidebarWatchdog.createSidebarWatchdog({ window, document, now: () => watchdogNow, staleMs: 10000, visibleGraceMs: 0 });
    service.start();
    watchdogNow += 20000;
    Array.from(timers.values())[0]();
    assert.equal(service.cleanupCount(), 0);
    service.stop();
    controller.dispose();
    assert.equal(timers.size, 0);
    assert.ok(Array.from(document.listeners.values()).every((listeners) => listeners.length === 0));
});

test("layout ownership keeps real course navigation separate from the global Courses flyout", () => {
    const { document, root } = makeSidebarDocument();
    const wrapper = new FakeNode("main", { id: "wrapper", "data-canvas-state": "keep" });
    document.body.classList.add("with-left-side", "course-menu-expanded");
    const columns = new FakeNode("div", { class: "ic-Layout-columns", "data-canvas-columns-state": "keep" });
    const leftSide = new FakeNode("nav", { id: "left-side", class: "ic-app-course-menu", "data-canvas-course-menu-state": "keep" });
    columns.appendChild(leftSide);
    document.body.appendChild(columns);
    document.body.appendChild(wrapper);
    const controller = sidebar.createSidebarController({ document, window: { location: { pathname: "/" } }, root });
    controller.init({ better_sidebar: true });
    assert.equal(document.documentElement.getAttribute(sidebar.MARKER), "1");
    assert.equal(wrapper.getAttribute(sidebar.MARKER), "1");
    assert.equal(columns.getAttribute(sidebar.MARKER), "1");
    assert.equal(leftSide.getAttribute(sidebar.MARKER), "1");

    const portal = new FakeNode("div", { id: "nav-tray-portal" });
    const tray = new FakeNode("div", { class: "navigation-tray-container courses-tray", "data-canvas-tray-state": "keep" });
    portal.appendChild(tray);
    document.body.appendChild(portal);
    document.dispatchEvent({ type: "click", target: root });
    assert.equal(tray.getAttribute(sidebar.MARKER), "1");

    controller.reset();
    assert.equal(document.documentElement.getAttribute(sidebar.MARKER), null);
    assert.equal(wrapper.getAttribute(sidebar.MARKER), null);
    assert.equal(wrapper.getAttribute("data-canvas-state"), "keep");
    assert.equal(tray.getAttribute(sidebar.MARKER), null);
    assert.equal(tray.getAttribute("data-canvas-tray-state"), "keep");
    assert.equal(columns.getAttribute(sidebar.MARKER), null);
    assert.equal(columns.getAttribute("data-canvas-columns-state"), "keep");
    assert.equal(leftSide.getAttribute(sidebar.MARKER), null);
    assert.equal(leftSide.getAttribute("data-canvas-course-menu-state"), "keep");
});

test("storage changes reapply live and reset restores touched native state without rewinding unrelated Canvas mutations", () => {
    const { document, root, logo, list, items } = makeSidebarDocument();
    document.documentElement.style.setProperty("--apstudy-sidebar-width", "13px");
    const initial = {
        root: attrs(root), logo: attrs(logo), list: listIds(list),
        items: Object.fromEntries(Object.entries(items).map(([key, node]) => [key, {
            node: attrs(node), item: attrs(node.parentNode)
        }]))
    };
    const listeners = [];
    const chromeApi = { storage: { onChanged: { addListener(listener) { listeners.push(listener); }, removeListener() {} } } };
    const controller = sidebar.createSidebarController({ document, window: { location: { pathname: "/" } }, root, chromeApi });
    controller.init({ better_sidebar: true, sidebar_logo_visible: false, dashboard_sidebar_expanded: false });
    listeners[0]({ sidebar_logo_visible: { newValue: true }, sidebar_page_visibility: { newValue: { dashboard: false } } }, "sync");
    assert.equal(logo.classList.contains(`${sidebar.NAMESPACE}-logo-hidden`), false);
    assert.equal(items.dashboard.parentNode.getAttribute("hidden"), null);
    const canvasExtra = new FakeNode("li", { id: "canvas-rerendered-extra", class: "canvas-live-item" });
    list.appendChild(canvasExtra);
    list.insertBefore(items.help.parentNode, items.courses.parentNode);
    const canvasOrderBeforeReset = listIds(list);
    root.setAttribute("data-canvas-rerendered", "true");
    root.classList.toggle("canvas-live-class", true);
    const dynamicPageNode = new FakeNode("section", { id: "canvas-live-region" });
    document.body.appendChild(dynamicPageNode);

    controller.reset();
    initial.root.filter(([name]) => name !== "class").forEach(([name, value]) => assert.equal(root.getAttribute(name), value, name));
    assert.equal(root.classList.contains("native-root"), true);
    assert.equal(root.getAttribute("data-canvas-rerendered"), "true");
    assert.equal(root.classList.contains("canvas-live-class"), true);
    assert.deepEqual(attrs(logo), initial.logo);
    assert.deepEqual(listIds(list), canvasOrderBeforeReset, "Canvas reordering and dynamic siblings are preserved");
    assert.equal(canvasExtra.parentNode, list);
    assert.equal(dynamicPageNode.parentNode, document.body);
    Object.entries(items).forEach(([key, node]) => {
        assert.deepEqual(attrs(node), initial.items[key].node, key);
        assert.deepEqual(attrs(node.parentNode), initial.items[key].item, key);
    });
    assert.equal(document.querySelector('link[rel="stylesheet"][data-apstudycanvas-sidebar]'), null);
    assert.equal(document.documentElement.style["--apstudy-sidebar-width"], "13px", "the touched document width returns to its captured value");
    assert.equal(root.getAttribute(sidebar.MARKER), null);

    controller.init({ better_sidebar: true });
    assert.equal(root.getAttribute(sidebar.MARKER), "1", "re-enable recaptures current native DOM");
    controller.dispose();
    assert.equal(root.getAttribute(sidebar.MARKER), null);
});

test("reset never resurrects native items that Canvas replaced or removed", () => {
    const replacedFixture = makeSidebarDocument();
    const replacedController = sidebar.createSidebarController({
        document: replacedFixture.document,
        window: { location: { pathname: "/" } },
        root: replacedFixture.root
    });
    replacedController.init({ better_sidebar: true, sidebar_page_visibility: { dashboard: false } });
    const staleDashboardItem = replacedFixture.items.dashboard.parentNode;
    const replacementItem = new FakeNode("li", { class: "native-item dashboard canvas-replacement", "data-canvas-state": "current" });
    const replacementLink = new FakeNode("a", {
        id: "global_nav_dashboard_link",
        href: "/dashboard-new",
        title: "Canvas replacement",
        "aria-label": "Current dashboard"
    });
    replacementItem.appendChild(replacementLink);
    replacedFixture.list.insertBefore(replacementItem, staleDashboardItem);
    replacedFixture.list.removeChild(staleDashboardItem);

    replacedController.reset();

    assert.equal(staleDashboardItem.parentNode, null, "the stale captured item stays detached");
    assert.equal(replacementItem.parentNode, replacedFixture.list, "the Canvas replacement stays mounted");
    assert.equal(replacementItem.getAttribute("data-canvas-state"), "current");
    assert.equal(replacementLink.getAttribute("title"), "Canvas replacement");
    assert.equal(replacementLink.getAttribute("aria-label"), "Current dashboard");
    assert.equal(replacedFixture.document.getElementById("global_nav_dashboard_link"), replacementLink);

    const removedFixture = makeSidebarDocument();
    const removedController = sidebar.createSidebarController({
        document: removedFixture.document,
        window: { location: { pathname: "/" } },
        root: removedFixture.root
    });
    removedController.init({ better_sidebar: true });
    const removedHelpItem = removedFixture.items.help.parentNode;
    removedFixture.list.removeChild(removedHelpItem);

    removedController.reset();

    assert.equal(removedHelpItem.parentNode, null, "a Canvas-removed item is not reinserted");
    assert.equal(removedFixture.document.getElementById("global_nav_help_link"), null);
});

test("disabled settings leave native navigation untouched and initialization failure restores it", () => {
    const disabledFixture = makeSidebarDocument();
    const disabledBefore = attrs(disabledFixture.root);
    const disabledController = sidebar.createSidebarController({ document: disabledFixture.document, root: disabledFixture.root });
    disabledController.init({ better_sidebar: false });
    assert.deepEqual(attrs(disabledFixture.root), disabledBefore);
    assert.equal(disabledFixture.document.getElementById(sidebar.ROOT_ID), null);

    const failedFixture = makeSidebarDocument();
    const failedBefore = attrs(failedFixture.root);
    failedFixture.document.createElement = () => { throw new Error("style mount failed"); };
    const failedController = sidebar.createSidebarController({ document: failedFixture.document, root: failedFixture.root });
    assert.equal(failedController.apply({ better_sidebar: true }), false);
    assert.deepEqual(attrs(failedFixture.root), failedBefore);
    assert.equal(failedFixture.root.getAttribute(sidebar.MARKER), null);
    assert.equal(failedFixture.document.getElementById(sidebar.ROOT_ID), null);
});

test("full adapter failure tears down the custom rail, restores native navigation, and cleans listeners", async () => {
    const { document, root } = makeSidebarDocument();
    const window = { location: { href: "https://canvas.emory.edu/", origin: "https://canvas.emory.edu", pathname: "/" } };
    const adapter = { async assemble() { throw new Error("Canvas model unavailable"); } };
    const controller = sidebar.createSidebarController({ document, window, root, adapter });
    controller.init({ better_sidebar: true });
    assert.ok(document.getElementById(sidebar.ROOT_ID));
    assert.equal(document.listeners.get("keydown")?.length, 1);
    await controller.refresh();
    assert.equal(document.getElementById(sidebar.ROOT_ID), null);
    assert.equal(document.querySelector('link[rel="stylesheet"][data-apstudycanvas-sidebar]'), null);
    assert.equal(root.getAttribute(sidebar.MARKER), null);
    assert.equal(document.listeners.get("keydown")?.length || 0, 0);
    assert.equal(document.listeners.get("click")?.length || 0, 0);

    adapter.assemble = async () => ({
        identity: {}, route: {}, pages: [], pageOrder: [], pageVisibility: {},
        courses: [], courseState: { status: "empty", retryable: false }
    });
    assert.equal(controller.apply({ better_sidebar: true }), true);
    await controller.refresh();
    assert.equal(document.getElementById(sidebar.ROOT_ID)?.parentNode, document.documentElement);
    assert.equal(byClass(document.getElementById(sidebar.ROOT_ID), `${sidebar.NAMESPACE}-section-toggle`).length, 2);
    assert.equal(document.listeners.get("keydown")?.length, 1, "recovery after failure has one global listener");

    adapter.assemble = async () => { throw new Error("route adaptation failed"); };
    await controller.refresh();
    assert.equal(document.getElementById(sidebar.ROOT_ID), null, "route refresh failure removes the stale custom rail");
    assert.equal(root.getAttribute(sidebar.MARKER), null, "route refresh failure restores native navigation");
    assert.equal(document.listeners.get("keydown")?.length || 0, 0, "route failure removes rail listeners");
});

test("course tab loads are aborted and ignored when closed, superseded, refreshed, or torn down", async () => {
    const makeRun = async () => {
        const { document, root } = makeSidebarDocument();
        const pending = [];
        const adapter = {
            async assemble() {
                return {
                    identity: { accountKey: "b".repeat(64), origin: "https://canvas.emory.edu", userId: "7" },
                    route: {}, pages: [], pageOrder: [], pageVisibility: {},
                    courses: [{ id: "7", name: "Biology", href: "/courses/7" }],
                    courseState: { status: "populated", retryable: false }
                };
            },
            getCourseNavigation({ signal }) {
                return new Promise((resolve, reject) => {
                    const entry = { signal, resolve, reject, aborted: false };
                    signal?.addEventListener?.("abort", () => { entry.aborted = true; }, { once: true });
                    pending.push(entry);
                });
            }
        };
        const controller = sidebar.createSidebarController({
            document, root, adapter,
            window: { innerWidth: 1200, location: { href: "https://canvas.emory.edu/", origin: "https://canvas.emory.edu", pathname: "/" } }
        });
        controller.init({ better_sidebar: true });
        await controller.refresh();
        const toggle = () => byClass(document.getElementById(sidebar.ROOT_ID), `${sidebar.NAMESPACE}-course-toggle`)[0];
        return { document, controller, pending, toggle };
    };

    const closed = await makeRun();
    closed.toggle().dispatchEvent({ type: "click" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closed.pending.length, 1);
    closed.toggle().dispatchEvent({ type: "click" });
    assert.equal(closed.pending[0].aborted, true);
    closed.pending[0].resolve({ tabs: [{ label: "Stale", href: "/courses/7/stale" }] });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(byClass(closed.document.getElementById(sidebar.ROOT_ID), `${sidebar.NAMESPACE}-course-tab`).length, 0);

    const superseded = await makeRun();
    superseded.toggle().dispatchEvent({ type: "click" });
    await new Promise((resolve) => setImmediate(resolve));
    superseded.toggle().dispatchEvent({ type: "click" });
    superseded.toggle().dispatchEvent({ type: "click" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(superseded.pending.length, 2);
    assert.equal(superseded.pending[0].aborted, true);
    superseded.pending[0].resolve({ tabs: [{ label: "Stale", href: "/courses/7/stale" }] });
    superseded.pending[1].resolve({ tabs: [{ label: "Current", href: "/courses/7/current" }] });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(byClass(superseded.document.getElementById(sidebar.ROOT_ID), `${sidebar.NAMESPACE}-course-tab`).map((node) => node.textContent), ["Current"]);

    const refreshed = await makeRun();
    refreshed.toggle().dispatchEvent({ type: "click" });
    await new Promise((resolve) => setImmediate(resolve));
    const refreshPromise = refreshed.controller.refresh();
    assert.equal(refreshed.pending[0].aborted, true);
    refreshed.pending[0].resolve({ tabs: [{ label: "Stale", href: "/courses/7/stale" }] });
    await refreshPromise;
    assert.equal(byClass(refreshed.document.getElementById(sidebar.ROOT_ID), `${sidebar.NAMESPACE}-course-tab`).length, 0);

    const tornDown = await makeRun();
    tornDown.toggle().dispatchEvent({ type: "click" });
    await new Promise((resolve) => setImmediate(resolve));
    tornDown.controller.dispose();
    assert.equal(tornDown.pending[0].aborted, true);
    tornDown.pending[0].resolve({ tabs: [{ label: "Late", href: "/courses/7/late" }] });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(tornDown.document.getElementById(sidebar.ROOT_ID), null);

    const detached = await makeRun();
    detached.toggle().dispatchEvent({ type: "click" });
    await new Promise((resolve) => setImmediate(resolve));
    const detachedRoot = detached.document.getElementById(sidebar.ROOT_ID);
    detachedRoot.remove();
    detached.pending[0].resolve({ tabs: [{ label: "Detached late result", href: "/courses/7/detached" }] });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(byClass(detachedRoot, `${sidebar.NAMESPACE}-course-tab`).length, 0, "late results cannot render into a detached root");

    const replaced = await makeRun();
    replaced.toggle().dispatchEvent({ type: "click" });
    await new Promise((resolve) => setImmediate(resolve));
    const replacedRoot = replaced.document.getElementById(sidebar.ROOT_ID);
    replacedRoot.remove();
    const currentRoot = new FakeNode("aside", { id: sidebar.ROOT_ID, "data-current-owner": "canvas" });
    replaced.document.documentElement.appendChild(currentRoot);
    replaced.pending[0].resolve({ tabs: [{ label: "Replaced late result", href: "/courses/7/replaced" }] });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(byClass(replacedRoot, `${sidebar.NAMESPACE}-course-tab`).length, 0, "late results cannot render into a replaced root");
    assert.equal(replaced.document.getElementById(sidebar.ROOT_ID), currentRoot);
    assert.equal(currentRoot.childNodes.length, 0, "the current foreign root is untouched");
});

test("duplicate controller creation returns the one document owner and the legacy feature path keeps one hook", () => {
    const { document, root } = makeSidebarDocument();
    const first = sidebar.createSidebarController({ document, root });
    const second = sidebar.createSidebarController({ document, root });
    assert.equal(second, first);
    first.init({ better_sidebar: true });
    second.init({ better_sidebar: true });
    assert.equal(root.getAttribute(sidebar.MARKER), "1");

    const source = fs.readFileSync(path.join(__dirname, "../../js/content.js"), "utf8");
    for (const hook of ["toggleDarkMode", "customizeCards", "setupBetterTodo", "setupGPACalc", "loadDashboardNotes", "loadCustomFont"]) assert.match(source, new RegExp(`\\b${hook}\\b`));
    assert.match(source, /contentSidebarApi\?\.createSidebarController/);
    assert.match(source, /#better-sidebar-container/);
    assert.match(source, /guarded\s+setup\s+calls\s+below\s+cannot\s+create\s+the\s+retired/);
    assert.match(source, /if \(contentSidebarApi\?\.createSidebarController\) \{\s*return;\s*\}/);
    const hydrateDashboardSource = source.slice(source.indexOf("function hydrateDashboard"), source.indexOf("function ensureOverlayHost"));
    assert.ok(hydrateDashboardSource.includes("#DashboardCard_Container"), "dashboard hydration keeps the container-scoped injector pass");
    assert.doesNotMatch(hydrateDashboardSource, /setupBetterSidebar\(/);
    assert.doesNotMatch(hydrateDashboardSource, /MutationObserver|setTimeout/, "the lifecycle owns observation and coalescing; hydration is a pure injector pass");
    assert.doesNotMatch(source, /\bdashboardReadyTimer\b|\binsertTimer\b|\bresetTimer\b|\bcheckDashboardReady\b/, "the legacy dashboard observer is fully retired");
    assert.match(source, /onDashboardHydrate: hydrateDashboard/, "dashboard hydration is wired into the lifecycle initialization");
    assert.doesNotMatch(source, /chrome\.storage\.onChanged\.addListener\(applyOptionsChanges\)/);
});

test("hidden recovery can be opened and dismissed repeatedly without losing the attached control", () => {
    const { document, root } = makeSidebarDocument();
    const window = { innerWidth: 500, location: { href: "https://canvas.emory.edu/", origin: "https://canvas.emory.edu", pathname: "/" } };
    const controller = sidebar.createSidebarController({ document, window, root });
    controller.init({ better_sidebar: true });
    for (let cycle = 0; cycle < 3; cycle += 1) {
        let recovery = document.getElementById(sidebar.RECOVERY_ID);
        assert.ok(recovery?.parentNode, `recovery attached on cycle ${cycle}`);
        assert.equal(recovery.getAttribute("aria-controls"), sidebar.ROOT_ID);
        assert.equal(recovery.getAttribute("aria-expanded"), "false");
        recovery.dispatchEvent({ type: "click" });
        assert.equal(controller.getState().recoveryOpen, true);
        document.dispatchEvent({ type: "keydown", key: "Escape" });
        recovery = document.getElementById(sidebar.RECOVERY_ID);
        assert.ok(recovery?.parentNode, `recovery recreated on cycle ${cycle}`);
        assert.equal(recovery.focused, true);
        assert.equal(controller.getState().recoveryOpen, false);
    }
});

test("rail-local state persists optimistically and rolls back with an announcement when sync storage fails", async () => {
    const { document, root } = makeSidebarDocument();
    const writes = [];
    let fail = false;
    const controller = sidebar.createSidebarController({
        document,
        window: { innerWidth: 1200, location: { href: "https://canvas.emory.edu/", origin: "https://canvas.emory.edu", pathname: "/" } },
        root,
        writeSettings(changes) { writes.push(changes); return fail ? Promise.reject(new Error("offline")) : Promise.resolve(); }
    });
    controller.init({ better_sidebar: true, sidebar_preferred_state: "expanded" });
    let sectionToggles = byClass(document.getElementById(sidebar.ROOT_ID), `${sidebar.NAMESPACE}-section-toggle`);
    sectionToggles[0].dispatchEvent({ type: "click" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(writes.at(-1), { sidebar_pages_folded: true });
    byClass(document.getElementById(sidebar.ROOT_ID), `${sidebar.NAMESPACE}-section-toggle`)[1].dispatchEvent({ type: "click" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(writes.at(-1), { sidebar_courses_folded: true });
    let toggle = byClass(document.getElementById(sidebar.ROOT_ID), `${sidebar.NAMESPACE}-collapse-toggle`)[0];
    toggle.dispatchEvent({ type: "click" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(controller.getState().preferredState, "collapsed");
    assert.deepEqual(writes.at(-1), { sidebar_preferred_state: "collapsed" });
    fail = true;
    toggle = byClass(document.getElementById(sidebar.ROOT_ID), `${sidebar.NAMESPACE}-collapse-toggle`)[0];
    toggle.dispatchEvent({ type: "click" });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(controller.getState().preferredState, "collapsed");
    const live = byClass(document.getElementById(sidebar.ROOT_ID), `${sidebar.NAMESPACE}-live`)[0];
    assert.match(live.textContent, /Could not save/);
});

test("the Courses heading gear opens the Control Center and the rail edge toggles state without joining the a11y tree", async () => {
    const { document, root } = makeSidebarDocument();
    const writes = [];
    const events = [];
    const adapter = { async assemble() { return { identity: {}, route: {}, pages: [{ id: "dashboard", label: "Dashboard", href: "/", available: true, iconRole: "dashboard" }], pageOrder: ["dashboard"], pageVisibility: {}, courses: [{ id: "7", name: "Biology", href: "/courses/7" }], courseState: { status: "populated", retryable: false } }; } };
    const controller = sidebar.createSidebarController({
        document,
        window: { innerWidth: 1200, location: { href: "https://canvas.emory.edu/", origin: "https://canvas.emory.edu", pathname: "/" } },
        root,
        adapter,
        writeSettings(changes) { writes.push(changes); return Promise.resolve(); }
    });
    controller.init({ better_sidebar: true });
    await controller.refresh();
    const custom = document.getElementById(sidebar.ROOT_ID);

    assert.equal(byClass(custom, `${sidebar.NAMESPACE}-section-gear`).length, 1, "only the Courses section carries a customization gear");
    const gear = byClass(custom, `${sidebar.NAMESPACE}-section-gear`)[0];
    assert.equal(gear.getAttribute("aria-label"), "Customize course order in Control Center");
    assert.ok(gear.getAttribute("title"));
    document.addEventListener("apstudycanvas:open-control-center", () => events.push("opened"));
    gear.dispatchEvent({ type: "click" });
    assert.deepEqual(events, ["opened"]);
    assert.equal(byClass(custom, `${sidebar.NAMESPACE}-section-head`).length, 2, "both section headings render inside a head wrapper");

    const edge = byClass(custom, `${sidebar.NAMESPACE}-edge`)[0];
    assert.ok(edge, "the rail edge carries the collapse affordance");
    assert.equal(edge.getAttribute("aria-hidden"), "true");
    assert.equal(edge.getAttribute("tabindex"), "-1");
    edge.dispatchEvent({ type: "click" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(controller.getState().preferredState, "collapsed");
    assert.deepEqual(writes.at(-1), { sidebar_preferred_state: "collapsed" });
    const collapsedEdge = byClass(document.getElementById(sidebar.ROOT_ID), `${sidebar.NAMESPACE}-edge`)[0];
    collapsedEdge.dispatchEvent({ type: "click" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(controller.getState().preferredState, "expanded");
    assert.deepEqual(writes.at(-1), { sidebar_preferred_state: "expanded" });
});

test("the identity header renders only the real profile picture and never a substitute icon", async () => {
    const run = async (settings, avatarUrl) => {
        const { document, root } = makeSidebarDocument();
        const adapter = { async assemble() { return { identity: { institutionName: "Emory", institutionMarkUrl: "https://canvas.emory.edu/dist/images/emory_logo.png", userName: "Derek Chen", userAvatarUrl: avatarUrl }, route: {}, pages: [], pageOrder: [], pageVisibility: {}, courses: [] }; } };
        const controller = sidebar.createSidebarController({ document, root, adapter, window: { innerWidth: 1200, location: { href: "https://canvas.emory.edu/", origin: "https://canvas.emory.edu", pathname: "/" } } });
        controller.init({ better_sidebar: true, ...settings });
        await controller.refresh();
        return document.getElementById(sidebar.ROOT_ID);
    };
    const withAvatar = await run({}, "https://canvas.emory.edu/files/user_avatar.png");
    const avatar = byClass(withAvatar, `${sidebar.NAMESPACE}-identity-avatar`)[0];
    assert.ok(avatar, "a real avatar renders the profile picture control");
    assert.equal(avatar.tagName, "BUTTON", "the profile picture is the account control");
    assert.equal(allNodes(avatar, (node) => node.tagName === "IMG").length, 1, "the control contains exactly the avatar image");
    assert.equal(allNodes(avatar, (node) => node.tagName === "svg").length, 0, "the control never renders a substitute icon");
    assert.equal(byClass(withAvatar, `${sidebar.NAMESPACE}-identity-mark`).length, 0, "the institution logo is no longer part of the header");
    assert.equal(byClass(withAvatar, `${sidebar.NAMESPACE}-identity-copy`).length, 0, "the product promo copy is gone");
    assert.match(avatar.getAttribute("aria-label"), /Derek Chen/);
    const missingAvatar = await run({}, null);
    const initials = byClass(missingAvatar, `${sidebar.NAMESPACE}-identity-avatar`)[0];
    assert.ok(initials, "a missing avatar still leaves the account control in place");
    assert.equal(allNodes(initials, (node) => node.tagName === "svg").length, 0, "the initials fallback never becomes an invented icon");
    assert.equal(byClass(initials, `${sidebar.NAMESPACE}-avatar-initial`)[0].textContent, "D");
});

test("clicking the profile picture opens the native Canvas account tray", async () => {
    const { document, root } = makeSidebarDocument();
    const profileLink = new FakeNode("a", { id: "global_nav_profile_link", href: "/profile" });
    const nativeClicks = [];
    profileLink.click = () => nativeClicks.push("native-account");
    root.appendChild(profileLink);
    const adapter = { async assemble() { return { identity: { userName: "Derek Chen", userAvatarUrl: "https://canvas.emory.edu/avatar.png" }, route: {}, pages: [], pageOrder: [], pageVisibility: {}, courses: [] }; } };
    const controller = sidebar.createSidebarController({ document, root, adapter, window: { innerWidth: 1200, location: { href: "https://canvas.emory.edu/", origin: "https://canvas.emory.edu", pathname: "/" } } });
    controller.init({ better_sidebar: true });
    await controller.refresh();
    const avatar = byClass(document.getElementById(sidebar.ROOT_ID), `${sidebar.NAMESPACE}-identity-avatar`)[0];
    assert.ok(avatar, "the profile picture control is mounted");
    avatar.dispatchEvent({ type: "click" });
    assert.deepEqual(nativeClicks, ["native-account"], "the avatar click triggers the hidden native Account button");
});

test("the profile picture falls back to the Canvas account page when the native nav is absent", async () => {
    const { document, root } = makeSidebarDocument();
    const assignments = [];
    const adapter = { async assemble() { return { identity: { userName: "Derek Chen" }, route: {}, pages: [], pageOrder: [], pageVisibility: {}, courses: [] }; } };
    const controller = sidebar.createSidebarController({ document, root, adapter, window: { innerWidth: 1200, location: { href: "https://canvas.emory.edu/", origin: "https://canvas.emory.edu", pathname: "/", assign: (url) => assignments.push(url) } } });
    controller.init({ better_sidebar: true });
    await controller.refresh();
    const avatar = byClass(document.getElementById(sidebar.ROOT_ID), `${sidebar.NAMESPACE}-identity-avatar`)[0];
    avatar.dispatchEvent({ type: "click" });
    assert.deepEqual(assignments, ["https://canvas.emory.edu/profile/settings"], "the fallback mirrors the native Account destination");
});

test("the profile picture size setting drives the rail avatar scale", async () => {
    const run = async (value) => {
        const { document, root } = makeSidebarDocument();
        const adapter = { async assemble() { return { identity: { userName: "Derek Chen", userAvatarUrl: "https://canvas.emory.edu/avatar.png" }, route: {}, pages: [], pageOrder: [], pageVisibility: {}, courses: [] }; } };
        const controller = sidebar.createSidebarController({ document, root, adapter, window: { innerWidth: 1200, location: { href: "https://canvas.emory.edu/", origin: "https://canvas.emory.edu", pathname: "/" } } });
        controller.init({ better_sidebar: true, ...(value ? { sidebar_avatar_size: value } : {}) });
        await controller.refresh();
        return document.getElementById(sidebar.ROOT_ID);
    };
    const sizeFor = async (value) => {
        const rootEl = await run(value);
        return byClass(rootEl, `${sidebar.NAMESPACE}-identity-avatar`)[0] ? rootEl.style["--apstudy-sidebar-avatar-size"] : null;
    };
    assert.equal(await sizeFor("small"), "32px");
    assert.equal(await sizeFor("medium"), "44px");
    assert.equal(await sizeFor("large"), "56px");
    assert.equal(await sizeFor(undefined), "44px", "missing values keep the medium default");
    assert.equal(await sizeFor("gigantic"), "44px", "unknown values keep the medium default");
});

test("Canvas mutation refreshes never schedule sidebar network refreshes", () => {
    const content = fs.readFileSync(path.join(__dirname, "../../js/content.js"), "utf8");
    const start = content.indexOf("function refreshContentSidebar");
    assert.ok(start >= 0);
    const source = content.slice(start, content.indexOf("\nfunction ", start + 10));
    const mutationBranch = source.slice(source.indexOf('reason === "mutation"'), source.indexOf('reason === "init"'));
    assert.ok(mutationBranch.length > 0);
    assert.match(mutationBranch, /needsRefresh\(options\)/);
    assert.doesNotMatch(mutationBranch, /\.refresh\?\.\(\)/, "mutation must only re-apply, never re-fetch");
    const historyBranch = source.slice(source.indexOf('reason === "history"'), source.indexOf("contentSidebarController.apply(options);\n}", source.indexOf('reason === "history"')));
    assert.match(historyBranch, /reason === "history" \|\| reason === "popstate" \|\| reason === "hashchange"/, "every SPA route event takes the notifyRoute path");
    assert.match(historyBranch, /notifyRoute\?\.\(\)/, "SPA navigation updates the active marker without refetching");
    assert.doesNotMatch(historyBranch, /\.refresh\?\.\(\)/);
});

test("hydration cannot self-sustain: every hydrate-path write is conditional and mutation filtering never waits on the sidebar", () => {
    const content = fs.readFileSync(path.join(__dirname, "../../js/content.js"), "utf8");
    const extractFunction = (name) => {
        const start = content.indexOf(`function ${name}(`);
        assert.notEqual(start, -1, `missing ${name}`);
        const bodyStart = content.indexOf("{", start);
        let depth = 0;
        for (let index = bodyStart; index < content.length; index += 1) {
            if (content[index] === "{") depth += 1;
            if (content[index] === "}") {
                depth -= 1;
                if (depth === 0) return content.slice(start, index + 1);
            }
        }
        throw new Error(`unterminated ${name}`);
    };

    // Owned-mutation filtering decouples from sidebar readiness: a missing or
    // uninitialized sidebar controller must never freeze hydration, and the
    // todo-* ownership filter stays the only suppression path here.
    const onMutationStart = content.indexOf("onMutation: (records) => {");
    assert.ok(onMutationStart >= 0, "the lifecycle onMutation hook is wired in content.js");
    const onMutationSource = content.slice(onMutationStart, content.indexOf("onStorageChange", onMutationStart));
    assert.match(onMutationSource, /contentTodoIntegration\?\.isOwnedMutation\?\.\(records\)\) return false/);
    assert.doesNotMatch(onMutationSource, /contentSidebarController\?\.isInitialized/);
    assert.match(onMutationSource, /return true;/);

    // Each of these runs on every debounced hydration; rewriting an identical
    // value would hand the mutation observer its own output back and sustain
    // the refresh loop the retired checkDashboardReady observer caused.
    const gradient = extractFunction("changeGradientCards");
    assert.match(gradient, /!cardcss\.isConnected/, "the gradient style node is appended only when missing, never re-parented per hydrate");
    assert.match(gradient, /cardcss\.textContent !== css/);
    assert.match(gradient, /cardcss\.textContent !== ""/, "clearing the gradient is conditional too");
    const gpa = extractFunction("calculateGPA2");
    assert.match(gpa, /letter\.textContent !== nextLetter/);
    assert.match(gpa, /unweighted\.textContent !== unweightedText/);
    assert.match(gpa, /weighted\.textContent !== weightedText/);
    assert.match(gpa, /cumulative\.textContent !== cumulativeText/);
    const notes = extractFunction("loadDashboardNotes");
    assert.match(notes, /dashboardNotesController/, "the isolated notes controller is reused across hydrations");
    assert.match(notes, /dashboardNotesController\?\.destroy\(\)/, "disabling notes tears down its listeners and DOM root");
    const grades = extractFunction("insertGrades");
    assert.match(grades, /getAttribute\("href"\) !== gradeHref/);
    assert.match(grades, /gradeContainer\.style\.display !== "block"/);
    const customize = extractFunction("customizeCards");
    assert.match(customize, /titleNode\.textContent !== cardOptions\.name/);
    assert.match(customize, /codeNode\.textContent !== cardOptions\.code/);
    assert.match(customize, /topColor\.parentNode !== container/, "the hero image is not re-parented on every hydrate");

    // Card Assignments: the skeleton is only a placeholder for the in-flight
    // planner read, the disabled path cannot spam identical style writes, and
    // a rejected planner read stays contained instead of surfacing as an
    // unhandled rejection.
    const setup = extractFunction("setupCardAssignments");
    assert.match(setup, /cardAssignments === null/);
    const assignments = extractFunction("loadCardAssignments");
    assert.match(assignments, /card\.style\.display !== "none"/);
    assert.match(assignments, /\.catch\(/);
    assert.match(assignments, /generation !== cardAssignmentsGeneration/, "stale route/context generations cannot render");
    assert.match(assignments, /insertBefore\(row, cursor/);
});

test("notifyRoute re-derives the active destination without refetching the model", async () => {
    const { document, root } = makeSidebarDocument();
    const location = { href: "https://canvas.emory.edu/", origin: "https://canvas.emory.edu", pathname: "/" };
    let assembleCalls = 0;
    const adapter = {
        async assemble() {
            assembleCalls += 1;
            return { identity: {}, route: { kind: "dashboard", pageId: "dashboard", pathname: "/" }, pages: [
                { id: "dashboard", label: "Dashboard", href: "/", available: true, iconRole: "dashboard" },
                { id: "assignments", label: "Assignments", href: "/assignments", available: true, iconRole: "canvas" }
            ], pageOrder: ["dashboard", "assignments"], pageVisibility: {}, courses: [] };
        },
        parseCanvasRoute(value) {
            return { origin: value.origin, pathname: value.pathname, kind: value.pathname === "/assignments" ? "unknown" : "dashboard", pageId: value.pathname === "/assignments" ? "canvas-route:x" : "dashboard", courseId: null, resource: [] };
        }
    };
    const controller = sidebar.createSidebarController({ document, root, adapter, window: { innerWidth: 1200, location } });
    controller.init({ better_sidebar: true });
    await controller.refresh();
    const custom = document.getElementById(sidebar.ROOT_ID);
    assert.deepEqual(allNodes(custom, (node) => node.getAttribute?.("aria-current") === "page").map((node) => node.getAttribute?.("data-page-id")), ["dashboard"]);
    const before = assembleCalls;
    location.pathname = "/assignments";
    location.href = "https://canvas.emory.edu/assignments";
    assert.equal(controller.notifyRoute(), true);
    const updated = document.getElementById(sidebar.ROOT_ID);
    assert.deepEqual(allNodes(updated, (node) => node.getAttribute?.("aria-current") === "page").map((node) => node.getAttribute?.("data-page-id")), ["assignments"]);
    assert.equal(assembleCalls, before, "notifyRoute must not refetch");
    controller.reset();
    assert.equal(controller.notifyRoute(), false, "notifyRoute is a no-op after reset");
});

test("notifyRoute updates the active marker in place, preserving rail DOM identity", async () => {
    const { document, root } = makeSidebarDocument();
    const location = { href: "https://canvas.emory.edu/", origin: "https://canvas.emory.edu", pathname: "/" };
    let assembleCalls = 0;
    const adapter = {
        async assemble() {
            assembleCalls += 1;
            return { identity: {}, route: { kind: "dashboard", pageId: "dashboard", pathname: "/" }, pages: [
                { id: "dashboard", label: "Dashboard", href: "/", available: true, iconRole: "dashboard" },
                { id: "assignments", label: "Assignments", href: "/assignments", available: true, iconRole: "canvas" }
            ], pageOrder: ["dashboard", "assignments"], pageVisibility: {}, courses: [] };
        },
        parseCanvasRoute(value) {
            return { origin: value.origin, pathname: value.pathname, kind: "unknown", pageId: "canvas-route:x", courseId: null, resource: [] };
        }
    };
    const controller = sidebar.createSidebarController({ document, root, adapter, window: { innerWidth: 1200, location } });
    controller.init({ better_sidebar: true });
    await controller.refresh();
    const custom = document.getElementById(sidebar.ROOT_ID);
    const pageList = custom.querySelector(`.${sidebar.NAMESPACE}-page-list`);
    assert.ok(pageList, "the page list rendered");
    const linkFor = (id) => byClass(custom, `${sidebar.NAMESPACE}-page-row`).find((node) => node.getAttribute("data-page-id") === id);
    const assignmentsBefore = linkFor("assignments");
    assert.ok(assignmentsBefore);
    location.pathname = "/assignments";
    location.href = "https://canvas.emory.edu/assignments";
    const assembleBefore = assembleCalls;
    assert.equal(controller.notifyRoute(), true);
    const customAfter = document.getElementById(sidebar.ROOT_ID);
    assert.equal(customAfter.querySelector(`.${sidebar.NAMESPACE}-page-list`), pageList, "the page list node is not rebuilt on route change");
    const assignmentsAfter = linkFor("assignments");
    assert.equal(assignmentsAfter, assignmentsBefore, "the row link object is preserved");
    assert.equal(assignmentsAfter.getAttribute("aria-current"), "page", "the new destination is marked in place");
    assert.equal(linkFor("dashboard").getAttribute("aria-current"), null, "the old destination is unmarked in place");
    assert.equal(assembleCalls, assembleBefore, "the diff path never refetches");
    controller.reset();
});

test("a stale revision marker falls notifyRoute back to a full rebuild", async () => {
    const { document, root } = makeSidebarDocument();
    const location = { href: "https://canvas.emory.edu/", origin: "https://canvas.emory.edu", pathname: "/" };
    const adapter = {
        async assemble() {
            return { identity: {}, route: { kind: "dashboard", pageId: "dashboard", pathname: "/" }, pages: [
                { id: "dashboard", label: "Dashboard", href: "/", available: true, iconRole: "dashboard" }
            ], pageOrder: ["dashboard"], pageVisibility: {}, courses: [] };
        },
        parseCanvasRoute(value) {
            return { origin: value.origin, pathname: value.pathname, kind: "unknown", pageId: "canvas-route:x", courseId: null, resource: [] };
        }
    };
    const controller = sidebar.createSidebarController({ document, root, adapter, window: { innerWidth: 1200, location } });
    controller.init({ better_sidebar: true });
    await controller.refresh();
    const custom = document.getElementById(sidebar.ROOT_ID);
    const pageList = custom.querySelector(`.${sidebar.NAMESPACE}-page-list`);
    custom.setAttribute("data-apstudycanvas-sidebar-revision", "999");
    location.pathname = "/courses";
    location.href = "https://canvas.emory.edu/courses";
    assert.equal(controller.notifyRoute(), true, "the fallback still reports success");
    const rebuilt = document.getElementById(sidebar.ROOT_ID).querySelector(`.${sidebar.NAMESPACE}-page-list`);
    assert.notEqual(rebuilt, pageList, "an untrusted revision falls back to a full rebuild");
    controller.reset();
});

function makeSnapshotHarness() {
    const storage = new Map();
    const sessionStorage = {
        getItem: (key) => (storage.has(key) ? storage.get(key) : null),
        setItem: (key, value) => storage.set(key, String(value)),
        removeItem: (key) => storage.delete(key)
    };
    const state = { clock: 1750000000000, assembleCalls: 0 };
    const pages = [
        { id: "dashboard", label: "Dashboard", href: "/", available: true, iconRole: "dashboard" },
        { id: "courses", label: "Courses", href: "/courses", available: true, iconRole: "courses" }
    ];
    const makeAdapter = (courses, options = {}) => ({
        async assemble() {
            state.assembleCalls += 1;
            return { identity: { institutionName: "Emory" }, route: { kind: "dashboard", pageId: "dashboard", pathname: "/" }, pages, pageOrder: ["dashboard", "courses"], pageVisibility: {}, courses, courseState: { status: courses.length ? "populated" : "empty", retryable: false, reason: null, provisional: false } };
        },
        parseCanvasRoute(value) {
            return { origin: value.origin, pathname: value.pathname, kind: value.pathname === "/" ? "dashboard" : "unknown", pageId: value.pathname === "/" ? "dashboard" : "canvas-route:x", courseId: null, resource: [] };
        },
        async getCourseNavigation() {
            return { tabs: [
                { label: "Home", href: "/courses/101" },
                { label: "Assignments", href: "/courses/101/assignments" }
            ] };
        },
        ...options
    });
    const makeWindow = (pathname) => ({ innerWidth: 1200, location: { href: `https://canvas.emory.edu${pathname}`, origin: "https://canvas.emory.edu", pathname }, sessionStorage, setTimeout: () => 0, clearTimeout: () => {} });
    return { storage, sessionStorage, state, pages, makeAdapter, makeWindow };
}

test("a hard navigation adopts the sessionStorage snapshot: populated rail at mount with no refetch", async () => {
    const harness = makeSnapshotHarness();
    const courses = [
        { id: "101", name: "Biology", href: "/courses/101", color: "#a1b2c3" },
        { id: "102", name: "History", href: "/courses/102" }
    ];
    const first = makeSidebarDocument();
    const firstController = sidebar.createSidebarController({
        document: first.document,
        root: first.root,
        adapter: harness.makeAdapter(courses),
        window: harness.makeWindow("/"),
        now: () => harness.state.clock
    });
    firstController.init({ better_sidebar: true });
    await firstController.refresh();
    assert.equal(harness.state.assembleCalls, 1);
    // The debounced writer is stubbed out (no-op timers), so only the
    // pagehide flush can produce the snapshot — exactly the hard-navigation
    // ordering this feature depends on.
    first.document.dispatchEvent({ type: "pagehide" });
    assert.ok(harness.storage.has(sidebar.SNAPSHOT_STORAGE_KEY), "pagehide flush writes the snapshot");
    const stored = JSON.parse(harness.storage.get(sidebar.SNAPSHOT_STORAGE_KEY));
    assert.equal(stored.v, sidebar.SNAPSHOT_RECORD_VERSION);
    assert.equal(stored.courses.length, 2);

    const second = makeSidebarDocument();
    const secondController = sidebar.createSidebarController({
        document: second.document,
        root: second.root,
        adapter: harness.makeAdapter(courses),
        window: harness.makeWindow("/"),
        now: () => harness.state.clock + 1000
    });
    secondController.init({ better_sidebar: true });
    assert.equal(harness.state.assembleCalls, 1, "mount adoption never refetches");
    const model = secondController.getModel();
    assert.equal(model.courseState.status, "populated", "the snapshot renders populated");
    assert.equal(model.courseState.provisional, true, "the snapshot render stays provisional");
    assert.equal(model.courseState.reason, "snapshot");
    assert.equal(model.courses.length, 2);
    const custom = second.document.getElementById(sidebar.ROOT_ID);
    assert.equal(byClass(custom, `${sidebar.NAMESPACE}-course-item`).length, 2, "course rows render immediately");
    const dashboardRow = byClass(custom, `${sidebar.NAMESPACE}-page-row`).find((node) => node.getAttribute("data-page-id") === "dashboard");
    assert.equal(dashboardRow?.getAttribute("aria-current"), "page", "the route is re-derived at adoption, never trusted from the record");
    await secondController.refresh();
    assert.equal(harness.state.assembleCalls, 2, "the explicit revalidation refetches once");
    assert.equal(secondController.getModel().courseState.provisional, false, "revalidation clears the provisional state");
    secondController.dispose();
    firstController.dispose();
});

test("snapshot hydration restores open course disclosures and they survive the mount refresh", async () => {
    const harness = makeSnapshotHarness();
    const courses = [
        { id: "101", name: "Biology", href: "/courses/101", color: "#a1b2c3" },
        { id: "102", name: "History", href: "/courses/102" }
    ];
    const first = makeSidebarDocument();
    const firstController = sidebar.createSidebarController({
        document: first.document,
        root: first.root,
        adapter: harness.makeAdapter(courses),
        window: harness.makeWindow("/"),
        now: () => harness.state.clock
    });
    firstController.init({ better_sidebar: true });
    await firstController.refresh();
    const toggle = byClass(first.document.getElementById(sidebar.ROOT_ID), `${sidebar.NAMESPACE}-course-toggle`)[0];
    assert.ok(toggle, "the course row renders its disclosure toggle");
    toggle.dispatchEvent({ type: "click" });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    first.document.dispatchEvent({ type: "pagehide" });
    const stored = JSON.parse(harness.storage.get(sidebar.SNAPSHOT_STORAGE_KEY));
    assert.deepEqual(stored.disclosure.map((entry) => entry.id), ["101"], "the open disclosure is captured");
    assert.equal(stored.disclosure[0].tabs.length, 2);

    const second = makeSidebarDocument();
    const secondController = sidebar.createSidebarController({
        document: second.document,
        root: second.root,
        adapter: harness.makeAdapter(courses),
        window: harness.makeWindow("/"),
        now: () => harness.state.clock + 1000
    });
    secondController.init({ better_sidebar: true });
    const custom = second.document.getElementById(sidebar.ROOT_ID);
    assert.equal(byClass(custom, `${sidebar.NAMESPACE}-course-tab`).length, 2, "disclosure tabs render from the snapshot");
    await secondController.refresh();
    assert.equal(byClass(second.document.getElementById(sidebar.ROOT_ID), `${sidebar.NAMESPACE}-course-tab`).length, 2, "settled disclosures survive the revalidation render");
    secondController.dispose();
    firstController.dispose();
});

test("expired snapshots are ignored and the mount falls back to the loading model", async () => {
    const harness = makeSnapshotHarness();
    const courses = [{ id: "101", name: "Biology", href: "/courses/101" }];
    const first = makeSidebarDocument();
    const firstController = sidebar.createSidebarController({
        document: first.document,
        root: first.root,
        adapter: harness.makeAdapter(courses),
        window: harness.makeWindow("/"),
        now: () => harness.state.clock
    });
    firstController.init({ better_sidebar: true });
    await firstController.refresh();
    first.document.dispatchEvent({ type: "pagehide" });
    assert.ok(harness.storage.has(sidebar.SNAPSHOT_STORAGE_KEY));

    const second = makeSidebarDocument();
    const secondController = sidebar.createSidebarController({
        document: second.document,
        root: second.root,
        adapter: harness.makeAdapter(courses),
        window: harness.makeWindow("/"),
        now: () => harness.state.clock + sidebar.SNAPSHOT_TTL_MS + 1000
    });
    secondController.init({ better_sidebar: true });
    assert.equal(harness.state.assembleCalls, 1, "the first assemble call belongs to document one only");
    const model = secondController.getModel();
    assert.equal(model.courseState.status, "loading", "an expired snapshot is not adopted");
    assert.equal(model.courses.length, 0);
    secondController.dispose();
    firstController.dispose();
});

test("oversized snapshots degrade gracefully: disclosures and then courses are dropped before the write is skipped", async () => {
    const harness = makeSnapshotHarness();
    const longName = "X".repeat(300);
    const courses = Array.from({ length: 200 }, (_, index) => ({ id: String(1000 + index), name: `${longName} ${index}`, href: `/courses/${1000 + index}` }));
    const first = makeSidebarDocument();
    const firstController = sidebar.createSidebarController({
        document: first.document,
        root: first.root,
        adapter: harness.makeAdapter(courses),
        window: harness.makeWindow("/"),
        now: () => harness.state.clock
    });
    firstController.init({ better_sidebar: true });
    await firstController.refresh();
    first.document.dispatchEvent({ type: "pagehide" });
    const stored = JSON.parse(harness.storage.get(sidebar.SNAPSHOT_STORAGE_KEY));
    assert.deepEqual(stored.courses, [], "the course list is dropped to fit the cap");
    assert.equal(stored.pages.length, 2, "the page structure still hydrates");
    const second = makeSidebarDocument();
    const secondController = sidebar.createSidebarController({
        document: second.document,
        root: second.root,
        adapter: harness.makeAdapter(courses),
        window: harness.makeWindow("/"),
        now: () => harness.state.clock + 1000
    });
    secondController.init({ better_sidebar: true });
    const model = secondController.getModel();
    assert.equal(model.pages.length, 2, "pages adopt from the degraded record");
    assert.equal(model.courses.length, 0);
    assert.equal(model.courseState.status, "loading", "degraded courses render as loading, never a false empty state");
    const custom = second.document.getElementById(sidebar.ROOT_ID);
    assert.equal(byClass(custom, `${sidebar.NAMESPACE}-page-item`).length >= 2, true, "the rail structure is present immediately");
    secondController.dispose();
    firstController.dispose();
});


test("a sidebar initialized before the native nav mounts runs exactly one initial refresh", async () => {
    const { document, root } = makeSidebarDocument();
    root.remove();
    let assembleCalls = 0;
    const adapter = {
        async assemble() {
            assembleCalls += 1;
            return { identity: {}, route: { kind: "dashboard", pageId: "dashboard", pathname: "/" }, pages: [
                { id: "dashboard", label: "Dashboard", href: "/", available: true, iconRole: "dashboard" }
            ], pageOrder: ["dashboard"], pageVisibility: {}, courses: [] };
        }
    };
    const controller = sidebar.createSidebarController({ document, adapter, window: { innerWidth: 1200, location: { href: "https://canvas.emory.edu/", origin: "https://canvas.emory.edu", pathname: "/" } } });
    controller.init({ better_sidebar: true });
    assert.equal(assembleCalls, 0, "init before the nav exists never fetches");
    assert.equal(controller.isMountRefreshDone(), false);
    const settle = async () => { for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

    document.documentElement.appendChild(root);
    assert.equal(controller.apply({}), true, "the late native root mounts the rail");
    await settle();
    assert.equal(assembleCalls, 1, "the first successful mount starts exactly one refresh");
    assert.equal(controller.isMountRefreshDone(), true);
    assert.equal(document.getElementById(sidebar.ROOT_ID) !== null, true);

    document.getElementById(sidebar.ROOT_ID).remove();
    assert.equal(controller.apply({}), true, "a torn-down rail remounts without refetching");
    await settle();
    assert.equal(assembleCalls, 1, "later mutation remounts never refetch");
    assert.equal(controller.apply({}), true, "applies on a mounted rail stay cheap");
    await settle();
    assert.equal(assembleCalls, 1);
    controller.dispose();
});

test("collapsed rail exposes visible root scale and density variables and filters unavailable pages", async () => {
    const { document, root } = makeSidebarDocument();
    const adapter = {
        async assemble() {
            return { identity: {}, route: { pathname: "/dashboard" }, pages: [
                { id: "dashboard", label: "Dashboard", href: "/dashboard", available: true, iconRole: "dashboard" },
                { id: "history", label: "History", href: null, available: false, iconRole: "history" }
            ], pageOrder: ["dashboard", "history"], pageVisibility: { dashboard: false, history: true }, courses: [] };
        }
    };
    const controller = sidebar.createSidebarController({ document, window: { innerWidth: 1200, location: { href: "https://canvas.emory.edu/", origin: "https://canvas.emory.edu", pathname: "/" } }, root, adapter });
    controller.init({ better_sidebar: true, sidebar_preferred_state: "collapsed", sidebar_scale_preset: "extra-large", sidebar_density: "compact", sidebar_collapsed_labels: true });
    await controller.refresh();
    const custom = document.getElementById(sidebar.ROOT_ID);
    assert.equal(custom.getAttribute("data-apstudycanvas-sidebar-state"), "collapsed");
    assert.equal(custom.getAttribute("data-apstudycanvas-sidebar-scale"), "extra-large");
    assert.equal(custom.getAttribute("data-apstudycanvas-sidebar-density"), "compact");
    assert.equal(custom.style["--apstudy-sidebar-icon-size"], "21px");
    assert.equal(custom.style["--apstudy-sidebar-label-size"], "18px");
    assert.equal(controller.getModel().pages.find((page) => page.id === "history")?.available, false);
    assert.equal(allNodes(custom, (node) => node.getAttribute?.("data-page-id") === "history").length, 0);
    const showHidden = byClass(custom, `${sidebar.NAMESPACE}-show-hidden`)[0];
    assert.equal(showHidden.parentNode.tagName, "LI");
});

test("course disclosure uses only adapter-verified tabs and handles empty and error results", async () => {
    const run = async (mode) => {
        const { document, root } = makeSidebarDocument();
        const calls = [];
        const adapter = {
            async assemble() { return { identity: {}, route: {}, pages: [], pageOrder: [], pageVisibility: {}, courses: [{ id: 7, name: "Biology", href: "/courses/7", color: "#123456" }] }; },
            async getCourseNavigation(args) { calls.push(args); if (mode === "error") throw new Error("unavailable"); return mode === "empty" ? { tabs: [] } : { tabs: [{ id: "home", label: "Home", href: "/courses/7" }, { id: "unsafe", label: "Unsafe", href: "https://evil.example/course" }] }; }
        };
        const controller = sidebar.createSidebarController({ document, window: { innerWidth: 1200, location: { href: "https://canvas.emory.edu/", origin: "https://canvas.emory.edu", pathname: "/" } }, root, adapter });
        controller.init({ better_sidebar: true });
        await controller.refresh();
        const toggle = byClass(document.getElementById(sidebar.ROOT_ID), `${sidebar.NAMESPACE}-course-toggle`)[0];
        toggle.dispatchEvent({ type: "click" });
        await new Promise((resolve) => setImmediate(resolve));
        return { document, controller, calls };
    };
    const success = await run("success");
    assert.equal(success.calls.length, 1);
    assert.ok(byClass(success.document.getElementById(sidebar.ROOT_ID), `${sidebar.NAMESPACE}-course-tab`).length >= 1);
    assert.ok(byClass(success.document.getElementById(sidebar.ROOT_ID), `${sidebar.NAMESPACE}-course-link`).length >= 1);
    assert.equal(allNodes(success.document.getElementById(sidebar.ROOT_ID), (node) => node.getAttribute?.("href") === "https://evil.example/course").length, 0);
    const empty = await run("empty");
    assert.match(allNodes(empty.document.getElementById(sidebar.ROOT_ID)).map((node) => node.textContent).join(" "), /No course navigation/);
    const error = await run("error");
    assert.ok(byClass(error.document.getElementById(sidebar.ROOT_ID), `${sidebar.NAMESPACE}-course-retry`).length >= 1);
});

test("course-order reads use only the opaque account key", async () => {
    const { document, root } = makeSidebarDocument();
    let key = null;
    const accountKey = "a".repeat(64);
    const adapter = { async assemble() { return { identity: { accountKey, origin: "https://canvas.emory.edu", userId: "42" }, pages: [], pageOrder: [], pageVisibility: {}, courses: [] }; } };
    const controller = sidebar.createSidebarController({ document, root, window: { innerWidth: 1200, location: { href: "https://canvas.emory.edu/", origin: "https://canvas.emory.edu", pathname: "/" } }, adapter, readCourseOrder(value) { key = value; return Promise.resolve([]); } });
    controller.init({ better_sidebar: true });
    await controller.refresh();
    assert.match(key, new RegExp(`^apstudycanvas\\.sidebar\\.course-order\\.v1:${accountKey}$`));
    assert.doesNotMatch(key, /canvas\.emory\.edu|42/);
});

test("semantic rail renders icon-led destinations, a branded identity, bounded courses, and an icon-led footer", async () => {
    const { document, root } = makeSidebarDocument();
    const adapter = {
        async assemble() {
            return {
                identity: { institutionName: "Emory" },
                route: { kind: "dashboard", pageId: "dashboard", pathname: "/dashboard" },
                pages: [
                    { id: "dashboard", label: "Dashboard", href: "/dashboard", available: true, iconRole: "dashboard" },
                    { id: "unknown", label: "Unknown destination", href: "/unknown", available: true, iconRole: "not-a-real-icon" }
                ],
                pageOrder: ["dashboard", "unknown"],
                pageVisibility: {},
                courses: [{ id: "biology", name: "Biology with an intentionally long course title", href: "/courses/7", color: "#123456" }]
            };
        }
    };
    const controller = sidebar.createSidebarController({
        document,
        window: { innerWidth: 1200, location: { href: "https://canvas.emory.edu/", origin: "https://canvas.emory.edu", pathname: "/dashboard" } },
        root,
        adapter
    });
    controller.init({ better_sidebar: true, sidebar_expanded_width: 180 });
    await controller.refresh();
    const custom = document.getElementById(sidebar.ROOT_ID);
    const pageRows = byClass(custom, `${sidebar.NAMESPACE}-page-row`);
    assert.equal(pageRows.length, 2);
    pageRows.forEach((row) => {
        const icon = row.querySelector("svg");
        assert.ok(icon, "every destination keeps a visible inline icon");
        assert.equal(row.getAttribute("aria-label") !== null, true);
        assert.equal(icon.namespaceURI, "http://www.w3.org/2000/svg");
        assert.equal(icon.getAttribute("class"), `${sidebar.NAMESPACE}-icon`);
        assert.equal(icon.getAttribute("xmlns"), "http://www.w3.org/2000/svg");
        assert.equal(icon.getAttribute("viewBox"), "0 0 24 24");
        assert.equal(icon.getAttribute("fill"), "none");
        assert.equal(icon.getAttribute("stroke"), "currentColor");
        assert.equal(icon.getAttribute("aria-hidden"), "true");
        assert.equal(icon.getAttribute("focusable"), "false");
        assert.equal(icon.getAttribute("role"), "presentation");
        const path = icon.querySelector("path");
        assert.ok(path, "the inline icon has a real vector child");
        assert.equal(path.namespaceURI, "http://www.w3.org/2000/svg");
        assert.equal(path.getAttribute("class"), `${sidebar.NAMESPACE}-icon-path`);
        assert.match(path.getAttribute("d"), /^M/);
        assert.equal(path.getAttribute("stroke"), "currentColor");
        assert.equal(path.getAttribute("fill"), "none");
        assert.equal(path.getAttribute("vector-effect"), "non-scaling-stroke");
    });
    const dashboard = allNodes(custom, (node) => node.getAttribute?.("data-page-id") === "dashboard")[0];
    const unknown = allNodes(custom, (node) => node.getAttribute?.("data-page-id") === "unknown")[0];
    assert.equal(dashboard.querySelector("svg").getAttribute("data-apstudycanvas-icon"), "dashboard");
    assert.equal(unknown.querySelector("svg").getAttribute("data-apstudycanvas-icon"), "fallback");
    assert.equal(unknown.querySelector("svg").querySelector("path").getAttribute("d"), "M4 4h16v16H4z M8 8h8v8H8z");
    assert.equal(dashboard.getAttribute("aria-current"), "page");
    const avatar = byClass(custom, `${sidebar.NAMESPACE}-identity-avatar`)[0];
    assert.ok(avatar, "the identity header is the user's profile picture control");
    assert.equal(avatar.tagName, "BUTTON");
    assert.equal(avatar.getAttribute("aria-haspopup"), "dialog");
    assert.equal(avatar.getAttribute("aria-label"), "Canvas account");
    assert.equal(byClass(avatar, `${sidebar.NAMESPACE}-avatar-initial`)[0].textContent, "C", "a missing avatar falls back to initials");
    assert.equal(byClass(custom, `${sidebar.NAMESPACE}-identity-copy`).length, 0, "the APStudyCanvas promo copy no longer occupies the header");
    assert.equal(byClass(custom, `${sidebar.NAMESPACE}-identity-mark`).length, 0, "a missing institution logo leaves no mark slot");
    assert.equal(byClass(custom, `${sidebar.NAMESPACE}-section-label`).map((node) => node.textContent).join(" "), "Pages Courses");
    assert.equal(byClass(custom, `${sidebar.NAMESPACE}-course-dot`).length, 1);
    assert.equal(byClass(custom, `${sidebar.NAMESPACE}-course-link`)[0].getAttribute("title"), "Biology with an intentionally long course title");
    byClass(custom, `${sidebar.NAMESPACE}-footer-action`).forEach((action) => assert.ok(action.querySelector("svg"), "footer controls retain their icons"));
});

test("open long-label courses keep the bounded nested-tab DOM contract", async () => {
    const { document, root } = makeSidebarDocument();
    const longCourseName = "BIOL-141L-1: Foundations of Modern Biology with an intentionally long Canvas course title";
    const longTabLabel = "Assignments and resources with an intentionally long navigation label";
    const adapter = {
        async assemble() {
            return {
                identity: {}, route: {}, pages: [], pageOrder: [], pageVisibility: {},
                courses: [{ id: "biology", name: longCourseName, href: "/courses/7", color: "#123456" }]
            };
        },
        async getCourseNavigation() {
            return { tabs: [
                { id: "home", label: "Home", href: "/courses/7" },
                { id: "assignments", label: longTabLabel, href: "/courses/7/assignments" }
            ] };
        }
    };
    const controller = sidebar.createSidebarController({
        document, root, adapter,
        window: { innerWidth: 1200, location: { href: "https://canvas.emory.edu/", origin: "https://canvas.emory.edu", pathname: "/" } }
    });
    controller.init({ better_sidebar: true, sidebar_expanded_width: 180 });
    await controller.refresh();

    const custom = document.getElementById(sidebar.ROOT_ID);
    const middle = byClass(custom, `${sidebar.NAMESPACE}-middle`);
    const coursesSection = byClass(custom, `${sidebar.NAMESPACE}-courses-section`);
    const courseList = byClass(custom, `${sidebar.NAMESPACE}-course-list`);
    const courseRow = byClass(custom, `${sidebar.NAMESPACE}-course-row`);
    const courseLink = byClass(custom, `${sidebar.NAMESPACE}-course-link`);
    const courseName = byClass(custom, `${sidebar.NAMESPACE}-course-name`);
    const courseToggle = byClass(custom, `${sidebar.NAMESPACE}-course-toggle`);
    assert.equal(middle.length, 1);
    assert.equal(coursesSection.length, 1);
    assert.equal(courseList.length, 1);
    assert.equal(courseRow.length, 1);
    assert.equal(courseLink.length, 1);
    assert.equal(courseName.length, 1);
    assert.equal(courseName[0].textContent, longCourseName);
    assert.equal(courseToggle.length, 1);
    assert.equal(courseToggle[0].getAttribute("aria-expanded"), "false");

    courseToggle[0].dispatchEvent({ type: "click" });
    await new Promise((resolve) => setImmediate(resolve));
    const openRoot = document.getElementById(sidebar.ROOT_ID);
    const tabs = byClass(openRoot, `${sidebar.NAMESPACE}-course-tabs`);
    const tabItems = allNodes(tabs[0], (node) => node.tagName === "LI");
    const tabLinks = byClass(openRoot, `${sidebar.NAMESPACE}-course-tab`);
    assert.equal(tabs.length, 1);
    assert.equal(tabItems.length, 2);
    assert.equal(tabLinks.length, 2);
    assert.equal(tabLinks[1].textContent, longTabLabel);
    assert.equal(tabLinks[1].getAttribute("href"), "https://canvas.emory.edu/courses/7/assignments");
});

test("section heading tooltips follow the preference without losing accessible names", async () => {
    const render = async (tooltips) => {
        const { document, root } = makeSidebarDocument();
        const adapter = {
            async assemble() {
                return {
                    identity: {}, route: {},
                    pages: [{ id: "dashboard", label: "Dashboard", href: "/dashboard", available: true, iconRole: "dashboard" }],
                    pageOrder: ["dashboard"], pageVisibility: {}, courses: [{ id: "7", name: "Biology", href: "/courses/7" }]
                };
            }
        };
        const controller = sidebar.createSidebarController({
            document, root, adapter,
            window: { innerWidth: 1200, location: { href: "https://canvas.emory.edu/", origin: "https://canvas.emory.edu", pathname: "/" } }
        });
        controller.init({ better_sidebar: true, sidebar_tooltips: tooltips });
        await controller.refresh();
        const rootNode = document.getElementById(sidebar.ROOT_ID);
        return { headings: byClass(rootNode, `${sidebar.NAMESPACE}-section-toggle`), courseLink: byClass(rootNode, `${sidebar.NAMESPACE}-course-link`)[0] };
    };

    const enabled = await render(true);
    assert.deepEqual(enabled.headings.map((heading) => heading.getAttribute("title")), ["Pages", "Courses"]);
    assert.equal(enabled.courseLink.getAttribute("title"), "Biology");
    assert.equal(enabled.courseLink.getAttribute("aria-label"), "Biology");
    const disabled = await render(false);
    assert.deepEqual(disabled.headings.map((heading) => heading.getAttribute("title")), [null, null]);
    assert.equal(disabled.courseLink.getAttribute("title"), null);
    assert.equal(disabled.courseLink.getAttribute("aria-label"), "Biology");
    disabled.headings.forEach((heading) => {
        assert.ok(heading.getAttribute("aria-label"), "the button accessible name must remain present");
        assert.ok(heading.getAttribute("aria-controls"), "the section relationship must remain present");
        assert.notEqual(heading.getAttribute("aria-expanded"), null, "the disclosure state must remain present");
    });
});

test("explicit rail widths remain live at the measured expanded and compact safety points", async () => {
    const cases = [
        { expanded: 180, collapsed: 86, state: "expanded" },
        { expanded: 280, collapsed: 86, state: "expanded" },
        { expanded: 180, collapsed: 86, state: "collapsed" },
        { expanded: 180, collapsed: 70, state: "collapsed" }
    ];
    for (const settings of cases) {
        const { document, root } = makeSidebarDocument();
        const adapter = { async assemble() { return { identity: {}, route: {}, pages: [], pageOrder: [], pageVisibility: {}, courses: [] }; } };
        const controller = sidebar.createSidebarController({ document, root, adapter, window: { innerWidth: 1200, location: { href: "https://canvas.emory.edu/", origin: "https://canvas.emory.edu", pathname: "/" } } });
        controller.init({ better_sidebar: true, sidebar_preferred_state: settings.state, sidebar_expanded_width: settings.expanded, sidebar_collapsed_width: settings.collapsed });
        await controller.refresh();
        const custom = document.getElementById(sidebar.ROOT_ID);
        assert.equal(custom.style["--apstudy-sidebar-width"], `${settings.state === "expanded" ? settings.expanded : settings.collapsed}px`);
        assert.equal(custom.style["--apstudycanvas-sidebar-expanded-width"], undefined);
        assert.equal(controller.getState().widths.expanded, settings.expanded);
        assert.equal(controller.getState().widths.collapsed, settings.collapsed);
    }
});

test("Courses keeps one stable shell across loading, populated, successful empty, and retryable error states", async () => {
    const modelFor = (courseState, courses = []) => ({
        identity: {}, route: {},
        pages: [{ id: "dashboard", label: "Dashboard", href: "/", available: true, iconRole: "dashboard" }],
        pageOrder: ["dashboard"], pageVisibility: {}, courses, courseState
    });
    const assertState = (custom, expected) => {
        const sections = byClass(custom, `${sidebar.NAMESPACE}-courses-section`);
        const bodies = byClass(custom, `${sidebar.NAMESPACE}-course-body`);
        const lists = byClass(custom, `${sidebar.NAMESPACE}-course-list`);
        assert.equal(sections.length, 1, "Courses section shell remains mounted");
        assert.equal(bodies.length, 1, "Courses body remains mounted");
        assert.equal(lists.length, 1, "Courses list remains mounted");
        assert.equal(sections[0].getAttribute("data-course-state"), expected);
        assert.equal(bodies[0].getAttribute("data-course-state"), expected);
        assert.equal(byClass(custom, `${sidebar.NAMESPACE}-section-toggle`).at(-1).getAttribute("aria-controls"), `${sidebar.NAMESPACE}-courses-body`);
    };

    let release;
    const { document, root } = makeSidebarDocument();
    const adapter = {
        assemble() { return new Promise((resolve) => { release = resolve; }); }
    };
    const controller = sidebar.createSidebarController({ document, root, adapter, window: { innerWidth: 1200, location: { href: "https://canvas.emory.edu/", origin: "https://canvas.emory.edu", pathname: "/" } } });
    controller.init({ better_sidebar: true });
    const pending = controller.refresh();
    assertState(document.getElementById(sidebar.ROOT_ID), "loading");
    release(modelFor({ status: "populated", retryable: false }, [{ id: "7", name: "Biology", href: "/courses/7", color: "#123456" }]));
    await pending;
    assertState(document.getElementById(sidebar.ROOT_ID), "populated");
    assert.equal(byClass(document.getElementById(sidebar.ROOT_ID), `${sidebar.NAMESPACE}-course-row`).length, 1);

    adapter.assemble = async () => modelFor({ status: "empty", retryable: false });
    await controller.refresh();
    const emptyRoot = document.getElementById(sidebar.ROOT_ID);
    assertState(emptyRoot, "empty");
    assert.equal(byClass(emptyRoot, `${sidebar.NAMESPACE}-course-status-message`)[0].textContent, "No active courses.");

    adapter.assemble = async () => modelFor({ status: "error", retryable: true, reason: "request-failed" });
    await controller.refresh();
    const errorRoot = document.getElementById(sidebar.ROOT_ID);
    assertState(errorRoot, "error");
    const retry = byClass(errorRoot, `${sidebar.NAMESPACE}-course-retry`)[0];
    assert.ok(retry);
    let retried;
    const retriedModel = new Promise((resolve) => { retried = resolve; });
    adapter.assemble = async () => {
        const next = modelFor({ status: "populated", retryable: false }, [{ id: "8", name: "Chemistry", href: "/courses/8" }]);
        retried(next);
        return next;
    };
    retry.dispatchEvent({ type: "click" });
    await retriedModel;
    await new Promise((resolve) => setImmediate(resolve));
    assertState(document.getElementById(sidebar.ROOT_ID), "populated");
});

test("Courses folded and hidden preferences change allocation without treating empty data as visibility", async () => {
    const render = async (settings) => {
        const { document, root } = makeSidebarDocument();
        const adapter = { async assemble() { return { identity: {}, route: {}, pages: [], pageOrder: [], pageVisibility: {}, courses: [], courseState: { status: "empty", retryable: false } }; } };
        const controller = sidebar.createSidebarController({ document, root, adapter, window: { innerWidth: 1200, location: { href: "https://canvas.emory.edu/", origin: "https://canvas.emory.edu", pathname: "/" } } });
        controller.init({ better_sidebar: true, ...settings });
        await controller.refresh();
        return document.getElementById(sidebar.ROOT_ID);
    };
    const folded = await render({ sidebar_courses_folded: true });
    assert.equal(byClass(folded, `${sidebar.NAMESPACE}-courses-section`).length, 1);
    assert.equal(byClass(folded, `${sidebar.NAMESPACE}-course-body`)[0].getAttribute("hidden"), "");
    assert.equal(byClass(folded, `${sidebar.NAMESPACE}-middle`)[0].getAttribute("data-courses-folded"), "true");

    const hidden = await render({ sidebar_courses_visible_expanded: false });
    assert.equal(byClass(hidden, `${sidebar.NAMESPACE}-courses-section`).length, 0);
    assert.equal(byClass(hidden, `${sidebar.NAMESPACE}-middle`)[0].getAttribute("data-courses-visible"), "false");

    const emptyVisible = await render({ sidebar_courses_visible_expanded: true });
    assert.equal(byClass(emptyVisible, `${sidebar.NAMESPACE}-courses-section`).length, 1);
    assert.equal(byClass(emptyVisible, `${sidebar.NAMESPACE}-courses-section`)[0].getAttribute("data-course-state"), "empty");
});

test("section and nested-course disclosures retain semantic state through their short exit motion", async () => {
    const { document, root } = makeSidebarDocument();
    const animationFrames = [];
    const adapter = {
        async assemble() {
            return {
                identity: {}, route: {},
                pages: [{ id: "dashboard", label: "Dashboard", href: "/dashboard", available: true, iconRole: "dashboard" }],
                pageOrder: ["dashboard"], pageVisibility: {},
                courses: [{ id: "7", name: "Biology", href: "/courses/7" }],
                courseState: { status: "populated", retryable: false }
            };
        },
        async getCourseNavigation() { return { tabs: [{ id: "home", label: "Home", href: "/courses/7" }] }; }
    };
    const controller = sidebar.createSidebarController({
        document, root, adapter, writeSettings: async () => {},
        window: { innerWidth: 1200, location: { href: "https://canvas.emory.edu/", origin: "https://canvas.emory.edu", pathname: "/" }, requestAnimationFrame(callback) { animationFrames.push(callback); return animationFrames.length; } }
    });
    controller.init({ better_sidebar: true });
    await controller.refresh();

    const custom = document.getElementById(sidebar.ROOT_ID);
    const pageToggle = byClass(custom, `${sidebar.NAMESPACE}-section-toggle`)[0];
    const pageList = byClass(custom, `${sidebar.NAMESPACE}-page-list`)[0];
    pageToggle.dispatchEvent({ type: "click" });
    assert.equal(pageToggle.getAttribute("aria-expanded"), "false");
    assert.equal(pageList.getAttribute("aria-hidden"), "true");
    assert.equal(pageList.getAttribute("hidden"), null, "the close keeps the panel mounted for its exit");
    pageList.dispatchEvent({ type: "transitionend", propertyName: "opacity" });
    assert.equal(pageList.getAttribute("hidden"), "");
    pageToggle.dispatchEvent({ type: "click" });
    assert.equal(pageToggle.getAttribute("aria-expanded"), "true");
    assert.equal(pageList.getAttribute("aria-hidden"), "false");
    assert.equal(pageList.getAttribute("hidden"), null);
    assert.equal(pageList.getAttribute("data-motion"), "opening", "the opening keyframe is painted before the final state");
    animationFrames.shift()();
    assert.equal(pageList.getAttribute("data-motion"), "opening", "one rAF cannot coalesce the opening and final states");
    animationFrames.shift()();
    assert.equal(pageList.getAttribute("data-motion"), "open");

    const courseToggle = byClass(custom, `${sidebar.NAMESPACE}-course-toggle`)[0];
    const panelId = courseToggle.getAttribute("aria-controls");
    assert.equal(document.getElementById(panelId).getAttribute("hidden"), "", "closed course navigation remains safely hidden by default");
    courseToggle.dispatchEvent({ type: "click" });
    await new Promise((resolve) => setImmediate(resolve));
    animationFrames.shift()();
    animationFrames.shift()();
    const openPanel = document.getElementById(panelId);
    assert.equal(openPanel.getAttribute("aria-hidden"), "false");
    assert.equal(openPanel.getAttribute("data-motion"), "open");
    const openToggle = byClass(custom, `${sidebar.NAMESPACE}-course-toggle`)[0];
    openToggle.dispatchEvent({ type: "click" });
    assert.equal(openPanel.getAttribute("aria-hidden"), "true");
    assert.equal(openPanel.getAttribute("hidden"), null);
    openPanel.dispatchEvent({ type: "transitionend", propertyName: "opacity", target: openPanel.children[0] });
    assert.equal(openPanel.getAttribute("hidden"), null, "a bubbled child transition cannot complete the panel exit");
    openPanel.dispatchEvent({ type: "transitionend", propertyName: "opacity" });
    assert.equal(openPanel.getAttribute("hidden"), "");
});

test("sidebar disclosure CSS keeps hover, focus, motion hooks, and reduced-motion final states explicit", () => {
    const css = fs.readFileSync(path.join(__dirname, "../../css/sidebar.css"), "utf8");
    assert.match(css, /\.apstudycanvas-sidebar-section-toggle svg\s*\{[^}]*position:\s*absolute[^}]*inset-inline-start:\s*8px[^}]*opacity:\s*0/, "section arrows stay hidden at rest with BetterCampus-like inset");
    assert.match(css, /\.apstudycanvas-sidebar-section-head:hover \.apstudycanvas-sidebar-section-toggle svg,[\s\S]*opacity:\s*1/, "section arrows reveal for pointer and keyboard interaction");
    assert.match(css, /\.apstudycanvas-sidebar-section-head:hover \.apstudycanvas-sidebar-section-label,[\s\S]*transform:\s*translateX\(24px\)/, "labels make a padded 24px lane for the revealed arrow");
    assert.match(css, /data-courses-folded="true"\]\s*\{[^}]*grid-template-rows:\s*minmax\(76px,\s*max-content\) auto[^}]*align-content:\s*start/, "a folded Courses heading stays directly below Pages instead of dropping to the footer");
    assert.match(css, /\.apstudycanvas-sidebar-section-toggle:focus-visible,[\s\S]*outline:\s*2px solid var\(--apstudy-sidebar-focus-edge\)/);
    assert.match(css, /\.apstudycanvas-sidebar-page-list,\s*[\s\S]*\.apstudycanvas-sidebar-course-tabs\s*\{[\s\S]*transition:\s*opacity 160ms ease-in-out, clip-path 160ms ease-in-out, transform 160ms ease-in-out/);
    assert.match(css, /\.apstudycanvas-sidebar-course-tabs\[data-motion="closing"\][\s\S]*pointer-events:\s*none/);
    assert.match(css, /\.apstudycanvas-sidebar-page-list\[hidden\],[\s\S]*display:\s*none !important/);
    assert.match(css, /\.apstudycanvas-sidebar-section\s*\{[\s\S]*transition:\s*grid-template-rows 160ms ease-in-out/);
    assert.match(css, /\.apstudycanvas-sidebar-section\[data-folded="true"\],[\s\S]*grid-template-rows:\s*auto 0fr/);
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*transition-duration:\s*0\.01ms !important/);
});

test("shell allocation renders Pages, Courses, and footer simultaneously with independent list scrolling", async () => {
    const { document, root } = makeSidebarDocument();
    const pages = ["dashboard", "courses", "calendar", "inbox", "history", "help"].map((id) => ({ id, label: id, href: `/${id}`, available: true, iconRole: id }));
    const adapter = { async assemble() { return { identity: {}, route: {}, pages, pageOrder: pages.map((page) => page.id), pageVisibility: {}, courses: [{ id: "7", name: "Biology", href: "/courses/7" }], courseState: { status: "populated", retryable: false } }; } };
    const controller = sidebar.createSidebarController({ document, root, adapter, window: { innerWidth: 1309, innerHeight: 746, location: { href: "https://canvas.emory.edu/", origin: "https://canvas.emory.edu", pathname: "/" } } });
    controller.init({ better_sidebar: true, sidebar_expanded_width: 180 });
    await controller.refresh();
    const custom = document.getElementById(sidebar.ROOT_ID);
    assert.equal(byClass(custom, `${sidebar.NAMESPACE}-pages-section`).length, 1);
    assert.equal(byClass(custom, `${sidebar.NAMESPACE}-courses-section`).length, 1);
    assert.equal(byClass(custom, `${sidebar.NAMESPACE}-course-row`).length, 1);
    assert.equal(byClass(custom, `${sidebar.NAMESPACE}-footer`).length, 1);
    const middle = byClass(custom, `${sidebar.NAMESPACE}-middle`)[0];
    assert.equal(middle.getAttribute("data-pages-visible"), "true");
    assert.equal(middle.getAttribute("data-courses-visible"), "true");

    const css = fs.readFileSync(path.join(__dirname, "../../css/sidebar.css"), "utf8");
    assert.match(css, /#apstudycanvas-sidebar-root\s*\{[\s\S]*grid-template-rows:\s*72px minmax\(0,\s*1fr\) auto/);
    assert.match(css, /data-pages-visible="true"\]\[data-courses-visible="true"\][^\{]*\{\s*grid-template-rows:\s*minmax\(132px,\s*\.9fr\) minmax\(0,\s*1\.1fr\)/);
    assert.match(css, /\.apstudycanvas-sidebar-page-list\s*\{[^}]*overflow-y:\s*auto/);
    assert.match(css, /\.apstudycanvas-sidebar-course-list\s*\{[^}]*overflow-y:\s*auto/);
    assert.match(css, /\.apstudycanvas-sidebar-middle\s*\{[^}]*overflow:\s*hidden/);
    assert.match(css, /\.apstudycanvas-sidebar-footer\s*\{[^}]*min-height:\s*77px/);
});

test("BetterCampus-inspired rail geometry is encoded as structural CSS, including nested overflow safety", () => {
    const css = fs.readFileSync(path.join(__dirname, "../../css/sidebar.css"), "utf8");
    assert.match(css, /#apstudycanvas-sidebar-root\s*\{[\s\S]*display:\s*grid[\s\S]*grid-template-rows:\s*72px minmax\(0,\s*1fr\) auto/);
    assert.match(css, /\.apstudycanvas-sidebar-identity\s*\{[\s\S]*min-height:\s*72px[\s\S]*height:\s*72px/);
    assert.match(css, /\.apstudycanvas-sidebar-page-row,[\s\S]*min-height:\s*32px[\s\S]*padding:\s*6px 8px[\s\S]*border-radius:\s*8px/);
    assert.match(css, /#apstudycanvas-sidebar-root svg\.apstudycanvas-sidebar-icon\s*\{[\s\S]*display:\s*block\s*!important[\s\S]*fill:\s*none\s*!important[\s\S]*stroke:\s*currentColor\s*!important[\s\S]*visibility:\s*visible\s*!important/);
    assert.match(css, /#apstudycanvas-sidebar-root svg\.apstudycanvas-sidebar-icon\s*>\s*\.apstudycanvas-sidebar-icon-path\s*\{[\s\S]*stroke:\s*currentColor\s*!important/);
    const collisionRule = css.match(/#apstudycanvas-sidebar-root svg\.apstudycanvas-sidebar-icon\s*\{([^}]*)\}/)?.[1] || "";
    assert.doesNotMatch(collisionRule, /\b(?:width|height):[^;]*!important/, "Canvas collision dimensions must not be global");
    assert.match(css, /\.apstudycanvas-sidebar-page-icon\s*\{[\s\S]*flex:\s*0 0 var\(--apstudy-sidebar-icon-size, 16px\)[\s\S]*width:\s*var\(--apstudy-sidebar-icon-size, 16px\)[\s\S]*height:\s*var\(--apstudy-sidebar-icon-size, 16px\)/);
    assert.match(css, /\.apstudycanvas-sidebar-page-icon svg\s*\{[\s\S]*width:\s*100%\s*!important[\s\S]*height:\s*100%\s*!important/);
    assert.match(css, /\.apstudycanvas-sidebar-course-list\s*\{[\s\S]*min-width:\s*0[\s\S]*min-height:\s*0[\s\S]*overflow-x:\s*hidden[\s\S]*overflow-y:\s*auto/);
    assert.match(css, /\.apstudycanvas-sidebar-middle\s*\{[\s\S]*display:\s*grid[\s\S]*min-width:\s*0[\s\S]*min-height:\s*0[\s\S]*overflow:\s*hidden/);
    assert.match(css, /data-pages-visible="true"\]\[data-courses-visible="true"[^\{]*\{\s*grid-template-rows:\s*minmax\(132px,\s*\.9fr\) minmax\(0,\s*1\.1fr\)/);
    assert.match(css, /\.apstudycanvas-sidebar-courses-section\s*\{[\s\S]*min-width:\s*0[\s\S]*min-height:\s*28px[\s\S]*width:\s*100%[\s\S]*max-width:\s*100%[\s\S]*overflow:\s*hidden/);
    assert.match(css, /\.apstudycanvas-sidebar-page-item,[\s\S]*\.apstudycanvas-sidebar-course-item,[\s\S]*min-width:\s*0/);
    assert.match(css, /\.apstudycanvas-sidebar-page-item\[hidden\]\s*\{\s*display:\s*none\s*!important;\s*\}/, "saved-hidden page rows must override the base display rule");
    assert.match(css, /\.apstudycanvas-sidebar-course-row\s*\{[\s\S]*width:\s*100%[\s\S]*min-height:\s*32px/);
    assert.match(css, /\.apstudycanvas-sidebar-course-link\s*\{[\s\S]*min-width:\s*0[\s\S]*width:\s*100%[\s\S]*max-width:\s*100%[\s\S]*overflow:\s*hidden/);
    assert.match(css, /\.apstudycanvas-sidebar-course-name\s*\{[\s\S]*font-size:\s*var\(--apstudy-sidebar-label-size, 14px\)[\s\S]*line-height:\s*20px/);
    assert.match(css, /\.apstudycanvas-sidebar-course-tab\s*\{[\s\S]*min-width:\s*0[\s\S]*max-width:\s*100%[\s\S]*overflow:\s*hidden[\s\S]*text-overflow:\s*ellipsis[\s\S]*white-space:\s*nowrap/);
    assert.doesNotMatch(css, /\.apstudycanvas-sidebar-footer\s*\{[^}]*border-top/, "the fixed footer separates through rhythm, not a ruled border");
    assert.match(css, /\.apstudycanvas-sidebar-footer-action\.apstudycanvas-sidebar-product-entry\s*\{[\s\S]*justify-content:\s*center/);
    assert.match(css, /\.apstudycanvas-sidebar-footer-action\.apstudycanvas-sidebar-product-entry::before,[\s\S]*\.apstudycanvas-sidebar-footer-action\.apstudycanvas-sidebar-product-entry::after\s*\{[\s\S]*height:\s*1px/);
    assert.match(css, /\.apstudycanvas-sidebar-footer-action svg\s*\{[\s\S]*width:\s*16px[\s\S]*height:\s*16px/);
    assert.match(css, /\.apstudycanvas-sidebar-course-toggle\s*\{[\s\S]*flex:\s*0 0 24px[\s\S]*width:\s*24px[\s\S]*min-width:\s*24px[\s\S]*min-height:\s*24px[\s\S]*height:\s*24px/);
    assert.match(css, /\.apstudycanvas-sidebar-course-toggle svg\s*\{[\s\S]*width:\s*14px[\s\S]*height:\s*14px/);
    const expandedToggleRule = css.match(/\.apstudycanvas-sidebar-course-toggle svg\s*\{([^}]*)\}/)?.[1] || "";
    assert.doesNotMatch(expandedToggleRule, /var\(--apstudy-sidebar-icon-size\)/, "expanded disclosure size must ignore global scale");
    assert.doesNotMatch(expandedToggleRule, /\b(?:width|height):[^;]*!important/, "disclosure sizing stays component-local");
    assert.match(css, /#apstudycanvas-sidebar-root\.apstudycanvas-sidebar-collapsed \.apstudycanvas-sidebar-course-row\s*\{[\s\S]*min-height:\s*32px/);
    assert.match(css, /#apstudycanvas-sidebar-root\.apstudycanvas-sidebar-collapsed \.apstudycanvas-sidebar-course-toggle\s*\{[\s\S]*flex-basis:\s*24px[\s\S]*width:\s*24px[\s\S]*min-width:\s*24px[\s\S]*min-height:\s*24px[\s\S]*height:\s*24px/);
    assert.match(css, /#apstudycanvas-sidebar-root\.apstudycanvas-sidebar-collapsed \.apstudycanvas-sidebar-course-toggle svg\s*\{[\s\S]*width:\s*12px[\s\S]*height:\s*12px/);
    const collapsedToggleRule = css.match(/#apstudycanvas-sidebar-root\.apstudycanvas-sidebar-collapsed \.apstudycanvas-sidebar-course-toggle svg\s*\{([^}]*)\}/)?.[1] || "";
    assert.doesNotMatch(collapsedToggleRule, /var\(--apstudy-sidebar-icon-size\)/, "collapsed disclosure size must ignore global scale");
    assert.match(css, /--apstudy-sidebar-course-gap:\s*6px/);
    const courseListRules = Array.from(css.matchAll(/\.apstudycanvas-sidebar-course-list\s*\{([^}]*)\}/g), (match) => match[1]);
    assert.equal(courseListRules.length, 1, "course list has one dedicated sizing rule");
    const courseListRule = courseListRules[0] || "";
    assert.match(courseListRule, /gap:\s*var\(--apstudy-sidebar-course-gap\)/);
    assert.doesNotMatch(courseListRule, /--apstudy-sidebar-row-gap/);
    assert.match(css, /\.apstudycanvas-sidebar-course-list\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    assert.match(css, /\.apstudycanvas-sidebar-course-row\s*\{[\s\S]*display:\s*grid[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+24px[\s\S]*min-width:\s*0/);
    assert.match(css, /\.apstudycanvas-sidebar-course-link\s*\{[\s\S]*display:\s*grid[\s\S]*grid-template-columns:\s*8px\s+minmax\(0,\s*1fr\)[\s\S]*width:\s*100%[\s\S]*max-width:\s*100%/);
    assert.match(css, /\.apstudycanvas-sidebar-course-tabs\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\)[\s\S]*width:\s*calc\(100% - 20px\)[\s\S]*overflow-x:\s*hidden/);
    assert.match(css, /\.apstudycanvas-sidebar-course-tabs\s*>\s*li\s*\{[\s\S]*width:\s*100%[\s\S]*max-width:\s*100%/);
    assert.match(css, /\.apstudycanvas-sidebar-course-tabs\s*>\s*li\s*\{[\s\S]*overflow:\s*hidden/);
    assert.match(css, /\.apstudycanvas-sidebar-course-name\s*\{[\s\S]*display:\s*block[\s\S]*width:\s*100%[\s\S]*max-width:\s*100%/);
    assert.match(css, /\.apstudycanvas-sidebar-course-tab\s*\{[\s\S]*width:\s*100%[\s\S]*max-width:\s*100%[\s\S]*overflow:\s*hidden/);
    assert.match(css, /\.apstudycanvas-sidebar-course-retry\s*\{[\s\S]*width:\s*100%[\s\S]*max-width:\s*100%[\s\S]*overflow:\s*hidden/);
    const footerIconRule = css.match(/\.apstudycanvas-sidebar-footer-action svg\s*\{([^}]*)\}/)?.[1] || "";
    assert.match(footerIconRule, /width:\s*16px[\s\S]*height:\s*16px/);
    assert.doesNotMatch(footerIconRule, /var\(--apstudy-sidebar-icon-size\)/, "footer icons must ignore global scale");
    assert.match(css, /--apstudy-sidebar-surface-hover:\s*color-mix\(in srgb, var\(--apstudy-sidebar-text\) 8%, transparent\)/, "hover is a quiet 8% selection layer like the reference rail");
    assert.match(css, /\.apstudycanvas-sidebar-section-head\s*\{[\s\S]*display:\s*flex/);
    assert.match(css, /\.apstudycanvas-sidebar-section-head \.apstudycanvas-sidebar-section-toggle\s*\{[\s\S]*color:\s*var\(--apstudy-sidebar-text\)/);
    assert.match(css, /\.apstudycanvas-sidebar-section-label\s*\{[\s\S]*font-size:\s*var\(--apstudy-sidebar-label-size, 14px\)/);
    assert.match(css, /\.apstudycanvas-sidebar-section-toggle svg\s*\{[\s\S]*transform:\s*rotate\(90deg\)/);
    assert.match(css, /\.apstudycanvas-sidebar-section-toggle\[aria-expanded="false"\] svg\s*\{[\s\S]*transform:\s*rotate\(0deg\)/);
    assert.match(css, /\.apstudycanvas-sidebar-section-gear\s*\{[\s\S]*opacity:\s*0/);
    assert.match(css, /\.apstudycanvas-sidebar-section-head:hover \.apstudycanvas-sidebar-section-gear,[\s\S]*\.apstudycanvas-sidebar-section-head:focus-within \.apstudycanvas-sidebar-section-gear\s*\{[\s\S]*opacity:\s*1/);
    assert.match(css, /\.apstudycanvas-sidebar-edge\s*\{[\s\S]*width:\s*8px/);
    assert.match(css, /\.apstudycanvas-sidebar-edge::before\s*\{[\s\S]*width:\s*4px[\s\S]*background:\s*var\(--apstudy-sidebar-gold\)/);
    assert.match(css, /\.apstudycanvas-sidebar-edge::after\s*\{[\s\S]*content:\s*"Collapse Sidebar"/);
    assert.match(css, /#apstudycanvas-sidebar-root\[data-apstudycanvas-sidebar-state="collapsed"\] \.apstudycanvas-sidebar-edge::after\s*\{[\s\S]*content:\s*"Expand Sidebar"/);
    assert.match(css, /\.apstudycanvas-sidebar-recovery\s*\{[\s\S]*inset:\s*auto auto 24px 16px/, "the recovery control waits near the lower-left like the reference rail");
});

test("course rows keep a hard vertical floor and the Courses list remains the bounded scroll owner", () => {
    const css = fs.readFileSync(path.join(__dirname, "../../css/sidebar.css"), "utf8");
    const sharedRowRule = css.match(/\.apstudycanvas-sidebar-course-row\s*\{([^}]*)\}/)?.[1] || "";
    assert.match(sharedRowRule, /min-height:\s*32px/, "expanded course rows never render below the 32px reference row");
    assert.match(sharedRowRule, /flex-shrink:\s*0/, "course rows are never compressed by constrained ancestors");
    const gridRowRule = css.match(/\.apstudycanvas-sidebar-course-row\s*\{([^}]*display:\s*grid[^}]*)\}/)?.[1] || "";
    assert.match(gridRowRule, /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+24px/);
    assert.match(gridRowRule, /min-height:\s*32px/);
    assert.match(gridRowRule, /flex-shrink:\s*0/);
    assert.match(css, /#apstudycanvas-sidebar-root\.apstudycanvas-sidebar-collapsed \.apstudycanvas-sidebar-course-row\s*\{[^}]*min-height:\s*32px/, "the collapsed rail keeps the same row floor");

    const listRule = css.match(/\.apstudycanvas-sidebar-course-list\s*\{([^}]*)\}/)?.[1] || "";
    assert.match(listRule, /overflow-y:\s*auto/, "the course list is the bounded vertical scroll owner");
    assert.match(listRule, /overflow-x:\s*hidden/);
    assert.match(listRule, /min-height:\s*0/, "the list can shrink inside its grid track instead of overflowing the rail");
    assert.match(listRule, /block-size:\s*100%/, "the list is capped by its track, so entries scroll instead of growing the rail");
    assert.match(listRule, /overscroll-behavior:\s*contain/);
    assert.match(css, /\.apstudycanvas-sidebar-course-body\s*\{[^}]*grid-template-rows:\s*auto minmax\(0,\s*1fr\)/, "the body bounds the list with a shrinkable track");
    assert.match(css, /\.apstudycanvas-sidebar-course-list\s*\{[^}]*grid-row:\s*2/);
    assert.match(css, /\.apstudycanvas-sidebar-middle\[[^\]]*\][^\{]*data-courses-visible="true"[^\{]*\{\s*grid-template-rows:[^;]*minmax\(0,/);
});

test("rail courses mirror the displayed dashboard card evidence and exclude non-displayed enrollments", async () => {
    const { document, root } = makeSidebarDocument();
    const origin = "https://canvas.emory.edu";
    const requestedPaths = [];
    const fetchImpl = async (url) => {
        const pathname = new URL(url).pathname;
        requestedPaths.push(pathname);
        if (pathname === "/api/v1/courses") {
            return { status: 200, headers: {}, async json() {
                return [
                    { id: 42, name: "Biology", workflow_state: "available" },
                    { id: 43, name: "Hidden Chemistry", workflow_state: "available" },
                    { id: 44, name: "Statistics", workflow_state: "available" }
                ];
            } };
        }
        if (pathname === "/api/v1/users/self") return { status: 200, headers: {}, async json() { return { id: "123", name: "Student" }; } };
        if (pathname === "/api/v1/conversations/unread_count") return { status: 200, headers: {}, async json() { return {}; } };
        throw new Error(`Unexpected Canvas path: ${pathname}`);
    };
    const adapter = sidebarAdapter.createSidebarAdapter({ fetchImpl });
    const controller = sidebar.createSidebarController({
        document,
        root,
        adapter,
        window: { innerWidth: 1200, location: { href: `${origin}/`, origin, pathname: "/" } },
        // The dashboard actually displayed only Biology and Statistics; the
        // persisted displayed subset carries that evidence to the rail.
        displayedCardCache: { read: async () => ({ courseIds: ["42", "44"], savedAt: Date.now() }), write: async () => true }
    });
    controller.init({ better_sidebar: true });
    await controller.refresh();
    assert.equal(requestedPaths.includes("/api/v1/dashboard/dashboard_cards"), false, "the broad dashboard_cards menu endpoint is not card evidence and is never consulted");
    const custom = document.getElementById(sidebar.ROOT_ID);
    const links = byClass(custom, `${sidebar.NAMESPACE}-course-link`);
    assert.deepEqual(links.map((link) => link.getAttribute("href")), [`${origin}/courses/42`, `${origin}/courses/44`], "active displayed courses stay");
    assert.equal(allNodes(custom, (node) => String(node.textContent || "").includes("Hidden Chemistry")).length, 0, "enrollments without displayed dashboard cards never render");
    assert.deepEqual(controller.getModel().courses.map((course) => course.id), ["42", "44"]);
    assert.equal(controller.getModel().displayedCardSource, "cache");
    assert.equal(controller.getModel().courseState.status, "populated");
});

test("empty dashboard DOM converges to the hydrated card set without refetching courses", async () => {
    const { document, root } = makeSidebarDocument();
    const origin = "https://canvas.emory.edu";
    // The card container exists but Canvas has not hydrated any cards yet.
    const cards = new FakeNode("div", { id: "DashboardCard_Container" });
    document.body.appendChild(cards);
    // Discovery reads with querySelectorAll; the Fake DOM gains a traversal
    // rooted at the document element so the adapter observes real structure.
    document.querySelectorAll = (selector) => {
        const results = [];
        const visit = (node) => {
            node.childNodes?.forEach((child) => {
                if (child._matches?.(selector)) results.push(child);
                visit(child);
            });
        };
        visit(document.documentElement);
        return results;
    };
    let courseFetches = 0;
    const fetchImpl = async (url) => {
        const pathname = new URL(url).pathname;
        if (pathname === "/api/v1/courses") {
            courseFetches += 1;
            return { status: 200, headers: {}, async json() {
                return Array.from({ length: 12 }, (_, index) => ({ id: 100 + index, name: `Course ${index + 1}`, workflow_state: "available" }));
            } };
        }
        if (pathname === "/api/v1/users/self") return { status: 200, headers: {}, async json() { return { id: "123", name: "Student" }; } };
        if (pathname === "/api/v1/conversations/unread_count") return { status: 200, headers: {}, async json() { return {}; } };
        throw new Error(`Unexpected Canvas path: ${pathname}`);
    };
    const observerCallbacks = [];
    class FakeObserver {
        constructor(callback) { observerCallbacks.push(callback); }
        observe() {}
        disconnect() {}
    }
    const cacheWrites = [];
    const adapter = sidebarAdapter.createSidebarAdapter({ fetchImpl });
    const controller = sidebar.createSidebarController({
        document,
        root,
        adapter,
        window: { innerWidth: 1200, location: { href: `${origin}/`, origin, pathname: "/" }, MutationObserver: FakeObserver, setTimeout: () => 0, clearTimeout: () => {} },
        displayedCardCache: { read: async () => null, write: async (entry) => { cacheWrites.push(entry); return true; } }
    });
    controller.init({ better_sidebar: true });
    await controller.refresh();
    // No authoritative evidence at all: the rail falls open to the 12 active
    // enrollments, the model flags the evidence as pending, and the assembly
    // cost exactly one course fetch.
    assert.equal(controller.getModel().courses.length, 12, "without evidence the active ceiling keeps the rail useful");
    assert.equal(controller.getModel().displayedCardSource, "none");
    assert.equal(controller.getModel().displayedCardsPending, true);
    assert.equal(courseFetches, 1);
    assert.equal(observerCallbacks.length, 1, "pending evidence arms exactly one hydration watcher");
    // Canvas hydrates 8 of the 12 cards. The watcher reconciles from the
    // already-fetched active list: the displayed set narrows to the 8 real
    // cards, the authoritative ids persist, and no second fetch happens.
    Array.from({ length: 8 }, (_, index) => {
        const card = new FakeNode("div", { class: "ic-DashboardCard" });
        const link = new FakeNode("a", { href: `/courses/${100 + index}`, class: "ic-DashboardCard__link" });
        link.textContent = `Course ${index + 1}`;
        card.appendChild(link);
        cards.appendChild(card);
    });
    observerCallbacks[0]();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
        controller.getModel().courses.map((course) => course.id),
        ["100", "101", "102", "103", "104", "105", "106", "107"],
        "the rail converges to exactly the 8 displayed cards"
    );
    assert.equal(controller.getModel().displayedCardSource, "dom");
    assert.equal(controller.getModel().displayedCardsPending, false);
    assert.equal(courseFetches, 1, "convergence reuses the fetched active list instead of refetching");
    assert.equal(cacheWrites.at(-1)?.courseIds?.length, 8, "only the authoritative displayed ids persist");
    controller.dispose();
});

test("sidebar model changes notify the subscribed rail once per accepted model", async () => {
    const { document, root } = makeSidebarDocument();
    const origin = "https://canvas.emory.edu";
    const fetchImpl = async (url) => {
        const pathname = new URL(url).pathname;
        if (pathname === "/api/v1/courses") {
            return { status: 200, headers: {}, async json() {
                return [
                    { id: 42, name: "Biology", workflow_state: "available" },
                    { id: 44, name: "Statistics", workflow_state: "available" }
                ];
            } };
        }
        if (pathname === "/api/v1/users/self") return { status: 200, headers: {}, async json() { return { id: "123", name: "Student" }; } };
        if (pathname === "/api/v1/conversations/unread_count") return { status: 200, headers: {}, async json() { return {}; } };
        throw new Error(`Unexpected Canvas path: ${pathname}`);
    };
    const notifications = [];
    const adapter = sidebarAdapter.createSidebarAdapter({ fetchImpl });
    const controller = sidebar.createSidebarController({
        document,
        root,
        adapter,
        window: { innerWidth: 1200, location: { href: `${origin}/`, origin, pathname: "/" } },
        displayedCardCache: { read: async () => ({ courseIds: ["42", "44"], savedAt: Date.now() }), write: async () => true },
        onModelChange: (model) => notifications.push(model.courses.map((course) => course.id))
    });
    controller.init({ better_sidebar: true });
    await controller.refresh();
    assert.ok(notifications.length >= 1, "the rail subscription sees the model converge");
    assert.deepEqual(notifications.at(-1), ["42", "44"], "the final notification carries the authoritative displayed set");
    controller.dispose();
    // The wiring on the content.js side: notifications feed the rail's light
    // sync path, pause/route reset the cached view so a stale one can never
    // be replayed, and refresh captures the view it rendered.
    const contentSource = fs.readFileSync(path.join(__dirname, "../../js/content.js"), "utf8");
    assert.match(contentSource, /onModelChange: \(\) => \{ try \{ contentTodoIntegration\?\.syncSidebarCourses\?\.\(\); \} catch \(error\) \{\} \}/);
    assert.match(contentSource, /lastView = view;/);
    assert.match(contentSource, /function syncSidebarCourses\(\) \{/);
    assert.match(contentSource, /if \(signature === lastCourseSignature\) return;/);
    assert.match(contentSource, /syncSidebarCourses, getState/);
});

test("shared layout CSS includes workspace and tray offsets plus reduced-motion and print reset", () => {
    const css = fs.readFileSync(path.join(__dirname, "../../css/sidebar.css"), "utf8");
    assert.match(css, /--apstudy-sidebar-width/);
    assert.match(css, /html:has\(#apstudycanvas-sidebar-root\) #wrapper \{[\s\S]*margin-inline-start: var\(--apstudy-sidebar-width\)/);
    assert.match(css, /\.ic-Layout-wrapper,[\s\S]*margin-inline-start: 0 !important/);
    assert.match(css, /\.ic-app-nav-toggle-and-crumbs \{[\s\S]*padding-inline-start: var\(--apstudy-sidebar-width\)/);
    assert.match(css, /#breadcrumbs/);
    assert.match(css, /inset-inline-start: var\(--apstudy-sidebar-width\)/);
    assert.match(css, /\.apstudycanvas-sidebar-identity\s*\{[^}]*justify-content:\s*center/, "the profile picture is centered in the header");
    assert.match(css, /html\[data-apstudycanvas-sidebar-mounted="1"\] body > #nav-tray-portal > span > span\s*\{[^}]*left:\s*0\s*!important[^}]*max-inline-size:\s*100vw\s*!important[^}]*transition:\s*left 500ms/, "the tray panel base state sits at the viewport edge and glides with the rail");
    assert.doesNotMatch(css, /#nav-tray-portal\s*\{[^}]*z-index/, "the portal keeps Canvas's native stacking below the rail, so trays can never cover the sidebar");
    assert.match(css, /#nav-tray-portal \.navigation-tray-container\.profile-tray/, "the account tray keeps its content-fitting rules beside the courses tray");
    assert.match(css, /\.tray-with-space-for-global-nav\s*\{[^}]*margin-inline-start:\s*0\s*!important/, "the native icon-rail content offset is dropped under the mounted rail");
    assert.match(css, /:has\(#apstudycanvas-sidebar-root:not\(\.apstudycanvas-sidebar-overlay\)\.apstudycanvas-sidebar-expanded\)[\s\S]*:has\(#apstudycanvas-sidebar-root:not\(\.apstudycanvas-sidebar-overlay\)\.apstudycanvas-sidebar-collapsed\)[^\{]*body > #nav-tray-portal > span > span[^{]*\{[^}]*left:\s*var\(--apstudy-sidebar-width\)\s*!important[^}]*max-inline-size:\s*max\(0px, calc\(100vw - var\(--apstudy-sidebar-width\)\)\)\s*!important/, "expanded and collapsed rails shift the tray panel right of the rail");
    assert.match(css, /@media print[\s\S]*?#nav-tray-portal > span > span[^{]*\{[^}]*left:\s*0\s*!important[^}]*max-inline-size:\s*100vw\s*!important/);
    assert.match(css, /@media print[\s\S]*:has\(#apstudycanvas-sidebar-root:not\(\.apstudycanvas-sidebar-overlay\)\.apstudycanvas-sidebar-expanded\)[\s\S]*:has\(#apstudycanvas-sidebar-root:not\(\.apstudycanvas-sidebar-overlay\)\.apstudycanvas-sidebar-collapsed\)[\s\S]*inset-inline-start:\s*0\s*!important/);
    assert.doesNotMatch(css, /#nav-tray-portal[^\{]*\.(?:dialog|modal|generic)/, "tray contract must not target generic portals");
    assert.doesNotMatch(css, /#nav-tray-portal\s*>?\s*\.(?!navigation-tray-container\.(?:courses|profile)-tray|tray-with-space-for-global-nav)/, "unrelated tray portal children must remain untouched");
    const layoutContract = css.slice(0, css.indexOf("#apstudycanvas-sidebar-root {"));
    assert.doesNotMatch(layoutContract, /margin-left:/, "nested Canvas wrappers must not accumulate a second rail margin");
    assert.match(css, /inset-inline-start: 0 !important/);
    assert.match(css, /@media print/);
    assert.match(css, /prefers-reduced-motion/);
});

test("Courses tray CSS executes the width, hidden, recovery, print, overflow, and isolation state contract", () => {
    const css = fs.readFileSync(path.join(__dirname, "../../css/sidebar.css"), "utf8");
    const viewport = 1440;
    [
        { state: "expanded", width: 180 },
        { state: "expanded", width: 280 },
        { state: "collapsed", width: 86 },
        { state: "collapsed", width: 70 }
    ].forEach(({ state, width }) => {
        const style = evaluateCourseTrayCss(css, { target: "tray", mounted: true, state, width, viewport });
        assert.equal(style["left"], `${width}px`, `${state} ${width}px panel offset`);
        assert.equal(style["max-inline-size"], `${viewport - width}px`, `${state} ${width}px available width`);
        assert.equal(style["overflow-x"], "hidden");
    });
    assert.doesNotMatch(css, /#nav-tray-portal\s*\{[^}]*z-index/, "the portal keeps Canvas's native stacking below the rail, so trays can never cover the sidebar");

    const hidden = evaluateCourseTrayCss(css, { target: "tray", mounted: true, state: "hidden", width: 0, viewport });
    assert.equal(hidden["left"], "0");
    assert.equal(hidden["max-inline-size"], `${viewport}px`);
    const recovery = evaluateCourseTrayCss(css, { target: "tray", mounted: true, state: "expanded", overlay: true, width: 280, viewport });
    assert.equal(recovery["left"], "0");
    assert.equal(recovery["max-inline-size"], `${viewport}px`);

    const print = evaluateCourseTrayCss(css, { target: "tray", mounted: true, state: "expanded", width: 280, viewport, print: true });
    assert.equal(print["left"], "0");
    assert.equal(print["max-inline-size"], `${viewport}px`);
    assert.equal(print["overflow-x"], "hidden");

    const directChild = evaluateCourseTrayCss(css, { target: "direct-child", mounted: true, state: "expanded", width: 280, viewport });
    assert.equal(directChild["min-width"], "0");
    assert.equal(directChild["max-inline-size"], "100%");
    const content = evaluateCourseTrayCss(css, { target: "content", mounted: true, state: "expanded", width: 280, viewport });
    assert.equal(content["overflow-x"], "hidden");
    assert.equal(content["max-inline-size"], "100%");
    const link = evaluateCourseTrayCss(css, { target: "link", mounted: true, state: "expanded", width: 280, viewport });
    assert.equal(link["overflow-x"], "hidden");
    assert.equal(link["text-overflow"], "ellipsis");

    const genericDialog = { target: "generic-dialog", mounted: true, state: "expanded", width: 280, viewport };
    assert.deepEqual(evaluateCourseTrayCss(css, genericDialog), {}, "generic dialogs are not repositioned");
    const accidentallyBroad = `${css}\n#nav-tray-portal [role="dialog"], #nav-tray-portal .popover { inset-inline-start: var(--apstudy-sidebar-width) !important; }`;
    assert.equal(evaluateCourseTrayCss(accidentallyBroad, genericDialog)["inset-inline-start"], "280px", "the matcher must expose broad dialog/popover regressions");
    assert.deepEqual(evaluateCourseTrayCss(css, { target: "tray", mounted: false, state: "expanded", width: 280, viewport }), {});
});

test("real Canvas course navigation reserves its upstream width only beside a normal desktop APStudy rail", () => {
    const css = fs.readFileSync(path.join(__dirname, "../../css/sidebar.css"), "utf8");
    assert.match(css, /--apstudy-canvas-course-menu-width:\s*12rem/);
    assert.match(css, /@media screen and \(min-width:\s*768px\)/);

    [
        { state: "expanded", width: 280 },
        { state: "expanded", width: 180 },
        { state: "collapsed", width: 86 },
        { state: "collapsed", width: 70 }
    ].forEach(({ state, width }) => {
        const columns = evaluateCourseTrayCss(css, { target: "course-columns", mounted: true, state, width, viewport: 1440 });
        const menu = evaluateCourseTrayCss(css, { target: "course-menu", mounted: true, state, width, viewport: 1440 });
        assert.equal(columns["padding-inline-start"], "192px", `${state} preserves Canvas's 192px course-menu reservation`);
        assert.equal(columns.overflow, "visible");
        assert.equal(columns["max-inline-size"], "100%");
        assert.equal(menu.position, "absolute");
        assert.equal(menu["inset-inline-start"], "0");
        assert.equal(menu["inline-size"], "192px");
        assert.equal(width + Number.parseInt(menu["inset-inline-start"], 10), width, "course menu begins immediately after the APStudy rail");
        assert.equal(width + Number.parseInt(columns["padding-inline-start"], 10), width + 192, "content begins after both rails");
    });

    [
        { state: "hidden", width: 0, viewport: 1440 },
        { state: "expanded", width: 280, viewport: 1440, overlay: true },
        { state: "expanded", width: 280, viewport: 767 },
        { state: "expanded", width: 280, viewport: 1440, print: true },
        { state: "expanded", width: 280, viewport: 1440, mounted: false }
    ].forEach((scenario) => {
        assert.deepEqual(evaluateCourseTrayCss(css, { target: "course-columns", mounted: true, ...scenario }), {});
        assert.deepEqual(evaluateCourseTrayCss(css, { target: "course-menu", mounted: true, ...scenario }), {});
    });

    assert.deepEqual(evaluateCourseTrayCss(css, { target: "generic-dialog", mounted: true, state: "expanded", width: 280, viewport: 1440 }), {});
    assert.doesNotMatch(css, /(?:\[role=["']dialog["']\]|\.popover)[^{]*--apstudy-canvas-course-menu-width/);
});

test("Firefox minimum covers every advertised sidebar CSS and injection feature", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../../manifest.json"), "utf8"));
    const css = fs.readFileSync(path.join(__dirname, "../../css/sidebar.css"), "utf8");
    const minimum = Number.parseInt(manifest.browser_specific_settings?.gecko?.strict_min_version, 10);
    assert.ok(minimum >= 128, "MAIN content-script injection requires Firefox 128+");
    assert.match(css, /:has\(/, "the sidebar relies on :has() and must keep its advertised Firefox floor");
});

test("70px collapsed rails keep every control inside the rail without expanded horizontal constraints", () => {
    const css = fs.readFileSync(path.join(__dirname, "../../css/sidebar.css"), "utf8");
    const collapsed = css.slice(css.indexOf("#apstudycanvas-sidebar-root.apstudycanvas-sidebar-collapsed"), css.indexOf(".apstudycanvas-sidebar-footer {"));
    assert.match(collapsed, /\.apstudycanvas-sidebar-section-toggle \{[\s\S]*justify-content: center;[\s\S]*min-width: 0;[\s\S]*font-size: 0/);
    assert.match(css, /#apstudycanvas-sidebar-root\.apstudycanvas-sidebar-collapsed \.apstudycanvas-sidebar-footer-action \{[\s\S]*justify-content: center;[\s\S]*min-width: 0;[\s\S]*font-size: 0/);
    assert.match(css, /#apstudycanvas-sidebar-root > \* \{ min-width: 0; \}/);
    assert.match(css, /\.apstudycanvas-sidebar-footer \{[\s\S]*min-width: 0/);
    assert.match(css, /\.apstudycanvas-sidebar-course-link \{[^}]*min-width: 0/);
    assert.match(css, /\.apstudycanvas-sidebar-page-label\[aria-hidden="true"\] \{ display: none; \}/);
});

test("sidebar theme tokens keep a BetterCampus-like Nest navy shell coherent across Canvas modes", () => {
    const css = fs.readFileSync(path.join(__dirname, "../../css/sidebar.css"), "utf8");
    const rootTokens = css.slice(css.indexOf(":root {"), css.indexOf("}\n\n/* The wrapper"));
    const declaration = (name) => rootTokens.match(new RegExp(`${name.replace(/[.*+?^${}()|[\\]\\]/g, "\\\\$&")}\\s*:\\s*([^;]+);`))?.[1] || "";

    assert.equal(declaration("--apstudy-sidebar-navy"), "#002f6c");
    assert.equal(declaration("--apstudy-sidebar-surface"), "var(--apstudy-sidebar-navy)");
    assert.equal(declaration("--apstudy-sidebar-text"), "var(--apstudy-sidebar-on-dark)");
    assert.equal(declaration("--apstudy-sidebar-active"), "var(--apstudy-sidebar-parchment)");
    assert.doesNotMatch(rootTokens, /var\(--bc/, "the custom rail owns one coherent Nest shell instead of inheriting partial Canvas surfaces");
    assert.match(css, /html:has\(#darkcss\)\s*\{[\s\S]*--apstudy-sidebar-surface:\s*var\(--apstudy-sidebar-dark-navy\)/);
    assert.match(css, /--apstudy-sidebar-surface-raised:\s*var\(--apstudy-sidebar-dark-raised\)/);
    assert.match(css, /--apstudy-sidebar-color-scheme:\s*dark/);
    assert.match(css, /background:\s*var\(--apstudy-sidebar-surface\)/);
    assert.match(css, /background:\s*var\(--apstudy-sidebar-surface-hover\)/);
    assert.match(css, /background:\s*var\(--apstudy-sidebar-active\)/);
    assert.match(css, /border(?:-right|-top):\s*1px solid var\(--apstudy-sidebar-border\)/);
    assert.match(css, /scrollbar-color:\s*var\(--apstudy-sidebar-scrollbar\)/);
    assert.match(css, /color-scheme:\s*var\(--apstudy-sidebar-color-scheme\)/);
    assert.doesNotMatch(css, /#apstudycanvas-sidebar-root\s*\{[\s\S]*background:\s*var\(--apstudy-sidebar-navy\)/);
    assert.doesNotMatch(css, /MutationObserver|matchMedia/);
});

test("theme adaptation preserves focus, reduced-motion, print, and responsive state contracts", () => {
    const css = fs.readFileSync(path.join(__dirname, "../../css/sidebar.css"), "utf8");
    assert.match(css, /--apstudy-sidebar-focus-edge:\s*#ffffff/);
    assert.match(css, /outline:\s*2px solid var\(--apstudy-sidebar-gold\)/);
    assert.match(css, /box-shadow:\s*0 0 0 1px var\(--apstudy-sidebar-focus-edge\)/);
    assert.match(css, /@media print[\s\S]*--apstudy-sidebar-width: 0px !important/);
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
    assert.match(css, /apstudycanvas-sidebar-hidden[\s\S]*width: 0/);
    assert.match(css, /apstudycanvas-sidebar-recovery[\s\S]*width: 40px[\s\S]*height: 40px/);
});

test("active destination hover and focus preserve the contrast-safe active token pair", () => {
    const css = fs.readFileSync(path.join(__dirname, "../../css/sidebar.css"), "utf8");
    const activeInteraction = css.match(/#apstudycanvas-sidebar-root \.apstudycanvas-sidebar-page-row\.apstudycanvas-sidebar-active:hover,[\s\S]*?#apstudycanvas-sidebar-root \.apstudycanvas-sidebar-page-row\.apstudycanvas-sidebar-active:focus-visible,[\s\S]*?\{([^}]*)\}/)?.[1]
        || "";
    assert.match(activeInteraction, /color:\s*var\(--apstudy-sidebar-active-text\)/);
    assert.match(activeInteraction, /background:\s*var\(--apstudy-sidebar-active\)/);
    assert.doesNotMatch(activeInteraction, /surface-raised|surface-hover/);
    assert.match(css, /:root\s*\{[\s\S]*--apstudy-sidebar-active-text:\s*var\(--apstudy-sidebar-navy\)[\s\S]*--apstudy-sidebar-active:\s*var\(--apstudy-sidebar-parchment\)/);
    assert.match(css, /html:has\(#darkcss\)\s*\{[\s\S]*--apstudy-sidebar-active:\s*var\(--apstudy-sidebar-on-dark\)[\s\S]*--apstudy-sidebar-active-text:\s*var\(--apstudy-sidebar-dark-navy\)/);
    assert.match(css, /\.apstudycanvas-sidebar-page-row\.apstudycanvas-sidebar-active:hover,[\s\S]*\.apstudycanvas-sidebar-page-row\.apstudycanvas-sidebar-active:focus-visible/);
});

test("forced colors preserve system-color affordances for rail and recovery controls", () => {
    const css = fs.readFileSync(path.join(__dirname, "../../css/sidebar.css"), "utf8");
    const start = css.indexOf("@media (forced-colors: active)");
    const end = css.indexOf("@media print", start);
    assert.ok(start >= 0 && end > start, "forced-colors contract must be isolated before print rules");
    const forcedColors = css.slice(start, end);
    assert.match(forcedColors, /#apstudycanvas-sidebar-root\s*\{[\s\S]*forced-color-adjust:\s*none[\s\S]*color:\s*CanvasText[\s\S]*background:\s*Canvas[\s\S]*border-color:\s*CanvasText/);
    assert.match(forcedColors, /#apstudycanvas-sidebar-root a,[\s\S]*#apstudycanvas-sidebar-root a:visited\s*\{[\s\S]*color:\s*LinkText\s*!important/);
    assert.match(forcedColors, /#apstudycanvas-sidebar-root button,[\s\S]*background:\s*ButtonFace[\s\S]*border:\s*1px solid ButtonText/);
    assert.match(forcedColors, /\.apstudycanvas-sidebar-page-row\.apstudycanvas-sidebar-active,[\s\S]*color:\s*HighlightText\s*!important[\s\S]*background:\s*Highlight/);
    assert.match(forcedColors, /#apstudycanvas-sidebar-root :focus-visible,[\s\S]*outline:\s*2px solid Highlight[\s\S]*box-shadow:\s*0 0 0 2px Canvas/);
    assert.match(forcedColors, /\.apstudycanvas-sidebar-recovery\s*\{[\s\S]*display:\s*grid[\s\S]*color:\s*ButtonText[\s\S]*background:\s*ButtonFace[\s\S]*border:\s*2px solid ButtonText/);
    assert.match(forcedColors, /#apstudycanvas-sidebar-root\.apstudycanvas-sidebar-hidden\s*\{[\s\S]*width:\s*0[\s\S]*border:\s*0/);
});

test("an empty adapter route falls back to the current location and marks only the exact Courses destination", async () => {
    const { document, root } = makeSidebarDocument();
    const adapter = {
        async assemble() {
            return {
                identity: {},
                route: {},
                pages: [
                    { id: "courses", label: "Courses", href: "/courses", available: true, iconRole: "courses" },
                    { id: "course-fake", label: "Course fake", href: "/courseshelf", available: true, iconRole: "canvas" }
                ],
                pageOrder: ["courses", "course-fake"],
                pageVisibility: {},
                courses: []
            };
        }
    };
    const window = { innerWidth: 1200, location: { href: "https://canvas.emory.edu/courses", origin: "https://canvas.emory.edu", pathname: "/courses" } };
    const controller = sidebar.createSidebarController({ document, window, root, adapter });
    controller.init({ better_sidebar: true });
    await controller.refresh();
    const custom = document.getElementById(sidebar.ROOT_ID);
    const courses = allNodes(custom, (node) => node.getAttribute?.("data-page-id") === "courses")[0];
    const fake = allNodes(custom, (node) => node.getAttribute?.("data-page-id") === "course-fake")[0];
    assert.equal(courses.getAttribute("aria-current"), "page");
    assert.equal(fake.getAttribute("aria-current"), null);
});

test("latest async adapter refresh wins and aborts an older course request", async () => {
    const { document, root } = makeSidebarDocument();
    const window = { innerWidth: 1200, location: { href: "https://canvas.emory.edu/", origin: "https://canvas.emory.edu", pathname: "/" } };
    let assembleCount = 0;
    let abortCount = 0;
    let releaseFirst;
    const account = { origin: "https://canvas.emory.edu", userId: "123", accountKey: "a".repeat(64) };
    const makeModel = (id, name) => ({ identity: account, account, route: {}, pages: [{ id: "dashboard", label: "Dashboard", href: "https://canvas.emory.edu/", available: true, iconRole: "dashboard" }], pageOrder: ["dashboard"], pageVisibility: {}, courses: [{ id, name, href: `https://canvas.emory.edu/courses/${id}` }], courseOrder: [id], courseState: { status: "populated", retryable: false, reason: null } });
    const adapter = {
        async resolveIdentity() { return { identity: account, account, apiUser: { id: "123", name: "Student" } }; },
        assemble({ signal } = {}) {
            assembleCount += 1;
            if (assembleCount === 1) return new Promise((resolve, reject) => {
                releaseFirst = () => resolve(makeModel("1", "Stale course"));
                signal?.addEventListener?.("abort", () => {
                    abortCount += 1;
                    const error = new Error("aborted");
                    error.name = "AbortError";
                    reject(error);
                }, { once: true });
            });
            return Promise.resolve(makeModel("2", "Current course"));
        }
    };
    const controller = sidebar.createSidebarController({ document, window, root, adapter });
    controller.init({ better_sidebar: true });
    const first = controller.refresh();
    await new Promise((resolve) => setImmediate(resolve));
    const second = controller.refresh();
    await second;
    await first;
    releaseFirst?.();
    assert.equal(abortCount, 1);
    assert.deepEqual(controller.getModel().courses.map((course) => course.id), ["2"]);
    assert.equal(controller.getModel().courseState.status, "populated");
});

test("verified course progress renders before the slower sidebar model settles", async () => {
    const { document, root } = makeSidebarDocument();
    const origin = "https://canvas.emory.edu";
    let releaseAssembly;
    const account = { origin, userId: "123", accountKey: "a".repeat(64) };
    const adapter = {
        assemble({ onCourses } = {}) {
            onCourses?.({ status: "populated", retryable: false, reason: null, courses: [{ id: "42", name: "Biology", href: `${origin}/courses/42` }] });
            return new Promise((resolve) => { releaseAssembly = resolve; });
        }
    };
    const controller = sidebar.createSidebarController({ document, root, adapter, window: { innerWidth: 1200, location: { href: `${origin}/`, origin, pathname: "/" } } });
    controller.init({ better_sidebar: true });
    const pending = controller.refresh();
    await new Promise((resolve) => setImmediate(resolve));
    const custom = document.getElementById(sidebar.ROOT_ID);
    assert.deepEqual(byClass(custom, `${sidebar.NAMESPACE}-course-row`).map((row) => row.querySelector(`.${sidebar.NAMESPACE}-course-link`)?.getAttribute("href")), [`${origin}/courses/42`]);
    releaseAssembly({ identity: account, account, route: {}, pages: [{ id: "dashboard", label: "Dashboard", href: `${origin}/`, available: true, iconRole: "dashboard" }], pageOrder: ["dashboard"], pageVisibility: {}, courses: [{ id: "42", name: "Biology", href: `${origin}/courses/42` }], courseOrder: ["42"], courseState: { status: "populated", retryable: false, reason: null } });
    await pending;
    assert.deepEqual(controller.getModel().courses.map((course) => course.id), ["42"]);
});

test("dead Dashboard History and Help routes never render or become active, while one canonical page does", async () => {
    const { document, root } = makeSidebarDocument();
    const origin = "https://canvas.emory.edu";
    const pages = [
        { id: "dashboard", label: "Dashboard", href: `${origin}/`, available: true, iconRole: "dashboard" },
        { id: "history-dead", label: "History dead", href: "#", available: true, iconRole: "history" },
        { id: "help-dead", label: "Help dead", href: "javascript:void(0)", available: true, iconRole: "help" },
        { id: "help-unavailable", label: "Help unavailable", href: `${origin}/help`, available: false, iconRole: "help" },
        { id: "history", label: "History", href: `${origin}/users/self/history`, available: true, iconRole: "history" },
        { id: "help", label: "Help", href: `${origin}/help`, available: true, iconRole: "help" }
    ];
    const adapter = { async assemble() { return { identity: {}, route: sidebarAdapter.parseCanvasRoute(`${origin}/users/self/history`), pages, pageOrder: pages.map((page) => page.id), pageVisibility: {}, courses: [], courseState: { status: "empty" } }; } };
    const controller = sidebar.createSidebarController({ document, root, adapter, window: { innerWidth: 1200, location: { href: `${origin}/users/self/history`, origin, pathname: "/users/self/history" } } });
    controller.init({ better_sidebar: true });
    await controller.refresh();
    const custom = document.getElementById(sidebar.ROOT_ID);
    const links = byClass(custom, `${sidebar.NAMESPACE}-page-row`);
    assert.deepEqual(links.map((link) => link.getAttribute("data-page-id")), ["dashboard", "history", "help"]);
    assert.deepEqual(links.filter((link) => link.getAttribute("aria-current") === "page").map((link) => link.getAttribute("data-page-id")), ["history"]);
    for (const link of links) {
        assert.ok(link.querySelector(`.${sidebar.NAMESPACE}-page-icon`));
        assert.ok(link.querySelector(`.${sidebar.NAMESPACE}-page-label`)?.textContent);
    }
    controller.apply({ better_sidebar: true, sidebar_preferred_state: "collapsed", sidebar_collapsed_labels: true });
    assert.equal(custom.classList.contains(`${sidebar.NAMESPACE}-collapsed`), true);
    assert.equal(byClass(custom, `${sidebar.NAMESPACE}-page-label`).every((label) => label.getAttribute("aria-hidden") !== "true"), true);
});

test("page link states explicitly preserve icon and label visibility in light and dark shells", () => {
    const css = fs.readFileSync(path.join(__dirname, "../../css/sidebar.css"), "utf8");
    assert.match(css, /#apstudycanvas-sidebar-root a,\s*#apstudycanvas-sidebar-root a:link,\s*#apstudycanvas-sidebar-root a:visited\s*\{[^}]*color:\s*inherit\s*!important/);
    assert.match(css, /#apstudycanvas-sidebar-root \.apstudycanvas-sidebar-page-row,\s*#apstudycanvas-sidebar-root \.apstudycanvas-sidebar-page-row:link,\s*#apstudycanvas-sidebar-root \.apstudycanvas-sidebar-page-row:visited\s*\{[^}]*color:\s*var\(--apstudy-sidebar-text\)\s*!important/);
    assert.match(css, /\.apstudycanvas-sidebar-page-row \.apstudycanvas-sidebar-page-icon,[\s\S]*opacity:\s*1\s*!important;[\s\S]*visibility:\s*visible\s*!important/);
    assert.match(css, /\.apstudycanvas-sidebar-page-row\.apstudycanvas-sidebar-active,[\s\S]*:visited\s*\{[^}]*color:\s*var\(--apstudy-sidebar-active-text\)\s*!important/);
    assert.match(css, /\.apstudycanvas-sidebar-page-row\.apstudycanvas-sidebar-active:hover,[\s\S]*:focus-visible\s*\{[^}]*color:\s*var\(--apstudy-sidebar-active-text\)\s*!important/);
    assert.match(css, /html:has\(#darkcss\)[\s\S]*--apstudy-sidebar-active-text:\s*var\(--apstudy-sidebar-dark-navy\)/);
});

test("adapter-through-renderer history reproduction keeps placeholders out and assigns one canonical active page", async () => {
    const { document, root, items } = makeSidebarDocument();
    items.history.setAttribute("href", "/users/self/history");
    items.help.setAttribute("href", "#");
    const origin = "https://canvas.emory.edu";
    const adapter = {
        async assemble() {
            const pages = sidebarAdapter.discoverPages({ document, location: { origin, pathname: "/users/self/history" } });
            return {
                identity: {}, account: { origin, userId: "7", accountKey: "a".repeat(64) },
                route: sidebarAdapter.parseCanvasRoute(`${origin}/users/self/history`),
                pages, pageOrder: pages.map((page) => page.id), pageVisibility: {}, courses: [],
                courseState: { status: "empty", retryable: false, reason: null }
            };
        }
    };
    const controller = sidebar.createSidebarController({ document, root, adapter, window: { innerWidth: 1200, location: { href: `${origin}/users/self/history`, origin, pathname: "/users/self/history" } } });
    controller.init({ better_sidebar: true });
    await controller.refresh();
    const links = byClass(document.getElementById(sidebar.ROOT_ID), `${sidebar.NAMESPACE}-page-row`);
    assert.equal(links.some((link) => link.getAttribute("data-page-id") === "help"), false);
    assert.deepEqual(links.filter((link) => link.getAttribute("aria-current") === "page").map((link) => link.getAttribute("data-page-id")), ["history"]);
});

test("account changes clear old courses during the identity probe while preserving the section shell", async () => {
    const { document, root } = makeSidebarDocument();
    const origin = "https://canvas.emory.edu";
    const accountA = "a".repeat(64);
    const accountB = "b".repeat(64);
    let account = accountA;
    let releaseAssembly;
    const adapter = {
        async resolveIdentity() { return { identity: { origin, userId: account, accountKey: account }, account: { origin, userId: account, accountKey: account }, apiUser: { id: account } }; },
        assemble() {
            if (account === accountB) return new Promise((resolve) => { releaseAssembly = resolve; });
            return Promise.resolve({ identity: { origin, userId: accountA, accountKey: accountA }, account: { origin, userId: accountA, accountKey: accountA }, route: {}, pages: [{ id: "dashboard", label: "Dashboard", href: `${origin}/`, available: true, iconRole: "dashboard" }], pageOrder: ["dashboard"], pageVisibility: {}, courses: [{ id: "1", name: "Biology", href: `${origin}/courses/1` }], courseState: { status: "populated" } });
        }
    };
    const controller = sidebar.createSidebarController({ document, root, adapter, window: { innerWidth: 1200, location: { href: `${origin}/`, origin, pathname: "/" } } });
    controller.init({ better_sidebar: true });
    await controller.refresh();
    account = accountB;
    const pending = controller.refresh();
    await new Promise((resolve) => setImmediate(resolve));
    const custom = document.getElementById(sidebar.ROOT_ID);
    assert.equal(byClass(custom, `${sidebar.NAMESPACE}-courses-section`).length, 1);
    assert.equal(byClass(custom, `${sidebar.NAMESPACE}-course-row`).length, 0);
    assert.equal(byClass(custom, `${sidebar.NAMESPACE}-course-status-loading`).length, 1);
    releaseAssembly({ identity: { origin, userId: accountB, accountKey: accountB }, account: { origin, userId: accountB, accountKey: accountB }, route: {}, pages: [{ id: "dashboard", label: "Dashboard", href: `${origin}/`, available: true, iconRole: "dashboard" }], pageOrder: ["dashboard"], pageVisibility: {}, courses: [], courseState: { status: "empty" } });
    await pending;
    assert.equal(controller.getModel().account.accountKey, accountB);
});

test("same-account background refresh storms preserve populated courses until the newest model lands", async () => {
    const { document, root } = makeSidebarDocument();
    const origin = "https://canvas.emory.edu";
    const pending = [];
    let calls = 0;
    const makeModel = (accountKey, id, name) => ({
        identity: { origin, userId: accountKey, accountKey }, account: { origin, userId: accountKey, accountKey }, route: {},
        pages: [{ id: "dashboard", label: "Dashboard", href: `${origin}/`, available: true, iconRole: "dashboard" }], pageOrder: ["dashboard"], pageVisibility: {},
        courses: [{ id, name, href: `${origin}/courses/${id}` }], courseOrder: [id], courseState: { status: "populated", retryable: false }
    });
    const adapter = { assemble() { calls += 1; if (calls === 1) return Promise.resolve(makeModel("account-a", "1", "Biology")); return new Promise((resolve) => pending.push(resolve)); } };
    const controller = sidebar.createSidebarController({ document, root, adapter, window: { innerWidth: 1200, location: { href: `${origin}/`, origin, pathname: "/" } } });
    controller.init({ better_sidebar: true });
    await controller.refresh();
    const custom = document.getElementById(sidebar.ROOT_ID);
    const second = controller.refresh();
    const third = controller.refresh();
    assert.equal(byClass(custom, `${sidebar.NAMESPACE}-course-row`).length, 1);
    assert.equal(byClass(custom, `${sidebar.NAMESPACE}-course-status-loading`).length, 0);
    assert.equal(byClass(custom, `${sidebar.NAMESPACE}-course-body`)[0].getAttribute("aria-busy"), "false");
    pending[1](makeModel("account-a", "2", "Chemistry"));
    await third;
    pending[0](makeModel("account-a", "9", "Stale"));
    await second;
    assert.deepEqual(controller.getModel().courses.map((course) => course.name), ["Chemistry"]);
    assert.equal(byClass(custom, `${sidebar.NAMESPACE}-course-status-loading`).length, 0);
    assert.equal(byClass(custom, `${sidebar.NAMESPACE}-course-row`).length, 1);
});

test("account changes replace cached course data without accepting stale same-origin responses", async () => {
    const { document, root } = makeSidebarDocument();
    const origin = "https://canvas.emory.edu";
    let account = "account-a";
    const adapter = { async assemble() { const id = account === "account-a" ? "1" : "2"; return { identity: { origin, userId: account, accountKey: account }, account: { origin, userId: account, accountKey: account }, route: {}, pages: [{ id: "dashboard", label: "Dashboard", href: `${origin}/`, available: true }], pageOrder: ["dashboard"], pageVisibility: {}, courses: [{ id, name: `Course ${account}`, href: `${origin}/courses/${id}` }], courseState: { status: "populated" } }; } };
    const controller = sidebar.createSidebarController({ document, root, adapter, window: { innerWidth: 1200, location: { href: `${origin}/`, origin, pathname: "/" } } });
    controller.init({ better_sidebar: true });
    await controller.refresh();
    account = "account-b";
    await controller.refresh();
    assert.equal(controller.getModel().account.accountKey, "account-b");
    assert.deepEqual(controller.getModel().courses.map((course) => course.id), ["2"]);
});

test("stylesheet loss fails closed without teardown: custom hides, native remains semantically visible, and offsets have no inline target mutation", () => {
    const { document, root } = makeSidebarDocument();
    const wrapper = new FakeNode("div", { id: "wrapper", style: "margin-left:7px;" });
    document.body.appendChild(wrapper);
    const controller = sidebar.createSidebarController({ document, root, window: { innerWidth: 1200, location: { href: "https://canvas.emory.edu/", origin: "https://canvas.emory.edu", pathname: "/" } } });
    controller.init({ better_sidebar: true });
    const custom = document.getElementById(sidebar.ROOT_ID);
    assert.equal(custom.style.display, "none", "inline fail-closed state survives extension context death");
    assert.equal(custom.getAttribute("hidden"), null, "the enabled CSS override does not remove navigation from the accessibility tree");
    assert.equal(custom.getAttribute("role"), "navigation");
    assert.equal(root.getAttribute("hidden"), null);
    assert.equal(root.getAttribute("aria-hidden"), null);
    assert.equal(root.style.display, undefined);
    assert.equal(root.style.visibility, undefined);
    assert.equal(document.querySelector('link[rel="stylesheet"][data-apstudycanvas-sidebar]'), null, "sidebar CSS is manifest/runtime injected, never a persistent DOM link");
    assert.equal(custom.style.display, "none");
    assert.equal(root.getAttribute("hidden"), null);
    assert.equal(root.getAttribute("aria-hidden"), null);
    assert.equal(wrapper.getAttribute("style"), "margin-left:7px;", "controller never writes Canvas offset styles inline");
    const css = fs.readFileSync(path.join(__dirname, "../../css/sidebar.css"), "utf8");
    assert.match(css, /#apstudycanvas-sidebar-root\s*\{[\s\S]*display:\s*grid\s*!important/);
    assert.match(css, /#global_nav\.apstudycanvas-sidebar-hidden,[\s\S]*display:\s*none\s*!important/);
    controller.reset();
    assert.equal(document.getElementById(sidebar.ROOT_ID), null);
    assert.equal(root.classList.contains(`${sidebar.NAMESPACE}-hidden`), false);
});

test("the Sidebar SETTINGS_UPDATE validator accepts and clamps live sidebar values", () => {
    const result = sidebar.validateSettingsUpdateRequest({
        version: 1,
        request_id: "sidebar-validate-ok",
        type: "SETTINGS_UPDATE",
        payload: {
            area: "sync",
            changes: {
                better_sidebar: true,
                sidebar_expanded_width: 9999,
                sidebar_collapsed_width: 1,
                sidebar_density: "comfortable",
                sidebar_page_order: ["courses", "dashboard", "calendar", "inbox", "history", "help", "apstudy:planner", "apstudy:notes", "apstudy:grades", "apstudy:study"],
                sidebar_page_visibility: { dashboard: false, courses: true, calendar: true, inbox: true, history: true, help: true, "apstudy:planner": true, "apstudy:notes": true, "apstudy:grades": true, "apstudy:study": true },
                sidebar_preferred_state: "collapsed"
            }
        }
    });
    assert.equal(result.ok, true);
    assert.equal(result.requestId, "sidebar-validate-ok");
    assert.deepEqual(result.payload.changes, {
        better_sidebar: true,
        sidebar_expanded_width: 320,
        sidebar_collapsed_width: 48,
        sidebar_density: "comfortable",
        sidebar_page_order: ["courses", "dashboard", "calendar", "inbox", "history", "help", "apstudy:planner", "apstudy:notes", "apstudy:grades", "apstudy:study"],
        sidebar_page_visibility: { dashboard: false, courses: true, calendar: true, inbox: true, history: true, help: true, "apstudy:planner": true, "apstudy:notes": true, "apstudy:grades": true, "apstudy:study": true },
        sidebar_preferred_state: "collapsed"
    }, "numeric widths clamp to the same bounds the storage seam enforces");
});

test("the Sidebar SETTINGS_UPDATE validator rejects malformed requests and values", () => {
    const base = { type: "SETTINGS_UPDATE", payload: { area: "sync", changes: {} } };
    assert.equal(sidebar.validateSettingsUpdateRequest(null).ok, false);
    assert.equal(sidebar.validateSettingsUpdateRequest({ type: "OTHER" }).code, "SETTINGS_MESSAGE_INVALID");
    assert.equal(sidebar.validateSettingsUpdateRequest({ type: "SETTINGS_UPDATE", payload: { area: "local", changes: {} } }).code, "SETTINGS_PAYLOAD_INVALID");
    assert.equal(sidebar.validateSettingsUpdateRequest({ ...base, payload: { area: "sync", changes: [] } }).code, "SETTINGS_PAYLOAD_INVALID");

    const invalid = (changes) => sidebar.validateSettingsUpdateRequest({ type: "SETTINGS_UPDATE", payload: { area: "sync", changes } });
    assert.equal(invalid({ sidebar_preferred_state: "sideways" }).code, "SETTINGS_VALUE_INVALID");
    assert.equal(invalid({ better_sidebar: "yes" }).code, "SETTINGS_VALUE_INVALID");
    assert.equal(invalid({ sidebar_page_order: "dashboard" }).code, "SETTINGS_VALUE_INVALID");
    assert.equal(invalid({ sidebar_page_visibility: { dashboard: "true" } }).code, "SETTINGS_VALUE_INVALID");
    assert.equal(invalid({ sidebar_page_labels: "Courses" }).code, "SETTINGS_VALUE_INVALID");
    assert.equal(invalid({ sidebar_section_visibility: true }).code, "SETTINGS_KEY_UNSUPPORTED");
    assert.equal(invalid({ assignments_due: true }).code, "SETTINGS_KEY_UNSUPPORTED", "non-sidebar keys stay on the settings-apply path");

    const empty = sidebar.validateSettingsUpdateRequest({ type: "SETTINGS_UPDATE", payload: { area: "sync", changes: {} } });
    assert.equal(empty.ok, true);
    assert.deepEqual(empty.payload.changes, {});
});

test("the Sidebar validator's key set matches the settings-apply sidebar split exactly", () => {
    const settingsApply = require("../../js/content/settings-apply.js");
    const routed = new Set(settingsApply.LIVE_APPLY_GROUPS.sidebar);
    assert.deepEqual(
        Array.from(sidebar.SIDEBAR_VALIDATABLE_KEYS).sort(),
        Array.from(routed).sort(),
        "a key routed to the sidebar validator must be accepted, and vice versa"
    );
});

test("settings-apply delegates sidebar values to the real Sidebar module in mixed updates", () => {
    const settingsApply = require("../../js/content/settings-apply.js");
    const mixed = settingsApply.validateSettingsUpdateRequest({
        type: "SETTINGS_UPDATE",
        payload: { area: "sync", changes: { dark_mode: true, sidebar_expanded_width: 9999, sidebar_logo_visible: false } }
    }, { validateSidebar: sidebar.validateSettingsUpdateRequest });
    assert.equal(mixed.ok, true);
    assert.equal(mixed.payload.changes.sidebar_expanded_width, 320, "the sidebar subset is validated and clamped, not passed through");
    assert.equal(mixed.payload.changes.sidebar_logo_visible, false);
    assert.deepEqual(mixed.payload.reloadKeys, []);

    const rejected = settingsApply.validateSettingsUpdateRequest({
        type: "SETTINGS_UPDATE",
        payload: { area: "sync", changes: { dark_mode: true, sidebar_page_order: "nope" } }
    }, { validateSidebar: sidebar.validateSettingsUpdateRequest });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.code, "SETTINGS_VALUE_INVALID");
});
