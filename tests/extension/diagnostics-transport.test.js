"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

test("diagnostics transport supports direct CommonJS consumption without window", () => {
    const modulePath = require.resolve("../../js/diagnostics-transport.js");
    const saved = {
        window: global.window,
        document: global.document,
        chrome: global.chrome,
        transport: global.APStudyCanvasDiagnosticsTransport,
        customDomain: global.APStudyCanvasCustomDomain
    };
    try {
        delete global.window;
        delete global.document;
        delete global.chrome;
        delete require.cache[modulePath];
        const transport = require(modulePath);
        assert.equal(transport, global.APStudyCanvasDiagnosticsTransport);
        assert.deepEqual(transport.normalizeCanvasDomains("canvas.example.edu"), {
            valid: true,
            value: ["https://canvas.example.edu"]
        });
        assert.equal(transport.normalizeCanvasDomains("http://canvas.example.edu").valid, false);
        assert.equal(typeof transport.inspectCanvas, "function");
        assert.equal(typeof transport.requestCustomOrigin, "function");
    } finally {
        delete require.cache[modulePath];
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete global[key];
            else global[key] = value;
        }
    }
});
