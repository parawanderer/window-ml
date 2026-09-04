// HUD-card state — the signals + pure helpers that drive the off-mode "card" surface and the Spotlight
// composer: which run is selected, collapse/dismiss/maximize sets, the composer inputs (model/steps/
// stream/vision), and the run-selection logic (cardRuns / selectedRun / isPendingGate). A leaf module
// (no JSX) shared by the card view components AND app.tsx's message bus. Extracted from hud-card.tsx.
import { signal } from "@preact/signals";
import type { ElementContext } from "../contract";
import { sessionMap, ollamaIds, config } from "./store";
import type { AgentStep, Session } from "./store";
import { decidedSteps, stepKey } from "./ui-kit";
import { utilitySummariesOn } from "./summaries";
import { genTitle } from "./debug-reducer";

// Multi-run HUD state. The card shows ONE run (the SELECTED one); a tab strip switches between concurrent
// runs. These are keyed by run hash so one run's collapse/dismiss never touches another's ("" selection =
// auto-pick). Sets are replaced immutably (a mutate-in-place wouldn't re-render — signals gotcha).
export const cardSelectedHash = signal<string>("");        // which run's card is showing ("" → auto-pick)
export const cardDetail = signal(true);                    // multi-run: tabbed DETAIL (true) ⇄ calm summary toast (false)
export const cardCollapsedSet = signal<Set<string>>(new Set());   // run hashes collapsed to a toast (finished cards)
export const cardDismissedSet = signal<Set<string>>(new Set());   // run hashes the user dismissed (× on a card)
export const cardSteerHash = signal<string>("");   // a LIVE run whose HUD card is showing the inline steer box (orb → "Steer this run…")
export const isCardCollapsed = (h: string): boolean => cardCollapsedSet.value.has(h);
export const isCardDismissed = (h: string): boolean => cardDismissedSet.value.has(h);
export const setCardCollapsed = (h: string, v: boolean): void => {
    const s = new Set(cardCollapsedSet.value); v ? s.add(h) : s.delete(h); cardCollapsedSet.value = s;
};
export const dismissCardRun = (h: string): void => {
    const s = new Set(cardDismissedSet.value); s.add(h); cardDismissedSet.value = s;
    if (cardSelectedHash.value === h) cardSelectedHash.value = "";   // let the reconciler auto-pick the next
};
// cardShowWorkHash + revealSeq now live in ./store (shared with the answer-render provenance jump).
export const cardMaximizedHash = signal<string>("");   // the run whose card is MAXIMISED (a near-full-page corner window)
export const composerOpen = signal(false);          // the Spotlight composer — the HUD morphs into a task input
export const composerElement = signal<ElementContext | null>(null);   // right-click "ask about this" → the element pill's context
// Where the composer's send goes: a NEW run (default, Spotlight/"ask about this") or APPENDED to an already-
// open run (right-click "add to current run" → steer if it's running, follow-up if idle).
export const composerTarget = signal<{ mode: "new" } | { mode: "append"; hash: string }>({ mode: "new" });
export const composerMaxSteps = signal(20);         // step budget for a UI-started run (persists across opens)
export const STEP_BUDGETS = [10, 20, 50];           // the segmented presets in the composer
// Stream the model's thinking live for a UI-started run. ALWAYS on for the Commander: a run you start from
// the HUD is one you are watching, so the reactive mode is the only one that makes sense there — the toggle
// that used to sit in the composer bar had one useful setting and cost a button. Kept as a signal because it
// is what the run is started with, and it is the seam a control would come back through if one is ever
// wanted. (Console `ml.agent` stays default-off — the primitive is unchanged.)
export const composerStream = signal(true);
export const composerStarting = signal(0);          // timestamp: a UI run was sent, awaiting its first event (bridge pill)
// Per-call model pick for a UI-started run. "" = follow the configured default (so switching the default
// from the dropdown just keeps this on it). A non-"" value overrides the model FOR THIS RUN ONLY — the
// startRun payload carries it to createAgent({ model }); it never touches config. Persists across opens.
export const composerModel = signal("");
export const composerModelOpen = signal(false);     // the model-picker dropdown is open (over the composer foot)
// Per-call FORCE-NATIVE vision, only meaningful for a NON-Ollama picked model whose vision we can't probe
// (e.g. GPT-4o / minimax). ON → startRun passes ml.agent's `vision: true` (see with its own model) for
// this run; OFF → the default routing (delegate to the OCR reader if one sees). Ollama models auto-detect,
// so the toggle is hidden for them — the composer mirror of the Settings "vision capable?" lock.
export const composerVision = signal(false);
// Known Ollama-backed? The server's provenance list is authoritative.
export const isOllamaModel = (id: string): boolean => !!ollamaIds.value?.includes(id);
// AFFIRMATIVELY non-Ollama — provenance is loaded (ollamaIds non-null) AND doesn't list it. Used to gate the
// native-vision toggle: while the list is still loading (null) this is false, so the eye doesn't flash in then
// out and shove the chip when LIST_MODELS lands. The send() vision override reads the same signal.
export const isCloudModel = (id: string): boolean => ollamaIds.value != null && !ollamaIds.value.includes(id);
// The model a UI-started run will actually use: the per-call override, else the configured default.
export const composerResolvedModel = (): string => composerModel.value || config.value.model || "";
// Switch the CONFIGURED default model from the composer dropdown (a testing convenience — no Settings trip).
// SET_MODEL validates against the server list + persists to sync storage; the app's storage.onChanged
// listener folds it back into config.value. Reset the per-call override so the composer follows the new default.
export function setDefaultModel(id: string): void {
    chrome.runtime.sendMessage({ type: "SET_MODEL", payload: { model: id } }, () => { void chrome.runtime.lastError; });
    composerModel.value = "";
    composerModelOpen.value = false;
}
export const orbHover = signal(false);              // hovering the working orb → it stretches into a labelled capsule
export const cardTitleTried = new Set<string>();

// A live, not-yet-decided approval gate (mirrors PendingNote's blocked check).
export const isPendingGate = (hash: string, st: AgentStep): boolean =>
    !!(st.pending && st.awaitingApproval && !(st.seq != null && decidedSteps.has(stepKey(hash, st.seq))));

// --- Multi-run card selection ---------------------------------------------------------------------
// A run is TERMINAL once its turn settled (not mid-turn): a follow-up run() keeps the prior summary, so
// the status guard is what stops a stale answer showing instead of the working orb.
export const runIsDone = (s: Session): boolean => s.status !== "pending" && (s.summary != null || !!s.error || !!s.cancelled);
export const runIsPending = (s: Session): boolean => (s.steps || []).some(st => isPendingGate(s.hash, st));
// The runs the card cares about: non-silent agent runs the user hasn't dismissed. A silent run
// (ml.agent({ silent })) shows no card (approvals still surface, handled per-run below). Stable tab
// order by createdTs so tabs don't reshuffle as runs emit.
export const cardWorthy = (s: Session): boolean => s.kind === "agent" && !s.agentConfig?.silent && !isCardDismissed(s.hash);
export const cardRuns = (): Session[] => [...sessionMap.values()].filter(cardWorthy).sort((a, b) => a.createdTs - b.createdTs);
// The run whose card is showing. STICKY (badge-don't-steal): keep the current selection while it's still
// card-worthy — a new concurrent run adds a tab, it never hijacks the view. Auto-pick only when nothing
// valid is selected: prefer a run awaiting approval (it needs you), else the most recently active.
export const selectedRun = (): Session | null => {
    const runs = cardRuns();
    if (!runs.length) return null;
    const cur = cardSelectedHash.value && runs.find(s => s.hash === cardSelectedHash.value);
    if (cur) return cur;
    const pending = runs.filter(runIsPending).sort((a, b) => b.lastTs - a.lastTs)[0];
    return pending || runs.reduce<Session | null>((best, s) => (!best || s.lastTs > best.lastTs ? s : best), null);
};

// Lazily summarise the run's task with the utility model (if configured) for the toast headline —
// the sidebar's title machinery, but ungated on sidebarOpen (irrelevant to the card).
export function ensureCardTitle(s: Session): void {
    if (s.title || cardTitleTried.has(s.hash) || !utilitySummariesOn()) return;
    cardTitleTried.add(s.hash);
    genTitle(s.hash, s.task || "");
}
