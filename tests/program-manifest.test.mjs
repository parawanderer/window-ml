// program-manifest.test.mjs — program manifests (src/shell/program-manifest.ts, docs/spec/PROGRAM_MANIFEST.md): every shipped manifest validates, every fixture call describes as recorded, every flag that changes a call's effects is ENUMERATED in a fixture, an unlisted flag or subcommand is unknown, and the descriptions meet the free tier (src/effects.ts) the way the spec says.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const { describeCall, hardenArgv, validateManifest, inRange, CREDENTIAL_PROVIDERS, scriptLacksRunsCode, SCRIPT_RUNS_CODE_WARNING } = await import("../src/shell/program-manifest.ts");
const { effectKey, free, boundFor, fromProgramEffect } = await import("../src/effects.ts");

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
    assert.deepEqual(Object.keys(manifests).sort(), ["awk", "cat", "cp", "find", "gh", "git", "head", "jq", "ls", "mv", "rg", "rm", "rmdir", "sed", "tail", "unlink", "wc"]);
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

// --- SHELL.md's name-immutable top level reaches find -delete (2026-10-19): a removal of a top-level name is not free ---

test("find -delete removes names: a removal at a root's top level is inside no bound", () => {
    // The removal counterpart of the `.envrc` creation guard (effects.test.mjs, sw-policies.test.mjs). find.json
    // claims -delete as write-names (K3c, #788): the effect is a write marked names over the OPERAND's resolved
    // place, and claimsTopLevelName fails CLOSED when that place was not resolved as neither a top-level entry nor
    // a root. So find /r -delete (isRoot) and find /r/src -delete (topLevel) ask, and a nested removal stays free.
    const sb = boundFor("host-sandbox");
    const find = manifests.find;
    // The host resolved the operand under a root at /r: depth 0 is the root itself, depth 1 a top-level entry.
    const at = (inRoot, secret = false) => ({ arg, given }) => {
        const depth = given === "/r" ? 0 : given.replace(/^\/r\/?/, "").split("/").filter(Boolean).length;
        return { kind: "fs", path: given, inRoot, secret, exists: true, isRoot: depth === 0, topLevel: depth === 1 };
    };
    const d = (argv) => describeCall(argv, find, { version: "*", resolve: at(true) });
    // Vector: find /r -delete removes .envrc, .mcp.json, .vscode/ — every top-level name of the root.
    assert.equal(free(d(["find", "/r", "-delete"]).effects, sb), false,
        "find -delete on a root removes its top-level names");
    // The same claim when the operand is itself a top-level entry: find /r/src -delete unlinks src.
    assert.equal(free(d(["find", "/r/src", "-delete"]).effects, sb), false,
        "find -delete that unlinks a top-level entry is inside no bound");
    // Positive control: a nested removal is free (the rule is universal over the top level, not over every path).
    assert.equal(free(d(["find", "/r/src/a.ts", "-delete"]).effects, sb), true,
        "a nested removal is free");
    // Positive control: a read-only find is free.
    assert.equal(free(d(["find", "/r", "-name", "*.ts"]).effects, sb), true,
        "a read-only find is free");
});

test("an UNMARKED names write asks: claimsTopLevelName fails closed when the place was not resolved", () => {
    // The fail-closed line is worth pinning (effects.ts claimsTopLevelName): a names write whose fact carries no
    // topLevel/isRoot is treated as a top-level claim, so a resolver that forgets the markers degrades to ASKING,
    // never to running free. This is what the first draft of the test above missed — its stub resolver returned
    // bare facts, and a nested removal asked for the wrong reason.
    const sb = boundFor("host-sandbox");
    const unmarked = fromProgramEffect("write-names", { paths: [{ kind: "fs", path: "/r/src/a.ts", inRoot: true, secret: false }] });
    assert.equal(free(unmarked, sb), false,
        "a names write with no place facts is inside no bound");
    // Positive control: the same path with the markers the resolver computes is free (nested names write).
    const marked = fromProgramEffect("write-names", { paths: [{ kind: "fs", path: "/r/src/a.ts", inRoot: true, secret: false, exists: true, isRoot: false, topLevel: false }] });
    assert.equal(free(marked, sb), true,
        "a nested names write the host resolved is free");
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
    assert.deepEqual(bad({ command: { ...base.command, effects: ["write-names"] } }), [], "write-names is a program effect (PROGRAM_MANIFEST.md, 2026-10-19)");
    assert.match(bad({ command: { ...base.command, effects: ["write_names"] } }).join(), /not a program effect/);
    assert.match(bad({ command: { ...base.command, effects: [{ network: { direction: "out" } }] } }).join(), /not a program effect/);
    assert.match(bad({ version: { range: "latest", args: [], pattern: "x" } }).join(), /range/);
    assert.match(bad({ command: { ...base.command, flags: { "-x": { valueIsPath: "write" } } } }).join(), /needs value: true/);
    assert.match(bad({ extra: 1 }).join(), /unknown key extra/);
});

test("a script's manifest has an entrypoint and NO version; a binary's has a version and no entrypoint; each violation is refused", () => {
    const cmd = { effects: ["read"], paths: "operands", flags: { "-n": {} } };
    const script = { program: "node", entrypoint: { path: "scripts/tool.mjs", sha256: "a".repeat(64) }, command: cmd };
    assert.deepEqual(validateManifest(script), []);
    const v = { range: "*", args: [], pattern: "" };
    assert.match(validateManifest({ ...script, version: v }).join(), /\$\.version: a script is pinned by its entrypoint's sha256, so it has no version/);
    assert.match(validateManifest({ program: "node", command: cmd }).join(), /\$\.version: \{range, args, pattern\}/, "neither is refused too");
    const ep = (e) => validateManifest({ ...script, entrypoint: e }).join();
    for (const path of ["/abs/tool.mjs", "../tool.mjs", "scripts/../tool.mjs", "./tool.mjs", "-tool.mjs", "scripts//tool.mjs", ""]) assert.match(ep({ path, sha256: "a".repeat(64) }), /entrypoint\.path/, path);
    assert.match(ep({ path: "t.mjs", sha256: "A".repeat(64) }), /entrypoint\.sha256/);
    assert.match(ep({ path: "t.mjs", sha256: "a".repeat(64), extra: 1 }), /\$\.entrypoint: \{path, sha256\}/);
});

test("a credential is its provider's program's alone, and its ports and hosts subsets of the provider's", () => {
    const gh = JSON.parse(fs.readFileSync(new URL("gh.json", MANIFESTS), "utf8"));
    assert.deepEqual(gh.credential, { provider: "github" });
    assert.deepEqual(gh.network, { ports: [443], hosts: CREDENTIAL_PROVIDERS.github.hosts }, "the shipped gh.json asks for every GitHub host the host lists");
    const v = (patch) => validateManifest({ ...gh, ...patch }).join("\n");
    assert.equal(v({}), "");
    assert.match(v({ credential: { provider: "aws" } }), /\$\.credential\.provider: one of github/);
    assert.match(v({ credential: { provider: "toString" } }), /\$\.credential\.provider: one of github/, "a prototype key is no provider");
    assert.match(v({ credential: { provider: "github", env: "GH_TOKEN" } }), /\$\.credential: \{provider\}/, "no env name comes from a manifest");
    assert.match(v({ credential: "github" }), /\$\.credential: \{provider\}/);
    assert.match(v({ program: "curl" }), /\$\.credential\.provider: github is gh's alone/);
    for (const ports of [[80], [443, 22], [], ["443"], 443]) assert.match(v({ network: { ports } }), /\$\.network/, JSON.stringify(ports));
    for (const hosts of [["*"], ["*.github.com"], ["example.com"], ["api.github.com", "evil.test"], ["API.GITHUB.COM"], ["api.github.com."], [], [1], "api.github.com"])
        assert.match(v({ network: { ports: [443], hosts } }), /\$\.network\.hosts: /, JSON.stringify(hosts));
    assert.equal(v({ network: { ports: [443], hosts: ["api.github.com"] } }), "", "a subset");
    assert.equal(v({ network: { ports: [443] } }), "", "no hosts: every provider host, as a manifest from before the field");
    assert.match(v({ network: { ports: [443], paths: ["/"] } }), /\$\.network: \{ports, hosts\?\}/);
    assert.match(v({ credential: undefined }), /\$\.network: only beside a credential/);
});

test("a script's options parse from argv[2], and a flag at argv[1] is not the script", () => {
    const m = { program: "node", entrypoint: { path: "scripts/tool.mjs", sha256: "a".repeat(64) }, command: { effects: ["read"], paths: "operands", flags: { "-n": {} } } };
    const d = describeCall(["node", "scripts/tool.mjs", "-n", "a.txt"], m);
    assert.equal(d.described, true);
    assert.deepEqual(d.pathArgs.map((p) => p.arg), [3], "argv[1] is the script, not an operand");
    assert.deepEqual(d.why, []);
    for (const argv of [["node", "-u", "scripts/tool.mjs"], ["node", "--", "scripts/tool.mjs"], ["node"]]) {
        const u = describeCall(argv, m);
        assert.equal(u.effects, "unknown", argv.join(" "));
        assert.match(u.why.join(), /described only as node scripts\/tool\.mjs, with no interpreter flag before it/);
    }
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

// --- a term that names the path it acts on applies to that path (window-ml #882, ruled 2026-10-21) ---

test("write-names on a path-valued flag or find primary lands on the value, not the command", () => {
    const V = { version: "1", resolve: ({ given }) => ({ kind: "fs", path: "/w/" + given }) };
    const ver = { range: ">=1", args: ["--version"], pattern: "(\\d+)" };
    const m = { program: "x", version: ver,
        command: { effects: ["read"], paths: "operands", flags: { "--rm": { value: true, valueIsPath: "write", effects: ["write-names"] } } } };
    assert.deepEqual(validateManifest(m), []);
    const d = describeCall(["x", "--rm", "f", "o"], m, V);
    assert.equal(d.described, true);
    assert.ok(!keys(d.effects).some((k) => k.startsWith("write-names:fs:/w/o")), "flag: no write-names on the command's operand");
    assert.ok(keys(d.effects).some((k) => k.startsWith("write-names:fs:/w/f:")), "flag: write-names on the value");
    const find = { program: "find", version: ver,
        command: { syntax: "find", effects: ["read"], paths: "operands", flags: {}, primaries: { "-rm-into": { args: 1, argIsPath: "write", effects: ["write-names"] } } } };
    assert.deepEqual(validateManifest(find), []);
    const f = describeCall(["find", "o", "-rm-into", "g"], find, V);
    assert.equal(f.described, true);
    assert.ok(!keys(f.effects).some((k) => k.startsWith("write-names:fs:/w/o")), "primary: no write-names on the operand");
    assert.ok(keys(f.effects).some((k) => k.startsWith("write-names:fs:/w/g:")), "primary: write-names on the value");
});

// --- the delete family: optionsFirst, dashIsPath, repoWide, pathspecs (docs/spec/PROGRAM_MANIFEST.md) ---

test("optionsFirst: an option after an operand, `--` included, is unknown; before it, or after `--`, it is not", () => {
    const m = manifests.rm;
    assert.equal(describeCall(["rm", "a", "-r"], m).described, false, "GNU: recursive; BSD: two files");
    assert.equal(describeCall(["rm", "a", "--", "-b"], m).described, false, "BSD removes a file named --");
    assert.equal(describeCall(["rm", "-r", "a"], m).recursive, true);
    assert.equal(describeCall(["rm", "--", "-r"], m).recursive, false);
    assert.equal(describeCall(["rm", "a", "-"], m).described, true, "a lone - is a file name, not an option");
});

test("dashIsPath: a lone - is claimed as a name; a command without it still reads it as stdin", () => {
    assert.deepEqual(describeCall(["rm", "-"], manifests.rm).pathArgs.map((p) => p.arg), [1]);
    assert.deepEqual(describeCall(["cat", "-"], manifests.cat).pathArgs, []);
});

test("repoWide + pathspecs: git rm / mv also claim the directory and the repository root; a `:` pathspec is unknown", () => {
    const at = (arg) => ({ kind: "fs", path: arg === "repo" ? "/repo" : arg === "cwd" ? "/repo/src" : `/repo/src/${arg}` });
    const d = describeCall(["git", "rm", "a"], git, { ...V, resolve: ({ arg, given }) => arg === "repo" || arg === "cwd" ? at(arg) : { kind: "fs", path: `/repo/src/${given}` } });
    const names = d.effects.filter((e) => e.res.names).map((e) => e.res.path).sort();
    assert.deepEqual(names, ["/repo", "/repo/src", "/repo/src/a"]);
    for (const a of [":/x", ":(glob)*.ts", ":!x"]) assert.equal(describeCall(["git", "rm", a], git, V).described, false, a);
    assert.equal(describeCall(["git", "rm", "--", ":/x"], git, V).described, false, "after -- too");
    assert.equal(describeCall(["git", "-C", "sub", "rm", "a"], git, V).described, false, "-C with operands: git resolves them against sub, the host against the cwd");
});

// --- a flag after an operand, per shipped manifest (the optionsFirst audit, 2026-11-17) ---

/** Every shipped manifest, with one call that puts a flag after an operand and what that call describes as. Without
 *  `optionsFirst` the manifest reads such an argument as a flag, which is right only where every supported platform's
 *  parser does too: `measured` says which parser, on what. A parser that reads it as a file name reads a path the host
 *  never resolved (macOS 26.7: `cat f -n`, with `-n` a symlink to `.env`, printed the secret, and main described it as
 *  reading `f` alone). */
const AFTER_OPERAND = {
    cat: { argv: ["cat", "f", "-n"], described: false },
    head: { argv: ["head", "f", "-n", "5"], described: false },
    tail: { argv: ["tail", "f", "-n", "1"], described: false },
    wc: { argv: ["wc", "f", "-l"], described: false },
    ls: { argv: ["ls", "f", "-l"], described: false },
    cp: { argv: ["cp", "a", "b", "-R"], described: false },
    mv: { argv: ["mv", "a", "b", "-f"], described: false },
    rm: { argv: ["rm", "a", "-r"], described: false },
    rmdir: { argv: ["rmdir", "a", "-v"], described: false },
    unlink: { argv: ["unlink", "a", "-v"], described: false },
    sed: { argv: ["sed", "p", "f", "-n"], described: false },
    awk: { argv: ["awk", "{print}", "f", "-F:"], described: false },
    find: { argv: ["find", ".", "-L"], described: false, measured: "find's own grammar: after the first operand -L is an expression, which the manifest does not list (macOS find: \"-L: unknown primary or operator\")" },
    rg: { argv: ["rg", "a", "f", "-n"], described: true, measured: "ripgrep 15.0.0 on macOS numbered the lines: rg parses its own argv, the same code on Linux" },
    jq: { argv: ["jq", ".", "f", "-c"], described: true, measured: "jq-1.7.1-apple printed compact output: jq's main.c reads options anywhere, the same code on Linux" },
    git: { argv: ["git", "status", "README.md", "-s"], described: true, measured: "git 2.54.0 (Apple) and 2.56.0: parse-options permutes (status -s, blame -s, ls-files -s, rm -n, mv -n, branch <name> -v) or refuses (diff, log: \"must come before non-option arguments\"), never a path; git's own parser, the same on Linux" },
    gh: { argv: ["gh", "pr", "view", "12", "--comments"], described: true, measured: "gh 2.103.0: pflag intersperses flags (gh config get git_protocol --host github.com read --host); gh's own parser, the same on Linux" },
};

test("every shipped manifest says what a flag after an operand is (enumerate, do not sample)", () => {
    assert.deepEqual(Object.keys(AFTER_OPERAND).sort(), Object.keys(manifests).sort());
    for (const [name, row] of Object.entries(AFTER_OPERAND)) {
        const d = describeCall(row.argv, manifests[name], { version: fixtures[name].version });
        assert.equal(d.described, row.described, `${row.argv.join(" ")}: ${d.why.join("; ")}`);
    }
});

test("a command without optionsFirst names the measured parser that permutes on every supported platform", () => {
    for (const [name, m] of Object.entries(manifests)) {
        const loose = commands(m.command).filter(([, c]) => !c.optionsFirst && c.syntax !== "find" && !c.subcommands);
        if (loose.length) assert.equal(typeof AFTER_OPERAND[name].measured, "string", `${name}: ${loose.map(([at]) => [name, ...at].join(" ")).join(", ")} lack optionsFirst; set it, or measure the parser`);
    }
});

test("upgrade: main's cat, head, tail, wc and ls described a flag after an operand, and head, tail, wc and ls a lone - as stdin; the shipped ones do not, and an old stored copy is never read", async () => {
    const OLD = new URL("./fixtures/manifests-before-options-first/", import.meta.url);
    const { validStored } = await import("../src/shell/stored-manifests.ts");
    const { SHIPPED_MANIFESTS, manifestsFor, manifestFor } = await import("../src/shell/sh-call.ts");
    for (const name of ["cat", "head", "tail", "wc", "ls"]) {
        const old = JSON.parse(fs.readFileSync(new URL(`${name}.json`, OLD), "utf8"));
        const { argv } = AFTER_OPERAND[name];
        const was = describeCall(argv, old);
        assert.equal(was.described, true, `${name}: the fixture is the defect, a described call`);
        assert.deepEqual(was.pathArgs.map((p) => p.arg), [1], `${name}: main resolved only the first operand`);
        assert.equal(describeCall(argv, manifests[name]).described, false, name);
        const strip = (m) => ({ ...m, command: { ...m.command, optionsFirst: undefined, dashIsPath: undefined } });
        assert.deepEqual(strip(manifests[name]), strip(old), `${name}: optionsFirst and dashIsPath are the only changes`);
        // A lone `-` is a FILE for macOS head, tail, wc and ls (e3, #1951): main claimed no path for it; now it is one.
        if (name !== "cat") {
            assert.deepEqual(describeCall([name, "f", "-"], old).pathArgs.map((p) => p.arg), [1], `${name}: main left the file named - unresolved`);
            assert.deepEqual(describeCall([name, "f", "-"], manifests[name]).pathArgs.map((p) => p.arg), [1, 2], `${name}: - is resolved as a path`);
        }
        // A copy of the old file stored as the person's own manifest: dropped at load (B2), and passed over at call time.
        const entry = { id: `man-${name}`, scope: "global", manifest: old, origin: "person", created: 1, pin: { path: `/bin/${name}`, fingerprint: "1:2:3:4", inRoot: false } };
        assert.equal(validStored(entry, "global", SHIPPED_MANIFESTS), false, `${name}: a stored copy of a shipped program is dropped`);
        assert.equal(manifestFor(argv, undefined, manifestsFor([entry], ["/w"]).list), SHIPPED_MANIFESTS[name], `${name}: the call is described by the shipped file`);
    }
});

// --- the host holds the same bytes (window-ml #882, window-ml-host #19) ---

/** The pin both repos hold: sha256 of the lines "<sha256 hex of the raw bytes>  <name>\n", over every .json of the fixtures
 *  ("calls/<p>.json") and the manifests ("manifests/<p>.json"), names sorted bytewise. The host's copy under
 *  `vectors/program-manifests/` records it in `PIN`. */
const VECTOR_PIN = "a09ef075ba3ef647db8dff2924b71de18ca0d59f1c8028b7fd1f3c1c5627ec3d";

test("the manifests and call fixtures hash to the pin the host holds", () => {
    const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
    const named = [["calls", FIXTURES], ["manifests", MANIFESTS], ["scanners", new URL("./fixtures/sed-scanners/", import.meta.url)]].flatMap(([dir, url]) =>
        fs.readdirSync(url).filter((f) => f.endsWith(".json")).map((f) => [`${dir}/${f}`, fs.readFileSync(new URL(f, url))]));
    named.sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    const pin = sha(named.map(([n, bytes]) => `${sha(bytes)}  ${n}\n`).join(""));
    assert.equal(pin, VECTOR_PIN, "the manifests, call fixtures or scanner vectors changed: re-copy them to window-ml-host's vectors/program-manifests/ and update VECTOR_PIN here and PIN there together");
});

// --- the editor's warning: a script whose manifest lacks runs-code (SHELL.md, the TRAP paragraph) ---

test("scriptLacksRunsCode: only an entrypoint script whose default command lacks runs-code is flagged", () => {
    const ep = { path: "scripts/t.sh", sha256: "a".repeat(64) };
    const cmd = (effects) => ({ effects, paths: "operands", flags: {} });
    const ANYV = { range: "*", args: [], pattern: "" };
    const rows = [
        ["script, read only", { program: "bash", entrypoint: ep, command: cmd(["read"]) }, true],
        ["script, no effects", { program: "bash", entrypoint: ep, command: cmd([]) }, true],
        ["script, read + write", { program: "python3", entrypoint: ep, command: cmd(["read", "write"]) }, true],
        ["script with runs-code", { program: "bash", entrypoint: ep, command: cmd(["read", "runs-code"]) }, false],
        ["script with unknown (no envelope is sent)", { program: "bash", entrypoint: ep, command: cmd(["unknown"]) }, false],
        ["binary, read only", { program: "mytool", version: ANYV, command: cmd(["read"]) }, false],
        ["an interpreter binary without an entrypoint", { program: "bash", version: ANYV, command: cmd(["read"]) }, false],
        ["a binary with runs-code", { program: "env", version: ANYV, command: cmd(["runs-code"]) }, false],
    ];
    for (const [name, m, want] of rows) assert.equal(scriptLacksRunsCode(m), want, name);
    for (const [name, m] of Object.entries(manifests)) assert.equal(scriptLacksRunsCode(m), false, `shipped ${name}`);
});

test("scriptLacksRunsCode reads the default command only: a subcommand with runs-code is still flagged, and a call reaching it is exec(process)", () => {
    const ep = { path: "scripts/t.sh", sha256: "a".repeat(64) };
    const m = { program: "bash", entrypoint: ep, command: { effects: ["read"], paths: "operands", flags: {}, subcommands: { build: { effects: ["read", "runs-code"], paths: "operands", flags: {} } } } };
    assert.equal(scriptLacksRunsCode(m), true);
    assert.match(SCRIPT_RUNS_CODE_WARNING, /default command lacks runs-code: under it,/);
    const sub = describeCall(["bash", "scripts/t.sh", "build"], m);
    assert.deepEqual(sub.subcommand, ["build"]);
    assert.ok(sub.effects !== "unknown" && sub.effects.some((e) => e.op === "exec" && e.res.kind === "process"), JSON.stringify(sub.effects));
    const top = describeCall(["bash", "scripts/t.sh"], m);
    assert.ok(top.effects !== "unknown" && !top.effects.some((e) => e.op === "exec"), JSON.stringify(top.effects));
});

// --- flavours: which implementation runs, and what each adds (PROGRAM_MANIFEST.md "Flavours", ruled 2026-11-17) ---

const { flavourOf, SYSTEM_PROGRAM_DIRS } = await import("../src/shell/program-manifest.ts");

/** A flavoured program: GNU permutes and hardens with --sandbox; BSD stops at the first operand and has its own -l. */
const FLAVOURED = {
    program: "tool", version: { range: "*", args: [], pattern: "" },
    flavours: { gnu: { probe: { args: ["--version"], pattern: "^tool \\(GNU tool\\) (\\d+\\.\\d+)", range: ">=4.3 <5" } }, bsd: { system: "macos" } },
    command: {
        effects: ["read"], paths: "operands", terminator: "--", clusters: true, flags: { "-n": {} },
        flavour: { gnu: { flags: { "--quiet": {}, "--sandbox": {} }, argOrder: "permute", harden: ["--sandbox"] }, bsd: { flags: { "-l": {} }, argOrder: "stop" } },
    },
};

test("the flavoured fixture validates", () => {
    assert.deepEqual(validateManifest(FLAVOURED), []);
});

test("flavourOf: in-root never, another file name is other, the macOS system program is bsd, a GNU probe in range is gnu, else undetected", () => {
    const at = (path, inRoot = false) => ({ path, inRoot });
    const rows = [
        // [program, platform, probed, flavour, probe wanted]
        [at("/w/proj/bin/tool", true), "macos", undefined, null, false],
        [at("/w/proj/bin/tool", true), "linux", "4.9", null, false],
        [at("/usr/bin/busybox"), "linux", undefined, "other", false],
        [at("/opt/homebrew/Cellar/gnu-tool/4.9/bin/gtool"), "macos", "4.9", "other", false],
        ...SYSTEM_PROGRAM_DIRS.macos.map((d) => [at(`${d}/tool`), "macos", undefined, "bsd", false]),
        [at("/usr/bin/tool"), "linux", undefined, null, true],
        [at("/usr/local/bin/tool"), "macos", undefined, null, true],
        [at("/usr/bin/tool"), "linux", "4.9", "gnu", false],
        [at("/usr/bin/tool"), "linux", "4.2", null, false],
        [at("/usr/bin/tool"), "linux", "5.0", null, false],
        [at("/usr/bin/tool"), "linux", null, null, false],
        [at("/usr/bin/tool"), undefined, undefined, null, true],
    ];
    for (const [program, platform, probed, flavour, probe] of rows) {
        const r = flavourOf(FLAVOURED, program, platform, probed, true);
        assert.deepEqual([r.flavour, r.probe], [flavour, probe], `${program.path} on ${platform}, probed ${probed}`);
        assert.equal(typeof r.how, "string");
        // The same facts for a stored manifest: what its author does not choose decides alike, and the probe never.
        const stored = flavourOf(FLAVOURED, program, platform, probed, false);
        assert.deepEqual([stored.flavour, stored.probe], [flavour === "gnu" ? null : flavour, false], `stored: ${program.path} on ${platform}, probed ${probed}`);
    }
    // The system rule needs the bsd flavour declared, and a manifest without flavours is never flavoured.
    const gnuOnly = { ...FLAVOURED, flavours: { gnu: FLAVOURED.flavours.gnu } };
    assert.deepEqual(flavourOf(gnuOnly, at("/usr/bin/tool"), "macos", undefined, true).probe, true);
    assert.equal(flavourOf(gnuOnly, at("/usr/bin/tool"), "macos", undefined, true).flavour, null);
    assert.deepEqual(flavourOf(manifests.cat, at("/bin/cat"), "macos", undefined, true), { flavour: null, how: "the manifest declares no flavours", probe: false });
});

test("a stored manifest's gnu flavour is never detected: its probe's output is the author's, and no filter on it holds", () => {
    // The author chose the probe's arguments and the program, so the output says what the author wants. A filter
    // dropping lines that contain an argument is not enough: printf prints the matching line from octal escapes.
    const printf = { ...FLAVOURED, flavours: { gnu: { probe: { args: ["\\164ool (GNU tool) 4.9\\n"], pattern: "^tool \\(GNU tool\\) (\\d+\\.\\d+)", range: ">=4.3 <5" } } } };
    const printed = execFileSync("printf", printf.flavours.gnu.probe.args, { encoding: "utf8" });
    assert.match(printed, new RegExp(printf.flavours.gnu.probe.pattern, "m"), "printf did not print the GNU line");
    assert.ok(!printf.flavours.gnu.probe.args.some((a) => printed.includes(a)), "the printed line contains an argument, so it does not show the bypass");
    const r = flavourOf(printf, { path: "/usr/bin/tool", inRoot: false }, "linux", "4.9", false);
    assert.deepEqual([r.flavour, r.probe], [null, false]);
    assert.match(r.how, /never run/);
});

test("a detected flavour reads the core and its own overlay; undetected reads the core with optionsFirst; other describes nothing", () => {
    const rows = [
        // [argv, flavour, described, pathArgs]
        [["tool", "-n", "f"], "gnu", true, [2]],
        [["tool", "f", "--quiet"], "gnu", true, [1]],
        [["tool", "f", "-n"], "gnu", true, [1]],
        [["tool", "-l", "f"], "gnu", false, null],
        [["tool", "-n", "f"], "bsd", true, [2]],
        [["tool", "-l", "f"], "bsd", true, [2]],
        [["tool", "--quiet", "f"], "bsd", false, null],
        // BSD stops at the first operand: what follows is a file name, `--` and `-n` included.
        [["tool", "f", "-n"], "bsd", true, [1, 2]],
        [["tool", "f", "--", "-x"], "bsd", true, [1, 2, 3]],
        [["tool", "-n", "f"], null, true, [2]],
        [["tool", "f", "-n"], null, false, null],
        [["tool", "--quiet", "f"], null, false, null],
        [["tool", "-l", "f"], null, false, null],
        [["tool", "-n", "f"], undefined, true, [2]],
        [["tool", "f", "-n"], undefined, false, null],
        [["tool", "-n", "f"], "other", false, null],
        [["tool", "f"], "other", false, null],
    ];
    for (const [argv, flavour, described, pathArgs] of rows) {
        const d = describeCall(argv, FLAVOURED, flavour === undefined ? {} : { flavour });
        assert.equal(d.described, described, `${argv.join(" ")} as ${flavour}: ${d.why.join("; ")}`);
        if (pathArgs) assert.deepEqual(d.pathArgs.map((p) => p.arg), pathArgs, `${argv.join(" ")} as ${flavour}`);
        if (flavour === "other") assert.match(d.why.join("; "), /an implementation its manifest does not describe/);
    }
});

test("under stop, an argument after an operand that spells a declared flag doing more than a read asks, in every spelling", () => {
    // The manifest says the program reads it as a file name; if the argument order is misread, the write is dropped
    // (red-team, #1963). Both describers apply this: window-ml-host's manifest.rs agrees on `tool f.txt --write-all`.
    const stop = {
        program: "tool", version: { range: "*", args: [], pattern: "" }, flavours: { bsd: { system: "macos" } },
        command: { effects: ["read"], paths: "operands", clusters: true, terminator: "--", flags: { "-n": {}, "--write-all": { effects: ["write"] }, "-w": { effects: ["write"] },
            "--out": { value: true, valueIsPath: "write" }, "-R": { recursive: true }, "--exec": { runner: true, effects: ["runs-code"] }, "--grep": { value: true, effects: ["read"] } },
            flavour: { bsd: { argOrder: "stop", flags: { "--rm": { effects: ["write-names"] } } } } },
    };
    assert.deepEqual(validateManifest(stop), []);
    for (const tail of [["--write-all"], ["--write-all=x"], ["-w"], ["-nw"], ["--out", "o"], ["--out=o"], ["-R"], ["--exec"], ["--rm"], ["--", "--write-all"], ["g", "-w"], ["-xw"]]) {
        const argv = ["tool", "f.txt", ...tail];
        const d = describeCall(argv, stop, { flavour: "bsd" });
        assert.equal(d.described, false, `${argv.join(" ")} was described under stop: ${JSON.stringify(d.pathArgs)}`);
        assert.ok(d.why.some((w) => /does more than read/.test(w)), `${argv.join(" ")}: ${JSON.stringify(d.why)}`);
    }
    // A read-only flag, or an argument no flag spells, stays a file name under stop.
    for (const tail of [["-n"], ["--grep"], ["--nope"], ["-x"]]) {
        const argv = ["tool", "f.txt", ...tail];
        const d = describeCall(argv, stop, { flavour: "bsd" });
        assert.equal(d.described, true, `${argv.join(" ")}: ${JSON.stringify(d.why)}`);
        assert.deepEqual(d.pathArgs.map((p) => argv[p.arg]), ["f.txt", tail[0]]);
    }
    // Before the first operand the flag is a flag, as ever; after a `--` the command honours, given BEFORE any operand,
    // every implementation reads an operand, so it stays one. After an operand, `--` is itself a file name under stop.
    assert.equal(describeCall(["tool", "-w", "f.txt"], stop, { flavour: "bsd" }).described, true);
    const t = describeCall(["tool", "--", "f.txt", "--write-all"], stop, { flavour: "bsd" });
    assert.equal(t.described, true, JSON.stringify(t.why));
    assert.deepEqual(t.pathArgs.map((p) => p.arg), [2, 3]);
});

test("a flavour's hardening is added after the core's, only for that flavour", () => {
    const hardened = (flavour) => hardenArgv(["tool", "f"], describeCall(["tool", "f"], FLAVOURED, { flavour }));
    assert.deepEqual(hardened("gnu"), ["tool", "--sandbox", "f"]);
    for (const f of ["bsd", null, "other"]) assert.deepEqual(hardened(f), ["tool", "f"], String(f));
    assert.equal(describeCall(["tool", "--sandbox", "f"], FLAVOURED, { flavour: "gnu" }).described, true, "the hardened argv describes as the original");
});

test("upgrade: a manifest without flavours describes every fixture call identically whatever the flavour says", () => {
    // The 15 shipped manifests declare no flavours; each vector under each detection state is today's description.
    for (const [name, fx] of Object.entries(fixtures)) {
        assert.equal(manifests[name].flavours, undefined, `${name} ships unflavoured in this change`);
        for (const c of fx.calls) {
            const today = describeCall(c.argv, manifests[name], { version: fx.version });
            for (const flavour of ["gnu", "bsd", "other", null]) assert.deepEqual(describeCall(c.argv, manifests[name], { version: fx.version, flavour }), today, `${c.argv.join(" ")} as ${flavour}`);
        }
    }
});
