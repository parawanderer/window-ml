// Shared leaf UI primitives for the debug sidebar — extracted from app.tsx so the
// render-panel / answer-render clusters (and the app shell) can share one source.
// These carry no run/session logic: syntax-highlighted code, copy-to-clipboard,
// the custom context menu, the page-highlight bridge, approval posting, and the
// small click-to-copy chips (Hash / CopyBtn / Stamp / TagBadge / SheetChip / …).
import type { ComponentChildren } from "preact";
import { useState, useEffect, useMemo } from "preact/hooks";
import { signal } from "@preact/signals";
import type { AnswerMedia } from "../contract";
import type { Status, AgentStep } from "./store";
import { codeLineNumbers } from "./store";
import { beautifyJs, highlight, htmlLines, shortStamp, fullStamp, pretty, truncate, mdInline } from "./format";
import { lineMapBetween } from "../line-map";
import { useTipPlacement } from "./use-tip";
import { IconCopy, IconCheck, IconSheet, IconChevron } from "./icons";

export const DOT_TIP: Record<Status, string> = {
    pending: "In flight — waiting for the model to respond.",
    ok: "Completed successfully.",
    err: "Failed — see the error in the turn.",
};
/** A status DOT — pending / ok / err — with the tooltip that says which. The one status indicator: a
 *  session row, a step header and a model's residency all use it, so the three cannot drift into three
 *  colours meaning the same thing. */
export const Dot = ({ status }: { status: Status }) => (
    <span class="tt">
        <span class={`dot ${status}`} />
        <span class="tt-pop left" role="tooltip">{DOT_TIP[status]}</span>
    </span>
);

// Syntax-highlighted code block (highlight() returns safe token HTML). `format`
// beautifies JS first (exec source). Reads the codeLineNumbers signal so the
// gutter toggle re-renders live; wrap vs. scroll is a global CSS attribute.
/** A span of `text` that was substituted for something the author did not write, with the original for a
 *  tooltip — `exec`'s expanded pointer macros. */
export interface CodeMark { start: number; end: number; from: string }

/**
 * Highlight `text`, wrapping each marked range so a reader can see WHICH part is not what was typed and
 * hover it for the original.
 *
 * Segment-by-segment rather than post-processing the highlighted HTML, because highlighting rewrites the
 * string and the offsets no longer index it. That is safe here for a specific reason: the macro never
 * expands inside a string or a comment, so every boundary falls at a token boundary and no segment can cut
 * a literal in half.
 *
 * Beautification is skipped when there are marks, for the same offset reason — reformatting moves
 * everything after the first change. Losing it costs a little on code a model wrote (usually already
 * formatted); guessing at shifted offsets would underline the wrong text, which is worse than plain.
 */
function markedHtml(text: string, lang: string | undefined, marks: CodeMark[]): string {
    const ordered = [...marks].filter(m => m.start >= 0 && m.end <= text.length && m.end > m.start).sort((a, b) => a.start - b.start);
    let out = "", at = 0;
    for (const m of ordered) {
        if (m.start < at) continue;   // overlapping marks: keep the first, never emit crossed spans
        out += highlight(text.slice(at, m.start), lang);
        // The panel's own tooltip, not the browser's `title`: a native tooltip cannot render the pointer as
        // code, waits half a second before appearing, and looks like an OS artefact rather than part of the
        // panel. `.tt-pop` is display:none and read into the floating layer on hover (see .tt-layer), so its
        // prose is never selected along with the code it annotates.
        out += `<span class="tt tt-code expanded">`
            // `wrap`, because a pointer is exactly the unbreakable long token the nowrap default clips: a
            // generated remote tool name reaches 40 characters, and the end of it is the part you hovered for.
            + `<span class="tt-pop wrap">Expanded from <code>${escapeAttr(m.from)}</code></span>`
            + `${highlight(text.slice(m.start, m.end), lang)}</span>`;
        at = m.end;
    }
    return out + highlight(text.slice(at), lang);
}

const escapeAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The text a `Code` block will actually DRAW. Exported because the annotator has to number the same
 *  lines the reader sees: JS is beautified inside the component, so a caller reasoning about line numbers
 *  cannot get them from the text it passed in. */
export const displaySource = (text: string, lang?: string, format?: boolean, marks?: CodeMark[]): string =>
    format && !marks?.length && (lang === "javascript" || lang === "js") ? beautifyJs(text) : text;

/** A CODE BLOCK — syntax-highlighted, optionally line-numbered, and the one place a line can be MARKED
 *  (a failure), ANNOTATED (a margin note from `explain`), or pointed at from elsewhere (`lineIds` makes
 *  each row addressable). Beautifies JS itself and hands back the line MAP through `onMap`, because
 *  reformatting moves line numbers and a stack trace's whole content is a line number. */
export const Code = ({ text, lang, format, marks, lineIds, markLine, markTitle, notes, onMap }: { text: string; lang?: string; format?: boolean; marks?: CodeMark[]; lineIds?: string; markLine?: number | null; markTitle?: string; notes?: Map<number, string>; onMap?: (map: number[] | null) => void }) => {
    const src = displaySource(text, lang, format, marks);
    // BEAUTIFYING MOVES LINE NUMBERS, and js-beautify hands back no map — so one is derived from the two
    // texts (see line-map.ts). Without it a JS stack trace read against this block names a line that has
    // since moved, which is the same silent disagreement the Python side had.
    const lineMap = useMemo(() => (src === text ? null : lineMapBetween(text, src)), [text, src]);
    useEffect(() => { onMap?.(lineMap); }, [lineMap, onMap]);
    // An expansion is a single call and never contains a newline, so a marked span cannot straddle one —
    // which is what lets the line-number path below split this HTML as it always has.
    const html = marks?.length ? markedHtml(src, lang, marks) : highlight(src, lang);
    // The per-line form is also used when a line is being POINTED AT: you cannot mark a line in a block that
    // has no lines, and a traceback saying "line 3" with nothing numbered leaves the reader counting. So a
    // `markLine` turns the gutter on for that block regardless of the preference — the preference is about
    // wanting numbers in general, not about wanting them withheld when something is referring to one.
    // Notes turn the gutter on for the same reason a `markLine` does: a margin note is keyed to a line,
    // and a line the reader cannot number is one they have to count to.
    if (!codeLineNumbers.value && markLine == null && !notes?.size)
        return <pre class="code"><code class="hljs" dangerouslySetInnerHTML={{ __html: html }} /></pre>;
    return (
        <pre class="code numbered"><code class="hljs">
            {htmlLines(html).map((ln, i) => [
                // `lineIds` makes each row addressable, so a traceback elsewhere on the page can point AT a
                // line rather than at the block containing it.
                // The marked line carries the panel's own tooltip rather than a native `title`: the native
                // one waits about a second, which on a mark you are hovering to find out what it MEANS is
                // long enough to have given up. `.tt` makes the row the trigger; the pop is read into the
                // shared floating layer.
                <span class={`cline${markLine === i + 1 ? " cline-fail" : ""}`} key={i}
                    {...(markLine === i + 1 && markTitle ? cursorTipOn(markTitle) : {})}
                    {...(lineIds ? { "data-line": String(i + 1) } : {})}>
                    <span class="lno">{i + 1}</span>
                    <span class="lcode" dangerouslySetInnerHTML={{ __html: ln || " " }} />
                    {/* The marked line's explanation FOLLOWS THE CURSOR (see cursorTip): a code line is as
                        wide as the block, so an anchored tip can sit half a panel from the pointer that
                        summoned it. Kept in the DOM as well so it is readable without a pointer at all. */}
                    {markLine === i + 1 && markTitle ? <span class="tt-pop cline-why" role="tooltip">{markTitle}</span> : null}
                </span>,
                /* A model-written gloss, drawn UNDER its line rather than to the right of it: the panel is
                   often 400px wide and a true right margin would sit off the end of a horizontally
                   scrolled block. It is a sibling of the line, never part of it — the source keeps its
                   own numbering and the line map is untouched. */
                notes?.get(i + 1) ? <span class="lnote" key={`n${i}`}><span class="lnote-mark" aria-hidden="true">↳</span><span class="lnote-txt" dangerouslySetInnerHTML={{ __html: mdInline(notes.get(i + 1)!) }} /></span> : null,
            ])}
        </code></pre>
    );
};

/** THE POINTER CHIP — the one shell every `@tool:` reference is drawn in: the copy chip under a step, the
 *  "revises" pill on a retry's diff, and whatever names a pointer next. It was a CSS copy for a while and
 *  that is the drift this exists to stop: a pointer must not read as a different KIND of thing depending on
 *  which surface names it.
 *
 *  The shell only — the chip's CHROME and its tooltip. What it DOES differs (one copies, one navigates), so
 *  the behaviour stays with the caller. `children` is the label: a pointer's own id, or a friendlier name
 *  the model gave it. */
export function PointerChip({ label, tip, onClick, cls, trailing }:
    { label: ComponentChildren; tip: ComponentChildren; onClick: (e: MouseEvent) => void; cls?: string; trailing?: ComponentChildren }) {
    return (
        <button class={`tt tok-chip${cls ? ` ${cls}` : ""}`} onClick={onClick}>
            <code>{label}</code>
            {trailing}
            <span class="tt-pop wrap left" role="tooltip">{tip}</span>
        </button>
    );
}

// Copy to clipboard. Falls back to execCommand when the async Clipboard API is
// unavailable (http pages) OR blocked — a host page's Permissions-Policy can
// withhold clipboard-write from our iframe even though the API exists, so we
// also catch a rejection, not just an absent API.
export function execCopy(text: string): Promise<void> {
    return new Promise((resolve, reject) => {
        try {
            const ta = document.createElement("textarea");
            ta.value = text; ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
            document.body.appendChild(ta); ta.focus(); ta.select();
            const ok = document.execCommand("copy"); ta.remove();
            ok ? resolve() : reject(new Error("execCommand copy failed"));
        } catch (e) { reject(e); }
    });
}
/** Copy to the clipboard, tolerantly — see execCopy for why a rejection matters as much as a missing API. */
export function copyText(text: string): Promise<void> {
    if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text).catch(() => execCopy(text));
    return execCopy(text);
}

// "copied!" feedback that reverts after a moment.
export function useCopy(): { copied: boolean; copy: (text: string) => void } {
    const [copied, setCopied] = useState(false);
    const copy = (text: string) =>
        copyText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }).catch(() => {});
    return { copied, copy };
}

// A lightweight custom context menu. A web-page/iframe can't invoke the native OS menu with custom
// items (that's privileged DevTools-only), so we render our own popup at the cursor. Rendered once in
// App; opened via openCtxMenu(e, items); dismissed on outside-click / Esc / blur / item-click.
export interface CtxItem { label: string; run: () => void; }
/** The open right-click menu, or null. One per surface; `ContextMenu` draws it. */
export const ctxMenu = signal<{ x: number; y: number; items: CtxItem[] } | null>(null);
/** Open the panel's own right-click menu at the pointer, suppressing the browser's — the useful actions
 *  here are ours (copy a selector, copy a pointer) and the native menu offers none of them. */
export const openCtxMenu = (e: MouseEvent, items: CtxItem[]): void => { e.preventDefault(); ctxMenu.value = { x: e.clientX, y: e.clientY, items }; };
/** The panel's right-click MENU, mounted once per surface and driven by the `ctxMenu` signal. A menu
 *  rather than the browser's: the useful actions here are ours (copy a `document.querySelector(…)` for an
 *  element, copy a pointer) and the native one offers none of them. */
export function ContextMenu() {
    const m = ctxMenu.value;
    useEffect(() => {
        if (!m) return;
        const close = () => (ctxMenu.value = null);
        const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
        window.addEventListener("keydown", onKey);
        window.addEventListener("blur", close);
        return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("blur", close); };
    }, [m]);
    if (!m) return null;
    const left = Math.min(m.x, window.innerWidth - 240);           // keep it on-screen (it's small)
    const top = Math.min(m.y, window.innerHeight - (m.items.length * 30 + 14));
    return (
        <div class="ctx-backdrop" onPointerDown={() => (ctxMenu.value = null)} onContextMenu={e => { e.preventDefault(); ctxMenu.value = null; }}>
            <div class="ctx-menu" style={`left:${left}px;top:${top}px`} onPointerDown={e => e.stopPropagation()}>
                {m.items.map((it, i) => <button class="ctx-item" key={i} onClick={() => { it.run(); ctxMenu.value = null; }}>{it.label}</button>)}
            </div>
        </div>
    );
}

// A debug image that opens full-window on click. The lightbox lives in the shell
// (parent), not this iframe, so it fills the whole browser rather than the
// ~sidebar-width frame — post the src up and the shell renders the overlay.
export const openLightbox = (src: string) => window.parent.postMessage({ __mlLightbox: src }, "*");

// Ask the shell to draw / clear a DevTools-style highlight over a page element (on hover of a rendered
// element reference). The shell owns the page DOM (a content script), so it resolves the selector +
// rect and outlines it WITHOUT touching the element. Overlay-surface only — a no-op in the devtools
// panel, whose parent can't reach the page.
export const highlightEl = (selector: string) => window.parent.postMessage({ __mlHighlight: { selector } }, "*");
// A canvas @pt/@box token — the shell resolves it (via injected) to a point marker / box outline.
export const highlightToken = (token: string) => window.parent.postMessage({ __mlHighlight: { token } }, "*");
/** Stop outlining anything on the page — the pointer left the thing that was pointing at it. */
export const clearHighlight = () => window.parent.postMessage({ __mlHighlight: null }, "*");
// The APPROVAL-card highlight: a pulsing GREEN spotlight (kind "approve"), distinct from the blue hover
// box, so the pending target is unmistakable. The shell replies with the target's on-page position
// (e.g. "bottom-left") → highlightPos, which the card shows so you know where to look.
export const highlightApprove = (ref: { selector?: string; token?: string }) => window.parent.postMessage({ __mlHighlight: { ...ref, kind: "approve" } }, "*");
/** Where the currently highlighted element sits on screen ("bottom-left"), so an approval card can say
 *  WHERE the thing it is about is without you hunting for the outline. */
export const highlightPos = signal<string>("");
// Hover handlers for a locate `picked` string, which is EITHER an @pt/@box token OR "… → selector" —
// so the same overlay works in both point mode and element mode.
export const pickedHover = (picked?: string): { onPointerEnter?: () => void; onPointerLeave?: () => void } => {
    if (!picked) return {};
    const tok = picked.match(/@(?:pt|box):[0-9a-f]+/)?.[0];
    const sel = tok ? "" : (picked.split("→").pop() || "").trim();
    if (!tok && !sel) return {};
    return { onPointerEnter: () => (tok ? highlightToken(tok) : highlightEl(sel)), onPointerLeave: clearHighlight };
};
// Hover handlers for any string that MENTIONS an @pt/@box token (e.g. a look image's label
// `element "@pt:…"`) — hover → outline it on the page. Only fires when a token is present.
export const tokenHover = (s?: string): { onPointerEnter?: () => void; onPointerLeave?: () => void } => {
    const tok = s?.match(/@(?:pt|box):[0-9a-f]+/)?.[0];
    return tok ? { onPointerEnter: () => highlightToken(tok), onPointerLeave: clearHighlight } : {};
};

// Design A: the sidebar's approve/deny for a background-hosted run's pending gate. We post it to the
// SHELL (our parent), which — because it can prove the message came from this real extension iframe
// (e.source === frame.contentWindow, unforgeable by the page) — forwards it to the background as
// SET_APPROVAL. That authentication is the whole point: the decision is made HERE and the page can't
// spoof it. Keyed by the run hash + the step's seq.
export const sendApproval = (hash: string, seq: number, decision: boolean, persist = false) =>
    window.parent.postMessage({ __mlSidebarApp: "approval", hash, seq, decision, persist }, "*");

// The "https://host/*" host-permission pattern a step needs granted before it can run: a fetch_url's URL
// (the background SW fetch needs the host) OR a navigate's destination (a cross-origin nav must RE-INJECT the
// content script on the new origin, which "On click" site access withholds — without the grant the run can't
// re-adopt there). "On click" withholds <all_urls> for third-party hosts, so a first-time fetch/nav to a new
// origin would fail — but this iframe is extension-origin, so approving CAN grant that host in the same
// gesture. Null for any other tool or an unparseable/non-http URL.
export function grantHostPattern(st: AgentStep): string | null {
    if (st.tool !== "fetch_url" && st.tool !== "navigate") return null;
    const url = typeof st.arguments?.url === "string" ? st.arguments.url
        : (st.renderIn && st.renderIn.type === "action" ? st.renderIn.target : "");
    try { const u = new URL(String(url)); return (u.protocol === "http:" || u.protocol === "https:") ? `${u.protocol}//${u.host}/*` : null; }
    catch { return null; }
}
// Approve/deny a gate. For a fetch_url APPROVAL, first request host access to its origin IN THE SAME user
// gesture (so the SW fetch can reach it), then post the decision. Idempotent — Chrome no-ops when the host is
// already granted (no prompt), so it's safe to always try. Degrades gracefully: the approval is sent whether
// or not the grant succeeds (a denied host just yields the tool's actionable "grant On all sites" error).
export async function decideGate(st: AgentStep, hash: string, seq: number, ok: boolean, persist: boolean): Promise<void> {
    if (ok) {
        const pat = grantHostPattern(st);
        if (pat && typeof chrome !== "undefined" && chrome.permissions?.request) {
            try { await chrome.permissions.request({ origins: [pat] }); } catch { /* older Chrome / user dismissed → fetch returns the actionable error */ }
        }
    }
    sendApproval(hash, seq, ok, persist);
}
// Steps you've already approved/denied this session, keyed `hash:seq`. A step's own
// awaitingApproval flag only clears when the DONE event lands — AFTER the tool runs — so without
// this the run footer keeps showing "waiting for your approval" during that gap. Recording the
// decision on click lets PendingNote drop the step from "blocked" immediately. (ToolStep keeps its
// own local `decided` for its buttons; this is the run-level mirror.) Keys are unique per run
// (random hash) + monotonic seq, so it never collides; growth is one entry per approval.
/** THE DISCLOSURE — one fold, everywhere something opens. There were three, written three ways, and all
 *  three were a pill button that injected a box into the layout on click: that reads as content appearing
 *  rather than a section opening, and shoves whatever is below it. Slides. The panel had three of these written three different ways, all of them a pill
 *  button that injected a box into the layout on click — which reads as something appearing rather than as a
 *  section opening, gives no hint that the thing can be closed again, and jumps whatever is below it.
 *
 *  One component so the next one is free, and so all of them agree about what a chevron means. The slide is
 *  `grid-template-rows: 0fr → 1fr`: a height nobody knows in advance cannot be animated any other way, since
 *  `height: auto` does not transition at all.
 *
 *  `onOpen` is for a section whose content has to be FETCHED (the server-tool list) — it fires on the
 *  opening edge only, so re-opening does not re-request, and the caller decides whether a refresh is offered
 *  separately. `note` is a short status that rides on the header, where a count or a "loading…" belongs. */
export function Disclosure({ label, note, open: controlled, onOpen, onToggle, defaultOpen = false, children }: {
    label: ComponentChildren;
    note?: ComponentChildren;
    /** Controlled open state. With `onToggle` the caller owns it entirely (the lane's is persisted). */
    open?: boolean;
    /** Fires on the OPENING edge only — for a section whose content has to be fetched. */
    onOpen?: () => void;
    /** Fires on every change, with the new state. Present ⇒ the caller owns `open` in both directions. */
    onToggle?: (open: boolean) => void;
    defaultOpen?: boolean;
    children?: ComponentChildren;
}) {
    const [uncontrolled, setUncontrolled] = useState(defaultOpen);
    const open = controlled ?? uncontrolled;
    const toggle = () => {
        const next = !open;
        if (controlled == null) setUncontrolled(next);
        onToggle?.(next);
        if (next) onOpen?.();
    };
    return (
        <div class={`disc${open ? " open" : ""}`}>
            <button class="disc-head" aria-expanded={open} onClick={toggle}>
                <span class="tri" aria-hidden="true"><IconChevron /></span>
                <span class="disc-label">{label}</span>
                {note ? <span class="disc-note">{note}</span> : null}
            </button>
            {/* The wrapper is ALWAYS rendered — there has to be something to slide, and a body that only
                exists once open can only appear. Its content is still mounted while closed, so a fetch that
                landed stays landed and reopening is instant. */}
            <div class="disc-body" aria-hidden={!open}><div>{children}</div></div>
        </div>
    );
}

/** A tooltip that FOLLOWS THE CURSOR, for a trigger that is wide. The static `.tt`/`.tt-pop` layer anchors to
 *  its trigger, which is right for an icon button and wrong for a line of code: the anchor can be half a
 *  panel away from the pointer that summoned it. One signal and one layer, because two tips on screen at once
 *  is the failure mode every cursor tip in this panel already guards against.
 *
 *  Not the native `title` for the same reason nothing else here is: it waits about a second, which on
 *  something you are hovering to decide what it MEANS is long enough to have given up. */
/** The one floating tip. `text` is MARKDOWN (escaped, rendered inline); `node` is authored JSX. Exactly
 *  one of them is set — see cursorTipOn, which picks by the type of what it was given. */
export const cursorTip = signal<{ x: number; y: number; text?: string; node?: ComponentChildren } | null>(null);

/** Handlers for a trigger. Spread onto the element that should show `text` while the pointer is over it. */
/** Tooltip PROSE that came from data — a JSON Schema's `description`, a tool result, a model's own text.
 *  Rendered as markdown for the same reason the cursor tip renders a string that way: our parameter docs are
 *  full of backticked identifiers (`@tool:abc1234`, `pd.read_csv`), and showing the backticks is the tell
 *  that something is being printed rather than rendered. It escapes, so text we did not author cannot
 *  inject markup. Our OWN tooltips stay JSX children and need none of this. */
export const TipText = ({ md }: { md: string }) => <span dangerouslySetInnerHTML={{ __html: mdInline(md) }} />;

/** Attach the panel's cursor-following tooltip to an element.
 *
 *  TWO RENDER MODES, told apart by the TYPE of what you pass, so there is one function and no way to pick
 *  the wrong one:
 *   · a STRING is markdown TEXT — escaped, then rendered inline (`code`, *emphasis*, $math$). This is the
 *     default because it is where content from OUTSIDE comes in: a JSON Schema's `description`, a tool
 *     result, a model's own prose. Treating a string as markup would make that an injection.
 *   · anything else is JSX — our own authored tooltip, with whatever structure it needs. Children, never an
 *     HTML string, so there is no way to hand this something unescaped by accident. */
export const cursorTipOn = (content: string | ComponentChildren) => ({
    onPointerMove: (e: PointerEvent) => {
        cursorTip.value = typeof content === "string"
            ? { x: e.clientX, y: e.clientY, text: content }
            : { x: e.clientX, y: e.clientY, node: content };
    },
    onPointerLeave: () => { cursorTip.value = null; },
});

/** The single layer. Mounted once per surface, beside the context menu. */
export function CursorTipLayer() {
    const t = cursorTip.value;
    const { ref, style } = useTipPlacement(t ? { x: t.x, y: t.y, w: typeof window !== "undefined" ? window.innerWidth : 1e4 } : null);
    if (!t) return null;
    // A NODE renders as itself; a STRING goes through the inline markdown renderer — a tip explaining code
    // says `df['total']` and *why*, and a tip is exactly where backticks-as-literal-backticks look like a
    // bug. Same renderer the margin notes use, so the two cannot drift, and it escapes, so a tip built from
    // a tool result or a JSON Schema's description cannot inject markup.
    if (t.node !== undefined) return <div class="rc-tip cursor-tip" role="tooltip" ref={ref} style={style}>{t.node}</div>;
    return <div class="rc-tip cursor-tip" role="tooltip" ref={ref} style={style}
        dangerouslySetInnerHTML={{ __html: mdInline(t.text ?? "") }} />;
}

/** Gates you have already answered, by step key — so a decided step stays decided across the re-render
 *  the decision itself causes. */
export const decidedSteps = new Set<string>();
/** One step's identity across the panel: `<run hash>:<seq>`. `step` is the loop's counter and several
 *  records share it; `seq` addresses one row. */
export const stepKey = (hash: string, seq: number) => `${hash}:${seq}`;
// An IMAGE that opens in the lightbox — every screenshot the panel draws (a `look`, a locate's marked crop,
// a python figure) goes through this, so click-to-enlarge means the same thing everywhere.
// No tooltip here on purpose: `cursor: zoom-in` is the standard affordance for
// "click to enlarge", and a pop anchored under a full-width screenshot (locate
// renders stack several) would land far from the pointer and just add noise.
// stopPropagation so clicking the IMAGE only opens the lightbox — it must NOT also fire an ancestor's click
// (a citation's `.tok-ref` jumps to its source step; without this the DevTools answer both zoomed AND scrolled
// away to the producing step). Clicking the container's padding/background still reaches that ancestor handler.
export const ClickableImg = ({ src, alt }: { src: string; alt?: string }) =>
    <img class="zoomable" src={src} alt={alt} onClick={(e) => { e.stopPropagation(); openLightbox(src); }} />;

// The HUD completion card's answer-media gallery — the user-facing deliverable. Each item HOVER-HIGHLIGHTS
// the live element on the page (the same debug highlighter the sidebar uses), via its captured `selector`.
// `mode` "inline" shows the picture (an <img>'s full-res src, or an element crop); "highlight" is a compact
// chip that points at the element (for a control/region where the visual isn't the payoff). HUD-only — the
// debug detail (AgentRunView) never renders this.
export function AnswerMediaGallery({ media }: { media: AnswerMedia[] }) {
    return (
        <div class="card-answer-media">
            {media.map((m, i) => {
                const hover = m.selector ? { onPointerEnter: () => highlightEl(m.selector!), onPointerLeave: clearHighlight } : {};
                if (m.mode === "highlight" || !m.image) {
                    return (
                        <button key={i} class="am-chip" title={m.selector} {...hover}>
                            {m.image ? <img class="am-thumb" src={m.image} alt={m.label || "element"} /> : <span class="am-chip-ic" aria-hidden="true">⌖</span>}
                            <span class="am-chip-text">{m.label || "element"}<span class="am-chip-hint">hover to locate on page</span></span>
                        </button>
                    );
                }
                return (
                    <div key={i} class={`am-inline${m.selector ? " am-hoverable" : ""}`} {...hover}>
                        <ClickableImg src={m.image} alt={m.label || "answer element"} />
                    </div>
                );
            })}
        </div>
    );
}

// A short hash rendered as click-to-copy, with a tooltip. `stop` swallows the
// click so copying a hash inside a session row doesn't also open the session.
export function Hash({ hash, stop }: { hash: string; stop?: boolean }) {
    const { copied, copy } = useCopy();
    return (
        <span class="tt">
            <code class="hash copyable" onClick={(e) => { if (stop) e.stopPropagation(); copy(hash); }}>{hash}</code>
            <span class="tt-pop" role="tooltip">{copied ? "copied!" : "click to copy"}</span>
        </span>
    );
}

// A small copy-to-clipboard icon button with a tooltip.
export function CopyBtn({ text, tip = "copy" }: { text: string; tip?: string }) {
    const { copied, copy } = useCopy();
    return (
        <span class="tt">
            <button class="icon-btn" aria-label={tip} onClick={(e) => { e.stopPropagation(); copy(text); }}>
                {copied ? <IconCheck /> : <IconCopy />}
            </button>
            <span class="tt-pop" role="tooltip">{copied ? "copied!" : tip}</span>
        </span>
    );
}

// Session-type tag with a tooltip explaining what the type means.
export const TAG_TIP: Record<string, string> = {
    session: "Session-local — lives in this tab only, gone on reload.",
    saved: "Saved — persisted to storage; resumable by hash across reloads and tabs.",
};
/** A session's KIND badge — `session` / `saved` — with the tooltip explaining what that means for its
 *  lifetime. */
export const TagBadge = ({ tag }: { tag: string }) => (
    <span class="tt">
        <span class={`tag ${tag}`}>{tag}</span>
        <span class="tt-pop wide" role="tooltip">{TAG_TIP[tag] || tag}</span>
    </span>
);

// Timestamp: compact label, exact full stamp on hover. `snap` picks which way the
// tooltip opens — "left" (default, for right-edge placements like the chat view)
// or "right" (for left-edge placements like the list row, so it doesn't clip).
export const Stamp = ({ ts, snap = "left" }: { ts?: number; snap?: "left" | "right" }) => (
    <span class="tt">
        <span class="time">{shortStamp(ts)}</span>
        <span class={`tt-pop${snap === "right" ? " left" : ""}`} role="tooltip">{fullStamp(ts)}</span>
    </span>
);

// The model that produced a reply, as a click-to-copy chip (handy for debugging).
export function CopyModel({ model }: { model: string }) {
    const { copied, copy } = useCopy();
    return (
        <span class="tt">
            <button class="model-name" onClick={(e) => { e.stopPropagation(); copy(model); }}>{model}</button>
            <span class="tt-pop" role="tooltip">{copied ? "copied!" : "copy model name"}</span>
        </span>
    );
}

// Grey one-line preview for a collapsed In/Out: minified args, or newline-collapsed output.
export const inlineJson = (v: unknown): string => truncate(pretty(v).replace(/\s+/g, " "), 64);
/** Flatten text to ONE line for a collapsed preview — newlines collapsed, truncated. */
export const inlineText = (s: string): string => truncate(s.replace(/\s+/g, " ").trim(), 72);

const sheetTitleCache = new Map<string, string | null>();   // id → title (fetched once per session)
/** A Google Sheet reference as a friendly CHIP — the spreadsheet's title rather than its id, so an
 *  approval card says WHICH sheet is about to be read. */
export function SheetChip({ id, label }: { id: string; label?: string }) {
    // With a label (post-run: the run already fetched the sheet), use it. Without (the pre-run approval
    // chip), lazily HEAD-fetch just the TITLE so the USER sees which sheet — the model never gets it.
    const [fetched, setFetched] = useState<string | null | undefined>(() => label ? undefined : sheetTitleCache.get(id));
    useEffect(() => {
        if (label || sheetTitleCache.has(id)) return;
        try {
            chrome.runtime.sendMessage({ type: "FETCH_SHEET_TITLE", payload: { id } }, (resp: any) => {
                const name = (resp && resp.data) || null;
                sheetTitleCache.set(id, name);
                setFetched(name);
            });
        } catch { sheetTitleCache.set(id, null); }
    }, [id, label]);
    const name = label || fetched || "Google Sheet";
    return (
        <a class="tt sheet-chip" href={`https://docs.google.com/spreadsheets/d/${id}/edit`} target="_blank" rel="noopener" onClick={e => e.stopPropagation()}>
            <IconSheet /><span class="sheet-chip-name">{name}</span>
            <span class="tt-pop wrap left" role="tooltip">Google Sheet · {id}</span>
        </a>
    );
}
