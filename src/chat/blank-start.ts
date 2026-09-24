// blank-start.ts — WHETHER A NEW-TAB RUN CAN ACTUALLY START, and what to offer when it cannot.
//
// A run that asked for an empty tab opens a real page (`AGENT_START_PAGE`, or the runtime's own `agentStartPage`),
// and a browser whose site access is limited will not let the extension run there. That failure used to arrive after
// the run was started, as a refusal — so the obvious choice led to a dead end that nothing on screen predicted.
//
// The runtime answers it instead, as a capability (`blankStart`), which is what makes this decidable BEFORE anyone
// presses send and re-decidable the moment a grant lands, with no polling. This module is the pure reading of that
// answer: what state the choice is in, and which ways out exist. The drawing is start-page.tsx's.
//
// The ways out are not the same on every runtime, and that is the whole reason this is a state machine rather than a
// boolean. On a runtime THIS DEVICE IS, a permission prompt can be opened from the click that asks for it. On a
// REMOTE one nothing here can grant anything — so the only routes that work are a page it already holds, or one of
// its open tabs, and failing both, words for the person to carry to that machine.

import type { BlankStartCapability, RuntimeInfo } from "../session-host";

/** What state the "new tab" choice is in, and therefore what the page should offer. */
export type BlankStartState =
    /** it will work: nothing to say */
    | { kind: "ok" }
    /** blocked, and this device can open the permission prompt itself */
    | { kind: "grantable"; url: string; origin: string }
    /** blocked on another machine, which already holds these origins: propose them rather than advice */
    | { kind: "propose"; url: string; runtime: string; choices: { origin: string; url: string }[] }
    /** blocked on another machine with nothing to propose: words to carry there */
    | { kind: "elsewhere"; url: string; runtime: string; steps: string };

/**
 * Read the runtime's answer.
 *
 * `canGrant` is the seam's question, not a guess from `rt.id`: only the device that IS the runtime can raise a
 * permission prompt, and only it knows whether it holds the API to do so.
 */
export function blankStartState(rt: RuntimeInfo | undefined, canGrant: boolean): BlankStartState {
    const cap = rt?.capabilities?.blankStart;
    // Absent means NOT REPORTED, never "blocked": an older runtime says nothing here, and accusing it of a
    // permission problem it never claimed would block a start that works.
    if (!cap || cap.granted !== false) return { kind: "ok" };
    const url = cap.url;
    if (canGrant) return { kind: "grantable", url, origin: originPattern(url) };
    const name = rt?.name ?? "that device";
    const choices = (cap.origins ?? []).map((origin) => ({ origin, url: originUrl(origin) })).filter((c) => !!c.url);
    if (choices.length) return { kind: "propose", url, runtime: name, choices };
    return { kind: "elsewhere", url, runtime: name, steps: siteAccessSteps(cap, name) };
}

/** The host pattern a grant for `url` needs: the origin, every path under it. */
export function originPattern(url: string): string {
    try { return `${new URL(url).origin}/*`; } catch { return url; }
}

/** The page an origin pattern stands for (`https://x/*` → `https://x/`), or "" where it is not one we can open. */
export function originUrl(pattern: string): string {
    try { return new URL(pattern.replace(/\*$/, "")).origin + "/"; } catch { return ""; }
}

/**
 * What to do about it ON THE MACHINE IT IS ABOUT, in that machine's own words.
 *
 * The browser is the runtime's, not the reader's: being told to open `chrome://extensions` while the blocked device
 * runs Brave is advice that does not exist where it has to be followed. The extension id makes it a direct address
 * rather than a hunt through a list, so it is used whenever the runtime sent one.
 */
export function siteAccessSteps(cap: BlankStartCapability, runtime: string): string {
    const browser = cap.browser || "the browser";
    const scheme = (cap.browser || "chrome").toLowerCase().replace(/[^a-z]/g, "") || "chrome";
    const where = cap.extensionId
        ? `open ${scheme}://extensions/?id=${cap.extensionId}`
        : `open ${scheme}://extensions , find "window.ml" and click "Details"`;
    return `On ${runtime}, in ${browser}: ${where}, then under "Site access" choose "On all sites" — or add ${originPattern(cap.url)} under "On specific sites".`;
}
