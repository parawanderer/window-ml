// grant-extract.ts — STATIC extraction of the persistable egress grants inside an approved tool call.
//
// Button #3 ("Approve + remember these URLs") persists a session-wide consent for the URLs an `exec`'s
// inline `ml.fetch()` calls will hit — but ONLY the ones spelled out as string LITERALS, because you can
// only remember a URL the human actually SAW in the approval. A dynamic `ml.fetch(someVar)` has no
// concrete URL at approval time, so it stays one-off (button #2's ephemeral grant), which is the correct
// security boundary, not a limitation.
//
// This runs BACKGROUND-side (unforgeable): the same extraction feeds both the descriptor shown to the
// human AND the set the background actually persists, so what you approve is exactly what you get — a
// hostile page can't widen it by lying about the code, because the background parses the code itself.
//
// It is a real parser (acorn), not a regex: `ml.fetch` inside a comment or a string is NOT a call, and a
// template with an interpolation (`\`${host}/x\``) is NOT a static literal. Pure + chrome-free → unit-tested
// standalone (tests/grant-extract.test.mjs).

import { parse } from "acorn";
import type { PersistGrant } from "./contract";

/** Minimal acorn-node shape — we only read `type`, member/call fields, and literal values. */
type Node = { type: string; [k: string]: unknown };

/** Statically extract the persistable grants from a tool call's args. Returns [] when there's nothing to
 *  remember (no matching tool, unparseable code, or only dynamic targets). Registry-driven: add an entry
 *  to EXTRACTORS as new `ml.*` egress functions ship. */
export function extractGrants(tool: string, args: Record<string, unknown>): PersistGrant[] {
    const fn = EXTRACTORS[tool];
    return fn ? fn(args) : [];
}

const EXTRACTORS: Record<string, (args: Record<string, unknown>) => PersistGrant[]> = {
    // `exec` runs arbitrary JS; its inline `ml.fetch("…")` literals are the persistable egress.
    exec: (args) => {
        const js = typeof args.js === "string" ? args.js : "";
        const urls = fetchUrlLiterals(js);
        return urls.length ? [{ kind: "fetch-url", urls }] : [];
    },
};

/** Walk exec JS for `ml.fetch("literal")` / `window.ml.fetch(\`literal\`)` calls with a STATIC string
 *  first argument, returning the distinct URLs in source order. Dynamic args (a variable, an interpolated
 *  template) are skipped. Unparseable code → [] (falls through to the one-off grant). */
export function fetchUrlLiterals(js: string): string[] {
    let ast: Node;
    // exec bodies run wrapped in an async function, so top-level await / return / super are legal there —
    // allow them here too, or a perfectly normal `await ml.fetch(...)` would fail to parse → miss the grant.
    try { ast = parse(js, { ecmaVersion: "latest", allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true, allowSuperOutsideMethod: true }) as unknown as Node; }
    catch { return []; }
    const out: string[] = [];
    walk(ast, (node) => {
        if (node.type !== "CallExpression") return;
        if (!isMlFetchCallee(node.callee as Node)) return;
        const url = staticString((node.arguments as Node[])[0]);
        if (url) out.push(url);
    });
    return [...new Set(out)];
}

/** Depth-first walk over an acorn AST, visiting every node (any child that is itself a node or an array of
 *  nodes). Deliberately generic — no acorn-walk dependency, and it doesn't need to know the grammar. */
function walk(node: Node | null | undefined, visit: (n: Node) => void): void {
    if (!node || typeof node.type !== "string") return;
    visit(node);
    for (const key of Object.keys(node)) {
        const v = (node as Record<string, unknown>)[key];
        if (Array.isArray(v)) { for (const c of v) walk(c as Node, visit); }
        else if (v && typeof v === "object" && typeof (v as Node).type === "string") walk(v as Node, visit);
    }
}

/** Is this callee `ml.fetch` or `window.ml.fetch` (non-computed member access)? */
function isMlFetchCallee(callee: Node | undefined): boolean {
    if (!callee || callee.type !== "MemberExpression" || callee.computed) return false;
    if ((callee.property as Node | undefined)?.name !== "fetch") return false;
    const obj = callee.object as Node | undefined;
    if (obj?.type === "Identifier" && obj.name === "ml") return true;                       // ml.fetch(…)
    return obj?.type === "MemberExpression" && !obj.computed                                // window.ml.fetch(…)
        && (obj.property as Node | undefined)?.name === "ml"
        && (obj.object as Node | undefined)?.type === "Identifier"
        && (obj.object as Node | undefined)?.name === "window";
}

/** The string value of a STATIC argument: a string literal, or a template literal with no interpolations
 *  (a single quasi). Anything else (a variable, a number, an interpolated template) → null. */
function staticString(node: Node | undefined): string | null {
    if (!node) return null;
    if (node.type === "Literal" && typeof node.value === "string") return node.value;
    if (node.type === "TemplateLiteral") {
        const expressions = node.expressions as unknown[], quasis = node.quasis as Node[];
        if (expressions.length === 0 && quasis.length === 1) {
            const cooked = (quasis[0].value as { cooked?: string } | undefined)?.cooked;
            return typeof cooked === "string" ? cooked : null;
        }
    }
    return null;
}
