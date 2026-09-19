// settings-page.tsx — the chat app's settings as a SHEET, laid out like the search page: one column, a title, no band
// across the top, and Escape (or the back arrow) returns to where you were.
//
// Tabs, owned by different things (a third, Runtimes, is every runtime's own facts, read-only: runtime-sheet.tsx). "This page" is the device's own display preferences (view-mode.tsx), so
// it is there on every build, the web one included. The browser's settings are whatever the entry's
// `ChatExtras.settings` hands over — the extension's own settings view — and appear only where a runtime reports
// `localSettings` and this device can draw it; this file knows nothing about config, which keeps `src/chat/` free of
// `chrome`.
import { signal } from "@preact/signals";
import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { IconBack } from "../sidebar/icons";
import { mainView, useEscapeCloses } from "./nav";
import type { ChatStore } from "./chat-store";
import { RuntimeSheet } from "./runtime-sheet";
import { ThemeSeg } from "./theme-pick";
import { CODE_SIZES, PANEL_SIZES, codeSize, panelSize, setCodeSize, setPanelSize } from "./view-mode";

/** Which half of the settings is showing. Not stored: the sheet opens on this page's own, which is the half that is
 *  always there. */
export type SettingsTab = "page" | "runtimes" | "extension" | "housekeeping";

/** The tab Settings shows; set before opening it to land on one (the attention list opens it on Extension). */
export const settingsTab = signal<SettingsTab>("page");

/**
 * The settings sheet: this page's display settings, and the extension's where there are any.
 *
 * Two TABS rather than two sections one above the other, because they are different kinds of thing and were reading
 * as one list: the first is how this device draws this page (a preference, stored here), the second is the
 * extension's configuration (the backend, the models, the key), the same view the DevTools panel shows and shared by
 * everything the extension draws.
 */
export function SettingsPage({ browser, housekeeping, store }: { browser?: ComponentChildren | null; housekeeping?: ComponentChildren | null; store: ChatStore }) {
    const tab = settingsTab.value;
    const setTab = (t: SettingsTab) => { settingsTab.value = t; };
    useEscapeCloses();
    const shown: SettingsTab = (tab === "extension" && !browser) || (tab === "housekeeping" && !housekeeping) ? "page" : tab;
    const tabs: [SettingsTab, string][] = [
        ["page", "This page"], ["runtimes", "Runtimes"],
        ...(browser ? [["extension", "Extension"] as [SettingsTab, string]] : []),
        ...(housekeeping ? [["housekeeping", "Housekeeping"] as [SettingsTab, string]] : []),
    ];
    return (
        <main class="chat-main chat-settings" aria-label="Settings">
            <div class="view chat-sheet-scroll">
                <div class="chat-sheet-col">
                    <SheetHead title="Settings" back="Close settings" />
                    <div class="chat-seg chat-set-tabs" role="tablist" aria-label="Settings">
                        {tabs.map(([id, label]) => (
                            <button key={id} role="tab" aria-selected={shown === id} class={`chat-seg-opt${shown === id ? " on" : ""}`} onClick={() => setTab(id)}>{label}</button>
                        ))}
                    </div>
                    {shown === "page" ? (
                        <section class="chat-set-group" aria-label="This page">
                            <div class="chat-set-row">
                                <div class="chat-set-label">
                                    <span>Theme</span>
                                    <span class="chat-set-hint">This page only. The DevTools panel and the HUD keep the extension's Theme setting.</span>
                                </div>
                                <ThemeSeg />
                            </div>
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
                            <div class="chat-set-row">
                                <div class="chat-set-label">
                                    <span>Panel text size</span>
                                    <span class="chat-set-hint">The docked panels: the resource graphs, the bench's controls, their tabs. Default is the DevTools panel's size.</span>
                                </div>
                                <div class="chat-seg" role="radiogroup" aria-label="Panel text size">
                                    {PANEL_SIZES.map((o) => (
                                        <button key={o.px} role="radio" aria-checked={panelSize.value === o.px}
                                            class={`chat-seg-opt${panelSize.value === o.px ? " on" : ""}`} onClick={() => setPanelSize(o.px)}>{o.label}</button>
                                    ))}
                                </div>
                            </div>
                        </section>
                    ) : shown === "runtimes" ? (
                        <RuntimeSheet store={store} />
                    ) : shown === "housekeeping" ? (
                        <section class="chat-set-group chat-set-hk" aria-label="Housekeeping log">{housekeeping}</section>
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
