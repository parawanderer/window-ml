// user-focus.ts — WHERE THE USER IS, relative to an agent run, as the one line `chat_metadata` adds. Pure: the worker
// reads the browser's focus and hands it here, and the rules about what may be said live in one tested place.
//
// Said only when it DIFFERS from the agent's own tab (the tool's description tells the model that no line means the
// user is on its page). What it may name depends on who can READ the run's results. Every agent run with a tab
// executes through that page's own `ml.createAgent` — the chat page's and the HUD's included — so the page reads the
// answer, and naming the site the user has open elsewhere would hand it to that page: the confused-deputy shape the
// background's other guards exist for. So such a run is COARSE ("another tab"); FULL (the site and the title) is for
// a run no page can read, which today is none, and a headless agent would be. Never a full URL (a query string
// carries tokens), never anything about a private window, and always the moment it was read, since focus moves.

/** What the worker knows about the user's focus at one moment. */
export interface FocusSnapshot {
    /** Is a browser window focused at all? False when the user is in another application. */
    browserFocused: boolean;
    /** The active tab of the focused window, when there is one. */
    tab?: { tabId: number; url: string; title: string; incognito: boolean };
    /** when it was read, epoch ms */
    at: number;
}

/** How much the run may be told: a run a page can read gets no identity for another tab. */
export type FocusDetail = "coarse" | "full";

/** The extension's own chat page, as the worker names it (`chrome.runtime.getURL("chat.html")`). */
export interface FocusContext {
    /** the agent's own tab, or null for a run with no tab (a chat the worker hosts, a headless run) */
    agentTabId: number | null;
    /** the run's session hash, to tell "reading this run in the chat page" from "reading another" */
    runHash: string;
    chatPageUrl: string;
    detail: FocusDetail;
}

/** `11:52:03`, local time: when the snapshot was read. */
function clock(ms: number): string {
    const d = new Date(ms);
    return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}

/** The session a chat page URL has open (`#s=<runtime>:<hash>`), or null. */
function chatPageSession(url: string, chatPageUrl: string): { runtime: string; hash: string } | null | undefined {
    if (!url.startsWith(chatPageUrl)) return undefined;   // not the chat page at all
    const m = /[#&]s=([^&]+)/.exec(url.slice(chatPageUrl.length));
    if (!m) return null;
    const key = decodeURIComponent(m[1]);
    const at = key.lastIndexOf(":");
    return at > 0 ? { runtime: key.slice(0, at), hash: key.slice(at + 1) } : null;
}

/** A site's host without `www.`, or null for something that is not an http(s) URL. */
function siteOf(url: string): string | null {
    try {
        const u = new URL(url);
        return /^https?:$/.test(u.protocol) ? u.host.replace(/^www\./, "") : null;
    } catch { return null; }
}

/**
 * The `user focus` line for `chat_metadata`, or null when there is nothing to say: the user is on the agent's own
 * tab, or the snapshot is missing. Dense on purpose (a model reads it and pays for every character).
 */
export function userFocusLine(f: FocusSnapshot | null, c: FocusContext): string | null {
    if (!f) return null;
    const when = `(as of ${clock(f.at)})`;
    if (!f.browserFocused) return `user focus: away from the browser ${when}`;
    const t = f.tab;
    if (!t) return `user focus: no tab in view ${when}`;
    if (c.agentTabId != null && t.tabId === c.agentTabId) return null;
    const chat = chatPageSession(t.url, c.chatPageUrl);
    if (chat !== undefined) {
        const here = chat && chat.hash === c.runHash;
        return `user focus: the chat page, ${here ? "reading this conversation" : "not on this conversation"} ${when}`;
    }
    // Coarse (every run with a page behind it, today) folds these into "another tab": that a private window is open
    // is itself something the page has no business learning.
    if (c.detail === "coarse") return `user focus: another tab ${when}`;
    if (t.incognito) return `user focus: a private window ${when}`;
    const site = siteOf(t.url);
    if (!site) return `user focus: another tab (a browser page) ${when}`;
    // A title is text the SITE wrote, going into the model's context: one line, cut short, and with its own quotes
    // turned so it cannot close the quote it sits in and read as the tool's own words.
    const title = t.title.replace(/\s+/g, " ").replace(/"/g, "'").trim().slice(0, 80);
    return `user focus: another tab, ${site}${title ? ` "${title}"` : ""} ${when}`;
}
