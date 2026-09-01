// Shared leaf UI primitives for the debug sidebar — extracted from app.tsx so the
// render-panel / answer-render clusters (and the app shell) can share one source.
// These carry no run/session logic: syntax-highlighted code, copy-to-clipboard,
// the custom context menu, the page-highlight bridge, approval posting, and the
// small click-to-copy chips (Hash / CopyBtn / Stamp / TagBadge / SheetChip / …).
import { useState, useEffect } from "preact/hooks";
import { signal } from "@preact/signals";
import type { AnswerMedia } from "../contract";
import type { Status, AgentStep } from "./store";
import { codeLineNumbers } from "./store";
import { beautifyJs, highlight, htmlLines, shortStamp, fullStamp, pretty, truncate } from "./format";
import { IconCopy, IconCheck, IconSheet } from "./icons";

export const DOT_TIP: Record<Status, string> = {
    pending: "In flight — waiting for the model to respond.",
    ok: "Completed successfully.",
    err: "Failed — see the error in the turn.",
};
export const Dot = ({ status }: { status: Status }) => (
    <span class="tt">
        <span class={`dot ${status}`} />
        <span class="tt-pop left" role="tooltip">{DOT_TIP[status]}</span>
    </span>
);

// Syntax-highlighted code block (highlight() returns safe token HTML). `format`
// beautifies JS first (exec source). Reads the codeLineNumbers signal so the
// gutter toggle re-renders live; wrap vs. scroll is a global CSS attribute.
export const Code = ({ text, lang, format }: { text: string; lang?: string; format?: boolean }) => {
    const src = format && (lang === "javascript" || lang === "js") ? beautifyJs(text) : text;
    const html = highlight(src, lang);
    if (!codeLineNumbers.value)
        return <pre class="code"><code class="hljs" dangerouslySetInnerHTML={{ __html: html }} /></pre>;
    return (
        <pre class="code numbered"><code class="hljs">
            {htmlLines(html).map((ln, i) => (
                <span class="cline" key={i}>
                    <span class="lno">{i + 1}</span>
                    <span class="lcode" dangerouslySetInnerHTML={{ __html: ln || " " }} />
                </span>
            ))}
        </code></pre>
    );
};

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
export const ctxMenu = signal<{ x: number; y: number; items: CtxItem[] } | null>(null);
export const openCtxMenu = (e: MouseEvent, items: CtxItem[]): void => { e.preventDefault(); ctxMenu.value = { x: e.clientX, y: e.clientY, items }; };
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
export const clearHighlight = () => window.parent.postMessage({ __mlHighlight: null }, "*");
// The APPROVAL-card highlight: a pulsing GREEN spotlight (kind "approve"), distinct from the blue hover
// box, so the pending target is unmistakable. The shell replies with the target's on-page position
// (e.g. "bottom-left") → highlightPos, which the card shows so you know where to look.
export const highlightApprove = (ref: { selector?: string; token?: string }) => window.parent.postMessage({ __mlHighlight: { ...ref, kind: "approve" } }, "*");
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
export const decidedSteps = new Set<string>();
export const stepKey = (hash: string, seq: number) => `${hash}:${seq}`;
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
export const inlineText = (s: string): string => truncate(s.replace(/\s+/g, " ").trim(), 72);

const sheetTitleCache = new Map<string, string | null>();   // id → title (fetched once per session)
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
