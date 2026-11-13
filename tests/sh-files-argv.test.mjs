// sh-files-argv.test.mjs — `/files` in an `ml.sh` argv while the host holds it on disk (FILE_ATTACHMENTS.md H9), from
// the worker's side: which operands a manifest says are written (`writtenOperands`), what `planSpawn` asks the host to
// map, the refusal of a `/files` argument no manifest places, and the card's line for a mapped one.

import { test } from "node:test";
import assert from "node:assert/strict";
import { describeCall, validateManifest } from "../src/shell/program-manifest.ts";
import { parseShRun, planSpawn, shFacts, shCardLines, unaskedLines, SHIPPED_MANIFESTS, filesLines } from "../src/shell/sh-call.ts";
import { hostMapsFiles } from "../src/shell/host-protocol.ts";

const S = { cwd: "/w" };
const FILES = { mount: "m1", session: "s1", shown: "~/git/proj/window-ml-files" };
const plan = (argv, files = FILES) => planSpawn(parseShRun([argv]), { ...S, ...(files ? { files } : {}) });
const cp = SHIPPED_MANIFESTS.cp;

// --- which operands are written ---

test("cp writes its last operand and reads the others; a writer with no writtenOperands writes every operand", () => {
    const roles = (argv, m) => describeCall(argv, m).pathArgs.map((p) => `${p.arg}${p.role[0]}`);
    assert.deepEqual(roles(["cp", "a", "b", "dir"], cp), ["1r", "2r", "3w"]);
    assert.deepEqual(roles(["cp", "-R", "/files/attached/3fa91c2", "/files/copy"], cp), ["2r", "3w"]);
    assert.deepEqual(roles(["mv", "a", "b"], SHIPPED_MANIFESTS.mv), ["1w", "2w"], "mv's sources are removed: written too");
    assert.deepEqual(roles(["rm", "a", "b"], SHIPPED_MANIFESTS.rm), ["1w", "2w"]);
    assert.deepEqual(roles(["cat", "a"], SHIPPED_MANIFESTS.cat), ["1r"], "a reader writes nothing");
    const writer = { ...cp, command: { ...cp.command } };
    delete writer.command.writtenOperands;
    assert.deepEqual(roles(["cp", "a", "b"], writer), ["1w", "2w"], "absent field: every operand written, so a source in attached/ is refused (fails closed)");
});

test("with writtenOperands, a write falls on the destination and a read on the sources", () => {
    const keys = describeCall(["cp", "a", "b", "dir"], cp).effects.map((e) => `${e.op}${e.res.names ? "-names" : ""}:${e.res.path}`).sort();
    assert.deepEqual(keys, ["read:a", "read:b", "write-names:dir", "write:dir"]);
});

test("writtenOperands is \"last\", only on a command whose operands are paths", () => {
    const with_ = (c) => ({ ...cp, command: { ...cp.command, ...c } });
    assert.deepEqual(validateManifest(cp), []);
    assert.notDeepEqual(validateManifest(with_({ writtenOperands: "first" })), []);
    assert.notDeepEqual(validateManifest(with_({ writtenOperands: true })), []);
    assert.notDeepEqual(validateManifest(with_({ paths: "none" })), [], "operands that are not paths have no destination");
    assert.deepEqual(validateManifest(with_({ paths: { operandsFrom: 1 } })), []);
});

// --- what the host is asked to map ---

test("only `filesArgv: true` in hello says the host maps /files", () => {
    assert.equal(hostMapsFiles({ filesArgv: true }), true);
    for (const v of [false, "yes", 1, {}, null, undefined]) assert.equal(hostMapsFiles({ filesArgv: v }), false, String(v));
    assert.equal(hostMapsFiles(undefined), false);
});

test("a spawn names the mount /files is, and sends the written paths' role; without one, neither", () => {
    const p = plan(["cp", "/files/attached/3fa91c2/data.csv", "/files/data.csv"]);
    assert.deepEqual(p.spawn.files, { mount: "m1", session: "s1" });
    assert.deepEqual(p.spawn.pathArgs, [{ arg: 1 }, { arg: 2, role: "write" }], "the host maps the path arguments; a source is read");
    assert.equal(p.filesRefusal, undefined);
    const bare = plan(["cp", "a", "b"], null);
    assert.equal("files" in bare.spawn, false);
    assert.deepEqual(bare.spawn.pathArgs, [{ arg: 1 }, { arg: 2, role: "write" }], "the role is sent whatever /files is: a written path in attached/ is refused by either name");
});

test("a described call's /files argument that is not a path (a pattern) is left alone and not refused", () => {
    for (const argv of [["rg", "/files/", "."], ["rg", "-e", "/files/x", "src"]]) {
        assert.equal(plan(argv).filesRefusal, undefined, argv.join(" "));
    }
    assert.deepEqual(plan(["rg", "/files/", "."]).spawn.pathArgs, [{ arg: 2, walk: true }], "the pattern is not a path the host maps");
});

test("a versioned program is placed by its parse: rg and git rm name /files paths before the host reports a version", () => {
    for (const argv of [["rg", "TODO", "/files"], ["git", "rm", "/files/x"]]) {
        const p = plan(argv);
        assert.equal(p.description.described, false, `${argv.join(" ")}: undescribed until the version is known`);
        assert.equal(p.filesRefusal, undefined, argv.join(" "));
    }
});

// --- what cannot be placed ---

test("a /files argument of a program with no manifest is refused with the real path to retry with", () => {
    assert.equal(plan(["python3", "/files/data.csv"]).filesRefusal, "/files is on disk while the host is connected: ~/git/proj/window-ml-files/data.csv");
    assert.equal(plan(["python3", "/files"]).filesRefusal, "/files is on disk while the host is connected: ~/git/proj/window-ml-files");
    assert.equal(plan(["python3", "--in=/files/a"]).filesRefusal, "/files is on disk while the host is connected: ~/git/proj/window-ml-files/a", "after the first =");
    assert.equal(plan(["python3", "-Dk=/files/a"]).filesRefusal?.endsWith("window-ml-files/a"), true);
    assert.equal(plan(["python3", "/files/a"], { ...FILES, shown: "~/p/window-ml-files/" }).filesRefusal, "/files is on disk while the host is connected: ~/p/window-ml-files/a", "a trailing / on the folder is not doubled");
});

test("a /files argument of an undescribed call is refused even where the parse put a path", () => {
    for (const argv of [["cp", "-t", "/files/attached/x", "a"], ["cp", "-a", "/files/a", "b"], ["cp", "a", "/files/b", "-r"]]) {
        const p = plan(argv);
        assert.equal(p.description.described, false, argv.join(" "));
        assert.match(p.filesRefusal ?? "", /^\/files is on disk while the host is connected: ~\/git\/proj\/window-ml-files\//, argv.join(" "));
    }
});

test("only the start and the first = are looked at, a stated cost; a name that merely begins with /files is not /files", () => {
    assert.equal(plan(["python3", "--set=a=/files/x"]).filesRefusal, undefined, "after a second =: not seen");
    assert.equal(plan(["python3", "/filesystem/x"]).filesRefusal, undefined);
    assert.equal(plan(["python3", "x/files/y"]).filesRefusal, undefined);
    assert.equal(plan(["python3", "/files/x"], null).filesRefusal, undefined, "with no host folder, /files is not on disk: nothing to refuse");
});

// --- the card and the record ---

const facts = (over = {}) => ({
    id: "c1", argv: ["cp", "/h/proj/window-ml-files/attached/3/d.csv", "/h/proj/window-ml-files/d.csv"], program: { path: "/bin/cp", inRoot: false },
    cwd: { path: "/h/proj", inRoot: true }, env: { set: [], secrets: [], free: true }, repo: null, repoConfigRunsCode: false,
    paths: [], effects: "unknown", mode: "host", sandboxed: true, placement: "host-sandbox", expiresInMs: 1000, ...over,
});
const mapped = [{ index: 1, from: "/files/attached/3/d.csv", to: "/h/proj/window-ml-files/attached/3/d.csv" }, { index: 2, from: "/files/d.csv", to: "/h/proj/window-ml-files/d.csv" }];

test("the card shows each mapped argument in both forms, and an older host's facts carry none", () => {
    const f = shFacts(facts({ files: mapped }), undefined);
    assert.deepEqual(f.files, mapped);
    const lines = shCardLines(f).filter((l) => l.label === "/files");
    assert.deepEqual(lines.map((l) => l.value), ["/files/attached/3/d.csv is /h/proj/window-ml-files/attached/3/d.csv", "/files/d.csv is /h/proj/window-ml-files/d.csv"]);
    assert.deepEqual(shFacts(facts(), undefined).files, [], "absent from an older host");
    assert.deepEqual(filesLines([]), []);
});

test("a call that ran without asking keeps the mapped forms under its step", () => {
    const lines = unaskedLines({ by: "default", argv: facts().argv, files: mapped, outcome: {} });
    assert.deepEqual(lines.filter((l) => l.label === "/files").length, 2);
    assert.equal(unaskedLines({ by: "default", argv: ["cp"], outcome: {} }).some((l) => l.label === "/files"), false, "an older record has none");
});
