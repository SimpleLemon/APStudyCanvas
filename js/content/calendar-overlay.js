(function (root, factory) {
    "use strict";

    const api = factory();
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasContent = Object.assign(root.APStudyCanvasContent || {}, { CalendarOverlay: api });
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const CONTRACT_VERSION = 1;
    const CALENDAR_ROUTE_PATH = "/calendar";
    const CALENDAR_RANGE_MAX_DAYS = 62;
    const CALENDAR_RANGE_MAX_MS = CALENDAR_RANGE_MAX_DAYS * 24 * 60 * 60 * 1000;
    const STRICT_ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
    const ROOT_MARKER = "data-apstudycanvas-calendar-overlay";
    const ROOT_ID = "apstudycanvas-calendar-overlay-root";
    const READY_MARKER = "data-apstudycanvas-calendar-ready";
    const READY_CONTENT_MARKER = "data-apstudycanvas-calendar-content";
    const READY_MARKER_VALUE = "1";
    const REPLACEMENT_PARITY_VERSION = 1;
    const REPLACEMENT_PARITY_FLAG = "calendarReplacementParity";
    const REPLACEMENT_SELECTORS = Object.freeze([
        "#calendar-app",
        "[data-testid='calendar-app']",
        ".calendar-app"
    ]);
    // Replacement remains dormant until every item below is proven against
    // the live Canvas/Nest contract. The versioned marker is intentionally
    // false in production and the vendored artifact does not advertise it.
    const REPLACEMENT_PARITY_GATE = Object.freeze([
        "month/week/agenda navigation",
        "all-day/timed event parity",
        "filters",
        "Nest CRUD and recurrence parity",
        "reminders/preferences parity",
        "source links",
        "completion styling/routing",
        "account events",
        "accessible dialogs"
    ]);
    const ANCHOR_SELECTORS = Object.freeze([
        "#calendar-app",
        "[data-testid='calendar-app']",
        ".calendar-app",
        "#content"
    ]);

    function isPlainObject(value) {
        if (!value || typeof value !== "object" || Array.isArray(value)) return false;
        const prototype = Object.getPrototypeOf(value);
        return prototype === Object.prototype || prototype === null;
    }

    function normalizeMode(value) {
        return value === "off" || value === "overlay" || value === "replace" ? value : "off";
    }

    function normalizedOrigin(location) {
        if (!location?.protocol || !location?.host) return null;
        try {
            const url = new URL(`${location.protocol}//${location.host}`);
            return url.protocol === "https:" && !url.username && !url.password ? url.origin : null;
        } catch (error) {
            return null;
        }
    }

    function isExactCanvasCalendarRoute(location, approvedOrigins = []) {
        const origin = normalizedOrigin(location);
        const approved = Array.isArray(approvedOrigins) && approvedOrigins.includes(origin);
        return Boolean(approved && location?.pathname === CALENDAR_ROUTE_PATH && !location?.hash);
    }

    function errorWithCode(code, message = code) {
        const error = new Error(message);
        error.code = code;
        return error;
    }

    function isAbortError(error) {
        return error?.name === "AbortError" || error?.code === "ABORTED" || error?.code === "CALENDAR_OVERLAY_ABORTED";
    }

    function abortError() {
        const error = errorWithCode("CALENDAR_OVERLAY_ABORTED");
        error.name = "AbortError";
        return error;
    }

    function strictInstant(value) {
        if (value instanceof Date) value = value.toISOString();
        if (typeof value !== "string" || !STRICT_ISO_INSTANT.test(value)) return null;
        const parsed = new Date(value);
        return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value ? value : null;
    }

    function normalizeRange(range) {
        if (!isPlainObject(range)) throw errorWithCode("NEST_CALENDAR_RANGE_INVALID");
        const startValue = range.start instanceof Date ? range.start.toISOString() : range.start;
        const endValue = range.end instanceof Date ? range.end.toISOString() : range.end;
        const start = strictInstant(startValue);
        const end = strictInstant(endValue);
        if (!start || !end) throw errorWithCode("NEST_CALENDAR_RANGE_INVALID");
        const startMs = Date.parse(start);
        const endMs = Date.parse(end);
        if (!(startMs < endMs)) throw errorWithCode("NEST_CALENDAR_RANGE_ORDER_INVALID");
        if (endMs - startMs > CALENDAR_RANGE_MAX_MS) throw errorWithCode("NEST_CALENDAR_RANGE_TOO_LARGE");
        return Object.freeze({ start, end });
    }

    function createRangeEnvelope(range, requestId) {
        const normalized = normalizeRange(range);
        if (typeof requestId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(requestId)) {
            throw errorWithCode("NEST_CALENDAR_RANGE_REQUEST_ID_INVALID");
        }
        return Object.freeze({
            version: CONTRACT_VERSION,
            request_id: requestId,
            type: "NEST_CALENDAR_RANGE_GET",
            payload: normalized
        });
    }

    function randomRequestId(win) {
        try {
            if (typeof win?.crypto?.randomUUID === "function") return `calendar-${win.crypto.randomUUID()}`.slice(0, 160);
        } catch (error) {}
        return `calendar-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`.slice(0, 160);
    }

    function sendRuntimeMessage(chromeApi, message, signal) {
        if (signal?.aborted) return Promise.reject(abortError());
        if (typeof chromeApi?.runtime?.sendMessage !== "function") return Promise.reject(errorWithCode("CALENDAR_RUNTIME_UNAVAILABLE"));
        return new Promise((resolve, reject) => {
            let settled = false;
            let promise;
            const cleanup = () => signal?.removeEventListener?.("abort", onAbort);
            const settle = (error, value) => {
                if (settled) return;
                settled = true;
                cleanup();
                if (error) reject(error);
                else resolve(value);
            };
            const onAbort = () => settle(abortError());
            signal?.addEventListener?.("abort", onAbort, { once: true });
            try {
                promise = chromeApi.runtime.sendMessage(message, (response) => settle(null, response));
            } catch (error) {
                settle(error);
                return;
            }
            if (promise && typeof promise.then === "function") promise.then((value) => settle(null, value), (error) => settle(error));
        });
    }

    function artifactIsCompatible(artifact) {
        return Boolean(
            isPlainObject(artifact)
            && artifact.contractVersion === CONTRACT_VERSION
            && typeof artifact.mountCalendar === "function"
            && typeof artifact.createCalendarDataAdapter === "function"
        );
    }

    function replacementParityIsReady(artifact, flags) {
        const platformMarker = flags?.[REPLACEMENT_PARITY_FLAG];
        const artifactMarker = artifact?.[REPLACEMENT_PARITY_FLAG];
        return Boolean(
            flags?.replacement === true
            && isPlainObject(platformMarker)
            && platformMarker.version === REPLACEMENT_PARITY_VERSION
            && platformMarker.ready === true
            && isPlainObject(artifactMarker)
            && artifactMarker.version === REPLACEMENT_PARITY_VERSION
            && artifactMarker.ready === true
        );
    }

    function readOnlyCapabilities({ mode = "overlay" } = {}) {
        return Object.freeze({
            contractVersion: CONTRACT_VERSION,
            mode,
            readOnly: true,
            readOnlyValid: true,
            shareMode: false,
            shareModeValid: true,
            overlay: mode === "overlay",
            replacement: false,
            mutation: false,
            crud: false,
            share: false,
            writeback: false,
            mirror: false,
            delete: false,
            projection: true,
            canvasMutation: false,
            nestMutation: false,
            parityGate: REPLACEMENT_PARITY_GATE,
            actionSupport: Object.freeze({
                routeDisplayOverride: false,
                retryWriteback: false,
                openSourceUrl: false
            }),
            data: Object.freeze({ events: [], sources: [], writebacks: [] })
        });
    }

    function findCalendarAnchor(doc) {
        for (const selector of ANCHOR_SELECTORS) {
            const node = doc?.querySelector?.(selector);
            if (node && node.nodeType === 1 && node.isConnected !== false) return node;
        }
        return null;
    }

    function findNativeCalendarContainers(doc) {
        const nodes = [];
        const add = (node) => {
            if (node && node.nodeType === 1 && node.isConnected !== false && !nodes.includes(node)) nodes.push(node);
        };
        for (const selector of REPLACEMENT_SELECTORS) {
            if (typeof doc?.querySelectorAll === "function") {
                try { doc.querySelectorAll(selector).forEach(add); } catch (error) {}
            } else {
                try { add(doc?.querySelector?.(selector)); } catch (error) {}
            }
        }
        return nodes;
    }

    function hasReplacementReadyContent(rootNode) {
        if (!rootNode || rootNode.nodeType !== 1) return false;
        if (rootNode.getAttribute?.(READY_MARKER) !== READY_MARKER_VALUE) return false;
        if (rootNode.getAttribute?.(READY_CONTENT_MARKER) === READY_MARKER_VALUE) return true;
        try {
            return Boolean(rootNode.querySelector?.(`[${READY_CONTENT_MARKER}="${READY_MARKER_VALUE}"]`));
        } catch (error) {
            return false;
        }
    }

    function createCalendarDataAdapter({ chromeApi, window: win, signal, onRangeError } = {}) {
        let lastRange = null;
        let requestSequence = 0;
        let disposed = false;

        function linkedSignal(requestSignal) {
            if (typeof AbortController !== "function") return { signal: requestSignal || signal, dispose: () => {} };
            const controller = new AbortController();
            const sources = [signal, requestSignal].filter((candidate, index, values) => candidate && values.indexOf(candidate) === index);
            const abort = () => controller.abort();
            sources.forEach((source) => {
                if (source.aborted) controller.abort();
                else source.addEventListener?.("abort", abort, { once: true });
            });
            return {
                signal: controller.signal,
                dispose: () => sources.forEach((source) => source.removeEventListener?.("abort", abort))
            };
        }

        function nextRequestId() {
            requestSequence += 1;
            return `${randomRequestId(win)}-${requestSequence}`.slice(0, 160);
        }

        async function loadRange({ range, signal: requestSignal } = {}) {
            if (disposed || signal?.aborted) throw abortError();
            let normalized;
            const linked = linkedSignal(requestSignal);
            try {
                normalized = normalizeRange(range);
                const envelope = createRangeEnvelope(normalized, nextRequestId());
                const response = await sendRuntimeMessage(chromeApi, envelope, linked.signal);
                if (linked.signal?.aborted || requestSignal?.aborted || signal?.aborted) throw abortError();
                const payload = isPlainObject(response?.payload) ? response.payload : response;
                if (!isPlainObject(payload) || payload.ok !== true) {
                    throw errorWithCode(typeof payload?.code === "string" ? payload.code : "NEST_CALENDAR_RANGE_UNAVAILABLE");
                }
                lastRange = normalized;
                return payload;
            } catch (error) {
                if (!isAbortError(error)) {
                    try { onRangeError?.(error); } catch (callbackError) {}
                }
                throw error;
            } finally {
                linked.dispose();
            }
        }

        async function refresh({ signal: requestSignal } = {}) {
            if (!lastRange) return { ok: true, contractVersion: CONTRACT_VERSION, events: [], sources: [] };
            return loadRange({ range: lastRange, signal: requestSignal });
        }

        function dispose() {
            disposed = true;
            lastRange = null;
        }

        async function loadPreferences() {
            return { response: { ok: true, status: 200 }, payload: { preferences: [] } };
        }

        async function loadCourses() {
            return {
                termsResponse: { ok: true, status: 200 },
                sectionsResponse: { ok: true, status: 200 },
                termsPayload: { terms: [] },
                sectionsPayload: { sections: [] }
            };
        }

        async function loadCourseSectionsById() {
            return { response: { ok: true, status: 200 }, payload: { sections: [] } };
        }

        async function loadShares() {
            return { response: { ok: true, status: 200 }, payload: { shares: [] } };
        }

        return Object.freeze({ loadRange, refresh, loadPreferences, loadCourses, loadCourseSectionsById, loadShares, dispose });
    }

    function createCalendarOverlayController({
        window: win = globalThis.window,
        document: doc = globalThis.document,
        chromeApi = globalThis.chrome,
        contextService,
        getContext,
        getFlags,
        getMode,
        getArtifact = () => globalThis.APStudyCalendarExtension,
        onStatus = () => {},
        anchorTimeoutMs = 5000,
        anchorStableMs = 60,
        now = () => Date.now(),
        readinessRange,
        setTimer = setTimeout,
        clearTimer = clearTimeout,
        mutationObserver: MutationObserverClass = win?.MutationObserver || globalThis.MutationObserver
    } = {}) {
        if (!doc) return Object.freeze({ init: async () => ({ state: "unavailable" }), update: async () => {}, route: async () => {}, refresh: async () => {}, pause: () => {}, resume: () => {}, dispose: () => {}, getState: () => ({ state: "unavailable" }) });

        let activation = null;
        let activationPromise = null;
        let anchorObserver = null;
        let anchorTimer = null;
        let anchorStableTimer = null;
        let mountedObserver = null;
        let mountDispose = null;
        let mountedRoot = null;
        let adapter = null;
        let nativeSnapshots = [];
        let lifecycleListenersBound = false;
        let lifecycleListeners = null;
        let state = "idle";
        let lastError = null;

        function clearAnchorWait() {
            anchorObserver?.disconnect?.();
            anchorObserver = null;
            if (anchorTimer !== null) clearTimer(anchorTimer);
            if (anchorStableTimer !== null) clearTimer(anchorStableTimer);
            anchorTimer = null;
            anchorStableTimer = null;
        }

        function clearMountedObserver() {
            mountedObserver?.disconnect?.();
            mountedObserver = null;
        }

        function propertySnapshot(node, property) {
            return { present: property in Object(node), value: node[property] };
        }

        function styleSnapshot(node) {
            const snapshot = propertySnapshot(node, "style");
            return Object.freeze({
                present: snapshot.present,
                value: snapshot.value,
                cssText: typeof node.style?.cssText === "string" ? node.style.cssText : null
            });
        }

        function captureNativeSnapshot(nodes) {
            return nodes.map((node) => ({
                node,
                attributes: Object.freeze({
                    hidden: node.getAttribute?.("hidden") ?? null,
                    style: node.getAttribute?.("style") ?? null,
                    class: node.getAttribute?.("class") ?? null,
                    "aria-hidden": node.getAttribute?.("aria-hidden") ?? null,
                    inert: node.getAttribute?.("inert") ?? null
                }),
                properties: Object.freeze({
                    hidden: propertySnapshot(node, "hidden"),
                    style: styleSnapshot(node),
                    className: propertySnapshot(node, "className"),
                    ariaHidden: propertySnapshot(node, "ariaHidden"),
                    inert: propertySnapshot(node, "inert")
                })
            }));
        }

        function restoreAttribute(node, name, value) {
            if (value === null) node.removeAttribute?.(name);
            else node.setAttribute?.(name, value);
        }

        function restoreProperty(node, snapshot, property) {
            if (property === "style") {
                if (snapshot?.cssText !== null && node.style) node.style.cssText = snapshot.cssText;
                return;
            }
            if (snapshot?.present) node[property] = snapshot.value;
            else if (Object.prototype.hasOwnProperty.call(node, property)) delete node[property];
        }

        function restoreNative() {
            for (const snapshot of nativeSnapshots) {
                const node = snapshot?.node;
                if (!node) continue;
                try {
                    restoreAttribute(node, "hidden", snapshot.attributes.hidden);
                    restoreAttribute(node, "style", snapshot.attributes.style);
                    restoreAttribute(node, "class", snapshot.attributes.class);
                    restoreAttribute(node, "aria-hidden", snapshot.attributes["aria-hidden"]);
                    restoreAttribute(node, "inert", snapshot.attributes.inert);
                    restoreProperty(node, snapshot.properties.hidden, "hidden");
                    restoreProperty(node, snapshot.properties.style, "style");
                    restoreProperty(node, snapshot.properties.className, "className");
                    restoreProperty(node, snapshot.properties.ariaHidden, "ariaHidden");
                    restoreProperty(node, snapshot.properties.inert, "inert");
                } catch (error) {}
            }
        }

        function hideNative() {
            for (const snapshot of nativeSnapshots) {
                const node = snapshot?.node;
                if (!node) continue;
                try {
                    node.hidden = true;
                    node.setAttribute?.("hidden", "");
                    node.ariaHidden = "true";
                    node.setAttribute?.("aria-hidden", "true");
                    node.inert = true;
                    node.setAttribute?.("inert", "");
                } catch (error) {
                    restoreNative();
                    throw error;
                }
            }
        }

        function sameNodeList(left, right) {
            return left.length === right.length && left.every((node, index) => node === right[index]);
        }

        function observeMountedDom(mode) {
            clearMountedObserver();
            if (typeof MutationObserverClass !== "function") return;
            const target = doc.body || doc.documentElement;
            if (!target) return;
            mountedObserver = new MutationObserverClass(() => {
                if (!mountedRoot || mountedRoot.isConnected === false) {
                    dispose("apstudy-root-removed");
                    return;
                }
                if (mode === "replace" && !sameNodeList(nativeSnapshots.map((snapshot) => snapshot.node), findNativeCalendarContainers(doc))) {
                    dispose("native-container-changed");
                }
            });
            mountedObserver.observe(target, { childList: true, subtree: true });
        }

        function removeOwnedRoot() {
            if (mountedRoot?.parentNode) mountedRoot.parentNode.removeChild(mountedRoot);
            mountedRoot = null;
            const stale = doc.getElementById?.(ROOT_ID);
            if (stale?.getAttribute?.(ROOT_MARKER) === "1" && stale.parentNode) stale.parentNode.removeChild(stale);
        }

        function dispose(reason = "dispose") {
            clearAnchorWait();
            clearMountedObserver();
            unbindLifecycleListeners();
            if (activation && !activation.signal.aborted) activation.abort(reason);
            activation = null;
            activationPromise = null;
            // Native restoration is deliberately the first teardown action;
            // APStudy's disposer and root removal must never run first.
            restoreNative();
            try {
                if (typeof mountDispose === "function") mountDispose();
            } catch (error) {}
            restoreNative();
            adapter?.dispose?.();
            adapter = null;
            mountDispose = null;
            removeOwnedRoot();
            nativeSnapshots = [];
            state = "disposed";
            lastError = reason;
        }

        function waitForStableNodes(signal, findNodes, timeoutCode, returnList) {
            return new Promise((resolve, reject) => {
                let settled = false;
                let previous = null;

                const finish = (error, value) => {
                    if (settled) return;
                    settled = true;
                    clearAnchorWait();
                    signal?.removeEventListener?.("abort", onAbort);
                    if (error) reject(error);
                    else resolve(value);
                };
                const onAbort = () => finish(abortError());
                const check = () => {
                    if (signal?.aborted) return onAbort();
                    const candidate = findNodes();
                    const candidateList = Array.isArray(candidate) ? candidate : candidate ? [candidate] : [];
                    if (!candidateList.length) {
                        previous = null;
                        if (anchorStableTimer !== null) clearTimer(anchorStableTimer);
                        anchorStableTimer = null;
                        return;
                    }
                    if (!previous || !sameNodeList(previous, candidateList)) {
                        previous = candidateList;
                        if (anchorStableTimer !== null) clearTimer(anchorStableTimer);
                        anchorStableTimer = setTimer(() => {
                            anchorStableTimer = null;
                            const current = findNodes();
                            const currentList = Array.isArray(current) ? current : current ? [current] : [];
                            if (sameNodeList(currentList, candidateList)) finish(null, returnList ? candidateList : candidateList[0]);
                            else check();
                        }, Math.max(0, Number(anchorStableMs) || 0));
                        return;
                    }
                    if (anchorStableTimer === null) {
                        anchorStableTimer = setTimer(() => finish(null, returnList ? candidateList : candidateList[0]), Math.max(0, Number(anchorStableMs) || 0));
                    }
                };

                signal?.addEventListener?.("abort", onAbort, { once: true });
                if (typeof MutationObserverClass === "function") {
                    anchorObserver = new MutationObserverClass(check);
                    const target = doc.body || doc.documentElement;
                    if (target) anchorObserver.observe(target, { childList: true, subtree: true });
                }
                anchorTimer = setTimer(() => finish(errorWithCode(timeoutCode)), Math.max(0, Number(anchorTimeoutMs) || 0));
                check();
            });
        }

        function waitForStableAnchor(signal) {
            return waitForStableNodes(signal, () => findCalendarAnchor(doc), "CANVAS_CALENDAR_ANCHOR_TIMEOUT", false);
        }

        function waitForStableNativeContainers(signal) {
            return waitForStableNodes(signal, () => findNativeCalendarContainers(doc), "CALENDAR_NATIVE_CONTAINER_TIMEOUT", true);
        }

        async function readMode(explicitMode) {
            if (explicitMode !== undefined) return normalizeMode(explicitMode);
            if (typeof getMode === "function") {
                try {
                    const value = await getMode();
                    return normalizeMode(value?.canvas_calendar_mode ?? value);
                } catch (error) {
                    return "off";
                }
            }
            return "off";
        }

        async function readFlags() {
            if (typeof getFlags !== "function") return {};
            try {
                const value = await getFlags();
                return isPlainObject(value?.["platform.flags"]) ? value["platform.flags"] : (isPlainObject(value) ? value : {});
            } catch (error) {
                return {};
            }
        }

        async function readVerifiedContext() {
            let context;
            try {
                context = typeof getContext === "function" ? await getContext() : await contextService?.getContext?.();
            } catch (error) {
                return { ok: false, state: "error", code: "CANVAS_CONTEXT_ERROR" };
            }
            if (!context || context.ok !== true || context.state !== "connected" || !context.origin || !context.canvasUser?.id) {
                return context || { ok: false, state: "waiting", code: "CANVAS_ACCOUNT_VERIFICATION_WAITING" };
            }
            try {
                const verified = await contextService?.verifyAccount?.({ expectedOrigin: context.origin, expectedUserId: context.canvasUser.id });
                if (verified) return verified;
            } catch (error) {
                return { ok: false, state: "error", code: "CANVAS_ACCOUNT_VERIFY_ERROR" };
            }
            return { ok: true, state: "verified", origin: context.origin, userId: context.canvasUser.id, profile: context.profile };
        }

        function mount(artifact, anchors, currentActivation, mode) {
            if (currentActivation.signal.aborted) throw abortError();
            if (!artifactIsCompatible(artifact)) throw errorWithCode("CALENDAR_ARTIFACT_CONTRACT_UNSUPPORTED");
            const existing = doc.getElementById?.(ROOT_ID);
            if (existing) throw errorWithCode("CALENDAR_OVERLAY_ALREADY_MOUNTED");
            const rootNode = doc.createElement("div");
            rootNode.id = ROOT_ID;
            rootNode.setAttribute(ROOT_MARKER, "1");
            rootNode.setAttribute("data-apstudycanvas-mode", mode);
            const anchor = Array.isArray(anchors) ? anchors[0] : anchors;
            const parent = anchor?.parentNode || anchor;
            if (!parent || typeof parent.insertBefore !== "function") throw errorWithCode("CALENDAR_OVERLAY_ANCHOR_INVALID");
            parent.insertBefore(rootNode, anchor.nextSibling || null);
            mountedRoot = rootNode;
            if (!adapter) adapter = createCalendarDataAdapter({ chromeApi, window: win, signal: currentActivation.signal, onRangeError: handleRangeError });
            try {
                mountDispose = artifact.mountCalendar(rootNode, adapter, readOnlyCapabilities({ mode }));
                if (typeof mountDispose !== "function") throw errorWithCode("CALENDAR_ARTIFACT_DISPOSE_UNAVAILABLE");
                if (currentActivation.signal.aborted || mountedRoot !== rootNode) {
                    try { mountDispose(); } catch (disposeError) {}
                    mountDispose = null;
                    throw abortError();
                }
                if (mode === "replace" && !hasReplacementReadyContent(rootNode)) {
                    throw errorWithCode("CALENDAR_REPLACEMENT_READY_MARKER_MISSING");
                }
                if (mode === "replace") {
                    nativeSnapshots = captureNativeSnapshot(anchors);
                    if (!nativeSnapshots.length) throw errorWithCode("CALENDAR_NATIVE_CONTAINER_MISSING");
                    hideNative();
                }
            } catch (error) {
                restoreNative();
                adapter.dispose();
                adapter = null;
                try { mountDispose?.(); } catch (disposeError) {}
                mountDispose = null;
                removeOwnedRoot();
                nativeSnapshots = [];
                throw error;
            }
            observeMountedDom(mode);
            state = "mounted";
            lastError = null;
        }

        function handleRangeError(error) {
            lastError = error?.code || "NEST_CALENDAR_RANGE_UNAVAILABLE";
            try { onStatus({ state: "error", code: lastError }); } catch (callbackError) {}
            dispose("range-error");
        }

        function initialRange() {
            if (readinessRange) return normalizeRange(readinessRange);
            const start = new Date(Number(now()) || Date.now());
            start.setUTCHours(0, 0, 0, 0);
            const end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
            return normalizeRange({ start, end });
        }

        function bindLifecycleListeners() {
            if (lifecycleListenersBound) return;
            const onNavigation = () => {
                route({ path: win?.location?.pathname, href: win?.location?.href });
            };
            win?.addEventListener?.("popstate", onNavigation);
            win?.addEventListener?.("hashchange", onNavigation);
            lifecycleListenersBound = true;
            lifecycleListeners = onNavigation;
        }

        function unbindLifecycleListeners() {
            if (!lifecycleListenersBound) return;
            win?.removeEventListener?.("popstate", lifecycleListeners);
            win?.removeEventListener?.("hashchange", lifecycleListeners);
            lifecycleListeners = null;
            lifecycleListenersBound = false;
        }

        async function activate(explicitMode) {
            const currentActivation = activation;
            if (!currentActivation || currentActivation.signal.aborted) throw abortError();
            const mode = await readMode(explicitMode);
            if (currentActivation.signal.aborted || activation !== currentActivation) throw abortError();
            if (mode !== "overlay" && mode !== "replace") {
                dispose(mode === "replace" ? "replacement-unsupported" : "mode-off");
                state = "off";
                return { state, mode };
            }
            if (!isExactCanvasCalendarRoute(win?.location, [normalizedOrigin(win?.location)])) {
                dispose("route-exit");
                state = "off-route";
                return { state, mode };
            }

            const verified = await readVerifiedContext();
            if (!verified?.ok || verified.state !== "verified") {
                dispose(verified?.code || "CANVAS_ACCOUNT_VERIFICATION_WAITING");
                state = "gated";
                lastError = verified?.code || "CANVAS_ACCOUNT_VERIFICATION_WAITING";
                return { state, mode, code: lastError };
            }
            if (currentActivation.signal.aborted || activation !== currentActivation) throw abortError();
            if (!isExactCanvasCalendarRoute(win?.location, [verified.origin])) {
                dispose("route-exit");
                state = "off-route";
                return { state, mode };
            }
            const flags = await readFlags();
            if (flags.projection !== true || flags.overlay !== true) {
                dispose(flags.overlay !== true ? "FEATURE_DISABLED_OVERLAY" : "FEATURE_DISABLED_PROJECTION");
                state = "gated";
                lastError = flags.overlay !== true ? "FEATURE_DISABLED_OVERLAY" : "FEATURE_DISABLED_PROJECTION";
                return { state, mode, code: lastError };
            }
            const artifact = typeof getArtifact === "function" ? getArtifact() : getArtifact;
            if (!artifactIsCompatible(artifact)) throw errorWithCode("CALENDAR_ARTIFACT_CONTRACT_UNSUPPORTED");
            if (mode === "replace" && !replacementParityIsReady(artifact, flags)) {
                dispose("replacement-unsupported");
                state = "off";
                lastError = "CALENDAR_REPLACEMENT_PARITY_NOT_READY";
                return { state, mode, code: lastError };
            }
            if (currentActivation.signal.aborted || activation !== currentActivation) throw abortError();
            if (!adapter) adapter = createCalendarDataAdapter({ chromeApi, window: win, signal: currentActivation.signal, onRangeError: handleRangeError });
            // The existing content readiness signal proves Canvas identity and
            // rollout flags, but it does not prove the account's read consent.
            // A bounded read-only range request is the final gate before DOM
            // insertion and also seeds refresh() with the last safe range.
            state = "checking-readiness";
            await adapter.loadRange({ range: initialRange(), signal: currentActivation.signal });
            if (currentActivation.signal.aborted || activation !== currentActivation) throw abortError();
            state = "waiting-anchor";
            const anchors = mode === "replace"
                ? await waitForStableNativeContainers(currentActivation.signal)
                : await waitForStableAnchor(currentActivation.signal);
            if (currentActivation.signal.aborted || activation !== currentActivation) throw abortError();
            mount(artifact, anchors, currentActivation, mode);
            return { state, mode, contractVersion: CONTRACT_VERSION };
        }

        function init(options = {}) {
            const forced = options.force === true;
            if (activationPromise && !forced) return activationPromise;
            if (!forced && state === "mounted" && options.mode === undefined) return Promise.resolve({ state, mode: "overlay" });
            if (forced || activation || mountedRoot || nativeSnapshots.length) dispose("reinitialize");
            bindLifecycleListeners();
            activation = new AbortController();
            const currentActivation = activation;
            activationPromise = Promise.resolve().then(() => activate(options.mode)).catch((error) => {
                if (!isAbortError(error)) {
                    lastError = error?.code || "CALENDAR_OVERLAY_INIT_FAILED";
                    try { onStatus({ state: "error", code: lastError }); } catch (callbackError) {}
                    dispose("mount-error");
                }
                return { state: isAbortError(error) ? "aborted" : "error", code: error?.code };
            }).finally(() => {
                if (activation === currentActivation) activationPromise = null;
            });
            return activationPromise;
        }

        function update(changes = {}, areaName) {
            const hasChange = (keys) => keys.some((key) => Object.prototype.hasOwnProperty.call(changes, key));
            const relevant = areaName === undefined
                || areaName === "sync" && Object.prototype.hasOwnProperty.call(changes, "canvas_calendar_mode")
                || areaName === "local" && hasChange(["platform.flags", "platform.accountMetadata", "platform.consent", "platform.identity", "platform.account"]);
            if (!relevant) return Promise.resolve({ state });
            return init({ mode: changes.canvas_calendar_mode?.newValue, force: true });
        }

        function route({ path, href } = {}) {
            const currentPath = path || win?.location?.pathname;
            const hash = href ? (() => { try { return new URL(href).hash; } catch (error) { return win?.location?.hash; } })() : win?.location?.hash;
            if (currentPath !== CALENDAR_ROUTE_PATH || hash) {
                dispose("route-exit");
                return Promise.resolve({ state: "off-route" });
            }
            if (state === "mounted" && !activationPromise) return init();
            return init({ force: true });
        }

        function refresh() {
            if (state !== "mounted") return Promise.resolve({ state });
            return adapter?.refresh?.() || Promise.resolve({ ok: true, events: [], sources: [] });
        }

        function pause() {
            if (state === "mounted" || state === "waiting-anchor" || state === "gated") dispose("lifecycle-pause");
        }

        function resume() {
            return init();
        }

        return Object.freeze({
            init,
            update,
            route,
            refresh,
            pause,
            resume,
            dispose,
            getState: () => ({ state, lastError, mounted: Boolean(mountedRoot), hasActivation: Boolean(activation) }),
            constants: Object.freeze({ CONTRACT_VERSION, CALENDAR_ROUTE_PATH, CALENDAR_RANGE_MAX_DAYS, ROOT_MARKER, ROOT_ID, READY_MARKER, READY_CONTENT_MARKER, READY_MARKER_VALUE, REPLACEMENT_PARITY_VERSION, REPLACEMENT_PARITY_FLAG, REPLACEMENT_PARITY_GATE, ANCHOR_SELECTORS, REPLACEMENT_SELECTORS }),
            normalizeMode,
            normalizeRange,
            createRangeEnvelope,
            createCalendarDataAdapter,
            readOnlyCapabilities,
            artifactIsCompatible,
            replacementParityIsReady,
            findNativeCalendarContainers,
            hasReplacementReadyContent,
            isExactCanvasCalendarRoute
        });
    }

    return Object.freeze({
        CONTRACT_VERSION,
        CALENDAR_ROUTE_PATH,
        CALENDAR_RANGE_MAX_DAYS,
        ROOT_MARKER,
        ROOT_ID,
        READY_MARKER,
        READY_CONTENT_MARKER,
        READY_MARKER_VALUE,
        REPLACEMENT_PARITY_VERSION,
        REPLACEMENT_PARITY_FLAG,
        REPLACEMENT_PARITY_GATE,
        ANCHOR_SELECTORS,
        REPLACEMENT_SELECTORS,
        normalizeMode,
        normalizeRange,
        createRangeEnvelope,
        createCalendarDataAdapter,
        createCalendarOverlayController,
        readOnlyCapabilities,
        artifactIsCompatible,
        replacementParityIsReady,
        findNativeCalendarContainers,
        hasReplacementReadyContent,
        isExactCanvasCalendarRoute
    });
}));
