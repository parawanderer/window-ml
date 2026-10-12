// check-memory.mjs — checks Claude Code's memory folder for this checkout keeps its hierarchical index intact.
//
//   node scripts/check-memory.mjs          # print errors and warnings; exits 0 always
//   node scripts/check-memory.mjs --hook   # the Claude Code PostToolUse hook (.claude/settings.json): reads the tool
//                                          # call on stdin, and only when it touched the memory folder (a Write/Edit
//                                          # into it, or a Bash command naming it) exits 2 with the errors on stderr,
//                                          # so the session that wrote the memory hears about it at once
//   node scripts/check-memory.mjs --dir <path>   # check another folder (WML_MEMORY_DIR does the same)
//
// The memory is not in the repo: it lives in `~/.claude/projects/<checkout path, non-alphanumerics as dashes>/memory/`
// on the machine that runs the harness. CI never sees it, and the format is the harness's, so the check is a harness
// hook rather than a git hook or a CI job. No folder (a clone that never wrote one) is silence, not an error.
//
// The shape it holds: `MEMORY.md` is loaded into every session and is cut off past 200 lines, so it lists only a few
// read-first memories and one HUB per topic (`topic-<name>.md`). Every other memory carries `  topics: a, b` under
// `metadata:` and is found by the command in its hub. A memory without topics is invisible to every session.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

/** The line count past which Claude Code truncates MEMORY.md. */
export const INDEX_LINES = 200;

/**
 * Finds the memory folder Claude Code uses for a checkout, from its absolute path.
 * @param {string} root the checkout's top-level directory
 * @param {Record<string,string|undefined>} env
 * @param {string} home
 * @returns {string}
 */
export function memoryDir(root, env = process.env, home = homedir()) {
    if (env.WML_MEMORY_DIR) return env.WML_MEMORY_DIR;
    const config = env.CLAUDE_CONFIG_DIR || join(home, ".claude");
    return join(config, "projects", root.replace(/[^A-Za-z0-9]/g, "-"), "memory");
}

/**
 * Reads one memory file's frontmatter: name, description and topics.
 * @param {string} text
 * @returns {{ name?: string, description?: string, topics?: string[], hasMetadata: boolean } | null} null without frontmatter
 */
export function frontmatter(text) {
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    if (!m) return null;
    const out = { hasMetadata: false };
    for (const line of m[1].split(/\r?\n/)) {
        const kv = /^(name|description):\s*(.*)$/.exec(line);
        if (kv) out[kv[1]] = kv[2].trim();
        if (/^metadata:/.test(line)) out.hasMetadata = true;
        const t = /^\s+topics:\s*(.*)$/.exec(line);
        if (t) out.topics = t[1].split(",").map(s => s.trim()).filter(Boolean);
    }
    return out;
}

/**
 * Checks a memory folder's files against the hierarchical-index shape.
 * @param {Map<string,string>} files file name (`x.md`) to its text; non-Markdown files are ignored
 * @returns {{ errors: string[], warnings: string[] }}
 */
export function checkMemory(files) {
    const errors = [], warnings = [];
    const index = files.get("MEMORY.md");
    if (index === undefined) return { errors: ["MEMORY.md is missing: no session sees any memory"], warnings };

    const lines = index.split(/\r?\n/).length;
    if (lines > INDEX_LINES) errors.push(`MEMORY.md is ${lines} lines; Claude Code cuts it off at ${INDEX_LINES}. List hubs, not memories.`);

    const linked = new Set();
    for (const [, target] of index.matchAll(/\]\(([^)\s]+\.md)\)/g)) {
        linked.add(target);
        if (!files.has(target)) errors.push(`MEMORY.md links ${target}, which does not exist`);
    }

    const hubs = new Set([...files.keys()].filter(f => /^topic-.+\.md$/.test(f)).map(f => f.slice(6, -3)));
    for (const hub of hubs) {
        if (!linked.has(`topic-${hub}.md`)) errors.push(`hub topic-${hub}.md is not linked from MEMORY.md, so no session finds it`);
    }

    const used = new Map();
    for (const [file, text] of files) {
        if (!file.endsWith(".md") || file === "MEMORY.md") continue;
        const fm = frontmatter(text);
        if (!fm) { errors.push(`${file}: no frontmatter`); continue; }
        if (fm.name && fm.name !== file.slice(0, -3)) warnings.push(`${file}: name "${fm.name}" differs from the file name`);
        if (!fm.description) errors.push(`${file}: no description, so the topic listing shows nothing for it`);
        if (hubs.has(file.slice(6, -3)) && file.startsWith("topic-")) continue;
        if (!fm.topics?.length) {
            errors.push(`${file}: no \`  topics:\` under metadata:, so no hub lists it (add one or more existing topics)`);
            continue;
        }
        for (const t of fm.topics) {
            if (!hubs.has(t)) errors.push(`${file}: topic "${t}" has no hub (topic-${t}.md); use an existing topic or add the hub and its MEMORY.md line`);
            used.set(t, (used.get(t) ?? 0) + 1);
        }
    }
    for (const hub of hubs) if (!used.has(hub)) warnings.push(`hub topic-${hub}.md has no memories tagged "${hub}"`);
    return { errors, warnings };
}

/**
 * Whether a hook's tool call touched the memory folder: a file tool writing inside it, or a shell command naming it.
 * @param {{ tool_name?: string, tool_input?: { file_path?: unknown, command?: unknown } }} call
 * @param {string} dir the memory folder, absolute
 */
export function touchesMemory(call, dir) {
    const path = call?.tool_input?.file_path;
    if (typeof path === "string") return resolve(path).startsWith(dir + sep);
    const command = call?.tool_input?.command;
    if (typeof command !== "string") return false;
    const projects = dir.replace(/\/memory\/?$/, "");
    return command.includes(dir) || command.includes(projects.slice(projects.lastIndexOf("/projects/")));
}

/** Reads every Markdown file in a folder into the map `checkMemory` takes. */
function readFolder(dir) {
    const files = new Map();
    for (const f of readdirSync(dir)) if (f.endsWith(".md")) files.set(f, readFileSync(join(dir, f), "utf8"));
    return files;
}

function checkoutRoot() {
    try {
        return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
        return process.cwd();
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const args = process.argv.slice(2);
    const at = args.indexOf("--dir");
    const dir = resolve(at >= 0 ? args[at + 1] : memoryDir(process.env.CLAUDE_PROJECT_DIR || checkoutRoot()));
    const hook = args.includes("--hook");

    if (hook) {
        let call = {};
        try { call = JSON.parse(readFileSync(0, "utf8")); } catch { process.exit(0); }
        if (!touchesMemory(call, dir)) process.exit(0);
    }
    if (!existsSync(join(dir, "MEMORY.md"))) process.exit(0);

    const { errors, warnings } = checkMemory(readFolder(dir));
    if (hook) {
        if (errors.length) {
            console.error(`The memory index at ${dir} is broken (see MEMORY.md's header for the convention):\n` +
                errors.map(e => `  - ${e}`).join("\n"));
            process.exit(2);
        }
        process.exit(0);
    }
    for (const e of errors) console.log(`  ✗ memory: ${e}`);
    for (const w of warnings) console.log(`  ⚠ memory: ${w}`);
}
