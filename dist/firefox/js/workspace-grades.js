(function (root, factory) {
    "use strict";
    const api = factory(root?.APStudyCanvasWorkspaceGradesDomain, root?.APStudyCanvasContent?.GradeAnalytics);
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasWorkspaceGradesUI = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function (defaultDomain, defaultAnalytics) {
    "use strict";

    /*
     * THESIS: grades are a legible evidence ledger, not a motivational dashboard or invented history.
     * OWN-WORLD: parchment rows, navy structure, gold focus, crisp rules, and mono measurements.
     * STORY: scan current truth, open one class, inspect assignments, then build or test one estimate.
     * FIRST VIEWPORT: term summary and course ledger; class views retain a breadcrumb and compact tabs.
     * FORM: established APStudyCanvas Operate surface shared unchanged by popup and native Canvas hosts.
     */

    const TABS = Object.freeze(["overview", "assignments", "graphs", "what-if"]);
    const TAB_LABELS = Object.freeze({ overview: "Overview", assignments: "Assignments", graphs: "Graphs", "what-if": "What-if" });
    const globalRoot = typeof globalThis !== "undefined" ? globalThis : null;

    function clone(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }
    function clean(value, max = 240) {
        return typeof value === "string" || typeof value === "number"
            ? String(value).replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, max)
            : "";
    }
    function finite(value) { const number = value === "" || value === null || value === undefined ? NaN : Number(value); return Number.isFinite(number) ? number : null; }
    function percent(value) { return Number.isFinite(value) ? `${value.toFixed(1)}%` : "Unavailable"; }
    function gpaValue(summary) {
        const value = summary?.cumulative ?? summary?.weighted ?? summary?.unweighted;
        return Number.isFinite(value) ? value.toFixed(2) : "—";
    }
    function routeIntent(route = {}) {
        const courseId = clean(route.courseId || route.course, 100) || null;
        const tab = TABS.includes(route.tab) ? route.tab : "overview";
        return { courseId, tab };
    }
    function classes(node) { return new Set(clean(node?.className, 1000).split(" ").filter(Boolean)); }
    function toggleClass(node, name, enabled) {
        const values = classes(node); if (enabled) values.add(name); else values.delete(name); node.className = [...values].join(" ");
    }
    function safeWorkspace(value) {
        const grades = value?.grades && typeof value.grades === "object" ? value.grades : { courses: {}, priorGpa: "", priorCredits: "" };
        return { ...(value && typeof value === "object" ? clone(value) : { version: 1 }), grades: { courses: {}, priorGpa: "", priorCredits: "", ...clone(grades), courses: clone(grades.courses || {}) } };
    }

    class GradesWorkspace {
        constructor(options = {}) {
            this.doc = options.document || globalRoot?.document;
            this.win = options.window || globalRoot;
            this.domain = options.domain || defaultDomain;
            this.analytics = options.analytics || defaultAnalytics;
            this.adapter = options.adapter;
            this.preferenceStore = options.preferenceStore || null;
            this.getWorkspaceRecord = typeof options.getWorkspaceRecord === "function" ? options.getWorkspaceRecord : async () => ({ version: 1, grades: { courses: {}, priorGpa: "", priorCredits: "" } });
            this.saveWorkspaceGrades = typeof options.saveWorkspaceGrades === "function" ? options.saveWorkspaceGrades : null;
            this.getBounds = typeof options.getBounds === "function" ? options.getBounds : () => options.bounds || null;
            this.getScenario = typeof options.getScenario === "function" ? options.getScenario : null;
            this.saveScenario = typeof options.saveScenario === "function" ? options.saveScenario : null;
            this.navigateCanvas = typeof options.navigateCanvas === "function" ? options.navigateCanvas : null;
            this.dirtyListener = typeof options.onDirtyChange === "function" ? options.onDirtyChange : null;
            if (!this.doc?.createElement || !this.domain?.buildCourseOverview || !this.analytics?.createScenario || !this.adapter?.overview || !this.adapter?.course) throw new TypeError("Grades UI requires document, domain, analytics, and adapter options");
            this.host = null; this.root = null; this.context = null; this.mode = "popup"; this.route = routeIntent();
            this.overviewRead = null; this.overview = null; this.workspace = safeWorkspace(); this.courseRead = null; this.scenario = null;
            this.preferences = { ...this.domain.DEFAULT_PREFS }; this.chart = null; this.notice = { text: "", kind: "" };
            this.loading = false; this.courseLoading = false; this.disposed = false; this.disposeCalled = false; this.generation = 0;
            this.navigationGeneration = 0; this.workspaceRevision = 0; this.scenarioRevision = 0;
            this.workspaceDirty = false; this.scenarioDirty = false; this.activePoint = null;
        }

        el(tag, text, className) { const node = this.doc.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; }
        button(text, action, className = "", role = "") {
            const node = this.el("button", text, className); node.type = "button"; if (role) node.dataset.gradesRole = role;
            node.addEventListener("click", () => { if (!this.disposed) void action(node); }); return node;
        }
        field(labelText, control, className = "") {
            const label = this.el("label", undefined, `workspace-grades-field${className ? ` ${className}` : ""}`); label.append(this.el("span", labelText), control); return label;
        }
        select(labelText, options, value, role) {
            const input = this.el("select"); input.dataset.gradesRole = role;
            options.forEach(([key, label]) => { const option = this.el("option", label); option.value = key; input.append(option); }); input.value = value;
            return this.field(labelText, input);
        }
        announce(text, kind = "") {
            this.notice = { text: clean(text, 360), kind };
            try { this.context?.status?.(this.notice.text, kind === "error"); } catch (error) {}
        }
        setDirty(kind, value) {
            const before = this.queryDirty();
            if (kind === "workspace") { this.workspaceDirty = value === true; if (value === true) this.workspaceRevision += 1; }
            else { this.scenarioDirty = value === true; if (value === true) this.scenarioRevision += 1; }
            const after = this.queryDirty(); if (before !== after) { try { (this.dirtyListener || this.context?.onDirtyChange)?.(after); } catch (error) {} }
        }
        queryDirty() { return !this.disposed && (this.workspaceDirty || this.scenarioDirty); }
        course() { return this.overview?.rows?.find(row => row.id === this.route.courseId) || null; }
        config() { return this.workspace.grades.courses[this.route.courseId] ||= {}; }
        accountScope() { return this.context?.account?.scope || this.overviewRead?.account?.scope || null; }
        saveIsCurrent(snapshot, kind) {
            return !this.disposed && snapshot.navigation === this.navigationGeneration && snapshot.scope === this.accountScope() && snapshot.courseId === this.route.courseId && snapshot.revision === (kind === "workspace" ? this.workspaceRevision : this.scenarioRevision);
        }
        confirmScenarioDiscard(focusTarget) {
            if (!this.scenarioDirty) return true;
            const restore = focusTarget || this.doc?.activeElement; let confirmed = false;
            try { confirmed = this.win?.confirm?.("Discard unsaved what-if scenario changes before changing classes?") === true; } catch (error) {}
            if (!confirmed) { restore?.focus?.(); return false; }
            this.setDirty("scenario", false); this.scenario = null; this.chart = null; this.activePoint = null; return true;
        }
        leaveCourse(focusTarget) {
            if (!this.confirmScenarioDiscard(focusTarget)) return false;
            this.navigationGeneration += 1; this.generation += 1; this.route = routeIntent(); this.courseRead = null; this.scenario = null; this.chart = null; this.activePoint = null; this.render(); return true;
        }

        async mount(host, { mode = "popup", route = {}, context = null } = {}) {
            if (this.disposed) throw new Error("The Grades workspace has been disposed.");
            this.host = host || context?.shellHost; this.context = context; this.mode = mode === "canvas" ? "canvas" : "popup"; this.route = routeIntent(route);
            if (!this.host?.append) throw new TypeError("A Grades host is required");
            this.root = this.el("section", undefined, `workspace-grades workspace-grades--${this.mode}`); this.root.dataset.gradesRole = "root"; this.root.setAttribute("aria-label", "Grades workspace"); this.host.replaceChildren(this.root);
            await this.loadOverview(); return this;
        }
        async loadOverview() {
            const token = ++this.generation; this.loading = true; this.render();
            try {
                const [read, workspace, preferences] = await Promise.all([
                    this.adapter.overview(),
                    Promise.resolve(this.getWorkspaceRecord()).catch(error => { this.announce(`${clean(error?.message) || "Saved grade settings could not be loaded."} Canvas grades were not changed.`, "error"); return null; }),
                    Promise.resolve(this.preferenceStore?.load?.()).catch(() => null)
                ]);
                if (this.disposed || token !== this.generation) return;
                this.overviewRead = read; this.workspace = safeWorkspace(workspace); this.preferences = { ...this.domain.DEFAULT_PREFS, ...(preferences || {}) };
                this.overview = this.domain.buildCourseOverview(read.courses, this.workspace, { bounds: this.getBounds() });
                if (!this.route.courseId && this.preferences.courseId && this.overview.rows.some(row => row.id === this.preferences.courseId)) this.preferences.courseId = this.preferences.courseId;
                if (this.route.courseId && !this.overview.rows.some(row => row.id === this.route.courseId)) { this.route = routeIntent(); this.announce("That class is not in the current verified Canvas course list.", "error"); }
            } catch (error) {
                if (this.disposed || token !== this.generation) return;
                this.overviewRead = null; this.overview = null; this.announce(clean(error?.message) || "Grades could not be loaded. Reload Canvas and try again.", "error");
            } finally { if (!this.disposed && token === this.generation) { this.loading = false; this.render(); if (this.route.courseId) await this.loadCourse(this.route.courseId); } }
        }
        async loadCourse(courseId) {
            const key = clean(courseId, 100); if (!key) return;
            if (this.scenarioDirty) return false;
            const token = ++this.generation; this.courseLoading = true; this.courseRead = null; this.chart = null; this.render();
            try {
                const [read, scenario] = await Promise.all([this.adapter.course(key), Promise.resolve(this.getScenario?.(key)).catch(() => null)]);
                if (this.disposed || token !== this.generation || this.route.courseId !== key) return;
                this.courseRead = read; this.scenario = scenario?.version === this.analytics.VERSION ? scenario : this.analytics.createScenario();
                this.preferences.courseId = key;
            } catch (error) {
                if (this.disposed || token !== this.generation) return;
                this.announce(clean(error?.message) || "This class’s grade data could not be loaded. No estimate was generated.", "error");
            } finally { if (!this.disposed && token === this.generation) { this.courseLoading = false; this.render(); } }
        }
        async routeUpdate(route = {}, context = this.context) {
            if (this.disposed) return false;
            if (context?.account?.scope && this.context?.account?.scope && context.account.scope !== this.context.account.scope) {
                this.navigationGeneration += 1; this.generation += 1;
                this.announce(this.queryDirty() ? "Your Canvas account changed. Unsaved grade changes remain here; save or discard them before leaving." : "Your Canvas account changed. Close and reopen Grades.", "error"); this.render(); return false;
            }
            const next = routeIntent(route); const changedCourse = next.courseId !== this.route.courseId; this.context = context || this.context;
            if (changedCourse && !this.confirmScenarioDiscard()) return false;
            if (changedCourse) { this.generation += 1; this.navigationGeneration += 1; this.setDirty("scenario", false); this.scenario = null; this.courseRead = null; this.chart = null; }
            this.route = next; this.activePoint = null; this.render();
            if (changedCourse && next.courseId) await this.loadCourse(next.courseId); return true;
        }
        async openCourse(courseId, tab = "overview", focusTarget = null) {
            const key = clean(courseId, 100); if (!key) return false;
            if (key === this.route.courseId) { this.openTab(tab); return true; }
            if (key !== this.route.courseId && !this.confirmScenarioDiscard(focusTarget)) return false;
            if (key !== this.route.courseId) this.navigationGeneration += 1;
            this.route = { courseId: key, tab: TABS.includes(tab) ? tab : "overview" }; this.scenario = null; this.courseRead = null; this.chart = null; this.activePoint = null; this.render(); await this.loadCourse(key); return true;
        }
        openTab(tab) { if (!TABS.includes(tab)) return; this.route = { ...this.route, tab }; this.activePoint = null; this.render(); }
        openCanvas(path) {
            if (!/^\/courses\/[A-Za-z0-9._~-]+(?:\/|$)/.test(path || "")) return;
            if (this.navigateCanvas) this.navigateCanvas(path);
            else if (this.win?.location?.origin) this.win.location.href = new URL(path, this.win.location.origin).href;
        }

        render() {
            if (!this.root) return; this.root.replaceChildren();
            if (this.loading) { this.root.setAttribute("aria-busy", "true"); this.root.append(this.el("p", "Loading current Canvas grades…", "workspace-grades-state")); return; }
            this.root.setAttribute("aria-busy", "false");
            if (!this.overview) return this.renderFailure();
            this.route.courseId ? this.renderClass() : this.renderOverview();
            const status = this.el("p", this.notice.text, `workspace-grades-status${this.notice.kind ? ` is-${this.notice.kind}` : ""}`); status.setAttribute("aria-live", "polite"); this.root.append(status);
        }
        renderFailure() {
            const box = this.el("div", undefined, "workspace-grades-gate"); box.append(this.el("h1", "Grades are unavailable"), this.el("p", this.notice.text || "Current grades require a verified Canvas account."), this.button("Retry", () => this.loadOverview(), "workspace-grades-primary")); this.root.append(box);
        }
        renderOverview() {
            const header = this.el("header", undefined, "workspace-grades-header");
            const copy = this.el("div"); copy.append(this.el("h1", "Grades"), this.el("p", "Current scores come from Canvas. GPA, credits, goals, and what-if values use your saved local settings.")); header.append(copy); this.root.append(header);
            const summary = this.el("section", undefined, "workspace-grades-summary"); summary.setAttribute("aria-label", "Term summary");
            const summaryItems = [
                ["Current GPA", gpaValue(this.overview.current), this.overview.current.label],
                ["Counted credits", Number.isFinite(this.overview.credits) ? String(this.overview.credits) : "—", "Credits saved for counted classes"],
                ["Classes", String(this.overview.rows.length), "Current verified Canvas courses"]
            ];
            if (this.overview.scenario) summaryItems.splice(1, 0, ["What-if GPA", gpaValue(this.overview.scenario), this.overview.scenario.label]);
            summaryItems.forEach(([label, value, help]) => { const item = this.el("div", undefined, "workspace-grades-summary-item"); item.append(this.el("span", label), this.el("strong", value), this.el("small", help)); summary.append(item); });
            this.root.append(summary);
            const ledger = this.el("section", undefined, "workspace-grades-ledger"); ledger.append(this.el("h2", "Current classes"));
            if (!this.overview.rows.length) ledger.append(this.el("p", "Canvas returned no active courses with grade access.", "workspace-grades-empty"));
            this.overview.rows.forEach(row => ledger.append(this.courseRow(row))); this.root.append(ledger);
        }
        courseRow(row) {
            const article = this.el("article", undefined, "workspace-grades-course-row");
            const identity = this.el("div", undefined, "workspace-grades-course-name"); identity.append(this.el("h3", row.name), this.el("p", row.code || "Canvas course"));
            const grade = this.el("div", undefined, "workspace-grades-measure"); grade.append(this.el("span", "Current"), this.el("strong", percent(row.currentGrade?.value)), row.officialGrade ? this.el("small", `Official final: ${percent(row.officialGrade.value)}`) : this.el("small", "Not an official final grade"));
            const credits = this.el("div", undefined, "workspace-grades-measure"); credits.append(this.el("span", "Credits"), this.el("strong", row.credits ? String(row.credits) : "—"), this.el("small", row.included ? "Included when grade and scale resolve" : "Excluded from GPA"));
            const goal = this.el("div", undefined, "workspace-grades-measure"); goal.append(this.el("span", "Goal"), this.el("strong", Number.isFinite(row.goal) ? percent(row.goal) : "—"), this.el("small", Number.isFinite(row.goal) && Number.isFinite(row.currentGrade?.value) ? row.currentGrade.value >= row.goal ? "At or above goal" : `${(row.goal - row.currentGrade.value).toFixed(1)} points to goal` : "Set locally in What-if"));
            const actions = this.el("div", undefined, "workspace-grades-row-actions"); actions.append(this.button("View class", button => this.openCourse(row.id, "overview", button), "workspace-grades-primary"), this.button("Canvas gradebook", () => this.openCanvas(row.links.grades), "workspace-grades-link"));
            article.append(identity, grade, credits, goal, actions); return article;
        }
        renderClass() {
            const course = this.course(); if (!course) return this.renderOverview();
            const header = this.el("header", undefined, "workspace-grades-class-header");
            const crumb = this.el("nav", undefined, "workspace-grades-breadcrumb"); crumb.setAttribute("aria-label", "Breadcrumb"); crumb.append(this.button("Grades", button => this.leaveCourse(button), "workspace-grades-crumb"), this.el("span", course.name));
            const title = this.el("div"); title.append(this.el("h1", course.name), this.el("p", `${percent(course.currentGrade?.value)} current Canvas grade · ${course.officialGrade ? `${percent(course.officialGrade.value)} official final` : "no official final reported"}`)); header.append(crumb, title); this.root.append(header);
            const tabs = this.el("nav", undefined, "workspace-grades-tabs"); tabs.setAttribute("aria-label", `${course.name} grade views`);
            TABS.forEach(tab => { const button = this.button(TAB_LABELS[tab], () => this.openTab(tab), tab === this.route.tab ? "is-active" : "", `tab-${tab}`); button.setAttribute("aria-current", tab === this.route.tab ? "page" : "false"); tabs.append(button); }); this.root.append(tabs);
            if (this.courseLoading) return this.root.append(this.el("p", "Loading assignments and grading groups…", "workspace-grades-state"));
            if (!this.courseRead) { const box = this.el("div", undefined, "workspace-grades-state"); box.append(this.el("p", this.notice.text || "Class grade data is unavailable. No estimate was generated."), this.button("Retry class", () => this.loadCourse(course.id), "workspace-grades-primary")); return this.root.append(box); }
            const panel = this.el("section", undefined, "workspace-grades-panel"); panel.setAttribute("aria-label", TAB_LABELS[this.route.tab]);
            if (this.route.tab === "overview") this.renderClassOverview(panel, course);
            else if (this.route.tab === "assignments") this.renderAssignments(panel);
            else if (this.route.tab === "graphs") this.renderGraphs(panel);
            else this.renderWhatIf(panel, course);
            this.root.append(panel);
        }
        renderClassOverview(parent, course) {
            const config = this.config(); const intro = this.el("div", undefined, "workspace-grades-class-summary");
            [["Current Canvas grade", percent(course.currentGrade?.value)], ["Saved credits", finite(config.credits) === null ? "—" : String(finite(config.credits))], ["Saved goal", finite(config.goal) === null ? "—" : percent(finite(config.goal))], ["Local what-if", finite(config.whatIf) === null ? "—" : percent(finite(config.whatIf))]].forEach(([label, value]) => { const item = this.el("div"); item.append(this.el("span", label), this.el("strong", value)); intro.append(item); });
            parent.append(intro, this.el("p", "Canvas remains authoritative. Local goals and what-if values never change a Canvas grade.", "workspace-grades-disclosure"));
            const links = this.el("div", undefined, "workspace-grades-actions"); links.append(this.button("Course overview", () => this.openCanvas(course.links.overview), "workspace-grades-secondary"), this.button("Assignments in Canvas", () => this.openCanvas(course.links.assignments), "workspace-grades-secondary"), this.button("Canvas gradebook", () => this.openCanvas(course.links.grades), "workspace-grades-primary")); parent.append(links);
        }
        renderAssignments(parent) {
            parent.append(this.el("h2", "Assignments"), this.el("p", "Only supported assignment scores returned by Canvas appear here. Hidden, dropped, excused, and ungraded work stays explicitly labeled.", "workspace-grades-disclosure"));
            const table = this.el("table", undefined, "workspace-grades-table"); const caption = this.el("caption", `${this.course().name} assignments`); const head = this.el("thead"); const headRow = this.el("tr"); ["Assignment", "Due", "Score", "Status"].forEach(value => headRow.append(this.el("th", value))); head.append(headRow); const body = this.el("tbody");
            this.courseRead.source.assignments.forEach(row => { const tr = this.el("tr"); const score = Number.isFinite(row.score) && Number.isFinite(row.pointsPossible) && row.pointsPossible > 0 ? `${row.score} / ${row.pointsPossible} · ${percent(row.score / row.pointsPossible * 100)}` : "Not graded"; const status = row.hidden ? "Hidden" : row.dropped ? "Dropped" : row.excused ? "Excused" : row.missing ? "Missing" : row.ungraded ? "Ungraded" : "Counted"; tr.append(this.el("th", row.title), this.el("td", row.dueAt ? new Date(row.dueAt).toLocaleDateString() : "No due timestamp"), this.el("td", score), this.el("td", status)); body.append(tr); });
            if (!this.courseRead.source.assignments.length) { const tr = this.el("tr"); const td = this.el("td", "Canvas returned no assignments for this class."); td.setAttribute("colspan", "4"); tr.append(td); body.append(tr); }
            table.append(caption, head, body); parent.append(table);
        }

        renderGraphs(parent) {
            parent.append(this.el("h2", "Build a graph"), this.el("p", "Choose one class, one supported metric, a date range, and a chart preset. Generate updates both the visual and its equivalent table.", "workspace-grades-disclosure"));
            const form = this.el("form", undefined, "workspace-grades-builder"); form.addEventListener("submit", event => { event.preventDefault?.(); void this.generateChart(); });
            const courseChoices = this.overview.rows.map(row => [row.id, row.name]); const courseField = this.select("1. Course", courseChoices, this.route.courseId, "chart-course"); courseField.children[1].disabled = true;
            const metric = this.select("2. Metric", [["assignment-percentage", "Assignment percentage"]], this.preferences.metric, "chart-metric");
            const range = this.select("3. Date range", [["all", "All supported assignments"], ["last-30-days", "Last 30 days"], ["last-90-days", "Last 90 days"], ["custom", "Custom range"]], this.preferences.dateRange, "chart-range");
            const type = this.select("4. Chart preset", [["scores-over-time", "Scores over time · line and points"], ["score-histogram", "Score histogram"], ["assignment-group-bars", "Assignment-group bars"]], this.preferences.chartType, "chart-type");
            const comparison = this.select("5. Compare", [["current", "Current Canvas assignments"], ["scenario", "Current and local what-if estimate"]], this.preferences.comparison, "chart-comparison");
            const start = this.el("input"); start.type = "date"; start.value = clean(this.preferences.start).slice(0, 10); start.dataset.gradesRole = "chart-start";
            const end = this.el("input"); end.type = "date"; end.value = clean(this.preferences.end).slice(0, 10); end.dataset.gradesRole = "chart-end";
            const custom = this.el("div", undefined, "workspace-grades-custom-range"); custom.hidden = this.preferences.dateRange !== "custom"; custom.append(this.field("Start", start), this.field("End", end));
            range.children[1].addEventListener("change", () => { custom.hidden = range.children[1].value !== "custom"; });
            form.append(courseField, metric, range, type, comparison, custom, this.button(this.chart ? "Update graph" : "Generate graph", () => this.generateChart(), "workspace-grades-primary", "generate-chart")); parent.append(form);
            if (this.chart) this.renderChart(parent, this.chart);
            else parent.append(this.el("p", "No graph generated yet. The controls above do not imply data is available.", "workspace-grades-empty"));
        }
        role(name) {
            const visit = node => { if (node?.dataset?.gradesRole === name) return node; for (const child of Array.from(node?.children || [])) { const found = visit(child); if (found) return found; } return null; };
            return visit(this.root);
        }
        async generateChart() {
            const dateValue = value => value ? new Date(`${value}T12:00:00.000Z`).toISOString() : null;
            const input = { courseId: this.route.courseId, metric: this.role("chart-metric")?.value, dateRange: this.role("chart-range")?.value, chartType: this.role("chart-type")?.value, comparison: this.role("chart-comparison")?.value, start: dateValue(this.role("chart-start")?.value), end: dateValue(this.role("chart-end")?.value) };
            const result = this.domain.buildChartDataset(this.courseRead.source, input, { scenario: this.scenario, analytics: this.analytics }); this.chart = result;
            if (result.validation?.ok) { this.preferences = { ...result.validation.config }; try { await this.preferenceStore?.save?.(this.preferences); } catch (error) { this.announce("The graph is ready, but these controls could not be remembered.", "error"); } }
            if (result.state === "unsupported") this.announce(result.message || result.validation?.errors?.[0]?.message || "That graph is not supported by the available data.", "error"); else if (result.state === "empty") this.announce("No supported assignments match this graph. No estimate was generated."); else this.announce("Graph and equivalent table updated.", "saved"); this.render();
        }
        renderChart(parent, chart) {
            const section = this.el("section", undefined, "workspace-grades-chart-result");
            if (chart.state !== "ready") { section.append(this.el("h3", chart.state === "unsupported" ? "This graph is not supported" : "No matching data"), this.el("p", chart.message || chart.validation?.errors?.[0]?.message || "Change the guided controls and try again.")); parent.append(section); return; }
            section.append(this.el("h3", chart.title), this.el("p", chart.disclosure, "workspace-grades-disclosure"));
            const plot = this.el("div", undefined, `workspace-grades-plot is-${chart.validation.config.chartType}`); plot.setAttribute("role", "group"); plot.setAttribute("aria-label", `${chart.title}. Use Left and Right Arrow keys to move between points.`);
            const tooltip = this.el("p", "Focus a chart point for details.", "workspace-grades-tooltip"); tooltip.setAttribute("role", "status"); tooltip.dataset.gradesRole = "chart-tooltip";
            const points = chart.datasets.flatMap(dataset => dataset.points.map((point, pointIndex) => ({ dataset, point, pointIndex, pointCount: dataset.points.length })));
            const maxY = Math.max(100, ...points.map(item => Number(item.point.y) || 0));
            if (chart.validation.config.chartType === "scores-over-time") {
                const svg = this.doc.createElementNS ? this.doc.createElementNS("http://www.w3.org/2000/svg", "svg") : this.el("svg"); svg.setAttribute("class", "workspace-grades-line"); svg.setAttribute("viewBox", "0 0 1000 1000"); svg.setAttribute("preserveAspectRatio", "none"); svg.setAttribute("aria-hidden", "true");
                chart.datasets.forEach(dataset => { const own = dataset.points; if (own.length < 2) return; const path = this.doc.createElementNS ? this.doc.createElementNS("http://www.w3.org/2000/svg", "path") : this.el("path"); path.setAttribute("d", own.map((point, index) => `${index ? "L" : "M"}${own.length === 1 ? 500 : 40 + index * 920 / (own.length - 1)},${920 - Math.max(0, Number(point.y) || 0) / maxY * 780}`).join(" ")); path.dataset.series = dataset.id; svg.append(path); }); plot.append(svg);
            }
            points.forEach(item => {
                const mark = this.button("", () => this.activatePoint(item.dataset.id, item.point.key, item.point.valueLabel), `workspace-grades-mark is-${item.dataset.status}`, "chart-point"); mark.dataset.datasetId = item.dataset.id; mark.dataset.pointKey = item.point.key; mark.title = item.point.valueLabel; mark.setAttribute("aria-label", `${item.dataset.label}. ${item.point.valueLabel}`);
                const ratio = Math.max(0, Number(item.point.y) || 0) / maxY;
                const pointLeft = item.pointCount > 1 ? 4 + item.pointIndex * 92 / (item.pointCount - 1) : 50;
                mark.style.setProperty("--point-left", `${pointLeft}%`);
                mark.style.setProperty("--point-bottom", `${8 + ratio * 78}%`);
                mark.style.setProperty("--bar-height", `${24 + Math.min(210, Math.max(0, Number(item.point.y) || 0) * 2)}px`);
                mark.addEventListener("focus", () => this.activatePoint(item.dataset.id, item.point.key, item.point.valueLabel));
                mark.addEventListener("keydown", event => { if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return; event.preventDefault?.(); const marks = this.chartMarks(); const current = marks.indexOf(mark); marks[(current + (event.key === "ArrowRight" ? 1 : -1) + marks.length) % marks.length]?.focus?.(); }); plot.append(mark);
            });
            section.append(plot, tooltip); this.renderChartTable(section, chart.table); parent.append(section);
            if (this.activePoint) this.activatePoint(this.activePoint.datasetId, this.activePoint.pointKey, this.activePoint.label);
        }
        chartMarks() { const all = []; const visit = node => { if (node?.dataset?.gradesRole === "chart-point") all.push(node); Array.from(node?.children || []).forEach(visit); }; visit(this.root); return all; }
        activatePoint(datasetId, pointKey, label) {
            this.activePoint = { datasetId, pointKey, label }; this.chartMarks().forEach(node => toggleClass(node, "is-active", node.dataset.datasetId === datasetId && node.dataset.pointKey === pointKey));
            const tooltip = this.role("chart-tooltip"); if (tooltip) tooltip.textContent = label;
            const visit = node => { if (node?.dataset?.gradesRole === "chart-row") toggleClass(node, "is-active", node.dataset.datasetId === datasetId && node.dataset.pointKey === pointKey); Array.from(node?.children || []).forEach(visit); }; visit(this.root);
        }
        renderChartTable(parent, tableData) {
            const wrap = this.el("div", undefined, "workspace-grades-table-wrap"); const table = this.el("table", undefined, "workspace-grades-table"); const caption = this.el("caption", tableData.caption); const head = this.el("thead"); const tr = this.el("tr"); tableData.columns.forEach(value => tr.append(this.el("th", value))); head.append(tr); const body = this.el("tbody");
            tableData.rows.forEach(row => { const line = this.el("tr"); line.tabIndex = 0; line.dataset.gradesRole = "chart-row"; line.dataset.datasetId = row.datasetId; line.dataset.pointKey = row.pointKey; line.addEventListener("focus", () => this.activatePoint(row.datasetId, row.pointKey, row.cells.join(" · "))); row.cells.forEach((value, index) => line.append(this.el(index === 0 ? "th" : "td", value))); body.append(line); });
            table.append(caption, head, body); wrap.append(table); parent.append(wrap);
        }

        renderWhatIf(parent, course) {
            parent.append(this.el("h2", "What-if"), this.el("p", "What-if changes are local estimates. They never write to Canvas or become official grades.", "workspace-grades-disclosure"));
            const settings = this.el("section", undefined, "workspace-grades-whatif-summary"); settings.append(this.el("h3", "GPA settings")); const config = this.config();
            const controls = this.el("div", undefined, "workspace-grades-settings-grid");
            [["Credits", "credits", 60], ["Goal %", "goal", 200], ["Overall what-if %", "whatIf", 200]].forEach(([label, key, max]) => { const input = this.el("input"); input.type = "number"; input.min = "0"; input.max = String(max); input.step = "any"; input.value = config[key] ?? ""; input.disabled = !this.saveWorkspaceGrades; input.dataset.gradesRole = `workspace-${key}`; input.addEventListener("input", () => { config[key] = input.value; this.setDirty("workspace", true); }); controls.append(this.field(label, input)); });
            settings.append(controls);
            if (this.saveWorkspaceGrades) settings.append(this.button("Save GPA settings", () => this.saveSettings(), "workspace-grades-primary")); else settings.append(this.el("p", "Saved GPA settings are read-only in this host.", "workspace-grades-help")); parent.append(settings);
            const scenario = this.el("section", undefined, "workspace-grades-scenario"); scenario.append(this.el("h3", "Assignment scenario"), this.el("p", this.saveScenario ? "Adjust supported scores, then save this local scenario." : "This scenario is temporary and lasts only while this Grades view stays open.", "workspace-grades-help"));
            const rows = this.el("div", undefined, "workspace-grades-scenario-rows"); this.courseRead.source.assignments.slice(0, 100).forEach(assignment => {
                const change = this.scenario.assignments?.[assignment.id] || {}; const row = this.el("div", undefined, "workspace-grades-scenario-row"); row.append(this.el("strong", assignment.title));
                [["Earned", "score", change.score ?? assignment.score ?? ""], ["Possible", "pointsPossible", change.pointsPossible ?? assignment.pointsPossible ?? ""]].forEach(([label, key, value]) => { const input = this.el("input"); input.type = "number"; input.min = "0"; input.step = "any"; input.value = value; input.addEventListener("input", () => { this.scenario = this.analytics.scenarioAssignment(this.scenario, assignment.id, { [key]: finite(input.value) }); this.setDirty("scenario", true); }); row.append(this.field(label, input)); }); rows.append(row);
            }); scenario.append(rows);
            const finalRow = this.el("div", undefined, "workspace-grades-final-row"); const finalScore = this.el("input"); finalScore.type = "number"; finalScore.min = "0"; finalScore.step = "any"; finalScore.value = this.scenario.final?.score ?? ""; const finalPossible = this.el("input"); finalPossible.type = "number"; finalPossible.min = "0"; finalPossible.step = "any"; finalPossible.value = this.scenario.final?.pointsPossible ?? "";
            const updateFinal = () => { this.scenario = this.analytics.setScenarioFinal(this.scenario, { title: "Hypothetical final", score: finite(finalScore.value), pointsPossible: finite(finalPossible.value), groupId: null }); this.setDirty("scenario", true); };
            finalScore.addEventListener("input", updateFinal); finalPossible.addEventListener("input", updateFinal); finalRow.append(this.field("Hypothetical final earned", finalScore), this.field("Hypothetical final possible", finalPossible)); scenario.append(finalRow);
            const actions = this.el("div", undefined, "workspace-grades-actions"); if (this.saveScenario) actions.append(this.button("Save local scenario", () => this.saveCurrentScenario(), "workspace-grades-primary")); actions.append(this.button("Reset scenario", () => { this.scenario = this.analytics.resetScenario(); this.setDirty("scenario", true); this.render(); }, "workspace-grades-secondary")); scenario.append(actions); parent.append(scenario);
        }
        async saveSettings() {
            if (!this.saveWorkspaceGrades) return;
            const snapshot = { navigation: this.navigationGeneration, scope: this.accountScope(), courseId: this.route.courseId, revision: this.workspaceRevision };
            try {
                const saved = await this.saveWorkspaceGrades(clone(this.workspace.grades)); if (!this.saveIsCurrent(snapshot, "workspace")) return;
                if (saved) this.workspace = safeWorkspace(saved.grades ? saved : { ...this.workspace, grades: saved }); this.overview = this.domain.buildCourseOverview(this.overviewRead.courses, this.workspace, { bounds: this.getBounds() }); this.setDirty("workspace", false); this.announce("GPA settings saved locally.", "saved");
            } catch (error) { if (!this.saveIsCurrent(snapshot, "workspace")) return; this.announce(`${clean(error?.message) || "GPA settings could not be saved."} Your changes are still here.`, "error"); } this.render();
        }
        async saveCurrentScenario() {
            if (!this.saveScenario) return;
            const snapshot = { navigation: this.navigationGeneration, scope: this.accountScope(), courseId: this.route.courseId, revision: this.scenarioRevision };
            try {
                const saved = await this.saveScenario(snapshot.courseId, clone(this.scenario)); if (!this.saveIsCurrent(snapshot, "scenario")) return;
                if (saved?.version === this.analytics.VERSION) this.scenario = saved; this.setDirty("scenario", false); this.announce("What-if scenario saved locally.", "saved");
            } catch (error) { if (!this.saveIsCurrent(snapshot, "scenario")) return; this.announce(`${clean(error?.message) || "The scenario could not be saved."} Your estimate is still here.`, "error"); } this.render();
        }
        async dispose(reason = "dispose") {
            if (this.disposed) return; this.disposed = true; this.generation += 1; this.navigationGeneration += 1;
            if (!this.disposeCalled) { this.disposeCalled = true; try { this.adapter.dispose?.(reason); } catch (error) {} }
            const wasDirty = this.workspaceDirty || this.scenarioDirty; this.workspaceDirty = false; this.scenarioDirty = false; if (wasDirty) { try { (this.dirtyListener || this.context?.onDirtyChange)?.(false); } catch (error) {} }
            this.root?.remove?.(); if (this.host?.contains?.(this.root)) this.host.replaceChildren(); this.root = null; this.host = null;
        }
    }

    function createGradesWorkspace(options) { return new GradesWorkspace(options); }
    function createGradesModule(options = {}) {
        let workspace = null;
        return Object.freeze({
            async mount(context, route = {}) { workspace = createGradesWorkspace(options); await workspace.mount(options.host || context?.shellHost, { mode: options.mode || "popup", route, context }); return workspace; },
            routeUpdate(route, context) { return workspace?.routeUpdate(route, context) ?? false; },
            queryDirty() { return workspace?.queryDirty() ?? false; },
            async dispose(reason) { const current = workspace; workspace = null; await current?.dispose(reason); }
        });
    }

    return Object.freeze({ GradesWorkspace, createGradesWorkspace, createGradesModule, routeIntent, TABS, TAB_LABELS });
}));
