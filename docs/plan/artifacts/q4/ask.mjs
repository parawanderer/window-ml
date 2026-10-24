// Spike Q4: ask a panel of models to write three artifacts under two shapes of `root`, saving each raw reply.
import fs from "node:fs";
import path from "node:path";

const OUT = path.join(path.dirname(new URL(import.meta.url).pathname), "replies");
fs.mkdirSync(OUT, { recursive: true });
const MODELS = (process.env.MODELS || "deepseek.deepseek-v4-pro,litellm.google/gemini-flash-latest,litellm.anthropic/claude-sonnet-5-5,moonshot.kimi-k3,openrouter.openai/gpt-6.1-sol,qwen3.6:35b").split(",");

const COMMON = `You are writing an ARTIFACT: a small page shown beside a chat, which you keep up to date over the conversation, like a whiteboard.
Reply with ONE JSON object in a \`\`\`json fence: {"title": string, "body": string, "css": string, "scripts": [string, ...]}.

body: HTML. Extra elements: <ml-embed ref="@tool:<id>:out"></ml-embed> draws a tool's result (an image, a table) and <ml-markdown> holds Markdown. No <script>, no on* attributes, no external URLs (they are removed).
css: plain CSS for the artifact (no @import, no url()).
scripts: run in order each time the artifact is drawn, in a restricted JavaScript DIALECT:
- AVAILABLE: const/let; arrow functions and \`function\` EXPRESSIONS; recursion; if/else, ternary, &&, ||, ??; for…of over arrays, Sets, Maps, strings, Object.keys/values/entries(); array methods (map, filter, reduce, forEach, find, findIndex, some, every, sort, slice, splice, push, pop, join, includes, indexOf, concat, flat); template literals; spread; optional chaining; shorthand destructuring \`const { a, b } = o\`; Math, JSON, Object.keys/values/entries/assign, String and Number methods, Set, Map, Date, regex; try/catch; async/await.
- NOT AVAILABLE (a script using one is refused and the artifact shows an error): while, do, classic for(;;), for…in, switch, break, continue, throw, class, function DECLARATIONS, method shorthand or getters in object literals, destructuring with renames or defaults, the \`in\` operator, setTimeout/setInterval, fetch, document, window, Intl, structuredClone.
What scripts can reach:
- \`state\`: a plain object kept across redraws and across the conversation. Read and write it directly.
- \`ml.current\`: a read-only snapshot of this conversation. \`ml.current.messages\` is an array of {role: "system"|"user"|"assistant"|"tool", content: string, tool_calls?: [{function: {name, arguments}}]}.
- \`ml.dereference("@tool:<id>:out")\`: a tool result's TEXT (a CSV, JSON, …) as a string.
`;

const ROOT = {
    data: `- \`root\`: the artifact's view as PLAIN DATA, parsed from body before the scripts run: each node is {tag, attrs: {…}, text, children: [...]}, and \`root.byId\` maps each element's id to its node. Change the view by writing these objects (set text, push or splice children, set attrs). A node's \`on\` field holds its event handlers: \`node.on = { click: (e) => …, input: (e) => … }\`; e is {type, id, value, checked}. After every handler the view is redrawn from root.`,
    dom: `- \`root\`: the artifact's root ELEMENT. On it and on the elements you get from it: querySelector, querySelectorAll, textContent, value, checked, classList.add/remove/toggle, setAttribute, getAttribute, append, remove, replaceChildren, and \`root.create(tag)\` to make a new element (there is no document). Handlers: el.addEventListener(type, (e) => …), where e is {type, target}.`,
};

const TASKS = {
    todo: "Make a todo list the person and you share: add an item from a text box, tick items done, delete an item, and show how many are left. Start it with three items about planning a weekend trip.",
    figure: "python_exec made a figure of a year's monthly rainfall; its image is @tool:3fa9c21:out. The same data as CSV (header `month,mm`, 12 rows) is @tool:7be01d4:out. Show the figure with a caption, and below it the three wettest months and the yearly total, computed from the CSV.",
    current: "Make a panel about this conversation: how many messages there are by role, the names of the five most recent tool calls, and the length of the longest message. It must be right whenever it is redrawn.",
};

/** One chat completion through OpenWebUI. */
async function ask(model, prompt) {
    const r = await fetch(`${process.env.OPENWEBUI_URL}/api/chat/completions`, {
        method: "POST", signal: AbortSignal.timeout(300_000),
        headers: { "content-type": "application/json", authorization: `Bearer ${process.env.OPENWEBUI_KEY}` },
        body: JSON.stringify({ model, stream: false, messages: [{ role: "user", content: prompt }] }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(`${r.status} ${JSON.stringify(j).slice(0, 200)}`);
    return { text: j.choices?.[0]?.message?.content ?? "", usage: j.usage };
}

const jobs = [];
for (const model of MODELS) for (const [shape, rootText] of Object.entries(ROOT)) for (const [task, taskText] of Object.entries(TASKS)) {
    const file = path.join(OUT, `${model.replace(/[^\w.-]+/g, "_")}__${shape}__${task}.json`);
    if (fs.existsSync(file)) continue;
    const prompt = `${COMMON}${rootText}\n\nTASK: ${taskText}`;
    jobs.push(ask(model, prompt).then((r) => { fs.writeFileSync(file, JSON.stringify({ model, shape, task, ...r }, null, 2) + "\n"); console.log("done", model, shape, task); },
        (e) => console.log("FAIL", model, shape, task, String(e).slice(0, 200))));
}
await Promise.all(jobs);
