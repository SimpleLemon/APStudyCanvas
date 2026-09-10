"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const root = path.resolve(__dirname, "../..");
const source = fs.readFileSync(path.join(root, "js/popup.js"), "utf8");

function testNode() {
    const listeners = new Map();
    const classes = new Set();
    return {
        checked: false, disabled: false, hidden: false, inert: false, textContent: "", dataset: {},
        classList: { toggle(name, active) { if (active) classes.add(name); else classes.delete(name); }, contains: (name) => classes.has(name) },
        setAttribute(name, value) { this[name] = String(value); },
        addEventListener(type, listener) { listeners.set(type, [...(listeners.get(type) || []), listener]); },
        removeEventListener(type, listener) { listeners.set(type, (listeners.get(type) || []).filter((candidate) => candidate !== listener)); },
        dispatch(type, detail = {}) {
            const event = { currentTarget: this, target: this, stopPropagation() {}, stopImmediatePropagation() {}, ...detail };
            for (const listener of listeners.get(type) || []) listener(event);
        }
    };
}

function harness({ dom = false, coordinator = true } = {}) {
    const elements = dom ? Object.fromEntries([
        "#nest-consent-enabled", "#nest-consent-refresh", "#nest-consent-status",
        "#calendar-capability-status", "#calendar-accounts-status-value"
    ].map((selector) => [selector, testNode()])) : {};
    const document = { querySelector: (selector) => elements[selector] || null, querySelectorAll: () => [] };
    const storage = { get: async () => ({}), set: async () => undefined };
    const chrome = { storage: { local: storage, sync: storage } };
    const context = vm.createContext({ URL, URLSearchParams, setTimeout, clearTimeout, console, window: {}, document, chrome });
    vm.runInContext(fs.readFileSync(path.join(root, "js/settings-schema.js"), "utf8"), context);
    vm.runInContext(source.slice(0, source.indexOf("function queueSettingWrite")), context);
    vm.runInContext(`
        globalThis.calls = [];
        globalThis.responses = [];
        globalThis.updates = [];
        globalThis.generation = 1;
        globalThis.binding = { accountKey: "a".repeat(64), sourceKey: "canvas:" + "a".repeat(64), origin: "https://canvas.emory.edu", canvasUserId: "123" };
        globalThis.snapshot = { generation: 1, identity: { state: "authenticated" }, binding, capabilities: { mutation: true }, consent: null };
        globalThis.controller = { state: { identity: { state: "authenticated" }, identityGeneration: 1, identityUserKey: "nest-user" } };
        if (${coordinator ? "true" : "false"}) controller.connection = {
            getSnapshot: () => snapshot, isCurrent: (value) => value === generation,
            update: (value) => { updates.push(value); }
        };
        globalThis.responseForType = null;
        popupPlatformRequest = async (type, payload) => { calls.push({type, payload}); const response = typeof responseForType === "function" ? responseForType(type, payload) : responses.shift(); return typeof response === "function" ? response() : response; };
        globalThis.calendar = createPopupCalendarController({ controller, document });
        Object.assign(calendar.state, { binding, contextState: "connected", consent: { valid: true, current: true, revoked: false }, consentVerified: true, sourceRef: "src1:test", mutationEnabled: true });
        globalThis.readResponse = current => ({consent:{version:1,source_key:binding.sourceKey,account_key:binding.accountKey,scopes:POPUP_CANVAS_CONSENT_SCOPES.slice(),current,granted:current}});
        globalThis.writeResponse = (scopes) => ({ contractVersion: 1, consent: { version: 2, source_key: binding.sourceKey, account_key: binding.accountKey, scopes, current: scopes.length > 0, granted: scopes.length > 0 }});
    `, context);
    return {
        elements,
        run: (code) => vm.runInContext(code, context),
        json: (code) => JSON.parse(vm.runInContext(`JSON.stringify(${code})`, context)),
        settle: async () => { for (let index = 0; index < 4; index += 1) await new Promise((resolve) => setImmediate(resolve)); }
    };
}

test("scoped permission edits replace only the write grant and preserve read consent", async () => {
    const h = harness();
    await h.run(`responses.push(writeResponse(["personal_events_write"])); calendar.loadWriteConsent()`);
    await h.run(`responses.push({ok:true}, writeResponse(["personal_events_write", "planner_items_write"])); calendar.setWriteConsentScope("planner_items_write", true)`);
    const saved = h.json(`calls.find(call => call.type === "NEST_CONSENT_SET")`);
    assert.equal(saved.payload.version, 2);
    assert.deepEqual(saved.payload.scopes, ["personal_events_write", "planner_items_write"]);
    assert.equal(saved.payload.source_key, `canvas:${"a".repeat(64)}`);
    assert.equal(h.run("calendar.state.consent.current"), true);
    assert.equal(h.run("updates.at(-1).consent.read.current"), true);
    await h.run(`responses.push({ok:true}, writeResponse(["planner_items_write"])); calendar.setWriteConsentScope("personal_events_write", false)`);
    assert.deepEqual(h.json(`calls.filter(call => call.type === "NEST_CONSENT_SET").at(-1).payload.scopes`), ["planner_items_write"]);
    await h.run(`responses.push({ok:true}, writeResponse([])); calendar.setWriteConsentScope("planner_items_write", false)`);
    assert.equal(h.run(`calls.filter(call => call.type === "NEST_CONSENT_SET").at(-1).payload.action`), "revoke");
    assert.equal(h.run("calendar.state.consent.current"), true);
});

test("write consent rejects another account and stale async completions", async () => {
    const h = harness();
    assert.equal(h.run(`popupCalendarNormalizeWriteConsent({...writeResponse(["personal_events_write"]), consent: {...writeResponse([]).consent, account_key: "b".repeat(64)}}, binding).valid`), false);
    const pending = h.run(`responses.push(() => new Promise(resolve => { globalThis.finish = resolve; })); calendar.loadWriteConsent()`);
    h.run(`generation++; finish(writeResponse(["personal_events_write"]))`);
    await pending;
    assert.equal(h.run("calendar.state.writeConsent"), null);
    assert.equal(h.run("updates.length"), 0);
});

test("calendar consent and calendar-list lookups ignore late responses after the connection changes", async () => {
    const h = harness();
    const calendarsPending = h.run(`responses.push(() => new Promise(resolve => { globalThis.finishCalendars = resolve; })); calendar.state.projectionEnabled = true; calendar.state.sourceRef = "src1:test"; calendar.loadCalendars()`);
    const consentPending = h.run(`responses.push(() => new Promise(resolve => { globalThis.finishConsent = resolve; })); calendar.loadConsent()`);
    await h.settle();
    h.run(`generation++; calendar.state.consent = null; calendar.state.calendars = [{id:"still-current"}]; finishConsent({consent:{version:1,source_key:binding.sourceKey,account_key:binding.accountKey,scopes:POPUP_CANVAS_CONSENT_SCOPES.slice(),current:true,granted:true}}); finishCalendars({source_ref:"src1:test",calendars:[{id:"late",label:"Late calendar",visible:true,routing_eligible:true}]})`);
    assert.equal(await consentPending, null);
    assert.equal(await calendarsPending, null);
    assert.equal(h.run("calendar.state.consent"), null);
    assert.deepEqual(h.json("calendar.state.calendars"), [{id:"still-current"}]);
    assert.deepEqual(h.json("calls.map(call => call.type)"), ["NEST_CALENDARS_GET", "NEST_CONSENT_GET"]);
    assert.equal(h.run("updates.length"), 1);
    assert.equal(h.run("updates[0].consent.read.current"), false);
});

test("partial capability snapshots keep independent calendar and personal-item paths gated", () => {
    const h = harness();
    assert.deepEqual(h.json("popupCalendarNormalizeCapabilities({upload:true,projection:true,overlay:false,replacement:false,mutation:false,mirroring:true})"), {
        upload: true, projection: true, overlay: false, replacement: false, mutation: false, mirroring: true
    });
    const model = (setup) => { h.run(`${setup}; calendar.render()`); return h.json("calendar.state.presentation"); };
    let p = model(`calendar.state.consent = {valid:true,current:true}; calendar.state.consentVerified = true; calendar.state.rolloutEnabled = true; calendar.state.projectionEnabled = true; calendar.state.overlayEnabled = false; calendar.state.replacementEnabled = false; calendar.state.mutationEnabled = false; calendar.state.mirroringEnabled = false; calendar.state.calendarMode = "off"`);
    assert.equal(p.sync, true);
    assert.equal(p.calendar, true, "projection keeps the calendar group available even when overlay is unavailable");
    assert.equal(p.overlay, false);
    assert.equal(p.replacement, false);
    assert.equal(p.permissions.personal_events_write, false);
    assert.match(p.summary, /calendar overlay/);

    p = model(`calendar.state.consent = {valid:true,current:true}; calendar.state.consentVerified = true; calendar.state.rolloutEnabled = false; calendar.state.projectionEnabled = false; calendar.state.overlayEnabled = false; calendar.state.replacementEnabled = false; calendar.state.mutationEnabled = true; calendar.state.mirroringEnabled = true; calendar.state.calendarMode = "off"`);
    assert.equal(p.sync, false);
    assert.equal(p.calendar, false);
    assert.equal(p.overlay, false);
    assert.equal(p.permissions.personal_events_write, true);
    assert.equal(p.permissions.planner_items_write, true);
    assert.equal(p.permissions.selected_item_mirroring, true);
});

test("activity actions use scoped messages and Keep Nest wire choice", async () => {
    const h = harness();
    await h.run(`responses.push({items:[{idempotency_key:"intent-1", event_ref:"user:1", state:"conflict", conflict:{expected_revision:"reviewed-token"}}]}); calendar.refreshWriteActivity()`);
    await h.run(`responses.push({ok:true}, {items:[]}); calendar.actOnWriteActivity("intent-1", "apply_writeback")`);
    const resolve = h.json(`calls.find(call => call.type === "CANVAS_WRITEBACK_RESOLVE")`);
    assert.deepEqual(resolve.payload, {account_key:"a".repeat(64),source_ref:"src1:test",idempotency_key:"intent-1",choice:"apply_writeback",expected_revision:"reviewed-token"});
    await h.run(`calendar.actOnWriteActivity("unknown", "unlink")`);
    assert.equal(h.run("calls.length"), 3);
    h.run("calendar.state.consent = null");
    await h.run("calendar.refreshWriteActivity()");
    assert.equal(h.run("calls.length"), 3);
});

test("progress labels are readable rather than raw timestamp and count keys", () => {
    const h = harness();
    assert.deepEqual(h.json(`popupCalendarCountSummary({pages_read: 4, items: {completed: 12}})`), ["Pages read: 4", "Items completed: 12"]);
});

test("account presentation separates authentication, binding, access, support, and failures", () => {
    const h = harness();
    const model = (setup) => { h.run(`${setup}; calendar.render()`); return h.json('calendar.state.presentation'); };
    for (const identity of ['checking', 'signed_out', 'expired', 'unavailable']) {
        const p = model(`snapshot.identity.state = '${identity}'`);
        assert.equal(p.bound, false);
        assert.equal(p.sync, false);
        assert.equal(Object.values(p.permissions).some(Boolean), false);
        assert.equal(p.error, identity === 'unavailable');
    }
    let p = model(`snapshot.identity.state = 'authenticated'; calendar.state.binding = null`);
    assert.equal(p.connected, true);
    assert.match(p.summary, /verify/);
    p = model(`calendar.state.binding = binding; calendar.state.consent = {valid:true,current:false}`);
    assert.equal(p.bound, true);
    assert.equal(p.optIn, false);
    assert.match(p.summary, /Allow Canvas data access/);
    p = model(`calendar.state.consent = {valid:false,current:false}; calendar.state.consentFailure = 'check'; calendar.state.consentVerified = false`);
    assert.equal(p.error, false);
    assert.equal(p.summary, "");
    p = model(`calendar.state.consentFailure = null; calendar.state.consent = {valid:true,current:true}; calendar.state.consentVerified = true; calendar.state.mutationEnabled = false`);
    assert.equal(p.sync, false);
    assert.equal(p.error, false);
    assert.match(p.summary, /Not available/);
    p = model(`calendar.state.rolloutEnabled = true; calendar.state.projectionEnabled = true; calendar.state.overlayEnabled = true; calendar.state.syncBusy = true`);
    assert.equal(p.sync, true, 'pending actions retain the group');
    assert.equal(p.overlay, true);
    p = model(`calendar.state.rolloutEnabled = false; calendar.state.optIns[binding.accountKey] = true; calendar.state.writeConsent = {valid:true,current:true,scopes:['personal_events_write']}; calendar.state.calendarMode = 'overlay'; calendar.state.overlayEnabled = false`);
    assert.equal(p.optIn, true, 'saved opt-in retains its off action');
    assert.equal(p.permissions.personal_events_write, true, 'granted scope retains revoke');
    assert.equal(p.calendar, true, 'saved unavailable mode retains Canvas-only recovery');
    assert.equal(h.run('calendar.state.calendarMode'), 'overlay');
    p = model(`calendar.state.capabilityError = true`);
    assert.equal(p.error, true);
    assert.match(p.summary, /could not be checked/);
});

test("read consent uses scoped SET then GET without starting an upload and ignores stale saves", async () => {
    const h = harness();
    h.run(`calendar.state.consent = {valid:true,current:false}; calendar.state.consentVerified = true`);
    await h.run(`responses.push({ok:true},readResponse(true)); calendar.setConsent(true)`);
    assert.deepEqual(h.json('calls.map(c => c.type)'), ['NEST_CONSENT_SET','NEST_CONSENT_GET']);
    assert.equal(h.run('calls[0].payload.version'), 1);
    assert.equal(h.run('calendar.state.presentation.access'), true);
    const pending = h.run(`responses.push(() => new Promise(resolve => {globalThis.finishSave = resolve})); calendar.setConsent(true)`);
    await h.settle();
    h.run(`generation++; calendar.state.consent = null; finishSave({ok:true})`);
    await pending;
    assert.equal(h.run('calendar.state.consent'), null);
    assert.equal(h.run('calls.length'), 3, 'stale save does not refresh the new account');
});

test("failed consent saves retain confirmed choices and expose recovery", async () => {
    const h = harness();
    h.run(`calendar.state.consent = {valid:true,current:false}; calendar.state.consentVerified = true`);
    await assert.rejects(h.run(`responses.push({ok:false}); calendar.setConsent(true)`));
    assert.equal(h.run('calendar.state.consent.current'), false);
    assert.equal(h.run('calendar.state.consentVerified'), false);
    assert.equal(h.run('calendar.state.presentation.error'), false);
    h.run(`calendar.state.writeConsent = {valid:true,current:true,scopes:['personal_events_write']}`);
    await h.run(`responses.push({ok:false}); calendar.setWriteConsentScope('personal_events_write',false)`);
    assert.deepEqual(h.json('calendar.state.writeConsent.scopes'), ['personal_events_write']);
    assert.equal(h.run('calendar.state.consent.current'), false);
});

test("the producer's empty consent is a valid missing grant, never a failed lookup or authorization", () => {
    const h = harness();
    h.run(`globalThis.empty = {version:1, sourceKey:binding.sourceKey, source_key:binding.sourceKey, accountKey:binding.accountKey, account_key:binding.accountKey, granted:false, current:true, state:'not_granted', scopes:[]}`);
    assert.equal(h.run('popupCalendarNormalizeConsent(empty,binding).valid'),true);
    assert.equal(h.run('popupCalendarNormalizeConsent(empty,binding).current'),false);
    assert.equal(h.run('popupCalendarNormalizeConnectionConsent(popupCalendarNormalizeConsent(empty,binding),binding).valid'),true);
    assert.equal(h.run('popupCalendarNormalizeConsent({...empty,granted:true},binding).valid'),false);
    assert.equal(h.run(`popupCalendarNormalizeConsent({...empty,account_key:'b'.repeat(64)},binding).valid`),false);
});

test("successful save with failed confirmation retains choices and retries only a read", async () => {
    const h = harness({ dom: true });
    h.run(`calendar.state.consent = {valid:true,current:false}; responses.push({ok:true}, () => {throw new Error('OFFLINE')})`);
    await assert.rejects(h.run('calendar.setConsent(true)'), /CONSENT_NOT_CONFIRMED/);
    assert.equal(h.run('calendar.state.consentOperation'), 'verification-failed');
    assert.equal(h.run('calendar.state.presentation.access'), false);
    assert.equal(h.elements['#nest-consent-enabled'].checked, false);
    assert.match(h.elements['#nest-consent-status'].textContent, /could not be confirmed/);
    assert.equal(h.elements['#calendar-capability-status'].hidden, true);
    assert.equal(h.elements['#calendar-accounts-status-value'].textContent, 'Nest connected');
    await h.run('responses.push(readResponse(true)); calendar.loadConsent()');
    assert.equal(h.run('calendar.state.presentation.access'), true);
    assert.equal(h.run('calendar.state.consentFailure'), null);
    assert.deepEqual(h.json('calls.map(call=>call.type)'), ['NEST_CONSENT_SET','NEST_CONSENT_GET','NEST_CONSENT_GET']);
});

test("newer consent reads serialize and stale completions cannot authorize access", async () => {
    const h = harness();
    const first = h.run(`responses.push(() => new Promise(resolve => {globalThis.finishRead=resolve})); calendar.loadConsent()`);
    await h.settle();
    const second = h.run('responses.push(readResponse(false)); calendar.loadConsent()');
    assert.equal(h.run('calls.length'), 1);
    h.run('finishRead(readResponse(true))');
    assert.equal(await first, null);
    await second;
    assert.equal(h.run('calendar.state.consentOperation'), 'idle');
    assert.equal(h.run('calendar.state.presentation.access'), false);
    assert.equal(h.run('calls.length'), 2);
});

test("fallback identity change clears busy consent and ignores the old save", async () => {
    const h = harness({ dom: true, coordinator: false });
    h.run('calendar.render()');
    const save = h.run(`responses.push(() => new Promise(resolve => {globalThis.finishSave=resolve})); calendar.setConsent(true)`);
    await h.settle();
    h.run(`controller.state.identityGeneration++; controller.state.identity={state:'signed_out'}; calendar.render()`);
    assert.equal(h.run('calendar.state.consentOperation'), 'idle');
    assert.equal(h.run('calendar.state.consent'), null);
    h.run('finishSave({ok:true})');
    assert.equal(await save, null);
    assert.equal(h.run('calendar.state.presentation.access'), false);
    assert.equal(h.run('calls.length'), 1);
});

test("Check access during a save waits for the mutation and confirms without resaving", async () => {
    const h = harness();
    h.run('calendar.state.consent={valid:true,current:false}');
    const save = h.run(`responses.push(() => new Promise(resolve => {globalThis.finishSave=resolve})); calendar.setConsent(true)`);
    await h.settle();
    const check = h.run('responses.push(readResponse(true)); calendar.loadConsent()');
    assert.deepEqual(h.json('calls.map(call=>call.type)'), ['NEST_CONSENT_SET']);
    h.run('finishSave({ok:true})');
    assert.equal(await save, null);
    await check;
    assert.deepEqual(h.json('calls.map(call=>call.type)'), ['NEST_CONSENT_SET','NEST_CONSENT_GET']);
    assert.equal(h.run('calendar.state.presentation.access'), true);
});
