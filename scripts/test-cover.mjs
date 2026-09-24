#!/usr/bin/env node
// WHICH TESTS COVER THIS CODE — and the command that runs them.
//
//   node scripts/test-cover.mjs src/sidebar/services.ts       # the tests that reach this module
//   node scripts/test-cover.mjs --changed                     # …for everything this branch changed
//   node scripts/test-cover.mjs --changed --cmd               # just the commands, to paste
//   node scripts/test-cover.mjs src/chat/grants.ts --why      # …and the import chain that reaches it
//   node scripts/test-cover.mjs src/x.ts --all                # …naming the e2e specs that boot the whole build
//
// WHY IT EXISTS, from the failure it is named after. `scripts/test-index.mjs` made the tests FINDABLE, which is
// half the problem; this is the other half. Changing `canContinue` in the services seam, I ran `npm run test:chat`
// — which runs chat-web, chat-page and native-embed, and NOT `tests/e2e/cross-page.spec.mjs`, where the two
// acceptance tests for continuing a capped run actually live. Nothing connected the file I changed to the suite
// that covers it, so the verification I did was against the tests I happened to think of. It passed. That is the
// kind of thing that passes until it does not.
//
// HOW IT RESOLVES. Its own parse, not the compiler's program: the tests are `.mjs` and `.js` that pull source in
// with `await import("../src/chat/attention.ts")`, a STRING the language service does not follow from a JS file,
// and `tsconfig.tests.json` has two root files. So every specifier is read out of the AST — static `import`,
// `require`, and dynamic `import()` with a literal argument — and resolved by hand, which is exactly the set the
// tests use. A specifier built from a variable cannot be resolved and is skipped rather than guessed at.
//
// THE BUILD IS THE OTHER HALF, in two shapes. A test may name a BUNDLE FILE (`dist/sidebar-app.js`, which
// `tests/helpers.js` loads into a `node:vm` sandbox) — that is traced to the entry it was built from, which is how
// 407 sidebar tests come to cover the sidebar at all. Or it may name a build DIRECTORY (`dist`, `dist-web`) and
// hand it to a browser, which is every Playwright spec: no import edge reaches the source and none can, because
// the source arrives as a bundle the browser loads. Those are reported as their own group and counted rather than
// listed — they can notice ANY change, which as a list of thirty-one buries the tests that are actually about it.
//
// WHAT IT DOES NOT CLAIM. Reaching a module is not testing it: this answers "which suites could possibly notice
// this change", which is the question you need before choosing what to run, and not "is this line covered" — that
// is `npm run coverage`. It over-reports by design, because the cost of running one suite too many is a minute and
// the cost of running one too few is what this file is named after.

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname, resolve, relative, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { ts } = require("@ts-morph/common");
const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

/** Extensions a specifier may resolve to, in the order a bundler would try them. */
const EXTS = [".ts", ".tsx", ".mjs", ".js", ".jsx", ".json"];

/** Every file worth walking: the source, the shared test helpers, and the tests themselves. */
function sources(dir, out = []) {
    for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name === "artifacts" || name === "generated") continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) sources(p, out);
        else if (/\.(m?js|jsx?|tsx?)$/.test(name)) out.push(p);
    }
    return out;
}

/** Resolve one specifier from one file, or null when it leaves the repo (a package) or cannot be known. */
function resolveSpec(from, spec) {
    if (!spec.startsWith(".") && !spec.startsWith("/")) return null;   // a package, not ours
    const base = resolve(dirname(from), spec);
    if (existsSync(base) && statSync(base).isFile()) return base;
    for (const e of EXTS) if (existsSync(base + e)) return base + e;
    // A specifier written with the source extension when the file is .tsx, and the index form.
    const swapped = base.replace(/\.js$/, "");
    for (const e of EXTS) if (existsSync(swapped + e)) return swapped + e;
    for (const e of EXTS) if (existsSync(join(base, "index" + e))) return join(base, "index" + e);
    return null;
}

/** Every specifier a file names: static imports and re-exports, `require`, and dynamic `import()` — literals only. */
export function specifiersOf(file, text = readFileSync(file, "utf8")) {
    const kind = /\.tsx?$/.test(file) ? (file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS) : ts.ScriptKind.JS;
    const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
    const out = new Set();
    const lit = (n) => (n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : null);
    const visit = (node) => {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
            const s = lit(node.moduleSpecifier);
            if (s) out.add(s);
        } else if (ts.isCallExpression(node)) {
            const callee = node.expression;
            const isImport = callee.kind === ts.SyntaxKind.ImportKeyword;
            const isRequire = ts.isIdentifier(callee) && callee.text === "require";
            if (isImport || isRequire) {
                const s = lit(node.arguments[0]);
                if (s) out.add(s);
            }
        }
        // A BUILD named in any string. Two shapes, and both matter: a bundle file (`dist/sidebar-app.js`, which
        // `tests/helpers.js` loads into a vm) and a build DIRECTORY (`dist`, `dist-web`), which a harness hands to
        // a browser. The first can be traced to its entry; the second is the whole build and is marked as such.
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
            if (/(^|\/)dist[^"']*\.js$/.test(node.text)) out.add(node.text);
            else if (/^(?:\.{1,2}\/)*dist(-web|-app|-native)?\/?$/.test(node.text)) out.add(`\0build:${node.text.replace(/^[./]+|\/$/g, "")}`);
        }
        ts.forEachChild(node, visit);
    };
    ts.forEachChild(src, visit);
    return [...out];
}

/** Which bundle entry a `dist/x.js` path was built from, read from build.mjs rather than guessed. */
function bundleEntries() {
    const text = readFileSync(join(ROOT, "build.mjs"), "utf8");
    const map = new Map();
    // `entryPoints: { background: "src/background.ts", … }` and bare arrays of entry paths.
    for (const m of text.matchAll(/([A-Za-z0-9_-]+)\s*:\s*"(src\/[^"]+\.tsx?)"/g)) map.set(`${m[1]}.js`, m[2]);
    for (const m of text.matchAll(/"(src\/([A-Za-z0-9_-]+)\.tsx?)"/g)) if (!map.has(`${m[2]}.js`)) map.set(`${m[2]}.js`, m[1]);
    return map;
}

/** The import graph over every file in the repo, plus the bundle hop. */
function graph() {
    const files = [...sources(join(ROOT, "src")), ...sources(join(ROOT, "tests")), ...sources(join(ROOT, "mobile", "src"))];
    const entries = bundleEntries();
    const edges = new Map();
    const bootsBuild = new Set();
    for (const f of files) {
        const to = new Set();
        for (const spec of specifiersOf(f)) {
            if (spec.startsWith("\0build:")) { bootsBuild.add(f); continue; }
            const hit = resolveSpec(f, spec);
            if (hit) { to.add(hit); continue; }
            // A bundle: credit its entry, so a test that loads dist/ covers what went into it.
            const bundle = spec.match(/(?:^|\/)(([A-Za-z0-9_-]+)\.js)$/);
            if (bundle && spec.includes("dist") && entries.has(bundle[1])) {
                const entry = join(ROOT, entries.get(bundle[1]));
                if (existsSync(entry)) to.add(entry);
            }
        }
        edges.set(f, to);
    }
    return { edges, bootsBuild };
}

/** Everything reachable from `start`, and the first path to each — the `--why` chain. */
function reach(edges, start) {
    const seen = new Map([[start, [start]]]);
    const queue = [start];
    while (queue.length) {
        const at = queue.shift();
        for (const next of edges.get(at) ?? []) {
            if (seen.has(next)) continue;
            seen.set(next, [...seen.get(at), next]);
            queue.push(next);
        }
    }
    return seen;
}

/** The command that runs one test file. A Playwright spec runs by path; everything else goes to the runner. */
function commandFor(rel) {
    return rel.startsWith("tests/e2e/") ? `npx playwright test ${rel}` : `node scripts/test.mjs --files ${rel}`;
}

/** The commands for a SET of files, collapsed: one runner invocation for all the node tests, one per spec.
 *  Named exactly rather than by genre — the genre containing a file in `core` is 105 files, which is not an
 *  answer to "what should I run for this change". */
function commandsFor(rels) {
    const specs = rels.filter((r) => r.startsWith("tests/e2e/"));
    const node = rels.filter((r) => !r.startsWith("tests/e2e/"));
    return [
        ...(node.length ? [`node scripts/test.mjs --files ${node.join(" ")}`] : []),
        ...specs.map((s) => `npx playwright test ${s}`),
    ];
}

// The CLI runs only when this file IS the command: `specifiersOf` is imported by its own test, and a module that
// walks the repo — or exits 2 on usage — the moment it is required is not importable.
if (process.argv[1] && process.argv[1].endsWith("test-cover.mjs")) main();

function main() {
const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);

let targets = args.filter((a) => !a.startsWith("--"));
if (flag("changed")) {
    const base = execFileSync("git", ["merge-base", "HEAD", "origin/main"], { cwd: ROOT, encoding: "utf8" }).trim();
    const out = execFileSync("git", ["diff", "--name-only", `${base}...HEAD`], { cwd: ROOT, encoding: "utf8" });
    targets = [...targets, ...out.split("\n").filter((f) => /^(src|mobile)\/.*\.(m?js|tsx?)$/.test(f))];
}
if (!targets.length) {
    // `--changed` with nothing to say is not a usage error: a branch that only touched scripts or tests has no
    // source for a test to reach, and telling it how to type the command is answering a question it did not ask.
    if (flag("changed")) { console.log("nothing under src/ or mobile/ changed on this branch."); process.exit(0); }
    console.error("usage: node scripts/test-cover.mjs <file…> | --changed [--cmd] [--why] [--all]");
    process.exit(2);
}

const want = new Set(targets.map((t) => resolve(ROOT, t)).filter((t) => existsSync(t)));
if (!want.size) { console.error("test-cover: none of those files exist."); process.exit(2); }

const { edges, bootsBuild } = graph();
const isTest = (f) => /\/tests\//.test(f) && /\.(test|spec)\.(m?js|tsx?)$/.test(f);
const hits = [];
for (const f of edges.keys()) {
    if (!isTest(f)) continue;
    const seen = reach(edges, f);
    for (const target of want) {
        if (seen.has(target)) { hits.push({ test: relative(ROOT, f), target: relative(ROOT, target), path: seen.get(target) }); break; }
    }
}
hits.sort((a, b) => a.test.localeCompare(b.test));

// THE TESTS THAT BOOT A WHOLE BUILD. A harness hands `dist/` or `dist-web/` to a browser as a DIRECTORY, so no
// import edge reaches the source and none can — the source arrives as a bundle. Following imports alone would say
// the cross-page acceptance tests cover nothing. They cover everything, which is the other unhelpful answer:
// listed beside the precise hits they drown them. So they are their own group, counted rather than named — the
// suites that can notice any change and tell you least about which.
const whole = [...edges.keys()]
    .filter((f) => isTest(f) && !hits.some((h) => resolve(ROOT, h.test) === f)
        && [...reach(edges, f).keys()].some((r) => bootsBuild.has(r)))
    .map((f) => relative(ROOT, f))
    .sort();

if (flag("cmd")) {
    for (const c of commandsFor(hits.map((h) => h.test))) console.log(c);
} else {
    for (const h of hits) {
        console.log(`${h.test}\t${commandFor(h.test)}`);
        if (flag("why")) for (const step of h.path.slice(1)) console.log(`\t  → ${relative(ROOT, step)}`);
    }
    // ONE LINE, not thirty-one. Every extension e2e spec boots `dist/`, so every one of them can notice any source
    // change — which is true, and as a list it buries the handful of tests that are actually ABOUT this code. The
    // count is the useful part; `--all` prints them when you want the names.
    if (whole.length) {
        console.log("");
        if (flag("all")) for (const t of whole) console.log(`${t}\t${commandFor(t)}\t(boots a whole build)`);
        else console.log(`${whole.length} test file(s) boot a whole BUILD (dist/, dist-web/…), so any source change can reach them. --all names them.`);
    }
    if (!hits.length && !whole.length) console.log("no test reaches those files — which is either a gap or a file nothing imports yet.");
    else if (hits.length) console.error(`\ntest-cover: ${hits.length} test file(s) reach this code. Run them with:\n  ${commandsFor(hits.map((h) => h.test)).join("\n  ")}`);
    else console.error(`\ntest-cover: no test IMPORTS this code; the ${whole.length} above reach it through a build.`);
}
}
