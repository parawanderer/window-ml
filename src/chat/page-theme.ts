// page-theme.ts — APPLYING the chat page's own theme (`pageThemeMode`, view-mode.tsx): puts the choice on the shared
// theme resolver (`pageTheme`, sidebar/prefs.ts) and draws it again whenever the choice, the extension's Theme setting
// or the system's changes. Its own module because it touches the DOM and `matchMedia`, which only the entries load.
import { effect } from "@preact/signals";
import { applyTheme, pageTheme } from "../sidebar/prefs";
import { config } from "../sidebar/store";
import { pageThemeMode } from "./view-mode";

/** Follow the page's theme choice from now on. The entry calls it once, after `installViewPrefs`. */
export function installPageTheme(): () => void {
    return effect(() => {
        const m = pageThemeMode.value;
        void config.value.theme;   // read, so a change to the extension's setting draws again
        pageTheme.value = m === "extension" ? null : m;
        applyTheme();
    });
}
