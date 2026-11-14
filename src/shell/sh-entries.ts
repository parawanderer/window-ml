// sh-entries.ts — a step's answered `ml.sh` calls as one list of entries, for the transcript's collapsed footer.

// A step's calls are recorded in two places: an ask the person answered (`StepAsk`) and a call that ran with nobody
// asked (`ShCallSpan.unasked`). The transcript used to draw them as two separate blocks of facts. This turns both into
// the same entry, so a surface draws one row per call and one summary over them. Pure: no DOM, no preact.
// A call still WAITING on the person is not an entry: it is a gate, and a gate is drawn open (ask-card.tsx).

import type { ShCallSpan, StepAsk } from "../contract";
import { askOutcomeLines, scriptOf, shCardLines, unaskedLines, type ShCardLine, type ShFacts } from "./sh-call";
export { scriptOf };
import { putCardLines, putSubject, type PutFacts } from "./sh-put";

/** What became of a call: it ran (asked or not), the person said no, or it never got an answer. */
export type ShVerdict = "ran" | "denied" | "stopped";

/** One call, as a row. */
export interface ShEntry {
    key: string;
    verdict: ShVerdict;
    /** Asked and answered, or allowed without asking. */
    how: "asked" | "free";
    /** The sentence for the verdict: "allowed after 3 s", "ran without asking (the built-in default)", "denied". */
    said: string;
    /** The program's name, or what the call is (`ml.sh.put`). */
    program: string;
    /** The argv as the host got it (for a put, what it writes); empty for an unknown kind. */
    argv: string[];
    /** The body of a `bash -c <body>` call, with its newlines, or null when the call is not one. */
    script: string | null;
    /** How long it ran, when the step's call records say (paired by order; absent when they cannot be paired). */
    durationMs?: number;
    /** Every fact the card had: what ran, where, under which sandbox, then what it reported. */
    facts: ShCardLine[];
    /** Something deserves a look that the person could NOT have seen when they decided: shown on the collapsed row, never
     *  only inside it. For a call they were asked about, only what happened AFTER the answer counts (a weaker sandbox than
     *  asked, a protected name that changed, a kill): the card's own facts were on the card they approved. A call that ran
     *  without asking has had no review, so every warned fact counts. */
    warn: boolean;
    /** What raised `warn`, as `label: value` lines, for the row's tooltip. */
    flags: string[];
    /** The person's note on a denial, or why the ask ended without them. */
    note?: string;
}

/** How an answered ask reads, by state. Words shared with the transcript's answered-ask line. */
export const ASK_DONE: Record<StepAsk["state"], string> = {
    pending: "waiting", allowed: "allowed", denied: "denied", cancelled: "cancelled", timeout: "nobody answered in time",
    unattended: "refused: nobody to ask", ended: "the turn ended first", limit: "refused: asked too often",
};

/** The ask kinds a footer holds: the `ml.sh` calls and writes. An arrival's ask (a run held at a page) and a kind this
 *  build does not know are not calls, and stay the lines they were. */
export const isCallAsk = (kind: string): boolean => kind === "sh" || kind === "put";

/** The name of the program an argv starts, without its directory. */
const programOf = (argv: readonly string[]): string => (argv[0] ?? "").split("/").pop() || "?";

const argvOf = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

/** `after 3 s`, from an ask's two stamps; empty when it was not answered. */
const waited = (a: StepAsk): string => (a.answeredAt != null ? ` after ${Math.max(0, Math.round((a.answeredAt - a.raisedAt) / 1000))} s` : "");

/** An ask's facts and its report, in the card's words; the facts alone when the report is absent, never an error. */
function askFacts(a: StepAsk): ShCardLine[] {
    let facts: ShCardLine[] = [];
    try {
        facts = a.kind === "sh" ? shCardLines(a.facts as unknown as ShFacts)
            : a.kind === "put" ? putCardLines(a.facts as unknown as PutFacts)
                : Object.entries(a.facts ?? {}).map(([label, v]) => ({ label, value: typeof v === "string" ? v : JSON.stringify(v) }));
    } catch { /* facts of another shape: the entry says what it can and the raw view has the rest */ }
    return [...facts, ...askOutcomeLines(a)];
}

/** The warning a set of facts raises: `warn`, and the lines that raised it (an out-of-memory kill is one more). */
const flagsOf = (lines: ShCardLine[], oom: boolean): { warn: boolean; flags: string[] } => {
    const flags = [...lines.filter((l) => l.warn).map((l) => `${l.label}: ${l.value}`), ...(oom ? ["killed for running out of memory"] : [])];
    return { warn: flags.length > 0, flags };
};

/**
 * A step's answered calls, as entries, in the order they happened: the asks the person answered and the calls that ran
 * without asking, together, by when each finished (`ShCallSpan.endedAt`). A record written before that stamp existed
 * has none, and then the asks come first (in the order they were raised) and the free calls after (in the order they
 * finished), which is what the transcript always showed.
 * @param st the step's `asks` and `shCalls`
 */
export function shEntries(st: { asks?: readonly StepAsk[]; shCalls?: readonly ShCallSpan[] }): ShEntry[] {
    const calls = st.shCalls ?? [];
    const spans = calls.filter((c) => !c.unasked);
    const answered = (st.asks ?? []).filter((a) => a.state !== "pending" && isCallAsk(a.kind)).slice().sort((x, y) => x.raisedAt - y.raisedAt);
    const allowed = answered.filter((a) => a.state === "allowed" && a.kind === "sh");
    // WHICH SPAN IS WHICH ASK'S CALL. With stamps: the first call that finished after the ask was answered and that no
    // earlier ask took. Without them, one to one by position, and only where the counts agree: anything else would put
    // one call's time on another.
    const timed = spans.length > 0 && spans.every((c) => typeof c.endedAt === "number");
    const taken = new Set<number>();
    const spanOf = new Map<string, number>();
    allowed.forEach((a, k) => {
        const i = timed ? spans.findIndex((c, j) => !taken.has(j) && c.endedAt! >= (a.answeredAt ?? 0)) : spans.length === allowed.length ? k : -1;
        if (i >= 0) { taken.add(i); spanOf.set(a.id, i); }
    });
    const items: { at: number | undefined; e: ShEntry }[] = [];
    for (const a of answered) {
        const argv = a.kind === "put" ? [putSubject(a.facts as unknown as PutFacts)] : argvOf(a.facts?.argv);
        const facts = askFacts(a);
        const span = spanOf.has(a.id) ? spans[spanOf.get(a.id)!] : undefined;
        items.push({
            at: span?.endedAt ?? a.answeredAt ?? a.raisedAt,
            e: {
                key: a.id, verdict: a.state === "allowed" ? "ran" : a.state === "denied" ? "denied" : "stopped", how: "asked",
                said: `${Object.hasOwn(ASK_DONE, a.state) ? ASK_DONE[a.state] : String(a.state)}${waited(a)}`,
                program: a.kind === "put" ? "ml.sh.put" : argv.length ? programOf(argv) : a.kind,
                argv, script: a.kind === "put" ? null : scriptOf(argv),
                ...(span ? { durationMs: span.durationMs } : {}),
                facts, ...flagsOf(askOutcomeLines(a), span?.killed === "oom"),
                ...(a.note ? { note: a.note } : {}),
            },
        });
    }
    calls.forEach((c, i) => {
        const u = c.unasked;
        if (!u || !Array.isArray(u.argv)) return;
        const facts = unaskedLines(u);
        items.push({
            at: c.endedAt,
            e: {
                key: `free${i}`, verdict: "ran", how: "free",
                said: `ran without asking (${u.by === "policy" ? (u.policy ? `the policy "${u.policy}"` : "a policy") : "the built-in default"})`,
                program: programOf(u.argv), argv: argvOf(u.argv), script: scriptOf(u.argv), durationMs: c.durationMs,
                facts, ...flagsOf(facts, c.killed === "oom"),
            },
        });
    });
    // Interleaved only when every entry has an instant; otherwise the order the records came in (asks, then free).
    if (items.every((x) => x.at !== undefined)) items.sort((x, y) => x.at! - y.at!);
    return items.map((x) => x.e);
}

/** The counts the footer says: calls, how many the person answered, how many ran free, and how many need a look. */
export function shSummary(entries: readonly ShEntry[]): { calls: number; asked: number; free: number; denied: number; warns: number } {
    return {
        calls: entries.length,
        asked: entries.filter((e) => e.how === "asked").length,
        free: entries.filter((e) => e.how === "free").length,
        denied: entries.filter((e) => e.verdict === "denied").length,
        warns: entries.filter((e) => e.warn).length,
    };
}
