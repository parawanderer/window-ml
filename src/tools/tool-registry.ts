// tool-registry.ts — every builtin agent tool, declared once: what the gate, the pointers, the worker's routing and the
// start card each need to know about it, so none of them keeps a list of names of its own.

// Each declaration names the files that hold the tool's factory, and `scripts/check-tools.mjs` holds the two together:
// a factory with no declaration, or a declaration naming a file with no factory for it, fails the pre-commit hook and
// CI. The declarations live HERE rather than beside each factory because the lists below are read by modules that do
// not import the factories (agent-loop.ts, tool-exec.ts, the sidebar's bundle): a declaration that ran only when its
// factory's module loaded would leave a gate list short in exactly those places, and a short `GATED_TOOL_NAMES` fails
// open. This file imports nothing, so every bundle that reads it reads all of it.
//
// A name the registry does not declare is the SITE's own tool (docs/spec/SITE_ACCESS_SLICE3.md, Q18). A site tool that
// takes a builtin's name gets the builtin's treatment: gated if the builtin is, and the builtin's card line.

/** Where a run the WORKER built executes the tool: `page` delegates it to the run's tab, `worker` runs it in the
 *  service worker (it never reads the page, or reads it as plain data), `loop` is answered by the agent loop itself.
 *  A run the page hosts runs every tool in the page. */
export type ToolRealm = "page" | "worker" | "loop";

/** What a card line may depend on: the facts of the run's toolset that change what a tool can reach. */
export interface CardFacts {
    /** `navigate` was built with `crossOrigin` on. */
    crossOrigin?: boolean;
}

/** One builtin tool's declaration. */
export interface BuiltinToolDecl {
    /** The tool's name, as the model calls it. */
    name: string;
    /** The repo paths of the files that hold its factory (`look` has two: the delegated one and the native one). */
    factories: readonly string[];
    /** The worker gates every call: its factory sets `requiresApproval`, and a page's descriptor cannot take it off
     *  (sw-run-host.ts `pageStartPayload`). */
    gated: boolean;
    /** Its output can be kept as an `@tool:` pointer, so a run with tool tokens offers it `token` (tool-params.ts). */
    citable: boolean;
    realm: ToolRealm;
    /** The start card's sentence for it (SITE_ACCESS_SLICE3.md 1.1). Tools that share a sentence give the same string,
     *  and the card shows it once. `null`: no line, the tool reaches nothing outside the run and the extension. */
    cardLine: string | ((facts: CardFacts) => string) | null;
}

const registry = new Map<string, BuiltinToolDecl>(); // state: fixed

const REALMS: readonly ToolRealm[] = ["page", "worker", "loop"];

/**
 * Declare a builtin tool. Called once per tool, below, at load.
 * @param decl the declaration
 * @returns the same declaration
 */
export function defineBuiltinTool(decl: BuiltinToolDecl): BuiltinToolDecl {
    if (registry.has(decl.name)) throw new Error(`builtin tool ${decl.name} is declared twice`);
    if (!REALMS.includes(decl.realm)) throw new Error(`builtin tool ${decl.name} has an unknown realm "${decl.realm}"`);
    if (!decl.factories.length) throw new Error(`builtin tool ${decl.name} names no factory`);
    registry.set(decl.name, Object.freeze({ ...decl, factories: Object.freeze([...decl.factories]) }));
    return decl;
}

// --- the declarations ---

const READ_PAGE = "Read this page";
const SHOTS = "Take screenshots of this page and show them to the model";
const CLICK_TYPE = "Click and type on this page";

defineBuiltinTool({ name: "findByText", factories: ["src/tools/tools.ts"], gated: false, citable: false, realm: "page", cardLine: READ_PAGE });
defineBuiltinTool({ name: "interactives", factories: ["src/tools/tools.ts"], gated: false, citable: false, realm: "page", cardLine: READ_PAGE });
defineBuiltinTool({ name: "describeElement", factories: ["src/tools/tools.ts"], gated: false, citable: false, realm: "page", cardLine: READ_PAGE });
defineBuiltinTool({ name: "ancestors", factories: ["src/tools/tools.ts"], gated: false, citable: false, realm: "page", cardLine: READ_PAGE });
defineBuiltinTool({ name: "countMatches", factories: ["src/tools/tools.ts"], gated: false, citable: false, realm: "page", cardLine: READ_PAGE });
defineBuiltinTool({ name: "sampleText", factories: ["src/tools/tools.ts"], gated: false, citable: false, realm: "page", cardLine: READ_PAGE });
defineBuiltinTool({ name: "pageInfo", factories: ["src/tools/tools.ts"], gated: false, citable: false, realm: "page", cardLine: READ_PAGE });
defineBuiltinTool({ name: "scroll", factories: ["src/tools/tools.ts"], gated: false, citable: false, realm: "page", cardLine: READ_PAGE });
defineBuiltinTool({ name: "wait", factories: ["src/tools/tools.ts"], gated: false, citable: false, realm: "page", cardLine: READ_PAGE });
defineBuiltinTool({ name: "exec", factories: ["src/tools/tools.ts"], gated: true, citable: true, realm: "page", cardLine: "Run code on this page" });
defineBuiltinTool({ name: "answer", factories: ["src/tools/tools.ts"], gated: false, citable: false, realm: "worker", cardLine: READ_PAGE });
defineBuiltinTool({ name: "dereference", factories: ["src/tools/tools.ts"], gated: false, citable: false, realm: "loop", cardLine: null });

defineBuiltinTool({ name: "look", factories: ["src/tools/builtin-tools.ts", "src/ml/ml-vision.ts"], gated: false, citable: true, realm: "worker", cardLine: SHOTS });
defineBuiltinTool({ name: "locate", factories: ["src/tools/builtin-tools.ts"], gated: false, citable: true, realm: "worker", cardLine: SHOTS });
defineBuiltinTool({ name: "click", factories: ["src/tools/builtin-tools.ts"], gated: true, citable: false, realm: "page", cardLine: CLICK_TYPE });
defineBuiltinTool({ name: "type", factories: ["src/tools/builtin-tools.ts"], gated: true, citable: false, realm: "page", cardLine: CLICK_TYPE });

defineBuiltinTool({ name: "navigate", factories: ["src/ml/ml-tool-factories.ts"], gated: true, citable: false, realm: "page",
    cardLine: (f) => (f.crossOrigin ? "Open other pages in this tab, on any site" : "Open other pages of this site in this tab") });
defineBuiltinTool({ name: "fetch_url", factories: ["src/ml/ml-tool-factories.ts"], gated: true, citable: true, realm: "worker", cardLine: "Read other websites (it asks you before each new one)" });
defineBuiltinTool({ name: "chat_metadata", factories: ["src/ml/ml-tool-factories.ts"], gated: false, citable: false, realm: "page", cardLine: null });
defineBuiltinTool({ name: "python_exec", factories: ["src/python/python-tool.ts"], gated: true, citable: true, realm: "worker", cardLine: "Run Python" });
defineBuiltinTool({ name: "agent_api_docs", factories: ["src/tools/api-docs-tool.ts"], gated: false, citable: true, realm: "worker", cardLine: null });

// --- what the rest of the code reads ---

/** Whether a tool name is one of the extension's own. Anything else is the site's own tool. */
export const isBuiltinTool = (name: unknown): boolean => typeof name === "string" && registry.has(name);

/** A builtin's declaration, or undefined for a name that is not one (the site's own tool). */
export const builtinTool = (name: string): BuiltinToolDecl | undefined => registry.get(name);

/** Every builtin's declaration, in declaration order. */
export const builtinTools = (): BuiltinToolDecl[] => [...registry.values()];

/**
 * The start card's line for a tool.
 * @param name the tool's name
 * @param facts the run's facts that change a line (`navigate`'s `crossOrigin`)
 * @returns the sentence; `null` for a builtin with no line; `undefined` for a name that is not a builtin, which the
 *   card counts among the site's own tools
 */
export function cardLine(name: string, facts: CardFacts = {}): string | null | undefined {
    const d = registry.get(name);
    if (!d) return undefined;
    return typeof d.cardLine === "function" ? d.cardLine(facts) : d.cardLine;
}

const namesWhere = (pick: (d: BuiltinToolDecl) => boolean): ReadonlySet<string> => new Set(builtinTools().filter(pick).map((d) => d.name));

/** The builtins the worker always gates, whatever `requiresApproval` a page's descriptor carries. */
export const GATED_BUILTINS: ReadonlySet<string> = namesWhere((d) => d.gated);

/** The builtins whose output can be kept as an `@tool:` pointer. */
export const CITABLE_BUILTINS: ReadonlySet<string> = namesWhere((d) => d.citable);

/** The builtins a worker-built run executes in the worker rather than the page. */
export const WORKER_BUILTINS: ReadonlySet<string> = namesWhere((d) => d.realm === "worker");
