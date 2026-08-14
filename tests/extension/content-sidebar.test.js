"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const sidebar = require("../../js/content/sidebar.js");

class FakeNode {
    constructor(tagName = "div", attributes = {}) {
        this.tagName = tagName.toUpperCase();
        this.nodeType = 1;
        this.parentNode = null;
        this.parentElement = null;
        this.childNodes = [];
        this.textContent = "";
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

    _matches(selector) {
        const trimmed = selector.trim();
        if (!trimmed) return false;
        if (trimmed.includes(",")) return trimmed.split(",").some((part) => this._matches(part));
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
        this.documentElement.appendChild(this.head);
    }

    createElement(tagName) { return new FakeNode(tagName); }
    getElementById(id) { return this.documentElement.querySelector(`#${id}`); }
    querySelector(selector) { return this.documentElement.querySelector(selector); }
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

test("sidebar applies every safe setting, canonicalizes order, and leaves unknown Canvas links after known links", () => {
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
    assert.equal(root.classList.contains(`${sidebar.NAMESPACE}-compact`), true);
    assert.equal(root.classList.contains(`${sidebar.NAMESPACE}-collapsed`), true);
    assert.equal(root.getAttribute("data-apstudycanvas-sidebar-mode"), "course");
    assert.equal(root.style["--apstudycanvas-sidebar-expanded-width"], "320px");
    assert.equal(root.style["--apstudycanvas-sidebar-collapsed-width"], "64px");
    assert.equal(root.style["--apstudycanvas-sidebar-icon-size"], "22px");
    assert.equal(root.style["--apstudycanvas-sidebar-label-size"], "15px");
    assert.equal(logo.classList.contains(`${sidebar.NAMESPACE}-logo-hidden`), true);
    assert.equal(items.dashboard.parentNode.getAttribute("hidden"), "");
    assert.equal(items.dashboard.parentNode.getAttribute("aria-hidden"), "true");
    assert.equal(items.dashboard.getAttribute("title"), "Dashboard");
    assert.equal(items.dashboard.getAttribute("aria-label"), "Dashboard");
    assert.deepEqual(listIds(list), [
        "global_nav_courses_link", "global_nav_dashboard_link", "global_nav_calendar_link",
        "global_nav_conversations_link", "global_nav_history_link", "global_nav_help_link", "native-unknown"
    ]);
    assert.deepEqual(sidebar.normalizeOrder(["courses", "courses", "unknown", "dashboard"]), ["courses", "dashboard", "calendar", "inbox", "history", "help"]);
});

test("storage changes reapply live and reset restores the exact native root, item, logo, style, and order snapshot", () => {
    const { document, root, logo, list, items } = makeSidebarDocument();
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
    assert.equal(items.dashboard.parentNode.getAttribute("hidden"), "");

    controller.reset();
    assert.deepEqual(attrs(root), initial.root);
    assert.deepEqual(attrs(logo), initial.logo);
    assert.deepEqual(listIds(list), initial.list);
    Object.entries(items).forEach(([key, node]) => {
        assert.deepEqual(attrs(node), initial.items[key].node, key);
        assert.deepEqual(attrs(node.parentNode), initial.items[key].item, key);
    });
    assert.equal(document.getElementById(sidebar.STYLE_ID), null);
    assert.equal(root.getAttribute(sidebar.MARKER), null);

    controller.init({ better_sidebar: true });
    assert.equal(root.getAttribute(sidebar.MARKER), "1", "re-enable recaptures current native DOM");
    controller.dispose();
    assert.equal(root.getAttribute(sidebar.MARKER), null);
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
    assert.match(source, /guarded setup calls below cannot\n\s*\/\/ create the retired/);
    assert.doesNotMatch(source, /chrome\.storage\.onChanged\.addListener\(applyOptionsChanges\)/);
});
