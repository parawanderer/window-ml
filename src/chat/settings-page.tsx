// settings-page.tsx — the chat app's settings as a SHEET, laid out like the search page: one column, a title, no band
// across the top, and Escape (or the back arrow) returns to where you were.
//
// Two tabs, owned by different things. "This page" is the device's own display preferences (view-mode.tsx), so
// it is there on every build, the web one included. The browser's settings are whatever the entry's
// `ChatExtras.settings` hands over — the extension's own settings view — and appear only where a runtime reports
// `localSettings` and this device can draw it; this file knows nothing about config, which keeps `src/chat/` free of
// `chrome`.
import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { IconBack } from "../sidebar/icons";
import { mainView, useEscapeCloses } from "./nav";
import { CODE_SIZES, codeSize, setCodeSize } from "./view-mode";

/** Which half of the settings is showing. Not stored: the sheet opens on this page's own, which is the half that is
 *  always there. */
type SettingsTab = "page" | "extension";

/**
 * The settings sheet: this page's display settings, and the extension's where there are any.
 *
 * Two TABS rather than two sections one above the other, because they are different kinds of thing and were reading
 * as one list: the first is how this device draws this page (a preference, stored here), the second is the
 * extension's configuration (the backend, the models, the key), the same view the DevTools panel shows and shared by
 * everything the extension draws.
 */
export function SettingsPage({ browser }: { browser?: ComponentChildren | null }) {
    const [tab, setTab] = useState<SettingsTab>("page");
    useEscapeCloses();
    const shown: SettingsTab = browser ? tab : "page";
    return (
        <main class="chat-main chat-settings" aria-label="Settings">
            <div class="view chat-sheet-scroll">
                <div class="chat-sheet-col">
                    <SheetHead title="Settings" back="Close settings" />
                    {browser ? (
                        <div class="chat-seg chat-set-tabs" role="tablist" aria-label="Settings">
                            <button role="tab" aria-selected={shown === "page"} class={`chat-seg-opt${shown === "page" ? " on" : ""}`} onClick={() => setTab("page")}>This page</button>
                            <button role="tab" aria-selected={shown === "extension"} class={`chat-seg-opt${shown === "extension" ? " on" : ""}`} onClick={() => setTab("extension")}>Extension</button>
                        </div>
                    ) : null}
                    {shown === "page" ? (
                        <section class="chat-set-group" aria-label="This page">
                            <div class="chat-set-row">
                                <div class="chat-set-label">
                                    <span>Code size</span>
                                    <span class="chat-set-hint">Code blocks, the Python bench, and what it prints. The prose keeps its size.</span>
                                </div>
                                <div class="chat-seg" role="radiogroup" aria-label="Code size">
                                    {CODE_SIZES.map((o) => (
                                        <button key={o.px} role="radio" aria-checked={codeSize.value === o.px}
                                            class={`chat-seg-opt${codeSize.value === o.px ? " on" : ""}`} onClick={() => setCodeSize(o.px)}>{o.label}</button>
                                    ))}
                                </div>
                            </div>
                            <pre class="code chat-set-sample" aria-hidden="true">{"for i in range(3):\n    print(f\"{i} hello\")"}</pre>
                        </section>
                    ) : (
                        <section class="chat-set-group" aria-label="Extension">
                            <p class="chat-set-lede">The extension's configuration: the same settings the DevTools panel and the toolbar popup edit.</p>
                            <div class="chat-settings-body">{browser}</div>
                        </section>
                    )}
                </div>
            </div>
        </main>
    );
}

/** A sheet's title, with the way back as a round button hanging to its left, so the title lines up with the rows. */
export function SheetHead({ title, back }: { title: string; back: string }) {
    return (
        <div class="chat-sheet-head">
            <button class="tt hbtn chat-sheet-back" aria-label={back} onClick={() => (mainView.value = null)}>
                <IconBack /><span class="tt-pop" role="tooltip">{back}</span>
            </button>
            <h1 class="chat-sheet-title">{title}</h1>
        </div>
    );
}
