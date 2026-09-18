// The generated `window.ml` API reference (scripts/gen-api-docs.mjs → api-docs.gen.ts),
// which the `agent_api_docs` tool hands the model so it can answer questions about its own
// host. The whole point of generating it is that it can't drift from contract.ts, so the
// load-bearing test here is the FRESHNESS diff — plus the two properties the extractor is
// responsible for: `_` plumbing stays out, and the option types get expanded (a bare
// `chat(prompt, options?)` teaches the model nothing about `schema`/`think`/`onToken`).
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { generateApiDocs, renderModule, parseDecls, stripPrivateMembers, AGENT_HIDDEN } from "../scripts/gen-api-docs.mjs";
import * as genApi from "../scripts/gen-api-docs.mjs";
import { SKIP_TYPES as SKIP } from "../scripts/gen-api-docs.mjs";

const CONTRACT = readFileSync(new URL("../src/contract.ts", import.meta.url), "utf8");
const docs = generateApiDocs();

/** The MlApi member names contract.ts declares, split into public and `_` plumbing. */
const apiMembers = () => {
    const body = parseDecls(CONTRACT).get("MlApi").body;
    const names = [];
    for (const line of body) {
        const m = /^ {4}(\w+)[(?:<]/.exec(line);      // a member at the interface's own indent
        if (m) names.push(m[1]);
    }
    return { public: names.filter(n => !n.startsWith("_")), private: names.filter(n => n.startsWith("_")) };
};

test("api-docs.gen.ts is up to date with contract.ts (run `npm run gen-api-docs`)", () => {
    const onDisk = readFileSync(new URL("../src/api-docs.gen.ts", import.meta.url), "utf8");
    assert.equal(onDisk, renderModule(),
        "api-docs.gen.ts is stale — contract.ts changed since the last build.");
});

test("every public, non-AGENT_HIDDEN MlApi member reaches the doc", () => {
    const { public: pub } = apiMembers();
    assert.ok(pub.length > 15, `expected a real API surface, parsed ${pub.length} members`);
    for (const name of pub.filter(n => !AGENT_HIDDEN.has(n))) assert.match(docs, new RegExp(`\\b${name}\\b`), `${name} missing from the docs`);
});

test("AGENT_HIDDEN members are kept in the API but stripped from the agent doc", () => {
    const { public: pub } = apiMembers();
    for (const name of AGENT_HIDDEN) assert.ok(pub.includes(name), `${name} should still be a public MlApi member (only hidden from the doc)`);
    // Their SIGNATURES don't appear (a `name(...)` call form) — `ready` legitimately shows in a preamble example.
    for (const name of ["step", "pythonExec"]) assert.doesNotMatch(docs, new RegExp(`\\n\\s*${name}\\(`), `${name}'s signature leaked into the doc`);
});

test("`_` plumbing is stripped — members, their JSDoc, and the section header", () => {
    const { private: priv } = apiMembers();
    assert.ok(priv.length > 5, `expected internal members in MlApi, parsed ${priv.length}`);
    for (const name of priv) assert.doesNotMatch(docs, new RegExp(`\\b${name}\\s*\\(`), `${name} leaked into the docs`);
    // The `/* ---- internal plumbing ---- */` header introduces only dropped members, so it
    // goes with them (the preamble's own mention of the convention is fine and stays).
    assert.doesNotMatch(docs, /---- internal plumbing/i);
});

test("option/result types are expanded, not just named", () => {
    // The reason the generator chases type references at all: the model needs the option
    // fields, not `options?: ChatOptions`.
    for (const type of ["ChatOptions", "AgentOptions", "MlHistory", "AgentResult", "FetchResult"]) {
        assert.match(docs, new RegExp(`### ${type}\\b`), `${type} not expanded`);
    }
    assert.match(docs, /schema\?:/, "ChatOptions.schema missing — type expansion didn't reach the fields");
    assert.match(docs, /maxSteps\?:/, "AgentOptions.maxSteps missing");
});

test("EVERY type the doc names is either expanded or deliberately skipped", () => {
    // The real invariant, and the reason the spot-check above is not enough on its own: a named-but-undefined
    // type teaches the model nothing and it cannot tell that something is missing. This was not hypothetical —
    // `DynamicToolNamespace` was named by `ml.dynamicTools` and never defined, because it is declared in
    // another module and the generator used to read only contract.ts. Five hardcoded names could not catch
    // that, and could not catch the next one either.
    const expanded = new Set([...docs.matchAll(/^### (\w+)/gm)].map(m => m[1]));
    // DANGLING means the generator COULD have defined it and did not — asked of the resolver itself, so prose
    // words and ambient DOM/TS names are excluded by construction rather than by a list that would rot.
    const resolve = genApi.makeResolver(new URL("../src/contract.ts", import.meta.url).pathname);

    // Only the fences a caller READS: the MlApi block and each expanded type. A tool-initialiser's own option
    // types are deliberately never seeded (the model passes an MlTool, it never builds one), so those member
    // lines are dropped here exactly as the generator drops them.
    const referenced = new Set();
    for (const fence of docs.match(/```ts\n[\s\S]*?\n```/g) || [])
        for (const line of fence.split("\n")) {
            if (/\):\s*MlTool\b/.test(line) || /:\s*MlTool;\s*$/.test(line)) continue;
            for (const n of line.match(/\b[A-Z][A-Za-z0-9_]*\b/g) || []) referenced.add(n);
        }

    const dangling = [...referenced]
        .filter(n => !expanded.has(n) && !SKIP.has(n) && n !== "MlApi" && n !== "MlTool")
        .filter(n => resolve.has(n));

    assert.deepEqual(dangling, [],
        `named but never defined, so the model reads a type it cannot resolve: ${dangling.join(", ")}.`
        + ` Either the generator cannot reach its declaration (it follows contract.ts's imports — check the`
        + ` binding), or it belongs in SKIP_TYPES with a reason.`);
});

test("a MODULE HEADER never leaks into the doc the model reads", () => {
    // parseDecls takes the comment run directly above a declaration as its documentation. When contract.ts was
    // split by theme, two of the new modules had their file header sitting directly above their first
    // declaration with no blank line and no import between — so the header, which is written for whoever edits
    // the module, was attached to that declaration and printed into the model's API reference. It cost 10 lines
    // of prose about storage keys and worker lifetimes, and it named a type (RequestHint) that then had no
    // section, which is the failure the dangling check catches one step later.
    //
    // A blank line after the header is the fix. This asserts the outcome instead, because the next module
    // written without one should fail here rather than ship.
    const headers = [...docs.matchAll(/^\/\/ ([\w-]+\.tsx?) —.*$/gm)].map(m => m[1]);
    assert.deepEqual(headers, [], `a module's file header reached the model: ${headers.join(", ")}.`
        + ` Put a blank line between the header and the first declaration in that file.`);
});

test("a type that MOVES out of contract.ts is still found, through the import that binds it", () => {
    // contract.ts is one contract; it does not have to be one FILE. Splitting it used to cut this doc by 10.7%
    // in silence. The generator now resolves an unknown name through the import/re-export that binds it, so
    // this asserts the mechanism directly rather than trusting that nobody will ever split the file.
    const { makeResolver } = genApi;
    const r = makeResolver(new URL("../src/contract.ts", import.meta.url).pathname);
    // Declared in contract.ts itself.
    assert.ok(r.has("MlApi"), "a local declaration still resolves");
    // Declared elsewhere and reached only by following contract.ts's own imports.
    assert.ok(r.has("DynamicToolNamespace"), "an imported declaration resolves through the import that binds it");
    // And through the BARREL: contract.ts was split by theme, so these are declared in contract-*.ts files
    // and reach a reader only via `export * from`. This is the case the split actually depends on, and it is
    // load-bearing for about a hundred `import("./contract").X` type queries that no tool would rewrite.
    for (const n of ["ChatOptions", "AgentResult", "MlTool", "FetchResult", "MlConfig", "RenderDescriptor", "MlDebugEvent", "LoadedModel", "StartRunPayload"])
        assert.ok(r.has(n), `${n} moved to a themed module and must still resolve through contract.ts's barrel`);
    assert.ok(!r.has("ThisTypeDoesNotExistAnywhere"), "and an unknown name stays unknown");
});

test("the always-paid MlApi block carries PROSE, not @param/@returns tags", () => {
    // The default `agent_api_docs` view always includes this block, so every run pays for it whatever it asks.
    // contract.ts's house style is prose — it has ZERO @param/@returns in the whole file today, and the tags
    // live in the IMPLEMENTATION (injected.ts), which the generator never reads.
    //
    // This is a guard on that staying true, not a stripper. Stripping would silently discard a sentence someone
    // deliberately wrote; failing here says "that explanation costs every run — put it in the prose above the
    // member, or accept the cost knowingly." If a future view expands types lazily, tags there are pay-per-query
    // and fine; it is the ALWAYS-PAID block this is about.
    const block = /## `ml` — the object on `window`\n\n```ts\n([\s\S]*?)\n```/.exec(docs);
    assert.ok(block, "the MlApi block is what every call pays for — it must be findable");
    const tags = block[1].split("\n").filter(l => /^\s*\*?\s*@(param|returns|throws|example)\b/.test(l));
    assert.deepEqual(tags, [],
        `@param/@returns in MlApi's JSDoc costs context on EVERY run. Write it as prose above the member instead.`);
});

test("an MlTool is opaque, but the OPTIONS you build one with are not", () => {
    // The line between them is what the model DOES with each. It passes an `MlTool` to a run and never
    // inspects it, so expanding it would drag in its whole implementation subtree for nothing. It CONSTRUCTS
    // the argument, though — and until 2026-09-18 a tool-initialiser's whole line was dropped from the seed,
    // which took its option types with it: `ml.lookTool({ memory })` named `VisionMemory` and nothing in the
    // corpus defined it, so the model could not even query for it.
    assert.match(docs, /MlTool/, "MlTool should still be referenced by name in signatures");
    for (const t of ["MlTool", "ToolResult", "ToolContext", "ApprovalRequest"]) {
        assert.doesNotMatch(docs, new RegExp(`### ${t}\\b`), `${t} should be opaque (not expanded) — it's a pass-around detail`);
    }
    assert.match(docs, /### VisionMemory\b/,
        "the `memory` option of lookTool/locateTool is something the model builds, so it must be reachable");
});

test("the doc names the console entry points the agent gets asked about", () => {
    assert.match(docs, /devtools console/i);
    assert.match(docs, /ml\.agent\(/);
});

test("the doc separates agent (sees the page) from chat (raw model call)", () => {
    // Observed failure: asked how to script itself, the agent offered `ml.chat("what are the
    // main…")` as "a quick answer about the page". chat has no DOM access — it gets only the
    // prompt string. Both the preamble and the generated MlApi JSDoc must say so.
    assert.match(docs, /NOT interchangeable/);
    assert.match(docs, /no DOM access and no tools/);
    assert.match(docs, /sees ONLY the\n.*prompt string/s, "MlApi.chat's own JSDoc must carry the caveat");
    assert.match(docs, /page-aware entry point/, "MlApi.agent's JSDoc must claim the page");
});

test("stripPrivateMembers keeps a well-formed interface and drops multi-line `_` members", () => {
    const src = [
        "export interface X {",
        "    /** Kept. */",
        "    keep(a: string): void;",
        "    /* ---- internal ---- */",
        "    /** Dropped. */",
        "    _gone(opts: {",
        "        a: number;",
        "    }): void;",
        "}",
    ];
    const out = stripPrivateMembers(src).join("\n");
    assert.match(out, /keep\(a: string\): void;/);
    assert.doesNotMatch(out, /_gone|Dropped|internal/);
    assert.ok(out.trimEnd().endsWith("}"), `interface left unclosed:\n${out}`);
});

test("parseDecls captures whole declarations, including multi-line type aliases", () => {
    assert.equal(parseDecls(CONTRACT).get("MlApi").kind, "interface");
    // MlPublicConfig is a multi-line `Pick<MlConfig, …>`; a scanner that stopped at the first line would
    // silently truncate the field list. It lives in contract-config.ts since the contract was split by theme,
    // so parseDecls is asked about the file that DECLARES it — this is the single-file scanner, and the
    // following-imports behaviour is the resolver's job, asserted separately below.
    const config = parseDecls(readFileSync(new URL("../src/contract-config.ts", import.meta.url), "utf8"));
    assert.equal(config.get("MlPublicConfig").kind, "type");
    assert.ok(config.get("MlPublicConfig").body.join("\n").includes("apiFormat"));
});
