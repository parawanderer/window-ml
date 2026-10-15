// long-session.ts — a synthetic LONG session for the fake host: how a transcript behaves at a thousand turns.
//
// Deterministic from `now`, like the rest of the demo world. Two shapes, because they cost differently to draw: a chat
// (one user message and one answer per turn, with code, a table or math in some of them) and an agent run (one step
// per turn, with a dataframe, a plot or a plain result, and a thought in some). The web build adds them when the
// address carries `?long=<n>`; the measurement spec (tests/e2e/chat-scroll.spec.mjs) drives them the same way.
import type { MlDebugEvent } from "../contract/contract-debug";
import type { SessionSummary } from "../session/session-host";

/** The keys the long sessions live under, for specs that open one by name. */
export const LONG = { chat: "laptop:10a9c4a7", agent: "laptop:10a9a9e1" } as const;

const PLOT = "data:image/svg+xml;utf8," + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="420" height="220" viewBox="0 0 420 220"><rect width="420" height="220" fill="#ffffff"/><rect x="60" y="80" width="56" height="100" fill="#60a5fa"/><rect x="160" y="50" width="56" height="130" fill="#818cf8"/><rect x="260" y="110" width="56" height="70" fill="#f472b6"/></svg>`);

const ANSWERS = [
    "Short answer: yes. The longer one depends on the context length you actually use.",
    "Per token the cache holds a key and a value for every layer:\n\n$$\\text{bytes} = 2 \\cdot n_{\\text{layers}} \\cdot n_{\\text{kv}} \\cdot d \\cdot b$$\n\nAt FP16 that is a few hundred KB per token.",
    "```python\nlayers, kv, d, b = 64, 8, 128, 2\nprint(2 * layers * kv * d * b)\n```\n\nThat prints 262144, i.e. 256 KB per token.",
    "| ctx | cache GiB |\n| --- | --- |\n| 4k | 1.0 |\n| 8k | 2.0 |\n| 16k | 3.9 |\n| 32k | 7.8 |\n\nLinear in context, so halve it with a q8_0 cache.",
    "Three things matter: the number of KV heads, the head dimension, and the element width. Everything else is a multiple of those.\n\n- grouped-query attention shrinks the first\n- the architecture fixes the second\n- quantisation changes the third",
];

/** A chat of `n` turns: the events and the index row. */
export function longChat(n: number, now = Date.now()): { summary: SessionSummary; events: MlDebugEvent[] } {
    const [runtime, hash] = LONG.chat.split(":");
    const t0 = now - n * 60_000;
    const events: MlDebugEvent[] = [];
    for (let i = 0; i < n; i++) {
        const ts = t0 + i * 60_000;
        const base = { id: `${hash}-${i}`, ts, save: true, session: { hash, turn: i } };
        events.push({
            ...base, kind: "chat", streaming: false,
            request: { model: "qwen3:32b", extend: null, messages: [{ role: "user", content: `Question ${i + 1}: how does the cache change at ${4 * (1 + (i % 8))}k context?` }], images: null, toolIds: null, schema: false, think: null, maxTokens: null },
            config: { system: null, model: "qwen3:32b", think: null, schema: false, toolIds: null, maxTokens: null, save: true },
        } as MlDebugEvent);
        events.push({
            ...base, ts: ts + 4000, kind: "chat-result", model: "qwen3:32b", extend: null, reasoning: null, sources: null, structured: false,
            usage: { promptTokens: 24, completionTokens: 200, totalTokens: 224 }, content: `Turn ${i + 1}. ${ANSWERS[i % ANSWERS.length]}`,
        } as MlDebugEvent);
    }
    return { summary: { id: { runtime, hash }, kind: "chat", status: "done", pendingApprovals: 0, saved: true, createdTs: t0, lastTs: now, title: `A long chat (${n} turns)`, model: "qwen3:32b" }, events };
}

/** An agent run of `n` steps, `gapMs` apart (small ones put the last step moments ago), a table in every third and a plot in every seventh, ending in an answer. */
export function longAgent(n: number, now = Date.now(), gapMs = 30_000): { summary: SessionSummary; events: MlDebugEvent[] } {
    const [runtime, hash] = LONG.agent.split(":");
    const t0 = now - (n + 5) * gapMs;
    const base = (ts: number, turn: number) => ({ id: `${hash}-${turn}`, ts, save: true, session: { hash, turn } });
    const events: MlDebugEvent[] = [
        { ...base(t0, 0), kind: "agent", task: "Tabulate every fare and plot the spread", model: "qwen3:32b", maxSteps: n + 10, config: undefined as never, pageUrl: "https://flights.example/search", pageTitle: "Flights" } as MlDebugEvent,
    ];
    for (let i = 1; i <= n; i++) {
        const ts = t0 + i * gapMs;
        const code = `import pandas as pd\ndf = pd.DataFrame({'a': [${i}, ${i + 1}, ${i + 2}], 'b': ['x', 'y', 'z']})\nreturn df`;
        const common = { ...base(ts, i), kind: "agent-step", step: i, seq: i, toolMs: 20 + (i % 90), ...(i % 5 === 0 ? { thought: `Step ${i}: check the next block before moving on.` } : {}) };
        if (i % 7 === 0) {
            events.push({ ...common, tool: "python_exec", approval: "sandbox", arguments: { code }, result: "<figure>", renderIn: { type: "python-in", mode: "script", code }, renderOut: { type: "python-out", image: PLOT } } as MlDebugEvent);
        } else if (i % 3 === 0) {
            events.push({ ...common, tool: "python_exec", approval: "sandbox", arguments: { code }, result: "table", renderIn: { type: "python-in", mode: "script", code }, renderOut: { type: "python-out", df: { columns: ["a", "b"], rows: [[i, "x"], [i + 1, "y"], [i + 2, "z"]] } } } as MlDebugEvent);
        } else {
            const js = `return document.querySelectorAll('.fare-card:nth-child(${i})').length`;
            events.push({ ...common, tool: "exec", approval: "readonly", arguments: { js }, result: String(i % 4), renderIn: { type: "code", text: js, lang: "javascript", format: true }, renderOut: { type: "exec-out", value: String(i % 4) } } as MlDebugEvent);
        }
    }
    events.push({ ...base(now, n), kind: "agent-result", steps: n, hitCap: false, summary: `Done: ${n} steps, every fare tabulated.` } as MlDebugEvent);
    return { summary: { id: { runtime, hash }, kind: "agent", status: "done", pendingApprovals: 0, saved: true, createdTs: t0, lastTs: now, title: `A long run (${n} steps)`, model: "qwen3:32b" }, events };
}
