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
/** Which model profile a session actually ran on — `utility` or the default. Read from the RESOLVED
 *  model the server reported, not from what the caller requested (which is null for a utility run). */
export function sessionProfile(s: Session): "utility" | "default" | null {
    const last = s.turns[s.turns.length - 1];
    return last ? turnProfile(last) : null;
}

// ONE model, spelled two ways by one server. `/api/ps` reports Ollama's SHORT name (`gemma4:31b`) while the
// event stream reports the fully-qualified one (`registry.ollama.ai/library/gemma4:31b`) — so without this
// the panel drew every streamed model a SECOND time, in its own colour, badged "off-box" as though it had
// never been resident. The inverse of Ollama's own ShortName: the default registry comes off, then the
// default `library` namespace, then the implicit `:latest` tag. Deliberately only the DEFAULTS — a model
// pulled from elsewhere (`hf.co/user/model`) keeps its prefix, because ps keeps it too, and stripping to the
// last path segment would collide two genuinely different models that happen to share a name.
const DEFAULT_REGISTRY = "registry.ollama.ai/";
const DEFAULT_NAMESPACE = "library/";
/** ONE CANONICAL NAME for a model. The event stream names them fully-qualified
 *  (`registry.ollama.ai/library/gemma4:31b`) while `/api/ps` names them short, in the same frame — so
 *  without this every streamed model is drawn TWICE, once as a phantom "off-box" row. The inverse of
 *  Ollama's own ShortName: default registry, default `library` namespace, implicit `:latest`. */
export const normModel = (m: string): string => {
    let s = m.startsWith(DEFAULT_REGISTRY) ? m.slice(DEFAULT_REGISTRY.length) : m;
    if (s.startsWith(DEFAULT_NAMESPACE)) s = s.slice(DEFAULT_NAMESPACE.length);
    return s.replace(/:latest$/, "");
};
// The context window we last OBSERVED each model loaded with (from /api/ps). A model's window is a
// property of the model, not of whether it's resident right now — so the usage gauge keeps measuring
// occupancy after the model is evicted from VRAM instead of flipping to a different metric. Overwritten
// every poll (a mid-run reload at a new num_ctx is picked up); live-resident always wins, this is only the
// fallback while evicted (last-observed — can be stale, which is fine).
export const seenContext = new Map<string, number>();
