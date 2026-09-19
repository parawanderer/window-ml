// Applies stored prefs to the DOM root for the debug sidebar: theme (data-theme +
// the active code theme's highlight CSS), font scale (--fs), and code-block display
// (data-codewrap / data-codelines). Extracted so both the Settings UI and the app
// bootstrap can drive them without a cycle. The code themes themselves live in
// code-theme-css.ts (the stylesheets) and code-themes.ts (presets + the VS Code converter).
import katexCss from "katex/dist/katex.min.css";
import { signal } from "@preact/signals";
import { config, fontScale, codeWrap, codeLineNumbers, focusMode, BASE_FS, codeTheme, codeThemeCustom, codeThemeUi } from "./store";
import { activeCodeTheme, convertStored } from "./code-theme-css";
import { PANEL_TOKENS, VSCODE_THEME_ID, type ConvertedTheme } from "../code-themes";

/** The uploaded VS Code theme when it is colouring the whole panel — chosen, loaded, converting, and the panel
 *  toggle on — else null. While it is, the panel's light/dark is the theme's own and the Theme setting is moot. */
export const panelThemeActive = (): ConvertedTheme | null => {
    const custom = codeThemeCustom.value;
    if (codeTheme.value !== VSCODE_THEME_ID || !codeThemeUi.value || !custom) return null;
    try { return convertStored(custom); } catch { return null; }
};

/**
 * A page's OWN theme, over the extension's Theme setting: the chat page's choice (view-mode.tsx), so a page for
 * thinking can be light while the DevTools panel and the HUD stay dark. null follows the extension. While set, it wins
 * over an uploaded VS Code theme colouring the panel too, since that is also the extension's choice.
 */
export const pageTheme = signal<"system" | "light" | "dark" | null>(null);

let hljsStyleEl: HTMLStyleElement | null = null;   // holds the active code theme's stylesheet
const themeMedia = window.matchMedia("(prefers-color-scheme: dark)");

/** The theme to draw in — the explicit choice, else the OS preference. */
export const resolveTheme = (): "dark" | "light" => {
    const own = pageTheme.value;
    if (own === "light" || own === "dark") return own;
    if (own === "system") return themeMedia.matches ? "dark" : "light";
    const ui = panelThemeActive();
    if (ui) return ui.type;
    const t = config.value.theme;
    return (t === "light" || t === "dark") ? t : (themeMedia.matches ? "dark" : "light");
};
/** Put the resolved theme on the root element, which is where every colour token is defined. */
export const applyTheme = (): void => {
    const t = resolveTheme();
    document.documentElement.setAttribute("data-theme", t);
    applyCodeTheme(t);
    applyPanelPalette();
    // Tell the shell our AUTHORITATIVE resolved theme so the off-mode card's acrylic
    // (drawn page-side, in the shell's shadow root) matches. The shell resolves theme
    // from the CONTENT-SCRIPT window's matchMedia, which is unreliable on some hosts
    // (GitHub reports light there) — that split-brain painted a white acrylic behind
    // our transparent card. This iframe's resolution is the correct one; the shell
    // ignores the message unless it's the card frame. See shell.ts onMessage.
    try { window.parent?.postMessage({ __mlSidebarCardTheme: t }, "*"); } catch { /* not framed */ }
};
themeMedia.addEventListener("change", applyTheme);

/** The panel's own colours from an uploaded VS Code theme (`panelThemeActive`), as inline tokens on the root —
 *  which win over the light/dark palettes in sidebar.css. Every token is removed when it is off, so the panel
 *  returns to exactly its own palette. */
const applyPanelPalette = (): void => {
    const ui = pageTheme.value ? null : panelThemeActive();
    const root = document.documentElement.style;
    for (const token of PANEL_TOKENS) {
        const v = ui?.panel[token];
        if (v) root.setProperty(token, v); else root.removeProperty(token);
    }
};

/** The code colour theme (Settings → Code blocks): its stylesheet, plus the surface colours code blocks and the
 *  bench editor paint with. Those two ride `--code-bg`/`--code-fg` on the root, and are REMOVED for the default,
 *  which draws on the panel's own colours — so a theme whose light/dark differs from the panel's (a dark theme
 *  in a light panel) still puts its light tokens on its own dark background, not on the panel's white. */
export const applyCodeTheme = (panel: "dark" | "light" = resolveTheme()): void => {
    const active = activeCodeTheme(codeTheme.value, codeThemeCustom.value, panel);
    if (hljsStyleEl) hljsStyleEl.textContent = active.css;
    const root = document.documentElement.style;
    const set = (name: string, v: string | undefined) => { if (v) root.setProperty(name, v); else root.removeProperty(name); };
    set("--code-bg", active.bg);
    set("--code-fg", active.fg);
    // The editor's chrome. A VS Code theme names its own; a preset names none, so its selection is a faint tint of
    // its own text colour — the panel's accent at the old strength was a bright lavender wash over the tokens.
    set("--code-sel", active.ui?.selection ?? (active.fg ? `color-mix(in srgb, ${active.fg} 22%, transparent)` : undefined));
    set("--code-line", active.ui?.lineHighlight);
    set("--code-cursor", active.ui?.cursor);
    set("--code-lno", active.ui?.lineNumber);
    // Read-only blocks select text natively; this lets their selection follow the theme too (sidebar.css).
    if (active.bg) document.documentElement.setAttribute("data-code-themed", ""); else document.documentElement.removeAttribute("data-code-themed");
};

// Create the <style> element that holds the active highlight theme + apply once.
// Called from mount() (needs document.head to exist).
export const initThemeStyle = (): void => {
    // KaTeX's stylesheet (static, theme-independent). Its @font-face url()s are `fonts/KaTeX_*.woff2`,
    // resolved relative to sidebar.html → the fonts copied to dist/fonts/ by the build. Injected once.
    const katexStyle = document.createElement("style");
    katexStyle.textContent = katexCss;
    document.head.append(katexStyle);
    hljsStyleEl = document.createElement("style");
    document.head.append(hljsStyleEl);
    applyTheme();
};

// Font scale → the --fs custom property the content sizes key off.
export const applyFont = (): void => {
    document.documentElement.style.setProperty("--fs", `${(BASE_FS * fontScale.value).toFixed(2)}px`);
};
// Code-block prefs ride root data-attributes (like the theme) so all code blocks
// react at once; line numbers also need a signal, since it changes the markup.
export const applyCodePrefs = (): void => {
    document.documentElement.setAttribute("data-codewrap", codeWrap.value ? "on" : "off");
    document.documentElement.setAttribute("data-codelines", codeLineNumbers.value ? "on" : "off");
};

/** Focus mode rides a root attribute for the same reason the code prefs do: it is purely presentational, so
 *  CSS can own all of it and no component has to learn about it. Keeping it out of the markup also means an
 *  element hidden here is still THERE — the transcript a reader is looking at is the same one they can export,
 *  search, or read with the mode off. */
export const applyFocus = (): void => {
    document.documentElement.toggleAttribute("data-focus", focusMode.value);
};
