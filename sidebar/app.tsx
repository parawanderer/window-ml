// Debug sidebar — isolated content-script world, built with Preact. An opt-in,
// slide-out panel that logs every window.ml call, grouped into sessions (one per
// createChat). injected.js pushes a one-way event stream over window.postMessage
// ({ __mlDebug: MlDebugEvent }); we aggregate events into sessions by hash and
// render a list ⇄ detail UI. Bundled (Preact + signals) into dist/sidebar.js only
// — the core primitive stays dependency-free.
import { render } from "preact";
import { useState, useEffect } from "preact/hooks";
import { signal } from "@preact/signals";
import type { MlDebugEvent, DebugSessionConfig, NeutralMessage, MlConfig, ApiFormat, Theme, LoadedModel } from "../contract";
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
}
interface Session {
    hash: string; model: string | null; tag: "session" | "saved";
    createdTs: number; lastTs: number; status: Status;
    config: DebugSessionConfig; turns: Turn[];
}

// --- state: a Map (O(1) lookup) + a version signal to notify Preact of changes ---
const sessionMap = new Map<string, Session>();
const rev = signal(0);
const view = signal<{ name: "list" } | { name: "detail"; hash: string } | { name: "settings" }>({ name: "list" });
const fontScale = signal(1);
const config = signal<MlConfig>(DEFAULT_CONFIG);   // live mirror of chrome.storage.sync
const models = signal<string[]>([]);               // server model ids (for the datalists)
const vramOpen = signal(false);                    // VRAM monitor panel toggled on?
const sidebarOpen = signal(false);                 // is the shell slid open? (gates polling)

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
const escapeHtml = (s: string): string =>
    s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

// Minimal, SAFE markdown → HTML (escape first, then a small subset; fenced code
// is protected from inline formatting). Used via dangerouslySetInnerHTML.
function highlight(code: string, lang?: string): string {
    try {
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
        const turn: Turn = { id: ev.id, ts: ev.ts, user: lastUser(ev.request.messages), images: ev.request.images, status: "pending" };
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
            ? { ...prev, assistant: ev.content, sources: ev.sources, structured: ev.structured, status: "ok", ts: ev.ts }
            : { ...prev, error: ev.error, status: "err", ts: ev.ts };
        s.turns = s.turns.map((x, idx) => idx === i ? updated : x);
        s.lastTs = ev.ts; s.status = rollupStatus(s);
    }
    rev.value++;   // notify Preact
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
    system: null, model: null, think: false, cleanup: true, schema: false, toolIds: null, maxTokens: null, save: false,
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
    if (!c.cleanup) lines.push("cleanup: false");
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

// Assistant reply: no visible box around the text (#5). The markdown⇄raw toggle
// and a copy button (copies raw markdown, #6) sit on the right of the header row.
function AssistantBody({ t }: { t: Turn }) {
    const [showRaw, setShowRaw] = useState(!!t.structured);
    return (
        <>
            <div class="mrow">
                <Dot status={t.status} />
                <span class="who">assistant</span>
                <span class="sp" />
                {t.status === "ok"
                    ? <>
                        <CopyBtn text={t.assistant || ""} tip="copy markdown" />
                        <button class="raw-btn" onClick={() => setShowRaw(v => !v)}>{showRaw ? "nice" : "raw"}</button>
                    </>
                    : null}
                <Stamp ts={t.ts} />
            </div>
            {t.status === "pending"
                ? <div class="pending-note">…thinking</div>
                : t.status === "err"
                    ? <div class="errtext">{t.error || "(error)"}</div>
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

function SessionRow({ s }: { s: Session }) {
    const title = s.turns[0]?.user || "(no prompt)";
    return (
        <button class="row" onClick={() => (view.value = { name: "detail", hash: s.hash })}>
            <Dot status={s.status} />
            <Stamp ts={s.lastTs} snap="right" />
            <b class="row-title">{truncate(title, 80)}</b>
            <div class="row-meta">
                <TagBadge tag={s.tag} />
                <span class="model">{s.model || "default"}</span>
                <Hash hash={s.hash} stop />
            </div>
        </button>
    );
}

function ListView() {
    rev.value; // subscribe to session changes
    const list = [...sessionMap.values()].sort((a, b) => b.lastTs - a.lastTs);
    if (!list.length) return <div class="empty">No ml calls yet. Run one in the console.</div>;
    return <>{list.map(s => <SessionRow key={s.hash} s={s} />)}</>;
}

function DetailView({ hash }: { hash: string }) {
    // Re-renders via App's rev subscription (App cascades to this pure component);
    // turn updates are immutable (see onDebug) so children re-render too.
    const s = sessionMap.get(hash);
    if (!s) return <div class="empty">Session not found.</div>;
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

const IconVram = () => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
        <path d="M3 12h4l2 5 4-13 3 8h5" />
    </svg>
);

// Live VRAM: a sparkline of total usage over time + a per-model legend with
// evict controls. Polls OLLAMA_PS while mounted AND the sidebar is slid open
// (gated on sidebarOpen so it never hammers Ollama in the background). No
// manual refresh — that's the whole point.
function VramPanel() {
    const [loaded, setLoaded] = useState<LoadedModel[] | null>(null);
    const [history, setHistory] = useState<number[]>([]);
    const [err, setErr] = useState<string | null>(null);

    const poll = () => {
        if (!sidebarOpen.value) return;   // paused while slid closed
        chrome.runtime.sendMessage({ type: "OLLAMA_PS", payload: {} }, (resp: any) => {
            if (chrome.runtime.lastError || (resp && resp.error)) {
                setErr((resp && resp.error) || chrome.runtime.lastError?.message || "unavailable");
                setLoaded([]); return;
            }
            setErr(null);
            const list: LoadedModel[] = resp.data || [];
            setLoaded(list);
            const total = list.reduce((s, m) => s + (m.vramGB || 0), 0);
            setHistory(h => [...h, total].slice(-VRAM_HISTORY));
        });
    };
    useEffect(() => {
        poll();
        const id = setInterval(poll, VRAM_POLL_MS);
        return () => clearInterval(id);
    }, []);

    const evict = (model?: string) =>
        chrome.runtime.sendMessage({ type: "OLLAMA_UNLOAD", payload: model ? { model } : {} }, () => poll());

    if (err) return <div class="vram"><div class="vram-empty">VRAM unavailable — no Ollama backend.</div></div>;

    const total = history.length ? history[history.length - 1] : 0;
    const W = 240, H = 34;
    const yMax = Math.max(1, ...history) * 1.15;
    const pts = history.length > 1
        ? history.map((v, i) => `${((i / (history.length - 1)) * W).toFixed(1)},${(H - (v / yMax) * H).toFixed(1)}`).join(" ")
        : "";
    return (
        <div class="vram">
            <div class="vram-head">
                <span class="vram-total">{total.toFixed(1)} GB in use</span>
                <span class="sp" />
                {loaded && loaded.length ? <button class="vram-free" onClick={() => evict()}>Free VRAM</button> : null}
            </div>
            <svg class="vram-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
                {pts ? <polyline points={pts} fill="none" stroke="var(--accent)" stroke-width="1.5" /> : null}
            </svg>
            {loaded && loaded.length
                ? loaded.map(m => (
                    <div class="vram-row" key={m.model}>
                        <span class="vram-dot" style={{ background: colorFor(m.model) }} />
                        <span class="vram-name">{m.model}</span>
                        <span class="sp" />
                        <span class="vram-gb">{m.vramGB != null ? `${m.vramGB} GB` : "?"}</span>
                        <button class="vram-x" title="Evict from VRAM" onClick={() => evict(m.model)}>✕</button>
                    </div>
                ))
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
    return (
        <div class="app">
            <div class="head">
                {v.name !== "list" ? <button class="nav" title="Back to sessions" onClick={() => (view.value = { name: "list" })}>‹</button> : null}
                <b>{v.name === "detail" ? (sessionMap.get(v.hash)?.model || "default") : inSettings ? "Settings" : `Sessions (${sessionMap.size})`}</b>
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
    else if (typeof d.__mlSidebarOpen === "boolean") sidebarOpen.value = d.__mlSidebarOpen;
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
