// named-reads.ts — the pointer reads an approved `exec` script names, so the worker can send their values WITH the call.

// An approved script runs in the page's world, and a pointer read there used to ring the worker (DEREF_TOKEN) for
// whatever the caller named, while the run's tool was in flight. The page shares that world, so it could name any
// pointer the run held. Instead the worker resolves the reads the script spells out, the person having approved that
// text, and the page answers only those (docs/spec/SITE_ACCESS.md slice 2, attack 14).
//
// A read is NAMED when its pointer and its pipe are literals: `ml.dereference("@tool:abc1234")`, with
// `{ pipe: "head 5" }` or `{ pipe: ["grep -E a|b", "head 2"] }`. The `@tool:` macro expands to the first form before
// this runs. A computed pointer or pipe is not named, and is refused at run time with a sentence saying so.

import { pipeStages } from "./token-pipe";
import type { DerefMeta, DerefRead } from "../contract/contract-pointers";

/** One read the script names: the pointer as written, and its pipe as stages. */
export interface NamedRead { ref: string; pipe: string[] }

/** A named read, resolved by the worker: the value with its advisory and metadata, or the error the read raises. */
export interface PreRead extends NamedRead { value?: string; warning?: string; meta?: DerefMeta; error?: string }

/** Whether the scan reached for something it could not read as a literal. */
const NOT_LITERAL = Symbol("not literal");

/** Read one JS string literal at `i` (`"…"`, `'…'`, or a template with no `${`), returning its value and where it ends. */
function stringAt(src: string, i: number): { value: string; end: number } | typeof NOT_LITERAL {
    const q = src[i];
    if (q !== '"' && q !== "'" && q !== "`") return NOT_LITERAL;
    let out = "";
    for (let j = i + 1; j < src.length; j++) {
        const c = src[j];
        if (c === q) return { value: out, end: j + 1 };
        if (q === "`" && c === "$" && src[j + 1] === "{") return NOT_LITERAL;
        if (c === "\n" && q !== "`") return NOT_LITERAL;
        if (c !== "\\") { out += c; continue; }
        const n = src[++j];
        const simple: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", "0": "\0" };
        if (n === undefined) return NOT_LITERAL;
        if (n in simple) out += simple[n];
        else if (n === "u" || n === "x") {
            const hex = n === "x" ? src.slice(j + 1, j + 3) : src[j + 1] === "{" ? src.slice(j + 2, src.indexOf("}", j)) : src.slice(j + 1, j + 5);
            const code = parseInt(hex, 16);
            if (!/^[0-9a-fA-F]+$/.test(hex) || !Number.isFinite(code) || code > 0x10ffff) return NOT_LITERAL;
            out += String.fromCodePoint(code);
            j += n === "x" ? 2 : src[j + 1] === "{" ? hex.length + 2 : 4;
        } else if (n === "\n") { /* a line continuation */ }
        else out += n;
    }
    return NOT_LITERAL;
}

const skipSpace = (src: string, i: number): number => { while (i < src.length && /\s/.test(src[i])) i++; return i; };

/** Read the options literal `{ pipe: <string | [strings]> }` at `i` (a trailing comma allowed), or nothing else. */
function pipeOptionAt(src: string, i: number): { stages: string[]; end: number } | typeof NOT_LITERAL {
    if (src[i] !== "{") return NOT_LITERAL;
    i = skipSpace(src, i + 1);
    const key = /^pipe\b/.test(src.slice(i)) ? { value: "pipe", end: i + 4 } : stringAt(src, i);
    if (key === NOT_LITERAL || key.value !== "pipe") return NOT_LITERAL;
    i = skipSpace(src, key.end);
    if (src[i] !== ":") return NOT_LITERAL;
    i = skipSpace(src, i + 1);
    let stages: string[];
    if (src[i] === "[") {
        stages = [];
        i = skipSpace(src, i + 1);
        while (src[i] !== "]") {
            const s = stringAt(src, i);
            if (s === NOT_LITERAL) return NOT_LITERAL;
            stages.push(s.value);
            i = skipSpace(src, s.end);
            if (src[i] === ",") i = skipSpace(src, i + 1);
            else if (src[i] !== "]") return NOT_LITERAL;
        }
        i++;
        stages = pipeStages(stages);
    } else {
        const s = stringAt(src, i);
        if (s === NOT_LITERAL) return NOT_LITERAL;
        stages = pipeStages(s.value);
        i = s.end;
    }
    i = skipSpace(src, i);
    if (src[i] === ",") i = skipSpace(src, i + 1);
    if (src[i] !== "}") return NOT_LITERAL;
    return { stages, end: i + 1 };
}

/**
 * The pointer reads `code` names with literals, in order, each once. Text inside a comment or a string that looks like
 * a call counts too: the person approved that text, and over-reading what it names costs only the value, never a
 * read it does not name.
 * @param code the script AFTER the `@tool:` macro has expanded it
 * @returns each named (pointer, pipe) pair
 */
export function namedReads(code: string): NamedRead[] {
    const out: NamedRead[] = [];
    const seen = new Set<string>();
    const call = /\bml\s*\.\s*dereference\s*\(/g;
    for (let m = call.exec(code); m; m = call.exec(code)) {
        let i = skipSpace(code, m.index + m[0].length);
        const ref = stringAt(code, i);
        if (ref === NOT_LITERAL) continue;
        i = skipSpace(code, ref.end);
        let pipe: string[] = [];
        if (code[i] === ",") {
            i = skipSpace(code, i + 1);
            if (code[i] !== ")") {
                const opt = pipeOptionAt(code, i);
                if (opt === NOT_LITERAL) continue;
                pipe = opt.stages;
                i = skipSpace(code, opt.end);
                if (code[i] === ",") i = skipSpace(code, i + 1);
            }
        }
        if (code[i] !== ")") continue;
        const k = readKey(ref.value, pipe);
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ ref: ref.value, pipe });
    }
    return out;
}

/** The identity of a read: its pointer as written and its stages. */
export const readKey = (ref: string, pipe: string[]): string => JSON.stringify([ref, pipe]);

/**
 * A run's resolver for one approved call, answering only the reads sent with it.
 * @param reads what the worker resolved for this call
 * @returns the resolver a tool's context binds; a read that was not sent rejects with what to write instead
 */
export function preResolvedDeref(reads: readonly PreRead[]): (ref: string, pipe?: string | string[]) => Promise<DerefRead> {
    const byKey = new Map(reads.map((r) => [readKey(r.ref, r.pipe), r]));
    return async (ref, pipe) => {
        const r = byKey.get(readKey(ref, pipeStages(pipe)));
        if (!r) throw new Error(`ml.dereference(${JSON.stringify(ref)}${pipeStages(pipe).length ? ", { pipe }" : ""}) was not named in the script, so its value was not sent with it. Write the pointer and its pipe as literals (\`@tool:<id>\`, or \`ml.dereference("<id>", { pipe: "<stages>" })\`) and run it again.`);
        if (r.error !== undefined) throw new Error(r.error);
        return { value: r.value ?? "", ...(r.warning ? { warning: r.warning } : {}), ...(r.meta ? { meta: r.meta } : {}) };
    };
}
