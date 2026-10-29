// policy-proposal.ts — a policy the MODEL proposes (`propose_policy`): checked, and its breadth measured, by the worker.

// The model never adds a policy: it proposes one, and the person approves it on a card (docs/spec/POLICIES.md, "Scopes").
// What the card leads with is the proposal's BREADTH, measured here over the run's own recorded calls and a probe of
// hosts the run never used, never anything the model said about it. A code policy's breadth can only be measured, so
// the card says it is a sample (POLICIES.md, "Showing what was approved").

import type { NeutralMessage } from "../contract/contract-chat";
import { evalPolicy, type PolicyEffect } from "../readonly-exec";
import { fetchFacts, navigateFacts } from "./sw-policies";
import { POLICY_LABEL_MAX, POLICY_SOURCE_MAX, PROPOSAL_ROWS_MAX } from "./policy-valid";

/** A proposal as the worker accepted it: the strings it checked, which are what the card shows and what is added. */
export interface PolicyProposal {
    effect: PolicyEffect;
    source: string;
    label: string;
}

/** One `fetch_url` call this run made, and what became of it. */
export interface RecordedFetch {
    url: string;
    rendered: boolean;
    credentials: boolean;
    outcome: "ran" | "denied" | "refused" | "error" | "pending";
}

/** What a proposal would have matched. */
export interface ProposalBreadth {
    /** The run's fetch_url calls the proposal was measured over. */
    calls: number;
    /** Those it matches. */
    matched: RecordedFetch[];
    /** How many URLs on hosts this run never used it was tried on. */
    tried: number;
    /** Those it matches too: non-empty means it reaches past this run's sites. */
    strays: string[];
    /** Other paths, or the other scheme, on the hosts it matched, that it matches too. */
    widens: string[];
    /** It matches navigating too (`interactive`) on a page it matches: a navigate is the same fetch (POLICIES.md). */
    navigates: boolean;
}

/** A host for a line of the card, or the URL itself when it has none. */
const hostOf = (url: string): string => { try { return new URL(url).hostname || url; } catch { return url; } };

/** Probed on every proposal, as they are: loopback and a private address are past any site, however a policy is written. */
export const FIXED_PROBE_URLS: readonly string[] = ["http://127.0.0.1/", "http://localhost/", "http://192.168.1.1/"];

/** The suffixes random probe hosts are drawn under: common public ones, and the reserved ones no real site uses. */
const PROBE_SUFFIXES = ["com", "org", "net", "io", "invalid", "example"];

/** Random integers below `n`, `count` of them. */
function randoms(count: number, n: number): number[] {
    const r = new Uint32Array(count);
    crypto.getRandomValues(r);
    return [...r].map((x) => x % n);
}

/** A DNS label of random letters and digits, of random length (3 to 12): no prefix, no fixed shape to exclude. */
function randomLabel(): string {
    const [len, ...cs] = randoms(13, 36);
    return cs.slice(0, 3 + (len % 10)).map((c) => c.toString(36)).join("");
}

/**
 * URLs on hosts no run uses: the fixed ones, then a random host under each of `PROBE_SUFFIXES` with a random path. Drawn
 * afresh for each proposal and with no fixed marker, so a policy written to miss the probe, by name (`c.host !== …`) or
 * by shape (`endsWith(".invalid")`, `startsWith("10.")`), cannot know what it has to miss (repl-specs ruling, #719).
 * @returns the probe URLs for one measure
 */
export function probeUrls(): string[] {
    const [a, b, c] = randoms(3, 254);
    return [...FIXED_PROBE_URLS, `http://10.${a}.${b}.${c + 1}/`,
        ...PROBE_SUFFIXES.map((sfx) => `https://${randomLabel()}.${sfx}/${randomLabel()}`)];
}

/**
 * Probes built from what a proposal matched: for each matched host a SIBLING at every label depth (a.b.c.d gives
 * <random>.b.c.d, <random>.c.d and <random>.d), so a policy that admits any suffix the host has, `endsWith(".github.io")`
 * as much as `endsWith(".com")`, is caught with no public suffix list (repl-specs, #719); and for each matched URL the
 * same URL at another random path and under the other scheme.
 * @param matched URLs of the run's calls the proposal matched
 * @returns `siblings` (other sites) and `variants` (the same sites, other URLs)
 */
export function relatedProbes(matched: readonly string[]): { siblings: string[]; variants: string[] } {
    const siblings = new Set<string>(), variants = new Set<string>();
    for (const url of matched.slice(0, 10)) {
        let u: URL;
        try { u = new URL(url); } catch { continue; }
        const labels = u.hostname.split(".");
        // An IP address has no parent names to share.
        if (!/^\d+$/.test(labels.at(-1)!) && !u.hostname.startsWith("["))
            for (let i = 1; i < labels.length; i++) siblings.add(`${u.protocol}//${randomLabel()}.${labels.slice(i).join(".")}/`);
        variants.add(`${u.origin}/${randomLabel()}`);
        variants.add(`${u.protocol === "https:" ? "http:" : "https:"}//${u.host}${u.pathname}${u.search}`);
    }
    return { siblings: [...siblings], variants: [...variants] };
}

/**
 * Check a proposal's arguments as the model sent them; any failure is said to the model and no card is shown.
 * @param args the call's arguments
 * @returns the accepted proposal, or the error the model reads
 */
export function checkProposal(args: Record<string, unknown>): { proposal: PolicyProposal } | { error: string } {
    const { effect, when, label } = args;
    if (effect !== "allow" && effect !== "deny" && effect !== "ask") return { error: `Error: "effect" must be "allow", "deny" or "ask".` };
    if (typeof when !== "string" || !when.trim()) return { error: `Error: "when" must be the policy's code, a function (c) => boolean.` };
    if (when.length > POLICY_SOURCE_MAX) return { error: `Error: "when" is longer than ${POLICY_SOURCE_MAX} characters; a policy is a predicate, not a program.` };
    if (typeof label !== "string" || !label.trim()) return { error: `Error: "label" must be a short sentence saying what the policy does.` };
    if (label.length > POLICY_LABEL_MAX) return { error: `Error: "label" is longer than ${POLICY_LABEL_MAX} characters.` };
    // The card quotes the label inside the worker's own sentences: a quote or a line break in it could pass the model's
    // words off as the worker's measure.
    if (/["\p{Cc}\p{Zl}\p{Zp}]/u.test(label)) return { error: `Error: "label" may not hold a double quote, a line break or a control character.` };
    // Evaluated once over a probe: a policy that cannot be read, or reads a field a fetch call does not have, is
    // refused here rather than shown to the person as a rule that would never answer anything.
    const r = evalPolicy(when, fetchFacts(FIXED_PROBE_URLS[0]), effect);
    if (r.broken) return { error: `Error: the policy does not run: ${r.broken}. It is not proposed.` };
    return { proposal: { effect, source: when, label: label.trim() } };
}

export { PROPOSAL_ROWS_MAX };

/**
 * Check a proposal as the model sent it: a list of `rules`, or the one-rule form (`effect`, `when`, `label`) older calls
 * use. Each row is checked as {@link checkProposal} does, and a bad row refuses the whole proposal, naming the row.
 * @param args the call's arguments
 * @returns the accepted rows in the order sent, or the error the model reads
 */
export function checkProposals(args: Record<string, unknown>): { proposals: PolicyProposal[] } | { error: string } {
    if (args.rules === undefined) {
        const c = checkProposal(args);
        return "error" in c ? c : { proposals: [c.proposal] };
    }
    if (args.effect !== undefined || args.when !== undefined || args.label !== undefined) return { error: `Error: send either "rules" or "effect", "when" and "label", not both.` };
    const rules = args.rules;
    if (!Array.isArray(rules) || !rules.length) return { error: `Error: "rules" must be a non-empty list of { effect, when, label }.` };
    if (rules.length > PROPOSAL_ROWS_MAX) return { error: `Error: "rules" holds ${rules.length} rules; at most ${PROPOSAL_ROWS_MAX} in one proposal.` };
    const proposals: PolicyProposal[] = [];
    for (let i = 0; i < rules.length; i++) {
        const r = rules[i];
        if (!r || typeof r !== "object" || Array.isArray(r)) return { error: `Error: rule ${i + 1} must be an object { effect, when, label }.` };
        const c = checkProposal(r as Record<string, unknown>);
        if ("error" in c) return { error: c.error.replace(/^Error: /, `Error: rule ${i + 1}: `) };
        proposals.push(c.proposal);
    }
    return { proposals };
}

/**
 * The run's fetch_url calls, read from its messages: each assistant call paired with its tool result by id.
 * @param messages the run's messages, as the loop holds them
 * @returns every call with a string `url`, in order
 */
export function recordedFetches(messages: readonly NeutralMessage[]): RecordedFetch[] {
    const results = new Map<string, string>();
    for (const m of messages) if (m.role === "tool" && typeof m.tool_call_id === "string") results.set(m.tool_call_id, String(m.content ?? ""));
    const out: RecordedFetch[] = [];
    for (const m of messages) {
        if (m.role !== "assistant" || !Array.isArray(m.tool_calls)) continue;
        for (const tc of m.tool_calls) {
            if (tc?.name !== "fetch_url") continue;
            let a: unknown = tc.arguments;
            if (typeof a === "string") try { a = JSON.parse(a); } catch { continue; }
            if (!a || typeof a !== "object" || typeof (a as { url?: unknown }).url !== "string") continue;
            const args = a as { url: string; rendered?: unknown; credentials?: unknown };
            const res = results.get(tc.id);
            out.push({
                url: args.url, rendered: !!args.rendered, credentials: !!args.credentials,
                outcome: res == null ? "pending" : res.startsWith("Denied by") ? "denied" : res.startsWith("Refused by") ? "refused" : res.startsWith("Error") ? "error" : "ran",
            });
        }
    }
    return out;
}

/**
 * Measure what a proposal matches: the run's own calls, and the probe. A call it breaks on counts as not matched, as
 * judging it would.
 * @param p the accepted proposal
 * @param calls the run's recorded calls
 * @param probes the URLs on unrelated hosts to try (fresh ones by default)
 * @returns the breadth
 */
export function measureBreadth(p: PolicyProposal, calls: readonly RecordedFetch[], probes: readonly string[] = probeUrls()): ProposalBreadth {
    const hits = (url: string, o: { rendered?: boolean; credentials?: boolean } = {}): boolean => evalPolicy(p.source, fetchFacts(url, o), p.effect).decision === p.effect;
    const navs = (url: string): boolean => evalPolicy(p.source, navigateFacts(url), p.effect).decision === p.effect;
    const any = (u: string): boolean => hits(u) || hits(u, { rendered: true }) || navs(u);
    const matched = calls.filter((c) => hits(c.url, c));
    const used = new Set(calls.map((c) => hostOf(c.url)));
    const { siblings, variants } = relatedProbes(matched.map((c) => c.url));
    const others = [...probes, ...siblings].filter((u) => !used.has(hostOf(u)));
    const strays = others.filter(any), widens = variants.filter(any);
    const navigates = [...matched.map((c) => c.url), ...strays, ...widens].some(navs);
    return { calls: calls.length, matched, tried: others.length, strays, widens, navigates };
}

/**
 * The card's first line: what the proposal does and how far it reaches, measured. Leads the card, so a broad proposal
 * is seen as broad before its code is read.
 * @param p the accepted proposal
 * @param b its breadth
 * @returns one paragraph for the card's note
 */
export function breadthNote(p: PolicyProposal, b: ProposalBreadth): string {
    const verb = p.effect === "allow" ? "fetch without asking" : p.effect === "ask" ? "ask the person before a fetch" : "refuse without asking";
    const head = `Proposed by the model for this run: ${verb} when this code returns true. "${p.label}".`;
    const hosts = [...new Set(b.matched.map((c) => hostOf(c.url)))];
    const shown = hosts.slice(0, 3).join(", ") + (hosts.length > 3 ? `, and ${hosts.length - 3} more` : "");
    const past = !b.calls ? "This run has made no fetch_url call to measure it against."
        : !b.matched.length ? `It matches none of this run's ${b.calls} fetch_url calls.`
        : `It matches ${b.matched.length} of this run's ${b.calls} fetch_url calls (${shown}).`;
    const reach = b.strays.length
        ? `It ALSO matches sites this run never used (${b.strays.map(hostOf).join(", ")}): it reaches past this run's sites.`
        : `It matched none of the ${b.tried} unrelated sites it was tried on.`;
    const wide = b.widens.length ? ` On the sites it matched, it also matches other pages or the other scheme (${b.widens.length} of those tried).` : "";
    const nav = !b.navigates ? ""
        : p.effect === "allow" ? " It also lets the run go to those pages without asking and act on them."
        : p.effect === "ask" ? " It also asks before the run goes to those pages."
        : " It also stops the run going to those pages.";
    return `${head} ${past} ${reach}${wide}${nav} Measured, not proven: other URLs may match.`;
}
