// script-grammar.test.mjs — the narrow sed script and awk program (src/shell/script-grammar.ts, PROGRAM_MANIFEST.md "sed and awk"): what each accepts, every form each refuses, and the two seds' delimiter scanners held to their sources.
import { test } from "node:test";
import assert from "node:assert/strict";

const { sedScriptRefusal, awkProgramRefusal, AWK_ASSIGNMENT, __gnuRegexEnd, __bsdDelimitedEnd } = await import("../src/shell/script-grammar.ts");

// --- sed: what is described ---

test("a sed script of plain commands, addresses and s/y is described, under GNU and BSD alike", () => {
    for (const s of [
        "p", "s/a/b/", "s/a/b/g", "s/a/b/2p", "s|a|b|gI", "s/a/b/i", "1d", "$p", "1,3p", "/re/,/re2/d", "/x/,$d", "/x/!d", "/x/ ! d",
        "/x/{s/a/b/;p;}", "/x/{\ns/a/b/\np\n}", "h;G", "=", "q", "y/abc/xyz/", "y,a\\,b,xyz,", "n;N;D;P;x;g;H", "p\nd", ";;p;;", "  p  ",
        "s/[/]/X/", "s/[[:alpha:]/]/X/", "s/a[]/]/X/", "s/[^]/]/X/", "s/\\//X/", "s/[\\]/X/", "", "s/a/b/;s/c/d/g",
    ]) {
        assert.equal(sedScriptRefusal(s, false), undefined, `bsd or undetected: ${JSON.stringify(s)}`);
        assert.equal(sedScriptRefusal(s, true), undefined, `gnu: ${JSON.stringify(s)}`);
    }
});

test("q with an exit code is GNU's alone", () => {
    assert.equal(sedScriptRefusal("q5", true), undefined);
    assert.equal(sedScriptRefusal("/x/q 3", true), undefined);
    assert.match(sedScriptRefusal("q5", false), /"5" after q/);
});

// --- sed: what is refused ---

test("every sed command that reads or writes a file or runs a command is refused, and so is every s flag that does", () => {
    for (const [s, why] of [
        ["w out", /"w" is not described: it reads or writes a file/], ["1w out", /"w"/], ["W out", /"W"/], ["r /etc/passwd", /"r"/],
        ["R f", /"R"/], ["e", /"e"/], ["e ls", /"e"/], ["F", /"F"/], ["/x/w out", /"w"/],
        ["s/a/b/w out", /the s flag "w"/], ["s/a/b/gw out", /the s flag "w"/], ["s/a/b/e", /the s flag "e"/], ["s/a/b/m", /the s flag "m"/],
        ["s/a/b/M", /the s flag "M"/], ["s/a/b/ w out", /the s flag "w"/], ["s/a/b/;w out", /"w"/], ["p;w out", /"w"/],
        ["p w out", /"w" after p/], ["{w out\n}", /"w"/], ["s/a/b/\nw out", /"w"/],
    ]) assert.match(sedScriptRefusal(s, false) ?? "DESCRIBED", why, JSON.stringify(s));
});

test("labels, branches, text commands, comments and the rest of sed are refused, so no reading of them can differ", () => {
    for (const [s, why] of [
        [":a;N;ba", /":"/], ["b", /"b"/], ["t", /"t"/], ["T", /"T"/], ["a text", /"a"/], ["a\\\ntext", /"a"/], ["i x", /"i"/], ["c x", /"c"/],
        ["#n\np", /"#"/], ["p # c", /"#" after p/], ["l", /"l"/], ["L", /"L"/], ["Q", /"Q"/], ["z", /"z"/], ["v", /"v"/],
    ]) assert.match(sedScriptRefusal(s, false) ?? "DESCRIBED", why, JSON.stringify(s));
});

test("GNU's address forms and a custom address delimiter are refused", () => {
    for (const [s, why] of [
        ["0,/x/d", /line address 0/], ["0p", /line address 0/], ["1~2p", /"~"/], ["1,+2p", /second address/], ["1,~4p", /second address/],
        ["\\%x%d", /its own delimiter/], ["/x/Id", /"I"/], ["/x/Md", /"M"/], ["/x/,\\%y%d", /its own delimiter/],
    ]) assert.match(sedScriptRefusal(s, true) ?? "DESCRIBED", why, JSON.stringify(s));
});

test("a script whose braces do not balance, or an address with no command, is refused", () => {
    assert.match(sedScriptRefusal("}", false), /closes no \{/);
    assert.match(sedScriptRefusal("/x/{p", false), /not closed/);
    assert.match(sedScriptRefusal("1", false), /no command/);
    assert.match(sedScriptRefusal("1}", false), /"\}" is not described/);
});

test("an s or y that is not closed on its own line, or uses a delimiter both seds do not read as one byte, is refused", () => {
    for (const [s, why] of [
        ["s/a/b", /replacement is not closed/], ["s/a", /not closed/], ["s/a\nb/c/", /not closed/], ["s/a/b\nc/", /not closed/],
        ["s/a/b\\\nc/", /not closed/], ["s\\a\\b\\", /delimiter "\\\\"/], ["s a b ", /delimiter " "/], ["sxaxbx", undefined], ["s", /delimiter ""/],
        ["séaébé", /delimiter/], ["y/ab/x", /not closed/], ["y/[a/xy/", /holding \[/],
    ]) {
        const got = sedScriptRefusal(s, false);
        if (why === undefined) assert.equal(got, undefined, JSON.stringify(s));
        else assert.match(got ?? "DESCRIBED", why, JSON.stringify(s));
    }
});

// --- sed: the two delimiter scanners ---

test("a bracket expression GNU and BSD sed end in different places is refused (measured: GNU 4.9 snarf_char_class, Apple text_cmds compile_ccl)", () => {
    // GNU: after a class's closing `:`, a `[` keeps it closing, and `]` closes it; BSD needs `:]`. So GNU ends the
    // regex at the second /, and BSD never: gsed parsed `w F` and created F, macOS sed reported unbalanced brackets.
    const s = "s/[[:a:[]/]/Q/w F";
    assert.equal(__gnuRegexEnd(s, 2, "/"), 12);
    assert.equal(__bsdDelimitedEnd(s, 2, "/"), -1);
    assert.match(sedScriptRefusal("s/[[:a:[]/]/X/", false), /not closed/);
});

test("both scanners skip a bracket expression whole and agree where its classes close", () => {
    for (const [re, end] of [["[/]/", 4], ["[[:alpha:]/]/", 13], ["a[]/]/", 6], ["[^]/]/", 6], ["[[.].]/]/", 9], ["[[=a=]/]/", 9], ["\\//", 3], ["[\\]/", 4], ["[[:a:]]]/", 9]]) {
        const s = `s/${re}X/`;
        assert.equal(__gnuRegexEnd(s, 2, "/"), 2 + end, `gnu ${re}`);
        assert.equal(__bsdDelimitedEnd(s, 2, "/"), 2 + end, `bsd ${re}`);
    }
});

test("a delimiter that is itself [ ends the regex at the first [, for both", () => {
    assert.equal(__gnuRegexEnd("s[a[b[", 2, "["), 4);
    assert.equal(__bsdDelimitedEnd("s[a[b[", 2, "["), 4);
    assert.equal(sedScriptRefusal("s[a[b[", false), undefined);
});

test("both scanners end every shared regex where the measured sed did (tests/fixtures/sed-scanners/regex-ends.json)", async () => {
    const { rows } = JSON.parse((await import("node:fs")).readFileSync(new URL("./fixtures/sed-scanners/regex-ends.json", import.meta.url), "utf8"));
    assert.ok(rows.length > 2000 && rows.some(([, g, b]) => g !== b), "the vectors hold rows where GNU and BSD differ");
    const differ = rows.filter(([s, g, b]) => __gnuRegexEnd(s, 2, "/") !== g || __bsdDelimitedEnd(s, 2, "/") !== b);
    assert.deepEqual(differ.slice(0, 10), []);
});

// --- awk ---

test("an awk program that only reads its operands and prints to stdout is described", () => {
    for (const p of ["{print $1}", "{ print $2, $1 }", "NR>1{print}", "$3 > 10 {print $1}", "BEGIN{FS=\":\"} {n++} END{print n}", "a || b {print}",
        "/x/{printf \"%s\\n\", $0}", "{s += $1} END {print s / NR}", "length($0) > 72", "{gsub(/a/, \"b\"); print}"]) assert.equal(awkProgramRefusal(p), undefined, p);
});

test("an awk program that can run a command, read another file or the environment, or write, is refused, by substring", () => {
    for (const [p, why] of [
        ["BEGIN{system(\"rm -rf x\")}", /"system"/], ["{\"date\" | getline d}", /"getline"/], ["{getline < \"/etc/passwd\"}", /"getline"/],
        ["BEGIN{print ENVIRON[\"HOME\"]}", /"ENVIRON"/], ["BEGIN{ARGV[1]=\"/etc/passwd\"; ARGC=2}", /"ARGV"/], ["BEGIN{ARGC=1}", /"ARGC"/],
        ["BEGIN{print PROCINFO[\"pid\"]}", /"PROCINFO"/], ["@include \"x.awk\"", /"@"/], ["BEGIN{f=\"system\"; @f()}", /"system"/],
        ["{print > \"out\"}", /> after a print/], ["{print >> \"out\"}", /> after a print/], ["{printf \"x\" > \"/dev/stderr\"}", /> after a print/],
        ["{print | \"sh\"}", /a \| that is not \|\|/], ["{print |& \"sh\"}", /a \|/], ["{print $1 ||| x}", /a \|/],
        // The check has no lexer, so a word inside a string or a comparison after a print is refused too: that only asks.
        ["{print \"system\"}", /"system"/], ["{print; if (a > b) n++}", /> after a print/],
    ]) assert.match(awkProgramRefusal(p) ?? "DESCRIBED", why, p);
});

test("a word or a redirection split by a backslash-newline is refused as the spliced text would read it", () => {
    for (const [p, why] of [
        ["BEGIN{sys\\\ntem(\"id\")}", /"system"/], ["{get\\\nline d < \"/etc/passwd\"}", /"getline"/], ["BEGIN{print ENV\\\nIRON[\"HOME\"]}", /"ENVIRON"/],
        ["{prin\\\nt \"x\" > \"out\"}", /> after a print/], ["{pr\\\nintf \"x\" >> \"out\"}", /> after a print/],
        // The raw text is checked too, so a | that only splices into || still asks.
        ["a |\\\n| b {print}", /a \| that is not \|\|/],
    ]) assert.match(awkProgramRefusal(p) ?? "DESCRIBED", why, JSON.stringify(p));
    // A backslash-newline that splices nothing refused stays described.
    for (const p of ["{print \\\n$1}", "NR>1\\\n{print}"]) assert.equal(awkProgramRefusal(p), undefined, JSON.stringify(p));
});

test("an awk operand is an assignment only in the identifier=value form awk itself reads as one", () => {
    for (const a of ["n=1", "FS=:", "_x9=", "a=b=c"]) assert.ok(AWK_ASSIGNMENT.test(a), a);
    for (const a of ["./n=1", "1n=2", "=x", "a-b=1", "file", "dir/a=b"]) assert.ok(!AWK_ASSIGNMENT.test(a), a);
});
