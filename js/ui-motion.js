(function (root, factory) {
    'use strict';
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.APStudyCanvasMotion = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';
    // Weak ownership: disposed modules and detached feature trees are never cached.
    const loading = new WeakMap();
    const animations = new WeakMap();
    const reduced = win => win?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
    function cancelReveal(node) {
        const cancel = node && animations.get(node);
        cancel?.();
    }
    function reveal(node, duration = 150) {
        if (!node) return;
        cancelReveal(node);
        const doc = node.ownerDocument, win = doc?.defaultView;
        if (!node.animate || reduced(win) || doc?.hidden || node.hidden) return;
        const effect = node.animate([{ opacity: 0.65 }, { opacity: 1 }], { duration, easing: 'cubic-bezier(.16,1,.3,1)' });
        const media = win?.matchMedia?.('(prefers-reduced-motion: reduce)');
        let done = false;
        const cancel = () => {
            if (done) return; done = true;
            effect.cancel();
            animations.delete(node);
            doc?.removeEventListener?.('visibilitychange', hidden);
            win?.removeEventListener?.('pagehide', cancel);
            media?.removeEventListener?.('change', cancel);
        };
        const hidden = () => { if (doc.hidden) cancel(); };
        animations.set(node, cancel);
        doc?.addEventListener?.('visibilitychange', hidden);
        win?.addEventListener?.('pagehide', cancel, { once: true });
        media?.addEventListener?.('change', cancel);
        effect.finished.then(cancel, cancel);
    }
    function clearLoading(host) { if (host) loading.get(host)?.(); }
    function showLoading(host, label, kind = 'rows') {
        if (!host?.ownerDocument) return () => {};
        clearLoading(host);
        const doc = host.ownerDocument, win = doc.defaultView;
        const box = doc.createElement('div'); box.className = `apstudy-loading apstudy-loading--${kind}`;
        const status = doc.createElement('p'); status.className = 'apstudy-loading-status'; status.textContent = label; status.setAttribute('role', 'status');
        const shapes = doc.createElement('div'); shapes.className = 'apstudy-skeleton'; shapes.setAttribute('aria-hidden', 'true');
        for (let i = 0; i < (kind === 'account' ? 3 : 6); i++) { const line = doc.createElement('span'); shapes.appendChild(line); }
        if (label) box.appendChild(status); box.appendChild(shapes); host.appendChild(box); host.setAttribute('aria-busy', 'true');
        let visible = false, done = false;
        const sync = () => { box.setAttribute('data-motion-visible', visible && !doc.hidden ? 'true' : 'false'); };
        // One observer per active loading region, disconnected as soon as it settles.
        const Observer = win?.IntersectionObserver;
        const observer = Observer ? new Observer(entries => { if (done) return; visible = entries.some(e => e.isIntersecting); sync(); }) : null;
        observer?.observe(box); sync();
        const clear = () => {
            if (done) return; done = true;
            observer?.disconnect(); doc.removeEventListener?.('visibilitychange', sync); win?.removeEventListener?.('pagehide', clear);
            box.remove?.(); host.removeAttribute?.('aria-busy'); loading.delete(host);
        };
        doc.addEventListener?.('visibilitychange', sync); win?.addEventListener?.('pagehide', clear, { once: true });
        loading.set(host, clear);
        return clear;
    }
    function watchVisibility(node) {
        if (!node?.ownerDocument) return () => {};
        const doc = node.ownerDocument, win = doc.defaultView;
        let visible = false;
        const sync = () => { node.setAttribute('data-motion-visible', visible && !doc.hidden ? 'true' : 'false'); };
        const observer = win?.IntersectionObserver ? new win.IntersectionObserver(entries => { visible = entries.some(e => e.isIntersecting); sync(); }) : null;
        observer?.observe(node); sync();
        const dispose = () => { observer?.disconnect(); doc.removeEventListener?.('visibilitychange', sync); win?.removeEventListener?.('pagehide', dispose); };
        doc.addEventListener?.('visibilitychange', sync); win?.addEventListener?.('pagehide', dispose, { once: true });
        return dispose;
    }
    function dispose(host) { clearLoading(host); cancelReveal(host); }
    return Object.freeze({ showLoading, clearLoading, reveal, cancelReveal, watchVisibility, dispose });
}));
