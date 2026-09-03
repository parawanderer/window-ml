// Applies stored prefs to the DOM root for the debug sidebar: theme (data-theme +
// the active Atom One highlight CSS), font scale (--fs), and code-block display
// (data-codewrap / data-codelines). Extracted so both the Settings UI and the app
// bootstrap can drive them without a cycle. The Atom One themes live here since
// applyTheme is their only consumer.
import atomOneDark from "highlight.js/styles/atom-one-dark.css";
import atomOneLight from "highlight.js/styles/atom-one-light.css";
import katexCss from "katex/dist/katex.min.css";
import { config, fontScale, codeWrap, codeLineNumbers, BASE_FS } from "./store";

let hljsStyleEl: HTMLStyleElement | null = null;   // holds the active Atom One theme
const themeMedia = window.matchMedia("(prefers-color-scheme: dark)");

export const resolveTheme = (): "dark" | "light" => {
    const t = config.value.theme;
    return (t === "light" || t === "dark") ? t : (themeMedia.matches ? "dark" : "light");
};
export const applyTheme = (): void => {
    const t = resolveTheme();
    document.documentElement.setAttribute("data-theme", t);
    if (hljsStyleEl) hljsStyleEl.textContent = t === "dark" ? atomOneDark : atomOneLight;
    // Tell the shell our AUTHORITATIVE resolved theme so the off-mode card's acrylic
    // (drawn page-side, in the shell's shadow root) matches. The shell resolves theme
    // from the CONTENT-SCRIPT window's matchMedia, which is unreliable on some hosts
    // (GitHub reports light there) — that split-brain painted a white acrylic behind
    // our transparent card. This iframe's resolution is the correct one; the shell
    // ignores the message unless it's the card frame. See shell.ts onMessage.
    try { window.parent?.postMessage({ __mlSidebarCardTheme: t }, "*"); } catch { /* not framed */ }
};
themeMedia.addEventListener("change", applyTheme);

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
