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

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(ROOT, "src", "contract.ts");
const OUT = join(ROOT, "src", "api-docs.gen.ts");

// Types reachable from MlApi that a console caller never types out: the sidebar's
// render descriptors (a big discriminated union that would triple the doc for zero
// caller value) and the debug-event payloads. Referenced by name, never expanded.
export const SKIP_TYPES = new Set([
    "RenderDescriptor", "LocateSubstep", "ToolRenderInput", "TableSource", "TablePreview",
    "MlConfig",   // MlPublicConfig (a Pick of it) is what the page may actually read
    "MlTool",     // tool-initialisers return one; the model only PASSES it to `tools`, never inspects it
    "ApprovalRequest", "ApprovalDecision",   // callback types for a user-supplied approve() — the model never writes one
    "AgentStepEvent",       // the onStep callback's event — the model never writes an onStep handler from exec
    "AnswerMedia",          // internal render shape (answer element screenshots) — never constructed by a caller
    "AgentTranscriptEntry", // AgentResult.transcript entry shape — internal, not something a caller builds
    "TokenRender",          // INTERNAL: stripped before ml.agent resolves; a model that requested it got a cut-off
                            // section naming an undefined type (model panel, 2026-10-09)
]);

// Public MlApi members the CONSOLE user has but the MODEL should NOT see in its doc — kept in the API, stripped
// from agent_api_docs (they'd only spend tokens on things the agent never uses from exec): `step` (writing your
// own tool loop is too complex to do on the fly), `ready` (a load-timing promise, user-only), `pythonExec`
// (the model uses the `python_exec` TOOL, not this console method).
export const AGENT_HIDDEN = new Set(["step", "ready", "pythonExec"]);

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

\`window.ml\` is chiefly how the USER invokes you, but it is also reachable from your own
\`exec\` tool — those calls run in the page like any other JS, and go through the same human
approval gate, so introspecting yourself is fair game:

    await ml.getModel()      // which model am I running on?
    await ml.config()        // non-secret config (models, API format)
    await ml.ps()            // what's loaded in VRAM right now

Prefer your own tools for page work — they're cheaper and already in your schema. Reserve
\`ml.chat\`/\`ml.agent\` from inside \`exec\` for when you genuinely need a nested model call;
each one spends real time and VRAM, and an \`ml.agent\` inside an agent recurses.

The reference is generated from the extension's TypeScript contract. Members prefixed with
\`_\` are internal plumbing and are omitted.
`;

// Where a run can be started and what a person sees there: served on request (a search), not in the default view,
// which is for finding a method. It used to be the preamble's middle, paid on every first call.
const SURFACES = `## Where a run starts

The console is not the only entry point. A run can also be started and continued from
four UIs: the in-page **Commander HUD** (a Spotlight-style command bar in a corner card),
the **sidebar panel** open over the page, the **DevTools panel**, and the **chat app**,
which is either this browser's own page or a client on another device. **How to open the
HUD on this browser — including the keyboard shortcut actually bound right now — is the
"Opening the HUD" section** (\`search: "HUD"\`). It is read live rather than written here,
because the user can rebind it.

Which of them the person typed in is recorded per message and reported by
\`chat_metadata\`, and it is worth asking for, because it says what they can actually see:
at the HUD they are looking at the page you are working on; in the chat app on another
device they cannot see it at all.

Each \`ml.agent\` run gets a short session hash, and every one of those surfaces shows the
same session under it (and can resume it). Requests flow page -> content script ->
background worker -> the LLM server; the API key and server URL are never exposed to the
page.
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
        const m = /^export (?:abstract )?(interface|type|class) (\w+)\b/.exec(lines[i]);
        if (!m) continue;
        const [, kind, name] = m;
        let end = i, depth = depthDelta(lines[i]);
        // An interface ends when its braces close; a type alias when a `;` lands at depth 0.
        const done = () => kind === "type"
            ? depth === 0 && stripLineComment(lines[end]).trim().endsWith(";")
            : depth === 0 && /[};]\s*$/.test(stripLineComment(lines[end]).trim());
        while (!done()) {
            if (++end >= lines.length) throw new Error(`gen-api-docs: unterminated ${kind} ${name}`);
            depth += depthDelta(lines[end]);
        }
        decls.set(name, { kind, doc: docAbove(lines, i), body: lines.slice(i, end + 1) });
    }
    return decls;
}

/**
 * Where a class member's BODY opens on its first line, or -1 when it has none there. Not the first `{`: a parameter
 * or return type can hold an object type (`rank<T>(c: readonly { key: T }[]): { score: number }[] {`), and cutting
 * there printed `rank<T>(c: readonly;`. The body brace is the last one on a line that ends with `{`, or, for a
 * one-line body, the `{` that opens the balanced group the line ends with.
 *
 * @param {string} line A member's first source line.
 * @returns {number} The index of the body's `{`, or -1.
 */
export function bodyBrace(line) {
    const t = stripLineComment(line).trimEnd();
    if (t.endsWith("{")) return t.lastIndexOf("{");
    if (!t.endsWith("}")) return -1;
    for (let i = t.length - 1, depth = 0; i >= 0; i--) {
        if (t[i] === "}") depth++;
        else if (t[i] === "{" && --depth === 0) return i;
    }
    return -1;
}

/**
 * A CLASS as its declaration surface: member signatures, their JSDoc, no bodies.
 *
 * Classes are indexed because a model can be handed one and expected to CALL it — `ml.embed` returns an
 * `Embedding`, whose whole point is `.dot(other)`, and before this the doc named that type and never defined
 * it. What a caller needs is the signatures; the implementation is noise in a document that costs context on
 * every run, so bodies are dropped by walking the class at depth 1 and skipping anything deeper.
 */
export function classSurface(body) {
    const out = [body[0]];
    let depth = depthDelta(body[0]);
    let pending = [];   // comment lines held until we know whether the member below them is kept
    for (let i = 1; i < body.length - 1; i++) {
        const line = body[i], before = depth;
        depth += depthDelta(line);
        if (before !== 1) continue;                       // inside a member body
        const t = stripLineComment(line).trim();
        if (!t) continue;
        if (/^[/*]/.test(line.trim())) { pending.push(line); continue; }
        // `private`/`protected` members are not callable by the reader this document is for, and dropping the
        // member without its JSDoc would leave the comment explaining it attached to the NEXT one.
        if (/^\s*(private|protected)\b/.test(line)) { pending = []; continue; }
        out.push(...pending); pending = [];
        const cut = bodyBrace(line);
        out.push(cut >= 0 ? `${line.slice(0, cut).trimEnd()};` : line);
    }
    out.push(body[body.length - 1]);
    return out;
}

/**
 * Re-emit an interface verbatim minus its `_`-prefixed members (and their JSDoc).
 * Section comments introducing a dropped run of members go too, so the output has
 * no dangling "---- internal plumbing ----" header over nothing.
 *
 * @param {string[]} body The declaration's source lines.
 * @returns {string[]} The kept lines.
 */
export function stripPrivateMembers(body, extraHidden = new Set()) {
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
        // Dropped: `_`-prefixed plumbing, plus any name in `extraHidden` (AGENT_HIDDEN — public API the console
        // user has but the MODEL shouldn't spend doc tokens on, e.g. `step`/`ready`/`pythonExec`).
        const memberName = (before === 1) ? (trimmed.match(/^([A-Za-z_$][\w$]*)/) || [])[1] : undefined;
        if (before === 1 && (/^_\w/.test(trimmed) || (memberName && extraHidden.has(memberName)))) {
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

// Contract.ts aligns inline `//` comments into a column for human readability — runs of padding spaces the
// MODEL pays tokens for and doesn't need. Trim them for the generated doc: (1) collapse the alignment gap
// before a trailing comment to one space, (2) trim a deeply-indented comment-only continuation to the member
// indent, (3) fold leading 4-space indentation into tabs (one token per level, vs several for the spaces).
// Only touches `//` comments + leading indentation (JSDoc `*` lines' text is untouched); a `//` inside a
// string never has a 2-space run before it, so string literals are safe. NOTE: (3) means the emitted MlApi
// block is TAB-indented — api-docs-query.ts's `splitMembers` accepts a tab OR 4 spaces at the member level.
// (4) An inline type import (`import("./agent/current-context").CurrentSnapshot`) is written as its NAME: the module
// path is ours, not the model's, and the name is what it looks the type up by.
const deAlign = line => line
    .replace(/\bimport\((["'])[^"']+\1\)\./g, "")
    .replace(/(\S)[ \t]{2,}(\/\/)/, "$1 $2")
    .replace(/^ {5,}(\/\/)/, "    $1")
    .replace(/^ +/, sp => "\t".repeat(Math.floor(sp.length / 4)) + " ".repeat(sp.length % 4));

/** Named types mentioned in these lines that `known(name)` can resolve to a declaration. */
const referencedTypes = (lines, known) => {
    const names = new Set();
    for (const name of lines.join("\n").match(/\b[A-Z][A-Za-z0-9_]*\b/g) || []) {
        if (known(name)) names.add(name);
    }
    return names;
};

/* --------------------- resolving a type that is not in contract.ts --------------------- */
// contract.ts is one contract, but it does not have to be one FILE, and a type that moves to a themed module
// must not silently vanish from what the agent reads. It did: moving `FetchResult` out — leaving a re-export
// behind — cut this doc by 10.7% and dropped its `### FetchResult` section, because the generator read exactly
// one file and expanded only what that file declared.
//
// So a name that contract.ts does not declare is resolved through the IMPORT THAT BINDS IT, recursively.
// Through the import, not by searching the tree for the name: two modules may declare the same name, and a
// generator that picked a winner by scan order would put the wrong definition in front of the model.
//
// DEMAND-DRIVEN, and that is the whole safety argument. Only a name something already REFERENCES is ever
// looked up, so this can add nothing that was not already named in the doc — where walking every import
// eagerly would pull unrelated declarations into `known`, and `referencedTypes` matches any capitalised word.
// The doc is model-facing context that is re-sent on every run; growing it by accident is a real cost.
const MAX_MODULES = 64;   // a cycle is already handled by `visited`; this bounds a pathological import graph

/** Resolve `spec` (a relative import path) against `from`, as TypeScript would. */
const moduleFile = (from, spec) => {
    const base = join(dirname(from), spec);
    for (const c of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) if (existsSync(c)) return c;
    return null;
};

/** The bindings a module re-exports or imports BY NAME, plus the modules it re-exports wholesale. */
const moduleLinks = (file, text) => {
    const byName = new Map();   // exported/imported name → the file that should declare it
    const wildcard = [];        // `export * from "./x"` — searched only after a named binding misses
    const rel = /["'](\.[^"']+)["']/;
    for (const m of text.matchAll(/(?:import|export)\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["'](\.[^"']+)["']/g)) {
        const target = moduleFile(file, m[2]);
        if (!target) continue;
        for (const part of m[1].split(",")) {
            // `A as B` binds B here but is declared as A there; the doc names what the caller sees.
            const [orig, alias] = part.replace(/\btype\s+/, "").split(/\s+as\s+/).map(x => x.trim());
            if (orig) byName.set((alias || orig), { file: target, as: orig });
        }
    }
    for (const m of text.matchAll(/export\s+\*\s+from\s*["'](\.[^"']+)["']/g)) {
        const t = moduleFile(file, m[1]);
        if (t) wildcard.push(t);
    }
    // `import("./x").Name` — the inline form, which this codebase uses heavily in contract.ts itself.
    for (const m of text.matchAll(/import\((["'])(\.[^"']+)\1\)\.(\w+)/g)) {
        const t = moduleFile(file, m[2]);
        if (t && !byName.has(m[3])) byName.set(m[3], { file: t, as: m[3] });
    }
    return { byName, wildcard, rel };
};

/** A declaration index over contract.ts that follows its imports on demand. */
export function makeResolver(entry) {
    const mods = new Map();   // file → { decls, links }
    const load = (file) => {
        let m = mods.get(file);
        if (!m) {
            if (mods.size >= MAX_MODULES) return null;
            const text = readFileSync(file, "utf8");
            // contract.ts's own modules are written for this parser and must parse; a module reached only through
            // another one's imports may not (a class body it cannot follow), and its declarations are then left out
            // rather than failing the build: an unparsed type is named in the doc, just not defined there.
            let decls;
            try { decls = parseDecls(text); } catch (e) { if (file === entry || /[\\/]contract[\\/]/.test(file)) throw e; decls = new Map(); }
            m = { decls, links: moduleLinks(file, text) };
            // Each declaration remembers its file, so the names IT mentions are resolved through ITS imports.
            for (const d of m.decls.values()) d.file = file;
            mods.set(file, m);
        }
        return m;
    };
    const memo = new Map();
    const find = (name, file, visited) => {
        if (!file || visited.has(file)) return null;
        visited.add(file);
        const m = load(file);
        if (!m) return null;
        if (m.decls.has(name)) return m.decls.get(name);
        const link = m.links.byName.get(name);
        if (link) {
            const hit = find(link.as, link.file, visited);
            if (hit) return hit;
        }
        for (const w of m.links.wildcard) {
            const hit = find(name, w, visited);
            if (hit) return hit;
        }
        return null;
    };
    /** `name` as `file` sees it: declared there, or bound by one of its imports. Defaults to contract.ts. */
    const get = (name, file = entry) => {
        const key = `${file}\0${name}`;
        if (!memo.has(key)) memo.set(key, find(name, file, new Set()));
        return memo.get(key);
    };
    return { get, has: (name, file) => !!get(name, file), modules: () => mods.size };
}

/* ------------------------------- generation -------------------------------- */

/**
 * Build the agent-facing API reference from contract.ts, split into servable PARTS.
 *
 * The `agent_api_docs` tool serves these piecewise (api-docs-query.ts): MlApi + a type
 * index by default, a named type on demand. Keeping them separate here is what makes that
 * possible — a single pre-joined blob couldn't be sliced back apart reliably.
 *
 * @returns {{preamble: string, mlApi: string, types: Record<string,string>}}
 *   `preamble` framing prose; `mlApi` the object's ```ts section; `types` each referenced
 *   option/result type's `### name` section (transitively reached, minus SKIP_TYPES), sorted.
 */
export function generateApiParts() {
    const text = readFileSync(SOURCE, "utf8");
    const decls = parseDecls(text);
    const resolve = makeResolver(SOURCE);
    const api = decls.get("MlApi");
    if (!api) throw new Error("gen-api-docs: no `export interface MlApi` in contract.ts");

    const apiLines = stripPrivateMembers(api.body, AGENT_HIDDEN);
    if (apiLines.some(l => /^\s{4}_\w/.test(l))) throw new Error("gen-api-docs: `_` member survived the strip");
    const mlApi = ["## `ml` — the object on `window`\n", "```ts", ...apiLines.map(deAlign), "```\n"].join("\n");

    // Tool-INITIALISER methods return an MlTool — and the model only ever PASSES that result to a run
    // (`ml.agent("…", { tools: [ml.lookTool()] })`), it never constructs or inspects the tool. So `MlTool` is
    // OPAQUE — shown by name in signatures, never expanded — which drops its whole implementation subtree
    // (ToolResult/ToolContext/…). And a type referenced ONLY from a tool-initialiser's signature (its option
    // objects, e.g. VisionMemory) is never SEEDED, so it drops too — while a type ALSO used elsewhere (e.g.
    // ShotBox via pythonExec's return) is still reached from that other use. Detected structurally: a member
    // line whose return type is `MlTool`.
    const returnsMlTool = l => /\):\s*MlTool\b/.test(l) || /:\s*MlTool;\s*$/.test(l);
    // …but the OPTIONS are seeded, which is the correction. The rule above is about the RETURN: the model
    // passes an MlTool to a run and never inspects it, so expanding it would drag in its whole implementation
    // subtree. It does CONSTRUCT the argument, though, and dropping a tool-initialiser's line entirely took the
    // option types with it — `ml.lookTool({ memory })` named `VisionMemory` and the model had no way to reach
    // its definition, because a type absent from the corpus cannot be queried either.
    //
    // Cheap now for a reason that was not true when the rule was written: this reference is served through
    // api-docs-query.ts, which returns a default view and expands on demand under GRAPH_BUDGET. Completeness
    // costs a query, not every run. Measured: one new section, +2.3 KB.
    const seedLines = apiLines.map(l => (returnsMlTool(l) ? l.replace(/\):\s*MlTool\b.*$/, ")") : l));

    // BFS the types MlApi's public members mention, then the types THOSE mention. `MlTool` is seeded as OPAQUE.
    // A name is resolved from the file whose declaration MENTIONS it: `CurrentSnapshot` (agent/current-context.ts)
    // names `MessageMeta`, which contract.ts never imports, and asking contract.ts for it found nothing, so the doc
    // named a type it did not define. First binding wins per name, as before.
    const seen = new Set(["MlApi", "MlTool", ...SKIP_TYPES]);
    const queue = [];
    const enqueue = (names, file) => {
        for (const n of names) {
            // Its own file first; then contract.ts, for a contract type named in prose (`RunStats.genBasis`).
            const decl = resolve.get(n, file) ?? resolve.get(n);
            if (decl && !seen.has(n)) { seen.add(n); queue.push([n, decl]); }
        }
    };
    enqueue(referencedTypes(seedLines, (n) => resolve.has(n)), SOURCE);   // seed from non-tool-initialiser signatures only

    const found = [];
    while (queue.length) {
        const [name, decl] = queue.shift();
        const body = decl.kind === "interface" ? stripPrivateMembers(decl.body)
            : decl.kind === "class" ? classSurface(decl.body) : decl.body;
        found.push([name, `### ${name}\n\n\`\`\`ts\n${[...decl.doc, ...body].map(deAlign).join("\n")}\n\`\`\`\n`]);
        enqueue(referencedTypes([...decl.doc, ...body], (n) => resolve.has(n, decl.file) || resolve.has(n)), decl.file);
    }
    // Alphabetical, so the output doesn't churn when contract.ts is reordered.
    found.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    return { preamble: PREAMBLE, surfaces: SURFACES, mlApi, types: Object.fromEntries(found) };
}

/** The member lines of an interface body at its own level, JSDoc and line comments skipped (a brace in prose must not
 *  move the depth). Each as written, without its trailing `;`. */
function memberLines(body) {
    const members = [];
    let depth = 0, inDoc = false;
    for (const raw of body.slice(1, -1)) {
        const l = raw.trim();
        if (inDoc || l.startsWith("/*")) { inDoc = !l.includes("*/"); continue; }
        if (l.startsWith("//")) continue;
        const code = stripLineComment(raw).trim();
        if (depth === 0 && /^\w+\??:/.test(code)) members.push(code.replace(/;$/, ""));
        depth += depthDelta(code);
    }
    return members;
}

/**
 * `ml.current`'s top-level members as one line, lifted from `CurrentSnapshot` itself, so the system prompt's
 * self-introspection clause (`currentClause`, prompts.ts) can never describe a shape the code no longer has. Each type it
 * names is followed by its FIELD NAMES (`MessageMeta[] (id, ts, tokens, …)`), from that type's declaration: the real
 * models this was tried on looked for `tokens` on the messages, because a bare type name says nothing about what is in
 * it. The types themselves are what `agent_api_docs` expands.
 * @param resolve from {@link makeResolver}
 * @returns {string} `{ run: CurrentRun (id, model, …); messages: NeutralMessage[] (role, content, …); … }`
 */
export function currentSignature(resolve) {
    const d = resolve.get("CurrentSnapshot");
    if (!d) throw new Error("gen-api-docs: no `CurrentSnapshot` reachable from contract.ts");
    // A type's field names: an interface's members; an alias's, through the interfaces it names plus its inline keys.
    const fieldsOf = (name, seen = new Set()) => {
        const t = resolve.get(name, d.file) ?? resolve.get(name);
        if (!t || seen.has(name)) return [];
        seen.add(name);
        if (t.kind === "interface") return memberLines(t.body).map((m) => m.match(/^\w+/)[0]);
        const text = t.body.join(" ");
        const named = [...text.matchAll(/\b([A-Z]\w+)\b/g)].flatMap(([, n]) => n === name ? [] : fieldsOf(n, seen));
        const inline = [...text.matchAll(/[{;,]\s*(\w+)\??:/g)].map(([, k]) => k);
        return [...named, ...inline];
    };
    const annotate = (member) => member.replace(/\b([A-Z]\w+)(\[\])?/g, (all, n, arr) => {
        const f = fieldsOf(n);
        return f.length ? `${n}${arr ?? ""} (${f.join(", ")})` : all;
    });
    return `{ ${memberLines(d.body).map(annotate).join("; ")} }`;
}

/** Join the parts back into the single flat reference (the shape older callers/tests expect). */
export function fullDoc({ preamble, surfaces, mlApi, types }) {
    return [preamble, surfaces, mlApi, "## Option & result types\n", ...Object.values(types)].join("\n");
}

/**
 * Build the agent-facing API reference from contract.ts.
 *
 * @returns {string} Markdown: the preamble, MlApi's public members, then every
 *   option/result type they reference (transitively, minus SKIP_TYPES).
 */
export function generateApiDocs() {
    return fullDoc(generateApiParts());
}

/** Serialize the reference into the `api-docs.gen.ts` module injected.js imports. */
export function renderModule() {
    const parts = generateApiParts();
    return "// GENERATED by scripts/gen-api-docs.mjs from contract.ts — do not edit.\n" +
        "// Regenerated on every build; `npm test` fails if it is stale.\n" +
        `export const ML_API_DOCS = ${JSON.stringify(fullDoc(parts))};\n` +
        `export const ML_API_PARTS = ${JSON.stringify(parts)};\n` +
        `/** \`ml.current\`'s members, one line, from \`CurrentSnapshot\` (gen-api-docs.mjs \`currentSignature\`). */\n` +
        `export const CURRENT_SIGNATURE = ${JSON.stringify(currentSignature(makeResolver(SOURCE)))};\n`;
}

/** Regenerate api-docs.gen.ts in place. Called by build.mjs (and directly by npm scripts). */
export function writeApiDocs() {
    const module = renderModule();
    // Skip the write when unchanged, so a --watch build doesn't retrigger itself.
    try { if (readFileSync(OUT, "utf8") === module) return OUT; } catch { /* not written yet */ }
    writeFileSync(OUT, module);
    return OUT;
}

if (process.argv[1] && process.argv[1].endsWith("gen-api-docs.mjs")) {
    console.log(`generated ${writeApiDocs()}`);
}
