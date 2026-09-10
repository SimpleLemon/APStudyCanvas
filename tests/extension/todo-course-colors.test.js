"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const todoApi = require("../../js/content/todo-api.js");
const CONTENT_SOURCE = fs.readFileSync(path.join(__dirname, "../../js/content.js"), "utf8");

// content.js helpers are module-private, so the focused tests load the real
// function bodies (plus the real cache-state declaration) into a fresh
// context, exactly like the other content-extraction harnesses.
function extractFunction(name) {
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

function loadContentHelpers(context) {
    const stateLine = CONTENT_SOURCE.match(/const todoCustomColorsState = \{[^}]*\};/)?.[0];
    assert.ok(stateLine, "the cache-state declaration must stay extractable");
    vm.runInNewContext(`${stateLine}\n${extractFunction("adoptCanvasCustomColors")}\n${extractFunction("mergeCanvasCustomColors")}\n${extractFunction("maybeFetchCanvasCustomColors")}\n${extractFunction("reconcileRightSideWrapperScroll")}\n__helpers = { todoCustomColorsState, adoptCanvasCustomColors, mergeCanvasCustomColors, maybeFetchCanvasCustomColors, reconcileRightSideWrapperScroll };`, context, { filename: "js/content.js" });
    return context.__helpers;
}

function styleStub() {
    const values = new Map();
    return {
        setProperty(name, value) { values.set(String(name), String(value)); },
        getPropertyValue(name) { return values.get(String(name)) ?? ""; },
        removeProperty(name) { values.delete(String(name)); },
        snapshot() { return Object.fromEntries(values); }
    };
}

function documentStub(wrapper) {
    return { getElementById: (id) => (id === "right-side-wrapper" ? wrapper : null) };
}

test("custom color normalization keeps Canvas's course_<id> keys and valid hex only", () => {
    assert.deepEqual(todoApi.normalizeCustomColors({
        custom_colors: {
            course_101: "#6969B3",
            course_102: "rgb(75,36,74)",
            course_103: "",
            account_1: "#123456",
            junk: "#abcdef",
            course_: "#abcdef",
            course_999999999999999999999: "#abcdef"
        }
    }), { course_101: "#6969b3" });
    for (const payload of [null, undefined, [], { }, { custom_colors: null }, { custom_colors: [] }, "ok"]) {
        assert.deepEqual(todoApi.normalizeCustomColors(payload), {}, `malformed payload ${JSON.stringify(payload)} yields no colors`);
    }
});

test("the bounded colors fetch succeeds, fails, and times out without ever throwing", async () => {
    const requests = [];
    const ok = todoApi.fetchCanvasCustomColors({
        fetchImpl: (url, init) => {
            requests.push({ url, init });
            return Promise.resolve({ ok: true, status: 200, json: async () => ({ custom_colors: { course_42: "#294D91" } }) });
        },
        origin: "https://canvas.emory.edu"
    });
    const success = await ok;
    assert.equal(success.ok, true);
    assert.deepEqual(success.colors, { course_42: "#294d91" });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "https://canvas.emory.edu/api/v1/users/self/colors");
    assert.equal(requests[0].init.method, "GET");
    assert.equal(requests[0].init.credentials, "include");
    assert.equal(requests[0].init.headers.Accept, "application/json");

    const failures = await Promise.all([
        todoApi.fetchCanvasCustomColors({ fetchImpl: async () => ({ status: 500 }), origin: "https://canvas.emory.edu" }),
        todoApi.fetchCanvasCustomColors({ fetchImpl: async () => { throw new Error("network down"); }, origin: "https://canvas.emory.edu" }),
        todoApi.fetchCanvasCustomColors({ fetchImpl: async () => ({ status: 200, json: async () => { throw new Error("bad json"); } }), origin: "https://canvas.emory.edu" }),
        todoApi.fetchCanvasCustomColors({ fetchImpl: async () => ({}), origin: "" }),
        todoApi.fetchCanvasCustomColors({ fetchImpl: async () => ({}), origin: "not-a-url" })
    ]);
    failures.forEach((failure) => {
        assert.equal(failure.ok, false, "failure is a settled result, never a rejection");
        assert.deepEqual(failure.colors, {});
        assert.ok(failure.error.code.startsWith("CANVAS_CUSTOM_COLORS"));
    });

    // Bounded: a hanging response is abandoned by the internal timeout.
    const started = Date.now();
    const hanging = await todoApi.fetchCanvasCustomColors({
        fetchImpl: (url, init) => new Promise((resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted")))),
        origin: "https://canvas.emory.edu",
        timeoutMs: 20
    });
    assert.equal(hanging.ok, false);
    assert.ok(Date.now() - started < 2000, "the timeout bounds the request well under the suite budget");

    // An external caller signal aborts cooperatively too.
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5);
    const aborted = await todoApi.fetchCanvasCustomColors({
        fetchImpl: (url, init) => new Promise((resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted")))),
        origin: "https://canvas.emory.edu",
        signal: controller.signal
    });
    assert.equal(aborted.ok, false);
});

test("content merges authoritative course_<id> colors over rail courses", () => {
    const context = { console };
    const { mergeCanvasCustomColors, todoCustomColorsState } = loadContentHelpers(context);
    const courses = [
        { id: "101", label: "BIOL", color: "#294d91" },
        { id: "102", label: "CHEM" }
    ];
    const merged = mergeCanvasCustomColors(courses, { course_101: "#6969b3" });
    assert.equal(merged[0].color, "#6969b3", "the Canvas color wins over any derived value");
    assert.strictEqual(merged[1], courses[1], "courses without an authoritative color pass through untouched");
    assert.strictEqual(mergeCanvasCustomColors(courses, null), courses, "no cache means no rewrite");
});

test("adoption caches per origin, skips cached origins and recent failures, and retries once the window passes", async () => {
    const context = {
        console,
        contentTodoApi: todoApi,
        fetch: async () => ({ status: 200, json: async () => ({ custom_colors: { course_7: "#386641" } }) })
    };
    const { adoptCanvasCustomColors, maybeFetchCanvasCustomColors, todoCustomColorsState } = loadContentHelpers(context);
    const origin = "https://canvas.emory.edu";

    const fetched = await maybeFetchCanvasCustomColors(origin, null);
    assert.equal(fetched.ok, true, "an uncached origin runs one bounded fetch through the real API module");
    assert.deepEqual(fetched.colors, { course_7: "#386641" });
    assert.equal(adoptCanvasCustomColors(origin, fetched), true, "the first successful adopt changes the cache");
    assert.deepEqual({ ...todoCustomColorsState.cache.get(origin) }, { course_7: "#386641" });
    assert.equal(adoptCanvasCustomColors(origin, { ok: true, colors: { course_7: "#386641" } }), false, "an identical echo is not a change");
    assert.strictEqual(await maybeFetchCanvasCustomColors(origin, null), null, "a cached origin is never refetched in the same session");

    todoCustomColorsState.cache.delete(origin);
    adoptCanvasCustomColors(origin, { ok: false, colors: {}, error: { code: "X" } });
    assert.ok(todoCustomColorsState.failureAt.get(origin) > 0, "a failed read records the attempt time");
    assert.strictEqual(await maybeFetchCanvasCustomColors(origin, null), null, "a recent failure is not retried inside the bounded window");
    todoCustomColorsState.failureAt.set(origin, Date.now() - 60001);
    const retry = await maybeFetchCanvasCustomColors(origin, null);
    assert.equal(retry.ok, true, "after the retry window one bounded fetch runs again");
    assert.deepEqual(retry.colors, { course_7: "#386641" });

    // A context whose transport is absent stays a no-op (content.js always
    // declares the module constant; here the stub mirrors the null case).
    const bare = loadContentHelpers({ console, contentTodoApi: null });
    assert.strictEqual(await bare.maybeFetchCanvasCustomColors(origin, null), null, "a missing transport fetch helper never fetches");
});

test("scroll ownership reconcile: default flow clears retired inline owners, opt-in pins one sticky frame", () => {
    const context = { console };
    const { reconcileRightSideWrapperScroll } = loadContentHelpers(context);

    const wrapper = { style: styleStub() };
    ["position", "top", "height", "overflow-y"].forEach((property) => wrapper.style.setProperty(property, "sticky-block"));
    wrapper.style.setProperty("flex", "0 0 280px"); // sidebar-owned, must survive

    context.options = {};
    context.document = documentStub(wrapper);
    reconcileRightSideWrapperScroll();
    ["position", "top", "height", "overflow-y"].forEach((property) => {
        assert.equal(wrapper.style.getPropertyValue(property), "", `flow mode clears stale inline ${property}`);
    });
    assert.equal(wrapper.style.getPropertyValue("flex"), "0 0 280px", "the reconcile only owns scroll/height, never layout width");

    context.options = { todo_separate_scrollbar: true };
    reconcileRightSideWrapperScroll();
    assert.equal(wrapper.style.getPropertyValue("position"), "sticky");
    assert.equal(wrapper.style.getPropertyValue("top"), "0");
    assert.equal(wrapper.style.getPropertyValue("height"), "calc(100dvh - 48px)");
    assert.equal(wrapper.style.getPropertyValue("overflow-y"), "auto");

    // A missing wrapper (course pages without the legacy column) is a no-op.
    context.options = {};
    context.document = documentStub(null);
    assert.doesNotThrow(() => reconcileRightSideWrapperScroll());
});
