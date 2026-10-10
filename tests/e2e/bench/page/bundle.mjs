// bundle.mjs — the bench's pages as code: the dashboard (app.tsx), the scoreboard (scores.tsx) and a run page's lane (run-lane.tsx), each bundled by
// esbuild into one script string, in memory, the first time it is asked for. Plus the stylesheet that goes with them.
// No dist and no build step to forget: the page is built from the source that is checked out, every time the bench runs.

import { buildSync } from "esbuild";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../../..");
const cache = new Map();

/** One entry, bundled as an IIFE with Preact's JSX, minified; built once per process. */
function bundle(entry) {
    if (!cache.has(entry)) {
        const out = buildSync({
            entryPoints: [path.join(HERE, entry)], bundle: true, write: false, format: "iife", platform: "browser",
            jsx: "automatic", jsxImportSource: "preact", minify: true, target: "es2020", logLevel: "silent",
            // `<` inside a string literal would let a `</script>` close the inline tag the bundle is shipped in.
            charset: "utf8",
        });
        if (out.errors.length) throw new Error(out.errors.map((e) => `${e.location?.file ?? entry}:${e.location?.line ?? "?"}: ${e.text}`).join("\n"));
        cache.set(entry, out.outputFiles[0].text.replace(/<\/script/gi, "<\\/script"));
    }
    return cache.get(entry);
}

/** Forget every built bundle, so the next ask builds from the source as it is now (the page's live-edit loop). */
export const invalidate = () => cache.clear();

/**
 * What the pages are built from, for a server that watches them: this directory, the lane modules the bundle shares
 * with the panel (the lane, the hash chip and its tooltip), and the stylesheet and palette whose rules and colours it lifts.
 */
export const pageSources = () => [
    HERE,
    path.join(ROOT, "src/resource"),
    path.join(ROOT, "src/sidebar/resource"),
    path.join(ROOT, "src/sidebar/sidebar.css"),
    path.join(ROOT, "src/sidebar/page-kit.css"),
    path.join(ROOT, "src/sidebar/fold-card.tsx"),
    path.join(ROOT, "src/sidebar/palette.ts"),
    path.join(ROOT, "src/sidebar/copy-hash.tsx"),
    path.join(ROOT, "src/sidebar/format.ts"),
    path.join(ROOT, "src/sidebar/tooltip-layer.ts"),
    path.join(ROOT, "src/sidebar/tip.ts"),
    path.join(ROOT, "src/sidebar/help-tip.tsx"),
    path.join(ROOT, "src/sidebar/interval-bar.tsx"),
    path.join(ROOT, "src/sidebar/disclosure.tsx"),
    path.join(ROOT, "src/sidebar/code-block.tsx"),
    path.join(ROOT, "src/sidebar/filter-chips.tsx"),
    path.join(ROOT, "src/sidebar/icons.tsx"),
];

/** The dashboard's script. */
export const appScript = () => bundle("app.tsx");
/** The scoreboard's script. */
export const scoresScript = () => bundle("scores.tsx");
/** The script that draws a run's lane on its own page. */
export const runLaneScript = () => bundle("run-lane.tsx");

/** The sidebar's stylesheet, the source of the lane's rules and of both themes' colours. */
export const sidebarCss = () => readFileSync(path.join(ROOT, "src/sidebar/sidebar.css"), "utf8");

/** `css`'s rules with every selector put under `scope`, so a stylesheet applies only while the scope matches. */
function scopeRules(css, scope) {
    return css.replace(/\/\*[^]*?\*\//g, "").replace(/([^{}]+)\{([^}]*)\}/g, (_, sel, body) =>
        `${sel.split(",").map((x) => `${scope} ${x.trim()}`).join(",")}{${body}}`);
}

/**
 * The panel's DEFAULT code theme (code-themes.ts `DEFAULT_CODE_THEME`) for both modes: the highlight.js stylesheet the
 * panel's settings apply when nobody picked another, and the surface colours (`--code-bg`/`--code-fg`) it declares,
 * which the panel's code blocks paint with.
 */
async function codeThemeCss() {
    const { DEFAULT_CODE_THEME, presetFile, hljsBaseColors } = await import("../../../../src/code-themes.ts");
    const one = (mode) => {
        // Without its comments: they credit the theme's author with a link, and the page loads nothing from outside.
        const text = readFileSync(path.join(ROOT, "node_modules/highlight.js/styles", `${presetFile(DEFAULT_CODE_THEME, mode).file}.css`), "utf8").replace(/\/\*[^]*?\*\//g, "");
        const { bg, fg } = hljsBaseColors(text);
        return { css: text, vars: `${bg ? `;--code-bg:${bg}` : ""}${fg ? `;--code-fg:${fg}` : ""}` };
    };
    return { dark: one("dark"), light: one("light") };
}

/**
 * The dashboard's stylesheet: the sidebar's colour tokens for both themes (following the system unless the page's
 * toggle set `data-theme`), the lane's rules from sidebar.css, the standalone page's pieces (page-kit.css), and the page's
 * own layout (page.css).
 */
export async function appCss() {
    const { themeVars, laneCss, sidebarRules } = await import("../../../../src/sidebar/resource/lane-static.ts");
    const css = sidebarCss();
    const { dark, light } = themeVars(css);
    const code = await codeThemeCss();
    return [
        `:root{${dark}${code.dark.vars}}`,
        `@media (prefers-color-scheme: light){:root:not([data-theme="dark"]){${light}${code.light.vars}}}`,
        `:root[data-theme="light"]{${light}${code.light.vars}}`,
        // Code coloured as the panel colours it by default (Settings → Code blocks: Atom One), dark and light.
        code.dark.css,
        `@media (prefers-color-scheme: light){${scopeRules(code.light.css, ':root:not([data-theme="dark"])')}}`,
        scopeRules(code.light.css, ':root[data-theme="light"]'),
        laneCss(css, { scoped: false }),
        // The panel's click-to-copy hash chip and the tooltip layer it shows its tip in (page/app.tsx installs it).
        sidebarRules(css, /\.hash\b|\.tt\b|\.tt-pop\b|\.tt-layer\b/),
        // The shared pieces the pages are built from: a label with a tip (help-tip.tsx), an estimate on its interval
        // (interval-bar.tsx), and the fold (disclosure.tsx).
        sidebarRules(css, /\.help\b|\.ival\b|\.disc\b|\.disc-|\.rc-lane-chip\b|\.rc-lane-filter\b/),
        // The resource panel's memory chart, which the timeline draws when the harness read the box (timeline.tsx).
        sidebarRules(css, /\.rc\b|\.rc-|\.vram-/),
        // An answer rendered as markdown, styled as the panel styles one (format.ts `markdown`).
        sidebarRules(css, /\.md\b|\.md-|(^|[\s,])\.code\b|pre\.code|\.hljs|\.cline\b/),
        // A diff's rows with their gutter (code-diff.tsx), the spec card's "What changed".
        sidebarRules(css, /\.dline\b|\.dline-|\.dno\b|\.dsign\b|\.dtext\b/),
        // A command to paste with its copy button (code-block.tsx `CopyableCode`): the held-run menu's commands.
        sidebarRules(css, /\.code-block\b|\.code-tools\b|\.copyable-code\b|\.icon-btn\b/),
        // The stacked chart over time (time-chart.tsx): the Memory card's history.
        sidebarRules(css, /\.tc\b|\.tc-|\.rc-tip-/),
        // The standalone page's pieces (cards that fold, tiles, badges, buttons), shared in src/sidebar, then this page's own.
        readFileSync(path.join(ROOT, "src/sidebar/page-kit.css"), "utf8"),
        readFileSync(path.join(HERE, "page.css"), "utf8"),
    ].join("\n");
}
