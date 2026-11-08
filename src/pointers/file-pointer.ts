// file-pointer.ts — a file the person attached, as an `@file:` pointer: its record, the outline the model is given up
// front, a PDF's pages as the `<page>` sections the `pages` verb selects, and the shelf a run's files sit on
// (docs/spec/FILE_ATTACHMENTS.md, slice 3). A text file, and a long paste, are pointers too: read as their text.
//
// Pure: no chrome, no I/O. The bytes and the read document live in the value store; a pointer holds their keys.

import type { PdfDoc } from "../pdf/pdf-read";
import { escapePageText, pageRanges } from "../pdf/pdf-frame";
import { toolToken } from "../util";
import { isTokenShape } from "./token-id";
import { FILE_PREFIX } from "./token-prefixes";

/** Characters of a file's name kept: the name is untrusted text and travels in every outline and refusal. */
export const FILE_NAME_MAX = 120;
/** Characters of the first page's text (a text file's opening) the outline previews. */
export const FILE_PREVIEW_CHARS = 800;

/** An attached file as a run holds it. The bytes and the read document are value-store rows (held for the run's
 *  session), named here by key; everything else is what the outline and a refusal say about it. */
export interface FilePointer {
    /** The minted id, without the prefix: {@link fileId}. */
    id: string;
    /** The file's own name, cleaned ({@link cleanFileName}): the label the person and the model both call it. */
    name: string;
    type: string;
    bytes: number;
    /** A text file's lines; absent for a PDF ({@link isTextFile}). */
    lines?: number;
    /** What the file says it has (0 for a text file). */
    pages: number;
    /** How many were read: fewer when the read stopped (`truncated`). */
    read: number;
    /** The turn it was attached in, 1-based. */
    turn: number;
    /** The value-store key of the read document (a JSON {@link PdfDoc}); a text file's text. */
    doc: string;
    /** The value-store key of the file's bytes. */
    data: string;
    sha256: string;
    /** Characters of page text across the pages read (of a text file, its text). */
    chars: number;
    /** Pages with a figure, and scanned pages, by number. */
    figures: number[];
    scans: number[];
    /** Why not every page was read, as the reader said it. */
    truncated?: string;
}

/** The id of a run's `n`th attached file: a pointer id in its own domain, so it never collides with a tool output's. */
export const fileId = (runHash: string, n: number): string => toolToken(`${runHash}:file`, n);

/** A file's name as it may travel: control and format characters (a bidi override included) and line breaks
 *  stripped, whitespace collapsed, the length capped. A downloaded file can be called anything. */
export function cleanFileName(raw: unknown): string {
    const s = typeof raw === "string" ? raw.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, " ").replace(/\s+/g, " ").trim() : "";
    const capped = [...s].slice(0, FILE_NAME_MAX).join("");
    return capped || "file";
}

/** A name in the quoted label form, `"report.pdf"`, with a quote or backslash inside it escaped. */
export const quoteName = (name: string): string => `"${name.replace(/["\\]/g, "\\$&")}"`;

/** A file's pointer as the model writes it. */
export const fileRef = (f: Pick<FilePointer, "id">): string => `${FILE_PREFIX}${f.id}`;

/** Text that goes inside a `<page>` section or an outline: {@link escapePageText}, and an opening `<page` written
 *  `<\page` too, so a page cannot open a section of its own and have the `pages` verb take it for another page. */
export function escapeSectionText(text: string): { text: string; escaped: number } {
    const e = escapePageText(text);
    let escaped = e.escaped;
    return { text: e.text.replace(/<page/gi, (m) => { escaped++; return `<\\${m.slice(1)}`; }), escaped };
}

/** Pages whose kind is `mixed` (a figure) and `scanned`, by number. */
export function pageKinds(doc: PdfDoc): { figures: number[]; scans: number[] } {
    return {
        figures: doc.pages.filter((p) => p.kind === "mixed").map((p) => p.n),
        scans: doc.pages.filter((p) => p.kind === "scanned").map((p) => p.n),
    };
}

/** "61k" for a token count from characters (~4 per token). */
function tokensOf(chars: number): string {
    const t = Math.round(chars / 4);
    return t >= 1000 ? `${Math.round(t / 1000)}k` : String(t);
}

/** "page 3 has a figure" / "pages 3, 7-9 have figures". */
function pagesSay(ns: number[], one: string, many: string): string {
    return ns.length === 1 ? `page ${ns[0]} ${one}` : `pages ${pageRanges(ns)} ${many}`;
}

/** "48 pages", or "500 of 900 pages read" when the read stopped short: what every line about the file says. */
export function filePagesSaid(f: Pick<FilePointer, "pages" | "read">): string {
    return f.read < f.pages ? `${f.read} of ${f.pages} pages read` : `${f.pages} page${f.pages === 1 ? "" : "s"}`;
}

/** Is `f` a text file (or a long paste), read as its text rather than by pages? A pointer written before text files
 *  were held has no `lines`, and is a PDF. */
export const isTextFile = (f: Pick<FilePointer, "lines">): boolean => typeof f.lines === "number";

/** "12 pages" for a PDF ({@link filePagesSaid}), "40 lines" for a text file: a file's size in every line about it. */
export function fileSizeSaid(f: Pick<FilePointer, "pages" | "read" | "lines">): string {
    return isTextFile(f) ? `${f.lines} line${f.lines === 1 ? "" : "s"}` : filePagesSaid(f);
}

/** "PDF, 12 pages" / "Text, 40 lines": what a file is, as the inventory and a read's header say it. */
export const fileKindSaid = (f: Pick<FilePointer, "pages" | "read" | "lines">): string => `${isTextFile(f) ? "Text" : "PDF"}, ${fileSizeSaid(f)}`;

/** The pipe a hint suggests for reading `f`: its first pages, or a text file's opening lines. */
export const firstRead = (f: Pick<FilePointer, "read" | "lines">): string => (isTextFile(f) ? "head -n 100" : `pages ${firstPages(f)}`);

/** The `pages` argument a hint suggests: the first three pages read, or "1" for a one-page file, so it never names a
 *  page the file does not hold. */
export const firstPages = (f: Pick<FilePointer, "read">): string => (f.read > 1 ? `1-${Math.min(f.read, 3)}` : "1");

/**
 * What the model is given up front for an attached PDF, in place of its content: the pointer, the name, who it came
 * from, its size, which pages need eyes, how to read it, and the first page's opening.
 * @param f the file
 * @param doc the read document, for the preview
 * @param first the earlier file by the same name, when there is one
 * @returns the outline, escaped, and how many escapes it took (the block's `escaped`)
 */
export function fileOutline(f: FilePointer, doc: PdfDoc, first?: FilePointer): { text: string; escaped: number } {
    const who = attachedBy(first);
    const size = filePagesSaid(f);
    const text = f.chars ? `about ${tokensOf(f.chars)} tokens of text` : "no text layer";
    const lines = [`${fileRef(f)} ${quoteName(f.name)}: ${who}. PDF, ${size}, ${text}.`];
    const kinds = [
        f.figures.length ? pagesSay(f.figures, "has a figure", "have figures") : "",
        f.scans.length ? pagesSay(f.scans, "is scanned", "are scanned") : "",
    ].filter(Boolean).join("; ");
    lines.push(`${kinds ? `${kinds[0].toUpperCase()}${kinds.slice(1)}. ` : ""}Read with dereference(${fileRef(f)}, pipe "pages ${firstPages(f)}").`);
    const page = doc.pages.find((p) => p.text.trim());
    if (page) {
        const flat = page.text.replace(/\s+/g, " ").trim();
        const cut = flat.length > FILE_PREVIEW_CHARS ? `${flat.slice(0, FILE_PREVIEW_CHARS)}…` : flat;
        lines.push(`Page ${page.n}: ${cut}`);
    }
    if (f.truncated) lines.push(f.truncated);
    // Escaped whole: the name and the preview are the file's text, and the outline sits inside the message's `<file>`.
    return escapeSectionText(lines.join("\n"));
}

/** Who attached `f`, as an outline's first line says it: the person, and the earlier file by its name when there is one. */
function attachedBy(first?: FilePointer): string {
    return first
        ? `a second file by this name; the first is ${fileRef(first)}, attached in turn ${first.turn}. Attached by the person`
        : "attached by the person";
}

/**
 * What the model is given up front for a held text file (or a long paste), in place of its text: the pointer, the
 * name, who it came from, its size, how to read it, and its opening.
 * @param f the file
 * @param text its text, for the preview
 * @param first the earlier file by the same name, when there is one
 * @returns the outline, escaped, and how many escapes it took (the block's `escaped`)
 */
export function textOutline(f: FilePointer, text: string, first?: FilePointer): { text: string; escaped: number } {
    const lines = [
        `${fileRef(f)} ${quoteName(f.name)}: ${attachedBy(first)}. ${fileKindSaid(f)}, about ${tokensOf(f.chars)} tokens.`,
        `Read with dereference(${fileRef(f)}, pipe "${firstRead(f)}"); grep -n finds a line.`,
    ];
    const open = text.length > FILE_PREVIEW_CHARS ? `${text.slice(0, FILE_PREVIEW_CHARS)}…` : text;
    if (open.trim()) lines.push(`Opening:\n${open}`);
    return escapeSectionText(lines.join("\n"));
}

/** A read document as the `pages` verb's input: one `<page n="k">` section per page read, its text escaped. A page
 *  with no text says so, and says why when it is scanned. */
export function fileSections(doc: PdfDoc): string {
    return doc.pages.map((p) => {
        const body = p.text.trim()
            ? escapeSectionText(p.text.replace(/\n+$/, "")).text
            : p.kind === "scanned" ? `(page ${p.n} is scanned and has no text)` : `(page ${p.n} has no text)`;
        return `<page n="${p.n}">\n${body}\n</page>`;
    }).join("\n");
}

/** Compare names the way a model recalls them: case and inner whitespace aside. */
const nameKey = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, " ");

/** How a reference to an attached file resolved: the file, or the sentence saying why not. */
export type FileResolution = { file: FilePointer; error?: undefined } | { file?: undefined; error: string };

/** The files a run's session holds, by id. Unbounded and never evicted: they are the person's attachments, few, and
 *  held in the value store for the session's life, so a pointer to one must not lapse while its bytes are kept. */
export class FileShelf {
    private byId = new Map<string, FilePointer>();

    /** Hold a file. The same bytes held twice are one file: the pointer already held is returned. */
    note(f: FilePointer): FilePointer {
        for (const g of this.byId.values()) if (g.sha256 === f.sha256) return g;
        this.byId.set(f.id, f);
        return f;
    }

    /** Take back files this caller noted, by id: a message that was not delivered. Only ids the caller itself added
     *  (`attachFiles`' `added`), never a pointer the same bytes resolved to from before, which stays. */
    drop(ids: readonly string[]): void {
        for (const id of ids) this.byId.delete(id);
    }

    /** The earliest other file held under `name`, for a second file's outline. */
    firstNamed(name: string, except?: string): FilePointer | undefined {
        return this.all().find((g) => g.id !== except && nameKey(g.name) === nameKey(name));
    }

    /** Every file, in the order attached. */
    all(): FilePointer[] { return [...this.byId.values()].sort((a, b) => a.turn - b.turn); }

    get size(): number { return this.byId.size; }

    /**
     * Resolve `@file:<id>` or `@file:"name"`. The forms are told apart by shape. A name two files share is refused,
     * listing both, never resolved to the latest: a draft and its revision answer differently.
     * @param ref the reference, with or without the prefix
     */
    resolve(ref: string): FileResolution {
        const bare = String(ref).trim().replace(/^@file:/, "");
        const quoted = /^["'](.*)["']$/s.exec(bare);
        if (quoted) {
            const want = nameKey(quoted[1].replace(/\\(["'\\])/g, "$1"));
            const hits = this.all().filter((g) => nameKey(g.name) === want);
            if (hits.length === 1) return { file: hits[0] };
            if (hits.length > 1) {
                const list = hits.map((g) => `  - ${fileRef(g)} (${fileSizeSaid(g)}, attached in turn ${g.turn})`).join("\n");
                return { error: `${hits.length} attached files are named ${quoteName(hits[0].name)}:\n${list}\nRead one by its id, or ask the person which one they meant.` };
            }
            return { error: this.fault(bare) };
        }
        const hit = isTokenShape(bare) ? this.byId.get(bare) : undefined;
        if (hit) return { file: hit };
        const named = this.all().find((g) => nameKey(g.name) === nameKey(bare));
        if (named) return { error: `'${FILE_PREFIX}${bare}' is a file NAME, and a name must be quoted: ${FILE_PREFIX}${quoteName(named.name)}, or by id ${fileRef(named)}.` };
        return { error: this.fault(bare) };
    }

    /** The sentence for a reference that names no attached file, listing those there are. */
    private fault(bare: string): string {
        const head = `MemoryFault: '${FILE_PREFIX}${bare}' is not a file attached to this session.`;
        if (!this.byId.size) return `${head}\nThe person has attached no file here.`;
        const list = this.all().map((g) => `  - ${fileRef(g)} ${quoteName(g.name)} (${fileSizeSaid(g)}, turn ${g.turn})`).join("\n");
        return `${head}\nAttached files:\n${list}`;
    }
}
