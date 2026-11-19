// gen-sed-regex-ends.mjs — writes the shared sed regex vectors (tests/fixtures/sed-scanners/regex-ends.json): where
// GNU and BSD sed each end a regular expression, measured against both real seds, for window-ml-host's port to be
// held to as well (PROGRAM_MANIFEST.md, "sed and awk").
//
// The regexes are bracket-heavy strings from a fixed seed; each is run as `s/<r>/Q/w F` in an empty directory, which
// creates F at compile time exactly when the sed ends the regex, replacement and flags where the port says. The
// script refuses to write unless both seds are installed (GNU as `gsed` or a `sed` whose --version says GNU, BSD as
// macOS's /usr/bin/sed) and neither disagrees with its port on any regex. A row is `[script, gnu, bsd]`: the index
// just past the closing delimiter of the regex in `script` under each port, -1 when it is not closed.
//
//   node scripts/gen-sed-regex-ends.mjs
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { __gnuRegexEnd, __bsdDelimitedEnd, __plainDelimitedEnd } = await import("../src/shell/script-grammar.ts");

const OUT = new URL("../tests/fixtures/sed-scanners/regex-ends.json", import.meta.url);
/** The two draws: the measurement as first run, then one aimed at the classes, where the two seds can differ. */
const DRAWS = [{ n: 8000, seed: 3 }, { n: 4000, seed: 5, prefixes: ["[[:", "[[.", "[[=", "a[[:", "[^[:"] }];

/** The sed binary of one implementation on this machine, or undefined. */
function sedOf(kind) {
    const says = (bin) => spawnSync(bin, ["--version"], { encoding: "utf8" });
    if (kind === "gnu") return ["gsed", "sed"].find((b) => /\(GNU sed\)/.test(says(b).stdout ?? ""));
    return process.platform === "darwin" && fs.existsSync("/usr/bin/sed") ? "/usr/bin/sed" : undefined;
}

/** The regexes the measurement draws: bracket-heavy strings, deduplicated in draw order, from a fixed seed. A draw
 * with a prefix opens a class, collating symbol or equivalence class first, where GNU and BSD can disagree. */
function regexes(n, seed, prefixes = [""]) {
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const R = ["[", "[", "[", "]", "]", "]", "\\", ":", ":", ".", "=", "^", "a", "/", "/"];
    const seen = new Set();
    for (let k = 0; k < n; k++) {
        let r = prefixes[Math.floor(rnd() * prefixes.length)];
        const len = 1 + Math.floor(rnd() * 9);
        for (let j = 0; j < len; j++) r += R[Math.floor(rnd() * R.length)];
        seen.add(r);
    }
    return [...seen];
}

/** The sed's verdict on one script: whether it ended the s where `s/<r>/Q/w F` puts the flags at `w F`. */
function sedEnds(bin, dir, script) {
    const p = spawnSync(bin, ["-n", "-e", script], { input: "", cwd: dir, encoding: "utf8" });
    const made = fs.existsSync(path.join(dir, "F"));
    fs.rmSync(path.join(dir, "F"), { force: true });
    // A regcomp error is the regex's content (an invalid class), not where it ends.
    const regcomp = /RE error|invalid|unmatched|trailing backslash|character class syntax is/i.test(p.stderr) && !/unterminated|unbalanced brackets|bad flag|unknown option/.test(p.stderr);
    return { said: made && p.status === 0, regcomp };
}

const bins = { gnu: sedOf("gnu"), bsd: sedOf("bsd") };
for (const [k, b] of Object.entries(bins)) if (!b) throw new Error(`no ${k} sed on this machine: both are needed to measure`);
const versionOf = (bin) => (spawnSync(bin, ["--version"], { encoding: "utf8" }).stdout ?? "").split("\n")[0].trim();
const ports = { gnu: __gnuRegexEnd, bsd: __bsdDelimitedEnd };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wml-sed-"));
const rows = [];
const differ = [];
try {
    for (const r of [...new Set(DRAWS.flatMap((d) => regexes(d.n, d.seed, d.prefixes)))]) {
        const script = `s/${r}/Q/w F`;
        const row = [script];
        for (const kind of ["gnu", "bsd"]) {
            const e = ports[kind](script, 2, "/");
            const portSays = e > 0 && __plainDelimitedEnd(script, e, "/") === script.length - 3;
            const { said, regcomp } = sedEnds(bins[kind], dir, script);
            if (said !== portSays && !(regcomp && portSays)) differ.push({ kind, r, port: e });
            row.push(e);
        }
        rows.push(row);
    }
} finally {
    fs.rmSync(dir, { recursive: true, force: true });
}
if (differ.length) throw new Error(`a port disagrees with its sed; nothing written:\n${JSON.stringify(differ.slice(0, 10), null, 1)}`);

const head = {
    about: "Where GNU and BSD sed end the regular expression of `s/<r>/Q/w F`: [script, gnu, bsd], the index just past its closing delimiter, -1 when not closed. Written by scripts/gen-sed-regex-ends.mjs; both ports agreed with their sed on every row.",
    measured: { gnu: versionOf(bins.gnu), bsd: `${bins.bsd} (${os.type()} ${os.release()})`, draws: DRAWS },
};
const body = rows.map((row) => "    " + JSON.stringify(row)).join(",\n");
const text = JSON.stringify(head, null, 2).replace(/\n}$/, `,\n  "rows": [\n${body}\n  ]\n}\n`);
JSON.parse(text);
fs.mkdirSync(new URL(".", OUT), { recursive: true });
fs.writeFileSync(OUT, text);
console.log(`${rows.length} regexes written to tests/fixtures/sed-scanners/regex-ends.json`);
