// THE LOCAL RUNTIME'S COMMANDS: what the chat page can do to this browser's sessions (docs/spec/SESSION_CONTRACT.md
// §Commands), each mapped onto a path the extension already has. Nothing here decides a gate, starts a loop or builds
// a request body of its own: an approval goes to the one `resolveApproval`, a steer into the running loop's inbox, a
// message to a page-hosted session through the page's own handler, a side call through `fetchLLM`.
//
// Pure over its dependencies (`CommandDeps`), which sw-sessions.ts and background.ts fill in with the real ones, so
// every command's decisions are tested in Node without a browser (tests/session-commands.test.mjs).
import type { NeutralMessage } from "./contract-chat";
import type { MlDebugEvent } from "./contract-debug";
import type { SessionHistory } from "./session-store";
import type { Command, CommandError, CommandResult, CommandType, SessionId, TabInfo } from "./session-host";
import type { SessionIndex } from "./session-index";

/** What a page said it did with a relayed session action. `no-answer`: it did not reply in time. */
export type PageOutcome = "steer" | "turn" | "cancelled" | "continued" | "busy" | "none" | "no-answer";

/** Everything the commands reach outside themselves. */
export interface CommandDeps {
    /** what this runtime CALLS itself: the id every session id and answer is built with */
    runtime: string;
    /** Is this id this runtime, by any name it answers to? A runtime keeps answering to the id it had before it was
     *  paired, so a page open across that change, and a key kept on disk, do not become a runtime that never existed. */
    ownsRuntime?(id: unknown): boolean;
    index: SessionIndex;
    /** remove a session from the index and end its subscriptions */
    removeFromIndex(id: SessionId): void;
    /** what this runtime IS, for a client that reached it over a transport that cannot know */
    describe(): { kind: "browser" | "desktop" | "headless"; contractVersion: number; capabilities: unknown };
    /** http(s) tabs this browser has open */
    listTabs(): Promise<TabInfo[]>;
    /** one tab, or null when it is gone */
    getTab(tabId: number): Promise<TabInfo | null>;
    /** relay a session action to the page in a tab and wait for what it did; rejects when nothing listens there */
    toPage(tabId: number, action: "send" | "cancel" | "continue", body: { hash: string; text?: string; images?: string[]; elementContext?: unknown }): Promise<PageOutcome>;
    /** bring a tab and its window to the front; false when the tab is gone */
    focusTab(tabId: number, windowId?: number): Promise<boolean>;
    /** outline an element or point on a tab's page (fire and forget) */
    highlight(tabId: number, ref: { selector: string } | { token: string } | null): void;
    /** push a message into a RUNNING background loop's inbox and show it in the transcript; false when no loop runs */
    steer(hash: string, text: string): boolean;
    /** abort a background-hosted run and close its open gates; false when none was live */
    cancelRun(hash: string): boolean;
    /** resolve one open approval gate; false when it was already closed */
    resolveApproval(key: string, decision: { approved: true; persist?: boolean } | { approved: false; feedback?: string }): boolean;
    /** forget what the worker keeps for a finished session: its stored chat history, its resumable snapshot */
    forgetStored(hash: string): Promise<void>;
    /** start a chat this worker hosts (no tab), resolving with its hash once the first turn is under way */
    startChat(opts: { text: string; images?: string[]; model?: string; system?: string; think?: boolean | null; ephemeral?: boolean }): Promise<string>;
    /** the next turn of a worker-hosted chat; `not-found` when this worker does not host it and storage has nothing */
    sendChat(hash: string, text: string, images?: string[]): Promise<"turn" | "busy" | "not-found">;
    /** abort a worker-hosted chat's turn; false when it was idle or is not ours */
    cancelChat(hash: string): boolean;
    /** does this worker host this chat itself, rather than a tab? */
    hostsChat(hash: string): boolean;
    /** keep this session past the worker's life: what an absent `ephemeral` means on the command that started it */
    keepSession(hash: string): void;
    /** every event this runtime still holds for a session, oldest first; empty when it holds none */
    storedEvents?(hash: string): Promise<MlDebugEvent[]>;
    /** what a saved session would be CONTINUED from, or null when this browser keeps no history for it */
    history(hash: string): Promise<SessionHistory | null>;
    /**
     * Hand a saved run back to a page: put it where a resume looks for it, and have the page rebuild its toolset.
     * `"adopted"` when that page now holds it.
     */
    adoptSession(tabId: number, hash: string, history: SessionHistory): Promise<PageOutcome | "adopted">;
    /** note in the session's own transcript that it has been picked up on another page */
    noteResumed(hash: string, tabId: number, note: { id: string; url: string; fromUrl?: string; afterMs: number; dropped: string[] }): void;
    /** start a run on a tab, through that page's own start path; resolves with what the page reported */
    startAgent(tabId: number, opts: { task: string; images?: string[]; model?: string; maxSteps?: number; vision?: true; stream?: true }): Promise<{ outcome: PageOutcome | "started"; hash?: string }>;
    /** open a new tab at a URL and wait until the extension can talk to it; rejects when it never answers */
    openTab(url: string): Promise<number>;
    /** the page a blank agent target opens when the command names no URL ("" when unset) */
    startPage(): string;
    /** is a utility model configured (a side call would otherwise run on the main model) */
    utilityConfigured(): boolean;
    /** a small model call on the utility profile */
    sideCall(req: { messages: NeutralMessage[]; schema?: object; maxTokens: number; session?: string }): Promise<{ content: string; usage?: unknown }>;
    /** capture a window's visible tab as a data URL */
    captureVisible(windowId: number, opts: { format: "png" | "jpeg"; quality?: number }): Promise<string>;
    now(): number;
}

/** A side call's token ceiling, whatever the client asks for: glosses and titles are short. */
export const SIDE_CALL_MAX_TOKENS = 1024;
/** A screenshot's size ceiling, whatever the client asks for. */
export const SCREENSHOT_MAX_BYTES = 4 * 1024 * 1024;
/** Mid-run steers carry text only (the loop's inbox has no image slot); images go with a new turn. */
const STEER_TEXT_MAX = 20_000;
/** One message's text, on a chat this worker hosts. Long enough for a pasted document, short of a denial of service. */
const CHAT_TEXT_MAX = 100_000;
/**
 * What a resumed session LOSES, in words a person and a model both read. Never empty: something is always dropped,
 * because the new page is a different document.
 *
 * It is a list rather than prose so the model's transcript and the log's divider cannot disagree about it, and it
 * lives beside the command because the command is what causes the loss.
 */
export const RESUME_DROPS = [
    "live references to elements on the old page",
    "the page's state object",
    "cached fetches",
    "tools a page script defined (functions cannot be stored)",
    "approval grants (consent is per page, and is asked again)",
] as const;

/** How many events one backfill page carries, whatever a client asks for. A page holds screenshots, so this is a
 *  size decision wearing a count: forty events of a DOM run is nothing and forty screenshots is tens of megabytes,
 *  which is why a client pages rather than asking for a session. */
const BACKFILL_PAGE = 40;

/** A system prompt set at `chat.start`. */
const CHAT_SYSTEM_MAX = 20_000;

const fail = (code: CommandError["code"], message: string): CommandResult<any> => ({ ok: false, error: { code, message } });
const ok = <T extends CommandType>(data: any): CommandResult<T> => ({ ok: true, data });

const isSessionId = (v: unknown): v is SessionId => !!v && typeof (v as SessionId).runtime === "string" && typeof (v as SessionId).hash === "string";

/** The command handler for one runtime. */
export function createCommandHandler(deps: CommandDeps): (command: Command) => Promise<CommandResult<CommandType>> {
    /** The session a command names, when it is this runtime's and the index holds it. */
    const session = (c: { session?: unknown }): { id: SessionId; error?: undefined } | { id?: undefined; error: CommandResult<any> } => {
        if (!isSessionId(c.session)) return { error: fail("invalid", "a session id is required") };
        if (!ours(c.session.runtime) || !deps.index.get(c.session.hash)) return { error: fail("not-found", "no such session on this browser") };
        return { id: c.session };
    };
    /** Is this command addressed to us? By the id we report, or by one we still answer to. */
    const ours = (id: unknown): boolean => (deps.ownsRuntime ? deps.ownsRuntime(id) : id === deps.runtime);
    const ownRuntime = (c: { runtime?: unknown }): CommandResult<any> | null =>
        ours(c.runtime) ? null : fail("not-found", "no such runtime here");
    /** The tab a session is bound to, or an error saying why there is none. */
    const tabOf = (hash: string): { tabId: number; error?: undefined } | { tabId?: undefined; error: CommandResult<any> } => {
        const b = deps.index.binding(hash);
        return b?.tabId != null ? { tabId: b.tabId } : { error: fail("unavailable", "the tab this session ran on is closed") };
    };
    /**
     * Is this session a chat with no page behind it, and therefore this worker's to answer?
     *
     * `hostsChat` reads the worker's MEMORY, which an MV3 eviction empties. A saved chat that survives one is still
     * pageless, and routing on memory sent its next message down the run paths, which end at a tab it never had: the
     * person was told the tab this session ran on is closed, about a session that never had a tab. The index knows
     * what it is, and `sendChat` rehydrates from storage, so the KIND is what decides and memory is only the fast
     * path.
     */
    const pagelessChat = (hash: string): boolean => {
        if (deps.hostsChat(hash)) return true;
        const summary = deps.index.get(hash);
        return !!summary && summary.kind === "chat" && !summary.page;
    };

    /**
     * The tab an `AgentTarget` names: one that is open, or a new one at a url. Shared by `agent.start` and
     * `session.resume`, which ask the same question — resuming on another page IS a navigation, so it picks a target
     * the way starting does.
     */
    const resolveTarget = async (target: { kind?: unknown; tabId?: unknown; url?: unknown } | undefined): Promise<{ tabId: number; url: string; error?: undefined } | { tabId?: undefined; url?: undefined; error: CommandResult<any> }> => {
        if (target?.kind === "tab") {
            if (typeof target.tabId !== "number") return { error: fail("invalid", "a tab target needs a tab id") };
            const tab = await deps.getTab(target.tabId);
            if (!tab) return { error: fail("not-found", "no such tab") };
            // The extension's content script does not run on the browser's own pages, so a run there could
            // never see anything. Refused here rather than started and left waiting for a page that cannot answer.
            if (!/^https?:/i.test(tab.url)) return { error: fail("forbidden", "the extension cannot run on that page") };
            return { tabId: target.tabId, url: tab.url };
        }
        if (target?.kind === "blank") {
            const url = (typeof target.url === "string" && target.url.trim()) || deps.startPage();
            if (!url) return { error: fail("invalid", "a blank target needs a url, or a start page set in this browser's settings") };
            if (!/^https?:\/\//i.test(url)) return { error: fail("invalid", "a start page must be an http(s) url") };
            // The url is carried back rather than read off the tab afterwards: a tab this call just opened may not
            // be reportable yet, and the page a resume landed on is the one that was asked for either way.
            try { return { tabId: await deps.openTab(url), url }; }
            catch (err) { return { error: fail("failed", `could not open a tab at ${url}: ${(err as Error)?.message || err}`) }; }
        }
        if (target?.kind === "headless") return { error: fail("unsupported", "this browser has no headless runtime") };
        return { error: fail("invalid", "a run needs a target: a tab, or a blank tab") };
    };

    /** Relay to the session's page; a page with nothing listening, or no answer, is unavailable. */
    const viaPage = async (hash: string, action: "send" | "cancel" | "continue", body: { text?: string; images?: string[]; elementContext?: unknown } = {}): Promise<PageOutcome | CommandResult<any>> => {
        const t = tabOf(hash);
        if (t.error) return t.error;
        try {
            const outcome = await deps.toPage(t.tabId, action, { hash, ...body });
            if (outcome === "no-answer") return fail("unavailable", "the page this session runs on did not answer; it may still be loading");
            return outcome;
        } catch {
            return fail("unavailable", "the page this session ran on is not reachable (reloaded, or the extension cannot run there)");
        }
    };

    const handlers: { [T in CommandType]?: (c: Extract<Command, { type: T }>) => Promise<CommandResult<T>> } = {
        /**
         * A page of a session's events, for a client whose subscription came back `truncated`.
         *
         * Locally this is never needed — the index serves a subscription from its ring and the store in-process —
         * so it exists for a client on the other side of a relay, whose ring is short and whose session may be from
         * last Tuesday. Answering it here anyway is what keeps the two paths honest: a local client can exercise
         * the same command a phone will.
         */
        "session.backfill": async (c) => {
            const s = session(c);
            if (s.error) return s.error;
            if (!deps.storedEvents) return fail("unsupported", "this browser keeps no history to page through");
            const limit = c.limit == null ? BACKFILL_PAGE : Math.min(Math.max(1, Math.floor(c.limit)), BACKFILL_PAGE);
            if (c.before != null && (!Number.isInteger(c.before) || c.before < 0)) return fail("invalid", "before must be a position in this session's history");
            // A session this runtime does not KEEP has no durable history: the only copy was the ring, which the
            // subscription already served, and what fell out of it is gone. Saying so is the whole point of
            // `truncated` — a client that got an empty page would otherwise wait for a page that is never coming.
            const kept = !!deps.index.get(s.id.hash)?.saved;
            const all = kept ? await deps.storedEvents(s.id.hash) : [];
            // A position past the end is not an error: a client that asked before the runtime had written its
            // newest events would otherwise be refused for being early rather than given the page it asked for.
            const end = c.before == null ? all.length : Math.min(c.before, all.length);
            const from = Math.max(0, end - limit);
            return ok({
                session: s.id,
                epoch: deps.index.epochOf(s.id.hash),
                events: all.slice(from, end),
                from,
                // `more` says another page exists BELOW this one. `truncated` says one does not and never will,
                // which is a different sentence and the one a reader has to be told.
                more: from > 0,
                truncated: from === 0 && !kept,
            });
        },

        // What a transport cannot answer. A hub carries identity and liveness and deliberately nothing else, so a
        // client that reached this runtime over one asks the runtime itself — over the same authenticated channel as
        // every other command, which is what makes the answer worth anything.
        "runtime.info": async (c) => ownRuntime(c) ?? ok({ ...deps.describe(), nowMs: deps.now() }),

        "tabs.list": async (c) => ownRuntime(c) ?? ok({ tabs: await deps.listTabs() }),

        // A chat with no page behind it, hosted by the worker (sw-chat.ts). It answers as soon as the first turn is
        // UNDER WAY rather than when it finishes, so the client subscribes and watches the answer arrive; a chat that
        // only existed once the model had replied would leave the person's own message nowhere for half a minute.
        // A run on a tab. It goes through the page's own start path (the one the HUD composer uses), so a run
        // started from the chat page is a genuine session of that tab, built by the page's toolset, rather than a
        // second way of starting a run that would drift from the first.
        "agent.start": async (c) => {
            const bad = ownRuntime(c);
            if (bad) return bad;
            if (c.lineage) return fail("unsupported", "this browser does not start subagents yet");
            const task = typeof c.task === "string" ? c.task : "";
            const images = Array.isArray(c.images) ? c.images.filter((i): i is string => typeof i === "string" && i.startsWith("data:image/")) : [];
            if (!task.trim() && !images.length) return fail("invalid", "a run needs a task or an image");
            if (task.length > CHAT_TEXT_MAX) return fail("invalid", "that task is too long");
            if (c.maxSteps != null && (!Number.isInteger(c.maxSteps) || c.maxSteps <= 0)) return fail("invalid", "maxSteps must be a positive whole number");
            const t = await resolveTarget(c.target as { kind?: unknown; tabId?: unknown; url?: unknown } | undefined);
            if (t.error) return t.error;
            const tabId = t.tabId;

            const r = await deps.startAgent(tabId, {
                task, ...(images.length ? { images } : {}),
                ...(c.model ? { model: c.model } : {}),
                ...(c.maxSteps != null ? { maxSteps: c.maxSteps } : {}),
                ...(c.vision === true ? { vision: true as const } : {}),
                ...(c.stream === true ? { stream: true as const } : {}),
            });
            if (r.outcome === "started" && r.hash) {
                if (!c.ephemeral) deps.keepSession(r.hash);
                return ok({ session: { runtime: deps.runtime, hash: r.hash } });
            }
            // The page answered that it started nothing, or never answered at all. A run that started anyway would
            // still appear in the index, so this says what is known rather than inventing a session id.
            if (r.outcome === "none") return fail("failed", "the page did not start a run");
            return fail("unavailable", "the page did not answer; it may still be loading, or the extension cannot run there");
        },

        /**
         * Pick a saved session up on another page. From the agent's side this is a NAVIGATION — everything in its
         * context describes the page it last ran on — so it names a target the way `agent.start` does and the model
         * is told, in its own transcript, what no longer holds.
         *
         * It does not take a turn. Resuming makes the session live on that page; the person's next `session.send`
         * is the turn, which is also why a resume of something already running is a conflict rather than a no-op.
         */
        "session.resume": async (c) => {
            const s = session(c);
            if (s.error) return s.error;
            const summary = deps.index.get(s.id.hash)!;
            // A chat with no page is already this worker's, wherever it is: its next message rehydrates it. Giving
            // it a tab would not make it more resumable, it would give it a page it does not use.
            if (pagelessChat(s.id.hash)) return fail("unsupported", "a chat with no page resumes on its next message; it needs no tab");
            if (summary.status === "running" || summary.status === "waiting") return fail("conflict", "that session is still going; it does not need resuming");
            if (!summary.saved) return fail("not-found", "that session was not saved, so there is nothing to continue from");
            const history = await deps.history(s.id.hash);
            if (!history) return fail("not-found", "this browser kept no history for that session");
            if (history.kind !== "agent") return fail("unsupported", "only a run resumes onto a page");
            if (!history.payload) return fail("not-found", "that session was saved before this browser kept enough to continue a run");

            const t = await resolveTarget(c.target as { kind?: unknown; tabId?: unknown; url?: unknown } | undefined);
            if (t.error) return t.error;

            let outcome: PageOutcome | "adopted";
            try { outcome = await deps.adoptSession(t.tabId, s.id.hash, history); }
            catch { return fail("unavailable", "that page is not reachable; the extension may not run there"); }
            if (outcome !== "adopted") {
                if (outcome === "no-answer") return fail("unavailable", "that page did not answer; it may still be loading");
                return fail("failed", "that page did not take the session");
            }
            // Only once the page holds it: a note about a resume that did not happen would be a lie in the one
            // place a reader and the model both trust.
            const at = deps.now();
            deps.noteResumed(s.id.hash, t.tabId, {
                // ONE resume, not one session: the index de-duplicates a note by its id, because two surfaces can
                // report the same resume, and a session resumed twice would otherwise show one divider for both.
                id: `${s.id.hash}-r${at}`,
                url: t.url,
                ...(summary.page?.url ? { fromUrl: summary.page.url } : {}),
                afterMs: Math.max(0, at - summary.lastTs),
                dropped: [...RESUME_DROPS],
            });
            return ok({ session: s.id });
        },

        "chat.start": async (c) => {
            const bad = ownRuntime(c);
            if (bad) return bad;
            const text = typeof c.text === "string" ? c.text : "";
            const images = Array.isArray(c.images) ? c.images.filter((i): i is string => typeof i === "string" && i.startsWith("data:image/")) : [];
            if (!text.trim() && !images.length) return fail("invalid", "a chat needs a message or an image");
            if (text.length > CHAT_TEXT_MAX) return fail("invalid", "that message is too long");
            if (c.system != null && typeof c.system !== "string") return fail("invalid", "a system prompt must be text");
            if (typeof c.system === "string" && c.system.length > CHAT_SYSTEM_MAX) return fail("invalid", "that system prompt is too long");
            if (c.model != null && typeof c.model !== "string") return fail("invalid", "a model must be named as text");
            if (c.think != null && typeof c.think !== "boolean") return fail("invalid", "think must be true, false or absent");
            try {
                const hash = await deps.startChat({
                    text, ...(images.length ? { images } : {}),
                    ...(c.model ? { model: c.model } : {}),
                    ...(typeof c.system === "string" && c.system ? { system: c.system } : {}),
                    ...(c.think != null ? { think: c.think } : {}),
                    ...(c.ephemeral ? { ephemeral: true } : {}),
                });
                // "Sessions started by a command are saved unless `ephemeral`" (SESSION_CONTRACT.md §Commands).
                if (!c.ephemeral) deps.keepSession(hash);
                return ok({ session: { runtime: deps.runtime, hash } });
            } catch (err) {
                return fail("failed", (err as Error)?.message || String(err));
            }
        },

        "session.send": async (c) => {
            const s = session(c);
            if (s.error) return s.error;
            const text = typeof c.text === "string" ? c.text : "";
            const images = Array.isArray(c.images) ? c.images.filter((i): i is string => typeof i === "string" && i.startsWith("data:image/")) : [];
            if (!text.trim() && !images.length && !c.elementContext) return fail("invalid", "a message needs text, an image or an element");
            // A chat this worker hosts has no tab to relay to, and no loop to steer: the message is simply its next
            // turn. Checked BEFORE the run paths, which both end at a tab this session does not have.
            if (pagelessChat(s.id.hash)) {
                if (text.length > CHAT_TEXT_MAX) return fail("invalid", "that message is too long");
                const outcome = await deps.sendChat(s.id.hash, text, images);
                if (outcome === "turn") return ok({ mode: "turn" });
                if (outcome === "busy") return fail("conflict", "the chat is still answering the last message");
                return fail("not-found", "this browser no longer holds that chat");
            }
            const status = deps.index.get(s.id.hash)!.status;
            const running = status === "running" || status === "waiting";
            // A background loop that is running takes the steer directly: the page's handle may be gone (the run
            // navigated), and the inbox is the same one the handle's `say` reaches.
            if (running && !images.length && !c.elementContext) {
                if (text.length > STEER_TEXT_MAX) return fail("invalid", "that message is too long to steer with");
                if (deps.steer(s.id.hash, text)) return ok({ mode: "steer" });
            }
            const r = await viaPage(s.id.hash, "send", { text, ...(images.length ? { images } : {}), ...(c.elementContext ? { elementContext: c.elementContext } : {}) });
            if (typeof r !== "string") return r;
            if (r === "steer" || r === "turn") return ok({ mode: r });
            return fail("not-found", "the page no longer holds this session (it was reloaded, or the session was never resumable)");
        },

        "session.cancel": async (c) => {
            const s = session(c);
            if (s.error) return s.error;
            // Same routing as `session.send`: a pageless chat is this worker's, and one it has forgotten has no turn
            // in flight to cancel. Falling through would ask a tab it never had.
            if (pagelessChat(s.id.hash)) {
                if (deps.cancelChat(s.id.hash)) return ok({});
                return fail("conflict", "the session is not running");
            }
            if (deps.cancelRun(s.id.hash)) return ok({});
            const status = deps.index.get(s.id.hash)!.status;
            if (status !== "running" && status !== "waiting") return fail("conflict", "the session is not running");
            const r = await viaPage(s.id.hash, "cancel");
            if (typeof r !== "string") return r;
            return r === "cancelled" ? ok({}) : fail("not-found", "the page no longer holds this run");
        },

        "session.continue": async (c) => {
            const s = session(c);
            if (s.error) return s.error;
            if (deps.index.get(s.id.hash)!.status !== "capped") return fail("conflict", "only a run that stopped at its step limit can be continued");
            const r = await viaPage(s.id.hash, "continue");
            if (typeof r !== "string") return r;
            if (r === "continued") return ok({});
            if (r === "busy") return fail("conflict", "the run is already going again");
            return fail("not-found", "the page no longer holds this run (reloaded or navigated away)");
        },

        "session.delete": async (c) => {
            const s = session(c);
            if (s.error) return s.error;
            const status = deps.index.get(s.id.hash)!.status;
            if (status === "running" || status === "waiting") return fail("conflict", "stop the session before deleting it");
            await deps.forgetStored(s.id.hash);
            deps.removeFromIndex(s.id);
            return ok({});
        },

        "approval.answer": async (c) => {
            const s = session(c);
            if (s.error) return s.error;
            if (!Number.isInteger(c.seq) || (c.decision !== "approve" && c.decision !== "deny")) return fail("invalid", "an answer needs the step's seq and approve or deny");
            const decision = c.decision === "approve"
                ? { approved: true as const, ...(c.persist ? { persist: true } : {}) }
                : { approved: false as const, ...(typeof c.feedback === "string" && c.feedback ? { feedback: c.feedback.slice(0, 2000) } : {}) };
            return ok({ resolved: deps.resolveApproval(`${s.id.hash}:${c.seq}`, decision) });
        },

        "page.highlight": async (c) => {
            const s = session(c);
            if (s.error) return s.error;
            const ref = c.ref;
            const valid = ref === null
                || (typeof ref === "object" && ref != null && (typeof (ref as { selector?: unknown }).selector === "string" || typeof (ref as { token?: unknown }).token === "string"));
            if (!valid) return fail("invalid", "a highlight needs a selector, a token or null");
            const t = tabOf(s.id.hash);
            if (t.error) return t.error;
            deps.highlight(t.tabId, ref);
            return ok({});
        },

        "side.call": async (c) => {
            const bad = ownRuntime(c);
            if (bad) return bad;
            if (!["title", "summary", "explain"].includes(c.purpose)) return fail("invalid", "unknown side-call purpose");
            if (!Array.isArray(c.messages) || !c.messages.length || !c.messages.every(validMessage)) return fail("invalid", "messages must be system, user or assistant text");
            if (!Number.isFinite(c.maxTokens) || c.maxTokens <= 0) return fail("invalid", "maxTokens must be positive");
            if (c.schema != null && typeof c.schema !== "object") return fail("invalid", "schema must be an object");
            if (!deps.utilityConfigured()) return fail("unsupported", "no utility model is set on this browser");
            const sessionHash = isSessionId(c.session) && c.session.runtime === deps.runtime ? c.session.hash : undefined;
            try {
                const r = await deps.sideCall({ messages: c.messages, ...(c.schema ? { schema: c.schema } : {}), maxTokens: Math.min(Math.floor(c.maxTokens), SIDE_CALL_MAX_TOKENS), ...(sessionHash ? { session: sessionHash } : {}) });
                let structured: unknown;
                if (c.schema) { try { structured = JSON.parse(r.content); } catch { /* the content is still returned */ } }
                return ok({ content: r.content, ...(structured !== undefined ? { structured } : {}), usage: r.usage ?? null });
            } catch (err) {
                return fail("failed", (err as Error)?.message || String(err));
            }
        },

        // What a person at the machine is LOOKING AT, so `drive` rather than `view`. Only a tab `tabs.list` would
        // have shown: a client can only have guessed any other id, and `forbidden` would confirm the tab exists.
        "tab.focus": async (c) => {
            const bad = ownRuntime(c);
            if (bad) return bad;
            if (typeof c.tabId !== "number" || !Number.isInteger(c.tabId)) return fail("invalid", "a tab id is a whole number");
            const tab = await deps.getTab(c.tabId);
            if (!tab || !/^https?:/i.test(tab.url)) return fail("not-found", "no such tab");
            return (await deps.focusTab(c.tabId, tab.windowId)) ? ok({}) : fail("not-found", "that tab has closed");
        },

        "tab.screenshot": async (c) => {
            const bad = ownRuntime(c);
            if (bad) return bad;
            let tabId: number;
            const target = c.target as { tabId?: unknown; session?: unknown } | undefined;
            if (target && typeof target.tabId === "number") tabId = target.tabId;
            else if (target && target.session !== undefined) {
                const s = session({ session: target.session });
                if (s.error) return s.error;
                const t = tabOf(s.id.hash);
                if (t.error) return t.error;
                tabId = t.tabId;
            } else return fail("invalid", "a screenshot needs a tab or a session");
            const tab = await deps.getTab(tabId);
            if (!tab) return fail("not-found", "no such tab");
            // The browser can capture only what a window shows. Attaching the debugger to capture a background tab
            // would put a banner on someone's screen for a remote look, so that is not done on the quiet.
            if (!tab.active || tab.windowId == null) return fail("conflict", "that tab is not in front in its window, so it cannot be captured");
            const ceiling = Math.min(Number.isFinite(c.maxBytes) && (c.maxBytes as number) > 0 ? (c.maxBytes as number) : SCREENSHOT_MAX_BYTES, SCREENSHOT_MAX_BYTES);
            const attempts: { format: "png" | "jpeg"; quality?: number }[] = [{ format: "png" }, { format: "jpeg", quality: 80 }, { format: "jpeg", quality: 60 }, { format: "jpeg", quality: 40 }];
            for (const a of attempts) {
                let image: string;
                try { image = await deps.captureVisible(tab.windowId, a); }
                catch (err) { return fail("failed", (err as Error)?.message || String(err)); }
                if (dataUrlBytes(image) > ceiling) continue;
                const size = imageSize(image);
                if (!size) return fail("failed", "the capture was not a readable image");
                return ok({ image, width: size.width, height: size.height, ts: deps.now() });
            }
            return fail("failed", `the screenshot does not fit in ${ceiling} bytes`);
        },
    };

    return async (command) => {
        const h = handlers[command.type] as ((c: Command) => Promise<CommandResult<CommandType>>) | undefined;
        if (!h) return fail("unsupported", `${command.type} is not available on this browser yet`);
        return h(command);
    };
}

function validMessage(m: unknown): boolean {
    const msg = m as { role?: unknown; content?: unknown };
    return !!msg && (msg.role === "system" || msg.role === "user" || msg.role === "assistant") && typeof msg.content === "string";
}

/** The decoded size of a base64 data URL. */
export function dataUrlBytes(dataUrl: string): number {
    const i = dataUrl.indexOf(",");
    const b64 = i >= 0 ? dataUrl.slice(i + 1) : dataUrl;
    const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
    return Math.floor((b64.length * 3) / 4) - pad;
}

/** A PNG's or JPEG's pixel size, read from its header bytes; null for anything else. */
export function imageSize(dataUrl: string): { width: number; height: number } | null {
    const m = /^data:image\/(png|jpeg);base64,/.exec(dataUrl);
    if (!m) return null;
    let bytes: Uint8Array;
    try {
        const bin = atob(dataUrl.slice(m[0].length, m[0].length + 256 * 1024));   // a JPEG's frame header can sit behind large EXIF blocks
        bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
    } catch { return null; }
    const u16 = (i: number): number => (bytes[i] << 8) | bytes[i + 1];
    if (m[1] === "png") {
        if (bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50) return null;
        const u32 = (i: number): number => ((bytes[i] << 24) >>> 0) + (bytes[i + 1] << 16) + (bytes[i + 2] << 8) + bytes[i + 3];
        return { width: u32(16), height: u32(20) };
    }
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
    let i = 2;
    while (i + 9 < bytes.length) {
        if (bytes[i] !== 0xff) return null;
        const marker = bytes[i + 1];
        // SOF0–SOF15 carry the frame size, except DHT (C4), JPG (C8) and DAC (CC).
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
            return { height: u16(i + 5), width: u16(i + 7) };
        }
        i += 2 + u16(i + 2);
    }
    return null;
}
