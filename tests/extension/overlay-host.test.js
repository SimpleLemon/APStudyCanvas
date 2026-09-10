"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const overlayHost = require("../../js/content/overlay-host.js");
const overlayPreview = require("../../js/content/overlay-preview.js");
const overlayHistory = require("../../js/content/overlay-history.js");
const contract = require("../../js/platform/contract.js");
const storage = require("../../js/platform/storage.js");
const router = require("../../js/platform/router.js");
const popupController = require("../../js/popup-controller.js");

const EXTENSION_ORIGIN = "chrome-extension://test-id";

class FakeNode {
    constructor(tagName = "div", rectProvider = null) {
        this.tagName = String(tagName).toUpperCase();
        this.nodeType = 1;
        this.className = "";
        this.hidden = false;
        this.textContent = "";
        this.childNodes = [];
        this.parentNode = null;
        this.offsetWidth = 0;
        this.focusCount = 0;
        this.shadow = null;
        this._rectProvider = rectProvider;
        this._attributes = new Map();
        this._listeners = new Map();
        const properties = new Map();
        this.style = {
            setProperty: (name, value) => { properties.set(String(name), String(value)); },
            removeProperty: (name) => { properties.delete(String(name)); },
            getPropertyValue: (name) => properties.get(String(name)) || "",
            getPropertyPriority: () => "",
            get size() { return properties.size; }
        };
    }

    get children() { return this.childNodes; }
    get id() { return this.getAttribute("id") || ""; }
    set id(value) { this.setAttribute("id", value); }

    setAttribute(name, value) { this._attributes.set(String(name), String(value)); }
    getAttribute(name) { return this._attributes.has(String(name)) ? this._attributes.get(String(name)) : null; }
    removeAttribute(name) { this._attributes.delete(String(name)); }
    appendChild(child) {
        this.childNodes.push(child);
        child.parentNode = this;
        return child;
    }
    insertBefore(child, reference) {
        const index = this.childNodes.indexOf(reference);
        if (index < 0) return this.appendChild(child);
        this.childNodes.splice(index, 0, child);
        child.parentNode = this;
        return child;
    }
    remove() {
        if (!this.parentNode) return;
        this.parentNode.childNodes = this.parentNode.childNodes.filter((node) => node !== this);
        this.parentNode = null;
    }
    attachShadow() {
        this.shadow = new FakeNode("shadow-root");
        return this.shadow;
    }
    addEventListener(type, handler) {
        if (!this._listeners.has(type)) this._listeners.set(type, []);
        this._listeners.get(type).push(handler);
    }
    removeEventListener(type, handler) {
        const handlers = this._listeners.get(type) || [];
        this._listeners.set(type, handlers.filter((entry) => entry !== handler));
    }
    dispatch(type, event = {}) {
        for (const handler of [...(this._listeners.get(type) || [])]) handler(event);
    }
    listenerCount(type) { return (this._listeners.get(type) || []).length; }
    focus() { this.focusCount += 1; }
    contains() { return true; }
    getBoundingClientRect() {
        return this._rectProvider?.(this) || { left: 0, top: 0, width: 0, height: 0 };
    }
}

function makeEnvironment({ reducedMotion = false, fullscreenStored } = {}) {
    const doc = new FakeNode("document");
    doc.documentElement = new FakeNode("html");
    doc.body = new FakeNode("body");
    doc.activeElement = new FakeNode("button");
    let windowRef;
    doc.createElement = (tagName) => new FakeNode(tagName, (node) => {
        if (node.className !== "preview-viewport" || !windowRef) return null;
        const viewport = { width: windowRef.innerWidth, height: windowRef.innerHeight };
        if (!overlayPreview.isPreviewLayoutAvailable(viewport)) return null;
        const panel = overlayPreview.computePanelRect(viewport);
        const slots = overlayPreview.computeSlots(panel, { viewportWidth: viewport.width });
        const rect = overlayPreview.splitPreviewSlot(slots.preview).viewport;
        return { left: rect.x, top: rect.y, width: rect.width, height: rect.height };
    });
    const href = "https://canvas.emory.edu/courses/1";
    const stack = [{ state: null, url: href }];
    let index = 0;
    const listeners = new Map();
    const location = { href };
    // Captured rather than real, so the context-invalidation poll can be fired
    // on demand instead of waiting two seconds.
    const intervals = [];
    windowRef = {
        innerWidth: 1000,
        innerHeight: 800,
        scrollX: 0,
        scrollY: 0,
        scrollTo(x, y) { this.scrollX = x; this.scrollY = y; },
        setInterval(handler, ms) { intervals.push({ handler, ms }); return intervals.length; },
        clearInterval(id) { if (id >= 1 && id <= intervals.length) intervals[id - 1] = null; },
        matchMedia: () => ({ matches: reducedMotion }),
        location,
        history: {
            get state() { return stack[index].state; },
            pushState(state, _title, url) {
                stack.splice(index + 1);
                const nextUrl = typeof url === "string" && url ? url : location.href;
                stack.push({ state, url: nextUrl });
                index = stack.length - 1;
                location.href = nextUrl;
            },
            back() {
                if (index === 0) return;
                index -= 1;
                location.href = stack[index].url;
                const event = { state: stack[index].state };
                for (const handler of [...(listeners.get("popstate") || [])]) handler(event);
            }
        },
        addEventListener(type, handler) {
            if (!listeners.has(type)) listeners.set(type, []);
            listeners.get(type).push(handler);
        },
        removeEventListener(type, handler) {
            const handlers = listeners.get(type) || [];
            listeners.set(type, handlers.filter((entry) => entry !== handler));
        },
        dispatch(type, event = {}) {
            for (const handler of [...(listeners.get(type) || [])]) handler(event);
        },
        listenerCount(type) { return (listeners.get(type) || []).length; }
    };
    doc.querySelectorAll = (selector) => {
        if (selector !== "a[href]") return [];
        return ["/", "/courses", "/calendar", "/conversations", "/courses/1"].map((path) => ({
            getAttribute(name) { return name === "href" ? path : null; },
            click() {
                const next = path === "/" ? "https://canvas.emory.edu/" : `https://canvas.emory.edu${path}`;
                windowRef.history.pushState({ canvas: "preview" }, "", next);
            }
        }));
    };
    const store = {};
    if (fullscreenStored !== undefined) store[overlayHost.FULLSCREEN_KEY] = fullscreenStored;
    const chromeApi = {
        runtime: {
            id: "test-id",
            getURL: (value) => `${EXTENSION_ORIGIN}/${String(value).replace(/^\//, "")}`
        },
        storage: {
            local: {
                async get(key) {
                    const name = typeof key === "string" ? key : Array.isArray(key) ? key[0] : Object.keys(key || {})[0];
                    return { [name]: store[name] };
                },
                async set(values) { Object.assign(store, values); }
            }
        }
    };
    return { doc, windowRef, chromeApi, store, intervals };
}

const authoritativeDrafts = new WeakMap();

function createHost(options = {}) {
    const environment = makeEnvironment(options);
    let host;
    host = overlayHost.createOverlayHost({
        documentRef: environment.doc,
        windowRef: environment.windowRef,
        chromeApi: environment.chromeApi,
        readyTimeoutMs: options.readyTimeoutMs,
        draftStateResolver: options.draftStateResolver || (() => ({ ok: true, draft: authoritativeDrafts.get(host) === true })),
        sessionTokenFactory: options.sessionTokenFactory
    });
    authoritativeDrafts.set(host, false);
    return { ...environment, host };
}

function shellNodes(doc) {
    const container = doc.documentElement.children.find((node) => node.getAttribute("id") === overlayHost.ROOT_ID);
    const root = container?.shadow || container;
    const overlay = root?.children.find((node) => node.className === "overlay");
    return {
        container,
        overlay,
        backdrop: overlay?.children.find((node) => node.className === "backdrop"),
        panel: overlay?.children.find((node) => node.className === "panel"),
        fill: overlay?.children.find((node) => node.className === "panel")?.children.find((node) => node.className === "panel-fill"),
        stage: overlay?.children.find((node) => node.className === "panel")?.children.find((node) => node.className === "stage"),
        preview: overlay?.children.find((node) => node.className === "panel")?.children.find((node) => node.className === "preview"),
        previewViewport: overlay?.children.find((node) => node.className === "panel")?.children
            .find((node) => node.className === "preview")?.children.find((node) => node.className === "preview-viewport"),
        frame: overlay?.children.find((node) => node.className === "panel")?.children.find((node) => node.className === "stage")?.children[0],
        frameState: overlay?.children.find((node) => node.className === "panel")?.children.find((node) => node.className === "stage")?.children[1]
    };
}

function signalReady(host, payload = {}) {
    return host.handleControl("ready", { ...payload, overlaySession: host.overlaySession });
}

const draftSequences = new WeakMap();

function control(host, action, payload = {}) {
    const nextPayload = { ...payload, overlaySession: host.overlaySession };
    if (action === "draft-state" && !Object.prototype.hasOwnProperty.call(nextPayload, "sequence")) {
        const sequence = (draftSequences.get(host) || 0) + 1;
        if (host.readiness === "ready") draftSequences.set(host, sequence);
        nextPayload.sequence = sequence;
    }
    const result = host.handleControl(action, nextPayload);
    if (action === "draft-state" && result?.ok === true) authoritativeDrafts.set(host, payload.draft === true);
    return result;
}

function cssRule(selector) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return overlayHost.SHELL_CSS.match(new RegExp(`${escaped} \\{([^}]*)\\}`))?.[1] || "";
}

test("the embedded frame URL reuses popup.html with query-only state so the router's exact-page gate still passes", () => {
    const { chromeApi } = makeEnvironment();
    const url = new URL(overlayHost.frameUrl(chromeApi, {
        tabId: 12,
        category: "appearance",
        parentOrigin: "https://canvas.emory.edu/courses/1"
    }));

    assert.equal(`${url.protocol}//${url.host}`, EXTENSION_ORIGIN);
    assert.equal(url.pathname, "/html/popup.html");
    assert.equal(url.hash, "");
    assert.equal(url.searchParams.get("embedded"), "1");
    assert.equal(url.searchParams.get("sourceCanvasTabId"), "12");
    assert.equal(url.searchParams.get("category"), "appearance");
    assert.equal(url.searchParams.get("overlaySession"), null);
    assert.equal(url.searchParams.get("overlayParentOrigin"), "https://canvas.emory.edu");
});

test("recovered ready sessions close cleanly, protect dirty edits, and retain unavailable recovery", async () => {
    const cases = [
        { name: "clean", resolver: () => ({ ok: true, draft: false }), expected: "closing", open: false, confirms: 0 },
        { name: "dirty", resolver: () => ({ ok: true, draft: true }), expected: "OVERLAY_DRAFT_PENDING", open: true, confirms: 1 },
        { name: "unresponsive", resolver: () => ({ ok: false, code: "OVERLAY_DRAFT_STATE_UNAVAILABLE" }), expected: "OVERLAY_DRAFT_STATE_UNAVAILABLE", open: true, confirms: 0 }
    ];

    for (const scenario of cases) {
        const { doc, host, windowRef } = createHost({ draftStateResolver: scenario.resolver });
        let confirms = 0;
        windowRef.confirm = () => { confirms += 1; return false; };
        host.open({ tabId: 84 });
        const firstSession = host.overlaySession;
        const retried = host.handleControl("retry", { overlaySession: firstSession });
        assert.notEqual(retried.overlaySession, firstSession, `${scenario.name}: retry rotates the frame capability`);
        assert.equal(signalReady(host).state, "ready", `${scenario.name}: recovered child is ready`);

        const result = await host.close("escape");
        assert.equal(result.code || result.state, scenario.expected, `${scenario.name}: Escape reaches the host close path`);
        assert.equal(host.isOpen(), scenario.open, `${scenario.name}: close state is preserved`);
        assert.equal(confirms, scenario.confirms, `${scenario.name}: only known dirty state prompts`);
        if (scenario.name === "unresponsive") {
            assert.equal(shellNodes(doc).stage.children.find((node) => node.className === "draft-recovery").hidden, false);
        }
    }
});

test("overlay sessions use cryptographic entropy and fail closed when entropy is unavailable", () => {
    const uuid = "12345678-1234-4123-8123-123456789abc";
    assert.equal(overlayHost.createOverlaySessionToken({ randomUUID: () => uuid }), `overlay-${uuid}`);

    let randomCalls = 0;
    const fallback = overlayHost.createOverlaySessionToken({
        getRandomValues(bytes) {
            randomCalls += 1;
            bytes.forEach((_, index) => { bytes[index] = index + 1; });
            return bytes;
        }
    });
    assert.equal(randomCalls, 1);
    assert.match(fallback, /^overlay-[0-9a-f]{48}$/);
    assert.throws(() => overlayHost.createOverlaySessionToken({}), { code: "OVERLAY_SESSION_ENTROPY_UNAVAILABLE" });
    assert.throws(() => overlayHost.createOverlaySessionToken({ getRandomValues() { throw new Error("entropy failed"); } }), { code: "OVERLAY_SESSION_ENTROPY_UNAVAILABLE" });

    const { doc, host, windowRef } = createHost({
        sessionTokenFactory: () => overlayHost.createOverlaySessionToken({})
    });
    assert.deepEqual(host.open({ tabId: 8 }), {
        ok: false,
        state: "closed",
        code: "OVERLAY_SESSION_ENTROPY_UNAVAILABLE"
    });
    assert.equal(host.isOpen(), false);
    assert.equal(windowRef.history.state, null);
    assert.notEqual(doc.body.inert, true);
    assert.equal(doc.body.style.getPropertyValue("transform"), "");
    assert.equal(shellNodes(doc).overlay.hidden, true);
});

test("frame URL rejects unsafe categories and non-positive tab ids rather than passing them through", () => {
    const { chromeApi } = makeEnvironment();

    for (const category of ["../escape", "Appearance", "a".repeat(41), "", null, 7]) {
        assert.equal(overlayHost.safeCategory(category), null, String(category));
        assert.equal(new URL(overlayHost.frameUrl(chromeApi, { category })).searchParams.has("category"), false);
    }
    for (const tabId of [0, -3, 1.5, "12", null]) {
        assert.equal(new URL(overlayHost.frameUrl(chromeApi, { tabId })).searchParams.has("sourceCanvasTabId"), false);
    }
});

test("the shell mounts once into a closed shadow root and opens as an opaque full-viewport workspace", () => {
    const { doc, host } = createHost();
    const result = host.open({ tabId: 8, category: "themes" });

    assert.deepEqual(result, { ok: true, state: "open", reopened: false, cold: true, frameReused: false, fullscreen: true, preview: true });
    assert.deepEqual(host.lastOpen, { cold: true, frameReused: false, reopened: false });
    const { container, overlay, backdrop, panel, frame, frameState, stage, preview } = shellNodes(doc);
    assert.ok(container.shadow, "shell is isolated in a shadow root, not the Canvas cascade");
    assert.equal(overlay.getAttribute("data-state"), "open");
    assert.equal(overlay.getAttribute("data-fullscreen"), "true");
    assert.equal(overlay.getAttribute("data-preview"), "on");
    assert.equal(overlay.getAttribute("data-reduced-motion"), "false");
    assert.equal(overlay.hidden, false);
    assert.ok(backdrop, "backdrop scrim exists");
    assert.equal(panel.getAttribute("role"), "dialog");
    assert.equal(panel.getAttribute("aria-modal"), "true");
    assert.ok(stage, "settings iframe lives in the left host slot");
    assert.ok(preview, "preview viewport is host-rendered, not inside the iframe");
    assert.equal(preview.getAttribute("data-preview-slot"), "canvas");
    assert.equal(new URL(frame.getAttribute("src")).searchParams.get("category"), "themes");
    assert.equal(new URL(frame.getAttribute("src")).searchParams.get("overlaySession"), host.overlaySession);
    assert.equal(host.readiness, "loading");
    assert.equal(frame.getAttribute("aria-hidden"), "true");
    assert.equal(frame.focusCount, 0);
    assert.equal(frameState.focusCount, 1);

    // Full-viewport geometry and motion are declarative, so assert the contract the CSS encodes.
    assert.deepEqual(overlayHost.FULL_VIEWPORT_INSET, { block: 0, inline: 0 });
    assert.deepEqual(overlayHost.WINDOWED_INSET, overlayHost.FULL_VIEWPORT_INSET);
    assert.equal(overlayHost.WINDOWED_RADIUS, 16);
    assert.equal(overlayHost.OPEN_DURATION, 340);
    assert.equal(overlayHost.CLOSE_DURATION, 180);
    assert.match(overlayHost.SHELL_CSS, /:host \{[\s\S]*position: fixed;[\s\S]*inset: 0;[\s\S]*width: 100vw;[\s\S]*height: 100vh;[\s\S]*z-index: 2147483647;[\s\S]*display: block;[\s\S]*overflow: hidden;/);
    assert.match(overlayHost.SHELL_CSS, /\.overlay \{[\s\S]*inset: 0;[\s\S]*overflow: hidden;/);
    assert.doesNotMatch(cssRule(".overlay"), /background(?:-color)?:\s*#0a0f22/);
    assert.match(overlayHost.SHELL_CSS, /\.backdrop \{[\s\S]*inset: 0;[\s\S]*background: #0a0f22;[\s\S]*pointer-events: auto;/);
    assert.doesNotMatch(overlayHost.SHELL_CSS, /\.backdrop \{[^}]*color-mix/);
    assert.doesNotMatch(overlayHost.SHELL_CSS, /backdrop-filter:\s*blur/);
    assert.match(overlayHost.SHELL_CSS, /\.panel \{[\s\S]*inset: 0;[\s\S]*border-radius: 0;[\s\S]*box-shadow: none;[\s\S]*pointer-events: none;/);
    assert.doesNotMatch(cssRule(".panel"), /background(?:-color)?:\s*#0a0f22/);
    assert.match(cssRule(".panel-fill"), /background:\s*#0a0f22/);
    assert.doesNotMatch(cssRule(".stage"), /background(?:-color)?:\s*#0a0f22/);
    assert.match(overlayHost.SHELL_CSS, /\.stage,[\s\S]*\.preview \{[\s\S]*pointer-events: auto;/);
    assert.match(overlayHost.SHELL_CSS, /transform: scale\(\.12\)/);
    assert.match(overlayHost.SHELL_CSS, /grid-template-columns: minmax\(clamp\(520px, 52%, 760px\), 52fr\) minmax\(0, 48fr\)/);
    assert.match(overlayHost.SHELL_CSS, /@container overlay-shell \(max-width: 719\.98px\)/);
    assert.match(overlayHost.SHELL_CSS, /column-gap: clamp\(24px, 4vw, 64px\)/);
    assert.match(overlayHost.SHELL_CSS, /padding: 16px 16px 16px calc\(16px \+ clamp\(0px, 3vw, 48px\)\)/);
    assert.match(cssRule(".preview-toolbar"), /border-radius:\s*12px/, "preview utility chrome uses the Nest card radius token");
    assert.doesNotMatch(overlayHost.SHELL_CSS, /justify-content: space-between/);
    assert.doesNotMatch(overlayHost.SHELL_CSS, /\[data-fullscreen="true"\] \.panel/);
    assert.doesNotMatch(overlayHost.SHELL_CSS, /505px/);
    assert.match(overlayHost.SHELL_CSS, /\[data-preview="off"\] \.panel \{[\s\S]*grid-template-columns: minmax\(0, 1fr\)/);
    assert.match(overlayHost.SHELL_CSS, /@container overlay-shell \(max-width: 719\.98px\)[\s\S]*grid-template-columns: minmax\(0, 1fr\)[\s\S]*\.preview \{ display: none; \}/);

    host.open({ tabId: 8 });
    assert.equal(doc.documentElement.children.filter((node) => node.getAttribute("id") === overlayHost.ROOT_ID).length, 1);
    assert.deepEqual(host.lastOpen, { cold: false, frameReused: true, reopened: true });
});

test("host stays visibly loading until the active iframe session reports ready", () => {
    const { doc, host } = createHost();
    host.open({ tabId: 8, category: "overview" });
    const { frame, frameState } = shellNodes(doc);
    const session = host.overlaySession;

    assert.equal(host.readiness, "loading");
    assert.equal(frameState.hidden, false);
    assert.equal(frameState.getAttribute("role"), "status");
    assert.equal(frame.getAttribute("tabindex"), "-1");
    assert.equal(control(host, "focus", { target: "frame" }).code, "OVERLAY_ACTION_STATE_INVALID");

    assert.equal(host.handleControl("ready", { overlaySession: session }).state, "ready");
    assert.equal(host.readiness, "ready");
    assert.equal(frameState.hidden, true);
    assert.equal(frame.getAttribute("aria-hidden"), null);
    assert.equal(frame.getAttribute("tabindex"), "0");
    assert.equal(frame.focusCount, 1);
});

test("the fixed shadow host leaves page hit testing alone while closed or closing", async () => {
    const { doc, host } = createHost({ reducedMotion: true });

    // Mounting the shell must not create a full-viewport click shield before
    // the first open, even though the root is retained for warm reopens.
    host.open({ tabId: 8 });
    const { container, overlay } = shellNodes(doc);
    assert.equal(container.style.getPropertyValue("pointer-events"), "auto");
    assert.equal(overlay.hidden, false);

    assert.equal((await host.close("backdrop")).state, "closing");
    assert.equal(container.style.getPropertyValue("pointer-events"), "none");
    assert.equal(overlay.getAttribute("data-state"), "closing");

    await new Promise((resolve) => setTimeout(resolve, overlayHost.REDUCED_DURATION + 20));
    assert.equal(overlay.hidden, true);
    assert.equal(container.style.getPropertyValue("pointer-events"), "none");

    // A warm reopen restores hit testing only for the active overlay and a
    // repeated close returns the retained host to the inert state.
    host.open({ tabId: 8 });
    assert.equal(container.style.getPropertyValue("pointer-events"), "auto");
    assert.equal((await host.close("escape")).state, "closing");
    assert.equal((await host.close("escape")).state, "closing");
    await new Promise((resolve) => setTimeout(resolve, overlayHost.REDUCED_DURATION + 20));
    assert.equal(container.style.getPropertyValue("pointer-events"), "none");
});

test("closing an unavailable workspace clears its host recovery layer before a later category open", async () => {
    const { doc, host } = createHost();
    host.open({ tabId: 8, category: "overview" });
    const failedFrame = shellNodes(doc).frame;
    assert.equal(host.handleControl("error", { overlaySession: host.overlaySession, code: "POPUP_INIT_FAILED" }).state, "error");
    assert.equal(shellNodes(doc).frameState.hidden, false, "the host owns the unavailable state while that iframe is active");

    assert.equal((await host.close("toolbar-close")).state, "closing");
    assert.equal(failedFrame.getAttribute("src"), "about:blank", "close revokes the failed iframe instead of retaining its extension document");
    assert.equal(shellNodes(doc).frameState.hidden, true, "close retires Workspace unavailable synchronously, before its visual transition ends");

    host.open({ tabId: 8, category: "canvas-search" });
    const { frame, frameState } = shellNodes(doc);
    assert.notEqual(frame, failedFrame, "the next category uses a fresh iframe capability");
    assert.equal(new URL(frame.getAttribute("src")).searchParams.get("category"), "canvas-search");
    assert.equal(frameState.children[0].textContent, "Loading APStudyCanvas", "a prior host failure cannot strand recovery copy over the new workspace");
    assert.equal(signalReady(host).state, "ready");
    assert.equal(frameState.hidden, true, "the ready replacement has no recovery layer left behind");
});

test("Escape remains host-owned while a replacement workspace is loading", async () => {
    const { doc, host, windowRef } = createHost();
    const originalUrl = windowRef.location.href;
    host.open({ tabId: 8, category: "overview" });

    let prevented = 0;
    let stopped = 0;
    doc.dispatch("keydown", {
        key: "Escape",
        preventDefault() { prevented += 1; },
        stopPropagation() { stopped += 1; }
    });

    assert.equal(prevented, 1, "the browser cannot apply Escape navigation behind the loading shell");
    assert.equal(stopped, 1, "Escape does not leak from the overlay host");
    assert.equal((await host.close("escape")).state, "closing", "the in-flight close remains idempotent");
    assert.equal(windowRef.location.href, originalUrl, "closing a loading replacement never changes the Canvas route");
});

test("a sidebar iframe can complete the existing readiness handshake through its authenticated parent bridge", async () => {
    const { doc, host, windowRef } = createHost();
    host.open({ category: "sidebar" });
    const { frame } = shellNodes(doc);
    const frameWindow = {
        responses: [],
        postMessage(message, targetOrigin) {
            this.responses.push({ message, targetOrigin });
        }
    };
    frame.contentWindow = frameWindow;
    const session = host.overlaySession;
    windowRef.dispatch("message", {
        source: frameWindow,
        origin: EXTENSION_ORIGIN,
        data: {
            type: overlayHost.OVERLAY_BRIDGE_REQUEST_TYPE,
            requestId: "sidebar-ready-1",
            overlaySession: session,
            action: "ready",
            payload: { overlaySession: session }
        }
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(host.readiness, "ready");
    assert.equal(frameWindow.responses.length, 1);
    assert.equal(frameWindow.responses[0].targetOrigin, EXTENSION_ORIGIN);
    assert.deepEqual(frameWindow.responses[0].message.payload.state, "ready");
    assert.equal(frameWindow.responses[0].message.overlaySession, session);
    assert.ok(frame);
});

test("ready and draft-state are distinct authenticated transitions", () => {
    const { host } = createHost();
    host.open({ tabId: 8 });
    const ready = control(host, "ready", { draft: true });

    assert.equal(ready.state, "ready");
    assert.equal(Object.prototype.hasOwnProperty.call(ready, "draft"), false);
    assert.deepEqual(control(host, "draft-state", { draft: true }), { ok: true, state: "ready", draft: true, sequence: 1 });
    assert.equal(control(host, "draft-state", { draft: "yes" }).code, "OVERLAY_DRAFT_STATE_INVALID");
    assert.equal(host.handleControl("draft-state", { overlaySession: host.overlaySession, draft: false }).code, "OVERLAY_DRAFT_STATE_INVALID");
});

test("out-of-order draft state cannot clear newer unsaved-change protection", async () => {
    const { host, windowRef } = createHost();
    windowRef.confirm = () => false;
    host.open({ tabId: 8 });
    signalReady(host);
    const session = host.overlaySession;

    assert.deepEqual(host.handleControl("draft-state", {
        overlaySession: session,
        draft: true,
        sequence: 2
    }), { ok: true, state: "ready", draft: true, sequence: 2 });
    assert.deepEqual(host.handleControl("draft-state", {
        overlaySession: session,
        draft: false,
        sequence: 1
    }), { ok: false, code: "OVERLAY_DRAFT_STATE_STALE", draft: true, sequence: 2 });
    authoritativeDrafts.set(host, true);
    assert.deepEqual(await host.close("escape"), { ok: false, code: "OVERLAY_DRAFT_PENDING", state: "open" });
});

test("host timeout keeps an opaque recovery panel with retry and workspace fallback", async () => {
    const { doc, host } = createHost({ readyTimeoutMs: 15 });
    host.open({ tabId: 9, category: "appearance" });
    const firstSession = host.overlaySession;
    await new Promise((resolve) => setTimeout(resolve, 30));

    const { frameState } = shellNodes(doc);
    const actions = frameState.children[2];
    const retry = actions.children[0];
    const fallback = actions.children[1];
    assert.equal(host.readiness, "error");
    assert.equal(frameState.hidden, false);
    assert.equal(frameState.getAttribute("role"), "alert");
    assert.equal(actions.hidden, false);
    assert.equal(retry.focusCount, 1, "timeout moves focus to the recovery action");
    assert.match(fallback.getAttribute("href"), /popup\.html\?view=workspace&category=appearance/);
    assert.equal(fallback.getAttribute("target"), "_blank");

    retry.dispatch("click");
    assert.equal(host.readiness, "loading");
    assert.equal(frameState.focusCount, 2, "retry returns focus to the loading status");
    assert.notEqual(host.overlaySession, firstSession);
    assert.equal(new URL(host.frameSrc).searchParams.get("overlaySession"), host.overlaySession);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(host.readiness, "error", "a retry that receives no handshake becomes recoverable again");

    const readyCase = createHost({ readyTimeoutMs: 15 });
    readyCase.host.open({ tabId: 10 });
    signalReady(readyCase.host);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(readyCase.host.readiness, "ready", "ready cancels the pending timeout");
    assert.equal(shellNodes(readyCase.doc).frameState.hidden, true);
});

test("close before ready cancels loading and ignores the abandoned session", async () => {
    const { doc, host } = createHost({ readyTimeoutMs: 15 });
    host.open({ tabId: 10 });
    const abandoned = host.overlaySession;
    await host.close("programmatic");
    assert.equal(host.readiness, "closed");
    assert.equal(shellNodes(doc).frame.getAttribute("src"), "about:blank");
    assert.equal(host.handleControl("ready", { overlaySession: abandoned }).code, "OVERLAY_SESSION_STALE");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.notEqual(host.readiness, "error");
});

test("reopen creates a new session and rejects stale ready from the prior open", async () => {
    const { host } = createHost();
    host.open({ tabId: 11 });
    const firstSession = host.overlaySession;
    await host.close("programmatic");
    host.open({ tabId: 11 });
    const secondSession = host.overlaySession;

    assert.notEqual(secondSession, firstSession);
    assert.equal(host.handleControl("ready", { overlaySession: firstSession }).code, "OVERLAY_SESSION_STALE");
    assert.equal(host.readiness, "loading");
    assert.equal(host.handleControl("ready", { overlaySession: secondSession }).state, "ready");
});

test("structured iframe errors replace loading with the same usable recovery panel", () => {
    const { doc, host } = createHost();
    host.open({ tabId: 12 });
    const result = host.handleControl("error", {
        overlaySession: host.overlaySession,
        code: "POPUP_INIT_FAILED",
        recoverable: true
    });
    assert.deepEqual(result, { ok: true, state: "error", code: "POPUP_INIT_FAILED" });
    assert.equal(host.readiness, "error");
    assert.equal(shellNodes(doc).frameState.getAttribute("role"), "alert");
});

test("every iframe control requires the matching active session and the current readiness state", async () => {
    const { host } = createHost();
    host.open({ tabId: 13 });
    const active = host.overlaySession;
    const actions = ["ready", "error", "retry", "draft-state", "close", "discard-close", "fullscreen", "navigate", "zoom", "preview", "focus"];

    for (const action of actions) {
        assert.equal(host.handleControl(action, {}).code, "OVERLAY_SESSION_REQUIRED", `${action}: missing token`);
        assert.equal(host.handleControl(action, { overlaySession: `${active}-stale` }).code, "OVERLAY_SESSION_STALE", `${action}: stale token`);
    }
    for (const action of actions.filter((value) => !["ready", "error", "retry"].includes(value))) {
        assert.equal(host.handleControl(action, { overlaySession: active }).code, "OVERLAY_ACTION_STATE_INVALID", `${action}: loading state`);
    }

    assert.equal(control(host, "retry").state, "loading", "a live session can replace a stalled loading attempt");

    assert.equal(signalReady(host).state, "ready");
    for (const action of ["ready", "error", "retry"]) {
        assert.equal(control(host, action).code, "OVERLAY_ACTION_STATE_INVALID", `${action}: ready state`);
    }
    assert.deepEqual(control(host, "draft-state", { draft: true }), { ok: true, state: "ready", draft: true, sequence: 1 });
    assert.equal(control(host, "fullscreen", { value: true }).fullscreen, true);
    assert.equal(control(host, "navigate", { destination: "calendar" }).ok, true);
    assert.equal(control(host, "zoom", { value: 125 }).zoom, 125);
    assert.equal(control(host, "preview", { enabled: true }).preview, true);
    assert.equal(control(host, "focus", { target: "frame" }).target, "frame");
    authoritativeDrafts.set(host, false);
    assert.equal((await control(host, "close")).state, "closing");
});

test("retry rotates the session and rejects both missing and stale retry credentials", () => {
    const { host } = createHost();
    host.open({ tabId: 14 });
    const first = host.overlaySession;
    assert.equal(control(host, "error", { code: "POPUP_INIT_FAILED" }).state, "error");
    assert.equal(host.handleControl("retry", {}).code, "OVERLAY_SESSION_REQUIRED");
    assert.equal(host.handleControl("retry", { overlaySession: `${first}-stale` }).code, "OVERLAY_SESSION_STALE");

    const retried = host.handleControl("retry", { overlaySession: first });
    assert.equal(retried.state, "loading");
    assert.notEqual(retried.overlaySession, first);
    assert.equal(host.handleControl("ready", { overlaySession: first }).code, "OVERLAY_SESSION_STALE");
    assert.equal(host.handleControl("ready", { overlaySession: retried.overlaySession }).state, "ready");
});

test("retry while loading replaces the dead iframe attempt and ignores every late message", () => {
    const { doc, host } = createHost();
    host.open({ tabId: 15 });
    const firstSession = host.overlaySession;
    const firstFrame = shellNodes(doc).frame;

    const retried = host.handleControl("retry", { overlaySession: firstSession });
    const secondFrame = shellNodes(doc).frame;
    assert.equal(retried.state, "loading");
    assert.notEqual(retried.overlaySession, firstSession);
    assert.notEqual(secondFrame, firstFrame, "retry recreates the extension document instead of retargeting it");
    assert.equal(firstFrame.getAttribute("src"), "about:blank");
    assert.equal(host.handleControl("ready", { overlaySession: firstSession }).code, "OVERLAY_SESSION_STALE");
    assert.equal(host.handleControl("error", { overlaySession: firstSession, code: "POPUP_INIT_FAILED" }).code, "OVERLAY_SESSION_STALE");
    assert.equal(host.readiness, "loading");
    assert.equal(host.handleControl("ready", { overlaySession: retried.overlaySession }).state, "ready");
});

test("rapid retries leave only the newest iframe attempt authoritative", () => {
    const { doc, host } = createHost();
    host.open({ tabId: 16 });
    const first = host.overlaySession;
    const firstFrame = shellNodes(doc).frame;
    // A host-page mutation can detach a dying iframe before the host retries.
    // It remains a retired extension document and must still be revoked.
    const displacedFrames = doc.createElement("div");
    displacedFrames.appendChild(firstFrame);
    const second = host.handleControl("retry", { overlaySession: first });
    const secondFrame = shellNodes(doc).frame;
    const third = host.handleControl("retry", { overlaySession: second.overlaySession });

    assert.equal(host.readiness, "loading");
    assert.notEqual(third.overlaySession, second.overlaySession);
    assert.equal(firstFrame.getAttribute("src"), "about:blank");
    assert.equal(secondFrame.getAttribute("src"), "about:blank");
    assert.equal(host.handleControl("ready", { overlaySession: second.overlaySession }).code, "OVERLAY_SESSION_STALE");
    assert.equal(host.handleControl("ready", { overlaySession: third.overlaySession }).state, "ready");
});

test("session tokens use browser crypto and opening fails closed without secure entropy", () => {
    const uuid = "123e4567-e89b-42d3-a456-426614174000";
    assert.equal(overlayHost.createOverlaySessionToken({ randomUUID: () => uuid }), `overlay-${uuid}`);
    const fallback = overlayHost.createOverlaySessionToken({
        getRandomValues(bytes) {
            bytes.forEach((_, index) => { bytes[index] = index; });
            return bytes;
        }
    });
    assert.match(fallback, /^overlay-[0-9a-f]{48}$/);
    assert.throws(() => overlayHost.createOverlaySessionToken({}), /OVERLAY_SESSION_ENTROPY_UNAVAILABLE/);

    const environment = makeEnvironment();
    const host = overlayHost.createOverlayHost({
        documentRef: environment.doc,
        windowRef: environment.windowRef,
        chromeApi: environment.chromeApi,
        sessionTokenFactory: () => ""
    });
    assert.deepEqual(host.open({ tabId: 15 }), { ok: false, state: "closed", code: "OVERLAY_SESSION_INVALID" });
    const nodes = shellNodes(environment.doc);
    assert.equal(nodes.overlay.hidden, true);
    assert.equal(nodes.container.style.getPropertyValue("pointer-events"), "none");
    assert.equal(nodes.frame.getAttribute("src"), null);
    assert.equal(environment.doc.documentElement.style.getPropertyValue("overflow"), "");
    assert.equal(environment.doc.body.inert, undefined);
    assert.equal(overlayHistory.isOverlayState(environment.windowRef.history.state), false);
});

test("reopening keeps the frame unless the category changes, so a warm overlay does not reload", () => {
    const { doc, host } = createHost();
    host.open({ tabId: 4, category: "sidebar" });
    const first = shellNodes(doc).frame.getAttribute("src");

    assert.deepEqual(host.open({ tabId: 4 }), { ok: true, state: "open", reopened: true, cold: false, frameReused: true, fullscreen: true, preview: true });
    assert.equal(shellNodes(doc).frame.getAttribute("src"), first);

    const switched = host.open({ tabId: 4, category: "calendar-accounts" });
    assert.equal(switched.cold, false);
    assert.equal(switched.frameReused, false);
    assert.notEqual(shellNodes(doc).frame.getAttribute("src"), first);
    assert.equal(host.category, "calendar-accounts");
});

test("a close-then-open cycle reuses only the shell and creates a fresh iframe browsing context", async () => {
    const { doc, host } = createHost();
    const first = host.open({ tabId: 4, category: "sidebar" });
    assert.equal(first.cold, true);
    const { container, frame } = shellNodes(doc);
    const src = frame.getAttribute("src");
    const session = host.overlaySession;
    assert.equal(signalReady(host).state, "ready");

    await host.close("programmatic");
    assert.equal(frame.getAttribute("src"), "about:blank", "close navigates the iframe to about:blank so reopen starts clean");
    assert.equal(host.overlaySession, null);
    assert.equal(host.handleControl("ready", { overlaySession: session }).code, "OVERLAY_SESSION_STALE");
    await new Promise((resolve) => setTimeout(resolve, overlayHost.CLOSE_DURATION + 20));
    assert.equal(shellNodes(doc).overlay.hidden, true);

    const second = host.open({ tabId: 4, category: "sidebar" });
    assert.deepEqual(second, { ok: true, state: "open", reopened: false, cold: false, frameReused: false, fullscreen: false, preview: true });
    assert.deepEqual(host.lastOpen, { cold: false, frameReused: false, reopened: false });
    assert.equal(shellNodes(doc).container, container);
    assert.notEqual(shellNodes(doc).frame, frame, "reopen replaces the settling about:blank iframe before minting the new session");
    assert.equal(frame.getAttribute("src"), "about:blank", "the replacement never restores a retired iframe capability");
    assert.notEqual(host.overlaySession, session);
    assert.notEqual(shellNodes(doc).frame.getAttribute("src"), src);
    assert.equal(new URL(shellNodes(doc).frame.getAttribute("src")).searchParams.get("overlaySession"), host.overlaySession);
});

test("repeated button and Escape closes mint isolated sessions while retry remains bounded", async () => {
    const { doc, host } = createHost();
    const sessions = [];
    const frames = [];

    for (let cycle = 0; cycle < 3; cycle += 1) {
        host.open({ tabId: 44, category: "appearance" });
        const openedSession = host.overlaySession;
        const openedFrame = shellNodes(doc).frame;
        sessions.push(openedSession);
        frames.push(openedFrame);

        if (cycle === 0) {
            // The host-owned recovery button must rotate only this attempt,
            // then the replacement document becomes the sole ready authority.
            host.handleControl("error", { overlaySession: openedSession, code: "POPUP_INIT_FAILED", recoverable: true });
            shellNodes(doc).frameState.children[2].children[0].dispatch("click");
            assert.notEqual(host.overlaySession, openedSession);
            assert.equal(openedFrame.getAttribute("src"), "about:blank", "retry revokes the failed iframe before its replacement can register");
            assert.equal(host.handleControl("ready", { overlaySession: openedSession }).code, "OVERLAY_SESSION_STALE");
            sessions.push(host.overlaySession);
        }

        const activeSession = host.overlaySession;
        assert.equal(host.handleControl("ready", { overlaySession: activeSession }).state, "ready");
        for (const staleSession of sessions.filter((session) => session !== activeSession)) {
            assert.equal(host.handleControl("ready", { overlaySession: staleSession }).code, "OVERLAY_SESSION_STALE");
            assert.equal(host.handleControl("error", { overlaySession: staleSession, code: "POPUP_INIT_FAILED" }).code, "OVERLAY_SESSION_STALE");
        }

        if (cycle % 2 === 0) {
            doc.dispatch("keydown", { key: "Escape", stopPropagation() {} });
            await new Promise((resolve) => setTimeout(resolve, 0));
        } else {
            await host.handleControl("close", { overlaySession: activeSession });
        }
        assert.equal(host.overlaySession, null);
        assert.equal(openedFrame.getAttribute("src"), "about:blank");
    }

    assert.equal(new Set(sessions).size, sessions.length);
    assert.equal(new Set(frames).size, frames.length, "each close/reopen has an independent iframe registration");
});

test("the launch origin drives the scale-up transform origin and falls back to the toolbar corner", () => {
    const { doc, host } = createHost();
    host.open({ launchOrigin: { x: 500, y: 40 } });
    const { panel } = shellNodes(doc);
    assert.equal(panel.style.getPropertyValue("--apsc-origin-x"), "50%");
    assert.equal(panel.style.getPropertyValue("--apsc-origin-y"), "40px");

    host.open({ launchOrigin: null });
    assert.equal(panel.style.getPropertyValue("--apsc-origin-x"), "99%");
    assert.equal(panel.style.getPropertyValue("--apsc-origin-y"), "0px");
});

test("reduced motion is resolved per open rather than cached at mount", () => {
    const environment = makeEnvironment();
    let reduced = false;
    environment.windowRef.matchMedia = () => ({ matches: reduced });
    const host = overlayHost.createOverlayHost({
        documentRef: environment.doc,
        windowRef: environment.windowRef,
        chromeApi: environment.chromeApi
    });

    host.open({});
    assert.equal(shellNodes(environment.doc).overlay.getAttribute("data-reduced-motion"), "false");
    reduced = true;
    host.open({});
    assert.equal(shellNodes(environment.doc).overlay.getAttribute("data-reduced-motion"), "true");
    assert.match(overlayHost.SHELL_CSS, /\[data-reduced-motion="true"\][\s\S]*transform: none/);
    assert.match(overlayHost.SHELL_CSS, /\[data-reduced-motion="true"\] \.backdrop \{[\s\S]*backdrop-filter: none/);
    assert.doesNotMatch(overlayHost.SHELL_CSS, /backdrop-filter:\s*blur/);
    assert.doesNotMatch(overlayHost.SHELL_CSS, /\.panel \{[^}]*backdrop-filter/);
    assert.doesNotMatch(overlayHost.SHELL_CSS, /\.preview \{[^}]*backdrop-filter/);
    assert.doesNotMatch(overlayHost.SHELL_CSS, /\.preview-toolbar \{[^}]*backdrop-filter/);
});

test("the preview column reserves a static toolbar row above the clipped live viewport", () => {
    const { doc, host } = createHost();
    host.open({});
    const { preview } = shellNodes(doc);
    const toolbar = preview.children.find((node) => node.className === "preview-toolbar");
    const viewport = preview.children.find((node) => node.className === "preview-viewport");

    assert.ok(toolbar, "the zoom toolbar is host-rendered in the shadow root, not inside the settings iframe");
    assert.equal(preview.children.indexOf(toolbar), 0, "the toolbar owns grid row 1");
    assert.equal(preview.children.indexOf(viewport), 1, "the live Canvas viewport owns grid row 2");
    assert.ok(
        viewport.children.some((node) => node.className === "preview-shield"),
        "the click shield lives inside the clipped viewport, so it cannot cover the toolbar"
    );
    assert.deepEqual(toolbar.children.map((node) => node.className), [
        "preview-zoom-out",
        "preview-zoom-value",
        "preview-zoom-in",
        "preview-toolbar-divider",
        "preview-page-label",
        "preview-zoom-reset",
        "preview-toolbar-end"
    ]);

    assert.match(overlayHost.SHELL_CSS, /\.preview \{[^}]*grid-template-rows: minmax\(52px, max-content\) 1fr/);
    assert.match(overlayHost.SHELL_CSS, /\.preview \{[^}]*gap: 8px/);
    assert.match(overlayHost.SHELL_CSS, /\.preview \{[^}]*margin-top: 58px/);
    assert.doesNotMatch(overlayHost.SHELL_CSS, /\.preview-toolbar \{[^}]*position: absolute/);
    assert.match(overlayHost.SHELL_CSS, /\.preview-viewport \{[^}]*border-radius: 16px/);
    assert.match(overlayHost.SHELL_CSS, /\.preview-viewport \{[^}]*overflow: hidden/);
    assert.match(overlayHost.SHELL_CSS, /\.preview-toolbar button \{[^}]*min-height: 48px/);
    assert.match(overlayHost.SHELL_CSS, /\.preview-toolbar button \{[^}]*min-width: 48px/);
    assert.match(overlayHost.SHELL_CSS, /\.preview-toolbar select \{[^}]*min-height: 40px/);
    assert.match(overlayHost.SHELL_CSS, /\.preview-toolbar \{[^}]*flex-wrap: wrap/);
    assert.match(overlayHost.SHELL_CSS, /\.preview-toolbar \{[^}]*min-height: 52px/);
    assert.match(overlayHost.SHELL_CSS, /\.preview-toolbar select:focus-visible \{[^}]*outline: 2px solid #D4AF37/);
    assert.match(overlayHost.SHELL_CSS, /\.preview-toolbar-end \{[^}]*margin-left: auto/);
});

test("the Theming switch renders only when a caller injects it, and lands last in the toolbar", () => {
    const bare = createHost();
    bare.host.open({});
    const bareEnd = shellNodes(bare.doc).preview.children
        .find((node) => node.className === "preview-toolbar")
        .children.find((node) => node.className === "preview-toolbar-end");
    assert.deepEqual(bareEnd.children, [], "with no injected themeToggle the host renders no switch");

    const environment = makeEnvironment();
    const toggled = [];
    const host = overlayHost.createOverlayHost({
        documentRef: environment.doc,
        windowRef: environment.windowRef,
        chromeApi: environment.chromeApi,
        themeToggle: { label: "Theming", pressed: false, onToggle: (value) => toggled.push(value) }
    });
    host.open({});
    const end = shellNodes(environment.doc).preview.children
        .find((node) => node.className === "preview-toolbar")
        .children.find((node) => node.className === "preview-toolbar-end");
    const switchNode = end.children[0];
    assert.equal(switchNode.getAttribute("role"), "switch");
    assert.equal(switchNode.getAttribute("aria-checked"), "false");

    switchNode.dispatch("click", {});
    assert.equal(switchNode.getAttribute("aria-checked"), "true");
    assert.deepEqual(toggled, [true]);

    signalReady(host);
    assert.equal(control(host, "focus", { target: "toolbar-end" }).ok, true);
    assert.equal(switchNode.focusCount, 1, "the switch is the last toolbar stop before Tab wraps to the frame");
    assert.match(overlayHost.SHELL_CSS, /\.preview-theme-switch \{[^}]*border-radius: 999px/);
    assert.match(overlayHost.SHELL_CSS, /\[aria-checked="true"\] \.preview-theme-switch-track \{[^}]*#D4AF37/);
});

// Phase 7. Tab order runs rail -> settings column -> toolbar -> back to the frame.
// The frame is DOM-first and the toolbar second, so the browser walks the iframe's
// own contents before the toolbar; the wrap is what closes the loop, and it only
// closes correctly if the list toolbarControls() returns is genuinely the toolbar's
// focusable nodes in DOM order. The in-iframe toolbar is gone, so this list is the
// only owner.
function focusableToolbarClasses(doc) {
    const toolbar = shellNodes(doc).preview.children.find((node) => node.className === "preview-toolbar");
    const focusable = [];
    const walk = (node) => {
        if (["BUTTON", "SELECT"].includes(node.tagName)) focusable.push(node.className || node.tagName.toLowerCase());
        node.children.forEach(walk);
    };
    toolbar.children.forEach(walk);
    return focusable;
}

test("toolbarControls matches the toolbar's DOM focus order and Tab wraps from its last stop to the frame", () => {
    // Without an injected theme switch the last stop is Reset.
    const bare = createHost();
    bare.host.open({});
    assert.deepEqual(focusableToolbarClasses(bare.doc), [
        "preview-zoom-out",
        "preview-zoom-in",
        "preview-page",
        "preview-zoom-reset"
    ]);

    const environment = makeEnvironment();
    const host = overlayHost.createOverlayHost({
        documentRef: environment.doc,
        windowRef: environment.windowRef,
        chromeApi: environment.chromeApi,
        themeToggle: { label: "Theming", pressed: false, onToggle: () => {} }
    });
    host.open({});
    signalReady(host);
    const order = focusableToolbarClasses(environment.doc);
    assert.deepEqual(order, [
        "preview-zoom-out",
        "preview-zoom-in",
        "preview-page",
        "preview-zoom-reset",
        "preview-theme-switch"
    ]);

    const nodes = shellNodes(environment.doc);
    nodes.overlay.setAttribute("data-preview", "on");
    const toolbar = nodes.preview.children.find((node) => node.className === "preview-toolbar");
    const end = toolbar.children.find((node) => node.className === "preview-toolbar-end").children[0];
    const reset = toolbar.children.find((node) => node.className === "preview-zoom-reset");

    // Focusing "end" must land on the same node the DOM walk says is last.
    assert.equal(control(host, "focus", { target: "toolbar-end" }).target, "toolbar-end");
    assert.equal(end.className, order[order.length - 1]);
    assert.equal(end.focusCount, 1);

    // Tab from that last stop wraps to the frame; Tab from any earlier stop does
    // not, and Shift+Tab never wraps forward.
    const framesBefore = nodes.frame.focusCount;
    const shadow = nodes.container.shadow;
    shadow.activeElement = end;
    let prevented = 0;
    nodes.overlay.dispatch("keydown", {
        key: "Tab",
        shiftKey: false,
        preventDefault: () => { prevented += 1; },
        stopPropagation: () => {}
    });
    assert.equal(nodes.frame.focusCount, framesBefore + 1, "Tab from the last toolbar stop wraps to the settings frame");
    assert.equal(prevented, 1);

    shadow.activeElement = reset;
    nodes.overlay.dispatch("keydown", {
        key: "Tab",
        shiftKey: false,
        preventDefault: () => { prevented += 1; },
        stopPropagation: () => {}
    });
    assert.equal(nodes.frame.focusCount, framesBefore + 1, "Tab from a mid-toolbar stop stays inside the toolbar");

    shadow.activeElement = end;
    nodes.overlay.dispatch("keydown", {
        key: "Tab",
        shiftKey: true,
        preventDefault: () => { prevented += 1; },
        stopPropagation: () => {}
    });
    assert.equal(nodes.frame.focusCount, framesBefore + 1, "Shift+Tab is the iframe bridge's direction, not the wrap's");

    // Preview off means no toolbar stops at all, so nothing can wrap.
    nodes.overlay.setAttribute("data-preview", "off");
    assert.equal(control(host, "focus", { target: "toolbar-end" }).code, "PREVIEW_INACTIVE");
});

test("closing runs the exit transition, then hides the shell and restores every host mutation", async () => {
    const { doc, host, windowRef } = createHost();
    const trigger = doc.activeElement;
    doc.documentElement.style.setProperty("overflow", "scroll");
    windowRef.scrollX = 40;
    windowRef.scrollY = 90;

    host.open({ tabId: 3 });
    signalReady(host);
    assert.equal(doc.documentElement.style.getPropertyValue("overflow"), "hidden");
    assert.equal(doc.body.style.getPropertyValue("overflow"), "hidden");
    assert.ok(doc.body.style.getPropertyValue("transform"), "the live Canvas body is scaled into the preview slot");
    assert.equal(doc.body.style.getPropertyValue("pointer-events"), "none");

    const { overlay, frame, backdrop, fill } = shellNodes(doc);
    assert.match(backdrop.style.getPropertyValue("clip-path"), /^path\(evenodd/);
    assert.match(fill.style.getPropertyValue("clip-path"), /^path\(evenodd/);
    assert.deepEqual(await host.close("backdrop"), { ok: true, state: "closing", reason: "backdrop" });
    assert.equal(overlay.getAttribute("data-state"), "closing");
    assert.equal(backdrop.style.getPropertyValue("clip-path"), "", "close immediately restores the full-viewport mask");
    assert.equal(fill.style.getPropertyValue("clip-path"), "", "the panel mask cannot retain a stale hole during exit");
    assert.equal(doc.body.style.getPropertyValue("transform"), "", "Canvas is unscaled before panel geometry starts closing");
    assert.equal(frame.getAttribute("src"), "about:blank", "close navigates the iframe capability away before the transition");

    await new Promise((resolve) => setTimeout(resolve, overlayHost.CLOSE_DURATION + 20));
    assert.equal(overlay.getAttribute("data-state"), "closed");
    assert.equal(overlay.hidden, true);
    assert.equal(frame.getAttribute("src"), "about:blank");
    assert.equal(doc.documentElement.style.getPropertyValue("overflow"), "scroll", "the pre-existing value is restored, not cleared");
    assert.equal(doc.body.style.getPropertyValue("overflow"), "");
    assert.equal(doc.body.style.getPropertyValue("transform"), "");
    assert.equal(doc.body.style.getPropertyValue("pointer-events"), "");
    assert.equal(doc.body.inert, false);
    assert.equal(windowRef.scrollX, 40);
    assert.equal(windowRef.scrollY, 90);
    assert.equal(trigger.focusCount, 1, "focus returns to the element that had it before the overlay opened");
});

test("Canvas course-card menu editor closes, reopens, and recovers focus without stale overlay state", async () => {
    const { doc, host } = createHost({ reducedMotion: true });
    // A Canvas-shaped dashboard card action is the launch origin for the
    // course-card editor. The host owns the editor iframe and its recovery;
    // this fixture deliberately repeats the 1.0 close/reopen failure shape.
    const courseCardMenu = new FakeNode("button");
    courseCardMenu.setAttribute("data-course-id", "42");
    courseCardMenu.setAttribute("aria-label", "Course card menu for Biology 141");
    doc.activeElement = courseCardMenu;
    let priorSession = null;
    let priorFrameUrl = null;

    for (let cycle = 0; cycle < 3; cycle += 1) {
        const opened = host.open({ tabId: 42, category: "course-cards" });
        assert.equal(opened.ok, true);
        const ready = signalReady(host);
        assert.equal(ready.state, "ready", `cycle ${cycle + 1}: editor becomes ready`);
        const frameUrl = shellNodes(doc).frame.getAttribute("src");
        assert.notEqual(frameUrl, priorFrameUrl, `cycle ${cycle + 1}: a retired editor frame is never reused`);
        if (priorSession) {
            assert.deepEqual(host.handleControl("ready", { overlaySession: priorSession }), {
                ok: false, state: "stale", code: "OVERLAY_SESSION_STALE"
            }, `cycle ${cycle + 1}: prior editor cannot mutate the reopened menu`);
        }
        priorSession = host.overlaySession;
        priorFrameUrl = frameUrl;
        assert.equal((await control(host, "close")).state, "closing");
        assert.equal(shellNodes(doc).frame.getAttribute("src"), "about:blank", "close revokes the editor capability before recovery");
        if (cycle < 2) continue; // Opening on the next loop interrupts the visual close safely.
        await new Promise((resolve) => setTimeout(resolve, overlayHost.REDUCED_DURATION + 20));
    }

    const { overlay, frame } = shellNodes(doc);
    assert.equal(overlay.getAttribute("data-state"), "closed");
    assert.equal(overlay.hidden, true);
    assert.equal(frame.getAttribute("src"), "about:blank");
    assert.equal(courseCardMenu.focusCount, 1, "final close returns focus to the Canvas course-card menu action");
    host.destroy("course-card-menu-regression");
});

test("backdrop click and Escape close the overlay, and Escape is ignored while closed", () => {
    const { doc, host } = createHost();
    host.open({});
    const { backdrop } = shellNodes(doc);

    backdrop.dispatch("click", {});
    assert.equal(host.isOpen(), false);

    host.open({});
    let stopped = 0;
    doc.dispatch("keydown", { key: "Escape", stopPropagation() { stopped += 1; } });
    assert.equal(host.isOpen(), false);
    assert.equal(stopped, 1);

    doc.dispatch("keydown", { key: "Escape", stopPropagation() { stopped += 1; } });
    assert.equal(stopped, 1, "a closed overlay leaves Escape to the Canvas page");
    doc.dispatch("keydown", { key: "a", stopPropagation() { stopped += 1; } });
    assert.equal(stopped, 1);
});

test("fullscreen is a property of the same overlay and resets when it closes", async () => {
    const { doc, host, store } = createHost();
    host.open({});
    assert.deepEqual(host.setFullscreen(true), { ok: true, fullscreen: true });
    assert.equal(shellNodes(doc).overlay.getAttribute("data-fullscreen"), "true");
    assert.equal(host.fullscreen, true);
    assert.equal(store[overlayHost.FULLSCREEN_KEY], true);

    await host.close();
    await new Promise((resolve) => setTimeout(resolve, overlayHost.CLOSE_DURATION + 20));
    assert.equal(host.fullscreen, false);
    assert.equal(shellNodes(doc).overlay.getAttribute("data-fullscreen"), "false");
    assert.equal(store[overlayHost.FULLSCREEN_KEY], true, "closing the overlay must not wipe the device-local preference");
});

test("reopening restores the persisted fullscreen geometry without changing the Canvas URL", async () => {
    const { doc, host, windowRef } = createHost({ fullscreenStored: true });
    const href = windowRef.location.href;
    await new Promise((resolve) => setImmediate(resolve));

    const opened = host.open({});
    assert.equal(opened.fullscreen, true);
    assert.equal(shellNodes(doc).overlay.getAttribute("data-fullscreen"), "true");
    assert.equal(windowRef.location.href, href);

    host.setFullscreen(false);
    await host.close();
    await new Promise((resolve) => setTimeout(resolve, overlayHost.CLOSE_DURATION + 20));
    host.open({});
    assert.equal(host.fullscreen, false);
    assert.equal(windowRef.location.href, href);
});

test("backdrop, Escape, and a second close are idempotent and consume the history marker", async () => {
    const { doc, host, windowRef } = createHost();
    host.open({});
    assert.equal(overlayHost.FULLSCREEN_KEY, "platform.overlayFullscreen");
    const { backdrop } = shellNodes(doc);

    backdrop.dispatch("click", {});
    assert.equal(host.isOpen(), false);
    assert.deepEqual(await host.close("backdrop"), { ok: true, state: "closing" });
    assert.equal(overlayHistoryIsClosed(windowRef), true);
});

function overlayHistoryIsClosed(windowRef) {
    return overlayHistory.isOverlayState(windowRef.history.state) === false;
}

test("destroy removes the shell, drops every listener, and restores the page", () => {
    const { doc, host } = createHost();
    host.open({});
    assert.equal(doc.listenerCount("keydown"), 1);
    assert.ok(doc.body.style.getPropertyValue("transform"));

    assert.deepEqual(host.destroy("test"), { ok: true, state: "destroyed", reason: "test" });
    assert.equal(doc.listenerCount("keydown"), 0);
    assert.equal(doc.documentElement.children.some((node) => node.getAttribute("id") === overlayHost.ROOT_ID), false);
    assert.equal(doc.documentElement.style.getPropertyValue("overflow"), "");
    assert.equal(doc.body.style.getPropertyValue("transform"), "");
    assert.equal(host.isOpen(), false);
    assert.deepEqual(host.destroy("again"), { ok: true, state: "destroyed", reason: "again" }, "destroying twice is a no-op, not a throw");
});

test("destroy during the close transition still restores overflow, inert, and the body transform", async () => {
    const { doc, host } = createHost();
    doc.documentElement.style.setProperty("overflow", "scroll");
    host.open({});
    assert.equal((await host.close("programmatic")).state, "closing");
    assert.equal(shellNodes(doc).overlay.getAttribute("data-state"), "closing");

    // The close timer has not fired yet, so the ledger is still owed.
    host.destroy("mid-close");
    assert.equal(doc.documentElement.style.getPropertyValue("overflow"), "scroll", "the pre-existing value is restored, not cleared");
    assert.equal(doc.body.style.getPropertyValue("overflow"), "");
    assert.equal(doc.body.style.getPropertyValue("transform"), "");
    assert.equal(doc.body.inert, false);
    assert.equal(doc.body.getAttribute("inert"), null);
    assert.equal(doc.documentElement.children.some((node) => node.getAttribute("id") === overlayHost.ROOT_ID), false);
});

test("an invalidated extension context tears the overlay down instead of leaving a scaled page", () => {
    const environment = makeEnvironment();
    const host = overlayHost.createOverlayHost({
        documentRef: environment.doc,
        windowRef: environment.windowRef,
        chromeApi: environment.chromeApi
    });
    host.open({});
    const pollIndex = environment.intervals.findIndex((entry) => entry && entry.ms === 2000);
    const poll = environment.intervals[pollIndex];
    assert.ok(poll, "an open overlay polls the runtime handle every 2s");

    poll.handler();
    assert.equal(host.isOpen(), true, "a live runtime handle leaves the overlay alone");

    environment.chromeApi.runtime = {
        get id() { throw new Error("Extension context invalidated"); }
    };
    poll.handler();
    assert.equal(environment.doc.body.style.getPropertyValue("transform"), "");
    assert.equal(environment.doc.documentElement.style.getPropertyValue("overflow"), "");
    assert.equal(environment.doc.body.inert, false);
    assert.equal(
        environment.doc.documentElement.children.some((node) => node.getAttribute("id") === overlayHost.ROOT_ID),
        false
    );
    assert.equal(environment.intervals[pollIndex], null, "the poll is ledger-recorded, so teardown clears it");
});

test("the restore ledger replays inverses in reverse order and survives a throwing undo", () => {
    const ledger = overlayHost.createRestoreLedger();
    const order = [];
    ledger.record(() => order.push("first"));
    ledger.record(() => { throw new Error("boom"); });
    ledger.record(() => order.push("last"));
    assert.equal(ledger.size, 3);

    ledger.restore();
    assert.deepEqual(order, ["last", "first"]);
    assert.equal(ledger.size, 0);

    ledger.restore();
    assert.deepEqual(order, ["last", "first"], "restoring twice is a no-op rather than a double undo");
});

test("preview degrades to a full-width settings slot when disabled or the overlay is not on the page root", () => {
    const disabled = createHost();
    assert.equal(disabled.host.open({ preview: false }).preview, false);
    assert.equal(shellNodes(disabled.doc).overlay.getAttribute("data-preview"), "off");
    assert.equal(disabled.doc.body.style.getPropertyValue("transform"), "");

    const { doc, host } = createHost();
    host.open({});
    signalReady(host);
    assert.equal(control(host, "preview", { enabled: false }).preview, false);
    assert.equal(shellNodes(doc).overlay.getAttribute("data-preview"), "off");
    assert.equal(doc.body.style.getPropertyValue("transform"), "", "disabling preview restores the unscaled page while the overlay stays open");
    assert.equal(host.isOpen(), true);
    assert.equal(control(host, "preview", { enabled: true }).preview, true);
    assert.ok(doc.body.style.getPropertyValue("transform"));
});

test("narrow viewports suppress preview and restore it after a wide resize", () => {
    const environment = makeEnvironment();
    environment.windowRef.innerWidth = 390;
    const host = overlayHost.createOverlayHost({
        documentRef: environment.doc,
        windowRef: environment.windowRef,
        chromeApi: environment.chromeApi
    });

    const opened = host.open({});
    const nodes = shellNodes(environment.doc);
    assert.equal(opened.preview, false);
    assert.equal(host.preview, false);
    assert.equal(nodes.overlay.getAttribute("data-preview"), "off");
    assert.equal(environment.doc.body.style.getPropertyValue("transform"), "");
    assert.equal(nodes.backdrop.style.getPropertyValue("clip-path"), "");
    assert.match(cssRule('.overlay[data-preview="off"] .panel'), /grid-template-columns:\s*minmax\(0, 1fr\)/);
    assert.match(cssRule('.overlay[data-preview="off"] .panel'), /padding-left:\s*16px/);

    environment.windowRef.innerWidth = 1000;
    environment.windowRef.dispatch("resize");
    assert.equal(nodes.overlay.getAttribute("data-preview"), "on");
    assert.equal(host.preview, true);
    assert.ok(environment.doc.body.style.getPropertyValue("transform"));
});

test("overlay control routes zoom, navigate, and preview without synthesizing popstate", () => {
    const { doc, host, windowRef } = createHost();
    host.open({});
    signalReady(host);
    const pops = [];
    const original = windowRef.addEventListener.bind(windowRef);
    windowRef.addEventListener = (type, handler) => {
        if (type === "popstate") pops.push(handler);
        return original(type, handler);
    };

    assert.deepEqual(control(host, "zoom", { value: 150 }), { ok: true, zoom: 150 });
    assert.equal(host.zoom, 150);
    assert.deepEqual(control(host, "zoom", { reset: true }), { ok: true, zoom: 100 });
    assert.equal(control(host, "navigate", { destination: "calendar" }).ok, true);
    assert.equal(windowRef.location.href, "https://canvas.emory.edu/calendar");
    assert.equal(pops.length, 0);
    assert.equal(control(host, "navigate", { destination: "not-a-page" }).code, "PREVIEW_DESTINATION_UNSUPPORTED");
    assert.equal(control(host, "navigate", { url: "https://evil.example/" }).code, "PREVIEW_DESTINATION_UNSUPPORTED");
    assert.equal(host.preview, true);
    assert.equal(host.handleControl("nope").code, "OVERLAY_ACTION_UNSUPPORTED");

    control(host, "zoom", { value: 175 });
    host.destroy();
    assert.equal(doc.body.style.getPropertyValue("transform"), "");
});

test("open makes the Canvas body inert and close restores it so focus cannot leak into the scaled page", async () => {
    const { doc, host } = createHost();
    host.open({});
    assert.equal(doc.body.inert, true);
    assert.equal(doc.body.getAttribute("inert"), "");
    await host.close("escape");
    await new Promise((resolve) => setTimeout(resolve, overlayHost.CLOSE_DURATION + 20));
    assert.equal(doc.body.inert, false);
    assert.equal(doc.body.getAttribute("inert"), null);
});

test("overlay focus control moves to the host toolbar or back to the iframe", () => {
    const { doc, host } = createHost();
    host.open({});
    signalReady(host);
    assert.equal(control(host, "focus", { target: "toolbar" }).ok, true);
    assert.equal(control(host, "focus", { target: "toolbar-end" }).ok, true);
    assert.equal(control(host, "focus", { target: "frame" }).target, "frame");
    assert.equal(control(host, "focus", { target: "elsewhere" }).code, "OVERLAY_FOCUS_UNSUPPORTED");
    control(host, "preview", { enabled: false });
    assert.equal(control(host, "focus", { target: "toolbar" }).code, "PREVIEW_INACTIVE");
    const css = overlayHost.fontFaceCss({ runtime: { getURL: (value) => `chrome-extension://id/${value}` } });
    assert.match(css, /Public Sans/);
    assert.match(css, /font\/public-sans-latin\.woff2/);
    assert.match(css, /IBM Plex Mono/);
    assert.match(css, /font\/ibm-plex-mono-latin-400\.woff2/);
    // .preview-zoom-value asks for weight 500, so the real face is loaded rather
    // than letting the browser synthesise a bold from the 400 one.
    assert.match(css, /font\/ibm-plex-mono-latin-500\.woff2/);
    assert.match(css, /font-weight: 500/);
    assert.match(overlayHost.SHELL_CSS, /\.preview-zoom-value \{[^}]*font-weight: 500/);
    // Newsreader stays out: nothing in this shadow root is display type, and an
    // unreferenced face has no business in web_accessible_resources.
    assert.doesNotMatch(css, /newsreader/i);
});

test("a theme draft blocks host-initiated close until the user confirms", async () => {
    const { doc, host, windowRef } = createHost();
    let asked = 0;
    windowRef.confirm = () => { asked += 1; return false; };
    host.open({});
    signalReady(host);
    control(host, "draft-state", { draft: true });
    assert.deepEqual(await host.close("escape"), { ok: false, code: "OVERLAY_DRAFT_PENDING", state: "open" });
    assert.equal(asked, 1);
    assert.equal(host.isOpen(), true);
    windowRef.confirm = () => { asked += 1; return true; };
    assert.equal((await host.close("escape")).state, "closing");
    assert.equal(asked, 2);
    await new Promise((resolve) => setTimeout(resolve, overlayHost.CLOSE_DURATION + 20));
    assert.equal(shellNodes(doc).frame.getAttribute("src"), "about:blank", "discarding a draft navigates the iframe away so reopen starts clean");
});

test("session-bound discard recovery closes only after the host confirms it", () => {
    const { doc, host, windowRef } = createHost();
    let prompt = "";
    windowRef.confirm = (message) => { prompt = message; return true; };
    host.open({ tabId: 42 });
    signalReady(host);
    control(host, "draft-state", { draft: true });

    const result = control(host, "discard-close", { confirmDiscard: true });

    assert.equal(result.ok, true);
    assert.equal(result.state, "closing");
    assert.equal(result.reason, "embedded-discard");
    assert.match(prompt, /Discard unsaved theme edits and close APStudyCanvas\? This cannot be undone\./);
    assert.equal(shellNodes(doc).frame.getAttribute("src"), "about:blank", "confirmed discard navigates the active editor away immediately");
});

test("discard recovery remains open on denial, unavailable confirmation, or missing explicit intent", () => {
    const { doc, host, windowRef } = createHost();
    host.open({ tabId: 42 });
    signalReady(host);
    const active = host.overlaySession;

    assert.deepEqual(host.handleControl("discard-close", { overlaySession: active }), {
        ok: false,
        code: "OVERLAY_DISCARD_CONFIRMATION_REQUIRED",
        state: "open"
    });
    windowRef.confirm = () => false;
    assert.deepEqual(host.handleControl("discard-close", { overlaySession: active, confirmDiscard: true }), {
        ok: false,
        code: "OVERLAY_DISCARD_CANCELLED",
        state: "open"
    });
    windowRef.confirm = () => { throw new Error("confirmation unavailable"); };
    assert.deepEqual(host.handleControl("discard-close", { overlaySession: active, confirmDiscard: true }), {
        ok: false,
        code: "OVERLAY_DISCARD_CONFIRMATION_UNAVAILABLE",
        state: "open"
    });
    assert.equal(host.isOpen(), true);
    assert.notEqual(shellNodes(doc).frame.getAttribute("src"), null);
});

test("discard recovery fails closed for missing and stale overlay sessions", () => {
    const { host, windowRef } = createHost();
    let confirms = 0;
    windowRef.confirm = () => { confirms += 1; return true; };
    host.open({ tabId: 42 });
    signalReady(host);
    const active = host.overlaySession;

    assert.equal(host.handleControl("discard-close", { confirmDiscard: true }).code, "OVERLAY_SESSION_REQUIRED");
    assert.equal(host.handleControl("discard-close", {
        overlaySession: `${active}-stale`,
        confirmDiscard: true
    }).code, "OVERLAY_SESSION_STALE");
    assert.equal(confirms, 0, "unauthenticated recovery cannot reach host confirmation");
    assert.equal(host.isOpen(), true);
});

test("an edit immediately followed by close is protected while draft transport is still deferred", async () => {
    const { doc, host, windowRef } = createHost();
    let asked = 0;
    let releaseTransport;
    let transportApplied = false;
    const deferredTransport = new Promise((resolve) => {
        releaseTransport = () => {
            transportApplied = true;
            control(host, "draft-state", { draft: true });
            resolve();
        };
    });
    windowRef.confirm = () => { asked += 1; return false; };
    host.open({ tabId: 42 });
    signalReady(host);

    // The editor changes synchronously, but its sequenced background delivery
    // has not reached the host's cached false state yet.
    authoritativeDrafts.set(host, true);
    const result = await host.close("backdrop");

    assert.equal(transportApplied, false);
    assert.deepEqual(result, { ok: false, code: "OVERLAY_DRAFT_PENDING", state: "open" });
    assert.equal(asked, 1);
    assert.equal(host.isOpen(), true);
    assert.notEqual(shellNodes(doc).frame.getAttribute("src"), null);
    releaseTransport();
    await deferredTransport;
});

test("authoritative iframe draft replies are bound to the active source, origin, session, and request", async () => {
    const environment = makeEnvironment();
    const host = overlayHost.createOverlayHost({
        documentRef: environment.doc,
        windowRef: environment.windowRef,
        chromeApi: environment.chromeApi,
        draftQueryTimeoutMs: 20
    });
    let request = null;
    const frameWindow = {
        postMessage(message, targetOrigin) {
            request = message;
            assert.equal(targetOrigin, EXTENSION_ORIGIN);
            environment.windowRef.dispatch("message", {
                source: frameWindow,
                origin: EXTENSION_ORIGIN,
                data: {
                    type: overlayHost.DRAFT_RESPONSE_TYPE,
                    overlaySession: message.overlaySession,
                    requestId: message.requestId,
                    draft: true
                }
            });
        }
    };
    environment.windowRef.confirm = () => false;
    host.open({ tabId: 42 });
    signalReady(host);
    shellNodes(environment.doc).frame.contentWindow = frameWindow;

    assert.deepEqual(await host.close("escape"), {
        ok: false,
        code: "OVERLAY_DRAFT_PENDING",
        state: "open"
    });
    assert.equal(request.type, overlayHost.DRAFT_QUERY_TYPE);
    assert.equal(request.overlaySession, host.overlaySession);
    assert.match(request.requestId, new RegExp(`^${host.overlaySession}:\\d+$`));
});

test("a ready editor stays open when its authoritative draft state cannot be obtained", async () => {
    const { doc, host, windowRef } = createHost({
        draftStateResolver: async () => { throw new Error("FRAME_UNAVAILABLE"); }
    });
    windowRef.confirm = () => { throw new Error("unknown state must not prompt or discard"); };
    host.open({ tabId: 42 });
    signalReady(host);

    assert.deepEqual(await host.close("escape"), {
        ok: false,
        code: "OVERLAY_DRAFT_STATE_UNAVAILABLE",
        state: "open"
    });
    assert.equal(host.isOpen(), true);
    assert.notEqual(shellNodes(doc).frame.getAttribute("src"), null);
});

test("embedded close resolves the iframe's authoritative cleared draft before unloading", async () => {
    const { host, windowRef } = createHost();
    windowRef.confirm = () => { throw new Error("iframe already confirmed"); };
    host.open({});
    signalReady(host);
    control(host, "draft-state", { draft: true });
    authoritativeDrafts.set(host, false);
    assert.equal((await control(host, "close")).state, "closing");
});

test("cancelling a draft discard on Back re-owns the history marker so the shell still owns history", async () => {
    const { host, windowRef } = createHost();
    windowRef.confirm = () => false;
    host.open({});
    signalReady(host);
    control(host, "draft-state", { draft: true });
    assert.equal(overlayHistory.isOverlayState(windowRef.history.state), true);

    windowRef.history.back();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(host.isOpen(), true);
    assert.equal(overlayHistory.isOverlayState(windowRef.history.state), true, "cancelled popstate close must push the overlay marker again");
    assert.equal(windowRef.location.href, "https://canvas.emory.edu/courses/1");
});

test("rapid Back stays marker-owned until deferred host authorization commits", async () => {
    let resolveDraft;
    let requests = 0;
    const draftState = new Promise((resolve) => { resolveDraft = resolve; });
    const { doc, host, windowRef } = createHost({
        draftStateResolver: () => {
            requests += 1;
            return draftState;
        }
    });
    host.open({ tabId: 42 });
    signalReady(host);

    windowRef.history.back();
    windowRef.history.back();
    assert.equal(requests, 1);
    assert.equal(host.isOpen(), true);
    assert.equal(overlayHistory.isOverlayState(windowRef.history.state), true);
    assert.notEqual(shellNodes(doc).frame.getAttribute("src"), null, "pending authorization cannot unload the editor");

    resolveDraft({ ok: true, draft: false });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(shellNodes(doc).overlay.getAttribute("data-state"), "closing");
    assert.equal(overlayHistory.isOverlayState(windowRef.history.state), false, "the marker releases only after the close commits");
    assert.equal(shellNodes(doc).frame.getAttribute("src"), "about:blank");
});

test("reopening during the close animation keeps the original restore ledger", async () => {
    const { doc, host } = createHost();
    doc.documentElement.style.setProperty("overflow", "scroll");
    host.open({});
    assert.equal(doc.documentElement.style.getPropertyValue("overflow"), "hidden");
    assert.equal(doc.body.inert, true);

    assert.equal((await host.close("programmatic")).state, "closing");
    const reopened = host.open({});
    assert.equal(reopened.ok, true);
    assert.equal(reopened.reopened, true);
    assert.equal(host.isOpen(), true);
    assert.equal(doc.documentElement.style.getPropertyValue("overflow"), "hidden");
    assert.equal(doc.body.inert, true);

    await host.close("programmatic");
    await new Promise((resolve) => setTimeout(resolve, overlayHost.CLOSE_DURATION + 20));
    assert.equal(doc.documentElement.style.getPropertyValue("overflow"), "scroll");
    assert.equal(doc.body.style.getPropertyValue("overflow"), "");
    assert.equal(doc.body.inert, false);
    assert.equal(doc.body.getAttribute("inert"), null);
});

test("close while zoom is in flight and destroy while preview is active both restore the page", async () => {
    const { doc, host } = createHost();
    host.open({});
    host.setPreviewZoom({ value: 200 });
    const closing = await host.close("programmatic");
    assert.equal(closing.state, "closing");
    host.destroy();
    assert.equal(doc.body.style.getPropertyValue("transform"), "");
    assert.equal(doc.documentElement.style.getPropertyValue("overflow"), "");
});

// ---------------------------------------------------------------------------
// Phase 8a, §12 item 4 — the teardown contract, asserted as a whole rather than
// property by property. The browser matrix (§12 items 2-3) is not available, so
// "the Canvas page is byte-identical to before" is verified here against the
// restore ledger: the FakeNode style bag reports its own size, so an empty bag
// is proof that no mutation was left behind, including any a future phase adds
// without updating this list.
// ---------------------------------------------------------------------------

const HOST_BODY_MUTATIONS = ["transform", "transform-origin", "overflow", "pointer-events", "width", "height"];

function styleSnapshot(node, names) {
    const entries = {};
    names.forEach((name) => {
        const value = node.style.getPropertyValue(name);
        if (value) entries[name] = value;
    });
    return entries;
}

test("open then close leaves the Canvas page with no residual mutation of any kind", async () => {
    const { doc, host, windowRef } = createHost();
    // A pre-existing value on documentElement and nothing at all on body, so the
    // restore is proven to put back what it found rather than clear the property.
    doc.documentElement.style.setProperty("overflow", "scroll");
    const nativePush = windowRef.history.pushState;
    assert.equal(doc.body.style.size, 0, "the fixture body starts clean");
    assert.equal("replaceState" in windowRef.history, false, "the fixture ships no replaceState");

    host.open({ tabId: 3 });
    assert.deepEqual(Object.keys(styleSnapshot(doc.body, HOST_BODY_MUTATIONS)).sort(), [...HOST_BODY_MUTATIONS].sort());
    assert.equal(doc.body.style.size, HOST_BODY_MUTATIONS.length, "the body carries exactly the six recorded mutations");
    assert.equal(doc.documentElement.style.getPropertyValue("overflow"), "hidden");
    assert.equal(doc.documentElement.style.getPropertyValue("background-color"), "#0a0f22");
    assert.equal(doc.body.inert, true);
    assert.equal(doc.body.getAttribute("inert"), "");

    await host.close("close-out");
    await new Promise((resolve) => setTimeout(resolve, overlayHost.CLOSE_DURATION + 20));

    // The whole point: not "the properties I remembered to name are empty" but
    // "there is nothing left in the bag".
    assert.equal(doc.body.style.size, 0, `body still carries ${JSON.stringify(styleSnapshot(doc.body, HOST_BODY_MUTATIONS))}`);
    HOST_BODY_MUTATIONS.forEach((name) => {
        assert.equal(doc.body.style.getPropertyValue(name), "", `residual body ${name}`);
    });
    assert.equal(doc.body.inert, false);
    assert.equal(doc.body.getAttribute("inert"), null);
    assert.equal(doc.documentElement.style.getPropertyValue("background-color"), "", "the navy letterbox fill is removed");
    assert.equal(doc.documentElement.style.size, 1, "only the pre-existing declaration is left on documentElement");
    assert.equal(doc.documentElement.style.getPropertyValue("overflow"), "scroll");
    // The host never patches history — lifecycle.js owns the single patch — so
    // both entry points must still be the natives the page shipped with.
    assert.equal(windowRef.history.pushState, nativePush);
    assert.equal("replaceState" in windowRef.history, false, "the host installs no history wrapper of its own");
});

test("destroy leaves the Canvas page with no residual mutation of any kind", () => {
    const { doc, host, windowRef } = createHost();
    doc.documentElement.style.setProperty("overflow", "scroll");
    const nativePush = windowRef.history.pushState;

    host.open({ tabId: 4 });
    const container = shellNodes(doc).container;
    assert.equal(container.style.getPropertyValue("pointer-events"), "auto");
    assert.equal(doc.body.style.size, HOST_BODY_MUTATIONS.length);
    assert.equal(doc.documentElement.style.size, 2);

    assert.deepEqual(host.destroy("close-out"), { ok: true, state: "destroyed", reason: "close-out" });

    assert.equal(container.style.getPropertyValue("pointer-events"), "none");
    assert.equal(doc.body.style.size, 0, `body still carries ${JSON.stringify(styleSnapshot(doc.body, HOST_BODY_MUTATIONS))}`);
    HOST_BODY_MUTATIONS.forEach((name) => {
        assert.equal(doc.body.style.getPropertyValue(name), "", `residual body ${name}`);
    });
    assert.equal(doc.body.inert, false);
    assert.equal(doc.body.getAttribute("inert"), null);
    assert.equal(doc.documentElement.style.getPropertyValue("background-color"), "");
    assert.equal(doc.documentElement.style.size, 1);
    assert.equal(doc.documentElement.style.getPropertyValue("overflow"), "scroll");
    assert.equal(windowRef.history.pushState, nativePush);
    // The shell itself is gone, and the listeners with it.
    assert.equal(doc.documentElement.children.some((node) => node.getAttribute("id") === overlayHost.ROOT_ID), false);
    assert.equal(doc.listenerCount("keydown"), 0);
    assert.equal(windowRef.listenerCount("popstate"), 0);
});

test("an open-close-open-destroy cycle does not accumulate mutations across the reused shell", async () => {
    const { doc, host } = createHost();
    host.open({ tabId: 5 });
    signalReady(host);
    const opened = styleSnapshot(doc.body, HOST_BODY_MUTATIONS);
    await host.close("first");
    await new Promise((resolve) => setTimeout(resolve, overlayHost.CLOSE_DURATION + 20));
    assert.equal(doc.body.style.size, 0);

    host.open({ tabId: 5 });
    assert.deepEqual(styleSnapshot(doc.body, HOST_BODY_MUTATIONS), opened, "a warm reopen re-applies the same mutation set, not a superset");
    assert.equal(doc.body.style.size, HOST_BODY_MUTATIONS.length);
    host.destroy("second");
    assert.equal(doc.body.style.size, 0);
    assert.equal(doc.documentElement.style.size, 0, "nothing was owed to documentElement to begin with");
});

// ---------------------------------------------------------------------------
// Phase 1 — invalidation, teardown, and blocked-close recovery foundation.
// ---------------------------------------------------------------------------

test("context polling destroys the overlay when the runtime handle is missing entirely", () => {
    const environment = makeEnvironment();
    environment.doc.documentElement.style.setProperty("overflow", "scroll");
    delete environment.chromeApi.runtime;
    const host = overlayHost.createOverlayHost({
        documentRef: environment.doc,
        windowRef: environment.windowRef,
        chromeApi: environment.chromeApi
    });
    host.open({});
    const poll = environment.intervals.find((entry) => entry && entry.ms === 2000);
    assert.ok(poll, "the watch is scheduled even without a runtime handle");

    poll.handler();
    assert.equal(host.isOpen(), false);
    assert.equal(environment.doc.documentElement.style.getPropertyValue("overflow"), "scroll", "the pre-existing value is restored, not cleared");
    assert.equal(environment.doc.body.inert, false);
    assert.equal(environment.doc.body.style.getPropertyValue("transform"), "");
    assert.equal(
        environment.doc.documentElement.children.some((node) => node.getAttribute("id") === overlayHost.ROOT_ID),
        false
    );
    assert.equal(environment.intervals.some((entry) => entry && entry.ms === 2000), false, "no poll residue survives the teardown");
});

test("context polling treats any throw reading runtime.id as invalidated, not only recognized messages", () => {
    const environment = makeEnvironment();
    const host = overlayHost.createOverlayHost({
        documentRef: environment.doc,
        windowRef: environment.windowRef,
        chromeApi: environment.chromeApi
    });
    host.open({});
    const pollIndex = environment.intervals.findIndex((entry) => entry && entry.ms === 2000);
    assert.ok(pollIndex >= 0);

    environment.chromeApi.runtime = {
        get id() { throw new TypeError("Cannot read properties of undefined (reading 'id')"); }
    };
    environment.intervals[pollIndex].handler();
    assert.equal(host.isOpen(), false, "an unrecognizable throw is still a dead context");
    assert.equal(environment.doc.documentElement.style.getPropertyValue("overflow"), "");
    assert.equal(environment.doc.body.inert, false);
    assert.equal(environment.intervals[pollIndex], null, "teardown clears the ledger-recorded poll");
});

test("a discarded iframe is navigated to about:blank instead of merely losing its src attribute", async () => {
    const { doc, host } = createHost({ readyTimeoutMs: 15 });
    host.open({ tabId: 21 });
    const { frame } = shellNodes(doc);
    const loaded = frame.getAttribute("src");
    assert.match(loaded, /popup\.html/);
    await host.close("programmatic");
    assert.equal(frame.getAttribute("src"), "about:blank", "teardown performs a real navigation, leaving no suspended extension document");
});

test("the first unavailable authoritative draft answer surfaces a host-owned recovery panel", async () => {
    const environment = makeEnvironment();
    environment.doc.documentElement.style.setProperty("overflow", "scroll");
    const host = overlayHost.createOverlayHost({
        documentRef: environment.doc,
        windowRef: environment.windowRef,
        chromeApi: environment.chromeApi,
        draftQueryTimeoutMs: 10
    });
    environment.windowRef.confirm = () => { throw new Error("no confirmation before the recovery button"); };
    assert.equal(overlayHost.DRAFT_QUERY_TIMEOUT_MS, 500, "the production draft check still times out at 500ms");
    host.open({ tabId: 42 });
    signalReady(host);
    shellNodes(environment.doc).frame.contentWindow = { postMessage() {} };

    assert.deepEqual(await host.close("escape"), { ok: false, code: "OVERLAY_DRAFT_STATE_UNAVAILABLE", state: "open" });

    const { stage } = shellNodes(environment.doc);
    const recovery = stage.children.find((node) => node.className === "draft-recovery");
    assert.ok(recovery, "the recovery surface is host-rendered in the shadow root");
    assert.equal(recovery.hidden, false);
    assert.equal(recovery.children[0].textContent, "Workspace did not respond. Unsaved theme edits may be lost.");
    const closeAnyway = recovery.children[1].children[0];
    assert.equal(closeAnyway.tagName, "BUTTON");
    assert.equal(closeAnyway.textContent, "Close anyway");
    assert.equal(closeAnyway.focusCount, 1, "the surface takes focus when it appears");
    assert.equal(host.isOpen(), true, "the workspace stays open while recovery is offered");
    assert.match(shellNodes(environment.doc).frame.getAttribute("src"), /popup\.html/, "the iframe itself is untouched");
});

test("Close anyway demands its own confirmation; denial stays open, acceptance commits with no residue", async () => {
    const environment = makeEnvironment();
    environment.doc.documentElement.style.setProperty("overflow", "scroll");
    const host = overlayHost.createOverlayHost({
        documentRef: environment.doc,
        windowRef: environment.windowRef,
        chromeApi: environment.chromeApi,
        draftStateResolver: () => ({ ok: false, code: "OVERLAY_DRAFT_STATE_UNAVAILABLE" })
    });
    host.open({ tabId: 42 });
    signalReady(host);
    const { stage, overlay } = shellNodes(environment.doc);
    const recovery = stage.children.find((node) => node.className === "draft-recovery");
    assert.deepEqual(await host.close("escape"), { ok: false, code: "OVERLAY_DRAFT_STATE_UNAVAILABLE", state: "open" });
    const closeAnyway = recovery.children[1].children[0];

    let confirms = 0;
    let confirmMessage = "";
    environment.windowRef.confirm = (message) => { confirms += 1; confirmMessage = message; return false; };
    closeAnyway.dispatch("click", {});
    assert.equal(confirms, 1, "the button invokes a second confirmation before any commit");
    assert.match(confirmMessage, /Discard unsaved theme edits and close APStudyCanvas\? This cannot be undone\./);
    assert.equal(host.isOpen(), true, "cancellation keeps the workspace open");
    assert.equal(overlay.getAttribute("data-state"), "open");
    assert.equal(closeAnyway.focusCount, 2, "cancellation restores focus to the recovery action");
    assert.equal(overlayHistory.isOverlayState(environment.windowRef.history.state), true, "a cancelled recovery close keeps the history marker");

    environment.windowRef.confirm = () => { confirms += 1; return true; };
    closeAnyway.dispatch("click", {});
    assert.equal(confirms, 2);
    assert.equal(overlay.getAttribute("data-state"), "closing");
    assert.equal(recovery.hidden, true, "the surface retires once the close commits");
    await new Promise((resolve) => setTimeout(resolve, overlayHost.CLOSE_DURATION + 20));

    assert.equal(overlay.getAttribute("data-state"), "closed");
    assert.equal(overlay.hidden, true);
    assert.equal(shellNodes(environment.doc).frame.getAttribute("src"), "about:blank");
    assert.equal(environment.doc.documentElement.style.getPropertyValue("overflow"), "scroll", "the pre-existing value is restored, not cleared");
    assert.equal(environment.doc.body.style.getPropertyValue("overflow"), "");
    assert.equal(environment.doc.body.style.getPropertyValue("transform"), "");
    assert.equal(environment.doc.body.inert, false);
    assert.equal(environment.doc.body.getAttribute("inert"), null);
    assert.equal(overlayHistory.isOverlayState(environment.windowRef.history.state), false, "the history marker releases with the committed close");
    assert.equal(environment.intervals.some((entry) => entry && entry.ms === 2000), false, "the context poll leaves with the ledger");
});

test("the recovery surface shows once per session and retires when the workspace answers again", async () => {
    const { doc, host, windowRef } = createHost({
        draftStateResolver: () => ({ ok: false, code: "OVERLAY_DRAFT_STATE_UNAVAILABLE" })
    });
    windowRef.confirm = () => { throw new Error("no confirmation outside the recovery button"); };
    host.open({});
    signalReady(host);
    await host.close("escape");
    await host.close("escape");

    const { stage } = shellNodes(doc);
    const surfaces = stage.children.filter((node) => node.className === "draft-recovery");
    assert.equal(surfaces.length, 1, "repeated unavailable answers never duplicate the surface");
    assert.equal(surfaces[0].hidden, false);
    assert.equal(host.isOpen(), true);

    assert.deepEqual(control(host, "draft-state", { draft: false }), { ok: true, state: "ready", draft: false, sequence: 1 });
    assert.equal(surfaces[0].hidden, true, "an answering workspace retires the stale surface");
    assert.deepEqual(await host.close("escape"), { ok: false, code: "OVERLAY_DRAFT_STATE_UNAVAILABLE", state: "open" });
    assert.equal(surfaces[0].hidden, true, "the surface is not resummoned within the same session");
});

test("known-dirty confirmation is preserved and never summons the recovery surface", async () => {
    const { doc, host, windowRef } = createHost();
    let asked = 0;
    windowRef.confirm = () => { asked += 1; return false; };
    host.open({});
    signalReady(host);
    control(host, "draft-state", { draft: true });

    assert.deepEqual(await host.close("escape"), { ok: false, code: "OVERLAY_DRAFT_PENDING", state: "open" });
    assert.equal(asked, 1, "a known-dirty draft still asks its own question");
    assert.equal(shellNodes(doc).stage.children.find((node) => node.className === "draft-recovery").hidden, true);
    assert.equal(host.isOpen(), true);
});

test("the recovery surface stays host-internal and out of the public control vocabulary", () => {
    const { host } = createHost({
        draftStateResolver: () => ({ ok: false, code: "OVERLAY_DRAFT_STATE_UNAVAILABLE" })
    });
    host.open({});
    signalReady(host);
    const active = host.overlaySession;
    assert.equal(host.handleControl("close-anyway", { overlaySession: active }).code, "OVERLAY_ACTION_UNSUPPORTED");
    assert.equal(host.handleControl("draft-recovery", { overlaySession: active }).code, "OVERLAY_ACTION_UNSUPPORTED");
    assert.equal(host.handleControl("discard-close", { overlaySession: active }).code, "OVERLAY_DISCARD_CONFIRMATION_REQUIRED", "existing recovery actions keep their shape");
});

test("a close with no live finalize timer self-heals instead of ending forever", async () => {
    const originalSetTimeout = globalThis.setTimeout;
    const environment = makeEnvironment();
    environment.doc.documentElement.style.setProperty("overflow", "scroll");
    const host = overlayHost.createOverlayHost({
        documentRef: environment.doc,
        windowRef: environment.windowRef,
        chromeApi: environment.chromeApi,
        draftStateResolver: () => ({ ok: true, draft: false })
    });
    host.open({});
    signalReady(host);

    let healed;
    globalThis.setTimeout = () => null;
    try {
        assert.equal((await host.close("programmatic")).state, "closing");
        assert.equal(shellNodes(environment.doc).overlay.getAttribute("data-state"), "closing");
        assert.equal(environment.doc.documentElement.style.getPropertyValue("overflow"), "hidden", "the ledger is still held while the close is stuck");
        healed = await host.close("programmatic");
    } finally {
        globalThis.setTimeout = originalSetTimeout;
    }

    assert.deepEqual(healed, { ok: true, state: "closed" });
    assert.equal(shellNodes(environment.doc).overlay.getAttribute("data-state"), "closed");
    assert.equal(shellNodes(environment.doc).overlay.hidden, true);
    assert.equal(environment.doc.documentElement.style.getPropertyValue("overflow"), "scroll", "the pre-existing value is restored, not cleared");
    assert.equal(environment.doc.body.inert, false);
    assert.equal(environment.doc.body.getAttribute("inert"), null);
    assert.equal(overlayHistory.isOverlayState(environment.windowRef.history.state), false);
});

test("a failed reopen mint leaves the in-flight close free to finalize", async () => {
    let mints = 0;
    const environment = makeEnvironment();
    environment.doc.documentElement.style.setProperty("overflow", "scroll");
    const host = overlayHost.createOverlayHost({
        documentRef: environment.doc,
        windowRef: environment.windowRef,
        chromeApi: environment.chromeApi,
        sessionTokenFactory: () => {
            mints += 1;
            if (mints === 2) throw Object.assign(new Error("entropy gone"), { code: "OVERLAY_SESSION_ENTROPY_UNAVAILABLE" });
            return `overlay-session-${mints}`;
        },
        draftStateResolver: () => ({ ok: true, draft: false })
    });
    host.open({ tabId: 7 });
    signalReady(host);
    assert.equal((await host.close("programmatic")).state, "closing");

    const failed = host.open({ tabId: 7 });
    assert.deepEqual(failed, { ok: false, state: "closed", code: "OVERLAY_SESSION_ENTROPY_UNAVAILABLE" });
    assert.equal(shellNodes(environment.doc).overlay.getAttribute("data-state"), "closing", "the failed open did not strand the closing shell");
    assert.equal(shellNodes(environment.doc).container.style.getPropertyValue("pointer-events"), "none", "a failed reopen cannot restore page-blocking hit testing");

    await new Promise((resolve) => setTimeout(resolve, overlayHost.CLOSE_DURATION + 20));
    assert.equal(shellNodes(environment.doc).overlay.getAttribute("data-state"), "closed", "the interrupted close still finalizes");
    assert.equal(shellNodes(environment.doc).overlay.hidden, true);
    assert.equal(environment.doc.documentElement.style.getPropertyValue("overflow"), "scroll", "the pre-existing value is restored, not cleared");
    assert.equal(environment.doc.body.inert, false);
    assert.equal(environment.doc.body.getAttribute("inert"), null);
    assert.equal(overlayHistory.isOverlayState(environment.windowRef.history.state), false);
    assert.equal(environment.intervals.some((entry) => entry && entry.ms === 2000), false, "no ledger residue: the poll is released with the close");
});

test("protocol lifecycle keeps background, host, and popup authorization aligned across recovery and three reopen cycles", async () => {
    const canvasOrigin = "https://canvas.emory.edu";
    const { doc, host, windowRef } = createHost({
        draftStateResolver: () => ({ ok: true, draft: false }),
        sessionTokenFactory: (() => {
            let sequence = 0;
            return () => `overlay-protocol-${++sequence}`;
        })()
    });
    windowRef.location.href = `${canvasOrigin}/courses/1`;

    let routerService;
    let requestNumber = 0;
    const backgroundChrome = {
        runtime: { getURL: (value) => `${EXTENSION_ORIGIN}/${String(value).replace(/^\//, "")}` },
        tabs: {
            async sendMessage(tabId, message, options) {
                assert.equal(tabId, 42, "the router derives the destination from the authenticated sender tab");
                assert.deepEqual(options, { frameId: 0 }, "the host remains the tab's top-frame owner");
                return {
                    payload: await host.handleControl(message.payload.action, message.payload)
                };
            }
        }
    };
    routerService = router.createRouter({
        chromeApi: backgroundChrome,
        storage: storage.createMemoryStorage({
            sync: { custom_domain: [canvasOrigin] },
            local: { "platform.flags": { canvasOverlay: true } },
            session: {}
        }),
        transport: {
            identityGet: async () => ({ ok: true }),
            request: async () => ({ ok: true, body: {} }),
            mutate: async () => ({ ok: true, body: {} })
        }
    });

    function popupFor(frameUrl) {
        const popupWindow = {
            location: { search: new URL(frameUrl).search },
            addEventListener() {},
            removeEventListener() {}
        };
        const popupChrome = {
            runtime: {
                getURL: backgroundChrome.runtime.getURL,
                async sendMessage(message) {
                    const response = await routerService.handle(message, {
                        id: "test-id",
                        origin: EXTENSION_ORIGIN,
                        url: frameUrl,
                        // Chromium can classify an embedded extension document
                        // as the top frame. The router must accept zero only
                        // after exact page/session/tab/origin validation.
                        frameId: 0,
                        tab: { id: 42, url: `${canvasOrigin}/courses/1`, windowId: 7 }
                    });
                    return response;
                }
            }
        };
        return popupController.createController({
            document: { querySelector() { return null; }, querySelectorAll() { return []; } },
            window: popupWindow,
            chromeApi: popupChrome,
            contract,
            now: () => ++requestNumber
        });
    }

    function currentFrameUrl() {
        return shellNodes(doc).frame.getAttribute("src");
    }

    // First launch fails in the real popup, routes its error through the
    // background, and the host Retry button creates a fresh capability.
    host.open({ tabId: 42, category: "appearance" });
    const firstUrl = currentFrameUrl();
    const firstPopup = popupFor(firstUrl);
    assert.equal((await firstPopup.reportStartupFailure(new Error("startup failed"))).state, "error");
    assert.equal(host.readiness, "error");

    const firstSession = host.overlaySession;
    const failedFrame = shellNodes(doc).frame;
    const retried = host.handleControl("retry", { overlaySession: firstSession });
    assert.equal(retried.state, "loading");
    assert.notEqual(retried.overlaySession, firstSession, "Retry mints a new host capability");
    assert.equal(failedFrame.getAttribute("src"), "about:blank", "the displaced popup is navigated away before its replacement handshake");
    const retryUrl = currentFrameUrl();

    // A message from the displaced popup still clears the router's sender
    // checks, but must not be able to change the new host session.
    assert.deepEqual(await firstPopup.overlayControl("ready"), {
        ok: false,
        code: "OVERLAY_SESSION_STALE"
    });
    assert.equal(host.readiness, "loading");
    const retriedPopup = popupFor(retryUrl);
    assert.equal((await retriedPopup.overlayControl("ready")).state, "ready");

    // Button close, then open again before the visual close timer settles.
    // This is the live failure shape: the next frame must be a new browsing
    // context and a new popup handshake, not the retired iframe document.
    assert.equal((await retriedPopup.overlayControl("close")).state, "closing");
    const closedFrame = shellNodes(doc).frame;
    host.open({ tabId: 42, category: "appearance" });
    const secondUrl = currentFrameUrl();
    assert.notEqual(secondUrl, retryUrl, "close → reopen replaces the iframe URL/session");
    assert.equal(closedFrame.getAttribute("src"), "about:blank", "reopen leaves the closed iframe permanently revoked");
    const secondPopup = popupFor(secondUrl);
    assert.equal((await secondPopup.overlayControl("ready")).state, "ready");

    // Escape is delegated by the embedded popup to this same close control.
    assert.equal((await secondPopup.overlayControl("close")).state, "closing");
    host.open({ tabId: 42, category: "appearance" });
    const thirdUrl = currentFrameUrl();
    const thirdPopup = popupFor(thirdUrl);
    assert.equal((await thirdPopup.overlayControl("ready")).state, "ready");

    // A fourth toolbar-equivalent open after another close must mint and
    // authorize a replacement frame. This is the production repeated-action
    // shape: no immediate close, no duplicate visible shell, and no stale
    // session can control the replacement.
    assert.equal((await thirdPopup.overlayControl("close")).state, "closing");
    const retiredThirdFrame = shellNodes(doc).frame;
    host.open({ tabId: 42, category: "appearance" });
    const fourthUrl = currentFrameUrl();
    assert.notEqual(fourthUrl, thirdUrl, "the fourth open rotates the iframe session");
    assert.equal(retiredThirdFrame.getAttribute("src"), "about:blank", "the third frame is revoked before the fourth opens");
    const fourthPopup = popupFor(fourthUrl);
    assert.equal((await fourthPopup.overlayControl("ready")).state, "ready");
    assert.deepEqual(await thirdPopup.overlayControl("ready"), {
        ok: false,
        code: "OVERLAY_SESSION_STALE"
    }, "a stale third-session message cannot close or ready the fourth overlay");

    // Rapid duplicate opens while the current iframe is still authoritative
    // reuse only that current session; no stale popup can claim the next one.
    const rapid = host.open({ tabId: 42, category: "appearance" });
    assert.equal(rapid.frameReused, true);
    assert.equal(currentFrameUrl(), fourthUrl);
    assert.equal((await fourthPopup.overlayControl("close")).state, "closing");
    host.destroy("protocol-test");
});
