// sh-delete-manifests.test.mjs — what the program manifests for rm, mv, rmdir, unlink, `git rm` and `git mv` must say, written BEFORE the manifests (adversary tests, failing first). A delete or rename is a `write-names` effect on the entry it removes or renames (and, for a move, on the name it creates); a flag, an operand order or a platform difference the manifest does not model answers `unknown`, never a narrower claim. Each test states the property it guards. Run: node --import tsx --test tests/sh-delete-manifests.test.mjs
//
// Why a new file and not tests/program-manifest.test.mjs / tests/fixtures/program-calls/: those fixtures and
// src/shell/manifests/ are hashed into VECTOR_PIN (shared with window-ml-host), and "every manifest has a fixture" /
// "the first set ships" there pin the program list. This file adds no pinned fixture; the builder adds the pinned
// fixtures (rm.json, mv.json, ...) and the pin update on top of it. These vectors are the stricter ones, over shFacts.
//
// Platforms assumed (macOS BSD, GNU coreutils). On BOTH: rm -f -i -r -R -d -v, `--`; mv -f -i -n -v, `--`; rmdir -p -v,
// `--`; unlink takes one operand and no option. GNU only: rm -I --interactive --one-file-system --preserve-root
// --no-preserve-root --recursive --force --verbose --dir, mv -b -S -t -T -u -Z --backup --target-directory
// --no-target-directory --update --strip-trailing-slashes, rmdir --parents --ignore-fail-on-non-empty. BSD only: rm
// -P -W -x, mv -h. GNU permutes options and operands (`rm a -r` is recursive); BSD getopt stops at the first operand
// (`rm a -r` removes files "a" and "-r"). A flag on one platform only is "described correctly or unknown".
//
// Section 4 (redteam-e3, 2026-10-22) is the under-claim pass: a call judged free that touches more than the
// manifest claims. Its `run()` reports `containsSecret` only for a walked path, matching the real host — an earlier
// fake that always answered it hid both holes.

import { test } from "node:test";
import assert from "node:assert/strict";

const { shFacts, manifestFor } = await import("../src/shell/sh-call.ts");
const { describeCall } = await import("../src/shell/program-manifest.ts");
const { free, boundFor, effectSet } = await import("../src/effects.ts");

const GIT = "2.55.0";
const SANDBOX = boundFor("host-sandbox");
const PLAIN = boundFor("host-plain");

// --- a fake host: resolves EVERY argv index from 1 on (so a manifest cannot under-claim by the host not being asked) ---

const norm = (p) => { const out = []; for (const c of p.split("/")) { if (c === "" || c === ".") continue; if (c === "..") out.pop(); else out.push(c); } return "/" + out.join("/"); };

/** shFacts over a fake host answer. `secret`/`beneath` are resolved paths that are a secret / hold one below them.
 *  `containsSecret` is reported ONLY for a walked path, matching window-ml-host (session.rs: the host walks and
 *  answers `containsSecret` only when the pathArg carries `walk`): a fake that always answers it hides an
 *  under-claim, because the real host never asks. */
function run(argv, o = {}) {
    const cwd = o.cwd ?? "/w", roots = o.roots ?? ["/w"];
    const inRoot = (p) => roots.some((r) => p === r || p.startsWith(r + "/"));
    const m = manifestFor(argv, { cwd, roots });
    const walked = new Set(m ? describeCall(argv, m, {}).pathArgs.filter((p) => p.walk).map((p) => p.arg) : []);
    const paths = argv.map((given, arg) => ({ given, arg })).slice(1).map(({ given, arg }) => {
        const path = norm(given.startsWith("/") ? given : `${cwd}/${given}`);
        return {
            arg, given, path, inRoot: inRoot(path), secret: !!o.secret?.includes(path), exists: true,
            ...(walked.has(arg) ? { containsSecret: !!o.beneath?.includes(path) } : {}),
        };
    });
    return shFacts({
        id: "c1", argv, program: o.program ?? { path: `/bin/${argv[0].split("/").pop()}`, inRoot: false }, cwd: { path: cwd, inRoot: inRoot(cwd) },
        env: { set: [], secrets: [], free: true }, repo: o.repo === undefined ? null : o.repo, repoConfigRunsCode: null, paths,
        effects: "unknown", mode: "host", sandboxed: true, placement: o.placement ?? "host-sandbox", expiresInMs: 1,
    }, o.version ?? (argv[0] === "git" ? GIT : null), { roots });
}

/** The resolved paths a call writes by NAME (create, remove, rename), sorted; null when the call is unknown. */
const names = (f) => f.effects === "unknown" ? null : [...new Set(f.effects.filter((e) => e.op === "write" && e.res.kind === "fs" && e.res.names === true).map((e) => e.res.path))].sort();
const P = (...a) => a.sort();
const under = (q, p) => p === q || p.startsWith(q + "/");
/** Whether a names write lies on `p` or on an ancestor of it (a wider claim covers a narrower one). */
const covered = (f, p) => (names(f) ?? []).some((q) => under(q, p));
const call = (argv, o) => ({ argv, f: run(argv, o) });

// The calls the careful S4 deny policy must catch, with the paths each removes or renames (coreutils: exact).
const EXACT = [
    [["rm", "a.txt"], P("/w/a.txt")],
    [["rm", "-f", "a.txt"], P("/w/a.txt")],
    [["rm", "-i", "a.txt"], P("/w/a.txt")],
    [["rm", "-v", "a.txt", "b.txt"], P("/w/a.txt", "/w/b.txt")],
    [["rm", "-d", "dir"], P("/w/dir")],
    [["rm", "-r", "dir"], P("/w/dir")],
    [["rm", "-R", "dir"], P("/w/dir")],
    [["rm", "-rf", "dir"], P("/w/dir")],
    [["rm", "-fr", "dir"], P("/w/dir")],
    [["rm", "-r", "-f", "dir"], P("/w/dir")],
    [["rm", "src/a.ts"], P("/w/src/a.ts")],
    [["/bin/rm", "a.txt"], P("/w/a.txt")],
    [["rmdir", "d"], P("/w/d")],
    [["rmdir", "-v", "d", "e"], P("/w/d", "/w/e")],
    [["unlink", "a.txt"], P("/w/a.txt")],
    [["mv", "a", "b"], P("/w/a", "/w/b")],
    [["mv", "-f", "a", "b"], P("/w/a", "/w/b")],
    [["mv", "-n", "a", "b"], P("/w/a", "/w/b")],
    [["mv", "-i", "-v", "a", "b"], P("/w/a", "/w/b")],
    [["mv", "src/a.ts", "src/b.ts"], P("/w/src/a.ts", "/w/src/b.ts")],
    [["mv", "a", "b", "c", "dir"], P("/w/a", "/w/b", "/w/c", "/w/dir")],
];
// git: the pathspec is not a path, so a manifest may name the operand or any directory above it (the repository).
const GITS = [
    [["git", "rm", "a.txt"], ["/w/a.txt"]],
    [["git", "rm", "-f", "a.txt"], ["/w/a.txt"]],
    [["git", "rm", "-r", "dir"], ["/w/dir"]],
    [["git", "rm", "-r", "-f", "dir"], ["/w/dir"]],
    [["git", "rm", "--cached", "a.txt"], ["/w/a.txt"]],
    [["git", "rm", "-q", "--ignore-unmatch", "a.txt"], ["/w/a.txt"]],
    [["git", "mv", "a", "b"], ["/w/a", "/w/b"]],
    [["git", "mv", "-f", "a", "b"], ["/w/a", "/w/b"]],
    [["git", "mv", "-k", "a", "b"], ["/w/a", "/w/b"]],
    [["git", "mv", "a", "b", "dir"], ["/w/a", "/w/b", "/w/dir"]],
];

// --- 1. positive: each is described, a names write on exactly the right resolved path(s) (these FAIL until the manifests exist) ---

for (const [argv, want] of EXACT) test(`${argv.join(" ")}: described, write-names on exactly ${want.join(", ")}`, () => {
    // Guards: a delete or rename is a names write (not an in-place write, not unknown) on every entry it removes or creates, and on nothing else.
    const { f } = call(argv);
    assert.equal(f.described, true, f.why.join("; "));
    assert.equal(f.runner, false);
    assert.deepEqual(names(f), want);
});

for (const [argv, want] of GITS) test(`${argv.join(" ")}: described, write-names on ${want.join(", ")} or a directory above each`, () => {
    // Guards: git's operands are pathspecs, so the repository (cwd) may stand in for a path, but never a narrower place than the operand.
    const { f } = call(argv);
    assert.equal(f.described, true, f.why.join("; "));
    for (const p of want) assert.ok(covered(f, p), `${p} is covered by no write-names in ${JSON.stringify(names(f))}`);
});

test("rm -r / -R / -rf mark the operand as walked, so the host answers whether a secret lies below", () => {
    // Guards: a recursive delete removes a whole tree; only a walked operand gets `containsSecret` (describeCall recursive/walk).
    for (const argv of [["rm", "-r", "dir"], ["rm", "-R", "dir"], ["rm", "-rf", "dir"], ["rm", "-fr", "dir"]]) {
        const d = describeCall(argv, manifestFor(argv) ?? assert.fail(`no manifest for ${argv[0]}`), {});
        assert.equal(d.described, true, argv.join(" "));
        assert.equal(d.recursive, true, `${argv.join(" ")} is recursive`);
        assert.deepEqual(d.pathArgs.filter((p) => p.walk).map((p) => p.arg), [2], `${argv.join(" ")}: the operand is walked`);
    }
    const plain = describeCall(["rm", "a.txt"], manifestFor(["rm"]) ?? assert.fail("no rm manifest"), {});
    assert.equal(plain.recursive, false, "rm without -r walks nothing");
});

test("a secret below a recursively deleted directory, or a secret file removed, is never free", () => {
    // Guards: deleting a secret is a write on a secret path, which no bound covers (the sandbox included).
    assert.equal(free(run(["rm", "-r", "dir"], { beneath: ["/w/dir"] }).effects, SANDBOX), false, "dir holds a secret");
    assert.equal(free(run(["rm", "dir/.env"], { secret: ["/w/dir/.env"] }).effects, SANDBOX), false, "the file is a secret");
    assert.equal(free(run(["mv", "dir/.env", "dir/x"], { secret: ["/w/dir/.env"] }).effects, SANDBOX), false, "renaming a secret away");
});

// --- 2a. unlisted flags: unknown, never a narrower answer (pass today because unknown is today's answer) ---

for (const argv of [["rm", "--made-up", "a"], ["rm", "-Z", "a"], ["mv", "--made-up", "a", "b"], ["rmdir", "--made-up", "d"], ["unlink", "--made-up", "a"],
    ["git", "rm", "--made-up", "a"], ["git", "mv", "--made-up", "a", "b"], ["rm", "-rf", "-x-"]]) {
    test(`${argv.join(" ")}: an unlisted flag is unknown`, () => {
        // Guards: a manifest does not guess at a flag it never listed.
        const { f } = call(argv);
        assert.equal(f.described, false);
        assert.equal(f.effects, "unknown");
    });
}

// --- 2b. flags that exist on one platform: described correctly (a superset of the baseline) or unknown ---

/** Either unknown, or described with a names write on every path of `want` (a wider claim is fine), and walked when `walk`. */
function unknownOrAtLeast(argv, want, walk = false, o) {
    const f = run(argv, o);
    if (f.effects === "unknown") { assert.equal(f.described, false, argv.join(" ")); return; }
    assert.equal(f.described, true, argv.join(" "));
    for (const p of want) assert.ok(covered(f, p), `${argv.join(" ")}: ${p} is not claimed (got ${JSON.stringify(names(f))})`);
    if (walk) {
        const d = describeCall(argv, manifestFor(argv), {});
        assert.equal(d.recursive, true, `${argv.join(" ")} is recursive`);
    }
}

test("rm flags of one platform only (-I -P -W -x, GNU long options) are unknown or at least the baseline", () => {
    // Guards: -W (BSD whiteout undelete), --one-file-system, --no-preserve-root, --interactive[=WHEN] never narrow the claim.
    for (const flag of ["-I", "-P", "-W", "-x", "--interactive=never", "--interactive", "--one-file-system", "--preserve-root", "--no-preserve-root", "--preserve-root=all", "--dir", "--verbose", "--force"])
        unknownOrAtLeast(["rm", flag, "a.txt"], ["/w/a.txt"]);
    for (const flag of ["--recursive", "-Rv", "-rI"]) unknownOrAtLeast(["rm", flag, "dir"], ["/w/dir"], true);
});

test("rmdir -p removes the parents too: unknown, or not free under the sandbox", () => {
    // Guards: `rmdir -p a/b/c` removes /w/a/b and /w/a (a top-level name); a claim on c alone is narrower than the effect.
    for (const argv of [["rmdir", "-p", "src/gen/x"], ["rmdir", "--parents", "src/gen/x"], ["rmdir", "-pv", "src/gen/x"]]) {
        const f = run(argv);
        assert.equal(free(f.effects, SANDBOX), false, argv.join(" "));
        if (f.effects !== "unknown") assert.ok(covered(f, "/w/src"), `${argv.join(" ")} must claim the top-level ancestor src`);
    }
    unknownOrAtLeast(["rmdir", "--ignore-fail-on-non-empty", "d"], ["/w/d"]);
});

test("unlink with two operands, or a GNU-only option, is unknown or claims every operand", () => {
    // Guards: BSD and GNU both refuse a second operand; if the manifest describes it anyway it must not drop one.
    unknownOrAtLeast(["unlink", "a", "b"], ["/w/a", "/w/b"]);
    unknownOrAtLeast(["unlink", "--version"], []);
});

test("mv options that add or redirect a name (-t, -T, -b, -S, --backup, --target-directory) are unknown or claim every name they touch", () => {
    // Guards: GNU `mv -t dir a b` creates dir/a and dir/b (dir is an option VALUE, not the last operand); -b writes b~ next to b.
    unknownOrAtLeast(["mv", "-t", "dir", "a", "b"], ["/w/dir", "/w/a", "/w/b"]);
    unknownOrAtLeast(["mv", "--target-directory=dir", "a", "b"], ["/w/dir", "/w/a", "/w/b"]);
    unknownOrAtLeast(["mv", "--target-directory", "dir", "a", "b"], ["/w/dir", "/w/a", "/w/b"]);
    unknownOrAtLeast(["mv", "-T", "a", "b"], ["/w/a", "/w/b"]);
    unknownOrAtLeast(["mv", "--no-target-directory", "a", "b"], ["/w/a", "/w/b"]);
    unknownOrAtLeast(["mv", "-b", "a", "b"], ["/w/a", "/w/b"]);
    unknownOrAtLeast(["mv", "--backup=numbered", "a", "b"], ["/w/a", "/w/b"]);
    unknownOrAtLeast(["mv", "-S", ".orig", "-b", "a", "b"], ["/w/a", "/w/b"]);
    for (const flag of ["-u", "--update", "-Z", "--strip-trailing-slashes", "-h"]) unknownOrAtLeast(["mv", flag, "a", "b"], ["/w/a", "/w/b"]);
});

test("a top-level backup name (mv -b a top, written as top~) is not free under the sandbox", () => {
    // Guards: whatever the manifest says of -b, the created name next to a top-level destination is a top-level name.
    assert.equal(free(run(["mv", "-b", "src/a", "top"]).effects, SANDBOX), false);
});

// --- 2c. `--` and operands that look like options ---

test("after `--` an operand starting with - is a FILE: rm -- -rf removes the file -rf, not recursively", () => {
    // Guards: a manifest that reads `-rf` after `--` as flags would claim nothing (or a walk) instead of a names write on /w/-rf.
    for (const [argv, want] of [
        [["rm", "--", "-rf"], P("/w/-rf")],
        [["rm", "-f", "--", "-rf"], P("/w/-rf")],
        [["rm", "-f", "--", "-r", "-f", "x"], P("/w/-r", "/w/-f", "/w/x")],
        [["rm", "--", "--made-up"], P("/w/--made-up")],
        [["mv", "--", "-a", "-b"], P("/w/-a", "/w/-b")],
        [["mv", "-f", "--", "-a", "b"], P("/w/-a", "/w/b")],
        [["rmdir", "--", "-d"], P("/w/-d")],
        [["unlink", "--", "-x"], P("/w/-x")],
    ]) {
        const { f } = call(argv);
        assert.equal(f.described, true, `${argv.join(" ")}: ${f.why.join("; ")}`);
        assert.deepEqual(names(f), want, argv.join(" "));
    }
    // After an OPERAND, BSD rm reads `--` as a file name too (`rm a -- -b` removes a, -- and -b on macOS, checked
    // 2026-10-22), GNU does not: exactly {a, -b} would under-claim on BSD, so the call is undescribed.
    assert.equal(call(["rm", "a", "--", "-b"]).f.described, false, "rm a -- -b: GNU and BSD disagree");
    const d = describeCall(["rm", "--", "-rf"], manifestFor(["rm"]) ?? assert.fail("no rm manifest"), {});
    assert.equal(d.recursive, false, "-rf after -- is not -r");
    assert.equal(d.terminator, "--", "the host puts `--` before a computed operand");
    for (const prog of ["mv", "rmdir", "unlink"]) assert.equal(describeCall([prog, "--", "x", "y"], manifestFor([prog]) ?? assert.fail(`no ${prog} manifest`), {}).terminator, "--", prog);
});

test("git rm / git mv after `--`: a dash-leading pathspec is a path", () => {
    // Guards: `git rm -- -x` removes the path -x; the claim covers /w/-x.
    for (const [argv, want] of [[["git", "rm", "--", "-x"], ["/w/-x"]], [["git", "mv", "--", "-a", "-b"], ["/w/-a", "/w/-b"]]]) {
        const { f } = call(argv);
        assert.equal(f.described, true, f.why.join("; "));
        for (const p of want) assert.ok(covered(f, p), `${argv.join(" ")}: ${p}`);
    }
});

test("an operand starting with - and no `--` is an (unlisted) option: unknown", () => {
    // Guards: `rm -rf -x` / `mv -a -b` are option parses, not file names; an unlisted flag stays unknown.
    for (const argv of [["rm", "-rf", "-x-"], ["rm", "-x-"], ["mv", "-a-", "b"], ["rmdir", "-d-"], ["git", "rm", "-x-"]]) assert.equal(run(argv).effects, "unknown", argv.join(" "));
});

test("an option AFTER an operand: GNU reads it as an option, BSD as a file name; the claim covers both or is unknown", () => {
    // Guards: `rm a -r` is a recursive delete of a (GNU) or a delete of files a and -r (BSD); `mv a b -f` moves a, b into a dir named -f (BSD).
    unknownOrAtLeast(["rm", "a", "-r"], ["/w/a", "/w/-r"], true);
    unknownOrAtLeast(["rm", "a", "-f"], ["/w/a", "/w/-f"]);
    unknownOrAtLeast(["mv", "a", "b", "-f"], ["/w/a", "/w/b", "/w/-f"]);
    unknownOrAtLeast(["rmdir", "d", "-p"], ["/w/d", "/w/-p"]);
});

// --- 2d. moving INTO a directory; sources and destination ---

test("mv a dir/ and mv a b dir: the destination operand is named too (the created name is under it)", () => {
    // Guards: `mv a existing-dir/` creates existing-dir/a; the manifest cannot know the dir exists, so the destination operand is claimed (narrow way: names on the operand itself).
    for (const [argv, want] of [
        [["mv", "a", "existing-dir/"], P("/w/a", "/w/existing-dir")],
        [["mv", "src/a", "src/b/"], P("/w/src/a", "/w/src/b")],
        [["mv", "a", "b", "dir/"], P("/w/a", "/w/b", "/w/dir")],
        [["mv", "a", "."], P("/w", "/w/a")],
    ]) {
        const { f } = call(argv);
        assert.equal(f.described, true, f.why.join("; "));
        assert.deepEqual(names(f), want, argv.join(" "));
    }
});

test("mv from a top-level name, or to one, asks even when the other end is nested (the sandbox bound excludes top-level names)", () => {
    // Guards: both ends of a move are checked separately; one top-level end is enough to ask.
    assert.equal(free(run(["mv", ".envrc", "src/x"]).effects, SANDBOX), false, "removes a top-level name");
    assert.equal(free(run(["mv", "src/x", ".envrc"]).effects, SANDBOX), false, "creates a top-level name");
    assert.equal(free(run(["mv", "src/x", "/outside/y"]).effects, SANDBOX), false, "destination outside the roots");
    assert.equal(free(run(["mv", "/outside/y", "src/x"]).effects, SANDBOX), false, "source outside the roots");
});

// --- 2e. roots, top-level names and outside the roots: the default policy and EFFECTS.md's top-level rule must refuse ---

test("rm -rf of a root itself: the names write is marked isRoot and is not free under any bound", () => {
    // Guards: removing a root removes every top-level name in it (EFFECTS.md, "The top-level names of a root are outside B").
    const f = run(["rm", "-rf", "/w/proj"], { roots: ["/w/proj"], cwd: "/w/proj" });
    assert.equal(f.described, true, f.why.join("; "));
    assert.deepEqual(names(f), ["/w/proj"]);
    assert.equal(f.effects.find((e) => e.res.names).res.isRoot, true);
    assert.equal(free(f.effects, SANDBOX), false);
    for (const argv of [["rm", "-r", "."], ["rm", "-rf", "./"], ["rm", "-r", "/w"], ["rmdir", "."], ["mv", ".", "x"]]) {
        const g = run(argv);
        assert.equal(free(g.effects, SANDBOX), false, `${argv.join(" ")} removes or renames the root`);
    }
});

test("rm of a top-level entry is not free under the sandbox; a path outside the roots is covered by no bound", () => {
    // Guards: the top-level rule reaches rm/rmdir/unlink/mv exactly as it reaches find -delete.
    for (const argv of [["rm", "src"], ["rm", "-rf", "src"], ["rm", ".envrc"], ["rmdir", "src"], ["unlink", ".mcp.json"], ["mv", "src", "lib"], ["mv", "src/a", "top"], ["rm", "-rf", ".vscode"]]) {
        const f = run(argv);
        assert.equal(f.described, true, `${argv.join(" ")}: ${f.why.join("; ")}`);
        assert.equal(free(f.effects, SANDBOX), false, `${argv.join(" ")} removes a top-level name`);
    }
    for (const argv of [["rm", "../x"], ["rm", "-rf", "/etc/x"], ["rm", "/"], ["rm", "-rf", "src/../../x"], ["unlink", "../x"], ["rmdir", "/tmp/d"], ["mv", "a", "../b"]]) {
        const f = run(argv);
        assert.equal(f.described, true, `${argv.join(" ")}: ${f.why.join("; ")}`);
        const out = f.effects.filter((e) => e.res.names && e.res.inRoot === false);
        assert.ok(out.length > 0, `${argv.join(" ")}: a names write with inRoot false`);
        assert.equal(free(f.effects, SANDBOX), false, `${argv.join(" ")} is outside the roots`);
    }
});

test("git rm / git mv of a root, or of an operand outside the roots, are not free under the sandbox", () => {
    // Guards: the repository operand `.` is the root; `..` leaves it.
    for (const argv of [["git", "rm", "-r", "."], ["git", "rm", "-r", "src"], ["git", "mv", "src", "lib"], ["git", "rm", "../x"]]) assert.equal(free(run(argv).effects, SANDBOX), false, argv.join(" "));
    assert.equal(free(run(["git", "rm", "-r", "."], { cwd: "/w/src" }).effects, SANDBOX), false, "from a subdirectory . is a top-level entry");
});

test("git rm removes emptied parent directories, so a nested git rm may remove a top-level name: unknown or not free under the sandbox", () => {
    // Guards: `git rm src/only.ts` deletes src/ when it becomes empty. NARROW reading chosen (see report): it asks.
    for (const argv of [["git", "rm", "src/gen/only.ts"], ["git", "rm", "-f", "src/only.ts"]]) assert.equal(free(run(argv).effects, SANDBOX), false, argv.join(" "));
});

test("git rm with pathspecs that are not one path (glob, magic, a list from a file or stdin, `:/` from a subdirectory) is unknown or covers what they can reach", () => {
    // Guards: a glob matches many files, --pathspec-from-file reads the operands from a file/stdin, `:/x` is relative to the repository root, `..` leaves the cwd.
    const sub = { cwd: "/w/src" };
    const atLeast = (argv, want, o = sub) => unknownOrAtLeast(argv, want, false, o);
    atLeast(["git", "rm", "*.ts"], ["/w/src"]);
    atLeast(["git", "rm", "gen/*.ts"], ["/w/src/gen"]);
    atLeast(["git", "rm", ":(glob)**/*.ts"], ["/w/src"]);
    atLeast(["git", "rm", ":/foo"], ["/w"]);
    atLeast(["git", "rm", ":/"], ["/w"]);
    atLeast(["git", "rm", "--pathspec-from-file=list.txt"], ["/w"]);
    atLeast(["git", "rm", "--pathspec-from-file=-"], ["/w"]);
    atLeast(["git", "rm", "--pathspec-from-file=list.txt", "--pathspec-file-nul"], ["/w"]);
    atLeast(["git", "rm", "../a.txt"], ["/w/a.txt"]);
    atLeast(["git", "mv", "*.ts", "dir"], ["/w/src", "/w/src/dir"]);
});

test("git -C sub rm a.txt names the file in sub, not in the cwd", () => {
    // Guards: -C moves the repository; the pathspec is relative to it. A claim on /w/a.txt would be the wrong file.
    const f = run(["git", "-C", "sub", "rm", "a.txt"]);
    if (f.effects === "unknown") return;
    assert.ok(covered(f, "/w/sub/a.txt"), JSON.stringify(names(f)));
});

test("git rm / git mv with a flag that runs another program or an option before the subcommand that does, is unknown", () => {
    // Guards: -c core.hooksPath / core.fsmonitor and --exec-path run code; git.json already marks -c unknown, rm/mv must not bypass it.
    for (const argv of [["git", "-c", "core.fsmonitor=x", "rm", "a"], ["git", "-c", "core.hooksPath=h", "mv", "a", "b"]]) {
        const f = run(argv);
        assert.equal(f.effects, "unknown", argv.join(" "));
    }
});

// --- 2f. programs that run others, and programs of the same name that are not ours ---

test("xargs/env/sudo/nice/command rm: not described (the program is another one)", () => {
    // Guards: a wrapper does not borrow rm's description; `xargs rm` reads its operands from stdin.
    for (const argv of [["xargs", "rm"], ["xargs", "-0", "rm", "-f"], ["env", "rm", "a"], ["sudo", "rm", "a"], ["nice", "rm", "a"], ["command", "rm", "a"]]) {
        const f = run(argv);
        assert.equal(f.described, false, argv.join(" "));
        assert.equal(f.effects, "unknown", argv.join(" "));
    }
    const exec = run(["find", ".", "-exec", "rm", "{}", ";"]);
    assert.equal(exec.runner, true, "find -exec rm is a runner (control: find's own manifest, unchanged by this change)");
});

test("a program named rm that lives inside a workspace root is not the system rm: not described, or not free", () => {
    // Guards: `./rm a.txt` where ./rm is a script the model wrote is matched by basename; the description of rm must not run an arbitrary script as a nested names write.
    // (A cat/ls manifest has the same exposure today; if this needs a change in shFacts, not in a manifest, see the report.)
    const f = run(["./rm", "a.txt"], { program: { path: "/w/rm", inRoot: true } });
    assert.ok(f.described === false || f.effects === "unknown" || free(f.effects, PLAIN) === false);
    assert.equal(f.described, false, "an in-root program is not described by a binary's manifest");
});

// --- 3. through shFacts: the careful S4 deny policy, and the built-in default ---

/** The careful S4 deny policy, as a person writes it over the effect set (EFFECTS.md): any write by name to an fs entry. */
const s4 = (f) => effectSet(f.effects).writes.some((r) => r.kind === "fs" && r.names === true);

test("the S4 deny policy matches every delete and rename above, and not cat, ls or git status", () => {
    // Guards: with manifests a names-write DENY fires on rm/mv/rmdir/unlink/git rm/git mv; without it (unknown) it misses (and the person is asked).
    for (const [argv] of [...EXACT, ...GITS]) assert.equal(s4(run(argv)), true, argv.join(" "));
    for (const argv of [["cat", "a.txt"], ["ls", "src"], ["git", "status"], ["git", "diff"], ["find", "src", "-name", "*.ts"], ["wc", "-l", "a.txt"]]) {
        const f = run(argv);
        assert.equal(f.described, true, `${argv.join(" ")} (control): ${f.why.join("; ")}`);
        assert.equal(s4(f), false, `${argv.join(" ")} is not a delete`);
    }
});

test("the built-in default policy never frees a delete or rename on the plain host (no bound), unknown or described", () => {
    // Guards: a manifest buys facts, not permission. free() is false for every rm/mv call on the plain host.
    for (const [argv] of [...EXACT, ...GITS]) assert.equal(free(run(argv, { placement: "host-plain" }).effects, PLAIN), false, argv.join(" "));
});

test("under the sandbox, no delete or rename of a top-level name, a root, a secret or a path outside the roots is free", () => {
    // Guards: the default asks wherever the sandbox's bound (roots less top-level names, no secrets) does not cover the claim.
    const asks = [
        ["rm", "src"], ["rm", "-rf", "src"], ["rm", "."], ["rm", "-r", ".."], ["rm", "../x"], ["rmdir", "src"], ["unlink", "top.txt"],
        ["mv", "a", "b"], ["mv", "src", "x/y"], ["mv", "x/y", "src"], ["git", "rm", "top.txt"], ["git", "mv", "a", "b"],
    ];
    for (const argv of asks) assert.equal(free(run(argv).effects, SANDBOX), false, argv.join(" "));
});

test("a call the manifest cannot describe stays unknown and is never free", () => {
    // Guards: fails safe; the S4 deny misses it (unknown writes are kind \"unknown\"), so the person is asked.
    for (const argv of [["rm", "--made-up", "src/gen/a.ts"], ["mv", "--made-up", "src/a", "src/b"], ["git", "rm", "--made-up", "a"]]) {
        const f = run(argv);
        assert.equal(f.effects, "unknown");
        assert.equal(free(f.effects, SANDBOX), false);
        assert.equal(s4(f), false);
    }
});

// --- 4. under-claims: a call judged free that touches more than the manifest claims (red-team-e3, 2026-10-22) ---
//
// Two shapes the adversary section above cannot see, because its fake host answered `containsSecret` for every
// path and because every git call ran with repo: null at a root (so repoWide made them all ask). The real host
// answers `containsSecret` only for a walked path (window-ml-host session.rs), and a repository can sit nested
// inside a workspace root.

test("mv of a directory that holds a secret is not free: the move renames every name beneath it", () => {
    // Guards: `mv` needs no -r to move a tree. describeCall never sets walk on its operands, so the host never
    // answers containsSecret and the secret's name is renamed under a free judgment. Ruled shape: a directory
    // operand of mv means everything beneath it (PROGRAM_MANIFEST.md, `recursive`), so the host must check it.
    // Every path below is nested (parent is not a root), so the only reason to ask is the secret.
    // Positive control first: the harness frees a plain nested move and refuses the secret when it is spelled out.
    assert.equal(free(run(["mv", "src/a", "src/b"], { cwd: "/w/a" }).effects, SANDBOX), true, "plain nested move is free (control)");
    assert.equal(free(run(["mv", "src/keep/.env", "src/keep/x"], { cwd: "/w/a", secret: ["/w/a/src/keep/.env"] }).effects, SANDBOX), false, "the secret file itself (control)");
    assert.equal(free(run(["rm", "-r", "src/keep"], { cwd: "/w/a", beneath: ["/w/a/src/keep"] }).effects, SANDBOX), false, "rm -r walks, so the host reports containsSecret (control)");
    // The hole: the same directory, moved whole. The host is not asked, so the claim is silent about the secret.
    assert.equal(free(run(["mv", "src/keep", "src/keep2"], { cwd: "/w/a", beneath: ["/w/a/src/keep"] }).effects, SANDBOX), false,
        "mv src/keep src/keep2 renames src/keep/.env with it");
    assert.equal(free(run(["mv", "src/keep", "src/"], { cwd: "/w/a", beneath: ["/w/a/src/keep"] }).effects, SANDBOX), false,
        "mv src/keep src/ moves the tree under src/");
});

test("git mv of a directory that holds a secret is not free: same move, same walk gap", () => {
    // Guards: git mv has no recursive flag either; a directory operand moves everything beneath it.
    // Repo at /w/a/b (nested: parent /w/a is not a root), so repoWide's claim does not already make it ask.
    const repo = { root: "/w/a/b", reasons: ["git"] };
    const o = { cwd: "/w/a/b", repo, roots: ["/w"], beneath: ["/w/a/b/keep"] };
    assert.equal(free(run(["git", "mv", "keep", "src/keep2"], o).effects, SANDBOX), false,
        "git mv keep src/keep2 renames keep/.env with it");
});

test("git rm of a pathspec glob whose matches include a secret is not free: the literal path is not the names it removes", () => {
    // Guards: ml.sh passes argv with no shell, so git receives the glob as a pathspec. Only a :-leading pathspec is
    // magic today; `*.ts`, `**/*.ts`, `*`, `a?.ts`, `[ab].ts` stay described as ONE path whose name literally
    // contains `*`. git removes every match — a secret among them — under a claim that never named it.
    // Positive control: the same secret spelled exactly is flagged and not free. Repo nested at /w/a/b.
    const repo = { root: "/w/a/b", reasons: ["git"] };
    const base = { cwd: "/w/a/b/src", repo, roots: ["/w"], secret: ["/w/a/b/src/secret.ts"] };
    assert.equal(free(run(["git", "rm", "secret.ts"], base).effects, SANDBOX), false, "the secret file itself (control)");
    for (const spec of ["*.ts", "src/*.ts", "**/*.ts", "*", "a?.ts", "[ab].ts", "foo*bar"]) {
        const f = run(["git", "rm", spec], base);
        assert.equal(f.described, false, `${spec}: a glob is not one path, so the call is unknown`);
        assert.equal(free(f.effects, SANDBOX), false, `git rm ${spec} removes secret.ts among its matches`);
    }
});

test("describeCall marks mv's and git mv's operands as walked (the host only answers containsSecret for those)", () => {
    // Guards: the two holes above share one root: `recursive` is never set for a command whose directory operand
    // means everything beneath it. PROGRAM_MANIFEST.md's `recursive` row names exactly that property.
    for (const argv of [["mv", "keep", "src/keep2"], ["git", "mv", "keep", "src/keep2"]]) {
        const m = manifestFor(argv);
        assert.ok(m, argv.join(" "));
        const d = describeCall(argv, m, { version: argv[0] === "git" ? GIT : undefined });
        assert.equal(d.described, true, `${argv.join(" ")}: ${d.why.join("; ")}`);
        assert.ok(d.pathArgs.some((p) => p.walk), `${argv.join(" ")}: no operand is walked, so the host never checks what is beneath it`);
    }
    // Control: rm without -r walks nothing; mv must be recursive the way rm -r is, because it always moves a tree.
    assert.equal(describeCall(["rm", "a"], manifestFor(["rm"]), {}).recursive, false, "rm without -r walks nothing (control)");
    assert.equal(describeCall(["mv", "a", "b"], manifestFor(["mv"]), {}).recursive, true,
        "mv always moves a whole directory, so it is recursive like rm -r");
});
