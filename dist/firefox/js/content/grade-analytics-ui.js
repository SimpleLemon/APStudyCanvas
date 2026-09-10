(function (root, factory) {
    "use strict";
    const api = factory(root?.APStudyCanvasContent?.GradeAnalytics);
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasContent = Object.assign(root.APStudyCanvasContent || {}, { GradeAnalyticsUI: api });
}(typeof globalThis !== "undefined" ? globalThis : this, function (defaultDomain) {
    "use strict";

    const ROOT_CLASS = "apstudy-grade-analytics";
    const MAX_RENDERED_ROWS = 100;
    const PERFORMANCE_BUDGETS = Object.freeze({ initialMountMs: 50, taskRender200Ms: 100 });
    const EMPTY = "—";
    const safeNumber = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
    const percent = (value) => Number.isFinite(value) ? `${value.toFixed(1)}%` : EMPTY;
    const text = (value, fallback = "") => typeof value === "string" && value.trim() ? value.trim() : fallback;
    const append = (parent, ...children) => parent.append(...children.filter(Boolean));

    function element(doc, tag, className, value) {
        const node = doc.createElement(tag);
        if (className) node.className = className;
        if (value !== undefined) node.textContent = String(value);
        return node;
    }
    function button(doc, label, action, className = "", focusKey = "") {
        const node = element(doc, "button", `apstudy-grade-analytics__button ${className}`.trim(), label);
        node.type = "button"; node.dataset.action = action; if (focusKey) node.dataset.focusKey = focusKey; return node;
    }
    function field(doc, label, value, action, options = {}) {
        const wrap = element(doc, "label", "apstudy-grade-analytics__field");
        const title = element(doc, "span", "apstudy-grade-analytics__field-label", label);
        const input = doc.createElement(options.select ? "select" : "input");
        input.dataset.action = action; if (options.focusKey) input.dataset.focusKey = options.focusKey;
        input.name = action;
        if (options.select) {
            options.values.forEach(({ value: optionValue, label }) => { const option = doc.createElement("option"); option.value = optionValue; option.textContent = label; if (optionValue === String(value ?? "")) option.selected = true; input.append(option); });
        } else { input.type = options.type || "number"; input.inputMode = "decimal"; input.step = "any"; input.value = value ?? ""; if (options.min !== undefined) input.min = String(options.min); }
        append(wrap, title, input); return wrap;
    }
    function table(doc, caption, headings, rows) {
        const wrap = element(doc, "div", "apstudy-grade-analytics__table-wrap");
        const node = element(doc, "table", "apstudy-grade-analytics__table");
        const cap = element(doc, "caption", "", caption); const head = doc.createElement("thead"); const headRow = doc.createElement("tr");
        headings.forEach((heading) => append(headRow, element(doc, "th", "", heading)));
        head.append(headRow); const body = doc.createElement("tbody");
        rows.forEach((cells) => { const row = doc.createElement("tr"); cells.forEach((cell) => { const bodyCell = element(doc, "td", "", cell); append(row, bodyCell); }); append(body, row); });
        append(node, cap, head, body); append(wrap, node); return wrap;
    }
    function statusMessage(overview) {
        const parts = [];
        if (overview.hidden) parts.push(`${overview.hidden} hidden`);
        if (overview.dropped) parts.push(`${overview.dropped} dropped`);
        if (overview.excused) parts.push(`${overview.excused} excused`);
        if (overview.ungraded) parts.push(`${overview.ungraded} ungraded`);
        if (overview.missing) parts.push(`${overview.missing} missing`);
        return parts.length ? `${parts.join(", ")} assignment${parts.length === 1 ? " is" : "s are"} excluded or estimated as shown.` : "All visible graded assignments are included.";
    }
    function createGradeAnalyticsUI({ document: doc = globalThis.document, domain = defaultDomain, now = () => globalThis.performance?.now?.() ?? Date.now() } = {}) {
        let root = null; let content = null; let liveRegion = null; let host = null; let source = null; let options = { bounds: null, zones: false }; let scenario = null; let state = "empty"; let error = ""; let retry = null; let mounted = false; let generation = 0; let lastAnnouncement = ""; let nextFocus = null;
        let metrics = { initialMountMs: null, lastRenderMs: null, renderCount: 0, renderedAssignments: 0 };
        const ids = { assignment: 0, group: 0 };
        const supported = () => Boolean(doc?.createElement && domain?.calculateAnalytics && domain?.createScenario);
        function result() { return source ? domain.calculateAnalytics(domain.materializeScenario(source, scenario), options) : null; }
        function estimateAnnouncement() {
            const overview = result()?.overview;
            return overview ? `Local estimate recalculated: ${percent(overview.score)}${overview.letter ? ` (${overview.letter})` : ""}, ${overview.counted} counted assignment${overview.counted === 1 ? "" : "s"}.` : "";
        }
        function updateScenario(next, focusKey = null) {
            scenario = next; state = "ready"; error = ""; nextFocus = focusKey || nextFocus;
            const announcement = estimateAnnouncement();
            if (announcement && announcement !== lastAnnouncement) { liveRegion.textContent = announcement; lastAnnouncement = announcement; }
            renderState();
        }
        function titleFor(row) { return text(row?.title, "Untitled assignment"); }
        function focusSnapshot() {
            const active = doc?.activeElement;
            if (!active?.dataset?.focusKey || !root?.contains?.(active)) return null;
            return { key: active.dataset.focusKey, start: active.selectionStart, end: active.selectionEnd };
        }
        function restoreFocus(snapshot) {
            const desired = nextFocus || snapshot?.key; nextFocus = null;
            if (!desired) return;
            const target = content?.querySelector?.(`[data-focus-key="${desired}"]`);
            if (!target?.focus) return;
            target.focus();
            if (snapshot?.key === desired && Number.isFinite(snapshot.start) && typeof target.setSelectionRange === "function") target.setSelectionRange(snapshot.start, Number.isFinite(snapshot.end) ? snapshot.end : snapshot.start);
        }
        function renderState() {
            const before = now(); const snapshot = focusSnapshot(); content.replaceChildren();
            const heading = element(doc, "h2", "apstudy-grade-analytics__title", "Grade analytics"); heading.id = "apstudy-grade-analytics-title";
            const notice = element(doc, "p", "apstudy-grade-analytics__disclosure", "Estimates use the grades currently available in Canvas. APStudy never writes Canvas grades, assignments, groups, or submissions.");
            append(content, heading, notice);
            if (state === "loading") { const loading = element(doc, "p", "apstudy-grade-analytics__state", "Loading grade estimates…"); loading.setAttribute("role", "status"); append(content, loading); return finishRender(before, snapshot); }
            if (state === "error") { const message = element(doc, "p", "apstudy-grade-analytics__state apstudy-grade-analytics__state--error", error || "Grade estimates could not load. Canvas remains unchanged."); message.setAttribute("role", "alert"); append(content, message, typeof retry === "function" ? button(doc, "Try again", "retry", "apstudy-grade-analytics__button--quiet", "retry") : null); return finishRender(before, snapshot); }
            if (!source) { append(content, element(doc, "p", "apstudy-grade-analytics__state", "No grade data is available for this course yet.")); return finishRender(before, snapshot); }
            const data = result(); const overview = data.overview;
            if (!overview.counted) { append(content, element(doc, "p", "apstudy-grade-analytics__state", "There are no visible graded assignments to estimate yet. Ungraded, hidden, dropped, and excused work stays out of the estimate.")); }
            const overviewSection = element(doc, "section", "apstudy-grade-analytics__overview"); overviewSection.setAttribute("aria-labelledby", "apstudy-grade-overview"); const overviewHeading = element(doc, "h3", "", "Overview"); overviewHeading.id = "apstudy-grade-overview";
            const score = element(doc, "p", "apstudy-grade-analytics__score", percent(overview.score)); score.dataset.zone = overview.zone || "unknown";
            const details = element(doc, "p", "apstudy-grade-analytics__details", `${overview.letter || "No letter scale"} · ${overview.method === "weighted-groups" ? "weighted groups" : "total points"} · ${overview.counted} counted`);
            const totals = element(doc, "p", "apstudy-grade-analytics__details", `${Number.isFinite(overview.earned) ? overview.earned.toFixed(1) : EMPTY} earned of ${Number.isFinite(overview.possible) ? overview.possible.toFixed(1) : EMPTY} possible`);
            const status = element(doc, "p", "apstudy-grade-analytics__details", statusMessage(overview));
            if (scenario.pinnedFinal) append(overviewSection, element(doc, "p", "apstudy-grade-analytics__pin", `Pinned local estimate: ${percent(scenario.pinnedFinal.score)}${scenario.pinnedFinal.letter ? ` (${scenario.pinnedFinal.letter})` : ""}.`));
            append(overviewSection, overviewHeading, score, details, totals, status); append(content, overviewSection);
            renderDistribution(data); renderHistory(data); renderScenario(data);
            finishRender(before, snapshot);
        }
        function finishRender(before, snapshot) { metrics = { ...metrics, lastRenderMs: Math.max(0, now() - before), renderCount: metrics.renderCount + 1, renderedAssignments: Math.min(result()?.source.assignments.length || 0, MAX_RENDERED_ROWS) }; restoreFocus(snapshot); }
        function renderDistribution(data) {
            const section = element(doc, "section", "apstudy-grade-analytics__section"); const heading = element(doc, "h3", "", "Assignment distribution"); heading.id = "apstudy-grade-distribution"; section.setAttribute("aria-labelledby", heading.id); append(section, heading);
            if (!data.distribution.length) append(section, element(doc, "p", "apstudy-grade-analytics__details", "No graded assignments are available for a distribution yet."));
            else {
                const total = data.distribution.reduce((sum, row) => sum + row.count, 0);
                const colours = ["#176b4d", "#0a4b78", "#7a4b00", "#a12622", "#5b4b8a"];
                let cursor = 0;
                const slices = data.distribution.map((row, index) => { const start = cursor; cursor += (row.count / total) * 100; return `${colours[index % colours.length]} ${start}% ${cursor}%`; });
                const pie = element(doc, "div", "apstudy-grade-analytics__pie"); pie.style.setProperty("--apstudy-grade-pie", `conic-gradient(${slices.join(",")})`); pie.setAttribute("role", "img"); pie.setAttribute("aria-label", `Assignment distribution: ${data.distribution.map((row) => `${row.letter}, ${row.count}`).join("; ")}`);
                const chart = element(doc, "ul", "apstudy-grade-analytics__distribution"); chart.setAttribute("aria-label", "Assignment grade distribution");
                data.distribution.forEach((row) => { const item = element(doc, "li", "apstudy-grade-analytics__distribution-item"); item.dataset.zone = row.letter.startsWith("A") ? "excellent" : row.letter.startsWith("B") ? "strong" : row.letter.startsWith("C") ? "watch" : "at-risk"; const label = element(doc, "span", "", `${row.letter}: ${row.count}`); const fill = element(doc, "span", "apstudy-grade-analytics__distribution-fill"); fill.style.setProperty("--apstudy-grade-share", `${Math.max(2, (row.count / total) * 100)}%`); fill.setAttribute("aria-hidden", "true"); append(item, label, fill); append(chart, item); });
                append(section, pie, chart, table(doc, "Text equivalent: assignment distribution", ["Grade", "Assignments"], data.distribution.map((row) => [row.letter, String(row.count)])));
            } append(content, section);
        }
        function renderHistory(data) {
            const section = element(doc, "section", "apstudy-grade-analytics__section"); const heading = element(doc, "h3", "", "History and recent trend"); heading.id = "apstudy-grade-history"; section.setAttribute("aria-labelledby", heading.id);
            const recent = data.lastFive.length ? data.lastFive.map((row) => `${titleFor(row)} ${percent(row.score)}`).join("; ") : "No graded assignments yet.";
            append(section, heading, element(doc, "p", "apstudy-grade-analytics__details", `Last five: ${recent}`));
            const heatmap = element(doc, "ul", "apstudy-grade-analytics__heatmap"); heatmap.setAttribute("aria-label", "Grade heatmap, with assignment names and scores");
            data.heatmap.slice(0, MAX_RENDERED_ROWS).forEach((row) => { const cell = element(doc, "li", "apstudy-grade-analytics__heatmap-cell", percent(row.score)); const label = `${row.label}${row.zone ? ` — ${row.zone} zone` : ""}`; cell.dataset.zone = row.zone || "unknown"; cell.setAttribute("aria-label", label); cell.title = label; append(heatmap, cell); }); append(section, heatmap);
            const visible = data.history.slice(0, MAX_RENDERED_ROWS); append(section, table(doc, "Text equivalent: assignment history", ["Assignment", "Due", "Score", "Running score", "Grade"], visible.map((row) => [titleFor(row), row.dueAt ? new Date(row.dueAt).toLocaleDateString() : "No due date", percent(row.score), percent(row.runningScore), row.letter || "Unscaled"])));
            if (data.history.length > visible.length) append(section, element(doc, "p", "apstudy-grade-analytics__details", `Showing the first ${MAX_RENDERED_ROWS} of ${data.history.length} graded assignments to keep this page responsive.`));
            append(content, section);
        }
        function renderScenario(data) {
            const section = element(doc, "section", "apstudy-grade-analytics__scenario"); const heading = element(doc, "h3", "", "Imagine-If calculator"); heading.id = "apstudy-grade-scenario"; section.setAttribute("aria-labelledby", heading.id);
            const local = element(doc, "p", "apstudy-grade-analytics__sandbox", "Local, nonpersistent sandbox. Changes exist only until this grade page closes or refreshes and never write to Canvas.");
            const actions = element(doc, "div", "apstudy-grade-analytics__actions"); append(actions, button(doc, "Pin local estimate", "pin", "", "pin"), button(doc, "Reset local changes", "reset", "apstudy-grade-analytics__button--quiet", "reset"));
            append(section, heading, local, actions);
            const groups = result().source.groups.slice(0, MAX_RENDERED_ROWS); if (groups.length) { const groupHeading = element(doc, "h4", "", "Groups"); append(section, groupHeading); groups.forEach((group) => { const row = element(doc, "div", "apstudy-grade-analytics__editor-row"); row.dataset.groupId = group.id; const name = element(doc, "strong", "", group.name); const original = scenario.groups[group.id] || {}; append(row, name, field(doc, "Weight (%)", original.weight === undefined ? (Number.isFinite(group.weight) ? group.weight * 100 : "") : safeNumber(original.weight) * 100, "group-weight", { min: 0, focusKey: `group-weight:${group.id}` }), button(doc, "Remove group", "remove-group", "apstudy-grade-analytics__button--quiet", `remove-group:${group.id}`)); append(section, row); }); }
            const groupChoices = result().source.groups.map((group) => ({ value: group.id, label: group.name })); append(section, field(doc, "New group name", "", "new-group-name", { type: "text", focusKey: "new-group-name" }), field(doc, "New group weight (%)", "", "new-group-weight", { min: 0, focusKey: "new-group-weight" }), button(doc, "Add group", "add-group", "apstudy-grade-analytics__button--quiet", "add-group"));
            const assignmentHeading = element(doc, "h4", "", "Assignments"); append(section, assignmentHeading); result().source.assignments.slice(0, MAX_RENDERED_ROWS).forEach((assignment) => { const row = element(doc, "div", "apstudy-grade-analytics__editor-row"); row.dataset.assignmentId = assignment.id; const change = scenario.assignments[assignment.id] || {}; append(row, element(doc, "strong", "", titleFor(assignment)), field(doc, "Earned", change.score ?? assignment.score ?? "", "assignment-score", { focusKey: `assignment-score:${assignment.id}` }), field(doc, "Possible", change.pointsPossible ?? assignment.pointsPossible ?? "", "assignment-possible", { min: 0, focusKey: `assignment-possible:${assignment.id}` }), button(doc, "Remove assignment", "remove-assignment", "apstudy-grade-analytics__button--quiet", `remove-assignment:${assignment.id}`)); append(section, row); });
            append(section, field(doc, "New assignment name", "", "new-assignment-name", { type: "text", focusKey: "new-assignment-name" }), field(doc, "New assignment earned", "", "new-assignment-score", { focusKey: "new-assignment-score" }), field(doc, "New assignment possible", "", "new-assignment-possible", { min: 0, focusKey: "new-assignment-possible" }), field(doc, "New assignment group", groupChoices[0]?.value || "", "new-assignment-group", { select: true, values: [{ value: "", label: "No group" }, ...groupChoices], focusKey: "new-assignment-group" }), button(doc, "Add assignment", "add-assignment", "apstudy-grade-analytics__button--quiet", "add-assignment"));
            const finalHeading = element(doc, "h4", "", "Final-score estimate"); append(section, finalHeading, field(doc, "Final earned", scenario.final?.score ?? "", "final-score", { focusKey: "final-score" }), field(doc, "Final possible", scenario.final?.pointsPossible ?? "", "final-possible", { min: 0, focusKey: "final-possible" }), field(doc, "Final group", scenario.final?.groupId || "", "final-group", { select: true, values: [{ value: "", label: "No group" }, ...groupChoices], focusKey: "final-group" }), button(doc, "Update final estimate", "final", "apstudy-grade-analytics__button--quiet", "final"));
            append(content, section);
        }
        function find(action) { return root?.querySelector?.(`[data-action="${action}"]`); }
        function onInput(event) {
            const target = event.target; const action = target?.dataset?.action; const row = target?.closest?.("[data-assignment-id], [data-group-id]"); if (!action || !row) return;
            if (action === "assignment-score" || action === "assignment-possible") updateScenario(domain.scenarioAssignment(scenario, row.dataset.assignmentId, { [action === "assignment-score" ? "score" : "pointsPossible"]: safeNumber(target.value) }));
            if (action === "group-weight") { const value = safeNumber(target.value); updateScenario(domain.scenarioGroup(scenario, row.dataset.groupId, { weight: Number.isFinite(value) ? value / 100 : null })); }
        }
        function onClick(event) {
            const target = event.target?.closest?.("[data-action]"); if (!target) return; const action = target.dataset.action; const row = target.closest?.("[data-assignment-id], [data-group-id]");
            if (action === "retry") { try { retry?.(); } catch (error) {} }
            else if (action === "reset") updateScenario(domain.resetScenario(), "reset");
            else if (action === "pin") updateScenario(domain.pinFinalEstimate(source, scenario, options), "pin");
            else if (action === "remove-assignment" && row) updateScenario(domain.removeScenarioAssignment(scenario, row.dataset.assignmentId), "new-assignment-name");
            else if (action === "remove-group" && row) updateScenario(domain.removeScenarioGroup(scenario, row.dataset.groupId), "new-group-name");
            else if (action === "add-group") { const name = find("new-group-name")?.value; const weight = safeNumber(find("new-group-weight")?.value); if (text(name)) { ids.group += 1; const id = `local-group-${ids.group}`; updateScenario(domain.addScenarioGroup(scenario, { id, name: text(name), weight: Number.isFinite(weight) ? weight / 100 : null }), `group-weight:${id}`); } }
            else if (action === "add-assignment") { const title = text(find("new-assignment-name")?.value); const score = safeNumber(find("new-assignment-score")?.value); const possible = safeNumber(find("new-assignment-possible")?.value); if (title && Number.isFinite(score) && Number.isFinite(possible) && possible > 0) { ids.assignment += 1; const id = `local-assignment-${ids.assignment}`; updateScenario(domain.addScenarioAssignment(scenario, { id, title, score, pointsPossible: possible, groupId: find("new-assignment-group")?.value || null }), `assignment-score:${id}`); } }
            else if (action === "final") updateScenario(domain.setScenarioFinal(scenario, { score: safeNumber(find("final-score")?.value), pointsPossible: safeNumber(find("final-possible")?.value), groupId: find("final-group")?.value || null }), "final-score");
        }
        function mount(container, input = {}) {
            if (!supported() || !container?.append) return false; const before = now(); generation += 1; host = container; if (!root) { root = element(doc, "section", ROOT_CLASS); content = element(doc, "div", "apstudy-grade-analytics__content"); liveRegion = element(doc, "p", "apstudy-grade-analytics__live"); liveRegion.setAttribute("aria-live", "polite"); liveRegion.setAttribute("aria-atomic", "true"); liveRegion.setAttribute("role", "status"); root.dataset.apstudycanvasOwned = "true"; root.setAttribute("aria-labelledby", "apstudy-grade-analytics-title"); append(root, liveRegion, content); root.addEventListener("click", onClick); root.addEventListener("change", onInput); }
            const config = input && typeof input === "object" && ("source" in input || "state" in input || "error" in input || "onRetry" in input) ? input : { source: input };
            source = config.source || null; options = { bounds: config.bounds || null, zones: config.zones === true }; scenario = domain.createScenario(); state = config.state || (source ? "ready" : "empty"); error = text(config.error); retry = typeof config.onRetry === "function" ? config.onRetry : null; lastAnnouncement = ""; liveRegion.textContent = ""; if (root.parentElement !== host) host.append(root); mounted = true; renderState(); metrics = { ...metrics, initialMountMs: Math.max(0, now() - before) }; return true;
        }
        function update(input = {}) { if (!mounted) return false; const config = input && typeof input === "object" && ("source" in input || "state" in input || "error" in input || "onRetry" in input) ? input : { source: input }; if (config.source !== undefined) { source = config.source; scenario = domain.createScenario(); } if (config.bounds !== undefined) options.bounds = config.bounds; if (config.zones !== undefined) options.zones = config.zones === true; if (config.state) state = config.state; if (config.error !== undefined) error = text(config.error); if (config.onRetry !== undefined) retry = typeof config.onRetry === "function" ? config.onRetry : null; renderState(); return true; }
        function destroy() { generation += 1; mounted = false; root?.remove?.(); root = content = liveRegion = host = source = scenario = null; error = ""; retry = null; state = "empty"; lastAnnouncement = ""; nextFocus = null; }
        function isAttached() { return Boolean(mounted && root?.parentElement === host && (typeof root.isConnected !== "boolean" || root.isConnected)); }
        return Object.freeze({ mount, update, destroy, isMounted: () => mounted, isAttached, generation: () => generation, renderMetrics: () => Object.freeze({ ...metrics }), MAX_RENDERED_ROWS, PERFORMANCE_BUDGETS });
    }
    return Object.freeze({ ROOT_CLASS, MAX_RENDERED_ROWS, PERFORMANCE_BUDGETS, createGradeAnalyticsUI });
}));
