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
    /** a message to a session: steers a running agent, or starts its next turn */
    sendToSession(session: string, text: string, images?: string[]): void;
    cancelSession(session: string): void;
    /** continue a run stopped at its step cap, or retry a failed one */
    continueSession(session: string): void;
    /** outline something on the session's page; `null` clears it. A host with no page does nothing. */
    highlight(ref: HighlightRef): void;
    /** show an image full-size */
    openLightbox(src: string): void;
    /** host-permission checks for a credentialed fetch; null where the host has no such permissions */
    hostAccess: { has(pattern: string): Promise<boolean>; request(pattern: string): Promise<void> } | null;
    /** a Google Sheet's title by id, or null when it cannot be read here */
    sheetTitle(id: string): Promise<string | null>;
    /** persist a display preference (the bench's state, and the like) */
    savePref(key: string, value: unknown): void;
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
    sendToSession() {},
    cancelSession() {},
    continueSession() {},
    highlight() {},
    openLightbox() {},
    hostAccess: null,
    sheetTitle: async () => null,
    savePref() {},
    storedTable: null,
};

let current: SidebarServices = UNAVAILABLE;

/** The installed services. Read at CALL time, never captured at import, so installing later still takes effect. */
export const services = (): SidebarServices => current;

/** Install the host's services. Called once by an entry point, before it renders. */
export function installServices(s: SidebarServices): void {
    current = s;
}
