// pkg-pep508.ts — PEP 508 requirements (`requires_dist` entries) and their environment markers, parsed and evaluated as Python's `packaging` 26.3 does, for the install verdict.

// A port of `packaging`'s tokenizer and recursive-descent parser (`_tokenizer.py`, `_parser.py`, `markers.py`), with
// the same grammar and the same quirks: `<` and `>` between two strings are false and `<=`/`>=` mean equality, a
// version-valued key (`python_version` and three more) compares as a specifier, and `or` binds looser than `and`.
// Like pkg-pep440.ts it is total and bounded: an input over its cap, outside printable ASCII, or off the grammar is
// `null`, a marker that cannot be evaluated (an unknown key, `~=` between strings) is `undefined`, and no regular
// expression is built from an input. A quoted string holding a backslash is refused: `packaging` reads it with
// Python's `ast.literal_eval`, whose escapes are not worth porting for a string no real release carries.

import { SPEC_TOKEN_RE, parseSpecifier, parseSpecifierSet, specifierSetContains, type Pep440SpecifierSet } from "./pkg-pep440";

/** The longest requirement string read; the longest in the pinned index snapshot is 569 characters. */
export const MAX_REQUIREMENT_CHARS = 2048;

/** How deep a marker's parentheses may nest. */
export const MAX_MARKER_DEPTH = 32;

/** PEP 503's normal form of a project name: lower case, each run of `-`, `_` and `.` one `-`. */
export function canonicalName(name: string): string {
    return name.toLowerCase().replace(/[-_.]+/g, "-");
}

/** One side of a marker comparison: an environment key, or a quoted string. */
type MarkerVar = { kind: "var"; name: string } | { kind: "str"; value: string };

/** A marker comparison, or a parenthesised marker. */
type MarkerAtom = { lhs: MarkerVar; op: string; rhs: MarkerVar } | MarkerTree;

/** A marker as `or` of `and`s: true when every atom of some group is. */
export interface MarkerTree { groups: MarkerAtom[][] }

/** A parsed requirement: the project's canonical name, its extras, its ranges, its marker. */
export interface Pep508Requirement {
    name: string;
    extras: string[];
    specifier: Pep440SpecifierSet;
    url: string | null;
    marker: MarkerTree | null;
}

const RULES = {
    LEFT_PARENTHESIS: /\(/y,
    RIGHT_PARENTHESIS: /\)/y,
    LEFT_BRACKET: /\[/y,
    RIGHT_BRACKET: /\]/y,
    SEMICOLON: /;/y,
    COMMA: /,/y,
    QUOTED_STRING: /'[^']*'|"[^"]*"/y,
    OP: /===|==|~=|!=|<=|>=|<|>/y,
    BOOLOP: /\b(?:or|and)\b/y,
    IN: /\bin\b/y,
    NOT: /\bnot\b/y,
    VARIABLE: /\b(?:python_version|python_full_version|os[._]name|sys[._]platform|platform_(?:release|system)|platform[._](?:version|machine|python_implementation)|python_implementation|implementation_(?:name|version)|extras?|dependency_groups)\b/y,
    SPECIFIER: SPEC_TOKEN_RE,
    AT: /@/y,
    URL: /[^ \t]+/y,
    IDENTIFIER: /\b[a-zA-Z0-9][a-zA-Z0-9._-]*\b/y,
    VERSION_PREFIX_TRAIL: /\.\*/y,
    VERSION_LOCAL_LABEL_TRAIL: /\+[a-z0-9]+(?:[-_.][a-z0-9]+)*/y,
    WS: /[ \t]+/y,
} as const;

type Rule = keyof typeof RULES | "END";

/** Thrown inside the parser and caught at its edge: never leaves this module. */
class Syntax extends Error {}

/** `packaging`'s tokenizer: match a named rule at the current position, without consuming unless read. */
class Tokenizer {
    pos = 0;
    private next: { rule: Rule; text: string } | null = null;
    constructor(readonly source: string) {}

    check(rule: Rule): boolean {
        if (this.next) throw new Syntax("check after check");
        if (rule === "END") {
            if (this.pos !== this.source.length) return false;
            this.next = { rule, text: "" };
            return true;
        }
        const re = RULES[rule];
        re.lastIndex = this.pos;
        const m = re.exec(this.source);
        if (!m) return false;
        this.next = { rule, text: m[0] };
        return true;
    }

    /** Whether the rule matches here, without keeping the match. */
    peek(rule: Rule): boolean {
        const hit = this.check(rule);
        this.next = null;
        return hit;
    }

    consume(rule: Rule): void {
        if (this.check(rule)) this.read();
    }

    expect(rule: Rule): string {
        if (!this.check(rule)) throw new Syntax(`expected ${rule}`);
        return this.read();
    }

    read(): string {
        const t = this.next;
        if (!t) throw new Syntax("read without check");
        this.pos += t.text.length;
        this.next = null;
        return t.text;
    }

    /** `packaging`'s `enclosing_tokens`: an optional opening token, `body`, then its closing token if it was there. */
    enclosed<T>(open: Rule, close: Rule, body: () => T): T {
        const opened = this.check(open);
        if (opened) this.read();
        const out = body();
        if (opened) this.expect(close);
        return out;
    }
}

/** A quoted string's value, the quotes removed; a backslash or a control character is refused. */
function quoted(text: string): string {
    const inner = text.slice(1, -1);
    if (/[\\\x00-\x08\x0a-\x1f\x7f]/.test(inner)) throw new Syntax("escape in quoted string");
    return inner;
}

function parseMarkerVar(t: Tokenizer): MarkerVar {
    if (t.check("VARIABLE")) {
        const name = t.read().replace(/\./g, "_");
        return { kind: "var", name: name === "python_implementation" ? "platform_python_implementation" : name };
    }
    if (t.check("QUOTED_STRING")) return { kind: "str", value: quoted(t.read()) };
    throw new Syntax("expected a marker variable or quoted string");
}

function parseMarkerOp(t: Tokenizer): string {
    if (t.check("IN")) { t.read(); return "in"; }
    if (t.check("NOT")) {
        t.read();
        t.expect("WS");
        t.expect("IN");
        return "not in";
    }
    if (t.check("OP")) return t.read();
    throw new Syntax("expected a marker operator");
}

/** `extra == "Foo_Bar"` compares canonical names: the literal is normalized at parse time, as `packaging` does. */
function normalizeExtra(lhs: MarkerVar, rhs: MarkerVar): [MarkerVar, MarkerVar] {
    if (lhs.kind === "var" && lhs.name === "extra" && rhs.kind === "str") return [lhs, { kind: "str", value: canonicalName(rhs.value) }];
    if (rhs.kind === "var" && rhs.name === "extra" && lhs.kind === "str") return [{ kind: "str", value: canonicalName(lhs.value) }, rhs];
    if (rhs.kind === "var" && (rhs.name === "extras" || rhs.name === "dependency_groups") && lhs.kind === "str")
        return [{ kind: "str", value: canonicalName(lhs.value) }, rhs];
    return [lhs, rhs];
}

function parseMarkerAtom(t: Tokenizer, depth: number): MarkerAtom {
    t.consume("WS");
    let atom: MarkerAtom;
    if (t.peek("LEFT_PARENTHESIS")) {
        if (depth >= MAX_MARKER_DEPTH) throw new Syntax("marker nested too deep");
        atom = t.enclosed("LEFT_PARENTHESIS", "RIGHT_PARENTHESIS", () => {
            t.consume("WS");
            const m = parseMarker(t, depth + 1);
            t.consume("WS");
            return m;
        });
    } else {
        t.consume("WS");
        const l = parseMarkerVar(t);
        t.consume("WS");
        const op = parseMarkerOp(t);
        t.consume("WS");
        const r = parseMarkerVar(t);
        t.consume("WS");
        const [lhs, rhs] = normalizeExtra(l, r);
        atom = { lhs, op, rhs };
    }
    t.consume("WS");
    return atom;
}

function parseMarker(t: Tokenizer, depth: number): MarkerTree {
    const groups: MarkerAtom[][] = [[parseMarkerAtom(t, depth)]];
    while (t.check("BOOLOP")) {
        if (t.read() === "or") groups.push([]);
        groups[groups.length - 1].push(parseMarkerAtom(t, depth));
    }
    return { groups };
}

function parseExtras(t: Tokenizer): string[] {
    if (!t.peek("LEFT_BRACKET")) return [];
    return t.enclosed("LEFT_BRACKET", "RIGHT_BRACKET", () => {
        t.consume("WS");
        const extras: string[] = [];
        if (t.check("IDENTIFIER")) {
            extras.push(t.read());
            for (;;) {
                t.consume("WS");
                if (t.peek("IDENTIFIER")) throw new Syntax("expected comma between extra names");
                if (!t.check("COMMA")) break;
                t.read();
                t.consume("WS");
                extras.push(t.expect("IDENTIFIER"));
            }
        }
        t.consume("WS");
        return extras;
    });
}

function parseVersionMany(t: Tokenizer): string {
    let out = "";
    while (t.check("SPECIFIER")) {
        out += t.read();
        if (t.peek("VERSION_PREFIX_TRAIL")) throw new Syntax(".* suffix");
        if (t.peek("VERSION_LOCAL_LABEL_TRAIL")) throw new Syntax("local label");
        t.consume("WS");
        if (!t.check("COMMA")) break;
        out += t.read();
        t.consume("WS");
    }
    return out;
}

function parseRequirementMarker(t: Tokenizer): MarkerTree {
    t.expect("SEMICOLON");
    const m = parseMarker(t, 0);
    t.consume("WS");
    return m;
}

/** Parse one requirement (`requests[socks]>=2.31; python_version >= "3.9"`), or `null` when it is not one. */
export function parseRequirement(source: unknown): Pep508Requirement | null {
    if (typeof source !== "string" || source.length > MAX_REQUIREMENT_CHARS || !/^[\t\x20-\x7e]*$/.test(source)) return null;
    try {
        const t = new Tokenizer(source);
        t.consume("WS");
        const name = t.expect("IDENTIFIER");
        t.consume("WS");
        const extras = parseExtras(t);
        t.consume("WS");
        let url: string | null = null, spec = "", marker: MarkerTree | null = null;
        if (t.check("AT")) {
            t.read();
            t.consume("WS");
            url = t.expect("URL");
            if (!t.peek("END")) {
                t.expect("WS");
                if (!t.peek("END")) marker = parseRequirementMarker(t);
            }
        } else {
            spec = t.enclosed("LEFT_PARENTHESIS", "RIGHT_PARENTHESIS", () => {
                t.consume("WS");
                const s = parseVersionMany(t);
                t.consume("WS");
                return s;
            });
            t.consume("WS");
            if (!t.peek("END")) marker = parseRequirementMarker(t);
        }
        t.expect("END");
        const specifier = parseSpecifierSet(spec);
        if (!specifier) return null;
        return { name: canonicalName(name), extras: extras.map(canonicalName), specifier, url, marker };
    } catch (e) {
        if (e instanceof Syntax) return null;
        throw e;
    }
}

/** The keys whose values compare as versions. */
const VERSION_KEYS = new Set(["implementation_version", "platform_release", "python_full_version", "python_version"]); // state: fixed

/** Thrown when a marker cannot be evaluated; caught in `evaluateMarker`. */
class Undefined extends Error {}

function evalOp(lhs: string, op: string, rhs: string, key: string): boolean {
    if (VERSION_KEYS.has(key)) {
        const spec = parseSpecifier(op + rhs);
        if (spec) return specifierSetContains([spec], lhs);
    }
    switch (op) {
        case "in": return rhs.includes(lhs);
        case "not in": return !rhs.includes(lhs);
        case "<": case ">": return false;
        case "<=": case "==": case ">=": return lhs === rhs;
        case "!=": return lhs !== rhs;
        default: throw new Undefined(op);
    }
}

function lookup(env: Readonly<Record<string, string>>, key: string): string {
    if (!Object.hasOwn(env, key)) throw new Undefined(key);
    return env[key];
}

function evalTree(tree: MarkerTree, env: Readonly<Record<string, string>>): boolean {
    // Every atom is evaluated, as `packaging` does: an undefined key raises even after a group is already true.
    const results = tree.groups.map((g) => g.map((a) => {
        if ("groups" in a) return evalTree(a, env);
        let key: string, l: string, r: string;
        if (a.lhs.kind === "var") {
            key = a.lhs.name;
            l = lookup(env, key);
            r = a.rhs.kind === "var" ? a.rhs.name : a.rhs.value;
        } else {
            key = a.rhs.kind === "var" ? a.rhs.name : a.rhs.value;
            l = a.lhs.value;
            r = lookup(env, key);
        }
        return evalOp(l, a.op, r, key);
    }));
    return results.some((g) => g.every(Boolean));
}

/** Evaluate a marker against a marker environment (with `extra` empty, as for a requirement with no extras asked),
 *  or `undefined` when it cannot be: a key the environment lacks, or an operator undefined on its operands. */
export function evaluateMarker(tree: MarkerTree, env: Readonly<Record<string, string>>): boolean | undefined {
    const full: Record<string, string> = { ...env, extra: "" };
    if (typeof full.python_full_version === "string" && full.python_full_version.endsWith("+")) full.python_full_version += "local";
    try {
        return evalTree(tree, full);
    } catch (e) {
        if (e instanceof Undefined) return undefined;
        throw e;
    }
}
