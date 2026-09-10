'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime, ALARM } = require('../../js/platform/writeback-runtime.js');
const account = 'a'.repeat(64);
const metadata = { source_ref: 'src1:test', source_key: `canvas:${account}`, nest_user_id: 'nest1' };

test('durable writes resume from saved bindings and coalesce concurrent alarms', async () => {
    let calls = 0, release;
    const runtime = createRuntime({ storage: { readFlags: async () => ({ mutation: true, mirroring: true }), get: async () => ({ 'platform.sourceMetadata': { accounts: { [account]: metadata } } }) }, service: { drain: async (payload, options) => {
        calls++;
        assert.equal(payload.account_key, account);
        assert.equal(options.metadata.nest_user_id, 'nest1');
        await new Promise(resolve => { release = resolve; });
    } } });
    const first = runtime.tick(), second = runtime.tick();
    assert.equal(first, second);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1); release(); await first;
});

test('disabled flags and archived bindings never drain', async () => {
    for (const enabled of [false, true]) {
        let calls = 0;
        const runtime = createRuntime({ storage: { readFlags: async () => ({ mutation: enabled, mirroring: enabled }), get: async () => ({ 'platform.sourceMetadata': { accounts: { [account]: { ...metadata, archived: true } } } }) }, service: { drain: async () => { calls++; } } });
        await runtime.tick(); assert.equal(calls, 0);
    }
});

test('a persisted alarm recreates the runtime after worker restart', async () => {
    let created;
    const runtime = createRuntime({ storage: { readFlags: async () => ({}) }, service: {}, alarms: { create: (name, spec) => { created = {name, spec}; } } });
    runtime.start(); await runtime.tick(); await runtime.handleAlarm({ name: ALARM }); await runtime.tick();
    assert.deepEqual(created, { name: ALARM, spec: { periodInMinutes: 1 } });
});
