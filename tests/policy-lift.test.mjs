// policy-lift.test.mjs — the policy tree's lifter (src/readonly-exec/policy-lift.ts): which sources lift, measured over the
// committed corpus, and that a lifted tree AGREES with its original source, run through the real policy realm, on every
// cell its constants induce (docs/plan/repl/LANE_11_POLICY_TREE_DESIGN.md; ruled #921, #927).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const { liftPolicy } = await import("../src/readonly-exec/policy-lift.ts");
const { evalPolicy } = await import("../src/readonly-exec.ts");
const { CONSUMER_FIELDS } = await import("../src/readonly-exec/policy-lift.ts");
const { evalTree, treeVerdict, cells, asView } = await import("./fixtures/policy-tree-cells.mjs");
const { NEEDS } = await import("./e2e/panel/policy-proposals.score.ts");

const corpus = JSON.parse(fs.readFileSync(new URL("./fixtures/policy-corpus.json", import.meta.url), "utf8"));
const measured = corpus.policies.filter((e) => e.tree);
const lifts = (fit) => fit === "as-written" || fit === "mechanical";

/** The nodes outside any quantifier (the quantifiers included), whose value at a cell needs no list element. */
function topNodes(t, out = []) {
    if (t.op === "all" || t.op === "any") { if (t.of.length) out.push(t); t.of.forEach((x) => topNodes(x, out)); }
    else if (t.op === "not") topNodes(t.of, out);
    else out.push(t);
    return out;
}

/** Whether the tree agrees with the source on every cell; the ORACLE is the source in the real policy realm. Also
 *  checks the cells are worth comparing on: every node outside a quantifier is true on some cell and false on another,
 *  so a generator that never builds the case a constant names fails here rather than agreeing on "false" everywhere. */
function agreement(src, consumer, tree) {
    let compared = 0, broken = 0;
    const nodes = topNodes(tree), seen = nodes.map(() => new Set());
    for (const f of cells(tree, consumer)) {
        const view = asView(f);
        nodes.forEach((n, i) => seen[i].add(evalTree(n, view, CONSUMER_FIELDS[consumer])));
        const o = evalPolicy(src, f, "allow");
        if (o.broken) { broken++; continue; }
        const want = o.decision === "allow";
        const got = treeVerdict(tree, asView(f), CONSUMER_FIELDS[consumer], "allow");
        if (want !== got) return { mismatch: f, want, got, compared, broken };
        compared++;
    }
    const flat = nodes.findIndex((_, i) => seen[i].size < 2);
    if (flat >= 0) return { flat: nodes[flat], compared, broken };
    return { compared, broken };
}

// --- the corpus: which sources lift ---

test("the lifter lifts exactly the corpus entries recorded as fitting, as written or by a mechanical rewrite", () => {
    assert.ok(measured.length >= 60, `the corpus has its measured entries (${measured.length})`);
    for (const e of measured) {
        const r = liftPolicy(e.src, e.consumer);
        assert.equal(!!r.tree, lifts(e.tree.fit), `${e.tree.fit}: ${e.src}\n  → ${r.why ?? "lifted"}`);
        if (!r.tree) assert.ok(r.why, "a source that does not lift says why");
    }
});

test("the corpus's figure is reproduced from the file: 36 of 39 consumer policies and 49 of 60 lift", () => {
    const bySrc = new Map();
    for (const e of measured.filter((x) => x.author !== "model")) bySrc.set(e.src.split(/\s+/).join(" "), e);
    const count = (pred) => [...bySrc.values()].filter(pred).length;
    const lifted = (e) => !!liftPolicy(e.src, e.consumer).tree;
    assert.equal(bySrc.size, 60);
    assert.equal(count((e) => e.tree.group === "consumer"), 39);
    assert.equal(count((e) => e.tree.group === "consumer" && lifted(e)), 36);
    assert.equal(count(lifted), 49);
});

test("the model-written entries' figure is reproduced from the file: 45 of 74 distinct policies lift, 25 of 37 fetch and 20 of 37 sh", () => {
    const bySrc = new Map();
    for (const e of measured.filter((x) => x.author === "model")) bySrc.set(e.consumer + e.src.split(/\s+/).join(" "), e);
    const lifted = (e) => !!liftPolicy(e.src, e.consumer).tree;
    const n = (pred) => [...bySrc.values()].filter(pred).length;
    assert.equal(bySrc.size, 74);
    assert.equal(n(lifted), 45);
    assert.equal(n((e) => e.consumer === "fetch" && lifted(e)), 25);
    assert.equal(n((e) => e.consumer === "sh" && lifted(e)), 20);
    for (const e of bySrc.values()) assert.equal(e.tree.group, "consumer", "a model's proposal is over a real consumer");
});

// --- a lifted tree agrees with its source ---

test("every lifted corpus policy agrees with its source, in the real policy realm, on every cell", () => {
    const seen = new Set();
    const tooBig = [];
    for (const e of measured) {
        if (seen.has(e.src) || !lifts(e.tree.fit)) continue;
        seen.add(e.src);
        const { tree } = liftPolicy(e.src, e.consumer);
        let r;
        try { r = agreement(e.src, e.consumer, tree); }
        catch (err) {
            // A model's long proposal can induce more cells than the generator enumerates (it throws past its cap, never samples).
            if (e.author !== "model" || !/past the test's cap/.test(err.message)) throw err;
            // Compared instead on the need's hand-labelled calls, the facts the bench scored it on.
            const need = NEEDS[e.consumer].find((x) => x.id === e.notes[1].split(" ")[0]);
            assert.ok(need, `${e.src}: its notes name no need`);
            let n = 0;
            for (const v of need.vectors) {
                const o = evalPolicy(e.src, v.facts, need.effect);
                if (o.broken) continue;
                n++;
                assert.equal(treeVerdict(tree, asView(v.facts), CONSUMER_FIELDS[e.consumer], need.effect), o.decision === need.effect, `${e.src}\n  disagrees on ${v.name}`);
            }
            assert.ok(n > 0, `${e.src}: some call of ${need.id} must evaluate`);
            tooBig.push(e.src);
            continue;
        }
        assert.equal(r.mismatch, undefined, `${e.src}\n  source says ${r.want}, tree says ${r.got} on ${JSON.stringify(r.mismatch)}`);
        assert.ok(r.compared > 0, `${e.src}: some cell must evaluate (broken on all ${r.broken})`);
        assert.equal(r.flat, undefined, `${e.src}: no cell makes ${JSON.stringify(r.flat)} take both values`);
    }
    // Pinned, so a third one is noticed: two sh answers (S2, S3) read too many fields to enumerate, and are compared on
    // their need's calls only.
    assert.equal(tooBig.length, 2, `sources too big to enumerate:\n${tooBig.join("\n---\n")}`);
});

test("an ALLOW lifted over a nullable fact agrees on the null cell too: the tree, like the realm, does not fire there", () => {
    // qwen3.8:27b's S3 answer in the 2026-10-21 run, exactly as written, and the shortest form of the same fail-open.
    const srcs = [
        "const READONLY = [\"status\", \"diff\", \"log\", \"show\"];\n(c) =>\n  c.argv[0] === \"git\" &&\n  READONLY.includes(c.argv[1]) &&\n  c.cwd.inRoot === true &&\n  c.repoConfigRunsCode !== true &&\n  !c.effects.has(\"write\") &&\n  !c.effects.has(\"exec\")",
        '(c) => c.argv[0] === "git" && !c.repoConfigRunsCode',
        '(c) => c.argv[0] === "git" || c.repoConfigRunsCode === null',
    ];
    for (const src of srcs) {
        const { tree, why } = liftPolicy(src, "sh");
        assert.ok(tree, `${src}: ${why}`);
        const nullCells = cells(tree, "sh").filter((f) => f.repoConfigRunsCode === null);
        assert.ok(nullCells.length > 0, `${src}: the cells include the null one`);
        const r = agreement(src, "sh", tree);
        assert.equal(r.mismatch, undefined, `${src}\n  source says ${r.want}, tree says ${r.got} on ${JSON.stringify(r.mismatch)}`);
        assert.equal(r.flat, undefined);
    }
});

// --- the segment rule: a prefix that does not end at a segment stays code ---

test("a character prefix over a URL or a path lifts only when it ends at a segment", () => {
    const yes = [
        ['(c) => c.url.startsWith("https://a.example/")', "fetch"],
        ['(c) => c.url.startsWith("https://a.example/docs/")', "fetch"],
        ['(c) => c.paths.every((p) => p.path.startsWith("/r/src/"))', "sh"],
        ['(c) => c.host === "shop.com" || c.host.endsWith(".shop.com")', "fetch"],
        ['(c) => c.paths.length > 0 && c.secrets.length === 0 && c.argv.length === 2', "sh"],
        ['(c) => c.effects.pairs.length !== 0 && c.repoConfigRunsCode === false && !c.effects.uses("github")', "sh"],
    ];
    const no = [
        ['(c) => c.url.startsWith("https://a.example")', "fetch", "a.example.evil.com"],
        ['(c) => c.url.startsWith("https://a.example/docs")', "fetch", "docsevil"],
        ['(c) => c.url.startsWith("http")', "fetch", "a scheme prefix"],
        ['(c) => c.url.startsWith("https://u@a.example/")', "fetch", "userinfo"],
        ['(c) => c.paths.every((p) => p.path.startsWith("/r/src"))', "sh", "/r/srcevil"],
        ['(c) => c.host.startsWith("docs.")', "fetch", "a host by its left labels"],
        ['(c) => c.host.endsWith("shop.com")', "fetch", "evilshop.com"],
    ];
    for (const [src, consumer] of yes) {
        const r = liftPolicy(src, consumer);
        assert.ok(r.tree, `${src}: ${r.why}`);
        const a = agreement(src, consumer, r.tree);
        assert.equal(a.mismatch, undefined, `${src} on ${JSON.stringify(a.mismatch)}`);
        assert.equal(a.flat, undefined, `${src}: ${JSON.stringify(a.flat)} takes one value on every cell`);
    }
    for (const [src, consumer, why] of no) assert.equal(liftPolicy(src, consumer).tree, undefined, `${src} must stay code (${why})`);
});

// --- a regex lifts only as literal prefixes ---

test("a regex lifts only when anchored and literal, with at most one group of literal alternatives", () => {
    const r = liftPolicy('(c) => !c.argv.some((a) => /^--(output|ext-diff)/.test(a))', "sh");
    assert.deepEqual(r.tree, { op: "not", of: { op: "some", list: ["argv"], test: { op: "startsWith", field: ["@"], values: ["--output", "--ext-diff"] } } });
    for (const src of [
        "(c) => /--output/.test(c.argv[1])",            // unanchored
        "(c) => /^--out.*/.test(c.argv[1])",            // not literal
        "(c) => /^--[a-z]+/.test(c.argv[1])",           // a class
        "(c) => /^\\w+/.test(c.argv[1])",               // a class escape
        "(c) => /^a|b/.test(c.argv[1])",                // alternation outside a group: `b` is unanchored
        "(c) => /^(a|b)(c|d)/.test(c.argv[1])",         // two groups
        "(c) => /^--output/i.test(c.argv[1])",          // flags
        "(c) => /^(a|b.*)/.test(c.argv[1])",            // a group that is not literal
    ]) assert.equal(liftPolicy(src, "sh").tree, undefined, `${src} must stay code`);
});

// --- what the lifter refuses, and that it never throws ---

test("a source outside the fragment stays code with a reason, and the lifter never throws", () => {
    for (const [src, consumer] of [
        ["(c) => c.argv.length < 3", "sh"],
        ["(c) => c.argv[0] === c.argv[1]", "sh"],
        ["(c) => c.paths[0].inRoot", "sh"],
        ["(c) => c.paths.every((p) => p.topLevel === true)", "sh"],       // a fact sent only on some calls
        ["(c) => c.host === 'a' && c.argv[0] === 'git'", "fetch"],         // fetch has no argv
        ["(c) => c.credentials === \"false\"", "fetch"],                   // a constant of the wrong type
        ["(c) => c.url", "fetch"],                                          // truthiness of a string
        ["(c) => c.effects.has(\"delete\")", "sh"],                          // outside the algebra
        ["(c) => c.paths.some((p) => c.argv.some((a) => a === p.given))", "sh"],
        ["(c) => { return true; }", "sh"],
        ["c => c.argv[0] === 'git'; 1", "sh"],
        ["", "sh"], ["(((", "sh"], ["(c, d) => true", "sh"], ["const x = c; (c) => true", "sh"],
    ]) {
        const r = liftPolicy(src, consumer);
        assert.equal(r.tree, undefined, `${src} must stay code`);
        assert.ok(typeof r.why === "string" && r.why.length > 0, `${src}: says why`);
    }
});

test("includes on a list fact stays code and says how the fragment writes it", () => {
    for (const src of ['(c) => c.argv.includes("--force")', '(c) => c.secrets.includes("github")', '(c) => !c.env.set.includes("PATH")'])
        assert.match(liftPolicy(src, "sh").why ?? "", /^\.includes\(…\) on the list fact (argv|secrets|env\.set) \(the fragment writes it as \.some/, src);
});

test("a constant list or a const helper lifts as membership; a const that is not a literal stays code", () => {
    assert.deepEqual(liftPolicy('const OK = ["a", "b"]; (c) => OK.includes(c.host)', "fetch").tree, { op: "oneOf", field: ["host"], values: ["a", "b"] });
    assert.equal(liftPolicy('const OK = ["a", c.host]; (c) => OK.includes(c.host)', "fetch").tree, undefined);
    assert.equal(liftPolicy("let OK = [\"a\"]; (c) => OK.includes(c.host)", "fetch").tree, undefined, "only const");
});
