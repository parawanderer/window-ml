// Model / VRAM diagnostics — the server model-list fetch, the Ollama /api/ps VRAM monitor panel + its
// polling, per-model load-state, backend-health probing, and the Python sandbox bench. A separate,
// self-contained surface from the run views. Extracted from app.tsx.
import { useState, useEffect, useRef } from "preact/hooks";
import type { RenderDescriptor } from "../contract";
import { fmtCtx, isBackendUnreachable } from "../contract";
import { signal } from "@preact/signals";
import {
    config, models, ollamaIds, loadedModels, psError, vramOpen, backendError, rev, sessionMap,
    sidebarOpen, view,
} from "./store";
import { truncate } from "./format";
import { normModel, seenContext } from "./model";
import { IconVram, IconEye, IconEyeOff, IconBench } from "./icons";
import { parseInfo, formatBytes, boxSignature, sameBoxOnly, type Capacity, type ResourceSample, type ModelResidency } from "../resource-model";
import { ResourceTracks } from "./resource-chart";
import type { LoadedModel } from "../contract";

/** A LoadedModel (the ps relay's shape) → the residency the chart works in. Bytes, never the rounded GB: the
 *  bands subtract these from exact capacity figures. `gpus` absent means CPU-resident, and that absence is
 *  preserved as an empty device map rather than invented placement. */
export function residencyOf(m: LoadedModel): ModelResidency {
    const vram = m.vramBytes ?? 0, size = m.sizeBytes ?? 0;
    const perDevice: Record<string, number | null> = {};
    for (const g of m.gpus ?? []) perDevice[g.id] = g.vramBytes === 0 && vram > 0 ? null : g.vramBytes;
    return {
        model: m.model, vramBytes: vram, ramBytes: Math.max(0, size - vram), perDevice,
        contextLength: m.contextLength, expiresAt: m.expiresAt ? Date.parse(m.expiresAt) || null : null,
    };
}
import { RenderPanel } from "./render-panel";

// Fetch the server's model list via the background worker (privileged fetch);
// degrade silently if unreachable. Populates the datalists.
export function fetchModels(): void {
    chrome.runtime.sendMessage({ type: "LIST_MODELS", payload: {} }, (resp: any) => {
        if (chrome.runtime.lastError || !resp || resp.error) return;
        models.value = resp.data || [];
        ollamaIds.value = resp.ollamaModels ?? null;   // null = provenance unknown (skip cloud detection)
    });
}


// --- VRAM monitor ---
export const VRAM_COLORS = ["#6366f1", "#22c55e", "#f59e0b", "#ec4899", "#06b6d4", "#a855f7", "#ef4444", "#84cc16"];
export const colorFor = (name: string) => VRAM_COLORS[[...name].reduce((a, c) => a + c.charCodeAt(0), 0) % VRAM_COLORS.length];
export const VRAM_HISTORY = 45, VRAM_POLL_MS = 2000;
// Session-long history, in a MODULE signal rather than component state: the old panel kept 45 samples in
// useState and threw them away on every close, so "what happened during that run" was unanswerable the moment
// you looked away. ~30 min at 2s is ~900 samples of a few numbers each — kilobytes. Session-only by choice:
// it dies with the page, and gaps (the panel was closed, so nothing was polled) stay gaps.
export const RESOURCE_HISTORY = 900;
export const resourceHistory = signal<ResourceSample[]>([]);
// Machine CAPACITY — the denominator. The TOTALS change only when hardware does, but `free_memory` rides in
// the same payload and changes with every load and evict, so fetching once per open froze the free and
// residual bands at whatever they were when you opened the panel (a card would read "18 GiB in use" beside
// "free 94.42 GiB"). Refreshed on a SLOWER cadence than ps instead: often enough to track occupancy, rarely
// enough not to hammer a route whose totals never move.
// null = unknown (the route isn't served): the chart then draws no ceiling rather than pretending it is zero.
export const CAPACITY_EVERY = 5;   // ps polls between capacity refreshes (5 x 2s = 10s)
let psSinceCapacity = 0;
export const capacity = signal<Capacity | null>(null);
export function fetchCapacity(): void {
    chrome.runtime.sendMessage({ type: "OLLAMA_INFO", payload: {} }, (resp: any) => {
        if (chrome.runtime.lastError || !resp || resp.error) return;   // leave capacity unknown
        const next = parseInfo(resp.data);
        // Pointing at a DIFFERENT machine (a CUDA server, then a Metal Mac) invalidates the history: those
        // samples were measured against another ceiling, on devices whose ids mean different hardware. Drawing
        // them here would clip an 18 GiB band against an 11.84 GiB ceiling and look like a reading.
        // A SWITCH means one known box replaced by a different known box. The first fetch (unknown → known)
        // is not one: treating it as such would drop every sample taken before capacity arrived, which on a
        // fresh open is all of them — the panel would render nothing until the next poll.
        const switched = !!capacity.value && boxSignature(next) !== boxSignature(capacity.value);
        // On a switch, drop samples that can't be attributed to EITHER box as well — an unattributed sample is
        // backfilled with the current capacity at render, which after a switch means drawing the old machine's
        // readings against the new machine's ceiling.
        if (switched) resourceHistory.value = sameBoxOnly(resourceHistory.value, next, true);
        capacity.value = next;
    });
}
// Models the user has hidden from the totals/graph (session-only; a signal so it
// survives VramPanel remounts). Immutable Set updates so the signal notifies.
export const hiddenModels = signal<Set<string>>(new Set());
export const toggleHidden = (model: string): void => {
    const next = new Set(hiddenModels.value);
    next.has(model) ? next.delete(model) : next.add(model);
    hiddenModels.value = next;
};

// Poll Ollama's resident-model set (/api/ps) into the shared signals, for BOTH
// the VRAM panel and the header status dot. Gated so it never hammers Ollama in
// the background: only while the shell is slid open AND something needs it (the
// panel is up, or a detail header — the only place a status dot shows).
export function pollPs(): void {
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
        // One sample per poll, carrying the capacity in force at the time — a sample read back from history
        // must know the ceiling it was drawn against, not today's.
        const sample: ResourceSample = {
            t: Date.now(),
            models: loaded.map((m: LoadedModel) => residencyOf(m)),
            capacity: capacity.value,
        };
        resourceHistory.value = [...resourceHistory.value, sample].slice(-RESOURCE_HISTORY);
        // Keep occupancy honest without polling capacity as often as residency (see CAPACITY_EVERY).
        if (++psSinceCapacity >= CAPACITY_EVERY) { psSinceCapacity = 0; fetchCapacity(); }
    });
}

// --- proactive backend-health probe (drives the offline banner + the HUD card's offline state) ---
// A run/chat failure isn't the only way to learn the box is down — probe the CHAT backend DIRECTLY so a dead
// box surfaces even before/without a run, and AUTO-RECOVERS when it's back. LIST_MODELS hits the configured
// chatUrl (backend-agnostic; it throws a network error when unreachable, an HTTP/"no models" error when it's
// up). A HANGING box (packets dropped, not refused) never calls back — so a no-RESPONSE within the window
// ALSO counts as unreachable (the "stuck on Starting…" case the user hit). Sets/clears `backendError`.
export const BACKEND_HEALTH_MS = 6000;          // probe cadence while the app is mounted
export const BACKEND_HEALTH_TIMEOUT_MS = 6000;  // no response by here → treat as unreachable (a hanging box)
let healthInFlight = false;
export function pollBackendHealth(): void {
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
export function expiresIn(expiresAt: string | null): string | null {
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
export function fmtTTL(expiresAt: string | null): string | null {
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
export type LoadState = "loaded" | "cold" | "inflight" | "unavailable" | "cloud" | "unknown";
export function modelLoadState(model: string, inFlight: boolean): { state: LoadState; tip: string } {
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


export function ModelStatusDot({ model, inFlight }: { model: string; inFlight: boolean }) {
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
/** The facts about one resident model: context window and keep-alive TTL, each with its explanation. Shared
 *  by the legend row and the chart's hover tooltip so the two can never drift — a badge added here appears in
 *  both placements, which is the whole reason this isn't inlined twice. */
export function ModelFacts({ m, tips = true }: { m: LoadedModel; tips?: boolean }) {
    const ttl = fmtTTL(m.expiresAt);
    return (
        <>
            {m.contextLength ? (
                <span class={tips ? "tt vram-ctx" : "vram-ctx"}>{fmtCtx(m.contextLength)}
                    {tips ? <span class="tt-pop left" role="tooltip">Loaded with a {m.contextLength.toLocaleString()}-token context window. Ollama preallocates the KV cache for the FULL window, even when your prompts are short. Load with a smaller <code>num_ctx</code> to reclaim it.</span> : null}
                </span>
            ) : null}
            {ttl ? (
                <span class={tips ? "tt vram-ttl" : "vram-ttl"}>{ttl}
                    {tips ? <span class="tt-pop left" role="tooltip">Keep-alive TTL — Ollama evicts this model from {m.vramBytes ? "VRAM" : "memory"} when the countdown reaches zero (expires {new Date(m.expiresAt!).toLocaleTimeString()}). Each use resets it. Set <code>keep_alive</code> to change how long it lingers.</span> : null}
                </span>
            ) : null}
        </>
    );
}

/** The model a chart band is being hovered on, so the band and its legend row highlight together. Module-level
 *  because the chart and the rows are different components either side of the panel. */
export const hoverModel = signal<string | null>(null);

export function VramPanel() {
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
    useEffect(() => { pollPs(); fetchCapacity(); }, []);   // immediate poll + the denominator
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
    const total = loaded ? loaded.reduce((s, m) => s + (hidden.has(m.model) ? 0 : (m.vramBytes ?? 0)), 0) : 0;
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
                <span class="vram-total">{formatBytes(total)} in use</span>
                <span class="sp" />
                {rows.length ? <button class="vram-free" onClick={() => evict()}>Free VRAM</button> : null}
            </div>
            {capacity.value
                ? <ResourceTracks samples={resourceHistory.value} capacity={capacity.value} hidden={hidden} />
                /* No /api/info (stock Ollama, or an OpenWebUI without the passthrough): capacity is UNKNOWN,
                   so fall back to the old auto-scaled shape rather than drawing a ceiling we don't have. */
                : <svg class="vram-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
                    {pts ? <polyline points={pts} fill="none" stroke="var(--accent)" stroke-width="1.5" /> : null}
                </svg>}
            {rows.length
                ? rows.map(m => {
                    const off = hidden.has(m.model);
                    return (
                        <div class={`vram-row${off ? " off" : ""}${hoverModel.value === m.model ? " hot" : ""}`} key={m.model}
                            onPointerEnter={() => (hoverModel.value = m.model)} onPointerLeave={() => (hoverModel.value = null)}>
                            <button class="vram-dot" style={{ background: off ? "var(--fg-faint)" : colorFor(m.model) }}
                                title={off ? "Show in totals" : "Hide from totals"} onClick={() => toggleHidden(m.model)} />
                            <span class="vram-name">{m.model}</span>
                            <ModelFacts m={m} />
                            <span class="sp" />
                            <span class="vram-gb">{m.vramBytes ? formatBytes(m.vramBytes) : m.sizeBytes ? `${formatBytes(m.sizeBytes)} (CPU)` : "?"}</span>
                            <button class="tt vram-x" aria-label="Evict from VRAM" onClick={() => evict(m.model)}>✕<span class="tt-pop" role="tooltip">Evict from VRAM</span></button>
                        </div>
                    );
                })
                : <div class="vram-empty">Nothing loaded.</div>}
        </div>
    );
}

// Shape a raw PYTHON_EXEC response into a `python-out` descriptor for RenderPanel.
export function pyBenchDescriptor(r: { ok: boolean; value?: unknown; stdout: string; error?: string; table?: { columns: string[]; rows: (string | number | null)[][] } }): RenderDescriptor {
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
export const lsGet = (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } };
export const lsSet = (k: string, v: string): void => { try { localStorage.setItem(k, v); } catch { /* opaque origin — skip */ } };
export function PythonBench() {
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
