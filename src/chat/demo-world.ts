// THE FAKE HOST'S DEMO WORLD: three runtimes and a handful of sessions in the states the chat page has to render. An
// agent waiting on an approval, a finished chat with code and math, a run stopped at its step cap, a run on a runtime
// this device may only watch, and a runtime that is offline. The web build opens on it until `HubHost` exists, the
// e2e specs drive it, and it is the live mockup of both layouts.
import type { MlDebugEvent } from "../contract-debug";
import { SESSION_CONTRACT_VERSION, type Grant, type RuntimeInfo, type SessionSummary } from "../session-host";
import { FakeHost } from "./fake-host";

const EVERY: Grant[] = [{ scope: "view" }, { scope: "drive" }, { scope: "approve" }, { scope: "screen" }];

/** The world's session keys, for specs and demos that open one by name. */
export const DEMO = {
    waiting: "laptop:3f9a0c21",
    chat: "laptop:7b21d4e8",
    capped: "laptop:c0ffee12",
    watched: "lab-box:1d2e3f40",
    pointers: "laptop:5e6f7a80",
    offline: "old-mac:aa55aa55",
} as const;

/** Build the demo host. `now` pins the clock, so a screenshot does not change between runs. */
export function demoHost(now = Date.now(), opts: { latencyMs?: number } = {}): FakeHost {
    const min = 60_000;
    const runtimes: RuntimeInfo[] = [
        {
            id: "laptop", name: "Work laptop", kind: "browser", online: true, contractVersion: SESSION_CONTRACT_VERSION, grants: EVERY,
            capabilities: { chat: true, agent: true, tabs: true, screenshots: true, highlight: true, sideCalls: true, persistence: true },
        },
        {
            id: "lab-box", name: "Lab box", kind: "desktop", online: true, contractVersion: SESSION_CONTRACT_VERSION, grants: [{ scope: "view" }],
            capabilities: { agent: true, sideCalls: true },
        },
        {
            id: "old-mac", name: "Old Mac", kind: "browser", online: false, lastSeen: now - 90 * min, contractVersion: SESSION_CONTRACT_VERSION, grants: EVERY,
            capabilities: { chat: true, agent: true },
        },
    ];
    // Hoisted so a step's ARGUMENTS and its render slot cannot drift apart — which is the one way this fixture
    // could lie about a real run while looking right.
    const EXEC_JS = "return [...document.querySelectorAll('.fare-card')].map(c => ({ price: c.querySelector('.price')?.textContent, airline: c.dataset.airline }))";
    const COUNT_JS = "return document.querySelectorAll('.fare-card').length";
    const PY_CODE = "import pandas as pd\ndf = pd.DataFrame({'airline': ['TP', 'HV', 'KL'], 'price': [118, 96, 131]})\nreturn df.sort_values('price')";
    const BENCH_PY = "import json, statistics\nruns = json.load(open('bench/latest.json'))\nreturn statistics.median(r['tok_s'] for r in runs)";
    const base = (hash: string, ts: number, turn = 0) => ({ id: `${hash}-${turn}`, ts, save: true, session: { hash, turn } });
    const agentStart = (hash: string, ts: number, task: string, maxSteps = 12): MlDebugEvent => ({ ...base(hash, ts), kind: "agent", task, model: "qwen3:32b", maxSteps, config: undefined as never, pageUrl: "https://flights.example/search?from=AMS&to=LIS", pageTitle: "Flights AMS → LIS" });
    const summary = (key: string, over: Partial<SessionSummary> & Pick<SessionSummary, "kind" | "status" | "createdTs" | "lastTs">): SessionSummary => {
        const [runtime, hash] = key.split(":");
        return { id: { runtime, hash }, pendingApprovals: 0, saved: true, ...over };
    };

    const w = DEMO.waiting.split(":")[1];
    const waiting: MlDebugEvent[] = [
        agentStart(w, now - 6 * min, "Find the cheapest flight on this page and summarise its fare rules"),
        {
            ...base(w, now - 5 * min, 1), kind: "agent-step", step: 1, seq: 1, tool: "exec", approval: "readonly", toolMs: 41,
            thought: "Survey the result cards first, to see what a fare row holds.",
            arguments: { js: EXEC_JS },
            result: "[{\"price\":\"€118\",\"airline\":\"TP\"},{\"price\":\"€96\",\"airline\":\"HV\"},{\"price\":\"€131\",\"airline\":\"KL\"}]",
            // The render slots the real tools fill (`src/tools.ts`, `src/python-tool.ts`). Without them a step
            // falls back to its raw argument tree, which is a JSON string with `\n` in it where a reader expects
            // code — the fallback working exactly as designed, over a fixture that did not match a real run.
            renderIn: { type: "code", text: EXEC_JS, lang: "javascript", format: true },
            renderOut: { type: "exec-out", value: "[{\"price\":\"€118\",\"airline\":\"TP\"},{\"price\":\"€96\",\"airline\":\"HV\"},{\"price\":\"€131\",\"airline\":\"KL\"}]" },
        },
        {
            ...base(w, now - 4 * min, 2), kind: "agent-step", step: 2, seq: 2, pending: true, awaitingApproval: true, tool: "fetch_url",
            thought: "The €96 fare links its rules on another site; read them.",
            arguments: { url: "https://www.transavia.com/en-EU/service/fare-rules/" },
            renderIn: { type: "action", verb: "fetch", target: "https://www.transavia.com/en-EU/service/fare-rules/", crossOrigin: "www.transavia.com" },
        },
    ];

    const c = DEMO.chat.split(":")[1];
    const chatStart = (turn: number, ts: number, text: string): MlDebugEvent => ({
        ...base(c, ts, turn), kind: "chat", streaming: false,
        request: { model: "qwen3:32b", extend: null, messages: [{ role: "user", content: text }], images: null, toolIds: null, schema: false, think: null, maxTokens: null },
        config: { system: null, model: "qwen3:32b", think: null, schema: false, toolIds: null, maxTokens: null, save: true },
    } as MlDebugEvent);
    const chat: MlDebugEvent[] = [
        chatStart(0, now - 40 * min, "How much memory does the KV cache of a 32B model take at 32k context?"),
        {
            ...base(c, now - 39 * min, 0), kind: "chat-result", model: "qwen3:32b", extend: null, reasoning: null, sources: null, structured: false,
            usage: { promptTokens: 24, completionTokens: 212, totalTokens: 236 },
            content: [
                "Per token, the cache holds a key and a value for every layer:",
                "",
                "$$\\text{bytes} = 2 \\cdot n_{\\text{layers}} \\cdot n_{\\text{kv heads}} \\cdot d_{\\text{head}} \\cdot \\text{bytes per element}$$",
                "",
                "For a 64-layer model with 8 KV heads of 128 dimensions at FP16, that is **256 KB per token**, so 32k tokens need about **7.8 GiB**.",
                "",
                "```python",
                "layers, kv_heads, head_dim, fp16 = 64, 8, 128, 2",
                "per_token = 2 * layers * kv_heads * head_dim * fp16",
                "print(per_token * 32_768 / 2**30)  # 7.8125",
                "```",
                "",
                "Quantising the cache to q8_0 roughly halves that.",
            ].join("\n"),
        },
    ];

    const k = DEMO.capped.split(":")[1];
    const capped: MlDebugEvent[] = [
        agentStart(k, now - 3 * 60 * min, "Tabulate the prices from the three fare cards and plot them", 2),
        {
            ...base(k, now - 179 * min, 1), kind: "agent-step", step: 1, seq: 1, tool: "python_exec", approval: "sandbox", toolMs: 1840,
            arguments: { code: PY_CODE },
            result: "  airline  price\n1      HV     96\n0      TP    118\n2      KL    131",
            renderIn: { type: "python-in", mode: "script", code: PY_CODE },
            renderOut: { type: "python-out", df: { columns: ["airline", "price"], rows: [["HV", 96], ["TP", 118], ["KL", 131]] } },
        },
        {
            ...base(k, now - 178 * min, 2), kind: "agent-step", step: 2, seq: 2, tool: "exec", approval: "readonly", toolMs: 12,
            arguments: { js: COUNT_JS }, result: "3",
            renderIn: { type: "code", text: COUNT_JS, lang: "javascript", format: true },
            renderOut: { type: "exec-out", value: "3" },
        },
        { ...base(k, now - 178 * min + 1000, 2), kind: "agent-result", summary: "", steps: 2, hitCap: true },
    ];

    // A run whose ANSWER CITES ITS OWN STEPS (`![label](@tool:<id>)`, docs/dev/pointers.md): one value quoted
    // inline mid-sentence, one table embedded as a block with the model's caption under it, an image, and a plain
    // link that jumps to the step instead of showing it. Every form the answer renderer has, in one answer, because
    // the thing worth looking at is that a citation does NOT read like the prose around it: it is a transclusion of
    // something a tool actually produced, and the page says so.
    const pt = DEMO.pointers.split(":")[1];
    const PLOT_SVG = "data:image/svg+xml;utf8," + encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" width="420" height="220" viewBox="0 0 420 220">
            <rect width="420" height="220" fill="#ffffff"/>
            <line x1="52" y1="180" x2="400" y2="180" stroke="#9ca3af"/>
            <line x1="52" y1="20" x2="52" y2="180" stroke="#9ca3af"/>
            ${[["HV", 96, "#60a5fa"], ["TP", 118, "#818cf8"], ["KL", 131, "#f472b6"]].map(([n, v, c], i) =>
        `<rect x="${86 + i * 100}" y="${180 - (v as number)}" width="56" height="${v}" fill="${c}"/>
             <text x="${114 + i * 100}" y="196" font-family="system-ui" font-size="12" fill="#374151" text-anchor="middle">${n}</text>
             <text x="${114 + i * 100}" y="${172 - (v as number)}" font-family="system-ui" font-size="12" fill="#374151" text-anchor="middle">€${v}</text>`).join("")}
        </svg>`.replace(/\s+/g, " "));
    const POINTER_PY = "import pandas as pd\ndf = pd.DataFrame({'airline': ['TP', 'HV', 'KL'], 'price': [118, 96, 131]})\nreturn df.sort_values('price')";
    const PLOT_PY = "import matplotlib.pyplot as plt\nplt.bar(df.airline, df.price)\nreturn plt";
    const pointers: MlDebugEvent[] = [
        agentStart(pt, now - 12 * min, "Summarise the fares and show me the spread"),
        {
            ...base(pt, now - 11 * min, 1), kind: "agent-step", step: 1, seq: 1, tool: "exec", approval: "readonly", toolMs: 12,
            token: "d4e5f60", thought: "Count what is on the page first.",
            arguments: { js: COUNT_JS }, result: "3",
            renderIn: { type: "code", text: COUNT_JS, lang: "javascript", format: true },
            renderOut: { type: "exec-out", value: "3" },
        },
        {
            ...base(pt, now - 10 * min, 2), kind: "agent-step", step: 2, seq: 2, tool: "python_exec", approval: "sandbox", toolMs: 1640,
            token: "a1b2c3d", arguments: { code: POINTER_PY }, result: "  airline  price\n1      HV     96\n0      TP    118\n2      KL    131",
            renderIn: { type: "python-in", mode: "script", code: POINTER_PY },
            renderOut: { type: "python-out", df: { columns: ["airline", "price"], rows: [["HV", 96], ["TP", 118], ["KL", 131]] } },
        },
        {
            ...base(pt, now - 9 * min, 3), kind: "agent-step", step: 3, seq: 3, tool: "python_exec", approval: "sandbox", toolMs: 2100,
            token: "c3d4e5f", arguments: { code: PLOT_PY }, result: "<figure>",
            renderIn: { type: "python-in", mode: "script", code: PLOT_PY },
            renderOut: { type: "python-out", image: PLOT_SVG },
        },
        {
            ...base(pt, now - 9 * min + 2000, 3), kind: "agent-result", steps: 3, hitCap: false,
            summary: [
                "There are ![the count](@tool:d4e5f60) fares on the page, and the cheapest is HV at €96.",
                "",
                "![Every fare, cheapest first](@tool:a1b2c3d)",
                "",
                "The spread is €35 across the three, which is narrow enough that the shape reads better than the numbers:",
                "",
                "![Fares by airline](@tool:c3d4e5f | img)",
                "",
                "The count came from [the survey step](@tool:d4e5f60), and the table is the dataframe that step 2 returned, not a copy of it.",
            ].join("\n"),
        },
    ];

    const l = DEMO.watched.split(":")[1];
    const watched: MlDebugEvent[] = [
        { ...agentStart(l, now - 2 * min, "Re-run the nightly benchmark and report regressions"), pageUrl: undefined, pageTitle: undefined } as MlDebugEvent,
        {
            ...base(l, now - min, 1), kind: "agent-step", step: 1, seq: 1, tool: "python_exec", pending: true, approval: "sandbox",
            arguments: { code: BENCH_PY },
            renderIn: { type: "python-in", mode: "script", code: BENCH_PY },
        },
    ];

    const o = DEMO.offline.split(":")[1];
    const offline: MlDebugEvent[] = [
        { ...chatStart(0, now - 26 * 60 * min, "Draft a polite reminder about the overdue invoice"), id: `${o}-0`, session: { hash: o, turn: 0 } } as MlDebugEvent,
        {
            ...base(o, now - 26 * 60 * min + 5000, 0), kind: "chat-result", model: "qwen3:32b", extend: null, reasoning: null, sources: null, structured: false, usage: null,
            content: "Hi Sam,\n\nA quick reminder that invoice #2291 was due on the 3rd. Could you let me know when to expect payment?\n\nThanks!",
        },
    ];

    // A HISTORY: brainstorming chats from the last half year, so the list has something past its recent window and the
    // "Older sessions" view has more than a screenful to scroll. Deterministic from `now`, like everything here.
    const OLD_TOPICS = [
        ["Name ideas for the offline map app", "A few directions: something about paths (Trailhead, Waymark), something about paper (Foldout, Quire), or plain and descriptive (Offline Atlas)."],
        ["Why does my sourdough collapse?", "Most often over-proofing: the gluten has given up holding the gas by the time it hits the oven. Try a shorter bulk and a colder final proof."],
        ["Compare SQLite WAL vs rollback journal", "WAL lets readers proceed during a write and is usually faster; rollback is simpler and safer on network filesystems."],
        ["Talk outline: local models in the browser", "1. Why local. 2. The CORS wall and the extension that walks around it. 3. What a page can ask for. 4. Demo. 5. What it cannot do yet."],
        ["Gift ideas for a climber", "A chalk bag with a brush holder, a good belay glasses pair, or a guidebook for somewhere they have not been yet."],
        ["Explain Raft leader election", "Followers time out, become candidates, and ask for votes; a majority makes a leader, and randomised timeouts keep two from splitting the vote forever."],
        ["Rewrite this paragraph shorter", "The migration finished early; two tables still need their indexes rebuilt."],
        ["Tokyo in four days", "Day 1 Asakusa and Ueno, day 2 Shibuya and Harajuku, day 3 a day trip to Kamakura, day 4 Shimokitazawa and whatever you missed."],
        ["Is 16GB VRAM enough for a 14B model?", "At 4-bit, yes, with room for a moderate context. At 8-bit it will spill."],
        ["Cold email to a design studio", "Hi — I run a small open-source browser extension and would love a second pair of eyes on its reading view. Would a short paid review interest you?"],
        ["Difference between p-values and confidence intervals", "A p-value answers one yes/no question about a null; an interval says which effect sizes the data are compatible with."],
        ["Budget spreadsheet structure", "One sheet of raw transactions, one of categories, and a summary pivot. Never type into the summary."],
    ] as const;
    const history = Array.from({ length: 48 }, (_, i) => {
        const [title, answer] = OLD_TOPICS[i % OLD_TOPICS.length];
        const hash = `0ld${(0x10000 + i * 7919).toString(16).slice(-5)}`;
        const ts = now - (34 + Math.round(i * 3.4)) * 24 * 60 * min;
        const events: MlDebugEvent[] = [
            { ...chatStart(0, ts, title), id: `${hash}-0`, session: { hash, turn: 0 } } as MlDebugEvent,
            { ...base(hash, ts + 4000, 0), kind: "chat-result", model: "qwen3:32b", extend: null, reasoning: null, sources: null, structured: false, usage: null, content: answer } as MlDebugEvent,
        ];
        return { summary: summary(`laptop:${hash}`, { kind: "chat", status: "done", createdTs: ts, lastTs: ts + 4000, title, model: "qwen3:32b" }), events };
    });

    return new FakeHost({
        runtimes,
        latencyMs: opts.latencyMs,
        sessions: [
            ...history,
            { summary: summary(DEMO.waiting, { kind: "agent", status: "waiting", pendingApprovals: 1, createdTs: now - 6 * min, lastTs: now - 4 * min, task: "Find the cheapest flight on this page and summarise its fare rules", title: "Cheapest AMS → LIS fare", model: "qwen3:32b", page: { url: "https://flights.example/search?from=AMS&to=LIS", title: "Flights AMS → LIS", tabId: 41 } }), events: waiting },
            { summary: summary(DEMO.chat, { kind: "chat", status: "done", createdTs: now - 40 * min, lastTs: now - 39 * min, title: "KV cache size at 32k", model: "qwen3:32b" }), events: chat },
            // A page with no `tabId`: the tab it worked in has since closed, which is what makes it resumable and what the
            // header's page chip then reports — which page the run WAS on, rather than nothing at all.
            { summary: summary(DEMO.capped, { kind: "agent", status: "capped", createdTs: now - 180 * min, lastTs: now - 178 * min, title: "Plot the fare prices", model: "qwen3:32b", page: { url: "https://flights.example/search?from=AMS&to=LIS", title: "Flights AMS → LIS" } }), events: capped },
            { summary: summary(DEMO.pointers, { kind: "agent", status: "done", createdTs: now - 12 * min, lastTs: now - 9 * min, title: "Fares, cited", model: "qwen3:32b", page: { url: "https://flights.example/search?from=AMS&to=LIS", title: "Flights AMS → LIS", tabId: 41 } }), events: pointers },
            { summary: summary(DEMO.watched, { kind: "agent", status: "running", createdTs: now - 2 * min, lastTs: now - min, title: "Nightly benchmark", model: "qwen3:32b" }), events: watched },
            { summary: summary(DEMO.offline, { kind: "chat", status: "done", createdTs: now - 26 * 60 * min, lastTs: now - 26 * 60 * min + 5000, title: "Invoice reminder" }), events: offline },
        ],
    });
}
