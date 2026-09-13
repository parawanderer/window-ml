// The bundled code-theme STYLESHEETS, and the one function that decides which is live.
//
// Kept apart from code-themes.ts, which is pure and imports no CSS, so the converter and the preset list are
// testable directly; this is the half that needs the build's CSS-as-text loader. ~30 highlight.js themes, a
// couple of KB each, bundled into sidebar-app rather than fetched, so switching one is instant and offline.
import css_atom_one_dark from "highlight.js/styles/atom-one-dark.css";
import css_atom_one_light from "highlight.js/styles/atom-one-light.css";
import css_github_dark from "highlight.js/styles/github-dark.css";
import css_github from "highlight.js/styles/github.css";
import css_github_dark_dimmed from "highlight.js/styles/github-dark-dimmed.css";
import css_vs2015 from "highlight.js/styles/vs2015.css";
import css_vs from "highlight.js/styles/vs.css";
import css_tokyo_night_dark from "highlight.js/styles/tokyo-night-dark.css";
import css_tokyo_night_light from "highlight.js/styles/tokyo-night-light.css";
import css_stackoverflow_dark from "highlight.js/styles/stackoverflow-dark.css";
import css_stackoverflow_light from "highlight.js/styles/stackoverflow-light.css";
import css_base16_gruvbox_dark_medium from "highlight.js/styles/base16/gruvbox-dark-medium.css";
import css_base16_gruvbox_light_medium from "highlight.js/styles/base16/gruvbox-light-medium.css";
import css_base16_solarized_dark from "highlight.js/styles/base16/solarized-dark.css";
import css_base16_solarized_light from "highlight.js/styles/base16/solarized-light.css";
import css_panda_syntax_dark from "highlight.js/styles/panda-syntax-dark.css";
import css_panda_syntax_light from "highlight.js/styles/panda-syntax-light.css";
import css_kimbie_dark from "highlight.js/styles/kimbie-dark.css";
import css_kimbie_light from "highlight.js/styles/kimbie-light.css";
import css_a11y_dark from "highlight.js/styles/a11y-dark.css";
import css_a11y_light from "highlight.js/styles/a11y-light.css";
import css_monokai_sublime from "highlight.js/styles/monokai-sublime.css";
import css_base16_dracula from "highlight.js/styles/base16/dracula.css";
import css_nord from "highlight.js/styles/nord.css";
import css_night_owl from "highlight.js/styles/night-owl.css";
import css_base16_material_darker from "highlight.js/styles/base16/material-darker.css";
import css_xcode from "highlight.js/styles/xcode.css";
import css_intellij_light from "highlight.js/styles/intellij-light.css";
import { CODE_THEME_PRESETS, DEFAULT_CODE_THEME, VSCODE_THEME_ID, presetFile, hljsBaseColors, convertVscodeTheme, parseJsonc, type ConvertedTheme } from "../code-themes";

const CSS: Record<string, string> = {
    "atom-one-dark": css_atom_one_dark,
    "atom-one-light": css_atom_one_light,
    "github-dark": css_github_dark,
    "github": css_github,
    "github-dark-dimmed": css_github_dark_dimmed,
    "vs2015": css_vs2015,
    "vs": css_vs,
    "tokyo-night-dark": css_tokyo_night_dark,
    "tokyo-night-light": css_tokyo_night_light,
    "stackoverflow-dark": css_stackoverflow_dark,
    "stackoverflow-light": css_stackoverflow_light,
    "base16/gruvbox-dark-medium": css_base16_gruvbox_dark_medium,
    "base16/gruvbox-light-medium": css_base16_gruvbox_light_medium,
    "base16/solarized-dark": css_base16_solarized_dark,
    "base16/solarized-light": css_base16_solarized_light,
    "panda-syntax-dark": css_panda_syntax_dark,
    "panda-syntax-light": css_panda_syntax_light,
    "kimbie-dark": css_kimbie_dark,
    "kimbie-light": css_kimbie_light,
    "a11y-dark": css_a11y_dark,
    "a11y-light": css_a11y_light,
    "monokai-sublime": css_monokai_sublime,
    "base16/dracula": css_base16_dracula,
    "nord": css_nord,
    "night-owl": css_night_owl,
    "base16/material-darker": css_base16_material_darker,
    "xcode": css_xcode,
    "intellij-light": css_intellij_light,
};

/** The live code theme: its stylesheet, and the colours to paint code SURFACES with (`--code-bg`/`--code-fg`).
 *  No colours for the default, which draws on the panel's own surface colours exactly as it always has. */
export interface ActiveCodeTheme { css: string; bg?: string; fg?: string }

let converted: { text: string; theme: ConvertedTheme } | null = null;
/** A stored VS Code theme, converted once per distinct file rather than on every theme switch. */
export function convertStored(custom: { name: string; text: string }): ConvertedTheme {
    if (converted?.text !== custom.text) converted = { text: custom.text, theme: convertVscodeTheme(parseJsonc(custom.text), custom.name) };
    return converted.theme;
}

/**
 * Which stylesheet colours code right now.
 * @param id a preset id, or `vscode` for the uploaded theme.
 * @param custom the uploaded theme, when there is one. A `vscode` choice without one (or with one that no longer
 *   converts) falls back to the default rather than to no colours at all.
 * @param panel the panel's resolved light/dark, which a preset PAIR follows.
 */
export function activeCodeTheme(id: string, custom: { name: string; text: string } | null, panel: "dark" | "light"): ActiveCodeTheme {
    if (id === VSCODE_THEME_ID && custom) {
        try { const t = convertStored(custom); return { css: t.css, bg: t.bg, fg: t.fg }; } catch { /* fall through to the default */ }
    }
    const { preset, file } = presetFile(id === VSCODE_THEME_ID ? DEFAULT_CODE_THEME : id, panel);
    const css = CSS[file] ?? "";
    if (preset.id === DEFAULT_CODE_THEME) return { css };
    const { bg, fg } = hljsBaseColors(css);
    return { css, ...(bg ? { bg } : {}), ...(fg ? { fg } : {}) };
}

export { CODE_THEME_PRESETS };
