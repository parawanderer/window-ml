// no-tab.ts — the one tab id a run with NO tab is filed under (docs/spec/TABLESS_RUN.md, "How it would work"), and the
// predicate every tab-keyed helper asks before it pins, buffers, sends or attaches anything.

import { builtinTool } from "../tools/tool-registry";

/**
 * The tab id of a run that has no tab: the browser's own `chrome.tabs.TAB_ID_NONE`, which no tab ever has. A number, so
 * `bgRuns`, its snapshot and the turn's tab cell keep their type; a sentinel host rather than `tabId: number | null`,
 * which would put a guard on every send. Spelled as the value, so a module that loads with no `chrome` still has it.
 */
export const NO_TAB = -1;

/**
 * Whether a tab id is the no-tab sentinel. Every helper filed by tab asks this first: a pin, a replay ring, a debugger,
 * an arrival watcher or a page send for {@link NO_TAB} has no tab to act on.
 * @param tabId the tab id a run is filed under
 * @returns true for the sentinel
 */
export const isNoTab = (tabId: number | undefined): boolean => tabId === NO_TAB;

/**
 * Whether a tool call needs the run's page: every page-realm builtin and every tool a site registered (an undeclared
 * name), and `look`/`locate` unless they look at an attached file's pages, which the worker drew. The worker's own
 * tools (`python_exec`, `fetch_url`, `task`, ...), a server's remote tools and `chat_metadata`, which the loop answers,
 * need none.
 * @param name the tool's name
 * @param args the call's arguments
 * @param remote whether the run's tool of that name is a server's remote tool
 * @returns true when a run with no tab cannot run it
 */
export function needsPage(name: string, args?: Record<string, unknown>, remote = false): boolean {
    if (remote) return false;
    // The loop answers chat_metadata itself (agent-loop.ts, the `meta` capability), above the dispatch: no page is involved.
    if (name === "chat_metadata") return false;
    if (name === "look" || name === "locate") return !Array.isArray(args?._images);
    const realm = builtinTool(name)?.realm;
    return realm === undefined || realm === "page";
}

/**
 * What the model reads for a page tool called by a run with no tab: the tool stays listed, and the result says why it
 * did not run and how the run gets a page.
 * @param name the tool's name
 * @returns the tool result's text
 */
export const noPageText = (name: string): string =>
    `Error: "${name}" needs a page, and this run has no tab. The tools that need no page still work. The person can bring this session to a tab.`;
