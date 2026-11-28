// cell-facts.ts — what one `exec` or `python_exec` cell DID, recorded by the worker once the step's result is final: the
// step's `cell` object in the JSON export, its line in the Markdown export, and its execution-log record
// (docs/spec/CELL_FACTS.md, half 1).
//
// Three rules hold for every fact here. None is model-facing: nothing in this file reaches a prompt, a tool result or
// `ml.current`. None is an input to a decision: the facts are composed after the step's approval and result exist, and
// nothing reads them back. Absent means unknown: a step with no `cell`, or a `cell` with no field, says nothing either way.

/** Which evaluator ran the cell. */
export type CellLang = "js" | "python";
/** Inside the dialect; outside it (asked, or allowed by a policy); or refused before any of its code ran. */
export type CellRan = "inside" | "outside" | "not-run";
/** Why a cell was not inside (CELL_FACTS.md, the `why.kind` table). */
export type CellWhyKind = "not-in-dialect" | "denied" | "budget" | "marked" | "argument" | "routing";
/** Where a JS cell's dialect evaluator ran: the worker decides it before dispatch, never the cell. */
export type CellRealm = "worker" | "page";

/** One lifted or host function the cell called, and the steps charged for it (its callbacks' steps are the cell's own). */
export interface CellLifted { name: string; calls: number; charged: number }
/** One `ml` wire member the cell called. */
export interface CellWire { member: string; calls: number }

/** What a cell did, as the export and the execution log carry it. Every field but `lang` and `ran` may be absent. */
export interface CellFacts {
    lang: CellLang;
    ran: CellRan;
    /** JS only: where its dialect evaluator ran. */
    realm?: CellRealm;
    /** Python only: the ladder's class of the worker when the cell started (ruling 102); absent for `not-run`. */
    class?: "A" | "B";
    /** For `outside` and `not-run`: why it was not inside. `name` is the first refused name, an identifier. */
    why?: { kind: CellWhyKind; name?: string };
    /** JS only: the step meter at the cell's end, for an inside cell and for one that tripped the budget. */
    steps?: { used: number; budget: number };
    /** JS inside cells: the host functions called, largest charge first. */
    lifted?: CellLifted[];
    /** Rows of `lifted` cut by the row cap or the size bound. */
    liftedMore?: number;
    /** JS inside cells and every Python cell: the `ml` members called over the wire. */
    wire?: CellWire[];
    /** Rows of `wire` cut by the row cap or the size bound. */
    wireMore?: number;
    /** Python: this cell set the outside mark on its worker. */
    marked?: true;
}

/** What the worker noted about a cell while its step ran, before the step's approval is known. */
export interface CellNote {
    realm?: CellRealm;
    why?: { kind: CellWhyKind; name?: string };
    steps?: { used: number; budget: number };
    lifted?: readonly CellLifted[];
    wire?: readonly CellWire[];
    /** Python: the worker carried the outside mark when the cell's inside try reached it. */
    markedWorker?: boolean;
    /** Python: an inside try reached the worker and was answered, so the worker's mark is known. */
    workerKnown?: boolean;
    /** Python: the cell set the outside mark. */
    markSet?: boolean;
}

/** Rows kept per list. */
export const CELL_ROWS_MAX = 32;
/** The longest a name may be. */
export const CELL_NAME_MAX = 120;
/** The most characters the object may take serialized; past it rows are cut, counts kept. */
export const CELL_CHARS_MAX = 4096;

const NAME_RE = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/;
const KINDS: ReadonlySet<string> = new Set<CellWhyKind>(["not-in-dialect", "denied", "budget", "marked", "argument", "routing"]);

/**
 * Whether a string is a name the facts may carry: a dotted identifier of at most {@link CELL_NAME_MAX} characters.
 * A value (a string the script built, a property key with a space) is never one.
 * @param s the candidate
 * @returns true for a name
 */
export function isCellName(s: unknown): s is string {
    return typeof s === "string" && s.length <= CELL_NAME_MAX && NAME_RE.test(s);
}

/**
 * How a step's approval reads as what the cell did. `readonly` and `sandbox` ran inside; an approval that let it run
 * ran outside; a refusal, a skip, a cancel, or no approval at all (an argument error) ran none of it.
 * @param approval the step's approval provenance
 * @returns the cell's `ran`
 */
export function ranOf(approval: string | undefined): CellRan {
    if (approval === "readonly" || approval === "sandbox") return "inside";
    if (approval === undefined || approval === "denied" || approval === "skipped" || approval === "cancelled") return "not-run";
    return "outside";
}

/**
 * Compose a cell's facts from its language, the step's approval and what the worker noted. Only what the worker decides
 * survives for a JS cell the page evaluated (`realm: "page"`): its `ran` and the worker's own `why.kind`.
 * @param lang the cell's language
 * @param approval the step's approval provenance
 * @param note what the worker noted while the step ran
 * @returns the facts, bounded
 */
export function composeCellFacts(lang: CellLang, approval: string | undefined, note: CellNote = {}): CellFacts {
    const ran = ranOf(approval);
    const out: CellFacts = { lang, ran };
    const why = ran !== "inside" && note.why && KINDS.has(note.why.kind) ? note.why : undefined;
    if (lang === "js") {
        if (note.realm) out.realm = note.realm;
        if (note.realm === "page") {
            if (why) out.why = { kind: why.kind };
            return out;
        }
        if (why) out.why = isCellName(why.name) ? { kind: why.kind, name: why.name } : { kind: why.kind };
        if (note.steps && (ran === "inside" || why?.kind === "budget")) out.steps = { used: note.steps.used, budget: note.steps.budget };
        if (ran === "inside") {
            const lifted = (note.lifted ?? []).filter((l) => isCellName(l.name));
            if (lifted.length) out.lifted = [...lifted].sort((a, b) => b.charged - a.charged || b.calls - a.calls || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).map((l) => ({ ...l }));
            const wire = (note.wire ?? []).filter((w) => isCellName(w.member));
            if (wire.length) out.wire = sortedWire(wire);
        }
    } else {
        if (ran !== "not-run" && note.workerKnown) out.class = note.markedWorker ? "B" : "A";
        // A Python refusal's name needs the fork to carry it as an attribute: never read off its text (ruling on d1).
        if (why) out.why = { kind: why.kind };
        const wire = (note.wire ?? []).filter((w) => isCellName(w.member));
        if (wire.length) out.wire = sortedWire(wire);
        if (note.markSet) out.marked = true;
    }
    return bounded(out);
}

const sortedWire = (rows: readonly CellWire[]): CellWire[] =>
    [...rows].sort((a, b) => b.calls - a.calls || (a.member < b.member ? -1 : a.member > b.member ? 1 : 0)).map((w) => ({ ...w }));

/**
 * Cut the row lists to {@link CELL_ROWS_MAX} and the whole to {@link CELL_CHARS_MAX} characters, keeping how many rows
 * were cut. The rows cut first are the last of each list, the smallest.
 * @param f the facts
 * @returns the same facts, bounded
 */
function bounded(f: CellFacts): CellFacts {
    const cut = (list: "lifted" | "wire", more: "liftedMore" | "wireMore", keep: number): void => {
        const rows = f[list] as unknown[] | undefined;
        if (!rows || rows.length <= keep) return;
        f[more] = (f[more] ?? 0) + rows.length - keep;
        if (keep) (f as unknown as Record<string, unknown[]>)[list] = rows.slice(0, keep); else delete f[list];
    };
    cut("lifted", "liftedMore", CELL_ROWS_MAX);
    cut("wire", "wireMore", CELL_ROWS_MAX);
    while (JSON.stringify(f).length > CELL_CHARS_MAX) {
        const l = f.lifted?.length ?? 0, w = f.wire?.length ?? 0;
        if (l >= w && l) cut("lifted", "liftedMore", l - 1);
        else if (w) cut("wire", "wireMore", w - 1);
        else break;
    }
    return f;
}

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

/**
 * A `cell` object made safe to store, or null when it is not one: every key known and typed, the names identifiers, the
 * lists within their row caps and the whole within {@link CELL_CHARS_MAX}. Nothing is passed through: an unknown key, a
 * wrong type or a field on the wrong language refuses the whole object, so a reader never meets a shape it does not know.
 * @param raw the candidate
 * @returns the facts, or null
 */
export function sanitizeCellFacts(raw: unknown): CellFacts | null {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const r = raw as Record<string, unknown>;
    const known = new Set(["lang", "ran", "realm", "class", "why", "steps", "lifted", "liftedMore", "wire", "wireMore", "marked"]);
    if (Object.keys(r).some((k) => !known.has(k))) return null;
    if (r.lang !== "js" && r.lang !== "python") return null;
    if (r.ran !== "inside" && r.ran !== "outside" && r.ran !== "not-run") return null;
    const out: CellFacts = { lang: r.lang, ran: r.ran };
    if (r.realm !== undefined) { if (r.lang !== "js" || (r.realm !== "worker" && r.realm !== "page")) return null; out.realm = r.realm; }
    if (r.class !== undefined) { if (r.lang !== "python" || (r.class !== "A" && r.class !== "B")) return null; out.class = r.class; }
    if (r.why !== undefined) {
        const w = r.why as Record<string, unknown> | null;
        if (!w || typeof w !== "object" || Array.isArray(w) || Object.keys(w).some((k) => k !== "kind" && k !== "name")) return null;
        if (typeof w.kind !== "string" || !KINDS.has(w.kind)) return null;
        if (w.name !== undefined && !isCellName(w.name)) return null;
        out.why = w.name !== undefined ? { kind: w.kind as CellWhyKind, name: w.name as string } : { kind: w.kind as CellWhyKind };
    }
    if (r.steps !== undefined) {
        const s = r.steps as Record<string, unknown> | null;
        if (r.lang !== "js" || !s || typeof s !== "object" || Array.isArray(s) || Object.keys(s).some((k) => k !== "used" && k !== "budget")) return null;
        if (!isCount(s.used) || !isCount(s.budget)) return null;
        out.steps = { used: s.used, budget: s.budget };
    }
    if (r.lifted !== undefined) {
        if (r.lang !== "js" || !Array.isArray(r.lifted) || r.lifted.length > CELL_ROWS_MAX) return null;
        const rows: CellLifted[] = [];
        for (const x of r.lifted as unknown[]) {
            const o = x as Record<string, unknown> | null;
            if (!o || typeof o !== "object" || Array.isArray(o) || Object.keys(o).some((k) => k !== "name" && k !== "calls" && k !== "charged")) return null;
            if (!isCellName(o.name) || !isCount(o.calls) || !isCount(o.charged)) return null;
            rows.push({ name: o.name, calls: o.calls, charged: o.charged });
        }
        out.lifted = rows;
    }
    if (r.wire !== undefined) {
        if (!Array.isArray(r.wire) || r.wire.length > CELL_ROWS_MAX) return null;
        const rows: CellWire[] = [];
        for (const x of r.wire as unknown[]) {
            const o = x as Record<string, unknown> | null;
            if (!o || typeof o !== "object" || Array.isArray(o) || Object.keys(o).some((k) => k !== "member" && k !== "calls")) return null;
            if (!isCellName(o.member) || !isCount(o.calls)) return null;
            rows.push({ member: o.member, calls: o.calls });
        }
        out.wire = rows;
    }
    for (const k of ["liftedMore", "wireMore"] as const) if (r[k] !== undefined) { if (!isCount(r[k])) return null; out[k] = r[k] as number; }
    if (r.marked !== undefined) { if (r.lang !== "python" || r.marked !== true) return null; out.marked = true; }
    if (JSON.stringify(out).length > CELL_CHARS_MAX) return null;
    return out;
}

/**
 * The facts as one line of the Markdown export, e.g. `js · inside · worker · steps 812/3000000 · lifted array.map×2 (40)`.
 * @param f the facts
 * @returns the line, without its label
 */
export function cellFactsLine(f: CellFacts): string {
    const parts: string[] = [f.lang, f.ran];
    if (f.realm) parts.push(f.realm);
    if (f.class) parts.push(`class ${f.class}`);
    if (f.why) parts.push(`why ${f.why.kind}${f.why.name ? ` ${f.why.name}` : ""}`);
    if (f.steps) parts.push(`steps ${f.steps.used}/${f.steps.budget}`);
    if (f.lifted?.length || f.liftedMore) parts.push(`lifted ${(f.lifted ?? []).map((l) => `${l.name}×${l.calls} (${l.charged})`).join(", ")}${f.liftedMore ? ` +${f.liftedMore} more` : ""}`);
    if (f.wire?.length || f.wireMore) parts.push(`wire ${(f.wire ?? []).map((w) => `${w.member}×${w.calls}`).join(", ")}${f.wireMore ? ` +${f.wireMore} more` : ""}`);
    if (f.marked) parts.push("set the outside mark");
    return parts.join(" · ");
}
