(function (root, factory) {
    "use strict";
    const api = factory();
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasWorkspacePlanner = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    /*
     * THESIS: one calm, legible planning field separates authoritative deadlines from personal time blocks.
     * OWN-WORLD: navy controls, gold selection, parchment calendar, crisp rules, compact source color.
     * STORY: verify access, scan the period, inspect truth, then explicitly schedule or edit personal time.
     * FIRST VIEWPORT: compact toolbar over one calendar field with an adjacent, non-modal detail editor.
     * FORM: established APStudyCanvas Operate surface, extending the approved shell and Nest calendar grammar.
     */

    const VIEWS = new Set(["day", "week", "month"]);
    const HOUR_HEIGHT = 56;
    const DEFAULT_COLOR = "#355f8a";
    const PREF_VERSION = 1;
    const globalRoot = typeof globalThis !== "undefined" ? globalThis : null;

    function clone(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }
    function clean(value, max = 240) {
        return typeof value === "string"
            ? value.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, max)
            : "";
    }
    function validDate(value) {
        const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
        return Number.isFinite(date.getTime()) ? date : null;
    }
    function safeColor(value) { return /^#[0-9a-f]{6}$/i.test(String(value || "")) ? String(value) : DEFAULT_COLOR; }
    function isAllDay(event) { return event?.all_day === true || event?.is_all_day === true || event?.isAllDay === true; }
    function isPersonal(event) { return Boolean(event?.editable === true && ((["user", "native"].includes(event?.source_type) && /^user:/.test(String(event?.event_ref || ""))) || (event?.source_type === "external" && /^external:[a-f0-9]{32}$/.test(String(event?.event_ref || ""))))); }
    function eventId(event) { return clean(event?.event_ref || event?.id, 320); }
    function sourceLabel(event) { return clean(event?.source_label || event?.calendar_label || event?.calendar_id, 120) || (isPersonal(event) ? "Personal" : "Canvas"); }
    function eventColor(event) { return safeColor(event?.source_color || event?.color); }
    function pad(value) { return String(value).padStart(2, "0"); }
    function dateInputValue(value) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return String(value);
        const date = validDate(value);
        return date ? `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` : "";
    }
    function timeInputValue(value) {
        const date = validDate(value);
        return date ? `${pad(date.getHours())}:${pad(date.getMinutes())}` : "";
    }
    function fromInputs(date, time = "00:00") {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return null;
        const [year, month, day] = date.split("-").map(Number);
        const [hour, minute] = time.split(":").map(Number);
        const value = new Date(year, month - 1, day, hour, minute, 0, 0);
        return value.getFullYear() === year && value.getMonth() === month - 1 && value.getDate() === day ? value : null;
    }
    function startOfDay(value) { const date = validDate(value) || new Date(); date.setHours(0, 0, 0, 0); return date; }
    function shiftDate(value, days = 0, months = 0) {
        const date = validDate(value) || new Date();
        if (months) date.setMonth(date.getMonth() + months);
        if (days) date.setDate(date.getDate() + days);
        return date;
    }
    function dayKey(value) { return dateInputValue(value); }
    function formatDate(value, options) { const date = validDate(value); return date ? new Intl.DateTimeFormat(undefined, options).format(date) : "Unknown date"; }
    function formatCivilDate(value, options) {
        const key = String(value || "").slice(0, 10);
        const date = /^\d{4}-\d{2}-\d{2}$/.test(key) ? fromInputs(key, "12:00") : validDate(value);
        return date ? new Intl.DateTimeFormat(undefined, options).format(date) : "Unknown date";
    }
    function formatTime(value) { return formatDate(value, { hour: "numeric", minute: "2-digit" }); }
    function formatRange(event) {
        if (isAllDay(event)) return `${formatCivilDate(event.start, { weekday: "short", month: "short", day: "numeric" })} · All day`;
        return `${formatDate(event.start, { weekday: "short", month: "short", day: "numeric" })} · ${formatTime(event.start)}–${formatTime(event.end)}`;
    }
    function accessCopy(code) {
        const values = {
            PLANNER_ACCOUNT_UNVERIFIED: ["Connect Planner", "Planner needs a verified Canvas and Nest account before it can load calendar data.", "Connect Nest", "connect"],
            PLANNER_READ_CAPABILITY_REQUIRED: ["Planner is not available", "This Nest account does not currently provide the calendar capabilities Planner requires.", "Check connection", "connect"],
            PLANNER_READ_CONSENT_REQUIRED: ["Allow calendar access", "Review calendar access before Planner reads any existing events or deadlines.", "Review access", "consent"],
            PLANNER_WRITE_CONSENT_REQUIRED: ["Editing is read-only", "You can view the calendar, but personal event changes need separate write permission.", "Review editing access", "consent"]
        };
        return values[code] || ["Planner is unavailable", "Planner could not verify calendar access. Reload Canvas and try again.", "Check connection", "connect"];
    }
    function preferenceKey(context) {
        const scope = clean(context?.account?.scope, 180);
        return scope ? `apstudycanvas.planner.ui.v${PREF_VERSION}:${scope}` : null;
    }

    function createWorkspacePlanner(options = {}) {
        const doc = options.document || globalRoot?.document;
        const win = options.window || globalRoot;
        const adapter = options.adapter;
        const hostOption = options.host;
        const preferences = options.preferences || null;
        const now = typeof options.now === "function" ? options.now : () => new Date();
        const optionDirtyListener = typeof options.onDirtyChange === "function" ? options.onDirtyChange : null;

        let context = null;
        let host = null;
        let rootNode = null;
        let unsubscribe = null;
        let state = null;
        let view = "week";
        let anchor = startOfDay(now());
        let selected = null;
        let editor = null;
        let dirty = false;
        let busy = false;
        let disposed = false;
        let generation = 0;
        let notice = { text: "", kind: "" };
        let importSelection = new Set();
        let accountScope = "";

        const setDirty = value => {
            const next = value === true;
            if (dirty === next) return;
            dirty = next;
            try { (optionDirtyListener || context?.onDirtyChange)?.(next); } catch (error) {}
        };
        const el = (tag, text, className) => {
            const node = doc.createElement(tag);
            if (text !== undefined) node.textContent = text;
            if (className) node.className = className;
            return node;
        };
        const button = (text, action, className = "", role = "") => {
            const node = el("button", text, className);
            node.type = "button";
            if (role) node.dataset.plannerRole = role;
            node.addEventListener("click", () => { if (!disposed && !busy) void action(node); });
            return node;
        };
        const field = (labelText, control) => {
            const label = el("label", undefined, "workspace-planner-field");
            label.append(el("span", labelText), control);
            return label;
        };
        const announce = (text, kind = "") => {
            notice = { text: clean(text, 320), kind };
            try { context?.status?.(notice.text, kind === "error"); } catch (error) {}
        };
        function role(name) {
            if (!rootNode) return null;
            const visit = node => {
                if (node.dataset?.plannerRole === name) return node;
                for (const child of Array.from(node.children || [])) { const found = visit(child); if (found) return found; }
                return null;
            };
            return visit(rootNode);
        }
        async function readPreferences() {
            const key = preferenceKey(context);
            if (!key || !preferences?.get) return;
            try {
                const response = await preferences.get(key);
                const value = response?.[key] || response;
                if (VIEWS.has(value?.view)) view = value.view;
                if (/^\d{4}-\d{2}-\d{2}$/.test(value?.date || "")) anchor = fromInputs(value.date) || anchor;
            } catch (error) { announce("Planner preferences could not be loaded. This session starts in Week view.", "error"); }
        }
        async function writePreferences() {
            const key = preferenceKey(context);
            if (!key || !preferences?.set) return;
            const value = { version: PREF_VERSION, view, date: dayKey(anchor) };
            try {
                if (preferences.set.length >= 2) await preferences.set(key, value);
                else await preferences.set({ [key]: value });
            } catch (error) { announce("Planner could not remember this view. Calendar data was not changed.", "error"); render(); }
        }
        function routeIntent(route = {}) {
            return {
                view: VIEWS.has(route.view) ? route.view : null,
                date: /^\d{4}-\d{2}-\d{2}$/.test(route.date || "") ? fromInputs(route.date) : null,
                eventId: clean(route.eventId || route.event, 320)
            };
        }
        async function reload({ focus = false } = {}) {
            const token = ++generation;
            render();
            await adapter.loadRange({ anchor, view, useMonthGrid: view === "month" });
            if (disposed || token !== generation) return;
            if (selected) selected = state?.events?.find(item => eventId(item) === eventId(selected)) || selected;
            render();
            if (focus) role("calendar")?.focus?.({ preventScroll: true });
        }
        async function chooseView(next) {
            if (!VIEWS.has(next) || next === view) return;
            view = next;
            selected = null;
            await writePreferences();
            await reload({ focus: true });
        }
        async function navigatePeriod(direction) {
            anchor = view === "month" ? shiftDate(anchor, 0, direction) : shiftDate(anchor, direction * (view === "week" ? 7 : 1));
            selected = null;
            await writePreferences();
            await reload({ focus: true });
        }
        async function goToday() {
            anchor = startOfDay(now());
            await writePreferences();
            await reload({ focus: true });
        }
        function eventsForDate(date, allDay) {
            const key = dayKey(date);
            return (state?.visibleEvents || []).filter(event => {
                if (isAllDay(event)) {
                    const startKey = String(event.start || "").slice(0, 10);
                    let endKey = String(event.end || "").slice(0, 10);
                    if (!/^\d{4}-\d{2}-\d{2}$/.test(startKey)) return false;
                    if (!/^\d{4}-\d{2}-\d{2}$/.test(endKey) || endKey <= startKey) endKey = dayKey(shiftDate(fromInputs(startKey), 1));
                    return (allDay === undefined || allDay === true) && startKey <= key && key < endKey;
                }
                const start = validDate(event.start);
                const end = validDate(event.end) || start;
                if (!start) return false;
                const match = dayKey(start) === key || (start < shiftDate(startOfDay(date), 1) && end > startOfDay(date));
                return match && (allDay === undefined || isAllDay(event) === allDay);
            }).sort((left, right) => Date.parse(left.start) - Date.parse(right.start) || clean(left.title).localeCompare(clean(right.title)));
        }
        function eventButton(event, compact = false) {
            const personal = isPersonal(event);
            const node = button(clean(event.title, 180) || "Untitled event", () => selectEvent(event), `workspace-planner-event${compact ? " is-compact" : ""}${event.completed ? " is-complete" : ""}`, "event");
            node.dataset.eventId = eventId(event);
            node.style.setProperty("--event-color", eventColor(event));
            node.setAttribute("aria-label", `${clean(event.title) || "Untitled event"}, ${formatRange(event)}, ${sourceLabel(event)}. ${personal ? "Editable personal event." : "Authoritative deadline; view only."}`);
            if (personal) {
                node.setAttribute("draggable", "true");
                node.addEventListener("dragstart", eventObject => eventObject.dataTransfer?.setData?.("text/plain", eventId(event)));
            }
            return node;
        }
        function renderToolbar(parent) {
            const bar = el("div", undefined, "workspace-planner-toolbar");
            const views = el("div", undefined, "workspace-planner-view-switch");
            views.setAttribute("role", "group");
            views.setAttribute("aria-label", "Calendar view");
            ["day", "week", "month"].forEach(name => {
                const item = button(name[0].toUpperCase() + name.slice(1), () => chooseView(name), name === view ? "is-active" : "", `view-${name}`);
                item.setAttribute("aria-pressed", String(name === view));
                views.append(item);
            });
            const period = el("div", undefined, "workspace-planner-period-controls");
            period.append(
                button("Previous", () => navigatePeriod(-1), "workspace-planner-icon-button", "previous"),
                button("Today", goToday, "workspace-planner-today", "today"),
                button("Next", () => navigatePeriod(1), "workspace-planner-icon-button", "next")
            );
            const actions = el("div", undefined, "workspace-planner-toolbar-actions");
            const add = button("New time block", () => openNew(now()), "workspace-planner-primary", "new");
            add.disabled = !state?.access?.write;
            actions.append(add, button("Import existing tasks", openImport, "workspace-planner-secondary", "import"));
            bar.append(views, period, actions);
            parent.append(bar);
        }
        function renderFilters(parent) {
            const area = el("div", undefined, "workspace-planner-filterbar");
            const legend = el("div", undefined, "workspace-planner-sources");
            const active = new Set(state?.filters?.sourceIds || []);
            const sources = state?.sources?.length ? state.sources : [...new Map((state?.events || []).map(item => [sourceLabel(item), { id: item.calendar_id || item.source_label || sourceLabel(item), label: sourceLabel(item), color: eventColor(item) }])).values()];
            sources.forEach(source => {
                const id = clean(source.id || source.label, 160);
                const label = el("label", undefined, "workspace-planner-source");
                const input = el("input"); input.type = "checkbox"; input.checked = !active.size || active.has(id);
                input.addEventListener("change", () => {
                    const next = new Set(state?.filters?.sourceIds || sources.map(item => clean(item.id || item.label, 160)));
                    if (input.checked) next.add(id); else next.delete(id);
                    adapter.setFilters({ sourceIds: next.size === sources.length ? [] : [...next] });
                });
                const swatch = el("span", undefined, "workspace-planner-swatch"); swatch.style.setProperty("--source-color", safeColor(source.color));
                label.append(input, swatch, el("span", clean(source.label, 120) || "Calendar")); legend.append(label);
            });
            const completed = el("label", undefined, "workspace-planner-source");
            const completedInput = el("input"); completedInput.type = "checkbox"; completedInput.checked = state?.filters?.showCompleted !== false;
            completedInput.addEventListener("change", () => adapter.setFilters({ showCompleted: completedInput.checked }));
            completed.append(completedInput, el("span", "Completed tasks"));
            area.append(legend, completed); parent.append(area);
        }
        function periodTitle() {
            if (view === "day") return formatDate(anchor, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
            if (view === "month") return formatDate(anchor, { month: "long", year: "numeric" });
            const start = state?.range?.start || anchor;
            const end = shiftDate(validDate(state?.range?.end) || shiftDate(anchor, 7), -1);
            return `${formatDate(start, { month: "short", day: "numeric" })} – ${formatDate(end, { month: "short", day: "numeric", year: "numeric" })}`;
        }
        function renderHeader(parent) {
            const header = el("header", undefined, "workspace-planner-header");
            const copy = el("div"); copy.append(el("h1", "Planner"), el("p", "Canvas deadlines stay authoritative. Personal time blocks are scheduled separately."));
            const title = el("strong", periodTitle(), "workspace-planner-period-title"); title.setAttribute("aria-live", "polite");
            header.append(copy, title); parent.append(header);
        }
        function renderAllDay(parent, days) {
            const row = el("div", undefined, "workspace-planner-all-day");
            row.style.setProperty("--planner-days", String(days.length));
            row.append(el("span", "All day", "workspace-planner-axis-label"));
            days.forEach(date => {
                const lane = el("div", undefined, "workspace-planner-all-day-lane");
                lane.dataset.date = dayKey(date);
                eventsForDate(date, true).forEach(event => lane.append(eventButton(event, true)));
                row.append(lane);
            });
            parent.append(row);
        }
        function positionedEvents(date) {
            const source = eventsForDate(date, false).map(event => ({ event, start: validDate(event.start), end: validDate(event.end) }));
            const columns = [];
            return source.map(item => {
                let column = columns.findIndex(end => end <= item.start);
                if (column < 0) { column = columns.length; columns.push(item.end); } else columns[column] = item.end;
                const overlaps = source.filter(other => other.start < item.end && other.end > item.start).length;
                return { ...item, column, columns: Math.max(1, overlaps) };
            });
        }
        function renderTimeGrid(parent, days) {
            const scroller = el("div", undefined, "workspace-planner-time-scroller"); scroller.dataset.plannerRole = "calendar"; scroller.tabIndex = 0;
            const grid = el("div", undefined, "workspace-planner-time-grid"); grid.style.setProperty("--planner-days", String(days.length));
            const axis = el("div", undefined, "workspace-planner-time-axis");
            for (let hour = 0; hour < 24; hour += 1) axis.append(el("span", formatTime(new Date(2026, 0, 1, hour)), "workspace-planner-hour"));
            grid.append(axis);
            days.forEach(date => {
                const column = el("div", undefined, `workspace-planner-day-column${dayKey(date) === dayKey(now()) ? " is-today" : ""}`);
                column.dataset.date = dayKey(date);
                column.addEventListener("dblclick", eventObject => {
                    const y = Number(eventObject.offsetY) || 9 * HOUR_HEIGHT;
                    const start = fromInputs(dayKey(date), `${pad(Math.floor(y / HOUR_HEIGHT))}:${pad(Math.round(((y % HOUR_HEIGHT) / HOUR_HEIGHT) * 4) * 15 % 60)}`);
                    openNew(start || date);
                });
                column.addEventListener("dragover", eventObject => eventObject.preventDefault?.());
                column.addEventListener("drop", eventObject => { eventObject.preventDefault?.(); void dropEvent(eventObject, date); });
                positionedEvents(date).forEach(item => {
                    const node = eventButton(item.event);
                    const startMinutes = item.start.getHours() * 60 + item.start.getMinutes();
                    const duration = Math.max(15, (item.end - item.start) / 60000);
                    node.style.top = `${startMinutes / 60 * HOUR_HEIGHT}px`;
                    node.style.height = `${Math.max(24, duration / 60 * HOUR_HEIGHT)}px`;
                    node.style.left = `${item.column / item.columns * 100}%`;
                    node.style.width = `${100 / item.columns}%`;
                    const time = el("small", formatTime(item.event.start)); node.append(time); column.append(node);
                });
                if (dayKey(date) === dayKey(now())) {
                    const instant = validDate(now());
                    const marker = el("span", undefined, "workspace-planner-now");
                    marker.style.top = `${(instant.getHours() * 60 + instant.getMinutes()) / 60 * HOUR_HEIGHT}px`;
                    marker.setAttribute("aria-label", `Current time ${formatTime(instant)}`);
                    column.append(marker);
                }
                grid.append(column);
            });
            scroller.append(grid); parent.append(scroller);
        }
        function renderDay(parent) {
            const date = startOfDay(anchor);
            const frame = el("section", undefined, "workspace-planner-calendar workspace-planner-day");
            const head = el("div", undefined, "workspace-planner-day-heading");
            head.append(el("span", "Time"), el("strong", formatDate(date, { weekday: "short", month: "short", day: "numeric" }))); frame.append(head);
            renderAllDay(frame, [date]); renderTimeGrid(frame, [date]);
            const tasks = el("aside", undefined, "workspace-planner-day-tasks"); tasks.append(el("h2", "Tasks on this day"));
            const due = eventsForDate(date).filter(event => !isPersonal(event));
            if (!due.length) tasks.append(el("p", "No Canvas deadlines are shown for this day."));
            else due.forEach(event => tasks.append(eventButton(event, true)));
            const wrap = el("div", undefined, "workspace-planner-day-layout"); wrap.append(frame, tasks); parent.append(wrap);
        }
        function renderWeek(parent) {
            const rangeStart = validDate(state?.range?.start) || shiftDate(startOfDay(anchor), -anchor.getDay());
            const days = Array.from({ length: 7 }, (_, index) => shiftDate(rangeStart, index));
            const frame = el("section", undefined, "workspace-planner-calendar workspace-planner-week");
            const head = el("div", undefined, "workspace-planner-week-heading"); head.style.setProperty("--planner-days", "7"); head.append(el("span", "Time"));
            days.forEach(date => { const cell = button(formatDate(date, { weekday: "short", month: "numeric", day: "numeric" }), async () => { anchor = date; await chooseView("day"); }, dayKey(date) === dayKey(now()) ? "is-today" : ""); head.append(cell); });
            frame.append(head); renderAllDay(frame, days); renderTimeGrid(frame, days); parent.append(frame);
        }
        function monthDays() {
            const start = validDate(state?.range?.start) || shiftDate(new Date(anchor.getFullYear(), anchor.getMonth(), 1), -new Date(anchor.getFullYear(), anchor.getMonth(), 1).getDay());
            const end = validDate(state?.range?.end) || shiftDate(start, 42);
            const count = Math.max(35, Math.min(42, Math.round((end - start) / 86400000)));
            return Array.from({ length: count }, (_, index) => shiftDate(start, index));
        }
        function renderMonth(parent) {
            const grid = el("section", undefined, "workspace-planner-month"); grid.dataset.plannerRole = "calendar"; grid.tabIndex = 0;
            ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].forEach(name => grid.append(el("span", name, "workspace-planner-month-weekday")));
            monthDays().forEach(date => {
                const cell = el("div", undefined, `workspace-planner-month-day${date.getMonth() !== anchor.getMonth() ? " is-adjacent" : ""}${dayKey(date) === dayKey(now()) ? " is-today" : ""}`);
                const open = button(String(date.getDate()), async () => { anchor = date; await chooseView("day"); }, "workspace-planner-month-number"); open.setAttribute("aria-label", `Open ${formatDate(date, { weekday: "long", month: "long", day: "numeric" })} in Day view`); cell.append(open);
                const events = eventsForDate(date);
                events.slice(0, 3).forEach(event => cell.append(eventButton(event, true)));
                if (events.length > 3) cell.append(button(`+${events.length - 3} more`, async () => { anchor = date; await chooseView("day"); }, "workspace-planner-more"));
                grid.append(cell);
            });
            parent.append(grid);
        }
        function selectEvent(event) { selected = event; editor = null; setDirty(false); render(); role("details")?.focus?.({ preventScroll: true }); }
        function openNew(date) {
            const range = adapter.helpers.defaultTimedRange(validDate(date) || now());
            selected = null;
            editor = { mode: "create", title: "", description: "", start: range.start, end: range.end, all_day: false, calendar_id: state?.sources?.find(source => source.editable !== false && (state.access?.nativeWrite !== false || String(source.id).startsWith("external:")))?.id || "" };
            setDirty(true); render(); role("title")?.focus?.({ preventScroll: true });
        }
        function openEdit() {
            if (!selected || !isPersonal(selected)) return;
            editor = { mode: "edit", event: selected, title: selected.title || "", description: selected.description || "", location: selected.location || "", start: selected.start, end: selected.end, all_day: isAllDay(selected), calendar_id: selected.calendar_id || "", color: eventColor(selected) };
            setDirty(false); render(); role("title")?.focus?.({ preventScroll: true });
        }
        function updateEditor(key, value) { if (!editor) return; editor[key] = value; setDirty(true); }
        function editorPayload() {
            const startDate = role("start-date")?.value; const endDate = role("end-date")?.value || startDate;
            const allDay = role("all-day")?.checked === true;
            const start = fromInputs(startDate, allDay ? "00:00" : role("start-time")?.value);
            let end = fromInputs(endDate, allDay ? "00:00" : role("end-time")?.value);
            if (allDay && end && start && end <= start) end = shiftDate(start, 1);
            return {
                title: role("title")?.value || "", description: role("description")?.value || "", start: start?.toISOString(), end: end?.toISOString(),
                ...(editor.event?.source_type === "external" ? {location: role("location")?.value || ""} : {}), all_day: allDay, calendar_id: role("calendar")?.value || "", color: role("color")?.value || DEFAULT_COLOR
            };
        }
        async function saveEditor() {
            if (!editor) return;
            const payload = editorPayload();
            if (!clean(payload.title)) { announce("Add a title before saving. Your draft is still here.", "error"); render(); role("title")?.focus?.(); return; }
            if (!validDate(payload.start) || !validDate(payload.end) || Date.parse(payload.start) >= Date.parse(payload.end)) { announce("Choose an end after the start. Times snap to 15-minute increments.", "error"); render(); return; }
            busy = true; announce("Saving personal time block…"); render();
            const result = editor.mode === "create" ? await adapter.createEvent(payload, { draftId: "planner-ui-create" }) : await adapter.updateEvent(editor.event, payload, { draftId: `planner-ui-edit:${eventId(editor.event)}` });
            busy = false;
            if (!result?.ok) {
                const permissionCode = ["PLANNER_ACCOUNT_UNVERIFIED", "PLANNER_READ_CAPABILITY_REQUIRED", "PLANNER_READ_CONSENT_REQUIRED", "PLANNER_WRITE_CONSENT_REQUIRED"].includes(result?.code);
                announce(`${permissionCode ? accessCopy(result.code)[1] : "This personal time block could not be saved."} Your draft is still here; try again.`, "error");
                setDirty(true); render(); return;
            }
            editor = null; selected = null; setDirty(false); announce("Personal time block saved.", "saved"); await reload();
        }
        async function deleteSelected() {
            if (!selected || !isPersonal(selected)) return;
            if (win?.confirm && win.confirm(`Delete “${clean(selected.title) || "this time block"}”?`) !== true) return;
            busy = true; announce("Deleting personal time block…"); render();
            const result = await adapter.deleteEvent(selected, { draftId: `planner-ui-delete:${eventId(selected)}` }); busy = false;
            if (!result?.ok) { announce("This time block could not be deleted. Nothing was removed; try again.", "error"); render(); return; }
            selected = null; announce("Personal time block deleted.", "saved"); await reload();
        }
        async function adjustSelected(kind, minutes) {
            if (!selected || !isPersonal(selected)) return;
            const start = validDate(selected.start); const end = validDate(selected.end); if (!start || !end) return;
            let result;
            if (kind === "move") result = await adapter.moveEvent(selected, new Date(start.getTime() + minutes * 60000).toISOString(), new Date(end.getTime() + minutes * 60000).toISOString(), { draftId: `planner-ui-move:${eventId(selected)}` });
            else result = await adapter.resizeEvent(selected, new Date(Math.max(start.getTime() + 15 * 60000, end.getTime() + minutes * 60000)).toISOString(), { draftId: `planner-ui-resize:${eventId(selected)}` });
            if (!result?.ok) { announce("The schedule change was not saved. The original time is still shown.", "error"); render(); return; }
            announce("Personal time block updated.", "saved"); await reload();
        }
        async function dropEvent(eventObject, date) {
            const id = clean(eventObject.dataTransfer?.getData?.("text/plain"), 320);
            const item = state?.events?.find(event => eventId(event) === id);
            if (!item || !isPersonal(item)) return;
            const oldStart = validDate(item.start); const oldEnd = validDate(item.end); if (!oldStart || !oldEnd) return;
            const nextStart = fromInputs(dayKey(date), timeInputValue(oldStart)); const nextEnd = new Date(nextStart.getTime() + (oldEnd - oldStart));
            const result = await adapter.moveEvent(item, nextStart.toISOString(), nextEnd.toISOString(), { draftId: `planner-ui-drop:${id}` });
            if (!result?.ok) announce("The time block was not moved. Use the detail controls to try again.", "error");
            else announce("Personal time block moved.", "saved");
            await reload();
        }
        function openImport() {
            const candidates = (state?.events || []).filter(event => event.source_type === "canvas");
            importSelection = new Set(candidates.map(eventId).filter(Boolean));
            selected = null; editor = { mode: "import" }; setDirty(false); render(); role("import-panel")?.focus?.({ preventScroll: true });
        }
        async function confirmImport() {
            const items = (state?.events || []).filter(event => importSelection.has(eventId(event)) && !isPersonal(event));
            if (!items.length) { announce("Select at least one existing task to import.", "error"); render(); return; }
            busy = true; announce(`Importing ${items.length} selected task${items.length === 1 ? "" : "s"} as separate personal blocks…`); render();
            const result = await adapter.importEvents(items, { calendar_id: state?.sources?.[0]?.id || undefined }); busy = false;
            const failed = result.results.filter(item => !item.ok).length; const skipped = result.results.filter(item => item.skipped).length;
            editor = null;
            announce(failed ? `${failed} task${failed === 1 ? "" : "s"} could not be imported. Failed drafts remain available; originals were not changed.` : `Import complete. ${skipped ? `${skipped} duplicate${skipped === 1 ? " was" : "s were"} skipped. ` : ""}Original tasks were not changed.`, failed ? "error" : "saved");
            await reload();
        }
        function renderEditorForm(parent) {
            const panel = el("aside", undefined, "workspace-planner-panel"); panel.dataset.plannerRole = "details"; panel.tabIndex = -1;
            const heading = el("div", undefined, "workspace-planner-panel-heading"); heading.append(el("h2", editor.mode === "create" ? "New time block" : "Edit time block"), button("Close", () => { editor = null; setDirty(false); render(); }, "workspace-planner-close")); panel.append(heading);
            const title = el("input"); title.value = editor.title; title.dataset.plannerRole = "title"; title.addEventListener("input", () => updateEditor("title", title.value)); panel.append(field("Title", title));
            const allDay = el("input"); allDay.type = "checkbox"; allDay.checked = editor.all_day; allDay.dataset.plannerRole = "all-day"; allDay.addEventListener("change", () => { updateEditor("all_day", allDay.checked); render(); });
            const toggle = el("label", undefined, "workspace-planner-check"); toggle.append(allDay, el("span", "All day")); panel.append(toggle);
            const dates = el("div", undefined, "workspace-planner-form-grid");
            [["Start date", "start-date", "date", dateInputValue(editor.start)], ["Start time", "start-time", "time", timeInputValue(editor.start)], ["End date", "end-date", "date", dateInputValue(editor.end)], ["End time", "end-time", "time", timeInputValue(editor.end)]].forEach(([label, roleName, type, value]) => {
                if (editor.all_day && type === "time") return;
                const input = el("input"); input.type = type; input.value = value; input.dataset.plannerRole = roleName; if (type === "time") input.step = "900"; input.addEventListener("input", () => setDirty(true)); dates.append(field(label, input));
            }); panel.append(dates);
            const calendar = el("select"); calendar.dataset.plannerRole = "calendar";
            (state?.sources || []).filter(source => source.editable !== false && source.writable !== false && (state.access?.nativeWrite !== false || String(source.id).startsWith("external:"))).forEach(source => { const option = el("option", clean(source.label || source.name) || "Personal"); option.value = clean(source.id); calendar.append(option); }); calendar.value = editor.calendar_id;
            panel.append(field("Personal calendar", calendar));
            if (editor.event?.source_type === "external") {
                calendar.disabled = true;
                const location = el("input"); location.value = editor.location || ""; location.dataset.plannerRole = "location";
                location.addEventListener("input", () => updateEditor("location", location.value)); panel.append(field("Location", location));
            }

            const color = el("input"); color.type = "color"; color.value = safeColor(editor.color); color.dataset.plannerRole = "color"; panel.append(field("Color", color));
            const description = el("textarea"); description.value = editor.description; description.dataset.plannerRole = "description"; description.addEventListener("input", () => updateEditor("description", description.value)); panel.append(field("Details", description));
            panel.append(el("p", "Times snap to 15 minutes. New timed blocks default to one hour. Canvas deadlines cannot be edited here.", "workspace-planner-help"));
            const actions = el("div", undefined, "workspace-planner-panel-actions"); actions.append(button(busy ? "Saving…" : "Save time block", saveEditor, "workspace-planner-primary", "save"));
            if (editor.mode === "edit") actions.append(button("Delete", deleteSelected, "workspace-planner-danger")); panel.append(actions); parent.append(panel);
        }
        function renderImportPanel(parent) {
            const panel = el("aside", undefined, "workspace-planner-panel"); panel.dataset.plannerRole = "import-panel"; panel.tabIndex = -1;
            const heading = el("div", undefined, "workspace-planner-panel-heading"); heading.append(el("h2", "Import existing tasks"), button("Close", () => { editor = null; render(); }, "workspace-planner-close")); panel.append(heading);
            panel.append(el("p", "Choose which visible Canvas deadlines to copy into separate personal time blocks. Originals stay unchanged, and nothing uploads until you confirm.", "workspace-planner-help"));
            const candidates = (state?.events || []).filter(event => event.source_type === "canvas");
            if (!candidates.length) panel.append(el("p", "No visible Canvas tasks are available in this period."));
            candidates.forEach(event => {
                const label = el("label", undefined, "workspace-planner-import-row"); const input = el("input"); input.type = "checkbox"; input.checked = importSelection.has(eventId(event));
                input.addEventListener("change", () => { if (input.checked) importSelection.add(eventId(event)); else importSelection.delete(eventId(event)); });
                const copy = el("span"); copy.append(el("strong", clean(event.title) || "Untitled task"), el("small", formatRange(event))); label.append(input, copy); panel.append(label);
            });
            const confirm = button(busy ? "Importing…" : "Import selected tasks", confirmImport, "workspace-planner-primary", "confirm-import"); confirm.disabled = busy || !candidates.length; panel.append(confirm); parent.append(panel);
        }
        function renderDetails(parent) {
            if (editor?.mode === "import") return renderImportPanel(parent);
            if (editor) return renderEditorForm(parent);
            if (!selected) return;
            const panel = el("aside", undefined, "workspace-planner-panel"); panel.dataset.plannerRole = "details"; panel.tabIndex = -1;
            const heading = el("div", undefined, "workspace-planner-panel-heading"); heading.append(el("h2", clean(selected.title) || "Untitled event"), button("Close", () => { selected = null; render(); }, "workspace-planner-close")); panel.append(heading);
            const badge = el("span", selected.source_type === "external" ? `${selected.provider === "google" ? "Google Calendar" : "Outlook"} · ${selected.sync_state || "synchronized"}` : isPersonal(selected) ? "Personal time block" : "Canvas deadline · View only", "workspace-planner-kind"); badge.style.setProperty("--event-color", eventColor(selected)); panel.append(badge);
            panel.append(el("p", formatRange(selected), "workspace-planner-detail-time"), el("p", sourceLabel(selected), "workspace-planner-detail-source"));
            if (selected.description) panel.append(el("p", clean(selected.description, 2000), "workspace-planner-description"));
            if (isPersonal(selected)) {
                const actions = el("div", undefined, "workspace-planner-panel-actions"); actions.append(button("Edit details", openEdit, "workspace-planner-primary"), button("15 min earlier", () => adjustSelected("move", -15), "workspace-planner-secondary"), button("15 min later", () => adjustSelected("move", 15), "workspace-planner-secondary"), button("Shorten 15 min", () => adjustSelected("resize", -15), "workspace-planner-secondary"), button("Extend 15 min", () => adjustSelected("resize", 15), "workspace-planner-secondary"), button("Delete", deleteSelected, "workspace-planner-danger")); panel.append(actions);
            } else if (selected.source_type === "external") {
                panel.append(el("p", "Edit guest meetings, series rules, and read-only events in the calendar provider.", "workspace-planner-help"));
            } else panel.append(el("p", "This date is authoritative in Canvas. To plan work time, create a separate personal block or use the explicit import action.", "workspace-planner-help"));
            if (selected.source_type === "external" && selected.source_url) {
                const link = el("a", selected.provider === "google" ? "Open in Google Calendar" : "Open in Outlook");
                link.href = selected.source_url; link.target = "_blank"; link.rel = "noopener noreferrer"; panel.append(link);
            }
            parent.append(panel);
        }
        function renderGate(parent, access) {
            const [title, copy, actionLabel, action] = accessCopy(access?.code);
            const gate = el("section", undefined, "workspace-planner-gate"); gate.append(el("h1", title), el("p", copy));
            const handler = action === "consent" ? context?.actions?.reviewPlannerConsent || context?.reviewPlannerConsent : context?.actions?.connectNest || context?.connectNest;
            const connect = button(actionLabel, async () => {
                if (typeof handler !== "function") { announce("Open APStudy Nest account settings to update this connection, then return and retry.", "error"); render(); return; }
                await handler(); adapter.refreshAccess(); state = adapter.snapshot(); if (state.access.read) await reload(); else render();
            }, "workspace-planner-primary", "gate-action"); gate.append(connect);
            if (access?.code === "PLANNER_WRITE_CONSENT_REQUIRED") gate.append(button("Continue read-only", () => { notice = { text: "Planner is read-only until editing access is granted.", kind: "" }; renderReady(parent.parentElement || parent); }, "workspace-planner-secondary"));
            parent.append(gate);
        }
        function renderReady(parent) {
            renderHeader(parent); renderToolbar(parent); renderFilters(parent);
            const connections = el("a", "Manage calendar connections"); connections.href = "https://nest.apstudy.org/calendar/connections"; connections.target = "_blank"; connections.rel = "noopener noreferrer"; parent.append(connections);
            if (!state?.access?.write) {
                const gate = el("div", undefined, "workspace-planner-readonly");
                gate.append(el("p", "Planner is read-only. Personal time blocks and imports need separate editing access."));
                gate.append(button("Review editing access", async () => {
                    const handler = context?.actions?.reviewPlannerConsent || context?.reviewPlannerConsent;
                    if (typeof handler !== "function") { announce("Open APStudy Nest account settings to review editing access, then return and retry.", "error"); render(); return; }
                    await handler(); adapter.refreshAccess(); state = adapter.snapshot(); render();
                }, "workspace-planner-secondary", "write-consent"));
                parent.append(gate);
            }
            if (state?.loading) parent.append(el("div", "Loading calendar…", "workspace-planner-loading"));
            const body = el("div", undefined, `workspace-planner-body${selected || editor ? " has-panel" : ""}`);
            const calendar = el("div", undefined, "workspace-planner-main");
            if (view === "day") renderDay(calendar); else if (view === "month") renderMonth(calendar); else renderWeek(calendar);
            body.append(calendar); renderDetails(body); parent.append(body);
            if (["PLANNER_ACCOUNT_UNVERIFIED", "PLANNER_READ_CAPABILITY_REQUIRED", "PLANNER_READ_CONSENT_REQUIRED"].includes(state?.error)) announce(accessCopy(state.error)[1], "error");
        }
        function render() {
            if (!host || disposed) return;
            const motion = win?.APStudyCanvasMotion || globalThis.APStudyCanvasMotion;
            const wasLoading = host.getAttribute?.("aria-busy") === "true";
            const firstLoad = state?.access?.read && ((state.loading && !state.loadedRange) || (!state.range && !state.error));
            if (firstLoad && motion) {
                if (!wasLoading) { host.replaceChildren(); motion.showLoading(host, "Loading calendar…", "planner"); }
                return;
            }
            motion?.clearLoading(host);
            rootNode = el("div", undefined, "workspace-planner");
            if (!state?.access?.read) renderGate(rootNode, state?.access);
            else renderReady(rootNode);
            const status = el("p", notice.text, `workspace-planner-status${notice.kind ? ` is-${notice.kind}` : ""}`); status.dataset.plannerRole = "status"; status.setAttribute("role", notice.kind === "error" ? "alert" : "status"); status.setAttribute("aria-live", "polite"); rootNode.append(status);
            host.replaceChildren(rootNode);
            if (wasLoading) motion?.reveal(host, 120);
        }
        async function mount(nextContext, route = {}) {
            if (!doc?.createElement || !adapter?.snapshot || !adapter?.subscribe || !adapter?.loadRange) throw new Error("WORKSPACE_PLANNER_DEPENDENCIES_UNAVAILABLE");
            disposed = false; context = nextContext || {}; accountScope = clean(context?.account?.scope, 180); host = hostOption || doc.getElementById?.("feature-route-host");
            if (!host?.replaceChildren) throw new Error("WORKSPACE_PLANNER_HOST_UNAVAILABLE");
            const intent = routeIntent(route); if (intent.view) view = intent.view; if (intent.date) anchor = intent.date;
            const token = ++generation;
            state = adapter.snapshot();
            render();
            const initialize = async () => {
                await readPreferences();
                if (disposed || token !== generation) return;
                if (intent.view) view = intent.view; if (intent.date) anchor = intent.date;
                unsubscribe = adapter.subscribe(next => { state = next; if (!disposed) render(); });
                adapter.refreshAccess(); state = adapter.snapshot();
                if (state.access.read) await reload(); else render();
                if (disposed) return;
                if (intent.eventId) { selected = state.events.find(event => eventId(event) === intent.eventId) || null; render(); }
            };
            const initialLoad = initialize();
            if (!context?.deferInitialLoad) await initialLoad;
            else void initialLoad.catch(() => { if (!disposed) { announce("Planner could not load. Try opening it again.", "error"); render(); } });
            return api;
        }
        async function routeUpdate(route = {}, nextContext = context) {
            if (disposed) return;
            context = nextContext || context; const nextScope = clean(context?.account?.scope, 180);
            adapter.refreshAccess(); state = adapter.snapshot();
            if (accountScope && nextScope !== accountScope) {
                announce(dirty ? "Your account changed. This unsaved draft is still here; close Planner before switching accounts." : "Your account changed. Planner cleared the previous account’s calendar data.", "error");
                render(); return;
            }
            accountScope = nextScope;
            const intent = routeIntent(route); if (intent.view) view = intent.view; if (intent.date) anchor = intent.date;
            if (state.access.read) await reload(); else render();
            if (intent.eventId) { selected = state.events.find(event => eventId(event) === intent.eventId) || null; render(); }
        }
        async function dispose() {
            if (disposed) return;
            disposed = true; (win?.APStudyCanvasMotion || globalThis.APStudyCanvasMotion)?.dispose(host); generation += 1; unsubscribe?.(); unsubscribe = null; adapter.dispose?.();
            if (host && rootNode && Array.from(host.children || []).includes(rootNode)) host.replaceChildren();
            rootNode = null; host = null; state = null; selected = null; editor = null; importSelection.clear(); setDirty(false);
        }
        const api = Object.freeze({ mount, routeUpdate, queryDirty: () => dirty, dispose });
        return api;
    }

    return Object.freeze({ createWorkspacePlanner, preferenceKey, accessCopy, isPersonal, isAllDay });
}));
