"use strict";

// Small chrome.storage.local-shaped fake for search retention tests. It records
// physical writes/removals so tests can distinguish an ignored cache entry from
// one that was actually evicted from extension-local storage.
function createCanvasSearchStorage(initial = {}) {
    const store = { ...initial };
    const operations = [];
    return {
        operations,
        async get(key) { operations.push({ type: "get", key }); return { [key]: store[key] }; },
        async set(key, value) { operations.push({ type: "set", key }); store[key] = value; },
        async remove(key) { operations.push({ type: "remove", key }); delete store[key]; },
        value(key) { return store[key]; }
    };
}

module.exports = { createCanvasSearchStorage };
