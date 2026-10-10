// api-docs-tool.ts — the `agent_api_docs` tool, built from where it reads the live shortcut and config.

// The reference itself is build-time; two of its sections are the person's RUNTIME state (the HUD shortcut, whether
// read-only `ml` calls auto-approve). A page-hosted run reads them through window messages (`pageDocsSource`); a
// worker-built run builds the same tool in the worker (worker-tools.ts) with a source that reads them directly, so the
// run's tab needs no message for them (docs/spec/SITE_ACCESS.md, slice 2 part 2).

import type { MlTool, ToolContext } from "../contract/contract-agent";
import type { InvocationInfo, MlPublicConfig } from "../contract";
import type { defineTool } from "../ml/ml-tool-factories";
import { makeBackgroundTaskPromise } from "../bridge";
import { BUILD_DIFF } from "../build-diff.gen";
import { BUILD_INFO } from "../build-info.gen";
// Generated from contract.ts at build time (scripts/gen-api-docs.mjs) — the public MlApi
// surface, so the doc the model reads can never drift from the interface it describes.
import { ML_API_PARTS } from "../api-docs.gen";
import { ML_READONLY_METHODS } from "../readonly-exec";
import { browserInfo } from "../util";
import { errText } from "../dom/dom";
import { runPipe, pipeHint, PIPE_REF } from "../pointers/text-pipe";
import { toolDetailsSection } from "./tool-details";
import { queryApiDocs, isDefaultQuery, withoutMembers, type ApiDocsQuery } from "./api-docs-query";
import { hiddenMlMembers } from "../ml/ml-member-tools";

/** Where `agent_api_docs` reads the two runtime facts it reports. Either may reject or return null: it says less. */
export interface DocsSource {
    /** How the person opens the HUD on this install (GET_INVOCATION). */
    invocation(): Promise<InvocationInfo | null>;
    /** The non-secret config, for `autoApproveReadonly` (GET_CONFIG). */
    config(): Promise<MlPublicConfig | null>;
}

/** A page-hosted run's source: the background, through the content-script relay. */
export const pageDocsSource: DocsSource = {
    invocation: () => makeBackgroundTaskPromise<InvocationInfo>("INVOCATION_REQUEST", "INVOCATION_RESPONSE", {}),
    config: () => makeBackgroundTaskPromise<MlPublicConfig>("CONFIG_REQUEST", "CONFIG_RESPONSE", {}),
};

// How long invocationSection waits for the background's shortcut reply before answering
// generically. Short: it's one section of a docs lookup, never worth stalling a step for.
const INVOCATION_TIMEOUT_MS = 1500;

/**
 * Await a background lookup, giving up with `null` after {@link INVOCATION_TIMEOUT_MS} — a docs
 * lookup must never stall an agent step on a slow/torn-down relay, and every caller here degrades
 * to generic advice. The timer is cleared on the fast path so a resolved lookup leaves nothing
 * pending on the event loop.
 *
 * @param p The in-flight background promise.
 * @returns Its value, or null on timeout/rejection.
 */
const bounded = async <T>(p: Promise<T>): Promise<T | null> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([p, new Promise<null>(r => { timer = setTimeout(() => r(null), INVOCATION_TIMEOUT_MS); })]);
    } catch {
        return null;
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
};

/**
 * The "how the user opens the HUD here" section of agent_api_docs — resolved at RUN TIME, not
 * baked into the generated reference, because the keyboard shortcut is user-rebindable: a
 * hardcoded "Alt+Space" sends them to a key that may do nothing. Reports what is bound right
 * now, whether they changed it, and the settings URL for THEIR browser (the scheme differs on
 * Edge/Brave/…). Degrades to the generic instructions if the background can't be reached.
 *
 * @param src where the live shortcut is read
 * @returns {Promise<string>} A markdown section for the tool's output.
 */
const invocationSection = async (src: DocsSource): Promise<string> => {
    const b = browserInfo();
    const shortcutsUrl = `${b.scheme}://extensions/shortcuts`;
    const lines = [`## Opening the HUD (this browser: ${b.name}${b.version ? ` ${b.version}` : ""})`, ""];
    // Bounded: makeBackgroundTaskPromise waits forever for its reply, and a missing/slow relay
    // (torn-down content script, sleeping worker) must degrade to generic advice rather than
    // stall the agent step on a docs lookup.
    const info = await bounded(src.invocation());
    if (info?.shortcut) {
        lines.push(`- **Keyboard: \`${info.shortcut}\`** — the shortcut bound RIGHT NOW` +
            (info.isDefault ? " (the extension's default)." : ` (the user CHANGED this from the default \`${info.defaultShortcut}\`).`));
    } else if (info) {
        lines.push(`- **Keyboard: not assigned.** The default (\`${info.defaultShortcut || "Alt+Space"}\`) is not bound — ` +
            "either the user cleared it or it collided with another extension. They must set one to open the HUD by keyboard.");
    } else {
        lines.push("- **Keyboard:** a shortcut opens the HUD, but the live binding could not be read here — " +
            "tell the user to check the shortcuts page below rather than guessing a key.");
    }
    lines.push(`- **Rebinding it:** the user opens \`${shortcutsUrl}\` and edits "Open the window.ml command bar". ` +
        "Chromium reserves that page for the user — neither you nor the extension can set a shortcut for them, " +
        "and you cannot navigate there yourself (tools don't act on browser-internal pages), so hand them the URL.");
    if (info?.contextMenu) lines.push("- **Right-click** anywhere on the page and pick window.ml from the context menu.");
    lines.push("- **Toolbar:** the extension's icon opens the popup (settings, model picker), not the HUD.");
    return lines.join("\n");
};

/**
 * The "you can read your own setup for free" section of agent_api_docs. Like the HUD shortcut,
 * this is RUNTIME state the generated reference can't hold: it's true only while
 * `autoApproveReadonly` is on, so it's resolved here rather than stated unconditionally — and it
 * lives behind this tool call rather than in the system prompt, which every run pays for.
 *
 * @param src where the config is read
 * @returns {Promise<string>} A markdown section, or "" when the flag is off (then these calls
 *          go through the normal approval gate and there is nothing special to say).
 */
const selfIntrospectionSection = async (src: DocsSource): Promise<string> => {
    // Unreadable → say nothing: the approval gate is the safe default to describe.
    const cfg = await bounded(src.config());
    if (!cfg?.autoApproveReadonly) return "";
    return ["## Reading your own setup (no approval needed)", "",
        `\`${ML_READONLY_METHODS.map(m => `ml.${m}()`).join("`, `")}\` are read-only, so calling them ` +
        "from `exec` runs with NO approval prompt — that's how to answer \"which model am I?\" and the like. " +
        "`ml.pipe(text, stages)` and `ml.jsonPath(data, \"$..id\")` are free too, unless a pattern (`grep`/`sed`, `match()`/`search()`) could backtrack. " +
        "Every other `ml` method still asks the user first."].join("\n");
};

/**
 * The "here's my source" section of agent_api_docs: the public repo, the exact commit this harness was
 * built from + when that commit was made, and the build time. Lets the agent READ ITS OWN CODE (e.g. clone
 * or browse the repo at this commit) instead of guessing how it works. Build-time git provenance (the
 * extension can't run git live); fields it doesn't have are simply omitted, so a git-less build says less.
 * @returns {string} A markdown section, or "" when no provenance was captured.
 */
const sourceSection = (): string => {
    const b = BUILD_INFO;
    const lines: string[] = [];
    if (b.repoUrl) lines.push(`- Public repository: ${b.repoUrl}`);
    if (b.shortCommit) lines.push(`- This harness is built from commit \`${b.shortCommit}\`${(b as { dirty?: boolean }).dirty ? " PLUS uncommitted local changes (NOT a clean build of that commit — the source at this commit won't match exactly)" : ""}${b.commitDate ? ` (committed ${b.commitDate})` : ""}${b.commitUrl ? ` — ${b.commitUrl}` : ""}`);
    // The specific files that differ from `commit` in THIS build — so if you read the repo at that commit,
    // you know which files won't match what's actually running here (the rest DO match the commit).
    const dirtyFiles = (b as { dirtyFiles?: readonly string[] }).dirtyFiles;
    if (dirtyFiles && dirtyFiles.length) lines.push(`- Files changed since that commit in this build (so they WON'T match the repo at \`${b.shortCommit}\`): ${dirtyFiles.map(f => `\`${f}\``).join(", ")}`);
    if (b.buildTime) lines.push(`- Built: ${b.buildTime}`);
    if (!lines.length) return "";
    return ["## My source", "",
        "You are open source — you can read your own implementation to answer questions about how you work:",
        ...lines].join("\n");
};

/** The `agent_api_docs({ diff: true })` section: this build's EXACT uncommitted diff (captured at build time,
 *  the extension can't run git live). Kept behind an explicit arg — it's large and rarely needed. */
const dirtyDiffSection = (): string => {
    const b = BUILD_INFO as { dirty?: boolean; shortCommit?: string };
    if (!b.dirty) return `This build is a CLEAN checkout of \`${b.shortCommit || "its commit"}\` — no uncommitted changes, so the repo at that commit matches exactly.`;
    if (!BUILD_DIFF) return `This build has uncommitted changes, but no diff was captured (a git-less build). See the file list in the source section.`;
    return ["## Local changes (uncommitted diff vs `" + (b.shortCommit || "commit") + "`)", "",
        "This is exactly what differs in THIS build from the repo at its commit — everything else matches.",
        "", "```diff", BUILD_DIFF, "```"].join("\n");
};

/**
 * The `agent_api_docs` tool.
 * @param define the `defineTool` to build it with
 * @param src where its runtime sections are read
 * @returns the tool
 */
export function apiDocsTool(define: typeof defineTool, src: DocsSource): MlTool {
    return define({
        name: "agent_api_docs",
        summary: "Looks up the window.ml extension's own API reference.",
        // Deliberately terse: this is a "when you need it" escape hatch, not a step in the
        // method. The reference is LARGE, so it's served ctags-style (api-docs-query.ts): the
        // default call is MlApi + a type index; drill into a type or scan by term on demand.
        // The system prompt's SELF_CLAUSE is what tells the model the tool is worth reaching for.
        description: "Your own implementation details: the public API of window.ml, the browser " +
            "extension you run inside, and how a user invokes you — the devtools console, or the " +
            "in-page HUD and the keyboard shortcut currently bound to it. Also gives the public repo " +
            "link + the exact commit this build is on, so you can read your own source. Call it when " +
            "asked about yourself, how to reach you, or the API, instead of guessing. This reference is " +
            "LARGE, so it comes in pieces: call with NO args first for a one-line index of every `ml` member " +
            "and the type names. Then drill down, usually by METHOD (`members`): its full doc plus every type " +
            "its signature uses, followed to the leaves, so one call gives you what you need to call it.",
        parameters: {
            type: "object",
            properties: {
                members: {
                    type: "array",
                    items: { type: "string" },
                    description: "Expand these `ml` methods (e.g. [\"fetch\", \"agent\"]): each one's " +
                        "signature/JSDoc PLUS the type sections its signature references. The usual drill-down."
                },
                types: {
                    type: "array",
                    items: { type: "string" },
                    description: "Expand these referenced types in full by name (e.g. [\"FetchResult\"]). " +
                        "Names come from the index or from a method you expanded. For a type you already spotted."
                },
                search: {
                    type: "string",
                    description: "Scan every member and type section for this term (e.g. \"screenshot\") " +
                        "and return what mentions it. Use it when you don't know the method or type name. With `members` or " +
                            "`types` in the same call, you get both."
                },
                fresh: {
                    type: "boolean",
                    description: "If you used this tool before but you critically need to re-read a definition, " +
                        "set this to force a fresh full re-print. Do NOT set it if you recently checked the " +
                        "definitions you need (repeats within a dig are collapsed to save space). Default off."
                },
                pipe: {
                    type: "string",
                    description: "Reduce what this call returns, e.g. 'grep -i signal', 'grep -n fetch | head 20'. " +
                        "Applied LAST, to whatever the other args selected. Reach for it when you want LINES rather " +
                        "than sections: `search` returns every section that mentions a term, which is the wrong grain " +
                        "for a question like \"which methods take a signal\". " + PIPE_REF
                },
                tool: {
                    type: "string",
                    description: "A tool's reference (e.g. \"fetch_url\"): how its options behave, beyond its description. Standalone.",
                },
                diff: {
                    type: "boolean",
                    description: "Return the EXACT local diff of this build's uncommitted changes (vs its commit) " +
                        "— use it after the source section tells you the build is dirty, to see precisely what " +
                        "differs from the repo at that commit. Standalone; ignores the other args. Default off."
                }
            }
        },
        // The reference itself is build-time (sliced here per the query). The source provenance (repo/commit),
        // the live HUD shortcut, and the read-only-exec note are RUNTIME state the user owns — resolved here and
        // handed to the slicer as searchable env sections. Resolved for the default view (which shows them) and
        // for a `search` (the model hunts the HUD shortcut via search, as observed) — but NOT for a member/type
        // drill, which shouldn't pay two background round-trips for context it didn't ask for.
        run: async (args: ApiDocsQuery & { diff?: boolean; pipe?: string; tool?: string } = {}, ctx?: ToolContext): Promise<string> => {
            if (args.diff) return dirtyDiffSection();   // explicit: the exact local diff (never in the default view)
            if (typeof args.tool === "string" && args.tool.trim()) return toolDetailsSection(args.tool.trim(), (n) => ctx?.hasTool ? ctx.hasTool(n) : true);
            const wantEnv = isDefaultQuery(args) || !!(args.search && args.search.trim());
            const env = wantEnv
                ? [
                    { name: "Opening the HUD", body: await invocationSection(src) },
                    { name: "My source", body: sourceSection() },
                    { name: "Reading your own setup", body: await selfIntrospectionSection(src) },
                ].filter(e => e.body)
                : [];
            // Within-burst dedup: this call IS the docs streak, so reset the leniency counter; `fresh`
            // purges what was shown so the model re-reads in full. `shown` (undefined on a legacy ctx-less
            // path) collapses chunks already printed earlier in the dig to one-line stubs.
            const mem = ctx?.docsMemory;
            if (mem) { mem.sinceDocs = 0; if (args.fresh) mem.shown.clear(); }
            // A member this run does not have (its tool is not in the toolset) is not in its reference either.
            const parts = ctx?.hasTool ? withoutMembers(ML_API_PARTS, [...hiddenMlMembers(ctx.hasTool).keys()]) : ML_API_PARTS;
            const view = queryApiDocs(parts, args, env, mem?.shown);
            // The reduction lives HERE rather than in api-docs-query.ts, which has no imports on purpose, and it
            // goes through `runPipe` rather than growing a second one: PIPE_CMDS is the single source for every
            // description of the dialect, and a private reduction in one tool is how that stops being true.
            const pipe = typeof args.pipe === "string" ? args.pipe.trim() : "";
            if (!pipe) return view;
            try { return `${runPipe(view, pipe)}\n\n(piped through \`${pipe}\`)`; }
            catch (e) { const msg = errText(e as Error); return `Pipe error: ${msg}${pipeHint(msg)}`; }
        }
    }) as MlTool;
}
