// The SHAPE of a `@tool:<id>` pointer, in one place: how an id is built, and how to tell a mistyped one from
// an invented one. Pure — no DOM, no chrome — so the loop, the answer parser and the pointer store can all
// agree without pulling in anything else.
//
// An id is 6 hex characters of avalanched hash plus ONE check character. The check exists because of what
// this mechanism is FOR: it lets a model reference a large output instead of re-emitting it, and that only
// pays if the model TRUSTS the reference. A corrupted id must therefore fail loudly. Sparsity alone already
// makes a corrupted id unlikely to hit another live pointer (~1 in 8,100 for a single-character typo among
// ~24 live ids), but "unlikely" is a probability, not a property — and the failure it permits is the silent
// one: a real output, from the wrong call. The check character makes EVERY single-character substitution
// structurally invalid, so that class of error can only ever miss.
//
// It also buys a better diagnosis. Without it, a fault cannot tell a mistyped real id from an invented one
// and has to give both the same advice; with it, `@tool:` + 7 hex that fails the check is definitively a
// TYPO, and the model can be told to re-read the id rather than to go run a tool.

/** Hex characters of hash in an id, before the check character. */
export const TOKEN_PAYLOAD_LEN = 6;
/** Total id length. 7 = 6 payload + 1 check; the payload width is what sets the collision space, so the
 *  check is ADDED rather than taken out of the 6 (spending a payload character would have made an INVENTED
 *  id 16x more likely to hit a live one — the more common failure — to fix the rarer typo). */
export const TOKEN_LEN = TOKEN_PAYLOAD_LEN + 1;
/** The id's regex SOURCE, so every place that parses `@tool:<id>` builds its pattern from one definition. */
export const TOKEN_HEX_SRC = `[0-9a-f]{${TOKEN_LEN}}`;

/** Positional weights for the check character. All ODD, therefore coprime to 16, which is what makes every
 *  single-character substitution detectable: changing digit `d` to `d'` at position `i` shifts the sum by
 *  `w_i * (d' - d)`, and with `w_i` coprime to 16 that is 0 mod 16 only when `d' === d`. */
const WEIGHTS = [1, 3, 5, 7, 9, 11];

/** The check character for a payload. */
export function checkChar(payload: string): string {
    let sum = 0;
    for (let i = 0; i < payload.length && i < WEIGHTS.length; i++) sum += WEIGHTS[i] * parseInt(payload[i], 16);
    return (sum % 16).toString(16);
}

/** Does this string have an id's SHAPE (right length, all hex)? True for a mistyped id as well as a valid
 *  one — which is the point: it separates "meant to be an id" from "a tool-name alias". */
export function isTokenShape(s: string): boolean {
    return new RegExp(`^${TOKEN_HEX_SRC}$`).test(s);
}

/** Is this a WELL-FORMED id — right shape AND a matching check character? A false here on something that
 *  {@link isTokenShape} accepts means the model corrupted a real id rather than inventing one. */
export function isTokenValid(s: string): boolean {
    return isTokenShape(s) && s[TOKEN_PAYLOAD_LEN] === checkChar(s.slice(0, TOKEN_PAYLOAD_LEN));
}
