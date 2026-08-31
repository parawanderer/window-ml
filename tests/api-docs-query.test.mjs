// The ctags-like slicer over the generated API reference (api-docs-query.ts). It's pure, so
// it's tested standalone against BOTH a small hand-built fixture (for exact behaviour) and the
// REAL generated parts (so the default/member/type/scan flows hold against the shipped reference).
import { test } from "node:test";
import assert from "node:assert";
import { queryApiDocs, isDefaultQuery, GRAPH_BUDGET } from "../api-docs-query.ts";
import { generateApiParts } from "../scripts/gen-api-docs.mjs";

// A minimal fixture: two "types", an MlApi block whose members reference them, a preamble sentinel.
const FIXTURE = {
    preamble: "PREAMBLE_SENTINEL: framing prose.",
    mlApi: [
        "## `ml` — the object on `window`", "", "```ts",
        "export interface MlApi {",
        "    /** Talk to the model. */",
        "    chat(prompt: string, options?: ChatOptions): Promise<string>;",
        "    /** Fetch a URL and return its content. */",
        "    fetch(url: string): Promise<FetchResult>;",
        "}", "```", "",
    ].join("\n"),
    types: {
        // FetchResult → ContentKind is a transitive edge, so member queries can be tested for
        // walking the graph past one hop, to the leaf.
        ChatOptions: "### ChatOptions\n\n```ts\nexport interface ChatOptions {\n    schema?: object;\n}\n```\n",
        ContentKind: '### ContentKind\n\n```ts\nexport type ContentKind = "html" | "json";\n```\n',
        FetchResult: "### FetchResult\n\n```ts\nexport interface FetchResult {\n    text: string;\n    type: ContentKind;\n}\n```\n",
    },
};

test("default view: preamble + MlApi + a type INDEX, but not the type bodies", () => {
    const out = queryApiDocs(FIXTURE);
    assert.match(out, /PREAMBLE_SENTINEL/, "preamble missing");
    assert.match(out, /export interface MlApi/, "MlApi block missing");
    assert.match(out, /Available types: ChatOptions, ContentKind, FetchResult\./, "index of type names missing");
    // The whole point: the type bodies are NOT expanded in the default call.
    assert.doesNotMatch(out, /schema\?: object/, "ChatOptions body leaked into the default view");
    assert.doesNotMatch(out, /### FetchResult/, "FetchResult section leaked into the default view");
});

test("default view leads the model toward the by-member drill-down", () => {
    const out = queryApiDocs(FIXTURE);
    assert.match(out, /agent_api_docs\(\{ members:/, "no guidance to expand by member (the primary path)");
    assert.match(out, /agent_api_docs\(\{ types:/, "no guidance to expand a type");
    assert.match(out, /agent_api_docs\(\{ search:/, "no guidance to search");
});

test("{ members } returns the method AND follows its type graph to the leaves", () => {
    const out = queryApiDocs(FIXTURE, { members: ["fetch"] });
    assert.match(out, /## `ml\.fetch`/, "the method's own block is missing");
    assert.match(out, /Fetch a URL and return its content/, "the method's JSDoc is missing");
    assert.match(out, /### FetchResult/, "the directly-referenced type was not pulled in");
    assert.match(out, /text: string/, "FetchResult's fields were not expanded");
    // The graph is walked past one hop: FetchResult → ContentKind comes along automatically.
    assert.match(out, /### ContentKind/, "the transitive (2-hop) type was not followed to");
    // Small enough to be complete → the model is told so, so it won't drill again.
    assert.match(out, /✓ Complete/, "a fully-expanded small graph should be marked complete");
    // Only fetch's graph — chat's ChatOptions must not come along.
    assert.doesNotMatch(out, /### ChatOptions/, "an unrelated type leaked in");
    assert.doesNotMatch(out, /PREAMBLE_SENTINEL/, "a drill-down call re-paid for the preamble");
});

test("a large transitive tail is NAMED, not expanded, while the one-hop type is guaranteed", () => {
    // fetch → Near (direct, small) → Far (transitive, huge). Far must defer; Near must always show.
    const big = { preamble: "P", types: {}, mlApi: [
        "## `ml`", "```ts", "export interface MlApi {",
        "    /** Fetch. */",
        "    fetch(url: string): Promise<Near>;",
        "}", "```",
    ].join("\n") };
    big.types.Near = "### Near\n\n```ts\nexport interface Near {\n    deeper: Far;\n}\n```\n";
    big.types.Far = "### Far\n\n```ts\nexport interface Far {\n    x: string; // " + "y".repeat(GRAPH_BUDGET) + "\n}\n```\n";
    const out = queryApiDocs(big, { members: ["fetch"] });
    assert.match(out, /### Near/, "the direct one-hop type must always be shown");
    assert.doesNotMatch(out, /### Far\n/, "an over-budget transitive type should not be expanded");
    assert.match(out, /Also reachable, not expanded[^]*Far/, "the deferred type must be named for a follow-up");
});

test("{ members } is case-insensitive and de-dupes a shared type across members", () => {
    // Both members reference nothing shared here, so add a second fetch-like case via casing.
    const out = queryApiDocs(FIXTURE, { members: ["FETCH", "fetch"] });
    assert.equal(out.match(/### FetchResult/g).length, 1, "a repeated member re-expanded its type");
    assert.equal(out.match(/## `ml\.fetch`/g).length, 1, "the member block was emitted twice");
});

test("{ types } expands a specific type literally, without its member", () => {
    const out = queryApiDocs(FIXTURE, { types: ["chatoptions"] });
    assert.match(out, /### ChatOptions/, "requested type not expanded");
    assert.match(out, /schema\?: object/, "type body not expanded");
    assert.doesNotMatch(out, /## `ml\.chat`/, "types-mode should not pull in the member");
    assert.doesNotMatch(out, /### FetchResult/, "an unrequested type was expanded");
});

test("{ types } can expand MlApi itself", () => {
    const out = queryApiDocs(FIXTURE, { types: ["MlApi"] });
    assert.match(out, /export interface MlApi/, "MlApi not expandable by name");
});

test("members + types together de-dupe an overlapping type", () => {
    const out = queryApiDocs(FIXTURE, { members: ["fetch"], types: ["FetchResult"] });
    assert.equal(out.match(/### FetchResult/g).length, 1, "FetchResult shown twice across the two params");
});

test("unknown names are reported with the member + type lists", () => {
    const out = queryApiDocs(FIXTURE, { members: ["nope"], types: ["ghost"] });
    assert.match(out, /Not found: nope, ghost\./, "unknowns not reported");
    assert.match(out, /Members: chat, fetch\./, "member list missing");
    assert.match(out, /Types: MlApi, ChatOptions, ContentKind, FetchResult\./, "type list missing");
});

test("{ search } returns matching member blocks and type sections", () => {
    const out = queryApiDocs(FIXTURE, { search: "fetch" });
    // `fetch` names a member AND appears in the FetchResult section body.
    assert.match(out, /## `ml\.fetch`/, "matching member block not returned");
    assert.match(out, /### FetchResult/, "matching type section not expanded");
    assert.doesNotMatch(out, /## `ml\.chat`/, "a non-matching member was returned");
});

test("{ search } matches JSDoc prose, not just names", () => {
    const out = queryApiDocs(FIXTURE, { search: "talk to the model" });
    assert.match(out, /## `ml\.chat`/, "a member matched only by its JSDoc was not found");
});

test("{ search } with no hit lists the members and types to try", () => {
    const out = queryApiDocs(FIXTURE, { search: "zzzznope" });
    assert.match(out, /No member or type mentions "zzzznope"/, "empty search not reported");
    assert.match(out, /Members: chat, fetch\./);
    assert.match(out, /Types: ChatOptions, ContentKind, FetchResult\./);
});

test("{ search } that matches too many types degrades to a name list, not a full dump", () => {
    const many = { preamble: "P", mlApi: "## `ml`\n```ts\nexport interface MlApi {}\n```\n", types: {} };
    for (let i = 0; i < 12; i++) many.types[`T${i}`] = `### T${i}\n\n\`\`\`ts\n// widget marker ${i}\n\`\`\`\n`;
    const out = queryApiDocs(many, { search: "widget" });
    assert.match(out, /too many to expand/, "did not cap a broad search");
    assert.match(out, /T0, T1/, "matching names not listed");
    assert.doesNotMatch(out, /```ts\n\/\/ widget marker/, "expanded a section despite being over the cap");
});

// The runtime/environment sections the tool resolves live and passes in (HUD shortcut, source).
// Body deliberately says "Keyboard: … shortcut" NON-adjacently, to prove tokenized search.
const ENV = [
    { name: "Opening the HUD", body: "## Opening the HUD\n\n- **Keyboard: `Alt+Space`** — the shortcut bound RIGHT NOW. Returns text.\n" },
    { name: "My source", body: "## My source\n\n- Public repository: https://example.test/repo\n" },
];

test("default view includes the runtime env sections and says they're searchable", () => {
    const out = queryApiDocs(FIXTURE, {}, ENV);
    assert.match(out, /## Opening the HUD/, "env section missing from the default view");
    assert.match(out, /Alt\+Space/, "the live shortcut is missing");
    assert.match(out, /searchable/, "the default view should tell the model env facts are searchable");
});

test("{ search } finds a runtime env section (this is the HUD-shortcut failure the model hit)", () => {
    const out = queryApiDocs(FIXTURE, { search: "HUD" }, ENV);
    assert.match(out, /## Opening the HUD/, "search did not reach the env section");
    assert.match(out, /Alt\+Space/, "the shortcut the model was hunting was not returned");
});

test("{ search } is TOKENIZED: 'keyboard shortcut' matches a section with the words non-adjacent", () => {
    const out = queryApiDocs(FIXTURE, { search: "keyboard shortcut" }, ENV);
    assert.match(out, /## Opening the HUD/, "a multi-word search failed on non-adjacent words");
});

test("{ search } puts env hits BEFORE type/member hits", () => {
    // "text" appears in the env section AND in FetchResult (`text: string`).
    const out = queryApiDocs(FIXTURE, { search: "text" }, ENV);
    assert.ok(out.indexOf("## Opening the HUD") < out.indexOf("### FetchResult"),
        "the environment hit should rank above a type that merely contains the word");
});

test("a member/type drill does NOT include env, even if some is passed", () => {
    const out = queryApiDocs(FIXTURE, { members: ["fetch"] }, ENV);
    assert.doesNotMatch(out, /## Opening the HUD/, "a focused drill should not re-pay for env context");
});

test("isDefaultQuery distinguishes the no-args view from a drill-down", () => {
    assert.equal(isDefaultQuery(), true);
    assert.equal(isDefaultQuery({}), true);
    assert.equal(isDefaultQuery({ members: [], types: [] }), true, "empty arrays are still the default view");
    assert.equal(isDefaultQuery({ search: "  " }), true, "a blank search is still the default view");
    assert.equal(isDefaultQuery({ members: ["fetch"] }), false);
    assert.equal(isDefaultQuery({ types: ["ChatOptions"] }), false);
    assert.equal(isDefaultQuery({ search: "fetch" }), false);
});

/* ------------------- within-burst dedup (the `seen` set) ------------------- */

test("a section shown once is a one-line stub the SECOND time in the same burst", () => {
    const seen = new Set();
    const first = queryApiDocs(FIXTURE, { members: ["fetch"] }, [], seen);
    assert.match(first, /### FetchResult/, "first call should show FetchResult in full");
    assert.match(first, /text: string/, "first call should have the fields");

    const second = queryApiDocs(FIXTURE, { members: ["fetch"] }, [], seen);
    assert.match(second, /\[ml\.fetch already seen\]/, "repeated member should collapse to a stub");
    assert.match(second, /\[interface FetchResult already seen\]/, "repeated type should collapse to a stub");
    assert.doesNotMatch(second, /text: string/, "the full type body should NOT be re-printed");
});

test("a type-alias stub says 'type', an interface stub says 'interface'", () => {
    const seen = new Set();
    queryApiDocs(FIXTURE, { members: ["fetch"] }, [], seen);   // shows FetchResult (interface) + ContentKind (type)
    const again = queryApiDocs(FIXTURE, { types: ["ContentKind", "FetchResult"] }, [], seen);
    assert.match(again, /\[type ContentKind already seen\]/, "a `type` alias should be labelled 'type'");
    assert.match(again, /\[interface FetchResult already seen\]/, "an `interface` should be labelled 'interface'");
});

test("a stubbed type does NOT count against the graph budget or show as deferred", () => {
    const seen = new Set(["type:FetchResult", "type:ContentKind"]);   // pretend both already shown
    const out = queryApiDocs(FIXTURE, { members: ["fetch"] }, [], seen);
    assert.match(out, /\[interface FetchResult already seen\]/);
    assert.doesNotMatch(out, /Also reachable/, "an already-seen type must not be reported as deferred");
});

test("search collapses an already-shown section to a stub too", () => {
    const seen = new Set();
    queryApiDocs(FIXTURE, { types: ["FetchResult"] }, [], seen);
    const searched = queryApiDocs(FIXTURE, { search: "FetchResult" }, [], seen);
    assert.match(searched, /\[interface FetchResult already seen\]/, "search should not re-dump a seen section");
});

test("env sections stub on repeat within a burst", () => {
    const seen = new Set();
    const first = queryApiDocs(FIXTURE, {}, ENV, seen);
    assert.match(first, /Alt\+Space/, "first default view shows the env section in full");
    const second = queryApiDocs(FIXTURE, {}, ENV, seen);
    assert.match(second, /\[Opening the HUD already seen\]/, "repeated env section should stub");
    assert.match(second, /\[the ml object \(methods\) already seen\]/, "the ml block should stub on a repeat default view");
});

test("without a `seen` set, nothing is ever stubbed (legacy / dedup-disabled path)", () => {
    const a = queryApiDocs(FIXTURE, { members: ["fetch"] });
    const b = queryApiDocs(FIXTURE, { members: ["fetch"] });
    assert.equal(a, b, "two identical calls with no memory should be byte-identical");
    assert.doesNotMatch(b, /already seen/);
});

/* ------- against the REAL generated reference (not just the fixture) ------- */

test("real parts: default view names the actual types and hides their bodies", () => {
    const out = queryApiDocs(generateApiParts());
    assert.match(out, /## `ml`/, "real MlApi block missing");
    assert.match(out, /Available types: .*ChatOptions/, "ChatOptions not in the real index");
    assert.doesNotMatch(out, /### ChatOptions\b/, "real ChatOptions section leaked into the default view");
});

test("real parts: expanding ml.fetch pulls in FetchResult automatically", () => {
    const out = queryApiDocs(generateApiParts(), { members: ["fetch"] });
    assert.match(out, /## `ml\.fetch`/, "real fetch member block missing");
    assert.match(out, /### FetchResult/, "fetch's signature type was not pulled in");
});

test("real parts: expanding a known type returns its fields", () => {
    const out = queryApiDocs(generateApiParts(), { types: ["ChatOptions"] });
    assert.match(out, /### ChatOptions/);
    assert.match(out, /schema\?:/, "ChatOptions.schema field not reached by expansion");
});

test("real parts: every public method splits out as an expandable member", () => {
    const parts = generateApiParts();
    // The member splitter must see the same members the generator emitted (no silent drop).
    // The generated MlApi block is TAB-indented (deAlign); accept a tab or 4 spaces.
    const bodyNames = [...parts.mlApi.matchAll(/^(?:\t| {4})([A-Za-z_$][\w$]*)\s*[?(<:]/gm)].map(m => m[1]);
    assert.ok(bodyNames.length > 10, `expected a real member surface, saw ${bodyNames.length}`);
    for (const name of bodyNames) {
        const out = queryApiDocs(parts, { members: [name] });
        assert.match(out, new RegExp(`## \`ml\\.${name}\``), `${name} did not expand as a member`);
    }
});
