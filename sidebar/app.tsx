// Debug sidebar — isolated content-script world, built with Preact. An opt-in,
// slide-out panel that logs every window.ml call, grouped into sessions (one per
// createChat). injected.js pushes a one-way event stream over window.postMessage
// ({ __mlDebug: MlDebugEvent }); we aggregate events into sessions by hash and
// render a list ⇄ detail UI. Bundled (Preact + signals) into dist/sidebar.js only
// — the core primitive stays dependency-free.
import { render } from "preact";
import type { ComponentChildren } from "preact";
import { useState, useEffect } from "preact/hooks";
import { signal } from "@preact/signals";
import type { MlDebugEvent, DebugSessionConfig, NeutralMessage, MlConfig, ApiFormat, Theme, LoadedModel, ExtendProfile, RenderDescriptor } from "../contract";
import { DEFAULT_CONFIG } from "../contract";
// Syntax highlighting — highlight.js core + a focused set of languages, and the
// Atom One themes (imported as CSS text, injected into the shadow root).
import hljs from "highlight.js/lib/core";
import json from "highlight.js/lib/languages/json";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import python from "highlight.js/lib/languages/python";
import bash from "highlight.js/lib/languages/bash";
import xml from "highlight.js/lib/languages/xml";
import cssLang from "highlight.js/lib/languages/css";
import mdLang from "highlight.js/lib/languages/markdown";
import atomOneDark from "highlight.js/styles/atom-one-dark.css";
import atomOneLight from "highlight.js/styles/atom-one-light.css";

for (const [name, lang] of [
    ["json", json], ["javascript", javascript], ["typescript", typescript], ["python", python],
    ["bash", bash], ["xml", xml], ["css", cssLang], ["markdown", mdLang],
] as const) hljs.registerLanguage(name, lang);

const FONT_KEY = "ml_debug_fontscale";
const BASE_FS = 12, MIN_FS = 0.8, MAX_FS = 1.6;   // font-scale bounds (× BASE_FS px)

type Status = "pending" | "ok" | "err";
interface Turn {
    id: string; ts: number; user: string; images: string[] | null;
    assistant?: string; sources?: unknown[] | null; structured?: boolean; error?: string; status: Status;
    reqModel?: string | null;   // the model the caller explicitly requested (null = fell back to default/utility)
    model?: string | null;      // the model that actually produced this reply (resolved server-side)
    extend?: ExtendProfile | null;  // which profile resolved it — marks (default) vs (utility)
    reasoning?: string | null;  // separate thinking/reasoning text, if the model produced any
}
interface AgentStep { step: number; thought?: string; tool?: string; arguments?: Record<string, unknown>; result?: string; elements?: number; render?: RenderDescriptor; }
interface Session {
    hash: string; model: string | null; tag: "session" | "saved";
    createdTs: number; lastTs: number; status: Status;
    config: DebugSessionConfig; turns: Turn[];
    title?: string;   // AI-summarised title (lazy; see title generation below)
    // ml.agent runs (kind === "agent"): a task + a list of steps + a final summary.
    kind?: "agent";
    task?: string;
    steps?: AgentStep[];
    summary?: string;
    hitCap?: boolean;
    maxSteps?: number;
}

// --- state: a Map (O(1) lookup) + a version signal to notify Preact of changes ---
const sessionMap = new Map<string, Session>();
const rev = signal(0);
const view = signal<{ name: "list" } | { name: "detail"; hash: string } | { name: "settings" }>({ name: "list" });
const fontScale = signal(1);
const config = signal<MlConfig>(DEFAULT_CONFIG);   // live mirror of chrome.storage.sync
const models = signal<string[]>([]);               // server model ids (for the datalists)
const ollamaIds = signal<string[] | null>(null);   // subset that's Ollama-backed (null = can't tell → skip cloud detection)
const vramOpen = signal(false);                    // VRAM monitor panel toggled on?
const sidebarOpen = signal(false);                 // is the shell slid open? (gates polling)
const loadedModels = signal<LoadedModel[] | null>(null);   // OLLAMA_PS resident set (null until first poll)
const psError = signal<string | null>(null);               // OLLAMA_PS failure (no Ollama backend)

/* -------------------------------- helpers -------------------------------- */
const pretty = (v: unknown, max = 6000): string => {
    let s: string;
    try { s = typeof v === "string" ? v : JSON.stringify(v, null, 2); } catch { s = String(v); }
    return s.length > max ? s.slice(0, max) + `\n… (${s.length - max} more chars)` : s;
};
// Compact label that stays unambiguous past today: time-only for today, else a
// short date + time. The exact full stamp (with seconds) rides along on hover.
const shortStamp = (ts?: number): string => {
    const d = new Date(ts || Date.now());
    if (d.toDateString() === new Date().toDateString())
        return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
};
const fullStamp = (ts?: number): string =>
    new Date(ts || Date.now()).toLocaleString(undefined,
        { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const truncate = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + "…" : s);
// One-line preview for a collapsed assistant reply: first non-empty line,
// truncated. `more` marks that content is hidden (so we show a trailing …).
function collapsedPreview(s: string): { text: string; more: boolean } {
    const full = (s || "").trim();
    const first = full.split("\n").map(x => x.trim()).find(Boolean) || "";
    const text = truncate(first, 100);
    return { text, more: text !== full };
}
const escapeHtml = (s: string): string =>
    s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

// Minimal, SAFE markdown → HTML (escape first, then a small subset; fenced code
// is protected from inline formatting). Used via dangerouslySetInnerHTML.
function highlight(code: string, lang?: string): string {
    try {
        if (lang === "text" || lang === "plain") return escapeHtml(code);   // opt out of auto-detect
        if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang }).value;
        return hljs.highlightAuto(code).value;
    } catch { return escapeHtml(code); }
}

function markdown(src: string): string {
    const codeBlocks: string[] = [];
    // Pull fenced code from the RAW source first (highlighted, not double-escaped),
    // stashed behind an ASCII placeholder restored at the end.
    const stashed = src.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang: string, code: string) => {
        codeBlocks.push(`<pre class="code"><code class="hljs">${highlight(code.replace(/\n$/, ""), lang || undefined)}</code></pre>`);
        return `\n@@CODE${codeBlocks.length - 1}@@\n`;
    });
    const text = escapeHtml(stashed);
    const inline = (t: string): string => t
        .replace(/`([^`]+)`/g, "<code>$1</code>")
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
        .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    const out: string[] = [];
    let list: string[] | null = null;
    const flush = () => { if (list) { out.push("<ul>" + list.join("") + "</ul>"); list = null; } };
    for (const raw of text.split("\n")) {
        const line = raw.trimEnd();
        const h = line.match(/^(#{1,6})\s+(.*)$/);
        const li = line.match(/^[-*]\s+(.*)$/);
        if (h) { flush(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); }
        else if (li) { (list ??= []).push(`<li>${inline(li[1])}</li>`); }
        else if (!line.trim()) { flush(); }
        else { flush(); out.push(`<p>${inline(line)}</p>`); }
    }
    flush();
    return out.join("").replace(/@@CODE(\d+)@@/g, (_, i: string) => codeBlocks[+i]);
}

function lastUser(messages: NeutralMessage[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "user") { const c = messages[i].content; return typeof c === "string" ? c : pretty(c); }
    }
    return "";
}
const rollupStatus = (s: Session): Status =>
    s.turns.some(t => t.status === "pending") ? "pending" : s.turns.some(t => t.status === "err") ? "err" : "ok";

function onDebug(ev: MlDebugEvent): void {
    // --- ml.agent runs (own session kind) ---
    if (ev.kind === "agent") {
        sessionMap.set(ev.session.hash, {
            hash: ev.session.hash, model: ev.model, tag: "session", kind: "agent",
            createdTs: ev.ts, lastTs: ev.ts, status: "pending", turns: [], steps: [], task: ev.task, maxSteps: ev.maxSteps,
            config: { system: null, model: ev.model, think: null, schema: false, toolIds: null, maxTokens: null, save: false },
        });
        rev.value++; return;
    }
    if (ev.kind === "agent-step") {
        const s = sessionMap.get(ev.session.hash);
        if (!s) return;
        s.steps = [...(s.steps || []), { step: ev.step, thought: ev.thought, tool: ev.tool, arguments: ev.arguments, result: ev.result, elements: ev.elements, render: ev.render }];
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
            ? { ...prev, assistant: ev.content, sources: ev.sources, structured: ev.structured, status: "ok", ts: ev.ts, model: ev.model, extend: ev.extend, reasoning: ev.reasoning }
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

// Syntax-highlighted code block (highlight() returns safe token HTML).
const Code = ({ text, lang }: { text: string; lang?: string }) =>
    <pre class="code"><code class="hljs" dangerouslySetInnerHTML={{ __html: highlight(text, lang) }} /></pre>;

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

const IconCopy = () => (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4">
        <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
        <path d="M10.5 5.5V3.5A1.5 1.5 0 0 0 9 2H3.5A1.5 1.5 0 0 0 2 3.5V9a1.5 1.5 0 0 0 1.5 1.5h2" />
    </svg>
);
const IconCheck = () => (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.7">
        <path d="M3 8.5l3.5 3.5L13 4.5" />
    </svg>
);

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

// Disclosure chevron (the ▸ glyph renders tiny; an SVG is crisp and scalable).
const IconChevron = () => (
    <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.9">
        <path d="M6 3.5L10.5 8L6 12.5" />
    </svg>
);

// createChat defaults — values equal to these get a `// default` annotation in
// the raw options view so it's obvious what the caller actually set.
const CONFIG_DEFAULTS: Record<string, unknown> = {
    system: null, model: null, think: false, schema: false, toolIds: null, maxTokens: null, save: false,
};
// Pretty JSON with a trailing `// default` on each line whose value matches the
// default (rendered as JS so highlight.js styles the comments; the copy button
// still copies clean JSON).
function annotatedConfig(c: DebugSessionConfig): string {
    const entries = Object.entries(c);
    const body = entries.map(([k, v], i) => {
        const val = JSON.stringify(v);
        const isDefault = val === JSON.stringify(CONFIG_DEFAULTS[k]);
        return `  ${JSON.stringify(k)}: ${val}${i < entries.length - 1 ? "," : ""}${isDefault ? "  // default" : ""}`;
    });
    return `{\n${body.join("\n")}\n}`;
}

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

// Which profile produced a turn, for the (default)/(utility) tag beside the
// model name. An explicitly-requested model gets no tag — only a fell-back-to
// resolution is worth flagging.
function turnProfile(t: Turn): "utility" | "default" | null {
    if (t.reqModel) return null;
    return t.extend === "utility" ? "utility" : "default";
}
// Predict a turn's model from the config the same way the background resolves it,
// so a *pending* turn shows the real model (not "default") before its result
// lands — we already know the config client-side.
function resolveModel(reqModel?: string | null, extend?: ExtendProfile | null): string {
    if (reqModel) return reqModel;
    if (extend === "utility") return config.value.utilityModel || config.value.model || "default";
    return config.value.model || "default";
}
// A session's model/profile follows its latest turn (the best predictor of what
// responds next). Turn-based so it distinguishes an explicit model (no tag) from
// a default fallback, and it works for a pending turn too.
const shownModel = (s: Session): string => {
    const last = s.turns[s.turns.length - 1];
    if (last?.status === "ok" && last.model) return last.model;   // actually resolved
    return last ? resolveModel(last.reqModel, last.extend) : resolveModel(s.config.model, null);
};
function sessionProfile(s: Session): "utility" | "default" | null {
    const last = s.turns[s.turns.length - 1];
    return last ? turnProfile(last) : null;
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

// Assistant reply: no visible box around the text (#5). The markdown⇄raw toggle
// and a copy button (copies raw markdown, #6) sit on the right of the header row.
function AssistantBody({ t }: { t: Turn }) {
    const [showRaw, setShowRaw] = useState(!!t.structured);
    const [collapsed, setCollapsed] = useState(false);
    const done = t.status === "ok";
    const preview = done ? collapsedPreview(t.assistant || "") : null;
    return (
        <>
            <div class="mrow">
                <Dot status={t.status} />
                {/* The chevron + label toggle collapse (only when there's a reply). */}
                {done
                    ? <button class="who-toggle" title={collapsed ? "expand" : "collapse"} onClick={() => setCollapsed(v => !v)}>
                        <span class={`tri${collapsed ? "" : " open"}`} aria-hidden="true"><IconChevron /></span>
                        <span class="who">assistant</span>
                    </button>
                    : <span class="who">assistant</span>}
                {/* The model that produced this reply + its (default)/(utility) profile. */}
                {done && t.model ? <CopyModel model={t.model} /> : null}
                {done && t.model && turnProfile(t) ? <span class="profile-inline">({turnProfile(t)})</span> : null}
                <span class="sp" />
                {done
                    ? <>
                        <CopyBtn text={t.assistant || ""} tip="copy markdown" />
                        {collapsed ? null : <button class="raw-btn" onClick={() => setShowRaw(v => !v)}>{showRaw ? "nice" : "raw"}</button>}
                    </>
                    : null}
                <Stamp ts={t.ts} />
            </div>
            {/* Reasoning/thinking text (separate from the reply), collapsed by default. */}
            {done && !collapsed && t.reasoning
                ? <details class="thinking"><summary>thinking</summary><div class="md" dangerouslySetInnerHTML={{ __html: markdown(t.reasoning) }} /></details>
                : null}
            {t.status === "pending"
                ? <div class="pending-note">…thinking</div>
                : t.status === "err"
                    ? <div class="errtext">{t.error || "(error)"}</div>
                    : collapsed
                        ? <div class="asst-collapsed" onClick={() => setCollapsed(false)}>{preview!.text}{preview!.more ? <span class="more"> …</span> : null}</div>
                        : showRaw
                            ? <Code text={t.assistant || ""} lang="markdown" />
                            : <div class="md" dangerouslySetInnerHTML={{ __html: markdown(t.assistant || "") }} />}
            {t.sources?.length
                ? <details class="sources"><summary>{`sources (${t.sources.length})`}</summary><Code text={pretty(t.sources)} lang="json" /></details>
                : null}
        </>
    );
}

function MessageTurn({ t }: { t: Turn }) {
    return (
        <>
            <div class="msg user">
                <div class="mrow"><span class="who">user</span><span class="sp" /><Stamp ts={t.ts} /></div>
                <div class="utext">{t.user}</div>
                {t.images?.length ? <div class="thumbs">{t.images.map((src, i) => <img key={i} src={src} />)}</div> : null}
            </div>
            <div class={`msg asst ${t.status}`}><AssistantBody t={t} /></div>
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

function SessionRow({ s, model, profile }: { s: Session; model: string; profile: "utility" | "default" | null }) {
    const title = s.title || s.task || s.turns[0]?.user || "(no prompt)";
    return (
        <button class="row" onClick={() => (view.value = { name: "detail", hash: s.hash })}>
            <Dot status={s.status} />
            <Stamp ts={s.lastTs} snap="right" />
            <b class="row-title">{truncate(title, 80)}</b>
            <div class="row-meta">
                {s.kind === "agent" ? <AgentBadge /> : <TagBadge tag={s.tag} />}
                <ProfileBadge profile={profile} />
                <span class="model">{model}</span>
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
            {items.map((it, i) => (
                <div class="r-el" key={it.index ?? i}>
                    <span class="r-el-idx">#{it.index ?? i}</span>
                    {it.text ? <span class="r-el-text">«{it.text}»</span> : null}
                    <code class="r-el-path">{it.path}</code>
                </div>
            ))}
        </div>
    );
}
function RenderTable({ columns, rows }: { columns: string[]; rows: (string | number)[][] }) {
    return (
        <div class="r-table-wrap">
            <table class="r-table">
                <thead><tr>{columns.map((c, i) => <th key={i}>{c}</th>)}</tr></thead>
                <tbody>{rows.map((row, i) => <tr key={i}>{row.map((c, j) => <td key={j}>{String(c)}</td>)}</tr>)}</tbody>
            </table>
        </div>
    );
}
function RenderPanel({ d }: { d: RenderDescriptor }) {
    switch (d.type) {
        case "image": return <div class="r-image"><img src={d.src} alt={d.label || "image"} />{d.label ? <div class="r-image-label">{d.label}</div> : null}</div>;
        case "code": return <Code text={d.text} lang={d.lang} />;
        case "table": return <RenderTable columns={d.columns} rows={d.rows} />;
        case "keyval": return <div class="r-keyval">{d.pairs.map(([k, v], i) => <div class="r-kv" key={i}><span class="r-k">{k}</span><span class="r-v">{v}</span></div>)}</div>;
        case "elements": return <RenderElements items={d.items} />;
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
                            <button class={showRaw ? "" : "on"} onClick={() => setShowRaw(false)}>rendered</button>
                            <button class={showRaw ? "on" : ""} onClick={() => setShowRaw(true)}>raw</button>
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

// A step of one ml.agent TURN (one LLM call): a thought + its batched tool calls.
interface AgentTurnGroup { step: number; thought?: string; tools: AgentStep[]; }
function groupTurns(steps: AgentStep[]): AgentTurnGroup[] {
    const byStep = new Map<number, AgentTurnGroup>();
    const order: number[] = [];
    for (const st of steps) {
        let t = byStep.get(st.step);
        if (!t) { t = { step: st.step, tools: [] }; byStep.set(st.step, t); order.push(st.step); }
        if (st.thought != null) t.thought = st.thought;
        if (st.tool) t.tools.push(st);
    }
    return order.map(s => byStep.get(s)!);
}

const StepPill = ({ step, max }: { step: number; max?: number }) =>
    <span class="step-pill">step {step}{max ? `/${max}` : ""}</span>;

// The model's reasoning for a turn (an LLM completion → status dot). Collapses to
// its first line.
function ThoughtBlock({ thought }: { thought: string }) {
    const [open, setOpen] = useState(false);
    const p = collapsedPreview(thought);
    return (
        <div class="athought">
            <button class="astep-head" onClick={() => setOpen(v => !v)}>
                <span class={`tri${open ? " open" : ""}`} aria-hidden="true"><IconChevron /></span>
                <Dot status="ok" />
                <span class="who">thought</span>
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
function ToolStep({ st }: { st: AgentStep }) {
    const [open, setOpen] = useState(false);
    const args = st.arguments && Object.keys(st.arguments).length ? st.arguments : null;
    // A descriptor renders the block it targets (default "out"); the other stays raw.
    const inRender = st.render?.target === "in" ? st.render : undefined;
    const outRender = st.render && st.render.target !== "in" ? st.render : undefined;
    return (
        <div class="astep tool">
            <button class="astep-head" onClick={() => setOpen(v => !v)}>
                <span class={`tri${open ? " open" : ""}`} aria-hidden="true"><IconChevron /></span>
                <Dot status={toolFailed(st.result) ? "err" : "ok"} />
                <span class="tool-name">{st.tool}</span>
                {st.elements ? <span class="el-count" title="DOM nodes returned (reach them in the console via onStep)">{st.elements} el</span> : null}
                {!open ? <span class="astep-preview">{collapsedPreview(st.result || "").text}</span> : null}
            </button>
            {open
                ? <div class="astep-body">
                    {args
                        ? <IoBlock label="In" tip="The arguments the model passed to this tool call."
                            preview={inlineJson(args)} render={inRender} raw={<Code text={pretty(args)} lang="json" />} />
                        : null}
                    <IoBlock label="Out" tip="What the tool returned to the model."
                        preview={inlineText(st.result || "")} render={outRender}
                        raw={st.result ? <Code text={st.result} lang="text" /> : <span class="dim">(no output)</span>} />
                </div>
                : null}
        </div>
    );
}

// One turn = the pill + the thought + the tool calls it batched.
function AgentTurn({ turn, max }: { turn: AgentTurnGroup; max?: number }) {
    return (
        <div class="aturn">
            <div class="aturn-head"><StepPill step={turn.step} max={max} /></div>
            {turn.thought ? <ThoughtBlock thought={turn.thought} /> : null}
            {turn.tools.map((st, i) => <ToolStep key={`${st.tool}-${i}`} st={st} />)}
        </div>
    );
}

function AgentRunView({ s }: { s: Session }) {
    const turns = groupTurns(s.steps || []);
    return (
        <>
            <div class="msg user">
                <div class="mrow"><span class="who">task</span><span class="sp" /><Stamp ts={s.createdTs} /></div>
                <div class="utext">{s.task}</div>
            </div>
            {turns.map(t => <AgentTurn key={t.step} turn={t} max={s.maxSteps} />)}
            {s.summary != null
                ? <div class={`agent-summary${s.hitCap ? " capped" : ""}`}>
                    <div class="mrow"><Dot status={s.status} /><span class="who">{s.hitCap ? "stopped (step cap)" : "answer"}</span><span class="sp" /><Stamp ts={s.lastTs} /></div>
                    <div class="md" dangerouslySetInnerHTML={{ __html: markdown(s.summary) }} />
                </div>
                : <div class="pending-note">…running ({(s.steps || []).length} steps)</div>}
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
    return <div class="list" data-rev={r}>{list.map(s => <SessionRow key={s.hash} s={s} model={shownModel(s)} profile={sessionProfile(s)} />)}</div>;
}

function DetailView({ hash }: { hash: string }) {
    // Re-renders via App's rev subscription (App cascades to this pure component);
    // turn updates are immutable (see onDebug) so children re-render too.
    const s = sessionMap.get(hash);
    if (!s) return <div class="empty">Session not found.</div>;
    if (s.kind === "agent") return <AgentRunView s={s} />;
    return <><OptionsBlock s={s} />{s.turns.map(t => <MessageTurn key={t.id} t={t} />)}</>;
}

// Gear — Heroicons "cog-6-tooth" (MIT, https://heroicons.com).
const IconGear = () => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
        <path d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.24-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z" />
        <path d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
    </svg>
);

// Fetch the server's model list via the background worker (privileged fetch);
// degrade silently if unreachable. Populates the datalists.
function fetchModels(): void {
    chrome.runtime.sendMessage({ type: "LIST_MODELS", payload: {} }, (resp: any) => {
        if (chrome.runtime.lastError || !resp || resp.error) return;
        models.value = resp.data || [];
        ollamaIds.value = resp.ollamaModels ?? null;   // null = provenance unknown (skip cloud detection)
    });
}

// Update one config field: mirror it into the signal (live UI), optionally
// persist to chrome.storage.sync (which the popup also reads → they sync).
function setField(key: keyof MlConfig, value: string | number | boolean, persist = true): void {
    config.value = { ...config.value, [key]: value };
    if (persist) chrome.storage.sync.set({ [key]: value });
    if (key === "theme") applyTheme();
}

// Clarification text — same wording as the popup's hints (keep in sync).
const TIP = {
    apiFormat: "Request and response shape — match it to the URL above.",
    model: "The model list loads automatically — start typing to pick one.",
    ocrModel: "Vision model ml.read() uses for OCR — kept separate from the chat model.",
    utilityModel: "A small, cheap model for side tasks like session-title summaries. Leave blank to reuse the main model. Suggestions: qwen3.5:0.8b for an average machine, a gemma4:e2b-class model for a beefier one.",
    utilityNumCtx: "Context window (num_ctx) for the utility model. Summarising needs little context — keep it small on modest hardware; larger just uses more KV-cache memory. Only used when a utility model is set.",
    utilityForceCpu: "Run the utility model on CPU (num_gpu: 0) so it never competes with your main model for VRAM. Only used when a utility model is set.",
    autoTitles: "Let the utility model generate a short title for each debug session. Off = sessions just show the first prompt. Only runs when a utility model is set and the panel is open.",
};

// Field label with an optional hover tooltip. Left-anchored (.left) so it opens
// rightward into the panel — far-left labels would clip a centered pop.
const Lbl = ({ children, tip }: { children: string; tip?: string }) =>
    tip
        ? <span class="tt">{children}<span class="tt-pop left" role="tooltip">{tip}</span></span>
        : <span>{children}</span>;

// --- model liveness test (per model) ---
type TestState = { status: "loading" | "ok" | "err"; error?: string };
const modelTests = signal<Record<string, TestState | undefined>>({});
const MODEL_ROLES: { key: keyof MlConfig; label: string }[] = [
    { key: "model", label: "Model" },
    { key: "ocrModel", label: "OCR" },
    { key: "utilityModel", label: "Utility" },
];

const setTest = (key: keyof MlConfig, state: TestState) => { modelTests.value = { ...modelTests.value, [key]: state }; };

// A generated PNG with a known short code — for genuinely testing OCR (a text
// ping would pass on ANY model without exercising vision). null if no canvas.
function ocrTestImage(): { dataUrl: string; token: string } | null {
    try {
        const alpha = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";   // no ambiguous 0/O/1/I/L
        let token = "";
        for (let i = 0; i < 4; i++) token += alpha[Math.floor(Math.random() * alpha.length)];
        const cv = document.createElement("canvas");
        cv.width = 240; cv.height = 96;
        const ctx = cv.getContext("2d");
        if (!ctx) return null;
        ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, cv.width, cv.height);
        ctx.fillStyle = "#000"; ctx.font = "bold 60px monospace"; ctx.textBaseline = "middle";
        ctx.fillText(token, 20, 50);
        return { dataUrl: cv.toDataURL("image/png"), token };
    } catch { return null; }
}

// Test one model via the background. Text models get a trivial ping; the OCR
// model actually transcribes a generated image and we verify the code returns.
function testOne(key: keyof MlConfig): void {
    const name = (config.value[key] as string).trim();
    if (!name) return;
    setTest(key, { status: "loading" });

    // The utility model is tested through its own profile (extend:"utility") so
    // the check exercises its real num_ctx + Force-CPU config, not just the name.
    const ping = { role: "user", content: "Reply with exactly: OK" };
    const img = key === "ocrModel" ? ocrTestImage() : null;
    const payload = img
        ? { messages: [{ role: "user", content: "Transcribe the characters in this image. Output only the characters.", images: [img.dataUrl] }], model: name, ocr: true }
        : key === "utilityModel"
            ? { messages: [ping], extend: "utility" }
            : { messages: [ping], model: name };

    chrome.runtime.sendMessage({ type: "FETCH_LLM", payload }, (resp: any) => {
        const err = chrome.runtime.lastError?.message || (resp && resp.error);
        if (err) return setTest(key, { status: "err", error: String(err) });
        if (img) {
            const got = String(resp.data || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
            return setTest(key, got.includes(img.token)
                ? { status: "ok" }
                : { status: "err", error: `read "${truncate(String(resp.data || ""), 40)}" — expected ${img.token}` });
        }
        setTest(key, { status: "ok" });
    });
}
const testModels = () => { for (const { key } of MODEL_ROLES) testOne(key); };

const TestIcon = ({ state }: { state: "idle" | "unset" | "loading" | "ok" | "err" }) => (
    <span class={`test-ic ${state}`}>
        {state === "ok" ? <IconCheck /> : state === "err" ? "✕" : state === "loading" ? "…" : state === "unset" ? "—" : ""}
    </span>
);

// "Test models" button + a per-model status row (loading/ok/err/not-set), errors below.
function ModelTests() {
    const t = modelTests.value;
    return (
        <div class="set-test">
            <button class="test-btn" onClick={testModels}>Test models</button>
            {MODEL_ROLES.map(({ key, label }) => {
                const name = (config.value[key] as string).trim();
                const state = !name ? "unset" : (t[key]?.status ?? "idle");
                return (
                    <div class="test-row" key={key}>
                        <TestIcon state={state} />
                        <span class="role">{label}</span>
                        <span class="name">{name || "not set"}</span>
                    </div>
                );
            })}
            {MODEL_ROLES.map(({ key }) => t[key]?.error
                ? <div class="test-err" key={key}>{truncate(t[key]!.error!, 160)}</div> : null)}
        </div>
    );
}

// Full settings view (mirrors the popup). Reads/writes chrome.storage.sync
// directly — safe because this runs in the extension-origin iframe, not the
// page DOM — so edits sync live with the popup. Text fields persist on change
// (blur) to avoid chatty storage writes; the signal updates on input for a
// responsive UI + the utility-field enable gating.
function Settings() {
    const c = config.value;
    const utilOn = !!c.utilityModel.trim();
    const pct = Math.round(fontScale.value * 100);
    const setScale = (s: number) => {
        fontScale.value = Math.min(MAX_FS, Math.max(MIN_FS, Math.round(s * 20) / 20));
        applyFont();
        chrome.storage.local.set({ [FONT_KEY]: fontScale.value });
    };
    const text = (key: keyof MlConfig, extra?: Record<string, unknown>) => ({
        type: "text", value: c[key] as string,
        onInput: (e: any) => setField(key, e.target.value, false),
        onChange: (e: any) => setField(key, e.target.value),
        ...extra,
    });
    return (
        <div class="settings">

            <div class="set-field"><span>Font size</span>
                <div class="stepper">
                    <button title="Smaller" onClick={() => setScale(fontScale.value - 0.1)}>−</button>
                    <span class="set-val">{pct}%</span>
                    <button title="Larger" onClick={() => setScale(fontScale.value + 0.1)}>+</button>
                    <button class="reset" title="Reset to 100%" onClick={() => setScale(1)}>reset</button>
                </div>
            </div>

            <datalist id="ml-models">{models.value.map(m => <option key={m} value={m} />)}</datalist>

            <div class="set-group">Connection</div>
            <div class="set-note">Point this at <b>OpenWebUI</b> for the full feature set — server-side (Python) tools, RAG, and web search all route through it. A direct <b>Ollama</b> URL works but only gives the plain text-chat subset.</div>
            <label class="set-field"><span>Chat completions URL</span>
                <input {...text("chatUrl")} class={c.chatUrl.trim() ? "" : "err"} />
                <div class="set-hint">OpenWebUI: /api/chat/completions · Ollama passthrough: /ollama/api/chat</div>
                {c.chatUrl.trim() ? null : <div class="set-err">Required — the extension won't work without this.</div>}
            </label>
            <label class="set-field"><span>API key</span>
                <input {...text("apiKey")} type="password" placeholder="OpenWebUI → Settings → Account" />
                <div class="set-hint">Generate one in OpenWebUI → Settings → Account → API keys.</div>
            </label>
            <label class="set-field"><Lbl tip={TIP.apiFormat}>API format</Lbl>
                <select value={c.apiFormat} onChange={(e: any) => setField("apiFormat", e.target.value as ApiFormat)}>
                    <option value="openai">OpenAI (…/chat/completions)</option>
                    <option value="ollama">Ollama native (…/api/chat)</option>
                </select></label>

            <div class="set-group">Models</div>
            <div class="set-note">These are the defaults <code>ml.chat</code> / <code>ml.createChat</code> use when you don't pass a <code>model</code>. With no default <b>Model</b> set, you must specify one on every call.</div>
            <label class="set-field"><Lbl tip={TIP.model}>Model</Lbl>
                <input {...text("model", { list: "ml-models", placeholder: "e.g. qwen3:14b" })} /></label>
            <label class="set-field"><Lbl tip={TIP.ocrModel}>OCR model (optional)</Lbl>
                <input {...text("ocrModel", { list: "ml-models", placeholder: "e.g. qwen2.5vl" })} /></label>
            <div class="set-note">If you set a utility model, then you can use it by using the shorthand: <br/><code>ml.chat("...", &#123; extend: "utility" &#125;);</code>.</div>
            <label class="set-field"><Lbl tip={TIP.utilityModel}>Utility model (optional)</Lbl>
                <input {...text("utilityModel", { list: "ml-models", placeholder: "blank = use main model" })} /></label>
            <label class="set-field"><Lbl tip={TIP.utilityNumCtx}>Utility model context size</Lbl>
                <input type="number" min="512" step="512" value={c.utilityNumCtx} disabled={!utilOn}
                    onChange={(e: any) => setField("utilityNumCtx", parseInt(e.target.value, 10) || DEFAULT_CONFIG.utilityNumCtx)} /></label>
            <label class={`set-check${utilOn ? "" : " off"}`}>
                <input type="checkbox" checked={c.utilityForceCpu} disabled={!utilOn}
                    onChange={(e: any) => setField("utilityForceCpu", e.target.checked)} />
                <Lbl tip={TIP.utilityForceCpu}>Force utility onto CPU</Lbl>
            </label>
            <label class={`set-check${utilOn ? "" : " off"}`}>
                <input type="checkbox" checked={c.autoTitles} disabled={!utilOn}
                    onChange={(e: any) => setField("autoTitles", e.target.checked)} />
                <Lbl tip={TIP.autoTitles}>Summarise chat titles with the utility model</Lbl>
            </label>
            <ModelTests />

            <div class="set-group">Appearance</div>
            <label class="set-field"><span>Theme</span>
                <select value={c.theme} onChange={(e: any) => setField("theme", e.target.value as Theme)}>
                    <option value="auto">Auto (system)</option>
                    <option value="dark">Dark</option>
                    <option value="light">Light</option>
                </select></label>
        </div>
    );
}

// --- VRAM monitor ---
const VRAM_COLORS = ["#6366f1", "#22c55e", "#f59e0b", "#ec4899", "#06b6d4", "#a855f7", "#ef4444", "#84cc16"];
const colorFor = (name: string) => VRAM_COLORS[[...name].reduce((a, c) => a + c.charCodeAt(0), 0) % VRAM_COLORS.length];
const VRAM_HISTORY = 45, VRAM_POLL_MS = 2000;
// Models the user has hidden from the totals/graph (session-only; a signal so it
// survives VramPanel remounts). Immutable Set updates so the signal notifies.
const hiddenModels = signal<Set<string>>(new Set());
const toggleHidden = (model: string): void => {
    const next = new Set(hiddenModels.value);
    next.has(model) ? next.delete(model) : next.add(model);
    hiddenModels.value = next;
};

const IconVram = () => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
        <path d="M3 12h4l2 5 4-13 3 8h5" />
    </svg>
);

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
        loadedModels.value = resp.data || [];
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
                            <span class="sp" />
                            <span class="vram-gb">{m.vramGB != null ? `${m.vramGB} GB` : m.sizeGB != null ? `${m.sizeGB} GB (CPU)` : "?"}</span>
                            <button class="vram-x" title="Evict from VRAM" onClick={() => evict(m.model)}>✕</button>
                        </div>
                    );
                })
                : <div class="vram-empty">Nothing loaded.</div>}
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
            <div class="head">
                {v.name !== "list" ? <button class="nav" title="Back to sessions" onClick={() => (view.value = { name: "list" })}>‹</button> : null}
                {detailSession
                    ? <>
                        <ModelStatusDot model={shownModel(detailSession)} inFlight={detailSession.status === "pending"} />
                        <span class="tt head-model">{shownModel(detailSession)}<span class="tt-pop left" role="tooltip">The model that will respond to your next message in this session.</span></span>
                        <ProfileBadge profile={sessionProfile(detailSession)} />
                        {detailSession.kind === "agent" ? <AgentBadge /> : null}
                    </>
                    : <b>{inSettings ? "Settings" : `Sessions (${sessionMap.size})`}</b>}
                <span class="sp" />
                {v.name === "detail" ? <Hash hash={v.hash} /> : null}
                {!inSettings ? <button class={`hbtn${vramOpen.value ? " on" : ""}`} title="VRAM monitor" onClick={() => (vramOpen.value = !vramOpen.value)}><IconVram /></button> : null}
                {!inSettings ? <button class="hbtn" title="Settings" onClick={() => { fetchModels(); view.value = { name: "settings" }; }}><IconGear /></button> : null}
            </div>
            {vramOpen.value && !inSettings ? <VramPanel /> : null}
            <div class="view" data-rev={r}>
                {v.name === "settings" ? <Settings />
                    : v.name === "list" ? <ListView />
                        : <DetailView hash={v.hash} />}
            </div>
        </div>
    );
}

/* --------------------------------- mount ---------------------------------
 * This runs INSIDE the sidebar iframe (an extension page — sidebar.html), which
 * the host web page can't read across the origin boundary. The content-script
 * shell (sidebar/shell.ts) hosts the iframe, relays each `__mlDebug` event in
 * via postMessage, and owns the slide-out container/tab/resize.
 */
let hljsStyleEl: HTMLStyleElement | null = null;   // holds the active Atom One theme
const themeMedia = window.matchMedia("(prefers-color-scheme: dark)");
const resolveTheme = (): "dark" | "light" => {
    const t = config.value.theme;
    return (t === "light" || t === "dark") ? t : (themeMedia.matches ? "dark" : "light");
};
const applyTheme = () => {
    const t = resolveTheme();
    document.documentElement.setAttribute("data-theme", t);
    if (hljsStyleEl) hljsStyleEl.textContent = t === "dark" ? atomOneDark : atomOneLight;
};
themeMedia.addEventListener("change", applyTheme);
// Font scale → the --fs custom property the content sizes key off.
const applyFont = () => document.documentElement.style.setProperty("--fs", `${(BASE_FS * fontScale.value).toFixed(2)}px`);

// Debug events are relayed in from the shell (the parent window); a bare page
// can't reach this iframe's message bus across the extension-origin boundary.
function onMessage(e: MessageEvent): void {
    const d = e.data as any;
    if (e.source !== window.parent || !d) return;
    if (d.__mlDebug) onDebug(d.__mlDebug as MlDebugEvent);
    else if (typeof d.__mlSidebarOpen === "boolean") {
        const wasOpen = sidebarOpen.value;
        sidebarOpen.value = d.__mlSidebarOpen;
        if (d.__mlSidebarOpen && !wasOpen) titleTried.clear();   // fresh open → backfill missing titles
    }
}

function mount(): void {
    hljsStyleEl = document.createElement("style");
    document.head.append(hljsStyleEl);
    const root = document.getElementById("root") || document.body;
    chrome.storage.sync.get(DEFAULT_CONFIG, (cfg: any) => { config.value = cfg as MlConfig; applyTheme(); });
    chrome.storage.local.get({ [FONT_KEY]: 1 }, (d: any) => { if (d[FONT_KEY]) fontScale.value = d[FONT_KEY]; applyFont(); });
    applyTheme();
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
