// shadow-patch.ts — MAIN-world, document_start content script (declared in manifest.json).
//
// Captures CLOSED shadow roots so the opt-in "pierce closed shadow DOM" feature (config
// `pierceClosedShadow`) can reach inside them. Closed shadow DOM is ENCAPSULATION, not a security
// boundary: it lives in the same JS realm as the page, so wrapping Element.prototype.attachShadow BEFORE
// page components run lets us stash each closed root as it's created — WITHOUT changing its mode. The
// host's own `.shadowRoot` accessor still returns null, so component re-init guards (`if (this.shadowRoot)`)
// behave identically; only our WeakMap holds the reference.
//
// Why a SEPARATE document_start script and not injected.js: injected.js is appended by the content script
// at document_idle — far too late; by then components have already attached their roots and the race is
// lost. This must run FIRST, in the page's main world (a content script can't wrap the page's prototype
// from the isolated world). It runs on EVERY page and the flag can't gate it (the main world has no
// chrome.storage to read synchronously, and an async read loses the race), but its only effect is a
// WeakMap.set on closed-root creation; dom.ts reads the map ONLY when the user turned the flag on, and when
// off the entries are GC'd with their elements (WeakMap keys are weak). It canNOT capture DECLARATIVE
// closed roots (`<template shadowrootmode="closed">`, attached by the HTML parser, never via attachShadow)
// or native/browser-internal roots — the DOM tools steer those to visual locate/@pt.

(() => {
    const proto = Element.prototype as { attachShadow?: (init: ShadowRootInit) => ShadowRoot };
    const original = proto.attachShadow;
    if (typeof original !== "function") return;   // ancient engine with no shadow DOM → nothing to do
    const KEY = "__mlClosedRoots";
    // Idempotent: if this script somehow runs twice (SPA soft-nav, double injection), don't re-wrap.
    if ((window as unknown as Record<string, unknown>)[KEY]) return;
    const roots = new WeakMap<Element, ShadowRoot>();
    // Non-enumerable so it doesn't show up in casual `for..in`/Object.keys sweeps of window. It's readable by
    // any same-realm script, but that's inherent — the page authored the closed root and could wrap
    // attachShadow itself; this grants no cross-origin capability, only lifts our own selector reach.
    Object.defineProperty(window, KEY, { value: roots, enumerable: false, configurable: false, writable: false });
    const patched = function (this: Element, init: ShadowRootInit): ShadowRoot {
        const root = original.call(this, init);
        if (init && init.mode === "closed") {
            try { roots.set(this, root); } catch { /* exotic/frozen host key → skip, feature just won't reach it */ }
        }
        return root;
    };
    try {
        Object.defineProperty(proto, "attachShadow", { value: patched, configurable: true, writable: true });
    } catch { /* prototype frozen by the page → leave the native method; capture is simply unavailable */ }
})();
