// Shared element IDs for the debug-sidebar shell. The shell (sidebar/shell.ts) creates
// these nodes; the page-side hit-testing (som.ts `withHiddenSidebar`) and the screenshot
// bridge reference the same IDs to hide/detect the overlay — so they live in one place
// rather than as magic strings that could silently drift apart.
export const SB_ROOT = "ml-sb-root";         // host container; its presence = the sidebar is mounted
export const SB_HOST = "ml-sb-host";         // the fixed, right-docked panel (overlays the page)
export const SB_TAB = "ml-sb-tab";           // the always-visible pull tab
export const SB_FRAME = "ml-sb-frame";       // the iframe holding the Preact app
export const SB_LIGHTBOX = "ml-lightbox";    // full-viewport image lightbox (a sibling overlay)
export const SB_LIGHTBOX_X = "ml-lightbox-x";
