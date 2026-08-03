// Generate the agent-facing `window.ml` API reference FROM contract.ts.
//
// The `agent_api_docs` tool hands the model this text so it can answer questions
// about its own host ("how do I call you from the console?") and about the API a
// page script would use. Nobody curates a second copy of the docs by hand — the
// TypeScript interface IS the documentation, so this script lifts it: the public
// (non-`_`) members of `MlApi`, their JSDoc, and the option/return types they
// reference, transitively.
//
// It's a line scanner, not a real parser: `typescript@7` is the Go port and ships
// no JS compiler API, and pulling in a second TypeScript just to read one file is
// worse than 80 lines of brace counting. It leans on contract.ts's house style
// (top-level `export interface X {`, one member per line, JSDoc above) and THROWS
// if that stops holding, rather than silently emitting a truncated doc.
//
// Writes `api-docs.gen.ts` (gitignored, like dist/). Run by build.mjs before
// bundling and by `npm run typecheck`; `tests/api-docs.test.js` regenerates and
// diffs it, so a contract.ts edit can never leave the shipped doc stale.
//
//   node scripts/gen-api-docs.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(ROOT, "contract.ts");
const OUT = join(ROOT, "api-docs.gen.ts");

// Types reachable from MlApi that a console caller never types out: the sidebar's
// render descriptors (a big discriminated union that would triple the doc for zero
// caller value) and the debug-event payloads. Referenced by name, never expanded.
const SKIP_TYPES = new Set([
    "RenderDescriptor", "LocateSubstep", "ToolRenderInput", "TableSource", "TablePreview",
    "MlConfig",   // MlPublicConfig (a Pick of it) is what the page may actually read
]);

// The framing the interface itself can't carry — what window.ml IS and where it
// lives. Everything after this point is lifted from the source.
const PREAMBLE = `# window.ml — public API

You are running inside **window.ml**, a Chrome extension (Manifest V3) that injects a
\`window.ml\` object into the MAIN WORLD of every page and bridges it to local LLMs via
OpenWebUI / Ollama. It is a console-first primitive, not a chat app: the deliverable is
an object you call from any page's devtools console or from a userscript.

That is how a human drives it — and how YOU were started:

    await ml.agent("hide every post about crypto")      // <- an agent run, like this one
    await ml.chat("write a haiku about tuesdays")       // a raw model call
    const chat = ml.createChat({ system: "..." }); await chat.chat("hi")
    ml.ready.then(() => console.log("window.ml is live"))

**\`agent\` and \`chat\` are NOT interchangeable, and this is the distinction people get
wrong.** Only \`ml.agent\` can see or touch the page: it runs a tool loop over the live DOM,
which is what YOU are. \`ml.chat\`/\`ml.createChat\` are raw model calls — the model receives
only the prompt string (plus any \`images\`) and has no DOM access and no tools, so
\`ml.chat("what's on this page?")\` cannot work. To ask a plain question about the page from
the console you must either extract the text yourself and pass it in
(\`ml.chat("Summarise: " + document.body.innerText)\`) or use \`ml.agent\`.

The console is not the only entry point: the user can also start a run from the
extension's in-page HUD (a Spotlight-style command bar). **How to open the HUD on this
browser — including the keyboard shortcut actually bound right now — is in the "Opening
the HUD" section at the END of this document.** It is read live rather than written here,
because the user can rebind it.

Each \`ml.agent\` run gets a short session hash, visible in the extension's debug
sidebar (and resumable). Requests flow page -> content script -> background worker ->
the LLM server; the API key and server URL are never exposed to the page.

\`window.ml\` is chiefly how the USER invokes you, but it is also reachable from your own
\`exec\` tool — those calls run in the page like any other JS, and go through the same human
approval gate, so introspecting yourself is fair game:

    await ml.getModel()      // which model am I running on?
    await ml.config()        // non-secret config (models, API format)
    await ml.ps()            // what's loaded in VRAM right now

Prefer your own tools for page work — they're cheaper and already in your schema. Reserve
\`ml.chat\`/\`ml.agent\` from inside \`exec\` for when you genuinely need a nested model call;
each one spends real time and VRAM, and an \`ml.agent\` inside an agent recurses.

The reference below is generated from the extension's TypeScript contract, so the
signatures are exact. Members prefixed with \`_\` are internal plumbing and are omitted.
`;

/* ----------------------------- the line scanner ---------------------------- */

/** Strip `//` line comments so brace counting isn't fooled by one (block comments
 *  are handled by the caller, which never counts inside them). */
const stripLineComment = line => {
    const i = line.indexOf("//");
    return i === -1 ? line : line.slice(0, i);
};

/** Net brace/paren/bracket depth a line adds. contract.ts has no braces inside
 *  string literals in the declarations we scan, so a raw count is exact. */
const depthDelta = line => {
    const code = stripLineComment(line);
    let d = 0;
    for (const ch of code) {
        if (ch === "{" || ch === "(" || ch === "[") d++;
        else if (ch === "}" || ch === ")" || ch === "]") d--;
    }
    return d;
};

/** The contiguous comment block immediately above `i` (JSDoc and/or `//` lines). */
const docAbove = (lines, i) => {
    let start = i;
    while (start > 0) {
        const prev = lines[start - 1].trim();
        if (prev.endsWith("*/") || prev.startsWith("*") || prev.startsWith("/*") || prev.startsWith("//")) start--;
        else break;
    }
    return lines.slice(start, i);
};

/**
 * Index every top-level `export interface X {…}` / `export type X = …;` in the file.
 *
 * @param {string} text contract.ts source.
 * @returns {Map<string, {kind: "interface"|"type", doc: string[], body: string[]}>}
 *   `body` is the declaration's own source lines, verbatim.
 */
export function parseDecls(text) {
    const lines = text.split("\n");
    const decls = new Map();
    for (let i = 0; i < lines.length; i++) {
        const m = /^export (interface|type) (\w+)\b/.exec(lines[i]);
        if (!m) continue;
        const [, kind, name] = m;
        let end = i, depth = depthDelta(lines[i]);
        // An interface ends when its braces close; a type alias when a `;` lands at depth 0.
        const done = () => kind === "interface"
            ? depth === 0 && /[};]\s*$/.test(stripLineComment(lines[end]).trim())
            : depth === 0 && stripLineComment(lines[end]).trim().endsWith(";");
        while (!done()) {
            if (++end >= lines.length) throw new Error(`gen-api-docs: unterminated ${kind} ${name}`);
            depth += depthDelta(lines[end]);
        }
        decls.set(name, { kind, doc: docAbove(lines, i), body: lines.slice(i, end + 1) });
    }
    return decls;
}

/**
 * Re-emit an interface verbatim minus its `_`-prefixed members (and their JSDoc).
 * Section comments introducing a dropped run of members go too, so the output has
 * no dangling "---- internal plumbing ----" header over nothing.
 *
 * @param {string[]} body The declaration's source lines.
 * @returns {string[]} The kept lines.
 */
export function stripPrivateMembers(body) {
    const out = [];
    let depth = 0, pendingDoc = [], inBlockComment = false;
    for (let i = 0; i < body.length; i++) {
        const line = body[i], trimmed = line.trim();
        // Buffer comments: they belong to whatever member comes next, so they're only
        // committed once we know that member survives.
        if (inBlockComment || trimmed.startsWith("/*") || (depth === 1 && trimmed.startsWith("//"))) {
            if (trimmed.startsWith("/*")) inBlockComment = !trimmed.includes("*/");
            else if (inBlockComment && trimmed.includes("*/")) inBlockComment = false;
            pendingDoc.push(line);
            continue;
        }
        const before = depth;
        depth += depthDelta(line);
        // A member starts at the interface's own level (depth 1 after the header line).
        if (before === 1 && /^_\w/.test(trimmed)) {
            pendingDoc = [];                       // drop the member AND its doc
            while (depth > 1 && i + 1 < body.length) depth += depthDelta(body[++i]);   // multi-line member
            continue;
        }
        // A blank line ends a comment's association with the next member.
        if (!trimmed && pendingDoc.length) { out.push(...pendingDoc, line); pendingDoc = []; continue; }
        out.push(...pendingDoc, line);
        pendingDoc = [];
    }
    // Tidy the tail: drop buffered comments that introduced a dropped block (e.g. the
    // "---- internal plumbing ----" header) and the blank lines they left behind, so the
    // closing brace doesn't float below a gap.
    const close = out.length && /^\s*\}/.test(out[out.length - 1]) ? out.pop() : null;
    while (out.length && !out[out.length - 1].trim()) out.pop();
    out.push(close ?? "}");
    return out;
}

/** Named types mentioned in these lines that contract.ts actually declares. */
const referencedTypes = (lines, known) => {
    const names = new Set();
    for (const name of lines.join("\n").match(/\b[A-Z][A-Za-z0-9_]*\b/g) || []) {
        if (known.has(name)) names.add(name);
    }
    return names;
};

/* ------------------------------- generation -------------------------------- */

/**
 * Build the agent-facing API reference from contract.ts.
 *
 * @returns {string} Markdown: the preamble, MlApi's public members, then every
 *   option/result type they reference (transitively, minus SKIP_TYPES).
 */
export function generateApiDocs() {
    const text = readFileSync(SOURCE, "utf8");
    const decls = parseDecls(text);
    const api = decls.get("MlApi");
    if (!api) throw new Error("gen-api-docs: no `export interface MlApi` in contract.ts");

    const apiLines = stripPrivateMembers(api.body);
    if (apiLines.some(l => /^\s{4}_\w/.test(l))) throw new Error("gen-api-docs: `_` member survived the strip");
    const out = [PREAMBLE, "## `ml` — the object on `window`\n", "```ts", ...apiLines, "```\n"];

    // BFS the types MlApi's public members mention, then the types THOSE mention.
    const seen = new Set(["MlApi", ...SKIP_TYPES]);
    const queue = [];
    const enqueue = names => {
        for (const n of names) if (decls.has(n) && !seen.has(n)) { seen.add(n); queue.push(n); }
    };
    enqueue(referencedTypes(apiLines, decls));

    const sections = [];
    while (queue.length) {
        const name = queue.shift();
        const decl = decls.get(name);
        const body = decl.kind === "interface" ? stripPrivateMembers(decl.body) : decl.body;
        sections.push(`### ${name}\n\n\`\`\`ts\n${[...decl.doc, ...body].join("\n")}\n\`\`\`\n`);
        enqueue(referencedTypes(body, decls));
    }
    // Alphabetical, so the output doesn't churn when contract.ts is reordered.
    sections.sort();
    out.push("## Option & result types\n", ...sections);
    return out.join("\n");
}

/** Serialize the reference into the `api-docs.gen.ts` module injected.js imports. */
export function renderModule(docs) {
    return "// GENERATED by scripts/gen-api-docs.mjs from contract.ts — do not edit.\n" +
        "// Regenerated on every build; `npm test` fails if it is stale.\n" +
        `export const ML_API_DOCS = ${JSON.stringify(docs)};\n`;
}

/** Regenerate api-docs.gen.ts in place. Called by build.mjs (and directly by npm scripts). */
export function writeApiDocs() {
    const module = renderModule(generateApiDocs());
    // Skip the write when unchanged, so a --watch build doesn't retrigger itself.
    try { if (readFileSync(OUT, "utf8") === module) return OUT; } catch { /* not written yet */ }
    writeFileSync(OUT, module);
    return OUT;
}

if (process.argv[1] && process.argv[1].endsWith("gen-api-docs.mjs")) {
    console.log(`generated ${writeApiDocs()}`);
}
