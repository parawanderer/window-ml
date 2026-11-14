// links-prompt.bench.ts — LINKS.md's open question 1: does a model write the `[label](window-ml:<address>)` link form
// when the form is only in agent_api_docs's "Your settings" section, or does it need one sentence in the system prompt
// (`LINKS_CLAUSE`, src/agent/prompts.ts)? Two arms, the same build otherwise:
//
//   USE_ENV=1 node --import tsx tests/e2e/bench/run.mjs tests/e2e/bench/specs/links-prompt.bench.ts --dry
//   LINKS_MODELS=a,b USE_ENV=1 node --import tsx tests/e2e/bench/run.mjs tests/e2e/bench/specs/links-prompt.bench.ts
//   LINKS_MODELS=fake node --import tsx tests/e2e/bench/run.mjs tests/e2e/bench/specs/links-prompt.bench.ts --repeats 1 --no-sync
//
// Four tasks ask where something is set, which a link answers; the fifth asks about the page and is the control for
// links nobody asked for. A run passes when the answer carries a link whose address resolves (`parseAddress`, the
// panel's own parser) to the place the task is about. The notebook (notebooks/bench/make-links-prompt.py) splits that
// into: linked at all, resolves, the exact row, the right tab or section, and the sentence's prompt-token cost.
//
// Against the fake model each task's script reads the system prompt, so the dry run checks the arms differ: with the
// sentence it links the setting's row, without it a section it found through agent_api_docs.

import { defineBench } from "../spec";
import { parseAddress, type PanelRoute } from "../../../../src/link-address";

const MODELS = (process.env.LINKS_MODELS || "gemma4:31b,gemma4:e4b,qwen3.8-flash-next:vision,deepseek.deepseek-flash,openrouter.openai/gpt-6-luna")
    .split(",").map((s) => s.trim()).filter(Boolean);

/** Every `[label](window-ml:<address>)` in `text`, in order. A bare `window-ml:` with no Markdown link is not one. */
export function linksIn(text: string): { label: string; address: string }[] {
    return [...text.matchAll(/\[([^\]\n]+)\]\(window-ml:([^)\s]*)\)/g)].map((m) => ({ label: m[1], address: m[2] }));
}

/** Where a task's answer should point: the tab and, where the place has one, the section. `key` is the exact row. */
export interface Want { tab: string; section?: string; key?: string; backup?: boolean }

/** Whether a resolved link opens the place `want` names: the same tab, and the same section where `want` has one. A
 *  setting's row counts as its section. */
export function opensPlace(r: PanelRoute, want: Want): boolean {
    if (want.backup) return (r as { target?: string }).target === "set-backup";
    return r.tab === want.tab && (want.section === undefined || r.section === want.section);
}

/** A run passes when some link in its answer resolves and opens the place the task is about. */
const linksTo = (want: Want) => ({ answer }: { answer: string }) =>
    linksIn(answer).some(({ address }) => { const r = parseAddress(address); return !!r && opensPlace(r, want); });

/** The fake's answer: with the sentence in its system prompt, the exact row; without it, the section (or tab) the
 *  docs section names, if the docs call returned it; with neither, prose. */
const fakeAnswer = (label: string, row: string, place: string) =>
    (req: { messages?: { role?: string; content?: unknown }[] }) => {
        const text = (role: string) => (req.messages || []).filter((m) => m.role === role).map((m) => String(m.content ?? "")).join("\n");
        if (text("system").includes("window-ml:setting/<key>")) return { content: `Set it in [${label}](window-ml:${row}).` };
        if (text("tool").includes(`\`${place}\``)) return { content: `It is in [${label}](window-ml:${place}).` };
        return { content: `Open Settings and find ${label}.` };
    };

const NOT_SUITE = { included: false, reason: "measures one sentence of the system prompt through this spec's build constant" };

/** A task that asks where something is set, with the fake's two-step script: search the docs, then answer. */
const askWhere = (id: string, task: string, want: Want, label: string, row: string, place: string) => ({
    id, regression: NOT_SUITE, task,
    script: [{ tool: "agent_api_docs", args: { search: "window-ml:" } }, fakeAnswer(label, row, place)],
    succeeded: linksTo(want),
});

export const TASKS = [
    askWhere("api-key", "Where do I set the API key for my model server?",
        { tab: "connection", key: "apiKey" }, "API key", "setting/apiKey", "settings/extension/connection"),
    askWhere("shell", "How do I let you run programs on my computer?",
        { tab: "advanced", section: "shell", key: "shellEnabled" }, "Programs", "setting/shellEnabled", "settings/extension/advanced/shell"),
    askWhere("readonly", "I don't want read-only scripts to run without asking me first. Where do I change that?",
        { tab: "advanced", section: "javascript", key: "autoApproveReadonly" }, "JavaScript", "setting/autoApproveReadonly", "settings/extension/advanced/javascript"),
    askWhere("backup", "How do I back up my settings and sessions?",
        { tab: "appearance", backup: true }, "Backup and restore", "settings/extension/backup", "settings/extension/backup"),
    {
        // The control: nothing here is about settings, so a link is noise. Passes on the page's code and no link.
        id: "control",
        regression: NOT_SUITE,
        start: "/step3",
        task: "What code is shown on this page? Answer with just the code.",
        script: [
            { tool: "findByText", args: { text: "CROSSPAGE" } },
            (req: { messages?: { content?: unknown }[] }) => {
                const m = (req.messages || []).map((x) => (typeof x.content === "string" ? x.content : "")).join(" ").match(/CROSSPAGE-\d+/);
                return { content: m ? `The code is ${m[0]}.` : "I couldn't find a code on this page." };
            },
        ],
        succeeded: ({ answer }: { answer: string }) => /CROSSPAGE-\d+/.test(answer) && linksIn(answer).length === 0,
    },
];

export default defineBench({
    name: "links-prompt",
    description: "LINKS.md open question 1: does a model write window-ml: setting links from agent_api_docs alone, or with one sentence in the prompt?",
    repeats: 4,
    timeoutMs: 240000,
    approve: "auto",

    dimensions: {
        model: MODELS,
        sentence: ["off", "on"],
    },

    // Both arms set the constant, so neither depends on what ships. From the HUD, as a person asks. `LINKS_MODELS=fake`
    // is the dry run: a cell naming a backend model is sent to the real server, so the fake's cells name none.
    apply: (combo) => ({
        ...(combo.model === "fake" ? {} : { backend: { model: combo.model } }),
        defines: { __ML_LINKS_SENTENCE__: JSON.stringify(combo.sentence) },
        surface: "hud",
    }),

    tasks: TASKS,
});
