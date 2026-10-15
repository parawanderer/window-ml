// program-manifest.test.mjs — program manifests (src/shell/program-manifest.ts, docs/spec/PROGRAM_MANIFEST.md): every shipped manifest validates, every fixture call describes as recorded, every flag that changes a call's effects is ENUMERATED in a fixture, an unlisted flag or subcommand is unknown, and the descriptions meet the free tier (src/effects.ts) the way the spec says.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const { describeCall, hardenArgv, validateManifest, inRange } = await import("../src/shell/program-manifest.ts");
const { effectKey, free, boundFor } = await import("../src/effects.ts");

const MANIFESTS = new URL("../src/shell/manifests/", import.meta.url);
const FIXTURES = new URL("./fixtures/program-calls/", import.meta.url);
const manifests = Object.fromEntries(fs.readdirSync(MANIFESTS).filter((f) => f.endsWith(".json")).map((f) =>
    [path.basename(f, ".json"), JSON.parse(fs.readFileSync(new URL(f, MANIFESTS), "utf8"))]));
const fixtures = Object.fromEntries(fs.readdirSync(FIXTURES).filter((f) => f.endsWith(".json")).map((f) =>
    [path.basename(f, ".json"), JSON.parse(fs.readFileSync(new URL(f, FIXTURES), "utf8"))]));
const keys = (e) => e === "unknown" ? "unknown" : e.map(effectKey).sort();

/** Every command of a manifest with its subcommand path: [path, spec]. */
function commands(cmd, at = []) {
    return [[at, cmd], ...Object.entries(cmd.subcommands ?? {}).flatMap(([n, s]) => commands(s, [...at, n]))];
}

/** A flag changes a call's description when it adds an effect, a path, a directory, a runner, an echo or an answer code. */
const changesEffect = (f) => (f.effects?.length ?? 0) > 0 || f.valueIsPath || f.valueIsDir || f.runner || f.echoes || f.okCodes || f.recursive || f.pathsFrom !== undefined;

// --- the shipped manifests ---

test("the first set from PROGRAM_MANIFEST.md ships, one file per program", () => {
    assert.deepEqual(Object.keys(manifests).sort(), ["cat", "find", "git", "head", "jq", "ls", "rg", "tail", "wc"]);
    for (const [file, m] of Object.entries(manifests)) assert.equal(m.program, file, `${file}.json names ${m.program}`);
});

test("every shipped manifest validates", () => {
    for (const [name, m] of Object.entries(manifests)) assert.deepEqual(validateManifest(m), [], name);
});

test("every manifest has a fixture, and every fixture a manifest", () => {
    assert.deepEqual(Object.keys(fixtures).sort(), Object.keys(manifests).sort());
});

// --- the fixtures: the vectors both readers (this one and the host's) are held to ---

for (const [name, fx] of Object.entries(fixtures)) {
    test(`${name}: every fixture call describes as recorded`, () => {
        assert.ok(fx.calls.length >= 8, `${name} has a real fixture, not a sample`);
        for (const c of fx.calls) {
            const d = describeCall(c.argv, manifests[name], { version: fx.version });
            const got = { described: d.described, effects: keys(d.effects), pathArgs: d.pathArgs, actsOnDir: d.actsOnDir, runner: d.runner, okCodes: d.okCodes, echoes: d.echoes, recursive: d.recursive, hardened: hardenArgv(c.argv, d) };
            const want = { described: c.described, effects: c.effects, pathArgs: c.pathArgs, actsOnDir: c.actsOnDir, runner: c.runner, okCodes: c.okCodes, echoes: c.echoes, recursive: c.recursive, hardened: c.hardened };
            assert.deepEqual(got, want, `${c.argv.join(" ")} (${c.note})`);
            assert.equal(typeof c.note, "string", "each call says what it is for");
        }
    });

    test(`${name}: every flag and primary that changes the effects is enumerated in the fixture`, () => {
        const missing = [];
        for (const [at, cmd] of commands(manifests[name].command)) {
            const inCommand = fx.calls.filter((c) => at.every((s, i) => c.argv.slice(1).filter((a) => !a.startsWith("-"))[i] === s || c.argv.includes(s)));
            const used = (flag) => inCommand.some((c) => c.argv.some((a) => a === flag || a.startsWith(`${flag}=`)
                || (flag.length === 2 && flag[0] === "-" && /^-[A-Za-z]+$/.test(a) && a.includes(flag[1]) && cmd.clusters)));
            for (const [flag, f] of Object.entries(cmd.flags)) if (changesEffect(f) && !used(flag)) missing.push(`${[name, ...at].join(" ")} ${flag}`);
            for (const [p, spec] of Object.entries(cmd.primaries ?? {})) {
                if (((spec.effects?.length ?? 0) > 0 || spec.argIsPath || spec.runner) && !used(p)) missing.push(`${name} ${p}`);
            }
        }
        assert.deepEqual(missing, [], "flags that change the effects need a fixture call each (enumerate, do not sample)");
    });

    test(`${name}: an unlisted flag makes every command unknown`, () => {
        for (const [at, cmd] of commands(manifests[name].command)) {
            if (cmd.subcommands) continue;
            const argv = [name, ...at, "--wml-not-a-flag"];
            const d = describeCall(argv, manifests[name], { version: fx.version });
            assert.equal(d.described, false, argv.join(" "));
            assert.equal(d.effects, "unknown");
        }
    });
}

// --- describeCall's rules, independent of any one program ---

const git = manifests.git;
const V = { version: "2.55.0" };

test("an unlisted subcommand, a wrong program name, an unreported or out-of-range version: unknown", () => {
    assert.equal(describeCall(["git", "commit", "-m", "x"], git, V).effects, "unknown");
    assert.equal(describeCall(["notgit", "status"], git, V).described, false);
    assert.equal(describeCall(["git", "status"], git, {}).described, false, "no version reported");
    assert.equal(describeCall(["git", "status"], git, { version: "1.9.0" }).described, false);
    assert.equal(describeCall(["/opt/homebrew/bin/git", "status"], git, V).described, true, "argv[0] by basename");
});

test("an env change the manifest names makes the call unknown", () => {
    assert.equal(describeCall(["git", "status"], git, { ...V, envSet: ["GIT_DIR"] }).described, false);
    assert.equal(describeCall(["git", "status"], git, { ...V, envSet: ["LC_ALL"] }).described, true);
});

test("a flag missing its value, or a value on a flag that takes none, is unknown", () => {
    assert.equal(describeCall(["git", "log", "-n"], git, V).described, false);
    assert.equal(describeCall(["git", "status", "--short=yes"], git, V).described, false);
});

test("a path attached to a short flag cannot be resolved, so it is unknown", () => {
    assert.equal(describeCall(["git", "diff", "-Oorder.txt"], git, V).described, false);
    assert.equal(describeCall(["git", "diff", "-O", "order.txt"], git, V).described, true);
});

test("the terminator and the operand start are reported for the host", () => {
    const d = describeCall(["git", "log", "--oneline", "HEAD~3"], git, V);
    assert.equal(d.terminator, "--end-of-options");
    assert.equal(d.operandStart, 3);
    assert.equal(describeCall(["git", "status"], git, V).operandStart, null);
});

// --- meeting the free tier (EFFECTS.md): the description is what free() reads ---

const resolveIn = (inRoot, secret = false) => ({ arg, given }) => ({ kind: "fs", path: arg === "cwd" ? "/r" : `/r/${given}`, inRoot, secret });

test("git status in a root is free on the plain host once the host resolved the repository inside a root", () => {
    const d = describeCall(["git", "status"], git, { ...V, resolve: resolveIn(true) });
    assert.equal(free(d.effects, boundFor("host-plain")), true);
    const unresolved = describeCall(["git", "status"], git, V);
    assert.equal(free(unresolved.effects, boundFor("host-plain")), false, "an unresolved path is covered by nothing");
    const outside = describeCall(["git", "status"], git, { ...V, resolve: resolveIn(false) });
    assert.equal(free(outside.effects, boundFor("host-plain")), false);
});

test("every effect-changing flag of git diff takes the call out of the plain host's free tier", () => {
    for (const extra of [["--output=x.patch"], ["--ext-diff"], ["--textconv"], ["--no-index", "a", "b"]]) {
        const d = describeCall(["git", "diff", ...extra], git, { ...V, resolve: resolveIn(true) });
        assert.equal(free(d.effects, boundFor("host-plain")), false, extra.join(" "));
    }
});

test("under the sandbox a write inside the roots is free, a runner is not if it is unknown, and a secret never is", () => {
    const sb = boundFor("host-sandbox");
    const out = describeCall(["git", "diff", "--output=x.patch"], git, { ...V, resolve: resolveIn(true) });
    assert.equal(free(out.effects, sb), true, "a write in the roots is inside the sandbox's bound");
    const secret = describeCall(["git", "blame", "--contents", ".env", "a"], git, { ...V, resolve: ({ arg, given }) =>
        ({ kind: "fs", path: arg === "cwd" ? "/r" : `/r/${given}`, inRoot: true, secret: given === ".env" }) });
    assert.equal(free(secret.effects, sb), false);
    assert.equal(free(describeCall(["git", "-c", "core.pager=sh", "log"], git, V).effects, sb), false);
});

test("network effects keep their direction, and an unnamed host is any host", () => {
    assert.deepEqual(keys(describeCall(["git", "fetch"], git, { ...V, resolve: resolveIn(true) }).effects).filter((k) => k.includes("net")), ["read:net:*"]);
    assert.deepEqual(keys(describeCall(["git", "push"], git, { ...V, resolve: resolveIn(true) }).effects).filter((k) => k.includes("net")), ["read:net:*", "write:net:*"]);
});

// --- versions ---

test("version ranges: comparators all hold, missing parts are zero", () => {
    assert.equal(inRange("2.55.0", ">=2.30.0 <3"), true);
    assert.equal(inRange("2.30", ">=2.30.0 <3"), true);
    assert.equal(inRange("3.0.0", ">=2.30.0 <3"), false);
    assert.equal(inRange("2.29.9", ">=2.30.0"), false);
    assert.equal(inRange("14.1.1", ">=13"), true);
    assert.equal(inRange("1.7.1", "=1.7.1"), true);
    assert.equal(inRange("garbage", ">=1"), false);
});

// --- the validator ---

test("the validator refuses a misspelt key, a runner that runs nothing, a bad effect term and a bad range", () => {
    const base = { program: "x", version: { range: ">=1", args: ["--version"], pattern: "(\\d+)" },
        command: { effects: ["read"], paths: "operands", flags: { "-v": {} } } };
    assert.deepEqual(validateManifest(base), []);
    const bad = (patch) => validateManifest(structuredClone({ ...base, ...patch }));
    assert.match(bad({ command: { ...base.command, flags: { "-x": { runer: true } } } }).join(), /unknown key runer/);
    assert.match(bad({ command: { ...base.command, flags: { "-x": { runner: true } } } }).join(), /runner's effects/);
    assert.match(bad({ command: { ...base.command, effects: ["delete"] } }).join(), /not a program effect/);
    assert.match(bad({ command: { ...base.command, effects: [{ network: { direction: "out" } }] } }).join(), /not a program effect/);
    assert.match(bad({ version: { range: "latest", args: [], pattern: "x" } }).join(), /range/);
    assert.match(bad({ command: { ...base.command, flags: { "-x": { valueIsPath: "write" } } } }).join(), /needs value: true/);
    assert.match(bad({ extra: 1 }).join(), /unknown key extra/);
});

// --- hardening and recursive readers (rulings of 2026-10-15) ---

test("a hardened argv describes exactly as the original, for every fixture call", () => {
    for (const [name, fx] of Object.entries(fixtures)) for (const c of fx.calls) {
        const d = describeCall(c.argv, manifests[name], { version: fx.version });
        const h = describeCall(hardenArgv(c.argv, d), manifests[name], { version: fx.version });
        assert.deepEqual(keys(h.effects), keys(d.effects), `${c.argv.join(" ")}: hardening changed the effects`);
        assert.equal(h.described, d.described, c.argv.join(" "));
    }
});

test("git's read subcommands are hardened against the repository's pager, external diff and textconv", () => {
    const h = (argv) => hardenArgv(argv, describeCall(argv, git, V));
    assert.deepEqual(h(["git", "diff", "HEAD"]), ["git", "--no-pager", "diff", "--no-ext-diff", "--no-textconv", "HEAD"]);
    assert.deepEqual(h(["git", "-C", "x", "log", "-1"]), ["git", "--no-pager", "-C", "x", "log", "--no-ext-diff", "--no-textconv", "-1"]);
    assert.deepEqual(h(["git", "--no-pager", "status"]), ["git", "--no-pager", "status"], "nothing doubled");
});

test("a recursive reader marks every walked path, and its own directory when it has no path", () => {
    const rg = manifests.rg, find = manifests.find, ls = manifests.ls;
    const v = (m) => ({ version: fixtures[m.program].version });
    const a = describeCall(["rg", "TODO", "src", "docs"], rg, v(rg));
    assert.equal(a.recursive, true);
    assert.deepEqual(a.pathArgs.map((p) => [p.arg, p.walk]), [[2, true], [3, true]]);
    const b = describeCall(["rg", "TODO"], rg, v(rg));
    assert.equal(b.recursive && b.actsOnDir, true, "no path: the cwd is walked");
    assert.equal(describeCall(["find", ".", "-name", "*.ts"], find, v(find)).pathArgs[0].walk, true);
    assert.equal(describeCall(["ls", "src"], ls, v(ls)).recursive, false);
    assert.equal(describeCall(["ls", "-R", "src"], ls, v(ls)).pathArgs[0].walk, true);
    assert.equal(describeCall(["cat", "a.txt"], manifests.cat, v(manifests.cat)).recursive, false);
});
