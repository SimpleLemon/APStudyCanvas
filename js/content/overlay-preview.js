(function (root, factory) {
    "use strict";
    const api = factory();
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasContent = Object.assign(root.APStudyCanvasContent || {}, { OverlayPreview: api });
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const ZOOM_MIN = 50;
    const ZOOM_MAX = 200;
    const ZOOM_STEP = 25;
    const ZOOM_DEFAULT = 100;
    // Contain-fit: 100% zoom shows the *entire* Canvas viewport — including
    // Canvas's own nav rail — scaled down and letterboxed inside the preview
    // hole. The navy bands are painted by the ledgered documentElement
    // background. Zoom still multiplies this contain scale; above 100% the
    // page overflows, stays aligned, and is clipped by the hole. There is no
    // pan UI. Reset returns to this 100% contain default.
    const FIT_MODE = "contain";
    const LAYOUT_TRANSITION_MS = 400;
    // requestAnimationFrame bounds normal retries to the browser's paint
    // cadence. The timeout fallback must also yield so a missing rendered
    // rectangle cannot create a zero-delay hot loop.
    const LAYOUT_RETRY_DELAY_MS = 50;
    // These are ratios of the space left after the explicit inter-column gap.
    // The host uses the matching 52fr / 48fr grid. The editor also has a CSS
    // floor so its category rail and detail pane remain side by side at normal
    // desktop widths instead of falling into the compact selector too early.
    const IFRAME_SLOT_FRACTION = 0.52;
    const PREVIEW_SLOT_FRACTION = 0.48;
    const FULL_VIEWPORT_INSET = Object.freeze({ block: 0, inline: 0 });
    const PANEL_PADDING = 16;
    const PANEL_GAP_MIN = 24;
    const PANEL_GAP_FLUID_VW = 4;
    const PANEL_GAP_MAX = 64;
    const PANEL_GAP_CSS = `clamp(${PANEL_GAP_MIN}px, ${PANEL_GAP_FLUID_VW}vw, ${PANEL_GAP_MAX}px)`;
    // Keep the editor visually anchored on wide screens without introducing a
    // minimum width or assuming an action-popup-sized shell.
    const EDITOR_LEFT_INSET_FLUID_VW = 3;
    const EDITOR_LEFT_INSET_MAX = 48;
    const EDITOR_LEFT_INSET_CSS = `clamp(0px, ${EDITOR_LEFT_INSET_FLUID_VW}vw, ${EDITOR_LEFT_INSET_MAX}px)`;
    const PREVIEW_RADIUS = 16;
    const PREVIEW_UTILITY_HEADER_HEIGHT = 58;
    // The preview column is a two-row grid: a static toolbar row on top and
    // the live viewport below it. The engine must letterbox into the viewport
    // row only, so these numbers are shared with `.preview` in overlay-host.
    const PREVIEW_TOOLBAR_HEIGHT = 52;
    const PREVIEW_TOOLBAR_GAP = 8;
    // Below this content-driven breakpoint the preview is removed entirely;
    // above it the bounded editor floor still leaves the preview column room
    // to remain visible. The host uses the same value in its container query.
    const PREVIEW_MIN_VIEWPORT_WIDTH = 720;
    const PREVIEW_ALIGN = Object.freeze({ x: 0.5, y: 0.5 });

    const DESTINATIONS = Object.freeze([
        Object.freeze({ id: "dashboard", label: "Dashboard", path: "/" }),
        Object.freeze({ id: "courses", label: "Courses", path: "/courses" }),
        Object.freeze({ id: "calendar", label: "Calendar", path: "/calendar" }),
        Object.freeze({ id: "inbox", label: "Inbox", path: "/conversations" }),
        Object.freeze({ id: "course-home", label: "Course home", pathTemplate: "/courses/:courseId" })
    ]);

    const DESTINATION_BY_ID = Object.freeze(Object.fromEntries(DESTINATIONS.map((entry) => [entry.id, entry])));

    function clamp(value, min, max) {
        return Math.min(max, Math.max(min, value));
    }

    function snapZoom(value) {
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) return ZOOM_DEFAULT;
        return clamp(Math.round(numeric / ZOOM_STEP) * ZOOM_STEP, ZOOM_MIN, ZOOM_MAX);
    }

    function stepZoom(current, direction) {
        const delta = direction < 0 ? -ZOOM_STEP : ZOOM_STEP;
        return snapZoom(snapZoom(current) + delta);
    }

    function resolveZoom(payload, current) {
        if (payload?.reset === true) return ZOOM_DEFAULT;
        if (payload && Object.prototype.hasOwnProperty.call(payload, "step")) {
            const step = Number(payload.step);
            if (!Number.isFinite(step) || step === 0) return snapZoom(current);
            return stepZoom(current, step);
        }
        if (payload && Object.prototype.hasOwnProperty.call(payload, "value")) return snapZoom(payload.value);
        if (payload && Object.prototype.hasOwnProperty.call(payload, "delta")) {
            return snapZoom(snapZoom(current) + Number(payload.delta));
        }
        return snapZoom(current);
    }

    function normalizePath(pathname) {
        const raw = typeof pathname === "string" ? pathname : "";
        if (!raw || raw === "/") return "/";
        return raw.length > 1 && raw.endsWith("/") ? raw.slice(0, -1) : raw;
    }

    function parseCourseId(href) {
        try {
            const path = normalizePath(new URL(href, "https://canvas.emory.edu").pathname);
            const match = path.match(/^\/courses\/(\d+)(?:\/|$)/);
            return match ? match[1] : null;
        } catch (error) {
            return null;
        }
    }

    function destinationFromHref(href) {
        try {
            const path = normalizePath(new URL(href, "https://canvas.emory.edu").pathname);
            if (path === "/" || path === "/dashboard") return "dashboard";
            if (path === "/courses") return "courses";
            if (path === "/calendar") return "calendar";
            if (path === "/conversations" || path.startsWith("/conversations/")) return "inbox";
            if (/^\/courses\/\d+(?:\/|$)/.test(path)) return "course-home";
            return null;
        } catch (error) {
            return null;
        }
    }

    function allowedCanvasPath(pathname) {
        const path = normalizePath(pathname);
        return path === "/"
            || path === "/dashboard"
            || path === "/courses"
            || path === "/calendar"
            || path === "/conversations"
            || path.startsWith("/conversations/")
            || /^\/courses\/\d+(?:\/|$)/.test(path);
    }

    function originOf(value) {
        try {
            return new URL(value).origin;
        } catch (error) {
            return "";
        }
    }

    // Catalog ids only. A payload `url` is ignored even when it happens to
    // match the Canvas origin, so an attacker-supplied href cannot drive this.
    function validateNavigationUrl(url, canvasOrigin) {
        const expected = originOf(canvasOrigin);
        if (!expected) return { ok: false, code: "PREVIEW_ORIGIN_REQUIRED" };
        let parsed;
        try {
            parsed = new URL(url, expected);
        } catch (error) {
            return { ok: false, code: "PREVIEW_URL_INVALID" };
        }
        if (parsed.origin !== expected) return { ok: false, code: "PREVIEW_ORIGIN_MISMATCH" };
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return { ok: false, code: "PREVIEW_ORIGIN_MISMATCH" };
        if (parsed.username || parsed.password) return { ok: false, code: "PREVIEW_URL_INVALID" };
        if (!allowedCanvasPath(parsed.pathname)) return { ok: false, code: "PREVIEW_PATH_UNSUPPORTED" };
        return { ok: true, href: parsed.href, origin: parsed.origin, path: parsed.pathname };
    }

    function resolveNavigation(payload, { origin, href } = {}) {
        const id = typeof payload?.destination === "string" ? payload.destination : "";
        const dest = DESTINATION_BY_ID[id];
        if (!dest) return { ok: false, code: "PREVIEW_DESTINATION_UNSUPPORTED" };
        let path = dest.path;
        if (dest.pathTemplate) {
            const courseId = parseCourseId(href || "");
            if (!courseId) return { ok: false, code: "PREVIEW_COURSE_REQUIRED" };
            path = dest.pathTemplate.replace(":courseId", courseId);
        }
        return validateNavigationUrl(path, origin);
    }

    // The host is a true viewport surface now. Keep the old arguments
    // accepted for callers that still report fullscreen state, but do not let
    // a retired windowed inset change the live preview's coordinate system.
    function computePanelRect(viewport, _options = {}) {
        const width = Math.max(0, Number(viewport?.width) || 0);
        const height = Math.max(0, Number(viewport?.height) || 0);
        return { x: 0, y: 0, width, height };
    }

    function computePanelGap(viewportWidth) {
        const width = Math.max(0, Number(viewportWidth) || 0);
        return clamp(width * (PANEL_GAP_FLUID_VW / 100), PANEL_GAP_MIN, PANEL_GAP_MAX);
    }

    function computeEditorLeftInset(viewportWidth) {
        const width = Math.max(0, Number(viewportWidth) || 0);
        return clamp(width * (EDITOR_LEFT_INSET_FLUID_VW / 100), 0, EDITOR_LEFT_INSET_MAX);
    }

    function isPreviewLayoutAvailable(viewport) {
        return (Number(viewport?.width) || 0) >= PREVIEW_MIN_VIEWPORT_WIDTH;
    }

    function computeSlots(panel, { previewEnabled = true, viewportWidth = panel?.width } = {}) {
        const leftInset = previewEnabled ? computeEditorLeftInset(viewportWidth) : 0;
        const contentWidth = Math.max(0, panel.width - PANEL_PADDING * 2 - leftInset);
        const contentHeight = Math.max(0, panel.height - PANEL_PADDING * 2);
        const top = panel.y + PANEL_PADDING;
        const left = panel.x + PANEL_PADDING + leftInset;
        if (!previewEnabled) {
            return {
                iframe: { x: left, y: top, width: contentWidth, height: contentHeight },
                preview: null
            };
        }
        const gap = Math.min(contentWidth, computePanelGap(viewportWidth));
        const trackWidth = Math.max(0, contentWidth - gap);
        const ratioTotal = IFRAME_SLOT_FRACTION + PREVIEW_SLOT_FRACTION;
        const iframeWidth = trackWidth * (IFRAME_SLOT_FRACTION / ratioTotal);
        const previewWidth = trackWidth * (PREVIEW_SLOT_FRACTION / ratioTotal);
        const previewTop = top + Math.min(contentHeight, PREVIEW_UTILITY_HEADER_HEIGHT);
        return {
            iframe: { x: left, y: top, width: iframeWidth, height: contentHeight },
            preview: {
                x: left + iframeWidth + gap,
                y: previewTop,
                width: previewWidth,
                height: Math.max(0, contentHeight - PREVIEW_UTILITY_HEADER_HEIGHT)
            }
        };
    }

    // Pure: no DOM, no state. `contain` letterboxes the whole viewport into
    // the slot; anything else covers it.
    function computeFitScale(viewport, rect, mode) {
        const viewW = Math.max(1, Number(viewport?.width) || 1);
        const viewH = Math.max(1, Number(viewport?.height) || 1);
        const slotW = Math.max(1, Number(rect?.width) || 1);
        const slotH = Math.max(1, Number(rect?.height) || 1);
        const scaleW = slotW / viewW;
        const scaleH = slotH / viewH;
        return mode === "contain" ? Math.min(scaleW, scaleH) : Math.max(scaleW, scaleH);
    }

    // Pure: splits the preview column into its toolbar row and the viewport
    // row beneath it. Never returns a negative height, so a short panel
    // degrades to a zero-height viewport rather than an inverted rect.
    function splitPreviewSlot(rect, { toolbarHeight = PREVIEW_TOOLBAR_HEIGHT, gap = PREVIEW_TOOLBAR_GAP } = {}) {
        if (!rect) return null;
        const x = Number(rect.x) || 0;
        const y = Number(rect.y) || 0;
        const width = Math.max(0, Number(rect.width) || 0);
        const height = Math.max(0, Number(rect.height) || 0);
        const bar = clamp(Number(toolbarHeight) || 0, 0, height);
        const space = clamp(Number(gap) || 0, 0, Math.max(0, height - bar));
        return {
            toolbar: { x, y, width, height: bar },
            viewport: {
                x,
                y: y + bar + space,
                width,
                height: Math.max(0, height - bar - space)
            }
        };
    }

    function computeBodyTransform(viewport, previewRect, zoomPercent, scroll, { fitMode = FIT_MODE, align = PREVIEW_ALIGN } = {}) {
        const zoom = snapZoom(zoomPercent);
        const viewW = Math.max(1, Number(viewport?.width) || 1);
        const viewH = Math.max(1, Number(viewport?.height) || 1);
        const slotW = Math.max(1, Number(previewRect?.width) || 1);
        const slotH = Math.max(1, Number(previewRect?.height) || 1);
        const fit = computeFitScale({ width: viewW, height: viewH }, { width: slotW, height: slotH }, fitMode);
        const scale = fit * (zoom / 100);
        const drawnW = viewW * scale;
        const drawnH = viewH * scale;
        // Align the drawn page inside the slot. At 100% contain this
        // letterboxes; zoomed past 100% the overflow stays aligned and the
        // overlay clip-path hole hides it. This phase does not pan.
        const alignX = Number.isFinite(Number(align?.x)) ? Number(align.x) : 0.5;
        const alignY = Number.isFinite(Number(align?.y)) ? Number(align.y) : 0.5;
        const offsetX = (Number(previewRect?.x) || 0) + (slotW - drawnW) * alignX;
        const offsetY = (Number(previewRect?.y) || 0) + (slotH - drawnH) * alignY;
        const scrollX = Number(scroll?.x) || 0;
        const scrollY = Number(scroll?.y) || 0;
        const transform = `translate(${offsetX}px, ${offsetY}px) scale(${scale}) translate(${-scrollX}px, ${-scrollY}px)`;
        return {
            zoom,
            fit,
            scale,
            offsetX,
            offsetY,
            clipped: drawnW > slotW + 0.5 || drawnH > slotH + 0.5,
            fitMode,
            transform,
            transformOrigin: "0px 0px"
        };
    }

    function roundedRectPath(x, y, width, height, radius) {
        const rr = Math.max(0, Math.min(radius, width / 2, height / 2));
        if (rr === 0) return `M${x},${y} H${x + width} V${y + height} H${x} Z`;
        return [
            `M${x + rr},${y}`,
            `H${x + width - rr}`,
            `A${rr},${rr} 0 0 1 ${x + width},${y + rr}`,
            `V${y + height - rr}`,
            `A${rr},${rr} 0 0 1 ${x + width - rr},${y + height}`,
            `H${x + rr}`,
            `A${rr},${rr} 0 0 1 ${x},${y + height - rr}`,
            `V${y + rr}`,
            `A${rr},${rr} 0 0 1 ${x + rr},${y}`,
            "Z"
        ].join(" ");
    }

    function evenoddHoleClipPath(outer, hole, radius) {
        if (!outer || !hole) return "";
        const outerPath = `M0,0 H${outer.width} V${outer.height} H0 Z`;
        const innerPath = roundedRectPath(hole.x, hole.y, hole.width, hole.height, radius);
        return `path(evenodd, "${outerPath} ${innerPath}")`;
    }

    function canHostPreview({ documentRef, container } = {}) {
        const root = documentRef?.documentElement;
        const body = documentRef?.body;
        if (!root || !body || !container) return { ok: false, reason: "missing-nodes" };
        if (container.parentNode && container.parentNode !== root) {
            return { ok: false, reason: "overlay-not-on-root" };
        }
        return { ok: true };
    }

    function matchingAnchor(anchors, target) {
        const list = Array.isArray(anchors) ? anchors : [];
        for (const anchor of list) {
            const raw = anchor?.getAttribute?.("href") || anchor?.href;
            if (!raw) continue;
            try {
                const href = new URL(String(raw), target.origin);
                if (href.origin === target.origin && normalizePath(href.pathname) === normalizePath(target.path || target.pathname)) {
                    return anchor;
                }
            } catch (error) {}
        }
        return null;
    }

    function collectAnchors(documentRef) {
        if (typeof documentRef?.querySelectorAll !== "function") return [];
        try {
            return Array.from(documentRef.querySelectorAll("a[href]"));
        } catch (error) {
            return [];
        }
    }

    // Preview entries must stack on top of the overlay marker. Clicking a
    // Canvas nav link lets the SPA push its own history. A missing same-origin
    // <a> returns PREVIEW_NAVIGATION_UNAVAILABLE rather than assigning
    // location.href, which would reload Canvas and tear the overlay down.
    function activateDestination(target, { documentRef, historyController } = {}) {
        if (historyController && typeof historyController.canStackPreview === "function" && !historyController.canStackPreview()) {
            return { ok: false, code: "OVERLAY_PREVIEW_HISTORY_BLOCKED" };
        }
        const anchor = matchingAnchor(collectAnchors(documentRef), target);
        if (anchor && typeof anchor.click === "function") {
            try {
                anchor.click();
                return { ok: true, method: "link", href: target.href };
            } catch (error) {}
        }
        return { ok: false, code: "PREVIEW_NAVIGATION_UNAVAILABLE" };
    }

    function readScroll(windowRef, documentRef) {
        const x = Number(windowRef?.scrollX);
        const y = Number(windowRef?.scrollY);
        if (Number.isFinite(x) || Number.isFinite(y)) {
            return { x: Number.isFinite(x) ? x : 0, y: Number.isFinite(y) ? y : 0 };
        }
        return {
            x: Number(documentRef?.documentElement?.scrollLeft) || 0,
            y: Number(documentRef?.documentElement?.scrollTop) || 0
        };
    }

    function measureRect(node) {
        try {
            const box = node?.getBoundingClientRect?.();
            if (box && Number(box.width) > 1 && Number(box.height) > 1) {
                const x = Number(box.left);
                const y = Number(box.top);
                const width = Number(box.width);
                const height = Number(box.height);
                if ([x, y, width, height].every(Number.isFinite)) return { x, y, width, height };
            }
        } catch (error) {}
        return null;
    }

    function createPreviewEngine({
        documentRef,
        windowRef,
        overlay,
        fill,
        backdrop,
        previewViewport,
        pageSelect,
        zoomValue,
        historyController,
        createLedger,
        insets,
        onState
    } = {}) {
        const doc = documentRef;
        const win = windowRef;
        let active = false;
        let generation = 0;
        let zoom = ZOOM_DEFAULT;
        let fullscreen = true;
        let lifecycleLedger = null;
        let presentationLedger = null;
        let styledBody = null;
        let scrollSnapshot = { x: 0, y: 0 };
        let layoutTimer = null;
        let retryTimer = null;
        let retryUsesAnimationFrame = false;
        let retryToken = 0;
        let pendingNavigate = false;
        let available = false;
        let suspended = false;

        function emit(extra) {
            if (typeof onState === "function") {
                try { onState({ active, available, zoom, fullscreen, pendingNavigate, ...extra }); } catch (error) {}
            }
        }

        function cancelScheduled() {
            if (layoutTimer == null) return;
            const cancel = win?.cancelAnimationFrame;
            if (typeof cancel === "function") cancel(layoutTimer);
            else clearTimeout(layoutTimer);
            layoutTimer = null;
        }

        function cancelRetry() {
            retryToken += 1;
            if (retryTimer == null) return;
            const cancel = win?.cancelAnimationFrame;
            if (retryUsesAnimationFrame && typeof cancel === "function") cancel(retryTimer);
            else clearTimeout(retryTimer);
            retryTimer = null;
            retryUsesAnimationFrame = false;
        }

        function scheduleRetry() {
            if (!active || suspended || retryTimer != null) return;
            const schedule = win?.requestAnimationFrame;
            const token = ++retryToken;
            const run = () => {
                if (token !== retryToken) return;
                retryTimer = null;
                retryUsesAnimationFrame = false;
                applyLayout();
            };
            retryUsesAnimationFrame = typeof schedule === "function";
            retryTimer = retryUsesAnimationFrame ? schedule(run) : setTimeout(run, LAYOUT_RETRY_DELAY_MS);
        }

        function currentViewport() {
            return {
                width: Number(win?.innerWidth) || 0,
                height: Number(win?.innerHeight) || 0
            };
        }

        function layoutRects() {
            const viewport = currentViewport();
            const panel = computePanelRect(viewport, { fullscreen, inset: FULL_VIEWPORT_INSET });
            const slots = computeSlots(panel, { previewEnabled: true, viewportWidth: viewport.width });
            // CSS can grow the toolbar when its controls wrap. Only the actual
            // rendered viewport row is authoritative; the pure split remains
            // available for deterministic slot tests, never as a reveal guess.
            const previewRect = measureRect(previewViewport);
            return { viewport, panel, slots, previewRect };
        }

        function applyClip(previewRect) {
            const viewport = currentViewport();
            const panel = computePanelRect(viewport, { fullscreen, inset: FULL_VIEWPORT_INSET });
            if (backdrop?.style?.setProperty) {
                backdrop.style.setProperty("clip-path", evenoddHoleClipPath(viewport, previewRect, PREVIEW_RADIUS));
            }
            if (fill?.style?.setProperty) {
                const localHole = previewRect
                    ? {
                        x: previewRect.x - panel.x,
                        y: previewRect.y - panel.y,
                        width: previewRect.width,
                        height: previewRect.height
                    }
                    : null;
                fill.style.setProperty("clip-path", localHole ? evenoddHoleClipPath(panel, localHole, PREVIEW_RADIUS) : "");
            }
        }

        function clearClip() {
            backdrop?.style?.removeProperty?.("clip-path");
            fill?.style?.removeProperty?.("clip-path");
        }

        function restorePresentation() {
            clearClip();
            presentationLedger?.restore();
            presentationLedger = null;
            styledBody = null;
            available = false;
        }

        function syncChrome() {
            if (zoomValue) zoomValue.textContent = `${zoom}%`;
            if (pageSelect && win?.location?.href) {
                const current = destinationFromHref(win.location.href);
                if (current) pageSelect.value = current;
                const courseOption = pageSelect.querySelector?.('option[value="course-home"]');
                const hasCourse = Boolean(parseCourseId(win.location.href));
                if (courseOption) {
                    courseOption.disabled = !hasCourse;
                    if (!hasCourse) {
                        courseOption.setAttribute?.("disabled", "disabled");
                        courseOption.setAttribute?.("title", "Open a course page to preview Course home.");
                    } else {
                        courseOption.removeAttribute?.("disabled");
                        courseOption.removeAttribute?.("title");
                    }
                }
            }
        }

        function styleBody(body, transform) {
            if (!body?.style) return;
            if (styledBody !== body) {
                restorePresentation();
                presentationLedger = typeof createLedger === "function" ? createLedger() : null;
                if (!presentationLedger) return;
                if (doc.documentElement) presentationLedger.setStyle(doc.documentElement, "background-color", "#0a0f22");
                presentationLedger.setStyle(body, "transform-origin", transform.transformOrigin);
                presentationLedger.setStyle(body, "pointer-events", "none");
                presentationLedger.setStyle(body, "width", `${currentViewport().width}px`);
                presentationLedger.setStyle(body, "height", `${currentViewport().height}px`);
                presentationLedger.setStyle(body, "transform", transform.transform);
                styledBody = body;
                return;
            }
            body.style.setProperty("transform", transform.transform);
            body.style.setProperty("transform-origin", transform.transformOrigin);
            body.style.setProperty("width", `${currentViewport().width}px`);
            body.style.setProperty("height", `${currentViewport().height}px`);
        }

        function applyLayout({ retry = true } = {}) {
            if (!active || !doc?.body) return { ok: false, reason: "inactive" };
            if (suspended) {
                restorePresentation();
                return { ok: true, preview: false, reason: "covered" };
            }
            const current = currentViewport();
            if (!isPreviewLayoutAvailable(current)) {
                cancelRetry();
                restorePresentation();
                syncChrome();
                emit({ reason: "narrow", previewState: "off" });
                return { ok: true, preview: false, reason: "narrow" };
            }
            if (!available) emit({ reason: "measuring", previewState: "pending" });
            const { viewport, previewRect } = layoutRects();
            if (!previewRect || previewRect.width < 1 || previewRect.height < 1) {
                restorePresentation();
                syncChrome();
                emit({ reason: "pending-layout", previewState: "pending" });
                if (retry) scheduleRetry();
                return { ok: true, preview: false, reason: "pending-layout" };
            }
            const transform = computeBodyTransform(viewport, previewRect, zoom, scrollSnapshot);
            try {
                cancelRetry();
                styleBody(doc.body, transform);
                applyClip(previewRect);
                available = true;
                syncChrome();
                emit({ reason: "layout", previewState: "on" });
                return { ok: true, preview: true, transform };
            } catch (error) {
                restorePresentation();
                emit({ reason: "error", previewState: "pending" });
                if (retry) scheduleRetry();
                return { ok: false, preview: false, reason: "error" };
            }
        }

        // `js/content/lifecycle.js` owns the single pushState/replaceState
        // patch. A second wrapper here would nest inside it, so lifecycle's
        // identity check on dispose would fail and leak the original onto the
        // Canvas page forever. The lifecycle calls this instead.
        function notifyRoute() {
            pendingNavigate = false;
            if (!active) return { ok: false, reason: "inactive" };
            const applied = applyLayout();
            emit({ reason: "route" });
            return applied;
        }

        function attachGuards(currentLedger) {
            const root = doc?.documentElement;
            const Observer = win?.MutationObserver || (typeof MutationObserver === "function" ? MutationObserver : null);
            if (typeof Observer === "function" && root) {
                const observer = new Observer(() => {
                    if (!active) return;
                    applyLayout();
                });
                observer.observe(root, { childList: true, subtree: false });
                currentLedger.record(() => { try { observer.disconnect(); } catch (error) {} });
            }
            const Resize = win?.ResizeObserver || (typeof ResizeObserver === "function" ? ResizeObserver : null);
            if (typeof Resize === "function" && previewViewport) {
                const resizeObserver = new Resize(() => {
                    if (active && !suspended) applyLayout();
                });
                resizeObserver.observe(previewViewport);
                currentLedger.record(() => { try { resizeObserver.disconnect(); } catch (error) {} });
            }

            function listen(target, type, handler) {
                if (!target?.addEventListener) return;
                target.addEventListener(type, handler);
                currentLedger.record(() => target.removeEventListener(type, handler));
            }
            listen(win, "resize", () => applyLayout());
            listen(win, "popstate", () => {
                pendingNavigate = false;
                applyLayout();
                emit({ reason: "popstate" });
            });
        }

        function start({ fullscreen: nextFullscreen = true } = {}) {
            stop();
            // Hosts must confirm the overlay container is a sibling of <body>
            // on <html> before calling start(). This engine only refuses when
            // there is no body to transform.
            if (!doc?.body) return { ok: false, preview: false, reason: "missing-nodes" };
            generation += 1;
            active = true;
            available = false;
            suspended = false;
            fullscreen = nextFullscreen === true;
            zoom = ZOOM_DEFAULT;
            styledBody = null;
            pendingNavigate = false;
            scrollSnapshot = readScroll(win, doc);
            lifecycleLedger = typeof createLedger === "function" ? createLedger() : null;
            attachGuards(lifecycleLedger || { record() {} });
            const applied = applyLayout();
            if (applied.ok === false && applied.reason === "error") {
                stop();
                return { ok: false, preview: false, reason: applied.reason };
            }
            emit({ reason: "start" });
            return { ok: true, preview: applied.preview === true, reason: applied.reason, zoom };
        }

        function stop() {
            generation += 1;
            const wasActive = active;
            active = false;
            suspended = false;
            pendingNavigate = false;
            cancelScheduled();
            cancelRetry();
            restorePresentation();
            lifecycleLedger?.restore();
            lifecycleLedger = null;
            if (wasActive) emit({ reason: "stop" });
        }

        // Closing geometry must never race a stale cutout. Cover synchronously
        // and suspend further layout work until the host either resumes a
        // cancelled close or completes teardown.
        function cover() {
            if (!active) return { ok: true, preview: false, reason: "inactive" };
            suspended = true;
            cancelScheduled();
            cancelRetry();
            restorePresentation();
            return { ok: true, preview: false, reason: "covered" };
        }

        function resume() {
            if (!active) return { ok: false, preview: false, reason: "inactive" };
            suspended = false;
            return applyLayout();
        }

        function setFullscreen(value) {
            fullscreen = value === true;
            if (active && !suspended) applyLayout();
            return { ok: true, fullscreen };
        }

        function setZoom(payload) {
            zoom = resolveZoom(payload, zoom);
            if (active && !suspended) applyLayout();
            syncChrome();
            emit({ reason: "zoom" });
            return { ok: true, zoom };
        }

        function navigate(payload) {
            if (!active) return { ok: false, code: "PREVIEW_INACTIVE" };
            const origin = originOf(win?.location?.href) || originOf(win?.location?.origin);
            const resolved = resolveNavigation(payload, { origin, href: win?.location?.href });
            if (!resolved.ok) return resolved;
            pendingNavigate = true;
            const token = generation;
            const result = activateDestination(resolved, { documentRef: doc, windowRef: win, historyController });
            if (token !== generation) return { ok: false, code: "PREVIEW_CLOSED" };
            if (result.ok === false) {
                pendingNavigate = false;
                return result;
            }
            applyLayout();
            syncChrome();
            emit({ reason: "navigate", href: result.href, method: result.method });
            return { ok: true, ...result, zoom };
        }

        function prefersReducedMotion() {
            try { return win?.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true; } catch (error) { return false; }
        }

        function trackTransition() {
            if (!active || suspended) return;
            applyLayout();
            if (prefersReducedMotion() || typeof win?.requestAnimationFrame !== "function") return;
            const started = generation;
            const began = typeof performance !== "undefined" ? performance.now() : Date.now();
            const tick = () => {
                if (!active || generation !== started) return;
                applyLayout();
                const now = typeof performance !== "undefined" ? performance.now() : Date.now();
                if (now - began < LAYOUT_TRANSITION_MS) layoutTimer = win.requestAnimationFrame(tick);
                else layoutTimer = null;
            };
            tick();
        }

        return Object.freeze({
            start,
            stop,
            cover,
            resume,
            setFullscreen,
            setZoom,
            navigate,
            applyLayout,
            notifyRoute,
            trackTransition,
            get active() { return active; },
            get available() { return active && available && !suspended; },
            get zoom() { return zoom; },
            get pendingNavigate() { return pendingNavigate; }
        });
    }

    return Object.freeze({
        ZOOM_MIN,
        ZOOM_MAX,
        ZOOM_STEP,
        ZOOM_DEFAULT,
        FIT_MODE,
        LAYOUT_TRANSITION_MS,
        IFRAME_SLOT_FRACTION,
        PREVIEW_SLOT_FRACTION,
        FULL_VIEWPORT_INSET,
        PANEL_PADDING,
        PANEL_GAP_MIN,
        PANEL_GAP_FLUID_VW,
        PANEL_GAP_MAX,
        PANEL_GAP_CSS,
        EDITOR_LEFT_INSET_FLUID_VW,
        EDITOR_LEFT_INSET_MAX,
        EDITOR_LEFT_INSET_CSS,
        PREVIEW_RADIUS,
        PREVIEW_UTILITY_HEADER_HEIGHT,
        PREVIEW_TOOLBAR_HEIGHT,
        PREVIEW_TOOLBAR_GAP,
        PREVIEW_MIN_VIEWPORT_WIDTH,
        PREVIEW_ALIGN,
        DESTINATIONS,
        clamp,
        snapZoom,
        stepZoom,
        resolveZoom,
        parseCourseId,
        destinationFromHref,
        allowedCanvasPath,
        validateNavigationUrl,
        resolveNavigation,
        computePanelRect,
        computePanelGap,
        computeEditorLeftInset,
        isPreviewLayoutAvailable,
        computeSlots,
        computeFitScale,
        splitPreviewSlot,
        computeBodyTransform,
        evenoddHoleClipPath,
        canHostPreview,
        matchingAnchor,
        activateDestination,
        createPreviewEngine
    });
}));
