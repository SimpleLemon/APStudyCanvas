"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const overlayPreview = require("../../js/content/overlay-preview.js");
const overlayHost = require("../../js/content/overlay-host.js");
const overlayHistory = require("../../js/content/overlay-history.js");

const CANVAS_ORIGIN = "https://canvas.emory.edu";

function measuredPreviewViewport(windowRef, rectProvider) {
    return {
        getBoundingClientRect() {
            const rect = typeof rectProvider === "function"
                ? rectProvider()
                : overlayPreview.splitPreviewSlot(overlayPreview.computeSlots(
                    overlayPreview.computePanelRect({
                        width: windowRef.innerWidth,
                        height: windowRef.innerHeight
                    }),
                    { viewportWidth: windowRef.innerWidth }
                ).preview).viewport;
            return {
                left: rect?.x ?? rect?.left ?? 0,
                top: rect?.y ?? rect?.top ?? 0,
                width: rect?.width ?? 0,
                height: rect?.height ?? 0
            };
        }
    };
}

test("zoom snaps to 25% steps, clamps to 50–200, and reset returns the default", () => {
    assert.equal(overlayPreview.ZOOM_DEFAULT, 100);
    assert.equal(overlayPreview.snapZoom(100), 100);
    assert.equal(overlayPreview.snapZoom(67), 75);
    assert.equal(overlayPreview.snapZoom(62), 50);
    assert.equal(overlayPreview.snapZoom(0), 50);
    assert.equal(overlayPreview.snapZoom(999), 200);
    assert.equal(overlayPreview.snapZoom("nope"), 100);
    assert.equal(overlayPreview.stepZoom(100, 1), 125);
    assert.equal(overlayPreview.stepZoom(100, -1), 75);
    assert.equal(overlayPreview.stepZoom(50, -1), 50);
    assert.equal(overlayPreview.stepZoom(200, 1), 200);
    assert.equal(overlayPreview.resolveZoom({ reset: true }, 175), 100);
    assert.equal(overlayPreview.resolveZoom({ step: 1 }, 100), 125);
    assert.equal(overlayPreview.resolveZoom({ step: -1 }, 100), 75);
    assert.equal(overlayPreview.resolveZoom({ value: 180 }, 100), 175);
    assert.equal(overlayPreview.resolveZoom({ delta: 50 }, 100), 150);
});

test("slot math uses zero-inset viewport geometry, the bounded 52/48 editor split, and fluid spacing", () => {
    const viewport = { width: 1440, height: 900 };
    const panel = overlayPreview.computePanelRect(viewport, {
        fullscreen: true,
        inset: overlayHost.WINDOWED_INSET
    });
    assert.deepEqual(panel, { x: 0, y: 0, width: 1440, height: 900 });
    const slots = overlayPreview.computeSlots(panel);
    assert.equal(overlayPreview.IFRAME_SLOT_FRACTION, 0.52);
    assert.equal(overlayPreview.PREVIEW_SLOT_FRACTION, 0.48);
    assert.equal(overlayPreview.computePanelGap(400), 24);
    assert.equal(overlayPreview.computePanelGap(1600), 64);
    assert.equal(overlayPreview.computeEditorLeftInset(400), 12);
    assert.ok(Math.abs(overlayPreview.computeEditorLeftInset(1440) - 43.2) < 1e-9);
    assert.equal(overlayPreview.computeEditorLeftInset(1600), 48);
    assert.equal(overlayPreview.PANEL_GAP_CSS, "clamp(24px, 4vw, 64px)");
    const trackWidth = slots.iframe.width + slots.preview.width;
    const iframeShare = slots.iframe.width / trackWidth;
    const previewShare = slots.preview.width / trackWidth;
    assert.ok(Math.abs(iframeShare - 0.52) < 0.03);
    assert.ok(Math.abs(previewShare - 0.48) < 0.03);
    assert.ok(Math.abs(
        slots.preview.x - (slots.iframe.x + slots.iframe.width) - overlayPreview.computePanelGap(viewport.width)
    ) < 1e-9);
    assert.equal(slots.preview.y, overlayPreview.PANEL_PADDING + overlayPreview.PREVIEW_UTILITY_HEADER_HEIGHT);
    assert.equal(slots.preview.height, 900 - overlayPreview.PANEL_PADDING * 2 - overlayPreview.PREVIEW_UTILITY_HEADER_HEIGHT);
    assert.equal(overlayPreview.PREVIEW_RADIUS, 16);

    const compatibilityRect = overlayPreview.computePanelRect(viewport, {
        fullscreen: false,
        inset: { block: 14, inline: 26 }
    });
    assert.deepEqual(compatibilityRect, panel, "retired windowed options cannot inset preview geometry");
    const degraded = overlayPreview.computeSlots(compatibilityRect, { previewEnabled: false });
    assert.equal(degraded.preview, null);
    assert.equal(degraded.iframe.width, compatibilityRect.width - overlayPreview.PANEL_PADDING * 2);
});

test("body transform contain-fits the viewport into the preview slot and scales with zoom", () => {
    const viewport = { width: 1000, height: 800 };
    const preview = { x: 400, y: 40, width: 560, height: 720 };
    const fit = overlayPreview.computeBodyTransform(viewport, preview, 100, { x: 10, y: 40 });
    assert.equal(overlayPreview.FIT_MODE, "contain");
    assert.equal(fit.fitMode, "contain");
    assert.equal(fit.zoom, 100);
    assert.equal(fit.fit, Math.min(560 / 1000, 720 / 800));
    assert.ok(Math.abs(fit.scale - fit.fit) < 1e-9, "100% zoom is the contain-fit scale, not 1:1");
    assert.equal(fit.clipped, false, "the whole Canvas viewport fits, so nothing is cut off at 100%");
    assert.equal(fit.offsetX, preview.x, "the width is the binding dimension, so there is no horizontal slack");
    assert.ok(fit.offsetY > preview.y, "the leftover height letterboxes into navy bands above and below");
    assert.match(fit.transform, /scale\(/);
    assert.match(fit.transform, /translate\(-10px, -40px\)/);
    assert.equal(fit.transformOrigin, "0px 0px");

    const zoomed = overlayPreview.computeBodyTransform(viewport, preview, 200, { x: 0, y: 0 });
    assert.ok(Math.abs(zoomed.scale - fit.scale * 2) < 1e-9);
    assert.equal(zoomed.clipped, true, "zooming past the contain fit overflows and is clipped by the hole");
    const shrunk = overlayPreview.computeBodyTransform(viewport, preview, 50, { x: 0, y: 0 });
    assert.ok(Math.abs(shrunk.scale - fit.scale * 0.5) < 1e-9);
    const reset = overlayPreview.resolveZoom({ reset: true }, 175);
    assert.equal(reset, overlayPreview.ZOOM_DEFAULT);
});

test("the cover branch still computes when a caller asks for it explicitly", () => {
    const viewport = { width: 1000, height: 800 };
    const preview = { x: 400, y: 40, width: 560, height: 720 };
    assert.equal(overlayPreview.computeFitScale(viewport, preview, "contain"), Math.min(560 / 1000, 720 / 800));
    assert.equal(overlayPreview.computeFitScale(viewport, preview, "cover"), Math.max(560 / 1000, 720 / 800));

    const cover = overlayPreview.computeBodyTransform(viewport, preview, 100, { x: 0, y: 0 }, { fitMode: "cover" });
    assert.equal(cover.fitMode, "cover");
    assert.equal(cover.fit, Math.max(560 / 1000, 720 / 800));
    assert.equal(cover.clipped, true, "a 5:4 page cover-fitted into a taller slot clips horizontally");
    assert.ok(cover.offsetX < preview.x, "cover overflow is centered, so the origin sits left of the slot");

    const topLeft = overlayPreview.computeBodyTransform(viewport, preview, 100, { x: 0, y: 0 }, { align: { x: 0, y: 0 } });
    assert.equal(topLeft.offsetX, preview.x);
    assert.equal(topLeft.offsetY, preview.y, "align 0,0 pins the drawn page to the slot origin");
    assert.deepEqual(overlayPreview.PREVIEW_ALIGN, { x: 0.5, y: 0.5 });
});

test("splitPreviewSlot reserves the toolbar row and clamps the viewport row at zero", () => {
    assert.equal(overlayPreview.PREVIEW_TOOLBAR_HEIGHT, 52);
    assert.equal(overlayPreview.PREVIEW_TOOLBAR_GAP, 8);

    const split = overlayPreview.splitPreviewSlot({ x: 640, y: 30, width: 760, height: 840 });
    assert.deepEqual(split.toolbar, { x: 640, y: 30, width: 760, height: 52 });
    assert.deepEqual(split.viewport, { x: 640, y: 90, width: 760, height: 780 });

    const custom = overlayPreview.splitPreviewSlot({ x: 0, y: 0, width: 100, height: 100 }, { toolbarHeight: 40, gap: 10 });
    assert.deepEqual(custom.viewport, { x: 0, y: 50, width: 100, height: 50 });

    const tiny = overlayPreview.splitPreviewSlot({ x: 0, y: 0, width: 100, height: 30 });
    assert.equal(tiny.toolbar.height, 30, "the toolbar cannot exceed the column");
    assert.equal(tiny.viewport.height, 0, "a short column degrades to a zero-height viewport, never negative");
    assert.equal(overlayPreview.splitPreviewSlot(null), null);
});

test("consecutive zero rendered measurements keep the masks closed until a measured-layout retry succeeds", () => {
    const bodyProperties = new Map();
    const htmlProperties = new Map();
    const backdropProperties = new Map();
    const fillProperties = new Map();
    const styleFor = (properties) => ({
        setProperty: (name, value) => { properties.set(name, String(value)); },
        removeProperty: (name) => { properties.delete(name); },
        getPropertyValue: (name) => properties.get(name) || "",
        getPropertyPriority: () => ""
    });
    let renderedRect = { left: 0, top: 0, width: 0, height: 0 };
    let retry = null;
    let scheduledRetries = 0;
    const win = {
        innerWidth: 1000,
        innerHeight: 800,
        scrollX: 0,
        scrollY: 0,
        location: { href: `${CANVAS_ORIGIN}/` },
        history: { pushState() {}, replaceState() {} },
        requestAnimationFrame(callback) {
            scheduledRetries += 1;
            retry = callback;
            return scheduledRetries;
        },
        cancelAnimationFrame() { retry = null; },
        addEventListener() {},
        removeEventListener() {}
    };
    const engine = overlayPreview.createPreviewEngine({
        documentRef: {
            documentElement: { style: styleFor(htmlProperties), childNodes: [] },
            body: { style: styleFor(bodyProperties) }
        },
        windowRef: win,
        fill: { style: styleFor(fillProperties) },
        backdrop: { style: styleFor(backdropProperties) },
        previewViewport: measuredPreviewViewport(win, () => renderedRect),
        createLedger: overlayHost.createRestoreLedger
    });

    const started = engine.start();
    assert.deepEqual(started, { ok: true, preview: false, reason: "pending-layout", zoom: 100 });
    assert.equal(engine.available, false);
    assert.equal(bodyProperties.has("transform"), false, "Canvas remains unscaled while the slot has no area");
    assert.equal(backdropProperties.has("clip-path"), false, "the viewport mask remains fully opaque");
    assert.equal(fillProperties.has("clip-path"), false, "the panel mask remains fully opaque");
    assert.equal(typeof retry, "function", "layout is retried after the pending frame commits");
    assert.equal(scheduledRetries, 1);
    engine.applyLayout();
    assert.equal(scheduledRetries, 1, "another layout signal cannot enqueue a duplicate retry");

    const runRetry = () => {
        const callback = retry;
        assert.equal(typeof callback, "function", "exactly one measured-layout retry remains scheduled");
        retry = null;
        callback();
    };

    runRetry();
    assert.equal(engine.available, false, "the first invalid retry does not reveal Canvas");
    assert.equal(scheduledRetries, 2);
    assert.equal(bodyProperties.has("transform"), false);
    assert.equal(backdropProperties.has("clip-path"), false);
    assert.equal(fillProperties.has("clip-path"), false);

    runRetry();
    assert.equal(engine.available, false, "the second invalid retry continues waiting without revealing Canvas");
    assert.equal(scheduledRetries, 3);
    assert.equal(bodyProperties.has("transform"), false);
    assert.equal(backdropProperties.has("clip-path"), false);
    assert.equal(fillProperties.has("clip-path"), false);

    renderedRect = { left: 611, top: 173, width: 333, height: 271 };
    runRetry();
    assert.equal(scheduledRetries, 3, "a valid measurement ends retry scheduling");
    assert.equal(retry, null);

    const expected = overlayPreview.computeBodyTransform(
        { width: win.innerWidth, height: win.innerHeight },
        { x: 611, y: 173, width: 333, height: 271 },
        100,
        { x: 0, y: 0 }
    );
    assert.equal(engine.available, true);
    assert.equal(bodyProperties.get("transform"), expected.transform, "the rendered rectangle, not a toolbar-height guess, drives the transform");
    assert.match(backdropProperties.get("clip-path"), /^path\(evenodd/);
    assert.match(fillProperties.get("clip-path"), /^path\(evenodd/);

    engine.stop();
    assert.equal(bodyProperties.has("transform"), false);
    assert.equal(backdropProperties.has("clip-path"), false);
    assert.equal(fillProperties.has("clip-path"), false);
});

test("cover and stop cancel pending measurement retries without residual mutations", () => {
    const bodyProperties = new Map();
    const htmlProperties = new Map();
    const backdropProperties = new Map();
    const fillProperties = new Map();
    const styleFor = (properties) => ({
        setProperty: (name, value) => { properties.set(name, String(value)); },
        removeProperty: (name) => { properties.delete(name); },
        getPropertyValue: (name) => properties.get(name) || "",
        getPropertyPriority: () => ""
    });
    let nextFrame = 1;
    let queuedRetry = null;
    let renderedRect = { left: 611, top: 173, width: 333, height: 271 };
    const cancelledFrames = [];
    const win = {
        innerWidth: 1000,
        innerHeight: 800,
        scrollX: 0,
        scrollY: 0,
        location: { href: `${CANVAS_ORIGIN}/` },
        history: { pushState() {}, replaceState() {} },
        requestAnimationFrame(callback) {
            const id = nextFrame++;
            queuedRetry = { id, callback };
            return id;
        },
        cancelAnimationFrame(id) {
            cancelledFrames.push(id);
            if (queuedRetry?.id === id) queuedRetry = null;
        },
        addEventListener() {},
        removeEventListener() {}
    };
    const engine = overlayPreview.createPreviewEngine({
        documentRef: {
            documentElement: { style: styleFor(htmlProperties), childNodes: [] },
            body: { style: styleFor(bodyProperties) }
        },
        windowRef: win,
        fill: { style: styleFor(fillProperties) },
        backdrop: { style: styleFor(backdropProperties) },
        previewViewport: measuredPreviewViewport(win, () => renderedRect),
        createLedger: overlayHost.createRestoreLedger
    });

    assert.equal(engine.start().preview, true);
    assert.equal(bodyProperties.has("transform"), true);
    assert.equal(backdropProperties.has("clip-path"), true);
    assert.equal(fillProperties.has("clip-path"), true);

    renderedRect = { left: 0, top: 0, width: 0, height: 0 };
    assert.equal(engine.applyLayout().reason, "pending-layout");
    assert.equal(bodyProperties.has("transform"), false, "an invalid measurement immediately untransforms Canvas");
    assert.equal(backdropProperties.has("clip-path"), false, "an invalid measurement immediately closes the viewport mask");
    assert.equal(fillProperties.has("clip-path"), false, "an invalid measurement immediately closes the panel mask");
    const closeRetry = queuedRetry;
    assert.ok(closeRetry);
    engine.cover();
    assert.deepEqual(cancelledFrames, [closeRetry.id]);
    assert.equal(queuedRetry, null);
    closeRetry.callback();
    assert.equal(queuedRetry, null, "a stale close retry cannot schedule more work");

    assert.equal(engine.resume().reason, "pending-layout");
    const destroyRetry = queuedRetry;
    assert.ok(destroyRetry);
    engine.stop();
    assert.deepEqual(cancelledFrames, [closeRetry.id, destroyRetry.id]);
    assert.equal(queuedRetry, null);
    destroyRetry.callback();
    assert.equal(queuedRetry, null, "a stale destroy retry cannot schedule more work");
    assert.equal(engine.active, false);
    assert.deepEqual([...bodyProperties], [], "Canvas body has no residual presentation styles");
    assert.deepEqual([...htmlProperties], [], "Canvas root has no residual mask background");
    assert.deepEqual([...backdropProperties], [], "the viewport mask remains fully closed");
    assert.deepEqual([...fillProperties], [], "the panel mask remains fully closed");
});

test("navigation accepts catalog destinations on the Canvas origin and rejects everything else", () => {
    const origin = CANVAS_ORIGIN;
    const href = `${origin}/courses/19/modules`;

    const calendar = overlayPreview.resolveNavigation({ destination: "calendar" }, { origin, href });
    assert.equal(calendar.ok, true);
    assert.equal(calendar.href, `${origin}/calendar`);

    const course = overlayPreview.resolveNavigation({ destination: "course-home" }, { origin, href });
    assert.equal(course.ok, true);
    assert.equal(course.path, "/courses/19");

    const dashboard = overlayPreview.resolveNavigation({ destination: "dashboard" }, { origin, href });
    assert.equal(dashboard.ok, true);

    assert.equal(overlayPreview.resolveNavigation({ destination: "inbox" }, { origin, href }).ok, true);
    assert.equal(overlayPreview.resolveNavigation({ destination: "courses" }, { origin, href }).ok, true);

    assert.equal(overlayPreview.resolveNavigation({ destination: "course-home" }, { origin, href: `${origin}/` }).code, "PREVIEW_COURSE_REQUIRED");
    assert.equal(overlayPreview.resolveNavigation({ destination: "evil" }, { origin, href }).code, "PREVIEW_DESTINATION_UNSUPPORTED");
    assert.equal(overlayPreview.resolveNavigation({ url: "https://evil.example/phish" }, { origin, href }).code, "PREVIEW_DESTINATION_UNSUPPORTED");

    assert.equal(overlayPreview.validateNavigationUrl("https://evil.example/", origin).code, "PREVIEW_ORIGIN_MISMATCH");
    assert.equal(overlayPreview.validateNavigationUrl(`${origin}/grades`, origin).code, "PREVIEW_PATH_UNSUPPORTED");
    assert.equal(overlayPreview.validateNavigationUrl("javascript:alert(1)", origin).code, "PREVIEW_ORIGIN_MISMATCH");
    assert.equal(overlayPreview.validateNavigationUrl("https://user:pass@canvas.emory.edu/calendar", origin).code, "PREVIEW_URL_INVALID");
});

test("canHostPreview requires an overlay container on the page root, not inside body", () => {
    const root = { tagName: "HTML" };
    const body = { tagName: "BODY", parentNode: root };
    const container = { parentNode: root };
    assert.deepEqual(overlayPreview.canHostPreview({
        documentRef: { documentElement: root, body },
        container
    }), { ok: true });
    assert.equal(overlayPreview.canHostPreview({
        documentRef: { documentElement: root, body },
        container: { parentNode: body }
    }).reason, "overlay-not-on-root");
    assert.equal(overlayPreview.canHostPreview({ documentRef: { documentElement: root }, container }).reason, "missing-nodes");
});

test("preview navigation stacks on the overlay marker via a Canvas link and never synthesizes popstate", () => {
    const href = `${CANVAS_ORIGIN}/courses/1`;
    const stack = [{ state: null, url: href }];
    let index = 0;
    let popstateCount = 0;
    const location = { href };
    const win = {
        location,
        history: {
            get state() { return stack[index].state; },
            pushState(state, _title, url) {
                stack.push({ state, url: url || location.href });
                index = stack.length - 1;
                location.href = stack[index].url;
            },
            back() {
                index -= 1;
                location.href = stack[index].url;
                popstateCount += 1;
            }
        },
        addEventListener() {},
        removeEventListener() {}
    };
    const history = overlayHistory.createOverlayHistory({ windowRef: win });
    history.enter();
    assert.equal(history.canStackPreview(), true);

    const documentRef = {
        querySelectorAll() {
            return [{
                getAttribute: () => "/calendar",
                click() {
                    win.history.pushState({ canvas: "preview" }, "", `${CANVAS_ORIGIN}/calendar`);
                }
            }];
        }
    };
    const result = overlayPreview.activateDestination(
        { href: `${CANVAS_ORIGIN}/calendar`, origin: CANVAS_ORIGIN, path: "/calendar" },
        { documentRef, windowRef: win, historyController: history }
    );
    assert.equal(result.ok, true);
    assert.equal(result.method, "link");
    assert.equal(popstateCount, 0, "activating a destination must not dispatch popstate");
    assert.equal(history.phase, "open");
    assert.equal(history.currentIsOurs(), false);
    assert.equal(win.location.href, `${CANVAS_ORIGIN}/calendar`);

    win.history.back();
    assert.equal(history.currentIsOurs(), true);
    assert.equal(history.phase, "open");
    assert.equal(history.canStackPreview(), true);

    history.exit("ui");
    assert.equal(history.canStackPreview(), false);
    assert.equal(overlayPreview.activateDestination(
        { href: `${CANVAS_ORIGIN}/`, origin: CANVAS_ORIGIN, path: "/" },
        { documentRef, windowRef: win, historyController: history }
    ).code, "OVERLAY_PREVIEW_HISTORY_BLOCKED");
});

test("activateDestination does not assign location.href when no matching Canvas link exists", () => {
    const href = `${CANVAS_ORIGIN}/courses/1`;
    const location = { href };
    let pushed = 0;
    const win = {
        location,
        history: {
            pushState() { pushed += 1; }
        }
    };
    const result = overlayPreview.activateDestination(
        { href: `${CANVAS_ORIGIN}/calendar`, origin: CANVAS_ORIGIN, path: "/calendar" },
        { documentRef: {}, windowRef: win }
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, "PREVIEW_NAVIGATION_UNAVAILABLE");
    assert.equal(pushed, 0);
    assert.equal(location.href, href);
});

test("activateDestination prefers clicking a same-origin Canvas link over pushState", () => {
    const clicks = [];
    const documentRef = {
        querySelectorAll() {
            return [{
                getAttribute: () => "/calendar",
                click() { clicks.push("/calendar"); }
            }];
        }
    };
    const win = { location: { href: `${CANVAS_ORIGIN}/` }, history: { pushState() { throw new Error("should not push"); } } };
    const result = overlayPreview.activateDestination(
        { href: `${CANVAS_ORIGIN}/calendar`, origin: CANVAS_ORIGIN, path: "/calendar" },
        { documentRef, windowRef: win }
    );
    assert.deepEqual(result, { ok: true, method: "link", href: `${CANVAS_ORIGIN}/calendar` });
    assert.deepEqual(clicks, ["/calendar"]);
});

test("the preview engine records every host mutation and restores them in reverse, including abnormal stop", () => {
    const properties = new Map();
    const bodyStyle = {
        setProperty: (name, value) => { properties.set(`body:${name}`, String(value)); },
        removeProperty: (name) => { properties.delete(`body:${name}`); },
        getPropertyValue: (name) => properties.get(`body:${name}`) || "",
        getPropertyPriority: () => ""
    };
    const htmlStyle = {
        setProperty: (name, value) => { properties.set(`html:${name}`, String(value)); },
        removeProperty: (name) => { properties.delete(`html:${name}`); },
        getPropertyValue: (name) => properties.get(`html:${name}`) || "",
        getPropertyPriority: () => ""
    };
    htmlStyle.setProperty("background-color", "red");
    const html = { style: htmlStyle, childNodes: [] };
    const body = { style: bodyStyle };
    const location = { href: `${CANVAS_ORIGIN}/courses/1` };
    const fill = { style: { setProperty() {}, removeProperty() {} } };
    const backdrop = { style: { setProperty() {}, removeProperty() {} } };
    const preview = {};
    let pushState = function originalPush(_state, _title, url) {
        if (typeof url === "string" && url) location.href = url;
    };
    let replaceState = function originalReplace() {};
    const historyObj = { pushState, replaceState };
    const listeners = [];
    const win = {
        innerWidth: 1000,
        innerHeight: 800,
        scrollX: 24,
        scrollY: 80,
        location,
        history: historyObj,
        addEventListener(type, handler) { listeners.push([type, handler]); },
        removeEventListener(type, handler) {
            const index = listeners.findIndex((entry) => entry[0] === type && entry[1] === handler);
            if (index >= 0) listeners.splice(index, 1);
        }
    };
    const documentRef = {
        documentElement: html,
        body,
        querySelectorAll() {
            return [{
                getAttribute: () => "/calendar",
                click() { win.history.pushState({ canvas: "preview" }, "", `${CANVAS_ORIGIN}/calendar`); }
            }];
        }
    };
    const engine = overlayPreview.createPreviewEngine({
        documentRef,
        windowRef: win,
        fill,
        backdrop,
        previewViewport: measuredPreviewViewport(win),
        historyController: { canStackPreview: () => true },
        createLedger: overlayHost.createRestoreLedger,
        insets: overlayHost.WINDOWED_INSET
    });

    const started = engine.start({ fullscreen: false });
    assert.equal(started.ok, true);
    assert.equal(engine.active, true);
    assert.ok(properties.get("body:transform"), "body is transformed for the preview");
    assert.equal(properties.get("body:pointer-events"), "none");
    assert.equal(properties.get("html:background-color"), "#0a0f22");
    assert.equal(historyObj.pushState, pushState, "history is patched once, in lifecycle");
    assert.equal(historyObj.replaceState, replaceState, "history is patched once, in lifecycle");

    engine.setZoom({ value: 150 });
    assert.equal(engine.zoom, 150);
    const midTransform = properties.get("body:transform");

    engine.stop();
    assert.equal(engine.active, false);
    assert.equal(properties.get("body:transform"), undefined);
    assert.equal(properties.get("body:pointer-events"), undefined);
    assert.equal(properties.get("html:background-color"), "red", "pre-existing html background is restored, not cleared");
    assert.equal(historyObj.pushState, pushState);
    assert.equal(listeners.length, 0);

    engine.start();
    engine.setZoom({ value: 175 });
    assert.equal(engine.zoom, 175);
    assert.notEqual(properties.get("body:transform"), midTransform);
    engine.navigate({ destination: "calendar" });
    assert.equal(engine.pendingNavigate === true || win.location.href.endsWith("/calendar"), true);
    engine.stop();
    assert.equal(properties.get("body:transform"), undefined, "stop during a pending navigation still restores");
});

test("notifyRoute re-applies the transform, so the engine needs no history patch of its own", () => {
    const properties = new Map();
    const style = {
        setProperty: (name, value) => { properties.set(name, String(value)); },
        removeProperty: (name) => { properties.delete(name); },
        getPropertyValue: (name) => properties.get(name) || "",
        getPropertyPriority: () => ""
    };
    const pushState = function originalPush() {};
    const replaceState = function originalReplace() {};
    const historyObj = { pushState, replaceState };
    const win = {
        innerWidth: 1200,
        innerHeight: 800,
        scrollX: 0,
        scrollY: 0,
        location: { href: `${CANVAS_ORIGIN}/` },
        history: historyObj,
        addEventListener() {},
        removeEventListener() {}
    };
    const engine = overlayPreview.createPreviewEngine({
        documentRef: { documentElement: { style, childNodes: [] }, body: { style } },
        windowRef: win,
        fill: { style: { setProperty() {}, removeProperty() {} } },
        backdrop: { style: { setProperty() {}, removeProperty() {} } },
        previewViewport: measuredPreviewViewport(win),
        createLedger: overlayHost.createRestoreLedger,
        insets: overlayHost.WINDOWED_INSET
    });

    assert.deepEqual(engine.notifyRoute(), { ok: false, reason: "inactive" }, "a closed overlay ignores route changes");

    engine.start();
    const first = properties.get("transform");
    assert.ok(first);
    assert.equal(historyObj.pushState, pushState, "starting the engine must not wrap pushState");
    assert.equal(historyObj.replaceState, replaceState, "starting the engine must not wrap replaceState");

    win.innerWidth = 800;
    const routed = engine.notifyRoute();
    assert.equal(routed.ok, true);
    assert.notEqual(properties.get("transform"), first, "the SPA route change re-fits the page into the new slot");
    assert.equal(engine.pendingNavigate, false);

    engine.stop();
    assert.equal(properties.has("transform"), false);
});

test("destroy-equivalent stop while zoom is active still restores the unscaled page", () => {
    const properties = new Map();
    const style = {
        setProperty: (name, value) => { properties.set(name, String(value)); },
        removeProperty: (name) => { properties.delete(name); },
        getPropertyValue: (name) => properties.get(name) || "",
        getPropertyPriority: () => ""
    };
    const engine = overlayPreview.createPreviewEngine({
        documentRef: {
            documentElement: { style, childNodes: [] },
            body: { style }
        },
        windowRef: {
            innerWidth: 1200,
            innerHeight: 800,
            scrollX: 0,
            scrollY: 0,
            location: { href: `${CANVAS_ORIGIN}/` },
            history: { pushState() {}, replaceState() {} },
            addEventListener() {},
            removeEventListener() {}
        },
        fill: { style: { setProperty() {}, removeProperty() {} } },
        backdrop: { style: { setProperty() {}, removeProperty() {} } },
        preview: {},
        createLedger: overlayHost.createRestoreLedger,
        insets: overlayHost.WINDOWED_INSET
    });
    engine.start();
    engine.setZoom({ step: 1 });
    engine.stop();
    assert.equal(properties.has("transform"), false);
});

// ---------------------------------------------------------------------------
// Phase 8a, §12 item 4 — the history-patch half of the teardown contract.
//
// Before Phase 3, lifecycle.js AND overlay-preview.js each wrapped
// pushState/replaceState. The second wrapper nested inside the first, so
// lifecycle's identity check on dispose (`history.pushState === pushWrapper`)
// never matched and the native pushState was **permanently** leaked onto the
// Canvas page: every later SPA navigation ran through an orphaned wrapper
// belonging to a torn-down overlay. Phase 3 collapsed it to one patch, in
// lifecycle, with the engine's notifyRoute() called from lifecycle's onRoute.
// These assertions are by function identity, which is the only thing that would
// have caught the leak.
// ---------------------------------------------------------------------------

test("history is patched exactly once, in lifecycle, and dispose restores the native functions by identity", () => {
    const lifecycle = require("../../js/content/lifecycle.js");

    const properties = new Map();
    const style = {
        setProperty: (name, value) => { properties.set(name, String(value)); },
        removeProperty: (name) => { properties.delete(name); },
        getPropertyValue: (name) => properties.get(name) || "",
        getPropertyPriority: () => ""
    };
    const attributes = new Map();
    const documentElement = {
        style,
        childNodes: [],
        getAttribute: (name) => (attributes.has(name) ? attributes.get(name) : null),
        setAttribute: (name, value) => { attributes.set(name, String(value)); },
        removeAttribute: (name) => { attributes.delete(name); }
    };
    const location = { href: `${CANVAS_ORIGIN}/courses/1`, pathname: "/courses/1" };

    function nativePushState(_state, _title, url) {
        if (typeof url === "string" && url) location.href = url;
    }
    function nativeReplaceState() {}
    const historyObj = { pushState: nativePushState, replaceState: nativeReplaceState };

    const listeners = new Map();
    const win = {
        innerWidth: 1200,
        innerHeight: 800,
        scrollX: 0,
        scrollY: 0,
        location,
        history: historyObj,
        addEventListener(type, handler) {
            if (!listeners.has(type)) listeners.set(type, []);
            listeners.get(type).push(handler);
        },
        removeEventListener(type, handler) {
            listeners.set(type, (listeners.get(type) || []).filter((entry) => entry !== handler));
        },
        listenerCount(type) { return (listeners.get(type) || []).length; }
    };
    const documentRef = { documentElement, body: { style }, querySelectorAll: () => [] };

    const engine = overlayPreview.createPreviewEngine({
        documentRef,
        windowRef: win,
        fill: { style: { setProperty() {}, removeProperty() {} } },
        backdrop: { style: { setProperty() {}, removeProperty() {} } },
        previewViewport: measuredPreviewViewport(win),
        createLedger: overlayHost.createRestoreLedger,
        insets: overlayHost.WINDOWED_INSET
    });

    const timers = new Map();
    let nextTimer = 1;
    const routes = [];
    const controller = lifecycle.createContentLifecycle({
        document: documentRef,
        window: win,
        chromeApi: { storage: { onChanged: { addListener() {}, removeListener() {} } } },
        setTimer: (callback) => { const id = nextTimer++; timers.set(id, callback); return id; },
        clearTimer: (id) => timers.delete(id),
        onRoute: (event) => { routes.push(event); engine.notifyRoute(); }
    });
    const flush = () => {
        const pending = Array.from(timers.values());
        timers.clear();
        pending.forEach((callback) => callback());
    };

    controller.init();
    const pushWrapper = historyObj.pushState;
    const replaceWrapper = historyObj.replaceState;
    assert.notEqual(pushWrapper, nativePushState, "lifecycle wraps pushState");
    assert.notEqual(replaceWrapper, nativeReplaceState, "lifecycle wraps replaceState");

    // A duplicate init must not nest a second wrapper — that nesting is exactly
    // what broke the identity check and leaked the native function.
    controller.init();
    assert.equal(historyObj.pushState, pushWrapper, "a second init must not stack another wrapper");
    assert.equal(historyObj.replaceState, replaceWrapper);

    // Nor may starting the preview engine add one.
    assert.equal(engine.start({ fullscreen: false }).ok, true);
    assert.equal(historyObj.pushState, pushWrapper, "the preview engine adds no history patch of its own");
    assert.equal(historyObj.replaceState, replaceWrapper);
    const beforeRoute = properties.get("transform");
    assert.ok(beforeRoute, "the engine transformed the body");

    // The single patch still drives the engine's re-fit on an SPA navigation.
    win.innerWidth = 800;
    win.history.pushState({}, "", `${CANVAS_ORIGIN}/calendar`);
    flush();
    assert.equal(routes.length, 1);
    assert.equal(routes[0].reason, "history");
    assert.notEqual(properties.get("transform"), beforeRoute, "the route change re-fitted the page through lifecycle's patch");

    engine.stop();
    controller.dispose();

    assert.equal(historyObj.pushState, nativePushState, "dispose must hand back the native pushState, not an orphaned wrapper");
    assert.equal(historyObj.replaceState, nativeReplaceState);
    assert.equal(properties.size, 0, `residual style declarations: ${JSON.stringify([...properties])}`);
    ["transform", "transform-origin", "overflow", "pointer-events", "width", "height", "background-color"].forEach((name) => {
        assert.equal(style.getPropertyValue(name), "", `residual ${name}`);
    });
    assert.equal(win.listenerCount("popstate"), 0);
    assert.equal(win.listenerCount("pagehide"), 0);
    assert.equal(documentElement.getAttribute(lifecycle.MARKER), null, "the lifecycle marker is released");
});

test("only js/content/lifecycle.js may assign history.pushState", () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const dir = path.resolve(__dirname, "../../js/content");
    const offenders = fs.readdirSync(dir)
        .filter((name) => name.endsWith(".js"))
        .filter((name) => name !== "lifecycle.js")
        .filter((name) => /history\.(?:push|replace)State\s*=[^=]/.test(fs.readFileSync(path.join(dir, name), "utf8")));
    assert.deepEqual(offenders, [], "a second history patch would nest and leak the native function forever");
    const source = fs.readFileSync(path.join(dir, "lifecycle.js"), "utf8");
    assert.match(source, /win\?\.history\?\.pushState === pushWrapper\) win\.history\.pushState = oldPushState/);
    assert.match(source, /win\?\.history\?\.replaceState === replaceWrapper\) win\.history\.replaceState = oldReplaceState/);
});
