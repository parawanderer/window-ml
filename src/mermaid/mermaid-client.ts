// mermaid-client.ts — Mermaid diagrams in model-written Markdown: the markup `markdown()` emits for a ```mermaid fence,
// the cache of finished drawings, and the pass that turns a fence into a diagram once it is on screen.
//
// The drawing happens in a sandboxed frame (mermaid.html, mermaid-frame.ts), never here: the diagram source is the
// model's, and the library that parses it is large. What comes back is SVG text, shown as an `<img>`, so nothing in it
// runs. A page that renders Markdown calls `installMermaid(document)` once; nothing else needs to know.
//
// WHY A CACHE AND AN OBSERVER rather than a component: a reply's HTML is replaced wholesale on every streamed token
// (streaming-md.tsx), so a diagram inserted into one rendering is gone at the next. Instead `markdown()` asks the cache
// as it builds the HTML: a finished diagram is emitted as its `<img>` directly, and only a fence never drawn before is
// emitted PENDING. The observer finds pending ones, asks the frame, and upgrades that element in place; the cache then
// makes every later rendering of the same source come out finished.
//
// The states, as agreed for the chat page: (1) a fence still streaming is plain code (stream-close.ts keeps it so);
// (2) once it closes, a "drawing the diagram" placeholder shows, but only if drawing takes longer than PLACEHOLDER_MS,
// and the box grows from the code's height to the diagram's; (3) the diagram fades in. A parse error leaves the code
// with a one-line note. A reply that is not streaming (history, a reload) shows the finished diagram with no states.
import { cursorTipOn } from "../sidebar/ui-kit";
import { type MermaidResult, MAX_SRC, done, keyOf, mermaidBlock, pageIsDark, showingSource, undrawable } from "./mermaid-block";

/** How long a closed fence may take before the placeholder shows: a quick drawing should not flash one. */
export const PLACEHOLDER_MS = 150;
/** How long the frame may take before the diagram counts as failed. */
const RENDER_TIMEOUT_MS = 10_000;
/** How many finished drawings are kept: the newest, by when they were asked for. */
const CACHE_MAX = 200;

// state: cache (drawings in flight, so two renderings of one reply ask once)
const inFlight = new Map<string, Promise<MermaidResult>>();

// --- the frame ---

let frame: HTMLIFrameElement | null = null;   // state: plumbing (the one sandboxed frame; made again if it fails)
let ready: Promise<HTMLIFrameElement> | null = null;   // state: plumbing
let seq = 0;   // state: plumbing (request ids to the frame)
let frameUrl: string | null = null;   // state: plumbing (where the frame loads from, when not beside the document)
// ONE DRAWING AT A TIME: N fences in a reply are N Mermaid parses either way, and in sequence they cost one parse's
// memory and leave the page responsive between them. Each asks the frame only once the one before has settled.
let sending: Promise<unknown> = Promise.resolve();   // state: plumbing (the drawing before this one)
const waiting = new Map<number, (r: MermaidResult) => void>();   // state: plumbing (requests the frame has not answered)

/** The hidden sandboxed frame, created on the first diagram. Off screen rather than `display: none`, since Mermaid
 *  measures its text and a frame that is not laid out measures nothing. */
function frameReady(doc: Document): Promise<HTMLIFrameElement> {
    if (ready) return ready;
    ready = new Promise((resolve, reject) => {
        const f = doc.createElement("iframe");
        f.setAttribute("sandbox", "allow-scripts");
        f.setAttribute("aria-hidden", "true");
        f.tabIndex = -1;
        f.className = "mmd-frame";
        f.style.cssText = "position:fixed;left:-10000px;top:0;width:1000px;height:800px;border:0;visibility:hidden";
        f.src = frameUrl ?? new URL("mermaid.html", doc.baseURI).href;
        const fail = setTimeout(() => reject(new Error("the diagram renderer did not start")), RENDER_TIMEOUT_MS);
        doc.defaultView!.addEventListener("message", (e: MessageEvent) => {
            // Only OUR frame's window: a page that can reach this window (the sidebar sits in someone's page) could
            // post a "finished drawing" of its own, which would then be shown as the model's diagram.
            if (!frame || e.source !== frame.contentWindow) return;
            const d = e.data as { mmd?: string; id?: number; svg?: unknown; w?: unknown; h?: unknown; error?: unknown };
            if (d?.mmd === "ready") { clearTimeout(fail); resolve(f); return; }
            if (d?.mmd !== "done" || typeof d.id !== "number") return;
            const settle = waiting.get(d.id);
            if (!settle) return;
            waiting.delete(d.id);
            if (typeof d.svg === "string" && /^<svg[\s>]/.test(d.svg) && typeof d.w === "number" && typeof d.h === "number") {
                const r = { svg: d.svg, w: d.w, h: d.h };
                const why = undrawable(r);
                settle(why ? { error: why } : r);
            } else settle({ error: typeof d.error === "string" ? d.error.slice(0, 200) : "not a diagram Mermaid can draw" });
        });
        frame = f;
        doc.body.append(f);
    });
    ready.catch(() => { ready = null; frame?.remove(); frame = null; });
    return ready;
}

/** Draw `src` in the page's current theme: from the cache, from a drawing already in flight, or by asking the frame. */
export function renderMermaid(src: string, doc: Document = document, dark = pageIsDark()): Promise<MermaidResult> {
    const key = keyOf(src, dark);
    const have = done.get(key);
    if (have) return Promise.resolve(have);
    const flying = inFlight.get(key);
    if (flying) return flying;
    if (src.length > MAX_SRC) return Promise.resolve({ error: `it is longer than ${MAX_SRC.toLocaleString("en")} characters` });
    const turn = sending;
    const p = turn.then(() => frameReady(doc)).then((f) => new Promise<MermaidResult>((resolve) => {
        const id = ++seq;
        const timer = setTimeout(() => { waiting.delete(id); resolve({ error: "drawing it took too long" }); }, RENDER_TIMEOUT_MS);
        waiting.set(id, (r) => { clearTimeout(timer); resolve(r); });
        f.contentWindow!.postMessage({ mmd: "render", id, src, dark }, "*");
    }), (e: Error): MermaidResult => ({ error: e.message })).then((r) => {
        inFlight.delete(key);
        done.set(key, r);
        if (done.size > CACHE_MAX) done.delete(done.keys().next().value!);
        return r;
    });
    sending = p.catch(() => {});
    inFlight.set(key, p);
    return p;
}

// --- upgrading what is on screen ---

/** Draw one pending block, in place. `live` is whether it closed in front of the reader (a streaming reply): only
 *  then does it pass through the placeholder and the fade; otherwise it simply becomes the diagram. */
async function upgrade(el: HTMLElement, live: boolean): Promise<void> {
    const pre = el.querySelector<HTMLElement>("pre.mmd-src");
    const src = pre?.textContent ?? "";
    if (!pre || !src.trim()) return;
    el.dataset.mmd = live ? "drawing" : "quiet";
    const doc = el.ownerDocument;
    const slow = live ? setTimeout(() => { if (el.dataset.mmd === "drawing") el.dataset.mmdSlow = ""; }, PLACEHOLDER_MS) : undefined;
    const r = await renderMermaid(src, doc);
    clearTimeout(slow);
    if (!el.isConnected) return;   // replaced meanwhile: the next rendering comes out of the cache
    const from = el.getBoundingClientRect().height;
    el.outerHTML = mermaidBlock(src);
    if (!live || "error" in r) return;
    // The new element: grow from the code's height to the diagram's, and fade the diagram in.
    const next = findNear(doc, src);
    if (!next) return;
    const to = next.getBoundingClientRect().height;
    next.dataset.mmdArrive = "";
    next.style.height = `${from}px`;
    void next.offsetHeight;
    next.style.height = `${to}px`;
    const end = () => { next.style.height = ""; delete next.dataset.mmdArrive; };
    next.addEventListener("transitionend", end, { once: true });
    setTimeout(end, 600);
}

/** The finished block for `src` just written in place of the pending one. */
function findNear(doc: Document, src: string): HTMLElement | null {
    for (const el of doc.querySelectorAll<HTMLElement>('.mmd[data-mmd="done"]')) if (el.querySelector("pre.mmd-src")?.textContent === src) return el;
    return null;
}

function scan(root: ParentNode): void {
    for (const el of root.querySelectorAll<HTMLElement>('.mmd[data-mmd="pending"]')) void upgrade(el, !!el.closest(".md-live"));
}

/** Switch a finished block between its diagram and its source, or copy the source. */
function act(btn: HTMLElement): void {
    const block = btn.closest<HTMLElement>(".mmd");
    const src = block?.querySelector("pre.mmd-src")?.textContent;
    if (!block || src == null) return;
    if (btn.dataset.mmdAct === "copy") {
        void navigator.clipboard?.writeText(src).then(() => { btn.textContent = "copied"; setTimeout(() => { btn.textContent = "copy"; }, 1200); }, () => {});
        return;
    }
    if (showingSource.has(src)) showingSource.delete(src); else showingSource.add(src);
    block.outerHTML = mermaidBlock(src);
}

/**
 * Turn every ```mermaid fence rendered into `doc`, now and from now on, into its diagram, and redraw them when the
 * theme changes. Once per document; a second call does nothing.
 * @param doc the document
 * @param url where the frame loads from, when not `mermaid.html` beside the document: the overlay's sidebar, an
 *   extension frame inside a web page, must load it by its per-session URL (`use_dynamic_url`), since the extension's
 *   own id no longer loads a web-accessible file there
 */
export function installMermaid(doc: Document, url?: string): void {
    const w = doc.defaultView as (Window & { __mlMermaid?: true }) | null;
    if (!w || w.__mlMermaid) return;
    if (!doc.body) { doc.addEventListener("DOMContentLoaded", () => installMermaid(doc, url), { once: true }); return; }
    w.__mlMermaid = true;
    frameUrl = url ?? null;
    scan(doc);
    new MutationObserver((records) => {
        for (const r of records) for (const n of r.addedNodes) if (n.nodeType === 1) {
            const el = n as HTMLElement;
            if (el.matches('.mmd[data-mmd="pending"]')) void upgrade(el, !!el.closest(".md-live"));
            else scan(el);
        }
    }).observe(doc.body, { childList: true, subtree: true });
    // The theme moves: every drawn block is drawn again in the new one, quietly.
    new MutationObserver(() => {
        for (const el of doc.querySelectorAll<HTMLElement>('.mmd[data-mmd="done"], .mmd[data-mmd="error"]')) {
            const src = el.querySelector("pre.mmd-src")?.textContent;
            if (src) void upgrade(el, false);
        }
    }).observe(doc.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    doc.addEventListener("click", (e) => {
        const btn = (e.target as Element | null)?.closest?.<HTMLElement>(".mmd-btn");
        if (btn) { e.preventDefault(); act(btn); }
    });
    // The panel's tooltip, not the browser's `title` (AGENTS.md): the buttons are in injected HTML, so it is delegated.
    let tipOn: HTMLElement | null = null;
    doc.addEventListener("pointermove", (e) => {
        const btn = (e.target as Element | null)?.closest?.<HTMLElement>(".mmd-btn") ?? null;
        if (btn !== tipOn && tipOn) cursorTipOn("").onPointerLeave();
        tipOn = btn;
        if (btn) cursorTipOn(btn.getAttribute("aria-label") ?? "").onPointerMove({ currentTarget: btn, clientX: e.clientX, clientY: e.clientY } as unknown as PointerEvent);
    });
}
