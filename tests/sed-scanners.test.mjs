// sed-scanners.test.mjs — the two sed delimiter scanners in src/shell/script-grammar.ts held to the real seds on this machine (PROGRAM_MANIFEST.md, "sed and awk"): where each ends a regular expression is where the program does.
//
// The oracle needs no parse output: `s/<r>/Q/w F`, run in an empty directory, creates the file F at compile time
// exactly when the sed's regex, replacement and flags fall where the port says (an earlier end leaves `Q/` among the
// flags, a later one leaves the s unterminated). Each half runs only where its sed is installed: GNU as `gsed` or a
// `sed` whose --version says GNU, BSD as macOS's /usr/bin/sed. The regexes are the shared vectors
// (tests/fixtures/sed-scanners/regex-ends.json, 2,926 measured with gsed 4.10 and macOS 26.7); the suite runs the
// first 600 and every row where GNU and BSD differ, and `WML_SED_SCANNERS_N=3000` runs them all.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { __gnuRegexEnd, __bsdDelimitedEnd, __plainDelimitedEnd } = await import("../src/shell/script-grammar.ts");

/** The sed binary of one implementation on this machine, or undefined. */
function sedOf(kind) {
    const says = (bin) => spawnSync(bin, ["--version"], { encoding: "utf8" });
    if (kind === "gnu") return ["gsed", "sed"].find((b) => /\(GNU sed\)/.test(says(b).stdout ?? ""));
    return process.platform === "darwin" && fs.existsSync("/usr/bin/sed") ? "/usr/bin/sed" : undefined;
}

/** The measured regexes, shared with window-ml-host (scripts/gen-sed-regex-ends.mjs writes them). */
const ROWS = JSON.parse(fs.readFileSync(new URL("./fixtures/sed-scanners/regex-ends.json", import.meta.url), "utf8")).rows;

const N = Number(process.env.WML_SED_SCANNERS_N ?? 600);
const SAMPLE = ROWS.filter((row, k) => k < N || row[1] !== row[2]).map(([script]) => script.slice(2, -6));

for (const [kind, port] of [["gnu", __gnuRegexEnd], ["bsd", __bsdDelimitedEnd]]) {
    const bin = sedOf(kind);
    test(`the ${kind} scanner ends a regular expression where ${bin ?? `${kind} sed`} does`, { skip: bin ? false : `no ${kind} sed on this machine` }, () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wml-sed-"));
        try {
            const differ = [];
            let atMarker = 0;
            for (const r of SAMPLE) {
                const script = `s/${r}/Q/w F`;
                const e = port(script, 2, "/");
                const portSays = e > 0 && __plainDelimitedEnd(script, e, "/") === script.length - 3;
                const p = spawnSync(bin, ["-n", "-e", script], { input: "", cwd: dir, encoding: "utf8" });
                const made = fs.existsSync(path.join(dir, "F"));
                fs.rmSync(path.join(dir, "F"), { force: true });
                // A regcomp error is the regex's content (an invalid class), not where it ends.
                const regcomp = /RE error|invalid|unmatched|trailing backslash|character class syntax is/i.test(p.stderr) && !/unterminated|unbalanced brackets|bad flag|unknown option/.test(p.stderr);
                const sedSays = made && p.status === 0;
                if (sedSays) atMarker++;
                if (sedSays !== portSays && !(regcomp && portSays)) differ.push({ r, port: e, sed: p.stderr.trim().slice(0, 80) });
            }
            assert.ok(atMarker > 50, `the sample reached the marker (${atMarker})`);
            assert.deepEqual(differ.slice(0, 10), []);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
}
