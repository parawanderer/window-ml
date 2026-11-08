// token-prefixes.ts — the prefixes that mark a pointer token, a value window.ml holds and the model names by token.
//
// A leaf: no imports, so a module that only needs to RECOGNISE a token (the shell call's argv refusal, bundled for a
// neutral platform) does not pull in the DOM, tables and Arrow behind the modules that mint them.

/** The sentinel that marks a tool-output reference (cf. `@pt:`/`@box:`). A CSS selector can't start with
 *  it (`@…` begins an at-rule, not a selector), so it unambiguously means "a token", never a selector. */
export const TOOL_TOKEN_PREFIX = "@tool:";

/** The prefix of an attached file's pointer, beside `@tool:`: the value came from the person, not a tool call. */
export const FILE_PREFIX = "@file:";

/** The prefix of a viewport point `locate` minted (`POINT_RE`, util.ts): a place on the page, held per tab. */
export const POINT_PREFIX = "@pt:";

/** The prefix of a viewport box `locate` minted (`BOX_RE`, util.ts): a region of the page, held per tab. */
export const BOX_PREFIX = "@box:";
