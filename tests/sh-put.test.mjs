// sh-put.test.mjs — one `ml.sh.put(file, path)` call as src/shell/sh-put.ts sees it, with no host and no worker: the
// argument checks, the facts a policy and the card are given, the built-in judgement over them, and the sentences.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseShPut, putFacts, putCardLines, putSubject, putRefusalText, putTooLargeText, base64Of, PUT_PATH_MAX } from "../src/shell/sh-put.ts";
import { ShRefused } from "../src/shell/sh-call.ts";
import { free, boundFor } from "../src/effects.ts";
import { evalPolicy } from "../src/readonly-exec/policy-realm.ts";

const refused = (args, re) => assert.throws(() => parseShPut(args), (e) => e instanceof ShRefused && e.code === "BadRequest" && re.test(e.message), `${JSON.stringify(args)}`);
const hostFacts = (rel, over = {}) => ({ id: "p1", path: `/w/${rel}`, root: "/w", rel, exists: false, existingSize: null, size: 10, tilde: [], ...over });
const FILE = { name: "r.pdf", type: "application/pdf", bytes: 10, sha256: "ab".repeat(32) };

// --- what a script may pass ---

test("put takes exactly two arguments: 0, 1 and 3 are BadRequest", () => {
    for (const args of [[], ["@file:3fa91c2"], ["@file:3fa91c2", "a", "b"], ["@file:3fa91c2", "a", "b", "c"]]) refused(args, /ml\.sh\.put takes an attached file's @file: handle/);
});

test("the first argument is an @file: handle string; anything else is BadRequest", () => {
    for (const first of ["@tool:ab12cd3", "3fa91c2", "@FILE:x", " @file:x", "file:x", "", 3, null, undefined, {}, ["@file:x"], true])
        refused([first, "inbox/x.pdf"], /takes an attached file's @file: handle/);
});

test("the path is a non-empty string without a NUL, at most PUT_PATH_MAX characters", () => {
    for (const path of ["", 3, null, undefined, {}, ["a"]]) refused(["@file:3fa91c2", path], /takes an attached file's @file: handle/);
    refused(["@file:3fa91c2", "a\0b"], /contains a NUL/);
    refused(["@file:3fa91c2", "x".repeat(PUT_PATH_MAX + 1)], /longer than 4096 characters/);
    const edge = "x".repeat(PUT_PATH_MAX);
    assert.deepEqual(parseShPut(["@file:3fa91c2", edge]), { ref: "@file:3fa91c2", path: edge }, "exactly PUT_PATH_MAX is accepted");
});

test("the good case returns the handle and the path as given", () => {
    assert.deepEqual(parseShPut(["@file:3fa91c2", "inbox/report.pdf"]), { ref: "@file:3fa91c2", path: "inbox/report.pdf" });
    assert.deepEqual(parseShPut(["@file:x", "../up"]), { ref: "@file:x", path: "../up" }, "resolving a path is the host's, not the parser's");
});

// --- the facts a policy and the card are given ---

test("the effects are exactly one in-root write of the resolved path; topLevel is by the relative path, exists is carried", () => {
    for (const [rel, topLevel] of [["x.pdf", true], ["inbox/x.pdf", false], ["a/b/c.txt", false], [".env.local", true]])
        for (const exists of [false, true]) {
            const f = putFacts(hostFacts(rel, { exists }), FILE);
            assert.deepEqual(f.effects, [{ op: "write", res: { kind: "fs", path: `/w/${rel}`, inRoot: true, exists, topLevel } }], `${rel} exists=${exists}`);
        }
});

test("the sh-call keys are present, so a policy written for ml.sh.run reads them without throwing", () => {
    const f = putFacts(hostFacts("inbox/x.pdf"), FILE);
    assert.deepEqual(f.argv, []);
    assert.equal(f.program.path, "");
    assert.equal(f.cwd.path, "/w");
    assert.equal(f.cwd.inRoot, true);
    assert.equal(f.placement, "host-sandbox");
    assert.equal(f.described, false, "no manifest describes a put: it runs no program");
    assert.equal(f.credential, null);
    assert.equal(f.put.exists, false);
    assert.equal(f.put.file, "r.pdf");
    assert.equal(f.put.sha256, FILE.sha256);
    assert.equal((c => c.program.path.startsWith("/usr"))(f), false);
    assert.equal((c => c.argv[0] === "git")(f), false);
});

// --- a policy written for programs never frees a put (the coordinator's condition, 2026-11-08) ---

/** Allow policies a person writes for named programs, each freeing a real call of that program (the control below). */
const PROGRAM_POLICIES = [
    "(c) => c.program.path === \"/usr/bin/git\"",
    "(c) => c.argv[0] === \"git\"",
    "(c) => c.argv.length > 0 && c.argv[0] === \"ls\"",
    "(c) => c.program.path.endsWith(\"/rg\") && c.cwd.inRoot",
    "(c) => c.placement === \"host-sandbox\" && c.argv.includes(\"status\")",
    "(c) => c.program.inRoot === false && c.program.path.startsWith(\"/usr/\")",
    "(c) => c.described",
    "(c) => c.described && c.cwd.inRoot && c.placement === \"host-sandbox\"",
    "(c) => c.credential?.provider === \"gh\" && !c.credential.held",
];

test("a policy that frees a named program, evaluated on a put's facts, neither allows nor breaks, at either placement", () => {
    const program = (path, argv) => ({ argv, program: { path, inRoot: false, version: null }, cwd: { path: "/w", inRoot: true }, placement: "host-sandbox", described: true, credential: { provider: "gh", sends: "", held: false, ports: [] } });
    const controls = [program("/usr/bin/git", ["git", "status"]), program("/usr/bin/git", ["git", "status"]), program("/bin/ls", ["ls"]), program("/usr/bin/rg", ["rg", "x"]), program("/usr/bin/git", ["git", "status"]), program("/usr/bin/git", ["git", "status"]), program("/usr/bin/git", ["git", "status"]), program("/usr/bin/git", ["git", "status"]), program("/usr/bin/git", ["git", "status"])];
    for (const [i, source] of PROGRAM_POLICIES.entries()) {
        assert.equal(evalPolicy(source, controls[i], "allow").decision, "allow", `control: ${source} does not free its own program, so this row proves nothing`);
        for (const rel of ["r.pdf", "inbox/r.pdf"]) for (const exists of [false, true]) {
            const f = putFacts(hostFacts(rel, { exists }), FILE);
            for (const placement of ["host-sandbox", "host-plain"]) {
                const r = evalPolicy(source, { ...f, placement }, "allow");
                assert.notEqual(r.decision, "allow", `${source} freed a put of ${rel} (exists ${exists}) at ${placement}`);
                assert.equal(r.broken, undefined, `${source} broke on a put's facts at ${placement}: ${r.broken}`);
            }
        }
    }
    const f = putFacts(hostFacts("r.pdf"), FILE);
    assert.deepEqual([f.argv, f.program.path], [[], ""], "a put names no program: its argv is empty and its program path is the empty string");
});

// --- the built-in judgement over the effects ---

test("the built-in default: a new nested file is free in the sandbox, a new top-level name is not, and nothing is free on the plain host", () => {
    const sandbox = boundFor("host-sandbox"), plain = boundFor("host-plain");
    const eff = (rel, exists) => putFacts(hostFacts(rel, { exists }), FILE).effects;
    assert.equal(free(eff("inbox/x.pdf", false), sandbox), true, "new nested");
    assert.equal(free(eff("x.pdf", false), sandbox), false, "new top-level name");
    assert.equal(free(eff("x.pdf", true), sandbox), true, "the bound alone frees an in-place top-level write (the caller asks for an existing file anyway)");
    for (const rel of ["x.pdf", "inbox/x.pdf"]) for (const exists of [false, true]) assert.equal(free(eff(rel, exists), plain), false, `plain ${rel} ${exists}`);
});

// --- the sentences ---

test("a host refusal keeps its code word and the JSON-quoted path; an unknown code falls back to the generic form", () => {
    const path = 'in "box"/x\\y.pdf';
    for (const code of ["OutsideRoots", "NoParent", "IsSymlink", "IsDirectory", "Protected", "Exists"]) {
        const t = putRefusalText(code, "host words", path);
        assert.ok(t.startsWith(`ml.sh.put: ${code}: `), `${code}: ${t}`);
        assert.ok(t.includes(JSON.stringify(path)), `${code} quotes the path`);
        assert.ok(!t.includes("host words"), `${code} uses its own sentence`);
    }
    assert.equal(putRefusalText("Weird", "boom", "p"), "ml.sh.put: Weird: boom");
});

test("the too-large sentence names both numbers", () => {
    const t = putTooLargeText(307200, 262144);
    assert.ok(t.includes("307200") && t.includes("262144") && t.includes("TooLarge"), t);
});

test("the card: a new file has no replaces line, an existing one has a warn line, a path tilde adds a line and an argv-index tilde does not", () => {
    const labels = (f) => putCardLines(putFacts(f, FILE)).map((l) => l.label);
    assert.deepEqual(labels(hostFacts("a/x.pdf")), ["write", "to"]);
    const ex = putCardLines(putFacts(hostFacts("a/x.pdf", { exists: true, existingSize: 1234 }), FILE));
    const rep = ex.find((l) => l.label === "replaces");
    assert.ok(rep?.warn && rep.value.includes("1,234"), JSON.stringify(ex));
    assert.equal(putCardLines(putFacts(hostFacts("a/x.pdf", { exists: true, existingSize: null }), FILE)).find((l) => l.label === "replaces").value, "the file there now");
    const t = (index, to) => ({ index, from: "~", to, ...(to ? {} : { reason: "no home" }) });
    assert.deepEqual(labels(hostFacts("a", { tilde: [t("path", "/h")] })), ["write", "to", "~"]);
    assert.deepEqual(labels(hostFacts("a", { tilde: [t(0, "/h"), t("cwd", "/h")] })), ["write", "to"]);
    const lit = putCardLines(putFacts(hostFacts("a", { tilde: [t("path", null)] }), FILE)).find((l) => l.label === "~");
    assert.ok(lit.warn && /stays literal \(no home\)/.test(lit.value));
});

test("putSubject names the file and where it goes; facts of another shape give the empty string", () => {
    assert.equal(putSubject(putFacts(hostFacts("a/x.pdf"), FILE)), "r.pdf to /w/a/x.pdf");
    for (const v of [{}, undefined, null, "s", 3, { put: {} }, { put: { file: "a" } }]) assert.equal(putSubject(v), "", JSON.stringify(v));
});

// --- base64 ---

test("base64Of round-trips 0 bytes, 1 byte, the chunk edge and past it", () => {
    for (const n of [0, 1, 2, 3, 0x8000 - 1, 0x8000, 0x8000 + 1, 0x8000 * 2 + 3]) {
        const b = new Uint8Array(n).map((_, i) => (i * 131 + 7) & 255);
        assert.equal(base64Of(b), Buffer.from(b).toString("base64"), `${n} bytes`);
    }
});
