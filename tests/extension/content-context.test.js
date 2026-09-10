"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const context = require("../../js/content/context.js");
const registration = require("../../js/platform/canvas-registration.js");

const STATIC_ORIGIN = "https://canvas.emory.edu";
const CUSTOM_ORIGIN = "https://canvas.example.edu";

function fakeDocument({ shell = true, signedOut = false } = {}) {
    return {
        title: "Canvas",
        querySelector(selector) {
            if (selector.includes("#application") || selector.includes("#wrapper.ic-app") || selector.includes(".ic-app")) return shell ? {} : null;
            if (selector.includes("#login_form") || selector.includes(".ic-Login__container")) return signedOut ? {} : null;
            if (selector.includes("#breadcrumbs")) return null;
            return null;
        }
    };
}

function fakeChrome({ customDomain = [], accounts = [] } = {}) {
    return {
        storage: {
            sync: { get: async () => ({ custom_domain: customDomain }) },
            local: { get: async () => ({ "platform.accountMetadata": { accounts } }) }
        }
    };
}

function queuedFetch(items) {
    const calls = [];
    let index = 0;
    const fetchImpl = async (url, options) => {
        calls.push({ url, options });
        const item = items[Math.min(index++, items.length - 1)];
        if (item instanceof Error) throw item;
        return {
            ok: item.status >= 200 && item.status < 300,
            status: item.status,
            async json() { return item.body; }
        };
    };
    return { fetchImpl, calls };
}

function canvasWindow(origin = STATIC_ORIGIN, pathname = "/courses/42") {
    const url = new URL(`${origin}${pathname}`);
    return { location: { protocol: url.protocol, host: url.host, pathname: url.pathname, origin: url.origin } };
}

function user(id, name = "Student", avatar_url = "https://cdn.example/avatar.png?size=96") {
    return { id, name, avatar_url, ignored: "drop-me", accessToken: "never-return" };
}

test("origin matrix accepts only normalized HTTPS roots and requires custom configuration plus verification", () => {
    assert.equal(context.normalizeCanvasOrigin("canvas.example.edu/"), CUSTOM_ORIGIN);
    assert.equal(context.normalizeCanvasOrigin("https://canvas.example.edu:443/"), CUSTOM_ORIGIN);
    for (const value of [
        "http://canvas.example.edu",
        "https://user:pass@canvas.example.edu",
        "https://canvas.example.edu/courses/42",
        "https://canvas.example.edu/?next=/courses/42",
        "https://canvas.example.edu/#profile",
        "https://localhost",
        "https://127.0.0.1",
        "https://canvas",
        "https://foo..example.edu",
        "https://-foo.example.edu"
    ]) assert.equal(context.normalizeCanvasOrigin(value), null, value);

    assert.equal(context.isApprovedOrigin(STATIC_ORIGIN), true);
    assert.equal(context.isApprovedOrigin(CUSTOM_ORIGIN, { configuredOrigins: [CUSTOM_ORIGIN], verifiedOrigins: [CUSTOM_ORIGIN] }), true);
    assert.equal(context.isApprovedOrigin(CUSTOM_ORIGIN, { configuredOrigins: [CUSTOM_ORIGIN], verifiedOrigins: [] }), false);
    assert.equal(context.isApprovedOrigin(CUSTOM_ORIGIN, { configuredOrigins: [], verifiedOrigins: [CUSTOM_ORIGIN] }), false);
    assert.deepEqual(context.verifiedOriginsFromMetadata({ accounts: [{ origin: CUSTOM_ORIGIN }, { origin: "https://evil.example/path" }] }), [CUSTOM_ORIGIN]);
});

test("user projection returns only safe identity fields and exact HTTPS avatars", () => {
    assert.equal(context.safeAvatar("https://cdn.example/avatar.png?size=96", STATIC_ORIGIN), "https://cdn.example/avatar.png?size=96");
    for (const value of [
        "http://cdn.example/avatar.png",
        "https://user:pass@cdn.example/avatar.png",
        "https://cdn.example/avatar.png#token",
        "https://cdn.example/avatar.png?access_token=secret",
        "https://cdn.example/private.ics"
    ]) assert.equal(context.safeAvatar(value, STATIC_ORIGIN), null, value);

    assert.deepEqual(context.sanitizeCanvasUser(user("student-1", "Student Example"), STATIC_ORIGIN), {
        id: "student-1",
        name: "Student Example",
        avatarUrl: "https://cdn.example/avatar.png?size=96"
    });
    assert.deepEqual(context.sanitizeCanvasUser({ id: "token=secret", name: "Bearer secret", avatar_url: "http://bad.example/a" }, STATIC_ORIGIN), {
        id: null,
        name: null,
        avatarUrl: null
    });
});

test("verified content binding carries the exact Canvas identity scope and unverified context carries none", () => {
    const accountKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const verified = context.buildCanvasBinding({
        verifiedContext: {
            ok: true,
            state: "verified",
            origin: CUSTOM_ORIGIN,
            userId: "student-1",
            profile: { displayName: "Student Example" }
        },
        context: {
            ok: true,
            state: "connected",
            origin: CUSTOM_ORIGIN,
            canvasUser: { id: "student-1" },
            profile: { displayName: "Student Example" }
        },
        accountKey,
        extraction: "supported"
    });
    assert.deepEqual(verified, {
        origin: CUSTOM_ORIGIN,
        canvasUserId: "student-1",
        accountKey,
        sourceKey: `canvas:${accountKey}`,
        label: "Student Example",
        extraction: "supported"
    });

    assert.equal(context.buildCanvasBinding({
        verifiedContext: { ok: false, state: "waiting", origin: CUSTOM_ORIGIN, userId: "student-1" },
        context: { ok: true, state: "connected", origin: CUSTOM_ORIGIN, canvasUser: { id: "student-1" } },
        accountKey,
        extraction: "supported"
    }), null);
});

test("GET_CANVAS_CONTEXT is live, re-fetches self, and pauses account-bound work on switching accounts", async () => {
    const fetched = queuedFetch([
        { status: 200, body: user("student-a", "Alice") },
        { status: 200, body: { id: "student-a", time_zone: "America/New_York", primary_email: "private@example.edu" } },
        { status: 200, body: user("student-b", "Bob") },
        { status: 200, body: { id: "student-b", time_zone: "Asia/Tokyo", primary_email: "private@example.edu" } },
        { status: 200, body: user("student-b", "Bob") },
        { status: 200, body: { id: "student-b", time_zone: "Asia/Tokyo", primary_email: "private@example.edu" } }
    ]);
    const changes = [];
    const service = context.createContextService({
        window: canvasWindow(),
        document: fakeDocument(),
        chromeApi: fakeChrome({ customDomain: [STATIC_ORIGIN], accounts: [{ origin: STATIC_ORIGIN }] }),
        fetchImpl: fetched.fetchImpl,
        onAccountChange: (change) => changes.push(change),
        now: () => 123
    });

    const first = await service.getContext();
    assert.equal(first.state, "connected");
    assert.deepEqual(first.profile, { displayName: "Alice", avatarUrl: "https://cdn.example/avatar.png?size=96" });
    assert.equal(first.canvasUser.id, "student-a");
    assert.equal(first.canvasUser.plannerTimeZone, "America/New_York");
    assert.equal(first.ignored, undefined);
    assert.equal(JSON.stringify(first).includes("accessToken"), false);

    const second = await service.getContext();
    assert.equal(second.canvasUser.id, "student-b");
    assert.equal(second.accountBoundJobsPaused, true);
    assert.equal(service.isAccountJobsPaused(), true);
    assert.deepEqual(changes, [{ reason: "canvas_account_changed", generation: 1 }]);
    assert.equal(fetched.calls.length, 4);
    assert.equal(fetched.calls[0].url, `${STATIC_ORIGIN}/api/v1/users/self`);
    assert.equal(fetched.calls[1].url, `${STATIC_ORIGIN}/api/v1/users/self/profile`);
    assert.deepEqual(fetched.calls[0].options.headers, { Accept: "application/json" });
    assert.equal(fetched.calls[0].options.credentials, "include");
    assert.equal(Object.keys(fetched.calls[0].options).includes("cookie"), false);
    assert.equal(Object.keys(fetched.calls[0].options).includes("csrf"), false);
    assert.equal(Object.keys(fetched.calls[0].options).includes("token"), false);
    assert.equal(second.canvasUser.plannerTimeZone, "Asia/Tokyo");
    assert.equal(JSON.stringify(first).includes("private@example.edu"), false);

    const verified = await service.verifyAccount({ expectedOrigin: STATIC_ORIGIN, expectedUserId: "student-b" });
    assert.deepEqual(verified, {
        ok: true,
        state: "verified",
        verified: true,
        origin: STATIC_ORIGIN,
        userId: "student-b",
        profile: { displayName: "Bob", avatarUrl: "https://cdn.example/avatar.png?size=96" },
        canvasUser: { id: "student-b", name: "Bob", avatarUrl: "https://cdn.example/avatar.png?size=96", plannerTimeZone: "Asia/Tokyo" },
        accountBoundJobsPaused: true
    });
});

test("profile timezone is an optional, profile-only enrichment and never leaks profile data", async () => {
    const profiles = [
        { label: "missing", response: { status: 200, body: { id: "student-a", primary_email: "private@example.edu" } } },
        { label: "invalid", response: { status: 200, body: { id: "student-a", time_zone: "Mars/Phobos", primary_email: "private@example.edu" } } },
        { label: "wrong user", response: { status: 200, body: { id: "student-b", time_zone: "Asia/Tokyo", primary_email: "private@example.edu" } } },
        { label: "server failure", response: { status: 503, body: {} } },
        { label: "network failure", response: new Error("profile unavailable") }
    ];

    for (const profile of profiles) {
        const calls = [];
        const fetchImpl = async (url) => {
            calls.push(String(url));
            const item = String(url).endsWith("/profile")
                ? profile.response
                // A timezone on `/self` must never become Planner authority.
                : { status: 200, body: { ...user("student-a"), time_zone: "Asia/Tokyo" } };
            if (item instanceof Error) throw item;
            return { ok: item.status >= 200 && item.status < 300, status: item.status, async json() { return item.body; } };
        };
        const service = context.createContextService({
            window: canvasWindow(), document: fakeDocument(), chromeApi: fakeChrome(), fetchImpl
        });
        const value = await service.getContext();
        assert.equal(value.state, "connected", profile.label);
        assert.equal(value.canvasUser.plannerTimeZone, undefined, profile.label);
        assert.equal(JSON.stringify(value).includes("private@example.edu"), false, profile.label);
        assert.deepEqual(calls, [
            `${STATIC_ORIGIN}/api/v1/users/self`,
            `${STATIC_ORIGIN}/api/v1/users/self/profile`
        ], profile.label);
    }
});

test("profile timezone has its own bounded abort lifecycle without failing identity", async () => {
    let timedOutSignal = null;
    const timeoutService = context.createContextService({
        window: canvasWindow(), document: fakeDocument(), chromeApi: fakeChrome(), selfTimeoutMs: 1,
        fetchImpl: async (url, options) => {
            if (!String(url).endsWith("/profile")) return { ok: true, status: 200, async json() { return user("student-a"); } };
            timedOutSignal = options.signal;
            return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("profile timeout")), { once: true }));
        }
    });
    const timedOut = await timeoutService.getContext();
    assert.equal(timedOut.state, "connected");
    assert.equal(timedOut.canvasUser.plannerTimeZone, undefined);
    assert.equal(timedOutSignal?.aborted, true);

    let disposedSignal = null;
    const disposedService = context.createContextService({
        window: canvasWindow(), document: fakeDocument(), chromeApi: fakeChrome(), selfTimeoutMs: 1000,
        fetchImpl: async (url, options) => {
            if (!String(url).endsWith("/profile")) return { ok: true, status: 200, async json() { return user("student-a"); } };
            disposedSignal = options.signal;
            return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("profile disposed")), { once: true }));
        }
    });
    const pending = disposedService.getContext();
    await new Promise((resolve) => setImmediate(resolve));
    disposedService.dispose();
    const disposed = await pending;
    assert.equal(disposedSignal?.aborted, true);
    assert.deepEqual(disposed, { ok: false, state: "error", code: "CANVAS_CONTEXT_DISPOSED" });
});

test("capabilities expose extraction only when the verified context has a ready handler", async () => {
    const fetchResult = queuedFetch([{ status: 200, body: user("student-a") }]);
    const service = context.createContextService({
        window: canvasWindow(),
        document: fakeDocument(),
        chromeApi: fakeChrome({ customDomain: [STATIC_ORIGIN], accounts: [{ origin: STATIC_ORIGIN }] }),
        fetchImpl: fetchResult.fetchImpl,
        isExtractionReady: () => true
    });
    const value = await service.getContext();
    assert.equal(value.capabilities.identity, "ready");
    assert.equal(value.capabilities.extraction, "supported");
    assert.equal(value.capabilities.upload, "unsupported");
    assert.equal(value.capabilities.writeback, "unsupported");
    assert.equal(value.capabilities.calendar, "unsupported");
});

test("account verification compares the live origin and user, and exposes waiting and signed-out states", async () => {
    const mismatchFetch = queuedFetch([
        { status: 200, body: user("student-a") }, { status: 200, body: { id: "student-a", time_zone: "America/New_York" } },
        { status: 200, body: user("student-a") }, { status: 200, body: { id: "student-a", time_zone: "America/New_York" } }
    ]);
    const mismatchService = context.createContextService({
        window: canvasWindow(), document: fakeDocument(), chromeApi: fakeChrome({ customDomain: [STATIC_ORIGIN] }), fetchImpl: mismatchFetch.fetchImpl
    });
    const originMismatch = await mismatchService.verifyAccount({ expectedOrigin: CUSTOM_ORIGIN, expectedUserId: "student-a" });
    assert.deepEqual(originMismatch, { ok: false, state: "mismatch", code: "CANVAS_ORIGIN_MISMATCH", origin: STATIC_ORIGIN });

    const userMismatch = await mismatchService.verifyAccount({ expectedOrigin: STATIC_ORIGIN, expectedUserId: "student-b" });
    assert.deepEqual(userMismatch, { ok: false, state: "mismatch", code: "CANVAS_USER_ID_MISMATCH", origin: STATIC_ORIGIN });
    assert.equal(mismatchFetch.calls.length, 4, "verification refreshes bounded self and profile context for every attempt");

    const waitingService = context.createContextService({
        window: canvasWindow(), document: fakeDocument({ shell: false }), chromeApi: fakeChrome({ customDomain: [STATIC_ORIGIN] }), fetchImpl: async () => { throw new Error("must wait"); }
    });
    assert.deepEqual(await waitingService.verifyAccount({ expectedOrigin: STATIC_ORIGIN }), {
        ok: false, state: "waiting", code: "CANVAS_ACCOUNT_VERIFICATION_WAITING"
    });

    const signedOutFetch = queuedFetch([{ status: 401, body: {} }]);
    const signedOutService = context.createContextService({
        window: canvasWindow(), document: fakeDocument(), chromeApi: fakeChrome({ customDomain: [STATIC_ORIGIN] }), fetchImpl: signedOutFetch.fetchImpl
    });
    assert.deepEqual(await signedOutService.getContext(), {
        version: 1,
        ok: true,
        state: "signed_out",
        code: "CANVAS_ACCOUNT_NOT_AUTHENTICATED",
        profile: null,
        canvasUser: null,
        capabilities: { identity: "signed_out", extraction: "unsupported", upload: "unsupported", writeback: "unsupported", calendar: "unsupported" },
        tab: null,
        course: null,
        unread: null,
        accountBoundJobsPaused: false
    });
    assert.deepEqual(await signedOutService.verifyAccount({ expectedOrigin: STATIC_ORIGIN }), {
        ok: false, state: "signed_out", code: "CANVAS_ACCOUNT_NOT_AUTHENTICATED"
    });
});

test("dynamic registration uses the same ordered modules and requires verified custom origins for reconciliation", async () => {
    const scripts = [];
    const calls = { contains: [], registered: [] };
    const chromeApi = {
        permissions: { async contains(query) { calls.contains.push(query); return true; } },
        scripting: {
            async getRegisteredContentScripts() { return scripts.slice(); },
            async registerContentScripts(items) { calls.registered.push(...items); scripts.push(...items); },
            async unregisterContentScripts() {}
        }
    };
    const service = registration.createCanvasRegistration({ chromeApi });
    assert.equal((await service.ensureOrigin("https://canvas.example.edu/path", { configuredOrigins: [CUSTOM_ORIGIN], verifiedOrigins: [CUSTOM_ORIGIN] })).code, "CANVAS_ORIGIN_NOT_CONFIGURED");
    assert.equal((await service.ensureOrigin(CUSTOM_ORIGIN, { configuredOrigins: [CUSTOM_ORIGIN], verifiedOrigins: [] })).code, "CANVAS_ORIGIN_NOT_VERIFIED");
    const result = await service.reconcile({ configuredOrigins: [CUSTOM_ORIGIN], verifiedOrigins: [CUSTOM_ORIGIN] });
    assert.equal(result[0].state, "registered");
    assert.equal(scripts.length, 2);
    assert.deepEqual(scripts[0].js, [registration.CANVAS_WATCHDOG_SCRIPT]);
    assert.equal(scripts[0].world, "MAIN");
    assert.deepEqual(scripts[1].js, registration.CANVAS_CONTENT_SCRIPTS);
    assert.equal(scripts[1].js.at(-1), "js/content.js");
    assert.deepEqual(scripts[1].matches, [`${CUSTOM_ORIGIN}/*`]);
    assert.deepEqual(calls.contains, [{ origins: [`${CUSTOM_ORIGIN}/*`] }]);
});

test("content seam preserves legacy hooks, rejects page bridges, and names unsupported sync/writeback families", () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const source = fs.readFileSync(path.join(__dirname, "../../js/content.js"), "utf8");
    for (const message of ["getCards", "setcolors", "getcolors", "inspect", "fixdm", "updateBackground"]) assert.match(source, new RegExp(`\\"${message}\\"`));
    for (const family of ["CANVAS_SYNC_START", "CANVAS_SYNC_RESUME", "CANVAS_SYNC_STATUS", "CANVAS_SYNC_CANCEL", "CANVAS_WRITEBACK_DRAIN", "CANVAS_WRITEBACK_RESULT"]) assert.match(source, new RegExp(family));
    assert.match(source, /contentSyncExtractionApi\?\.createContentSyncExtraction/);
    assert.match(source, /request\?\.type === "CANVAS_SYNC_EXTRACT_INTERNAL"/);
    assert.match(source, /contentSyncExtractionHandler\.handle\(request, sender\)/);
    assert.doesNotMatch(source, /CANVAS_SYNC_EXTRACT_INTERNAL",\s*"/);
    assert.match(source, /request\.type === "CANVAS_ACCOUNT_VERIFY"/);
    assert.doesNotMatch(source, /window\.postMessage/);
    assert.doesNotMatch(source, /addEventListener\(["']message["']/);
});
