// The server-side tools as a callable namespace: `ml.dynamicTools.<bundle>.<fn>(args)`.
//
// Three decisions shape this file.
//
// NAMESPACED BY BUNDLE, not flattened. Function names come from the server and two bundles can both expose
// `search`; flattening would resolve one of them and silently call the wrong tool.
//
// A PROXY *AND* REAL KEYS. `window.ml` is defined synchronously at document_start but the tool list needs a
// fetch, so a namespace that waited for the list would not exist when a console user first reaches for it.
// The Proxy dispatches by name immediately; the real keys appear once a list has resolved, which is what
// makes tab-completion work. Neither alone is enough: a Proxy has nothing to complete, and a plain object
// cannot exist before the fetch.
//
// THE SCHEMA IS ON THE CALLABLE, and it is the same object the call validates against. A second copy for
// humans to read would drift from the one that checks the arguments, and the drift would be invisible.
import type { MlApi, ServerTool, ServerToolFunction, JsonSchema, ServerToolResult } from "./contract";
import { validateArgs } from "./validate";

/** One function of a bundle, callable, with its own contract hanging off it. */
export interface DynamicTool {
    (args?: Record<string, unknown>, options?: { onOutput?: (text: string, ts?: number) => void; signal?: AbortSignal }): Promise<ServerToolResult>;
    /** The function's JSON Schema — what a human reads, and what a call is checked against. */
    schema: JsonSchema | null;
    /** The whole declaration: name, description, parameters. */
    spec: ServerToolFunction;
    /** Which bundle this came from. */
    toolId: string;
}

export interface DynamicToolNamespace {
    /** Fetch the tool list now, so the real keys exist for tab-completion. Idempotent per call. */
    load(): Promise<string[]>;
    [bundle: string]: unknown;
}

/** The error a call gets when its arguments do not match the server's own schema. Thrown BEFORE dispatch:
 *  a typo should fail here with the reason, not as a 400 from the far end or, worse, as a call that
 *  succeeded with a silently-dropped argument. */
export class DynamicToolArgumentError extends Error {
    constructor(public readonly tool: string, public readonly issues: string[]) {
        super(`${tool}: ${issues.join("; ")}`);
        this.name = "DynamicToolArgumentError";
    }
}

/** Build the callable for one function of one bundle. */
function makeTool(ml: MlApi, bundle: ServerTool, fn: ServerToolFunction): DynamicTool {
    const label = `ml.dynamicTools[${JSON.stringify(bundle.id)}].${fn.name}`;
    const call = ((args = {}, options = {}) => {
        // Checked against the SERVER's own schema, which is the one thing here we did not write. The agent
        // loop already does this for a model's tool calls (`validateArgs`); a console call deserves the same
        // answer rather than a round-trip to find out.
        const issues = validateArgs(fn.parameters || undefined, args);
        if (issues.length) return Promise.reject(new DynamicToolArgumentError(label, issues));
        return ml.execServerTool(bundle.id, fn.name, args, options);
    }) as DynamicTool;
    call.schema = fn.parameters || null;
    call.spec = fn;
    call.toolId = bundle.id;
    return call;
}

/**
 * The namespace.
 *
 * @param ml the live API (for `serverTools()` and `execServerTool`)
 * @param allow when present, the ONLY bundles reachable — the run-scoped whitelist. A tool outside it
 *   throws rather than being absent, so a model that reaches for one is told why instead of seeing
 *   `undefined is not a function`.
 */
export function makeDynamicTools(ml: MlApi, allow?: readonly string[]): DynamicToolNamespace {
    const bundles = new Map<string, ServerTool>();
    const built = new Map<string, Record<string, DynamicTool>>();
    let loading: Promise<string[]> | null = null;

    const permitted = (id: string) => !allow || allow.includes(id);

    const namespaceFor = (id: string): Record<string, DynamicTool> => {
        const known = built.get(id);
        if (known) return known;
        const bundle = bundles.get(id);
        // A bundle we have not listed yet still dispatches: the Proxy invents the function on demand and the
        // call itself is what discovers whether it exists. Without this the namespace would be unusable
        // until a fetch happened, which is the whole reason it is a Proxy.
        const base: Record<string, DynamicTool> = {};
        for (const fn of bundle?.functions || []) base[fn.name] = makeTool(ml, bundle!, fn);
        const ns = new Proxy(base, {
            get(target, prop) {
                if (typeof prop !== "string" || prop in target) return target[prop as string];
                // Unlisted: build a callable with no schema. It cannot validate — we were never told the
                // shape — so it dispatches and lets the server answer, which is better than refusing a tool
                // that may well exist.
                const unknown: ServerToolFunction = { name: prop, description: "", parameters: null };
                return makeTool(ml, bundle || { id, name: id, description: "", kind: "local", functions: [] }, unknown);
            },
        });
        if (bundle) built.set(id, ns);
        return ns;
    };

    const load = async (): Promise<string[]> => {
        loading ||= (async () => {
            const list = await ml.serverTools();
            bundles.clear(); built.clear();
            for (const b of list) if (permitted(b.id)) bundles.set(b.id, b);
            // Real keys, so the console can complete them. This is the half a Proxy cannot provide.
            for (const id of bundles.keys()) Object.defineProperty(root, id, {
                configurable: true, enumerable: true, get: () => namespaceFor(id),
            });
            return [...bundles.keys()];
        })().finally(() => { loading = null; });
        return loading;
    };

    const root = new Proxy({ load } as DynamicToolNamespace, {
        get(target, prop) {
            if (typeof prop !== "string" || prop === "load" || prop in target) return (target as Record<string, unknown>)[prop as string];
            // Told outright rather than left undefined: a run whose whitelist excludes this bundle should
            // explain itself, because `undefined is not a function` sends the reader looking for a typo.
            if (!permitted(prop)) throw new Error(`ml.dynamicTools: this run may not use ${JSON.stringify(prop)}. Allowed: ${(allow || []).join(", ") || "(none)"}`);
            return namespaceFor(prop);
        },
        // So `Object.keys` and the console's completion see what has been listed.
        ownKeys: (target) => [...new Set([...Reflect.ownKeys(target), ...bundles.keys()])],
        getOwnPropertyDescriptor: (target, prop) =>
            (typeof prop === "string" && bundles.has(prop))
                ? { configurable: true, enumerable: true, value: namespaceFor(prop) }
                : Reflect.getOwnPropertyDescriptor(target, prop),
    });
    return root;
}
