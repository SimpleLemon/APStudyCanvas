"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const overlayHistory = require("../../js/content/overlay-history.js");

function createWindow({ href = "https://canvas.emory.edu/courses/1", priorHref = null, deferBack = false } = {}) {
    const stack = [
        ...(priorHref ? [{ state: { canvas: "prior" }, url: priorHref }] : []),
        { state: null, url: href }
    ];
    let index = stack.length - 1;
    const listeners = new Map();
    const location = { href };
    let pendingBack = null;

    function dispatchPop() {
        const event = { state: stack[index].state };
        for (const handler of [...(listeners.get("popstate") || [])]) handler(event);
    }

    const win = {
        location,
        history: {
            get state() { return stack[index].state; },
            get length() { return stack.length; },
            get index() { return index; },
            pushState(state, _title, url) {
                stack.splice(index + 1);
                const nextUrl = typeof url === "string" && url ? url : location.href;
                stack.push({ state, url: nextUrl });
                index = stack.length - 1;
                location.href = nextUrl;
            },
            back() {
                if (index === 0) return;
                const apply = () => {
                    index -= 1;
                    location.href = stack[index].url;
                    dispatchPop();
                };
                if (deferBack) pendingBack = apply;
                else apply();
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
        listenerCount(type) { return (listeners.get(type) || []).length; },
        entries() { return stack.map((entry) => ({ state: entry.state, url: entry.url })); },
        flushBack() {
            const apply = pendingBack;
            pendingBack = null;
            if (apply) apply();
        }
    };
    return win;
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

test("opening the overlay pushes a state-only marker and leaves the visible URL unchanged", () => {
    const href = "https://canvas.emory.edu/courses/19?module=2";
    const win = createWindow({ href });
    const history = overlayHistory.createOverlayHistory({ windowRef: win });

    assert.deepEqual(history.enter(), { ok: true, phase: "open", pushed: true });
    assert.equal(win.location.href, href);
    assert.equal(overlayHistory.isOverlayState(win.history.state), true);
    assert.equal(win.history.length, 2);
    assert.deepEqual(history.enter(), { ok: true, phase: "open", pushed: false, reason: "already-open" });
    assert.equal(win.history.length, 2, "re-enter does not stack a second marker");
});

test("browser Back while open closes via popstate without a second history.back", () => {
    const win = createWindow();
    const closes = [];
    const history = overlayHistory.createOverlayHistory({
        windowRef: win,
        onClose: (detail) => closes.push(detail)
    });

    history.enter();
    win.history.back();

    assert.equal(history.phase, "closed");
    assert.deepEqual(closes, [{ reason: "popstate" }]);
    assert.equal(overlayHistory.isOverlayState(win.history.state), false);
});

test("rapid repeated Back is consumed while deferred close authorization is denied", async () => {
    const href = "https://canvas.emory.edu/courses/19";
    const priorHref = "https://canvas.emory.edu/dashboard";
    const authorization = deferred();
    let closeCalls = 0;
    const win = createWindow({ href, priorHref });
    const history = overlayHistory.createOverlayHistory({
        windowRef: win,
        onClose() {
            closeCalls += 1;
            return authorization.promise;
        }
    });

    history.enter();
    win.history.back();
    win.history.back();

    assert.equal(closeCalls, 1, "the pending authoritative check is debounced");
    assert.equal(history.phase, overlayHistory.PHASES.AUTHORIZING);
    assert.equal(history.currentIsOurs(), true, "the marker remains the live entry");
    assert.equal(win.location.href, href, "repeated Back cannot reach the prior Canvas entry");
    assert.equal(win.history.length, 3, "consuming repeated Back does not stack markers");

    authorization.resolve({ ok: false, code: "OVERLAY_DRAFT_PENDING" });
    await Promise.resolve();
    assert.equal(history.phase, overlayHistory.PHASES.OPEN);
    assert.equal(history.currentIsOurs(), true);
    assert.equal(win.location.href, href);
});

test("rapid repeated Back releases only the marker after deferred close authorization succeeds", async () => {
    const href = "https://canvas.emory.edu/courses/19";
    const priorHref = "https://canvas.emory.edu/dashboard";
    const authorization = deferred();
    let closeCalls = 0;
    const win = createWindow({ href, priorHref });
    const history = overlayHistory.createOverlayHistory({
        windowRef: win,
        onClose() {
            closeCalls += 1;
            return authorization.promise;
        }
    });

    history.enter();
    win.history.back();
    win.history.back();
    assert.equal(win.location.href, href);

    authorization.resolve({ ok: true, state: "closing" });
    await Promise.resolve();
    assert.equal(closeCalls, 1);
    assert.equal(history.phase, overlayHistory.PHASES.CLOSED);
    assert.equal(history.currentIsOurs(), false);
    assert.equal(win.location.href, href, "authorization consumes only the state-only marker");

    win.history.back();
    assert.equal(win.location.href, priorHref, "the next Back is the real Canvas navigation");
});

test("failed deferred authorization restores open ownership", async () => {
    const authorization = deferred();
    const win = createWindow();
    const history = overlayHistory.createOverlayHistory({
        windowRef: win,
        onClose: () => authorization.promise
    });

    history.enter();
    win.history.back();
    authorization.reject(new Error("authorization unavailable"));
    await Promise.resolve();

    assert.equal(history.phase, overlayHistory.PHASES.OPEN);
    assert.equal(history.currentIsOurs(), true);
});

test("UI close pops only our marker, so the next Back is a real Canvas navigation", () => {
    const win = createWindow({ href: "https://canvas.emory.edu/courses/1" });
    const closes = [];
    const history = overlayHistory.createOverlayHistory({
        windowRef: win,
        onClose: (detail) => closes.push(detail)
    });

    history.enter();
    assert.deepEqual(history.exit("ui"), { ok: true, phase: "closed", popped: true });
    assert.equal(closes.length, 0, "the popstate from our own back() is not a second close");
    assert.equal(history.phase, "closed");
    assert.equal(win.history.index, 0);

    win.history.back();
    assert.equal(closes.length, 0, "Back after a clean UI close does not fire overlay onClose");
});

test("UI close above a preview collapses the marker branch while preserving the live Canvas route", () => {
    const win = createWindow({ href: "https://canvas.emory.edu/courses/1" });
    const history = overlayHistory.createOverlayHistory({ windowRef: win, onClose() {} });

    history.enter();
    win.history.pushState({ canvas: "preview" }, "", "https://canvas.emory.edu/courses/2");
    assert.equal(history.currentIsOurs(), false);

    assert.deepEqual(history.exit("ui"), { ok: true, phase: "closed", popped: true, reason: "restore-preview" });
    assert.equal(win.history.length, 2);
    assert.equal(win.history.index, 1);
    assert.equal(win.location.href, "https://canvas.emory.edu/courses/2");
    assert.equal(win.entries().some((entry) => overlayHistory.isOverlayState(entry.state)), false);
});

test("deferred browser traversal completes close-above-preview restoration across both popstates", () => {
    const previewHref = "https://canvas.emory.edu/courses/2";
    const win = createWindow({ href: "https://canvas.emory.edu/courses/1", deferBack: true });
    const history = overlayHistory.createOverlayHistory({ windowRef: win });

    history.enter();
    win.history.pushState({ canvas: "preview" }, "", previewHref);
    assert.deepEqual(history.exit("ui"), { ok: true, phase: "exiting", popped: true, reason: "restore-preview" });

    win.flushBack();
    assert.equal(history.phase, "exiting");
    assert.equal(history.currentIsOurs(), true);
    win.flushBack();

    assert.equal(history.phase, "closed");
    assert.equal(win.location.href, previewHref);
    assert.equal(win.entries().some((entry) => overlayHistory.isOverlayState(entry.state)), false);
});

test("Back from a preview entry stacked on the marker keeps the overlay open", () => {
    const win = createWindow({ href: "https://canvas.emory.edu/courses/1" });
    const closes = [];
    const history = overlayHistory.createOverlayHistory({
        windowRef: win,
        onClose: (detail) => closes.push(detail)
    });

    history.enter();
    win.history.pushState({ canvas: "preview" }, "", "https://canvas.emory.edu/courses/2");
    win.history.back();

    assert.equal(history.phase, "open");
    assert.equal(closes.length, 0);
    assert.equal(history.currentIsOurs(), true);
    assert.equal(win.location.href, "https://canvas.emory.edu/courses/1");

    win.history.back();
    assert.equal(history.phase, "closed");
    assert.deepEqual(closes, [{ reason: "popstate" }]);
});

test("preview entries may stack only while the overlay is open", () => {
    const win = createWindow();
    const history = overlayHistory.createOverlayHistory({ windowRef: win });
    assert.equal(history.canStackPreview(), false);
    history.enter();
    assert.equal(history.canStackPreview(), true);
    history.exit("ui");
    assert.equal(history.canStackPreview(), false);
});

test("reopening while a UI close back() is in flight re-pushes after popstate instead of double-closing", () => {
    const win = createWindow({ deferBack: true });
    const closes = [];
    const history = overlayHistory.createOverlayHistory({
        windowRef: win,
        onClose: (detail) => closes.push(detail)
    });

    history.enter();
    const firstHref = win.location.href;
    assert.deepEqual(history.exit("ui"), { ok: true, phase: "exiting", popped: true });
    assert.deepEqual(history.enter(), { ok: true, phase: "reopening", pushed: false, reason: "reopen-pending" });

    win.flushBack();
    assert.equal(history.phase, "open");
    assert.equal(closes.length, 0);
    assert.equal(win.location.href, firstHref);
    assert.equal(history.currentIsOurs(), true);
});

test("destroy detaches popstate so an in-flight back cannot close a dead overlay", () => {
    const win = createWindow({ deferBack: true });
    const closes = [];
    const history = overlayHistory.createOverlayHistory({
        windowRef: win,
        onClose: (detail) => closes.push(detail)
    });

    history.enter();
    history.exit("ui");
    history.destroy();
    assert.equal(history.attached, false);
    assert.equal(win.listenerCount("popstate"), 0);

    win.flushBack();
    assert.equal(closes.length, 0);
    assert.equal(history.phase, "closed");
});

test("close above multiple previews leaves the next Back as real Canvas navigation, not a stale marker no-op", () => {
    const baseHref = "https://canvas.emory.edu/courses/1";
    const win = createWindow({ href: baseHref });
    const closes = [];
    const history = overlayHistory.createOverlayHistory({
        windowRef: win,
        onClose: (detail) => closes.push(detail)
    });

    history.enter();
    win.history.pushState({ canvas: "preview-1" }, "", "https://canvas.emory.edu/courses/2");
    win.history.pushState({ canvas: "preview-2" }, "", "https://canvas.emory.edu/assignments/3");
    assert.equal(history.exit("ui").reason, "restore-preview");
    assert.equal(win.history.length, 2);
    assert.equal(win.location.href, "https://canvas.emory.edu/assignments/3");
    assert.equal(win.entries().some((entry) => overlayHistory.isOverlayState(entry.state)), false);

    win.history.back();
    assert.equal(closes.length, 0);
    assert.equal(history.phase, "closed");
    assert.equal(win.location.href, baseHref);
});
