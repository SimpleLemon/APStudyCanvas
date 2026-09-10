(function (root, factory) {
    "use strict";
    const api = factory();
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.APStudyCanvasContent = Object.assign(root.APStudyCanvasContent || {}, { TodoEffects: api });
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    const EFFECT_TYPES = Object.freeze(["confetti", "fireworks", "stars", "hearts", "sparkle", "none"]);
    const INTENSITIES = Object.freeze(["none", "normal", "extra", "insane"]);
    const PARTICLE_COUNTS = Object.freeze({ none: 0, normal: 8, extra: 18, insane: 32 });
    const COLORS = Object.freeze(["#D4AF37", "#0d1328", "#55708f", "#b3261e"]);

    function normalizeType(value) {
        return EFFECT_TYPES.includes(value) ? value : "none";
    }

    function normalizeIntensity(value) {
        return INTENSITIES.includes(value) ? value : "normal";
    }

    function particleCount(intensity) {
        return PARTICLE_COUNTS[normalizeIntensity(intensity)];
    }

    function prefersReducedMotion(windowRef) {
        try { return Boolean(windowRef?.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches); }
        catch (error) { return false; }
    }

    function makeElement(documentRef, type, attributes = {}) {
        const element = documentRef.createElement(type);
        Object.entries(attributes).forEach(([key, value]) => {
            if (key === "className") element.className = value;
            else element.setAttribute?.(key, String(value));
        });
        return element;
    }

    function ensureLayer(container, documentRef) {
        if (!container) return null;
        const children = Array.from(container.children || container.childNodes || []);
        const existing = children.find((child) => child?.getAttribute?.("data-todo-effects-layer") === "true");
        if (existing) return existing;
        const layer = makeElement(documentRef, "div", {
            className: "apstudy-todo-effects-layer",
            "data-todo-effects-layer": "true",
            "aria-hidden": "true"
        });
        if (typeof container.append === "function") container.append(layer);
        else container.appendChild?.(layer);
        return layer;
    }

    function createStaticSuccess(layer, documentRef) {
        if (!layer) return null;
        const success = makeElement(documentRef, "span", {
            className: "apstudy-todo-effect-static",
            "data-effect-mode": "static",
            "aria-hidden": "true"
        });
        if (typeof layer.append === "function") layer.append(success);
        else layer.appendChild?.(success);
        return success;
    }

    function createTodoEffects({ document: documentRef = globalThis.document, window: windowRef = globalThis.window, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
        const activeTimers = new Set();
        const activeNodes = new Set();

        function celebrate({ container, type = "confetti", intensity = "normal", reducedMotion, onStaticSuccess = () => {} } = {}) {
            const layer = ensureLayer(container, documentRef);
            const normalizedType = normalizeType(type);
            const normalizedIntensity = normalizeIntensity(intensity);
            const isReduced = reducedMotion === undefined ? prefersReducedMotion(windowRef) : Boolean(reducedMotion);
            if (!layer) return { ok: false, mode: "unavailable", cleanup() {} };

            // A reduced-motion success remains visible as a bounded, static mark.
            // It never delays the completion mutation or captures focus.
            if (normalizedType === "none" || normalizedIntensity === "none") {
                return { ok: true, mode: "none", cleanup() {} };
            }

            if (isReduced) {
                const staticSuccess = createStaticSuccess(layer, documentRef);
                if (staticSuccess) activeNodes.add(staticSuccess);
                try { onStaticSuccess(); } catch (error) {}
                return { ok: true, mode: "static", cleanup() {} };
            }

            const count = particleCount(normalizedIntensity);
            const nodes = [];
            for (let index = 0; index < count; index += 1) {
                const particle = makeElement(documentRef, "span", {
                    className: `apstudy-todo-effect-particle is-${normalizedType}`,
                    "data-effect-type": normalizedType,
                    "data-effect-index": index
                });
                particle.style?.setProperty?.("--effect-index", String(index));
                particle.style?.setProperty?.("--effect-color", COLORS[index % COLORS.length]);
                if (typeof layer.append === "function") layer.append(particle);
                else layer.appendChild?.(particle);
                nodes.push(particle);
                activeNodes.add(particle);
            }

            const timer = setTimer(() => {
                activeTimers.delete(timer);
                nodes.forEach((node) => { activeNodes.delete(node); node.remove?.(); });
            }, 1100);
            activeTimers.add(timer);
            return {
                ok: true,
                mode: "animated",
                count,
                cleanup() {
                    if (activeTimers.has(timer)) {
                        clearTimer(timer);
                        activeTimers.delete(timer);
                    }
                    nodes.forEach((node) => { activeNodes.delete(node); node.remove?.(); });
                }
            };
        }

        function destroy() {
            activeTimers.forEach((timer) => clearTimer(timer));
            activeTimers.clear();
            activeNodes.forEach((node) => node.remove?.());
            activeNodes.clear();
        }

        return Object.freeze({ celebrate, destroy, particleCount, prefersReducedMotion });
    }

    return Object.freeze({
        EFFECT_TYPES,
        INTENSITIES,
        PARTICLE_COUNTS,
        normalizeType,
        normalizeIntensity,
        particleCount,
        prefersReducedMotion,
        createTodoEffects
    });
}));
