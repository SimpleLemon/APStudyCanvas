(function (root, factory) {
    "use strict";
    const api = factory();
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasWorkspaceNotes = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const MAX_EXCERPT = 150;
    const globalRoot = typeof globalThis !== "undefined" ? globalThis : null;

    function clone(value) {
        return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
    }

    function clean(value, max = 200) {
        return typeof value === "string"
            ? value.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, max)
            : "";
    }

    function excerpt(value, max = MAX_EXCERPT) {
        const text = typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim() : "";
        return text.length > max ? `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…` : text;
    }

    function routeIntent(route) {
        const source = route && typeof route === "object" ? route : {};
        return Object.freeze({
            query: clean(source.query ?? source.q ?? source.search, 240),
            noteId: clean(source.noteId ?? source.note, 100)
        });
    }

    function accountFromContext(context) {
        const canvas = context?.account?.canvas;
        const origin = typeof canvas?.origin === "string" ? canvas.origin : "";
        const accountId = String(canvas?.accountId ?? canvas?.canvasUserId ?? "");
        try {
            const url = new URL(origin);
            if (canvas?.verified !== true || url.protocol !== "https:" || url.origin !== origin || !/^\d+$/.test(accountId)) return null;
        } catch (error) { return null; }
        return Object.freeze({ origin, accountId });
    }

    function createWorkspaceNotes(options = {}) {
        const doc = options.document || globalRoot?.document;
        const win = options.window || globalRoot;
        const model = options.model || globalRoot?.APStudyCanvasContent?.WorkspaceModel;
        const storage = options.storage || (globalRoot?.chrome?.storage?.local ? {
            get: key => globalRoot.chrome.storage.local.get(key),
            set: value => globalRoot.chrome.storage.local.set(value)
        } : null);
        const resolveAccount = typeof options.verifyAccount === "function"
            ? options.verifyAccount
            : async context => accountFromContext(context);
        const readCourses = typeof options.readCourses === "function"
            ? options.readCourses
            : async context => Array.isArray(context?.courses) ? context.courses : [];
        const hostOption = options.host;
        const now = typeof options.now === "function" ? options.now : Date.now;
        const randomId = typeof options.randomId === "function"
            ? options.randomId
            : () => win?.crypto?.randomUUID?.() || `note-${now()}-${Math.random().toString(36).slice(2)}`;
        const optionDirtyListener = typeof options.onDirtyChange === "function" ? options.onDirtyChange : null;

        let sharedContext = null;
        let host = null;
        let rootNode = null;
        let store = null;
        let state = null;
        let account = null;
        let courses = [];
        let selectedId = "";
        let draft = null;
        let dirty = false;
        let busy = false;
        let disposed = false;
        let generation = 0;
        let abortController = null;
        let query = "";
        let courseFilter = "";
        let sort = "recent";
        let showingTrash = false;
        let status = { kind: "", text: "" };

        const setDirty = value => {
            const next = value === true;
            if (dirty === next) return;
            dirty = next;
            const listener = optionDirtyListener || sharedContext?.onDirtyChange;
            try { listener?.(next); } catch (error) {}
        };

        const el = (tag, text, className) => {
            const node = doc.createElement(tag);
            if (text !== undefined) node.textContent = text;
            if (className) node.className = className;
            return node;
        };
        const label = (text, control) => {
            const node = el("label", undefined, "workspace-notes-field");
            node.append(el("span", text), control);
            return node;
        };
        const button = (text, action, className = "") => {
            const node = el("button", text, className);
            node.type = "button";
            node.addEventListener("click", () => { if (!busy && !disposed) void action(); });
            return node;
        };
        const setStatus = (text, kind = "") => {
            status = { text, kind };
            sharedContext?.status?.(text, kind === "error");
            const node = rootNode && findRole(rootNode, "status");
            if (node) {
                node.textContent = text;
                node.className = `workspace-notes-status${kind ? ` is-${kind}` : ""}`;
                node.setAttribute("role", kind === "error" ? "alert" : "status");
            }
        };

        function findRole(node, role) {
            if (!node) return null;
            if (node.dataset?.notesRole === role) return node;
            for (const child of Array.from(node.children || [])) {
                const found = findRole(child, role);
                if (found) return found;
            }
            return null;
        }

        function courseName(id) {
            if (!id) return "No course";
            const match = courses.find(course => String(course.id) === String(id));
            return clean(match?.name || match?.course_code, 160) || `Course ${id}`;
        }

        function noteRows() {
            const needle = query.toLocaleLowerCase();
            return (state?.notes || [])
                .filter(note => Boolean(note.deleted) === showingTrash)
                .filter(note => !courseFilter || String(note.courseId) === courseFilter)
                .filter(note => !needle || `${note.title} ${note.body}`.toLocaleLowerCase().includes(needle))
                .sort((left, right) => sort === "title"
                    ? left.title.localeCompare(right.title, undefined, { sensitivity: "base" })
                    : right.updatedAt - left.updatedAt);
        }

        function currentNote() {
            return (state?.notes || []).find(note => note.id === selectedId) || null;
        }

        function confirmDiscard() {
            if (!dirty) return true;
            try { return win?.confirm?.("Discard unsaved note changes?") === true; }
            catch (error) { return false; }
        }

        function choose(note) {
            if (!note || (draft?.id !== note.id && !confirmDiscard())) return false;
            selectedId = note.id;
            draft = clone(note);
            setDirty(false);
            status = { kind: "saved", text: "Saved on this device." };
            render();
            findRole(rootNode, "title")?.focus?.({ preventScroll: true });
            return true;
        }

        function newNote() {
            if (!confirmDiscard()) return;
            selectedId = "";
            draft = { id: randomId(), title: "", body: "", courseId: courseFilter, updatedAt: now(), deleted: false };
            setDirty(false);
            status = { kind: "", text: "New note. Nothing is saved yet." };
            render();
            findRole(rootNode, "title")?.focus?.({ preventScroll: true });
        }

        function backToList() {
            if (!confirmDiscard()) return;
            draft = null;
            selectedId = "";
            setDirty(false);
            status = { kind: "", text: "" };
            render();
            findRole(rootNode, "new")?.focus?.({ preventScroll: true });
        }

        async function transact(change, successText) {
            if (!store || busy) return false;
            busy = true;
            render();
            setStatus("Saving…", "saving");
            try {
                state = await store.transact(change);
                setStatus(successText || "Saved on this device.", "saved");
                return true;
            } catch (error) {
                setStatus(`${clean(error?.message, 240) || "This note could not be saved."} Your draft is still here. Try again.`, "error");
                return false;
            } finally {
                busy = false;
                render();
            }
        }

        async function saveDraft() {
            if (!draft) return;
            const title = clean(draft.title, 160);
            if (!title) {
                setStatus("Add a title before saving. Your draft is still here.", "error");
                findRole(rootNode, "title")?.focus?.();
                return;
            }
            const saved = { ...clone(draft), title, courseId: clean(draft.courseId, 100), updatedAt: now(), deleted: false };
            const ok = await transact(data => {
                const index = data.notes.findIndex(note => note.id === saved.id);
                if (index < 0) data.notes.push(saved);
                else data.notes[index] = saved;
            });
            if (!ok) return;
            selectedId = saved.id;
            draft = clone(state.notes.find(note => note.id === saved.id));
            setDirty(false);
            render();
        }

        async function toggleTrash(note) {
            if (!note || (draft?.id === note.id && !confirmDiscard())) return;
            const restoring = Boolean(note.deleted);
            const ok = await transact(data => {
                const current = data.notes.find(item => item.id === note.id);
                if (!current) throw new Error("This note no longer exists.");
                current.deleted = !restoring;
                current.updatedAt = now();
            }, restoring ? "Note restored." : "Note moved to trash.");
            if (!ok) return;
            if (draft?.id === note.id) {
                draft = null;
                selectedId = "";
                setDirty(false);
            }
            render();
        }

        function renderControls(parent) {
            const controls = el("div", undefined, "workspace-notes-controls");
            const search = el("input");
            search.type = "search";
            search.value = query;
            search.placeholder = "Search titles and note text";
            search.dataset.notesRole = "search";
            search.addEventListener("input", () => {
                query = search.value;
                const caret = search.selectionStart;
                render();
                const replacement = findRole(rootNode, "search");
                replacement?.focus?.({ preventScroll: true });
                if (Number.isInteger(caret)) replacement?.setSelectionRange?.(caret, caret);
            });
            controls.append(label("Search notes", search));

            const course = el("select");
            [["", "All courses"], ...courses.map(item => [String(item.id), clean(item.name || item.course_code, 160) || `Course ${item.id}`])]
                .forEach(([value, name]) => { const option = el("option", name); option.value = value; course.append(option); });
            course.value = courseFilter;
            course.dataset.notesRole = "course-filter";
            course.addEventListener("change", () => { courseFilter = course.value; render(); findRole(rootNode, "course-filter")?.focus?.({ preventScroll: true }); });
            controls.append(label("Course", course));

            const ordering = el("select");
            [["recent", "Most recent"], ["title", "Title"]].forEach(([value, name]) => { const option = el("option", name); option.value = value; ordering.append(option); });
            ordering.value = sort;
            ordering.dataset.notesRole = "sort";
            ordering.addEventListener("change", () => { sort = ordering.value; render(); findRole(rootNode, "sort")?.focus?.({ preventScroll: true }); });
            controls.append(label("Sort", ordering));

            const view = el("select");
            [["active", "Notes"], ["trash", "Trash"]].forEach(([value, name]) => { const option = el("option", name); option.value = value; view.append(option); });
            view.value = showingTrash ? "trash" : "active";
            view.dataset.notesRole = "view";
            view.addEventListener("change", () => { showingTrash = view.value === "trash"; render(); findRole(rootNode, "view")?.focus?.({ preventScroll: true }); });
            controls.append(label("Show", view));
            parent.append(controls);
        }

        function renderList(parent) {
            const section = el("section", undefined, "workspace-notes-library");
            section.setAttribute("aria-label", showingTrash ? "Trashed notes" : "Saved notes");
            const heading = el("div", undefined, "workspace-notes-library-heading");
            const title = el("h2", showingTrash ? "Trash" : "Your notes");
            const create = button("New note", newNote, "workspace-notes-primary");
            create.dataset.notesRole = "new";
            create.disabled = showingTrash || busy;
            heading.append(title, create);
            section.append(heading);
            const rows = noteRows();
            if (!rows.length) {
                const empty = el("div", undefined, "workspace-notes-empty");
                empty.append(el("h3", showingTrash ? "Trash is empty" : query || courseFilter ? "No matching notes" : "Start with one useful thought"));
                empty.append(el("p", showingTrash ? "Notes moved to trash can be restored here." : query || courseFilter ? "Change the search or course filter to see more notes." : "Create a local text note and save it explicitly when it is ready."));
                section.append(empty);
            }
            rows.forEach(note => {
                const row = el("article", undefined, `workspace-notes-row${draft?.id === note.id ? " is-selected" : ""}`);
                const open = button(note.title, () => choose(note), "workspace-notes-row-open");
                open.setAttribute("aria-label", `Open ${note.title}`);
                const meta = el("p", `${courseName(note.courseId)} · ${new Date(note.updatedAt).toLocaleDateString()}`, "workspace-notes-meta");
                const body = el("p", excerpt(note.body) || "No note text yet.", "workspace-notes-excerpt");
                const actions = el("div", undefined, "workspace-notes-row-actions");
                actions.append(button(note.deleted ? "Restore" : "Move to trash", () => toggleTrash(note), "workspace-notes-secondary"));
                row.append(open, meta, body, actions);
                section.append(row);
            });
            parent.append(section);
        }

        function renderEditor(parent) {
            const section = el("section", undefined, "workspace-notes-editor");
            section.setAttribute("aria-label", "Note editor");
            if (!draft) {
                const blank = el("div", undefined, "workspace-notes-editor-empty");
                blank.append(el("h2", "Select a note to edit"), el("p", "Your saved notes stay visible beside the editor. On a narrow screen, opening a note moves you into a focused writing view."));
                section.append(blank);
                parent.append(section);
                return;
            }
            const header = el("div", undefined, "workspace-notes-editor-heading");
            header.append(button("Back to notes", backToList, "workspace-notes-back"), el("p", draft.id === selectedId ? "Editing saved note" : "New local note", "workspace-notes-editor-context"));
            section.append(header);
            const title = el("input");
            title.type = "text";
            title.maxLength = 160;
            title.required = true;
            title.value = draft.title;
            title.placeholder = "Note title";
            title.dataset.notesRole = "title";
            title.addEventListener("input", () => { draft.title = title.value; setDirty(true); setStatus("Unsaved changes.", "unsaved"); });
            section.append(label("Title", title));

            const course = el("select");
            const options = [["", "No course"], ...courses.map(item => [String(item.id), clean(item.name || item.course_code, 160) || `Course ${item.id}`])];
            if (draft.courseId && !options.some(([id]) => id === String(draft.courseId))) options.push([String(draft.courseId), courseName(draft.courseId)]);
            options.forEach(([value, name]) => { const option = el("option", name); option.value = value; course.append(option); });
            course.value = String(draft.courseId || "");
            course.addEventListener("change", () => { draft.courseId = course.value; setDirty(true); setStatus("Unsaved changes.", "unsaved"); });
            section.append(label("Course association", course));

            const body = el("textarea");
            body.maxLength = 100000;
            body.rows = 18;
            body.value = draft.body || "";
            body.placeholder = "Write plain text notes here…";
            body.dataset.notesRole = "body";
            body.addEventListener("input", () => { draft.body = body.value; setDirty(true); setStatus("Unsaved changes.", "unsaved"); });
            section.append(label("Note text", body));

            const footer = el("div", undefined, "workspace-notes-editor-footer");
            const live = el("p", status.text, `workspace-notes-status${status.kind ? ` is-${status.kind}` : ""}`);
            live.dataset.notesRole = "status";
            live.setAttribute("role", status.kind === "error" ? "alert" : "status");
            live.setAttribute("aria-live", "polite");
            const actions = el("div", undefined, "workspace-notes-actions");
            const save = button("Save note", saveDraft, "workspace-notes-primary");
            save.disabled = busy;
            actions.append(save);
            const existing = currentNote();
            if (existing) actions.append(button(existing.deleted ? "Restore note" : "Move to trash", () => toggleTrash(existing), "workspace-notes-secondary"));
            footer.append(live, actions);
            section.append(footer);
            parent.append(section);
        }

        function renderUnavailable(message) {
            if (!host) return;
            rootNode = el("section", undefined, "workspace-notes workspace-notes-unavailable");
            rootNode.append(el("h1", "Notes are unavailable"), el("p", message));
            host.replaceChildren(rootNode);
        }

        function render() {
            if (!host || disposed || !state) return;
            rootNode = el("div", undefined, `workspace-notes${draft ? " is-editor-open" : ""}`);
            const heading = el("header", undefined, "workspace-notes-header");
            heading.append(el("h1", "Notes"), el("p", "Saved as local text on this device.", "workspace-notes-local-label"));
            rootNode.append(heading);
            renderControls(rootNode);
            const split = el("div", undefined, "workspace-notes-split");
            renderList(split);
            renderEditor(split);
            rootNode.append(split);
            host.replaceChildren(rootNode);
        }

        async function verifyCurrent() {
            const value = await resolveAccount(sharedContext, abortController?.signal);
            const normalized = value && accountFromContext({ account: { canvas: { ...value, verified: true } } });
            if (!normalized) throw new Error("Canvas account could not be verified. Reload Canvas and try again.");
            return normalized;
        }

        async function load(route) {
            const token = ++generation;
            abortController?.abort?.();
            abortController = typeof AbortController !== "undefined" ? new AbortController() : { signal: undefined, abort() {} };
            renderUnavailable("Verifying your Canvas account…");
            try {
                account = await verifyCurrent();
                if (disposed || token !== generation) return;
                store = model.createStore({ storage, context: account, verify: verifyCurrent });
                const [loaded, availableCourses] = await Promise.all([
                    store.load(),
                    Promise.resolve(readCourses(sharedContext, abortController.signal)).catch(() => [])
                ]);
                if (disposed || token !== generation) return;
                state = loaded;
                courses = Array.isArray(availableCourses) ? availableCourses.filter(item => item && item.id !== undefined && item.id !== null) : [];
                const intent = routeIntent(route);
                if (intent.query) query = intent.query;
                if (intent.noteId) {
                    const match = state.notes.find(note => note.id === intent.noteId && !note.deleted);
                    if (match) { selectedId = match.id; draft = clone(match); }
                }
                render();
            } catch (error) {
                if (disposed || token !== generation) return;
                store = null;
                state = null;
                renderUnavailable(`${clean(error?.message, 240) || "Local notes could not be loaded."} No saved workspace data was changed.`);
                sharedContext?.status?.("Notes are unavailable for this Canvas account.", true);
            }
        }

        async function mount(context, route = {}) {
            if (!doc?.createElement || !model?.createStore || !storage?.get || !storage?.set) throw new Error("WORKSPACE_NOTES_DEPENDENCIES_UNAVAILABLE");
            disposed = false;
            sharedContext = context || {};
            host = hostOption || doc.getElementById?.("feature-route-host");
            if (!host?.replaceChildren) throw new Error("WORKSPACE_NOTES_HOST_UNAVAILABLE");
            const intent = routeIntent(route);
            query = intent.query;
            await load(route);
            return api;
        }

        async function routeUpdate(route = {}, context = sharedContext) {
            if (disposed) return;
            sharedContext = context || sharedContext;
            const intent = routeIntent(route);
            if (intent.query !== query) query = intent.query;
            if (intent.noteId && intent.noteId !== draft?.id) {
                const match = state?.notes?.find(note => note.id === intent.noteId && !note.deleted);
                if (match && !dirty) { selectedId = match.id; draft = clone(match); }
                else if (match && dirty) status = { kind: "unsaved", text: "Save or discard this draft before opening another note." };
            }
            try {
                const next = await verifyCurrent();
                if (account && (next.origin !== account.origin || next.accountId !== account.accountId)) {
                    setStatus("Your Canvas account changed. Your unsaved draft is still here; reopen Notes for the other account.", "error");
                    return;
                }
            } catch (error) {
                if (draft) setStatus("Canvas account verification failed. Your unsaved draft is still here.", "error");
            }
            render();
        }

        async function search(searchQuery, context = sharedContext, limit = 8) {
            const needle = clean(searchQuery, 240);
            if (!needle || !model?.createStore || !storage?.get || !storage?.set) return [];
            const resolved = await resolveAccount(context, undefined);
            const verified = resolved && accountFromContext({ account: { canvas: { ...resolved, verified: true } } });
            if (!verified) throw new Error("Canvas account could not be verified. Reload Canvas and try again.");
            const verify = async () => {
                const current = await resolveAccount(context, undefined);
                const normalized = current && accountFromContext({ account: { canvas: { ...current, verified: true } } });
                if (!normalized) throw new Error("Canvas account could not be verified. Reload Canvas and try again.");
                return normalized;
            };
            const loaded = await model.createStore({ storage, context: verified, verify }).load();
            const lower = needle.toLocaleLowerCase();
            return loaded.notes
                .filter(note => !note.deleted && `${note.title} ${note.body}`.toLocaleLowerCase().includes(lower))
                .sort((left, right) => right.updatedAt - left.updatedAt)
                .slice(0, Math.max(1, Math.min(20, Number(limit) || 8)))
                .map(note => Object.freeze({
                    id: `local-note-${note.id}`,
                    route: "notes",
                    label: note.title,
                    helper: excerpt(note.body) || "Saved local note",
                    terms: `${note.title} ${excerpt(note.body, 240)}`.toLocaleLowerCase(),
                    detail: Object.freeze({ query: needle, noteId: note.id })
                }));
        }

        async function dispose() {
            if (disposed) return;
            disposed = true;
            generation += 1;
            abortController?.abort?.();
            if (host && rootNode && Array.from(host.children || []).includes(rootNode)) host.replaceChildren();
            rootNode = null;
            host = null;
            store = null;
            state = null;
            courses = [];
            setDirty(false);
        }

        const api = Object.freeze({ mount, routeUpdate, queryDirty: () => dirty, search, dispose });
        return api;
    }

    return Object.freeze({ createWorkspaceNotes, accountFromContext, routeIntent, excerpt });
}));
