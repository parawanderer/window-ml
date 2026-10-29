// attached-files.ts — a file attached to a message: what counts as text, how much one message may carry, the
// `<file>` block the model reads, and the words a refusal uses (docs/spec/FILE_ATTACHMENTS.md, slice 1). A PDF is
// carried as its bytes and read by the runtime; its `<page>` sections come from pdf-frame.ts and are wrapped here.
//
// Pure, with no `chrome` and no DOM: the composer (to refuse a file before sending), the runtime's command check (the
// rule), the chat host and the agent's prompt framing (to build the message) all import this one copy.

import type { AttachedFile, AttachedFileInfo, AttachedPdf, ElementContext, PromptContext, PromptDisplay, SentFile } from "./contract/contract-run";
import { b64ToBytes, bytesToB64 } from "./pdf/pdf-wire";

/**
 * The most text one message may carry in files, counted in CHARACTERS of decoded text across all of its files.
 * A first figure (about 8k tokens of ordinary prose or code), to revisit against docs/spec/PROMPT_BUDGET.md and a
 * model's context window: it is deliberately one constant, so changing it changes the client's check and the
 * runtime's rule together.
 */
export const FILE_INLINE_MAX = 32_000;
/** How many files one message may carry. */
export const FILES_MAX_COUNT = 10;
/** The longest file name kept, in characters; a longer one is refused by the runtime rather than cut. */
export const FILE_NAME_MAX = 255;

/** The largest PDF one message may carry, in bytes. The hub's cap is lower (`min(20 MiB, 0.6 x the burst)`), and is
 *  that runtime's to apply. */
export const PDF_ATTACH_MAX = 20 * 1024 * 1024;

/** The picker's `accept` list: the common text and source types. It only OFFERS them; the test is {@link decodeTextFile}. */
export const TEXT_FILE_ACCEPT = "text/*,.txt,.md,.log,.csv,.tsv,.json,.jsonl,.yaml,.yml,.toml,.xml,.html,.css,.js,.mjs,.ts,.tsx,.jsx,.py,.rs,.go,.java,.c,.h,.cpp,.sh,.sql,.ini,.cfg,.conf,.env";

/** The picker's `accept` entries for a PDF, added when the runtime reads them. */
export const PDF_FILE_ACCEPT = "application/pdf,.pdf";

/** A PDF a runtime has read, ready to frame: its `<page>` sections (pdf-frame.ts) and what the block states. */
export interface ReadPdfFile { name: string; type: string; bytes: number; pages: number; body: string; escaped: number }

/** A file as the model's message frames it: a text file, or a PDF the runtime read. */
export type FramedFile = AttachedFile | ReadPdfFile;

/** Is `f` a PDF's bytes, as a command carries them? */
export const isPdfFile = (f: SentFile): f is AttachedPdf => typeof (f as AttachedPdf).data === "string";
/** Is `f` a PDF the runtime has read? */
export const isReadPdf = (f: FramedFile): f is ReadPdfFile => typeof (f as ReadPdfFile).body === "string";

/** How many bytes a base64 string holds, without decoding it. */
export function b64Bytes(b64: string): number {
    const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
    return Math.max(0, Math.floor(b64.length / 4) * 3 - pad);
}

/** The text files of `fs`: what a path that does not read PDFs takes (`filesRefusal` refuses a PDF to an agent run
 *  first, and a page's composer does not offer one). */
export function textFiles(fs?: readonly SentFile[] | null): AttachedFile[] | undefined {
    const out = (fs ?? []).filter((f): f is AttachedFile => !isPdfFile(f));
    return out.length ? out : undefined;
}

/** A message's files could not be sent once the runtime read them (a PDF that would not open, or more text than a
 *  message takes); the message is the reason, naming the file. Thrown before the turn, so nothing is sent. */
export class FilesRefused extends Error {
    constructor(message: string) { super(message); this.name = "FilesRefused"; }
}

/** Is the message going to a chat or to an agent run? Only the refusal's wording differs. */
export type FileTarget = "chat" | "agent";

/** "412 B", "18 kB", "210 kB": decimal, one figure, for a refusal a person reads. */
export function sizeLabel(chars: number): string {
    if (chars < 1000) return `${chars} B`;
    return chars < 10_000 ? `${(chars / 1000).toFixed(1)} kB` : `${Math.round(chars / 1000)} kB`;
}

/** UTF-8 length of `text` in bytes, the `bytes` a `<file>` block states. */
export function utf8Length(text: string): number {
    let n = 0;
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (c < 0x80) n += 1;
        else if (c < 0x800) n += 2;
        // A surrogate pair is one code point of four bytes; a lone surrogate is written as U+FFFD, three bytes.
        else if (c >= 0xd800 && c < 0xdc00 && i + 1 < text.length && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { n += 4; i++; }
        else n += 3;
    }
    return n;
}

/** How many lines `text` has: a trailing newline does not make another. */
export function lineCount(text: string): number {
    if (!text) return 0;
    const n = text.split("\n").length;
    return text.endsWith("\n") ? n - 1 : n;
}

/** A file's descriptor, as a transcript keeps it. */
export function fileInfo(f: FramedFile): AttachedFileInfo {
    if (isReadPdf(f)) return { name: f.name, type: f.type, bytes: f.bytes, lines: 0, pages: f.pages };
    return { name: f.name, type: f.type, bytes: utf8Length(f.text), lines: lineCount(f.text) };
}

/** "server.log · text, 412 lines", "paper.pdf · PDF, 12 pages": what the calm view's chip says. */
export function fileSummary(i: AttachedFileInfo): string {
    if (i.pages != null) return `${i.name} · PDF, ${i.pages} page${i.pages === 1 ? "" : "s"}`;
    return `${i.name} · text, ${i.lines} line${i.lines === 1 ? "" : "s"}`;
}

/** The sentence under a sent file's chip. Slice 1 sends every file whole; later slices add the other outcomes. */
export const FILE_SENT_TIP = "Sent to the model in full.";

/** The sentence under a sent PDF's chip. */
export const PDF_SENT_TIP = "Read page by page: each page's text, and the image of a page that needed one. The message names what was not sent.";

/** The tip for a sent file's chip. */
export const fileSentTip = (i: AttachedFileInfo): string => (i.pages != null ? PDF_SENT_TIP : FILE_SENT_TIP);

/** Do these bytes, name or type say PDF? */
export function looksPdf(name: string, type: string, bytes: Uint8Array): boolean {
    return type === "application/pdf" || /\.pdf$/i.test(name) || (bytes.length >= 5 && String.fromCharCode(...bytes.subarray(0, 5)) === "%PDF-");
}

/**
 * A picked PDF, checked and carried as its bytes: the runtime reads it. Refused when it does not start with `%PDF-`
 * (anywhere in its first KB, as the reader allows) or is past {@link PDF_ATTACH_MAX}.
 * @param name the file's name
 * @param bytes its content
 */
export function encodePdfFile(name: string, bytes: Uint8Array): { ok: true; file: AttachedPdf } | { ok: false; reason: string } {
    if (bytes.length > PDF_ATTACH_MAX) return { ok: false, reason: tooLargePdf(name, bytes.length) };
    if (!String.fromCharCode(...bytes.subarray(0, 1024)).includes("%PDF-")) return { ok: false, reason: `${name} is not a PDF` };
    return { ok: true, file: { name, type: "application/pdf", data: bytesToB64(bytes) } };
}

/** The sentence for a PDF past {@link PDF_ATTACH_MAX}. */
export function tooLargePdf(name: string, bytes: number): string {
    return `${name} is too large to send: ${sizeLabel(bytes)}; a PDF takes up to ${PDF_ATTACH_MAX / 1024 / 1024} MB`;
}

/**
 * Decode a picked file as text. A file is text if it decodes as UTF-8 (`fatal`) and holds no NUL byte; the extension
 * and the MIME type are not the test, so a `.log` or an extensionless file is text if it decodes. Refused files get
 * the reason as a sentence naming the file.
 * @param name the file's name
 * @param type the browser's MIME type for it ("" when it names none)
 * @param bytes its content
 */
export function decodeTextFile(name: string, type: string, bytes: Uint8Array): { ok: true; file: AttachedFile } | { ok: false; reason: string } {
    if (looksPdf(name, type, bytes)) return { ok: false, reason: `${name} is a PDF, which this runtime does not read` };
    if (bytes.includes(0)) return { ok: false, reason: `${name} is not a text file` };
    try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        return { ok: true, file: { name, type: type || "text/plain", text } };
    } catch { return { ok: false, reason: `${name} is not a text file` }; }
}

/**
 * The sentence for a file that does not fit: its size, the limit, and, for an agent run, that reading on demand is
 * a later change.
 * @param name the file
 * @param size its size (characters of text, or bytes where the text was not read)
 * @param together true when it fits alone and the other files take its room
 * @param target where the message goes
 */
export function tooLarge(name: string, size: number, together: boolean, target: FileTarget): string {
    return `${name} is too large to send whole${together ? " together with the other files" : ""}: ${sizeLabel(size)}; a message takes up to ${sizeLabel(FILE_INLINE_MAX)} of files`
        + (target === "agent" ? ". An agent run will read large files on demand in a later change" : "");
}

/** A file this many bytes or more cannot fit whatever it holds (UTF-8 is at most four bytes a character), so a picker
 *  refuses it without reading it. */
export const FILE_READ_MAX_BYTES = FILE_INLINE_MAX * 4;

/**
 * Why `files` cannot be sent in one message, or null. The client calls it to refuse before sending; the runtime calls
 * it as the rule. The wording names the file that tips the total, with its own size.
 * @param files the files of ONE message, in attach order
 * @param target where the message goes: an agent run says that reading on demand is a later change
 */
export function filesRefusal(files: readonly SentFile[], target: FileTarget): string | null {
    if (files.length > FILES_MAX_COUNT) return `a message takes up to ${FILES_MAX_COUNT} files`;
    let total = 0, pdfBytes = 0;
    for (const f of files) {
        if (f.name.length > FILE_NAME_MAX) return `a file name takes up to ${FILE_NAME_MAX} characters`;
        if (isPdfFile(f)) {
            // A PDF's text is counted by the runtime once it has read the pages (textCapRefusal); here, its bytes.
            if (target === "agent") return `${f.name} is a PDF; an agent run will read PDFs in a later change`;
            pdfBytes += b64Bytes(f.data);
            if (pdfBytes > PDF_ATTACH_MAX) return tooLargePdf(f.name, b64Bytes(f.data));
            continue;
        }
        total += f.text.length;
        if (total > FILE_INLINE_MAX) {
            return tooLarge(f.name, f.text.length, f.text.length <= FILE_INLINE_MAX, target);
        }
    }
    return null;
}

/**
 * Which of the pending files are refused, and why, by index (null: it will be sent). The first files that fit are kept,
 * so removing the one a reason names frees the rest. A file's own refusal does not count towards the total.
 * @param files the files in the box
 * @param target where the message will go
 */
export function pendingRefusals(files: readonly SentFile[], target: FileTarget): (string | null)[] {
    const out: (string | null)[] = [];
    const kept: SentFile[] = [];
    for (const f of files) {
        const why = filesRefusal([...kept, f], target);
        out.push(why);
        if (!why) kept.push(f);
    }
    return out;
}

/** A name or type as an XML-ish attribute value: the quote, the angle brackets, `&` and line breaks cannot end it. */
export function attr(v: string): string {
    return v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/\r/g, "&#13;").replace(/\n/g, "&#10;").replace(/\t/g, "&#9;");
}

/**
 * One file as the model reads it.
 *
 * The text is not interpreted, with ONE exception: a literal `</file` (any case) inside it is written `<\/file`, so a
 * file cannot close its own block and speak as the person. The block then says how many it changed (`escaped="2"`),
 * so the model and a reader of the log know the text was touched and where to look. Chosen over a per-message random
 * closing tag because the same message must always produce the same prompt: an export, a diff of two runs and a test
 * all compare these bytes.
 * @param f the file
 */
export function fileBlock(f: FramedFile): string {
    if (isReadPdf(f)) {
        const head = `<file name="${attr(f.name)}" type="${attr(f.type)}" bytes="${f.bytes}" pages="${f.pages}"${f.escaped ? ` escaped="${f.escaped}"` : ""}>`;
        return `${head}\n${f.body}${f.body && !f.body.endsWith("\n") ? "\n" : ""}</file>`;
    }
    let n = 0;
    const text = f.text.replace(/<\/file/gi, () => { n++; return "<\\/file"; });
    const head = `<file name="${attr(f.name)}" type="${attr(f.type)}" bytes="${utf8Length(f.text)}"${n ? ` escaped="${n}"` : ""}>`;
    return `${head}\n${text}${text.endsWith("\n") ? "" : "\n"}</file>`;
}

/** The blocks of `files` in attach order, blank-line separated; "" for none. */
export function fileBlocks(files: readonly FramedFile[]): string {
    return files.map(fileBlock).join("\n\n");
}

/** `typed` with the files' blocks after it, in attach order. */
export function withFileBlocks(typed: string, files?: readonly FramedFile[] | null): string {
    if (!files?.length) return typed;
    return [typed.trim() ? typed : "", fileBlocks(files)].filter(Boolean).join("\n\n");
}

/** A message with files and nothing else folded in: the model-facing text, and how to show it (absent without files). */
export function frameFiles(typed: string, files?: readonly FramedFile[] | null): { text: string; display?: PromptDisplay } {
    return files?.length ? { text: withFileBlocks(typed, files), display: fileDisplay(typed, files) } : { text: typed };
}

/** The file entries of a message's display context. */
export function fileContexts(files?: readonly FramedFile[] | null): PromptContext[] {
    return (files ?? []).map((f) => ({ kind: "file" as const, file: fileInfo(f) }));
}

/**
 * Validate files off the wire (a command, a relayed message): the right shape, nothing else. Names and types are
 * strings, the text is a string. Does NOT apply the size rules (that is {@link filesRefusal}, which answers a command
 * with a reason); it never throws.
 * @param v whatever arrived
 * @returns the files, or undefined when there are none or the shape is wrong
 */
export function cleanFiles(v: unknown): SentFile[] | undefined {
    if (!Array.isArray(v)) return undefined;
    const out: SentFile[] = [];
    for (const x of v) {
        if (!x || typeof x !== "object") return undefined;
        const { name, type, text, data } = x as Record<string, unknown>;
        if (typeof name !== "string" || !name) return undefined;
        if (data !== undefined && text !== undefined) return undefined;   // both: neither shape, so not a guess
        if (typeof data === "string") {
            // A PDF's bytes: base64 that decodes (b64ToBytes is null otherwise), typed as a PDF whatever was claimed.
            if (!b64ToBytes(data)) return undefined;
            out.push({ name, type: "application/pdf", data });
            continue;
        }
        if (typeof text !== "string") return undefined;
        out.push({ name, type: typeof type === "string" && type ? type : "text/plain", text });
    }
    return out.length ? out : undefined;
}

/**
 * The files of a command, checked: the RULE behind the composer's convenience check. A malformed list or one past
 * the limits is refused with the reason, never trimmed, so a message never goes out with fewer files than the person
 * attached.
 * @param raw the command's `files` as it arrived
 * @param target where the message goes (only the wording of a size refusal differs)
 * @returns the files (absent for none), or the reason to answer `invalid` with
 */
export function checkFilesField(raw: unknown, target: FileTarget): { files?: SentFile[]; reason?: string } {
    if (raw == null || (Array.isArray(raw) && !raw.length)) return {};
    const files = cleanFiles(raw);
    if (!files || files.length !== (raw as unknown[]).length) return { reason: "files must be a list of { name, type, text } or, for a PDF, { name, type, data }" };
    const reason = filesRefusal(files, target);
    return reason ? { reason } : { files };
}

/** Is `ctx` a file entry? */
export const isFileContext = (c: PromptContext): c is Extract<PromptContext, { kind: "file" }> => c.kind === "file";

/** A display for a message with files and no element (an element's framing is `framePrompt`'s, prompts.ts). */
export function fileDisplay(typed: string, files: readonly FramedFile[], element?: ElementContext | null): PromptDisplay {
    return { typed: typed.trim(), context: [...(element ? [{ kind: "element" as const, element }] : []), ...fileContexts(files)] };
}

/**
 * Why the files of a chat message cannot be sent once its PDFs are read, or null: slice 1's cap on the TEXT a
 * message carries in files, counted over the text files and the text of every page read.
 * @param sizes each file's name and characters of text, in attach order
 */
export function textCapRefusal(sizes: readonly { name: string; chars: number }[]): string | null {
    let total = 0;
    for (const f of sizes) {
        total += f.chars;
        if (total > FILE_INLINE_MAX) return tooLarge(f.name, f.chars, f.chars <= FILE_INLINE_MAX, "chat");
    }
    return null;
}
