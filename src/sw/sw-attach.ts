// sw-attach.ts — a PDF the person attached to an agent run: read once, kept in the value store for the run's session,
// and noted on the run's shelf as an `@file:` pointer whose outline the task carries (docs/spec/FILE_ATTACHMENTS.md,
// slice 3).

import { FilesRefused, isPdfFile, type FramedFile } from "../attached-files";
import type { SentFile } from "../contract/contract-run";
import { cleanFileName, fileId, fileOutline, fileRef, pageKinds, type FilePointer, type FileShelf } from "../pointers/file-pointer";
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

/** The sentence for a PDF the store could not keep. */
function keepRefusal(name: string, e: unknown): string {
    const why = e instanceof ValueTooLarge ? `${e.message} Raise the stored table budget in Settings, or attach a smaller file` : String((e as Error)?.message ?? e);
    return `${name} cannot be kept for this run: ${why}`;
}

/**
 * The files of a run's message with each PDF read, stored for the run's session and noted on its shelf: a text file
 * as sent, a PDF as its outline under its pointer. The same bytes twice are one file. Refused whole, before the run
 * starts, when a PDF will not read or the store cannot keep it; rows stored by then are the caller's to release with
 * the session.
 * @param runId the run, whose session holds the rows
 * @param files the message's files, checked (`checkFilesField`)
 * @param turn the turn they arrive in, 1-based
 * @param d the reader, the store and the shelf
 * @returns the files to frame, and the pointers this call added
 * @throws {FilesRefused} a PDF would not read, or the store cannot keep it
 */
export async function attachFiles(runId: string, files: readonly SentFile[] | undefined, turn: number, d: AttachDeps): Promise<{ files?: FramedFile[]; added: FilePointer[] }> {
    const out: FramedFile[] = [], added: FilePointer[] = [];
    for (const f of files ?? []) {
        if (!isPdfFile(f)) { out.push(f); continue; }
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
                id: fileId(runId, d.shelf.size + 1), name, type: "application/pdf", bytes: bytes.length, pages: r.doc.pageCount,
                read: r.doc.pages.length, turn, doc: doc.key, data: data.key, sha256,
                chars: r.doc.pages.reduce((n, pg) => n + pg.text.length, 0), figures, scans,
                ...(r.doc.truncated ? { truncated: r.doc.truncated.sentence } : {}),
            });
            added.push(p);
        }
        out.push({ name: p.name, type: p.type, bytes: p.bytes, pages: p.pages, body: fileOutline(p, r.doc, d.shelf.firstNamed(p.name, p.id)), escaped: 0, pointer: fileRef(p) });
    }
    return { ...(out.length ? { files: out } : {}), added };
}
