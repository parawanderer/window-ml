// Per-session token / context-window usage — the occupancy bar and the delegated-subcall chip shown in
// the detail header (and the HUD). Occupancy is the LATEST call's prompt+completion (each call re-sends
// the whole history, so summing would double-count the shared prefix). Extracted from app.tsx.
import type { TokenUsage } from "../contract";
import { fmtCtx } from "../contract";
import { config, psError, loadedModels } from "./store";
import type { Session } from "./store";
import { shownModel, normModel, seenContext } from "./model";
import { IconUsage } from "./icons";

// Current context OCCUPANCY for a session = the LATEST turn's / step's usage
// (prompt + completion), NOT a sum: every call re-sends the whole history, so the
// last call's prompt already contains all prior turns. Summing would double-count
// that shared prefix N times over. Returns null when no counts were reported.
export function sessionOccupancy(s: Session): number | null {
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
export function sessionSubcall(s: Session): { tokens: number; calls: number } | null {
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
export function sessionContextLimit(model: string | null): number | null {
    if (!model) return null;
    const ps = psError.value ? null : loadedModels.value;
    const resident = ps?.find(m => m.model === model || normModel(m.model) === normModel(model));
    return resident?.contextLength ?? seenContext.get(normModel(model)) ?? null;
}

// Green → amber → red as the window fills. Interpolated in hue so it eases rather
// than jumping at thresholds (a full context = truncation, the thing to warn about).
export function usageHue(frac: number): string {
    const f = Math.max(0, Math.min(1, frac));
    const hue = 130 - 130 * f;   // 130 (green) → 0 (red), amber ~65 in the middle
    return `hsl(${Math.round(hue)}, 72%, 45%)`;
}

// A small ghosted chip beside the usage bar: tokens spent this turn on DELEGATED vision sub-calls
// (look/locate/verify). Distinct from the fill — it's separate SPEND, not context occupancy — so it
// reads as "+N sub" with its own tooltip. Null → renders nothing (no delegated calls this turn).
export function SubcallChip({ s }: { s: Session }) {
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

/** HOW FULL THE CONTEXT IS, and what this session has spent — the gauge beside the composer. Reads the
 *  model's own window when it is known, so the bar means tokens rather than a guess. */
export function UsageBar({ s }: { s: Session }) {
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
