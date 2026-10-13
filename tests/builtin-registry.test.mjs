// builtin-registry.test.mjs — the builtin tool registry (src/tools/tool-registry.ts) and its ratchet (scripts/check-tools.mjs):
// the lists the gate, the pointers and the worker's routing read are derived from it and say exactly what the
// hand-kept lists said before it existed; a name it does not declare is the site's own tool; and the ratchet fails on
// a factory with no declaration, or a declaration with no factory.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reg = await import("../src/tools/tool-registry.ts");

// --- the derived lists equal the hand-kept ones they replaced ---

// Copied verbatim from origin/main at 18cbd211, the commit before the registry. A difference is a behaviour change:
// edit these only in a change that means to make one, and say why there; never to make a test pass.
const OLD = {
    /** src/sw/sw-run-host.ts `GATED_TOOL_NAMES` */
    gated: ["exec", "python_exec", "fetch_url", "navigate", "click", "type"],
    /** src/tools/tool-params.ts `CITABLE_TOOLS` */
    citable: ["exec", "python_exec", "look", "locate", "fetch_url", "agent_api_docs"],
    /** src/sw/worker-tools.ts `WORKER_TOOL_NAMES` */
    worker: ["fetch_url", "python_exec", "agent_api_docs", "answer", "look", "locate"],
    /** Every tool a factory under src/ built (`node scripts/check-tools.mjs --list` at that commit). */
    builtins: ["agent_api_docs", "ancestors", "answer", "chat_metadata", "click", "countMatches", "dereference", "describeElement",
        "exec", "fetch_url", "findByText", "interactives", "locate", "look", "navigate", "pageInfo", "python_exec", "sampleText",
        "scroll", "type", "wait"],
};

const sorted = (xs) => [...xs].sort();

test("the registry declares exactly the builtins the factories built before it", () => {
    assert.deepEqual(sorted(reg.builtinTools().map((d) => d.name)), sorted(OLD.builtins));
});

test("every declared tool's gated, citable and realm say what the old lists said, tool by tool", () => {
    for (const name of OLD.builtins) {
        const d = reg.builtinTool(name);
        assert.ok(d, name);
        assert.equal(d.gated, OLD.gated.includes(name), `${name}: gated`);
        assert.equal(d.citable, OLD.citable.includes(name), `${name}: citable`);
        // The old code had two realms: the worker's list, and the page for everything else (`dereference` is answered by
        // the loop, which the old routing never sent anywhere either: it is in neither list).
        assert.equal(d.realm === "worker", OLD.worker.includes(name), `${name}: runs in the worker`);
        assert.equal(d.realm === "loop", name === "dereference", `${name}: answered by the loop`);
    }
});

test("CITABLE_TOOLS (tool-params.ts) is the registry's citable set, and equals the old list", async () => {
    const { CITABLE_TOOLS } = await import("../src/tools/tool-params.ts");
    assert.equal(CITABLE_TOOLS, reg.CITABLE_BUILTINS);
    assert.deepEqual(sorted(CITABLE_TOOLS), sorted(OLD.citable));
});

test("WORKER_TOOL_NAMES (worker-tools.ts) is the registry's worker realm, and equals the old list", async () => {
    const { WORKER_TOOL_NAMES } = await import("../src/sw/worker-tools.ts");
    assert.equal(WORKER_TOOL_NAMES, reg.WORKER_BUILTINS);
    assert.deepEqual(sorted(WORKER_TOOL_NAMES), sorted(OLD.worker));
});

/** sw-run-host.ts, loaded with a `chrome` that answers anything: only its pure exports are used. */
async function runHost() {
    // Every member is another such stub, a call returns one, and it reads as "" where a string is wanted: enough for
    // the module's load-time listeners and storage reads to find nothing.
    const deep = () => new Proxy(function () {}, {
        get: (_t, k) => (k === "then" ? undefined : k === Symbol.toPrimitive ? () => "" : deep()),
        apply: () => deep(),
    });
    const prev = globalThis.chrome;
    globalThis.chrome = deep();
    try { return await import("../src/sw/sw-run-host.ts"); } finally { globalThis.chrome = prev; }
}

const SITE = { tab: { id: 7, url: "https://site.example/" }, url: "https://site.example/", origin: "https://site.example", frameId: 0 };

test("GATED_TOOL_NAMES (sw-run-host.ts) is the registry's gated set; a page's START_RUN cannot ungate any of them", async () => {
    const { GATED_TOOL_NAMES, pageStartPayload } = await runHost();
    assert.equal(GATED_TOOL_NAMES, reg.GATED_BUILTINS);
    assert.deepEqual(sorted(GATED_TOOL_NAMES), sorted(OLD.gated));
    // Enumerated over every builtin, not sampled: the page sends each one ungated and the worker re-gates exactly the old six.
    const tools = OLD.builtins.map((name) => ({ name, requiresApproval: false }));
    const out = pageStartPayload({ tools }, SITE, {});
    for (const t of out.tools) assert.equal(t.requiresApproval, OLD.gated.includes(t.name), t.name);
});

// --- a name the registry does not declare is the site's own ---

test("a site tool named like a builtin is treated as the builtin: gated, and given the builtin's card line", async () => {
    const { pageStartPayload } = await runHost();
    assert.equal(reg.isBuiltinTool("exec"), true);
    assert.equal(reg.cardLine("exec"), "Run code on this page");
    const out = pageStartPayload({ tools: [{ name: "exec", description: "the site's own exec", requiresApproval: false }] }, SITE, {});
    assert.equal(out.tools[0].requiresApproval, true);
});

test("an undeclared name is the site's own tool: not a builtin, no card line, not ungated or gated by name", async () => {
    const { pageStartPayload } = await runHost();
    for (const name of ["my_tool", "Exec", "exec ", "", "__proto__", "constructor", "toString", "hasOwnProperty"]) {
        assert.equal(reg.isBuiltinTool(name), false, JSON.stringify(name));
        assert.equal(reg.builtinTool(name), undefined, JSON.stringify(name));
        assert.equal(reg.cardLine(name), undefined, JSON.stringify(name));
    }
    for (const v of [undefined, null, 1, {}, ["exec"]]) assert.equal(reg.isBuiltinTool(v), false, String(v));
    const out = pageStartPayload({ tools: [{ name: "my_tool", requiresApproval: false }, { name: "mine", requiresApproval: true }] }, SITE, {});
    assert.deepEqual(out.tools.map((t) => t.requiresApproval), [false, true]);
});

// --- the start card's lines (SITE_ACCESS_SLICE3.md 1.1) ---

test("every builtin's card line is the spec's wording, or none for a tool that reaches nothing outside the run", () => {
    const READ = "Read this page", SHOTS = "Take screenshots of this page and show them to the model", CT = "Click and type on this page";
    const want = {
        exec: "Run code on this page", click: CT, type: CT,
        fetch_url: "Read other websites (it asks you before each new one)", python_exec: "Run Python", look: SHOTS, locate: SHOTS,
        findByText: READ, interactives: READ, describeElement: READ, ancestors: READ, countMatches: READ, sampleText: READ,
        pageInfo: READ, scroll: READ, wait: READ, answer: READ,
        dereference: null, agent_api_docs: null, chat_metadata: null,
        navigate: "Open other pages of this site in this tab",
    };
    for (const name of OLD.builtins) assert.equal(reg.cardLine(name), want[name], name);
    assert.equal(reg.cardLine("navigate", { crossOrigin: true }), "Open other pages in this tab, on any site");
    assert.equal(reg.cardLine("navigate", { crossOrigin: false }), "Open other pages of this site in this tab");
});

test("defineBuiltinTool refuses a second declaration, an unknown realm and a declaration with no factory", () => {
    assert.throws(() => reg.defineBuiltinTool({ name: "exec", factories: ["x.ts"], gated: false, citable: false, realm: "page", cardLine: null }), /declared twice/);
    assert.throws(() => reg.defineBuiltinTool({ name: "zz_realm", factories: ["x.ts"], gated: false, citable: false, realm: "tab", cardLine: null }), /unknown realm/);
    assert.throws(() => reg.defineBuiltinTool({ name: "zz_nofactory", factories: [], gated: false, citable: false, realm: "page", cardLine: null }), /names no factory/);
    assert.equal(reg.isBuiltinTool("zz_realm"), false);
    assert.equal(reg.isBuiltinTool("zz_nofactory"), false);
});

// --- the other tables keyed by builtin name name only builtins ---

test("every other table keyed by a builtin's name names a declared builtin", async () => {
    const { SHADOW_TOOLS } = await import("../src/agent/prompts.ts");
    const { ML_MEMBER_TOOL } = await import("../src/ml/ml-member-tools.ts");
    const { OUTPUT_CAP } = await import("../src/contract/contract-pointers.ts");
    const { CODE_LANG, CODE_INTENT } = await import("../src/sidebar/transcript/summaries.tsx");
    const { ACTIVITY } = await import("../src/sidebar/transcript/orb-status.ts");
    const tables = {
        SHADOW_TOOLS: [...SHADOW_TOOLS], ML_MEMBER_TOOL: Object.values(ML_MEMBER_TOOL), OUTPUT_CAP: Object.keys(OUTPUT_CAP),
        CODE_LANG: Object.keys(CODE_LANG), CODE_INTENT: Object.keys(CODE_INTENT),
        // `screenshot` names no tool (none has been built under that name since `look` replaced it): a dead row, not a drift.
        ACTIVITY: Object.keys(ACTIVITY).filter((k) => k !== "screenshot"),
    };
    for (const [table, names] of Object.entries(tables))
        for (const n of names) assert.ok(reg.isBuiltinTool(n), `${table} names ${n}, which the registry does not declare`);
    // The shadow clause's tools are page tools: the worker cannot pierce a shadow root.
    for (const n of SHADOW_TOOLS) assert.notEqual(reg.builtinTool(n).realm, "loop", n);
});

// --- the ratchet: scripts/check-tools.mjs ---

const check = await import("../scripts/check-tools.mjs");
const registryText = readFileSync(path.join(ROOT, check.REGISTRY), "utf8");

test("check-tools passes on the repo as it is", () => {
    const out = execFileSync(process.execPath, [path.join(ROOT, "scripts/check-tools.mjs")], { encoding: "utf8" });
    assert.match(out, /21 builtin tools, each declared/);
});

const decl = (name, factories) => `defineBuiltinTool({ name: "${name}", factories: [${factories.map((f) => `"${f}"`).join(", ")}], gated: false, citable: false, realm: "page", cardLine: null });\n`;
const factory = (name) => `export const t = (ml) => ml.defineTool({\n    name: "${name}",\n    description: "does a thing",\n    run: async () => "",\n});\n`;

test("check-tools fails on a factory with no declaration, naming the tool and the file", () => {
    const files = [{ rel: check.REGISTRY, text: decl("one", ["src/a.ts"]) }, { rel: "src/a.ts", text: factory("one") }, { rel: "src/b.ts", text: factory("two") }];
    const { problems } = check.checkTools(files);
    assert.equal(problems.length, 1, problems.join("\n"));
    assert.match(problems[0], /^src\/b\.ts\ttwo: a builtin tool factory with no defineBuiltinTool declaration/);
});

test("check-tools fails on a declaration with no factory, and on one naming the wrong file", () => {
    const none = check.checkTools([{ rel: check.REGISTRY, text: decl("ghost", ["src/a.ts"]) }, { rel: "src/a.ts", text: "export {};" }]).problems;
    assert.equal(none.length, 1, none.join("\n"));
    assert.match(none[0], /ghost: declared, but no factory for it exists anywhere/);
    const moved = check.checkTools([{ rel: check.REGISTRY, text: decl("one", ["src/a.ts"]) }, { rel: "src/a.ts", text: "" }, { rel: "src/b.ts", text: factory("one") }]).problems;
    assert.ok(moved.some((p) => /src\/b\.ts\tone: a factory here, but its declaration does not list this file/.test(p)), moved.join("\n"));
    assert.ok(moved.some((p) => /one: declared with a factory in src\/a\.ts, which has none/.test(p)), moved.join("\n"));
});

test("check-tools reads a factory named by a constant, and ignores a commented-out one and a server tool built at run time", () => {
    const files = [
        { rel: check.REGISTRY, text: decl("dereference", ["src/a.ts"]) },
        { rel: "src/a.ts", text: `export const DEREF_TOOL = "dereference";\nexport const d = (T) => T({ name: DEREF_TOOL, description: "reads" });\n// const old = T({ name: "gone", description: "x" });\n/* return { name: "also_gone", description: "x" } */\n` },
        { rel: "src/b.ts", text: `export const s = (fn) => ({ name: fnName, description: fn.description });\nconst k = crypto.subtle.generateKey({ name: "Ed25519" }, false, []);\n` },
    ];
    assert.deepEqual(check.checkTools(files).problems, []);
});

test("check-tools refuses a declaration whose name or factories are not literals", () => {
    const text = `defineBuiltinTool({ name: N, factories: ["src/a.ts"], gated: false, citable: false, realm: "page", cardLine: null });\n`
        + `defineBuiltinTool({ name: "x", factories: FILES, gated: false, citable: false, realm: "page", cardLine: null });\n`;
    const { problems } = check.checkTools([{ rel: check.REGISTRY, text }]);
    assert.equal(problems.filter((p) => /write name and factories as string literals/.test(p)).length, 2, problems.join("\n"));
});

test("the registry's own declarations parse: one per builtin, each naming its factories", () => {
    const ds = check.declarationsIn(registryText);
    assert.deepEqual(sorted(ds.map((d) => d.name)), sorted(OLD.builtins));
    for (const d of ds) assert.deepEqual(sorted(d.factories), sorted(reg.builtinTool(d.name).factories), d.name);
});
