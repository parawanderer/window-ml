// run-payload-check.ts — the shape a page's run-control payload (START_RUN, RESUME_RUN, INJECT_MESSAGE, PAGE_CANCEL_RUN) must have before the worker registers anything for it.

import { LEXICAL_METRICS } from "../contract/contract-config";

/** The bounds a run-control payload is held to. Each is well past what `startPayload` (run-assembly.ts) builds. */
export const RUN_PAYLOAD_LIMITS = {
    runId: 128, toolName: 128, tools: 256, capabilities: 16, images: 64, resumeMessages: 20_000, toolNames: 256, depth: 64,
} as const;

/** Keys that would reach an object's prototype if a later copy used assignment rather than definition. */
const PROTO_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

type Check = (v: unknown, at: string) => string | null;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const has = (o: Record<string, unknown>, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined;

/** A run id: a short token of letters, digits, `_`, `.` and `-`, never a prototype key (a session key splits on `:`). */
function runIdError(v: unknown, at = "runId"): string | null {
    if (typeof v !== "string") return `${at} must be a string`;
    if (!new RegExp(`^[A-Za-z0-9_.-]{1,${RUN_PAYLOAD_LIMITS.runId}}$`).test(v)) return `${at} must be 1 to ${RUN_PAYLOAD_LIMITS.runId} letters, digits, "_", "." or "-"`;
    if (PROTO_KEYS.has(v)) return `${at} may not be "${v}"`;
    return null;
}

/**
 * Walk a value for an own `__proto__` key at any depth, and for nesting past `RUN_PAYLOAD_LIMITS.depth`. Iterative, so a
 * deep payload cannot exhaust the worker's stack while it is checked.
 * @param root the payload
 * @param at its name in an error
 * @returns the first problem, or null
 */
function structureError(root: unknown, at: string): string | null {
    const stack: [unknown, number, string][] = [[root, 0, at]];
    while (stack.length) {
        const [v, depth, path] = stack.pop()!;
        if (typeof v !== "object" || v === null) continue;
        if (depth > RUN_PAYLOAD_LIMITS.depth) return `${at} is nested deeper than ${RUN_PAYLOAD_LIMITS.depth} levels`;
        if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) stack.push([v[i], depth + 1, `${path}[${i}]`]); continue; }
        for (const k of Object.keys(v)) {
            if (k === "__proto__") return `${path} has a "__proto__" key`;
            stack.push([(v as Record<string, unknown>)[k], depth + 1, `${path}.${k}`]);
        }
    }
    return null;
}

const optional = (check: Check): Check => (v, at) => (v === undefined ? null : check(v, at));
const str: Check = (v, at) => (typeof v === "string" ? null : `${at} must be a string`);
const bool: Check = (v, at) => (typeof v === "boolean" ? null : `${at} must be true or false`);
const strOrNull: Check = (v, at) => (v === null || typeof v === "string" ? null : `${at} must be a string or null`);
const boolOrNull: Check = (v, at) => (v === null || typeof v === "boolean" ? null : `${at} must be true, false or null`);
const obj: Check = (v, at) => (isObject(v) ? null : `${at} must be an object`);
const count: Check = (v, at) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? null : `${at} must be a whole number`);
const oneOf = (values: readonly string[]): Check => (v, at) => (typeof v === "string" && values.includes(v) ? null : `${at} must be one of ${values.map((x) => `"${x}"`).join(", ")}`);
const listOf = (max: number, item: Check): Check => (v, at) => {
    if (!Array.isArray(v)) return `${at} must be an array`;
    if (v.length > max) return `${at} has ${v.length} entries, more than ${max}`;
    for (let i = 0; i < v.length; i++) { const e = item(v[i], `${at}[${i}]`); if (e) return e; }
    return null;
};
/** An object whose named fields each pass their check; other fields are left to the code that reads them. */
const shape = (fields: Record<string, Check>, required: readonly string[] = []): Check => (v, at) => {
    if (!isObject(v)) return `${at} must be an object`;
    for (const k of required) if (!has(v, k)) return `${at}.${k} is missing`;
    for (const [k, check] of Object.entries(fields)) { const e = check(v[k], `${at}.${k}`); if (e) return e; }
    return null;
};

const remote = shape({ via: oneOf(["openwebui"]), toolId: str, fn: str }, ["via", "toolId", "fn"]);
const toolName: Check = (v, at) => (typeof v === "string" && v.length > 0 && v.length <= RUN_PAYLOAD_LIMITS.toolName ? null : `${at} must be a name of 1 to ${RUN_PAYLOAD_LIMITS.toolName} characters`);
const tool = shape({
    name: toolName, description: optional(str), parameters: optional(obj), requiresApproval: bool,
    capabilities: listOf(RUN_PAYLOAD_LIMITS.capabilities, str), precheck: optional(bool), summary: optional(str), remote: optional(remote),
}, ["name", "requiresApproval", "capabilities"]);
/** A history message: an object with a role. Its content and tool calls are left as they are: a session saved by an older
 *  build holds tool calls in the wire shape (`function.name`), and the loop and the format adapters read both. */
const message = shape({ role: oneOf(["system", "user", "assistant", "tool"]) }, ["role"]);
/** A rebuild's vision facts (`driverSees`, `visionModel`, `groundingModel`, `groundingRange`) are left to `run-vision.ts`,
 *  which reads each as the type it needs and treats anything else as absent (review-locate.test.mjs, "handed-over"). */
const rebuild = shape({
    toolNames: listOf(RUN_PAYLOAD_LIMITS.toolNames, str), model: optional(strOrNull), pierceClosed: optional(bool), cdp: optional(bool), crossOrigin: optional(bool),
    builtBy: optional(oneOf(["worker"])),
}, ["toolNames"]);

/** Every START_RUN field the worker reads (StartRunPayload), with its check. Two are left to their readers, which take any
 *  value: `maxSteps` to `stepBudget` (a bounded budget or none), and `approvalRouting`, compared to "both" and "external"
 *  only, so an unknown value shows and blocks the gate as "ui" does (redteam-page-run-builtby.test.mjs). */
const START_FIELDS: Record<string, Check> = {
    runId: (v, at) => runIdError(v, at), task: str, systemPrompt: str, tools: listOf(RUN_PAYLOAD_LIMITS.tools, tool),
    model: optional(strOrNull), think: optional(boolOrNull), display: optional(obj), origin: optional(obj), builtBy: optional(oneOf(["worker"])),
    stream: optional(bool), autoApprovePython: optional(bool), autoApproveReadonly: optional(bool), autoApproveSameOriginAuth: optional(bool),
    autoApproveSelfSource: optional(bool), selfIntrospection: optional(bool), toolTokens: optional(bool), unattended: optional(bool), silent: optional(bool),
    resumeMessages: optional(listOf(RUN_PAYLOAD_LIMITS.resumeMessages, message)), images: optional(listOf(RUN_PAYLOAD_LIMITS.images, str)),
    stepBase: optional(count), seqBase: optional(count), labelMatch: optional(oneOf(LEXICAL_METRICS)), surface: optional(oneOf(["overlay", "devtools", "off"])),
    pageOrigin: optional(str), pageUrl: optional(str), pageTitle: optional(str),
    crossOrigin: optional(bool), crossPage: optional(bool), rebuild: optional(rebuild), env: optional(bool),
};
const START_REQUIRED = ["runId", "task", "systemPrompt", "tools"] as const;

const RESUME_FIELDS: Record<string, Check> = { runId: (v, at) => runIdError(v, at), task: str };
const INJECT_FIELDS: Record<string, Check> = { runId: (v, at) => runIdError(v, at), text: str, sayId: optional(str), origin: optional(obj), waitForPerson: optional(str) };
const CANCEL_FIELDS: Record<string, Check> = { runId: (v, at) => runIdError(v, at) };

const FIELDS: Record<string, [Record<string, Check>, readonly string[]]> = {
    START_RUN: [START_FIELDS, START_REQUIRED],
    RESUME_RUN: [RESUME_FIELDS, ["runId", "task"]],
    INJECT_MESSAGE: [INJECT_FIELDS, ["runId", "text"]],
    PAGE_CANCEL_RUN: [CANCEL_FIELDS, ["runId"]],
};

/**
 * What is wrong with a run-control message's payload, checked before the worker registers anything for it: every
 * field the worker reads has the type it is read as, every list is bounded, and no object at any depth carries an own
 * `__proto__` key. Fields the worker does not read are left alone.
 * @param type the message type (`RUN_CONTROL_TYPES`, page-relay.ts)
 * @param payload the payload as it arrived
 * @returns the error to answer with (`"<TYPE> refused: …"`), or null when the payload may be acted on, or the type is not run control
 */
export function runControlPayloadError(type: string, payload: unknown): string | null {
    const spec = FIELDS[type];
    if (!spec) return null;
    const [fields, required] = spec;
    const refuse = (why: string): string => `${type} refused: ${why}.`;
    if (!isObject(payload)) return refuse("the payload must be an object");
    const deep = structureError(payload, "payload");
    if (deep) return refuse(deep);
    for (const k of required) if (!has(payload, k)) return refuse(`${k} is missing`);
    for (const [k, check] of Object.entries(fields)) {
        if (payload[k] === undefined) continue;
        const e = check(payload[k], k);
        if (e) return refuse(e);
    }
    return null;
}
