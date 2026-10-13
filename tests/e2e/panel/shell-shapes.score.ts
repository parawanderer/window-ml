// shell-shapes.score.ts — scores a model's written ml.sh calls mechanically: parses, uses the asked shape, stays argv.

import { spawnSync } from "node:child_process";
import * as acorn from "acorn";

/** The API shapes the interview asks for, by key. `lang` decides the parser. */
export const SHAPES = {
    run: { lang: "js", name: "plain ml.sh.run", uses: /\bml\.sh\.(?:run|pipe)\s*\(/ },
    execa: { lang: "js", name: "execa", uses: /\bexeca(?:Sync)?\s*\(/ },
    template: { lang: "js", name: "$ template", uses: /(?:^|[^\w$.])\$(?:\s*\([^)]*\))?\s*`/m },
    pysh: { lang: "py", name: "Python sh", uses: /\bsh\.[a-z_]\w*\s*[.(]|from\s+sh\s+import/ },
    plumbum: { lang: "py", name: "plumbum", uses: /plumbum|\blocal\s*\[/ },
    subprocess: { lang: "py", name: "subprocess shim", uses: /\bsubprocess\.(?:run|check_output|check_call|Popen|call)\s*\(/ },
} as const;
export type ShapeKey = keyof typeof SHAPES;

export const TASKS = [1, 2, 3, 4, 5, 6] as const;

/** One task's answer, scored. `clean` is the verdict; each flag says why not. */
export interface Scored {
    task: number;
    lang: "js" | "py" | null;
    present: boolean;
    parses: boolean;
    parseError?: string;
    /** which shapes the code calls (any number) */
    shapes: ShapeKey[];
    /** `sh -c`/`bash -c`, `shell: true`/`shell=True`, child_process, os.system/os.popen */
    shellEscape: string[];
    /** shell syntax as an argv element (`"|"`, `"&&"`, `"$(…)"`, `" | "` inside one) */
    metaInArgv: string[];
    /** a shell metacharacter or quote in a `$` template's static part */
    staticMeta: string[];
    /** a whole command line passed as one string where argv was meant (`execa("git diff --stat")`) */
    stringCommand: string[];
    /** a glob character in an argument no program or glob helper will expand (correctness, not safety) */
    literalGlob: string[];
    /** process launches, roughly: under per-call approval, each one asks */
    spawns: number;
    clean: boolean;
}

const PIPE_TOKENS = new Set(["|", "||", "&&", ";", ">", ">>", "<", "2>", "2>&1", "&>", "|&", "&"]);
const STATIC_META = /[|;&<>`\\'"*?~]|\$\(|\$\{|\$[A-Za-z_]/g;
/** A program that matches its own pattern argument, so a glob character there is meant (find -name, grep --include). */
const GLOB_OK_BEFORE = new Set(["-name", "-iname", "-path", "-ipath", "-wholename", "--include", "--exclude", "-g", "--glob", "--", "-e", "-E", "-P", "-regex", "-iregex"]);

/** The fenced code blocks of an answer, keyed by the `T<n>` tag on their first lines. */
export function blocksByTask(answer: string): Map<number, { lang: string; code: string }> {
    const out = new Map<number, { lang: string; code: string }>();
    for (const m of answer.matchAll(/```([\w+-]*)[^\n]*\n([\s\S]*?)```/g)) {
        const code = m[2];
        const head = code.split("\n").slice(0, 3).join("\n");
        const tag = head.match(/^\s*(?:\/\/|#)\s*\**T\s*([1-6])\b/m);
        if (tag && !out.has(Number(tag[1]))) out.set(Number(tag[1]), { lang: m[1].toLowerCase(), code });
    }
    return out;
}

function langOf(fence: string, code: string): "js" | "py" {
    if (/^(py|python|python3)$/.test(fence)) return "py";
    if (/^(js|javascript|ts|typescript|mjs)$/.test(fence)) return "js";
    return /^\s*#\s*T[1-6]/m.test(code) || /\bimport\s+\w+\s*$|^from\s+\w+\s+import/m.test(code) ? "py" : "js";
}

function strOf(n: any): string | null {
    if (n?.type === "Literal" && typeof n.value === "string") return n.value;
    if (n?.type === "TemplateLiteral" && n.expressions.length === 0) return n.quasis[0].value.cooked ?? null;
    return null;
}

/** The literal text of a string built from literals, templates and `+` (the dynamic parts as one space), else null. */
function staticText(n: any): string | null {
    if (strOf(n) != null) return strOf(n);
    if (n?.type === "TemplateLiteral") return n.quasis.map((q: any) => q.value.cooked ?? "").join(" ");
    if (n?.type === "BinaryExpression" && n.operator === "+") return `${staticText(n.left) ?? " "}${staticText(n.right) ?? " "}`;
    return null;
}

function walk(node: any, visit: (n: any, parent: any) => void, parent: any = null): void {
    if (!node || typeof node.type !== "string") return;
    visit(node, parent);
    for (const k of Object.keys(node)) {
        if (k === "loc" || k === "start" || k === "end") continue;
        const v = node[k];
        if (Array.isArray(v)) v.forEach((c) => walk(c, visit, node));
        else if (v && typeof v.type === "string") walk(v, visit, node);
    }
}

function calleeName(c: any): string {
    if (!c) return "";
    if (c.type === "Identifier") return c.name;
    if (c.type === "MemberExpression") return `${calleeName(c.object)}.${c.property?.name ?? strOf(c.property) ?? "?"}`;
    if (c.type === "CallExpression") return `${calleeName(c.callee)}()`;
    return "";
}

/** Checks a list of argv strings (in order) for shell syntax, sh -c, a command line in one string, and dead globs. */
function argvFindings(argv: (string | null)[], s: Scored, opts: { firstIsProgram: boolean; globHelper: boolean }): void {
    argv.forEach((a, i) => {
        if (a == null) return;
        if (PIPE_TOKENS.has(a.trim()) || /\$\(|`|\s\|\s|\s&&\s|\s>\s|\s2>&1/.test(a)) s.metaInArgv.push(a);
        const prev = argv[i - 1];
        if (/^(ba|z|da)?sh$|\/(ba|z)?sh$/.test(a) && (argv[i + 1] === "-c" || argv[i + 1] === "-lc")) s.shellEscape.push(`${a} ${argv[i + 1]}`);
        if (i === 0 && opts.firstIsProgram && /\s/.test(a.trim()) && !/^["']/.test(a)) s.stringCommand.push(a);
        if (/[*?]/.test(a) && !opts.globHelper && !(prev != null && GLOB_OK_BEFORE.has(prev)) && !/^--(include|exclude)=/.test(a)
            && !(i > 0 && /^(grep|egrep|rg|sed|awk|find)$/.test(argv[0] ?? "") && i === argv.findIndex((x) => x != null && !x.startsWith("-")) )) s.literalGlob.push(a);
    });
}

function scoreJs(code: string, s: Scored): void {
    let ast: any;
    try {
        ast = acorn.parse(code, { ecmaVersion: "latest", sourceType: "module", allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true });
    } catch (e: any) { s.parseError = String(e?.message ?? e); return; }
    s.parses = true;
    walk(ast, (n, parent) => {
        if (n.type === "ImportDeclaration" && /child_process/.test(n.source.value)) s.shellEscape.push(`import ${n.source.value}`);
        if (n.type === "CallExpression") {
            const name = calleeName(n.callee);
            const last = name.split(".").pop() ?? "";
            if (name === "require" && /child_process/.test(strOf(n.arguments[0]) ?? "")) s.shellEscape.push("require child_process");
            if (/^(execSync|exec|spawnSync|execFileSync)$/.test(name)) s.shellEscape.push(name);
            const globHelper = /glob/i.test(name) || /glob/i.test(calleeName(parent?.callee));
            // execa("git", [..]) / execaSync / .pipe("b", [..]): a program then an argv array
            if (/^(execa|execaSync)$/.test(last) || (last === "pipe" && strOf(n.arguments[0]) != null)) {
                s.spawns++;
                const prog = strOf(n.arguments[0]);
                const whole = prog == null ? staticText(n.arguments[0]) : null;
                if (whole != null && /\S\s+\S|\S\s+$/.test(whole)) s.stringCommand.push(whole);
                const arr = n.arguments[1]?.type === "ArrayExpression" ? n.arguments[1].elements.map(strOf) : [];
                argvFindings([prog, ...arr], s, { firstIsProgram: true, globHelper });
            }
            // ml.sh.run([..]) / run("..."), and pipe([..], [..])
            if (/(^|\.)sh\.run$/.test(name) || (/(^|\.)sh\.pipe$/.test(name))) {
                for (const a of n.arguments) {
                    if (a?.type === "ArrayExpression") { s.spawns++; argvFindings(a.elements.map(strOf), s, { firstIsProgram: true, globHelper: false }); }
                    else if (a?.type !== "ObjectExpression" && staticText(a) != null && /\S\s/.test(staticText(a)!)) { s.spawns++; s.stringCommand.push(staticText(a)!); }
                }
            }
            for (const a of n.arguments) if (a?.type === "ObjectExpression") for (const p of a.properties)
                if ((p.key?.name ?? strOf(p.key)) === "shell" && !(p.value?.type === "Literal" && p.value.value === false)) s.shellEscape.push("shell: true");
        }
        if (n.type === "TaggedTemplateExpression") {
            const tag = calleeName(n.tag);
            if (/^\$(\(\))?$|\.pipe$|^\$\.\w+$/.test(tag) || (n.tag.type === "CallExpression" && calleeName(n.tag.callee) === "$")) {
                s.spawns++;
                const statics = n.quasi.quasis.map((q: any) => q.value.cooked ?? q.value.raw);
                for (const st of statics) for (const m of st.matchAll(STATIC_META)) s.staticMeta.push(m[0]);
                const words = statics.join(" \u0000 ").trim().split(/\s+/);
                if (/^(ba|z)?sh$/.test(words[0]) && words[1] === "-c") s.shellEscape.push(`${words[0]} -c`);
            }
        }
    });
    s.staticMeta = [...new Set(s.staticMeta)];
}

const PY_DUMP = String.raw`
import ast, json, sys
src = sys.stdin.read()
try:
    tree = ast.parse(src)
except SyntaxError as e:
    print(json.dumps({"ok": False, "error": f"{e.msg} (line {e.lineno})"})); sys.exit(0)
def name(n):
    if isinstance(n, ast.Name): return n.id
    if isinstance(n, ast.Attribute): return name(n.value) + "." + n.attr
    if isinstance(n, ast.Subscript): return name(n.value) + "[]"
    if isinstance(n, ast.Call): return name(n.func) + "()"
    return "?"
def s(n):
    if isinstance(n, ast.Constant) and isinstance(n.value, str): return n.value
    return None
def elts(n):
    if isinstance(n, (ast.List, ast.Tuple)): return [s(e) for e in n.elts]
    return None
calls, subs, imports = [], [], []
for n in ast.walk(tree):
    if isinstance(n, ast.Call):
        kw = {}
        for k in n.keywords:
            if k.arg is None: continue
            v = k.value
            kw[k.arg] = (v.value if isinstance(v, ast.Constant) and isinstance(v.value, (bool, int, float, str, type(None))) else "<expr>")
        calls.append({"name": name(n.func), "args": [s(a) for a in n.args], "list0": elts(n.args[0]) if n.args else None, "kw": kw})
    if isinstance(n, ast.Subscript):
        sl = n.slice
        subs.append({"name": name(n.value), "args": elts(sl) if isinstance(sl, ast.Tuple) else [s(sl)]})
    if isinstance(n, ast.Import): imports += [a.name for a in n.names]
    if isinstance(n, ast.ImportFrom): imports.append(n.module or "")
print(json.dumps({"ok": True, "calls": calls, "subs": subs, "imports": imports}))
`;

function scorePy(code: string, s: Scored): void {
    const r = spawnSync("python3", ["-I", "-c", PY_DUMP], { input: code, encoding: "utf8", timeout: 10_000 });
    let d: any;
    try { d = JSON.parse(r.stdout); } catch { s.parseError = `python3 failed: ${r.stderr.slice(0, 200)}`; return; }
    if (!d.ok) { s.parseError = d.error; return; }
    s.parses = true;
    if (d.imports.some((i: string) => /^(os|commands)$/.test(i)) && d.calls.some((c: any) => /^os\.(system|popen)$/.test(c.name))) s.shellEscape.push("os.system/popen");
    for (const c of d.calls) {
        const last = c.name.split(".").pop();
        const globHelper = /glob/i.test(c.name);
        if (c.kw.shell === true || c.kw.shell === "<expr>") s.shellEscape.push("shell=True");
        if (/^subprocess\.(run|check_output|check_call|Popen|call)$/.test(c.name)) {
            s.spawns++;
            if (c.list0) argvFindings(c.list0, s, { firstIsProgram: true, globHelper: false });
            else if (typeof c.args[0] === "string") s.stringCommand.push(c.args[0]);
        } else if (/^sh\.[a-zA-Z_]\w*(\.[a-zA-Z_]\w*)*$/.test(c.name) && !/^sh\.(glob|Command|ErrorReturnCode\w*|contrib)/.test(c.name) && !c.name.startsWith("sh.ml")) {
            // sh.git.diff("HEAD~1", stat=True): program and subcommands are attribute names, args follow
            s.spawns++;
            const parts = c.name.split(".").slice(1);
            argvFindings([...parts, ...c.args], s, { firstIsProgram: false, globHelper: false });
            if (/^(ba|z)?sh$/.test(parts[0]) && c.args[0] === "-c") s.shellEscape.push(`sh.${parts[0]}("-c")`);
        } else if (last === "glob" || globHelper) {
            // a glob helper takes a pattern on purpose
        }
    }
    for (const sb of d.subs) {
        // plumbum: local["git"]["diff", "--stat"], git["diff", ...]
        if (/^local(\[\])?$/.test(sb.name) || /\[\]$/.test(sb.name) || /^[a-z_]\w*$/.test(sb.name)) {
            const args = sb.args ?? [];
            if (sb.name === "local") { if (/^(ba|z)?sh$/.test(args[0] ?? "")) s.shellEscape.push(`local["${args[0]}"]`); continue; }
            argvFindings(["<prog>", ...args], s, { firstIsProgram: false, globHelper: false });
            if (args[0] === "-c" && /sh/.test(sb.name)) s.shellEscape.push(`${sb.name}["-c"]`);
        }
    }
}

/** Scores one task's code. Absent code is scored as missing, not clean. */
export function scoreTask(task: number, block: { lang: string; code: string } | undefined): Scored {
    const s: Scored = { task, lang: null, present: !!block, parses: false, shapes: [], shellEscape: [], metaInArgv: [], staticMeta: [], stringCommand: [], literalGlob: [], spawns: 0, clean: false };
    if (!block) return s;
    s.lang = langOf(block.lang, block.code);
    (s.lang === "py" ? scorePy : scoreJs)(block.code, s);
    s.shapes = (Object.keys(SHAPES) as ShapeKey[]).filter((k) => SHAPES[k].lang === s.lang && SHAPES[k].uses.test(block.code));
    s.clean = s.parses && s.shapes.length > 0 && !s.shellEscape.length && !s.metaInArgv.length && !s.staticMeta.length && !s.stringCommand.length;
    return s;
}

/** Scores every task of one answer. */
export function scoreAnswer(answer: string): Scored[] {
    const blocks = blocksByTask(answer);
    return TASKS.map((t) => scoreTask(t, blocks.get(t)));
}

/** The tasks of an answer that are not clean, or not in `shape` when one was asked for, each with why. */
export function faults(answer: string, shape?: ShapeKey): string[] {
    return scoreAnswer(answer).flatMap((s) => {
        const why = [
            !s.present && "missing",
            s.present && !s.parses && `does not parse (${s.parseError})`,
            s.parses && !s.shapes.length && "uses none of the shapes",
            shape && s.parses && s.shapes.length && !s.shapes.includes(shape) && `not in ${SHAPES[shape].name}`,
            s.shellEscape.length && `shell escape: ${s.shellEscape.join(", ")}`,
            s.metaInArgv.length && `shell syntax in argv: ${s.metaInArgv.map((x) => JSON.stringify(x)).join(", ")}`,
            s.staticMeta.length && `metacharacter in template: ${s.staticMeta.map((x) => JSON.stringify(x)).join(" ")}`,
            s.stringCommand.length && `command line as one string: ${s.stringCommand.map((x) => JSON.stringify(x)).join(", ")}`,
        ].filter(Boolean) as string[];
        return why.length ? [`T${s.task}: ${why.join("; ")}`] : [];
    });
}
