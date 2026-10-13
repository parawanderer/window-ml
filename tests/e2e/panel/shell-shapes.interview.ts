// shell-shapes.interview.ts — which borrowed API shape for ml.sh do models write correctly: argv, no shell syntax, in the shape asked?

import { defineInterview, type AskDef } from "../bench/spec";
import { faults, SHAPES, type ShapeKey } from "./shell-shapes.score";

/**
 * The paper panel of docs/spec/SHELL.md, "The API's shape": nothing runs. Each model gets one short doc per shape and
 * six everyday tasks, writes them once in the shape it would reach for, then once in each shape, and every answer is
 * scored by `shell-shapes.score.ts` (parses, uses the shape, no `sh -c`/`shell=True`, no shell syntax in an argv
 * element or a template's static part, no whole command line in one string). It measures WRITING, not use in a loop.
 */

const COMMON = `There is no shell anywhere. Every call becomes an argument vector (argv) that the host spawns directly, so \`|\`, \`>\`, \`&&\`, \`;\`, \`*\`, \`~\`, \`$VAR\`, quotes and \`$(…)\` mean nothing to it: a call that would need a shell to act on them is REFUSED, and so is spawning \`sh -c\`/\`bash -c\`. Each spawn needs the person's approval unless a policy allows it. A non-zero exit is a value, never an exception, in every shape. stdin is closed unless you pass input. JS shapes run inside \`exec\` (top-level await works); Python shapes run inside \`python_exec\`, where Python's own \`glob\`, \`os\` and \`open\` see the sandbox, not the host's files.`;

const DOCS: Record<ShapeKey, string> = {
    run: `### Shape "run" (JS): plain ml.sh
\`\`\`js
const r = await ml.sh.run(["git", "diff", "--stat", "HEAD~1"], { cwd: "repo", env: { CI: "1" }, input: "text for stdin" });
r.code; r.ok; r.stdout; r.stderr;                        // strings, code a number
const p = await ml.sh.pipe(["grep", "-F", x, "f.log"], ["wc", "-l"]);   // a real OS pipe, any number of argvs; result of the last
const files = await ml.sh.glob("src/*.ts", { cwd: "repo" });            // host-side glob, returns paths
\`\`\``,
    execa: `### Shape "execa" (JS): execa's call shape
\`\`\`js
const r = await execa("git", ["diff", "--stat", "HEAD~1"], { cwd: "repo", env: { CI: "1" }, input: "text for stdin" });
r.exitCode; r.failed; r.stdout; r.stderr;                // does not throw on a non-zero exit here
const p = await execa("grep", ["-F", x, "f.log"]).pipe("wc", ["-l"]);   // a real OS pipe; chain .pipe again for more
const files = await ml.sh.glob("src/*.ts", { cwd: "repo" });            // host-side glob, returns paths
\`\`\``,
    template: `### Shape "template" (JS): the zx/execa \`$\` template, argv-safe
\`\`\`js
const r = await $\`git diff --stat \${ref}\`;            // the static text is split on whitespace into words
const r2 = await $({ cwd: "repo", env: { CI: "1" }, input: "text" })\`npm test\`;
const p = await $\`grep -F \${x} f.log\`.pipe\`wc -l\`; // a real OS pipe; chain .pipe for more
const files = await ml.sh.glob("src/*.ts");             // host-side glob; \${files} passes the array as several arguments
r.exitCode; r.stdout; r.stderr;
\`\`\`
Each \`\${…}\` is exactly ONE argument whatever it contains (an array is one argument per element). The static text may hold only plain words: a quote, \`|\`, \`>\`, \`&\`, \`;\`, \`*\`, \`?\`, \`~\`, \`$\` or a backslash in it is refused.`,
    pysh: `### Shape "pysh" (Python): the \`sh\` library's shape
\`\`\`python
from ml.sh import sh, glob
r = sh.git.diff("--stat", "HEAD~1")         # attribute chain = program then subcommands; positional args are argv
r = sh.git.log(ref, max_count=5, oneline=True)   # long kwargs: max_count=5 -> --max-count=5, oneline=True -> --oneline; one letter: n=5 -> -n 5
r = sh.npm.test(_cwd="repo", _env={"CI": "1"}, _in="text for stdin")
p = sh.wc("-l", _in=sh.grep("-F", x, "f.log"))   # _in=<another call> is a real OS pipe
files = glob("src/*.ts")                     # host-side glob, returns paths
r.exit_code; r.stdout; r.stderr              # str
\`\`\``,
    plumbum: `### Shape "plumbum" (Python): plumbum's shape
\`\`\`python
from ml.sh.plumbum import local, glob
git = local["git"]
code, out, err = git["diff", "--stat", "HEAD~1"].run()           # never raises on a non-zero exit
code, out, err = local["npm"]["test"].with_cwd("repo").with_env(CI="1").run()
code, out, err = (local["grep"]["-F", x, "f.log"] | local["wc"]["-l"]).run()   # | between commands is a real OS pipe
code, out, err = (local["wc"]["-l"] << "text for stdin").run()
files = glob("src/*.ts")                                          # host-side glob, returns paths
\`\`\``,
    subprocess: `### Shape "subprocess" (Python): a subprocess shim
\`\`\`python
import subprocess
from ml.sh import glob
r = subprocess.run(["git", "diff", "--stat", "HEAD~1"], capture_output=True, text=True, cwd="repo", env={"CI": "1"}, input="text")
r.returncode; r.stdout; r.stderr
files = glob("src/*.ts")      # host-side glob, returns paths
\`\`\`
\`shell=True\` and a command given as one string are refused. There is no OS pipe: to pipe, pass one result's stdout as the next call's \`input=\`. \`env\` is ADDED to the host's environment.`,
};

const TASK_LIST = `The tasks. \`needle\` and \`ref\` are variables that already hold strings.
- T1. \`needle\` is text a person typed (it may contain spaces, quotes or a \`$\`). Count the lines of \`logs/app.log\` that contain it literally.
- T2. \`ref\` holds a git tag such as \`v1.2.0\`. List the names of the files changed between \`ref\` and HEAD.
- T3. Run \`npm test\` in the directory \`packages/api\` with the environment variable \`CI=1\`. Report whether it passed and the last 20 lines of its output.
- T4. List the files anywhere under \`data/\` larger than 10 MB, biggest first.
- T5. Count the total number of lines across all \`.ts\` files directly in \`src/\` (not its subfolders).
- T6. Print the 10 most frequent client IPs in \`logs/access.log\` (the first space-separated field of each line), with their counts.`;

const FORMAT = `Answer ONLY in text, and call no tools: \`ml.sh\` does not exist yet and we are designing it, so a call would fail and tell you nothing. For EACH task write one fenced code block whose first line is the comment \`// T1\` (JS) or \`# T1\` (Python), and so on to T6. Put the whole task in that block (more than one call is fine), and do the processing in programs rather than in JS/Python where you reasonably can. No prose between the blocks unless a task cannot be done in the shape; then say why in a comment inside its block.`;

const ORDER: ShapeKey[] = ["run", "execa", "template", "pysh", "plumbum", "subprocess"];

const shapeAsk = (k: ShapeKey): AskDef => ({
    ask: `Now write all six tasks again in shape "${k}" only (${SHAPES[k].name}). Here is its doc again:\n\n${DOCS[k]}\n\n${TASK_LIST}\n\n${FORMAT}`,
    expect: (t) => faults(t.answer, k).length === 0,
    why: `six blocks in ${SHAPES[k].name}, each parses, argv only (no sh -c/shell=True, no shell syntax in an argument or the template's static text, no command line as one string)`,
});

export default defineInterview({
    about: "SHELL.md's paper panel: which borrowed API shape for ml.sh (plain run, execa, the $ template, Python sh, plumbum, a subprocess shim) models write correctly, argv only, before any process host exists. Scored mechanically by shell-shapes.score.ts; nothing is run.",
    task: {
        ask: `We are designing \`ml.sh\`: running programs on the person's machine from inside your \`exec\` (JS) and \`python_exec\` (Python) tools. ${COMMON}\n\nThere are six API shapes, all for the same host:\n\n${ORDER.map((k) => DOCS[k]).join("\n\n")}\n\n${TASK_LIST}\n\nFirst, write each task in WHICHEVER shape you would naturally reach for (JS or Python, mixing is fine). ${FORMAT}`,
        expect: (t) => faults(t.answer).length === 0,
        why: "six blocks in any shape, each parses, argv only",
    },
    asks: [
        ...ORDER.map(shapeAsk),
        "Last, an honest review for the people building this. Which shape was most natural to write, and in which did you hesitate or have to work around the rules? Which of your own answers above would you now say are wrong (a refused call, a glob that would not expand, a pipe done wrong), and why? Which ONE or TWO shapes should ship, and what would you change in them? Be specific.",
    ],
});
