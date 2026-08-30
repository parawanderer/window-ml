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
import type { MlDebugEvent, DebugSessionConfig, DebugAgentConfig, NeutralMessage, MlConfig, ApiFormat, Theme, LoadedModel, ExtendProfile, RenderDescriptor, ToolFeedback, LocateSubstep, TokenUsage, TableSource, ElementContext, AnswerMedia } from "../contract";
import { DEFAULT_CONFIG, fmtCtx } from "../contract";
import { elementReference, externalSheetIds } from "../dom";
import {
    FONT_KEY, WRAP_KEY, LINES_KEY,
    sessionMap, rev, view, fontScale, codeWrap, codeLineNumbers, config, models,
    ollamaIds, vramOpen, sidebarOpen, loadedModels, psError, turnsRun, backendError,
} from "./store";
import { isBackendUnreachable } from "../contract";
import type { ReusedGrant } from "../contract";
import type { Status, Turn, AgentStep, Session } from "./store";
import { pretty, shortStamp, fullStamp, truncate, collapsedPreview, highlight, beautifyJs, htmlLines, markdown, stripFormatting, lastUser, rollupStatus } from "./format";
import { annotatedConfig, turnProfile, shownModel, sessionProfile } from "./model";
import { exportSession, printSession } from "./export";
import { applyTheme, applyFont, applyCodePrefs, initThemeStyle } from "./prefs";
import { IconCopy, IconCheck, IconWarn, IconChevron, IconGear, IconExport, IconVram, IconSend, IconStop, IconUsage, IconBench, IconSheet, IconEye, IconEyeOff } from "./icons";
import { Settings } from "./settings";

// The highest (cumulative) step number seen so far — the position a say()/answer arriving NOW belongs at,
// so the chat log interleaves user messages + answers with the turn step-groups in order.
const maxSessionStep = (s: Session): number => Math.max(0, ...(s.steps || []).map(x => x.step || 0));

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

function onDebug(ev: MlDebugEvent): void {
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
            createdTs: ev.ts, lastTs: ev.ts, status: "pending", turns: [], steps: [], task: ev.task, taskImages: ev.images, maxSteps: ev.maxSteps, agentConfig: ev.config, resumed: ev.resumed,
            config: { system: null, model: ev.model, think: null, schema: false, toolIds: null, maxTokens: null, save: false },
        });
        drainOrphans(ev.session.hash);   // apply any step/result that raced ahead of this start (cross-page replay)
        rev.value++; return;
    }
    if (ev.kind === "agent-step") {
        const s = sessionMap.get(ev.session.hash);
        if (!s) { queueOrphan(ev.session.hash, ev); return; }   // no start yet → hold it, don't manufacture a phantom
        const step = { step: ev.step, localStep: ev.localStep, seq: ev.seq, pending: ev.pending, awaitingApproval: ev.awaitingApproval, thought: ev.thought, reasoning: ev.reasoning, tool: ev.tool, arguments: ev.arguments, result: ev.result, elements: ev.elements, renderIn: ev.renderIn, renderOut: ev.renderOut, feedback: ev.feedback, argIssues: ev.argIssues, approval: ev.approval, usage: ev.usage, subUsage: ev.subUsage, grants: ev.grants, reused: ev.reused };
        const steps = s.steps || [];
        // In-flight: a tool step arrives twice — a pending START then the DONE, sharing a `seq`.
        // Patch the existing row in place (immutably) so it fills in; otherwise append. Thoughts
        // and single-emit steps have no seq → always append.
        const i = ev.seq != null ? steps.findIndex(x => x.seq === ev.seq) : -1;
        // When patching the pending START with its DONE, COALESCE the render slots: a DENIED call's
        // DONE carries no renderIn/renderOut (the tool never ran → no envelope), which would blank
        // out the In preview the awaiting-approval START already showed. A render only ever appears,
        // never legitimately vanishes, so keep the existing one when the DONE doesn't supply a newer.
        const merged = i >= 0
            ? { ...step, renderIn: step.renderIn ?? steps[i].renderIn, renderOut: step.renderOut ?? steps[i].renderOut }
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
        s.status = status; s.lastTs = ev.ts;
        // A finished run has no in-flight step: clear any lingering pending/awaiting flags so a straggler START
        // that arrived BEFORE this result (a background run's late tool fan) doesn't render a phantom "running…"
        // row under a completed run. (The after-result ordering is handled by the seal in agent-step.)
        if ((s.steps || []).some(st => st.pending)) s.steps = (s.steps || []).map(st => st.pending ? { ...st, pending: false, awaitingApproval: false } : st);
        // Seal the turn (see agent-step): a later straggler/replayed step ≤ endStep can't re-open "running".
        s.ended = true; s.endedStep = endStep;
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
const titleTried = new Set<string>();

function cleanTitle(raw: string): string {
    const line = raw.trim().split("\n").map(s => s.trim()).filter(Boolean)[0] || "";
    return truncate(line.replace(/^["'`*]+|["'`*.]+$/g, "").trim(), 60);
}

function genTitle(hash: string, prompt: string): void {
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
const blockSummaries = new Map<string, string>();   // `${hash}:${blockIndex}` → the one-line summary
const blockSummaryTried = new Set<string>();
const blockKey = (hash: string, i: number): string => `${hash}:${i}`;
function ensureBlockSummary(hash: string, i: number, prompt: string, result: string): void {
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
interface RunTaskBlock { prompt: string; promptImages?: string[]; turns: AgentTurnGroup[]; answer: NonNullable<Session["answers"]>[number] | null; }
// Segment a run into per-task blocks (a prompt → its turns → its answer). null when there's ≤1 task — nothing
// to segment, so Show-work renders its flat trace as before.
function buildRunBlocks(run: Session): RunTaskBlock[] | null {
    const answers = run.answers || [];
    if (answers.length <= 1) return null;
    const says = run.says || [];
    const turns = groupTurns(run.steps || []).filter(t => t.thought || t.reasoning || t.tools.length);
    const blocks: RunTaskBlock[] = [];
    let prev = -Infinity;
    for (let i = 0; i < answers.length; i++) {
        const boundary = answers[i].atStep;
        blocks.push({
            prompt: i === 0 ? (run.task || "") : (says[i - 1]?.text || ""),
            promptImages: i === 0 ? run.taskImages : says[i - 1]?.images,
            turns: turns.filter(t => t.step > prev && t.step <= boundary),
            answer: answers[i],
        });
        prev = boundary;
    }
    return blocks;
}

// Scan for sessions still needing a title and kick off generation. Called from
// App's effect on every session change / open transition.
function maybeGenerateTitles(): void {
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

// Syntax-highlighted code block (highlight() returns safe token HTML). `format`
// beautifies JS first (exec source). Reads the codeLineNumbers signal so the
// gutter toggle re-renders live; wrap vs. scroll is a global CSS attribute.
const Code = ({ text, lang, format }: { text: string; lang?: string; format?: boolean }) => {
    const src = format && (lang === "javascript" || lang === "js") ? beautifyJs(text) : text;
    const html = highlight(src, lang);
    if (!codeLineNumbers.value)
        return <pre class="code"><code class="hljs" dangerouslySetInnerHTML={{ __html: html }} /></pre>;
    return (
        <pre class="code numbered"><code class="hljs">
            {htmlLines(html).map((ln, i) => (
                <span class="cline" key={i}>
                    <span class="lno">{i + 1}</span>
                    <span class="lcode" dangerouslySetInnerHTML={{ __html: ln || " " }} />
                </span>
            ))}
        </code></pre>
    );
};

// Copy to clipboard. Falls back to execCommand when the async Clipboard API is
// unavailable (http pages) OR blocked — a host page's Permissions-Policy can
// withhold clipboard-write from our iframe even though the API exists, so we
// also catch a rejection, not just an absent API.
function execCopy(text: string): Promise<void> {
    return new Promise((resolve, reject) => {
        try {
            const ta = document.createElement("textarea");
            ta.value = text; ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
            document.body.appendChild(ta); ta.focus(); ta.select();
            const ok = document.execCommand("copy"); ta.remove();
            ok ? resolve() : reject(new Error("execCommand copy failed"));
        } catch (e) { reject(e); }
    });
}
function copyText(text: string): Promise<void> {
    if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text).catch(() => execCopy(text));
    return execCopy(text);
}

// "copied!" feedback that reverts after a moment.
function useCopy(): { copied: boolean; copy: (text: string) => void } {
    const [copied, setCopied] = useState(false);
    const copy = (text: string) =>
        copyText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }).catch(() => {});
    return { copied, copy };
}

// A lightweight custom context menu. A web-page/iframe can't invoke the native OS menu with custom
// items (that's privileged DevTools-only), so we render our own popup at the cursor. Rendered once in
// App; opened via openCtxMenu(e, items); dismissed on outside-click / Esc / blur / item-click.
interface CtxItem { label: string; run: () => void; }
const ctxMenu = signal<{ x: number; y: number; items: CtxItem[] } | null>(null);
const openCtxMenu = (e: MouseEvent, items: CtxItem[]): void => { e.preventDefault(); ctxMenu.value = { x: e.clientX, y: e.clientY, items }; };
function ContextMenu() {
    const m = ctxMenu.value;
    useEffect(() => {
        if (!m) return;
        const close = () => (ctxMenu.value = null);
        const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
        window.addEventListener("keydown", onKey);
        window.addEventListener("blur", close);
        return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("blur", close); };
    }, [m]);
    if (!m) return null;
    const left = Math.min(m.x, window.innerWidth - 240);           // keep it on-screen (it's small)
    const top = Math.min(m.y, window.innerHeight - (m.items.length * 30 + 14));
    return (
        <div class="ctx-backdrop" onPointerDown={() => (ctxMenu.value = null)} onContextMenu={e => { e.preventDefault(); ctxMenu.value = null; }}>
            <div class="ctx-menu" style={`left:${left}px;top:${top}px`} onPointerDown={e => e.stopPropagation()}>
                {m.items.map((it, i) => <button class="ctx-item" key={i} onClick={() => { it.run(); ctxMenu.value = null; }}>{it.label}</button>)}
            </div>
        </div>
    );
}

// A debug image that opens full-window on click. The lightbox lives in the shell
// (parent), not this iframe, so it fills the whole browser rather than the
// ~sidebar-width frame — post the src up and the shell renders the overlay.
const openLightbox = (src: string) => window.parent.postMessage({ __mlLightbox: src }, "*");

// Ask the shell to draw / clear a DevTools-style highlight over a page element (on hover of a rendered
// element reference). The shell owns the page DOM (a content script), so it resolves the selector +
// rect and outlines it WITHOUT touching the element. Overlay-surface only — a no-op in the devtools
// panel, whose parent can't reach the page.
const highlightEl = (selector: string) => window.parent.postMessage({ __mlHighlight: { selector } }, "*");
// A canvas @pt/@box token — the shell resolves it (via injected) to a point marker / box outline.
const highlightToken = (token: string) => window.parent.postMessage({ __mlHighlight: { token } }, "*");
const clearHighlight = () => window.parent.postMessage({ __mlHighlight: null }, "*");
// The APPROVAL-card highlight: a pulsing GREEN spotlight (kind "approve"), distinct from the blue hover
// box, so the pending target is unmistakable. The shell replies with the target's on-page position
// (e.g. "bottom-left") → highlightPos, which the card shows so you know where to look.
const highlightApprove = (ref: { selector?: string; token?: string }) => window.parent.postMessage({ __mlHighlight: { ...ref, kind: "approve" } }, "*");
const highlightPos = signal<string>("");
// Hover handlers for a locate `picked` string, which is EITHER an @pt/@box token OR "… → selector" —
// so the same overlay works in both point mode and element mode.
const pickedHover = (picked?: string): { onPointerEnter?: () => void; onPointerLeave?: () => void } => {
    if (!picked) return {};
    const tok = picked.match(/@(?:pt|box):[0-9a-f]+/)?.[0];
    const sel = tok ? "" : (picked.split("→").pop() || "").trim();
    if (!tok && !sel) return {};
    return { onPointerEnter: () => (tok ? highlightToken(tok) : highlightEl(sel)), onPointerLeave: clearHighlight };
};
// Hover handlers for any string that MENTIONS an @pt/@box token (e.g. a look image's label
// `element "@pt:…"`) — hover → outline it on the page. Only fires when a token is present.
const tokenHover = (s?: string): { onPointerEnter?: () => void; onPointerLeave?: () => void } => {
    const tok = s?.match(/@(?:pt|box):[0-9a-f]+/)?.[0];
    return tok ? { onPointerEnter: () => highlightToken(tok), onPointerLeave: clearHighlight } : {};
};

// Design A: the sidebar's approve/deny for a background-hosted run's pending gate. We post it to the
// SHELL (our parent), which — because it can prove the message came from this real extension iframe
// (e.source === frame.contentWindow, unforgeable by the page) — forwards it to the background as
// SET_APPROVAL. That authentication is the whole point: the decision is made HERE and the page can't
// spoof it. Keyed by the run hash + the step's seq.
const sendApproval = (hash: string, seq: number, decision: boolean, persist = false) =>
    window.parent.postMessage({ __mlSidebarApp: "approval", hash, seq, decision, persist }, "*");
// Steps you've already approved/denied this session, keyed `hash:seq`. A step's own
// awaitingApproval flag only clears when the DONE event lands — AFTER the tool runs — so without
// this the run footer keeps showing "waiting for your approval" during that gap. Recording the
// decision on click lets PendingNote drop the step from "blocked" immediately. (ToolStep keeps its
// own local `decided` for its buttons; this is the run-level mirror.) Keys are unique per run
// (random hash) + monotonic seq, so it never collides; growth is one entry per approval.
const decidedSteps = new Set<string>();
const stepKey = (hash: string, seq: number) => `${hash}:${seq}`;
// No tooltip here on purpose: `cursor: zoom-in` is the standard affordance for
// "click to enlarge", and a pop anchored under a full-width screenshot (locate
// renders stack several) would land far from the pointer and just add noise.
const ClickableImg = ({ src, alt }: { src: string; alt?: string }) =>
    <img class="zoomable" src={src} alt={alt} onClick={() => openLightbox(src)} />;

// The HUD completion card's answer-media gallery — the user-facing deliverable. Each item HOVER-HIGHLIGHTS
// the live element on the page (the same debug highlighter the sidebar uses), via its captured `selector`.
// `mode` "inline" shows the picture (an <img>'s full-res src, or an element crop); "highlight" is a compact
// chip that points at the element (for a control/region where the visual isn't the payoff). HUD-only — the
// debug detail (AgentRunView) never renders this.
function AnswerMediaGallery({ media }: { media: AnswerMedia[] }) {
    return (
        <div class="card-answer-media">
            {media.map((m, i) => {
                const hover = m.selector ? { onPointerEnter: () => highlightEl(m.selector!), onPointerLeave: clearHighlight } : {};
                if (m.mode === "highlight" || !m.image) {
                    return (
                        <button key={i} class="am-chip" title={m.selector} {...hover}>
                            {m.image ? <img class="am-thumb" src={m.image} alt={m.label || "element"} /> : <span class="am-chip-ic" aria-hidden="true">⌖</span>}
                            <span class="am-chip-text">{m.label || "element"}<span class="am-chip-hint">hover to locate on page</span></span>
                        </button>
                    );
                }
                return (
                    <div key={i} class={`am-inline${m.selector ? " am-hoverable" : ""}`} {...hover}>
                        <ClickableImg src={m.image} alt={m.label || "answer element"} />
                    </div>
                );
            })}
        </div>
    );
}

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

// Timestamp: compact label, exact full stamp on hover. `snap` picks which way the
// tooltip opens — "left" (default, for right-edge placements like the chat view)
// or "right" (for left-edge placements like the list row, so it doesn't clip).
const Stamp = ({ ts, snap = "left" }: { ts?: number; snap?: "left" | "right" }) => (
    <span class="tt">
        <span class="time">{shortStamp(ts)}</span>
        <span class={`tt-pop${snap === "right" ? " left" : ""}`} role="tooltip">{fullStamp(ts)}</span>
    </span>
);



// The session's createChat config (not the per-turn request/messages — full
// message history is a separate export feature).
function OptionsBlock({ s }: { s: Session }) {
    const c = s.config;
    const lines: string[] = [`model: ${c.model || "default"}`];
    if (c.system) lines.push(`system: ${truncate(c.system, 200)}`);
    if (c.think) lines.push("think: true");
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


// The model that produced a reply, as a click-to-copy chip (handy for debugging).
function CopyModel({ model }: { model: string }) {
    const { copied, copy } = useCopy();
    return (
        <span class="tt">
            <button class="model-name" onClick={(e) => { e.stopPropagation(); copy(model); }}>{model}</button>
            <span class="tt-pop" role="tooltip">{copied ? "copied!" : "copy model name"}</span>
        </span>
    );
}

// A reply bubble — shared by a chat turn's assistant reply and an agent run's
// final answer, so the two render identically: no boxed background (#5), a header
// (status dot · collapse chevron · model chip · (profile) · copy · raw ⇄ nice ·
// timestamp) over the body (markdown ⇄ raw, collapsible), with optional thinking
// and sources. No "assistant"/"answer" word — the header controls carry the
// meaning; `label` appears only for an exceptional state (e.g. an agent step-cap).
function ReplyBubble({ content, status, model, profile, ts, reasoning = null, sources = null, error, label, capped, initialRaw }: {
    content: string; status: Status; model: string | null; profile: "utility" | "default" | null; ts: number;
    reasoning?: string | null; sources?: unknown[] | null; error?: string; label?: string; capped?: boolean; initialRaw?: boolean;
}) {
    const [showRaw, setShowRaw] = useState(!!initialRaw);
    const [collapsed, setCollapsed] = useState(false);
    // "There's a reply to show" — true for an OK turn AND a step-capped agent answer
    // (status "err" but it still produced a summary). A real error has `error` set.
    const hasReply = status !== "pending" && !error;
    const preview = hasReply ? collapsedPreview(content) : null;
    return (
        <div class={`msg asst ${status}${capped ? " capped" : ""}`}>
            <div class="mrow">
                {/* Chevron (collapse affordance) · status dot · an optional label for
                    an exceptional state (e.g. an agent step-cap stop). */}
                {hasReply
                    ? <button class="who-toggle" title={collapsed ? "expand" : "collapse"} onClick={() => setCollapsed(v => !v)}>
                        <span class={`tri${collapsed ? "" : " open"}`} aria-hidden="true"><IconChevron /></span>
                    </button>
                    : null}
                <Dot status={status} />
                {label ? <span class="who">{label}</span> : null}
                {/* The model that produced this reply + its (default)/(utility) profile. */}
                {hasReply && model ? <CopyModel model={model} /> : null}
                {hasReply && model && profile ? <span class="profile-inline">({profile})</span> : null}
                <span class="sp" />
                {/* Copy + raw⇄nice are for a real reply. A terminal notice (a step-cap
                    stop) is a short line — collapsible is enough; copy/raw are noise. */}
                {hasReply && !capped
                    ? <>
                        <CopyBtn text={content} tip="copy markdown" />
                        {collapsed ? null : <button class="raw-btn" onClick={() => setShowRaw(v => !v)}>{showRaw ? "nice" : "raw"}</button>}
                    </>
                    : null}
                <Stamp ts={ts} />
            </div>
            {/* Reasoning/thinking text (separate from the reply), collapsed by default. */}
            {hasReply && !collapsed && reasoning
                ? <details class="thinking"><summary>thinking</summary><div class="md" dangerouslySetInnerHTML={{ __html: markdown(reasoning, { math: true }) }} /></details>
                : null}
            {status === "pending"
                ? <div class="pending-note">…thinking</div>
                : error
                    ? <div class="errtext">{error}</div>
                    : collapsed
                        ? <div class="asst-collapsed" onClick={() => setCollapsed(false)}>{preview!.text}{preview!.more ? <span class="more"> …</span> : null}</div>
                        : showRaw
                            ? <Code text={content} lang="markdown" />
                            : <div class="md" dangerouslySetInnerHTML={{ __html: markdown(content, { math: true }) }} />}
            {sources?.length
                ? <details class="sources"><summary>{`sources (${sources.length})`}</summary><Code text={pretty(sources)} lang="json" /></details>
                : null}
        </div>
    );
}

function MessageTurn({ t }: { t: Turn }) {
    return (
        <>
            <div class="msg user">
                <div class="mrow"><span class="who">user</span><span class="sp" /><Stamp ts={t.ts} /></div>
                <div class="utext">{t.user}</div>
                {t.images?.length ? <div class="thumbs">{t.images.map((src, i) => <ClickableImg key={i} src={src} />)}</div> : null}
            </div>
            <ReplyBubble content={t.assistant || ""} status={t.status} model={t.model ?? null}
                profile={turnProfile(t)} ts={t.ts} reasoning={t.reasoning} sources={t.sources}
                error={t.status === "err" ? (t.error || "(error)") : undefined} initialRaw={!!t.structured} />
        </>
    );
}

const ProfileBadge = ({ profile }: { profile?: ExtendProfile | null }) =>
    profile !== null ? <span class="profile">{profile}</span> : null;

// Presentational — model/profile arrive as plain props (resolved in ListView).
// It must NOT read a signal itself: @preact/signals auto-memoizes a
// signal-reading child, which (with our in-place session mutation → unchanged
// `s` reference) would make it skip the parent re-render and freeze on pending.
const AgentBadge = () => <span class="agent-badge">agent</span>;

// The model name is intentionally NOT shown here — the list gets busy with tags,
// and the resolved model is one tap away in the detail header.
function SessionRow({ s, profile }: { s: Session; profile: "utility" | "default" | null }) {
    const title = s.title || s.task || s.turns[0]?.user || "(no prompt)";
    return (
        <button class="row" onClick={() => (view.value = { name: "detail", hash: s.hash })}>
            <Dot status={s.status} />
            <Stamp ts={s.lastTs} snap="right" />
            {/* key flips fb→ai when the AI-summarised title lands, remounting the element so ml-reveal
                plays once (a plain text swap wouldn't animate). Only the AI title animates, not the fallback. */}
            <b class={`row-title${s.title ? " ml-reveal" : ""}`} key={s.title ? "t-ai" : "t-fb"}>{truncate(title, 80)}</b>
            <div class="row-meta">
                {s.kind === "agent" ? <AgentBadge /> : <TagBadge tag={s.tag} />}
                <ProfileBadge profile={profile} />
                <Hash hash={s.hash} stop />
            </div>
        </button>
    );
}

// --- descriptor renderers: a serializable RenderDescriptor → a panel. The
// registry is keyed by `type`; a tool supplies one (page-side) or we auto-derive
// image/elements, else the default In:/Out: renders the raw result. ---
function RenderElements({ items }: { items: { path: string; text?: string; index?: number }[] }) {
    const single = items.length === 1;   // one element → the #0 badge is noise; just show the element
    return (
        <div class="r-elements">
            {items.map((it, i) => {
                // Hover → outline it on the page (DevTools-style). A path that's an @pt/@box highlights
                // the point/region (via injected); a CSS selector highlights the element. Right-click a
                // selector row → a menu to copy a JS reference (nothing sensible for an @pt/@box).
                const isTok = /^@(?:pt|box):[0-9a-f]+$/.test(it.path);
                const menu = (e: MouseEvent) => openCtxMenu(e, [
                    { label: "Copy document.querySelector(…)", run: () => copyText(elementReference(it.path, it.index)) },
                    { label: "Copy selector", run: () => copyText(it.path) },
                ]);
                return (
                    <div class="r-el" key={it.index ?? i}
                        title={isTok ? undefined : "right-click to copy a reference"}
                        onPointerEnter={() => (isTok ? highlightToken(it.path) : highlightEl(it.path))} onPointerLeave={clearHighlight}
                        onContextMenu={isTok ? undefined : menu}>
                        {single ? null : <span class="r-el-idx">#{it.index ?? i}</span>}
                        {it.text ? <span class="r-el-text">«{it.text}»</span> : null}
                        <code class="r-el-path">{it.path}</code>
                    </div>
                );
            })}
        </div>
    );
}
function RenderTable({ columns, rows }: { columns: string[]; rows: (string | number | null)[][] }) {
    return (
        <div class="r-table-wrap">
            <table class="r-table">
                <thead><tr>{columns.map((c, i) => <th key={i}>{c}</th>)}</tr></thead>
                <tbody>{rows.map((row, i) => <tr key={i}>{row.map((c, j) => <td key={j} class={typeof c === "number" ? "r-td-num" : undefined}>{c == null ? "" : String(c)}</td>)}</tr>)}</tbody>
            </table>
        </div>
    );
}
// The `locate` debug view: model + mode header, then (grounding) the VLM prompt, the
// square the model saw with its box, and the element-location pass; (marks) just the
// badged shot. Picked element at the bottom.
// One substep of a locate run: a vision sub-call (its own In-prompt / image / Out-reply,
// with a raw⇄visualise image toggle) or a DOM snap (just a labelled image). The [N] badge
// numbers it; hovering explains what kind of step it is.
function LocateSubstepView({ s, n }: { s: LocateSubstep; n: number }) {
    const [raw, setRaw] = useState(false);   // "visualise" (the human overlay) by default
    const kind = s.prompt ? "a vision sub-call — its own prompt + reply, run standalone" : "a DOM hit-test — no model call";
    return (
        <div class="r-loc-sub">
            {s.note ? <div class="r-loc-note">{s.note}</div> : null}
            <div class="r-loc-subhead">
                <span class="tt r-loc-numtt"><span class="r-loc-num">{n}</span><span class="tt-pop left" role="tooltip">Sub-step {n}: {kind}.</span></span> {s.label}
            </div>
            {s.prompt ? <details class="io r-loc-io"><summary class="io-label">In (prompt): <span class="io-preview">{inlineText(s.prompt)}</span></summary><div class="io-body"><Code text={s.prompt} lang="text" /></div></details> : null}
            {s.image ? <div class="r-loc-stage">
                <ClickableImg src={raw && s.rawImage ? s.rawImage : s.image} alt={s.label} />
                {s.rawImage ? <div class="rr-toggle r-loc-viz">
                    <button class={raw ? "" : "on"} onClick={() => setRaw(false)}>visualise</button>
                    <button class={raw ? "on" : ""} onClick={() => setRaw(true)}>raw</button>
                </div> : null}
            </div> : null}
            {s.output != null && s.output !== "" ? <details class="io r-loc-io"><summary class="io-label">Out: <span class="io-preview">{inlineText(s.output)}</span></summary><div class="io-body"><Code text={s.output} lang="text" /></div></details> : null}
        </div>
    );
}

function LocateRender({ d }: { d: Extract<RenderDescriptor, { type: "locate" }> }) {
    // Is this vision sub-call's model the SAME as the agent driver's? If so, flag that
    // it still ran standalone (its image + reply never entered the driver's context) —
    // otherwise the matching name reads as if the driver itself saw and answered.
    rev.value;   // reactive: re-read when sessions change
    const driverModel = view.value.name === "detail" ? sessionMap.get(view.value.hash)?.model : undefined;
    const sameAsDriver = !!driverModel && d.model === driverModel;
    return (
        <div class="r-locate">
            <div class="r-loc-head">
                {d.mode === "grounding" ? "Grounding" : d.mode === "grid-grounding" ? "Grid → Grounding" : d.mode === "grid" ? "Grid" : "Set-of-Marks"} · <b>{d.model}</b>
                {sameAsDriver ? <span class="tt r-loc-delegated"> (standalone sub-call · not in the agent's context)<span class="tt-pop left" role="tooltip">This vision sub-call ran on its own — its image and reply were NOT added to the agent driver's conversation, even though it's the same model.</span></span> : null}
            </div>
            {d.substeps.map((s, i) => <LocateSubstepView key={i} s={s} n={i + 1} />)}
            <div class="r-loc-picked">
                <span class="tt">{d.pickedBy === "model" ? "Model picked" : "Snapped to"}<span class="tt-pop left" role="tooltip">{d.pickedBy === "model" ? "The model chose this by badge number (Set-of-Marks)." : d.pickedBy === "snap" ? "The model localized a region; the DOM hit-test chose this actual element." : "No element was selected."}</span></span>: {d.picked ? <code class="r-hoverable" {...pickedHover(d.picked)}>{d.picked}</code> : <span class="dim">(none)</span>}
            </div>
        </div>
    );
}

// `python_exec`'s In slot: a notebook-cell header — the run mode (hover explains what
// `script`/`cast:pt`/`cast:box` mean), the input screenshot the script saw, and the source.
const PY_MODE = {
    script: { label: "script", tip: "General scripting — the return comes back as text." },
    pt: { label: "cast: pt", tip: "The return is validated as a point ([x,y]/{x,y}) and minted as a clickable @pt." },
    box: { label: "cast: box", tip: "The return is validated as a box and minted as an @box region." },
} as const;
// A Jupyter/DataFrame-style preview of the injected `df`: a numbered index gutter, sticky
// header, zebra rows + vertical rules, right-aligned monospace numbers — plus click-to-sort
// (cycles asc→desc→none, preserving the pandas index), drag-to-resize columns, collapse, and
// copy-CSV. Zero-dep (no grid library — it's a capped debug preview). Human-only, so it shows
// up to PY_DF_ROWS rows, not the model's cap.
const PY_DF_ROWS = 200;
const csvField = (v: string | number | null): string => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
function PyDfTable({ columns, rows }: { columns: string[]; rows: (string | number | null)[][] }) {
    const cols = columns.length ? columns : (rows[0] || []).map((_, i) => String(i));
    const [collapsed, setCollapsed] = useState(false);
    const [sort, setSort] = useState<{ c: number; dir: 1 | -1 } | null>(null);
    const [widths, setWidths] = useState<Record<number, number>>({});
    const [copied, setCopied] = useState(false);

    // Sort a [originalIndex, row] view so the gutter keeps the pandas index (like sort_values);
    // numbers compare numerically, strings by locale, nulls (NaN) always sink to the bottom.
    let view = rows.map((r, i) => [i, r] as [number, (string | number | null)[]]);
    if (sort) view = [...view].sort(([, a], [, b]) => {
        const x = a[sort.c], y = b[sort.c];
        if (x == null) return y == null ? 0 : 1;
        if (y == null) return -1;
        return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y))) * sort.dir;
    });
    const shown = view.slice(0, PY_DF_ROWS);

    const cycleSort = (c: number) => setSort(s => !s || s.c !== c ? { c, dir: 1 } : s.dir === 1 ? { c, dir: -1 } : null);
    const copyCsv = () => {
        const csv = [cols.map(csvField).join(","), ...rows.map(r => cols.map((_, j) => csvField(r[j])).join(","))].join("\n");
        navigator.clipboard?.writeText(csv).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }, () => {});
    };
    const startResize = (c: number, e: any) => {
        e.preventDefault(); e.stopPropagation();
        const th = (e.currentTarget as HTMLElement).parentElement as HTMLElement;
        const startX = e.clientX, startW = widths[c] ?? th.offsetWidth;
        const onMove = (ev: PointerEvent) => setWidths(w => ({ ...w, [c]: Math.max(40, startW + ev.clientX - startX) }));
        const onUp = () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); };
        window.addEventListener("pointermove", onMove); window.addEventListener("pointerup", onUp);
    };

    return (
        <div class="r-df">
            <div class="r-df-bar">
                <button class="r-df-btn" onClick={() => setCollapsed(v => !v)}>{collapsed ? "▸ show table" : "▾ hide table"}</button>
                {!collapsed ? <button class="r-df-btn" onClick={copyCsv}>{copied ? "copied ✓" : "copy CSV"}</button> : null}
            </div>
            {collapsed ? null : <>
                <div class="r-df-scroll">
                    <table class="r-df-table">
                        <thead><tr>
                            <th class="r-df-idx"></th>
                            {cols.map((c, j) => (
                                <th key={j} style={widths[j] ? { width: `${widths[j]}px` } : undefined} onClick={() => cycleSort(j)} title="click to sort">
                                    {c}{sort && sort.c === j ? <span class="r-df-sort">{sort.dir === 1 ? " ▲" : " ▼"}</span> : null}
                                    <span class="r-df-resize" title="drag to resize" onPointerDown={(e: any) => startResize(j, e)} onClick={(e: any) => e.stopPropagation()} />
                                </th>
                            ))}
                        </tr></thead>
                        <tbody>{shown.map(([origIdx, row], i) => (
                            <tr key={i}>
                                <td class="r-df-idx">{origIdx}</td>
                                {cols.map((_, j) => { const c = row[j]; return <td key={j} class={typeof c === "number" ? "r-td-num" : (c == null ? "r-td-nan" : undefined)}>{c == null ? "NaN" : String(c)}</td>; })}
                            </tr>
                        ))}</tbody>
                    </table>
                </div>
                {rows.length > PY_DF_ROWS ? <div class="dim r-py-more">… {rows.length - PY_DF_ROWS} more rows</div> : null}
            </>}
        </div>
    );
}
// A loaded DataFrame's provenance → a short source label + a hover tooltip clarifying where the
// data came from (so a multi-table run reads clearly, and the human knows what was fetched).
function tableSourceDesc(s: TableSource): { short: string; tip: string } {
    switch (s.kind) {
        case "sheet-external": return { short: `sheet ${s.label}`, tip: "This data was fetched from an EXTERNAL Google Sheet with your approval." };
        case "sheet-current": return { short: s.label, tip: "This data was fetched from the Google Sheet you're currently on." };
        default: return { short: s.label, tip: `This data was extracted from a table on the current page (${s.label}).` };
    }
}
function PythonInRender({ d }: { d: Extract<RenderDescriptor, { type: "python-in" }> }) {
    return (
        <div class="r-python r-py-in">
            <div class="r-py-mode">Mode: <span class="tt"><span class="r-py-modeval">{PY_MODE[d.mode].label}</span><span class="tt-pop left" role="tooltip">{PY_MODE[d.mode].tip}</span></span></div>
            {d.image ? <div class="r-image r-py-img"
                {...(d.imageToken ? { onPointerEnter: () => highlightToken(d.imageToken!), onPointerLeave: clearHighlight } : {})}>
                <ClickableImg src={d.image} alt="input image" /><div class="r-image-label">input image (img / img_np){d.imageToken ? " — hover to locate on page" : ""}</div></div> : null}
            {(d.tables || []).map((t, i) => {
                const src = tableSourceDesc(t.source);
                const cols = t.columns?.length || t.rows?.[0]?.length || 0;
                return <div key={i} class="r-py-table">
                    <div class="r-py-lbl">
                        input table → <b class="r-py-var">{t.name}</b>{t.rows ? ` (${t.rows.length} × ${cols})` : ""}
                        {" · "}
                        {t.source.kind === "sheet-external"
                            ? <SheetChip id={t.source.label} label={t.source.name || undefined} />   /* id → a friendly chip; name = the real sheet title */
                            : <span class="tt r-py-src"><span class="r-py-srcval">{src.short}</span><span class="tt-pop left" role="tooltip">{src.tip}</span></span>}
                    </div>
                    {t.rows ? <PyDfTable columns={t.columns || []} rows={t.rows} />
                        : <div class="dim r-py-more">loaded via pd.read_html (no clean row preview)</div>}
                </div>;
            })}
            <Code text={d.code} lang="python" />
        </div>
    );
}
// A collapsible section of the python-out block (stdout / value / error / token). Same disclosure
// pattern as the In:/Out: blocks — open by default, its label is the summary. A big stdout can be
// folded away to get to the value.
function PyOutSection({ label, cls, children }: { label: string; cls: string; children: ComponentChildren }) {
    return <details class={`r-py-sec ${cls}`} open><summary class="r-py-lbl">{label}</summary>{children}</details>;
}
// `python_exec`'s Out slot: captured stdout, then one of a returned image / a minted
// @pt·@box token / the raw value / a Python traceback.
function PythonOutRender({ d }: { d: Extract<RenderDescriptor, { type: "python-out" }> }) {
    return (
        <div class="r-python r-py-out">
            {d.stdout ? <PyOutSection label="stdout" cls="r-py-stdout"><Code text={d.stdout} lang="text" /></PyOutSection> : null}
            {d.image ? <div class="r-image"><ClickableImg src={d.image} alt="output image" /><div class="r-image-label">returned image</div></div> : null}
            {d.token ? <PyOutSection label="token" cls="r-py-token"><code class="r-hoverable" onPointerEnter={() => highlightToken(d.token!)} onPointerLeave={clearHighlight}>{d.token}</code></PyOutSection> : null}
            {d.error ? <PyOutSection label="error" cls="r-py-err"><Code text={d.error} lang="text" /></PyOutSection> : null}
            {d.df && !d.error ? <PyOutSection label="value (DataFrame)" cls="r-py-val"><PyDfTable columns={d.df.columns} rows={d.df.rows} /></PyOutSection> : null}
            {d.value != null && !d.image && !d.token && !d.error && !d.df ? <PyOutSection label="value" cls="r-py-val"><Code text={d.value} lang="json" /></PyOutSection> : null}
        </div>
    );
}

// A DELEGATED look's Out: the exact image the reader saw + which model read it + its text output —
// so it reads like a locate sub-call, not the weird auto-derived element text it used to show.
function LookRender({ d }: { d: Extract<RenderDescriptor, { type: "look" }> }) {
    return (
        <div class="r-look">
            <div class="r-image">
                <ClickableImg src={d.image} alt={d.label || "look"} />
                <div class="r-image-label">{d.label ? `${d.label} · ` : ""}viewed by <b>{d.model || "default"}</b></div>
            </div>
            {/* The exact prompt the reader was asked over the image — collapsed by default (secondary), but
                there so you can see WHY the VLM answered as it did (e.g. the click-mark annotation note). */}
            {d.prompt ? <details class="r-py-sec r-look-prompt-sec"><summary class="r-py-lbl">prompt sent</summary>
                <div class="r-look-prompt">{d.prompt}</div></details> : null}
            {/* The reader's output can be long → collapsible (open by default), same disclosure as python-out. */}
            <details class="r-py-sec r-look-out-sec" open>
                <summary class="r-py-lbl">model output</summary>
                <div class="r-look-out md" dangerouslySetInnerHTML={{ __html: markdown(d.output, { math: true }) }} />
            </details>
        </div>
    );
}

function RenderPanel({ d }: { d: RenderDescriptor }) {
    switch (d.type) {
        case "image": {
            // If the label references an @pt/@box (e.g. look's `element "@pt:…"`), hovering the shot
            // outlines that point/region on the page — same overlay setup.
            const th = tokenHover(d.label);
            return <div class={`r-image${th.onPointerEnter ? " r-hoverable" : ""}`} {...th}>
                <ClickableImg src={d.src} alt={d.label || "image"} />{d.label ? <div class="r-image-label">{d.label}</div> : null}</div>;
        }
        case "code": return <Code text={d.text} lang={d.lang} format={d.format} />;
        case "table": return <RenderTable columns={d.columns} rows={d.rows} />;
        case "keyval": return <div class="r-keyval">{d.pairs.map(([k, v], i) => <div class="r-kv" key={i}><span class="r-k">{k}</span><span class="r-v">{v}</span></div>)}</div>;
        case "elements": return <RenderElements items={d.items} />;
        case "action":
            // DEBUG In view (overlay/devtools + HUD "show work"): a hoverable ELEMENT reference when the action
            // targets a page element (selector — hover → outline, right-click → copy a reference); otherwise a
            // clean verb + URL line for a navigate/fetch (NOT raw JSON, and NOT the card's "Agent wants to …"
            // sentence — that's ApprovalBody's job; the log stays a plain debugging view).
            if (d.selector) return <RenderElements items={[{ path: d.selector, ...(d.target ? { text: d.target } : {}) }]} />;
            if (d.target) {
                const target = d.target;
                return (
                    <div class="r-action">
                        <span class="r-action-verb">{d.verb}</span>{" "}
                        {d.input ? <><b class="r-action-input">“{truncate(d.input, 120)}”</b>{" "}</> : null}
                        <span class="r-action-target" title="right-click to open or copy"
                            onContextMenu={e => openCtxMenu(e, [
                                { label: "Open in new tab", run: () => { try { window.open(target, "_blank", "noopener"); } catch { /* popup blocked */ } } },
                                { label: "Copy URL", run: () => { try { void navigator.clipboard?.writeText(target); } catch { /* no clipboard */ } } },
                            ])}>{target}</span>
                        {d.note ? <span class="r-action-note"> · {d.note}</span> : null}
                    </div>
                );
            }
            return <Code text={pretty(d)} lang="json" />;
        case "locate": return <LocateRender d={d} />;
        case "python-in": return <PythonInRender d={d} />;
        case "python-out": return <PythonOutRender d={d} />;
        case "look": return <LookRender d={d} />;
        default: return <Code text={pretty(d)} lang="json" />;   // unknown type → dump it
    }
}

// "Sent to the model" — what a tool fed straight INTO the model's context (locate's snap-inject: a
// marked crop for a vision driver, a delegated description for a text-only one), plus WHY it was sent
// (a point is automatic; a selector/@box only with verify:true). This is distinct from Out (which the
// model also gets): it spotlights the extra VISUAL/DESCRIPTION payload the model received in-turn.
function FeedbackBlock({ fb }: { fb: ToolFeedback }) {
    // Collapsed by default — the injected crop is usually the same image already shown in the Out
    // locate render above, so it's visually redundant; the summary (what + why) is the useful part.
    return (
        <details class="astep-feedback">
            <summary class="feedback-head"><span class="tri" aria-hidden="true"><IconChevron /></span><IconEye /><span class="feedback-title">Sent to the model</span><span class="feedback-why">{fb.reason}</span></summary>
            <div class="feedback-body">
                {fb.image ? <ClickableImg src={fb.image} alt={fb.label || "located crop"} /> : null}
                {fb.via === "text" && fb.prompt
                    ? <details class="r-py-sec r-look-prompt-sec"><summary class="r-py-lbl">prompt sent</summary><div class="r-look-prompt">{fb.prompt}</div></details>
                    : null}
                {fb.via === "text" && fb.text
                    ? <div class="feedback-desc">{fb.image ? "The reader's description of the crop (this is the text the model actually received — it can't see the image):" : ""}<div class="feedback-desc-text">{fb.text}</div></div>
                    : null}
            </div>
        </details>
    );
}

// "Reused a grant you approved" — why an approval-gated step auto-ran with no prompt: it re-used a resource
// you already OK'd (a cached ml.fetch URL a read-only exec re-read; an already-approved Google Sheet a
// python_exec reused). Collapsed by default; the summary is deterministic (kind + count), expand for the
// exact items. Generic over `kind` so future grant kinds render here with no layout change.
const REUSED_KIND: Record<string, { noun: string; nounN: string }> = {
    "fetch-url": { noun: "URL", nounN: "URLs" },
    sheet: { noun: "sheet", nounN: "sheets" },
};
function ReusedBlock({ reused }: { reused: ReusedGrant[] }) {
    // Summarise per-kind (e.g. "2 URLs · 1 sheet") — deterministic, no payload.
    const byKind = new Map<string, ReusedGrant[]>();
    for (const g of reused) { if (!byKind.has(g.kind)) byKind.set(g.kind, []); byKind.get(g.kind)!.push(g); }
    const summary = [...byKind.entries()].map(([k, gs]) => { const n = REUSED_KIND[k]; return `${gs.length} ${gs.length === 1 ? n?.noun || k : n?.nounN || k}`; }).join(" · ");
    return (
        <details class="astep-reused">
            <summary class="reused-head"><span class="tri" aria-hidden="true"><IconChevron /></span><IconCheck /><span class="reused-title">Reused a grant you approved</span><span class="reused-why">{summary} · no prompt needed</span></summary>
            <ul class="reused-list">{reused.map((g, i) => <li key={i}>{g.kind === "sheet" ? <SheetChip id={g.detail} /> : <code>{g.detail}</code>}</li>)}</ul>
        </details>
    );
}

// A Jupyter-style In:/Out: block: a gutter label + content, collapsible on its
// own (a grey inline preview shows when collapsed). If a descriptor targets THIS
// block it renders by default with a per-block rendered⇄raw toggle (e.g. exec's
// In renders pretty JS while its Out stays raw). `raw` is the plain fallback.
function IoBlock({ label, tip, preview, render, raw }: { label: string; tip?: string; preview: string; render?: RenderDescriptor; raw: ComponentChildren }) {
    const [showRaw, setShowRaw] = useState(false);   // rendered by default when a descriptor targets this block
    return (
        <details class="io" open>
            <summary class="io-label" title={tip}>{label}: <span class="io-preview">{preview}</span></summary>
            <div class="io-body">
                {render
                    ? <>
                        <div class="rr-toggle">
                            <span class="tt"><button class={showRaw ? "" : "on"} onClick={() => setShowRaw(false)}>rendered</button><span class="tt-pop left" role="tooltip">A debug visualisation for you — not shown to the model.</span></span>
                            <span class="tt"><button class={showRaw ? "on" : ""} onClick={() => setShowRaw(true)}>raw</button><span class="tt-pop left" role="tooltip">Exactly what the model sent/received. All it knows.</span></span>
                        </div>
                        {showRaw ? raw : <RenderPanel d={render} />}
                    </>
                    : raw}
            </div>
        </details>
    );
}
// Grey one-line preview for a collapsed In/Out: minified args, or newline-collapsed output.
const inlineJson = (v: unknown): string => truncate(pretty(v).replace(/\s+/g, " "), 64);
const inlineText = (s: string): string => truncate(s.replace(/\s+/g, " ").trim(), 72);

// A step of one ml.agent TURN (one LLM call): the assistant's prose (thought) + its separate
// reasoning/thinking + its batched tool calls.
// `step` is the SESSION-cumulative step (the grouping key, so turn N's steps don't merge with turn 1's);
// `localStep` is the PER-TURN step shown in the pill — maxSteps is a per-turn budget, so a follow-up run
// counts 1/N again, not 18/20. (Falls back to `step` for a pre-localStep event.)
interface AgentTurnGroup { step: number; localStep: number; thought?: string; reasoning?: string | null; tools: AgentStep[]; }
function groupTurns(steps: AgentStep[]): AgentTurnGroup[] {
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

const StepPill = ({ step, max }: { step: number; max?: number }) =>
    <span class="step-pill">step {step}{max ? `/${max}` : ""}</span>;

// The turn's separate reasoning channel (reasoning_content) — how the model THINKS, distinct from
// what it says (the prose). Dim, COLLAPSED by default (its text is mostly noise); the preview is just
// a ~token estimate (the server reports reasoning_tokens:0). No status dot — it's not a step that fails.
function ThoughtBlock({ thought }: { thought: string }) {
    const [open, setOpen] = useState(false);
    const tokEst = Math.max(1, Math.round(thought.length / 4));   // ~chars/4 (no real reasoning_tokens)
    return (
        <div class="athought athinking">
            <button class="astep-head" onClick={() => setOpen(v => !v)}>
                <span class={`tri${open ? " open" : ""}`} aria-hidden="true"><IconChevron /></span>
                <span class="who">thinking</span>
                {/* The ~token estimate is a debug detail — hidden in the user-facing HUD card, kept in the
                    DevTools panel / overlay. */}
                {!open && surface.value !== "card" ? <span class="astep-preview">~{tokEst} tokens</span> : null}
            </button>
            {open ? <div class="md astep-body" dangerouslySetInnerHTML={{ __html: markdown(thought, { math: true }) }} /> : null}
        </div>
    );
}

const toolFailed = (result?: string): boolean => !!result && /^(Error:|Denied)/.test(result);

// One tool call: collapsed by default. Expanded, a descriptor renders by default
// with a rendered⇄raw toggle (raw = the In:/Out: args+result); no descriptor →
// In:/Out: directly.
// How an approval-gated call was decided — a green/red provenance pill. This is
// also the slot a future interactive-approval control will resolve into.
const APPROVAL = {
    readonly: { label: "auto-approved", tip: "Auto-approved by the read-only exec setting." },
    sandbox: { label: "auto-approved", tip: "Auto-approved by the python_exec setting — a readonly-mode run is isolated by construction (no network / JS scope / DOM / filesystem)." },
    "same-origin": { label: "auto-approved", tip: "Same-site navigation (or a cross-site origin you already allowed this run) — not a new cross-origin escalation, so no prompt." },
    consented: { label: "auto-approved", tip: "A URL you already approved fetching this session — no re-prompt." },
    user: { label: "approved", tip: "Approved by you." },
    denied: { label: "denied", tip: "Denied by you." },
    skipped: { label: "skipped", tip: "No prompt needed — the target didn't resolve (no element / stale @pt / bad selector), so the action could only fail. It never ran." },
    cancelled: { label: "cancelled", tip: "You cancelled the run while this call was awaiting approval — it never ran." },
} as const;
const ApprovalBadge = ({ approval }: { approval: keyof typeof APPROVAL }) => (
    <span class={`tt appr-badge appr-${approval}`}>
        <span class={`appr ${approval === "denied" ? "no" : (approval === "skipped" || approval === "cancelled") ? "skip" : "yes"}`}>{APPROVAL[approval].label}</span>
        <span class="tt-pop left" role="tooltip">{APPROVAL[approval].tip}</span>
    </span>
);

// A Google Docs-style smart chip for a Google Sheet reference: an icon + a friendly label instead of
// the raw 44-char id, hoverable for the full id, opening the sheet on click. Reused in the approval
// note and the python-in source label. (The real sheet TITLE would need a fetch; "Google Sheet" is the
// friendly stand-in — the loaded df already carries the model's own variable name beside it.)
const sheetTitleCache = new Map<string, string | null>();   // id → title (fetched once per session)
function SheetChip({ id, label }: { id: string; label?: string }) {
    // With a label (post-run: the run already fetched the sheet), use it. Without (the pre-run approval
    // chip), lazily HEAD-fetch just the TITLE so the USER sees which sheet — the model never gets it.
    const [fetched, setFetched] = useState<string | null | undefined>(() => label ? undefined : sheetTitleCache.get(id));
    useEffect(() => {
        if (label || sheetTitleCache.has(id)) return;
        try {
            chrome.runtime.sendMessage({ type: "FETCH_SHEET_TITLE", payload: { id } }, (resp: any) => {
                const name = (resp && resp.data) || null;
                sheetTitleCache.set(id, name);
                setFetched(name);
            });
        } catch { sheetTitleCache.set(id, null); }
    }, [id, label]);
    const name = label || fetched || "Google Sheet";
    return (
        <a class="tt sheet-chip" href={`https://docs.google.com/spreadsheets/d/${id}/edit`} target="_blank" rel="noopener" onClick={e => e.stopPropagation()}>
            <IconSheet /><span class="sheet-chip-name">{name}</span>
            <span class="tt-pop wrap left" role="tooltip">Google Sheet · {id}</span>
        </a>
    );
}

// The distinct EXTERNAL Google Sheet ids a python_exec call will load — read from the ARGS (`tables`),
// NOT the rendered In: at approval time the tables aren't fetched yet (the pre-run preview is code-only),
// so the render has no sheet source. Approving grants the run those spreadsheets for the rest of the
// page-session, so the gate discloses it. Same detection as the background's escalation (externalSheetIds).
function externalSheetGrant(args?: Record<string, unknown>): string[] {
    return args ? [...new Set(externalSheetIds(args))] : [];
}

// button #3: the distinct static URLs a step's persistable egress grants would remember for the session
// (today only `fetch-url` — an exec's inline ml.fetch literals). Extracted BACKGROUND-side and carried on
// the step (st.grants), so the human reviews exactly what will be persisted. Extensible: a new grant kind
// adds a branch here + one in the background's persistGrants (both keyed by `PersistGrant.kind`).
function persistGrantUrls(grants?: import("../contract").PersistGrant[]): string[] {
    if (!grants?.length) return [];
    const urls: string[] = [];
    for (const g of grants) if (g.kind === "fetch-url") urls.push(...g.urls);
    return [...new Set(urls)];
}

// The "Approve + remember" disclosure shown above the approval buttons when a call carries persistable
// grants — an unfurlable list of the exact URLs the session will remember (what's shown IS what persists).
// Shared by the sidebar step and the HUD card so both surfaces read identically.
function GrantRememberNote({ urls }: { urls: string[] }) {
    const [open, setOpen] = useState(false);
    return (
        <div class="appr-note grant-note">
            <IconWarn />
            <div class="grant-note-body">
                <button class="grant-note-head" onClick={() => setOpen(v => !v)} aria-expanded={open}>
                    <span class={`tri${open ? " open" : ""}`} aria-hidden="true"><IconChevron /></span>
                    <span>“Approve + remember” lets this run re-fetch {urls.length === 1 ? "this URL" : `these ${urls.length} URLs`} for the rest of the session without re-asking.</span>
                </button>
                {open
                    ? <ul class="grant-url-list">{urls.map((u, i) => <li key={i}><code>{u}</code></li>)}</ul>
                    : null}
            </div>
        </div>
    );
}

function ToolStep({ st, hash }: { st: AgentStep; hash?: string }) {
    const [expanded, setExpanded] = useState(false);
    const [decided, setDecided] = useState(false);   // hide the controls the instant we click (before the DONE lands)
    const args = st.arguments && Object.keys(st.arguments).length ? st.arguments : null;
    // The run's def for THIS tool — its summary (hover on the name) + its parameter schema (the raw In view
    // annotates each arg key with its schema description). Absent on older debug events (names only).
    const toolDef = hash ? sessionMap.get(hash)?.agentConfig?.tools?.find(t => t.name === st.tool) : undefined;
    const toolSummary = toolDef?.summary;
    const paramSchema = toolDef?.parameters as JsonSchemaNode | undefined;
    // Each slot renders from its own descriptor; the block falls back to raw when absent.
    const inRender = st.renderIn;
    const outRender = st.renderOut;
    const issues = st.argIssues?.length ? st.argIssues : null;
    // Design A: a background-hosted call blocked on the human gate. Render approve/deny here — the
    // decision is made in this (extension-origin) iframe, unforgeable by the page. Needs the run hash +
    // the step seq to correlate; without them (a page-loop run) fall back to the plain pending view.
    const awaiting = !!(st.awaitingApproval && st.pending && !decided && hash && st.seq != null);
    // A pending approval AUTO-UNFURLS the In so you review the call before deciding (no extra click).
    const open = expanded || awaiting;
    // Keep the step expanded after you decide (setExpanded), so it doesn't collapse when `awaiting`
    // clears — you see the Out result fill in on the same open cell.
    const decide = (ok: boolean, persist = false) => {
        setExpanded(true); setDecided(true);
        if (hash && st.seq != null) decidedSteps.add(stepKey(hash, st.seq));
        sendApproval(hash!, st.seq!, ok, persist);
        rev.value++;   // re-render the run footer so it drops "waiting for your approval" at once
    };
    // When a step starts awaiting approval, scroll it into view so a gate mid-run isn't missed.
    const approveRef = useRef<HTMLDivElement>(null);
    // Reveal a new approval prompt ONLY when the user has scrolled up to read — if they're parked at
    // the bottom, App's stick-to-bottom pins to the true bottom (this scrollIntoView would fight it:
    // block:"nearest" lands shy of the bottom AND its scroll event flips `atBottom` false, defeating
    // the pin so the post-approval Out no longer sticks).
    useEffect(() => { if (awaiting && !atBottom.v) approveRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }); }, [awaiting]);
    // Consent scope: approving a python_exec that loads an EXTERNAL Google Sheet caches that
    // spreadsheet for the rest of the page-session (later calls to it won't re-prompt). Tell the
    // human the approval is a session-scoped grant, not a one-shot.
    const sheetGrants = awaiting ? externalSheetGrant(st.arguments) : [];
    const grantUrls = awaiting ? persistGrantUrls(st.grants) : [];
    return (
        <div class={`astep tool${open ? " open" : ""}${st.pending ? " pending" : ""}${awaiting ? " awaiting" : ""}${st.approval ? (st.approval === "denied" ? " appr-no" : (st.approval === "skipped" || st.approval === "cancelled") ? " appr-skip" : " appr-yes") : ""}`}>
            <button class="astep-head" onClick={() => setExpanded(v => !v)}>
                <span class={`tri${open ? " open" : ""}`} aria-hidden="true"><IconChevron /></span>
                <Dot status={st.pending ? "pending" : toolFailed(st.result) ? "err" : "ok"} />
                {/* Tool-authored short summary (contract MlTool.summary) → hover tooltip, both surfaces. */}
                {toolSummary
                    ? <span class="tt tool-name-wrap"><span class="tool-name">{st.tool}</span><span class="tt-pop left" role="tooltip">{toolSummary}</span></span>
                    : <span class="tool-name">{st.tool}</span>}
                {st.approval ? <ApprovalBadge approval={st.approval} /> : null}
                {st.elements ? <span class="tt el-count">{st.elements} el<span class="tt-pop wrap" role="tooltip">DOM nodes returned (reach them in the console via onStep).</span></span> : null}
                {issues ? <span class="arg-warn" title={issues.join("; ")}><IconWarn />{issues.length}</span> : null}
                {!open ? <span class="astep-preview">{awaiting ? <span class="dim">needs approval</span> : st.pending ? <span class="dim">running…</span> : collapsedPreview(st.result || "").text}</span> : null}
            </button>
            {open
                ? <div class="astep-body">
                    {issues ? <div class="tt tt-row arg-issues"><IconWarn /><span>arg schema: {issues.join("; ")}</span><span class="tt-pop wrap left" role="tooltip">The args don't match this tool's parameter schema.</span></div> : null}
                    {st.reused?.length ? <ReusedBlock reused={st.reused} /> : null}
                    {args || inRender
                        ? <IoBlock label="In" tip="The arguments the model passed to this tool call."
                            preview={inlineJson(args || {})} render={inRender}
                            raw={<RawArgs args={args || {}} schema={paramSchema} />} />
                        : null}
                    <IoBlock label="Out" tip="What the tool returned to the model."
                        preview={st.pending ? "running…" : inlineText(st.result || "")} render={outRender}
                        raw={st.result ? <Code text={st.result} lang="text" /> : <span class="dim">{st.pending ? "running…" : "(no output)"}</span>} />
                    {st.feedback ? <FeedbackBlock fb={st.feedback} /> : null}
                </div>
                : null}
            {/* On-demand plain-English gloss for a code step — CARD's Show-work trace only (the debug panel
                keeps the raw code); needs a utility model. Lives UNDER the (collapsed) step, not inside the
                expand, so you can annotate a call without opening its whole In/Out. */}
            {surface.value === "card" && (st.tool === "exec" || st.tool === "python_exec") && hash && st.seq != null && !st.pending && config.value.utilityModel.trim()
                ? <CodeExplain hash={hash} seq={st.seq} lang={st.tool === "python_exec" ? "python" : "javascript"} code={codeOf(st)?.text || ""} result={st.result} />
                : null}
            {/* Approval bar at the BOTTOM — after In/Out — so you review the call (its rendered In)
                before the approve/deny controls, and it reads as the last thing to act on. */}
            {awaiting
                ? <div class="astep-approve" ref={approveRef}>
                    {sheetGrants.length
                        ? <div class="appr-note"><IconWarn /><span>Approving grants this run access to {sheetGrants.map((id, i) => <SheetChip key={i} id={id} />)} for the rest of this session — later calls to {sheetGrants.length === 1 ? "it" : "them"} won't re-prompt.</span></div>
                        : null}
                    {grantUrls.length ? <GrantRememberNote urls={grantUrls} /> : null}
                    <div class="appr-row">
                        <span class="appr-ask">Approve running <b>{st.tool}</b>?</span>
                        <span class="sp" />
                        <button class="appr-btn no" onClick={() => decide(false)}>Deny</button>
                        <button class="appr-btn yes" onClick={() => decide(true)}>Approve</button>
                        {grantUrls.length ? <button class="appr-btn yes remember" onClick={() => decide(true, true)}>Approve + remember</button> : null}
                    </div>
                </div>
                : null}
        </div>
    );
}

// A turn's PROSE (content) — what the model SAYS this step. Rendered like the final answer: plain
// markdown, EXPANDED by default, no status dot / "thought" label / box. Collapsible via a subtle
// chevron (→ a one-line preview), same affordance the answer bubble uses.
function TurnProse({ text }: { text: string }) {
    const [collapsed, setCollapsed] = useState(false);
    const p = collapsedPreview(text);
    return (
        <div class={`aturn-prose${collapsed ? " collapsed" : ""}`}>
            <button class="who-toggle prose-tri" title={collapsed ? "expand" : "collapse"} onClick={() => setCollapsed(v => !v)}>
                <span class={`tri${collapsed ? "" : " open"}`} aria-hidden="true"><IconChevron /></span>
            </button>
            {collapsed
                ? <span class="asst-collapsed" onClick={() => setCollapsed(false)}>{p.text}{p.more ? " …" : ""}</span>
                : <div class="md" dangerouslySetInnerHTML={{ __html: markdown(text, { math: true }) }} />}
        </div>
    );
}
// One turn = the pill + the thinking + the prose + the tool calls it batched.
function AgentTurn({ turn, max, hash }: { turn: AgentTurnGroup; max?: number; hash?: string }) {
    return (
        <div class="aturn">
            <div class="aturn-head"><StepPill step={turn.localStep} max={max} /></div>
            {turn.reasoning ? <ThoughtBlock thought={turn.reasoning} /> : null}
            {turn.thought ? <TurnProse text={turn.thought} /> : null}
            {turn.tools.map((st, i) => <ToolStep key={`${st.tool}-${i}`} st={st} hash={hash} />)}
        </div>
    );
}

// The agent run's setup (model, maxSteps, tools, env/vision/hints, + the resolved
// system prompt) — a collapsed block at the top, the agent analogue of chat's
// OptionsBlock.
// A zero-dep collapsible JSON tree (DevTools-console style): objects/arrays fold with a one-line
// preview, primitives render inline + typed. Used to inspect the agent's full tool definitions.
function jtPreview(v: object): string {
    if (Array.isArray(v)) return v.length ? `[ ${v.length} item${v.length === 1 ? "" : "s"} ]` : "[ ]";
    const keys = Object.keys(v);
    if (!keys.length) return "{ }";
    return `{ ${keys.slice(0, 4).join(", ")}${keys.length > 4 ? ", …" : ""} }`;
}
// A JSON-schema node (as much as we read of it): its own `description`, and children by `properties`
// (object) or `items` (array). Passed alongside a value so JsonNode can annotate keys with their schema
// description — at ANY depth, not just the top level (nested-object args get tooltips too).
interface JsonSchemaNode { description?: string; properties?: Record<string, JsonSchemaNode>; items?: JsonSchemaNode; }
// A JSON key. When the schema gives it a description, it becomes a hoverable tooltip (same .tt/.tt-pop as
// elsewhere) + a dotted underline so you can tell which keys carry docs — a debugging affordance over raw args.
function JtKey({ name, desc, unknown }: { name: string; desc?: string; unknown?: boolean }) {
    if (unknown) return <span class="tt jt-key jt-key-unknown" tabIndex={0}>{name}:<span class="tt-pop left" role="tooltip">Not in this tool's parameter schema — likely a hallucinated argument, so the tool will ignore it or error.</span></span>;
    if (desc) return <span class="tt jt-key jt-key-doc" tabIndex={0}>{name}:<span class="tt-pop left" role="tooltip">{desc}</span></span>;
    return <span class="jt-key">{name}:</span>;
}
function JsonNode({ k, v, depth = 0, defaultOpen, schema, desc, unknown, allOpen }: { k?: string; v: unknown; depth?: number; defaultOpen?: boolean; schema?: JsonSchemaNode; desc?: string; unknown?: boolean; allOpen?: boolean }) {
    const branch = !!v && typeof v === "object";
    const [open, setOpen] = useState(allOpen || (defaultOpen ?? depth < 1));   // allOpen → expanded at EVERY depth (the raw In view)
    const pad = { paddingLeft: `${depth * 13}px` };
    if (!branch) {
        const t = v === null ? "null" : typeof v;
        return <div class="jt-row" style={pad}>
            {k != null ? <JtKey name={k} desc={desc} unknown={unknown} /> : null}
            <span class={`jt-val jt-${t}`}>{typeof v === "string" ? JSON.stringify(v) : String(v)}</span>
        </div>;
    }
    const arr = Array.isArray(v);
    const entries: [string, unknown][] = arr
        ? (v as unknown[]).map((x, i) => [String(i), x])
        : Object.entries(v as Record<string, unknown>);
    // Resolve each child's schema node: an array's elements share `items`; an object's are `properties[key]`.
    const childOf = (ck: string): JsonSchemaNode | undefined => arr ? schema?.items : schema?.properties?.[ck];
    // Only flag "not in schema" when this node's schema actually DEFINES its keys (a real `properties` map) —
    // otherwise we don't know the allowed shape and mustn't false-flag. Arrays have no per-key schema.
    const props = !arr && schema?.properties && typeof schema.properties === "object" ? schema.properties as Record<string, unknown> : null;
    // allOpen (the raw In view) is non-collapsible → drop the chevron, so the opening brace isn't pushed
    // right of the closing one and keys indent cleanly under it.
    const collapsible = !allOpen;
    return <div class="jt-node">
        <div class={`jt-row jt-branch${collapsible ? " jt-clickable" : ""}`} style={pad} role={collapsible ? "button" : undefined} onClick={collapsible ? () => setOpen(o => !o) : undefined}>
            {collapsible ? <span class={`tri${open ? " open" : ""}`} aria-hidden="true"><IconChevron /></span> : null}
            {k != null ? <JtKey name={k} desc={desc} unknown={unknown} /> : null}
            {open ? <span class="jt-brace">{arr ? "[" : "{"}</span> : <span class="jt-preview">{jtPreview(v as object)}</span>}
        </div>
        {open ? <>
            {entries.map(([ek, ev]) => <JsonNode key={ek} k={arr ? undefined : ek} v={ev} depth={depth + 1} schema={childOf(ek)} desc={arr ? undefined : childOf(ek)?.description} unknown={!!props && !(ek in props)} allOpen={allOpen} />)}
            <div class="jt-row" style={pad}><span class="jt-brace">{arr ? "]" : "}"}</span></div>
        </> : null}
    </div>;
}
// The raw In view: an always-expanded, schema-annotated JSON tree (hover a key with a schema description
// for its docs). A tree isn't selectable like the old text block, so it carries a COPY button. And anything
// that isn't a plain object/array — or that won't serialize — falls back to the old code renderer, which is
// always valid + copyable. `args` is already a parsed value off the bus, so this is belt-and-braces.
function RawArgs({ args, schema }: { args: unknown; schema?: JsonSchemaNode }) {
    let json = "", ok = true;
    try { json = pretty(args ?? {}); } catch { ok = false; }   // circular / non-serialisable → use the fallback
    const tree = ok && !!args && typeof args === "object";
    return <div class="jt-args">
        <span class="jt-args-copy"><CopyBtn text={ok ? json : String(args)} tip="copy JSON" /></span>
        {tree ? <JsonNode v={args} schema={schema} allOpen defaultOpen /> : <Code text={ok ? json : String(args)} lang="json" />}
    </div>;
}

// The agent's full tool definitions — name, approval/vision badges, description, and a JSON tree of
// the parameter schema the model actually sees. Older debug events carry names only; those degrade
// to just the head + description (no tree), since parameters weren't plumbed through then.
function ToolDefCard({ t }: { t: DebugAgentConfig["tools"][number] }) {
    const [open, setOpen] = useState(false);   // collapsed → just the tool name + badges
    const hasBody = !!(t.description || t.parameters);
    return <div class="tooldef">
        <div class={`tooldef-head${hasBody ? " clickable" : ""}`} role={hasBody ? "button" : undefined} onClick={hasBody ? () => setOpen(v => !v) : undefined}>
            {hasBody ? <span class={`tri${open ? " open" : ""}`} aria-hidden="true"><IconChevron /></span> : null}
            <b class="tooldef-name">{t.name}</b>
            {t.requiresApproval ? <span class="tt tooldef-warn"><IconWarn /><span class="tt-pop wrap left" role="tooltip">Calling this tool requires your approval.</span></span> : null}
            {t.vision ? <span class="tt tooldef-badge">vision<span class="tt-pop wrap left" role="tooltip">A vision tool — it sends a screenshot to a vision-capable model (the agent's own model if it sees, else the OCR/vision reader). Only wired when such a model resolves.</span></span> : null}
        </div>
        {open ? <>
            {t.description ? <div class="tooldef-desc md" dangerouslySetInnerHTML={{ __html: markdown(t.description) }} /> : null}
            {t.parameters ? <div class="tooldef-params"><JsonNode k="parameters" v={t.parameters} defaultOpen={false} /></div> : null}
        </> : null}
    </div>;
}
function ToolDefsView({ tools }: { tools: DebugAgentConfig["tools"] }) {
    return <div class="tooldefs">{tools.map((t, i) => <ToolDefCard key={i} t={t} />)}</div>;
}

function AgentOptionsBlock({ s }: { s: Session }) {
    const c = s.agentConfig;
    const [open, setOpen] = useState(false);
    const [showSys, setShowSys] = useState(false);
    const [showTools, setShowTools] = useState(false);
    if (!c) return null;
    // The full defs (description + parameter schema) are only in newer events; older ones carry names
    // only, so the "show tool defs" viewer would just repeat the summary line — hide it then.
    const hasToolDefs = c.tools.some(t => t.description || t.parameters);
    const lines = [`model: ${s.model || "default"}`, `maxSteps: ${c.maxSteps}`];
    if (c.think != null) lines.push(`think: ${c.think}`);
    if (!c.env) lines.push("env: false");
    // Vision: what was PASSED + what RESOLVED — the debug line for "native / delegated / no-vision run".
    // `passed`: auto (null) · true (forced native) · false (off) · "model" (forced reader). `driverSees` +
    // `visionModel` are the resolved facts (newer events); fall back to just the passed value for old ones.
    if (c.vision === false) {
        lines.push("vision: false");
    } else if (c.driverSees !== undefined || c.visionModel !== undefined) {
        const passed = c.vision === true ? "true (forced native)" : typeof c.vision === "string" ? `${JSON.stringify(c.vision)} (forced reader)` : "auto";
        const resolved = c.driverSees ? "local-sees: yes (native)" : c.visionModel ? `local-sees: no · reader: ${c.visionModel}` : "local-sees: no · no reader";
        lines.push(`vision: ${passed} · ${resolved}`);
    } else if (c.vision != null && c.vision !== true) {
        lines.push(`vision: ${JSON.stringify(c.vision)}`);
    }
    if (c.hints) lines.push(`hints: ${truncate(c.hints, 140)}`);
    // The full-defs viewer below lists every tool; only fall back to a one-line names summary when
    // those defs aren't available (older events), so the two don't duplicate.
    if (!hasToolDefs) lines.push(`tools (${c.tools.length}): ${c.tools.map(t => t.name + (t.requiresApproval ? " ⚠" : "")).join(", ")}`);
    // Vision wasn't disabled, yet nothing vision-capable got wired → no reader
    // resolved, so look/locate silently aren't available. Flag it.
    const noVision = c.vision !== false && !c.tools.some(t => t.vision);
    return (
        <div class="block agent-opts">
            <div class="block-head" role="button" onClick={() => setOpen(v => !v)}>
                <span class={`tri${open ? " open" : ""}`} aria-hidden="true"><IconChevron /></span>
                <span class="block-label">agent options</span>
                {noVision ? <span class="tt arg-warn"><IconWarn />no vision<span class="tt-pop wrap left" role="tooltip">No vision-capable model resolved (agent model → OCR model). The look and locate tools aren't available this run; set an OCR/vision model in Settings → Models.</span></span> : null}
            </div>
            {open
                ? <div class="tbody">
                    {noVision ? <div class="tt tt-row arg-issues"><IconWarn /><span>visual tools unavailable — no vision model (set an OCR/vision model in Settings → Models)</span><span class="tt-pop wrap left" role="tooltip">ml.agent couldn't resolve a vision reader, so look/locate weren't wired.</span></div> : null}
                    <pre class="opts">{lines.join("\n")}</pre>
                    <div class="sys-block">
                        <button class="raw-btn" onClick={() => setShowSys(v => !v)}>{showSys ? "hide" : "show"} system prompt{c.customSystem ? " (custom)" : ""}</button>
                        {showSys ? <Code text={c.system} lang="markdown" /> : null}
                    </div>
                    {hasToolDefs
                        ? <div class="sys-block">
                            <button class="raw-btn" onClick={() => setShowTools(v => !v)}>{showTools ? "hide" : "show"} tool definitions ({c.tools.length})</button>
                            {showTools ? <ToolDefsView tools={c.tools} /> : null}
                        </div>
                        : null}
                </div>
                : null}
        </div>
    );
}

// A mid-run steer's delivery indicator: a small badge on the bubble telling you whether the LETTERBOXED
// message has actually reached the agent yet. `undefined` = not a steer (initial task / follow-up), render
// nothing. Queued pulses; seen is a solid check. Same markup in both surfaces (DevTools + HUD).
function SteerSeen({ seen }: { seen: boolean }) {
    return (
        <span class={`steer-seen tt ${seen ? "on" : "wait"}`} aria-label={seen ? "Seen by the agent" : "Queued — not picked up yet"}>
            {seen
                ? <svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" d="M20 6 9 17l-5-5" /></svg>
                : <span class="steer-dot" aria-hidden="true" />}
            <span class="tt-pop left" role="tooltip">{seen ? "Seen — the agent picked this up" : "Queued — the agent hasn't picked this up yet (delivered at its next step)"}</span>
        </span>
    );
}

// A user message in the conversation — the initial task, a follow-up run()'s task, or a mid-run say().
// All render as "you"; a mid-run steer additionally carries a `steer` delivery indicator (queued/seen).
const UserBubble = ({ text, ts, images, steer }: { text: string; ts: number; images?: string[]; steer?: { seen?: boolean } }) => (
    <div class="msg user">
        <div class="mrow"><span class="who">you</span>{steer ? <SteerSeen seen={!!steer.seen} /> : null}<span class="sp" /><Stamp ts={ts} /></div>
        {images?.length ? <div class="thumbs">{images.map((src, i) => <ClickableImg key={i} src={src} />)}</div> : null}
        {text ? <div class="utext">{text}</div> : null}
    </div>
);

// The absolute destination of a `navigate` step (the resolved URL the action render carries, else the raw arg).
const navTargetOf = (st: AgentStep): string => {
    const ri = st.renderIn;
    if (ri && ri.type === "action" && typeof ri.target === "string" && ri.target) return ri.target;
    const u = st.arguments?.url;
    return typeof u === "string" ? u : "";
};
// host + path for a compact label; the full URL rides the title tooltip.
const prettyUrl = (url: string): string => {
    try { const u = new URL(url); return u.host + (u.pathname !== "/" ? u.pathname : "") + u.search; } catch { return url; }
};
// A page-transition marker in the run log — the moment the agent left this document and the run RE-ADOPTED the
// new one (a cross-page/-domain nav). Like Claude Code's context-compaction rule: a horizontal divider that
// makes the seam legible when reading a run that spans pages, distinct from the `navigate` tool call above it.
function NavDivider({ url }: { url: string }) {
    return (
        <div class="nav-divider" title={url}>
            <span class="nav-rule" aria-hidden="true" />
            <span class="nav-label">
                <svg class="nav-ico" viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M4 12h13M13 6l6 6-6 6" /></svg>
                navigated to <b class="nav-url">{prettyUrl(url)}</b> · session resumed
            </span>
            <span class="nav-rule" aria-hidden="true" />
        </div>
    );
}

function AgentRunView({ s }: { s: Session }) {
    // Skip an empty step group — one carrying only a usage sample (final-answer token counts), no
    // thought/reasoning/tool. KEEP a reasoning-only turn (the final-answer turn shows its thinking here).
    const groups = groupTurns(s.steps || []).filter(t => t.thought || t.reasoning || t.tools.length);
    // The whole session is a CHAT LOG: user messages (task + follow-ups + says) and answers interleaved
    // with the turn step-groups, ordered by step position. `atStep + fraction` slots an answer just after
    // its turn's steps, and a following user message just after that.
    const answer = (a: NonNullable<Session["answers"]>[number], key: string) =>
        a.error
            ? <ReplyBubble key={key} content="" status="err" model={s.model} profile={sessionProfile(s)} ts={a.ts} error={a.error} label="run failed" />
            : <ReplyBubble key={key} content={a.text} status={a.status} model={s.model} profile={sessionProfile(s)} ts={a.ts}
                label={a.cancelled ? "cancelled" : a.hitCap ? "stopped (step cap)" : undefined} capped={a.hitCap || a.cancelled} />;
    // Answers AND says share the same positional base (atStep + 0.5 = "after this turn's steps"); the TS
    // breaks the tie. A fixed answer-before-say fraction was wrong: when a turn runs no tool steps (a plain
    // chat-style reply, or a cancel), every answer/say lands at the SAME atStep, so the fraction forced ALL
    // answers ahead of ALL says regardless of when they actually happened. ts is the authoritative order.
    const items: { pos: number; ts: number; el: preact.JSX.Element }[] = [
        { pos: -1, ts: s.createdTs, el: <UserBubble key="task" text={s.task || ""} ts={s.createdTs} images={s.taskImages} /> },
        ...groups.map(g => ({ pos: g.step, ts: 0, el: <AgentTurn key={`t${g.step}`} turn={g} max={s.maxSteps} hash={s.hash} /> })),
        // A page-transition divider right after each SUCCESSFUL navigate turn (skip a denied/errored one — the
        // page didn't actually change). Sits at step+0.3: after the navigate group, before its next turn/answer.
        ...(s.steps || []).filter(st => st.tool === "navigate" && st.approval !== "denied" && !!st.result && !st.result.startsWith("Error") && !!navTargetOf(st))
            .map((st, i) => ({ pos: (st.step || 0) + 0.3, ts: 0, el: <NavDivider key={`nav${i}-${st.seq ?? st.step}`} url={navTargetOf(st)} /> })),
        ...(s.answers || []).map((a, i) => ({ pos: a.atStep + 0.5, ts: a.ts, el: answer(a, `a${i}`) })),
        ...(s.says || []).map((sy, i) => ({ pos: sy.atStep + 0.5, ts: sy.ts, el: <UserBubble key={`s${i}`} text={sy.text} ts={sy.ts} images={sy.images} steer={sy.id ? { seen: sy.seen } : undefined} /> })),
    ].sort((a, b) => a.pos - b.pos || a.ts - b.ts);
    return (
        <>
            <AgentOptionsBlock s={s} />
            {items.map(it => it.el)}
            {s.status === "pending" ? <PendingNote s={s} /> : null}
        </>
    );
}

// The live footer of a running agent. Its bar is a browser-native motif — the thin indeterminate
// "page is loading" sweep an SPA shows on navigation — so an active run reads as the browser working.
// When the run is BLOCKED on your approval it swaps to a breathing amber bar (no forward motion) +
// "waiting…", so paused-needs-you vs actively-running is legible at a glance from colour + motion.
function PendingNote({ s }: { s: Session }) {
    // Blocked = a step is still awaiting the gate AND you haven't decided it yet (decidedSteps flips
    // the instant you click, before the tool's DONE event clears awaitingApproval).
    const blocked = (s.steps || []).some(st => st.pending && st.awaitingApproval && !(st.seq != null && decidedSteps.has(stepKey(s.hash, st.seq))));
    const n = turnsRun(s.steps);
    return (
        <div class={`pending-note${blocked ? " blocked" : ""}`}>
            <div class="pbar" aria-hidden="true"><span /></div>
            <span class="ptext">{blocked ? "waiting for your approval…" : `running · ${n} ${n === 1 ? "step" : "steps"}`}</span>
        </div>
    );
}

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
const surface = signal<"panel" | "card">("panel");
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
// "Show work" open-state, keyed by the run's HASH (not a global boolean). A new run's hash won't match, so
// its trace is COLLAPSED by default with NO post-render reset — the reset-as-effect was why a fast/quiet run
// first painted with the PREVIOUS run's trace expanded (tall) then collapsed (the "opens huge then shrinks"
// glitch). "" = nothing open. Also naturally scopes to the active run once the card has tabs.
const cardShowWorkHash = signal<string>("");
const cardMaximizedHash = signal<string>("");   // the run whose card is MAXIMISED (a near-full-page corner window)
const composerOpen = signal(false);          // the Spotlight composer — the HUD morphs into a task input
const composerElement = signal<ElementContext | null>(null);   // right-click "ask about this" → the element pill's context
// Where the composer's send goes: a NEW run (default, Spotlight/"ask about this") or APPENDED to an already-
// open run (right-click "add to current run" → steer if it's running, follow-up if idle).
const composerTarget = signal<{ mode: "new" } | { mode: "append"; hash: string }>({ mode: "new" });
const composerMaxSteps = signal(20);         // step budget for a UI-started run (persists across opens)
const STEP_BUDGETS = [10, 20, 50];           // the segmented presets in the composer
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

// Utility-model auto-summaries (card title, code/action approval summaries) are gated on BOTH a
// configured utility model AND the "summarise with the utility model" toggle (config.autoTitles).
const utilitySummariesOn = () => config.value.autoTitles && !!config.value.utilityModel.trim();

// Plain-English summary of a CODE approval's snippet, via the utility model — so the human reads "sums
// every quarter and finds the top rep" ABOVE the actual code (which still shows, as the consent
// surface). Keyed per step; opt-in on a utility model, best-effort (the code alone suffices without).
const codeSummaries = new Map<string, string>();
const codeSummaryTried = new Set<string>();
// The actual fetch — needs only a utility model (used directly by the on-demand "Explain" button in the
// Show-work trace, which the user explicitly clicked, so it isn't gated on the auto-summarise toggle).
// `output` (present only in the Show-work trace, where the code has ALREADY run) lets the gloss describe
// what it actually DID/found, not just what it would do — the approval-card path passes none (pre-run).
function fetchCodeSummary(hash: string, seq: number, lang: string, code: string, output?: string): void {
    if (!config.value.utilityModel.trim() || !code.trim()) return;
    const key = stepKey(hash, seq);
    if (codeSummaryTried.has(key)) return;
    codeSummaryTried.add(key);
    const messages = output && output.trim()
        ? [
            { role: "system", content: "You explain what a code snippet DID in ONE plain-English sentence (≤ 22 words) for a non-programmer, USING its output to say what it found/produced. State the effect and the result. No preamble, no code, no restating the language." },
            { role: "user", content: `Explain what this ${lang} code did.\n\nCode:\n${truncate(code, 1200)}\n\nOutput:\n${truncate(output, 400)}` },
        ]
        : [
            { role: "system", content: "You explain what a code snippet DOES in ONE plain-English sentence (≤ 22 words) for a non-programmer about to approve running it. State the effect and any data it touches. No preamble, no code, no restating the language." },
            { role: "user", content: `Explain what this ${lang} code does:\n\n${truncate(code, 1400)}` },
        ];
    fetchUtilityLine(messages, key);
}
// AUTO path (the approval card's gloss) — additionally gated on the auto-summarise toggle.
function ensureCodeSummary(hash: string, seq: number, lang: string, code: string): void {
    if (utilitySummariesOn()) fetchCodeSummary(hash, seq, lang, code);
}
// The on-demand "Explain this Python/JS" affordance in the Show-work trace (card surface only). Lazy —
// ONE utility-model call, only when clicked; shows the gloss inline once it lands.
function CodeExplain({ hash, seq, lang, code, result }: { hash: string; seq: number; lang: string; code: string; result?: string }) {
    const rv = rev.value;   // subscribe: the gloss lands on a rev bump (ToolStep is signal-memoized → won't); retained via data-rev
    const summary = codeSummaries.get(stepKey(hash, seq));
    if (summary) return <div class="step-explain ml-reveal" data-rev={rv}><span class="step-explain-ic" aria-hidden="true">💡</span><span>{summary}</span></div>;
    if (!code.trim()) return null;
    return <button class="step-explain-btn" data-rev={rv} onClick={() => fetchCodeSummary(hash, seq, lang, code, result)}>💡 Explain this {lang === "python" ? "Python" : "JavaScript"}</button>;
}
// A tool with NO deterministic intent (a custom approval-gated tool, no `action` render) still gets a
// human description — the utility model paraphrases the call. Same cache/plumbing as the code summary.
function ensureActionSummary(hash: string, seq: number, tool: string, args: Record<string, unknown>): void {
    if (!utilitySummariesOn() || !tool) return;
    const key = stepKey(hash, seq);
    if (codeSummaryTried.has(key)) return;
    codeSummaryTried.add(key);
    const messages = [
        { role: "system", content: "In ONE short plain-English sentence (≤ 18 words), tell a non-programmer what this tool call will DO, so they can approve it. State the effect. No preamble, no JSON, no tool name." },
        { role: "user", content: `Tool: ${tool}\nArguments: ${truncate(JSON.stringify(args ?? {}), 800)}` },
    ];
    fetchUtilityLine(messages, key);
}
// Shared: run a short utility-model call and store the one-line reply as the step's summary.
function fetchUtilityLine(messages: { role: string; content: string }[], key: string): void {
    chrome.runtime.sendMessage(
        { type: "FETCH_LLM", payload: { messages, extend: "utility", maxTokens: 70, think: false } },
        (resp: any) => {
            if (chrome.runtime.lastError || !resp || resp.error) return;
            const line = String(resp.data || "").trim().split("\n").map(s => s.trim()).filter(Boolean)[0] || "";
            const s = truncate(line.replace(/^["'`*]+|["'`*]+$/g, "").trim(), 160);
            if (s) { codeSummaries.set(key, s); rev.value++; }
        },
    );
}

// A pending call's INTENT: prefer the tool-provided `action` descriptor (deterministic; custom tools
// too), else a name-based verb for built-ins, else nothing (→ utility-model description).
const CODE_LANG: Record<string, string> = { exec: "javascript", python_exec: "python" };
interface Intent { verb: string; kind?: string; target?: string; selector?: string; input?: string; note?: string; submit?: boolean; crossOrigin?: string; link?: boolean; }
function intentFor(st: AgentStep): Intent | null {
    // Whether a `type` will ALSO press Enter — a materially bigger action (it submits the form/search), so the
    // approval must call it out. Read from the raw args (the ground truth), regardless of the render path.
    const submit = st.tool === "type" ? !!st.arguments?.submit : undefined;
    const ri = st.renderIn;
    // `link` renders the target as a significant URL (warm-yellow + dotted, like navigate/submit) rather than
    // "the element …" — a fetch's URL is leaving-the-page-worthy, so style it the same as navigate's.
    if (ri && ri.type === "action") return { verb: ri.verb, kind: ri.kind, target: ri.target, selector: ri.selector, input: ri.input, note: ri.note, submit, crossOrigin: ri.crossOrigin, link: st.tool === "navigate" || st.tool === "fetch_url" };
    if (ri && ri.type === "elements" && ri.items[0])   // an older/other target render still gives a target + selector
        return { verb: st.tool === "click" ? "Click" : st.tool === "type" ? "Type" : `Run ${st.tool}`, target: ri.items[0].text || ri.items[0].path, selector: ri.items[0].path, submit };
    const sel = typeof st.arguments?.selector === "string" ? (st.arguments.selector as string) : undefined;
    if (st.tool === "click") return { verb: "Click", selector: sel };
    if (st.tool === "type") return { verb: "Type", selector: sel, input: String(st.arguments?.text ?? ""), submit };
    return null;
}
// For a CODE tool, the actual source — the consent surface (you can't approve code you can't see).
function codeOf(st: AgentStep): { text: string; lang: string } | null {
    const lang = CODE_LANG[st.tool || ""];
    if (!lang) return null;
    const ri = st.renderIn;
    if (ri && ri.type === "code" && typeof ri.text === "string") return { text: ri.text, lang };
    if (ri && ri.type === "python-in" && typeof ri.code === "string") return { text: ri.code, lang };
    const a = st.arguments || {};
    const src = typeof a.js === "string" ? a.js : typeof a.code === "string" ? a.code : "";
    return { text: src, lang };
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
    const [open, setOpen] = useState(last);   // latest expanded, priors collapsed
    // This component only MOUNTS when Show-work is open, so firing here = fire-on-open (lazy). Cached by key.
    useEffect(() => { ensureBlockSummary(run.hash, index, block.prompt, block.answer?.text || ""); }, [run.hash, index]);
    const summary = blockSummaries.get(blockKey(run.hash, index));
    const header = summary || inlineText(block.prompt) || "(task)";
    return (
        <div class="run-block" data-rev={rv}>
            <button class="run-block-head" onClick={() => setOpen(v => !v)}>
                <span class={`tri${open ? " open" : ""}`} aria-hidden="true"><IconChevron /></span>
                <span class={`run-block-sum${summary ? " ml-reveal" : ""}`}
                    title={summary ? `${summary}\n\nRequest: ${block.prompt}` : block.prompt}>{header}</span>
                <span class="sp" />
                <span class="run-block-n">{block.turns.length} {block.turns.length === 1 ? "step" : "steps"}</span>
            </button>
            {open ? (
                <div class="run-block-body">
                    <CardTraceMsg label="you asked" text={block.prompt} cls="acard-you" images={block.promptImages} />
                    {block.turns.map(t => <AgentTurn key={t.step} turn={t} max={run.maxSteps} hash={run.hash} />)}
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
        window.parent.postMessage({ __mlSidebarApp: "startRun", task: t, maxSteps: composerMaxSteps.value, model: model || undefined, vision, images: att.imgs, elementContext: el || undefined }, "*");
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
    const state = composing ? "composer"                       // the composer takes over — centered Spotlight bar
        : steering ? "expanded"                                // steering a live run: open the card for the inline steer box
        : pending ? "expanded"                                 // an approval: show the action directly (even for a silent run)
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
        window.parent.postMessage({ __mlSidebarCardFocus: true }, "*");
        const decideKey = (ok: boolean) => { decidedSteps.add(stepKey(h, seq)); clearHighlight(); sendApproval(h, seq, ok); rev.value++; };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Enter") { e.preventDefault(); decideKey(true); }
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
        sendApproval(run.hash, pendingStep.seq, ok, persist);
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
                            <div class="card-answer dim card-working"><span class="card-work-ic" aria-hidden="true">{activityFor(run).icon}</span>{liveProseFor(run) || activityFor(run).label}<span class="pill-dots"><i /><i /><i /></span></div>
                            {(run.steps || []).some(s => s.tool) ? <ShowWork run={run} /> : null}
                          </>
                        : <>
                            {/* "Show work" sits ABOVE the answer now — the audit trail is the header, the answer
                                the payoff. Only when there's actual WORK (≥1 tool step); a pure chat answer has none. */}
                            {(run.steps || []).some(s => s.tool) ? <ShowWork run={run} /> : null}
                            {run.error
                                ? <div class={`card-error${offline ? " card-error-offline" : ""}`}>{offline ? <><IconWarn /> </> : null}{run.error}</div>
                                : (run.summary || "").trim()
                                    ? <div class="card-answer md" dangerouslySetInnerHTML={{ __html: markdown(run.summary || "", { math: true }) }} />
                                    : <div class="card-answer dim card-answer-empty">{run.cancelled ? "Run cancelled — the agent returned no text." : "The run finished without a text reply."}</div>}
                            {/* answer-designated element visuals — the user-facing deliverable (HUD-only; the debug
                                sidebar deliberately doesn't render these). Click to lightbox. */}
                            {run.answerMedia && run.answerMedia.length ? <AnswerMediaGallery media={run.answerMedia} /> : null}
                          </>}
            </div>
            {/* Deny/Approve as a FIXED footer — outside the scroll area, so it's always visible (a
                drag-collapse or the scrollbar appearing can never cut or shift the buttons). */}
            {pending && pendingStep
                ? (() => {
                    const grantUrls = persistGrantUrls(pendingStep.grants);
                    return <div class="card-foot card-foot-appr">
                        {grantUrls.length ? <GrantRememberNote urls={grantUrls} /> : null}
                        <div class="card-foot-row">
                            <button class="appr-btn no" onClick={() => decide(false)}>Deny <kbd class="kb">esc</kbd></button>
                            <button class="appr-btn yes" onClick={() => decide(true)}>Approve <kbd class="kb">⏎</kbd></button>
                            {grantUrls.length ? <button class="appr-btn yes remember" onClick={() => decide(true, true)}>Approve + remember</button> : null}
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

// Whether the detail log is scrolled to the bottom (stick-to-bottom intent). Module-level so the
// per-step approval reveal (ToolStep) and App's scroll logic share ONE truth — a single App instance.
const atBottom = { v: true };

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
