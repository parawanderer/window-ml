// Debug sidebar — isolated content-script world, built with Preact. An opt-in,
// slide-out panel that logs every window.ml call, grouped into sessions (one per
// createChat). injected.js pushes a one-way event stream over window.postMessage
// ({ __mlDebug: MlDebugEvent }); we aggregate events into sessions by hash and
// render a list ⇄ detail UI. Bundled (Preact + signals) into dist/sidebar.js only
// — the core primitive stays dependency-free.
import { render } from "preact";
import { useState } from "preact/hooks";
import { signal } from "@preact/signals";
import type { MlDebugEvent, DebugSessionConfig, NeutralMessage } from "../contract";
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
const view = signal<{ name: "list" } | { name: "detail"; hash: string }>({ name: "list" });
const fontScale = signal(1);
const settingsOpen = signal(false);

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

// Copy to clipboard, with a fallback for non-secure (http) pages where the async
// Clipboard API is unavailable.
function copyText(text: string): Promise<void> {
    if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
    return new Promise((resolve, reject) => {
        try {
            const ta = document.createElement("textarea");
            ta.value = text; ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
            document.body.appendChild(ta); ta.focus(); ta.select();
            document.execCommand("copy"); ta.remove(); resolve();
        } catch (e) { reject(e); }
    });
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

// Timestamp: compact label, exact full stamp on hover.
const Stamp = ({ ts }: { ts?: number }) => (
    <span class="tt">
        <span class="time">{shortStamp(ts)}</span>
        <span class="tt-pop" role="tooltip">{fullStamp(ts)}</span>
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
            <Stamp ts={s.lastTs} />
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

const IconGear = () => (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3">
        <circle cx="8" cy="8" r="2.1" />
        <path d="M8 1.5v1.4M8 13.1v1.4M14.5 8h-1.4M2.9 8H1.5M12.6 3.4l-1 1M4.4 11.6l-1 1M12.6 12.6l-1-1M4.4 4.4l-1-1" />
    </svg>
);

// Settings panel (toggled from the header gear). Font size scales the readable
// content; persisted to chrome.storage.local like the panel width.
function Settings() {
    const pct = Math.round(fontScale.value * 100);
    const setScale = (s: number) => {
        fontScale.value = Math.min(MAX_FS, Math.max(MIN_FS, Math.round(s * 20) / 20));
        applyFont();
        chrome.storage.local.set({ [FONT_KEY]: fontScale.value });
    };
    return (
        <div class="settings">
            <div class="set-row">
                <span class="set-label">Font size</span>
                <span class="sp" />
                <div class="stepper">
                    <button title="Smaller" onClick={() => setScale(fontScale.value - 0.1)}>−</button>
                    <span class="set-val">{pct}%</span>
                    <button title="Larger" onClick={() => setScale(fontScale.value + 0.1)}>+</button>
                    <button class="reset" title="Reset to 100%" onClick={() => setScale(1)}>reset</button>
                </div>
            </div>
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
    return (
        <div class="app">
            <div class="head">
                {v.name === "detail" ? <button class="nav" title="Back to sessions" onClick={() => (view.value = { name: "list" })}>‹</button> : null}
                <b>{v.name === "detail" ? (sessionMap.get(v.hash)?.model || "default") : `Sessions (${sessionMap.size})`}</b>
                <span class="sp" />
                {v.name === "detail" ? <Hash hash={v.hash} /> : null}
                <button class={`gear${settingsOpen.value ? " on" : ""}`} title="Settings" onClick={() => (settingsOpen.value = !settingsOpen.value)}><IconGear /></button>
            </div>
            {settingsOpen.value ? <Settings /> : null}
            <div class="view" data-rev={r}>{v.name === "list" ? <ListView /> : <DetailView hash={v.hash} />}</div>
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
let themePref = "auto";
const resolveTheme = (): "dark" | "light" =>
    (themePref === "light" || themePref === "dark") ? themePref : (themeMedia.matches ? "dark" : "light");
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
    if (e.source !== window.parent || !d || !d.__mlDebug) return;
    onDebug(d.__mlDebug as MlDebugEvent);
}

function mount(): void {
    hljsStyleEl = document.createElement("style");
    document.head.append(hljsStyleEl);
    const root = document.getElementById("root") || document.body;
    chrome.storage.sync.get({ theme: "auto" }, (cfg: any) => { themePref = cfg.theme || "auto"; applyTheme(); });
    chrome.storage.local.get({ [FONT_KEY]: 1 }, (d: any) => { if (d[FONT_KEY]) fontScale.value = d[FONT_KEY]; applyFont(); });
    applyTheme();
    render(<App />, root);

    window.addEventListener("message", onMessage);
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === "sync" && changes.theme) { themePref = (changes.theme.newValue as string) || "auto"; applyTheme(); }
    });
    // Tell the shell we're listening; it then handshakes injected.js on the page.
    window.parent.postMessage({ __mlSidebarApp: "ready" }, "*");
}

mount();
