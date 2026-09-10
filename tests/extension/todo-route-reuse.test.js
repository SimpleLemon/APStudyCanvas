"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.resolve(__dirname, "../../js/content.js"), "utf8");
const todoCss = fs.readFileSync(path.resolve(__dirname, "../../css/todo-right-rail.css"), "utf8");

function extractFunction(name) {
    const start = source.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `missing ${name}`);
    const bodyStart = source.indexOf("{", start);
    let depth = 0;
    for (let index = bodyStart; index < source.length; index += 1) {
        if (source[index] === "{") depth += 1;
        if (source[index] === "}") {
            depth -= 1;
            if (depth === 0) return source.slice(start, index + 1);
        }
    }
    throw new Error(`unterminated ${name}`);
}

function placementFor({ path: route = "/", width, cards = null, rail = null }) {
    const placementSource = extractFunction("placement");
    const documentRef = {
        querySelector(selector) {
            if (selector === "#right-side") return rail;
            if (selector === "#DashboardCard_Container") return cards;
            return null;
        }
    };
    return new Function("document", "window", "current_page", `${placementSource}\nreturn placement;`)(
        documentRef,
        { innerWidth: width },
        route
    )();
}

const routeSource = extractFunction("route");

test("todo route() reuses the rendered view between supported routes instead of tearing the rail down", () => {
    const reuseStart = routeSource.indexOf("if (lastView)");
    assert.ok(reuseStart > 0, "route() keeps a last-view reuse branch");
    const reuseBranch = routeSource.slice(reuseStart);
    assert.match(reuseBranch, /render\(\{ \.\.\.lastView, courses \}\)/, "the last view is re-rendered in place");
    assert.doesNotMatch(reuseBranch, /removeRail\(/, "the reuse branch never tears the rail down");
    assert.doesNotMatch(reuseBranch, /lastView = null/, "the reuse branch never discards the view");
    assert.doesNotMatch(reuseBranch, /cardRenderers\.clear\(\)/, "the reuse branch keeps the dashboard card renderers");
});

test("todo route() keeps reuse except for an interrupted Planner mutation", () => {
    const reuseStart = routeSource.indexOf("if (lastView)");
    const unsupportedBranch = routeSource.slice(0, reuseStart);
    assert.match(unsupportedBranch, /!enabled\(\) \|\| !routeIsSupported\(\)/, "only disabled or unsupported routes tear down");
    assert.match(unsupportedBranch, /removeRail\(\)/);
    const preamble = routeSource.slice(0, routeSource.indexOf("if (!enabled()"));
    assert.match(preamble, /const interruptedPlannerOperation = activePlannerOperations > 0;/);
    assert.match(preamble, /if \(interruptedPlannerOperation\) removeRail\(\);/, "only a route-interrupted Planner operation tears down the rail so old modal/completion state cannot land");
    assert.doesNotMatch(preamble, /lastView = null/);
});

test("todo route invalidates Planner transports before reuse and makes only enabled routes fresh", () => {
    const invalidation = routeSource.indexOf("disposePlannerTaskTransport();");
    const routeGate = routeSource.indexOf("if (!enabled() || !routeIsSupported())");
    const reset = routeSource.indexOf("resetPlannerTaskTransport();");
    assert.ok(invalidation > -1 && invalidation < routeGate, "route cancels old page/write transport before it can repaint a reused rail");
    assert.ok(reset > routeGate, "a fresh transport is created only after the enabled supported-route gate");
    assert.match(source, /function stalePlannerRouteResult\(\)/);
    assert.match(source, /operationGeneration === plannerTransportGeneration && !destroyed \? result : stalePlannerRouteResult\(\)/, "late success cannot become a stale completion/UI effect");
    assert.match(source, /plannerTaskTransport = null;\s*plannerPageTransport = null;/, "route disposal cannot leave a stale transport reusable");
});

test("same-route todo refetches are bounded by the route revalidation window", () => {
    assert.match(routeSource, /TODO_ROUTE_REVALIDATE_MS/);
    const constant = source.match(/const TODO_ROUTE_REVALIDATE_MS = (\d+);/);
    assert.ok(constant, "the revalidation window constant is defined");
    assert.ok(Number(constant[1]) > 0, "the revalidation window is positive");
    const schedules = Array.from(routeSource.matchAll(/schedule\("route"\)/g)).length;
    assert.equal(schedules, 3, "route refetch happens only via fallback, stale revalidation, or a failed in-place paint");
});

test("todo retries a delayed Canvas rail anchor with a capped readiness handoff", () => {
    assert.match(source, /const TODO_RAIL_READY_ATTEMPTS = 20;/);
    assert.match(source, /const TODO_RAIL_READY_DELAY_MS = 100;/);
    const ensureRail = extractFunction("ensureRail");
    assert.match(ensureRail, /if \(!target\) \{\s*railDiagnostic = placementFailureReason\(\);\s*removeRail\(\);\s*scheduleRailReadiness\("canvas-anchor"\);/, "a cards-first or rail-later Canvas commit requests bounded retry with an observable reason");
    const retry = extractFunction("scheduleRailReadiness");
    assert.match(retry, /railReadyAttempts >= TODO_RAIL_READY_ATTEMPTS/, "the retry cannot become an infinite observer/poll");
    assert.match(retry, /if \(lastView\) \{\s*try \{ render\(\{ \.\.\.lastView, courses: displayedRailCourses\(\) \}\);/, "a route return remounts the real prior view without fabricating data");
    const settingsChanged = source.slice(source.indexOf("function settingsChanged()"), source.indexOf("function pause(reason = \"pause\")"));
    assert.match(settingsChanged, /if \(!enabled\(\)\) \{\s*railDiagnostic = "todo-disabled";\s*clearRailReadiness\(\);/, "disabled To-Do records its unmounted reason and cancels readiness");
    assert.match(source, /function pause\(reason = "pause"\) \{\s*clearRailReadiness\(\);/, "full reload and lifecycle pause cancel readiness");
});

test("todo retries a transient Canvas binding miss with a separate capped handoff", () => {
    assert.match(source, /const TODO_BINDING_READY_ATTEMPTS = 20;/);
    assert.match(source, /const TODO_BINDING_READY_DELAY_MS = 250;/);
    const retry = extractFunction("scheduleBindingReadiness");
    assert.match(retry, /bindingReadyAttempts >= TODO_BINDING_READY_ATTEMPTS/, "binding retry is bounded independently of Canvas anchor readiness");
    assert.match(retry, /refresh\("canvas-binding-retry"\)/, "a later verified context restarts the real refresh path");
    const refresh = extractFunction("refresh");
    assert.match(refresh, /railDiagnostic = "binding-unavailable";\s*removeRail\(\);\s*scheduleBindingReadiness\(\);/, "a temporary binding miss removes unverified UI and schedules recovery");
    assert.match(refresh, /clearBindingReadiness\(\);/, "a verified binding cancels the pending recovery timer");
});

test("todo placement uses dashboard cards only for the dashboard's medium composition", () => {
    const cards = { id: "cards" };
    const rail = { id: "right-side" };

    assert.equal(placementFor({ path: "/", width: 767, cards, rail }).host, rail, "narrow dashboard retains Canvas's rail anchor");
    [768, 900, 1100].forEach((width) => {
        const target = placementFor({ path: "/", width, cards, rail });
        assert.equal(target.host, cards, `dashboard ${width}px stays below its course cards`);
        assert.equal(target.value, "below-course-cards");
    });
    assert.equal(placementFor({ path: "/", width: 1101, cards, rail }).host, rail, "wide dashboard returns to Canvas's rail anchor");
    assert.equal(placementFor({ path: "/", width: 900, rail }), null, "a medium dashboard waits for its required card anchor instead of moving into a different composition");
});

test("todo placement keeps every supported course route in its native right-side rail across responsive changes", () => {
    const cards = { id: "stale-dashboard-cards" };
    const rail = { id: "right-side" };
    ["/courses", "/courses/42", "/courses/42/assignments"].forEach((route) => {
        [767, 768, 900, 1100, 1101].forEach((width) => {
            const target = placementFor({ path: route, width, cards, rail });
            assert.equal(target.host, rail, `${route} at ${width}px never requests dashboard cards`);
            assert.equal(target.value, "right-rail");
            assert.equal(target.native, rail);
        });
    });
});

test("todo placement recovers delayed route-specific anchors without a fallback mount or rail churn", () => {
    const cards = { id: "cards" };
    const rail = { id: "right-side" };

    assert.equal(placementFor({ path: "/", width: 900, rail }), null, "dashboard waits while cards are delayed");
    assert.equal(placementFor({ path: "/", width: 900, cards, rail }).host, cards, "dashboard mounts once its card anchor arrives");
    assert.equal(placementFor({ path: "/courses/42", width: 900 }), null, "course waits while its native rail is delayed");
    assert.equal(placementFor({ path: "/courses/42", width: 900, cards, rail }).host, rail, "course mounts into its arriving native rail, not stale cards");

    const ensureRail = extractFunction("ensureRail");
    assert.match(ensureRail, /target\.ownedHost \? railHost !== target\.host : railHost\?\.parentNode !== target\.host/, "a changed owned fallback host or legacy placement remounts the rail");
    assert.equal((ensureRail.match(/target\.host\.appendChild\(railHost\)/g) || []).length, 1, "one guarded append path prevents duplicate hosts");
});

test("todo placement lifecycle retains disable/enable cleanup and bounded horizontal sizing", () => {
    const settingsChanged = source.slice(source.indexOf("function settingsChanged()"), source.indexOf("function pause(reason = \"pause\")"));
    assert.match(settingsChanged, /if \(!enabled\(\)\) \{\s*railDiagnostic = "todo-disabled";\s*clearRailReadiness\(\);[\s\S]*?removeRail\(\);/, "disable records its reason, cancels retries, and removes the owned rail before a later enable refresh");
    assert.match(settingsChanged, /institutionLogo\.apply\(settings\(\)\.todo_institution_logo_visible === true\);\s*schedule\("settings"\);/, "enable applies the saved logo preference before one normal refresh");
    assert.match(todoCss, /\[data-apstudycanvas-owned="todo-right-rail-host"\][\s\S]*?inline-size:\s*100%;[\s\S]*?max-inline-size:\s*100%;[\s\S]*?min-inline-size:\s*0;/, "each responsive host remains constrained to its Canvas column");
    assert.match(todoCss, /\.apstudy-todo-right-rail\s*\{[\s\S]*?inline-size:\s*min\(100%, 380px\);[\s\S]*?max-inline-size:\s*100%;[\s\S]*?min-width:\s*0;/, "the rail itself cannot create horizontal overflow at narrow widths or 200% zoom");
});

test("Dashboard native To Do fallback is semantic, sibling-only, and never captured as native rail", () => {
    const placement = extractFunction("placement");
    const nativeRegion = extractFunction("dashboardNativeTodoRegion");
    const regionVerifier = extractFunction("nativeTodoRegionOwnsList");
    const fallbackHost = extractFunction("dashboardNativeTodoHost");
    assert.match(placement, /if \(railTarget\) return \{ host: railTarget, value: "right-rail", native: railTarget \};/, "the legacy rail remains the first wide-Dashboard choice");
    assert.match(placement, /if \(!dashboard\) return null;/, "course routes cannot fall through to Dashboard placement");
    assert.match(placement, /value: "dashboard-native-todo-adjacent", native: null, ownedHost: true/, "fallback explicitly declines native capture so Canvas nodes cannot be hidden");
    assert.match(nativeRegion, /depth < 5/, "semantic discovery is bounded and never climbs to the document root");
    assert.match(nativeRegion, /candidate === document\.body \|\| candidate === document\.documentElement/, "body and document roots are rejected as placement regions");
    assert.match(regionVerifier, /#planner-todosidebar-item-list/, "the region verifier requires Canvas's exact native To Do list identity");
    assert.match(regionVerifier, /to do/, "the semantic fallback requires a visible To Do heading");
    assert.match(fallbackHost, /parent === document\.body \|\| parent === document\.documentElement/, "the new sibling can never be appended to body or document root");
    assert.match(fallbackHost, /parent\.insertBefore\(host, next\)/, "the owned wrapper is inserted immediately after the verified native region");
});

test("Todo runtime exposes non-private mounting diagnostics", () => {
    assert.match(source, /let railDiagnostic = "missing-anchor";/);
    ["todo-disabled", "unsupported-route", "missing-anchor", "missing-cards-anchor", "binding-unavailable", "mounted"].forEach((reason) => assert.match(source, new RegExp(`"${reason}"`), reason));
    assert.match(source, /getState: \(\) => \(\{ binding, placement: railPlacement, mounted: railMounted, reason: railDiagnostic \}\)/, "runtime state returns only structural placement diagnostics");
});
