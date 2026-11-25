// One session's transcript, whatever its kind: an agent run, a chat, or an embed call. Shared by the extension's panel
// (app.tsx) and the chat page's core (src/chat/), which is why it lives outside app.tsx and reaches nothing but the
// session views and the store.
import { Fragment } from "preact";
import { AgentRunView, ThoughtBlock, ToolStep, TurnProse } from "./agent-detail";
import { EmbedRunView, OptionsBlock, MessageTurn } from "./reply";
import { sessionMap, type AgentStep } from "../store";
import { EarlierInThread, tail } from "./transcript-window";

/** A session's transcript by its key (`Session.hash`): the agent run view, the embed view, or a chat's turns. */
export function DetailView({ hash }: { hash: string }) {
    // Re-renders via App's rev subscription (App cascades to this pure component);
    // turn updates are immutable (see onDebug) so children re-render too.
    const s = sessionMap.get(hash);
    if (!s) return <div class="empty">Session not found.</div>;
    if (s.kind === "agent") return <AgentRunView s={s} />;
    // An EMBED session is not a conversation. It reports through the chat events — a model call is a model
    // call, and reusing the machinery costs no new event kind — but rendering it as user/assistant bubbles
    // presents a request for vectors as something somebody said, which is where the confusion starts.
    if (s.kind === "embed") return <EmbedRunView s={s} />;
    // Only the newest turns are drawn; the rest are held and one button away (transcript-window.tsx).
    const { drawn, hidden } = tail(s.turns, s.hash);
    return <>
        <OptionsBlock s={s} />
        <EarlierInThread sessionKey={s.hash} hidden={hidden} />
        {drawn.map(t => <MessageTurn key={t.id} t={t} hash={s.hash} between={<ChatToolSteps steps={(s.steps || []).filter(st => st.turn === t.id)} hash={s.hash} />} />)}
    </>;
}

/** A chat turn's tool calls (`read_pages`), drawn between the person's message and the answer with the agent run's own
 *  step rows, so the call and the exact result the model read are both one click away. */
function ChatToolSteps({ steps, hash }: { steps: AgentStep[]; hash: string }) {
    if (!steps.length) return null;
    return <div class="aturn chat-tools">
        {steps.map((st, i) => <Fragment key={st.seq ?? i}>
            {st.reasoning ? <ThoughtBlock thought={st.reasoning} /> : null}
            {st.thought ? <TurnProse text={st.thought} ts={st.ts} /> : null}
            <ToolStep st={st} hash={hash} slot={i} />
        </Fragment>)}
    </div>;
}
