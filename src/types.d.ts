// Ambient module declarations for deps that ship no TypeScript types.

// turndown-plugin-gfm: GFM tables/strikethrough/task-lists for Turndown. No @types package; its API is a
// set of plugin functions passed to a TurndownService's `.use()`.
declare module "turndown-plugin-gfm" {
    import type TurndownService from "turndown";
    type Plugin = (service: TurndownService) => void;
    export const gfm: Plugin;
    export const tables: Plugin;
    export const strikethrough: Plugin;
    export const taskListItems: Plugin;
}
