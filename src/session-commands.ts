// THE LOCAL RUNTIME'S COMMANDS: what the chat page can do to this browser's sessions (docs/spec/SESSION_CONTRACT.md
// §Commands), each mapped onto a path the extension already has. Nothing here decides a gate, starts a loop or builds
// a request body of its own: an approval goes to the one `resolveApproval`, a steer into the running loop's inbox, a
// message to a page-hosted session through the page's own handler, a side call through `fetchLLM`.
//
// Pure over its dependencies (`CommandDeps`), which sw-sessions.ts and background.ts fill in with the real ones, so
// every command's decisions are tested in Node without a browser (tests/session-commands.test.mjs).
import type { NeutralMessage } from "./contract";
import type { Command, CommandError, CommandResult, CommandType, SessionId, TabInfo } from "./session-host";
import type { SessionIndex } from "./session-index";

/** What a page said it did with a relayed session action. `no-answer`: it did not reply in time. */
export type PageOutcome = "steer" | "turn" | "cancelled" | "continued" | "busy" | "none" | "no-answer";

/** Everything the commands reach outside themselves. */
export interface CommandDeps {
    runtime: string;
    index: SessionIndex;
    /** remove a session from the index and end its subscriptions */
    removeFromIndex(id: SessionId): void;
    /** http(s) tabs this browser has open */
    listTabs(): Promise<TabInfo[]>;
    /** one tab, or null when it is gone */
    getTab(tabId: number): Promise<TabInfo | null>;
    /** relay a session action to the page in a tab and wait for what it did; rejects when nothing listens there */
    toPage(tabId: number, action: "send" | "cancel" | "continue", body: { hash: string; text?: string; images?: string[]; elementContext?: unknown }): Promise<PageOutcome>;
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
        if (c.session.runtime !== deps.runtime || !deps.index.get(c.session.hash)) return { error: fail("not-found", "no such session on this browser") };
        return { id: c.session };
    };
    const ownRuntime = (c: { runtime?: unknown }): CommandResult<any> | null =>
        c.runtime === deps.runtime ? null : fail("not-found", "no such runtime here");
    /** The tab a session is bound to, or an error saying why there is none. */
    const tabOf = (hash: string): { tabId: number; error?: undefined } | { tabId?: undefined; error: CommandResult<any> } => {
        const b = deps.index.binding(hash);
        return b?.tabId != null ? { tabId: b.tabId } : { error: fail("unavailable", "the tab this session ran on is closed") };
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
        "tabs.list": async (c) => ownRuntime(c) ?? ok({ tabs: await deps.listTabs() }),

        // A chat with no page behind it, hosted by the worker (sw-chat.ts). It answers as soon as the first turn is
        // UNDER WAY rather than when it finishes, so the client subscribes and watches the answer arrive; a chat that
        // only existed once the model had replied would leave the person's own message nowhere for half a minute.
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
            if (deps.hostsChat(s.id.hash)) {
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
            if (deps.hostsChat(s.id.hash)) {
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
