(function (root, factory) {
    "use strict";
    const content = root?.APStudyCanvasContent || {};
    const state = content.TodoState || (typeof require === "function" ? require("./todo-state.js") : null);
    const todoApi = content.TodoApi || (typeof require === "function" ? require("./todo-api.js") : null);
    const api = factory(state, todoApi);
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasContent = Object.assign(root.APStudyCanvasContent || {}, { TodoCourseCards: api });
}(typeof globalThis !== "undefined" ? globalThis : this, function (stateApi, todoApi) {
    "use strict";

    /**
     * Course-card integration contract for the next content owner:
     *
     * const cards = TodoCourseCards.create({ completionDispatcher });
     * cards.mount({ card, course, canvasAccountKey, canvasTasks, nestTasks, settings });
     * cards.update(nextViewModel); cards.destroy();
     *
     * `canvasTasks` and `nestTasks` are normalized TodoModel records. Nest
     * records need an explicit Canvas account key in their association metadata
     * (for example `canvasAccountKey` or `course.canvas_account_key`) before
     * they can appear on a Canvas course card. Association never writes back to
     * Canvas or Nest; it only annotates the returned in-memory record.
     */

    const ACCOUNT_KEY = /^[a-f0-9]{64}$/;
    const BUCKET_ORDER = Object.freeze(["overdue", "urgent", "soon", "later"]);
    const SOURCE_ORDER = Object.freeze({ canvas: 0, nest: 1 });
    const DEFAULT_SETTINGS = Object.freeze({
        todo_enabled: true,
        todo_course_card_tasks_enabled: true,
        todo_card_max: 4,
        todo_card_sort: "urgency-balanced",
        todo_hide_completed: "immediate",
        todo_completion_authority: "canvas",
        todo_date_format: "absolute",
        todo_clock_24h: false,
        todo_link_target: "new-tab"
    });
    const PLACEMENT_HOOKS = Object.freeze({
        railAttribute: "data-apstudycanvas-todo-placement",
        railBelowCardsValue: "below-course-cards",
        cardTaskAttribute: "data-apstudycanvas-owned",
        cardTaskValue: "todo-course-card-tasks",
        cardAttachment: "course-card",
        mediumWidth: Object.freeze({ min: 768, max: 1100, railPlacement: "below-course-cards" })
    });

    function plainObject(value) {
        return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    }

    function array(value) { return Array.isArray(value) ? value : []; }

    function text(value, fallback = "") {
        if (value === null || value === undefined) return fallback;
        const result = String(value).replace(/[\u0000-\u001f\u007f]/g, "").trim();
        return result || fallback;
    }

    function stableText(value) { return text(value).toLocaleLowerCase("en-US"); }

    function accountKey(value) {
        const candidate = text(value).toLowerCase();
        return ACCOUNT_KEY.test(candidate) ? candidate : null;
    }

    function courseId(value) {
        if (value && typeof value === "object") return courseId(value.id ?? value.courseId ?? value.course_id ?? value.canvas_course_id);
        const candidate = text(value);
        return candidate && !/[\u0000-\u001f\u007f/]/.test(candidate) ? candidate : null;
    }

    function firstValue(...values) { return values.find((value) => value !== undefined && value !== null && value !== ""); }

    function canvasAccountKeyFrom(value) {
        const source = plainObject(value);
        const course = plainObject(source.course || source.course_metadata);
        const association = plainObject(source.association || source.courseAssociation);
        const raw = plainObject(source.raw);
        return accountKey(firstValue(
            source.canvasAccountKey,
            source.canvas_account_key,
            source.canvasAccount,
            source.canvas_account?.accountKey,
            source.canvas_account?.account_key,
            course.canvasAccountKey,
            course.canvas_account_key,
            course.canvasAccount,
            association.canvasAccountKey,
            association.canvas_account_key,
            raw.canvasAccountKey,
            raw.canvas_account_key,
            raw.canvas_account?.accountKey,
            raw.canvas_account?.account_key
        ));
    }

    function courseIdFrom(value) {
        const source = plainObject(value);
        const course = plainObject(source.course || source.course_metadata);
        const raw = plainObject(source.raw);
        return courseId(firstValue(
            source.courseId,
            source.course_id,
            source.canvasCourseId,
            source.canvas_course_id,
            course.id,
            course.courseId,
            course.course_id,
            course.canvas_course_id,
            raw.course_id,
            raw.canvas_course_id
        ));
    }

    function normalizeCardCourse(course, canvasAccountKeyValue) {
        const source = plainObject(course);
        const normalizedId = courseId(source);
        const normalizedAccountKey = accountKey(firstValue(canvasAccountKeyValue, source.canvasAccountKey, source.canvas_account_key, source.accountKey, source.account_key));
        return Object.freeze({
            id: normalizedId,
            accountKey: normalizedAccountKey,
            name: text(firstValue(source.name, source.course_name, source.label), normalizedId ? `Course ${normalizedId}` : "Course"),
            code: text(firstValue(source.code, source.course_code)),
            label: text(firstValue(source.label, source.name, source.course_code, source.code), normalizedId ? `Course ${normalizedId}` : "Course")
        });
    }

    function normalizeSettings(values) {
        const source = plainObject(values);
        const result = { ...DEFAULT_SETTINGS, ...source };
        if (source.todo_enabled === undefined && typeof source.better_todo === "boolean") result.todo_enabled = source.better_todo;
        if (source.todo_card_max === undefined && typeof source.num_todo_items === "number") result.todo_card_max = source.num_todo_items;
        if (source.todo_hide_completed !== "keep-visible") result.todo_hide_completed = "immediate";
        if (!["urgency-balanced", "due-date", "course"].includes(result.todo_card_sort)) result.todo_card_sort = "urgency-balanced";
        const cap = Number(result.todo_card_max);
        result.todo_card_max = Number.isFinite(cap) ? Math.max(1, Math.min(10, Math.round(cap))) : DEFAULT_SETTINGS.todo_card_max;
        if (result.todo_completion_authority !== "manual" && result.todo_completion_authority !== "canvas") result.todo_completion_authority = DEFAULT_SETTINGS.todo_completion_authority;
        if (result.todo_link_target !== "same-tab" && result.todo_link_target !== "new-tab") result.todo_link_target = DEFAULT_SETTINGS.todo_link_target;
        return result;
    }

    function sourceOf(task) { return text(task?.source).toLowerCase(); }

    function taskKey(task, fallback = "task") {
        return text(task?.id || task?.eventRef || task?.sourceItemKey || `${sourceOf(task) || fallback}:${task?.remoteId || ""}:${task?.title || ""}`, fallback);
    }

    function mergeCourseTasks({ course, canvasAccountKey: suppliedAccountKey, canvasTasks, nestTasks, tasks } = {}) {
        const normalizedCourse = normalizeCardCourse(course, suppliedAccountKey);
        const expectedAccountKey = normalizedCourse.accountKey;
        const expectedCourseId = normalizedCourse.id;
        if (!expectedAccountKey || !expectedCourseId) return [];

        const inputCanvas = Array.isArray(canvasTasks) ? canvasTasks : array(tasks).filter((task) => sourceOf(task) === "canvas");
        const inputNest = Array.isArray(nestTasks) ? nestTasks : array(tasks).filter((task) => sourceOf(task) === "nest");
        const seen = new Set();
        const result = [];

        inputCanvas.forEach((task) => {
            if (!task || sourceOf(task) !== "canvas") return;
            if (accountKey(task.accountKey) !== expectedAccountKey || courseIdFrom(task) !== expectedCourseId) return;
            const key = taskKey(task);
            if (seen.has(key)) return;
            seen.add(key);
            result.push(task);
        });

        inputNest.forEach((task) => {
            if (!task || sourceOf(task) !== "nest") return;
            // A Nest account key is not a Canvas account key. Only an explicit
            // Canvas association can pass this boundary.
            if (canvasAccountKeyFrom(task) !== expectedAccountKey || courseIdFrom(task) !== expectedCourseId) return;
            const key = taskKey(task);
            if (seen.has(key)) return;
            seen.add(key);
            result.push({
                ...task,
                courseAssociation: {
                    ...(plainObject(task.courseAssociation)),
                    canvasAccountKey: expectedAccountKey,
                    courseId: expectedCourseId,
                    source: "course-card-metadata"
                }
            });
        });
        return result;
    }

    function dueMs(task) {
        const due = task?.due;
        if (due?.kind === "instant") {
            const parsed = Date.parse(due.utcInstant);
            return Number.isFinite(parsed) ? parsed : Infinity;
        }
        if (due?.kind === "date") {
            const parsed = Date.parse(`${due.date}T23:59:59.999Z`);
            return Number.isFinite(parsed) ? parsed : Infinity;
        }
        const raw = firstValue(task?.dueAt, task?.due_at, task?.due);
        const parsed = Date.parse(String(raw || ""));
        return Number.isFinite(parsed) ? parsed : Infinity;
    }

    function classify(task, { now = Date.now(), timeZone } = {}) {
        if (task?.completion === true) return { bucket: "completed", label: "Completed", order: 99 };
        const domainClassification = stateApi?.classifyTask?.(task, { now, timeZone });
        const overdue = domainClassification?.overdue === true || domainClassification?.bucket === "missing";
        if (overdue) return { bucket: "overdue", label: domainClassification?.bucket === "missing" ? "Missing" : "Overdue", order: 0 };
        if (task?.priority === "urgent" || domainClassification?.bucket === "urgent") return { bucket: "urgent", label: "Urgent", order: 1 };
        if (domainClassification?.bucket === "soon") return { bucket: "soon", label: "Due soon", order: 2 };
        if (domainClassification?.bucket === "undated") return { bucket: "later", label: "No due date", order: 3 };
        return { bucket: "later", label: domainClassification?.bucket === "submitted-ungraded" ? "Submitted" : "Upcoming", order: 3 };
    }

    function compareTasks(left, right, leftIndex = 0, rightIndex = 0) {
        const dueDifference = dueMs(left) - dueMs(right);
        if (dueDifference !== 0) return dueDifference;
        const titleDifference = stableText(left?.title).localeCompare(stableText(right?.title), "en-US");
        if (titleDifference !== 0) return titleDifference;
        const sourceDifference = (SOURCE_ORDER[sourceOf(left)] ?? 9) - (SOURCE_ORDER[sourceOf(right)] ?? 9);
        if (sourceDifference !== 0) return sourceDifference;
        const idDifference = stableText(taskKey(left)).localeCompare(stableText(taskKey(right)), "en-US");
        return idDifference || leftIndex - rightIndex;
    }

    function compareByCourse(left, right, leftIndex = 0, rightIndex = 0) {
        const leftCourse = stableText(left?.course?.code || left?.course?.label || left?.course?.name || left?.course?.id);
        const rightCourse = stableText(right?.course?.code || right?.course?.label || right?.course?.name || right?.course?.id);
        const courseDifference = leftCourse.localeCompare(rightCourse, "en-US");
        return courseDifference || compareTasks(left, right, leftIndex, rightIndex);
    }

    function selectCourseCardTasks(tasks, { cap = DEFAULT_SETTINGS.todo_card_max, sort = DEFAULT_SETTINGS.todo_card_sort, now = Date.now(), timeZone } = {}) {
        const limit = Number.isFinite(Number(cap)) ? Math.max(1, Math.min(10, Math.round(Number(cap)))) : DEFAULT_SETTINGS.todo_card_max;
        const sortMode = ["urgency-balanced", "due-date", "course"].includes(sort) ? sort : DEFAULT_SETTINGS.todo_card_sort;
        const buckets = new Map(BUCKET_ORDER.map((bucket) => [bucket, []]));
        array(tasks).forEach((task, index) => {
            if (!task || task.completion === true) return;
            const classification = classify(task, { now, timeZone });
            const bucket = buckets.has(classification.bucket) ? classification.bucket : "later";
            buckets.get(bucket).push({ task, classification, index });
        });
        const compare = sortMode === "course"
            ? (left, right) => compareByCourse(left.task, right.task, left.index, right.index)
            : (left, right) => compareTasks(left.task, right.task, left.index, right.index);
        buckets.forEach((entries) => entries.sort(compare));

        if (sortMode !== "urgency-balanced") {
            return Array.from(buckets.values())
                .flat()
                .sort(compare)
                .slice(0, limit)
                .map((entry, position) => ({ ...entry, position }));
        }

        // Round-robin is intentional: each urgency class gets a chance before
        // a large overdue class can fill the cap. Within each class, due date,
        // title, source (Canvas before Nest), id, then input position are the
        // deterministic tie-breakers.
        const selected = [];
        while (selected.length < limit) {
            let picked = false;
            BUCKET_ORDER.forEach((bucket) => {
                if (selected.length >= limit) return;
                const entry = buckets.get(bucket)?.shift();
                if (!entry) return;
                selected.push({ ...entry, position: selected.length });
                picked = true;
            });
            if (!picked) break;
        }
        return selected;
    }

    function safeHttpsUrl(value) {
        try {
            const url = new URL(String(value || ""));
            if (url.protocol !== "https:" || url.username || url.password || url.hash) return null;
            return url.href;
        } catch (error) { return null; }
    }

    function formatDue(task, now = Date.now()) {
        const due = task?.due;
        if (!due) return "No due date";
        if (due.kind === "date" && due.date) return due.date;
        const parsed = Date.parse(due.utcInstant || "");
        if (!Number.isFinite(parsed)) return "Due date unavailable";
        try {
            return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(parsed));
        } catch (error) { return new Date(parsed || now).toISOString(); }
    }

    function makeElement(documentRef, tagName, attributes = {}, content = null) {
        const element = documentRef.createElement(tagName);
        Object.entries(attributes).forEach(([key, value]) => {
            if (value === undefined || value === null) return;
            if (key === "className") element.className = String(value);
            else if (key === "textContent") element.textContent = String(value);
            else if (key === "style" && value && typeof value === "object") Object.assign(element.style || {}, value);
            else element.setAttribute?.(key, String(value));
        });
        if (content !== null && content !== undefined) element.textContent = String(content);
        return element;
    }

    function append(parent, child) {
        if (typeof parent?.append === "function") parent.append(child);
        else parent?.appendChild?.(child);
        return child;
    }

    function clear(node) {
        if (typeof node?.replaceChildren === "function") node.replaceChildren();
        else while (node?.firstChild) node.removeChild(node.firstChild);
    }

    function childrenOf(node) { return Array.from(node?.children || node?.childNodes || []); }

    function attr(node, name) { return node?.getAttribute?.(name) || ""; }

    function cardCourseFromElement(card) {
        if (!card) return {};
        const dataset = card.dataset || {};
        return {
            id: firstValue(dataset.courseId, attr(card, "data-course-id"), attr(card, "data-course_id")),
            label: firstValue(dataset.courseName, attr(card, "data-course-name"), attr(card, "aria-label"))
        };
    }

    function present(node) { return Boolean(node) && node.isConnected !== false; }

    function taskLabel(task) { return text(task?.title, "Untitled task"); }

    function taskStatus(task, classification) {
        return task?.completion ? "Completed" : classification?.label || "Upcoming";
    }

    function stableDomId(value) { return `apstudy-course-task-${encodeURIComponent(taskKey(value)).replace(/%/g, "-")}`; }

    function createCourseCardRenderer(options = {}) {
        const documentRef = options.document || globalThis.document;
        const callbacks = options;
        let mounted = false;
        let card = null;
        let rootNode = null;
        let version = 0;
        let requestSequence = 0;
        let pending = new Map();
        let errors = new Map();
        let completedVisible = new Map();
        let lastSignature = null;
        let view = {
            course: null,
            canvasAccountKey: null,
            canvasTasks: [],
            nestTasks: [],
            tasks: [],
            settings: normalizeSettings(options.settings),
            now: options.now ?? Date.now(),
            liveMessage: ""
        };

        function removeRoot() {
            rootNode?.remove?.();
            rootNode = null;
        }

        function available() { return present(card); }

        function updateView(input = {}) {
            if (Object.prototype.hasOwnProperty.call(input, "course")) view.course = input.course;
            if (Object.prototype.hasOwnProperty.call(input, "canvasAccountKey")) view.canvasAccountKey = input.canvasAccountKey;
            if (Array.isArray(input.canvasTasks)) view.canvasTasks = input.canvasTasks.slice();
            if (Array.isArray(input.nestTasks)) view.nestTasks = input.nestTasks.slice();
            if (Array.isArray(input.tasks)) {
                view.tasks = input.tasks.slice();
                if (!Array.isArray(input.canvasTasks)) view.canvasTasks = input.tasks.filter((task) => sourceOf(task) === "canvas");
                if (!Array.isArray(input.nestTasks)) view.nestTasks = input.tasks.filter((task) => sourceOf(task) === "nest");
            }
            if (input.settings) view.settings = normalizeSettings({ ...view.settings, ...input.settings });
            if (input.now !== undefined) view.now = input.now;
            if (!view.course) view.course = cardCourseFromElement(card);
            if (!view.canvasAccountKey) view.canvasAccountKey = firstValue(view.course?.accountKey, attr(card, "data-canvas-account-key"));
            view.settings = normalizeSettings(view.settings);
            view.tasks = mergeCourseTasks({ course: view.course, canvasAccountKey: view.canvasAccountKey, canvasTasks: view.canvasTasks, nestTasks: view.nestTasks });
            const active = selectCourseCardTasks(view.tasks, { cap: view.settings.todo_card_max, sort: view.settings.todo_card_sort, now: view.now, timeZone: view.course?.timeZone });
            if (view.settings.todo_hide_completed === "keep-visible") {
                view.tasks.filter((task) => task.completion === true).forEach((task) => completedVisible.set(taskKey(task), task));
            } else completedVisible.clear();
            view.selected = active;
        }

        function ensureRoot() {
            if (rootNode && rootNode.parentNode === card) return rootNode;
            const stale = childrenOf(card).find((child) => attr(child, PLACEMENT_HOOKS.cardTaskAttribute) === PLACEMENT_HOOKS.cardTaskValue);
            stale?.remove?.();
            rootNode = makeElement(documentRef, "section", {
                className: "apstudy-course-card-tasks",
                "data-apstudycanvas-owned": PLACEMENT_HOOKS.cardTaskValue,
                "data-course-task-attachment": PLACEMENT_HOOKS.cardAttachment,
                "data-completed-behavior": view.settings.todo_hide_completed,
                role: "region"
            });
            append(card, rootNode);
            return rootNode;
        }

        function renderTask(task, classification, position) {
            const key = taskKey(task);
            const pendingEntry = pending.get(key);
            const row = makeElement(documentRef, "li", {
                className: `apstudy-course-card-task-row is-${classification.bucket}${task.completion ? " is-completed" : ""}`,
                "data-task-id": key,
                "data-source": sourceOf(task),
                "data-urgency": classification.bucket,
                "data-status": task.completion ? "completed" : "active",
                "data-position": position
            });
            const marker = makeElement(documentRef, "span", { className: "apstudy-course-card-task-marker", "aria-hidden": "true" });
            marker.style?.setProperty?.("--course-color", text(task.course?.color, "#D4AF37"));
            append(row, marker);

            const content = makeElement(documentRef, "div", { className: "apstudy-course-card-task-content" });
            const title = taskLabel(task);
            const destination = safeHttpsUrl(task.url);
            const titleNode = destination
                ? makeElement(documentRef, "a", { className: "apstudy-course-card-task-title", href: destination, "aria-label": `${title} · ${sourceOf(task) === "nest" ? "Nest" : "Canvas"}` }, title)
                : makeElement(documentRef, "span", { className: "apstudy-course-card-task-title" }, title);
            if (destination && view.settings.todo_link_target === "new-tab") {
                titleNode.setAttribute("target", "_blank");
                titleNode.setAttribute("rel", "noopener noreferrer");
            }
            append(content, titleNode);
            const meta = makeElement(documentRef, "div", { className: "apstudy-course-card-task-meta", id: `${stableDomId(task)}-meta` });
            append(meta, makeElement(documentRef, "span", { className: "apstudy-course-card-task-source", "data-source-label": sourceOf(task) === "nest" ? "Nest" : "Canvas" }, sourceOf(task) === "nest" ? "Nest" : "Canvas"));
            append(meta, makeElement(documentRef, "span", { className: "apstudy-course-card-task-status", "data-status-label": taskStatus(task, classification) }, taskStatus(task, classification)));
            append(meta, makeElement(documentRef, "time", { className: "apstudy-course-card-task-due", dateTime: task?.due?.utcInstant || task?.due?.date || "" }, formatDue(task, view.now)));
            append(content, meta);
            append(row, content);

            const desired = !Boolean(task.completion);
            const button = makeElement(documentRef, "button", {
                type: "button",
                className: "apstudy-course-card-task-complete",
                "data-action": "complete-task",
                "aria-label": `${desired ? "Mark" : "Mark as active"} ${title}`,
                "aria-pressed": String(Boolean(task.completion)),
                "aria-describedby": `${stableDomId(task)}-meta`
            }, desired ? "Complete" : "Done");
            if (pendingEntry) {
                button.disabled = true;
                button.setAttribute("aria-disabled", "true");
                button.setAttribute("aria-busy", "true");
                button.textContent = "Saving";
            }
            button.addEventListener?.("click", () => handleCompletion(task));
            append(row, button);
            const error = errors.get(key);
            if (error) append(row, makeElement(documentRef, "p", { className: "apstudy-course-card-task-error", role: "alert" }, error));
            return row;
        }

        // The signature covers only what render reads: the course identity,
        // the Canvas account key, the merged Canvas/Nest task records, the
        // normalized settings, and the derived selection output (each
        // selected task's key, urgency bucket, status label, and position).
        // Raw `now` is never signed: signing the derived output instead keeps
        // harmless clock drift on the fast path while still re-rendering when
        // time passage changes a bucket, a status label, or the balanced
        // sort order. DOM state, dispatcher callbacks, pending and error
        // maps, and the live message remain excluded; those paths render
        // directly and keep the DOM in sync themselves.
        function taskSignature(task) {
            const due = plainObject(task?.due);
            return [
                taskKey(task),
                sourceOf(task),
                taskLabel(task),
                Boolean(task.completion),
                text(task?.priority) || null,
                due.kind ?? null,
                due.date ?? null,
                due.utcInstant ?? null,
                text(task?.url) || null,
                text(task?.course?.color) || null,
                accountKey(firstValue(task?.accountKey, canvasAccountKeyFrom(task))),
                courseIdFrom(task)
            ];
        }

        function viewSignature() {
            const course = normalizeCardCourse(view.course, view.canvasAccountKey);
            const settings = plainObject(view.settings);
            return JSON.stringify([
                course.id,
                course.accountKey,
                course.name,
                course.code,
                course.label,
                accountKey(view.canvasAccountKey),
                array(view.tasks).map(taskSignature),
                array(view.selected).map((entry) => [
                    taskKey(entry.task),
                    entry.classification?.bucket ?? null,
                    entry.classification?.label ?? null,
                    entry.position ?? null
                ]),
                Object.keys(DEFAULT_SETTINGS).map((key) => settings[key] ?? null)
            ]);
        }

        // A signature that cannot be serialized (exotic records carrying
        // circular or BigInt fields) returns null instead of throwing. Null
        // never matches the fast path, so update fails open by rendering.
        function safeViewSignature() {
            try { return viewSignature(); } catch (error) { return null; }
        }

        function render() {
            if (!mounted || !available()) {
                removeRoot();
                mounted = false;
                return { ok: false, state: "card-missing" };
            }
            if (view.settings.todo_enabled === false || view.settings.todo_course_card_tasks_enabled === false) {
                removeRoot();
                return { ok: true, state: "disabled" };
            }
            const root = ensureRoot();
            root.setAttribute("data-completed-behavior", view.settings.todo_hide_completed);
            clear(root);
            const headingId = "apstudy-course-card-tasks-title";
            root.setAttribute("aria-labelledby", headingId);
            const header = makeElement(documentRef, "header", { className: "apstudy-course-card-tasks-header" });
            append(header, makeElement(documentRef, "h3", { id: headingId }, "To-do"));
            const visibleCompleted = view.settings.todo_hide_completed === "keep-visible"
                ? Array.from(completedVisible.values()).filter((task) => !view.selected.some((entry) => taskKey(entry.task) === taskKey(task))).slice(0, Math.max(0, view.settings.todo_card_max - view.selected.length))
                : [];
            append(header, makeElement(documentRef, "span", { className: "apstudy-course-card-tasks-count", "aria-label": `${view.selected.length + visibleCompleted.length} tasks` }, String(view.selected.length + visibleCompleted.length)));
            append(root, header);
            const list = makeElement(documentRef, "ul", { className: "apstudy-course-card-task-list", "aria-label": `Tasks for ${text(view.course?.label, "course")}` });
            view.selected.forEach((entry, index) => append(list, renderTask(entry.task, entry.classification, index)));
            visibleCompleted.forEach((task, index) => append(list, renderTask(task, classify(task, { now: view.now }), view.selected.length + index)));
            if (!view.selected.length && !visibleCompleted.length) append(root, makeElement(documentRef, "p", { className: "apstudy-course-card-tasks-empty" }, "No active tasks."));
            else append(root, list);
            append(root, makeElement(documentRef, "p", { className: "apstudy-course-card-tasks-live", role: "status", "aria-live": "polite", "aria-atomic": "true" }, view.liveMessage));
            return { ok: true, state: "rendered", rendered: true, root };
        }

        function dispatcher() {
            return callbacks.completionDispatcher || callbacks.todoApi?.dispatchCompletion || todoApi?.dispatchCompletion || null;
        }

        function handleCompletion(task) {
            const key = taskKey(task);
            if (pending.has(key)) return;
            const desired = !Boolean(task.completion);
            const complete = dispatcher();
            if (typeof complete !== "function") {
                errors.set(key, "Completion is unavailable. Retry after reconnecting.");
                view.liveMessage = "Completion is unavailable. Retry is available.";
                render();
                return;
            }
            pending.set(key, { desired });
            errors.delete(key);
            view.liveMessage = `${taskLabel(task)} is saving.`;
            render();
            const requestVersion = version;
            const requestId = `todo-course-card-completion:${++requestSequence}`;
            const idempotencyKey = `todo-course-card:${encodeURIComponent(key)}:${desired ? "complete" : "active"}`;
            Promise.resolve().then(() => complete(task, desired, {
                requestId,
                idempotencyKey,
                mode: view.settings.todo_completion_authority,
                accountKey: task.accountKey || view.canvasAccountKey
            })).then((result) => {
                if (!mounted || requestVersion !== version) return;
                pending.delete(key);
                if (result?.ok === true) {
                    const replacement = result.task || { ...task, completion: desired };
                    view.tasks = view.tasks.map((entry) => taskKey(entry) === key ? replacement : entry);
                    view.canvasTasks = view.canvasTasks.map((entry) => taskKey(entry) === key ? replacement : entry);
                    view.nestTasks = view.nestTasks.map((entry) => taskKey(entry) === key ? replacement : entry);
                    if (desired && view.settings.todo_hide_completed === "keep-visible") completedVisible.set(key, replacement);
                    else if (!desired) completedVisible.delete(key);
                    errors.delete(key);
                    view.liveMessage = `${taskLabel(task)} marked ${desired ? "complete" : "active"}.`;
                    updateView({});
                    render();
                    try { callbacks.onCompletionSuccess?.(replacement); } catch (error) {}
                    return;
                }
                const message = result?.error?.message || "Canvas or Nest did not confirm the change.";
                errors.set(key, `${message} Your previous state is unchanged. Retry is available.`);
                view.liveMessage = `${taskLabel(task)} could not be updated. Retry is available.`;
                render();
                try { callbacks.onCompletionFailure?.(result); } catch (error) {}
            }).catch((error) => {
                if (!mounted || requestVersion !== version) return;
                pending.delete(key);
                errors.set(key, `${error?.message || "The completion request failed."} Your previous state is unchanged. Retry is available.`);
                view.liveMessage = `${taskLabel(task)} could not be updated. Retry is available.`;
                render();
                try { callbacks.onCompletionFailure?.(error); } catch (callbackError) {}
            });
        }

        function mount(input = {}) {
            const nextCard = input.card || input.host || null;
            if (!present(nextCard)) {
                removeRoot();
                mounted = false;
                return { ok: false, code: "TODO_COURSE_CARD_MISSING", state: "card-missing" };
            }
            if (mounted && nextCard !== card) destroy();
            card = nextCard;
            mounted = true;
            version += 1;
            updateView(input);
            lastSignature = safeViewSignature();
            const result = render();
            return { ...result, state: result.state === "rendered" ? "mounted" : result.state };
        }

        function update(input = {}) {
            if (!mounted) return { ok: false, code: "TODO_COURSE_CARD_NOT_MOUNTED" };
            if (input.card && input.card !== card) return mount(input);
            if (!available()) {
                removeRoot();
                mounted = false;
                return { ok: false, code: "TODO_COURSE_CARD_MISSING", state: "card-missing" };
            }
            updateView(input);
            const signature = safeViewSignature();
            if (typeof signature === "string" && signature === lastSignature && rootNode) {
                return { ok: true, state: "unchanged", rendered: false, root: rootNode };
            }
            lastSignature = signature;
            return render();
        }

        function destroy() {
            version += 1;
            removeRoot();
            mounted = false;
            card = null;
            lastSignature = null;
            pending.clear();
            errors.clear();
            completedVisible.clear();
            return { ok: true, state: "destroyed" };
        }

        return Object.freeze({ mount, update, destroy, getRoot: () => rootNode, getState: () => ({ ...view, selected: array(view.selected).slice(), pending: new Map(pending), errors: new Map(errors) }) });
    }

    return Object.freeze({
        ACCOUNT_KEY,
        BUCKET_ORDER,
        DEFAULT_SETTINGS,
        PLACEMENT_HOOKS,
        normalizeSettings,
        normalizeCardCourse,
        canvasAccountKeyFrom,
        courseIdFrom,
        mergeCourseTasks,
        classify,
        compareTasks,
        selectCourseCardTasks,
        safeHttpsUrl,
        formatDue,
        getPlacementHooks: () => ({ ...PLACEMENT_HOOKS, mediumWidth: { ...PLACEMENT_HOOKS.mediumWidth } }),
        create: createCourseCardRenderer
    });
}));
