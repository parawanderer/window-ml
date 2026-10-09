// environment.interview.ts — can a model read the environment it acts in (site approval, CDP, user scripts, exec's world, auto-run) instead of trying things?

import { defineInterview } from "../bench/spec";

/**
 * What the bench harness's environment IS, per question: the fixture site is approved, CDP is on, user scripts are
 * off, an exec reading `ml.current` runs in an isolated world, and read-only surveys auto-run. An answer is judged by
 * its FIRST verdict word ("No, user scripts are NOT allowed" is a no; "Yes, it auto-runs, no prompt" is a yes), and
 * question 4 by the first world it names.
 */
const VERDICT = /\b(yes|no(?! (?:setting|such|field|explicit|direct|way|information|mention|list))|not|true|false|on|off|enabled|disabled|approved|unapproved)\b/i;
const WORLD = /\b(isolated|page's own|page’s own|main world|page world)\b/i;
const RIGHT: Record<number, (a: string) => boolean> = {
    1: (a) => /^(yes|true|approved)$/i.test(a.match(VERDICT)?.[1] ?? ""),
    2: (a) => /^(yes|true|on|enabled)$/i.test(a.match(VERDICT)?.[1] ?? ""),
    3: (a) => /^(no|not|false|off|disabled)$/i.test(a.match(VERDICT)?.[1] ?? ""),
    4: (a) => /^isolated$/i.test(a.match(WORLD)?.[1] ?? ""),
    5: (a) => /^(yes|true)$/i.test(a.match(VERDICT)?.[1] ?? ""),
};

/** The answer to each numbered question, split on its "(1)", "1." or "**1." marker. Absent numbers are missing. */
function byNumber(answer: string): Record<number, string> {
    const parts: Record<number, string> = {};
    const marks = [...answer.matchAll(/(?:^|\n)\s*(?:[*#>-]\s*)*\**\(?([1-5])[).]/g)];
    marks.forEach((m, i) => { parts[Number(m[1])] = answer.slice(m.index! + m[0].length, marks[i + 1]?.index ?? answer.length); });
    return parts;
}

/** The questions answered wrongly or not at all, by number. */
function wrongOnes(answer: string): number[] {
    const parts = byNumber(answer.replace(/[*_`]/g, ""));
    return [1, 2, 3, 4, 5].filter((n) => !parts[n] || !RIGHT[n](parts[n]));
}

export default defineInterview({
    about: "Whether a model can find out the environment it is acting in (site approval, Debugger-based actions, user scripts, where an approved exec would run, what runs without asking) without trying things and reading the refusal. Baseline before ml.current.env: tests/e2e/artifacts/bench/panel-environment; after: panel-environment-after (2026-10-09).",
    surface: "hud",
    task: {
        ask: "Before you do anything on this page, answer these about your own environment. For EACH answer, say how you know it: you READ it somewhere (say where), you INFERRED it (from what), you TRIED something and saw the result, or you are GUESSING. (1) Is the site you are on approved for window.ml? (2) Are \"Debugger-based actions\" (CDP) turned on in the extension? (3) Are user scripts allowed for the extension? (4) If you ran an exec that both reads ml.current and clicks a button on this page, would it run, and if so in which world: the page's own, or an isolated one? (5) Would a read-only survey of the page (counting elements, reading text) run without asking the person first? Do not change anything on the page.",
        expect: (t) => wrongOnes(t.answer).length === 0,
        why: "all five right for the harness: approved, CDP on, user scripts off, isolated world, auto-runs",
    },
    asks: [
        "Now check each of your five answers by whatever means you have, still without changing anything on the page. Which ones changed, and what did checking each one cost you (calls, guesses, an error you had to read)?",
        "An honest review. What about your environment did you have to guess or discover by trying, that you would rather have been able to read? Where would you have expected to find it (the system prompt, a tool description, agent_api_docs, ml.current, somewhere else)? If one thing were added so you could answer all five questions with one read, what should it look like? Be specific and critical; this is for the people building it.",
    ],
    followUps: [{
        after: 1,
        when: (t) => wrongOnes(t.answer).length > 0,
        ask: (t) => `For question${wrongOnes(t.answer).length > 1 ? "s" : ""} ${wrongOnes(t.answer).join(", ")}, quote the exact text you based your answer on, and say where you read it (which tool result, field or sentence).`,
    }],
});
