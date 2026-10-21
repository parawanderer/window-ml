// policy-proposals.prompt.ts — what the two policy-writing interviews ask: the facts a policy reads, the rules, one need per turn.

import type { AskDef, InterviewDef } from "../bench/spec";
import { NEEDS, extract, type Need } from "./policy-proposals.score";
import { TOOL_DETAILS } from "../../../src/tools/tool-details";

/** The rules of the realm every policy runs in (docs/spec/POLICIES.md), in the words a model needs. */
const RULES_BASE = `A policy is a read-only JS function over ONE call, \`(c) => …\`, returning true when it applies and false when it does not. It runs in a restricted interpreter: \`==\` and \`!=\` are refused (use \`===\`/\`!==\`), reading a field \`c\` does not have is an error (the policy is then BROKEN and ignored, so a typo never applies), and a result that is not a boolean is broken too. String methods, array methods, regex literals and \`const\` lists before the function work.`;

/** The rules per consumer. A fetch policy is what `propose_policy` sends, so its interview reads that tool's details too,
 *  the same text `agent_api_docs({ tool: "propose_policy" })` serves (added after the first run of 2026-10-21). */
const RULES = { fetch: `${RULES_BASE}\n\n${TOOL_DETAILS.propose_policy}`, sh: RULES_BASE } as const;

/** What `c` holds, per consumer: fetch_url's facts (sw-policies.ts `fetchFacts`) and ml.sh's (sh-call.ts `ShFacts`). */
const FACTS = {
    fetch: `A \`fetch_url\` call gives:
| field | what |
| --- | --- |
| \`url\` | the URL as asked, a string |
| \`host\` | its hostname, lower-cased |
| \`method\` | always \`"GET"\` |
| \`credentials\` | true when the person's cookies are sent |
| \`rendered\` | true when the page is rendered in a tab rather than fetched |
| \`kind\` | always \`"fetch"\` |
| \`effects\` | what the call does as (operation, resource) pairs: \`c.effects.pairs\` is a list of \`{ op, res }\`, here one \`{ op: "read", res: { kind: "net", host } }\`; \`c.effects.unknown\` is true when nothing could be said |`,
    sh: `An \`ml.sh\` call (a program run on the person's machine, with no shell: an argument vector the host spawns) gives facts the host resolved, never text to re-parse:
| field | what |
| --- | --- |
| \`argv\` | the argument vector, strings: \`["git", "diff", "HEAD~1"]\` |
| \`program\` | \`{ path, inRoot, version }\`: \`argv[0]\` resolved to the file that runs |
| \`cwd\` | \`{ path, inRoot }\`: the working directory, resolved; \`inRoot\` is true inside the workspace |
| \`paths\` | each argument the program's manifest marks as a path: \`{ arg, given, path, inRoot, secret, exists }\`, resolved with realpath; \`secret\` is true for a file such as \`.env\` |
| \`env\` | \`{ set, free }\`: the variables the call sets, and whether all of them are harmless |
| \`secrets\` | the secret handles the call carries, by name |
| \`repoConfigRunsCode\` | true when the git repository's own config can run a program (a hook, a pager, an fsmonitor), false when it cannot or there is no repository, null when the host could not tell |
| \`effects\` | what the program's manifest says this call does. \`c.effects.pairs\`: a list of \`{ op, res }\`, \`op\` one of \`"read"\`, \`"write"\`, \`"exec"\`, \`"use"\`, \`"alloc"\`; \`res.kind\` one of \`"fs"\`, \`"net"\`, \`"process"\`, \`"secret"\`, \`"heap"\`, \`"entropy"\`, \`"unknown"\`. An fs resource has \`path\`, \`inRoot\`, \`secret\`, \`exists\`, and \`names: true\` when the write deletes or renames it. \`c.effects.reads\`/\`c.effects.writes\`: the resources read/written. \`c.effects.has(op, kind?)\`, \`c.effects.uses(name)\`. \`c.effects.unknown\`: true when no manifest describes the call (every question then answers as if it does everything) |
| \`described\`, \`why\` | whether a manifest describes the call, and what it could not describe |
| \`mode\`, \`sandboxed\` | where it would run |`,
} as const;

const FORMAT = "Answer with ONE fenced code block holding only the function `(c) => …` (a `const` list before it is fine), and nothing else after it. Call no tools: nothing runs, we are measuring how such rules are written.";

/** The words of one need's ask. */
const needText = (n: Need) => `Need ${n.id} (a${n.effect === "allow" ? "n allow" : " deny"} policy: true means the call is ${n.effect === "allow" ? "run without asking" : "refused without asking"}): ${n.text}`;

/** The check on one turn: the model did what was asked, one block holding a function. Whether it lifts is the
 *  MEASUREMENT, which the scorer reports; a lifter miss is not the model's failure, so it never turns a badge red. */
const extracted = (t: { answer: string }) => extract(t.answer) != null;

/** The interview for one consumer: the facts and the first need as the task, one need per later turn. */
export function policyInterview(consumer: "fetch" | "sh"): Omit<InterviewDef, "kind"> {
    const needs = NEEDS[consumer];
    const ask = (n: Need, lead = ""): AskDef => ({
        ask: `${lead}${needText(n)}\n\n${FORMAT}`,
        expect: extracted,
        why: "one fenced (c) => … block (whether it lifts is scored by policy-proposals.score.ts)",
    });
    return {
        about: `Models write ${consumer === "fetch" ? "fetch_url" : "ml.sh"} policies as text for ${needs.length} described needs; policy-proposals.score.ts measures the fraction the policy tree's lifter covers (lifted / extracted), and which are right on hand-labelled calls. Nothing runs.`,
        task: ask(needs[0], `Write run policies: rules that answer matching ${consumer === "fetch" ? "`fetch_url`" : "`ml.sh`"} calls without asking the person, who reads and approves each rule. ${RULES[consumer]}\n\n${FACTS[consumer]}\n\nThere are ${needs.length} needs, one per message.\n\n`),
        asks: needs.slice(1).map((n) => ask(n)),
    };
}
