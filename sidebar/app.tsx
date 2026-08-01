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
import { elementReference } from "../dom";
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
import { IconCopy, IconCheck, IconWarn, IconChevron, IconGear, IconExport, IconVram, IconSend, IconUsage, IconBench } from "./icons";
import { Settings } from "./settings";

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
        const step = { step: ev.step, seq: ev.seq, pending: ev.pending, awaitingApproval: ev.awaitingApproval, thought: ev.thought, reasoning: ev.reasoning, tool: ev.tool, arguments: ev.arguments, result: ev.result, elements: ev.elements, renderIn: ev.renderIn, renderOut: ev.renderOut, argIssues: ev.argIssues, approval: ev.approval, usage: ev.usage };
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
        s.lastTs = ev.ts; rev.value++; return;
    }
    if (ev.kind === "agent-result") {
        const s = sessionMap.get(ev.session.hash);
        if (!s) return;
        s.summary = ev.summary; s.hitCap = ev.hitCap; s.status = ev.hitCap ? "err" : "ok"; s.lastTs = ev.ts;
        rev.value++; return;
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
                ? <details class="thinking"><summary>thinking</summary><div class="md" dangerouslySetInnerHTML={{ __html: markdown(reasoning) }} /></details>
                : null}
            {status === "pending"
                ? <div class="pending-note">…thinking</div>
                : error
                    ? <div class="errtext">{error}</div>
                    : collapsed
                        ? <div class="asst-collapsed" onClick={() => setCollapsed(false)}>{preview!.text}{preview!.more ? <span class="more"> …</span> : null}</div>
                        : showRaw
                            ? <Code text={content} lang="markdown" />
                            : <div class="md" dangerouslySetInnerHTML={{ __html: markdown(content) }} />}
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
            <b class="row-title">{truncate(title, 80)}</b>
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
                        <span class="r-el-idx">#{it.index ?? i}</span>
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
                        <span class="tt r-py-src"><span class="r-py-srcval">{src.short}</span><span class="tt-pop left" role="tooltip">{src.tip}</span></span>
                    </div>
                    {t.rows ? <PyDfTable columns={t.columns || []} rows={t.rows} />
                        : <div class="dim r-py-more">loaded via pd.read_html (no clean row preview)</div>}
                </div>;
            })}
            <Code text={d.code} lang="python" />
        </div>
    );
}
// `python_exec`'s Out slot: captured stdout, then one of a returned image / a minted
// @pt·@box token / the raw value / a Python traceback.
function PythonOutRender({ d }: { d: Extract<RenderDescriptor, { type: "python-out" }> }) {
    return (
        <div class="r-python r-py-out">
            {d.stdout ? <div class="r-py-stdout"><div class="r-py-lbl">stdout</div><Code text={d.stdout} lang="text" /></div> : null}
            {d.image ? <div class="r-image"><ClickableImg src={d.image} alt="output image" /><div class="r-image-label">returned image</div></div> : null}
            {d.token ? <div class="r-py-token"><div class="r-py-lbl">token</div><code class="r-hoverable" onPointerEnter={() => highlightToken(d.token!)} onPointerLeave={clearHighlight}>{d.token}</code></div> : null}
            {d.error ? <div class="r-py-err"><div class="r-py-lbl">error</div><Code text={d.error} lang="text" /></div> : null}
            {d.value != null && !d.image && !d.token && !d.error ? <div class="r-py-val"><div class="r-py-lbl">value</div><Code text={d.value} lang="json" /></div> : null}
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
        case "locate": return <LocateRender d={d} />;
        case "python-in": return <PythonInRender d={d} />;
        case "python-out": return <PythonOutRender d={d} />;
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
interface AgentTurnGroup { step: number; thought?: string; reasoning?: string | null; tools: AgentStep[]; }
function groupTurns(steps: AgentStep[]): AgentTurnGroup[] {
    const byStep = new Map<number, AgentTurnGroup>();
    const order: number[] = [];
    for (const st of steps) {
        let t = byStep.get(st.step);
        if (!t) { t = { step: st.step, tools: [] }; byStep.set(st.step, t); order.push(st.step); }
        if (st.thought != null) t.thought = st.thought;
        if (st.reasoning != null) t.reasoning = st.reasoning;
        if (st.tool) t.tools.push(st);
    }
    return order.map(s => byStep.get(s)!);
}

const StepPill = ({ step, max }: { step: number; max?: number }) =>
    <span class="step-pill">step {step}{max ? `/${max}` : ""}</span>;

// A turn's prose (content, `kind:"thought"`) OR its separate reasoning channel
// (reasoning_content, `kind:"thinking"`) — the two are DISTINCT: `content` is what the model
// says, `reasoning` is how it thinks. Both use the same collapsible pattern (collapsed to the
// first line); a thinking block is dimmed to read as secondary to the prose.
function ThoughtBlock({ thought, kind = "thought" }: { thought: string; kind?: "thought" | "thinking" }) {
    const [open, setOpen] = useState(false);
    const p = collapsedPreview(thought);
    return (
        <div class={`athought${kind === "thinking" ? " athinking" : ""}`}>
            <button class="astep-head" onClick={() => setOpen(v => !v)}>
                <span class={`tri${open ? " open" : ""}`} aria-hidden="true"><IconChevron /></span>
                <Dot status="ok" />
                <span class="who">{kind}</span>
                {!open ? <span class="astep-preview">{p.text}{p.more ? " …" : ""}</span> : null}
            </button>
            {open ? <div class="md astep-body" dangerouslySetInnerHTML={{ __html: markdown(thought) }} /> : null}
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
} as const;
const ApprovalBadge = ({ approval }: { approval: "readonly" | "sandbox" | "user" | "denied" }) => (
    <span class="tt">
        <span class={`appr ${approval === "denied" ? "no" : "yes"}`}>{APPROVAL[approval].label}</span>
        <span class="tt-pop left" role="tooltip">{APPROVAL[approval].tip}</span>
    </span>
);

// The distinct EXTERNAL Google Sheet ids a python-in render loads. Approving such a call grants
// the run access to those spreadsheets for the rest of the page-session, so the gate discloses it.
function externalSheetGrant(d?: RenderDescriptor): string[] {
    if (!d || d.type !== "python-in") return [];
    return [...new Set((d.tables || []).filter(t => t.source.kind === "sheet-external").map(t => t.source.label))];
}

function ToolStep({ st, hash }: { st: AgentStep; hash?: string }) {
    const [expanded, setExpanded] = useState(false);
    const [decided, setDecided] = useState(false);   // hide the controls the instant we click (before the DONE lands)
    const args = st.arguments && Object.keys(st.arguments).length ? st.arguments : null;
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
    const decide = (ok: boolean) => { setExpanded(true); setDecided(true); sendApproval(hash!, st.seq!, ok); };
    // When a step starts awaiting approval, scroll it into view so a gate mid-run isn't missed.
    const approveRef = useRef<HTMLDivElement>(null);
    useEffect(() => { if (awaiting) approveRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }); }, [awaiting]);
    // Consent scope: approving a python_exec that loads an EXTERNAL Google Sheet caches that
    // spreadsheet for the rest of the page-session (later calls to it won't re-prompt). Tell the
    // human the approval is a session-scoped grant, not a one-shot.
    const sheetGrants = awaiting ? externalSheetGrant(inRender) : [];
    return (
        <div class={`astep tool${st.pending ? " pending" : ""}${awaiting ? " awaiting" : ""}${st.approval ? (st.approval === "denied" ? " appr-no" : " appr-yes") : ""}`}>
            <button class="astep-head" onClick={() => setExpanded(v => !v)}>
                <span class={`tri${open ? " open" : ""}`} aria-hidden="true"><IconChevron /></span>
                <Dot status={st.pending ? "pending" : toolFailed(st.result) ? "err" : "ok"} />
                <span class="tool-name">{st.tool}</span>
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
            {/* Approval bar at the BOTTOM — after In/Out — so you review the call (its rendered In)
                before the approve/deny controls, and it reads as the last thing to act on. */}
            {awaiting
                ? <div class="astep-approve" ref={approveRef}>
                    {sheetGrants.length
                        ? <div class="appr-note"><IconWarn /><span>Approving grants this run access to {sheetGrants.length === 1 ? "Google Sheet" : "Google Sheets"} <b>{sheetGrants.join(", ")}</b> for the rest of this session — later calls to {sheetGrants.length === 1 ? "it" : "them"} won't re-prompt.</span></div>
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

// One turn = the pill + the thought + the tool calls it batched.
function AgentTurn({ turn, max, hash }: { turn: AgentTurnGroup; max?: number; hash?: string }) {
    return (
        <div class="aturn">
            <div class="aturn-head"><StepPill step={turn.step} max={max} /></div>
            {turn.reasoning ? <ThoughtBlock thought={turn.reasoning} kind="thinking" /> : null}
            {turn.thought ? <ThoughtBlock thought={turn.thought} kind="thought" /> : null}
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

function AgentRunView({ s }: { s: Session }) {
    const turns = groupTurns(s.steps || []);
    return (
        <>
            <AgentOptionsBlock s={s} />
            <div class="msg user">
                <div class="mrow"><span class="who">task</span><span class="sp" /><Stamp ts={s.createdTs} /></div>
                <div class="utext">{s.task}</div>
            </div>
            {/* Skip an empty step group — one carrying only a usage sample (the final
                answer's token counts), no thought or tool, would render a bare pill. */}
            {turns.filter(t => t.thought || t.tools.length).map(t => <AgentTurn key={t.step} turn={t} max={s.maxSteps} hash={s.hash} />)}
            {s.summary != null
                ? <ReplyBubble content={s.summary} status={s.status} model={s.model}
                    profile={sessionProfile(s)} ts={s.lastTs}
                    label={s.hitCap ? "stopped (step cap)" : undefined} capped={s.hitCap} />
                : <div class="pending-note">…running ({turnsRun(s.steps)} steps)</div>}
        </>
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

// A placeholder chat composer at the bottom of a session. Not wired up yet — the
// long-term plan is to append user messages to a live session from here — so the
// input and both buttons are disabled. It exists now to host the usage gauge and
// stake out the layout (upload + · input · send · gauge).
function Composer({ s }: { s: Session }) {
    return (
        <div class="composer">
            <div class="composer-row">
                <button class="tt cbtn" disabled aria-label="Upload an image">＋<span class="tt-pop left above" role="tooltip">Attach an image — coming soon (you'll be able to paste screenshots here)</span></button>
                <input class="cinput" type="text" disabled placeholder="Send a message to this session… (coming soon)" />
                <button class="tt cbtn csend" disabled aria-label="Send"><IconSend /><span class="tt-pop above" role="tooltip">Send — coming soon</span></button>
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
function pyBenchDescriptor(r: { ok: boolean; value?: unknown; stdout: string; error?: string }): RenderDescriptor {
    const stdout = r.stdout || undefined;
    if (!r.ok) return { type: "python-out", stdout, error: r.error || "error" };
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
            <div class="bench-note">Runs against the SAME sandbox <code>python_exec</code> uses (offscreen → worker → Pyodide). Code-only — no page image/tables. <code>return</code> a value; <code>print()</code> is captured. 15s cap.</div>
            <textarea ref={taRef} class="bench-code code" spellcheck={false} value={code} onInput={e => setCode((e.target as HTMLTextAreaElement).value)} onKeyDown={onKey} placeholder="return 6 * 7" />
            <div class="bench-bar">
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
            <div class="view" data-rev={r}>
                {v.name === "settings" ? <Settings />
                    : v.name === "bench" ? <PythonBench />
                        : v.name === "list" ? <ListView />
                            : <DetailView hash={v.hash} />}
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
    else if (d.__mlDebugReset) resetSessions();
    else if (typeof d.__mlSidebarOpen === "boolean") {
        const wasOpen = sidebarOpen.value;
        sidebarOpen.value = d.__mlSidebarOpen;
        if (d.__mlSidebarOpen && !wasOpen) titleTried.clear();   // fresh open → backfill missing titles
    }
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
    render(<App />, root);

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
