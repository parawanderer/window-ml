// count-programs.test.mjs — the splitter behind notebooks/shell/shell-usage.ipynb: which words it counts as programs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCommands, classify } from "../notebooks/shell/count-programs.mjs";

/** The programs one command line counts, in order. */
const programs = (src) => parseCommands(src).map(classify).filter((r) => r && r.program).map((r) => r.program);

// --- shapes that are not a program call: none of their words is counted ---

const NOT_PROGRAMS = [
    ["a case pattern list", 'case "$1" in\n  start) grep a f;;\n  stop|halt) sed 1q ;;\n  (*) wc f;;\nesac; ls', ["grep", "sed", "wc", "ls"]],
    ["a nested case", "case $x in a) case $y in b) cat f;; esac; tail f;; esac; head f", ["cat", "tail", "head"]],
    ["a case whose last item has no ;;", "case $x in a) jq . f\nesac\nrg x", ["jq", "rg"]],
    ["a function definition and a call to it", "helper() { grep x f; }; helper; X=1 helper", ["grep"]],
    ["a `function name ()` definition", "function g () { sed 1q; }; if true; then g; fi", ["sed", "true"]],
    ["a =~ group inside [[ ]]", '[[ "$x" =~ ^(alpha|beta)$ ]] && date', ["date"]],
    ["&& inside [[ ]]", "[[ -f a && -d b ]] || mkdir b", ["mkdir"]],
    ["arithmetic inside double quotes", 'sed -n "$((n+45))p" f | head', ["sed", "head"]],
    ["a bare (( )) and for (( ))", "(( n+3 )) && grep x f; for ((i=0;i<3;i++)); do ls; done", ["grep", "ls"]],
];
for (const [what, src, want] of NOT_PROGRAMS) {
    test(`not a program: ${what}`, () => assert.deepEqual(programs(src), want));
}

// --- shapes that do run a program inside a construct: it is counted ---

test("a $( ) inside [[ ]] still runs, and is counted", () => {
    assert.deepEqual(programs('if [[ "$(uname)" == Darwin ]]; then sysctl -n hw.ncpu; fi'), ["uname", "sysctl"]);
});

test("a subshell's commands are counted", () => {
    assert.deepEqual(programs("(cd a && make)"), ["make"]);
});

test("wrappers are unwrapped to the program they run", () => {
    assert.deepEqual(programs("sudo -u root env A=1 nice -n 5 xargs -I{} prog"), ["prog"]);
    assert.deepEqual(programs("timeout 5 sleep 1"), ["sleep"]);
});

test("a heredoc body is skipped to its terminator, and the command after it is read", () => {
    assert.deepEqual(programs("cat <<'EOF'\ngrep x $(ls)\nEOF\nwc -l f"), ["cat", "wc"]);
});

test("a { …; } group's commands are counted", () => {
    assert.deepEqual(programs("{ grep x f; sed 1q f; } > out"), ["grep", "sed"]);
});
