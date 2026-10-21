// policy-proposals.score.ts — scores a model's written policies: extracted, lifted by the policy tree's lifter, right on hand-labelled calls.

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { liftPolicy, type LiftConsumer } from "../../../src/readonly-exec/policy-lift";
import { evalPolicy } from "../../../src/readonly-exec/policy-realm";
import { fetchFacts } from "../../../src/sw/sw-policies";
import { shFacts } from "../../../src/shell/sh-call";

/**
 * The measurement of docs/plan/repl/LANE_11_POLICY_TREE_DESIGN.md over MODEL-written policies (ruled #924): each need
 * below is asked of a model, its answer is one `(c) => …` block, and the covered fraction is lifted / extracted. A
 * vector is one call's facts as the product builds them (`fetchFacts`, `shFacts` over a host's resolution) with the
 * answer the need asks for: `true` when the policy must hold (an allow that lets it run, a deny that refuses it). Only
 * calls whose answer the need's words settle are vectors; one a careful reader could argue either way is left out.
 */

/** One hand-labelled call: what it is (shown in misses), its facts, and whether the policy must hold on it. */
export interface Vector { name: string; facts: Record<string, unknown>; holds: boolean }

/** One need: what the model is asked for, as which effect, and the calls that check its answer. */
export interface Need { id: string; effect: "allow" | "deny"; text: string; vectors: Vector[] }

// --- fetch: the calls, as fetchFacts builds them ---

const get = (url: string, holds: boolean, opts: { credentials?: boolean } = {}): Vector =>
    ({ name: `${opts.credentials ? "with credentials " : ""}${url}`, facts: fetchFacts(url, opts), holds });

export const FETCH_NEEDS: Need[] = [
    {
        id: "F1", effect: "allow",
        text: "Let the run read pages on docs.python.org without asking, but only without the person's cookies (no credentials).",
        vectors: [
            get("https://docs.python.org/3/library/os.html", true),
            get("https://docs.python.org/", true),
            get("https://docs.python.org/3/library/os.html", false, { credentials: true }),
            get("https://docs.python.org.evil.example/3/", false),
            get("https://evil.example/docs.python.org/", false),
            get("https://evil.example/?u=https://docs.python.org/", false),
            get("https://python.org/", false),
            get("https://wiki.python.org/moin/", false),
            get("https://evildocs.python.org/", false),
            get("https://docs.python.org.example/", false),
        ],
    },
    {
        id: "F2", effect: "allow",
        text: "Let the run read raw files from any repository of the GitHub organisation acme without asking: every URL under https://raw.githubusercontent.com/acme/, over https only.",
        vectors: [
            get("https://raw.githubusercontent.com/acme/widgets/main/README.md", true),
            get("https://raw.githubusercontent.com/acme/tools/v1.2/src/index.js", true),
            get("https://raw.githubusercontent.com/acmecorp/widgets/main/README.md", false),
            get("https://raw.githubusercontent.com/evil/acme/main/README.md", false),
            get("https://raw.githubusercontent.com/evil/x/main/acme/README.md", false),
            get("https://raw.githubusercontent.com.evil.example/acme/widgets/main/x", false),
            get("https://evil.example/raw.githubusercontent.com/acme/widgets/main/x", false),
            get("https://github.com/acme/widgets/blob/main/README.md", false),
            get("http://raw.githubusercontent.com/acme/widgets/main/README.md", false),
            get("https://gist.githubusercontent.com/acme/abc/raw/x", false),
        ],
    },
    {
        id: "F3", effect: "allow",
        text: "Let the run read Wikipedia in any language without asking: en.wikipedia.org, de.wikipedia.org, ja.wikipedia.org and every other language's site.",
        vectors: [
            get("https://en.wikipedia.org/wiki/Graph_theory", true),
            get("https://de.wikipedia.org/wiki/Graphentheorie", true),
            get("https://ja.wikipedia.org/wiki/グラフ理論", true),
            get("https://zh-yue.wikipedia.org/wiki/圖論", true),
            get("https://en.wikipedia.org.evil.example/wiki/X", false),
            get("https://enwikipedia.org/wiki/X", false),
            get("https://evilwikipedia.org/wiki/X", false),
            get("https://en.wikipedia.com/wiki/X", false),
            get("https://en.wiktionary.org/wiki/graph", false),
            get("https://evil.example/en.wikipedia.org/wiki/X", false),
        ],
    },
    {
        id: "F4", effect: "deny",
        text: "Refuse every fetch from pastebin.com and its subdomains without asking, and nothing else.",
        vectors: [
            get("https://pastebin.com/raw/abc123", true),
            get("https://pastebin.com/", true),
            get("https://www.pastebin.com/abc123", true),
            get("https://evilpastebin.com/abc123", false),
            get("https://pastebin.com.example.org/abc123", false),
            get("https://example.com/?u=pastebin.com", false),
            get("https://example.com/pastebin.com/abc123", false),
            get("https://docs.python.org/3/", false),
            get("https://pastebin.co/abc123", false),
        ],
    },
];

// --- sh: the calls, as shFacts builds them over a host's resolution ---

/** The workspace, which is the one root. */
export const ROOT = "/w/proj";
type PathOver = { path?: string; inRoot?: boolean; secret?: boolean; exists?: boolean; containsSecret?: boolean | null };
/** A path argument, resolved under the workspace unless `over` says otherwise. */
const at = (arg: number, given: string, over: PathOver = {}) => ({ arg, given, path: `${ROOT}/${given}`, inRoot: true, secret: false, exists: true, ...over });
/** An outside path. */
const outside = (arg: number, given: string, path: string) => at(arg, given, { path, inRoot: false });

/** One call's facts: `shFacts` over a host answer, git at a version its manifest describes, in a repository whose
 *  config runs nothing unless `repoConfigRunsCode` says otherwise. */
function call(argv: string[], paths: ReturnType<typeof at>[] = [], over: { cwd?: { path: string; inRoot: boolean }; repoConfigRunsCode?: boolean | null; secrets?: string[] } = {}): Record<string, unknown> {
    const git = argv[0] === "git";
    const host = {
        id: "v", argv, program: { path: `/usr/bin/${argv[0]}`, inRoot: false }, cwd: { path: ROOT, inRoot: true, containsSecret: false, ...over.cwd },
        env: { set: [], secrets: over.secrets ?? [], free: true }, repo: git ? { root: ROOT, reasons: [] } : null,
        repoConfigRunsCode: "repoConfigRunsCode" in over ? over.repoConfigRunsCode! : git ? false : null,
        paths, effects: "unknown" as const, mode: "host" as const, sandboxed: true, placement: "host-sandbox" as const, expiresInMs: 1,
    };
    return shFacts(host, git ? "2.45.0" : null, { roots: [ROOT] }) as unknown as Record<string, unknown>;
}
const sh = (name: string, holds: boolean, facts: Record<string, unknown>): Vector => ({ name, facts, holds });

const NOT_A_REPO = { repoConfigRunsCode: null };

export const SH_NEEDS: Need[] = [
    {
        id: "S1", effect: "allow",
        text: "Let the run execute the project's tests, `npm test` exactly (no other arguments), in the workspace /w/proj, without asking.",
        vectors: [
            sh("npm test", true, call(["npm", "test"])),
            sh("npm test in /w/proj/packages/api", true, call(["npm", "test"], [], { cwd: { path: `${ROOT}/packages/api`, inRoot: true } })),
            sh("npm install", false, call(["npm", "install"])),
            sh("npm test --foo", false, call(["npm", "test", "--foo"])),
            sh("npm run build", false, call(["npm", "run", "build"])),
            sh("npm testx", false, call(["npm", "testx"])),
            sh("npm", false, call(["npm"])),
            sh("npx test", false, call(["npx", "test"])),
            sh("npm test in /tmp/other (outside the workspace)", false, call(["npm", "test"], [], { cwd: { path: "/tmp/other", inRoot: false } })),
            sh("npm install test", false, call(["npm", "install", "test"])),
        ],
    },
    {
        id: "S2", effect: "allow",
        text: "Let any call that only READS files inside the workspace /w/proj run without asking, as long as it reads no secret file (such as .env). Anything that writes, deletes, runs another program, or does something the host cannot describe still asks.",
        vectors: [
            sh("cat README.md", true, call(["cat", "README.md"], [at(1, "README.md")])),
            sh("head -n 5 src/a.ts", true, call(["head", "-n", "5", "src/a.ts"], [at(3, "src/a.ts")])),
            sh("wc -l a.txt b.txt", true, call(["wc", "-l", "a.txt", "b.txt"], [at(2, "a.txt"), at(3, "b.txt")])),
            sh("ls src", true, call(["ls", "src"], [at(1, "src", { containsSecret: false })])),
            sh("cat .env (a secret)", false, call(["cat", ".env"], [at(1, ".env", { secret: true })])),
            sh("cat a.txt .env", false, call(["cat", "a.txt", ".env"], [at(1, "a.txt"), at(2, ".env", { secret: true })])),
            sh("cat /etc/passwd", false, call(["cat", "/etc/passwd"], [outside(1, "/etc/passwd", "/etc/passwd")])),
            sh("cat ../other/notes.txt", false, call(["cat", "../other/notes.txt"], [outside(1, "../other/notes.txt", "/w/other/notes.txt")])),
            sh("find src -name '*.tmp' -delete", false, call(["find", "src", "-name", "*.tmp", "-delete"], [at(1, "src", { containsSecret: false })])),
            sh("rm a.txt (no manifest)", false, call(["rm", "a.txt"], [at(1, "a.txt")])),
            sh("python3 x.py (no manifest)", false, call(["python3", "x.py"], [at(1, "x.py")])),
            sh("git diff --output=out.patch", false, call(["git", "diff", "--output=out.patch"], [at(2, "out.patch", { exists: false })])),
        ],
    },
    {
        id: "S3", effect: "allow",
        text: "Let git that only reads run without asking: `git status`, `git diff`, `git log` and `git show`, with any arguments that do not write a file or run another program, in a repository inside the workspace /w/proj. Never in a repository whose own config can run a program (the fact `repoConfigRunsCode` is true there, and null when the host could not tell).",
        vectors: [
            sh("git status", true, call(["git", "status"])),
            sh("git diff HEAD~1", true, call(["git", "diff", "HEAD~1"])),
            sh("git log --oneline -n 5", true, call(["git", "log", "--oneline", "-n", "5"])),
            sh("git show HEAD", true, call(["git", "show", "HEAD"])),
            sh("git status where repoConfigRunsCode is true", false, call(["git", "status"], [], { repoConfigRunsCode: true })),
            sh("git status where repoConfigRunsCode is null", false, call(["git", "status"], [], NOT_A_REPO)),
            sh("git diff --output=out.patch", false, call(["git", "diff", "--output=out.patch"], [at(2, "out.patch", { exists: false })])),
            sh("git diff --ext-diff", false, call(["git", "diff", "--ext-diff"])),
            sh("git commit -m x", false, call(["git", "commit", "-m", "x"])),
            sh("git push", false, call(["git", "push"])),
            sh("git status in /tmp/other (outside the workspace)", false, call(["git", "status"], [], { cwd: { path: "/tmp/other", inRoot: false } })),
            sh("cat README.md (not git)", false, call(["cat", "README.md"], [at(1, "README.md")])),
        ],
    },
    {
        id: "S4", effect: "deny",
        text: "Refuse, without asking, any call that deletes or renames a file or directory. Leave every other call alone.",
        vectors: [
            sh("rm a.txt", true, call(["rm", "a.txt"], [at(1, "a.txt")])),
            sh("rm -rf src", true, call(["rm", "-rf", "src"], [at(2, "src")])),
            sh("mv a.txt b.txt", true, call(["mv", "a.txt", "b.txt"], [at(1, "a.txt"), at(2, "b.txt", { exists: false })])),
            sh("find src -name '*.tmp' -delete", true, call(["find", "src", "-name", "*.tmp", "-delete"], [at(1, "src", { containsSecret: false })])),
            sh("git rm a.txt", true, call(["git", "rm", "a.txt"], [at(2, "a.txt")])),
            sh("git mv a.txt b.txt", true, call(["git", "mv", "a.txt", "b.txt"], [at(2, "a.txt"), at(3, "b.txt", { exists: false })])),
            sh("cat a.txt", false, call(["cat", "a.txt"], [at(1, "a.txt")])),
            sh("ls src", false, call(["ls", "src"], [at(1, "src", { containsSecret: false })])),
            sh("find src -name '*.tmp'", false, call(["find", "src", "-name", "*.tmp"], [at(1, "src", { containsSecret: false })])),
            sh("git status", false, call(["git", "status"])),
            sh("npm test", false, call(["npm", "test"])),
            sh("wc -l a.txt", false, call(["wc", "-l", "a.txt"], [at(2, "a.txt")])),
        ],
    },
];

export const NEEDS: Record<"fetch" | "sh", Need[]> = { fetch: FETCH_NEEDS, sh: SH_NEEDS };

// --- scoring one answer ---

/** The policy source an answer gives: the first fenced block holding an arrow function, else null (NOT EXTRACTED). */
export function extract(answer: string): string | null {
    for (const m of answer.matchAll(/```[\w+-]*[^\n]*\n([\s\S]*?)```/g)) {
        const src = m[1].trim().replace(/;\s*$/, "");
        if (src.includes("=>")) return src;
    }
    return null;
}

/** One answer, scored. `right` is meaningful only when `src` is set. */
export interface Scored {
    need: string;
    src: string | null;
    /** the lifter's reason when the source stays code */
    why?: string;
    lifted: boolean;
    /** the realm refused or threw on some vector: the policy is BROKEN there */
    broken: string[];
    /** vectors the policy answers wrongly (holds where it must not, or not where it must) */
    wrong: string[];
    right: boolean;
}

/** Score one answer to one need: extract, lift, then run the source in the real policy realm on every vector. */
export function scoreProposal(consumer: Exclude<LiftConsumer, "other">, need: Need, answer: string): Scored {
    const src = extract(answer);
    const s: Scored = { need: need.id, src, lifted: false, broken: [], wrong: [], right: false };
    if (src == null) return s;
    const lift = liftPolicy(src, consumer);
    s.lifted = !!lift.tree;
    if (!lift.tree) s.why = lift.why;
    for (const v of need.vectors) {
        const o = evalPolicy(src, v.facts, need.effect);
        if (o.broken) { s.broken.push(`${v.name}: ${o.broken}`); continue; }
        if ((o.decision === need.effect) !== v.holds) s.wrong.push(`${v.holds ? "misses" : "matches"} ${v.name}`);
    }
    s.right = !s.broken.length && !s.wrong.length;
    return s;
}

// --- a sweep, tabulated ---

/** Every run of a sweep: its interview, model, and the answer to each turn (turn n answers need n). */
function runsOf(sweep: string): { task: string; model: string; answers: Map<number, string> }[] {
    const out: { task: string; model: string; answers: Map<number, string> }[] = [];
    for (const task of readdirSync(sweep, { withFileTypes: true }).filter((d) => d.isDirectory() && /^policy-(fetch|sh)$/.test(d.name))) {
        for (const m of readdirSync(join(sweep, task.name), { withFileTypes: true }).filter((d) => d.isDirectory())) {
            for (const r of readdirSync(join(sweep, task.name, m.name)).filter((x) => /^r\d+$/.test(x))) {
                const dir = join(sweep, task.name, m.name, r);
                const cell = existsSync(join(dir, "cell.json")) ? JSON.parse(readFileSync(join(dir, "cell.json"), "utf8")) : null;
                const answers = new Map<number, string>();
                const outbox = join(dir, "outbox");
                if (existsSync(outbox)) for (const f of readdirSync(outbox)) {
                    const n = f.match(/^turn-(\d+)\.md$/);
                    if (n) answers.set(Number(n[1]), readFileSync(join(outbox, f), "utf8"));
                }
                out.push({ task: task.name, model: cell?.combo?.model ?? m.name, answers });
            }
        }
    }
    return out;
}

/** The tables of docs: per model extracted / lifted / right / broken / not extracted, then the lifter's misses grouped. */
export function report(sweep: string): string {
    const rows: string[] = [];
    const misses = new Map<string, string[]>();
    let ext = 0, lift = 0;
    for (const consumer of ["fetch", "sh"] as const) {
        rows.push(`\n### ${consumer}\n`, "| model | extracted | lifted | right | broken | not extracted |", "| --- | --- | --- | --- | --- | --- |");
        for (const run of runsOf(sweep).filter((r) => r.task === `policy-${consumer}`).sort((a, b) => a.model.localeCompare(b.model))) {
            const scored = NEEDS[consumer].map((need, i) => scoreProposal(consumer, need, run.answers.get(i + 1) ?? ""));
            const got = scored.filter((s) => s.src != null);
            ext += got.length; lift += got.filter((s) => s.lifted).length;
            for (const s of got.filter((x) => !x.lifted)) misses.set(s.why!, [...(misses.get(s.why!) ?? []), `${run.model} ${s.need}`]);
            const ids = (f: (s: Scored) => boolean) => scored.filter(f).map((s) => s.need).join(" ") || "-";
            rows.push(`| ${run.model} | ${got.length} | ${got.filter((s) => s.lifted).length} | ${got.filter((s) => s.right).length} | ${ids((s) => s.broken.length > 0)} | ${ids((s) => s.src == null)} |`);
        }
    }
    const whys = [...misses].sort((a, b) => b[1].length - a[1].length).map(([why, who]) => `- ${why} (${who.length}): ${who.join(", ")}`);
    return [`**Covered: ${lift} of ${ext} extracted proposals lift (${ext ? Math.round((100 * lift) / ext) : 0}%).**`, ...rows, "\n### Why a proposal stayed code\n", ...(whys.length ? whys : ["- none"])].join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
    if (!process.argv[2]) { console.error("usage: node --import tsx tests/e2e/panel/policy-proposals.score.ts <sweep dir>"); process.exit(2); }
    console.log(report(process.argv[2]));
}
