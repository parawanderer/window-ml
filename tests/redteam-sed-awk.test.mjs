// redteam-sed-awk.test.mjs — a sed script or an awk program is a second language in one argv string, and the commands
// that write a file, read a file the argv does not name, or start a program live in it (`w`, `W`, `r`, `R`, `e`, `F`,
// the `s` flags `w`/`e`/`m`/`M`; awk's `system`, `getline`, `ENVIRON`, `ARGV`, `ARGC`, `PROCINFO`, `@`, `|`, `print >`).
// The manifest cannot list those as flags, so `script: "sed" | "awk"` hands the text to script-grammar.ts and a text
// outside the grammar makes the CALL `unknown` — which asks, and is never free.
//
// The property, in one line: no sed script and no awk program that writes a file, reads an unnamed file or starts a
// program is described as free; text outside the grammar is `unknown`. The lane's own rows (tests/script-grammar.test.mjs)
// hold the grammar function by function. These go through `describeCall` and the SHIPPED manifests, because the hole a
// grammar alone cannot show is the ARGV: the text sed or awk really runs is not always `argv[1]` (an `-e` chain, a value
// attached in the same token, GNU's permission to put a flag after an operand), and the first operand is a FILE once a
// script flag gave the program. Every row here names a shape the fixtures (tests/fixtures/program-calls/{sed,awk}.json)
// do not carry, and every section keeps a free control: a checker that refused everything would pass the refusals alone.
//
// WHAT THIS FILE CANNOT ROW (named so the next reader does not look for it):
//   - gawk: the awk manifest declares one flavour (`bsd`, macOS) and every other awk is refused as an implementation the
//     manifest does not describe (`other` → unknown), so a shape that differs only in gawk's lexer cannot cost anything:
//     the call asks before the program is read at all. Row "an awk its manifest does not describe" below.
//   - a backslash-newline inside a keyword (`sys\<newline>tem("id")`, `prin\<newline>t "x" > "out"`): the substring check
//     accepts it, since the raw text holds neither word. MEASURED on BSD awk 20200816 (this machine's awk, the flavour
//     the manifest describes): it does not glue the keyword — `sys\<newline>tem(...)` stops at "calling undefined
//     function tem", and `prin\<newline>t "X"` is an expression statement that prints nothing — so the acceptance is
//     harmless on the only implementation this manifest describes. The row below holds the flavour refusal that keeps
//     gawk out; the splice itself is not a row, it is this measurement.
//   - the awk program's OWN reading of a file through a path the argv names (an operand): that is a `read` the manifest
//     reports, not an unnamed file.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const { describeCall } = await import("../src/shell/program-manifest.ts");
const MANIFESTS = path.resolve(import.meta.dirname, "../src/shell/manifests");
const sedManifest = JSON.parse(fs.readFileSync(path.join(MANIFESTS, "sed.json"), "utf8"));
const awkManifest = JSON.parse(fs.readFileSync(path.join(MANIFESTS, "awk.json"), "utf8"));

const T = { timeout: 30000 };

/** The call's description as the property reads it: described, and the effects a policy is judged on. */
function call(argv, manifest = sedManifest, flavour) {
    const d = describeCall(argv, manifest, { version: "4.9", ...(flavour ? { flavour } : {}) });
    return { described: d.described, effects: d.effects, why: d.why, pathArgs: d.pathArgs };
}

/** The property, for a call that must never be free: `unknown` effects are what makes the card and the policy ask. */
function assertAsks(argv, manifest = sedManifest, flavour) {
    const got = call(argv, manifest, flavour);
    assert.equal(got.described, false, `${JSON.stringify(argv)} is described: ${JSON.stringify(got.effects)}`);
    assert.equal(got.effects, "unknown", `${JSON.stringify(argv)} has effects ${JSON.stringify(got.effects)}`);
    assert.ok(got.why.length > 0, `${JSON.stringify(argv)} has no line saying why it is unknown`);
}

// --- sed: a script that writes a file, reads an unnamed file or runs a program, in every argv shape it can arrive in ---

test("RED TEAM: every sed command that writes a file, reads a file or runs a program makes the CALL unknown", T, () => {
    for (const script of [
        "w out.txt", "1w out.txt", "$w out.txt", "/x/w out.txt", "/x/!w out.txt", "W out.txt", "/x/W out.txt",
        "r /etc/passwd", "1r f", "R f", "e", "e id", "E", "F",
        "s/a/b/w out.txt", "s/a/b/gw out.txt", "s/a/b/e", "s/a/b/ge", "s/x/y/2w out.txt",
        "p;w out.txt", "{p;w out.txt}", "/x/{p\nw out.txt\n}", "y/a/b/;w out.txt", "#n\nw out.txt", ":l;w out.txt",
        "a text", "i text", "c text", "b", "t", "T", ":a;ba",
    ]) {
        // The script as the first operand, before a file that must not save it from being unknown.
        assertAsks(["sed", script, "a.txt"], sedManifest, "gnu");
        assertAsks(["sed", script, "a.txt"], sedManifest, "bsd");
    }
});

test("RED TEAM: a writing script given through -e or --expression is caught wherever in the chain it sits", T, () => {
    for (const argv of [
        ["sed", "-e", "w out.txt", "a.txt"],
        ["sed", "-e", "p", "-e", "w out.txt", "a.txt"],
        ["sed", "-e", "w out.txt", "-e", "p", "a.txt"],
        ["sed", "-n", "-e", "p", "-e", "r /etc/passwd", "a.txt"],
        ["sed", "--expression=p", "--expression=w out.txt", "a.txt"],
        ["sed", "--expression=p;w out.txt", "a.txt"],
        ["sed", "-new out.txt", "a.txt"],
        ["sed", "-nep;w out.txt", "a.txt"],
        ["sed", "a.txt", "-e", "w out.txt"],
        ["sed", "p", "a.txt", "--expression=w out.txt"],
        ["sed", "--", "w out.txt", "a.txt"],
    ]) assertAsks(argv, sedManifest, "gnu");
    // Under BSD the operand-first shapes are refused for their ambiguity too, and the -e chain is read the same way.
    assertAsks(["sed", "-e", "p", "-e", "w out.txt", "a.txt"], sedManifest, "bsd");
});

test("RED TEAM: a script using the one form both seds read differently is unknown even when the flavour is known", T, () => {
    // GNU ends the bracket expression at the second `/` and BSD never does: the text after it (`w F`) is a file to one
    // sed and an error to the other. Nothing may be described as read-only from a script whose own end differs.
    for (const flavour of ["gnu", "bsd"]) assertAsks(["sed", "s/[[:a:[]/]/Q/w F", "a.txt"], sedManifest, flavour);
});

test("RED TEAM: the free control — a read-only sed script describes, and the script is not one of its paths", T, () => {
    for (const [argv, flavour, arg] of [
        [["sed", "-n", "p", "a.txt"], "gnu", 3],
        [["sed", "s/a/b/g", "a.txt", "b.txt"], "gnu", 2],
        [["sed", "-ne", "p", "a.txt"], "gnu", 3],
        [["sed", "-i", "s/a/b/", "a.txt"], "gnu", 3],
        [["sed", "-n", "p", "a.txt"], "bsd", 3],
    ]) {
        const got = call(argv, sedManifest, flavour);
        assert.equal(got.described, true, `${JSON.stringify(argv)}: ${JSON.stringify(got.why)}`);
        assert.ok(got.effects !== "unknown");
        assert.equal(got.pathArgs.some((p) => p.arg === arg - 1 && p.role === "read" && argv[arg - 1] === "p"), false, "the script itself is not a path");
        assert.ok(got.pathArgs.some((p) => p.arg === arg), `${JSON.stringify(argv)}: the file operand is a path: ${JSON.stringify(got.pathArgs)}`);
    }
});

// --- awk: a program that writes a file, reads a file or the environment, or starts a program ---

test("RED TEAM: every awk program that runs a command, reads a named file or the environment is unknown", T, () => {
    for (const program of [
        `{system("id")}`, `BEGIN{system("id")}`,
        `{while (("id" | getline) > 0) print}`, `{"id" |& getline}`, `{print | "id"}`, `{print | "sh"; close("sh")}`,
        `{getline x < "f"}`, `BEGIN{while ((getline line < "/etc/passwd") > 0) print line}`,
        `{print > "out"}`, `{print >> "out"}`, `{printf "%s", $0 > "out"}`, `BEGIN{print "x" > "/dev/stderr"}`,
        `BEGIN{print ENVIRON["HOME"]}`, `BEGIN{for (i in ARGV) print i}`, `BEGIN{print ARGC}`, `BEGIN{print PROCINFO["pid"]}`,
        `@include "x"`, `{f = @g}`, `BEGIN{print "system"}`, `{if (1) { system("id") }}`,
    ]) assertAsks(["awk", program, "a.txt"], awkManifest, "bsd");
});

test("RED TEAM: the awk checker's over-refusals only ever ask, and a comparison before any print stays described", T, () => {
    // Refused although harmless: a string holding a forbidden word, and a comparison written AFTER a print. Both are
    // the checker's width, and both ask — the property is that nothing free writes, not that everything harmless is free.
    for (const program of [`{print "system"}`, `{print ">"}`, `{print; if ($1 > 2) print "x"}`]) assertAsks(["awk", program, "a.txt"], awkManifest, "bsd");
    // The comparison BEFORE any print is no redirection, so the program is described and reads only what the argv names.
    for (const program of [`{if ($1 > 2) print}`, `{if ($1 > 2) print "x"}`]) {
        const got = call(["awk", program, "a.txt"], awkManifest, "bsd");
        assert.equal(got.described, true, `${program}: ${JSON.stringify(got.why)}`);
        assert.ok(got.effects.some((e) => e.op === "read"), "the operand is the call's read");
    }
});

test("RED TEAM: an awk operand that is an assignment is a variable, not a file, and adds no path", T, () => {
    const got = call(["awk", `{print}`, "n=1", "a.txt"], awkManifest, "bsd");
    assert.equal(got.described, true, JSON.stringify(got.why));
    assert.deepEqual(got.pathArgs.map((p) => p.arg), [3], `only a.txt is a path: ${JSON.stringify(got.pathArgs)}`);
});

test("RED TEAM: a program from a file (-f), and an awk its manifest does not describe, are unknown before any text is read", T, () => {
    assertAsks(["awk", "-f", "prog.awk", "a.txt"], awkManifest, "bsd");
    assertAsks(["awk", `{print $1}`, "-f", "prog.awk", "a.txt"], awkManifest, "bsd");
    // gawk is `other`: the splice shapes below cannot be reached through it at all, which is what keeps them harmless.
    assertAsks(["awk", `{sys\\\ntem("id")}`, "a.txt"], awkManifest, "other");
    assertAsks(["awk", `{prin\\\nt "x" > "out"}`, "a.txt"], awkManifest, "other");
});

test("RED TEAM: the free control — a read-only awk program describes, and its program is not a path", T, () => {
    for (const [argv, arg] of [
        [["awk", `{print $1}`, "a.txt"], 2],
        [["awk", "-F,", `{print $2}`, "a.csv"], 3],
        [["awk", "-v", "x=1", `{print x, $0}`, "a.txt"], 4],
    ]) {
        const got = call(argv, awkManifest, "bsd");
        assert.equal(got.described, true, `${JSON.stringify(argv)}: ${JSON.stringify(got.why)}`);
        assert.deepEqual(got.pathArgs.map((p) => p.arg), [arg], `${JSON.stringify(argv)}: ${JSON.stringify(got.pathArgs)}`);
    }
});

// --- sed and awk alike: an implementation the manifest does not describe is unknown, whatever the text says ---

test("RED TEAM: an undescribed implementation is unknown, so no text is ever read through it", T, () => {
    assertAsks(["sed", "-n", "p", "a.txt"], sedManifest, "other");
    assertAsks(["awk", `{print $1}`, "a.txt"], awkManifest, "other");
});
