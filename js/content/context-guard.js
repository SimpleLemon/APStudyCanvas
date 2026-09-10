(function (root, factory) {
    "use strict";
    const api = factory();
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasContent = Object.assign(root.APStudyCanvasContent || {}, { ExtensionContext: api });
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    // The canonical Chrome phrase, plus the wrappers the platform is allowed
    // to add ("Uncaught", "Uncaught (in promise)", an "…Error:" tag — where
    // the tag may be a bare "Error:") and trailing punctuation. Anything that
    // changes the sentence — extra words, other failures — must not match, so
    // unrelated errors still propagate.
    const INVALIDATED_CONTEXT = /^(?:uncaught(?:\s+\(in promise\))?\s+)?(?:(?:[a-z][a-z0-9_ ]*)?error:?\s*)?extension context (?:was )?invalidated(?:[.!?]+)?$/i;

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
