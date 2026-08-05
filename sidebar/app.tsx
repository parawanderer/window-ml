// Debug sidebar — isolated content-script world, built with Preact. An opt-in,
// slide-out panel that logs every window.ml call, grouped into sessions (one per
// createChat). injected.js pushes a one-way event stream over window.postMessage
// ({ __mlDebug: MlDebugEvent }); we aggregate events into sessions by hash and
// render a list ⇄ detail UI. Bundled (Preact + signals) into dist/sidebar.js only
// — the core primitive stays dependency-free.
import { render } from "preact";
import type { ComponentChildren } from "preact";
import { useState, useEffect, useRef } from "preact/hooks";
import { signal } from "@preact/signals";
import type { MlDebugEvent, DebugSessionConfig, DebugAgentConfig, NeutralMessage, MlConfig, ApiFormat, Theme, LoadedModel, ExtendProfile, RenderDescriptor, LocateSubstep, TokenUsage, TableSource } from "../contract";
import { DEFAULT_CONFIG, fmtCtx } from "../contract";
import { elementReference, externalSheetIds } from "../dom";
import {
    FONT_KEY, WRAP_KEY, LINES_KEY,
    sessionMap, rev, view, fontScale, codeWrap, codeLineNumbers, config, models,
    ollamaIds, vramOpen, sidebarOpen, loadedModels, psError, turnsRun,
} from "./store";
import type { Status, Turn, AgentStep, Session } from "./store";
import { pretty, shortStamp, fullStamp, truncate, collapsedPreview, highlight, beautifyJs, htmlLines, markdown, lastUser, rollupStatus } from "./format";
import { annotatedConfig, turnProfile, shownModel, sessionProfile } from "./model";
import { exportSession, printSession } from "./export";
import { applyTheme, applyFont, applyCodePrefs, initThemeStyle } from "./prefs";
import { IconCopy, IconCheck, IconWarn, IconChevron, IconGear, IconExport, IconVram, IconSend, IconStop, IconUsage, IconBench, IconSheet } from "./icons";
import { Settings } from "./settings";

// The highest (cumulative) step number seen so far — the position a say()/answer arriving NOW belongs at,
// so the chat log interleaves user messages + answers with the turn step-groups in order.
const maxSessionStep = (s: Session): number => Math.max(0, ...(s.steps || []).map(x => x.step || 0));

function onDebug(ev: MlDebugEvent): void {
    // --- ml.agent runs (own session kind) ---
    if (ev.kind === "agent") {
        sessionMap.set(ev.session.hash, {
            hash: ev.session.hash, model: ev.model, tag: "session", kind: "agent",
            createdTs: ev.ts, lastTs: ev.ts, status: "pending", turns: [], steps: [], task: ev.task, maxSteps: ev.maxSteps, agentConfig: ev.config,
            config: { system: null, model: ev.model, think: null, schema: false, toolIds: null, maxTokens: null, save: false },
        });
        rev.value++; return;
    }
    if (ev.kind === "agent-step") {
        const s = sessionMap.get(ev.session.hash);
        if (!s) return;
        const step = { step: ev.step, localStep: ev.localStep, seq: ev.seq, pending: ev.pending, awaitingApproval: ev.awaitingApproval, thought: ev.thought, reasoning: ev.reasoning, tool: ev.tool, arguments: ev.arguments, result: ev.result, elements: ev.elements, renderIn: ev.renderIn, renderOut: ev.renderOut, argIssues: ev.argIssues, approval: ev.approval, usage: ev.usage };
        const steps = s.steps || [];
        // In-flight: a tool step arrives twice — a pending START then the DONE, sharing a `seq`.
        // Patch the existing row in place (immutably) so it fills in; otherwise append. Thoughts
        // and single-emit steps have no seq → always append.
        const i = ev.seq != null ? steps.findIndex(x => x.seq === ev.seq) : -1;
        // When patching the pending START with its DONE, COALESCE the render slots: a DENIED call's
        // DONE carries no renderIn/renderOut (the tool never ran → no envelope), which would blank
        // out the In preview the awaiting-approval START already showed. A render only ever appears,
        // never legitimately vanishes, so keep the existing one when the DONE doesn't supply a newer.
        const merged = i >= 0
            ? { ...step, renderIn: step.renderIn ?? steps[i].renderIn, renderOut: step.renderOut ?? steps[i].renderOut }
            : step;
        s.steps = i >= 0 ? steps.map((x, k) => k === i ? merged : x) : [...steps, step];
        // A step means the agent is actively working — flip to pending so a follow-up turn on an already-
        // "done" session (whose prior summary still sits in s.summary) reads as WORKING, not terminal. This
        // covers the off/card path where the page-side agent-say bridge is dormant, so a step is the first
        // signal the run resumed. The next agent-result flips it back to ok/err.
        s.status = "pending";
        s.lastTs = ev.ts; rev.value++; return;
    }
    if (ev.kind === "agent-result") {
        const s = sessionMap.get(ev.session.hash);
        if (!s) return;
        const status: Status = (ev.error || ev.hitCap || ev.cancelled) ? "err" : "ok";
        // Append this turn's answer (chat log) — do NOT overwrite prior turns. `summary`/`status` still
        // track the LATEST for the title + row dot.
        s.answers = [...(s.answers || []), { text: ev.summary, ts: ev.ts, atStep: maxSessionStep(s), status, hitCap: ev.hitCap, cancelled: !!ev.cancelled, error: ev.error || undefined }];
        s.summary = ev.summary; s.hitCap = ev.hitCap; s.error = ev.error || undefined; s.cancelled = !!ev.cancelled;
        s.status = status; s.lastTs = ev.ts;
        rev.value++; return;
    }
    // A handle raised the step cap mid-run (a.maxSteps = N) → the "STEP x/N" display re-renders live.
    if (ev.kind === "agent-cap") {
        const s = sessionMap.get(ev.session.hash);
        if (s) { s.maxSteps = ev.maxSteps; s.lastTs = ev.ts; rev.value++; }
        return;
    }
    // A user message mid-conversation: a follow-up run()'s task OR a mid-run say(). Both render as "you"
    // bubbles, interleaved with the turns by step position (atStep = the step count when they arrived).
    if (ev.kind === "agent-say") {
        const s = sessionMap.get(ev.session.hash);
        // A new user message means the agent is (about to be) working → back to pending, so the live footer
        // shows during a follow-up run (harmless for a mid-run steer, which is already pending).
        if (s) { s.says = [...(s.says || []), { text: ev.text, ts: ev.ts, atStep: maxSessionStep(s) }]; s.status = "pending"; s.lastTs = ev.ts; rev.value++; }
        return;
    }
    if (ev.kind === "chat") {
        let s = sessionMap.get(ev.session.hash);
        if (!s) {
            s = {
                hash: ev.session.hash, model: ev.request.model, tag: ev.save ? "saved" : "session",
                createdTs: ev.ts, lastTs: ev.ts, status: "pending", config: ev.config, turns: [],
            };
            sessionMap.set(ev.session.hash, s);
        }
        if (ev.save) s.tag = "saved";
        // Immutable: new turn object + new array. Preact/@preact/signals skips
        // re-rendering a child whose props are referentially unchanged, so a
        // turn we later update MUST become a new object or its (stateful)
        // AssistantBody won't re-render — the "stale …thinking" bug.
        const turn: Turn = { id: ev.id, ts: ev.ts, user: lastUser(ev.request.messages), images: ev.request.images, status: "pending", reqModel: ev.request.model, extend: ev.request.extend };
        s.turns = [...s.turns, turn];
        s.lastTs = ev.ts; s.status = "pending";
    } else {
        const s = sessionMap.get(ev.session.hash);
        const i = s ? s.turns.findIndex(x => x.id === ev.id) : -1;
        if (!s || i < 0) return;
        const prev = s.turns[i];
        // Replace the turn with a NEW object (see note above) so the open detail
        // view re-renders it live instead of only after a re-navigation/reload.
        const updated: Turn = ev.kind === "chat-result"
            ? { ...prev, assistant: ev.content, sources: ev.sources, structured: ev.structured, status: "ok", ts: ev.ts, model: ev.model, extend: ev.extend, reasoning: ev.reasoning, usage: ev.usage }
            : { ...prev, error: ev.error, status: "err", ts: ev.ts };
        s.turns = s.turns.map((x, idx) => idx === i ? updated : x);
        s.lastTs = ev.ts; s.status = rollupStatus(s);
    }
    rev.value++;   // notify Preact
}

/* --------------------------- session titles ------------------------------
 * Claude-Code-style short titles, generated by the *utility* model. This is
 * done entirely sidebar-side (the iframe can call the background's FETCH_LLM
 * directly, same as "Test models") — no page-`ml` round-trip. It's lazy: we
 * only summarise a session while the panel is actually open (gated on
 * sidebarOpen), and only its first completed turn. Until a title lands the row
 * falls back to the truncated first prompt. `titleTried` bounds retries to once
 * per open (cleared on a fresh open, so a failure backfills next time).
 */
const titleTried = new Set<string>();

function cleanTitle(raw: string): string {
    const line = raw.trim().split("\n").map(s => s.trim()).filter(Boolean)[0] || "";
    return truncate(line.replace(/^["'`*]+|["'`*.]+$/g, "").trim(), 60);
}

function genTitle(hash: string, prompt: string): void {
    const messages = [
        { role: "system", content: "You write terse 3-6 word titles for a request. Reply with ONLY the title — no quotes, no trailing punctuation, no preamble." },
        { role: "user", content: `Summarise this request as a short title:\n\n${truncate(prompt, 500)}` },
    ];
    chrome.runtime.sendMessage(
        { type: "FETCH_LLM", payload: { messages, extend: "utility", maxTokens: 32, think: false } },
        (resp: any) => {
            const s = sessionMap.get(hash);
            if (!s || chrome.runtime.lastError || !resp || resp.error) return;   // leave unset → retried next open
            const title = cleanTitle(String(resp.data || ""));
            if (title) { s.title = title; rev.value++; }
        },
    );
}

// Scan for sessions still needing a title and kick off generation. Called from
// App's effect on every session change / open transition.
function maybeGenerateTitles(): void {
    // Opt-in: only when a utility model is configured AND auto-titles is on.
    // Without a utility model, extend:"utility" would fall back to the (expensive)
    // main model — a user who hasn't set one hasn't asked for auto-titles.
    if (!sidebarOpen.value || !config.value.autoTitles || !config.value.utilityModel.trim()) return;
    for (const s of sessionMap.values()) {
        if (s.title || titleTried.has(s.hash)) continue;
        const first = s.turns[0];
        if (!first || first.status !== "ok" || !first.user.trim()) continue;
        titleTried.add(s.hash);
        genTitle(s.hash, first.user);
    }
}

/* ------------------------------ components ------------------------------- */
const DOT_TIP: Record<Status, string> = {
    pending: "In flight — waiting for the model to respond.",
    ok: "Completed successfully.",
    err: "Failed — see the error in the turn.",
};
const Dot = ({ status }: { status: Status }) => (
    <span class="tt">
        <span class={`dot ${status}`} />
        <span class="tt-pop left" role="tooltip">{DOT_TIP[status]}</span>
    </span>
);

// Syntax-highlighted code block (highlight() returns safe token HTML). `format`
// beautifies JS first (exec source). Reads the codeLineNumbers signal so the
// gutter toggle re-renders live; wrap vs. scroll is a global CSS attribute.
const Code = ({ text, lang, format }: { text: string; lang?: string; format?: boolean }) => {
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
function execCopy(text: string): Promise<void> {
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
function copyText(text: string): Promise<void> {
    if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text).catch(() => execCopy(text));
    return execCopy(text);
}

// "copied!" feedback that reverts after a moment.
function useCopy(): { copied: boolean; copy: (text: string) => void } {
    const [copied, setCopied] = useState(false);
    const copy = (text: string) =>
        copyText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }).catch(() => {});
    return { copied, copy };
}

// A lightweight custom context menu. A web-page/iframe can't invoke the native OS menu with custom
// items (that's privileged DevTools-only), so we render our own popup at the cursor. Rendered once in
// App; opened via openCtxMenu(e, items); dismissed on outside-click / Esc / blur / item-click.
interface CtxItem { label: string; run: () => void; }
const ctxMenu = signal<{ x: number; y: number; items: CtxItem[] } | null>(null);
const openCtxMenu = (e: MouseEvent, items: CtxItem[]): void => { e.preventDefault(); ctxMenu.value = { x: e.clientX, y: e.clientY, items }; };
function ContextMenu() {
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
const openLightbox = (src: string) => window.parent.postMessage({ __mlLightbox: src }, "*");

// Ask the shell to draw / clear a DevTools-style highlight over a page element (on hover of a rendered
// element reference). The shell owns the page DOM (a content script), so it resolves the selector +
// rect and outlines it WITHOUT touching the element. Overlay-surface only — a no-op in the devtools
// panel, whose parent can't reach the page.
const highlightEl = (selector: string) => window.parent.postMessage({ __mlHighlight: { selector } }, "*");
// A canvas @pt/@box token — the shell resolves it (via injected) to a point marker / box outline.
const highlightToken = (token: string) => window.parent.postMessage({ __mlHighlight: { token } }, "*");
const clearHighlight = () => window.parent.postMessage({ __mlHighlight: null }, "*");
// The APPROVAL-card highlight: a pulsing GREEN spotlight (kind "approve"), distinct from the blue hover
// box, so the pending target is unmistakable. The shell replies with the target's on-page position
// (e.g. "bottom-left") → highlightPos, which the card shows so you know where to look.
const highlightApprove = (ref: { selector?: string; token?: string }) => window.parent.postMessage({ __mlHighlight: { ...ref, kind: "approve" } }, "*");
const highlightPos = signal<string>("");
// Hover handlers for a locate `picked` string, which is EITHER an @pt/@box token OR "… → selector" —
// so the same overlay works in both point mode and element mode.
const pickedHover = (picked?: string): { onPointerEnter?: () => void; onPointerLeave?: () => void } => {
    if (!picked) return {};
    const tok = picked.match(/@(?:pt|box):[0-9a-f]+/)?.[0];
    const sel = tok ? "" : (picked.split("→").pop() || "").trim();
    if (!tok && !sel) return {};
    return { onPointerEnter: () => (tok ? highlightToken(tok) : highlightEl(sel)), onPointerLeave: clearHighlight };
};
// Hover handlers for any string that MENTIONS an @pt/@box token (e.g. a look image's label
// `element "@pt:…"`) — hover → outline it on the page. Only fires when a token is present.
const tokenHover = (s?: string): { onPointerEnter?: () => void; onPointerLeave?: () => void } => {
    const tok = s?.match(/@(?:pt|box):[0-9a-f]+/)?.[0];
    return tok ? { onPointerEnter: () => highlightToken(tok), onPointerLeave: clearHighlight } : {};
};

// Design A: the sidebar's approve/deny for a background-hosted run's pending gate. We post it to the
// SHELL (our parent), which — because it can prove the message came from this real extension iframe
// (e.source === frame.contentWindow, unforgeable by the page) — forwards it to the background as
// SET_APPROVAL. That authentication is the whole point: the decision is made HERE and the page can't
// spoof it. Keyed by the run hash + the step's seq.
const sendApproval = (hash: string, seq: number, decision: boolean) =>
    window.parent.postMessage({ __mlSidebarApp: "approval", hash, seq, decision }, "*");
// Steps you've already approved/denied this session, keyed `hash:seq`. A step's own
// awaitingApproval flag only clears when the DONE event lands — AFTER the tool runs — so without
// this the run footer keeps showing "waiting for your approval" during that gap. Recording the
// decision on click lets PendingNote drop the step from "blocked" immediately. (ToolStep keeps its
// own local `decided` for its buttons; this is the run-level mirror.) Keys are unique per run
// (random hash) + monotonic seq, so it never collides; growth is one entry per approval.
const decidedSteps = new Set<string>();
const stepKey = (hash: string, seq: number) => `${hash}:${seq}`;
// No tooltip here on purpose: `cursor: zoom-in` is the standard affordance for
// "click to enlarge", and a pop anchored under a full-width screenshot (locate
// renders stack several) would land far from the pointer and just add noise.
const ClickableImg = ({ src, alt }: { src: string; alt?: string }) =>
    <img class="zoomable" src={src} alt={alt} onClick={() => openLightbox(src)} />;

// A short hash rendered as click-to-copy, with a tooltip. `stop` swallows the
// click so copying a hash inside a session row doesn't also open the session.
function Hash({ hash, stop }: { hash: string; stop?: boolean }) {
    const { copied, copy } = useCopy();
    return (
        <span class="tt">
            <code class="hash copyable" onClick={(e) => { if (stop) e.stopPropagation(); copy(hash); }}>{hash}</code>
            <span class="tt-pop" role="tooltip">{copied ? "copied!" : "click to copy"}</span>
        </span>
    );
}

// A small copy-to-clipboard icon button with a tooltip.
function CopyBtn({ text, tip = "copy" }: { text: string; tip?: string }) {
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
const TAG_TIP: Record<string, string> = {
    session: "Session-local — lives in this tab only, gone on reload.",
    saved: "Saved — persisted to storage; resumable by hash across reloads and tabs.",
};
const TagBadge = ({ tag }: { tag: string }) => (
    <span class="tt">
        <span class={`tag ${tag}`}>{tag}</span>
        <span class="tt-pop wide" role="tooltip">{TAG_TIP[tag] || tag}</span>
    </span>
);

// Timestamp: compact label, exact full stamp on hover. `snap` picks which way the
// tooltip opens — "left" (default, for right-edge placements like the chat view)
// or "right" (for left-edge placements like the list row, so it doesn't clip).
const Stamp = ({ ts, snap = "left" }: { ts?: number; snap?: "left" | "right" }) => (
    <span class="tt">
        <span class="time">{shortStamp(ts)}</span>
        <span class={`tt-pop${snap === "right" ? " left" : ""}`} role="tooltip">{fullStamp(ts)}</span>
    </span>
);



// The session's createChat config (not the per-turn request/messages — full
// message history is a separate export feature).
function OptionsBlock({ s }: { s: Session }) {
    const c = s.config;
    const lines: string[] = [`model: ${c.model || "default"}`];
    if (c.system) lines.push(`system: ${truncate(c.system, 200)}`);
    if (c.think) lines.push("think: true");
    if (c.schema) lines.push("schema: yes (structured output)");
    if (c.toolIds?.length) lines.push(`toolIds: ${c.toolIds.join(", ")}`);
    if (c.maxTokens != null) lines.push(`maxTokens: ${c.maxTokens}`);
    if (c.save) lines.push("save: true");
    // Collapsed by default (disclosure triangle); the raw/copy controls live
    // inside the header and only show once expanded.
    const [openB, setOpenB] = useState(false);
    const [showRaw, setShowRaw] = useState(false);
    return (
        <div class="block">
            <div class="block-head" role="button" onClick={() => setOpenB(v => !v)}>
                <span class={`tri${openB ? " open" : ""}`} aria-hidden="true"><IconChevron /></span>
                <span class="block-label">options</span>
                <span class="sp" />
                {openB
                    ? <>
                        <button class="raw-btn" onClick={(e) => { e.stopPropagation(); setShowRaw(v => !v); }}>{showRaw ? "nice" : "raw"}</button>
                        <CopyBtn text={pretty(c)} tip="copy JSON" />
                    </>
                    : null}
            </div>
            {openB
                ? <div class="tbody">{showRaw ? <Code text={annotatedConfig(c)} lang="javascript" /> : <pre class="opts">{lines.join("\n")}</pre>}</div>
                : null}
        </div>
    );
}


// The model that produced a reply, as a click-to-copy chip (handy for debugging).
function CopyModel({ model }: { model: string }) {
    const { copied, copy } = useCopy();
    return (
        <span class="tt">
            <button class="model-name" onClick={(e) => { e.stopPropagation(); copy(model); }}>{model}</button>
            <span class="tt-pop" role="tooltip">{copied ? "copied!" : "copy model name"}</span>
        </span>
    );
}

// A reply bubble — shared by a chat turn's assistant reply and an agent run's
// final answer, so the two render identically: no boxed background (#5), a header
// (status dot · collapse chevron · model chip · (profile) · copy · raw ⇄ nice ·
// timestamp) over the body (markdown ⇄ raw, collapsible), with optional thinking
// and sources. No "assistant"/"answer" word — the header controls carry the
// meaning; `label` appears only for an exceptional state (e.g. an agent step-cap).
function ReplyBubble({ content, status, model, profile, ts, reasoning = null, sources = null, error, label, capped, initialRaw }: {
    content: string; status: Status; model: string | null; profile: "utility" | "default" | null; ts: number;
    reasoning?: string | null; sources?: unknown[] | null; error?: string; label?: string; capped?: boolean; initialRaw?: boolean;
}) {
    const [showRaw, setShowRaw] = useState(!!initialRaw);
    const [collapsed, setCollapsed] = useState(false);
    // "There's a reply to show" — true for an OK turn AND a step-capped agent answer
    // (status "err" but it still produced a summary). A real error has `error` set.
    const hasReply = status !== "pending" && !error;
    const preview = hasReply ? collapsedPreview(content) : null;
    return (
        <div class={`msg asst ${status}${capped ? " capped" : ""}`}>
            <div class="mrow">
                {/* Chevron (collapse affordance) · status dot · an optional label for
                    an exceptional state (e.g. an agent step-cap stop). */}
                {hasReply
                    ? <button class="who-toggle" title={collapsed ? "expand" : "collapse"} onClick={() => setCollapsed(v => !v)}>
                        <span class={`tri${collapsed ? "" : " open"}`} aria-hidden="true"><IconChevron /></span>
                    </button>
                    : null}
                <Dot status={status} />
                {label ? <span class="who">{label}</span> : null}
                {/* The model that produced this reply + its (default)/(utility) profile. */}
                {hasReply && model ? <CopyModel model={model} /> : null}
                {hasReply && model && profile ? <span class="profile-inline">({profile})</span> : null}
                <span class="sp" />
                {/* Copy + raw⇄nice are for a real reply. A terminal notice (a step-cap
                    stop) is a short line — collapsible is enough; copy/raw are noise. */}
                {hasReply && !capped
                    ? <>
                        <CopyBtn text={content} tip="copy markdown" />
                        {collapsed ? null : <button class="raw-btn" onClick={() => setShowRaw(v => !v)}>{showRaw ? "nice" : "raw"}</button>}
                    </>
                    : null}
                <Stamp ts={ts} />
            </div>
            {/* Reasoning/thinking text (separate from the reply), collapsed by default. */}
            {hasReply && !collapsed && reasoning
                ? <details class="thinking"><summary>thinking</summary><div class="md" dangerouslySetInnerHTML={{ __html: markdown(reasoning, { math: true }) }} /></details>
                : null}
            {status === "pending"
                ? <div class="pending-note">…thinking</div>
                : error
                    ? <div class="errtext">{error}</div>
                    : collapsed
                        ? <div class="asst-collapsed" onClick={() => setCollapsed(false)}>{preview!.text}{preview!.more ? <span class="more"> …</span> : null}</div>
                        : showRaw
                            ? <Code text={content} lang="markdown" />
                            : <div class="md" dangerouslySetInnerHTML={{ __html: markdown(content, { math: true }) }} />}
            {sources?.length
                ? <details class="sources"><summary>{`sources (${sources.length})`}</summary><Code text={pretty(sources)} lang="json" /></details>
                : null}
        </div>
    );
}

function MessageTurn({ t }: { t: Turn }) {
    return (
        <>
            <div class="msg user">
                <div class="mrow"><span class="who">user</span><span class="sp" /><Stamp ts={t.ts} /></div>
                <div class="utext">{t.user}</div>
                {t.images?.length ? <div class="thumbs">{t.images.map((src, i) => <ClickableImg key={i} src={src} />)}</div> : null}
            </div>
            <ReplyBubble content={t.assistant || ""} status={t.status} model={t.model ?? null}
                profile={turnProfile(t)} ts={t.ts} reasoning={t.reasoning} sources={t.sources}
                error={t.status === "err" ? (t.error || "(error)") : undefined} initialRaw={!!t.structured} />
        </>
    );
}

const ProfileBadge = ({ profile }: { profile?: ExtendProfile | null }) =>
    profile !== null ? <span class="profile">{profile}</span> : null;

// Presentational — model/profile arrive as plain props (resolved in ListView).
// It must NOT read a signal itself: @preact/signals auto-memoizes a
// signal-reading child, which (with our in-place session mutation → unchanged
// `s` reference) would make it skip the parent re-render and freeze on pending.
const AgentBadge = () => <span class="agent-badge">agent</span>;

// The model name is intentionally NOT shown here — the list gets busy with tags,
// and the resolved model is one tap away in the detail header.
function SessionRow({ s, profile }: { s: Session; profile: "utility" | "default" | null }) {
    const title = s.title || s.task || s.turns[0]?.user || "(no prompt)";
    return (
        <button class="row" onClick={() => (view.value = { name: "detail", hash: s.hash })}>
            <Dot status={s.status} />
            <Stamp ts={s.lastTs} snap="right" />
            {/* key flips fb→ai when the AI-summarised title lands, remounting the element so ml-reveal
                plays once (a plain text swap wouldn't animate). Only the AI title animates, not the fallback. */}
            <b class={`row-title${s.title ? " ml-reveal" : ""}`} key={s.title ? "t-ai" : "t-fb"}>{truncate(title, 80)}</b>
            <div class="row-meta">
                {s.kind === "agent" ? <AgentBadge /> : <TagBadge tag={s.tag} />}
                <ProfileBadge profile={profile} />
                <Hash hash={s.hash} stop />
            </div>
        </button>
    );
}

// --- descriptor renderers: a serializable RenderDescriptor → a panel. The
// registry is keyed by `type`; a tool supplies one (page-side) or we auto-derive
// image/elements, else the default In:/Out: renders the raw result. ---
function RenderElements({ items }: { items: { path: string; text?: string; index?: number }[] }) {
    const single = items.length === 1;   // one element → the #0 badge is noise; just show the element
    return (
        <div class="r-elements">
            {items.map((it, i) => {
                // Hover → outline it on the page (DevTools-style). A path that's an @pt/@box highlights
                // the point/region (via injected); a CSS selector highlights the element. Right-click a
                // selector row → a menu to copy a JS reference (nothing sensible for an @pt/@box).
                const isTok = /^@(?:pt|box):[0-9a-f]+$/.test(it.path);
                const menu = (e: MouseEvent) => openCtxMenu(e, [
                    { label: "Copy document.querySelector(…)", run: () => copyText(elementReference(it.path, it.index)) },
                    { label: "Copy selector", run: () => copyText(it.path) },
                ]);
                return (
                    <div class="r-el" key={it.index ?? i}
                        title={isTok ? undefined : "right-click to copy a reference"}
                        onPointerEnter={() => (isTok ? highlightToken(it.path) : highlightEl(it.path))} onPointerLeave={clearHighlight}
                        onContextMenu={isTok ? undefined : menu}>
                        {single ? null : <span class="r-el-idx">#{it.index ?? i}</span>}
                        {it.text ? <span class="r-el-text">«{it.text}»</span> : null}
                        <code class="r-el-path">{it.path}</code>
                    </div>
                );
            })}
        </div>
    );
}
function RenderTable({ columns, rows }: { columns: string[]; rows: (string | number | null)[][] }) {
    return (
        <div class="r-table-wrap">
            <table class="r-table">
                <thead><tr>{columns.map((c, i) => <th key={i}>{c}</th>)}</tr></thead>
                <tbody>{rows.map((row, i) => <tr key={i}>{row.map((c, j) => <td key={j} class={typeof c === "number" ? "r-td-num" : undefined}>{c == null ? "" : String(c)}</td>)}</tr>)}</tbody>
            </table>
        </div>
    );
}
// The `locate` debug view: model + mode header, then (grounding) the VLM prompt, the
// square the model saw with its box, and the element-location pass; (marks) just the
// badged shot. Picked element at the bottom.
// One substep of a locate run: a vision sub-call (its own In-prompt / image / Out-reply,
// with a raw⇄visualise image toggle) or a DOM snap (just a labelled image). The [N] badge
// numbers it; hovering explains what kind of step it is.
function LocateSubstepView({ s, n }: { s: LocateSubstep; n: number }) {
    const [raw, setRaw] = useState(false);   // "visualise" (the human overlay) by default
    const kind = s.prompt ? "a vision sub-call — its own prompt + reply, run standalone" : "a DOM hit-test — no model call";
    return (
        <div class="r-loc-sub">
            {s.note ? <div class="r-loc-note">{s.note}</div> : null}
            <div class="r-loc-subhead">
                <span class="tt r-loc-numtt"><span class="r-loc-num">{n}</span><span class="tt-pop left" role="tooltip">Sub-step {n}: {kind}.</span></span> {s.label}
            </div>
            {s.prompt ? <details class="io r-loc-io"><summary class="io-label">In (prompt): <span class="io-preview">{inlineText(s.prompt)}</span></summary><div class="io-body"><Code text={s.prompt} lang="text" /></div></details> : null}
            {s.image ? <div class="r-loc-stage">
                <ClickableImg src={raw && s.rawImage ? s.rawImage : s.image} alt={s.label} />
                {s.rawImage ? <div class="rr-toggle r-loc-viz">
                    <button class={raw ? "" : "on"} onClick={() => setRaw(false)}>visualise</button>
                    <button class={raw ? "on" : ""} onClick={() => setRaw(true)}>raw</button>
                </div> : null}
            </div> : null}
            {s.output != null && s.output !== "" ? <details class="io r-loc-io"><summary class="io-label">Out: <span class="io-preview">{inlineText(s.output)}</span></summary><div class="io-body"><Code text={s.output} lang="text" /></div></details> : null}
        </div>
    );
}

function LocateRender({ d }: { d: Extract<RenderDescriptor, { type: "locate" }> }) {
    // Is this vision sub-call's model the SAME as the agent driver's? If so, flag that
    // it still ran standalone (its image + reply never entered the driver's context) —
    // otherwise the matching name reads as if the driver itself saw and answered.
    rev.value;   // reactive: re-read when sessions change
    const driverModel = view.value.name === "detail" ? sessionMap.get(view.value.hash)?.model : undefined;
    const sameAsDriver = !!driverModel && d.model === driverModel;
    return (
        <div class="r-locate">
            <div class="r-loc-head">
                {d.mode === "grounding" ? "Grounding" : d.mode === "grid-grounding" ? "Grid → Grounding" : d.mode === "grid" ? "Grid" : "Set-of-Marks"} · <b>{d.model}</b>
                {sameAsDriver ? <span class="tt r-loc-delegated"> (standalone sub-call · not in the agent's context)<span class="tt-pop left" role="tooltip">This vision sub-call ran on its own — its image and reply were NOT added to the agent driver's conversation, even though it's the same model.</span></span> : null}
            </div>
            {d.substeps.map((s, i) => <LocateSubstepView key={i} s={s} n={i + 1} />)}
            <div class="r-loc-picked">
                <span class="tt">{d.pickedBy === "model" ? "Model picked" : "Snapped to"}<span class="tt-pop left" role="tooltip">{d.pickedBy === "model" ? "The model chose this by badge number (Set-of-Marks)." : d.pickedBy === "snap" ? "The model localized a region; the DOM hit-test chose this actual element." : "No element was selected."}</span></span>: {d.picked ? <code class="r-hoverable" {...pickedHover(d.picked)}>{d.picked}</code> : <span class="dim">(none)</span>}
            </div>
        </div>
    );
}

// `python_exec`'s In slot: a notebook-cell header — the run mode (hover explains what
// `script`/`cast:pt`/`cast:box` mean), the input screenshot the script saw, and the source.
const PY_MODE = {
    script: { label: "script", tip: "General scripting — the return comes back as text." },
    pt: { label: "cast: pt", tip: "The return is validated as a point ([x,y]/{x,y}) and minted as a clickable @pt." },
    box: { label: "cast: box", tip: "The return is validated as a box and minted as an @box region." },
} as const;
// A Jupyter/DataFrame-style preview of the injected `df`: a numbered index gutter, sticky
// header, zebra rows + vertical rules, right-aligned monospace numbers — plus click-to-sort
// (cycles asc→desc→none, preserving the pandas index), drag-to-resize columns, collapse, and
// copy-CSV. Zero-dep (no grid library — it's a capped debug preview). Human-only, so it shows
// up to PY_DF_ROWS rows, not the model's cap.
const PY_DF_ROWS = 200;
const csvField = (v: string | number | null): string => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
function PyDfTable({ columns, rows }: { columns: string[]; rows: (string | number | null)[][] }) {
    const cols = columns.length ? columns : (rows[0] || []).map((_, i) => String(i));
    const [collapsed, setCollapsed] = useState(false);
    const [sort, setSort] = useState<{ c: number; dir: 1 | -1 } | null>(null);
    const [widths, setWidths] = useState<Record<number, number>>({});
    const [copied, setCopied] = useState(false);

    // Sort a [originalIndex, row] view so the gutter keeps the pandas index (like sort_values);
    // numbers compare numerically, strings by locale, nulls (NaN) always sink to the bottom.
    let view = rows.map((r, i) => [i, r] as [number, (string | number | null)[]]);
    if (sort) view = [...view].sort(([, a], [, b]) => {
        const x = a[sort.c], y = b[sort.c];
        if (x == null) return y == null ? 0 : 1;
        if (y == null) return -1;
        return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y))) * sort.dir;
    });
    const shown = view.slice(0, PY_DF_ROWS);

    const cycleSort = (c: number) => setSort(s => !s || s.c !== c ? { c, dir: 1 } : s.dir === 1 ? { c, dir: -1 } : null);
    const copyCsv = () => {
        const csv = [cols.map(csvField).join(","), ...rows.map(r => cols.map((_, j) => csvField(r[j])).join(","))].join("\n");
        navigator.clipboard?.writeText(csv).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }, () => {});
    };
    const startResize = (c: number, e: any) => {
        e.preventDefault(); e.stopPropagation();
        const th = (e.currentTarget as HTMLElement).parentElement as HTMLElement;
        const startX = e.clientX, startW = widths[c] ?? th.offsetWidth;
        const onMove = (ev: PointerEvent) => setWidths(w => ({ ...w, [c]: Math.max(40, startW + ev.clientX - startX) }));
        const onUp = () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); };
        window.addEventListener("pointermove", onMove); window.addEventListener("pointerup", onUp);
    };

    return (
        <div class="r-df">
            <div class="r-df-bar">
                <button class="r-df-btn" onClick={() => setCollapsed(v => !v)}>{collapsed ? "▸ show table" : "▾ hide table"}</button>
                {!collapsed ? <button class="r-df-btn" onClick={copyCsv}>{copied ? "copied ✓" : "copy CSV"}</button> : null}
            </div>
            {collapsed ? null : <>
                <div class="r-df-scroll">
                    <table class="r-df-table">
                        <thead><tr>
                            <th class="r-df-idx"></th>
                            {cols.map((c, j) => (
                                <th key={j} style={widths[j] ? { width: `${widths[j]}px` } : undefined} onClick={() => cycleSort(j)} title="click to sort">
                                    {c}{sort && sort.c === j ? <span class="r-df-sort">{sort.dir === 1 ? " ▲" : " ▼"}</span> : null}
                                    <span class="r-df-resize" title="drag to resize" onPointerDown={(e: any) => startResize(j, e)} onClick={(e: any) => e.stopPropagation()} />
                                </th>
                            ))}
                        </tr></thead>
                        <tbody>{shown.map(([origIdx, row], i) => (
                            <tr key={i}>
                                <td class="r-df-idx">{origIdx}</td>
                                {cols.map((_, j) => { const c = row[j]; return <td key={j} class={typeof c === "number" ? "r-td-num" : (c == null ? "r-td-nan" : undefined)}>{c == null ? "NaN" : String(c)}</td>; })}
                            </tr>
                        ))}</tbody>
                    </table>
                </div>
                {rows.length > PY_DF_ROWS ? <div class="dim r-py-more">… {rows.length - PY_DF_ROWS} more rows</div> : null}
            </>}
        </div>
    );
}
// A loaded DataFrame's provenance → a short source label + a hover tooltip clarifying where the
// data came from (so a multi-table run reads clearly, and the human knows what was fetched).
function tableSourceDesc(s: TableSource): { short: string; tip: string } {
    switch (s.kind) {
        case "sheet-external": return { short: `sheet ${s.label}`, tip: "This data was fetched from an EXTERNAL Google Sheet with your approval." };
        case "sheet-current": return { short: s.label, tip: "This data was fetched from the Google Sheet you're currently on." };
        default: return { short: s.label, tip: `This data was extracted from a table on the current page (${s.label}).` };
    }
}
function PythonInRender({ d }: { d: Extract<RenderDescriptor, { type: "python-in" }> }) {
    return (
        <div class="r-python r-py-in">
            <div class="r-py-mode">Mode: <span class="tt"><span class="r-py-modeval">{PY_MODE[d.mode].label}</span><span class="tt-pop left" role="tooltip">{PY_MODE[d.mode].tip}</span></span></div>
            {d.image ? <div class="r-image r-py-img"
                {...(d.imageToken ? { onPointerEnter: () => highlightToken(d.imageToken!), onPointerLeave: clearHighlight } : {})}>
                <ClickableImg src={d.image} alt="input image" /><div class="r-image-label">input image (img / img_np){d.imageToken ? " — hover to locate on page" : ""}</div></div> : null}
            {(d.tables || []).map((t, i) => {
                const src = tableSourceDesc(t.source);
                const cols = t.columns?.length || t.rows?.[0]?.length || 0;
                return <div key={i} class="r-py-table">
                    <div class="r-py-lbl">
                        input table → <b class="r-py-var">{t.name}</b>{t.rows ? ` (${t.rows.length} × ${cols})` : ""}
                        {" · "}
                        {t.source.kind === "sheet-external"
                            ? <SheetChip id={t.source.label} label={t.source.name || undefined} />   /* id → a friendly chip; name = the real sheet title */
                            : <span class="tt r-py-src"><span class="r-py-srcval">{src.short}</span><span class="tt-pop left" role="tooltip">{src.tip}</span></span>}
                    </div>
                    {t.rows ? <PyDfTable columns={t.columns || []} rows={t.rows} />
                        : <div class="dim r-py-more">loaded via pd.read_html (no clean row preview)</div>}
                </div>;
            })}
            <Code text={d.code} lang="python" />
        </div>
    );
}
// A collapsible section of the python-out block (stdout / value / error / token). Same disclosure
// pattern as the In:/Out: blocks — open by default, its label is the summary. A big stdout can be
// folded away to get to the value.
function PyOutSection({ label, cls, children }: { label: string; cls: string; children: ComponentChildren }) {
    return <details class={`r-py-sec ${cls}`} open><summary class="r-py-lbl">{label}</summary>{children}</details>;
}
// `python_exec`'s Out slot: captured stdout, then one of a returned image / a minted
// @pt·@box token / the raw value / a Python traceback.
function PythonOutRender({ d }: { d: Extract<RenderDescriptor, { type: "python-out" }> }) {
    return (
        <div class="r-python r-py-out">
            {d.stdout ? <PyOutSection label="stdout" cls="r-py-stdout"><Code text={d.stdout} lang="text" /></PyOutSection> : null}
            {d.image ? <div class="r-image"><ClickableImg src={d.image} alt="output image" /><div class="r-image-label">returned image</div></div> : null}
            {d.token ? <PyOutSection label="token" cls="r-py-token"><code class="r-hoverable" onPointerEnter={() => highlightToken(d.token!)} onPointerLeave={clearHighlight}>{d.token}</code></PyOutSection> : null}
            {d.error ? <PyOutSection label="error" cls="r-py-err"><Code text={d.error} lang="text" /></PyOutSection> : null}
            {d.df && !d.error ? <PyOutSection label="value (DataFrame)" cls="r-py-val"><PyDfTable columns={d.df.columns} rows={d.df.rows} /></PyOutSection> : null}
            {d.value != null && !d.image && !d.token && !d.error && !d.df ? <PyOutSection label="value" cls="r-py-val"><Code text={d.value} lang="json" /></PyOutSection> : null}
        </div>
    );
}

// A DELEGATED look's Out: the exact image the reader saw + which model read it + its text output —
// so it reads like a locate sub-call, not the weird auto-derived element text it used to show.
function LookRender({ d }: { d: Extract<RenderDescriptor, { type: "look" }> }) {
    return (
        <div class="r-look">
            <div class="r-image">
                <ClickableImg src={d.image} alt={d.label || "look"} />
                <div class="r-image-label">{d.label ? `${d.label} · ` : ""}viewed by <b>{d.model || "default"}</b></div>
            </div>
            {/* The reader's output can be long → collapsible (open by default), same disclosure as python-out. */}
            <details class="r-py-sec r-look-out-sec" open>
                <summary class="r-py-lbl">model output</summary>
                <div class="r-look-out md" dangerouslySetInnerHTML={{ __html: markdown(d.output, { math: true }) }} />
            </details>
        </div>
    );
}

function RenderPanel({ d }: { d: RenderDescriptor }) {
    switch (d.type) {
        case "image": {
            // If the label references an @pt/@box (e.g. look's `element "@pt:…"`), hovering the shot
            // outlines that point/region on the page — same overlay setup.
            const th = tokenHover(d.label);
            return <div class={`r-image${th.onPointerEnter ? " r-hoverable" : ""}`} {...th}>
                <ClickableImg src={d.src} alt={d.label || "image"} />{d.label ? <div class="r-image-label">{d.label}</div> : null}</div>;
        }
        case "code": return <Code text={d.text} lang={d.lang} format={d.format} />;
        case "table": return <RenderTable columns={d.columns} rows={d.rows} />;
        case "keyval": return <div class="r-keyval">{d.pairs.map(([k, v], i) => <div class="r-kv" key={i}><span class="r-k">{k}</span><span class="r-v">{v}</span></div>)}</div>;
        case "elements": return <RenderElements items={d.items} />;
        case "action":
            // DEBUG In view (overlay/devtools): keep the hoverable/selectable ELEMENT reference (the
            // selector + human label, hover → outline, right-click → copy a reference), exactly like the
            // pre-intent render. The user-facing "Agent wants to …" sentence is the CARD's job (built in
            // ApprovalBody), NOT the log — the log stays a debugging tool.
            return d.selector
                ? <RenderElements items={[{ path: d.selector, ...(d.target ? { text: d.target } : {}) }]} />
                : <Code text={pretty(d)} lang="json" />;
        case "locate": return <LocateRender d={d} />;
        case "python-in": return <PythonInRender d={d} />;
        case "python-out": return <PythonOutRender d={d} />;
        case "look": return <LookRender d={d} />;
        default: return <Code text={pretty(d)} lang="json" />;   // unknown type → dump it
    }
}

// A Jupyter-style In:/Out: block: a gutter label + content, collapsible on its
// own (a grey inline preview shows when collapsed). If a descriptor targets THIS
// block it renders by default with a per-block rendered⇄raw toggle (e.g. exec's
// In renders pretty JS while its Out stays raw). `raw` is the plain fallback.
function IoBlock({ label, tip, preview, render, raw }: { label: string; tip?: string; preview: string; render?: RenderDescriptor; raw: ComponentChildren }) {
    const [showRaw, setShowRaw] = useState(false);   // rendered by default when a descriptor targets this block
    return (
        <details class="io" open>
            <summary class="io-label" title={tip}>{label}: <span class="io-preview">{preview}</span></summary>
            <div class="io-body">
                {render
                    ? <>
                        <div class="rr-toggle">
                            <span class="tt"><button class={showRaw ? "" : "on"} onClick={() => setShowRaw(false)}>rendered</button><span class="tt-pop left" role="tooltip">A debug visualisation for you — not shown to the model.</span></span>
                            <span class="tt"><button class={showRaw ? "on" : ""} onClick={() => setShowRaw(true)}>raw</button><span class="tt-pop left" role="tooltip">Exactly what the model sent/received. All it knows.</span></span>
                        </div>
                        {showRaw ? raw : <RenderPanel d={render} />}
                    </>
                    : raw}
            </div>
        </details>
    );
}
// Grey one-line preview for a collapsed In/Out: minified args, or newline-collapsed output.
const inlineJson = (v: unknown): string => truncate(pretty(v).replace(/\s+/g, " "), 64);
const inlineText = (s: string): string => truncate(s.replace(/\s+/g, " ").trim(), 72);

// A step of one ml.agent TURN (one LLM call): the assistant's prose (thought) + its separate
// reasoning/thinking + its batched tool calls.
// `step` is the SESSION-cumulative step (the grouping key, so turn N's steps don't merge with turn 1's);
// `localStep` is the PER-TURN step shown in the pill — maxSteps is a per-turn budget, so a follow-up run
// counts 1/N again, not 18/20. (Falls back to `step` for a pre-localStep event.)
interface AgentTurnGroup { step: number; localStep: number; thought?: string; reasoning?: string | null; tools: AgentStep[]; }
function groupTurns(steps: AgentStep[]): AgentTurnGroup[] {
    const byStep = new Map<number, AgentTurnGroup>();
    const order: number[] = [];
    for (const st of steps) {
        let t = byStep.get(st.step);
        if (!t) { t = { step: st.step, localStep: st.localStep ?? st.step, tools: [] }; byStep.set(st.step, t); order.push(st.step); }
        if (st.thought != null) t.thought = st.thought;
        if (st.reasoning != null) t.reasoning = st.reasoning;
        if (st.tool) t.tools.push(st);
    }
    return order.map(s => byStep.get(s)!);
}

const StepPill = ({ step, max }: { step: number; max?: number }) =>
    <span class="step-pill">step {step}{max ? `/${max}` : ""}</span>;

// The turn's separate reasoning channel (reasoning_content) — how the model THINKS, distinct from
// what it says (the prose). Dim, COLLAPSED by default (its text is mostly noise); the preview is just
// a ~token estimate (the server reports reasoning_tokens:0). No status dot — it's not a step that fails.
function ThoughtBlock({ thought }: { thought: string }) {
    const [open, setOpen] = useState(false);
    const tokEst = Math.max(1, Math.round(thought.length / 4));   // ~chars/4 (no real reasoning_tokens)
    return (
        <div class="athought athinking">
            <button class="astep-head" onClick={() => setOpen(v => !v)}>
                <span class={`tri${open ? " open" : ""}`} aria-hidden="true"><IconChevron /></span>
                <span class="who">thinking</span>
                {/* The ~token estimate is a debug detail — hidden in the user-facing HUD card, kept in the
                    DevTools panel / overlay. */}
                {!open && surface.value !== "card" ? <span class="astep-preview">~{tokEst} tokens</span> : null}
            </button>
            {open ? <div class="md astep-body" dangerouslySetInnerHTML={{ __html: markdown(thought, { math: true }) }} /> : null}
        </div>
    );
}

const toolFailed = (result?: string): boolean => !!result && /^(Error:|Denied)/.test(result);

// One tool call: collapsed by default. Expanded, a descriptor renders by default
// with a rendered⇄raw toggle (raw = the In:/Out: args+result); no descriptor →
// In:/Out: directly.
// How an approval-gated call was decided — a green/red provenance pill. This is
// also the slot a future interactive-approval control will resolve into.
const APPROVAL = {
    readonly: { label: "auto-approved", tip: "Auto-approved by the read-only exec setting." },
    sandbox: { label: "auto-approved", tip: "Auto-approved by the python_exec setting — a readonly-mode run is isolated by construction (no network / JS scope / DOM / filesystem)." },
    user: { label: "approved", tip: "Approved by you." },
    denied: { label: "denied", tip: "Denied by you." },
    skipped: { label: "skipped", tip: "No prompt needed — the target didn't resolve (no element / stale @pt / bad selector), so the action could only fail. It never ran." },
} as const;
const ApprovalBadge = ({ approval }: { approval: keyof typeof APPROVAL }) => (
    <span class={`tt appr-badge appr-${approval}`}>
        <span class={`appr ${approval === "denied" ? "no" : approval === "skipped" ? "skip" : "yes"}`}>{APPROVAL[approval].label}</span>
        <span class="tt-pop left" role="tooltip">{APPROVAL[approval].tip}</span>
    </span>
);

// A Google Docs-style smart chip for a Google Sheet reference: an icon + a friendly label instead of
// the raw 44-char id, hoverable for the full id, opening the sheet on click. Reused in the approval
// note and the python-in source label. (The real sheet TITLE would need a fetch; "Google Sheet" is the
// friendly stand-in — the loaded df already carries the model's own variable name beside it.)
const sheetTitleCache = new Map<string, string | null>();   // id → title (fetched once per session)
function SheetChip({ id, label }: { id: string; label?: string }) {
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

// The distinct EXTERNAL Google Sheet ids a python_exec call will load — read from the ARGS (`tables`),
// NOT the rendered In: at approval time the tables aren't fetched yet (the pre-run preview is code-only),
// so the render has no sheet source. Approving grants the run those spreadsheets for the rest of the
// page-session, so the gate discloses it. Same detection as the background's escalation (externalSheetIds).
function externalSheetGrant(args?: Record<string, unknown>): string[] {
    return args ? [...new Set(externalSheetIds(args))] : [];
}

function ToolStep({ st, hash }: { st: AgentStep; hash?: string }) {
    const [expanded, setExpanded] = useState(false);
    const [decided, setDecided] = useState(false);   // hide the controls the instant we click (before the DONE lands)
    const args = st.arguments && Object.keys(st.arguments).length ? st.arguments : null;
    // The tool's own short human-friendly summary (contract MlTool.summary), from the run's tool defs.
    const toolSummary = hash ? sessionMap.get(hash)?.agentConfig?.tools?.find(t => t.name === st.tool)?.summary : undefined;
    // Each slot renders from its own descriptor; the block falls back to raw when absent.
    const inRender = st.renderIn;
    const outRender = st.renderOut;
    const issues = st.argIssues?.length ? st.argIssues : null;
    // Design A: a background-hosted call blocked on the human gate. Render approve/deny here — the
    // decision is made in this (extension-origin) iframe, unforgeable by the page. Needs the run hash +
    // the step seq to correlate; without them (a page-loop run) fall back to the plain pending view.
    const awaiting = !!(st.awaitingApproval && st.pending && !decided && hash && st.seq != null);
    // A pending approval AUTO-UNFURLS the In so you review the call before deciding (no extra click).
    const open = expanded || awaiting;
    // Keep the step expanded after you decide (setExpanded), so it doesn't collapse when `awaiting`
    // clears — you see the Out result fill in on the same open cell.
    const decide = (ok: boolean) => {
        setExpanded(true); setDecided(true);
        if (hash && st.seq != null) decidedSteps.add(stepKey(hash, st.seq));
        sendApproval(hash!, st.seq!, ok);
        rev.value++;   // re-render the run footer so it drops "waiting for your approval" at once
    };
    // When a step starts awaiting approval, scroll it into view so a gate mid-run isn't missed.
    const approveRef = useRef<HTMLDivElement>(null);
    // Reveal a new approval prompt ONLY when the user has scrolled up to read — if they're parked at
    // the bottom, App's stick-to-bottom pins to the true bottom (this scrollIntoView would fight it:
    // block:"nearest" lands shy of the bottom AND its scroll event flips `atBottom` false, defeating
    // the pin so the post-approval Out no longer sticks).
    useEffect(() => { if (awaiting && !atBottom.v) approveRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }); }, [awaiting]);
    // Consent scope: approving a python_exec that loads an EXTERNAL Google Sheet caches that
    // spreadsheet for the rest of the page-session (later calls to it won't re-prompt). Tell the
    // human the approval is a session-scoped grant, not a one-shot.
    const sheetGrants = awaiting ? externalSheetGrant(st.arguments) : [];
    return (
        <div class={`astep tool${open ? " open" : ""}${st.pending ? " pending" : ""}${awaiting ? " awaiting" : ""}${st.approval ? (st.approval === "denied" ? " appr-no" : st.approval === "skipped" ? " appr-skip" : " appr-yes") : ""}`}>
            <button class="astep-head" onClick={() => setExpanded(v => !v)}>
                <span class={`tri${open ? " open" : ""}`} aria-hidden="true"><IconChevron /></span>
                <Dot status={st.pending ? "pending" : toolFailed(st.result) ? "err" : "ok"} />
                {/* Tool-authored short summary (contract MlTool.summary) → hover tooltip, both surfaces. */}
                {toolSummary
                    ? <span class="tt tool-name-wrap"><span class="tool-name">{st.tool}</span><span class="tt-pop left" role="tooltip">{toolSummary}</span></span>
                    : <span class="tool-name">{st.tool}</span>}
                {st.approval ? <ApprovalBadge approval={st.approval} /> : null}
                {st.elements ? <span class="tt el-count">{st.elements} el<span class="tt-pop wrap" role="tooltip">DOM nodes returned (reach them in the console via onStep).</span></span> : null}
                {issues ? <span class="arg-warn" title={issues.join("; ")}><IconWarn />{issues.length}</span> : null}
                {!open ? <span class="astep-preview">{awaiting ? <span class="dim">needs approval</span> : st.pending ? <span class="dim">running…</span> : collapsedPreview(st.result || "").text}</span> : null}
            </button>
            {open
                ? <div class="astep-body">
                    {issues ? <div class="tt tt-row arg-issues"><IconWarn /><span>arg schema: {issues.join("; ")}</span><span class="tt-pop wrap left" role="tooltip">The args don't match this tool's parameter schema.</span></div> : null}
                    {args || inRender
                        ? <IoBlock label="In" tip="The arguments the model passed to this tool call."
                            preview={inlineJson(args || {})} render={inRender} raw={<Code text={pretty(args || {})} lang="json" />} />
                        : null}
                    <IoBlock label="Out" tip="What the tool returned to the model."
                        preview={st.pending ? "running…" : inlineText(st.result || "")} render={outRender}
                        raw={st.result ? <Code text={st.result} lang="text" /> : <span class="dim">{st.pending ? "running…" : "(no output)"}</span>} />
                </div>
                : null}
            {/* On-demand plain-English gloss for a code step — CARD's Show-work trace only (the debug panel
                keeps the raw code); needs a utility model. Lives UNDER the (collapsed) step, not inside the
                expand, so you can annotate a call without opening its whole In/Out. */}
            {surface.value === "card" && (st.tool === "exec" || st.tool === "python_exec") && hash && st.seq != null && !st.pending && config.value.utilityModel.trim()
                ? <CodeExplain hash={hash} seq={st.seq} lang={st.tool === "python_exec" ? "python" : "javascript"} code={codeOf(st)?.text || ""} result={st.result} />
                : null}
            {/* Approval bar at the BOTTOM — after In/Out — so you review the call (its rendered In)
                before the approve/deny controls, and it reads as the last thing to act on. */}
            {awaiting
                ? <div class="astep-approve" ref={approveRef}>
                    {sheetGrants.length
                        ? <div class="appr-note"><IconWarn /><span>Approving grants this run access to {sheetGrants.map((id, i) => <SheetChip key={i} id={id} />)} for the rest of this session — later calls to {sheetGrants.length === 1 ? "it" : "them"} won't re-prompt.</span></div>
                        : null}
                    <div class="appr-row">
                        <span class="appr-ask">Approve running <b>{st.tool}</b>?</span>
                        <span class="sp" />
                        <button class="appr-btn no" onClick={() => decide(false)}>Deny</button>
                        <button class="appr-btn yes" onClick={() => decide(true)}>Approve</button>
                    </div>
                </div>
                : null}
        </div>
    );
}

// A turn's PROSE (content) — what the model SAYS this step. Rendered like the final answer: plain
// markdown, EXPANDED by default, no status dot / "thought" label / box. Collapsible via a subtle
// chevron (→ a one-line preview), same affordance the answer bubble uses.
function TurnProse({ text }: { text: string }) {
    const [collapsed, setCollapsed] = useState(false);
    const p = collapsedPreview(text);
    return (
        <div class={`aturn-prose${collapsed ? " collapsed" : ""}`}>
            <button class="who-toggle prose-tri" title={collapsed ? "expand" : "collapse"} onClick={() => setCollapsed(v => !v)}>
                <span class={`tri${collapsed ? "" : " open"}`} aria-hidden="true"><IconChevron /></span>
            </button>
            {collapsed
                ? <span class="asst-collapsed" onClick={() => setCollapsed(false)}>{p.text}{p.more ? " …" : ""}</span>
                : <div class="md" dangerouslySetInnerHTML={{ __html: markdown(text, { math: true }) }} />}
        </div>
    );
}
// One turn = the pill + the thinking + the prose + the tool calls it batched.
function AgentTurn({ turn, max, hash }: { turn: AgentTurnGroup; max?: number; hash?: string }) {
    return (
        <div class="aturn">
            <div class="aturn-head"><StepPill step={turn.localStep} max={max} /></div>
            {turn.reasoning ? <ThoughtBlock thought={turn.reasoning} /> : null}
            {turn.thought ? <TurnProse text={turn.thought} /> : null}
            {turn.tools.map((st, i) => <ToolStep key={`${st.tool}-${i}`} st={st} hash={hash} />)}
        </div>
    );
}

// The agent run's setup (model, maxSteps, tools, env/vision/hints, + the resolved
// system prompt) — a collapsed block at the top, the agent analogue of chat's
// OptionsBlock.
// A zero-dep collapsible JSON tree (DevTools-console style): objects/arrays fold with a one-line
// preview, primitives render inline + typed. Used to inspect the agent's full tool definitions.
function jtPreview(v: object): string {
    if (Array.isArray(v)) return v.length ? `[ ${v.length} item${v.length === 1 ? "" : "s"} ]` : "[ ]";
    const keys = Object.keys(v);
    if (!keys.length) return "{ }";
    return `{ ${keys.slice(0, 4).join(", ")}${keys.length > 4 ? ", …" : ""} }`;
}
function JsonNode({ k, v, depth = 0, defaultOpen }: { k?: string; v: unknown; depth?: number; defaultOpen?: boolean }) {
    const branch = !!v && typeof v === "object";
    const [open, setOpen] = useState(defaultOpen ?? depth < 1);
    const pad = { paddingLeft: `${depth * 13}px` };
    if (!branch) {
        const t = v === null ? "null" : typeof v;
        return <div class="jt-row" style={pad}>
            {k != null ? <span class="jt-key">{k}:</span> : null}
            <span class={`jt-val jt-${t}`}>{typeof v === "string" ? JSON.stringify(v) : String(v)}</span>
        </div>;
    }
    const arr = Array.isArray(v);
    const entries: [string, unknown][] = arr
        ? (v as unknown[]).map((x, i) => [String(i), x])
        : Object.entries(v as Record<string, unknown>);
    return <div class="jt-node">
        <div class="jt-row jt-branch" style={pad} role="button" onClick={() => setOpen(o => !o)}>
            <span class={`tri${open ? " open" : ""}`} aria-hidden="true"><IconChevron /></span>
            {k != null ? <span class="jt-key">{k}:</span> : null}
            {open ? <span class="jt-brace">{arr ? "[" : "{"}</span> : <span class="jt-preview">{jtPreview(v as object)}</span>}
        </div>
        {open ? <>
            {entries.map(([ek, ev]) => <JsonNode key={ek} k={arr ? undefined : ek} v={ev} depth={depth + 1} />)}
            <div class="jt-row" style={pad}><span class="jt-brace">{arr ? "]" : "}"}</span></div>
        </> : null}
    </div>;
}
// The agent's full tool definitions — name, approval/vision badges, description, and a JSON tree of
// the parameter schema the model actually sees. Older debug events carry names only; those degrade
// to just the head + description (no tree), since parameters weren't plumbed through then.
function ToolDefCard({ t }: { t: DebugAgentConfig["tools"][number] }) {
    const [open, setOpen] = useState(false);   // collapsed → just the tool name + badges
    const hasBody = !!(t.description || t.parameters);
    return <div class="tooldef">
        <div class={`tooldef-head${hasBody ? " clickable" : ""}`} role={hasBody ? "button" : undefined} onClick={hasBody ? () => setOpen(v => !v) : undefined}>
            {hasBody ? <span class={`tri${open ? " open" : ""}`} aria-hidden="true"><IconChevron /></span> : null}
            <b class="tooldef-name">{t.name}</b>
            {t.requiresApproval ? <span class="tt tooldef-warn"><IconWarn /><span class="tt-pop wrap left" role="tooltip">Calling this tool requires your approval.</span></span> : null}
            {t.vision ? <span class="tt tooldef-badge">vision<span class="tt-pop wrap left" role="tooltip">A vision tool — it sends a screenshot to a vision-capable model (the agent's own model if it sees, else the OCR/vision reader). Only wired when such a model resolves.</span></span> : null}
        </div>
        {open ? <>
            {t.description ? <div class="tooldef-desc md" dangerouslySetInnerHTML={{ __html: markdown(t.description) }} /> : null}
            {t.parameters ? <div class="tooldef-params"><JsonNode k="parameters" v={t.parameters} defaultOpen={false} /></div> : null}
        </> : null}
    </div>;
}
function ToolDefsView({ tools }: { tools: DebugAgentConfig["tools"] }) {
    return <div class="tooldefs">{tools.map((t, i) => <ToolDefCard key={i} t={t} />)}</div>;
}

function AgentOptionsBlock({ s }: { s: Session }) {
    const c = s.agentConfig;
    const [open, setOpen] = useState(false);
    const [showSys, setShowSys] = useState(false);
    const [showTools, setShowTools] = useState(false);
    if (!c) return null;
    // The full defs (description + parameter schema) are only in newer events; older ones carry names
    // only, so the "show tool defs" viewer would just repeat the summary line — hide it then.
    const hasToolDefs = c.tools.some(t => t.description || t.parameters);
    const lines = [`model: ${s.model || "default"}`, `maxSteps: ${c.maxSteps}`];
    if (c.think != null) lines.push(`think: ${c.think}`);
    if (!c.env) lines.push("env: false");
    if (c.vision != null && c.vision !== true) lines.push(`vision: ${JSON.stringify(c.vision)}`);
    if (c.hints) lines.push(`hints: ${truncate(c.hints, 140)}`);
    // The full-defs viewer below lists every tool; only fall back to a one-line names summary when
    // those defs aren't available (older events), so the two don't duplicate.
    if (!hasToolDefs) lines.push(`tools (${c.tools.length}): ${c.tools.map(t => t.name + (t.requiresApproval ? " ⚠" : "")).join(", ")}`);
    // Vision wasn't disabled, yet nothing vision-capable got wired → no reader
    // resolved, so look/locate silently aren't available. Flag it.
    const noVision = c.vision !== false && !c.tools.some(t => t.vision);
    return (
        <div class="block agent-opts">
            <div class="block-head" role="button" onClick={() => setOpen(v => !v)}>
                <span class={`tri${open ? " open" : ""}`} aria-hidden="true"><IconChevron /></span>
                <span class="block-label">agent options</span>
                {noVision ? <span class="tt arg-warn"><IconWarn />no vision<span class="tt-pop wrap left" role="tooltip">No vision-capable model resolved (agent model → OCR model). The look and locate tools aren't available this run; set an OCR/vision model in Settings → Models.</span></span> : null}
            </div>
            {open
                ? <div class="tbody">
                    {noVision ? <div class="tt tt-row arg-issues"><IconWarn /><span>visual tools unavailable — no vision model (set an OCR/vision model in Settings → Models)</span><span class="tt-pop wrap left" role="tooltip">ml.agent couldn't resolve a vision reader, so look/locate weren't wired.</span></div> : null}
                    <pre class="opts">{lines.join("\n")}</pre>
                    <div class="sys-block">
                        <button class="raw-btn" onClick={() => setShowSys(v => !v)}>{showSys ? "hide" : "show"} system prompt{c.customSystem ? " (custom)" : ""}</button>
                        {showSys ? <Code text={c.system} lang="markdown" /> : null}
                    </div>
                    {hasToolDefs
                        ? <div class="sys-block">
                            <button class="raw-btn" onClick={() => setShowTools(v => !v)}>{showTools ? "hide" : "show"} tool definitions ({c.tools.length})</button>
                            {showTools ? <ToolDefsView tools={c.tools} /> : null}
                        </div>
                        : null}
                </div>
                : null}
        </div>
    );
}

// A user message in the conversation — the initial task, a follow-up run()'s task, or a mid-run say().
// All identical: from the chat's point of view there's nothing to distinguish them (they're all "you").
const UserBubble = ({ text, ts }: { text: string; ts: number }) => (
    <div class="msg user">
        <div class="mrow"><span class="who">you</span><span class="sp" /><Stamp ts={ts} /></div>
        <div class="utext">{text}</div>
    </div>
);

function AgentRunView({ s }: { s: Session }) {
    // Skip an empty step group — one carrying only a usage sample (final-answer token counts), no
    // thought/reasoning/tool. KEEP a reasoning-only turn (the final-answer turn shows its thinking here).
    const groups = groupTurns(s.steps || []).filter(t => t.thought || t.reasoning || t.tools.length);
    // The whole session is a CHAT LOG: user messages (task + follow-ups + says) and answers interleaved
    // with the turn step-groups, ordered by step position. `atStep + fraction` slots an answer just after
    // its turn's steps, and a following user message just after that.
    const answer = (a: NonNullable<Session["answers"]>[number], key: string) =>
        a.error
            ? <ReplyBubble key={key} content="" status="err" model={s.model} profile={sessionProfile(s)} ts={a.ts} error={a.error} label="run failed" />
            : <ReplyBubble key={key} content={a.text} status={a.status} model={s.model} profile={sessionProfile(s)} ts={a.ts}
                label={a.cancelled ? "cancelled" : a.hitCap ? "stopped (step cap)" : undefined} capped={a.hitCap || a.cancelled} />;
    const items: { pos: number; el: preact.JSX.Element }[] = [
        { pos: -1, el: <UserBubble key="task" text={s.task || ""} ts={s.createdTs} /> },
        ...groups.map(g => ({ pos: g.step, el: <AgentTurn key={`t${g.step}`} turn={g} max={s.maxSteps} hash={s.hash} /> })),
        ...(s.answers || []).map((a, i) => ({ pos: a.atStep + 0.5, el: answer(a, `a${i}`) })),
        ...(s.says || []).map((sy, i) => ({ pos: sy.atStep + 0.9, el: <UserBubble key={`s${i}`} text={sy.text} ts={sy.ts} /> })),
    ].sort((a, b) => a.pos - b.pos);
    return (
        <>
            <AgentOptionsBlock s={s} />
            {items.map(it => it.el)}
            {s.status === "pending" ? <PendingNote s={s} /> : null}
        </>
    );
}

// The live footer of a running agent. Its bar is a browser-native motif — the thin indeterminate
// "page is loading" sweep an SPA shows on navigation — so an active run reads as the browser working.
// When the run is BLOCKED on your approval it swaps to a breathing amber bar (no forward motion) +
// "waiting…", so paused-needs-you vs actively-running is legible at a glance from colour + motion.
function PendingNote({ s }: { s: Session }) {
    // Blocked = a step is still awaiting the gate AND you haven't decided it yet (decidedSteps flips
    // the instant you click, before the tool's DONE event clears awaitingApproval).
    const blocked = (s.steps || []).some(st => st.pending && st.awaitingApproval && !(st.seq != null && decidedSteps.has(stepKey(s.hash, st.seq))));
    const n = turnsRun(s.steps);
    return (
        <div class={`pending-note${blocked ? " blocked" : ""}`}>
            <div class="pbar" aria-hidden="true"><span /></div>
            <span class="ptext">{blocked ? "waiting for your approval…" : `running · ${n} ${n === 1 ? "step" : "steps"}`}</span>
        </div>
    );
}

function ListView() {
    // `r` subscribes this view to session changes AND resolving model/profile
    // here (reads config) keeps that signal read out of SessionRow. Retained in
    // data-rev so the subscription survives minification.
    const r = rev.value;
    const list = [...sessionMap.values()].sort((a, b) => b.lastTs - a.lastTs);
    if (!list.length) return <div class="empty" data-rev={r}>No ml calls yet. Run one in the console.</div>;
    return <div class="list" data-rev={r}>{list.map(s => <SessionRow key={s.hash} s={s} profile={sessionProfile(s)} />)}</div>;
}

function DetailView({ hash }: { hash: string }) {
    // Re-renders via App's rev subscription (App cascades to this pure component);
    // turn updates are immutable (see onDebug) so children re-render too.
    const s = sessionMap.get(hash);
    if (!s) return <div class="empty">Session not found.</div>;
    if (s.kind === "agent") return <AgentRunView s={s} />;
    return <><OptionsBlock s={s} />{s.turns.map(t => <MessageTurn key={t.id} t={t} />)}</>;
}

// Fetch the server's model list via the background worker (privileged fetch);
// degrade silently if unreachable. Populates the datalists.
function fetchModels(): void {
    chrome.runtime.sendMessage({ type: "LIST_MODELS", payload: {} }, (resp: any) => {
        if (chrome.runtime.lastError || !resp || resp.error) return;
        models.value = resp.data || [];
        ollamaIds.value = resp.ollamaModels ?? null;   // null = provenance unknown (skip cloud detection)
    });
}


// --- VRAM monitor ---
const VRAM_COLORS = ["#6366f1", "#22c55e", "#f59e0b", "#ec4899", "#06b6d4", "#a855f7", "#ef4444", "#84cc16"];
const colorFor = (name: string) => VRAM_COLORS[[...name].reduce((a, c) => a + c.charCodeAt(0), 0) % VRAM_COLORS.length];
const VRAM_HISTORY = 45, VRAM_POLL_MS = 2000;
const normModel = (m: string) => m.replace(/:latest$/, "");
// The context window we last OBSERVED each model loaded with (from /api/ps). A
// model's window is a property of the model, not of whether it's resident right now
// — so the usage gauge keeps measuring occupancy after the model is evicted from
// VRAM instead of flipping to a different metric. Overwritten every poll, so a
// mid-run reload at a new num_ctx is picked up; live-resident always wins, this is
// only the fallback while evicted (last-observed — can be stale, which is fine).
const seenContext = new Map<string, number>();
// Models the user has hidden from the totals/graph (session-only; a signal so it
// survives VramPanel remounts). Immutable Set updates so the signal notifies.
const hiddenModels = signal<Set<string>>(new Set());
const toggleHidden = (model: string): void => {
    const next = new Set(hiddenModels.value);
    next.has(model) ? next.delete(model) : next.add(model);
    hiddenModels.value = next;
};

// Poll Ollama's resident-model set (/api/ps) into the shared signals, for BOTH
// the VRAM panel and the header status dot. Gated so it never hammers Ollama in
// the background: only while the shell is slid open AND something needs it (the
// panel is up, or a detail header — the only place a status dot shows).
function pollPs(): void {
    if (!sidebarOpen.value) return;
    if (!vramOpen.value && view.value.name !== "detail") return;
    chrome.runtime.sendMessage({ type: "OLLAMA_PS", payload: {} }, (resp: any) => {
        if (chrome.runtime.lastError || (resp && resp.error)) {
            psError.value = (resp && resp.error) || chrome.runtime.lastError?.message || "unavailable";
            loadedModels.value = []; return;
        }
        psError.value = null;
        const loaded = resp.data || [];
        // Remember each resident model's window (overwrite → tracks a mid-run reload).
        for (const m of loaded) if (typeof m.contextLength === "number") seenContext.set(normModel(m.model), m.contextLength);
        loadedModels.value = loaded;
    });
}

// "expires in Xs/Xm" from an /api/ps expires_at ISO stamp (Ollama's TTL).
function expiresIn(expiresAt: string | null): string | null {
    if (!expiresAt) return null;
    const ms = new Date(expiresAt).getTime() - Date.now();
    if (isNaN(ms) || ms <= 0) return null;
    const s = Math.round(ms / 1000);
    return s < 90 ? `expires in ${s}s` : `expires in ${Math.round(s / 60)}m`;
}

// Live model-load state for the header's "responds-next" model, from /api/ps
// (resident) + the installed list + our own in-flight flag. Five states, detail
// in the tooltip (see SIDEBAR_UI_FEEDBACK.md). Reads signals directly so it
// updates on each poll; model/inFlight arrive as plain props.
type LoadState = "loaded" | "cold" | "inflight" | "unavailable" | "cloud" | "unknown";
function modelLoadState(model: string, inFlight: boolean): { state: LoadState; tip: string } {
    const ps = psError.value ? null : loadedModels.value;
    // Match the FULL tagged name (only normalising :latest). A base-name match
    // ("gemma4") picks the wrong variant when a family has several tags loaded
    // — e.g. gemma4:31b would grab gemma4:e2b's (CPU, no-VRAM) row.
    const norm = (m: string) => m.replace(/:latest$/, "");
    const resident = ps?.find(m => m.model === model || norm(m.model) === norm(model)) || null;
    if (inFlight) return { state: "inflight", tip: resident ? "Generating a response…" : "Loading the model into VRAM…" };
    if (psError.value) return { state: "unknown", tip: "Load state unknown — no Ollama backend responding." };
    if (ps == null) return { state: "unknown", tip: "Checking load state…" };
    if (resident) {
        // size_vram (vramGB) vs size (sizeGB) → fully-CPU / partial-offload / full-GPU.
        const v = resident.vramGB, sz = resident.sizeGB;
        const where = !v
            ? (sz ? `on CPU (${sz} GB RAM)` : "on CPU (RAM)")
            : (sz && v < sz - 0.1 ? `${v} of ${sz} GB in VRAM — partial CPU offload (slower)` : `${v} GB VRAM`);
        const bits = [where, expiresIn(resident.expiresAt)].filter(Boolean);
        return { state: "loaded", tip: `Loaded — ${bits.join(" · ")}.` };
    }
    // Not resident. An external (non-Ollama) model has no local load state at all.
    const listed = models.value.includes(model);
    const ollama = ollamaIds.value;   // null = provenance unknown → don't guess cloud
    if (ollama && listed && !ollama.includes(model))
        return { state: "cloud", tip: "External API model — runs remotely; no local VRAM or load state." };
    if (listed) return { state: "cold", tip: "Idle — installed but not resident; loads on next use." };
    if (models.value.length) return { state: "unavailable", tip: "Unavailable — the server doesn't list this model (not installed?)." };
    return { state: "unknown", tip: "Load state unknown." };
}

// --- Context-usage gauge (composer footer) ---
// Current context OCCUPANCY for a session = the LATEST turn's / step's usage
// (prompt + completion), NOT a sum: every call re-sends the whole history, so the
// last call's prompt already contains all prior turns. Summing would double-count
// that shared prefix N times over. Returns null when no counts were reported.
function sessionOccupancy(s: Session): number | null {
    const usages: TokenUsage[] = s.kind === "agent"
        ? (s.steps || []).map(st => st.usage).filter((u): u is TokenUsage => !!u)
        : s.turns.map(t => t.usage).filter((u): u is TokenUsage => !!u);
    if (!usages.length) return null;
    const last = usages[usages.length - 1];
    return last.promptTokens + last.completionTokens;
}

// The context window the session's model was LOADED with, matched by full tagged
// name: the LIVE resident window (/api/ps) if it's loaded now, else the last window
// we observed it at (seenContext) — a model's window is a property of the model, so
// an evicted-but-previously-seen model keeps its denominator. null only when we've
// genuinely never seen it (a true cloud model) → the gauge shows a raw token count.
function sessionContextLimit(model: string | null): number | null {
    if (!model) return null;
    const ps = psError.value ? null : loadedModels.value;
    const resident = ps?.find(m => m.model === model || normModel(m.model) === normModel(model));
    return resident?.contextLength ?? seenContext.get(normModel(model)) ?? null;
}

// Green → amber → red as the window fills. Interpolated in hue so it eases rather
// than jumping at thresholds (a full context = truncation, the thing to warn about).
function usageHue(frac: number): string {
    const f = Math.max(0, Math.min(1, frac));
    const hue = 130 - 130 * f;   // 130 (green) → 0 (red), amber ~65 in the middle
    return `hsl(${Math.round(hue)}, 72%, 45%)`;
}

function UsageBar({ s }: { s: Session }) {
    const occupancy = sessionOccupancy(s);
    if (occupancy == null) return null;   // nothing to show until the server reports counts
    // Use the RESOLVED model (what the header shows), not s.model — a "default"
    // session has s.model === null (the caller named no model), but the reply
    // resolved to a real, often-resident model whose window we CAN measure against.
    const model = shownModel(s);
    const limit = sessionContextLimit(model);
    // The NUMERATOR is the same either way (occupancy) — only the denominator/% comes
    // and goes with whether we know the window, so the number never jumps.
    if (limit) {
        const frac = occupancy / limit;
        const pct = Math.round(frac * 100);
        return (
            <span class="tt usage-gauge">
                <span class="usage-ic" aria-hidden="true"><IconUsage /></span>
                <span class="usage-track"><span class="usage-fill" style={{ width: `${Math.min(100, frac * 100).toFixed(1)}%`, background: usageHue(frac) }} /></span>
                <span class="usage-pct">{pct}%</span>
                <span class="tt-pop wrap above" role="tooltip">
                    Context: {occupancy.toLocaleString()} / {limit.toLocaleString()} tokens ({pct}%).
                    This is the live window occupancy — every turn re-sends the whole history. Near 100% the model starts truncating.
                </span>
            </span>
        );
    }
    // Window unknown (a model we've never seen resident — a true cloud model): show the
    // raw occupancy, no %/bar. Same number as above, just no denominator to divide by.
    return (
        <span class="tt usage-gauge">
            <span class="usage-ic" aria-hidden="true"><IconUsage /></span>
            <span class="usage-total">{fmtCtx(occupancy)} tok</span>
            <span class="tt-pop wrap above" role="tooltip">
                {occupancy.toLocaleString()} tokens in context (latest turn). No context limit is known for this model{model ? ` ("${model}")` : ""} — it's never been resident in Ollama (a cloud model?), so there's no window size to show a % against.
            </span>
        </span>
    );
}

// The session composer: drive a live createAgent session from the sidebar. Sending routes to the page
// (via the parent shell/panel) → the handle by hash: STEER a running loop (say) or start a new turn (run),
// the page deciding from the handle's live state. Claude-Code touch: while a run is IN FLIGHT and the box
// is EMPTY, the submit button becomes a STOP that cancels; type anything and it's a send again.
function Composer({ s }: { s: Session }) {
    const r = rev.value;   // subscribe: `s.status` is mutated in place (same ref), so without a signal read this
                           // stateful child won't re-render when the run goes pending/idle → the Stop button.
    const [text, setText] = useState("");
    // Every session is continuable: an AGENT session has a steerable handle in the page's registry
    // (say/run/cancel); a plain CHAT session continues via its history in the session registry (a fresh turn,
    // or the in-flight fetch aborted). The page routes `sessionSend`/`sessionCancel` to whichever it is.
    const agent = s.kind === "agent";
    const running = s.status === "pending";
    const empty = !text.trim();
    const stop = running && empty;   // in-flight + empty box → the button cancels the run/turn (Claude-Code style)
    const cancel = () => window.parent.postMessage({ __mlSidebarApp: "sessionCancel", hash: s.hash }, "*");
    const send = () => {
        const t = text.trim();
        if (!t) return;
        window.parent.postMessage({ __mlSidebarApp: "sessionSend", hash: s.hash, text: t }, "*");
        setText("");
    };
    const act = () => (stop ? cancel() : send());
    const onKey = (e: KeyboardEvent) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); act(); } };
    const placeholder = running ? (agent ? "Steer this run, or send to queue a follow-up…" : "Sending… or stop this turn")
        : "Send a message to continue this session…";
    return (
        <div class="composer" data-rev={r}>
            <div class="composer-row">
                <button class="tt cbtn" disabled aria-label="Upload an image">＋<span class="tt-pop left above" role="tooltip">Attach an image — coming soon (you'll be able to paste screenshots here)</span></button>
                <input class="cinput" type="text" value={text} onInput={e => setText((e.target as HTMLInputElement).value)} onKeyDown={onKey}
                    placeholder={placeholder} />
                <button class={`tt cbtn ${stop ? "cstop" : "csend"}`} onClick={act} disabled={!stop && empty} aria-label={stop ? "Stop the run" : "Send"}>
                    {stop ? <IconStop /> : <IconSend />}<span class="tt-pop above" role="tooltip">{stop ? "Stop (cancel)" : running ? "Steer the run" : "Send"}</span>
                </button>
            </div>
            <div class="composer-foot">
                <span class="sp" />
                <UsageBar s={s} />
            </div>
        </div>
    );
}

function ModelStatusDot({ model, inFlight }: { model: string; inFlight: boolean }) {
    const { state, tip } = modelLoadState(model, inFlight);
    return (
        <span class="tt">
            <span class={`dot ${state}`} />
            <span class="tt-pop left" role="tooltip">{tip}</span>
        </span>
    );
}

// Live VRAM: a sparkline of total usage over time + a per-model legend with
// evict controls. Reads the shared OLLAMA_PS signals (polled at App level while
// the sidebar is open) and accumulates the sparkline history locally.
function VramPanel() {
    const loaded = loadedModels.value;
    const hidden = hiddenModels.value;
    const err = psError.value;
    // Per-model snapshots (not pre-summed totals) so hiding/showing a model
    // redraws the WHOLE line against the current visibility set, not just new
    // points. (This is also the per-model VRAM log panel-v2 will build on.)
    const [history, setHistory] = useState<Record<string, number>[]>([]);
    const sumVisible = (snap: Record<string, number>) =>
        Object.entries(snap).reduce((s, [m, v]) => s + (hidden.has(m) ? 0 : v), 0);
    useEffect(() => { pollPs(); }, []);   // immediate poll on open (don't wait for the interval)
    useEffect(() => {
        if (!loaded) return;
        const snap: Record<string, number> = {};
        for (const m of loaded) snap[m.model] = m.vramGB || 0;
        setHistory(h => [...h, snap].slice(-VRAM_HISTORY));
    }, [loaded]);

    const evict = (model?: string) =>
        chrome.runtime.sendMessage({ type: "OLLAMA_UNLOAD", payload: model ? { model } : {} }, () => pollPs());

    if (err) return <div class="vram"><div class="vram-empty">VRAM unavailable — no Ollama backend.</div></div>;

    // Total is the CURRENT visible resident set — read it straight from `loaded`,
    // not the sparkline history (which lags a render and resets to 0 on reopen).
    const total = loaded ? loaded.reduce((s, m) => s + (hidden.has(m.model) ? 0 : (m.vramGB || 0)), 0) : 0;
    // Stable order so rows don't reshuffle as models load/evict.
    const rows = loaded ? [...loaded].sort((a, b) => a.model.localeCompare(b.model)) : [];
    // Recompute every point's visible-total each render, so toggling redraws the
    // full line retroactively (not just going forward).
    const series = history.map(sumVisible);
    const W = 240, H = 34;
    const yMax = Math.max(1, ...series) * 1.15;
    const pts = series.length > 1
        ? series.map((v, i) => `${((i / (series.length - 1)) * W).toFixed(1)},${(H - (v / yMax) * H).toFixed(1)}`).join(" ")
        : "";
    return (
        <div class="vram">
            <div class="vram-head">
                <span class="vram-total">{total.toFixed(1)} GB in use</span>
                <span class="sp" />
                {rows.length ? <button class="vram-free" onClick={() => evict()}>Free VRAM</button> : null}
            </div>
            <svg class="vram-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
                {pts ? <polyline points={pts} fill="none" stroke="var(--accent)" stroke-width="1.5" /> : null}
            </svg>
            {rows.length
                ? rows.map(m => {
                    const off = hidden.has(m.model);
                    return (
                        <div class={`vram-row${off ? " off" : ""}`} key={m.model}>
                            <button class="vram-dot" style={{ background: off ? "var(--fg-faint)" : colorFor(m.model) }}
                                title={off ? "Show in totals" : "Hide from totals"} onClick={() => toggleHidden(m.model)} />
                            <span class="vram-name">{m.model}</span>
                            {m.contextLength ? (
                                <span class="tt vram-ctx">{fmtCtx(m.contextLength)}
                                    <span class="tt-pop left" role="tooltip">Loaded with a {m.contextLength.toLocaleString()}-token context window. Ollama preallocates the KV cache for the FULL window, even when your prompts are short. Load with a smaller <code>num_ctx</code> to reclaim it.</span>
                                </span>
                            ) : null}
                            <span class="sp" />
                            <span class="vram-gb">{m.vramGB != null ? `${m.vramGB} GB` : m.sizeGB != null ? `${m.sizeGB} GB (CPU)` : "?"}</span>
                            <button class="tt vram-x" aria-label="Evict from VRAM" onClick={() => evict(m.model)}>✕<span class="tt-pop" role="tooltip">Evict from VRAM</span></button>
                        </div>
                    );
                })
                : <div class="vram-empty">Nothing loaded.</div>}
        </div>
    );
}

// Export button + its format menu. Two shapes of the same log: a markdown bundle
// (for a coding assistant — screenshots as real .png sidecars) or a PDF via the
// print dialog (for a human). Dismissed by a pointerdown outside, or Escape.
function ExportMenu({ hash }: { hash: string }) {
    const [open, setOpen] = useState(false);
    const wrap = useRef<HTMLSpanElement>(null);
    useEffect(() => {
        if (!open) return;
        // A pointerdown inside the wrapper is the trigger's own (its onClick
        // toggles) or an item's (its onClick closes) — closing here too would
        // fight them, so ignore anything within.
        const onDown = (e: Event) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
        const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
        document.addEventListener("pointerdown", onDown);
        document.addEventListener("keydown", onKey);
        return () => { document.removeEventListener("pointerdown", onDown); document.removeEventListener("keydown", onKey); };
    }, [open]);
    const pick = (fn: (h: string) => void) => { setOpen(false); fn(hash); };
    return (
        <span class="menuwrap" ref={wrap}>
            <button class={`tt hbtn${open ? " on" : ""}`} aria-label="Export log" aria-haspopup="menu" aria-expanded={open}
                onClick={() => setOpen(o => !o)}>
                <IconExport />
                {open ? null : <span class="tt-pop" role="tooltip">Export log</span>}
            </button>
            {open ? (
                <div class="menu" role="menu">
                    <button class="menu-item" role="menuitem" onClick={() => pick(exportSession)}>
                        Markdown<span class="menu-hint">.zip with screenshots</span>
                    </button>
                    <button class="menu-item" role="menuitem" onClick={() => pick(printSession)}>
                        PDF<span class="menu-hint">opens the print dialog</span>
                    </button>
                </div>
            ) : null}
        </span>
    );
}

// Shape a raw PYTHON_EXEC response into a `python-out` descriptor for RenderPanel.
function pyBenchDescriptor(r: { ok: boolean; value?: unknown; stdout: string; error?: string; table?: { columns: string[]; rows: (string | number | null)[][] } }): RenderDescriptor {
    const stdout = r.stdout || undefined;
    if (!r.ok) return { type: "python-out", stdout, error: r.error || "error" };
    if (r.table) return { type: "python-out", stdout, df: r.table };   // a returned DataFrame → real table
    const v = r.value;
    if (typeof v === "string" && /^data:image\//.test(v)) return { type: "python-out", stdout, image: v };
    const value = v == null ? undefined : (typeof v === "string" ? v : JSON.stringify(v, null, 2));
    return { type: "python-out", stdout, value };
}
// A standalone Python workbench: run scripts against the SAME sandbox the python_exec tool uses
// (offscreen → worker → Pyodide) with a readonly/full mode selector, for debugging. Code-only — no
// page image/tables (the sidebar iframe can't screenshot the page). The sidebar already talks to the
// background directly (LIST_MODELS/OLLAMA_PS), so this is just one more message. Script + mode persist
// in localStorage so they survive navigation. A full-mode run here is USER-initiated in the trusted
// UI, so it just runs — no approval prompt (you are the approver).
// Guarded localStorage — the bench persists its script/mode there, but an opaque origin (jsdom, or a
// locked-down context) throws SecurityError on access, so degrade to no-persist instead of crashing.
const lsGet = (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k: string, v: string): void => { try { localStorage.setItem(k, v); } catch { /* opaque origin — skip */ } };
function PythonBench() {
    const [code, setCode] = useState(() => lsGet("ml_bench_code") ?? "import numpy as np\nreturn int(np.arange(10).sum())");
    const [mode, setMode] = useState<"readonly" | "full">(() => (lsGet("ml_bench_mode") === "full" ? "full" : "readonly"));
    const [running, setRunning] = useState(false);
    const [result, setResult] = useState<{ ok: boolean; value?: unknown; stdout: string; error?: string } | null>(null);
    const taRef = useRef<HTMLTextAreaElement>(null);
    const run = () => {
        if (running || !code.trim()) return;
        setRunning(true); setResult(null);
        lsSet("ml_bench_code", code); lsSet("ml_bench_mode", mode);
        try {
            chrome.runtime.sendMessage({ type: "PYTHON_EXEC", payload: { code, hardened: mode === "readonly", image: null, tables: null } },
                (resp: any) => {
                    // The background wraps the offscreen result: { data: PyResult } | { error }.
                    const r = resp?.data ?? (resp?.error ? { ok: false, stdout: "", error: resp.error } : null);
                    setResult(r || { ok: false, stdout: "", error: "No response from the sandbox." });
                    setRunning(false);
                });
        } catch (e) { setResult({ ok: false, stdout: "", error: String(e) }); setRunning(false); }
    };
    // Tab inserts spaces (don't escape the field); Cmd/Ctrl+Enter runs.
    const onKey = (e: KeyboardEvent) => {
        const ta = taRef.current;
        if (e.key === "Tab" && ta) {
            e.preventDefault();
            const s = ta.selectionStart, en = ta.selectionEnd;
            setCode(code.slice(0, s) + "    " + code.slice(en));
            requestAnimationFrame(() => { ta.selectionStart = ta.selectionEnd = s + 4; });
        } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); run(); }
    };
    const outD = result ? pyBenchDescriptor(result) : null;
    const empty = result?.ok && !result.stdout && result.value == null;
    return (
        <div class="bench">
            <textarea ref={taRef} class="bench-code code" spellcheck={false} value={code} onInput={e => setCode((e.target as HTMLTextAreaElement).value)} onKeyDown={onKey} placeholder="return 6 * 7" />
            <div class="bench-bar">
                <span class="tt bench-info" aria-label="about the bench">ⓘ<span class="tt-pop wrap left" role="tooltip">Runs against the SAME sandbox python_exec uses (offscreen → worker → Pyodide). Code-only — no page image/tables. `return` a value (or end with a bare expression, Jupyter-style); print() is captured. 15s cap.</span></span>
                <label class="bench-mode">mode
                    <select value={mode} onChange={e => setMode((e.target as HTMLSelectElement).value === "full" ? "full" : "readonly")}>
                        <option value="readonly">readonly (sandboxed)</option>
                        <option value="full">full (network)</option>
                    </select>
                </label>
                <span class="sp" />
                <span class="bench-kbd dim">⌘/Ctrl+↵</span>
                <button class="bench-run" disabled={running || !code.trim()} onClick={run}>{running ? "running…" : "Run"}</button>
            </div>
            {outD
                ? <div class="bench-out"><div class="io-label">Out:</div>{empty ? <span class="dim">(ran — no output, no return)</span> : <RenderPanel d={outD} />}</div>
                : running ? <div class="bench-out dim">running…</div> : null}
        </div>
    );
}

/* ------------------------------ off-mode card ----------------------------
 * The "card" surface. When debug is OFF but a privileged ml.agent run must be
 * gated, the run routes through the background and streams here into a small
 * acrylic corner CARD (mounted by the shell). It's a CURATED view of the SAME
 * session data — the approval to act on and the final answer — hiding the debug
 * detail (thinking, auto-approved steps, options, VRAM/polling). It reuses the
 * exact render components (ToolStep, ReplyBubble, markdown), so a decision here is
 * identical to the sidebar's and rides the same unforgeable SET_APPROVAL path
 * (this IS the extension iframe). The shell tells us we're the card via
 * `__mlSidebarSurface`; we tell the shell our size/reveal via `__mlSidebarCard`.
 */
// Which surface this app instance is (the shell posts it once, on our ready handshake).
const surface = signal<"panel" | "card">("panel");
const cardCollapsed = signal(false);         // user collapsed a FINISHED card down to a toast (default: show it)
const cardDismissed = signal<string>("");    // the run hash the user dismissed (closes a finished card)
// "Show work" open-state, keyed by the run's HASH (not a global boolean). A new run's hash won't match, so
// its trace is COLLAPSED by default with NO post-render reset — the reset-as-effect was why a fast/quiet run
// first painted with the PREVIOUS run's trace expanded (tall) then collapsed (the "opens huge then shrinks"
// glitch). "" = nothing open. Also naturally scopes to the active run once the card has tabs.
const cardShowWorkHash = signal<string>("");
const composerOpen = signal(false);          // the Spotlight composer — the HUD morphs into a task input
const composerMaxSteps = signal(20);         // step budget for a UI-started run (persists across opens)
const STEP_BUDGETS = [10, 20, 50];           // the segmented presets in the composer
const composerStarting = signal(0);          // timestamp: a UI run was sent, awaiting its first event (bridge pill)
const orbHover = signal(false);              // hovering the working orb → it stretches into a labelled capsule
const cardTitleTried = new Set<string>();

const latestAgentRun = (): Session | null => {
    let best: Session | null = null;
    for (const s of sessionMap.values()) if (s.kind === "agent" && (!best || s.lastTs > best.lastTs)) best = s;
    return best;
};
// A live, not-yet-decided approval gate (mirrors PendingNote's blocked check).
const isPendingGate = (hash: string, st: AgentStep): boolean =>
    !!(st.pending && st.awaitingApproval && !(st.seq != null && decidedSteps.has(stepKey(hash, st.seq))));

// Lazily summarise the run's task with the utility model (if configured) for the toast headline —
// the sidebar's title machinery, but ungated on sidebarOpen (irrelevant to the card).
function ensureCardTitle(s: Session): void {
    if (s.title || cardTitleTried.has(s.hash) || !utilitySummariesOn()) return;
    cardTitleTried.add(s.hash);
    genTitle(s.hash, s.task || "");
}

// Utility-model auto-summaries (card title, code/action approval summaries) are gated on BOTH a
// configured utility model AND the "summarise with the utility model" toggle (config.autoTitles).
const utilitySummariesOn = () => config.value.autoTitles && !!config.value.utilityModel.trim();

// Plain-English summary of a CODE approval's snippet, via the utility model — so the human reads "sums
// every quarter and finds the top rep" ABOVE the actual code (which still shows, as the consent
// surface). Keyed per step; opt-in on a utility model, best-effort (the code alone suffices without).
const codeSummaries = new Map<string, string>();
const codeSummaryTried = new Set<string>();
// The actual fetch — needs only a utility model (used directly by the on-demand "Explain" button in the
// Show-work trace, which the user explicitly clicked, so it isn't gated on the auto-summarise toggle).
// `output` (present only in the Show-work trace, where the code has ALREADY run) lets the gloss describe
// what it actually DID/found, not just what it would do — the approval-card path passes none (pre-run).
function fetchCodeSummary(hash: string, seq: number, lang: string, code: string, output?: string): void {
    if (!config.value.utilityModel.trim() || !code.trim()) return;
    const key = stepKey(hash, seq);
    if (codeSummaryTried.has(key)) return;
    codeSummaryTried.add(key);
    const messages = output && output.trim()
        ? [
            { role: "system", content: "You explain what a code snippet DID in ONE plain-English sentence (≤ 22 words) for a non-programmer, USING its output to say what it found/produced. State the effect and the result. No preamble, no code, no restating the language." },
            { role: "user", content: `Explain what this ${lang} code did.\n\nCode:\n${truncate(code, 1200)}\n\nOutput:\n${truncate(output, 400)}` },
        ]
        : [
            { role: "system", content: "You explain what a code snippet DOES in ONE plain-English sentence (≤ 22 words) for a non-programmer about to approve running it. State the effect and any data it touches. No preamble, no code, no restating the language." },
            { role: "user", content: `Explain what this ${lang} code does:\n\n${truncate(code, 1400)}` },
        ];
    fetchUtilityLine(messages, key);
}
// AUTO path (the approval card's gloss) — additionally gated on the auto-summarise toggle.
function ensureCodeSummary(hash: string, seq: number, lang: string, code: string): void {
    if (utilitySummariesOn()) fetchCodeSummary(hash, seq, lang, code);
}
// The on-demand "Explain this Python/JS" affordance in the Show-work trace (card surface only). Lazy —
// ONE utility-model call, only when clicked; shows the gloss inline once it lands.
function CodeExplain({ hash, seq, lang, code, result }: { hash: string; seq: number; lang: string; code: string; result?: string }) {
    const rv = rev.value;   // subscribe: the gloss lands on a rev bump (ToolStep is signal-memoized → won't); retained via data-rev
    const summary = codeSummaries.get(stepKey(hash, seq));
    if (summary) return <div class="step-explain ml-reveal" data-rev={rv}><span class="step-explain-ic" aria-hidden="true">💡</span><span>{summary}</span></div>;
    if (!code.trim()) return null;
    return <button class="step-explain-btn" data-rev={rv} onClick={() => fetchCodeSummary(hash, seq, lang, code, result)}>💡 Explain this {lang === "python" ? "Python" : "JavaScript"}</button>;
}
// A tool with NO deterministic intent (a custom approval-gated tool, no `action` render) still gets a
// human description — the utility model paraphrases the call. Same cache/plumbing as the code summary.
function ensureActionSummary(hash: string, seq: number, tool: string, args: Record<string, unknown>): void {
    if (!utilitySummariesOn() || !tool) return;
    const key = stepKey(hash, seq);
    if (codeSummaryTried.has(key)) return;
    codeSummaryTried.add(key);
    const messages = [
        { role: "system", content: "In ONE short plain-English sentence (≤ 18 words), tell a non-programmer what this tool call will DO, so they can approve it. State the effect. No preamble, no JSON, no tool name." },
        { role: "user", content: `Tool: ${tool}\nArguments: ${truncate(JSON.stringify(args ?? {}), 800)}` },
    ];
    fetchUtilityLine(messages, key);
}
// Shared: run a short utility-model call and store the one-line reply as the step's summary.
function fetchUtilityLine(messages: { role: string; content: string }[], key: string): void {
    chrome.runtime.sendMessage(
        { type: "FETCH_LLM", payload: { messages, extend: "utility", maxTokens: 70, think: false } },
        (resp: any) => {
            if (chrome.runtime.lastError || !resp || resp.error) return;
            const line = String(resp.data || "").trim().split("\n").map(s => s.trim()).filter(Boolean)[0] || "";
            const s = truncate(line.replace(/^["'`*]+|["'`*]+$/g, "").trim(), 160);
            if (s) { codeSummaries.set(key, s); rev.value++; }
        },
    );
}

// A pending call's INTENT: prefer the tool-provided `action` descriptor (deterministic; custom tools
// too), else a name-based verb for built-ins, else nothing (→ utility-model description).
const CODE_LANG: Record<string, string> = { exec: "javascript", python_exec: "python" };
interface Intent { verb: string; kind?: string; target?: string; selector?: string; input?: string; note?: string; submit?: boolean; }
function intentFor(st: AgentStep): Intent | null {
    // Whether a `type` will ALSO press Enter — a materially bigger action (it submits the form/search), so the
    // approval must call it out. Read from the raw args (the ground truth), regardless of the render path.
    const submit = st.tool === "type" ? !!st.arguments?.submit : undefined;
    const ri = st.renderIn;
    if (ri && ri.type === "action") return { verb: ri.verb, kind: ri.kind, target: ri.target, selector: ri.selector, input: ri.input, note: ri.note, submit };
    if (ri && ri.type === "elements" && ri.items[0])   // an older/other target render still gives a target + selector
        return { verb: st.tool === "click" ? "Click" : st.tool === "type" ? "Type" : `Run ${st.tool}`, target: ri.items[0].text || ri.items[0].path, selector: ri.items[0].path, submit };
    const sel = typeof st.arguments?.selector === "string" ? (st.arguments.selector as string) : undefined;
    if (st.tool === "click") return { verb: "Click", selector: sel };
    if (st.tool === "type") return { verb: "Type", selector: sel, input: String(st.arguments?.text ?? ""), submit };
    return null;
}
// For a CODE tool, the actual source — the consent surface (you can't approve code you can't see).
function codeOf(st: AgentStep): { text: string; lang: string } | null {
    const lang = CODE_LANG[st.tool || ""];
    if (!lang) return null;
    const ri = st.renderIn;
    if (ri && ri.type === "code" && typeof ri.text === "string") return { text: ri.text, lang };
    if (ri && ri.type === "python-in" && typeof ri.code === "string") return { text: ri.code, lang };
    const a = st.arguments || {};
    const src = typeof a.js === "string" ? a.js : typeof a.code === "string" ? a.code : "";
    return { text: src, lang };
}

// The BODY of a pending approval (goal + a plain-English intent, or the code, or a utility-model
// description) — an intent-verification prompt, not a debug trace. The Deny/Approve controls live in a
// FIXED footer (CardApp), so a scroll or a drag-collapse never cuts them off. While it's up, the real
// page element is highlighted (a pulsing green spotlight), and the card names where it is on the page.
function ApprovalBody({ st, hash, goal }: { st: AgentStep; hash: string; goal: string }) {
    const rv = rev.value;   // subscribe: the utility-model gloss lands on a rev bump (this reads a signal →
                            // auto-memoized, so without this it wouldn't re-render for it). Retained via data-rev.
    const code = codeOf(st);
    const intent = intentFor(st);
    const key = st.seq != null ? stepKey(hash, st.seq) : "";
    useEffect(() => {
        const sel = intent?.selector;
        if (sel) highlightApprove(/^@(?:pt|box):[0-9a-f]+/.test(sel) ? { token: sel } : { selector: sel });
        if (code && st.seq != null) ensureCodeSummary(hash, st.seq, code.lang, code.text);
        else if (!code && !intent?.target && st.seq != null) ensureActionSummary(hash, st.seq, st.tool || "", st.arguments || {});
        return () => { clearHighlight(); highlightPos.value = ""; };
    }, [st.seq]);
    const summary = key ? codeSummaries.get(key) : undefined;
    const pos = highlightPos.value;
    const sheets = externalSheetGrant(st.arguments);
    const isType = !!intent && intent.verb.toLowerCase() === "type";
    return (
        <div class="action" data-rev={rv}>
            <div class="action-goal">{goal}</div>
            {code
                ? <div class="action-card action-code">
                    <div class="action-verb">{st.tool === "python_exec" ? "Run Python" : "Run JavaScript"}</div>
                    {summary ? <div class="action-summary ml-reveal">{summary}</div> : null}
                    <div class="action-codeblk"><Code text={code.text} lang={code.lang} format={code.lang === "javascript"} /></div>
                  </div>
                : intent
                    ? <div class="action-card">
                        <div class="action-sentence">
                            Agent wants to <span class="action-verb">{intent.verb.toLowerCase()}</span>
                            {isType ? <> “<b class="action-target">{truncate(intent.input || "", 100)}</b>” into</> : null}
                            {" the "}{intent.kind || "element"}
                            {intent.target ? <> <b class="action-target">“{intent.target}”</b></> : null}
                            {/* type + submit is a bigger action (presses Enter → sends the form). Call it out with a
                                dotted underline so the human sees it's not just typing. */}
                            {isType && intent.submit ? <> and <span class="action-submit">submit</span> it</> : null}
                            {intent.note ? <span class="action-note"> · {intent.note}</span> : null}.
                        </div>
                        {intent.selector ? <div class="action-loc"><span class="loc-dot" aria-hidden="true" />Highlighted on the page{pos ? <> · <b>{pos}</b></> : null}</div> : null}
                      </div>
                    : <div class="action-card">
                        {summary ? <div class="action-summary ml-reveal">{summary}</div>
                            : <div class="action-body dim">Run <b>{st.tool}</b>{st.arguments && Object.keys(st.arguments).length ? <> with {inlineJson(st.arguments)}</> : null}</div>}
                      </div>}
            {sheets.length
                ? <div class="action-sheets"><IconWarn /><span>Grants this run access to {sheets.map((id, i) => <SheetChip key={i} id={id} />)} for the session.</span></div>
                : null}
        </div>
    );
}

// The live "working" pill's per-tool icon + hover label (headless progress — see the tool running).
const ACTIVITY: Record<string, { icon: string; label: string; short: string }> = {
    look: { icon: "👁", label: "Viewing the screen…", short: "look" },
    findByText: { icon: "🔎", label: "Searching the page…", short: "find" },
    locate: { icon: "🎯", label: "Locating an element…", short: "locate" },
    click: { icon: "👆", label: "Clicking…", short: "click" },
    type: { icon: "⌨️", label: "Typing…", short: "type" },
    exec: { icon: "λ", label: "Running JavaScript…", short: "exec" },
    python_exec: { icon: "🐍", label: "Running Python…", short: "python" },
    scroll: { icon: "🖱", label: "Scrolling…", short: "scroll" },
    screenshot: { icon: "📷", label: "Capturing…", short: "capture" },
};
function activityFor(run: Session): { icon: string; label: string; short: string } {
    const steps = run.steps || [];
    // Scope to the CURRENT (in-flight) turn's steps — those AFTER the last follow-up prompt's step position.
    // Within a turn, show the running tool, else the most-recent COMPLETED tool (the model is still processing
    // its result — don't snap to "thinking" the instant a look finishes). Bare "thinking" only at the START of
    // a turn (no tool yet) — including a fresh reply-turn, where the PREVIOUS turn's tools must not leak in.
    const turnStart = Math.max(0, ...(run.says || []).map(s => s.atStep || 0));
    const cur = steps.filter(s => (s.step || 0) > turnStart);
    const tool = [...cur].reverse().find(s => s.pending && s.tool) || [...cur].reverse().find(s => s.tool);
    if (!tool?.tool) return { icon: "💭", label: "Thinking…", short: "thinking" };
    return ACTIVITY[tool.tool] || { icon: "⚙️", label: `Running ${tool.tool}…`, short: tool.tool };
}
// The model's latest between-step PROSE (its `thought` — narration, not the hidden `reasoning`) within the
// CURRENT turn. Powers the live caption pill in Progress mode. Null until the model says something this turn.
function liveProseFor(run: Session): string | null {
    const steps = run.steps || [];
    const turnStart = Math.max(0, ...(run.says || []).map(s => s.atStep || 0));
    for (let i = steps.length - 1; i >= 0; i--) {
        if ((steps[i].step || 0) <= turnStart) break;   // walked out of the current turn
        const t = (steps[i].thought || "").trim();
        if (t) return t;
    }
    return null;
}
// Right-click the card/pill → ask the shell to draw the "move to corner" menu (drawn shell-side so the
// tiny pill iframe can't clip it). Coords are iframe-local; the shell offsets by the frame's position.
// Carry the run hash (for Copy run id / Cancel) + whether it's still live (Cancel only shows then).
const cardCtxMenu = (e: any) => {
    e.preventDefault();
    const run = latestAgentRun();
    const live = !!run && run.summary == null && !run.error;
    window.parent.postMessage({ __mlSidebarCornerMenu: { x: e.clientX, y: e.clientY, hash: run?.hash || "", live } }, "*");
    armMenuDismiss();
};
// Grab-drag the HUD: stream movement DELTAS to the shell, which moves the container and snaps to the
// nearest corner on release. A click (movement below a small threshold) is left alone, so buttons /
// toast-expand still fire. CRITICAL: capture + listen on a STABLE element (documentElement), NOT the
// grab element — the orb/pill/head re-renders on every agent event mid-drag, and a capture/listener bound
// to it would be orphaned the instant it's swapped (the "stuck, can't grab, mouse-is-a-magnet" bug: the
// drop never fires so it never snaps). documentElement is never re-rendered; capture keeps the moves
// flowing even when the pointer leaves the tiny orb iframe.
let orbDragging = false;   // true during an active drag → suppress the hover-capsule so it can't resize mid-drag
// Cleanup for the CURRENT card drag (removes its listeners + resets orbDragging/orbHover). Held at module
// scope so a new drag can force-end a prior stuck one, and the shell's window-level safety net can end it
// via __mlSidebarCardEndDrag when a fast flick escaped the iframe and the in-iframe pointerup never fired.
let endActiveCardDrag: (() => void) | null = null;
// Hover the orb → stretch to the labelled capsule. Only collapse on a REAL leave: resizing the container
// under a stationary pointer makes the browser fire a SPURIOUS pointerleave (the pointer is still
// physically inside the box), which was closing the capsule the instant it opened. So on leave we check
// the pointer's actual position against the element's box and IGNORE it when it's still inside; a small
// hysteresis timer on genuine leaves lets a quick re-enter cancel the collapse.
let orbLeaveTimer = 0;
// Hover-to-capsule is DISARMED right after a drag: the orb must land as a plain CIRCLE, not snap open just
// because the cursor happens to be sitting on it where it landed. A genuine leave+re-enter re-arms it, so a
// deliberate hover still expands. (Set false in the drag cleanup; set true on a real pointerleave.)
let orbHoverArmed = true;
const orbEnter = () => { if (orbDragging || !orbHoverArmed) return; clearTimeout(orbLeaveTimer); orbHover.value = true; };
const orbLeave = (e: any) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    if (e.clientX > r.left && e.clientX < r.right && e.clientY > r.top && e.clientY < r.bottom) return;   // spurious (resize) — pointer still inside
    orbHoverArmed = true;   // a real leave → the next enter is a deliberate hover, allow it to expand again
    clearTimeout(orbLeaveTimer);
    orbLeaveTimer = window.setTimeout(() => { orbHover.value = false; }, 140);
};
const startCardDrag = (e: any) => {
    if (e.button != null && e.button !== 0) return;                                          // left / touch only
    if ((e.target as HTMLElement).closest("button, input, textarea, a, .seg")) return;       // not on a control
    // Clean up any PRIOR drag whose pointerup never reached us (a fast flick escapes the tiny iframe before
    // it catches up → capture is lost → `up` never fires). Without this, its `move` listener stays attached
    // and the NEXT drag posts DOUBLE moves → the orb "runs away". The shell's window-level safety net (below)
    // also force-ends it, but starting fresh is the belt to that suspenders.
    endActiveCardDrag?.();
    const cap = document.documentElement;
    const startX = e.clientX, startY = e.clientY, pid = e.pointerId;
    let dragging = false;
    const cleanup = () => {
        cap.removeEventListener("pointermove", move);
        cap.removeEventListener("pointerup", up);
        cap.removeEventListener("pointercancel", up);
        if (endActiveCardDrag === cleanup) endActiveCardDrag = null;
        if (dragging) { dragging = false; orbDragging = false; }
        // Settle the orb back to the CIRCLE after a drag AND disarm hover-expand: it must LAND as a circle,
        // not immediately re-expand because the cursor is sitting on where it landed (the "lands expanded
        // then collapses" jank). A real leave+re-enter re-arms it, so a deliberate hover still opens it.
        orbHover.value = false;
        orbHoverArmed = false;
    };
    const move = (ev: any) => {
        if (!dragging) {
            if (Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) < 4) return;   // threshold → still a click
            dragging = true; orbDragging = true; orbHover.value = false;                      // no hover-resize mid-drag
            try { cap.setPointerCapture(pid); } catch { /* older engines */ }
            // Send WHERE in the card the grab landed (iframe-local ≈ offset from the card's top-left, since
            // the iframe fills the wrap). The shell keeps that fractional point under the cursor across a
            // mid-drag size change (pill→orb) so the collapsed orb lands UNDER the cursor, not at the edge.
            window.parent.postMessage({ __mlSidebarCardGrab: { gx: ev.clientX, gy: ev.clientY } }, "*");
        }
        window.parent.postMessage({ __mlSidebarCardMove: { dx: ev.movementX, dy: ev.movementY } }, "*");
    };
    const up = () => {
        const wasDragging = dragging;
        cleanup();
        if (!wasDragging) return;
        window.parent.postMessage({ __mlSidebarCardDrop: true }, "*");
        // A drag must CANCEL the click that fires after pointerup — otherwise dropping a dragged toast
        // also triggers its onClick (expand). Swallow the next click in the CAPTURE phase (before the
        // element's handler); a timeout clears it if no click follows (some engines skip it after capture).
        const swallow = (ce: Event) => { ce.stopPropagation(); clear(); };
        const clear = () => window.removeEventListener("click", swallow, true);
        window.addEventListener("click", swallow, true);
        setTimeout(clear, 350);
    };
    endActiveCardDrag = cleanup;
    cap.addEventListener("pointermove", move);
    cap.addEventListener("pointerup", up);
    cap.addEventListener("pointercancel", up);
};
// The corner menu is drawn in the SHELL (top document), but the right-click that opened it happened
// inside THIS iframe — so the page window was already blurred and a later in-card click fires no new
// blur, nor does its pointerdown reach the shell's outside-click handler. So the NEXT pointerdown in the
// card tells the shell to dismiss the menu. Single-armed so repeated right-clicks don't stack listeners.
let menuDismissArmed = false;
function armMenuDismiss(): void {
    if (menuDismissArmed) return;
    menuDismissArmed = true;
    window.addEventListener("pointerdown", () => {
        menuDismissArmed = false;
        window.parent.postMessage({ __mlSidebarCornerMenuDismiss: true }, "*");
    }, { once: true, capture: true });
}

// "Show work" — the audit trail under a finished card. The card already HAS the whole trace (run.steps),
// it just hides it; this re-renders it with the SAME components the debug sidebar uses (AgentTurn →
// ToolStep). Collapsed by default; a finished run has no awaiting gate, so no approve buttons appear.
function ShowWork({ run }: { run: Session }) {
    // Reading cardShowWorkHash auto-memoizes this component; `run` is mutated in place (same ref), so also
    // subscribe to `rev` — else a landed Explain gloss (rev bump) wouldn't re-render. Retained via data-rev.
    const rv = rev.value;
    const open = cardShowWorkHash.value === run.hash;
    // Drop empty groups — a turn carrying only a usage sample (final-answer token counts), no thought /
    // reasoning / tool — which otherwise render as a blank block in the trace (the same filter AgentRunView
    // uses). KEEP a reasoning-only turn (the final-answer turn shows its thinking).
    const turns = groupTurns(run.steps || []).filter(t => t.thought || t.reasoning || t.tools.length);
    // "N steps" = the number of loop iterations actually shown (turn-groups across ALL turns), not just the
    // tool calls — a thinking-only step is still a step, and the old tool-only count undercounted multi-turn runs.
    const n = turns.length;
    // Interleave the CONVERSATION into the trace — your prompts (task + follow-ups → "you asked") and PAST
    // answers, positioned with the step-groups by cumulative step (same scheme as the panel's AgentRunView:
    // task at -1, an answer just after its turn's steps, a following prompt just after that). The LATEST
    // answer isn't here — it's the card BODY (or, while running, the live prose) — so a done run drops it.
    const running = run.status === "pending";
    const answers = run.answers || [];
    const pastAnswers = running ? answers : answers.slice(0, -1);
    const traceItems: { pos: number; el: preact.JSX.Element }[] = [
        ...(run.task ? [{ pos: -1, el: <CardTraceMsg key="task" label="you asked" text={run.task} cls="acard-you" /> }] : []),
        ...(run.says || []).map((s, i) => ({ pos: s.atStep + 0.9, el: <CardTraceMsg key={`say${i}`} label="you asked" text={s.text} cls="acard-you" /> })),
        ...pastAnswers.map((a, i) => ({ pos: a.atStep + 0.5, el: <CardTraceMsg key={`ans${i}`} label={a.cancelled ? "cancelled" : a.hitCap ? "stopped early" : "answered"} text={a.text || "(no reply)"} cls="acard-ans" /> })),
        ...turns.map(t => ({ pos: t.step, el: <AgentTurn key={`t${t.step}`} turn={t} max={run.maxSteps} hash={run.hash} /> })),
    ].sort((a, b) => a.pos - b.pos);
    // Right-click the toggle → export THIS run (Markdown / PDF), reusing the debug bar's export logic. The
    // `head` wraps ONLY the toggle + menu, so a click on the TRACE (or anywhere else, or the page → iframe
    // blur) dismisses it — the trace is a sibling, outside `head`.
    const [expMenu, setExpMenu] = useState(false);
    const head = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!expMenu) return;
        const close = () => setExpMenu(false);
        const onDown = (e: Event) => { if (!head.current?.contains(e.target as Node)) close(); };
        const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
        document.addEventListener("pointerdown", onDown);
        document.addEventListener("keydown", onKey);
        window.addEventListener("blur", close);   // clicking the page (outside the iframe) blurs it
        return () => { document.removeEventListener("pointerdown", onDown); document.removeEventListener("keydown", onKey); window.removeEventListener("blur", close); };
    }, [expMenu]);
    const exp = (fn: (h: string) => void) => { setExpMenu(false); fn(run.hash); };
    return (
        <div class="card-work" data-rev={rv}>
            <div class="card-work-head" ref={head}>
                <button class={`card-work-toggle${open ? " open" : ""}`} title="Right-click to export this run (Markdown / PDF)"
                    onClick={() => (cardShowWorkHash.value = open ? "" : run.hash)}
                    onContextMenu={e => { e.preventDefault(); setExpMenu(v => !v); }}>
                    <span class="card-work-label">{open ? "Hide work" : "Show work"}</span>
                    <span class="card-work-n">{n} {n === 1 ? "step" : "steps"}</span>
                    <span class="sp" />
                    <span class={`tri${open ? " open" : ""}`} aria-hidden="true"><IconChevron /></span>
                </button>
                {expMenu ? (
                    <div class="card-export-menu" role="menu">
                        <div class="menu-head">Export this run</div>
                        <button class="menu-item" role="menuitem" onClick={() => exp(exportSession)}>Markdown<span class="menu-hint">.zip with screenshots</span></button>
                        <button class="menu-item" role="menuitem" onClick={() => exp(printSession)}>PDF<span class="menu-hint">opens the print dialog</span></button>
                    </div>
                ) : null}
            </div>
            {open ? <div class="card-work-trace">{traceItems.map(it => it.el)}</div> : null}
        </div>
    );
}

// A collapsed disclosure in the card trace for a USER PROMPT ("you asked") or a PAST ANSWER ("answered") —
// styled like the thinking block, so Show-work reads as a scannable conversation SHAPE (ask → work → answer
// → ask → …). Collapsed with a one-line preview; expand for the full text. This is how a multi-turn HUD run
// stays legible: you can tell which steps belonged to which of your prompts.
function CardTraceMsg({ label, text, cls }: { label: string; text: string; cls: string }) {
    const [open, setOpen] = useState(false);
    return (
        <div class={`athought ${cls}`}>
            <button class="astep-head" onClick={() => setOpen(v => !v)}>
                <span class={`tri${open ? " open" : ""}`} aria-hidden="true"><IconChevron /></span>
                <span class="who">{label}</span>
                {!open ? <span class="astep-preview">{inlineText(text || "")}</span> : null}
            </button>
            {open ? <div class="md astep-body" dangerouslySetInnerHTML={{ __html: markdown(text || "", { math: true }) }} /> : null}
        </div>
    );
}

// The Spotlight composer — the HUD morphed into a task input. Reuses the card's head/body/foot anatomy
// (same 🤖 in the same top-left spot as every other state) so it reads as the SAME blob reshaping, not a
// new panel. On send it posts `startRun` to the shell → the page runs a real ml.agent() (hash, resumable).
function ComposerCard() {
    const [text, setText] = useState("");
    const [err, setErr] = useState("");   // pre-flight complaint (e.g. no model configured) — blocks the send
    const budget = composerMaxSteps.value;   // the step budget (persists across opens)
    const ref = useRef<HTMLTextAreaElement>(null);
    // Focus after a frame so the container's morph (and the shell's frame.focus) has landed.
    useEffect(() => { const id = requestAnimationFrame(() => ref.current?.focus()); return () => cancelAnimationFrame(id); }, []);
    const close = () => { composerOpen.value = false; };
    const send = () => {
        const t = text.trim();
        if (!t) return;
        // Pre-flight: a HUD run with no default model would flash the orb, then fail at the background's
        // prepareRequest with "No model configured". Catch it HERE instead — an inline nudge to Settings,
        // so a fresh install that hasn't picked a model gets an actionable message, not a cryptic failure.
        if (!config.value.model) { setErr("No model set. Open the extension settings (toolbar icon) and pick a model first."); return; }
        // Bridge the round-trip: show a "Starting…" pill until the run's first event arrives (the composer
        // flies back to the corner and is instantly working). Safety-cleared if the run never surfaces.
        const t0 = Date.now();
        composerStarting.value = t0;
        setTimeout(() => { if (composerStarting.value === t0) composerStarting.value = 0; }, 10000);
        window.parent.postMessage({ __mlSidebarApp: "startRun", task: t, maxSteps: composerMaxSteps.value }, "*");
        close();
    };
    return (
        <div class="card-app" data-rev={rev.value}>
            <div class="card-head">
                <span class="card-bot" aria-hidden="true">🤖</span>
                <span class="card-head-txt">New task</span>
                <span class="sp" />
                <button class="card-x" aria-label="Cancel" title="Cancel" onClick={close}>✕</button>
            </div>
            <div class="card-body">
                <textarea ref={ref} class="card-cmp-input" rows={3}
                    placeholder="Ask window.ml to do something on this page…"
                    value={text}
                    onInput={e => { setText((e.target as HTMLTextAreaElement).value); if (err) setErr(""); }}
                    onKeyDown={e => {
                        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
                        else if (e.key === "Escape") { e.preventDefault(); close(); }
                    }} />
                {err ? <div class="card-cmp-err">{err}</div> : null}
            </div>
            <div class="card-foot card-cmp-foot">
                <span class="card-cmp-hint"><kbd class="kb">↵</kbd> send · <kbd class="kb">esc</kbd> cancel</span>
                <span class="sp" />
                {/* Step budget — a pretty segmented control (not a bare <select>); caps the agent loop. */}
                <div class="card-cmp-budget" title="How many tool steps the agent may take">
                    <span class="card-cmp-budget-label">Steps</span>
                    <div class="seg" role="group" aria-label="Step budget">
                        {STEP_BUDGETS.map(n => (
                            <button key={n} class={`seg-opt${budget === n ? " on" : ""}`}
                                aria-pressed={budget === n} onClick={() => (composerMaxSteps.value = n)}>{n}</button>
                        ))}
                    </div>
                </div>
                <button class="appr-btn yes" onClick={send} disabled={!text.trim()}>Send</button>
            </div>
        </div>
    );
}

// The liquid tool ORB — the working HUD balled into a circle showing the active-tool emoji. On HOVER it
// RESHAPES: the blob stretches into a capsule that spells out what it's doing ("👁 Looking at the
// screen…") — the shell springs the container wider, the label fades in. Draggable + right-click move
// like every HUD state. (Emoji for now; a looping custom SVG per tool slots into `.card-orb-ic` later.)
function Orb({ icon, label, wide, prose }: { icon: string; label: string; wide: boolean; prose?: boolean }) {
    return (
        <div class="card-app" data-rev={rev.value}>
            <div class={`card-orb${wide ? " wide" : ""}${prose ? " prose" : ""}`}
                onPointerEnter={orbEnter} onPointerLeave={orbLeave}
                onPointerDown={startCardDrag} onContextMenu={cardCtxMenu}
                title={prose ? label : undefined}>
                <span class="card-orb-ic" aria-hidden="true">{icon}</span>
                {wide ? <span class="card-orb-label">{label}</span> : null}
            </div>
        </div>
    );
}

function CardApp() {
    const r = rev.value;   // subscribe to session changes (retained via data-rev below)
    const composing = composerOpen.value;   // Spotlight bar open → the HUD morphs into the task input
    const run = latestAgentRun();
    const hash = run?.hash;
    const showWork = !!hash && cardShowWorkHash.value === hash;   // active run's trace open? (subscribe → re-measure height on toggle)
    const pendingStep = run ? (run.steps || []).find(st => isPendingGate(run.hash, st)) : undefined;
    const pending = !!pendingStep;
    // Terminal ONLY when the run isn't mid-turn: a follow-up run() keeps the PRIOR summary set, so without
    // the status guard `done` would stay true and the card would show the stale answer instead of collapsing
    // to the working orb. status flips to "pending" on a new turn (optimistically in CardReply, and on any
    // agent-step) and back to ok/err on the next agent-result.
    const done = !!run && run.status !== "pending" && (run.summary != null || !!run.error || !!run.cancelled);
    const dismissed = !!run && cardDismissed.value === run.hash;
    // BRIDGE: the composer was just sent but the run's first event hasn't surfaced yet — show a
    // "Starting…" pill immediately (so hitting Enter has an instant HUD response, like the DevTools
    // panel), overriding any older run. Cleared once the new run (createdTs ≥ the send time) appears.
    const startedAt = composerStarting.value;
    const newRunUp = !!run && (run.createdTs || 0) >= startedAt;
    const starting = startedAt > 0 && !newRunUp;
    // In flight the INSTANT the run starts (thinking, before any tool step) → the pill shows right away.
    // "quiet" HUD mode still suppresses the idle/working pill (the card only surfaces for approvals/answers).
    const running = !!run && !pending && !done;
    const quiet = config.value.agentHud === "quiet";
    // A `silent` run (ml.agent({ silent: true })) is a scripting utility: keep it OUT of the HUD — no
    // working orb, no answer card. Approvals STILL surface (privileged consent can't be silenced), so
    // `pending` below is unaffected; only the ambient orb + the finished-answer card are suppressed.
    const silent = !!run?.agentConfig?.silent;
    const showOrb = (running || starting) && !quiet && !silent;
    const hovering = orbHover.value;                           // hovering the orb → stretch to a labelled capsule
    // Live prose: the model's between-step narration (its `thought`, NOT the hidden reasoning). In PROGRESS
    // mode it auto-expands the orb into a caption pill so you see what it's doing without hovering; QUIET
    // suppresses it (the run is already !showOrb there). Not for the "Starting…" bridge (no run steps yet).
    const liveProse = (showOrb && !starting) ? liveProseFor(run!) : null;
    const state = composing ? "composer"                       // the composer takes over — centered Spotlight bar
        : pending ? "expanded"                                 // an approval: show the action directly (even for a silent run)
            : showOrb ? (liveProse ? "orbprose" : hovering ? "orblabel" : "orb")   // in flight → orb; caption when narrating; capsule on hover
                : (done && !dismissed && !silent) ? (cardCollapsed.value ? "toast" : "expanded")   // finished: the answer
                    : "hidden";

    // Clear a STALE hover whenever we're not showing the orb — the orb can unmount while hovered (the
    // composer opens over it, an approval expands) and then no pointerleave fires, which would wrongly
    // reopen the capsule (orblabel) when the orb next appears (e.g. the "Starting…" bridge). So a fresh
    // orb always starts circular until a real pointerenter.
    useEffect(() => { if (state !== "orb" && state !== "orblabel" && state !== "orbprose") orbHover.value = false; }, [state]);
    useEffect(() => { if (startedAt > 0 && newRunUp) composerStarting.value = 0; }, [newRunUp]);   // run surfaced → drop the bridge
    useEffect(() => { if (run) ensureCardTitle(run); }, [hash, r]);
    // No reset effect needed — show-work is keyed by hash, so a new run is collapsed by default (its hash
    // isn't the open one). "Show work" open → ask the shell to slide the card to the drag limit (room for the
    // whole trace); closed → release it (snap back to fit). Driven by the ACTIVE run's derived open state.
    useEffect(() => { window.parent.postMessage({ __mlSidebarCardExpand: showWork }, "*"); }, [showWork]);
    // Report our natural CONTENT height so the shell can FIT the card (a cross-origin iframe can't
    // auto-size). We sum the card's children — head + body(scrollHeight = full content) + foot — NOT
    // documentElement.scrollHeight: the app fills the iframe (height:100%), so measuring the container
    // would feed its own clamped height back (an oscillation). The shell caps this to the viewport and
    // the body scrolls. Measured after two frames (fonts/highlighting settle) + on later async growth.
    useEffect(() => {
        const post = () => {
            const app = document.querySelector(".card-app") as HTMLElement | null;
            if (!app) { window.parent.postMessage({ __mlSidebarCardH: Math.ceil(document.documentElement.scrollHeight) }, "*"); return; }
            // Sum each child's TRUE height. `.card-body` is flex:1, so a user drag inflates its clientHeight
            // (and thus scrollHeight) to fill the taller container — measuring that would report the dragged
            // size as "content" and the shell would snap-back-glitch (the drag looks like a content change).
            // So for card-body measure its own children + padding, which is the real content regardless of
            // how tall the container was dragged.
            let h = 0;
            for (const c of Array.from(app.children) as HTMLElement[]) {
                if (c.classList.contains("card-body")) {
                    const cs = getComputedStyle(c);
                    let inner = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + parseFloat(cs.borderTopWidth || "0") + parseFloat(cs.borderBottomWidth || "0");
                    for (const kid of Array.from(c.children) as HTMLElement[]) {
                        const ks = getComputedStyle(kid);
                        inner += kid.scrollHeight + parseFloat(ks.marginTop) + parseFloat(ks.marginBottom);
                    }
                    h += inner;
                } else h += c.offsetHeight;   // offsetHeight (NOT scrollHeight) so head/foot BORDERS count — else
                                              // the posted height is ~2px short and card-body shows a spurious scrollbar
            }
            // +2px slack: sub-pixel rounding of each child's height can still leave card-body ~1px short of its
            // content (a faint scrollbar). The pad is invisible but guarantees the content never overflows.
            window.parent.postMessage({ __mlSidebarCardH: Math.ceil(h) + 6 }, "*");
        };
        post();
        requestAnimationFrame(() => requestAnimationFrame(post));
        if (typeof ResizeObserver === "undefined") return;
        const ro = new ResizeObserver(post);
        ro.observe(document.body);
        return () => ro.disconnect();
        // `showWork`: the ResizeObserver can't catch a Show-work toggle (the iframe body is height-pinned
        // by the shell, so content growth doesn't resize body) — so re-measure explicitly on the toggle.
    }, [state, r, showWork]);
    // Post the STATE *after* the height effect (both fire on a state change; effects run in definition
    // order). So on orb→expanded the shell learns the new content's height FIRST (silently — the orb uses a
    // fixed size), then applies "expanded" with the fresh cardAutoH. Posting state first made it lay out the
    // expanded card at the STALE height (the previous run's, or the 200px default) → it opened 2-3× too tall
    // then snapped down — the "elastic jump". Height-then-state removes the overshoot.
    useEffect(() => { window.parent.postMessage({ __mlSidebarCard: state }, "*"); }, [state]);
    // Keyboard: Enter approves, Esc denies — but ONLY from a real keydown INSIDE this trusted iframe (a
    // page-side global hotkey routed in would reopen the forgery hole, so we deliberately don't do that).
    // We ask the shell to focus the card frame when an approval appears, so the keys work without a click.
    useEffect(() => {
        if (!run || !pendingStep || pendingStep.seq == null) return;
        const h = run.hash, seq = pendingStep.seq;
        window.parent.postMessage({ __mlSidebarCardFocus: true }, "*");
        const decideKey = (ok: boolean) => { decidedSteps.add(stepKey(h, seq)); clearHighlight(); sendApproval(h, seq, ok); rev.value++; };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Enter") { e.preventDefault(); decideKey(true); }
            else if (e.key === "Escape") { e.preventDefault(); decideKey(false); }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [pending, pendingStep?.seq]);

    if (composing) return <ComposerCard />;   // the blob reshapes into the task input (container morphs shell-side)
    // The just-sent "Starting…" bridge orb (before the run's first event) — the composer balled up and flew
    // back to the corner, already working. Ignores any older run underneath.
    if ((state === "orb" || state === "orblabel") && starting) return <Orb icon="💭" label="Starting…" wide={state === "orblabel"} />;
    if (!run) return <div class="card-app" data-rev={r} />;

    const title = run.title || truncate(run.task || "Agent run", 80);
    const headline = pending ? "Approval needed" : run.error ? "Run failed" : run.cancelled ? "Cancelled" : done ? (run.hitCap ? "Stopped" : "Task complete") : "Working…";
    const decide = (ok: boolean) => {
        if (!pendingStep || pendingStep.seq == null) return;
        decidedSteps.add(stepKey(run.hash, pendingStep.seq));
        clearHighlight();
        sendApproval(run.hash, pendingStep.seq, ok);
        rev.value++;
    };
    const onClose = (e: Event) => {
        e.stopPropagation();
        if (pendingStep) decide(false);          // × on a pending gate = a fast Deny
        else cardDismissed.value = run.hash;     // × on a finished card = dismiss
    };
    // Dismiss on POINTERDOWN (not click/pointerup): if the pointer wobbles between the × and the toast body,
    // the browser fires `click` on their common ANCESTOR (the toast), whose handler EXPANDS — and a pointerUP
    // that drifts off the × misses the button entirely. Dismissing on pointerDOWN sets `dismissed` before any
    // of that: the state machine then resolves to "hidden" regardless of a stray expand click, so the card
    // never flashes open. stopPropagation keeps the press from also starting the drag grab on the toast.
    const onCloseDown = (e: Event) => { e.stopPropagation(); e.preventDefault(); onClose(e); };

    // Hidden = render NOTHING (the shell fades the wrapper out by opacity). Without this branch the code
    // falls through to the full expanded card, so on dismiss the content swaps small-toast→full-card and the
    // height re-measures UP — the card visibly GREW while fading ("expands then goes opacity 0"), and closing
    // the composer over a dismissed run faded into that stale dialog. Empty content → a clean fade to nothing.
    if (state === "hidden") return <div class="card-app" data-rev={r} />;

    if (state === "orbprose") {
        // The live caption: current tool icon + the model's latest between-step narration (one ellipsized line).
        return <Orb icon={activityFor(run).icon} label={liveProse || activityFor(run).label} wide prose />;
    }
    if (state === "orb" || state === "orblabel") {
        const a = activityFor(run);
        return <Orb icon={a.icon} label={a.label} wide={state === "orblabel"} />;
    }
    if (state === "toast") {
        return (
            <div class="card-app" data-rev={r}>
                <div class="card-toast" role="button" title="Click to review · drag or right-click to move" onPointerDown={startCardDrag} onClick={e => { if (!(e.target as HTMLElement).closest(".card-x")) cardCollapsed.value = false; }} onContextMenu={cardCtxMenu}>
                    <span class="card-bot" aria-hidden="true">🤖</span>
                    <span class="card-toast-txt">
                        <span class="card-toast-head">{headline}</span>
                        <span class="card-toast-sub">{title}</span>
                    </span>
                    <button class="card-x" aria-label="Dismiss" onPointerDown={onCloseDown} onClick={e => e.stopPropagation()}>✕</button>
                </div>
            </div>
        );
    }
    return (
        <div class="card-app" data-rev={r}>
            <div class="card-head" onPointerDown={startCardDrag} onContextMenu={cardCtxMenu}>
                <span class="card-bot" aria-hidden="true">🤖</span>
                <span class={`card-head-txt${pending ? " pending" : ""}`}>{headline}</span>
                <span class="sp" />
                {pending ? null : <button class="card-icon" aria-label="Collapse" title="Collapse" onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); cardCollapsed.value = true; }}>▾</button>}
                <button class="card-x" aria-label={pending ? "Deny" : "Dismiss"} onPointerDown={onCloseDown} onClick={e => e.stopPropagation()}>✕</button>
            </div>
            <div class="card-body">
                {pending && pendingStep
                    ? <ApprovalBody st={pendingStep} hash={run.hash} goal={title} />
                    : <>
                        {run.error
                            ? <div class="card-error">{run.error}</div>
                            : (run.summary || "").trim()
                                ? <div class="card-answer md" dangerouslySetInnerHTML={{ __html: markdown(run.summary || "", { math: true }) }} />
                                : <div class="card-answer dim card-answer-empty">{run.cancelled ? "Run cancelled — the agent returned no text." : "The run finished without a text reply."}</div>}
                        {/* Only when there's actual WORK — at least one tool step. A pure chat answer (0 tool
                            steps) has nothing to show, so no "Show work · 0 steps". */}
                        {(run.steps || []).some(s => s.tool) ? <ShowWork run={run} /> : null}
                      </>}
            </div>
            {/* Deny/Approve as a FIXED footer — outside the scroll area, so it's always visible (a
                drag-collapse or the scrollbar appearing can never cut or shift the buttons). */}
            {pending && pendingStep
                ? <div class="card-foot">
                    <button class="appr-btn no" onClick={() => decide(false)}>Deny <kbd class="kb">esc</kbd></button>
                    <button class="appr-btn yes" onClick={() => decide(true)}>Approve <kbd class="kb">⏎</kbd></button>
                  </div>
                : done ? <CardReply hash={run.hash} /> : null}
        </div>
    );
}

// Inline reply on the finished HUD card — the lowest-friction "respond to the final response". Reuses the
// EXACT session-composer reverse channel the panel uses (__mlSidebarApp:"sessionSend" → shell → the page's
// handle registry → the run's run()), so a follow-up turn continues the SAME session. Sending flips the card
// back to the working orb via the normal state machine. Compact: one line + send, Enter sends.
function CardReply({ hash }: { hash: string }) {
    // Collapsed by default to a slim GHOST affordance (icon + "Reply…", NOT a filled input) — quiet until you
    // want to reply. Click opens the real input, where the send button lives INSIDE the field and only
    // materialises once you type. Escape / empty blur collapses back to the ghost.
    const [open, setOpen] = useState(false);
    const [text, setText] = useState("");
    const inputRef = useRef<HTMLInputElement>(null);
    const send = () => {
        const t = text.trim();
        if (!t) return;
        window.parent.postMessage({ __mlSidebarApp: "sessionSend", hash, text: t }, "*");
        // Optimistic: flip the session to WORKING now so the card morphs to the orb the instant you hit
        // Enter, instead of showing the stale answer until the follow-up's first event lands (in off/card
        // mode the page's agent-say bridge is dormant, so there'd otherwise be a visible lag).
        const s = sessionMap.get(hash);
        if (s) { s.status = "pending"; s.lastTs = Date.now(); rev.value++; }
        setText(""); setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
        else if (e.key === "Escape") { e.preventDefault(); setText(""); setOpen(false); }
    };
    useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);

    if (!open) {
        return (
            <div class="card-reply collapsed">
                <button class="card-reply-open" onClick={() => setOpen(true)}>
                    <IconSend /><span>Reply to continue this run…</span>
                </button>
            </div>
        );
    }
    const has = !!text.trim();
    return (
        <div class="card-reply">
            <div class="card-reply-field">
                <input ref={inputRef} class="card-reply-in" type="text" value={text} placeholder="Reply to continue this run…"
                    onInput={e => setText((e.target as HTMLInputElement).value)} onKeyDown={onKey}
                    onBlur={() => { if (!text.trim()) setOpen(false); }} />
                <button class={`card-reply-send${has ? " show" : ""}`} aria-label="Send" tabIndex={has ? 0 : -1}
                    onMouseDown={e => e.preventDefault()} onClick={send} disabled={!has}>
                    <IconSend />
                </button>
            </div>
        </div>
    );
}

// Top-level switch: the off-mode card or the full slide-out panel. Kept separate (not a branch inside
// App) so App's hooks/effects — the ps polling, stick-to-bottom, title backfill — never run for the
// card, which needs none of them.
function Root() {
    return surface.value === "card" ? <CardApp /> : <App />;
}

// Whether the detail log is scrolled to the bottom (stick-to-bottom intent). Module-level so the
// per-step approval reveal (ToolStep) and App's scroll logic share ONE truth — a single App instance.
const atBottom = { v: true };

function App() {
    const v = view.value;
    // Subscribe to session-data changes. This read MUST land in always-rendered
    // output (the data-rev on .view below) — NOT a bare `rev.value;` statement
    // (minification drops it as dead code) and NOT a value used in only one
    // branch (minification inlines it into that branch). Either mistake leaves
    // the detail view subscribed to nothing, so a result that arrives while it's
    // open updates the turn's data but never re-renders (stale "…thinking").
    const r = rev.value;
    // The iframe body IS the panel; the slide-out shell (tab/resize/container)
    // lives in the content-script host (sidebar/shell.ts), not here.
    const inSettings = v.name === "settings";
    const inBench = v.name === "bench";
    const detailSession = v.name === "detail" ? sessionMap.get(v.hash) : null;
    // Lazily summarise session titles whenever the data or open-state changes.
    // `open` is read (not just used in deps) so App re-renders on open/close.
    const open = sidebarOpen.value;
    // `utilModel`/`autoTitles` are deps so enabling them later backfills sessions.
    const utilModel = config.value.utilityModel;
    const autoTitles = config.value.autoTitles;
    useEffect(() => { maybeGenerateTitles(); }, [r, open, utilModel, autoTitles]);
    // Poll Ollama's resident set for the VRAM panel + the header status dot: a
    // steady interval, plus an immediate poll whenever the view/open-state
    // changes (so the dot resolves promptly on navigation). pollPs self-gates.
    useEffect(() => {
        const id = setInterval(pollPs, VRAM_POLL_MS);
        return () => clearInterval(id);
    }, []);
    useEffect(() => { pollPs(); }, [v.name, vramOpen.value, open]);
    // Stick-to-bottom: while a session's detail is open and the user is parked at the bottom,
    // keep the log pinned to the latest as it grows — but if they've scrolled UP to read, leave
    // them there. `atBottom.v` (module-level so ToolStep can consult it too) tracks intent,
    // recomputed on every manual scroll. Opening a detail jumps to the latest and re-sticks.
    const viewRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    // While a SMOOTH auto-pin is animating, the scroll events it emits show scrollTop short of the
    // bottom — onViewScroll must NOT read those as "the user scrolled up" (that flip mid-animation is
    // what made the pin give up and pop/stick-fail). So suppress recomputation while pinning, and clear
    // the flag once we've actually reached the bottom. A real user gesture (wheel/touch) clears it too,
    // so they can always break away from the follow.
    const pinning = useRef(false);
    const onViewScroll = () => {
        const el = viewRef.current;
        if (!el) return;
        const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
        if (pinning.current) { if (dist < 4) { pinning.current = false; atBottom.v = true; } return; }
        atBottom.v = dist < 40;
    };
    const endPin = () => { pinning.current = false; };   // a user scroll gesture cancels the auto-follow
    const pinBottom = (smooth: boolean) => {
        const el = viewRef.current;
        if (!el) return;
        if (smooth && el.scrollTo) { pinning.current = true; atBottom.v = true; el.scrollTo({ top: el.scrollHeight, behavior: "smooth" }); }
        else { pinning.current = false; el.scrollTop = el.scrollHeight; }   // instant (open jump / jsdom)
    };
    const detailKey = v.name === "detail" ? v.hash : "";
    // Open/switch a detail → jump straight to the latest and re-stick.
    useEffect(() => { if (detailKey) { pinBottom(false); atBottom.v = true; } }, [detailKey]);
    // Re-pin (smoothly) whenever the content's HEIGHT changes while stuck — this is the key: a new
    // event, an approval prompt or its revealed Out, a screenshot finishing loading, or streaming all
    // grow the content AFTER the render commits, which a render-keyed effect would miss (it scrolled to
    // the old height). A ResizeObserver catches every one. (Guarded for jsdom, which lacks it.)
    useEffect(() => {
        const content = contentRef.current;
        if (!detailKey || !content || typeof ResizeObserver === "undefined") return;
        const ro = new ResizeObserver(() => { if (atBottom.v) pinBottom(true); });
        ro.observe(content);
        return () => ro.disconnect();
    }, [detailKey]);
    return (
        <div class="app">
            <ContextMenu />
            <div class="head">
                {v.name !== "list" ? <button class="tt nav" aria-label="Back to sessions" onClick={() => (view.value = { name: "list" })}>‹<span class="tt-pop left" role="tooltip">Back to sessions</span></button> : null}
                {detailSession
                    ? <>
                        <ModelStatusDot model={shownModel(detailSession)} inFlight={detailSession.status === "pending"} />
                        <span class="tt head-model">{shownModel(detailSession)}<span class="tt-pop left" role="tooltip">The model that will respond to your next message in this session.</span></span>
                        <ProfileBadge profile={sessionProfile(detailSession)} />
                        {detailSession.kind === "agent" ? <AgentBadge /> : null}
                    </>
                    : <b>{inSettings ? "Settings" : inBench ? "Python bench" : `Sessions (${sessionMap.size})`}</b>}
                <span class="sp" />
                {v.name === "detail" ? <Hash hash={v.hash} /> : null}
                {v.name === "detail" ? <ExportMenu hash={v.hash} /> : null}
                {!inSettings && !inBench ? <button class={`tt hbtn${vramOpen.value ? " on" : ""}`} aria-label="VRAM monitor" onClick={() => (vramOpen.value = !vramOpen.value)}><IconVram /><span class="tt-pop" role="tooltip">VRAM monitor</span></button> : null}
                {!inSettings && !inBench ? <button class="tt hbtn" aria-label="Python bench" onClick={() => (view.value = { name: "bench" })}><IconBench /><span class="tt-pop" role="tooltip">Python bench — run scripts in the sandbox</span></button> : null}
                {!inSettings && !inBench ? <button class="tt hbtn" aria-label="Settings" onClick={() => { fetchModels(); view.value = { name: "settings" }; }}><IconGear /><span class="tt-pop" role="tooltip">Settings</span></button> : null}
            </div>
            {vramOpen.value && !inSettings && !inBench ? <VramPanel /> : null}
            <div class="view" data-rev={r} ref={viewRef} onScroll={onViewScroll} onWheel={endPin} onTouchMove={endPin}>
                <div ref={contentRef}>
                    {v.name === "settings" ? <Settings />
                        : v.name === "bench" ? <PythonBench />
                            : v.name === "list" ? <ListView />
                                : <DetailView hash={v.hash} />}
                </div>
            </div>
            {detailSession ? <Composer s={detailSession} /> : null}
        </div>
    );
}

/* --------------------------------- mount ---------------------------------
 * This runs INSIDE the sidebar iframe (an extension page — sidebar.html), which
 * the host web page can't read across the origin boundary. The content-script
 * shell (sidebar/shell.ts) hosts the iframe, relays each `__mlDebug` event in
 * via postMessage, and owns the slide-out container/tab/resize.
 */
// Debug events are relayed in from the shell (the parent window); a bare page
// can't reach this iframe's message bus across the extension-origin boundary.
// Drop all session state. The DevTools panel reuses one long-lived app across page
// reloads (the overlay gets a fresh iframe each load), so it must be told to clear —
// on a page navigation (ML_DEBUG_RESET) and before a reconnect's authoritative replay.
function resetSessions(): void {
    sessionMap.clear();
    titleTried.clear();
    if (view.value.name === "detail") view.value = { name: "list" };
    rev.value++;
}

function onMessage(e: MessageEvent): void {
    const d = e.data as any;
    if (e.source !== window.parent || !d) return;
    if (d.__mlDebug) onDebug(d.__mlDebug as MlDebugEvent);
    else if (typeof d.__mlHighlightPos === "string") highlightPos.value = d.__mlHighlightPos;   // where the approval target sits on the page
    else if (d.__mlDebugReset) resetSessions();
    else if (typeof d.__mlSidebarSurface === "string") {
        // The shell tells us which surface we are. The off-mode card renders a transparent, curated
        // view — flag <html> so the CSS drops the opaque canvas and the acrylic shows through.
        surface.value = d.__mlSidebarSurface === "card" ? "card" : "panel";
        document.documentElement.dataset.surface = surface.value;
    }
    else if (typeof d.__mlSidebarOpen === "boolean") {
        const wasOpen = sidebarOpen.value;
        sidebarOpen.value = d.__mlSidebarOpen;
        if (d.__mlSidebarOpen && !wasOpen) titleTried.clear();   // fresh open → backfill missing titles
    }
    else if (typeof d.__mlSidebarComposer === "string") composerOpen.value = d.__mlSidebarComposer === "open";   // Spotlight bar
    else if (d.__mlSidebarCardEndDrag) endActiveCardDrag?.();   // shell's safety net force-ended a stuck drag → clean up our listeners
}

function mount(): void {
    initThemeStyle();
    const root = document.getElementById("root") || document.body;
    chrome.storage.sync.get(DEFAULT_CONFIG, (cfg: any) => { config.value = cfg as MlConfig; applyTheme(); });
    chrome.storage.local.get({ [FONT_KEY]: 1, [WRAP_KEY]: true, [LINES_KEY]: false }, (d: any) => {
        if (d[FONT_KEY]) fontScale.value = d[FONT_KEY]; applyFont();
        codeWrap.value = d[WRAP_KEY] !== false; codeLineNumbers.value = !!d[LINES_KEY]; applyCodePrefs();
    });
    applyTheme();
    applyCodePrefs();
    fetchModels();
    render(<Root />, root);

    window.addEventListener("message", onMessage);
    // Live-sync config edits made elsewhere (e.g. the popup) into the settings form.
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "sync") return;
        const patch: Record<string, unknown> = {};
        for (const k in changes) patch[k] = changes[k].newValue;
        config.value = { ...config.value, ...patch };
        if (changes.theme) applyTheme();
    });
    // Tell the shell we're listening; it then handshakes injected.js on the page.
    window.parent.postMessage({ __mlSidebarApp: "ready" }, "*");
}

mount();
