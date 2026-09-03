// The extension's devtools_page (manifest). It runs once when DevTools opens on a tab,
// and its only job is to register the "ml" panel. The panel itself (panel.html) hosts
// the same sidebar app as the in-page overlay — see sidebar/panel.ts. (`chrome` is the
// @types/chrome global — no local declare, which would poison the type project-wide.)
chrome.devtools.panels.create("window.ml", "", "panel.html", () => { /* panel created */ });
