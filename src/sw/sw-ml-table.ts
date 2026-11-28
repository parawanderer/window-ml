// sw-ml-table.ts — `ml.table` over the wire: the member a cell's `t = ml.table(src)` calls (docs/spec/ML_TABLE.md).

// Two callers, one answer shape (table-answer.ts `TableAnswer`):
// - A run the worker built reads the source when the cell calls it, judged exactly as a `tables` source was
//   (worker-tools.ts `workerTableRead`). A Google Sheet the person has not approved asks: inside the dialect the whole
//   cell goes to the person (`Asks`, raised in the cell as `NotInDialect`); in an approved cell it is a nested ask on the
//   running step.
// - A cell a page started (`ml.pythonExec` from a page script, a page-built run before hand-over) has no run here to read
//   for, so the page read the sources written as literals in the code before the cell (ml-python.ts `hoistTables`), the
//   worker checked them (sw-python.ts), and the member answers from those. Any other source raises at the call.

import { WireError, type WireClient, type WireMember } from "./ml-wire-serve";
import { derefByRun, isWorkerRun, sessionTokens } from "./sw-runs";
import { valueHolders } from "./sw-values";
import { raiseAsk } from "./sw-asks";
import { tableCtxOf, workerTableRead } from "./worker-tools";
import { hoistKey, tableOpts, UNHOISTED_TABLE, type TableAnswer } from "../python/table-answer";

/** An answer as it crosses: the log's preview and row count stay here. */
const crossing = ({ preview: _p, rowCount: _r, ...a }: TableAnswer): Omit<TableAnswer, "preview" | "rowCount"> => a;

/**
 * The `table` member this client has, or undefined when it has none: a client bound to a run the worker built, or one
 * that carries a page's hoisted tables.
 * @param client the wire client
 * @returns the member
 */
export function tableMemberFor(client: WireClient): WireMember | undefined {
    const run = client.run;
    if (run && isWorkerRun(run)) return {
        run: async (src: unknown, opts?: unknown) => {
            const ctx = tableCtxOf(run);
            if (!ctx) throw new WireError("Absent", "ml.table is not available here: this run has no tab to read for");
            const o = tableOpts(opts);
            const answer = await workerTableRead(ctx, src, o, {
                deref: derefByRun.get(run),
                file: (ref) => sessionTokens(run).files.resolve(ref),
                holds: async (key) => (await valueHolders(key))?.includes(run) ?? false,
                sheet: (id, url) => sheetAsk(client, run, id, url),
            });
            ctx.pyCall?.read?.push({ src: String(src), answer });
            return crossing(answer);
        },
    };
    const hoisted = client.tables;
    if (hoisted) return {
        run: async (src: unknown, opts?: unknown) => {
            if (typeof src !== "string") throw new WireError("BadRequest", "ml.table takes a source string");
            const a = hoisted.get(hoistKey(src, tableOpts(opts)));
            if (!a) throw new WireError("Absent", `ml.table(${JSON.stringify(src)}): ${UNHOISTED_TABLE}`);
            if ("error" in a) throw new WireError("Failed", a.error);
            return crossing(a);
        },
    };
    return undefined;
}

/**
 * A Sheet this call was not approved for. Inside the dialect it is the cell's to ask (`Asks`): the cell goes to the
 * person, with the Sheet on its card when the code names it as a literal. In an approved cell it is a nested ask on the
 * step that started the code; a client opened by no step can raise none, and is refused.
 * @param client the wire client
 * @param run its run
 * @param id the Sheet's id
 * @param url the Sheet's URL as the source named it
 * @throws `Asks`, or `Denied` when the person declines or nobody can be asked
 */
async function sheetAsk(client: WireClient, run: string, id: string, url: string): Promise<void> {
    if (client.realm !== "full") throw new WireError("Asks", `it reads the Google Sheet ${id} with the person's login, which needs their approval`);
    if (!client.step) throw new WireError("Denied", `ml.table reads the Google Sheet ${id} with the person's login, and this cell has no step to ask on`);
    const o = await raiseAsk(run, client.step.seq, { kind: "sheet", facts: { sheet: url, id } });
    if (!o.allowed) throw new WireError("Denied", `ml.table: reading the Google Sheet ${id} was ${o.state === "denied" ? "declined" : `not approved (${o.state})`}`);
}
