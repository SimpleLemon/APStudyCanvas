"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const extractor = require(path.join(root, "js/canvas-adapter/extractor.js"));
const batch = require(path.join(root, "js/canvas-adapter/batch.js"));
const transport = require(path.join(root, "js/platform/transport.js"));

test("extractor factory stays inert without the private internal capability", () => {
    assert.equal(extractor.createExtractor({ runtime: { sendMessage() {} } }), null);
});

test("isolated extractor batches stay below the local transport body ceiling", () => {
    assert.ok(extractor.UPLOAD_BATCH_BYTES < transport.MAX_BODY_BYTES);
    const result = batch.buildBatches([
        { eventRef: "a", payload: { value: "x".repeat(30000) } },
        { eventRef: "b", payload: { value: "y".repeat(30000) } }
    ], { maxItems: extractor.UPLOAD_BATCH_ITEMS, maxBytes: extractor.UPLOAD_BATCH_BYTES });
    assert.equal(result.batches.length, 2);
    assert.ok(result.batches.every((item) => item.byte_length <= extractor.UPLOAD_BATCH_BYTES));
});
