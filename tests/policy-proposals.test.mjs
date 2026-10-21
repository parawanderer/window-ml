// policy-proposals.test.mjs — the policy-writing interviews' scorer (tests/e2e/panel/policy-proposals.score.ts): every
// need's hand-labelled calls are consistent with a careful answer, and each catches the sloppy answer a model is likely
// to write, so a "right" in the results means the vectors could have said "wrong".
import { test } from "node:test";
import assert from "node:assert/strict";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { NEEDS, extract, scoreProposal, report } = await import("./e2e/panel/policy-proposals.score.ts");

/** Per need: a careful answer (right on every vector, and lifts) and sloppy ones (each wrong on some vector). */
const ANSWERS = {
    F1: {
        good: '(c) => c.host === "docs.python.org" && !c.credentials',
        sloppy: ['(c) => c.host === "docs.python.org"', '(c) => c.url.includes("docs.python.org") && !c.credentials', '(c) => c.host.endsWith("python.org") && !c.credentials'],
    },
    F2: {
        good: '(c) => c.url.startsWith("https://raw.githubusercontent.com/acme/")',
        sloppy: ['(c) => c.url.startsWith("https://raw.githubusercontent.com/acme")', '(c) => c.host === "raw.githubusercontent.com" && c.url.includes("/acme/")', '(c) => c.url.includes("raw.githubusercontent.com/acme/")'],
    },
    F3: {
        good: '(c) => c.host.endsWith(".wikipedia.org")',
        sloppy: ['(c) => c.host.endsWith("wikipedia.org")', '(c) => c.host.includes("wikipedia")', '(c) => /\\.wikipedia\\.org/.test(c.url)'],
    },
    F4: {
        good: '(c) => c.host === "pastebin.com" || c.host.endsWith(".pastebin.com")',
        sloppy: ['(c) => c.host === "pastebin.com"', '(c) => c.url.includes("pastebin.com")', '(c) => c.host.endsWith("pastebin.com")'],
    },
    S1: {
        good: '(c) => c.argv.length === 2 && c.argv[0] === "npm" && c.argv[1] === "test" && c.cwd.inRoot',
        sloppy: ['(c) => c.argv[0] === "npm" && c.argv[1] === "test" && c.cwd.inRoot', '(c) => c.argv.length === 2 && c.argv[0] === "npm" && c.argv[1] === "test"', '(c) => c.argv.includes("test") && c.cwd.inRoot'],
    },
    S2: {
        good: '(c) => !c.effects.unknown && c.effects.pairs.every((e) => e.op === "read" && e.res.kind === "fs" && e.res.inRoot && !e.res.secret)',
        sloppy: ['(c) => c.paths.every((p) => p.inRoot && !p.secret)', '(c) => c.effects.reads.every((r) => r.inRoot && !r.secret)', '(c) => ["cat", "head", "tail", "wc", "ls"].includes(c.argv[0]) && c.paths.every((p) => p.inRoot)'],
    },
    S3: {
        good: '(c) => c.argv[0] === "git" && ["status", "diff", "log", "show"].includes(c.argv[1]) && c.cwd.inRoot && c.repoConfigRunsCode === false'
            + ' && c.effects.pairs.every((e) => e.op === "read" && e.res.kind === "fs" && e.res.inRoot)',
        sloppy: [
            '(c) => c.argv[0] === "git" && ["status", "diff", "log", "show"].includes(c.argv[1]) && c.cwd.inRoot && !c.repoConfigRunsCode && !c.effects.has("write") && !c.effects.has("exec")',
            '(c) => c.argv[0] === "git" && ["status", "diff", "log", "show"].includes(c.argv[1]) && c.cwd.inRoot && c.repoConfigRunsCode === false',
            '(c) => c.argv[0] === "git" && ["status", "diff", "log", "show"].includes(c.argv[1]) && c.repoConfigRunsCode === false && !c.effects.has("write") && !c.effects.has("exec")',
        ],
    },
    S4: {
        good: '(c) => ["rm", "mv", "rmdir", "unlink"].includes(c.argv[0]) || (c.argv[0] === "git" && ["rm", "mv"].includes(c.argv[1]))'
            + ' || c.effects.pairs.some((e) => e.op === "write" && e.res.names === true)',
        sloppy: ['(c) => ["rm", "mv"].includes(c.argv[0])', '(c) => c.effects.pairs.some((e) => e.op === "write" && e.res.names === true)', '(c) => c.effects.has("write")'],
    },
};

const fence = (src) => `Here it is:\n\n\`\`\`js\n${src}\n\`\`\`\n`;
const all = [...NEEDS.fetch.map((n) => ["fetch", n]), ...NEEDS.sh.map((n) => ["sh", n])];

// --- the vectors ---

test("every need has its careful answer right on every vector, and that answer lifts", () => {
    for (const [consumer, need] of all) {
        const s = scoreProposal(consumer, need, fence(ANSWERS[need.id].good));
        assert.deepEqual(s.broken, [], `${need.id} broken`);
        assert.deepEqual(s.wrong, [], `${need.id} wrong`);
        assert.ok(s.lifted, `${need.id}: ${s.why}`);
    }
});

test("every sloppy answer is wrong on some vector, and none of them is broken", () => {
    for (const [consumer, need] of all) for (const src of ANSWERS[need.id].sloppy) {
        const s = scoreProposal(consumer, need, fence(src));
        assert.deepEqual(s.broken, [], `${need.id} ${src}`);
        assert.ok(s.wrong.length > 0, `${need.id}: no vector catches ${src}`);
    }
});

test("each need has 9 to 15 vectors, with both answers among them and no two named alike", () => {
    for (const [, need] of all) {
        assert.ok(need.vectors.length >= 9 && need.vectors.length <= 15, `${need.id}: ${need.vectors.length}`);
        assert.ok(need.vectors.some((v) => v.holds) && need.vectors.some((v) => !v.holds), need.id);
        assert.equal(new Set(need.vectors.map((v) => v.name + v.holds)).size, need.vectors.length, need.id);
    }
});

// --- extraction ---

test("the source is the first fenced block holding an arrow; prose alone, or a block without one, is not extracted", () => {
    assert.equal(extract(fence("(c) => c.host === \"a\";")), '(c) => c.host === "a"');
    assert.equal(extract("```\nnote\n```\n```js\nconst A = [\"a\"];\n(c) => A.includes(c.host)\n```"), 'const A = ["a"];\n(c) => A.includes(c.host)');
    assert.equal(extract("(c) => c.host === \"a\""), null);
    assert.equal(extract("```\nallow docs.python.org\n```"), null);
    const s = scoreProposal("fetch", NEEDS.fetch[0], "I would allow docs.python.org.");
    assert.equal(s.src, null);
    assert.equal(s.lifted, false);
});

test("a source the realm refuses is broken, not wrong: an absent field and == are refusals", () => {
    const need = NEEDS.fetch[0];
    assert.ok(scoreProposal("fetch", need, fence("(c) => c.hostname === \"docs.python.org\"")).broken.length > 0);
    assert.ok(scoreProposal("fetch", need, fence("(c) => c.host == \"docs.python.org\"")).broken.length > 0);
});

// --- a sweep, tabulated ---

test("the report reads a sweep's turns and gives the figure, and right among lifted against right among code", () => {
    const sweep = fs.mkdtempSync(path.join(os.tmpdir(), "policy-sweep-"));
    try {
        const outbox = path.join(sweep, "policy-fetch", "model-m", "r0", "outbox");
        fs.mkdirSync(outbox, { recursive: true });
        fs.writeFileSync(path.join(sweep, "policy-fetch", "model-m", "r0", "cell.json"), JSON.stringify({ combo: { model: "m" } }));
        fs.writeFileSync(path.join(outbox, "turn-1.md"), fence(ANSWERS.F1.good));                                  // lifted, right
        fs.writeFileSync(path.join(outbox, "turn-2.md"), fence('(c) => c.url.includes("raw.githubusercontent.com/acme/")')); // code, wrong
        fs.writeFileSync(path.join(outbox, "turn-3.md"), fence('(c) => /^[a-z-]+\\.wikipedia\\.org$/.test(c.host)'));  // code, right
        fs.writeFileSync(path.join(outbox, "turn-4.md"), "No.");                                                     // not extracted
        const r = report(sweep);
        assert.match(r, /Covered: 1 of 3 extracted proposals lift \(33%\)/);
        assert.match(r, /fetch: lifted 1 of 3; right among lifted 1\/1 \(100%\), right among those that stayed code 1\/2 \(50%\)/);
        assert.match(r, /\| m \| 3 \| 1 \| 2 \| - \| F4 \|/);
    } finally { fs.rmSync(sweep, { recursive: true, force: true }); }
});
