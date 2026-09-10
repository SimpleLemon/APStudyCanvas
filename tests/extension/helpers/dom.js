"use strict";

class Node {
    constructor(doc, tag) { this.ownerDocument = doc; this.tagName = tag; this.children = []; this.parentElement = null; this.dataset = {}; this.style = { setProperty: (key, value) => { this.style[key] = value; } }; this.listeners = new Map(); this.attributes = {}; this._value = ""; this.className = ""; this.textContent = ""; this.selectionStart = null; this.selectionEnd = null; }
    get value() { return this._value; }
    set value(value) { this._value = String(value ?? ""); }
    append(...nodes) { nodes.forEach((node) => { if (!node) return; node.parentElement = this; this.children.push(node); }); }
    replaceChildren(...nodes) { this.children.forEach((node) => { node.parentElement = null; }); this.children = []; this.append(...nodes); }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((node) => node !== this); this.parentElement = null; }
    contains(node) { return node === this || this.children.some((child) => child.contains(node)); }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    dispatchEvent(event) { this.listeners.get(event.type)?.({ ...event, target: event.target || this }); }
    focus() { this.ownerDocument.activeElement = this; }
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
    closest(selector) { let current = this; while (current) { if (selector.includes("data-action") && current.dataset.action) return current; if (selector.includes("data-assignment-id") && current.dataset.assignmentId) return current; if (selector.includes("data-group-id") && current.dataset.groupId) return current; current = current.parentElement; } return null; }
    querySelector(selector) { const match = selector.match(/data-([\w-]+)="([^"]+)"/); if (!match) return null; const key = match[1].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()); return walk(this).find((node) => node.dataset[key] === match[2]) || null; }
}
class Document { constructor() { this.activeElement = null; } createElement(tag) { return new Node(this, tag); } }
function walk(node) { return [node, ...node.children.flatMap(walk)]; }

module.exports = { Document, walk };
