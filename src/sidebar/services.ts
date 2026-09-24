// THE SERVICES SEAM: what the shared session components need from whatever hosts them, as one injected object.
//
// The session views (agent runs, chat turns, output cells, code blocks, approvals, the composer) render in the
// in-page sidebar, the DevTools panel and the Commander HUD today, and in the chat page and a phone app next
// (docs/spec/CHAT_PAGE.md). They used to call `chrome.*` and `window.parent.postMessage` directly, which ties them
// to an extension frame. They call this instead, and each entry point installs an implementation: the extension
// frames install `services-ext.ts` (the same calls as before), the chat core installs one over a `SessionHost`.
//
// No `chrome` here, and nothing that imports it: a bundle without the extension must be able to include this file.
//
// Session identifiers are the session's KEY in this client (`Session.hash`): the bare hash for the sidebar's own
// sessions, `runtime:hash` in the chat page. An implementation that needs the bare hash takes it with `bareHash`.

import type { SendOutcome } from "./drafts";

/** A small utility-model call the UI makes about a session: its title, a block summary, `explain` notes, an
 *  approval gloss. Mirrors the contract's `side.call`: the caller supplies the messages, the host always uses its
 *  utility profile. */
export interface SideCallRequest {
    purpose: "title" | "summary" | "explain";
    /** the session it is about (its key), for the request hint */
    session: string;
    messages: { role: string; content: string }[];
    schema?: object;
    maxTokens: number;
}
/** A side call's answer. `requestId` joins the call to the server's record of it on the event lane. */
export type SideCallResult = { ok: true; content: string; requestId?: string } | { ok: false; error: string };

/** A page element or canvas point the UI outlines on the session's page. `kind: "approve"` marks the target of an
 *  approval being considered. */
export type HighlightRef = { selector?: string; token?: string; kind?: "approve" } | null;

/** Everything the shared session components ask of their host. */
export interface SidebarServices {
    sideCall(req: SideCallRequest): Promise<SideCallResult>;
    /** Can a side call about this session be made here? The extension asks whether a utility model is set; a
     *  session host asks the session's runtime (its `sideCalls` capability). Read during render, so an
     *  implementation over signals keeps the caller subscribed. */
    sideCalls(session: string): boolean;
    /** Is there a Python bench to open a script in? Only the extension frames have one today. */
    bench: boolean;
    /** answer an approval gate by the pending step's `seq` */
    answerApproval(session: string, seq: number, decision: boolean, persist: boolean): void;
    /** A message to a session: steers a running agent, or starts its next turn. Resolves when the host knows whether it
     *  was taken, so the composer can put the text back on a failure (drafts.ts); never rejects. */
    sendToSession(session: string, text: string, images?: string[]): Promise<SendOutcome>;
    cancelSession(session: string): void;
    /** continue a run stopped at its step cap, or retry a failed one. `maxSteps` is a budget chosen for this
     *  continuation; omitted keeps the run's own. A retry never carries one — it is the same turn again. */
    continueSession(session: string, maxSteps?: number): void;
    /** outline something on the session's page; `null` clears it. A host with no page does nothing. */
    highlight(ref: HighlightRef): void;
    /** show an image full-size */
    openLightbox(src: string): void;
    /** Open a URL AWAY from this surface — a new tab in a browser, the system browser from the phone app. Never a
     *  navigation of the surface itself: this page IS the client, and leaving it drops the hub connection. */
    openLink(url: string): void;
    /** host-permission checks for a credentialed fetch; null where the host has no such permissions */
    hostAccess: { has(pattern: string): Promise<boolean>; request(pattern: string): Promise<void> } | null;
    /** a Google Sheet's title by id, or null when it cannot be read here */
    sheetTitle(id: string): Promise<string | null>;
    /** persist a display preference (the bench's state, and the like) */
    savePref(key: string, value: unknown): void;
    /** Hand a finished file to the person: a download in a browser, the share sheet on a phone. The EXPORTS go
     *  through this, which is why it is here rather than left to each surface's own download helper. */
    saveFile(name: string, data: Blob): void;
    /**
     * Print a rendered, self-contained document — the PDF export, which is really "print this, choose Save as PDF".
     * NULL WHERE NOTHING HERE CAN PRINT, and that is not a detail a caller may skip: a phone app's WebView has no
     * print dialog and no tab to open one in, so the export picker offers PDF only where this is set.
     *
     * The extension's own frames pass the document to a real TAB through the background, because `window.print()`
     * is suppressed inside docked DevTools; a plain page prints it in an offscreen iframe of its own.
     */
    printDoc: ((html: string) => void) | null;
    /** The version of whatever is hosting these views, stamped into a JSON export. Null where there is no such
     *  number — a page served from a build has its commit (`BUILD_INFO`) and nothing else. */
    appVersion: string | null;
    /** An ABSOLUTE url for a file shipped beside this surface (`fonts/KaTeX_Math-Italic.woff2`). The print document
     *  renders from a blob url, whose relative paths resolve against the origin ROOT rather than against wherever
     *  this page is served from, so a relative reference in it silently 404s. */
    assetUrl(path: string): string;
    /**
     * Load the page of events before the oldest one held for a session, for a reference that points further back than
     * what is loaded (transcript-window.tsx `reveal`). Resolves with whether anything older can still be loaded. Null
     * where the host cannot page: the extension panel holds a run's whole log already.
     */
    loadEarlier: ((session: string) => Promise<{ more: boolean }>) | null;
    /** Every row of a STORED table (a render's `value` key; docs/spec/POINTER_VALUES.md), as column arrays, for the table
     *  view's whole-table summary and copy. Rejects with the store's reason when the value is gone. `null` where this host
     *  cannot reach a value store: the view then works over its preview and says so. */
    storedTable: ((key: string, opts: StoredTableRead) => Promise<{ rowCount: number; columns: Record<string, (string | number | boolean | null)[]> }>) | null;
}

/** How to read a stored table: its column names, and the split decisions its preview made (for a delimited body). */
export interface StoredTableRead { columns: string[]; delimiter?: string; headerless?: boolean }

/** The session's bare hash from its key: the part after the last `:`, or the key itself when it has none. */
export const bareHash = (key: string): string => key.slice(key.lastIndexOf(":") + 1);

/** A step's session key from a `stepKey` (`<session key>:<seq>`), splitting on the LAST `:` because a session key
 *  may itself contain one (`runtime:hash`). */
export function splitStepKey(key: string): { session: string; seq: number } {
    const i = key.lastIndexOf(":");
    return { session: key.slice(0, i), seq: Number(key.slice(i + 1)) };
}

/** Before an entry point installs anything: every call answers "not available here" rather than throwing, so a
 *  renderer used somewhere unexpected degrades instead of breaking. */
const UNAVAILABLE: SidebarServices = {
    sideCall: async () => ({ ok: false, error: "no host is installed" }),
    sideCalls: () => false,
    bench: false,
    answerApproval() {},
    sendToSession: async () => ({ ok: false, error: "no host is installed" }),
    cancelSession() {},
    continueSession() {},
    highlight() {},
    openLightbox() {},
    openLink() {},
    hostAccess: null,
    sheetTitle: async () => null,
    savePref() {},
    saveFile() {},
    printDoc: null,
    appVersion: null,
    assetUrl: (path) => path,
    loadEarlier: null,
    storedTable: null,
};

let current: SidebarServices = UNAVAILABLE;

/** The installed services. Read at CALL time, never captured at import, so installing later still takes effect. */
export const services = (): SidebarServices => current;

/** Install the host's services. Called once by an entry point, before it renders. */
export function installServices(s: SidebarServices): void {
    current = s;
}
