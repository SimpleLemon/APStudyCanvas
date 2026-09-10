"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const cardAppearance = require("../../js/content/card-appearance.js");
const canvasRegistration = require("../../js/platform/canvas-registration.js");

const root = path.resolve(__dirname, "../..");
const contentSource = fs.readFileSync(path.join(root, "js/content.js"), "utf8");

function makeCard(id) { return { id }; }

function makeDoc(cards = []) {
    return {
        documentElement: {},
        querySelectorAll(selector) {
            if (selector !== ".ic-DashboardCard") return [];
            return cards.slice();
        }
    };
}

function makeObserverClass() {
    const instances = [];
    class FakeObserver {
        constructor(callback) {
            this.callback = callback;
            this.targets = [];
            this.optionList = [];
            this.disconnectCalls = 0;
            instances.push(this);
        }
        observe(target, options) { this.targets.push(target); this.optionList.push(options); }
        disconnect() { this.disconnectCalls += 1; }
        trigger(records) { this.callback(records); }
    }
    FakeObserver.instances = instances;
    return FakeObserver;
}

test("start observes the document subtree and applies to cards already in the DOM", () => {
    const card = makeCard(1);
    const applied = [];
    const Observer = makeObserverClass();
    const doc = makeDoc([card]);
    const watcher = cardAppearance.createCardAppearance({
        document: doc,
        apply: (reason) => applied.push([reason, card]),
        mutationObserver: Observer
    });
    watcher.start();
    assert.equal(watcher.isStarted(), true);
    assert.equal(Observer.instances.length, 1);
    assert.deepEqual(Observer.instances[0].optionList, [{ childList: true, subtree: true }]);
    assert.equal(Observer.instances[0].targets[0], doc.documentElement, "the observer must watch the whole document from document_start");
    assert.deepEqual(applied.map((entry) => entry[1]), [card]);
    watcher.stop();
});

test("a card insertion is customized synchronously inside the mutation microtask", () => {
    const applied = [];
    const Observer = makeObserverClass();
    const doc = makeDoc([]);
    const watcher = cardAppearance.createCardAppearance({
        document: doc,
        apply: (reason) => applied.push(reason),
        mutationObserver: Observer
    });
    watcher.start();
    assert.deepEqual(applied, [], "no cards, no apply");

    const card = makeCard(7);
    doc.querySelectorAll = () => [card];
    Observer.instances[0].trigger([{ type: "childList", addedNodes: [{}] }]);

    assert.deepEqual(applied, ["card-insertion"], "apply must run before the observer returns, before any paint");
    watcher.stop();
});

test("mutations caused by the customizer's own writes do not re-apply", () => {
    const applied = [];
    const Observer = makeObserverClass();
    const card = makeCard(3);
    const doc = makeDoc([card]);
    const watcher = cardAppearance.createCardAppearance({
        document: doc,
        apply: () => applied.push(1),
        mutationObserver: Observer
    });
    watcher.start();
    assert.equal(applied.length, 1);
    // The customizer appends an image container and link images; those
    // childList records must not trigger another pass on the same cards.
    Observer.instances[0].trigger([{ type: "childList", addedNodes: [{}, {}] }]);
    assert.equal(applied.length, 1);
    watcher.stop();
});

test("a replaced card element (same count, new identity) re-applies", () => {
    const applied = [];
    const Observer = makeObserverClass();
    const original = makeCard(9);
    const doc = makeDoc([original]);
    const watcher = cardAppearance.createCardAppearance({
        document: doc,
        apply: () => applied.push(1),
        mutationObserver: Observer
    });
    watcher.start();
    assert.equal(applied.length, 1);
    const replacement = makeCard(9);
    doc.querySelectorAll = () => [replacement];
    Observer.instances[0].trigger([{ type: "childList", addedNodes: [replacement] }]);
    assert.equal(applied.length, 2, "Canvas re-renders must be restyled");
    watcher.stop();
});

test("removals and empty record batches never scan", () => {
    const applied = [];
    const Observer = makeObserverClass();
    const doc = makeDoc([]);
    const watcher = cardAppearance.createCardAppearance({
        document: doc,
        apply: () => applied.push(1),
        mutationObserver: Observer
    });
    watcher.start();
    doc.querySelectorAll = () => [makeCard(2)];
    Observer.instances[0].trigger([{ type: "childList", removedNodes: [{}] }]);
    Observer.instances[0].trigger([]);
    assert.deepEqual(applied, [], "no insertion, no scan");
    watcher.stop();
});

test("an apply error does not disable the watcher", () => {
    const applied = [];
    const Observer = makeObserverClass();
    const doc = makeDoc([makeCard(4)]);
    let fail = true;
    const watcher = cardAppearance.createCardAppearance({
        document: doc,
        apply: () => { applied.push(1); if (fail) throw new Error("boom"); },
        mutationObserver: Observer
    });
    watcher.start();
    assert.deepEqual(applied, [1], "the error is contained inside the scan");
    fail = false;
    doc.querySelectorAll = () => [makeCard(4)];
    Observer.instances[0].trigger([{ type: "childList", addedNodes: [{}] }]);
    assert.deepEqual(applied, [1, 1]);
    watcher.stop();
});

test("without MutationObserver support the watcher still styles existing cards once", () => {
    const applied = [];
    const card = makeCard(5);
    const watcher = cardAppearance.createCardAppearance({
        document: makeDoc([card]),
        apply: () => applied.push(card),
        mutationObserver: null
    });
    watcher.start();
    assert.deepEqual(applied, [card]);
    assert.equal(watcher.isStarted(), true);
    watcher.stop();
});

test("stop disconnects the observer and future triggers are ignored", () => {
    const applied = [];
    const Observer = makeObserverClass();
    const doc = makeDoc([]);
    const watcher = cardAppearance.createCardAppearance({
        document: doc,
        apply: () => applied.push(1),
        mutationObserver: Observer
    });
    watcher.start();
    watcher.stop();
    assert.equal(Observer.instances[0].disconnectCalls, 1);
    doc.querySelectorAll = () => [makeCard(6)];
    Observer.instances[0].trigger([{ type: "childList", addedNodes: [{}] }]);
    assert.deepEqual(applied, [], "a stopped watcher is inert");
});

test("content.js runs the card customizer through the watcher at boot", () => {
    assert.match(contentSource, /const contentCardAppearanceApi = globalThis\.APStudyCanvasContent\?\.CardAppearance;/);
    assert.match(contentSource, /function applyCardAppearance\(\) \{\s*customizeCards\(\);\s*changeGradientCards\(\);\s*\}/);
    assert.match(contentSource, /ensureCardAppearance\(\);\s*initializeTodoIntegration\(\);/, "the watcher must start before the debounced lifecycle");
});

test("card-appearance is registered in manifest and dynamic registration at the same position", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
    const manifestScripts = manifest.content_scripts[1].js;
    const dynamicScripts = canvasRegistration.CANVAS_CONTENT_SCRIPTS;
    assert.equal(manifestScripts.indexOf("js/content/card-appearance.js"), dynamicScripts.indexOf("js/content/card-appearance.js"));
    assert.ok(manifestScripts.includes("js/content/card-appearance.js"), "static Canvas injection needs the watcher");
    assert.ok(manifestScripts.indexOf("js/content/card-appearance.js") < manifestScripts.indexOf("js/content.js"), "the watcher must load before content.js");
    assert.deepEqual(manifestScripts, dynamicScripts);
});
