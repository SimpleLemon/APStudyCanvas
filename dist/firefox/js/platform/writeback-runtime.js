(function (root, factory) {
    'use strict';
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.APStudyCanvasPlatform = Object.assign(root.APStudyCanvasPlatform || {}, { WritebackRuntime: api });
}(globalThis, function () {
    'use strict';
    const ALARM = 'apstudycanvas-personal-writes-v1';
    function createRuntime({ storage, service, alarms } = {}) {
        let running = null;
        async function cycle() {
            const flags = await storage.readFlags();
            if (flags.mutation !== true || flags.mirroring !== true) return;
            const local = await storage.get('local', 'platform.sourceMetadata');
            const accounts = local?.['platform.sourceMetadata']?.accounts || {};
            for (const [accountKey, metadata] of Object.entries(accounts).slice(0, 20)) {
                if (!/^[a-f0-9]{64}$/.test(accountKey) || metadata?.active === false || metadata?.archived === true || metadata?.source_key !== `canvas:${accountKey}` || !/^src1:[A-Za-z0-9._~-]{1,128}$/.test(metadata?.source_ref || '')) continue;
                const current = await storage.readFlags();
                if (current.mutation !== true || current.mirroring !== true) return;
                // drain rechecks both identities, live capabilities, and read/write consent.
                try { await service.drain({ account_key: accountKey, source_ref: metadata.source_ref }, { metadata, requestId: `writeback-${Date.now()}` }); }
                catch (_) { /* Durable state resumes on the next alarm. */ }
            }
        }
        function tick() {
            if (!running) running = cycle().finally(() => { running = null; });
            return running;
        }
        function start() {
            Promise.resolve(alarms?.create?.(ALARM, { periodInMinutes: 1 })).catch(() => {});
            void Promise.resolve().then(tick).catch(() => {});
        }
        function handleAlarm(alarm) { return alarm?.name === ALARM ? tick() : Promise.resolve(); }
        return Object.freeze({ start, tick, handleAlarm });
    }
    return Object.freeze({ ALARM, createRuntime });
}));
