/* Local-only settings editor contracts. Remote theme-service runtime is retired. */
(function (root, factory) {
    "use strict";
    const api = factory();
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasSettingsEditors = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";
    const GPA_ORDER = Object.freeze(["A+", "A", "A-", "B+", "B", "B-", "C+", "C", "C-", "D+", "D", "D-", "F"]);
    const GPA_BY_LETTER_PRESET = Object.freeze({
        "A+": Object.freeze({ cutoff: 97, gpa: 4 }),
        A: Object.freeze({ cutoff: 93, gpa: 4 }),
        "A-": Object.freeze({ cutoff: 90, gpa: 4 }),
        "B+": Object.freeze({ cutoff: 87, gpa: 3 }),
        B: Object.freeze({ cutoff: 83, gpa: 3 }),
        "B-": Object.freeze({ cutoff: 80, gpa: 3 }),
        "C+": Object.freeze({ cutoff: 77, gpa: 2 }),
        C: Object.freeze({ cutoff: 73, gpa: 2 }),
        "C-": Object.freeze({ cutoff: 70, gpa: 2 }),
        "D+": Object.freeze({ cutoff: 67, gpa: 1 }),
        D: Object.freeze({ cutoff: 63, gpa: 1 }),
        "D-": Object.freeze({ cutoff: 60, gpa: 1 }),
        F: Object.freeze({ cutoff: 0, gpa: 0 })
    });
    const plain = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
    const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

    function validCourseImage(value) {
        const candidate = typeof value === "string" ? value.trim() : "";
        if (!candidate || candidate.toLowerCase() === "none") return { valid: true, value: candidate.toLowerCase() === "none" ? "none" : "" };
        try {
            const url = new URL(candidate);
            return /^(?:http:|https:)$/.test(url.protocol) ? { valid: true, value: url.href } : { valid: false, value: candidate };
        } catch (_) { return { valid: false, value: candidate }; }
    }

    function createCourseCardEditor({ store, transaction, render, confirm, status, sendToCanvas } = {}) {
        const run = transaction || store?.transaction;
        if (typeof run !== "function") throw new Error("COURSE_CARD_TRANSACTION_UNAVAILABLE");
        const report = typeof status === "function" ? status : () => {};
        const redraw = typeof render === "function" ? render : () => {};
        const ask = typeof confirm === "function" ? confirm : () => true;
        let queue = Promise.resolve();
        const partition = (courseId, current, updates, fallback = {}) => {
            if (!courseId) throw new Error("COURSE_ID_REQUIRED");
            const cards = ["custom_cards", "custom_cards_2", "custom_cards_3"].map((key) => plain(current?.[key]) ? current[key] : {});
            // Read the same precedence order used by the legacy renderer, then
            // write the resolved card into the primary partition. Removing the
            // duplicate rows makes a stale lower/upper partition unable to
            // resurrect an old course value after a save.
            const oldCard = Object.assign({}, ...cards.map((entry) => plain(entry[courseId]) ? entry[courseId] : {}));
            const next = { ...oldCard };
            ["default", "eid", "weight", "credits", "gr"].forEach((key) => { if (next[key] === undefined && fallback[key] !== undefined) next[key] = fallback[key]; });
            Object.assign(next, updates);
            const withoutCourse = cards.slice(1).map((entry) => {
                const output = { ...entry };
                delete output[courseId];
                return output;
            });
            return { custom_cards: { ...cards[0], [courseId]: next }, custom_cards_2: withoutCourse[0], custom_cards_3: withoutCourse[1] };
        };
        const commit = (courseId, updates, fallback, message) => {
            const work = async () => {
                const result = await run((current) => partition(courseId, current, updates, fallback));
                await Promise.resolve(sendToCanvas?.("refreshCards", { courseId }));
                report(message); redraw(); return result;
            };
            const next = queue.then(work, work); queue = next.catch(() => {}); return next;
        };
        function save(courseId, draft, fallback = {}) {
            const image = validCourseImage(draft?.img);
            if (!image.valid) { report("Use an http(s) image URL, or leave the image blank.", true); return Promise.reject(new Error("COURSE_IMAGE_INVALID")); }
            return commit(courseId, { ...draft, img: image.value, hidden: draft?.hidden === true, hide: draft?.hidden === true }, fallback, "Course card saved.");
        }
        function reset(courseId, fallback = {}) {
            if (!ask("Reset this course card to its Canvas defaults?")) return Promise.resolve({ cancelled: true });
            const work = async () => {
                const result = await run((current) => Object.fromEntries(["custom_cards", "custom_cards_2", "custom_cards_3"].map((key) => {
                    const cards = plain(current?.[key]) ? { ...current[key] } : {};
                    delete cards[courseId];
                    return [key, cards];
                })));
                await Promise.resolve(sendToCanvas?.("refreshCards", { courseId }));
                report("Course card reset to Canvas defaults."); redraw(); return result;
            };
            const next = queue.then(work, work); queue = next.catch(() => {}); return next;
        }
        return Object.freeze({ validCourseImage, partition, save, reset });
    }

    function createGpaBoundsEditor({ transaction, read, render, status } = {}) {
        if (typeof transaction !== "function") throw new Error("GPA_TRANSACTION_UNAVAILABLE");
        const readBounds = typeof read === "function" ? read : null;
        const redraw = typeof render === "function" ? render : () => {};
        const report = typeof status === "function" ? status : () => {};
        const isValidBounds = (bounds) => plain(bounds) && Object.keys(bounds).length === GPA_ORDER.length && GPA_ORDER.every((key, index) => {
            const entry = bounds[key];
            const previous = index ? bounds[GPA_ORDER[index - 1]] : null;
            return plain(entry) && Number.isFinite(entry.cutoff) && entry.cutoff >= 0 && entry.cutoff <= 101
                && Number.isFinite(entry.gpa) && entry.gpa >= 0 && entry.gpa <= 5
                && (!previous || entry.cutoff <= previous.cutoff);
        });
        function update(letter, field, raw) {
            const value = Number(raw), max = field === "cutoff" ? 101 : 5;
            if (!GPA_ORDER.includes(letter) || !["cutoff", "gpa"].includes(field) || !Number.isFinite(value) || value < 0 || value > max) {
                report(field === "cutoff" ? "Enter a grade cutoff from 0 to 101." : "Enter a GPA value from 0 to 5.", true);
                return Promise.reject(new Error("GPA_BOUND_INVALID"));
            }
            const nextBoundsFor = (current) => {
                const bounds = plain(current?.gpa_calc_bounds) ? current.gpa_calc_bounds : {};
                if (!plain(bounds[letter])) throw new Error("GPA_BOUND_MISSING");
                const nextBounds = { ...bounds, [letter]: { ...bounds[letter], [field]: value } };
                if (!isValidBounds(nextBounds)) throw new Error("GPA_BOUND_ORDER_INVALID");
                return nextBounds;
            };
            const commit = () => transaction((current) => ({ gpa_calc_bounds: nextBoundsFor(current) }));
            const preflight = readBounds ? Promise.resolve().then(readBounds).then(nextBoundsFor) : Promise.resolve();
            return preflight.then(commit).then((result) => { redraw(); return result; }, (error) => {
                report(error.message === "GPA_BOUND_ORDER_INVALID" ? "Grade cutoffs must stay in descending letter-grade order." : "GPA bounds could not be saved.", true);
                redraw();
                throw error;
            });
        }
        function applyPreset(bounds) {
            if (!isValidBounds(bounds)) return Promise.reject(new Error("GPA_PRESET_INVALID"));
            return transaction(() => ({ gpa_calc_bounds: clone(bounds) })).then((result) => { redraw(); return result; }, (error) => { redraw(); throw error; });
        }
        return Object.freeze({ order: GPA_ORDER, update, applyPreset });
    }

    function createAppearanceTools({ transaction, draft, status, sendToCanvas, validateHttpsUrl } = {}) {
        if (typeof transaction !== "function") throw new Error("APPEARANCE_TRANSACTION_UNAVAILABLE");
        const report = typeof status === "function" ? status : () => {};
        const validate = typeof validateHttpsUrl === "function" ? validateHttpsUrl : (value) => ({ valid: /^https:\/\//i.test(String(value || "")), value: String(value || "").trim() });
        const supportedFonts = Object.freeze(["", "Newsreader", "Public Sans", "IBM Plex Mono", "System UI"]);
        // This editor deliberately accepts only faces available without a
        // network request. The content script maps these fixed choices to
        // packaged @font-face rules or browser system fallbacks.
        const normalizeFont = (value) => {
            const family = String(value || "").trim();
            return { link: "", family: supportedFonts.includes(family) ? family : "" };
        };
        const applyCss = (value, initial) => transaction(() => ({ custom_styles: String(value || "") })).then((result) => { draft?.setCss?.(false); report("Custom CSS applied."); return result; }).catch((error) => { draft?.setCss?.(String(value || "") !== String(initial || "")); throw error; });
        const discardCss = (initial) => { draft?.setCss?.(false); return String(initial || ""); };
        const applyBackground = (preset) => { const safe = validate(preset?.url, true); if (!safe.valid || !Number.isFinite(Number(preset?.scale))) return Promise.reject(new Error("BACKGROUND_PRESET_INVALID")); return transaction(() => ({ customBackgroundLink: safe.value, customBackgroundScale: Number(preset.scale) })).then(async (result) => { await Promise.resolve(sendToCanvas?.("updateBackground")); report("Background applied."); return result; }); };
        const clearBackground = () => transaction(() => ({ customBackgroundLink: "", customBackgroundScale: 100 })).then(async (result) => { await Promise.resolve(sendToCanvas?.("updateBackground")); return result; });
        const setDarkFixUrls = (urls) => transaction(() => ({ dark_mode_fix: Array.isArray(urls) ? urls.filter((value) => typeof value === "string") : [] }));
        return Object.freeze({ normalizeFont, applyCss, discardCss, applyBackground, clearBackground, setDarkFixUrls });
    }

    function createDiagnosticsTools({ store, confirm, status, inspectCanvas, requestCustomOrigin } = {}) {
        const ask = typeof confirm === "function" ? confirm : () => true, report = typeof status === "function" ? status : () => {};
        const loadErrors = async () => {
            const values = await store?.localGet?.("errors");
            // Legacy entries were raw stack strings. They are intentionally
            // neither rendered nor transformed here; only the fixed current
            // diagnostic record can reach the support UI.
            return Array.isArray(values?.errors) ? values.errors
                .filter((entry) => plain(entry) && entry.code === "CONTENT_RUNTIME_FAILED" && entry.category === "runtime")
                .map((entry) => "CONTENT_RUNTIME_FAILED (runtime)")
                : [];
        };
        const resetSupported = async (keys) => { if (!ask("Reset supported APStudyCanvas settings? This cannot be undone.")) return { cancelled: true }; if (typeof store?.reset !== "function") throw new Error("SUPPORTED_RESET_UNAVAILABLE"); const result = await store.reset(keys); report("Supported settings reset."); return result; };
        const inspect = async () => {
            if (typeof inspectCanvas !== "function") throw new Error("CANVAS_INSPECT_UNAVAILABLE");
            const result = await inspectCanvas();
            report("Dark-mode inspection complete.");
            return result;
        };
        const requestOrigin = async (origin) => {
            if (!ask("Allow APStudyCanvas to connect to this Canvas origin?")) return { cancelled: true };
            if (typeof requestCustomOrigin !== "function") throw new Error("CUSTOM_ORIGIN_REQUEST_UNAVAILABLE");
            const result = await requestCustomOrigin(origin);
            if (result?.ok !== true) throw new Error("CANVAS_ORIGIN_REQUEST_FAILED");
            report("Canvas origin connected and saved.");
            return result;
        };
        return Object.freeze({ loadErrors, resetSupported, inspect, requestCustomOrigin: requestOrigin });
    }
    return Object.freeze({ createCourseCardEditor, createGpaBoundsEditor, createAppearanceTools, createDiagnosticsTools, validCourseImage, GPA_ORDER, GPA_BY_LETTER_PRESET });
}));
