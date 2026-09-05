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

/** Build the callable for one function of one bundle.
 *
 *  The schema is the SERVER's, verbatim — deliberately NOT the agent tool's. `buildServerTools` adds an
 *  optional `token` beside the server's properties so a MODEL can name the output it is about to capture;
 *  that is a concept of the agent loop (a pointer store, a citation), and a human calling from the console
 *  has none of them. Adding it here would advertise an argument that does nothing and would be rejected by
 *  the validation two lines below. */
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
 * @param allow when present, the ONLY bundles reachable — a fixed whitelist, for tests and for a namespace
 *   built for one purpose. A tool outside it throws rather than being absent, so a model that reaches for
 *   one is told why instead of seeing `undefined is not a function`.
 * @param scope the LIVE whitelist, consulted per access: what the currently-running tool call may reach, or
 *   null outside a run (the console, unrestricted). This is how one memoised namespace can be narrow inside
 *   an approved `exec` and wide in the console — there is no caller identity to test, so the object itself
 *   is what changes.
 */
export function makeDynamicTools(ml: MlApi, allow?: readonly string[], scope?: () => readonly string[] | null): DynamicToolNamespace {
    const bundles = new Map<string, ServerTool>();
    const built = new Map<string, Record<string, DynamicTool>>();
    let loading: Promise<string[]> | null = null;

    // The whitelist is read PER ACCESS, not captured: `ml.dynamicTools` is one memoised object on the page,
    // and a tool call narrows it for its duration. Capturing at construction would mean the namespace a run
    // sees is whatever the FIRST caller happened to build — the console's unrestricted one, in practice.
    const permitted = (id: string) => {
        const active = allow ?? scope?.();
        return !active || active.includes(id);
    };

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
            // Every bundle the KEY can reach. What a given run may use is decided per access, not here: the
            // list is a fact about the credentials, and load() usually happens outside any run at all.
            for (const b of list) bundles.set(b.id, b);
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
            if (typeof prop !== "string" || prop === "load") return (target as Record<string, unknown>)[prop as string];
            // The permission check comes BEFORE the own-property short-circuit, because `load()` defines real
            // keys and they would otherwise bypass it entirely — the namespace would narrow only for bundles
            // nobody had listed yet, which is backwards.
            //
            // Only a KNOWN bundle throws. An unfamiliar name is left to dispatch and be refused at the
            // background gate, both because we may simply not have listed it and because this trap also sees
            // `then`, `constructor` and whatever else the runtime probes — throwing on those would make the
            // namespace unusable in ways that have nothing to do with permissions.
            if (bundles.has(prop) && !permitted(prop)) {
                const active = allow ?? scope?.() ?? [];
                throw new Error(`ml.dynamicTools: this run may not use ${JSON.stringify(prop)}. It was given: ${active.join(", ") || "(no server tools)"}`);
            }
            if (prop in target) return (target as Record<string, unknown>)[prop as string];
            return namespaceFor(prop);
        },
        // So `Object.keys` and the console's completion see what has been listed — MINUS whatever the live
        // scope forbids. The target's own keys are filtered too, not just the map: `load()` defines real
        // properties for every bundle the key can reach, and a run must not see them enumerated any more
        // than it can reach them. Safe to omit because those properties are configurable.
        ownKeys: (target) => [...new Set([...Reflect.ownKeys(target), ...bundles.keys()])]
            .filter((k) => typeof k !== "string" || !bundles.has(k) || permitted(k)),
        getOwnPropertyDescriptor: (target, prop) =>
            (typeof prop === "string" && bundles.has(prop) && permitted(prop))
                ? { configurable: true, enumerable: true, value: namespaceFor(prop) }
                : Reflect.getOwnPropertyDescriptor(target, prop),
    });
    return root;
}
