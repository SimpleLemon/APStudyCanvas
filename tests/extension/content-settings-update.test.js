"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const CONTENT_SOURCE = fs.readFileSync(path.join(__dirname, "../../js/content.js"), "utf8");
const settingsApply = require("../../js/content/settings-apply.js");
const settingsSchema = require("../../js/settings-schema.js");
// The harness mounts the real Sidebar module, not a validator stub: content.js
// delegates sidebar SETTINGS_UPDATE validation to Sidebar.validateSettingsUpdateRequest,
// and a stub here would hide exactly that production seam.
const sidebarModule = require("../../js/content/sidebar.js");

function extractContentFunction(name) {
    const start = CONTENT_SOURCE.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `missing ${name}`);
    const bodyStart = CONTENT_SOURCE.indexOf("{", start);
    let depth = 0;
    for (let index = bodyStart; index < CONTENT_SOURCE.length; index += 1) {
        if (CONTENT_SOURCE[index] === "{") depth += 1;
        if (CONTENT_SOURCE[index] === "}") {
            depth -= 1;
            if (depth === 0) return CONTENT_SOURCE.slice(start, index + 1);
        }
    }
    throw new Error(`unterminated ${name}`);
}

function loadContentFunction(name, context) {
    vm.runInNewContext(`${extractContentFunction(name)}\n__contentFunction = ${name};`, context, { filename: "js/content.js" });
    return context.__contentFunction;
}

function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
}

function dashboardNode(name) {
    return {
        name,
        children: [],
        parentElement: null,
        dataset: {},
        style: {},
        appendChild(node) {
            node.remove?.();
            this.children.push(node);
            node.parentElement = this;
            return node;
        },
        prepend(...nodes) {
            nodes.filter(Boolean).reverse().forEach((node) => {
                node.remove?.();
                this.children.unshift(node);
                node.parentElement = this;
            });
        },
        remove() {
            if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((node) => node !== this);
            this.parentElement = null;
        },
        querySelector() { return null; }
    };
}

async function flushPromiseCallbacks() {
    await Promise.resolve();
    await Promise.resolve();
}

function createContentRuntime({ syncSettings = {}, localSettings = {} } = {}) {
    let messageListener;
    let applyResult = false;
    let applyCalls = 0;
    let refreshCalls = 0;
    let controlCenterOpens = 0;
    const todoSettingsCalls = [];
    const documentListeners = new Map();
    const controller = {
        init() {},
        apply() { applyCalls += 1; return applyResult; },
        refresh() { refreshCalls += 1; return Promise.resolve({}); },
        needsRefresh() { return false; },
        pause() {},
        resume() {},
        dispose() {}
    };
    const sidebar = {
        ...sidebarModule,
        createSidebarController() { return controller; }
    };
    const nodes = new Map();
    const html = { append() {}, appendChild() {} };
    const rootAttributes = new Map();
    html.setAttribute = (name, value) => { rootAttributes.set(String(name), String(value)); };
    html.removeAttribute = (name) => { rootAttributes.delete(String(name)); };
    html.hasAttribute = (name) => rootAttributes.has(String(name));
    html.getAttribute = (name) => (rootAttributes.has(String(name)) ? rootAttributes.get(String(name)) : null);
    const document = {
        readyState: "complete",
        cookie: "",
        documentElement: html,
        head: {
            appendChild(node) {
                node.parentNode = this;
                if (node.id) nodes.set(node.id, node);
            }
        },
        querySelector(selector) { return selector === "html" ? html : selector.startsWith("#") ? nodes.get(selector.slice(1)) || null : null; },
        querySelectorAll() { return []; },
        getElementById() { return null; },
        addEventListener(type, listener) {
            const values = documentListeners.get(type) || [];
            values.push(listener);
            documentListeners.set(type, values);
        },
        removeEventListener(type, listener) {
            documentListeners.set(type, (documentListeners.get(type) || []).filter((candidate) => candidate !== listener));
        },
        dispatchEvent(event) {
            (documentListeners.get(event?.type) || []).slice().forEach((listener) => listener(event));
            return true;
        },
        createElement() {
            return {
                style: {},
                classList: { add() {}, remove() {} },
                append() {},
                setAttribute() {},
                remove() { if (this.id) nodes.delete(this.id); this.parentNode = null; },
                parentNode: null
            };
        }
    };
    const values = {
        custom_font: { link: "", family: "" },
        dark_mode: false,
        dark_preset: {},
        device_dark: false,
        remind: false,
        auto_dark: false,
        better_sidebar: false,
        dashboard_compact_padding: "medium",
        // The mounted schema floods todo defaults into boot's options merge,
        // which wakes getColors(); production storage always carries the card
        // color map (background reconcile writes it), so the seed does too.
        custom_cards_3: {},
        ...syncSettings
    };
    const syncWrites = [];
    const storageArea = {
        get(keys, callback) {
            if (typeof callback === "function") callback(keys === null ? { ...values } : { ...values });
            return Promise.resolve(keys === null ? { ...values } : { ...values });
        },
        set(changes) { syncWrites.push(JSON.parse(JSON.stringify(changes))); Object.assign(values, changes); return Promise.resolve(); }
    };
    const localValues = { ...localSettings };
    const localReads = [];
    const localWrites = [];
    const localRemovals = [];
    const localStorage = {
        get(keys) {
            localReads.push(keys);
            if (keys === null) return Promise.resolve({ ...localValues });
            const requested = Array.isArray(keys) ? keys : [keys];
            return Promise.resolve(Object.fromEntries(requested.filter((key) => Object.prototype.hasOwnProperty.call(localValues, key)).map((key) => [key, localValues[key]])));
        },
        set(changes) { localWrites.push(JSON.parse(JSON.stringify(changes))); Object.assign(localValues, changes); return Promise.resolve(); },
        remove(keys) { const removed = Array.isArray(keys) ? keys : [keys]; localRemovals.push(...removed); removed.forEach((key) => delete localValues[key]); return Promise.resolve(); }
    };
    const consoleCalls = [];
    const chrome = {
        runtime: {
            id: "test-extension",
            onMessage: { addListener(listener) { messageListener = listener; } }
        },
        storage: { sync: storageArea, local: localStorage }
    };
    const window = {
        location: {
            origin: "https://canvas.emory.edu",
            protocol: "https:",
            hostname: "canvas.emory.edu",
            pathname: "/"
        },
        addEventListener() {},
        removeEventListener() {}
    };
    // The production schema and content script share an isolated world. The
    // Node harness does not, so bridge the dictionary-taking methods through
    // JSON to preserve their same-realm plain-object contract.
    const cloneSchemaInput = (value) => JSON.parse(JSON.stringify(value));
    const schemaBridge = {
        ...settingsSchema,
        migrateTodoSettings: (value) => settingsSchema.migrateTodoSettings(cloneSchemaInput(value)),
        todoSettingsSnapshot: (value) => settingsSchema.todoSettingsSnapshot(cloneSchemaInput(value)),
        migratePhaseOneSettings: (value) => settingsSchema.migratePhaseOneSettings(cloneSchemaInput(value)),
        normalizeCustomFont: (value) => settingsSchema.normalizeCustomFont(cloneSchemaInput(value))
    };
    const context = {
        window,
        document,
        chrome,
        console: { log(...args) { consoleCalls.push(args); }, warn(...args) { consoleCalls.push(args); }, error(...args) { consoleCalls.push(args); } },
        DARKMODE_CSS: "",
        // The manifest lists js/settings-schema.js ahead of js/content.js in
        // production, so the harness mounts the real schema too.
        APStudyCanvasSchema: schemaBridge,
        APStudyCanvasContent: { Sidebar: sidebar, SettingsApply: require("../../js/content/settings-apply.js") },
        setTimeout() { return 0; },
        clearTimeout() {},
        setInterval() { return 0; },
        clearInterval() {},
        MutationObserver: class { observe() {} disconnect() {} },
        fetch: async () => ({ ok: true, json: async () => ({}) })
    };
    context.APStudyCanvasContent.OverlayHost = {
        createOverlayHost() {
            return { open() { controlCenterOpens += 1; return { ok: true, state: "open" }; } };
        }
    };
    context.globalThis = context;
    vm.runInNewContext(CONTENT_SOURCE, context, { filename: "js/content.js" });
    vm.runInNewContext("assignments = Promise.resolve([]);", context, { filename: "js/content.js" });
    vm.runInNewContext("startExtension()", context, { filename: "js/content.js" });
    applyCalls = 0;
    return {
        context,
        document,
        setApplyResult(value) { applyResult = value; },
        applyCalls() { return applyCalls; },
        refreshCalls() { return refreshCalls; },
        controlCenterOpens() { return controlCenterOpens; },
        installTodoIntegration() {
            context.__todoSettingsCalls = todoSettingsCalls;
            vm.runInNewContext("contentTodoIntegration = { settingsChanged(next) { __todoSettingsCalls.push(Boolean(next?.planner_tasks_enabled)); return true; } };", context, { filename: "js/content.js" });
        },
        applyStorage(changes) {
            context.__storageChanges = changes;
            vm.runInNewContext("applyOptionsChanges(__storageChanges, 'sync');", context, { filename: "js/content.js" });
            delete context.__storageChanges;
        },
        todoSettingsCalls() { return todoSettingsCalls.slice(); },
        dispatchControlCenter() { document.dispatchEvent({ type: "apstudycanvas:open-control-center" }); },
        controlCenterListenerCount() { return (documentListeners.get("apstudycanvas:open-control-center") || []).length; },
        fontNode() { return nodes.get("custom_font") || null; },
        localReads,
        localWrites,
        localRemovals,
        syncWrites,
        consoleCalls,
        async ready() {
            await Promise.resolve();
            await Promise.resolve();
            await new Promise((resolve) => setImmediate(resolve));
        },
        send(request) {
            context.__settingsUpdateRequest = request;
            const scopedRequest = vm.runInNewContext("JSON.parse(JSON.stringify(__settingsUpdateRequest))", context);
            delete context.__settingsUpdateRequest;
            let response;
            const returned = messageListener(scopedRequest, { id: "test-extension" }, (value) => { response = value; });
            return { returned, response };
        },
        async sendAsync(request) {
            context.__settingsUpdateRequest = request;
            const scopedRequest = vm.runInNewContext("JSON.parse(JSON.stringify(__settingsUpdateRequest))", context);
            delete context.__settingsUpdateRequest;
            let response;
            const returned = messageListener(scopedRequest, { id: "test-extension" }, (value) => { response = value; });
            await new Promise((resolve) => setImmediate(resolve));
            return { returned, response };
        }
    };
}

test("content applies only packaged or system font stacks and never creates a remote stylesheet", async () => {
    assert.doesNotMatch(CONTENT_SOURCE, /fonts\.(?:googleapis|gstatic)\.com/i);
    assert.doesNotMatch(CONTENT_SOURCE, /createElement\(["']link["']\)/i);
    const runtime = createContentRuntime();
    await runtime.ready();
    runtime.context.__font = { link: "https://fonts.example.test/private.css", family: "Public Sans" };
    vm.runInNewContext("options = { custom_font: __font }; loadCustomFont();", runtime.context, { filename: "js/content.js" });
    assert.match(runtime.fontNode().textContent, /"Public Sans", system-ui, sans-serif/);
    assert.doesNotMatch(runtime.fontNode().textContent, /fonts\.example|private/i);
});

test("content migrates legacy font settings and clears raw diagnostic storage without reading it", async () => {
    const hostile = "https://canvas.example.test/courses/42?token=very-private";
    const runtime = createContentRuntime({
        syncSettings: { custom_font: { link: "DM+Sans:wght@400;700", family: "'DM Sans'" } },
        localSettings: { errors: [`Error: ${hostile}\nsecret-stack-frame`] }
    });
    await runtime.ready();
    assert.deepEqual(runtime.syncWrites.find((changes) => changes.custom_font)?.custom_font, { link: "", family: "" });
    assert.ok(runtime.localRemovals.includes("errors"));
    assert.equal(runtime.localReads.some((keys) => (Array.isArray(keys) ? keys : [keys]).includes("errors")), false, "legacy error contents are never read during cleanup");

    runtime.context.__hostileException = { message: hostile, stack: `stack ${hostile}`, identifier: "student-123" };
    vm.runInNewContext("logError(__hostileException);", runtime.context, { filename: "js/content.js" });
    await runtime.ready();
    const stored = JSON.stringify(runtime.localWrites.at(-1));
    const logged = JSON.stringify(runtime.consoleCalls);
    assert.equal(stored, JSON.stringify({ errors: [{ code: "CONTENT_RUNTIME_FAILED", category: "runtime" }] }));
    assert.ok(Buffer.byteLength(stored, "utf8") <= 128);
    assert.doesNotMatch(stored, /canvas\.example|private|secret|student-123/i);
    assert.doesNotMatch(logged, /canvas\.example|private|secret|student-123/i);
});

test("diagnostic cleanup runs once and preserves later safe records", async () => {
    const runtime = createContentRuntime({ localSettings: { content_diagnostics_v2: true, errors: [{ code: "CONTENT_RUNTIME_FAILED", category: "runtime" }] } });
    await runtime.ready();
    assert.equal(runtime.localRemovals.includes("errors"), false);
    assert.equal(runtime.localReads.some((keys) => (Array.isArray(keys) ? keys : [keys]).includes("errors")), false);
});

test("all canonical sidebar settings are live-appliable through the shared classifier", () => {
    const keys = [
        "better_sidebar", "sidebar_enabled", "enable_sidebar", "enabled", "sidebar_preferred_state",
        "sidebar_scale_preset", "sidebar_scale", "sidebar_expanded_width", "sidebar_collapsed_width",
        "sidebar_density", "sidebar_icon_size", "sidebar_label_size", "sidebar_logo_visible",
        "sidebar_product_entry_visible", "sidebar_collapsed_labels", "sidebar_pages_visible_expanded",
        "sidebar_courses_visible_expanded", "sidebar_pages_visible_collapsed", "sidebar_courses_visible_collapsed",
        "sidebar_pages_folded", "sidebar_courses_folded", "sidebar_page_order",
        "sidebar_page_visibility", "sidebar_page_labels", "sidebar_labels", "sidebar_tooltips",
        "sidebar_accessibility_labels", "dashboard_sidebar_expanded", "course_sidebar_expanded"
    ];
    keys.forEach((key) => {
        assert.equal(settingsApply.classifyKey(key), "live", key);
        assert.equal(settingsApply.liveApplyGroup(key), "sidebar", key);
    });
});

test("SETTINGS_UPDATE reports false until the sidebar controller actually renders or updates", async () => {
    const runtime = createContentRuntime();
    await runtime.ready();
    const request = {
        version: 1,
        request_id: "settings-update-regression",
        type: "SETTINGS_UPDATE",
        payload: { area: "sync", changes: { sidebar_logo_visible: false } }
    };

    const pending = runtime.send(request);
    assert.equal(pending.returned, false);
    assert.equal(pending.response.payload.applied, false);
    assert.equal(pending.response.payload.rendered, false);

    runtime.setApplyResult(true);
    const applied = runtime.send({ ...request, request_id: "settings-update-applied" });
    assert.equal(runtime.applyCalls(), 2);
    assert.equal(applied.response.payload.applied, true);
    assert.equal(applied.response.payload.rendered, true);
});

test("SETTINGS_UPDATE validates sidebar values through the real Sidebar validator", async () => {
    const runtime = createContentRuntime();
    await runtime.ready();

    const invalid = runtime.send({
        version: 1,
        request_id: "sidebar-update-invalid",
        type: "SETTINGS_UPDATE",
        payload: { area: "sync", changes: { sidebar_preferred_state: "sideways" } }
    });
    assert.equal(invalid.response.payload.ok, false);
    assert.equal(invalid.response.payload.code, "SETTINGS_VALUE_INVALID", "an impossible preferred state must never reach the live rail");

    const unknownKey = runtime.send({
        version: 1,
        request_id: "sidebar-update-unknown",
        type: "SETTINGS_UPDATE",
        payload: { area: "sync", changes: { sidebar_section_visibility: true } }
    });
    assert.equal(unknownKey.response.payload.ok, false);
    assert.equal(unknownKey.response.payload.code, "SETTINGS_KEY_UNSUPPORTED");

    runtime.setApplyResult(true);
    const valid = runtime.send({
        version: 1,
        request_id: "sidebar-update-valid",
        type: "SETTINGS_UPDATE",
        payload: { area: "sync", changes: { sidebar_preferred_state: "collapsed", sidebar_expanded_width: 9999 } }
    });
    assert.equal(valid.response.payload.ok, true);
    assert.equal(valid.response.payload.applied, true);
    assert.ok(valid.response.payload.appliedKeys.includes("sidebar_preferred_state"));
});

test("SETTINGS_UPDATE applies appearance and dashboard keys through the shared applicator", async () => {
    const runtime = createContentRuntime();
    await runtime.ready();
    runtime.setApplyResult(true);
    const appearance = runtime.send({
        version: 1,
        request_id: "settings-update-appearance",
        type: "SETTINGS_UPDATE",
        payload: { area: "sync", changes: { dark_mode: true } }
    });
    assert.equal(appearance.response.payload.ok, true);
    assert.equal(appearance.response.payload.applied, true);
    assert.ok(appearance.response.payload.appliedKeys.includes("dark_mode"));

    const assignments = runtime.send({
        version: 1,
        request_id: "settings-update-reload",
        type: "SETTINGS_UPDATE",
        payload: { area: "sync", changes: { assignments_due: true } }
    });
    assert.equal(assignments.response.payload.ok, true);
    assert.equal(assignments.response.payload.applied, true);
    assert.ok(assignments.response.payload.appliedKeys.includes("assignments_due"));
    assert.deepEqual(assignments.response.payload.reloadKeys, []);
    assert.equal(assignments.response.payload.state, "applied");
});

test("SIDEBAR_REFRESH accepts only the account-local course-order refresh and waits for the live rail", async () => {
    const runtime = createContentRuntime();
    await runtime.ready();
    const refreshesBefore = runtime.refreshCalls();
    const valid = await runtime.sendAsync({
        version: 1,
        request_id: "sidebar-course-order-refresh",
        type: "SIDEBAR_REFRESH",
        payload: { reason: "course-order" }
    });
    assert.equal(valid.returned, true);
    assert.equal(valid.response.payload.ok, true);
    assert.equal(valid.response.payload.refreshed, true);
    assert.equal(runtime.refreshCalls(), refreshesBefore + 1);

    const invalid = runtime.send({
        version: 1,
        request_id: "sidebar-unknown-refresh",
        type: "SIDEBAR_REFRESH",
        payload: { reason: "unknown" }
    });
    assert.equal(invalid.returned, false);
    assert.equal(invalid.response.payload.ok, false);
    assert.equal(invalid.response.payload.code, "CONTENT_FIELDS_UNSUPPORTED");
    assert.equal(runtime.refreshCalls(), refreshesBefore + 1, "invalid refreshes never reach the sidebar owner");
});

test("new content settings share one live owner for messages and storage echoes", async () => {
    const runtime = createContentRuntime();
    await runtime.ready();
    const cases = [
        ["card_letter_grade_visible", true, "appearance"],
        ["assignment_sequence_footer_visible", false, "appearance"],
        ["hide_infrastructure_footer", true, "appearance"],
        ["quiz_safe_mode", false, "appearance"],
        ["canvas_search_enabled", false, "study-tools"],
        ["grade_analytics_enabled", true, "study-tools"]
    ];

    for (const [key, value, group] of cases) {
        assert.equal(settingsApply.classifyKey(key), "live", key);
        assert.equal(settingsApply.liveApplyGroup(key), group, key);
        const update = runtime.send({
            version: 1,
            request_id: `live-${key}`,
            type: "SETTINGS_UPDATE",
            payload: { area: "sync", changes: { [key]: value } }
        });
        assert.equal(update.response.payload.ok, true, key);
        assert.equal(update.response.payload.applied, true, key);
        assert.ok(update.response.payload.appliedKeys.includes(key), key);
        runtime.applyStorage({ [key]: { oldValue: !value, newValue: value } });
    }
});

test("dashboard assignment and grade/GPA changes reconcile once across a message and storage echo", async () => {
    const runtime = createContentRuntime();
    await runtime.ready();
    vm.runInNewContext(`
        __assignmentReconciles = 0;
        __gradeReconciles = 0;
        reconcileCardAssignments = () => { __assignmentReconciles += 1; return true; };
        reconcileDashboardGrades = () => { __gradeReconciles += 1; return true; };
    `, runtime.context, { filename: "js/content.js" });
    const changes = { num_assignments: 6, gpa_calc: true, grade_hover: true };
    const message = runtime.send({
        version: 1,
        request_id: "dashboard-live-message",
        type: "SETTINGS_UPDATE",
        payload: { area: "sync", changes }
    });
    assert.equal(message.response.payload.ok, true);
    assert.equal(message.response.payload.applied, true);
    assert.deepEqual(message.response.payload.reloadKeys, []);
    assert.deepEqual(message.response.payload.appliedKeys.sort(), Object.keys(changes).sort());
    runtime.applyStorage(Object.fromEntries(Object.entries(changes).map(([key, value]) => [key, { oldValue: undefined, newValue: value }])));
    assert.equal(runtime.context.__assignmentReconciles, 1);
    assert.equal(runtime.context.__gradeReconciles, 1);
});

test("GPA restores its intended sibling order and pending grade callbacks respect a later disable", async () => {
    async function renderOrder(prepend) {
        const dashboard = dashboardNode("dashboard");
        const before = dashboardNode("before");
        const card = dashboardNode("card");
        const calculator = dashboardNode("calculator");
        const after = dashboardNode("after");
        card.dataset.canvasrefinedGpaRendered = "true";
        calculator.dataset.canvasrefinedGpaRendered = "true";
        [before, card, calculator, after].forEach((node) => dashboard.appendChild(node));
        const context = {
            current_page: "/",
            options: { gpa_calc: true, gpa_calc_prepend: prepend },
            grades: Promise.resolve([]),
            document: {
                querySelector(selector) {
                    if (selector === ".ic-DashboardCard__box__container") return dashboard;
                    if (selector === ".canvasrefined-gpa-card") return card;
                    if (selector === ".canvasrefined-gpa") return calculator;
                    return null;
                },
                querySelectorAll() { return []; }
            },
            calculateGPA2() {},
            logError() {}
        };
        loadContentFunction("setupGPACalc", context)();
        await flushPromiseCallbacks();
        return dashboard.children.map((node) => node.name);
    }

    assert.deepEqual(await renderOrder(true), ["calculator", "card", "before", "after"]);
    assert.deepEqual(await renderOrder(false), ["before", "after", "card", "calculator"]);

    const pending = deferred();
    const dashboard = dashboardNode("dashboard");
    const card = dashboardNode("card");
    const calculator = dashboardNode("calculator");
    card.dataset.canvasrefinedGpaRendered = "true";
    calculator.dataset.canvasrefinedGpaRendered = "true";
    dashboard.appendChild(card);
    dashboard.appendChild(calculator);
    const gpaContext = {
        current_page: "/",
        options: { gpa_calc: true, gpa_calc_prepend: false },
        grades: pending.promise,
        document: {
            querySelector(selector) {
                if (selector === ".ic-DashboardCard__box__container") return dashboard;
                if (selector === ".canvasrefined-gpa-card") return card;
                if (selector === ".canvasrefined-gpa") return calculator;
                return null;
            },
            querySelectorAll(selector) { return selector === ".canvasrefined-gpa-card, .canvasrefined-gpa" ? [card, calculator] : []; }
        },
        calculateGPA2() {},
        logError() {}
    };
    const setupGpa = loadContentFunction("setupGPACalc", gpaContext);
    setupGpa();
    gpaContext.options.gpa_calc = false;
    setupGpa();
    pending.resolve([]);
    await flushPromiseCallbacks();
    assert.equal(card.style.display, "none");
    assert.equal(calculator.style.display, "none");

    const gradeRequest = deferred();
    const grade = {
        style: { display: "" },
        textContent: "",
        classList: { toggle() {} },
        setAttribute() {},
        removeAttribute() {}
    };
    const link = { href: "https://canvas.emory.edu/courses/1" };
    const dashboardCard = {
        querySelectorAll(selector) { return selector === ".ic-DashboardCard__link" ? [link] : []; },
        querySelector(selector) { return selector === ".canvasrefined-card-grade" ? grade : null; }
    };
    const gradeContext = {
        options: { dashboard_grades: true, card_letter_grade_visible: false },
        grades: gradeRequest.promise,
        domain: "https://canvas.emory.edu",
        document: {
            querySelectorAll(selector) {
                if (selector === ".ic-DashboardCard") return [dashboardCard];
                if (selector === ".canvasrefined-card-grade") return [grade];
                return [];
            }
        },
        contentCardAppearanceApi: {
            canvasCourseLocation() { return { courseId: "1" }; },
            courseDestination() { return { href: "https://canvas.emory.edu/courses/1/grades" }; }
        },
        contentGpaApi: null,
        makeElement() { throw new Error("the existing badge should be reused"); },
        logError() {}
    };
    const insert = loadContentFunction("insertGrades", gradeContext);
    insert();
    gradeContext.options.dashboard_grades = false;
    insert();
    gradeRequest.resolve([{ id: 1, enrollments: [{ computed_current_score: 95 }] }]);
    await flushPromiseCallbacks();
    assert.equal(grade.style.display, "none", "a stale grades callback cannot revive a disabled badge");
});

test("SETTINGS_UPDATE flips the dashboard compact-padding level on the root element", async () => {
    const runtime = createContentRuntime();
    await runtime.ready();
    const root = runtime.document.documentElement;
    const request = (requestId, value) => ({
        version: 1,
        request_id: requestId,
        type: "SETTINGS_UPDATE",
        payload: { area: "sync", changes: { dashboard_compact_padding: value } }
    });
    const attribute = "data-apstudycanvas-dashboard-compact-padding";

    const medium = runtime.send(request("compact-padding-medium", "medium"));
    assert.equal(medium.response.payload.ok, true);
    assert.ok(medium.response.payload.appliedKeys.includes("dashboard_compact_padding"));
    assert.equal(root.getAttribute(attribute), "medium");

    const echo = runtime.send(request("compact-padding-echo", "medium"));
    assert.equal(echo.response.payload.ok, true);
    assert.equal(root.getAttribute(attribute), "medium", "re-applying the same level must keep the trim on");

    const high = runtime.send(request("compact-padding-high", "high"));
    assert.equal(high.response.payload.ok, true);
    assert.equal(root.getAttribute(attribute), "high", "a more aggressive level must retarget the attribute");

    const off = runtime.send(request("compact-padding-off", "off"));
    assert.equal(off.response.payload.ok, true);
    assert.equal(root.getAttribute(attribute), null, "turning the option off must restore Canvas's own padding");
});

test("SETTINGS_UPDATE tolerates legacy boolean compact-padding values", async () => {
    const runtime = createContentRuntime();
    await runtime.ready();
    const root = runtime.document.documentElement;
    const request = (requestId, value) => ({
        version: 1,
        request_id: requestId,
        type: "SETTINGS_UPDATE",
        payload: { area: "sync", changes: { dashboard_compact_padding: value } }
    });
    const attribute = "data-apstudycanvas-dashboard-compact-padding";

    const legacyOn = runtime.send(request("compact-padding-legacy-on", true));
    assert.equal(legacyOn.response.payload.ok, true);
    assert.equal(root.getAttribute(attribute), "medium", "a legacy on-state must land on the medium level");
    assert.ok(legacyOn.response.payload.appliedKeys.includes("dashboard_compact_padding"));

    const legacyOff = runtime.send(request("compact-padding-legacy-off", false));
    assert.equal(legacyOff.response.payload.ok, true);
    assert.equal(root.getAttribute(attribute), "medium", "a legacy off-state normalizes to the shipped medium default");
});

test("the sidebar control-center event is bridged once to the existing overlay host", async () => {
    const runtime = createContentRuntime();
    await runtime.ready();
    assert.equal(runtime.controlCenterListenerCount(), 1);
    runtime.dispatchControlCenter();
    runtime.dispatchControlCenter();
    assert.equal(runtime.controlCenterOpens(), 2);
    assert.equal(runtime.controlCenterListenerCount(), 1);
});

test("startup wires the adapter refresh without creating a second sidebar mount", async () => {
    const runtime = createContentRuntime();
    await runtime.ready();
    assert.equal(runtime.refreshCalls(), 1);
    assert.equal(runtime.applyCalls(), 0, "the harness clears the initial mount count; no duplicate apply occurs after startup");
});

test("storage-only planner transitions refresh the To-Do owner once per transition", async () => {
    const runtime = createContentRuntime({ syncSettings: { planner_tasks_enabled: false } });
    await runtime.ready();
    runtime.installTodoIntegration();

    runtime.applyStorage({ planner_tasks_enabled: { oldValue: false, newValue: true } });
    runtime.applyStorage({ planner_tasks_enabled: { oldValue: true, newValue: false } });

    assert.deepEqual(runtime.todoSettingsCalls(), [true, false], "storage-only off→on→off updates reach the rail owner exactly once each");
});

test("direct Planner SETTINGS_UPDATE followed by its storage echo refreshes the To-Do owner once", async () => {
    const runtime = createContentRuntime({ syncSettings: { planner_tasks_enabled: false } });
    await runtime.ready();
    runtime.installTodoIntegration();
    const direct = runtime.send({
        version: 1,
        request_id: "planner-live-then-storage-echo",
        type: "SETTINGS_UPDATE",
        payload: { area: "sync", changes: { planner_tasks_enabled: true } }
    });
    assert.equal(direct.response.payload.ok, true);
    runtime.applyStorage({ planner_tasks_enabled: { oldValue: false, newValue: true } });
    assert.deepEqual(runtime.todoSettingsCalls(), [true], "the storage acknowledgement observes the committed snapshot and does not recreate Planner transport/rail");
});

test("Better Todo indicator update tolerates transiently removed filter DOM", () => {
    const runtime = createContentRuntime();
    const indicator = { style: {} };
    const announcement = { offsetWidth: 25, offsetLeft: 0, firstElementChild: { style: {} } };
    const assignments = { offsetWidth: 25, offsetLeft: 50, firstElementChild: { style: {} } };
    const completed = { offsetWidth: 25, offsetLeft: 100, firstElementChild: { style: {} } };
    const nodes = new Map([
        ["better-todo-indicator", indicator],
        ["better-todo-announcement", announcement],
        ["better-todo-assignments", assignments],
        ["better-todo-completed", completed]
    ]);
    runtime.document.getElementById = (id) => nodes.get(id) || null;

    let delayedUpdate;
    runtime.context.setTimeout = (callback) => {
        delayedUpdate = callback;
        return 1;
    };
    vm.runInNewContext(
        'setTimeout(() => updateIndicator(document.getElementById("better-todo-assignments")), 10)',
        runtime.context,
        { filename: "js/content.js" }
    );
    nodes.delete("better-todo-indicator");
    assert.doesNotThrow(() => delayedUpdate());

    nodes.set("better-todo-indicator", indicator);
    announcement.firstElementChild = null;
    assert.doesNotThrow(() => vm.runInNewContext(
        'updateIndicator(document.getElementById("better-todo-assignments"))',
        runtime.context,
        { filename: "js/content.js" }
    ));
    assert.equal(indicator.style.width, "50px");
    assert.equal(indicator.style.left, "37.5px");
    assert.equal(assignments.firstElementChild.style.opacity, "1");
    assert.equal(completed.firstElementChild.style.opacity, ".5");
});
