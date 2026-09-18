/**
 * Chats the BACKGROUND hosts: a conversation with no page behind it, for the chat page's `chat.start`
 * (`docs/spec/SESSION_CONTRACT.md`).
 *
 * Every other session in the index belongs to a tab — a console `ml.chat`, a page script, a background-hosted agent
 * run delegating its tools back to the page it started on. A chat started from `chat.html` has none: the person
 * typed into an extension page, and closing that page must not end the conversation, because the phone will open
 * the same chat later through the hub.
 *
 * Two consequences shape this file.
 *
 * The transcript is emitted HERE, as the same `chat` / `chat-result` / `chat-error` events `injected.ts` emits for
 * a page chat, so the index, the chat page, the sidebar's session views and the exports all read one shape and
 * nothing has to know which side ran the turn.
 *
 * And there is no DevTools panel to relay them to: a panel attaches to a tab, and this session has no tab. So this
 * is the one place an event reaches the index without also going through `relayDebugEvent`. That is not a second
 * feed of a session something else already reports (AGENTS.md's trap, which is about recording a run twice); it is
 * the only feed of a session nothing else can see.
 */
import { hintSession, shortHash, type RequestHint } from "./contract";
import { type LlmResult, type NeutralMessage } from "./contract-chat";
import { type StoredSession } from "./contract-messages";
import { type MlDebugEvent } from "./contract-debug";

/** Live background chats. Small on purpose: each holds a whole history, and the worker's memory is shared with
 *  every run. The oldest idle chat is dropped when a new one would exceed it; a SAVED chat is only dropped from
 *  memory and comes back from storage on its next turn. */
export const MAX_BG_CHATS = 32;
/** Images on one turn, matching what the page path accepts from the composer. */
export const MAX_TURN_IMAGES = 8;

/** What a background chat needs from the worker, injected so the module is testable without `chrome`. */
export interface ChatDeps {
    /** the session index (and nothing else: see the file's header) */
    emit(event: MlDebugEvent): void;
    /** one model call, aborted through its signal; `fetchLLM` in the worker */
    call(req: { messages: NeutralMessage[]; model: string | null; think: boolean | null; hint: RequestHint }, signal: AbortSignal): Promise<LlmResult>;
    load(hash: string): Promise<StoredSession | null>;
    save(hash: string, session: StoredSession): Promise<void>;
    now(): number;
}

/** A chat this worker is hosting. */
interface BgChat {
    hash: string;
    messages: NeutralMessage[];
    model: string | null;
    think: boolean | null;
    system: string | null;
    /** false for an `ephemeral` chat: it is never written to storage and cannot be rehydrated */
    save: boolean;
    /** turns started, so a turn's id is stable and its `SessionRef.turn` counts up */
    turns: number;
    /** set while a turn is in flight; `cancel` aborts it */
    running: AbortController | null;
    lastTs: number;
}

let deps: ChatDeps | null = null;
const chats = new Map<string, BgChat>();

/** Install the worker's dependencies. Called once, from `sw-sessions.ts`. */
export function configureBackgroundChats(d: ChatDeps): void {
    deps = d;
}

/** Is this hash a chat this worker hosts? (A page's chat lives in its tab and is not one of these.) */
export function isBackgroundChat(hash: string): boolean {
    return chats.has(hash);
}

/** Drop a chat from memory, after `session.delete` has removed whatever it stored. */
export function forgetBackgroundChat(hash: string): void {
    const chat = chats.get(hash);
    chat?.running?.abort();
    chats.delete(hash);
}

/** Every background chat, for tests and `ml.__housekeeping()`. */
export function backgroundChats(): string[] {
    return [...chats.keys()];
}

/** Abort a turn in flight. `false` when this chat is not ours or was already idle. */
export function cancelBackgroundChat(hash: string): boolean {
    const chat = chats.get(hash);
    if (!chat?.running) return false;
    chat.running.abort();
    chat.running = null;
    return true;
}

/** Start a chat and run its first turn. Resolves with the session hash as soon as the turn is UNDER WAY, so a
 *  client can subscribe to the stream and watch the answer arrive, rather than waiting out the generation. */
export async function startBackgroundChat(opts: {
    text: string;
    images?: string[];
    model?: string;
    system?: string;
    think?: boolean | null;
    ephemeral?: boolean;
}): Promise<string> {
    const d = need();
    evict();
    const hash = mintHash();
    const chat: BgChat = {
        hash,
        messages: opts.system ? [{ role: "system", content: opts.system }] : [],
        model: opts.model ?? null,
        think: opts.think ?? null,
        system: opts.system ?? null,
        save: !opts.ephemeral,
        turns: 0,
        running: null,
        lastTs: d.now(),
    };
    chats.set(hash, chat);
    void turn(chat, opts.text, opts.images);
    return hash;
}

/** The next turn of a background chat. `not-found` when this worker does not host it and storage cannot bring it
 *  back; `busy` while a turn is still running, since a chat has no inbox to steer into. */
export async function sendBackgroundChat(hash: string, text: string, images?: string[]): Promise<"turn" | "busy" | "not-found"> {
    const chat = chats.get(hash) ?? (await rehydrate(hash));
    if (!chat) return "not-found";
    if (chat.running) return "busy";
    void turn(chat, text, images);
    return "turn";
}

/**
 * One turn: the user's message, the model's answer, and the two events that say so.
 *
 * The events carry the same `id` for the start and its result, which is how the index closes the open turn. It is
 * derived from the hash and the turn number rather than drawn at random, so a turn that is somehow reported twice
 * is recognised as one turn rather than recorded as two.
 */
async function turn(chat: BgChat, text: string, images?: string[]): Promise<void> {
    const d = need();
    const id = `${chat.hash}-${++chat.turns}`;
    const session = { hash: chat.hash, turn: chat.turns };
    const user: NeutralMessage = { role: "user", content: text };
    const pictures = (images ?? []).slice(0, MAX_TURN_IMAGES);
    if (pictures.length) user.images = pictures;
    const messages = [...chat.messages, user];
    const controller = new AbortController();
    chat.running = controller;
    chat.lastTs = d.now();

    d.emit({
        kind: "chat", id, ts: d.now(), save: chat.save, session, streaming: false,
        config: { system: chat.system, model: chat.model, think: chat.think, schema: false, toolIds: null, maxTokens: null, save: chat.save },
        request: {
            model: chat.model, extend: null, messages, images: pictures.length ? pictures : null,
            toolIds: null, schema: false, think: chat.think, maxTokens: null,
        },
    });

    try {
        const result = await d.call({
            messages,
            model: chat.model,
            think: chat.think,
            // "interactive": a person is waiting for this answer, which is what the hint means (contract.ts
            // RequestUse). An agent run says "agent"; a title or a summary says "utility".
            hint: { use: "interactive", session: hintSession(chat.hash) },
        }, controller.signal);
        // A cancel that landed while the fetch was resolving: the turn is over either way, and reporting a result
        // the person cancelled would put an answer in a transcript they stopped.
        if (controller.signal.aborted) throw new Error("cancelled");
        const answer: NeutralMessage = { role: "assistant", content: result.content };
        if (result.sources?.length) answer.sources = result.sources;
        chat.messages = [...messages, answer];
        chat.lastTs = d.now();
        if (chat.save) await persist(chat);
        d.emit({
            kind: "chat-result", id, ts: d.now(), save: chat.save, session, content: result.content,
            sources: result.sources?.length ? result.sources : null, structured: false,
            model: result.model ?? chat.model, extend: null, reasoning: result.reasoning ?? null,
            usage: result.usage ?? null,
        });
    } catch (err) {
        // The user's message is NOT kept on a failed turn: the model never saw it answered, and keeping it would
        // make the next turn re-send a question that was never asked properly. It is in the transcript as the
        // failed turn's own event, so nothing is lost to the reader.
        chat.lastTs = d.now();
        d.emit({ kind: "chat-error", id, ts: d.now(), save: chat.save, session, error: String((err as Error)?.message || err) });
    } finally {
        if (chat.running === controller) chat.running = null;
    }
}

/** Write the chat where `ml.resumeChat(hash)` and a later worker can find it: the same `ml_session_<hash>` record a
 *  page's `{ save: true }` chat writes, so a background chat is resumable from a page like any other. */
async function persist(chat: BgChat): Promise<void> {
    const d = need();
    try {
        await d.save(chat.hash, {
            hash: chat.hash, messages: chat.messages, model: chat.model, extend: null, numCtx: null, numGpu: null,
            think: chat.think, schema: null, toolIds: null, maxTokens: null, save: true,
        });
    } catch { /* storage full or unavailable: the turn still happened, and resume just will not have it */ }
}

/** Bring a saved chat back after the worker was evicted, so a chat the person left open all morning answers its
 *  next message instead of reporting that it no longer exists. */
async function rehydrate(hash: string): Promise<BgChat | null> {
    const d = need();
    let stored: StoredSession | null = null;
    try { stored = await d.load(hash); } catch { return null; }
    if (!stored || !Array.isArray(stored.messages)) return null;
    evict();
    const system = stored.messages[0]?.role === "system" ? stored.messages[0].content : null;
    const chat: BgChat = {
        hash, messages: stored.messages, model: stored.model ?? null, think: stored.think ?? null,
        system: typeof system === "string" ? system : null, save: true,
        // The turn counter restarts, so a rehydrated chat's turn ids would collide with the ones it emitted before
        // the eviction. The messages say how many turns there were; an assistant message per answered turn.
        turns: stored.messages.filter((m) => m.role === "assistant").length,
        running: null, lastTs: d.now(),
    };
    chats.set(hash, chat);
    return chat;
}

/** Keep the map under its cap by dropping the chat idle longest. A running turn is never dropped. */
function evict(): void {
    while (chats.size >= MAX_BG_CHATS) {
        let oldest: BgChat | null = null;
        for (const chat of chats.values()) if (!chat.running && (!oldest || chat.lastTs < oldest.lastTs)) oldest = chat;
        if (!oldest) return;   // every chat is mid-turn: let the map exceed its cap rather than abort someone's turn
        chats.delete(oldest.hash);
    }
}

/** A hash no live chat holds. Collisions are vanishingly unlikely at 4 bytes, and a collision would merge two
 *  people's conversations, so the one cheap check is worth making. */
function mintHash(): string {
    for (let i = 0; i < 8; i++) {
        const hash = shortHash();
        if (!chats.has(hash)) return hash;
    }
    return shortHash();
}

function need(): ChatDeps {
    if (!deps) throw new Error("background chats are not configured");
    return deps;
}
