// Debug-event reducer — the state-aggregation layer of the sidebar. injected.js pushes a one-way
// MlDebugEvent stream (over window.postMessage) and onDebug folds each event into the session model
// (sessionMap + the rev signal): agent runs, chat turns, cross-page replay ordering (the orphan
// queue), mid-run steers, live streaming. It also owns the lazy utility-model TITLE + per-task BLOCK
// summaries and the run-block segmentation (buildRunBlocks). Pure logic, no JSX — extracted from app.tsx.
import { sessionMap, rev, config, sidebarOpen, backendError } from "./store";
import type { Session, Status, Turn, AgentStep } from "./store";
import type { MlDebugEvent } from "../contract";
import { isBackendUnreachable } from "../contract";
import { truncate, lastUser, rollupStatus } from "./format";

// The highest (cumulative) step number seen so far — the position a say()/answer arriving NOW belongs at,
// so the chat log interleaves user messages + answers with the turn step-groups in order.
export const maxSessionStep = (s: Session): number => Math.max(0, ...(s.steps || []).map(x => x.step || 0));

// Agent step/result events whose `agent` START hasn't arrived yet. On a cross-page re-adopt the REPLAY sends
// the start first, but a live agent-result can momentarily beat it onto the fresh document — dropping it lost a
// finished run's answer. We QUEUE such orphans by hash and drain them when the start lands. Crucially we do NOT
// manufacture a session from an orphan: a truly stray event (e.g. a DevTools ring-buffer that evicted an old
// run's start) would otherwise leave a headless "(no prompt)" phantom stuck on screen forever.
const orphanAgentEvents = new Map<string, MlDebugEvent[]>();
const ORPHAN_CAP = 400;   // per-hash bound so a stray hash spamming events can't grow unbounded
// Steer ids the agent has DRAINED ("seen"). Its agent-say-seen may arrive BEFORE the agent-say bubble
// (cross-page replay reorders), so remembering the id here lets a later bubble render pre-marked — the
// same order-independence the orphan queue gives steps. Bounded so a rogue stream can't grow it forever.
const steerSeen = new Set<string>();
const STEER_SEEN_CAP = 2000;
function markSteerSeen(id: string): void { if (steerSeen.size < STEER_SEEN_CAP) steerSeen.add(id); }
function queueOrphan(hash: string, ev: MlDebugEvent): void {
    let q = orphanAgentEvents.get(hash);
    if (!q) { q = []; orphanAgentEvents.set(hash, q); }
    if (q.length < ORPHAN_CAP) q.push(ev);
}
function drainOrphans(hash: string): void {
    const q = orphanAgentEvents.get(hash);
    if (!q) return;
    orphanAgentEvents.delete(hash);   // delete BEFORE replaying so the drained events find the session, not re-queue
    for (const oev of q) onDebug(oev);
}

export function onDebug(ev: MlDebugEvent): void {
    // --- ml.agent runs (own session kind) ---
    if (ev.kind === "agent") {
        const prev = sessionMap.get(ev.session.hash);
        // A cross-page re-adopt REPLAYS this start event. If the session already exists — from the run's first
        // life, OR because a live agent-step/agent-result raced ahead of the replay onto the fresh document —
        // do NOT recreate it: that would wipe the steps/answer/ended state the live events populated, leaving a
        // finished run stuck "running" with no answer (the cross-DOMAIN "completed but still running" bug).
        // Refresh identity fields only; never clear steps/answers/status.
        if (prev && prev.kind === "agent") {
            prev.model = ev.model ?? prev.model;
            prev.task = prev.task ?? ev.task;
            prev.taskImages = prev.taskImages ?? ev.images;
            prev.maxSteps = ev.maxSteps ?? prev.maxSteps;
            prev.agentConfig = ev.config ?? prev.agentConfig;
            if (ev.resumed) prev.resumed = true;
            prev.lastTs = Math.max(prev.lastTs, ev.ts);
            drainOrphans(ev.session.hash);
            rev.value++; return;
        }
        sessionMap.set(ev.session.hash, {
            hash: ev.session.hash, model: ev.model, tag: "session", kind: "agent",
            createdTs: ev.ts, lastTs: ev.ts, status: "pending", turns: [], steps: [], task: ev.task, taskImages: ev.images, pageUrl: ev.pageUrl, pageTitle: ev.pageTitle, maxSteps: ev.maxSteps, agentConfig: ev.config, resumed: ev.resumed,
            config: { system: null, model: ev.model, think: null, schema: false, toolIds: null, maxTokens: null, save: false },
        });
        drainOrphans(ev.session.hash);   // apply any step/result that raced ahead of this start (cross-page replay)
        rev.value++; return;
    }
    if (ev.kind === "agent-step") {
        const s = sessionMap.get(ev.session.hash);
        if (!s) { queueOrphan(ev.session.hash, ev); return; }   // no start yet → hold it, don't manufacture a phantom
        // LIVE tool-output delta (ctx.stream): carries ONLY { step, seq, streamOutput } (no tool) — patch it
        // ADDITIVELY onto the pending row (never rebuild the step, which would wipe tool/args). The DONE (with
        // a result + tool) supersedes it below. Ignore a delta whose START hasn't landed yet.
        if (ev.streamOutput != null && ev.tool == null && ev.seq != null) {
            const steps0 = s.steps || [];
            const j = steps0.findIndex(x => x.seq === ev.seq);
            if (j >= 0) { s.steps = steps0.map((x, k) => k === j ? { ...x, streamOutput: ev.streamOutput, streamMarks: ev.streamMarks } : x); s.lastTs = ev.ts; rev.value++; }
            return;
        }
        // `ts` is kept because a step is a point on the machine's TIMELINE as well as a row in a transcript: the
        // resource panel's event lane places it against what memory was doing at that moment.
        const step = { step: ev.step, localStep: ev.localStep, seq: ev.seq, toolMs: ev.toolMs, approveMs: ev.approveMs, remoteMs: ev.remoteMs, ts: ev.ts, pending: ev.pending, awaitingApproval: ev.awaitingApproval, thought: ev.thought, reasoning: ev.reasoning, tool: ev.tool, arguments: ev.arguments, result: ev.result, modelResult: ev.modelResult, streamMarks: ev.streamMarks, token: ev.token, elements: ev.elements, renderIn: ev.renderIn, renderOut: ev.renderOut, feedback: ev.feedback, argIssues: ev.argIssues, approval: ev.approval, usage: ev.usage, subUsage: ev.subUsage, grants: ev.grants, reused: ev.reused };
        const steps = s.steps || [];
        // In-flight: a tool step arrives twice — a pending START then the DONE, sharing a `seq`.
        // Patch the existing row in place (immutably) so it fills in; otherwise append. Thoughts
        // and single-emit steps have no seq → always append.
        const i = ev.seq != null ? steps.findIndex(x => x.seq === ev.seq) : -1;
        // When patching the pending START with its DONE, COALESCE the render slots: a DENIED call's
        // DONE carries no renderIn/renderOut (the tool never ran → no envelope), which would blank
        // out the In preview the awaiting-approval START already showed. A render only ever appears,
        // never legitimately vanishes, so keep the existing one when the DONE doesn't supply a newer.
        // Keep the stream MARKS across the DONE (like the render slots): the settled Out renders the SAME
        // captured text the stream produced — both keep the head under one cap — so the executor's per-line
        // timestamps stay valid for it. `streamOutput` itself is still superseded by the real result.
        const merged = i >= 0
            ? { ...step, renderIn: step.renderIn ?? steps[i].renderIn, renderOut: step.renderOut ?? steps[i].renderOut,
                streamMarks: step.streamMarks ?? steps[i].streamMarks }
            : step;
        s.steps = i >= 0 ? steps.map((x, k) => k === i ? merged : x) : [...steps, step];
        // A step means the agent is actively working — flip to pending so a follow-up turn on an already-
        // "done" session (whose prior summary still sits in s.summary) reads as WORKING, not terminal. This
        // covers the off/card path where the page-side agent-say bridge is dormant, so a step is the first
        // signal the run resumed. The next agent-result flips it back to ok/err. BUT skip a STRAGGLER: a
        // background-hosted run (design A / DevTools) keeps fanning the in-flight tool's late DONE after a
        // cancel, and it lands AFTER the page's cancelled result — which would wrongly re-show "running"
        // with no result ever coming to clear it. A straggler's step is ≤ the sealed turn's last step; a
        // real new/continuing turn always advances past it (and unseals).
        // Unseal (re-show "running") only for a NON-pending step past the sealed turn — a resumed off-mode
        // turn's thought/DONE, which agent-say can't announce there (the page-side bridge is dormant). A bare
        // PENDING START must NOT unseal a sealed, answered run: after a nav (or a cancel), the background loop's
        // in-flight tool can fan a late START for the NEXT step (step > endedStep) whose DONE never arrives (the
        // run already ended), which used to flip the finished run back to "running" forever — the "task's done
        // but the sidebar still says running" bug. A real resumed turn always follows with a DONE that unseals.
        if (!s.ended || (!ev.pending && (ev.step || 0) > (s.endedStep ?? -1))) { s.status = "pending"; s.ended = false; }
        s.liveStream = undefined; s.liveTurn = undefined;   // a real step landed → the live preview + in-flight turn are superseded by it
        s.lastTs = ev.ts; rev.value++; return;
    }
    if (ev.kind === "agent-result") {
        // On a re-adopted page the result can land BEFORE the replayed `agent` start; queue it (don't drop —
        // that was half of the "completed but stuck running, no answer" bug) and apply it when the start drains.
        const s = sessionMap.get(ev.session.hash);
        if (!s) { queueOrphan(ev.session.hash, ev); return; }
        const status: Status = (ev.error || ev.hitCap || ev.cancelled) ? "err" : "ok";
        // Seal against the run's OWN final step count (ev.steps), not just the steps that have ARRIVED. On a
        // re-adopted page the result can beat the replayed steps here, so maxSessionStep is 0 — sealing at that
        // would let the later steps (step > 0) re-open "running". ev.steps is the authoritative end (turn 1's
        // step numbers run 1..N with no base offset; a multi-turn handle's live order already has the steps in
        // hand, so maxSessionStep dominates there). Also positions the answer AFTER the steps in the chat log.
        const endStep = Math.max(maxSessionStep(s), ev.steps || 0);
        // Append this turn's answer (chat log) — do NOT overwrite prior turns. `summary`/`status` still
        // track the LATEST for the title + row dot.
        s.answers = [...(s.answers || []), { text: ev.summary, ts: ev.ts, atStep: endStep, status, hitCap: ev.hitCap, cancelled: !!ev.cancelled, error: ev.error || undefined }];
        s.summary = ev.summary; s.hitCap = ev.hitCap; s.error = ev.error || undefined; s.cancelled = !!ev.cancelled;
        // Backend health: a run that couldn't reach the box flags the offline banner/card; any run that
        // finished (or failed for another reason) means the box answered → clear it.
        if (ev.error && isBackendUnreachable(ev.error)) backendError.value = ev.error;
        else if (!ev.error) backendError.value = "";
        // REPLACE (not merge): each turn's result carries THIS turn's answer media, so a new round that
        // designates nothing CLEARS the old answer (resets to 0) — the card never shows a stale prior answer.
        s.answerMedia = (ev.answerMedia && ev.answerMedia.length) ? ev.answerMedia : undefined;   // HUD card only
        s.answer = ev.answer || undefined;   // the curated answer-set markdown → the card renders it when it cites a @tool
        s.status = status; s.lastTs = ev.ts;
        // A finished run has no in-flight step: clear any lingering pending/awaiting flags so a straggler START
        // that arrived BEFORE this result (a background run's late tool fan) doesn't render a phantom "running…"
        // row under a completed run. (The after-result ordering is handled by the seal in agent-step.)
        if ((s.steps || []).some(st => st.pending)) s.steps = (s.steps || []).map(st => st.pending ? { ...st, pending: false, awaitingApproval: false } : st);
        // Seal the turn (see agent-step): a later straggler/replayed step ≤ endStep can't re-open "running".
        s.ended = true; s.endedStep = endStep; s.liveStream = undefined; s.liveTurn = undefined;
        rev.value++; return;
    }
    // A handle raised the step cap mid-run (a.maxSteps = N) → the "STEP x/N" display re-renders live.
    if (ev.kind === "agent-cap") {
        const s = sessionMap.get(ev.session.hash);
        if (s) { s.maxSteps = ev.maxSteps; s.lastTs = ev.ts; rev.value++; }
        return;
    }
    // A user message mid-conversation: a follow-up run()'s task OR a mid-run say(). Both render as "you"
    // bubbles, interleaved with the turns by step position (atStep = the step count when they arrived).
    if (ev.kind === "agent-say") {
        const s = sessionMap.get(ev.session.hash);
        if (!s) { queueOrphan(ev.session.hash, ev); return; }   // start not here yet → hold, don't drop the bubble
        // A new user message means the agent is (about to be) working → back to pending, so the live footer
        // shows during a follow-up run (harmless for a mid-run steer, which is already pending). `seen` starts
        // from the drained-id set, so a "seen" event that raced ahead of this bubble already counts.
        const seen = !!(ev.sayId && steerSeen.has(ev.sayId));
        s.says = [...(s.says || []), { text: ev.text, ts: ev.ts, atStep: maxSessionStep(s), images: ev.images, id: ev.sayId, seen }];
        s.status = "pending"; s.ended = false; s.lastTs = ev.ts; rev.value++;
        return;
    }
    // The agent drained a queued steer at a step boundary → flip its bubble's "seen" indicator. Keyed by
    // sayId, and order-independent: if the bubble isn't here yet (replay reorder), remember the id so the
    // bubble renders pre-marked when it lands.
    if (ev.kind === "agent-say-seen") {
        markSteerSeen(ev.sayId);
        const s = sessionMap.get(ev.session.hash);
        if (s && s.says?.some(x => x.id === ev.sayId && !x.seen)) {
            s.says = s.says.map(x => x.id === ev.sayId ? { ...x, seen: true } : x);
            s.lastTs = Math.max(s.lastTs, ev.ts); rev.value++;
        }
        return;
    }
    // Live model output DURING a step (opt-in stream:true): show the accumulated thinking/reply as it
    // generates, so a long reasoning phase isn't a frozen token count. Superseded when the step's real
    // events land (agent-step / agent-result clear liveStream). Transient — no start yet → just drop it.
    if (ev.kind === "agent-stream") {
        const s = sessionMap.get(ev.session.hash);
        if (!s) return;
        s.liveStream = { step: ev.step, localStep: ev.localStep, reasoning: ev.reasoning, content: ev.content };
        s.status = "pending"; s.ended = false; s.lastTs = ev.ts; rev.value++;
        return;
    }
    // A model call is UNDERWAY (and, on a streamed run, which channel it is emitting). This is what lets the
    // resource panel draw a generation WHILE it happens; without it the first thing any surface hears about a
    // 40-second turn is the finished block, back-dated over memory it already drew.
    if (ev.kind === "agent-turn") {
        const s = sessionMap.get(ev.session.hash);
        // Ignore it for a session that has already ENDED. Events can arrive in any order (a cross-page replay
        // interleaves with the live fan), and a turn-start landing after the run's result would otherwise
        // strand a live bar that never clears.
        if (!s || s.ended) return;
        s.liveTurn = { step: ev.step, localStep: ev.localStep, startedTs: ev.ts, phases: ev.phases };
        s.status = "pending"; s.lastTs = Math.max(s.lastTs, ev.ts); rev.value++;
        return;
    }
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
        const turn: Turn = { id: ev.id, ts: ev.ts, user: lastUser(ev.request.messages), images: ev.request.images, status: "pending", reqModel: ev.request.model, extend: ev.request.extend };
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
            ? { ...prev, assistant: ev.content, sources: ev.sources, structured: ev.structured, status: "ok", ts: ev.ts, model: ev.model, extend: ev.extend, reasoning: ev.reasoning, usage: ev.usage }
            : { ...prev, error: ev.error, status: "err", ts: ev.ts };
        // Backend health (mirror the agent-result path): a chat that couldn't reach the box flags offline; a
        // successful chat-result clears it.
        if (ev.kind === "chat-error" && isBackendUnreachable(ev.error)) backendError.value = ev.error;
        else if (ev.kind === "chat-result") backendError.value = "";
        s.turns = s.turns.map((x, idx) => idx === i ? updated : x);
        s.lastTs = ev.ts; s.status = rollupStatus(s);
    }
    rev.value++;   // notify Preact
}

/* --------------------------- session titles ------------------------------
 * Claude-Code-style short titles, generated by the *utility* model. This is
 * done entirely sidebar-side (the iframe can call the background's FETCH_LLM
 * directly, same as "Test models") — no page-`ml` round-trip. It's lazy: we
 * only summarise a session while the panel is actually open (gated on
 * sidebarOpen), and only its first completed turn. Until a title lands the row
 * falls back to the truncated first prompt. `titleTried` bounds retries to once
 * per open (cleared on a fresh open, so a failure backfills next time).
 */
export const titleTried = new Set<string>();

function cleanTitle(raw: string): string {
    const line = raw.trim().split("\n").map(s => s.trim()).filter(Boolean)[0] || "";
    return truncate(line.replace(/^["'`*]+|["'`*.]+$/g, "").trim(), 60);
}

export function genTitle(hash: string, prompt: string): void {
    const messages = [
        { role: "system", content: "You write terse 3-6 word titles for a request. Reply with ONLY the title — no quotes, no trailing punctuation, no preamble." },
        { role: "user", content: `Summarise this request as a short title:\n\n${truncate(prompt, 500)}` },
    ];
    chrome.runtime.sendMessage(
        { type: "FETCH_LLM", payload: { messages, extend: "utility", maxTokens: 32, think: false } },
        (resp: any) => {
            const s = sessionMap.get(hash);
            if (!s || chrome.runtime.lastError || !resp || resp.error) return;   // leave unset → retried next open
            const title = cleanTitle(String(resp.data || ""));
            if (title) { s.title = title; rev.value++; }
        },
    );
}

// ---- Run-block segmentation + lazy per-block summaries (HUD "Show work" ONLY) ----
// A multi-turn HUD run is a chain of TASKS, each ending when the agent answers. In Show-work we group the
// trace into per-task BLOCKS, collapse the priors, and — lazily, once Show-work is opened — summarise each
// with the UTILITY model (cached). The user's own prompt is the instant fallback until/unless a summary lands.
export const blockSummaries = new Map<string, string>();   // `${hash}:${blockIndex}` → the one-line summary
const blockSummaryTried = new Set<string>();
export const blockKey = (hash: string, i: number): string => `${hash}:${i}`;
export function ensureBlockSummary(hash: string, i: number, prompt: string, result: string): void {
    if (!config.value.utilityModel.trim()) return;   // no utility model → the prompt fallback simply stays
    const key = blockKey(hash, i);
    if (blockSummaries.has(key) || blockSummaryTried.has(key)) return;
    blockSummaryTried.add(key);
    const messages = [
        { role: "system", content: "You write a terse one-line summary (≤ 16 words) of one task within an agent session — what the user asked and what the agent did/produced. Reply with ONLY the summary: no quotes, no preamble." },
        { role: "user", content: `Request:\n${truncate(prompt || "(none)", 400)}\n\nResult:\n${truncate(result || "(no result)", 400)}` },
    ];
    chrome.runtime.sendMessage(
        { type: "FETCH_LLM", payload: { messages, extend: "utility", maxTokens: 48, think: false } },
        (resp: { data?: unknown; error?: string } | undefined) => {
            if (chrome.runtime.lastError || !resp || resp.error) { blockSummaryTried.delete(key); return; }   // retry next open
            const line = String(resp.data || "").trim().split("\n").map(x => x.trim()).filter(Boolean)[0] || "";
            // Strip surrounding quotes/marks AND a leading "Summary:"/"Task -" label the model adds despite
            // the "no preamble" instruction (it was showing literally as "Summary: …" in the block header).
            const s = truncate(line.replace(/^["'`*]+|["'`*.]+$/g, "").trim().replace(/^(summary|task)\s*[:\-–]\s*/i, "").trim(), 120);
            if (s) { blockSummaries.set(key, s); rev.value++; }
        },
    );
}
export type SayItem = NonNullable<Session["says"]>[number];
export interface RunTaskBlock { prompt: string; promptImages?: string[]; turns: AgentTurnGroup[]; steers: SayItem[]; answer: NonNullable<Session["answers"]>[number] | null; }
// Segment a run into per-task blocks (a prompt → its turns → its answer). null when there's ≤1 task — nothing
// to segment, so Show-work renders its flat trace as before.
export function buildRunBlocks(run: Session): RunTaskBlock[] | null {
    const answers = run.answers || [];
    if (answers.length <= 1) return null;
    const says = run.says || [];
    // `run.says` is OVERLOADED: a new-turn follow-up (a continuation — NO sayId) AND a mid-run STEER (has a
    // sayId, injected into the running turn, no answer of its own). Only continuations map 1:1 to answers, so
    // the block PROMPT must index the CONTINUATIONS — indexing all says shifts every message into the wrong
    // (previous) block the moment a steer exists. Steers render INLINE with the turns, at their step.
    const continuations = says.filter(s => !s.id);
    const turns = groupTurns(run.steps || []).filter(t => t.thought || t.reasoning || t.tools.length);
    const blocks: RunTaskBlock[] = [];
    let prev = -Infinity;
    for (let i = 0; i < answers.length; i++) {
        const boundary = answers[i].atStep;
        blocks.push({
            prompt: i === 0 ? (run.task || "") : (continuations[i - 1]?.text || ""),
            promptImages: i === 0 ? run.taskImages : continuations[i - 1]?.images,
            turns: turns.filter(t => t.step > prev && t.step <= boundary),
            steers: says.filter(s => s.id && s.atStep > prev && s.atStep <= boundary),   // mid-run messages IN this block
            answer: answers[i],
        });
        prev = boundary;
    }
    return blocks;
}

// Scan for sessions still needing a title and kick off generation. Called from
// App's effect on every session change / open transition.
export function maybeGenerateTitles(): void {
    // Opt-in: only when a utility model is configured AND auto-titles is on.
    // Without a utility model, extend:"utility" would fall back to the (expensive)
    // main model — a user who hasn't set one hasn't asked for auto-titles.
    if (!sidebarOpen.value || !config.value.autoTitles || !config.value.utilityModel.trim()) return;
    for (const s of sessionMap.values()) {
        if (s.title || titleTried.has(s.hash)) continue;
        // A CHAT session titles off its first completed turn; an AGENT run has no chat turns, so it titles off
        // its `task` (known from agent-start) — same utility-model summariser, so both surfaces read alike.
        const first = s.turns[0];
        const prompt = first
            ? (first.status === "ok" && first.user.trim() ? first.user : "")
            : (s.task?.trim() ? s.task : "");
        if (!prompt) continue;
        titleTried.add(s.hash);
        genTitle(s.hash, prompt);
    }
}

// A step of one ml.agent TURN (one LLM call): the assistant's prose (thought) + its separate
// reasoning/thinking + its batched tool calls.
// `step` is the SESSION-cumulative step (the grouping key, so turn N's steps don't merge with turn 1's);
// `localStep` is the PER-TURN step shown in the pill — maxSteps is a per-turn budget, so a follow-up run
// counts 1/N again, not 18/20. (Falls back to `step` for a pre-localStep event.)
export interface AgentTurnGroup { step: number; localStep: number; thought?: string; reasoning?: string | null; tools: AgentStep[]; }
export function groupTurns(steps: AgentStep[]): AgentTurnGroup[] {
    const byStep = new Map<number, AgentTurnGroup>();
    const order: number[] = [];
    for (const st of steps) {
        let t = byStep.get(st.step);
        if (!t) { t = { step: st.step, localStep: st.localStep ?? st.step, tools: [] }; byStep.set(st.step, t); order.push(st.step); }
        if (st.thought != null) t.thought = st.thought;
        if (st.reasoning != null) t.reasoning = st.reasoning;
        if (st.tool) t.tools.push(st);
    }
    return order.map(s => byStep.get(s)!);
}
