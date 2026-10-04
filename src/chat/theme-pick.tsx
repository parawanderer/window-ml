// theme-pick.tsx — CHOOSING THIS PAGE'S THEME: System, Light, Dark, and "Like the extension" while the extension's own
// Theme setting is not Auto (when it is, following it IS following the system, and a fourth choice that means the
// same as another would only be something to puzzle over). Two shapes of one choice: a row in the gear menu that
// opens into a short list, and a segmented control in Settings → This page.
import { IconCheck, IconTheme } from "../sidebar/icons";
import { MenuGroup } from "./menu";
import { config } from "../sidebar/store";
import { pageThemeMode, setPageThemeMode, type PageThemeMode } from "./view-mode";

const NAMES: Record<string, string> = { auto: "System", light: "Light", dark: "Dark" };

/** The choices on offer, and the one to show as chosen ("extension" shows as System while the extension is on Auto). */
export function themeChoices(): { choices: { id: PageThemeMode; label: string }[]; chosen: PageThemeMode } {
    const ext = config.value.theme;
    const follows = ext === "light" || ext === "dark";
    const choices: { id: PageThemeMode; label: string }[] = [
        ...(follows ? [{ id: "extension" as const, label: `Like the extension (${NAMES[ext]})` }] : []),
        { id: "system", label: "System" }, { id: "light", label: "Light" }, { id: "dark", label: "Dark" },
    ];
    const m = pageThemeMode.value;
    return { choices, chosen: m === "extension" && !follows ? "system" : m };
}

/** The gear menu's row: "Theme · Dark", opening into the choices as radio items. */
export function ThemeMenu() {
    const { choices, chosen } = themeChoices();
    const now = choices.find((c) => c.id === chosen)?.label.replace(/^Like the extension.*/, "Extension") ?? "";
    return (
        <MenuGroup icon={<IconTheme />} label="Theme for this page" detail={now}>
            {(open) => choices.map((c, i) => (
                <button key={c.id} class="chat-menu-item chat-menu-sub" role="menuitemradio" aria-checked={c.id === chosen}
                    style={`--i:${i}`} tabIndex={open ? 0 : -1} onClick={() => setPageThemeMode(c.id)}>
                    <span class="chat-menu-label">{c.label}</span>
                    {c.id === chosen ? <span class="chat-menu-on" aria-hidden="true"><IconCheck /></span> : null}
                </button>
            ))}
        </MenuGroup>
    );
}

/** Settings → This page: the same choice as a segmented control. */
export function ThemeSeg() {
    const { choices, chosen } = themeChoices();
    return (
        <div class="chat-seg" role="radiogroup" aria-label="Theme">
            {choices.map((c) => (
                <button key={c.id} role="radio" aria-checked={c.id === chosen} class={`chat-seg-opt${c.id === chosen ? " on" : ""}`}
                    onClick={() => setPageThemeMode(c.id)}>{c.id === "extension" ? "Extension" : c.label}</button>
            ))}
        </div>
    );
}
