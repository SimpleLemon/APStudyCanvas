(function(root, factory) {
    "use strict";
    const api = factory();
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasContent = Object.assign(root.APStudyCanvasContent || {}, { WorkspaceUI: api });
}(typeof globalThis !== "undefined" ? globalThis : this, function() {
    "use strict";
    const labels = { planner: "Planner", notes: "Notes", grades: "Grades", study: "Study" };
    function createWorkspace({ document: doc, window: win, model, gpa, storage, verify, readCourses, readPlanner, getBounds, openSettings }) {
        let dialog, main, status, heading, store, state, courses = [], courseError = false;
        let page = "planner", dirty = false, busy = false, generation = 0, returnFocus, controller;
        let courseFilter = "", query = "", sort = "updated", trash = false, mode = "week", date = new Date();
        let editing = false;
        let plannerItems = [], plannerError = "", plannerLoading = false, plannerSequence = 0;
        const el = (tag, text, className) => { const n = doc.createElement(tag); if (text !== undefined) n.textContent = text; if (className) n.className = className; return n; };
        const button = (text, action, primary = false) => { const n = el("button", text, primary ? "aw-primary" : ""); n.type = "button"; n.addEventListener("click", () => { if (!busy) action(); }); return n; };
        const message = (text, error = false) => { status.textContent = text; status.setAttribute("role", error ? "alert" : "status"); };
        const safeLeave = () => !busy && (!dirty || win.confirm("Discard unsaved changes?"));
        const field = (parent, label, value = "", type = "text", attrs = {}) => {
            const wrap = el("label", undefined, "aw-field"), input = el(type === "textarea" ? "textarea" : "input");
            if (type !== "textarea") input.type = type;
            input.value = value ?? ""; Object.assign(input, attrs);
            wrap.append(el("span", label), input); parent.append(wrap);
            input.addEventListener("input", () => { dirty = true; }); return input;
        };
        const select = (parent, label, choices, value, change) => {
            const wrap = el("label", undefined, "aw-field"), input = el("select");
            choices.forEach(([v, name]) => { const opt = el("option", name); opt.value = v; input.append(opt); });
            input.value = value; wrap.append(el("span", label), input); parent.append(wrap);
            input.addEventListener("change", () => change(input.value)); return input;
        };
        const courseChoices = (all = true) => [["", all ? "All courses" : "Personal / no course"], ...courses.map(c => [String(c.id), c.name || c.course_code || `Course ${c.id}`])];
        const courseName = id => courses.find(c => String(c.id) === String(id))?.name || (id ? `Course ${id}` : "Personal");
        const form = () => { const n = el("form", undefined, "aw-editor"); n.addEventListener("submit", e => e.preventDefault()); main.append(n); return n; };
        function formActions(parent, save) {
            const row = el("div", undefined, "aw-actions"); row.append(button("Save", () => { if (parent.reportValidity()) save(); }, true), button("Cancel", () => { if (safeLeave()) render(); })); parent.append(row);
        }
        async function write(change, after = render) {
            if (busy) return false;
            busy = true; dialog.setAttribute("aria-busy", "true"); message("Saving…");
            const controls = [...dialog.querySelectorAll("button, input, textarea, select")];
            const previous = controls.map(n => n.disabled); controls.forEach(n => { n.disabled = true; });
            try { state = await store.transact(change); dirty = false; after(); message("Saved on this device."); return true; }
            catch (error) { message(`${error.message} Your changes are still here. Try Save again.`, true); return false; }
            finally { busy = false; dialog.removeAttribute("aria-busy"); controls.forEach((n, i) => { n.disabled = previous[i]; }); }
        }
        function saveRecord(kind, record) {
            const next = { ...record, updatedAt: Date.now() };
            return write(data => { const i = data[kind].findIndex(r => r.id === next.id); if (i < 0) data[kind].push(next); else data[kind][i] = next; });
        }
        function toggleTrash(kind, record) { write(data => { const r = data[kind].find(r => r.id === record.id); if (!r) throw new Error("This item no longer exists."); r.deleted = !r.deleted; r.updatedAt = Date.now(); }); }
        function recordBase() { return { id: win.crypto.randomUUID(), title: "", courseId: courseFilter, updatedAt: Date.now(), deleted: false }; }
        function link(text, href) {
            const n = el("a", text);
            try { const url = new URL(href, win.location.origin); if (url.origin !== win.location.origin || url.protocol !== "https:") throw new Error(); n.href = url.href; n.target = "_blank"; n.rel = "noopener"; }
            catch { n.removeAttribute("href"); }
            return n;
        }
        function mount() {
            dialog = el("dialog", undefined, "apstudy-workspace"); dialog.id = "apstudy-workspace";
            dialog.dataset.apstudycanvasOwned = "true"; dialog.setAttribute("aria-labelledby", "aw-title");
            const header = el("header", undefined, "aw-header");
            header.append(el("span", "Nest.APStudy", "aw-brand"), button("Close", close));
            const nav = el("nav", undefined, "aw-nav"); nav.setAttribute("aria-label", "Study workspace");
            Object.entries(labels).forEach(([key, title]) => { const b = button(title, () => open(key)); b.dataset.page = key; nav.append(b); });
            heading = el("h1"); heading.id = "aw-title";
            const intro = el("div", undefined, "aw-intro"); intro.append(heading, el("p", "Personal tasks, notes, study sets and grade estimates are saved on this device."));
            status = el("p", "", "aw-status"); status.setAttribute("aria-live", "polite");
            main = el("div", undefined, "aw-main");
            dialog.append(header, nav, intro, status, main); doc.body.append(dialog);
            dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
            dialog.addEventListener("keydown", event => {
                if (event.key !== "Tab") return;
                const list = [...dialog.querySelectorAll("button, input, textarea, select, a[href]")].filter(n => !n.disabled && !n.hidden && n.getClientRects().length);
                const first = list[0], last = list[list.length - 1];
                if (event.shiftKey && doc.activeElement === first) { event.preventDefault(); last?.focus(); }
                else if (!event.shiftKey && doc.activeElement === last) { event.preventDefault(); first?.focus(); }
            });
            win.addEventListener("beforeunload", event => { if (dialog.open && (dirty || busy)) { event.preventDefault(); event.returnValue = ""; } });
        }
        async function initialize() {
            const token = ++generation; controller?.abort(); controller = new AbortController();
            main.replaceChildren(el("p", "Loading your workspace…")); message("");
            try {
                const context = await verify(controller.signal);
                const nextStore = model.createStore({ storage, context, verify: () => verify(controller.signal), lock: (key, operation) => win.navigator?.locks ? win.navigator.locks.request(key, operation) : operation() });
                const nextState = await nextStore.load();
                let nextCourses;
                try { nextCourses = await readCourses(controller.signal); courseError = false; }
                catch { nextCourses = []; courseError = true; }
                if (token !== generation || !dialog.open) return;
                store = nextStore; state = nextState; courses = nextCourses; render();
                if (page === "planner") loadPlanner();
            } catch (error) {
                if (token !== generation || !dialog.open) return;
                main.replaceChildren(el("p", "Your workspace could not be loaded. Saved materials have not been changed."), button("Retry", initialize, true));
                message(error.message, true);
            }
        }
        function open(next) {
            if (!labels[next]) return false;
            if (dialog?.open && !safeLeave()) return true;
            if (!dialog) mount();
            const wasOpen = dialog.open; page = next; dirty = false; query = ""; trash = false;
            if (!wasOpen) { returnFocus = doc.activeElement; dialog.showModal(); state = null; initialize(); }
            else if (state) { render(); if (page === "planner") loadPlanner(); }
            heading.textContent = labels[page]; return true;
        }
        function close() {
            if (!safeLeave()) return;
            generation++; plannerSequence++; controller?.abort(); dialog.close(); dirty = false; returnFocus?.focus?.();
        }
        function render() {
            dirty = false; editing = false; main.replaceChildren(); message(""); heading.textContent = labels[page];
            dialog.querySelectorAll("[data-page]").forEach(n => n.setAttribute("aria-current", n.dataset.page === page ? "page" : "false"));
            if (courseError) { const warning = el("div", undefined, "aw-warning"); warning.append(el("p", "Canvas courses could not be read. Personal materials are available; course scores are unavailable."), button("Retry Canvas", initialize)); main.append(warning); }
            if (page === "planner") renderPlanner();
            else if (page === "grades") renderGrades();
            else renderLibrary();
        }
        function renderLibrary() {
            const kind = page;
            const tools = el("div", undefined, "aw-toolbar");
            const search = field(tools, "Search", query, "search", { maxLength: 200 });
            // Search updates the list only, preserving focus and the typed selection.
            search.addEventListener("input", () => { query = search.value; dirty = false; listItems(); });
            select(tools, "Course", courseChoices(), courseFilter, value => { courseFilter = value; listItems(); });
            select(tools, "Sort", [["updated", "Recently edited"], ["title", "Title"]], sort, value => { sort = value; listItems(); });
            select(tools, "Show", [["active", "Library"], ["trash", "Trash"]], trash ? "trash" : "active", value => { trash = value === "trash"; listItems(); });
            tools.append(button(kind === "notes" ? "New note" : "New study set", () => editMaterial(kind, recordBase()), true)); main.append(tools);
            const list = el("div", undefined, "aw-list"); main.append(list);
            function listItems() {
                list.replaceChildren();
                const rows = state[kind].filter(r => Boolean(r.deleted) === trash && (!courseFilter || r.courseId === courseFilter) && `${r.title} ${r.body || ""} ${(r.cards || []).map(c => `${c.question} ${c.answer}`).join(" ")}`.toLowerCase().includes(query.toLowerCase())).sort((a,b) => sort === "title" ? a.title.localeCompare(b.title) : b.updatedAt-a.updatedAt);
                if (!rows.length) list.append(el("h2", trash ? "Trash is empty" : query || courseFilter ? "No matching materials" : kind === "notes" ? "Keep your course notes together" : "Build your first study set"), el("p", trash ? "Deleted materials appear here and can be restored." : "Create a material above, or change your search and course filter."));
                rows.forEach(r => {
                    const row = el("article", undefined, "aw-row"), text = el("div");
                    text.append(el("h2", r.title), el("p", `${courseName(r.courseId)} · ${new Date(r.updatedAt).toLocaleDateString()}${kind === "study" ? ` · ${r.cards.length} cards · ${r.cards.filter(c => (c.correct || 0) > (c.missed || 0)).length} learning well` : ""}`));
                    const actions = el("div", undefined, "aw-actions");
                    if (trash) actions.append(button("Restore", () => toggleTrash(kind, r)));
                    else {
                        actions.append(button("Edit", () => editMaterial(kind, r)));
                        if (kind === "study") actions.append(button("Review", () => practice(r, false)), button("Practice answers", () => practice(r, true)));
                        actions.append(button("Move to trash", () => toggleTrash(kind, r)));
                    }
                    row.append(text, actions); list.append(row);
                });
            }
            listItems();
        }
        function previewMarkdown(parent, source) {
            parent.replaceChildren();
            // An intentionally small Markdown subset; all source is text, never HTML.
            source.split("\n").forEach(line => {
                const h = /^(#{1,3})\s+(.*)$/.exec(line);
                const n = el(h ? `h${h[1].length + 1}` : "p");
                const content = h ? h[2] : line;
                content.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).forEach(part => {
                    if (part.startsWith("**") && part.endsWith("**")) n.append(el("strong", part.slice(2,-2)));
                    else if (part.startsWith("`") && part.endsWith("`")) n.append(el("code", part.slice(1,-1)));
                    else n.append(doc.createTextNode(part));
                }); parent.append(n);
            });
        }
        function editMaterial(kind, original) {
            editing = true; main.replaceChildren(); const f = form();
            const title = field(f, "Title", original.title, "text", { required: true, maxLength: 160 });
            const choices = courseChoices(false); if (original.courseId && !choices.some(c => c[0] === original.courseId)) choices.push([original.courseId, courseName(original.courseId)]);
            const course = select(f, "Course", choices, original.courseId, () => { dirty = true; });
            if (kind === "notes") {
                const body = field(f, "Note · Markdown headings, bold and code supported", original.body || "", "textarea", { maxLength: 100000, rows: 16 });
                const preview = el("div", undefined, "aw-preview"); preview.hidden = true;
                f.append(button("Toggle preview", () => { preview.hidden = !preview.hidden; previewMarkdown(preview, body.value); }), preview);
                body.addEventListener("input", () => { if (!preview.hidden) previewMarkdown(preview, body.value); });
                formActions(f, () => saveRecord(kind, { ...original, title: title.value.trim() || "Untitled note", courseId: course.value, body: body.value }));
            } else {
                const cardList = el("div", undefined, "aw-card-editor"); f.append(cardList);
                let cards = (original.cards || []).map(c => ({ ...c })); if (!cards.length) cards.push({ id: win.crypto.randomUUID(), question: "", answer: "" });
                function drawCards() {
                    cardList.replaceChildren(); cards.forEach((card, i) => {
                        const row = el("fieldset"); row.append(el("legend", `Card ${i+1}`));
                        const q = field(row, "Question", card.question, "textarea", { required: true, maxLength: 4000, rows: 2 });
                        const a = field(row, "Answer", card.answer, "textarea", { required: true, maxLength: 4000, rows: 2 });
                        q.addEventListener("input", () => { card.question = q.value; card.correct = 0; card.missed = 0; });
                        a.addEventListener("input", () => { card.answer = a.value; card.correct = 0; card.missed = 0; });
                        row.append(button("Remove card", () => { cards.splice(i,1); dirty = true; drawCards(); })); cardList.append(row);
                    });
                }
                drawCards(); f.append(button("Add card", () => { if (cards.length >= 200) { message("A set supports up to 200 cards.", true); return; } cards.push({ id: win.crypto.randomUUID(), question: "", answer: "" }); dirty = true; drawCards(); }));
                formActions(f, () => {
                    if (!cards.length || cards.some(c => !c.question.trim() || !c.answer.trim())) { message("Add at least one card with a question and answer.", true); return; }
                    saveRecord(kind, { ...original, title: title.value.trim() || "Untitled study set", courseId: course.value, cards });
                });
            }
            title.focus();
        }
        function practice(set, typed, selected = set.cards) {
            let index = 0, missed = [], answered = false;
            function show() {
                main.replaceChildren(); const area = el("div", undefined, "aw-practice"); main.append(area);
                area.append(button("Back to library", render), el("h2", set.title));
                if (index >= selected.length) {
                    area.append(el("h3", "Session complete"), el("p", `${selected.length-missed.length} of ${selected.length} cards recalled. Progress saved on this device.`));
                    if (missed.length) area.append(button("Retry missed cards", () => practice(set, typed, missed), true)); return;
                }
                const card = selected[index]; answered = false;
                area.append(el("p", `Card ${index+1} of ${selected.length}`), el("h3", card.question));
                const answer = el("p", card.answer, "aw-answer"); answer.hidden = true; area.append(answer);
                const actions = el("div", undefined, "aw-actions"); area.append(actions);
                if (typed) {
                    const input = field(area, "Your answer", "", "text", { maxLength: 4000 });
                    input.addEventListener("input", () => { dirty = false; });
                    const check = button("Check answer", () => { if (!answered) { answered = true; answer.hidden = false; const correct = model.answerMatches(input.value, card.answer); actions.replaceChildren(el("p", correct ? "Correct" : "Not quite — compare with the answer."), button("Save result & next", () => record(correct), true)); } }, true);
                    actions.append(check); input.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); check.click(); } }); input.focus();
                } else actions.append(button("Reveal answer", () => { answer.hidden = false; actions.replaceChildren(button("Still learning", () => record(false)), button("Got it", () => record(true), true)); }, true));
                async function record(correct) {
                    await write(data => {
                        const current = data.study.find(s => s.id === set.id && !s.deleted)?.cards.find(c => c.id === card.id);
                        if (!current || current.question !== card.question || current.answer !== card.answer) throw new Error("This card changed in another workspace. Reopen the study set.");
                        const key = correct ? "correct" : "missed"; current[key] = (current[key] || 0)+1; current.lastReviewed = Date.now();
                    }, () => { if (!correct) missed.push(card); index++; show(); });
                }
            }
            show();
        }
        async function loadPlanner() {
            const seq = ++plannerSequence; plannerLoading = true; plannerError = "";
            const range = model.range(date, mode); if (state && page === "planner") render();
            try { const items = await readPlanner(range, controller.signal); if (seq === plannerSequence) plannerItems = items; }
            catch (error) { if (seq === plannerSequence) { plannerItems = []; plannerError = "Canvas deadlines could not be loaded. Retry to see your full schedule."; } }
            finally { if (seq === plannerSequence) { plannerLoading = false; if (dialog.open && page === "planner" && !editing) render(); } }
        }
        function renderPlanner() {
            const tools = el("div", undefined, "aw-toolbar");
            select(tools, "View", [["day", "Day"], ["week", "Week"], ["month", "Month"]], mode, v => { mode = v; loadPlanner(); });
            const dateInput = field(tools, "Starting date", model.dateKey(date), "date");
            dateInput.addEventListener("change", () => { if (dateInput.value) { date = new Date(`${dateInput.value}T12:00:00`); dirty = false; loadPlanner(); } });
            select(tools, "Course", courseChoices(), courseFilter, v => { courseFilter = v; render(); });
            select(tools, "Show", [["active", "Schedule"], ["trash", "Trash"]], trash ? "trash" : "active", v => { trash = v === "trash"; render(); });
            tools.append(button("New task", () => editTask({ ...recordBase(), date: model.dateKey(date), done: false }), true)); main.append(tools);
            const nav = el("div", undefined, "aw-actions");
            function move(step) { if (mode === "month") date = new Date(date.getFullYear(),date.getMonth()+step,1); else date.setDate(date.getDate()+step*(mode === "week" ? 7 : 1)); loadPlanner(); }
            nav.append(button("Previous", () => move(-1)), button("Today", () => { date = new Date(); loadPlanner(); }), button("Next", () => move(1)), button("Refresh deadlines", loadPlanner)); main.append(nav);
            const {start, end} = model.range(date, mode);
            main.append(el("h2", `${start.toLocaleDateString(undefined,{month:"long",day:"numeric",year:"numeric"})}${mode === "day" ? "" : ` – ${new Date(end.getTime()-1).toLocaleDateString(undefined,{month:"long",day:"numeric"})}`}`));
            if (plannerLoading && !trash) main.append(el("p", "Loading Canvas deadlines…"));
            if (plannerError && !trash) main.append(el("p", plannerError, "aw-warning"));
            const list = el("div", undefined, "aw-schedule"); main.append(list);
            const local = state.planner.filter(r => Boolean(r.deleted) === trash && (!courseFilter || r.courseId === courseFilter));
            const remote = !trash && !plannerLoading ? plannerItems.filter(r => !courseFilter || String(r.course_id) === courseFilter) : [];
            const rows = [...local.map(r => ({ date: r.date, local: r })), ...remote.map(r => ({ date: model.dateKey(new Date(r.plannable_date)), remote: r }))].filter(r => trash || (r.date >= model.dateKey(start) && r.date < model.dateKey(end))).sort((a,b) => a.date.localeCompare(b.date));
            if (!rows.length) list.append(el("p", trash ? "No tasks in trash." : plannerLoading || plannerError ? "Personal tasks in this range will appear here." : "Nothing scheduled in this range. Add a personal task or change the date."));
            let lastDay;
            rows.forEach(({date: day, local: task, remote: item}) => {
                if (day !== lastDay) { list.append(el("h3", new Date(`${day}T12:00:00`).toLocaleDateString(undefined,{weekday:"long",month:"short",day:"numeric"}))); lastDay = day; }
                const row = el("article", undefined, "aw-row"), content = el("div"), actions = el("div", undefined, "aw-actions");
                if (task) {
                    content.append(el("h4", `${task.done ? "Completed: " : ""}${task.title}`), el("p", `${courseName(task.courseId)} · Personal task`));
                    if (!trash) actions.append(button(task.done ? "Mark incomplete" : "Complete", () => write(data => { const r = data.planner.find(r => r.id === task.id); if (!r) throw new Error("Task no longer exists."); r.done = !r.done; })), button("Edit", () => editTask(task)));
                    actions.append(button(trash ? "Restore" : "Move to trash", () => toggleTrash("planner", task)));
                } else {
                    content.append(link(item.plannable?.title || "Canvas deadline", item.html_url || item.plannable?.html_url || "/"), el("p", `${courseName(item.course_id)} · Canvas · ${new Date(item.plannable_date).toLocaleTimeString(undefined,{hour:"numeric",minute:"2-digit"})}`));
                }
                row.append(content, actions); list.append(row);
            });
        }
        function editTask(task) {
            editing = true; main.replaceChildren(); const f = form();
            const title = field(f, "Task", task.title, "text", { required: true, maxLength: 160 });
            const due = field(f, "Date", task.date, "date", { required: true });
            const choices = courseChoices(false); if (task.courseId && !choices.some(c => c[0] === task.courseId)) choices.push([task.courseId, courseName(task.courseId)]);
            const course = select(f, "Course", choices, task.courseId, () => { dirty = true; });
            formActions(f, () => saveRecord("planner", { ...task, title: title.value.trim() || "Untitled task", date: due.value, courseId: course.value })); title.focus();
        }
        function renderGrades() {
            main.append(el("p", "Estimates use Canvas current course scores and your GPA scale. Enter credits to count a course. What-if scores and goals stay local; your official grades remain in Canvas."));
            if (courseError) return;
            const f = form(), draft = JSON.parse(JSON.stringify(state.grades));
            const estimates = el("p", undefined, "aw-grade-summary"); f.append(estimates);
            let whatIf = false;
            select(f, "Calculate using", [["current", "Current Canvas scores"], ["whatif", "What-if scores"]], "current", v => { whatIf = v === "whatif"; update(); });
            const rows = el("div", undefined, "aw-grade-rows"); f.append(rows);
            courses.forEach(course => {
                const id = String(course.id), config = draft.courses[id] ||= {};
                const row = el("fieldset"); row.append(el("legend", course.name || `Course ${id}`));
                const summary = model.gradeSummary([course], draft, getBounds(), gpa).rows[0];
                row.append(el("p", summary.current === null ? "Current score unavailable" : `Current score: ${summary.current}% · ${summary.letter || "No GPA scale"}`));
                const controls = el("div", undefined, "aw-toolbar"); row.append(controls);
                select(controls, "Count in GPA", [["yes", "Included"], ["no", "Excluded"]], config.included === false ? "no" : "yes", v => { config.included = v === "yes"; dirty = true; update(); });
                [["credits", "Credits", 60], ["goal", "Goal %", 200], ["whatIf", "What-if %", 200]].forEach(([key,label,max]) => {
                    const input = field(controls, label, config[key] ?? "", "number", { min: 0, max, step: "any" });
                    input.addEventListener("input", () => { config[key] = input.value; update(); });
                });
                const goal = el("p"); goal.dataset.goalCourse = id; row.append(goal, link("Open Canvas gradebook", `/courses/${id}/grades`)); rows.append(row);
            });
            if (!courses.length) rows.append(el("p", "No active courses returned by Canvas."));
            const prior = el("div", undefined, "aw-toolbar"); f.append(prior);
            [["priorGpa", "Prior GPA", 10], ["priorCredits", "Prior credits", 10000]].forEach(([key,label,max]) => { const input = field(prior, label, draft[key], "number", { min: 0, max, step: "any" }); input.addEventListener("input", () => { draft[key] = input.value; update(); }); });
            f.append(button("Edit GPA scale", () => { if (safeLeave()) { dirty = false; close(); openSettings(); } }));
            formActions(f, () => write(data => { data.grades = draft; }));
            function update() {
                const result = model.gradeSummary(courses,draft,getBounds(),gpa,whatIf);
                estimates.textContent = `${whatIf ? "What-if" : "Current"} term GPA: ${gpa.formatGpa(result.term)} · Cumulative GPA: ${gpa.formatGpa(result.cumulative)}`;
                result.rows.forEach(r => {
                    const target = rows.querySelector(`[data-goal-course="${r.course.id}"]`);
                    if (target) target.textContent = r.config.goal === undefined || r.config.goal === "" || r.score === null ? "" : `Goal: ${r.config.goal}% · ${r.score >= Number(r.config.goal) ? "At or above goal" : `${(Number(r.config.goal)-r.score).toFixed(1)} percentage points below goal`}`;
                });
            }
            update();
        }
        return Object.freeze({ open, close });
    }
    return Object.freeze({ createWorkspace });
}));
