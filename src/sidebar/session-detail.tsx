// One session's transcript, whatever its kind: an agent run, a chat, or an embed call. Shared by the extension's panel
// (app.tsx) and the chat page's core (src/chat/), which is why it lives outside app.tsx and reaches nothing but the
// session views and the store.
import { AgentRunView } from "./agent-detail";
import { EmbedRunView, OptionsBlock, MessageTurn } from "./reply";
import { sessionMap } from "./store";

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
    return <><OptionsBlock s={s} />{s.turns.map(t => <MessageTurn key={t.id} t={t} hash={s.hash} />)}</>;
}
