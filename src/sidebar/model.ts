// Model-resolution + config-annotation helpers for the debug sidebar. Predicts a
// turn/session's model the way the background resolves it (so a pending turn shows
// the real model, not "default"), and annotates createChat options with which
// values are defaults. Pure except for reading the live `config` signal.
import type { DebugSessionConfig, ExtendProfile } from "../contract";
import { config } from "./store";
import type { Turn, Session } from "./store";

// createChat defaults — values equal to these get a `// default` annotation in
// the raw options view so it's obvious what the caller actually set.
export const CONFIG_DEFAULTS: Record<string, unknown> = {
    system: null, model: null, think: false, schema: false, toolIds: null, maxTokens: null, save: false,
};
// Pretty JSON with a trailing `// default` on each line whose value matches the
// default (rendered as JS so highlight.js styles the comments; the copy button
// still copies clean JSON).
export function annotatedConfig(c: DebugSessionConfig): string {
    const entries = Object.entries(c);
    const body = entries.map(([k, v], i) => {
        const val = JSON.stringify(v);
        const isDefault = val === JSON.stringify(CONFIG_DEFAULTS[k]);
        return `  ${JSON.stringify(k)}: ${val}${i < entries.length - 1 ? "," : ""}${isDefault ? "  // default" : ""}`;
    });
    return `{\n${body.join("\n")}\n}`;
}

// Which profile produced a turn, for the (default)/(utility) tag beside the
// model name. An explicitly-requested model gets no tag — only a fell-back-to
// resolution is worth flagging.
export function turnProfile(t: Turn): "utility" | "default" | null {
    if (t.reqModel) return null;
    return t.extend === "utility" ? "utility" : "default";
}
// Predict a turn's model from the config the same way the background resolves it,
// so a *pending* turn shows the real model (not "default") before its result
// lands — we already know the config client-side.
export function resolveModel(reqModel?: string | null, extend?: ExtendProfile | null): string {
    if (reqModel) return reqModel;
    if (extend === "utility") return config.value.utilityModel || config.value.model || "default";
    return config.value.model || "default";
}
// A session's model/profile follows its latest turn (the best predictor of what
// responds next). Turn-based so it distinguishes an explicit model (no tag) from
// a default fallback, and it works for a pending turn too.
export const shownModel = (s: Session): string => {
    const last = s.turns[s.turns.length - 1];
    if (last?.status === "ok" && last.model) return last.model;   // actually resolved
    return last ? resolveModel(last.reqModel, last.extend) : resolveModel(s.config.model, null);
};
export function sessionProfile(s: Session): "utility" | "default" | null {
    const last = s.turns[s.turns.length - 1];
    return last ? turnProfile(last) : null;
}

// The ":latest" tag is implicit — normalise it off so a model id matches its resident/config form.
export const normModel = (m: string): string => m.replace(/:latest$/, "");
// The context window we last OBSERVED each model loaded with (from /api/ps). A model's window is a
// property of the model, not of whether it's resident right now — so the usage gauge keeps measuring
// occupancy after the model is evicted from VRAM instead of flipping to a different metric. Overwritten
// every poll (a mid-run reload at a new num_ctx is picked up); live-resident always wins, this is only the
// fallback while evicted (last-observed — can be stale, which is fine).
export const seenContext = new Map<string, number>();
