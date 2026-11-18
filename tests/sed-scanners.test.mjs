// sed-scanners.test.mjs — the two sed delimiter scanners in src/shell/script-grammar.ts held to the real seds on this machine (PROGRAM_MANIFEST.md, "sed and awk"): where each ends a regular expression is where the program does.
//
// The oracle needs no parse output: `s/<r>/Q/w F`, run in an empty directory, creates the file F at compile time
// exactly when the sed's regex, replacement and flags fall where the port says (an earlier end leaves `Q/` among the
// flags, a later one leaves the s unterminated). Each half runs only where its sed is installed: GNU as `gsed` or a
// `sed` whose --version says GNU, BSD as macOS's /usr/bin/sed. The suite runs a seeded sample; the lane's measurement
// (2026-11-18, gsed 4.10 and macOS 26.7: 1,735 unique regexes, no disagreement for either) is re-run with
// `WML_SED_SCANNERS_N=8000 node --import tsx --test tests/sed-scanners.test.mjs`.
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

/** The regexes the measurement draws: bracket-heavy strings, deduplicated, from a fixed seed. */
function regexes(n) {
    let seed = 3;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const R = ["[", "[", "[", "]", "]", "]", "\\", ":", ":", ".", "=", "^", "a", "/", "/"];
    const seen = new Set();
    for (let k = 0; k < n; k++) {
        let r = "";
        const len = 1 + Math.floor(rnd() * 9);
        for (let j = 0; j < len; j++) r += R[Math.floor(rnd() * R.length)];
        seen.add(r);
    }
    return [...seen];
}

const N = Number(process.env.WML_SED_SCANNERS_N ?? 600);

for (const [kind, port] of [["gnu", __gnuRegexEnd], ["bsd", __bsdDelimitedEnd]]) {
    const bin = sedOf(kind);
    test(`the ${kind} scanner ends a regular expression where ${bin ?? `${kind} sed`} does`, { skip: bin ? false : `no ${kind} sed on this machine` }, () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wml-sed-"));
        try {
            const differ = [];
            let atMarker = 0;
            for (const r of regexes(N)) {
                const script = `s/${r}/Q/w F`;
                const e = port(script, 2, "/");
                const portSays = e > 0 && __plainDelimitedEnd(script, e, "/") === script.length - 3;
                const p = spawnSync(bin, ["-n", "-e", script], { input: "", cwd: dir, encoding: "utf8" });
                const made = fs.existsSync(path.join(dir, "F"));
                fs.rmSync(path.join(dir, "F"), { force: true });
                // A regcomp error is the regex's content (an invalid class), not where it ends.
                const regcomp = /RE error|invalid|unmatched|trailing backslash/i.test(p.stderr) && !/unterminated|unbalanced brackets|bad flag|unknown option/.test(p.stderr);
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
