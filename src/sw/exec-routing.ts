// exec-routing.ts — where an approved exec of a worker-built run runs: the page's world, an isolated world, or nowhere.

// A script run in the page's main world shares a realm with every script on the page, so whatever it is handed there is
// the page's too: the pointer values it names, and `ml.current` (docs/spec/SITE_ACCESS.md, part 4). Such a script, and
// every approved exec on a page the person has not approved, runs in a world of its own instead. Everything else runs
// in the world the call names (`world`), else the default world: the main world, which is full parity with how the
// page's own scripts see it, unless the build or the stored setting makes it the isolated one.

import { expandPointers } from "../pointers/pointer-macro";
import { namedReads } from "../pointers/named-reads";
import type { ExecWorld } from "../contract/contract-config";

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

/** Why a route was taken, for the execution log and the note the model is given. `requested`: the call's `world`;
 *  `default`: the default world, isolated. */
export type ExecReason = "plain" | "current" | "pointer" | "unapproved-page" | "requested" | "default";

/** Where one approved exec runs. `main` with a `note` is the approved-page fallback when no isolation is available. */
export type ExecRoute =
    | { where: "main"; reason: ExecReason; note?: string }
    | { where: "isolated"; how: "userScripts" | "cdp"; reason: ExecReason }
    | { where: "refused"; reason: ExecReason; result: string };

/** The sentence a refused or fallen-back exec names as the remedy. */
const ENABLE = "Turn on Debugger-based actions, or allow user scripts, in window.ml Settings → Advanced → \"Debugger-based actions and user scripts\"";

/** Why policy keeps a script out of the page's world, as a `world: "page"` refusal says it. */
const FORCED: Record<"current" | "pointer" | "unapproved-page", string> = {
    current: "it reads ml.current",
    pointer: "it reads pointer values",
    "unapproved-page": "this site is not approved for window.ml",
};

/** What the call asked for, and the default for a call that asks nothing. */
export interface WorldAsk { world?: unknown; defaultWorld?: ExecWorld }

/**
 * Decide where an approved exec of a worker-built run runs.
 *
 * POLICY first: isolated when the page is not approved (whatever the script names), or when the script names
 * `ml.current` or a pointer, and `world: "page"` never overrides it (refused, with why). With no isolation available:
 * refused on an unapproved page and for `ml.current` (which the main world does not have); a pointer-naming script on
 * an approved page runs in the main world as before, with a note (owner's decision, 2026-10-08), unless the call asked
 * for `world: "isolated"`.
 *
 * Then the CALL: `world: "isolated"` runs isolated or is refused, never downgraded to the main world; `world: "page"`
 * runs in the main world. A call without `world` takes the default: isolated where available, else the main world as
 * before (owner's decision, 2026-10-14: a default is not a request).
 * @param js the approved source
 * @param approvedPage whether the tab's origin is approved now
 * @param iso what this browser offers
 * @param ask the call's `world` and the default world (`page` when not given)
 * @returns the route
 */
export function routeExec(js: string, approvedPage: boolean, iso: Isolation, ask: WorldAsk = {}): ExecRoute {
    // null is omitted: some OpenAI-compatible models send null for an optional field.
    const world = ask.world === null ? undefined : ask.world, defaultWorld = ask.defaultWorld ?? "page";
    if (world !== undefined && world !== "page" && world !== "isolated")
        return { where: "refused", reason: "requested", result: `Error: world must be "page" or "isolated", or omitted.` };
    const names = execNames(js);
    const forced = !approvedPage ? "unapproved-page" : names.current ? "current" : names.pointers ? "pointer" : null;
    const isolated = (reason: ExecReason): ExecRoute | null =>
        iso.userScripts ? { where: "isolated", how: "userScripts", reason } : iso.cdp ? { where: "isolated", how: "cdp", reason } : null;
    const unavailable = (reason: ExecReason): ExecRoute =>
        ({ where: "refused", reason, result: `Error: world "isolated" was asked for and no isolated world is available, so this exec did not run. ${ENABLE}, or omit world.` });
    if (forced) {
        if (world === "page")
            return { where: "refused", reason: forced, result: `Error: world "page" is refused here: ${FORCED[forced]}, so this exec runs only in an isolated world. Omit world.` };
        const r = isolated(forced);
        if (r) return r;
        if (world === "isolated") return unavailable(forced);
        if (forced === "pointer")
            return { where: "main", reason: forced, note: `(Ran in the page's own world, where its scripts can read the pointer values it was sent: no isolated world is available. ${ENABLE} to isolate it.)` };
        return {
            where: "refused", reason: forced,
            result: forced === "current"
                ? `Error: this exec reads ml.current, which only an isolated world is given, and none is available. Read ml.current in a read-only exec and act on the page in the next. ${ENABLE}.`
                : `Error: this page's site is not approved for window.ml, so an approved exec runs here only in an isolated world, and none is available. ${ENABLE}, or use the other tools.`,
        };
    }
    if (world === "page") return { where: "main", reason: "requested" };
    if (world === "isolated") return isolated("requested") ?? unavailable("requested");
    if (defaultWorld === "isolated") return isolated("default") ?? { where: "main", reason: "plain" };
    return { where: "main", reason: "plain" };
}

/** The one line an isolated exec's failure adds when the page's world was open to it: what it read is likely a global
 *  of the page's, which only that world has. */
export const PAGE_GLOBAL_HINT = `Page globals need world: "page".`;

/**
 * The hint for an isolated exec's error, or "" when there is none: only for a route the call could have taken to the
 * page's world (`requested` or `default`; never one policy isolated, where `world: "page"` is refused), and only for
 * the errors a missing page global throws.
 * @param route the route the exec ran on
 * @param error the error it reported
 */
export function pageGlobalHint(route: { where: string; reason: ExecReason }, error: string): string {
    if (route.where !== "isolated" || (route.reason !== "requested" && route.reason !== "default")) return "";
    return /\bis not defined\b|Cannot read properties of undefined/.test(error) ? PAGE_GLOBAL_HINT : "";
}

/**
 * A call's arguments without `world`, for what goes to the page: the worker routes the call, so the page is not told
 * which world was asked for.
 * @param args the call's arguments
 */
export function withoutWorld(args: Record<string, unknown>): Record<string, unknown> {
    if (!("world" in args)) return args;   // null too: it is removed, as omitted
    const { world: _world, ...rest } = args;
    return rest;
}

/** What the approval card says when a call's `world` sends it somewhere other than where an exec without one would run.
 *  User-facing text (owner-approved strings). */
export const WORLD_CARD = {
    main: "Runs in the page's own world, where the page's scripts can see and change it.",
    isolated: "Runs in an isolated world, hidden from the page's scripts.",
} as const;

/**
 * The approval card's line for an exec whose `world` moves it away from where the default would run it, or "" when it
 * lands where an exec without `world` would (or is refused, which is decided before any card). Under an isolated default
 * this is what shows a person that the model, perhaps steered by the page, asked for the page's world.
 * @param asked the route with the call's `world`
 * @param byDefault the route of the same script without one
 */
export function worldCardNote(asked: ExecRoute, byDefault: ExecRoute): string {
    if (asked.where === byDefault.where || asked.where === "refused") return "";
    return WORLD_CARD[asked.where];
}
