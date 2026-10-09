// A ctags-like index over the generated `window.ml` API reference.
//
// The full reference (contract.ts → gen-api-docs.mjs → api-docs.gen.ts) is large: MlApi's
// members plus every option/result type they reach, transitively. Paying all of that into
// context on every `agent_api_docs` call is wasteful when the model usually wants one method
// and the handful of types that method touches. So the generator emits the reference in PARTS
// — the preamble, the MlApi object, and a map of type-name → its section — and this module
// slices them on demand.
//
// The load-bearing query is BY MEMBER, because that's how an agent actually reaches for this:
// it doesn't start from a type name, it starts from an intent ("I want to call ml.fetch"). So:
//
//   • default (no args)   → the core preamble + ONE LINE per member + the type names.
//   • { members: [...] }   → each method's own signature+JSDoc PLUS the type sections its
//                            signature reaches, followed to the leaves within GRAPH_BUDGET (the
//                            "everything I need to call this" view).
//   • { types: [...] }     → a specific type section by name (the precise second step).
//   • { search: "term" }   → scan every member and type section for the term and return the hits.
//
// It is DELIBERATELY pure (no chrome, no DOM, no runtime state) so it unit-tests standalone.
// The member/edge graph is read straight out of `mlApi` + `types` here — no extra generated
// data — which keeps api-docs.gen.ts lean and this module self-contained. The tool's
// runtime-only sections (HUD shortcut, source commit, read-only note) are appended by tools.ts.

/** The generated reference, split so it can be served piecewise. Emitted by gen-api-docs.mjs. */
export interface ApiDocsParts {
    /** The framing prose: what window.ml is, agent-vs-chat, reaching `ml` from your own `exec`. */
    preamble: string;
    /** "Where a run starts": the UIs, what `chat_metadata` reports, session hashes. Served by a search, not by the
     *  default view, which is for finding a method. Optional so a fixture can leave it out. */
    surfaces?: string;
    /** The `## \`ml\` — the object on \`window\`` section: MlApi's public members as one ```ts block. */
    mlApi: string;
    /** `typeName → its \`### typeName\` markdown section`, in alphabetical order. */
    types: Record<string, string>;
}

/**
 * A runtime-resolved section the tool supplies (the live HUD shortcut, the source commit, the
 * read-only-exec note). It can't be baked into the generated reference — it's true only right now
 * — so it's passed in per call. Named in the default view and served by a search, because "how do I
 * open the HUD?" is a thing the model reaches for via `search`, not by re-reading the no-args view.
 */
export interface EnvSection {
    /** A short label for name-matching a search (e.g. "Opening the HUD"). */
    name: string;
    /** The rendered markdown section (already has its own `##` heading). */
    body: string;
}

/** What the `agent_api_docs` tool accepts. None set → the default MlApi + index view. */
export interface ApiDocsQuery {
    /** Expand these `ml` methods: each one's signature/JSDoc + the types its signature references. */
    members?: string[];
    /** Expand these referenced types in full, by name (case-insensitive; `"MlApi"` → the object). */
    types?: string[];
    /** Scan every member and type section for this term and return what mentions it. */
    search?: string;
    /** If you used this tool before but you critically need to re-read a definition, set this to force a fresh
     *  full re-print. Do NOT set it if you recently checked the definitions you need. Default off. */
    fresh?: boolean;
}

// A query that matches a huge number of sections (a common word like "string", or JSDoc prose)
// would dump the whole reference back — defeating the point. Past this many hits in one bucket,
// we list names instead of expanding.
const MAX_SECTIONS = 8;

// When expanding a member/type, we follow its type graph to the leaves and include the WHOLE closure if its DEEPER
// part fits this many characters, because a second `agent_api_docs` round-trip costs a full turn (the system prompt
// re-sends), so a few KB of maybe-unused type defs is the cheaper trade. The types asked for, and a member's one-hop
// types, are always shown and never counted: when they were, `members: ["fetch"]` spent the budget on FetchResult
// and left out Table and TableCell, the types a CSV caller needed next (six of seven panel models paid a call for
// it, 2026-10-09). Past the budget the deeper tail is named, not expanded. ~12 KB ≈ 3 K tokens.
export const GRAPH_BUDGET = 12000;

/* --------------------- reading the member graph out of MlApi --------------------- */

interface Member { name: string; block: string; }

/** Strip a `//` line comment so brace counting isn't fooled by one. */
const stripLineComment = (line: string): string => {
    const i = line.indexOf("//");
    return i === -1 ? line : line.slice(0, i);
};

/** Net brace/paren/bracket depth a line adds (contract.ts has no braces inside string literals here). */
const depthDelta = (line: string): number => {
    let d = 0;
    for (const ch of stripLineComment(line)) {
        if (ch === "{" || ch === "(" || ch === "[") d++;
        else if (ch === "}" || ch === ")" || ch === "]") d--;
    }
    return d;
};

/** The `export interface MlApi { … }` source lines, lifted out of the ```ts fence in `mlApi`. */
const mlApiBody = (mlApi: string): string[] => {
    const m = mlApi.match(/```ts\n([\s\S]*?)\n```/);
    return m ? m[1].split("\n") : [];
};

/**
 * Split the MlApi block into per-member blocks (each = its leading JSDoc + its declaration,
 * multi-line signatures included). Same depth-counting the generator's line scanner uses;
 * degrades to `[]` if the block can't be read (then a member query reports "unknown" rather
 * than throwing inside the running extension).
 */
const splitMembers = (mlApi: string): Member[] => {
    const lines = mlApiBody(mlApi);
    if (!lines.length) return [];
    const members: Member[] = [];
    let doc: string[] = [];
    let depth = depthDelta(lines[0]);   // the interface's opening brace → members live at depth 1
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i], t = line.trim();
        if (depth === 1 && (t.startsWith("/*") || t.startsWith("*") || t.startsWith("//") || t.endsWith("*/"))) {
            doc.push(line);
            continue;
        }
        // Member at the interface's own level: one tab (the generated doc) OR four spaces (test fixtures). A `readonly`
        // PROPERTY is a member too (`state`, `current`): read past the modifier, or its JSDoc rode on to the next
        // method and `{ members: ["current"] }` answered "not found".
        const nameMatch = depth === 1 ? /^(?:\t| {4})(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*[?(<:]/.exec(line) : null;
        if (nameMatch) {
            const start = i;
            depth += depthDelta(line);
            // Consume continuation lines until the member statement closes at the interface's own level.
            while (!(depth === 1 && /[;}]\s*$/.test(stripLineComment(lines[i]).trim()))) {
                if (++i >= lines.length) break;
                depth += depthDelta(lines[i]);
            }
            members.push({ name: nameMatch[1], block: [...doc, ...lines.slice(start, i + 1)].join("\n") });
            doc = [];
            continue;
        }
        if (!t) doc = [];       // a blank line ends a comment's association with the next member
        depth += depthDelta(line);
    }
    return members;
};

/** Type names (that the reference actually defines) mentioned in a chunk of source. */
const typesIn = (text: string, typeNames: Set<string>): string[] => {
    const found = new Set<string>();
    for (const tok of text.match(/\b[A-Z][A-Za-z0-9_]*\b/g) || []) if (typeNames.has(tok)) found.add(tok);
    return [...found];
};

/**
 * The full transitive closure of type names reachable from `seeds`, in BFS order (seeds first,
 * then the types THEY reference, and so on to the leaves). Cycle-safe. This is the "graph the
 * model asked for" — expanded all at once when it's small enough, so it needn't drill repeatedly.
 */
const closureTypes = (parts: ApiDocsParts, seeds: string[]): string[] => {
    const known = new Set(Object.keys(parts.types));
    const order: string[] = [];
    const seen = new Set<string>();
    const queue = seeds.filter(s => known.has(s));
    for (const s of queue) seen.add(s);
    while (queue.length) {
        const name = queue.shift() as string;
        order.push(name);
        for (const t of typesIn(parts.types[name], known)) if (!seen.has(t)) { seen.add(t); queue.push(t); }
    }
    return order;
};

/**
 * The reference for a run that does not have some `ml` members (ml-member-tools.ts): those members' blocks are cut out
 * of `mlApi`, and a type goes with them when nothing left reaches it. A type a remaining member also uses stays, so
 * hiding `answer` never costs the reader a type `agent` needs.
 * @param parts the full reference
 * @param hidden member names this run does not have
 * @returns the reference as this run should see it; `parts` itself when nothing is hidden
 */
export function withoutMembers(parts: ApiDocsParts, hidden: string[]): ApiDocsParts {
    if (!hidden.length) return parts;
    const drop = new Set(hidden);
    const members = splitMembers(parts.mlApi);
    const gone = members.filter(m => drop.has(m.name));
    if (!gone.length) return parts;
    const known = new Set(Object.keys(parts.types));
    const kept = new Set(closureTypes(parts, members.filter(m => !drop.has(m.name)).flatMap(m => typesIn(m.block, known))));
    const orphaned = new Set(closureTypes(parts, gone.flatMap(m => typesIn(m.block, known))).filter(t => !kept.has(t)));
    let mlApi = parts.mlApi;
    for (const m of gone) mlApi = mlApi.replace(m.block + "\n", "");
    const types: Record<string, string> = {};
    for (const [name, section] of Object.entries(parts.types)) if (!orphaned.has(name)) types[name] = section;
    return { ...parts, mlApi, types };
}

/* ---------------------- within-burst dedup (see DocsMemory) ---------------------- */

/** interface vs. type alias, for the "already seen" stub label. */
const sectionKind = (section: string): string => /export\s+type\s/.test(section) ? "type" : "interface";

/**
 * Emit a chunk in full, OR — if `seen` already holds its key (shown earlier in this contiguous dig) — a
 * compact one-line stub like `[interface FetchResult already seen]`, so a burst of docs calls doesn't
 * re-print the same definition. Records the key on a full emit. `seen === undefined` disables dedup.
 */
const piece = (seen: Set<string> | undefined, key: string, stub: string, full: string): string => {
    if (!seen) return full;
    if (seen.has(key)) return stub;
    seen.add(key);
    return full;
};

/* ------------------------------- the views ------------------------------- */

/** The sections a search reaches beyond members and types: the run's live environment and where a run starts. */
const searchable = (parts: ApiDocsParts, env: EnvSection[]): EnvSection[] =>
    parts.surfaces ? [...env, { name: "Where a run starts", body: parts.surfaces }] : env;

/** A member's JSDoc reduced to its first sentence, and its declaration on one line. */
const gist = (m: Member): { signature: string; summary: string } => {
    const lines = m.block.split("\n");
    const declAt = lines.findIndex(l => /^(?:\t| {4})(?:readonly\s+)?[A-Za-z_$]/.test(l) && !/^\s*(\/\*|\*)/.test(l));
    const doc = lines.slice(0, declAt < 0 ? 0 : declAt).filter(l => !/^\s*\/\*\s*-{2,}/.test(l))
        .map(l => l.replace(/^\s*(\/\*\*|\*\/|\*)\s?/, "").replace(/\*\/\s*$/, "")).join(" ").replace(/\s+/g, " ").trim();
    const first = doc.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? doc;
    const signature = lines.slice(declAt < 0 ? 0 : declAt).join(" ").replace(/\s+/g, " ").trim().replace(/;$/, "");
    return { signature, summary: first };
};

/** The section a member sits under in MlApi (`/* ---- chat ---- *\/`), when it has one. */
const sectionOf = (m: Member): string | null => m.block.match(/\/\*\s*-{2,}\s*(.*?)\s*-{2,}\s*\*\//)?.[1] ?? null;

/**
 * The default view: what exists, compactly. The core preamble, then ONE LINE per `ml` member (its declaration and the
 * first sentence of its doc) under MlApi's own section markers, the type names, and how to drill in. Full JSDoc is
 * served only by `members`, so nothing the default printed comes back again on the drill-in. The panel (2026-10-09)
 * measured the old default, which printed every member's full doc plus the environment sections, as 60-95% noise
 * for a task and the largest reply of a session.
 */
const defaultView = (parts: ApiDocsParts, env: EnvSection[], seen?: Set<string>): string => {
    const members = splitMembers(parts.mlApi);
    const lines: string[] = ["## `ml`: every member, one line each", ""];
    for (const m of members) {
        const section = sectionOf(m);
        if (section) lines.push("", `### ${section}`, "");
        const { signature, summary } = gist(m);
        lines.push(`- \`${signature}\`${summary ? `: ${summary}` : ""}`);
    }
    const more = searchable(parts, env).map(e => `"${e.name}"`);
    const index = [
        "## Going deeper",
        "",
        "Full docs come by name; a member brings the types its signature uses, followed to their leaves:",
        "",
        '    agent_api_docs({ members: ["fetch", "agent"] })   // methods, full doc, with their types',
        '    agent_api_docs({ types: ["FetchResult"] })         // a type by name',
        '    agent_api_docs({ search: "screenshot" })           // every section mentioning a term',
        "",
        `Types: ${Object.keys(parts.types).join(", ")}.`,
        ...(more.length ? ["", `Also searchable by name: ${more.join(", ")} (how you are opened, your source commit, what you can read about your own setup, where runs start).`] : []),
    ].join("\n");
    return [
        piece(seen, "preamble", "[intro already seen]", parts.preamble),
        piece(seen, "index", "[the member index already seen]", lines.join("\n").replace(/\n{3,}/g, "\n\n")),
        index,
    ].join("\n");
};

/**
 * Expand `ml` methods and/or named types, following each one's type graph. The types a member's
 * signature references directly (one hop) and any explicit `types` are GUARANTEED; then the deeper
 * transitive tail is included too, all the way to the leaves, as long as that tail fits
 * GRAPH_BUDGET — so a small graph comes back complete in one call and the model needn't drill again.
 * Over budget, the tail is named (with `types:[...]`) rather than expanded. Everything de-dupes.
 */
const expand = (parts: ApiDocsParts, wantMembers: string[], wantTypes: string[], seen?: Set<string>): string => {
    const typeNames = new Set(Object.keys(parts.types));
    const members = splitMembers(parts.mlApi);
    const byName = new Map(members.map(m => [m.name.toLowerCase(), m]));

    const out: string[] = [];
    const emittedMembers = new Set<string>();
    const missing: string[] = [];
    const guaranteed = new Set<string>();   // one-hop member types + explicit types: always shown
    let showMlApi = false;

    for (const req of wantMembers) {
        const m = byName.get(req.trim().toLowerCase());
        if (!m) { missing.push(req); continue; }
        if (emittedMembers.has(m.name)) continue;   // repeats / different casings of the same method
        emittedMembers.add(m.name);
        out.push(piece(seen, `member:${m.name}`, `[ml.${m.name} already seen]`,
            `## \`ml.${m.name}\`\n\n\`\`\`ts\n${m.block}\n\`\`\`\n`));
        for (const t of typesIn(m.block, typeNames)) guaranteed.add(t);
    }
    for (const req of wantTypes) {
        const want = req.trim().toLowerCase();
        if (want === "mlapi") { showMlApi = true; continue; }
        const key = [...typeNames].find(n => n.toLowerCase() === want);
        if (key) guaranteed.add(key); else missing.push(req);
    }
    if (showMlApi) out.push(piece(seen, "ml", "[the ml object (methods) already seen]", parts.mlApi));

    // Walk the whole graph the request reaches. Guaranteed types are always emitted; the rest of the
    // closure fills the remaining budget (best-fit, so one huge type can't starve small useful ones).
    // An already-seen section costs only its one-line stub, so it never consumes budget or gets deferred.
    const reachable = closureTypes(parts, [...guaranteed]);
    const bonus: string[] = [];
    let budget = GRAPH_BUDGET;
    for (const t of reachable) {
        const section = parts.types[t];
        const key = `type:${t}`;
        if (seen?.has(key)) { out.push(`[${sectionKind(section)} ${t} already seen]`); continue; }
        if (guaranteed.has(t) || section.length <= budget) {
            out.push(section);
            seen?.add(key);
            if (!guaranteed.has(t)) { budget -= section.length; bonus.push(t); }
        }
    }
    const deferred = reachable.filter(t => !guaranteed.has(t) && !bonus.includes(t) && !seen?.has(`type:${t}`));

    // Tell the model whether it has the complete picture — so it doesn't waste a round-trip checking.
    if (reachable.length && !deferred.length) {
        out.push("> ✓ Complete: every type reachable from what you asked for is expanded above " +
            "(followed to its leaves). Nothing more to fetch.");
    } else if (deferred.length) {
        out.push(`> Also reachable, not expanded to keep this small: ${deferred.join(", ")}. ` +
            "Fetch any with `agent_api_docs({ types: [...] })`.");
    }
    if (missing.length) {
        out.push(`> Not found: ${missing.join(", ")}. ` +
            `Members: ${members.map(m => m.name).join(", ")}. Types: MlApi, ${Object.keys(parts.types).join(", ")}.`);
    }
    return out.join("\n");
};

/**
 * Scan every member, type section, AND runtime/environment section for `term` and return the hits.
 * Matching is TOKENIZED — a section matches when it contains ALL the words in the term (not the
 * contiguous phrase), so "keyboard shortcut" finds the HUD section that says "Keyboard: … shortcut".
 * Environment hits come first (a "how do I open the HUD" search wants that, not a type that name-drops
 * "HUD" in prose). Member/type hits are each capped so a broad term degrades to a name list.
 */
const searchDocs = (parts: ApiDocsParts, term: string, env: EnvSection[], seen?: Set<string>): string => {
    const tokens = term.toLowerCase().split(/\s+/).filter(Boolean);
    const hit = (s: string): boolean => { const l = s.toLowerCase(); return tokens.every(t => l.includes(t)); };

    const envHits = env.filter(e => hit(e.name) || hit(e.body));
    const members = splitMembers(parts.mlApi);
    const memberHits = members.filter(m => hit(m.name) || hit(m.block));

    const typeNames = Object.keys(parts.types);
    const nameHits = typeNames.filter(n => hit(n));
    const bodyHits = typeNames.filter(n => !nameHits.includes(n) && hit(parts.types[n]));
    const typeHits = [...nameHits, ...bodyHits];

    const out: string[] = [];
    out.push(...envHits.map(e => piece(seen, `env:${e.name}`, `[${e.name} already seen]`, e.body)));
    if (memberHits.length > MAX_SECTIONS) {
        out.push(`## \`ml\` members matching "${term}" (${memberHits.length})`, "",
            `${memberHits.map(m => `\`${m.name}\``).join(", ")} — expand with \`agent_api_docs({ members: [...] })\`.`);
    } else if (memberHits.length) {
        out.push(...memberHits.map(m => piece(seen, `member:${m.name}`, `[ml.${m.name} already seen]`,
            `## \`ml.${m.name}\`\n\n\`\`\`ts\n${m.block}\n\`\`\`\n`)));
    }
    if (typeHits.length > MAX_SECTIONS) {
        out.push(`## Types matching "${term}" (${typeHits.length} — too many to expand)`, "",
            `${typeHits.join(", ")}.`, "",
            `Expand the ones you want: \`agent_api_docs({ types: [${typeHits.slice(0, 3).map(n => `"${n}"`).join(", ")}] })\`.`);
    } else if (typeHits.length) {
        out.push(...typeHits.map(n => piece(seen, `type:${n}`, `[${sectionKind(parts.types[n])} ${n} already seen]`, parts.types[n])));
    }
    if (!out.length) {
        return `No member or type mentions "${term}". Members: ${members.map(m => m.name).join(", ")}. ` +
            `Types: ${typeNames.join(", ")}.`;
    }
    return out.join("\n");
};

/**
 * Slice the API reference per the query. Pure: the tool resolves its runtime-only sections
 * (HUD shortcut, source commit, read-only note) and passes them in as `env`.
 *
 * @param parts The generated reference parts (ML_API_PARTS).
 * @param q     `{ members }`/`{ types }` to expand, `{ search }` to scan (with either, both are returned), none for the
 *              default view.
 * @param env   Runtime/environment sections (HUD shortcut, source, …): named in the default view, served
 *              by a search. The tool resolves these live and passes them only when the view can use them.
 * @param seen  The run's within-burst dedup set (DocsMemory.shown): a chunk whose key is already in it is
 *              printed as a one-line stub instead of in full, and a full emit adds its key. Omit to disable.
 */
export function queryApiDocs(parts: ApiDocsParts, q: ApiDocsQuery = {}, env: EnvSection[] = [], seen?: Set<string>): string {
    const search = q.search?.trim();
    const members = (q.members ?? []).filter(s => s && s.trim());
    const types = (q.types ?? []).filter(s => s && s.trim());
    // Both, when both are asked: a search used to replace the members and types it came with, so a call asking
    // for three new types plus a search printed only the search's one already-seen stub. The expansion goes first
    // and marks what it printed, so the search then stubs those instead of printing them twice.
    if (members.length || types.length) {
        const view = expand(parts, members, types, seen);
        return search ? `${view}\n\n${searchDocs(parts, search, searchable(parts, env), seen)}` : view;
    }
    if (search) return searchDocs(parts, search, searchable(parts, env), seen);
    return defaultView(parts, env, seen);
}

/** True when the query is the default (MlApi + index) view — the tool appends runtime sections only then. */
export const isDefaultQuery = (q: ApiDocsQuery = {}): boolean =>
    !(q.search && q.search.trim()) &&
    !(q.members ?? []).some(s => s && s.trim()) &&
    !(q.types ?? []).some(s => s && s.trim());
