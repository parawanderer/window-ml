// settings-sections.ts — the extension settings view's tabs and the sections each draws, by id: what an address may
// name (`settings/extension/advanced/shell`, route.ts). Pure, so the chat page's router reads it without the view.
//
// The view (settings.tsx) is the truth; tests/sidebar-settings.test.js opens every tab and fails when the sections it
// draws differ from this table.

/** The extension settings view's tabs, in the order it shows them. */
export const PANEL_TABS = ["connection", "models", "appearance", "advanced", "permissions"] as const;

/** One tab of the extension settings view. */
export type PanelTab = typeof PANEL_TABS[number];

/** The collapsible sections each panel tab draws, by their `Section` id. */
export const PANEL_SECTIONS: Record<PanelTab, readonly string[]> = {
    connection: [],
    models: ["defaults", "modelFilter", "utility", "embeddings", "grounding"],
    appearance: ["general", "devtools", "spend", "storage", "agenthud", "codeblocks", "runstats", "export"],
    advanced: ["servertools", "javascript", "pointers", "python", "fetch", "focus", "shell", "manifests", "libraries",
        "introspection", "protostream", "shadow", "cdp"],
    permissions: ["waitingrequests", "siteapprovals", "hostaccess", "whitelist", "policies"],
};
