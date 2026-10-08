// deref-read.ts — reading a `@tool:<id>` pointer from the page through the background worker: the value object
// `ml.dereference` resolves to, and the two messages that fetch a pointer's text and a stored table's columns.
// Moved out of ml-agent.ts so tools/ and agent/ can read a pointer without importing the window.ml surface.

import type { Table } from "./contract/contract-fetch";
import type { DerefValue, DerefMeta, DerefRead } from "./contract/contract-pointers";
import type { TokenKind } from "./contract/contract-render";
import { jsonShape, jsonValue } from "./dom";
import { type StoredColumnReader, asTable, tableShape } from "./table/table-data";
import { currentHasTool } from "./tool-exec";

/**
 * The object `ml.dereference` resolves to: the pointer's text, with what the loop knows about it attached.
 *
 * It EXTENDS String, which is the whole trick — every spelling that worked when this returned a bare string
 * still works (`JSON.parse(await ml.dereference(id))`, `${v}`, `v.split("\n")`, `v.length`), while `.type`,
 * `.json` and the rest answer the questions a caller previously had to guess at from the bytes. The one
 * casualty is `typeof v === "string"`, which is now false: compare `v.text`, or `String(v)`.
 *
 * `json` is parsed LAZILY and cached — most reads never ask, and a big capture should not pay for a parse
 * nobody wanted. A non-JSON body leaves it undefined rather than throwing, since asking is how you find out.
 */
export class DerefText extends String implements DerefValue {
    readonly type: TokenKind;
    readonly id: string;
    readonly tool: string;
    readonly step: number;
    readonly label?: string;
    readonly table?: Table;
    readonly image?: string;
    readonly latex?: string;

    #json?: { v: unknown };            // memo: absent = not parsed yet, { v: undefined } = parsed, not JSON
    #repipe: (stages: string | string[]) => Promise<DerefValue>;

    constructor(text: string, meta: DerefMeta | undefined, repipe: (stages: string | string[]) => Promise<DerefValue>, readColumns?: StoredColumnReader) {
        super(text);
        this.type = meta?.kind ?? "text";
        this.id = meta?.id ?? "";
        this.tool = meta?.tool ?? "";
        this.step = meta?.step ?? -1;
        if (meta?.label) this.label = meta.label;
        if (meta?.table) this.table = asTable(meta.table, { python: currentHasTool("python_exec"), ...(readColumns ? { readColumns } : {}) });
        if (meta?.image) this.image = meta.image;
        if (meta?.latex) this.latex = meta.latex;
        this.#repipe = repipe;
    }

    /** The text, explicitly — for a caller that would rather not rely on coercion. */
    get text(): string { return String(this); }

    get json(): unknown {
        if (!this.#json) {
            const t = this.text.trim();
            let v: unknown;
            if (t.startsWith("{") || t.startsWith("[")) { try { v = JSON.parse(t); } catch { v = undefined; } }
            this.#json = { v };
        }
        return this.#json.v;
    }

    /** Reduce this value further through the text-pipe dialect. */
    pipe(stages: string | string[]): Promise<DerefValue> { return this.#repipe(stages); }

    /** The TS-like shape of it. A TABLE describes itself as a frame — its shape and its pandas dtypes —
     *  rather than as the type of its rendered text, which is the same answer `fetch_url`'s `schema: true`
     *  gives for a CSV and the reason `schema` is worth calling on a pointer at all: the structure without
     *  the payload. Otherwise the JSON shape, throwing `ml.schema`'s actionable error on a non-JSON body. */
    schema(): string {
        const t = this.table;
        if (t) return tableShape(t);
        return jsonShape(jsonValue(this.text, `@tool:${this.id || "?"}`));
    }
}

/** Named columns of a stored table, every row, read by the service worker. The same id-matched relay as a pointer read.
 *  `runId` LABELS the request; what entitles it is decided worker-side (background.ts): a background-hosted run holding
 *  the value, or the tab the worker disclosed that key to, which is how a page-hosted run reads one. */
export function columnsViaBackground(runId: string, key: string, names: string[], opts: { delimiter?: string; headerless?: boolean }): Promise<{ rowCount: number; columns: Record<string, (string | number | boolean | null)[]> }> {
    return new Promise((resolve, reject) => {
        const id = `cols-${Math.random().toString(16).slice(2)}`;
        const onMsg = (e: MessageEvent) => {
            const d = e.data as { type?: string; id?: string; rowCount?: number; columns?: Record<string, (string | number | boolean | null)[]>; error?: string } | undefined;
            if (!d || d.type !== "PAGE_VALUE_COLUMNS_RESULT" || d.id !== id) return;
            window.removeEventListener("message", onMsg);
            if (d.error) reject(new Error(d.error)); else resolve({ rowCount: d.rowCount ?? 0, columns: d.columns ?? {} });
        };
        window.addEventListener("message", onMsg);
        window.postMessage({ type: "PAGE_VALUE_COLUMNS", id, runId, key, names, ...opts }, "*");
    });
}

/** Read a `@tool:<id>` pointer from a page-hosted run through the background worker, which holds the run's outputs;
 *  a stored table comes back with a column reader bound to the same run. */
export function derefViaBackground(runId: string, ref: string, pipe?: string | string[]): Promise<DerefRead> {
    return new Promise((resolve, reject) => {
        const id = `deref-${Math.random().toString(16).slice(2)}`;
        const onMsg = (e: MessageEvent) => {
            const d = e.data as { type?: string; id?: string; value?: string; warning?: string; meta?: DerefMeta; error?: string } | undefined;
            if (!d || d.type !== "PAGE_DEREF_RESULT" || d.id !== id) return;
            window.removeEventListener("message", onMsg);
            if (d.error) { reject(new Error(d.error)); return; }
            // A stored table's columns are read through this run too, so the reader is bound here, where the runId is.
            const key = d.meta?.table ? d.meta.value : undefined;
            const table = d.meta?.table;
            resolve({ value: d.value ?? "", ...(d.warning ? { warning: d.warning } : {}), ...(d.meta ? { meta: d.meta } : {}),
                ...(key && table ? { readColumns: (names: string[]) => columnsViaBackground(runId, key, names, { delimiter: table.delimiter, headerless: table.headerless }) } : {}) });
        };
        window.addEventListener("message", onMsg);
        // `pipe` may be an ARRAY of stages (structured-clones fine); `??` not `||` so an array survives.
        window.postMessage({ type: "PAGE_DEREF", id, runId, ref, pipe: pipe ?? "" }, "*");
    });
}
