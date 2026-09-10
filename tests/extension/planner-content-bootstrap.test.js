"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");

const root = path.resolve(__dirname, "../..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const canvasEntries = manifest.content_scripts.filter((entry) => Array.isArray(entry.matches) && entry.matches.includes("https://canvas.emory.edu/*"));
const canvasScripts = canvasEntries.flatMap((entry) => entry.js || []);

class Element {
    constructor(document, tag) { this.ownerDocument = document; this.nodeName = tag.toUpperCase(); this.parentNode = null; this.childNodes = []; this.attributes = new Map(); this.listeners = new Map(); this.style = { setProperty: (key, value) => { this.style[key] = value; } }; this.value = ""; this.disabled = false; this.hidden = false; this.clientWidth = 0; this.scrollWidth = 0; this._computedStyle = {}; this._text = ""; this._className = ""; this.classList = { add: (...names) => { this.className = `${this.className} ${names.join(" ")}`.trim(); }, remove: (...names) => { this.className = this.className.split(/\s+/).filter((name) => !names.includes(name)).join(" "); }, contains: (name) => this.className.split(/\s+/).includes(name) }; }
    get children() { return this.childNodes.filter((node) => node instanceof Element); }
    get firstChild() { return this.childNodes[0] || null; }
    get firstElementChild() { return this.children[0] || null; }
    get isConnected() { return this === this.ownerDocument.body || Boolean(this.parentNode?.isConnected); }
    get className() { return this._className; }
    set className(value) { this._className = String(value || ""); this.attributes.set("class", this._className); }
    get id() { return this.getAttribute("id") || ""; }
    set id(value) { this.setAttribute("id", value); }
    get textContent() { return this._text || this.childNodes.map((node) => node.textContent || "").join(""); }
    set textContent(value) { this.replaceChildren(); this._text = String(value ?? ""); }
    append(...nodes) { nodes.forEach((node) => this.appendChild(node)); }
    appendChild(node) { if (!node) return node; node.parentNode?.removeChild?.(node); node.parentNode = this; this.childNodes.push(node); return node; }
    insertBefore(node, before) { node.parentNode?.removeChild?.(node); node.parentNode = this; const index = this.childNodes.indexOf(before); this.childNodes.splice(index < 0 ? this.childNodes.length : index, 0, node); return node; }
    removeChild(node) { const index = this.childNodes.indexOf(node); if (index >= 0) this.childNodes.splice(index, 1); node.parentNode = null; return node; }
    replaceChildren(...nodes) { this.childNodes.forEach((node) => { node.parentNode = null; }); this.childNodes = []; this._text = ""; nodes.forEach((node) => this.appendChild(node)); }
    remove() { this.parentNode?.removeChild?.(this); }
    setAttribute(name, value) { this.attributes.set(String(name), String(value)); if (name === "class") this._className = String(value); if (name === "value") this.value = String(value); }
    getAttribute(name) { return this.attributes.get(String(name)) ?? null; }
    removeAttribute(name) { this.attributes.delete(String(name)); }
    addEventListener(type, listener) { this.listeners.set(type, [...(this.listeners.get(type) || []), listener]); }
    removeEventListener(type, listener) { this.listeners.set(type, (this.listeners.get(type) || []).filter((item) => item !== listener)); }
    dispatch(type, properties = {}) { const event = { type, target: this, currentTarget: this, preventDefault() {}, stopPropagation() {}, ...properties }; (this.listeners.get(type) || []).slice().forEach((listener) => listener(event)); return event; }
    focus() { this.ownerDocument.activeElement = this; }
    setGeometry({ clientWidth, scrollWidth = clientWidth, inlineSize = `${clientWidth}px`, minInlineSize = "0px" } = {}) { this.clientWidth = Number(clientWidth) || 0; this.scrollWidth = Number(scrollWidth) || 0; this._computedStyle = { inlineSize, minInlineSize }; }
    getBoundingClientRect() { return { width: this.clientWidth, height: 0, top: 0, right: this.clientWidth, bottom: 0, left: 0, x: 0, y: 0, toJSON() { return {}; } }; }
    contains(node) { return node === this || this.childNodes.some((child) => child.contains?.(node)); }
    matches(selector) { const simple = selector.trim().replace(/:not\([^)]*\)/g, ""); const tag = simple.match(/^[\w-]+/)?.[0]; if (tag && this.nodeName.toLowerCase() !== tag.toLowerCase()) return false; const id = simple.match(/#([\w:-]+)/)?.[1]; if (id && id !== this.id) return false; const classes = [...simple.matchAll(/\.([\w-]+)/g)].map((match) => match[1]); if (classes.some((name) => !this.className.split(/\s+/).includes(name))) return false; return [...simple.matchAll(/\[([^\]=]+)(?:=['"]?([^\]'"\]]+)['"]?)?\]/g)].every(([, name, value]) => this.getAttribute(name) !== null && (value === undefined || this.getAttribute(name) === value)); }
    matchesDeep(selector) { const parts = selector.split(/\s+/); if (!this.matches(parts.at(-1))) return false; let node = this.parentNode; const seen = new Set(); for (let index = parts.length - 2; index >= 0; index -= 1) { while (node && !node.matches?.(parts[index])) { if (seen.has(node)) return false; seen.add(node); node = node.parentNode; } if (!node) return false; node = node.parentNode; } return true; }
    querySelectorAll(selector) { const found = []; const seen = new Set(); const choices = String(selector).split(",").map((item) => item.trim()); const visit = (node) => { if (seen.has(node)) return; seen.add(node); node.childNodes.forEach((child) => { if (child instanceof Element) { if (choices.some((choice) => child.matchesDeep(choice))) found.push(child); visit(child); } }); }; visit(this); return found; }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

class Document {
    constructor() { this.listeners = new Map(); this.readyState = "complete"; this.activeElement = null; this.documentElement = new Element(this, "html"); this.head = new Element(this, "head"); this.body = new Element(this, "body"); this.documentElement.append(this.head, this.body); this.cookie = "_csrf_token=bootstrap-token"; }
    createElement(tag) { return new Element(this, tag); }
    createElementNS(_namespace, tag) { return new Element(this, tag); }
    addEventListener(type, listener) { this.listeners.set(type, [...(this.listeners.get(type) || []), listener]); }
    removeEventListener(type, listener) { this.listeners.set(type, (this.listeners.get(type) || []).filter((item) => item !== listener)); }
    querySelector(selector) { if (selector === "html") return this.documentElement; if (selector === "body") return this.body; return this.documentElement.querySelector(selector); }
    querySelectorAll(selector) { return this.documentElement.querySelectorAll(selector); }
    getElementById(id) { return this.querySelector(`#${id}`); }
    contains(node) { return this.documentElement.contains(node); }
    listenerCount(type) { return (this.listeners.get(type) || []).length; }
    focusableElements() { const result = []; const visit = (node) => { node.children?.forEach((child) => { const tag = child.nodeName.toLowerCase(); const tabindex = child.getAttribute("tabindex"); const focusable = !child.hidden && child.getAttribute("aria-hidden") !== "true" && !child.disabled && (tag === "button" || tag === "input" || tag === "select" || tag === "textarea" || (tag === "a" && Boolean(child.getAttribute("href"))) || (tabindex !== null && tabindex !== "-1")); if (focusable) result.push(child); visit(child); }); }; visit(this.documentElement); return result; }
    tab() { const focusable = this.focusableElements(); const current = focusable.indexOf(this.activeElement); const next = focusable[current + 1] || focusable[0] || null; next?.focus?.(); return next; }
}

const flush = async (turns = 12) => { for (let index = 0; index < turns; index += 1) await new Promise((resolve) => setImmediate(resolve)); };

// Planner fixtures below are dated September 7. Keep their visibility independent of the wall clock.
function bootstrap(pathname = "/", { plannerEnabled = true, todoEnabled = true, selfStatus = 200, profileTimeZone = "America/New_York", profileStatus = 200, browserTimeZone = "America/New_York", now = Date.parse("2026-09-07T12:00:00Z"), width = 1440, dashboardCards = false, dashboardLegacyRail = false, plannerItems = [] } = {}) {
    const document = new Document();
    document.body.id = "application";
    const dashboard = pathname === "/" || pathname === "";
    let nativeTodo = null;
    let nativeRegion = null;
    let dashboardColumn = null;
    let dashboardCardsTarget = null;
    function mountNativeDashboardTodo({ replace = false } = {}) {
        if (replace) nativeRegion?.remove();
        // Current Canvas Dashboard topology: To Do is a semantic native
        // region, not the retired #right-side rail. The extension must mount
        // only into its sibling and leave every native node intact.
        if (!dashboardColumn || !dashboardColumn.isConnected) { dashboardColumn = document.createElement("aside"); dashboardColumn.setAttribute("data-canvas-dashboard-column", "right"); document.body.appendChild(dashboardColumn); }
        nativeRegion = document.createElement("section"); nativeRegion.setAttribute("role", "region"); nativeRegion.setAttribute("aria-labelledby", "planner-todo-heading");
        const heading = document.createElement("h2"); heading.id = "planner-todo-heading"; heading.textContent = "To Do";
        nativeTodo = document.createElement("ul"); nativeTodo.id = "planner-todosidebar-item-list";
        const nativeItem = document.createElement("a"); nativeItem.setAttribute("href", "/courses/1/assignments/1"); nativeItem.textContent = "Canvas native task"; nativeTodo.appendChild(nativeItem);
        nativeRegion.append(heading, nativeTodo); dashboardColumn.appendChild(nativeRegion);
    }
    if (dashboard) {
        mountNativeDashboardTodo();
        if (dashboardCards) { dashboardCardsTarget = document.createElement("section"); dashboardCardsTarget.id = "DashboardCard_Container"; document.body.insertBefore(dashboardCardsTarget, dashboardColumn); }
        if (dashboardLegacyRail) { const rightRail = document.createElement("div"); rightRail.id = "right-side"; document.body.appendChild(rightRail); }
    } else {
        const rightRail = document.createElement("div"); rightRail.id = "right-side"; document.body.appendChild(rightRail);
    }
    const windowListeners = new Map();
    const location = { origin: "https://canvas.emory.edu", protocol: "https:", host: "canvas.emory.edu", hostname: "canvas.emory.edu", pathname, href: `https://canvas.emory.edu${pathname}` };
    document.location = location;
    const window = { location, innerWidth: width, matchMedia: () => ({ matches: false }), addEventListener(type, listener) { windowListeners.set(type, [...(windowListeners.get(type) || []), listener]); }, removeEventListener(type, listener) { windowListeners.set(type, (windowListeners.get(type) || []).filter((item) => item !== listener)); } };
    window.history = { pushState(_state, _title, next) {
        const parsed = new URL(next, location.origin); location.pathname = parsed.pathname; location.href = parsed.href;
        // Canvas replaces the Dashboard right column on a course route. The
        // deterministic harness models only that route-owned anchor, never a
        // synthetic legacy rail on the current Dashboard itself.
        if (parsed.pathname !== "/" && !document.querySelector("#right-side")) {
            const rightRail = document.createElement("div"); rightRail.id = "right-side"; document.body.appendChild(rightRail);
        }
    } };
    const values = { custom_domain: [], planner_tasks_enabled: plannerEnabled, todo_enabled: todoEnabled, custom_cards_3: {}, dark_preset: {}, custom_font: { link: "", family: "" }, dashboard_compact_padding: "medium" };
    const storageListeners = [];
    const runtimeListeners = [];
    const messages = [];
    const plannerUrls = [];
    const canvasReadUrls = [];
    let currentPlannerItems = Array.isArray(plannerItems) ? plannerItems : [];
    let currentSelfStatus = selfStatus;
    const deferredRequests = [];
    const logs = [];
    let deferNextPlannerRequest = false;
    const chrome = {
        runtime: { id: "bootstrap-test", onMessage: { addListener(listener) { runtimeListeners.push(listener); } }, sendMessage(message, callback) { messages.push(message); if (message.action === "request" && deferNextPlannerRequest) { deferNextPlannerRequest = false; return new Promise((resolve, reject) => deferredRequests.push({ resolve, reject, callback })); } const reply = message.action === "request" ? { ok: true, status: 201, body: { id: 91 }, headers: {} } : { ok: true }; callback?.(reply); return Promise.resolve(reply); } },
        storage: { sync: { get(_keys, callback) { callback?.({ ...values }); return Promise.resolve({ ...values }); }, set(next) { Object.assign(values, next); return Promise.resolve(); } }, local: { get() { return Promise.resolve({}); }, set() { return Promise.resolve(); }, remove() { return Promise.resolve(); } }, onChanged: { addListener(listener) { storageListeners.push(listener); }, removeListener() {} } }
    };
    let timerId = 0;
    let immediateBudget = 40;
    const timers = new Map();
    const delayedTimers = new Map();
    const ClockDate = now === null ? Date : class extends Date {
        constructor(...args) { super(...(args.length ? args : [now])); }
        static now() { return now; }
    };
    const HarnessDateTimeFormat = function (...args) {
        const formatter = new Intl.DateTimeFormat(...args);
        if (args.length) return formatter;
        // The coordinator's range/presentation clock is intentionally a
        // different zone from the profile source in the Tokyo test below.
        // Explicit formatter zones retain native behavior for date conversion.
        return {
            format: formatter.format.bind(formatter),
            formatToParts: formatter.formatToParts.bind(formatter),
            resolvedOptions: () => ({ ...formatter.resolvedOptions(), timeZone: browserTimeZone })
        };
    };
    HarnessDateTimeFormat.prototype = Intl.DateTimeFormat.prototype;
    HarnessDateTimeFormat.supportedLocalesOf = Intl.DateTimeFormat.supportedLocalesOf.bind(Intl.DateTimeFormat);
    const context = { window, document, chrome, console: { log(...args) { logs.push(args); }, warn(...args) { logs.push(args); }, error(...args) { logs.push(args); } }, URL, URLSearchParams, AbortController, TextEncoder, TextDecoder, crypto: webcrypto, Date: ClockDate, Intl: { ...Intl, DateTimeFormat: HarnessDateTimeFormat }, fetch: async (url) => {
        const target = String(url);
        if (target.includes("/api/v1/users/self")) canvasReadUrls.push(target);
        const response = target.includes("/api/v1/users/self/profile")
            ? { status: profileStatus, body: profileStatus >= 200 && profileStatus < 300 ? { id: 1, time_zone: profileTimeZone, primary_email: "private@example.edu" } : {} }
            : target.includes("/api/v1/users/self")
                ? { status: currentSelfStatus, body: currentSelfStatus >= 200 && currentSelfStatus < 300 ? { id: 1, name: "Student" } : {} }
                : { status: 200, body: target.includes("/api/v1/planner/items") ? currentPlannerItems : [] };
        // Return JSON allocated in the VM realm, matching a browser fetch
        // response instead of accidentally exercising a cross-realm test fake.
        context.__testFetchBody = response.body;
        const body = vm.runInContext("JSON.parse(JSON.stringify(__testFetchBody))", context);
        delete context.__testFetchBody;
        return { ok: response.status >= 200 && response.status < 300, status: response.status, headers: { get() { return ""; } }, json: async () => body };
    }, MutationObserver: class { observe() {} disconnect() {} }, getComputedStyle(node) { return { inlineSize: node?._computedStyle?.inlineSize || "0px", minInlineSize: node?._computedStyle?.minInlineSize || "0px" }; }, setTimeout(callback, delay = 0) { const id = ++timerId; if (delay <= 20 && immediateBudget-- > 0) timers.set(id, setImmediate(() => { timers.delete(id); callback(); })); else delayedTimers.set(id, { callback, delay: Number(delay) || 0 }); return id; }, clearTimeout(id) { const timer = timers.get(id); if (timer) clearImmediate(timer); timers.delete(id); delayedTimers.delete(id); }, setInterval() { return ++timerId; }, clearInterval() {}, navigator: {}, globalThis: null };
    context.globalThis = context;
    vm.createContext(context);
    const executedScripts = [];
    const counts = { page: 0, task: 0, activePage: 0, activeTask: 0, rail: 0, nest: 0 };
    let content = null;
    // The manifest loader is faithful: it runs every static script in order.
    // At the coordinator boundary only, install observable adapters around the
    // already-loaded modules. `content.js` itself remains the manifest source
    // and captures these normal browser dependencies during its own execution.
    function instrumentContentCoordinator() {
        content = context.APStudyCanvasContent;
        const realPage = content.PlannerPageTransport;
        const realTasks = content.PlannerTasks;
        const realRail = content.TodoRightRail;
        content.PlannerPageTransport = Object.freeze({ ...realPage, create(options) { counts.page += 1; counts.activePage += 1; const transport = realPage.create(options); let disposed = false; return Object.freeze({ ...transport, fetchImpl(url, request) { plannerUrls.push({ url: String(url), method: String(request?.method || "GET").toUpperCase() }); return transport.fetchImpl(url, request); }, dispose() { if (!disposed) { disposed = true; counts.activePage -= 1; } transport.dispose(); } }); } });
        content.PlannerTasks = Object.freeze({ ...realTasks, createTransport(options) { counts.task += 1; counts.activeTask += 1; const transport = realTasks.createTransport(options); let disposed = false; return Object.freeze({ ...transport, dispose() { if (!disposed) { disposed = true; counts.activeTask -= 1; } transport.dispose(); } }); } });
        content.TodoRightRail = Object.freeze({ ...realRail, create(options) { counts.rail += 1; return realRail.create({ ...options, createNestTask: async () => { counts.nest += 1; return { ok: true }; } }); } });
    }
    canvasScripts.forEach((file) => {
        if (file === "js/content.js") instrumentContentCoordinator();
        vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), context, { filename: file });
        executedScripts.push(file);
    });
    return {
        document, window, chrome, nativeTodo: () => nativeTodo, nativeRegion: () => nativeRegion, counts, messages, plannerUrls, canvasReadUrls, logs, runtimeListeners, storageListeners, executedScripts,
        setPlannerItems(items) { currentPlannerItems = Array.isArray(items) ? items : []; },
        setSelfStatus(status) { currentSelfStatus = Number(status) || 0; },
        todoRuntime: () => context.APStudyCanvasTodoRuntime,
        todoState: () => context.APStudyCanvasTodoRuntime?.state?.(),
        replaceNativeDashboardTodo() { mountNativeDashboardTodo({ replace: true }); },
        setViewport(nextWidth) { window.innerWidth = nextWidth; (windowListeners.get("resize") || []).slice().forEach((listener) => listener()); },
        setDashboardCards(present) {
            if (present && !dashboardCardsTarget) { dashboardCardsTarget = document.createElement("section"); dashboardCardsTarget.id = "DashboardCard_Container"; document.body.insertBefore(dashboardCardsTarget, dashboardColumn); }
            if (!present) { dashboardCardsTarget?.remove(); dashboardCardsTarget = null; }
        },
        runTimersThrough(maxDelay = 100, limit = 1) {
            let executed = 0;
            for (const [id, timer] of Array.from(delayedTimers.entries())) {
                if (executed >= limit || timer.delay > maxDelay) continue;
                delayedTimers.delete(id); timer.callback(); executed += 1;
            }
            return executed;
        },
        pendingTimerCount(maxDelay = Infinity) { return Array.from(delayedTimers.values()).filter((timer) => timer.delay <= maxDelay).length; },
        setHarnessGeometry(columnWidth) {
            const region = nativeRegion;
            const host = document.querySelector('[data-apstudycanvas-owned="todo-right-rail-host"]');
            const rail = document.querySelector(".apstudy-todo-right-rail");
            region?.setGeometry({ clientWidth: columnWidth });
            host?.setGeometry({ clientWidth: columnWidth, inlineSize: `${columnWidth}px`, minInlineSize: "0px" });
            rail?.setGeometry({ clientWidth: columnWidth, inlineSize: `${Math.min(columnWidth, 380)}px`, minInlineSize: "0px" });
            return { region, host, rail, getComputedStyle: context.getComputedStyle };
        },
        navigateDashboard() {
            document.querySelector("#right-side")?.remove();
            mountNativeDashboardTodo({ replace: true });
            window.history.pushState({}, "", "/");
        },
        deferNextPlannerRequest() { deferNextPlannerRequest = true; },
        resolveDeferredPlannerRequest(reply = { ok: true, status: 201, body: { id: 91 }, headers: {} }) {
            const pending = deferredRequests.shift();
            assert.ok(pending, "a Planner request must be pending before its late response resolves");
            pending.callback?.(reply);
            pending.resolve(reply);
        },
        rejectDeferredPlannerRequest(error = new Error("late Planner transport failure")) {
            const pending = deferredRequests.shift();
            assert.ok(pending, "a Planner request must be pending before its late response rejects");
            pending.reject(error);
        },
        emitStorage(changes) { storageListeners.forEach((listener) => listener(changes, "sync")); },
        sendSettings(changes) {
            let reply;
            const returns = runtimeListeners.map((listener) => {
                context.__testSettingsMessage = { version: 1, request_id: "planner-bootstrap-settings", type: "SETTINGS_UPDATE", payload: { area: "sync", changes } };
                const request = vm.runInContext("JSON.parse(JSON.stringify(__testSettingsMessage))", context);
                delete context.__testSettingsMessage;
                return listener(request, { id: "bootstrap-test" }, (value) => {
                    // Chrome broadcasts to every listener but accepts only the
                    // first synchronous response for one message channel.
                    if (reply === undefined) reply = value;
                });
            });
            return { returns, reply, listenerCount: runtimeListeners.length };
        }
    };
}

test("manifest-ordered whole content bootstrap gates Planner transports and preserves one-owner writes", async () => {
    assert.deepEqual(canvasEntries.map((entry) => entry.js || []), [
        ["js/content/sidebar-watchdog.js"],
        canvasEntries[1].js
    ], "the fixture must include each Canvas-matched manifest entry in manifest order");
    const unsupported = bootstrap("/calendar");
    await flush();
    assert.deepEqual(unsupported.executedScripts, canvasScripts, "the whole VM executes every Canvas-matched static script in manifest order");
    assert.equal(unsupported.executedScripts.filter((file) => file === "js/content.js").length, 1, "the unmodified coordinator is loaded exactly once through the manifest");
    assert.ok(unsupported.document.listenerCount("visibilitychange") >= 1, "the separately declared sidebar watchdog entry was executed");
    assert.equal(unsupported.counts.task, 0);
    assert.equal(unsupported.counts.page, 0);
    unsupported.window.history.pushState({}, "", "/courses/1");
    await flush();
    assert.equal(unsupported.counts.task, 1, JSON.stringify(unsupported.logs));
    assert.equal(unsupported.counts.page, 1);

    const live = bootstrap("/");
    await flush();
    assert.equal(live.counts.task, 1, "supported startup creates one Planner task transport");
    assert.equal(live.counts.page, 1, "supported startup creates one Planner page transport");
    assert.equal(live.counts.rail, 1, "the actual rail mounts once");
    const add = live.document.querySelector(".apstudy-todo-add");
    assert.ok(add, "the whole coordinator rendered the real Add Task control");
    add.dispatch("click");
    assert.match(live.document.querySelector(".apstudy-todo-modal-status").textContent, /APStudyCanvas-owned planner task in Canvas/);
    const title = live.document.getElementById("apstudy-todo-field-title");
    const dueDate = live.document.getElementById("apstudy-todo-field-dueDate");
    if (!dueDate.value) { dueDate.value = "2026-09-07"; dueDate.dispatch("input"); }
    title.value = "Whole coordinator planner task";
    title.dispatch("input");
    live.document.querySelector(".apstudy-todo-form").dispatch("submit");
    await flush(4);
    assert.equal(live.messages.filter((message) => message.action === "request").length, 1, live.document.querySelector(".apstudy-todo-modal-status")?.textContent);
    assert.equal(live.counts.nest, 0);
    live.window.history.pushState({}, "", "/calendar");
    await flush();
    assert.equal(live.counts.activeTask, 0, "supported→unsupported disposes the Planner task owner");
    assert.equal(live.counts.activePage, 0, "supported→unsupported disposes the Planner page owner");
    assert.equal(live.todoState().mounted, false, "supported→unsupported removes the old rail");
    assert.equal(live.todoState().reason, "unsupported-route", "supported→unsupported records the current route reason rather than leaving a stale mounted diagnostic");

    const liveEnable = bootstrap("/", { plannerEnabled: false });
    await flush();
    assert.equal(liveEnable.counts.task, 0, "the default-off persisted preference owns no transport");
    const listenerCount = liveEnable.runtimeListeners.length;
    assert.equal(listenerCount, 1, "the coordinator registers its one runtime listener; the manifest watchdog is a document-lifecycle listener, not a second runtime receiver");
    const update = liveEnable.sendSettings({ planner_tasks_enabled: true });
    assert.equal(update.listenerCount, listenerCount, "the SETTINGS_UPDATE broadcast reaches every runtime listener registered by the manifest-ordered scripts");
    assert.equal(update.returns.length, listenerCount, "each registered runtime listener receives the same SETTINGS_UPDATE broadcast");
    assert.equal(update.reply?.payload?.ok, true, JSON.stringify(liveEnable.logs));
    assert.equal(liveEnable.counts.task, 1, "the real content message creates one enabled transport");
    liveEnable.emitStorage({ planner_tasks_enabled: { oldValue: false, newValue: true } });
    assert.equal(liveEnable.counts.task, 1, "the storage echo does not duplicate the message-owned transport");
    assert.equal(liveEnable.counts.rail, 1, "message plus storage echo does not remount a second rail");
    assert.equal(liveEnable.runtimeListeners.length, listenerCount, "message plus storage echo does not attach duplicate listeners");
    assert.equal(liveEnable.messages.filter((message) => message.action === "request").length, 0, "preference synchronization never writes Planner data");

    const pending = bootstrap("/");
    await flush();
    pending.deferNextPlannerRequest();
    pending.document.querySelector(".apstudy-todo-add").dispatch("click");
    const pendingTitle = pending.document.getElementById("apstudy-todo-field-title");
    pendingTitle.value = "Route-cancelled planner task";
    pendingTitle.dispatch("input");
    pending.document.querySelector(".apstudy-todo-form").dispatch("submit");
    await flush(4);
    assert.equal(pending.messages.filter((message) => message.action === "request").length, 1, "the pending write reached Planner once");
    pending.window.history.pushState({}, "", "/courses/2");
    await flush();
    assert.equal(pending.messages.filter((message) => message.action === "cancel").length, 1, "SPA route change cancels the pending Planner write exactly once");
    assert.equal(pending.messages.filter((message) => message.action === "request").length, 1, "route change never retries an ambiguous write");
    assert.equal(pending.document.querySelector(".apstudy-todo-modal"), null, "the retired old-route dialog cannot show stale success");
    assert.equal(pending.counts.activeTask, 1, "the fresh supported route has one current Planner task owner");
    assert.equal(pending.counts.activePage, 1, "the fresh supported route has one current Planner page owner");
    assert.equal(pending.counts.task, 2, "the new supported route creates exactly one replacement Planner task transport");
    assert.equal(pending.counts.page, 2, "the new supported route creates exactly one replacement Planner page transport");
    const freshRail = pending.document.querySelector(".apstudy-todo-right-rail");
    const freshTaskCount = freshRail?.querySelectorAll(".apstudy-todo-task").length;
    pending.resolveDeferredPlannerRequest();
    await flush(4);
    assert.equal(pending.messages.filter((message) => message.action === "cancel").length, 1, "a late Planner response cannot issue another cancellation");
    assert.equal(pending.messages.filter((message) => message.action === "request").length, 1, "a late Planner response cannot retry the retired write");
    assert.equal(pending.document.querySelector(".apstudy-todo-modal"), null, "a late Planner success cannot reopen or update a retired dialog");
    assert.equal(pending.document.querySelector(".apstudy-todo-right-rail")?.querySelectorAll(".apstudy-todo-task").length, freshTaskCount, "a late Planner success cannot mutate the fresh route task list");
    assert.doesNotMatch(pending.document.body.textContent, /Task created in Canvas|late Planner transport failure/, "the fresh route has no stale Planner completion or failure notice");
});

test("manifest-ordered coordinator retires a late rejected Planner write after SPA navigation", async () => {
    const unhandledRejections = [];
    const observeUnhandledRejection = (reason) => { unhandledRejections.push(reason); };
    process.on("unhandledRejection", observeUnhandledRejection);
    try {
        const pending = bootstrap("/");
        await flush();
        pending.deferNextPlannerRequest();
        pending.document.querySelector(".apstudy-todo-add").dispatch("click");
        const title = pending.document.getElementById("apstudy-todo-field-title");
        const dueDate = pending.document.getElementById("apstudy-todo-field-dueDate");
        if (!dueDate.value) { dueDate.value = "2026-09-07"; dueDate.dispatch("input"); }
        title.value = "Late rejected Planner task";
        title.dispatch("input");
        pending.document.querySelector(".apstudy-todo-form").dispatch("submit");
        await flush(4);
        assert.equal(pending.messages.filter((message) => message.action === "request").length, 1, "the real rendered form dispatches one deferred Planner write");

        pending.window.history.pushState({}, "", "/courses/3");
        await flush();
        assert.equal(pending.messages.filter((message) => message.action === "cancel").length, 1, "SPA navigation cancels the old rejected write once");
        assert.equal(pending.messages.filter((message) => message.action === "request").length, 1, "route retirement never dispatches a second Planner write");
        assert.equal(pending.document.querySelector(".apstudy-todo-modal"), null, "route retirement removes the old rail dialog before its request settles");
        assert.equal(pending.counts.rail, 2, "the interrupted route retires the old rail and mounts one fresh rail");
        assert.equal(pending.counts.activeTask, 1, "the supported destination route owns exactly one fresh Planner task transport");
        assert.equal(pending.counts.activePage, 1, "the supported destination route owns exactly one fresh Planner page transport");
        assert.equal(pending.counts.task, 2, "the destination route creates exactly one replacement task transport");
        assert.equal(pending.counts.page, 2, "the destination route creates exactly one replacement page transport");
        const freshRail = pending.document.querySelector(".apstudy-todo-right-rail");
        const freshTaskCount = freshRail?.querySelectorAll(".apstudy-todo-task").length;

        pending.rejectDeferredPlannerRequest(new Error("late old-route Planner rejection"));
        await flush(8);

        assert.deepEqual(unhandledRejections, [], "late rejection is observed by the retired Planner operation and never becomes unhandled");
        assert.equal(pending.messages.filter((message) => message.action === "cancel").length, 1, "late rejection cannot issue another cancellation");
        assert.equal(pending.messages.filter((message) => message.action === "request").length, 1, "late rejection cannot retry or redispatch the old write");
        assert.equal(pending.document.querySelector(".apstudy-todo-modal"), null, "late rejection cannot reopen an old-route modal or render stale error status");
        assert.equal(pending.document.querySelector(".apstudy-todo-right-rail")?.querySelectorAll(".apstudy-todo-task").length, freshTaskCount, "late rejection cannot mutate the fresh route task list");
        assert.doesNotMatch(pending.document.body.textContent, /late old-route Planner rejection|Canvas could not create the task.|Task created in Canvas/, "the fresh route has no stale Planner error, success, or status copy");
    } finally {
        process.off("unhandledRejection", observeUnhandledRejection);
    }
});

test("current Dashboard mounts beside—not inside—the semantic Canvas To Do region", async () => {
    const live = bootstrap("/", { plannerEnabled: true, width: 1440 });
    await flush();
    const nativeRegion = live.nativeRegion();
    const nativeList = live.nativeTodo();
    const before = nativeRegion.textContent;
    const host = nativeRegion.parentNode.children[nativeRegion.parentNode.children.indexOf(nativeRegion) + 1];

    assert.equal(live.document.querySelectorAll("#right-side").length, 0, "the current Dashboard fixture has no synthetic legacy rail");
    assert.equal(host?.getAttribute("data-apstudycanvas-owned"), "todo-right-rail-host");
    assert.equal(host?.getAttribute("data-apstudycanvas-todo-placement"), "dashboard-native-todo-adjacent");
    assert.equal(live.document.querySelectorAll('[data-apstudycanvas-owned="todo-right-rail-host"]').length, 1, "the document owns one fallback wrapper");
    assert.equal(nativeRegion.textContent, before, "mounting preserves the native To Do heading, list, and descendants byte-for-byte in the harness");
    assert.equal(nativeList.hidden, false, "fallback mode never hides the native Canvas list");
    assert.equal(nativeList.getAttribute("aria-hidden"), null, "fallback mode never removes native To Do from the accessibility tree");
    const add = host.querySelector(".apstudy-todo-add");
    assert.ok(add, "the loading shell exposes Add Task before feed/account resolution");
    assert.equal(live.todoState().placement, "dashboard-native-todo-adjacent");
    assert.equal(live.todoState().reason, "mounted");
    nativeList.focus(); add.focus();
    assert.equal(live.document.activeElement, add, "the extension action remains after the native To Do list in DOM/focus order");
});

test("a hard-reload binding delay remounts To-Do through the bounded production retry", async () => {
    const live = bootstrap("/", { selfStatus: 503 });
    await flush();
    assert.equal(live.todoState().mounted, false, "the first transient account check fails closed and removes the unverified loading rail");
    assert.equal(live.todoState().reason, "binding-unavailable", "the runtime exposes a structural binding diagnostic instead of claiming a removed rail is mounted");
    assert.equal(live.pendingTimerCount(250), 1, "the real coordinator schedules one bounded binding retry after Canvas reports ready");

    live.setSelfStatus(200);
    assert.equal(live.runTimersThrough(250), 1, "the bounded retry runs after Canvas identity becomes available");
    await flush();

    assert.equal(live.todoState().mounted, true, "the real To-Do rail remounts without a Canvas reload once its verified binding resolves");
    assert.equal(live.todoState().reason, "mounted");
    assert.ok(live.document.querySelector(".apstudy-todo-add"), "the remounted production rail exposes its normal task action");
    assert.equal(live.pendingTimerCount(250), 0, "a verified binding cancels further retry work");
});

test("Planner-disabled current Dashboard uses the real Nest Add Task path once", async () => {
    const live = bootstrap("/", { plannerEnabled: false, width: 1440 });
    await flush();
    const add = live.document.querySelector(".apstudy-todo-add");
    assert.ok(add, "the Planner-off loading shell still mounts the current-Dashboard fallback rail");
    assert.equal(live.counts.task, 0, "Planner-off creates no Planner task transport");
    assert.equal(live.counts.page, 0, "Planner-off creates no Planner page transport");
    add.dispatch("click");
    assert.match(live.document.querySelector(".apstudy-todo-modal-status")?.textContent || "", /Nest tasks stay separate from Canvas assignments/, "the real dialog selects the Nest path while Planner is off");
    const title = live.document.getElementById("apstudy-todo-field-title");
    title.value = "Harness-only Nest task"; title.dispatch("input");
    live.document.querySelector(".apstudy-todo-form").dispatch("submit");
    await flush(6);
    assert.equal(live.counts.nest, 1, "the real rendered form calls the harmless Nest adapter once");
    assert.equal(live.counts.task, 0, "the Nest path never creates a Planner task transport");
    assert.equal(live.counts.page, 0, "the Nest path never creates a Planner page transport");
    assert.equal(live.messages.filter((message) => message.action === "request").length, 0, "the Nest path never sends a Planner page request");
});

test("whole coordinator promotes refreshed nested Planner Notes and mutates only their canonical Canvas id", async () => {
    const live = bootstrap("/", { plannerItems: [] });
    await flush();
    live.document.querySelector(".apstudy-todo-add").dispatch("click");
    const title = live.document.getElementById("apstudy-todo-field-title");
    const dueDate = live.document.getElementById("apstudy-todo-field-dueDate");
    title.value = "Create then refresh owned note";
    title.dispatch("input");
    if (!dueDate.value) { dueDate.value = "2026-09-07"; dueDate.dispatch("input"); }
    live.document.querySelector(".apstudy-todo-form").dispatch("submit");
    await flush(8);
    const post = live.messages.find((message) => message.action === "request" && message.request?.method === "POST");
    assert.ok(post, "the real rendered create path sends one Planner POST");
    assert.equal(live.counts.nest, 0, "Planner create never falls through to Nest");
    assert.match(post.request.body.details, /APSTUDYCANVAS_PLANNER_NOTE/, "the created record carries its durable ownership marker");

    live.setPlannerItems([{
        id: 9911,
        plannable_id: 41809,
        plannable_type: "planner_note",
        course_id: 42,
        plannable: {
            id: 41809,
            title: "Create then refresh owned note",
            todo_date: "2026-09-07T04:00:00Z",
            details: post.request.body.details,
            course_id: 42
        }
    }]);
    await live.todoRuntime().refresh("nested-planner-note-refresh");
    await flush(8);
    const row = live.document.querySelector(".apstudy-todo-task");
    assert.ok(row, "the real coordinator renders the refreshed nested Planner Note");
    assert.equal(row.querySelector("[data-action='complete-task']").disabled, false, "the ownership marker enables completion after refresh");
    assert.ok(row.querySelector("[data-action='edit-planner-task']"), "the ownership marker enables Edit after refresh");
    assert.match(row.querySelector(".apstudy-todo-task-due").textContent, /^Due 09\/07$/, "Canvas local-midnight Planner dates render as date-only rather than a misleading 12:00 AM instant");
    row.querySelector("[data-action='toggle-preview']").dispatch("click");
    assert.doesNotMatch(row.querySelector(".apstudy-todo-preview").textContent, /APSTUDYCANVAS_PLANNER_NOTE/, "the marker never leaks into the rendered preview");

    row.querySelector("[data-action='edit-planner-task']").dispatch("click");
    assert.equal(live.document.getElementById("apstudy-todo-field-dueDate").value, "2026-09-07", "the edit form receives the canonical date key, not Canvas's ISO timestamp");
    live.document.querySelector(".apstudy-todo-form").dispatch("submit");
    await flush(8);
    let requests = live.messages.filter((message) => message.action === "request");
    assert.equal(requests.slice(-1)[0].request.method, "PUT");
    assert.equal(requests.slice(-1)[0].request.id, "41809", "Edit targets the plannable note id, never planner row 9911");
    assert.equal(requests.slice(-1)[0].request.body.todo_date, "2026-09-07", "Edit serializes the canonical Planner date key");
    assert.equal(live.document.querySelector(".apstudy-todo-modal"), null, "the successful edit closes its modal before completion");
    live.document.querySelector("[data-action='complete-task']").dispatch("click");
    await flush(8);
    requests = live.messages.filter((message) => message.action === "request");
    assert.equal(requests.slice(-1)[0].request.method, "PUT");
    assert.equal(requests.slice(-1)[0].request.id, "41809", "completion uses the canonical nested Planner Note id");
    assert.equal(requests.slice(-1)[0].request.body.todo_date, "2026-09-07", "checkbox completion preserves the canonical date key");
    assert.equal(requests.slice(-1)[0].request.body.details.includes(":1"), true, "checkbox completion writes the completed ownership marker without entering an edit modal validation path");
    assert.equal(live.document.querySelector(".apstudy-todo-modal"), null, "checkbox completion never opens the edit modal");
    live.document.querySelector("#apstudy-todo-tab-done").dispatch("click");
    live.document.querySelector("[data-action='edit-planner-task']").dispatch("click");
    live.document.querySelector("[data-action='delete-planner-task']").dispatch("click");
    await flush(8);
    requests = live.messages.filter((message) => message.action === "request");
    assert.equal(requests.slice(-1)[0].request.method, "DELETE");
    assert.equal(requests.slice(-1)[0].request.id, "41809", "Delete uses the canonical nested Planner Note id");
    const lifecycle = requests.map(({ request }) => ({ method: request.method, id: request.id || null }));
    assert.deepEqual(lifecycle, [
        { method: "POST", id: null },
        { method: "PUT", id: "41809" },
        { method: "PUT", id: "41809" },
        { method: "DELETE", id: "41809" }
    ], "the lifecycle is exactly create, edit, completion, delete without a hidden retry");
    assert.deepEqual(live.plannerUrls, [
        { method: "POST", url: "https://canvas.emory.edu/api/v1/planner_notes" },
        { method: "PUT", url: "https://canvas.emory.edu/api/v1/planner_notes/41809" },
        { method: "PUT", url: "https://canvas.emory.edu/api/v1/planner_notes/41809" },
        { method: "DELETE", url: "https://canvas.emory.edu/api/v1/planner_notes/41809" }
    ], "each mutation URL uses the one canonical Planner Note resource id");
    assert.equal(lifecycle.filter(({ method }) => method === "POST").length, 1, "the refresh/action lifecycle issues one create");
    assert.equal(lifecycle.filter(({ method }) => method === "PUT").length, 2, "the lifecycle includes both edit and completion writes");
    assert.equal(lifecycle.filter(({ method }) => method === "DELETE").length, 1, "the lifecycle deletes exactly once");
    assert.equal(live.counts.nest, 0, "the full create→refresh→edit/complete/delete lifecycle issues no Nest writes");

    const foreign = bootstrap("/", { plannerItems: [
        { id: 9012, plannable_id: 41999, plannable_type: "planner_note", plannable: { id: 41999, title: "Unmarked Canvas note", todo_date: "2026-09-07", details: "Canvas-authored note" } },
        { id: 9013, plannable_id: 42000, plannable_type: "planner_note", plannable: { id: 42000, title: "Marker-only owned note", todo_date: "2026-09-07", details: "APSTUDYCANVAS_PLANNER_NOTE:1:pt-markeronly-1234567:0" } }
    ] });
    await flush(8);
    await foreign.todoRuntime().refresh("nested-planner-note-read-only");
    await flush(8);
    const foreignRow = foreign.document.querySelectorAll(".apstudy-todo-task").find((candidate) => /Unmarked Canvas note/.test(candidate.textContent));
    assert.equal(foreignRow.querySelector("[data-action='complete-task']").disabled, true, "an unmarked nested Canvas Planner Note remains read-only");
    assert.equal(foreignRow.querySelector("[data-action='edit-planner-task']"), null, "an unmarked nested Canvas Planner Note exposes no edit/delete path");
    const markerOnlyRow = foreign.document.querySelectorAll(".apstudy-todo-task").find((candidate) => /Marker-only owned note/.test(candidate.textContent));
    markerOnlyRow.querySelector("[data-action='toggle-preview']").dispatch("click");
    const markerOnlyPreview = markerOnlyRow.querySelector(".apstudy-todo-preview").textContent;
    assert.match(markerOnlyPreview, /No preview available for this item/, "a marker-only note does not invent preview copy");
    assert.doesNotMatch(markerOnlyPreview, /APSTUDYCANVAS_PLANNER_NOTE/, "a marker-only note never displays ownership metadata");
});

test("whole coordinator canonicalizes Canvas Planner Note timestamps in the authoritative account timezone", async () => {
    const details = "Timezone coverage\n\nAPSTUDYCANVAS_PLANNER_NOTE:1:pt-timezone-1234567:0";
    const cases = [
        { label: "existing date-only", profileTimeZone: "America/New_York", now: Date.parse("2026-09-07T12:00:00Z"), value: "2026-09-07", expected: "2026-09-07" },
        { label: "New York spring DST", profileTimeZone: "America/New_York", now: Date.parse("2026-03-08T12:00:00Z"), value: "2026-03-08T05:00:00Z", expected: "2026-03-08" },
        { label: "New York autumn DST", profileTimeZone: "America/New_York", now: Date.parse("2026-11-01T12:00:00Z"), value: "2026-11-01T04:00:00Z", expected: "2026-11-01" },
        { label: "profile zone differs from browser", browserTimeZone: "America/New_York", profileTimeZone: "Asia/Tokyo", now: Date.parse("2026-09-07T12:00:00Z"), value: "2026-09-06T15:30:00Z", expected: "2026-09-07" }
    ];
    for (const [index, entry] of cases.entries()) {
        const live = bootstrap("/", {
            profileTimeZone: entry.profileTimeZone,
            browserTimeZone: entry.browserTimeZone,
            now: entry.now,
            plannerItems: [{
                id: 9400 + index,
                plannable_id: 43000 + index,
                plannable_type: "planner_note",
                plannable: { id: 43000 + index, title: `${entry.label} Planner Note`, todo_date: entry.value, details }
            }]
        });
        await flush();
        await live.todoRuntime().refresh(`planner-date-${index}`);
        await flush(8);
        const row = live.document.querySelector(".apstudy-todo-task");
        assert.ok(row, `${entry.label} remains visible`);
        assert.match(row.querySelector(".apstudy-todo-task-due").textContent, new RegExp(`^Due ${entry.expected.slice(5, 7)}\\/${entry.expected.slice(8, 10)}$`), `${entry.label} is rendered as an account-local date, not an instant`);
        row.querySelector("[data-action='edit-planner-task']").dispatch("click");
        assert.equal(live.document.getElementById("apstudy-todo-field-dueDate").value, entry.expected, `${entry.label} reaches the edit form as the canonical date key`);
    }
});

test("missing profile timezone keeps ISO Planner Notes visible, blocks date mutations, and preserves canonical-id deletion", async () => {
    const live = bootstrap("/", {
        profileTimeZone: "Not/AConfiguredZone",
        now: Date.parse("2026-09-07T12:00:00Z"),
        plannerItems: [{
            id: 9501,
            plannable_id: 44001,
            plannable_type: "planner_note",
            // A present-day display fallback keeps the owned row visible. Its
            // ISO Planner date cannot become write authority without Canvas's
            // authenticated profile timezone.
            due_at: "2026-09-07T12:00:00Z",
            plannable: {
                id: 44001,
                title: "Invalid Planner date",
                todo_date: "2026-09-06T15:30:00Z",
                details: "APSTUDYCANVAS_PLANNER_NOTE:1:pt-invaliddate-1234567:0"
            }
        }]
    });
    await flush();
    await live.todoRuntime().refresh("invalid-planner-date");
    await flush(8);
    const row = live.document.querySelector(".apstudy-todo-task");
    assert.ok(row, "an owned Planner Note with an unavailable profile timezone remains visible for recovery");
    assert.equal(row.querySelector("[data-action='complete-task']").disabled, true, "completion is disabled before it can construct a bridge write");
    row.querySelector("[data-action='complete-task']").dispatch("click");
    await flush(8);
    assert.equal(live.messages.filter((message) => message.action === "request").length, 0, "an ISO date without profile authority never reaches the page bridge or Canvas fetch");
    assert.equal(row.getAttribute("data-status"), "active", "the original row stays incomplete until Canvas confirms a completion");
    row.querySelector("[data-action='edit-planner-task']").dispatch("click");
    assert.match(live.document.querySelector(".apstudy-todo-modal-status").textContent, /timezone is unavailable/i, "the edit modal gives the precise blocked-mutation reason");
    assert.equal(live.document.querySelector(".apstudy-todo-submit").disabled, true, "editing stays fail-closed without a profile timezone");
    live.document.querySelector("[data-action='delete-planner-task']").dispatch("click");
    await flush(8);
    const requests = live.messages.filter((message) => message.action === "request");
    assert.deepEqual(requests.map((message) => [message.request.method, message.request.id || null]), [["DELETE", "44001"]], "delete remains available because it does not serialize todo_date");
});

test("date-only Planner Notes remain editable when the optional profile timezone is absent", async () => {
    const live = bootstrap("/", {
        profileTimeZone: null,
        plannerItems: [{
            id: 9502,
            plannable_id: 44002,
            plannable_type: "planner_note",
            plannable: {
                id: 44002,
                title: "Date-only profile-independent note",
                todo_date: "2026-09-07",
                details: "APSTUDYCANVAS_PLANNER_NOTE:1:pt-dateonly-1234567:0"
            }
        }]
    });
    await flush();
    await live.todoRuntime().refresh("date-only-without-profile-zone");
    await flush(8);
    const row = live.document.querySelector(".apstudy-todo-task");
    assert.ok(row);
    row.querySelector("[data-action='complete-task']").dispatch("click");
    await flush(8);
    const requests = live.messages.filter((message) => message.action === "request");
    assert.deepEqual(requests.map((message) => [message.request.method, message.request.id || null]), [["PUT", "44002"]], "a literal Canvas date needs no timezone conversion authority");
});

test("whole coordinator fails closed when nested and outer Planner Note resource ids conflict", async () => {
    const conflict = bootstrap("/", { plannerItems: [{
        id: 9014,
        plannable_id: 41998,
        plannable_type: "planner_note",
        plannable: {
            id: 42001,
            title: "Conflicting owned note",
            todo_date: "2026-09-07",
            details: "Read safely\n\nAPSTUDYCANVAS_PLANNER_NOTE:1:pt-conflict-1234567:0"
        }
    }] });
    await flush(8);
    await conflict.todoRuntime().refresh("nested-planner-note-id-conflict");
    await flush(8);
    const row = conflict.document.querySelectorAll(".apstudy-todo-task").find((candidate) => /Conflicting owned note/.test(candidate.textContent));
    assert.ok(row, "the malformed Canvas row stays visible rather than disappearing");
    assert.equal(row.querySelector("[data-action='complete-task']").disabled, true, "a conflicting resource id revokes completion authority");
    assert.equal(row.querySelector("[data-action='edit-planner-task']"), null, "a conflicting resource id exposes no edit/delete path");
    row.querySelector("[data-action='toggle-preview']").dispatch("click");
    const preview = row.querySelector(".apstudy-todo-preview").textContent;
    assert.match(preview, /Read safely/, "read-only preview still uses the note description");
    assert.doesNotMatch(preview, /APSTUDYCANVAS_PLANNER_NOTE/, "the ownership marker never reaches a conflicting row's preview");
    assert.equal(conflict.messages.filter((message) => message.action === "request").length, 0, "a conflicting row sends zero planner writes");
    assert.equal(conflict.plannerUrls.length, 0, "a conflicting row never constructs a Planner Note endpoint");
    assert.equal(conflict.counts.nest, 0, "a conflicting row never falls through to Nest");
});

test("whole coordinator uses matching one-sided Planner Note resource ids for actions", async () => {
    const live = bootstrap("/", { plannerItems: [
        {
            id: 9015,
            plannable_id: 43001,
            plannable_type: "planner_note",
            plannable: {
                title: "Outer-only owned note",
                todo_date: "2026-09-07",
                details: "Outer description\n\nAPSTUDYCANVAS_PLANNER_NOTE:1:pt-outeronly-1234567:0"
            }
        },
        {
            id: 9016,
            plannable_type: "planner_note",
            plannable: {
                id: 43002,
                title: "Nested-only owned note",
                todo_date: "2026-09-07",
                details: "Nested description\n\nAPSTUDYCANVAS_PLANNER_NOTE:1:pt-nestedonly-1234567:0"
            }
        }
    ] });
    await flush(8);
    await live.todoRuntime().refresh("nested-planner-note-one-sided-ids");
    await flush(8);
    const outer = live.document.querySelectorAll(".apstudy-todo-task").find((candidate) => /Outer-only owned note/.test(candidate.textContent));
    const nested = live.document.querySelectorAll(".apstudy-todo-task").find((candidate) => /Nested-only owned note/.test(candidate.textContent));
    assert.equal(outer.querySelector("[data-action='complete-task']").disabled, false);
    assert.equal(nested.querySelector("[data-action='complete-task']").disabled, false);
    outer.querySelector("[data-action='complete-task']").dispatch("click");
    await flush(8);
    nested.querySelector("[data-action='complete-task']").dispatch("click");
    await flush(8);
    assert.deepEqual(live.plannerUrls, [
        { method: "PUT", url: "https://canvas.emory.edu/api/v1/planner_notes/43001" },
        { method: "PUT", url: "https://canvas.emory.edu/api/v1/planner_notes/43002" }
    ], "a one-sided Canvas resource id is used consistently for mapping and completion");
    assert.equal(live.counts.nest, 0);
});

test("medium Dashboard readiness waits for cards, recovers once, and remains honest at its bounded timeout", async () => {
    for (const width of [768, 900, 1100]) {
        const live = bootstrap("/", { width });
        await flush();
        assert.equal(live.todoState().reason, "missing-cards-anchor", `${width}px reports the cards-only missing anchor`);
        assert.equal(live.document.querySelector(".apstudy-todo-add"), null, `${width}px never falls back beside native To Do while cards are required`);
        assert.equal(live.pendingTimerCount(100), 1, `${width}px schedules one bounded readiness retry`);
        live.setDashboardCards(true);
        assert.equal(live.runTimersThrough(100), 1, `${width}px delivers the real bounded readiness retry`);
        await flush();
        assert.equal(live.todoState().placement, "below-course-cards", `${width}px recovers into the cards placement`);
        assert.equal(live.todoState().reason, "mounted", `${width}px replaces its waiting diagnostic after mount`);
        assert.equal(live.counts.rail, 1, `${width}px recovery creates one rail`);
        assert.equal(live.document.querySelectorAll('[data-apstudycanvas-owned="todo-right-rail-host"]').length, 1, `${width}px recovery leaves one owned host`);
    }
    const timedOut = bootstrap("/", { width: 900 });
    await flush();
    for (let attempt = 0; attempt < 20; attempt += 1) {
        if (!timedOut.runTimersThrough(100)) break;
        await flush();
    }
    assert.equal(timedOut.document.querySelector(".apstudy-todo-add"), null, "a permanently missing cards anchor never mounts a fallback rail");
    assert.equal(timedOut.todoState().reason, "missing-cards-anchor", "the bounded timeout retains the honest missing-cards diagnostic");
    assert.equal(timedOut.counts.rail, 0, "timeout never creates a duplicate or misplaced rail");
});

test("harness geometry and sequential focus preserve native-first normal flow without claiming browser layout", async () => {
    for (const [viewport, column] of [[1440, 360], [720, 320]]) {
        const live = bootstrap("/", { width: viewport });
        await flush();
        const { region, host, rail, getComputedStyle } = live.setHarnessGeometry(column);
        assert.ok(region && host && rail, `${viewport}px fixture has native region, sibling host, and rail`);
        assert.ok(host.scrollWidth <= host.clientWidth + 1, `${viewport}px harness host has no horizontal overflow beyond rounding`);
        assert.ok(rail.scrollWidth <= rail.clientWidth + 1, `${viewport}px harness rail has no horizontal overflow beyond rounding`);
        assert.equal(getComputedStyle(host).inlineSize, `${column}px`, `${viewport}px representative host inline size is constrained to its column in the adapter`);
        assert.equal(getComputedStyle(host).minInlineSize, "0px", `${viewport}px representative host permits shrink-to-fit`);
        assert.equal(getComputedStyle(rail).inlineSize, `${Math.min(column, 380)}px`, `${viewport}px representative rail remains within its available column`);
        const add = live.document.querySelector(".apstudy-todo-add");
        const focusables = live.document.focusableElements();
        assert.ok(focusables.indexOf(live.nativeTodo().firstElementChild) < focusables.indexOf(add), `${viewport}px native Canvas task precedes Add Task in sequential focus order`);
        live.document.activeElement = null;
        assert.equal(live.document.tab(), live.nativeTodo().firstElementChild, `${viewport}px first Tab reaches native Canvas content`);
        let current = null;
        for (let step = 0; step < focusables.length; step += 1) { current = live.document.tab(); if (current === add) break; }
        assert.equal(current, add, `${viewport}px sequential Tab reaches Add Task after native Canvas content`);
        add.focus(); add.dispatch("click");
        const close = live.document.querySelector(".apstudy-todo-modal-close");
        assert.ok(close, `${viewport}px Add Task opens the real modal`);
        close.dispatch("click");
        // The real rail may conservatively treat its generated draft as dirty;
        // complete that explicit close flow before checking focus restoration.
        live.document.querySelector(".apstudy-todo-discard")?.dispatch("click");
        assert.equal(live.document.activeElement === live.document.querySelector(".apstudy-todo-add"), true, `${viewport}px closing the modal restores focus to the current Add Task control after rerender`);
    }
});

test("Dashboard placement preserves cards band, course rail ownership, and independent To Do opt-out", async () => {
    for (const width of [768, 900, 1100]) {
        const live = bootstrap("/", { width, dashboardCards: true });
        await flush();
        const host = live.document.querySelector('[data-apstudycanvas-owned="todo-right-rail-host"]');
        assert.equal(host?.parentNode?.id, "DashboardCard_Container", `${width}px keeps the cards-first Dashboard composition`);
        assert.equal(live.todoState().placement, "below-course-cards");
        assert.equal(live.nativeTodo().hidden, false, "cards placement also leaves native To Do visible");
    }
    const mediumMissingCards = bootstrap("/", { width: 900 });
    await flush();
    assert.equal(mediumMissingCards.document.querySelector(".apstudy-todo-add"), null, "medium Dashboard waits for its cards anchor instead of using a native-list fallback");
    assert.equal(mediumMissingCards.todoState().reason, "missing-cards-anchor");
    for (const width of [720, 767, 1101, 1440]) {
        const live = bootstrap("/", { width });
        await flush();
        assert.ok(live.document.querySelector(".apstudy-todo-add"), `${width}px uses the normal-flow native-To-Do sibling fallback`);
        assert.equal(live.todoState().placement, "dashboard-native-todo-adjacent");
    }
    const course = bootstrap("/courses/42", { width: 1440 });
    await flush();
    assert.equal(course.todoState().placement, "right-rail", "course routes retain only the legacy right rail path");
    assert.equal(course.document.querySelectorAll('[data-apstudycanvas-todo-placement="dashboard-native-todo-adjacent"]').length, 0, "course routes never infer the Dashboard fallback");
    const legacyDashboard = bootstrap("/", { width: 1440, dashboardLegacyRail: true });
    await flush();
    assert.equal(legacyDashboard.todoState().placement, "right-rail", "when both Dashboard anchors exist, legacy #right-side remains first choice");
    assert.equal(legacyDashboard.document.querySelector('[data-apstudycanvas-owned="todo-right-rail-host"]').parentNode.id, "right-side");
    const disabled = bootstrap("/", { todoEnabled: false });
    await flush();
    assert.equal(disabled.document.querySelector(".apstudy-todo-add"), null, "todo_enabled independently suppresses the loading shell");
    assert.equal(disabled.todoState().reason, "todo-disabled");
});

test("Dashboard native-region replacement retires only owned fallback hosts and remounts once", async () => {
    const live = bootstrap("/", { width: 1440 });
    await flush();
    const oldNative = live.nativeTodo();
    const oldHost = live.document.querySelector('[data-apstudycanvas-owned="todo-right-rail-host"]');
    live.replaceNativeDashboardTodo();
    live.todoRuntime().schedule("native-dashboard-replacement");
    await flush();
    const region = live.nativeRegion();
    const host = region.parentNode.children[region.parentNode.children.indexOf(region) + 1];
    assert.equal(live.counts.rail, 2, "a replaced Canvas region retires the old rail and mounts one current rail");
    assert.equal(oldHost.isConnected, false, "only the stale extension host is removed");
    assert.equal(oldNative.isConnected, false, "the harness replaced the native region itself rather than mutating it");
    assert.equal(live.nativeTodo().hidden, false, "the replacement native list stays visible");
    assert.equal(host?.getAttribute("data-apstudycanvas-owned"), "todo-right-rail-host");
    assert.equal(live.document.querySelectorAll('[data-apstudycanvas-owned="todo-right-rail-host"]').length, 1, "replacement leaves exactly one owned host");
    live.todoRuntime().destroy("placement-test");
    assert.equal(live.document.querySelectorAll('[data-apstudycanvas-owned="todo-right-rail-host"]').length, 0, "destroy removes only extension-owned wrappers");
    assert.equal(live.nativeTodo().isConnected, true, "destroy never removes the native Canvas To Do region");
});

test("Dashboard route and responsive placement transitions retain one current owned host", async () => {
    const live = bootstrap("/", { width: 1440 });
    await flush();
    assert.equal(live.todoState().placement, "dashboard-native-todo-adjacent");
    live.window.history.pushState({}, "", "/courses/42");
    await flush();
    assert.equal(live.todoState().placement, "right-rail", "Dashboard → course retires the Dashboard fallback");
    live.navigateDashboard();
    await flush();
    assert.equal(live.todoState().placement, "dashboard-native-todo-adjacent", "course → Dashboard recreates the sibling fallback after Canvas replaces its column");
    live.setDashboardCards(true);
    live.setViewport(900);
    await flush();
    assert.equal(live.todoState().placement, "below-course-cards", "the medium cards band wins over a native To Do fallback");
    live.setViewport(1440);
    await flush();
    assert.equal(live.todoState().placement, "dashboard-native-todo-adjacent", "wide Dashboard returns from cards to the native To Do sibling fallback");
    assert.equal(live.document.querySelectorAll('[data-apstudycanvas-owned="todo-right-rail-host"]').length, 1, "every route/placement transition leaves exactly one owned host");
});
