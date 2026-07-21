// Applies stored prefs to the DOM root for the debug sidebar: theme (data-theme +
// the active Atom One highlight CSS), font scale (--fs), and code-block display
// (data-codewrap / data-codelines). Extracted so both the Settings UI and the app
// bootstrap can drive them without a cycle. The Atom One themes live here since
// applyTheme is their only consumer.
import atomOneDark from "highlight.js/styles/atom-one-dark.css";
import atomOneLight from "highlight.js/styles/atom-one-light.css";
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
};
themeMedia.addEventListener("change", applyTheme);

// Create the <style> element that holds the active highlight theme + apply once.
// Called from mount() (needs document.head to exist).
export const initThemeStyle = (): void => {
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
