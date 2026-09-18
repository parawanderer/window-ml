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
            arguments: { js: "return [...document.querySelectorAll('.fare-card')].map(c => ({ price: c.querySelector('.price')?.textContent, airline: c.dataset.airline }))" },
            result: "[{\"price\":\"€118\",\"airline\":\"TP\"},{\"price\":\"€96\",\"airline\":\"HV\"},{\"price\":\"€131\",\"airline\":\"KL\"}]",
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
            arguments: { code: "import pandas as pd\ndf = pd.DataFrame({'airline': ['TP', 'HV', 'KL'], 'price': [118, 96, 131]})\nreturn df.sort_values('price')" },
            result: "  airline  price\n1      HV     96\n0      TP    118\n2      KL    131",
        },
        {
            ...base(k, now - 178 * min, 2), kind: "agent-step", step: 2, seq: 2, tool: "exec", approval: "readonly", toolMs: 12,
            arguments: { js: "return document.querySelectorAll('.fare-card').length" }, result: "3",
        },
        { ...base(k, now - 178 * min + 1000, 2), kind: "agent-result", summary: "", steps: 2, hitCap: true },
    ];

    const l = DEMO.watched.split(":")[1];
    const watched: MlDebugEvent[] = [
        { ...agentStart(l, now - 2 * min, "Re-run the nightly benchmark and report regressions"), pageUrl: undefined, pageTitle: undefined } as MlDebugEvent,
        {
            ...base(l, now - min, 1), kind: "agent-step", step: 1, seq: 1, tool: "python_exec", pending: true, approval: "sandbox",
            arguments: { code: "import json, statistics\nruns = json.load(open('bench/latest.json'))\nreturn statistics.median(r['tok_s'] for r in runs)" },
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

    return new FakeHost({
        runtimes,
        latencyMs: opts.latencyMs,
        sessions: [
            { summary: summary(DEMO.waiting, { kind: "agent", status: "waiting", pendingApprovals: 1, createdTs: now - 6 * min, lastTs: now - 4 * min, task: "Find the cheapest flight on this page and summarise its fare rules", title: "Cheapest AMS → LIS fare", model: "qwen3:32b", page: { url: "https://flights.example/search?from=AMS&to=LIS", title: "Flights AMS → LIS", tabId: 41 } }), events: waiting },
            { summary: summary(DEMO.chat, { kind: "chat", status: "done", createdTs: now - 40 * min, lastTs: now - 39 * min, title: "KV cache size at 32k", model: "qwen3:32b" }), events: chat },
            // A page with no `tabId`: the tab it worked in has since closed, which is what makes it resumable and what the
            // header's page chip then reports — which page the run WAS on, rather than nothing at all.
            { summary: summary(DEMO.capped, { kind: "agent", status: "capped", createdTs: now - 180 * min, lastTs: now - 178 * min, title: "Plot the fare prices", model: "qwen3:32b", page: { url: "https://flights.example/search?from=AMS&to=LIS", title: "Flights AMS → LIS" } }), events: capped },
            { summary: summary(DEMO.watched, { kind: "agent", status: "running", createdTs: now - 2 * min, lastTs: now - min, title: "Nightly benchmark", model: "qwen3:32b" }), events: watched },
            { summary: summary(DEMO.offline, { kind: "chat", status: "done", createdTs: now - 26 * 60 * min, lastTs: now - 26 * 60 * min + 5000, title: "Invoice reminder" }), events: offline },
        ],
    });
}
