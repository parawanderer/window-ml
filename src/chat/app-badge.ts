// app-badge.ts — THE COUNT ON THE HOME-SCREEN ICON, for the hosted client installed as an app (an iPad, where Apple
// gives a free signing certificate seven days and no more, so the web app is the app).
//
// It is the same number the inbox draws: the things that need a hand, problems only. Nothing new is computed here.
//
// Only while INSTALLED. In a browser tab the Badging API is specified to do nothing, and asking for it there would be
// a permission-shaped question about a surface that cannot show an answer — so the display mode is checked first and
// a tab is left alone. The native app does not use this either: a packaged app's badge belongs to the OS, and that is
// the push work, not this.
//
// What it does NOT do is notify. The badge changes while the page is open or backgrounded; a badge that updates with
// the app closed needs a push to wake a service worker, which is a server, a key pair and a subscription per device.

/** Is this page running as an installed app, rather than in a browser tab? */
function installed(): boolean {
    try {
        // `standalone` is what iOS sets on a home-screen web app; the media query is the standard spelling.
        return matchMedia("(display-mode: standalone)").matches
            || (navigator as unknown as { standalone?: boolean }).standalone === true;
    } catch { return false; }
}

/**
 * Put `n` on the app's icon, or take it off at zero. Silent where the browser has no Badging API, where the page is a
 * tab, or where the call is refused — a decoration that throws would take the page down with it.
 */
export function setAppBadge(n: number): void {
    const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
    if (!nav.setAppBadge || !installed()) return;
    try {
        void (n > 0 ? nav.setAppBadge(n) : nav.clearAppBadge?.() ?? nav.setAppBadge(0)).catch(() => {});
    } catch { /* a browser that lists the method and refuses the call */ }
}
