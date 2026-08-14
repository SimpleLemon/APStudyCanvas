"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { webcrypto } = require("node:crypto");

const root = path.resolve(__dirname, "../..");
const fixtureRoot = path.join(root, "tests/fixtures/canvas/normalizers");
const identity = require(path.join(root, "js/canvas-adapter/identity.js"));
const contracts = require(path.join(root, "js/canvas-adapter/contracts.js"));
const normalizers = require(path.join(root, "js/canvas-adapter/normalizers.js"));

const ACCOUNT = { origin: "https://canvas.example.edu", userId: 123 };
const FIXTURE_FILES = ["assignment.json", "quiz.json", "discussion-topic.json", "planner-note.json", "calendar-event.json"];

function readFixture(file) {
    return JSON.parse(fs.readFileSync(path.join(fixtureRoot, file), "utf8"));
}

function options(overrides = {}) {
    return { ...ACCOUNT, ...overrides };
}

function assertQuarantine(result, code) {
    assert.equal(result.ok, false);
    assert.equal(result.state, "quarantined");
    assert.equal(result.code, code);
    assert.deepEqual(result.items, []);
    assert.deepEqual(result.reason, { code });
    assert.equal(Object.prototype.hasOwnProperty.call(result, "raw"), false);
}

test("all five Phase5A item types normalize through their actual exports", async () => {
    for (const file of FIXTURE_FILES) {
        const fixture = readFixture(file);
        const result = await normalizers.normalizeCanvasItem(fixture.type, fixture.item, fixture.options);
        assert.equal(result.ok, true, file);
        assert.equal(result.state, "normalized", file);
        assert.equal(result.type, fixture.type, file);
        assert.equal(result.items.length, 1, file);
        const item = result.item;
        assert.equal(item.schemaVersion, 1, file);
        assert.match(item.eventRef, /^canvas:[a-f0-9]{64}:[a-f0-9]{64}$/);
        for (const field of ["key", "id", "contextId", "calendarId", "occurrenceId", "revision", "payloadHash", "accountKey"]) {
            assert.ok(item.source[field] !== undefined && item.source[field] !== null, `${file}: missing source.${field}`);
        }
        assert.equal(await normalizers.safeUploadObject(item), true, file);
    }
});

test("origin and user identity invalid matrix is fail-closed", async () => {
    for (const origin of [
        "http://canvas.example.edu",
        "https://user:pass@canvas.example.edu",
        "https://canvas.example.edu/courses/42",
        "https://canvas.example.edu/?token=secret",
        "https://canvas.example.edu/#profile",
        "javascript:alert(1)",
        "https://canvas..example.edu"
    ]) assert.equal(identity.normalizeCanvasOrigin(origin), null, origin);
    for (const userId of [undefined, null, "", "0", 0, "-1", "1.2", "student-1", "123456789012345678901", Number.MAX_SAFE_INTEGER + 1]) {
        assert.equal(identity.normalizeAccount({ origin: ACCOUNT.origin, userId }), null, String(userId));
    }
    assert.deepEqual(identity.normalizeAccount(ACCOUNT), { origin: ACCOUNT.origin, userId: "123" });
    assert.equal(await identity.accountKey({ origin: ACCOUNT.origin, userId: "not-an-id" }), null);
});

test("SHA-256 uses WebCrypto and the same deterministic fallback known vectors", async () => {
    const vectors = [
        ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
        ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
        ["The quick brown fox jumps over the lazy dog", "d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592"]
    ];
    for (const [value, expected] of vectors) {
        assert.equal(await identity.sha256Hex(value, { cryptoImpl: webcrypto }), expected);
        assert.equal(await identity.sha256Hex(value, { cryptoImpl: webcrypto, forceFallback: true }), expected);
        assert.equal(identity.sha256HexSync(value), expected);
    }
    assert.equal(
        await identity.accountKey({ ...ACCOUNT, cryptoImpl: webcrypto }),
        "82b43931e4cb7ecd230c97a5c65c002dcc3016797b3ba873250686e01bec321e"
    );
    assert.equal(
        await identity.accountKey({ ...ACCOUNT, forceFallback: true }),
        "82b43931e4cb7ecd230c97a5c65c002dcc3016797b3ba873250686e01bec321e"
    );
});

test("account, type, context, remote, and occurrence components are collision-resistant", async () => {
    const accountA = await identity.accountKey({ origin: ACCOUNT.origin, userId: 123, forceFallback: true });
    const accountB = await identity.accountKey({ origin: "https://other.example.edu", userId: 123, forceFallback: true });
    const accountC = await identity.accountKey({ origin: ACCOUNT.origin, userId: 124, forceFallback: true });
    assert.notEqual(accountA, accountB);
    assert.notEqual(accountA, accountC);

    const base = { type: "assignment", contextId: "course:42", remoteId: "10", occurrenceId: "10" };
    const keys = [
        identity.sourceItemKey(base),
        identity.sourceItemKey({ ...base, type: "quiz" }),
        identity.sourceItemKey({ ...base, contextId: "course:43" }),
        identity.sourceItemKey({ ...base, remoteId: "11" }),
        identity.sourceItemKey({ ...base, occurrenceId: "11" }),
        identity.sourceItemKey({ ...base, contextId: "course", remoteId: "42:10" })
    ];
    assert.equal(new Set(keys).size, keys.length);
    assert.equal(identity.sourceItemKey({ ...base, occurrenceId: undefined }), null);
    assert.equal(identity.sourceItemKey({ ...base, occurrenceId: "" }), null);
    assert.equal(identity.sourceItemKey({ ...base, remoteId: undefined }), null);

    const eventRef = await identity.buildEventRef({ accountKey: accountA, sourceItemKey: keys[0] });
    assert.match(eventRef, /^canvas:[a-f0-9]{64}:[a-f0-9]{64}$/);
    assert.notEqual(eventRef, keys[0]);
    assert.notEqual(eventRef, "canvas:" + accountA + ":" + keys[0]);
    const correlation = identity.safeCorrelationId("student=123/course=42/item=10");
    assert.match(correlation, /^c-[a-f0-9]{24}$/);
    assert.equal(correlation.includes("123"), false);
});

test("Canvas IDs preserve canonical 64-bit digit strings and reject unsafe numeric collisions", async () => {
    const unsafeA = 9007199254740992;
    const unsafeB = 9007199254740993;
    assert.equal(unsafeA, unsafeB);
    assert.equal(identity.sourceItemKey({ type: "assignment", contextId: "course:42", remoteId: unsafeA, occurrenceId: unsafeA }), null);
    assert.equal(identity.sourceItemKey({ type: "assignment", contextId: "course:42", remoteId: unsafeB, occurrenceId: unsafeB }), null);
    const stringA = identity.sourceItemKey({ type: "assignment", contextId: "course:42", remoteId: "9007199254740992", occurrenceId: "9007199254740992" });
    const stringB = identity.sourceItemKey({ type: "assignment", contextId: "course:42", remoteId: "9007199254740993", occurrenceId: "9007199254740993" });
    assert.notEqual(stringA, stringB);

    const fixture = readFixture("assignment.json");
    const rejected = await normalizers.normalizeAssignment({ ...fixture.item, id: unsafeA }, fixture.options);
    assertQuarantine(rejected, "CANVAS_REMOTE_ID_MISSING");
    const acceptedA = await normalizers.normalizeAssignment({ ...fixture.item, id: "9007199254740992" }, fixture.options);
    const acceptedB = await normalizers.normalizeAssignment({ ...fixture.item, id: "9007199254740993" }, fixture.options);
    assert.equal(acceptedA.ok, true);
    assert.equal(acceptedB.ok, true);
    assert.notEqual(acceptedA.item.eventRef, acceptedB.item.eventRef);
    assert.equal(acceptedA.item.source.id, "9007199254740992");
    assert.equal(acceptedB.item.source.id, "9007199254740993");
});

test("safe upload validation recomputes account and source-item identity", async () => {
    const fixture = readFixture("assignment.json");
    const normalized = await normalizers.normalizeAssignment(fixture.item, fixture.options);
    assert.equal(await normalizers.safeUploadObject(normalized.item), true);

    const metadataChanges = {
        type: "quiz",
        contextId: "43",
        id: "999",
        occurrenceId: "999"
    };
    for (const [field, altered] of Object.entries(metadataChanges)) {
        const candidate = { ...normalized.item, source: { ...normalized.item.source, [field]: altered } };
        assert.equal(await normalizers.safeUploadObject(candidate), false, field);
    }

    const calendarFixture = readFixture("calendar-event.json");
    const calendar = await normalizers.normalizeCalendarEvent(calendarFixture.item, calendarFixture.options);
    assert.equal(await normalizers.safeUploadObject(calendar.item), true);
    assert.equal(await normalizers.safeUploadObject({
        ...calendar.item,
        source: { ...calendar.item.source, calendarId: "course_43" }
    }), false, "calendarId");

    const otherKey = identity.sourceItemKey({ type: "assignment", contextId: "42", remoteId: "999", occurrenceId: "999" });
    const forgedItemHash = await identity.buildEventRef({ accountKey: normalized.item.source.accountKey, sourceItemKey: otherKey });
    assert.equal(await normalizers.safeUploadObject({ ...normalized.item, eventRef: forgedItemHash }), false);
    assert.equal(await normalizers.safeUploadObject({ ...normalized.item, source: { ...normalized.item.source, key: otherKey } }), false, "source.key");

    const otherAccount = await identity.accountKey({ origin: ACCOUNT.origin, userId: "124" });
    const forgedAccount = await identity.buildEventRef({ accountKey: otherAccount, sourceItemKey: normalized.item.source.key });
    assert.equal(await normalizers.safeUploadObject({ ...normalized.item, eventRef: forgedAccount }), false);
    assert.equal(await normalizers.safeUploadObject({ ...normalized.item, source: { ...normalized.item.source, accountKey: otherAccount } }), false, "accountKey");
    assert.equal(await normalizers.safeUploadObject({ ...normalized.item, eventRef: normalized.item.eventRef.toUpperCase() }), false);
});

test("date-only, all-day, DST offsets, timezones, deadline-only items, and invalid dates are explicit", async () => {
    assert.deepEqual(normalizers.parseDateValue("2026-09-04", { allowDateOnly: true, timezone: "America/Phoenix" }), {
        kind: "all_day", date: "2026-09-04", sourceTimezone: "America/Phoenix", sourceOffset: null
    });
    assert.deepEqual(normalizers.parseDateValue("2026-11-01T01:30:00-07:00", { allowDateOnly: false, timezone: "America/Los_Angeles" }), {
        kind: "instant", utcInstant: "2026-11-01T08:30:00.000Z", sourceTimezone: "America/Los_Angeles", sourceOffset: "-07:00"
    });
    assert.equal(normalizers.parseDateValue("2026-02-29", { allowDateOnly: true }), null);
    assert.equal(normalizers.parseDateValue("2026-01-01T25:00:00Z", { allowDateOnly: false }), null);
    assert.equal(normalizers.parseDateValue("2026-01-01T10:00:00", { allowDateOnly: false }), null);

    const planner = readFixture("planner-note.json");
    const plannerResult = await normalizers.normalizePlannerNote(planner.item, options({ sourceTimezone: "America/Phoenix" }));
    assert.equal(plannerResult.item.date.kind, "all_day");
    assert.equal(plannerResult.item.date.sourceTimezone, "America/Phoenix");
    assert.equal(plannerResult.item.payload.deadline, undefined);
    assert.equal(plannerResult.item.payload.duration, undefined);

    for (const file of ["assignment.json", "quiz.json", "discussion-topic.json"]) {
        const fixture = readFixture(file);
        const result = await normalizers.normalizeCanvasItem(fixture.type, fixture.item, fixture.options);
        assert.equal(result.item.payload.deadline, true, file);
        assert.equal(result.item.payload.duration, undefined, file);
    }
    const invalid = readFixture("assignment.json");
    invalid.item.due_at = "2026-02-29T23:59:00Z";
    assertQuarantine(await normalizers.normalizeAssignment(invalid.item, invalid.options), "CANVAS_DATE_INVALID");
});

test("safe URLs require exact allowed HTTPS origins and exclude credentials, secrets, ICS, and unsafe schemes", () => {
    const good = "https://canvas.example.edu/courses/42/assignments/101?view=student";
    assert.equal(normalizers.safeUrl(good, ACCOUNT.origin), good);
    for (const value of [
        "https://canvas.example.edu.evil.test/courses/42",
        "http://canvas.example.edu/courses/42",
        "https://user:pass@canvas.example.edu/courses/42",
        "https://canvas.example.edu/courses/42?access_token=secret",
        "https://canvas.example.edu/courses/42?next=https%3A%2F%2Fevil.test%2Ftoken%3Dsecret",
        "https://canvas.example.edu/private.ics",
        "javascript:alert(1)",
        "data:text/html,secret"
    ]) assert.equal(normalizers.safeUrl(value, ACCOUNT.origin), null, value);
    assert.equal(normalizers.safeUrl("https://cdn.example.edu/resource", ACCOUNT.origin, { allowedSourceOrigins: ["https://cdn.example.edu"] }), "https://cdn.example.edu/resource");
    assert.equal(normalizers.safeUrl("https://other.example.edu/resource", ACCOUNT.origin, { allowedSourceOrigins: ["https://cdn.example.edu"] }), null);
    assert.equal(normalizers.safeUrl("https://cdn.example.edu/resource", ACCOUNT.origin, { sameOrigin: false, allowedSourceOrigins: ["https://cdn.example.edu"] }), "https://cdn.example.edu/resource");
});

test("recurrence is stable only with series UUID plus occurrence ID, and quarantine is sanitized", async () => {
    const fixture = readFixture("calendar-event.json");
    const recurring = { ...fixture.item, series_uuid: "series-1", rrule: "FREQ=WEEKLY" };
    const accepted = await normalizers.normalizeCalendarEvent(recurring, fixture.options);
    assert.equal(accepted.ok, true);
    assert.deepEqual(accepted.item.payload.recurrence, { seriesId: "series-1", rule: "FREQ=WEEKLY" });
    assert.equal(accepted.item.source.occurrenceId, "505");

    for (const unstable of [
        { ...fixture.item, rrule: "FREQ=DAILY" },
        { ...fixture.item, series_head: true },
        { ...fixture.item, series_uuid: "Bearer top-secret" }
    ]) {
        const result = await normalizers.normalizeCalendarEvent(unstable, fixture.options);
        assert.equal(result.ok, false);
        assert.equal(result.state, "quarantined");
        assert.equal(result.items.length, 0);
        assert.equal(JSON.stringify(result).includes("top-secret"), false);
    }
});

test("all completion combinations reconcile deterministically", () => {
    const absent = null;
    const incompleteSubmission = { workflow_state: "unsubmitted" };
    const completeSubmission = { submitted_at: "2026-08-30T12:00:00Z" };
    const absentOverride = null;
    const incompleteOverride = { marked_complete: false };
    const completeOverride = { marked_complete: true };
    assert.equal(normalizers.reconcileCompletion({ submission: absent, plannerOverride: absentOverride, type: "assignment" }), "incomplete/none");
    assert.equal(normalizers.reconcileCompletion({ submission: absent, plannerOverride: incompleteOverride, type: "assignment" }), "incomplete/none");
    assert.equal(normalizers.reconcileCompletion({ submission: absent, plannerOverride: completeOverride, type: "assignment" }), "completed/planner_override");
    assert.equal(normalizers.reconcileCompletion({ submission: incompleteSubmission, plannerOverride: absentOverride, type: "assignment" }), "incomplete/none");
    assert.equal(normalizers.reconcileCompletion({ submission: incompleteSubmission, plannerOverride: incompleteOverride, type: "assignment" }), "incomplete/none");
    assert.equal(normalizers.reconcileCompletion({ submission: incompleteSubmission, plannerOverride: completeOverride, type: "assignment" }), "completed/submission+planner_override");
    assert.equal(normalizers.reconcileCompletion({ submission: completeSubmission, plannerOverride: absentOverride, type: "assignment" }), "completed/submission");
    assert.equal(normalizers.reconcileCompletion({ submission: completeSubmission, plannerOverride: incompleteOverride, type: "assignment" }), "completed/submission+planner_override");
    assert.equal(normalizers.reconcileCompletion({ submission: completeSubmission, plannerOverride: completeOverride, type: "assignment" }), "completed/submission+planner_override");
    assert.equal(normalizers.reconcileCompletion({ type: "calendar_event", notApplicable: true }), "not_applicable");
});

test("canonical payload hash is key-order stable and excludes volatile or secret raw fields", async () => {
    const fixture = readFixture("assignment.json");
    const first = await normalizers.normalizeAssignment({
        ...fixture.item,
        access_token: "secret",
        private_description: "private",
        raw_email: "student@example.edu",
        private_ics: "BEGIN:VCALENDAR"
    }, fixture.options);
    const second = await normalizers.normalizeAssignment({
        private_ics: "BEGIN:VCALENDAR",
        raw_email: "student@example.edu",
        private_description: "private",
        access_token: "different-secret",
        html_url: fixture.item.html_url,
        due_at: fixture.item.due_at,
        description: fixture.item.description,
        name: fixture.item.name,
        course_id: fixture.item.course_id,
        id: fixture.item.id,
        updated_at: "2026-09-01T00:00:00Z"
    }, fixture.options);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(first.item.source.payloadHash, second.item.source.payloadHash);
    assert.equal(first.item.source.revision, `payload:${first.item.source.payloadHash}`);
    assert.deepEqual(first.item.payload, second.item.payload);
});

test("normalized output contains only safe description/URL data and required provenance", async () => {
    const fixture = readFixture("discussion-topic.json");
    const result = await normalizers.normalizeDiscussionTopic({
        ...fixture.item,
        private_description: "do not export",
        raw_email: "student@example.edu",
        private_ics: "BEGIN:VCALENDAR\nSECRET",
        assignment: { ...fixture.item.assignment, internal_token: "secret" }
    }, fixture.options);
    assert.equal(result.ok, true);
    const serialized = JSON.stringify(result.item);
    for (const forbidden of ["private_description", "do not export", "raw_email", "student@example.edu", "private_ics", "BEGIN:VCALENDAR", "internal_token"]) {
        assert.equal(serialized.includes(forbidden), false, forbidden);
    }
    assert.equal(result.item.payload.description, "Post a short introduction.");
    assert.equal(result.item.source.url, fixture.item.html_url);
    assert.equal(result.item.source.calendarUrl, fixture.item.html_url);
    assert.equal(result.item.source.accountKey, result.item.eventRef.split(":")[1]);
});

test("registry mutations remain runtime-disabled and unsupported item families stay excluded", async () => {
    function visit(value, pathName = "registry") {
        if (!value || typeof value !== "object") return;
        if (Array.isArray(value)) return value.forEach((item, index) => visit(item, `${pathName}[${index}]`));
        if (value.mutation === true) {
            assert.equal(value.enabled, false, `${pathName} mutation enabled`);
            assert.equal(contracts.operationAvailability("assignment", "create", { "canvas.assignments.manage": true }).ok, false);
        }
        Object.entries(value).forEach(([key, item]) => visit(item, `${pathName}.${key}`));
    }
    visit(contracts.CAPABILITY_REGISTRY);
    for (const type of contracts.SUPPORTED_TYPES || normalizers.SUPPORTED_TYPES) {
        assert.ok(contracts.getCapability(type));
        for (const name of ["create", "update", "completion", "delete"]) {
            const operation = contracts.getOperation(type, name);
            if (operation) assert.equal(operation.enabled, false, `${type}.${name}`);
        }
    }
    for (const type of ["announcement", "custom_local_task", "unknown"]) {
        assert.equal(contracts.getCapability(type), null, type);
        const result = await normalizers.normalizeCanvasItem(type, {}, options());
        assert.equal(result.state, "unsupported", type);
        assert.equal(result.code, "CANVAS_ITEM_TYPE_UNSUPPORTED", type);
    }
    const announcement = readFixture("discussion-topic.json");
    announcement.item.is_announcement = true;
    const result = await normalizers.normalizeDiscussionTopic(announcement.item, announcement.options);
    assert.deepEqual(result, { ok: false, state: "unsupported", type: "discussion_topic", code: "CANVAS_ANNOUNCEMENT_UNSUPPORTED", items: [] });
});
