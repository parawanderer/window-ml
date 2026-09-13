// CODE THEMES — the stylesheet that colours every code block and the bench editor.
//
// Both surfaces colour tokens through highlight.js's `hljs-*` classes (the editor maps CodeMirror's tags onto
// them, cm-editor.ts `HLJS_STYLE`), so ONE stylesheet themes both. A preset is one of highlight.js's own; a
// custom theme is a VS Code theme converted here into the same kind of stylesheet.
//
// THE CONVERSION IS APPROXIMATE, and the Settings note says so. A VS Code theme colours TextMate SCOPES
// (`keyword.control.flow.python`, `entity.name.function.decorator`), found by running TextMate grammars — a far
// finer vocabulary than highlight.js's ~40 classes, and neither highlight.js nor CodeMirror produces scopes.
// So each class takes the colour of the scope that best stands for it. Selectors that depend on a PARENT scope
// (`meta.function-call entity.name.function`) are skipped: nothing here knows a token's parents, and applying
// such a rule everywhere would colour tokens the theme only meant to colour in one context.
//
// The uploaded file is user data, so nothing from it reaches the stylesheet verbatim: colours must be hex, font
// styles come from a fixed list, and anything else is dropped.

/** A highlight.js class → the TextMate scopes that stand for it, best first. The first that the theme colours
 *  wins, so a theme that styles `keyword.control` but not `keyword` still colours keywords. */
export const SCOPE_MAP: Record<string, string[]> = {
    "hljs-comment": ["comment"],
    "hljs-quote": ["markup.quote", "comment"],
    "hljs-doctag": ["comment.block.documentation", "storage.type.class.jsdoc", "comment"],
    "hljs-keyword": ["keyword.control", "keyword", "storage.type", "storage"],
    "hljs-built_in": ["support.function", "support.class", "support.type", "entity.name.type"],
    "hljs-type": ["entity.name.type", "support.type", "storage.type"],
    "hljs-literal": ["constant.language", "constant"],
    "hljs-number": ["constant.numeric", "constant"],
    "hljs-string": ["string"],
    "hljs-regexp": ["string.regexp", "string"],
    "hljs-symbol": ["constant.other.symbol", "constant"],
    "hljs-title": ["entity.name.function", "entity.name"],
    "hljs-title.function_": ["entity.name.function", "support.function"],
    "hljs-title.class_": ["entity.name.class", "entity.name.type.class", "entity.name.type"],
    "hljs-params": ["variable.parameter", "variable"],
    "hljs-variable": ["variable.other", "variable"],
    "hljs-variable.language_": ["variable.language", "keyword"],
    "hljs-template-variable": ["variable.other", "variable"],
    "hljs-attr": ["variable.other.property", "support.type.property-name", "entity.other.attribute-name"],
    "hljs-property": ["variable.other.property", "support.type.property-name"],
    "hljs-attribute": ["entity.other.attribute-name", "support.type.property-name"],
    "hljs-meta": ["meta.decorator", "entity.name.function.decorator", "meta.preprocessor", "keyword.other"],
    "hljs-name": ["entity.name.tag"],
    "hljs-tag": ["entity.name.tag"],
    "hljs-selector-tag": ["entity.name.tag.css", "entity.name.tag"],
    "hljs-selector-class": ["entity.other.attribute-name.class.css", "entity.other.attribute-name"],
    "hljs-selector-id": ["entity.other.attribute-name.id.css", "entity.other.attribute-name"],
    "hljs-operator": ["keyword.operator"],
    "hljs-punctuation": ["punctuation"],
    "hljs-subst": ["meta.embedded", "variable"],
    "hljs-section": ["markup.heading", "entity.name.section"],
    "hljs-bullet": ["markup.list", "punctuation.definition.list"],
    "hljs-link": ["markup.underline.link", "string.other.link"],
    "hljs-emphasis": ["markup.italic"],
    "hljs-strong": ["markup.bold"],
    "hljs-addition": ["markup.inserted"],
    "hljs-deletion": ["markup.deleted", "invalid"],
};

/** One `tokenColors` entry, as a VS Code theme writes it. `scope` is a string (possibly comma-separated) or a
 *  list; a rule with no scope is the old-style global default. */
interface TokenRule { scope?: string | string[]; settings?: { foreground?: string; background?: string; fontStyle?: string } }

/** What a converted theme IS — the stylesheet, and what the panel needs to know about it. */
export interface ConvertedTheme {
    /** The theme's own name, or the file's when it has none. */
    name: string;
    /** Dark or light, from the theme's `type`, else from its background's luminance. */
    type: "dark" | "light";
    /** The editor background and default text colour — the whole code surface, not only the tokens. */
    bg: string;
    fg: string;
    /** A stylesheet of `.hljs` and `.hljs-*` rules, the same shape as a highlight.js theme. */
    css: string;
    /** Which highlight.js classes the theme coloured, and which fell back to its plain text colour. */
    matched: string[];
    missing: string[];
}

const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
/** A colour we will write into CSS, or null. Hex only: a theme's colours are hex, and anything else in a file
 *  we did not write is a way to put arbitrary text into a stylesheet. */
const safeColor = (c: unknown): string | null => (typeof c === "string" && HEX.test(c.trim()) ? c.trim().toLowerCase() : null);

/**
 * Parse a VS Code theme file, which is JSONC: comments and trailing commas are allowed, and most published
 * themes use them. Strips both OUTSIDE strings (a URL in a string has `//` in it) and hands the rest to JSON.
 * @throws when what is left is not JSON.
 */
export function parseJsonc(text: string): unknown {
    let out = "";
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === "\"") {
            const start = i;
            for (i++; i < text.length && text[i] !== "\""; i++) if (text[i] === "\\") i++;
            out += text.slice(start, i + 1);
        } else if (ch === "/" && text[i + 1] === "/") {
            while (i < text.length && text[i] !== "\n") i++;
            out += "\n";
        } else if (ch === "/" && text[i + 1] === "*") {
            i += 2;
            while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
            i++;
        } else out += ch;
    }
    return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

/** Relative luminance of a hex colour, 0 (black) to 1 (white). */
function luminance(hex: string): number {
    let h = hex.slice(1);
    if (h.length <= 4) h = [...h].map((c) => c + c).join("");
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
        .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The theme's rules as flat (selector, settings, order) triples — one per comma-separated selector. */
function flatRules(rules: TokenRule[]): { sel: string; settings: NonNullable<TokenRule["settings"]>; order: number }[] {
    const out: { sel: string; settings: NonNullable<TokenRule["settings"]>; order: number }[] = [];
    rules.forEach((r, order) => {
        if (!r || typeof r !== "object" || !r.settings || !r.scope) return;
        const sels = (Array.isArray(r.scope) ? r.scope : String(r.scope).split(",")).map((s) => String(s).trim()).filter(Boolean);
        // A parent-scope selector ("a b") or an exclusion ("a - b") needs context nothing here has.
        for (const sel of sels) if (!/\s/.test(sel)) out.push({ sel, settings: r.settings, order });
    });
    return out;
}

/** The rule that colours `scope`: the LONGEST selector that is the scope or a dotted prefix of it, and the later
 *  rule on a tie — TextMate's own specificity, minus the parent-scope part. */
function resolve(rules: ReturnType<typeof flatRules>, scope: string, field: "foreground" | "fontStyle") {
    let best: (typeof rules)[number] | null = null;
    for (const r of rules) {
        if (r.settings[field] == null) continue;
        if (scope !== r.sel && !scope.startsWith(r.sel + ".")) continue;
        if (!best || r.sel.length > best.sel.length || (r.sel.length === best.sel.length && r.order >= best.order)) best = r;
    }
    return best?.settings[field];
}

/**
 * Convert a VS Code colour theme (the parsed JSON) into a highlight.js-shaped stylesheet.
 * @param fallbackName used when the theme names nothing (the uploaded file's name).
 * @throws when this is not a colour theme at all (no `tokenColors` and no `colors`).
 */
export function convertVscodeTheme(theme: unknown, fallbackName = "Custom theme"): ConvertedTheme {
    if (!theme || typeof theme !== "object") throw new Error("That file is not a VS Code theme (expected a JSON object).");
    const t = theme as { name?: unknown; type?: unknown; colors?: Record<string, unknown>; tokenColors?: unknown };
    const rules = Array.isArray(t.tokenColors) ? (t.tokenColors as TokenRule[]) : [];
    const colors = t.colors && typeof t.colors === "object" ? t.colors : {};
    if (!rules.length && !Object.keys(colors).length) {
        throw new Error("That file has no `tokenColors` or `colors`, so it is not a VS Code colour theme. (A theme that only `include`s another cannot be read on its own.)");
    }
    // The old-style global rule — a `tokenColors` entry with no scope — carries the default fg/bg.
    const global = rules.find((r) => r && typeof r === "object" && !r.scope && r.settings)?.settings ?? {};
    const declaredType = t.type === "light" || t.type === "hcLight" ? "light" : t.type === "dark" || t.type === "hc" || t.type === "hcDark" ? "dark" : null;
    const bgRaw = safeColor(colors["editor.background"]) ?? safeColor(global.background);
    const type = declaredType ?? (bgRaw ? (luminance(bgRaw.slice(0, 7)) > 0.4 ? "light" : "dark") : "dark");
    const bg = bgRaw ?? (type === "light" ? "#ffffff" : "#1e1e1e");
    const fg = safeColor(colors["editor.foreground"]) ?? safeColor(global.foreground) ?? (type === "light" ? "#000000" : "#d4d4d4");

    const flat = flatRules(rules);
    const lines = [
        // The layout every highlight.js theme carries, so a converted theme lays out exactly like a preset.
        "pre code.hljs{display:block;overflow-x:auto;padding:1em}",
        "code.hljs{padding:3px 5px}",
        `.hljs{color:${fg};background:${bg}}`,
    ];
    const matched: string[] = [], missing: string[] = [];
    for (const [cls, scopes] of Object.entries(SCOPE_MAP)) {
        let color: string | null = null, style: string | undefined;
        for (const s of scopes) {
            const c = safeColor(resolve(flat, s, "foreground"));
            if (c) { color = c; style = resolve(flat, s, "fontStyle"); break; }
        }
        if (!color) { missing.push(cls); continue; }
        matched.push(cls);
        // Words, not the raw string: only these four ever become CSS, so a malformed value loses its junk and
        // keeps whatever real style words it had.
        const words = new Set(String(style ?? "").toLowerCase().split(/[^a-z]+/).filter(Boolean));
        const decl = [`color:${color}`];
        if (words.has("italic")) decl.push("font-style:italic");
        if (words.has("bold")) decl.push("font-weight:bold");
        const deco = ["underline", "strikethrough"].filter((w) => words.has(w)).map((w) => (w === "strikethrough" ? "line-through" : w));
        if (deco.length) decl.push(`text-decoration:${deco.join(" ")}`);
        lines.push(`.${cls}{${decl.join(";")}}`);
    }
    // highlight.js's own emphasis/strong classes mean italic/bold whatever colour the theme gave them.
    lines.push(".hljs-emphasis{font-style:italic}", ".hljs-strong{font-weight:bold}");
    const name = typeof t.name === "string" && t.name.trim() ? t.name.trim().slice(0, 80) : fallbackName;
    return { name, type, bg, fg, css: lines.join("\n"), matched, missing };
}

/**
 * The background and default text colour a highlight.js stylesheet declares on `.hljs` — what the editor and
 * code blocks need to paint their whole surface in that theme, not only its tokens.
 * @returns null for either one the stylesheet does not declare as a plain value.
 */
export function hljsBaseColors(css: string): { bg: string | null; fg: string | null } {
    let bg: string | null = null, fg: string | null = null;
    // Every `.hljs { … }` block, in order (a theme can split them); later declarations win, as in CSS.
    // Comments first: some themes annotate each declaration inside the block (`/* var(--highlight-bg) */`). Then
    // every rule whose selector LIST includes exactly `.hljs` — themes split it (`.hljs { background }` and
    // `.hljs, .hljs-subst { color }`, as Nord does) — with later declarations winning, as in CSS.
    for (const m of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^}]*)\}/g)) {
        if (!m[1].split(",").some((sel) => sel.trim() === ".hljs")) continue;
        for (const decl of m[2].split(";")) {
            const [k, ...v] = decl.split(":");
            const key = k?.trim().toLowerCase(), val = v.join(":").trim();
            if (!val) continue;
            if (key === "color") fg = val;
            else if (key === "background" || key === "background-color") bg = val;
        }
    }
    return { bg, fg };
}

/** A bundled highlight.js theme. A PAIR follows the panel's light/dark; a single-variant theme is used as it is,
 *  whichever the panel is (its code surfaces take its own background, so a dark theme stays readable in a light
 *  panel). Files are paths under `highlight.js/styles/`, without `.css`. */
export interface CodeThemePreset { id: string; label: string; dark?: string; light?: string }

/** The default: the panel's own look, drawn on the panel's own surface colours rather than the theme's. */
export const DEFAULT_CODE_THEME = "atom-one";
/** The custom slot: a VS Code theme the user uploaded. */
export const VSCODE_THEME_ID = "vscode";

/** The presets on offer — a curated few of highlight.js's ~250, chosen for recognisability. */
export const CODE_THEME_PRESETS: CodeThemePreset[] = [
    { id: "atom-one", label: "Atom One", dark: "atom-one-dark", light: "atom-one-light" },
    { id: "github", label: "GitHub", dark: "github-dark", light: "github" },
    { id: "github-dimmed", label: "GitHub Dimmed", dark: "github-dark-dimmed", light: "github" },
    { id: "visual-studio", label: "Visual Studio", dark: "vs2015", light: "vs" },
    { id: "tokyo-night", label: "Tokyo Night", dark: "tokyo-night-dark", light: "tokyo-night-light" },
    { id: "stackoverflow", label: "Stack Overflow", dark: "stackoverflow-dark", light: "stackoverflow-light" },
    { id: "gruvbox", label: "Gruvbox", dark: "base16/gruvbox-dark-medium", light: "base16/gruvbox-light-medium" },
    { id: "solarized", label: "Solarized", dark: "base16/solarized-dark", light: "base16/solarized-light" },
    { id: "panda", label: "Panda Syntax", dark: "panda-syntax-dark", light: "panda-syntax-light" },
    { id: "kimbie", label: "Kimbie", dark: "kimbie-dark", light: "kimbie-light" },
    { id: "a11y", label: "a11y (high contrast)", dark: "a11y-dark", light: "a11y-light" },
    { id: "monokai", label: "Monokai", dark: "monokai-sublime" },
    { id: "dracula", label: "Dracula", dark: "base16/dracula" },
    { id: "nord", label: "Nord", dark: "nord" },
    { id: "night-owl", label: "Night Owl", dark: "night-owl" },
    { id: "material-darker", label: "Material Darker", dark: "base16/material-darker" },
    { id: "xcode", label: "Xcode", light: "xcode" },
    { id: "intellij-light", label: "IntelliJ Light", light: "intellij-light" },
];

/** Which stylesheet file a preset uses in a panel of the given mode: its matching variant, else its only one.
 *  An unknown id is the default, so a preset removed in a later version degrades to the default look. */
export function presetFile(id: string, panel: "dark" | "light"): { preset: CodeThemePreset; file: string } {
    const preset = CODE_THEME_PRESETS.find((p) => p.id === id) ?? CODE_THEME_PRESETS[0];
    return { preset, file: (panel === "dark" ? preset.dark ?? preset.light : preset.light ?? preset.dark)! };
}
