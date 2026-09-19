// settings-page.tsx — this browser's settings as a SHEET of the chat app, laid out like the search page: one column,
// a title, no band across the top, and Escape (or the back arrow) returns to where you were.
//
// It draws whatever the entry's `ChatExtras.settings` hands it — the extension's own settings view — and knows nothing
// about config itself, which is what keeps `src/chat/` free of `chrome`.
import type { ComponentChildren } from "preact";
import { IconBack } from "../sidebar/icons";
import { mainView, useEscapeCloses } from "./nav";

/** The settings sheet, around the settings view this device can draw. */
export function SettingsPage({ children }: { children: ComponentChildren }) {
    useEscapeCloses();
    return (
        <main class="chat-main chat-settings" aria-label="Settings">
            <div class="view chat-sheet-scroll">
                <div class="chat-sheet-col">
                    <button class="nav chat-sheet-back" aria-label="Close settings" onClick={() => (mainView.value = null)}><IconBack /></button>
                    <h1 class="chat-sheet-title">Settings</h1>
                    <div class="chat-settings-body">{children}</div>
                </div>
            </div>
        </main>
    );
}
