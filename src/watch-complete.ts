// watch-complete.ts — COMPLETION for a watch as it is typed (docs/spec/STATE_INSPECTOR.md, "Watches"), and for the
// read-only console after it: what may follow the text before the caret. Pure, over the tree's SHAPE (state-watch.ts,
// `treeShape`) and the dialect's own method lists (`offeredMethods`), so it offers only names that resolve to
// something and calls the dialect allows.

import { offeredMethods } from "./readonly-exec/policy";
import type { WatchShape } from "./state-watch";

/** One thing that may be inserted. */
export interface WatchCompletion {
    /** What the list shows. */
    label: string;
    /** What replaces the text from `from` to the caret: the label, or `["odd key"]` for a key that is not a name. */
    insert: string;
    /** Where the replaced text starts. */
    from: number;
    /** `key`, `method` or `root`, for the list's styling. */
    kind: "key" | "method" | "root";
    /** What it holds, said shortly (`[12]`, `{4}`, `string`), or `()` for a method. */
    detail: string;
}

/** The most a list offers. */
export const MAX_COMPLETIONS = 50;

/** The callable namespaces a watch may name, each with the dialect's kind for its statics. */
const NAMESPACES: Record<string, string> = { Math: "Math", JSON: "JSON", Object: "ObjectCtor", Array: "ArrayCtor" };
/** The free functions a watch may call (the dialect's CALLABLE_ROOTS, less the page-only `getComputedStyle`). */
const FREE_FNS = ["String", "Number", "Boolean", "parseInt", "parseFloat", "isNaN", "isFinite"];

const IDENT = /^[A-Za-z_$][\w$]*$/;
/** A member chain ending at the caret: its head, its steps, then `.` and the partial name being typed. Not preceded by
 *  `.`, `)` or a name character, so `f(x).` and the middle of a longer chain do not match. */
const MEMBER_AT_CARET = /(?:^|[^\w$.\])])((?:[A-Za-z_$][\w$]*)(?:\.[A-Za-z_$][\w$]*|\[\d+\]|\["(?:[^"\\]|\\.)*"\])*)\.([A-Za-z_$][\w$]*)?$/;
/** A bare name being typed where a root goes. */
const ROOT_AT_CARET = /(?:^|[^\w$.\])"'`])([A-Za-z_$][\w$]*)$/;

/** A shape said shortly, for a key's detail. */
function describe(s: WatchShape | undefined): string {
    if (!s) return "";
    if (s.t === "object") return `{${Object.keys(s.keys).length + (s.more ?? 0)}}`;
    if (s.t === "array") return `[${s.n}]`;
    return s.t;
}

/** One step down a shape: a key, an index, or `length`; undefined where the shape does not go. */
function step(s: WatchShape | undefined, key: string | number): WatchShape | undefined {
    if (!s) return undefined;
    if (s.t === "array") return typeof key === "number" ? s.item : key === "length" ? { t: "number" } : undefined;
    if (s.t === "string") return key === "length" ? { t: "number" } : undefined;
    if (s.t === "object" && typeof key === "string") return Object.hasOwn(s.keys, key) ? s.keys[key] : undefined;
    return undefined;
}

/** The steps of a chain after its head: names, indexes and quoted keys. */
function steps(rest: string): (string | number)[] {
    const out: (string | number)[] = [];
    for (const m of rest.matchAll(/\.([A-Za-z_$][\w$]*)|\[(\d+)\]|\["((?:[^"\\]|\\.)*)"\]/g))
        out.push(m[1] ?? (m[2] != null ? Number(m[2]) : JSON.parse(`"${m[3]}"`)));
    return out;
}

/**
 * What may follow the text before the caret. After `chain.` (or `chain.par`): the keys of what the chain names, and the
 * methods the dialect allows on its kind. At a bare name: the roots a watch starts from. Elsewhere, nothing; and a name
 * already typed in full is not offered back, so a finished name shuts the list.
 * @param text the whole input
 * @param caret where the caret is in it
 * @param shape the tree's shape, from the worker; absent before the first read
 */
export function completeWatch(text: string, caret: number, shape: WatchShape | undefined): WatchCompletion[] {
    const before = text.slice(0, caret);
    // Inside a string literal nothing completes: count the quotes before the caret.
    if ((before.match(/(?<!\\)["'`]/g)?.length ?? 0) % 2) return [];
    const member = MEMBER_AT_CARET.exec(before);
    if (member) {
        const [, chain, partial = ""] = member;
        const head = /^[A-Za-z_$][\w$]*/.exec(chain)![0];
        const from = caret - partial.length;
        if (head in NAMESPACES && chain === head) return methods(NAMESPACES[head], partial, from);
        let at: WatchShape | undefined = head === "$" ? shape : shape?.t === "object" ? step(shape, head) : undefined;
        for (const s of steps(chain.slice(head.length))) at = step(at, s);
        return at ? membersOf(at, partial, from) : [];
    }
    const root = ROOT_AT_CARET.exec(before);
    if (!root) return [];
    const partial = root[1], from = caret - partial.length;
    const names: [string, string][] = [
        ...(shape?.t === "object" ? Object.keys(shape.keys).map((k): [string, string] => [k, describe(shape.keys[k])]) : []),
        ...Object.keys(NAMESPACES).map((k): [string, string] => [k, ""]),
        ...FREE_FNS.map((k): [string, string] => [k, "()"]),
    ];
    return names.filter(([n]) => n.startsWith(partial) && n !== partial)
        .slice(0, MAX_COMPLETIONS).map(([n, d]) => ({ label: n, insert: n, from, kind: "root", detail: d }));
}

/** The keys and methods on a value of this shape that start with `partial`, less one typed in full. */
function membersOf(s: WatchShape, partial: string, from: number): WatchCompletion[] {
    const keys: WatchCompletion[] = [];
    if (s.t === "object")
        for (const [k, v] of Object.entries(s.keys))
            if (k.startsWith(partial) && k !== partial) keys.push({ label: k, insert: IDENT.test(k) ? k : `["${k.replace(/["\\]/g, "\\$&")}"]`,
                // A key that is not a name replaces the `.` too: `x.["a b"]` is no syntax.
                from: IDENT.test(k) ? from : from - 1, kind: "key", detail: describe(v) });
    if ((s.t === "array" || s.t === "string") && "length".startsWith(partial) && partial !== "length") keys.push({ label: "length", insert: "length", from, kind: "key", detail: "number" });
    const kind = s.t === "array" ? "array" : s.t === "string" ? "string" : s.t === "number" ? "number" : "";
    return [...keys, ...(kind ? methods(kind, partial, from) : [])].slice(0, MAX_COMPLETIONS);
}

/** The dialect's methods for a kind that start with `partial`. */
function methods(kind: string, partial: string, from: number): WatchCompletion[] {
    return offeredMethods(kind).filter((m) => m.startsWith(partial) && m !== partial)
        .map((m) => ({ label: m, insert: m, from, kind: "method" as const, detail: "()" }));
}
