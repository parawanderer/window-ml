// Debug sidebar — isolated content-script world, built with Preact. An opt-in,
// slide-out panel that logs every window.ml call, grouped into sessions (one per
// createChat). injected.js pushes a one-way event stream over window.postMessage
// ({ __mlDebug: MlDebugEvent }); we aggregate events into sessions by hash and
// render a list ⇄ detail UI. Bundled (Preact + signals) into dist/sidebar.js only
// — the core primitive stays dependency-free.
import { render, type VNode } from "preact";
import { useState } from "preact/hooks";
import { signal } from "@preact/signals";
import type { MlDebugEvent, DebugChatRequest, NeutralMessage } from "../contract";
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

const WIDTH_KEY = "ml_debug_width";
const MIN_W = 280, TAB_W = 34;

type Status = "pending" | "ok" | "err";
interface Turn {
    id: string; ts: number; user: string; images: string[] | null;
    assistant?: string; sources?: unknown[] | null; structured?: boolean; error?: string; status: Status;
}
interface Session {
    hash: string; model: string | null; tag: "session" | "saved";
    createdTs: number; lastTs: number; status: Status;
    options: DebugChatRequest; system: string | null; turns: Turn[];
}

// --- state: a Map (O(1) lookup) + a version signal to notify Preact of changes ---
const sessionMap = new Map<string, Session>();
const rev = signal(0);
const view = signal<{ name: "list" } | { name: "detail"; hash: string }>({ name: "list" });
const open = signal(false);
const width = signal<number | null>(null);

/* -------------------------------- helpers -------------------------------- */
const pretty = (v: unknown, max = 6000): string => {
    let s: string;
    try { s = typeof v === "string" ? v : JSON.stringify(v, null, 2); } catch { s = String(v); }
    return s.length > max ? s.slice(0, max) + `\n… (${s.length - max} more chars)` : s;
};
const timeStr = (ts?: number): string => new Date(ts || Date.now()).toLocaleTimeString();
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
            const sys = ev.request.messages.find(m => m.role === "system");
            s = {
                hash: ev.session.hash, model: ev.request.model, tag: ev.save ? "saved" : "session",
                createdTs: ev.ts, lastTs: ev.ts, status: "pending", options: ev.request,
                system: sys ? (typeof sys.content === "string" ? sys.content : pretty(sys.content)) : null, turns: [],
            };
            sessionMap.set(ev.session.hash, s);
        }
        if (ev.save) s.tag = "saved";
        s.turns.push({ id: ev.id, ts: ev.ts, user: lastUser(ev.request.messages), images: ev.request.images, status: "pending" });
        s.lastTs = ev.ts; s.status = "pending";
    } else {
        const s = sessionMap.get(ev.session.hash);
        const t = s?.turns.find(x => x.id === ev.id);
        if (!s || !t) return;
        if (ev.kind === "chat-result") { t.assistant = ev.content; t.sources = ev.sources; t.structured = ev.structured; t.status = "ok"; }
        else { t.error = ev.error; t.status = "err"; }
        t.ts = ev.ts; s.lastTs = ev.ts; s.status = rollupStatus(s);
    }
    rev.value++;   // notify Preact
}

/* ------------------------------ components ------------------------------- */
const Dot = ({ status }: { status: Status }) =>
    <span class={`dot ${status}`} title={status === "pending" ? "in flight" : status} />;

// Syntax-highlighted code block (highlight() returns safe token HTML).
const Code = ({ text, lang }: { text: string; lang?: string }) =>
    <pre class="code"><code class="hljs" dangerouslySetInnerHTML={{ __html: highlight(text, lang) }} /></pre>;

function RawToggle({ label, nice, raw, startRaw }: { label: string; nice: () => VNode; raw: () => VNode; startRaw?: boolean }) {
    const [showRaw, setShowRaw] = useState(!!startRaw);
    return (
        <div class="block">
            <div class="block-head">
                <span class="block-label">{label}</span>
                <span class="sp" />
                <button class="raw-btn" onClick={() => setShowRaw(!showRaw)}>{showRaw ? "nice" : "raw"}</button>
            </div>
            <div class="tbody">{showRaw ? raw() : nice()}</div>
        </div>
    );
}

function OptionsBlock({ s }: { s: Session }) {
    const o = s.options;
    const lines: string[] = [`model: ${o.model || "default"}`];
    if (s.system) lines.push(`system: ${truncate(s.system, 200)}`);
    if (o.schema) lines.push("schema: yes (structured output)");
    if (o.toolIds?.length) lines.push(`toolIds: ${o.toolIds.join(", ")}`);
    if (o.think === true || o.think === false) lines.push(`think: ${o.think}`);
    if (o.maxTokens != null) lines.push(`maxTokens: ${o.maxTokens}`);
    if (o.images?.length) lines.push(`images: ${o.images.length}`);
    return <RawToggle label="options" startRaw={false}
        nice={() => <pre class="opts">{lines.join("\n")}</pre>}
        raw={() => <Code text={pretty(o)} lang="json" />} />;
}

function MessageTurn({ t }: { t: Turn }) {
    return (
        <>
            <div class="msg user">
                <div class="mrow"><span class="who">user</span><span class="sp" /><span class="time">{timeStr(t.ts)}</span></div>
                <div class="utext">{t.user}</div>
                {t.images?.length ? <div class="thumbs">{t.images.map((src, i) => <img key={i} src={src} />)}</div> : null}
            </div>
            <div class={`msg asst ${t.status}`}>
                <div class="mrow"><Dot status={t.status} /><span class="who">assistant</span><span class="sp" /><span class="time">{timeStr(t.ts)}</span></div>
                {t.status === "pending"
                    ? <div class="pending-note">…thinking</div>
                    : t.status === "err"
                        ? <div class="errtext">{t.error || "(error)"}</div>
                        : <>
                            <RawToggle label={t.structured ? "response (structured)" : "response"} startRaw={!!t.structured}
                                nice={() => <div class="md" dangerouslySetInnerHTML={{ __html: markdown(t.assistant || "") }} />}
                                raw={() => <Code text={t.assistant || ""} lang="markdown" />} />
                            {t.sources?.length
                                ? <details class="sources"><summary>{`sources (${t.sources.length})`}</summary><Code text={pretty(t.sources)} lang="json" /></details>
                                : null}
                        </>}
            </div>
        </>
    );
}

function SessionRow({ s }: { s: Session }) {
    const title = s.turns[0]?.user || "(no prompt)";
    return (
        <button class="row" onClick={() => (view.value = { name: "detail", hash: s.hash })}>
            <Dot status={s.status} />
            <b class="row-title">{truncate(title, 80)}</b>
            <div class="row-meta">
                <span class={`tag ${s.tag}`}>{s.tag}</span>
                <span class="model">{s.model || "default"}</span>
                <code class="hash">{s.hash}</code>
                <span class="time">{timeStr(s.lastTs)}</span>
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
    rev.value; // subscribe
    const s = sessionMap.get(hash);
    if (!s) return <div class="empty">Session not found.</div>;
    return <><OptionsBlock s={s} />{s.turns.map(t => <MessageTurn key={t.id} t={t} />)}</>;
}

function Resize() {
    const onDown = (e: PointerEvent) => {
        e.preventDefault();
        const handle = e.currentTarget as HTMLElement;
        handle.setPointerCapture(e.pointerId);
        const onMove = (ev: PointerEvent) => { width.value = Math.max(MIN_W, Math.min(window.innerWidth * 0.95, window.innerWidth - ev.clientX + TAB_W)); };
        const onUp = () => {
            handle.removeEventListener("pointermove", onMove);
            handle.removeEventListener("pointerup", onUp);
            if (width.value) chrome.storage.local.set({ [WIDTH_KEY]: Math.round(width.value) });
        };
        handle.addEventListener("pointermove", onMove);
        handle.addEventListener("pointerup", onUp);
    };
    return <div class="resize" title="Drag to resize" onPointerDown={onDown} />;
}

function App() {
    const v = view.value;
    const count = (rev.value, sessionMap.size);   // read rev.value → re-render on change
    return (
        <div class={`wrap${open.value ? " open" : ""}`} style={width.value ? { width: `${width.value}px` } : undefined}>
            <button class="tab" title="window.ml debug" onClick={() => (open.value = !open.value)}>ml · debug</button>
            <div class="body">
                <Resize />
                <div class="head">
                    {v.name === "detail" ? <button class="nav" title="Back to sessions" onClick={() => (view.value = { name: "list" })}>‹</button> : null}
                    <b>{v.name === "detail" ? (sessionMap.get(v.hash)?.model || "default") : `Sessions (${count})`}</b>
                    <span class="sp" />
                    {v.name === "detail" ? <code class="hash">{v.hash}</code> : null}
                </div>
                <div class="view">{v.name === "list" ? <ListView /> : <DetailView hash={v.hash} />}</div>
            </div>
        </div>
    );
}

/* --------------------------------- mount --------------------------------- */
let hostEl: HTMLElement | null = null;
let mountPoint: HTMLElement | null = null;
let hljsStyleEl: HTMLStyleElement | null = null;   // holds the active Atom One theme
const themeMedia = window.matchMedia("(prefers-color-scheme: dark)");
let themePref = "auto";
const resolveTheme = (): "dark" | "light" =>
    (themePref === "light" || themePref === "dark") ? themePref : (themeMedia.matches ? "dark" : "light");
const applyTheme = () => {
    const t = resolveTheme();
    hostEl?.setAttribute("data-theme", t);
    if (hljsStyleEl) hljsStyleEl.textContent = t === "dark" ? atomOneDark : atomOneLight;
};
themeMedia.addEventListener("change", applyTheme);

function onMessage(e: MessageEvent): void {
    const d = e.data as any;
    if (e.source !== window || !d || !d.__mlDebug) return;
    onDebug(d.__mlDebug as MlDebugEvent);
}

async function mount(): Promise<void> {
    if (hostEl) return;
    hostEl = document.createElement("div");
    hostEl.id = "ml-debug-sidebar-host";
    hostEl.style.cssText = "all: initial;";
    applyTheme();
    const root = hostEl.attachShadow({ mode: "open" });

    let css = "";
    try { css = await fetch(chrome.runtime.getURL("sidebar.css")).then(r => r.text()); }
    catch (e) { console.error("ml debug sidebar: failed to load css", e); hostEl = null; return; }
    if (!hostEl) return;

    const style = document.createElement("style"); style.textContent = css; root.append(style);
    hljsStyleEl = document.createElement("style"); root.append(hljsStyleEl); applyTheme();   // Atom One theme for highlighted code
    mountPoint = document.createElement("div"); root.append(mountPoint);
    chrome.storage.local.get({ [WIDTH_KEY]: 0 }, (d: any) => { if (d[WIDTH_KEY]) width.value = d[WIDTH_KEY]; });
    render(<App />, mountPoint);
    (document.documentElement || document.body).append(hostEl);

    window.addEventListener("message", onMessage);
    window.postMessage({ __mlSidebar: "ready" }, "*");   // handshake → injected.js emits
}

function unmount(): void {
    if (!hostEl) return;
    window.removeEventListener("message", onMessage);
    if (mountPoint) render(null, mountPoint);
    hostEl.remove();
    hostEl = mountPoint = hljsStyleEl = null;
    sessionMap.clear();
    view.value = { name: "list" };
    rev.value++;
}

/* ----------------------- config gate + live toggle ----------------------- */
chrome.storage.sync.get({ sidebar: false, theme: "auto" }, (cfg: any) => {
    themePref = cfg.theme || "auto";
    if (cfg.sidebar) mount();
});
chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    if (changes.theme) { themePref = (changes.theme.newValue as string) || "auto"; applyTheme(); }
    if (changes.sidebar) { if (changes.sidebar.newValue) mount(); else unmount(); }
});
