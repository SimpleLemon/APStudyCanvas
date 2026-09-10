(function (root, factory) {
    "use strict";
    const api = factory();
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasContent = Object.assign(root.APStudyCanvasContent || {}, { CardAppearance: api });
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    // Canvas builds the dashboard long after the document starts: React fetches
    // the card set, then inserts .ic-DashboardCard nodes in its own tasks. The
    // lifecycle hydrate path coalesces mutations through a debounce timer, so
    // one or more frames paint untouched cards first — hidden courses visibly
    // pop away and custom card art pops in late. This watcher closes that gap:
    // it observes card insertions and invokes the card customizer inside the
    // mutation microtask, which the browser always runs before painting, so
    // modifications land in the same frame as the cards themselves.
    function createCardAppearance({
        document: doc = globalThis.document,
        cardSelector = ".ic-DashboardCard",
        apply = () => {},
        mutationObserver: MutationObserverClass = globalThis.MutationObserver
    } = {}) {
        let observer = null;
        let started = false;
        let seenCards = null;
        let applying = false;

        function cardNodes() {
            if (!doc?.querySelectorAll) return [];
            try { return Array.from(doc.querySelectorAll(cardSelector) || []); } catch (error) { return []; }
        }

        function applyCards(reason) {
            if (applying) return;
            applying = true;
            try { apply(reason); } catch (error) {} finally { applying = false; }
        }

        function scan() {
            const cards = cardNodes();
            if (!cards.length) return;
            const seen = seenCards || (seenCards = new WeakSet());
            if (!cards.some((card) => !seen.has(card))) return;
            cards.forEach((card) => seen.add(card));
            applyCards("card-insertion");
        }

        function onMutations(records) {
            if (!started) return;
            // Style and text writes are handled inside apply; only an actual
            // insertion can bring a card this watcher has not styled yet.
            if (!Array.isArray(records) || !records.some((record) => (record?.addedNodes?.length || 0) > 0)) return;
            scan();
        }

        function start() {
            if (started) return;
            started = true;
            if (typeof MutationObserverClass !== "function") {
                scan();
                return;
            }
            observer = new MutationObserverClass(onMutations);
            observer.observe(doc?.documentElement || doc, { childList: true, subtree: true });
            // Cards can already be in the DOM when the watcher starts (late
            // injection, or settings resolving after Canvas painted).
            scan();
        }

        function stop() {
            observer?.disconnect?.();
            observer = null;
            started = false;
        }

        function reset() {
            seenCards = null;
        }

        return Object.freeze({ start, stop, scan, reset, isStarted: () => started });
    }

    function canvasCourseLocation(value, origin) {
        if (typeof origin !== "string" || !origin) return null;
        let url;
        try { url = new URL(String(value || ""), origin); } catch (error) { return null; }
        if (url.origin !== origin || url.username || url.password) return null;
        const match = url.pathname.match(/^\/courses\/(\d+)(?:\/(assignments|grades)(?:\/(\d+)(?:\/submissions\/\d+)?)?)?\/?$/);
        if (!match) return null;
        return Object.freeze({
            href: url.href,
            courseId: match[1],
            section: match[2] || "course",
            assignmentId: match[3] || null
        });
    }

    // Planner payloads are not trusted as navigation authority. A card can
    // only point within the course represented by that dashboard card.
    function sameCourseCanvasLocation(value, { origin, courseId, section } = {}) {
        const location = canvasCourseLocation(value, origin);
        if (!location || String(location.courseId) !== String(courseId || "")) return null;
        if (section && location.section !== section) return null;
        return location;
    }

    function courseDestination(origin, courseId, section) {
        const safeId = String(courseId || "").trim();
        if (!/^\d+$/.test(safeId) || !["assignments", "grades"].includes(section)) return null;
        return sameCourseCanvasLocation(`${origin}/courses/${safeId}/${section}`, { origin, courseId: safeId, section });
    }

    function submissionAssignmentDestination(value, origin) {
        const location = canvasCourseLocation(value, origin);
        if (!location || location.section !== "assignments" || !location.assignmentId) return null;
        const path = new URL(location.href).pathname;
        if (!/^\/courses\/\d+\/assignments\/\d+\/submissions\/\d+\/?$/.test(path)) return null;
        return sameCourseCanvasLocation(`${origin}/courses/${location.courseId}/assignments/${location.assignmentId}`, {
            origin,
            courseId: location.courseId,
            section: "assignments"
        });
    }

    // Canvas renders dashboard cards in multiple React commits. It can insert
    // a card shell before its course anchor, then replace that anchor while
    // hydrating. Treat the anchor as optional and untrusted. A dashboard card
    // only represents a course root, so other Canvas routes fail closed.
    function dashboardCardDestination(card, origin) {
        const anchor = card?.querySelector?.(".ic-DashboardCard__link") || null;
        const rawHref = anchor?.getAttribute?.("href") || anchor?.href || "";
        const location = canvasCourseLocation(rawHref, origin);
        return location?.section === "course" ? location : null;
    }

    function resolveLetterGrade(value, bounds, gpaApi) {
        const score = typeof value === "number" ? value : Number.parseFloat(String(value ?? "").trim());
        if (!Number.isFinite(score) || typeof gpaApi?.computeGpa !== "function") return null;
        const result = gpaApi.computeGpa({
            courses: [{ weight: "regular", credits: 1, grade: score }],
            bounds,
            weighted: false,
            cumulative: null
        });
        const course = result?.courses?.[0];
        return course?.counted === true && typeof course.letter === "string" ? course.letter : null;
    }

    return Object.freeze({
        createCardAppearance,
        canvasCourseLocation,
        sameCourseCanvasLocation,
        courseDestination,
        submissionAssignmentDestination,
        dashboardCardDestination,
        resolveLetterGrade
    });
}));
