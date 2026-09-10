"use strict";

/* Small DOM fixture for compatibility contracts that do not need a browser CSS
 * engine. It deliberately models Canvas replacement portals and APStudy-owned
 * siblings, rather than flattening every surface into a selector string. */
class Node {
    constructor(tagName = "div") {
        this.tagName = String(tagName).toUpperCase();
        this.parentNode = null;
        this.childNodes = [];
        this.attributes = new Map();
        this.className = "";
        this.id = "";
        this.textContent = "";
    }

    append(...nodes) { nodes.filter(Boolean).forEach((node) => this.appendChild(node)); }
    appendChild(node) { node.remove?.(); node.parentNode = this; this.childNodes.push(node); return node; }
    remove() {
        if (!this.parentNode) return;
        this.parentNode.childNodes = this.parentNode.childNodes.filter((node) => node !== this);
        this.parentNode = null;
    }
    setAttribute(name, value) {
        const normalized = String(name);
        const stringValue = String(value);
        this.attributes.set(normalized, stringValue);
        if (normalized === "id") this.id = stringValue;
        if (normalized === "class") this.className = stringValue;
    }
    getAttribute(name) { return this.attributes.get(String(name)) ?? null; }
    removeAttribute(name) {
        const normalized = String(name);
        this.attributes.delete(normalized);
        if (normalized === "id") this.id = "";
        if (normalized === "class") this.className = "";
    }
}

class Document {
    constructor() {
        this.documentElement = new Node("html");
        this.body = new Node("body");
        this.documentElement.append(this.body);
    }

    createElement(tagName) { return new Node(tagName); }
    querySelector(selector) {
        if (selector === "#darkcss") return walk(this.documentElement).find((node) => node.id === "darkcss") || null;
        return null;
    }
}

function walk(node) { return node ? [node, ...node.childNodes.flatMap(walk)] : []; }

function node(tagName, { id, className, attributes = {}, text } = {}) {
    const result = new Node(tagName);
    if (id) result.setAttribute("id", id);
    if (className) result.setAttribute("class", className);
    Object.entries(attributes).forEach(([name, value]) => result.setAttribute(name, value));
    if (text) result.textContent = text;
    return result;
}

function canvasCompatibilityFixture() {
    const document = new Document();
    const dashboard = node("main", { id: "DashboardCard_Container" });
    const listCard = node("article", { className: "ic-DashboardCard__box" });
    const cardHeader = node("button", { className: "ic-DashboardCard__header-button", text: "Biology — very long translated course title" });
    listCard.append(cardHeader);
    dashboard.append(listCard);

    const gradebook = node("section", { id: "gradebook_grid" });
    const gradeViewport = node("div", { className: "slick-viewport" });
    const selectedGrade = node("div", { className: "slick-cell", attributes: { "aria-selected": "true" }, text: "Midterm" });
    gradeViewport.append(selectedGrade); gradebook.append(gradeViewport);

    const sidebar = node("aside", { id: "apstudycanvas-sidebar-root" });
    const todo = node("section", { id: "apstudy-todo-right-rail", attributes: { "data-apstudycanvas-owned": "true" } });
    document.body.append(dashboard, gradebook, sidebar, todo);
    return { document, dashboard, listCard, cardHeader, gradebook, gradeViewport, selectedGrade, sidebar, todo };
}

function addCanvasPortals(document) {
    const trayPortal = node("div", { id: "nav-tray-portal" });
    const tray = node("section", { className: "navigation-tray-container courses-tray" });
    const comments = node("section", { id: "comments-tray" });
    const submission = node("section", { className: "submission-details-container" });
    const announcement = node("article", { id: "announcementWrapper" });
    const datePicker = node("div", { className: "ui-datepicker" });
    const timePicker = node("div", { className: "ui-timepicker-wrapper" });
    const listbox = node("ul", { attributes: { role: "listbox", "data-testid": "time-picker" } });
    const selectedOption = node("li", { attributes: { role: "option", "aria-selected": "true" }, text: "11:59 PM" });
    listbox.append(selectedOption); trayPortal.append(tray);
    document.body.append(trayPortal, comments, submission, announcement, datePicker, timePicker, listbox);
    return { trayPortal, tray, comments, submission, announcement, datePicker, timePicker, listbox, selectedOption };
}

function createWindow() {
    const listeners = new Map();
    const history = { pushState() {}, replaceState() {} };
    return {
        location: { href: "https://canvas.emory.edu/courses/42/grades", pathname: "/courses/42/grades" },
        history,
        listeners,
        addEventListener(type, listener) { listeners.set(type, [...(listeners.get(type) || []), listener]); },
        removeEventListener(type, listener) { listeners.set(type, (listeners.get(type) || []).filter((candidate) => candidate !== listener)); },
        dispatch(type, event = {}) { (listeners.get(type) || []).slice().forEach((listener) => listener(event)); }
    };
}

function createObserverClass() {
    const instances = [];
    class Observer {
        constructor(callback) { this.callback = callback; this.disconnectCalls = 0; this.observeCalls = 0; instances.push(this); }
        observe() { this.observeCalls += 1; }
        disconnect() { this.disconnectCalls += 1; }
        trigger(records) { this.callback(records); }
    }
    Observer.instances = instances;
    return Observer;
}

module.exports = { Node, Document, walk, node, canvasCompatibilityFixture, addCanvasPortals, createWindow, createObserverClass };
