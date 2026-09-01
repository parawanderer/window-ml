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
import type { MlDebugEvent, DebugSessionConfig, DebugAgentConfig, MlConfig, ApiFormat, Theme, LoadedModel, ExtendProfile, RenderDescriptor, TokenUsage, ElementContext, AnswerMedia } from "../contract";
import { DEFAULT_CONFIG, fmtCtx } from "../contract";
import { externalSheetIds } from "../dom";
import {
    FONT_KEY, WRAP_KEY, LINES_KEY,
    sessionMap, rev, view, fontScale, codeWrap, codeLineNumbers, config, models,
    ollamaIds, vramOpen, sidebarOpen, loadedModels, psError, turnsRun, backendError,
    cardShowWorkHash, revealSeq, surface, atBottom,
} from "./store";
import {
    Code, ContextMenu, ClickableImg, AnswerMediaGallery, Hash,
    highlightEl, clearHighlight, highlightApprove, highlightPos, decideGate, decidedSteps, stepKey,
    inlineJson, inlineText, SheetChip,
} from "./ui-kit";
import { RenderPanel } from "./render-panel";
import { scrollToStepSeq, AnswerBody, ResultBlock } from "./answer-render";
import {
    onDebug, buildRunBlocks, maybeGenerateTitles, ensureBlockSummary, blockSummaries, blockKey, groupTurns,
    genTitle, titleTried,
} from "./debug-reducer";
import type { AgentTurnGroup, RunTaskBlock } from "./debug-reducer";
import { OptionsBlock, MessageTurn, ProfileBadge, SessionRow, AgentBadge } from "./reply";
import {
    AgentRunView, AgentTurn, SteerSeen, HostAccessNote, OutputRaiseNote, GrantCard, hasPersistGrants,
    externalSheetGrant, KEEP_HINT,
} from "./agent-detail";
import {
    utilitySummariesOn, codeSummaries, codeOf, intentFor, ensureCodeSummary, ensureActionSummary,
} from "./summaries";
import { isBackendUnreachable, resolveOutputCap } from "../contract";
import type { PersistGrant } from "../contract";
import type { Status, Turn, AgentStep, Session } from "./store";
import { pretty, truncate, collapsedPreview, highlight, markdown, stripFormatting } from "./format";
import { hasTokens } from "../answer-tokens";
import { shownModel, sessionProfile } from "./model";
import { exportSession, printSession } from "./export";
import { applyTheme, applyFont, applyCodePrefs, initThemeStyle } from "./prefs";
import { IconWarn, IconChevron, IconGear, IconExport, IconVram, IconSend, IconStop, IconUsage, IconBench, IconEye, IconEyeOff } from "./icons";
import { Settings } from "./settings";


/* ------------------------------ components ------------------------------- */




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

// --- proactive backend-health probe (drives the offline banner + the HUD card's offline state) ---
// A run/chat failure isn't the only way to learn the box is down — probe the CHAT backend DIRECTLY so a dead
// box surfaces even before/without a run, and AUTO-RECOVERS when it's back. LIST_MODELS hits the configured
// chatUrl (backend-agnostic; it throws a network error when unreachable, an HTTP/"no models" error when it's
// up). A HANGING box (packets dropped, not refused) never calls back — so a no-RESPONSE within the window
// ALSO counts as unreachable (the "stuck on Starting…" case the user hit). Sets/clears `backendError`.
const BACKEND_HEALTH_MS = 6000;          // probe cadence while the app is mounted
const BACKEND_HEALTH_TIMEOUT_MS = 6000;  // no response by here → treat as unreachable (a hanging box)
let healthInFlight = false;
function pollBackendHealth(): void {
    if (healthInFlight) return;   // one in flight at a time; the timeout guarantees it always settles
    healthInFlight = true;
    let settled = false;
    const finish = (unreachable: string | null): void => {
        if (settled) return;
        settled = true; healthInFlight = false;
        backendError.value = unreachable || "";
    };
    const timer = setTimeout(
        () => finish(`Couldn't reach the server at ${config.value.chatUrl || "the configured URL"} — no response. Is it running?`),
        BACKEND_HEALTH_TIMEOUT_MS);
    try {
        chrome.runtime.sendMessage({ type: "LIST_MODELS", payload: {} }, (resp: { error?: string } | undefined) => {
            clearTimeout(timer);
            const err = chrome.runtime.lastError?.message || resp?.error || "";
            // Only a NETWORK-level failure means "the box is gone". An HTTP / "no models installed" error means
            // the server ANSWERED → reachable (clear). Any data likewise → reachable.
            finish(err && isBackendUnreachable(err) ? err : null);
        });
    } catch { clearTimeout(timer); finish(null); }   // extension context gone → don't nag
}

// "expires in Xs/Xm" from an /api/ps expires_at ISO stamp (Ollama's TTL).
function expiresIn(expiresAt: string | null): string | null {
    if (!expiresAt) return null;
    const ms = new Date(expiresAt).getTime() - Date.now();
    if (isNaN(ms) || ms <= 0) return null;
    const s = Math.round(ms / 1000);
    return s < 90 ? `expires in ${s}s` : `expires in ${Math.round(s / 60)}m`;
}

// Live keep-alive countdown from an /api/ps expires_at stamp, as a compact
// two-unit d/h/m/s string ("2d 3h", "5m 12s", "44s") for the VRAM row. Ollama
// evicts a model once this hits zero; each use resets it (Ollama recomputes
// expires_at). Returns null when there's no stamp or it's already elapsed.
function fmtTTL(expiresAt: string | null): string | null {
    if (!expiresAt) return null;
    const ms = new Date(expiresAt).getTime() - Date.now();
    if (isNaN(ms) || ms <= 0) return null;
    let s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400); s -= d * 86400;
    const h = Math.floor(s / 3600); s -= h * 3600;
    const m = Math.floor(s / 60); s -= m * 60;
    if (d) return `${d}d ${h}h`;
    if (h) return `${h}h ${m}m`;
    if (m) return `${m}m ${s}s`;
    return `${s}s`;
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

// DELEGATED sub-call spend this turn — the auto-wired look/locate/verify make their own vision
// calls the loop never sees; bus.ts meters them and rides a running tally on each agent-step. This
// is NOT occupancy (a separate context, gone after each call), so the bar shows it as an extra "+N"
// chip, not folded into the fill. The LATEST step's tally is the turn total (it's cumulative). Chat
// sessions never delegate → always null.
function sessionSubcall(s: Session): { tokens: number; calls: number } | null {
    if (s.kind !== "agent") return null;
    const subs = (s.steps || []).map(st => st.subUsage).filter((u): u is NonNullable<typeof u> => !!u && !!u.calls);
    if (!subs.length) return null;
    const last = subs[subs.length - 1];
    return { tokens: last.prompt + last.completion, calls: last.calls };
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

// A small ghosted chip beside the usage bar: tokens spent this turn on DELEGATED vision sub-calls
// (look/locate/verify). Distinct from the fill — it's separate SPEND, not context occupancy — so it
// reads as "+N sub" with its own tooltip. Null → renders nothing (no delegated calls this turn).
function SubcallChip({ s }: { s: Session }) {
    const sub = sessionSubcall(s);
    if (!sub) return null;
    return (
        <span class="tt usage-sub">
            +{fmtCtx(sub.tokens)} sub
            <span class="tt-pop wrap above" role="tooltip">
                {sub.tokens.toLocaleString()} tokens over {sub.calls} delegated vision sub-call{sub.calls === 1 ? "" : "s"} this turn
                (look/locate/verify make their own model calls). This is separate SPEND, not context occupancy — each runs in
                its own context that's discarded after the call, so it isn't part of the % on the left.
            </span>
        </span>
    );
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
            <>
            <span class="tt usage-gauge">
                <span class="usage-ic" aria-hidden="true"><IconUsage /></span>
                <span class="usage-track"><span class="usage-fill" style={{ width: `${Math.min(100, frac * 100).toFixed(1)}%`, background: usageHue(frac) }} /></span>
                <span class="usage-pct">{pct}%</span>
                <span class="tt-pop wrap above" role="tooltip">
                    Context: {occupancy.toLocaleString()} / {limit.toLocaleString()} tokens ({pct}%).
                    This is the live window occupancy — every turn re-sends the whole history. Near 100% the model starts truncating.
                </span>
            </span>
            <SubcallChip s={s} />
            </>
        );
    }
    // Window unknown (a model we've never seen resident — a true cloud model): show the
    // raw occupancy, no %/bar. Same number as above, just no denominator to divide by.
    return (
        <>
        <span class="tt usage-gauge">
            <span class="usage-ic" aria-hidden="true"><IconUsage /></span>
            <span class="usage-total">{fmtCtx(occupancy)} tok</span>
            <span class="tt-pop wrap above" role="tooltip">
                {occupancy.toLocaleString()} tokens in context (latest turn). No context limit is known for this model{model ? ` ("${model}")` : ""} — it's never been resident in Ollama (a cloud model?), so there's no window size to show a % against.
            </span>
        </span>
        <SubcallChip s={s} />
        </>
    );
}

// The session composer: drive a live createAgent session from the sidebar. Sending routes to the page
// (via the parent shell/panel) → the handle by hash: STEER a running loop (say) or start a new turn (run),
// the page deciding from the handle's live state. Claude-Code touch: while a run is IN FLIGHT and the box
// is EMPTY, the submit button becomes a STOP that cancels; type anything and it's a send again.
// Shared image-attach state for BOTH composers (session + Spotlight): a file upload or a clipboard paste
// becomes data URLs, with a `loading` count so the thumb strip can show spinners while FileReader decodes.
function useImageAttach() {
    const [imgs, setImgs] = useState<string[]>([]);
    const [loading, setLoading] = useState(0);
    const fileRef = useRef<HTMLInputElement>(null);
    const addFiles = (files: FileList | File[] | null | undefined) => {
        const list = [...(files || [])].filter(f => f && f.type.startsWith("image/"));
        if (!list.length) return;
        setLoading(n => n + list.length);
        for (const f of list) {
            const rd = new FileReader();
            rd.onload = () => { const url = String(rd.result || ""); if (url.startsWith("data:image/")) setImgs(a => [...a, url]); setLoading(n => Math.max(0, n - 1)); };
            rd.onerror = () => setLoading(n => Math.max(0, n - 1));
            rd.readAsDataURL(f);
        }
    };
    // Paste a screenshot straight into the box (the common flow). Returns true when it consumed an image
    // (so the caller can preventDefault); false lets a normal text paste through.
    const onPaste = (e: ClipboardEvent): void => {
        const files = [...(e.clipboardData?.items || [])].filter(it => it.kind === "file" && it.type.startsWith("image/")).map(it => it.getAsFile()).filter(Boolean) as File[];
        if (!files.length) return;
        e.preventDefault();
        addFiles(files);
    };
    return { imgs, setImgs, loading, addFiles, onPaste, fileRef, remove: (i: number) => setImgs(a => a.filter((_, j) => j !== i)), clear: () => setImgs([]) };
}

// The attached-image thumbnail strip: previews with an × to remove, plus spinner placeholders for
// in-flight decodes. Renders nothing when there are no images and nothing decoding.
function ThumbStrip({ imgs, loading, onRemove }: { imgs: string[]; loading: number; onRemove: (i: number) => void }) {
    if (!imgs.length && !loading) return null;
    return (
        <div class="cthumbs">
            {imgs.map((src, i) => (
                <div class="cthumb" key={i}>
                    <img src={src} alt="attachment" />
                    <button class="cthumb-x" onClick={() => onRemove(i)} aria-label="Remove image" title="Remove">×</button>
                </div>
            ))}
            {Array.from({ length: loading }, (_, i) => <div class="cthumb cthumb-load" key={`l${i}`}><span class="cspin" /></div>)}
        </div>
    );
}

// The right-click "ask about this" reference pill: a removable chip naming the resolved container (role +
// the leaf you clicked). Hovering it BOXES that container on the live page (reuses the hover-highlight),
// so you see exactly what context is captured before sending.
function ElementPill({ ctx, onRemove }: { ctx: ElementContext; onRemove: () => void }) {
    const label = ctx.anchorText ? `${ctx.role || "element"} · "${truncate(ctx.anchorText, 30)}"` : (ctx.role || "element");
    return (
        <div class="el-pill" onPointerEnter={() => highlightEl(ctx.selector)} onPointerLeave={clearHighlight} title={ctx.selector}>
            <span class="el-pill-ic" aria-hidden="true">📌</span>
            <span class="el-pill-txt">{label}</span>
            <button class="el-pill-x" onClick={onRemove} aria-label="Remove element context" title="Remove">×</button>
        </div>
    );
}

function Composer({ s }: { s: Session }) {
    const r = rev.value;   // subscribe: `s.status` is mutated in place (same ref), so without a signal read this
                           // stateful child won't re-render when the run goes pending/idle → the Stop button.
    const [text, setText] = useState("");
    const att = useImageAttach();
    // Every session is continuable: an AGENT session has a steerable handle in the page's registry
    // (say/run/cancel); a plain CHAT session continues via its history in the session registry (a fresh turn,
    // or the in-flight fetch aborted). The page routes `sessionSend`/`sessionCancel` to whichever it is.
    const agent = s.kind === "agent";
    const running = s.status === "pending";
    const empty = !text.trim() && !att.imgs.length;   // an IMAGE-only send is allowed
    const stop = running && empty;   // in-flight + empty box → the button cancels the run/turn (Claude-Code style)
    const cancel = () => window.parent.postMessage({ __mlSidebarApp: "sessionCancel", hash: s.hash }, "*");
    const send = () => {
        const t = text.trim();
        if (!t && !att.imgs.length) return;
        window.parent.postMessage({ __mlSidebarApp: "sessionSend", hash: s.hash, text: t, images: att.imgs }, "*");
        setText(""); att.clear();
    };
    const act = () => (stop ? cancel() : send());
    // Enter SENDS only — it must NEVER cancel a run (pressing Enter with an empty box while a run is in
    // flight used to hit the Stop path and kill the run out of nowhere). Cancelling is the Stop BUTTON only.
    const onKey = (e: KeyboardEvent) => { if (e.key === "Enter" && !e.shiftKey && !empty) { e.preventDefault(); send(); } };
    const placeholder = running ? (agent ? "Steer this run, or send to queue a follow-up…" : "Sending… or stop this turn")
        : "Send a message (or paste a screenshot) to continue…";
    return (
        <div class="composer" data-rev={r}>
            <ThumbStrip imgs={att.imgs} loading={att.loading} onRemove={att.remove} />
            <div class="composer-row">
                <input ref={att.fileRef} type="file" accept="image/*" multiple style="display:none"
                    onChange={e => { att.addFiles((e.target as HTMLInputElement).files); (e.target as HTMLInputElement).value = ""; }} />
                <button class="tt cbtn" onClick={() => att.fileRef.current?.click()} aria-label="Attach an image">＋<span class="tt-pop left above" role="tooltip">Attach an image (or paste a screenshot into the box)</span></button>
                <input class="cinput" type="text" value={text} onInput={e => setText((e.target as HTMLInputElement).value)} onKeyDown={onKey} onPaste={att.onPaste}
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
    // Tick once a second so the TTL countdowns tick down smoothly between the
    // slower /api/ps polls (VRAM_POLL_MS). Cleared on unmount (the panel is only
    // mounted while open) so it never keeps a jsdom test window alive.
    const [, tick] = useState(0);
    useEffect(() => { const id = setInterval(() => tick(t => t + 1), 1000); return () => clearInterval(id); }, []);
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
                            {fmtTTL(m.expiresAt) ? (
                                <span class="tt vram-ttl">{fmtTTL(m.expiresAt)}
                                    <span class="tt-pop left" role="tooltip">Keep-alive TTL — Ollama evicts this model from {m.vramGB ? "VRAM" : "memory"} when the countdown reaches zero (expires {new Date(m.expiresAt!).toLocaleTimeString()}). Each use resets it. Set <code>keep_alive</code> to change how long it lingers.</span>
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
// surface signal now lives in ./store (cross-surface).
// Multi-run HUD state. The card shows ONE run (the SELECTED one); a tab strip switches between concurrent
// runs. These are keyed by run hash so one run's collapse/dismiss never touches another's ("" selection =
// auto-pick). Sets are replaced immutably (a mutate-in-place wouldn't re-render — signals gotcha).
const cardSelectedHash = signal<string>("");        // which run's card is showing ("" → auto-pick)
const cardDetail = signal(true);                    // multi-run: tabbed DETAIL (true) ⇄ calm summary toast (false)
const cardCollapsedSet = signal<Set<string>>(new Set());   // run hashes collapsed to a toast (finished cards)
const cardDismissedSet = signal<Set<string>>(new Set());   // run hashes the user dismissed (× on a card)
const cardSteerHash = signal<string>("");   // a LIVE run whose HUD card is showing the inline steer box (orb → "Steer this run…")
const isCardCollapsed = (h: string): boolean => cardCollapsedSet.value.has(h);
const isCardDismissed = (h: string): boolean => cardDismissedSet.value.has(h);
const setCardCollapsed = (h: string, v: boolean): void => {
    const s = new Set(cardCollapsedSet.value); v ? s.add(h) : s.delete(h); cardCollapsedSet.value = s;
};
const dismissCardRun = (h: string): void => {
    const s = new Set(cardDismissedSet.value); s.add(h); cardDismissedSet.value = s;
    if (cardSelectedHash.value === h) cardSelectedHash.value = "";   // let the reconciler auto-pick the next
};
// cardShowWorkHash + revealSeq now live in ./store (shared with the answer-render provenance jump).
const cardMaximizedHash = signal<string>("");   // the run whose card is MAXIMISED (a near-full-page corner window)
const composerOpen = signal(false);          // the Spotlight composer — the HUD morphs into a task input
const composerElement = signal<ElementContext | null>(null);   // right-click "ask about this" → the element pill's context
// Where the composer's send goes: a NEW run (default, Spotlight/"ask about this") or APPENDED to an already-
// open run (right-click "add to current run" → steer if it's running, follow-up if idle).
const composerTarget = signal<{ mode: "new" } | { mode: "append"; hash: string }>({ mode: "new" });
const composerMaxSteps = signal(20);         // step budget for a UI-started run (persists across opens)
const STEP_BUDGETS = [10, 20, 50];           // the segmented presets in the composer
const composerStream = signal(true);         // stream the model's thinking live for a UI-started run — ON by default for Commander (you want to SEE it work); toggle off per-run. Persists across opens. (Console ml.agent stays default-off — the primitive is unchanged.)
const composerStarting = signal(0);          // timestamp: a UI run was sent, awaiting its first event (bridge pill)
// Per-call model pick for a UI-started run. "" = follow the configured default (so switching the default
// from the dropdown just keeps this on it). A non-"" value overrides the model FOR THIS RUN ONLY — the
// startRun payload carries it to createAgent({ model }); it never touches config. Persists across opens.
const composerModel = signal("");
const composerModelOpen = signal(false);     // the model-picker dropdown is open (over the composer foot)
// Per-call FORCE-NATIVE vision, only meaningful for a NON-Ollama picked model whose vision we can't probe
// (e.g. GPT-4o / minimax). ON → startRun passes ml.agent's `vision: true` (see with its own model) for
// this run; OFF → the default routing (delegate to the OCR reader if one sees). Ollama models auto-detect,
// so the toggle is hidden for them — the composer mirror of the Settings "vision capable?" lock.
const composerVision = signal(false);
// Known Ollama-backed? The server's provenance list is authoritative.
const isOllamaModel = (id: string): boolean => !!ollamaIds.value?.includes(id);
// AFFIRMATIVELY non-Ollama — provenance is loaded (ollamaIds non-null) AND doesn't list it. Used to gate the
// native-vision toggle: while the list is still loading (null) this is false, so the eye doesn't flash in then
// out and shove the chip when LIST_MODELS lands. The send() vision override reads the same signal.
const isCloudModel = (id: string): boolean => ollamaIds.value != null && !ollamaIds.value.includes(id);
// The model a UI-started run will actually use: the per-call override, else the configured default.
const composerResolvedModel = (): string => composerModel.value || config.value.model || "";
// Switch the CONFIGURED default model from the composer dropdown (a testing convenience — no Settings trip).
// SET_MODEL validates against the server list + persists to sync storage; the app's storage.onChanged
// listener folds it back into config.value. Reset the per-call override so the composer follows the new default.
function setDefaultModel(id: string): void {
    chrome.runtime.sendMessage({ type: "SET_MODEL", payload: { model: id } }, () => { void chrome.runtime.lastError; });
    composerModel.value = "";
    composerModelOpen.value = false;
}
const orbHover = signal(false);              // hovering the working orb → it stretches into a labelled capsule
const cardTitleTried = new Set<string>();

// A live, not-yet-decided approval gate (mirrors PendingNote's blocked check).
const isPendingGate = (hash: string, st: AgentStep): boolean =>
    !!(st.pending && st.awaitingApproval && !(st.seq != null && decidedSteps.has(stepKey(hash, st.seq))));

// --- Multi-run card selection ---------------------------------------------------------------------
// A run is TERMINAL once its turn settled (not mid-turn): a follow-up run() keeps the prior summary, so
// the status guard is what stops a stale answer showing instead of the working orb.
const runIsDone = (s: Session): boolean => s.status !== "pending" && (s.summary != null || !!s.error || !!s.cancelled);
const runIsPending = (s: Session): boolean => (s.steps || []).some(st => isPendingGate(s.hash, st));
// The runs the card cares about: non-silent agent runs the user hasn't dismissed. A silent run
// (ml.agent({ silent })) shows no card (approvals still surface, handled per-run below). Stable tab
// order by createdTs so tabs don't reshuffle as runs emit.
const cardWorthy = (s: Session): boolean => s.kind === "agent" && !s.agentConfig?.silent && !isCardDismissed(s.hash);
const cardRuns = (): Session[] => [...sessionMap.values()].filter(cardWorthy).sort((a, b) => a.createdTs - b.createdTs);
// The run whose card is showing. STICKY (badge-don't-steal): keep the current selection while it's still
// card-worthy — a new concurrent run adds a tab, it never hijacks the view. Auto-pick only when nothing
// valid is selected: prefer a run awaiting approval (it needs you), else the most recently active.
const selectedRun = (): Session | null => {
    const runs = cardRuns();
    if (!runs.length) return null;
    const cur = cardSelectedHash.value && runs.find(s => s.hash === cardSelectedHash.value);
    if (cur) return cur;
    const pending = runs.filter(runIsPending).sort((a, b) => b.lastTs - a.lastTs)[0];
    return pending || runs.reduce<Session | null>((best, s) => (!best || s.lastTs > best.lastTs ? s : best), null);
};

// Lazily summarise the run's task with the utility model (if configured) for the toast headline —
// the sidebar's title machinery, but ungated on sidebarOpen (irrelevant to the card).
function ensureCardTitle(s: Session): void {
    if (s.title || cardTitleTried.has(s.hash) || !utilitySummariesOn()) return;
    cardTitleTried.add(s.hash);
    genTitle(s.hash, s.task || "");
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
                    <OutputRaiseNote tool={st.tool} args={st.arguments} />
                  </div>
                : intent
                    ? <div class="action-card">
                        <div class="action-sentence">
                            {/* navigate: "Agent wants to go to <url>", the URL styled like a significant action
                                (warm + dotted) — leaving for another page is worth calling out. */}
                            {intent.link
                                ? <>Agent wants to <span class="action-verb">{intent.verb.toLowerCase()}</span> <span class="action-link">{intent.target}</span></>
                                : <>Agent wants to <span class="action-verb">{intent.verb.toLowerCase()}</span>
                                    {isType ? <> “<b class="action-target">{truncate(intent.input || "", 100)}</b>” into</> : null}
                                    {" the "}{intent.kind || "element"}
                                    {intent.target ? <> <b class="action-target">“{intent.target}”</b></> : null}
                                    {/* type + submit is a bigger action (presses Enter → sends the form). Call it out with a
                                        dotted underline so the human sees it's not just typing. */}
                                    {isType && intent.submit ? <> and <span class="action-submit">submit</span> it</> : null}</>}
                            {intent.note ? <span class="action-note"> · {intent.note}</span> : null}.
                        </div>
                        {intent.selector ? <div class="action-loc"><span class="loc-dot" aria-hidden="true" />Highlighted on the page{pos ? <> · <b>{pos}</b></> : null}</div> : null}
                        {/* CROSS-ORIGIN iframe = the one privileged case: a real debugger click reaching INTO
                            embedded third-party content that uses your session there. Chrome's debug banner only
                            appears AFTER you approve, so warn here, visually, BEFORE. (Same-origin frames / shadow
                            roots don't warn — not a security boundary.) */}
                        {intent.crossOrigin ? <div class="action-xorigin"><IconWarn /><span><b>Privileged click into an embedded cross-origin frame</b> — <b class="xorigin-host">{intent.crossOrigin}</b>. It uses a real debugger click and your session on that site.</span></div> : null}
                      </div>
                    : <div class="action-card">
                        {/* Utility-model gloss (if any) ABOVE the render — but it must NOT replace a
                            deterministic render (e.g. navigate's destination URL); a consent card has to keep
                            showing WHAT it's approving. Summary + render stack, like the code case does. */}
                        {summary ? <div class="action-summary ml-reveal">{summary}</div> : null}
                        {st.renderIn ? <RenderPanel d={st.renderIn} />
                            : (summary ? null : <div class="action-body dim">Run <b>{st.tool}</b>{st.arguments && Object.keys(st.arguments).length ? <> with {inlineJson(st.arguments)}</> : null}</div>)}
                      </div>}
            {sheets.length
                ? <div class="action-sheets"><IconWarn /><span>Grants this run access to {sheets.map((id, i) => <SheetChip key={i} id={id} />)} for the session.</span></div>
                : null}
            <HostAccessNote st={st} />
        </div>
    );
}

// The live "working" pill's per-tool icon + hover label (headless progress — see the tool running).
const ACTIVITY: Record<string, { icon: string; label: string; short: string }> = {
    look: { icon: "👁", label: "Viewing the screen…", short: "look" },
    findByText: { icon: "🔎", label: "Searching the page…", short: "find" },
    interactives: { icon: "🔎", label: "Finding controls…", short: "controls" },
    describeElement: { icon: "🔬", label: "Inspecting an element…", short: "inspect" },
    ancestors: { icon: "🧭", label: "Tracing the DOM…", short: "ancestors" },
    sampleText: { icon: "📄", label: "Reading text…", short: "read" },
    countMatches: { icon: "🔢", label: "Counting matches…", short: "count" },
    locate: { icon: "🎯", label: "Locating an element…", short: "locate" },
    click: { icon: "👆", label: "Clicking…", short: "click" },
    type: { icon: "⌨️", label: "Typing…", short: "type" },
    wait: { icon: "⏳", label: "Waiting for the page…", short: "wait" },
    exec: { icon: "λ", label: "Running JavaScript…", short: "exec" },
    python_exec: { icon: "🐍", label: "Running Python…", short: "python" },
    scroll: { icon: "🖱", label: "Scrolling…", short: "scroll" },
    screenshot: { icon: "📷", label: "Capturing…", short: "capture" },
    fetch_url: { icon: "🌐", label: "Fetching a URL…", short: "fetch" },
    navigate: { icon: "🧭", label: "Navigating…", short: "navigate" },
    answer: { icon: "📌", label: "Marking the answer…", short: "answer" },
    agent_api_docs: { icon: "📖", label: "Reading its own manual…", short: "docs" },
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
    const cur = steps.filter(s => (s.step || 0) > turnStart);
    if (!cur.length) return null;
    // Only the CURRENT (latest) step's narration. Walking back to an earlier step's thought left a stale
    // caption up — e.g. "Scanning the settings panel…" stayed while the agent had moved on to click/wait
    // several steps later. No prose on the current step → null, and the pill falls back to that step's tool
    // activity label (activityFor), which is always accurate. (A step emits its thought and its tool as
    // separate entries sharing one `step`, so scan every entry at the latest step number.)
    const latest = Math.max(0, ...cur.map(s => s.step || 0));
    const t = cur.filter(s => (s.step || 0) === latest).map(s => (s.thought || "").trim()).find(Boolean);
    // Strip markdown/HTML — the pill is one plain line, so a model's `**bold**`/`<b>`/backticks would show
    // as literal syntax. (The detail-view prose keeps rendered markdown.)
    return t ? (stripFormatting(t) || null) : null;
}
// Right-click the card/pill → ask the shell to draw the "move to corner" menu (drawn shell-side so the
// tiny pill iframe can't clip it). Coords are iframe-local; the shell offsets by the frame's position.
// Carry the run hash (for Copy run id / Cancel) + whether it's still live (Cancel only shows then).
const cardCtxMenu = (e: any) => {
    e.preventDefault();
    const run = selectedRun();
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
    // Multi-TASK run (>1 answer) → segment into collapsible per-task blocks; else null → the flat trace below.
    const blocks = buildRunBlocks(run);
    // Interleave the CONVERSATION into the trace — your prompts (task + follow-ups → "you asked") and PAST
    // answers, positioned with the step-groups by cumulative step (same scheme as the panel's AgentRunView:
    // task at -1, an answer just after its turn's steps, a following prompt just after that). The LATEST
    // answer isn't here — it's the card BODY (or, while running, the live prose) — so a done run drops it.
    const running = run.status === "pending";
    const answers = run.answers || [];
    const pastAnswers = running ? answers : answers.slice(0, -1);
    // Answers and says share one positional base (atStep + 0.5); TS breaks the tie — see AgentRunView for
    // why a fixed answer-before-say fraction mis-orders a chat-style turn that ran no tool steps.
    const traceItems: { pos: number; ts: number; el: preact.JSX.Element }[] = [
        ...(run.task || run.taskImages?.length ? [{ pos: -1, ts: run.createdTs || 0, el: <CardTraceMsg key="task" label="you asked" text={run.task || ""} cls="acard-you" images={run.taskImages} /> }] : []),
        ...(run.says || []).map((s, i) => ({ pos: s.atStep + 0.5, ts: s.ts, el: <CardTraceMsg key={`say${i}`} label="you asked" text={s.text} cls="acard-you" images={s.images} steer={s.id ? { seen: s.seen } : undefined} /> })),
        ...pastAnswers.map((a, i) => ({ pos: a.atStep + 0.5, ts: a.ts, el: <CardTraceMsg key={`ans${i}`} label={a.cancelled ? "cancelled" : a.hitCap ? "stopped early" : "answered"} text={a.text || "(no reply)"} cls="acard-ans" /> })),
        ...turns.map(t => ({ pos: t.step, ts: 0, el: <AgentTurn key={`t${t.step}`} turn={t} max={run.maxSteps} hash={run.hash} /> })),
    ].sort((a, b) => a.pos - b.pos || a.ts - b.ts);
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
            {open ? <div class="card-work-trace">
                {/* Multi-task run → per-task BLOCKS (collapse priors, expand the latest); single task → the
                    flat interleaved trace as before. */}
                {blocks
                    ? blocks.map((b, i) => <RunTaskBlockView key={i} run={run} block={b} index={i} last={i === blocks.length - 1} />)
                    : traceItems.map(it => it.el)}
            </div> : null}
        </div>
    );
}

// A collapsed disclosure in the card trace for a USER PROMPT ("you asked") or a PAST ANSWER ("answered") —
// styled like the thinking block, so Show-work reads as a scannable conversation SHAPE (ask → work → answer
// → ask → …). Collapsed with a one-line preview; expand for the full text. This is how a multi-turn HUD run
// stays legible: you can tell which steps belonged to which of your prompts.
function CardTraceMsg({ label, text, cls, images, steer }: { label: string; text: string; cls: string; images?: string[]; steer?: { seen?: boolean } }) {
    const [open, setOpen] = useState(false);
    return (
        <div class={`athought ${cls}`}>
            <button class="astep-head" onClick={() => setOpen(v => !v)}>
                <span class={`tri${open ? " open" : ""}`} aria-hidden="true"><IconChevron /></span>
                <span class="who">{label}</span>
                {steer ? <SteerSeen seen={!!steer.seen} /> : null}
                {!open ? <span class="astep-preview">{inlineText(text || "")}</span> : null}
            </button>
            {images?.length ? <div class="thumbs">{images.map((src, i) => <ClickableImg key={i} src={src} />)}</div> : null}
            {open && text ? <div class="md astep-body" dangerouslySetInnerHTML={{ __html: markdown(text || "", { math: true }) }} /> : null}
        </div>
    );
}

// One TASK block in the HUD Show-work (a multi-task run only). Collapsed → a one-line summary (utility-model,
// lazy + cached) or the prompt fallback, + a step-count chip. Expanded → the prompt, its turns, and (for a
// PRIOR block) its answer — the LATEST block's answer is the card body, so it's not repeated here. The latest
// block is expanded by default; priors collapse. Card-only (the debug sidebar shows the full flat trace).
function RunTaskBlockView({ run, block, index, last }: { run: Session; block: RunTaskBlock; index: number; last: boolean }) {
    const rv = rev.value;   // subscribe → re-render when the lazy summary lands (retained via data-rev)
    const [userOpen, setUserOpen] = useState(last);   // latest expanded, priors collapsed
    // A provenance click (a bottom-answer citation) sets revealSeq to a step; if that step is in THIS block,
    // force it open so scrollToStepSeq can reach the row. Derived DURING RENDER (a signal read, so the component
    // re-renders when revealSeq changes) into a sticky `stuckOpen` — NOT a useEffect, because a signal-driven
    // re-render doesn't reconcile effect deps (the effect never re-ran → the collapsed block stayed shut, the
    // bug). `stuckOpen` persists after revealSeq auto-clears so the block stays open + collapsible.
    const [stuckOpen, setStuckOpen] = useState(false);
    const reveal = revealSeq.value;
    if (reveal != null && !stuckOpen && block.turns.some(t => t.tools.some(s => s.seq === reveal))) setStuckOpen(true);
    const open = userOpen || stuckOpen;
    // This component only MOUNTS when Show-work is open, so firing here = fire-on-open (lazy). Cached by key.
    useEffect(() => { ensureBlockSummary(run.hash, index, block.prompt, block.answer?.text || ""); }, [run.hash, index]);
    const summary = blockSummaries.get(blockKey(run.hash, index));
    const header = summary || inlineText(block.prompt) || "(task)";
    return (
        <div class="run-block" data-rev={rv} data-reveal={reveal ?? ""}>
            {/* Toggling clears the reveal-forced open so a collapse actually collapses (else `stuckOpen` re-opens). */}
            <button class="run-block-head" onClick={() => { setUserOpen(!open); setStuckOpen(false); }}>
                <span class={`tri${open ? " open" : ""}`} aria-hidden="true"><IconChevron /></span>
                <span class={`run-block-sum${summary ? " ml-reveal" : ""}`}
                    title={summary ? `${summary}\n\nRequest: ${block.prompt}` : block.prompt}>{header}</span>
                <span class="sp" />
                <span class="run-block-n">{block.turns.length} {block.turns.length === 1 ? "step" : "steps"}</span>
            </button>
            {open ? (
                <div class="run-block-body">
                    <CardTraceMsg label="you asked" text={block.prompt} cls="acard-you" images={block.promptImages} />
                    {/* Turns + any MID-RUN steers, interleaved by step so a steer sits where it was sent, not
                        appended after all the work (and never mis-nested into a different block). */}
                    {[
                        ...block.turns.map(t => ({ pos: t.step, el: <AgentTurn key={`t${t.step}`} turn={t} max={run.maxSteps} hash={run.hash} /> })),
                        ...block.steers.map((s, k) => ({ pos: s.atStep + 0.5, el: <CardTraceMsg key={`st${k}`} label="you asked" text={s.text} cls="acard-you" images={s.images} steer={s.id ? { seen: s.seen } : undefined} /> })),
                    ].sort((a, b) => a.pos - b.pos).map(x => x.el)}
                    {block.answer && !last ? <CardTraceMsg label={block.answer.cancelled ? "cancelled" : block.answer.hitCap ? "stopped early" : "answered"} text={block.answer.text || "(no reply)"} cls="acard-ans" /> : null}
                </div>
            ) : null}
        </div>
    );
}

// The composer's model control: a chip showing the run's model (the per-call pick, else the default) that
// opens a dropdown of the allowed models. Picking a row overrides the model FOR THIS RUN; the ★ persists it
// as the new default (SET_MODEL) — a testing shortcut so you rarely open Settings. A non-Ollama pick also
// gets an eye toggle for per-call native vision. Mirrors the Settings vision lock: Ollama auto-detects, so
// no toggle there.
function ComposerModelBar() {
    const open = composerModelOpen.value;
    const sel = composerResolvedModel();
    const def = config.value.model || "";
    // The allowed set (LIST_MODELS already applied modelFilter) — but ALWAYS include the configured default:
    // a cloud default often isn't in the server's model list, and it'd be absurd to omit the model you're on.
    // Sorted A→Z so a long local list is scannable.
    const list = [...new Set(def ? [def, ...models.value] : models.value)].sort((a, b) => a.localeCompare(b));
    // Offer the native-vision toggle ONLY for an AFFIRMATIVELY non-Ollama model — provenance is unknown until
    // LIST_MODELS lands, and treating unknown as cloud made the eye flash in then out once the list loaded,
    // shoving the chip sideways (the "snap" on open). Unknown → no eye, no flash.
    const cloud = !!sel && isCloudModel(sel);
    const wrapRef = useRef<HTMLDivElement>(null);
    // Type-to-filter (contains-anywhere, case-insensitive) — a long local model list is a pain to scan.
    const [filter, setFilter] = useState("");
    const filterRef = useRef<HTMLInputElement>(null);
    const q = filter.trim().toLowerCase();
    const shown = q ? list.filter(m => m.toLowerCase().includes(q)) : list;
    // Close on any pointer-down outside the control (the iframe's own document — the menu floats over the body).
    useEffect(() => {
        if (!open) return;
        const onDown = (e: PointerEvent) => { if (!wrapRef.current?.contains(e.target as Node)) composerModelOpen.value = false; };
        document.addEventListener("pointerdown", onDown, true);
        return () => document.removeEventListener("pointerdown", onDown, true);
    }, [open]);
    // Reset the filter + focus the box each time the menu opens, so you can just type.
    useEffect(() => { if (open) { setFilter(""); const id = requestAnimationFrame(() => filterRef.current?.focus()); return () => cancelAnimationFrame(id); } }, [open]);
    const pick = (m: string) => { composerModel.value = m === def ? "" : m; composerModelOpen.value = false; };
    return (
        <div class="cmp-model" ref={wrapRef}>
            <button class="cmp-model-btn" type="button" aria-haspopup="listbox" aria-expanded={open}
                title="Model for this run — click to switch (★ sets your default)"
                onClick={() => (composerModelOpen.value = !open)}>
                <span class="cmp-model-name">{sel || "no model"}</span>
                <IconChevron />
            </button>
            {cloud ? (
                <button class={`cmp-vis${composerVision.value ? " on" : ""}`} type="button" aria-pressed={composerVision.value}
                    aria-label={composerVision.value ? "Native vision on for this run" : "Native vision off for this run"}
                    title={composerVision.value
                        ? "This run: the model sees images itself (native vision) — click to turn off"
                        : "This run: no native vision — delegates to the reader model. Click to turn on for a cloud model that can see (e.g. GPT-4o)."}
                    onClick={() => (composerVision.value = !composerVision.value)}>{composerVision.value ? <IconEye /> : <IconEyeOff />}</button>
            ) : null}
            {open ? (
                <div class="cmp-model-menu" role="listbox">
                    <input ref={filterRef} class="cmp-model-filter" type="text" value={filter} placeholder="Filter models…"
                        aria-label="Filter models"
                        onInput={e => setFilter((e.target as HTMLInputElement).value)}
                        onKeyDown={e => {
                            if (e.key === "Enter" && shown.length) { e.preventDefault(); pick(shown[0]); }
                            else if (e.key === "Escape") { e.preventDefault(); composerModelOpen.value = false; }
                        }} />
                    {list.length === 0
                        ? <div class="cmp-model-empty">No models loaded — check the server URL / API key in Settings.</div>
                        : shown.length === 0
                            ? <div class="cmp-model-empty">No models match "{filter.trim()}".</div>
                            : shown.map(m => {
                                const isSel = m === sel, isDef = m === def, tag = isOllamaModel(m) ? "ollama" : (ollamaIds.value ? "cloud" : "");
                                return (
                                    <div key={m} class={`cmp-model-row${isSel ? " sel" : ""}`} role="option" aria-selected={isSel}
                                        onClick={() => pick(m)}>
                                        <span class="cmp-model-row-name">{m}</span>
                                        {tag ? <span class={`cmp-model-tag ${tag}`}>{tag}</span> : null}
                                        <button class={`cmp-model-star${isDef ? " on" : ""}`} type="button"
                                            title={isDef ? "Your default model" : "Set as default model"}
                                            onClick={e => { e.stopPropagation(); setDefaultModel(m); }}>{isDef ? "★" : "☆"}</button>
                                    </div>
                                );
                            })}
                </div>
            ) : null}
        </div>
    );
}

// The Spotlight composer — the HUD morphed into a task input. Reuses the card's head/body/foot anatomy
// (same 🤖 in the same top-left spot as every other state) so it reads as the SAME blob reshaping, not a
// new panel. On send it posts `startRun` to the shell → the page runs a real ml.agent() (hash, resumable).
function ComposerCard() {
    const [text, setText] = useState("");
    const [err, setErr] = useState("");   // pre-flight complaint (e.g. no model configured) — blocks the send
    const att = useImageAttach();
    const budget = composerMaxSteps.value;   // the step budget (persists across opens)
    const ref = useRef<HTMLTextAreaElement>(null);
    // Focus after a frame so the container's morph (and the shell's frame.focus) has landed.
    useEffect(() => { const id = requestAnimationFrame(() => ref.current?.focus()); return () => cancelAnimationFrame(id); }, []);
    const el = composerElement.value;   // right-click "ask about this" context, if any
    const target = composerTarget.value;   // NEW run (default) vs APPEND to the open run
    const appendRun = target.mode === "append" ? sessionMap.get(target.hash) : undefined;
    const close = () => { composerOpen.value = false; composerElement.value = null; composerTarget.value = { mode: "new" }; };
    const send = () => {
        const t = text.trim();
        if (!t && !att.imgs.length && !el) return;   // allow an image-only OR element-only task
        // APPEND mode ("add to current run"): route to the open session — the page steers a running loop
        // (say) or starts a follow-up turn (run), and folds any element context into the message. No model
        // pre-flight (the run already resolved one). Optimistically flip it to working so the card morphs now.
        if (target.mode === "append") {
            window.parent.postMessage({ __mlSidebarApp: "sessionSend", hash: target.hash, text: t, images: att.imgs, elementContext: el || undefined }, "*");
            const s = sessionMap.get(target.hash);
            if (s) { s.status = "pending"; s.ended = false; s.lastTs = Date.now(); rev.value++; }
            close();
            return;
        }
        // Pre-flight: a HUD run with no model at all would flash the orb, then fail at the background's
        // prepareRequest with "No model configured". Catch it HERE instead — an inline nudge, so a fresh
        // install that hasn't picked a model gets an actionable message, not a cryptic failure. A per-call
        // pick counts, so this only fires when there's neither an override nor a configured default.
        // Backend down: block a NEW run — it would only fail (or retry fruitlessly). The health probe clears
        // `backendError` the instant the box answers again, re-enabling submission. (Steering/appending an
        // EXISTING run above is allowed — its next model call rides out the outage via the background's
        // network retry, so an ongoing run recovers.)
        if (backendError.value) { setErr("Backend unreachable — can't start a new run until the server is back (it re-enables automatically)."); return; }
        const model = composerModel.value.trim();   // "" = follow the configured default
        const resolved = composerResolvedModel();
        if (!resolved) { setErr("No model set. Pick one from the model menu above, or set a default in the extension settings."); return; }
        // Native-vision override only rides along for a non-Ollama pick with the eye toggled on (Ollama
        // vision is auto-detected, so we never send it there — the background resolves it). undefined ⇒
        // omitted ⇒ ml.agent's default routing (delegate to the reader model if one sees).
        const vision = (isCloudModel(resolved) && composerVision.value) ? true : undefined;
        // Bridge the round-trip: show a "Starting…" pill until the run's first event arrives (the composer
        // flies back to the corner and is instantly working). Safety-cleared if the run never surfaces.
        const t0 = Date.now();
        composerStarting.value = t0;
        setTimeout(() => { if (composerStarting.value === t0) composerStarting.value = 0; }, 10000);
        window.parent.postMessage({ __mlSidebarApp: "startRun", task: t, maxSteps: composerMaxSteps.value, model: model || undefined, vision, stream: composerStream.value || undefined, images: att.imgs, elementContext: el || undefined }, "*");
        close();
    };
    return (
        <div class="card-app" data-rev={rev.value}>
            <div class="card-head">
                <span class="card-bot" aria-hidden="true">🤖</span>
                <span class="card-head-txt" title={appendRun ? (appendRun.title || appendRun.task || "") : undefined}>
                    {target.mode === "append" ? (appendRun?.status === "pending" ? "Steer this run" : "Add to run") : "New task"}
                </span>
                <span class="sp" />
                {target.mode === "append" ? null : <ComposerModelBar />}
                <button class="card-x" aria-label="Cancel" title="Cancel" onClick={close}>✕</button>
            </div>
            <div class="card-body">
                {el ? <ElementPill ctx={el} onRemove={() => (composerElement.value = null)} /> : null}
                <ThumbStrip imgs={att.imgs} loading={att.loading} onRemove={att.remove} />
                <textarea ref={ref} class="card-cmp-input" rows={3}
                    placeholder={el ? "Ask about the selected element…" : "Ask window.ml to do something on this page… (paste a screenshot to attach)"}
                    value={text}
                    onInput={e => { setText((e.target as HTMLTextAreaElement).value); if (err) setErr(""); }}
                    onPaste={att.onPaste}
                    onKeyDown={e => {
                        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
                        else if (e.key === "Escape") { e.preventDefault(); close(); }
                    }} />
                {err ? <div class="card-cmp-err">{err}</div>
                    : (backendError.value && target.mode !== "append") ? <div class="card-cmp-err">⚠ Backend unreachable — new runs are paused until the server is back.</div>
                        : null}
            </div>
            <div class="card-foot card-cmp-foot">
                <input ref={att.fileRef} type="file" accept="image/*" multiple style="display:none"
                    onChange={e => { att.addFiles((e.target as HTMLInputElement).files); (e.target as HTMLInputElement).value = ""; }} />
                <button class="tt cbtn" onClick={() => att.fileRef.current?.click()} aria-label="Attach an image">＋<span class="tt-pop left above" role="tooltip">Attach an image (or paste a screenshot)</span></button>
                <span class="card-cmp-hint"><kbd class="kb">↵</kbd> send · <kbd class="kb">esc</kbd> cancel</span>
                <span class="sp" />
                {/* Stream the model's thinking live — so a long reasoning phase shows its words, not a frozen count. */}
                <button class={`card-cmp-stream${composerStream.value ? " on" : ""}`} aria-pressed={composerStream.value}
                    title="Stream the model's thinking live (see what it's doing during a long reasoning phase)"
                    onClick={() => (composerStream.value = !composerStream.value)}>◊ live</button>
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
                <button class="appr-btn yes" onClick={send} disabled={!text.trim() && !att.imgs.length && !el}>Send</button>
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

// The concurrency tab strip: one tab per card-worthy run, shown only when >1 run is live (single run =
// no strip). Each tab carries a status glyph (amber-pulse dot = awaiting approval · spinner = running ·
// ✓/✗ = done/failed), the run's title, and a × to drop it from the HUD. Clicking selects (manual pick,
// which selectedRun then honours over the pending/latest default). Its own pointer handlers stopProp so
// a tab click/dismiss never starts the card drag underneath.
function CardTabs({ runs, selected }: { runs: Session[]; selected?: string }) {
    return (
        <div class="card-tabs" role="tablist" onPointerDown={e => e.stopPropagation()}>
            {runs.map(s => {
                const pend = runIsPending(s), fin = runIsDone(s);
                const bad = !!s.error || !!s.cancelled;
                const glyph = pend ? <span class="card-tab-dot pend" aria-hidden="true" />
                    : fin ? <span class={`card-tab-fin${bad ? " bad" : ""}`} aria-hidden="true">{bad ? "✗" : "✓"}</span>
                        : <span class="card-tab-spin" aria-hidden="true" />;
                return (
                    <div class={`card-tab${s.hash === selected ? " on" : ""}${pend ? " pend" : ""}`} role="tab"
                        aria-selected={s.hash === selected} title={s.title || s.task || "Agent run"}
                        onClick={e => { e.stopPropagation(); cardSelectedHash.value = s.hash; }}>
                        {glyph}
                        <span class="card-tab-label">{s.title || truncate(s.task || "Run", 22)}</span>
                        <button class="card-tab-x" aria-label="Dismiss run"
                            onPointerDown={e => { e.stopPropagation(); e.preventDefault(); dismissCardRun(s.hash); }}
                            onClick={e => e.stopPropagation()}>✕</button>
                    </div>
                );
            })}
        </div>
    );
}

function CardApp() {
    const r = rev.value;   // subscribe to session changes (retained via data-rev below)
    const composing = composerOpen.value;   // Spotlight bar open → the HUD morphs into the task input
    const runs = cardRuns();               // all card-worthy concurrent runs (for the tab strip)
    const run = selectedRun();             // the ONE run whose card is showing (see selectedRun: user pick, else pending, else latest)
    const hash = run?.hash;
    const showWork = !!hash && cardShowWorkHash.value === hash;   // active run's trace open? (subscribe → re-measure height on toggle)
    const pendingStep = run ? (run.steps || []).find(st => isPendingGate(run.hash, st)) : undefined;
    const pending = !!pendingStep;
    // Terminal ONLY when the run isn't mid-turn: a follow-up run() keeps the PRIOR summary set, so without
    // the status guard `done` would stay true and the card would show the stale answer instead of collapsing
    // to the working orb. status flips to "pending" on a new turn (optimistically in CardReply, and on any
    // agent-step) and back to ok/err on the next agent-result.
    const done = !!run && runIsDone(run);
    const tabs = runs.length > 1;          // >1 card-worthy run → show the tab strip (single run = today's look)
    // Is there any run with a CARD to reach (an approval or a finished answer)? When several runs are
    // merely working, we keep the bare orb (it narrates the last op across runs — selectedRun returns the
    // latest-active, so the caption already reflects whichever run just stepped); tabs only take over once
    // a run has content worth switching to, so the answer/approval is reachable.
    const anyContent = runs.some(s => runIsPending(s) || runIsDone(s));
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
    // Orb-steer: while a run is LIVE and its steer box is open, force the card OPEN (out of the orb) so the
    // input is reachable. Only meaningful for a running run — it self-clears the instant the run finishes.
    const steering = !!run && running && cardSteerHash.value === run.hash;
    // The final answer is STREAMING (stream:true) → open the card so the answer FILLS IN live, instead of the
    // orb popping the finished answer all at once. Only for the reply phase (liveStream.content) — the pure
    // thinking phase keeps the calm orb + its narration caption. Respects quiet/silent (those suppress the card).
    const streamingAnswer = !!run?.liveStream?.content && !quiet && !silent;
    const state = composing ? "composer"                       // the composer takes over — centered Spotlight bar
        : steering ? "expanded"                                // steering a live run: open the card for the inline steer box
        : pending ? "expanded"                                 // an approval: show the action directly (even for a silent run)
        : streamingAnswer ? "expanded"                         // the answer is streaming in → open the card to show it live
            : (tabs && anyContent) ? (cardDetail.value ? "expanded" : "toast")   // multi-run with content: tabbed detail ⇄ calm summary toast (one card-level toggle)
                : showOrb ? (liveProse ? "orbprose" : hovering ? "orblabel" : "orb")   // in flight → orb; caption when narrating; capsule on hover (single run, or several all merely working)
                    : (done && !silent) ? (isCardCollapsed(run!.hash) ? "toast" : (cardMaximizedHash.value === run!.hash ? "maximized" : "expanded"))   // single finished run: the answer — MAXIMISED into a corner window when toggled
                        : "hidden";

    // Clear a STALE hover whenever we're not showing the orb — the orb can unmount while hovered (the
    // composer opens over it, an approval expands) and then no pointerleave fires, which would wrongly
    // reopen the capsule (orblabel) when the orb next appears (e.g. the "Starting…" bridge). So a fresh
    // orb always starts circular until a real pointerenter.
    useEffect(() => { if (state !== "orb" && state !== "orblabel" && state !== "orbprose") orbHover.value = false; }, [state]);
    // Close the steer box once the run is no longer live (it finished / failed / was cancelled) — the box is
    // meaningless without a running loop, and this snaps the card to its finished-answer form cleanly.
    useEffect(() => { if (!running && cardSteerHash.value === run?.hash) cardSteerHash.value = ""; }, [running]);
    // A FOLLOW-UP turn just started (was done, now working again — there's prior conversation): collapse an
    // OPEN "Show work" for this run. Otherwise the prior turn's expanded trace looms over the streaming answer
    // and reflows spammily as it fills in, then snaps away when the run settles. Collapsing matches that clean
    // end-state from the start; the trace is one click away. Only fires when it was actually open on THIS run.
    useEffect(() => {
        if (running && run && cardShowWorkHash.value === run.hash && (run.answers?.length || run.says?.length)) cardShowWorkHash.value = "";
    }, [running]);
    // An approval opens the tabbed DETAIL (a multi-run summary would hide the action), and stays open through
    // the decision so the outcome is visible instead of snapping back to the calm summary.
    useEffect(() => { if (pending) cardDetail.value = true; }, [pending]);
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
            // Caption pill: report its NATURAL width so the shell fits the pill to the text (up to a max, then
            // the label ellipsizes). Measure the label's real glyph extent with a Range — the label has
            // overflow:hidden + a flex width, so its offsetWidth/scrollWidth is clamped to the CURRENT pill and
            // wouldn't shrink for a short line; a Range over the text reports the true layout width regardless.
            const orb = app.querySelector(".card-orb.prose") as HTMLElement | null;
            const lbl = orb?.querySelector(".card-orb-label") as HTMLElement | null;
            // Guarded: Range.getBoundingClientRect is a layout call (unavailable under jsdom, and a hostile
            // environment could throw) — a measurement failure must never abort the effect and strand the
            // state post below it. The shell falls back to the fixed orbprose width when no width arrives.
            if (orb && lbl && lbl.firstChild) try {
                const range = document.createRange();
                range.selectNodeContents(lbl);
                const textW = range.getBoundingClientRect().width;
                const cs = getComputedStyle(orb);
                const ic = orb.querySelector(".card-orb-ic") as HTMLElement | null;
                const chrome = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + (parseFloat(cs.columnGap || cs.gap) || 9) + (ic?.offsetWidth || 20);
                if (textW > 0) window.parent.postMessage({ __mlSidebarCardW: Math.ceil(chrome + textW) + 4 }, "*");
            } catch { /* no layout available (jsdom) → shell uses the fixed orbprose width */ }
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
        const canKeep = hasPersistGrants(pendingStep.grants);
        window.parent.postMessage({ __mlSidebarCardFocus: true }, "*");
        const decideKey = (ok: boolean, persist = false) => { decidedSteps.add(stepKey(h, seq)); clearHighlight(); void decideGate(pendingStep, h, seq, ok, persist); rev.value++; };
        const onKey = (e: KeyboardEvent) => {
            // Enter approves; Esc denies; KEEP is a deliberate two-key combo (⌘/Ctrl+K) — intentionally NOT
            // Enter-adjacent, so granting a session-long fetch permission can't be a slip of the Approve key.
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { if (canKeep) { e.preventDefault(); decideKey(true, true); } }
            else if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) { e.preventDefault(); decideKey(true); }
            else if (e.key === "Escape") { e.preventDefault(); decideKey(false); }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [pending, pendingStep?.seq]);

    if (composing) return <ComposerCard />;   // the blob reshapes into the task input (container morphs shell-side)
    // Backend GONE: a run that's still "starting"/"working" against a dead box would otherwise hang on the
    // "Starting…" orb with no signal (the reported bug). The proactive health probe set backendError → show it
    // plainly. A finished run keeps its own card (a completed run's error already shows via card-error-offline);
    // an approval gate stays visible too. `boDown` is exactly the in-between: not done, not gated.
    const boDown = !!backendError.value && !done && !pending;
    if (boDown) {
        if (state === "orb" || state === "orblabel") return <Orb icon="⚠" label="Backend down" wide />;
        return (
            <div class="card-app offline" data-rev={r}>
                <div class="card-head"><span class="card-head-txt">Backend unreachable</span></div>
                <div class="card-body"><div class="card-error card-error-offline"><IconWarn /> {backendError.value}</div></div>
            </div>
        );
    }
    // The just-sent "Starting…" bridge orb (before the run's first event) — the composer balled up and flew
    // back to the corner, already working. Ignores any older run underneath.
    if ((state === "orb" || state === "orblabel") && starting) return <Orb icon="💭" label="Starting…" wide={state === "orblabel"} />;
    if (!run) return <div class="card-app" data-rev={r} />;

    const title = run.title || truncate(run.task || "Agent run", 80);
    // A backend-UNREACHABLE failure gets its own headline ("Backend unreachable") so a dead box is unmistakable,
    // distinct from a generic run failure (a reachable box that errored).
    const offline = !!run.error && isBackendUnreachable(run.error);
    const failWord = offline ? "Backend unreachable" : "Run failed";
    const headline = pending ? "Approval needed" : run.error ? failWord : run.cancelled ? "Cancelled" : done ? (run.hitCap ? "Stopped" : "Task complete") : run.resumed ? "Resumed…" : "Working…";
    // Multi-run EXPANDED head: name the selected run (its title, ellipsized in CSS) rather than the generic
    // "Task complete" — the status is already carried by the tab's glyph. Keep the status word for the
    // states that matter more than a name (approval / failure / cancel).
    const headText = tabs ? (pending ? "Approval needed" : run.error ? failWord : run.cancelled ? "Cancelled" : title) : headline;
    // Multi-run COLLAPSED summary: a calm overview, not per-run detail — a generic status + a count badge,
    // no title subtitle, no tab strip. (A pending run would force the EXPANDED state, so it isn't seen here.)
    const doneN = runs.filter(runIsDone).length;
    const anyPend = runs.some(runIsPending);   // a run needs approval — must stay visible even in the summary
    const summaryHead = anyPend ? "Approval needed" : doneN === runs.length ? "All tasks complete" : doneN > 0 ? "Some tasks complete" : "Tasks running…";
    const decide = (ok: boolean, persist = false) => {
        if (!pendingStep || pendingStep.seq == null) return;
        decidedSteps.add(stepKey(run.hash, pendingStep.seq));
        clearHighlight();
        void decideGate(pendingStep, run.hash, pendingStep.seq, ok, persist);   // fetch_url: grant its host in-gesture
        rev.value++;
    };
    const onClose = (e: Event) => {
        e.stopPropagation();
        if (pendingStep) decide(false);          // × on a pending gate = a fast Deny
        else dismissCardRun(run.hash);           // × on a finished card = dismiss (drops it from the tab strip)
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
        // MULTI-RUN collapsed → a calm SUMMARY: 🤖 + a generic status + a count badge, no per-run title, no
        // tab strip. Click expands to the tabbed detail; × dismisses ALL runs (close the summary). SINGLE run
        // → the classic toast (headline + the task subtitle), which expands to its own answer.
        if (tabs) {
            return (
                <div class="card-app" data-rev={r}>
                    <div class="card-toast summary" role="button" title="Click to review · drag or right-click to move"
                        onPointerDown={startCardDrag}
                        onClick={e => { if (!(e.target as HTMLElement).closest(".card-x")) cardDetail.value = true; }}
                        onContextMenu={cardCtxMenu}>
                        <span class="card-bot" aria-hidden="true">🤖</span>
                        <span class={`card-toast-head${anyPend ? " pending" : ""}`}>{summaryHead}</span>
                        <span class={`card-count${anyPend ? " pend" : ""}`} title={`${runs.length} runs`}>{runs.length}</span>
                        <span class="sp" />
                        <button class="card-x" aria-label="Dismiss all" onPointerDown={e => { e.stopPropagation(); e.preventDefault(); runs.forEach(s => dismissCardRun(s.hash)); }} onClick={e => e.stopPropagation()}>✕</button>
                    </div>
                </div>
            );
        }
        return (
            <div class="card-app" data-rev={r}>
                <div class="card-toast" role="button" title="Click to review · drag or right-click to move" onPointerDown={startCardDrag} onClick={e => { if (!(e.target as HTMLElement).closest(".card-x")) setCardCollapsed(run.hash, false); }} onContextMenu={cardCtxMenu}>
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
            <ContextMenu />{/* right-click menus (e.g. a fetch/navigate URL → open in new tab) need their renderer in the HUD too, not just the panel */}
            {tabs ? <CardTabs runs={runs} selected={hash} /> : null}
            <div class="card-head" onPointerDown={startCardDrag} onContextMenu={cardCtxMenu}>
                {tabs ? null : <span class="card-bot" aria-hidden="true">🤖</span>}   {/* multi-run: the tab strip already IDs the run — drop the 🤖 to de-clutter */}
                <span class={`card-head-txt${pending ? " pending" : ""}`} title={tabs ? headText : undefined}>{headText}</span>
                <span class="sp" />
                {/* Maximise the finished-answer card into a near-full-page corner window (animated); toggles back.
                    Only for a single finished run (an approval/working card stays compact). */}
                {done && !pending && !tabs
                    ? <button class="card-icon" aria-label={cardMaximizedHash.value === run.hash ? "Minimise" : "Maximise"} title={cardMaximizedHash.value === run.hash ? "Minimise" : "Maximise"}
                        onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); cardMaximizedHash.value = cardMaximizedHash.value === run.hash ? "" : run.hash; }}>{cardMaximizedHash.value === run.hash ? "⤡" : "⤢"}</button>
                    : null}
                {pending ? null : <button class="card-icon" aria-label="Collapse" title="Collapse" onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); cardMaximizedHash.value = ""; tabs ? (cardDetail.value = false) : setCardCollapsed(run.hash, true); }}>▾</button>}
                <button class="card-x" aria-label={pending ? "Deny" : "Dismiss"} onPointerDown={onCloseDown} onClick={e => { e.stopPropagation(); cardMaximizedHash.value = ""; }}>✕</button>
            </div>
            <div class="card-body">
                {pending && pendingStep
                    ? <ApprovalBody st={pendingStep} hash={run.hash} goal={title} />
                    : !done
                        // A working run browsed via a tab (multi-run detail): show a live "Working…" line + its
                        // trace, not the finished-answer branch (which would render an empty "no reply yet").
                        ? <>
                            {/* Show work sits ABOVE, exactly as in the done branch — so it doesn't JUMP from
                                bottom to top when a streaming follow-up finishes (the "spammy reflow" bug). */}
                            {(run.steps || []).some(s => s.tool) ? <ShowWork run={run} /> : null}
                            {run.liveStream?.content
                                // The answer is STREAMING → render it as clean markdown, EXACTLY like the
                                // finished answer (it becomes run.summary when the run settles — no reflow). The
                                // HUD is answer-first: no "Running JavaScript…" activity line and no model-chip /
                                // reply-bubble chrome (that's DevTools/sidebar detail — the LiveStream component).
                                ? <div class="card-answer md" dangerouslySetInnerHTML={{ __html: markdown(run.liveStream.content, { math: true }) }} />
                                : <div class="card-answer dim card-working"><span class="card-work-ic" aria-hidden="true">{activityFor(run).icon}</span>{liveProseFor(run) || activityFor(run).label}<span class="pill-dots"><i /><i /><i /></span></div>}
                          </>
                        : <>
                            {/* "Show work" sits ABOVE the answer now — the audit trail is the header, the answer
                                the payoff. Only when there's actual WORK (≥1 tool step); a pure chat answer has none. */}
                            {(run.steps || []).some(s => s.tool) ? <ShowWork run={run} /> : null}
                            {run.error
                                ? <div class={`card-error${offline ? " card-error-offline" : ""}`}>{offline ? <><IconWarn /> </> : null}{run.error}</div>
                                : (run.summary || "").trim()
                                    ? <AnswerBody text={run.summary || ""} run={run} />
                                    : <div class="card-answer dim card-answer-empty">{run.cancelled ? "Run cancelled — the agent returned no text." : "The run finished without a text reply."}</div>}
                            {/* answer-designated element visuals — the user-facing deliverable (HUD-only; the debug
                                sidebar deliberately doesn't render these). Click to lightbox. */}
                            {run.answerMedia && run.answerMedia.length ? <AnswerMediaGallery media={run.answerMedia} /> : null}
                            {/* The curated answer SET's tool outputs (designated + auto-appended), rendered under
                                the summary — see ResultBlock (shared with the DevTools reply for parity). */}
                            <ResultBlock run={run} />
                            {/* Step-capped stop → one click resumes with a fresh N-step budget (no need to type
                                a follow-up in the composer). Not shown for a cancel/error. */}
                            {run.hitCap && !run.cancelled
                                ? <button class="continue-run" title="Resume this run with more steps, continuing from where it stopped"
                                    onClick={() => window.parent.postMessage({ __mlSidebarApp: "continueRun", hash: run.hash }, "*")}>
                                    Continue <span class="continue-steps">+{run.maxSteps || 20} steps</span>
                                  </button>
                                : null}
                          </>}
            </div>
            {/* Deny/Approve as a FIXED footer — outside the scroll area, so it's always visible (a
                drag-collapse or the scrollbar appearing can never cut or shift the buttons). */}
            {pending && pendingStep
                ? (() => {
                    const showGrants = hasPersistGrants(pendingStep.grants);
                    return <div class="card-foot card-foot-appr">
                        {showGrants ? <GrantCard grants={pendingStep.grants!} /> : null}
                        <div class="card-foot-row">
                            <button class="appr-btn no" onClick={() => decide(false)}>Deny <kbd class="kb">esc</kbd></button>
                            <button class="appr-btn yes" onClick={() => decide(true)}>Approve <kbd class="kb">⏎</kbd></button>
                            {showGrants ? <button class="appr-btn yes remember" title="Approve — and let the agent fetch these URLs WITHOUT approval for the rest of this session (results are cached)" onClick={() => decide(true, true)}>Keep <kbd class="kb">{KEEP_HINT}</kbd></button> : null}
                        </div>
                    </div>;
                  })()
                : done ? <CardReply hash={run.hash} />
                    : steering ? <CardSteer hash={run.hash} onClose={() => { cardSteerHash.value = ""; }} />
                        : null}
        </div>
    );
}

// The inline STEER box on a LIVE card (orb → right-click → "Steer this run…"). Text-only: a mid-run steer
// routes to the handle's say(), which is text-only (no images mid-flight), so offering an attach would only
// drop it. Sends via the SAME sessionSend channel as the reply; while the run is live the page routes it to
// say() → the message is queued and shows as an agent-say bubble with the "seen" indicator. Stays OPEN after
// a send so you can steer again; Escape or × closes back to the orb.
function CardSteer({ hash, onClose }: { hash: string; onClose: () => void }) {
    const [text, setText] = useState("");
    const inputRef = useRef<HTMLInputElement>(null);
    useEffect(() => { inputRef.current?.focus(); }, []);
    const send = () => {
        const t = text.trim();
        if (!t) return;
        window.parent.postMessage({ __mlSidebarApp: "sessionSend", hash, text: t }, "*");
        setText(""); inputRef.current?.focus();   // keep steering — a run often needs more than one nudge
    };
    const onKey = (e: KeyboardEvent) => {
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
        else if (e.key === "Escape") { e.preventDefault(); onClose(); }
    };
    const has = !!text.trim();
    return (
        <div class="card-steer">
            <div class="card-steer-field">
                <span class="card-steer-ic" aria-hidden="true" title="Steer — delivered at the agent's next step">🧭</span>
                <input ref={inputRef} class="card-steer-in" type="text" value={text} placeholder="Steer the agent — added at its next step…"
                    onInput={e => setText((e.target as HTMLInputElement).value)} onKeyDown={onKey} />
                <button class={`card-steer-send${has ? " show" : ""}`} aria-label="Send steer" tabIndex={has ? 0 : -1}
                    onMouseDown={e => e.preventDefault()} onClick={send} disabled={!has}><IconSend /></button>
                <button class="card-steer-x" aria-label="Close steer" title="Close (Esc)" onMouseDown={e => e.preventDefault()} onClick={onClose}>✕</button>
            </div>
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
    const att = useImageAttach();
    const inputRef = useRef<HTMLInputElement>(null);
    const send = () => {
        const t = text.trim();
        if (!t && !att.imgs.length) return;
        window.parent.postMessage({ __mlSidebarApp: "sessionSend", hash, text: t, images: att.imgs }, "*");
        // Optimistic: flip the session to WORKING now so the card morphs to the orb the instant you hit
        // Enter, instead of showing the stale answer until the follow-up's first event lands (in off/card
        // mode the page's agent-say bridge is dormant, so there'd otherwise be a visible lag).
        const s = sessionMap.get(hash);
        if (s) { s.status = "pending"; s.lastTs = Date.now(); rev.value++; }
        setText(""); att.clear(); setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
        else if (e.key === "Escape") { e.preventDefault(); setText(""); att.clear(); setOpen(false); }
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
    const has = !!text.trim() || att.imgs.length > 0;
    return (
        <div class="card-reply">
            <ThumbStrip imgs={att.imgs} loading={att.loading} onRemove={att.remove} />
            <div class="card-reply-field">
                <input ref={att.fileRef} type="file" accept="image/*" multiple style="display:none"
                    onChange={e => { att.addFiles((e.target as HTMLInputElement).files); (e.target as HTMLInputElement).value = ""; }} />
                {/* preventDefault on mousedown so clicking ＋ doesn't blur the input (which would collapse the box). */}
                <button class="cbtn card-reply-attach" aria-label="Attach an image" onMouseDown={e => e.preventDefault()} onClick={() => att.fileRef.current?.click()}>＋</button>
                <input ref={inputRef} class="card-reply-in" type="text" value={text} placeholder="Reply to continue this run…"
                    onInput={e => setText((e.target as HTMLInputElement).value)} onKeyDown={onKey} onPaste={att.onPaste}
                    onBlur={() => { if (!text.trim() && !att.imgs.length && !att.loading) setOpen(false); }} />
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
    // Proactive backend health, in BOTH surfaces: a dead box must surface even when a run fails silently or
    // HANGS (no error event). The panel is mounted whenever devtools/overlay is up; the off-mode card is
    // mounted while a run is active — exactly when a stuck "Starting…" would otherwise hang with no signal.
    useEffect(() => {
        pollBackendHealth();
        const id = setInterval(pollBackendHealth, BACKEND_HEALTH_MS);
        return () => clearInterval(id);
    }, []);
    return surface.value === "card" ? <CardApp /> : <App />;
}

// atBottom now lives in ./store (shared with agent-detail's ToolStep).

// A persistent, top-of-panel banner shown when the backend is UNREACHABLE (server down / wrong host /
// refused) — so a dead box reads at a glance in the devtools panel + overlay, without drilling into the
// failed run. Set/cleared in onDebug (backendError); the URL comes from the (cached) config so it shows even
// while nothing on the backend answers.
function BackendOfflineBanner() {
    const msg = backendError.value;
    if (!msg) return null;
    const url = config.value.chatUrl || "";
    return (
        <div class="backend-offline" role="alert">
            <IconWarn />
            <div class="bo-body">
                <b class="bo-title">Backend unreachable</b>
                <span class="bo-detail">Couldn't reach your server{url ? <> at <code>{url}</code></> : null}. Is it running? Check the Server URL / API format in Settings.</span>
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
            <BackendOfflineBanner />
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
    else if (typeof d.__mlSidebarComposer === "string") { composerOpen.value = d.__mlSidebarComposer === "open"; if (d.__mlSidebarComposer !== "open") composerElement.value = null; }   // Spotlight bar
    else if (d.__mlComposerElement) composerElement.value = d.__mlComposerElement as ElementContext;   // right-click "ask about this" → element pill
    else if (d.__mlAddToCurrentRun) {
        // Right-click "Add to current run": open the composer targeting the OPEN run (append) instead of a
        // fresh one. If nothing's open, degrade to a normal new-run composer so the entry is never a dead-end.
        const cur = selectedRun();
        const ctx = d.__mlAddToCurrentRun.ctx;
        composerElement.value = (ctx && typeof ctx.selector === "string") ? ctx as ElementContext : null;
        composerTarget.value = cur ? { mode: "append", hash: cur.hash } : { mode: "new" };
        composerOpen.value = true;
    }
    else if (d.__mlSidebarCardEndDrag) endActiveCardDrag?.();   // shell's safety net force-ended a stuck drag → clean up our listeners
    else if (d.__mlSteerRun && typeof d.__mlSteerRun.hash === "string") {
        // Orb right-click → "Steer this run…": open the inline steer box on this run's card. Uncollapse it
        // (a collapsed toast can't hold the input) and ask the shell to focus the frame so typing lands.
        cardSteerHash.value = d.__mlSteerRun.hash;
        setCardCollapsed(d.__mlSteerRun.hash, false);
        window.parent.postMessage({ __mlSidebarCardFocus: true }, "*");
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
