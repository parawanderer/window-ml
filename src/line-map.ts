// MAP LINE NUMBERS ACROSS A WHITESPACE-ONLY REFORMAT.
//
// Any pretty-printer we show code through moves line numbers, and a stack trace's entire content is a line
// number — so the rendered view and the error text silently stop agreeing. The Python formatter builds its
// own map as it goes, but `js-beautify` (which `exec`'s In block runs through) gives nothing back, and
// writing a second bespoke map per formatter is how they drift.
//
// This derives one from the two TEXTS, which works for any formatter that only moves whitespace: strip the
// whitespace from both and they are the same string, so a position in that stripped stream identifies the
// same code in each. Walk both, remember which line each stripped character came from, and the map falls out.
//
// It REFUSES rather than guesses. If the two do not agree once whitespace is removed, the formatter changed
// something — and a map derived from a mismatch would point confidently at the wrong line, which is worse
// than the un-mapped number the reader could at least distrust.
//
// ONE THING IT CANNOT SEE, said plainly rather than pretended away: whitespace INSIDE a string literal.
// `'a  b'` and `'a b'` strip to the same characters, so a formatter that re-spaced a string would be mapped
// as though nothing happened. Telling them apart needs a tokenizer per language, which is the thing this
// exists to avoid — and both formatters that use it copy strings byte-for-byte (py-format asserts it; a
// beautifier that reflowed string contents would be broken in its own right). If a third one ever does not,
// this is the guard that will not catch it.

/** Which line of the stripped stream each character came from, and the stripped text itself. */
function strip(src: string): { text: string; line: number[] } {
    let text = "";
    const line: number[] = [];
    let n = 1;
    for (const ch of src) {
        if (ch === "\n") { n++; continue; }
        if (ch === " " || ch === "\t" || ch === "\r") continue;
        text += ch;
        line.push(n);
    }
    return { text, line };
}

/**
 * Original 1-based line → formatted 1-based line, or null when the two texts are not the same code.
 *
 * A line with no code on it (blank, or whitespace only) has no character to anchor on, so it takes the
 * mapping of the next line that does — which is where a reader looking for it would land anyway.
 */
export function lineMapBetween(original: string, formatted: string): number[] | null {
    const a = strip(original), b = strip(formatted);
    // The whole safety property in one comparison: same tokens, same order, only the spacing moved.
    if (a.text !== b.text) return null;
    const map: number[] = [];
    // First, the lines that HAVE code: anchor each on its first non-space character.
    for (let i = 0; i < a.line.length; i++) {
        const from = a.line[i];
        if (map[from] == null) map[from] = b.line[i];
    }
    // Then the blank ones, backwards, so each takes the next line that does have code — and a trailing run of
    // blanks takes the last line rather than falling off the end.
    const total = original.split("\n").length;
    const last = map.filter((v) => v != null).pop() ?? 1;
    for (let n = total; n >= 1; n--) map[n] = map[n] ?? (map[n + 1] ?? last);
    return map;
}
