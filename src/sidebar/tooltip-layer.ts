// ONE floating layer for every static tooltip in the panel.
//
// The old scheme was a hidden-but-present `.tt-pop` sibling revealed by `:hover`. That is three problems at
// once, and they were being patched one call site at a time:
//
//   1. COPY-PASTE. The text is in the DOM whether or not it is shown, so selecting a row and copying it drags
//      every tooltip's prose along with it.
//   2. CLIPPING. It is positioned inside the layout, so ANY scrolling or overflow-hidden ancestor cuts it off
//      — which is why tooltips kept disappearing behind the resizable resource panel, the output cell, and
//      the plot.
//   3. DIRECTION. Which way it opens was hardcoded per call site (`left`, `above`, `wide`), so every new
//      placement had to rediscover which edge it would run off.
//
// This moves the rendering to a single `position: fixed` element outside the flow: nothing clips it, its
// direction is COMPUTED from where the trigger actually is, and the source node stays `display: none` so it
// is never selected or copied. The markup does not change — the existing `.tt` / `.tt-pop` pairs keep working,
// and the direction classes become hints rather than instructions.
import { tipStyle } from "./tip";

const MARGIN = 6;

/** Install the layer on a root (the sidebar's shadow root, or a document). Idempotent. */
export function installTooltipLayer(root: Document | ShadowRoot, doc: Document = document): () => void {
    const host = (root as ShadowRoot).host ? (root as ShadowRoot) : (root as Document);
    if ((host as { __mlTipLayer?: boolean }).__mlTipLayer) return () => {};
    (host as { __mlTipLayer?: boolean }).__mlTipLayer = true;

    const layer = doc.createElement("div");
    layer.className = "tt-layer";
    layer.setAttribute("role", "tooltip");
    layer.hidden = true;
    ((root as ShadowRoot).host ? root : doc.body).appendChild(layer);

    let current: Element | null = null;
    // The layer holds a COPY, so anything that re-renders the source while it is open (the resource panel
    // polls every 2s) would leave the reader looking at a figure the panel no longer believes. Watch the
    // source and re-copy — a tooltip that disagrees with what is under it is worse than no tooltip.
    const watcher = doc.defaultView?.MutationObserver
        ? new (doc.defaultView.MutationObserver)(() => { if (current) fill(current); })
        : null;
    const hide = (): void => {
        current = null; layer.hidden = true; layer.textContent = "";
        watcher?.disconnect();
    };

    /** Copy the trigger's tooltip content into the layer. Returns false when it has none (any more). */
    const fill = (trigger: Element): boolean => {
        const src = trigger.querySelector(".tt-pop");
        if (!src) return false;
        layer.textContent = "";
        for (const n of Array.from(src.childNodes)) layer.appendChild(n.cloneNode(true));
        layer.classList.toggle("wrap", src.classList.contains("wrap") || src.classList.contains("wide") || src.classList.contains("left"));
        return true;
    };

    const show = (trigger: Element): void => {
        const src = trigger.querySelector(".tt-pop");
        if (!src) return hide();
        current = trigger;
        // Clone rather than move: the source stays put (and hidden), so nothing about the row's markup or its
        // tests changes, and a re-render can't strand the layer holding a detached node.
        // (`wrap`/`wide` carry a width intent worth keeping; direction classes do not — see fill.)
        fill(trigger);
        layer.hidden = false;
        // WRAP IF IT DOES NOT FIT, whatever the call site said. `.tt-layer` is nowrap with a max-width, so a
        // sentence longer than that is simply CLIPPED — the end of the very thing being explained is the part
        // you cannot read. `wrap` existed to prevent that and had to be remembered per call site, which is
        // not a judgement anyone can make reliably: it depends on the rendered width, the font scale, and
        // whatever the text says today. The layer is already measured here, so it can just look. An explicit
        // `wrap` still wins (it is a width INTENT, not only an overflow fix) — this only ever adds it.
        if (!layer.classList.contains("wrap") && layer.scrollWidth > layer.clientWidth + 1) layer.classList.add("wrap");
        // Re-copy on any change under the trigger. Observing the TRIGGER, not the popup, because a re-render
        // may replace the .tt-pop node itself rather than editing its text.
        watcher?.disconnect();
        watcher?.observe(trigger, { childList: true, subtree: true, characterData: true });

        // Measure AFTER content is in, then place against the viewport — the only box that never scrolls out
        // from under it.
        const t = trigger.getBoundingClientRect();
        const w = doc.defaultView?.innerWidth ?? 1024;
        const h = doc.defaultView?.innerHeight ?? 768;
        const box = layer.getBoundingClientRect();
        const style = tipStyle({ x: t.left + t.width / 2, y: t.top, w });
        Object.assign(layer.style, { left: "auto", right: "auto", ...style });
        // tipStyle decides the side; the vertical half needs the tooltip's own height, which only exists now.
        const above = t.top - box.height - MARGIN;
        layer.style.top = `${above >= MARGIN ? above : Math.min(t.bottom + MARGIN, h - box.height - MARGIN)}px`;
    };

    const over = (e: Event): void => {
        const el = (e.target as Element | null)?.closest?.(".tt");
        if (el) { if (el !== current) show(el); }
        else if (current) hide();
    };
    const out = (e: Event): void => {
        const to = (e as MouseEvent).relatedTarget as Element | null;
        if (!to || !to.closest?.(".tt")) hide();
    };

    root.addEventListener("pointerover", over, true);
    root.addEventListener("pointerout", out, true);
    root.addEventListener("pointerdown", hide, true);
    // A tooltip anchored to something that has scrolled away is worse than none.
    root.addEventListener("scroll", hide, true);
    doc.defaultView?.addEventListener("blur", hide);

    return () => {
        root.removeEventListener("pointerover", over, true);
        root.removeEventListener("pointerout", out, true);
        root.removeEventListener("pointerdown", hide, true);
        root.removeEventListener("scroll", hide, true);
        watcher?.disconnect();
        layer.remove();
        (host as { __mlTipLayer?: boolean }).__mlTipLayer = false;
    };
}
