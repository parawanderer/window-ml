// theme.ts — THE APP'S COLOURS AND SIZES, taken from the chat page's own tokens (src/sidebar/sidebar.css `:root`, and
// calm view's darker canvas in src/chat/chat.css), so the native chrome and the transcript in its WebView read as one
// surface. Light is the page's light theme; dark is calm view's dark, where the canvas is the darkest thing on screen
// and what you type into is raised out of it.

import { useColorScheme } from "react-native";
import { createContext, useContext } from "react";

/** One theme's palette. Names match the page's CSS custom properties. */
export interface Palette {
    scheme: "light" | "dark";
    bg: string;
    panel: string;
    panel2: string;
    border: string;
    fg: string;
    fgDim: string;
    fgFaint: string;
    accent: string;
    accentFg: string;
    userBg: string;
    ok: string;
    err: string;
    warn: string;
    /** a count of things waiting on the person: cyan on a phone, as the page's touch rule has it */
    notice: string;
    noticeFg: string;
}

/** The light palette: sidebar.css `:root[data-theme="light"]`. */
export const LIGHT: Palette = {
    scheme: "light", bg: "#ffffff", panel: "#f4f4f5", panel2: "#e4e4e7", border: "#e4e4e7", fg: "#18181b",
    fgDim: "#52525b", fgFaint: "#a1a1aa", accent: "#6366f1", accentFg: "#ffffff", userBg: "#eceef1",
    ok: "#16a34a", err: "#dc2626", warn: "#ca8a04", notice: "#0284c7", noticeFg: "#ffffff",
};

/** The dark palette: calm view's (chat.css `.chat.calm`), over the panel's dark text colours. */
export const DARK: Palette = {
    scheme: "dark", bg: "#121316", panel: "#1c1d21", panel2: "#2a2b31", border: "#2a2b31", fg: "#e4e4e7",
    fgDim: "#a1a1aa", fgFaint: "#71717a", accent: "#6366f1", accentFg: "#ffffff", userBg: "#2a2b31",
    ok: "#4ade80", err: "#f87171", warn: "#eab308", notice: "#38bdf8", noticeFg: "#082f49",
};

/** Sizes shared by every screen: the page's calm type scale at a phone's reading size, and a 44pt touch target. */
export const SIZE = {
    text: 16,
    small: 13.5,
    title: 28,
    heading: 17,
    target: 44,
    gutter: 16,
    radius: 14,
};

/** The theme the person chose in Settings: follow the system, or one of the two. */
export type ThemeChoice = "system" | "light" | "dark";

/** The chosen theme, provided at the root (App.tsx). */
export const ThemeChoiceContext = createContext<{ choice: ThemeChoice; setChoice: (c: ThemeChoice) => void }>({ choice: "system", setChoice: () => {} });

/** The palette in force: the person's choice, or the system's when they chose "system". */
export function usePalette(): Palette {
    const system = useColorScheme();
    const { choice } = useContext(ThemeChoiceContext);
    const scheme = choice === "system" ? (system === "dark" ? "dark" : "light") : choice;
    return scheme === "dark" ? DARK : LIGHT;
}
