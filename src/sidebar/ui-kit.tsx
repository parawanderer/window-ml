// Shared leaf UI primitives for the debug sidebar — extracted from app.tsx so the
// render-panel / answer-render clusters (and the app shell) can share one source.
// These carry no run/session logic: syntax-highlighted code, copy-to-clipboard,
// the custom context menu, the page-highlight bridge, approval posting, and the
// small click-to-copy chips (Hash / CopyBtn / Stamp / TagBadge / SheetChip / …).
import { useGoneOnScrollOrBlur, underPointer } from "./pointer-gone";
import type { ComponentChildren } from "preact";
import { useState, useEffect } from "preact/hooks";
import { signal } from "@preact/signals";
import type { AnswerMedia } from "../contract/contract-render";
import type { Status, AgentStep } from "./store";
import { codeLineNumbers } from "./store";
import { shortStamp, fullStamp, pretty, truncate, mdInline } from "./format";
import { hhmmss, fmtDur } from "./timestamps";
import { services } from "./services";
import { useTipPlacement } from "./use-tip";
import { watchTrigger } from "./tooltip-layer";
import { IconCopy, IconCheck, IconSheet } from "./icons";
import { useCopy } from "./copy-hash";
import { CodeProps, CodeBlock } from "./code-block";

export const DOT_TIP: Record<Status, string> = {
    pending: "In flight — waiting for the model to respond.",
    ok: "Completed successfully.",
    err: "Failed — see the error in the turn.",
};
/** A status DOT — pending / ok / err — with the tooltip that says which. The one status indicator: a
 *  session row, a step header and a model's residency all use it, so the three cannot drift into three
 *  colours meaning the same thing. `warn` is for a run that stopped short without failing (its step cap, a cancel):
 *  amber, and the sentence given is its tooltip, since "Failed" would be wrong about it.
 *
 *  WHEN AND HOW LONG, under a rule, for a dot that marks an EVENT rather than a state. The status alone answers
 *  "did it work"; standing on a row in a long transcript the next two questions are always "when was this" and
 *  "what did it cost", and both were already on the step — the stamp in the gutter, the duration inside the Out
 *  block — which is to say behind a scroll and behind a disclosure. The dot is the thing the eye is already on.
 *  Same shape as the event lane's tip: the sentence, then a rule, then the figures. A row that is a STATE (a
 *  session's dot, a model's residency) passes neither and is unchanged. */
export const Dot = ({ status, warn, ts, ms }: {
    status: Status; warn?: string;
    /** when this happened, as wall clock */
    ts?: number;
    /** how long it took — the tool's own clock, not the step's (a step's time includes a human at a gate) */
    ms?: number;
}) => (
    <span class="tt">
        <span class={`dot ${warn ? "warn" : status}`} />
        <span class="tt-pop left" role="tooltip">
            {warn ?? DOT_TIP[status]}
            {ts != null || ms != null
                ? <span class="dot-when">{ts != null ? hhmmss(ts) : null}{ts != null && ms != null ? " · " : null}{ms != null ? <b>{fmtDur(ms)}</b> : null}</span>
                : null}
        </span>
    </span>
);

/** A code block as the panel draws one, with the panel's line-number setting and its cursor tooltip on a marked line. */
export const Code = (props: CodeProps) => <CodeBlock {...props} lineNumbers={codeLineNumbers.value} markTip={cursorTipOn} />;

/** THE POINTER CHIP — the one shell every `@tool:` reference is drawn in: the copy chip under a step, the
 *  "revises" pill on a retry's diff, and whatever names a pointer next. It was a CSS copy for a while and
 *  that is the drift this exists to stop: a pointer must not read as a different KIND of thing depending on
 *  which surface names it.
 *
 *  The shell only — the chip's CHROME and its tooltip. What it DOES differs (one copies, one navigates), so
 *  the behaviour stays with the caller. `children` is the label: a pointer's own id, or a friendlier name
 *  the model gave it. */
/**
 * A −/value/+ PILL: step something down or up, with where it currently stands between the two. One rounded
 * control rather than three loose buttons, because the three are one question ("how big?") and a row of bare
 * glyphs beside a number reads as three unrelated things.
 *
 * The VALUE IS A BUTTON when `reset` is given: the one place a reset belongs is on the number it would reset,
 * which costs no row and is where a hand already is. Ends disable themselves at the ladder's limits rather than
 * silently doing nothing — a control that looks live and is not is worse than one that is visibly spent.
 *
 * @param value what it stands at now, already formatted ("115%", "3 of 8")
 * @param onStep called with -1 or 1
 * @param label what the control adjusts, for a screen reader ("Text size")
 * @param reset put it back; omitted, the middle is plain text
 */
export function Stepper({ value, onStep, label, less, more, reset, atLeast, atMost }: {
    value: string; onStep(by: -1 | 1): void; label: string;
    /** the ends' own names, where "Smaller"/"Bigger" is not what this steps */
    less?: string; more?: string;
    reset?(): void;
    /** at the bottom / top of the ladder: the end that cannot move says so */
    atLeast?: boolean; atMost?: boolean;
}) {
    return (
        <span class="ui-stepper" role="group" aria-label={label}>
            <button class="ui-step-end" aria-label={less ?? "Smaller"} disabled={atLeast} onClick={() => onStep(-1)}>−</button>
            {reset
                ? <button class="ui-step-now" aria-label={`${label}: ${value}. Reset`} onClick={reset}>{value}</button>
                : <span class="ui-step-now">{value}</span>}
            <button class="ui-step-end" aria-label={more ?? "Bigger"} disabled={atMost} onClick={() => onStep(1)}>+</button>
        </span>
    );
}

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

// A lightweight custom context menu. A web-page/iframe can't invoke the native OS menu with custom
// items (that's privileged DevTools-only), so we render our own popup at the cursor. Rendered once in
// App; opened via openCtxMenu(e, items); dismissed on outside-click / Esc / blur / item-click.
export interface CtxItem {
    label: string;
    run: () => void;
    /** a glyph before the label, so the menu is read by shape as well as by word */
    icon?: ComponentChildren;
    /** offered but not available yet: shown, dimmed, and not clickable, rather than silently doing nothing */
    disabled?: boolean;
}
/** The open right-click menu, or null. One per surface; `ContextMenu` draws it. */
export const ctxMenu = signal<{ x: number; y: number; items: CtxItem[] } | null>(null);
/** Open the panel's own right-click menu at the pointer, suppressing the browser's — the useful actions
 *  here are ours (copy a selector, copy a pointer) and the native menu offers none of them. */
export const openCtxMenu = (e: MouseEvent, items: CtxItem[], opts?: { mark?: Element | null }): void => {
    e.preventDefault();
    const menu = { x: e.clientX, y: e.clientY, items };
    ctxMenu.value = menu;
    // THE THING THE MENU IS ABOUT, marked while it is open (`.ctx-target`): in a tree of rows, which one you
    // right-clicked is otherwise a guess. Cleared when this menu closes or another replaces it.
    const el = opts?.mark;
    if (!el) return;
    el.classList.add("ctx-target");
    const stop = ctxMenu.subscribe((v) => { if (v !== menu) { el.classList.remove("ctx-target"); stop(); } });
};
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
                {m.items.map((it, i) => (
                    <button class={`ctx-item${it.disabled ? " off" : ""}`} key={i} disabled={it.disabled}
                        onClick={() => { if (!it.disabled) { it.run(); ctxMenu.value = null; } }}>
                        {it.icon ? <span class="ctx-icon" aria-hidden="true">{it.icon}</span> : null}{it.label}
                    </button>
                ))}
            </div>
        </div>
    );
}

// A debug image that opens full-window on click. The lightbox lives in the shell
// (parent), not this iframe, so it fills the whole browser rather than the
// ~sidebar-width frame — post the src up and the shell renders the overlay.
export const openLightbox = (src: string) => services().openLightbox(src);

// Ask the shell to draw / clear a DevTools-style highlight over a page element (on hover of a rendered
// element reference). The shell owns the page DOM (a content script), so it resolves the selector +
// rect and outlines it WITHOUT touching the element. Overlay-surface only — a no-op in the devtools
// panel, whose parent can't reach the page.
export const highlightEl = (selector: string) => services().highlight({ selector });
// A canvas @pt/@box token — the shell resolves it (via injected) to a point marker / box outline.
export const highlightToken = (token: string) => services().highlight({ token });
/** Stop outlining anything on the page — the pointer left the thing that was pointing at it. */
export const clearHighlight = () => services().highlight(null);
// The APPROVAL-card highlight: a pulsing GREEN spotlight (kind "approve"), distinct from the blue hover
// box, so the pending target is unmistakable. The shell replies with the target's on-page position
// (e.g. "bottom-left") → highlightPos, which the card shows so you know where to look.
export const highlightApprove = (ref: { selector?: string; token?: string }) => services().highlight({ ...ref, kind: "approve" });
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
export const sendApproval = (hash: string, seq: number, decision: boolean, persist = false, feedback?: string) =>
    services().answerApproval(hash, seq, decision, persist, feedback);

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
export async function decideGate(st: AgentStep, hash: string, seq: number, ok: boolean, persist: boolean, feedback?: string): Promise<void> {
    if (ok) {
        const pat = grantHostPattern(st);
        const access = services().hostAccess;
        if (pat && access) await access.request(pat);   // dismissed or unsupported → the fetch returns the actionable error
    }
    sendApproval(hash, seq, ok, persist, feedback);
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
 *  `opts.delayMs` is the DELAYED mode: the tip appears only once the pointer has rested that long, and only when
 *  `opts.onlyIf(trigger)` is true at that moment (say, the text is cut off). The default is at once, always.
 *
 *  TWO RENDER MODES, told apart by the TYPE of what you pass, so there is one function and no way to pick
 *  the wrong one:
 *   · a STRING is markdown TEXT — escaped, then rendered inline (`code`, *emphasis*, $math$). This is the
 *     default because it is where content from OUTSIDE comes in: a JSON Schema's `description`, a tool
 *     result, a model's own prose. Treating a string as markup would make that an injection.
 *   · anything else is JSX — our own authored tooltip, with whatever structure it needs. Children, never an
 *     HTML string, so there is no way to hand this something unescaped by accident. */
export const cursorTipOn = (content: string | ComponentChildren, opts?: { delayMs?: number; onlyIf?: (el: Element) => boolean }) => {
    const show = (el: Element | null, x: number, y: number): void => {
        cursorTip.value = typeof content === "string" ? { x, y, text: content } : { x, y, node: content };
        // A trigger that UNMOUNTS under a still pointer raises no pointer-leave, so the tip would stay up over
        // nothing. Watched the same way the anchored layer watches its triggers.
        if (el && el !== tipTrigger) {
            unwatchTip?.();
            tipTrigger = el;
            unwatchTip = watchTrigger(el, () => { if (tipTrigger === el) clearCursorTip(); });
        }
    };
    // THE DELAYED MODE: the tip waits until the pointer has RESTED on the trigger, and appears only if `onlyIf` still
    // holds then (a name that is actually cut off). For a control the pointer crosses on its way somewhere else,
    // where an instant tip would flash up at every pass.
    if (opts?.delayMs) {
        const delay = opts.delayMs;
        return {
            onPointerMove: (e: PointerEvent) => {
                const el = e.currentTarget as Element | null;
                if (tipTrigger === el && cursorTip.value) { show(el, e.clientX, e.clientY); return; }
                pendingAt = { x: e.clientX, y: e.clientY };
                if (pendingEl === el) return;
                clearTimeout(pendingTimer);
                pendingEl = el;
                pendingTimer = setTimeout(() => {
                    if (pendingEl !== el || !el?.isConnected || (opts.onlyIf && !opts.onlyIf(el))) return;
                    show(el, pendingAt.x, pendingAt.y);
                }, delay);
            },
            onPointerLeave: () => { clearTimeout(pendingTimer); pendingEl = null; clearCursorTip(); },
            "data-tip": "",
        };
    }
    return {
        onPointerMove: (e: PointerEvent) => show(e.currentTarget as Element | null, e.clientX, e.clientY),
        onPointerLeave: () => { clearCursorTip(); },
        // THE MARKER THAT MAKES THIS AUDITABLE. Everything here is pointer events, so an explanation reachable only
        // by hovering left no trace in the DOM and nothing could check for one — which is how a tooltip ships as the
        // only route to something on a surface that has no pointer. `data-tip` is what the touch probe looks for
        // (tests/e2e/touch-probe.mjs): on a phone, every one of these must have another way to the same words.
        "data-tip": "",
    };
};
/** The delayed mode's one pending tip: its trigger, its timer, and where the pointer last was over it. */
let pendingEl: Element | null = null;
let pendingTimer: ReturnType<typeof setTimeout> | undefined;
let pendingAt = { x: 0, y: 0 };
let tipTrigger: Element | null = null;
let unwatchTip: (() => void) | null = null;
/** Take the cursor tip down, and stop watching whatever summoned it. */
function clearCursorTip(): void {
    cursorTip.value = null;
    tipTrigger = null;
    unwatchTip?.(); unwatchTip = null;
}

/** The single layer. Mounted once per surface, beside the context menu. */
export function CursorTipLayer() {
    const t = cursorTip.value;
    const { ref, style } = useTipPlacement(t ? { x: t.x, y: t.y, w: typeof window !== "undefined" ? window.innerWidth : 1e4 } : null);
    // Esc dismisses it without moving the pointer, as it does the anchored layer's.
    const up = !!t;
    // After a scroll the tip stays only while its trigger is still what the pointer is on. A tip raised WITHOUT a
    // trigger (TimeChart writes `cursorTip` itself, per pointer position inside one plot) is not judged here: there is
    // nothing to compare, and its owner hides it on its own leave.
    useGoneOnScrollOrBlur(up, clearCursorTip, () => {
        if (!tipTrigger) return true;
        const at = cursorTip.value, el = at && underPointer(at.x, at.y);
        return !!(el && tipTrigger.contains(el));
    });
    useEffect(() => {
        if (!up) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") clearCursorTip(); };
        document.addEventListener("keydown", onKey, true);
        return () => document.removeEventListener("keydown", onKey, true);
    }, [up]);
    if (!t) return null;
    // A NODE renders as itself; a STRING goes through the inline markdown renderer — a tip explaining code
    // says `df['total']` and *why*, and a tip is exactly where backticks-as-literal-backticks look like a
    // bug. Same renderer the margin notes use, so the two cannot drift, and it escapes, so a tip built from
    // a tool result or a JSON Schema's description cannot inject markup.
    if (t.node !== undefined) return <div class="rc-tip cursor-tip" role="tooltip" ref={ref} style={style}>{t.node}</div>;
    return <div class="rc-tip cursor-tip" role="tooltip" ref={ref} style={style}
        dangerouslySetInnerHTML={{ __html: mdInline(t.text ?? "") }} />;
}

// Steps you've already approved/denied this session, keyed `hash:seq`. A step's own
// awaitingApproval flag only clears when the DONE event lands — AFTER the tool runs — so without
// this the run footer keeps showing "waiting for your approval" during that gap. Recording the
// decision on click lets PendingNote drop the step from "blocked" immediately. (ToolStep keeps its
// own local `decided` for its buttons; this is the run-level mirror.) Keys are unique per run
// (random hash) + monotonic seq, so it never collides; growth is one entry per approval.
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
        void services().sheetTitle(id).then((name) => {
            sheetTitleCache.set(id, name);
            setFetched(name);
        });
    }, [id, label]);
    const name = label || fetched || "Google Sheet";
    return (
        <a class="tt sheet-chip" href={`https://docs.google.com/spreadsheets/d/${id}/edit`} target="_blank" rel="noopener" onClick={e => e.stopPropagation()}>
            <IconSheet /><span class="sheet-chip-name">{name}</span>
            <span class="tt-pop wrap left" role="tooltip">Google Sheet · {id}</span>
        </a>
    );
}

/**
 * THE LIVENESS GLYPH: a small amorphous blob that wobbles, pulls itself apart into three spinning dots, and comes
 * back together. Fifteen pixels of "something is still happening", for beside the words that say what.
 *
 * It replaces an indeterminate SWEEP BAR in the reading view. A full-width bar is the browser's own page-loading
 * motif and reads right in the panel, among instrumentation; across a reading column it is a rule drawn under the
 * conversation, which is a lot of furniture to say one thing. This says the same thing in the space of a character,
 * next to the sentence it belongs to.
 *
 * HOW IT MORPHS, which is one trick rather than a sequence of drawings: three circles under a gooey filter (a blur,
 * then a hard alpha curve that re-sharpens it). Overlapping, their blurred edges merge and the filter cuts one
 * outline around the pair, so they ARE a blob; drawn apart, each gets its own outline and they are dots. So the only
 * thing animated is how far from the centre each sits, and the morph falls out of the filter.
 *
 * The group's rotation runs the whole time and is invisible while they are a lump, which is what keeps the two
 * phases from needing to be coordinated: the spin is simply always there and only legible once there is something
 * to spin.
 */
export function BusyBlob({ label }: { label?: string }) {
    return (
        <svg class="blob" viewBox="0 0 24 24" role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : "true"}>
            <defs>
                {/* The alpha curve is what re-sharpens the blur: everything under about half opacity goes, and what
                    is left goes opaque, so two blurred discs that touch come out as one solid shape. */}
                <filter id="blob-goo">
                    <feGaussianBlur in="SourceGraphic" stdDeviation="1.5" result="blur" />
                    <feColorMatrix in="blur" type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 16 -7" />
                </filter>
            </defs>
            <g filter="url(#blob-goo)">
                <circle class="blob-a" cx="12" cy="12" r="3.6" />
                <circle class="blob-b" cx="12" cy="12" r="3.6" />
                <circle class="blob-c" cx="12" cy="12" r="3.6" />
            </g>
        </svg>
    );
}
