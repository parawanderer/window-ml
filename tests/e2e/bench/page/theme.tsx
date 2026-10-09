// theme.tsx — the bench pages' theme: auto (the system's), light or dark, remembered per browser; shared by the sweep
// page and the scoreboard.

import { useState, useEffect } from "preact/hooks";

type Theme = "auto" | "light" | "dark";

const THEME_KEY = "benchTheme";

/** Remembered per browser; guarded, since a saved report opened from file:// can throw on localStorage. */
export const readTheme = (): Theme => { try { const t = localStorage.getItem(THEME_KEY); return t === "light" || t === "dark" ? t : "auto"; } catch { return "auto"; } };

export const applyTheme = (t: Theme) => { if (t === "auto") delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t; };

/** Auto (follow the system), light, dark: one button that says what it is now and switches to the next. */
export function ThemeToggle() {
    const [theme, setTheme] = useState<Theme>(readTheme);
    useEffect(() => { applyTheme(theme); try { localStorage.setItem(THEME_KEY, theme); } catch { /* private mode */ } }, [theme]);
    const next: Record<Theme, Theme> = { auto: "light", light: "dark", dark: "auto" };
    const icon = { auto: "◐", light: "☀", dark: "☾" }[theme];
    return <button class="btn small tt" data-tip={`Theme: ${theme}${theme === "auto" ? " (follows the system)" : ""}. Click for ${next[theme]}.`} aria-label={`Theme: ${theme}`} onClick={() => setTheme(next[theme])}>{icon} {theme}</button>;
}
