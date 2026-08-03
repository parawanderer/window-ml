// The generated `window.ml` API reference (scripts/gen-api-docs.mjs → api-docs.gen.ts),
// which the `agent_api_docs` tool hands the model so it can answer questions about its own
// host. The whole point of generating it is that it can't drift from contract.ts, so the
// load-bearing test here is the FRESHNESS diff — plus the two properties the extractor is
// responsible for: `_` plumbing stays out, and the option types get expanded (a bare
// `chat(prompt, options?)` teaches the model nothing about `schema`/`think`/`onToken`).
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { generateApiDocs, renderModule, parseDecls, stripPrivateMembers } from "../scripts/gen-api-docs.mjs";

const CONTRACT = readFileSync(new URL("../contract.ts", import.meta.url), "utf8");
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
    const onDisk = readFileSync(new URL("../api-docs.gen.ts", import.meta.url), "utf8");
    assert.equal(onDisk, renderModule(docs),
        "api-docs.gen.ts is stale — contract.ts changed since the last build.");
});

test("every public MlApi member reaches the doc", () => {
    const { public: pub } = apiMembers();
    assert.ok(pub.length > 15, `expected a real API surface, parsed ${pub.length} members`);
    for (const name of pub) assert.match(docs, new RegExp(`\\b${name}\\b`), `${name} missing from the docs`);
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
    for (const type of ["ChatOptions", "AgentOptions", "MlHistory", "MlTool", "AgentResult"]) {
        assert.match(docs, new RegExp(`### ${type}\\b`), `${type} not expanded`);
    }
    assert.match(docs, /schema\?:/, "ChatOptions.schema missing — type expansion didn't reach the fields");
    assert.match(docs, /maxSteps\?:/, "AgentOptions.maxSteps missing");
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
    const decls = parseDecls(CONTRACT);
    assert.equal(decls.get("MlApi").kind, "interface");
    assert.equal(decls.get("MlPublicConfig").kind, "type");
    // MlPublicConfig is a multi-line `Pick<MlConfig, …>`; a scanner that stopped at the
    // first line would silently truncate the field list.
    assert.ok(decls.get("MlPublicConfig").body.join("\n").includes("apiFormat"));
});
