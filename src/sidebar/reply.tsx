// Chat + session-list rendering primitives — the assistant reply bubble (shared by a chat turn and an
// agent run's final answer), the user/assistant turn pair, and the session-list row. Extracted from
// app.tsx; a leaf view layer over ui-kit + answer-render (no agent-detail / HUD deps, so agent-detail
// can import ReplyBubble without a cycle).
import { useState } from "preact/hooks";
import type { ExtendProfile } from "../contract";
import { view } from "./store";
import type { Session, Turn, Status, AgentStep } from "./store";
import { pretty, truncate, collapsedPreview, markdown } from "./format";
import { annotatedConfig, turnProfile } from "./model";
import { IconChevron } from "./icons";
import { Dot, Stamp, Hash, TagBadge, CopyBtn, CopyModel, Code, ClickableImg } from "./ui-kit";
import { aliasOf, AnswerBody, ResultBlock } from "./answer-render";
import { hasTokens } from "../answer-tokens";

// The session's createChat config (not the per-turn request/messages — full
// message history is a separate export feature).
export function OptionsBlock({ s }: { s: Session }) {
    // A session may carry NO config — `ml.embed()` reports through the chat events and has none to speak of.
    // Dereferencing it blanked the entire detail view, which is a worse failure than the missing block: one
    // absent field should never take the transcript with it.
    const c = s.config;
    if (!c) return null;
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



// A reply bubble — shared by a chat turn's assistant reply and an agent run's
// final answer, so the two render identically: no boxed background (#5), a header
// (status dot · collapse chevron · model chip · (profile) · copy · raw ⇄ nice ·
// timestamp) over the body (markdown ⇄ raw, collapsible), with optional thinking
// and sources. No "assistant"/"answer" word — the header controls carry the
// meaning; `label` appears only for an exceptional state (e.g. an agent step-cap).
export function ReplyBubble({ content, status, model, profile, ts, reasoning = null, sources = null, error, label, capped, initialRaw, resumeCap, streaming, tokenRun, tokenScope, anchorHash, latest }: {
    content: string; status: Status; model: string | null; profile: "utility" | "default" | null; ts: number;
    reasoning?: string | null; sources?: unknown[] | null; error?: string; label?: string; capped?: boolean; initialRaw?: boolean;
    resumeCap?: { hash: string; steps: number };   // a step-capped run → a "Continue (+N steps)" button (resume, fresh budget)
    streaming?: boolean;   // the answer is STREAMING live — same bubble as the finished reply (model chip + content) with a live pulse, no copy/raw/stamp yet
    tokenRun?: Session;   // an agent ANSWER: resolve its @tool citations against this run (chat replies pass none). The existing [raw] shows the literal markdown.
    tokenScope?: readonly AgentStep[];
    /** The session this reply belongs to, for the event lane's scroll-to-answer. An agent answer takes it
     *  from `tokenRun`; a chat reply has no run to take it from and must be told. */
    anchorHash?: string;   // narrow a tool-name ALIAS to THIS turn's steps, so a prior answer's `@tool:python_exec` doesn't drift to a later turn's call
    latest?: boolean;   // this is the run's LATEST answer → render the bottom-of-answer ResultBlock here (s.answer holds only the latest, so earlier turns must not show it)
}) {
    const [showRaw, setShowRaw] = useState(!!initialRaw);
    const [collapsed, setCollapsed] = useState(false);
    // "There's a reply to show" — true for an OK turn AND a step-capped agent answer
    // (status "err" but it still produced a summary). A real error has `error` set. A streaming reply
    // also has content to show (it's filling in), so it renders the body too.
    const hasReply = (status !== "pending" && !error) || !!streaming;
    const preview = hasReply ? collapsedPreview(content) : null;
    // `data-answer-hash` is an ANCHOR for the run this answer belongs to. The event lane's final generation IS
    // this message, but it carries no step seq — nothing else in the transcript identifies it, so clicking
    // that bar navigated to the run and then had nothing to scroll to or highlight.
    return (
        <div class={`msg asst ${status}${capped ? " capped" : ""}${streaming ? " streaming" : ""}`}
            {...((tokenRun?.hash || anchorHash) ? { "data-answer-hash": tokenRun?.hash || anchorHash } : {})}>
            <div class="mrow">
                {/* Chevron (collapse affordance) · status dot · an optional label for an exceptional state
                    (e.g. an agent step-cap stop). Same structure while STREAMING — the chevron stays and a live
                    pulse swaps in FOR the status dot (same slot, so the model chip / text don't shift on settle);
                    copy/raw/stamp are the only things that appear when it settles (on the right, no left shift). */}
                {hasReply
                    ? <button class="who-toggle" title={collapsed ? "expand" : "collapse"} onClick={() => setCollapsed(v => !v)}>
                        <span class={`tri${collapsed ? "" : " open"}`} aria-hidden="true"><IconChevron /></span>
                      </button>
                    : null}
                {streaming ? <span class="live-dot" aria-hidden="true" /> : <Dot status={status} />}
                {label ? <span class="who">{label}</span> : null}
                {/* The model that produced this reply + its (default)/(utility) profile. */}
                {hasReply && model ? <CopyModel model={model} /> : null}
                {hasReply && model && profile ? <span class="profile-inline">({profile})</span> : null}
                <span class="sp" />
                {/* Copy + raw⇄nice are for a real reply. A terminal notice (a step-cap
                    stop) is a short line — collapsible is enough; copy/raw are noise. Not while streaming. */}
                {hasReply && !capped && !streaming
                    ? <>
                        <CopyBtn text={content} tip="copy markdown" />
                        {collapsed ? null : <button class="raw-btn" onClick={() => setShowRaw(v => !v)}>{showRaw ? "nice" : "raw"}</button>}
                    </>
                    : null}
                {streaming ? null : <Stamp ts={ts} />}
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
                            : tokenRun && hasTokens(content, aliasOf(tokenRun))
                                ? <AnswerBody text={content} run={tokenRun} cls="asst-answer" scope={tokenScope} />
                                : <div class="md" dangerouslySetInnerHTML={{ __html: markdown(content, { math: true }) }} />}
            {/* Bottom-of-answer tool outputs — SAME ResultBlock the HUD card renders (parity). Only on the
                run's latest answer (s.answer is single-valued) and only in the normal, expanded view. */}
            {hasReply && !collapsed && !showRaw && latest && tokenRun ? <ResultBlock run={tokenRun} shownIn={content} /> : null}
            {/* A step-capped run stopped mid-task — one click resumes it with a fresh N-step budget (no need to
                type a follow-up). Resuming re-enters the SAME run by hash from its stored state. */}
            {resumeCap && !collapsed
                ? <button class="continue-run" title="Resume this run with more steps, continuing from where it stopped"
                    onClick={() => window.parent.postMessage({ __mlSidebarApp: "continueRun", hash: resumeCap.hash }, "*")}>
                    Continue <span class="continue-steps">+{resumeCap.steps} steps</span>
                  </button>
                : null}
            {sources?.length
                ? <details class="sources"><summary>{`sources (${sources.length})`}</summary><Code text={pretty(sources)} lang="json" /></details>
                : null}
        </div>
    );
}

/**
 * An `ml.embed()` session, rendered as what it IS: a list of CALLS, not a conversation.
 *
 * Embeds report through the chat events, so the stored shape is turns with a "user" and an "assistant" side.
 * Drawn that way it reads as somebody asking a question and a model answering, which is not what happened —
 * a request for vectors is a call with inputs and a result. The same data, said accurately: what went in,
 * what came back, and how long it took.
 */
export function EmbedRunView({ s }: { s: Session }) {
    const done = s.turns.filter((t) => t.assistant || t.error);
    return (
        <div class="embed-run">
            <div class="set-note">
                <b>{s.model || "embedding model"}</b> — {s.turns.length} call{s.turns.length === 1 ? "" : "s"} to
                {" "}<code>ml.embed()</code>. Embedding turns text into vectors for search and retrieval; there is no
                conversation here, and the timings are wall clock (the endpoint reports no token counts).
            </div>
            {s.turns.map((t) => (
                <div class={`embed-call${t.error ? " err" : ""}`} key={t.id}>
                    <span class="embed-in">{t.user || "embed"}</span>
                    <span class="embed-arrow" aria-hidden="true">→</span>
                    <span class="embed-out">{t.error ? t.error : (t.assistant || <span class="dim">running…</span>)}</span>
                    <span class="sp" />
                    {t.usage?.genMs != null ? <span class="embed-ms">{Math.round(t.usage.genMs)}ms</span> : null}
                    <Stamp ts={t.ts} />
                </div>
            ))}
            {!done.length ? <div class="hint">No completed calls yet.</div> : null}
        </div>
    );
}

/** ONE CHAT TURN — your message, the reply, its thinking disclosure, sources and token usage. The chat
 *  counterpart to `ToolStep`: an `ml.chat()` session is a list of these. */
export function MessageTurn({ t, hash }: { t: Turn; hash?: string }) {
    return (
        <>
            <div class="msg user">
                <div class="mrow"><span class="who">user</span><span class="sp" /><Stamp ts={t.ts} /></div>
                <div class="utext">{t.user}</div>
                {t.images?.length ? <div class="thumbs">{t.images.map((src, i) => <ClickableImg key={i} src={src} />)}</div> : null}
            </div>
            {/* `anchorHash` is what the event lane scrolls to. A chat session gets a container bar and
                generation spans like any other, and clicking one used to navigate here and then find nothing
                to reach — the anchor was only set for agent answers, which is where `tokenRun` comes from. */}
            <ReplyBubble content={t.assistant || ""} status={t.status} model={t.model ?? null}
                profile={turnProfile(t)} ts={t.ts} reasoning={t.reasoning} sources={t.sources} anchorHash={hash}
                error={t.status === "err" ? (t.error || "(error)") : undefined} initialRaw={!!t.structured} />
        </>
    );
}

/** WHICH MODEL PROFILE answered — `default` or `utility`. A session run on `extend: "utility"` has a
 *  null client-side model, so without this the panel would show "default" for a reply the utility model
 *  actually produced. */
export const ProfileBadge = ({ profile }: { profile?: ExtendProfile | null }) =>
    profile !== null ? <span class="profile">{profile}</span> : null;

// Presentational — model/profile arrive as plain props (resolved in ListView).
// It must NOT read a signal itself: @preact/signals auto-memoizes a
// signal-reading child, which (with our in-place session mutation → unchanged
// `s` reference) would make it skip the parent re-render and freeze on pending.
export const AgentBadge = () => <span class="agent-badge">agent</span>;
/** An `ml.embed()` session. Without it the row fell back to the generic "session" tag, so the one kind of
 *  session that is NOT a conversation was the one the list refused to name — leaving you to work out from
 *  the title that "embed 24 inputs" was not something somebody typed. */
export const EmbedBadge = () => <span class="agent-badge embed-badge">embed</span>;

// The model name is intentionally NOT shown here — the list gets busy with tags,
// and the resolved model is one tap away in the detail header.
export function SessionRow({ s, profile }: { s: Session; profile: "utility" | "default" | null }) {
    // An EMBED session is named by what was INVOKED, not by a turn. Its turns are calls, and their text is
    // ours ("embed 24 inputs") — using one as the title presents a description we wrote as something the user
    // typed, which is the whole reason it read as a chat.
    const title = s.kind === "embed"
        ? `ml.embed() · ${s.turns.length} call${s.turns.length === 1 ? "" : "s"}`
        : (s.title || s.task || s.turns[0]?.user || "(no prompt)");
    return (
        <button class="row" onClick={() => (view.value = { name: "detail", hash: s.hash })}>
            <Dot status={s.status} />
            <Stamp ts={s.lastTs} snap="right" />
            {/* key flips fb→ai when the AI-summarised title lands, remounting the element so ml-reveal
                plays once (a plain text swap wouldn't animate). Only the AI title animates, not the fallback. */}
            <b class={`row-title${s.title ? " ml-reveal" : ""}`} key={s.title ? "t-ai" : "t-fb"}>{truncate(title, 80)}</b>
            <div class="row-meta">
                {s.kind === "agent" ? <AgentBadge /> : s.kind === "embed" ? <EmbedBadge /> : <TagBadge tag={s.tag} />}
                <ProfileBadge profile={profile} />
                <Hash hash={s.hash} stop />
            </div>
        </button>
    );
}
