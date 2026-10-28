// Shared element IDs for the debug-sidebar shell. The shell (sidebar/shell.ts) creates
// these nodes; the page-side hit-testing (locate.ts `withHiddenSidebar`) and the screenshot
// bridge reference the same IDs to hide/detect the overlay — so they live in one place
// rather than as magic strings that could silently drift apart.
export const SB_ROOT = "ml-sb-root";         // host container; its presence = the sidebar is mounted
export const SB_HOST = "ml-sb-host";         // the fixed, right-docked panel (overlays the page)
export const SB_TAB = "ml-sb-tab";           // the always-visible pull tab
export const SB_FRAME = "ml-sb-frame";       // the iframe holding the Preact app
export const SB_LIGHTBOX = "ml-lightbox";    // full-viewport image lightbox (a sibling overlay)
export const SB_LIGHTBOX_X = "ml-lightbox-x";
export const SB_HIGHLIGHT = "ml-highlight";  // DevTools-style hover highlight box (positioned over a page element; never mutates it)
export const SB_CARD = "ml-sb-card";         // off-mode acrylic approval CARD host (a separate shadow host from the overlay shell)
/** The id of the shell's own stylesheet, the first child of each of its shadow roots: the mark a tool that crosses shadow
 *  boundaries tells our root by. The page can neither put a node into a closed root of ours nor take one out, whereas the
 *  HOST's id is an attribute in the page's document that it can change or remove. */
export const SB_STYLE = "ml-sb-style";

/** Is `id` one the shell gives its own UI (a shadow host or a node of ours)? Tools that cross shadow boundaries skip a
 *  host with one, and a root holding a child with one ({@link SB_STYLE}): our roots are closed to the page, and no tool of
 *  the page's may open them. */
export const isOwnUiId = (id: string): boolean => /^ml-(sb-|lightbox|highlight)/.test(id);

/** The event the main-world DOM tools (dom.ts) dispatch on window to get the reader of the closed shadow roots that
 *  shadow-patch.ts captured, which keeps them in its closure. */
export const CLOSED_ROOTS_EVENT = "wml-closed-roots";

/** A random custom-element name with no `ml-` in it, so a page cannot tell the highlight's host by its tag. */
export function anonymousTag(): string {
    const letters = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => String.fromCharCode(97 + (b % 26))).join("");
    for (;;) { const tag = `${letters(5)}-${letters(6)}`; if (!tag.includes("ml-")) return tag; }
}
