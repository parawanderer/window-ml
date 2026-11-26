// policy-proposal.ts — a policy the MODEL proposes (`propose_policy`): checked, and its breadth measured, by the worker.

// The model never adds a policy: it proposes one, and the person approves it on a card (docs/spec/POLICIES.md, "Scopes").
// What the card leads with is the proposal's BREADTH, measured here over the run's own recorded calls and a probe of
// hosts the run never used, never anything the model said about it. A code policy's breadth can only be measured, so
// the card says it is a sample (POLICIES.md, "Showing what was approved").

import type { NeutralMessage } from "../contract/contract-chat";
import { evalPolicy, type PolicyEffect } from "../readonly-exec";
import { POLICY_STEPS } from "../readonly-exec/policy-realm";
import { policyLiterals, type PolicyLiterals } from "../readonly-exec/policy-literals";
import { actFacts, fetchFacts, navigateFacts, type ActRecord } from "./sw-policies";
import { CONFIG_ENUMS, SETTING_CLASSES, configTypeOk, domainAllows, modelWritable, settingDecl, settingWidens, type SettingDecl, type SettingDomain } from "../setting-class";
import { DEFAULT_CONFIG, modelFilterAllows, type MlConfig } from "../contract/contract-config";
import { SETTING_TEXT } from "../setting-text";
import { settingFacts } from "./sw-change-setting";
import { POLICY_LABEL_MAX, POLICY_SOURCE_MAX, PROPOSAL_ROWS_MAX } from "./policy-valid";

/** A proposal as the worker accepted it: the strings it checked, which are what the card shows and what is added. */
export interface PolicyProposal {
    /** What the rule judges: a `fetch_url` or navigate (the default), a click or a type on a page, or a `change_setting`. */
    consumer: "fetch" | "act" | "setting";
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
    const consumer = args.consumer ?? "fetch";
    if (consumer !== "fetch" && consumer !== "act" && consumer !== "setting") return { error: `Error: "consumer" must be "fetch", "act" or "setting".` };
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
    const probe = consumer === "act" ? actFacts(FIXED_PROBE_URLS[0], "click", { tag: "button", href: null, name: "" })
        : consumer === "setting" ? settingFacts({ key: "theme", from: "auto", to: "dark", class: "ordinary", widens: false })
        : fetchFacts(FIXED_PROBE_URLS[0]);
    const r = evalPolicy(when, probe, effect);
    if (r.broken) return { error: `Error: the policy does not run: ${r.broken}. It is not proposed.` };
    return { proposal: { consumer, effect, source: when, label: label.trim() } };
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

/** What an `act` proposal would have matched: the run's recorded clicks and types, and clicks on pages of unrelated hosts. */
export interface ActBreadth {
    /** The clicks and types this run made, as the worker resolved them. */
    recorded: number;
    /** Those it matches. */
    matched: ActRecord[];
    /** How many unrelated pages a click on a nameless button was tried on. */
    tried: number;
    /** Those it matches too: non-empty means it reaches past this run's sites. */
    strays: string[];
}

/**
 * Measure what an `act` proposal matches: the run's recorded acts, and a click on a nameless button of each probe URL.
 * @param p the accepted proposal
 * @param acts the run's recorded clicks and types
 * @param probes the URLs on unrelated hosts to try (fresh ones by default)
 * @returns the breadth
 */
export function measureActBreadth(p: PolicyProposal, acts: readonly ActRecord[], probes: readonly string[] = probeUrls()): ActBreadth {
    const hit = (url: string, action: "click" | "type", e: ActRecord["element"]): boolean => evalPolicy(p.source, actFacts(url, action, e), p.effect).decision === p.effect;
    const matched = acts.filter((a) => hit(a.url, a.action, a.element));
    const used = new Set(acts.map((a) => hostOf(a.url)));
    const others = probes.filter((u) => !used.has(hostOf(u)));
    const strays = others.filter((u) => hit(u, "click", { tag: "button", href: null, name: "" }));
    return { recorded: acts.length, matched, tried: others.length, strays };
}

/**
 * The card's first line for an `act` rule: what it does and how far it reaches, over recorded clicks and types, saying so
 * when there are none.
 * @param p the accepted proposal
 * @param b its breadth
 * @returns one paragraph for the card's note
 */
export function actBreadthNote(p: PolicyProposal, b: ActBreadth): string {
    const verb = p.effect === "allow" ? "click or type without asking" : p.effect === "ask" ? "ask the person before a click or a type" : "refuse a click or a type without asking";
    const head = `Proposed by the model for this run: ${verb} when this code returns true. "${p.label}".`;
    const line = (a: ActRecord): string => `${a.action} "${a.element.name ?? ""}" on ${a.url}`;
    const past = !b.recorded ? "This run has made no click or type to measure it against."
        : !b.matched.length ? `It matches none of this run's ${b.recorded} clicks and types.`
        : `It matches ${b.matched.length} of this run's ${b.recorded} clicks and types (${b.matched.slice(0, 3).map(line).join("; ")}${b.matched.length > 3 ? `; and ${b.matched.length - 3} more` : ""}).`;
    const reach = b.strays.length ? `It ALSO matches a click on a nameless button of sites this run never used (${b.strays.map(hostOf).join(", ")}): it reaches past this run's sites.`
        : `It matched none of the ${b.tried} unrelated sites a click was tried on.`;
    return `${head} ${past} ${reach} Measured, not proven: other pages and buttons may match.`;
}

// --- a `setting` rule: measured over every setting the agent may change ---

/** How many random values a sampled key's `from` (and an unbounded number's `to`) is drawn, beside the current value. */
export const SETTING_RANDOM_SAMPLES = 4;
/** The widest integer range whose every value is tried as `to`; a wider one is sampled (ruling 117). It bounds the pairs a
 *  key adds, (named values) x (this), not the steps: an evaluation's steps grow with the rule's length, so the cost is
 *  about quadratic in the numbers a rule names. Measured, a rule naming 40 numbers spends 816,478 of
 *  {@link SETTING_MEASURE_STEPS} on `detachedTaskMaxMin` (60 wide) and 498,946 on `closedRunGraceMin` (sampled). What
 *  refuses a future key that would exhaust the budget is the 40-number row over SETTING_CLASSES
 *  (tests/propose-policy-setting.test.mjs), not this cap. */
export const SETTING_ENUMERATE_MAX = 256;
/** The steps every `setting` rule of one `propose_policy` call may spend being measured, shared across its rows: a
 *  predicate over the facts costs 8 to 16 steps an evaluation, 41k to 83k for a whole measure; a call that spends this
 *  is refused (MODEL_SETTINGS.md, "Size"). Counted in steps, never in wall time. */
export const SETTING_MEASURE_STEPS = 1_000_000;

/** What a `setting` rule matches of one key: over how many (from, to) pairs it was tried, and how many it matched. */
export interface SettingKeyBreadth {
    key: string;
    class: "ordinary" | "guarded";
    /** False for a boolean or enum key, every pair of whose values was tried: its answer is exact. */
    sampled: boolean;
    /** The pairs tried; 0 when the key could not be measured (a model key with no server list). */
    tried: number;
    matched: number;
    /** The pairs the rule broke on (a throw, a coercion, a missing field), and the first break's reason. */
    broken: number;
    brokeWith?: string;
}

/** What a `setting` rule matches over every key the agent may change, and the keys this run already asked to change. */
export interface SettingBreadth {
    keys: SettingKeyBreadth[];
    /** The rule's evaluations, for the spec's measured cost. */
    evaluations: number;
    /** The keys of this run's `change_setting` calls, in order, once each. */
    called: string[];
    /** The shared step budget ran out before every key was measured: the rule is refused, not shown. */
    exhausted: boolean;
}

/** What a setting measure reads: the stored config, and the server's model ids (null when they cannot be read). */
export interface SettingMeasureDeps {
    config: MlConfig;
    modelIds: readonly string[] | null;
}

/** A key's result as the card says it. */
export type SettingCover = "every" | "some" | "none" | "unmeasured";

/** The result of one key: every pair tried matched, some, none, or no pair could be tried. */
export const settingCover = (k: SettingKeyBreadth): SettingCover => !k.tried ? "unmeasured" : k.matched === k.tried ? "every" : k.matched ? "some" : "none";

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const uniqJson = (vs: unknown[]): unknown[] => { const seen = new Set<string>(); return vs.filter((v) => { const j = JSON.stringify(v); return seen.has(j) ? false : (seen.add(j), true); }); };
/** `n` values of `pool` drawn at random (repeats possible): fresh per measure, so a rule cannot know which. */
const drawn = (pool: readonly unknown[], n: number): unknown[] => (pool.length ? randoms(n, pool.length).map((i) => pool[i]) : []);

/** Every valid off-peak span, "a-b" with two different whole hours. */
const ALL_HOURS: readonly string[] = Array.from({ length: 24 * 24 }, (_, i) => `${Math.floor(i / 24)}-${i % 24}`).filter((h) => h.split("-")[0] !== h.split("-")[1]);

/** A string the rule names, and one value carrying it at each end: what a `startsWith`, `endsWith` or `includes` matches. */
const carriers = (lits: readonly string[]): string[] => lits.flatMap((l) => [l, `${l}${randomLabel()}`, `${randomLabel()}${l}`]);

/**
 * The rule's own constants as values of one key (MODEL_SETTINGS.md, "The residual of sampling"): for a number domain each
 * number and its neighbours ±1, kept to the domain; for a string domain each string the domain holds, and every value
 * of a finite list that carries one; for a guarded key, by its type. A value outside what the key takes is not added:
 * `checkSettingChange` refuses it before any judge.
 */
function literalValues(key: string, decl: SettingDecl, all: PolicyLiterals | null, pool: readonly unknown[] = []): unknown[] {
    if (!all) return [];
    // The names `c.key` is compared with are keys, not values of one.
    const lits = { ...all, strings: all.strings.filter((x) => !all.keyNames.includes(x)) };
    const near = lits.numbers.flatMap((n) => [n - 1, n, n + 1]);
    if (decl.class === "ordinary") {
        const d = decl.domain;
        if (d.kind === "number") return near.filter((v) => domainAllows(d, v) === true);
        if (d.kind === "boolean" || d.kind === "enum") return [];
        // For each string, at most one listed value that starts with it, one that ends with it and one that holds it,
        // drawn at random: what `startsWith`, `endsWith` and `includes` match, without a list's every match.
        const strs = pool.filter((v): v is string => typeof v === "string");
        const one = (f: (v: string) => boolean): string[] => drawn(strs.filter(f), 1) as string[];
        return [...lits.strings.filter((v) => pool.includes(v)),
            ...lits.strings.filter((l) => l).flatMap((l) => [...one((v) => v.startsWith(l)), ...one((v) => v.endsWith(l)), ...one((v) => v.includes(l))])];
    }
    const d = (DEFAULT_CONFIG as unknown as Record<string, unknown>)[key];
    if (Object.prototype.hasOwnProperty.call(CONFIG_ENUMS, key) || typeof d === "boolean") return [];
    if (typeof d === "number") return near.filter((v) => configTypeOk(key, v));
    const strs = carriers(lits.strings);
    return Array.isArray(d) ? strs.map((x) => [x]) : strs;
}

/**
 * The values tried for an ordinary key: `to` over its declared domain (every value where that is finite and small), and
 * `from` over every value for an exact key, else the current value and random ones.
 * @returns the values, whether they are a sample, or null when the key cannot be measured
 */
function ordinaryValues(key: string, d: SettingDomain, current: unknown, deps: SettingMeasureDeps): { from: unknown[]; to: unknown[]; sampled: boolean } | null {
    const n = SETTING_RANDOM_SAMPLES;
    const sampleFrom = (pool: readonly unknown[]): unknown[] => uniqJson([current, ...drawn(pool, n)]);
    switch (d.kind) {
        case "boolean": return { from: [true, false], to: [true, false], sampled: false };
        case "enum": return { from: [...d.words], to: [...d.words], sampled: false };
        case "number": {
            if (d.integer && d.max !== undefined && d.max - d.min + 1 <= SETTING_ENUMERATE_MAX) {
                const all = Array.from({ length: d.max - d.min + 1 }, (_, i) => d.min + i);
                return { from: sampleFrom(all), to: all, sampled: true };
            }
            const span = d.max !== undefined ? d.max - d.min : 1_000_000;
            const rand = (): number[] => randoms(n, 1_000_000).map((r) => d.integer ? d.min + (r % (Math.floor(span) + 1)) : d.min + (r / 1_000_000) * span);
            const dflt = (DEFAULT_CONFIG as unknown as Record<string, unknown>)[key];
            const to = uniqJson([d.min, ...(d.max !== undefined ? [d.max] : []), dflt, ...rand()]).filter((v) => domainAllows(d, v) === true);
            return { from: uniqJson([current, ...rand()]), to, sampled: true };
        }
        case "hours": return { from: sampleFrom(ALL_HOURS), to: [...ALL_HOURS], sampled: true };
        case "currency": {
            const all = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("currency") : [];
            return { from: sampleFrom(all), to: all, sampled: true };
        }
        case "model": {
            if (!deps.modelIds) return null;
            const ids = deps.modelIds.filter((id) => modelFilterAllows(id, deps.config.modelFilter));
            const to = [...ids, ...((DEFAULT_CONFIG as unknown as Record<string, unknown>)[key] === "" ? [""] : [])];
            return to.length ? { from: sampleFrom(ids), to, sampled: true } : null;
        }
    }
}

/**
 * The values tried for a guarded key, which has no domain: samples by type, for `from` and `to` alike (MODEL_SETTINGS.md,
 * "Proposing a `setting` policy"). Always a sample.
 */
function guardedValues(key: string, current: unknown): unknown[] {
    const d = (DEFAULT_CONFIG as unknown as Record<string, unknown>)[key];
    if (Object.prototype.hasOwnProperty.call(CONFIG_ENUMS, key)) return [...CONFIG_ENUMS[key]];
    if (typeof d === "boolean") return [true, false];
    if (Array.isArray(d)) {
        const l = Array.isArray(current) ? current as unknown[] : [];
        return uniqJson([l, [...l, `/${randomLabel()}/${randomLabel()}`], l.slice(1)]);
    }
    if (typeof d === "number") return uniqJson([current, 0, randoms(1, 10_000)[0] + 1]);
    return uniqJson(["", current, key === "agentStartPage" ? `https://${randomLabel()}.com/` : randomLabel()]);
}

/**
 * Measure what a `setting` rule matches: every key the agent may change, ordinary and guarded, each over pairs of
 * (from, to) its facts can hold. The facts are those the judge reads (`settingFacts`), so what the card says is what the
 * rule does, up to the values a sample did not draw. A pair the rule breaks on counts as not matched, as judging it would.
 * @param p the accepted proposal, consumer `setting`
 * @param deps the stored config and the server's model ids
 * @param called the keys of this run's `change_setting` calls
 * @returns the breadth
 */
export function measureSettingBreadth(p: PolicyProposal, deps: SettingMeasureDeps, called: readonly string[] = [],
    budget: { left: number } = { left: SETTING_MEASURE_STEPS }): SettingBreadth {
    const keys: SettingKeyBreadth[] = [];
    let evaluations = 0;
    const lits = policyLiterals(p.source);
    for (const key of Object.keys(SETTING_CLASSES)) {
        if (budget.left <= 0) break;
        const decl = settingDecl(key);
        if (!decl || (decl.class !== "ordinary" && decl.class !== "guarded") || !modelWritable(key)) continue;
        const current = (deps.config as unknown as Record<string, unknown>)[key] ?? (DEFAULT_CONFIG as unknown as Record<string, unknown>)[key];
        const base = decl.class === "ordinary" ? ordinaryValues(key, decl.domain, current, deps) : { from: guardedValues(key, current), to: guardedValues(key, current), sampled: true };
        // The rule's own constants join the values tried, as `from` and `to` both: a value it names is never left to a draw.
        // Each named value is paired with the base values, never with another named one, so the cost grows with the
        // named values, not with their square.
        const named = base ? uniqJson(literalValues(key, decl, lits, base.to)) : [];
        const vals = base;
        const pairs: [unknown, unknown][] = [];
        if (base) {
            for (const from of base.from) for (const to of base.to) pairs.push([from, to]);
            for (const v of named) {
                if (!base.from.some((f) => sameJson(f, v))) for (const to of base.to) pairs.push([v, to]);
                if (!base.to.some((t) => sameJson(t, v))) for (const from of base.from) pairs.push([from, v]);
            }
        }
        let tried = 0, matched = 0, broken = 0;
        let brokeWith: string | undefined;
        for (const [from, to] of pairs) {
            if (sameJson(from, to)) continue;
            if (budget.left <= 0) break;
            tried++; evaluations++;
            const facts = settingFacts({ key: key as keyof MlConfig & string, from, to, class: decl.class, widens: settingWidens(key, from, to) });
            const meter = { steps: 1 };
            const r = evalPolicy(p.source, facts, p.effect, { stepBudget: Math.min(POLICY_STEPS, budget.left), meter });
            budget.left -= Math.max(1, meter.steps);
            if (r.decision === p.effect) matched++;
            else if (r.broken && budget.left > 0) { broken++; brokeWith ??= r.broken; }
        }
        keys.push({ key, class: decl.class, sampled: vals?.sampled ?? true, tried, matched, broken, ...(brokeWith ? { brokeWith } : {}) });
    }
    return { keys, evaluations, called: [...new Set(called)], exhausted: budget.left <= 0 };
}

/**
 * The keys of the run's `change_setting` calls, read from its messages.
 * @param messages the run's messages, as the loop holds them
 * @returns each key once, in the order first asked
 */
export function recordedSettingKeys(messages: readonly NeutralMessage[]): string[] {
    const out = new Set<string>();
    for (const m of messages) {
        if (m.role !== "assistant" || !Array.isArray(m.tool_calls)) continue;
        for (const tc of m.tool_calls) {
            if (tc?.name !== "change_setting") continue;
            let a: unknown = tc.arguments;
            if (typeof a === "string") try { a = JSON.parse(a); } catch { continue; }
            const key = a && typeof a === "object" ? (a as { key?: unknown }).key : undefined;
            if (typeof key === "string" && settingDecl(key)) out.add(key);
        }
    }
    return [...out];
}

/** The most keys the covers line names before "and N more". */
const COVER_NAMED_MAX = 6;
const settingName = (key: string): string => SETTING_TEXT[key as keyof MlConfig]?.name ?? key;
const coverWords = (k: SettingKeyBreadth): string => {
    const c = settingCover(k);
    return `${settingName(k.key)} (${c === "every" ? (k.sampled ? "every value tried" : "every value") : "some values"}${k.sampled ? ", sampled" : ""})`;
};
const names = (ks: readonly SettingKeyBreadth[]): string => ks.map((k) => settingName(k.key)).join(", ");

/**
 * Why a `setting` proposal is refused before any card, or null: an allow that covers no ordinary key it could be
 * measured over frees nothing, and a card for it would read as a grant.
 * @param p the accepted proposal
 * @param b its breadth
 * @returns the error the model reads, or null
 */
export function settingRefusal(p: PolicyProposal, b: SettingBreadth): string | null {
    if (b.exhausted) return `Error: this rule takes too long to measure over every setting; a setting policy is a short predicate. It is not proposed.`;
    // A break is silent at judge time (no opinion), so a rule that breaks on any value it was tried on is refused here.
    const broke = b.keys.filter((k) => k.broken > 0);
    if (broke.length) return `Error: the rule breaks on ${broke.length} setting${broke.length === 1 ? "" : "s"} (${broke.slice(0, 3).map((k) => k.key).join(", ")}${broke.length > 3 ? ", …" : ""}: ${broke[0].brokeWith}); guard it by c.key or by typeof before reading c.from or c.to. It is not proposed.`;
    if (p.effect !== "allow") return null;
    const ordinary = b.keys.filter((k) => k.class === "ordinary");
    if (ordinary.some((k) => k.matched > 0)) return null;
    const unmeasured = ordinary.filter((k) => settingCover(k) === "unmeasured");
    const lost = unmeasured.length ? ` ${names(unmeasured)} could not be measured: the server's model list could not be read.` : "";
    return `Error: this allow covers no setting a policy can free: measured over every setting you may change, it matches none, or only guarded ones, which always ask whatever a policy says.${lost} It is not proposed.`;
}

/**
 * The card's note for a `setting` rule, leading with the measure: which settings it covers by their Settings names, which
 * could not be measured, for an allow the guarded ones it matches but cannot free, the run's own asked-for settings it
 * covers, then the model's label, then what was sampled, counting the sampled settings that showed no match.
 * @param p the accepted proposal
 * @param b its breadth
 * @returns one paragraph for the card's note
 */
export function settingBreadthNote(p: PolicyProposal, b: SettingBreadth): string {
    const allow = p.effect === "allow";
    // An allow frees an ordinary change alone (judgeSettingChange): its guarded matches are said apart.
    const scope = b.keys.filter((k) => !allow || k.class === "ordinary");
    const covered = scope.filter((k) => k.matched > 0);
    const ordinary = b.keys.filter((k) => k.class === "ordinary");
    const all = ordinary.length > 0 && ordinary.every((k) => settingCover(k) === "every");
    const lead = all ? "It covers every setting the agent may change, at every value tried."
        : !covered.length ? "It covers no setting the agent may change."
        : `It covers: ${covered.slice(0, COVER_NAMED_MAX).map(coverWords).join(", ")}${covered.length > COVER_NAMED_MAX ? `, and ${covered.length - COVER_NAMED_MAX} more` : ""}.`;
    const unmeasured = scope.filter((k) => settingCover(k) === "unmeasured");
    const lost = unmeasured.length ? ` Could not be measured: ${names(unmeasured)}.` : "";
    const guarded = allow ? b.keys.filter((k) => k.class === "guarded" && k.matched > 0) : [];
    const apart = guarded.length ? ` It would also cover, but these always ask whatever a policy says: ${names(guarded)}.` : "";
    const asked = b.called.filter((key) => b.keys.some((k) => k.key === key));
    const hit = asked.filter((key) => b.keys.find((k) => k.key === key)!.matched > 0);
    const run = !asked.length ? "" : hit.length ? ` Of the settings this run asked to change, it covers ${hit.map(settingName).join(", ")}.` : ` It covers none of the ${asked.length === 1 ? "one setting" : `${asked.length} settings`} this run asked to change.`;
    const verb = allow ? "change a setting without asking" : p.effect === "ask" ? "ask the person before a setting is changed" : "refuse a change to a setting without asking";
    const head = ` Proposed by the model for this run: ${verb} when this code returns true. "${p.label}".`;
    const full = !all && covered.length > COVER_NAMED_MAX ? ` Every setting it covers: ${covered.map(coverWords).join(", ")}.` : "";
    const silent = scope.filter((k) => k.sampled && k.tried > 0 && k.matched === 0);
    const residual = silent.length ? ` ${silent.length} sampled setting${silent.length === 1 ? "" : "s"} showed no match and could still be covered at a value not tried: ${names(silent)}.` : "";
    return `${lead}${lost}${apart}${run}${head}${full} Measured over every setting the agent may change; values marked sampled were tried, not proven.${residual}`;
}

/**
 * Measure every `setting` row of one call against ONE step budget, shared across the rows, and refuse the whole call if
 * any row is refused. The precheck calls this, and the measures it returns are the ones the card shows: they travel with
 * the call, never looked up by the rule's text, so a rule proposed again is measured again over fresh samples.
 * @param rows the call's accepted rows, in order
 * @param deps the stored config and the server's model ids
 * @param called the keys of this run's `change_setting` calls
 * @param steps the budget the rows share; the product's is {@link SETTING_MEASURE_STEPS}, a test's may be smaller
 * @returns each row's measure (undefined for a row of another consumer), or the error the model reads
 */
export function measureSettingRows(rows: readonly PolicyProposal[], deps: SettingMeasureDeps, called: readonly string[] = [],
    steps: number = SETTING_MEASURE_STEPS): { measures: (SettingBreadth | undefined)[] } | { error: string } {
    const budget = { left: steps };
    const measures: (SettingBreadth | undefined)[] = [];
    for (let i = 0; i < rows.length; i++) {
        const lit = rows[i].consumer === "setting" ? settingLiteralRefusal(rows[i]) : null;
        if (lit) return { error: rows.length > 1 ? lit.replace(/^Error: /, `Error: rule ${i + 1}: `) : lit };
        const b = rows[i].consumer === "setting" ? measureSettingBreadth(rows[i], deps, called, budget) : undefined;
        const r = b ? settingRefusal(rows[i], b) : null;
        if (r) return { error: rows.length > 1 ? r.replace(/^Error: /, `Error: rule ${i + 1}: `) : r };
        measures.push(b);
    }
    return { measures };
}

/** What a key takes, in words, from its declaration: generated, so a new setting or domain needs no sentence here. */
export function settingTakes(key: string): string {
    const decl = settingDecl(key);
    const d = (DEFAULT_CONFIG as unknown as Record<string, unknown>)[key];
    if (decl?.class === "ordinary") {
        const m = decl.domain;
        switch (m.kind) {
            case "boolean": return "true or false";
            case "enum": return `one of ${m.words.map((w) => JSON.stringify(w)).join(", ")}`;
            case "number": return `${m.integer ? "a whole number" : "a number"} ${m.max !== undefined ? `from ${m.min} to ${m.max}` : `of ${m.min} or more`}`;
            case "hours": return `a span of hours like "23-7"`;
            case "currency": return "a currency code like \"EUR\"";
            case "model": return "a model id the server lists";
        }
    }
    if (Object.prototype.hasOwnProperty.call(CONFIG_ENUMS, key)) return `one of ${CONFIG_ENUMS[key].map((w) => JSON.stringify(w)).join(", ")}`;
    return Array.isArray(d) ? "a list of strings" : `a ${typeof d}`;
}

/**
 * Why a `setting` rule is refused from its source alone, before it is measured, or null: a `c.key` it names that is no
 * setting, or a constant it compares `c.from` or `c.to` with, beside `c.key === "<key>"`, that the key can never hold.
 * Read from the declarations every check reads (`settingDecl`, `configTypeOk`, `domainAllows`), never a table of its own.
 * @param p the accepted proposal, consumer `setting`
 * @returns the error the model reads, or null
 */
export function settingLiteralRefusal(p: PolicyProposal): string | null {
    const lits = policyLiterals(p.source);
    if (!lits) return null;
    const none = lits.keyNames.find((k) => !settingDecl(k));
    if (none !== undefined) return `Error: c.key is compared with ${JSON.stringify(none.slice(0, 64))}, which is no setting (ml.settings() lists them). It is not proposed.`;
    for (const k of lits.keyed) {
        const decl = settingDecl(k.key);
        if (!decl || (decl.class !== "ordinary" && decl.class !== "guarded")) continue;
        const d = (DEFAULT_CONFIG as unknown as Record<string, unknown>)[k.key];
        const relational = k.op !== "===" && k.op !== "!==";
        // An order compares numbers alone; an equality must name a value the key can hold.
        const ok = relational ? typeof d === "number" && typeof k.value === "number"
            : Array.isArray(d) ? false
            : decl.class === "ordinary" ? domainAllows(decl.domain, k.value) !== false && configTypeOk(k.key, k.value)
            : configTypeOk(k.key, k.value);
        if (!ok) return `Error: c.${k.field} is compared with ${JSON.stringify(k.value)} where c.key is "${k.key}", which takes ${settingTakes(k.key)}${Array.isArray(d) ? " (compare its entries)" : ""}: it can never match. It is not proposed.`;
    }
    return null;
}
