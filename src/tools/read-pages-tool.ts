// read-pages-tool.ts — `read_pages`, a worker chat's one tool: the text of pages of a PDF the person attached that the
// message did not send (docs/spec/FILE_ATTACHMENTS.md, "Reading the pages held back").
//
// Pure: the chat (sw-chat.ts) says which PDFs it can read and how to get each one's read document, and gets back the
// text the model reads. Every way a call can go wrong is answered as a sentence, never thrown, so a bad call never
// ends the turn the person is waiting on.

import { attr } from "../attached-files";
import { escapePageText, pageRanges } from "../pdf/pdf-frame";
import type { PdfDoc } from "../pdf/pdf-read";
import { PIPE_PAGES_MAX, pageSpans } from "../pointers/text-pipe";

/** The tool's name, as the model calls it. */
export const READ_PAGES = "read_pages";

/** How many `read_pages` calls one chat turn may make; past it the turn's last model call is made with no tools. */
export const READ_PAGES_MAX_CALLS = 4;

/** What a chat's held-back note says can get those pages, when the tool is offered on the turn. */
export const READ_PAGES_RECOVERY = "Read them with read_pages.";

/** The tool as the model is offered it: the openai `tools` shape both API formats send. */
export const READ_PAGES_TOOL = {
    name: "read_pages",
    description: "Read pages of a PDF attached to this chat that its message did not send. Returns each page's text.",
    parameters: {
        type: "object",
        properties: {
            file: { type: "string", description: "the PDF's name, as its <file> block gives it" },
            pages: { type: "string", description: "page numbers: 3, 3-5 or 3,7-9" },
        },
        required: ["file", "pages"],
        additionalProperties: false,
    },
} as const;

/** One PDF a chat lists: its name and page count, how many pages from the first its message sent, whether the chat
 *  still holds it, and its read document, which answers null when the chat no longer holds it after all. */
export interface ReadableFile {
    name: string;
    pages: number;
    sent: number;
    /** false: listed with no rows (the store would not keep it, or they were released) */
    held: boolean;
    doc(): Promise<PdfDoc | null>;
}

/** Whether a turn offers `read_pages`: some PDF the chat still holds has a page its message did not send. */
export function offersReadPages(files: readonly ReadableFile[]): boolean {
    return files.some((f) => f.held && f.sent < f.pages);
}

/**
 * Answer one `read_pages` call: the `<page>` sections asked for, inside a `<file>` block, while their text fits in
 * `budget` characters; the pages past it are named. A page with a figure says so, and a scan with no text says it has
 * none to give, since this tool reads text only.
 * @param files the PDFs the chat can read, in the order they were sent
 * @param args the call's arguments as the model wrote them
 * @param budget the characters of page text one call returns (`pdfTextBudget`)
 * @returns the text the model reads
 */
export async function readPages(files: readonly ReadableFile[], args: unknown, budget: number): Promise<string> {
    const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
    const name = typeof a.file === "string" ? a.file.trim() : "";
    const raw = typeof a.pages === "string" ? a.pages : typeof a.pages === "number" ? String(a.pages) : "";
    const listed = files.length ? files.map((_f, i) => label(files, i)).join(", ") : "none";
    if (!name) return `read_pages needs \`file\`: the PDF's name. This chat holds: ${listed}.`;
    const f = pick(files, name);
    if (f === null) return `This chat holds no PDF named ${JSON.stringify(name)}. It holds: ${listed}.`;
    if (f === "ambiguous") return `${JSON.stringify(name)} names more than one PDF in this chat. Pass one of: ${listed}.`;
    let want: number[];
    try { want = pageSpans(raw, PIPE_PAGES_MAX, "in one call; read them in parts"); } catch (e) { return `read_pages: ${(e as Error).message}`; }
    const doc = f.held ? await f.doc().catch(() => null) : null;
    if (!doc) return `${f.name} is no longer held by this chat. The person can attach it again.`;
    const have = new Set(doc.pages.map((p) => p.n));
    const missing = want.filter((n) => !have.has(n));
    if (missing.length) {
        const held = doc.pages.length ? `pages ${pageRanges(doc.pages.map((p) => p.n))}` : "no pages";
        return `${f.name} has no page ${pageRanges(missing)}: it holds ${held}${doc.truncated ? ` (${doc.truncated.sentence})` : ""}.`;
    }
    let room = Math.max(0, budget), escaped = 0;
    const parts: string[] = [], past: number[] = [];
    for (const n of want) {
        const p = doc.pages.find((x) => x.n === n)!;
        let text = p.text.trim() ? p.text : "";
        let cut = "";
        if (past.length || text.length > room) {
            // The first page asked for, alone past what one call returns, comes cut rather than not at all: named, it
            // could never be read by any call.
            if (parts.length || past.length || room <= 0) { past.push(n); continue; }
            cut = `(page ${n} is cut here: its text runs past what one call returns, ${room} of ${text.length} characters)`;
            text = text.slice(0, room);
        }
        room -= text.length;
        const lines = [text, cut];
        if (p.kind === "mixed") lines.push(`(page ${n} has a figure; read_pages returns its text only)`);
        if (p.kind === "scanned" && !text) lines.push(`(page ${n} is a scan with no text; read_pages returns text only)`);
        const body = lines.filter(Boolean).map((l) => { const e = escapePageText(l); escaped += e.escaped; return e.text; }).join("\n");
        parts.push(`<page n="${n}">\n${body}${body.endsWith("\n") ? "" : "\n"}</page>`);
    }
    if (past.length) parts.push(`${past.length === 1 ? `page ${past[0]} was` : `pages ${pageRanges(past)} were`} not returned: past the text one call returns. Read ${past.length === 1 ? "it" : "them"} in another call.`);
    const head = `<file name="${attr(f.name)}" pages="${f.pages}"${escaped ? ` escaped="${escaped}"` : ""}>`;
    return `${head}\n${parts.join("\n")}\n</file>`;
}

/** The file a name picks: by its name, or `name#k` for the k-th of several with that name (in the order sent). */
function pick(files: readonly ReadableFile[], name: string): ReadableFile | null | "ambiguous" {
    const same = files.filter((f) => f.name === name);
    if (same.length === 1) return same[0];
    if (same.length > 1) return "ambiguous";
    const m = /^(.*)#(\d{1,3})$/.exec(name);
    if (!m) return null;
    const of = files.filter((f) => f.name === m[1]);
    const k = Number(m[2]);
    return of.length > 1 && k >= 1 && k <= of.length ? of[k - 1] : null;
}

/** How a call names file `i`: its name, or `name#k` when several share it. */
function label(files: readonly ReadableFile[], i: number): string {
    const f = files[i];
    const of = files.filter((x) => x.name === f.name);
    return of.length > 1 ? `${f.name}#${of.indexOf(f) + 1}` : f.name;
}
