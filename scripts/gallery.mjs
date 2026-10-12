#!/usr/bin/env node
// gallery.mjs — THE COMPONENT GALLERY from the command line: build it, serve it, list what it holds, screenshot one
// component with given props and toggles, render every entry to see which fail, and remind a commit about the tags
// (docs/spec/COMPONENT_GALLERY.md; skill: gallery).
//
//   node scripts/gallery.mjs build                                    # dist-gallery/
//   node scripts/gallery.mjs serve [--port 5180]                      # build if stale, then serve it
//   node scripts/gallery.mjs list ['<regex>'] [--group g] [--json]    # what it holds
//   node scripts/gallery.mjs list --props <id>                        # one entry's props: types, enum members, variants
//   node scripts/gallery.mjs shot <id> [--variant v] [--props '<json>'|@f.json] [--theme light|dark|system]
//        [--view dev|calm] [--width phone|panel|desktop|full] [--tokens '<json>'|@f.json] [--size WxH]
//        [--wait ms] [--page] [--log] [--out f.png]                   # a PNG of the entry's tile (Read it)
//   node scripts/gallery.mjs shot A B C                               # several, one browser: test-results/gallery-<id>.png
//   node scripts/gallery.mjs shot Disclosure --do 'click:.disc-head' --do 'hover:page .tt' [--each]   # interact first
//        [--script flow.mjs] [--eval '<expr>']                        # a Playwright script: export default async ({ page, tile, shot }) => {}
//   node scripts/gallery.mjs flow <id> [shot flags]                   # the same, from a FILE kept at tmp/gallery-flows/<id>.mjs
//                                                                     #   (written from a template the first time; edit, re-run)
//   node scripts/gallery.mjs check [--only '<regex>'] [--changed <ref>]   # render everything; exit 1 on a broken EXAMPLE
//   node scripts/gallery.mjs remind [--staged | <ref>]                # the pre-commit reminder: @group / @gallery
//
// Every toggle the page has is a flag here: the page keeps its whole state in the URL (src/gallery/gallery-url.ts),
// and `shot` writes that URL. A custom entry's log (its timings, for the gradient canvas) prints with `--log`.
import * as esbuild from "esbuild";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { writeBuildInfo } from "./gen-build-info.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
/** The generator, loaded only by the commands that read the TypeScript program (not `remind`, which runs on every commit). */
const gen = () => import("./gallery-gen.mjs");
const OUT = path.join(ROOT, "dist-gallery");
const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (n) => argv.includes(`--${n}`);
const opt = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
/** The positional arguments after the command: words that are not a flag or a flag's value. */
const BOOL = new Set(["json", "page", "log", "staged", "full", "verbose", "each"]);
const positional = argv.slice(1).filter((a, i, all) => !a.startsWith("--") && !(i > 0 && all[i - 1].startsWith("--") && !BOOL.has(all[i - 1].slice(2))));
/** Every value of a repeatable flag (`--do a --do b`). */
const opts = (n) => argv.flatMap((a, i) => (a === `--${n}` && argv[i + 1] != null ? [argv[i + 1]] : []));
/** A JSON flag: inline JSON, or `@file`. */
const jsonOpt = (n) => { const v = opt(n); if (v == null) return undefined; return JSON.parse(v.startsWith("@") ? readFileSync(v.slice(1), "utf8") : v); };

/** The newest modification time under a directory, for the staleness check. */
function newest(dir) {
    let t = 0;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        t = Math.max(t, e.isDirectory() ? newest(p) : statSync(p).mtimeMs);
    }
    return t;
}
const stale = () => !existsSync(path.join(OUT, "gallery.js")) || newest(path.join(ROOT, "src")) > statSync(path.join(OUT, "gallery.js")).mtimeMs;

/** Build dist-gallery/ (staged, swapped in on success). The manifest is a virtual module, never a file in src/. */
async function build() {
    const t0 = Date.now();
    writeBuildInfo();
    const manifest = (await gen()).galleryManifest();
    const files = [...new Set(manifest.components.map((c) => c.file))];
    const imp = (f) => `() => import(${JSON.stringify(path.join(ROOT, f))})`;
    const contents = [
        `export const components = ${JSON.stringify(manifest.components)};`,
        `export const loaders = {${files.map((f) => `${JSON.stringify(f)}: ${imp(f)}`).join(",\n")}};`,
        `export const custom = {${manifest.custom.map((f) => `${JSON.stringify(f)}: ${imp(f)}`).join(",\n")}};`,
    ].join("\n");
    const stage = `${OUT}.stage`;
    rmSync(stage, { recursive: true, force: true });
    mkdirSync(stage, { recursive: true });
    try {
        await esbuild.build({
            absWorkingDir: ROOT,
            entryPoints: { gallery: "src/gallery/gallery.tsx" },
            outdir: stage, bundle: true, format: "esm", splitting: true, target: ["chrome114"],
            jsx: "automatic", jsxImportSource: "preact", loader: { ".css": "text" }, sourcemap: "linked", logLevel: "warning",
            plugins: [{
                name: "gallery-manifest",
                setup(b) {
                    b.onResolve({ filter: /^gallery:manifest$/ }, () => ({ path: "gallery:manifest", namespace: "gallery" }));
                    b.onLoad({ filter: /.*/, namespace: "gallery" }, () => ({ contents, loader: "js", resolveDir: ROOT }));
                },
            }],
        });
        cpSync(path.join(ROOT, "src/gallery/gallery.html"), path.join(stage, "index.html"));
        for (const f of ["src/sidebar/sidebar.css", "src/chat/chat.css", "src/sidebar/page-kit.css", "src/gallery/gallery.css"]) cpSync(path.join(ROOT, f), path.join(stage, path.basename(f)));
        const fonts = path.join(ROOT, "node_modules/katex/dist/fonts");
        if (existsSync(fonts)) {
            mkdirSync(path.join(stage, "fonts"), { recursive: true });
            for (const f of readdirSync(fonts)) if (f.endsWith(".woff2")) cpSync(path.join(fonts, f), path.join(stage, "fonts", f));
        }
        rmSync(OUT, { recursive: true, force: true });
        renameSync(stage, OUT);
    } catch (e) {
        rmSync(stage, { recursive: true, force: true });
        console.error("✗ gallery build FAILED: dist-gallery/ is untouched.");
        throw e;
    }
    console.error(`built dist-gallery/ (${manifest.components.length} components, ${manifest.custom.length} custom module(s)) in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

async function ensureBuilt() { if (stale()) await build(); }

/** Serve dist-gallery/ on a port (0: any free one). */
async function serve(port = 0) {
    const { serveStatic } = await import("../tests/e2e/static-server.mjs");
    return serveStatic(OUT, { port });
}

/** The custom entries, read by importing their modules (they must not touch the DOM at import). */
async function customEntries() {
    const { tsImport } = await import("tsx/esm/api");
    const out = [];
    for (const f of (await gen()).customEntryFiles()) {
        try {
            const mod = await tsImport(path.join(ROOT, f), import.meta.url);
            for (const e of mod.gallery ?? []) out.push({ id: e.id, kind: "custom", name: e.title, file: f, summary: e.summary, groups: e.groups ?? ["custom"], variants: Object.keys(e.variants ?? { default: 1 }).map((name) => ({ name, source: "custom" })), props: e.props });
        } catch (err) { out.push({ id: f, kind: "custom", name: f, file: f, summary: `failed to import: ${err.message}`, groups: ["custom"], variants: [] }); }
    }
    return out;
}

/** One schema as a line or a few, for `list --props`. */
function schemaLines(schema, indent = "  ") {
    return (schema.fields ?? []).map((f) => `${indent}${f.name}${f.optional ? "?" : ""}: ${f.schema.kind}${f.schema.members ? ` [${f.schema.members.map((m) => JSON.stringify(m)).join(" | ")}]` : ""}  ${f.schema.text}${f.doc ? `  — ${f.doc}` : ""}`);
}

async function list() {
    const m = (await gen()).galleryManifest();
    const all = [...await customEntries(), ...m.components];
    if (opt("props")) {
        const e = all.find((x) => x.id === opt("props"));
        if (!e) { console.error(`✗ no entry ${opt("props")}`); process.exit(2); }
        if (flag("json")) { console.log(JSON.stringify(e, null, 2)); return; }
        console.log(`${e.id}  (${e.file}${e.line ? `:${e.line}` : ""})\n  ${e.summary}\n  groups: ${e.groups.join(", ")}`);
        if (e.props?.fields) console.log(`props:\n${schemaLines(e.props).join("\n")}`);
        else console.log(`props (custom entry default):\n  ${JSON.stringify(e.props)}`);
        console.log(`variants:\n${e.variants.map((v) => `  ${v.name} (${v.source})${v.props !== undefined ? `  ${JSON.stringify(v.props)}` : ""}${v.error ? `  ✗ ${v.error}` : ""}`).join("\n")}`);
        return;
    }
    const re = positional[0] ? new RegExp(positional[0], "i") : null;
    const rows = all.filter((e) => (!re || re.test(`${e.id} ${e.summary} ${e.groups.join(" ")}`)) && (!opt("group") || e.groups.includes(opt("group"))));
    if (flag("json")) { console.log(JSON.stringify(rows.map(({ props, inferred, ...r }) => r), null, 2)); return; }
    // TAB-separated, like the code index: id, groups, variants, file, summary.
    for (const e of rows) console.log([e.id, e.groups.join(","), e.variants.map((v) => v.name).join("|"), e.file + (e.line ? `:${e.line}` : ""), e.summary].join("\t"));
}

/** The page URL for a state: the hash src/gallery/gallery-url.ts parses. */
async function stateUrl(base, s) {
    const { formatHash } = await import("tsx/esm/api").then(({ tsImport }) => tsImport(path.join(ROOT, "src/gallery/gallery-url.ts"), import.meta.url));
    return `${base}index.html${formatHash(s)}`;
}

/** Open a browser on the served gallery and wait for it to be ready. */
async function openGallery(size = "1400x900") {
    const { chromium } = await import("@playwright/test");
    const server = await serve();
    const [w, h] = size.split("x").map(Number);
    const browser = await chromium.launch({ channel: "chromium" });
    const context = await browser.newContext({ viewport: { width: w, height: h } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => { if (m.type() === "error") errors.push(`console.error: ${m.text()}`); });
    return { server, context, page, errors, close: async () => { await browser.close(); server.close(); } };
}

/** Wait until the tile for (id, variant) has a settled status, and return it. */
async function settle(page, id, variant, timeout = 10_000) {
    return page.evaluate(async ({ id, variant, timeout }) => {
        const g = globalThis.__gallery;
        await g.ready;
        const it = g.items().find((x) => x.id === id);
        if (!it) return { state: "missing", error: `no entry ${id}` };
        const v = variant || it.variants[0]?.name;
        const t0 = performance.now();
        for (;;) {
            const s = g.status(id, v);
            if (s && s.state !== "pending") return { ...s, variant: v };
            if (performance.now() - t0 > timeout) return { state: "error", error: "timed out rendering", variant: v };
            await new Promise((r) => setTimeout(r, 30));
        }
    }, { id, variant, timeout });
}

async function shot() {
    const ids = positional;
    if (!ids.length) { console.error("usage: node scripts/gallery.mjs shot <id> [<id> …] [flags]  (ids: node scripts/gallery.mjs list)"); process.exit(2); }
    if (ids.length > 1 && opt("out")) { console.error("--out names one file; with several ids each goes to test-results/gallery-<id>.png"); process.exit(2); }
    await ensureBuilt();
    const g = await openGallery(opt("size"));
    let code = 0;
    try {
        for (const id of ids) {
            const url = await stateUrl(g.server.url, {
                id, variant: opt("variant") ?? "", props: jsonOpt("props") ?? null, tokens: jsonOpt("tokens") ?? null,
                theme: opt("theme") ?? "dark", view: opt("view") ?? "dev", width: opt("width") ?? "full", tab: "props", q: "",
            });
            await g.page.goto(url);
            const st = await settle(g.page, id, opt("variant"));
            await g.page.waitForTimeout(opt("wait") ? Number(opt("wait")) : 150);
            const out = opt("out") ?? `test-results/gallery-${id.replace(/[^\w.-]+/g, "_")}.png`;
            mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
            const frame = g.page.locator(".gl-tile.sel .gl-frame, .gl-tile:first-child .gl-frame").first();
            const snap = async (file) => { if (flag("page")) await g.page.screenshot({ path: file }); else await frame.screenshot({ path: file }); };
            /** A numbered frame beside the final shot: `<out>-<n>-<name>.png`. */
            let n = 0;
            const frameShot = async (name) => {
                const f = out.replace(/\.png$/, `-${String(++n).padStart(2, "0")}-${String(name).replace(/[^\w.-]+/g, "_").slice(0, 40)}.png`);
                await snap(f);
                console.log(`  frame: ${f}`);
            };
            // INTERACTIONS, scoped to the component's tile: `--do` steps, then a `--script` with the whole Playwright API.
            for (const step of opts("do")) {
                await doStep(g.page, frame, step);
                if (flag("each")) await frameShot(step);
            }
            const own = flowScript || opt("script") ? null : await variantFlow(g.page, id, st.variant);
            if (own) console.log(`  flow: ${own} (the variant's @gallery-flow)`);
            const script = flowScript ?? opt("script") ?? (own ? path.join(ROOT, own) : null);
            if (script) {
                // A query string defeats Node's module cache, so an edited flow re-runs as edited.
                const mod = await import(`${path.resolve(script)}?t=${Date.now()}`);
                await (mod.default ?? mod.run)({ page: g.page, tile: frame, frame, shot: frameShot });
            }
            if (opt("eval")) console.log(`eval: ${JSON.stringify(await g.page.evaluate((src) => (0, eval)(src), opt("eval")))}`);
            await snap(out);
            if (ids.length === 1) console.log(`url: ${url}`);
            console.log(`${id}: ${st.state}${st.variant ? ` (variant "${st.variant}")` : ""}${st.error ? `: ${st.error}` : ""}  → ${out}`);
            if (flag("log")) {
                const log = await g.page.evaluate(() => globalThis.__gallery.log());
                for (const l of log) console.log(`log: ${new Date(l.t).toISOString().slice(11, 23)}  ${l.text}`);
                const pts = await g.page.evaluate(() => globalThis.__gallery.points());
                if (pts.length) {
                    const keys = [...new Set(pts.flatMap((p) => Object.keys(p.values)))];
                    const mean = (k) => pts.reduce((s, p) => s + (p.values[k] ?? 0), 0) / pts.length;
                    console.log(`timings: ${pts.length} frames, mean ${keys.map((k) => `${k} ${mean(k).toFixed(3)} ms`).join(", ")}`);
                }
            }
            if (st.state !== "ok") code = 1;
        }
    } finally {
        for (const e of g.errors) console.log(e);
        await g.close();
    }
    process.exit(code);
}

/**
 * One `--do` step on a component's tile: `click:<sel>`, `dblclick:<sel>`, `hover:<sel>`, `focus:<sel>`,
 * `type:<sel>=<text>`, `fill:<sel>=<text>`, `press:<key>` (on the focused element), `wait:<ms>`, `waitfor:<sel>`. A
 * selector is looked up inside the tile; prefix it with `page ` to look in the whole page (a tooltip, a menu or a
 * dialog drawn outside the tile).
 */
async function doStep(page, tile, step) {
    const i = step.indexOf(":");
    const verb = i < 0 ? step : step.slice(0, i), arg = i < 0 ? "" : step.slice(i + 1);
    const at = (sel) => (sel.startsWith("page ") ? page.locator(sel.slice(5)) : tile.locator(sel)).first();
    const [sel, text = ""] = arg.split(/=(.*)/s);
    switch (verb) {
        case "click": return at(arg).click();
        case "dblclick": return at(arg).dblclick();
        case "hover": return at(arg).hover();
        case "focus": return at(arg).focus();
        case "type": return at(sel).pressSequentially(text);
        case "fill": return at(sel).fill(text);
        case "press": return page.keyboard.press(arg);
        case "wait": return page.waitForTimeout(Number(arg));
        case "waitfor": return at(arg).waitFor({ timeout: 10_000 });
        default: throw new Error(`--do ${step}: unknown step (click, dblclick, hover, focus, type, fill, press, wait, waitfor)`);
    }
}

/** The flow script a `flow` command runs (null for a plain `shot`). */
let flowScript = null;

/** A flow FILE for an entry: kept on disk so it can be edited and re-run, instead of a script retyped each time. */
const FLOW_TEMPLATE = (id) => `// ${id}.mjs — a gallery flow: drives ${id} in its tile, then the final shot is taken.
// Run it (and re-run it after each edit) with: node scripts/gallery.mjs flow ${id} [--variant v] [--props …] [--theme …]
// \`tile\` is the component's frame (a Playwright Locator: tile.locator("button").click()), \`page\` the whole page (a
// tooltip, a menu or a dialog may be drawn outside the tile), \`shot(name)\` saves a numbered frame beside the final shot.
export default async ({ page, tile, shot }) => {
    await shot("start");
    // await tile.locator("button").first().click();
    // await page.waitForTimeout(200);
    // await shot("after the click");
};
`;

async function flow() {
    const id = positional[0];
    if (!id) { console.error("usage: node scripts/gallery.mjs flow <id> [shot flags]  (writes tmp/gallery-flows/<id>.mjs the first time)"); process.exit(2); }
    const file = opt("file") ?? path.join(ROOT, "tmp/gallery-flows", `${id.replace(/[^\w.-]+/g, "_")}.mjs`);
    if (!existsSync(file)) {
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, FLOW_TEMPLATE(id));
        console.log(`flow: wrote ${path.relative(ROOT, file)} (a template: edit it, then run this again)`);
    }
    flowScript = file;
    return shot();
}

/** The committed flow of a variant (`@gallery-flow`), repo-relative, or null. */
async function variantFlow(page, id, variant) {
    return page.evaluate(({ id, variant }) => {
        const it = globalThis.__gallery.items().find((x) => x.id === id);
        return it?.variants.find((v) => v.name === variant)?.flow ?? null;
    }, { id, variant });
}

/** Run a committed flow against the tile for the check: it passes when it returns without throwing. */
async function runFlow(page, file) {
    const tile = page.locator(".gl-tile.sel .gl-frame, .gl-tile:first-child .gl-frame").first();
    const mod = await import(`${path.join(ROOT, file)}?t=${Date.now()}`);
    await (mod.default ?? mod.run)({ page, tile, frame: tile, shot: async () => {} });
}

/** Components in files changed since `ref`, by id. */
function changedFiles(ref) {
    return new Set(execFileSync("git", ["diff", "--name-only", ref, "--"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean));
}

async function check() {
    await ensureBuilt();
    const only = opt("only") ? new RegExp(opt("only")) : null;
    const changed = opt("changed") ? changedFiles(opt("changed")) : null;
    const g = await openGallery();
    const blocking = [], warnings = [];
    let rendered = 0, handled = 0;
    // A component can spin the page's main thread (a render loop), and then nothing inside the page times out: the
    // render is raced here, and a page that does not answer is replaced by a fresh one.
    const fresh = async () => {
        await g.page.close().catch(() => {});
        g.page = await g.context.newPage();
        g.page.on("pageerror", () => {});
        await g.page.goto(`${g.server.url}index.html`);
        await g.page.evaluate(() => globalThis.__gallery.ready);
    };
    const race = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r({ state: "error", error: `hung: the page stopped answering for ${ms / 1000} s (a render loop?)`, hung: true }), ms))]);
    try {
        await g.page.goto(`${g.server.url}index.html`);
        const items = await g.page.evaluate(async () => { await globalThis.__gallery.ready; return globalThis.__gallery.items(); });
        const manifest = new Map((await gen()).galleryManifest().components.map((c) => [c.id, c]));
        for (const it of items) {
            if (only && !only.test(it.id)) continue;
            const c = manifest.get(it.id);
            for (const v of it.variants) {
                const go = g.page.evaluate(({ id, variant }) => { location.hash = `#/${encodeURIComponent(id)}?variant=${encodeURIComponent(variant)}`; }, { id: it.id, variant: v.name });
                if (v.source === "none") { handled++; if (flag("verbose")) console.error(`none   ${it.id}  ${v.reason}`); continue; }
                let st = await race(go.then(() => settle(g.page, it.id, v.name, 8_000)), 12_000);
                if (st.hung) await fresh();
                else if (v.flow && st.state === "ok") {
                    st = await race(runFlow(g.page, v.flow).then(() => ({ state: "ok" }), (e) => ({ state: "error", error: `flow ${v.flow} failed: ${String(e?.message ?? e).split("\n")[0]}` })), 20_000);
                    if (st.hung) await fresh();
                }
                if (flag("verbose")) console.error(`${st.state.padEnd(6)} ${it.id} [${v.name}]${st.error ? `  ${st.error.slice(0, 140)}` : ""}`);
                rendered++;
                if (st.state === "ok") continue;
                const row = { id: it.id, variant: v.name, source: v.source, state: st.state, error: st.error, file: c?.file, line: c?.line };
                (v.source === "inferred" ? warnings : blocking).push(row);
            }
        }
    } finally { await g.close(); }
    const where = (r) => (r.file ? `${r.file}:${r.line}` : "custom entry");
    for (const r of warnings) {
        console.log(`warn  ${r.id} [${r.variant}] ${r.state}: ${r.error ?? ""}  (${where(r)})`);
        // In CI, an annotation on the component, for the ones this change touched: "add an @gallery example".
        if (process.env.GITHUB_ACTIONS && r.file && (!changed || changed.has(r.file))) {
            console.log(`::warning file=${r.file},line=${r.line}::${r.id} does not render from its inferred props (${r.state}: ${(r.error ?? "").slice(0, 120)}). Add an @gallery example to its JSDoc; if it draws nothing until triggered, an @gallery-flow; if nothing is worth showing on its own, @gallery none <reason> (skill: gallery).`);
        }
    }
    for (const r of blocking) {
        console.log(`FAIL  ${r.id} [${r.variant}] (${r.source}) ${r.state}: ${r.error ?? ""}  (${where(r)})`);
        if (process.env.GITHUB_ACTIONS && r.file) console.log(`::error file=${r.file},line=${r.line}::the @gallery example "${r.variant}" of ${r.id} does not render: ${r.state}`);
    }
    console.log(`gallery check: ${rendered} render(s); ${blocking.length} broken example(s), flow(s) or custom entr(ies) (blocking), ${warnings.length} inferred render(s) failing (warnings), ${handled} marked @gallery none`);
    process.exit(blocking.length ? 1 : 0);
}

/** The pre-commit reminder: components a commit adds or changes with no `@group`, or no `@gallery`. Static, never fails. */
function remind() {
    const staged = flag("staged");
    const ref = staged ? null : positional[0] ?? "HEAD";
    const diffArgs = staged ? ["diff", "--cached", "-U0", "--", "src/*.tsx", "src/**/*.tsx"] : ["diff", "-U0", ref, "--", "src/*.tsx", "src/**/*.tsx"];
    const diff = execFileSync("git", diffArgs, { cwd: ROOT, encoding: "utf8" });
    const touched = new Map();   // file → changed line numbers (new side)
    let file = null;
    for (const l of diff.split("\n")) {
        const f = /^\+\+\+ b\/(.+)$/.exec(l);
        if (f) { file = f[1]; touched.set(file, []); continue; }
        const h = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/.exec(l);
        if (h && file) { const a = Number(h[1]), n = h[2] == null ? 1 : Number(h[2]); for (let i = 0; i < Math.max(n, 1); i++) touched.get(file).push(a + i); }
    }
    const missing = [];
    for (const [f, lines] of touched) {
        if (!existsSync(path.join(ROOT, f)) || f.startsWith("src/gallery/")) continue;   // the gallery's own parts are not listed
        const src = (staged ? execFileSync("git", ["show", `:${f}`], { cwd: ROOT, encoding: "utf8" }) : readFileSync(path.join(ROOT, f), "utf8")).split("\n");
        const decls = [];
        src.forEach((l, i) => { if (/^\S/.test(l) && !/^[}\])]/.test(l) && !/^\s*\/\//.test(l)) decls.push(i); });
        src.forEach((l, i) => {
            const m = /^export function ([A-Z]\w*)/.exec(l);
            if (!m) return;
            const end = decls.find((d) => d > i) ?? src.length;
            let docStart = i;
            while (docStart > 0 && /^\s*(\/\*\*|\*|\*\/)/.test(src[docStart - 1])) docStart--;
            if (!lines.some((n) => n - 1 >= docStart && n - 1 < end)) return;
            const doc = src.slice(docStart, i).join("\n");
            const needs = [!/@group\b/.test(doc) && "@group", !/@gallery\b/.test(doc) && "@gallery"].filter(Boolean);
            if (needs.length) missing.push({ name: m[1], file: f, line: i + 1, needs });
        });
    }
    if (!missing.length) return;
    console.log("gallery: components this change touches, missing gallery tags (a reminder, not a failure; skill: gallery):");
    for (const m of missing) {
        const hint = m.needs.includes("@gallery") ? `  check its inferred render: node scripts/gallery.mjs shot ${m.name}; if it is blank or broken, add @gallery {…} (or @gallery-flow / @gallery none: skill gallery)` : "";
        console.log(`  ${m.name}  ${m.file}:${m.line}  no ${m.needs.join(", no ")}${hint}`);
    }
}

const COMMANDS = {
    build, list, shot, check, flow,
    remind: async () => remind(),
    serve: async () => {
        await ensureBuilt();
        const s = await serve(Number(opt("port") ?? 5180));
        console.log(`gallery: ${s.url}index.html  (Ctrl-C to stop; rebuild with: node scripts/gallery.mjs build)`);
    },
};
if (!COMMANDS[cmd]) {
    console.error("usage: node scripts/gallery.mjs build | serve | list | shot <id> | flow <id> | check | remind   (see the header of this file)");
    process.exit(2);
}
await COMMANDS[cmd]();
