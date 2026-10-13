#!/usr/bin/env node
// check-tools.mjs — holds the builtin tool registry (src/tools/tool-registry.ts) and the tool factories together: every
// builtin factory is declared with `defineBuiltinTool`, and every declaration names the files that really hold its
// factory.
//
//   node scripts/check-tools.mjs            # check; exits 1 on a mismatch (the hook and CI run this)
//   node scripts/check-tools.mjs --staged   # the same, over what is staged (the pre-commit hook)
//   node scripts/check-tools.mjs --list     # every builtin: its factories, as found and as declared
//
// WHY. The gate (`GATED_TOOL_NAMES`), the pointers (`CITABLE_TOOLS`), the worker's routing (`WORKER_TOOL_NAMES`) and
// the start card's "is this one of ours" all read the registry. A builtin added with a factory and no declaration is
// none of those things: not gated by the worker, not citable, and shown on the start card as the SITE's own tool. A
// declaration with no factory is a name a site's tool can take to be treated as ours.
//
// WHAT COUNTS AS A FACTORY: an object literal whose FIRST key is `name`, given as a string or a constant
// (`name: DEREF_TOOL`; a lower-case variable is a tool built at run time, a server tool, and not a builtin), that also
// has a `description`, opening right after a `(` or a `return` — the shape of
// `defineTool({ name: "exec", … })` and of a tool returned as a plain object (`chat_metadata`). Comments and strings are
// stripped first (js-scan.mjs), so a commented-out tool is not one. Looked for in the worker, page and offscreen code:
// src/ except the UI realms and the hub, which define no agent tools.
//
// The check is complete, not a ratchet: it held from the commit that added it, so any mismatch is new.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { scan } from "./js-scan.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
/** Where the registry lives. */
export const REGISTRY = "src/tools/tool-registry.ts";
/** Not where an agent tool is defined: the UI realms, the hub client, generated and declaration-only files. */
const SKIP = /^src\/(sidebar|chat|native|hub)\/|\.gen\.ts$|\.d\.ts$/;

/** The text between the `{` at `open` and its matching `}`. */
function objectAt(code, open) {
    let depth = 0;
    for (let i = open; i < code.length; i++) {
        const c = code[i];
        if (c === "{") depth++;
        else if (c === "}" && --depth === 0) return code.slice(open + 1, i);
    }
    return code.slice(open + 1);
}

/**
 * The string constants a file defines (`const DEREF_TOOL = "dereference"`), so a factory naming its tool by one is read.
 * @param {string} text the source
 * @returns {Map<string, string>}
 */
export function constantsIn(text) {
    const { code, strings } = scan(text);
    const out = new Map();
    for (const m of code.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*\0(\d+)\0\s*;/g)) {
        const v = strings[+m[2]]?.value;
        if (v != null) out.set(m[1], v);
    }
    return out;
}

/**
 * The tool factories in one file's text.
 * @param {string} text the source
 * @param {Map<string, string>} constants string constants by name, for `name: SOME_CONST`
 * @returns {{ name: string|null, ref: string, line: number }[]} `name` null when a constant could not be resolved
 */
export function factoriesIn(text, constants = new Map()) {
    if (!/\bname\s*:/.test(text) || !/\bdescription\s*:/.test(text)) return [];
    const { code, strings } = scan(text);
    const out = [];
    for (const m of code.matchAll(/(?:\(|\breturn)\s*(\{)\s*name\s*:\s*(?:\0(\d+)\0|([A-Z][A-Z0-9_]*))\s*,/g)) {
        const open = m.index + m[0].indexOf("{");
        if (!/(^|[,{\s])description\s*:/.test(objectAt(code, open))) continue;
        const ref = m[2] != null ? JSON.stringify(strings[+m[2]]?.value) : m[3];
        const name = m[2] != null ? strings[+m[2]]?.value ?? null : constants.get(m[3]) ?? null;
        out.push({ name, ref, line: code.slice(0, open).split("\n").length });
    }
    return out;
}

/**
 * The `defineBuiltinTool` declarations in the registry's text.
 * @param {string} text the registry's source
 * @returns {{ name: string|null, factories: string[]|null, line: number }[]} a field that is not written as literals
 *   comes back null, which the check reports
 */
export function declarationsIn(text) {
    const { code, strings } = scan(text);
    const out = [];
    for (const m of code.matchAll(/\bdefineBuiltinTool\s*\(\s*\{/g)) {
        const open = m.index + m[0].length - 1;
        const body = objectAt(code, open);
        const n = /(^|[,{\s])name\s*:\s*\0(\d+)\0/.exec(body);
        const f = /(^|[,{\s])factories\s*:\s*\[([^\]]*)\]/.exec(body);
        const files = f ? [...f[2].matchAll(/\0(\d+)\0/g)].map((x) => strings[+x[1]]?.value) : null;
        out.push({
            name: n ? strings[+n[2]]?.value ?? null : null,
            factories: files && files.length && files.every((x) => typeof x === "string") && !f[2].replace(/\0\d+\0|[\s,]/g, "") ? files : null,
            line: code.slice(0, open).split("\n").length,
        });
    }
    return out;
}

/**
 * Every disagreement between the factories and the registry.
 * @param {{ rel: string, text: string }[]} files the sources to search for factories (the registry among them)
 * @returns {{ problems: string[], found: Map<string, Set<string>>, declared: Map<string, string[]> }}
 */
export function checkTools(files) {
    // Only the files that could define a constant some factory names are scanned for it: a scan is the slow part.
    const refs = new Set(files.flatMap((f) => [...f.text.matchAll(/\bname\s*:\s*([A-Z][A-Z0-9_]*)\s*,/g)].map((m) => m[1])));
    const constants = new Map();
    for (const f of files) {
        if (![...refs].some((r) => f.text.includes(`const ${r}`))) continue;
        for (const [k, v] of constantsIn(f.text)) if (!constants.has(k)) constants.set(k, v);
    }
    const problems = [];
    /** name → the files a factory for it was found in */
    const found = new Map();
    for (const { rel, text } of files) {
        if (rel === REGISTRY) continue;
        for (const fx of factoriesIn(text, constants)) {
            if (fx.name == null) { problems.push(`${rel}:${fx.line}\ta tool factory names its tool by ${fx.ref}, which is not a string constant this check can read`); continue; }
            if (!found.has(fx.name)) found.set(fx.name, new Set());
            found.get(fx.name).add(rel);
        }
    }
    const registry = files.find((f) => f.rel === REGISTRY);
    if (!registry) return { problems: [...problems, `${REGISTRY} is missing`], found, declared: new Map() };
    const declared = new Map();
    for (const d of declarationsIn(registry.text)) {
        const at = `${REGISTRY}:${d.line}`;
        if (d.name == null || d.factories == null) { problems.push(`${at}\twrite name and factories as string literals, so this check can read them`); continue; }
        if (declared.has(d.name)) { problems.push(`${at}\t${d.name} is declared twice`); continue; }
        declared.set(d.name, d.factories);
    }
    for (const [name, where] of found) {
        const decl = declared.get(name);
        if (!decl) { problems.push(`${[...where][0]}\t${name}: a builtin tool factory with no defineBuiltinTool declaration in ${REGISTRY}`); continue; }
        for (const rel of where) if (!decl.includes(rel)) problems.push(`${rel}\t${name}: a factory here, but its declaration does not list this file`);
    }
    for (const [name, decl] of declared) {
        const where = found.get(name);
        if (!where) { problems.push(`${REGISTRY}\t${name}: declared, but no factory for it exists anywhere`); continue; }
        for (const rel of decl) if (!where.has(rel)) problems.push(`${REGISTRY}\t${name}: declared with a factory in ${rel}, which has none`);
    }
    return { problems, found, declared };
}

/** Every source file a factory may live in, repo-relative. */
function sources() {
    const out = [];
    const walk = (dir) => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) { walk(full); continue; }
            const rel = path.relative(ROOT, full).split(path.sep).join("/");
            if (/\.tsx?$/.test(e.name) && !SKIP.test(rel)) out.push(rel);
        }
    };
    walk(path.join(ROOT, "src"));
    return out.sort();
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const staged = process.argv.includes("--staged");
    const git = (args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20 });
    const rels = staged ? git(["ls-files", "--cached", "--", "src"]).split("\n").filter((r) => /\.tsx?$/.test(r) && !SKIP.test(r)) : sources();
    // A file whose working copy differs from the index is read from the index; every other one from disk, which is the same.
    const dirty = staged ? new Set(git(["diff", "--name-only", "--", "src"]).split("\n")) : new Set();
    const files = rels.map((rel) => ({ rel, text: dirty.has(rel) ? git(["show", `:${rel}`]) : readFileSync(path.join(ROOT, rel), "utf8") }));
    const { problems, found, declared } = checkTools(files);
    if (process.argv.includes("--list")) {
        for (const name of [...new Set([...declared.keys(), ...found.keys()])].sort())
            console.log(`${name}\tfound: ${[...(found.get(name) ?? [])].join(", ") || "-"}\tdeclared: ${(declared.get(name) ?? []).join(", ") || "-"}`);
        console.log("");
    }
    if (problems.length) {
        for (const p of problems) console.log(p);
        console.error(`\n${problems.length} disagreement(s) between the builtin tool factories and ${REGISTRY}. A builtin that is`
            + " not declared is treated as the SITE's own tool: not gated by the worker, not citable, and shown on the start card"
            + " as the site's. Declare it with defineBuiltinTool, naming the file its factory is in.");
        process.exit(1);
    }
    console.log(`check-tools: ${declared.size} builtin tools, each declared and each with its factory.`);
}
