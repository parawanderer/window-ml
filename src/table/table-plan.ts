// table-plan.ts — the plan a stored table's read carries, and its closed-shape check: small, so the content script and
// the worker check a page's message without loading the parsers.

/** What one stored read asks for beside its column names: the most rows it returns (a `head` view's `n`). The flat plan
 *  the worker checks field by field (docs/spec/ML_TABLE.md, "Views of a stored table in JS"); slice B adds `where`. */
export type StoredReadPlan = { limit?: number };

/** The fields a stored read's message may carry (docs/spec/ML_TABLE.md, "Views of a stored table in JS"): the flat plan,
 *  with `names` for its columns, plus the routing a relay adds. A message with any other field is refused. */
export const STORED_READ_FIELDS: readonly string[] = ["type", "id", "runId", "op", "key", "names", "delimiter", "headerless", "limit"];

/** A stored read's message checked against the closed shape: no field outside {@link STORED_READ_FIELDS}, and a `limit`
 *  that is absent or a whole number from 0. Answers the plan, or what is wrong with the message. Nothing in a plan is
 *  code, and every reader of a page's message checks it here. */
export function checkReadPlan(msg: Record<string, unknown>): StoredReadPlan | { refused: string } {
    const extra = Object.keys(msg).find((k) => !STORED_READ_FIELDS.includes(k));
    if (extra !== undefined) return { refused: `a stored read has no field ${JSON.stringify(extra.slice(0, 40))}` };
    const limit = msg.limit;
    if (limit === undefined || limit === null) return {};
    if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 0) return { refused: "a stored read's limit is a whole number from 0" };
    return { limit };
}
