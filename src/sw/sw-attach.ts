// sw-attach.ts — a file the person attached to an agent run the worker built, on its first message or a later one: a
// PDF read once, a text file as it is, and a long paste, each kept in the value store for the run's session and noted
// on the run's shelf as an `@file:` pointer the message names (docs/spec/FILE_ATTACHMENTS.md, slice 3 and "Every
// attachment to an agent run as a pointer").

import { FilesRefused, isPdfFile, lineCount, sentWhole, type FramedFile } from "../attached-files";
import type { SentFile } from "../contract/contract-run";
import { FETCH_PREVIEW_CHARS } from "../ml/ml-tool-factories";
import { cleanFileName, fileId, fileOutline, fileRef, pageKinds, quoteName, textOutline, type FilePointer, type FileShelf } from "../pointers/file-pointer";
import { ValueTooLarge, sha256Hex, type ValueFormat, type ValueRow } from "../pointers/value-store";
import { b64ToBytes, type PdfMessage, type PdfReadReply } from "../pdf/pdf-wire";
import { ensureOffscreen } from "./sw-offscreen";

/** Read a PDF in the offscreen document's reader (docs/dev/pdf.md): only the service worker may ask it. */
export async function readPdfOffscreen(b64: string): Promise<PdfReadReply> {
    await ensureOffscreen();
    return await chrome.runtime.sendMessage({ type: "PDF_READ", b64 } satisfies PdfMessage);
}

/** What attaching needs: the reader, the held store (`storeHeld`, sw-values.ts) and the run's shelf. */
export interface AttachDeps {
    read(b64: string): Promise<PdfReadReply | null | undefined>;
    store(blob: Blob, format: ValueFormat, source: string, session: string): Promise<ValueRow>;
    shelf: FileShelf;
}

/** A count a reader reported, floored to the non-negative integer every reader of the pointer may take it for (0 when it
 *  is not a finite non-negative number): `ReadPdfFile` is a contract other producers fill, and its numbers reach
 *  model-facing text. */
const count = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0);

/** The sentence for a PDF the store could not keep. */
function keepRefusal(name: string, e: unknown): string {
    const why = e instanceof ValueTooLarge ? `${e.message} Raise the stored table budget in Settings, or attach a smaller file` : String((e as Error)?.message ?? e);
    return `${name} cannot be kept for this run: ${why}`;
}

/**
 * Hold one text for the run: stored for its session and noted on its shelf. The same text twice is one file, the
 * pointer already held.
 * @param runId the run, whose session holds the row
 * @param f the name, type and text
 * @param turn the turn it arrives in, 1-based
 * @param d the store and the shelf
 * @param added where a pointer this call notes is pushed
 * @throws {FilesRefused} the store cannot keep it
 */
async function holdText(runId: string, f: { name: string; type: string; text: string }, turn: number, d: AttachDeps, added: FilePointer[]): Promise<FilePointer> {
    const blob = new Blob([f.text]);
    const sha256 = await sha256Hex(blob);
    const had = d.shelf.all().find((g) => g.sha256 === sha256);
    if (had) return had;
    const name = cleanFileName(f.name);
    let row: ValueRow;
    try { row = await d.store(blob, "text", name, runId); } catch (e) { throw new FilesRefused(keepRefusal(name, e)); }
    const p = d.shelf.note({
        id: fileId(runId, d.shelf.size + 1), name, type: f.type || "text/plain", bytes: blob.size, lines: lineCount(f.text),
        pages: 0, read: 0, turn, doc: row.key, data: row.key, sha256, chars: f.text.length, figures: [], scans: [],
    });
    added.push(p);
    return p;
}

/**
 * The files of a run's message, each held for the run's session and noted on its shelf, framed: a text file whole
 * while the message's text fits (`sentWhole`), past that as its outline, and a PDF read and framed as its outline, each
 * under its pointer. The same bytes twice are one file. Refused whole, before the message is sent, when a PDF will not
 * read or the store cannot keep a file: the pointers noted by then are taken back off the shelf, and rows stored by
 * then are the caller's to release with the session.
 * @param runId the run, whose session holds the rows
 * @param files the message's files, checked (`checkFilesField`)
 * @param turn the turn they arrive in, 1-based
 * @param d the reader, the store and the shelf
 * @returns the files to frame, and the pointers this call added
 * @throws {FilesRefused} a PDF would not read, or the store cannot keep a file
 */
export async function attachFiles(runId: string, files: readonly SentFile[] | undefined, turn: number, d: AttachDeps): Promise<{ files?: FramedFile[]; added: FilePointer[] }> {
    const out: FramedFile[] = [], added: FilePointer[] = [];
    try {
        await attachEach(runId, files ?? [], turn, d, out, added);
    } catch (e) {
        d.shelf.drop(added.map((p) => p.id));
        throw e;
    }
    return { ...(out.length ? { files: out } : {}), added };
}

/** {@link attachFiles}' loop: each file held and framed into `out`, each pointer it notes pushed to `added`. */
async function attachEach(runId: string, files: readonly SentFile[], turn: number, d: AttachDeps, out: FramedFile[], added: FilePointer[]): Promise<void> {
    const whole = sentWhole(files);
    for (const [i, f] of files.entries()) {
        if (!isPdfFile(f)) {
            const p = await holdText(runId, f, turn, d, added);
            if (whole[i]) { out.push({ name: p.name, type: p.type, text: f.text, pointer: fileRef(p) }); continue; }
            const outline = textOutline(p, f.text, d.shelf.firstNamed(p.name, p.id));
            out.push({ name: p.name, type: p.type, bytes: p.bytes, lines: p.lines ?? 0, body: outline.text, escaped: outline.escaped, pointer: fileRef(p) });
            continue;
        }
        const r = await d.read(f.data).catch(() => null);
        if (!r) throw new FilesRefused(`${f.name} could not be read: the PDF reader did not answer`);
        if (!r.ok) throw new FilesRefused(`${f.name}: ${r.refusal}`);
        const bytes = b64ToBytes(f.data);
        if (!bytes) throw new FilesRefused(`${f.name} could not be read: its bytes are not base64`);
        const blob = new Blob([bytes as Uint8Array<ArrayBuffer>]);
        const sha256 = await sha256Hex(blob);
        let p = d.shelf.all().find((g) => g.sha256 === sha256);
        if (!p) {
            const name = cleanFileName(f.name);
            let data: ValueRow, doc: ValueRow;
            try {
                data = await d.store(blob, "bytes", name, runId);
                doc = await d.store(new Blob([JSON.stringify(r.doc)]), "paged", name, runId);
            } catch (e) { throw new FilesRefused(keepRefusal(name, e)); }
            const { figures, scans } = pageKinds(r.doc);
            p = d.shelf.note({
                id: fileId(runId, d.shelf.size + 1), name, type: "application/pdf", bytes: bytes.length, pages: count(r.doc.pageCount),
                read: r.doc.pages.length, turn, doc: doc.key, data: data.key, sha256,
                chars: r.doc.pages.reduce((n, pg) => n + pg.text.length, 0), figures, scans,
                ...(r.doc.truncated ? { truncated: r.doc.truncated.sentence } : {}),
            });
            added.push(p);
        }
        const outline = fileOutline(p, r.doc, d.shelf.firstNamed(p.name, p.id));
        out.push({ name: p.name, type: p.type, bytes: p.bytes, pages: p.pages, body: outline.text, escaped: outline.escaped, pointer: fileRef(p) });
    }
}

/** The name of a long paste's pointer: "pasted text", then "pasted text 2", … , the first not already on the shelf. */
export const PASTE_NAME = "pasted text";

/** The first paste name `shelf` does not hold. */
function pasteName(shelf: FileShelf): string {
    for (let n = 1; ; n++) {
        const name = n === 1 ? PASTE_NAME : `${PASTE_NAME} ${n}`;
        if (!shelf.firstNamed(name)) return name;
    }
}

/**
 * A person's message of {@link FETCH_PREVIEW_CHARS} characters or more, held as a text pointer beside it: the message
 * still goes to the model whole, and one line after it names the pointer, so the model quotes from it by reading
 * rather than by typing it out again. The threshold is `fetch_url`'s preview cut, one rule for "too long to re-type".
 * @param runId the run, whose session holds the row
 * @param text the message as the person typed it
 * @param turn the turn it arrives in, 1-based
 * @param d the store and the shelf
 * @returns the line to append and the pointers added, or null for a message shorter than the threshold, or one the
 *   store cannot keep: the message goes whole either way, so a paste never refuses it
 */
export async function attachPaste(runId: string, text: string, turn: number, d: Pick<AttachDeps, "store" | "shelf">): Promise<{ line: string; added: FilePointer[] } | null> {
    if (text.length < FETCH_PREVIEW_CHARS) return null;
    const added: FilePointer[] = [];
    try {
        const p = await holdText(runId, { name: pasteName(d.shelf), type: "text/plain", text }, turn, { ...d, read: async () => null }, added);
        return { line: pasteLine(p), added };
    } catch { return null; }
}

/** The one line after a long message that names its pointer. */
export const pasteLine = (p: FilePointer): string =>
    `(This message is also held as ${fileRef(p)} ${quoteName(p.name)}, ${p.lines} line${p.lines === 1 ? "" : "s"}: quote from it with dereference(${fileRef(p)}, pipe "grep -n …") rather than typing it out again.)`;
