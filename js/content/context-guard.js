(function (root, factory) {
    "use strict";
    const api = factory();
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasContent = Object.assign(root.APStudyCanvasContent || {}, { ExtensionContext: api });
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const INVALIDATED_CONTEXT = /^(?:Extension context invalidated|Extension context was invalidated)$/i;

    function isInvalidated(error) {
        const message = error instanceof Error ? error.message : error?.message ?? error;
        return INVALIDATED_CONTEXT.test(String(message || "").trim());
    }

    function run(task, { onInvalidated = () => {} } = {}) {
        let result;
        try {
            result = task();
        } catch (error) {
            return settle(error);
        }
        return Promise.resolve(result).catch(settle);

        function settle(error) {
            if (!isInvalidated(error)) return Promise.reject(error);
            try { onInvalidated(error); } catch (cleanupError) {}
            return { ok: false, invalidated: true };
        }
    }

    return Object.freeze({ isInvalidated, run });
}));
