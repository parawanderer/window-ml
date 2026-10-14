// shadow-patch.ts — MAIN-world, document_start content script (declared in manifest.json).
//
// Captures CLOSED shadow roots so the opt-in "pierce closed shadow DOM" feature (config
// `pierceClosedShadow`) can reach inside them. Closed shadow DOM is ENCAPSULATION, not a security
// boundary: it lives in the same JS realm as the page, so wrapping Element.prototype.attachShadow BEFORE
// page components run lets us stash each closed root as it's created — WITHOUT changing its mode. The
// host's own `.shadowRoot` accessor still returns null, so component re-init guards (`if (this.shadowRoot)`)
// behave identically; only our WeakMap holds the reference.
//
// The WeakMap lives in this script's CLOSURE: no global, nothing the page can write. The DOM tools (injected.js, a
// separate script loaded later) get a READER for it once, by dispatching CLOSED_ROOTS_EVENT on window: this script's
// listener, registered before any page script, answers into the event's detail and stops it, so no page listener sees
// it. A page can dispatch the same event and read its own closed roots, which it authored; it cannot put a root behind
// a host. A page that wraps `dispatchEvent` before injected.js loads can hand the tools a reader of its own, as it can
// wrap any builtin the main-world tools call (docs/dev/detection-surface.md, row 4).
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

import { CLOSED_ROOTS_EVENT } from "./ids";

(() => {
    const proto = Element.prototype as { attachShadow?: (init: ShadowRootInit) => ShadowRoot };
    const original = proto.attachShadow;
    if (typeof original !== "function") return;   // ancient engine with no shadow DOM → nothing to do
    const roots = new WeakMap<Element, ShadowRoot>();
    // The builtins this closure calls, taken before any page script runs, so a page that rewrites them later cannot
    // read or fill the map through them.
    const apply = Reflect.apply;
    const wmGet = WeakMap.prototype.get, wmSet = WeakMap.prototype.set;
    const stop = Event.prototype.stopImmediatePropagation;
    const read = (el: Element): ShadowRoot | null => { try { return (apply(wmGet, roots, [el]) as ShadowRoot | undefined) ?? null; } catch { return null; } };
    const patched = function (this: Element, init: ShadowRootInit): ShadowRoot {
        const root = apply(original, this, [init]) as ShadowRoot;
        if (init && init.mode === "closed") {
            try { apply(wmSet, roots, [this, root]); } catch { /* exotic/frozen host key → skip, feature just won't reach it */ }
        }
        return root;
    };
    try {
        Object.defineProperty(proto, "attachShadow", { value: patched, configurable: true, writable: true });
    } catch { return; /* prototype frozen by the page → leave the native method; capture is simply unavailable */ }
    window.addEventListener(CLOSED_ROOTS_EVENT, (e: Event) => {
        apply(stop, e, []);
        const d = (e as CustomEvent<{ read?: unknown } | null>).detail;
        if (d && typeof d === "object") d.read = read;
    }, true);
})();
