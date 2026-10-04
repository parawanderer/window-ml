// model-status.tsx — what state a model is in, as every surface that names a model shows it: resident, cold,
// loading, unavailable or cloud (`modelLoadState`, `ModelStatusDot`), when its keep-alive runs out (`expiresIn`),
// and its capability probe. The model picker, the HUD card and the resource panel all read it from here.

import { normModel, formatBytes } from "../resource-model";
import { NO_EXPIRY_MS, modelCaps, isEmbedding, isChatModel } from "./panel-facts";
import { loadedModels, psError, models, ollamaIds } from "./store";

/** Is this model resident right now? `undefined` when we have no `/api/ps` answer yet — the caller must not
 *  read that as "not loaded", since the difference between "loading" and "we don't know" matters to what the
 *  UI claims. Matches on the tagged name, normalising `:latest` like the rest of the model plumbing. */
export function residentNow(model?: string | null): boolean | undefined {
    const loaded = loadedModels.value;
    if (!model || !loaded) return undefined;
    return loaded.some((m) => normModel(m.model) === normModel(model));
}

// "expires in Xs/Xm" from an /api/ps expires_at ISO stamp (Ollama's TTL). A BUSY runner has no deadline to
// report: the server rewrites it when the request finishes, so the stamp we hold is the one from last time.
export function expiresIn(expiresAt: string | null, busy?: boolean): string | null {
    if (busy) return "in use — TTL held";
    if (!expiresAt) return null;
    const ms = new Date(expiresAt).getTime() - Date.now();
    if (isNaN(ms) || ms <= 0) return null;
    if (ms > NO_EXPIRY_MS) return "pinned — no expiry";
    const s = Math.round(ms / 1000);
    return s < 90 ? `expires in ${s}s` : `expires in ${Math.round(s / 60)}m`;
}

// Live model-load state for the header's "responds-next" model, from /api/ps
// (resident) + the installed list + our own in-flight flag. Five states, detail
// in the tooltip (see SIDEBAR_UI_FEEDBACK.md). Reads signals directly so it
// updates on each poll; model/inFlight arrive as plain props.
export type LoadState = "loaded" | "cold" | "inflight" | "unavailable" | "cloud" | "unknown";

/** Is this model resident, loading, evicted or unknown — and the sentence explaining which. Shared by the
 *  status dot and its tooltip so the two cannot disagree. */
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
        // size_vram vs size → fully-CPU / partial-offload / full-GPU. From the EXACT bytes, in GiB like every other
        // memory figure in the panel (the rounded decimal `vramGB` read ~7% larger than the chart for the same model).
        const v = resident.vramBytes ?? (resident.vramGB != null ? resident.vramGB * 1e9 : null);
        const sz = resident.sizeBytes ?? (resident.sizeGB != null ? resident.sizeGB * 1e9 : null);
        const where = !v
            ? (sz ? `on CPU (${formatBytes(sz)} RAM)` : "on CPU (RAM)")
            : (sz && v < sz * 0.99 ? `${formatBytes(v)} of ${formatBytes(sz)} in VRAM — partial CPU offload (slower)` : `${formatBytes(v)} VRAM`);
        const bits = [where, expiresIn(resident.expiresAt, resident.busy)].filter(Boolean);
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

/** IS THIS MODEL READY — resident, loading, evicted, or unknown — as a dot beside the model name, with
 *  the residency facts on hover. The answer to "why is this run slow" is often here before the run
 *  starts. */
export function ModelStatusDot({ model, inFlight }: { model: string; inFlight: boolean }) {
    const { state, tip } = modelLoadState(model, inFlight);
    return (
        <span class="tt">
            <span class={`dot ${state}`} />
            <span class="tt-pop left" role="tooltip">{tip}</span>
        </span>
    );
}

const capsAsked = new Set<string>();

/** Ask Ollama what a model can do (`/api/show` capabilities). Undeterminable — a cloud model, an old
 *  server — is UNKNOWN, never "no". */
export function probeCaps(model: string): void {
    if (capsAsked.has(model)) return;
    capsAsked.add(model);
    try {
        chrome.runtime.sendMessage({ type: "MODEL_CAPS", payload: { model } }, (resp: any) => {
            if (chrome.runtime.lastError || !resp || resp.error) return;   // unknown, never "no"
            modelCaps.value = { ...modelCaps.value, [model]: Array.isArray(resp.data) ? resp.data : null };
        });
    } catch { /* no runtime (tests) */ }
}

/** One phrase for what a model IS, for every tooltip that names one. Empty when nobody said. */
export const modelKindLabel = (model: string): string =>
    isEmbedding(model) ? "embedding model" : isChatModel(model) ? "chat model" : "";
