// The JSDoc drift check (scripts/check-jsdoc.mjs). Run against FIXTURE sources, never this repo, so a test
// never asserts a fact about a file someone is editing.
//
// The thing under test is a judgement call as much as a parser: a MISSING @param is fine and must never be
// reported, because AGENTS.md asks for them "where useful". What is never fine is documentation that
// CONTRADICTS the code — and the reason this repo cares more than most is that contract.ts's JSDoc is lifted
// verbatim into what the model reads, so a wrong @param there ships a wrong API reference.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "check-jsdoc.mjs");

function fixture(files) {
    const root = mkdtempSync(join(tmpdir(), "jsdoc-"));
    mkdirSync(join(root, "src"), { recursive: true });
    for (const [rel, body] of Object.entries(files)) {
        mkdirSync(join(root, dirname(rel)), { recursive: true });
        writeFileSync(join(root, rel), body);
    }
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(join(root, "scripts", "check-jsdoc.mjs"), readFileSync(SCRIPT, "utf8"));
    return {
        root,
        /** stdout as split fields; the script exits 0 without --strict, so this never throws on findings. */
        run: (...args) => execFileSync(process.execPath, [join(root, "scripts", "check-jsdoc.mjs"), ...args],
            { cwd: root, encoding: "utf8" }).trim().split("\n").filter(Boolean).map((l) => l.split("\t")),
        stop: () => rmSync(root, { recursive: true, force: true }),
    };
}

test("check-jsdoc: a @param naming something the function does not take is reported", async () => {
    const fx = fixture({
        "src/a.ts": `/**
 * Do a thing.
 * @param count how many
 */
export function doIt(amount: number) { return amount; }
`,
    });
    try {
        const hits = fx.run().filter((r) => r[1] === "UNKNOWN");
        assert.equal(hits.length, 1);
        assert.match(hits[0][2], /@param count/);
    } finally { fx.stop(); }
});

test("check-jsdoc: a MISSING @param is never reported — a subset misleads nobody", async () => {
    const fx = fixture({
        "src/a.ts": `/**
 * Do a thing.
 * @param first the one that mattered enough to explain
 */
export function doIt(first: number, second: string, third: boolean) { return first; }
`,
    });
    try {
        assert.deepEqual(fx.run().filter((r) => r[1]), [], "documenting one of three arguments is a choice");
    } finally { fx.stop(); }
});

test("check-jsdoc: a DESTRUCTURED options object is matched on its properties, not its name", async () => {
    const fx = fixture({
        "src/a.ts": `/**
 * Chat.
 * @param prompt the prompt
 * @param options the options
 * @param options.think whether to think
 * @param options.gone a setting that was removed
 */
export function chat(prompt: string, { think = false }: { think?: boolean } = {}) { return think; }
`,
    });
    try {
        const hits = fx.run().filter((r) => r[1] === "UNKNOWN");
        // `options` has no name of its own in the signature, so it is never the finding; `options.gone` is.
        assert.equal(hits.length, 1, `expected only options.gone, got ${JSON.stringify(hits)}`);
        assert.match(hits[0][2], /options\.gone/);
    } finally { fx.stop(); }
});

test("check-jsdoc: a doc block documenting NOTHING is reported (the failure that started this)", async () => {
    // Found on main the day the check was written: `__loads`'s block sat above `__housekeeping`'s, so one
    // documented nothing and the other advertised an option it does not take.
    const fx = fixture({
        "src/a.ts": `/**
 * The older copy of this documentation.
 * @param opts.clear empty the store after reading
 */
/** The one that is actually attached. */
export function dump(opts?: { download?: boolean }) { return opts; }
`,
    });
    try {
        const hits = fx.run().filter((r) => r[1] === "ORPHANED");
        assert.equal(hits.length, 1);
        assert.match(hits[0][2], /documents nothing/);
    } finally { fx.stop(); }
});

test("check-jsdoc: a contradicting primitive type is reported, a vaguer JSDoc spelling is not", async () => {
    const fx = fixture({
        "src/a.ts": `/**
 * @param {string} id the identifier
 */
export function byId(id: number) { return id; }

/**
 * @param {Object} opts the options
 * @param {Function} cb what to call
 */
export function run(opts: Record<string, unknown>, cb: () => void) { return [opts, cb]; }
`,
    });
    try {
        const hits = fx.run().filter((r) => r[1] === "TYPE");
        assert.equal(hits.length, 1, `{Object} for a Record and {Function} for a function are JSDoc's own`
            + ` vaguer spellings, not drift — flagging them is how a check gets suppressed. Got ${JSON.stringify(hits)}`);
        assert.match(hits[0][2], /@param \{string\} id — declared number/);
    } finally { fx.stop(); }
});

test("check-jsdoc: a comment between the doc and the declaration does not defeat it", async () => {
    const fx = fixture({
        "src/a.ts": `/**
 * Do a thing.
 * @param count how many
 */
// an aside about the implementation, which is common in this repo
export function doIt(amount: number) { return amount; }
`,
    });
    try {
        assert.equal(fx.run().filter((r) => r[1] === "UNKNOWN").length, 1, "the declaration is still found");
    } finally { fx.stop(); }
});
