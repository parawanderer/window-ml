// redteam-files-argv.test.mjs — `/files` in an `ml.sh` argv, from the WORKER's side (FILE_ATTACHMENTS.md H9, as built:
// "the worker refuses what cannot be placed, before `spawn` ... the worker's refusal before `spawn` is the check").
//
// The host maps only what the worker marks as a path, and refuses only what reaches it; so the worker's half is the
// placement, and a `/files` argument the worker neither places nor refuses reaches the program as a literal path. These
// rows state the placement over the MANIFESTS — every path position each shipped manifest can produce, enumerated from
// the manifests themselves — rather than over a guessed argv:
//
//   A. every `/files` argument the manifest parse places is a path argument the host will map, and a call the parse
//      does not describe is refused before `spawn`, in every position its string scan looks at (the start, the first `=`).
//   B. the positions the string scan does NOT look at are named one by one, with what happens to each: the attached
//      short value (`-f/files/x`) makes the call undescribed (the parse's own refusal: pass it as its own argument), the
//      second `=`, `argv[0]`, an env value and the cwd. None of them is silently both unrefused and mapped.
//   C. the sentence the model gets never resolves the token: `/files/../x`, `/files//x`, `/files/./attached` are handed
//      back and mapped AS WRITTEN, so H2's mount-relative rule is the host's and a worker that normalised first would
//      walk out of the mount with its blessing.
//   D. with `/files` not on the host's disk (nothing mounts it until H16, and an old host does not map), nothing is
//      refused and no `files` is sent: the token stays the browser sandbox's.
//
// MUTATION PER ROW, MEASURED AT c0014ef2 (notes, not committed changes — one applied alone, its row watched going red, the
// source reverted; the file was clean 4/4 before and after):
//   A  program-manifest.ts: the `d.pathArgs.push({ arg: valueAt.arg, … role: f.valueIsPath })` line deleted → A red:
//      "gh api --input=: a /files argument the manifest marks as a path is not one the host will map".
//   B  sh-call.ts filesPlaced: the `eq >= 0 && isFilesPath(a.slice(eq + 1))` branch dropped, so only the start is looked
//      at → B red: "python3 --out=/files/x".
//   C  sh-call.ts filesPlaced: the sentence quotes `normalPath(at)` instead of the token → C red: "python3 /files/: the
//      sentence does not quote the token as written".
//   D  sh-call.ts planSpawn: `spawn.files` sent even with no `files` in the session → D red: "python3 /files/x: a mount
//      was sent to a host with no uploads folder".
//
// WHAT THIS HEAD CANNOT ROW, and why (one line each, so the next reader does not look for them):
//   - The old-host half (`hello.filesArgv`, H15): `hostMapsFiles` exists and the lane's row pins it, but nothing wires a
//     session's `files` yet — `runCall` passes none ("No session mounts an uploads folder yet (FILE_ATTACHMENTS.md H16)"),
//     so there is no worker path that could send `files` to an older host. Rows land with H16's wiring.
//   - An env VALUE naming `/files` (e.g. `{env: {GIT_DIR: "/files/x"}}`) is neither scanned nor mapped: the call asks (an
//     env key the manifest lists leaves it undescribed) and the value reaches the program literally, which names nothing
//     unless the host has a `/files` of its own. Not refused, so the model is not taught the retry — B pins the bucket.
//   - A path attached to a SHORT flag (`-f/files/x`, `-C/files/x`): the parse refuses to place it on purpose ("pass it as
//     its own argument") so the call is undescribed and asks; the H9 sentence does not fire there. A pins that.
//   - A repo-wide command's operand (`git status /files/x`): the operand is not one path the host resolves, so it reaches
//     git literally; the call asks until a version describes it. A pins that (`kind: "repo"`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { planSpawn, parseShRun, SHIPPED_MANIFESTS } from "../src/shell/sh-call.ts";
import { describeCall } from "../src/shell/program-manifest.ts";

const FILES = { mount: "m1", session: "s1", shown: "~/git/proj/window-ml-files" };
const SENTENCE = "/files is on disk while the host is connected: ~/git/proj/window-ml-files";
/** The plan for one argv, with `/files` on the host's disk unless `files` says otherwise. */
const plan = (argv, opts = null, files = FILES) => planSpawn(parseShRun(opts ? [argv, opts] : [argv]), { cwd: "/w", ...(files ? { files } : {}) });
/** Where `arg` went in the argv the host runs (hardening only inserts, so the string is unchanged), and whether the host
 *  will map that index. */
const placement = (p, arg) => {
    const at = p.spawn.argv.indexOf(arg);
    return { at, mapped: at >= 0 && !!p.spawn.pathArgs?.some((e) => e.arg === at) };
};
/** What became of a call carrying `arg`: the worker's refusal, the host's mapping, or a literal the program receives. */
const fate = (p, arg) => {
    if (p.filesRefusal) return "refused";
    const { mapped } = placement(p, arg);
    if (mapped) return "mapped";
    return p.description?.described === false || p.description === null ? "asks" : "literal";
};

/** Every command path of a manifest: the command itself, then each subcommand, with the names that reach it. */
function commandPaths(m) {
    const out = [];
    const walk = (cmd, names) => {
        out.push({ cmd, names, label: [m.program, ...names].join(" ") });
        for (const [sub, c] of Object.entries(cmd.subcommands ?? {})) walk(c, [...names, sub]);
    };
    walk(m.command, []);
    return out;
}

// --- A. every path position a manifest can produce ---

test("RED TEAM: every /files argument a manifest marks as a path is one the host maps, or the call is refused before spawn", () => {
    const shapes = [];
    for (const m of Object.values(SHIPPED_MANIFESTS)) {
        for (const { cmd, names, label } of commandPaths(m)) {
            // A path operand, where the command's operands ARE paths. `paths: "repo"` operands are not: the command's
            // target is the repository, and the host resolves no single path for them (H9's table, the repo row).
            if (cmd.paths === "operands" || (typeof cmd.paths === "object" && !Array.isArray(cmd.paths))) {
                // `{operandsFrom: n}`: the first n operands are not paths, so the token goes after n filler operands.
                const pad = Array.from({ length: typeof cmd.paths === "object" ? cmd.paths.operandsFrom : 0 }, (_, i) => `p${i}`);
                shapes.push({ m, label: `${label} <operand>`, kind: "path", argv: [m.program, ...names, ...pad, "/files/x"] });
            } else if (cmd.paths === "repo") {
                shapes.push({ m, label: `${label} <operand, repo>`, kind: "repo", argv: [m.program, ...names, "/files/x"] });
            }
            for (const [flag, spec] of Object.entries(cmd.flags)) {
                if (!spec.valueIsPath && !spec.valueIsDir) continue;
                const long = flag.startsWith("--");
                shapes.push({ m, label: `${label} ${flag}=`, kind: "path", argv: [m.program, ...names, `${flag}=/files/x`] });
                shapes.push({ m, label: `${label} ${flag} (separate)`, kind: "path", argv: [m.program, ...names, flag, "/files/x"] });
                if (!long) shapes.push({ m, label: `${label} ${flag}<attached>`, kind: "attached", argv: [m.program, ...names, `${flag}/files/x`] });
            }
            for (const primary of Object.keys(cmd.primaries ?? {}).filter((k) => cmd.primaries[k].argIsPath)) {
                shapes.push({ m, label: `${label} ${primary} <value>`, kind: "path", argv: [m.program, ...names, ".", primary, "/files/x"] });
            }
        }
    }
    assert.ok(shapes.length > 40, `enumerated ${shapes.length} path positions — the manifests were not walked`);
    assert.ok(shapes.some((s) => s.kind === "attached") && shapes.some((s) => s.kind === "repo"), "the walk found no attached or repo-wide position");
    for (const s of shapes) {
        const p = plan(s.argv);
        const arg = s.argv.find((a) => a.includes("/files")) ?? s.argv.at(-1);
        const { at, mapped } = placement(p, arg);
        // What the WORKER's own placement check reads: the parse with no version to check, exactly as filesPlaced does.
        const described = describeCall(p.spawn.argv, s.m.entrypoint ? s.m : { ...s.m, version: { range: "*", args: [], pattern: "" } }).described;
        // Refused: the call cannot be placed as the caller wrote it, and the model is told the real path instead.
        if (p.filesRefusal) continue;
        if (s.kind === "attached") {
            // The parse's own rule for a path attached to a short flag (program-manifest.ts): the call is not described, so
            // it asks. Never refused by the string scan — the token is at neither of the two places it looks.
            assert.equal(described, false, `${s.label}: a path attached to a short flag was described as a call`);
            assert.equal(mapped, false, `${s.label}: mapped, though the parse does not place it`);
            continue;
        }
        assert.equal(described, true, `${s.label}: neither refused nor placed by its own manifest`);
        if (s.kind === "repo") {
            assert.equal(mapped, false, `${s.label}: a repo-wide operand was sent as one path argument`);
            continue;
        }
        assert.equal(mapped, true, `${s.label}: a /files argument the manifest marks as a path is not one the host will map: ${s.argv.join(" ")} (at ${at})`);
    }
});

// --- B. the positions the string scan cannot see ---

test("RED TEAM: the start and the first = are refused for an unplaceable call, and every other spelling is accounted for", () => {
    // No manifest at all: nothing is placed, so the token is refused wherever the scan looks.
    for (const token of ["/files/x", "/files", "/files/", "/files//x", "/files/./attached", "/files/../x", "/filesystem/x"]) {
        const p = plan(["python3", token]);
        const expected = token === "/filesystem/x" ? null : SENTENCE + token.slice("/files".length);
        assert.equal(p.filesRefusal ?? null, expected, `python3 ${token}`);
    }
    for (const token of ["--out=/files/x", "-Dk=/files/x", "k=/files/x"]) {
        assert.match(plan(["python3", token]).filesRefusal ?? "", /^\/files is on disk while the host is connected: /, `python3 ${token}`);
    }
    // The named cost, and the spellings no scan sees: each accounted for, none both unrefused and mapped.
    const cost = {
        "second = (named cost)": ["python3", "--set=a=/files/x"],
        "attached short value": ["rg", "-f/files/x", "."],
        "attached directory": ["git", "-C/files/x", "status"],
        "argv[0]": ["/files/x", "a"],
    };
    for (const [label, argv] of Object.entries(cost)) {
        const p = plan(argv);
        const arg = argv.find((a) => a.startsWith("-") && a.endsWith("/files/x")) ?? argv[0];
        assert.equal(p.filesRefusal ?? null, null, `${label}: refused, though the scan does not look there`);
        assert.equal(fate(p, arg), "asks", `${label}: ${fate(p, arg)}`);
        assert.equal(placement(p, arg).mapped, false, `${label}: mapped, though the scan cannot see it`);
    }
    // An env value is not an argument: it is sent as written and the host maps only path arguments and the cwd.
    const env = plan(["git", "status"], { env: { GIT_DIR: "/files/x" } });
    assert.equal(env.filesRefusal ?? null, null, "an env value is not a /files argument");
    assert.deepEqual(env.spawn.env, { GIT_DIR: "/files/x" }, "the env value was rewritten on the way to the host");
    assert.equal(env.spawn.pathArgs ?? null, null, "an env value was turned into a path argument");
    // The cwd is mapped by the host (H9), so the worker sends it as written and never refuses it.
    for (const cwd of ["/files", "/files/attached", "/files/../x"]) {
        const p = plan(["ls"], { cwd });
        assert.equal(p.filesRefusal ?? null, null, `cwd ${cwd}: refused, though the host maps the cwd`);
        assert.equal(p.spawn.cwd, cwd, `cwd ${cwd}: rewritten by the worker`);
        assert.deepEqual(p.spawn.files, { mount: "m1", session: "s1" }, `cwd ${cwd}: no mount for the host to map it in`);
    }
});

// --- C. the token is never resolved on the way ---

test("RED TEAM: a /files argument is handed back and mapped exactly as written, so the mount-relative rule is the host's alone", () => {
    for (const tail of ["", "/", "//x", "/./attached", "/../x", "/x/"]) {
        const token = `/files${tail}`;
        const p = plan(["cat", token]);
        assert.equal(p.filesRefusal ?? null, null, `cat ${token}: refused by the worker, though the manifest places it`);
        assert.equal(p.spawn.argv[1], token, `cat ${token}: the argv was rewritten on the way to the host`);
        assert.deepEqual(placement(p, token), { at: 1, mapped: true }, `cat ${token}: not mapped`);
        // And for a program with no manifest, the sentence hands the token back as written: no normalisation.
        const u = plan(["python3", token]);
        assert.equal(u.filesRefusal, SENTENCE + tail, `python3 ${token}: the sentence does not quote the token as written`);
    }
});

// --- D. with no folder on the host, nothing is placed and nothing refused ---

test("RED TEAM: with no uploads folder on this host, no call is refused, no mount is sent, and the argv is untouched", () => {
    for (const argv of [["python3", "/files/x"], ["cat", "/files/../x"], ["cp", "-R", "/files/attached/x", "/files/"]]) {
        const p = plan(argv, null, null);
        assert.equal(p.filesRefusal ?? null, null, `${argv.join(" ")}: refused with no folder to map it to`);
        assert.equal("files" in p.spawn, false, `${argv.join(" ")}: a mount was sent to a host with no uploads folder`);
        assert.deepEqual(p.spawn.argv, argv, `${argv.join(" ")}: the argv changed`);
    }
    // And a described call still hands the host the arguments it will judge: the role is sent whatever /files is.
    const cp = plan(["cp", "/files/attached/x", "/files/y"], null, null);
    assert.deepEqual(cp.spawn.pathArgs, [{ arg: 1 }, { arg: 2, role: "write" }]);
});
