(function (root, factory) {
    "use strict";
    const api = factory();
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasContent = Object.assign(root.APStudyCanvasContent || {}, { GradeOverview: api });
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    // Read-only summary of the native global /grades page. There is no fetch,
    // storage, or Canvas-write capability anywhere in this module: it only
    // parses the courses Canvas already printed on the page the student sees.
    const ROOT_CLASS = "apstudy-grade-overview";
    const MAX_COURSES = 100;
    const COURSE_GRADES_HREF = /^\/courses\/(\d+)\/grades(?:\/(\d+))?\/?$/;
    const SCORE_TEXT = /^(\d{1,3}(?:\.\d+)?)\s*%$/;
    const MAX_TITLE = 160;

    function childElements(node) { return Array.from(node?.children || []); }
    function textOf(node) { return typeof node?.textContent === "string" ? node.textContent.replace(/\s+/g, " ").trim() : ""; }
    function displayText(value, fallback) { const cleaned = typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, MAX_TITLE) : ""; return cleaned || fallback; }
    function hasOwnedAncestor(node) { let current = node; while (current) { if (current?.dataset?.apstudycanvasOwned === "true") return true; current = current.parentElement; } return false; }
    function containsNode(ancestor, node) { let current = node; while (current) { if (current === ancestor) return true; current = current.parentElement; } return false; }
    function ancestorWithTagName(node, tagNames) { let current = node?.parentElement; while (current) { if (tagNames.includes(current.tagName)) return current; current = current.parentElement; } return null; }
    function freeze(value) { if (Array.isArray(value)) value.forEach(freeze); else if (value && typeof value === "object") Object.values(value).forEach(freeze); return Object.freeze(value); }

    function parseGlobalGradeRows(root) {
        if (!root?.children) return freeze({ rows: [], truncated: false });
        const anchors = [];
        (function walk(node) { childElements(node).forEach((child) => { if (child.tagName === "A") anchors.push(child); else walk(child); }); })(root);
        const matched = [];
        const seen = new Set();
        anchors.forEach((anchor) => {
            if (!anchor || hasOwnedAncestor(anchor)) return;
            const match = COURSE_GRADES_HREF.exec(String(anchor.getAttribute?.("href") || ""));
            if (!match) return;
            const courseId = match[1];
            if (seen.has(courseId)) return;
            seen.add(courseId);
            const row = ancestorWithTagName(anchor, ["TR", "LI"]);
            const cells = row ? childElements(row).filter((cell) => cell.tagName === "TD" || cell.tagName === "TH") : [];
            const linkCell = cells.find((cell) => containsNode(cell, anchor)) || null;
            let score = null; let scoreLabel = "";
            for (const cell of cells) {
                if (cell === linkCell) continue;
                const parsed = SCORE_TEXT.exec(textOf(cell));
                if (parsed) {
                    const value = Number(parsed[1]);
                    if (Number.isFinite(value) && value >= 0 && value <= 1000) { score = value; scoreLabel = textOf(cell); break; }
                }
            }
            matched.push({ courseId, title: displayText(anchor.textContent, `Course ${courseId}`), score, scoreLabel });
        });
        const truncated = matched.length > MAX_COURSES;
        return freeze({ rows: matched.slice(0, MAX_COURSES), truncated });
    }

    function summarizeGradeOverview(rows, { bounds = null, letterFor = null, truncated = false } = {}) {
        const source = Array.isArray(rows) ? rows : [];
        const summarized = source.slice(0, MAX_COURSES).map((row) => {
            const score = Number.isFinite(row?.score) ? row.score : null;
            const letter = score !== null && typeof letterFor === "function" ? letterFor(score, bounds) ?? null : null;
            return { courseId: String(row?.courseId || ""), title: displayText(row?.title, `Course ${row?.courseId || ""}`), score, scoreLabel: typeof row?.scoreLabel === "string" ? row.scoreLabel : "", letter };
        });
        const scored = summarized.filter((row) => row.score !== null);
        return freeze({
            courses: summarized.length,
            scored: scored.length,
            unavailable: summarized.length - scored.length,
            rows: summarized,
            truncated: truncated === true
        });
    }

    function summaryLine(summary) {
        if (!summary || !summary.courses) return "Canvas lists no courses on this page yet.";
        const parts = [`${summary.scored} of ${summary.courses} course${summary.courses === 1 ? " reports" : "s report"} a score.`];
        if (summary.unavailable) parts.push(`${summary.unavailable} course${summary.unavailable === 1 ? " has" : "s have"} no score on this page.`);
        if (summary.truncated) parts.push(`Showing the first ${MAX_COURSES} courses Canvas lists.`);
        return parts.join(" ");
    }

    function element(doc, tag, className, value) {
        const node = doc.createElement(tag);
        if (className) node.className = className;
        if (value !== undefined) node.textContent = String(value);
        return node;
    }
    function append(parent, ...children) { parent.append(...children.filter(Boolean)); }

    function createGradeOverviewUI({ document: doc = globalThis.document } = {}) {
        let root = null; let content = null; let host = null; let state = "loading"; let summary = null; let onRetry = null; let mounted = false; let generation = 0;
        function retryButton() {
            const node = element(doc, "button", "apstudy-grade-overview__button", "Try again");
            node.type = "button"; node.dataset.action = "retry"; node.dataset.focusKey = "retry"; return node;
        }
        function render() {
            if (!content) return;
            content.replaceChildren();
            const title = element(doc, "h2", "apstudy-grade-overview__title", "Grade overview"); title.id = "apstudy-grade-overview-title";
            const disclosure = element(doc, "p", "apstudy-grade-overview__disclosure", "A local summary of the courses Canvas lists on this page. Scores come from Canvas itself; letter estimates use APStudy's GPA scale. The native Grades list below stays unchanged.");
            append(content, title, disclosure);
            if (state === "loading") {
                const loading = element(doc, "p", "apstudy-grade-overview__state", "Reading the courses Canvas lists on this page…");
                loading.setAttribute("role", "status"); append(content, loading); return;
            }
            if (state === "empty") {
                const empty = element(doc, "p", "apstudy-grade-overview__state", "Canvas lists no course grades here yet. The native Grades page below stays unchanged.");
                empty.setAttribute("role", "status"); append(content, empty, typeof onRetry === "function" ? retryButton() : null); return;
            }
            if (!summary || !summary.courses) { append(content, element(doc, "p", "apstudy-grade-overview__state", "Canvas lists no course grades here yet.")); return; }
            append(content, element(doc, "p", "apstudy-grade-overview__summary", summaryLine(summary)));
            const tableWrap = element(doc, "div", "apstudy-grade-overview__table-wrap");
            const table = element(doc, "table", "apstudy-grade-overview__table");
            const caption = element(doc, "caption", "", "Text equivalent: courses Canvas lists on this page");
            const head = doc.createElement("thead"); const headRow = doc.createElement("tr");
            ["Course", "Score", "Letter estimate"].forEach((heading) => { const cell = element(doc, "th", "", heading); cell.setAttribute("scope", "col"); append(headRow, cell); });
            head.append(headRow);
            const body = doc.createElement("tbody");
            summary.rows.forEach((row) => {
                const tr = doc.createElement("tr");
                const course = element(doc, "td", "apstudy-grade-overview__course");
                const link = doc.createElement("a"); link.className = "apstudy-grade-overview__link"; link.textContent = row.title;
                link.setAttribute("href", `/courses/${encodeURIComponent(row.courseId)}/grades`);
                course.append(link);
                const score = element(doc, "td", "", row.scoreLabel || "No score on this page"); score.dataset.state = row.scoreLabel ? "scored" : "unavailable";
                tr.append(course, score, element(doc, "td", "", row.letter || "—")); body.append(tr);
            });
            table.append(caption, head, body); tableWrap.append(table); content.append(tableWrap);
        }
        function adopt(input) {
            if (input?.state) state = input.state;
            if (input?.summary !== undefined) summary = input.summary || null;
            // An explicit onRetry key always wins, including null: a stale
            // retry closure from a previous lifecycle phase must not survive
            // into a state that no longer owns a retry action.
            if (input && Object.prototype.hasOwnProperty.call(input, "onRetry")) {
                onRetry = typeof input.onRetry === "function" ? input.onRetry : null;
            }
        }
        function mount(container, input = {}) {
            if (!container?.append || !doc?.createElement) return false;
            generation += 1; host = container; adopt(input);
            if (!root) {
                root = element(doc, "section", ROOT_CLASS); content = element(doc, "div", "apstudy-grade-overview__content");
                root.dataset.apstudycanvasOwned = "true"; root.setAttribute("aria-labelledby", "apstudy-grade-overview-title");
                root.addEventListener("click", (event) => { if (event.target?.dataset?.action === "retry") { try { onRetry?.(); } catch (error) {} } });
                root.append(content);
            }
            if (root.parentElement !== host) {
                if (typeof host.insertBefore === "function") host.insertBefore(root, host.firstChild ?? null);
                else host.append(root);
            }
            mounted = true; render(); return true;
        }
        function update(input = {}) { if (!mounted) return false; adopt(input); render(); return true; }
        function destroy() { generation += 1; mounted = false; root?.remove?.(); root = content = host = null; state = "loading"; summary = null; onRetry = null; }
        function isAttached() { return Boolean(mounted && root?.parentElement === host && (typeof root.isConnected !== "boolean" || root.isConnected)); }
        return Object.freeze({ mount, update, destroy, isMounted: () => mounted, isAttached, generation: () => generation, MAX_COURSES, ROOT_CLASS });
    }

    return Object.freeze({ ROOT_CLASS, MAX_COURSES, parseGlobalGradeRows, summarizeGradeOverview, summaryLine, createGradeOverviewUI });
}));
