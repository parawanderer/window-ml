// attached-files.ts — a text file attached to a message: what counts as text, how much one message may carry, the
// `<file>` block the model reads, and the words a refusal uses (docs/spec/FILE_ATTACHMENTS.md, slice 1).
//
// Pure, with no `chrome` and no DOM: the composer (to refuse a file before sending), the runtime's command check (the
// rule), the chat host and the agent's prompt framing (to build the message) all import this one copy.

import type { AttachedFile, AttachedFileInfo, ElementContext, PromptContext, PromptDisplay } from "./contract/contract-run";

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

/** The picker's `accept` list: the common text and source types. It only OFFERS them; the test is {@link decodeTextFile}. */
export const TEXT_FILE_ACCEPT = "text/*,.txt,.md,.log,.csv,.tsv,.json,.jsonl,.yaml,.yml,.toml,.xml,.html,.css,.js,.mjs,.ts,.tsx,.jsx,.py,.rs,.go,.java,.c,.h,.cpp,.sh,.sql,.ini,.cfg,.conf,.env";

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
export function fileInfo(f: AttachedFile): AttachedFileInfo {
    return { name: f.name, type: f.type, bytes: utf8Length(f.text), lines: lineCount(f.text) };
}

/** "server.log · text, 412 lines": what the calm view's chip says. */
export function fileSummary(i: AttachedFileInfo): string {
    return `${i.name} · text, ${i.lines} line${i.lines === 1 ? "" : "s"}`;
}

/** The sentence under a sent file's chip. Slice 1 sends every file whole; later slices add the other outcomes. */
export const FILE_SENT_TIP = "Sent to the model in full.";

/**
 * Decode a picked file as text. A file is text if it decodes as UTF-8 (`fatal`) and holds no NUL byte; the extension
 * and the MIME type are not the test, so a `.log` or an extensionless file is text if it decodes. Refused files get
 * the reason as a sentence naming the file.
 * @param name the file's name
 * @param type the browser's MIME type for it ("" when it names none)
 * @param bytes its content
 */
export function decodeTextFile(name: string, type: string, bytes: Uint8Array): { ok: true; file: AttachedFile } | { ok: false; reason: string } {
    const pdf = type === "application/pdf" || /\.pdf$/i.test(name) || (bytes.length >= 5 && String.fromCharCode(...bytes.subarray(0, 5)) === "%PDF-");
    if (pdf) return { ok: false, reason: `${name} is not a text file; PDFs come in a later change` };
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
export function filesRefusal(files: readonly AttachedFile[], target: FileTarget): string | null {
    if (files.length > FILES_MAX_COUNT) return `a message takes up to ${FILES_MAX_COUNT} files`;
    let total = 0;
    for (const f of files) {
        if (f.name.length > FILE_NAME_MAX) return `a file name takes up to ${FILE_NAME_MAX} characters`;
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
export function pendingRefusals(files: readonly AttachedFile[], target: FileTarget): (string | null)[] {
    const out: (string | null)[] = [];
    const kept: AttachedFile[] = [];
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
export function fileBlock(f: AttachedFile): string {
    let n = 0;
    const text = f.text.replace(/<\/file/gi, () => { n++; return "<\\/file"; });
    const head = `<file name="${attr(f.name)}" type="${attr(f.type)}" bytes="${utf8Length(f.text)}"${n ? ` escaped="${n}"` : ""}>`;
    return `${head}\n${text}${text.endsWith("\n") ? "" : "\n"}</file>`;
}

/** The blocks of `files` in attach order, blank-line separated; "" for none. */
export function fileBlocks(files: readonly AttachedFile[]): string {
    return files.map(fileBlock).join("\n\n");
}

/** `typed` with the files' blocks after it, in attach order. */
export function withFileBlocks(typed: string, files?: readonly AttachedFile[] | null): string {
    if (!files?.length) return typed;
    return [typed.trim() ? typed : "", fileBlocks(files)].filter(Boolean).join("\n\n");
}

/** A message with files and nothing else folded in: the model-facing text, and how to show it (absent without files). */
export function frameFiles(typed: string, files?: readonly AttachedFile[] | null): { text: string; display?: PromptDisplay } {
    return files?.length ? { text: withFileBlocks(typed, files), display: fileDisplay(typed, files) } : { text: typed };
}

/** The file entries of a message's display context. */
export function fileContexts(files?: readonly AttachedFile[] | null): PromptContext[] {
    return (files ?? []).map((f) => ({ kind: "file" as const, file: fileInfo(f) }));
}

/**
 * Validate files off the wire (a command, a relayed message): the right shape, nothing else. Names and types are
 * strings, the text is a string. Does NOT apply the size rules (that is {@link filesRefusal}, which answers a command
 * with a reason); it never throws.
 * @param v whatever arrived
 * @returns the files, or undefined when there are none or the shape is wrong
 */
export function cleanFiles(v: unknown): AttachedFile[] | undefined {
    if (!Array.isArray(v)) return undefined;
    const out: AttachedFile[] = [];
    for (const x of v) {
        if (!x || typeof x !== "object") return undefined;
        const { name, type, text } = x as Record<string, unknown>;
        if (typeof name !== "string" || !name || typeof text !== "string") return undefined;
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
export function checkFilesField(raw: unknown, target: FileTarget): { files?: AttachedFile[]; reason?: string } {
    if (raw == null || (Array.isArray(raw) && !raw.length)) return {};
    const files = cleanFiles(raw);
    if (!files || files.length !== (raw as unknown[]).length) return { reason: "files must be a list of { name, type, text }" };
    const reason = filesRefusal(files, target);
    return reason ? { reason } : { files };
}

/** Is `ctx` a file entry? */
export const isFileContext = (c: PromptContext): c is Extract<PromptContext, { kind: "file" }> => c.kind === "file";

/** A display for a message with files and no element (an element's framing is `framePrompt`'s, prompts.ts). */
export function fileDisplay(typed: string, files: readonly AttachedFile[], element?: ElementContext | null): PromptDisplay {
    return { typed: typed.trim(), context: [...(element ? [{ kind: "element" as const, element }] : []), ...fileContexts(files)] };
}
