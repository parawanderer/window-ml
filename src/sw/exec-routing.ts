// exec-routing.ts — where an approved exec of a worker-built run runs: the page's world, an isolated world, or nowhere.

// A script run in the page's main world shares a realm with every script on the page, so whatever it is handed there is
// the page's too: the pointer values it names, and `ml.current` (docs/spec/SITE_ACCESS.md, part 4). Such a script, and
// every approved exec on a page the person has not approved, runs in a world of its own instead. Everything else keeps
// the main world, which is full parity with how the page's own scripts see it.

import { expandPointers } from "../pointers/pointer-macro";
import { namedReads } from "../pointers/named-reads";

/** What an approved exec's source asks for, read lexically. A miss is safe: what a script does not name literally is
 *  not sent with it (named-reads.ts), and the main world has no `ml.current`, so it fails there rather than leaking. */
export interface ExecNames { current: boolean; pointers: boolean }

/** Read what a script names. */
export function execNames(js: string): ExecNames {
    const { code, expansions } = expandPointers(js);
    return {
        current: /\bml\s*\.\s*current\b/.test(code),
        pointers: expansions.length > 0 || namedReads(code).length > 0 || /\bml\s*\.\s*dereference\s*\(/.test(code),
    };
}

/** The mechanisms this browser offers for running a script in a world of its own, in order of preference. */
export interface Isolation { userScripts: boolean; cdp: boolean }

/** Why a route was taken, for the execution log and the note the model is given. */
export type ExecReason = "plain" | "current" | "pointer" | "unapproved-page";

/** Where one approved exec runs. `main` with a `note` is the approved-page fallback when no isolation is available. */
export type ExecRoute =
    | { where: "main"; reason: ExecReason; note?: string }
    | { where: "isolated"; how: "userScripts" | "cdp"; reason: ExecReason }
    | { where: "refused"; reason: ExecReason; result: string };

/** The sentence a refused or fallen-back exec names as the remedy. */
const ENABLE = "Turn on Debugger-based actions, or allow user scripts, in window.ml Settings → Advanced → \"Debugger-based actions and user scripts\"";

/**
 * Decide where an approved exec of a worker-built run runs.
 *
 * Isolated when the page is not approved (whatever the script names), or when the script names `ml.current` or a
 * pointer. With no isolation available: refused on an unapproved page and for `ml.current` (which the main world does
 * not have); a pointer-naming script on an approved page runs in the main world as before, with a note (owner's
 * decision, 2026-10-08: nothing that works today breaks, and the values reach only a site the person approved).
 * @param js the approved source
 * @param approvedPage whether the tab's origin is approved now
 * @param iso what this browser offers
 * @returns the route
 */
export function routeExec(js: string, approvedPage: boolean, iso: Isolation): ExecRoute {
    const names = execNames(js);
    const reason: ExecReason = !approvedPage ? "unapproved-page" : names.current ? "current" : names.pointers ? "pointer" : "plain";
    if (reason === "plain") return { where: "main", reason };
    if (iso.userScripts) return { where: "isolated", how: "userScripts", reason };
    if (iso.cdp) return { where: "isolated", how: "cdp", reason };
    if (reason === "pointer")
        return { where: "main", reason, note: `(Ran in the page's own world, where its scripts can read the pointer values it was sent: no isolated world is available. ${ENABLE} to isolate it.)` };
    return {
        where: "refused", reason,
        result: reason === "current"
            ? `Error: this exec reads ml.current, which only an isolated world is given, and none is available. Read ml.current in a read-only exec and act on the page in the next. ${ENABLE}.`
            : `Error: this page's site is not approved for window.ml, so an approved exec runs here only in an isolated world, and none is available. ${ENABLE}, or use the other tools.`,
    };
}
