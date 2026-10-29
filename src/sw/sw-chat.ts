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
 * nothing has to know which side ran the turn. The reply STREAMS while it is written, as throttled `chat-stream`
 * previews of the text so far (the chat counterpart of an agent run's `agent-stream`), which the result supersedes.
 *
 * And there is no DevTools panel to relay them to: a panel attaches to a tab, and this session has no tab. So this
 * is the one place an event reaches the index without also going through `relayDebugEvent`. That is not a second
 * feed of a session something else already reports (AGENTS.md's trap, which is about recording a run twice); it is
 * the only feed of a session nothing else can see.
 */
import { hintSession, shortHash, type AttachedFile, type AttachedPdf, type RequestHint, type SentFile } from "../contract/contract-run";
import { FilesRefused, b64Bytes, frameFiles, isPdfFile, textCapRefusal, type FramedFile } from "../attached-files";
import { ImagesRefused, namedNote, readerNote, type ImagePlan } from "../image-gate";
import { pageSections, planPages, wantsImage, type PageAim, type PageOutcome } from "../pdf/pdf-frame";
import type { PdfDoc } from "../pdf/pdf-read";
import type { PdfReadReply, PdfRenderReply } from "../pdf/pdf-wire";
import { type LlmResult, type NeutralMessage } from "../contract/contract-chat";
import { type StoredSession } from "../contract/contract-messages";
import { type MlDebugEvent } from "../contract/contract-debug";

/** Live background chats. Small on purpose: each holds a whole history, and the worker's memory is shared with
 *  every run. The oldest idle chat is dropped when a new one would exceed it; a SAVED chat is only dropped from
 *  memory and comes back from storage on its next turn. */
export const MAX_BG_CHATS = 32;
/** Images on one turn, matching what the page path accepts from the composer. */
export const MAX_TURN_IMAGES = 8;

/** How many pages of a message's PDFs the reader model may read, past which a scan is named as not sent: each is a
 *  model call the person waits for before the answer starts. A first figure. */
export const READER_PAGE_MAX = 32;
/** The scale a page is drawn at for a model or a reader: 144 dpi, legible small print on a letter page. */
export const PAGE_IMAGE_SCALE = 2;
/** What a chat says can get a page it held back: nothing yet (slice 3's `look` on a page is an agent run's). */
export const CHAT_PAGE_RECOVERY = "This chat cannot show them.";

/** The least time between two live `chat-stream` previews of one turn: the cadence an agent run streams at
 *  (`STREAM_EMIT_MS`, sw-run-host.ts), smooth enough to read and not a flood of events into the index. */
export const CHAT_STREAM_EMIT_MS = 90;

/** One model request of a background chat's turn. */
export interface ChatRequest { messages: NeutralMessage[]; model: string | null; think: boolean | null; hint: RequestHint }

/** What a background chat needs from the worker, injected so the module is testable without `chrome`. */
export interface ChatDeps {
    /** the session index (and nothing else: see the file's header) */
    emit(event: MlDebugEvent): void;
    /** one model call, aborted through its signal; `fetchLLM` in the worker */
    call(req: ChatRequest, signal: AbortSignal): Promise<LlmResult>;
    /** the same call STREAMED: `onDelta` gets each new piece of the reply or of its thinking as it arrives; `streamLLM`
     *  in the worker. Absent, a turn falls back to `call` and its answer lands whole. */
    stream?(req: ChatRequest, onDelta: (delta: { content?: string; reasoning?: string }) => void, signal: AbortSignal): Promise<LlmResult>;
    load(hash: string): Promise<StoredSession | null>;
    save(hash: string, session: StoredSession): Promise<void>;
    now(): number;
    /** where a message's images go for `model` (null: the default): to it, to a reader, named, or refused
     *  (image-gate.ts). `forced` is the person's `vision: true`. */
    images(model: string | null, forced: boolean): Promise<ImagePlan>;
    /** `reader`'s transcription of one image, for a model that does not see */
    read(image: string, reader: string, signal: AbortSignal): Promise<string>;
    /** the offscreen document's PDF reader (pdf-wire.ts): a PDF read page by page, and one page drawn as a PNG.
     *  Absent, a message with a PDF is refused. */
    pdf?: { read(b64: string): Promise<PdfReadReply>; render(b64: string, n: number, scale: number): Promise<PdfRenderReply> };
}

/** A message's files once its PDFs are read: a text file as sent, a PDF with its pages and what each page sends. */
type ReadFile = AttachedFile | { pdf: AttachedPdf; doc: PdfDoc; aims: PageAim[] };
/** What a turn needs decided before it starts: where its pasted images go, and its files read. */
interface Prepared { plan: ImagePlan; files?: ReadFile[] }

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
    files?: SentFile[];
    model?: string;
    system?: string;
    think?: boolean | null;
    ephemeral?: boolean;
    vision?: true;
}): Promise<string> {
    const d = need();
    const prep = await prepare(d, opts.model ?? null, opts.images, opts.files, opts.vision === true);
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
    void turn(chat, opts.text, opts.images, prep);
    return hash;
}

/** Switch a background chat's model from its next turn on, and write it where a resume reads it. False when this
 *  worker does not host the chat and storage cannot bring it back. */
export async function setBackgroundChatModel(hash: string, model: string): Promise<boolean> {
    const chat = chats.get(hash) ?? (await rehydrate(hash));
    if (!chat) return false;
    chat.model = model;
    if (chat.save) await persist(chat);
    return true;
}

/** The next turn of a background chat. `not-found` when this worker does not host it and storage cannot bring it
 *  back; `busy` while a turn is still running, since a chat has no inbox to steer into. Throws {@link ImagesRefused}
 *  before the turn when its images may not be sent (`vision: true` is the person's word that the model sees), and
 *  {@link FilesRefused} when a PDF cannot be read or its pages hold more text than a message takes. */
export async function sendBackgroundChat(hash: string, text: string, images?: string[], files?: SentFile[], vision?: true): Promise<"turn" | "busy" | "not-found"> {
    const chat = chats.get(hash) ?? (await rehydrate(hash));
    if (!chat) return "not-found";
    if (chat.running) return "busy";
    const prep = await prepare(need(), chat.model, images, files, vision === true);
    if (chat.running) return "busy";   // another send took the turn while the files were read
    void turn(chat, text, images, prep);
    return "turn";
}

/**
 * What a message sends, decided BEFORE a turn starts so a refusal reaches the command and nothing is sent: each PDF
 * read (offscreen, docs/dev/pdf.md), the text cap applied to what its pages hold, and where images go. Vision is
 * asked only when something would send an image: a pasted one, a scanned page, or a page with a figure.
 * @throws {FilesRefused} a PDF would not read, or the files hold more text than a message takes
 * @throws {ImagesRefused} an image would be sent, the model's vision is not known and no reader is set
 */
async function prepare(d: ChatDeps, model: string | null, images: string[] | undefined, files: SentFile[] | undefined, forced: boolean): Promise<Prepared> {
    const read: ReadFile[] = [];
    for (const f of files ?? []) {
        if (!isPdfFile(f)) { read.push(f); continue; }
        if (!d.pdf) throw new FilesRefused(`${f.name} is a PDF, which this runtime does not read`);
        const r = await d.pdf.read(f.data).catch(() => null);
        if (!r) throw new FilesRefused(`${f.name} could not be read: the PDF reader did not answer`);
        if (!r.ok) throw new FilesRefused(`${f.name}: ${r.refusal}`);
        read.push({ pdf: f, doc: r.doc, aims: [] });
    }
    const why = textCapRefusal(read.map((f) => "pdf" in f
        ? { name: f.pdf.name, chars: f.doc.pages.reduce((n, p) => n + p.text.length, 0) }
        : { name: f.name, chars: f.text.length }));
    if (why) throw new FilesRefused(why);
    const docs = read.flatMap((f) => ("pdf" in f ? [f.doc] : []));
    const kinds = docs.flatMap((doc) => doc.pages.map((p) => wantsImage(p.kind)));
    const scans = kinds.includes("scan");
    let plan: ImagePlan = { route: "model" };
    if (images?.length || scans || kinds.includes("figure")) {
        plan = await d.images(model, forced);
        if (plan.route === "refused") {
            if (images?.length || scans) throw new ImagesRefused(plan.message);
            // Only figures: a page with a figure still has its text, so it goes with a line naming the figure.
            plan = { route: "named" };
        }
    }
    if (docs.length) {
        const reader = plan.route === "reader" || plan.route === "model" ? plan.reader ?? null : null;
        // Pasted images come first, then the pages that need one, in page order (FILE_ATTACHMENTS.md).
        const room = MAX_TURN_IMAGES - Math.min(images?.length ?? 0, MAX_TURN_IMAGES);
        const aims = planPages(docs, plan.route, { images: room, reader: !!reader, readerMax: READER_PAGE_MAX });
        let i = 0;
        for (const f of read) if ("pdf" in f) f.aims = aims[i++];
    }
    return { plan, ...(read.length ? { files: read } : {}) };
}

/**
 * Draw the pages a PDF sends as images, and have the reader read the ones it reads, one after another; a page that
 * will not draw says why in its section. Stops at a cancel.
 */
async function drawPages(d: ChatDeps, f: { pdf: AttachedPdf; doc: PdfDoc; aims: PageAim[] }, reader: string | null, signal: AbortSignal): Promise<Map<number, PageOutcome>> {
    const out = new Map<number, PageOutcome>();
    for (let i = 0; i < f.doc.pages.length; i++) {
        const aim = f.aims[i];
        if (aim !== "image" && aim !== "reader") continue;
        if (signal.aborted) break;
        const n = f.doc.pages[i].n;
        const r = await d.pdf!.render(f.pdf.data, n, PAGE_IMAGE_SCALE).catch(() => null);
        if (!r?.ok) { out.set(n, { failed: r ? r.refusal : "the PDF reader did not answer" }); continue; }
        const image = `data:image/png;base64,${r.pngB64}`;
        if (aim === "image") { out.set(n, { image }); continue; }
        let text = "";
        try { text = reader ? await d.read(image, reader, signal) : ""; } catch { /* reader unavailable: the section says so */ }
        out.set(n, { read: text });
    }
    return out;
}

/**
 * One turn: the user's message, the model's answer, and the two events that say so.
 *
 * The events carry the same `id` for the start and its result, which is how the index closes the open turn. It is
 * derived from the hash and the turn number rather than drawn at random, so a turn that is somehow reported twice
 * is recognised as one turn rather than recorded as two.
 */
async function turn(chat: BgChat, text: string, images: string[] | undefined, prep: Prepared): Promise<void> {
    const { plan } = prep;
    const d = need();
    const id = `${chat.hash}-${++chat.turns}`;
    const session = { hash: chat.hash, turn: chat.turns };
    const controller = new AbortController();
    chat.running = controller;
    chat.lastTs = d.now();
    // Images go to the model only when it sees (or the person said it does); otherwise each is replaced by a note the
    // model reads, the reader's transcription or a line naming it as not sent (image-gate.ts).
    const shown = (images ?? []).slice(0, MAX_TURN_IMAGES);
    const pictures = plan.route === "model" ? [...shown] : [];
    const notes: string[] = [];
    if (plan.route === "reader") {
        for (let i = 0; i < shown.length; i++) {
            let read = "";
            try { read = await d.read(shown[i], plan.reader, controller.signal); } catch { /* reader unavailable: the note says so */ }
            notes.push(readerNote(i, shown.length, plan.reader, read));
        }
    } else if (plan.route === "named") {
        for (let i = 0; i < shown.length; i++) notes.push(namedNote(i, shown.length));
    }
    // A PDF's pages are drawn and read now, inside the turn the person is waiting on; their images follow the pasted
    // ones, numbered in the `<page image="…">` that carries each (pdf-frame.ts).
    const reader = plan.route === "reader" || plan.route === "model" ? plan.reader ?? null : null;
    const files: FramedFile[] = [];
    for (const f of prep.files ?? []) {
        if (!("pdf" in f)) { files.push(f); continue; }
        const outcomes = await drawPages(d, f, reader, controller.signal);
        const s = pageSections(f.doc, f.aims, outcomes, { firstImage: pictures.length + 1, reader, recovery: CHAT_PAGE_RECOVERY });
        pictures.push(...s.images);
        files.push({ name: f.pdf.name, type: f.pdf.type, bytes: b64Bytes(f.pdf.data), pages: f.doc.pageCount, body: s.body, escaped: s.escaped });
    }
    // Attached files are part of the message the model reads, as `<file>` blocks after the typed words; `display`
    // keeps the words and the files apart for the transcript (attached-files.ts).
    const framed = frameFiles(text, files);
    const content = notes.length ? (framed.text ? `${framed.text}\n\n${notes.join("\n\n")}` : notes.join("\n\n")) : framed.text;
    const user: NeutralMessage = { role: "user", content };
    const display = framed.display;
    if (pictures.length) user.images = pictures;
    const messages = [...chat.messages, user];

    const streaming = !!d.stream;
    d.emit({
        kind: "chat", id, ts: d.now(), save: chat.save, session, streaming, ...(display ? { display } : {}),
        config: { system: chat.system, model: chat.model, think: chat.think, schema: false, toolIds: null, maxTokens: null, save: chat.save },
        request: {
            model: chat.model, extend: null, messages, images: pictures.length ? pictures : null,
            toolIds: null, schema: false, think: chat.think, maxTokens: null,
        },
    });

    try {
        const req: ChatRequest = {
            messages,
            model: chat.model,
            think: chat.think,
            // "interactive": a person is waiting for this answer, which is what the hint means (contract.ts
            // RequestUse). An agent run says "agent"; a title or a summary says "utility".
            hint: { use: "interactive", session: hintSession(chat.hash) },
        };
        const result = d.stream ? await d.stream(req, preview(chat, id, session, controller.signal), controller.signal) : await d.call(req, controller.signal);
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

/**
 * The live preview of one streamed turn: accumulate what arrives, and emit it as a `chat-stream` at most every
 * {@link CHAT_STREAM_EMIT_MS}. Each event carries everything SO FAR, so the index can keep only the newest and a reader
 * that missed one is not behind. Leading edge only, with no trailing send: the turn's `chat-result` follows the last
 * piece and supersedes every preview. Nothing goes out once the turn is cancelled.
 */
function preview(chat: BgChat, id: string, session: { hash: string; turn: number }, signal: AbortSignal): (delta: { content?: string; reasoning?: string }) => void {
    const d = need();
    let content = "", reasoning = "", last = -Infinity;
    return (delta) => {
        if (delta.content) content += delta.content;
        if (delta.reasoning) reasoning += delta.reasoning;
        if (signal.aborted || (!content && !reasoning)) return;
        const now = d.now();
        if (now - last < CHAT_STREAM_EMIT_MS) return;
        last = now;
        chat.lastTs = now;
        d.emit({ kind: "chat-stream", id, ts: now, save: false, session, ...(content ? { content } : {}), ...(reasoning ? { reasoning } : {}) });
    };
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
