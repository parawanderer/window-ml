// Applies stored prefs to the DOM root for the debug sidebar: theme (data-theme +
// the active code theme's highlight CSS), font scale (--fs), and code-block display
// (data-codewrap / data-codelines). Extracted so both the Settings UI and the app
// bootstrap can drive them without a cycle. The code themes themselves live in
// code-theme-css.ts (the stylesheets) and code-themes.ts (presets + the VS Code converter).
import katexCss from "katex/dist/katex.min.css";
import { config, fontScale, codeWrap, codeLineNumbers, focusMode, BASE_FS, codeTheme, codeThemeCustom } from "./store";
import { activeCodeTheme } from "./code-theme-css";

let hljsStyleEl: HTMLStyleElement | null = null;   // holds the active code theme's stylesheet
const themeMedia = window.matchMedia("(prefers-color-scheme: dark)");

/** The theme to draw in — the explicit choice, else the OS preference. */
export const resolveTheme = (): "dark" | "light" => {
    const t = config.value.theme;
    return (t === "light" || t === "dark") ? t : (themeMedia.matches ? "dark" : "light");
};
/** Put the resolved theme on the root element, which is where every colour token is defined. */
export const applyTheme = (): void => {
    const t = resolveTheme();
    document.documentElement.setAttribute("data-theme", t);
    applyCodeTheme(t);
    // Tell the shell our AUTHORITATIVE resolved theme so the off-mode card's acrylic
    // (drawn page-side, in the shell's shadow root) matches. The shell resolves theme
    // from the CONTENT-SCRIPT window's matchMedia, which is unreliable on some hosts
    // (GitHub reports light there) — that split-brain painted a white acrylic behind
    // our transparent card. This iframe's resolution is the correct one; the shell
    // ignores the message unless it's the card frame. See shell.ts onMessage.
    try { window.parent?.postMessage({ __mlSidebarCardTheme: t }, "*"); } catch { /* not framed */ }
};
themeMedia.addEventListener("change", applyTheme);

/** The code colour theme (Settings → Code blocks): its stylesheet, plus the surface colours code blocks and the
 *  bench editor paint with. Those two ride `--code-bg`/`--code-fg` on the root, and are REMOVED for the default,
 *  which draws on the panel's own colours — so a theme whose light/dark differs from the panel's (a dark theme
 *  in a light panel) still puts its light tokens on its own dark background, not on the panel's white. */
export const applyCodeTheme = (panel: "dark" | "light" = resolveTheme()): void => {
    const active = activeCodeTheme(codeTheme.value, codeThemeCustom.value, panel);
    if (hljsStyleEl) hljsStyleEl.textContent = active.css;
    const root = document.documentElement.style;
    if (active.bg) root.setProperty("--code-bg", active.bg); else root.removeProperty("--code-bg");
    if (active.fg) root.setProperty("--code-fg", active.fg); else root.removeProperty("--code-fg");
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
