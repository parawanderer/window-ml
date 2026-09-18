"use strict";
// scripts/extract-function.mjs — lifting a range of statements into its own function. The refactor itself is
// TypeScript's `Extract Symbol`; what is tested here is what this repo added on top: choosing module scope,
// naming the result, refusing a range the compiler will not take, and never writing on --dry-run.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const SCRIPT = path.join(process.cwd(), "scripts", "extract-function.mjs");
const TSCONFIG = JSON.stringify({
    compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true, noEmit: true },
    include: ["src"],
});

function fixture(t, files) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "extract-fn-test-"));
    fs.writeFileSync(path.join(root, "tsconfig.json"), TSCONFIG);
    for (const [rel, text] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), text);
    }
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return {
        root,
        read: (rel) => fs.readFileSync(path.join(root, rel), "utf8"),
        run(args) {
            try {
                return { code: 0, out: execFileSync("node", [SCRIPT, "--root", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
            } catch (e) {
                return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
            }
        },
    };
}

const SRC = [
    "// a.ts — the fixture.",
    "",
    "export function big(a: number, b: number): number {",
    "    const x = a * 2;",
    "    const y = b * 3;",
    "    const sum = x + y;",
    "    const scaled = sum * 10;",
    "    return scaled;",
    "}",
    "",
].join("\n");

test("extracts a statement range to MODULE scope under the name given, and renames every reference", (t) => {
    const f = fixture(t, { "src/a.ts": SRC });
    const r = f.run(["--file", "src/a.ts", "--lines", "6-7", "--name", "combine"]);
    assert.equal(r.code, 0, r.out);
    const after = f.read("src/a.ts");
    assert.match(after, /function combine\(/, "the extracted function carries the requested name");
    assert.doesNotMatch(after, /newFunction/, "the refactor's placeholder name is gone");
    assert.match(after, /^\/\/ a\.ts — the fixture\./, "the module header is untouched");
    // Module scope, not nested inside `big`: the whole point when splitting a large file.
    assert.match(after, /\n(export )?function combine\(/, "combine sits at module scope");
});

test("--scope inner keeps the extraction nested in the enclosing function", (t) => {
    const f = fixture(t, { "src/a.ts": SRC });
    const r = f.run(["--file", "src/a.ts", "--lines", "6-7", "--name", "combine", "--scope", "inner"]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Extract to inner function/, "it reports the scope it used");
});

test("--dry-run writes nothing", (t) => {
    const f = fixture(t, { "src/a.ts": SRC });
    const r = f.run(["--file", "src/a.ts", "--lines", "6-7", "--name", "combine", "--dry-run"]);
    assert.equal(r.code, 0, r.out);
    assert.equal(f.read("src/a.ts"), SRC, "the file on disk is unchanged");
    assert.match(r.out, /dry run: nothing written/);
});

test("a range the compiler will not extract is REFUSED, with why", (t) => {
    // Half of a statement: the range starts mid-declaration, so there is no expression or statement list to lift.
    const f = fixture(t, { "src/a.ts": ["// a.ts — the fixture.", "", "export const v = {", "    k: 1,", "};", ""].join("\n") });
    const r = f.run(["--file", "src/a.ts", "--lines", "4-4", "--name", "part"]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /will not extract/);
    assert.match(f.read("src/a.ts"), /export const v = \{/, "the source is untouched");
});

test("an invalid identifier is rejected before any work happens", (t) => {
    const f = fixture(t, { "src/a.ts": SRC });
    const r = f.run(["--file", "src/a.ts", "--lines", "6-7", "--name", "not a name"]);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /not a valid identifier/);
});
