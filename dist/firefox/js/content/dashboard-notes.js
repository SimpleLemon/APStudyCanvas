(function (root, factory) {
    "use strict";
    const api = factory();
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasContent = Object.assign(root.APStudyCanvasContent || {}, { DashboardNotes: api });
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const SOURCE_KEY = "dashboard_notes_text";
    const STATE_KEY = "dashboard_notes_checkbox_state_v1";
    const NOTE_ID = "dashboard-note-v1";
    const MAX_SOURCE_CHARS = 12000;
    const MAX_TASKS = 100;
    const MAX_STATE_BYTES = 6000;
    // Canvas replaces the dashboard card root asynchronously on some SPA
    // returns. Keep the readiness watch short: it exists only to bridge that
    // handoff, never to become a second permanent page lifecycle.
    const READY_WINDOW_MS = 3000;
    const byteLength = (value) => {
        const text = JSON.stringify(value);
        return typeof TextEncoder === "function" ? new TextEncoder().encode(text).length : unescape(encodeURIComponent(text)).length;
    };
    function hash(value) { let h = 2166136261; for (let i = 0; i < value.length; i += 1) { h ^= value.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }
    function safeUrl(value) {
        try { const url = new URL(String(value).trim()); return url.protocol === "https:" && !url.username && !url.password ? url.href : null; } catch (error) { return null; }
    }
    function normalizeSource(value) { return typeof value === "string" ? value.slice(0, MAX_SOURCE_CHARS).replace(/\r\n?/g, "\n") : ""; }
    function parse(value) {
        const source = normalizeSource(value); let offset = 0; let count = 0;
        return Object.freeze(source.split("\n").flatMap((line) => {
            const start = offset; const end = start + line.length; offset = end + 1;
            const task = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.*)$/);
            const heading = line.match(/^\s{0,3}(#{1,3})\s+(.+?)\s*#*\s*$/);
            const list = line.match(/^\s*[-*]\s+(.+)$/);
            if (task && count++ < MAX_TASKS) return [{ type: "task", checked: task[1].toLowerCase() === "x", text: task[2], start, end, id: `${NOTE_ID}:${hash(`${start}:${end}:${line}`)}` }];
            if (heading) return [{ type: "heading", level: Math.min(3, heading[1].length + 1), text: heading[2], start, end }];
            if (list) return [{ type: "list", text: list[1], start, end }];
            return line.trim() ? [{ type: "paragraph", text: line, start, end }] : [];
        }));
    }
    function appendInline(doc, parent, value) {
        const expression = /(`[^`]*`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]*\))/g; let cursor = 0; const text = String(value || "");
        text.replace(expression, (token, index) => {
            if (index > cursor) parent.append(doc.createTextNode(text.slice(cursor, index))); cursor = index + token.length;
            if (token[0] === "`") { const node = doc.createElement("code"); node.textContent = token.slice(1, -1); parent.append(node); }
            else if (token.startsWith("**")) { const node = doc.createElement("strong"); node.textContent = token.slice(2, -2); parent.append(node); }
            else if (token[0] === "*") { const node = doc.createElement("em"); node.textContent = token.slice(1, -1); parent.append(node); }
            else { const match = token.match(/^\[([^\]]+)\]\((.*)\)$/); const href = safeUrl(match?.[2]); if (!href) parent.append(doc.createTextNode(match?.[1] || token)); else { const node = doc.createElement("a"); node.href = href; node.target = "_blank"; node.rel = "noopener noreferrer"; node.textContent = match[1]; parent.append(node); } }
            return token;
        });
        if (cursor < text.length) parent.append(doc.createTextNode(text.slice(cursor)));
    }
    function normalizedState(value, tasks) {
        const permitted = new Set(tasks.map((task) => task.id)); const input = value?.version === 1 && value?.noteId === NOTE_ID && value?.tasks && typeof value.tasks === "object" ? value.tasks : {}; const states = {};
        Object.entries(input).forEach(([id, checked]) => { if (permitted.has(id) && typeof checked === "boolean") states[id] = checked; });
        const result = { version: 1, noteId: NOTE_ID, tasks: states }; return byteLength(result) <= MAX_STATE_BYTES ? result : { version: 1, noteId: NOTE_ID, tasks: {} };
    }
    function createPersistence({ storage, onError = () => {} } = {}) {
        let state = { version: 1, noteId: NOTE_ID, tasks: {} };
        // `committed` is the last state known to have reached extension
        // storage. It is deliberately separate from the optimistic UI state:
        // two rapid toggles of the same box can both fail, in which case the
        // later failure must restore the stored value, not the earlier failed
        // optimistic value.
        let committed = state;
        let queue = Promise.resolve();
        // A write is intentionally derived when it reaches the queue, not when
        // a checkbox event fires. Otherwise a failed earlier write can be
        // accidentally included in a later successful write for a different
        // checkbox.
        const revisions = new Map();
        async function load(tasks, { isCurrent = () => true } = {}) {
            try {
                const loaded = normalizedState((await storage.get(STATE_KEY))?.[STATE_KEY], tasks);
                // A source edit can change the permitted task ids while this
                // read is pending. Do not let the old normalization replace
                // the state that the newer source will load.
                if (isCurrent()) { state = loaded; committed = state; }
            } catch (error) { if (isCurrent()) onError("Notes could not load saved checkbox state."); }
            return state;
        }
        function save(tasks, id, checked) {
            const revision = (revisions.get(id) || 0) + 1;
            revisions.set(id, revision);
            state = normalizedState({ ...state, tasks: { ...state.tasks, [id]: Boolean(checked) } }, tasks);
            // Recover the queue after an earlier failure so a later user
            // action can retry rather than inheriting a permanently rejected
            // promise chain.
            queue = queue.catch(() => undefined).then(async () => {
                const snapshot = state;
                try {
                    await storage.set({ [STATE_KEY]: snapshot });
                    committed = snapshot;
                } catch (error) {
                    // Never undo a newer toggle of this same checkbox. For an
                    // unrelated later toggle, remove only the failed change so
                    // its queued write persists the remaining current state.
                    if (revisions.get(id) === revision) {
                        const nextTasks = { ...state.tasks };
                        if (Object.prototype.hasOwnProperty.call(committed.tasks, id)) nextTasks[id] = committed.tasks[id];
                        else delete nextTasks[id];
                        state = normalizedState({ ...state, tasks: nextTasks }, tasks);
                    }
                    onError("Checkbox state could not be saved. Your change was restored.");
                    throw error;
                }
            });
            return queue.then(() => ({ ok: true, state })).catch(() => ({ ok: false, state, checked: Boolean(checked), revision }));
        }
        function cleanup(tasks) { const next = normalizedState(state, tasks); state = next; queue = queue.catch(() => undefined).then(() => storage.set({ [STATE_KEY]: next })).catch(() => { onError("Old checkbox state could not be cleaned up."); }); return queue; }
        return Object.freeze({ load, save, cleanup, state: () => state });
    }
    function createDashboardNotes({ document: doc = globalThis.document, storage = globalThis.chrome?.storage?.sync, setTimer = setTimeout, clearTimer = clearTimeout, mutationObserver: MutationObserverClass = globalThis.MutationObserver, readyWindowMs = READY_WINDOW_MS } = {}) {
        let root, textarea, preview, status, source = "", tasks = [], timer = null, persistence, mounted = false;
        let readyObserver = null, readyTimer = null, findContainer = null, desiredSource = "", mountVersion = 0, sourceGeneration = 0, readinessEnabled = false;
        const report = (message) => { if (status) status.textContent = message || ""; };
        const resize = () => { if (textarea) { textarea.style.height = "1px"; textarea.style.height = `${textarea.scrollHeight + 5}px`; } };
        const clearReadyWatch = () => {
            readyObserver?.disconnect?.();
            readyObserver = null;
            if (readyTimer !== null) clearTimer(readyTimer);
            readyTimer = null;
        };
        const setSource = (value) => { source = normalizeSource(value); sourceGeneration += 1; return source; };
        function render() {
            tasks = parse(source).filter((item) => item.type === "task"); preview.replaceChildren(); let taskList = null;
            parse(source).forEach((item) => {
                if (item.type === "task") {
                    if (!taskList) { taskList = doc.createElement("ul"); taskList.className = "apstudy-dashboard-note-tasks"; preview.append(taskList); }
                    const row = doc.createElement("li"); row.dataset.apstudyNoteSourceStart = String(item.start); row.dataset.apstudyNoteSourceEnd = String(item.end);
                    const input = doc.createElement("input"); input.type = "checkbox"; input.id = `apstudy-note-${hash(item.id)}`; input.checked = persistence.state().tasks[item.id] ?? item.checked; input.dataset.apstudyNoteTaskId = item.id;
                    const label = doc.createElement("label"); label.htmlFor = input.id; appendInline(doc, label, item.text);
                    input.addEventListener("change", () => {
                        const previous = !input.checked;
                        const checked = input.checked;
                        persistence.save(tasks, item.id, checked).then((result) => {
                            // A delayed failed write must not visually undo a
                            // newer toggle the user made while it was pending.
                            if (!result.ok && input.checked === checked) input.checked = previous;
                        });
                    }); row.append(input, label); taskList.append(row); return;
                }
                taskList = null; const node = doc.createElement(item.type === "heading" ? `h${item.level}` : item.type === "list" ? "li" : "p"); node.dataset.apstudyNoteSourceStart = String(item.start); node.dataset.apstudyNoteSourceEnd = String(item.end); appendInline(doc, node, item.text);
                if (item.type === "list") { const list = doc.createElement("ul"); list.append(node); preview.append(list); } else preview.append(node);
            });
        }
        function queueSourceSave() { clearTimer(timer); timer = setTimer(async () => { try { await storage.set({ [SOURCE_KEY]: source }); await persistence.cleanup(tasks); report(""); } catch (error) { report("Notes could not be saved. Keep this page open and try again."); } }, 500); }
        async function mount(container, initialSource) {
            if (!container || !storage) return false;
            const version = ++mountVersion;
            if (!root) { root = doc.createElement("section"); root.className = "canvasrefined-dashboard-notes"; root.dataset.apstudycanvasOwned = "true"; textarea = doc.createElement("textarea"); textarea.className = "canvasrefined-dashboard-notes-source"; textarea.placeholder = "Write a note with Markdown"; textarea.setAttribute("aria-label", "Dashboard note Markdown source"); preview = doc.createElement("div"); preview.className = "apstudy-dashboard-note-preview"; preview.setAttribute("aria-label", "Rendered dashboard note"); status = doc.createElement("p"); status.className = "apstudy-dashboard-note-status"; status.setAttribute("aria-live", "polite"); root.append(textarea, preview, status); container.prepend(root); textarea.addEventListener("input", () => { setSource(textarea.value); render(); resize(); queueSourceSave(); }); persistence = createPersistence({ storage, onError: report }); }
            if (root.parentElement !== container) container.prepend(root);
            mounted = true; setSource(initialSource); textarea.value = source; tasks = parse(source).filter((item) => item.type === "task");
            const generation = sourceGeneration;
            const isCurrent = () => mounted && version === mountVersion && generation === sourceGeneration && root && preview && textarea && persistence;
            await persistence.load(tasks, { isCurrent });
            // A route teardown or a later reconciliation can finish while the
            // storage read is pending. A source edit has the same boundary:
            // retry with its task snapshot rather than rendering new text
            // with state normalized for the old task set.
            if (!isCurrent()) return mounted && version === mountVersion && root?.parentElement === container ? mount(container, source) : false;
            render(); resize(); return true;
        }
        function update(initialSource) { if (!mounted || textarea === doc.activeElement) return; setSource(initialSource); textarea.value = source; render(); resize(); }
        function observeReadiness() {
            if (readyObserver || readyTimer !== null || typeof findContainer !== "function") return;
            const check = () => {
                if (!readinessEnabled) return;
                const container = findContainer();
                if (!container) return;
                clearReadyWatch();
                void mount(container, desiredSource);
            };
            if (typeof MutationObserverClass === "function" && doc?.documentElement) {
                readyObserver = new MutationObserverClass(check);
                readyObserver.observe(doc.documentElement, { childList: true, subtree: true });
            }
            readyTimer = setTimer(clearReadyWatch, Math.max(0, Number(readyWindowMs) || READY_WINDOW_MS));
            check();
        }
        function reconcile({ enabled = true, source: nextSource, getContainer } = {}) {
            if (typeof getContainer === "function") findContainer = getContainer;
            if (nextSource !== undefined) desiredSource = normalizeSource(nextSource);
            if (!enabled) { destroy(); return false; }
            readinessEnabled = true;
            const container = typeof findContainer === "function" ? findContainer() : null;
            if (!container) { observeReadiness(); return false; }
            clearReadyWatch();
            if (!mounted || root?.parentElement !== container) void mount(container, desiredSource);
            else update(desiredSource);
            return true;
        }
        function destroy() { readinessEnabled = false; mountVersion += 1; clearReadyWatch(); mounted = false; clearTimer(timer); timer = null; root?.remove?.(); root = textarea = preview = status = persistence = null; }
        return Object.freeze({ mount, update, reconcile, destroy, isMounted: () => mounted, isWaiting: () => Boolean(readyObserver || readyTimer !== null) });
    }
    return Object.freeze({ SOURCE_KEY, STATE_KEY, NOTE_ID, MAX_SOURCE_CHARS, MAX_TASKS, MAX_STATE_BYTES, READY_WINDOW_MS, safeUrl, normalizeSource, parse, normalizedState, createPersistence, createDashboardNotes });
}));
