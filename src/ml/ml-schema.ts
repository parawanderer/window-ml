// ml-schema.ts — `ml.schema`, the TypeScript-like shape of JSON values, as a pure function the page and the worker share.

import { jsonShape, jsonValue, joinShapes } from "../dom/dom";
import { tableShape } from "../table/table-data";

/** `ml.schema`: the TypeScript-like type of some JSON, or the JOINED type of several, and a table as a frame. Pure,
 *  so the worker can offer it to a read-only survey as well as the page. */
export async function mlSchema(...values: unknown[]): Promise<string> {
    const vs = await Promise.all(values);
    if (!vs.length) throw new Error("ml.schema needs at least one value — pass a JSON value, a JSON string, a fetch result, or a pointer read.");
    const label = (i: number) => vs.length === 1 ? "the argument" : `argument ${i + 1}`;
    // A TABLE has a structure, but not a JSON one: its rows are a matrix, so a JSON shape of them
    // says `(string | number)[][]` — true, and useless. Describe it as a FRAME instead (the same
    // answer `fetch_url`'s `schema: true` and a pointer's `.schema()` give), so asking a CSV for its
    // schema returns its columns and dtypes rather than the type of its text.
    const asTable = (v: unknown): import("../contract").TableLike | undefined =>
        (v && typeof v === "object" ? (v as { table?: import("../contract").TableLike }).table : undefined);
    if (vs.some(asTable)) {
        return vs.map((v, i) => {
            const t = asTable(v);
            const prefix = vs.length === 1 ? "" : `${label(i)}: `;
            return prefix + (t ? tableShape(t) : jsonShape(jsonValue(v, label(i))));
        }).join("\n\n");
    }
    return joinShapes(vs.map((v, i) => jsonValue(v, label(i))));
}
