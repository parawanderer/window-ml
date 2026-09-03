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


// ---- the OTHER half of the namespace: tool names ----
// A `@tool:` reference has three DISJOINT forms, and they are told apart by SHAPE alone:
//   @tool:"a label"    quoted        -> the model's own label
//   @tool:a1b2c3f      token-shaped  -> a minted id
//   @tool:python_exec  bare word     -> a tool alias
// That only works if a tool name can never be mistaken for an id. The charset does NOT give this for free:
// `deadbee` is a perfectly good identifier AND a valid token shape. So the rule is enforced here, at the one
// place tools are defined, rather than assumed and documented.

/** The shape a tool name must have: an identifier, no spaces, not starting with a digit. Also the alias
 *  branch of the answer grammar, so a tool that can be defined can always be cited by name. */
export const TOOL_NAME_SRC = "[A-Za-z_][A-Za-z0-9_]*";

/** Why this tool name is unusable, or null if it is fine. Returned rather than thrown so the caller can
 *  phrase the error (`ml.defineTool` throws; a test can assert). */
export function toolNameError(name: unknown): string | null {
    if (typeof name !== "string" || !name) return "a tool needs a name";
    if (!new RegExp(`^${TOOL_NAME_SRC}$`).test(name)) {
        return `tool name ${JSON.stringify(name)} must be letters, digits and underscores only, not starting with a digit `
            + `(it is used bare in a @tool: reference, where a space or punctuation would not parse)`;
    }
    // The collision the shape-based dispatch depends on not existing.
    if (isTokenShape(name)) {
        return `tool name ${JSON.stringify(name)} looks like a generated output id (${TOKEN_LEN} hex characters), `
            + `so @tool:${name} would be ambiguous — rename it`;
    }
    return null;
}
