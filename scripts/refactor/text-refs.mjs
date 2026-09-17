// Places that name a source file as a STRING — `readFileSync("src/sidebar/settings.tsx")`, `join(ROOT, "src",
// "contract.ts")` — which no compiler follows. Moving code out of such a file can leave a generator reading the
// wrong place, or a test asserting `doesNotMatch` against a file the code no longer lives in, which passes forever.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const TEXT = /\.(m?[jt]sx?|cjs|json|ya?ml|sh|html|md)$/;

/** Tracked files (or, outside git, every file bar the usual build output), root-relative. @param {string} root */
function candidates(root) {
    try {
        return execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n").filter(Boolean);
    } catch {
        const out = [];
        const walk = (dir) => {
            for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
                if (["node_modules", "dist", ".git"].includes(e.name)) continue;
                const rel = dir ? `${dir}/${e.name}` : e.name;
                if (e.isDirectory()) walk(rel); else out.push(rel);
            }
        };
        walk("");
        return out;
    }
}

/**
 * @param {string} root @param {string} fromRel root-relative path of the file code moves OUT of
 * @param {Set<string>} moved names being moved
 * @returns {{ file: string, line: number, text: string, kind: "code"|"entry"|"doc" }[]}
 */
export function textReferences(root, fromRel, moved) {
    const base = path.basename(fromRel);
    const esc = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const literal = new RegExp(`(["'\`])((?:[^"'\`\\n]*/)?${esc})\\1`, "g");
    const bare = new RegExp(`(^|[^\\w./-])((?:[\\w.-]+/)*${esc})(?![\\w.-])`, "g");
    const specifier = /(\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s*)$/;
    const names = [...moved];
    const out = [];
    for (const rel of candidates(root)) {
        if (rel === fromRel || !TEXT.test(rel)) continue;
        let text;
        try { text = fs.readFileSync(path.join(root, rel), "utf8"); } catch { continue; }
        if (!text.includes(base)) continue;
        const isDoc = rel.endsWith(".md");
        text.split("\n").forEach((line, i) => {
            if (!line.includes(base)) return;
            if (isDoc) {
                // A doc line matters when it says a moved thing lives in this file.
                for (const m of line.matchAll(bare)) {
                    if (!pathMatches(fromRel, m[2])) continue;
                    if (names.some((n) => new RegExp(`\\b${n}\\b`).test(line))) out.push({ file: rel, line: i + 1, text: line.trim(), kind: "doc" });
                    return;
                }
                return;
            }
            for (const m of line.matchAll(literal)) {
                if (specifier.test(line.slice(0, m.index))) continue;          // an import the compiler already rewrote
                if (!pathMatches(fromRel, m[2])) continue;
                out.push({ file: rel, line: i + 1, text: line.trim(), kind: rel === "build.mjs" ? "entry" : "code" });
                return;
            }
        });
    }
    return out;
}

/** Could this string name that file? Its trailing path segments must agree. @param {string} fromRel @param {string} s */
function pathMatches(fromRel, s) {
    const segs = s.split("/").filter((x) => x && x !== "." && x !== "..");
    const want = fromRel.split("/");
    return segs.every((seg, i) => want[want.length - segs.length + i] === seg);
}
