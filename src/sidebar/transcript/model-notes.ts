// model-notes.ts — the sentences the worker appends to a tool's result for the MODEL, which a person reading the same output has no use for.

/** The result text without the notes written to the model alone: why an exec ran in an isolated world (`sw-isolated-exec.ts`)
 *  and how long `ml.sh` waited for the person (`sw-run-host.ts`). An output embedded in an answer shows this; the step's own
 *  raw view keeps the full text, which is what the model saw. Each note is one parenthesised line at the start of its
 *  own line, matched by its opening words, so a result that merely mentions them mid-line is left alone. */
export function withoutModelNotes(result: string): string {
    return result
        .replace(/\n*^\(Ran in an isolated world because[^\n]*\)[ \t]*$/gm, "")
        .replace(/\n*^\(ml\.sh waited \d+ s for the person to approve\.\)[ \t]*$/gm, "")
        .replace(/\s+$/, "");
}
