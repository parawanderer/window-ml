// Agent-run debug detail views — the trace an ml.agent run renders in the sidebar/DevTools detail (and,
// reused, in the HUD "Show work"): per-turn thought + tool-call steps (ToolStep / AgentTurn), the
// approval / grant / host-access chrome, the JSON-tree tool-def viewer, the agent-options block, nav
// dividers, and the run container (AgentRunView / LiveStream / PendingNote). Extracted from app.tsx; it
// sits above ./reply (uses ReplyBubble) and the ui-kit / answer-render / render-panel / debug-reducer layers.
import type { ComponentChildren } from "preact";
import { useState, useEffect, useRef } from "preact/hooks";
import type { RenderDescriptor, DebugAgentConfig, PersistGrant } from "../contract";
import { resolveOutputCap, runStats, fmtTokPerSec, runStatsProvenance } from "../contract";
import { externalSheetIds } from "../dom";
import { config, surface, view, rev, sessionMap, turnsRun, atBottom, showStatsTokens, showStatsTps, laneLitSeqs, focusMode } from "./store";
import type { Session, AgentStep, Status } from "./store";
import { pretty, truncate, markdown, collapsedPreview } from "./format";
import { sessionProfile } from "./model";
import { IconChevron, IconWarn, IconCopy, IconCheck } from "./icons";
import {
    Code, CopyBtn, SheetChip, Hash, Stamp, ClickableImg, Dot, Disclosure,
    decideGate, decidedSteps, stepKey, grantHostPattern, inlineJson, inlineText,
} from "./ui-kit";
import { FeedbackBlock, ReusedBlock } from "./answer-render";
import { deepestUserLine } from "../py-format";
import { RenderPanel, OutputCell, SeenSplit } from "./render-panel";
import { ReplyBubble } from "./reply";
import { CodeExplain, codeOf } from "./summaries";
import { groupTurns } from "./debug-reducer";
import type { AgentTurnGroup } from "./debug-reducer";

// A Jupyter-style In:/Out: block: a gutter label + content, collapsible on its
// own (a grey inline preview shows when collapsed). If a descriptor targets THIS
// block it renders by default with a per-block rendered⇄raw toggle (e.g. exec's
// In renders pretty JS while its Out stays raw). `raw` is the plain fallback.
/** Which citation slot this block IS, for the anchors below. Only In and Out are cited. */
const slotOf = (label: string): "in" | "out" | undefined =>
    label === "In" ? "in" : label === "Out" ? "out" : undefined;

export function IoBlock({ label, tip, preview, render, raw, marks, reserve, failLine }: { label: string; tip?: string; preview: string; render?: RenderDescriptor; raw: ComponentChildren; marks?: [number, number][]; reserve?: boolean; failLine?: number | null }) {
    const [showRaw, setShowRaw] = useState(false);   // rendered by default when a descriptor targets this block
    // The capped/scrollable/findable cell is for tool OUTPUT — a fetch_url page, a big sampleText dump. The In
    // block is the CALL (args / the code being run): short, and it already renders in its own code block, so
    // wrapping it there only added chrome (and a stray horizontal scrollbar) for nothing.
    const cell = (body: ComponentChildren) => label === "Out" ? <OutputCell>{body}</OutputCell> : <>{body}</>;
    return (
        <details class="io" open>
            <summary class="io-label" title={tip}>{label}: <span class="io-preview">{preview}</span></summary>
            <div class="io-body">
                {/* The toggle is also rendered (DISABLED) while output is still streaming: the descriptor only
                    arrives when the step settles, and letting the row appear then pushed everything down — the
                    same jump as the live rail, vertically. `reserve` holds its space until it's usable. */}
                {render || reserve
                    ? <>
                        <div class={`rr-toggle${render ? "" : " reserved"}`}>
                            <span class="tt"><button class={showRaw ? "" : "on"} disabled={!render} onClick={() => setShowRaw(false)}>rendered</button><span class="tt-pop left" role="tooltip">{render ? "A debug visualisation for you — not shown to the model." : "Available once this step finishes."}</span></span>
                            <span class="tt"><button class={showRaw ? "on" : ""} disabled={!render} onClick={() => setShowRaw(true)}>raw</button><span class="tt-pop left" role="tooltip">{render ? "Exactly what the model sent/received. All it knows." : "Available once this step finishes."}</span></span>
                        </div>
                        {render && !showRaw ? <RenderPanel d={render} marks={marks} failLine={failLine} />
                            /* RAW is shared by every tool and has no renderer-specific structure, so it
                               carries the DEFAULT anchor for the slot. A rendered view may declare a finer
                               one (python-in's code, python-out's value) and wins by being the visible
                               match; when it declares none, this is still the right half of the step. */
                            : <div data-cite={slotOf(label)}>{cell(raw)}</div>}
                    </>
                    : <div data-cite={slotOf(label)}>{cell(raw)}</div>}
            </div>
        </details>
    );
}


export const StepPill = ({ step, max }: { step: number; max?: number }) =>
    <span class="step-pill">step {step}{max ? `/${max}` : ""}</span>;

// The turn's separate reasoning channel (reasoning_content) — how the model THINKS, distinct from
// what it says (the prose). Dim, COLLAPSED by default (its text is mostly noise); the preview is just
// a ~token estimate (the server reports reasoning_tokens:0). No status dot — it's not a step that fails.
export function ThoughtBlock({ thought, live }: { thought: string; live?: boolean }) {
    const [open, setOpen] = useState(false);
    const bodyRef = useRef<HTMLDivElement>(null);
    // While LIVE (streaming), keep the expanded body scrolled to the newest text.
    useEffect(() => { if (live && open && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight; });
    const tokEst = Math.max(1, Math.round(thought.length / 4));   // ~chars/4 (no real reasoning_tokens)
    return (
        <div class={`athought athinking${live ? " live" : ""}`}>
            <button class="astep-head" onClick={() => setOpen(v => !v)}>
                <span class={`tri${open ? " open" : ""}`} aria-hidden="true"><IconChevron /></span>
                <span class="who">thinking</span>
                {/* The ~token estimate is a debug detail — hidden in the user-facing HUD card, EXCEPT while live,
                    where the ticking count (with a trailing "…") IS the "it's working" cue. No live DOT: it
                    would take a slot that vanishes on settle, jerking "thinking" left. The row's structure is
                    IDENTICAL live vs settled, so nothing shifts. */}
                {/* Its OWN class beside the shared one. `.astep-preview` is also the collapsed TOOL row's output
                    preview, which focus mode hides as spam — and hiding this with it took away the only sign
                    that a long think is progressing rather than stuck, which is the opposite of what a reading
                    mode wants. Two classes rather than a new one: the styling is shared, the visibility is not. */}
                {!open && (surface.value !== "card" || live) ? <span class="astep-preview astep-tokest">~{tokEst} tokens{live ? "…" : ""}</span> : null}
            </button>
            {/* Live: plain text (partial markdown mid-stream renders ugly); finished: markdown. */}
            {open
                ? (live
                    ? <div class="astep-body live-scroll" ref={bodyRef}>{thought}</div>
                    : <div class="md astep-body" dangerouslySetInnerHTML={{ __html: markdown(thought, { math: true }) }} />)
                : null}
        </div>
    );
}

// Where the MODEL's copy of this tool's output will be cut, for a step that's still streaming — so the
// doomed tail can be greyed AS IT ARRIVES instead of springing the truncation on you at the end. Derived from
// the call's own args, so a model-requested (human-approved) larger cap is respected automatically. Only the
// tools that HAVE an output cap report one; everything else streams unmarked.
export function liveCutoff(st: AgentStep): number | undefined {
    if (st.tool !== "exec" && st.tool !== "python_exec") return undefined;
    const a = st.arguments || {};
    return resolveOutputCap(st.tool, a.maxChars, a.maxCharsReason).cap;
}

export const toolFailed = (result?: string): boolean => !!result && /^(Error:|Denied)/.test(result);

// One tool call: collapsed by default. Expanded, a descriptor renders by default
// with a rendered⇄raw toggle (raw = the In:/Out: args+result); no descriptor →
// In:/Out: directly.
// How an approval-gated call was decided — a green/red provenance pill. This is
// also the slot a future interactive-approval control will resolve into.
export const APPROVAL = {
    readonly: { label: "auto-approved", tip: "Auto-approved by the read-only exec setting." },
    sandbox: { label: "auto-approved", tip: "Auto-approved by the python_exec setting — a readonly-mode run is isolated by construction (no network / JS scope / DOM / filesystem)." },
    "same-origin": { label: "auto-approved", tip: "Same-site action — a navigation or an uncredentialed fetch to this origin (or one you already allowed this run). The page could do it itself, so no prompt." },
    consented: { label: "auto-approved", tip: "A URL you already approved fetching this session — no re-prompt." },
    "self-source": { label: "auto-approved", tip: "An uncredentialed read of the agent's OWN repo source (code / structural API, not issues or other user-generated prose) — free via the Self-source setting." },
    user: { label: "approved", tip: "Approved by you." },
    denied: { label: "denied", tip: "Denied by you." },
    skipped: { label: "skipped", tip: "No prompt needed — the target didn't resolve (no element / stale @pt / bad selector), so the action could only fail. It never ran." },
    cancelled: { label: "cancelled", tip: "You cancelled the run while this call was awaiting approval — it never ran." },
} as const;
export const ApprovalBadge = ({ approval }: { approval: keyof typeof APPROVAL }) => (
    <span class={`tt appr-badge appr-${approval}`}>
        <span class={`appr ${approval === "denied" ? "no" : (approval === "skipped" || approval === "cancelled") ? "skip" : "yes"}`}>{APPROVAL[approval].label}</span>
        <span class="tt-pop left" role="tooltip">{APPROVAL[approval].tip}</span>
    </span>
);

// The distinct EXTERNAL Google Sheet ids a python_exec call will load — read from the ARGS (`tables`),
// NOT the rendered In: at approval time the tables aren't fetched yet (the pre-run preview is code-only),
// so the render has no sheet source. Approving grants the run those spreadsheets for the rest of the
// page-session, so the gate discloses it. Same detection as the background's escalation (externalSheetIds).
export function externalSheetGrant(args?: Record<string, unknown>): string[] {
    return args ? [...new Set(externalSheetIds(args))] : [];
}

// A first-time fetch of a new origin needs the extension's host access to that site (the background SW fetch
// is withheld under "On click" site access). Because this iframe is extension-origin, approving the gate can
// grant the host in the same gesture (decideGate) — this note tells the user a Chrome permission prompt will
// appear, so it isn't a surprise. Async-checks chrome.permissions.contains; renders nothing when already
// granted (or on a page-loop run with no chrome), so a normal already-allowed fetch stays silent.
export function HostAccessNote({ st }: { st: AgentStep }) {
    const pat = grantHostPattern(st);
    const [missing, setMissing] = useState(false);
    useEffect(() => {
        let live = true;
        if (!pat || typeof chrome === "undefined" || !chrome.permissions?.contains) { setMissing(false); return; }
        chrome.permissions.contains({ origins: [pat] }).then((has: boolean) => { if (live) setMissing(!has); }).catch(() => {});
        return () => { live = false; };
    }, [pat]);
    if (!pat || !missing) return null;
    const host = pat.replace(/^https?:\/\//, "").replace(/\/\*$/, "");
    // A navigate needs the host so the content script can re-inject on the new site (re-adoption); a fetch
    // needs it so the background fetch can reach the URL. Same grant, different reason — say which.
    const why = st.tool === "navigate" ? "so the agent can keep working on it after navigating" : "so the fetch can reach it";
    return (
        <div class="action-host">
            <IconWarn />
            <span>First-time access to <b class="action-target">{host}</b> — approving asks Chrome to grant this site {why}.</span>
        </div>
    );
}

// A raised output cap on exec/python_exec is worth calling out on the approval card: the agent is asking to
// let its own result run longer than the default (its context, your tokens). Show the ceiling-clamped size +
// the model's required justification (warm/dotted, like a significant action). Renders nothing when unraised.
export function OutputRaiseNote({ tool, args }: { tool?: string; args?: Record<string, unknown> }) {
    if (tool !== "exec" && tool !== "python_exec") return null;
    const c = resolveOutputCap(tool, args?.maxChars, args?.maxCharsReason);
    if (!c.escalated) return null;
    const reason = typeof args?.maxCharsReason === "string" ? args.maxCharsReason.trim() : "";
    return (
        <div class="action-raise">
            <IconWarn />
            <span>Raise output limit to <b class="action-submit">{c.cap.toLocaleString()} chars</b> (default {c.def.toLocaleString()}){reason ? <> — <span class="action-target">“{reason}”</span></> : null}.</span>
        </div>
    );
}

// The items a persistable grant would remember (today only `fetch-url` → its URLs). Extensible: a new grant
// kind returns its own detail strings here + a label in GRANT_KIND + a detail branch in GrantCard.
export const GRANT_KIND: Record<string, { noun: string; nounN: string }> = {
    "fetch-url": { noun: "URL", nounN: "URLs" },
};
export function grantUrlsOf(g: PersistGrant): string[] { return g.kind === "fetch-url" ? [...new Set(g.urls)] : []; }
export function hasPersistGrants(grants?: PersistGrant[]): boolean { return !!grants?.some(g => grantUrlsOf(g).length > 0); }

// The collapsed "Keep" grant card shown above the approval buttons — a deterministic per-kind SUMMARY of
// what approving-and-remembering will persist for the session ("Keep remembers 1 URL …"), expand for the
// exact items. Driven by the step's `grants` BY KIND, so a new grant kind slots in with no layout change.
// Shared by the sidebar step and the HUD card. (The "Keep" button does approve + persist.)
// Deliberate two-key combo for Keep (⌘K on mac, Ctrl+K elsewhere) — NOT Enter-adjacent, on purpose.
export const KEEP_HINT = (typeof navigator !== "undefined" && /Mac/i.test(navigator.platform || navigator.userAgent || "")) ? "⌘K" : "Ctrl K";
export function GrantCard({ grants }: { grants: PersistGrant[] }) {
    const byKind = new Map<string, number>();
    for (const g of grants) { const n = grantUrlsOf(g).length; if (n) byKind.set(g.kind, (byKind.get(g.kind) || 0) + n); }
    const summary = [...byKind.entries()].map(([k, n]) => { const nm = GRANT_KIND[k]; return `${n} ${n === 1 ? nm?.noun || k : nm?.nounN || k}`; }).join(" · ");
    return (
        <details class="appr-grant">
            <summary class="appr-grant-head"><span class="tri" aria-hidden="true"><IconChevron /></span><IconWarn /><span class="appr-grant-sum"><b>Keep</b> lets the agent fetch {summary} WITHOUT approval for the rest of this session</span></summary>
            <div class="appr-grant-detail">
                {grants.map((g, i) => grantUrlsOf(g).length ? <ul class="grant-url-list" key={i}>{grantUrlsOf(g).map((u, j) => <li key={j}><code>{u}</code></li>)}</ul> : null)}
                <div class="appr-grant-note">Fetched results are cached and reused — the agent won't re-ask for {grants.length === 1 && grantUrlsOf(grants[0]).length === 1 ? "it" : "them"} until you reload.</div>
            </div>
        </details>
    );
}

/** A step's pointer, click-to-copy. Copies the full `@tool:<id>` rather than the bare hex: that is the form
 *  that resolves everywhere — in the composer, in `ml.dereference`, in a `@tool:` macro inside `exec` — and
 *  making someone add the prefix by hand is how you get a fault instead of a read. */
function TokenChip({ token }: { token: string }) {
    const [done, setDone] = useState(false);
    const ref = `@tool:${token}`;
    const copy = () => {
        // `navigator.clipboard` needs a secure context and can reject; the textarea fallback is what makes
        // this work in an extension iframe where it sometimes does not.
        const ok = () => { setDone(true); setTimeout(() => setDone(false), 1200); };
        try {
            navigator.clipboard?.writeText(ref).then(ok, () => fallback());
            if (!navigator.clipboard) fallback();
        } catch { fallback(); }
        function fallback() {
            try {
                const ta = document.createElement("textarea");
                ta.value = ref; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
                document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove();
                ok();
            } catch { /* nothing else to try; the text is on screen to read */ }
        }
    };
    return (
        <div class="astep-token">
            <button class="tt tok-chip" onClick={copy} aria-label={`Copy ${ref}`}>
                <code>{ref}</code>
                {/* A GLYPH, not a word. A hover-only label changes the chip's width, and the chip is
                    right-aligned, so the pointer text jumped sideways every time the cursor arrived. Two
                    icons of the same box mean the affordance is always visible and the confirmation costs
                    no layout either. */}
                <span class="tok-chip-icon">{done ? <IconCheck /> : <IconCopy />}</span>
                <span class="tt-pop wrap left" role="tooltip">This step's output kept as a pointer. Copy it and paste it into the composer to ask about this exact output, or read it in `exec` as {ref}.</span>
            </button>
        </div>
    );
}

export function ToolStep({ st, hash }: { st: AgentStep; hash?: string }) {
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
    // The DEEPEST user frame of a python traceback, if this step failed — the line the failure was ON, as
    // opposed to the call path above it. Read here because the step holds both descriptors.
    const failLine = outRender && outRender.type === "python-out" && outRender.error
        ? deepestUserLine(outRender.error) : null;
    // Design A: a background-hosted call blocked on the human gate. Render approve/deny here — the
    // decision is made in this (extension-origin) iframe, unforgeable by the page. Needs the run hash +
    // the step seq to correlate; without them (a page-loop run) fall back to the plain pending view.
    const awaiting = !!(st.awaitingApproval && st.pending && !decided && hash && st.seq != null);
    // A pending approval AUTO-UNFURLS the In so you review the call before deciding (no extra click).
    // So does being the step someone just navigated TO — from a lane block or an answer citation, both of
    // which say "open this step". Landing on a collapsed row that merely pulses is the promise half-kept:
    // you are shown WHERE it is and not WHAT it was, which is the thing you clicked for.
    //
    // Derived DURING RENDER into a sticky flag, the same way the containing block does it (card-showwork's
    // `stuckOpen`): `revealSeq` auto-clears about a second later so a re-click of the same seq re-triggers,
    // and reading it directly would collapse the step again right after it opened. Sticky also means the
    // header toggle still works afterwards — it clears the flag, so a collapse actually collapses.
    // Hovering a block in the event lane dims every step outside its lineage, the same way the lane dims its
    // own bars — so the bar and the rows it is about are picked out together.
    const litSeqs = laneLitSeqs.value;
    const dimmed = !!litSeqs && st.seq != null && !litSeqs.has(st.seq);
    const open = expanded || awaiting;
    // Keep the step expanded after you decide (setExpanded), so it doesn't collapse when `awaiting`
    // clears — you see the Out result fill in on the same open cell.
    //
    // FOCUS MODE inverts that, because it is reading the run as a conversation: a call you have just
    // decided on is finished being the thing you are looking at, and leaving it open means every approval
    // permanently widens the transcript you came to read. It collapses to its one-line preview instead,
    // which still fills in with the result. Deciding is also the one moment a collapse cannot lose you
    // anything — you have just read the call in order to approve it.
    const decide = (ok: boolean, persist = false) => {
        setExpanded(!focusMode.value); setDecided(true);
        if (hash && st.seq != null) decidedSteps.add(stepKey(hash, st.seq));
        void decideGate(st, hash!, st.seq!, ok, persist);   // fetch_url: grant its host in-gesture, then post
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
    const showGrants = awaiting && hasPersistGrants(st.grants);
    return (
        <div data-astep-seq={st.seq} class={`astep tool${dimmed ? " away" : ""}${open ? " open" : ""}${st.pending ? " pending" : ""}${awaiting ? " awaiting" : ""}${st.approval ? (st.approval === "denied" ? " appr-no" : (st.approval === "skipped" || st.approval === "cancelled") ? " appr-skip" : " appr-yes") : ""}`}>
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
                {!open ? <span class="astep-preview">{awaiting ? <span class="dim">needs approval</span> : st.pending ? (st.streamOutput ? <span class="astep-livepreview">{collapsedPreview(st.streamOutput).text}</span> : <span class="dim">running…</span>) : collapsedPreview(st.result || "").text}</span> : null}
            </button>
            {open
                ? <div class="astep-body">
                    {issues ? <div class="tt tt-row arg-issues"><IconWarn /><span>arg schema: {issues.join("; ")}</span><span class="tt-pop wrap left" role="tooltip">The args don't match this tool's parameter schema.</span></div> : null}
                    {st.reused?.length ? <ReusedBlock reused={st.reused} /> : null}
                    {args || inRender
                        ? <IoBlock label="In" tip="The arguments the model passed to this tool call."
                            preview={inlineJson(args || {})} render={inRender}
                            /* WHERE IT BROKE, from the Out's traceback, marked on the In's code. The step is
                               the only place that holds both halves — the two RenderDescriptors are rendered
                               in separate blocks and neither can see the other. */
                            failLine={failLine}
                            raw={<RawArgs args={args || {}} schema={paramSchema} />} />
                        : null}
                    <IoBlock label="Out" tip="What the tool returned to the model." marks={st.streamMarks} reserve={!!st.pending && st.streamOutput != null}
                        preview={st.pending ? (st.streamOutput ? inlineText(st.streamOutput) : "running…") : inlineText(st.result || "")} render={outRender}
                        raw={st.pending
                            ? (st.streamOutput != null
                                // LIVE tool output (ctx.stream — console.log / print) filling in Jupyter-style while it runs.
                                ? <div class="astep-streaming"><SeenSplit text={st.streamOutput} seen={liveCutoff(st)} live marks={st.streamMarks} /></div>
                                : <span class="dim">running…</span>)
                            : (st.modelResult ?? st.result) ? <Code text={st.modelResult ?? st.result ?? ""} lang="text" /> : <span class="dim">(no output)</span>} />
                    {st.feedback ? <FeedbackBlock fb={st.feedback} /> : null}
                    {/* The step's POINTER, when the run minted one — a first-class handle the model reads its
                        own outputs back through and can cite in an answer, which until now existed only in
                        the model's context. Click to copy: paste it into the composer to ask about this exact
                        output. Under the Out it names, because it is a handle ON that output, not a property
                        of the call — putting it above made it the first thing you read about a step, which it
                        is not.

                        DevTools only. The HUD is a glance surface for someone driving a task and a hex handle
                        there is noise; this belongs on the surface you open when you are debugging. */}
                    {st.token && surface.value !== "card" ? <TokenChip token={st.token} /> : null}
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
                    <HostAccessNote st={st} />
                    <OutputRaiseNote tool={st.tool} args={st.arguments} />
                    {showGrants ? <GrantCard grants={st.grants!} /> : null}
                    <div class="appr-row">
                        <span class="appr-ask">Approve running <b>{st.tool}</b>?</span>
                        <span class="sp" />
                        <button class="appr-btn no" onClick={() => decide(false)}>Deny</button>
                        <button class="appr-btn yes" onClick={() => decide(true)}>Approve</button>
                        {showGrants ? <button class="appr-btn yes remember" title="Approve — and let the agent fetch these URLs WITHOUT approval for the rest of this session (results are cached)" onClick={() => decide(true, true)}>Keep</button> : null}
                    </div>
                </div>
                : null}
        </div>
    );
}

// A turn's PROSE (content) — what the model SAYS this step. Rendered like the final answer: plain
// markdown, EXPANDED by default, no status dot / "thought" label / box. Collapsible via a subtle
// chevron (→ a one-line preview), same affordance the answer bubble uses.
export function TurnProse({ text }: { text: string }) {
    const [collapsed, setCollapsed] = useState(false);
    const p = collapsedPreview(text);
    // Nothing to collapse (a short single-line thought that fits the preview whole) → no toggle chevron; it
    // would only mislead ("expand" reveals nothing). Just render the prose.
    if (!p.more) return <div class="aturn-prose no-toggle"><div class="md" dangerouslySetInnerHTML={{ __html: markdown(text, { math: true }) }} /></div>;
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
export function AgentTurn({ turn, max, hash }: { turn: AgentTurnGroup; max?: number; hash?: string }) {
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
export function jtPreview(v: object): string {
    if (Array.isArray(v)) return v.length ? `[ ${v.length} item${v.length === 1 ? "" : "s"} ]` : "[ ]";
    const keys = Object.keys(v);
    if (!keys.length) return "{ }";
    return `{ ${keys.slice(0, 4).join(", ")}${keys.length > 4 ? ", …" : ""} }`;
}
// A JSON-schema node (as much as we read of it): its own `description`, and children by `properties`
// (object) or `items` (array). Passed alongside a value so JsonNode can annotate keys with their schema
// description — at ANY depth, not just the top level (nested-object args get tooltips too).
export interface JsonSchemaNode { description?: string; properties?: Record<string, JsonSchemaNode>; items?: JsonSchemaNode; }
// A JSON key. When the schema gives it a description, it becomes a hoverable tooltip (same .tt/.tt-pop as
// elsewhere) + a dotted underline so you can tell which keys carry docs — a debugging affordance over raw args.
export function JtKey({ name, desc, unknown }: { name: string; desc?: string; unknown?: boolean }) {
    if (unknown) return <span class="tt jt-key jt-key-unknown" tabIndex={0}>{name}:<span class="tt-pop left" role="tooltip">Not in this tool's parameter schema — likely a hallucinated argument, so the tool will ignore it or error.</span></span>;
    if (desc) return <span class="tt jt-key jt-key-doc" tabIndex={0}>{name}:<span class="tt-pop left" role="tooltip">{desc}</span></span>;
    return <span class="jt-key">{name}:</span>;
}
export function JsonNode({ k, v, depth = 0, defaultOpen, schema, desc, unknown, allOpen }: { k?: string; v: unknown; depth?: number; defaultOpen?: boolean; schema?: JsonSchemaNode; desc?: string; unknown?: boolean; allOpen?: boolean }) {
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
export function RawArgs({ args, schema }: { args: unknown; schema?: JsonSchemaNode }) {
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
export function ToolDefCard({ t }: { t: DebugAgentConfig["tools"][number] }) {
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
export function ToolDefsView({ tools }: { tools: DebugAgentConfig["tools"] }) {
    return <div class="tooldefs">{tools.map((t, i) => <ToolDefCard key={i} t={t} />)}</div>;
}

export function AgentOptionsBlock({ s }: { s: Session }) {
    const c = s.agentConfig;
    const [open, setOpen] = useState(false);
    if (!c) return null;
    // The full defs (description + parameter schema) are only in newer events; older ones carry names
    // only, so the "show tool defs" viewer would just repeat the summary line — hide it then.
    const hasToolDefs = c.tools.some(t => t.description || t.parameters);
    const lines = [`model: ${s.model || "default"}`, `maxSteps: ${c.maxSteps}`, `streaming: ${c.stream ? "on" : "off"}`];
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
                    {/* Sections that OPEN, not buttons that inject a box: same disclosure the rest of the
                        panel uses, so a chevron means the same thing everywhere. */}
                    <div class="sys-block">
                        <Disclosure label={<>system prompt{c.customSystem ? " (custom)" : ""}</>}>
                            <Code text={c.system} lang="markdown" />
                        </Disclosure>
                    </div>
                    {hasToolDefs
                        ? <div class="sys-block">
                            <Disclosure label="tool definitions" note={`${c.tools.length}`}>
                                <ToolDefsView tools={c.tools} />
                            </Disclosure>
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
export function SteerSeen({ seen }: { seen: boolean }) {
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
export const UserBubble = ({ text, ts, images, steer }: { text: string; ts: number; images?: string[]; steer?: { seen?: boolean } }) => (
    <div class="msg user">
        <div class="mrow"><span class="who">you</span>{steer ? <SteerSeen seen={!!steer.seen} /> : null}<span class="sp" /><Stamp ts={ts} /></div>
        {images?.length ? <div class="thumbs">{images.map((src, i) => <ClickableImg key={i} src={src} />)}</div> : null}
        {text ? <div class="utext">{text}</div> : null}
    </div>
);

// The absolute destination of a `navigate` step (the resolved URL the action render carries, else the raw arg).
export const navTargetOf = (st: AgentStep): string => {
    const ri = st.renderIn;
    if (ri && ri.type === "action" && typeof ri.target === "string" && ri.target) return ri.target;
    const u = st.arguments?.url;
    return typeof u === "string" ? u : "";
};
// host + path for a compact label; the full URL rides the title tooltip.
export const prettyUrl = (url: string): string => {
    try { const u = new URL(url); return u.host + (u.pathname !== "/" ? u.pathname : "") + u.search; } catch { return url; }
};
// A page-transition marker in the run log — the moment the agent left this document and the run RE-ADOPTED the
// new one (a cross-page/-domain nav). Like Claude Code's context-compaction rule: a horizontal divider that
// makes the seam legible when reading a run that spans pages, distinct from the `navigate` tool call above it.
export function NavDivider({ url }: { url: string }) {
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

// Every per-call usage sample a session recorded — agent runs stamp usage per STEP; chat sessions per TURN.
function sessionUsages(s: Session): (import("../contract").TokenUsage | null | undefined)[] {
    return [...(s.steps || []).map(st => st.usage), ...(s.turns || []).map(t => t.usage)];
}

// The DevTools bottom-bar run-stats readout: cumulative in/out token SPEND and the generation rate, with a
// hover tooltip recording HOW the rate was measured (Ollama generation time vs wall-clock incl. network). Each
// figure is independently toggled in Settings → Appearance (chrome.storage.local prefs); with both off, or no
// usage reported yet, it renders nothing. Panel chrome — the HUD card has no such bar.
export function RunStatsBar({ s }: { s: Session }) {
    const rs = runStats(sessionUsages(s));
    const tps = fmtTokPerSec(rs);
    const showTok = showStatsTokens.value && rs.calls > 0;
    const showTps = showStatsTps.value && tps != null;
    if (!showTok && !showTps) return null;
    return (
        <div class="run-stats tt" role="status" aria-label="run token stats">
            {showTok ? <span class="rstat"><span class="rstat-ic" aria-hidden="true">↕</span>{rs.inTokens.toLocaleString()} in · {rs.outTokens.toLocaleString()} out</span> : null}
            {showTps ? <span class="rstat rstat-tps">{tps}</span> : null}
            <span class="tt-pop left" role="tooltip">{runStatsProvenance(rs)}</span>
        </div>
    );
}

export function AgentRunView({ s }: { s: Session }) {
    // Skip an empty step group — one carrying only a usage sample (final-answer token counts), no
    // thought/reasoning/tool. KEEP a reasoning-only turn (the final-answer turn shows its thinking here).
    const groups = groupTurns(s.steps || []).filter(t => t.thought || t.reasoning || t.tools.length);
    // The whole session is a CHAT LOG: user messages (task + follow-ups + says) and answers interleaved
    // with the turn step-groups, ordered by step position. `atStep + fraction` slots an answer just after
    // its turn's steps, and a following user message just after that.
    const lastAnswerTs = (s.answers && s.answers.length) ? s.answers[s.answers.length - 1].ts : -1;
    const answers = s.answers || [];
    // A tool-name ALIAS (`@tool:python_exec`) in a PRIOR answer must resolve within THAT turn's steps, not the
    // whole run — else it drifts to a later turn's call. The turn's steps are the groups between the previous
    // answer's boundary and this one's (mirrors buildRunBlocks' segmentation). The LATEST answer is NOT scoped
    // (undefined → whole run): a tool-name alias means "that tool's latest call", and a follow-up answer
    // legitimately cites a tool it ran in an EARLIER turn (e.g. "show me how you computed this" → the prior
    // python_exec). Per-turn-scoping the latest answer was the bug that made such a cross-turn citation show
    // "unresolved" in the DevTools panel while the HUD (which passes no scope for the final answer) resolved it.
    const scopeFor = (i: number): AgentStep[] => {
        const lo = i > 0 ? answers[i - 1].atStep : -Infinity;
        const hi = answers[i].atStep;
        return groups.filter(g => g.step > lo && g.step <= hi).flatMap(g => g.tools);
    };
    const answer = (a: NonNullable<Session["answers"]>[number], key: string, i: number) =>
        a.error
            ? <ReplyBubble key={key} content="" status="err" model={s.model} profile={sessionProfile(s)} ts={a.ts} error={a.error} label="run failed" />
            : <ReplyBubble key={key} content={a.text} status={a.status} model={s.model} profile={sessionProfile(s)} ts={a.ts} tokenRun={s} tokenScope={a.ts === lastAnswerTs ? undefined : scopeFor(i)} latest={a.ts === lastAnswerTs}
                label={a.cancelled ? "cancelled" : a.hitCap ? "stopped (step cap)" : undefined} capped={a.hitCap || a.cancelled}
                // Only the LATEST answer, and only a step-cap stop (not a cancel/error), offers Continue — resuming
                // an old buried answer would be confusing, and a live run has nothing to resume.
                resumeCap={a.hitCap && !a.cancelled && a.ts === lastAnswerTs && s.status !== "pending" ? { hash: s.hash, steps: s.maxSteps || 20 } : undefined} />;
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
        ...(s.answers || []).map((a, i) => ({ pos: a.atStep + 0.5, ts: a.ts, el: answer(a, `a${i}`, i) })),
        ...(s.says || []).map((sy, i) => ({ pos: sy.atStep + 0.5, ts: sy.ts, el: <UserBubble key={`s${i}`} text={sy.text} ts={sy.ts} images={sy.images} steer={sy.id ? { seen: sy.seen } : undefined} /> })),
    ].sort((a, b) => a.pos - b.pos || a.ts - b.ts);
    return (
        <>
            <AgentOptionsBlock s={s} />
            {items.map(it => it.el)}
            {s.liveStream ? <LiveStream ls={s.liveStream} s={s} /> : null}
            {s.status === "pending" ? <PendingNote s={s} /> : null}
        </>
    );
}

// The model's LIVE output while the current step streams (opt-in stream:true) — fed into the SAME container
// SHAPES the finished run uses, so when the step resolves there's no jarring jump: the reasoning into an
// `.aturn` group (StepPill + a live `ThoughtBlock`, ticking count, expand to watch), the reply into the real
// `ReplyBubble` in streaming mode (model chip + content + a live pulse). Cleared the instant the step's real
// events land (the reducer nulls liveStream on agent-step/agent-result).
export function LiveStream({ ls, s }: { ls: NonNullable<Session["liveStream"]>; s: Session }) {
    if (!ls.reasoning && !ls.content) return null;
    return (
        <>
            {ls.reasoning
                ? <div class="aturn">
                    <div class="aturn-head"><StepPill step={ls.localStep ?? ls.step} max={s.maxSteps} /></div>
                    <ThoughtBlock thought={ls.reasoning} live />
                  </div>
                : null}
            {ls.content ? <ReplyBubble content={ls.content} status="ok" model={s.model} profile={sessionProfile(s)} ts={ls.step /* unused while streaming */} streaming /> : null}
        </>
    );
}

// The live footer of a running agent. Its bar is a browser-native motif — the thin indeterminate
// "page is loading" sweep an SPA shows on navigation — so an active run reads as the browser working.
// When the run is BLOCKED on your approval it swaps to a breathing amber bar (no forward motion) +
// "waiting…", so paused-needs-you vs actively-running is legible at a glance from colour + motion.
export function PendingNote({ s }: { s: Session }) {
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
